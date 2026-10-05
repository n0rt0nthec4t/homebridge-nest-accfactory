// Drive the real NexusTalk parser/lifecycle with protobuf packets and a fake TLS socket.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import tls from 'node:tls';
import { fileURLToPath, URL } from 'node:url';
import test from 'node:test';
import { getProtoRoot } from '../../src/protobuf.js';

// Streamer is used only for media type constants here; avoid its Homebridge imports.
let location = new URL('../../src/nexustalk.js', import.meta.url);
let source = await readFile(location, 'utf8');
// Named timer imports otherwise retain the originals before per-test timer mocks activate.
let timerModule =
  'data:text/javascript,' +
  encodeURIComponent(
    'import timers from "node:timers"; ' +
      'export function setInterval(...args) { return timers.setInterval(...args); } ' +
      'export function clearInterval(...args) { return timers.clearInterval(...args); }',
  );
source = source.replace(/from '([^']+)'/g, (match, specifier) => {
  let target =
    specifier === './streamer.js'
      ? 'data:text/javascript,export default { MEDIA_TYPE: { AUDIO: "audio", VIDEO: "video" } };'
      : specifier === 'node:timers'
        ? timerModule
        : specifier.startsWith('.') === true
          ? new URL(specifier, location).href
          : specifier;
  return 'from ' + JSON.stringify(target);
});
let { default: NexusTalk } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
let root = getProtoRoot(fileURLToPath(new URL('../../src/protobuf/nest/nexustalk.proto', import.meta.url)));

