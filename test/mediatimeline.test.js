// Verify retained media lookup, cursor protection, capacity bounds and long-running index compaction.
import assert from 'node:assert/strict';
import test from 'node:test';

import MediaTimeline from '../src/plugins/camera/mediatimeline.js';

test('MediaTimeline indexes mixed media and keyframes', () => {
  let timeline = new MediaTimeline(10, 4, 4);
  let video = { type: 'video', time: 100, keyFrame: false };
  let audio = { type: 'audio', time: 110 };
  let keyFrame = { type: 'video', time: 120, keyFrame: true };

  assert.equal(timeline.add(video), 10);
  assert.equal(timeline.add(audio), 11);
  assert.equal(timeline.add(keyFrame), 12);

  assert.equal(timeline.nextVideoFrom(11), keyFrame);
  assert.equal(timeline.nextAudioFrom(10), audio);
  assert.equal(timeline.nextKeyFrameFrom(10), keyFrame);
  assert.equal(timeline.latestTime(), 120);
});

test('MediaTimeline trims expired items without crossing a protected cursor', () => {
  let timeline = new MediaTimeline(0, 4, 4);

  timeline.add({ type: 'video', time: 100 });
  timeline.add({ type: 'audio', time: 200 });
  timeline.add({ type: 'video', time: 300 });

  assert.equal(timeline.trim(400, 1), 1);
  assert.equal(timeline.startIndex, 1);
  assert.equal(timeline.first().time, 200);
  assert.equal(timeline.stats.trimmedItems, 1);
});

test('MediaTimeline finds the closest item when mixed timestamps are not ordered', () => {
  let timeline = new MediaTimeline();
  let closest = { type: 'audio', time: 190 };

  timeline.add({ type: 'video', time: 300 });
  timeline.add(closest);
  timeline.add({ type: 'video', time: 100 });

  assert.equal(timeline.closestToTime(200), closest);
});

test('MediaTimeline reports capacity drops and resets cleanly', () => {
  let timeline = new MediaTimeline(5, 1, 1);

  assert.equal(timeline.add({ type: 'audio', time: 1 }), 5);
  assert.equal(timeline.add({ type: 'audio', time: 2 }), undefined);
  assert.equal(timeline.stats.droppedItems, 1);

  timeline.clear(20);

  assert.equal(timeline.empty, true);
  assert.equal(timeline.nextIndex, 20);
  assert.equal(timeline.stats.droppedItems, 0);
});

