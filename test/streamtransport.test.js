// Verify transport lifecycle, media health, metadata and bounded RTP jitter release without network I/O.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Buffer } from 'node:buffer';
import H264 from '../src/plugins/camera/h264.js';
import { sequenceParameterSet } from './helpers/h264-fixtures.js';

import StreamTransport from '../src/plugins/camera/streamtransport.js';

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

test('media health suppresses deltas, recovers via keyframes and falls back on a new failure', (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: 100000 });
  let transport = new StreamTransport();
  let state = transport.getMediaState('video', { badWindowMs: 100, unstableBadThreshold: 2, recoveringCleanTarget: 3 });
  assert.equal(transport.getMediaState('video').suppressDeltas !== true, true);
  transport.markMediaIssue('video', 'loss');
  transport.markMediaIssue('video', 'loss');
  assert.equal(state.state, StreamTransport.MEDIA_STATE.UNSTABLE);
  assert.equal(transport.getMediaState('video').suppressDeltas !== true, false);
  transport.markMediaFrame('video', { keyFrame: true });
  assert.equal(state.state, StreamTransport.MEDIA_STATE.RECOVERING);
  transport.markMediaIssue('video', 'loss');
  assert.equal(state.state, StreamTransport.MEDIA_STATE.UNSTABLE);
  transport.markMediaFrame('video', { keyFrame: true });
  transport.markMediaFrame('video');
  assert.equal(state.state, StreamTransport.MEDIA_STATE.STABLE);
  assert.equal(transport.getMediaState('video').suppressDeltas !== true, true);
  assert.equal(state.events.length, 0);
  assert.equal(transport.resetMediaState('video').badWindowMs, 100);
  assert.deepEqual(transport.resetMediaState(), {});
});
test('recovery counts only faults inside the configured rolling window', (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: 100000 });
  let transport = new StreamTransport();
  let state = transport.getMediaState('video', { badWindowMs: 100, unstableBadThreshold: 2 });
  transport.markMediaIssue('video', 'loss');
  assert.equal(state.badEvents, 1);
  context.mock.timers.tick(101);
  transport.markMediaIssue('video', 'loss');
  assert.equal(state.badEvents, 1);
  assert.equal(state.state, StreamTransport.MEDIA_STATE.STABLE);
  transport.markMediaIssue('video', 'incomplete-frame');
  assert.equal(state.badEvents, 2);
  assert.equal(state.state, StreamTransport.MEDIA_STATE.UNSTABLE);
});
test('media state starts complete and bounds its expired event history', (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: 100000 });
  let transport = new StreamTransport();
  let state = transport.getMediaState();
  assert.equal(transport.getMediaState('video').suppressDeltas !== true, true);
  assert.equal(state.state, StreamTransport.MEDIA_STATE.STABLE);
  for (let index = 0; index < 100; index++) {
    transport.markMediaIssue('video', 'loss');
  }
  context.mock.timers.tick(10000);
  transport.markMediaFrame();
  assert.equal(state.events.length, 0);
  assert.equal(state.eventsStart, 0);
});
test('media recovery resets replace state, retain configured thresholds and isolate sessions', () => {
  let transport = new StreamTransport();
  let state = transport.getMediaState('video', { badWindowMs: 100, unstableBadThreshold: 1, recoveringCleanTarget: 3 });
  let audio = transport.getMediaState('audio');
  transport.markMediaIssue('video', 'loss');
  assert.equal(state.state, StreamTransport.MEDIA_STATE.UNSTABLE);

  let reset = transport.resetMediaState('video');
  assert.notEqual(reset, state);
  assert.equal(transport.getMediaState('audio'), audio);
  assert.deepEqual(
    reset,
    new StreamTransport().getMediaState('video', {
      badWindowMs: 100,
      unstableBadThreshold: 1,
      recoveringCleanTarget: 3,
    }),
  );
  assert.equal(transport.getMediaState('video').suppressDeltas !== true, true);
  transport.markMediaIssue('video', 'loss');
  transport.markMediaFrame('video', { keyFrame: true });
  assert.equal(reset.state, StreamTransport.MEDIA_STATE.RECOVERING);
  transport.markMediaFrame('video');
  assert.equal(reset.state, StreamTransport.MEDIA_STATE.STABLE);
  assert.equal(reset.badEvents, 0);
  assert.equal(reset.suppressDeltas, false);

  transport.resetMediaState();
  assert.notEqual(transport.getMediaState('video'), reset);
  assert.notEqual(transport.getMediaState('audio'), audio);
  assert.equal(transport.getMediaState('video').suppressDeltas !== true, true);
});

