// streamer
// Part of homebridge-nest-accfactory
//
// Base class for all Camera/Doorbell streaming.
//
// Maintains a shared rotating media buffer using RingBuffer and allows multiple
// HomeKit clients to consume the same upstream source for live viewing, buffering,
// and/or recording. Each live or recording output maintains its own cursor into
// the shared buffer.
//
// Note:
// - RingBuffer is also exposed for reuse by transport implementations
//   (e.g. NexusTalk, WebRTC) for efficient queueing and buffering.
//
// IMPORTANT:
// Extending classes are responsible for managing the upstream stream source
// (e.g. WebRTC, NexusTalk) and MUST notify Streamer of source lifecycle changes
// using setSourceState(..). This ensures correct buffer handling, connection
// lifecycle behaviour, fallback frame behaviour, and output startup logic.
//
// Typical source lifecycle states are:
// - SOURCE_CONNECTING   -> when initiating connection to upstream source
// - SOURCE_CONNECTED    -> when transport is established but media may not yet be flowing
// - SOURCE_READY        -> when media items are flowing and valid
// - SOURCE_RECONNECTING -> when source is retrying after interruption
// - SOURCE_CLOSING      -> when source teardown has started
// - SOURCE_CLOSED       -> when the source has stopped or disconnected
//
// Failure to signal correct source state may result in:
// - stale or frozen video on startup
// - incorrect buffer positioning
// - missing recordings or live stream failures
//
// Media Model:
// - Streamer expects complete media frames (not partial frames such as raw NALU fragments)
// - Video should be provided as complete H264 NAL units or access units
// - Audio should be provided as complete frames (AAC or PCM)
// - Streamer handles pacing, buffering, and fan-out to outputs
//
// Buffering Model:
// - A shared RingBuffer stores recent media frames/items
// - Appends and trimming are O(1); no front-splice copying occurs
// - Buffer capacity grows only when required; normal operation does not re-pack items
// - Live and recording sessions read from the buffer using independent cursors
// - Items are referenced using logical indexes; physical storage may wrap
//
// Live Streaming Behaviour:
// - Live outputs prefer starting at the most recent safe decoder point (IDR keyframe)
// - If a sufficiently recent keyframe is retained, it is used to bootstrap playback
// - If no recent keyframe is available, the stream attaches near the live edge
// - In this case, video is suppressed until the next keyframe arrives naturally
// - This avoids replaying stale buffered media and keeps latency low
//
// Recording Behaviour:
// - Recording outputs start from a requested timestamp when provided
// - For H264, the nearest suitable keyframe is selected to ensure decodability
// - If no exact match exists, the closest valid keyframe before/after is used
// - If no keyframe is found, fallback to the latest safe decoder position
//
// H264 Handling:
// - Streamer manages Annex-B start codes for H264 output
// - Extending classes should provide clean NAL units without start codes where possible
// - SPS/PPS are tracked and injected as needed for decoder startup
//
// Synchronisation:
// - Audio output is suppressed until a video keyframe (IDR) is seen for a session
// - This ensures correct A/V alignment for HomeKit consumers
//
// Extending classes are expected to implement or override, as needed:
//
// streamer.connect(options)
// streamer.close()
// streamer.onUpdate(deviceData)
// streamer.onShutdown()
//
// The following should be implemented when supported by the transport:
//
// streamer.sendTalkback(talkingBuffer)
//
// The following getters should be overridden:
//
// streamer.codecs <- return object with codecs being used (video, audio, talkback)
// streamer.capabilities <- return object with streaming capabilities (live, record, talkback, buffering)
//
// The following properties should be overridden when required:
//
// blankAudio - Buffer containing a blank audio segment for the type of audio being used
//
// Code version 2026.04.16
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

const MAX_BUFFERED_ITEMS_PER_OUTPUT_PER_TICK = 20; // Prevent one output starving others
const STREAM_FRAME_INTERVAL = 1000 / 30; // 30fps approx
const OUTPUT_LOOP_INTERVAL = 10; // Shared output scheduler interval
const OUTPUT_BUDGET_LOG_INTERVAL = 30000; // Throttle per-streamer over-budget debug logs

// Default capacity for generic RingBuffer usage.
// This should remain a sensible general-purpose default and not be tied to
// any specific streaming or media retention behaviour.
const RINGBUFFER_DEFAULT_CAPACITY = 1024;

// Initial capacity used by Streamer for its shared media buffer.
// This may diverge from the generic RingBuffer default as buffering strategy,
// retention window, or media characteristics evolve.
const STREAMER_INITIAL_BUFFER_CAPACITY = 1024;

// RingBuffer
//
// Fixed-capacity circular buffer with logical indexing.
// - O(1) push and shift (no array reallocation or front-splice)
// - Grows by doubling when capacity is exceeded
// - Maintains a monotonically increasing logical startIndex
//   so external consumers can track absolute positions even as data is trimmed
//
// Terminology:
// - head: physical index of the first logical item
// - size: number of valid items currently stored
// - startIndex: logical index of the first item (external reference point)
//
// Access is done via logical offsets (0..size-1), which are translated
// to physical positions via modulo arithmetic.
export class RingBuffer {
  items = [];
  capacity = 0;
  head = 0;
  size = 0;
  startIndex = 0;

  constructor(startIndex = 0, capacity = RINGBUFFER_DEFAULT_CAPACITY) {
    // capacity = physical storage size (number of slots in the circular array)
    this.capacity = Number.isInteger(capacity) === true && capacity > 0 ? capacity : RINGBUFFER_DEFAULT_CAPACITY;

    // Preallocate backing array to avoid resizing on every push
    this.items = new Array(this.capacity);

    // startIndex = logical index of the first item in the buffer
    // (used by external consumers to map absolute positions)
    this.startIndex = Number.isInteger(startIndex) === true && startIndex >= 0 ? startIndex : 0;
  }

  physicalOffset(offset) {
    // Convert a logical offset (0..size-1) into a physical array index.
    // head = physical position of logical offset 0.
    // We wrap using modulo to stay within the circular buffer.
    if (Number.isInteger(offset) !== true || offset < 0) {
      return -1;
    }

    return (this.head + offset) % this.capacity;
  }

  getByOffset(offset) {
    let physicalOffset = 0;

    // Bounds check against current logical size
    if (Number.isInteger(offset) !== true || offset < 0 || offset >= this.size) {
      return undefined;
    }

    // Translate logical offset -> physical slot
    physicalOffset = this.physicalOffset(offset);

    // Return stored item (or undefined if something went wrong)
    return physicalOffset >= 0 ? this.items[physicalOffset] : undefined;
  }

  grow() {
    // Double capacity to amortize growth cost (O(n), but infrequent)
    let newCapacity = this.capacity * 2;
    let newItems = new Array(newCapacity);
    let index = 0;

    // Re-pack items linearly starting at index 0
    // This removes wrap-around and resets head to 0
    while (index < this.size) {
      newItems[index] = this.getByOffset(index);
      index++;
    }

    this.items = newItems;
    this.capacity = newCapacity;

    // After re-pack, logical offset 0 is now at physical index 0
    this.head = 0;
  }

  push(item) {
    let tailOffset = 0;

    // Grow if buffer is full (no overwriting policy here)
    if (this.size >= this.capacity) {
      this.grow();
    }

    // Tail = logical position "size"
    tailOffset = this.physicalOffset(this.size);
    if (tailOffset < 0) {
      return;
    }

    // Insert at tail and increase size
    this.items[tailOffset] = item;
    this.size++;
  }

