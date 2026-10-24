// Test the shared source/output lifecycle with real Streamer and an injected transport; no sockets or FFmpeg.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { importSource } from './helpers/import-source.js';
import StreamTransport from '../src/plugins/camera/streamtransport.js';
import H264 from '../src/plugins/camera/h264.js';
import RTPMuxer from '../src/plugins/camera/rtpmuxer.js';
import MediaTimeline from '../src/plugins/camera/mediatimeline.js';

// Forward timer calls to Node's per-test fake clock while preserving the production source bytes.
let location = new URL('../src/plugins/camera/streamer.js', import.meta.url);
let timers =
  'data:text/javascript,' +
  encodeURIComponent(
    'import timers from "node:timers";' +
      'export function setInterval(...args) { return timers.setInterval(...args); }' +
      'export function clearInterval(...args) { return timers.clearInterval(...args); }' +
      'export function setTimeout(...args) { return timers.setTimeout(...args); }' +
      'export function clearTimeout(...args) { return timers.clearTimeout(...args); }',
  );
// Inject only the delivery boundary: retain real packetization and clocks while
// replacing loopback delivery with a synchronous sink and controllable lifecycle.
let muxerModule =
  'data:text/javascript,' +
  encodeURIComponent(
    'import RTPMuxer from ' +
      JSON.stringify(new URL('../src/plugins/camera/rtpmuxer.js', import.meta.url).href) +
      ';' +
      'export let hooks = { instances: [], prepare: undefined, close: undefined, send: undefined };' +
      'export default class extends RTPMuxer {' +
      'packets = [];' +
      'constructor(settings) { super({ ...settings, audioControl: false, talkback: undefined, writePacket: (data, metadata) => {' +
      'this.packets.push({ data, ...metadata }); return hooks.send?.(this, data, metadata) ?? true;' +
      '} }); this.settings = settings; hooks.instances.push(this); }' +
      'prepare() { return hooks.prepare?.(this) ?? super.prepare(); }' +
      'close() { let done = super.close(); return hooks.close?.(this, done) ?? done; }' +
      '}',
  );
let { hooks } = await import(muxerModule);
let source = (await readFile(location, 'utf8'))
  .replace('from \'node:timers\'', 'from ' + JSON.stringify(timers))
  .replace('from \'./rtpmuxer.js\'', 'from ' + JSON.stringify(muxerModule));
let { default: Streamer } = await importSource(location, source);
let nextID = 0;
class Transport extends StreamTransport {
  calls = [];
  async open(options) {
    this.calls.push(['open', options]);
    this.setState(StreamTransport.STATE.READY);
  }

  async close() {
    this.calls.push(['close']);
    this.setState(StreamTransport.STATE.CLOSED);
  }

  async shutdown() {
    this.calls.push(['shutdown']);
  }

  async update(options) {
    this.calls.push(['update', options]);
  }
}
function setup(context, data = {}, options = {}) {
  hooks.instances = [];
  hooks.prepare = undefined;
  hooks.close = undefined;
  hooks.send = undefined;
  let transport = new Transport();
  transport.video.codec = 'h264';
  Object.assign(transport.audio, { codec: 'opus', sampleRate: 48000, channels: 2 });
  let streamer = new Streamer(
    'streamer-test-' + nextID++,
    {
      description: 'Camera',
      online: true,
      streaming_enabled: true,
      audio_enabled: true,
      nest_google_device_uuid: 'DEVICE_CAMERA',
      ...data,
    },
    { transport, ...options },
  );
  context.after(() => streamer.stopEverything());
  return { streamer, transport };
}

// Step the fake clock so relative playout deadlines see elapsed scheduler ticks,
// rather than every interval callback observing the end of a large time jump.
function advance(context, milliseconds) {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 10) {
    context.mock.timers.tick(Math.min(10, milliseconds - elapsed));
  }
}

let keyframe = Buffer.from([0, 0, 0, 1, 0x65, 1]);
function addVideo(transport, timestamp = 100000, keyFrame = true) {
  transport.emitMedia({
    type: 'video',
    codec: 'h264',
    timestamp,
    data: keyFrame === true ? keyframe : Buffer.from([0, 0, 0, 1, 0x61, 2]),
    keyFrame,
    codecConfig: keyFrame === true ? { sps: Buffer.from([0x67, 0x42]), pps: Buffer.from([0x68, 1]) } : undefined,
  });
}
function media(muxer, track = 'video') {
  return muxer.packets.filter((packet) => packet.kind === 'rtp' && packet.track === track);
}
for (let [label, data] of [
  ['offline', { online: false }],
  ['disabled', { streaming_enabled: false }],
]) {
  test(label + ' output prepares RTP without opening an unavailable source', async (context) => {
    let { streamer, transport } = setup(context, data);
    let output = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'live' });
    assert.deepEqual(Object.keys(output).sort(), ['fragments', 'start', 'stop']);
    assert.equal(typeof output.start, 'function');
    assert.equal(hooks.instances[0].input.type, 'rtp');
    assert.deepEqual(transport.calls, []);
    await streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_LIVE, { sessionID: 'live' });
    assert.equal(hooks.instances[0].closed, true);
  });
}
test('live and recording own independent RTP clocks while sharing one source', async (context) => {
  let { streamer, transport } = setup(context);
  let live = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'live', options: { includeAudio: true } });
  let record = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'record' });
  assert.notEqual(live, record);
  assert.notEqual(hooks.instances[0].input, hooks.instances[1].input);
  assert.equal(transport.calls.filter(([type]) => type === 'open').length, 1);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_LIVE, { sessionID: 'live' });
  assert.equal(hooks.instances[0].closed, true);
  assert.equal(hooks.instances[1].closed, false);
  assert.equal(
    transport.calls.some(([type]) => type === 'close'),
    false,
  );
  await streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_RECORD, { sessionID: 'record' });
  assert.equal(hooks.instances[1].closed, true);
  assert.equal(transport.calls.at(-1)[0], 'close');
});
test('duplicate starts reuse delivery and talkback, while conflicting types are rejected', async (context) => {
  let { streamer } = setup(context);
  let first = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'same', options: { includeAudio: true } });
  let second = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'same' });
  assert.equal(first, second);
  assert.equal(hooks.instances.length, 1);
  assert.equal(await streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'same' }), undefined);
});
test('only one recording consumer is created across different request ids', async (context) => {
  let { streamer } = setup(context);
  let first = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'first' });
  let second = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'second' });
  assert.equal(first, second);
  assert.equal(hooks.instances.length, 1);
});
for (let type of [Streamer.MESSAGE_TYPE.START_LIVE, Streamer.MESSAGE_TYPE.START_RECORD]) {
  test(type + ' waits for IDR and packetizes cached SPS/PPS with the bootstrap timestamp', async (context) => {
    context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
    let { streamer, transport } = setup(context);
    await streamer.onMessage(type, { sessionID: 'decoder' });
    addVideo(transport, 100000, false);
    advance(context, 300);
    assert.deepEqual(media(hooks.instances[0]), []);
    addVideo(transport, 100300);
    advance(context, 500);
    let packets = media(hooks.instances[0]);
    assert.deepEqual(
      packets.map(({ data }) => data[12] & 31),
      [7, 8, 5],
    );
    assert.equal(new Set(packets.map(({ data }) => data.readUInt32BE(4))).size, 1);
    assert.equal(packets.at(-1).data[1] & 0x80, 0x80);
    await streamer.stopEverything();
    let count = packets.length;
    advance(context, 1000);
    assert.equal(media(hooks.instances[0]).length, count);
  });
}
test('recording reads retained prebuffer while a later live view starts at the live edge', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context, {}, { bufferDuration: 8000 });
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_BUFFER, { options: {} });
  addVideo(transport, 100000);
  addVideo(transport, 100100, false);
  advance(context, 300);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'clip', options: { recordTime: 100000 } });
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'live' });
  advance(context, 500);
  assert.equal(media(hooks.instances[0]).length, 4);
  assert.deepEqual(media(hooks.instances[1]), []);
  addVideo(transport, 100800);
  advance(context, 500);
  assert.equal(media(hooks.instances[1]).length, 3);
});
test('recording merges retained audio and video by source time and drops audio before its first IDR', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context, {}, { bufferDuration: 8000 });
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_BUFFER, { options: {} });
  addVideo(transport, 100000);
  addVideo(transport, 100100, false);
  addVideo(transport, 100200);
  addVideo(transport, 100300, false);
  for (let timestamp of [100120, 100220, 100320]) {
    transport.emitMedia({ type: 'audio', codec: 'opus', timestamp, data: Buffer.from([0xf8, 0xff, 0xfe]) });
  }
  advance(context, 500);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, {
    sessionID: 'clip',
    options: { recordTime: 100100, includeAudio: true },
  });
  advance(context, 500);
  let packets = hooks.instances[0].packets.filter((packet) => packet.kind === 'rtp');
  // The first selected video is a delta frame. Audio from before the next IDR
  // must not slip through merely because the entire video backlog ran first.
  assert.equal(media(hooks.instances[0], 'audio').length, 2);
  assert.deepEqual(
    packets.map(({ track }) => track),
    ['video', 'video', 'video', 'audio', 'video', 'audio'],
  );
});

