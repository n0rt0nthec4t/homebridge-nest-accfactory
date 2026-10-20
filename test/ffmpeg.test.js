// Verify FFmpeg hardware discovery, capability queries, diagnostics, and session lifecycle.
// Code version 2026.10.20
import assert from 'node:assert/strict';
import child_process from 'node:child_process';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import timers from 'node:timers';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import FFmpeg from '../src/plugins/camera/ffmpeg.js';

const spawnProcess = child_process.spawn;
const processes = new WeakMap();
const processFor = (handle) => processes.get(handle);

test('hardware selection requires encoded output and preserves Pi encoder-node discovery', async (t) => {
  let cases = [
    { name: 'encoder at video11 without video0', nodes: { video11: 'bcm2835-codec-encode' }, codec: 'h264_v4l2m2m' },
    { name: 'renumbered encoder', nodes: { video31: 'bcm2835-codec-encode' }, codec: 'h264_v4l2m2m' },
    { name: 'camera and decoder only', nodes: { video0: 'unicam', video10: 'bcm2835-codec-decode' } },
    { name: 'image encoder only', nodes: { video0: 'bcm2835-codec-encode_image' } },
    { name: 'encoder inaccessible', nodes: { video11: 'bcm2835-codec-encode' }, denied: true },
    { name: 'missing sysfs on Pi', nodes: {}, missingSysfs: true },
    { name: 'missing compiled encoder', nodes: { video11: 'bcm2835-codec-encode' }, compiled: false },
    { name: 'generic Linux encoder metadata', nodes: { video31: 'generic-encoder' }, model: 'Generic', codec: 'h264_v4l2m2m' },
    { name: 'generic camera is not encoder evidence', nodes: { video0: 'generic-camera' }, model: 'Generic' },
    { name: 'missing model still identifies an encoder', nodes: { video31: 'generic-encoder' }, model: null, codec: 'h264_v4l2m2m' },
    { name: 'Pi DRM never outranks the encoder', nodes: { video11: 'bcm2835-codec-encode' }, drm: true, codec: 'h264_v4l2m2m' },
    { name: 'Pi DRM alone does not enable acceleration', nodes: {}, drm: true },
    { name: 'generic DRM does not prove NVIDIA or QSV encoding', nodes: {}, drm: true, model: 'Generic', codec: 'h264_vaapi' },
    { name: 'NVIDIA driver produces encoded output', nodes: {}, drm: true, model: 'Generic', codec: 'h264_nvenc' },
    { name: 'driver encode failure keeps software available', nodes: { video11: 'bcm2835-codec-encode' }, failure: true },
  ];
  for (let scenario of cases) {
    await t.test(scenario.name, (t) => {
      t.mock.method(os, 'platform', () => 'linux');
      t.mock.method(fs, 'readFileSync', (file) => {
        if (file === '/sys/firmware/devicetree/base/model' && scenario.model !== null) {
          return scenario.model ?? 'Raspberry Pi 4 Model B';
        }
        let device = /^\/sys\/class\/video4linux\/(video\d+)\/name$/.exec(file)?.[1];
        if (device in scenario.nodes) {
          return scenario.nodes[device];
        }
        throw new Error('Missing metadata');
      });
      t.mock.method(fs, 'readdirSync', (file) => {
        if (file === '/dev/dri') {
          return scenario.drm === true ? ['card0', 'renderD129'] : [];
        }
        assert.equal(file, '/sys/class/video4linux');
        if (scenario.missingSysfs === true) {
          throw new Error('Missing sysfs');
        }
        return Object.keys(scenario.nodes);
      });
      t.mock.method(fs, 'accessSync', (file, mode) => {
        assert.equal(mode, fs.constants.R_OK | fs.constants.W_OK);
        if (scenario.denied === true || (file.startsWith('/dev/dri/') === false && !(file.slice(5) in scenario.nodes))) {
          throw new Error('Device unavailable');
        }
      });
      let probe = t.mock.method(child_process, 'spawnSync', (binary, args, options) => {
        if (args[0] === '-version') {
          return { status: 0, stdout: 'ffmpeg version 8.0 ' };
        }
        if (args[0] === '-encoders') {
          return {
            status: 0,
            stdout:
              ' V..... libx264' +
              (scenario.compiled === false
                ? ''
                : '\n V..... h264_v4l2m2m' + (scenario.drm === true ? '\n V..... h264_nvenc\n V..... h264_qsv\n V..... h264_vaapi' : '')),
          };
        }
        if (args.includes('-frames:v') === true) {
          assert.ok(options.timeout > 0 && options.timeout <= 2000);
          assert.equal(options.killSignal, 'SIGKILL');
          let codec = args[args.indexOf('-codec:v') + 1];
          return { status: scenario.failure === true || codec !== scenario.codec ? 1 : 0, stdout: Buffer.from([0, 0, 0, 1, 0x67]) };
        }
        return { status: 0, stdout: '' };
      });
      let binary = 'ffmpeg-' + scenario.name.replace(/ /g, '-');
      let ffmpeg = new FFmpeg(binary);
      assert.equal(ffmpeg.hardwareH264Codec, scenario.codec);
      assert.equal(ffmpeg.supportsHardwareH264, scenario.codec !== undefined);
      assert.equal(ffmpeg.features.hardwareH264Codec, scenario.codec);
      for (let codec of ['h264_nvenc', 'h264_qsv', 'h264_vaapi', 'h264_v4l2m2m', 'h264_videotoolbox']) {
        assert.equal(ffmpeg.features[codec], scenario.codec === codec);
      }
      assert.equal(ffmpeg.supportsEncoder('libx264'), true);
      assert.equal(ffmpeg.getH264EncoderOptions(false).codec, 'libx264');
      let original = ffmpeg.getH264EncoderOptions(true);
      let changed = ffmpeg.getH264EncoderOptions(true);
      changed.codec = 'changed';
      changed.filter = 'changed';
      changed.preset = 'changed';
      changed.inputArguments.push('changed');
      assert.deepEqual(ffmpeg.getH264EncoderOptions(true), original, 'Callers cannot mutate the selected configuration');
      if (scenario.codec === 'h264_vaapi') {
        let encoding = ffmpeg.getH264EncoderOptions(true);
        assert.deepEqual(encoding.inputArguments, ['-vaapi_device', '/dev/dri/renderD129']);
        assert.equal(encoding.filter, 'format=nv12,hwupload');
        encoding.inputArguments.push('mutated');
        assert.equal(ffmpeg.getH264EncoderOptions(true).inputArguments.length, 2);
      }
      if (scenario.codec === undefined) {
        assert.equal(ffmpeg.getH264EncoderOptions(true).codec, 'libx264');
      }
      let calls = probe.mock.callCount();
      let repeated = new FFmpeg(binary);
      assert.equal(repeated.hardwareH264Codec, scenario.codec);
      assert.deepEqual(repeated.getH264EncoderOptions(true), original, 'Returned options cannot mutate another camera manager');
      assert.equal(probe.mock.callCount(), calls + 5, 'Camera managers must reuse hardware validation');
    });
  }
});

