// Verify source preference and effective operating modes using the file-backed thermostat mapper.
import { getResourceKey } from '../src/utils.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { importSource } from './helpers/import-source.js';
import { DATA_SOURCE } from '../src/consts.js';

let { processRawData } = await importSource(new URL('../src/plugins/thermostat.js', import.meta.url));

for (let eco of ['manual', 'auto']) {
  for (let normalMode of ['off', 'heat', 'cool', 'range']) {
    test('Eco with both limits disabled maps to Off: ' + DATA_SOURCE.PROTOBUF + '/' + eco + '/' + normalMode, () => {
      let id = 'DEVICE_GOOGLE';
      let value = {
        device_identity: { serialNumber: 'SERIAL' },
        configuration_done: { deviceReady: true },
        device_info: { typeName: 'nest.resource.NestLearningThermostat3Resource', pairerId: { resourceId: 'STRUCTURE_HOME' } },
        eco_mode_state: { ecoMode: eco === 'manual' ? 'ECO_MODE_MANUAL_ECO' : 'ECO_MODE_AUTO_ECO' },
        eco_mode_settings: {
          ecoTemperatureHeat: { enabled: false, value: { value: 4.5 } },
          ecoTemperatureCool: { enabled: false, value: { value: 24.5 } },
        },
        target_temperature_settings: {
          enabled: { value: normalMode !== 'off' },
          targetTemperature: {
            setpointType: 'SET_POINT_TYPE_' + (normalMode === 'off' ? 'heat' : normalMode).toUpperCase(),
            heatingTarget: { value: 19 },
            coolingTarget: { value: 25 },
          },
        },
      };
      let raw = {
        [id]: { source: DATA_SOURCE.PROTOBUF, value },
        STRUCTURE_HOME: { value: {} },
      };
      let field = 'eco_mode_state';
      let changed = new Map([[id, { fields: new Set([field]) }]]);
      let before = structuredClone(raw);
      let mapped = processRawData(undefined, raw, { options: {} }, undefined, changed).SERIAL.data;
      assert.equal(mapped.hvac_mode, 'off');
      assert.equal(mapped.eco_mode, eco);
      assert.equal(mapped.target_temperature_low, 19);
      assert.equal(mapped.target_temperature_high, 25);
      assert.deepEqual(raw, before, 'Presentation must not change the source mode needed after Eco');

      // Changing only enable flags must replace only that side's mapped target.
      for (let [heatEnabled, coolEnabled, low, high] of [
        [true, false, 4.5, 25],
        [false, true, 19, 24.5],
        [true, true, 4.5, 24.5],
        [false, false, 19, 25],
      ]) {
        value.eco_mode_settings.ecoTemperatureHeat.enabled = heatEnabled;
        value.eco_mode_settings.ecoTemperatureCool.enabled = coolEnabled;

        let flagsChanged = new Map([
          [
            id,
            {
              fields: new Set(['eco_mode_settings']),
            },
          ],
        ]);
        mapped = processRawData(undefined, raw, { options: {} }, undefined, flagsChanged).SERIAL.data;
        assert.equal(mapped.target_temperature_low, low);
        assert.equal(mapped.target_temperature_high, high);
      }

      // Missing settings do not confirm that both Eco sides are disabled.

      delete value.eco_mode_settings.ecoTemperatureHeat.enabled;

      mapped = processRawData(undefined, raw, { options: {} }, undefined, changed).SERIAL.data;
      assert.equal(mapped.hvac_mode, normalMode);

      value.eco_mode_settings.ecoTemperatureHeat.enabled = false;
      value.eco_mode_state.ecoMode = 'ECO_MODE_UNSPECIFIED';

      mapped = processRawData(undefined, raw, { options: {} }, undefined, changed).SERIAL.data;
      assert.equal(mapped.hvac_mode, normalMode);
      assert.equal(mapped.eco_mode, 'unknown');

      value.eco_mode_state.ecoMode = 'ECO_MODE_INACTIVE';

      mapped = processRawData(undefined, raw, { options: {} }, undefined, changed).SERIAL.data;
      assert.equal(mapped.hvac_mode, normalMode);
      assert.equal(mapped.eco_mode, 'off');
      assert.equal(mapped.target_temperature_low, 19);
      assert.equal(mapped.target_temperature_high, 25);
    });
  }
}

