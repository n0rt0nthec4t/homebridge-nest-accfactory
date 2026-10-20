// Verify camera cleanup uses managed FFmpeg completion without Homebridge, media backends or network sockets.
// Code version 2026.10.20
import assert from 'node:assert/strict';
import { importSource } from './helpers/import-source.js';
import { Buffer } from 'node:buffer';
import child_process from 'node:child_process';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { URL } from 'node:url';
import FFmpeg from '../src/plugins/camera/ffmpeg.js';
import { processConfig } from '../src/config.js';
import { DATA_SOURCE } from '../src/consts.js';

// Replace runtime boundaries while exercising the complete camera implementation and real FFmpeg manager.
let baseModule =
  'data:text/javascript,' +
  encodeURIComponent(
    'import { EventEmitter } from "node:events"; export default class extends EventEmitter {' +
      'constructor(accessory, api, data) { super(); this.hap = api.hap; this.deviceData = data; this.uuid = data.serialNumber; }' +
      'addTimer() {} removeTimer() {} static makeValidHKName(name) { return name; } }',
  );
let streamModule =
  'data:text/javascript,' +
  encodeURIComponent(
    'export default class { static MESSAGE = "streamer"; ' +
      'static MESSAGE_TYPE = { START_LIVE: "start_live", STOP_LIVE: "stop_live",' +
      'START_RECORD: "start_record", STOP_RECORD: "stop_record" };' +
      'static CODEC_TYPE = { PCM: "pcm", AAC: "aac", SPEEX: "speex", OPUS: "opus" }; }',
  );
let replacements = {
  '../HomeKitDevice.js': baseModule,
  './camera/streamer.js': streamModule,
  './camera/nexustalk.js': 'data:text/javascript,export default class {}',
  './camera/webrtc.js': 'data:text/javascript,export default class {}',
};
let location = new URL('../src/plugins/camera.js', import.meta.url);
let source = await readFile(location, 'utf8');
source = source.replace(/from '([^']+)'/g, (match, specifier) => {
  let target = replacements[specifier] ?? (specifier.startsWith('.') === true ? new URL(specifier, location).href : specifier);
  return 'from ' + JSON.stringify(target);
});
let { default: Camera, processRawData } = await importSource(location, source);

test('Nest and Google cameras default to two live viewers and forward configured counts independently of HKSV', (t) => {
  t.mock.method(child_process, 'spawnSync', () => ({ error: new Error('Mock probe') }));
  let log = { warn() {}, info() {}, debug() {} };
  let hap = { H264Profile: {}, H264Level: {}, VideoCodecType: { H264: 0 }, SRTPCryptoSuites: { NONE: 0 } };
  for (let source of [DATA_SOURCE.NEST, DATA_SOURCE.GOOGLE]) {
    let resource = source === DATA_SOURCE.NEST ? 'quartz.camera' : 'DEVICE_CAMERA';
    let value =
      source === DATA_SOURCE.NEST
        ? {
            serial_number: 'CAMERA',
            structure_id: 'home',
            model: 'Nest Cam',
            software_version: '1.0.0',
            description: 'Camera',
            streaming_state: 'enabled',
            audio_input_enabled: false,
            capabilities: [],
            nexus_api_http_server_url: 'https://camera.invalid',
            properties: { 'cc2migration.overview_state': 'NORMAL' },
          }
        : {
            device_identity: { serialNumber: 'CAMERA', softwareVersion: '1.0.0' },
            device_info: { typeName: 'google.resource.SpencerResource', pairerId: { resourceId: 'STRUCTURE_HOME' } },
            configuration_done: { deviceReady: true },
            streaming_protocol: { supportedProtocols: ['PROTOCOL_WEBRTC'] },
            label: { label: 'Camera' },
            microphone_settings: {},
            speaker_volume: {},
            observation_trigger_capabilities: {},
            liveness: {},
            recording_toggle: {},
          };
    let raw = { [resource]: { source, value }, 'where.home': { value: { wheres: [] } }, STRUCTURE_HOME: { value: {} } };
    let changed = new Map([[resource, { fields: new Set(Object.keys(value)) }]]);
    for (let maxStreams of [undefined, 1, 2, 3, 4]) {
      for (let hksv of [false, true]) {
        let config = processConfig({ options: { maxStreams, hksv }, devices: [{ serialNumber: 'CAMERA', hksv }] }, log, {});
        let result = processRawData(log, raw, config, undefined, changed).CAMERA;
        assert.equal(result?.full, true, source + ' fixture must produce a complete camera');
        assert.equal(result.data.maxStreams, maxStreams ?? 2);
        let camera = new Camera(undefined, { hap }, result.data);
        assert.equal(camera.generateControllerOptions().cameraStreamCount, maxStreams ?? 2);
      }
    }
  }
});

