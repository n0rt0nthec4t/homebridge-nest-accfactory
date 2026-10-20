// Encode controlled SPS fixtures to verify profile, chroma, interlacing and cropping metadata independently of media transports.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import H264 from '../src/plugins/camera/h264.js';
import { sequenceParameterSet } from './helpers/h264-fixtures.js';

for (let profile of [66, 77, 100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]) {
  test('SPS profile ' + profile + ' decodes 1920x1080 with display cropping', () => {
    let data = sequenceParameterSet({ profile, crop: [0, 0, 0, 4] });
    assert.deepEqual(H264.getSPSInfo(data), { width: 1920, height: 1080, profileIdc: profile, levelIdc: 31, chromaFormatIdc: 1 });
  });
}
for (let [options, expected] of [
  [{ profile: 100, chroma: 0, crop: [1, 2, 3, 4] }, [1917, 1081, 0]],
  [{ profile: 100, chroma: 2, crop: [1, 2, 3, 4] }, [1914, 1081, 2]],
  [{ profile: 100, chroma: 3, scaling: true, crop: [1, 2, 3, 4] }, [1917, 1081, 3]],
  [{ profile: 100, scaling: true, poc: 1 }, [1920, 1088, 1]],
  [{ poc: 2, interlaced: true, heightMbs: 34, crop: [0, 0, 0, 2] }, [1920, 1080, 1]],
]) {
  test('SPS extended metadata ' + JSON.stringify(options), () => {
    let info = H264.getSPSInfo(sequenceParameterSet(options));
    assert.deepEqual([info.width, info.height, info.chromaFormatIdc], expected);
  });
}
test('SPS removes emulation-prevention bytes without changing decoded metadata', () => {
  let data = sequenceParameterSet();
  assert.deepEqual(H264.getSPSInfo(Buffer.concat([data, Buffer.from([0, 0, 3, 1])])), H264.getSPSInfo(data));
});
test('truncated and impossible SPS dimensions fail closed', () => {
  let data = sequenceParameterSet({ profile: 100, scaling: true, poc: 1, crop: [1, 2, 3, 4] });
  for (let length = 0; length < data.length - 1; length++) {
    assert.equal(H264.getSPSInfo(data.subarray(0, length)), undefined, 'truncation at byte ' + length);
  }
  assert.equal(H264.getSPSInfo(sequenceParameterSet({ crop: [0, 1000, 0, 0] })), undefined);
  assert.equal(H264.getSPSInfo(undefined), undefined);
});
