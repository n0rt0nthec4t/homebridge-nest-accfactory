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
let source = (await readFile(location, 'utf8')).replace('from \'node:timers\'', 'from ' + JSON.stringify(timers));
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
  let transport = new Transport();
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
for (let [label, data] of [
  ['offline', { online: false }],
  ['disabled', { streaming_enabled: false }],
]) {
  test(label + ' camera can prepare output without opening a source', async (context) => {
    let { streamer, transport } = setup(context, data);
    let output = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'live' });
    assert.equal(typeof output.video.write, 'function');
    assert.deepEqual(transport.calls, []);
    assert.equal(streamer.isLiveStreaming(), true);
    await streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_LIVE, { sessionID: 'live' });
    assert.equal(output.video.writableEnded, true);
    assert.equal(streamer.hasActiveStreams(), false);
  });
}
test('live and recording share a source and stopping one preserves the other', async (context) => {
  let { streamer, transport } = setup(context);
  let live = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'live', options: { includeAudio: true } });
  let record = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'record', options: { includeAudio: true } });
  assert.equal(transport.calls.filter(([kind]) => kind === 'open').length, 1);
  assert.equal(streamer.isRecording(), true);
  assert.equal(streamer.isLiveStreaming(), true);
  assert.equal(typeof live.talkback.write, 'function');
  assert.equal(record.talkback, null);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_LIVE, { sessionID: 'live' });
  assert.equal(live.video.writableEnded, true);
  assert.equal(record.video.writableEnded, false);
  assert.equal(streamer.isRecording(), true);
  assert.equal(
    transport.calls.some(([kind]) => kind === 'close'),
    false,
  );
  await streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_RECORD, { sessionID: 'record' });
  assert.equal(record.video.writableEnded, true);
  assert.equal(streamer.hasActiveStreams(), false);
  assert.equal(transport.calls.at(-1)[0], 'close');
});

test('duplicate outputs retain streams, recording stays singular and type conflicts are rejected', async (context) => {
  let { streamer } = setup(context);
  let first = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'one' });
  let duplicate = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'two' });
  assert.equal(duplicate.video, first.video);
  assert.equal(await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'one' }), undefined);
  assert.equal(await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, {}), undefined);
  await streamer.stopEverything();
  assert.equal(first.video.writableEnded, true);
  assert.equal(streamer.isRecording(), false);
});

test('retained buffering keeps source alive after the last viewer leaves', async (context) => {
  let { streamer, transport } = setup(context);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_BUFFER);
  let live = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'one' });
  await streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_LIVE, { sessionID: 'one' });
  assert.equal(live.video.writableEnded, true);
  assert.equal(streamer.isBuffering(), true);
  assert.equal(
    transport.calls.some(([kind]) => kind === 'close'),
    false,
  );
  await streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_BUFFER);
  assert.equal(streamer.hasActiveStreams(), false);
  assert.equal(transport.calls.at(-1)[0], 'close');
});

test('offline/recovery reconnects active source while preserving HomeKit output identity', async (context) => {
  let { streamer, transport } = setup(context);
  let live = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'one' });
  await streamer.onUpdate({ online: false });
  assert.equal(transport.calls.at(-1)[0], 'close');
  assert.equal(live.video.writableEnded, false);
  await streamer.onUpdate({ online: true });
  assert.equal(transport.calls.at(-1)[0], 'open');
  let recovered = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'one' });
  assert.equal(recovered.video, live.video);
  await streamer.onUpdate({ nest_google_device_uuid: 'DEVICE_REPLACEMENT' });
  assert.equal(streamer.nest_google_device_uuid, 'DEVICE_REPLACEMENT');
  assert.equal(transport.calls.at(-1)[0], 'open');
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

for (let type of ['live', 'record']) {
  test(type + ' output waits for a keyframe and injects cached SPS/PPS before decoder startup', async (context) => {
    context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
    let { streamer, transport } = setup(context);
    transport.video.codec = 'h264';
    transport.video.fps = 30;
    let output = await streamer.onMessage(type === 'live' ? Streamer.MESSAGE_TYPE.START_LIVE : Streamer.MESSAGE_TYPE.START_RECORD, {
      sessionID: 'decoder',
    });
    let chunks = [];
    output.video.on('data', (data) => chunks.push(data));
    streamer.addMedia({ type: 'video', codec: 'h264', timestamp: 100000, data: Buffer.from([0, 0, 0, 1, 0x41, 1]), keyFrame: false });
    context.mock.timers.tick(100);
    assert.deepEqual(chunks, [], 'inter-frames cannot initialise the decoder');
    let sps = Buffer.from([0x67, 0x42, 0, 0x1f]);
    let pps = Buffer.from([0x68, 0x01]);
    let idr = Buffer.from([0, 0, 0, 1, 0x65, 0x02]);
    streamer.addMedia({
      type: 'video',
      codec: 'h264',
      timestamp: 100100,
      data: idr,
      keyFrame: true,
      codecConfig: { sps, pps, hasSPS: false, hasPPS: false },
    });
    context.mock.timers.tick(500);
    assert.deepEqual(Buffer.concat(chunks), Buffer.concat([Buffer.from([0, 0, 0, 1]), sps, Buffer.from([0, 0, 0, 1]), pps, idr]));
    await streamer.stopEverything();
    let count = chunks.length;
    context.mock.timers.tick(1000);
    assert.equal(chunks.length, count, 'teardown removes the scheduler output');
  });
}

