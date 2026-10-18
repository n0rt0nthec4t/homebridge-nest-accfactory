// Verify protobuf-only Home/Away discovery, stable identity and occupancy updates without starting Homebridge.
import assert from 'node:assert/strict';
import { importSource } from './helpers/import-source.js';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { URL } from 'node:url';
import { DATA_SOURCE, DEVICE_TYPE, NESTLABS_MAC_PREFIX } from '../src/consts.js';
import { crc24 } from '../src/utils.js';

let location = new URL('../src/plugins/homeaway.js', import.meta.url);
let parent = 'data:text/javascript,' + encodeURIComponent('export default class { static makeValidHKName(name) { return name; } }');
let source = (await readFile(location, 'utf8')).replace(/from '([^']+)'/g, (match, specifier) => {
  return 'from ' + JSON.stringify(specifier === '../HomeKitDevice.js' ? parent : new URL(specifier, location).href);
});
let { default: HomeAway, processRawData } = await importSource(location, source);
let changed = new Map([['STRUCTURE_HOME', { fields: new Set(['structure_info', 'structure_mode']) }]]);

function structure(mode) {
  return {
    source: DATA_SOURCE.GOOGLE,
    value: {
      structure_info: { rtsStructureId: 'structure.home', name: 'Home' },
      structure_mode: { structureMode: mode },
    },
  };
}

test('Home/Away ignores REST structures regardless of arrival order and preserves existing identity', () => {
  let rest = ['structure.home', { source: DATA_SOURCE.NEST, value: { name: 'Home', away: false } }];
  let google = ['STRUCTURE_HOME', structure('STRUCTURE_MODE_AWAY')];
  let serial = NESTLABS_MAC_PREFIX + crc24(DEVICE_TYPE.HOMEAWAY.toUpperCase() + ':STRUCTURE.HOME').toUpperCase();
  assert.deepEqual(processRawData(undefined, Object.fromEntries([rest]), { options: {} }, undefined, changed), {});
  for (let entries of [
    [rest, google],
    [google, rest],
  ]) {
    let devices = processRawData(undefined, Object.fromEntries(entries), { options: {} }, undefined, changed);
    assert.deepEqual(Object.keys(devices), [serial]);
    assert.equal(devices[serial].full, true);
    assert.equal(devices[serial].data.nest_google_device_uuid, 'STRUCTURE_HOME');
    assert.equal(devices[serial].data.occupancy, false);
  }
});

test('Home/Away requires a recognised mode and maps all defined modes consistently', () => {
  for (let mode of [undefined, 'STRUCTURE_MODE_UNSPECIFIED', 'UNKNOWN']) {
    let devices = processRawData(undefined, { STRUCTURE_HOME: structure(mode) }, { options: {} }, undefined, changed);
    assert.equal(Object.values(devices)[0].full, false);
    assert.equal(Object.values(devices)[0].data.occupancy, undefined);
  }
  for (let mode of ['HOME', 'AWAY', 'SLEEP', 'VACATION']) {
    let devices = processRawData(undefined, { STRUCTURE_HOME: structure('STRUCTURE_MODE_' + mode) }, { options: {} }, undefined, changed);
    assert.equal(Object.values(devices)[0].full, true);
    assert.equal(Object.values(devices)[0].data.occupancy, mode === 'HOME');
  }
});

test('Home/Away mode-only deltas retain identity and update HomeKit despite active nested occupancy', () => {
  let raw = { STRUCTURE_HOME: structure('STRUCTURE_MODE_HOME') };
  let initial = processRawData(undefined, raw, { options: {} }, undefined, changed);
  let serial = Object.keys(initial)[0];
  let updates = [];
  let target = {
    deviceData: initial[serial].data,
    occupancyService: { updateCharacteristic: (...args) => updates.push(args) },
    hap: { Characteristic: { OccupancyDetected: { OCCUPANCY_DETECTED: 1, OCCUPANCY_NOT_DETECTED: 0 } } },
  };
  for (let mode of ['AWAY', 'HOME']) {
    raw.STRUCTURE_HOME.value.structure_mode = {
      structureMode: 'STRUCTURE_MODE_' + mode,
      occupancy: { activity: 'ACTIVITY_ACTIVE', presence: 'PRESENCE_UNAVAILABLE' },
    };
    let delta = processRawData(
      undefined,
      raw,
      { options: {} },
      undefined,
      new Map([['STRUCTURE_HOME', { fields: new Set(['structure_mode']) }]]),
    );
    assert.deepEqual(Object.keys(delta), [serial]);
    assert.equal(delta[serial].full, true, 'mode-only updates reuse the cached discovery fields');
    HomeAway.prototype.onUpdate.call(target, { ...initial[serial].data, ...delta[serial].data });
  }
  assert.deepEqual(
    updates.map((args) => args[1]),
    [0, 1],
  );
});

test('Home/Away publishes the translated occupancy supplied by the lifecycle', () => {
  let updates = [];
  let target = {
    deviceData: { occupancy: true },
    occupancyService: { updateCharacteristic: (...args) => updates.push(args) },
    hap: { Characteristic: { OccupancyDetected: { OCCUPANCY_DETECTED: 1, OCCUPANCY_NOT_DETECTED: 0 } } },
  };
  HomeAway.prototype.onUpdate.call(target, { occupancy: true });
  HomeAway.prototype.onUpdate.call(target, { occupancy: false });
  assert.deepEqual(
    updates.map((args) => args[1]),
    [1, 0],
  );
});