for (let platform of ['darwin', 'win32']) {
  for (let outcome of ['success', 'driver failure', 'timeout', 'empty output']) {
    test(platform + ' hardware validation: ' + outcome, (t) => {
      t.mock.method(os, 'platform', () => platform);
      let codec = platform === 'darwin' ? 'h264_videotoolbox' : 'h264_qsv';
      t.mock.method(child_process, 'spawnSync', (binary, args) => {
        if (args[0] === '-version') {
          return { status: 0, stdout: 'ffmpeg version 8.0 ' };
        }
        if (args[0] === '-encoders') {
          return { status: 0, stdout: ' V..... libx264\n V..... ' + codec };
        }
        if (args.includes('-frames:v') === true) {
          return {
            status: outcome === 'driver failure' ? 1 : 0,
            error: outcome === 'timeout' ? new Error('ETIMEDOUT') : undefined,
            stdout: outcome === 'empty output' ? Buffer.alloc(0) : Buffer.from([0, 0, 0, 1, 0x67]),
          };
        }
        return { status: 0, stdout: '' };
      });
      let ffmpeg = new FFmpeg('ffmpeg-' + platform + '-' + outcome.replace(/ /g, '-'));
      assert.equal(ffmpeg.hardwareH264Codec, outcome === 'success' ? codec : undefined);
      assert.equal(ffmpeg.getH264EncoderOptions(true).codec, outcome === 'success' ? codec : 'libx264');
    });
  }
}

test('hardware validation cache is invalidated when the executable changes', (t) => {
  t.mock.method(os, 'platform', () => 'darwin');
  let revision = 1;
  t.mock.method(fs, 'statSync', () => ({ size: revision, mtimeMs: revision, ino: 1 }));
  let validations = 0;
  t.mock.method(child_process, 'spawnSync', (binary, args) => {
    if (args[0] === '-version') {
      return { status: 0, stdout: 'ffmpeg version 8.0 ' };
    }
    if (args[0] === '-encoders') {
      return { status: 0, stdout: ' V..... libx264\n V..... h264_videotoolbox' };
    }
    if (args.includes('-frames:v') === true) {
      validations++;
      return { status: revision === 1 ? 0 : 1, stdout: Buffer.from([0, 0, 0, 1, 0x67]) };
    }
    return { status: 0, stdout: '' };
  });
  assert.equal(new FFmpeg('ffmpeg-cache-revision').supportsHardwareH264, true);
  assert.equal(new FFmpeg('ffmpeg-cache-revision').supportsHardwareH264, true);
  assert.equal(validations, 1);
  revision = 2;
  assert.equal(new FFmpeg('ffmpeg-cache-revision').supportsHardwareH264, false);
  assert.equal(new FFmpeg('ffmpeg-cache-revision').getH264EncoderOptions(true).codec, 'libx264');
  assert.equal(validations, 2);
});

test('hardware validation stops at the total deadline and caches the software fallback', (t) => {
  t.mock.method(os, 'platform', () => 'linux');
  t.mock.method(fs, 'readFileSync', () => 'Generic');
  t.mock.method(fs, 'readdirSync', (file) => (file === '/dev/dri' ? ['renderD128'] : []));
  t.mock.method(fs, 'accessSync', () => {});
  let elapsed = 0;
  t.mock.method(Date, 'now', () => elapsed);
  let codecs = [];
  t.mock.method(child_process, 'spawnSync', (binary, args, options) => {
    if (args[0] === '-version') {
      return { status: 0, stdout: 'ffmpeg version 8.0 ' };
    }
    if (args[0] === '-encoders') {
      return { status: 0, stdout: ' V..... libx264\n V..... h264_nvenc\n V..... h264_qsv\n V..... h264_vaapi' };
    }
    if (args.includes('-frames:v') === true) {
      codecs.push(args[args.indexOf('-codec:v') + 1]);
      assert.equal(options.timeout, 2000);
      elapsed += options.timeout;
      return { status: null, error: new Error('ETIMEDOUT'), stdout: Buffer.alloc(0) };
    }
    return { status: 0, stdout: '' };
  });
  assert.equal(new FFmpeg('ffmpeg-total-deadline').supportsHardwareH264, false);
  assert.equal(new FFmpeg('ffmpeg-total-deadline').getH264EncoderOptions(true).codec, 'libx264');
  assert.deepEqual(codecs, ['h264_nvenc', 'h264_qsv']);
  assert.equal(elapsed, 4000);
});

// Mock binary probing and child processes so diagnostics tests do not depend on installed FFmpeg.
function createMockFFmpeg(t) {
  t.mock.method(child_process, 'spawnSync', (binary, args) => ({
    status: 0,
    stdout: {
      '-version': 'ffmpeg version 8.0 ',
      '-encoders': ' V..... libx264\n A..... libopus',
      '-decoders': ' A..... libspeex',
      '-muxers': ' E mp4\n E matroska,webm',
      '-demuxers': '',
    }[args[0]],
  }));
  let children = [];
  let spawn = t.mock.method(child_process, 'spawn', (binary, args, options) => {
    let child = new EventEmitter();
    child.stdio = options.stdio.map(() => new PassThrough());
    [child.stdin, child.stdout, child.stderr] = child.stdio;
    child.kill = t.mock.fn(() => true);
    children.push(child);
    return child;
  });
  let ffmpeg = new FFmpeg('ffmpeg');
  t.mock.method(ffmpeg, 'start', (options) => {
    let handle = FFmpeg.prototype.start.call(ffmpeg, options);
    processes.set(handle, spawn.mock.calls.at(-1).result);
    return handle;
  });
  return { ffmpeg, children, spawn };
}

test('capability queries distinguish encoders, decoders and muxers including format aliases', (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  assert.equal(ffmpeg.supportsEncoder('libx264'), true);
  assert.equal(ffmpeg.supportsEncoder('libspeex'), false);
  assert.equal(ffmpeg.supportsDecoder('libspeex'), true);
  assert.equal(ffmpeg.supportsDecoder('libx264'), false);
  for (let muxer of ['mp4', 'matroska', 'webm']) {
    assert.equal(ffmpeg.supportsMuxer(muxer), true);
    assert.equal(ffmpeg.hasMinimumSupport({ muxers: [muxer] }), true);
  }
  assert.equal(ffmpeg.hasMinimumSupport({ muxers: ['missing'] }), false);
  for (let name of ['missing', '', undefined]) {
    assert.equal(ffmpeg.supportsEncoder(name), false);
    assert.equal(ffmpeg.supportsDecoder(name), false);
    assert.equal(ffmpeg.supportsMuxer(name), false);
  }
});

test('capability queries return false when the binary probe fails', (t) => {
  t.mock.method(child_process, 'spawnSync', () => ({ error: new Error('Unavailable') }));
  let ffmpeg = new FFmpeg('ffmpeg');
  assert.equal(ffmpeg.supportsEncoder('libx264'), false);
  assert.equal(ffmpeg.supportsDecoder('libspeex'), false);
  assert.equal(ffmpeg.supportsMuxer('mp4'), false);
});