test('VFR source intervals survive accelerated retained recording playback', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context, {}, { bufferDuration: 8000 });
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_BUFFER, { options: {} });
  addVideo(transport, 100000);
  addVideo(transport, 100100, false);
  addVideo(transport, 100150, false);
  advance(context, 2000);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'clip', options: { recordTime: 100000 } });
  advance(context, 500);
  let timestamps = media(hooks.instances[0])
    .filter(({ data }) => (data[1] & 0x80) !== 0)
    .map(({ data }) => data.readUInt32BE(4));
  assert.deepEqual(
    timestamps.slice(1).map((value, index) => (value - timestamps[index]) >>> 0),
    [9000, 4500],
  );
});
test('native Opus stays compressed for simultaneous live and recording consumers', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context);
  Object.assign(transport.audio, { codec: 'opus', sampleRate: 48000, channels: 2 });
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'live', options: { includeAudio: true } });
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'record', options: { includeAudio: true } });
  addVideo(transport);
  advance(context, 10);
  let payload = Buffer.from([0xf8, 0xff, 0xfe]);
  transport.emitMedia({ type: 'audio', codec: 'opus', timestamp: 100020, data: payload });
  advance(context, 500);
  for (let muxer of hooks.instances) {
    assert.deepEqual(media(muxer, 'audio')[0].data.subarray(12), payload);
  }
});
test('AAC learns from source ADTS and retained metadata for later recording consumers', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { adts } = await import('./helpers/aac-fixtures.js');
  let { streamer, transport } = setup(context);
  Object.assign(transport.audio, { codec: 'aac', channels: 1 });
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'live', options: { includeAudio: true } });
  assert.equal(hooks.instances[0].needsAudioConfig, true);
  addVideo(transport);
  let payload = Buffer.from([0x21, 0x10, 0x56]);
  transport.emitMedia({ type: 'audio', codec: 'aac', timestamp: 100020, data: adts(payload) });
  assert.equal(hooks.instances[0].needsAudioConfig, false);
  advance(context, 500);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'record', options: { includeAudio: true } });
  assert.equal(hooks.instances[1].needsAudioConfig, false);
  advance(context, 500);
  transport.emitMedia({ type: 'audio', codec: 'aac', timestamp: 101020, data: adts(payload) });
  advance(context, 500);
  for (let muxer of hooks.instances) {
    assert.deepEqual(media(muxer, 'audio')[0].data.subarray(16), payload);
  }
});
test('a blocked viewer finishes its current access unit without stalling another RTP viewer', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'slow' });
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'fast' });
  let slow = hooks.instances[0];
  hooks.send = (muxer, data, metadata) => (muxer === slow && metadata.kind === 'rtp' ? false : true);
  addVideo(transport);
  addVideo(transport, 100100, false);
  advance(context, 1000);
  assert.equal(media(slow).length, 3);
  assert.equal(media(hooks.instances[1]).length, 4);
  advance(context, 1000);
  assert.equal(media(slow).length, 3);
  hooks.send = undefined;
  slow.resume('video');
  advance(context, 500);
  assert.equal(media(slow).length, 4);
});
test('a failed RTP sink retires only its own viewer', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'bad' });
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'good' });
  hooks.send = (muxer) => {
    if (muxer === hooks.instances[0]) {
      throw new Error('Receiver failed');
    }
    return true;
  };
  addVideo(transport);
  advance(context, 1000);
  assert.equal(hooks.instances[0].closed, true);
  assert.equal(hooks.instances[1].closed, false);
  assert.equal(media(hooks.instances[1]).length, 3);
  assert.equal(streamer.isLiveStreaming(), true);
  assert.equal(
    transport.calls.some(([type]) => type === 'close'),
    false,
  );
});
for (let [label, data] of [
  ['offline', { online: false }],
  ['disabled', { streaming_enabled: false }],
  ['migration', { migrating: true }],
]) {
  test(label + ' fallback emits H264 RTP with bounded delivery', async (context) => {
    context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
    let { streamer } = setup(context, data);
    await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'fallback' });
    advance(context, 100);
    assert.equal(media(hooks.instances[0]).length > 0, true);
    let types = media(hooks.instances[0]).map(({ data }) => data[12] & 31);
    assert.equal(types.includes(7), true, 'fallback must preserve its SPS');
    assert.equal(types.includes(8), true, 'fallback must preserve its PPS');
    let muxer = hooks.instances[0];
    hooks.send = () => false;
    advance(context, 50);
    let count = media(muxer).length;
    advance(context, 100);
    assert.equal(media(muxer).length, count);
  });
}
test('talkback still forwards bytes and sends its end marker after inactivity', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context);
  let sent = [];
  transport.sendAudio = async (data) => sent.push([...data]);
  let output = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'talk', options: { includeAudio: true } });
  let startLive = context.mock.fn(() => []);
  output.start({ startLive }, {});
  let settings = startLive.mock.calls[0].arguments[0];
  assert.equal(settings.input, hooks.instances[0].input);
  assert.equal(settings.ports, hooks.instances[0].ports);
  settings.talkback.write(Buffer.from([1, 2]));
  advance(context, 1000);
  assert.deepEqual(sent, [[1, 2], []]);
  await streamer.stopEverything();
  advance(context, 2000);
  assert.deepEqual(sent, [[1, 2], []]);
});
for (let shutdown of [false, true]) {
  test('pending RTP preparation is cancelled by ' + (shutdown === true ? 'shutdown' : 'STOP'), async (context) => {
    let { streamer } = setup(context);
    let ready = Promise.withResolvers();
    hooks.prepare = () => ready.promise;
    let starting = streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'same' });
    await setImmediate();
    let old = hooks.instances[0];
    await (shutdown === true ? streamer.stopEverything() : streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_LIVE, { sessionID: 'same' }));
    assert.equal(old.closed, true);
    hooks.prepare = undefined;
    let replacement = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'same' });
    ready.resolve();
    assert.equal(await starting, undefined);
    assert.equal(typeof replacement.start, 'function');
    assert.notEqual(hooks.instances[1].input, old.input);
    assert.equal(hooks.instances[1].closed, false);
  });
}
test('duplicate pending starts share one RTP preparation', async (context) => {
  let { streamer } = setup(context);
  let ready = Promise.withResolvers();
  hooks.prepare = () => ready.promise;
  let first = streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'same' });
  let second = streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'same' });
  await setImmediate();
  assert.equal(hooks.instances.length, 1);
  ready.resolve();
  assert.equal(await first, await second);
});
test('RTP preparation failure releases an unused source and allows retry', async (context) => {
  let { streamer, transport } = setup(context);
  hooks.prepare = () => Promise.reject(new Error('Bind failed'));
  await assert.rejects(streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'live' }), /Bind failed/);
  assert.equal(hooks.instances[0].closed, true);
  assert.equal(transport.closed, true);
  hooks.prepare = undefined;
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'live' });
  assert.equal(hooks.instances[1].closed, false);
});
test('asynchronous socket closure cannot retire a same-id replacement', async (context) => {
  let { streamer, transport } = setup(context);
  let finished = Promise.withResolvers();
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'same' });
  let old = hooks.instances[0];
  hooks.close = (muxer, done) => (muxer === old ? finished.promise : done);
  let stopping = streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_LIVE, { sessionID: 'same' });
  await setImmediate();
  assert.equal(old.closed, true);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'same' });
  finished.resolve();
  await stopping;
  assert.equal(hooks.instances[1].closed, false);
  assert.equal(
    transport.calls.some(([type]) => type === 'close'),
    false,
  );
});
test('shutdown waits for RTP resource closure and retires transport ownership', async (context) => {
  let { streamer, transport } = setup(context);
  let finished = Promise.withResolvers();
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'live' });
  hooks.close = () => finished.promise;
  let done = false;
  let stopping = streamer.stopEverything().then(() => {
    done = true;
  });
  await setImmediate();
  assert.equal(done, false);
  assert.equal(hooks.instances[0].closed, true);
  assert.equal(
    transport.calls.some(([type]) => type === 'shutdown'),
    true,
  );
  finished.resolve();
  await stopping;
  assert.equal(done, true);
});

