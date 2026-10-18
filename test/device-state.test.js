// Exercise normalised device updates through the real lifecycle and real HAP services.
// Matrices cover upstream transitions independently of HomeKit writes and retain cached identity.
import assert from 'node:assert/strict';
import hap from './helpers/homebridge-hap.js';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { importSource } from './helpers/import-source.js';
import HomeKitDevice from '../src/HomeKitDevice/HomeKitDevice.js';
import { LOW_BATTERY_LEVEL } from '../src/consts.js';

let C = hap.Characteristic;
let classes = {};
for (let name of ['thermostat', 'heatlink', 'lock', 'protect', 'tempsensor', 'homeaway', 'weather', 'floodlight']) {
  classes[name] = (await importSource(new URL('../src/plugins/' + name + '.js', import.meta.url))).default;
}
HomeKitDevice.PLUGIN_NAME = 'device-state-test';
let serial = 0;
async function setup(context, name, data = {}) {
  let serialNumber = 'STATE-' + serial++;
  let device = new classes[name](
    undefined,
    { version: 2.7, hap },
    {
      serialNumber,
      manufacturer: 'Nest',
      model: name,
      description: name,
      softwareVersion: '1.0.0',
      nest_google_device_uuid: 'DEVICE_TEST',
      associated_thermostat: 'DEVICE_PARENT',
      online: true,
      battery_level: 80,
      current_temperature: 21,
      current_humidity: 45,
      temperature_scale: 'C',
      hvac_mode: 'off',
      hvac_state: 'off',
      can_heat: true,
      can_cool: true,
      target_temperature: 22,
      target_temperature_low: 20,
      target_temperature_high: 24,
      has_humidifier: false,
      has_dehumidifier: false,
      has_fan: false,
      fan_state: false,
      fan_max_speed: 3,
      fan_timer_speed: 1,
      fan_duration: 1800,
      humidifier_state: false,
      dehumidifier_state: false,
      target_humidity_humidifier: 45,
      target_humidity_dehumidifier: 60,
      has_hot_water_temperature: true,
      has_hot_water_control: true,
      current_water_temperature: 50,
      hot_water_temperature: 55,
      hotwaterMinTemp: 45,
      hotwaterMaxTemp: 80,
      hot_water_active: false,
      hot_water_boost_active: false,
      hotwaterBoostTime: 1800,
      bolt_state: 'unlocked',
      bolt_actor: 'remote',
      auto_relock_duration: 0,
      max_auto_relock_duration: 300,
      tampered: false,
      smoke_status: false,
      co_status: false,
      smoke_test_passed: true,
      co_test_passed: true,
      replacement_date: Math.floor(Date.now() / 1000) + 86400,
      wired_or_battery: true,
      occupancy: false,
      ...data,
    },
  );
  device.accessory = new hap.Accessory(name, hap.uuid.generate(serialNumber));
  let warnings = [];
  device.accessory.on('characteristic-warning', (warning) => warnings.push(warning));
  let writes = [];
  device.set = async (values) => {
    writes.push(values);
  };
  let history = [];
  device.history = (...args) => history.push(args);
  context.after(() => device.remove());
  await device.onAdd();
  return { device, warnings, writes, history };
}
function value(service, type) {
  return service.getCharacteristic(type).value;
}

