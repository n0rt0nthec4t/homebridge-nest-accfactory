// Streamer
// Part of homebridge-nest-accfactory
//
// Base class for HomeKit Camera/Doorbell media output.
//
// Streamer owns the HomeKit-facing media pipeline:
// - shared media retention via MediaTimeline
// - live and recording output fan-out
// - per-output pacing and catch-up behaviour
// - decoder-safe startup handling
// - H264 SPS/PPS bootstrap for outputs
// - fallback video frame injection when the camera is offline, video is disabled, or migrating
// - optional talkback stream wiring to the active StreamTransport
//
// Streamer does not implement protocol-specific streaming.
//
// Protocol-specific connection handling is owned by StreamTransport subclasses
// such as WebRTC and NexusTalk. A transport is injected into Streamer through
// constructor options and is responsible for:
// - authentication/signalling/session setup
// - reconnect/recovery behaviour
// - packet receive and protocol parsing
// - media frame assembly
// - codec metadata and source media stats
// - lifecycle state reporting
//
// Transport boundary:
// - Transport emits complete media frames using consumer.media(media)
// - Transport reports lifecycle state using consumer.state(state, reason)
// - Streamer consumes those callbacks and writes retained/timed output streams
//
// Media model:
// - Streamer expects complete media frames, not partial RTP/NAL fragments
// - Video should be complete H264 NAL units or access units
// - Audio should be complete AAC/PCM/Opus/etc frames as produced by the transport
// - Streamer preserves media ordering using monotonic timeline timestamps
//
// Buffering model:
// - A shared MediaTimeline stores recent media items
// - MediaTimeline uses one ordered RingBuffer plus video/audio/keyframe indexes
// - Live and recording sessions read independently from the same retained timeline
// - Each output maintains media-specific cursors plus a protected retention cursor
//
// Live streaming behaviour:
// - Live outputs attach at the current live edge
// - Output policy controls whether startup waits for a keyframe
// - This keeps latency low while still allowing decoder-safe startup when required
//
// Recording behaviour:
// - Recording outputs can start from a requested timestamp
// - The closest retained media item to the requested time is selected
// - Decoder/keyframe safety is handled during playout, not during cursor selection
//
// H264 handling:
// - Transport assembles H264 media
// - Streamer caches SPS/PPS for output bootstrap
// - Streamer expects H264 transport media to already be Annex-B access units
// - Streamer injects SPS/PPS before first output keyframe when required
//
// Statistics:
// - StreamTransport owns lifecycle/source media stats
// - MediaTimeline owns retained buffer/index stats
// - Streamer owns per-output write/drop/playout stats
//
// Code version 2026.05.13
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
import MediaTimeline from './mediaTimeline.js';
import StreamTransport from './streamtransport.js';

// Define constants
import { TIMERS, RESOURCE_FRAMES, RESOURCE_PATH, LOG_LEVELS, __dirname } from './consts.js';

const MAX_BUFFERED_ITEMS_PER_OUTPUT_PER_TICK = 20; // Prevent one output starving others
const STREAM_FRAME_INTERVAL = 1000 / 30; // 30fps approx
const OUTPUT_LOOP_INTERVAL = 10; // Shared output scheduler interval
const OUTPUT_BUDGET_LOG_INTERVAL = 30000; // Throttle per-streamer over-budget debug logs
const OUTPUT_PLAYOUT_POLICY = {
  live: {
    requireKeyFrameStart: false,
    playoutDelayMs: 350,
    maxLagBehindLiveMs: 1000,
    dueTolerance: 12,
    dueSlack: 18,
    catchupExitThresholdMs: 300,
    catchupAudioBurstLimit: 6,
    normalVideoBurstLimit: 2,
    normalAudioBurstLimit: 8,
    catchupVideoBurstLimit: 4,
  },

  record: {
    requireKeyFrameStart: true,
    playoutDelayMs: 200,
    maxLagBehindLiveMs: 1200,
    dueTolerance: 12,
    dueSlack: 20,
    catchupExitThresholdMs: 350,
    catchupAudioBurstLimit: 6,
    normalVideoBurstLimit: 3,
    normalAudioBurstLimit: 6,
    catchupVideoBurstLimit: 10,
  },
};

// Initial capacity used by Streamer for its shared media buffer.
// This may diverge from the generic RingBuffer default as buffering strategy,
// retention window, or media characteristics evolve.
// Define constants
const STREAMER_INITIAL_BUFFER_CAPACITY = 1024;
const STREAMER_MAX_BUFFER_CAPACITY = 8192;

// Streamer object
export default class Streamer {
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

  static CODEC_TYPE = StreamTransport.CODEC_TYPE;
  static H264NALUS = StreamTransport.H264NALUS;

  static MESSAGE = 'Streamer.onMessage'; // Message type for HomeKitDevice to listen for

  static MESSAGE_TYPE = {
    // Action type messages
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

  supportDump = false; // Enable support for dumping stats on demand for this streamer instance
  log = undefined; // Logging function object
  videoEnabled = undefined; // Video stream on camera enabled or not
  audioEnabled = undefined; // Audio from camera enabled or not
  online = undefined; // Camera online or not
  migrating = undefined; // Device is transferring/migrating between APIs
  nest_google_device_uuid = undefined; // Nest/Google UUID of the device connecting

  // Internal data only for this class
  #transport = undefined; // Active protocol transport
  #HomeKitDeviceUUID = undefined; // HomeKitDevice uuid for this streamer
  #bufferDuration = 0; // Duration of media to keep in the shared buffer based on media timestamps
  #bufferEnabled = false; // Retained buffering policy flag owned by Streamer
  #timeline = undefined; // Shared media timeline used by buffering, live and recording outputs
  #outputs = new Map(); // Live and recording outputs keyed by session id
  #cameraFrames = {}; // H264 resource frames for offline, video off, transferring
  #sequenceCounters = {}; // Sequence counters for item types
  #itemIndex = 0; // Monotonic item index for shared media timeline cursor tracking
  #videoState = {}; // Video state tracking
  #audioState = {}; // Audio state tracking
  #lastFallbackFrameTime = 0; // Timer for pacing fallback frames
  #lastBudgetLogTime = 0; // Last time budget processing was sampled/logged
  #outputErrors = 0; // Consecutive output loop failures for this instance
  #lastMediaTime = {}; // Track last buffered media time per type for fallback ordering guards
  #connectOptions = {}; // Store options from connect to use on reconnects
  #lifecycleQueue = Promise.resolve(); // Serializes source connect/close operations to avoid lifecycle races

  // Codecs currently being used by the active transport.
  get codecs() {
    return (
      this.#transport?.codecs ?? {
        video: undefined,
        audio: undefined,
        talkback: undefined,
      }
    );
  }

  constructor(uuid, deviceData, options = {}) {
    if (Object.values(LOG_LEVELS).every((fn) => typeof options?.log?.[fn] === 'function')) {
      this.log = options.log;
    }

    this.#HomeKitDeviceUUID = uuid;

    HomeKitDevice.message(uuid, Streamer.MESSAGE, this);
    HomeKitDevice.message(uuid, HomeKitDevice.UPDATE, this);
    HomeKitDevice.message(uuid, HomeKitDevice.TIMER, this);
    HomeKitDevice.message(uuid, HomeKitDevice.SHUTDOWN, this);

    this.migrating = deviceData?.migrating === true;
    this.online = deviceData?.online === true;
    this.videoEnabled = deviceData?.streaming_enabled === true;
    this.audioEnabled = deviceData?.audio_enabled === true;
    this.nest_google_device_uuid = deviceData?.nest_google_device_uuid;

    const loadFrameResource = (filename, label) => {
      let buffer = undefined;
      let file = path.resolve(__dirname, RESOURCE_PATH, filename);

      if (fs.existsSync(file) === true) {
        buffer = fs.readFileSync(file);

        // Strip Annex-B start code from bundled fallback frames.
        // Streamer adds start codes during output when required.
        if (buffer.indexOf(StreamTransport.H264NALUS.START_CODE) === 0) {
          buffer = buffer.subarray(StreamTransport.H264NALUS.START_CODE.length);
        }
      } else {
        this.log?.warn?.('Failed to load %s video resource for "%s"', label, deviceData.description);
      }

      return buffer;
    };

    // Load bundled fallback frames used when:
    // - camera is offline
    // - video is disabled
    // - Nest device is migrating between APIs
    this.#cameraFrames = {
      offline: loadFrameResource(RESOURCE_FRAMES.CAMERA_OFFLINE, 'offline'),
      off: loadFrameResource(RESOURCE_FRAMES.CAMERA_OFF, 'video off'),
      transfer: loadFrameResource(RESOURCE_FRAMES.CAMERA_TRANSFER, 'transferring'),
    };

    this.#lastFallbackFrameTime = Date.now();
    this.supportDump = options?.supportDump === true;

    // Setup retained media buffer duration.
    // Clamp to sane bounds to avoid invalid or excessive retention sizes.
    this.#bufferDuration =
      Number.isInteger(options?.bufferDuration) === true && options.bufferDuration > 0
        ? Math.min(Math.max(options.bufferDuration, 2000), 15000)
        : 5000;

