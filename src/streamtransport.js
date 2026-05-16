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
// - Protocol authentication and signalling
// - Packet receive handling
// - Protocol-specific packet parsing
// - Media frame assembly
// - Transport-specific reconnect behaviour
// - Optional talkback/audio send support
//
// Transport implementations are expected to:
// - Emit complete media frames
// - Report transport state transitions
// - Handle protocol-specific recovery and reconnect logic
//
// Media emitted by transports should already be normalised and complete:
// - Video should be complete access units or NAL units
// - Audio should be complete codec frames
// - Partial RTP fragments or incomplete payloads should not be emitted
// - media.timestamp is source media time, not final HomeKit/output playout time
// - Output pacing, catch-up, and live latency policy are owned by Streamer
//
// Typical transport lifecycle states:
// - CONNECTING
// - CONNECTED
// - READY
// - RECONNECTING
// - CLOSING
// - CLOSED
//
// Code version 2026.05.16
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { Buffer } from 'node:buffer';

const VIDEO_FPS_LOG_CHANGE_THRESHOLD = 5; // Minimum rounded FPS change before logging updated stream media

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
  #reportedVideoMetadata = {
    width: undefined,
    height: undefined,
    fps: undefined,
    lastFPSLogTime: undefined,
  }; // Last video metadata values reported to debug logs

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
      media.bitrate = Number.isFinite(media.bitrate) === true ? media.bitrate : this.video.bitrate;
    }

    if (mediaType === 'audio') {
      media.profile = typeof media.profile === 'string' ? media.profile : this.audio.profile;
      media.sampleRate = Number.isFinite(media.sampleRate) === true ? media.sampleRate : this.audio.sampleRate;
      media.channels = Number.isFinite(media.channels) === true ? media.channels : this.audio.channels;
      media.bitrate = Number.isFinite(media.bitrate) === true ? media.bitrate : this.audio.bitrate;
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
    this?.consumer?.media?.(media);
  }

  setState(type, reason = undefined, context = undefined) {
    let now = Date.now();
    let details = undefined;
    let contextText = '';

    // setState(type, context) is accepted as a shorthand when there is no
    // failure/reconnect reason. This keeps call sites readable for normal
    // CONNECTING/CONNECTED/READY transitions that only add host/session detail.
    if (typeof reason === 'object' && reason !== null) {
      context = reason;
      reason = undefined;
    }

    // Context is optional diagnostic metadata for the shared lifecycle log only.
    // It is deliberately not forwarded to Streamer so the transport state
    // contract remains state + reason, while logs can still include protocol
    // details such as NexusTalk host redirects or WebRTC stream IDs.
    details = typeof context === 'object' && context !== null ? context : {};

    // Ignore invalid state values.
    if (Object.values(StreamTransport.STATE).includes(type) !== true) {
      return;
    }

    // Avoid duplicate state notifications.
    if (this.#state === type) {
      return;
    }

    // New transport session/recovery attempt.
    // Runtime media metadata and media timing stats should be relearned.
    if (type === StreamTransport.STATE.CONNECTING || type === StreamTransport.STATE.RECONNECTING) {
      this.resetMediaStats();
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

      if (typeof reason === 'string' && reason !== '') {
        this.stats.lifecycle.reconnectReasons[reason] = (this.stats.lifecycle.reconnectReasons[reason] ?? 0) + 1;
      }
    }

    if (type === StreamTransport.STATE.CLOSED) {
      this.stats.lifecycle.closedAt = now;
    }

    this.#state = type;

    // Fold protocol-specific lifecycle details into the single shared state
    // log line instead of having each transport emit extra connection logs.
    if (typeof details?.host === 'string' && details.host !== '') {
      contextText += ' on "' + details.host + '"';
    }

    if (typeof details?.fromHost === 'string' && details.fromHost !== '') {
      contextText += ' from "' + details.fromHost + '"';
    }

    if (typeof details?.toHost === 'string' && details.toHost !== '') {
      contextText += ' to "' + details.toHost + '"';
    }

    if (typeof details?.sessionId !== 'undefined' && details.sessionId !== null && String(details.sessionId) !== '') {
      contextText += ' with session ID "' + String(details.sessionId) + '"';
    }

    this?.log?.debug?.(
      'Stream transport is "%s" for uuid "%s"%s%s',
      type,
      this.uuid,
      contextText,
      typeof reason === 'string' && reason !== '' ? ' (' + reason + ')' : '',
    );

    // Forward transport state changes to the consumer.
    this?.consumer?.state?.(type, reason);
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
      Number.isFinite(previousWidth) === true &&
      Number.isFinite(previousHeight) === true &&
      Number.isFinite(previousRoundedFPS) === true;
    let resolutionChanged = hasReportedMetadata === true && (nextWidth !== previousWidth || nextHeight !== previousHeight);
    let fpsChanged = hasReportedMetadata === true && nextRoundedFPS !== previousRoundedFPS;
    let fpsLogDue =
      hasReportedMetadata !== true ||
      (fpsChanged === true &&
        Math.abs(nextRoundedFPS - previousRoundedFPS) >= VIDEO_FPS_LOG_CHANGE_THRESHOLD &&
        (typeof this.#reportedVideoMetadata.lastFPSLogTime !== 'number' ||
          now - this.#reportedVideoMetadata.lastFPSLogTime >= 30000));
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

  static getH264NALUnits(data) {
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

  static hasH264NAL(data, nalType) {
    for (let nalu of StreamTransport.getH264NALUnits(data)) {
      if (nalu.type === nalType) {
        return true;
      }
    }

    return false;
  }

  static getH264Resolution(sps) {
    let rbsp = undefined;
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
    let r = 0;
    let w = 0;
    let picOrderCntType = 0;
    let width = 0;
    let height = 0;

    // SPS NAL only.
    if (Buffer.isBuffer(sps) !== true || sps.length < 4 || (sps[0] & 0x1f) !== this.H264NALUS.TYPES.SPS) {
      return undefined;
    }

    try {
      // Strip emulation-prevention bytes (00 00 03) so we can read RBSP bits directly.
      rbsp = Buffer.allocUnsafe(sps.length);

      while (r < sps.length) {
        if (r + 2 < sps.length && sps[r] === 0x00 && sps[r + 1] === 0x00 && sps[r + 2] === 0x03) {
          rbsp[w++] = 0x00;
          rbsp[w++] = 0x00;
          r += 3;
          continue;
        }

        rbsp[w++] = sps[r++];
      }

      rbsp = rbsp.subarray(0, w);
      bitLength = rbsp.length * 8;

      // Bit reader helpers for Exp-Golomb coded SPS fields.
      let readBit = () => {
        let byteOffset = 0;
        let value = 0;

        if (bitOffset >= bitLength) {
          return 0;
        }

        byteOffset = bitOffset >> 3;
        value = (rbsp[byteOffset] >> (7 - (bitOffset & 0x07))) & 0x01;
        bitOffset++;

        return value;
      };

      let readBits = (count) => {
        let value = 0;

        while (count-- > 0) {
          value = (value << 1) | readBit();
        }

        return value >>> 0;
      };

      let readUE = () => {
        let zeros = 0;
        let value = 0;

        while (bitOffset < bitLength && readBit() === 0) {
          zeros++;
        }

        value = Math.pow(2, zeros) - 1;

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

      // High-profile SPS carries extra chroma / scaling-list fields.
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

        readUE(); // bit_depth_luma_minus8
        readUE(); // bit_depth_chroma_minus8
        readBit(); // qpprime_y_zero_transform_bypass_flag

        // seq_scaling_matrix_present_flag
        if (readBit() === 1) {
          let count = chromaFormatIdc !== 3 ? 8 : 12;
          let i = 0;

          while (i < count) {
            // seq_scaling_list_present_flag[i]
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

      // Skip picture order / reference frame fields until width/height fields.
      readUE(); // log2_max_frame_num_minus4
      picOrderCntType = readUE();

      if (picOrderCntType === 0) {
        readUE(); // log2_max_pic_order_cnt_lsb_minus4
      }

      if (picOrderCntType === 1) {
        let i = 0;
        let count = 0;

        readBit(); // delta_pic_order_always_zero_flag
        readSE(); // offset_for_non_ref_pic
        readSE(); // offset_for_top_to_bottom_field
        count = readUE(); // num_ref_frames_in_pic_order_cnt_cycle

        while (i < count) {
          readSE(); // offset_for_ref_frame[i]
          i++;
        }
      }

      readUE(); // max_num_ref_frames
      readBit(); // gaps_in_frame_num_value_allowed_flag

      // Frame dimensions in macroblocks.
      picWidthInMbsMinus1 = readUE();
      picHeightInMapUnitsMinus1 = readUE();
      frameMbsOnlyFlag = readBit();

      if (frameMbsOnlyFlag === 0) {
        readBit(); // mb_adaptive_frame_field_flag
      }

      readBit(); // direct_8x8_inference_flag

      // Optional frame cropping offsets.
      if (readBit() === 1) {
        frameCropLeftOffset = readUE();
        frameCropRightOffset = readUE();
        frameCropTopOffset = readUE();
        frameCropBottomOffset = readUE();
      }

      // Crop units depend on chroma format and whether picture is frame- or field-coded.
      if (chromaFormatIdc === 1 || chromaFormatIdc === 2) {
        cropUnitX = 2;
      }

      cropUnitY = chromaFormatIdc === 1 ? 2 * (2 - frameMbsOnlyFlag) : 2 - frameMbsOnlyFlag;

      // Return decoded display resolution only.
      width = (picWidthInMbsMinus1 + 1) * 16 - (frameCropLeftOffset + frameCropRightOffset) * cropUnitX;
      height = (2 - frameMbsOnlyFlag) * (picHeightInMapUnitsMinus1 + 1) * 16 - (frameCropTopOffset + frameCropBottomOffset) * cropUnitY;

      if (Number.isInteger(width) !== true || Number.isInteger(height) !== true || width <= 0 || height <= 0) {
        return undefined;
      }

      return {
        width: width,
        height: height,
      };
    } catch {
      return undefined;
    }
  }
}
