// Verify protobuf HVAC discovery, controls, related-state updates and rejection of retired REST data.
import assert from 'node:assert/strict';
import { importSource } from './helpers/import-source.js';
import test from 'node:test';
import { DATA_SOURCE } from '../src/consts.js';

let { processRawData: heatlink } = await importSource(new URL('../src/plugins/heatlink.js', import.meta.url));
let { processRawData: tempsensor } = await importSource(new URL('../src/plugins/tempsensor.js', import.meta.url));

function rawData() {
  return {
    STRUCTURE_HOME: { source: DATA_SOURCE.PROTOBUF, value: {} },
    DEVICE_THERMOSTAT: {
      source: DATA_SOURCE.PROTOBUF,
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
      source: DATA_SOURCE.PROTOBUF,
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
      source: 'Nest',
      value: { serial_number: 'LEGACY', heat_link_serial_number: 'LEGACY_HEATLINK' },
    },
    'rcs_settings.LEGACY': { value: { associated_rcs_sensors: ['kryptonite.LEGACY_SENSOR'] } },
    'kryptonite.LEGACY_SENSOR': { source: 'Nest', value: { serial_number: 'LEGACY_SENSOR' } },
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

let { processRawData: thermostat } = await importSource(new URL('../src/plugins/thermostat.js', import.meta.url));

function nestData() {
  let source = 'Nest';
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

test('thermostat, sensor and Heat Link reject complete retired REST resources', () => {
  const raw = nestData();
  const before = structuredClone(raw);
  for (const mapper of [thermostat, tempsensor, heatlink]) {
    assert.deepEqual(mapper(undefined, raw, { options: {} }), {});
  }
  assert.deepEqual(raw, before);
});

for (let [id, changes, mapper] of [
  ['shared.LEGACY', { target_temperature_low: 23 }, thermostat],
  ['track.LEGACY', { online: false }, thermostat],
  ['kryptonite.SENSOR_SERIAL', { current_temperature: 17 }, thermostat],
  ['rcs_settings.LEGACY', { active_rcs_sensors: [] }, tempsensor],
  ['device.LEGACY', { hot_water_temperature: 60 }, heatlink],
  ['where.HOME', { wheres: [{ where_id: 'room', name: 'Bedroom' }] }, thermostat],
]) {
  test('retired REST related update ' + id + ' is ignored', () => {
    let raw = nestData();
    Object.assign(raw[id].value, changes);
    let result = mapper(undefined, raw, { options: {} }, undefined, new Map([[id, { fields: new Set(Object.keys(changes)) }]]));
    assert.deepEqual(result, {});
  });
}

for (let reverse of [false, true]) {
  test('protobuf ignores retired REST regardless of resource order; reverse=' + reverse, () => {
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
        assert.deepEqual(result, {}, 'REST delta ' + changed + ' must not trigger protobuf reconciliation');
      }
    }
  });
}

test('unready protobuf does not fall back to retired REST thermostat, sensor or Heat Link state', () => {
  let raw = { ...rawData(), ...nestData() };
  raw.DEVICE_THERMOSTAT.value.configuration_done.deviceReady = false;
  for (let mapper of [thermostat, tempsensor, heatlink]) {
    let result = mapper(undefined, raw, { options: {} });
    assert.deepEqual(result, {});
  }
});
