// Drive the real NexusTalk parser/lifecycle with protobuf packets and a fake TLS socket.
import assert from 'node:assert/strict';
import { importSource } from './helpers/import-source.js';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import tls from 'node:tls';
import { fileURLToPath, URL } from 'node:url';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { getProtoRoot, getProtoType } from '../src/protobuf.js';

// Streamer is used only for media type constants here; avoid its Homebridge imports.
let location = new URL('../src/plugins/camera/nexustalk.js', import.meta.url);
let source = await readFile(location, 'utf8');
// Schema loading can fail independently of TLS; keep real protobuf encoding for available types.
let schemaModule =
  'data:text/javascript,' +
  encodeURIComponent(
    'import { getProtoType as load } from ' +
      JSON.stringify(new URL('../src/protobuf.js', import.meta.url).href) +
      '; export const schema = { load }; export function getProtoType(...args) { return schema.load(...args); }',
  );
let { schema } = await import(schemaModule);
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
      : specifier === '../../protobuf.js'
        ? schemaModule
        : specifier === 'node:timers'
          ? timerModule
          : specifier.startsWith('.') === true
            ? new URL(specifier, location).href
            : specifier;
  return 'from ' + JSON.stringify(target);
});
let { default: NexusTalk } = await importSource(location, source);
let root = getProtoRoot(fileURLToPath(new URL('../src/protobuf/nest/nexustalk.proto', import.meta.url)));

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

