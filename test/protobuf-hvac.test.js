// Verify preferred protobuf and fallback REST HVAC discovery, controls and related-state updates.
import assert from 'node:assert/strict';
import { importSource } from './helpers/import-source.js';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { URL } from 'node:url';
import crypto from 'node:crypto';
import { attachAPIClients } from './helpers/api-clients.js';
import { DATA_SOURCE, USER_AGENT } from '../src/consts.js';

async function loadMapper(name) {
  let location = new URL('../src/plugins/' + name + '.js', import.meta.url);
  let parent = 'data:text/javascript,' + encodeURIComponent('export default class { static makeValidHKName(name) { return name; } }');
  let source = (await readFile(location, 'utf8')).replace(/from '([^']+)'/g, (match, specifier) => {
    return 'from ' + JSON.stringify(specifier === '../HomeKitDevice.js' ? parent : new URL(specifier, location).href);
  });
  return (await importSource(location, source)).processRawData;
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
  assert.equal(result.HEATLINK_SERIAL.full, true, 'hot-water-only updates reuse cached thermostat traits');
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
  'return new class { #rawData = raw; #accounts = new Map([["account", connection]]);' +
    'errors = []; log = { debug: (...args) => this.errors.push(args) };' +
    'run(id, values) { return this.#set("account", id, values); }' +
    systemSource.slice(setBegin, setEnd) +
    '};',
);

test('protobuf commands retain their routing and incomplete REST devices reject unsupported controls', async () => {
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
        return { status: 0, data: [{ traitOperations: [{ progress: 'COMPLETE' }] }] };
      },
    },
  };
  let fetch = async (...args) => {
    rest.push(args);
    return { json: async () => ({ objects: [{}] }) };
  };
  let host = createCommandHost(raw, connection, DATA_SOURCE, crypto, fetch, USER_AGENT, URL);
  attachAPIClients(connection, raw, fetch, host.log);
  await host.run('DEVICE_THERMOSTAT', { target_temperature: 22, hot_water_boost_active: { state: true, time: 1800 } });
  assert.equal(grpc.length, 2);
  let temperature = grpc[0][3].batchUpdateStateRequest[0];
  assert.equal(temperature.traitRequest.resourceId, 'DEVICE_THERMOSTAT');
  assert.equal(temperature.state.value.targetTemperature.heatingTarget.value, 22);
  assert.equal(grpc[1][3].batchUpdateStateRequest[0].traitRequest.traitLabel, 'hot_water_settings');
  assert.deepEqual(host.errors, []);
  await assert.rejects(
    host.run('device.LEGACY', { target_temperature: 22, hot_water_boost_active: { state: true, time: 1800 } }),
    AggregateError,
  );
  await assert.rejects(host.run('kryptonite.LEGACY_SENSOR', { active_sensor: true }), AggregateError);
  assert.equal(host.errors.length, 3, 'Each unsupported setting is rejected without sending an invalid REST request');
  assert.equal(rest.length, 0);
  assert.equal(grpc.length, 2);
  await host.run('topaz.PROTECT', { ntp_green_led_enable: true });
  assert.equal(rest.length, 1);
  assert.equal(JSON.parse(rest[0][3]).objects[0].object_key, 'topaz.PROTECT');
});

