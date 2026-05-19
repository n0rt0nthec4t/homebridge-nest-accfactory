// StreamTransport
// Part of homebridge-nest-accfactory
//
// Base class for protocol-specific streaming transports.
//
// Provides a consistent transport boundary for stream sources such as
// WebRTC, NexusTalk, or future streaming implementations.
//
// Responsibilities:
// - Connection/session lifecycle management
// - Protocol authentication and signalling wrappers
// - Packet receive handling support
// - Protocol-specific packet parsing support
// - Media frame normalisation and emission
// - Transport-specific reconnect behaviour
// - Optional talkback/audio send support
// - Shared RTP/network jitter buffering helpers
// - Shared media metadata and delivery statistics
// - Shared media recovery state for packetised transports
//
// Transport implementations are expected to:
// - Implement doOpen(), doClose(), doUpdate(), and optionally doSendAudio()
// - Emit complete media frames through emitMedia()
// - Report transport state transitions through setState()
// - Handle protocol-specific recovery and reconnect logic
// - Use transport jitter helpers where packet reordering is needed
// - Use media state helpers where decoder recovery is needed
//
// Media emitted by transports should already be normalised and complete:
// - Video should be complete access units or complete NAL units
// - Audio should be complete codec frames
// - Partial RTP fragments or incomplete payloads should not be emitted
// - media.timestamp is source media time, not final HomeKit/output playout time
// - media.frameDuration may be supplied for audio when known
// - Output pacing, catch-up, and live latency policy are owned by Streamer
//
// Jitter helpers:
// - createJitterBuffer() creates sequence or timestamp-grouped jitter state
// - pushJitterPacket() inserts packets into a sequence or timestamp-grouped queue
// - releaseJitterPackets() releases ordered single-packet media
// - releaseJitterGroups() releases timestamp-grouped media
// - sortJitterGroupPackets() sorts grouped packets and detects sequence gaps
// - countJitterPackets() counts queued packets
// - sizeJitterBuffer() returns top-level jitter queue size
// - clearJitterBuffer() clears jitter state
// - Internal jitter helpers use cached queue item arrays to reduce allocation churn
// - Internal jitter sorting uses wraparound-aware RTP sequence/timestamp comparison
//
// Media recovery helpers:
// - getMediaState() returns built-in per-media recovery state
// - resetMediaState() resets one media recovery state or clears all media recovery states
// - markMediaIssue() records bad media events
// - markMediaFrame() records accepted clean media frames
// - canAcceptMediaFrame() decides whether a frame should currently be accepted
//
// Media metadata:
// - updateVideoMetadata() stores and rate-limits video metadata logging
// - emitMedia() normalises codec, timing, sequence, audio, and video metadata
// - H264 SPS metadata can be learned from complete emitted video frames
//
// Typical transport lifecycle states:
// - CONNECTING
// - CONNECTED
// - READY
// - RECONNECTING
// - CLOSING
// - CLOSED
//
// Code version 2026.05.18
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { Buffer } from 'node:buffer';

import H264 from './h264.js';
import RingBuffer from './ringbuffer.js';

const VIDEO_FPS_LOG_CHANGE_THRESHOLD = 5; // Minimum rounded FPS change before logging updated stream media
const RTP_SEQUENCE_WRAP = 0x10000; // Default 16-bit RTP sequence wrap value
const RTP_SEQUENCE_MASK = 0xffff; // Default 16-bit RTP sequence mask
const RTP_TIMESTAMP_WRAP = 0x100000000; // Default 32-bit RTP timestamp wrap value
const RTP_TIMESTAMP_MAX_DELTA = 0x7fffffff; // Default max positive RTP timestamp delta
const MEDIA_BAD_WINDOW_MS = 3000; // Default rolling window for media recovery events
const MEDIA_UNSTABLE_BAD_THRESHOLD = 4; // Default bad event count that enters unstable media state
const MEDIA_RECOVERING_CLEAN_TARGET = 6; // Default clean score needed to return to stable media state
const MEDIA_BITRATE_WINDOW_MS = 5000; // Rolling window used to estimate emitted media bitrate
const MEDIA_BITRATE_MIN_WINDOW_MS = 1000; // Minimum sample duration before reporting estimated bitrate

// StreamTransport object
export default class StreamTransport {
  static STATE = {
    CONNECTING: 'transport-connecting',
    CONNECTED: 'transport-connected',
    READY: 'transport-ready',
    RECONNECTING: 'transport-reconnecting',
    CLOSING: 'transport-closing',
    CLOSED: 'transport-closed',
  };

  static MEDIA_STATE = {
    STABLE: 'stable',
    UNSTABLE: 'unstable',
    RECOVERING: 'recovering',
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

  consumer = undefined; // Consumer callback interface
  log = undefined; // Logging function object
  uuid = undefined; // Transport/source device UUID used for logging

  video = {
    codec: undefined,
    profile: undefined,
    clockRate: undefined,
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
    // Optional fallback audio frame used when Streamer injects
    // transport-specific silence during offline/video-disabled states.
    blank: undefined,
  };

  talkback = {
    codec: undefined,
    sampleRate: undefined,
    channels: undefined,
  };

  stats = {
    lifecycle: {
      connectingAt: undefined,
      connectedAt: undefined,
      readyAt: undefined,
      closedAt: undefined,
      reconnects: 0,
      reconnectReasons: {},
    },

    media: {
      firstVideoAt: undefined,
      firstAudioAt: undefined,
      firstKeyframeAt: undefined,
      lastVideoAt: undefined,
      lastAudioAt: undefined,
      lastKeyframeAt: undefined,
      maxVideoGapMs: 0,
      maxAudioGapMs: 0,
      largeAudioGaps: 0,
      videoDrops: {},
      videoReorder: {
        defers: 0,
        fuTimestampDefers: 0,
        overflowDrops: 0,
      },
      audioSilenceFillFrames: 0,
      audioSilenceFillMs: 0,
      keyframeRequests: 0,
      videoFrames: 0,
      audioFrames: 0,
      keyframes: 0,
    },
  };

  #state = StreamTransport.STATE.CLOSED; // Current transport lifecycle state
  #mediaSequences = {}; // Per-media-type fallback sequence counters
  #mediaStates = {}; // Per-media recovery/acceptance state
  #reportedVideoMetadata = {
    width: undefined,
    height: undefined,
    fps: undefined,
    lastFPSLogTime: undefined,
  }; // Last video metadata values reported to debug logs

