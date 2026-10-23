// Exercise actual loopback RTSP negotiation and interleaved RTP/RTCP delivery.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import dgram from 'node:dgram';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import timers from 'node:timers';
import RTPMuxer from '../src/plugins/camera/rtpmuxer.js';
import { importSource } from './helpers/import-source.js';
let { default: Streamer } = await importSource(new URL('../src/plugins/camera/streamer.js', import.meta.url));
import StreamTransport from '../src/plugins/camera/streamtransport.js';

async function connect(context, output) {
  await output.prepare();
  const url = new URL(output.input.url);
  const socket = net.connect({ host: url.hostname, port: Number(url.port) });
  const packets = [];
  const pending = new Map();
  let buffer = Buffer.alloc(0);
  let sequence = 0;
  socket.on('data', (data) => {
    buffer = buffer.length === 0 ? data : Buffer.concat([buffer, data]);
    while (buffer.length > 0) {
      if (buffer[0] === 0x24) {
        if (buffer.length < 4 || buffer.length < 4 + buffer.readUInt16BE(2)) {
          return;
        }
        const length = buffer.readUInt16BE(2);
        packets.push({ channel: buffer[1], data: Buffer.from(buffer.subarray(4, 4 + length)) });
        buffer = buffer.subarray(4 + length);
        continue;
      }
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) {
        return;
      }
      const lines = buffer.subarray(0, end).toString().split('\r\n');
      const status = Number(lines.shift().split(' ')[1]);
      const headers = new Map(
        lines.map((line) => {
          const colon = line.indexOf(':');
          return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
        }),
      );
      const length = Number(headers.get('content-length'));
      if (buffer.length < end + 4 + length) {
        return;
      }
      const body = buffer.subarray(end + 4, end + 4 + length).toString();
      buffer = buffer.subarray(end + 4 + length);
      pending.get(headers.get('cseq'))?.({ status, headers, body });
      pending.delete(headers.get('cseq'));
    }
  });
  await once(socket, 'connect');
  context.after(async () => {
    socket.destroy();
    await output.close();
  });
  return {
    socket,
    packets,
    request(method, path = output.input.url, headers = []) {
      const cseq = String(++sequence);
      const response = new Promise((resolve) => pending.set(cseq, resolve));
      socket.write([method + ' ' + path + ' RTSP/1.0', 'CSeq: ' + cseq, ...headers, '', ''].join('\r\n'));
      return response;
    },
  };
}

async function play(client, output, audio = false) {
  assert.equal(
    (await client.request('SETUP', output.input.url + '/trackID=0', ['Transport: RTP/AVP/TCP;unicast;interleaved=4-5'])).status,
    200,
  );
  if (audio === true) {
    assert.equal(
      (await client.request('SETUP', output.input.url + '/trackID=1', ['Transport: RTP/AVP/TCP;unicast;interleaved=6-7'])).status,
      200,
    );
  }
  return client.request('PLAY');
}

async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (predicate() !== true) {
    assert.equal(Date.now() < deadline, true, 'loopback delivery did not make progress');
    await delay(5);
  }
}

test('SDP describes actual audio, and PLAY gates RTP delivery on the owned listener', { timeout: 5000 }, async (context) => {
  const output = new RTPMuxer({ audio: { codec: 'opus', sampleRate: 48000, channels: 2 } });
  const client = await connect(context, output);
  assert.equal(output.blocked('video'), true);
  assert.throws(() => output.writeVideo(Buffer.from([0x65, 1]), 0), /PLAY/);
  assert.equal((await client.request('OPTIONS', '*')).status, 200);
  const description = await client.request('DESCRIBE');
  assert.match(description.body, /H264\/90000/);
  assert.match(description.body, /opus\/48000\/2/);
  assert.equal((await client.request('PLAY')).status, 455);
  assert.equal((await play(client, output, true)).status, 200);
  assert.equal(output.blocked('video'), false);
  output.writeVideo(Buffer.from([0x65, 1]), 1000, { sps: Buffer.from([0x67, 0x42]), pps: Buffer.from([0x68, 1]) });
  output.writeAudio(Buffer.from([0xf8, 0xff, 0xfe]), 1040);
  output.tick();
  await waitFor(() => client.packets.length === 6);
  assert.deepEqual(
    client.packets.map((packet) => packet.channel),
    [5, 7, 4, 4, 4, 6],
  );
  assert.deepEqual(
    client.packets.filter((packet) => packet.channel === 4).map(({ data }) => data[12] & 31),
    [7, 8, 5],
  );
  assert.deepEqual(client.packets.find((packet) => packet.channel === 6).data.subarray(12), Buffer.from([0xf8, 0xff, 0xfe]));
  const session = (await client.request('GET_PARAMETER')).headers.get('session');
  assert.equal((await client.request('GET_PARAMETER', output.input.url, ['Session: ' + session])).status, 200);
});

