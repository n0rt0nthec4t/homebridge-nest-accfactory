// Streamer
// Part of homebridge-nest-accfactory
//
// Shared media retention, scheduling and output ownership for cameras and doorbells.
// WebRTC and NexusTalk provide complete source frames; each live or recording
// receiver has its own RTPMuxer, FFmpeg handles, track cursors and decoder state.
//
// Responsibilities:
// - Connect or retire the source according to output and prebuffer demand
// - Retain raw H264 NAL groups and native encoded audio once in MediaTimeline
// - Keep preparing and active outputs in one registry with exact-owner cancellation
// - Schedule each receiver with a fresh work budget and fixed 300 ms A/V headroom
// - Wake delivery on incoming media, RTSP PLAY and socket drain
// - Bootstrap video from an IDR and its matching SPS/PPS configuration
// - Own output FFmpeg processes, RTP endpoints and optional talkback forwarding
// - Supply fallback video while offline, disabled or migrating
// - Collect output diagnostics only when FFmpeg debugging is enabled
//
// Retention and timing:
// - MediaTimeline holds independent bounded video/audio rings with stable indexes
// - Outputs cannot protect expired media; lagging video recovers at the next IDR
// - Live outputs attach at the live edge; recordings seek the requested source time
// - A recording drains its captured startup range in A/V source-time order
// - Fractional source timestamps remain independent of delivery deadlines
// - Source generations reset retained state and seed RTPMuxer's common A/V offset
// - Accepted writes advance their cursors even when the receiver then blocks
//
// Ownership:
// - STOP, abort and shutdown close the exact output's endpoints and processes
// - Late completion cannot tear down a replacement or another viewer/recording
// - The source remains connected while outputs or prebuffering still need it
// - Protocol signalling, packet reordering and frame assembly remain in the source
// - FFmpeg owns command construction and the bounded MP4 fragment reader
//
// Code version 2026.10.26
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import { setTimeout, clearTimeout } from 'node:timers';
import fs from 'fs';
import path from 'node:path';
import { PassThrough } from 'stream';

// Define our modules
import HomeKitDevice from '../../HomeKitDevice.js';
import MediaTimeline from './mediatimeline.js';
import StreamTransport from './streamtransport.js';
import H264 from './h264.js';
import RTPMuxer from './rtpmuxer.js';

// Define constants
import { TIMERS, RESOURCE_FRAMES, RESOURCE_PATH, LOG_LEVELS, __dirname } from '../../consts.js';

const MAX_BUFFERED_ITEMS_PER_OUTPUT_PER_TICK = 20; // Prevent one output starving others
const STREAM_FRAME_INTERVAL = 1000 / 30; // 30fps approx
const OUTPUT_PLAYOUT_DELAY_MS = 300; // Fixed A/V headroom for bursty source delivery

