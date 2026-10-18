// Verify mapper contracts and exclusion precedence across all supported discovery fixtures and data sources.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DATA_SOURCE, DEVICE_TYPE } from '../src/consts.js';
import { config, fixtures } from './helpers/discovery-fixtures.js';
import { importSource } from './helpers/import-source.js';

let modules = {};
for (let name of new Set(fixtures.map((fixture) => fixture.name))) {
  modules[name] = await importSource(new URL('../src/plugins/' + name + '.js', import.meta.url));
}
function setup(fixture, overrides = {}) {
  let id = fixture.id ?? 'DEVICE_TEST';
  let parents = structuredClone(fixture.parents ?? { STRUCTURE_HOME: { source: DATA_SOURCE.GOOGLE, value: {} } });
  let raw = {
    ...parents,
    [id]: { source: fixture.source ?? DATA_SOURCE.GOOGLE, value: { ...structuredClone(fixture.value), ...overrides } },
  };
  let options = structuredClone(config);
  let run = (type = fixture.type) => modules[fixture.name].processRawData(undefined, raw, options, type);
  return { id, raw, options, run };
}
for (let fixture of fixtures) {
  let label = fixture.name + ' / ' + (fixture.source ?? DATA_SOURCE.GOOGLE);
  test('mapper preserves cloud/configuration inputs: ' + label, () => {
    let flow = setup(fixture);
    let before = structuredClone([flow.raw, flow.options]);
    let result = Object.values(flow.run())[0];
    assert.equal(result.full, true);
    assert.equal(result.data.nest_google_device_uuid, flow.id);
    assert.deepEqual([flow.raw, flow.options], before);
    if (['lock', 'homeaway'].includes(fixture.name) === false) {
      assert.deepEqual(flow.run('Unsupported device type'), {});
    }
  });
  for (let [plugin, home, device, expected] of [
    [false, undefined, undefined, false],
    [true, undefined, undefined, true],
    [true, false, undefined, false],
    [false, true, undefined, true],
    [true, true, false, false],
    [false, false, true, true],
    [true, false, true, true],
  ]) {
    test('exclusion precedence: ' + label + ', plugin=' + plugin + ', home=' + home + ', device=' + device, () => {
      let flow = setup(fixture);
      let initial = Object.values(flow.run())[0].data;
      flow.options.options.exclude = plugin;
      flow.options.homes = [
        { google_home_uuid: initial.nest_google_home_uuid, nest_home_uuid: initial.nest_google_home_uuid, exclude: home },
      ];
      flow.options.devices = [{ serialNumber: initial.serialNumber.toLowerCase(), exclude: device, eveHistory: false }];
      let mapped = Object.values(flow.run())[0].data;
      assert.equal(mapped.excluded, expected);
      assert.equal(mapped.eveHistory, false);
    });
  }
  if (fixture.source !== DATA_SOURCE.NEST && fixture.name !== 'homeaway') {
    test('unready Google resource is not discovered: ' + label, () => {
      let flow = setup(fixture, { configuration_done: { deviceReady: false } });
      assert.deepEqual(flow.run(), {});
    });
  }
  test('invalid mapper containers are rejected: ' + label, () => {
    let mapper = modules[fixture.name].processRawData;
    for (let invalid of [undefined, null, [], 'invalid']) {
      assert.equal(mapper(undefined, invalid, config), undefined);
      assert.equal(mapper(undefined, {}, invalid), undefined);
    }
  });
}