test('independent outputs bind distinct ports and reject foreign paths, sessions and transports', { timeout: 5000 }, async (context) => {
  const first = new RTPMuxer();
  const second = new RTPMuxer();
  const client = await connect(context, first);
  await second.prepare();
  context.after(() => second.close());
  assert.notEqual(new URL(first.input.url).port, new URL(second.input.url).port);
  assert.equal((await client.request('OPTIONS')).status, 200);
  assert.equal((await client.request('DESCRIBE', first.input.url + '-wrong')).status, 404);
  assert.equal((await client.request('PLAY', first.input.url, ['Session: stale'])).status, 454);
  assert.equal(
    (await client.request('SETUP', first.input.url + '/trackID=0', ['Transport: RTP/AVP;unicast;client_port=10000-10001'])).status,
    461,
  );
  assert.equal((await client.request('SETUP', first.input.url + '/trackID=0', ['Transport: RTP/AVP/TCP;interleaved=256-257'])).status, 461);
  assert.equal((await play(client, first)).status, 200);
});

test('close during pending listen leaves no bound endpoint and is idempotent', { timeout: 5000 }, async () => {
  const output = new RTPMuxer();
  const preparing = output.prepare();
  const closing = output.close();
  assert.equal(output.close(), closing);
  await preparing;
  await closing;
  assert.equal(output.blocked('video'), true);
  await assert.rejects(output.prepare(), /closed/);
  const url = new URL(output.input.url);
  const probe = net.connect({ host: url.hostname, port: Number(url.port) });
  const [error] = await once(probe, 'error');
  assert.equal(error.code, 'ECONNREFUSED');
});

test('large access units are bounded before delivery, and a slow receiver drains safely', { timeout: 5000 }, async (context) => {
  const output = new RTPMuxer();
  const client = await connect(context, output);
  await play(client, output);
  assert.throws(() => output.writeVideo(Buffer.alloc(4 * 1024 * 1024 + 1, 0x65), 0), /pending-delivery limit/);
  assert.equal(client.packets.length, 0);
  client.socket.pause();
  const frame = Buffer.alloc(4 * 1024 * 1024 - 1, 0x33);
  frame[0] = 0x65;
  output.writeVideo(frame, 0);
  assert.equal(output.queuedBytes() <= 8 * 1024 * 1024, true);
  if (output.blocked('video') === true) {
    const queued = output.queuedBytes();
    assert.throws(() => output.writeVideo(Buffer.from([0x61, 1]), 100), /drain/);
    assert.equal(output.queuedBytes(), queued);
  }
  client.socket.resume();
  await waitFor(() => output.blocked('video') === false);
});

test('malformed oversized control input closes the endpoint with an actionable failure', { timeout: 5000 }, async (context) => {
  const output = new RTPMuxer();
  const client = await connect(context, output);
  assert.equal((await client.request('OPTIONS')).status, 200);
  client.socket.on('error', (error) => assert.equal(error.code, 'ECONNRESET'));
  const closed = new Promise((resolve) => client.socket.once('close', resolve));
  client.socket.write(Buffer.alloc(200 * 1024, 0x41));
  await closed;
  assert.equal(output.blocked('video'), true);
  assert.throws(() => output.tick(), /control buffer/);
});