test('shutdown waits for a pending source open before close and transport shutdown', async (context) => {
  let { streamer, transport } = setup(context);
  let pending = Promise.withResolvers();
  transport.open = async () => {
    transport.calls.push(['open']);
    await pending.promise;
    transport.setState(StreamTransport.STATE.READY);
  };
  let starting = streamer.onMessage(Streamer.MESSAGE_TYPE.START_BUFFER);
  await setImmediate();
  let stopping = streamer.stopEverything();
  await setImmediate();
  assert.deepEqual(transport.calls, [['open']]);
  pending.resolve();
  await starting;
  await stopping;
  assert.deepEqual(transport.calls, [['open'], ['close'], ['shutdown']]);
});

test('a failed source open is surfaced and does not poison later lifecycle work', async (context) => {
  let { streamer, transport } = setup(context);
  let failure = new Error('Source unavailable');
  transport.open = async () => {
    throw failure;
  };
  await assert.rejects(streamer.onMessage(Streamer.MESSAGE_TYPE.START_BUFFER), (error) => error === failure);
  transport.open = Transport.prototype.open;
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_BUFFER);
  assert.equal(transport.calls.at(-1)[0], 'open');
  await streamer.stopEverything();
  assert.equal(transport.calls.at(-1)[0], 'shutdown');
});

test('offline recovery preserves the existing RTP endpoint and source identity updates', async (context) => {
  let { streamer, transport } = setup(context);
  let live = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'same' });
  await streamer.onUpdate({ online: false });
  assert.equal(transport.calls.at(-1)[0], 'close');
  assert.equal(hooks.instances[0].closed, false);
  await streamer.onUpdate({ online: true });
  assert.equal(transport.calls.at(-1)[0], 'open');
  let recovered = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'same' });
  assert.equal(recovered, live);
  await streamer.onUpdate({ nest_google_device_uuid: 'DEVICE_REPLACEMENT' });
  assert.equal(streamer.nest_google_device_uuid, 'DEVICE_REPLACEMENT');
  assert.equal(hooks.instances.length, 1);
});
test('stopping retained buffering does not retire an active RTP viewer', async (context) => {
  let { streamer, transport } = setup(context);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_BUFFER, { options: {} });
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'live' });
  await streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_BUFFER);
  assert.equal(hooks.instances[0].closed, false);
  assert.equal(streamer.isLiveStreaming(), true);
  assert.equal(
    transport.calls.some(([type]) => type === 'close'),
    false,
  );
});
test('repeated and backwards source times are discarded without moving later presentation time', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context);
  transport.video.fps = 25;
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'live' });
  for (let timestamp of [100000, 100000, 99900, 100120]) {
    addVideo(transport, timestamp);
  }
  advance(context, 1000);
  let timestamps = media(hooks.instances[0])
    .filter(({ data }) => (data[1] & 0x80) !== 0)
    .map(({ data }) => data.readUInt32BE(4));
  assert.equal(timestamps.length, 2);
  assert.equal((timestamps[1] - timestamps[0]) >>> 0, 10800);
});
test('invalid AAC configuration retires its receiver without stopping a video-only viewer', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context);
  transport.audio.codec = 'aac';
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'audio', options: { includeAudio: true } });
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'video' });
  transport.emitMedia({ type: 'audio', codec: 'aac', timestamp: 100000, data: Buffer.from([1]) });
  await setImmediate();
  addVideo(transport);
  advance(context, 1000);
  assert.equal(hooks.instances[0].closed, true);
  assert.equal(hooks.instances[1].closed, false);
  assert.equal(media(hooks.instances[1]).length, 3);
  assert.equal(streamer.isLiveStreaming(), true);
});
test('pending stop diagnostics cannot remove a same-id RTP replacement', async (context) => {
  let { streamer, transport } = setup(context);
  let ready = Promise.withResolvers();
  transport.refreshDiagnostics = () => ready.promise;
  streamer.supportDump = true;
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'same' });
  let stopping = streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_LIVE, { sessionID: 'same' });
  await setImmediate();
  assert.equal(hooks.instances[0].closed, true);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'same' });
  ready.resolve();
  await stopping;
  assert.equal(hooks.instances[1].closed, false);
  assert.equal(streamer.isLiveStreaming(), true);
});

test('Streamer retains a bounded byte window under sustained overload without rejecting current media', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let warnings = [];
  let info = [];
  let { streamer, transport } = setup(
    context,
    {},
    {
      supportDump: true,
      log: {
        debug() {},
        error() {},
        success() {},
        warn: (...args) => warnings.push(args),
        info: (...args) => info.push(args),
      },
    },
  );
  transport.video.codec = 'h264';
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'overloaded' });
  let data = Buffer.alloc(600 * 1024, 1);
  for (let index = 0; index < 8300; index++) {
    transport.emitMedia({ type: 'video', timestamp: 100000 + index, data, keyFrame: true });
  }
  assert.equal(warnings.length, 0);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_LIVE, { sessionID: 'overloaded' });
  assert.equal(info.find((entry) => entry[0].includes('"size"'))[1], 54);
  assert.equal(info.find((entry) => entry[0].includes('"capacity"'))[1], 2048);
  assert.equal(info.find((entry) => entry[0].includes('"droppedItems"'))[1], 0);
});

test('source lifecycle clears stale host overrides and returns explicit close completion', async (context) => {
  let { streamer, transport } = setup(context);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_BUFFER, { options: { host: 'old.invalid', quality: 'high' } });
  await streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_BUFFER);
  assert.equal(transport.closed, true);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_BUFFER, { options: { quality: 'low' } });
  assert.deepEqual(
    transport.calls.filter(([kind]) => kind === 'open').map((entry) => entry[1]),
    [{ host: 'old.invalid', quality: 'high' }, { quality: 'low' }],
  );
});