  shift(count, resetStartIndex = undefined) {
    let removeCount = 0;
    let index = 0;
    let physicalOffset = 0;

    // Remove N items from the head (logical front of buffer)
    if (Number.isInteger(count) !== true || count <= 0) {
      return;
    }

    removeCount = Math.min(count, this.size);

    // Clear references so GC can reclaim memory
    while (index < removeCount) {
      physicalOffset = this.physicalOffset(index);
      if (physicalOffset >= 0) {
        this.items[physicalOffset] = undefined;
      }
      index++;
    }

    // Advance head forward (wrap if needed)
    this.head = (this.head + removeCount) % this.capacity;

    // Shrink logical size
    this.size -= removeCount;

    // Advance logical index base
    this.startIndex += removeCount;

    // If buffer is now empty, normalize state
    if (this.size === 0) {
      // Reset physical head to 0 so future pushes are contiguous
      this.head = 0;

      // Optionally reset logical index baseline.
      // Default behaviour keeps startIndex monotonic unless an explicit
      // resetStartIndex is supplied by the caller.
      if (Number.isInteger(resetStartIndex) === true && resetStartIndex >= 0) {
        this.startIndex = resetStartIndex;
      }
    }
  }

  clear(resetStartIndex = 0) {
    let index = 0;
    let physicalOffset = 0;

    while (index < this.size) {
      physicalOffset = this.physicalOffset(index);
      if (physicalOffset >= 0) {
        this.items[physicalOffset] = undefined;
      }
      index++;
    }

    this.head = 0;
    this.size = 0;

    if (Number.isInteger(resetStartIndex) === true && resetStartIndex >= 0) {
      this.startIndex = resetStartIndex;
    }
  }
}

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
    SOURCE_CLOSING: 'source-closing',
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
    codec: undefined,
    profile: undefined,
    width: undefined,
    height: undefined,
    fps: undefined,
    bitrate: undefined,
  };

  audio = {
    codec: undefined,
    profile: undefined,
    sampleRate: undefined,
    channels: undefined,
    bitrate: undefined,
    frameDuration: undefined,
  };

  // Internal data only for this class
  #HomeKitDeviceUUID = undefined; // HomeKitDevice uuid for this streamer
  #bufferDuration = 0; // Duration of media to keep in the shared buffer based on media timestamps
  #bufferEnabled = false; // Retained buffering policy flag owned by Streamer
  #buffer = undefined; // Shared rotating ring buffer used by buffering, live and recording outputs
  #outputs = new Map(); // Live and recording outputs keyed by session id
  #cameraFrames = {}; // H264 resource frames for offline, video off, transferring
  #sequenceCounters = {}; // Sequence counters for item types
  #itemIndex = 0; // Monotonic item index for shared buffer cursor tracking
  #videoState = {}; // Video state tracking
  #audioState = {}; // Audio state tracking
  #lastFallbackFrameTime = 0; // Timer for pacing fallback frames
  #lastBudgetLogTime = 0; // Last time budget processing was sampled/logged
  #outputErrors = 0; // Consecutive output loop failures for this instance
  #lastMediaTime = {}; // Track last buffered media time per type for fallback ordering guards
  #sourceState = Streamer.MESSAGE_TYPE.SOURCE_CLOSED; // Track stream source state from messages for internal logic and logging
  #connectOptions = {}; // Store options from connect to use on reconnects
  #lifecycleQueue = Promise.resolve(); // Serializes source connect/close operations to avoid lifecycle races
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

    // Setup buffer duration if passed in as an option, otherwise default to 5s
    // Clamp to sane bounds to avoid invalid or excessive buffer sizes
    this.#bufferDuration =
      Number.isInteger(options?.bufferDuration) === true && options.bufferDuration > 0
        ? Math.min(Math.max(options.bufferDuration, 2000), 15000)
        : 5000;
  }

  async onUpdate(deviceData) {
    if (typeof deviceData !== 'object') {
      return;
    }

    if (deviceData?.migrating !== undefined && this.migrating !== deviceData?.migrating) {
      this.migrating = deviceData.migrating;
    }

    if (deviceData?.nest_google_device_uuid !== undefined && this.nest_google_device_uuid !== deviceData?.nest_google_device_uuid) {
      this.nest_google_device_uuid = deviceData?.nest_google_device_uuid;

      if (this.hasActiveStreams() === true) {
        await this.#doClose();
        await this.#doConnect();
      }
    }

    if (
      (deviceData?.online !== undefined && this.online !== deviceData.online) ||
      (deviceData?.streaming_enabled !== undefined && this.videoEnabled !== deviceData.streaming_enabled) ||
      (deviceData?.audio_enabled !== undefined && this.audioEnabled !== deviceData.audio_enabled)
    ) {
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
        if (this.online === false || this.videoEnabled === false || this.audioEnabled === false) {
          await this.#doClose();
          return;
        }

        await this.#doConnect();
      }
    }
  }

  async onMessage(type, message) {
    if (typeof type !== 'string' || type === '') {
      return;
    }

    let sessionID = message?.sessionID !== undefined ? String(message.sessionID) : undefined;

    if (type === Streamer.MESSAGE_TYPE.START_BUFFER) {
      // Enable retained buffer and ensure source is connected.
      // This does not create an output stream, only prepares buffering for future use.
      if (this.capabilities.buffering !== true) {
        this?.log?.debug?.('Buffering is unsupported for "%s"', this.nest_google_device_uuid);
        return;
      }

      await this.#startBuffering(message?.options);
      return;
    }

    if (type === Streamer.MESSAGE_TYPE.STOP_BUFFER) {
      // Disable retained buffer.
      // If no outputs are active, this may also allow the source to close.
      if (this.capabilities.buffering !== true) {
        this?.log?.debug?.('Buffering is unsupported for "%s"', this.nest_google_device_uuid);
        return;
      }

      await this.#stopBuffering();
      return;
    }

    if (type === Streamer.MESSAGE_TYPE.START_LIVE) {
      // Start a live streaming output for HomeKit.
      // This creates PassThrough streams and begins feeding real-time data.
      if (this.capabilities.live !== true) {
        this?.log?.debug?.('Live streaming is unsupported for "%s"', this.nest_google_device_uuid);
        return;
      }

      return await this.#createOutput(sessionID, Streamer.STREAM_TYPE.LIVE, message?.options);
    }

    if (type === Streamer.MESSAGE_TYPE.STOP_LIVE) {
      // Stop a live streaming output.
      // Cleans up streams and may close source if no other outputs remain.
      if (this.capabilities.live !== true) {
        this?.log?.debug?.('Live streaming is unsupported for "%s"', this.nest_google_device_uuid);
        return;
      }

      await this.#stopOutput(sessionID, Streamer.STREAM_TYPE.LIVE);
      return;
    }

    if (type === Streamer.MESSAGE_TYPE.START_RECORD) {
      // Start a recording output (HKSV).
      // Uses retained buffer and aligns start position to a safe frame (e.g. H264 keyframe).
      if (this.capabilities.record !== true) {
        this?.log?.debug?.('Recording is unsupported for "%s"', this.nest_google_device_uuid);
        return;
      }

      return await this.#createOutput(sessionID, Streamer.STREAM_TYPE.RECORD, message?.options);
    }

    if (type === Streamer.MESSAGE_TYPE.STOP_RECORD) {
      // Stop a recording output.
      // If no sessionID is provided, stops the first active recording stream.
      if (this.capabilities.record !== true) {
        this?.log?.debug?.('Recording is unsupported for "%s"', this.nest_google_device_uuid);
        return;
      }

      await this.#stopOutput(sessionID, Streamer.STREAM_TYPE.RECORD);
      return;
    }

    if (
      type === Streamer.MESSAGE_TYPE.SOURCE_CONNECTING ||
      type === Streamer.MESSAGE_TYPE.SOURCE_CONNECTED ||
      type === Streamer.MESSAGE_TYPE.SOURCE_RECONNECTING ||
      type === Streamer.MESSAGE_TYPE.SOURCE_CLOSING ||
      type === Streamer.MESSAGE_TYPE.SOURCE_CLOSED ||
      type === Streamer.MESSAGE_TYPE.SOURCE_READY
    ) {
      // Handle lifecycle events from the underlying stream source (WebRTC, NexusTalk, etc).
      // These events reflect connection state and readiness for media delivery.

      // Ignore duplicate state transitions to avoid log spam and unnecessary stat updates
      if (this.#sourceState === type) {
        return;
      }

      // Prevent reconnecting -> connecting downgrade, which can occur during retry loops
      if (this.#sourceState === Streamer.MESSAGE_TYPE.SOURCE_RECONNECTING && type === Streamer.MESSAGE_TYPE.SOURCE_CONNECTING) {
        return;
      }

      this.#sourceState = type;

      // Reset transient state when connection is starting, restarting, or fully closed
      if (
        type === Streamer.MESSAGE_TYPE.SOURCE_CONNECTING ||
        type === Streamer.MESSAGE_TYPE.SOURCE_RECONNECTING ||
        type === Streamer.MESSAGE_TYPE.SOURCE_CLOSED
      ) {
        this.#resetSourceState();
        this.#resetSourceStats();
      }

      // Track timing and reconnect metrics for diagnostics/support dump
      if (typeof this.#stats === 'object' && this.#stats !== null) {
        let now = Date.now();

        // Initial connection attempt
        if (type === Streamer.MESSAGE_TYPE.SOURCE_CONNECTING) {
          this.#stats.source.connectingAt = now;
        }

        // Transport connected (but not yet ready for frames)
        if (type === Streamer.MESSAGE_TYPE.SOURCE_CONNECTED) {
          this.#stats.source.connectedAt = now;
        }

        // Source ready and delivering media
        if (type === Streamer.MESSAGE_TYPE.SOURCE_READY) {
          this.#stats.source.readyAt = now;
        }

        // Count reconnect attempts separately
        if (type === Streamer.MESSAGE_TYPE.SOURCE_RECONNECTING) {
          this.#stats.source.reconnects = (this.#stats.source.reconnects ?? 0) + 1;
        }
      }

      // Log unified source state for visibility across different transport implementations
      this?.log?.debug?.(
        'Stream source is "%s" for uuid "%s"%s',
        type,
        this.nest_google_device_uuid,
        typeof message?.reason === 'string' && message.reason !== '' ? ' (' + message.reason + ')' : '',
      );

      return;
    }
  }

  async onShutdown() {
    Streamer.#removeStreamer(this);
    await this.stopEverything();
  }

  async stopEverything() {
    if (this.hasActiveStreams() === true) {
      this?.log?.debug?.('Stopped buffering, live and recording from device uuid "%s"', this.nest_google_device_uuid);

      for (let output of this.#outputs.values()) {
        this.#cleanupOutput(output);
      }

      this.#outputs.clear();
      this.#resetRetainedState();
      this.#syncSchedulerState();
      await this.#doClose();
    }
  }

  addMedia(media) {
    let mediaType = undefined;
    let codec = undefined;
    let now = Date.now();
    let data = undefined;
    let audioFrameDuration = 0;
    let sequence = 0;
    let sourceTimestamp = 0;
    let mediaTime = 0;
    let keyFrame = false;
    let h264Result = undefined;

    // Validate incoming media object
    if (typeof media !== 'object' || media === null) {
      return;
    }

    mediaType = typeof media.type === 'string' ? media.type.toLowerCase() : undefined;
    keyFrame = media?.keyFrame === true;

    // Validate media type and payload
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

    // Do not process if no active outputs
    if (this.hasActiveStreams() !== true) {
      return;
    }

    data = media.data;

    // Ensure shared buffer exists before proceeding
    this.#ensureSharedBuffer();
    if (this.#buffer === undefined) {
      return;
    }

    // Resolve codec (explicit media override first, otherwise fallback to configured codecs)
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
                ? Streamer.CODEC_TYPE.META
                : undefined;

    if (typeof codec !== 'string' || codec.trim() === '') {
      return;
    }

    // Update advertised video stream properties
    if (mediaType === Streamer.MEDIA_TYPE.VIDEO) {
      this.video.codec = codec;

      if (media?.profile?.trim?.() !== '') {
        this.video.profile = media.profile;
      }

      if (Number.isFinite(media?.bitrate) === true && media.bitrate > 0) {
        this.video.bitrate = media.bitrate;
      }
    }

    // Update advertised audio stream properties
    if (mediaType === Streamer.MEDIA_TYPE.AUDIO) {
      this.audio.codec = codec;

      if (media?.profile?.trim?.() !== '') {
        this.audio.profile = media.profile;
      }

      if (Number.isFinite(media?.sampleRate) === true && media.sampleRate > 0) {
        this.audio.sampleRate = media.sampleRate;
      }

      if (Number.isFinite(media?.channels) === true && media.channels > 0) {
        this.audio.channels = media.channels;
      }

      if (Number.isFinite(media?.bitrate) === true && media.bitrate > 0) {
        this.audio.bitrate = media.bitrate;
      }
    }

    // Initialise sequence counter if required
    if (typeof this.#sequenceCounters?.[mediaType] !== 'number') {
      this.#sequenceCounters[mediaType] = 0;
    }

    // Use provided sequence/timestamp or fallback to generated values
    sequence = Number.isFinite(media?.sequence) === true ? media.sequence : this.#sequenceCounters[mediaType]++;
    sourceTimestamp = Number.isFinite(media?.timestamp) === true ? Math.round(media.timestamp) : now;

    // Ensure monotonic media time (never goes backwards)
    if (typeof this.#lastMediaTime?.[mediaType] !== 'number') {
      this.#lastMediaTime[mediaType] = 0;
    }

    mediaTime = sourceTimestamp < this.#lastMediaTime[mediaType] ? this.#lastMediaTime[mediaType] : sourceTimestamp;
    this.#lastMediaTime[mediaType] = mediaTime;

    // Codec-specific H264 processing
    if (mediaType === Streamer.MEDIA_TYPE.VIDEO && codec === Streamer.CODEC_TYPE.H264) {
      h264Result = this.#processH264VideoMedia(data, sourceTimestamp, keyFrame, now);

      if (typeof h264Result !== 'object' || h264Result === null) {
        return;
      }

      data = h264Result.data;
      keyFrame = h264Result.keyFrame === true;
    }

    // Audio frame timing smoothing
    if (mediaType === Streamer.MEDIA_TYPE.AUDIO) {
      if (typeof this.#audioState.lastSourceFrameTime === 'number') {
        audioFrameDuration = sourceTimestamp - this.#audioState.lastSourceFrameTime;

        if (audioFrameDuration > 0) {
          let isOutlier = false;

          if (typeof this.audio.frameDuration === 'number' && this.audio.frameDuration > 0) {
            let deviance = Math.abs(audioFrameDuration - this.audio.frameDuration) / this.audio.frameDuration;
            if (deviance > 0.5) {
              isOutlier = true;
            }
          }

          if (isOutlier !== true) {
            if (typeof this.audio.frameDuration === 'number') {
              this.audio.frameDuration = this.audio.frameDuration * 0.8 + audioFrameDuration * 0.2;
            } else {
              this.audio.frameDuration = audioFrameDuration;
            }
          }
        }
      }

      this.#audioState.lastSourceFrameTime = sourceTimestamp;
    }

    // Update source/item stats for support dump and diagnostics
    if (this.supportDump === true && typeof this.#stats?.source === 'object' && this.#stats.source !== null) {
      if (keyFrame === true && typeof this.#stats.source.firstKeyframeAt !== 'number') {
        this.#stats.source.firstKeyframeAt = now;
      }

      this.#stats.source.lastItemAt = now;

      if (mediaType === Streamer.MEDIA_TYPE.VIDEO) {
        this.#stats.source.lastVideoItemAt = now;

        if (typeof this.#stats.source.firstVideoItemAt !== 'number') {
          this.#stats.source.firstVideoItemAt = now;
        }
      }

      if (mediaType === Streamer.MEDIA_TYPE.AUDIO) {
        this.#stats.source.lastAudioItemAt = now;

        if (typeof this.#stats.source.firstAudioItemAt !== 'number') {
          this.#stats.source.firstAudioItemAt = now;
        }
      }

      if (keyFrame === true) {
        this.#stats.source.lastKeyframeAt = now;
      }
    }

    if (this.supportDump === true && typeof this.#stats?.items === 'object' && this.#stats.items !== null) {
      if (mediaType === Streamer.MEDIA_TYPE.VIDEO) {
        this.#stats.items.video++;
      }

      if (mediaType === Streamer.MEDIA_TYPE.AUDIO) {
        this.#stats.items.audio++;
      }

      if (mediaType === Streamer.MEDIA_TYPE.TALK) {
        this.#stats.items.talk++;
      }

      if (mediaType === Streamer.MEDIA_TYPE.METADATA) {
        this.#stats.items.metadata++;
      }

      if (keyFrame === true) {
        this.#stats.items.keyframes++;
      }
    }

    // Push final packet into shared buffer
    this.#buffer.push({
      index: this.#itemIndex++,
      type: mediaType,
      codec: codec,
      time: mediaTime,
      sourceTimestamp: sourceTimestamp,
      sequence: sequence,
      keyFrame: keyFrame === true,
      data: data,
    });
  }

  #processH264VideoMedia(data, sourceTimestamp, keyFrame, now) {
    let nalUnits = undefined;
    let containsFrame = false;
    let resolution = undefined;
    let isAnnexB = false;
    let previousFPS = undefined;
    let frameDelta = 0;
    let fps = 0;

    // Split incoming payload into NAL units
    nalUnits = this.#getH264NALUnits(data);

    if (nalUnits.length === 0) {
      return undefined;
    }

    // Derive Annex-B from parser behaviour:
    // - Non-Annex-B returns original buffer reference
    // - Annex-B returns subarray views
    isAnnexB = nalUnits[0].data !== data;

    for (let nalu of nalUnits) {
      // SPS -> update resolution and cache
      if (nalu.type === Streamer.H264NALUS.TYPES.SPS) {
        this.#videoState.lastSPS = Buffer.from(nalu.data);

        resolution = this.#decodeH264SPS(nalu.data);
        if (typeof resolution === 'object' && resolution !== null) {
          if (Number.isInteger(resolution.width) === true && resolution.width > 0) {
            this.video.width = resolution.width;
          }

          if (Number.isInteger(resolution.height) === true && resolution.height > 0) {
            this.video.height = resolution.height;
          }
        }
      }

      // PPS -> cache for future keyframes
      if (nalu.type === Streamer.H264NALUS.TYPES.PPS) {
        this.#videoState.lastPPS = Buffer.from(nalu.data);
      }

      // IDR (keyframe)
      if (nalu.type === Streamer.H264NALUS.TYPES.IDR) {
        this.#videoState.lastIDR = Buffer.from(nalu.data);
        containsFrame = true;
        keyFrame = true;
      }

      // Non-IDR slice still represents a frame
      if (nalu.type === Streamer.H264NALUS.TYPES.SLICE_NON_IDR) {
        containsFrame = true;
      }
    }

    // Convert non-Annex-B to Annex-B format for downstream compatibility
    if (isAnnexB !== true) {
      if (nalUnits.length !== 1) {
        return undefined;
      }

      data = Buffer.concat([Streamer.H264NALUS.START_CODE, nalUnits[0].data]);
    }

    // FPS estimation based on source timestamps
    if (containsFrame === true) {
      if (typeof this.#videoState.lastSourceFrameTime === 'number' && sourceTimestamp > this.#videoState.lastSourceFrameTime) {
        frameDelta = sourceTimestamp - this.#videoState.lastSourceFrameTime;
        previousFPS = this.video.fps;

        if (
          typeof previousFPS !== 'number' ||
          previousFPS <= 0 ||
          Math.abs(frameDelta - 1000 / previousFPS) / (1000 / previousFPS) <= 0.5
        ) {
          fps = 1000 / frameDelta;

          if (typeof previousFPS === 'number') {
            this.video.fps = previousFPS * 0.8 + fps * 0.2;
          } else {
            this.video.fps = fps;
          }

          if (
            this.#videoState.streamInfoLogged !== true &&
            typeof this.video.width === 'number' &&
            typeof this.video.height === 'number' &&
            typeof this.video.fps === 'number'
          ) {
            this.#videoState.streamInfoLogged = true;
            this?.log?.debug?.(
              'Receiving incoming stream from device "%s": %s %sx%s @ %sfps',
              this.nest_google_device_uuid,
              this.video.codec,
              this.video.width,
              this.video.height,
              Math.round(this.video.fps),
            );
          }

          if (typeof previousFPS === 'number' && typeof this.video.fps === 'number') {
            if (
              Math.abs(Math.round(this.video.fps) - Math.round(previousFPS)) >= 3 &&
              (typeof this.#videoState.lastFPSLogTime !== 'number' || now - this.#videoState.lastFPSLogTime >= 30000)
            ) {
              this.#videoState.lastFPSLogTime = now;
              this?.log?.debug?.('FPS from device "%s" has changed to %sfps', this.nest_google_device_uuid, Math.round(this.video.fps));
            }
          }
        }
      }

      this.#videoState.lastSourceFrameTime = sourceTimestamp;
    }

    // Track last keyframe index for buffer trimming / recording alignment
    if (keyFrame === true) {
      this.#videoState.lastIDRIndex = this.#itemIndex;
    }

    return {
      data: data,
      keyFrame: keyFrame,
    };
  }

  async #startBuffering(options = {}) {
    this.#ensureSharedBuffer();

    if (this.#bufferEnabled === true) {
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
    let includeAudio = options?.includeAudio === true;
    let waitForReady = Number.isInteger(options?.waitForReady) === true ? options.waitForReady : 0;
    let startCursor = this.#itemIndex;
    let buffer = undefined;
    let itemsLength = 0;
    let bufferStart = 0;
    let item = undefined;
    let isH264 = this.codecs?.video === Streamer.CODEC_TYPE.H264;
    let recordTime = options?.recordTime;
    let bestBeforeOffset = -1;
    let bestAfterOffset = -1;
    let bestBeforeTime = Number.NEGATIVE_INFINITY;
    let bestAfterTime = Number.POSITIVE_INFINITY;
    let latestKeyFrameOffset = -1;
    let index = 0;
    let itemTime = 0;
    let startTime = Date.now();

    // Validate session id
    if (typeof sessionID !== 'string' || sessionID === '') {
      return;
    }

    // Check for existing output with this session id
    existing = this.#outputs.get(sessionID);

    // Only allow a single record output, regardless of session id
    if (type === Streamer.STREAM_TYPE.RECORD && existing === undefined) {
      for (output of this.#outputs.values()) {
        if (output?.type === Streamer.STREAM_TYPE.RECORD) {
          existing = output;
          break;
        }
      }
    }

    // Reuse existing output when possible, otherwise reject type conflict
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

    // Ensure retained buffer exists and start/connect source if needed
    this.#ensureSharedBuffer();
    await this.#doConnect(options);
    buffer = this.#buffer;

    if (buffer instanceof RingBuffer !== true) {
      return;
    }

    // Create streams for this output
    video = new PassThrough();
    audio = includeAudio === true ? new PassThrough() : null;
    talkback = type === Streamer.STREAM_TYPE.LIVE && includeAudio === true ? new PassThrough({ highWaterMark: 1024 * 16 }) : null;

    // Prevent unhandled stream errors from bubbling
    video?.on?.('error', () => {});
    audio?.on?.('error', () => {});
    talkback?.on?.('error', () => {});

    // Determine initial cursor for recording
    if (type === Streamer.STREAM_TYPE.RECORD) {
      itemsLength = buffer.size;
      bufferStart = buffer.startIndex;
      bestBeforeOffset = -1;
      bestAfterOffset = -1;
      bestBeforeTime = Number.NEGATIVE_INFINITY;
      bestAfterTime = Number.POSITIVE_INFINITY;
      latestKeyFrameOffset = -1;
      index = 0;

      // Default to buffer start if valid
      if (typeof bufferStart === 'number') {
        startCursor = bufferStart;
      }

      // Only attempt precise positioning if we have retained data and a valid time
      if (itemsLength !== 0 && typeof recordTime === 'number' && Number.isFinite(recordTime) === true) {
        if (isH264 === true) {
          // For H264 we MUST start on a keyframe (IDR) or decoding will fail.
          // We scan the retained buffer once and track:
          // - closest keyframe before the requested time
          // - closest keyframe after the requested time
          // - latest keyframe overall as fallback
          while (index < itemsLength) {
            item = buffer.getByOffset(index);

            if (
              item?.type === Streamer.MEDIA_TYPE.VIDEO &&
              item?.codec === Streamer.CODEC_TYPE.H264 &&
              item?.keyFrame === true &&
              typeof item?.time === 'number'
            ) {
              itemTime = item.time;
              latestKeyFrameOffset = index;

              if (itemTime <= recordTime && itemTime >= bestBeforeTime) {
                bestBeforeTime = itemTime;
                bestBeforeOffset = index;
              }

              if (itemTime > recordTime && itemTime < bestAfterTime) {
                bestAfterTime = itemTime;
                bestAfterOffset = index;
              }
            }

            index++;
          }

          // Prefer nearest valid decoder start before requested time
          if (bestBeforeOffset !== -1) {
            startCursor = buffer.getByOffset(bestBeforeOffset)?.index;
          }

          // Otherwise nearest valid decoder start after requested time
          if (bestBeforeOffset === -1 && bestAfterOffset !== -1) {
            startCursor = buffer.getByOffset(bestAfterOffset)?.index;
          }

          // Otherwise use latest retained keyframe
          if (bestBeforeOffset === -1 && bestAfterOffset === -1 && latestKeyFrameOffset !== -1) {
            startCursor = buffer.getByOffset(latestKeyFrameOffset)?.index;
          }

          // Final fallback: last globally seen IDR if it is still inside retained window
          if (
            bestBeforeOffset === -1 &&
            bestAfterOffset === -1 &&
            latestKeyFrameOffset === -1 &&
            typeof this.#videoState?.lastIDRIndex === 'number' &&
            typeof bufferStart === 'number' &&
            this.#videoState.lastIDRIndex >= bufferStart
          ) {
            startCursor = this.#videoState.lastIDRIndex;
          }
        }

        if (isH264 !== true) {
          // Non-H264 can start at first retained frame at or after requested time
          index = 0;

          while (index < itemsLength) {
            item = buffer.getByOffset(index);

            if (typeof item?.time === 'number' && item.time >= recordTime) {
              startCursor = item.index;
              break;
            }

            index++;
          }
        }
      }

      // Never allow cursor to point before current retained window
      if (typeof bufferStart === 'number' && startCursor < bufferStart) {
        startCursor = bufferStart;
      }
    }

    // Create output state
    output = {
      sessionID: sessionID,
      type: type,
      video: video,
      audio: audio,
      talkback: talkback,
      talkbackTimeout: undefined,
      includeAudio: includeAudio,
      cursor: type === Streamer.STREAM_TYPE.RECORD ? startCursor : undefined,
      catchingUp: type === Streamer.STREAM_TYPE.RECORD,
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
        writes: { total: 0, video: 0, audio: 0 },
        drops: { videoBeforeKeyframe: 0, audioBeforeKeyframe: 0, bufferTrimmed: 0 },
      },
    };

    // Attach talkback handling for live streams
    if (talkback !== null) {
      talkback.on('data', (data) => {
        if (typeof this?.sendTalkback === 'function') {
          this.sendTalkback(data);

          clearTimeout(output.talkbackTimeout);
          output.talkbackTimeout = setTimeout(() => {
            this.sendTalkback(Buffer.alloc(0));
          }, TIMERS.TALKBACK_AUDIO.interval);
        }
      });

      talkback.on('close', () => {
        clearTimeout(output?.talkbackTimeout);

        if (typeof this?.sendTalkback === 'function') {
          this.sendTalkback(Buffer.alloc(0));
        }
      });
    }

    // Register output before any optional readiness wait
    this.#outputs.set(sessionID, output);
    this.#syncSchedulerState();

    // Optionally wait for source readiness before returning stream handles
    if (waitForReady > 0) {
      while (Date.now() - startTime < waitForReady) {
        if (
          this.#sourceState === Streamer.MESSAGE_TYPE.SOURCE_READY ||
          this.#sourceState === Streamer.MESSAGE_TYPE.SOURCE_CLOSED ||
          this.#sourceState === Streamer.MESSAGE_TYPE.SOURCE_RECONNECTING
        ) {
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    this?.log?.debug?.(
      'Started %s stream from device uuid "%s" and session id "%s"',
      type === Streamer.STREAM_TYPE.LIVE ? 'live' : 'record',
      this.nest_google_device_uuid,
      sessionID,
    );

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
      type === Streamer.STREAM_TYPE.LIVE ? 'live' : 'record',
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

  isSourceReady() {
    return this.#sourceState === Streamer.MESSAGE_TYPE.SOURCE_READY;
  }

  setSourceState(type, reason) {
    if (typeof type !== 'string' || type === '') {
      return;
    }

    HomeKitDevice.message(this.#HomeKitDeviceUUID, Streamer.MESSAGE, type, { reason: reason });
  }

  async requestSourceConnect(options = undefined) {
    return await this.#doConnect(options);
  }

  async requestSourceClose() {
    return await this.#doClose();
  }

  #queueLifecycle(task) {
    let run = this.#lifecycleQueue.then(async () => {
      return await task();
    });

    // Keep queue alive even if one task fails, and avoid unhandled rejection noise.
    this.#lifecycleQueue = run.catch(() => {
      // Empty
    });

    return run;
  }

  async #doConnect(options = undefined) {
    return await this.#queueLifecycle(async () => {
      if (this.online !== true || this.videoEnabled !== true) {
        return;
      }

      if (typeof options === 'object' && options !== null) {
        this.#connectOptions = {
          ...(typeof this.#connectOptions === 'object' && this.#connectOptions !== null ? this.#connectOptions : {}),
          ...options,
        };
      }

      if (this.#sourceState !== Streamer.MESSAGE_TYPE.SOURCE_CLOSED) {
        return;
      }

      await this?.connect?.(this.#connectOptions);
    });
  }

  async #doClose() {
    return await this.#queueLifecycle(async () => {
      this.#resetSourceState();
      this.#resetSourceStats();
      await this?.close?.();
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
    this.#buffer = undefined;
    this.#sequenceCounters = {};
    this.#itemIndex = 0;
    this.#videoState = {};
    this.#audioState = {};
    this.#lastMediaTime = {};
  }

  #ensureSharedBuffer() {
    if (this.#buffer === undefined) {
      // Shared media is stored in a circular buffer so appends and expiry remain O(1).
      // Output cursors still use logical item indexes, which keeps live/record start
      // semantics stable even though physical storage is now wrapped.
      this.#buffer = new RingBuffer(this.#itemIndex, STREAMER_INITIAL_BUFFER_CAPACITY);
    }
  }

  #resetSourceState() {
    this.#videoState = {};
    this.video = { codec: undefined, profile: undefined, width: undefined, height: undefined, fps: undefined, bitrate: undefined };

    this.#audioState = {};
    this.audio = {
      codec: undefined,
      profile: undefined,
      sampleRate: undefined,
      channels: undefined,
      bitrate: undefined,
      frameDuration: undefined,
    };
  }

  #resetSourceStats() {
    if (typeof this.#stats !== 'object' || this.#stats === null) {
      return;
    }

    let reconnects = this.#stats?.source?.reconnects ?? 0;

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
    let index = 0;
    let naluStart = -1;
    let naluEnd = -1;
    let startCodeLength = 0;

    // Validate input
    if (Buffer.isBuffer(data) !== true || data.length === 0) {
      return nalUnits;
    }

    // Detect if buffer begins with Annex-B start code (3-byte or 4-byte)
    if (
      data.length < 3 ||
      data[0] !== 0x00 ||
      data[1] !== 0x00 ||
      (data[2] !== 0x01 && (data.length < 4 || data[2] !== 0x00 || data[3] !== 0x01))
    ) {
      // Not Annex-B formatted -> treat entire buffer as a single NAL unit
      return [{ type: data[0] & 0x1f, data: data }];
    }

    // Determine initial start code length (3 or 4 bytes)
    startCodeLength = data[2] === 0x01 ? 3 : 4;

    index = startCodeLength;
    naluStart = index;

    // Single-pass scan for subsequent start codes
    while (index <= data.length - 3) {
      // Check for 3-byte start code (00 00 01)
      if (data[index] === 0x00 && data[index + 1] === 0x00 && data[index + 2] === 0x01) {
        naluEnd = index;

        // Push previous NAL unit if valid
        if (naluEnd > naluStart) {
          nalUnits.push({
            type: data[naluStart] & 0x1f,
            data: data.subarray(naluStart, naluEnd),
          });
        }

        index += 3;
        naluStart = index;
        continue;
      }

      // Check for 4-byte start code (00 00 00 01)
      if (
        index <= data.length - 4 &&
        data[index] === 0x00 &&
        data[index + 1] === 0x00 &&
        data[index + 2] === 0x00 &&
        data[index + 3] === 0x01
      ) {
        naluEnd = index;

        // Push previous NAL unit if valid
        if (naluEnd > naluStart) {
          nalUnits.push({
            type: data[naluStart] & 0x1f,
            data: data.subarray(naluStart, naluEnd),
          });
        }

        index += 4;
        naluStart = index;
        continue;
      }

      index++;
    }

    // Push final NAL unit (if any data remains after last start code)
    if (naluStart < data.length) {
      nalUnits.push({
        type: data[naluStart] & 0x1f,
        data: data.subarray(naluStart),
      });
    }

    return nalUnits;
  }

  #decodeH264SPS(sps) {
    let data = undefined;
    let bitOffset = 0;
    let bitLength = 0;
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

    // SPS NAL only
    if (Buffer.isBuffer(sps) !== true || sps.length < 4 || (sps[0] & 0x1f) !== Streamer.H264NALUS.TYPES.SPS) {
      return undefined;
    }

    // Strip emulation-prevention bytes (00 00 03) so we can read RBSP bits directly
    data = Buffer.allocUnsafe(sps.length);
    let r = 0;
    let w = 0;

    while (r < sps.length) {
      if (r + 2 < sps.length && sps[r] === 0x00 && sps[r + 1] === 0x00 && sps[r + 2] === 0x03) {
        data[w++] = 0x00;
        data[w++] = 0x00;
        r += 3;
        continue;
      }

      data[w++] = sps[r++];
    }

    data = data.subarray(0, w);
    bitLength = data.length * 8;

    // Bit reader helpers for Exp-Golomb coded SPS fields
    let readBit = () => {
      if (bitOffset >= bitLength) {
        return 0;
      }
      let byteOffset = bitOffset >> 3;
      let value = (data[byteOffset] >> (7 - (bitOffset & 0x07))) & 0x01;
      bitOffset++;
      return value;
    };

    let readBits = (count) => {
      let value = 0;
      while (count--) {
        value = (value << 1) | readBit();
      }
      return value >>> 0;
    };

    let readUE = () => {
      let zeros = 0;
      while (bitOffset < bitLength && readBit() === 0) {
        zeros++;
      }
      let value = Math.pow(2, zeros) - 1;
      if (zeros > 0) {
        value += readBits(zeros);
      }
      return value >>> 0;
    };

    let readSE = () => {
      let value = readUE();
      return (value & 1) === 0 ? -(value >>> 1) : (value + 1) >>> 1;
    };

    readBits(8); // nal_unit_type header byte
    profileIdc = readBits(8); // profile_idc
    readBits(16); // constraint_set_flags + level_idc
    readUE(); // seq_parameter_set_id

    // High-profile SPS carries extra chroma / scaling-list fields
    if (
      profileIdc === 100 ||
      profileIdc === 110 ||
      profileIdc === 122 ||
      profileIdc === 244 ||
      profileIdc === 44 ||
      profileIdc === 83 ||
      profileIdc === 86 ||
      profileIdc === 118 ||
      profileIdc === 128 ||
      profileIdc === 138 ||
      profileIdc === 139 ||
      profileIdc === 134 ||
      profileIdc === 135
    ) {
      chromaFormatIdc = readUE();
      if (chromaFormatIdc === 3) {
        readBit();
      }

      readUE();
      readUE();
      readBit();

      if (readBit() === 1) {
        let count = chromaFormatIdc !== 3 ? 8 : 12;
        let i = 0;

        while (i < count) {
          if (readBit() === 1) {
            let size = i < 6 ? 16 : 64;
            let last = 8;
            let next = 8;
            let j = 0;

            while (j < size) {
              if (next !== 0) {
                next = (last + readSE() + 256) % 256;
              }
              last = next === 0 ? last : next;
              j++;
            }
          }
          i++;
        }
      }
    }

    // Skip picture order / reference frame fields until width/height fields
    readUE();
    let picOrderCntType = readUE();

    if (picOrderCntType === 0) {
      readUE();
    }

    if (picOrderCntType === 1) {
      let i = 0;
      readBit();
      readSE();
      readSE();
      let count = readUE();

      while (i < count) {
        readSE();
        i++;
      }
    }

    readUE();
    readBit();

    // Frame dimensions in macroblocks
    picWidthInMbsMinus1 = readUE();
    picHeightInMapUnitsMinus1 = readUE();
    frameMbsOnlyFlag = readBit();

    if (frameMbsOnlyFlag === 0) {
      readBit();
    }

    readBit();

    // Optional frame cropping offsets
    if (readBit() === 1) {
      frameCropLeftOffset = readUE();
      frameCropRightOffset = readUE();
      frameCropTopOffset = readUE();
      frameCropBottomOffset = readUE();
    }

    // Crop units depend on chroma format and whether picture is frame- or field-coded
    if (chromaFormatIdc === 1 || chromaFormatIdc === 2) {
      cropUnitX = 2;
    }

    cropUnitY = chromaFormatIdc === 1 ? 2 * (2 - frameMbsOnlyFlag) : 2 - frameMbsOnlyFlag;

    // Return decoded display resolution only
    return {
      width: (picWidthInMbsMinus1 + 1) * 16 - (frameCropLeftOffset + frameCropRightOffset) * cropUnitX,
      height: (2 - frameMbsOnlyFlag) * (picHeightInMapUnitsMinus1 + 1) * 16 - (frameCropTopOffset + frameCropBottomOffset) * cropUnitY,
    };
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

    if (typeof outputWrites.total !== 'number') {
      outputWrites.total = 0;
      outputWrites.video = 0;
      outputWrites.audio = 0;
    }

    outputWrites.total++;

    if (type === Streamer.MEDIA_TYPE.VIDEO) {
      outputWrites.video++;
    }

    if (type === Streamer.MEDIA_TYPE.AUDIO) {
      outputWrites.audio++;
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
    isH264 = this.codecs?.video === Streamer.CODEC_TYPE.H264;
    if (typeof dateNow !== 'number') {
      dateNow = Date.now();
    }

    this.#statsWrite(output, Streamer.MEDIA_TYPE.VIDEO, dateNow);

    if (isH264 === true) {
      outputVideo.write(Streamer.H264NALUS.START_CODE);
    }

    outputVideo.write(fallbackFrame);

    if (output.includeAudio === true && Buffer.isBuffer(this.blankAudio) === true) {
      this.#statsWrite(output, Streamer.MEDIA_TYPE.AUDIO, dateNow);
      outputAudio.write(this.blankAudio);
    }
  }

  #processBufferedOutput(output, dateNow, streamType, budgetMs) {
    let buffer = this.#buffer;
    let startIndex = undefined;
    let itemsLength = 0;
    let processed = 0;
    let offset = 0;
    let item = undefined;
    let nextCursor = 0;
    let dueTime = 0;
    let latestItem = undefined;
    let latestItemTime = undefined;
    let catchupAudioWrites = 0;
    let catchupExitedThisTick = false;
    let dueTolerance = 2;
    let dueSlack = 10;
    let catchupExitThresholdMs = 250;
    let catchupAudioBurstLimit = streamType === Streamer.STREAM_TYPE.RECORD ? 4 : 2;
    let outputVideo = undefined;
    let outputAudio = undefined;
    let isH264Output = false;
    let isLive = false;
    let includeAudio = false;
    let lastSPS = undefined;
    let lastPPS = undefined;
    let hasSPS = false;
    let hasPPS = false;
    let shouldCatchUp = false;
    let budgetDeadline = 0;
    let outputCursor = 0;
    let outputSeenKeyFrame = false;
    let outputSentCodecConfig = false;
    let outputCatchingUp = false;
    let outputSourceBaseTime = undefined;
    let outputWallclockBaseTime = undefined;
    let outputLastVideoWriteTime = 0;

    if (
      typeof output !== 'object' ||
      output === null ||
      typeof dateNow !== 'number' ||
      typeof streamType !== 'string' ||
      buffer instanceof RingBuffer !== true
    ) {
      return;
    }

    // Pull commonly used references/flags into locals for this scheduler tick
    startIndex = buffer.startIndex;
    itemsLength = buffer.size;
    outputVideo = output.video;
    outputAudio = output.audio;
    includeAudio = output.includeAudio === true;
    isH264Output = this.codecs?.video === Streamer.CODEC_TYPE.H264;
    isLive = streamType === Streamer.STREAM_TYPE.LIVE;
    lastSPS = this.#videoState.lastSPS;
    lastPPS = this.#videoState.lastPPS;
    hasSPS = Buffer.isBuffer(lastSPS) === true && lastSPS.length > 0;
    hasPPS = Buffer.isBuffer(lastPPS) === true && lastPPS.length > 0;
    latestItem = itemsLength !== 0 ? buffer.getByOffset(itemsLength - 1) : undefined;
    latestItemTime = typeof latestItem?.time === 'number' ? latestItem.time : undefined;
    budgetDeadline = typeof budgetMs === 'number' && budgetMs > 0 ? dateNow + budgetMs : 0;

    if (itemsLength === 0) {
      return;
    }

    if (isLive === true && isH264Output === true) {
      // Live H264 is more sensitive to timer jitter than record output.
      // Give it a slightly wider due window so packets that are effectively due now
      // are not delayed by tiny scheduler timing variations.
      dueTolerance = 10;
    }

    // Resolve startup cursor for a new output against the current retained buffer.
    // For live H264 troubleshooting, behave more like the older streamer and begin
    // draining from the retained buffer head instead of waiting for a keyframe bootstrap.
    if (typeof output.cursor !== 'number') {
      output.cursor = startIndex;
      output.catchingUp = false;
      output.sourceBaseTime = undefined;
      output.wallclockBaseTime = undefined;
    }

    // Clamp cursor so it can never point before the currently retained window
    if (typeof output.cursor !== 'number' || output.cursor < startIndex) {
      output.cursor = startIndex;
    }

    outputCursor = output.cursor;
    outputSeenKeyFrame = output.seenKeyFrame === true;
    outputSentCodecConfig = output.sentCodecConfig === true;
    outputCatchingUp = output.catchingUp === true;
    outputSourceBaseTime = output.sourceBaseTime;
    outputWallclockBaseTime = output.wallclockBaseTime;
    outputLastVideoWriteTime = typeof output.lastVideoWriteTime === 'number' ? output.lastVideoWriteTime : 0;
    offset = outputCursor - startIndex;

    while (offset < itemsLength && processed < MAX_BUFFERED_ITEMS_PER_OUTPUT_PER_TICK) {
      if (budgetDeadline !== 0 && (processed & 0x03) === 0 && Date.now() >= budgetDeadline) {
        break;
      }

      item = buffer.getByOffset(offset);

      if (typeof item?.time !== 'number') {
        break;
      }

      nextCursor = item.index + 1;
      shouldCatchUp = outputCatchingUp === true && catchupExitedThisTick === false;

      // In normal paced mode, map media time to wall clock and only emit items that are due.
      // In catch-up mode this timing gate is bypassed so the output can drain toward the live edge.
      if (shouldCatchUp !== true) {
        if (typeof outputSourceBaseTime !== 'number' || typeof outputWallclockBaseTime !== 'number') {
          outputSourceBaseTime = item.time;
          outputWallclockBaseTime = dateNow;
        }

        dueTime = outputWallclockBaseTime + (item.time - outputSourceBaseTime);

        // Add a little slack beyond dueTolerance so scheduler jitter does not keep nudging
        // near-due packets into the next tick.
        if (dueTime > dateNow + dueTolerance + dueSlack) {
          break;
        }
      }

      if (item.type === Streamer.MEDIA_TYPE.VIDEO) {
        if (item.codec === Streamer.CODEC_TYPE.H264) {
          // Keep recording startup strict, but allow live H264 to begin outputting
          // immediately for troubleshooting older Nest camera startup behaviour.
          if (outputSeenKeyFrame !== true && item.keyFrame !== true && isLive !== true) {
            this.#statsDrop(output, Streamer.MEDIA_TYPE.VIDEO);
            outputCursor = nextCursor;
            offset = outputCursor - startIndex;
            processed++;
            continue;
          }

          // Before the first keyframe write for this output, prepend the latest retained SPS/PPS
          // so downstream decoder configuration is in place.
          if (item.keyFrame === true && outputSentCodecConfig !== true) {
            if (hasSPS === true) {
              outputVideo.write(Streamer.H264NALUS.START_CODE);
              outputVideo.write(lastSPS);
            }

            if (hasPPS === true) {
              outputVideo.write(Streamer.H264NALUS.START_CODE);
              outputVideo.write(lastPPS);
            }

            outputSentCodecConfig = true;
          }

          if (item.keyFrame === true) {
            outputSeenKeyFrame = true;
          }
        }

        if (isH264Output === true) {
          outputVideo.write(Streamer.H264NALUS.START_CODE);
        }

        outputVideo.write(item.data);
        outputLastVideoWriteTime = dateNow;
        this.#statsWrite(output, Streamer.MEDIA_TYPE.VIDEO, dateNow);

        // If this output was catching up and is now near the live edge, switch it back to
        // normal paced mode anchored from the current item.
        if (shouldCatchUp === true && typeof latestItemTime === 'number' && latestItemTime - item.time <= catchupExitThresholdMs) {
          outputCatchingUp = false;
          outputSourceBaseTime = item.time;
          outputWallclockBaseTime = dateNow;
          catchupExitedThisTick = true;
        }

        outputCursor = nextCursor;
        offset = outputCursor - startIndex;
        processed++;
        continue;
      }

      if (item.type === Streamer.MEDIA_TYPE.AUDIO) {
        if (includeAudio !== true) {
          outputCursor = nextCursor;
          offset = outputCursor - startIndex;
          processed++;
          continue;
        }

        // Keep recording startup strict, but allow live audio to flow immediately
        // for troubleshooting startup timing on older Nest cameras.
        if (isH264Output === true && outputSeenKeyFrame !== true && isLive !== true) {
          this.#statsDrop(output, Streamer.MEDIA_TYPE.AUDIO);
          outputCursor = nextCursor;
          offset = outputCursor - startIndex;
          processed++;
          continue;
        }

        // In catch-up mode, limit how much audio can be written in one tick so a backlog
        // does not dump a big burst of PCM/AAC into ffmpeg.
        if (shouldCatchUp === true && catchupAudioWrites >= catchupAudioBurstLimit) {
          break;
        }

        outputAudio.write(item.data);
        catchupAudioWrites++;
        this.#statsWrite(output, Streamer.MEDIA_TYPE.AUDIO, dateNow);

        if (shouldCatchUp === true && typeof latestItemTime === 'number' && latestItemTime - item.time <= catchupExitThresholdMs) {
          outputCatchingUp = false;
          outputSourceBaseTime = item.time;
          outputWallclockBaseTime = dateNow;
          catchupExitedThisTick = true;
        }

        outputCursor = nextCursor;
        offset = outputCursor - startIndex;
        processed++;
        continue;
      }

      // Unknown/non-media item type: just advance cursor past it
      outputCursor = nextCursor;
      offset = outputCursor - startIndex;
      processed++;
    }

    output.cursor = outputCursor;
    output.seenKeyFrame = outputSeenKeyFrame;
    output.sentCodecConfig = outputSentCodecConfig;
    output.catchingUp = outputCatchingUp;
    output.sourceBaseTime = outputSourceBaseTime;
    output.wallclockBaseTime = outputWallclockBaseTime;
    output.lastVideoWriteTime = outputLastVideoWriteTime;
  }

  #processOutput(dateNow, budgetMs) {
    let buffer = this.#buffer;
    let itemsLength = 0;
    let hasOutputs = false;
    let cutoffTime = 0;
    let trimCount = 0;
    let oldestProtectedCursor = this.#itemIndex;
    let protectedOffset = -1;
    let fallbackFrame = undefined;
    let firstItem = undefined;
    let output = undefined;

    if (buffer instanceof RingBuffer !== true) {
      return;
    }

    itemsLength = typeof buffer.size === 'number' ? buffer.size : 0;
    hasOutputs = this.#outputs.size !== 0;

    // Determine if buffer contains items older than retention window
    if (itemsLength !== 0) {
      cutoffTime = dateNow - this.#bufferDuration;
      firstItem = buffer.getByOffset(0);

      // Only consider trimming if oldest item is outside buffer duration
      if (typeof firstItem?.time === 'number' && firstItem.time < cutoffTime) {
        // Find the earliest cursor across all outputs
        // This represents the oldest item still needed by any active stream
        for (output of this.#outputs.values()) {
          if (typeof output.cursor === 'number' && output.cursor < oldestProtectedCursor) {
            oldestProtectedCursor = output.cursor;
          }
        }

        // Convert protected cursor into buffer-relative offset
        // Items before this offset must not be trimmed
        if (oldestProtectedCursor >= buffer.startIndex) {
          protectedOffset = oldestProtectedCursor - buffer.startIndex;
        }

        // If protectedOffset === 0 -> first item still needed -> no trimming possible
        if (protectedOffset !== 0) {
          // Walk buffer from oldest forward and count how many items can be safely trimmed
          while (trimCount < itemsLength) {
            firstItem = buffer.getByOffset(trimCount);

            // Stop if item has no valid timestamp
            if (typeof firstItem?.time !== 'number') {
              break;
            }

            // Stop once items are within retention window
            if (firstItem.time >= cutoffTime) {
              break;
            }

            // Stop if we reach the protected region required by outputs
            if (protectedOffset !== -1 && trimCount >= protectedOffset) {
              break;
            }

            trimCount++;
          }
        }
      }

      if (trimCount !== 0) {
        // Only record buffer trimming stats when support dump is enabled.
        // This avoids unnecessary per-output stat updates on the hot path.
        if (this.supportDump === true) {
          for (output of this.#outputs.values()) {
            if (typeof output.stats === 'object' && output.stats !== null) {
              // Ensure drops structure exists and record trimmed items
              this.#ensureOutputDrops(output.stats).bufferTrimmed += trimCount;
            }
          }
        }

        // Always trim buffer regardless of stats collection
        buffer.shift(trimCount, this.#itemIndex);
        itemsLength -= trimCount;
      }
    }

    // No outputs attached means we only need buffer retention maintenance this tick.
    if (hasOutputs !== true) {
      return;
    }

    // If fallback is not due and the source is not ready, there is nothing to fan out yet.
    if (this.#sourceState !== Streamer.MESSAGE_TYPE.SOURCE_READY && dateNow - this.#lastFallbackFrameTime < STREAM_FRAME_INTERVAL) {
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

    if (this.#sourceState !== Streamer.MESSAGE_TYPE.SOURCE_READY) {
      // Source is not ready and no fallback was sent, so there is nothing to fan out this tick.
      return;
    }

    for (output of this.#outputs.values()) {
      this.#processBufferedOutput(output, dateNow, output.type, budgetMs);
    }
  }

  #outputStats(output, dateNow) {
    let outputStats = typeof output?.stats === 'object' && output.stats !== null ? output.stats : undefined;
    let outputWrites = typeof outputStats?.writes === 'object' && outputStats.writes !== null ? outputStats.writes : undefined;
    let outputDrops = typeof outputStats?.drops === 'object' && outputStats.drops !== null ? outputStats.drops : undefined;
    let sourceStats = this.#stats?.source;
    let itemStats = this.#stats?.items;

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
    this?.log?.info?.('      "connect": "%s"', elapsed(sourceStats?.connectingAt, sourceStats?.connectedAt));
    this?.log?.info?.('      "video": "%s"', elapsed(sourceStats?.connectingAt, sourceStats?.firstVideoItemAt));
    this?.log?.info?.('      "audio": "%s"', elapsed(sourceStats?.connectingAt, sourceStats?.firstAudioItemAt));
    this?.log?.info?.('      "ready": "%s"', elapsed(sourceStats?.connectingAt, sourceStats?.readyAt));
    this?.log?.info?.('      "keyframe": "%s"', elapsed(sourceStats?.connectingAt, sourceStats?.firstKeyframeAt));
    this?.log?.info?.('    },');
    this?.log?.info?.('    "duration": {');
    this?.log?.info?.(
      '      "source": "%s"',
      typeof sourceStats?.connectedAt === 'number' ? Math.round((dateNow - sourceStats.connectedAt) / 1000) + 's' : '-',
    );
    this?.log?.info?.(
      '      "output": "%s"',
      typeof outputStats?.startedAt === 'number' ? Math.round((dateNow - outputStats.startedAt) / 1000) + 's' : '-',
    );
    this?.log?.info?.('    },');
    this?.log?.info?.('    "video": {');
    this?.log?.info?.('      "codec": "%s"', this.video?.codec ?? 'unknown');
    this?.log?.info?.(
      '      "resolution": "%s"',
      typeof this.video?.width === 'number' && typeof this.video?.height === 'number'
        ? this.video.width + 'x' + this.video.height
        : 'waiting for video…',
    );
    this?.log?.info?.('      "fps": %s', typeof this.video?.fps === 'number' ? Math.round(this.video.fps) : 'null');
    this?.log?.info?.('      "bitrate": %s', typeof this.video?.bitrate === 'number' ? this.video.bitrate : 'null');
    this?.log?.info?.('    },');
    this?.log?.info?.('    "audio": {');
    this?.log?.info?.('      "codec": "%s"', this.audio?.codec ?? 'unknown');
    this?.log?.info?.('      "sampleRate": %s', typeof this.audio?.sampleRate === 'number' ? this.audio.sampleRate : 'null');
    this?.log?.info?.('      "channels": %s', typeof this.audio?.channels === 'number' ? this.audio.channels : 'null');
    this?.log?.info?.('      "bitrate": %s', typeof this.audio?.bitrate === 'number' ? this.audio.bitrate : 'null');
    this?.log?.info?.(
      '      "frameDuration": %s',
      typeof this.audio?.frameDuration === 'number' ? Math.round(this.audio.frameDuration) : 'null',
    );
    this?.log?.info?.('    },');
    this?.log?.info?.('    "items": {');
    this?.log?.info?.('      "video": %s', itemStats?.video ?? 0);
    this?.log?.info?.('      "audio": %s', itemStats?.audio ?? 0);
    this?.log?.info?.('      "keyframes": %s', itemStats?.keyframes ?? 0);
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
    this?.log?.info?.('    },');
    this?.log?.info?.('    "last": {');
    this?.log?.info?.('      "item": "%s"', age(sourceStats?.lastItemAt));
    this?.log?.info?.('      "video": "%s"', age(sourceStats?.lastVideoItemAt));
    this?.log?.info?.('      "audio": "%s"', age(sourceStats?.lastAudioItemAt));
    this?.log?.info?.('      "keyframeAge": "%s"', age(sourceStats?.lastKeyframeAt));
    this?.log?.info?.('    },');
    this?.log?.info?.('    "reconnects": %s', sourceStats?.reconnects ?? 0);
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
