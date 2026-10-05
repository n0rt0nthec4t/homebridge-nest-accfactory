// Verify FFmpeg hardware discovery, capability queries, diagnostics, and session lifecycle.
// Code version 2026.10.05
import assert from 'node:assert/strict';
import child_process from 'node:child_process';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import process from 'node:process';
import timers from 'node:timers';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import FFmpeg from '../../src/ffmpeg.js';

const spawnProcess = child_process.spawn;

test('Raspberry Pi hardware selection uses accessible encoder nodes without extra FFmpeg calls', async (t) => {
  let cases = [
    { name: 'encoder at video11 without video0', nodes: { video11: 'bcm2835-codec-encode' }, expected: true },
    { name: 'renumbered encoder', nodes: { video31: 'bcm2835-codec-encode' }, expected: true },
    { name: 'camera and decoder only', nodes: { video0: 'unicam', video10: 'bcm2835-codec-decode' }, expected: false },
    { name: 'image encoder only', nodes: { video0: 'bcm2835-codec-encode_image' }, expected: false },
    { name: 'encoder inaccessible', nodes: { video11: 'bcm2835-codec-encode' }, denied: true, expected: false },
    { name: 'missing sysfs on Pi', nodes: { video0: 'unicam' }, missingSysfs: true, expected: false },
    { name: 'missing encoder in FFmpeg', nodes: { video11: 'bcm2835-codec-encode' }, compiled: false, expected: false },
    { name: 'generic Linux retains existing check', nodes: { video0: 'generic' }, model: 'Generic board', expected: true },
    { name: 'missing model retains existing check', nodes: { video0: 'generic' }, model: null, expected: true },
    { name: 'Pi DRM nodes do not outrank V4L2', nodes: { video11: 'bcm2835-codec-encode' }, drm: true, expected: true },
    { name: 'Pi DRM alone does not enable acceleration', nodes: {}, drm: true, expected: false },
    { name: 'Pi missing sysfs does not fall back to DRM', nodes: {}, drm: true, missingSysfs: true, expected: false },
    { name: 'generic Linux retains DRM priority', nodes: {}, drm: true, model: 'Generic board', codec: 'h264_nvenc' },
  ];

  for (let scenario of cases) {
    await t.test(scenario.name, (t) => {
      t.mock.method(os, 'platform', () => 'linux');
      t.mock.method(
        fs,
        'existsSync',
        (file) =>
          (file.startsWith('/dev/video') && file.slice(5) in scenario.nodes) || (scenario.drm === true && file.startsWith('/dev/dri')),
      );
      t.mock.method(fs, 'readFileSync', (file) => {
        if (file === '/sys/firmware/devicetree/base/model' && scenario.model !== null) {
          return scenario.model ?? 'Raspberry Pi 4 Model B Rev 1.4\0';
        }
        let device = /^\/sys\/class\/video4linux\/(video\d+)\/name$/.exec(file)?.[1];
        if (device in scenario.nodes) {
          return scenario.nodes[device] + '\n';
        }
        throw new Error('Missing metadata');
      });
      t.mock.method(fs, 'readdirSync', (file) => {
        if (file === '/dev/dri') {
          return ['card0', 'renderD128'];
        }
        assert.equal(file, '/sys/class/video4linux');
        if (scenario.missingSysfs === true) {
          throw new Error('Missing sysfs');
        }
        return Object.keys(scenario.nodes);
      });
      t.mock.method(fs, 'accessSync', (file, mode) => {
        assert.equal(mode, fs.constants.R_OK | fs.constants.W_OK);
        if (scenario.denied === true || !(file.slice(5) in scenario.nodes)) {
          throw new Error('Device unavailable');
        }
      });
      let spawn = t.mock.method(child_process, 'spawnSync', (binary, args) => {
        assert.equal(binary, 'ffmpeg');
        return {
          status: 0,
          stdout:
            args[0] === '-version'
              ? 'ffmpeg version 8.0 '
              : scenario.compiled === false
                ? ''
                : ' V..... h264_v4l2m2m' + (scenario.drm === true ? '\n V..... h264_nvenc\n V..... h264_qsv\n V..... h264_vaapi' : ''),
        };
      });

      let ffmpeg = new FFmpeg('ffmpeg');
      assert.equal(ffmpeg.hardwareH264Codec, scenario.codec ?? (scenario.expected === true ? 'h264_v4l2m2m' : undefined));
      assert.equal(ffmpeg.supportsHardwareH264, scenario.expected === true || scenario.codec !== undefined);
      if (scenario.drm === true && scenario.model === undefined) {
        for (let codec of ['h264_nvenc', 'h264_qsv', 'h264_vaapi']) {
          assert.equal(ffmpeg.features[codec], false);
        }
      }
      assert.deepEqual(
        spawn.mock.calls.map((call) => call.arguments[1]),
        [['-version'], ['-encoders'], ['-decoders'], ['-muxers'], ['-demuxers']],
      );
    });
  }
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
  return { ffmpeg: new FFmpeg('ffmpeg'), children, spawn };
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
  let session = ffmpeg.createSession('camera', 'one', ['-version'], 'live', callback);
  let first = Buffer.from('  first\r\n\nsecond ');
  let unicode = Buffer.from('café');
  session.stderr.emit('data', first);
  session.stderr.emit('data', unicode.subarray(0, unicode.length - 1));
  session.stderr.emit('data', unicode.subarray(unicode.length - 1));
  assert.deepEqual(session.diagnosticLines, ['first', 'second café']);
  session.stderr.emit('data', Buffer.from('\nthird'));
  assert.deepEqual(session.diagnosticLines, ['first', 'second café', 'third']);
  session.diagnosticLines.push('external mutation');
  assert.deepEqual(session.diagnosticLines, ['first', 'second café', 'third']);
  assert.equal(callback.mock.calls[0].arguments[0], first);
  assert.equal(callback.mock.callCount(), 4);
});