for (let exit of ['ready', 'closed', 'reconnecting', 'timeout']) {
  test('source readiness wait returns stream handles on ' + exit, async (context) => {
    context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
    let { streamer, transport } = setup(context);
    transport.open = async () => transport.setState(StreamTransport.STATE.CONNECTING);
    let settled = false;
    let starting = streamer
      .onMessage(Streamer.MESSAGE_TYPE.START_LIVE, {
        sessionID: 'wait',
        options: { waitForReady: 100 },
      })
      .then((output) => {
        settled = true;
        return output;
      });
    await setImmediate();
    assert.equal(settled, false);
    if (exit !== 'timeout') {
      transport.setState(StreamTransport.STATE[exit.toUpperCase()]);
    }
    advance(context, exit === 'timeout' ? 100 : 25);
    let output = await starting;
    assert.equal(typeof output.start, 'function');
    assert.equal(hooks.instances[0].input.type, 'rtp');
    assert.equal(streamer.isLiveStreaming(), true);
  });
}

for (let diagnostics of [false, true]) {
  test('source/output audio gap diagnostics are bounded and require opt-in: ' + diagnostics, async (context) => {
    context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
    let logs = [];
    let { streamer, transport } = setup(
      context,
      {},
      {
        supportDump: diagnostics,
        log: {
          debug: (...args) => logs.push(args),
          info() {},
          warn() {},
          error() {},
          success() {},
        },
      },
    );
    transport.video.codec = 'h264';

    await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'gaps', options: { includeAudio: true } });
    for (let index = 0; index < 5; index++) {
      transport.emitMedia({ type: 'audio', timestamp: 100000 + index * 200, data: Buffer.from([0xf8, 0xff, 0xfe]) });
      advance(context, 200);
    }
    for (let kind of ['source audio gap', 'output audio write gap']) {
      assert.equal(logs.filter((entry) => entry[0].includes(kind)).length, diagnostics === true ? 1 : 0);
    }
  });
}

for (let config of ['both', 'SPS', 'PPS']) {
  test('RTP bootstrap keeps exactly one copy of each parameter set: ' + config, async (context) => {
    context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
    let { streamer, transport } = setup(context);
    await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'sets' });
    let sps = Buffer.from([0x67, 1]);
    let pps = Buffer.from([0x68, 2]);
    let prefix = Buffer.from([0, 0, 0, 1]);
    let hasSPS = config !== 'PPS';
    let hasPPS = config !== 'SPS';
    let idr = Buffer.from([0x65, 3]);
    let accessUnit = Buffer.concat([...(hasSPS === true ? [prefix, sps] : []), ...(hasPPS === true ? [prefix, pps] : []), prefix, idr]);
    transport.emitMedia({ type: 'video', timestamp: 100000, keyFrame: true, data: accessUnit, codecConfig: { sps, pps, hasSPS, hasPPS } });
    advance(context, 310);
    let packets = media(hooks.instances[0]).map(({ data }) => data.subarray(12));
    assert.equal(packets.filter((data) => data.equals(sps)).length, 1);
    assert.equal(packets.filter((data) => data.equals(pps)).length, 1);
    assert.deepEqual(packets.at(-1), idr);
  });
}
test('reconnect resets decoder startup without replacing the RTP endpoint', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context);
  let output = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'recovery' });
  addVideo(transport);
  advance(context, 310);
  let count = media(hooks.instances[0]).length;
  transport.setState(StreamTransport.STATE.RECONNECTING);
  transport.setState(StreamTransport.STATE.READY);
  addVideo(transport, 100300, false);
  advance(context, 200);
  assert.equal(media(hooks.instances[0]).length, count);
  addVideo(transport, 100500);
  advance(context, 310);
  assert.equal(media(hooks.instances[0]).length, count + 3);
  assert.equal(await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'recovery' }), output);
});

for (let [sourceStart, repeated] of [
  [100000, false],
  [0, false],
  [100000, true],
]) {
  test(
    'AAC preserves source sample-clock spacing and rejects repeated timestamps: start=' + sourceStart + ' repeated=' + repeated,
    async (context) => {
      context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
      let { adts } = await import('./helpers/aac-fixtures.js');
      let { streamer, transport } = setup(context);
      Object.assign(transport.audio, { codec: 'aac', sampleRate: 48000, channels: 1, frameDuration: (1024 * 1000) / 48000 });
      await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'precision', options: { includeAudio: true } });
      let payload = adts(Buffer.from([0x21, 0x10, 0x56]));
      for (let index = 0; index < 6; index++) {
        transport.emitMedia({
          type: 'AUDIO',
          codec: 'AAC',
          timestamp: sourceStart + (repeated === true ? 0 : (index * 1024 * 1000) / 48000),
          data: payload,
        });
      }
      advance(context, 1000);
      let timestamps = media(hooks.instances[0], 'audio').map(({ data }) => data.readUInt32BE(4));
      assert.equal(timestamps.length, repeated === true ? 1 : 6);
      assert.deepEqual(
        timestamps.slice(1).map((value, index) => (value - timestamps[index]) >>> 0),
        repeated === true ? [] : [1024, 1024, 1024, 1024, 1024],
      );
    },
  );
}

test('fractional video frame intervals retain their 90 kHz RTP clock spacing', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'video-clock' });
  for (let index = 0; index < 5; index++) {
    addVideo(transport, 100000 + (index * 1001 * 1000) / 30000, index === 0);
  }
  advance(context, 1000);
  let timestamps = media(hooks.instances[0])
    .filter(({ data }) => (data[1] & 0x80) !== 0)
    .map(({ data }) => data.readUInt32BE(4));
  assert.equal(timestamps.length, 5);
  assert.deepEqual(
    timestamps.slice(1).map((value, index) => (value - timestamps[index]) >>> 0),
    [3003, 3003, 3003, 3003],
  );
});

test('preparing outputs hold source demand without reporting active playback or receiving media', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context);
  let ready = Promise.withResolvers();
  hooks.prepare = () => ready.promise;
  let starting = streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'preparing' });
  await setImmediate();
  assert.equal(streamer.hasActiveStreams(), true);
  assert.equal(transport.hasConsumers(), true);
  assert.equal(streamer.isStreaming(), false);
  assert.equal(streamer.isLiveStreaming(), false);
  assert.equal(streamer.isRecording(), false);
  addVideo(transport);
  advance(context, 500);
  assert.deepEqual(media(hooks.instances[0]), []);
  ready.resolve();
  await starting;
  assert.equal(streamer.isLiveStreaming(), true);
  addVideo(transport, 100500);
  advance(context, 500);
  assert.equal(media(hooks.instances[0]).length, 3);
});

test('different recording ids share one pending recording record', async (context) => {
  let { streamer, transport } = setup(context);
  let ready = Promise.withResolvers();
  hooks.prepare = () => ready.promise;
  let first = streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'first' });
  let second = streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'second' });
  await setImmediate();
  assert.equal(hooks.instances.length, 1);
  assert.equal(streamer.isRecording(), false);
  assert.equal(transport.hasConsumers(), true);
  ready.resolve();
  assert.equal(await first, await second);
  assert.equal(streamer.isRecording(), true);
});

test('stopping buffering preserves a preparing recording and its retained prebuffer', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_BUFFER);
  addVideo(transport);
  let ready = Promise.withResolvers();
  hooks.prepare = () => ready.promise;
  let starting = streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'preparing', options: { recordTime: 100000 } });
  await setImmediate();
  await streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_BUFFER);
  assert.equal(streamer.isBuffering(), false);
  assert.equal(
    transport.calls.some(([type]) => type === 'close'),
    false,
  );
  assert.equal(streamer.hasActiveStreams(), true);
  ready.resolve();
  await starting;
  advance(context, 500);
  assert.equal(media(hooks.instances[0]).length, 3);
});