  #lastVideoMetadataTimestamp = undefined; // Last source video timestamp used for FPS learning
  #bitrateWindows = {}; // Per-media rolling byte counters for bitrate estimation

  constructor(options = {}) {
    // Optional consumer callback interface.
    this.consumer = typeof options?.consumer === 'object' && options.consumer !== null ? options.consumer : {};

    // Optional logger passed through by the owning device.
    this.log = options?.log;

    // Optional UUID for logging purposes (e.g. source device UUID).
    this.uuid = typeof options?.uuid === 'string' ? options.uuid : undefined;
  }

  get state() {
    // Current transport lifecycle state.
    return this.#state;
  }

  get connecting() {
    // True when transport connection establishment is in progress.
    return this.#state === StreamTransport.STATE.CONNECTING;
  }

  get connected() {
    // True when transport session exists but media is not yet ready.
    return this.#state === StreamTransport.STATE.CONNECTED;
  }

  get ready() {
    // True when transport has reported media-ready state.
    return this.#state === StreamTransport.STATE.READY;
  }

  get reconnecting() {
    // True when transport is attempting recovery after interruption.
    return this.#state === StreamTransport.STATE.RECONNECTING;
  }

  get closing() {
    // True when transport teardown is in progress.
    return this.#state === StreamTransport.STATE.CLOSING;
  }

  get closed() {
    // True when transport has fully closed.
    return this.#state === StreamTransport.STATE.CLOSED;
  }

  get codecs() {
    // Codecs produced/consumed by this transport.
    return {
      video: this.video.codec,
      audio: this.audio.codec,
      talkback: this.talkback.codec,
    };
  }

  async open(options = undefined) {
    // Public transport lifecycle API.
    // Streamer calls this wrapper; subclasses implement doOpen().
    // Do not override this method in protocol transports.
    try {
      return await this.doOpen(options);
    } catch (error) {
      this?.log?.debug?.('Stream transport open failed for uuid "%s": %s', this.uuid, error?.message || String(error));
    }
  }

  async close(...args) {
    // Public transport lifecycle API.
    // Streamer calls this wrapper; subclasses implement doClose().
    // Do not override this method in protocol transports.
    // Closing an already closed transport is a no-op. Shutdown paths can call
    // cleanup after live/recording output has already closed the source.
    if (this.closed === true) {
      return;
    }

    try {
      return await this.doClose(...args);
    } catch (error) {
      this?.log?.debug?.('Stream transport close failed for uuid "%s": %s', this.uuid, error?.message || String(error));
    }
  }

  async sendAudio(data) {
    // Public talkback/audio-send API.
    // Streamer calls this wrapper; subclasses implement doSendAudio().
    // Do not override this method in protocol transports.
    try {
      return await this.doSendAudio(data);
    } catch (error) {
      this?.log?.debug?.('Stream transport talkback send failed for uuid "%s": %s', this.uuid, error?.message || String(error));
    }
  }

  async update(options = {}) {
    // Public runtime configuration API.
    // Streamer calls this wrapper; subclasses implement doUpdate().
    // Do not override this method in protocol transports.
    try {
      return await this.doUpdate(options);
    } catch (error) {
      this?.log?.debug?.('Stream transport update failed for uuid "%s": %s', this.uuid, error?.message || String(error));
    }
  }

  async doOpen() {
    // Optional protocol hook called by open().
    // Used for establishing protocol/session connectivity.
  }

  async doClose() {
    // Optional protocol hook called by close().
    // Used for shutting down protocol/session connectivity.
  }

  async doSendAudio() {
    // Optional protocol hook called by sendAudio().
    // Implement when talkback/audio send is supported.
  }

  async doUpdate() {
    // Optional protocol hook called by update().
    // Used for dynamic transport configuration updates.
  }

  createJitterBuffer(options = {}) {
    // Create a per-stream jitter buffer state object.
    // This is deliberately a plain object so transports can keep separate
    // audio/video/retransmission buffers without introducing another exported class.
    return {
      groupByTimestamp: options.groupByTimestamp === true,
      delayMs: Number.isFinite(options.delayMs) === true ? options.delayMs : 0,
      maxPackets: Number.isFinite(options.maxPackets) === true && options.maxPackets > 0 ? options.maxPackets : 64,
      sequenceWrap: Number.isFinite(options.sequenceWrap) === true && options.sequenceWrap > 0 ? options.sequenceWrap : RTP_SEQUENCE_WRAP,
      sequenceMask: Number.isFinite(options.sequenceMask) === true && options.sequenceMask > 0 ? options.sequenceMask : RTP_SEQUENCE_MASK,
      timestampWrap:
        Number.isFinite(options.timestampWrap) === true && options.timestampWrap > 0 ? options.timestampWrap : RTP_TIMESTAMP_WRAP,
      timestampMaxDelta:
        Number.isFinite(options.timestampMaxDelta) === true && options.timestampMaxDelta > 0
          ? options.timestampMaxDelta
          : RTP_TIMESTAMP_MAX_DELTA,
      queue: new RingBuffer(
        0,
        Number.isFinite(options.maxPackets) === true && options.maxPackets > 0 ? options.maxPackets : 64,
        Number.isFinite(options.maxPackets) === true && options.maxPackets > 0 ? options.maxPackets : 64,
      ),
      lastReleasedSequence: undefined,
      lastReleasedTimestamp: undefined,
      lastDropLogTime: undefined,
    };
  }

  pushJitterPacket(jitter, packetInfo = {}) {
    // Push one packet into a jitter buffer.
    // groupByTimestamp buffers collect packets into timestamp groups, which is
    // useful for video access-unit assembly. Non-grouped buffers release packets
    // in sequence order, which is useful for audio.
    if (typeof jitter !== 'object' || jitter === null) {
      return false;
    }

    if (jitter.groupByTimestamp === true) {
      return this.#jitterPushGrouped(jitter, packetInfo);
    }

    return this.#jitterPushPacket(jitter, packetInfo);
  }

