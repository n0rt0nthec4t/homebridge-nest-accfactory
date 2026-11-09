// Verify protobuf weather discovery and cached trait reconciliation without starting Homebridge or fetching forecasts.
import assert from 'node:assert/strict';
import { importSource } from './helpers/import-source.js';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { URL } from 'node:url';
import { DATA_SOURCE, DEVICE_TYPE, NESTLABS_MAC_PREFIX } from '../src/consts.js';
import { crc24 } from '../src/utils.js';

let location = new URL('../src/plugins/weather.js', import.meta.url);
let parent = 'data:text/javascript,' + encodeURIComponent('export default class { static makeValidHKName(name) { return name; } }');
let source = (await readFile(location, 'utf8')).replace(/from '([^']+)'/g, (match, specifier) => {
  return 'from ' + JSON.stringify(specifier === '../HomeKitDevice.js' ? parent : new URL(specifier, location).href);
});
let { processRawData } = await importSource(location, source);
let config = { options: {}, homes: [{ google_home_uuid: 'STRUCTURE_HOME', weather: true, elevation: 50 }] };
let serial = NESTLABS_MAC_PREFIX + crc24(DEVICE_TYPE.WEATHER.toUpperCase() + ':STRUCTURE.HOME').toUpperCase();
let traits = {
  structure_info: { rtsStructureId: 'structure.home', name: 'Home' },
  structure_location: { city: { value: 'Sydney' }, state: { value: 'NSW' } },
  weather: { current_temperature: 20, current_humidity: 60, condition: 'Clear', postal_code: '2000', country_code: 'AU' },
};

test('weather ignores REST structures and preserves legacy identity regardless of source arrival order', () => {
  let rest = ['structure.home', { source: DATA_SOURCE.NEST, value: { name: 'Home', weather: traits.weather } }];
  let google = ['STRUCTURE_HOME', { source: DATA_SOURCE.GOOGLE, value: traits }];
  assert.deepEqual(processRawData(undefined, Object.fromEntries([rest]), config), {});
  for (let entries of [
    [rest, google],
    [google, rest],
  ]) {
    let devices = processRawData(undefined, Object.fromEntries(entries), config);
    assert.deepEqual(Object.keys(devices), [serial]);
    assert.equal(devices[serial].full, true);
    assert.equal(devices[serial].data.excluded, false);
    assert.equal(devices[serial].data.elevation, 50);
    assert.equal(devices[serial].data.nest_google_device_uuid, 'STRUCTURE_HOME');
  }
});

for (let order of [
  ['structure_info', 'structure_location', 'weather'],
  ['structure_location', 'weather', 'structure_info'],
  ['weather', 'structure_info', 'structure_location'],
]) {
  test('weather initialises from separately arriving traits: ' + order.join(', '), () => {
    let raw = { STRUCTURE_HOME: { source: DATA_SOURCE.GOOGLE, value: {} } };
    let devices;
    for (let field of order) {
      raw.STRUCTURE_HOME.value[field] = traits[field];
      devices = processRawData(undefined, raw, config, undefined, new Map([['STRUCTURE_HOME', { fields: new Set([field]) }]]));
    }
    assert.equal(devices[serial].full, true);
    assert.equal(devices[serial].data.description, 'Sydney - NSW');
    assert.equal(devices[serial].data.current_temperature, 20);
    assert.equal(devices[serial].data.current_humidity, 60);
    raw.STRUCTURE_HOME.value.weather = { ...traits.weather, current_temperature: 23 };
    devices = processRawData(undefined, raw, config, undefined, new Map([['STRUCTURE_HOME', { fields: new Set(['weather']) }]]));
    assert.equal(devices[serial].full, true);
    assert.equal(devices[serial].data.current_temperature, 23);
    assert.deepEqual(
      processRawData(undefined, raw, config, undefined, new Map([['STRUCTURE_HOME', { fields: new Set(['structure_mode']) }]])),
      {},
    );
  });
}

test('weather resolves timezone-only changes from its own home and clears unusable zones', () => {
  let raw = {
    STRUCTURE_HOME: { source: DATA_SOURCE.GOOGLE, value: structuredClone(traits) },
    STRUCTURE_OTHER: {
      source: DATA_SOURCE.GOOGLE,
      value: {
        ...structuredClone(traits),
        structure_info: { rtsStructureId: 'structure.other' },
        time_zone: { timezoneName: 'Europe/London' },
      },
    },
  };
  assert.equal(processRawData(undefined, raw, config)[serial].data.timezone, null);
  for (let label of ['time_zone', 'home_timezone']) {
    for (let [reported, expected] of [
      [{ value: 'Australia/Sydney' }, 'Australia/Sydney'],
      ['America/Phoenix', 'America/Phoenix'],
      [{ value: 'Not/AZone' }, null],
      [{ value: '' }, null],
      [{ value: '+05:00' }, null],
      [null, null],
    ]) {
      raw.STRUCTURE_HOME.value[label] = { timezoneName: reported };
      let devices = processRawData(undefined, raw, config, undefined, new Map([['STRUCTURE_HOME', { fields: new Set([label]) }]]));
      assert.equal(devices[serial].full, true);
      assert.equal(devices[serial].data.timezone, expected);
      assert.equal(devices[serial].data.current_temperature, 20);
    }
    delete raw.STRUCTURE_HOME.value[label];
  }
  let devices = processRawData(undefined, raw, config);
  let other = Object.values(devices).find((device) => device.data.nest_google_home_uuid === 'STRUCTURE_OTHER');
  assert.equal(other.data.timezone, 'Europe/London');
  assert.equal(devices[serial].data.timezone, null);
  raw.STRUCTURE_HOME.value.time_zone = {};
  devices = processRawData(undefined, raw, config, undefined, new Map([['STRUCTURE_HOME', { fields: new Set(['time_zone']) }]]));
  assert.equal(devices[serial].data.timezone, null);
});

test('weather does not choose arbitrarily between conflicting home timezone traits', () => {
  let raw = {
    STRUCTURE_HOME: {
      source: DATA_SOURCE.GOOGLE,
      value: {
        ...structuredClone(traits),
        time_zone: { timezoneName: { value: 'Australia/Sydney' } },
        other_timezone: { timezoneName: 'America/Phoenix' },
      },
    },
  };
  assert.equal(processRawData(undefined, raw, config)[serial].data.timezone, null);
});
