// MediaTimeline
// Part of homebridge-nest-accfactory
//
// Shared retention for complete encoded media in independent video and audio rings.
//
// Responsibilities:
// - Keep stable track indexes through eviction and source resets
// - Enforce shared item and payload-byte bounds without waiting for readers
// - Trim expired source time and seek timestamps within an ordered track
// - Retain frame payloads and their original decoder configuration references
//
// Notes:
// - Streamer owns the time-retention policy, reader cursors and decoder recovery
// - A stalled reader cannot pin this buffer or block current source media
// - Default capacity is per ring; maximum items and bytes are shared across both
//
// Code version 2026.10.24
// Mark Hulskamp
'use strict';

// Import our modules
import RingBuffer from '../../ringbuffer.js';

// Define constants
const DEFAULT_CAPACITY = 1024;
const DEFAULT_MAX_ITEMS = 8192;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

const MEDIA_TYPE = {
  VIDEO: 'video',
  AUDIO: 'audio',
};

// MediaTimeline object
export default class MediaTimeline {
  #tracks = {};
  #bytes = 0;
  #maxItems = DEFAULT_MAX_ITEMS;
  #maxBytes = DEFAULT_MAX_BYTES;
  #trimmed = 0;
  #dropped = 0;

  constructor(startIndex = 0, capacity = DEFAULT_CAPACITY, maxItems = DEFAULT_MAX_ITEMS, maxBytes = DEFAULT_MAX_BYTES) {
    if (Number.isInteger(maxItems) !== true || maxItems <= 0 || Number.isSafeInteger(maxBytes) !== true || maxBytes <= 0) {
      throw new RangeError('Media retention requires positive item and byte limits');
    }

    this.#maxItems = maxItems;
    this.#maxBytes = maxBytes;

    for (let type of Object.values(MEDIA_TYPE)) {
      this.#tracks[type] = new RingBuffer(startIndex, capacity, maxItems);
    }
  }

  get size() {
    return this.#tracks.video.size + this.#tracks.audio.size;
  }

  get empty() {
    return this.size === 0;
  }

  get stats() {
    return {
      size: this.size,
      capacity: this.#tracks.video.capacity + this.#tracks.audio.capacity,
      maxCapacity: this.#maxItems,
      retainedBytes: this.#bytes,
      maxBytes: this.#maxBytes,
      videoItems: this.#tracks.video.size,
      audioItems: this.#tracks.audio.size,
      trimmedItems: this.#trimmed,
      droppedItems: this.#dropped,
    };
  }

  start(type) {
    return this.#tracks[type].startIndex;
  }

  end(type) {
    return this.#tracks[type].tailIndex;
  }

  get(type, index) {
    return this.#tracks[type].at(index);
  }

  add(item) {
    if (item?.type !== MEDIA_TYPE.VIDEO && item?.type !== MEDIA_TYPE.AUDIO) {
      return undefined;
    }

    let track = this.#tracks[item.type];
    if (track === undefined || Number.isFinite(item.time) !== true || Number.isFinite(item.bytes) !== true || item.bytes < 0) {
      return undefined;
    }

    if (item.bytes > this.#maxBytes) {
      this.#dropped++;
      return undefined;
    }

    // Evict oldest presentation time until both limits admit this complete unit.
    // Readers detect their expired cursor and recover at the next decodable IDR.
    while (this.size >= this.#maxItems || this.#bytes + item.bytes > this.#maxBytes) {
      let video = this.#tracks.video.getByOffset(0);
      let audio = this.#tracks.audio.getByOffset(0);
      this.#shift(video !== undefined && (audio === undefined || video.time <= audio.time) ? MEDIA_TYPE.VIDEO : MEDIA_TYPE.AUDIO);
    }

    item.index = track.tailIndex;
    track.push(item);
    this.#bytes += item.bytes;

    return item.index;
  }

  trim(cutoffTime) {
    let before = this.size;

    if (Number.isFinite(cutoffTime) !== true) {
      return 0;
    }

    for (let type of Object.values(MEDIA_TYPE)) {
      while (this.#tracks[type].getByOffset(0)?.time < cutoffTime) {
        this.#shift(type);
      }
    }

    return before - this.size;
  }

  #shift(type) {
    let track = this.#tracks[type];
    let item = track.getByOffset(0);

    this.#bytes -= item.bytes;
    track.shift(1);
    this.#trimmed++;
  }

  seek(type, time) {
    let track = this.#tracks[type];
    let left = 0;
    let right = track.size;

    // Source timestamps increase within each track; mixed arrival order no longer
    // requires a full-buffer search or auxiliary media-index arrays.
    while (left < right) {
      let middle = (left + right) >>> 1;
      if (track.getByOffset(middle).time < time) {
        left = middle + 1;
      } else {
        right = middle;
      }
    }

    return track.startIndex + left;
  }

  clear() {
    // Preserve track indexes across generations so old cursors cannot alias new data.
    for (let track of Object.values(this.#tracks)) {
      track.clear(track.tailIndex);
    }

    this.#bytes = 0;
  }
}