for (let [capability, canHeat, canCool, modes] of [
  ['heat/cool', true, true, ['off', 'heat', 'cool', 'range', 'ecoheat', 'ecocool', 'ecorange']],
  ['heat only', true, false, ['off', 'heat', 'ecoheat']],
  ['cool only', false, true, ['off', 'cool', 'ecocool']],
]) {
  for (let from of modes) {
    for (let to of modes) {
      test('thermostat ' + capability + ': upstream ' + from + ' -> ' + to, async (context) => {
        let flow = await setup(context, 'thermostat', { can_heat: canHeat, can_cool: canCool });
        let service = flow.device.thermostatService;
        let target = service.getCharacteristic(C.TargetHeatingCoolingState);
        let expected = { off: 0, heat: 1, cool: 2, range: 3, ecoheat: 1, ecocool: 2, ecorange: 3 };
        for (let mode of [from, to]) {
          await flow.device.update({ hvac_mode: mode });
          assert.equal(target.value, expected[mode]);
          assert.equal(await target.handleGetRequest(), expected[mode]);
        }
        assert.equal(flow.device.thermostatService, service);
        assert.equal(service.getCharacteristic(C.TargetHeatingCoolingState), target);
        assert.equal(flow.device.deviceData.can_heat, canHeat);
        assert.equal(flow.device.deviceData.can_cool, canCool);
        assert.deepEqual(flow.writes, [], 'cloud updates must not echo commands back upstream');
        assert.deepEqual(flow.warnings, []);
      });
    }
  }
}
for (let state of ['off', 'heating', 'cooling']) {
  test('thermostat publishes actual ' + state + ' independently of target mode', async (context) => {
    let flow = await setup(context, 'thermostat');
    await flow.device.update({ hvac_mode: 'range', hvac_state: state });
    assert.equal(value(flow.device.thermostatService, C.TargetHeatingCoolingState), 3);
    assert.equal(value(flow.device.thermostatService, C.CurrentHeatingCoolingState), { off: 0, heating: 1, cooling: 2 }[state]);
    assert.deepEqual(flow.writes, []);
    assert.deepEqual(flow.warnings, []);
  });
}
for (let [state, current, target] of [
  ['locked', 1, 1],
  ['unlocked', 0, 0],
  ['locking', 0, 1],
  ['unlocking', 1, 0],
  ['jammed', 2, 0],
  ['unknown', 3, 0],
]) {
  for (let [actor, secureAction, unsecureAction] of [
    ['physical', 9, 10],
    ['keypad', 4, 5],
    ['remote', 6, 7],
    ['voice', 6, 7],
    ['implicit', 8, 7],
    ['', 6, 7],
  ]) {
    test('lock ' + state + ' by ' + (actor || 'unspecified actor') + ' maps current, target and action', async (context) => {
      let flow = await setup(context, 'lock');
      let service = flow.device.lockService;
      await flow.device.update({ bolt_state: state, bolt_actor: actor, tampered: true, online: false });
      assert.equal(value(service, C.LockCurrentState), current);
      assert.equal(value(service, C.LockTargetState), target);
      assert.equal(value(service, C.LockLastKnownAction), target === 1 ? secureAction : unsecureAction);
      assert.equal(await service.getCharacteristic(C.LockCurrentState).handleGetRequest(), current);
      assert.equal(value(service, C.StatusTampered), C.StatusTampered.TAMPERED);
      assert.equal(value(service, C.StatusFault), C.StatusFault.GENERAL_FAULT);
      await flow.device.update({ bolt_state: 'locked', tampered: false, online: true });
      assert.equal(flow.device.lockService, service);
      assert.equal(value(service, C.StatusTampered), C.StatusTampered.NOT_TAMPERED);
      assert.equal(value(service, C.StatusFault), C.StatusFault.NO_FAULT);
      assert.deepEqual(flow.writes, []);
      // HAP does not list StatusFault on LockMechanism; retain visibility of this existing extension warning.
      assert.deepEqual(
        flow.warnings.map((warning) => warning.message),
        ['Characteristic not in required or optional characteristic section for service LockMechanism. Adding anyway.'],
      );
    });
  }
}
for (let online of [true, false]) {
  for (let associated of ['', 'DEVICE_PARENT']) {
    for (let active of [true, false]) {
      test('sensor availability: online=' + online + ', parent=' + associated + ', selected=' + active, async (context) => {
        let flow = await setup(context, 'tempsensor', { associated_thermostat: associated });
        for (let battery of [0, LOW_BATTERY_LEVEL, LOW_BATTERY_LEVEL + 1, 100]) {
          await flow.device.update({ online, active_sensor: active, battery_level: battery, current_temperature: 18.5 });
          assert.equal(value(flow.device.temperatureService, C.StatusActive), online === true && (associated === '' || active === true));
          assert.equal(value(flow.device.temperatureService, C.StatusFault), online === true ? 0 : 1);
          assert.equal(value(flow.device.temperatureService, C.CurrentTemperature), 18.5);
          assert.equal(value(flow.device.batteryService, C.BatteryLevel), battery);
          assert.equal(value(flow.device.batteryService, C.StatusLowBattery), battery <= LOW_BATTERY_LEVEL ? 1 : 0);
        }
        assert.deepEqual(flow.writes, []);
        assert.deepEqual(flow.warnings, []);
      });
    }
  }
}
for (let wired of [true, false]) {
  for (let [label, data, active, smokeFault, coFault] of [
    ['healthy', {}, true, 0, 0],
    ['offline', { online: false }, false, 1, 1],
    ['expired', { replacement_date: 1 }, false, 1, 1],
    ['smoke test failed', { smoke_test_passed: false }, true, 1, 0],
    ['CO test failed', { co_test_passed: false }, true, 0, 1],
  ]) {
    test('Protect ' + label + ', battery powered=' + wired + ': alarms and faults remain independent', async (context) => {
      let flow = await setup(context, 'protect', { wired_or_battery: wired });
      assert.equal(flow.device.motionService !== undefined, wired === false);
      for (let alarm of [true, false]) {
        await flow.device.update({ ...data, smoke_status: alarm, co_status: alarm, detected_motion: alarm });
        assert.equal(value(flow.device.smokeService, C.SmokeDetected), alarm === true ? 1 : 0);
        assert.equal(value(flow.device.carbonMonoxideService, C.CarbonMonoxideDetected), alarm === true ? 1 : 0);
        assert.equal(value(flow.device.smokeService, C.StatusActive), active);
        assert.equal(value(flow.device.smokeService, C.StatusFault), smokeFault);
        assert.equal(value(flow.device.carbonMonoxideService, C.StatusFault), coFault);
        if (wired === false) {
          assert.equal(value(flow.device.motionService, C.MotionDetected), alarm);
        }
      }
      if (wired === false) {
        await flow.device.update({ detected_motion: true });
        await flow.device.onShutdown();
        assert.equal(value(flow.device.motionService, C.MotionDetected), false);
      }
      assert.deepEqual(flow.writes, []);
      assert.deepEqual(flow.warnings, []);
    });
  }
}

