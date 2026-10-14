// Verify camera cleanup uses managed FFmpeg completion without Homebridge, media backends or network sockets.
// Code version 2026.10.14
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import child_process from 'node:child_process';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { URL } from 'node:url';
import FFmpeg from '../../src/ffmpeg.js';
import { processConfig } from '../../src/config.js';
import { DATA_SOURCE } from '../../src/consts.js';

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
  '../streamer.js': streamModule,
  '../nexustalk.js': 'data:text/javascript,export default class {}',
  '../webrtc.js': 'data:text/javascript,export default class {}',
};
let location = new URL('../../src/plugins/camera.js', import.meta.url);
let source = await readFile(location, 'utf8');
source = source.replace(/from '([^']+)'/g, (match, specifier) => {
  let target = replacements[specifier] ?? (specifier.startsWith('.') === true ? new URL(specifier, location).href : specifier);
  return 'from ' + JSON.stringify(target);
});
let { default: Camera, processRawData } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

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
        let config = processConfig(
          { options: { maxStreams, hksv }, devices: [{ serialNumber: 'CAMERA', hksv }] },
          log,
          {},
        );
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
  t.mock.method(dgram, 'createSocket', () => {
    let socket = new EventEmitter();
    let reserved = port++;
    socket.bind = (options, callback) => callback?.();
    socket.address = () => ({ port: reserved });
    socket.close = (callback) => callback?.();
    return socket;
  });
  let camera = new Camera(
    undefined,
    {
      hap: {
        StreamRequestTypes: { START: 'start', STOP: 'stop' },
        CameraController: { generateSynchronisationSource: () => 42 },
        SRTPCryptoSuites: ['AES_CM_128_HMAC_SHA1_80'],
        H264Profile: { HIGH: 2, MAIN: 1 },
        H264Level: { LEVEL4_0: 2, LEVEL3_2: 1 },
        HDSProtocolSpecificErrorReason: { NORMAL: 0 },
      },
    },
    { serialNumber: 'camera', description: 'Camera', audio_enabled: false, ffmpeg: {} },
  );
  camera.ffmpeg = new FFmpeg('ffmpeg');
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
  return { camera, processes, prepare, start, video };
}

test('camera cleans up live source and HomeKit on failed FFmpeg spawn', async (t) => {
  let { camera, processes, prepare, start } = setup(t);
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
  assert.deepEqual(camera.ffmpeg.listSessions(), []);
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
  let { camera, processes, prepare, start } = setup(t);
  await camera.prepareStream(prepare, () => {});
  await camera.handleStreamRequest(start, () => {});
  await camera.handleStreamRequest({ sessionID: 'one', type: 'stop' }, () => {});
  await camera.prepareStream(prepare, () => {});
  await camera.handleStreamRequest(start, () => {});
  processes[0].emit('exit', null, 'SIGKILL');
  processes[0].emit('close', null, 'SIGKILL');
  await setImmediate();
  assert.equal(camera.ffmpeg.hasSession(camera.uuid, 'one', 'live'), true);
  assert.equal(processes[1].kill.mock.callCount(), 0);
  assert.equal(camera.controller.forceStopStreamingSession.mock.callCount(), 1);
  assert.equal(camera.log.error.mock.callCount(), 0);
});

test('recording startup failure releases source output that becomes ready after completion', async (t) => {
  let { camera, processes, video } = setup(t);
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
  assert.deepEqual(camera.ffmpeg.listSessions(), []);
});

test('replacement created during failure cleanup survives the awaited source shutdown', async (t) => {
  let { camera, processes, prepare, start, video } = setup(t);
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
  assert.equal(camera.ffmpeg.hasSession(camera.uuid, 'one', 'live'), true);
  assert.equal(processes[1].kill.mock.callCount(), 0);
  assert.equal(camera.controller.forceStopStreamingSession.mock.callCount(), 0);
});

test('camera shutdown waits for its FFmpeg process to close', async (t) => {
  let { camera, processes, prepare, start } = setup(t);
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
  assert.deepEqual(camera.ffmpeg.listSessions(), []);
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
