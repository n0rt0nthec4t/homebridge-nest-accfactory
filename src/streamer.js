// streamer
// Part of homebridge-nest-accfactory
//
// This is the base class for all Camera/Doorbell streaming
//
// Buffers a single audio/video stream which allows multiple HomeKit devices to connect to the single stream
// for live viewing and/or recording
//
// The following functions should be defined in your class which extends this
//
// streamer.connect()
// streamer.close()
// streamer.sendTalkback(talkingBuffer)
// streamer.onUpdate(deviceData)
// streamer.codecs() <- return codecs beeing used in
//
// The following defines should be overriden in your class which extends this
//
// blankAudio - Buffer containing a blank audio segment for the type of audio being used
//
// Code version 2025.07.26
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { Buffer } from 'node:buffer';
import { setInterval, clearInterval, setTimeout, clearTimeout } from 'node:timers';
import fs from 'fs';
import path from 'node:path';
import { PassThrough } from 'stream';

// Define our modules
import HomeKitDevice from './HomeKitDevice.js';

// Define constants
import { TIMERS, RESOURCE_FRAMES, RESOURCE_PATH, LOG_LEVELS, __dirname } from './consts.js';

const MAX_BUFFER_AGE = 5000; // Keep last 5s of media in buffer
const STREAM_FRAME_INTERVAL = 1000 / 30; // 30fps approx

// Streamer object
export default class Streamer {
  static H264NALUS = {
    START_CODE: Buffer.from([0x00, 0x00, 0x00, 0x01]),
    TYPES: {
      SLICE_NON_IDR: 1,
      SLICE_PART_A: 2,
      SLICE_PART_B: 3,
      SLICE_PART_C: 4,
      IDR: 5, // Instantaneous Decoder Refresh
      SEI: 6,
      SPS: 7,
      PPS: 8,
      AUD: 9,
      END_SEQUENCE: 10,
      END_STREAM: 11,
      STAP_A: 24,
      FU_A: 28,
    },
  };

  static STREAM_TYPE = {
    LIVE: 'live',
    RECORD: 'record',
    BUFFER: 'buffer',
  };

  static PACKET_TYPE = {
    VIDEO: 'video',
    AUDIO: 'audio',
    TALK: 'talk',
    METADATA: 'meta',
  };

  static CODEC_TYPE = {
    H264: 'h264',
    AAC: 'aac',
    OPUS: 'opus',
    PCM: 'pcm',
    SPEEX: 'speex',
    META: 'meta',
    UNKNOWN: 'undefined',
  };

  static MESSAGE = 'Streamer.onMessage'; // Message type for HomeKitDevice to listen for

  static MESSAGE_TYPE = {
    START_LIVE: 'start-live',
    STOP_LIVE: 'stop-live',
    START_RECORD: 'start-record',
    STOP_RECORD: 'stop-record',
    START_BUFFER: 'start-buffer',
    STOP_BUFFER: 'stop-buffer',
  };

  log = undefined; // Logging function object
  videoEnabled = undefined; // Video stream on camera enabled or not
  audioEnabled = undefined; // Audio from camera enabled or not
  online = undefined; // Camera online or not
  nest_google_uuid = undefined; // Nest/Google UUID of the device connecting
  connected = undefined; // Stream endpoint connection: undefined = not connected , false = connecting , true = connected and streaming
  blankAudio = undefined; // Blank audio 'frame'

  // Internal data only for this class
  #outputTimer = undefined; // Timer for non-blocking loop to stream output data
  #outputs = {}; // Output streams ie: buffer, live, record
  #cameraFrames = {}; // H264 resource frames for offline, video off, transferring
  #sequenceCounters = {}; // Sequence counters for packet types
  #h264Video = {}; // H264 video state for SPS/PPS and IDR frames

  // Codecs being used for video, audio and talking
  get codecs() {
    return {
      video: undefined,
      audio: undefined,
      talkback: undefined,
    };
  }