for (let [code, reconnect] of [
  ['ERROR_AUTHORIZATION_FAILED', true],
  ['ERROR_INTERNAL', false],
]) {
  test('NexusTalk handles ' + code + ' with explicit reconnect ownership', async (context) => {
    let flow = setup(context);
    let socket = await open(flow);
    begin(socket);
    socket.emit('data', packet(201, 'Error', { code, message: 'Fixture error' }));
    assert.equal(socket.destroyed, reconnect);
    if (reconnect === true) {
      socket.emit('close');
      assert.equal(flow.sockets.length, 2);
      flow.sockets[1].handshake();
    }
  });
}
for (let id of [201, 202, 203, 207]) {
  test('NexusTalk malformed control payload ' + id + ' does not prevent the next valid media packet', async (context) => {
    let flow = setup(context);
    let socket = await open(flow);
    begin(socket);
    socket.emit('data', Buffer.from([id, 0, 1, 255]));
    socket.emit('data', packet(204, 'PlaybackPacket', { channelId: 2, payload: Buffer.from([8]) }));
    assert.equal(flow.media.length, 1);
    assert.deepEqual(flow.media[0].data, Buffer.from([8]));
  });
}
for (let [codec, profile, expected] of [
  ['H264', 'VIDEO_H264_2MBIT_L40', 2000000],
  ['H264', 'VIDEO_H264_530KBIT_L31', 530000],
  ['H264', 'VIDEO_H264_100KBIT_L30', 100000],
  ['AAC', 'AUDIO_AAC', undefined],
]) {
  test('NexusTalk accepts a single ' + codec + ' channel with ' + profile + ' metadata', async (context) => {
    let flow = setup(context);
    let socket = await open(flow);
    socket.emit(
      'data',
      packet(202, 'PlaybackBegin', {
        sessionId: 1,
        channels: [{ channelId: 1, codec, profile, sampleRate: codec === 'H264' ? 90000 : 48000 }],
      }),
    );
    assert.equal(socket.destroyed, false);
    if (codec === 'H264') {
      assert.equal(flow.transport.video.bitrate, expected);
    } else {
      assert.equal(flow.transport.audio.sampleRate, 48000);
    }
  });
}
test('NexusTalk playback without usable channels closes cleanly', async (context) => {
  let flow = setup(context);
  let socket = await open(flow);
  socket.emit('data', packet(202, 'PlaybackBegin', { sessionId: 1, channels: [] }));
  assert.equal(socket.destroyed, true);
  socket.emit('close');
  assert.equal(flow.transport.closed, true);
});
test('NexusTalk bounded outbound queue retains only the most recent talkback messages', async (context) => {
  let flow = setup(context);
  let socket = await open(flow);
  socket.emit('data', packet(202, 'PlaybackBegin', { sessionId: 7, channels: [{ channelId: 2, codec: 'AAC' }] }));
  for (let index = 0; index < 300; index++) {
    await flow.transport.sendAudio(Buffer.from([index & 0xff]));
  }
  socket.emit('data', packet(200));
  let audio = socket.writes.filter((entry, index) => index > 0 && socket.writes[index - 1][0] === 102);
  assert.equal(audio.length, 256);
  let type = root.lookupType('nest.nexustalk.v1.AudioPayload');
  assert.deepEqual(type.decode(audio[0]).payload, Buffer.from([44]));
  assert.deepEqual(type.decode(audio.at(-1)).payload, Buffer.from([299 & 0xff]));
});
test('NexusTalk pending video is bounded and a later frame recovers without retaining old payload', async (context) => {
  let flow = setup(context);
  let socket = await open(flow);
  begin(socket);
  for (let index = 0; index < 201; index++) {
    socket.emit('data', packet(204, 'PlaybackPacket', { channelId: 1, timestampDelta: 0, payload: Buffer.from([0x41, 1]) }));
  }
  assert.equal(flow.transport.stats.media.videoDrops['oversized-pending-frame'], 1);
  socket.emit('data', packet(204, 'PlaybackPacket', { channelId: 1, timestampDelta: 9000, payload: Buffer.from([0x65, 2]) }));
  await flow.transport.close();
  assert.equal(flow.media.length, 1);
  assert.deepEqual(flow.media[0].data, Buffer.from([0, 0, 0, 1, 0x65, 2]));
});
for (let type of ['AuthoriseRequest', 'Hello', 'StartPlayback', 'StopPlayback', 'AudioPayload']) {
  test('NexusTalk isolates protobuf ' + type + ' encode failure', async (context) => {
    let flow = setup(context);
    if (type === 'AuthoriseRequest' || type === 'Hello') {
      context.mock.method(root.lookupType('nest.nexustalk.v1.' + type), 'encode', () => {
        throw new Error('Fixture encode failure');
      });
      let socket = await open(flow);
      assert.equal(socket.writes.length, 0);
    } else {
      let socket = await open(flow);
      if (type !== 'StartPlayback') {
        begin(socket);
      }
      context.mock.method(root.lookupType('nest.nexustalk.v1.' + type), 'encode', () => {
        throw new Error('Fixture encode failure');
      });
      let before = socket.writes.length;
      if (type === 'StartPlayback') {
        socket.emit('data', packet(200));
      }
      if (type === 'StopPlayback') {
        await flow.transport.close();
      }
      if (type === 'AudioPayload') {
        await flow.transport.sendAudio(Buffer.from([1]));
      }
      assert.equal(socket.writes.length, before);
    }
  });
}
test('NexusTalk token/host updates and socket-close reconnect keep credentials on their own transport', async (context) => {
  let flow = setup(context);
  let socket = await open(flow);
  begin(socket);
  await flow.transport.update({ uuid: 'new-camera', host: 'replacement.invalid', apiAccess: { token: 'new-token', oauth2: 'oauth' } });
  assert.equal(flow.transport.uuid, 'new-camera');
  assert.equal(flow.transport.token, 'new-token');
  assert.equal(flow.transport.useGoogleAuth, true);
  socket.emit('close');
  assert.equal(flow.sockets[1].settings.host, 'replacement.invalid');
  flow.sockets[1].handshake();
  await flow.transport.update(null);
  assert.equal(flow.transport.token, 'new-token');
});
test('NexusTalk handles a TLS failure without consumers and does not reconnect', async (context) => {
  let flow = setup(context, { consumer: { active: () => false } });
  let opening = flow.transport.open();
  flow.sockets[0].emit('error', new Error('Fixture TLS error'));
  await opening;
  assert.equal(flow.sockets.length, 1);
  assert.equal(flow.transport.closed, true);
});

