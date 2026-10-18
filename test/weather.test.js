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
