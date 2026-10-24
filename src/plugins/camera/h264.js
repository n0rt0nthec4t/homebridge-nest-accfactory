// H264 helpers
// Part of homebridge-nest-accfactory
//
// H264 byte and RTP payload helpers shared by transports and output code.
//
// Provides:
// - Annex-B and raw single-NAL parsing
// - SPS profile, level, chroma format, and display-resolution parsing
// - RTP payload inspection, timestamp-group completeness and FU-A reconstruction
//
// Callers own packet ordering, access-unit assembly, decoder recovery, source
// lifecycle, media timing and output pacing. RTP reconstruction updates only the
// fragment state supplied by the caller; it does not own a transport session.
//
// Code version 2026.10.24
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { Buffer } from 'node:buffer';

// H264 utility object
export default class H264 {
  static NALUS = {
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

  // NAL parsing
  static getNALUnits(data) {
    let nalUnits = [];
    let index = 0;
    let naluStart = -1;
    let naluEnd = -1;
    let startCodeLength = 0;

    // Return raw buffers as one NAL when no Annex-B start code is present.
    if (Buffer.isBuffer(data) !== true || data.length === 0) {
      return nalUnits;
    }

    if (
      data.length < 3 ||
      data[0] !== 0x00 ||
      data[1] !== 0x00 ||
      (data[2] !== 0x01 && (data.length < 4 || data[2] !== 0x00 || data[3] !== 0x01))
    ) {
      return [{ type: data[0] & 0x1f, data: data }];
    }

    startCodeLength = data[2] === 0x01 ? 3 : 4;
    index = startCodeLength;
    naluStart = index;

    // Single-pass scan for subsequent 3-byte or 4-byte Annex-B start codes.
    while (index <= data.length - 3) {
      if (data[index] === 0x00 && data[index + 1] === 0x00 && data[index + 2] === 0x01) {
        naluEnd = index;

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

      if (
        index <= data.length - 4 &&
        data[index] === 0x00 &&
        data[index + 1] === 0x00 &&
        data[index + 2] === 0x00 &&
        data[index + 3] === 0x01
      ) {
        naluEnd = index;

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

    if (naluStart < data.length) {
      nalUnits.push({
        type: data[naluStart] & 0x1f,
        data: data.subarray(naluStart),
      });
    }

    return nalUnits;
  }

  // SPS metadata
  static getSPSInfo(sps) {
    let rbsp = undefined;
    let bitOffset = 0;
    let bitLength = 0;
    let profileIdc = 0;
    let levelIdc = 0;
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
    let truncated = false;

    // Decode display size and basic profile metadata from one SPS NAL payload.
    if (Buffer.isBuffer(sps) !== true || sps.length < 4 || (sps[0] & 0x1f) !== H264.NALUS.TYPES.SPS) {
      return undefined;
    }

    try {
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

      // Minimal SPS bit reader for Exp-Golomb coded fields. Reads fail closed:
      // a truncated SPS returns undefined instead of inventing zero bits.
      let readBit = () => {
        let byteOffset = 0;
        let value = 0;

        if (bitOffset >= bitLength) {
          truncated = true;
          return 0;
        }

        byteOffset = bitOffset >> 3;
        value = (rbsp[byteOffset] >> (7 - (bitOffset & 0x07))) & 0x01;
        bitOffset++;

        return value;
      };

      let readBits = (count) => {
        let value = 0;

        if (count < 0 || bitOffset + count > bitLength) {
          truncated = true;
          return 0;
        }

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

        if (truncated === true) {
          return 0;
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
      readBits(8); // constraint_set_flags
      levelIdc = readBits(8); // level_idc
      readUE(); // seq_parameter_set_id

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

      picWidthInMbsMinus1 = readUE();
      picHeightInMapUnitsMinus1 = readUE();
      frameMbsOnlyFlag = readBit();

      if (frameMbsOnlyFlag === 0) {
        readBit(); // mb_adaptive_frame_field_flag
      }

      readBit(); // direct_8x8_inference_flag

      if (readBit() === 1) {
        frameCropLeftOffset = readUE();
        frameCropRightOffset = readUE();
        frameCropTopOffset = readUE();
        frameCropBottomOffset = readUE();
      }

      if (chromaFormatIdc === 1 || chromaFormatIdc === 2) {
        cropUnitX = 2;
      }

      cropUnitY = chromaFormatIdc === 1 ? 2 * (2 - frameMbsOnlyFlag) : 2 - frameMbsOnlyFlag;
      width = (picWidthInMbsMinus1 + 1) * 16 - (frameCropLeftOffset + frameCropRightOffset) * cropUnitX;
      height = (2 - frameMbsOnlyFlag) * (picHeightInMapUnitsMinus1 + 1) * 16 - (frameCropTopOffset + frameCropBottomOffset) * cropUnitY;

      if (truncated === true || Number.isInteger(width) !== true || Number.isInteger(height) !== true || width <= 0 || height <= 0) {
        return undefined;
      }

      return {
        width: width,
        height: height,
        profileIdc: profileIdc,
        levelIdc: levelIdc,
        chromaFormatIdc: chromaFormatIdc,
      };
    } catch {
      return undefined;
    }
  }

  // RTP payload inspection and fragment reconstruction
  static resetFragmentState(state) {
    // Clear only the in-progress FU-A reconstruction fields. Callers keep
    // pending access-unit state, recovery state, and timing policy outside here.
    if (typeof state !== 'object' || state === null) {
      return;
    }

    state.fuParts = [];
    state.fuBytes = 0;
    state.fuNalType = 0;
    state.fuRtpTimestamp = undefined;
    state.fuFirstPacketTime = undefined;
    state.fuLastSequence = undefined;
  }

  static getPayloadInfo(payload) {
    let info = {
      hasKeyFrame: false,
      hasFragmentedNal: false,
      hasFragmentStart: false,
      hasFragmentEnd: false,
    };
    let nalType = 0;
    let stapOffset = 0;
    let stapLength = 0;
    let stapNal = undefined;

    // Inspect one RTP H264 payload for jitter/reorder decisions only.
    if (Buffer.isBuffer(payload) !== true || payload.length === 0) {
      return info;
    }

    nalType = payload[0] & 0x1f;

    if (nalType === H264.NALUS.TYPES.IDR) {
      info.hasKeyFrame = true;
      return info;
    }

    if (nalType === H264.NALUS.TYPES.FU_A && payload.length >= 2) {
      info.hasFragmentedNal = true;
      info.hasFragmentStart = (payload[1] & 0x80) === 0x80;
      info.hasFragmentEnd = (payload[1] & 0x40) === 0x40;
      info.hasKeyFrame = (payload[1] & 0x1f) === H264.NALUS.TYPES.IDR;
      return info;
    }

    if (nalType === H264.NALUS.TYPES.STAP_A) {
      stapOffset = 1;

      while (stapOffset + 2 <= payload.length) {
        stapLength = payload.readUInt16BE(stapOffset);
        stapOffset += 2;

        if (stapLength <= 0 || stapOffset + stapLength > payload.length) {
          break;
        }

        stapNal = payload.subarray(stapOffset, stapOffset + stapLength);
        stapOffset += stapLength;

        if (stapNal.length > 0 && (stapNal[0] & 0x1f) === H264.NALUS.TYPES.IDR) {
          info.hasKeyFrame = true;
          break;
        }
      }
    }

    return info;
  }

  static isTimestampGroupComplete(group, hasSequenceGap = false) {
    // H264 RTP timestamp groups are complete once marker is seen. FU-A groups
    // also require start/end fragments and continuous RTP sequence order.
    if (typeof group !== 'object' || group === null) {
      return false;
    }

    if (group.hasFragmentedNal === true) {
      return group.markerSeen === true && group.hasFragmentStart === true && group.hasFragmentEnd === true && hasSequenceGap !== true;
    }

    return group.markerSeen === true;
  }

  static acceptFuA(state, payload, context = {}) {
    let sequenceNumber = Number.isInteger(context.sequenceNumber) === true ? context.sequenceNumber : 0;
    let rtpTimestamp = Number.isInteger(context.rtpTimestamp) === true ? context.rtpTimestamp >>> 0 : 0;
    let receivedAt = Number.isFinite(context.receivedAt) === true ? context.receivedAt : Date.now();
    let sequenceMask = Number.isInteger(context.sequenceMask) === true ? context.sequenceMask : 0xffff;
    let nalHeader = Buffer.isBuffer(payload) === true && payload.length > 0 ? payload[0] : 0;
    let nri = nalHeader & 0x60;
    let fuHeader = 0;
    let fuStart = false;
    let fuEnd = false;
    let fuNalType = 0;
    let fuNalHeader = 0;
    let fragment = undefined;
    let fuPart = undefined;
    let expectedSequenceNumber = undefined;
    let interrupted = false;
    let previousNalType = 0;
    let previousParts = 0;

    // Rebuild one FU-A fragmented NAL while leaving stream recovery decisions
    // to the caller. The returned reason tells the transport what happened.
    if (typeof state !== 'object' || state === null || Buffer.isBuffer(payload) !== true || payload.length < 2) {
      return { ok: false, reason: 'invalid' };
    }

    fuHeader = payload[1];
    fuStart = (fuHeader & 0x80) === 0x80;
    fuEnd = (fuHeader & 0x40) === 0x40;
    fuNalType = fuHeader & 0x1f;
    fuNalHeader = nri | fuNalType;
    fragment = payload.subarray(2);

    if (Buffer.isBuffer(fragment) !== true || fragment.length === 0) {
      return { ok: false, reason: 'invalid', nalType: fuNalType, start: fuStart, end: fuEnd };
    }

    if (fuStart === true) {
      interrupted = Array.isArray(state.fuParts) === true && state.fuParts.length > 0;
      previousNalType = Number.isInteger(state.fuNalType) === true ? state.fuNalType : 0;
      previousParts = Array.isArray(state.fuParts) === true ? state.fuParts.length : 0;

      H264.resetFragmentState(state);
      state.fuRtpTimestamp = rtpTimestamp;
      state.fuNalType = fuNalType;
      state.fuFirstPacketTime = receivedAt;
      state.fuLastSequence = sequenceNumber;

      // Reconstruct only the NAL header; the core retains NALs without Annex-B framing.
      fuPart = Buffer.allocUnsafe(1 + fragment.length);
      fuPart.writeUInt8(fuNalHeader, 0);
      fragment.copy(fuPart, 1);
      state.fuParts.push(fuPart);
      state.fuBytes += fuPart.length;
    } else {
      // Non-start FU-A fragments must continue the same timestamp and sequence.
      if (
        typeof state.fuRtpTimestamp !== 'number' ||
        state.fuRtpTimestamp !== rtpTimestamp ||
        typeof state.fuLastSequence !== 'number' ||
        Array.isArray(state.fuParts) !== true ||
        state.fuParts.length === 0
      ) {
        return { ok: false, reason: 'orphan', nalType: fuNalType, start: false, end: fuEnd };
      }

      expectedSequenceNumber = (state.fuLastSequence + 1) & sequenceMask;

      if (sequenceNumber !== expectedSequenceNumber) {
        return {
          ok: false,
          reason: 'gap',
          nalType: state.fuNalType,
          expectedSequenceNumber: expectedSequenceNumber,
          start: false,
          end: fuEnd,
        };
      }

      state.fuParts.push(fragment);
      state.fuBytes += fragment.length;
      state.fuLastSequence = sequenceNumber;
    }

    if (fuEnd === true) {
      let result = undefined;

      if (Array.isArray(state.fuParts) !== true || state.fuParts.length === 0 || state.fuBytes <= 0) {
        return { ok: false, reason: 'invalid', nalType: fuNalType, start: fuStart, end: true };
      }

      fuPart = Buffer.concat(state.fuParts, state.fuBytes);

      result = {
        ok: true,
        complete: true,
        nalType: fuNalType,
        data: fuPart,
        bytes: fuPart.length,
        start: fuStart,
        end: true,
        interrupted: interrupted,
        previousNalType: previousNalType,
        previousParts: previousParts,
      };

      // The completed NAL is now detached from the fragment state. Clear the
      // retained fragments immediately so the next FU-A cannot look interrupted.
      H264.resetFragmentState(state);

      return result;
    }

    return {
      ok: true,
      complete: false,
      nalType: fuNalType,
      start: fuStart,
      end: false,
      interrupted: interrupted,
      previousNalType: previousNalType,
      previousParts: previousParts,
    };
  }
}