test('session diagnostics join split lines and UTF-8 while preserving raw callbacks', (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  let callback = t.mock.fn();
  let session = ffmpeg.start({ id: 'camera:one:live', args: ['-version'], onStderr: callback });
  let first = Buffer.from('  first\r\n\nsecond ');
  let unicode = Buffer.from('café');
  processFor(session).stderr.emit('data', first);
  processFor(session).stderr.emit('data', unicode.subarray(0, unicode.length - 1));
  processFor(session).stderr.emit('data', unicode.subarray(unicode.length - 1));
  assert.deepEqual(session.diagnosticLines, ['first', 'second café']);
  processFor(session).stderr.emit('data', Buffer.from('\nthird'));
  assert.deepEqual(session.diagnosticLines, ['first', 'second café', 'third']);
  session.diagnosticLines.push('external mutation');
  assert.deepEqual(session.diagnosticLines, ['first', 'second café', 'third']);
  assert.equal(callback.mock.calls[0].arguments[0], first);
  assert.equal(callback.mock.callCount(), 4);
});

test('session diagnostics retain only 20 lines and bound unterminated output', (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  let session = ffmpeg.start({ id: 'camera:one:default', args: [] });
  processFor(session).stderr.emit('data', Buffer.from(Array.from({ length: 100 }, (_, i) => 'line ' + i).join('\n')));
  assert.deepEqual(
    session.diagnosticLines,
    Array.from({ length: 20 }, (_, i) => 'line ' + (80 + i)),
  );
  processFor(session).stderr.emit('data', Buffer.from('\n' + 'x'.repeat(100000)));
  assert.deepEqual(session.diagnosticLines, ['x'.repeat(16384)]);
});

test('session diagnostics survive exit, remain isolated on replacement and drain trailing stderr', (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  let first = ffmpeg.start({ id: 'camera:one:live', args: [] });
  processFor(first).stderr.emit('data', Buffer.from('first failure\n'));
  let second = ffmpeg.start({ id: 'camera:one:live', args: [] });
  processFor(second).stderr.emit('data', Buffer.from('second session\n'));
  processFor(first).emit('exit', 1, null);
  processFor(first).emit('close', 1, null);
  assert.equal(second.active, true);
  assert.deepEqual(first.diagnosticLines, ['first failure']);
  assert.deepEqual(second.diagnosticLines, ['second session']);
  processFor(second).emit('exit', 1, null);
  assert.equal(second.active, false);
  processFor(second).stderr.emit('data', Buffer.from('final pipe output'));
  processFor(second).stderr.emit('end');
  processFor(second).emit('close', 1, null);
  assert.deepEqual(second.diagnosticLines, ['second session', 'final pipe output']);
  assert.deepEqual(first.diagnosticLines, ['first failure']);
});

test('startup failures are retained even when stderr is empty', (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  let callback = t.mock.fn();
  let session = ffmpeg.start({ id: 'camera:one:record', args: [], onStderr: callback });
  processFor(session).emit('error', new Error('ENOENT'));
  processFor(session).emit('close', -2, null);
  assert.equal(session.active, false);
  assert.deepEqual(session.diagnosticLines, ['Failed to start ffmpeg session "camera:one:record". Error was "ENOENT"']);
  assert.equal(callback.mock.calls[0].arguments[0], session.diagnosticLines[0]);
});

// Lifecycle assertions use process events and controlled timers instead of timing-sensitive sleeps.
test('session state and completion distinguish spawn, exit and fully drained pipes', async (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  let session = ffmpeg.start({ id: 'camera:one:default', args: [] });
  let complete = t.mock.fn();
  ffmpeg.once(FFmpeg.SESSION_EVENT.COMPLETE, complete);
  assert.equal(session.state, FFmpeg.SESSION_STATE.STARTING);
  processFor(session).emit('spawn');
  assert.equal(session.state, FFmpeg.SESSION_STATE.RUNNING);
  let settled = false;
  session.finished.then(() => {
    settled = true;
  });
  processFor(session).emit('exit', 0, null);
  await Promise.resolve();
  assert.equal(session.state, FFmpeg.SESSION_STATE.EXITED);
  assert.equal(settled, false);
  assert.equal(session.active, false);
  processFor(session).stderr.emit('data', Buffer.from('final diagnostics'));
  processFor(session).emit('close', 0, null);
  let result = await session.finished;
  assert.deepEqual(result, { state: 'exited', code: 0, signal: null, error: undefined, expected: false });
  assert.deepEqual(session.diagnosticLines, ['final diagnostics']);
  assert.equal(complete.mock.callCount(), 1);
  assert.equal(complete.mock.calls[0].arguments[0], session);
  assert.equal(complete.mock.calls[0].arguments[1], result);
  assert.deepEqual(await ffmpeg.shutdown(), []);
});

test('startup failure and unexpected termination report one failed completion', async (t) => {
  for (let startupFailure of [true, false]) {
    await t.test(startupFailure === true ? 'failed spawn' : 'unexpected signal', async (t) => {
      let { ffmpeg } = createMockFFmpeg(t);
      let session = ffmpeg.start({ id: 'camera:one:default', args: [] });
      let complete = t.mock.fn();
      ffmpeg.on(FFmpeg.SESSION_EVENT.COMPLETE, complete);
      let error = startupFailure === true ? new Error('ENOENT') : undefined;
      if (startupFailure === true) {
        processFor(session).emit('error', error);
      } else {
        processFor(session).emit('spawn');
        processFor(session).emit('exit', null, 'SIGKILL');
      }
      assert.equal(session.state, FFmpeg.SESSION_STATE.FAILED);
      assert.equal(complete.mock.callCount(), 0);
      processFor(session).emit('close', startupFailure === true ? -2 : null, startupFailure === true ? null : 'SIGKILL');
      let result = await session.finished;
      assert.equal(result.state, FFmpeg.SESSION_STATE.FAILED);
      assert.equal(result.error, error);
      assert.equal(result.expected, false);
      assert.equal(complete.mock.callCount(), 1);
      assert.deepEqual(await ffmpeg.shutdown(), []);
    });
  }
});

test('graceful shutdown escalates once and stays awaitable until close', async (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  let scheduled;
  t.mock.method(timers, 'setTimeout', (callback, delay) => {
    assert.equal(delay, 2000);
    scheduled = callback;
    return 123;
  });
  let clear = t.mock.method(timers, 'clearTimeout', () => {});
  let session = ffmpeg.start({ id: 'camera:one:default', args: [] });
  processFor(session).emit('spawn');
  let finished = session.stop();
  assert.equal(finished, session.finished);
  assert.equal(session.state, FFmpeg.SESSION_STATE.STOPPING);
  assert.equal(session.active, false);
  assert.equal(session.stop(), finished);
  assert.equal(processFor(session).kill.mock.callCount(), 1);
  scheduled();
  assert.deepEqual(
    processFor(session).kill.mock.calls.map((call) => call.arguments[0]),
    ['SIGTERM', 'SIGKILL'],
  );
  processFor(session).emit('exit', null, 'SIGKILL');
  processFor(session).emit('close', null, 'SIGKILL');
  assert.equal((await finished).expected, true);
  assert.equal(session.state, FFmpeg.SESSION_STATE.EXITED);
  assert.equal(session.stop(), finished);
  assert.equal(processFor(session).kill.mock.callCount(), 2);
  assert.equal(
    clear.mock.calls.some((call) => call.arguments[0] === 123),
    true,
  );
});