let thermostat = fixtures.find((fixture) => fixture.name === 'thermostat');
for (let [mode, heat, cool, expectedMode, expectedTarget] of [
  ['HEAT', false, false, 'heat', 20],
  ['COOL', false, false, 'cool', 26],
  ['RANGE', false, false, 'range', 23],
  ['HEAT', true, false, 'ecoheat', 17],
  ['COOL', false, true, 'ecocool', 28],
  ['RANGE', true, true, 'ecorange', 22.5],
]) {
  test('thermostat raw traits normalise ' + expectedMode + ' targets and capabilities', () => {
    let flow = setup(thermostat, {
      hvac_equipment_capabilities: {
        hasStage2Heat: true,
        hasStage3Cool: true,
        hasHumidifier: true,
        hasDehumidifier: true,
        hasAirFilter: true,
      },
      eco_mode_state: { ecoMode: heat === true || cool === true ? 'ECO_MODE_ACTIVE' : 'ECO_MODE_INACTIVE' },
      eco_mode_settings: {
        ecoTemperatureHeat: { enabled: heat, value: { value: 17 } },
        ecoTemperatureCool: { enabled: cool, value: { value: 28 } },
      },
      target_temperature_settings: {
        enabled: { value: true },
        targetTemperature: {
          setpointType: 'SET_POINT_TYPE_' + mode,
          heatingTarget: { value: 20 },
          coolingTarget: { value: 26 },
        },
      },
      fan_control_capabilities: { maxAvailableSpeed: 'FAN_SPEED_SETTING_STAGE3' },
      fan_control_settings: { timerSpeed: 'FAN_SPEED_SETTING_STAGE2', timerEnd: { seconds: '100' }, timerDuration: { seconds: '1800' } },
      humidity_control_settings: { humidifierTargetHumidity: { value: 45 }, dehumidifierTargetHumidity: { value: 60 } },
      hvac_control: { hvacState: { heatStage2Active: true, humidifierActive: true, dehumidifierActive: false } },
      filter_reminder: { filterReplacementNeeded: { value: true } },
      temperature_lock_settings: { enabled: true, pinHash: 'fixture-hash' },
      structure_mode: { structureMode: 'STRUCTURE_MODE_VACATION' },
      leaf: { active: true },
      heat_schedule_settings: {
        type: 'SET_POINT_SCHEDULE_TYPE_HEAT',
        setpoints: {
          morning: { dayOfWeek: 'DAY_OF_WEEK_MONDAY', secondsInDay: '21600', heatingTarget: { value: 20 }, coolingTarget: { value: 26 } },
        },
      },
    });
    let data = Object.values(flow.run())[0].data;
    assert.partialDeepStrictEqual(data, {
      hvac_mode: expectedMode,
      target_temperature: expectedTarget,
      can_heat: true,
      can_cool: true,
      has_fan: true,
      fan_max_speed: 3,
      fan_timer_speed: 2,
      fan_state: true,
      has_humidifier: true,
      has_dehumidifier: true,
      has_air_filter: true,
      filter_replacement_needed: true,
      temperature_lock: true,
      vacation_mode: true,
      leaf: true,
      hvac_state: 'heating',
    });
    if (mode === 'HEAT') {
      assert.equal(data.schedules[0][0].time, 21600);
    }
  });
}
for (let [type, expected] of [
  ['nest.resource.NestLearningThermostat1Resource', 'Learning Thermostat (1st gen)'],
  ['nest.resource.NestLearningThermostat2Resource', 'Learning Thermostat (2nd gen)'],
  ['google.resource.GoogleBismuth1Resource', 'Learning Thermostat (4th gen)'],
  ['nest.resource.NestOnyxResource', 'Thermostat E (1st gen)'],
  ['google.resource.GoogleZirconium1Resource', 'Thermostat (2020)'],
]) {
  test('thermostat resource model ' + type, () => {
    let flow = setup(thermostat, { device_info: { ...thermostat.value.device_info, typeName: type } });
    let data = Object.values(flow.run(DEVICE_TYPE.THERMOSTAT))[0].data;
    assert.equal(data.model, expected);
  });
}

