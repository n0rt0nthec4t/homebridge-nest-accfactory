// MediaTimeline
// Part of homebridge-nest-accfactory
//
// Shared ordered media timeline used by Streamer.
//
// Maintains a single RingBuffer containing all retained media items
// (video, audio, talkback, metadata) in timeline order while exposing
// lightweight media-specific indexes for fast lookup.
//
// Design goals:
// - Preserve a single ordered media timeline
// - Avoid duplicated video/audio buffers
// - Provide O(log n) media-specific lookup via indexed search
// - Maintain stable logical indexes during trimming
// - Keep retention and timeline ordering consistent across all media
//
// Architecture:
// - One shared RingBuffer stores all retained media items
// - Media-specific indexes provide efficient lookup:
//   - video index
//   - audio index
//   - keyframe index
// - Output sessions maintain independent cursors into the shared timeline
// - Trimming remains protected by the earliest active output cursor
//
// This preserves Streamer's existing timing and playout model:
// - one shared media timeline
// - one global monotonically increasing item index
// - independent video/audio output cursors
// - protected-cursor based retention trimming
//
// Benefits:
// - No duplicated media storage
// - Faster video/audio lookup without buffer walking
// - Efficient keyframe discovery for decoder-safe startup
// - Retains timeline-based A/V ordering
// - Minimal memory overhead from lightweight indexes
//
// Code version 2026.05.18
// Mark Hulskamp
'use strict';

// Import our modules
import RingBuffer from './ringbuffer.js';

// Define constants
const MEDIA_TIMELINE_DEFAULT_CAPACITY = 1024;
const MEDIA_TIMELINE_MAX_CAPACITY = 8192;
const MEDIA_TIMELINE_INDEX_COMPACT_THRESHOLD = 256;
const MEDIA_TIMELINE_TYPE_VIDEO = 'video';
const MEDIA_TIMELINE_TYPE_AUDIO = 'audio';

// MediaTimeline object
export default class MediaTimeline {
  #buffer = undefined; // Shared ordered media buffer
  #itemIndex = 0; // Next logical media item index

  #videoIndexes = []; // Logical indexes for video items
  #audioIndexes = []; // Logical indexes for audio items
  #keyframeIndexes = []; // Logical indexes for video keyframes

  #videoIndexOffset = 0; // First valid entry in #videoIndexes
  #audioIndexOffset = 0; // First valid entry in #audioIndexes
  #keyframeIndexOffset = 0; // First valid entry in #keyframeIndexes

  #trimmedItems = 0; // Total items removed by retention trimming
  #droppedItems = 0; // Total items rejected because retained capacity was full

  constructor(startIndex = 0, capacity = MEDIA_TIMELINE_DEFAULT_CAPACITY, maxCapacity = MEDIA_TIMELINE_MAX_CAPACITY) {
    // Initialise the logical item index.
    this.#itemIndex = Number.isInteger(startIndex) === true && startIndex >= 0 ? startIndex : 0;

    // Create one shared RingBuffer so video/audio retain a single ordered timeline.
    // Capacity and maximum capacity are caller-tunable so Streamer can preserve
    // its historical 8192 item ceiling while RingBuffer remains generic.
    this.#buffer = new RingBuffer(this.#itemIndex, capacity, maxCapacity);
  }

  get startIndex() {
    // First retained logical media index.
    return this.#buffer.startIndex;
  }

  get size() {
    // Number of retained media items.
    return this.#buffer.size;
  }

  get nextIndex() {
    // Next logical media index that will be assigned.
    return this.#itemIndex;
  }

  get endIndex() {
    // Logical index immediately after the retained window.
    return this.#buffer.startIndex + this.#buffer.size;
  }

  get empty() {
    // Convenience helper for callers.
    return this.#buffer.size === 0;
  }

  get stats() {
    // Lightweight timeline diagnostics.
    // These are safe to call from support/debug logging without scanning buffer data.
    return {
      startIndex: this.#buffer.startIndex,
      nextIndex: this.#itemIndex,
      size: this.#buffer.size,
      capacity: this.#buffer.capacity,
      maxCapacity: this.#buffer.maxCapacity,
      videoIndexes: this.#videoIndexes.length - this.#videoIndexOffset,
      audioIndexes: this.#audioIndexes.length - this.#audioIndexOffset,
      keyframeIndexes: this.#keyframeIndexes.length - this.#keyframeIndexOffset,
      trimmedItems: this.#trimmedItems,
      droppedItems: this.#droppedItems,
    };
  }