  constructor(uuid, deviceData, options) {
    // Setup logger object if passed as option
    if (Object.values(LOG_LEVELS).every((fn) => typeof options?.log?.[fn] === 'function')) {
      this.log = options.log;
    }

    // Setup HomeKitDevicee message type handler back to HomeKitDevice classes
    HomeKitDevice.message(uuid, Streamer.MESSAGE, this);
    HomeKitDevice.message(uuid, HomeKitDevice.UPDATE, this); // Register for 'update' message for this uuid also
    HomeKitDevice.message(uuid, HomeKitDevice.SHUTDOWN, this); // Register for 'shutdown' message for this uuid also

    // Store data we need from the device data passed it
    this.migrating = deviceData?.migrating === true;
    this.online = deviceData?.online === true;
    this.videoEnabled = deviceData?.streaming_enabled === true;
    this.audioEnabled = deviceData?.audio_enabled === true;
    this.nest_google_uuid = deviceData?.nest_google_uuid;

    // Load support video frame files as required
    const loadFrameResource = (filename, label) => {
      let buffer = undefined;
      let file = path.resolve(__dirname, RESOURCE_PATH, filename);

      if (fs.existsSync(file) === true) {
        buffer = fs.readFileSync(file);
        if (buffer.indexOf(Streamer.H264NALUS.START_CODE) === 0) {
          buffer = buffer.subarray(Streamer.H264NALUS.START_CODE.length);
        }
      } else {
        this.log?.warn?.('Failed to load %s video resource for "%s"', label, deviceData.description);
      }

      return buffer;
    };

    this.#cameraFrames = {
      offline: loadFrameResource(RESOURCE_FRAMES.CAMERA_OFFLINE, 'offline'),
      off: loadFrameResource(RESOURCE_FRAMES.CAMERA_OFF, 'video off'),
      transfer: loadFrameResource(RESOURCE_FRAMES.CAMERA_TRANSFER, 'transferring'),
    };