function setup(t) {
  t.mock.method(child_process, 'spawnSync', () => ({ error: new Error('Mock probe') }));
  let processes = [];
  t.mock.method(child_process, 'spawn', (binary, args, options) => {
    let child = new EventEmitter();
    child.args = args;
    child.stdio = options.stdio.map(() => new PassThrough());
    [child.stdin, child.stdout, child.stderr] = child.stdio;
    child.kill = t.mock.fn(() => true);
    processes.push(child);
    return child;
  });
  let port = 10000;
  let sockets = [];
  t.mock.method(dgram, 'createSocket', () => {
    let socket = new EventEmitter();
    let reserved = port++;
    socket.bind = (options, callback) => callback?.();
    socket.address = () => ({ port: reserved });
    socket.close = t.mock.fn((callback) => callback?.());
    socket.send = t.mock.fn();
    sockets.push(socket);
    return socket;
  });
  let camera = new Camera(
    undefined,
    {
      hap: {
        Characteristic: { MotionDetected: 'motion' },
        StreamRequestTypes: { START: 'start', STOP: 'stop', RECONFIGURE: 'reconfigure' },
        CameraController: { generateSynchronisationSource: () => 42 },
        SRTPCryptoSuites: ['AES_CM_128_HMAC_SHA1_80'],
        H264Profile: { HIGH: 2, MAIN: 1 },
        H264Level: { LEVEL4_0: 2, LEVEL3_2: 1 },
        HDSProtocolSpecificErrorReason: { NORMAL: 0 },
      },
    },
    { serialNumber: 'camera', description: 'Camera', audio_enabled: false, ffmpeg: { binary: 'ffmpeg', valid: true } },
  );
  let handles = [];
  t.mock.method(camera.ffmpeg, 'start', (options) => {
    let handle = FFmpeg.prototype.start.call(camera.ffmpeg, options);
    handles.push(handle);
    return handle;
  });
  camera.streamer = { codecs: {} };
  camera.controller = { forceStopStreamingSession: t.mock.fn() };
  camera.log = { error: t.mock.fn() };
  let video = new PassThrough();
  camera.message = t.mock.fn(async () => ({ video }));
  let crypto = { port: 1234, srtpCryptoSuite: 0, srtp_key: Buffer.alloc(16), srtp_salt: Buffer.alloc(14) };
  let prepare = {
    sessionID: 'one',
    targetAddress: '127.0.0.1',
    sourceAddress: '127.0.0.1',
    addressVersion: 'ipv4',
    video: crypto,
    audio: crypto,
  };
  let start = { sessionID: 'one', type: 'start', video: { pt: 99, mtu: 1378 }, audio: {} };
  t.after(() => {
    for (let child of processes) {
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
    }
  });
  return { camera, processes, handles, prepare, start, video, sockets };
}

test('camera cleans up live source and HomeKit on failed FFmpeg spawn', async (t) => {
  let { camera, handles, processes, prepare, start } = setup(t);
  await camera.prepareStream(prepare, () => {});
  await camera.handleStreamRequest(start, () => {});
  processes[0].emit('error', new Error('ENOENT'));
  processes[0].emit('close', -2, null);
  await setImmediate();
  assert.equal(
    camera.message.mock.calls.some((call) => call.arguments[1] === 'stop_live'),
    true,
  );
  assert.equal(camera.controller.forceStopStreamingSession.mock.callCount(), 1);
  await Promise.all(handles.map((handle) => handle.finished));
  assert.equal(
    handles.every((handle) => handle.active === false),
    true,
  );
  assert.equal(
    camera.log.error.mock.calls.some((call) => call.arguments.includes('ENOENT')),
    true,
  );
});