for (let [product, model] of [
  ['KR1', 'Temperature Sensor (1st gen)'],
  ['KRX', 'Temperature Sensor (2nd gen)'],
  ['UNKNOWN', 'Temperature Sensor (unknown)'],
]) {
  test('protobuf sensor model identity: ' + product, () => {
    let raw = rawData();
    raw.DEVICE_SENSOR.value.device_identity.productIdDescription.literal = product;
    assert.equal(tempsensor(undefined, raw, { options: {} }).SENSOR_SERIAL.data.model, model);
  });
}
for (let [age, online] of [
  [0, true],
  [14399, true],
  [14400, false],
  [14401, false],
]) {
  test('protobuf sensor beacon age ' + age + ' controls availability independently of temperature', (context) => {
    context.mock.timers.enable({ apis: ['Date'], now: 2000000000000 });
    let raw = rawData();
    raw.DEVICE_SENSOR.value.last_updated_beacon.lastBeaconTime.seconds = String(2000000000 - age);
    let data = tempsensor(undefined, raw, { options: {} }).SENSOR_SERIAL.data;
    assert.equal(data.online, online);
    assert.equal(data.current_temperature, 21);
  });
}
for (let [voltage, expected] of [
  [2.4, 0],
  [2.5, 0],
  [2.85, 50],
  [3.2, 100],
  [3.5, 100],
]) {
  test('protobuf sensor voltage bounds: ' + voltage, () => {
    let raw = rawData();
    raw.DEVICE_SENSOR.value.battery.assessedVoltage.value = voltage;
    assert.equal(tempsensor(undefined, raw, { options: {} }).SENSOR_SERIAL.data.battery_level, expected);
  });
}
for (let field of ['battery', 'current_temperature', 'device_identity']) {
  test('protobuf sensor waits for usable required ' + field, () => {
    let raw = rawData();
    delete raw.DEVICE_SENSOR.value[field];
    assert.deepEqual(tempsensor(undefined, raw, { options: {} }), {});
  });
}
for (let [plugin, home, device, excluded] of [
  [false, undefined, undefined, false],
  [true, undefined, undefined, true],
  [true, false, undefined, false],
  [false, true, undefined, true],
  [true, true, false, false],
  [false, false, true, true],
]) {
  test('protobuf sensor exclusion precedence: ' + plugin + '/' + home + '/' + device, () => {
    let raw = rawData();
    let data = tempsensor(undefined, raw, {
      options: { exclude: plugin, eveHistory: false },
      homes: [{ google_home_uuid: 'structure_home', exclude: home }],
      devices: [{ serialNumber: 'sensor_serial', exclude: device, eveHistory: true }],
    }).SENSOR_SERIAL.data;
    assert.equal(data.excluded, excluded);
    assert.equal(data.eveHistory, true);
  });
}
for (let association of [null, {}, { deviceId: { resourceId: '' } }, { deviceId: { resourceId: 'MISSING' } }]) {
  test('protobuf sensor ignores invalid parent association ' + JSON.stringify(association), () => {
    let raw = rawData();
    raw.DEVICE_THERMOSTAT.value.remote_comfort_sensing_settings.associatedRcsSensors = [association];
    assert.deepEqual(tempsensor(undefined, raw, { options: {} }), {});
  });
}

let thermostat = await loadMapper('thermostat');

function nestData() {
  let source = DATA_SOURCE.NEST;
  return {
    'structure.HOME': { source, value: { name: 'Home' } },
    'where.HOME': { source, value: { wheres: [{ where_id: 'room', name: 'Kitchen' }] } },
    'device.LEGACY': {
      source,
      value: {
        serial_number: 'LEGACY',
        current_version: '1.2.3',
        where_id: 'room',
        backplate_temperature: 21,
        battery_level: 3.8,
        temperature_scale: 'C',
        heat_link_serial_number: 'HEATLINK_SERIAL',
        heat_link_model: 'Amber-2',
        heat_link_sw_version: '1.2.3',
        has_hot_water_control: true,
        has_hot_water_temperature: true,
        hot_water_temperature: 55,
        hot_water_active: false,
        hot_water_boost_time_to_end: 0,
        current_water_temperature: 50,
        has_fan: true,
        fan_capabilities: 'stage3',
        fan_timer_speed: 'stage1',
        fan_timer_timeout: 0,
        has_humidifier: true,
        has_dehumidifier: true,
        target_humidity: 45,
        current_humidity: 40,
        away_temperature_low_enabled: true,
        away_temperature_high_enabled: true,
        away_temperature_low: 12,
        away_temperature_high: 28,
        eco: { mode: 'schedule' },
      },
    },
    'shared.LEGACY': {
      source,
      value: {
        can_heat: true,
        can_cool: true,
        target_temperature_type: 'heat',
        target_temperature: 20,
        target_temperature_low: 20,
        target_temperature_high: 24,
        hvac_heater_state: true,
      },
    },
    'track.LEGACY': { source, value: { online: true } },
    'link.LEGACY': { source, value: { structure: 'structure.HOME' } },
    'rcs_settings.LEGACY': {
      source,
      value: {
        associated_rcs_sensors: ['kryptonite.SENSOR_SERIAL'],
        active_rcs_sensors: ['kryptonite.SENSOR_SERIAL'],
      },
    },
    'kryptonite.SENSOR_SERIAL': {
      source,
      value: {
        serial_number: 'SENSOR_SERIAL',
        structure_id: 'HOME',
        where_id: 'room',
        model: 'KR1',
        current_temperature: 19,
        battery_level: 80,
        last_updated_at: Math.floor(Date.now() / 1000),
      },
    },
    'schedule.LEGACY': { source, value: { schedule_mode: 'heat', days: {} } },
  };
}

for (let [mode, expected] of [
  ['schedule', 'off'],
  ['manual-eco', 'manual'],
  ['auto-eco', 'auto'],
  ['MANUAL-ECO', 'manual'],
  ['unexpected', 'unknown'],
  [undefined, 'unknown'],
]) {
  test('Nest thermostat translates reported Eco mode ' + String(mode), () => {
    let raw = nestData();
    raw['device.LEGACY'].value.eco = mode === undefined ? undefined : { mode };
    let result = thermostat(undefined, raw, { options: {} });
    assert.equal(result.LEGACY.data.eco_mode, expected);
  });
}

