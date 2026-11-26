// Exercise HomeGraph sensor mapping through the normal field map, with physical
// identities and fabricated account/home relationships. No network or HomeKit setup.
import { getResourceKey } from '../src/utils.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { importSource } from './helpers/import-source.js';
import { DATA_SOURCE, DEVICE_TYPE, LOW_BATTERY_LEVEL, PROTOBUF_RESOURCES } from '../src/consts.js';
let location = new URL('../src/plugins/tempsensor.js', import.meta.url);
let parent = 'data:text/javascript,' + encodeURIComponent('export default class { static makeValidHKName(name) { return name; } }');
let source = (await readFile(location, 'utf8')).replace('from \'../HomeKitDevice.js\'', 'from ' + JSON.stringify(parent));
let { default: NestTemperatureSensor, processRawData } = await importSource(location, source);
const sensorId = getResourceKey('account', 'HomeGraph', 'sensor');
const parentId = getResourceKey('account', 'HomeGraph', 'parent');
const homeId = getResourceKey('account', 'HomeGraph', 'home', 'STRUCTURE');
function fixture() {
  return {
    [homeId]: {
      source: DATA_SOURCE.HOMEGRAPH,
      connection: 'account',
      value: { home: { uuid: 'home', rooms: [{ uuid: 'room', name: 'Bedroom' }] } },
    },
    [sensorId]: {
      source: DATA_SOURCE.HOMEGRAPH,
      connection: 'account',
      value: {
        googleHome: {
          id: { googleUuid: 'sensor', thirdPartyId: { idType: 'nest-home-assistant-prod' } },
          type: 'action.devices.types.SENSOR',
          displayName: 'Bedroom',
          names: { name: 'Bedroom', nicknames: ['Bedroom(Main)'], defaultNames: ['Bedroom', 'Temp Sensor'] },
          hardware: { model: 'Nest Temperature Sensor' },
        },
        technicalInformation: { serialNumber: '22AA_FIXTURE' },
        structureId: 'home',
        roomId: 'room',
        'temperatureSetting.ambientAirTemperatureC': { number: 22.21 },
        'charging.descriptiveCapacityRemaining': { text: 'high' },
        'deviceStatus.online': { boolean: true },
      },
    },
    [parentId]: {
      source: DATA_SOURCE.HOMEGRAPH,
      connection: 'account',
      value: {
        googleHome: {
          id: { googleUuid: 'parent', thirdPartyId: { idType: 'nest-home-assistant-prod' } },
          type: 'action.devices.types.THERMOSTAT',
        },
        structureId: 'home',
        'temperatureSetting.knownThermostatTemperatureSensors': {
          array: { values: [{ properties: { properties: [{ name: 'sensorId', value: { text: 'sensor' } }] } }] },
        },
        'temperatureSetting.activeThermostatTemperatureSensors': { array: { values: [{ text: 'sensor' }] } },
      },
    },
  };
}

test('HomeGraph sensors retain physical identity, use shared names and apply normal configuration', () => {
  let raw = fixture();
  let config = { options: { eveHistory: true }, homes: [{ homegraph_home_uuid: homeId, exclude: true }] };
  let result = processRawData(undefined, raw, config)['22AA_FIXTURE'];
  assert.equal(result.full, true);
  assert.equal(result.data.type, DEVICE_TYPE.TEMPSENSOR);
  assert.equal(result.data.description, 'Bedroom - Main');
  assert.equal(result.data.model, 'Temperature Sensor');
  assert.equal(result.data.softwareVersion, NestTemperatureSensor.VERSION);
  assert.equal(result.data.nest_google_device_uuid, sensorId);
  assert.equal(result.data.nest_google_home_uuid, homeId);
  assert.equal(result.data.associated_thermostat, parentId);
  assert.equal(result.data.active_sensor, true);
  assert.equal(result.data.current_temperature, 22);
  assert.equal(result.data.battery_level, 75);
  assert.equal(result.data.online, true);
  assert.equal(result.data.excluded, true);
  assert.equal(result.data.eveHistory, true);
  assert.equal(Object.hasOwn(result.data, 'source'), false);
  assert.equal(Object.hasOwn(result.data, 'dataSource'), false);
  config.devices = [{ serialNumber: '22AA_FIXTURE', exclude: false, eveHistory: false }];
  let overridden = processRawData(undefined, raw, config)['22AA_FIXTURE'].data;
  assert.equal(overridden.excluded, false);
  assert.equal(overridden.eveHistory, false);
  assert.deepEqual(processRawData(undefined, raw, config, DEVICE_TYPE.LOCK), {});
});