test('talkback forwards bytes to the active transport and sends silence after inactivity', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context);
  let audio = [];
  transport.sendAudio = async (data) => audio.push(data);
  let output = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'talk', options: { includeAudio: true } });
  let packet = Buffer.from([1, 2, 3]);
  output.talkback.write(packet);
  assert.deepEqual(audio, [packet]);
  context.mock.timers.tick(3000);
  assert.equal(audio.at(-1).length, 0);
  await streamer.stopEverything();
});

for (let [label, data] of [
  ['offline', { online: false }],
  ['software off', { streaming_enabled: false }],
  ['migration', { migrating: true }],
]) {
  test('Streamer supplies paced fallback video and silence while ' + label, async (context) => {
    context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
    let { streamer, transport } = setup(context, data, { supportDump: true });
    transport.video.codec = 'h264';
    transport.audio.blank = Buffer.from([0, 0]);
    let output = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'fallback', options: { includeAudio: true } });
    let video = [];
    let audio = [];
    output.video.on('data', (chunk) => video.push(chunk));
    output.audio.on('data', (chunk) => audio.push(chunk));
    context.mock.timers.tick(40);
    assert.equal(video.length, 2, 'one Annex-B prefix and one fallback frame');
    assert.deepEqual(video[0], Buffer.from([0, 0, 0, 1]));
    assert.deepEqual(audio, [transport.audio.blank]);
    context.mock.timers.tick(10);
    assert.equal(video.length, 2, 'fallback is paced rather than repeated on every scheduler tick');
    await streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_LIVE, { sessionID: 'fallback' });
  });
}

test('diagnostic output counts real audio/video writes and logs only when the last live output stops', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let logs = [];
  let log = Object.fromEntries(
    ['info', 'success', 'warn', 'error', 'debug'].map((name) => [name, (...args) => logs.push([name, ...args])]),
  );
  let { streamer, transport } = setup(context, {}, { supportDump: true, log });
  transport.video.codec = 'h264';
  transport.audio.codec = 'pcm';
  transport.audio.frameDuration = 20;
  let first = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'one', options: { includeAudio: true } });
  let second = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'two', options: { includeAudio: true } });
  let received = [];
  for (let output of [first, second]) {
    output.video.on('data', () => {});
    output.audio.on('data', (chunk) => received.push(chunk));
  }
  let audio = Buffer.from([1, 2]);
  for (let index = 0; index < 6; index++) {
    streamer.addMedia({
      type: 'video',
      timestamp: 100000 + index * 500,
      data: Buffer.from([0, 0, 0, 1, index === 0 ? 0x65 : 0x41, index]),
      keyFrame: index === 0,
      codecConfig: { sps: Buffer.from([0x67, 1]), pps: Buffer.from([0x68, 2]) },
    });
    streamer.addMedia({ type: 'audio', timestamp: 100000 + index * 500, data: audio });
    context.mock.timers.tick(500);
  }
  assert.ok(received.length > 0);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_LIVE, { sessionID: 'one' });
  assert.equal(
    logs.some(([level]) => level === 'info'),
    false,
  );
  await streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_LIVE, { sessionID: 'two' });
  assert.equal(
    logs.some(([level, text]) => level === 'info' && text.includes('Support dump')),
    true,
  );
  assert.equal(
    logs.some(([, text]) => text.includes('audioWriteGapsOver250Ms')),
    true,
  );
});

