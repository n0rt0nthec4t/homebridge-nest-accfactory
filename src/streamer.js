// streamer
// Part of homebridge-nest-accfactory
//
// This is the base class for all Camera/Doorbell streaming
//
// Buffers a single audio/video stream which allows multiple HomeKit devices to connect to the single stream
// for live viewing and/or recording
//
// IMPORTANT:
// Extending classes are responsible for managing the upstream stream source (e.g. WebRTC, NexusTalk)
// and MUST notify the Streamer of source state changes using setSourceStatus(..) calls.
// This ensures correct buffer handling, connection lifecycle, and fallback frame behaviour.
//
// At a minimum, the extending class MUST signal:
// - SOURCE_CONNECTING   -> when initiating connection to upstream source
// - SOURCE_READY        -> when media packets are flowing and valid
// - SOURCE_CLOSED       -> when the source has stopped or disconnected
//
// Failure to signal correct source state may result in:
// - stale or frozen video on startup
// - incorrect buffer positioning
// - missing recordings or live stream failures
//
// The following functions should be defined in your class which extends this:
//
// streamer.connect(options)
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
// Code version 2026.03.31
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
    // Action type messages
    START_LIVE: 'start-live',
    STOP_LIVE: 'stop-live',
    START_RECORD: 'start-record',
    STOP_RECORD: 'stop-record',
    START_BUFFER: 'start-buffer',
    STOP_BUFFER: 'stop-buffer',

    // Status type messages
    SOURCE_CONNECTED: 'source-connected',
    SOURCE_CONNECTING: 'source-connecting',
    SOURCE_READY: 'source-ready',
    SOURCE_RECONNECTING: 'source-reconnecting',
    SOURCE_CLOSED: 'source-closed',
  };

  // Shared global scheduler for all active Streamer instances
  // This avoids having one timer per camera and reduces event loop overhead
  static #streamers = new Map(); // uuid => Streamer instance
  static #timer = undefined; // Shared timer for all active streamers

  supportDump = false; // Enable support for dumping stats on demand for this streamer instance
  log = undefined; // Logging function object
  uuid = undefined; // HomeKitDevice uuid for this streamer
  videoEnabled = undefined; // Video stream on camera enabled or not
  audioEnabled = undefined; // Audio from camera enabled or not
  online = undefined; // Camera online or not
  migrating = undefined; // Device is transferring/migrating between APIs
  nest_google_device_uuid = undefined; // Nest/Google UUID of the device connecting
  blankAudio = undefined; // Blank audio 'frame' for the type of audio being used, to be defined in subclass if audio is supported
  video = {
    width: undefined,
    height: undefined,
    fps: undefined,
    bitrate: undefined,
  };

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
  #sourceState = Streamer.MESSAGE_TYPE.SOURCE_CLOSED; // Track stream source state from messages for internal logic and logging
  #connectOptions = {}; // Store options from connect to use on reconnects
  #stats = {
    source: {
      connectingAt: undefined,
      connectedAt: undefined,
      readyAt: undefined,
      lastPacketAt: undefined,
      lastVideoPacketAt: undefined,
      lastAudioPacketAt: undefined,
      lastKeyframeAt: undefined,
      firstVideoPacketAt: undefined,
      firstAudioPacketAt: undefined,
      firstKeyframeAt: undefined,
      reconnects: 0,
    },
    packets: {
      video: 0,
      audio: 0,
      talk: 0,
      metadata: 0,
      keyframes: 0,
    },
    drops: {
      videoBeforeKeyframe: 0,
      audioBeforeKeyframe: 0,
      latePacketsIgnored: 0,
      bufferTrimmed: 0,
    },
    outputs: {
      liveWrites: 0,
      recordWrites: 0,
      fallbackWrites: 0,
    },
  };

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

  // Get current stream source state
  get sourceState() {
    return this.#sourceState;
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

    this.supportDump = options?.supportDump === true;
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
      // Respond to request to start buffering stream
      if (this.capabilities.buffering !== true) {
        this?.log?.debug?.('Buffering is unsupported for "%s"', this.nest_google_device_uuid);
        return;
      }

      await this.#startBuffering(message?.options);
    }

    if (type === Streamer.MESSAGE_TYPE.STOP_BUFFER) {
      // Respond to request to stop buffering stream
      if (this.capabilities.buffering !== true) {
        this?.log?.debug?.('Buffering is unsupported for "%s"', this.nest_google_device_uuid);
        return;
      }

      await this.#stopBuffering();
    }

    if (type === Streamer.MESSAGE_TYPE.START_LIVE) {
      // Request to start live stream for session id
      if (this.capabilities.live !== true) {
        this?.log?.debug?.('Live streaming is unsupported for "%s"', this.nest_google_device_uuid);
        return;
      }

      return await this.#startLiveStream(sessionID, message?.options);
    }

    if (type === Streamer.MESSAGE_TYPE.STOP_LIVE) {
      // Request to stop live stream for session id
      if (this.capabilities.live !== true) {
        this?.log?.debug?.('Live streaming is unsupported for "%s"', this.nest_google_device_uuid);
        return;
      }

      await this.#stopLiveStream(sessionID);
    }

    if (type === Streamer.MESSAGE_TYPE.START_RECORD) {
      // Request to start recording stream for session id
      if (this.capabilities.record !== true) {
        this?.log?.debug?.('Recording is unsupported for "%s"', this.nest_google_device_uuid);
        return;
      }

      return await this.#startRecording(sessionID, message?.options);
    }

    if (type === Streamer.MESSAGE_TYPE.STOP_RECORD) {
      // Request to stop recording stream for session id
      if (this.capabilities.record !== true) {
        this?.log?.debug?.('Recording is unsupported for "%s"', this.nest_google_device_uuid);
        return;
      }

      await this.#stopRecording(sessionID);
    }

    // Respond to stream source status messages to update internal state and log status
    if (
      type === Streamer.MESSAGE_TYPE.SOURCE_CONNECTING ||
      type === Streamer.MESSAGE_TYPE.SOURCE_CONNECTED ||
      type === Streamer.MESSAGE_TYPE.SOURCE_RECONNECTING ||
      type === Streamer.MESSAGE_TYPE.SOURCE_CLOSED ||
      type === Streamer.MESSAGE_TYPE.SOURCE_READY
    ) {
      this.#sourceState = type; // Update internal source state for use in logic and logging

      if (
        type === Streamer.MESSAGE_TYPE.SOURCE_CONNECTING ||
        type === Streamer.MESSAGE_TYPE.SOURCE_RECONNECTING ||
        type === Streamer.MESSAGE_TYPE.SOURCE_CLOSED
      ) {
        // Reset video statistics and H264 video state on source connecting, reconnecting or close
        this.#resetSourceState();
        this.#resetSourceStats();
      }

      // Track source timing stats
      if (typeof this.#stats === 'object' && this.#stats !== null) {
        let now = Date.now();
        if (type === Streamer.MESSAGE_TYPE.SOURCE_CONNECTING) {
          this.#stats.source.connectingAt = now;
        }
        if (type === Streamer.MESSAGE_TYPE.SOURCE_CONNECTED) {
          this.#stats.source.connectedAt = now;
        }
        if (type === Streamer.MESSAGE_TYPE.SOURCE_READY) {
          this.#stats.source.readyAt = now;
        }
        if (type === Streamer.MESSAGE_TYPE.SOURCE_RECONNECTING) {
          this.#stats.source.reconnects = (this.#stats.source.reconnects ?? 0) + 1;
        }
      }

      // Log source status changes with reason if provided in message
      this?.log?.debug?.(
        'Stream source is "%s" for uuid "%s"%s',
        type,
        this.nest_google_device_uuid,
        typeof message?.reason === 'string' && message.reason !== '' ? ' (' + message.reason + ')' : '',
      );
      return;
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
    let codec = undefined;
    let nalUnits = undefined;
    let containsFrame = false;
    let now = Date.now();

    if (
      typeof packet !== 'object' ||
      packet === null ||
      Buffer.isBuffer(packet?.data) !== true ||
      packet.data.length === 0 ||
      typeof packet?.type !== 'string' ||
      packet.type.trim() === '' ||
      Streamer.PACKET_TYPE?.[packet.type.trim().toUpperCase()] === undefined
    ) {
      return;
    }

    packet.type = packet.type.toLowerCase();

    if (this.hasActiveStreams() !== true) {
      return;
    }

    // Ensure shared buffer exists for buffering/live/record outputs
    this.#ensureSharedBuffer();

    if (this.#buffer === undefined) {
      return;
    }

    codec =
      typeof packet?.codec === 'string'
        ? packet.codec.toLowerCase()
        : packet.type === Streamer.PACKET_TYPE.VIDEO
          ? this.codecs?.video
          : packet.type === Streamer.PACKET_TYPE.AUDIO
            ? this.codecs?.audio
            : packet.type === Streamer.PACKET_TYPE.TALKBACK
              ? this.codecs?.talk
              : undefined;

    if (typeof codec !== 'string' || codec.trim() === '') {
      return;
    }

    // Preserve original source timestamp exactly as supplied by upstream module
    // This lets us later compare source timing vs buffered monotonic timing when debugging output drift
    let sourceTimestamp =
      typeof packet?.timestamp === 'number' && Number.isFinite(packet.timestamp) === true ? Math.round(packet.timestamp) : now;

    // Start buffered packet time from source timestamp, then normalise below if needed
    let packetTime = sourceTimestamp;

    // Preserve packet sequence if upstream provided one, otherwise assign local sequence
    if (typeof this.#sequenceCounters?.[packet.type] !== 'number') {
      this.#sequenceCounters[packet.type] = 0;
    }

    let sequence = typeof packet?.sequence === 'number' ? packet.sequence : this.#sequenceCounters[packet.type]++;

    let data = packet.data;

    // Ensure packet timestamps stored in shared buffer are monotonic per packet type
    // This does not overwrite sourceTimestamp, which remains the original timing from upstream
    if (typeof this.#lastPacketTime?.[packet.type] !== 'number') {
      this.#lastPacketTime[packet.type] = 0;
    }

    if (packetTime <= this.#lastPacketTime[packet.type]) {
      packetTime = this.#lastPacketTime[packet.type] + 1;
    }

    this.#lastPacketTime[packet.type] = packetTime;

    // H264-specific NALU validation and metadata tracking
    if (packet.type === Streamer.PACKET_TYPE.VIDEO && codec === Streamer.CODEC_TYPE.H264) {
      nalUnits = this.#getH264NALUnits(data);
      if (Array.isArray(nalUnits) !== true || nalUnits.length === 0) {
        return;
      }

      // Track SPS/PPS/IDR from this packet and determine if this packet contains an actual frame
      nalUnits.forEach((nalu) => {
        if (nalu.type === Streamer.H264NALUS.TYPES.SPS) {
          this.#h264Video.lastSPS = Buffer.from(nalu.data);

          let resolution = this.#decodeH264SPS(nalu.data);
          if (typeof resolution === 'object' && resolution !== null) {
            if (Number.isInteger(resolution.width) === true && resolution.width > 0) {
              this.video.width = resolution.width;
            }

            if (Number.isInteger(resolution.height) === true && resolution.height > 0) {
              this.video.height = resolution.height;
            }
          }
        }

        if (nalu.type === Streamer.H264NALUS.TYPES.PPS) {
          this.#h264Video.lastPPS = Buffer.from(nalu.data);
        }

        if (nalu.type === Streamer.H264NALUS.TYPES.IDR) {
          this.#h264Video.lastIDR = Buffer.from(nalu.data);
          containsFrame = true;
        }

        if (nalu.type === Streamer.H264NALUS.TYPES.SLICE_NON_IDR) {
          containsFrame = true;
        }
      });

      // Treat packet as key frame when an IDR is present, even if upstream did not explicitly flag it
      if (packet?.keyFrame !== true) {
        packet.keyFrame = nalUnits.some((nalu) => nalu.type === Streamer.H264NALUS.TYPES.IDR);
      }

      // Store H264 packets in Annex-B form for downstream ffmpeg consumers
      // Single NAL packets are stored as raw payload only, since Streamer writes start codes on output
      if (nalUnits.length === 1) {
        data = Buffer.from(nalUnits[0].data);
      }

      // Multi-NAL packets are reassembled with explicit start codes between each NAL
      // This preserves whole access-unit structure coming from WebRTC/NexusTalk
      if (nalUnits.length > 1) {
        data = Buffer.concat(
          nalUnits.flatMap((nalu) => {
            return [Streamer.H264NALUS.START_CODE, nalu.data];
          }),
        );
      }

      // Track FPS using actual video frame NAL units (IDR and non-IDR slices)
      // Use buffered monotonic packet time so repeated/regressing upstream timestamps do not break FPS estimation
      if (containsFrame === true) {
        if (typeof this.#h264Video.lastFrameTime === 'number' && packetTime > this.#h264Video.lastFrameTime) {
          let frameDelta = packetTime - this.#h264Video.lastFrameTime;
          let fps = 1000 / frameDelta;
          let previousFPS = this.video.fps;

          // Smooth or assign FPS
          if (typeof this.video.fps === 'number') {
            this.video.fps = this.video.fps * 0.8 + fps * 0.2;
          } else {
            this.video.fps = fps;
          }

          // First-time announce (when fps becomes available AND we have dimensions)
          if (
            typeof previousFPS !== 'number' &&
            typeof this.video.width === 'number' &&
            typeof this.video.height === 'number' &&
            typeof this.video.fps === 'number'
          ) {
            this?.log?.debug?.(
              'Receiving incoming stream from device "%s": %sx%s @ %sfps',
              this.nest_google_device_uuid,
              this.video.width,
              this.video.height,
              Math.round(this.video.fps),
            );
          }

          // FPS change detection (only if we already had a value)
          if (typeof previousFPS === 'number' && typeof this.video.fps === 'number') {
            let currentFPS = Math.round(this.video.fps);
            let prevFPS = Math.round(previousFPS);
            let delta = Math.abs(currentFPS - prevFPS);

            // Only log if:
            // - meaningful FPS shift (>= 2 fps)
            // - AND at least 3 seconds since last log
            if (delta >= 2 && (typeof this.#h264Video.lastFPSLogTime !== 'number' || now - this.#h264Video.lastFPSLogTime >= 3000)) {
              this.#h264Video.lastFPSLogTime = now;

              this?.log?.debug?.('FPS from device "%s" has changed to %sfps', this.nest_google_device_uuid, Math.round(this.video.fps));
            }
          }
        }

        this.#h264Video.lastFrameTime = packetTime;
      }

      // Track most recent keyframe index in rolling buffer
      if (packet.keyFrame === true) {
        this.#h264Video.lastIDRIndex = this.#packetIndex;
      }
    }

    // Track first packets / first keyframe arrival for support/debugging
    if (typeof this.#stats?.source === 'object' && this.#stats.source !== null) {
      if (packet?.keyFrame === true && typeof this.#stats.source.firstKeyframeAt !== 'number') {
        this.#stats.source.firstKeyframeAt = now;
      }

      this.#stats.source.lastPacketAt = now;

      if (packet.type === Streamer.PACKET_TYPE.VIDEO) {
        this.#stats.source.lastVideoPacketAt = now;

        if (typeof this.#stats.source.firstVideoPacketAt !== 'number') {
          this.#stats.source.firstVideoPacketAt = now;
        }
      }

      if (packet.type === Streamer.PACKET_TYPE.AUDIO) {
        this.#stats.source.lastAudioPacketAt = now;

        if (typeof this.#stats.source.firstAudioPacketAt !== 'number') {
          this.#stats.source.firstAudioPacketAt = now;
        }
      }

      if (packet?.keyFrame === true) {
        this.#stats.source.lastKeyframeAt = now;
      }
    }

    // Track packet counters for support/debugging
    if (typeof this.#stats?.packets === 'object' && this.#stats.packets !== null) {
      if (packet.type === Streamer.PACKET_TYPE.VIDEO) {
        this.#stats.packets.video++;
      }

      if (packet.type === Streamer.PACKET_TYPE.AUDIO) {
        this.#stats.packets.audio++;
      }

      if (packet.type === Streamer.PACKET_TYPE.TALKBACK) {
        this.#stats.packets.talk++;
      }

      if (packet.type === Streamer.PACKET_TYPE.METADATA) {
        this.#stats.packets.metadata++;
      }

      if (packet.keyFrame === true) {
        this.#stats.packets.keyframes++;
      }
    }

    this.#buffer.packets.push({
      index: this.#packetIndex++,
      type: packet.type,
      codec: codec,
      time: packetTime, // Buffered monotonic timestamp used by Streamer scheduling
      sourceTimestamp: sourceTimestamp, // Original upstream timestamp preserved for timing diagnostics
      sequence: sequence,
      keyFrame: packet?.keyFrame === true,
      data: data,
    });
  }

  #startBuffering(options = {}) {
    this.#ensureSharedBuffer();

    if (this.#buffer.enabled === true) {
      return;
    }

    this.#buffer.enabled = true;
    this.log?.debug?.('Started buffering from device uuid "%s"', this.nest_google_device_uuid);
    this.#syncSchedulerState();

    this.#doConnect(options);
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

  #startLiveStream(sessionID, options = {}) {
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
    let audioOut = options?.includeAudio === true ? new PassThrough() : null; // Conditionally create audio stream
    let talkbackIn = options?.includeAudio === true ? new PassThrough({ highWaterMark: 1024 * 16 }) : null; // Conditionally create talkback stream

    // eslint-disable-next-line no-unused-vars
    videoOut?.on?.('error', (error) => {});
    // eslint-disable-next-line no-unused-vars
    audioOut?.on?.('error', (error) => {});
    // eslint-disable-next-line no-unused-vars
    talkbackIn?.on?.('error', (error) => {});

    this.#ensureSharedBuffer();

    // Get starting cursor for live stream
    // If there are already live viewers, align this viewer to the same shared timeline.
    // Otherwise, start as close to "now" as possible and wait for the next keyframe.
    let startCursor = this.#packetIndex;

    if (this.#buffer !== undefined) {
      let bufferStart = this.#buffer.startIndex;

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
      } else {
        startCursor = this.#packetIndex;
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
      let output = this.#live.get(sessionID);

      clearTimeout(output?.talkbackTimeout);

      if (typeof this?.sendTalkback === 'function') {
        // Signal end of talkback stream with empty buffer
        this.sendTalkback(Buffer.alloc(0));
      }
    });

    // Ensure upstream connection is active
    this.#doConnect(options);

    this.#live.set(sessionID, {
      sessionID: sessionID,
      video: videoOut,
      audio: audioOut,
      talkback: talkbackIn,
      talkbackTimeout: undefined,
      includeAudio: options?.includeAudio === true,
      cursor: startCursor,
      sentCodecConfig: false,
      seenKeyFrame: false,
      lastVideoWriteTime: 0,
      sourceBaseTime: undefined,
      wallclockBaseTime: undefined,
    });

    this?.log?.debug?.('Started live stream from device uuid "%s" and session id "%s"', this.nest_google_device_uuid, sessionID);
    this.#syncSchedulerState();

    return { video: videoOut, audio: audioOut, talkback: talkbackIn };
  }

  #stopLiveStream(sessionID) {
    let output = this.#live.get(sessionID);

    if (output !== undefined) {
      if (this.supportDump === true && output !== undefined && this.#live.size === 1) {
        // Output stats on demand when the final live stream stops for support diagnostics
        this.#outputStats(Date.now());
      }

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

  #startRecording(sessionID, options = {}) {
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
    let audioOut = options?.includeAudio === true ? new PassThrough() : null; // Conditionally create audio stream

    // eslint-disable-next-line no-unused-vars
    videoOut?.on?.('error', (error) => {});
    // eslint-disable-next-line no-unused-vars
    audioOut?.on?.('error', (error) => {});

    this.#ensureSharedBuffer();

    // Ensure upstream connection is active
    this.#doConnect(options);

    // Determine where recording should start from within the shared buffer.
    // If recordTime is supplied, try to start from the first buffered packet at or after that time.
    // For H264 video, snap forward to the next keyframe so the recording starts on a decodable frame.
    let startCursor = this.#buffer?.startIndex ?? this.#packetIndex;

    if (
      this.#buffer !== undefined &&
      Array.isArray(this.#buffer.packets) === true &&
      this.#buffer.packets.length !== 0 &&
      typeof options?.recordTime === 'number' &&
      Number.isFinite(options.recordTime) === true
    ) {
      let packets = this.#buffer.packets;
      let bufferStart = this.#buffer.startIndex;
      let packetOffset = -1;
      let keyFrameOffset = -1;
      let index = 0;

      // Find the first packet at or after the requested record time
      while (index < packets.length) {
        if (typeof packets[index]?.time === 'number' && packets[index].time >= options.recordTime) {
          packetOffset = index;
          break;
        }
        index++;
      }

      // If we found a matching packet time, use it as a starting point
      if (packetOffset !== -1) {
        startCursor = packets[packetOffset].index;

        // For H264 recordings, move forward to the next keyframe so ffmpeg starts on a decodable frame
        if (this.codecs?.video === Streamer.CODEC_TYPE.H264) {
          keyFrameOffset = packetOffset;
          while (keyFrameOffset < packets.length) {
            if (
              packets[keyFrameOffset]?.type === Streamer.PACKET_TYPE.VIDEO &&
              packets[keyFrameOffset]?.codec === Streamer.CODEC_TYPE.H264 &&
              packets[keyFrameOffset]?.keyFrame === true
            ) {
              startCursor = packets[keyFrameOffset].index;
              break;
            }
            keyFrameOffset++;
          }

          // If no later keyframe was found, fall back to the latest known buffered IDR if still retained
          if (
            keyFrameOffset >= packets.length &&
            typeof this.#h264Video?.lastIDRIndex === 'number' &&
            this.#h264Video.lastIDRIndex >= bufferStart
          ) {
            startCursor = this.#h264Video.lastIDRIndex;
          }
        }
      }
    }

    // Register recording session
    this.#record = {
      sessionID: sessionID,
      video: videoOut,
      audio: audioOut,
      includeAudio: options?.includeAudio === true,
      cursor: startCursor,
      sentCodecConfig: false,
      seenKeyFrame: false,
      lastVideoWriteTime: 0,
      sourceBaseTime: undefined,
      wallclockBaseTime: undefined,
    };

    this?.log?.debug?.(
      'Started recording stream from device uuid "%s" with session id of "%s"%s',
      this.nest_google_device_uuid,
      sessionID,
      typeof options?.recordTime === 'number' ? ' using record time ' + options.recordTime : '',
    );
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
    // Is buffering active?
    return this.#buffer?.enabled === true;
  }

  isStreaming() {
    // Any live or recording streams active?
    return this.#record !== undefined || this.#live.size !== 0;
  }

  isRecording() {
    // Is recording stream active?
    return this.#record !== undefined;
  }

  isLiveStreaming() {
    // Are any live streams active?
    return this.#live.size !== 0;
  }

  hasActiveStreams() {
    // Do we have any active streams or buffering?
    return this.#buffer?.enabled === true || this.#record !== undefined || this.#live.size !== 0;
  }

  setSourceState(type, reason) {
    // Set stream source state for internal logic and logging
    if (typeof type !== 'string' || type === '') {
      return;
    }

    HomeKitDevice.message(this.uuid, Streamer.MESSAGE, type, {
      reason: reason,
    });
  }

  async #doConnect(options = undefined) {
    if (this.online !== true || this.videoEnabled !== true) {
      // Don't attempt to connect if device is offline or streaming is not enabled
      return;
    }

    // Cache any connection options for use on reconnects (e.g. after a stream source disconnect or error)
    if (typeof options === 'object' && options !== null) {
      this.#connectOptions = {
        ...(typeof this.#connectOptions === 'object' && this.#connectOptions !== null ? this.#connectOptions : {}),
        ...options,
      };
    }

    if (this.#sourceState !== Streamer.MESSAGE_TYPE.SOURCE_CLOSED) {
      // Source is already connected or connecting, so no need to connect again
      return;
    }

    // Pass to the subclass to handle the actual connection logic and stream source management
    await this?.connect?.(this.#connectOptions);
  }

  async #doClose() {
    // Reset video details on close/disconnect
    this.#resetSourceState();
    this.#resetSourceStats();

    // Pass to the subclass to handle the actual stream source disconnection logic
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

  #ensureSharedBuffer() {
    if (this.#buffer === undefined) {
      this.#buffer = {
        enabled: false,
        packets: [],
        startIndex: this.#packetIndex,
      };
    }
  }

  #resetSourceState() {
    this.video = {
      width: undefined,
      height: undefined,
      fps: undefined,
      bitrate: undefined,
    };

    this.#h264Video = {};
  }

  #resetSourceStats() {
    if (typeof this.#stats !== 'object' || this.#stats === null) {
      return;
    }

    // Track reconnects across source disconnects, so preserve existing count if present
    let reconnects = this.#stats?.source?.reconnects ?? 0;

    // Reset all other source stats
    this.#stats.source = {
      connectingAt: undefined,
      connectedAt: undefined,
      readyAt: undefined,
      lastPacketAt: undefined,
      lastVideoPacketAt: undefined,
      lastAudioPacketAt: undefined,
      lastKeyframeAt: undefined,
      firstVideoPacketAt: undefined,
      firstAudioPacketAt: undefined,
      firstKeyframeAt: undefined,
      reconnects: reconnects,
    };
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

  #decodeH264SPS(sps) {
    // --- H.264 SPS (Sequence Parameter Set) Parsing ---
    // This function extracts the video width and height from a raw SPS NAL unit buffer.
    // It implements a minimal H.264 bitstream parser for the fields needed for resolution.

    let data = undefined;
    let bitOffset = 0;
    let profileIdc = 0;
    let chromaFormatIdc = 1;
    let picWidthInMbsMinus1 = 0;
    let picHeightInMapUnitsMinus1 = 0;
    let frameMbsOnlyFlag = 1;
    let frameCropLeftOffset = 0;
    let frameCropRightOffset = 0;
    let frameCropTopOffset = 0;
    let frameCropBottomOffset = 0;
    let cropUnitX = 1;
    let cropUnitY = 2;

    // Validate input: must be a buffer, at least 4 bytes, and an SPS NAL unit (type 7)
    if (Buffer.isBuffer(sps) !== true || sps.length < 4 || (sps[0] & 0x1f) !== Streamer.H264NALUS.TYPES.SPS) {
      return undefined;
    }

    // Read a single bit from the bitstream
    let readBit = () => {
      let value = 0;
      if (bitOffset >= data.length * 8) {
        return 0;
      }
      value = (data[Math.floor(bitOffset / 8)] >> (7 - (bitOffset % 8))) & 0x01;
      bitOffset++;
      return value;
    };

    // Read multiple bits as an unsigned integer
    let readBits = (count) => {
      let value = 0;
      let index = 0;
      while (index < count) {
        value = (value << 1) | readBit();
        index++;
      }
      return value >>> 0;
    };

    // Read an unsigned Exp-Golomb code (UE)
    let readUE = () => {
      let zeros = 0;
      let value = 0;
      while (bitOffset < data.length * 8 && readBit() === 0) {
        zeros++;
      }
      value = (1 << zeros) - 1;
      if (zeros > 0) {
        value += readBits(zeros);
      }
      return value >>> 0;
    };

    // Read a signed Exp-Golomb code (SE)
    let readSE = () => {
      let value = readUE();
      return (value & 0x01) === 0 ? -(value >>> 1) : (value + 1) >>> 1;
    };

    // These are inserted to prevent accidental start code emulation in the bitstream
    data = [];
    let offset = 0;
    while (offset < sps.length) {
      if (offset + 2 < sps.length && sps[offset] === 0x00 && sps[offset + 1] === 0x00 && sps[offset + 2] === 0x03) {
        data.push(0x00, 0x00);
        offset += 3;
        continue;
      }
      data.push(sps[offset]);
      offset++;
    }
    data = Buffer.from(data);

    // Parse SPS fields needed for resolution
    readBits(8); // Skip NAL header (forbidden_zero_bit, nal_ref_idc, nal_unit_type)
    profileIdc = readBits(8); // Read Profile IDC (e.g., Baseline, Main, High)
    readBits(8); // Constraint flags + reserved
    readBits(8); // Level IDC
    readUE(); // seq_parameter_set_id (UE)

    // Some profiles have extra fields
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc) === true) {
      chromaFormatIdc = readUE();
      if (chromaFormatIdc === 3) {
        readBit(); // separate_colour_plane_flag
      }
      readUE(); // bit_depth_luma_minus8
      readUE(); // bit_depth_chroma_minus8
      readBit(); // qpprime_y_zero_transform_bypass_flag
      // Scaling matrix present flag
      if (readBit() === 1) {
        let scalingListCount = chromaFormatIdc !== 3 ? 8 : 12;
        let index = 0;
        while (index < scalingListCount) {
          if (readBit() === 1) {
            // Skip scaling list data
            let size = index < 6 ? 16 : 64;
            let lastScale = 8;
            let nextScale = 8;
            let scan = 0;
            while (scan < size) {
              if (nextScale !== 0) {
                nextScale = (lastScale + readSE() + 256) % 256;
              }
              lastScale = nextScale === 0 ? lastScale : nextScale;
              scan++;
            }
          }
          index++;
        }
      }
    }

    readUE(); // log2_max_frame_num_minus4
    let picOrderCntType = readUE();
    if (picOrderCntType === 0) {
      readUE(); // log2_max_pic_order_cnt_lsb_minus4
    }
    if (picOrderCntType === 1) {
      let index = 0;
      let count = 0;
      readBit(); // delta_pic_order_always_zero_flag
      readSE(); // offset_for_non_ref_pic
      readSE(); // offset_for_top_to_bottom_field
      count = readUE(); // num_ref_frames_in_pic_order_cnt_cycle
      while (index < count) {
        readSE();
        index++;
      }
    }

    readUE(); // max_num_ref_frames
    readBit(); // gaps_in_frame_num_value_allowed_flag

    // Resolution fields
    picWidthInMbsMinus1 = readUE();
    picHeightInMapUnitsMinus1 = readUE();
    frameMbsOnlyFlag = readBit();
    if (frameMbsOnlyFlag === 0) {
      readBit(); // mb_adaptive_frame_field_flag
    }
    readBit(); // direct_8x8_inference_flag

    // Frame cropping
    if (readBit() === 1) {
      frameCropLeftOffset = readUE();
      frameCropRightOffset = readUE();
      frameCropTopOffset = readUE();
      frameCropBottomOffset = readUE();
    }

    // Calculate crop units based on chroma format and frame type
    if (chromaFormatIdc === 0) {
      cropUnitX = 1;
      cropUnitY = 2 - frameMbsOnlyFlag;
    }
    if (chromaFormatIdc === 1) {
      cropUnitX = 2;
      cropUnitY = 2 * (2 - frameMbsOnlyFlag);
    }
    if (chromaFormatIdc === 2) {
      cropUnitX = 2;
      cropUnitY = 1 * (2 - frameMbsOnlyFlag);
    }
    if (chromaFormatIdc === 3) {
      cropUnitX = 1;
      cropUnitY = 1 * (2 - frameMbsOnlyFlag);
    }

    // Final width and height calculation
    // Each macroblock is 16x16 pixels; apply cropping if present
    return {
      width: (picWidthInMbsMinus1 + 1) * 16 - (frameCropLeftOffset + frameCropRightOffset) * cropUnitX,
      height: (2 - frameMbsOnlyFlag) * (picHeightInMapUnitsMinus1 + 1) * 16 - (frameCropTopOffset + frameCropBottomOffset) * cropUnitY,
    };
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

  #writeFallback(output, fallbackFrame, streamType) {
    if (Buffer.isBuffer(fallbackFrame) !== true || typeof output !== 'object' || output === null) {
      return;
    }

    // Track fallback writes in stats for monitoring purposes, but only if we have a valid fallback frame to write
    if (typeof this.#stats?.outputs === 'object' && this.#stats.outputs !== null) {
      this.#stats.outputs.fallbackWrites++;

      if (streamType === Streamer.STREAM_TYPE.LIVE) {
        this.#stats.outputs.liveWrites++;
      }

      if (streamType === Streamer.STREAM_TYPE.RECORD) {
        this.#stats.outputs.recordWrites++;
      }
    }

    if (this.codecs?.video === Streamer.CODEC_TYPE.H264) {
      // H264 video streams require each frame to be prefixed with an Annex B start code (0x00000001)
      output?.video?.write?.(Streamer.H264NALUS.START_CODE);
    }
    output?.video?.write?.(fallbackFrame);

    if (output?.includeAudio === true && Buffer.isBuffer(this.blankAudio) === true) {
      output?.audio?.write?.(this.blankAudio);
    }
  }

  #writeBufferedPackets(output, dateNow, streamType) {
    let packets = this.#buffer?.packets;
    let startIndex = this.#buffer?.startIndex;
    let packetsLength = Array.isArray(packets) === true ? packets.length : 0;
    let processed = 0;
    let packet = undefined;
    let wroteAudio = false;
    let wroteVideo = false;
    let dueTime = 0;
    let offset = 0;
    let outputVideo = undefined;
    let outputAudio = undefined;
    let isH264Output = false;
    let isLive = false;
    let isRecord = false;
    let includeAudio = false;
    let drops = undefined;
    let outputs = undefined;
    let isVideo = false;
    let isAudio = false;
    let isH264Packet = false;
    let nextCursor = 0;
    let lastSPS = undefined;
    let lastPPS = undefined;

    if (typeof output !== 'object' || output === null || Array.isArray(packets) !== true) {
      return;
    }

    outputVideo = output?.video;
    outputAudio = output?.audio;
    isH264Output = this.codecs?.video === Streamer.CODEC_TYPE.H264;
    isLive = streamType === Streamer.STREAM_TYPE.LIVE;
    isRecord = streamType === Streamer.STREAM_TYPE.RECORD;
    includeAudio = output?.includeAudio === true;
    drops = this.#stats?.drops;
    outputs = this.#stats?.outputs;
    lastSPS = this.#h264Video.lastSPS;
    lastPPS = this.#h264Video.lastPPS;

    // Cursor has fallen behind our rotating window, so catch up
    if (typeof output.cursor !== 'number' || output.cursor < startIndex) {
      output.cursor = startIndex;
    }

    offset = output.cursor - startIndex;

    // For H264 outputs, do not let leading audio or non-keyframe video block startup.
    // H264 decoding requires a keyframe (IDR) to begin cleanly, so we skip forward
    // until we find the first available keyframe in the buffered packets.
    //
    // This scan is only performed during startup (before we've seen the first keyframe).
    if (isH264Output === true && output.seenKeyFrame !== true) {
      while (offset < packetsLength) {
        packet = packets[offset];

        // If packet timing is invalid or missing, stop scanning.
        // We cannot safely reason about ordering beyond this point.
        if (typeof packet?.time !== 'number') {
          break;
        }

        // Stop at the first H264 keyframe (IDR).
        // This is the earliest safe point to begin playback.
        if (packet.type === Streamer.PACKET_TYPE.VIDEO && packet.codec === Streamer.CODEC_TYPE.H264 && packet.keyFrame === true) {
          break;
        }

        // Skip non-keyframe packets (audio or delta frames) during startup.
        // These cannot be decoded correctly without a preceding keyframe.
        offset++;
        processed++;
      }

      // Update the output cursor to the selected starting position.
      // If a keyframe was found, this points to it.
      // If not, this safely skips all scanned packets without blocking startup.
      output.cursor = startIndex + offset;
    }

    // Write due packets for this output, but cap work done per scheduler tick
    while (offset < packetsLength && processed < MAX_PACKETS_PER_OUTPUT_PER_TICK) {
      packet = packets[offset];

      // Stop if packet timing is invalid
      if (typeof packet?.time !== 'number') {
        break;
      }

      // Establish the output timing base from the first packet processed for this output.
      // Packet time is on the source timeline, so we rebase it to local wallclock here.
      if (typeof output.sourceBaseTime !== 'number' || typeof output.wallclockBaseTime !== 'number') {
        output.sourceBaseTime = packet.time;
        output.wallclockBaseTime = dateNow;
      }

      dueTime = output.wallclockBaseTime + (packet.time - output.sourceBaseTime);

      // Small tolerance for scheduler jitter so packets that are only just ahead
      // do not unnecessarily stall output.
      if (dueTime > dateNow + 2) {
        break;
      }

      // Cache packet characteristics used repeatedly below
      isVideo = packet.type === Streamer.PACKET_TYPE.VIDEO;
      isAudio = packet.type === Streamer.PACKET_TYPE.AUDIO;
      isH264Packet = packet.codec === Streamer.CODEC_TYPE.H264;
      nextCursor = packet.index + 1;

      if (isVideo === true) {
        // For live streams, only allow one video frame write per scheduler tick.
        // This avoids bursty writes into ffmpeg/HomeKit while still preserving variable frame cadence.
        if (isLive === true && wroteVideo === true) {
          break;
        }

        if (isH264Packet === true) {
          // Still waiting for first keyframe on this output, so discard delta frames
          // until we reach a clean decoder start point.
          if (output.seenKeyFrame !== true && packet.keyFrame !== true) {
            if (drops !== null && typeof drops === 'object') {
              drops.videoBeforeKeyframe++;
            }

            output.cursor = nextCursor;
            offset++;
            processed++;
            continue;
          }

          // Ensure new outputs receive codec configuration immediately before their first keyframe.
          // This gives ffmpeg/HomeKit SPS/PPS context before the first IDR frame.
          if (packet.keyFrame === true && output.sentCodecConfig !== true) {
            if (Buffer.isBuffer(lastSPS) === true && lastSPS.length > 0) {
              outputVideo?.write?.(Streamer.H264NALUS.START_CODE);
              outputVideo?.write?.(lastSPS);
            }

            if (Buffer.isBuffer(lastPPS) === true && lastPPS.length > 0) {
              outputVideo?.write?.(Streamer.H264NALUS.START_CODE);
              outputVideo?.write?.(lastPPS);
            }

            output.sentCodecConfig = true;
            output.seenKeyFrame = true;
          }

          if (packet.keyFrame === true) {
            output.seenKeyFrame = true;
          }
        }

        // Reapply Annex-B start code when writing H264 packets downstream.
        if (isH264Output === true) {
          outputVideo?.write?.(Streamer.H264NALUS.START_CODE);
        }

        outputVideo?.write?.(packet.data);
        wroteVideo = true;

        if (outputs !== null && typeof outputs === 'object') {
          if (isLive === true) {
            outputs.liveWrites++;
          }

          if (isRecord === true) {
            outputs.recordWrites++;
          }
        }

        output.cursor = nextCursor;
        offset++;
        processed++;
        continue;
      }

      if (isAudio === true && includeAudio === true) {
        // Delay audio until first video keyframe for H264 outputs.
        // This avoids audio leading video during decoder startup.
        if (isH264Output === true && output.seenKeyFrame !== true) {
          if (drops !== null && typeof drops === 'object') {
            drops.audioBeforeKeyframe++;
          }

          output.cursor = nextCursor;
          offset++;
          processed++;
          continue;
        }

        // Only write one audio packet per scheduler tick to avoid bursty audio into ffmpeg
        if (wroteAudio === true) {
          break;
        }

        outputAudio?.write?.(packet.data);
        wroteAudio = true;

        output.cursor = nextCursor;
        offset++;
        processed++;
        continue;
      }

      // Skip unsupported packet types or packets not relevant to this output
      output.cursor = nextCursor;
      offset++;
      processed++;
    }
  }

  #processOutput(dateNow) {
    let buffer = this.#buffer;
    let packets = buffer?.packets;
    let packetsLength = Array.isArray(packets) === true ? packets.length : 0;
    let drops = this.#stats?.drops;
    let live = this.#live;
    let record = this.#record;
    let fallbackFrame = undefined;
    let cutoffTime = 0;
    let trimCount = 0;

    // Keep our main rotating buffer under a certain size
    if (packetsLength !== 0) {
      cutoffTime = dateNow - MAX_BUFFER_AGE;

      while (trimCount < packetsLength && packets[trimCount].time < cutoffTime) {
        trimCount++;
      }

      if (trimCount !== 0) {
        if (drops !== null && typeof drops === 'object') {
          drops.bufferTrimmed += trimCount;
        }

        packets.splice(0, trimCount);
        buffer.startIndex += trimCount;

        if (packets.length === 0) {
          buffer.startIndex = this.#packetIndex;
        }
      }
    }

    // Output fallback frame directly for offline, video disabled, or migrating
    // This is required as the streamer may be disconnected or has no incoming packets
    // We will pace this at ~30fps (every STREAM_FRAME_INTERVAL)
    if (dateNow - this.#lastFallbackFrameTime >= STREAM_FRAME_INTERVAL) {
      fallbackFrame = this.#getFallbackFrame();

      if (Buffer.isBuffer(fallbackFrame) === true) {
        if (record !== undefined) {
          this.#writeFallback(record, fallbackFrame, Streamer.STREAM_TYPE.RECORD);
        }

        for (let output of live.values()) {
          this.#writeFallback(output, fallbackFrame, Streamer.STREAM_TYPE.LIVE);
        }

        this.#lastFallbackFrameTime = dateNow;
        return;
      }
    }

    // Normal buffered output using actual packet timestamps
    if (this.#sourceState === Streamer.MESSAGE_TYPE.SOURCE_READY) {
      if (record !== undefined) {
        this.#writeBufferedPackets(record, dateNow, Streamer.STREAM_TYPE.RECORD);
      }

      for (let output of live.values()) {
        this.#writeBufferedPackets(output, dateNow, Streamer.STREAM_TYPE.LIVE);
      }
    }
  }

  #outputStats(dateNow) {
    let connectTime =
      typeof this.#stats?.source?.connectingAt === 'number' && typeof this.#stats?.source?.connectedAt === 'number'
        ? this.#stats.source.connectedAt - this.#stats.source.connectingAt + 'ms'
        : '-';

    let firstVideoPacketTime =
      typeof this.#stats?.source?.connectingAt === 'number' && typeof this.#stats?.source?.firstVideoPacketAt === 'number'
        ? this.#stats.source.firstVideoPacketAt - this.#stats.source.connectingAt + 'ms'
        : '-';

    let firstAudioPacketTime =
      typeof this.#stats?.source?.connectingAt === 'number' && typeof this.#stats?.source?.firstAudioPacketAt === 'number'
        ? this.#stats.source.firstAudioPacketAt - this.#stats.source.connectingAt + 'ms'
        : '-';

    let firstKeyframeTime =
      typeof this.#stats?.source?.connectingAt === 'number' && typeof this.#stats?.source?.firstKeyframeAt === 'number'
        ? this.#stats.source.firstKeyframeAt - this.#stats.source.connectingAt + 'ms'
        : '-';

    let readyTime =
      typeof this.#stats?.source?.connectingAt === 'number' && typeof this.#stats?.source?.readyAt === 'number'
        ? this.#stats.source.readyAt - this.#stats.source.connectingAt + 'ms'
        : '-';

    let duration =
      typeof this.#stats?.source?.connectedAt === 'number' ? Math.round((dateNow - this.#stats.source.connectedAt) / 1000) + 's' : '-';

    let resolution =
      typeof this.video?.width === 'number' && typeof this.video?.height === 'number'
        ? this.video.width + 'x' + this.video.height
        : 'waiting for video…';

    let fps = typeof this.video?.fps === 'number' ? Math.round(this.video.fps) : undefined;

    let lastPacketAgo =
      typeof this.#stats?.source?.lastPacketAt === 'number'
        ? dateNow - this.#stats.source.lastPacketAt < 1000
          ? '<1s'
          : Math.floor((dateNow - this.#stats.source.lastPacketAt) / 1000) + 's'
        : '-';

    let lastVideoAgo =
      typeof this.#stats?.source?.lastVideoPacketAt === 'number'
        ? dateNow - this.#stats.source.lastVideoPacketAt < 1000
          ? '<1s'
          : Math.floor((dateNow - this.#stats.source.lastVideoPacketAt) / 1000) + 's'
        : '-';

    let lastAudioAgo =
      typeof this.#stats?.source?.lastAudioPacketAt === 'number'
        ? dateNow - this.#stats.source.lastAudioPacketAt < 1000
          ? '<1s'
          : Math.floor((dateNow - this.#stats.source.lastAudioPacketAt) / 1000) + 's'
        : '-';

    let lastKeyframeAgo =
      typeof this.#stats?.source?.lastKeyframeAt === 'number'
        ? dateNow - this.#stats.source.lastKeyframeAt < 1000
          ? '<1s'
          : Math.floor((dateNow - this.#stats.source.lastKeyframeAt) / 1000) + 's'
        : '-';

    this?.log?.info?.(
      'Support dump for device uuid "%s" data will be logged below for troubleshooting purposes.',
      this.nest_google_device_uuid,
    );
    this?.log?.info?.('  {');
    this?.log?.info?.('    "startup": {');
    this?.log?.info?.('      "connect": "%s"', connectTime);
    this?.log?.info?.('      "video": "%s"', firstVideoPacketTime);
    this?.log?.info?.('      "audio": "%s"', firstAudioPacketTime);
    this?.log?.info?.('      "ready": "%s"', readyTime);
    this?.log?.info?.('      "keyframe": "%s"', firstKeyframeTime);
    this?.log?.info?.('    },');
    this?.log?.info?.('    "duration": "%s",', duration);
    this?.log?.info?.('    "video": {');
    this?.log?.info?.('      "resolution": "%s"', resolution);
    this?.log?.info?.('      "fps": %s', typeof fps === 'number' ? fps : 'null');
    this?.log?.info?.('    },');
    this?.log?.info?.('    "packets": {');
    this?.log?.info?.('      "video": %s', this.#stats?.packets?.video ?? 0);
    this?.log?.info?.('      "audio": %s', this.#stats?.packets?.audio ?? 0);
    this?.log?.info?.('      "keyframes": %s', this.#stats?.packets?.keyframes ?? 0);
    this?.log?.info?.('    },');
    this?.log?.info?.('    "drops": {');
    this?.log?.info?.('      "videoBeforeKeyframe": %s', this.#stats?.drops?.videoBeforeKeyframe ?? 0);
    this?.log?.info?.('      "audioBeforeKeyframe": %s', this.#stats?.drops?.audioBeforeKeyframe ?? 0);
    this?.log?.info?.('      "latePacketsIgnored": %s', this.#stats?.drops?.latePacketsIgnored ?? 0);
    this?.log?.info?.('    },');
    this?.log?.info?.('    "output": {');
    this?.log?.info?.('      "live": %s', this.#stats?.outputs?.liveWrites ?? 0);
    this?.log?.info?.('      "record": %s', this.#stats?.outputs?.recordWrites ?? 0);
    this?.log?.info?.('      "fallback": %s', this.#stats?.outputs?.fallbackWrites ?? 0);
    this?.log?.info?.('    },');
    this?.log?.info?.('    "last": {');
    this?.log?.info?.('      "packet": "%s"', lastPacketAgo);
    this?.log?.info?.('      "video": "%s"', lastVideoAgo);
    this?.log?.info?.('      "audio": "%s"', lastAudioAgo);
    this?.log?.info?.('      "keyframeAge": "%s"', lastKeyframeAgo);
    this?.log?.info?.('    },');
    this?.log?.info?.('    "reconnects": %s', this.#stats?.source?.reconnects ?? 0);
    this?.log?.info?.('  }');
    this?.log?.info?.('End of support dump for device uuid "%s" data.', this.nest_google_device_uuid);
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
      let streamers = this.#streamers;
      let removals = [];
      let streamerStartTime = 0;
      let streamerBudget = Math.max(2, Math.floor(OUTPUT_LOOP_INTERVAL / Math.max(streamers.size, 1)));

      for (let streamer of streamers.values()) {
        try {
          // Skip streamers with no active outputs.
          // This avoids spending scheduler time on instances that have nothing to write.
          if (streamer.#record === undefined && streamer.#live.size === 0) {
            streamer.#outputErrors = 0;
            continue;
          }

          streamerStartTime = Date.now();
          streamer.#processOutput(dateNow);
          streamer.#outputErrors = 0;

          // Simple per-streamer output budget.
          // If one streamer is taking too long in a shared tick, stop processing it further until the next scheduler run.
          if (Date.now() - streamerStartTime > streamerBudget) {
            streamer?.log?.debug?.(
              'Output processing budget exceeded for device uuid "%s" (%sms > %sms)',
              streamer?.nest_google_device_uuid,
              Date.now() - streamerStartTime,
              streamerBudget,
            );
          }
        } catch (error) {
          streamer.#outputErrors++;

          streamer?.log?.error?.('Output processing error for device uuid "%s": %s', streamer?.nest_google_device_uuid, String(error));

          // If a streamer repeatedly fails, remove it from scheduler
          // to prevent one bad instance impacting all others
          if (streamer.#outputErrors >= 5) {
            streamer?.log?.warn?.('Stopping output processing for unstable device uuid "%s"', streamer?.nest_google_device_uuid);
            removals.push(streamer);
          }
        }
      }

      for (let streamer of removals) {
        streamers.delete(streamer.uuid);
        streamer.stopEverything();
      }

      // Stop scheduler if no active streamers remain
      if (streamers.size === 0) {
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