for (let [capacity, expected] of [
  ['full', 100],
  ['high', 75],
  ['medium', 50],
  ['low', LOW_BATTERY_LEVEL],
  ['critically_low', Math.floor(LOW_BATTERY_LEVEL / 2)],
]) {
  test('reported HomeGraph battery category maps to the established coarse estimate: ' + capacity, () => {
    let raw = fixture();
    raw[sensorId].value['charging.descriptiveCapacityRemaining'].text = capacity;
    assert.equal(processRawData(undefined, raw, { options: {} })['22AA_FIXTURE'].data.battery_level, expected);
  });
}

for (let invalid of ['serial', 'temperature', 'battery', 'online']) {
  test('incomplete HomeGraph sensor data does not create an accessory: ' + invalid, () => {
    let raw = fixture();
    if (invalid === 'serial') {
      delete raw[sensorId].value.technicalInformation;
    }
    if (invalid === 'temperature') {
      raw[sensorId].value['temperatureSetting.ambientAirTemperatureC'].number = null;
    }
    if (invalid === 'battery') {
      raw[sensorId].value['charging.descriptiveCapacityRemaining'].text = '__proto__';
    }
    if (invalid === 'online') {
      raw[sensorId].value['deviceStatus.online'].boolean = 'true';
    }
    assert.deepEqual(processRawData(undefined, raw, { options: {} }), {});
  });
}

test('parent-only and home-only changes update cached sensors without changing identity', () => {
  let raw = fixture();
  raw[parentId].value['temperatureSetting.activeThermostatTemperatureSensors'].array.values = [{ text: 'parent' }];
  let changed = new Map([[parentId, { fields: new Set(['temperatureSetting.activeThermostatTemperatureSensors']) }]]);
  assert.equal(processRawData(undefined, raw, { options: {} }, undefined, changed)['22AA_FIXTURE'].data.active_sensor, false);
  raw[homeId].value.home.rooms[0].name = 'Guest Room';
  changed = new Map([[homeId, { fields: new Set(['home']) }]]);
  assert.equal(
    processRawData(undefined, raw, { options: {} }, undefined, changed)['22AA_FIXTURE'].data.description,
    'Bedroom - Main - Guest Room',
  );
  assert.deepEqual(processRawData(undefined, raw, { options: {} }, undefined, new Map([['OTHER', { fields: new Set() }]])), {});
});

for (let invalid of ['account', 'home', 'provider', 'ambiguous', 'unknown selection']) {
  test('sensor selection is tied to an explicit thermostat in the same account/home: ' + invalid, () => {
    let raw = fixture();
    if (invalid === 'account') {
      raw[parentId].connection = 'other';
    }
    if (invalid === 'home') {
      raw[parentId].value.structureId = 'other';
    }
    if (invalid === 'provider') {
      raw[parentId].value.googleHome.id.thirdPartyId.idType = 'third-party';
    }
    if (invalid === 'ambiguous') {
      raw.OTHER_PARENT = structuredClone(raw[parentId]);
    }
    if (invalid === 'unknown selection') {
      delete raw[parentId].value['temperatureSetting.activeThermostatTemperatureSensors'];
    }
    let data = processRawData(undefined, raw, { options: {} })['22AA_FIXTURE'].data;
    assert.equal(data.active_sensor, undefined);
    assert.equal(data.associated_thermostat, invalid === 'unknown selection' ? parentId : undefined);
  });
}

