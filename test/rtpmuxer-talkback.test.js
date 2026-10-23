// Verify encrypted return-audio routing and socket ownership without camera hardware.
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import RTPMuxer from '../src/plugins/camera/rtpmuxer.js';

function setup(
  context,
  {
    delayed = false,
    bindError = undefined,
    closeError = undefined,
    allocationError = undefined,
    delayedAllocation = false,
    probePorts = [],
  } = {},
) {
  let sockets = [];
  let probes = [];
  let nextPort = 22000;
  context.mock.method(dgram, 'createSocket', () => {
    let socket = new EventEmitter();
    socket.bind = context.mock.fn((port, ready) => {
      socket.inbound = typeof port === 'number';
      socket.port = socket.inbound === true ? port : (probePorts.shift() ?? nextPort++);
      socket.address = () => ({ port: socket.port });
      socket.ready = ready;
      if (socket.inbound !== true) {
        probes.push(socket);
        if (allocationError !== undefined) {
          queueMicrotask(() => socket.emit('error', allocationError));
        } else if (delayedAllocation !== true) {
          ready();
        }
        return;
      }
      sockets.push(socket);
      socket.ready = ready;
      if (bindError !== undefined) {
        queueMicrotask(() => socket.emit('error', bindError));
      } else if (delayed !== true) {
        ready();
      }
    });
    socket.send = context.mock.fn();
    socket.close = context.mock.fn((done) => {
      if (closeError !== undefined && socket.inbound === true) {
        throw closeError;
      }
      done();
    });
    return socket;
  });
  let talkback = { port: 12001, payloadType: 110 };
  let create = (options = {}) => new RTPMuxer({ talkback, ...options, writePacket: () => true });
  return { sockets, talkback, create, probes };
}

test('talkback preserves encrypted bytes, marker-bit routing and control forwarding', async (context) => {
  let { sockets, create, talkback } = setup(context);
  let muxer = create();
  context.after(() => muxer.close());
  await muxer.prepare();
  let socket = sockets[0];
  assert.equal(socket.bind.mock.calls[0].arguments[0], talkback.port);
  for (let packet of [null, {}, Buffer.alloc(0), Buffer.from([0x80])]) {
    socket.emit('message', packet);
  }
  socket.emit('message', Buffer.from([0, 110]));
  assert.equal(socket.send.mock.callCount(), 0);
  for (let type of [110, 110 | 0x80, 200, 201, 50]) {
    let packet = Buffer.from([0x80, type, 1, 2, 3]);
    let before = socket.send.mock.callCount();
    socket.emit('message', packet);
    let destinations = socket.send.mock.calls.slice(before).map((call) => {
      assert.equal(call.arguments[0], packet);
      assert.equal(call.arguments[2], '127.0.0.1');
      return call.arguments[1];
    });
    assert.deepEqual(
      destinations,
      type === 110 || type === (110 | 0x80) ? [muxer.ports.talkback] : [muxer.ports.audioControl, muxer.ports.talkback],
    );
  }
  await muxer.close();
  assert.equal(socket.listenerCount('message'), 0);
  assert.equal(socket.close.mock.callCount(), 1);
  await muxer.close();
  assert.equal(socket.close.mock.callCount(), 1);
});

test('stopping during talkback bind waits for readiness and retires only its own socket', async (context) => {
  let { sockets, create } = setup(context, { delayed: true });
  let old = create();
  let replacement = create();
  let starting = old.prepare();
  let stopping = old.close();
  let stopped = false;
  stopping.then(() => {
    stopped = true;
  });
  await setImmediate();
  assert.equal(stopped, false);
  let nextStart = replacement.prepare();
  sockets[1].ready();
  await nextStart;
  sockets[0].ready();
  await starting;
  await stopping;
  assert.equal(sockets[0].close.mock.callCount(), 1);
  assert.equal(sockets[1].close.mock.callCount(), 0);
  assert.equal(replacement.closed, false);
  await replacement.close();
});

test('talkback bind failure rejects preparation and releases the failed socket', async (context) => {
  let failure = Object.assign(new Error('Port occupied'), { code: 'EADDRINUSE' });
  let { sockets, create } = setup(context, {
    bindError: failure,
    closeError: Object.assign(new Error('Not running'), { code: 'ERR_SOCKET_DGRAM_NOT_RUNNING' }),
  });
  let muxer = create();
  await assert.rejects(muxer.prepare(), (error) => error === failure);
  await muxer.close();
  assert.equal(muxer.error, failure);
  assert.equal(muxer.closed, true);
  assert.equal(sockets[0].close.mock.callCount(), 1);
});