test('REST-only thermostat, sensor and Heat Link produce complete candidates using committed related buckets', () => {
  let raw = nestData();
  let before = structuredClone(raw);
  for (let [mapper, serial] of [
    [thermostat, 'LEGACY'],
    [tempsensor, 'SENSOR_SERIAL'],
    [heatlink, 'HEATLINK_SERIAL'],
  ]) {
    let result = mapper(undefined, raw, { options: {} });
    assert.equal(result[serial]?.full, true, JSON.stringify(result));
    assert.equal(result[serial].data.nest_google_home_uuid, 'structure.HOME');
    assert.equal(result[serial].data.nest_google_device_uuid, serial === 'SENSOR_SERIAL' ? 'kryptonite.SENSOR_SERIAL' : 'device.LEGACY');
  }
  assert.equal(thermostat(undefined, raw, { options: {} }).LEGACY.data.current_temperature, 19);
  assert.equal(thermostat(undefined, raw, { options: {} }).LEGACY.data.eco_mode, 'off');
  assert.equal(tempsensor(undefined, raw, { options: {} }).SENSOR_SERIAL.data.active_sensor, true);
  assert.deepEqual(raw, before, 'translation must not inject parent links or alter source data');
});

for (let [id, changes, mapper, serial, field, expected] of [
  ['shared.LEGACY', { target_temperature_low: 23 }, thermostat, 'LEGACY', 'target_temperature_low', 23],
  ['track.LEGACY', { online: false }, thermostat, 'LEGACY', 'online', false],
  ['kryptonite.SENSOR_SERIAL', { current_temperature: 17 }, thermostat, 'LEGACY', 'current_temperature', 17],
  ['rcs_settings.LEGACY', { active_rcs_sensors: [] }, tempsensor, 'SENSOR_SERIAL', 'active_sensor', false],
  ['device.LEGACY', { hot_water_temperature: 60 }, heatlink, 'HEATLINK_SERIAL', 'hot_water_temperature', 60],
  ['where.HOME', { wheres: [{ where_id: 'room', name: 'Bedroom' }] }, thermostat, 'LEGACY', 'description', 'Bedroom'],
]) {
  test('REST related update ' + id + ' refreshes ' + serial + '.' + field, () => {
    let raw = nestData();
    Object.assign(raw[id].value, changes);
    let result = mapper(undefined, raw, { options: {} }, undefined, new Map([[id, { fields: new Set(Object.keys(changes)) }]]));
    assert.equal(result[serial]?.data[field], expected, JSON.stringify(result));
  });
}

for (let reverse of [false, true]) {
  test('protobuf candidates remain preferred over complete REST candidates; reverse=' + reverse, () => {
    let google = rawData();
    delete google['device.LEGACY'];
    delete google['rcs_settings.LEGACY'];
    delete google['kryptonite.LEGACY_SENSOR'];
    google.DEVICE_THERMOSTAT.value.device_identity = { serialNumber: 'LEGACY', softwareVersion: '1.2.3' };
    let raw = reverse === true ? { ...google, ...nestData() } : { ...nestData(), ...google };
    for (let [mapper, serial, id] of [
      [thermostat, 'LEGACY', 'DEVICE_THERMOSTAT'],
      [tempsensor, 'SENSOR_SERIAL', 'DEVICE_SENSOR'],
      [heatlink, 'HEATLINK_SERIAL', 'DEVICE_THERMOSTAT'],
    ]) {
      assert.equal(mapper(undefined, raw, { options: {} })[serial]?.data.nest_google_device_uuid, id);
      for (let changed of ['device.LEGACY', 'rcs_settings.LEGACY', 'where.HOME', 'kryptonite.SENSOR_SERIAL']) {
        let result = mapper(
          undefined,
          raw,
          { options: {} },
          undefined,
          new Map([[changed, { fields: new Set(Object.keys(raw[changed].value)) }]]),
        );
        assert.equal(result[serial]?.data.nest_google_device_uuid, id, 'REST delta ' + changed + ' must not replace usable protobuf');
      }
    }
  });
}