for (let firstSource of ['Nest', DATA_SOURCE.PROTOBUF]) {
  test('thermostat mapper ignores retired REST arriving first from ' + firstSource, () => {
    let nest = ['device.nest', { source: 'Nest', value: { serial_number: 'SERIAL', backplate_temperature: 19 } }];
    let google = [
      'DEVICE_GOOGLE',
      {
        source: DATA_SOURCE.PROTOBUF,
        value: {
          device_identity: { serialNumber: 'SERIAL' },
          device_info: { typeName: 'nest.resource.NestLearningThermostat3Resource', pairerId: { resourceId: 'STRUCTURE_HOME' } },
          configuration_done: { deviceReady: true },
          current_temperature: { temperatureValue: { temperature: { value: 21 } } },
        },
      },
    ];
    let raw = {
      ...Object.fromEntries(firstSource === 'Nest' ? [nest, google] : [google, nest]),
      'track.SERIAL': { value: {} },
      'shared.SERIAL': { value: {} },
      'link.SERIAL': { value: { structure: 'structure.home' } },
      'where.home': { value: {} },
      STRUCTURE_HOME: { value: {} },
    };
    let mapped = processRawData(
      undefined,
      raw,
      { options: {} },
      undefined,
      new Map([['DEVICE_GOOGLE', { fields: new Set(['current_temperature']) }]]),
    );
    assert.equal(mapped.SERIAL.full, false);
    assert.equal(mapped.SERIAL.data.nest_google_device_uuid, 'DEVICE_GOOGLE');
    assert.equal(mapped.SERIAL.data.current_temperature, 21);
    assert.deepEqual(
      processRawData(
        undefined,
        raw,
        { options: {} },
        undefined,
        new Map([['device.nest', { fields: new Set(['backplate_temperature']) }]]),
      ),
      {},
    );
    delete raw.DEVICE_GOOGLE;
    assert.deepEqual(
      processRawData(
        undefined,
        raw,
        { options: {} },
        undefined,
        new Map([['device.nest', { fields: new Set(['backplate_temperature']) }]]),
      ),
      {},
    );
  });
}

// Fabricated equivalents of the captured Foyer scalar buckets, with physical
// identity supplied by the device's Technical Information page.
function homeGraphThermostat(mode = 'cool') {
  return {
    [getResourceKey('account', 'HomeGraph', 'home', 'STRUCTURE')]: {
      source: DATA_SOURCE.HOMEGRAPH,
      connection: 'account',
      value: { home: { uuid: 'home', name: 'Home', rooms: [{ uuid: 'room', name: 'Kitchen' }] } },
    },
    [getResourceKey('account', 'HomeGraph', 'thermostat')]: {
      source: DATA_SOURCE.HOMEGRAPH,
      connection: 'account',
      value: {
        structureId: 'home',
        roomId: 'room',
        technicalInformation: { serialNumber: 'THERMOSTAT' },
        googleHome: {
          id: { googleUuid: 'thermostat', thirdPartyId: { idType: 'nest-home-assistant-prod' } },
          type: 'action.devices.types.THERMOSTAT',
          displayName: 'Kitchen',
          hardware: { model: 'Nest Thermostat E', softwareVersion: '6.5-14' },
        },
        'deviceStatus.online': { boolean: true },
        'temperatureSetting.mode': { text: mode },
        'temperatureSetting.activeThermostatMode': { text: 'none' },
        'temperatureSetting.ambientAirTemperatureC': { number: 22.5 },
        'temperatureSetting.backplateAmbientAirTemperatureC': { number: 22 },
        'temperatureSetting.ambientAirHumidity': { number: 0.533 },
        'temperatureSetting.thermostatTemperatureSetpointC': { number: 24.5 },
        'attributes.temperatureSetting.availableThermostatModes': {
          array: { values: ['heat', 'cool', 'heatcool', 'eco', 'off'].map((text) => ({ text })) },
        },
        'attributes.temperatureSetting.temperatureUnit': { text: 'C' },
        'attributes.fanSpeed.availableFanSpeeds': {
          properties: {
            properties: [
              {
                name: 'speeds',
                value: {
                  array: {
                    values: ['OFF', 'S1'].map((text) => ({ properties: { properties: [{ name: 'speed_name', value: { text } }] } })),
                  },
                },
              },
            ],
          },
        },
        'fanSpeed.currentFanSpeedSetting': { text: 'OFF' },
        'fanSettings.fanTimerEndTimestampSec': { number: 0 },
      },
    },
  };
}

