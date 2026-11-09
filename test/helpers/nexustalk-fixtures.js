// Encode real NexusTalk wire messages and replace only the TLS socket boundary.
// Shared by parser tests and end-to-end media tests; no backend connection is opened.
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { getProtoRoot } from '../../src/protobuf.js';

let root = getProtoRoot(fileURLToPath(new URL('../../src/protobuf/nest/nexustalk.proto', import.meta.url)));

export function nexusPacket(id, type, value = {}) {
  let message = type === undefined ? Buffer.alloc(0) : root.lookupType('nest.nexustalk.v1.' + type);
  let payload = Buffer.isBuffer(message) === true ? message : Buffer.from(message.encode(message.fromObject(value)).finish());
  let header = Buffer.alloc(id === 205 ? 5 : 3);
  header[0] = id;
  if (id === 205) {
    header.writeUInt32BE(payload.length, 1);
  } else {
    header.writeUInt16BE(payload.length, 1);
  }
  return Buffer.concat([header, payload]);
}

export function nexusSocket(settings, handshake) {
  let socket = new EventEmitter();
  return Object.assign(socket, {
    settings,
    handshake,
    destroyed: false,
    readyState: 'open',
    writable: true,
    writes: [],
    cork() {},
    uncork() {},
    setKeepAlive() {},
    write(data) {
      this.writes.push(Buffer.from(data));
      return true;
    },
    destroy() {
      this.destroyed = true;
      this.writable = false;
    },
  });
}