  releaseJitterPackets(jitter, force = false) {
    let now = Date.now();
    let released = [];
    let packet = undefined;
    let seqDelta = 0;
    let ageMs = 0;
    let releaseCount = 0;
    let queue = this.#jitterItems(jitter);

    // Release packets from a non-grouped jitter buffer in sequence order.
    if (typeof jitter !== 'object' || jitter === null || jitter.groupByTimestamp === true) {
      return released;
    }

    // Sort queued packets by RTP sequence with wraparound handling.
    queue.sort((left, right) => this.#jitterSort(jitter, left, right, 'sequenceNumber', jitter.sequenceWrap, jitter.sequenceWrap / 2));

    while (releaseCount < queue.length) {
      packet = queue[releaseCount];
      ageMs = now - (packet?.receivedAt || now);

      // Wait for jitter delay unless buffer is full or force requested.
      if (force !== true && ageMs < jitter.delayMs && queue.length < jitter.maxPackets) {
        break;
      }

      releaseCount++;

      // Skip duplicate or clearly stale/out-of-order packets.
      if (typeof jitter.lastReleasedSequence === 'number') {
        seqDelta = (packet.sequenceNumber - jitter.lastReleasedSequence + jitter.sequenceWrap) % jitter.sequenceWrap;

        if (seqDelta === 0 || seqDelta > jitter.sequenceWrap / 2) {
          continue;
        }
      }

      jitter.lastReleasedSequence = packet.sequenceNumber;
      jitter.lastReleasedTimestamp = packet.rtpTimestamp;
      released.push(packet);
    }

    // Remove released packets from jitter queue.
    if (releaseCount > 0) {
      queue.splice(0, releaseCount);
      this.#jitterReplace(jitter, queue);
    }

    return released;
  }

  releaseJitterGroups(jitter, options = {}) {
    let now = Date.now();
    let force = options.force === true;
    let isComplete = typeof options.isComplete === 'function' ? options.isComplete : () => true;
    let canWait = typeof options.canWait === 'function' ? options.canWait : () => false;
    let maxGroups = Number.isInteger(options.maxGroups) === true && options.maxGroups > 0 ? options.maxGroups : undefined;
    let maxPackets = Number.isInteger(options.maxPackets) === true && options.maxPackets > 0 ? options.maxPackets : undefined;
    let released = [];
    let group = undefined;
    let groupPackets = 0;
    let releasedPackets = 0;
    let queue = this.#jitterItems(jitter);

    // Release timestamp groups from a grouped jitter buffer.
    // Transport-specific code decides whether a group is complete enough to
    // release because protocols differ in how frame boundaries are represented.
    if (typeof jitter !== 'object' || jitter === null || jitter.groupByTimestamp !== true) {
      return released;
    }

    queue.sort((left, right) => this.#jitterSort(jitter, left, right, 'rtpTimestamp', jitter.timestampWrap, jitter.timestampMaxDelta));

    while (queue.length > 0) {
      group = queue[0];
      groupPackets = Array.isArray(group?.packets) === true ? group.packets.length : 0;

      if (force !== true && isComplete(group, now, jitter) !== true && canWait(group, now, jitter) === true) {
        break;
      }

      if (
        force !== true &&
        ((typeof maxGroups === 'number' && released.length >= maxGroups) ||
          (typeof maxPackets === 'number' && releasedPackets > 0 && releasedPackets + groupPackets > maxPackets))
      ) {
        break;
      }

      group = queue.shift();
      released.push(group);
      releasedPackets += groupPackets;
      jitter.lastReleasedTimestamp = group.rtpTimestamp;
    }

    this.#jitterReplace(jitter, queue);

    return released;
  }

  sortJitterGroupPackets(jitter, group) {
    let expectedSequence = undefined;

    // Sort a timestamp group once and cache whether a sequence gap exists.
    // This avoids repeated sort/gap scans during video jitter release checks.
    if (
      typeof jitter !== 'object' ||
      jitter === null ||
      typeof group !== 'object' ||
      group === null ||
      Array.isArray(group.packets) !== true
    ) {
      return false;
    }

    if (group.packetsSorted === true) {
      return group.hasSequenceGap === true;
    }

    group.packets.sort((left, right) =>
      this.#jitterSort(jitter, left, right, 'sequenceNumber', jitter.sequenceWrap, jitter.sequenceWrap / 2),
    );
    group.hasSequenceGap = false;

    for (let packet of group.packets) {
      if (typeof expectedSequence === 'number' && packet.sequenceNumber !== expectedSequence) {
        group.hasSequenceGap = true;
        break;
      }

      expectedSequence = (packet.sequenceNumber + 1) & jitter.sequenceMask;
    }

    group.packetsSorted = true;

    return group.hasSequenceGap === true;
  }

  countJitterPackets(jitter) {
    let count = 0;

    // Return total packets currently held by a jitter buffer.
    // For grouped video jitter this counts packets inside all timestamp groups.
    if (typeof jitter !== 'object' || jitter === null || jitter.queue instanceof RingBuffer !== true) {
      return 0;
    }

    if (jitter.groupByTimestamp !== true) {
      return jitter.queue.size;
    }

    for (let group of this.#jitterItems(jitter)) {
      count += Array.isArray(group?.packets) === true ? group.packets.length : 0;
    }

    return count;
  }

  sizeJitterBuffer(jitter) {
    // Return top-level jitter queue size.
    // For grouped buffers this is the number of timestamp groups, not packets.
    return typeof jitter === 'object' && jitter !== null && jitter.queue instanceof RingBuffer ? jitter.queue.size : 0;
  }

  clearJitterBuffer(jitter) {
    // Clear jitter state and release ordering anchors.
    if (typeof jitter !== 'object' || jitter === null) {
      return;
    }

    jitter.queue?.clear?.(0);
    jitter.lastReleasedSequence = undefined;
    jitter.lastReleasedTimestamp = undefined;
    jitter.lastDropLogTime = undefined;
  }

  getMediaState(name = 'video', options = {}) {
    // Return built-in recovery/acceptance state for a named media stream.
    // This keeps media recovery inside StreamTransport rather than requiring
    // each transport to create and store its own state object.
    name = typeof name === 'string' && name !== '' ? name : 'video';

    if (typeof this.#mediaStates[name] !== 'object' || this.#mediaStates[name] === null) {
      this.#mediaStates[name] = this.#createMediaState(options);
    }

    return this.#mediaStates[name];
  }

  resetMediaState(name = undefined) {
    let state = undefined;
    let options = {};

    // Reset one named media recovery state, or all media recovery state if no
    // name is supplied. The lifecycle state is not affected.
    if (typeof name === 'string' && name !== '') {
      state = this.getMediaState(name);

      options = {
        badWindowMs: state.badWindowMs,
        unstableBadThreshold: state.unstableBadThreshold,
        recoveringCleanTarget: state.recoveringCleanTarget,
      };

      this.#mediaStates[name] = this.#createMediaState(options);
      return this.#mediaStates[name];
    }

    this.#mediaStates = {};
    return this.#mediaStates;
  }

  markMediaIssue(name = 'video', type = '', options = {}) {
    let state = this.getMediaState(name, options);
    let now = Date.now();
    let isClamp = options?.clamp === true;
    let isBad = typeof options?.bad === 'boolean' ? options.bad : true;

    // Record a media issue and update media recovery state.
    // Protocols decide what should be considered a media issue.
    this.#normaliseMediaState(state);
    this.#pruneMediaStateEvents(state, now);

    if (isClamp === true && typeof options?.bad !== 'boolean') {
      // A single timestamp clamp is often harmless; repeated clamps or clamps
      // mixed with other bad events are treated as a health signal.
      isBad = state.clampEvents >= 1 || state.badNonClampEvents > 0;
    }

    state.events.push({
      time: now,
      type: typeof type === 'string' ? type : '',
      bad: isBad === true,
      clamp: isClamp === true,
    });

    if (isClamp === true) {
      state.clampEvents++;
    }

    if (isBad === true) {
      state.badEvents++;

      if (isClamp !== true) {
        state.badNonClampEvents++;
      }
    }

    if (state.state === StreamTransport.MEDIA_STATE.RECOVERING && isBad === true) {
      state.state = StreamTransport.MEDIA_STATE.UNSTABLE;
      state.cleanScore = 0;
      state.suppressDeltas = true;
      return state;
    }

    if (state.badEvents >= state.unstableBadThreshold && state.state !== StreamTransport.MEDIA_STATE.UNSTABLE) {
      state.state = StreamTransport.MEDIA_STATE.UNSTABLE;
      state.cleanScore = 0;
      state.suppressDeltas = true;
    }

    return state;
  }

  markMediaFrame(name = 'video', options = {}) {
    let state = this.getMediaState(name, options);
    let now = Date.now();
    let isKeyFrame = options?.keyFrame === true;

    // Record an accepted clean media frame. Keyframes can start recovery from
    // an unstable decoder state, and enough clean frames return media to stable.
    this.#normaliseMediaState(state);
    this.#pruneMediaStateEvents(state, now);

    if (state.state === StreamTransport.MEDIA_STATE.UNSTABLE && isKeyFrame === true) {
      state.state = StreamTransport.MEDIA_STATE.RECOVERING;
      state.suppressDeltas = true;
      state.cleanScore = 2;
      return state;
    }

    if (state.state === StreamTransport.MEDIA_STATE.RECOVERING) {
      state.cleanScore += isKeyFrame === true ? 2 : 1;

      if (state.cleanScore >= state.recoveringCleanTarget) {
        state.state = StreamTransport.MEDIA_STATE.STABLE;
        state.cleanScore = 0;
        state.suppressDeltas = false;
        state.events = [];
        state.eventsStart = 0;
        state.badEvents = 0;
        state.badNonClampEvents = 0;
        state.clampEvents = 0;
        state.lastSuppressedLogTime = undefined;
      }
    }

    return state;
  }

  canAcceptMediaFrame(name = 'video', options = {}) {
    let state = this.getMediaState(name, options);
    let isKeyFrame = options?.keyFrame === true;

    // Decide whether a media frame should be accepted while a stream is
    // recovering. This hides delta-frame suppression from protocol code.
    this.#normaliseMediaState(state);

    if (state.state === StreamTransport.MEDIA_STATE.STABLE) {
      return true;
    }

    if (isKeyFrame === true) {
      return true;
    }

    return state.suppressDeltas !== true;
  }

  #learnVideoMetadata(media) {
    let info = undefined;

    // Learn generic video metadata from complete frames at the transport boundary.
    // Protocol transports still own packet/frame assembly; this only inspects
    // already-emitted media so WebRTC and NexusTalk do not duplicate timing/SPS parsing.
    if (media?.type !== 'video' || Number.isFinite(media?.timestamp) !== true || Buffer.isBuffer(media?.data) !== true) {
      return;
    }

    // Estimate source FPS from accepted video frame timestamps. This is metadata
    // only; Streamer owns output pacing and may still smooth/drop/catch up.
    if (typeof this.#lastVideoMetadataTimestamp === 'number' && media.timestamp > this.#lastVideoMetadataTimestamp) {
      let frameDuration = media.timestamp - this.#lastVideoMetadataTimestamp;
      let instantFps = frameDuration > 0 ? 1000 / frameDuration : undefined;

      if (Number.isFinite(instantFps) === true && instantFps >= 1 && instantFps <= 60) {
        this.updateVideoMetadata({
          fps: Number.isFinite(this.video.fps) === true && this.video.fps > 0 ? this.video.fps * 0.8 + instantFps * 0.2 : instantFps,
        });
      }
    }

    this.#lastVideoMetadataTimestamp = media.timestamp;

    if (
      media?.codec === StreamTransport.CODEC_TYPE.H264 &&
      (Number.isFinite(media.width) !== true || Number.isFinite(media.height) !== true || media.keyFrame === true)
    ) {
      for (let nalu of H264.getNALUnits(media.data)) {
        if (nalu.type !== H264.NALUS.TYPES.SPS) {
          continue;
        }

        info = H264.getSPSInfo(nalu.data);

        if (Number.isFinite(info?.width) === true && Number.isFinite(info?.height) === true) {
          if (this.video.width !== info.width || this.video.height !== info.height) {
            this.updateVideoMetadata({
              width: info.width,
              height: info.height,
            });
          }

          media.width = info.width;
          media.height = info.height;
        }

        break;
      }
    }
  }

  #updateMediaBitrate(mediaType, byteLength, now, explicitBitrate = undefined) {
    let window = undefined;
    let elapsedMs = 0;
    let bitrate = undefined;
    let mediaInfo = mediaType === 'video' ? this.video : mediaType === 'audio' ? this.audio : undefined;

    // Prefer source-declared bitrate where available. Otherwise estimate from
    // bytes emitted through the shared transport boundary.
    if (typeof mediaInfo !== 'object' || mediaInfo === null) {
      return undefined;
    }

    if (Number.isFinite(explicitBitrate) === true && explicitBitrate > 0) {
      mediaInfo.bitrate = Math.round(explicitBitrate);
      return mediaInfo.bitrate;
    }

    if (
      mediaType === 'audio' &&
      mediaInfo.codec === StreamTransport.CODEC_TYPE.PCM &&
      Number.isFinite(mediaInfo.sampleRate) === true &&
      Number.isFinite(mediaInfo.channels) === true
    ) {
      // PCM bitrate is determined by sample format, not packet arrival cadence.
      mediaInfo.bitrate = Math.round(mediaInfo.sampleRate * mediaInfo.channels * 16);
      return mediaInfo.bitrate;
    }

    if (Number.isFinite(byteLength) !== true || byteLength <= 0 || Number.isFinite(now) !== true) {
      return Number.isFinite(mediaInfo.bitrate) === true ? mediaInfo.bitrate : undefined;
    }

    window = this.#bitrateWindows[mediaType];

    if (typeof window !== 'object' || window === null || Number.isFinite(window.startedAt) !== true) {
      window = { startedAt: now, bytes: 0 };
      this.#bitrateWindows[mediaType] = window;
    }

    window.bytes += byteLength;
    elapsedMs = now - window.startedAt;

    if (elapsedMs >= MEDIA_BITRATE_MIN_WINDOW_MS) {
      bitrate = Math.round((window.bytes * 8 * 1000) / elapsedMs);
      mediaInfo.bitrate = bitrate;
    }

    if (elapsedMs >= MEDIA_BITRATE_WINDOW_MS) {
      window.startedAt = now;
      window.bytes = 0;
    }

    return Number.isFinite(mediaInfo.bitrate) === true ? mediaInfo.bitrate : undefined;
  }