test('session diagnostics retain only 20 lines and bound unterminated output', (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  let session = ffmpeg.createSession('camera', 'one', []);
  session.stderr.emit('data', Buffer.from(Array.from({ length: 100 }, (_, i) => 'line ' + i).join('\n')));
  assert.deepEqual(
    session.diagnosticLines,
    Array.from({ length: 20 }, (_, i) => 'line ' + (80 + i)),
  );
  session.stderr.emit('data', Buffer.from('\n' + 'x'.repeat(100000)));
  assert.deepEqual(session.diagnosticLines, ['x'.repeat(16384)]);
});

test('session diagnostics survive exit, remain isolated on replacement and drain trailing stderr', (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  let first = ffmpeg.createSession('camera', 'one', [], 'live');
  first.stderr.emit('data', Buffer.from('first failure\n'));
  let second = ffmpeg.createSession('camera', 'one', [], 'live');
  second.stderr.emit('data', Buffer.from('second session\n'));
  first.process.emit('exit', 1, null);
  first.process.emit('close', 1, null);
  assert.equal(ffmpeg.hasSession('camera', 'one', 'live'), true);
  assert.deepEqual(first.diagnosticLines, ['first failure']);
  assert.deepEqual(second.diagnosticLines, ['second session']);
  second.process.emit('exit', 1, null);
  assert.equal(ffmpeg.hasSession('camera', 'one', 'live'), false);
  second.stderr.emit('data', Buffer.from('final pipe output'));
  second.stderr.emit('end');
  second.process.emit('close', 1, null);
  assert.deepEqual(second.diagnosticLines, ['second session', 'final pipe output']);
  assert.deepEqual(first.diagnosticLines, ['first failure']);
});

test('startup failures are retained even when stderr is empty', (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  let callback = t.mock.fn();
  let session = ffmpeg.createSession('camera', 'one', [], 'record', callback);
  session.process.emit('error', new Error('ENOENT'));
  session.process.emit('close', -2, null);
  assert.equal(ffmpeg.hasSession('camera', 'one', 'record'), false);
  assert.deepEqual(session.diagnosticLines, ['Failed to start ffmpeg session "camera:one:record". Error was "ENOENT"']);
  assert.equal(callback.mock.calls[0].arguments[0], session.diagnosticLines[0]);
});

