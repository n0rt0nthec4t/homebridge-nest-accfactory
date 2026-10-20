// Verify decoder-facing RTP H264 contracts: complete packets, fragmented NALs, loss and sequence rollover.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import H264 from '../src/plugins/camera/h264.js';

for (let [label, payload, expected] of [
  ['missing', undefined, [false, false, false, false]],
  ['non-buffer', [], [false, false, false, false]],
  ['empty', Buffer.alloc(0), [false, false, false, false]],
  ['IDR', Buffer.from([0x65, 1]), [true, false, false, false]],
  ['inter-frame', Buffer.from([0x41, 1]), [false, false, false, false]],
  ['FU-A start', Buffer.from([0x7c, 0x85, 1]), [true, true, true, false]],
  ['FU-A end', Buffer.from([0x7c, 0x45, 2]), [true, true, false, true]],
  ['truncated FU-A', Buffer.from([0x7c]), [false, false, false, false]],
  ['STAP-A SPS plus IDR', Buffer.from([0x78, 0, 2, 0x67, 1, 0, 2, 0x65, 2]), [true, false, false, false]],
  ['STAP-A zero length', Buffer.from([0x78, 0, 0]), [false, false, false, false]],
  ['STAP-A truncated NAL', Buffer.from([0x78, 0, 4, 0x65]), [false, false, false, false]],
]) {
  test('RTP payload inspection: ' + label, () => {
    let info = H264.getPayloadInfo(payload);
    assert.deepEqual([info.hasKeyFrame, info.hasFragmentedNal, info.hasFragmentStart, info.hasFragmentEnd], expected);
  });
}
for (let marker of [true, false]) {
  for (let start of [true, false]) {
    for (let end of [true, false]) {
      for (let gap of [true, false]) {
        test('fragment completeness: marker=' + marker + ', start=' + start + ', end=' + end + ', gap=' + gap, () => {
          assert.equal(
            H264.isTimestampGroupComplete(
              {
                markerSeen: marker,
                hasFragmentedNal: true,
                hasFragmentStart: start,
                hasFragmentEnd: end,
              },
              gap,
            ),
            marker === true && start === true && end === true && gap === false,
          );
        });
      }
    }
  }
}
test('non-fragmented groups require a marker and invalid groups cannot be complete', () => {
  assert.equal(H264.isTimestampGroupComplete({ markerSeen: true }), true);
  assert.equal(H264.isTimestampGroupComplete({ markerSeen: false }), false);
  assert.equal(H264.isTimestampGroupComplete(null), false);
  assert.equal(H264.isTimestampGroupComplete(undefined), false);
});
for (let [first, mask] of [
  [10, 0xffff],
  [65535, 0xffff],
  [255, 0xff],
]) {
  test('FU-A reconstruction preserves Annex-B bytes across sequence ' + first, () => {
    let state = {};
    let start = H264.acceptFuA(state, Buffer.from([0x7c, 0x85, 1, 2]), {
      sequenceNumber: first,
      rtpTimestamp: 100,
      receivedAt: 1,
      sequenceMask: mask,
    });
    assert.equal(start.ok, true);
    assert.equal(start.complete, false);
    let result = H264.acceptFuA(state, Buffer.from([0x7c, 0x45, 3, 4]), {
      sequenceNumber: (first + 1) & mask,
      rtpTimestamp: 100,
      receivedAt: 2,
      sequenceMask: mask,
    });
    assert.equal(result.ok, true);
    assert.equal(result.complete, true);
    assert.deepEqual(result.data, Buffer.from([0, 0, 0, 1, 0x65, 1, 2, 3, 4]));
    assert.equal(result.bytes, result.data.length);
    assert.deepEqual(state.fuParts, []);
    assert.equal(state.fuBytes, 0);
    assert.equal(state.fuRtpTimestamp, undefined);
  });
}
for (let [label, payload, context, reason] of [
  ['missing payload', undefined, {}, 'invalid'],
  ['empty fragment', Buffer.from([0x7c, 0x85]), {}, 'invalid'],
  ['orphan continuation', Buffer.from([0x7c, 0x45, 2]), { rtpTimestamp: 101, sequenceNumber: 11 }, 'orphan'],
  ['sequence loss', Buffer.from([0x7c, 0x45, 2]), { rtpTimestamp: 100, sequenceNumber: 12 }, 'gap'],
]) {
  test('FU-A rejects ' + label + ' and a subsequent start recovers', () => {
    let state = {};
    H264.acceptFuA(state, Buffer.from([0x7c, 0x85, 1]), { rtpTimestamp: 100, sequenceNumber: 10 });
    assert.equal(H264.acceptFuA(state, payload, context).reason, reason);
    let result = H264.acceptFuA(state, Buffer.from([0x7c, 0xc5, 9]), { rtpTimestamp: 200, sequenceNumber: 20 });
    assert.equal(result.complete, true);
    assert.equal(result.interrupted, true);
    assert.deepEqual(result.data, Buffer.from([0, 0, 0, 1, 0x65, 9]));
    assert.deepEqual(state.fuParts, []);
  });
}
test('fragment reset preserves transport-owned recovery fields', () => {
  let state = { recovery: true, fuParts: [Buffer.from([1])], fuBytes: 1 };
  H264.resetFragmentState(state);
  assert.equal(state.recovery, true);
  assert.equal(state.fuBytes, 0);
  assert.doesNotThrow(() => H264.resetFragmentState(null));
  assert.equal(H264.acceptFuA(null, Buffer.from([0x7c, 0x85, 1])).reason, 'invalid');
});
