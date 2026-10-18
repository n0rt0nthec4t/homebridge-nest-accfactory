// Verify configuration normalization, viewer limits and protected migration without probing a real executable.
import assert from 'node:assert/strict';
import child_process from 'node:child_process';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { URL } from 'node:url';
import { processConfig } from '../src/config.js';

for (let mode of [0o600, 0o640, 0o400]) {
  for (let existing of [false, true]) {
    test(
      'migration preserves mode ' + mode.toString(8) + ' with existing sidecars=' + existing,
      {
        skip: process.platform === 'win32' ? 'POSIX permission bits are not Windows ACLs' : false,
      },
      (t) => {
        t.mock.method(child_process, 'spawnSync', () => ({ error: new Error('No test FFmpeg') }));
        let directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-config-permissions-'));
        t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
        let configPath = path.join(directory, 'config.json');
        let platform = { platform: 'NestAccfactory', nest: { access_token: 'synthetic-migration-token' }, devices: {} };
        let original = JSON.stringify({ platforms: [platform], bridge: { name: 'Unchanged' } });
        fs.writeFileSync(configPath, original, { mode });
        // chmod makes the fixture independent of the process umask.
        fs.chmodSync(configPath, mode);
        if (existing === true) {
          for (let suffix of ['.bak', '.tmp']) {
            fs.writeFileSync(configPath + suffix, 'old contents to replace completely');
            fs.chmodSync(configPath + suffix, 0o666);
          }
        }
        let securedWrites = [];
        let writeFileSync = fs.writeFileSync;
        t.mock.method(fs, 'writeFileSync', (descriptor, ...args) => {
          assert.equal(typeof descriptor, 'number');
          securedWrites.push(fs.fstatSync(descriptor).mode & 0o777);
          return writeFileSync(descriptor, ...args);
        });
        processConfig(structuredClone(platform), { warn() {}, info() {}, debug() {} }, { user: { configPath: () => configPath } });
        assert.deepEqual(securedWrites, [mode & 0o600, mode], 'permissions must be set before either credential write');
        assert.equal(fs.statSync(configPath).mode & 0o777, mode);
        assert.equal(fs.statSync(configPath + '.bak').mode & 0o777, mode & 0o600);
        assert.equal(fs.readFileSync(configPath + '.bak', 'utf8'), original);
        assert.equal(fs.existsSync(configPath + '.tmp'), false);
        let migrated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(migrated.platforms[0].accounts[0].access_token, 'synthetic-migration-token');
        assert.equal(migrated.platforms[0].nest, undefined);
        assert.deepEqual(migrated.platforms[0].devices, []);
        assert.deepEqual(migrated.bridge, { name: 'Unchanged' });
      },
    );
  }
}

for (let [operation, failureAt] of [
  ['fchmodSync', 1],
  ['fchmodSync', 2],
  ['writeFileSync', 1],
  ['writeFileSync', 2],
  ['renameSync', 1],
]) {
  test('migration keeps the original config after ' + operation + ' call ' + failureAt + ' fails', (t) => {
    t.mock.method(child_process, 'spawnSync', () => ({ error: new Error('No test FFmpeg') }));
    let directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-config-failure-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let configPath = path.join(directory, 'config.json');
    let platform = { platform: 'NestAccfactory', nest: { access_token: 'synthetic-migration-token' }, devices: {} };
    let original = JSON.stringify({ platforms: [platform] });
    fs.writeFileSync(configPath, original, { mode: 0o600 });
    fs.writeFileSync(configPath + '.bak', 'existing backup');
    let warnings = [];
    let originalOperation = fs[operation];
    let calls = 0;
    t.mock.method(fs, operation, (...args) => {
      calls++;
      if (calls === failureAt) {
        throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
      }
      return originalOperation(...args);
    });
    let runtime = processConfig(
      structuredClone(platform),
      { warn: (...args) => warnings.push(args), info() {}, debug() {} },
      { user: { configPath: () => configPath } },
    );
    assert.equal(fs.readFileSync(configPath, 'utf8'), original);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
    }
    assert.equal(fs.existsSync(configPath + '.tmp'), false);
    assert.equal(runtime.accounts[0].access_token, 'synthetic-migration-token');
    assert.equal(
      warnings.some((entry) => String(entry[0]).includes('permission denied') === true),
      true,
    );
    if (operation === 'fchmodSync' && failureAt === 1) {
      assert.equal(fs.readFileSync(configPath + '.bak', 'utf8'), 'existing backup');
    }
    if (failureAt === 2 || operation === 'renameSync') {
      assert.equal(fs.readFileSync(configPath + '.bak', 'utf8'), original);
    }
  });
}

