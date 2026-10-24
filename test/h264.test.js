// Verify Annex-B framing, decoder parameter sets and malformed H264 access-unit boundaries.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import H264 from '../src/plugins/camera/h264.js';

const START_CODE = Buffer.from([0x00, 0x00, 0x00, 0x01]);

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
});

test('H264 rejects malformed SPS metadata', () => {
  assert.equal(H264.getSPSInfo(Buffer.from([0x67, 0x00])), undefined);
  assert.equal(H264.getSPSInfo(Buffer.from([0x65, 0x00, 0x00, 0x00])), undefined);
});

for (let first of [Buffer.from([0, 0, 1]), START_CODE]) {
  for (let second of [Buffer.from([0, 0, 1]), START_CODE]) {
    test('H264 parses consecutive NAL boundaries of lengths ' + first.length + '/' + second.length, () => {
      let sps = Buffer.from([0x67, 1, 2]);
      let pps = Buffer.from([0x68, 3, 4]);
      let idr = Buffer.from([0x65, 5, 6]);
      let data = Buffer.concat([first, sps, second, pps, first, idr, second]);
      assert.deepEqual(
        H264.getNALUnits(data).map((unit) => unit.data),
        [sps, pps, idr],
      );
    });
  }
}
test('H264 ignores empty start-code boundaries and malformed access-unit parts', () => {
  let idr = Buffer.from([0x65, 1]);
  assert.deepEqual(H264.getNALUnits(Buffer.concat([START_CODE, START_CODE, idr, START_CODE])), [{ type: 5, data: idr }]);
  for (let invalid of [null, undefined, {}, [], Buffer.alloc(0)]) {
    assert.deepEqual(H264.getNALUnits(invalid), []);
  }
});