test('stop before spawn remains stopping and explicit SIGKILL cancels graceful escalation', async (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  t.mock.method(timers, 'setTimeout', () => 123);
  let clear = t.mock.method(timers, 'clearTimeout', () => {});
  let session = ffmpeg.start({ id: 'camera:one:default', args: [] });
  assert.throws(() => session.stop('SIGTERM', -1), RangeError);
  assert.equal(session.state, FFmpeg.SESSION_STATE.STARTING);
  session.stop();
  processFor(session).emit('spawn');
  assert.equal(session.state, FFmpeg.SESSION_STATE.STOPPING);
  let finished = session.stop('SIGKILL');
  assert.equal(
    clear.mock.calls.some((call) => call.arguments[0] === 123),
    true,
  );
  processFor(session).emit('exit', null, 'SIGKILL');
  processFor(session).emit('close', null, 'SIGKILL');
  assert.equal((await finished).expected, true);
});

test('device shutdown awaits replacements and other session types without affecting another device', async (t) => {
  let { ffmpeg, children } = createMockFFmpeg(t);
  t.mock.method(timers, 'setTimeout', () => 123);
  t.mock.method(timers, 'clearTimeout', () => {});
  let first = ffmpeg.start({ id: 'camera:one:live', args: [] });
  let second = ffmpeg.start({ id: 'camera:one:live', args: [] });
  processFor(second).emit('spawn');
  let record = ffmpeg.start({ id: 'camera:two:record', args: [] });
  let otherManager = new FFmpeg('ffmpeg');
  let other = otherManager.start({ id: 'one:live', args: [] });
  processes.set(other, children.at(-1));
  assert.equal(first.state, FFmpeg.SESSION_STATE.STOPPING);
  let settled = false;
  let shutdown = ffmpeg.shutdown().then(() => {
    settled = true;
  });
  for (let session of [first, record]) {
    processFor(session).emit('exit', null, 'SIGKILL');
    processFor(session).emit('close', null, 'SIGKILL');
  }
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(other.state, FFmpeg.SESSION_STATE.STARTING);
  assert.equal(processFor(other).kill.mock.callCount(), 0);
  processFor(second).emit('exit', null, 'SIGKILL');
  processFor(second).emit('close', null, 'SIGKILL');
  await shutdown;
  assert.equal(settled, true);
  processFor(other).emit('exit', 0, null);
  processFor(other).emit('close', 0, null);
  assert.equal((await ffmpeg.shutdown()).length, 3);
});

test(
  'real child processes confirm failed-spawn completion and forced shutdown',
  { timeout: 5000, skip: os.platform() === 'win32' },
  async (t) => {
    let { ffmpeg, spawn } = createMockFFmpeg(t);
    spawn.mock.mockImplementation((binary, args, options) => spawnProcess(args[0], args.slice(1), options));
    let failed = ffmpeg.start({ id: 'camera:missing:default', args: ['/missing-ffmpeg-lifecycle-binary'] });
    let failure = await failed.finished;
    assert.equal(failure.state, FFmpeg.SESSION_STATE.FAILED);
    assert.equal(failure.error.code, 'ENOENT');
    assert.equal(failure.expected, false);

    // The child explicitly ignores SIGTERM; stdout confirms its handler is installed before shutdown.
    let running = ffmpeg.start({
      id: 'camera:running:default',
      args: [process.execPath, '-e', 'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000);'],
    });
    t.after(() => running.stop('SIGKILL'));
    await new Promise((resolve) => running.stdout.once('data', resolve));
    assert.equal(running.state, FFmpeg.SESSION_STATE.RUNNING);
    let graceTimer = t.mock.method(timers, 'setTimeout', timers.setTimeout);
    assert.throws(() => running.stop('INVALID_SIGNAL'), { code: 'ERR_UNKNOWN_SIGNAL' });
    assert.equal(graceTimer.mock.callCount(), 0);
    assert.equal(running.state, FFmpeg.SESSION_STATE.RUNNING);
    let completion = await running.stop('SIGTERM', 10);
    assert.equal(completion.state, FFmpeg.SESSION_STATE.EXITED);
    assert.equal(completion.expected, true);
    assert.equal(completion.signal, 'SIGKILL');
    assert.deepEqual(await ffmpeg.shutdown(), []);
  },
);

test('session events publish changed states before STARTED and COMPLETE without duplicate transitions', async (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  let session = ffmpeg.start({ id: 'camera:events:default', args: [] });
  let events = [];
  ffmpeg.on(FFmpeg.SESSION_EVENT.STATE_CHANGED, (handle, change) => {
    assert.equal(handle, session);
    assert.equal(session.state, change.state);
    events.push(change);
  });
  ffmpeg.on(FFmpeg.SESSION_EVENT.STARTED, (started) => {
    assert.equal(started, session);
    events.push('started');
  });
  ffmpeg.on(FFmpeg.SESSION_EVENT.COMPLETE, (handle) => {
    assert.equal(handle, session);
    events.push('complete');
  });
  processFor(session).emit('spawn');
  session.stop('SIGKILL');
  session.stop('SIGKILL');
  processFor(session).emit('exit', null, 'SIGKILL');
  processFor(session).emit('close', null, 'SIGKILL');
  await session.finished;
  assert.deepEqual(events, [
    { state: FFmpeg.SESSION_STATE.RUNNING, previousState: FFmpeg.SESSION_STATE.STARTING },
    'started',
    { state: FFmpeg.SESSION_STATE.STOPPING, previousState: FFmpeg.SESSION_STATE.RUNNING },
    { state: FFmpeg.SESSION_STATE.EXITED, previousState: FFmpeg.SESSION_STATE.STOPPING },
    'complete',
  ]);
});

test('failed and cancelled startups do not emit STARTED', async (t) => {
  for (let failed of [true, false]) {
    await t.test(failed === true ? 'failed startup' : 'cancelled startup', async (t) => {
      let { ffmpeg } = createMockFFmpeg(t);
      let session = ffmpeg.start({ id: 'camera:events:default', args: [] });
      let started = t.mock.fn();
      let changes = [];
      ffmpeg.on(FFmpeg.SESSION_EVENT.STARTED, started);
      ffmpeg.on(FFmpeg.SESSION_EVENT.STATE_CHANGED, (handle, change) => changes.push(change));
      if (failed === true) {
        processFor(session).emit('error', new Error('ENOENT'));
        assert.equal(session.diagnosticLines.length, 1);
        processFor(session).emit('close', -2, null);
        assert.deepEqual(changes, [{ state: FFmpeg.SESSION_STATE.FAILED, previousState: FFmpeg.SESSION_STATE.STARTING }]);
      } else {
        session.stop('SIGKILL');
        processFor(session).emit('spawn');
        processFor(session).emit('exit', null, 'SIGKILL');
        processFor(session).emit('close', null, 'SIGKILL');
        assert.deepEqual(changes, [
          { state: FFmpeg.SESSION_STATE.STOPPING, previousState: FFmpeg.SESSION_STATE.STARTING },
          { state: FFmpeg.SESSION_STATE.EXITED, previousState: FFmpeg.SESSION_STATE.STOPPING },
        ]);
      }
      await session.finished;
      assert.equal(started.mock.callCount(), 0);
    });
  }
});

