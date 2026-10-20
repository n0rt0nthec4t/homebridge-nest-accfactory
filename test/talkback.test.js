// Verify encrypted HomeKit return-audio routing and exact socket ownership without network I/O.
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import Talkback from '../src/plugins/camera/talkback.js';

function setup(context, options = {}) {
  const sockets = [];
  const errors = [];
  const debug = [];
  context.mock.method(dgram, 'createSocket', (family) => {
    assert.equal(family, 'udp4');
    const socket = new EventEmitter();
    socket.bind = context.mock.fn();
    socket.send = context.mock.fn();
    socket.close = context.mock.fn();
    sockets.push(socket);
    return socket;
  });
  const settings = {
    port: 10000,
    audioPort: 10001,
    talkbackPort: 10002,
    payloadType: 110,
    description: 'Camera',
    log: { error: (...args) => errors.push(args), debug: (...args) => debug.push(args) },
    ...options,
  };
  const router = new Talkback(settings);
  context.after(() => router.close());
  return { router, socket: sockets[0], sockets, settings, errors, debug };
}

test('talkback forwards marked and unmarked RTP unchanged only to its FFmpeg receiver', (context) => {
  const { socket } = setup(context);
  assert.deepEqual(socket.bind.mock.calls[0].arguments, [10000]);
  for (const type of [110, 110 | 0x80]) {
    const packet = Buffer.from([0x80, type, 1, 2]);
    socket.emit('message', packet);
    const call = socket.send.mock.calls.at(-1);
    assert.equal(call.arguments[0], packet);
    assert.equal(call.arguments[1], 10002);
  }
  assert.equal(socket.send.mock.callCount(), 2);
});

for (const type of [200, 201]) {
  test('RTCP report ' + type + ' reaches both local receivers even when masked type matches RTP', (context) => {
    const { socket } = setup(context, { payloadType: type & 0x7f });
    const packet = Buffer.from([0x80, type, 0, 1]);
    socket.emit('message', packet);
    assert.deepEqual(
      socket.send.mock.calls.map((call) => call.arguments),
      [
        [packet, 10001],
        [packet, 10002],
      ],
    );
  });
}

test('malformed packets are ignored while unknown control traffic keeps its existing routes', (context) => {
  const { socket, debug } = setup(context);
  for (const packet of [null, {}, Buffer.alloc(0), Buffer.from([0x80]), Buffer.from([0, 110])]) {
    socket.emit('message', packet);
  }
  assert.equal(socket.send.mock.callCount(), 0);
  assert.equal(debug.length, 1);
  for (const type of [202, 47]) {
    const packet = Buffer.from([0x80, type, 0, 1]);
    socket.emit('message', packet);
    assert.deepEqual(
      socket.send.mock.calls.slice(-2).map((call) => call.arguments),
      [
        [packet, 10001],
        [packet, 10002],
      ],
    );
  }
  assert.equal(debug.length, 3);
});

for (const error of [new Error('bind failed'), 'socket failure']) {
  test('talkback socket errors close only their owner: ' + String(error), (context) => {
    const { router, socket, sockets, settings, errors } = setup(context);
    const replacement = new Talkback(settings);
    context.after(() => replacement.close());
    socket.close = context.mock.fn(() => {
      throw Object.assign(new Error('not bound'), { code: 'ERR_SOCKET_DGRAM_NOT_RUNNING' });
    });
    socket.emit('error', error);
    assert.equal(errors.length, 1);
    assert.equal(socket.listenerCount('message'), 0);
    assert.equal(socket.listenerCount('error'), 0);
    router.close();
    assert.equal(socket.close.mock.callCount(), 1);
    assert.equal(sockets[1].close.mock.callCount(), 0);
    socket.emit('message', Buffer.from([0x80, 110]));
    assert.equal(socket.send.mock.callCount(), 0);
    sockets[1].emit('message', Buffer.from([0x80, 110]));
    assert.equal(sockets[1].send.mock.callCount(), 1);
  });
}

test('unexpected socket close errors remain visible', (context) => {
  const { router, socket } = setup(context, { log: undefined });
  socket.emit('message', Buffer.from([0, 110]));
  socket.emit('message', Buffer.from([0x80, 47]));
  socket.close = context.mock.fn(() => {
    throw new Error('unexpected close failure');
  });
  assert.throws(() => router.close(), /unexpected close failure/);
});
