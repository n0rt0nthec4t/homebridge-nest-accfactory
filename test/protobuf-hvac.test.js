// Verify protobuf-only Heat Link and temperature sensor discovery, identity and related-state updates.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { URL } from 'node:url';
import crypto from 'node:crypto';
import { DATA_SOURCE, USER_AGENT } from '../src/consts.js';

async function loadMapper(name) {
  let location = new URL('../src/plugins/' + name + '.js', import.meta.url);
  let parent = 'data:text/javascript,' + encodeURIComponent('export default class { static makeValidHKName(name) { return name; } }');
  let source = (await readFile(location, 'utf8')).replace(/from '([^']+)'/g, (match, specifier) => {
    return 'from ' + JSON.stringify(specifier === '../HomeKitDevice.js' ? parent : new URL(specifier, location).href);
  });
  return (await import('data:text/javascript,' + encodeURIComponent(source))).processRawData;
}

let heatlink = await loadMapper('heatlink');
let tempsensor = await loadMapper('tempsensor');

function rawData() {
  return {
    STRUCTURE_HOME: { source: DATA_SOURCE.GOOGLE, value: {} },
    DEVICE_THERMOSTAT: {
      source: DATA_SOURCE.GOOGLE,
      value: {
        device_info: { typeName: 'nest.resource.NestLearningThermostat3Resource', pairerId: { resourceId: 'STRUCTURE_HOME' } },
        configuration_done: { deviceReady: true },
        heat_link: {
          heatLinkSerialNumber: { value: 'HEATLINK_SERIAL' },
          heatLinkModel: { value: 'Amber-2' },
          heatLinkSwVersion: { value: '1.2.3' },
        },
        heat_link_settings: { heatConnectionType: 'HEAT_LINK_CONNECTION_TYPE_OPENTHERM' },
        display_settings: { temperatureScale: 'TEMPERATURE_SCALE_C' },
        liveness: { status: 'LIVENESS_DEVICE_STATUS_ONLINE' },
        hvac_equipment_capabilities: { hasHotWaterControl: true, hasHotWaterTemperature: true },
        hot_water_settings: { boostTimerEnd: { seconds: '0' }, temperature: { value: 55 } },
        hot_water_trait: { boilerActive: false, temperature: { value: 50 } },
        label: { label: 'Kitchen' },
        remote_comfort_sensing_settings: {
          associatedRcsSensors: [{ deviceId: { resourceId: 'DEVICE_SENSOR' } }],
          activeRcsSelection: { activeRcsSensor: { resourceId: 'DEVICE_SENSOR' } },
        },
      },
    },
    DEVICE_SENSOR: {
      source: DATA_SOURCE.GOOGLE,
      value: {
        device_identity: { serialNumber: 'SENSOR_SERIAL', productIdDescription: { literal: 'KRX' } },
        device_info: { typeName: 'nest.resource.NestKryptoniteResource', pairerId: { resourceId: 'STRUCTURE_HOME' } },
        label: { label: 'Bedroom' },
        battery: { assessedVoltage: { value: 3 } },
        current_temperature: { temperatureValue: { temperature: { value: 21 } } },
        last_updated_beacon: { lastBeaconTime: { seconds: String(Math.floor(Date.now() / 1000)) } },
      },
    },
    'device.LEGACY': {
      source: DATA_SOURCE.NEST,
      value: { serial_number: 'LEGACY', heat_link_serial_number: 'LEGACY_HEATLINK' },
    },
    'rcs_settings.LEGACY': { value: { associated_rcs_sensors: ['kryptonite.LEGACY_SENSOR'] } },
    'kryptonite.LEGACY_SENSOR': { source: DATA_SOURCE.NEST, value: { serial_number: 'LEGACY_SENSOR' } },
  };
}

test('Heat Link uses protobuf thermostat identity and supports hot-water-only deltas', () => {
  let raw = rawData();
  let fields = new Set([...Object.keys(raw.DEVICE_THERMOSTAT.value), 'located_annotations']);
  let result = heatlink(undefined, raw, { options: {} }, undefined, new Map([['DEVICE_THERMOSTAT', { fields }]]));
  assert.deepEqual(Object.keys(result), ['HEATLINK_SERIAL']);
  assert.equal(result.HEATLINK_SERIAL.full, true);
  assert.equal(result.HEATLINK_SERIAL.data.associated_thermostat, 'DEVICE_THERMOSTAT');
  assert.equal(result.HEATLINK_SERIAL.data.hot_water_temperature, 55);
  raw.DEVICE_THERMOSTAT.value.hot_water_settings.boostTimerEnd.seconds = '12345';
  result = heatlink(
    undefined,
    raw,
    { options: {} },
    undefined,
    new Map([['DEVICE_THERMOSTAT', { fields: new Set(['hot_water_settings']) }]]),
  );
  assert.equal(result.HEATLINK_SERIAL.full, false);
  assert.equal(result.HEATLINK_SERIAL.data.hot_water_boost_active, true);
  delete raw.DEVICE_THERMOSTAT;
  assert.deepEqual(
    heatlink(undefined, raw, { options: {} }, undefined, new Map([['device.LEGACY', { fields: new Set(['heat_link_serial_number']) }]])),
    {},
  );
});