test('state listeners can force a graceful stop without leaving an escalation timer armed', async (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  t.mock.method(timers, 'setTimeout', () => 123);
  let clear = t.mock.method(timers, 'clearTimeout', () => {});
  let session = ffmpeg.start({ id: 'camera:events:default', args: [] });
  ffmpeg.on(FFmpeg.SESSION_EVENT.STATE_CHANGED, (handle, { state }) => {
    if (state === FFmpeg.SESSION_STATE.STOPPING) {
      session.stop('SIGKILL');
    }
  });
  session.stop();
  assert.deepEqual(
    processFor(session).kill.mock.calls.map((call) => call.arguments[0]),
    ['SIGTERM', 'SIGKILL'],
  );
  assert.equal(
    clear.mock.calls.some((call) => call.arguments[0] === 123),
    true,
  );
  processFor(session).emit('exit', null, 'SIGKILL');
  processFor(session).emit('close', null, 'SIGKILL');
  await session.finished;
});

test('invalid pipe counts default to stdin, stdout and stderr', (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  let counts = ['4', null, NaN, Infinity, 3.5, {}];
  for (let [index, pipeCount] of counts.entries()) {
    let session = ffmpeg.start({
      id: 'camera' + ':' + String(index) + ':' + 'default',
      args: [],
      onStderr: undefined,
      pipeCount: pipeCount,
    });
    assert.equal(processFor(session).stdio.length, 3);
    assert.equal(session.active, true);
  }
});

test('integer pipe counts retain the minimum and additional media pipes', (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  for (let count of [-1, 0, 2, 3, 4]) {
    let session = ffmpeg.start({ id: 'camera' + ':' + String(count) + ':' + 'default', args: [], onStderr: undefined, pipeCount: count });
    assert.equal(processFor(session).stdio.length, Math.max(3, count));
  }
});

test('synchronously rejected replacement arguments leave the running session intact', (t) => {
  let { ffmpeg, spawn } = createMockFFmpeg(t);
  let original = ffmpeg.start({ id: 'camera:one:default', args: [] });
  processFor(original).emit('spawn');
  spawn.mock.mockImplementation((...args) => spawnProcess(...args));
  assert.throws(() => ffmpeg.start({ id: 'camera:one:default', args: ['\0'] }), { code: 'ERR_INVALID_ARG_VALUE' });
  assert.equal(original.state, FFmpeg.SESSION_STATE.RUNNING);
  assert.equal(processFor(original).kill.mock.callCount(), 0);
  assert.equal(original.active, true);
});

test('asynchronous replacement startup failure leaves the running session intact', async (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  let original = ffmpeg.start({ id: 'camera:one:default', args: [] });
  processFor(original).emit('spawn');
  let replacement = ffmpeg.start({ id: 'camera:one:default', args: [] });
  processFor(replacement).emit('error', new Error('ENOENT'));
  processFor(replacement).emit('close', -2, null);
  assert.equal((await replacement.finished).state, FFmpeg.SESSION_STATE.FAILED);
  assert.equal(original.state, FFmpeg.SESSION_STATE.RUNNING);
  assert.equal(processFor(original).kill.mock.callCount(), 0);
  assert.equal(original.active, true);
});

test('older replacement startup cannot stop a newer pending request', async (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  t.mock.method(timers, 'setTimeout', () => 123);
  t.mock.method(timers, 'clearTimeout', () => {});
  let original = ffmpeg.start({ id: 'camera:one:default', args: [] });
  processFor(original).emit('spawn');
  let older = ffmpeg.start({ id: 'camera:one:default', args: [] });
  let newer = ffmpeg.start({ id: 'camera:one:default', args: [] });
  processFor(older).emit('spawn');
  assert.equal(original.state, FFmpeg.SESSION_STATE.STOPPING);
  assert.equal(newer.state, FFmpeg.SESSION_STATE.STARTING);
  assert.equal(processFor(newer).kill.mock.callCount(), 0);
  processFor(newer).emit('spawn');
  assert.equal(older.state, FFmpeg.SESSION_STATE.STOPPING);
  assert.equal(newer.state, FFmpeg.SESSION_STATE.RUNNING);
  let stopped = ffmpeg.shutdown();
  for (let session of [original, older, newer]) {
    processFor(session).emit('exit', null, 'SIGKILL');
    processFor(session).emit('close', null, 'SIGKILL');
  }
  await stopped;
});

test('EPIPE stays silent while other pipe errors reach diagnostics and completion', async (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  let callback = t.mock.fn();
  let session = ffmpeg.start({ id: 'camera:one:live', args: [], onStderr: callback, pipeCount: 4 });
  processFor(session).emit('spawn');
  for (let pipe of processFor(session).stdio) {
    pipe.emit('error', Object.assign(new Error('Broken pipe'), { code: 'EPIPE' }));
  }
  assert.equal(callback.mock.callCount(), 0);
  assert.deepEqual(session.diagnosticLines, []);
  let error = Object.assign(new Error('I/O failure'), { code: 'EIO' });
  processFor(session).stdio[3].emit('error', error);
  assert.equal(callback.mock.callCount(), 1);
  assert.deepEqual(session.diagnosticLines, ['Error on ffmpeg session "camera:one:live" pipe 3. Error was "I/O failure"']);
  assert.equal(callback.mock.calls[0].arguments[0], session.diagnosticLines[0]);
  // A pipe error does not mean the child exited; teardown must still be able to signal it.
  assert.equal(session.state, FFmpeg.SESSION_STATE.RUNNING);
  processFor(session).emit('exit', 0, null);
  processFor(session).emit('close', 0, null);
  let result = await session.finished;
  assert.equal(result.state, FFmpeg.SESSION_STATE.FAILED);
  assert.equal(result.error, error);
  assert.equal(result.expected, false);
});

test('unsuccessful signals leave the session active and do not schedule forced termination', async (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  let schedule = t.mock.method(timers, 'setTimeout', () => 123);
  let session = ffmpeg.start({ id: 'camera:one:default', args: [] });
  processFor(session).emit('spawn');
  t.mock.method(processFor(session), 'kill', () => false);
  assert.equal(session.stop(), session.finished);
  assert.equal(schedule.mock.callCount(), 0);
  assert.equal(session.state, FFmpeg.SESSION_STATE.RUNNING);
  processFor(session).emit('exit', 1, null);
  processFor(session).emit('close', 1, null);
  assert.equal((await session.finished).expected, false);
});