test('missing, null and malformed options receive defaults while valid settings are preserved', (t) => {
  t.mock.method(child_process, 'spawnSync', () => ({ error: new Error('No test FFmpeg') }));
  let log = { warn() {}, info() {}, debug() {} };
  for (let options of [undefined, null, [], 'invalid', 1, true]) {
    let config = processConfig({ options }, log, {});
    assert.equal(Array.isArray(config.options), false);
    assert.equal(config.options.eveHistory, true);
    assert.equal(config.options.maxStreams, 2);
    assert.equal(config.options.useNestAPI, true);
    assert.equal(config.options.useGoogleAPI, true);
  }
  let options = { eveHistory: false, maxStreams: 3, useNestAPI: false, ffmpegDebug: true };
  let config = processConfig({ options }, log, {});
  assert.equal(config.options, options);
  assert.equal(config.options.eveHistory, false);
  assert.equal(config.options.maxStreams, 3);
  assert.equal(config.options.useNestAPI, false);
  assert.equal(config.options.ffmpeg.debug, true);
});

test('maxStreams preserves integer counts from one to four and defaults invalid counts', async (t) => {
  t.mock.method(child_process, 'spawnSync', () => ({ error: new Error('No test FFmpeg') }));
  let schema = JSON.parse(await readFile(new URL('../config.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(schema.schema.properties.options.properties.maxStreams, { type: 'integer', default: 2, minimum: 1, maximum: 4 });
  for (let [value, expected] of [
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 4],
    ['1', 1],
    [undefined, 2],
    [0, 2],
    [5, 2],
    [1.5, 2],
    [NaN, 2],
  ]) {
    let config = { accounts: [], options: { maxStreams: value }, devices: [], homes: [] };
    let log = { warn() {}, info() {}, debug() {} };
    assert.equal(processConfig(config, log, {}).options.maxStreams, expected, 'Viewer count ' + value);
  }
});

for (let [label, version, missing, valid] of [
  ['supported codecs', '7.1', '', true],
  ['old binary', '7.0', '', false],
  ['missing AAC', '8.0', 'libfdk_aac', false],
  ['missing Opus', '8.0', 'libopus', false],
  ['missing H264', '8.0', 'libx264', false],
  ['missing Speex', '8.0', 'libspeex', false],
]) {
  test('configuration enforces FFmpeg minimum support: ' + label, (context) => {
    context.mock.method(child_process, 'spawnSync', (binary, args) => ({
      status: 0,
      stdout:
        {
          '-version': 'ffmpeg version ' + version + ' ',
          '-encoders': ['libx264', 'libfdk_aac', 'libopus']
            .filter((name) => name !== missing)
            .map((name) => ' A..... ' + name)
            .join('\n'),
          '-decoders': missing === 'libspeex' ? '' : ' A..... libspeex',
          '-muxers': '',
          '-demuxers': '',
        }[args[0]] ?? '',
    }));
    let warnings = [];
    let log = { warn: (...args) => warnings.push(args), info() {}, debug() {} };
    let config = processConfig({ options: { ffmpegPath: 'fixture-ffmpeg', debug: true } }, log, {});
    assert.equal(config.options.ffmpeg.valid, valid);
    if (valid === true) {
      assert.equal(config.options.ffmpeg.version, version);
      assert.equal(config.options.ffmpeg.binary, 'fixture-ffmpeg');
      assert.equal(
        warnings.some((entry) => String(entry[0]).includes('minimum support')),
        false,
      );
    } else {
      assert.equal(
        warnings.some((entry) => String(entry[0]).includes('minimum support')),
        true,
      );
    }
  });
}

test('legacy Google/Nest accounts migrate together and malformed placeholder overrides are discarded', (context) => {
  context.mock.method(child_process, 'spawnSync', () => ({ error: new Error('Fixture probe unavailable') }));
  let config = processConfig(
    {
      nest: { access_token: ' fixture-nest ', fieldTest: true },
      google: { issuetoken: ' fixture-issue ', cookie: ' fixture-cookie ', fieldTest: false },
      devices: [{ serialNumber: '' }, null, { serialNumber: 'SERIAL' }],
      homes: [null, { name: '' }, { name: 'Home' }],
    },
    { warn() {}, info() {}, debug() {} },
    {},
  );
  assert.deepEqual(config.accounts, [
    { name: 'Nest', type: 'nest', access_token: 'fixture-nest', fieldTest: true },
    { name: 'Google', type: 'google', issueToken: 'fixture-issue', cookie: 'fixture-cookie', fieldTest: false },
  ]);
  assert.deepEqual(config.devices, [{ serialNumber: 'SERIAL' }]);
  assert.deepEqual(config.homes, [{ name: 'Home' }]);
});
for (let [label, contents] of [
  ['malformed JSON', 'not JSON'],
  ['no platforms', '{}'],
  ['no matching legacy platform', JSON.stringify({ platforms: [{ platform: 'Other' }] })],
  [
    'ambiguous platforms',
    JSON.stringify({
      platforms: [
        { platform: 'NestAccfactory', nest: { access_token: 'one' } },
        { platform: 'NestAccfactory', nest: { access_token: 'two' } },
      ],
    }),
  ],
]) {
  test('unsafe migration keeps the original config intact: ' + label, (context) => {
    context.mock.method(child_process, 'spawnSync', () => ({ error: new Error('Fixture probe unavailable') }));
    let directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-config-validation-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let file = path.join(directory, 'config.json');
    fs.writeFileSync(file, contents);
    let warnings = [];
    let migrated = processConfig(
      { nest: { access_token: 'fixture-nest' } },
      { warn: (...args) => warnings.push(args), info() {}, debug() {} },
      { user: { configPath: () => file } },
    );
    assert.equal(migrated.accounts[0].access_token, 'fixture-nest');
    assert.equal(fs.readFileSync(file, 'utf8'), contents);
    assert.equal(fs.existsSync(file + '.bak'), false);
    assert.ok(warnings.length > 0);
  });
}

for (let failure of ['backup disappears', 'temporary file cleanup fails']) {
  test('migration preserves startup and the original config when ' + failure, (context) => {
    context.mock.method(child_process, 'spawnSync', () => ({ error: new Error('Fixture probe unavailable') }));
    let directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-config-recovery-'));
    context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let file = path.join(directory, 'config.json');
    let platform = { platform: 'NestAccfactory', nest: { access_token: 'fixture-token' } };
    let original = JSON.stringify({ platforms: [platform] });
    fs.writeFileSync(file, original);
    if (failure === 'backup disappears') {
      let exists = fs.existsSync;
      context.mock.method(fs, 'existsSync', (target) => (target === file + '.bak' ? false : exists(target)));
    } else {
      context.mock.method(fs, 'renameSync', () => {
        throw new Error('Fixture rename failed');
      });
      context.mock.method(fs, 'unlinkSync', () => {
        throw new Error('Fixture cleanup failed');
      });
    }
    let warnings = [];
    let config = processConfig(
      structuredClone(platform),
      { warn: (...args) => warnings.push(args), info() {} },
      { user: { configPath: () => file } },
    );
    assert.equal(config.accounts[0].access_token, 'fixture-token');
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.equal(fs.readFileSync(file + '.bak', 'utf8'), original);
    assert.equal(fs.existsSync(file + '.tmp'), failure === 'temporary file cleanup fails');
    assert.equal(
      warnings.some((entry) =>
        entry.includes(failure === 'backup disappears' ? 'unable to verify config backup was created' : 'Fixture rename failed'),
      ),
      true,
    );
    assert.equal(
      warnings.some((entry) => String(entry[0]).includes('migrated in memory')),
      true,
    );
  });
}

test('migration updates only the legacy platform and preserves an already migrated platform', (context) => {
  context.mock.method(child_process, 'spawnSync', () => ({ error: new Error('Fixture probe unavailable') }));
  let directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-config-platforms-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let file = path.join(directory, 'config.json');
  let current = { platform: 'NestAccfactory', accounts: [{ name: 'Existing', type: 'nest', access_token: 'existing' }], devices: [] };
  let legacy = { platform: 'NestAccfactory', google: { issuetoken: 'issue', cookie: 'cookie' }, devices: { SERIAL: { exclude: true } } };
  fs.writeFileSync(file, JSON.stringify({ platforms: [current, legacy] }));
  let result = processConfig(structuredClone(legacy), { warn() {}, info() {} }, { user: { configPath: () => file } });
  let saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.platforms[0], current);
  assert.deepEqual(saved.platforms[1], {
    platform: 'NestAccfactory',
    accounts: result.accounts,
    devices: [{ serialNumber: 'SERIAL', exclude: true }],
  });
});

for (let devices of [{ SERIAL: null }, { SERIAL: [] }, { SERIAL: false }]) {
  test('invalid legacy device entries do not trigger a partial migration: ' + JSON.stringify(devices), (context) => {
    context.mock.method(child_process, 'spawnSync', () => ({ error: new Error('Fixture probe unavailable') }));
    let config = processConfig(
      { devices },
      { warn() {}, info() {} },
      { user: { configPath: () => assert.fail('invalid device entries must not trigger persistence') } },
    );
    assert.equal(config.devices, devices);
    assert.deepEqual(config.accounts, []);
  });
}

test('explicit configuration flags preserve disabled APIs and route debug parameters to the logger', (context) => {
  context.mock.method(child_process, 'spawnSync', () => ({ error: new Error('Fixture probe unavailable') }));
  let messages = [];
  let log = { warn() {}, info: (...args) => messages.push(args) };
  let config = processConfig(
    {
      options: {
        debug: true,
        supportDump: true,
        exclude: true,
        useGoogleAPI: false,
        useNestAPI: false,
        eveHistory: false,
        logMotionEvents: false,
      },
    },
    log,
    {},
  );
  for (let key of ['debug', 'supportDump', 'exclude']) {
    assert.equal(config.options[key], true);
  }
  for (let key of ['useGoogleAPI', 'useNestAPI', 'eveHistory', 'logMotionEvents']) {
    assert.equal(config.options[key], false);
  }
  log.debug('Fixture %s', 'parameter');
  assert.equal(messages.length, 1);
  assert.equal(messages[0][0].replace(/\u001b\[[0-9;]*m/g, ''), 'Fixture %s');
  assert.equal(messages[0][1], 'parameter');
});

test('migration reports non-Error failures without losing the in-memory configuration', (context) => {
  context.mock.method(child_process, 'spawnSync', () => ({ error: new Error('Fixture probe unavailable') }));
  let warnings = [];
  let config = processConfig(
    { nest: { access_token: 'fixture-token' } },
    { warn: (...args) => warnings.push(args), info() {} },
    {
      user: {
        configPath: () => {
          throw 'Fixture config path unavailable';
        },
      },
    },
  );
  assert.equal(config.accounts[0].access_token, 'fixture-token');
  assert.equal(
    warnings.some((entry) => entry[1] === 'Fixture config path unavailable'),
    true,
  );
});

test('configuration publishes a successfully probed hardware encoder and debug details', (context) => {
  // Simulate a usable VideoToolbox encoder at the process boundary; no hardware is exercised.
  context.mock.method(os, 'platform', () => 'darwin');
  context.mock.method(child_process, 'spawnSync', (binary, args) => ({
    status: 0,
    stdout:
      {
        '-version': 'ffmpeg version 7.1 ',
        '-encoders': ' V..... libx264\n A..... libfdk_aac\n A..... libopus\n V..... h264_videotoolbox',
        '-decoders': ' A..... libspeex',
        '-hide_banner': Buffer.from([0, 0, 0, 1, 0x65, 1]),
      }[args[0]] ?? '',
  }));
  let messages = [];
  let log = { warn: () => assert.fail('fixture has all required codecs'), info: (...args) => messages.push(args) };
  let config = processConfig({ options: { ffmpegPath: 'fixture-config-hardware-ffmpeg', debug: true } }, log, {});
  assert.equal(config.options.ffmpeg.valid, true);
  assert.equal(config.options.ffmpeg.hwaccel, true);
  assert.equal(config.options.ffmpeg.binary, 'fixture-config-hardware-ffmpeg');
  assert.equal(messages.at(-1).at(-1), 'h264_videotoolbox');
  // Debug logging is deliberately disabled on the runtime logger when not requested.
  let quiet = { info: () => assert.fail('disabled debug must stay silent'), warn() {} };
  processConfig({ options: { debug: false } }, quiet, {});
  quiet.debug('Fixture message');
});