    // Attach transport backend (WebRTC / NexusTalk).
    // Transport owns protocol connection, media parsing and state.
    // Streamer owns buffering, pacing, fan-out and HomeKit stream handling.
    if (options?.transport instanceof StreamTransport) {
      this.#transport = options.transport;

      // Wire transport callbacks into Streamer.
      // Media and lifecycle events flow through this interface.
      this.#transport.consumer = {
        // Incoming media from transport.
        media: (media) => {
          this.addMedia(media);
        },

        // Transport state changes (connecting, ready, reconnecting, etc).
        state: (state, reason) => {
          this.onMessage(state, { reason: reason });
        },

        // Whether there are active outputs consuming media.
        active: () => {
          return this.hasActiveStreams();
        },
      };
    }
  }

  async onUpdate(deviceData) {
    let reconnect = false;
    let wasOnline = this.online === true;
    let becameOnline = false;
    let becameAvailable = false;
    let transportOptions = undefined;

    if (typeof deviceData !== 'object' || deviceData === null) {
      return;
    }

    // Streamer-owned display/fallback state.
    // These drive offline/video-disabled fallback frame behaviour.
    if (deviceData?.migrating !== undefined) {
      this.migrating = deviceData.migrating === true;
    }

    if (deviceData?.online !== undefined) {
      this.online = deviceData.online === true;
    }

    if (deviceData?.streaming_enabled !== undefined) {
      this.videoEnabled = deviceData.streaming_enabled === true;
    }

    if (deviceData?.audio_enabled !== undefined) {
      this.audioEnabled = deviceData.audio_enabled === true;
    }

    // Detect when a camera becomes available again after being offline.
    // We only want to reconnect if we transitioned from unavailable -> available,
    // not on every normal update tick.
    becameOnline = wasOnline !== true && this.online === true;
    becameAvailable = becameOnline === true && this.videoEnabled === true;

    // Transport-owned connection/auth/source options.
    // Transport subclasses decide which fields matter.
    transportOptions = {
      uuid: deviceData?.nest_google_device_uuid,
      host: deviceData?.nexustalk_host,
      apiAccess: deviceData?.apiAccess,
      fieldTest: deviceData?.apiAccess?.fieldTest === true,
    };

    // Source identity changed.
    // Existing transport session cannot be trusted, so force reconnect.
    if (deviceData?.nest_google_device_uuid !== undefined && this.nest_google_device_uuid !== deviceData.nest_google_device_uuid) {
      this.nest_google_device_uuid = deviceData.nest_google_device_uuid;
      reconnect = true;
    }

    // Allow transport to refresh runtime configuration such as:
    // - access tokens
    // - Google/Nest auth mode
    // - NexusTalk host
    // - field test settings
    if (typeof this.#transport?.update === 'function') {
      await this.#transport.update(transportOptions);
    }

    // No active buffering/live/record consumers.
    // Nothing upstream needs reconnecting yet.
    if (this.hasActiveStreams() !== true) {
      return;
    }

    // Camera unavailable or video disabled.
    // Close transport but keep outputs alive so fallback frames continue.
    if (this.online === false || this.videoEnabled === false) {
      await this.#doClose();
      return;
    }

    // Reconnect transport when:
    // - source identity changed
    // - camera has come back online
    // - transport was previously closed while outputs remained active
    //
    // This covers offline -> online recovery while buffering/live view
    // continues to exist.
    if (reconnect === true || becameAvailable === true || this.#transport?.closed === true) {
      await this.#doConnect({ forceReconnect: true });
    }
  }

  async onMessage(type, message) {
    if (typeof type !== 'string' || type === '') {
      return;
    }

    let sessionID = message?.sessionID !== undefined ? String(message.sessionID) : undefined;
    let options = typeof message?.options === 'object' && message.options !== null ? message.options : undefined;

    if (type === Streamer.MESSAGE_TYPE.START_BUFFER) {
      // Enable retained buffer and ensure source is connected.
      // This does not create an output stream, only prepares buffering for future use.
      await this.#startBuffering(options);
      return;
    }

    if (type === Streamer.MESSAGE_TYPE.STOP_BUFFER) {
      // Disable retained buffer.
      // If no outputs are active, this may also allow the source to close.
      await this.#stopBuffering();
      return;
    }

    if (type === Streamer.MESSAGE_TYPE.START_LIVE) {
      // Start a live streaming output for HomeKit.
      // This creates PassThrough streams and begins feeding real-time data.
      return await this.#createOutput(sessionID, Streamer.STREAM_TYPE.LIVE, options);
    }

    if (type === Streamer.MESSAGE_TYPE.STOP_LIVE) {
      // Stop a live streaming output.
      // Cleans up streams and may close source if no other outputs remain.
      await this.#stopOutput(sessionID, Streamer.STREAM_TYPE.LIVE);
      return;
    }

    if (type === Streamer.MESSAGE_TYPE.START_RECORD) {
      // Start a recording output (HKSV).
      // Uses retained buffer and selects a start position based on requested time.
      // Decoder safety (keyframe alignment) is handled during playout.
      return await this.#createOutput(sessionID, Streamer.STREAM_TYPE.RECORD, options);
    }

    if (type === Streamer.MESSAGE_TYPE.STOP_RECORD) {
      // Stop a recording output.
      // If no sessionID is provided, stops the first active recording stream.
      await this.#stopOutput(sessionID, Streamer.STREAM_TYPE.RECORD);
      return;
    }

    if (Object.values(StreamTransport.STATE).includes(type) === true) {
      // Reset transient media/output source tracking when a new transport lifecycle
      // starts, restarts, or fully closes.
      if (
        type === StreamTransport.STATE.CONNECTING ||
        type === StreamTransport.STATE.RECONNECTING ||
        type === StreamTransport.STATE.CLOSED
      ) {
        this.#resetSourceState();
      }

      return;
    }
  }

  async onShutdown() {
    Streamer.#removeStreamer(this);
    await this.stopEverything();
  }

  async stopEverything() {
    this?.log?.debug?.('Stopped buffering, live and recording from device uuid "%s"', this.nest_google_device_uuid);

    for (let output of this.#outputs.values()) {
      this.#cleanupOutput(output);
    }

    this.#outputs.clear();
    this.#resetRetainedState();
    this.#syncSchedulerState();

    // Always close underlying transport during shutdown/cleanup.
    await this.#doClose();
  }

  addMedia(media) {
    let addedIndex = undefined;
    let mediaType = undefined;
    let codec = undefined;
    let now = Date.now();
    let data = undefined;
    let sequence = 0;
    let sourceTimestamp = 0;
    let mediaTime = 0;
    let minimumMediaStep = 1;
    let keyFrame = false;
    let nalUnits = undefined;

    // Validate incoming media object.
    if (typeof media !== 'object' || media === null) {
      return;
    }

    mediaType = typeof media.type === 'string' ? media.type.toLowerCase() : undefined;
    keyFrame = media?.keyFrame === true;

    // Validate media type and payload.
    if (
      typeof mediaType !== 'string' ||
      mediaType.trim() === '' ||
      (mediaType !== Streamer.MEDIA_TYPE.VIDEO &&
        mediaType !== Streamer.MEDIA_TYPE.AUDIO &&
        mediaType !== Streamer.MEDIA_TYPE.TALK &&
        mediaType !== Streamer.MEDIA_TYPE.METADATA) ||
      Buffer.isBuffer(media.data) !== true ||
      media.data.length === 0
    ) {
      return;
    }

    // Do not process if no active outputs or retained buffer.
    if (this.hasActiveStreams() !== true) {
      return;
    }

    data = media.data;

    // Ensure shared media timeline exists before proceeding.
    this.#ensureMediaTimeline();
    if (this.#timeline === undefined) {
      return;
    }

    // Resolve codec.
    // Transport owns codec metadata, but explicit media codec wins if provided.
    codec =
      typeof media?.codec === 'string'
        ? media.codec.toLowerCase()
        : mediaType === Streamer.MEDIA_TYPE.VIDEO
          ? this.codecs?.video
          : mediaType === Streamer.MEDIA_TYPE.AUDIO
            ? this.codecs?.audio
            : mediaType === Streamer.MEDIA_TYPE.TALK
              ? this.codecs?.talkback
              : mediaType === Streamer.MEDIA_TYPE.METADATA
                ? StreamTransport.CODEC_TYPE.META
                : undefined;

    if (typeof codec !== 'string' || codec.trim() === '') {
      return;
    }

    // H264 transport contract:
    // - transports emit complete Annex-B access units
    // - Streamer stores access units unchanged
    // - output writes item.data directly
    // - Streamer only caches clean SPS/PPS for optional decoder bootstrap
    if (mediaType === Streamer.MEDIA_TYPE.VIDEO && codec === StreamTransport.CODEC_TYPE.H264) {
      nalUnits = StreamTransport.getH264NALUnits(data);

      if (nalUnits.length === 0) {
        return;
      }

      for (let nalu of nalUnits) {
        if (nalu.type === StreamTransport.H264NALUS.TYPES.SPS) {
          this.#videoState.lastSPS = Buffer.from(nalu.data);
        }

        if (nalu.type === StreamTransport.H264NALUS.TYPES.PPS) {
          this.#videoState.lastPPS = Buffer.from(nalu.data);
        }

        if (nalu.type === StreamTransport.H264NALUS.TYPES.IDR) {
          this.#videoState.lastIDR = Buffer.from(nalu.data);
          keyFrame = true;
        }
      }

      if (keyFrame === true) {
        this.#videoState.lastIDRIndex = this.#itemIndex;
      }
    }

    // Initialise sequence counter if required.
    if (typeof this.#sequenceCounters?.[mediaType] !== 'number') {
      this.#sequenceCounters[mediaType] = 0;
    }

    // Use provided sequence/timestamp or fallback to generated values.
    sequence = Number.isFinite(media?.sequence) === true ? media.sequence : this.#sequenceCounters[mediaType]++;
    sourceTimestamp = Number.isFinite(media?.timestamp) === true ? Math.round(media.timestamp) : now;

    // Ensure monotonic media time.
    // StreamTransport owns media timing metadata, but Streamer still protects
    // MediaTimeline ordering if timestamps repeat or go backwards.
    if (typeof this.#lastMediaTime?.[mediaType] !== 'number') {
      this.#lastMediaTime[mediaType] = 0;
    }

    if (sourceTimestamp <= this.#lastMediaTime[mediaType]) {
      if (
        mediaType === Streamer.MEDIA_TYPE.VIDEO &&
        Number.isFinite(this.#transport?.video?.fps) === true &&
        this.#transport.video.fps > 0
      ) {
        minimumMediaStep = Math.max(1, Math.round(1000 / this.#transport.video.fps));
      }

      if (
        mediaType === Streamer.MEDIA_TYPE.AUDIO &&
        Number.isFinite(this.#transport?.audio?.frameDuration) === true &&
        this.#transport.audio.frameDuration > 0
      ) {
        minimumMediaStep = Math.max(1, Math.round(this.#transport.audio.frameDuration));
      }

      if (mediaType === Streamer.MEDIA_TYPE.VIDEO && minimumMediaStep === 1) {
        minimumMediaStep = Math.round(STREAM_FRAME_INTERVAL);
      }

      mediaTime = this.#lastMediaTime[mediaType] + minimumMediaStep;
    } else {
      mediaTime = sourceTimestamp;
    }

    this.#lastMediaTime[mediaType] = mediaTime;

    // Push final packet into shared media timeline.
    addedIndex = this.#timeline.add({
      type: mediaType,
      codec: codec,
      time: mediaTime,
      sourceTimestamp: sourceTimestamp,
      sequence: sequence,
      keyFrame: keyFrame === true,
      data: data,
    });

    if (typeof addedIndex === 'number') {
      // Keep Streamer item index aligned with MediaTimeline.
      // MediaTimeline owns index assignment for retained media items.
      this.#itemIndex = this.#timeline.nextIndex;
    }
  }

  async #startBuffering(options = {}) {
    this.#ensureMediaTimeline();
    if (this.#timeline === undefined) {
      return;
    }

    this.#bufferEnabled = true;
    this.log?.debug?.('Started buffering from device uuid "%s"', this.nest_google_device_uuid);
    this.#syncSchedulerState();

    await this.#doConnect(options);
  }

  async #stopBuffering() {
    if (this.#bufferEnabled !== true) {
      return;
    }

    this.#bufferEnabled = false;
    this.log?.debug?.('Stopped buffering from device uuid "%s"', this.nest_google_device_uuid);

    if (this.isStreaming() === false) {
      this.#resetRetainedState();
      this.#syncSchedulerState();
      await this.#doClose();
      return;
    }

    this.#syncSchedulerState();
  }

  async #createOutput(sessionID, type, options) {
    let existing = undefined;
    let output = undefined;
    let video = undefined;
    let audio = null;
    let talkback = null;
    let includeAudio = options?.includeAudio === true && this.audioEnabled === true;
    let waitForReady = Number.isInteger(options?.waitForReady) === true ? options.waitForReady : 0;
    let startCursor = this.#itemIndex;
    let timeline = undefined;
    let timelineStart = 0;
    let item = undefined;
    let recordTime = options?.recordTime;
    let startTime = Date.now();

    // Validate session id.
    if (typeof sessionID !== 'string' || sessionID === '') {
      return;
    }

    // Check for existing output with this session id.
    existing = this.#outputs.get(sessionID);

    // Only allow a single record output, regardless of session id.
    if (type === Streamer.STREAM_TYPE.RECORD && existing === undefined) {
      for (output of this.#outputs.values()) {
        if (output?.type === Streamer.STREAM_TYPE.RECORD) {
          existing = output;
          break;
        }
      }
    }

    // Reuse existing output when possible, otherwise reject type conflict.
    if (existing !== undefined) {
      if (existing.type !== type) {
        this?.log?.warn?.(
          'Cannot start output for device uuid "%s" and session id "%s" as it is already in use for "%s"',
          this.nest_google_device_uuid,
          sessionID,
          existing.type,
        );
        return;
      }

      return {
        video: existing.video,
        audio: existing.audio,
        talkback: existing.talkback,
      };
    }

    // Ensure retained timeline exists and start/connect source if needed.
    this.#ensureMediaTimeline();
    await this.#doConnect(options);
    timeline = this.#timeline;

    if (timeline instanceof MediaTimeline !== true) {
      return;
    }

    // Create streams for this output.
    video = new PassThrough();
    audio = includeAudio === true ? new PassThrough() : null;
    talkback = type === Streamer.STREAM_TYPE.LIVE && includeAudio === true ? new PassThrough({ highWaterMark: 1024 * 16 }) : null;

    // Prevent unhandled stream errors from bubbling.
    video?.on?.('error', () => {});
    audio?.on?.('error', () => {});
    talkback?.on?.('error', () => {});

    // Determine initial cursor for recording.
    if (type === Streamer.STREAM_TYPE.RECORD) {
      timelineStart = timeline.startIndex;

      // Default to the retained timeline start.
      if (typeof timelineStart === 'number') {
        startCursor = timelineStart;
      }

      // Recording should start from the retained position closest to the requested
      // record time only. Decoder/keyframe safety is handled later during playout
      // inside #processBufferedOutput(), not here.
      if (timeline.empty !== true && typeof recordTime === 'number' && Number.isFinite(recordTime) === true) {
        item = timeline.closestToTime(recordTime);

        if (typeof item?.index === 'number') {
          startCursor = item.index;
        }
      }

      // Never allow cursor to point before current retained window.
      if (typeof timelineStart === 'number' && startCursor < timelineStart) {
        startCursor = timelineStart;
      }
    }

    // Live streaming should attach at the live edge.
    // We do not backtrack live outputs into retained media here.
    // Any decoder startup/keyframe handling remains the responsibility of
    // #processBufferedOutput().
    if (type === Streamer.STREAM_TYPE.LIVE) {
      startCursor = this.#itemIndex;
    }

    // Create output state.
    // Each output consumes from the shared media timeline using independent video
    // and audio cursors with one shared playout timing model.
    //
    // Key concepts:
    // - videoCursor/audioCursor: next media-specific read positions (absolute indexes)
    // - cursor: earliest media cursor, retained for shared timeline trimming
    // - catchingUp: used when starting behind live edge (mainly RECORD) to fast-drain
    // - sourceBaseTime / wallclockBaseTime:
    //     map source timestamps -> real time for paced playback
    // - policy: defines how this output consumes media (latency vs continuity tradeoff)
    //
    // IMPORTANT:
    // - All smoothing / pacing happens in Streamer (not in NexusTalk/WebRTC)
    // - Each output has its own independent timing model
    // - Policies MUST be tuned per output type (do not unify blindly)

    output = {
      sessionID: sessionID,
      type: type,

      // Writable streams (ffmpeg pipes etc).
      video: video,
      audio: audio,
      talkback: talkback,
      talkbackTimeout: undefined,

      // Whether audio should be written for this output.
      includeAudio: includeAudio,

      // Protected read cursor into shared media timeline.
      // The media cursors below do the actual draining; this remains the minimum
      // retained position used by timeline trimming.
      cursor: startCursor,
      videoCursor: startCursor,
      audioCursor: startCursor,

      // Catch-up mode:
      // - RECORD starts in catch-up to drain historical timeline
      // - LIVE starts at the live edge so no catch-up is required initially
      catchingUp: type === Streamer.STREAM_TYPE.RECORD,
      catchupTicks: 0,
      catchupStableFrames: 0,

      // Codec / decoder state tracking.
      sentCodecConfig: false, // SPS/PPS sent
      seenKeyFrame: false, // first keyframe seen

      // Last time a video frame was written (used for fallback timing).
      lastVideoWriteTime: 0,

      // Time mapping for paced playback:
      // wallclockTime = wallclockBaseTime + (item.time - sourceBaseTime)
      sourceBaseTime: undefined,
      wallclockBaseTime: undefined,

      // Playout policy:
      // Defines how aggressively we stay near live edge vs preserve continuity.
      //
      // LIVE:
      // - attaches at the live edge with a modest playout delay
      // - prefers stable low-latency delivery over dumping bursts into ffmpeg
      //
      // RECORD:
      // - slightly delayed paced playback
      // - preserves continuity while draining retained media
      policy: { ...(OUTPUT_PLAYOUT_POLICY[type] ?? OUTPUT_PLAYOUT_POLICY.live) },

      // Debug / instrumentation stats (used for tuning pacing behaviour).
      stats: {
        startedAt: Date.now(),
        firstWriteAt: undefined,
        firstVideoWriteAt: undefined,
        firstAudioWriteAt: undefined,
        writes: { total: 0, video: 0, audio: 0 },
        drops: { videoBeforeKeyframe: 0, audioBeforeKeyframe: 0, bufferTrimmed: 0 },
        diagnostics: {
          lastVideoWriteAt: undefined,
          lastAudioWriteAt: undefined,
          maxVideoWriteGapMs: 0,
          maxAudioWriteGapMs: 0,
          audioWriteGapsOver100Ms: 0,
          audioWriteGapsOver250Ms: 0,
          audioWriteGapsOver500Ms: 0,
          audioBlockedBehindVideo: 0,
          maxBlockedAudioLagMs: 0,
        },
      },
    };

    // Attach talkback handling for live streams.
    if (talkback !== null) {
      talkback.on('data', (data) => {
        this.#transport?.sendAudio?.(data);

        clearTimeout(output.talkbackTimeout);
        output.talkbackTimeout = setTimeout(() => {
          this.#transport?.sendAudio?.(Buffer.alloc(0));
        }, TIMERS.TALKBACK_AUDIO.interval);
      });

      talkback.on('close', () => {
        clearTimeout(output?.talkbackTimeout);
        this.#transport?.sendAudio?.(Buffer.alloc(0));
      });
    }

    // Register output before any optional readiness wait.
    this.#outputs.set(sessionID, output);
    this.#syncSchedulerState();

    // Optionally wait for source readiness before returning stream handles.
    if (waitForReady > 0) {
      while (Date.now() - startTime < waitForReady) {
        if (this.#transport?.ready === true || this.#transport?.closed === true || this.#transport?.reconnecting === true) {
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    this?.log?.debug?.('Started %s stream from device uuid "%s" and session id "%s"', type, this.nest_google_device_uuid, sessionID);

    return {
      video: video,
      audio: audio,
      talkback: talkback,
    };
  }

  async #stopOutput(sessionID, type) {
    let output = undefined;
    let hasOtherLiveOutputs = false;
    let id = undefined;
    let activeOutput = undefined;

    // Resolve output by session id if provided
    if (typeof sessionID === 'string' && sessionID !== '') {
      output = this.#outputs.get(sessionID);
    }

    // For recording, allow stopping the first active record stream if no session id was provided
    if (output === undefined && type === Streamer.STREAM_TYPE.RECORD) {
      for (let candidate of this.#outputs.values()) {
        if (candidate?.type === Streamer.STREAM_TYPE.RECORD) {
          output = candidate;
          break;
        }
      }
    }

    // Nothing matched to stop
    if (output === undefined) {
      return;
    }

    // Ensure we are not stopping a mismatched type (e.g. live vs record)
    if (output.type !== type) {
      this?.log?.warn?.(
        'Cannot stop stream for device uuid "%s" and session id "%s" as it is type "%s" not "%s"',
        this.nest_google_device_uuid,
        output.sessionID,
        output.type,
        type,
      );
      return;
    }

    // If this is the last live output and support dump is enabled, log per-output stats before cleanup
    if (output.type === Streamer.STREAM_TYPE.LIVE && this.supportDump === true) {
      for ([id, activeOutput] of this.#outputs) {
        if (id !== output.sessionID && activeOutput?.type === Streamer.STREAM_TYPE.LIVE) {
          hasOtherLiveOutputs = true;
          break;
        }
      }

      if (hasOtherLiveOutputs !== true) {
        this.#outputStats(output, Date.now());
      }
    }

    this?.log?.debug?.(
      'Stopping %s stream from device uuid "%s" and session id "%s"',
      type,
      this.nest_google_device_uuid,
      output.sessionID,
    );

    // Cleanup streams, timers, and any talkback state
    this.#cleanupOutput(output);

    // Remove from active outputs
    this.#outputs.delete(output.sessionID);

    // Clear retained state when last output stops and buffering is disabled.
    // This prevents stale buffered media being reused by the next session.
    if (this.#outputs.size === 0 && this.#bufferEnabled !== true) {
      this.#resetRetainedState();
    }

    // Update scheduler based on remaining activity
    this.#syncSchedulerState();

    // If nothing remains active, fully close underlying source
    if (this.isStreaming() === false && this.isBuffering() === false) {
      await this.#doClose();
    }
  }

  isBuffering() {
    return this.#bufferEnabled === true;
  }

  isStreaming() {
    return this.#outputs.size !== 0;
  }

  isRecording() {
    for (let output of this.#outputs.values()) {
      if (output?.type === Streamer.STREAM_TYPE.RECORD) {
        return true;
      }
    }

    return false;
  }

  isLiveStreaming() {
    for (let output of this.#outputs.values()) {
      if (output?.type === Streamer.STREAM_TYPE.LIVE) {
        return true;
      }
    }

    return false;
  }

  hasActiveStreams() {
    return this.#bufferEnabled === true || this.#outputs.size !== 0;
  }

  async requestSourceConnect(options = undefined) {
    return await this.#doConnect(options);
  }

  async requestSourceClose() {
    return await this.#doClose();
  }

  #queueLifecycle(task) {
    // Chain lifecycle operations sequentially so connect/close/reconnect
    // actions cannot overlap or race each other.
    let run = this.#lifecycleQueue.then(async () => {
      return await task();
    });

    // Keep the internal queue alive even if a lifecycle task fails.
    // This prevents a rejected promise from permanently breaking the queue
    // and suppresses unhandled rejection warnings for internal sequencing.
    this.#lifecycleQueue = run.catch((error) => {
      this?.log?.debug?.(
        'Streamer lifecycle queue task failed for device uuid "%s": %s',
        this.nest_google_device_uuid,
        error?.message || String(error),
      );
    });

    // Return the original task promise so callers still receive failures.
    return run;
  }

  async #doConnect(options = undefined) {
    return await this.#queueLifecycle(async () => {
      let forceReconnect = options?.forceReconnect === true;

      if (this.online !== true || this.videoEnabled !== true) {
        return;
      }

      if (typeof options === 'object' && options !== null) {
        this.#connectOptions = {
          ...(typeof this.#connectOptions === 'object' && this.#connectOptions !== null ? this.#connectOptions : {}),
          ...options,
        };

        if (Object.prototype.hasOwnProperty.call(options, 'host') !== true) {
          delete this.#connectOptions.host;
        }
      }

      if (forceReconnect !== true && this.#transport?.closed !== true && this.#transport?.reconnecting !== true) {
        return;
      }

      await this.#transport?.open?.(this.#connectOptions);
    });
  }

  async #doClose() {
    return await this.#queueLifecycle(async () => {
      this.#resetSourceState();
      await this.#transport?.close?.();
    });
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

  #resetRetainedState() {
    this.#bufferEnabled = false;
    this.#timeline = undefined;
    this.#sequenceCounters = {};
    this.#itemIndex = 0;
    this.#videoState = {};
    this.#audioState = {};
    this.#lastMediaTime = {};
  }

  #ensureMediaTimeline() {
    if (this.#timeline === undefined) {
      this.#timeline = new MediaTimeline(this.#itemIndex, STREAMER_INITIAL_BUFFER_CAPACITY, STREAMER_MAX_BUFFER_CAPACITY);
    }
  }

  #resetSourceState() {
    this.#videoState = {};
    this.#audioState = {};
    this.#lastMediaTime = {};

    // A transport reconnect means a new encoded media session.
    // Existing HomeKit outputs may still be open, but their decoder state must
    // be reset so the next real H264 keyframe can be bootstrapped again.
    for (let output of this.#outputs.values()) {
      output.seenKeyFrame = false;
      output.sentCodecConfig = false;
      output.sourceBaseTime = undefined;
      output.wallclockBaseTime = undefined;
      output.catchingUp = false;
      output.catchupTicks = 0;
      output.catchupStableFrames = 0;

      // Move active outputs to the current live edge.
      // This avoids replaying stale pre-offline media after fallback frames.
      output.cursor = this.#itemIndex;
      output.videoCursor = this.#itemIndex;
      output.audioCursor = this.#itemIndex;
    }
  }

  #ensureOutputDrops(outputStats) {
    if (typeof outputStats !== 'object' || outputStats === null) {
      return undefined;
    }

    if (typeof outputStats.drops !== 'object' || outputStats.drops === null) {
      outputStats.drops = { videoBeforeKeyframe: 0, audioBeforeKeyframe: 0, bufferTrimmed: 0 };
    }

    return outputStats.drops;
  }

  #statsWrite(output, type, dateNow) {
    let outputStats = output?.stats;
    let outputWrites = outputStats?.writes;
    let diagnostics = outputStats?.diagnostics;
    let gapMs = 0;

    if (this.supportDump !== true) {
      return;
    }

    if (typeof outputStats !== 'object' || outputStats === null) {
      return;
    }

    if (typeof outputStats.firstWriteAt !== 'number') {
      outputStats.firstWriteAt = dateNow;
    }

    if (type === Streamer.MEDIA_TYPE.VIDEO && typeof outputStats.firstVideoWriteAt !== 'number') {
      outputStats.firstVideoWriteAt = dateNow;
    }

    if (type === Streamer.MEDIA_TYPE.AUDIO && typeof outputStats.firstAudioWriteAt !== 'number') {
      outputStats.firstAudioWriteAt = dateNow;
    }

    if (typeof outputWrites !== 'object' || outputWrites === null) {
      return;
    }

    if (typeof diagnostics !== 'object' || diagnostics === null) {
      outputStats.diagnostics = {
        lastVideoWriteAt: undefined,
        lastAudioWriteAt: undefined,
        maxVideoWriteGapMs: 0,
        maxAudioWriteGapMs: 0,
        audioWriteGapsOver100Ms: 0,
        audioWriteGapsOver250Ms: 0,
        audioWriteGapsOver500Ms: 0,
        audioBlockedBehindVideo: 0,
        maxBlockedAudioLagMs: 0,
      };
      diagnostics = outputStats.diagnostics;
    }

    if (typeof outputWrites.total !== 'number') {
      outputWrites.total = 0;
      outputWrites.video = 0;
      outputWrites.audio = 0;
    }

    outputWrites.total++;

    if (type === Streamer.MEDIA_TYPE.VIDEO) {
      outputWrites.video++;

      if (typeof diagnostics.lastVideoWriteAt === 'number') {
        gapMs = dateNow - diagnostics.lastVideoWriteAt;
        if (gapMs > diagnostics.maxVideoWriteGapMs) {
          diagnostics.maxVideoWriteGapMs = gapMs;
        }
      }

      diagnostics.lastVideoWriteAt = dateNow;
    }

    if (type === Streamer.MEDIA_TYPE.AUDIO) {
      outputWrites.audio++;

      if (typeof diagnostics.lastAudioWriteAt === 'number') {
        gapMs = dateNow - diagnostics.lastAudioWriteAt;
        if (gapMs > diagnostics.maxAudioWriteGapMs) {
          diagnostics.maxAudioWriteGapMs = gapMs;
        }

        if (gapMs > 100) {
          diagnostics.audioWriteGapsOver100Ms++;
        }

        if (gapMs > 250) {
          diagnostics.audioWriteGapsOver250Ms++;
        }

        if (gapMs > 500) {
          diagnostics.audioWriteGapsOver500Ms++;
        }
      }

      diagnostics.lastAudioWriteAt = dateNow;
    }
  }

  #statsDrop(output, type) {
    let outputStats = output?.stats;

    if (this.supportDump !== true) {
      return;
    }

    if (typeof outputStats !== 'object' || outputStats === null) {
      return;
    }

    let outputDrops = this.#ensureOutputDrops(outputStats);

    if (type === Streamer.MEDIA_TYPE.VIDEO) {
      outputDrops.videoBeforeKeyframe++;
    }

    if (type === Streamer.MEDIA_TYPE.AUDIO) {
      outputDrops.audioBeforeKeyframe++;
    }
  }

  #writeFallback(output, fallbackFrame, dateNow = undefined) {
    let outputVideo = undefined;
    let outputAudio = undefined;
    let isH264 = false;

    if (Buffer.isBuffer(fallbackFrame) !== true || typeof output !== 'object' || output === null) {
      return;
    }

    outputVideo = output.video;
    outputAudio = output.audio;
    isH264 = this.codecs?.video === StreamTransport.CODEC_TYPE.H264;
    if (typeof dateNow !== 'number') {
      dateNow = Date.now();
    }

    this.#statsWrite(output, Streamer.MEDIA_TYPE.VIDEO, dateNow);

    if (isH264 === true) {
      outputVideo.write(StreamTransport.H264NALUS.START_CODE);
    }

    outputVideo.write(fallbackFrame);

    if (output.includeAudio === true && Buffer.isBuffer(this.#transport?.audio?.blank) === true) {
      this.#statsWrite(output, Streamer.MEDIA_TYPE.AUDIO, dateNow);
      outputAudio.write(this.#transport.audio.blank);
    }
  }

  #processBufferedOutput(output, dateNow, budgetMs) {
    let timeline = this.#timeline;
    let startIndex = undefined;
    let timelineEnd = 0;
    let processed = 0;
    let item = undefined;
    let videoItem = undefined;
    let audioItem = undefined;
    let latestItem = undefined;
    let latestItemTime = undefined;
    let anchorTime = undefined;
    let nextCursor = 0;
    let selectedType = undefined;
    let stopReason = '';
    let diagnostics = undefined;

    let outputVideo = undefined;
    let outputAudio = undefined;
    let includeAudio = false;
    let isH264Output = false;

    let lastSPS = undefined;
    let lastPPS = undefined;
    let hasSPS = false;
    let hasPPS = false;
    let keyFrameHasSPS = false;
    let keyFrameHasPPS = false;

    let policy = undefined;
    let requireKeyFrameStart = false;
    let playoutDelayMs = 0;
    let maxLagBehindLiveMs = 0;
    let dueTolerance = 0;
    let dueSlack = 0;
    let catchupExitThresholdMs = 0;
    let catchupAudioBurstLimit = 0;
    let catchupVideoBurstLimit = 0;
    let normalAudioBurstLimit = 0;
    let normalVideoBurstLimit = 0;

    let state = undefined;
    let due = undefined;
    let caps = undefined;
    let writes = undefined;

    let shouldCatchUp = false;
    let catchupExitedThisTick = false;
    let budgetDeadline = 0;
    let itemLag = 0;
    let lateness = 0;

    // Validate required inputs and shared timeline state before doing any work.
    if (typeof output !== 'object' || output === null || typeof dateNow !== 'number' || timeline instanceof MediaTimeline !== true) {
      return;
    }

    // Snapshot timeline state for this processing tick.
    startIndex = timeline.startIndex;
    timelineEnd = timeline.endIndex;

    if (timeline.size === 0) {
      return;
    }

    // Resolve output streams and audio availability.
    outputVideo = output.video;
    outputAudio = output.audio;
    includeAudio = output.includeAudio === true && outputAudio !== null;
    isH264Output = this.codecs?.video === StreamTransport.CODEC_TYPE.H264;

    // Resolve output policy.
    // Allows per-output tuning (live vs record) while falling back to sensible defaults.
    policy =
      typeof output?.policy === 'object' && output.policy !== null
        ? output.policy
        : (OUTPUT_PLAYOUT_POLICY[output?.type] ?? OUTPUT_PLAYOUT_POLICY.live);

    // Extract policy values with safety checks.
    //
    // Even when live policy does not normally require keyframe startup, force
    // decoder-safe startup whenever this output has not yet seen a real keyframe.
    // This is important after fallback frames, reconnects, source resets, and
    // offline -> online recovery where ffmpeg/HomeKit may still be displaying
    // a fallback H264 image.
    requireKeyFrameStart = policy.requireKeyFrameStart === true || (isH264Output === true && output.seenKeyFrame !== true);

    playoutDelayMs = Number.isFinite(policy.playoutDelayMs) === true && policy.playoutDelayMs >= 0 ? policy.playoutDelayMs : 120;
    maxLagBehindLiveMs =
      Number.isFinite(policy.maxLagBehindLiveMs) === true && policy.maxLagBehindLiveMs > 0 ? policy.maxLagBehindLiveMs : 750;
    dueTolerance = Number.isFinite(policy.dueTolerance) === true && policy.dueTolerance >= 0 ? policy.dueTolerance : 10;
    dueSlack = Number.isFinite(policy.dueSlack) === true && policy.dueSlack >= 0 ? policy.dueSlack : 10;
    catchupExitThresholdMs =
      Number.isFinite(policy.catchupExitThresholdMs) === true && policy.catchupExitThresholdMs >= 0 ? policy.catchupExitThresholdMs : 250;

    catchupAudioBurstLimit =
      Number.isFinite(policy.catchupAudioBurstLimit) === true && policy.catchupAudioBurstLimit > 0
        ? policy.catchupAudioBurstLimit
        : output.type === Streamer.STREAM_TYPE.RECORD
          ? 4
          : 2;

    catchupVideoBurstLimit =
      Number.isFinite(policy.catchupVideoBurstLimit) === true && policy.catchupVideoBurstLimit > 0
        ? policy.catchupVideoBurstLimit
        : output.type === Streamer.STREAM_TYPE.RECORD
          ? 8
          : 4;

    normalAudioBurstLimit =
      Number.isFinite(policy.normalAudioBurstLimit) === true && policy.normalAudioBurstLimit > 0
        ? policy.normalAudioBurstLimit
        : output.type === Streamer.STREAM_TYPE.RECORD
          ? 4
          : 2;

    normalVideoBurstLimit =
      Number.isFinite(policy.normalVideoBurstLimit) === true && policy.normalVideoBurstLimit > 0
        ? policy.normalVideoBurstLimit
        : output.type === Streamer.STREAM_TYPE.RECORD
          ? 3
          : 2;

    // Cached clean SPS/PPS for H264 keyframe bootstrap.
    // Transport media itself remains Annex-B and is written directly.
    lastSPS = this.#videoState.lastSPS;
    lastPPS = this.#videoState.lastPPS;
    hasSPS = Buffer.isBuffer(lastSPS) === true && lastSPS.length > 0;
    hasPPS = Buffer.isBuffer(lastPPS) === true && lastPPS.length > 0;

    // Local mutable output state.
    // Keeping this grouped reduces local variable churn while still writing the
    // final state back to the output object at the end of processing.
    state = {
      cursor: typeof output.cursor === 'number' ? output.cursor : startIndex,
      videoCursor: typeof output.videoCursor === 'number' ? output.videoCursor : startIndex,
      audioCursor: typeof output.audioCursor === 'number' ? output.audioCursor : startIndex,
      seenKeyFrame: output.seenKeyFrame === true,
      sentCodecConfig: output.sentCodecConfig === true,
      catchingUp: output.catchingUp === true,
      sourceBaseTime: output.sourceBaseTime,
      wallclockBaseTime: output.wallclockBaseTime,
      catchupTicks: Number.isInteger(output.catchupTicks) === true && output.catchupTicks >= 0 ? output.catchupTicks : 0,
      catchupStableFrames:
        Number.isInteger(output.catchupStableFrames) === true && output.catchupStableFrames >= 0 ? output.catchupStableFrames : 0,
    };

    // Per-tick due/cap/write counters.
    // These are intentionally reset each scheduler tick.
    due = {
      video: false,
      audio: false,
      videoTime: 0,
      audioTime: 0,
    };

    caps = {
      video: false,
      audio: false,
    };

    writes = {
      catchupAudio: 0,
      catchupVideo: 0,
      normalAudio: 0,
      normalVideo: 0,
    };

    // Clamp cursors to the currently retained media window.
    if (state.cursor < startIndex) {
      state.cursor = startIndex;
    }

    if (state.videoCursor < startIndex) {
      state.videoCursor = startIndex;
    }

    if (state.audioCursor < startIndex) {
      state.audioCursor = startIndex;
    }

    if (includeAudio !== true) {
      state.audioCursor = state.videoCursor;
    }

    // Protected cursor is used for retention.
    // Media-specific cursors do the actual draining.
    state.cursor = includeAudio === true ? Math.min(state.videoCursor, state.audioCursor) : state.videoCursor;

    // Determine latest media timestamp currently retained.
    // This acts as the live head for lag/catch-up decisions.
    latestItem = timeline.last();
    latestItemTime = typeof latestItem?.time === 'number' ? latestItem.time : undefined;

    // Optional time budget for cooperative scheduling across outputs.
    budgetDeadline = typeof budgetMs === 'number' && budgetMs > 0 ? dateNow + budgetMs : 0;

    // Detect if this output is too far behind the retained live head.
    // Uses the earliest protected cursor item as the lag reference.
    if (state.catchingUp !== true && typeof latestItemTime === 'number') {
      item = timeline.get(state.cursor);

      if (typeof item?.time === 'number') {
        itemLag = latestItemTime - item.time;

        if (itemLag > maxLagBehindLiveMs) {
          state.catchingUp = true;
          state.catchupTicks = 0;
          state.catchupStableFrames = 0;
        }
      }
    }

    // Main processing loop.
    // MediaTimeline gives us indexed video/audio lookup so we no longer walk
    // the mixed shared buffer looking for the next item of each type.
    while (
      (state.videoCursor < timelineEnd || (includeAudio === true && state.audioCursor < timelineEnd)) &&
      processed < MAX_BUFFERED_ITEMS_PER_OUTPUT_PER_TICK
    ) {
      // Respect scheduler budget periodically.
      if (budgetDeadline !== 0 && (processed & 0x03) === 0 && Date.now() >= budgetDeadline) {
        stopReason = 'budget';
        break;
      }

      videoItem = state.videoCursor < timelineEnd ? timeline.nextVideoFrom(state.videoCursor) : undefined;
      audioItem = includeAudio === true && state.audioCursor < timelineEnd ? timeline.nextAudioFrom(state.audioCursor) : undefined;

      due.video = false;
      due.audio = false;
      caps.video = false;
      caps.audio = false;
      selectedType = undefined;

      if (videoItem === undefined && audioItem === undefined) {
        break;
      }

      shouldCatchUp = state.catchingUp === true && catchupExitedThisTick === false;

      // Normal playback maps source media timestamps to wallclock time.
      // Catch-up playback drains retained items faster until close to live edge.
      if (shouldCatchUp !== true) {
        if (typeof state.sourceBaseTime !== 'number' || typeof state.wallclockBaseTime !== 'number') {
          anchorTime = undefined;

          if (typeof videoItem?.time === 'number') {
            anchorTime = videoItem.time;
          }

          if (typeof audioItem?.time === 'number' && (typeof anchorTime !== 'number' || audioItem.time < anchorTime)) {
            anchorTime = audioItem.time;
          }

          state.sourceBaseTime = anchorTime;
          state.wallclockBaseTime = dateNow - playoutDelayMs;
        }

        if (typeof videoItem?.time === 'number') {
          due.videoTime = state.wallclockBaseTime + (videoItem.time - state.sourceBaseTime);
          due.video = due.videoTime <= dateNow + dueTolerance + dueSlack;
        }

        if (typeof audioItem?.time === 'number') {
          due.audioTime = state.wallclockBaseTime + (audioItem.time - state.sourceBaseTime);
          due.audio = due.audioTime <= dateNow + dueTolerance + dueSlack;
        }
      } else {
        due.video = videoItem !== undefined;
        due.audio = audioItem !== undefined;
        due.videoTime = dateNow;
        due.audioTime = dateNow;
      }

      if (due.video !== true && due.audio !== true) {
        stopReason = 'not-due';
        break;
      }

      // Enforce burst limits separately for normal and catch-up playback.
      if (due.video === true) {
        caps.video =
          (shouldCatchUp !== true && writes.normalVideo >= normalVideoBurstLimit) ||
          (shouldCatchUp === true && writes.catchupVideo >= catchupVideoBurstLimit);
      }

      if (due.audio === true) {
        caps.audio =
          (shouldCatchUp !== true && writes.normalAudio >= normalAudioBurstLimit) ||
          (shouldCatchUp === true && writes.catchupAudio >= catchupAudioBurstLimit);
      }

      if ((due.video !== true || caps.video === true) && (due.audio !== true || caps.audio === true)) {
        stopReason =
          caps.video === true && caps.audio === true
            ? 'media-cap'
            : caps.video === true
              ? 'video-cap'
              : caps.audio === true
                ? 'audio-cap'
                : 'not-due';
        break;
      }

      // Choose the oldest due media item so A/V ordering remains timeline based.
      if (due.audio === true && caps.audio !== true && (due.video !== true || caps.video === true || due.audioTime <= due.videoTime)) {
        selectedType = Streamer.MEDIA_TYPE.AUDIO;
        item = audioItem;
      } else {
        selectedType = Streamer.MEDIA_TYPE.VIDEO;
        item = videoItem;
      }

      if (typeof item?.time !== 'number') {
        stopReason = 'invalid-item';
        break;
      }

      nextCursor = item.index + 1;

      // If normal playback is badly late, re-anchor timing to avoid falling
      // further behind due to temporary scheduler or upstream jitter.
      if (shouldCatchUp !== true) {
        lateness = dateNow - (selectedType === Streamer.MEDIA_TYPE.AUDIO ? due.audioTime : due.videoTime);

        if (lateness > Math.max(playoutDelayMs / 2, 120)) {
          state.sourceBaseTime = item.time;
          state.wallclockBaseTime = dateNow - playoutDelayMs;
        }
      }

      if (selectedType === Streamer.MEDIA_TYPE.VIDEO) {
        if (item.codec === StreamTransport.CODEC_TYPE.H264) {
          // Suppress pre-keyframe video until this output has a real IDR.
          // This protects both recording startup and live recovery after fallback.
          if (requireKeyFrameStart === true && state.seenKeyFrame !== true && item.keyFrame !== true) {
            this.#statsDrop(output, Streamer.MEDIA_TYPE.VIDEO);
            state.videoCursor = nextCursor;
            processed++;
            continue;
          }

          // Bootstrap H264 decoder with cached SPS/PPS before the first keyframe.
          // Do not duplicate config if the keyframe access unit already contains it.
          if (item.keyFrame === true && state.sentCodecConfig !== true) {
            keyFrameHasSPS = StreamTransport.hasH264NAL(item.data, StreamTransport.H264NALUS.TYPES.SPS);
            keyFrameHasPPS = StreamTransport.hasH264NAL(item.data, StreamTransport.H264NALUS.TYPES.PPS);

            if (hasSPS === true && keyFrameHasSPS !== true) {
              outputVideo.write(StreamTransport.H264NALUS.START_CODE);
              outputVideo.write(lastSPS);
            }

            if (hasPPS === true && keyFrameHasPPS !== true) {
              outputVideo.write(StreamTransport.H264NALUS.START_CODE);
              outputVideo.write(lastPPS);
            }

            state.sentCodecConfig = true;
          }

          if (item.keyFrame === true) {
            state.seenKeyFrame = true;
          }
        }

        outputVideo.write(item.data);
        this.#statsWrite(output, Streamer.MEDIA_TYPE.VIDEO, dateNow);

        if (shouldCatchUp === true) {
          writes.catchupVideo++;
          state.catchupTicks++;

          if (typeof latestItemTime === 'number' && latestItemTime - item.time <= catchupExitThresholdMs) {
            state.catchupStableFrames++;
          } else {
            state.catchupStableFrames = 0;
          }

          // Exit catch-up once enough recent video frames have been written.
          if (state.catchupTicks >= 2 && state.catchupStableFrames >= 2) {
            state.catchingUp = false;
            state.sourceBaseTime = item.time;
            state.wallclockBaseTime = dateNow - playoutDelayMs;
            state.catchupTicks = 0;
            state.catchupStableFrames = 0;
            catchupExitedThisTick = true;
          }
        } else {
          writes.normalVideo++;
        }

        state.videoCursor = nextCursor;
        processed++;
        continue;
      }

      if (selectedType === Streamer.MEDIA_TYPE.AUDIO) {
        // Audio may be disabled for the output or absent from the output stream.
        if (includeAudio !== true || outputAudio === null) {
          state.audioCursor = nextCursor;
          processed++;
          continue;
        }

        // If decoder-safe startup is required, suppress audio until video has
        // reached a keyframe. This helps avoid A/V drift at HomeKit startup.
        if (isH264Output === true && requireKeyFrameStart === true && state.seenKeyFrame !== true) {
          this.#statsDrop(output, Streamer.MEDIA_TYPE.AUDIO);
          state.audioCursor = nextCursor;
          processed++;
          continue;
        }

        outputAudio.write(item.data);
        this.#statsWrite(output, Streamer.MEDIA_TYPE.AUDIO, dateNow);

        if (shouldCatchUp === true) {
          writes.catchupAudio++;
        } else {
          writes.normalAudio++;
        }

        state.audioCursor = nextCursor;
        processed++;
        continue;
      }
    }

    // Diagnostic: audio was due but was blocked by video burst limits.
    if (this.supportDump === true && stopReason === 'video-cap' && due.audio === true && caps.audio !== true) {
      diagnostics = output?.stats?.diagnostics;

      if (typeof diagnostics === 'object' && diagnostics !== null) {
        diagnostics.audioBlockedBehindVideo++;
        diagnostics.maxBlockedAudioLagMs = Math.max(diagnostics.maxBlockedAudioLagMs, Math.max(0, dateNow - due.audioTime));
      }
    }

    // Persist updated output state.
    if (includeAudio !== true) {
      state.audioCursor = state.videoCursor;
    }

    output.videoCursor = state.videoCursor;
    output.audioCursor = state.audioCursor;
    output.cursor = includeAudio === true ? Math.min(state.videoCursor, state.audioCursor) : state.videoCursor;
    output.seenKeyFrame = state.seenKeyFrame;
    output.sentCodecConfig = state.sentCodecConfig;
    output.catchingUp = state.catchingUp;
    output.sourceBaseTime = state.sourceBaseTime;
    output.wallclockBaseTime = state.wallclockBaseTime;
    output.catchupTicks = state.catchupTicks;
    output.catchupStableFrames = state.catchupStableFrames;
  }

  #processOutput(dateNow, budgetMs) {
    let timeline = this.#timeline;
    let itemsLength = 0;
    let hasOutputs = false;
    let cutoffTime = 0;
    let trimCount = 0;
    let oldestProtectedCursor = this.#itemIndex;
    let fallbackFrame = undefined;
    let output = undefined;

    if (timeline instanceof MediaTimeline !== true) {
      return;
    }

    itemsLength = typeof timeline.size === 'number' ? timeline.size : 0;
    hasOutputs = this.#outputs.size !== 0;

    // Determine if timeline contains items older than retention window.
    if (itemsLength !== 0) {
      cutoffTime = dateNow - this.#bufferDuration;

      // Find the earliest protected cursor across all outputs.
      // This represents the oldest item still needed by any active stream.
      oldestProtectedCursor = timeline.protectedStart(this.#outputs);

      // Trim expired media while respecting the oldest protected output cursor.
      trimCount = timeline.trim(cutoffTime, oldestProtectedCursor);

      if (trimCount !== 0) {
        // Only record timeline trimming stats when support dump is enabled.
        // This avoids unnecessary per-output stat updates on the hot path.
        if (this.supportDump === true) {
          for (output of this.#outputs.values()) {
            if (typeof output.stats === 'object' && output.stats !== null) {
              // Ensure drops structure exists and record trimmed items.
              this.#ensureOutputDrops(output.stats).bufferTrimmed += trimCount;
            }
          }
        }

        itemsLength -= trimCount;
      }
    }

    // No outputs attached means we only need retention maintenance this tick.
    if (hasOutputs !== true) {
      return;
    }

    // If fallback is not due and the source is not ready, there is nothing to fan out yet.
    if (this.#transport?.ready !== true && dateNow - this.#lastFallbackFrameTime < STREAM_FRAME_INTERVAL) {
      return;
    }

    if (dateNow - this.#lastFallbackFrameTime >= STREAM_FRAME_INTERVAL) {
      if (this.online === false && Buffer.isBuffer(this.#cameraFrames.offline) === true) {
        fallbackFrame = this.#cameraFrames.offline;
      }

      if (
        fallbackFrame === undefined &&
        this.online === true &&
        this.videoEnabled === false &&
        Buffer.isBuffer(this.#cameraFrames.off) === true
      ) {
        fallbackFrame = this.#cameraFrames.off;
      }

      if (fallbackFrame === undefined && this.migrating === true && Buffer.isBuffer(this.#cameraFrames.transfer) === true) {
        fallbackFrame = this.#cameraFrames.transfer;
      }

      if (Buffer.isBuffer(fallbackFrame) === true) {
        for (output of this.#outputs.values()) {
          this.#writeFallback(output, fallbackFrame, dateNow);
        }

        this.#lastFallbackFrameTime = dateNow;
        return;
      }
    }

    if (this.#transport?.ready !== true) {
      // Source is not ready and no fallback was sent, so there is nothing to fan out this tick.
      return;
    }

    for (output of this.#outputs.values()) {
      this.#processBufferedOutput(output, dateNow, budgetMs);
    }
  }

  #outputStats(output, dateNow) {
    let outputStats = typeof output?.stats === 'object' && output.stats !== null ? output.stats : undefined;
    let outputWrites = typeof outputStats?.writes === 'object' && outputStats.writes !== null ? outputStats.writes : undefined;
    let outputDrops = typeof outputStats?.drops === 'object' && outputStats.drops !== null ? outputStats.drops : undefined;
    let diagnostics =
      typeof outputStats?.diagnostics === 'object' && outputStats.diagnostics !== null ? outputStats.diagnostics : undefined;
    let lifecycleStats = this.#transport?.stats?.lifecycle;
    let mediaStats = this.#transport?.stats?.media;
    let timelineStats = this.#timeline?.stats;
    let video = this.#transport?.video;
    let audio = this.#transport?.audio;

    let elapsed = (start, end) => (typeof start === 'number' && typeof end === 'number' ? end - start + 'ms' : '-');

    let age = (time) => {
      if (typeof time !== 'number') {
        return '-';
      }

      return dateNow - time < 1000 ? '<1s' : Math.floor((dateNow - time) / 1000) + 's';
    };

    this?.log?.info?.(
      'Support dump for device uuid "%s" data will be logged below for troubleshooting purposes.',
      this.nest_google_device_uuid,
    );
    this?.log?.info?.('  {');
    this?.log?.info?.('    "startup": {');
    this?.log?.info?.('      "connect": "%s"', elapsed(lifecycleStats?.connectingAt, lifecycleStats?.connectedAt));
    this?.log?.info?.('      "ready": "%s"', elapsed(lifecycleStats?.connectingAt, lifecycleStats?.readyAt));
    this?.log?.info?.('      "video": "%s"', elapsed(lifecycleStats?.connectingAt, mediaStats?.firstVideoAt));
    this?.log?.info?.('      "audio": "%s"', elapsed(lifecycleStats?.connectingAt, mediaStats?.firstAudioAt));
    this?.log?.info?.('      "keyframe": "%s"', elapsed(lifecycleStats?.connectingAt, mediaStats?.firstKeyframeAt));
    this?.log?.info?.('    },');
    this?.log?.info?.('    "duration": {');
    this?.log?.info?.(
      '      "transport": "%s"',
      typeof lifecycleStats?.connectedAt === 'number' ? Math.round((dateNow - lifecycleStats.connectedAt) / 1000) + 's' : '-',
    );
    this?.log?.info?.(
      '      "output": "%s"',
      typeof outputStats?.startedAt === 'number' ? Math.round((dateNow - outputStats.startedAt) / 1000) + 's' : '-',
    );
    this?.log?.info?.('    },');
    this?.log?.info?.('    "video": {');
    this?.log?.info?.('      "codec": "%s"', video?.codec ?? 'unknown');
    this?.log?.info?.(
      '      "resolution": "%s"',
      typeof video?.width === 'number' && typeof video?.height === 'number' ? video.width + 'x' + video.height : 'waiting for video…',
    );
    this?.log?.info?.('      "fps": %s', typeof video?.fps === 'number' ? Math.round(video.fps) : 'null');
    this?.log?.info?.('      "bitrate": %s', typeof video?.bitrate === 'number' ? video.bitrate : 'null');
    this?.log?.info?.('    },');
    this?.log?.info?.('    "audio": {');
    this?.log?.info?.('      "codec": "%s"', audio?.codec ?? 'unknown');
    this?.log?.info?.('      "sampleRate": %s', typeof audio?.sampleRate === 'number' ? audio.sampleRate : 'null');
    this?.log?.info?.('      "channels": %s', typeof audio?.channels === 'number' ? audio.channels : 'null');
    this?.log?.info?.('      "bitrate": %s', typeof audio?.bitrate === 'number' ? audio.bitrate : 'null');
    this?.log?.info?.('      "frameDuration": %s', typeof audio?.frameDuration === 'number' ? Math.round(audio.frameDuration) : 'null');
    this?.log?.info?.('    },');
    this?.log?.info?.('    "media": {');
    this?.log?.info?.('      "videoFrames": %s', mediaStats?.videoFrames ?? 0);
    this?.log?.info?.('      "audioFrames": %s', mediaStats?.audioFrames ?? 0);
    this?.log?.info?.('      "keyframes": %s', mediaStats?.keyframes ?? 0);
    this?.log?.info?.('    },');
    this?.log?.info?.('    "timeline": {');
    this?.log?.info?.('      "startIndex": %s', timelineStats?.startIndex ?? 0);
    this?.log?.info?.('      "nextIndex": %s', timelineStats?.nextIndex ?? 0);
    this?.log?.info?.('      "size": %s', timelineStats?.size ?? 0);
    this?.log?.info?.('      "videoIndexes": %s', timelineStats?.videoIndexes ?? 0);
    this?.log?.info?.('      "audioIndexes": %s', timelineStats?.audioIndexes ?? 0);
    this?.log?.info?.('      "keyframeIndexes": %s', timelineStats?.keyframeIndexes ?? 0);
    this?.log?.info?.('    },');
    this?.log?.info?.('    "transportDiagnostics": {');
    this?.log?.info?.('      "maxVideoGapMs": %s', mediaStats?.maxVideoGapMs ?? 0);
    this?.log?.info?.('      "maxAudioGapMs": %s', mediaStats?.maxAudioGapMs ?? 0);
    this?.log?.info?.('      "largeAudioGaps": %s', mediaStats?.largeAudioGaps ?? 0);
    this?.log?.info?.('    },');
    this?.log?.info?.('    "drops": {');
    this?.log?.info?.('      "videoBeforeKeyframe": %s', outputDrops?.videoBeforeKeyframe ?? 0);
    this?.log?.info?.('      "audioBeforeKeyframe": %s', outputDrops?.audioBeforeKeyframe ?? 0);
    this?.log?.info?.('      "bufferTrimmed": %s', outputDrops?.bufferTrimmed ?? 0);
    this?.log?.info?.('    },');
    this?.log?.info?.('    "output": {');
    this?.log?.info?.('      "startup": {');
    this?.log?.info?.('        "firstWrite": "%s"', elapsed(outputStats?.startedAt, outputStats?.firstWriteAt));
    this?.log?.info?.('        "firstVideoWrite": "%s"', elapsed(outputStats?.startedAt, outputStats?.firstVideoWriteAt));
    this?.log?.info?.('        "firstAudioWrite": "%s"', elapsed(outputStats?.startedAt, outputStats?.firstAudioWriteAt));
    this?.log?.info?.('      },');
    this?.log?.info?.('      "writes": {');
    this?.log?.info?.('        "total": %s', outputWrites?.total ?? 0);
    this?.log?.info?.('        "video": %s', outputWrites?.video ?? 0);
    this?.log?.info?.('        "audio": %s', outputWrites?.audio ?? 0);
    this?.log?.info?.('      },');
    this?.log?.info?.('      "diagnostics": {');
    this?.log?.info?.('        "maxVideoWriteGapMs": %s', diagnostics?.maxVideoWriteGapMs ?? 0);
    this?.log?.info?.('        "maxAudioWriteGapMs": %s', diagnostics?.maxAudioWriteGapMs ?? 0);
    this?.log?.info?.('        "audioWriteGapsOver100Ms": %s', diagnostics?.audioWriteGapsOver100Ms ?? 0);
    this?.log?.info?.('        "audioWriteGapsOver250Ms": %s', diagnostics?.audioWriteGapsOver250Ms ?? 0);
    this?.log?.info?.('        "audioWriteGapsOver500Ms": %s', diagnostics?.audioWriteGapsOver500Ms ?? 0);
    this?.log?.info?.('        "audioBlockedBehindVideo": %s', diagnostics?.audioBlockedBehindVideo ?? 0);
    this?.log?.info?.('        "maxBlockedAudioLagMs": %s', diagnostics?.maxBlockedAudioLagMs ?? 0);
    this?.log?.info?.('      },');
    this?.log?.info?.('    },');
    this?.log?.info?.('    "last": {');
    this?.log?.info?.('      "video": "%s"', age(mediaStats?.lastVideoAt));
    this?.log?.info?.('      "audio": "%s"', age(mediaStats?.lastAudioAt));
    this?.log?.info?.('      "keyframe": "%s"', age(mediaStats?.lastKeyframeAt));
    this?.log?.info?.('    },');
    this?.log?.info?.('    "reconnects": %s', lifecycleStats?.reconnects ?? 0);
    this?.log?.info?.('  }');
    this?.log?.info?.('End of support dump for device uuid "%s" data.', this.nest_google_device_uuid);
  }

  static #start() {
    if (this.#timer !== undefined) {
      return;
    }

    this.#timer = setInterval(() => {
      let dateNow = Date.now();
      let streamers = this.#streamers;
      let removals = [];
      let shouldCheckBudget = false;
      let streamerStartTime = 0;
      let streamerElapsed = 0;
      let streamerBudget = Math.max(2, Math.floor(OUTPUT_LOOP_INTERVAL / Math.max(streamers.size, 1)));

      for (let streamer of streamers.values()) {
        try {
          if (streamer.hasActiveStreams() === false) {
            streamer.#outputErrors = 0;
            continue;
          }

          shouldCheckBudget = dateNow - streamer.#lastBudgetLogTime >= OUTPUT_BUDGET_LOG_INTERVAL;

          if (shouldCheckBudget === true) {
            streamer.#lastBudgetLogTime = dateNow;
            streamerStartTime = Date.now();
          }

          streamer.#processOutput(dateNow, streamerBudget);
          streamer.#outputErrors = 0;
          if (shouldCheckBudget === true) {
            streamerElapsed = Date.now() - streamerStartTime;
          }

          if (shouldCheckBudget === true && streamerElapsed > streamerBudget) {
            streamer?.log?.debug?.(
              'Output processing budget exceeded for device uuid "%s" (%sms > %sms)',
              streamer?.nest_google_device_uuid,
              streamerElapsed,
              streamerBudget,
            );
          }
        } catch (error) {
          streamer.#outputErrors++;
          streamer?.log?.error?.('Output processing error for device uuid "%s": %s', streamer?.nest_google_device_uuid, String(error));

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

      if (streamers.size === 0) {
        clearInterval(this.#timer);
        this.#timer = undefined;
      }
    }, OUTPUT_LOOP_INTERVAL);
  }

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

  static #removeStreamer(streamer) {
    if (streamer instanceof Streamer === false) {
      return;
    }

    if (typeof streamer.#HomeKitDeviceUUID !== 'string' || streamer.#HomeKitDeviceUUID === '') {
      return;
    }

    this.#streamers.delete(streamer.#HomeKitDeviceUUID);

    if (this.#streamers.size === 0 && this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  #syncSchedulerState() {
    if (this.hasActiveStreams() === true) {
      if (Streamer.#streamers.has(this.#HomeKitDeviceUUID) === false) {
        Streamer.#addStreamer(this);
      }
      return;
    }

    if (Streamer.#streamers.has(this.#HomeKitDeviceUUID) === true) {
      Streamer.#removeStreamer(this);
    }
  }
}