  emitMedia(media) {
    let now = Date.now();
    let gapMs = 0;
    let mediaType = undefined;
    let codec = undefined;

    // Emit only complete media frames.
    mediaType = typeof media?.type === 'string' ? media.type.toLowerCase() : undefined;

    if (
      typeof media !== 'object' ||
      media === null ||
      (mediaType !== 'video' && mediaType !== 'audio' && mediaType !== 'talk' && mediaType !== 'meta') ||
      Buffer.isBuffer(media.data) !== true ||
      media.data.length === 0
    ) {
      return;
    }

    // Normalise the transport media contract before handing frames to Streamer.
    // Timestamps are source media time; Streamer later maps them onto output playout time.
    codec =
      typeof media.codec === 'string' && media.codec.trim() !== ''
        ? media.codec.toLowerCase()
        : mediaType === 'video'
          ? this.video.codec
          : mediaType === 'audio'
            ? this.audio.codec
            : mediaType === 'talk'
              ? this.talkback.codec
              : mediaType === 'meta'
                ? StreamTransport.CODEC_TYPE.META
                : undefined;

    if (typeof this.#mediaSequences?.[mediaType] !== 'number') {
      this.#mediaSequences[mediaType] = 0;
    }

    media.type = mediaType;
    media.codec = typeof codec === 'string' && codec.trim() !== '' ? codec : media.codec;
    media.sequence = Number.isFinite(media.sequence) === true ? media.sequence : this.#mediaSequences[mediaType]++;
    media.timestamp = Number.isFinite(media.timestamp) === true ? Math.round(media.timestamp) : now;
    media.keyFrame = media.keyFrame === true;

    if (mediaType === 'video') {
      media.profile = typeof media.profile === 'string' ? media.profile : this.video.profile;
      media.width = Number.isFinite(media.width) === true ? media.width : this.video.width;
      media.height = Number.isFinite(media.height) === true ? media.height : this.video.height;
      media.fps = Number.isFinite(media.fps) === true ? media.fps : this.video.fps;
      media.bitrate = this.#updateMediaBitrate(mediaType, media.data.length, now, media.bitrate);
      this.#learnVideoMetadata(media);
      media.width = Number.isFinite(media.width) === true ? media.width : this.video.width;
      media.height = Number.isFinite(media.height) === true ? media.height : this.video.height;
      media.fps = Number.isFinite(media.fps) === true ? media.fps : this.video.fps;
      media.bitrate = Number.isFinite(media.bitrate) === true ? media.bitrate : this.video.bitrate;
    }

    if (mediaType === 'audio') {
      media.profile = typeof media.profile === 'string' ? media.profile : this.audio.profile;
      media.sampleRate = Number.isFinite(media.sampleRate) === true ? media.sampleRate : this.audio.sampleRate;
      media.channels = Number.isFinite(media.channels) === true ? media.channels : this.audio.channels;
      media.bitrate = this.#updateMediaBitrate(mediaType, media.data.length, now, media.bitrate);
      media.frameDuration = Number.isFinite(media.frameDuration) === true ? media.frameDuration : this.audio.frameDuration;
    }

    // Ensure media stats are initialised before updating counters.
    if (typeof this.stats?.media !== 'object' || this.stats.media === null) {
      this.resetMediaStats();
    }

    // Track transport video delivery stats before handing off to Streamer.
    if (mediaType === 'video') {
      if (typeof this.stats.media.firstVideoAt !== 'number') {
        this.stats.media.firstVideoAt = now;
      }

      if (typeof this.stats.media.lastVideoAt === 'number') {
        gapMs = now - this.stats.media.lastVideoAt;

        if (gapMs > this.stats.media.maxVideoGapMs) {
          this.stats.media.maxVideoGapMs = gapMs;
        }
      }

      this.stats.media.lastVideoAt = now;
      this.stats.media.videoFrames = (this.stats.media.videoFrames ?? 0) + 1;

      if (media.keyFrame === true) {
        if (typeof this.stats.media.firstKeyframeAt !== 'number') {
          this.stats.media.firstKeyframeAt = now;
        }

        this.stats.media.lastKeyframeAt = now;
        this.stats.media.keyframes = (this.stats.media.keyframes ?? 0) + 1;
      }
    }

    // Track transport audio delivery stats before handing off to Streamer.
    if (mediaType === 'audio') {
      if (typeof this.stats.media.firstAudioAt !== 'number') {
        this.stats.media.firstAudioAt = now;
      }

      if (typeof this.stats.media.lastAudioAt === 'number') {
        gapMs = now - this.stats.media.lastAudioAt;

        if (gapMs > this.stats.media.maxAudioGapMs) {
          this.stats.media.maxAudioGapMs = gapMs;
        }

        if (gapMs > 100) {
          this.stats.media.largeAudioGaps = (this.stats.media.largeAudioGaps ?? 0) + 1;
        }
      }

      this.stats.media.lastAudioAt = now;
      this.stats.media.audioFrames = (this.stats.media.audioFrames ?? 0) + 1;
    }

    // Emit a complete media frame to the consumer.
    try {
      this?.consumer?.media?.(media);
    } catch (error) {
      this?.log?.debug?.('Stream transport media consumer failed for uuid "%s": %s', this.uuid, error?.message || String(error));
    }
  }

