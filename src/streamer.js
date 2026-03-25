// streamer
// Part of homebridge-nest-accfactory
//
// This is the base class for all Camera/Doorbell streaming
//
// Buffers a single audio/video stream which allows multiple HomeKit devices to connect to the single stream
// for live viewing and/or recording
//
// The following functions should be defined in your class which extends this:
//
// streamer.connect()
// streamer.close()
// streamer.sendTalkback(talkingBuffer)
// streamer.onUpdate(deviceData)
// streamer.onShutdown() <- should stop all streaming and buffering and clean up resources
//
// The following getters should be overridden in your class which extends this:
//
// streamer.codecs <- return object with codecs being used (video, audio, talkback)
// streamer.capabilities <- return object with streaming capabilities (live, record, talkback, buffering)
//
// The following properties should be overridden in your class which extends this:
//
// blankAudio - Buffer containing a blank audio segment for the type of audio being used
//
// Code version 2026.03.25
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

const MAX_BUFFER_AGE = 5000; // Keep last 5s of media in shared rotating buffer
const MAX_PACKETS_PER_OUTPUT_PER_TICK = 20; // Prevent one output starving others
const STREAM_FRAME_INTERVAL = 1000 / 30; // 30fps approx
const OUTPUT_LOOP_INTERVAL = 10; // Shared output scheduler interval

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

  // Shared global scheduler for all active Streamer instances
  // This avoids having one timer per camera and reduces event loop overhead
  static #streamers = new Map(); // uuid => Streamer instance
  static #timer = undefined; // Shared timer for all active streamers

  log = undefined; // Logging function object
  uuid = undefined; // HomeKitDevice uuid for this streamer
  videoEnabled = undefined; // Video stream on camera enabled or not
  audioEnabled = undefined; // Audio from camera enabled or not
  online = undefined; // Camera online or not
  migrating = undefined; // Device is transferring/migrating between APIs
  nest_google_device_uuid = undefined; // Nest/Google UUID of the device connecting
  connected = undefined; // Stream endpoint connection: undefined = not connected , false = connecting , true = connected and streaming
  blankAudio = undefined; // Blank audio 'frame'

  // Internal data only for this class
  #buffer = undefined; // Shared rotating packet buffer used by buffering, live and recording outputs
  #record = undefined; // Single recording output for this camera instance
  #live = new Map(); // Live outputs keyed by session id
  #cameraFrames = {}; // H264 resource frames for offline, video off, transferring
  #sequenceCounters = {}; // Sequence counters for packet types
  #packetIndex = 0; // Monotonic packet index for shared buffer cursor tracking
  #h264Video = {}; // H264 video state for SPS/PPS and IDR frames
  #lastFallbackFrameTime = 0; // Timer for pacing fallback frames
  #outputErrors = 0; // Consecutive output loop failures for this instance
  #lastPacketTime = {}; // Track last packet time per type for monotonic timestamp enforcement

  // Codecs being used for video, audio and talking
  get codecs() {
    return {
      video: undefined,
      audio: undefined,
      talkback: undefined,
    };
  }

  // Capabilities supported by this streamer
  get capabilities() {
    return {
      live: false,
      record: false,
      talkback: false,
      buffering: false,
    };
  }

  constructor(uuid, deviceData, options) {
    // Setup logger object if passed as option
    if (Object.values(LOG_LEVELS).every((fn) => typeof options?.log?.[fn] === 'function')) {
      this.log = options.log;
    }

    this.uuid = uuid;

    // Setup HomeKitDevice message type handler back to HomeKitDevice classes
    HomeKitDevice.message(uuid, Streamer.MESSAGE, this);
    HomeKitDevice.message(uuid, HomeKitDevice.UPDATE, this); // Register for 'update' message for this uuid also
    HomeKitDevice.message(uuid, HomeKitDevice.TIMER, this); // Register for 'timer' message for this uuid also
    HomeKitDevice.message(uuid, HomeKitDevice.SHUTDOWN, this); // Register for 'shutdown' message for this uuid also

    // Store data we need from the device data passed it
    this.migrating = deviceData?.migrating === true;
    this.online = deviceData?.online === true;
    this.videoEnabled = deviceData?.streaming_enabled === true;
    this.audioEnabled = deviceData?.audio_enabled === true;
    this.nest_google_device_uuid = deviceData?.nest_google_device_uuid;

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

    this.#lastFallbackFrameTime = Date.now();
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

    if (deviceData?.nest_google_device_uuid !== undefined && this.nest_google_device_uuid !== deviceData?.nest_google_device_uuid) {
      this.nest_google_device_uuid = deviceData?.nest_google_device_uuid;

      if (this.hasActiveStreams() === true) {
        // Since the Nest/Google device uuid has changed if there any any active streams, close and connect again
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

      if (this.hasActiveStreams() === true) {
        // Since online, video, audio enabled status has changed, if there are any active streams, close and connect again
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

    let sessionID = message?.sessionID !== undefined ? String(message.sessionID) : undefined;

    if (type === Streamer.MESSAGE_TYPE.START_BUFFER) {
      if (this.capabilities.buffering !== true) {
        this?.log?.debug?.('Buffering is unsupported for "%s"', this.nest_google_device_uuid);
        return;
      }

      await this.#startBuffering();
    }

    if (type === Streamer.MESSAGE_TYPE.STOP_BUFFER) {
      if (this.capabilities.buffering !== true) {
        this?.log?.debug?.('Buffering is unsupported for "%s"', this.nest_google_device_uuid);
        return;
      }

      await this.#stopBuffering();
    }

    if (type === Streamer.MESSAGE_TYPE.START_LIVE) {
      if (this.capabilities.live !== true) {
        this?.log?.debug?.('Live streaming is unsupported for "%s"', this.nest_google_device_uuid);
        return;
      }

      return await this.#startLiveStream(sessionID, message?.includeAudio === true);
    }

    if (type === Streamer.MESSAGE_TYPE.STOP_LIVE) {
      if (this.capabilities.live !== true) {
        this?.log?.debug?.('Live streaming is unsupported for "%s"', this.nest_google_device_uuid);
        return;
      }

      await this.#stopLiveStream(sessionID);
    }

    if (type === Streamer.MESSAGE_TYPE.START_RECORD) {
      if (this.capabilities.record !== true) {
        this?.log?.debug?.('Recording is unsupported for "%s"', this.nest_google_device_uuid);
        return;
      }

      return await this.#startRecording(sessionID, message?.includeAudio === true);
    }

    if (type === Streamer.MESSAGE_TYPE.STOP_RECORD) {
      if (this.capabilities.record !== true) {
        this?.log?.debug?.('Recording is unsupported for "%s"', this.nest_google_device_uuid);
        return;
      }

      await this.#stopRecording(sessionID);
    }
  }

  onShutdown() {
    Streamer.#removeStreamer(this);
    this.stopEverything();
  }

  stopEverything() {
    if (this.hasActiveStreams() === true) {
      this?.log?.debug?.('Stopped buffering, live and recording from device uuid "%s"', this.nest_google_device_uuid);

      this.#cleanupOutput(this.#record);

      for (let output of this.#live.values()) {
        this.#cleanupOutput(output);
      }

      this.#buffer = undefined;
      this.#record = undefined;
      this.#live.clear();
      this.#sequenceCounters = {}; // Reset sequence tracking
      this.#packetIndex = 0; // Reset shared packet index tracking
      this.#h264Video = {}; // Reset cached SPS/PPS and keyframe flag
      this.#lastPacketTime = {};
      this.#syncSchedulerState();
      this.#doClose(); // Trigger subclass-defined stream close logic
    }
  }

  addPacket(packet) {
    if (typeof packet !== 'object' || packet === null || Buffer.isBuffer(packet?.data) !== true) {
      return;
    }

    if (typeof packet?.type !== 'string' || packet.type.trim() === '') {
      return;
    }

    packet.type = packet.type.toLowerCase();
    if (Streamer.PACKET_TYPE?.[packet.type.toUpperCase()] === undefined) {
      return;
    }

    if (this.#sequenceCounters?.[packet.type] === undefined) {
      this.#sequenceCounters[packet.type] = 0;
    }

    if (this.#lastPacketTime?.[packet.type] === undefined) {
      this.#lastPacketTime[packet.type] = 0;
    }

    let codec =
      typeof packet?.codec === 'string'
        ? packet.codec.toLowerCase()
        : packet.type === Streamer.PACKET_TYPE.VIDEO
          ? this.codecs?.video
          : packet.type === Streamer.PACKET_TYPE.AUDIO
            ? this.codecs?.audio
            : undefined;
    let keyFrame = packet?.keyFrame === true;
    let packetTime = typeof packet?.timestamp === 'number' && Number.isNaN(packet.timestamp) === false ? packet.timestamp : Date.now();
    let sequence = typeof packet?.sequence === 'number' ? packet.sequence : this.#sequenceCounters[packet.type]++;
    let nalUnits = undefined;
    let data = packet.data;

    // Ensure buffer exists whenever we have buffering, live, or record active
    if (this.#buffer === undefined) {
      this.#ensureSharedBuffer(false);
    }

    if (this.#buffer === undefined) {
      return;
    }

    // H264-specific NALU validation and metadata tracking
    if (packet.type === Streamer.PACKET_TYPE.VIDEO && codec === Streamer.CODEC_TYPE.H264) {
      nalUnits = this.#getH264NALUnits(data);
      if (Array.isArray(nalUnits) !== true || nalUnits.length === 0) {
        return;
      }

      data =
        nalUnits.length === 1
          ? nalUnits[0].data
          : data.indexOf(Streamer.H264NALUS.START_CODE) === 0
            ? data
            : Buffer.concat(nalUnits.flatMap((nalu) => [Streamer.H264NALUS.START_CODE, nalu.data]));

      if (keyFrame !== true) {
        keyFrame = nalUnits.some((nalu) => nalu.type === Streamer.H264NALUS.TYPES.IDR);
      }

      nalUnits.forEach((nalu) => {
        if (nalu.type === Streamer.H264NALUS.TYPES.SPS) {
          this.#h264Video.lastSPS = nalu.data;
        }

        if (nalu.type === Streamer.H264NALUS.TYPES.PPS) {
          this.#h264Video.lastPPS = nalu.data;
        }

        if (nalu.type === Streamer.H264NALUS.TYPES.IDR) {
          this.#h264Video.lastIDR = nalu.data;
        }
      });

      if (data.indexOf(Streamer.H264NALUS.START_CODE) === 0) {
        data = data.subarray(Streamer.H264NALUS.START_CODE.length);
      }

      if (keyFrame === true) {
        this.#h264Video.lastIDRIndex = this.#packetIndex;
      }
    }

    // Keep timestamps monotonic per packet type inside the shared append-only buffer
    if (packetTime < this.#lastPacketTime[packet.type]) {
      packetTime = this.#lastPacketTime[packet.type];
    }
    this.#lastPacketTime[packet.type] = packetTime;

    this.#buffer.packets.push({
      index: this.#packetIndex++,
      type: packet.type,
      codec: codec,
      data: data,
      time: packetTime,
      sequence: sequence,
      keyFrame: keyFrame === true,
    });
  }

  #startBuffering() {
    this.#ensureSharedBuffer(true);

    if (this.#buffer?.enabled === true) {
      return;
    }

    this.#buffer.enabled = true;
    this.log?.debug?.('Started buffering from device uuid "%s"', this.nest_google_device_uuid);
    this.#syncSchedulerState();

    if (this.connected !== true) {
      this.#doConnect();
    }
  }

  #stopBuffering() {
    if (this.#buffer?.enabled !== true) {
      return;
    }

    this.#buffer.enabled = false;
    this.log?.debug?.('Stopped buffering from device uuid "%s"', this.nest_google_device_uuid);

    // If no live/record outputs remain, fully remove buffer and close connection
    if (this.isStreaming() === false) {
      this.#buffer = undefined;
      this.#packetIndex = 0;
      this.#h264Video = {};
      this.#lastPacketTime = {};
      this.#syncSchedulerState();
      this.#doClose();
      return;
    }

    this.#syncSchedulerState();
  }

  #startLiveStream(sessionID, includeAudio = true) {
    if (typeof sessionID !== 'string' || sessionID === '') {
      return;
    }

    if (this.#live.has(sessionID) === true) {
      this?.log?.warn?.('Live stream already exists for uuid "%s" and session id "%s"', this.nest_google_device_uuid, sessionID);
      let existing = this.#live.get(sessionID);
      return {
        video: existing.video,
        audio: existing.audio,
        talkback: existing.talkback,
      };
    }

    let videoOut = new PassThrough(); // Streamer writes video here
    let audioOut = includeAudio === true ? new PassThrough() : null; // Conditionally create audio stream
    let talkbackIn = includeAudio === true ? new PassThrough({ highWaterMark: 1024 * 16 }) : null; // Conditionally create talkback stream

    // eslint-disable-next-line no-unused-vars
    videoOut?.on?.('error', (error) => {});
    // eslint-disable-next-line no-unused-vars
    audioOut?.on?.('error', (error) => {});
    // eslint-disable-next-line no-unused-vars
    talkbackIn?.on?.('error', (error) => {});

    this.#ensureSharedBuffer(false);

    // Get starting cursor for live stream
    // this will be the packet index in the shared buffer where the live stream should start from
    let startCursor = this.#packetIndex;

    if (this.#buffer !== undefined) {
      let bufferStart = this.#buffer.startIndex;

      // Align with existing live streams (shared timeline)
      if (this.#live.size !== 0) {
        let minCursor = Infinity;

        for (let output of this.#live.values()) {
          if (typeof output?.cursor === 'number') {
            minCursor = Math.min(minCursor, output.cursor);
          }
        }

        if (minCursor !== Infinity) {
          startCursor = Math.max(bufferStart, minCursor);
        }
      } else if (typeof this.#h264Video?.lastIDRIndex === 'number' && this.#h264Video.lastIDRIndex >= bufferStart) {
        // No live viewers currently connected, so start from latest cached IDR in buffer
        startCursor = this.#h264Video.lastIDRIndex;
      } else {
        // Fallback to oldest packet currently retained in buffer
        startCursor = bufferStart;
      }
    }

    // Setup talkback handler
    talkbackIn?.on?.('data', (data) => {
      let output = this.#live.get(sessionID);

      // Received audio data to send onto camera/doorbell for output
      if (typeof this?.sendTalkback === 'function' && output !== undefined) {
        this.sendTalkback(data);

        clearTimeout(output.talkbackTimeout);
        output.talkbackTimeout = setTimeout(() => {
          // no audio received in 1000ms, so mark end of stream
          this.sendTalkback(Buffer.alloc(0));
        }, TIMERS.TALKBACK_AUDIO.interval);
      }
    });
    talkbackIn?.on?.('close', () => {
      clearTimeout(this.#live.get(sessionID)?.talkbackTimeout);
    });

    // Ensure upstream connection is active
    this.#doConnect();

    this.#live.set(sessionID, {
      sessionID: sessionID,
      video: videoOut,
      audio: audioOut,
      talkback: talkbackIn,
      talkbackTimeout: undefined,
      includeAudio: includeAudio === true,
      cursor: startCursor,
      sentCodecConfig: false,
      seenKeyFrame: false,
    });

    this?.log?.debug?.('Started live stream from device uuid "%s" and session id "%s"', this.nest_google_device_uuid, sessionID);
    this.#syncSchedulerState();

    return { video: videoOut, audio: audioOut, talkback: talkbackIn };
  }

  #stopLiveStream(sessionID) {
    let output = this.#live.get(sessionID);
    if (output !== undefined) {
      this?.log?.debug?.('Stopped live stream from device uuid "%s" and session id "%s"', this.nest_google_device_uuid, sessionID);

      this.#cleanupOutput(output);
      this.#live.delete(sessionID);
    }

    if (this.#live.size === 0 && this.#record === undefined && this.#buffer?.enabled !== true) {
      this.#buffer = undefined;
      this.#packetIndex = 0;
      this.#h264Video = {};
    }

    this.#syncSchedulerState();

    // If no more active streams, close the upstream connection
    if (this.isStreaming() === false && this.isBuffering() === false) {
      this.#doClose();
    }
  }

  #startRecording(sessionID, includeAudio = true) {
    if (typeof sessionID !== 'string' || sessionID === '') {
      return;
    }

    // Prevent duplicate recording sessions
    if (this.#record !== undefined) {
      this?.log?.warn?.(
        'Recording stream already exists for uuid "%s" and session id "%s"',
        this.nest_google_device_uuid,
        this.#record.sessionID,
      );
      return {
        video: this.#record.video,
        audio: this.#record.audio,
      };
    }

    // Create stream outputs for ffmpeg to consume
    let videoOut = new PassThrough(); // Streamer writes video here
    let audioOut = includeAudio === true ? new PassThrough() : null; // Conditionally create audio stream

    // eslint-disable-next-line no-unused-vars
    videoOut?.on?.('error', (error) => {});
    // eslint-disable-next-line no-unused-vars
    audioOut?.on?.('error', (error) => {});

    this.#ensureSharedBuffer(false);

    // Ensure upstream connection is active
    this.#doConnect();

    // Register recording session
    this.#record = {
      sessionID: sessionID,
      video: videoOut,
      audio: audioOut,
      includeAudio: includeAudio === true,
      cursor: this.#buffer?.startIndex ?? this.#packetIndex,
      sentCodecConfig: false,
      seenKeyFrame: false,
    };

    this?.log?.debug?.('Started recording stream from device uuid "%s" with session id of "%s"', this.nest_google_device_uuid, sessionID);
    this.#syncSchedulerState();

    // Return stream objects for ffmpeg to consume
    return { video: videoOut, audio: audioOut };
  }

  #stopRecording(sessionID) {
    if (this.#record !== undefined && (sessionID === undefined || this.#record.sessionID === sessionID)) {
      this?.log?.debug?.('Stopped recording stream from device uuid "%s"', this.nest_google_device_uuid);

      this.#cleanupOutput(this.#record);
      this.#record = undefined;
    }

    if (this.#record === undefined && this.#live.size === 0 && this.#buffer?.enabled !== true) {
      this.#buffer = undefined;
      this.#packetIndex = 0;
      this.#h264Video = {};
    }

    this.#syncSchedulerState();

    // If we have no more output streams active, we'll close the connection
    if (this.isStreaming() === false && this.isBuffering() === false) {
      this.#doClose();
    }
  }

  isBuffering() {
    return this.#buffer?.enabled === true;
  }

  isStreaming() {
    return this.#record !== undefined || this.#live.size !== 0;
  }

  isRecording() {
    return this.#record !== undefined;
  }

  isLiveStreaming() {
    return this.#live.size !== 0;
  }

  hasActiveStreams() {
    return this.#buffer?.enabled === true || this.#record !== undefined || this.#live.size !== 0;
  }

  async #doConnect() {
    if (this.online === true && this.videoEnabled === true && this.connected === undefined) {
      await this?.connect?.();
    }
  }

  async #doClose() {
    await this?.close?.();
  }

  #cleanupOutput(output) {
    if (typeof output !== 'object' || output === null) {
      return;
    }

    clearTimeout(output?.talkbackTimeout);

    output?.video?.removeAllListeners?.();
    output?.audio?.removeAllListeners?.();
    output?.talkback?.removeAllListeners?.();

    output?.video?.end?.();
    output?.audio?.end?.();
    output?.talkback?.end?.();
  }

  #ensureSharedBuffer(enabled = false) {
    if (this.#buffer === undefined) {
      this.#buffer = {
        enabled: enabled === true,
        packets: [],
        startIndex: this.#packetIndex,
      };
      return;
    }

    if (enabled === true) {
      this.#buffer.enabled = true;
    }
  }

  #getH264NALUnits(data) {
    let nalUnits = [];
    let offset = 0;
    let start = -1;
    let nextStart = -1;
    let startCodeLength = 0;

    if (Buffer.isBuffer(data) !== true || data.length === 0) {
      return nalUnits;
    }

    if (data.indexOf(Streamer.H264NALUS.START_CODE) !== 0) {
      return [{ type: data[0] & 0x1f, data: data }];
    }

    while (offset < data.length - 3) {
      if (data[offset] === 0x00 && data[offset + 1] === 0x00 && data[offset + 2] === 0x00 && data[offset + 3] === 0x01) {
        start = offset;
        startCodeLength = 4;
        offset += 4;
        nextStart = data.indexOf(Streamer.H264NALUS.START_CODE, offset);

        if (nextStart === -1) {
          nextStart = data.length;
        }

        if (start + startCodeLength < nextStart) {
          nalUnits.push({
            type: data[start + startCodeLength] & 0x1f,
            data: data.subarray(start + startCodeLength, nextStart),
          });
        }

        offset = nextStart;
        continue;
      }

      offset++;
    }

    return nalUnits;
  }

  #getFallbackFrame() {
    return this.online === false && this.#cameraFrames?.offline
      ? this.#cameraFrames.offline
      : this.online === true && this.videoEnabled === false && this.#cameraFrames?.off
        ? this.#cameraFrames.off
        : this.migrating === true && this.#cameraFrames?.transfer
          ? this.#cameraFrames.transfer
          : undefined;
  }

  #writeFallback(output, fallbackFrame) {
    if (Buffer.isBuffer(fallbackFrame) !== true || typeof output !== 'object' || output === null) {
      return;
    }

    if (this.codecs?.video === Streamer.CODEC_TYPE.H264) {
      output?.video?.write?.(Streamer.H264NALUS.START_CODE);
    }
    output?.video?.write?.(fallbackFrame);

    if (output?.includeAudio === true && Buffer.isBuffer(this.blankAudio) === true) {
      output?.audio?.write?.(this.blankAudio);
    }
  }

  #writeBufferedPackets(output, dateNow) {
    let packets = this.#buffer?.packets;
    let processed = 0;
    let offset = 0;
    let packet = undefined;
    let wroteAudio = false;

    if (typeof output !== 'object' || output === null || Array.isArray(packets) !== true) {
      return;
    }

    // Cursor has fallen behind our rotating window, so catch up
    if (typeof output.cursor !== 'number' || output.cursor < this.#buffer.startIndex) {
      output.cursor = this.#buffer.startIndex;
    }

    offset = output.cursor - this.#buffer.startIndex;

    while (offset < packets.length && processed < MAX_PACKETS_PER_OUTPUT_PER_TICK) {
      packet = packets[offset];

      if (typeof packet?.time !== 'number' || packet.time > dateNow) {
        offset++;
        continue;
      }

      if (packet.type === Streamer.PACKET_TYPE.VIDEO) {
        if (packet.codec === Streamer.CODEC_TYPE.H264) {
          // Do not send non-keyframe video until this output has seen its first keyframe
          if (output.seenKeyFrame !== true && packet.keyFrame !== true) {
            output.cursor = packet.index + 1;
            offset++;
            processed++;
            continue;
          }

          // Ensure new outputs get codec configuration before their first keyframe
          if (packet.keyFrame === true && output.sentCodecConfig !== true) {
            if (Buffer.isBuffer(this.#h264Video.lastSPS) === true && this.#h264Video.lastSPS.length > 0) {
              output?.video?.write?.(Streamer.H264NALUS.START_CODE);
              output?.video?.write?.(this.#h264Video.lastSPS);
            }

            if (Buffer.isBuffer(this.#h264Video.lastPPS) === true && this.#h264Video.lastPPS.length > 0) {
              output?.video?.write?.(Streamer.H264NALUS.START_CODE);
              output?.video?.write?.(this.#h264Video.lastPPS);
            }

            output.sentCodecConfig = true;
            output.seenKeyFrame = true;
          }

          if (packet.keyFrame === true) {
            output.seenKeyFrame = true;
          }
        }

        if (this.codecs?.video === Streamer.CODEC_TYPE.H264) {
          output?.video?.write?.(Streamer.H264NALUS.START_CODE);
        }
        output?.video?.write?.(packet.data);

        output.cursor = packet.index + 1;
        offset++;
        processed++;
        continue;
      }

      if (packet.type === Streamer.PACKET_TYPE.AUDIO && output?.includeAudio === true) {
        // Delay audio until first video keyframe for H264 outputs
        if (this.codecs?.video === Streamer.CODEC_TYPE.H264 && output.seenKeyFrame !== true) {
          output.cursor = packet.index + 1;
          offset++;
          processed++;
          continue;
        }

        // Only write one audio packet per output scheduler tick to avoid bursty audio into ffmpeg
        if (wroteAudio === true) {
          break;
        }

        output?.audio?.write?.(packet.data);
        wroteAudio = true;

        output.cursor = packet.index + 1;
        offset++;
        processed++;
        continue;
      }

      output.cursor = packet.index + 1;
      offset++;
      processed++;
    }
  }

  #processOutput(dateNow) {
    let cutoffTime = 0;
    let trimCount = 0;
    let fallbackFrame = undefined;

    // Keep our main rotating buffer under a certain size
    if (Array.isArray(this.#buffer?.packets) === true && this.#buffer.packets.length !== 0) {
      cutoffTime = dateNow - MAX_BUFFER_AGE;

      while (trimCount < this.#buffer.packets.length && this.#buffer.packets[trimCount].time < cutoffTime) {
        trimCount++;
      }

      if (trimCount !== 0) {
        this.#buffer.packets.splice(0, trimCount);
        this.#buffer.startIndex += trimCount;

        if (this.#buffer.packets.length === 0) {
          this.#buffer.startIndex = this.#packetIndex;
        }
      }
    }

    // Output fallback frame directly for offline, video disabled, or migrating
    // This is required as the streamer may be disconnected or has no incoming packets
    // We will pace this at ~30fps (every STREAM_FRAME_INTERVAL)
    if (dateNow - this.#lastFallbackFrameTime >= STREAM_FRAME_INTERVAL) {
      fallbackFrame = this.#getFallbackFrame();

      if (Buffer.isBuffer(fallbackFrame) === true) {
        if (this.#record !== undefined) {
          this.#writeFallback(this.#record, fallbackFrame);
        }

        for (let output of this.#live.values()) {
          this.#writeFallback(output, fallbackFrame);
        }

        this.#lastFallbackFrameTime = dateNow;
        return;
      }
    }

    // Normal buffered output using actual packet timestamps
    if (this.connected === true) {
      if (this.#record !== undefined) {
        this.#writeBufferedPackets(this.#record, dateNow);
      }

      for (let output of this.#live.values()) {
        this.#writeBufferedPackets(output, dateNow);
      }
    }
  }

  // Start the shared output processing loop
  // Runs every OUTPUT_LOOP_INTERVAL ms and processes all active streamers
  // Automatically stops when no streamers remain
  static #start() {
    if (this.#timer !== undefined) {
      return;
    }

    this.#timer = setInterval(() => {
      let dateNow = Date.now();

      for (let streamer of this.#streamers.values()) {
        try {
          streamer.#processOutput(dateNow);
          streamer.#outputErrors = 0;
        } catch (error) {
          streamer.#outputErrors++;

          streamer?.log?.error?.('Output processing error for device uuid "%s": %s', streamer?.nest_google_device_uuid, String(error));

          // If a streamer repeatedly fails, remove it from scheduler
          // to prevent one bad instance impacting all others
          if (streamer.#outputErrors >= 5) {
            streamer?.log?.warn?.('Stopping output processing for unstable device uuid "%s"', streamer?.nest_google_device_uuid);

            this.#streamers.delete(streamer.uuid);
            streamer.stopEverything();
          }
        }
      }

      // Stop scheduler if no active streamers remain
      if (this.#streamers.size === 0) {
        clearInterval(this.#timer);
        this.#timer = undefined;
      }
    }, OUTPUT_LOOP_INTERVAL);
  }

  // Register a streamer instance with the shared scheduler
  // Called when the instance has active streams (buffer/live/record)
  static #addStreamer(streamer) {
    if (streamer instanceof Streamer === false || typeof streamer?.uuid !== 'string' || streamer.uuid === '') {
      return;
    }

    this.#streamers.set(streamer.uuid, streamer);
    this.#start();
  }

  // Remove a streamer instance from the shared scheduler
  // Called when the instance no longer has any active streams
  static #removeStreamer(streamer) {
    if (streamer instanceof Streamer === false || typeof streamer?.uuid !== 'string' || streamer.uuid === '') {
      return;
    }

    this.#streamers.delete(streamer.uuid);

    // Stop scheduler if no streamers remain
    if (this.#streamers.size === 0 && this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  // Check if this streamer has active streams and add/remove from scheduler accordingly
  // Called whenever streams are started or stopped to ensure scheduler is always in sync with active streamers
  #syncSchedulerState() {
    if (this.hasActiveStreams() === true) {
      // Only add if not already registered
      if (Streamer.#streamers.has(this.uuid) === false) {
        Streamer.#addStreamer(this);
      }
      return;
    }

    // Only remove if currently registered
    if (Streamer.#streamers.has(this.uuid) === true) {
      Streamer.#removeStreamer(this);
    }
  }
}