test('transport lifecycle publishes each state once and resets session-learned metadata on reconnect', () => {
  let states = [];
  let transport = new StreamTransport({ consumer: { active: () => true, state: (...args) => states.push(args) } });
  assert.equal(transport.hasConsumers(), true);
  assert.equal(transport.setState('invalid'), false);
  for (let [state, property] of [
    [StreamTransport.STATE.CONNECTING, 'connecting'],
    [StreamTransport.STATE.CONNECTED, 'connected'],
    [StreamTransport.STATE.READY, 'ready'],
    [StreamTransport.STATE.RECONNECTING, 'reconnecting'],
    [StreamTransport.STATE.CLOSING, 'closing'],
    [StreamTransport.STATE.CLOSED, 'closed'],
  ]) {
    assert.equal(transport.setState(state, { reason: 'fixture', host: 'host', fromHost: 'old', toHost: 'new', sessionId: 1 }), true);
    assert.equal(transport[property], true);
    assert.equal(transport.setState(state), false);
  }
  assert.equal(states.length, 6);
  assert.equal(transport.stats.lifecycle.reconnectReasons.fixture, 1);
});
test('transport metadata is learned from SPS and source timing without duplicate complete-shape logs', (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: 100000 });
  let frames = [];
  let logs = [];
  let transport = new StreamTransport({ consumer: { media: (frame) => frames.push(frame) }, log: { debug: (...args) => logs.push(args) } });
  transport.video.codec = 'h264';
  let data = Buffer.concat([
    H264.NALUS.START_CODE,
    sequenceParameterSet({ widthMbs: 40, heightMbs: 23, crop: [0, 0, 0, 4] }),
    H264.NALUS.START_CODE,
    Buffer.from([0x65, 1]),
  ]);
  for (let index = 0; index <= 20; index++) {
    transport.emitMedia({ type: 'VIDEO', data, timestamp: 100000 + index * 40, keyFrame: index === 0 });
    context.mock.timers.tick(40);
  }
  assert.equal(transport.video.width, 640);
  assert.equal(transport.video.height, 360);
  assert.equal(Math.round(transport.video.fps), 25);
  assert.deepEqual(Object.keys(frames[0]).sort(), [
    'bytes',
    'codec',
    'config',
    'hasPPS',
    'hasSPS',
    'keyFrame',
    'nals',
    'timestamp',
    'type',
  ]);
  assert.equal(logs.length, 1);
  transport.updateVideoMetadata({ width: 1280, height: 720, fps: 30 });
  assert.equal(logs.length, 2);
  context.mock.timers.tick(30000);
  transport.updateVideoMetadata({ fps: 15 });
  assert.equal(logs.length, 3);
});
test('encoded audio derives bitrate and gap counters from emitted frames', (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: 100000 });
  let frames = [];
  let transport = new StreamTransport({ consumer: { media: (frame) => frames.push(frame) } });
  Object.assign(transport.audio, { codec: 'opus', sampleRate: 48000, channels: 2, frameDuration: 20 });
  transport.emitMedia({ type: 'audio', data: Buffer.alloc(80), timestamp: 100000 });
  context.mock.timers.tick(200);
  transport.emitMedia({ type: 'audio', data: Buffer.alloc(80), timestamp: 100200 });
  assert.equal(transport.audio.bitrate, undefined, 'bitrate estimation waits for a full sampling window');
  context.mock.timers.tick(800);
  transport.emitMedia({ type: 'audio', data: Buffer.alloc(80), timestamp: 101000 });
  assert.equal(transport.audio.bitrate, 1920);
  assert.deepEqual(Object.keys(frames[0]).sort(), ['bytes', 'codec', 'data', 'keyFrame', 'timestamp', 'type']);
  assert.equal(transport.stats.media.maxAudioGapMs, 800);
  assert.equal(transport.stats.media.largeAudioGaps, 2);
});
test('transport initializes diagnostic counters and contains failing consumer callbacks', async () => {
  let logs = [];
  let transport = new StreamTransport({
    consumer: {
      media: () => {
        throw new Error('Fixture consumer failure');
      },
    },
    log: { debug: (...args) => logs.push(args) },
  });
  transport.recordVideoDrop('loss');
  transport.recordVideoDrop('');
  transport.recordVideoReorder('custom');
  transport.recordKeyframeRequest();
  assert.equal(transport.stats.media.videoDrops.loss, 1);
  assert.equal(transport.stats.media.videoDrops.unknown, 1);
  assert.equal(transport.stats.media.keyframeRequests, 1);
  assert.equal(transport.stats.media.videoReorder.custom, 1);
  for (let invalid of [null, {}, { type: 'invalid', data: Buffer.from([1]) }, { type: 'audio', data: Buffer.alloc(0) }]) {
    transport.emitMedia(invalid);
  }
  transport.emitMedia({ type: 'meta', data: Buffer.from([1]) });
  assert.equal(logs.length, 1);
  transport.setState(StreamTransport.STATE.READY);
  for (let [method, hook] of [
    ['open', 'doOpen'],
    ['close', 'doClose'],
    ['update', 'doUpdate'],
    ['sendAudio', 'doSendAudio'],
  ]) {
    transport[hook] = async () => {
      throw new Error('Fixture transport failure');
    };
    await transport[method]();
  }
  assert.equal(logs.length, 6);
});