test('inaccessible DRM metadata disables QSV without failing construction or software support', (t) => {
  createMockFFmpeg(t);
  t.mock.method(os, 'platform', () => 'linux');
  t.mock.method(fs, 'existsSync', (file) => file.startsWith('/dev/dri'));
  t.mock.method(fs, 'readdirSync', () => {
    throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
  });
  t.mock.method(fs, 'readFileSync', () => 'Generic board');
  t.mock.method(child_process, 'spawnSync', (binary, args) => ({
    status: 0,
    stdout: args[0] === '-version' ? 'ffmpeg version 8.0 ' : args[0] === '-encoders' ? ' V..... libx264\n V..... h264_qsv' : '',
  }));
  let ffmpeg = new FFmpeg('ffmpeg');
  assert.equal(ffmpeg.hasMinimumSupport({ encoders: ['libx264'] }), true);
  assert.equal(ffmpeg.supportsHardwareH264, false);
  assert.equal(ffmpeg.hardwareH264Codec, undefined);
});

for (let platform of ['darwin', 'linux', 'win32']) {
  for (let location of ['directory', 'executable', 'home directory']) {
    test('binary resolution uses the configured ' + location + ' on ' + platform, (context) => {
      context.mock.method(os, 'platform', () => platform);
      context.mock.method(os, 'homedir', () => path.resolve('/fixture/home'));
      let name = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
      let input = location === 'home directory' ? '~/media-tools' : location === 'directory' ? '/fixture/tools///' : '/fixture/bin/' + name;
      let directory = path.resolve(location === 'home directory' ? '/fixture/home/media-tools' : '/fixture/tools');
      let expected = location === 'executable' ? path.resolve('/fixture/bin/' + name) : path.join(directory, name);
      context.mock.method(fs, 'existsSync', (file) => file === directory || file === expected);
      context.mock.method(fs, 'statSync', (file) => ({ isDirectory: () => file === directory }));
      let probes = context.mock.method(child_process, 'spawnSync', () => ({ status: 0, stdout: 'ffmpeg version 7.1 ' }));
      let ffmpeg = new FFmpeg(input);
      assert.equal(ffmpeg.binary, expected);
      assert.equal(ffmpeg.version, '7.1');
      assert.equal(
        probes.mock.calls.every((call) => call.arguments[0] === expected),
        true,
      );
    });
  }
}

for (let [platform, existing] of [
  ['darwin', '/opt/homebrew/bin/ffmpeg'],
  ['linux', '/usr/bin/ffmpeg'],
  ['win32', 'C:\\ffmpeg\\bin'],
]) {
  test('default binary discovery selects an existing installation on ' + platform, (context) => {
    context.mock.method(os, 'platform', () => platform);
    let expected = platform === 'win32' ? path.join(existing, 'ffmpeg.exe') : existing;
    context.mock.method(fs, 'existsSync', (file) => file === expected);
    let probe = context.mock.method(child_process, 'spawnSync', () => ({ status: 0, stdout: 'ffmpeg version 8.0 ' }));
    let ffmpeg = new FFmpeg();
    assert.equal(ffmpeg.binary, expected);
    assert.equal(ffmpeg.version, '8.0');
    assert.equal(probe.mock.calls[0].arguments[0], expected);
  });
}