for (let type of ['live', 'record']) {
  test(type + ' slow video consumer stops buffering additional frames until drain', async (context) => {
    context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
    let { streamer, transport } = setup(context, {}, { supportDump: true });
    transport.video.codec = 'h264';
    let output = await streamer.onMessage(type === 'live' ? Streamer.MESSAGE_TYPE.START_LIVE : Streamer.MESSAGE_TYPE.START_RECORD, {
      sessionID: 'slow',
    });
    let frame = Buffer.alloc(600 * 1024, 1);
    for (let index = 0; index < 10; index++) {
      streamer.addMedia({
        type: 'video',
        data: frame,
        timestamp: 100000 + index,
        keyFrame: index === 0,
        codecConfig: { sps: Buffer.from([0x67, 1]), pps: Buffer.from([0x68, 2]) },
      });
    }
    context.mock.timers.tick(10);
    assert.equal(output.video.writableNeedDrain, true);
    let queued = output.video.writableLength;
    context.mock.timers.tick(100);
    assert.equal(output.video.writableLength, queued, 'a blocked output must not accumulate another frame each tick');
    let received = 0;
    output.video.on('data', () => {
      received++;
    });
    await setImmediate();
    context.mock.timers.tick(500);
    assert.ok(received > 0);
  });
}

for (let type of ['live', 'record']) {
  test(type + ' slow audio consumer stops accumulating until drain', async (context) => {
    context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
    let { streamer, transport } = setup(context);
    transport.video.codec = 'h264';
    transport.audio.codec = 'pcm';
    let output = await streamer.onMessage(type === 'live' ? Streamer.MESSAGE_TYPE.START_LIVE : Streamer.MESSAGE_TYPE.START_RECORD, {
      sessionID: 'slow-audio',
      options: { includeAudio: true },
    });
    output.video.on('data', () => {});
    streamer.addMedia({ type: 'video', data: Buffer.from([0, 0, 0, 1, 0x65]), timestamp: 100000, keyFrame: true });
    context.mock.timers.tick(20);
    for (let index = 0; index < 10; index++) {
      streamer.addMedia({ type: 'audio', data: Buffer.alloc(160 * 1024), timestamp: 100010 + index });
    }
    context.mock.timers.tick(10);
    assert.equal(output.audio.writableNeedDrain, true);
    let queued = output.audio.writableLength;
    context.mock.timers.tick(100);
    assert.equal(output.audio.writableLength, queued);
    output.audio.resume();
    await setImmediate();
    context.mock.timers.tick(500);
  });
}

test('fallback video and silence also respect blocked outputs', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context, { online: false });
  transport.video.codec = 'h264';
  transport.audio.blank = Buffer.alloc(160 * 1024);
  let output = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'slow-fallback', options: { includeAudio: true } });
  context.mock.timers.tick(2000);
  assert.equal(output.audio.writableNeedDrain, true);
  let queuedVideo = output.video.writableLength;
  let queuedAudio = output.audio.writableLength;
  context.mock.timers.tick(2000);
  assert.equal(output.video.writableLength, queuedVideo);
  assert.equal(output.audio.writableLength, queuedAudio);
});

test('one blocked live viewer does not stop the other viewer or its audio', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context);
  transport.video.codec = 'h264';
  transport.audio.codec = 'pcm';
  let slow = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'blocked', options: { includeAudio: true } });
  let fast = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'healthy', options: { includeAudio: true } });
  let videoWrites = 0;
  let audioWrites = 0;
  fast.video.on('data', () => {
    videoWrites++;
  });
  fast.audio.on('data', () => {
    audioWrites++;
  });
  slow.audio.resume();
  for (let index = 0; index < 5; index++) {
    streamer.addMedia({ type: 'video', data: Buffer.alloc(600 * 1024), timestamp: 100000 + index * 33, keyFrame: index === 0 });
    streamer.addMedia({ type: 'audio', data: Buffer.from([index]), timestamp: 100000 + index * 33 });
  }
  context.mock.timers.tick(500);
  assert.equal(slow.video.writableNeedDrain, true);
  assert.equal(slow.video.writableLength, 600 * 1024);
  assert.equal(videoWrites, 5);
  assert.equal(audioWrites, 5);
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
    assert.equal(typeof output.video.write, 'function');
    assert.equal(streamer.isLiveStreaming(), true);
  });
}
test('recording can stop without a session ID and a mismatched stop preserves live output', async (context) => {
  let { streamer } = setup(context);
  let live = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'live' });
  let record = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'record' });
  await streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_RECORD, { sessionID: 'live' });
  assert.equal(live.video.writableEnded, false);
  assert.equal(record.video.writableEnded, false);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_RECORD, {});
  assert.equal(record.video.writableEnded, true);
  assert.equal(live.video.writableEnded, false);
});
for (let recordTime of [100000, 100100, 99999]) {
  test('recording selects retained media near record time ' + recordTime, async (context) => {
    context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
    let { streamer, transport } = setup(context);
    transport.video.codec = 'fixture';
    await streamer.onMessage(Streamer.MESSAGE_TYPE.START_BUFFER);
    for (let index = 0; index < 4; index++) {
      streamer.addMedia({ type: 'video', timestamp: 100000 + index * 100, data: Buffer.from([index]), keyFrame: true });
    }
    let record = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, { sessionID: 'retained', options: { recordTime } });
    let chunks = [];
    record.video.on('data', (chunk) => chunks.push(...chunk));
    context.mock.timers.tick(1000);
    assert.deepEqual(chunks, recordTime === 100100 ? [1, 2, 3] : [0, 1, 2, 3]);
  });
}
for (let type of ['video', 'audio']) {
  test('Streamer normalises repeated and backwards ' + type + ' source timestamps without losing output', async (context) => {
    context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
    let { streamer, transport } = setup(context);
    transport.video.codec = 'fixture';
    transport.audio.codec = 'pcm';
    transport.video.fps = 25;
    transport.audio.frameDuration = 20;
    let output = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'clock', options: { includeAudio: true } });
    let chunks = [];
    output[type].on('data', (chunk) => chunks.push(...chunk));
    for (let [index, timestamp] of [100000, 100000, 99900, 100120].entries()) {
      streamer.addMedia({ type, timestamp, data: Buffer.from([index]), keyFrame: true });
    }
    context.mock.timers.tick(1000);
    assert.deepEqual(chunks, [0, 1, 2, 3]);
  });
}