// Exercise bounded queues at the public transport boundary, including rollover and delayed release.
test('audio jitter waits for its delay, sorts rollover packets and rejects duplicates and stale packets', (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: 100000 });
  let transport = new StreamTransport();
  let jitter = transport.createJitterBuffer({ delayMs: 50, maxPackets: 4 });
  assert.equal(transport.pushJitterPacket(jitter, {}), false);
  for (let sequenceNumber of [0, 65535, 1]) {
    assert.equal(transport.pushJitterPacket(jitter, { sequenceNumber }), true);
  }
  assert.equal(transport.pushJitterPacket(jitter, { sequenceNumber: 0 }), false);
  assert.deepEqual(transport.releaseJitterPackets(jitter), []);
  context.mock.timers.tick(49);
  assert.deepEqual(transport.releaseJitterPackets(jitter), []);
  context.mock.timers.tick(1);
  assert.deepEqual(
    transport.releaseJitterPackets(jitter).map((entry) => entry.sequenceNumber),
    [65535, 0, 1],
  );
  assert.equal(transport.pushJitterPacket(jitter, { sequenceNumber: 0 }), false);
  assert.equal(transport.pushJitterPacket(jitter, { sequenceNumber: 1 }), false);
  assert.equal(transport.countJitterPackets(jitter), 0);
});
test('audio jitter stays bounded and forced release bypasses delay', () => {
  let transport = new StreamTransport();
  let jitter = transport.createJitterBuffer({ delayMs: 1000, maxPackets: 3 });
  for (let sequenceNumber = 0; sequenceNumber < 10; sequenceNumber++) {
    transport.pushJitterPacket(jitter, { sequenceNumber });
    assert.ok(transport.countJitterPackets(jitter) <= 3);
    assert.equal(transport.sizeJitterBuffer(jitter), transport.countJitterPackets(jitter));
  }
  assert.deepEqual(
    transport.releaseJitterPackets(jitter, true).map((entry) => entry.sequenceNumber),
    [7, 8, 9],
  );
  transport.clearJitterBuffer(jitter);
  assert.equal(transport.pushJitterPacket(jitter, { sequenceNumber: 0 }), true, 'new session resets sequence anchor');
});
for (let limit of ['groups', 'packets', 'force']) {
  test('video jitter honours completeness and release budget: ' + limit, () => {
    let transport = new StreamTransport();
    let jitter = transport.createJitterBuffer({ groupByTimestamp: true, maxPackets: 16 });
    for (let [rtpTimestamp, sequenceNumber] of [
      [100, 2],
      [0xfffffff0, 0],
      [0xfffffff0, 1],
      [200, 3],
    ]) {
      transport.pushJitterPacket(jitter, { rtpTimestamp, sequenceNumber });
    }
    assert.deepEqual(transport.releaseJitterGroups(jitter, { isComplete: () => false, canWait: () => true }), []);
    let released = transport.releaseJitterGroups(jitter, {
      maxGroups: limit === 'groups' ? 1 : undefined,
      maxPackets: 2,
      force: limit === 'force',
    });
    assert.deepEqual(
      released.map((entry) => entry.rtpTimestamp),
      limit === 'force' ? [0xfffffff0, 100, 200] : [0xfffffff0],
    );
    assert.equal(transport.countJitterPackets(jitter), limit === 'force' ? 0 : 2);
    assert.equal(jitter.groupIndex.size, limit === 'force' ? 0 : 2);
    assert.equal(transport.pushJitterPacket(jitter, { rtpTimestamp: 0xfffffff0, sequenceNumber: 4 }), false);
  });
}
test('video jitter bounds whole groups, accumulates flags and reports unrepaired sequence gaps', () => {
  let transport = new StreamTransport();
  let jitter = transport.createJitterBuffer({ groupByTimestamp: true, maxPackets: 3 });
  assert.equal(transport.pushJitterPacket(jitter, { sequenceNumber: 1 }), false);
  transport.pushJitterPacket(jitter, { rtpTimestamp: 100, sequenceNumber: 1, group: { keyFrame: true, codec: 'h264' } });
  assert.equal(transport.pushJitterPacket(jitter, { rtpTimestamp: 100, sequenceNumber: 1 }), false);
  transport.pushJitterPacket(jitter, { rtpTimestamp: 100, sequenceNumber: 3, group: { keyFrame: false } });
  let group = jitter.groupIndex.get(100);
  assert.equal(group.keyFrame, true);
  assert.equal(group.codec, 'h264');
  assert.equal(transport.sortJitterGroupPackets(jitter, group), true);
  transport.pushJitterPacket(jitter, { rtpTimestamp: 200, sequenceNumber: 4 });
  transport.pushJitterPacket(jitter, { rtpTimestamp: 200, sequenceNumber: 5 });
  assert.equal(jitter.groupIndex.has(100), false, 'overflow discards the whole oldest frame');
  assert.equal(transport.countJitterPackets(jitter), 2);
  transport.clearJitterBuffer(jitter);
  assert.equal(transport.sizeJitterBuffer(jitter), 0);
  assert.equal(jitter.groupIndex.size, 0);
});
test('invalid jitter state is rejected without producing media', () => {
  let transport = new StreamTransport();
  for (let invalid of [null, undefined, 1]) {
    assert.equal(transport.pushJitterPacket(invalid), false);
    assert.deepEqual(transport.releaseJitterPackets(invalid), []);
    assert.deepEqual(transport.releaseJitterGroups(invalid), []);
    assert.equal(transport.countJitterPackets(invalid), 0);
    assert.equal(transport.sizeJitterBuffer(invalid), 0);
    assert.equal(transport.sortJitterGroupPackets(invalid, {}), false);
    transport.clearJitterBuffer(invalid);
  }
});

