import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import H264 from '../../src/h264.js';

const START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01]);

test('H264 wraps raw NAL data without double-wrapping Annex-B data', () => {
  let raw = Buffer.from([0x65, 0xaa]);
  let wrapped = H264.wrapAnnexB(raw);

  assert.deepEqual(wrapped, Buffer.concat([START_CODE, raw]));
  assert.equal(H264.ensureAnnexB(wrapped), wrapped);
  assert.equal(H264.wrapAnnexB(Buffer.alloc(0)), undefined);
});

test('H264 parses mixed three-byte and four-byte Annex-B start codes', () => {
  let data = Buffer.from([0x00, 0x00, 0x01, 0x67, 0xaa, 0x00, 0x00, 0x00, 0x01, 0x68, 0xbb]);
  let units = H264.getNALUnits(data);

  assert.deepEqual(
    units.map((unit) => unit.type),
    [H264.NALUS.TYPES.SPS, H264.NALUS.TYPES.PPS],
  );
  assert.deepEqual(units[0].data, Buffer.from([0x67, 0xaa]));
  assert.deepEqual(units[1].data, Buffer.from([0x68, 0xbb]));
});

test('H264 treats a raw buffer as one NAL unit', () => {
  let raw = Buffer.from([0x65, 0x01, 0x02]);

  assert.deepEqual(H264.getNALUnits(raw), [{ type: H264.NALUS.TYPES.IDR, data: raw }]);
  assert.equal(H264.hasNAL(raw, H264.NALUS.TYPES.IDR), true);
});

test('H264 injects missing parameter sets into keyframes', () => {
  let sps = Buffer.from([0x67, 0x01]);
  let pps = Buffer.from([0x68, 0x02]);
  let idr = Buffer.from([0x65, 0x03]);
  let accessUnit = H264.buildAccessUnit([idr], { keyFrame: true, sps, pps });

  assert.equal(accessUnit.hasParameterSets, true);
  assert.equal(accessUnit.byteLength, 18);
  assert.deepEqual(
    H264.getNALUnits(accessUnit.data).map((unit) => unit.type),
    [H264.NALUS.TYPES.SPS, H264.NALUS.TYPES.PPS, H264.NALUS.TYPES.IDR],
  );
});

test('H264 rejects malformed SPS metadata', () => {
  assert.equal(H264.getSPSInfo(Buffer.from([0x67, 0x00])), undefined);
  assert.equal(H264.getSPSInfo(Buffer.from([0x65, 0x00, 0x00, 0x00])), undefined);
});