// Lifecycle assertions use process events and controlled timers instead of timing-sensitive sleeps.
test('session state and completion distinguish spawn, exit and fully drained pipes', async (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  let session = ffmpeg.createSession('camera', 'one', []);
  let complete = t.mock.fn();
  session.once(FFmpeg.SESSION_EVENT.COMPLETE, complete);
  assert.equal(session.state, FFmpeg.SESSION_STATE.STARTING);
  session.process.emit('spawn');
  assert.equal(session.state, FFmpeg.SESSION_STATE.RUNNING);
  let settled = false;
  session.finished.then(() => {
    settled = true;
  });
  session.process.emit('exit', 0, null);
  await Promise.resolve();
  assert.equal(session.state, FFmpeg.SESSION_STATE.EXITED);
  assert.equal(settled, false);
  assert.equal(ffmpeg.hasSession('camera', 'one'), false);
  assert.deepEqual(ffmpeg.listSessions(), ['camera:one:default']);
  session.stderr.emit('data', Buffer.from('final diagnostics'));
  session.process.emit('close', 0, null);
  let result = await session.finished;
  assert.deepEqual(result, { state: 'exited', code: 0, signal: null, error: undefined, expected: false });
  assert.deepEqual(session.diagnosticLines, ['final diagnostics']);
  assert.equal(complete.mock.callCount(), 1);
  assert.equal(complete.mock.calls[0].arguments[0], result);
  assert.deepEqual(ffmpeg.listSessions(), []);
});