  setState(type, options = {}) {
    let now = Date.now();
    let reason = typeof options?.reason === 'string' && options.reason !== '' ? options.reason : undefined;
    let contextText = '';

    // Context is optional diagnostic metadata for the shared lifecycle log only.
    // It is deliberately not forwarded to Streamer so the transport state
    // contract remains state + reason, while logs can still include protocol
    // details such as NexusTalk host redirects or WebRTC stream IDs.

    // Ignore invalid state values.
    if (Object.values(StreamTransport.STATE).includes(type) !== true) {
      this?.log?.warn?.('Invalid stream transport state "%s" for uuid "%s"', type, this.uuid);
      return false;
    }

    // Avoid duplicate state notifications.
    if (this.#state === type) {
      return false;
    }

    // New transport session/recovery attempt.
    // Runtime media metadata and media timing stats should be relearned.
    if (type === StreamTransport.STATE.CONNECTING || type === StreamTransport.STATE.RECONNECTING) {
      this.resetVideoMetadata();
      this.resetMediaStats();
      this.resetMediaState();
      this.#mediaSequences = {};
    }

    // Track transport lifecycle timing here, because StreamTransport owns state.
    if (type === StreamTransport.STATE.CONNECTING) {
      this.stats.lifecycle.connectingAt = now;
    }

    if (type === StreamTransport.STATE.CONNECTED) {
      this.stats.lifecycle.connectedAt = now;
    }

    if (type === StreamTransport.STATE.READY) {
      this.stats.lifecycle.readyAt = now;
    }

    if (type === StreamTransport.STATE.RECONNECTING) {
      this.stats.lifecycle.reconnects++;

      if (typeof this.stats.lifecycle.reconnectReasons !== 'object' || this.stats.lifecycle.reconnectReasons === null) {
        this.stats.lifecycle.reconnectReasons = {};
      }

      if (reason !== undefined) {
        this.stats.lifecycle.reconnectReasons[reason] = (this.stats.lifecycle.reconnectReasons[reason] ?? 0) + 1;
      }
    }

    if (type === StreamTransport.STATE.CLOSED) {
      this.stats.lifecycle.closedAt = now;
    }

    this.#state = type;

    // Fold protocol-specific lifecycle details into the single shared state
    // log line instead of having each transport emit extra connection logs.
    if (typeof options?.host === 'string' && options.host !== '') {
      contextText += ' on "' + options.host + '"';
    }

    if (typeof options?.fromHost === 'string' && options.fromHost !== '') {
      contextText += ' from "' + options.fromHost + '"';
    }

    if (typeof options?.toHost === 'string' && options.toHost !== '') {
      contextText += ' to "' + options.toHost + '"';
    }

    if (typeof options?.sessionId !== 'undefined' && options.sessionId !== null && String(options.sessionId) !== '') {
      contextText += ' with session ID "' + String(options.sessionId) + '"';
    }

    this?.log?.debug?.(
      'Stream transport is "%s" for uuid "%s"%s%s',
      type,
      this.uuid,
      contextText,
      reason !== undefined ? ' (' + reason + ')' : '',
    );

    // Forward transport state changes to the consumer.
    this?.consumer?.state?.(type, reason);

    return true;
  }