test('failed old preparation cannot remove or close a same-id replacement', async (context) => {
  let { streamer } = setup(context);
  let ready = Promise.withResolvers();
  hooks.prepare = () => ready.promise;
  let starting = streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'same' });
  let rejected = assert.rejects(starting, /Old bind failed/);
  await setImmediate();
  await streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_LIVE, { sessionID: 'same' });
  hooks.prepare = undefined;
  let replacement = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'same' });
  ready.reject(new Error('Old bind failed'));
  await rejected;
  assert.equal(hooks.instances[0].closed, true);
  assert.equal(hooks.instances[1].closed, false);
  assert.equal(await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'same' }), replacement);
});

test('source acquisition failure removes its preparing record and permits retry', async (context) => {
  let { streamer, transport } = setup(context);
  let fail = true;
  transport.open = async () => {
    if (fail === true) {
      fail = false;
      throw new Error('Source failed');
    }
    transport.setState(StreamTransport.STATE.READY);
  };
  await assert.rejects(streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'retry' }), /Source failed/);
  assert.equal(streamer.hasActiveStreams(), false);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'retry' });
  assert.equal(streamer.isLiveStreaming(), true);
});

test('an active viewer continues while another output is preparing', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'active' });
  let ready = Promise.withResolvers();
  hooks.prepare = () => ready.promise;
  let preparing = streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'pending' });
  await setImmediate();
  addVideo(transport);
  advance(context, 500);
  assert.equal(media(hooks.instances[0]).length, 3);
  assert.deepEqual(media(hooks.instances[1]), []);
  assert.equal(streamer.isRecording(), false);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_LIVE, { sessionID: 'active' });
  assert.equal(streamer.hasActiveStreams(), true);
  assert.equal(
    transport.calls.some(([type]) => type === 'close'),
    false,
  );
  ready.resolve();
  await preparing;
  assert.equal(streamer.isRecording(), true);
});

test('source frames arriving during acquisition configure the preparing output safely', async (context) => {
  let { adts } = await import('./helpers/aac-fixtures.js');
  let { streamer, transport } = setup(context);
  transport.audio.codec = 'aac';
  transport.open = async () => {
    assert.equal(transport.hasConsumers(), true);
    transport.setState(StreamTransport.STATE.CONNECTING);
    addVideo(transport);
    transport.emitMedia({ type: 'audio', timestamp: 100020, data: adts(Buffer.from([0x21, 0x10, 0x56])) });
    transport.setState(StreamTransport.STATE.READY);
  };
  let output = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'startup', options: { includeAudio: true } });
  assert.equal(typeof output.start, 'function');
  assert.equal(hooks.instances[0].input.type, 'rtp');
  assert.equal(hooks.instances[0].needsAudioConfig, false);
  assert.equal(streamer.isLiveStreaming(), true);
});

for (let firstTrack of ['video', 'audio']) {
  test(
    'late first ' + (firstTrack === 'video' ? 'audio' : 'video') + ' with earlier source time keeps live output and buffering running',
    async (context) => {
      context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
      let { streamer, transport } = setup(context);
      await streamer.onMessage(Streamer.MESSAGE_TYPE.START_BUFFER);
      await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'live', options: { includeAudio: true } });
      let write = (track, timestamp) => {
        if (track === 'video') {
          addVideo(transport, timestamp);
        } else {
          transport.emitMedia({ type: 'audio', timestamp, data: Buffer.from([0xf8, 0xff, 0xfe]) });
        }
      };
      write(firstTrack, 100040);
      advance(context, 310);
      let muxer = hooks.instances[0];
      assert.ok(media(muxer, firstTrack).length > 0);
      let lateTrack = firstTrack === 'video' ? 'audio' : 'video';
      write(lateTrack, 100000);
      advance(context, 100);
      assert.equal(streamer.isLiveStreaming(), true);
      assert.equal(streamer.isBuffering(), true);
      assert.equal(media(muxer, lateTrack).length > 0, true);
      assert.equal(
        transport.calls.some(([type]) => type === 'close'),
        false,
      );
    },
  );
}

for (let type of [Streamer.STREAM_TYPE.LIVE, Streamer.STREAM_TYPE.RECORD]) {
  test('regular ' + type + ' arrivals preserve fixed delivery pacing and RTP intervals', async (context) => {
    context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 100000 });
    let { streamer, transport } = setup(context);
    await streamer.onMessage(type === Streamer.STREAM_TYPE.LIVE ? Streamer.MESSAGE_TYPE.START_LIVE : Streamer.MESSAGE_TYPE.START_RECORD, {
      sessionID: 'fixed-pacing',
    });
    for (let index = 0; index < 12; index++) {
      addVideo(transport, Date.now(), index === 0);
      advance(context, 40);
    }

    let muxer = hooks.instances[0];
    advance(context, 310);
    let before = media(muxer).length;
    // A future source frame must still wait after regular arrivals. Repeated
    // deadline adjustments used to make live delivery progressively earlier.
    let futureTime = Date.now() + 500;
    addVideo(transport, futureTime, false);
    advance(context, 10);
    assert.equal(media(muxer).length, before);
    advance(context, 810);
    assert.equal(media(muxer).length, before + 1);
    let times = media(muxer)
      .filter(({ data }) => (data[1] & 0x80) !== 0)
      .map(({ data }) => data.readUInt32BE(4));
    assert.deepEqual(
      times.slice(1).map((time, index) => (time - times[index]) >>> 0),
      [...Array(11).fill(3600), (futureTime - 100440) * 90],
    );
  });
}

for (let diagnostics of [false, true]) {
  test('shared queue diagnostics cover video-only output; enabled=' + diagnostics, async (context) => {
    context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
    let logs = [];
    let { streamer, transport } = setup(
      context,
      {},
      { supportDump: diagnostics, log: { debug() {}, error() {}, success() {}, warn() {}, info: (...args) => logs.push(args) } },
    );
    await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'queue-diagnostics' });
    let muxer = hooks.instances[0];
    let queued = 0;
    let query = context.mock.method(muxer, 'queuedBytes', () => queued);
    hooks.send = (output, data, metadata) => {
      if (metadata.kind === 'rtp') {
        queued += data.length;
      }
      return true;
    };
    addVideo(transport);
    advance(context, 310);
    assert.equal(queued > 0, true);
    // The access-unit reservation queries once regardless of diagnostics.
    assert.equal(query.mock.callCount(), diagnostics === true ? 2 : 1);
    await streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_LIVE, { sessionID: 'queue-diagnostics' });
    let maximum = logs.find((entry) => entry[0].includes('"maxQueuedBytes"'));
    assert.equal(maximum?.[1], diagnostics === true ? queued : undefined);
    assert.equal(
      logs.some((entry) => entry[0].includes('"maxAudioQueuedBytes"')),
      false,
    );
  });
}

for (let diagnostics of [false, true]) {
  test('audio timing emits one stop summary per live/record output only when enabled=' + diagnostics, async (context) => {
    context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
    let logs = [];
    let { streamer, transport } = setup(
      context,
      {},
      {
        supportDump: diagnostics,
        log: { debug: (...args) => logs.push(args), info: (...args) => logs.push(args), warn() {}, error() {}, success() {} },
      },
    );
    await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'live-timing', options: { includeAudio: true } });
    await streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'record-timing', options: { includeAudio: true } });
    addVideo(transport);
    for (let timestamp of [100000, 100020, 100160, 100170]) {
      transport.emitMedia({ type: 'audio', timestamp, data: Buffer.from([0xf8, 0xff, 0xfe]) });
      advance(context, 40);
    }
    advance(context, 500);
    let summaries = () => logs.filter((entry) => entry[0].startsWith('RTP audio timing'));
    assert.equal(summaries().length, 0);
    await streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_LIVE, { sessionID: 'live-timing' });
    await streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_RECORD, { sessionID: 'record-timing' });
    assert.equal(summaries().length, diagnostics === true ? 2 : 0);
    for (let entry of summaries()) {
      assert.equal(entry[4].gaps, 1);
      assert.equal(entry[4].maxGapMs, 120);
      assert.equal(entry[4].overlaps, 1);
      assert.equal(entry[4].maxOverlapMs, 10);
    }
    // Duplicate stops never produce another summary or reset another receiver's counters.
    await streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_LIVE, { sessionID: 'live-timing' });
    await streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_RECORD, { sessionID: 'record-timing' });
    assert.equal(summaries().length, diagnostics === true ? 2 : 0);
  });
}