test('Heat Link updates temperature and boost independently, and restores optional capabilities', async (context) => {
  let flow = await setup(context, 'heatlink');
  let service = flow.device.thermostatService;
  let boost = flow.device.switchService;
  for (let active of [true, false]) {
    await flow.device.update({ hot_water_active: active, hot_water_boost_active: active, hot_water_temperature: 60 });
    assert.equal(value(service, C.CurrentHeatingCoolingState), active === true ? 1 : 0);
    assert.equal(value(service, C.TargetTemperature), 60);
    assert.equal(value(boost, C.On), active);
    assert.equal(flow.device.thermostatService, service);
  }
  await flow.device.update({ has_hot_water_temperature: false, has_hot_water_control: false });
  assert.equal(flow.device.thermostatService, undefined);
  assert.equal(flow.device.switchService, undefined);
  assert.equal(flow.device.accessory.services.includes(service), false);
  await flow.device.update({ has_hot_water_temperature: true, has_hot_water_control: true });
  assert.equal(value(flow.device.thermostatService, C.TargetTemperature), 60);
  assert.equal(value(flow.device.switchService, C.On), false);
  assert.deepEqual(flow.writes, []);
  assert.deepEqual(flow.warnings, []);
});

test('Heat Link HomeKit commands address the associated thermostat', async (context) => {
  let flow = await setup(context, 'heatlink');
  await flow.device.thermostatService.getCharacteristic(C.TargetTemperature).handleSetRequest(60);
  await flow.device.switchService.getCharacteristic(C.On).handleSetRequest(true);
  assert.deepEqual(flow.writes, [
    { uuid: 'DEVICE_PARENT', hot_water_temperature: 60 },
    { uuid: 'DEVICE_PARENT', hot_water_boost_active: { state: true, time: 1800 } },
  ]);
});

for (let name of ['homeaway', 'weather']) {
  test(name + ' cloud updates retain services and publish their measurements', async (context) => {
    let flow = await setup(context, name);
    let services = [...flow.device.accessory.services];
    for (let occupied of [true, false]) {
      await flow.device.update({ occupancy: occupied, current_temperature: 18.5, current_humidity: 60 });
      if (name === 'homeaway') {
        assert.equal(value(flow.device.occupancyService, C.OccupancyDetected), occupied === true ? 1 : 0);
      } else {
        assert.equal(value(flow.device.temperatureService, C.CurrentTemperature), 18.5);
        assert.equal(value(flow.device.humidityService, C.CurrentRelativeHumidity), 60);
      }
      assert.deepEqual(flow.device.accessory.services, services);
    }
    assert.deepEqual(flow.writes, []);
    assert.deepEqual(flow.warnings, []);
  });
}

for (let [canHeat, canCool, requested, expected] of [
  [true, true, 1, 'heat'],
  [true, true, 2, 'cool'],
  [true, true, 3, 'range'],
  [true, false, 3, 'heat'],
  [false, true, 3, 'cool'],
  [true, false, 2, 'off'],
  [false, true, 1, 'off'],
  [false, false, 3, 'off'],
]) {
  test(
    'thermostat mode command respects capabilities: heat=' + canHeat + ', cool=' + canCool + ', request=' + requested,
    async (context) => {
      let flow = await setup(context, 'thermostat', { can_heat: canHeat, can_cool: canCool });
      await flow.device.setMode(requested);
      assert.deepEqual(flow.writes, [{ uuid: 'DEVICE_TEST', hvac_mode: expected }]);
      assert.deepEqual(flow.warnings, []);
    },
  );
}
for (let [mode, characteristic, expectedKey] of [
  ['heat', C.TargetTemperature, 'target_temperature_low'],
  ['cool', C.TargetTemperature, 'target_temperature_high'],
  ['off', C.TargetTemperature, 'target_temperature'],
  ['range', C.HeatingThresholdTemperature, 'target_temperature_low'],
  ['range', C.CoolingThresholdTemperature, 'target_temperature_high'],
]) {
  test('thermostat ' + mode + ' HomeKit target writes ' + expectedKey, async (context) => {
    let flow = await setup(context, 'thermostat');
    await flow.device.update({ hvac_mode: mode });
    await flow.device.thermostatService.getCharacteristic(characteristic).handleSetRequest(23);
    assert.deepEqual(flow.writes, [{ uuid: 'DEVICE_TEST', [expectedKey]: 23 }]);
    assert.deepEqual(flow.warnings, []);
  });
}
for (let hasLight of [true, false]) {
  test('floodlight exposes light controls only with the capability: ' + hasLight, async (context) => {
    // Exercise the light-specific subclass hook; camera/HKSV lifecycle is covered separately.
    let flow = await setup(context, 'floodlight', { has_light: hasLight, light_enabled: false, light_brightness: 50 });
    if (hasLight === true) {
      let service = flow.device.lightService;
      assert.equal(await service.getCharacteristic(C.On).handleGetRequest(), false);
      assert.equal(await service.getCharacteristic(C.Brightness).handleGetRequest(), 50);
      assert.equal(service.getCharacteristic(C.Brightness).props.minStep, 10);
      await service.getCharacteristic(C.On).handleSetRequest(true);
      await service.getCharacteristic(C.Brightness).handleSetRequest(70);
      assert.deepEqual(flow.writes, [
        { uuid: 'DEVICE_TEST', light_enabled: true },
        { uuid: 'DEVICE_TEST', light_brightness: 70 },
      ]);
      flow.device.deviceData.has_light = false;
      await flow.device.onAdd();
      assert.equal(flow.device.accessory.services.includes(service), false);
    }
    assert.equal(flow.device.lightService, undefined);
    assert.deepEqual(flow.warnings, []);
  });
}