test('HomeGraph thermostat firmware must be device reported', () => {
  let raw = homeGraphThermostat('cool');
  delete raw[getResourceKey('account', 'HomeGraph', 'thermostat')].value.googleHome.hardware.softwareVersion;
  let result = mappedHomeGraph(raw);
  assert.equal(result.data.softwareVersion, undefined);
  assert.equal(result.full, false);
});

function mappedHomeGraph(raw, changed) {
  return processRawData(
    undefined,
    raw,
    { options: {}, homes: [{ homegraph_home_uuid: getResourceKey('account', 'HomeGraph', 'home', 'STRUCTURE'), exclude: true }] },
    undefined,
    changed,
  )?.THERMOSTAT;
}

test('HomeGraph thermostat maps Cool 24.5, humidity, fan and stable physical identity', () => {
  let raw = homeGraphThermostat();
  let before = structuredClone(raw);
  let result = mappedHomeGraph(raw);
  assert.equal(result.full, true);
  assert.equal(result.data.serialNumber, 'THERMOSTAT');
  assert.equal(result.data.hvac_mode, 'cool');
  assert.equal(result.data.target_temperature, 24.5);
  assert.equal(result.data.target_temperature_high, 24.5);
  assert.equal(result.data.current_temperature, 22.5);
  assert.equal(result.data.current_humidity, 53);
  assert.equal(result.data.temperature_scale, 'C');
  assert.equal(result.data.can_heat, true);
  assert.equal(result.data.can_cool, true);
  assert.equal(result.data.has_fan, true);
  assert.equal(result.data.fan_max_speed, 1);
  assert.equal(result.data.fan_state, false);
  assert.equal(result.data.fan_duration, 900);
  assert.equal(result.data.excluded, true);
  assert.equal(result.data.battery_level, undefined);
  assert.equal(result.data.source, undefined);
  assert.equal(result.data.googleHome, undefined);
  assert.deepEqual(raw, before);
});

for (let [mode, low, high, expected, target] of [
  ['heat', undefined, undefined, 'heat', 24.5],
  ['heatcool', 19, 25, 'range', 22],
  ['eco', 19, 25, 'ecorange', 22],
  ['eco', 19, undefined, 'ecoheat', 19],
  ['eco', undefined, 25, 'ecocool', 25],
  ['eco', undefined, undefined, 'off', undefined],
  ['off', undefined, undefined, 'off', undefined],
  ['on', 19, 25, 'range', 22],
  ['unrecognised', undefined, undefined, undefined, undefined],
]) {
  test('HomeGraph thermostat effective mode ' + mode + '/' + low + '/' + high, () => {
    let raw = homeGraphThermostat(mode);
    let value = raw[getResourceKey('account', 'HomeGraph', 'thermostat')].value;
    if (mode !== 'heat') {
      delete value['temperatureSetting.thermostatTemperatureSetpointC'];
    }
    if (low !== undefined) {
      value['temperatureSetting.thermostatTemperatureSetpointLowC'] = { number: low };
    }
    if (high !== undefined) {
      value['temperatureSetting.thermostatTemperatureSetpointHighC'] = { number: high };
    }
    let result = mappedHomeGraph(raw).data;
    assert.equal(result.hvac_mode, expected);
    assert.equal(result.target_temperature, target);
    assert.equal(result.target_temperature_low, mode === 'heat' ? 24.5 : low);
    assert.equal(result.target_temperature_high, high);
  });
}

