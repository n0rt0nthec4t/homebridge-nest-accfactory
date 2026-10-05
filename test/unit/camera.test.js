// Verify camera cleanup uses managed FFmpeg completion without Homebridge, media backends or network sockets.
// Code version 2026.10.05
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

// Replace runtime boundaries while exercising the complete camera implementation and real FFmpeg manager.
let baseModule =
  'data:text/javascript,' +
  encodeURIComponent(
    'import { EventEmitter } from "node:events"; export default class extends EventEmitter {' +
      'constructor(accessory, api, data) { super(); this.hap = api.hap; this.deviceData = data; this.uuid = data.serialNumber; }' +
      'addTimer() {} removeTimer() {} }',
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
let { default: Camera } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

function setup(t) {
  t.mock.method(child_process, 'spawnSync', () => ({ error: new Error('Mock probe') }));
  let processes = [];
  t.mock.method(child_process, 'spawn', (binary, args, options) => {
    let child = new EventEmitter();
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