test('fixed live playout spaces 200 ms audio batches without changing RTP timing', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context);
  let writes = [];
  hooks.send = (muxer, data, metadata) => {
    if (metadata.kind === 'rtp' && metadata.track === 'audio') {
      writes.push({ at: Date.now(), timestamp: data.readUInt32BE(4) });
    }
    return true;
  };
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'batched', options: { includeAudio: true } });
  addVideo(transport);
  let audio = (timestamp) => transport.emitMedia({ type: 'audio', timestamp, data: Buffer.from([0xf8, 0xff, 0xfe]) });
  audio(100000);
  advance(context, 200);
  assert.equal(writes.length, 0, 'normal delivery retains fixed playout headroom');
  for (let batch = 0; batch < 5; batch++) {
    for (let index = 1; index <= 10; index++) {
      audio(100000 + batch * 200 + index * 20);
    }
    advance(context, 200);
  }
  advance(context, 500);
  assert.equal(writes.length, 51);
  assert.equal(writes[0].at, 100310);
  for (let index = 1; index < writes.length; index++) {
    assert.equal(writes[index].at - writes[index - 1].at, 20);
    assert.equal((writes[index].timestamp - writes[index - 1].timestamp) >>> 0, 960);
  }
});

test('recording replay stops at its captured startup boundary while new arrivals wait for playout', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context, {}, { bufferDuration: 8000 });
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_BUFFER);
  for (let index = 0; index < 50; index++) {
    if (index % 10 === 0) {
      addVideo(transport, 100000 + index * 20, index === 0);
    }
    transport.emitMedia({ type: 'audio', timestamp: 100000 + index * 20, data: Buffer.from([0xf8, 0xff, 0xfe]) });
  }
  advance(context, 1000);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, {
    sessionID: 'boundary',
    options: { recordTime: 100000, includeAudio: true },
  });
  let muxer = hooks.instances[0];
  // These frames arrive after START_RECORD and must not join the replay range.
  addVideo(transport, 101000, false);
  transport.emitMedia({ type: 'audio', timestamp: 101000, data: Buffer.from([0xf8, 0xff, 0xfe]) });
  advance(context, 10);
  assert.equal(media(muxer, 'audio').length > 0, true);
  assert.equal(media(muxer, 'audio').length < 50, true, 'the shared work limit bounds retained replay');
  advance(context, 290);
  assert.equal(media(muxer, 'audio').length, 50);
  assert.equal(media(muxer).filter(({ data }) => (data[1] & 0x80) !== 0).length, 5);
  advance(context, 40);
  let audio = media(muxer, 'audio');
  assert.equal(audio.length, 51);
  assert.equal((audio.at(-1).data.readUInt32BE(4) - audio.at(-2).data.readUInt32BE(4)) >>> 0, 960);
  assert.equal(media(muxer).filter(({ data }) => (data[1] & 0x80) !== 0).length, 6);
});

test('a delayed first video frame cannot anchor playout behind newer retained audio', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'late-keyframe', options: { includeAudio: true } });
  transport.setState(StreamTransport.STATE.CONNECTED);
  for (let index = 0; index <= 150; index++) {
    transport.emitMedia({ type: 'audio', timestamp: 100000 + index * 20, data: Buffer.from([0xf8, 0xff, 0xfe]) });
    advance(context, 20);
  }
  // The IDR completes now, but its source time describes its first RTP packet.
  // Arrival order therefore differs from the shared source timeline's head.
  addVideo(transport, 100000);
  transport.setState(StreamTransport.STATE.READY);
  advance(context, 400);
  assert.equal(media(hooks.instances[0], 'audio').length, 151, 'startup backlog must not become several seconds of playout latency');
});

test('a video timestamp fault keeps both track clocks intact and waits for a keyframe', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'timestamp-fault', options: { includeAudio: true } });
  addVideo(transport, 100000);
  addVideo(transport, 100000, false);
  addVideo(transport, 100020, false);
  addVideo(transport, 100040);
  for (let timestamp of [100000, 100000, 99900, 100040]) {
    transport.emitMedia({ type: 'audio', timestamp, data: Buffer.from([0xf8, 0xff, 0xfe]) });
  }
  advance(context, 600);
  let video = media(hooks.instances[0])
    .filter(({ data }) => (data[1] & 0x80) !== 0)
    .map(({ data }) => data.readUInt32BE(4));
  let audio = media(hooks.instances[0], 'audio').map(({ data }) => data.readUInt32BE(4));
  assert.equal(video.length, 2);
  assert.equal(audio.length, 2);
  assert.equal((video[1] - video[0]) >>> 0, 3600);
  assert.equal((audio[1] - audio[0]) >>> 0, 1920);
  assert.equal(transport.stats.media.videoDrops['timestamp-recovery'], 1);
});

for (let restart of ['reopen', 'reconnect']) {
  test('source audio gap diagnostics reset on ' + restart + ' without hiding new-session gaps', async (context) => {
    context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
    let logs = [];
    let { streamer, transport } = setup(
      context,
      {},
      {
        supportDump: true,
        log: { debug: (...args) => logs.push(args), info() {}, warn() {}, error() {}, success() {} },
      },
    );
    await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'old', options: { includeAudio: true } });
    addVideo(transport);
    transport.emitMedia({ type: 'audio', timestamp: Date.now(), data: Buffer.from([0xf8, 0xff, 0xfe]) });
    advance(context, 200);
    transport.emitMedia({ type: 'audio', timestamp: Date.now(), data: Buffer.from([0xf8, 0xff, 0xfe]) });
    assert.equal(logs.filter((entry) => entry[0].includes('source audio gap')).length, 1);

    if (restart === 'reopen') {
      await streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_LIVE, { sessionID: 'old' });
      context.mock.timers.tick(697910);
      await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'new', options: { includeAudio: true } });
    } else {
      transport.setState(StreamTransport.STATE.RECONNECTING);
      advance(context, 1000);
      transport.setState(StreamTransport.STATE.READY);
    }
    logs = [];
    transport.emitMedia({ type: 'audio', timestamp: Date.now(), data: Buffer.from([0xf8, 0xff, 0xfe]) });
    assert.equal(logs.filter((entry) => entry[0].includes('source audio gap')).length, 0);
    advance(context, 200);
    transport.emitMedia({ type: 'audio', timestamp: Date.now(), data: Buffer.from([0xf8, 0xff, 0xfe]) });
    let gaps = logs.filter((entry) => entry[0].includes('source audio gap'));
    assert.equal(gaps.length, 1);
    assert.deepEqual(gaps[0].slice(2), [200, '-', '-']);
  });
}