for (let name of ['thermostat', 'heatlink', 'lock', 'protect', 'tempsensor', 'homeaway', 'weather']) {
  test(name + ' repeated setup reuses existing services and removal releases them', async (context) => {
    let flow = await setup(context, name);
    let accessory = flow.device.accessory;
    let services = [...accessory.services];
    await flow.device.onAdd();
    assert.deepEqual(flow.device.accessory.services, services);
    await flow.device.remove();
    assert.equal(flow.device.accessory, undefined);
    assert.deepEqual(
      accessory.services.map((service) => service.UUID),
      [hap.Service.AccessoryInformation.UUID],
    );
  });
}

for (let maxSpeed of [1, 3]) {
  test('thermostat fan controls, state and removal with ' + maxSpeed + ' speed stages', async (context) => {
    let flow = await setup(context, 'thermostat', { has_fan: true, fan_max_speed: maxSpeed });
    let service = flow.device.fanService;
    assert.equal(service.testCharacteristic(C.RotationSpeed), maxSpeed > 1);
    await service.getCharacteristic(C.Active).handleSetRequest(C.Active.ACTIVE);
    assert.equal(flow.writes.at(-1).fan_state, true);
    assert.equal(flow.writes.at(-1).fan_duration, 1800);
    await flow.device.update({ fan_state: true, fan_timer_speed: maxSpeed });
    assert.equal(await service.getCharacteristic(C.Active).handleGetRequest(), 1);
    if (maxSpeed > 1) {
      assert.equal(await service.getCharacteristic(C.RotationSpeed).handleGetRequest(), 100);
      await service.getCharacteristic(C.RotationSpeed).handleSetRequest(0);
      assert.equal(flow.writes.at(-1).fan_state, false);
    }
    await flow.device.update({ has_fan: false, fan_state: false });
    assert.equal(flow.device.fanService, undefined);
    await flow.device.update({ has_fan: true });
    assert.notEqual(flow.device.fanService, undefined);
  });
}
for (let [humidifier, dehumidifier, modes] of [
  [true, false, [1]],
  [false, true, [2]],
  [true, true, [0, 1, 2]],
]) {
  for (let mode of modes) {
    for (let active of [true, false]) {
      test(
        'thermostat humidity command: humidify=' + humidifier + ', dehumidify=' + dehumidifier + ', mode=' + mode + ', active=' + active,
        async (context) => {
          let flow = await setup(context, 'thermostat', { has_humidifier: humidifier, has_dehumidifier: dehumidifier });
          await flow.device.setHumidifierDehumidifierMode(active, mode);
          let expected = [];
          if (humidifier === true) {
            expected.push({ uuid: 'DEVICE_TEST', humidifier_state: active === true && mode !== 2, target_humidity_humidifier: 45 });
          }
          if (dehumidifier === true) {
            expected.push({ uuid: 'DEVICE_TEST', dehumidifier_state: active === true && mode !== 1, target_humidity_dehumidifier: 60 });
          }
          assert.deepEqual(flow.writes, expected);
          let service = flow.device.humidifierDehumidifierService;
          for (let state of [true, false]) {
            await flow.device.update({
              humidifier_state: humidifier === true && state === true,
              dehumidifier_state: dehumidifier === true && state === true,
            });
            assert.equal(value(service, C.Active), state === true ? 1 : 0);
            assert.equal(await service.getCharacteristic(C.Active).handleGetRequest(), state === true ? 1 : 0);
            await service.getCharacteristic(C.CurrentHumidifierDehumidifierState).handleGetRequest();
            await service.getCharacteristic(C.TargetHumidifierDehumidifierState).handleGetRequest();
          }
          assert.deepEqual(flow.warnings, []);
        },
      );
    }
  }
}
test('thermostat humidity thresholds route independently and capability changes retain the shared service', async (context) => {
  let flow = await setup(context, 'thermostat', { has_humidifier: true, has_dehumidifier: true, humiditySensor: true });
  let service = flow.device.humidifierDehumidifierService;
  await service.getCharacteristic(C.RelativeHumidityHumidifierThreshold).handleSetRequest(50);
  await service.getCharacteristic(C.RelativeHumidityDehumidifierThreshold).handleSetRequest(65);
  assert.deepEqual(flow.writes, [
    { uuid: 'DEVICE_TEST', target_humidity_humidifier: 50 },
    { uuid: 'DEVICE_TEST', target_humidity_dehumidifier: 65 },
  ]);
  for (let [humidifier, dehumidifier] of [
    [true, false],
    [true, true],
    [false, true],
    [true, true],
  ]) {
    await flow.device.update({ has_humidifier: humidifier, has_dehumidifier: dehumidifier, current_humidity: 55 });
    assert.equal(flow.device.humidifierDehumidifierService, service);
    assert.equal(service.testCharacteristic(C.RelativeHumidityHumidifierThreshold), humidifier);
    assert.equal(service.testCharacteristic(C.RelativeHumidityDehumidifierThreshold), dehumidifier);
    assert.equal(value(flow.device.humidityService, C.CurrentRelativeHumidity), 55);
    assert.equal(await flow.device.humidityService.getCharacteristic(C.CurrentRelativeHumidity).handleGetRequest(), 55);
  }
  await flow.device.update({ has_humidifier: false, has_dehumidifier: false });
  assert.equal(flow.device.humidifierDehumidifierService, undefined);
});