test('transport normalization preserves fractional source time and canonical codec metadata', () => {
  let frames = [];
  let transport = new StreamTransport({ consumer: { media: (frame) => frames.push(frame) } });
  Object.assign(transport.audio, { codec: 'AAC', sampleRate: 48000, channels: 1 });
  let data = Buffer.from([1]);
  let timestamps = Array.from({ length: 4 }, (_, index) => 100000 + (index * 1024 * 1000) / 48000);
  for (let timestamp of timestamps) {
    transport.emitMedia({ type: 'AUDIO', codec: '', data, timestamp });
  }
  assert.deepEqual(
    frames.map((frame) => frame.timestamp),
    timestamps,
  );
  assert.equal(
    frames.every((frame) => frame.type === 'audio' && frame.codec === 'aac' && frame.data === data),
    true,
  );
});

test('transport drops unresolved codecs and normalizes missing timing before emission', (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: 100000 });
  let frames = [];
  let transport = new StreamTransport({ consumer: { media: (frame) => frames.push(frame) } });
  let data = Buffer.from([0xf8, 0xff, 0xfe]);
  transport.emitMedia({ type: 'audio', data });
  assert.deepEqual(frames, []);
  assert.equal(transport.stats.media.audioFrames, 0);
  transport.audio.codec = ' OPUS ';
  transport.emitMedia({ type: 'AUDIO', data, timestamp: NaN });
  transport.emitMedia({ type: 'audio', data, timestamp: 0.25 });
  assert.equal(frames[0].codec, 'opus');
  assert.equal(frames[0].timestamp, 100000);
  assert.equal(frames[1].timestamp, 0.25);
});