for (let reason of ['USER_ENDED_SESSION', 'ERROR_TIME_NOT_AVAILABLE']) {
  test('NexusTalk playback end flushes the final frame and handles ' + reason, async (context) => {
    let flow = setup(context);
    let socket = await open(flow);
    begin(socket);
    socket.emit('data', packet(204, 'PlaybackPacket', { channelId: 1, payload: Buffer.from([0x65, 9]), timestampDelta: 3000 }));
    assert.equal(flow.media.length, 0, 'last video frame waits for the next timestamp or playback end');
    socket.emit('data', packet(203, 'PlaybackEnd', { sessionId: 7, reason }));
    assert.equal(flow.media.length, 1);
    assert.equal(flow.media[0].keyFrame, true);
    assert.deepEqual(flow.media[0].data.subarray(-2), Buffer.from([0x65, 9]));
    socket.emit('close');
    await Promise.resolve();
    assert.equal(flow.sockets.length, reason === 'USER_ENDED_SESSION' ? 1 : 2);
    if (reason !== 'USER_ENDED_SESSION') {
      flow.sockets[1].handshake();
      begin(flow.sockets[1]);
      let count = flow.media.length;
      socket.emit('data', packet(204, 'PlaybackPacket', { channelId: 2, payload: Buffer.from([7]) }));
      assert.equal(flow.media.length, count, 'old TLS socket cannot publish into the replacement');
    }
  });
}
test('NexusTalk health suppression drops deltas until keyframes restore stable decoding', async (context) => {
  let flow = setup(context);
  let socket = await open(flow);
  begin(socket);
  let health = flow.transport.getMediaState('video');
  for (let index = 0; index < health.unstableBadThreshold; index++) {
    flow.transport.markMediaIssue('video', 'fixture-loss');
  }
  let send = (nal) =>
    socket.emit(
      'data',
      packet(204, 'PlaybackPacket', {
        channelId: 1,
        payload: Buffer.from([nal, 1]),
        timestampDelta: 3000,
      }),
    );
  send(0x41);
  send(0x65);
  assert.equal(flow.media.length, 0);
  assert.equal(flow.transport.stats.media.videoDrops['suppressed-delta-recovery'], 1);
  for (let index = 0; index < health.recoveringCleanTarget; index++) {
    send(0x65);
  }
  assert.equal(health.state, 'stable');
  send(0x41);
  send(0x41);
  assert.equal(flow.media.at(-1).keyFrame, false);
});

test('NexusTalk without a host stays closed without opening TLS', async (context) => {
  let flow = setup(context, { host: '' });
  await flow.transport.open();
  assert.equal(flow.sockets.length, 0);
  assert.equal(flow.transport.closed, true);
});
test('NexusTalk Google credentials use an olive token on the wire', async (context) => {
  let flow = setup(context, { apiAccess: { token: 'olive-fixture', oauth2: 'oauth-fixture' } });
  let socket = await open(flow);
  let hello = root.lookupType('nest.nexustalk.v1.Hello').decode(socket.writes[1]);
  let auth = root.lookupType('nest.nexustalk.v1.AuthoriseRequest').decode(hello.authoriseRequest);
  assert.equal(auth.oliveToken, 'olive-fixture');
  assert.equal(auth.sessionToken, '');
});
test('NexusTalk control and unknown packets do not corrupt following media', async (context) => {
  let flow = setup(context);
  let socket = await open(flow);
  begin(socket);
  socket.emit(
    'data',
    Buffer.concat([
      packet(1),
      packet(208),
      packet(209),
      packet(250),
      packet(204, 'PlaybackPacket', { channelId: 2, timestampDelta: 480, payload: Buffer.from([8]) }),
    ]),
  );
  assert.equal(flow.media.length, 1);
  assert.deepEqual(flow.media[0].data, Buffer.from([8]));
});
test('NexusTalk ignores unrelated channels, empty media and malformed input before valid playback', async (context) => {
  let flow = setup(context);
  let socket = await open(flow);
  begin(socket);
  for (let data of [
    null,
    'invalid',
    Buffer.alloc(0),
    packet(204, 'PlaybackPacket', { channelId: 99, payload: Buffer.from([1]) }),
    packet(204, 'PlaybackPacket', { channelId: 1 }),
    packet(204, 'PlaybackPacket', { channelId: 2 }),
  ]) {
    socket.emit('data', data);
  }
  assert.deepEqual(flow.media, []);
  socket.emit('data', packet(204, 'PlaybackPacket', { channelId: 2, payload: Buffer.from([2]) }));
  assert.equal(flow.media.length, 1);
});
test('NexusTalk write failures uncork the TLS socket and allow later talkback', async (context) => {
  let flow = setup(context);
  let socket = await open(flow);
  begin(socket);
  let uncork = context.mock.method(socket, 'uncork');
  let write = socket.write;
  socket.write = () => {
    throw new Error('Fixture write failed');
  };
  await flow.transport.sendAudio(Buffer.from([1]));
  assert.equal(uncork.mock.callCount(), 1);
  socket.write = write;
  await flow.transport.sendAudio(Buffer.from([2]));
  let audio = root.lookupType('nest.nexustalk.v1.AudioPayload').decode(socket.writes.at(-1));
  assert.deepEqual(audio.payload, Buffer.from([2]));
});

