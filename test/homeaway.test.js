// Verify protobuf-only Home/Away discovery, stable identity and occupancy updates without starting Homebridge.
import { getResourceKey } from '../src/utils.js';
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
    source: DATA_SOURCE.PROTOBUF,
    value: {
      structure_info: { rtsStructureId: 'structure.home', name: 'Home' },
      structure_mode: { structureMode: mode },
    },
  };
}

test('Home/Away ignores REST structures regardless of arrival order and preserves existing identity', () => {
  let rest = ['structure.home', { source: 'Nest', value: { name: 'Home', away: false } }];
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

const homegraphId = getResourceKey('account', 'HomeGraph', 'foyer-home', 'STRUCTURE');
const homegraphSerial = NESTLABS_MAC_PREFIX + crc24(DEVICE_TYPE.HOMEAWAY.toUpperCase() + ':FOYER-HOME').toUpperCase();
function homegraphStructure(state) {
  return {
    source: DATA_SOURCE.HOMEGRAPH,
    value: {
      home: {
        uuid: 'foyer-home',
        name: 'Home',
        address: { addressComponents: { city: 'Sydney', state: 'NSW' } },
        traits: [
          {
            name: 'home.platform.traits.AreaPresenceStateTrait',
            fields: {
              presenceState: { stringValue: state },
              featureMap: { numberValue: 1 },
            },
          },
        ],
      },
    },
  };
}

test('HomeGraph Home/Away uses its home identity and maps only confirmed occupied/vacant states', () => {
  let raw = { [homegraphId]: homegraphStructure('PRESENCE_STATE_OCCUPIED') };
  let config = { options: {}, homes: [{ homegraph_home_uuid: homegraphId, exclude: true }] };
  for (let [state, expected] of [
    ['PRESENCE_STATE_OCCUPIED', true],
    ['PRESENCE_STATE_VACANT', false],
  ]) {
    raw[homegraphId].value.home.traits[0].fields.presenceState.stringValue = state;
    let result = processRawData(undefined, raw, config, undefined, new Map([[homegraphId, { fields: new Set(['home']) }]]));
    assert.deepEqual(Object.keys(result), [homegraphSerial]);
    assert.equal(result[homegraphSerial].full, true);
    let data = result[homegraphSerial].data;
    assert.equal(data.occupancy, expected);
    assert.equal(data.nest_google_device_uuid, homegraphId);
    assert.equal(data.nest_google_home_uuid, homegraphId);
    assert.equal(data.description, 'Sydney - NSW');
    assert.equal(data.excluded, true);
    assert.equal(Object.hasOwn(data, 'source'), false);
    assert.equal(Object.hasOwn(data, 'dataSource'), false);
  }
  for (let state of [undefined, 'PRESENCE_STATE_UNSPECIFIED', 'UNKNOWN']) {
    raw[homegraphId].value.home.traits[0].fields.presenceState.stringValue = state;
    let result = processRawData(undefined, raw, config);
    assert.equal(result[homegraphSerial].full, false);
    assert.equal(result[homegraphSerial].data.occupancy, undefined);
  }
});

test('HomeGraph Home/Away retains configuration overrides and ignores unrelated resource changes', () => {
  let raw = { [homegraphId]: homegraphStructure('PRESENCE_STATE_VACANT') };
  delete raw[homegraphId].value.home.address;
  let config = {
    options: { eveHistory: true },
    homes: [{ homegraph_home_uuid: homegraphId, exclude: true }],
    devices: [{ serialNumber: homegraphSerial, exclude: false, eveHistory: false }],
  };
  let data = processRawData(undefined, raw, config)[homegraphSerial].data;
  assert.equal(data.description, 'Home');
  assert.equal(data.excluded, false);
  assert.equal(data.eveHistory, false);
  assert.deepEqual(processRawData(undefined, raw, config, undefined, new Map([['STRUCTURE_OTHER', { fields: new Set(['home']) }]])), {});
  delete raw[homegraphId].value.home.uuid;
  assert.deepEqual(processRawData(undefined, raw, config), {});
});
