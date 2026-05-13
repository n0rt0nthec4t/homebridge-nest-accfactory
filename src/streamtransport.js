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
//
// Typical transport lifecycle states:
// - CONNECTING
// - CONNECTED
// - READY
// - RECONNECTING
// - CLOSING
// - CLOSED
//
// Code version 2026.05.12
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { Buffer } from 'node:buffer';

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
      videoFrames: 0,
      audioFrames: 0,
      keyframes: 0,
    },
  };

  #state = StreamTransport.STATE.CLOSED; // Current transport lifecycle state

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

  // eslint-disable-next-line no-unused-vars
  async open(options = undefined) {
    // Override in transport implementation.
    // Used for establishing protocol/session connectivity.
  }

  async close() {
    // Override in transport implementation.
    // Used for shutting down protocol/session connectivity.
  }

  // eslint-disable-next-line no-unused-vars
  sendAudio(data) {
    // Override in transport implementation when talkback/audio send is supported.
  }

  // eslint-disable-next-line no-unused-vars
  async update(options = {}) {
    // Optional override in subclasses for dynamic transport configuration updates (e.g. bitrate changes).
  }

  emitMedia(media) {
    let now = Date.now();
    let gapMs = 0;

    // Emit only complete media frames.
    if (
      typeof media !== 'object' ||
      media === null ||
      (media.type !== 'video' && media.type !== 'audio' && media.type !== 'talk' && media.type !== 'meta') ||
      Buffer.isBuffer(media.data) !== true ||
      media.data.length === 0
    ) {
      return;
    }

    // Ensure media stats are initialised before updating counters.
    if (typeof this.stats?.media !== 'object' || this.stats.media === null) {
      this.resetMediaStats();
    }

    // Track transport video delivery stats before handing off to Streamer.
    if (media.type === 'video') {
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
    if (media.type === 'audio') {
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

  setState(type, reason = undefined) {
    let now = Date.now();

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
    }

    if (type === StreamTransport.STATE.CLOSED) {
      this.stats.lifecycle.closedAt = now;
    }

    this.#state = type;

    this?.log?.debug?.(
      'Stream transport is "%s" for uuid "%s"%s',
      type,
      this.uuid,
      typeof reason === 'string' && reason !== '' ? ' (' + reason + ')' : '',
    );

    // Forward transport state changes to the consumer.
    this?.consumer?.state?.(type, reason);
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

      // Totals.
      videoFrames: 0,
      audioFrames: 0,
      keyframes: 0,
    };
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