test('startup failure and unexpected termination report one failed completion', async (t) => {
  for (let startupFailure of [true, false]) {
    await t.test(startupFailure === true ? 'failed spawn' : 'unexpected signal', async (t) => {
      let { ffmpeg } = createMockFFmpeg(t);
      let session = ffmpeg.createSession('camera', 'one', []);
      let complete = t.mock.fn();
      session.on(FFmpeg.SESSION_EVENT.COMPLETE, complete);
      let error = startupFailure === true ? new Error('ENOENT') : undefined;
      if (startupFailure === true) {
        session.process.emit('error', error);
      } else {
        session.process.emit('spawn');
        session.process.emit('exit', null, 'SIGKILL');
      }
      assert.equal(session.state, FFmpeg.SESSION_STATE.FAILED);
      assert.equal(complete.mock.callCount(), 0);
      session.process.emit('close', startupFailure === true ? -2 : null, startupFailure === true ? null : 'SIGKILL');
      let result = await session.finished;
      assert.equal(result.state, FFmpeg.SESSION_STATE.FAILED);
      assert.equal(result.error, error);
      assert.equal(result.expected, false);
      assert.equal(complete.mock.callCount(), 1);
      assert.deepEqual(ffmpeg.listSessions(), []);
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
  let session = ffmpeg.createSession('camera', 'one', []);
  session.process.emit('spawn');
  let finished = session.kill();
  assert.equal(finished, session.finished);
  assert.equal(session.state, FFmpeg.SESSION_STATE.STOPPING);
  assert.equal(ffmpeg.hasSession('camera', 'one'), false);
  assert.deepEqual(ffmpeg.listSessions(), ['camera:one:default']);
  assert.equal(session.kill(), finished);
  assert.equal(session.process.kill.mock.callCount(), 1);
  scheduled();
  assert.deepEqual(
    session.process.kill.mock.calls.map((call) => call.arguments[0]),
    ['SIGTERM', 'SIGKILL'],
  );
  session.process.emit('exit', null, 'SIGKILL');
  session.process.emit('close', null, 'SIGKILL');
  assert.equal((await finished).expected, true);
  assert.equal(session.state, FFmpeg.SESSION_STATE.EXITED);
  assert.equal(session.kill(), finished);
  assert.equal(session.process.kill.mock.callCount(), 2);
  assert.equal(
    clear.mock.calls.some((call) => call.arguments[0] === 123),
    true,
  );
});

test('stop before spawn remains stopping and explicit SIGKILL cancels graceful escalation', async (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  t.mock.method(timers, 'setTimeout', () => 123);
  let clear = t.mock.method(timers, 'clearTimeout', () => {});
  let session = ffmpeg.createSession('camera', 'one', []);
  assert.throws(() => session.kill('SIGTERM', -1), RangeError);
  assert.equal(session.state, FFmpeg.SESSION_STATE.STARTING);
  session.kill();
  session.process.emit('spawn');
  assert.equal(session.state, FFmpeg.SESSION_STATE.STOPPING);
  let finished = session.kill('SIGKILL');
  assert.equal(
    clear.mock.calls.some((call) => call.arguments[0] === 123),
    true,
  );
  session.process.emit('exit', null, 'SIGKILL');
  session.process.emit('close', null, 'SIGKILL');
  assert.equal((await finished).expected, true);
});

test('device shutdown awaits replacements and other session types without affecting another device', async (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  t.mock.method(timers, 'setTimeout', () => 123);
  t.mock.method(timers, 'clearTimeout', () => {});
  let first = ffmpeg.createSession('camera', 'one', [], 'live');
  let second = ffmpeg.createSession('camera', 'one', [], 'live');
  second.process.emit('spawn');
  let record = ffmpeg.createSession('camera', 'two', [], 'record');
  let other = ffmpeg.createSession('other', 'one', [], 'live');
  assert.equal(first.state, FFmpeg.SESSION_STATE.STOPPING);
  let settled = false;
  let shutdown = ffmpeg.killAllSessions('camera').then(() => {
    settled = true;
  });
  for (let session of [first, record]) {
    session.process.emit('exit', null, 'SIGKILL');
    session.process.emit('close', null, 'SIGKILL');
  }
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(other.state, FFmpeg.SESSION_STATE.STARTING);
  assert.equal(other.process.kill.mock.callCount(), 0);
  second.process.emit('exit', null, 'SIGKILL');
  second.process.emit('close', null, 'SIGKILL');
  await shutdown;
  assert.equal(settled, true);
  assert.deepEqual(ffmpeg.listSessions(), ['other:one:live']);
  other.process.emit('exit', 0, null);
  other.process.emit('close', 0, null);
  assert.deepEqual(await ffmpeg.killSession('missing', 'one'), []);
});

test(
  'real child processes confirm failed-spawn completion and forced shutdown',
  { timeout: 5000, skip: os.platform() === 'win32' },
  async (t) => {
    let { ffmpeg, spawn } = createMockFFmpeg(t);
    spawn.mock.mockImplementation((binary, args, options) => spawnProcess(args[0], args.slice(1), options));
    let failed = ffmpeg.createSession('camera', 'missing', ['/missing-ffmpeg-lifecycle-binary']);
    let failure = await failed.finished;
    assert.equal(failure.state, FFmpeg.SESSION_STATE.FAILED);
    assert.equal(failure.error.code, 'ENOENT');
    assert.equal(failure.expected, false);

    // The child explicitly ignores SIGTERM; stdout confirms its handler is installed before shutdown.
    let running = ffmpeg.createSession('camera', 'running', [
      process.execPath,
      '-e',
      'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000);',
    ]);
    t.after(() => running.kill('SIGKILL'));
    await new Promise((resolve) => running.stdout.once('data', resolve));
    assert.equal(running.state, FFmpeg.SESSION_STATE.RUNNING);
    let graceTimer = t.mock.method(timers, 'setTimeout', timers.setTimeout);
    assert.throws(() => running.kill('INVALID_SIGNAL'), { code: 'ERR_UNKNOWN_SIGNAL' });
    assert.equal(graceTimer.mock.callCount(), 0);
    assert.equal(running.state, FFmpeg.SESSION_STATE.RUNNING);
    let completion = await running.kill('SIGTERM', 10);
    assert.equal(completion.state, FFmpeg.SESSION_STATE.EXITED);
    assert.equal(completion.expected, true);
    assert.equal(completion.signal, 'SIGKILL');
    assert.deepEqual(ffmpeg.listSessions(), []);
  },
);

test('session events publish changed states before STARTED and COMPLETE without duplicate transitions', async (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  let session = ffmpeg.createSession('camera', 'events', []);
  let events = [];
  session.on(FFmpeg.SESSION_EVENT.STATE_CHANGED, (change) => {
    assert.equal(session.state, change.state);
    events.push(change);
  });
  session.on(FFmpeg.SESSION_EVENT.STARTED, (started) => {
    assert.equal(started, session);
    events.push('started');
  });
  session.on(FFmpeg.SESSION_EVENT.COMPLETE, () => events.push('complete'));
  session.process.emit('spawn');
  session.kill('SIGKILL');
  session.kill('SIGKILL');
  session.process.emit('exit', null, 'SIGKILL');
  session.process.emit('close', null, 'SIGKILL');
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
      let session = ffmpeg.createSession('camera', 'events', []);
      let started = t.mock.fn();
      let changes = [];
      session.on(FFmpeg.SESSION_EVENT.STARTED, started);
      session.on(FFmpeg.SESSION_EVENT.STATE_CHANGED, (change) => changes.push(change));
      if (failed === true) {
        session.process.emit('error', new Error('ENOENT'));
        assert.equal(session.diagnosticLines.length, 1);
        session.process.emit('close', -2, null);
        assert.deepEqual(changes, [{ state: FFmpeg.SESSION_STATE.FAILED, previousState: FFmpeg.SESSION_STATE.STARTING }]);
      } else {
        session.kill('SIGKILL');
        session.process.emit('spawn');
        session.process.emit('exit', null, 'SIGKILL');
        session.process.emit('close', null, 'SIGKILL');
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
  let session = ffmpeg.createSession('camera', 'events', []);
  session.on(FFmpeg.SESSION_EVENT.STATE_CHANGED, ({ state }) => {
    if (state === FFmpeg.SESSION_STATE.STOPPING) {
      session.kill('SIGKILL');
    }
  });
  session.kill();
  assert.deepEqual(
    session.process.kill.mock.calls.map((call) => call.arguments[0]),
    ['SIGTERM', 'SIGKILL'],
  );
  assert.equal(
    clear.mock.calls.some((call) => call.arguments[0] === 123),
    true,
  );
  session.process.emit('exit', null, 'SIGKILL');
  session.process.emit('close', null, 'SIGKILL');
  await session.finished;
});

test('invalid pipe counts default to stdin, stdout and stderr', (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  let counts = ['4', null, NaN, Infinity, 3.5, {}];
  for (let [index, pipeCount] of counts.entries()) {
    let session = ffmpeg.createSession('camera', String(index), [], 'default', undefined, pipeCount);
    assert.equal(session.stdio.length, 3);
    assert.equal(ffmpeg.hasSession('camera', String(index)), true);
  }
});

test('integer pipe counts retain the minimum and additional media pipes', (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  for (let count of [-1, 0, 2, 3, 4]) {
    let session = ffmpeg.createSession('camera', String(count), [], 'default', undefined, count);
    assert.equal(session.stdio.length, Math.max(3, count));
  }
});

test('synchronously rejected replacement arguments leave the running session intact', (t) => {
  let { ffmpeg, spawn } = createMockFFmpeg(t);
  let original = ffmpeg.createSession('camera', 'one', []);
  original.process.emit('spawn');
  spawn.mock.mockImplementation((...args) => spawnProcess(...args));
  assert.throws(() => ffmpeg.createSession('camera', 'one', ['\0']), { code: 'ERR_INVALID_ARG_VALUE' });
  assert.equal(original.state, FFmpeg.SESSION_STATE.RUNNING);
  assert.equal(original.process.kill.mock.callCount(), 0);
  assert.equal(ffmpeg.hasSession('camera', 'one'), true);
});

test('asynchronous replacement startup failure leaves the running session intact', async (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  let original = ffmpeg.createSession('camera', 'one', []);
  original.process.emit('spawn');
  let replacement = ffmpeg.createSession('camera', 'one', []);
  replacement.process.emit('error', new Error('ENOENT'));
  replacement.process.emit('close', -2, null);
  assert.equal((await replacement.finished).state, FFmpeg.SESSION_STATE.FAILED);
  assert.equal(original.state, FFmpeg.SESSION_STATE.RUNNING);
  assert.equal(original.process.kill.mock.callCount(), 0);
  assert.equal(ffmpeg.hasSession('camera', 'one'), true);
});

test('older replacement startup cannot stop a newer pending request', async (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  t.mock.method(timers, 'setTimeout', () => 123);
  t.mock.method(timers, 'clearTimeout', () => {});
  let original = ffmpeg.createSession('camera', 'one', []);
  original.process.emit('spawn');
  let older = ffmpeg.createSession('camera', 'one', []);
  let newer = ffmpeg.createSession('camera', 'one', []);
  older.process.emit('spawn');
  assert.equal(original.state, FFmpeg.SESSION_STATE.STOPPING);
  assert.equal(newer.state, FFmpeg.SESSION_STATE.STARTING);
  assert.equal(newer.process.kill.mock.callCount(), 0);
  newer.process.emit('spawn');
  assert.equal(older.state, FFmpeg.SESSION_STATE.STOPPING);
  assert.equal(newer.state, FFmpeg.SESSION_STATE.RUNNING);
  let stopped = ffmpeg.killAllSessions('camera');
  for (let session of [original, older, newer]) {
    session.process.emit('exit', null, 'SIGKILL');
    session.process.emit('close', null, 'SIGKILL');
  }
  await stopped;
});

test('EPIPE stays silent while other pipe errors reach diagnostics and completion', async (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  let callback = t.mock.fn();
  let session = ffmpeg.createSession('camera', 'one', [], 'live', callback, 4);
  session.process.emit('spawn');
  for (let pipe of session.stdio) {
    pipe.emit('error', Object.assign(new Error('Broken pipe'), { code: 'EPIPE' }));
  }
  assert.equal(callback.mock.callCount(), 0);
  assert.deepEqual(session.diagnosticLines, []);
  let error = Object.assign(new Error('I/O failure'), { code: 'EIO' });
  session.stdio[3].emit('error', error);
  assert.equal(callback.mock.callCount(), 1);
  assert.deepEqual(session.diagnosticLines, ['Error on ffmpeg session "camera:one:live" pipe 3. Error was "I/O failure"']);
  assert.equal(callback.mock.calls[0].arguments[0], session.diagnosticLines[0]);
  // A pipe error does not mean the child exited; teardown must still be able to signal it.
  assert.equal(session.state, FFmpeg.SESSION_STATE.RUNNING);
  session.process.emit('exit', 0, null);
  session.process.emit('close', 0, null);
  let result = await session.finished;
  assert.equal(result.state, FFmpeg.SESSION_STATE.FAILED);
  assert.equal(result.error, error);
  assert.equal(result.expected, false);
});

test('unsuccessful signals leave the session active and do not schedule forced termination', async (t) => {
  let { ffmpeg } = createMockFFmpeg(t);
  let schedule = t.mock.method(timers, 'setTimeout', () => 123);
  let session = ffmpeg.createSession('camera', 'one', []);
  session.process.emit('spawn');
  t.mock.method(session.process, 'kill', () => false);
  assert.equal(session.kill(), session.finished);
  assert.equal(schedule.mock.callCount(), 0);
  assert.equal(session.state, FFmpeg.SESSION_STATE.RUNNING);
  session.process.emit('exit', 1, null);
  session.process.emit('close', 1, null);
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
