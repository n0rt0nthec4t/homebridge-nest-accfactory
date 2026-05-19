// RingBuffer
// Part of homebridge-nest-accfactory
//
// Dynamically-sized circular buffer with logical indexing.
//
// Features:
// - O(1) push and shift operations
// - Dynamic capacity growth up to configured maximum
// - Monotonically increasing logical indexing
// - Zero-copy trimming using circular head movement
// - Preallocated storage to reduce allocation churn
// - Logical index and offset-based access helpers
// - Iterable support for for...of, Array.from(), and spread syntax
//
// Terminology:
// - head: physical index of the first logical item
// - size: number of retained items
// - startIndex: logical index of the first retained item
// - tailIndex: logical index immediately after the retained window
//
// Access is performed using logical offsets (0..size-1),
// which are translated to physical storage locations
// using modulo arithmetic.
//
// Intended use:
// - Timeline buffers
// - RTP/media packet queues
// - Jitter buffers
// - Rolling history windows
//
// Code version 2026.05.17
// Mark Hulskamp
'use strict';

// Define constants
const RINGBUFFER_DEFAULT_CAPACITY = 1024;
const RINGBUFFER_MAX_CAPACITY = 65535; // Arbitrary upper limit to prevent unbounded growth. Adjust as needed.

// RingBuffer object
export default class RingBuffer {
  items = [];
  capacity = 0;
  maxCapacity = RINGBUFFER_MAX_CAPACITY;
  head = 0;
  size = 0;
  startIndex = 0;

  constructor(startIndex = 0, capacity = RINGBUFFER_DEFAULT_CAPACITY, maxCapacity = RINGBUFFER_MAX_CAPACITY) {
    // Clamp maximum capacity to a sane positive integer.
    // Allows generic callers to tune growth limits without changing module defaults.
    this.maxCapacity = Number.isInteger(maxCapacity) === true && maxCapacity > 0 ? maxCapacity : RINGBUFFER_MAX_CAPACITY;

    // Clamp caller supplied capacity to configured limits.
    // If capacity exceeds maxCapacity, maxCapacity wins because this buffer
    // must never grow beyond the configured ceiling.
    this.capacity =
      Number.isInteger(capacity) === true && capacity > 0
        ? Math.min(capacity, this.maxCapacity)
        : Math.min(RINGBUFFER_DEFAULT_CAPACITY, this.maxCapacity);

    // Preallocate backing array so push operations avoid repeated array growth allocations.
    this.items = new Array(this.capacity);

    // Logical index of the first retained item.
    // Used externally to preserve cursor stability even when items are trimmed.
    this.startIndex = Number.isInteger(startIndex) === true && startIndex >= 0 ? startIndex : 0;
  }

  get empty() {
    // Convenience helper for callers.
    return this.size === 0;
  }

  get full() {
    // Convenience helper for callers.
    return this.size >= this.capacity;
  }

  get tailIndex() {
    // Logical index immediately after the retained window.
    return this.startIndex + this.size;
  }

  [Symbol.iterator]() {
    let index = 0;

    // Allow RingBuffer to be used with native iteration helpers:
    // for...of, Array.from(), spread syntax, etc.
    // This is intended as a convenience API, not as the hot-path access method
    // for streaming loops where allocation control matters.
    return {
      next: () => {
        if (index < this.size) {
          return {
            value: this.getByOffset(index++),
            done: false,
          };
        }

        return { done: true };
      },
    };
  }

  physicalOffset(offset) {
    // Convert a logical offset into a physical storage index.
    //
    // head = physical location of logical offset 0.
    // Wrap using modulo arithmetic so storage behaves as a circular array.
    if (Number.isInteger(offset) !== true || offset < 0) {
      return -1;
    }

    return (this.head + offset) % this.capacity;
  }

  getByOffset(offset) {
    let physicalOffset = 0;

    // Bounds check against retained logical size.
    if (Number.isInteger(offset) !== true || offset < 0 || offset >= this.size) {
      return undefined;
    }

    // Translate logical offset -> physical storage slot.
    physicalOffset = this.physicalOffset(offset);

    return physicalOffset >= 0 ? this.items[physicalOffset] : undefined;
  }

  at(logicalIndex) {
    // Resolve an item by logical index rather than offset.
    // Useful for callers working with timeline indexes.
    if (Number.isInteger(logicalIndex) !== true || logicalIndex < this.startIndex || logicalIndex >= this.startIndex + this.size) {
      return undefined;
    }

    return this.getByOffset(logicalIndex - this.startIndex);
  }

  grow() {
    let newCapacity = 0;
    let newItems = undefined;
    let index = 0;

    // Prevent unbounded growth.
    // Once the maximum configured capacity is reached, expansion is rejected.
    if (this.capacity >= this.maxCapacity) {
      return false;
    }

    // Double capacity to amortize resize cost.
    // Clamp to configured maximum.
    newCapacity = Math.min(this.capacity * 2, this.maxCapacity);
    newItems = new Array(newCapacity);

    // Re-pack retained items linearly starting at index 0.
    // Removes physical wrap-around and simplifies indexing.
    while (index < this.size) {
      newItems[index] = this.getByOffset(index);
      index++;
    }

    this.items = newItems;
    this.capacity = newCapacity;

    // Logical offset 0 now begins at physical slot 0.
    this.head = 0;

    return true;
  }

  push(item) {
    let tailOffset = 0;

    // Expand if the retained window has filled capacity.
    if (this.size >= this.capacity) {
      if (this.grow() !== true) {
        return false;
      }
    }

    // Tail = logical offset "size".
    // Convert into physical storage slot.
    tailOffset = (this.head + this.size) % this.capacity;

    // Insert at tail and expand retained size.
    this.items[tailOffset] = item;
    this.size++;

    return true;
  }

  shift(count, resetStartIndex = undefined) {
    let removeCount = 0;
    let index = 0;
    let physicalOffset = 0;

    // Remove N items from the logical front.
    if (Number.isInteger(count) !== true || count <= 0) {
      return false;
    }

    removeCount = Math.min(count, this.size);

    // Remove retained references so GC can reclaim memory.
    while (index < removeCount) {
      physicalOffset = this.physicalOffset(index);

      if (physicalOffset >= 0) {
        this.items[physicalOffset] = undefined;
      }

      index++;
    }

    // Advance retained head position.
    this.head = (this.head + removeCount) % this.capacity;
    this.size -= removeCount;
    this.startIndex += removeCount;

    // Reset internal state once fully emptied.
    if (this.size === 0) {
      this.head = 0;

      if (Number.isInteger(resetStartIndex) === true && resetStartIndex >= 0) {
        this.startIndex = resetStartIndex;
      }
    }

    return true;
  }

  clear(resetStartIndex = 0) {
    let index = 0;
    let physicalOffset = 0;

    // Clear retained references.
    while (index < this.size) {
      physicalOffset = this.physicalOffset(index);

      if (physicalOffset >= 0) {
        this.items[physicalOffset] = undefined;
      }

      index++;
    }

    // Reset retained state.
    this.head = 0;
    this.size = 0;

    if (Number.isInteger(resetStartIndex) === true && resetStartIndex >= 0) {
      this.startIndex = resetStartIndex;
    }

    return true;
  }
}