test('NexusTalk partial identity updates preserve Google authentication for the next connection', async (context) => {
  let flow = setup(context, { apiAccess: { token: 'olive-fixture', oauth2: 'oauth-fixture' } });
  await flow.transport.update({ uuid: 'camera.replacement' });
  assert.equal(flow.transport.useGoogleAuth, true);
  assert.equal(flow.transport.token, 'olive-fixture');
  let socket = await open(flow);
  let hello = root.lookupType('nest.nexustalk.v1.Hello').decode(socket.writes[1]);
  let auth = root.lookupType('nest.nexustalk.v1.AuthoriseRequest').decode(hello.authoriseRequest);
  assert.equal(auth.oliveToken, 'olive-fixture');
  await flow.transport.update({ apiAccess: { token: 'nest-fixture' } });
  assert.equal(flow.transport.useGoogleAuth, false, 'an explicitly supplied Nest credential object changes authentication mode');
});

for (let missing of [
  'AudioPayload',
  'StartPlayback',
  'StopPlayback',
  'AuthoriseRequest',
  'Hello',
  'Redirect',
  'PlaybackBegin',
  'PlaybackPacket',
  'PlaybackEnd',
  'Error',
]) {
  test('NexusTalk missing protobuf type ' + missing + ' stays contained at its protocol boundary', async (context) => {
    context.mock.method(schema, 'load', (path, name, log) =>
      name.endsWith('.' + missing) === true ? undefined : getProtoType(path, name, log),
    );
    let flow = setup(context);
    let socket = await open(flow);
    let before = socket.writes.length;
    begin(socket);
    if (missing === 'Redirect') {
      socket.emit('data', packet(207, 'Redirect', { newHost: 'replacement.invalid' }));
      assert.equal(socket.destroyed, false);
    }
    if (missing === 'Error') {
      socket.emit('data', packet(201, 'Error', { code: 'ERROR_AUTHORIZATION_FAILED' }));
      assert.equal(socket.destroyed, false);
    }
    socket.emit('data', packet(204, 'PlaybackPacket', { channelId: 2, payload: Buffer.from([9]) }));
    let writes = socket.writes.length;
    await flow.transport.sendAudio(Buffer.from([1]));
    if (missing === 'AudioPayload') {
      assert.equal(socket.writes.length, writes);
    }
    if (missing === 'PlaybackEnd') {
      socket.emit('data', packet(203, 'PlaybackEnd', { sessionId: 7, reason: 'USER_ENDED_SESSION' }));
      assert.equal(socket.destroyed, false);
    }
    await flow.transport.close();
    assert.equal(flow.sockets.length, 1, 'no reconnect before the owned socket closes');
    assert.equal(socket.destroyed, true);
    if (['Hello', 'AuthoriseRequest'].includes(missing) === true) {
      assert.equal(before, 0);
    }
    if (missing === 'PlaybackBegin' || missing === 'PlaybackPacket') {
      assert.deepEqual(flow.media, []);
    }
    if (missing === 'StartPlayback') {
      assert.equal(
        socket.writes.some((entry) => entry.length === 3 && entry[0] === 103),
        false,
      );
    }
    if (missing === 'StopPlayback') {
      assert.equal(
        socket.writes.some((entry) => entry.length === 3 && entry[0] === 104),
        false,
      );
    }
  });
}
test('NexusTalk a failed destroyed TLS socket reconnects once and ignores terminal events from its predecessor', async (context) => {
  let flow = setup(context);
  let opening = flow.transport.open();
  let old = flow.sockets[0];
  old.destroy();
  old.emit('error', new Error('Fixture TLS failure'));
  await opening;
  assert.equal(flow.sockets.length, 2);
  let replacement = flow.sockets[1];
  replacement.handshake();
  begin(replacement);
  old.emit('error', new Error('Fixture stale failure'));
  old.emit('end');
  old.emit('close');
  old.handshake();
  assert.equal(flow.sockets.length, 2);
  assert.equal(replacement.destroyed, false);
  assert.deepEqual(old.writes, []);
});
test('NexusTalk peer end followed by close reconnects a retained consumer exactly once', async (context) => {
  let flow = setup(context);
  let socket = await open(flow);
  begin(socket);
  socket.emit('end');
  assert.equal(flow.sockets.length, 1, 'close owns reconnect, not end');
  socket.destroy();
  socket.emit('close');
  assert.equal(flow.sockets.length, 2);
  flow.sockets[1].handshake();
  socket.emit('close');
  assert.equal(flow.sockets.length, 2);
});
test('NexusTalk graceful close survives socket destroy failure and can be called again', async (context) => {
  let flow = setup(context);
  let socket = await open(flow);
  begin(socket);
  let destroy = socket.destroy;
  socket.destroy = () => {
    throw new Error('Fixture destroy failed');
  };
  await flow.transport.close();
  assert.equal(flow.transport.closing, true);
  socket.destroy = destroy;
  await flow.transport.close();
  socket.emit('close');
  assert.equal(flow.transport.closed, true);
  assert.equal(flow.sockets.length, 1);
});

