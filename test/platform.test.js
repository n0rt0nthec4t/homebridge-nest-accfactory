// Exercise registration, device discovery and cache/shutdown boundaries using the real platform modules.
// Temporary plugin fixtures isolate invalid modules without changing the production registry.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import hap from './helpers/homebridge-hap.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { importSource } from './helpers/import-source.js';
import HomeKitDevice from '../src/HomeKitDevice/HomeKitDevice.js';
import { DEVICE_TYPE, DEVICE_CATEGORY_MAP } from '../src/consts.js';

let { default: registerPlatform } = await importSource(new URL('../src/index.js', import.meta.url));
let { loadDeviceModules, getDeviceHKCategory } = await importSource(new URL('../src/devices.js', import.meta.url));
let { default: Platform } = await importSource(new URL('../src/system.js', import.meta.url));
let log = { debug() {}, info() {}, warn() {}, error() {}, success() {} };

for (let api of [undefined, null, {}, { registerPlatform: true }]) {
  test('entry rejects invalid Homebridge registration API: ' + JSON.stringify(api), () => {
    assert.throws(() => registerPlatform(api), /Invalid Homebridge API object/);
  });
}
test('entry registers the real platform and shared Eve metadata', () => {
  let calls = [];
  registerPlatform({ registerPlatform: (...args) => calls.push(args) });
  assert.deepEqual(calls, [['NestAccfactory', Platform]]);
  assert.equal(HomeKitDevice.PLUGIN_NAME, 'homebridge-nest-accfactory');
  assert.equal(typeof HomeKitDevice.EVEHOME, 'function');
});

test('registry loads every supported device family and only device subclasses', async () => {
  let registry = await loadDeviceModules(log, 'plugins');
  let expected = Object.values(DEVICE_TYPE)
    .filter((type) => type !== DEVICE_TYPE.ALARM)
    .sort();
  assert.deepEqual([...registry.keys()].sort(), expected);
  for (let [type, entry] of registry) {
    assert.equal(HomeKitDevice.prototype.isPrototypeOf(entry.class.prototype), true, type);
    assert.equal(typeof entry.processRawData, 'function', type);
    assert.equal(getDeviceHKCategory(type), DEVICE_CATEGORY_MAP[type] ?? 1);
  }
  assert.equal(getDeviceHKCategory('unknown'), hap.Categories.OTHER);
});

test('registry skips invalid and failing modules while keeping deterministic first registration', async (context) => {
  let directory = await mkdtemp(path.join(tmpdir(), 'nest-registry-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let base = new URL('../src/HomeKitDevice/HomeKitDevice.js', import.meta.url).href;
  let preamble = 'import HomeKitDevice from ' + JSON.stringify(base) + ';\n';
  for (let [name, source] of [
    [
      '01-valid.js',
      preamble +
        'export default class extends HomeKitDevice { static TYPE = "fixture"; static VERSION = "test"; }\n' +
        'export function processRawData() { return "mapped"; }',
    ],
    ['02-duplicate.js', preamble + 'export default class extends HomeKitDevice { static TYPE = "fixture"; static VERSION = "duplicate"; }'],
    ['03-missing.js', preamble + 'export default class extends HomeKitDevice { static TYPE = ""; }'],
    ['04-unrelated.js', 'export default class {}; export const ignored = 1;'],
    ['05-failure.js', 'throw new Error("Fixture import failure");'],
    ['06-not-code.txt', 'This is not a JavaScript module'],
  ]) {
    await writeFile(path.join(directory, name), source);
  }
  let warnings = [];
  let registry = await loadDeviceModules(
    { ...log, warn: (...args) => warnings.push(args) },
    path.relative(fileURLToPath(new URL('../src/', import.meta.url)), directory),
  );
  assert.deepEqual([...registry.keys()], ['fixture']);
  assert.equal(registry.get('fixture').class.VERSION, 'test');
  assert.equal(registry.get('fixture').processRawData(), 'mapped');
  assert.equal(warnings.length, 2);
  assert.equal(warnings[0][1], '03-missing.js');
  assert.equal(warnings[1][1], '05-failure.js');
  await assert.rejects(loadDeviceModules(log, path.join(directory, 'missing')), /ENOENT/);
});

test('platform restores valid cached identity, removes stale cache and shuts down without accounts', async (context) => {
  let callbacks = new Map();
  let removed = [];
  let errors = [];
  let api = { hap, on: (event, handler) => callbacks.set(event, handler), unregisterPlatformAccessories: (...args) => removed.push(args) };
  let platform = new Platform({ ...log, error: (...args) => errors.push(args) }, {}, api);
  context.after(() => callbacks.get('shutdown')());
  let accessory = new hap.Accessory('Cached sensor', hap.uuid.generate('platform-cache'));
  platform.configureAccessory(accessory);
  assert.equal(platform.cachedAccessories[0], accessory);
  let stale = { displayName: 'Stale', getService() {} };
  platform.configureAccessory(stale);
  assert.deepEqual(removed, [['homebridge-nest-accfactory', 'NestAccfactory', [stale]]]);
  assert.deepEqual(platform.cachedAccessories, [accessory]);
  await callbacks.get('didFinishLaunching')();
  assert.equal(
    errors.some((entry) => entry[0].includes('No active connections')),
    true,
  );
  await callbacks.get('shutdown')();
  assert.deepEqual(platform.cachedAccessories, []);
  await callbacks.get('shutdown')();
});
