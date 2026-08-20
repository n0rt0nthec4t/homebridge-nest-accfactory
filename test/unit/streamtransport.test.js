import assert from 'node:assert/strict';
import test from 'node:test';

import StreamTransport from '../../src/streamtransport.js';

test('StreamTransport keeps sequential RTP groups sorted without rescanning', () => {
  let transport = new StreamTransport();
  let jitter = transport.createJitterBuffer({ groupByTimestamp: true, maxPackets: 16 });

  transport.pushJitterPacket(jitter, { rtpTimestamp: 100, sequenceNumber: 10 });
  transport.pushJitterPacket(jitter, { rtpTimestamp: 100, sequenceNumber: 11 });
  transport.pushJitterPacket(jitter, { rtpTimestamp: 100, sequenceNumber: 12, marker: true });

  let group = jitter.groupIndex.get(100);
  assert.equal(group.packetsSorted, true);
  assert.equal(group.hasSequenceGap, false);
  assert.equal(transport.sortJitterGroupPackets(jitter, group), false);
  assert.deepEqual(
    group.packets.map((packet) => packet.sequenceNumber),
    [10, 11, 12],
  );
});

test('StreamTransport re-sorts reordered RTP packets and closes recovered gaps', () => {
  let transport = new StreamTransport();
  let jitter = transport.createJitterBuffer({ groupByTimestamp: true, maxPackets: 16 });

  transport.pushJitterPacket(jitter, { rtpTimestamp: 100, sequenceNumber: 10 });
  transport.pushJitterPacket(jitter, { rtpTimestamp: 100, sequenceNumber: 12 });
  transport.pushJitterPacket(jitter, { rtpTimestamp: 100, sequenceNumber: 11 });

  let group = jitter.groupIndex.get(100);
  assert.equal(group.packetsSorted, false);
  assert.equal(transport.sortJitterGroupPackets(jitter, group), false);
  assert.deepEqual(
    group.packets.map((packet) => packet.sequenceNumber),
    [10, 11, 12],
  );
});

test('StreamTransport preserves sequential ordering across RTP wraparound', () => {
  let transport = new StreamTransport();
  let jitter = transport.createJitterBuffer({ groupByTimestamp: true, maxPackets: 16 });

  transport.pushJitterPacket(jitter, { rtpTimestamp: 100, sequenceNumber: 65535 });
  transport.pushJitterPacket(jitter, { rtpTimestamp: 100, sequenceNumber: 0 });

  let group = jitter.groupIndex.get(100);
  assert.equal(group.packetsSorted, true);
  assert.equal(transport.sortJitterGroupPackets(jitter, group), false);
});