for (let reverse of [false, true]) {
  test('sensor field preference, scoped relationships and protobuf-only updates: reverse=' + reverse, () => {
    let raw = fixture();
    raw.STRUCTURE_PROTO = { source: DATA_SOURCE.PROTOBUF, connection: 'proto-account', value: {} };
    raw.DEVICE_PROTO_PARENT = {
      source: DATA_SOURCE.PROTOBUF,
      connection: 'proto-account',
      value: {
        device_info: { typeName: PROTOBUF_RESOURCES.THERMOSTAT[0], pairerId: { resourceId: 'STRUCTURE_PROTO' } },
        configuration_done: { deviceReady: true },
        remote_comfort_sensing_settings: { associatedRcsSensors: [{ deviceId: { resourceId: 'DEVICE_PROTO_SENSOR' } }] },
      },
    };
    raw.DEVICE_PROTO_SENSOR = {
      source: DATA_SOURCE.PROTOBUF,
      connection: 'proto-account',
      value: {
        device_identity: { serialNumber: '22AA_FIXTURE' },
        device_info: { pairerId: { resourceId: 'STRUCTURE_PROTO' } },
        label: { label: 'Protobuf Sensor' },
        battery: { assessedVoltage: { value: 3.1 } },
        current_temperature: { temperatureValue: { temperature: { value: 19 } } },
        last_updated_beacon: { lastBeaconTime: { seconds: Math.floor(Date.now() / 1000) } },
      },
    };
    if (reverse === true) {
      raw = Object.fromEntries(Object.entries(raw).reverse());
    }
    let changed = new Map([['DEVICE_PROTO_SENSOR', { fields: new Set(['current_temperature']) }]]);
    let result = processRawData(undefined, raw, { options: {} }, undefined, changed);
    assert.deepEqual(Object.keys(result), ['22AA_FIXTURE']);
    assert.equal(result['22AA_FIXTURE'].data.nest_google_device_uuid, sensorId);
    assert.equal(result['22AA_FIXTURE'].data.current_temperature, 22);
    assert.equal(result['22AA_FIXTURE'].data.softwareVersion, NestTemperatureSensor.VERSION);
    raw.DEVICE_PROTO_PARENT.value.remote_comfort_sensing_settings.activeRcsSelection = {
      activeRcsSensor: { resourceId: 'DEVICE_PROTO_SENSOR' },
    };
    raw[sensorId].value['temperatureSetting.ambientAirTemperatureC'].number = 0;
    raw[sensorId].value['deviceStatus.online'].boolean = false;
    delete raw[parentId].value['temperatureSetting.knownThermostatTemperatureSensors'];
    result = processRawData(undefined, raw, { options: {} }, undefined, changed);
    assert.equal(result['22AA_FIXTURE'].data.current_temperature, 0);
    assert.equal(result['22AA_FIXTURE'].data.online, false);
    assert.equal(result['22AA_FIXTURE'].data.associated_thermostat, undefined);
    assert.equal(result['22AA_FIXTURE'].data.active_sensor, undefined);
    delete raw[sensorId].value['temperatureSetting.ambientAirTemperatureC'];
    result = processRawData(undefined, raw, { options: {} }, undefined, changed);
    assert.equal(result['22AA_FIXTURE'].data.nest_google_device_uuid, sensorId);
    assert.equal(result['22AA_FIXTURE'].data.current_temperature, 19);
    delete raw[sensorId].value.technicalInformation;
    result = processRawData(undefined, raw, { options: {} }, undefined, changed);
    assert.equal(result['22AA_FIXTURE'].data.nest_google_device_uuid, 'DEVICE_PROTO_SENSOR');
    assert.equal(result['22AA_FIXTURE'].data.current_temperature, 19);
    assert.equal(result['22AA_FIXTURE'].data.softwareVersion, NestTemperatureSensor.VERSION);
  });
}