test('audio gap logs and stop statistics measure the same accepted writes', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let logs = [];
  let { streamer, transport } = setup(
    context,
    {},
    {
      supportDump: true,
      log: { debug: (...args) => logs.push(args), info: (...args) => logs.push(args), warn() {}, error() {}, success() {} },
    },
  );
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'gap-statistics', options: { includeAudio: true } });
  transport.emitMedia({ type: 'audio', timestamp: 100000, data: Buffer.from([0xf8, 0xff, 0xfe]) });
  advance(context, 310);
  for (let [timestamp, elapsed] of [
    [100100, 100],
    [100350, 250],
    [100850, 500],
    [101450, 600],
  ]) {
    transport.emitMedia({ type: 'audio', timestamp, data: Buffer.from([0xf8, 0xff, 0xfe]) });
    advance(context, elapsed);
  }
  await streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_LIVE, { sessionID: 'gap-statistics' });
  assert.equal(media(hooks.instances[0], 'audio').length, 5);
  let gaps = logs.filter((entry) => entry[0].includes('output audio write gap'));
  assert.equal(gaps.length, 1, 'gap logging remains throttled');
  assert.equal(gaps[0][4], 250);
  for (let [name, expected] of [
    ['firstWrite', '310ms'],
    ['firstAudioWrite', '310ms'],
    ['maxAudioWriteGapMs', 600],
    ['audioWriteGapsOver100Ms', 3],
    ['audioWriteGapsOver250Ms', 2],
    ['audioWriteGapsOver500Ms', 1],
  ]) {
    assert.equal(logs.find((entry) => entry[0].includes('"' + name + '"'))?.[1], expected, name);
  }
});

test('only live audio outputs pass optional talkback routing to their muxer', async (context) => {
  let { streamer } = setup(context);
  // Hold preparation at the injected boundary so this checks settings without binding sockets.
  hooks.prepare = async () => {};
  let talkback = { port: 12001, payloadType: 110 };
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'talk', options: { includeAudio: true, talkback } });
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'record', options: { includeAudio: true, talkback } });
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'silent', options: { includeAudio: false, talkback } });
  assert.equal(hooks.instances[0].settings.audioControl, true);
  assert.equal(hooks.instances[1].settings.audioControl, false);
  assert.equal(hooks.instances[2].settings.audioControl, false);
  assert.equal(hooks.instances[0].settings.talkback, talkback);
  assert.equal(hooks.instances[1].settings.talkback, undefined);
  assert.equal(hooks.instances[2].settings.talkback, undefined);
});

test('each camera receives a fresh work budget despite earlier delivery cost', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let first = setup(context);
  let second = setup(context);
  await first.streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'first' });
  await second.streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'second' });
  let firstMuxer = hooks.instances[0];
  let secondMuxer = hooks.instances[1];
  let clock = Date.now;
  let simulatedWork = 0;
  context.mock.method(Date, 'now', () => clock() + simulatedWork);
  hooks.send = (muxer, data, metadata) => {
    if (muxer === firstMuxer && metadata.kind === 'rtp') {
      simulatedWork += 6;
    }
    return true;
  };
  for (let index = 0; index < 100; index++) {
    addVideo(first.transport, 100000 + index * 40);
    addVideo(second.transport, 100000 + index * 40);
  }
  advance(context, 50);
  let firstPackets = media(firstMuxer).length;
  let secondPackets = media(secondMuxer).length;
  context.diagnostic(JSON.stringify({ firstPackets, secondPackets, simulatedWorkMs: simulatedWork }));
  assert.equal(firstPackets > 0, true);
  assert.equal(secondPackets > 0, true);
});

test('a blocked output cannot pin retention or starve a healthy output', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'blocked' });
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'healthy' });
  let blocked = hooks.instances[0];
  let healthy = hooks.instances[1];
  hooks.send = (muxer, data, metadata) => muxer !== blocked || metadata.kind !== 'rtp';
  let add = MediaTimeline.prototype.add;
  let rejected = 0;
  context.mock.method(MediaTimeline.prototype, 'add', function (item) {
    let result = add.call(this, item);
    if (result === undefined) {
      rejected++;
    }
    return result;
  });
  addVideo(transport, 100000);
  advance(context, 310);
  for (let index = 1; index < 8220; index++) {
    addVideo(transport, 100000 + index * 40);
    advance(context, 40);
  }
  let before = media(healthy).length;
  for (let index = 8220; index < 8230; index++) {
    addVideo(transport, 100000 + index * 40);
    advance(context, 40);
  }
  context.diagnostic(JSON.stringify({ rejected, healthyPacketsBefore: before, healthyPacketsAfter: media(healthy).length }));
  assert.equal(rejected, 0);
  assert.equal(media(healthy).length > before, true);
  assert.equal(healthy.closed, false);
});

test('shared frames are parsed once and unchanged SPS metadata is reused across outputs', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context);
  for (let sessionID of ['one', 'two', 'three']) {
    await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID });
  }
  let parse = H264.getNALUnits;
  let scans = context.mock.method(H264, 'getNALUnits', (data) => parse(data));
  let info = context.mock.method(H264, 'getSPSInfo', () => ({ width: 1280, height: 720 }));
  let data = Buffer.from([0, 0, 0, 1, 0x67, 0x42, 0, 0, 0, 1, 0x68, 1, 0, 0, 0, 1, 0x65, 1]);
  for (let index = 0; index < 10; index++) {
    transport.emitMedia({ type: 'video', codec: 'h264', timestamp: 100000 + index * 100, keyFrame: true, data });
    advance(context, 100);
  }
  advance(context, 310);
  context.diagnostic(JSON.stringify({ frames: 10, outputs: 3, annexBScans: scans.mock.callCount(), spsParses: info.mock.callCount() }));
  assert.equal(scans.mock.callCount(), 10);
  assert.equal(info.mock.callCount(), 1);
});

test('source timestamp reset keeps live and recording outputs on a continuous RTP axis', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let errors = [];
  let { streamer, transport } = setup(
    context,
    {},
    {
      log: {
        debug() {},
        info() {},
        warn() {},
        success() {},
        error: (...args) => errors.push(args),
      },
    },
  );
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'one' });
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'record' });
  addVideo(transport, 100000);
  advance(context, 310);
  transport.setState(StreamTransport.STATE.RECONNECTING);
  transport.setState(StreamTransport.STATE.READY);
  addVideo(transport, 99900);
  advance(context, 400);
  await setImmediate();
  context.diagnostic(
    JSON.stringify({ schedulerErrors: errors.length, liveClosed: hooks.instances[0].closed, recordingClosed: hooks.instances[1].closed }),
  );
  assert.equal(errors.length, 0);
  assert.equal(hooks.instances[0].closed, false);
  assert.equal(hooks.instances[1].closed, false);
});

test('retained IDRs bootstrap with their own configuration and update it at the next IDR', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_BUFFER);
  let oldSPS = Buffer.from([0x67, 0x42]);
  let oldPPS = Buffer.from([0x68, 1]);
  let newSPS = Buffer.from([0x67, 0x64]);
  let newPPS = Buffer.from([0x68, 2]);
  let oldIDR = Buffer.from([0, 0, 0, 1, 0x65, 0x11]);
  let newIDR = Buffer.from([0, 0, 0, 1, 0x65, 0x22]);
  transport.emitMedia({
    type: 'video',
    timestamp: 100000,
    keyFrame: true,
    data: oldIDR,
    codecConfig: { sps: oldSPS, pps: oldPPS, hasSPS: false, hasPPS: false },
  });
  advance(context, 100);
  transport.emitMedia({
    type: 'video',
    timestamp: 100100,
    keyFrame: true,
    data: newIDR,
    codecConfig: { sps: newSPS, pps: newPPS, hasSPS: false, hasPPS: false },
  });
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'config', options: { recordTime: 100000 } });
  advance(context, 10);
  let payloads = media(hooks.instances[0]).map((packet) => packet.data.subarray(12));
  context.diagnostic(JSON.stringify({ firstNALs: payloads.slice(0, 3).map((data) => data.toString('hex')) }));
  assert.deepEqual(payloads[0], oldSPS);
  assert.deepEqual(payloads[1], oldPPS);
  assert.deepEqual(payloads[2], oldIDR.subarray(4));
  assert.deepEqual(payloads.slice(3), [newSPS, newPPS, newIDR.subarray(4)]);
});