  clear(resetStartIndex = 0) {
    // Reset logical indexing to a known position.
    this.#itemIndex = Number.isInteger(resetStartIndex) === true && resetStartIndex >= 0 ? resetStartIndex : 0;

    // Clear the underlying shared buffer.
    this.#buffer.clear(this.#itemIndex);

    // Clear indexes and reset their logical heads.
    this.#videoIndexes = [];
    this.#audioIndexes = [];
    this.#keyframeIndexes = [];

    this.#videoIndexOffset = 0;
    this.#audioIndexOffset = 0;
    this.#keyframeIndexOffset = 0;

    this.#trimmedItems = 0;
    this.#droppedItems = 0;
  }

  add(item) {
    // Validate media item before assigning an index.
    if (typeof item !== 'object' || item === null) {
      return undefined;
    }

    // Assign the global logical timeline index.
    item.index = this.#itemIndex;

    // Store in the shared ordered buffer.
    if (this.#buffer.push(item) !== true) {
      this.#droppedItems++;
      return undefined;
    }

    // Maintain video and keyframe indexes.
    if (item.type === MEDIA_TIMELINE_TYPE_VIDEO) {
      this.#videoIndexes.push(item.index);

      if (item.keyFrame === true) {
        this.#keyframeIndexes.push(item.index);
      }
    }

    // Maintain audio index.
    if (item.type === MEDIA_TIMELINE_TYPE_AUDIO) {
      this.#audioIndexes.push(item.index);
    }

    // Advance only after the item was accepted.
    this.#itemIndex++;

    return item.index;
  }

  get(index) {
    // Validate logical index.
    if (Number.isInteger(index) !== true) {
      return undefined;
    }

    // Reject anything outside the retained media window.
    if (index < this.#buffer.startIndex || index >= this.#buffer.startIndex + this.#buffer.size) {
      return undefined;
    }

    // Convert logical index to RingBuffer offset.
    return this.#buffer.getByOffset(index - this.#buffer.startIndex);
  }

  first() {
    // Return oldest retained item.
    return this.#buffer.getByOffset(0);
  }

  last() {
    // Return newest retained item.
    if (this.#buffer.size === 0) {
      return undefined;
    }

    return this.#buffer.getByOffset(this.#buffer.size - 1);
  }

  latestTime() {
    let offset = this.#buffer.size - 1;
    let item = undefined;

    // Return the newest retained media timestamp, skipping untimed metadata.
    while (offset >= 0) {
      item = this.#buffer.getByOffset(offset);

      if (typeof item?.time === 'number' && Number.isFinite(item.time) === true) {
        return item.time;
      }

      offset--;
    }

    return undefined;
  }