test('an unrequested successful live process exit also releases camera resources', async (t) => {
  let { camera, processes, prepare, start } = setup(t);
  await camera.prepareStream(prepare, () => {});
  await camera.handleStreamRequest(start, () => {});
  processes[0].emit('exit', 0, null);
  processes[0].emit('close', 0, null);
  await setImmediate();
  assert.equal(camera.controller.forceStopStreamingSession.mock.callCount(), 1);
  assert.equal(
    camera.message.mock.calls.some((call) => call.arguments[1] === 'stop_live'),
    true,
  );
});

test('late completion after requested stop cannot tear down a replacement live session', async (t) => {
  let { camera, handles, processes, prepare, start } = setup(t);
  await camera.prepareStream(prepare, () => {});
  await camera.handleStreamRequest(start, () => {});
  await camera.handleStreamRequest({ sessionID: 'one', type: 'stop' }, () => {});
  await camera.prepareStream(prepare, () => {});
  await camera.handleStreamRequest(start, () => {});
  processes[0].emit('exit', null, 'SIGKILL');
  processes[0].emit('close', null, 'SIGKILL');
  await setImmediate();
  assert.equal(handles.at(-1).active, true);
  assert.equal(processes[1].kill.mock.callCount(), 0);
  assert.equal(camera.controller.forceStopStreamingSession.mock.callCount(), 1);
  assert.equal(camera.log.error.mock.callCount(), 0);
});

test('recording startup failure releases source output that becomes ready after completion', async (t) => {
  let { camera, handles, processes, video } = setup(t);
  camera.updateRecordingConfiguration({
    videoCodec: {
      parameters: { profile: 0, level: 0, iFrameInterval: 4000, bitRate: 2000 },
      resolution: [1280, 720, 30],
    },
  });
  let ready = Promise.withResolvers();
  camera.message = t.mock.fn((type, message) => (message === 'start_record' ? ready.promise : Promise.resolve()));
  let next = camera.handleRecordingStreamRequest('recording').next();
  processes[0].emit('error', new Error('ENOENT'));
  processes[0].emit('close', -2, null);
  ready.resolve({ video });
  assert.equal((await next).done, true);
  assert.equal(
    camera.message.mock.calls.some((call) => call.arguments[1] === 'stop_record'),
    true,
  );
  await Promise.all(handles.map((handle) => handle.finished));
  assert.equal(
    handles.every((handle) => handle.active === false),
    true,
  );
});

test('replacement created during failure cleanup survives the awaited source shutdown', async (t) => {
  let { camera, handles, processes, prepare, start, video } = setup(t);
  await camera.prepareStream(prepare, () => {});
  await camera.handleStreamRequest(start, () => {});
  let stopped = Promise.withResolvers();
  camera.message = t.mock.fn((type, message) => (message === 'stop_live' ? stopped.promise : Promise.resolve({ video })));
  processes[0].emit('exit', 1, null);
  processes[0].emit('close', 1, null);
  await camera.prepareStream(prepare, () => {});
  await camera.handleStreamRequest(start, () => {});
  stopped.resolve();
  await setImmediate();
  assert.equal(handles.at(-1).active, true);
  assert.equal(processes[1].kill.mock.callCount(), 0);
  assert.equal(camera.controller.forceStopStreamingSession.mock.callCount(), 0);
});

test('camera shutdown waits for its FFmpeg process to close', async (t) => {
  let { camera, handles, processes, prepare, start } = setup(t);
  camera.streamer.stopEverything = async () => {};
  await camera.prepareStream(prepare, () => {});
  await camera.handleStreamRequest(start, () => {});
  let settled = false;
  let shutdown = camera.onShutdown().then(() => {
    settled = true;
  });
  await setImmediate();
  assert.equal(settled, false);
  processes[0].emit('exit', null, 'SIGKILL');
  processes[0].emit('close', null, 'SIGKILL');
  await shutdown;
  assert.equal(settled, true);
  await Promise.all(handles.map((handle) => handle.finished));
  assert.equal(
    handles.every((handle) => handle.active === false),
    true,
  );
});

