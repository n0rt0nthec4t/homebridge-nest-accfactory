// RTP H264 packet helpers
// Part of homebridge-nest-accfactory
//
// RTP packetization helpers for H264 payloads.
//
// This module sits between generic RTP jitter/reorder code and pure H264 byte
// helpers. It does not assemble access units or decide recovery policy.
//
// Code version 2026.05.18
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { Buffer } from 'node:buffer';
import H264 from './h264.js';

export default class RtpH264 {
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

      RtpH264.resetFragmentState(state);
      state.fuRtpTimestamp = rtpTimestamp;
      state.fuNalType = fuNalType;
      state.fuFirstPacketTime = receivedAt;
      state.fuLastSequence = sequenceNumber;

      // First FU-A fragment reconstructs the original NAL header and carries
      // the Annex-B prefix so the completed fragment is one normal NAL.
      fuPart = Buffer.allocUnsafe(H264.NALUS.START_CODE.length + 1 + fragment.length);
      H264.NALUS.START_CODE.copy(fuPart, 0);
      fuPart.writeUInt8(fuNalHeader, H264.NALUS.START_CODE.length);
      fragment.copy(fuPart, H264.NALUS.START_CODE.length + 1);
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
      RtpH264.resetFragmentState(state);

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