test('thermostat equipment changes update mode constraints without recreating the service', async (context) => {
  let flow = await setup(context, 'thermostat', { has_air_filter: true });
  let service = flow.device.thermostatService;
  for (let [heat, cool, allowed] of [
    [true, false, [0, 1]],
    [false, true, [0, 2]],
    [false, false, [0]],
    [true, true, [0, 1, 2, 3]],
  ]) {
    await flow.device.update({
      can_heat: heat,
      can_cool: cool,
      hvac_mode: 'off',
      removed_from_base: false,
      active_rcs_sensor: '',
      filter_replacement_needed: true,
    });
    assert.deepEqual(service.getCharacteristic(C.TargetHeatingCoolingState).props.validValues, allowed);
    assert.equal(value(service, C.FilterChangeIndication), C.FilterChangeIndication.CHANGE_FILTER);
    assert.equal(value(service, C.StatusFault), C.StatusFault.NO_FAULT);
    assert.equal(flow.device.thermostatService, service);
  }
  await service.getCharacteristic(C.LockPhysicalControls).handleSetRequest(C.LockPhysicalControls.CONTROL_LOCK_ENABLED);
  await service.getCharacteristic(C.LockPhysicalControls).handleSetRequest(C.LockPhysicalControls.CONTROL_LOCK_DISABLED);
  assert.deepEqual(
    flow.writes.map((entry) => entry.temperature_lock),
    [true, false],
  );
  await service.getCharacteristic(C.TemperatureDisplayUnits).handleSetRequest(C.TemperatureDisplayUnits.FAHRENHEIT);
  assert.equal(flow.writes.at(-1).temperature_scale, 'F');
});