// Exercise both command builders with the same validated encoder options; keep media and process boundaries mocked.
for (let codec of ['libx264', 'h264_nvenc', 'h264_qsv', 'h264_vaapi', 'h264_v4l2m2m', 'h264_videotoolbox']) {
  test('live and HKSV encoding arguments match validated ' + codec + ' settings', async (t) => {
    let { camera, processes, prepare, start } = setup(t);
    let encoding = {
      codec,
      inputArguments:
        codec === 'h264_vaapi'
          ? ['-vaapi_device', '/dev/dri/renderD129']
          : codec === 'h264_qsv'
            ? ['-qsv_device', '/dev/dri/renderD129']
            : [],
      filter: codec === 'h264_vaapi' ? 'format=nv12,hwupload' : codec === 'h264_qsv' ? 'format=nv12' : 'format=yuv420p',
      preset: codec === 'h264_nvenc' ? 'p4' : ['libx264', 'h264_qsv'].includes(codec) === true ? 'veryfast' : undefined,
    };
    t.mock.method(camera.ffmpeg, 'getH264EncoderOptions', () => encoding);
    camera.deviceData.ffmpeg = { hwaccel: true, transcode: true };
    start.video = { ...start.video, profile: 1, level: 1, max_bit_rate: 2000 };
    await camera.prepareStream(prepare, () => {});
    await camera.handleStreamRequest(start, () => {});
    camera.updateRecordingConfiguration({
      videoCodec: { parameters: { profile: 1, level: 1, iFrameInterval: 4000, bitRate: 2000 }, resolution: [1280, 720, 30] },
    });
    let recording = camera.handleRecordingStreamRequest('recording');
    let pending = recording.next();
    await setImmediate();
    for (let [index, child] of processes.entries()) {
      let args = child.args;
      assert.equal(args[args.indexOf('-codec:v') + 1], codec);
      assert.equal(args[args.indexOf('-filter:v') + 1], (index === 0 ? '' : 'fps=fps=30,') + encoding.filter);
      if (encoding.inputArguments.length > 0) {
        let position = args.indexOf(encoding.inputArguments[0]);
        assert.ok(position >= 0 && position < args.indexOf('-i'));
        assert.equal(args[position + 1], '/dev/dri/renderD129');
      }
      if (encoding.preset !== undefined) {
        assert.equal(args[args.indexOf('-preset') + 1], encoding.preset);
      } else {
        assert.equal(args.includes('-preset'), false);
      }
      assert.equal(args[args.indexOf('-profile:v') + 1], codec === 'h264_v4l2m2m' ? '77' : 'main');
    }
    assert.equal(processes.length, 2);
    await camera.closeRecordingStream('recording');
    assert.equal((await pending).done, true);
  });
}

for (let codec of ['opus', 'speex']) {
  test('camera talkback ' + codec + ' routes RTP/RTCP and wires encoded audio through managed processes', async (context) => {
    let { camera, handles, processes, sockets, prepare, start, video } = setup(context);
    camera.deviceData.audio_enabled = true;
    camera.deviceData.has_speaker = true;
    camera.deviceData.has_microphone = true;
    camera.streamer.codecs = { audio: 'aac', talkback: codec };
    camera.hap.AudioStreamingCodecType = { AAC_ELD: 'aac', OPUS: 'opus' };
    context.mock.method(camera.ffmpeg, 'supportsEncoder', () => true);
    let audio = new PassThrough();
    let talkback = new PassThrough();
    camera.message = context.mock.fn(async () => ({ video, audio, talkback }));
    start.audio = { pt: 110, codec: 'aac', max_bit_rate: 24, packet_time: 20, sample_rate: 16, channel: 1 };
    await camera.prepareStream(prepare, () => {});
    await camera.handleStreamRequest(start, () => {});
    assert.equal(processes.length, 2);
    assert.equal(processes[1].args.includes(codec === 'opus' ? 'libopus' : 'libspeex'), true);
    let talkbackArgs = processes[1].args;
    let timeoutOption = talkbackArgs.indexOf('-listen_timeout');
    assert.ok(timeoutOption > talkbackArgs.indexOf('sdp') && timeoutOption < talkbackArgs.indexOf('-i'));
    assert.equal(talkbackArgs[timeoutOption + 1], '0');
    assert.equal(processes[0].args.includes('-listen_timeout'), false);
    let splitter = sockets.find((socket) => socket.listenerCount('message') > 0 && socket !== sockets.at(-1));
    assert.notEqual(splitter, undefined);
    splitter.emit('message', Buffer.alloc(0));
    splitter.emit('message', Buffer.from([0, 110]));
    assert.equal(splitter.send.mock.callCount(), 0);
    splitter.emit('message', Buffer.from([0x80, 110]));
    assert.equal(splitter.send.mock.callCount(), 1);
    splitter.emit('message', Buffer.from([0x80, 200]));
    assert.equal(splitter.send.mock.callCount(), 3);
    splitter.emit('message', Buffer.from([0x80, 50]));
    assert.equal(splitter.send.mock.callCount(), 5);
    let received = [];
    talkback.on('data', (data) => received.push(data));
    processes[1].stdout.write(Buffer.from([1, 2, 3]));
    assert.deepEqual(received, [Buffer.from([1, 2, 3])]);
    splitter.emit('error', new Error('Fixture splitter failure'));
    assert.equal(splitter.close.mock.callCount(), 1);
    await camera.handleStreamRequest({ sessionID: 'one', type: 'stop' });
    assert.equal(handles.at(-1).active, false);
    assert.deepEqual(processes[1].kill.mock.calls[0].arguments, ['SIGKILL']);
  });
}

