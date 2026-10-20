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
  assert.equal(transport.canAcceptMediaFrame('video'), true);
  transport.markMediaIssue('video', 'loss');
  transport.markMediaIssue('video', 'loss');
  assert.equal(state.state, StreamTransport.MEDIA_STATE.UNSTABLE);
  assert.equal(transport.canAcceptMediaFrame('video'), false);
  assert.equal(transport.canAcceptMediaFrame('video', { keyFrame: true }), true);
  transport.markMediaFrame('video', { keyFrame: true });
  assert.equal(state.state, StreamTransport.MEDIA_STATE.RECOVERING);
  transport.markMediaIssue('video', 'loss');
  assert.equal(state.state, StreamTransport.MEDIA_STATE.UNSTABLE);
  transport.markMediaFrame('video', { keyFrame: true });
  transport.markMediaFrame('video');
  assert.equal(state.state, StreamTransport.MEDIA_STATE.STABLE);
  assert.equal(transport.canAcceptMediaFrame('video'), true);
  assert.equal(state.events.length, 0);
  assert.equal(transport.resetMediaState('video').badWindowMs, 100);
  assert.deepEqual(transport.resetMediaState(), {});
});
test('isolated timestamp clamps stay harmless but repeated clamps count as bad media', (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: 100000 });
  let transport = new StreamTransport();
  let state = transport.markMediaIssue('video', 'timestamp', { clamp: true });
  assert.equal(state.badEvents, 0);
  transport.markMediaIssue('video', 'timestamp', { clamp: true });
  assert.equal(state.badEvents, 1);
  context.mock.timers.tick(10000);
  transport.markMediaFrame();
  assert.equal(state.clampEvents, 0);
  assert.equal(state.badEvents, 0);
});
test('media state backfills partial protocol state and bounds its expired event history', (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: 100000 });
  let transport = new StreamTransport();
  let state = transport.getMediaState();
  for (let key of Object.keys(state)) {
    delete state[key];
  }
  assert.equal(transport.canAcceptMediaFrame(), true);
  assert.equal(state.state, StreamTransport.MEDIA_STATE.STABLE);
  for (let index = 0; index < 100; index++) {
    transport.markMediaIssue('video', 'diagnostic', { bad: false });
  }
  context.mock.timers.tick(10000);
  transport.markMediaFrame();
  assert.equal(state.events.length, 0);
  assert.equal(state.eventsStart, 0);
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
  let data = H264.buildAccessUnit([sequenceParameterSet({ widthMbs: 40, heightMbs: 23, crop: [0, 0, 0, 4] }), Buffer.from([0x65, 1])]).data;
  for (let index = 0; index < 3; index++) {
    transport.emitMedia({ type: 'VIDEO', data, timestamp: 100000 + index * 40, keyFrame: index === 0 });
    context.mock.timers.tick(40);
  }
  assert.equal(transport.video.width, 640);
  assert.equal(transport.video.height, 360);
  assert.equal(Math.round(transport.video.fps), 25);
  assert.equal(frames[0].sequence, 0);
  assert.equal(frames[2].sequence, 2);
  assert.equal(logs.length, 1);
  transport.updateVideoMetadata({ width: 1280, height: 720, fps: 30 });
  assert.equal(logs.length, 2);
  context.mock.timers.tick(30000);
  transport.updateVideoMetadata({ fps: 15 });
  assert.equal(logs.length, 3);
});
test('PCM metadata derives bitrate and audio gap counters from emitted frames', (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: 100000 });
  let frames = [];
  let transport = new StreamTransport({ consumer: { media: (frame) => frames.push(frame) } });
  Object.assign(transport.audio, { codec: 'pcm', sampleRate: 48000, channels: 2, frameDuration: 20 });
  transport.emitMedia({ type: 'audio', data: Buffer.from([1]), timestamp: 100000 });
  context.mock.timers.tick(200);
  transport.emitMedia({ type: 'audio', data: Buffer.from([2]), timestamp: 100200 });
  assert.equal(frames[0].bitrate, 1536000);
  assert.equal(transport.stats.media.maxAudioGapMs, 200);
  assert.equal(transport.stats.media.largeAudioGaps, 1);
  transport.recordAudioSilenceFill(20);
  transport.recordAudioSilenceFill(-1);
  assert.equal(transport.stats.media.audioSilenceFillFrames, 2);
  assert.equal(transport.stats.media.audioSilenceFillMs, 20);
});
test('transport repairs diagnostic counters and contains failing consumer callbacks', async () => {
  let logs = [];
  let transport = new StreamTransport({
    consumer: {
      media: () => {
        throw new Error('Fixture consumer failure');
      },
    },
    log: { debug: (...args) => logs.push(args) },
  });
  transport.stats.media = null;
  transport.recordVideoDrop('loss');
  transport.stats.media.videoDrops = null;
  transport.recordVideoDrop('');
  transport.stats.media.videoReorder = null;
  transport.recordVideoReorder('custom');
  transport.recordKeyframeRequest();
  assert.equal(transport.stats.media.videoDrops.unknown, 1);
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
  context.mock.timers.tick(50);
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
