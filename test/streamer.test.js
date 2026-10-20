// Test the shared source/output lifecycle with real Streamer and an injected transport; no sockets or FFmpeg.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { importSource } from './helpers/import-source.js';
import StreamTransport from '../src/plugins/camera/streamtransport.js';

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
      'constructor(settings) { super({ ...settings, writePacket: (data, metadata) => {' +
      'this.packets.push({ data, ...metadata }); return hooks.send?.(this, data, metadata) ?? true;' +
      '} }); hooks.instances.push(this); }' +
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
    assert.deepEqual(Object.keys(output).sort(), ['input', 'talkback']);
    assert.equal(output.input.type, 'rtp');
    assert.deepEqual(transport.calls, []);
    await streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_LIVE, { sessionID: 'live' });
    assert.equal(hooks.instances[0].closed, true);
  });
}
test('live and recording own independent RTP clocks while sharing one source', async (context) => {
  let { streamer, transport } = setup(context);
  let live = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'live', options: { includeAudio: true } });
  let record = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'record' });
  assert.equal(typeof live.talkback.write, 'function');
  assert.equal(record.talkback, null);
  assert.notEqual(live.input, record.input);
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
  assert.equal(first.input, second.input);
  assert.equal(first.talkback, second.talkback);
  assert.equal(hooks.instances.length, 1);
  assert.equal(await streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'same' }), undefined);
});
test('only one recording consumer is created across different request ids', async (context) => {
  let { streamer } = setup(context);
  let first = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'first' });
  let second = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'second' });
  assert.equal(first.input, second.input);
  assert.equal(hooks.instances.length, 1);
});
for (let type of [Streamer.MESSAGE_TYPE.START_LIVE, Streamer.MESSAGE_TYPE.START_RECORD]) {
  test(type + ' waits for IDR and packetizes cached SPS/PPS with the bootstrap timestamp', async (context) => {
    context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
    let { streamer, transport } = setup(context);
    await streamer.onMessage(type, { sessionID: 'decoder' });
    addVideo(transport, 100000, false);
    context.mock.timers.tick(300);
    assert.deepEqual(media(hooks.instances[0]), []);
    addVideo(transport, 100300);
    context.mock.timers.tick(500);
    let packets = media(hooks.instances[0]);
    assert.deepEqual(
      packets.map(({ data }) => data[12] & 31),
      [7, 8, 5],
    );
    assert.equal(new Set(packets.map(({ data }) => data.readUInt32BE(4))).size, 1);
    assert.equal(packets.at(-1).data[1] & 0x80, 0x80);
    await streamer.stopEverything();
    let count = packets.length;
    context.mock.timers.tick(1000);
    assert.equal(media(hooks.instances[0]).length, count);
  });
}
test('recording reads retained prebuffer while a later live view starts at the live edge', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context, {}, { bufferDuration: 8000 });
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_BUFFER, { options: {} });
  addVideo(transport, 100000);
  addVideo(transport, 100100, false);
  context.mock.timers.tick(300);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'clip', options: { recordTime: 100000 } });
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'live' });
  context.mock.timers.tick(500);
  assert.equal(media(hooks.instances[0]).length, 4);
  assert.deepEqual(media(hooks.instances[1]), []);
  addVideo(transport, 100800);
  context.mock.timers.tick(500);
  assert.equal(media(hooks.instances[1]).length, 3);
});
test('VFR source intervals survive accelerated retained recording playback', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context, {}, { bufferDuration: 8000 });
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_BUFFER, { options: {} });
  addVideo(transport, 100000);
  addVideo(transport, 100100, false);
  addVideo(transport, 100150, false);
  context.mock.timers.tick(2000);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'clip', options: { recordTime: 100000 } });
  context.mock.timers.tick(500);
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
  context.mock.timers.tick(10);
  let payload = Buffer.from([0xf8, 0xff, 0xfe]);
  transport.emitMedia({ type: 'audio', codec: 'opus', timestamp: 100020, data: payload });
  context.mock.timers.tick(500);
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
  context.mock.timers.tick(500);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'record', options: { includeAudio: true } });
  assert.equal(hooks.instances[1].needsAudioConfig, false);
  context.mock.timers.tick(500);
  transport.emitMedia({ type: 'audio', codec: 'aac', timestamp: 101020, data: adts(payload) });
  context.mock.timers.tick(500);
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
  context.mock.timers.tick(1000);
  assert.equal(media(slow).length, 3);
  assert.equal(media(hooks.instances[1]).length, 4);
  context.mock.timers.tick(1000);
  assert.equal(media(slow).length, 3);
  hooks.send = undefined;
  slow.resume('video');
  context.mock.timers.tick(500);
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
  context.mock.timers.tick(1000);
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
    context.mock.timers.tick(100);
    assert.equal(media(hooks.instances[0]).length > 0, true);
    let muxer = hooks.instances[0];
    hooks.send = () => false;
    context.mock.timers.tick(50);
    let count = media(muxer).length;
    context.mock.timers.tick(100);
    assert.equal(media(muxer).length, count);
  });
}
test('talkback still forwards bytes and sends its end marker after inactivity', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context);
  let sent = [];
  transport.sendAudio = async (data) => sent.push([...data]);
  let output = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'talk', options: { includeAudio: true } });
  output.talkback.write(Buffer.from([1, 2]));
  context.mock.timers.tick(1000);
  assert.deepEqual(sent, [[1, 2], []]);
  await streamer.stopEverything();
  context.mock.timers.tick(2000);
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
    assert.notEqual(replacement.input, old.input);
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
  assert.equal((await first).input, (await second).input);
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
  let starting = streamer.requestSourceConnect();
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
  await assert.rejects(streamer.requestSourceConnect(), (error) => error === failure);
  transport.open = Transport.prototype.open;
  await streamer.requestSourceConnect();
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
  assert.equal(recovered.input, live.input);
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
test('repeated and backwards source times become strictly increasing RTP timestamps', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context);
  transport.video.fps = 25;
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'live' });
  for (let timestamp of [100000, 100000, 99900, 100120]) {
    addVideo(transport, timestamp);
  }
  context.mock.timers.tick(1000);
  let timestamps = media(hooks.instances[0])
    .filter(({ data }) => (data[1] & 0x80) !== 0)
    .map(({ data }) => data.readUInt32BE(4));
  assert.equal(timestamps.length, 4);
  assert.deepEqual(
    timestamps.slice(1).map((value, index) => (value - timestamps[index]) >>> 0),
    [3600, 3600, 3600],
  );
});
test('invalid AAC configuration retires its receiver without stopping a video-only viewer', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context);
  transport.audio.codec = 'aac';
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'audio', options: { includeAudio: true } });
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'video' });
  transport.emitMedia({ type: 'audio', codec: 'aac', timestamp: 100000, data: Buffer.from([1]) });
  addVideo(transport);
  context.mock.timers.tick(1000);
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