for (const reset of [false, true]) {
  test('closing the second RTP viewer preserves the first viewer and shared source: reset=' + reset, { timeout: 8000 }, async (context) => {
    let opens = 0;
    let closes = 0;
    class Transport extends StreamTransport {
      async open() {
        opens++;
        this.setState(StreamTransport.STATE.READY);
      }

      async close() {
        closes++;
        this.setState(StreamTransport.STATE.CLOSED);
      }

      async shutdown() {}
    }
    const transport = new Transport();
    transport.video.codec = 'h264';
    const backends = new Map();
    let prepared = [];
    let prepare = RTPMuxer.prototype.prepare;
    context.mock.method(RTPMuxer.prototype, 'prepare', function () {
      if (prepared.includes(this) !== true) {
        prepared.push(this);
      }
      return prepare.call(this);
    });
    const failures = [];
    const streamer = new Streamer(
      'concurrent-rtsp-' + reset,
      { online: true, streaming_enabled: true, audio_enabled: false, nest_google_device_uuid: 'camera' },
      {
        transport,
        log: { debug() {}, info() {}, success() {}, warn: (...args) => failures.push(args), error: (...args) => failures.push(args) },
      },
    );
    context.after(() => streamer.stopEverything());
    for (const sessionID of ['first', 'second']) {
      await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID });
      backends.set(sessionID, prepared.at(-1));
    }
    const first = await connect(context, backends.get('first'));
    const second = await connect(context, backends.get('second'));
    await play(first, backends.get('first'));
    await play(second, backends.get('second'));
    const started = Date.now();
    transport.emitMedia({
      type: 'video',
      codec: 'h264',
      timestamp: started,
      data: Buffer.from([0, 0, 0, 1, 0x65, 1]),
      keyFrame: true,
      codecConfig: { sps: Buffer.from([0x67, 0x42]), pps: Buffer.from([0x68, 1]) },
    });
    await waitFor(() => first.packets.some((packet) => packet.channel === 4) && second.packets.some((packet) => packet.channel === 4));
    // Model FFmpeg being killed before HomeKit's STOP message reaches Streamer.
    // Waiting many scheduler ticks reproduces the original device-wide failure.
    if (reset === true) {
      second.socket.resetAndDestroy();
    } else {
      second.socket.destroy();
    }
    await waitFor(() => backends.get('second').closed === true);
    await delay(200);
    assert.equal(streamer.isLiveStreaming(), true);
    assert.equal(backends.get('first').closed, false);
    assert.equal(closes, 0);
    assert.deepEqual(failures, []);
    const before = first.packets.filter((packet) => packet.channel === 4).length;
    transport.emitMedia({ type: 'video', codec: 'h264', timestamp: Date.now(), data: Buffer.from([0, 0, 0, 1, 0x61, 2]) });
    await waitFor(() => first.packets.filter((packet) => packet.channel === 4).length > before);
    await streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_LIVE, { sessionID: 'second' });
    assert.equal(streamer.isLiveStreaming(), true);
    assert.equal(opens, 1);
    assert.equal(closes, 0);
    await streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_LIVE, { sessionID: 'first' });
    assert.equal(streamer.isLiveStreaming(), false);
    assert.equal(closes, 1);
  });
}

test('NexusTalk DESCRIBE waits for ADTS metadata and advertises the actual AAC track', { timeout: 5000 }, async (context) => {
  let expiry = undefined;
  let schedule = timers.setTimeout;
  context.mock.method(timers, 'setTimeout', (callback, milliseconds, ...args) => {
    if (milliseconds === 5000) {
      expiry = callback;
    }
    return schedule(callback, milliseconds, ...args);
  });
  let { adts } = await import('./helpers/aac-fixtures.js');
  let output = new RTPMuxer({ audio: { codec: 'aac' } });
  let client = await connect(context, output);
  let described = false;
  let pending = client.request('DESCRIBE').then((response) => {
    described = true;
    return response;
  });
  await delay(20);
  assert.equal(described, false);
  // A validated resource request owns the receiver even while SDP is deferred.
  expiry();
  assert.equal(output.closed, false);
  assert.equal((await client.request('DESCRIBE')).status, 455);
  assert.equal((await client.request('PLAY')).status, 455);
  output.configureAudio(adts(Buffer.from([0x21, 0x10]), { frequency: 4, channels: 2 }));
  let response = await pending;
  assert.equal(response.status, 200);
  assert.match(response.body, /MPEG4-GENERIC\/44100\/2/);
  assert.match(response.body, /config=1210/);
  assert.equal((await play(client, output, true)).status, 200);
  assert.equal(output.blocked('video'), false);
});

test('closing an output while AAC configuration is pending releases the receiver and listener', { timeout: 5000 }, async (context) => {
  let output = new RTPMuxer({ audio: { codec: 'aac' } });
  let client = await connect(context, output);
  client.request('DESCRIBE');
  await delay(10);
  let ended = once(client.socket, 'close');
  await output.close();
  await ended;
  assert.equal(output.closed, true);
  assert.equal(output.needsAudioConfig, false);
});