let protectGoogle = fixtures.find((fixture) => fixture.name === 'protect' && fixture.source !== DATA_SOURCE.NEST);
let protectNest = fixtures.find((fixture) => fixture.name === 'protect' && fixture.source === DATA_SOURCE.NEST);
for (let generation of [1, 2]) {
  for (let wired of [true, false]) {
    test('Protect model identification across both APIs: generation=' + generation + ', wired=' + wired, () => {
      let google = setup(protectGoogle, {
        device_info: {
          ...protectGoogle.value.device_info,
          typeName: 'nest.resource.NestProtect' + generation + (wired === true ? 'Line' : 'Battery') + 'PoweredResource',
        },
        wall_power: { present: wired, status: wired === true ? 'POWER_SOURCE_STATUS_ACTIVE' : 'POWER_SOURCE_STATUS_INACTIVE' },
      });
      let nest = setup(protectNest, {
        serial_number: (generation === 1 ? '05' : '06') + 'TEST',
        wired_or_battery: wired === true ? 0 : 1,
        line_power_present: wired,
      });
      for (let flow of [google, nest]) {
        let data = Object.values(flow.run())[0].data;
        assert.equal(
          data.model,
          'Protect (' + generation + (generation === 1 ? 'st' : 'nd') + ' gen, ' + (wired === true ? 'wired' : 'battery') + ')',
        );
        assert.equal(data.wired_or_battery, wired === false);
        assert.equal(data.line_power_present, wired);
      }
    });
  }
}
for (let [bank0, bank1, expected] of [
  [4.5, 5.4, 0],
  [5.4, 4.95, 50],
  [undefined, 5.4, 100],
  [4.95, undefined, 50],
  [0, 'bad', undefined],
]) {
  test('Protect voltage banks normalise battery percentage: ' + bank0 + '/' + bank1, () => {
    let flow = setup(protectGoogle, {
      battery_voltage_bank0: { batteryValue: { batteryVoltage: { value: bank0 } } },
      battery_voltage_bank1: { batteryValue: { batteryVoltage: { value: bank1 } } },
    });
    assert.equal(Object.values(flow.run())[0].data.battery_level, expected);
  });
}
for (let smoke of [false, true]) {
  for (let co of [false, true]) {
    test('Protect independent alarm, hush and self-test mapping: smoke=' + smoke + ', CO=' + co, () => {
      let google = setup(protectGoogle, {
        safety_alarm_smoke: {
          alarmState: smoke === true ? 'ALARM_STATE_ALARM' : 'ALARM_STATE_IDLE',
          silenceState: smoke === true ? 'SILENCE_STATE_SILENCED' : 'SILENCE_STATE_NOT_SILENCED',
        },
        safety_alarm_co: {
          alarmState: co === true ? 'ALARM_STATE_ALARM' : 'ALARM_STATE_IDLE',
          silenceState: co === true ? 'SILENCE_STATE_SILENCED' : 'SILENCE_STATE_NOT_SILENCED',
        },
        temperature: {
          faultInformation: { type: smoke === true ? 'TEMPERATURE_FAULT_TYPE_OUT_OF_NORMAL_RANGE' : 'TEMPERATURE_FAULT_TYPE_NONE' },
        },
        self_test: { lastMstEnd: { seconds: '100' } },
        legacy_structure_self_test: { mstInProgress: smoke, astInProgress: co },
        night_time_promise_settings: { greenLedEnabled: true },
        safety_structure_settings: { structureHushKey: 'fixture-hush-key' },
        legacy_protect_device_info: { autoAway: false },
      });
      let nest = setup(protectNest, {
        smoke_status: smoke === true ? 1 : 0,
        co_status: co === true ? 1 : 0,
        heat_status: smoke === true ? 1 : 0,
        hushed_state: smoke === true || co === true,
        latest_manual_test_end_utc_secs: '100',
        ntp_green_led_enable: true,
        auto_away: false,
        battery_level: 4950,
      });
      nest.raw['safety.home'].value.manual_self_test_in_progress = smoke === true || co === true;
      nest.raw['structure.home'] = { source: DATA_SOURCE.NEST, value: { topaz_hush_key: 'fixture-hush-key' } };
      for (let flow of [google, nest]) {
        let data = Object.values(flow.run())[0].data;
        assert.partialDeepStrictEqual(data, {
          smoke_status: smoke,
          co_status: co,
          heat_status: smoke,
          hushed_state: smoke === true || co === true,
          latest_alarm_test: 100,
          self_test_in_progress: smoke === true || co === true,
          ntp_green_led_enable: true,
          topaz_hush_key: 'fixture-hush-key',
        });
      }
      assert.equal(Object.values(nest.run())[0].data.battery_level, 50);
    });
  }
}
for (let list of ['criticalDevices', 'warningDevices']) {
  for (let [failure, field] of [
    ['FAILURE_TYPE_SMOKE', 'smoke_test_passed'],
    ['FAILURE_TYPE_TEMP', 'heat_test_passed'],
    ['FAILURE_TYPE_CO', 'co_test_passed'],
  ]) {
    test('Protect safety summary ' + list + ' overrides healthy sensor traits for ' + failure, () => {
      let flow = setup(protectGoogle, {
        smoke: {},
        temperature: {},
        carbon_monoxide: {},
        safety_summary: { [list]: [{ failures: [failure] }] },
      });
      let data = Object.values(flow.run())[0].data;
      for (let name of ['smoke_test_passed', 'heat_test_passed', 'co_test_passed']) {
        assert.equal(data[name], name !== field);
      }
    });
  }
}
for (let passed of [false, true]) {
  test('Protect sensor fault reports map consistently across APIs: passed=' + passed, () => {
    let google = setup(protectGoogle, {
      smoke: {
        infraredLedFault: { type: passed === true ? 'SMOKE_FAULT_TYPE_NONE' : 'SMOKE_FAULT_TYPE_FAILURE' },
        blueLedFault: { type: 'SMOKE_FAULT_TYPE_NONE' },
      },
      temperature: { faultInformation: { type: passed === true ? 'TEMPERATURE_FAULT_TYPE_NONE' : 'TEMPERATURE_FAULT_TYPE_FAILURE' } },
      carbon_monoxide: { faultInformation: { type: passed === true ? 'CO_FAULT_TYPE_NONE' : 'CO_FAULT_TYPE_FAILURE' } },
    });
    let nest = setup(protectNest, {
      component_smoke_test_passed: passed,
      component_temp_test_passed: passed,
      component_co_test_passed: passed,
    });
    for (let flow of [google, nest]) {
      let data = Object.values(flow.run())[0].data;
      assert.partialDeepStrictEqual(data, { smoke_test_passed: passed, heat_test_passed: passed, co_test_passed: passed });
    }
  });
}
