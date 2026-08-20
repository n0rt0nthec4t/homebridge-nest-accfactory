import assert from 'node:assert/strict';
import test from 'node:test';

import MediaTimeline from '../../src/mediatimeline.js';

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
