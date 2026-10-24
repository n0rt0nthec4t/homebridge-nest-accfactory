// Verify bounded track retention, stable cursors, byte limits and timestamp lookup.
import assert from 'node:assert/strict';
import test from 'node:test';
import MediaTimeline from '../src/plugins/camera/mediatimeline.js';

function item(type, time, bytes = 1) {
  return { type, time, bytes };
}

test('track cursors advance independently and binary seek handles mixed arrival order', () => {
  let timeline = new MediaTimeline(10, 2, 8);
  assert.equal(timeline.add(item('video', 300)), 10);
  assert.equal(timeline.add(item('audio', 100)), 10);
  assert.equal(timeline.add(item('audio', 200)), 11);
  assert.equal(timeline.add(item('video', 400)), 11);
  assert.equal(timeline.get('video', 10).time, 300);
  assert.equal(timeline.seek('audio', 150), 11);
  assert.equal(timeline.seek('audio', 50), 10);
  assert.equal(timeline.seek('video', 500), 12);
  assert.equal(timeline.empty, false);
});

test('a slow consumer cannot pin retention or prevent new frames entering either track', () => {
  let timeline = new MediaTimeline(0, 2, 4);
  for (let index = 0; index < 100; index++) {
    timeline.add(item('video', index * 20));
    timeline.add(item('audio', index * 20 + 10));
    assert.equal(timeline.size <= 4, true);
  }
  assert.equal(timeline.get('video', 0), undefined);
  assert.equal(timeline.get('video', timeline.end('video') - 1).time, 1980);
  assert.equal(timeline.stats.droppedItems, 0);
  assert.equal(timeline.stats.trimmedItems, 196);
});

test('shared byte and item bounds evict the oldest track front and reject oversized units', () => {
  let timeline = new MediaTimeline(0, 1, 10, 8);
  timeline.add(item('audio', 10, 3));
  timeline.add(item('video', 20, 4));
  timeline.add(item('video', 30, 4));
  assert.equal(timeline.stats.retainedBytes, 8);
  assert.equal(timeline.start('audio'), 1);
  assert.equal(timeline.add(item('audio', 40, 9)), undefined);
  assert.equal(timeline.stats.droppedItems, 1);
  assert.equal(timeline.stats.videoItems, 2);
  assert.equal(timeline.stats.audioItems, 0);
});

test('time trimming and clearing release payloads without reusing old track indexes', () => {
  let timeline = new MediaTimeline(5, 2, 4);
  timeline.add(item('video', 100, 2));
  timeline.add(item('audio', 200, 3));
  assert.equal(timeline.trim(NaN), 0);
  assert.equal(timeline.trim(150), 1);
  assert.equal(timeline.stats.retainedBytes, 3);
  timeline.clear();
  assert.equal(timeline.empty, true);
  assert.equal(timeline.stats.retainedBytes, 0);
  assert.equal(timeline.add(item('audio', 1)), 6);
  assert.equal(timeline.get('audio', 5), undefined);
});

test('invalid units cannot alter cursors or accounting', () => {
  let timeline = new MediaTimeline();
  for (let invalid of [undefined, null, {}, item('meta', 1), item('audio', NaN), item('video', 1, -1)]) {
    assert.equal(timeline.add(invalid), undefined);
  }
  assert.equal(timeline.size, 0);
  assert.equal(timeline.end('video'), 0);
});

test('invalid retention limits fail before accepting media', () => {
  for (let [items, bytes] of [
    [0, 8],
    [-1, 8],
    [1.5, 8],
    [4, 0],
    [4, Infinity],
  ]) {
    assert.throws(() => new MediaTimeline(0, 1, items, bytes), /retention/);
  }
});