test('fragmented H264 uses one wire allocation per packet and preserves RTCP counters', { timeout: 5000 }, async (context) => {
  let now = 1700000000000;
  let output = new RTPMuxer({ includeAudio: false, maxPacketBytes: 64, unixNow: () => now });
  let client = await connect(context, output);
  await play(client, output);
  output.writeVideo(Buffer.from([0x65, 1]), 0);
  await waitFor(() => client.packets.length === 2);
  client.packets.length = 0;

  let nal = Buffer.alloc(205, 0x33);
  nal[0] = 0x65;
  // Observe synchronous packet construction only, excluding socket/test setup.
  let allocations = context.mock.method(Buffer, 'allocUnsafe');
  let copies = context.mock.method(Buffer.prototype, 'copy');
  output.writeVideo(nal, 100);
  let copyCount = copies.mock.callCount();
  copies.mock.restore();
  let sizes = allocations.mock.calls.map((call) => call.arguments[0]);
  allocations.mock.restore();
  assert.deepEqual(sizes, [68, 68, 68, 68, 22], 'one final RTSP/RTP buffer per FU-A fragment');
  assert.equal(copyCount, 5, 'one payload copy directly into each final wire packet');

  await waitFor(() => client.packets.length === 5);
  let packets = client.packets.map((packet) => packet.data);
  assert.equal(
    client.packets.every((packet) => packet.channel === 4),
    true,
  );
  assert.deepEqual(
    packets.map((packet) => (packet[1] & 0x80) !== 0),
    [false, false, false, false, true],
  );
  assert.equal(packets[0][13] & 0x80, 0x80);
  assert.equal(packets.at(-1)[13] & 0x40, 0x40);
  assert.deepEqual(
    Buffer.concat([Buffer.from([(packets[0][12] & 0xe0) | (packets[0][13] & 31)]), ...packets.map((packet) => packet.subarray(14))]),
    nal,
  );
  for (let index = 1; index < packets.length; index++) {
    assert.equal(packets[index].readUInt16BE(2), (packets[index - 1].readUInt16BE(2) + 1) & 0xffff);
    assert.equal(packets[index].readUInt32BE(4), packets[0].readUInt32BE(4));
    assert.equal(packets[index].readUInt32BE(8), packets[0].readUInt32BE(8));
  }

  now += 1000;
  output.tick(now);
  await waitFor(() => client.packets.length === 6);
  let report = client.packets.at(-1);
  assert.equal(report.channel, 5);
  assert.equal(report.data[1], 200);
  assert.equal(report.data.readUInt32BE(20), 6);
  assert.equal(report.data.readUInt32BE(24), 216, 'octets include FU-A headers, excluding RTP and RTSP framing');
});

for (let request of [
  'DESCRIBE * RTSP/1.0\r\nCSeq: 1\r\n\r\n',
  'GET_PARAMETER * RTSP/1.0\r\nCSeq: 1\r\n\r\n',
  'PLAY * RTSP/1.0\r\nCSeq: 1\r\n\r\n',
  'TEARDOWN * RTSP/1.0\r\nCSeq: 1\r\n\r\n',
  'DESCRIBE rtsp://127.0.0.1/unknown RTSP/1.0\r\nCSeq: 1\r\n\r\n',
  'malformed request\r\n\r\n',
  Buffer.alloc(200 * 1024, 0x41),
  Buffer.from([0x24, 0, 0, 0]),
]) {
  test(
    'unvalidated RTSP client cannot disclose or retire an output: ' +
      (typeof request === 'string' ? request.split(' ')[0] : request.length),
    { timeout: 5000 },
    async (context) => {
      let output = new RTPMuxer({ includeAudio: false });
      let rejected = await connect(context, output);
      let received = [];
      rejected.socket.on('data', (data) => received.push(data));
      rejected.socket.on('error', (error) => assert.equal(error.code, 'ECONNRESET'));
      let closed = new Promise((resolve) => rejected.socket.once('close', resolve));
      rejected.socket.write(request);
      await closed;
      assert.equal(received.length, 0, 'no SDP, resource URL or session is disclosed');
      assert.equal(output.closed, false);
      assert.equal(output.error, undefined);

      let receiver = await connect(context, output);
      assert.equal((await play(receiver, output)).status, 200);
      output.writeVideo(Buffer.from([0x65, 1]), 0);
      await waitFor(() => receiver.packets.some((packet) => packet.channel === 4));
    },
  );
}

test('OPTIONS discovery cannot reserve ownership or disclose the resource', { timeout: 5000 }, async (context) => {
  let output = new RTPMuxer({ includeAudio: false });
  let candidate = await connect(context, output);
  let response = await candidate.request('OPTIONS', '*');
  assert.equal(response.status, 200);
  assert.equal(response.headers.has('session'), false);
  assert.equal(response.headers.has('content-base'), false);
  assert.equal(response.body, '');
  let closed = new Promise((resolve) => candidate.socket.once('close', resolve));
  let receiver = await connect(context, output);
  assert.equal((await play(receiver, output)).status, 200);
  await closed;
  response = await receiver.request('DESCRIBE', '*');
  assert.equal(response.status, 404);
  assert.equal(response.body, '');
  assert.equal(response.headers.has('session'), false);
  output.writeVideo(Buffer.from([0x65, 1]), 0);
  await waitFor(() => receiver.packets.some((packet) => packet.channel === 4));
});

