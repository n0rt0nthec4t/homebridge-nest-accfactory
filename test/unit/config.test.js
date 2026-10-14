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
import { processConfig } from '../../src/config.js';

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
  let schema = JSON.parse(await readFile(new URL('../../config.schema.json', import.meta.url), 'utf8'));
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