test('camera RTCP feedback resets its watchdog and expiry follows the normal stop path', async (context) => {
  let { camera, sockets, prepare, start } = setup(context);
  let timers = [];
  camera.addTimer = (...args) => timers.push(args);
  await camera.prepareStream(prepare, () => {});
  await camera.handleStreamRequest(start);
  assert.equal(timers.at(-1)[0], 'live-rtcp-one');
  assert.equal(timers.at(-1)[1].delay, 30000);
  let socket = sockets.at(-1);
  socket.emit('message', Buffer.alloc(0));
  socket.emit('message', Buffer.from([0, 200, 0, 0]));
  assert.equal(timers.length, 1);
  socket.emit('message', Buffer.from([0x80, 201, 0, 0]));
  assert.equal(timers.at(-1)[1].reset, true);
  assert.equal(timers.at(-1)[1].delay, 10000);
  socket.emit('error', new Error('Fixture RTCP listener failure'));
  await camera.handleStreamRequest({ sessionID: 'one', type: 'reconfigure' });
  await camera.onTimer({ timer: 'live-rtcp-one', sessionID: 'one' });
  assert.equal(camera.controller.forceStopStreamingSession.mock.callCount(), 1);
});

function mp4Box(type, payload = Buffer.alloc(0)) {
  let header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8);
  header.write(type, 4);
  return Buffer.concat([header, payload]);
}
test('HKSV yields fragmented MP4 initialisation before media and stops a waiting generator on close', async (context) => {
  let { camera, handles, processes } = setup(context);
  camera.updateRecordingConfiguration({
    videoCodec: {
      parameters: { profile: 0, level: 0, iFrameInterval: 4000, bitRate: 2000 },
      resolution: [1280, 720, 30],
    },
  });
  let recording = camera.handleRecordingStreamRequest('clip');
  let initial = recording.next();
  await setImmediate();
  let init = Buffer.concat([mp4Box('ftyp', Buffer.from([1])), mp4Box('moov', Buffer.from([2]))]);
  processes[0].stdout.write(init.subarray(0, 3));
  processes[0].stdout.write(init.subarray(3));
  assert.deepEqual((await initial).value, { data: init, isLast: false });
  let next = recording.next();
  let media = Buffer.concat([mp4Box('moof', Buffer.from([3])), mp4Box('mdat', Buffer.from([4, 5]))]);
  processes[0].stdout.write(media);
  assert.deepEqual((await next).value, { data: media, isLast: false });
  let pending = recording.next();
  await camera.closeRecordingStream('clip', camera.hap.HDSProtocolSpecificErrorReason.NORMAL);
  assert.equal((await pending).done, true);
  assert.equal(handles[0].active, false);
  processes[0].emit('exit', 0, null);
  processes[0].emit('close', 0, null);
  await Promise.all(handles.map((handle) => handle.finished));
  assert.equal(
    handles.every((handle) => handle.active === false),
    true,
  );
});
for (let unavailable of ['ffmpeg', 'source', 'configuration', 'motion']) {
  test('HKSV declines recording without ' + unavailable, async (context) => {
    let { camera, processes } = setup(context);
    if (unavailable === 'ffmpeg') {
      camera.ffmpeg = undefined;
    }
    if (unavailable === 'source') {
      camera.streamer = undefined;
    }
    if (unavailable === 'motion') {
      camera.motionService = { getCharacteristic: () => ({ value: false }) };
    }
    assert.equal((await camera.handleRecordingStreamRequest('unavailable').next()).done, true);
    assert.equal(processes.length, 0);
  });
}