  nextVideoFrom(index) {
    // Resolve next video item without scanning mixed media.
    return this.get(this.#nextIndexFrom(this.#videoIndexes, this.#videoIndexOffset, index));
  }

  nextAudioFrom(index) {
    // Resolve next audio item without scanning mixed media.
    return this.get(this.#nextIndexFrom(this.#audioIndexes, this.#audioIndexOffset, index));
  }

  nextKeyFrameFrom(index) {
    // Resolve next keyframe for decoder-safe startup.
    return this.get(this.#nextIndexFrom(this.#keyframeIndexes, this.#keyframeIndexOffset, index));
  }

  trim(cutoffTime, protectedIndex = undefined) {
    let trimCount = 0;
    let item = undefined;
    let protectedOffset = -1;

    // Nothing to trim if no retained media exists.
    if (this.#buffer.size === 0 || Number.isFinite(cutoffTime) !== true) {
      return 0;
    }

    // Convert protected logical index into retained buffer offset.
    if (Number.isInteger(protectedIndex) === true && protectedIndex >= this.#buffer.startIndex) {
      protectedOffset = protectedIndex - this.#buffer.startIndex;
    }

    // Count expired, unprotected items from the front.
    while (trimCount < this.#buffer.size) {
      if (protectedOffset !== -1 && trimCount >= protectedOffset) {
        break;
      }

      item = this.#buffer.getByOffset(trimCount);

      // Untimed items cannot be retained by age, so allow them to be trimmed.
      if (typeof item?.time !== 'number') {
        trimCount++;
        continue;
      }

      if (item.time >= cutoffTime) {
        break;
      }

      trimCount++;
    }

    if (trimCount === 0) {
      return 0;
    }

    // Trim the shared buffer.
    this.#buffer.shift(trimCount, this.#itemIndex);
    this.#trimmedItems += trimCount;

    // Move index heads forward without Array.shift().
    this.#trimIndexes();

    return trimCount;
  }

  closestToTime(time) {
    let index = 0;
    let item = undefined;
    let closestItem = undefined;
    let closestDelta = Number.POSITIVE_INFINITY;
    let itemDelta = 0;

    // Recording/session start selection requires a valid timestamp.
    if (Number.isFinite(time) !== true || this.#buffer.size === 0) {
      return undefined;
    }

    // The shared timeline is ordered by arrival/index, not guaranteed by media time.
    // Audio and video timestamps are normalised per media type, so the mixed
    // timeline may not be globally monotonic. Use a full scan here for correctness.
    //
    // This only happens when creating an output, not on every scheduler tick.
    while (index < this.#buffer.size) {
      item = this.#buffer.getByOffset(index);

      if (typeof item?.time === 'number') {
        itemDelta = Math.abs(item.time - time);

        if (itemDelta < closestDelta) {
          closestDelta = itemDelta;
          closestItem = item;
        }
      }

      index++;
    }

    return closestItem;
  }

  protectedStart(outputs) {
    let protectedIndex = this.#itemIndex;

    // No outputs means no active protected cursor.
    if (outputs instanceof Map !== true || outputs.size === 0) {
      return protectedIndex;
    }

    // Find the oldest valid cursor still required by any output.
    for (let output of outputs.values()) {
      if (Number.isInteger(output?.cursor) === true && output.cursor >= this.#buffer.startIndex && output.cursor < protectedIndex) {
        protectedIndex = output.cursor;
      }
    }

    return protectedIndex;
  }

  #nextIndexFrom(indexes, offset, index) {
    let left = offset;
    let right = indexes.length - 1;
    let middle = 0;
    let found = undefined;

    // Default invalid cursor requests to retained start.
    if (Number.isInteger(index) !== true) {
      index = this.#buffer.startIndex;
    }

    // Clamp before binary search.
    if (index < this.#buffer.startIndex) {
      index = this.#buffer.startIndex;
    }

    // Binary search for first indexed media item >= requested index.
    while (left <= right) {
      middle = Math.floor((left + right) / 2);

      if (indexes[middle] >= index) {
        found = indexes[middle];
        right = middle - 1;
      } else {
        left = middle + 1;
      }
    }

    return found;
  }

  #trimIndexes() {
    // Advance video index head past trimmed media.
    while (this.#videoIndexOffset < this.#videoIndexes.length && this.#videoIndexes[this.#videoIndexOffset] < this.#buffer.startIndex) {
      this.#videoIndexOffset++;
    }

    // Advance audio index head past trimmed media.
    while (this.#audioIndexOffset < this.#audioIndexes.length && this.#audioIndexes[this.#audioIndexOffset] < this.#buffer.startIndex) {
      this.#audioIndexOffset++;
    }

    // Advance keyframe index head past trimmed media.
    while (
      this.#keyframeIndexOffset < this.#keyframeIndexes.length &&
      this.#keyframeIndexes[this.#keyframeIndexOffset] < this.#buffer.startIndex
    ) {
      this.#keyframeIndexOffset++;
    }

    // Compact occasionally so stale index entries do not accumulate forever.
    this.#compactIndexes();
  }

  #compactIndexes() {
    // Compact video index array only after enough stale entries accumulate.
    // This avoids doing O(n) array work on every small trim.
    if (this.#videoIndexOffset >= MEDIA_TIMELINE_INDEX_COMPACT_THRESHOLD) {
      this.#videoIndexes = this.#videoIndexes.slice(this.#videoIndexOffset);
      this.#videoIndexOffset = 0;
    }

    // Compact audio index array only after enough stale entries accumulate.
    if (this.#audioIndexOffset >= MEDIA_TIMELINE_INDEX_COMPACT_THRESHOLD) {
      this.#audioIndexes = this.#audioIndexes.slice(this.#audioIndexOffset);
      this.#audioIndexOffset = 0;
    }

    // Compact keyframe index array only after enough stale entries accumulate.
    if (this.#keyframeIndexOffset >= MEDIA_TIMELINE_INDEX_COMPACT_THRESHOLD) {
      this.#keyframeIndexes = this.#keyframeIndexes.slice(this.#keyframeIndexOffset);
      this.#keyframeIndexOffset = 0;
    }
  }
}