test('waiting video jitter checks only the oldest group without rebuilding the queue', (context) => {
  let transport = new StreamTransport();
  let jitter = transport.createJitterBuffer({ groupByTimestamp: true, maxPackets: 64 });
  for (let index = 0; index < 16; index++) {
    transport.pushJitterPacket(jitter, { rtpTimestamp: index * 3000, sequenceNumber: index });
  }

  let reads = context.mock.method(jitter.queue, 'getByOffset');
  let clears = context.mock.method(jitter.queue, 'clear');
  let pushes = context.mock.method(jitter.queue, 'push');
  let head = jitter.queue.head;
  for (let index = 0; index < 100; index++) {
    assert.deepEqual(transport.releaseJitterGroups(jitter, { isComplete: () => false, canWait: () => true }), []);
  }

  assert.equal(reads.mock.callCount(), 100, 'one head inspection per attempt');
  assert.equal(clears.mock.callCount(), 0, 'waiting must not clear retained groups');
  assert.equal(pushes.mock.callCount(), 0, 'waiting must not reinsert retained groups');
  assert.equal(jitter.queue.head, head);
  assert.equal(jitter.queue.size, 16);
  assert.equal(jitter.packetCount, 16);
  assert.equal(jitter.groupIndex.size, 16);
});

test('video jitter reorders new timestamps after partial release across rollover', (context) => {
  let transport = new StreamTransport();
  let jitter = transport.createJitterBuffer({ groupByTimestamp: true, maxPackets: 16 });
  for (let [sequenceNumber, rtpTimestamp] of [0xfffffff0, 20, 10].entries()) {
    transport.pushJitterPacket(jitter, { rtpTimestamp, sequenceNumber });
  }

  assert.deepEqual(
    transport.releaseJitterGroups(jitter, { maxGroups: 1 }).map((group) => group.rtpTimestamp),
    [0xfffffff0],
  );
  assert.equal(jitter.packetCount, 2);
  assert.equal(jitter.groupIndex.has(0xfffffff0), false);
  transport.pushJitterPacket(jitter, { rtpTimestamp: 15, sequenceNumber: 3 });
  assert.deepEqual(
    transport.releaseJitterGroups(jitter, { maxGroups: 1 }).map((group) => group.rtpTimestamp),
    [10],
  );

  let clears = context.mock.method(jitter.queue, 'clear');
  assert.deepEqual(
    transport.releaseJitterGroups(jitter, { force: true }).map((group) => group.rtpTimestamp),
    [15, 20],
  );
  assert.equal(clears.mock.callCount(), 0, 'already ordered groups drain directly');
  assert.equal(jitter.queue.size, 0);
  assert.equal(jitter.packetCount, 0);
  assert.equal(jitter.groupIndex.size, 0);
  assert.equal(jitter.lastReleasedTimestamp, 20);
});