for (let action of ['stop', 'replace']) {
  test('live source completing after ' + action + ' cannot start an obsolete FFmpeg process', async (context) => {
    let { camera, handles, processes, prepare, start, video } = setup(context);
    await camera.prepareStream(prepare, () => {});
    let ready = Promise.withResolvers();
    camera.message = context.mock.fn((type, message) => (message === 'start_live' ? ready.promise : Promise.resolve()));
    let callback = context.mock.fn();
    let starting = camera.handleStreamRequest(start, callback);
    if (action === 'stop') {
      await camera.handleStreamRequest({ sessionID: 'one', type: 'stop' });
    } else {
      await camera.prepareStream(prepare, () => {});
    }
    let stops = camera.message.mock.calls.filter((call) => call.arguments[1] === 'stop_live').length;
    ready.resolve({ video });
    await starting;
    assert.equal(processes.length, 0);
    assert.equal(callback.mock.callCount(), 1);
    assert.equal(
      camera.message.mock.calls.filter((call) => call.arguments[1] === 'stop_live').length,
      stops + (action === 'stop' ? 1 : 0),
      'late startup releases only an output with no replacement owner',
    );
    if (action === 'replace') {
      camera.message = context.mock.fn(async () => ({ video }));
      await camera.handleStreamRequest(start);
      assert.equal(handles.at(-1).active, true);
    }
  });
}
for (let unavailable of ['streamer', 'ffmpeg', 'session']) {
  test('live startup without ' + unavailable + ' acknowledges without acquiring a source', async (context) => {
    let { camera, processes, prepare, start } = setup(context);
    if (unavailable !== 'session') {
      await camera.prepareStream(prepare, () => {});
    }
    if (unavailable === 'streamer') {
      camera.streamer = undefined;
    }
    if (unavailable === 'ffmpeg') {
      camera.ffmpeg = undefined;
    }
    let callback = context.mock.fn();
    await camera.handleStreamRequest(start, callback);
    assert.equal(callback.mock.callCount(), 1);
    assert.equal(camera.message.mock.callCount(), 0);
    assert.equal(processes.length, 0);
  });
}

for (let completion of ['error', 'exit', 'clean-exit']) {
  test('unexpected talkback ' + completion + ' releases the live source, peer process and sockets', async (context) => {
    let { camera, handles, processes, sockets, prepare, start, video } = setup(context);
    Object.assign(camera.deviceData, { audio_enabled: true, has_speaker: true, has_microphone: true });
    camera.streamer.codecs = { audio: 'aac', talkback: 'opus' };
    camera.hap.AudioStreamingCodecType = { AAC_ELD: 'aac', OPUS: 'opus' };
    context.mock.method(camera.ffmpeg, 'supportsEncoder', () => true);
    camera.message = context.mock.fn(async () => ({ video, audio: new PassThrough(), talkback: new PassThrough() }));
    start.audio = { pt: 110, codec: 'opus', max_bit_rate: 24, packet_time: 20, sample_rate: 24, channel: 1 };
    await camera.prepareStream(prepare, () => {});
    await camera.handleStreamRequest(start);
    processes[1].stderr.write('Fixture talkback final diagnostic\n');
    if (completion === 'error') {
      processes[1].emit('error', new Error('Fixture talkback failed'));
    } else {
      processes[1].emit('exit', completion === 'clean-exit' ? 0 : 1, null);
    }
    processes[1].emit('close', completion === 'clean-exit' ? 0 : 1, null);
    await setImmediate();
    assert.equal(
      camera.log.error.mock.calls.some(
        (call) => call.arguments[1] === 'talkback' && String(call.arguments.at(-1)).includes('Fixture talkback final diagnostic') === true,
      ),
      true,
    );
    assert.equal(camera.controller.forceStopStreamingSession.mock.callCount(), 1);
    assert.equal(camera.message.mock.calls.filter((call) => call.arguments[1] === 'stop_live').length, 1);
    assert.equal(processes[0].kill.mock.callCount(), 1);
    assert.equal(handles.at(-1).active, false);
    assert.equal(sockets.filter((socket) => socket.listenerCount('message') > 0).length, 0);
  });
}
test('replaced HKSV generators finish without following another process sharing their session key', async (context) => {
  let { camera, processes, video } = setup(context);
  camera.updateRecordingConfiguration({
    videoCodec: { parameters: { profile: 0, level: 0, iFrameInterval: 4000, bitRate: 2000 }, resolution: [1280, 720, 30] },
  });
  let recording = camera.handleRecordingStreamRequest('reused-clip');
  let waiting = recording.next();
  await setImmediate();
  let replacement = camera.ffmpeg.start({ id: 'record:reused-clip', args: [] });
  processes[1].emit('spawn');
  assert.equal(video.listenerCount('data'), 0);
  processes[0].emit('exit', null, 'SIGTERM');
  processes[0].emit('close', null, 'SIGTERM');
  assert.equal((await waiting).done, true);
  assert.equal(replacement.active, true);
  assert.equal(processes[1].kill.mock.callCount(), 0);
  processes[1].emit('exit', 0, null);
  processes[1].emit('close', 0, null);
  await replacement.finished;
});
test('unexpected HKSV completion wakes a waiting generator and releases the recording source', async (context) => {
  let { camera, handles, processes } = setup(context);
  camera.updateRecordingConfiguration({
    videoCodec: { parameters: { profile: 0, level: 0, iFrameInterval: 4000, bitRate: 2000 }, resolution: [1280, 720, 30] },
  });
  let recording = camera.handleRecordingStreamRequest('failed-clip');
  let waiting = recording.next();
  await setImmediate();
  processes[0].emit('exit', 1, null);
  processes[0].emit('close', 1, null);
  assert.equal((await waiting).done, true);
  assert.equal(camera.message.mock.calls.filter((call) => call.arguments[1] === 'stop_record').length, 1);
  await Promise.all(handles.map((handle) => handle.finished));
  assert.equal(
    handles.every((handle) => handle.active === false),
    true,
  );
});