    this.#outputLoop(); // Start the output loop to process media packets
  }

  // Class functions
  async onUpdate(deviceData) {
    if (typeof deviceData !== 'object') {
      return;
    }

    if (deviceData?.migrating !== undefined && this.migrating !== deviceData?.migrating) {
      // Migration status has changed
      this.migrating = deviceData.migrating;
    }

    if (deviceData?.nest_google_uuid !== undefined && this.nest_google_uuid !== deviceData?.nest_google_uuid) {
      this.nest_google_uuid = deviceData?.nest_google_uuid;

      if (this.isStreaming() === true || this.isBuffering() === true) {
        // Since the Nest/Google device uuid has changed if there any any active outputs, close and connect again
        // This may occur if a device has migrated between Nest and Google APIs
        this.#doClose();
        this.#doConnect();
      }
    }

    if (
      (deviceData?.online !== undefined && this.online !== deviceData.online) ||
      (deviceData?.streaming_enabled !== undefined && this.videoEnabled !== deviceData.streaming_enabled) ||
      (deviceData?.audio_enabled !== undefined && this.audioEnabled !== deviceData.audio_enabled)
    ) {
      // Online status or streaming status has changed
      if (deviceData?.online !== undefined) {
        this.online = deviceData.online === true;
      }

      if (deviceData?.streaming_enabled !== undefined) {
        this.videoEnabled = deviceData.streaming_enabled === true;
      }

      if (deviceData?.audio_enabled !== undefined) {
        this.audioEnabled = deviceData.audio_enabled === true;
      }

      if (this.isStreaming() === true || this.isBuffering() === true) {
        // Since online, video, audio enabled status has changed, if there any any active outputs, close and connect again
        if (this.online === false || this.videoEnabled === false || this.audioEnabled === false) {
          this.#doClose(); // as offline or streaming not enabled, close streamer
        }
        this.#doConnect();
      }
    }
  }

  async onMessage(type, message) {
    if (typeof type !== 'string' || type === '') {
      return;
    }

    // Ensure a message with sessionID is always a string
    let sessionID = message?.sessionID !== undefined ? String(message.sessionID) : undefined;

    if (type === Streamer.MESSAGE_TYPE.START_BUFFER) {
      // Start buffering media packets
      await this.#startBuffering();
    }

    if (type === Streamer.MESSAGE_TYPE.STOP_BUFFER) {
      // Stop buffering media packets
      await this.#stopBuffering();
    }

    if (type === Streamer.MESSAGE_TYPE.START_LIVE) {
      // Start live HomeKit stream
      return await this.#startLiveStream(sessionID);
    }

    if (type === Streamer.MESSAGE_TYPE.STOP_LIVE) {
      // Stop live stream
      await this.#stopLiveStream(sessionID);
    }

    if (type === Streamer.MESSAGE_TYPE.START_RECORD) {
      // Start recording HomeKit stream
      return await this.#startRecording(sessionID);
    }

    if (type === Streamer.MESSAGE_TYPE.STOP_RECORD) {
      // Stop recording stream
      await this.#stopRecording(sessionID);
    }
  }

  onShutdown() {
    clearInterval(this.#outputTimer);
    this.stopEverything();
  }

  stopEverything() {
    if (this.isStreaming() === true || this.isBuffering() === true) {
      this?.log?.debug?.('Stopped buffering, live and recording from device uuid "%s"', this.nest_google_uuid);
      this.#outputs = {}; // Remove all outputs (live, record, buffer)
      this.#sequenceCounters = {}; // Reset sequence tracking
      this.#h264Video = {}; // Reset cached SPS/PPS and keyframe flag
      this.#doClose(); // Trigger subclass-defined stream close logic
    }
  }

  add(packetType, data, timestamp = Date.now(), sequence = undefined) {
    if (typeof packetType !== 'string' || packetType === '' || Buffer.isBuffer(data) !== true) {
      return;
    }

    packetType = packetType.toLowerCase();
    if (Streamer.PACKET_TYPE?.[packetType.toUpperCase()] === undefined) {
      return;
    }

    if (this.#sequenceCounters?.[packetType] === undefined) {
      this.#sequenceCounters[packetType] = 0;
    }

    let seq = typeof sequence === 'number' ? sequence : this.#sequenceCounters[packetType]++;

    // H264-specific NALU validation
    if (packetType === Streamer.PACKET_TYPE.VIDEO && this.codecs?.video === Streamer.CODEC_TYPE.H264) {
      // Strip start code if present (0x00 00 00 01)
      if (data.indexOf(Streamer.H264NALUS.START_CODE) === 0) {
        data = data.subarray(Streamer.H264NALUS.START_CODE.length);
      }

      if (data.length < 1) {
        return;
      }

      let naluType = data[0] & 0x1f;
      if (naluType === 0 || naluType > 31) {
        return;
      }
    }

    const insertSortedByTime = (buffer, packet) => {
      let low = 0;
      let high = buffer.length;
      while (low < high) {
        let mid = (low + high) >>> 1;
        if (packet.time < buffer[mid].time) {
          high = mid;
        } else {
          low = mid + 1;
        }
      }
      buffer.splice(low, 0, packet);
    };

    // Add new packet to the shared buffer first (__BUFFER)
    if (Array.isArray(this.#outputs?.__BUFFER?.buffer) === true) {
      insertSortedByTime(this.#outputs?.__BUFFER?.buffer, {
        type: packetType,
        data: data,
        time: timestamp,
        sequence: seq,
      });
    }

    // Distribute packet to other outputs
    for (const session of Object.values(this.#outputs)) {
      if (session.type === Streamer.STREAM_TYPE.BUFFER) {
        continue; // already handled __BUFFER above
      }

      // Lazily initialize RECORD stream buffer from shared __BUFFER
      if (session.buffer === undefined && session.type === Streamer.STREAM_TYPE.RECORD) {
        session.buffer = Array.isArray(this.#outputs?.__BUFFER?.buffer) === true ? structuredClone(this.#outputs.__BUFFER.buffer) : [];
        continue; // buffer already includes current packet via clone
      }

      if (Array.isArray(session.buffer) === false) {
        continue;
      }

      // Insert new packet maintaining order
      insertSortedByTime(session.buffer, {
        type: packetType,
        data: data,
        time: timestamp,
        sequence: seq,
      });

      // Trim old packets based on age
      let cutoff = Date.now() - MAX_BUFFER_AGE;
      while (session.buffer.length > 0 && session.buffer[0].time < cutoff) {
        session.buffer.shift();
      }

      // Cap total size
      if (session.buffer.length > 200) {
        session.buffer.splice(0, session.buffer.length - 200);
      }
    }
  }

  #startBuffering() {
    if (this.#outputs?.__BUFFER === undefined) {
      this.#outputs.__BUFFER = {
        type: Streamer.STREAM_TYPE.BUFFER,
        buffer: [],
      };

      this.log?.debug?.('Started buffering from device uuid "%s"', this.nest_google_uuid);

      if (this.connected !== true) {
        this.#doConnect();
      }
    }
  }

  #stopBuffering() {
    if (this.#outputs?.__BUFFER !== undefined) {
      delete this.#outputs.__BUFFER;
      this.log?.debug?.('Stopped buffering from device uuid "%s"', this.nest_google_uuid);

      // If we have no more output streams active, we'll close the connection
      if (this.isStreaming() === false) {
        this.#doClose();
      }
    }
  }

  #startLiveStream(sessionID) {
    if (typeof sessionID !== 'string' || sessionID === '') {
      return;
    }

    if (this.#outputs?.[sessionID] !== undefined) {
      this?.log?.warn?.('Live stream already exists for uuid "%s" and session id "%s"', this.nest_google_uuid, sessionID);
      return {
        video: this.#outputs[sessionID].video,
        audio: this.#outputs[sessionID].audio,
        talkback: this.#outputs[sessionID].talkback,
      };
    }

    let videoOut = new PassThrough(); // Streamer writes video here
    let audioOut = new PassThrough(); // Streamer writes audio here
    let talkbackIn = new PassThrough({ highWaterMark: 1024 * 16 }); // ffmpeg writes talkback here

    // eslint-disable-next-line no-unused-vars
    videoOut?.on?.('error', (error) => {});
    // eslint-disable-next-line no-unused-vars
    audioOut?.on?.('error', (error) => {});
    // eslint-disable-next-line no-unused-vars
    talkbackIn?.on?.('error', (error) => {});

    // Setup talkback handler
    talkbackIn?.on?.('data', (data) => {
      // Received audio data to send onto camera/doorbell for output
      if (typeof this?.sendTalkback === 'function') {
        this.sendTalkback(data);

        clearTimeout(this.#outputs?.[sessionID]?.talkbackTimeout);
        this.#outputs[sessionID].talkbackTimeout = setTimeout(() => {
          // no audio received in 1000ms, so mark end of stream
          this.sendTalkback(Buffer.alloc(0));
        }, TIMERS.TALKBACK_AUDIO);
      }
    });
    talkbackIn?.on?.('close', () => {
      clearTimeout(this.#outputs?.[sessionID]?.talkbackTimeout);
    });

    // Ensure upstream connection is active
    this.#doConnect();

    this.#outputs[sessionID] = {
      type: Streamer.STREAM_TYPE.LIVE,
      video: videoOut,
      audio: audioOut,
      talkback: talkbackIn,
      talkbackTimeout: undefined,
      buffer: [],
    };

    this?.log?.debug?.('Started live stream from device uuid "%s" and session id "%s"', this.nest_google_uuid, sessionID);

    return { video: videoOut, audio: audioOut, talkback: talkbackIn };
  }

  #stopLiveStream(sessionID) {
    let output = this.#outputs?.[sessionID];
    if (output !== undefined) {
      this?.log?.debug?.('Stopped live stream from device uuid "%s" and session id "%s"', this.nest_google_uuid, sessionID);

      // Gracefully end output streams
      output.video?.end?.(); // Video output stream
      output.audio?.end?.(); // Audio output stream
      output.talkback?.end?.(); // Talkback input stream
      clearTimeout(output?.talkbackTimeout);
      delete this.#outputs[sessionID];
    }

    // If no more active streams, close the upstream connection
    if (this.isStreaming() === false && this.isBuffering() === false) {
      this.#doClose();
    }
  }

  #startRecording(sessionID) {
    if (typeof sessionID !== 'string' || sessionID === '') {
      return;
    }

    // Prevent duplicate recording sessions
    if (this.#outputs?.[sessionID] !== undefined) {
      this?.log?.warn?.('Recording stream already exists for uuid "%s" and session id "%s"', this.nest_google_uuid, sessionID);
      return {
        video: this.#outputs[sessionID].video,
        audio: this.#outputs[sessionID].audio,
      };
    }

    // Create stream outputs for ffmpeg to consume
    let videoOut = new PassThrough(); // Streamer writes video here
    let audioOut = new PassThrough(); // Streamer writes audio here

    // eslint-disable-next-line no-unused-vars
    videoOut?.on?.('error', (error) => {});
    // eslint-disable-next-line no-unused-vars
    audioOut?.on?.('error', (error) => {});

    // Ensure upstream connection is active
    this.#doConnect();

    // Register recording session
    this.#outputs[sessionID] = {
      type: Streamer.STREAM_TYPE.RECORD,
      video: videoOut,
      audio: audioOut,
      buffer: undefined,
    };

    this?.log?.debug?.('Started recording stream from device uuid "%s" with session id of "%s"', this.nest_google_uuid, sessionID);

    // Return stream objects for ffmpeg to consume
    return { video: videoOut, audio: audioOut };
  }

  #stopRecording(sessionID) {
    let output = this.#outputs?.[sessionID];
    if (output !== undefined) {
      this?.log?.debug?.('Stopped recording stream from device uuid "%s"', this.nest_google_uuid);

      // Gracefully end output streams
      output.video?.end?.(); // Video output stream
      output.audio?.end?.(); // Audio output stream
      delete this.#outputs[sessionID];
    }

    // If we have no more output streams active, we'll close the connection
    if (this.isStreaming() === false && this.isBuffering() === false) {
      this.#doClose();
    }
  }

  isBuffering() {
    return this.#outputs?.__BUFFER !== undefined;
  }

  isStreaming() {
    return Object.values(this.#outputs).some((x) => x?.type === Streamer.STREAM_TYPE.LIVE || x?.type === Streamer.STREAM_TYPE.RECORD);
  }

  isRecording() {
    return Object.values(this.#outputs).some((x) => x?.type === Streamer.STREAM_TYPE.RECORD);
  }

  isLiveStreaming() {
    return Object.values(this.#outputs).some((x) => x?.type === Streamer.STREAM_TYPE.LIVE);
  }

  async #doConnect() {
    if (this.online === true && this.videoEnabled === true && this.connected === undefined) {
      await this?.connect?.();
    }
  }

  async #doClose() {
    await this?.close?.();
  }

  #outputLoop() {
    // Start a non-blocking loop for output to the various streams which connect to our streamer object
    // This process will also handle the rolling-buffer size we require
    let lastFallbackFrameTime = Date.now();
    this.#outputTimer = setInterval(() => {
      let dateNow = Date.now();

      for (const session of Object.values(this.#outputs)) {
        // Keep our 'main' rolling buffer under a certain size
        // Live/record buffers will always reduce in length in the next section
        if (session.type === Streamer.STREAM_TYPE.BUFFER) {
          let cutoffTime = dateNow - MAX_BUFFER_AGE;
          while (session.buffer.length > 0 && session.buffer[0].time < cutoffTime) {
            session.buffer.shift();
          }
          continue;
        }

        // Output fallback frame directly for offline, video disabled, or migrating
        // This is required as the streamer may be disconnected or has no incoming packets
        // We will pace this at ~30fps (every STREAM_FRAME_INTERVAL)
        if (dateNow - lastFallbackFrameTime >= STREAM_FRAME_INTERVAL) {
          let fallbackFrame =
            this.online === false && this.#cameraFrames?.offline
              ? this.#cameraFrames.offline
              : this.online === true && this.videoEnabled === false && this.#cameraFrames?.off
                ? this.#cameraFrames.off
                : this.migrating === true && this.#cameraFrames?.transfer
                  ? this.#cameraFrames.transfer
                  : undefined;

          if (Buffer.isBuffer(fallbackFrame) === true) {
            if (this.codecs?.video === Streamer.CODEC_TYPE.H264) {
              session?.video?.write?.(Streamer.H264NALUS.START_CODE);
            }
            session?.video?.write?.(fallbackFrame);
            session?.audio?.write?.(this.blankAudio);
            lastFallbackFrameTime = dateNow;
            continue;
          }
        }

        // Normal buffered video output using actual packet timestamps
        if (this.connected === true && (session.type === Streamer.STREAM_TYPE.LIVE || session.type === Streamer.STREAM_TYPE.RECORD)) {
          while (
            session?.buffer?.length > 0 &&
            session.buffer[0].type === Streamer.PACKET_TYPE.VIDEO &&
            session.buffer[0].time <= dateNow
          ) {
            let packet = session.buffer.shift();
            if (this.codecs?.video === Streamer.CODEC_TYPE.H264) {
              session?.video?.write?.(Streamer.H264NALUS.START_CODE);
            }
            session?.video?.write?.(packet.data);
          }

          // Output any available audio packets immediately (based on timestamp)
          while (
            session?.buffer?.length > 0 &&
            session.buffer[0].type === Streamer.PACKET_TYPE.AUDIO &&
            session.buffer[0].time <= dateNow
          ) {
            let packet = session.buffer.shift();
            session?.audio?.write?.(packet.data);
          }
        }
      }
    }, 5); // Every 5ms
  }
}