test('runtime UDP errors retire that output without closing another output', async (context) => {
  let { sockets, create } = setup(context);
  let first = create();
  let second = create();
  await first.prepare();
  await second.prepare();
  let failure = new Error('UDP failure');
  sockets[0].emit('error', failure);
  await first.close();
  assert.equal(first.error, failure);
  assert.equal(second.closed, false);
  assert.equal(sockets[1].close.mock.callCount(), 0);
  await second.close();
});

for (let type of [200, 201]) {
  test('RTCP type ' + type + ' takes priority over its masked RTP payload type', async (context) => {
    let { sockets, create, talkback } = setup(context);
    talkback.payloadType = type & 0x7f;
    let muxer = create();
    await muxer.prepare();
    sockets[0].emit('message', Buffer.from([0x80, type]));
    assert.deepEqual(
      sockets[0].send.mock.calls.map((call) => call.arguments[1]),
      [muxer.ports.audioControl, muxer.ports.talkback],
    );
    await muxer.close();
  });
}

test('unexpected socket close errors remain visible', async (context) => {
  let { create } = setup(context, { closeError: new Error('Unexpected close failure') });
  let muxer = create();
  await muxer.prepare();
  await assert.rejects(muxer.close(), /Unexpected close failure/);
});

test('internal audio ports are allocated only as needed and probes close before FFmpeg starts', async (context) => {
  let { create, probes, sockets } = setup(context);
  let record = create({ talkback: undefined });
  await record.prepare();
  assert.equal(probes.length, 0);
  assert.equal(sockets.length, 0);
  assert.deepEqual(record.ports, { audioControl: undefined, talkback: undefined });
  let live = create({ talkback: undefined, audioControl: true });
  await live.prepare();
  assert.equal(probes.length, 1);
  assert.equal(sockets.length, 0);
  assert.equal(typeof live.ports.audioControl, 'number');
  assert.equal(live.ports.talkback, undefined);
  let duplex = create();
  await duplex.prepare();
  assert.equal(probes.length, 3);
  assert.equal(sockets.length, 1);
  assert.equal(new Set([live.ports.audioControl, duplex.ports.audioControl, duplex.ports.talkback]).size, 3);
  assert.equal(Object.isFrozen(duplex.ports), true);
  for (let probe of probes) {
    assert.equal(probe.close.mock.callCount(), 1);
  }
  await Promise.all([record.close(), live.close(), duplex.close()]);
});

test('concurrent output reservations reject duplicate selections and become reusable after close', async (context) => {
  let { create } = setup(context, { probePorts: [23000, 23001, 23000, 23002, 23003, 23000, 23004] });
  let first = create();
  let second = create();
  await first.prepare();
  await second.prepare();
  assert.deepEqual(first.ports, { audioControl: 23000, talkback: 23001 });
  assert.deepEqual(second.ports, { audioControl: 23002, talkback: 23003 });
  await first.close();
  let replacement = create();
  await replacement.prepare();
  assert.equal(replacement.ports.audioControl, 23000);
  await Promise.all([second.close(), replacement.close()]);
});

test('cancellation during an internal port probe closes the probe and skips further allocation', async (context) => {
  let { create, probes, sockets } = setup(context, { delayedAllocation: true });
  let muxer = create();
  let starting = muxer.prepare();
  await setImmediate();
  assert.equal(probes.length, 1);
  sockets[0].emit('message', Buffer.from([0x80, 110]));
  assert.equal(sockets[0].send.mock.callCount(), 0);
  let stopping = muxer.close();
  probes[0].ready();
  await starting;
  await stopping;
  assert.equal(probes.length, 1);
  assert.equal(probes[0].close.mock.callCount(), 1);
  assert.equal(sockets[0].close.mock.callCount(), 1);
});

test('internal port allocation failure rejects startup and closes its owned splitter', async (context) => {
  let failure = new Error('Allocation failed');
  let { create, sockets, probes } = setup(context, { allocationError: failure });
  let muxer = create();
  await assert.rejects(muxer.prepare(), (error) => error === failure);
  await muxer.close();
  assert.equal(muxer.error, failure);
  assert.equal(sockets[0].close.mock.callCount(), 1);
  assert.equal(probes[0].close.mock.callCount(), 1);
});
