// Construct complete ADTS fixtures with explicit header fields for AAC boundary tests.
export function adts(payload, { frequency = 3, channels = 1, profile = 2, crc = false, blocks = 0 } = {}) {
  let headerBytes = crc === true ? 9 : 7;
  let frameBytes = headerBytes + payload.length;
  let frame = Buffer.alloc(frameBytes);
  frame[0] = 0xff;
  frame[1] = crc === true ? 0xf0 : 0xf1;
  frame[2] = ((profile - 1) << 6) | (frequency << 2) | (channels >> 2);
  frame[3] = ((channels & 3) << 6) | (frameBytes >> 11);
  frame[4] = (frameBytes >> 3) & 255;
  frame[5] = ((frameBytes & 7) << 5) | 31;
  frame[6] = 0xfc | blocks;
  payload.copy(frame, headerBytes);
  return frame;
}