test('one receiver failure retires its FFmpeg process without stopping concurrent live or recording outputs', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context);
  let closed = [];
  let failed = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, {
    sessionID: 'bad',
    options: { onClose: (error) => closed.push(error) },
  });
  let healthy = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'good' });
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'clip' });
  let completion = Promise.withResolvers();
  let process = { diagnosticLines: ['Fixture receiver failure'], finished: completion.promise, stop: context.mock.fn() };
  failed.start({ startLive: () => [process] }, {});
  assert.throws(() => failed.start({}, {}), /already started/);
  completion.resolve({ expected: false, code: 1 });
  await setImmediate();
  assert.equal(hooks.instances[0].closed, true);
  assert.equal(hooks.instances[1].closed, false);
  assert.equal(hooks.instances[2].closed, false);
  assert.equal(closed.length, 1);
  assert.match(closed[0].message, /Fixture receiver failure/);
  assert.equal(process.stop.mock.callCount(), 1);
  addVideo(transport, 100000);
  advance(context, 310);
  assert.equal(media(hooks.instances[1]).length, 3);
  await failed.stop();
  assert.equal(hooks.instances[1].closed, false);
  await healthy.stop();
  assert.equal(streamer.isRecording(), true);
});

test('abort during endpoint preparation closes only that owner and leaves a replacement running', async (context) => {
  let { streamer } = setup(context);
  let ready = Promise.withResolvers();
  let controller = new AbortController();
  hooks.prepare = () => ready.promise;
  let starting = streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'same', options: { signal: controller.signal } });
  await setImmediate();
  controller.abort();
  await setImmediate();
  assert.equal(hooks.instances[0].closed, true);
  hooks.prepare = undefined;
  let replacement = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'same' });
  ready.resolve();
  assert.equal(await starting, undefined);
  assert.equal(hooks.instances[1].closed, false);
  await replacement.stop();
});

test('an already aborted output never acquires a source or endpoint', async (context) => {
  let { streamer, transport } = setup(context);
  let controller = new AbortController();
  controller.abort();
  assert.equal(
    await streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'cancelled', options: { signal: controller.signal } }),
    undefined,
  );
  assert.equal(hooks.instances.length, 0);
  assert.equal(
    transport.calls.some(([kind]) => kind === 'open'),
    false,
  );
});

test('repeated output stops await source teardown and an old handle cannot stop its replacement', async (context) => {
  let { streamer, transport } = setup(context);
  let output = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'same' });
  let retired = Promise.withResolvers();
  transport.close = async () => {
    await retired.promise;
    transport.setState(StreamTransport.STATE.CLOSED);
  };
  let first = output.stop();
  let secondDone = false;
  let second = output.stop().then(() => {
    secondDone = true;
  });
  await setImmediate();
  assert.equal(secondDone, false);
  retired.resolve();
  await Promise.all([first, second]);
  let replacement = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'same' });
  await output.stop();
  assert.equal(hooks.instances[1].closed, false);
  await replacement.stop();
});

test('recording output delegates fragment reading to its manager and owns the process through shutdown', async (context) => {
  let { streamer } = setup(context);
  let output = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'record' });
  let done = Promise.withResolvers();
  let process = { finished: done.promise, diagnosticLines: [], stop: context.mock.fn(() => done.resolve({ expected: true })) };
  let bytes = Buffer.from([1, 2]);
  let manager = {
    startRecording: context.mock.fn(() => process),
    fragments: async function* (handle) {
      assert.equal(handle, process);
      yield bytes;
    },
  };
  output.start(manager, { includeAudio: false });
  let received = [];
  for await (let fragment of output.fragments()) {
    received.push(fragment);
  }
  assert.deepEqual(received, [bytes]);
  assert.equal(manager.startRecording.mock.calls[0].arguments[0].id, 'record');
  await streamer.stopEverything();
  assert.equal(process.stop.mock.callCount(), 1);
  assert.throws(() => output.start(manager, {}), /closed/);
});

test('blocked delivery waits for drain notification instead of repeatedly polling an overdue frame', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'backpressure' });
  let muxer = hooks.instances[0];
  hooks.send = () => false;
  addVideo(transport, 100000);
  addVideo(transport, 100040);
  advance(context, 350);
  let count = media(muxer).length;
  let blocked = context.mock.method(muxer, 'blocked');
  advance(context, 500);
  assert.equal(blocked.mock.callCount() < 5, true);
  assert.equal(media(muxer).length, count);
  hooks.send = () => true;
  muxer.resume('video');
  advance(context, 10);
  assert.equal(media(muxer).length, count + 1);
});

for (let codec of ['aac', 'opus']) {
  test('shared ' + codec + ' audio is normalized once for retained replay and concurrent outputs', async (context) => {
    context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
    let { adts } = await import('./helpers/aac-fixtures.js');
    let { streamer, transport } = setup(context);
    transport.audio.codec = codec;
    let parse = context.mock.method(RTPMuxer, 'normalizeAudio');
    await streamer.onMessage(Streamer.MESSAGE_TYPE.START_BUFFER);
    addVideo(transport);
    let payload =
      codec === 'aac'
        ? Buffer.concat([adts(Buffer.from([0x21, 0x10]), { frequency: 4 }), adts(Buffer.from([0x21, 0x11]), { frequency: 4 })])
        : Buffer.from([0xf8, 0xff, 0xfe]);
    transport.emitMedia({ type: 'audio', timestamp: 100040, data: payload });
    assert.equal(parse.mock.callCount(), 1);
    await streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'record', options: { includeAudio: true } });
    await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'live1', options: { includeAudio: true } });
    await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'live2', options: { includeAudio: true } });
    transport.emitMedia({ type: 'audio', timestamp: 100100, data: payload });
    // A stale batch is discarded before parsing, including malformed stale AAC.
    transport.emitMedia({ type: 'audio', timestamp: 100100, data: Buffer.from([1]) });
    advance(context, 1000);
    assert.equal(parse.mock.callCount(), 2, 'configuration and delivery must reuse retained normalization');
    let frames = codec === 'aac' ? 2 : 1;
    assert.equal(media(hooks.instances[0], 'audio').length, frames * 2);
    assert.equal(media(hooks.instances[1], 'audio').length, frames);
    assert.equal(media(hooks.instances[2], 'audio').length, frames);
    if (codec === 'aac') {
      for (let muxer of hooks.instances) {
        let packets = media(muxer, 'audio');
        assert.equal((packets[1].data.readUInt32BE(4) - packets[0].data.readUInt32BE(4)) >>> 0, 1024);
      }
    }
    let shared = parse.mock.calls[1].result;
    assert.equal(shared.frames[0].data.buffer, payload.buffer, 'normalization must not copy payload bytes');
    assert.equal(shared.frames[0].data.byteOffset, payload.byteOffset + (codec === 'aac' ? 7 : 0));
  });
}

for (let codec of ['aac', 'opus']) {
  test('fallback ' + codec + ' audio shares normalization until its source buffer changes', async (context) => {
    context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
    let { adts } = await import('./helpers/aac-fixtures.js');
    let { streamer, transport } = setup(context, { online: false });
    transport.audio.codec = codec;
    transport.audio.blank = codec === 'aac' ? adts(Buffer.from([0x21, 1])) : Buffer.from([0xf8, 0xff, 0xfe]);
    let parse = context.mock.method(RTPMuxer, 'normalizeAudio');
    for (let sessionID of ['one', 'two']) {
      await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID, options: { includeAudio: true } });
    }
    advance(context, 200);
    assert.equal(parse.mock.callCount(), 1);
    assert.ok(media(hooks.instances[0], 'audio').length > 1);
    assert.equal(media(hooks.instances[0], 'audio').length, media(hooks.instances[1], 'audio').length);
    transport.audio.blank = Buffer.from(transport.audio.blank);
    advance(context, 200);
    assert.equal(parse.mock.callCount(), 2);
  });
}