for (let platform of ['darwin', 'win32']) {
  test('default binary discovery uses PATH when no installation is found on ' + platform, (context) => {
    context.mock.method(os, 'platform', () => platform);
    context.mock.method(fs, 'existsSync', () => false);
    let probe = context.mock.method(child_process, 'spawnSync', () => ({ error: new Error('Fixture PATH executable unavailable') }));
    let ffmpeg = new FFmpeg();
    assert.equal(ffmpeg.binary, platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    assert.equal(ffmpeg.version, undefined);
    assert.equal(probe.mock.callCount(), 1);
  });
}

test('missing explicit executable skips probes and cannot advertise required codec support', (context) => {
  context.mock.method(fs, 'existsSync', () => false);
  let probe = context.mock.method(child_process, 'spawnSync', () => assert.fail('missing binary must not be executed'));
  let ffmpeg = new FFmpeg('/fixture/missing/ffmpeg');
  assert.equal(ffmpeg.version, undefined);
  assert.equal(ffmpeg.hasMinimumSupport(), false);
  assert.equal(ffmpeg.supportsHardwareH264, false);
  assert.equal(probe.mock.callCount(), 0);
});

for (let result of [
  { status: 1, stdout: 'ffmpeg version 8.0 ' },
  { status: 0, stdout: null },
  { status: 0, stdout: 'unrecognised version' },
]) {
  test('unusable version probe cannot establish minimum support: ' + JSON.stringify(result), (context) => {
    context.mock.method(child_process, 'spawnSync', () => result);
    let ffmpeg = new FFmpeg('fixture-invalid-version');
    assert.equal(ffmpeg.version, undefined);
    assert.equal(ffmpeg.hasMinimumSupport({ encoders: ['libx264'] }), false);
    assert.equal(ffmpeg.supportsHardwareH264, false);
  });
}

for (let command of ['-encoders', '-decoders', '-muxers', '-demuxers']) {
  for (let result of [{ error: new Error('Fixture feature probe failed') }, { status: 1 }, { status: 0, stdout: null }]) {
    test('failed ' + command + ' query isolates unavailable features: ' + String(result.status ?? result.error.message), (context) => {
      context.mock.method(child_process, 'spawnSync', (binary, args) =>
        args[0] === command
          ? result
          : {
              status: 0,
              stdout: {
                '-version': 'ffmpeg version 8.0 ',
                '-encoders': ' V..... libx264',
                '-decoders': ' A..... libspeex',
                '-muxers': ' E mp4',
                '-demuxers': ' D mov',
              }[args[0]],
            },
      );
      let ffmpeg = new FFmpeg('fixture-feature-query');
      assert.equal(ffmpeg.version, '8.0');
      assert.equal(ffmpeg.supportsEncoder('libx264'), command !== '-encoders');
      assert.equal(ffmpeg.supportsDecoder('libspeex'), command !== '-decoders');
      assert.equal(ffmpeg.supportsMuxer('mp4'), command !== '-muxers');
      assert.deepEqual(ffmpeg.features.demuxers, command === '-demuxers' ? [] : ['mov']);
      assert.equal(ffmpeg.supportsHardwareH264, false);
    });
  }
}

test('process completion cancels scheduled forced termination', async (context) => {
  let { ffmpeg } = createMockFFmpeg(context);
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let session = ffmpeg.start({ id: 'camera:timer-race:default', args: [] });
  processFor(session).emit('spawn');
  session.stop();
  processFor(session).emit('exit', 0, null);
  processFor(session).emit('close', 0, null);
  context.mock.timers.tick(2000);
  assert.equal(processFor(session).kill.mock.callCount(), 1);
  assert.equal((await session.finished).expected, true);
  assert.deepEqual(await ffmpeg.shutdown(), []);
});

test('hardware discovery rejects inaccessible render nodes and malformed video entries', (context) => {
  context.mock.method(os, 'platform', () => 'linux');
  context.mock.method(fs, 'readFileSync', (file) => {
    if (file === '/sys/firmware/devicetree/base/model') {
      return 'Generic board';
    }
    assert.equal(file, '/sys/class/video4linux/video31/name');
    return 'camera capture';
  });
  context.mock.method(fs, 'readdirSync', (file) =>
    file === '/dev/dri' ? ['card0', 'renderD128', 'renderD129'] : ['not-a-video-node', 'video31'],
  );
  context.mock.method(fs, 'accessSync', (file) => {
    if (file === '/dev/dri/renderD128') {
      throw Object.assign(new Error('Fixture permission denied'), { code: 'EACCES' });
    }
    assert.equal(file, '/dev/dri/renderD129');
  });
  let devices = [];
  context.mock.method(child_process, 'spawnSync', (binary, args) => {
    if (args.includes('-frames:v') === true) {
      devices.push(args[args.indexOf('-qsv_device') + 1]);
      return { status: 1, stdout: '' };
    }
    return {
      status: 0,
      stdout:
        args[0] === '-version'
          ? 'ffmpeg version 8.0 '
          : args[0] === '-encoders'
            ? ' V..... libx264\n V..... h264_qsv\n V..... h264_v4l2m2m'
            : '',
    };
  });
  let ffmpeg = new FFmpeg('fixture-rejected-hardware-nodes');
  assert.deepEqual(devices, ['/dev/dri/renderD129']);
  assert.equal(ffmpeg.supportsHardwareH264, false);
  assert.equal(ffmpeg.getH264EncoderOptions(true).codec, 'libx264');
});

test('bounded hardware probe cache evicts old binaries while reusing recent validation', (context) => {
  context.mock.method(os, 'platform', () => 'darwin');
  context.mock.method(fs, 'statSync', () => {
    throw new Error('Fixture bare command has no resolved metadata');
  });
  let validations = new Map();
  context.mock.method(child_process, 'spawnSync', (binary, args) => {
    if (args.includes('-frames:v') === true) {
      validations.set(binary, (validations.get(binary) ?? 0) + 1);
      return { status: 0, stdout: Buffer.from([0, 0, 0, 1, 0x67]) };
    }
    return {
      status: 0,
      stdout: args[0] === '-version' ? 'ffmpeg version 8.0 ' : args[0] === '-encoders' ? ' V..... libx264\n V..... h264_videotoolbox' : '',
    };
  });
  for (let index = 0; index < 33; index++) {
    assert.equal(new FFmpeg('fixture-cache-capacity-' + index).supportsHardwareH264, true);
  }
  assert.equal(new FFmpeg('fixture-cache-capacity-32').supportsHardwareH264, true);
  assert.equal(validations.get('fixture-cache-capacity-32'), 1);
  assert.equal(new FFmpeg('fixture-cache-capacity-0').supportsHardwareH264, true);
  assert.equal(validations.get('fixture-cache-capacity-0'), 2);
});

test('build configuration flags are reported separately from available codecs', (context) => {
  context.mock.method(child_process, 'spawnSync', (binary, args) => ({
    status: 0,
    stdout: args[0] === '-version' ? 'ffmpeg version 8.0 --enable-libx264 --enable-shared' : '',
  }));
  let ffmpeg = new FFmpeg('fixture-build-flags');
  assert.deepEqual(ffmpeg.features.enabled, ['libx264', 'shared']);
  assert.equal(ffmpeg.supportsEncoder('libx264'), false);
  assert.equal(ffmpeg.hasMinimumSupport({ encoders: ['libx264'] }), false);
});

test('start owns media connections without disconnecting or destroying shared streams', async (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  let video = new PassThrough();
  let audio = new PassThrough();
  let talkback = new PassThrough();
  let first = ffmpeg.start({ id: 'record', inputs: { 0: video, 3: audio }, outputs: { 1: talkback } });
  let replacement = ffmpeg.start({ id: 'record', inputs: { 0: video } });
  video.write('video');
  audio.write('audio');
  first.stdout.write('talkback');
  assert.equal(processFor(first).stdin.read().toString(), 'video');
  assert.equal(processFor(replacement).stdin.read().toString(), 'video');
  assert.equal(processFor(first).stdio[3].read().toString(), 'audio');
  assert.equal(talkback.read().toString(), 'talkback');

  let finished = first.stop('SIGKILL');
  assert.equal(first.active, false);
  assert.equal(replacement.active, true);
  video.write('replacement');
  audio.write('stopped');
  first.stdout.write('stopped');
  assert.equal(processFor(replacement).stdin.read().toString(), 'replacement');
  assert.equal(processFor(first).stdin.read(), null);
  assert.equal(processFor(first).stdio[3].read(), null);
  assert.equal(talkback.read(), null);
  for (let stream of [video, audio, talkback]) {
    assert.equal(stream.destroyed, false);
    assert.equal(stream.writableEnded, false);
  }
  assert.equal(processFor(first).stdin.listenerCount('unpipe'), 0);
  assert.equal(talkback.listenerCount('unpipe'), 0);
  processFor(first).emit('exit', null, 'SIGKILL');
  processFor(first).emit('close', null, 'SIGKILL');
  await finished;
  processFor(replacement).emit('exit', 0, null);
  processFor(replacement).emit('close', 0, null);
  assert.equal(video.listenerCount('data'), 0);
  assert.deepEqual(await ffmpeg.shutdown(), []);
});

test('natural process exit detaches inputs but drains final output before completion', async (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  let source = new PassThrough();
  let sink = new PassThrough();
  let session = ffmpeg.start({ inputs: { 0: source }, outputs: { 1: sink } });
  processFor(session).emit('spawn');
  processFor(session).emit('exit', 0, null);
  assert.equal(session.active, false);
  assert.equal(source.listenerCount('data'), 0);
  session.stdout.write('final encoded bytes');
  assert.equal(sink.read().toString(), 'final encoded bytes');
  processFor(session).emit('close', 0, null);
  await session.finished;
  assert.equal(session.stdout.listenerCount('data'), 0);
  assert.equal(sink.listenerCount('unpipe'), 0);
  assert.equal(sink.destroyed, false);
  assert.equal(sink.writableEnded, false);
});

test('naturally finished pipe connections release tracking before process shutdown', async (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  let source = new PassThrough();
  let session = ffmpeg.start({ inputs: { 0: source } });
  source.end('last input');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(processFor(session).stdin.listenerCount('unpipe'), 0);
  let unpipe = t.mock.method(source, 'unpipe', source.unpipe);
  session.stop('SIGKILL');
  assert.equal(unpipe.mock.callCount(), 0);
  processFor(session).emit('exit', null, 'SIGKILL');
  processFor(session).emit('close', null, 'SIGKILL');
  await session.finished;
});

test('failed media attachment rolls back connections and terminates its process as a failure', async (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  let source = new PassThrough();
  let failure = new Error('Fixture pipe setup failed');
  t.mock.method(source, 'pipe', (destination) => {
    PassThrough.prototype.pipe.call(source, destination);
    throw failure;
  });
  let session = ffmpeg.start({ inputs: { 0: source } });
  assert.equal(source.listenerCount('data'), 0);
  assert.equal(processFor(session).stdin.listenerCount('unpipe'), 0);
  assert.equal(session.active, false);
  assert.deepEqual(processFor(session).kill.mock.calls[0].arguments, ['SIGKILL']);
  processFor(session).emit('exit', null, 'SIGKILL');
  processFor(session).emit('close', null, 'SIGKILL');
  let result = await session.finished;
  assert.equal(result.error, failure);
  assert.equal(result.expected, false);
  assert.equal(result.state, FFmpeg.SESSION_STATE.FAILED);
});

test('rejected stop signals preserve media connections until the process actually exits', async (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  let source = new PassThrough();
  let session = ffmpeg.start({ inputs: { 0: source } });
  t.mock.method(processFor(session), 'kill', () => false);
  assert.equal(session.stop(), session.finished);
  assert.equal(session.active, true);
  source.write('still connected');
  assert.equal(processFor(session).stdin.read().toString(), 'still connected');
  processFor(session).emit('error', new Error('Fixture spawn failed'));
  assert.equal(session.active, false);
  assert.equal(source.listenerCount('data'), 0);
  processFor(session).emit('close', -2, null);
  await session.finished;
});

test('forced shutdown is idempotent after explicit or timed escalation', async (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (let escalate of [true, false]) {
    let session = ffmpeg.start({ id: 'camera' + ':' + String(escalate) + ':' + 'default', args: [] });
    processFor(session).emit('spawn');
    if (escalate === true) {
      session.stop('SIGTERM', 10);
      t.mock.timers.tick(10);
    } else {
      session.stop('SIGKILL');
    }
    let signals = processFor(session).kill.mock.calls.map((call) => call.arguments[0]);
    assert.deepEqual(signals, escalate === true ? ['SIGTERM', 'SIGKILL'] : ['SIGKILL']);
    assert.equal(session.stop('SIGKILL'), session.finished);
    assert.equal(session.stop(), session.finished);
    assert.equal(processFor(session).kill.mock.callCount(), signals.length);
    processFor(session).emit('exit', null, 'SIGKILL');
    processFor(session).emit('close', null, 'SIGKILL');
    await session.finished;
  }
});

test('capability probes have a forced timeout and isolate timed-out feature queries', (t) => {
  createMockFFmpeg(t);
  let commands = [];
  t.mock.method(child_process, 'spawnSync', (binary, args, options) => {
    assert.equal(options.timeout, 2000);
    assert.equal(options.killSignal, 'SIGKILL');
    commands.push(args[0]);
    return args[0] === '-version'
      ? { status: 0, stdout: 'ffmpeg version 8.0 ' }
      : { error: Object.assign(new Error('Fixture probe timed out'), { code: 'ETIMEDOUT' }), status: null, stdout: null };
  });
  let ffmpeg = new FFmpeg('fixture-probe-timeout');
  assert.deepEqual(commands, ['-version', '-encoders', '-decoders', '-muxers', '-demuxers']);
  assert.equal(ffmpeg.version, '8.0');
  assert.equal(ffmpeg.supportsEncoder('libx264'), false);
  assert.equal(ffmpeg.supportsDecoder('libspeex'), false);
  assert.equal(ffmpeg.supportsMuxer('mp4'), false);
});

test('pending inputs attach automatically and cannot reconnect a stopped process', async (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  for (let cancelled of [false, true]) {
    let ready = Promise.withResolvers();
    let source = new PassThrough();
    let session = ffmpeg.start({ inputs: ready.promise });
    if (cancelled === true) {
      session.stop('SIGKILL');
    }
    ready.resolve({ 0: source });
    await Promise.resolve();
    source.write('media');
    assert.equal(source.listenerCount('data'), cancelled === true ? 0 : 1);
    let received = processFor(session).stdin.read();
    assert.equal(received?.toString(), cancelled === true ? undefined : 'media');
    processFor(session).emit('exit', 0, null);
    processFor(session).emit('close', 0, null);
    await session.finished;
  }
});

test('rejected input acquisition stops its process without classifying the failure as expected', async (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  let ready = Promise.withResolvers();
  let session = ffmpeg.start({ inputs: ready.promise });
  let error = new Error('Fixture input acquisition failed');
  ready.reject(error);
  await Promise.resolve();
  assert.equal(session.active, false);
  assert.deepEqual(processFor(session).kill.mock.calls[0].arguments, ['SIGKILL']);
  processFor(session).emit('exit', null, 'SIGKILL');
  processFor(session).emit('close', null, 'SIGKILL');
  let result = await session.finished;
  assert.equal(result.error, error);
  assert.equal(result.state, FFmpeg.SESSION_STATE.FAILED);
  assert.equal(result.expected, false);
});

test('shutdown shares completion and prevents starts from reentrant callbacks and later callers', async (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  let session = ffmpeg.start();
  let reentrant;
  assert.equal(
    ffmpeg.on(FFmpeg.SESSION_EVENT.STATE_CHANGED, (handle, { state }) => {
      if (state === FFmpeg.SESSION_STATE.STOPPING) {
        reentrant = ffmpeg.shutdown();
        assert.throws(() => ffmpeg.start(), /shut down/);
      }
    }),
    ffmpeg,
  );
  let shutdown = ffmpeg.shutdown();
  assert.equal(reentrant, shutdown);
  assert.equal(ffmpeg.shutdown(), shutdown);
  processFor(session).emit('exit', null, 'SIGKILL');
  processFor(session).emit('close', null, 'SIGKILL');
  assert.deepEqual(await shutdown, [await session.finished]);
  assert.equal(ffmpeg.shutdown(), shutdown);
  assert.throws(() => ffmpeg.start(), /shut down/);
});

test('start delivers finite SDP inputs and exposes no registry or raw process control', async (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  for (let input of ['v=0\r\n', Buffer.from('v=0\r\n')]) {
    let session = ffmpeg.start({ inputs: { 0: input } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(processFor(session).stdin.read().toString(), 'v=0\r\n');
    assert.equal(processFor(session).stdin.writableEnded, true);
    for (let property of ['process', 'key', 'stdin', 'stdio', 'kill', 'pipeInput', 'pipeOutput']) {
      assert.equal(session[property], undefined);
    }
    processFor(session).emit('exit', 0, null);
    processFor(session).emit('close', 0, null);
    await session.finished;
  }
  for (let method of ['createSession', 'hasSession', 'listSessions', 'killSession', 'killAllSessions']) {
    assert.equal(ffmpeg[method], undefined);
  }
});

test('invalid pipe mappings are rejected before spawning and independent starts do not replace each other', async (t) => {
  let { ffmpeg, spawn } = createMockFFmpeg(t);
  for (let index of ['-1', '1.5', 'not-a-pipe']) {
    assert.throws(() => ffmpeg.start({ inputs: { [index]: new PassThrough() } }), RangeError);
  }
  assert.equal(spawn.mock.callCount(), 0);
  let first = ffmpeg.start();
  let second = ffmpeg.start();
  processFor(first).emit('spawn');
  processFor(second).emit('spawn');
  assert.equal(processFor(first).kill.mock.callCount(), 0);
  assert.equal(processFor(second).kill.mock.callCount(), 0);
  for (let session of [first, second]) {
    processFor(session).emit('exit', 0, null);
    processFor(session).emit('close', 0, null);
    await session.finished;
  }
});