// Initial capacity is per track; the retained-item limit is shared across both.
const STREAMER_INITIAL_BUFFER_CAPACITY = 1024;
const STREAMER_MAX_BUFFER_CAPACITY = 8192;
const STREAMER_AUDIO_GAP_LOG_MS = 120; // FFmpeg-debug audio gap threshold for clearly audible source/output pauses
const STREAMER_AUDIO_GAP_LOG_INTERVAL_MS = 30000; // Throttle targeted audio gap diagnostics
const STREAMER_AV_CORRELATION_WINDOW_MS = 750; // Correlate audio gaps with nearby accepted keyframes

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
  static #due = Infinity;
  static #timer = undefined; // Shared timer for all active streamers

  ffmpegDebug = false; // Enable bounded media diagnostics and per-output close summaries
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
  #outputs = new Map(); // Preparing and active outputs; exact records own setup and playback
  #cameraFrames = {}; // H264 resource frames for offline, video off, transferring
  #generation = 0; // Identifies a source clock epoch across reconnects
  #waitingForKeyframe = false; // Decoder recovery after a rejected source timestamp
  #lastFallbackFrameTime = 0; // Timer for pacing fallback frames
  #rotation = 0; // Rotate the first receiver serviced on each scheduling turn
  #lastMediaTime = {}; // Track last buffered media time per type for fallback ordering guards
  #lastKeyframeAt = undefined; // Last accepted keyframe arrival at Streamer
  #fallbackAudio = undefined; // Shared normalized silence, keyed by source buffer and codec
  #lastKeyframeBytes = undefined; // Size of last accepted keyframe
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
    if (Object.values(LOG_LEVELS).every((fn) => typeof options?.log?.[fn] === 'function') === true) {
      this.log = options.log;
    }

    this.#HomeKitDeviceUUID = uuid;

    HomeKitDevice.message(uuid, Streamer.MESSAGE, this);
    HomeKitDevice.message(uuid, HomeKitDevice.UPDATE, this);
    HomeKitDevice.message(uuid, HomeKitDevice.TIMER, this);

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

        // Parse bundled access units once, retaining all SPS/PPS and picture NALs.
        // Removing only the first start code would hide their later boundaries.
        buffer = H264.getNALUnits(buffer).map((nal) => nal.data);
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
    this.ffmpegDebug = options?.ffmpegDebug === true;

    // Setup retained media buffer duration.
    // Clamp to sane bounds to avoid invalid or excessive retention sizes.
    this.#bufferDuration =
      Number.isInteger(options?.bufferDuration) === true && options.bufferDuration > 0
        ? Math.min(Math.max(options.bufferDuration, 2000), 15000)
        : 5000;

    // Attach the source transport (WebRTC / NexusTalk).
    // Transport owns protocol connection, media parsing and state.
    // Streamer owns buffering, pacing, fan-out and HomeKit stream handling.
    if (options?.transport instanceof StreamTransport) {
      this.#transport = options.transport;

      // Wire transport callbacks into Streamer.
      // Media and lifecycle events flow through this interface.
      this.#transport.consumer = {
        // Incoming media from transport.
        media: (media) => {
          this.#retainMedia(media);
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
      // Buffering owns source demand without creating a receiver output.
      this.#timeline ??= new MediaTimeline(0, STREAMER_INITIAL_BUFFER_CAPACITY, STREAMER_MAX_BUFFER_CAPACITY);
      this.#bufferEnabled = true;
      this.log?.debug?.('Started buffering from device uuid "%s"', this.nest_google_device_uuid);
      this.#syncSchedulerState();
      await this.#doConnect(options ?? {});
      return;
    }

    if (type === Streamer.MESSAGE_TYPE.STOP_BUFFER) {
      if (this.#bufferEnabled !== true) {
        return;
      }

      this.#bufferEnabled = false;
      this.log?.debug?.('Stopped buffering from device uuid "%s"', this.nest_google_device_uuid);

      // Live and preparing outputs retain source ownership after buffering stops.
      if (this.#outputs.size === 0) {
        this.#resetRetainedState();
        this.#syncSchedulerState();
        await this.#doClose();
        return;
      }

      this.#syncSchedulerState();
      return;
    }

    if (type === Streamer.MESSAGE_TYPE.START_LIVE) {
      // Start a live streaming output for HomeKit.
      // Each live or recording output owns one independent RTP endpoint.
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

  async stopEverything() {
    let stopped = [];

    // Capture active work before cleanup so the shutdown log reflects what
    // was actually running, rather than always claiming every mode was active.
    if (this.isBuffering() === true) {
      stopped.push('buffering');
    }

    if (this.isLiveStreaming() === true) {
      stopped.push('live');
    }

    if (this.isRecording() === true) {
      stopped.push('recording');
    }

    if (stopped.length > 0) {
      this?.log?.debug?.('Stopped %s from device uuid "%s"', stopped.join(', '), this.nest_google_device_uuid);
    }

    // Detach every owner before any close can yield or finish pending setup.
    let outputs = [...this.#outputs.values()];
    this.#outputs.clear();
    let closingOutputs = outputs.map((output) => {
      output.state = 'closing';
      output.signal?.removeEventListener('abort', output.abort);
      output.closing = this.#cleanupOutput(output);
      output.callback?.();
      return output.closing;
    });

    this.#resetRetainedState();

    // Full teardown owns scheduler cleanup directly. Normal start/stop paths
    // still use #syncSchedulerState() as outputs/buffering change incrementally.
    Streamer.#removeStreamer(this);

    // Queue transport teardown before awaiting muxer closure, so replacement
    // source acquisition cannot overtake shutdown of the previous owner.
    const closingSource = this.#queueLifecycle(async () => {
      this.#resetSourceState();
      await this.#transport?.close?.();
      await this.#transport?.shutdown?.();
    });
    await Promise.all([...closingOutputs, closingSource]);
  }

  #retainMedia(media) {
    let mediaType = undefined;
    let codec = undefined;
    let now = Date.now();
    let data = undefined;
    let keyFrame = false;

    // StreamTransport has validated and normalized this complete frame. This
    // private consumer only owns retention and per-output playout protection.
    mediaType = media.type;
    keyFrame = media.keyFrame;
    codec = media.codec;

    // Do not process if no active outputs or retained buffer.
    if (this.hasActiveStreams() !== true) {
      return;
    }

    data = media.data;

    // Ensure shared media timeline exists before proceeding.
    this.#timeline ??= new MediaTimeline(0, STREAMER_INITIAL_BUFFER_CAPACITY, STREAMER_MAX_BUFFER_CAPACITY);

    if (mediaType === Streamer.MEDIA_TYPE.VIDEO && keyFrame === true) {
      this.#lastKeyframeAt = now;
      this.#lastKeyframeBytes = media.bytes;
    }
    // Presentation time belongs to the transport. Never advance one track using
    // an estimated frame duration: doing so changes its relationship to the other.
    if (media.timestamp <= this.#lastMediaTime[mediaType]) {
      if (mediaType === Streamer.MEDIA_TYPE.VIDEO) {
        this.#waitingForKeyframe = true;
        this.#transport.recordVideoDrop('non-increasing-timestamp');
      }
      return;
    }

    // A discarded H264 frame may be referenced by later deltas. Retain only a
    // new decoder-safe keyframe after a timestamp fault, without retiming it.
    if (mediaType === Streamer.MEDIA_TYPE.VIDEO && this.#waitingForKeyframe === true) {
      if (keyFrame !== true) {
        this.#transport.recordVideoDrop('timestamp-recovery');
        return;
      }
      this.#waitingForKeyframe = false;
    }
    if (mediaType === Streamer.MEDIA_TYPE.AUDIO) {
      try {
        // Parse once for every retained batch, not once for each live/recording
        // receiver. Keep the batch together so its complete-unit bounds survive.
        data = RTPMuxer.normalizeAudio(data, codec);
      } catch (error) {
        this.log?.debug?.('Invalid source audio for device uuid "%s": %s', this.nest_google_device_uuid, String(error));
        for (let output of this.#outputs.values()) {
          if (output.muxer?.hasAudio === true) {
            this.#stopOutput(output.sessionID, output.type, output, error).catch((failure) =>
              this.log?.error?.('Media cleanup failed: %s', String(failure)),
            );
          }
        }
        return;
      }
    }
    this.#lastMediaTime[mediaType] = media.timestamp;

    // Retention is bounded independently of consumers. A lagging output must
    // recover at the current window instead of protecting expired media forever.
    this.#timeline.trim(Math.max(this.#lastMediaTime.video ?? -Infinity, this.#lastMediaTime.audio ?? -Infinity) - this.#bufferDuration);
    this.#timeline.add({
      type: mediaType,
      codec,
      time: media.timestamp,
      keyFrame,
      nals: media.nals,
      data,
      bytes: media.bytes,
      config: media.config,
      hasSPS: media.hasSPS,
      hasPPS: media.hasPPS,
    });
    if (mediaType === Streamer.MEDIA_TYPE.AUDIO && codec === StreamTransport.CODEC_TYPE.AAC) {
      for (let output of this.#outputs.values()) {
        if (output.muxer?.needsAudioConfig === true) {
          output.muxer.configureAudio(data);
        }
      }
    }
    if (this.isStreaming() === true) {
      Streamer.#wake();
    }
  }

  async #createOutput(sessionID, type, options) {
    if (typeof sessionID !== 'string' || sessionID === '') {
      return;
    }

    let existing = this.#outputs.get(sessionID);
    // Recording is singular even while its RTP endpoint is being prepared.
    if (type === Streamer.STREAM_TYPE.RECORD && existing === undefined) {
      for (let candidate of this.#outputs.values()) {
        if (candidate.type === type) {
          existing = candidate;
          break;
        }
      }
    }
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
      return await existing.promise;
    }

    // One record owns both setup and playback. Preparing consumers hold source
    // demand, but never enter media delivery scheduling.
    let output = {
      sessionID,
      type,
      state: 'preparing',
      promise: undefined,
      muxer: undefined,
      processes: new Set(),
      closing: undefined,
      callback: options?.onClose,
      signal: options?.signal,
      abort: undefined,
      fragments: undefined,
    };
    this.#outputs.set(sessionID, output);
    if (output.signal !== undefined) {
      output.abort = () => this.#stopOutput(sessionID, type, output);
      output.signal.addEventListener('abort', output.abort, { once: true });
      if (output.signal.aborted === true) {
        await output.abort();
        return;
      }
    }

    output.promise = this.#buildOutput(output, options);

    try {
      return await output.promise;
    } catch (error) {
      if (this.#outputs.get(sessionID) === output) {
        await this.#stopOutput(sessionID, type);
      } else {
        // Cancellation already relinquished ownership; only finish local cleanup.
        await output.muxer?.close();
      }
      throw error;
    }
  }

  async #buildOutput(output, options) {
    let { sessionID, type } = output;
    let muxer = undefined;
    let talkback = null;
    let includeAudio = options?.includeAudio === true && this.audioEnabled === true;
    let waitForReady = Number.isInteger(options?.waitForReady) === true ? options.waitForReady : 0;
    let timeline = undefined;
    let recordTime = options?.recordTime;
    let startTime = Date.now();

    // Ensure retained timeline exists and start/connect source if needed.
    this.#timeline ??= new MediaTimeline(0, STREAMER_INITIAL_BUFFER_CAPACITY, STREAMER_MAX_BUFFER_CAPACITY);
    await this.#doConnect(options);
    timeline = this.#timeline;

    if (timeline instanceof MediaTimeline !== true || this.#outputs.get(sessionID) !== output) {
      return;
    }

    // RTPMuxer owns delivery and wire clocks; this record owns its preparation.
    muxer = new RTPMuxer({
      includeAudio,
      audio: this.#transport?.audio,
      audioDiagnostics: this.ffmpegDebug === true,
      onReady: () => Streamer.#wake(),
      onClose: (error) => {
        this.#stopOutput(sessionID, type, output, error).catch((failure) =>
          this.log?.error?.('Media output cleanup failed: %s', String(failure)),
        );
      },
      audioControl: type === Streamer.STREAM_TYPE.LIVE && includeAudio === true,
      talkback: type === Streamer.STREAM_TYPE.LIVE && includeAudio === true ? options?.talkback : undefined,
    });
    output.muxer = muxer;
    await muxer.prepare();

    if (this.#outputs.get(sessionID) !== output) {
      await muxer.close();
      return;
    }
    if (muxer.needsAudioConfig === true) {
      let firstAudio = timeline.get('audio', timeline.start('audio'));
      if (firstAudio !== undefined) {
        muxer.configureAudio(firstAudio.data);
      }
    }
    if (muxer.error !== undefined) {
      throw muxer.error;
    }
    talkback = type === Streamer.STREAM_TYPE.LIVE && includeAudio === true ? new PassThrough({ highWaterMark: 1024 * 16 }) : null;

    // Prevent unhandled stream errors from bubbling.
    talkback?.on?.('error', () => {});

    // Each receiver owns its cursors and one common A/V clock. Recording can
    // drain the retained startup range before normal timed delivery begins.
    Object.assign(output, {
      // Delivery belongs to this output; only talkback remains a byte stream.
      talkback: talkback,
      talkbackTimeout: undefined,

      // Whether audio should be written for this output.
      includeAudio: includeAudio,

      // Each consumer follows bounded track indexes. Eviction never waits for a slow receiver.
      videoCursor: type === Streamer.STREAM_TYPE.RECORD ? timeline.seek('video', recordTime ?? -Infinity) : timeline.end('video'),
      audioCursor: type === Streamer.STREAM_TYPE.RECORD ? timeline.seek('audio', recordTime ?? -Infinity) : timeline.end('audio'),
      prebufferEnd: type === Streamer.STREAM_TYPE.RECORD ? { video: timeline.end('video'), audio: timeline.end('audio') } : {},
      generation: undefined,

      // Codec / decoder state tracking.
      config: undefined, // Decoder configuration last delivered to this receiver
      seenKeyFrame: false, // first keyframe seen

      // Time mapping for paced playback:
      // wallclockTime = wallclockBaseTime + (item.time - sourceBaseTime)
      sourceBaseTime: undefined,
      wallclockBaseTime: undefined,

      // Debug instrumentation is not allocated for normal streaming.
      stats:
        this.ffmpegDebug === true
          ? {
              startedAt: startTime,
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
                videoBackpressureStops: 0,
                maxQueuedBytes: 0,
                lastAudioDiagnosticLogTime: undefined,
              },
            }
          : undefined,
    });
    output.state = 'active';

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

    // Only fully prepared records participate in delivery scheduling.
    this.#syncSchedulerState();

    // Optionally wait for source readiness before returning stream handles.
    if (waitForReady > 0) {
      while (Date.now() - startTime < waitForReady) {
        if (this.#outputs.get(sessionID) !== output) {
          return;
        }
        if (this.#transport?.ready === true || this.#transport?.closed === true || this.#transport?.reconnecting === true) {
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    this?.log?.debug?.('Started %s stream from device uuid "%s" and session id "%s"', type, this.nest_google_device_uuid, sessionID);

    return Object.freeze({
      start: (manager, requirements) => {
        // Start through the output so process completion retires this exact owner.
        if (this.#outputs.get(sessionID) !== output || output.processes.size > 0) {
          throw new Error('Media output is closed or already started');
        }

        let settings = { ...requirements, id: sessionID, input: muxer.input, ports: muxer.ports, talkback };
        let handles = type === Streamer.STREAM_TYPE.RECORD ? [manager.startRecording(settings)] : manager.startLive(settings);
        output.fragments = type === Streamer.STREAM_TYPE.RECORD ? () => manager.fragments(handles[0], output.signal) : undefined;

        for (let [index, handle] of handles.entries()) {
          output.processes.add(handle);
          handle.finished
            .then((result) => {
              if (result.expected !== true && this.#outputs.get(sessionID) === output) {
                let reason =
                  result.error ??
                  new Error('FFmpeg ' + (index === 1 ? 'talkback' : type) + ' exited: ' + (result.code ?? result.signal ?? result.state));
                if (handle.diagnosticLines.length > 0) {
                  reason.message += ' (' + handle.diagnosticLines.join(' | ') + ')';
                }
                return this.#stopOutput(sessionID, type, output, reason);
              }
            })
            .catch((error) => this.log?.error?.('FFmpeg output completion failed: %s', String(error)));
        }
      },
      fragments: () => output.fragments(),
      stop: () => this.#stopOutput(sessionID, type, output),
    });
  }

  async #stopOutput(sessionID, type, owner = undefined, error = undefined) {
    let output = owner ?? this.#outputs.get(sessionID);
    if (output?.closing !== undefined) {
      return output.closing;
    }
    if (output === undefined && type === Streamer.STREAM_TYPE.RECORD) {
      for (let candidate of this.#outputs.values()) {
        if (candidate.type === type) {
          output = candidate;
          break;
        }
      }
    }
    if (output === undefined) {
      if (this.#outputs.size === 0 && this.#bufferEnabled !== true) {
        await this.#doClose();
      }
      return;
    }
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

    // Remove the exact owner before source retirement, diagnostics or socket
    // closure can yield. A replacement can then safely reuse the same session id.
    if (this.#outputs.get(output.sessionID) !== output) {
      return;
    }
    let wasActive = output.state === 'active';
    this.#outputs.delete(output.sessionID);
    output.state = 'closing';
    let closingSource = undefined;
    if (wasActive === false && this.#outputs.size === 0 && this.#bufferEnabled !== true) {
      // Queue this before awaiting socket closure so a replacement's source open
      // cannot be overtaken by the old owner's delayed cleanup.
      closingSource = this.#doClose();
    }
    this.#syncSchedulerState();
    output.signal?.removeEventListener('abort', output.abort);
    // Repeated stops await the entire teardown, including source retirement and
    // final diagnostics. Assign ownership before callbacks can re-enter stop.
    output.closing = Promise.resolve().then(async () => {
      let closingOutput = this.#cleanupOutput(output);
      output.callback?.(error);
      this?.log?.debug?.(
        'Stopping %s stream from device uuid "%s" and session id "%s"',
        type,
        this.nest_google_device_uuid,
        output.sessionID,
      );
      let results = await Promise.all([closingOutput, closingSource]);
      if (wasActive === true && output.stats !== undefined) {
        this.#outputStats(output, Date.now(), results[0].slice(1), error);
      }
      if (this.#outputs.size === 0 && this.#bufferEnabled !== true) {
        // Preserve retained statistics until final diagnostics finish, and retain
        // the source if a replacement took ownership during asynchronous closure.
        this.#resetRetainedState();
        if (closingSource === undefined) {
          await this.#doClose();
        }
      }
    });
    return await output.closing;
  }

  isBuffering() {
    return this.#bufferEnabled === true;
  }

  isStreaming() {
    for (let output of this.#outputs.values()) {
      if (output.state === 'active') {
        return true;
      }
    }
    return false;
  }

  isRecording() {
    for (let output of this.#outputs.values()) {
      if (output.state === 'active' && output.type === Streamer.STREAM_TYPE.RECORD) {
        return true;
      }
    }

    return false;
  }

  isLiveStreaming() {
    for (let output of this.#outputs.values()) {
      if (output.state === 'active' && output.type === Streamer.STREAM_TYPE.LIVE) {
        return true;
      }
    }

    return false;
  }

  hasActiveStreams() {
    // Source demand includes preparing consumers; playback queries above count
    // only active records so pending endpoints cannot enter delivery scheduling.
    return this.#bufferEnabled === true || this.#outputs.size !== 0;
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

      if (typeof this.#transport?.open === 'function') {
        await this.#transport.open(this.#connectOptions);
      }
    });
  }

  async #doClose() {
    return await this.#queueLifecycle(async () => {
      this.#resetSourceState();

      if (typeof this.#transport?.close === 'function') {
        await this.#transport.close();
      }
    });
  }

  #cleanupOutput(output) {
    if (typeof output !== 'object' || output === null) {
      return;
    }

    clearTimeout(output?.talkbackTimeout);
    output?.talkback?.removeAllListeners?.();
    output?.talkback?.end?.();
    for (let process of output.processes) {
      process.stop('SIGKILL');
    }
    return Promise.all([output.muxer?.close(), ...[...output.processes].map((process) => process.finished)]);
  }

  #resetRetainedState() {
    this.#bufferEnabled = false;
    this.#timeline = undefined;

    this.#waitingForKeyframe = false;
    this.#lastMediaTime = {};
    this.#generation++;
  }

  #resetSourceState() {
    this.#waitingForKeyframe = false;
    this.#lastMediaTime = {};
    this.#generation++;
    this.#timeline?.clear();

    // Reset fallback data and output-gap context for the new source session.
    this.#fallbackAudio = undefined;
    this.#lastKeyframeAt = undefined;
    this.#lastKeyframeBytes = undefined;

    // A transport reconnect means a new encoded media session.
    // Existing HomeKit outputs may still be open, but their decoder state must
    // be reset so the next real H264 keyframe can be bootstrapped again.
    for (let output of this.#outputs.values()) {
      if (output.state !== 'active') {
        continue;
      }
      output.seenKeyFrame = false;
      output.sourceBaseTime = undefined;
      output.wallclockBaseTime = undefined;
      output.prebufferEnd = {};

      // Move active outputs to the current live edge.
      // This avoids replaying stale pre-offline media after fallback frames.
      output.videoCursor = this.#timeline?.end('video') ?? 0;
      output.audioCursor = this.#timeline?.end('audio') ?? 0;
    }
  }

  #statsWrite(output, type, dateNow) {
    if (output.stats === undefined) {
      return;
    }

    // Active outputs initialise this complete record once during setup.
    let outputStats = output.stats;
    let outputWrites = outputStats.writes;
    let diagnostics = outputStats.diagnostics;
    let gapMs = 0;
    let keyframeAgeMs = undefined;

    outputStats.firstWriteAt ??= dateNow;

    // Both media tracks share one TCP queue. Sample after each accepted media
    // write so video-only outputs are covered without duplicating audio checks.
    diagnostics.maxQueuedBytes = Math.max(diagnostics.maxQueuedBytes, output.muxer.queuedBytes());
    outputWrites.total++;

    if (type === Streamer.MEDIA_TYPE.VIDEO) {
      outputStats.firstVideoWriteAt ??= dateNow;
      outputWrites.video++;
      if (typeof diagnostics.lastVideoWriteAt === 'number') {
        gapMs = dateNow - diagnostics.lastVideoWriteAt;
        diagnostics.maxVideoWriteGapMs = Math.max(diagnostics.maxVideoWriteGapMs, gapMs);
      }
      diagnostics.lastVideoWriteAt = dateNow;
    }

    if (type === Streamer.MEDIA_TYPE.AUDIO) {
      outputStats.firstAudioWriteAt ??= dateNow;
      outputWrites.audio++;
      if (typeof diagnostics.lastAudioWriteAt === 'number') {
        // The summary and throttled log measure the same audio-write interval.
        gapMs = dateNow - diagnostics.lastAudioWriteAt;
        diagnostics.maxAudioWriteGapMs = Math.max(diagnostics.maxAudioWriteGapMs, gapMs);
        if (gapMs > 100) {
          diagnostics.audioWriteGapsOver100Ms++;
        }
        if (gapMs > 250) {
          diagnostics.audioWriteGapsOver250Ms++;
        }
        if (gapMs > 500) {
          diagnostics.audioWriteGapsOver500Ms++;
        }

        if (
          gapMs >= STREAMER_AUDIO_GAP_LOG_MS &&
          (typeof diagnostics.lastAudioDiagnosticLogTime !== 'number' ||
            dateNow - diagnostics.lastAudioDiagnosticLogTime >= STREAMER_AUDIO_GAP_LOG_INTERVAL_MS)
        ) {
          keyframeAgeMs = typeof this.#lastKeyframeAt === 'number' ? dateNow - this.#lastKeyframeAt : undefined;
          diagnostics.lastAudioDiagnosticLogTime = dateNow;

          this?.log?.debug?.(
            'Streamer output audio write gap for device uuid "%s": session="%s" type="%s" gapMs=%s keyframeAgeMs=%s ' + 'keyframeBytes=%s',
            this.nest_google_device_uuid,
            output?.sessionID ?? '-',
            output?.type ?? '-',
            Math.round(gapMs),
            Number.isFinite(keyframeAgeMs) === true && keyframeAgeMs <= STREAMER_AV_CORRELATION_WINDOW_MS ? Math.round(keyframeAgeMs) : '-',
            Number.isFinite(this.#lastKeyframeBytes) === true ? this.#lastKeyframeBytes : '-',
          );
        }
      }
      diagnostics.lastAudioWriteAt = dateNow;
    }
  }

  #writeFallback(output, fallbackFrame, dateNow = undefined) {
    if (Array.isArray(fallbackFrame) !== true || typeof output !== 'object' || output === null) {
      return;
    }
    let muxer = output.muxer;
    let blank = this.#transport?.audio?.blank;
    let codec = this.#transport?.audio?.codec;
    if (
      output.includeAudio === true &&
      Buffer.isBuffer(blank) === true &&
      (this.#fallbackAudio?.source !== blank || this.#fallbackAudio?.codec !== codec)
    ) {
      // Fallback audio is reused across receivers and ticks until its source changes.
      this.#fallbackAudio = { source: blank, codec, batch: RTPMuxer.normalizeAudio(blank, codec) };
    }
    if (muxer.needsAudioConfig === true && Buffer.isBuffer(blank) === true) {
      muxer.configureAudio(this.#fallbackAudio.batch);
    }
    if (typeof dateNow !== 'number') {
      dateNow = Date.now();
    }

    if (muxer.blocked('video') !== true) {
      this.#statsWrite(output, Streamer.MEDIA_TYPE.VIDEO, dateNow);
      muxer.writeVideo(fallbackFrame, dateNow);
    }
    if (
      output.includeAudio === true &&
      muxer.hasAudio === true &&
      muxer.blocked('audio') !== true &&
      Buffer.isBuffer(this.#transport?.audio?.blank) === true
    ) {
      this.#statsWrite(output, Streamer.MEDIA_TYPE.AUDIO, dateNow);
      muxer.writeAudio(this.#fallbackAudio.batch, dateNow);
    }
    muxer.tick(dateNow);
  }

  #processBufferedOutput(output, now) {
    let timeline = this.#timeline;
    let muxer = output.muxer;
    let audioEnabled = output.includeAudio === true && muxer.hasAudio === true;
    let budget = performance.now() + 2;
    let next = 1000;
    let processed = 0;

    // Expired readers rejoin bounded retention instead of pinning older media.
    if (output.videoCursor < timeline.start('video')) {
      output.videoCursor = timeline.start('video');
      output.seenKeyFrame = false;
      if (this.ffmpegDebug === true) {
        output.stats.drops.bufferTrimmed++;
      }
    }

    output.audioCursor = Math.max(output.audioCursor, timeline.start('audio'));
    let video = timeline.get('video', output.videoCursor);
    let audio = audioEnabled === true ? timeline.get('audio', output.audioCursor) : undefined;
    let anchor = Math.min(video?.time ?? Infinity, audio?.time ?? Infinity);
    if (Number.isFinite(anchor) !== true) {
      return 1000;
    }

    if (output.generation !== this.#generation) {
      muxer.setSourceEpoch(anchor, this.#generation);
      output.generation = this.#generation;
    }

    if (output.sourceBaseTime === undefined) {
      output.sourceBaseTime = Math.max(
        this.#lastMediaTime.video ?? anchor,
        audioEnabled === true ? (this.#lastMediaTime.audio ?? anchor) : anchor,
      );
      output.wallclockBaseTime = now + OUTPUT_PLAYOUT_DELAY_MS;
    }

    // Each turn has its own monotonic budget. Commit accepted frames directly;
    // network writes cannot be rolled back by copying cursor state afterward.
    while (
      (video !== undefined || audio !== undefined) &&
      processed < MAX_BUFFERED_ITEMS_PER_OUTPUT_PER_TICK &&
      performance.now() < budget
    ) {
      let dueVideo =
        video === undefined
          ? Infinity
          : video.index < (output.prebufferEnd.video ?? 0)
            ? now
            : output.wallclockBaseTime + video.time - output.sourceBaseTime;
      let dueAudio =
        audio === undefined
          ? Infinity
          : audio.index < (output.prebufferEnd.audio ?? 0)
            ? now
            : output.wallclockBaseTime + audio.time - output.sourceBaseTime;

      next = Math.min(next, Math.max(1, Math.min(dueVideo, dueAudio) - now));
      // Prebuffer frames share a send-now deadline. Merge by source time so
      // video cannot drain first and admit audio from before its starting IDR.
      let useVideo = audio === undefined || (video !== undefined && video.time <= audio.time);
      let item = useVideo === true ? video : audio;
      let type = useVideo === true ? 'video' : 'audio';
      let due = useVideo === true ? dueVideo : dueAudio;
      if (due > now) {
        break;
      }
      if (muxer.blocked(type) === true) {
        // PLAY/drain wakes this receiver; do not spin on an already-due frame.
        return 1000;
      }

      processed++;

      if (useVideo === true) {
        if (output.seenKeyFrame === true || item.keyFrame === true) {
          let bootstrap =
            output.seenKeyFrame === true && output.config === item.config
              ? undefined
              : {
                  sps: item.hasSPS === true ? undefined : item.config?.sps,
                  pps: item.hasPPS === true ? undefined : item.config?.pps,
                };
          let writable = muxer.writeVideo(item.nals, item.time, bootstrap);
          if (writable === false && this.ffmpegDebug === true) {
            output.stats.diagnostics.videoBackpressureStops++;
          }
          output.seenKeyFrame = true;
          output.config = item.config;
          this.#statsWrite(output, type, now);
        } else if (output.stats !== undefined) {
          output.stats.drops.videoBeforeKeyframe++;
        }

        output.videoCursor++;
        video = timeline.get('video', output.videoCursor);
      } else {
        if (output.type !== Streamer.STREAM_TYPE.RECORD || output.seenKeyFrame === true) {
          muxer.writeAudio(item.data, item.time);
          this.#statsWrite(output, type, now);
        } else if (output.stats !== undefined) {
          output.stats.drops.audioBeforeKeyframe++;
        }

        output.audioCursor++;
        audio = timeline.get('audio', output.audioCursor);
      }
    }

    return video !== undefined || audio !== undefined ? next : 1000;
  }

  #processOutput(now) {
    let next = 1000;
    let outputs = [...this.#outputs.values()].filter((output) => output.state === 'active');
    if (outputs.length === 0) {
      return Infinity;
    }
    let first = this.#rotation++ % outputs.length;
    let fallbackSent = false;
    for (let index = 0; index < outputs.length; index++) {
      let output = outputs[(first + index) % outputs.length];
      try {
        if (output.muxer.closed === true) {
          throw output.muxer.error ?? new Error('Media receiver closed');
        }
        let frame =
          this.online === false
            ? this.#cameraFrames.offline
            : this.videoEnabled === false
              ? this.#cameraFrames.off
              : this.migrating === true
                ? this.#cameraFrames.transfer
                : undefined;
        if (frame !== undefined) {
          if (now - this.#lastFallbackFrameTime >= STREAM_FRAME_INTERVAL) {
            this.#writeFallback(output, frame, now);
            fallbackSent = true;
          }
          next = Math.min(next, STREAM_FRAME_INTERVAL);
        } else if (this.#transport.ready === true) {
          next = Math.min(next, this.#processBufferedOutput(output, now));
        }
        output.muxer.tick(now);
      } catch (error) {
        // A failed consumer never stops another live view, recording or the source.
        this.#stopOutput(output.sessionID, output.type, output, error).catch((failure) =>
          this.log?.error?.('Media cleanup failed: %s', String(failure)),
        );
      }
    }
    if (fallbackSent === true) {
      this.#lastFallbackFrameTime = now;
    }
    return next;
  }

  #outputStats(output, dateNow, results, error) {
    let stats = output.stats;
    let diagnostics = stats.diagnostics;

    // These counters belong to this output, including concurrent viewers and
    // recordings. Process outcomes are final because cleanup awaited pipe closure.
    this.log?.debug?.(
      'Media stream summary for device uuid "%s": session="%s" type="%s" %j',
      this.nest_google_device_uuid,
      output.sessionID,
      output.type,
      {
        source: this.#transport?.constructor.name,
        audioCodec: this.#transport?.audio?.codec,
        durationMs: dateNow - stats.startedAt,
        firstVideoMs: stats.firstVideoWriteAt === undefined ? undefined : stats.firstVideoWriteAt - stats.startedAt,
        firstAudioMs: stats.firstAudioWriteAt === undefined ? undefined : stats.firstAudioWriteAt - stats.startedAt,
        outcome: error?.name ?? 'stopped',
        ffmpeg: results.map((result) => ({ state: result.state, code: result.code, signal: result.signal, expected: result.expected })),
      },
    );
    // Source-clock gaps and encoded sample duration are distinct from delivery
    // pauses. Comparing both helps locate A/V drift without a full support dump.
    this.log?.debug?.('Media timing for device uuid "%s": session="%s" %j', this.nest_google_device_uuid, output.sessionID, {
      audio: output.muxer.audioTiming,
      maxVideoWriteGapMs: diagnostics.maxVideoWriteGapMs,
      maxAudioWriteGapMs: diagnostics.maxAudioWriteGapMs,
      audioWriteGapsOver100Ms: diagnostics.audioWriteGapsOver100Ms,
      audioWriteGapsOver250Ms: diagnostics.audioWriteGapsOver250Ms,
      audioWriteGapsOver500Ms: diagnostics.audioWriteGapsOver500Ms,
    });
    this.log?.debug?.('Media delivery for device uuid "%s": session="%s" %j', this.nest_google_device_uuid, output.sessionID, {
      sharedRetention: this.#timeline?.stats,
      writes: stats.writes,
      drops: stats.drops,
      videoBackpressureStops: diagnostics.videoBackpressureStops,
      maxQueuedBytes: diagnostics.maxQueuedBytes,
    });
  }

  static #wake(delay = 0) {
    let due = Date.now() + delay;
    if (this.#streamers.size === 0 || due >= this.#due) {
      return;
    }
    clearTimeout(this.#timer);
    this.#due = due;
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined;
        this.#due = Infinity;
        let next = Infinity;
        for (let streamer of this.#streamers.values()) {
          next = Math.min(next, streamer.#processOutput(Date.now()));
        }
        if (Number.isFinite(next) === true) {
          this.#wake(next);
        }
      },
      Math.max(0, delay),
    );
  }

  static #removeStreamer(streamer) {
    this.#streamers.delete(streamer.#HomeKitDeviceUUID);
    if (this.#streamers.size === 0) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
      this.#due = Infinity;
    }
  }

  #syncSchedulerState() {
    if (this.isStreaming() === true) {
      Streamer.#streamers.set(this.#HomeKitDeviceUUID, this);
      Streamer.#wake();
    } else {
      Streamer.#removeStreamer(this);
    }
  }
}