test('temperature sensors use protobuf identities and react to parent-only selection and sensor-only temperature changes', () => {
  let raw = rawData();
  let result = tempsensor(
    undefined,
    raw,
    { options: {} },
    undefined,
    new Map([['DEVICE_SENSOR', { fields: new Set(['current_temperature']) }]]),
  );
  assert.deepEqual(Object.keys(result), ['SENSOR_SERIAL']);
  assert.equal(result.SENSOR_SERIAL.full, true);
  assert.equal(result.SENSOR_SERIAL.data.active_sensor, true);
  assert.equal(result.SENSOR_SERIAL.data.associated_thermostat, 'DEVICE_THERMOSTAT');
  raw.DEVICE_THERMOSTAT.value.remote_comfort_sensing_settings.activeRcsSelection = { rcsSourceType: 'RCS_SOURCE_TYPE_BACKPLATE' };
  result = tempsensor(
    undefined,
    raw,
    { options: {} },
    undefined,
    new Map([['DEVICE_THERMOSTAT', { fields: new Set(['remote_comfort_sensing_settings']) }]]),
  );
  assert.equal(result.SENSOR_SERIAL.data.active_sensor, false);
  raw.DEVICE_SENSOR.value.current_temperature.temperatureValue.temperature.value = 23;
  result = tempsensor(
    undefined,
    raw,
    { options: {} },
    undefined,
    new Map([['DEVICE_SENSOR', { fields: new Set(['current_temperature']) }]]),
  );
  assert.equal(result.SENSOR_SERIAL.data.current_temperature, 23);
  delete raw.DEVICE_THERMOSTAT;
  assert.deepEqual(tempsensor(undefined, raw, { options: {} }), {});
});

let systemSource = await readFile(new URL('../src/system.js', import.meta.url), 'utf8');
let setBegin = systemSource.indexOf('  async #set(');
let setEnd = systemSource.indexOf('  async #get(', setBegin);
let createCommandHost = new Function(
  'raw',
  'connection',
  'DATA_SOURCE',
  'crypto',
  'fetchWrapper',
  'USER_AGENT',
  'URL',
  'return new class { #rawData = raw; #connections = new Map([["account", connection]]);' +
    'log = { debug: (...args) => { throw new Error(args.join(" ")); } };' +
    'run(id, values) { return this.#set("account", id, values); }' +
    systemSource.slice(setBegin, setEnd) +
    '};',
);

test('thermostat and Heat Link commands use protobuf while retired REST commands are ignored and Protect remains supported', async () => {
  let raw = rawData();
  raw.DEVICE_THERMOSTAT.value.eco_mode_state = { ecoMode: 'ECO_MODE_INACTIVE' };
  raw.DEVICE_THERMOSTAT.value.target_temperature_settings = {
    targetTemperature: { setpointType: 'SET_POINT_TYPE_HEAT', heatingTarget: { value: 20 } },
  };
  raw['topaz.PROTECT'] = { source: DATA_SOURCE.NEST, value: {} };
  let grpc = [];
  let rest = [];
  let connection = {
    authorised: true,
    transport_url: 'https://example.invalid',
    grpcTransport: {
      command: async (...args) => {
        grpc.push(args);
        return { data: [{ traitOperations: [{ progress: 'COMPLETE' }] }] };
      },
    },
  };
  let fetch = async (...args) => {
    rest.push(args);
    return { json: async () => ({ objects: [{}] }) };
  };
  let host = createCommandHost(raw, connection, DATA_SOURCE, crypto, fetch, USER_AGENT, URL);
  await host.run('DEVICE_THERMOSTAT', { target_temperature: 22, hot_water_boost_active: { state: true, time: 1800 } });
  assert.equal(grpc.length, 2);
  let temperature = grpc[0][3].batchUpdateStateRequest[0];
  assert.equal(temperature.traitRequest.resourceId, 'DEVICE_THERMOSTAT');
  assert.equal(temperature.state.value.targetTemperature.heatingTarget.value, 22);
  assert.equal(grpc[1][3].batchUpdateStateRequest[0].traitRequest.traitLabel, 'hot_water_settings');
  await host.run('device.LEGACY', { target_temperature: 22, hot_water_boost_active: { state: true, time: 1800 } });
  await host.run('kryptonite.LEGACY_SENSOR', { active_sensor: true });
  assert.equal(rest.length, 0);
  await host.run('topaz.PROTECT', { ntp_green_led_enable: true });
  assert.equal(rest.length, 1);
  assert.equal(JSON.parse(rest[0][3]).objects[0].object_key, 'topaz.PROTECT');
});