test('media statistics initialise and reset independently for each source', () => {
  let first = new StreamTransport();
  let second = new StreamTransport();
  let initial = structuredClone(second.stats.media);
  first.recordVideoDrop('loss');
  first.recordVideoReorder('defers');
  first.recordKeyframeRequest();
  assert.deepEqual(second.stats.media, initial);
  first.resetMediaStats();
  assert.deepEqual(first.stats.media, initial);
  assert.notEqual(first.stats.media, second.stats.media);
  assert.notEqual(first.stats.media.videoDrops, second.stats.media.videoDrops);
});

test('slim frames retain source metadata learning and declared bitrate on the transport', () => {
  let frames = [];
  let transport = new StreamTransport({ consumer: { media: (frame) => frames.push(frame) } });
  Object.assign(transport.video, { codec: 'h264', width: 320, height: 240, bitrate: 2000000 });
  let data = Buffer.concat([
    H264.NALUS.START_CODE,
    sequenceParameterSet({ widthMbs: 80, heightMbs: 45 }),
    H264.NALUS.START_CODE,
    Buffer.from([0x65, 1]),
  ]);
  transport.emitMedia({ type: 'video', data, keyFrame: true, timestamp: 100000 });
  assert.equal(transport.video.width, 1280);
  assert.equal(transport.video.height, 720);
  assert.equal(transport.video.bitrate, 2000000);
  assert.deepEqual(
    frames[0].nals,
    H264.getNALUnits(data).map((nal) => nal.data),
  );
  assert.deepEqual(Object.keys(frames[0]).sort(), [
    'bytes',
    'codec',
    'config',
    'hasPPS',
    'hasSPS',
    'keyFrame',
    'nals',
    'timestamp',
    'type',
  ]);
});

test('inferred FPS waits for a startup sample instead of logging the first sparse interval', (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: 100000 });
  let frames = [];
  let logs = [];
  let transport = new StreamTransport({ consumer: { media: (frame) => frames.push(frame) }, log: { debug: (...args) => logs.push(args) } });
  transport.video.codec = 'h264';
  let nals = [sequenceParameterSet({ widthMbs: 80, heightMbs: 45 }), Buffer.from([0x65, 1])];
  let timestamps = [100000, 100000 + 1000 / 3];
  for (let index = 1; index <= 19; index++) {
    timestamps.push(100000 + 1000 / 3 + (index * 1000) / 30);
  }
  for (let [index, timestamp] of timestamps.entries()) {
    transport.emitMedia({ type: 'video', timestamp, nals, keyFrame: true });
    if (index < 20) {
      assert.equal(logs.length, 0);
      assert.equal(transport.video.fps, undefined);
    }
  }
  assert.equal(logs.length, 1);
  assert.equal(logs[0][2], '1280x720 @ 30fps');
  assert.deepEqual(
    frames.map((frame) => frame.timestamp),
    timestamps,
    'FPS reporting must not retime source frames',
  );
  transport.setState(StreamTransport.STATE.RECONNECTING);
  logs.length = 0;
  transport.emitMedia({ type: 'video', timestamp: 200000, nals, keyFrame: true });
  transport.emitMedia({ type: 'video', timestamp: 200040, nals, keyFrame: true });
  assert.equal(logs.length, 0);
  assert.equal(transport.video.fps, undefined, 'a replacement source must collect its own startup sample');
});

test('explicit source FPS reports immediately without waiting for inferred startup samples', () => {
  let logs = [];
  let transport = new StreamTransport({ log: { debug: (...args) => logs.push(args) } });
  transport.updateVideoMetadata({ width: 1280, height: 720, fps: 15 });
  assert.equal(logs.length, 1);
  assert.equal(logs[0][2], '1280x720 @ 15fps');
});
