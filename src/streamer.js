// streamer
// Part of homebridge-nest-accfactory
//
// Base class for all Camera/Doorbell streaming.
//
// Maintains a shared rolling buffer of audio/video data and allows multiple
// HomeKit clients to consume the same upstream stream for live viewing and/or recording.
// Each output (live, record) maintains its own cursor into the shared buffer.
//
// IMPORTANT:
// Extending classes are responsible for managing the upstream stream source (e.g. WebRTC, NexusTalk)
// and MUST notify the Streamer of source state changes using setSourceState(..) calls.
// This ensures correct buffer handling, connection lifecycle, and fallback frame behaviour.
//
// At a minimum, the extending class MUST signal:
// - SOURCE_CONNECTING   -> when initiating connection to upstream source
// - SOURCE_READY        -> when media items are flowing and valid
// - SOURCE_CLOSED       -> when the source has stopped or disconnected
//
// Failure to signal correct source state may result in:
// - stale or frozen video on startup
// - incorrect buffer positioning
// - missing recordings or live stream failures
//
// Media Model:
// - Streamer expects complete media frames (not partial frames ie: NALUs)
// - Video should be provided as complete H264 NAL units or access units
// - Audio should be provided as complete frames (AAC or PCM)
// - Streamer handles pacing, buffering, and fan-out to outputs
//
// Buffering Model:
// - A shared rolling buffer stores recent media frames/items
// - Live and recording sessions read from the buffer using independent cursors
// - New live viewers align to existing viewers or start near the most recent keyframe
//
// H264 Handling:
// - Streamer manages Annex-B start codes for H264 output
// - Extending classes should provide clean NAL units without start codes where possible
//
// Synchronisation:
// - Audio output is suppressed until a video keyframe (IDR) is seen for a session
// - This ensures correct A/V alignment for HomeKit consumers
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
// Code version 2026.04.02
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
const MAX_BUFFERED_ITEMS_PER_OUTPUT_PER_TICK = 20; // Prevent one output starving others
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

  static MEDIA_TYPE = {
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
  #HomeKitDeviceUUID = undefined; // HomeKitDevice uuid for this streamer
  #buffer = undefined; // Shared rotating media buffer (frames/items) used by buffering, live and recording outputs
  #record = undefined; // Single recording output for this camera instance
  #live = new Map(); // Live outputs keyed by session id
  #cameraFrames = {}; // H264 resource frames for offline, video off, transferring
  #sequenceCounters = {}; // Sequence counters for item types
  #itemIndex = 0; // Monotonic item index for shared buffer cursor tracking
  #h264Video = {}; // H264 video state for SPS/PPS and IDR frames
  #lastFallbackFrameTime = 0; // Timer for pacing fallback frames
  #outputErrors = 0; // Consecutive output loop failures for this instance
  #lastMediaTime = {}; // Track last buffered media time per type for fallback ordering guards
  #sourceState = Streamer.MESSAGE_TYPE.SOURCE_CLOSED; // Track stream source state from messages for internal logic and logging
  #connectOptions = {}; // Store options from connect to use on reconnects
  #stats = {
    source: {
      connectingAt: undefined,
      connectedAt: undefined,
      readyAt: undefined,
      lastItemAt: undefined,
      lastVideoItemAt: undefined,
      lastAudioItemAt: undefined,
      lastKeyframeAt: undefined,
      firstVideoItemAt: undefined,
      firstAudioItemAt: undefined,
      firstKeyframeAt: undefined,
      reconnects: 0,
    },
    items: {
      video: 0,
      audio: 0,
      talk: 0,
      metadata: 0,
      keyframes: 0,
    },
    drops: {
      videoBeforeKeyframe: 0,
      audioBeforeKeyframe: 0,
      lateItemsIgnored: 0,
      bufferTrimmed: 0,
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

    this.#HomeKitDeviceUUID = uuid;

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
      this.#itemIndex = 0; // Reset shared item index tracking
      this.#h264Video = {}; // Reset cached SPS/PPS and keyframe flag
      this.#lastMediaTime = {};
      this.#syncSchedulerState();
      this.#doClose(); // Trigger subclass-defined stream close logic
    }
  }

  addMedia(media) {
    let codec = undefined;
    let nalUnits = undefined;
    let containsFrame = false;
    let now = Date.now();
    let data = media.data;

    if (
      typeof media !== 'object' ||
      media === null ||
      Buffer.isBuffer(media?.data) !== true ||
      media.data.length === 0 ||
      typeof media?.type !== 'string' ||
      media.type.trim() === '' ||
      Streamer.MEDIA_TYPE?.[media.type.trim().toUpperCase()] === undefined
    ) {
      return;
    }

    media.type = media.type.toLowerCase();

    if (this.hasActiveStreams() !== true) {
      return;
    }

    // Ensure shared buffer exists for buffering/live/record outputs
    this.#ensureSharedBuffer();

    if (this.#buffer === undefined) {
      return;
    }

    codec =
      typeof media?.codec === 'string'
        ? media.codec.toLowerCase()
        : media.type === Streamer.MEDIA_TYPE.VIDEO
          ? this.codecs?.video
          : media.type === Streamer.MEDIA_TYPE.AUDIO
            ? this.codecs?.audio
            : media.type === Streamer.MEDIA_TYPE.TALKBACK
              ? this.codecs?.talk
              : undefined;

    if (typeof codec !== 'string' || codec.trim() === '') {
      return;
    }

    // Preserve media sequence if upstream provided one, otherwise assign local sequence
    if (typeof this.#sequenceCounters?.[media.type] !== 'number') {
      this.#sequenceCounters[media.type] = 0;
    }

    let sequence = typeof media?.sequence === 'number' ? media.sequence : this.#sequenceCounters[media.type]++;

    // Preserve original source timestamp exactly as supplied by upstream module
    let sourceTimestamp =
      typeof media?.timestamp === 'number' && Number.isFinite(media.timestamp) === true ? Math.round(media.timestamp) : now;

    // Start buffered media time from source timestamp
    let mediaTime = sourceTimestamp;

    if (typeof this.#lastMediaTime?.[media.type] !== 'number') {
      this.#lastMediaTime[media.type] = 0;
    }

    // Only repair clearly invalid buffered timing here.
    // Upstream stream modules are now responsible for assigning sane media timestamps.
    if (typeof mediaTime !== 'number' || Number.isFinite(mediaTime) !== true) {
      mediaTime = now;
    }

    // Fallback monotonic guard only for obviously broken backwards jumps.
    // Do not rewrite equal/near-equal upstream timing by default.
    if (mediaTime < this.#lastMediaTime[media.type]) {
      mediaTime = this.#lastMediaTime[media.type];
    }

    this.#lastMediaTime[media.type] = mediaTime;

    // H264-specific NALU validation and metadata tracking
    if (media.type === Streamer.MEDIA_TYPE.VIDEO && codec === Streamer.CODEC_TYPE.H264) {
      nalUnits = this.#getH264NALUnits(data);
      if (Array.isArray(nalUnits) !== true || nalUnits.length === 0) {
        return;
      }

      // Track SPS/PPS/IDR from this media and determine if this media contains an actual frame
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

      // Treat media as key frame when an IDR is present, even if upstream did not explicitly flag it
      if (media?.keyFrame !== true) {
        media.keyFrame = nalUnits.some((nalu) => nalu.type === Streamer.H264NALUS.TYPES.IDR);
      }

      // Store H264 media in Annex-B form for downstream ffmpeg consumers
      // Single NAL items are stored as raw payload only, since Streamer writes start codes on output
      if (nalUnits.length === 1) {
        data = Buffer.from(nalUnits[0].data);
      }

      // Multi-NAL items are reassembled with explicit start codes between each NAL
      // This preserves whole access-unit structure coming from WebRTC/NexusTalk
      if (nalUnits.length > 1) {
        data = Buffer.concat(
          nalUnits.flatMap((nalu) => {
            return [Streamer.H264NALUS.START_CODE, nalu.data];
          }),
        );
      }

      // Track FPS using actual video frame NAL units (IDR and non-IDR slices)
      // Use source timestamps so FPS reflects actual upstream frame cadence
      if (containsFrame === true) {
        if (typeof this.#h264Video.lastSourceFrameTime === 'number' && sourceTimestamp > this.#h264Video.lastSourceFrameTime) {
          let frameDelta = sourceTimestamp - this.#h264Video.lastSourceFrameTime;
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

        this.#h264Video.lastSourceFrameTime = sourceTimestamp;
      }

      // Track most recent keyframe index in rolling buffer
      if (media.keyFrame === true) {
        this.#h264Video.lastIDRIndex = this.#itemIndex;
      }
    }

    // Track first items / first keyframe arrival for support/debugging
    if (typeof this.#stats?.source === 'object' && this.#stats.source !== null) {
      if (media?.keyFrame === true && typeof this.#stats.source.firstKeyframeAt !== 'number') {
        this.#stats.source.firstKeyframeAt = now;
      }

      this.#stats.source.lastItemAt = now;

      if (media.type === Streamer.MEDIA_TYPE.VIDEO) {
        this.#stats.source.lastVideoItemAt = now;

        if (typeof this.#stats.source.firstVideoItemAt !== 'number') {
          this.#stats.source.firstVideoItemAt = now;
        }
      }

      if (media.type === Streamer.MEDIA_TYPE.AUDIO) {
        this.#stats.source.lastAudioItemAt = now;

        if (typeof this.#stats.source.firstAudioItemAt !== 'number') {
          this.#stats.source.firstAudioItemAt = now;
        }
      }

      if (media?.keyFrame === true) {
        this.#stats.source.lastKeyframeAt = now;
      }
    }

    // Track item counters for support/debugging
    if (typeof this.#stats?.items === 'object' && this.#stats.items !== null) {
      if (media.type === Streamer.MEDIA_TYPE.VIDEO) {
        this.#stats.items.video++;
      }

      if (media.type === Streamer.MEDIA_TYPE.AUDIO) {
        this.#stats.items.audio++;
      }

      if (media.type === Streamer.MEDIA_TYPE.TALKBACK) {
        this.#stats.items.talk++;
      }

      if (media.type === Streamer.MEDIA_TYPE.METADATA) {
        this.#stats.items.metadata++;
      }

      if (media.keyFrame === true) {
        this.#stats.items.keyframes++;
      }
    }

    this.#buffer.items.push({
      index: this.#itemIndex++,
      type: media.type,
      codec: codec,
      time: mediaTime, // Buffered media timestamp used by Streamer scheduling
      sourceTimestamp: sourceTimestamp, // Original upstream timestamp preserved for timing diagnostics
      sequence: sequence,
      keyFrame: media?.keyFrame === true,
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
      this.#itemIndex = 0;
      this.#h264Video = {};
      this.#lastMediaTime = {};
      this.#syncSchedulerState();
      this.#doClose();
      return;
    }

    this.#syncSchedulerState();
  }

  #startLiveStream(sessionID, options = {}) {
    let existing = undefined;
    let includeAudio = options?.includeAudio === true;
    let videoOut = undefined;
    let audioOut = null;
    let talkbackIn = null;
    let startCursor = this.#itemIndex;
    let buffer = this.#buffer;
    let bufferStart = undefined;
    let minCursor = undefined;
    let output = undefined;

    if (typeof sessionID !== 'string' || sessionID === '') {
      return;
    }

    if (this.#live.has(sessionID) === true) {
      this?.log?.warn?.('Live stream already exists for uuid "%s" and session id "%s"', this.nest_google_device_uuid, sessionID);
      existing = this.#live.get(sessionID);

      return {
        video: existing.video,
        audio: existing.audio,
        talkback: existing.talkback,
      };
    }

    // Create stream outputs for ffmpeg to consume
    videoOut = new PassThrough();
    audioOut = includeAudio === true ? new PassThrough() : null;
    talkbackIn = includeAudio === true ? new PassThrough({ highWaterMark: 1024 * 16 }) : null;

    // eslint-disable-next-line no-unused-vars
    videoOut?.on?.('error', (error) => {});
    // eslint-disable-next-line no-unused-vars
    audioOut?.on?.('error', (error) => {});
    // eslint-disable-next-line no-unused-vars
    talkbackIn?.on?.('error', (error) => {});

    this.#ensureSharedBuffer();
    buffer = this.#buffer;
    bufferStart = buffer?.startIndex;

    // Get starting cursor for live stream.
    // If there are already live viewers, align this viewer to the same shared timeline.
    // Otherwise, start as close to "now" as possible and wait for the next keyframe.
    if (typeof bufferStart === 'number' && this.#live.size !== 0) {
      for (output of this.#live.values()) {
        if (typeof output?.cursor === 'number') {
          if (typeof minCursor !== 'number' || output.cursor < minCursor) {
            minCursor = output.cursor;
          }
        }
      }

      if (typeof minCursor === 'number') {
        startCursor = minCursor < bufferStart ? bufferStart : minCursor;
      }
    }

    // Setup talkback handler
    talkbackIn?.on?.('data', (data) => {
      output = this.#live.get(sessionID);

      // Received audio data to send onto camera/doorbell for output
      if (typeof this?.sendTalkback === 'function' && output !== undefined) {
        this.sendTalkback(data);

        clearTimeout(output.talkbackTimeout);
        output.talkbackTimeout = setTimeout(() => {
          this.sendTalkback(Buffer.alloc(0));
        }, TIMERS.TALKBACK_AUDIO.interval);
      }
    });

    talkbackIn?.on?.('close', () => {
      output = this.#live.get(sessionID);

      clearTimeout(output?.talkbackTimeout);

      if (typeof this?.sendTalkback === 'function') {
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
      includeAudio: includeAudio,
      cursor: startCursor,
      sentCodecConfig: false,
      seenKeyFrame: false,
      lastVideoWriteTime: 0,
      sourceBaseTime: undefined,
      wallclockBaseTime: undefined,
      stats: {
        startedAt: Date.now(),
        firstWriteAt: undefined,
        firstVideoWriteAt: undefined,
        firstAudioWriteAt: undefined,
        writes: {
          total: 0,
          video: 0,
          audio: 0,
        },
      },
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
        this.#outputStats(output, Date.now());
      }

      this?.log?.debug?.('Stopped live stream from device uuid "%s" and session id "%s"', this.nest_google_device_uuid, sessionID);

      this.#cleanupOutput(output);
      this.#live.delete(sessionID);
    }

    if (this.#live.size === 0 && this.#record === undefined && this.#buffer?.enabled !== true) {
      this.#buffer = undefined;
      this.#itemIndex = 0;
      this.#h264Video = {};
    }

    this.#syncSchedulerState();

    // If no more active streams, close the upstream connection
    if (this.isStreaming() === false && this.isBuffering() === false) {
      this.#doClose();
    }
  }

  #startRecording(sessionID, options = {}) {
    let buffer = undefined;
    let items = undefined;
    let itemsLength = 0;
    let bufferStart = undefined;
    let startCursor = this.#itemIndex;
    let videoOut = undefined;
    let audioOut = null;
    let includeAudio = options?.includeAudio === true;
    let isH264 = this.codecs?.video === Streamer.CODEC_TYPE.H264;
    let recordTime = options?.recordTime;
    let bestOffset = -1;
    let bestDelta = Number.POSITIVE_INFINITY;
    let index = 0;
    let delta = 0;

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
    videoOut = new PassThrough();
    audioOut = includeAudio === true ? new PassThrough() : null;

    // eslint-disable-next-line no-unused-vars
    videoOut?.on?.('error', (error) => {});
    // eslint-disable-next-line no-unused-vars
    audioOut?.on?.('error', (error) => {});

    this.#ensureSharedBuffer();

    // Ensure upstream connection is active
    this.#doConnect(options);

    buffer = this.#buffer;
    items = buffer?.items;
    itemsLength = Array.isArray(items) === true ? items.length : 0;
    bufferStart = buffer?.startIndex;

    if (typeof bufferStart === 'number') {
      startCursor = bufferStart;
    }

    // If recordTime is supplied, try to start as close as possible to that time.
    // For H264, choose the nearest buffered keyframe so recording starts on a decodable frame,
    // even if that keyframe is slightly before the requested time.
    if (itemsLength !== 0 && typeof recordTime === 'number' && Number.isFinite(recordTime) === true) {
      if (isH264 === true) {
        while (index < itemsLength) {
          if (
            items[index]?.type === Streamer.MEDIA_TYPE.VIDEO &&
            items[index]?.codec === Streamer.CODEC_TYPE.H264 &&
            items[index]?.keyFrame === true &&
            typeof items[index]?.time === 'number'
          ) {
            delta = Math.abs(items[index].time - recordTime);

            if (delta < bestDelta || (delta === bestDelta && items[index].time <= recordTime)) {
              bestDelta = delta;
              bestOffset = index;
            }
          }

          index++;
        }

        if (bestOffset !== -1) {
          startCursor = items[bestOffset].index;
        }

        if (
          bestOffset === -1 &&
          typeof this.#h264Video?.lastIDRIndex === 'number' &&
          typeof bufferStart === 'number' &&
          this.#h264Video.lastIDRIndex >= bufferStart
        ) {
          startCursor = this.#h264Video.lastIDRIndex;
        }
      }

      if (isH264 !== true) {
        while (index < itemsLength) {
          if (typeof items[index]?.time === 'number' && items[index].time >= recordTime) {
            startCursor = items[index].index;
            break;
          }

          index++;
        }
      }
    }

    // Register recording session
    this.#record = {
      sessionID: sessionID,
      video: videoOut,
      audio: audioOut,
      includeAudio: includeAudio,
      cursor: startCursor,
      sentCodecConfig: false,
      seenKeyFrame: false,
      lastVideoWriteTime: 0,
      sourceBaseTime: undefined,
      wallclockBaseTime: undefined,
      stats: {
        startedAt: Date.now(),
        firstWriteAt: undefined,
        firstVideoWriteAt: undefined,
        firstAudioWriteAt: undefined,
        writes: {
          total: 0,
          video: 0,
          audio: 0,
        },
      },
    };

    this?.log?.debug?.(
      'Started recording stream from device uuid "%s" with session id of "%s"%s',
      this.nest_google_device_uuid,
      sessionID,
      typeof recordTime === 'number' ? ' using record time ' + recordTime : '',
    );

    this.#syncSchedulerState();

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
      this.#itemIndex = 0;
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

    HomeKitDevice.message(this.#HomeKitDeviceUUID, Streamer.MESSAGE, type, {
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
        items: [],
        startIndex: this.#itemIndex,
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
      lastItemAt: undefined,
      lastVideoItemAt: undefined,
      lastAudioItemAt: undefined,
      lastKeyframeAt: undefined,
      firstVideoItemAt: undefined,
      firstAudioItemAt: undefined,
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
    // H.264 SPS (Sequence Parameter Set) Parsing
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

  #writeFallback(output, fallbackFrame) {
    if (Buffer.isBuffer(fallbackFrame) !== true || typeof output !== 'object' || output === null) {
      return;
    }

    let outputStats = output?.stats;
    let outputWrites = outputStats?.writes;
    let dateNow = Date.now();

    if (typeof outputStats !== 'object' || outputStats === null) {
      outputStats = undefined;
      outputWrites = undefined;
    }

    if (typeof outputWrites !== 'object' || outputWrites === null) {
      outputWrites = undefined;
    }

    // Track per-output/session video write stats
    if (outputStats !== undefined) {
      if (typeof outputStats.firstWriteAt !== 'number') {
        outputStats.firstWriteAt = dateNow;
      }

      if (typeof outputStats.firstVideoWriteAt !== 'number') {
        outputStats.firstVideoWriteAt = dateNow;
      }

      if (outputWrites !== undefined) {
        if (typeof outputWrites.total !== 'number') {
          outputWrites.total = 0;
        }

        if (typeof outputWrites.video !== 'number') {
          outputWrites.video = 0;
        }

        outputWrites.total++;
        outputWrites.video++;
      }
    }

    if (this.codecs?.video === Streamer.CODEC_TYPE.H264) {
      // H264 video streams require each frame to be prefixed with an Annex B start code (0x00000001)
      output?.video?.write?.(Streamer.H264NALUS.START_CODE);
    }

    output?.video?.write?.(fallbackFrame);

    if (output?.includeAudio === true && Buffer.isBuffer(this.blankAudio) === true) {
      if (outputStats !== undefined) {
        if (typeof outputStats.firstAudioWriteAt !== 'number') {
          outputStats.firstAudioWriteAt = dateNow;
        }

        if (outputWrites !== undefined) {
          if (typeof outputWrites.total !== 'number') {
            outputWrites.total = 0;
          }

          if (typeof outputWrites.audio !== 'number') {
            outputWrites.audio = 0;
          }

          outputWrites.total++;
          outputWrites.audio++;
        }
      }

      output?.audio?.write?.(this.blankAudio);
    }
  }

  #processBufferedOutput(output, dateNow, streamType, budgetMs) {
    let items = this.#buffer?.items;
    let startIndex = this.#buffer?.startIndex;
    let itemsLength = Array.isArray(items) === true ? items.length : 0;
    let processed = 0;
    let item = undefined;
    let wroteVideo = false;
    let dueTime = 0;
    let dueTolerance = 2;
    let isVideo = false;
    let isAudio = false;
    let isH264Media = false;
    let nextCursor = 0;
    let startedAt = Date.now();

    if (typeof output !== 'object' || output === null || Array.isArray(items) !== true) {
      return;
    }

    let outputVideo = output?.video;
    let outputAudio = output?.audio;
    let outputStats = output?.stats;
    let outputWrites = outputStats?.writes;
    let isH264Output = this.codecs?.video === Streamer.CODEC_TYPE.H264;
    let isLive = streamType === Streamer.STREAM_TYPE.LIVE;
    let includeAudio = output?.includeAudio === true;
    let drops = this.#stats?.drops;
    let lastSPS = this.#h264Video.lastSPS;
    let lastPPS = this.#h264Video.lastPPS;

    // Live H264 output is a little more sensitive to scheduler jitter and uneven upstream cadence.
    // Give it a slightly wider tolerance, but still keep writes paced to a single video frame per tick.
    if (isLive === true && isH264Output === true) {
      dueTolerance = 10;
    }

    if (typeof outputStats !== 'object' || outputStats === null) {
      outputStats = undefined;
      outputWrites = undefined;
    }

    if (typeof outputWrites !== 'object' || outputWrites === null) {
      outputWrites = undefined;
    }

    // Cursor has fallen behind our rotating window, so catch up
    if (typeof output.cursor !== 'number' || output.cursor < startIndex) {
      output.cursor = startIndex;
    }

    let offset = output.cursor - startIndex;

    // For H264 outputs, do not let leading audio or non-keyframe video block startup.
    // H264 decoding requires a keyframe (IDR) to begin cleanly, so we skip forward
    // until we find the first available keyframe in the buffered items.
    //
    // This scan is only performed during startup (before we've seen the first keyframe).
    if (isH264Output === true && output.seenKeyFrame !== true) {
      while (offset < itemsLength) {
        item = items[offset];

        // If item timing is invalid or missing, stop scanning.
        // We cannot safely reason about ordering beyond this point.
        if (typeof item?.time !== 'number') {
          break;
        }

        // Stop at the first H264 keyframe (IDR).
        // This is the earliest safe point to begin playback.
        if (item.type === Streamer.MEDIA_TYPE.VIDEO && item.codec === Streamer.CODEC_TYPE.H264 && item.keyFrame === true) {
          break;
        }

        // Skip non-keyframe items (audio or delta frames) during startup.
        // These cannot be decoded correctly without a preceding keyframe.
        offset++;
        processed++;
      }

      // Update the output cursor to the selected starting position.
      // If a keyframe was found, this points to it.
      // If not, this safely skips all scanned items without blocking startup.
      output.cursor = startIndex + offset;
    }

    // Write due items for this output, but cap work done per scheduler tick
    while (offset < itemsLength && processed < MAX_BUFFERED_ITEMS_PER_OUTPUT_PER_TICK) {
      if (typeof budgetMs === 'number' && budgetMs > 0 && Date.now() - startedAt >= budgetMs) {
        break;
      }

      item = items[offset];

      // Stop if item timing is invalid
      if (typeof item?.time !== 'number') {
        break;
      }

      // Establish the output timing base from the first item processed for this output.
      // Item time is on the source timeline, so we rebase it to local wallclock here.
      if (typeof output.sourceBaseTime !== 'number' || typeof output.wallclockBaseTime !== 'number') {
        output.sourceBaseTime = item.time;
        output.wallclockBaseTime = dateNow;
      }

      dueTime = output.wallclockBaseTime + (item.time - output.sourceBaseTime);

      // Small tolerance for scheduler jitter so items that are only just ahead
      // do not unnecessarily stall output.
      if (dueTime > dateNow + dueTolerance) {
        break;
      }

      // Cache item characteristics used repeatedly below
      isVideo = item.type === Streamer.MEDIA_TYPE.VIDEO;
      isAudio = item.type === Streamer.MEDIA_TYPE.AUDIO;
      isH264Media = item.codec === Streamer.CODEC_TYPE.H264;
      nextCursor = item.index + 1;

      if (isVideo === true) {
        // For live streams, only allow one video frame write per scheduler tick.
        // This avoids bursty writes into ffmpeg/HomeKit while still preserving variable frame cadence.
        if (isLive === true && wroteVideo === true) {
          break;
        }

        if (isH264Media === true) {
          // Still waiting for first keyframe on this output, so discard delta frames
          // until we reach a clean decoder start point.
          if (output.seenKeyFrame !== true && item.keyFrame !== true) {
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
          if (item.keyFrame === true && output.sentCodecConfig !== true) {
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

          if (item.keyFrame === true) {
            output.seenKeyFrame = true;
          }
        }

        // Reapply Annex-B start code when writing H264 media items downstream.
        if (isH264Output === true) {
          outputVideo?.write?.(Streamer.H264NALUS.START_CODE);
        }

        outputVideo?.write?.(item.data);
        wroteVideo = true;

        if (outputStats !== undefined) {
          if (typeof outputStats.firstWriteAt !== 'number') {
            outputStats.firstWriteAt = dateNow;
          }

          if (typeof outputStats.firstVideoWriteAt !== 'number') {
            outputStats.firstVideoWriteAt = dateNow;
          }

          if (outputWrites !== undefined) {
            if (typeof outputWrites.total !== 'number') {
              outputWrites.total = 0;
            }

            if (typeof outputWrites.video !== 'number') {
              outputWrites.video = 0;
            }

            outputWrites.total++;
            outputWrites.video++;
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

        outputAudio?.write?.(item.data);

        if (outputStats !== undefined) {
          if (typeof outputStats.firstWriteAt !== 'number') {
            outputStats.firstWriteAt = dateNow;
          }

          if (typeof outputStats.firstAudioWriteAt !== 'number') {
            outputStats.firstAudioWriteAt = dateNow;
          }
          if (outputWrites !== undefined) {
            if (typeof outputWrites.total !== 'number') {
              outputWrites.total = 0;
            }

            if (typeof outputWrites.audio !== 'number') {
              outputWrites.audio = 0;
            }

            outputWrites.total++;
            outputWrites.audio++;
          }
        }

        output.cursor = nextCursor;
        offset++;
        processed++;
        continue;
      }

      // Skip unsupported media types or items not relevant to this output
      output.cursor = nextCursor;
      offset++;
      processed++;
    }
  }

  #processOutput(dateNow, budgetMs) {
    let buffer = this.#buffer;
    let items = buffer?.items;
    let itemsLength = Array.isArray(items) === true ? items.length : 0;
    let drops = this.#stats?.drops;
    let live = this.#live;
    let record = this.#record;
    let cutoffTime = 0;
    let trimCount = 0;

    // Keep our main rotating buffer under a certain size
    if (itemsLength !== 0) {
      cutoffTime = dateNow - MAX_BUFFER_AGE;

      while (trimCount < itemsLength && items[trimCount].time < cutoffTime) {
        trimCount++;
      }

      if (trimCount !== 0) {
        if (drops !== null && typeof drops === 'object') {
          drops.bufferTrimmed += trimCount;
        }

        items.splice(0, trimCount);
        buffer.startIndex += trimCount;

        if (items.length === 0) {
          buffer.startIndex = this.#itemIndex;
        }
      }
    }

    // Output fallback frame directly for offline, video disabled, or migrating
    // This is required as the streamer may be disconnected or has no incoming media items
    // We will pace this at ~30fps (every STREAM_FRAME_INTERVAL)
    if (dateNow - this.#lastFallbackFrameTime >= STREAM_FRAME_INTERVAL) {
      let fallbackFrame =
        this.online === false && this.#cameraFrames?.offline
          ? this.#cameraFrames.offline
          : this.online === true && this.videoEnabled === false && this.#cameraFrames?.off
            ? this.#cameraFrames.off
            : this.migrating === true && this.#cameraFrames?.transfer
              ? this.#cameraFrames.transfer
              : undefined;

      if (Buffer.isBuffer(fallbackFrame) === true) {
        if (record !== undefined) {
          this.#writeFallback(record, fallbackFrame);
        }

        for (let output of live.values()) {
          this.#writeFallback(output, fallbackFrame);
        }

        this.#lastFallbackFrameTime = dateNow;
        return;
      }
    }

    // Normal buffered output using actual item timestamps
    if (this.#sourceState === Streamer.MESSAGE_TYPE.SOURCE_READY) {
      if (record !== undefined) {
        this.#processBufferedOutput(record, dateNow, Streamer.STREAM_TYPE.RECORD, budgetMs);
      }

      for (let output of live.values()) {
        this.#processBufferedOutput(output, dateNow, Streamer.STREAM_TYPE.LIVE, budgetMs);
      }
    }
  }

  #outputStats(output, dateNow) {
    let outputStats = output?.stats;
    let outputWrites = outputStats?.writes;

    if (typeof outputStats !== 'object' || outputStats === null) {
      outputStats = undefined;
      outputWrites = undefined;
    }

    if (typeof outputWrites !== 'object' || outputWrites === null) {
      outputWrites = undefined;
    }

    let connectTime =
      typeof this.#stats?.source?.connectingAt === 'number' && typeof this.#stats?.source?.connectedAt === 'number'
        ? this.#stats.source.connectedAt - this.#stats.source.connectingAt + 'ms'
        : '-';

    let firstVideoItemTime =
      typeof this.#stats?.source?.connectingAt === 'number' && typeof this.#stats?.source?.firstVideoItemAt === 'number'
        ? this.#stats.source.firstVideoItemAt - this.#stats.source.connectingAt + 'ms'
        : '-';

    let firstAudioItemTime =
      typeof this.#stats?.source?.connectingAt === 'number' && typeof this.#stats?.source?.firstAudioItemAt === 'number'
        ? this.#stats.source.firstAudioItemAt - this.#stats.source.connectingAt + 'ms'
        : '-';

    let firstKeyframeTime =
      typeof this.#stats?.source?.connectingAt === 'number' && typeof this.#stats?.source?.firstKeyframeAt === 'number'
        ? this.#stats.source.firstKeyframeAt - this.#stats.source.connectingAt + 'ms'
        : '-';

    let readyTime =
      typeof this.#stats?.source?.connectingAt === 'number' && typeof this.#stats?.source?.readyAt === 'number'
        ? this.#stats.source.readyAt - this.#stats.source.connectingAt + 'ms'
        : '-';

    let sourceDuration =
      typeof this.#stats?.source?.connectedAt === 'number' ? Math.round((dateNow - this.#stats.source.connectedAt) / 1000) + 's' : '-';

    let outputDuration = typeof output?.stats?.startedAt === 'number' ? Math.round((dateNow - output.stats.startedAt) / 1000) + 's' : '-';

    let resolution =
      typeof this.video?.width === 'number' && typeof this.video?.height === 'number'
        ? this.video.width + 'x' + this.video.height
        : 'waiting for video…';

    let fps = typeof this.video?.fps === 'number' ? Math.round(this.video.fps) : undefined;

    let lastItemAgo =
      typeof this.#stats?.source?.lastItemAt === 'number'
        ? dateNow - this.#stats.source.lastItemAt < 1000
          ? '<1s'
          : Math.floor((dateNow - this.#stats.source.lastItemAt) / 1000) + 's'
        : '-';

    let lastVideoAgo =
      typeof this.#stats?.source?.lastVideoItemAt === 'number'
        ? dateNow - this.#stats.source.lastVideoItemAt < 1000
          ? '<1s'
          : Math.floor((dateNow - this.#stats.source.lastVideoItemAt) / 1000) + 's'
        : '-';

    let lastAudioAgo =
      typeof this.#stats?.source?.lastAudioItemAt === 'number'
        ? dateNow - this.#stats.source.lastAudioItemAt < 1000
          ? '<1s'
          : Math.floor((dateNow - this.#stats.source.lastAudioItemAt) / 1000) + 's'
        : '-';

    let lastKeyframeAgo =
      typeof this.#stats?.source?.lastKeyframeAt === 'number'
        ? dateNow - this.#stats.source.lastKeyframeAt < 1000
          ? '<1s'
          : Math.floor((dateNow - this.#stats.source.lastKeyframeAt) / 1000) + 's'
        : '-';

    let firstOutputWriteTime =
      typeof output?.stats?.startedAt === 'number' && typeof output?.stats?.firstWriteAt === 'number'
        ? output.stats.firstWriteAt - output.stats.startedAt + 'ms'
        : '-';

    let firstOutputVideoWriteTime =
      typeof output?.stats?.startedAt === 'number' && typeof output?.stats?.firstVideoWriteAt === 'number'
        ? output.stats.firstVideoWriteAt - output.stats.startedAt + 'ms'
        : '-';

    let firstOutputAudioWriteTime =
      typeof output?.stats?.startedAt === 'number' && typeof output?.stats?.firstAudioWriteAt === 'number'
        ? output.stats.firstAudioWriteAt - output.stats.startedAt + 'ms'
        : '-';

    this?.log?.info?.(
      'Support dump for device uuid "%s" data will be logged below for troubleshooting purposes.',
      this.nest_google_device_uuid,
    );
    this?.log?.info?.('  {');
    this?.log?.info?.('    "startup": {');
    this?.log?.info?.('      "connect": "%s"', connectTime);
    this?.log?.info?.('      "video": "%s"', firstVideoItemTime);
    this?.log?.info?.('      "audio": "%s"', firstAudioItemTime);
    this?.log?.info?.('      "ready": "%s"', readyTime);
    this?.log?.info?.('      "keyframe": "%s"', firstKeyframeTime);
    this?.log?.info?.('    },');
    this?.log?.info?.('    "duration": {');
    this?.log?.info?.('      "source": "%s"', sourceDuration);
    this?.log?.info?.('      "output": "%s"', outputDuration);
    this?.log?.info?.('    },');
    this?.log?.info?.('    "video": {');
    this?.log?.info?.('      "resolution": "%s"', resolution);
    this?.log?.info?.('      "fps": %s', typeof fps === 'number' ? fps : 'null');
    this?.log?.info?.('    },');
    this?.log?.info?.('    "items": {');
    this?.log?.info?.('      "video": %s', this.#stats?.items?.video ?? 0);
    this?.log?.info?.('      "audio": %s', this.#stats?.items?.audio ?? 0);
    this?.log?.info?.('      "keyframes": %s', this.#stats?.items?.keyframes ?? 0);
    this?.log?.info?.('    },');
    this?.log?.info?.('    "drops": {');
    this?.log?.info?.('      "videoBeforeKeyframe": %s', this.#stats?.drops?.videoBeforeKeyframe ?? 0);
    this?.log?.info?.('      "audioBeforeKeyframe": %s', this.#stats?.drops?.audioBeforeKeyframe ?? 0);
    this?.log?.info?.('      "lateItemsIgnored": %s', this.#stats?.drops?.lateItemsIgnored ?? 0);
    this?.log?.info?.('    },');
    this?.log?.info?.('    "output": {');
    this?.log?.info?.('      "startup": {');
    this?.log?.info?.('        "firstWrite": "%s"', firstOutputWriteTime);
    this?.log?.info?.('        "firstVideoWrite": "%s"', firstOutputVideoWriteTime);
    this?.log?.info?.('        "firstAudioWrite": "%s"', firstOutputAudioWriteTime);
    this?.log?.info?.('      },');
    this?.log?.info?.('      "writes": {');
    this?.log?.info?.('        "total": %s', outputWrites?.total ?? 0);
    this?.log?.info?.('        "video": %s', outputWrites?.video ?? 0);
    this?.log?.info?.('        "audio": %s', outputWrites?.audio ?? 0);
    this?.log?.info?.('      },');
    this?.log?.info?.('    },');
    this?.log?.info?.('    "last": {');
    this?.log?.info?.('      "item": "%s"', lastItemAgo);
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
          if (streamer.hasActiveStreams() === false) {
            streamer.#outputErrors = 0;
            continue;
          }

          streamerStartTime = Date.now();
          streamer.#processOutput(dateNow, streamerBudget);
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
        streamers.delete(streamer.#HomeKitDeviceUUID);
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
    if (streamer instanceof Streamer === false) {
      return;
    }

    if (typeof streamer.#HomeKitDeviceUUID !== 'string' || streamer.#HomeKitDeviceUUID === '') {
      return;
    }

    this.#streamers.set(streamer.#HomeKitDeviceUUID, streamer);
    this.#start();
  }

  // Remove a streamer instance from the shared scheduler
  // Called when the instance no longer has any active streams
  static #removeStreamer(streamer) {
    if (streamer instanceof Streamer === false) {
      return;
    }

    if (typeof streamer.#HomeKitDeviceUUID !== 'string' || streamer.#HomeKitDeviceUUID === '') {
      return;
    }

    this.#streamers.delete(streamer.#HomeKitDeviceUUID);

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
      if (Streamer.#streamers.has(this.#HomeKitDeviceUUID) === false) {
        Streamer.#addStreamer(this);
      }
      return;
    }

    // Only remove if currently registered
    if (Streamer.#streamers.has(this.#HomeKitDeviceUUID) === true) {
      Streamer.#removeStreamer(this);
    }
  }
}
