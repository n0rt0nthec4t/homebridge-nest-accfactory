// Exercise actual loopback RTSP negotiation and interleaved RTP/RTCP delivery.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
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
  const output = new RTPMuxer({ audio: { codec: 'pcm', profile: 's16le', sampleRate: 48000, channels: 2 } });
  const client = await connect(context, output);
  assert.equal(output.blocked('video'), true);
  assert.throws(() => output.writeVideo(Buffer.from([0x65, 1]), 0), /PLAY/);
  assert.equal((await client.request('OPTIONS', '*')).status, 200);
  const description = await client.request('DESCRIBE');
  assert.match(description.body, /H264\/90000/);
  assert.match(description.body, /L16\/48000\/2/);
  assert.equal((await client.request('PLAY')).status, 455);
  assert.equal((await play(client, output, true)).status, 200);
  assert.equal(output.blocked('video'), false);
  output.writeVideo(Buffer.from([0x65, 1]), 1000, { sps: Buffer.from([0x67, 0x42]), pps: Buffer.from([0x68, 1]) });
  output.writeAudio(Buffer.from([1, 0, 2, 0]), 1040);
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
  assert.deepEqual(client.packets.find((packet) => packet.channel === 6).data.subarray(12), Buffer.from([0, 1, 0, 2]));
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