test('NexusTalk close before TLS handshake settles the pending open without a late handshake callback', async (context) => {
  let flow = setup(context);
  let settled = false;
  let opening = flow.transport.open().then(() => {
    settled = true;
  });
  let socket = flow.sockets[0];
  await flow.transport.close();
  socket.emit('close');
  await setImmediate();
  assert.equal(settled, true, 'requested close must not leave the open promise waiting forever');
  await opening;
  assert.equal(flow.transport.closed, true);
  assert.equal(flow.sockets.length, 1);
  assert.deepEqual(socket.writes, []);
});

for (let [videoStart, audioStart, expectedVideo, expectedAudio] of [
  [100, 100.1, 100000, 100100],
  [100, 110, 100000, 100250],
  [110, 100, 100250, 100000],
  [undefined, undefined, 100000, 100000],
]) {
  test('NexusTalk source channel offsets stay bounded: ' + videoStart + '/' + audioStart, async (context) => {
    let flow = setup(context);
    let socket = await open(flow);
    socket.emit('data', packet(200));
    socket.emit(
      'data',
      packet(202, 'PlaybackBegin', {
        sessionId: 7,
        channels: [
          { channelId: 1, codec: 'H264', sampleRate: 90000, startTime: videoStart },
          { channelId: 2, codec: 'AAC', sampleRate: 48000, startTime: audioStart },
        ],
      }),
    );
    socket.emit('data', packet(204, 'PlaybackPacket', { channelId: 1, payload: Buffer.from([0x65, 1]) }));
    socket.emit('data', packet(204, 'PlaybackPacket', { channelId: 2, payload: Buffer.from([2]) }));
    await flow.transport.close();
    assert.equal(flow.media.find((frame) => frame.type === 'video').timestamp, expectedVideo);
    assert.equal(flow.media.find((frame) => frame.type === 'audio').timestamp, expectedAudio);
  });
}
test('NexusTalk absent video clock metadata cannot make timestamps non-finite', async (context) => {
  let flow = setup(context);
  let socket = await open(flow);
  socket.emit('data', packet(200));
  socket.emit('data', packet(202, 'PlaybackBegin', { sessionId: 7, channels: [{ channelId: 1, codec: 'H264' }] }));
  socket.emit('data', packet(204, 'PlaybackPacket', { channelId: 1, timestampDelta: 9000, payload: Buffer.from([0x65, 1]) }));
  await flow.transport.close();
  assert.equal(flow.media[0].timestamp, 100000);
  assert.equal(Number.isFinite(flow.media[0].timestamp), true);
});