test('HomeGraph selected sensor follows only explicitly linked same-account/home temperatures', () => {
  let raw = homeGraphThermostat();
  let value = raw[getResourceKey('account', 'HomeGraph', 'thermostat')].value;
  value['temperatureSetting.knownThermostatTemperatureSensors'] = {
    array: { values: [{ properties: { properties: [{ name: 'sensorId', value: { text: 'sensor' } }] } }] },
  };
  value['temperatureSetting.activeThermostatTemperatureSensors'] = { array: { values: [{ text: 'sensor' }] } };
  raw[getResourceKey('account', 'HomeGraph', 'sensor')] = {
    source: DATA_SOURCE.HOMEGRAPH,
    connection: 'account',
    value: {
      structureId: 'home',
      googleHome: { id: { googleUuid: 'sensor' } },
      'temperatureSetting.ambientAirTemperatureC': { number: 18.5 },
    },
  };
  let changed = new Map([[getResourceKey('account', 'HomeGraph', 'sensor'), {}]]);
  let mapped = mappedHomeGraph(raw, changed).data;
  assert.equal(mapped.current_temperature, 18.5);
  assert.equal(mapped.active_rcs_sensor, getResourceKey('account', 'HomeGraph', 'sensor'));
  assert.deepEqual(mapped.linked_rcs_sensors, [getResourceKey('account', 'HomeGraph', 'sensor')]);
  raw[getResourceKey('account', 'HomeGraph', 'sensor')].connection = 'other';
  assert.equal(mappedHomeGraph(raw).data.current_temperature, 22.5);
  raw[getResourceKey('account', 'HomeGraph', 'sensor')].connection = 'account';
  raw[getResourceKey('account', 'HomeGraph', 'sensor')].value.structureId = 'other';
  assert.equal(mappedHomeGraph(raw).data.current_temperature, 22.5);
  value['temperatureSetting.activeThermostatTemperatureSensors'] = { array: { values: [{ text: 'thermostat' }] } };
  assert.equal(mappedHomeGraph(raw).data.active_rcs_sensor, '');
});

test('HomeGraph thermostat missing identity stays partial and invalid values stay unknown', () => {
  let raw = homeGraphThermostat();
  let value = raw[getResourceKey('account', 'HomeGraph', 'thermostat')].value;
  delete value.technicalInformation;
  assert.equal(mappedHomeGraph(raw), undefined);
  value.technicalInformation = { serialNumber: 'THERMOSTAT' };
  delete value['attributes.temperatureSetting.temperatureUnit'];
  value['temperatureSetting.ambientAirHumidity'] = { number: 2 };
  value['temperatureSetting.thermostatTemperatureSetpointC'] = { number: NaN };
  value['charging.capacityRemainingPercentage'] = { number: 85 };
  assert.equal(mappedHomeGraph(raw).data.temperature_scale, 'C');
  assert.equal(mappedHomeGraph(raw).data.target_temperature, undefined);
  assert.equal(mappedHomeGraph(raw).data.current_humidity, undefined);
  assert.equal(mappedHomeGraph(raw).data.battery_level, 85);
  value['charging.capacityRemainingPercentage'] = { number: 101 };
  value['charging.descriptiveCapacityRemaining'] = { text: 'medium' };
  assert.equal(mappedHomeGraph(raw).data.battery_level, 50);
});