test('receiver admission has an absolute deadline and stale expiry cannot close its replacement', { timeout: 5000 }, async (context) => {
  let deadlines = [];
  let schedule = timers.setTimeout;
  context.mock.method(timers, 'setTimeout', (callback, milliseconds, ...args) => {
    if (milliseconds === 5000) {
      deadlines.push(callback);
    }
    return schedule(callback, milliseconds, ...args);
  });
  let output = new RTPMuxer({ includeAudio: false });
  let candidate = await connect(context, output);
  await candidate.request('OPTIONS', '*');
  await candidate.request('OPTIONS', '*');
  assert.equal(deadlines.length, 1, 'traffic must not renew admission time');
  let closed = new Promise((resolve) => candidate.socket.once('close', resolve));
  deadlines[0]();
  await closed;
  assert.equal(output.closed, false);
  assert.equal(output.error, undefined);
  let receiver = await connect(context, output);
  assert.equal((await play(receiver, output)).status, 200);
  deadlines[0]();
  output.writeVideo(Buffer.from([0x65, 1]), 0);
  await waitFor(() => receiver.packets.some((packet) => packet.channel === 4));
});

test('pending receivers stay bounded and admission closes the remaining candidates', { timeout: 5000 }, async (context) => {
  let output = new RTPMuxer({ includeAudio: false });
  let candidates = [];
  for (let index = 0; index < 4; index++) {
    candidates.push(await connect(context, output));
  }
  let excess = await connect(context, output);
  excess.socket.on('error', (error) => assert.equal(error.code, 'ECONNRESET'));
  await new Promise((resolve) => excess.socket.once('close', resolve));
  assert.equal(output.closed, false);
  let rejected = candidates.slice(1).map((candidate) => new Promise((resolve) => candidate.socket.once('close', resolve)));
  assert.equal((await play(candidates[0], output)).status, 200);
  await Promise.all(rejected);
  output.writeVideo(Buffer.from([0x65, 1]), 0);
  await waitFor(() => candidates[0].packets.some((packet) => packet.channel === 4));
});

test('talkback UDP bind failure also closes the prepared RTSP listener', { timeout: 5000 }, async (context) => {
  let occupied = dgram.createSocket('udp4');
  occupied.bind(0);
  await once(occupied, 'listening');
  context.after(() => new Promise((resolve) => occupied.close(resolve)));
  let muxer = new RTPMuxer({
    talkback: { port: occupied.address().port, payloadType: 110 },
  });
  context.after(() => muxer.close());
  await assert.rejects(muxer.prepare(), { code: 'EADDRINUSE' });
  let url = new URL(muxer.input.url);
  await muxer.close();
  let client = net.connect({ host: url.hostname, port: Number(url.port) });
  context.after(() => client.destroy());
  await assert.rejects(once(client, 'connect'), { code: 'ECONNREFUSED' });
});

test('muxer-selected FFmpeg ports accept real UDP audio and control forwarding', { timeout: 5000 }, async (context) => {
  let probe = dgram.createSocket('udp4');
  probe.bind(0);
  await once(probe, 'listening');
  let port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  let muxer = new RTPMuxer({ talkback: { port, payloadType: 110 } });
  context.after(() => muxer.close());
  await muxer.prepare();
  assert.equal(new Set([port, muxer.ports.audioControl, muxer.ports.talkback]).size, 3);
  let control = dgram.createSocket('udp4');
  let talk = dgram.createSocket('udp4');
  let sender = dgram.createSocket('udp4');
  context.after(() => {
    control.close();
    talk.close();
    sender.close();
  });
  control.bind(muxer.ports.audioControl);
  talk.bind(muxer.ports.talkback);
  await Promise.all([once(control, 'listening'), once(talk, 'listening')]);
  let audio = Buffer.from([0x80, 110 | 0x80, 1, 2, 3]);
  let receivedAudio = once(talk, 'message');
  sender.send(audio, port, '127.0.0.1');
  assert.deepEqual((await receivedAudio)[0], audio);
  let report = Buffer.from([0x80, 200, 0, 1]);
  let reports = Promise.all([once(control, 'message'), once(talk, 'message')]);
  sender.send(report, port, '127.0.0.1');
  for (let received of await reports) {
    assert.deepEqual(received[0], report);
  }
});
