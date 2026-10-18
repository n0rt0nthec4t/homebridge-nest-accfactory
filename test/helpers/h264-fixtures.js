// Encode SPS fixture fields as Exp-Golomb/RBSP data for parser and transport integration tests.
import { Buffer } from 'node:buffer';

export function sequenceParameterSet(options = {}) {
  let profile = options.profile ?? 66;
  let chroma = options.chroma ?? 1;
  let bits = [0x67, profile, 0, 31].map((value) => value.toString(2).padStart(8, '0')).join('');
  let bit = (value) => {
    bits += value === true ? '1' : '0';
  };
  let ue = (value) => {
    let encoded = (value + 1).toString(2);
    bits += '0'.repeat(encoded.length - 1) + encoded;
  };
  let se = (value) => ue(value <= 0 ? -value * 2 : value * 2 - 1);
  ue(0); // Sequence parameter set id.
  if (profile !== 66 && profile !== 77) {
    ue(chroma);
    if (chroma === 3) {
      bit(false);
    }
    ue(0);
    ue(0);
    bit(false);
    bit(options.scaling === true);
    if (options.scaling === true) {
      for (let list = 0; list < (chroma === 3 ? 12 : 8); list++) {
        bit(list < 2);
        if (list === 0) {
          se(-8);
        }
        if (list === 1) {
          for (let index = 0; index < 16; index++) {
            se(index === 0 ? 1 : 0);
          }
        }
      }
    }
  }
  ue(0); // Frame number width.
  let poc = options.poc ?? 0;
  ue(poc);
  if (poc === 0) {
    ue(0);
  }
  if (poc === 1) {
    bit(false);
    se(-2);
    se(3);
    ue(2);
    se(-1);
    se(1);
  }
  ue(1);
  bit(false); // Reference frames, gaps permitted.
  ue((options.widthMbs ?? 120) - 1);
  ue((options.heightMbs ?? 68) - 1);
  bit(options.interlaced !== true);
  if (options.interlaced === true) {
    bit(true);
  }
  bit(true);
  bit(options.crop !== undefined);
  if (options.crop !== undefined) {
    for (let offset of options.crop) {
      ue(offset);
    }
  }
  bit(true); // RBSP trailing stop bit.
  bits = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
  return Buffer.from(bits.match(/.{8}/g).map((byte) => parseInt(byte, 2)));
}