  updateVideoMetadata(metadata = {}) {
    let now = Date.now();
    let previousWidth = this.#reportedVideoMetadata.width;
    let previousHeight = this.#reportedVideoMetadata.height;
    let previousFPS = this.#reportedVideoMetadata.fps;
    let nextWidth = Number.isFinite(metadata?.width) === true && metadata.width > 0 ? metadata.width : this.video.width;
    let nextHeight = Number.isFinite(metadata?.height) === true && metadata.height > 0 ? metadata.height : this.video.height;
    let nextFPS = Number.isFinite(metadata?.fps) === true && metadata.fps > 0 ? metadata.fps : this.video.fps;
    let nextRoundedFPS = Number.isFinite(nextFPS) === true && nextFPS > 0 ? Math.round(nextFPS) : undefined;
    let previousRoundedFPS = Number.isFinite(previousFPS) === true && previousFPS > 0 ? Math.round(previousFPS) : undefined;
    let hasCompleteMetadata =
      Number.isFinite(nextWidth) === true && Number.isFinite(nextHeight) === true && Number.isFinite(nextRoundedFPS) === true;
    let hasReportedMetadata =
      Number.isFinite(previousWidth) === true && Number.isFinite(previousHeight) === true && Number.isFinite(previousRoundedFPS) === true;
    let resolutionChanged = hasReportedMetadata === true && (nextWidth !== previousWidth || nextHeight !== previousHeight);
    let fpsChanged = hasReportedMetadata === true && nextRoundedFPS !== previousRoundedFPS;
    let fpsLogDue =
      hasReportedMetadata !== true ||
      (fpsChanged === true &&
        Math.abs(nextRoundedFPS - previousRoundedFPS) >= VIDEO_FPS_LOG_CHANGE_THRESHOLD &&
        (typeof this.#reportedVideoMetadata.lastFPSLogTime !== 'number' || now - this.#reportedVideoMetadata.lastFPSLogTime >= 30000));
    let description = nextWidth + 'x' + nextHeight + ' @ ' + nextRoundedFPS + 'fps';
    let action = hasReportedMetadata === true ? 'changed to' : 'is';

    // Store current transport metadata regardless of whether it is noisy enough
    // to report. Streamer and support dumps should see the freshest values.
    this.video.width = nextWidth;
    this.video.height = nextHeight;
    this.video.fps = nextFPS;

    // Avoid partial startup logs such as resolution first, then FPS. Report the
    // complete media shape once, then report meaningful changes using all fields.
    if (hasCompleteMetadata !== true) {
      return;
    }

    if (hasReportedMetadata === true && resolutionChanged !== true && fpsLogDue !== true) {
      return;
    }

    this?.log?.debug?.('Stream transport media %s %s for uuid "%s"', action, description, this.uuid);

    this.#reportedVideoMetadata.width = nextWidth;
    this.#reportedVideoMetadata.height = nextHeight;
    this.#reportedVideoMetadata.fps = nextFPS;
    this.#reportedVideoMetadata.lastFPSLogTime = now;
  }

  resetVideoMetadata() {
    // Clear session-learned video shape so the next emitted frames can relearn it
    // from SPS/timing and report fresh media metadata for the new stream.
    this.video.width = undefined;
    this.video.height = undefined;
    this.video.fps = undefined;
    this.#lastVideoMetadataTimestamp = undefined;
    this.#reportedVideoMetadata.width = undefined;
    this.#reportedVideoMetadata.height = undefined;
    this.#reportedVideoMetadata.fps = undefined;
    this.#reportedVideoMetadata.lastFPSLogTime = undefined;
  }

  hasConsumers() {
    // True when there are active consumers of this transport's media.
    return this.consumer?.active?.() === true;
  }

  resetMediaStats() {
    this.stats.media = {
      // First successful media arrival after connection/reconnect.
      firstVideoAt: undefined,
      firstAudioAt: undefined,
      firstKeyframeAt: undefined,

      // Last media seen.
      lastVideoAt: undefined,
      lastAudioAt: undefined,
      lastKeyframeAt: undefined,

      // Gap/jitter diagnostics.
      maxVideoGapMs: 0,
      maxAudioGapMs: 0,

      // Audio continuity indicators.
      largeAudioGaps: 0,

      // Transport-level recovery/quality indicators.
      videoDrops: {},
      videoReorder: {
        defers: 0,
        fuTimestampDefers: 0,
        overflowDrops: 0,
      },
      audioSilenceFillFrames: 0,
      audioSilenceFillMs: 0,
      keyframeRequests: 0,

      // Totals.
      videoFrames: 0,
      audioFrames: 0,
      keyframes: 0,
    };

    this.#bitrateWindows = {};
  }

  recordVideoDrop(reason = 'unknown') {
    if (typeof this.stats?.media !== 'object' || this.stats.media === null) {
      this.resetMediaStats();
    }

    if (typeof this.stats.media.videoDrops !== 'object' || this.stats.media.videoDrops === null) {
      this.stats.media.videoDrops = {};
    }

    reason = typeof reason === 'string' && reason !== '' ? reason : 'unknown';
    this.stats.media.videoDrops[reason] = (this.stats.media.videoDrops[reason] ?? 0) + 1;
  }

  recordVideoReorder(type = 'defers') {
    if (typeof this.stats?.media !== 'object' || this.stats.media === null) {
      this.resetMediaStats();
    }

    if (typeof this.stats.media.videoReorder !== 'object' || this.stats.media.videoReorder === null) {
      this.stats.media.videoReorder = {
        defers: 0,
        fuTimestampDefers: 0,
        overflowDrops: 0,
      };
    }

    if (typeof this.stats.media.videoReorder[type] !== 'number') {
      this.stats.media.videoReorder[type] = 0;
    }

    this.stats.media.videoReorder[type]++;
  }

  recordAudioSilenceFill(durationMs = 0) {
    if (typeof this.stats?.media !== 'object' || this.stats.media === null) {
      this.resetMediaStats();
    }

    this.stats.media.audioSilenceFillFrames = (this.stats.media.audioSilenceFillFrames ?? 0) + 1;
    this.stats.media.audioSilenceFillMs += Number.isFinite(durationMs) === true && durationMs > 0 ? durationMs : 0;
  }

  recordKeyframeRequest() {
    if (typeof this.stats?.media !== 'object' || this.stats.media === null) {
      this.resetMediaStats();
    }

    this.stats.media.keyframeRequests = (this.stats.media.keyframeRequests ?? 0) + 1;
  }

  #createMediaState(options = {}) {
    // Create reusable media recovery state for transports that need bad-event
    // windows and clean-frame recovery.
    return {
      state: StreamTransport.MEDIA_STATE.STABLE,
      events: [],
      eventsStart: 0,
      badEvents: 0,
      badNonClampEvents: 0,
      clampEvents: 0,
      cleanScore: 0,
      suppressDeltas: false,
      lastSuppressedLogTime: undefined,
      badWindowMs: Number.isFinite(options?.badWindowMs) === true && options.badWindowMs > 0 ? options.badWindowMs : MEDIA_BAD_WINDOW_MS,
      unstableBadThreshold:
        Number.isFinite(options?.unstableBadThreshold) === true && options.unstableBadThreshold > 0
          ? options.unstableBadThreshold
          : MEDIA_UNSTABLE_BAD_THRESHOLD,
      recoveringCleanTarget:
        Number.isFinite(options?.recoveringCleanTarget) === true && options.recoveringCleanTarget > 0
          ? options.recoveringCleanTarget
          : MEDIA_RECOVERING_CLEAN_TARGET,
    };
  }

  #normaliseMediaState(state) {
    // Backfill/repair a media state object so callers can safely keep state
    // across reconnects and incremental upgrades.
    if (Array.isArray(state.events) !== true) {
      state.events = [];
    }

    if (Number.isInteger(state.eventsStart) !== true || state.eventsStart < 0) {
      state.eventsStart = 0;
    }

    if (Number.isInteger(state.badEvents) !== true || state.badEvents < 0) {
      state.badEvents = 0;
    }

    if (Number.isInteger(state.badNonClampEvents) !== true || state.badNonClampEvents < 0) {
      state.badNonClampEvents = 0;
    }

    if (Number.isInteger(state.clampEvents) !== true || state.clampEvents < 0) {
      state.clampEvents = 0;
    }

    if (Object.values(StreamTransport.MEDIA_STATE).includes(state.state) !== true) {
      state.state = StreamTransport.MEDIA_STATE.STABLE;
    }

    if (Number.isFinite(state.cleanScore) !== true || state.cleanScore < 0) {
      state.cleanScore = 0;
    }

    if (typeof state.suppressDeltas !== 'boolean') {
      state.suppressDeltas = false;
    }

    state.badWindowMs = Number.isFinite(state.badWindowMs) === true && state.badWindowMs > 0 ? state.badWindowMs : MEDIA_BAD_WINDOW_MS;
    state.unstableBadThreshold =
      Number.isFinite(state.unstableBadThreshold) === true && state.unstableBadThreshold > 0
        ? state.unstableBadThreshold
        : MEDIA_UNSTABLE_BAD_THRESHOLD;
    state.recoveringCleanTarget =
      Number.isFinite(state.recoveringCleanTarget) === true && state.recoveringCleanTarget > 0
        ? state.recoveringCleanTarget
        : MEDIA_RECOVERING_CLEAN_TARGET;
  }