test('ending and resuming talkback preserves the playback session and empty end marker', async (context) => {
  let flow = setup(context);
  let socket = await open(flow);
  begin(socket);
  let before = socket.writes.length;
  await flow.transport.sendAudio(Buffer.from([1, 2]));
  await flow.transport.sendAudio(Buffer.alloc(0));
  await flow.transport.sendAudio(Buffer.from([3, 4]));
  let packets = socket.writes.slice(before);
  assert.deepEqual(packets.filter((entry, index) => index % 2 === 0).map((entry) => entry[0]), [102, 102, 102]);
  // Assert the wire bytes, since decoding supplies defaults even when the sender
  // incorrectly omits the empty payload or zero-valued SPEEX codec fields.
  let bodies = packets.filter((entry, index) => index % 2 === 1);
  assert.deepEqual(bodies.map((data) => data.toString('hex')), [
    '0a0201021007180020807d',
    '0a001007180020807d',
    '0a0203041007180020807d',
  ]);
  assert.deepEqual(
    packets.filter((entry, index) => index % 2 === 0).map((header) => header.readUInt16BE(1)),
    bodies.map((data) => data.length),
  );
  let type = root.lookupType('nest.nexustalk.v1.AudioPayload');
  let decoded = bodies.map((data) => type.decode(data));
  assert.deepEqual(decoded.map((message) => Buffer.from(message.payload)), [Buffer.from([1, 2]), Buffer.alloc(0), Buffer.from([3, 4])]);
  assert.equal(decoded.every((message) => message.sessionId === 7 && message.codec === 0 && message.sampleRate === 16000), true);
  assert.equal(flow.transport.connected, true);
  assert.equal(socket.destroyed, false);
  assert.equal(flow.sockets.length, 1);
});

test('talkback idle and peer-end diagnostics identify event ordering without exposing audio', async (context) => {
  let debug = [];
  let flow = setup(context, { log: { debug: (...args) => debug.push(args) } });
  let socket = await open(flow);
  begin(socket);
  await flow.transport.sendAudio(Buffer.from([1, 2]));
  await flow.transport.sendAudio(Buffer.alloc(0));
  socket.emit('end');
  let trace = debug.filter((args) => args[0].includes('idle marker') === true || args[0].includes('remote endpoint ended') === true);
  assert.equal(trace.length, 2);
  assert.match(trace[0][0], /idle marker/);
  assert.deepEqual(trace[0].slice(1), ['camera.test', 7]);
  assert.match(trace[1][0], /remote endpoint ended/);
  assert.deepEqual(trace[1].slice(1), ['camera.test', false, true]);
  assert.equal(socket.destroyed, false);
  socket.emit('close');
  assert.equal(flow.sockets.length, 2);
  socket.emit('end');
  assert.equal(debug.filter((args) => args[0].includes('remote endpoint ended') === true).length, 1);
  flow.sockets[1].handshake();
});