// Long-running timelines must retain valid lookup indexes after repeated ring wrap and index compaction.
test('MediaTimeline preserves video, audio and keyframe indexes across repeated compaction', () => {
  let timeline = new MediaTimeline(10, 16, 1024);
  for (let cycle = 0; cycle < 4; cycle++) {
    let start = timeline.nextIndex;
    for (let index = 0; index < 600; index++) {
      timeline.add({ type: index % 2 === 0 ? 'video' : 'audio', time: start + index, keyFrame: index % 2 === 0 });
    }
    assert.equal(timeline.trim(start + 512), 512);
    assert.equal(timeline.nextVideoFrom(start).index, start + 512);
    assert.equal(timeline.nextAudioFrom(start).index, start + 513);
    assert.equal(timeline.nextKeyFrameFrom(start).index, start + 512);
    assert.equal(timeline.stats.videoIndexes, 44);
    assert.equal(timeline.stats.audioIndexes, 44);
    assert.equal(timeline.stats.keyframeIndexes, 44);
    assert.equal(timeline.trim(Infinity), 0, 'non-finite cutoffs cannot erase retained media');
    assert.equal(timeline.trim(start + 600), 88);
    assert.equal(timeline.empty, true);
    assert.equal(timeline.nextVideoFrom(start), undefined);
  }
});
test('MediaTimeline skips untimed metadata when finding the latest timestamp and trims it safely', () => {
  let timeline = new MediaTimeline();
  timeline.add({ type: 'meta' });
  timeline.add({ type: 'audio', time: 100 });
  timeline.add({ type: 'meta', time: NaN });
  timeline.add({ type: 'meta' });
  assert.equal(timeline.latestTime(), 100);
  assert.equal(timeline.closestToTime(99).time, 100);
  assert.equal(timeline.trim(100), 1);
  assert.equal(timeline.first().time, 100);
  assert.equal(timeline.trim(101), 3);
  assert.equal(timeline.latestTime(), undefined);
  assert.equal(timeline.last(), undefined);
});
test('MediaTimeline chooses the oldest valid output cursor and releases protection as viewers leave', () => {
  let timeline = new MediaTimeline(10);
  for (let index = 0; index < 5; index++) {
    timeline.add({ type: 'video', time: index });
  }
  let outputs = new Map([
    ['old', { cursor: 11 }],
    ['new', { cursor: 14 }],
    ['invalid', { cursor: '10' }],
    ['expired', { cursor: 1 }],
    ['missing', null],
  ]);
  assert.equal(timeline.protectedStart(outputs), 11);
  assert.equal(timeline.trim(10, timeline.protectedStart(outputs)), 1);
  outputs.delete('old');
  assert.equal(timeline.protectedStart(outputs), 14);
  assert.equal(timeline.trim(10, timeline.protectedStart(outputs)), 3);
  assert.equal(timeline.size, 1);
  assert.equal(timeline.protectedStart(new Map()), 15);
  assert.equal(timeline.protectedStart(undefined), 15);
});
test('MediaTimeline rejects invalid lookup and media inputs without moving its logical index', () => {
  let timeline = new MediaTimeline(-1);
  for (let invalid of [undefined, null, 1, 'invalid']) {
    assert.equal(timeline.add(invalid), undefined);
    assert.equal(timeline.closestToTime(invalid), undefined);
  }
  assert.equal(timeline.nextIndex, 0);
  assert.equal(timeline.trim(100), 0);
  let item = { type: 'video', time: 10, keyFrame: true };
  timeline.add(item);
  assert.equal(timeline.get(-1), undefined);
  assert.equal(timeline.get(1), undefined);
  assert.equal(timeline.get(0.5), undefined);
  assert.equal(timeline.nextVideoFrom(undefined), item);
  assert.equal(timeline.nextKeyFrameFrom(-1), item);
  assert.equal(timeline.nextAudioFrom(0), undefined);
  timeline.clear(-1);
  assert.equal(timeline.nextIndex, 0);
});

test('MediaTimeline accounts for accepted payloads across protected trims, wrapped storage and clear', () => {
  let timeline = new MediaTimeline(0, 3, 3);

  assert.equal(timeline.stats.retainedBytes, 0);
  timeline.add({ type: 'video', time: 100, data: Buffer.alloc(4) });
  timeline.add({ type: 'audio', time: 200, data: Buffer.alloc(6) });
  timeline.add({ type: 'meta' });
  assert.equal(timeline.stats.retainedBytes, 10);

  assert.equal(timeline.add({ type: 'audio', time: 300, data: Buffer.alloc(8) }), undefined);
  assert.equal(timeline.stats.retainedBytes, 10, 'capacity rejection must not count payload bytes');
  assert.equal(timeline.trim(400, 1), 1);
  assert.equal(timeline.stats.retainedBytes, 6, 'protected payload remains counted');

  timeline.add({ type: 'video', time: 300, data: Buffer.alloc(8) });
  assert.equal(timeline.stats.retainedBytes, 14, 'wrapped storage counts the new payload once');
  assert.equal(timeline.trim(250), 2);
  assert.equal(timeline.stats.retainedBytes, 8, 'untimed metadata contributes no payload bytes');

  timeline.clear(20);
  assert.equal(timeline.stats.retainedBytes, 0);
  timeline.add({ type: 'meta', data: Buffer.alloc(5) });
  timeline.add({ type: 'meta', data: 'not a Buffer' });
  assert.equal(timeline.stats.retainedBytes, 5);
  assert.equal(timeline.trim(1), 2);
  assert.equal(timeline.stats.retainedBytes, 0, 'trimming untimed payloads releases their byte count');
});