for (let type of ['live', 'record']) {
  test(type + ' audio follows its decoder-start policy and resumes with the first IDR', async (context) => {
    context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
    let { streamer, transport } = setup(context, {}, { supportDump: true });
    transport.video.codec = 'h264';
    transport.audio.codec = 'pcm';
    let output = await streamer.onMessage(type === 'live' ? Streamer.MESSAGE_TYPE.START_LIVE : Streamer.MESSAGE_TYPE.START_RECORD, {
      sessionID: 'audio-start',
      options: { includeAudio: true },
    });
    let chunks = [];
    output.video.resume();
    output.audio.on('data', (chunk) => chunks.push(...chunk));
    streamer.addMedia({ type: 'audio', timestamp: 100000, data: Buffer.from([1]) });
    context.mock.timers.tick(300);
    assert.deepEqual(chunks, type === 'live' ? [1] : []);
    streamer.addMedia({ type: 'video', timestamp: 100300, data: Buffer.from([0, 0, 0, 1, 0x65, 1]), keyFrame: true });
    context.mock.timers.tick(100);
    streamer.addMedia({ type: 'audio', timestamp: 100400, data: Buffer.from([2]) });
    context.mock.timers.tick(1000);
    assert.equal(chunks.at(-1), 2);
  });
}
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
  transport.video.codec = 'fixture';
  await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'overloaded' });
  let data = Buffer.alloc(600 * 1024, 1);
  for (let index = 0; index < 8300; index++) {
    streamer.addMedia({ type: 'video', timestamp: 100000 + index, data, keyFrame: true });
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /retained timeline is full/);
  await streamer.onMessage(Streamer.MESSAGE_TYPE.STOP_LIVE, { sessionID: 'overloaded' });
  assert.equal(info.find((entry) => entry[0].includes('"size"'))[1], 8192);
  assert.equal(info.find((entry) => entry[0].includes('"capacity"'))[1], 8192);
  assert.equal(info.find((entry) => entry[0].includes('"droppedItems"'))[1], 108);
});
test('source reconnect resets codec bootstrap while retaining output stream identity', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let { streamer, transport } = setup(context);
  transport.video.codec = 'h264';
  let output = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'recovery' });
  let chunks = [];
  output.video.on('data', (chunk) => chunks.push(chunk));
  let emit = (keyFrame, byte, timestamp) =>
    streamer.addMedia({ type: 'video', timestamp, data: Buffer.from([0, 0, 0, 1, keyFrame === true ? 0x65 : 0x41, byte]), keyFrame });
  emit(true, 1, 100000);
  context.mock.timers.tick(200);
  let before = chunks.length;
  transport.setState(StreamTransport.STATE.RECONNECTING);
  transport.setState(StreamTransport.STATE.READY);
  emit(false, 2, 100200);
  context.mock.timers.tick(200);
  assert.equal(chunks.length, before, 'old decoder readiness cannot admit the new session delta');
  emit(true, 3, 100400);
  context.mock.timers.tick(200);
  assert.equal(chunks.at(-1).at(-1), 3);
  assert.equal(output.video.writableEnded, false);
});

