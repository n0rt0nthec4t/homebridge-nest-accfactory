// Verify bounded ring storage, logical indexes and retained-reference cleanup across wraparound.
import assert from 'node:assert/strict';
import test from 'node:test';

import RingBuffer from '../src/ringbuffer.js';

test('RingBuffer grows while preserving order and logical indexes', () => {
  let buffer = new RingBuffer(10, 2, 4);

  buffer.push('a');
  buffer.push('b');
  assert.equal(buffer.push('c'), true);

  assert.deepEqual([...buffer], ['a', 'b', 'c']);
  assert.equal(buffer.capacity, 4);
  assert.equal(buffer.at(10), 'a');
  assert.equal(buffer.at(12), 'c');
  assert.equal(buffer.tailIndex, 13);
});

test('RingBuffer preserves order after storage wraps', () => {
  let buffer = new RingBuffer(0, 3, 3);

  buffer.push('a');
  buffer.push('b');
  buffer.push('c');
  buffer.shift(2);
  buffer.push('d');
  buffer.push('e');

  assert.deepEqual([...buffer], ['c', 'd', 'e']);
  assert.equal(buffer.startIndex, 2);
  assert.equal(buffer.at(4), 'e');
});

test('RingBuffer rejects items beyond its maximum capacity', () => {
  let buffer = new RingBuffer(0, 2, 2);

  assert.equal(buffer.push('a'), true);
  assert.equal(buffer.push('b'), true);
  assert.equal(buffer.push('c'), false);
  assert.deepEqual([...buffer], ['a', 'b']);
});

test('RingBuffer clear resets retained state and indexing', () => {
  let buffer = new RingBuffer(20, 2, 2);

  buffer.push('a');
  buffer.clear(100);

  assert.equal(buffer.empty, true);
  assert.equal(buffer.startIndex, 100);
  assert.equal(buffer.tailIndex, 100);
  assert.equal(buffer.at(20), undefined);
});

test('RingBuffer rejects invalid offsets and shifts without changing retained order', () => {
  let buffer = new RingBuffer(10, 2, 2);
  buffer.push('a');
  buffer.push('b');
  assert.equal(buffer.full, true);
  for (let invalid of [-1, 0.5, NaN, undefined]) {
    assert.equal(buffer.physicalOffset(invalid), -1);
    assert.equal(buffer.getByOffset(invalid), undefined);
    assert.equal(buffer.at(invalid), undefined);
    assert.equal(buffer.shift(invalid), false);
  }
  assert.equal(buffer.shift(0), false);
  assert.equal(buffer.getByOffset(2), undefined);
  assert.deepEqual([...buffer], ['a', 'b']);
});
test('RingBuffer releases retained references when an oversized shift empties wrapped storage', () => {
  let buffer = new RingBuffer(10, 3, 3);
  for (let value of ['a', 'b', 'c']) {
    buffer.push(value);
  }
  buffer.shift(2);
  buffer.push('d');
  buffer.push('e');
  assert.equal(buffer.shift(100, 50), true);
  assert.equal(buffer.empty, true);
  assert.equal(buffer.startIndex, 50);
  assert.equal(
    buffer.items.every((value) => value === undefined),
    true,
  );
  assert.equal(buffer.full, false);
  buffer.push('new');
  assert.equal(buffer.at(50), 'new');
});