for (let extension of ['mjs', 'js']) {
  test('thermostat loads external ' + extension + ' controls and waits for heat/cool/fan/humidity transitions', async (context) => {
    let directory = await mkdtemp(path.join(tmpdir(), 'nest-external-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    let file = path.join(directory, 'control.' + extension);
    await writeFile(
      file,
      'export const calls = []; export default function(log, options) {' +
        'calls.push(["options", options]); return Object.fromEntries(["heat", "cool", "fan", "humidifier", "dehumidifier", "off"]' +
        '.map(name => [name, async value => calls.push([name, value])])); }',
    );
    let { calls } = await import(pathToFileURL(file).href);
    let flow = await setup(context, 'thermostat', {
      external: '"' + path.join(directory, 'control') + '" "http://unit.invalid"',
      has_fan: true,
      has_humidifier: true,
      has_dehumidifier: true,
    });
    await flow.device.update({ hvac_state: 'heating' });
    await flow.device.update({ hvac_state: 'cooling' });
    await flow.device.update({ hvac_state: 'off' });
    await flow.device.update({ fan_state: true });
    await flow.device.update({ fan_state: false });
    await flow.device.update({ humidifier_state: true });
    await flow.device.update({ humidifier_state: false });
    await flow.device.update({ dehumidifier_state: true });
    await flow.device.update({ dehumidifier_state: false });
    assert.deepEqual(
      calls.map(([name]) => name),
      ['options', 'heat', 'off', 'cool', 'off', 'fan', 'off', 'humidifier', 'off', 'dehumidifier', 'off'],
    );
    assert.deepEqual(calls[0][1].slice(0, 2), ['http://unit.invalid', 'thermostat']);
    assert.deepEqual(flow.writes, []);
  });
}

for (let [name, data] of [
  ['thermostat', { has_fan: true, has_humidifier: true, has_dehumidifier: true, humiditySensor: true }],
  ['heatlink', {}],
  ['lock', {}],
  ['protect', {}],
  ['tempsensor', {}],
  ['homeaway', {}],
  ['weather', {}],
]) {
  test(name + ' registered HomeKit getters return values within their characteristic contracts', async (context) => {
    let flow = await setup(context, name, data);
    for (let service of flow.device.accessory.services) {
      for (let characteristic of service.characteristics) {
        if (typeof characteristic.getHandler !== 'function') {
          continue;
        }
        let result = await characteristic.handleGetRequest();
        if (typeof result === 'number') {
          assert.equal(Number.isFinite(result), true, characteristic.displayName);
          if (typeof characteristic.props.minValue === 'number') {
            assert.ok(result >= characteristic.props.minValue);
          }
          if (typeof characteristic.props.maxValue === 'number') {
            assert.ok(result <= characteristic.props.maxValue);
          }
        }
      }
    }
    assert.deepEqual(flow.writes, []);
  });
}
test('Eve thermostat schedule reports sorted comfort periods and forwards vacation changes only', async (context) => {
  let previous = HomeKitDevice.EVEHOME;
  context.after(() => {
    HomeKitDevice.EVEHOME = previous;
  });
  HomeKitDevice.EVEHOME = { GET: 'fixture-eve-get', SET: 'fixture-eve-set' };
  let flow = await setup(context, 'thermostat', {
    schedule_mode: 'heat',
    removed_from_base: false,
    schedules: {
      0: {
        late: { entry_type: 'setpoint', type: 'HEAT', time: 64800, temp: 21 },
        early: { entry_type: 'setpoint', type: 'HEAT', time: 21600, 'temp-min': 17 },
        ignored: { entry_type: 'other', type: 'HEAT', time: 1, temp: 30 },
      },
      1: {},
      99: {},
    },
  });
  let result = flow.device.onMessage(HomeKitDevice.EVEHOME.GET, {});
  assert.equal(result.enableschedule, true);
  assert.equal(result.attached, true);
  assert.deepEqual(result.programs[0], { id: 0, days: 'mon', schedule: [{ start: 64800, duration: 21600, ecotemp: 17, comforttemp: 21 }] });
  assert.equal(result.programs[2].days, 'mon');
  flow.device.onMessage(HomeKitDevice.EVEHOME.SET, { vacation: { status: true }, programs: [] });
  assert.deepEqual(flow.writes, [{ uuid: 'DEVICE_TEST', vacation_mode: true }]);
});
test('Eve Protect and Heat Link payloads expose device status and route supported settings', async (context) => {
  let previous = HomeKitDevice.EVEHOME;
  context.after(() => {
    HomeKitDevice.EVEHOME = previous;
  });
  HomeKitDevice.EVEHOME = { GET: 'fixture-eve-get', SET: 'fixture-eve-set' };
  let protect = await setup(context, 'protect', {
    latest_alarm_test: 123,
    self_test_in_progress: true,
    heat_status: false,
    ntp_green_led_enable: true,
    smoke_test_passed: true,
    heat_test_passed: true,
    hushed_state: false,
  });
  let result = protect.device.onMessage(HomeKitDevice.EVEHOME.GET, {});
  assert.deepEqual(result, {
    lastalarmtest: 123,
    alarmtest: true,
    heatstatus: false,
    statusled: true,
    smoketestpassed: true,
    heattestpassed: true,
    hushedstate: false,
  });
  protect.device.onMessage(HomeKitDevice.EVEHOME.SET, { alarmtest: true, statusled: false });
  assert.deepEqual(protect.writes, [{ uuid: 'DEVICE_TEST', ntp_green_led_enable: false }]);
  let heatlink = await setup(context, 'heatlink');
  assert.deepEqual(heatlink.device.onMessage(HomeKitDevice.EVEHOME.GET, {}), { attached: true });
});
for (let name of ['thermostat', 'heatlink', 'lock', 'protect', 'tempsensor', 'homeaway', 'weather']) {
  test(name + ' ignores invalid direct update payloads without replacing services', async (context) => {
    let flow = await setup(context, name);
    let services = [...flow.device.accessory.services];
    for (let data of [undefined, null, [], 'invalid']) {
      await flow.device.onUpdate(data);
    }
    assert.deepEqual(flow.device.accessory.services, services);
    if (typeof flow.device.onMessage === 'function') {
      for (let [type, message] of [
        [null, {}],
        ['', {}],
        ['unknown', null],
        ['unknown', []],
        ['unknown', {}],
      ]) {
        assert.equal(flow.device.onMessage(type, message), undefined);
      }
    }
    assert.deepEqual(flow.writes, []);
  });
}

test('weather optional environmental characteristics publish values and preserve their identity', async (context) => {
  let names = ['ForecastDay', 'ObservationStation', 'Condition', 'WindDirection', 'WindSpeed', 'SunriseTime', 'SunsetTime', 'EveElevation'];
  let previous = new Map(names.map((name) => [name, C[name]]));
  let pressure = hap.Service.EveAirPressureSensor;
  context.after(() => {
    for (let [name, definition] of previous) {
      if (definition === undefined) {
        delete C[name];
      } else {
        C[name] = definition;
      }
    }
    if (pressure === undefined) {
      delete hap.Service.EveAirPressureSensor;
    } else {
      hap.Service.EveAirPressureSensor = pressure;
    }
  });
  // Model the optional extension API using real HAP definitions and real services.
  for (let name of names) {
    let uuid = hap.uuid.generate('weather-contract-' + name);
    C[name] = class extends C {
      static UUID = uuid;
      constructor() {
        super(name, uuid, {
          format: ['WindSpeed', 'EveElevation'].includes(name) === true ? hap.Formats.FLOAT : hap.Formats.STRING,
          perms: [hap.Perms.PAIRED_READ, hap.Perms.NOTIFY],
        });
        this.value = this.getDefaultValue();
      }
    };
  }
  hap.Service.EveAirPressureSensor = class extends hap.Service {
    static UUID = hap.uuid.generate('weather-contract-pressure');
    constructor(name, subtype) {
      super(name, hap.Service.EveAirPressureSensor.UUID, subtype);
      this.addCharacteristic(C.EveElevation);
    }
  };
  let flow = await setup(context, 'weather', { elevation: 50 });
  let service = flow.device.temperatureService;
  await flow.device.update({
    current_temperature: 19,
    current_humidity: 65,
    forecast: 'Sunny tomorrow',
    station: 'Sydney',
    condition: 'Clear',
    wind_direction: 'NE',
    wind_speed: 12,
    sunrise: 1792353600,
    sunset: 1792396800,
  });
  for (let [name, expected] of [
    ['ForecastDay', 'Sunny tomorrow'],
    ['ObservationStation', 'Sydney'],
    ['Condition', 'Clear'],
    ['WindDirection', 'NE'],
    ['WindSpeed', 12],
    ['SunriseTime', new Date(1792353600000).toLocaleTimeString()],
    ['SunsetTime', new Date(1792396800000).toLocaleTimeString()],
  ]) {
    assert.equal(value(service, C[name]), expected);
  }
  assert.equal(value(flow.device.airPressureService, C.EveElevation), 50);
  await flow.device.update({ current_temperature: 20 });
  assert.equal(value(service, C.Condition), 'Clear');
  assert.equal(flow.device.temperatureService, service);
  assert.deepEqual(flow.warnings, []);
  // Remove while extension definitions still exist; the test cleanup restores globals afterwards.
  await flow.device.remove();
});
for (let response of [
  undefined,
  {},
  { location_weather: {} },
  {
    location_weather: {
      current_temperature: 18,
      current_humidity: 70,
      condition: 'Rain',
      wind_direction: 'S',
      wind_speed: 5,
      sunrise: 1792353600,
      sunset: 1792396800,
      station: 'Sydney',
      forecast: 'Rain',
    },
  },
]) {
  test(
    'weather polling handles ' + (response?.location_weather?.condition ?? 'missing measurements') + ' through real HAP updates',
    async (context) => {
      let flow = await setup(context, 'weather');
      await flow.device.update({ current_temperature: 20, current_humidity: 44 });
      let queries = [];
      flow.device.get = async (request) => {
        queries.push(request);
        return response;
      };
      await flow.device.onTimer({ timer: 'weather' });
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(queries, [{ uuid: 'DEVICE_TEST', location_weather: true }]);
      assert.equal(value(flow.device.temperatureService, C.CurrentTemperature), response?.location_weather?.current_temperature ?? 20);
      assert.equal(value(flow.device.humidityService, C.CurrentRelativeHumidity), response?.location_weather?.current_humidity ?? 44);
    },
  );
}

for (let locked of [false, true]) {
  test(
    'lock HomeKit commands address the selected resource and suppress duplicate target writes; initially locked=' + locked,
    async (context) => {
      let flow = await setup(context, 'lock', { bolt_state: locked === true ? 'locked' : 'unlocked' });
      await flow.device.update({ battery_level: 79 });
      let target = flow.device.lockService.getCharacteristic(C.LockTargetState);
      let requested = locked === true ? C.LockTargetState.UNSECURED : C.LockTargetState.SECURED;
      await target.handleSetRequest(requested);
      await target.handleSetRequest(requested);
      assert.deepEqual(flow.writes, [{ uuid: 'DEVICE_TEST', bolt_lock: locked === false }]);
      assert.equal(target.value, requested);
      let duration = flow.device.lockService.getCharacteristic(C.LockManagementAutoSecurityTimeout);
      assert.equal(await duration.handleGetRequest(), 0);
      await duration.handleSetRequest(0);
      assert.equal(flow.writes.length, 1);
      await duration.handleSetRequest(60);
      assert.deepEqual(flow.writes.at(-1), { uuid: 'DEVICE_TEST', auto_relock_duration: 60 });
    },
  );
}
for (let temperature of [false, true]) {
  for (let boost of [false, true]) {
    test('Heat Link exposes only supported controls: temperature=' + temperature + ', boost=' + boost, async (context) => {
      let flow = await setup(context, 'heatlink', { has_hot_water_temperature: temperature, has_hot_water_control: boost });
      assert.equal(flow.device.thermostatService !== undefined, temperature);
      assert.equal(flow.device.switchService !== undefined, boost);
      if (temperature === true) {
        let units = flow.device.thermostatService.getCharacteristic(C.TemperatureDisplayUnits);
        await units.handleSetRequest(C.TemperatureDisplayUnits.FAHRENHEIT);
        assert.deepEqual(flow.writes.at(-1), { uuid: 'DEVICE_PARENT', temperature_scale: 'F' });
        await units.handleSetRequest(C.TemperatureDisplayUnits.CELSIUS);
        assert.deepEqual(flow.writes.at(-1), { uuid: 'DEVICE_PARENT', temperature_scale: 'C' });
      }
      assert.deepEqual(flow.warnings, []);
    });
  }
}

for (let [duration, expected] of [
  [0, 'On with fan speed of 100%'],
  [60, 'On with fan speed of 100% for 1 min'],
  [120, 'On with fan speed of 100% for 2 mins'],
  [90061, 'On with fan speed of 100% for 1 day 1 hr 1 min'],
  [1393320, 'On with fan speed of 100% for 2 wks 2 days 3 hrs 2 mins'],
]) {
  test('thermostat fan duration ' + duration + ' keeps command duration and readable status consistent', async (context) => {
    let flow = await setup(context, 'thermostat', { has_fan: true, fan_duration: duration });
    let logs = [];
    flow.device.log = { info: (...args) => logs.push(args) };
    await flow.device.fanService.getCharacteristic(C.RotationSpeed).handleSetRequest(100);
    assert.equal(flow.writes.at(-1).fan_duration, duration);
    assert.equal(flow.writes.at(-1).fan_timer_speed, 3);
    assert.equal(logs.at(-1).at(-1), expected);
  });
}
for (let mode of ['heat', 'cool', 'off']) {
  for (let scale of ['C', 'F']) {
    test('thermostat ' + mode + ' target writes retain Celsius values while logging ' + scale, async (context) => {
      let flow = await setup(context, 'thermostat', { temperature_scale: scale });
      await flow.device.update({ hvac_mode: mode });
      let logs = [];
      flow.device.log = { info: (...args) => logs.push(args) };
      await flow.device.thermostatService.getCharacteristic(C.TargetTemperature).handleSetRequest(20);
      let key = mode === 'heat' ? 'target_temperature_low' : mode === 'cool' ? 'target_temperature_high' : 'target_temperature';
      assert.deepEqual(flow.writes.at(-1), { uuid: 'DEVICE_TEST', [key]: 20 });
      assert.deepEqual(logs.at(-1).slice(-2), scale === 'C' ? ['20.0', '°C'] : ['68.0', '°F']);
    });
  }
}
for (let active of [false, true]) {
  test('thermostat registered humidity mode setters and getters retain both capabilities; active=' + active, async (context) => {
    let flow = await setup(context, 'thermostat', { has_humidifier: true, has_dehumidifier: true });
    let service = flow.device.humidifierDehumidifierService;
    await service.getCharacteristic(C.Active).handleSetRequest(active === true ? C.Active.ACTIVE : C.Active.INACTIVE);
    for (let mode of [
      C.TargetHumidifierDehumidifierState.HUMIDIFIER,
      C.TargetHumidifierDehumidifierState.DEHUMIDIFIER,
      C.TargetHumidifierDehumidifierState.HUMIDIFIER_OR_DEHUMIDIFIER,
    ]) {
      await service.getCharacteristic(C.TargetHumidifierDehumidifierState).handleSetRequest(mode);
    }
    assert.deepEqual(flow.writes.slice(-2), [
      { uuid: 'DEVICE_TEST', humidifier_state: active, target_humidity_humidifier: 45 },
      { uuid: 'DEVICE_TEST', dehumidifier_state: active, target_humidity_dehumidifier: 60 },
    ]);
    assert.equal(await service.getCharacteristic(C.RelativeHumidityHumidifierThreshold).handleGetRequest(), 45);
    assert.equal(await service.getCharacteristic(C.RelativeHumidityDehumidifierThreshold).handleGetRequest(), 60);
  });
}

for (let [humidifier, dehumidifier, expected] of [
  [false, false, 0],
  [true, false, 2],
  [false, true, 3],
  [true, true, 2],
]) {
  test('thermostat humidity read agrees with its published actual state: ' + humidifier + '/' + dehumidifier, async (context) => {
    let flow = await setup(context, 'thermostat', { has_humidifier: true, has_dehumidifier: true });
    await flow.device.update({ humidifier_state: humidifier, dehumidifier_state: dehumidifier, current_humidity: 46 });
    let characteristic = flow.device.humidifierDehumidifierService.getCharacteristic(C.CurrentHumidifierDehumidifierState);
    assert.equal(characteristic.value, expected);
    assert.equal(await characteristic.handleGetRequest(), expected);
    assert.equal(await characteristic.handleGetRequest(), expected);
    assert.deepEqual(flow.writes, []);
  });
}