function packet(id, type, value = {}) {
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

function setup(t, options = {}) {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 100000 });
  let sockets = [];
  let media = [];
  let active = true;
  t.mock.method(tls, 'connect', (settings, handshake) => {
    let socket = new EventEmitter();
    Object.assign(socket, {
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
    sockets.push(socket);
    return socket;
  });
  let transport = new NexusTalk({
    uuid: 'camera.test',
    host: 'camera.example',
    apiAccess: { token: 'test-token' },
    consumer: { active: () => active, media: (item) => media.push(item) },
    ...options,
  });
  t.after(async () => {
    active = false;
    await transport.close();
    for (let socket of sockets) {
      socket.emit('close');
    }
  });
  return { transport, sockets, media };
}

async function open(context) {
  let opening = context.transport.open();
  context.sockets.at(-1).handshake();
  await opening;
  return context.sockets.at(-1);
}

function begin(socket) {
  socket.emit('data', packet(200));
  socket.emit(
    'data',
    packet(202, 'PlaybackBegin', {
      sessionId: 7,
      channels: [
        { channelId: 1, codec: 'H264', sampleRate: 90000, startTime: 100 },
        { channelId: 2, codec: 'AAC', sampleRate: 48000, startTime: 100.1 },
      ],
    }),
  );
}

test('NexusTalk opens only one socket and starts playback after complete authorisation', async (t) => {
  let context = setup(t);
  let socket = await open(context);
  await context.transport.open();
  assert.equal(context.sockets.length, 1);
  assert.equal(socket.writes[0][0], 100);
  let hello = root.lookupType('nest.nexustalk.v1.Hello').decode(socket.writes[1]);
  assert.equal(hello.uuid, 'test');
  assert.equal(root.lookupType('nest.nexustalk.v1.AuthoriseRequest').decode(hello.authoriseRequest).sessionToken, 'test-token');
  let ok = packet(200);
  socket.emit('data', ok.subarray(0, 2));
  assert.equal(socket.writes.length, 2);
  socket.emit('data', ok.subarray(2));
  assert.equal(socket.writes[2][0], 103);
  t.mock.timers.tick(15000);
  assert.equal(socket.writes.at(-2)[0], 1);
  await context.transport.close();
  let count = socket.writes.length;
  t.mock.timers.tick(30000);
  assert.equal(socket.writes.length, count);
});

test('NexusTalk decodes fragmented and coalesced playback packets with source timestamps', async (t) => {
  let context = setup(t);
  let socket = await open(context);
  begin(socket);
  let audio = packet(205, 'PlaybackPacket', { channelId: 2, timestampDelta: 480, payload: Buffer.from([1, 2]) });
  for (let byte of audio) {
    socket.emit('data', Buffer.from([byte]));
  }
  assert.equal(context.media.length, 1);
  assert.equal(context.media[0].timestamp, 100110);
  let next = packet(204, 'PlaybackPacket', { channelId: 2, timestampDelta: 960, payload: Buffer.from([3]) });
  let negative = packet(204, 'PlaybackPacket', { channelId: 2, timestampDelta: -480, payload: Buffer.from([4]) });
  socket.emit('data', Buffer.concat([next, negative]));
  assert.deepEqual(
    context.media.map((item) => item.timestamp),
    [100110, 100130, 100130],
  );
  assert.deepEqual(context.media[0].data, Buffer.from([1, 2]));
});

test('NexusTalk grows its packet buffer and recovers after oversized framing', async (t) => {
  let context = setup(t);
  let socket = await open(context);
  begin(socket);
  let payload = Buffer.alloc(300000, 1);
  socket.emit('data', packet(205, 'PlaybackPacket', { channelId: 2, payload }));
  assert.deepEqual(context.media[0].data, payload);
  let invalid = Buffer.alloc(5);
  invalid[0] = 205;
  invalid.writeUInt32BE(5 * 1024 * 1024 + 1, 1);
  socket.emit('data', invalid);
  socket.emit('data', Buffer.alloc(10 * 1024 * 1024 + 1));
  socket.emit('data', packet(204, 'PlaybackPacket', { channelId: 2, payload: Buffer.from([9]) }));
  assert.equal(context.media.length, 2);
  assert.deepEqual(context.media[1].data, Buffer.from([9]));
});

test('NexusTalk ignores malformed protobuf and resumes at the next framed packet', async (t) => {
  let context = setup(t);
  let socket = await open(context);
  begin(socket);
  socket.emit('data', Buffer.from([204, 0, 1, 255]));
  socket.emit('data', packet(204, 'PlaybackPacket', { channelId: 2, payload: Buffer.from([5]) }));
  assert.equal(context.media.length, 1);
});

test('NexusTalk redirects only after socket close and ignores stale socket events', async (t) => {
  let context = setup(t);
  let socket = await open(context);
  socket.emit('data', packet(207, 'Redirect', { newHost: 'redirect.example' }));
  assert.equal(socket.destroyed, true);
  assert.equal(context.sockets.length, 1);
  socket.emit('close');
  assert.equal(context.sockets.length, 2);
  let replacement = context.sockets[1];
  assert.equal(replacement.settings.host, 'redirect.example');
  replacement.handshake();
  socket.emit('data', packet(207, 'Redirect', { newHost: 'stale.example' }));
  socket.emit('close');
  assert.equal(context.sockets.length, 2);
  assert.equal(replacement.destroyed, false);
});

test('NexusTalk camera-unreachable playback end does not reconnect', async (t) => {
  let context = setup(t);
  let socket = await open(context);
  begin(socket);
  socket.emit('data', packet(203, 'PlaybackEnd', { sessionId: 7, reason: 'ERROR_LEAF_NODE_CANNOT_REACH_CAMERA' }));
  socket.emit('close');
  assert.equal(context.transport.closed, true);
  assert.equal(context.sockets.length, 1);
  t.mock.timers.tick(30000);
  assert.equal(context.sockets.length, 1);
});

test('NexusTalk stalled playback requests one reconnect after the old socket closes', async (t) => {
  let context = setup(t);
  let socket = await open(context);
  begin(socket);
  t.mock.timers.tick(15000);
  assert.equal(socket.destroyed, true);
  assert.equal(context.sockets.length, 1);
  socket.emit('close');
  assert.equal(context.sockets.length, 2);
  context.sockets[1].handshake();
});

test('NexusTalk groups video by timestamp and flushes the final frame on close', async (t) => {
  let context = setup(t);
  let socket = await open(context);
  begin(socket);
  for (let payload of [Buffer.from([0x65, 1]), Buffer.from([0x65, 2])]) {
    socket.emit('data', packet(204, 'PlaybackPacket', { channelId: 1, timestampDelta: 0, payload }));
  }
  assert.equal(context.media.length, 0);
  socket.emit(
    'data',
    packet(204, 'PlaybackPacket', {
      channelId: 1,
      timestampDelta: 9000,
      payload: Buffer.from([0x41, 3]),
    }),
  );
  assert.equal(context.media.length, 1);
  assert.equal(context.media[0].timestamp, 100000);
  assert.equal(context.media[0].keyFrame, true);
  assert.deepEqual(context.media[0].data, Buffer.from([0, 0, 0, 1, 0x65, 1, 0, 0, 0, 1, 0x65, 2]));
  await context.transport.close();
  assert.equal(context.media.length, 2);
  assert.equal(context.media[1].timestamp, 100100);
  socket.emit('close');
  await context.transport.close();
  assert.equal(context.media.length, 2);
});

test('NexusTalk queues talkback until authorisation and preserves FIFO payloads', async (t) => {
  let context = setup(t);
  let socket = await open(context);
  socket.emit(
    'data',
    packet(202, 'PlaybackBegin', {
      sessionId: 7,
      channels: [{ channelId: 2, codec: 'AAC', sampleRate: 48000 }],
    }),
  );
  await context.transport.sendAudio(Buffer.from([1]));
  await context.transport.sendAudio(Buffer.from([2]));
  assert.equal(socket.writes.length, 2);
  socket.emit('data', packet(200));
  assert.deepEqual(
    socket.writes.filter((entry, index) => index % 2 === 0).map((entry) => entry[0]),
    [100, 102, 102, 103],
  );
  let type = root.lookupType('nest.nexustalk.v1.AudioPayload');
  assert.deepEqual(type.decode(socket.writes[3]).payload, Buffer.from([1]));
  assert.deepEqual(type.decode(socket.writes[5]).payload, Buffer.from([2]));
});

test('NexusTalk close during TLS setup prevents a late handshake from sending authentication', async (t) => {
  let context = setup(t);
  let opening = context.transport.open();
  let socket = context.sockets[0];
  await context.transport.close();
  socket.emit('close');
  socket.handshake();
  await opening;
  assert.equal(context.transport.closed, true);
  assert.deepEqual(socket.writes, []);
  assert.equal(context.sockets.length, 1);
});