for (let order of ['protobuf-first', 'homegraph-first']) {
  test('complete HomeGraph thermostat wins source selection: ' + order, () => {
    let homeGraph = homeGraphThermostat();
    let protobuf = {
      DEVICE_PROTO: {
        source: DATA_SOURCE.PROTOBUF,
        value: {
          device_identity: { serialNumber: 'THERMOSTAT', softwareVersion: '1.0' },
          device_info: { typeName: 'nest.resource.NestLearningThermostat3Resource', pairerId: { resourceId: 'STRUCTURE_PROTO' } },
          configuration_done: { deviceReady: true },
          label: { label: 'Thermostat' },
          current_temperature: { temperatureValue: { temperature: { value: 18 } } },
        },
      },
      STRUCTURE_PROTO: { value: {} },
    };
    let raw = order === 'protobuf-first' ? { ...protobuf, ...homeGraph } : { ...homeGraph, ...protobuf };
    assert.equal(mappedHomeGraph(raw).full, true);
    assert.equal(mappedHomeGraph(raw).data.nest_google_device_uuid, getResourceKey('account', 'HomeGraph', 'thermostat'));
    assert.equal(
      mappedHomeGraph(raw, new Map([['DEVICE_PROTO', {}]])).data.nest_google_device_uuid,
      getResourceKey('account', 'HomeGraph', 'thermostat'),
    );
    let preferred = raw[getResourceKey('account', 'HomeGraph', 'thermostat')].value;
    preferred['deviceStatus.online'].boolean = false;
    preferred['temperatureSetting.ambientAirTemperatureC'].number = 0;
    raw.DEVICE_PROTO.value.remote_comfort_sensing_settings = {
      activeRcsSelection: { activeRcsSensor: { resourceId: 'DEVICE_PROTO_SENSOR' } },
      associatedRcsSensors: [{ deviceId: { resourceId: 'DEVICE_PROTO_SENSOR' } }],
    };
    let combined = mappedHomeGraph(raw, new Map([['DEVICE_PROTO', {}]])).data;
    assert.equal(combined.online, false);
    assert.equal(combined.current_temperature, 0);
    assert.equal(combined.active_rcs_sensor, undefined, 'do not borrow a sensor ID from the other API');
    assert.equal(combined.linked_rcs_sensors, undefined);
    delete preferred.googleHome.hardware.softwareVersion;
    delete preferred['temperatureSetting.ambientAirTemperatureC'];
    combined = mappedHomeGraph(raw, new Map([['DEVICE_PROTO', {}]])).data;
    assert.equal(combined.softwareVersion, '1.0.0');
    assert.equal(combined.current_temperature, 18);
    assert.equal(combined.nest_google_device_uuid, getResourceKey('account', 'HomeGraph', 'thermostat'));
    delete raw[getResourceKey('account', 'HomeGraph', 'thermostat')].value.technicalInformation;
    assert.equal(mappedHomeGraph(raw).data.nest_google_device_uuid, 'DEVICE_PROTO');
  });
}

test('HomeGraph thermostat reports fan activity, HVAC activity, Fahrenheit and ignores unrelated batches', () => {
  let raw = homeGraphThermostat();
  let value = raw[getResourceKey('account', 'HomeGraph', 'thermostat')].value;
  value['attributes.temperatureSetting.temperatureUnit'] = { text: 'F' };
  value['fanSettings.fanTimerEndTimestampSec'] = { number: Date.now() / 1000 + 900 };
  value['fanSpeed.currentFanSpeedSetting'] = { text: 'S1' };
  for (let [reported, expected] of [
    ['heat', 'heating'],
    ['cool', 'cooling'],
    ['unknown', undefined],
  ]) {
    value['temperatureSetting.activeThermostatMode'] = { text: reported };
    let mapped = mappedHomeGraph(raw).data;
    assert.equal(mapped.hvac_state, expected);
    assert.equal(mapped.temperature_scale, 'F');
    assert.equal(mapped.fan_state, true);
    assert.equal(mapped.fan_timer_speed, 1);
  }
  assert.equal(mappedHomeGraph(raw, new Map([['unrelated', {}]])), undefined);
});