test('scheduler isolates repeated output failures and stops only the failing camera', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let errors = [];
  let warnings = [];
  let broken = setup(
    context,
    {},
    { log: { debug() {}, info() {}, success() {}, error: (...args) => errors.push(args), warn: (...args) => warnings.push(args) } },
  );
  let healthy = setup(context);
  broken.transport.video.codec = 'fixture';
  healthy.transport.video.codec = 'fixture';
  let badOutput = await broken.streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'broken' });
  let goodOutput = await healthy.streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'healthy' });
  context.mock.method(badOutput.video, 'write', () => {
    throw new Error('Fixture output pipe failure');
  });
  let received = [];
  goodOutput.video.on('data', (chunk) => received.push(...chunk));
  for (let flow of [broken, healthy]) {
    flow.streamer.addMedia({ type: 'video', timestamp: 100000, data: Buffer.from([1]), keyFrame: true });
  }
  context.mock.timers.tick(100);
  await setImmediate();
  assert.equal(errors.length, 5);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /unstable device/);
  assert.equal(broken.streamer.hasActiveStreams(), false);
  assert.equal(badOutput.video.writableEnded, true);
  assert.equal(broken.transport.calls.at(-1)[0], 'shutdown');
  assert.equal(healthy.streamer.isLiveStreaming(), true);
  assert.deepEqual(received, [1]);
  healthy.streamer.addMedia({ type: 'video', timestamp: 100100, data: Buffer.from([2]), keyFrame: true });
  context.mock.timers.tick(100);
  assert.deepEqual(received, [1, 2]);
});
test('successful output ticks reset the scheduler failure count between transient pipe failures', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
  let warnings = [];
  let { streamer, transport } = setup(
    context,
    {},
    { log: { debug() {}, info() {}, success() {}, error() {}, warn: (...args) => warnings.push(args) } },
  );
  transport.video.codec = 'fixture';
  let output = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'transient' });
  let received = [];
  let failNext = false;
  output.video.on('data', (chunk) => received.push(...chunk));
  let original = output.video.write;
  context.mock.method(output.video, 'write', function (...args) {
    if (failNext === true) {
      failNext = false;
      throw new Error('Fixture temporary pipe failure');
    }
    return original.apply(this, args);
  });
  for (let index = 0; index < 6; index++) {
    failNext = true;
    streamer.addMedia({ type: 'video', timestamp: 100000 + index * 100, data: Buffer.from([index]), keyFrame: true });
    context.mock.timers.tick(100);
  }
  assert.deepEqual(received, [0, 1, 2, 3, 4, 5]);
  assert.equal(streamer.isLiveStreaming(), true);
  assert.deepEqual(warnings, []);
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

for (let config of ['both', 'SPS', 'PPS']) {
  test('decoder bootstrap avoids duplicating parameter sets already carried by a keyframe: ' + config, async (context) => {
    context.mock.timers.enable({ apis: ['Date', 'setInterval', 'setTimeout'], now: 100000 });
    let { streamer, transport } = setup(context);
    transport.video.codec = 'h264';
    let output = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'parameter-sets' });
    let chunks = [];
    output.video.on('data', (chunk) => chunks.push(chunk));
    let sps = Buffer.from([0x67, 1]);
    let pps = Buffer.from([0x68, 2]);
    let prefix = Buffer.from([0, 0, 0, 1]);
    let hasSPS = config !== 'PPS';
    let hasPPS = config !== 'SPS';
    let idr = Buffer.from([0x65, 3]);
    let accessUnit = Buffer.concat([...(hasSPS === true ? [prefix, sps] : []), ...(hasPPS === true ? [prefix, pps] : []), prefix, idr]);
    streamer.addMedia({ type: 'video', timestamp: 100000, keyFrame: true, data: accessUnit, codecConfig: { sps, pps, hasSPS, hasPPS } });
    context.mock.timers.tick(300);
    let expected = Buffer.concat([...(hasSPS === false ? [prefix, sps] : []), ...(hasPPS === false ? [prefix, pps] : []), accessUnit]);
    assert.deepEqual(Buffer.concat(chunks), expected);
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
    transport.video.codec = 'fixture';
    transport.audio.codec = 'pcm';
    let output = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_LIVE, { sessionID: 'gaps', options: { includeAudio: true } });
    output.video.resume();
    output.audio.resume();
    for (let index = 0; index < 5; index++) {
      streamer.addMedia({ type: 'audio', timestamp: 100000 + index * 200, data: Buffer.from([index]) });
      context.mock.timers.tick(200);
    }
    for (let kind of ['source audio gap', 'output audio write gap']) {
      assert.equal(logs.filter((entry) => entry[0].includes(kind)).length, diagnostics === true ? 1 : 0);
    }
  });
}