for (let [values, bucket, expected] of [
  [{ target_temperature: 22 }, 'shared.LEGACY', { target_change_pending: true, target_temperature: 22 }],
  [{ target_temperature_low: 18 }, 'shared.LEGACY', { target_change_pending: true, target_temperature_low: 18 }],
  [{ target_temperature_high: 26 }, 'shared.LEGACY', { target_change_pending: true, target_temperature_high: 26 }],
  [{ hvac_mode: 'RANGE' }, 'shared.LEGACY', { target_change_pending: true, target_temperature_type: 'range' }],
  [{ hvac_mode: 'off' }, 'shared.LEGACY', { target_change_pending: true, target_temperature_type: 'off' }],
  [{ fan_timer_speed: 2 }, 'device.LEGACY', { fan_timer_speed: 'stage2' }],
  [
    { fan_timer_speed: 0, fan_duration: 60, fan_state: false },
    'device.LEGACY',
    { fan_state: false, fan_timer_timeout: 0, fan_timer_speed: 'stage1' },
  ],
  [{ temperature_lock: true }, 'device.LEGACY', { temperature_lock: true }],
  [{ temperature_scale: 'f' }, 'device.LEGACY', { temperature_scale: 'F' }],
  [{ hot_water_boost_active: { state: false } }, 'device.LEGACY', { hot_water_boost_time_to_end: 0 }],
  [{ hot_water_temperature: 60 }, 'device.LEGACY', { hot_water_temperature: 60 }],
  [{ target_humidity_humidifier: 50, humidifier_state: true }, 'device.LEGACY', { target_humidity_enabled: true, target_humidity: 50 }],
  [
    { dehumidifier_state: false, target_humidity_dehumidifier: 40 },
    'device.LEGACY',
    { target_humidity_enabled: false, target_humidity: 40 },
  ],
  [{ target_humidity_humidifier: 50 }, 'device.LEGACY', { target_humidity: 50 }],
  [{ target_humidity_dehumidifier: 40 }, 'device.LEGACY', { target_humidity: 40 }],
  [{ vacation_mode: true }, 'structure.HOME', { vacation_mode: true }],
]) {
  test('REST control ' + JSON.stringify(values) + ' uses the correct bucket without changing cached state', async () => {
    let raw = nestData();
    let before = structuredClone(raw);
    let requests = [];
    let connection = { authorised: true, transport_url: 'https://transport.invalid' };
    attachAPIClients(connection, raw, async (...args) => {
      requests.push(args);
      return { json: async () => ({ objects: [{}] }) };
    });
    await connection.nestAPI.set('device.LEGACY', values);
    assert.equal(requests.length, 1);
    assert.equal(requests[0][1], 'https://transport.invalid/v5/put');
    assert.deepEqual(JSON.parse(requests[0][3]).objects, [{ object_key: bucket, op: 'MERGE', value: expected }]);
    assert.deepEqual(raw, before);
  });
}

for (let mode of ['heat', 'cool']) {
  test('REST ' + mode + ' setpoints use the shared bucket during Eco', async () => {
    let raw = nestData();
    raw['device.LEGACY'].value.eco.mode = 'manual-eco';
    raw['shared.LEGACY'].value.target_temperature_type = mode;
    let requests = [];
    let connection = { authorised: true, transport_url: 'https://transport.invalid' };
    attachAPIClients(connection, raw, async (...args) => {
      requests.push(args);
      return { json: async () => ({ objects: [{}] }) };
    });
    await connection.nestAPI.set('device.LEGACY', { target_temperature: 22 });
    assert.deepEqual(JSON.parse(requests[0][3]).objects[0], {
      object_key: 'shared.LEGACY',
      op: 'MERGE',
      value: { target_change_pending: true, target_temperature: 22 },
    });
  });
}

for (let values of [
  { hvac_mode: 'invalid' },
  { target_temperature: 'invalid' },
  { fan_state: true, fan_duration: -1 },
  { fan_state: true, fan_duration: 60, fan_timer_speed: 4 },
  { temperature_scale: 'K' },
  { hot_water_boost_active: { state: true, time: -1 } },
  { target_humidity_humidifier: 101 },
  { humidifier_state: true, target_humidity_humidifier: 'bad' },
  { eco_mode: true },
]) {
  test('REST invalid setting rejects before network: ' + JSON.stringify(values), async () => {
    let connection = { authorised: true, transport_url: 'https://transport.invalid' };
    attachAPIClients(connection, nestData(), async () => assert.fail('Invalid request reached network'));
    await assert.rejects(connection.nestAPI.set('device.LEGACY', values), AggregateError);
  });
}

test('incomplete protobuf leaves complete REST fallback available for thermostat, sensor and Heat Link', () => {
  let raw = { ...rawData(), ...nestData() };
  raw.DEVICE_THERMOSTAT.value.configuration_done.deviceReady = false;
  for (let [mapper, serial] of [
    [thermostat, 'LEGACY'],
    [tempsensor, 'SENSOR_SERIAL'],
    [heatlink, 'HEATLINK_SERIAL'],
  ]) {
    let result = mapper(undefined, raw, { options: {} });
    assert.equal(result[serial]?.full, true);
    assert.match(result[serial].data.nest_google_device_uuid, /^(device|kryptonite)\./);
  }
});
