// streamer
// Part of homebridge-nest-accfactory
//
// This is the base class for all Camera/Doorbell streaming
//
// Buffers a single audio/video stream which allows multiple HomeKit devices to connect to the single stream
// for live viewing and/or recording
//
// The following functions should be overriden in your class which extends this
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
// Code version 2025.06.30
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { Buffer } from 'node:buffer';
import { setInterval, setTimeout, clearTimeout } from 'node:timers';
import fs from 'fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Define constants
const CAMERA_RESOURCE = {
  OFFLINE: 'Nest_camera_offline.h264',
  OFF: 'Nest_camera_off.h264',
  TRANSFER: 'Nest_camera_transfer.h264',
};
const TALKBACK_AUDIO_TIMEOUT = 1000;
const MAX_BUFFER_AGE = 5000; // Keep last 5s of media in buffer
const STREAM_FRAME_INTERVAL = 1000 / 30; // 30fps approx
const RESOURCE_PATH = './res';
const __dirname = path.dirname(fileURLToPath(import.meta.url)); // Make a defined for JS __dirname
const LOG_LEVELS = {
  INFO: 'info',
  SUCCESS: 'success',
  WARN: 'warn',
  ERROR: 'error',
  DEBUG: 'debug',
};

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
  #cameraOfflineFrame = undefined; // Camera offline video frame
  #cameraVideoOffFrame = undefined; // Video turned off on camera video frame
  #cameraTransferringFrame = undefined; // Camera transferring between Nest/Google Home video frame
  #sequenceCounters = {}; // Sequence counters for packet types
  #h264Video = {}; // H264 video state for SPS/PPS and IDR frames

  // Codecs being used for video, audio and talking
  get codecs() {
    return {
      video: undefined,
      audio: undefined,
      talk: undefined,
    };
  }

  constructor(nest_google_uuid, deviceData, options) {
    // Setup logger object if passed as option
    if (Object.values(LOG_LEVELS).every((fn) => typeof options?.log?.[fn] === 'function')) {
      this.log = options.log;
    }

    // Store data we need from the device data passed it
    this.migrating = deviceData?.migrating === true;
    this.online = deviceData?.online === true;
    this.videoEnabled = deviceData?.streaming_enabled === true;
    this.audioEnabled = deviceData?.audio_enabled === true;
    this.nest_google_uuid = nest_google_uuid;

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

    this.#cameraOfflineFrame = loadFrameResource(CAMERA_RESOURCE.OFFLINE, 'offline');
    this.#cameraVideoOffFrame = loadFrameResource(CAMERA_RESOURCE.OFF, 'video off');
    this.#cameraTransferringFrame = loadFrameResource(CAMERA_RESOURCE.TRANSFER, 'transferring');

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
          if (this.online === false && this.#cameraOfflineFrame !== undefined) {
            // Camera is offline so feed in our custom h264 frame and AAC silence
            if (this.codecs?.video === Streamer.CODEC_TYPE.H264) {
              session?.video?.write?.(Buffer.concat([Streamer.H264NALUS.START_CODE, this.#cameraOfflineFrame]));
            } else {
              session?.video?.write?.(this.#cameraOfflineFrame);
            }
            session?.audio?.write?.(this.blankAudio);
            lastFallbackFrameTime = dateNow;
            continue;
          }

          if (this.online === true && this.videoEnabled === false && this.#cameraVideoOffFrame !== undefined) {
            // Camera video is turned off so feed in our custom h264 frame and AAC silence
            if (this.codecs?.video === Streamer.CODEC_TYPE.H264) {
              session?.video?.write?.(Buffer.concat([Streamer.H264NALUS.START_CODE, this.#cameraVideoOffFrame]));
            } else {
              session?.video?.write?.(this.#cameraVideoOffFrame);
            }
            session?.audio?.write?.(this.blankAudio);
            lastFallbackFrameTime = dateNow;
            continue;
          }

          if (this.migrating === true && this.#cameraTransferringFrame !== undefined) {
            // Camera is migrating between Nest/Google Home so feed in custom h264 frame and AAC silence
            if (this.codecs?.video === Streamer.CODEC_TYPE.H264) {
              session?.video?.write?.(Buffer.concat([Streamer.H264NALUS.START_CODE, this.#cameraTransferringFrame]));
            } else {
              session?.video?.write?.(this.#cameraTransferringFrame);
            }
            session?.audio?.write?.(this.blankAudio);
            lastFallbackFrameTime = dateNow;
            continue;
          }
        }

        // Normal buffered video output using actual packet timestamps
        if (session.type === Streamer.STREAM_TYPE.LIVE || session.type === Streamer.STREAM_TYPE.RECORD) {
          while (session.buffer.length > 0 && session.buffer[0].type === Streamer.PACKET_TYPE.VIDEO && session.buffer[0].time <= dateNow) {
            let packet = session.buffer.shift();
            if (this.codecs?.video === Streamer.CODEC_TYPE.H264) {
              packet.data = Buffer.concat([Streamer.H264NALUS.START_CODE, packet.data]);
            }
            session?.video?.write?.(packet.data);
          }

          // Output any available audio packets immediately (based on timestamp)
          while (session.buffer.length > 0 && session.buffer[0].type === Streamer.PACKET_TYPE.AUDIO && session.buffer[0].time <= dateNow) {
            let packet = session.buffer.shift();
            session?.audio?.write?.(packet.data);
          }
        }
      }
    }, 5); // Every 5ms
  }

  // Class functions
  startBuffering() {
    if (this.#outputs?.buffer === undefined) {
      // No active buffer session, start connection to streamer
      if (this.online === true && this.videoEnabled === true && this.connected === undefined && typeof this.connect === 'function') {
        this?.log?.debug?.('Started buffering for uuid "%s"', this.nest_google_uuid);
        this.connect();
      }

      this.#outputs.buffer = {
        type: Streamer.STREAM_TYPE.BUFFER,
        buffer: [],
      };
    }
  }

  startLiveStream(sessionID, videoStream, audioStream, talkbackStream) {
    // Setup error catching for video/audio/talkback streams
    if (videoStream !== null && typeof videoStream === 'object') {
      videoStream.on('error', () => {
        // EPIPE errors??
      });
    }

    if (audioStream !== null && typeof audioStream === 'object') {
      audioStream.on('error', () => {
        // EPIPE errors??
      });
    }

    if (talkbackStream !== null && typeof talkbackStream === 'object') {
      let talkbackTimeout = undefined;

      talkbackStream.on('error', () => {
        // EPIPE errors??
      });

      talkbackStream.on('data', (data) => {
        // Received audio data to send onto camera/doorbell for output
        if (typeof this?.sendTalkback === 'function') {
          this.sendTalkback(data);

          clearTimeout(talkbackTimeout);
          talkbackTimeout = setTimeout(() => {
            // no audio received in 1000ms, so mark end of stream
            this.sendTalkback(Buffer.alloc(0));
          }, TALKBACK_AUDIO_TIMEOUT);
        }
      });
    }

    // If we do not have an active connection, so startup connection
    this.#doConnect();

    // Assign session
    this.#outputs[sessionID] = {
      type: Streamer.STREAM_TYPE.LIVE,
      video: videoStream,
      audio: audioStream,
      talk: talkbackStream,
      buffer: [],
    };

    // finally, we've started live stream
    this?.log?.debug?.(
      'Started live stream from uuid "%s" %s "%s"',
      this.nest_google_uuid,
      talkbackStream !== null && typeof talkbackStream === 'object' ? 'with two-way audio and session id of' : 'and session id of',
      sessionID,
    );
  }

  startRecording(sessionID, videoStream, audioStream) {
    // Setup error catching for video/audio streams
    if (videoStream !== null && typeof videoStream === 'object') {
      videoStream.on('error', () => {
        // EPIPE errors??
      });
    }

    if (audioStream !== null && typeof audioStream === 'object') {
      audioStream.on('error', () => {
        // EPIPE errors??
      });
    }

    // If we do not have an active connection, so startup connection
    this.#doConnect();

    // Capture recent buffer frames within the past 3000ms
    let now = Date.now();
    let recentBuffer = Array.isArray(this.#outputs?.buffer?.buffer)
      ? this.#outputs.buffer.buffer.filter(
          (packet) =>
            typeof packet?.time === 'number' &&
            packet.time >= now - 3000 &&
            (packet.type === Streamer.PACKET_TYPE.VIDEO || packet.type === Streamer.PACKET_TYPE.AUDIO),
        )
      : [];

    this.#outputs[sessionID] = {
      type: Streamer.STREAM_TYPE.RECORD,
      video: videoStream,
      audio: audioStream,
      buffer: recentBuffer,
    };

    // Finally we've started the recording stream
    this?.log?.debug?.('Started recording stream from uuid "%s" with session id of "%s"', this.nest_google_uuid, sessionID);
  }

  stopRecording(sessionID) {
    // Request to stop a recording stream
    if (this.#outputs?.[sessionID] !== undefined) {
      this?.log?.debug?.('Stopped recording stream from uuid "%s"', this.nest_google_uuid);

      // Gracefully close audio and video pipes
      this.#outputs?.[sessionID]?.video?.end?.();
      this.#outputs?.[sessionID]?.audio?.end?.();

      delete this.#outputs[sessionID];
    }

    // If we have no more output streams active, we'll close the connection
    if (this.isStreaming() === false) {
      this.#doClose();
    }
  }

  stopLiveStream(sessionID) {
    // Request to stop an active live stream
    if (this.#outputs?.[sessionID] !== undefined) {
      this?.log?.debug?.('Stopped live stream from uuid "%s"', this.nest_google_uuid);

      // Gracefully close audio and video pipes
      this.#outputs?.[sessionID]?.video?.end?.();
      this.#outputs?.[sessionID]?.audio?.end?.();

      delete this.#outputs[sessionID];
    }

    // If we have no more output streams active, we'll close the connection
    if (this.isStreaming() === false) {
      this.#doClose();
    }
  }

  stopBuffering() {
    if (this.#outputs?.buffer !== undefined) {
      this?.log?.debug?.('Stopped buffering from uuid "%s"', this.nest_google_uuid);
      delete this.#outputs.buffer;
    }

    // If we have no more output streams active, we'll close the connection
    if (this.isStreaming() === false) {
      this.#doClose();
    }
  }

  stop() {
    if (this.isStreaming() === true) {
      this?.log?.debug?.('Stopped buffering, live and recording from uuid "%s"', this.nest_google_uuid);
      this.#outputs = {}; // Remove all outputs (live, record, buffer)
      this.#sequenceCounters = {}; // Reset sequence tracking
      this.#h264Video = {}; // Reset cached SPS/PPS and keyframe flag
      this.#doClose(); // Trigger subclass-defined stream close logic
    }
  }

  onUpdate(deviceData) {
    if (typeof deviceData !== 'object') {
      return;
    }

    this.migrating = deviceData.migrating;

    if (this.nest_google_uuid !== deviceData?.nest_google_uuid) {
      this.nest_google_uuid = deviceData?.nest_google_uuid;

      if (this.isStreaming() === true) {
        // Since the uuid has change and a streamer may use this, if there any any active outputs, close and connect again
        this.#doClose();
        this.#doConnect();
      }
    }

    if (
      this.online !== deviceData.online ||
      this.videoEnabled !== deviceData.streaming_enabled ||
      this.audioEnabled !== deviceData?.audio_enabled
    ) {
      // Online status or streaming status has changed
      this.online = deviceData?.online === true;
      this.videoEnabled = deviceData?.streaming_enabled === true;
      this.audioEnabled = deviceData?.audio_enabled === true;

      if (this.isStreaming() === true) {
        // Since online, video, audio enabled status has changed, if there any any active outputs, close and connect again
        if (this.online === false || this.videoEnabled === false || this.audioEnabled === false) {
          this.#doClose(); // as offline or streaming not enabled, close streamer
        }
        this.#doConnect();
      }
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

    for (const session of Object.values(this.#outputs)) {
      if (Array.isArray(session?.buffer) === true) {
        session.buffer.push({
          type: packetType,
          data,
          time: timestamp,
          sequence: seq,
        });

        session.buffer.sort((a, b) => a.time - b.time);

        let cutoff = Date.now() - MAX_BUFFER_AGE;
        while (session.buffer.length > 0 && session.buffer[0].time < cutoff) {
          session.buffer.shift();
        }

        if (session.buffer.length > 200) {
          session.buffer.splice(0, session.buffer.length - 200);
        }
      }
    }
  }

  isBuffering() {
    return Object.values(this.#outputs).some((x) => Array.isArray(x?.buffer));
  }

  isStreaming() {
    return Object.keys(this.#outputs).length > 0;
  }

  isRecording() {
    return Object.values(this.#outputs).some((x) => x?.type === Streamer.STREAM_TYPE.RECORD);
  }

  isLiveStreaming() {
    return Object.values(this.#outputs).some((x) => x?.type === Streamer.STREAM_TYPE.LIVE);
  }

  #doConnect() {
    if (this.online === true && this.videoEnabled === true && this.connected === undefined && typeof this.connect === 'function') {
      this.connect();
    }
  }

  #doClose() {
    if (typeof this.close === 'function') {
      this.close();
    }
  }
}