test('HKSV input acquisition failure is terminated by FFmpeg without waiting for a HomeKit close', async (context) => {
  let { camera, processes, handles } = setup(context);
  camera.updateRecordingConfiguration({
    videoCodec: { parameters: { profile: 0, level: 0, iFrameInterval: 4000, bitRate: 2000 }, resolution: [1280, 720, 30] },
  });
  let error = new Error('Recording source failed');
  camera.message = context.mock.fn(async (type, message) => {
    if (message === 'start_record') {
      throw error;
    }
  });
  await assert.rejects(camera.handleRecordingStreamRequest('source-failure').next(), (caught) => caught === error);
  await setImmediate();
  assert.equal(handles[0].active, false);
  assert.equal(processes[0].kill.mock.callCount(), 1);
  processes[0].emit('exit', null, 'SIGKILL');
  processes[0].emit('close', null, 'SIGKILL');
  assert.equal((await handles[0].finished).expected, false);
  await setImmediate();
  assert.equal(camera.message.mock.calls.filter((call) => call.arguments[1] === 'stop_record').length, 1);
});

test('late recording completion cannot stop a replacement created during source teardown', async (context) => {
  let { camera, processes, handles, video } = setup(context);
  camera.updateRecordingConfiguration({
    videoCodec: { parameters: { profile: 0, level: 0, iFrameInterval: 4000, bitRate: 2000 }, resolution: [1280, 720, 30] },
  });
  let first = camera.handleRecordingStreamRequest('reused');
  let firstNext = first.next();
  await setImmediate();
  let stopping = Promise.withResolvers();
  camera.message = context.mock.fn((type, message) => (message === 'stop_record' ? stopping.promise : Promise.resolve({ video })));
  processes[0].emit('exit', 1, null);
  processes[0].emit('close', 1, null);
  assert.equal((await firstNext).done, true);
  let replacement = camera.handleRecordingStreamRequest('reused');
  let replacementNext = replacement.next();
  await setImmediate();
  stopping.resolve();
  await setImmediate();
  assert.equal(handles[1].active, true);
  assert.equal(processes[1].kill.mock.callCount(), 0);
  await camera.closeRecordingStream('reused', 0);
  assert.equal((await replacementNext).done, true);
  processes[1].emit('exit', null, 'SIGKILL');
  processes[1].emit('close', null, 'SIGKILL');
  await handles[1].finished;
});