  #pruneMediaStateEvents(state, now = Date.now()) {
    // Expire old media state events without reallocating on every packet.
    let expired = undefined;

    while (state.eventsStart < state.events.length) {
      expired = state.events[state.eventsStart];

      if (typeof expired?.time !== 'number' || now - expired.time <= state.badWindowMs) {
        break;
      }

      if (expired.bad === true) {
        state.badEvents = Math.max(0, state.badEvents - 1);

        if (expired.clamp !== true) {
          state.badNonClampEvents = Math.max(0, state.badNonClampEvents - 1);
        }
      }

      if (expired.clamp === true) {
        state.clampEvents = Math.max(0, state.clampEvents - 1);
      }

      state.eventsStart++;
    }

    if (state.eventsStart > 0 && (state.eventsStart >= 64 || state.eventsStart * 2 >= state.events.length)) {
      state.events = state.events.slice(state.eventsStart);
      state.eventsStart = 0;
    }
  }

  #jitterPushPacket(jitter, packetInfo = {}) {
    let sequenceNumber = Number.isInteger(packetInfo.sequenceNumber) === true ? packetInfo.sequenceNumber & jitter.sequenceMask : undefined;
    let seqDelta = 0;
    let queue = this.#jitterItems(jitter);

    // Insert a packet into a sequence-ordered jitter buffer.
    if (typeof sequenceNumber !== 'number') {
      return false;
    }

    if (typeof jitter.lastReleasedSequence === 'number') {
      seqDelta = (sequenceNumber - jitter.lastReleasedSequence + jitter.sequenceWrap) % jitter.sequenceWrap;

      if (seqDelta === 0 || seqDelta > jitter.sequenceWrap / 2) {
        return false;
      }
    }

    for (let packet of queue) {
      if (packet?.sequenceNumber === sequenceNumber) {
        return false;
      }
    }

    queue.push({
      ...packetInfo,
      sequenceNumber: sequenceNumber,
      receivedAt: Number.isFinite(packetInfo.receivedAt) === true ? packetInfo.receivedAt : Date.now(),
    });

    while (queue.length > jitter.maxPackets) {
      queue.shift();
    }

    this.#jitterReplace(jitter, queue);

    return true;
  }

  #jitterPushGrouped(jitter, packetInfo = {}) {
    let rtpTimestamp = Number.isInteger(packetInfo.rtpTimestamp) === true ? packetInfo.rtpTimestamp >>> 0 : undefined;
    let sequenceNumber = Number.isInteger(packetInfo.sequenceNumber) === true ? packetInfo.sequenceNumber & jitter.sequenceMask : undefined;
    let receivedAt = Number.isFinite(packetInfo.receivedAt) === true ? packetInfo.receivedAt : Date.now();
    let group = undefined;
    let timestampDelta = 0;
    let queue = this.#jitterItems(jitter);
    let packetCount = 0;

    // Insert a packet into a timestamp-grouped jitter buffer.
    if (typeof rtpTimestamp !== 'number' || typeof sequenceNumber !== 'number') {
      return false;
    }

    if (typeof jitter.lastReleasedTimestamp === 'number') {
      timestampDelta = (rtpTimestamp - jitter.lastReleasedTimestamp + jitter.timestampWrap) % jitter.timestampWrap;

      if (timestampDelta === 0 || timestampDelta > jitter.timestampMaxDelta) {
        return false;
      }
    }

    for (let entry of queue) {
      if (entry?.rtpTimestamp === rtpTimestamp) {
        group = entry;
        break;
      }
    }

    if (group === undefined) {
      group = {
        rtpTimestamp: rtpTimestamp,
        firstReceivedAt: receivedAt,
        lastReceivedAt: receivedAt,
        markerSeen: false,
        hasSequenceGap: false,
        packetsSorted: false,
        packets: [],
      };

      queue.push(group);
    }

    for (let packet of group.packets) {
      if (packet?.sequenceNumber === sequenceNumber) {
        return false;
      }
    }

    group.firstReceivedAt = Math.min(group.firstReceivedAt, receivedAt);
    group.lastReceivedAt = Math.max(group.lastReceivedAt, receivedAt);
    group.markerSeen = group.markerSeen === true || packetInfo.marker === true;
    group.packetsSorted = false;

    // Protocol-specific grouped metadata can be supplied in packetInfo.group.
    // Boolean flags accumulate across packets so later fragments cannot clear
    // facts learned from earlier packets in the same timestamp group.
    if (typeof packetInfo.group === 'object' && packetInfo.group !== null) {
      for (let [key, value] of Object.entries(packetInfo.group)) {
        group[key] = typeof value === 'boolean' ? group[key] === true || value === true : value;
      }
    }

    group.packets.push({
      ...packetInfo,
      sequenceNumber: sequenceNumber,
      rtpTimestamp: rtpTimestamp,
      receivedAt: receivedAt,
    });

    for (let entry of queue) {
      packetCount += Array.isArray(entry?.packets) === true ? entry.packets.length : 0;
    }

    while (packetCount > jitter.maxPackets && queue.length > 0) {
      packetCount -= Array.isArray(queue[0]?.packets) === true ? queue[0].packets.length : 0;
      queue.shift();
    }

    this.#jitterReplace(jitter, queue);

    return true;
  }

  #jitterSort(jitter, left, right, field, wrap, maxDelta) {
    // Push invalid entries to the end of the sort order.
    if (typeof left?.[field] !== 'number') {
      return 1;
    }

    if (typeof right?.[field] !== 'number') {
      return -1;
    }

    // Stable ordering for identical values.
    if (left[field] === right[field]) {
      return 0;
    }

    // Compare values using wraparound-aware ordering.
    // This handles RTP sequence number and timestamp rollover.
    return (right[field] - left[field] + wrap) % wrap < maxDelta ? -1 : 1;
  }

  #jitterItems(jitter) {
    let index = 0;

    // Invalid jitter state or queue unavailable.
    if (typeof jitter !== 'object' || jitter === null || jitter.queue instanceof RingBuffer !== true) {
      return [];
    }

    // Reuse a cached array to avoid repeated allocations during
    // frequent jitter-buffer operations.
    if (Array.isArray(jitter.items) !== true) {
      jitter.items = [];
    }

    // Match the current queue size so removed items are discarded.
    jitter.items.length = jitter.queue.size;

    // Refresh cached items from the RingBuffer.
    while (index < jitter.queue.size) {
      jitter.items[index] = jitter.queue.getByOffset(index);
      index++;
    }

    return jitter.items;
  }

  #jitterReplace(jitter, items = []) {
    let index = 0;

    // Invalid jitter state.
    if (typeof jitter !== 'object' || jitter === null) {
      return;
    }

    // Ensure jitter queue exists.
    if (jitter.queue instanceof RingBuffer !== true) {
      jitter.queue = new RingBuffer(0, jitter.maxPackets, jitter.maxPackets);
    }

    // Replace queue contents with the supplied ordered items.
    jitter.queue.clear(0);

    while (index < items.length) {
      jitter.queue.push(items[index]);
      index++;
    }

    // Refresh cached jitter items reference so future reads
    // avoid rebuilding arrays unnecessarily.
    jitter.items = items;
  }
}
