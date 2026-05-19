// H264 helpers
// Part of homebridge-nest-accfactory
//
// Pure H264 byte helpers shared by transports and output code.
//
// Provides:
// - Annex-B start-code wrapping
// - Annex-B and raw single-NAL parsing
// - NAL type detection
// - Annex-B access-unit building with optional SPS/PPS injection
// - SPS profile, level, chroma format, and display-resolution parsing
//
// This module does not own RTP packet ordering, frame recovery, stream state,
// media timing, or output pacing. Callers decide when NAL units have been
// collected into a complete access unit and when that access unit is safe to emit.
//
// Code version 2026.05.18
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

  static wrapAnnexB(nal) {
    let part = undefined;

    // Wrap one raw NAL payload with an Annex-B start code.
    if (Buffer.isBuffer(nal) !== true || nal.length === 0) {
      return undefined;
    }

    part = Buffer.allocUnsafe(H264.NALUS.START_CODE.length + nal.length);
    H264.NALUS.START_CODE.copy(part, 0);
    nal.copy(part, H264.NALUS.START_CODE.length);

    return part;
  }

  static ensureAnnexB(nal) {
    // Return a NAL payload in Annex-B form without double-wrapping existing data.
    if (Buffer.isBuffer(nal) !== true || nal.length === 0) {
      return undefined;
    }

    return nal.indexOf(H264.NALUS.START_CODE) === 0 ? nal : H264.wrapAnnexB(nal);
  }

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

  static hasNAL(data, nalType) {
    // Fast shared test for Annex-B or single-NAL buffers.
    for (let nalu of H264.getNALUnits(data)) {
      if (nalu.type === nalType) {
        return true;
      }
    }

    return false;
  }

  static buildAccessUnit(parts, options = {}) {
    let emitParts = [];
    let frameParts = [];
    let data = undefined;
    let byteLength = 0;
    let writeOffset = 0;
    let hasSPS = false;
    let hasPPS = false;

    // Build one Annex-B access unit from complete NAL buffers. This stays byte-level:
    // transports still decide packet ordering, timestamp grouping, recovery, and timing.
    if (Array.isArray(parts) !== true || parts.length === 0) {
      return undefined;
    }

    for (let part of parts) {
      let offset = 0;
      let type = 0;
      let annexBPart = undefined;

      if (Buffer.isBuffer(part) !== true || part.length === 0) {
        continue;
      }

      // Parts may already be Annex-B access-unit chunks, or raw NAL payloads.
      // Work out where the NAL header lives before checking SPS/PPS presence.
      if (part.indexOf(H264.NALUS.START_CODE) === 0) {
        offset = H264.NALUS.START_CODE.length;
      }

      if (part.length > offset) {
        type = part[offset] & 0x1f;
        hasSPS = hasSPS === true || type === H264.NALUS.TYPES.SPS;
        hasPPS = hasPPS === true || type === H264.NALUS.TYPES.PPS;
      }

      // Normalise every emitted part to Annex-B so callers get one stable
      // access-unit format regardless of transport packetisation.
      annexBPart = H264.ensureAnnexB(part);

      if (Buffer.isBuffer(annexBPart) === true && annexBPart.length > 0) {
        frameParts.push(annexBPart);
      }
    }

    if (options.keyFrame === true) {
      // Keyframes need parameter sets before IDR for decoders that attach mid-stream.
      if (hasSPS !== true && Buffer.isBuffer(options.sps) === true && options.sps.length > 0) {
        emitParts.push(H264.ensureAnnexB(options.sps));
        hasSPS = true;
      }

      if (hasPPS !== true && Buffer.isBuffer(options.pps) === true && options.pps.length > 0) {
        emitParts.push(H264.ensureAnnexB(options.pps));
        hasPPS = true;
      }
    }

    emitParts = emitParts.concat(frameParts);

    for (let part of emitParts) {
      byteLength += part.length;
    }

    if (byteLength <= 0) {
      return undefined;
    }

    // Preserve the single-buffer fast path for common already-complete frames.
    if (emitParts.length === 1) {
      data = emitParts[0];
    } else {
      data = Buffer.allocUnsafe(byteLength);

      for (let part of emitParts) {
        part.copy(data, writeOffset);
        writeOffset += part.length;
      }
    }

    return {
      data: data,
      byteLength: byteLength,
      hasSPS: hasSPS,
      hasPPS: hasPPS,
      hasParameterSets: hasSPS === true && hasPPS === true,
    };
  }

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
}