test('Streamer retained timeline stays bounded under sustained overload and throttles full-buffer warnings', async (context) => {
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
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /retained timeline is full/);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_LIVE, { sessionID: 'overloaded' });
  assert.equal(info.find((entry) => entry[0].includes('"size"'))[1], 8192);
  assert.equal(info.find((entry) => entry[0].includes('"capacity"'))[1], 8192);
  assert.equal(info.find((entry) => entry[0].includes('"droppedItems"'))[1], 108);
});

test('source lifecycle clears stale host overrides and returns explicit close completion', async (context) => {
  let { streamer, transport } = setup(context);
  await streamer.requestSourceConnect({ host: 'old.invalid', quality: 'high' });
  await streamer.requestSourceClose();
  assert.equal(transport.closed, true);
  await streamer.requestSourceConnect({ quality: 'low' });
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
    context.mock.timers.tick(exit === 'timeout' ? 100 : 25);
    let output = await starting;
    assert.equal(output.input.type, 'rtp');
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
      context.mock.timers.tick(200);
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
    context.mock.timers.tick(300);
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
  context.mock.timers.tick(300);
  let count = media(hooks.instances[0]).length;
  transport.setState(StreamTransport.STATE.RECONNECTING);
  transport.setState(StreamTransport.STATE.READY);
  addVideo(transport, 100300, false);
  context.mock.timers.tick(200);
  assert.equal(media(hooks.instances[0]).length, count);
  addVideo(transport, 100500);
  context.mock.timers.tick(300);
  assert.equal(media(hooks.instances[0]).length, count + 3);
  assert.equal((await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'recovery' })).input, output.input);
});

for (let [sourceStart, repeated] of [
  [100000, false],
  [0, false],
  [100000, true],
]) {
  test('AAC retains exact sample-clock spacing: start=' + sourceStart + ' repeated=' + repeated, async (context) => {
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
    context.mock.timers.tick(1000);
    let timestamps = media(hooks.instances[0], 'audio').map(({ data }) => data.readUInt32BE(4));
    assert.equal(timestamps.length, 6);
    assert.deepEqual(
      timestamps.slice(1).map((value, index) => (value - timestamps[index]) >>> 0),
      [1024, 1024, 1024, 1024, 1024],
    );
  });
}

test('fractional video frame intervals retain their 90 kHz RTP clock spacing', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'video-clock' });
  for (let index = 0; index < 5; index++) {
    addVideo(transport, 100000 + (index * 1001 * 1000) / 30000, index === 0);
  }
  context.mock.timers.tick(1000);
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
  context.mock.timers.tick(500);
  assert.deepEqual(media(hooks.instances[0]), []);
  ready.resolve();
  await starting;
  assert.equal(streamer.isLiveStreaming(), true);
  addVideo(transport, 100500);
  context.mock.timers.tick(500);
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
  assert.equal((await first).input, (await second).input);
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
  context.mock.timers.tick(500);
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
  assert.equal((await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'same' })).input, replacement.input);
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
  context.mock.timers.tick(500);
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
  assert.equal(output.input.type, 'rtp');
  assert.equal(hooks.instances[0].needsAudioConfig, false);
  assert.equal(streamer.isLiveStreaming(), true);
});
