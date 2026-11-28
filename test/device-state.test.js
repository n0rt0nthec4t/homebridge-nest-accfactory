// Exercise normalised device updates through the real lifecycle and real HAP services.
// Matrices cover upstream transitions independently of HomeKit writes and retain cached identity.
import { getResourceKey } from '../src/utils.js';
import assert from 'node:assert/strict';
import hap from './helpers/homebridge-hap.js';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { importSource } from './helpers/import-source.js';
import HomeKitDevice from '../src/HomeKitDevice/HomeKitDevice.js';
import HomeKitHistory from '../src/HomeKitHistory/HomeKitHistory.js';
import { protectHomeGraphFixture, protectSensorProperty } from './helpers/protect-homegraph-fixture.js';
import { LOW_BATTERY_LEVEL, CUSTOM_CHARACTERISTIC_UUID, DATA_SOURCE } from '../src/consts.js';

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
      eco_mode: 'off',
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

test('thermostat Eco characteristic retains its type and cached service without adding a switch', async (context) => {
  let flow = await setup(context, 'thermostat', { eco_mode: 'manual' });
  await flow.device.onUpdate(flow.device.deviceData);
  let service = flow.device.thermostatService;
  let control = service.getCharacteristic(C.EcoMode);
  assert.equal(control.UUID, CUSTOM_CHARACTERISTIC_UUID.ECO_MODE);
  assert.equal(control.displayName, 'Eco Mode');
  assert.equal(control.props.format, hap.Formats.BOOL);
  assert.deepEqual(control.props.perms, [hap.Perms.PAIRED_READ, hap.Perms.PAIRED_WRITE, hap.Perms.NOTIFY]);
  assert.equal(flow.device.accessory.getService(hap.Service.Switch), undefined);
  let uuid = flow.device.accessory.UUID;
  let services = flow.device.accessory.services.map((item) => [item.UUID, item.subtype]);
  flow.device.accessory = hap.Accessory.deserialize(hap.Accessory.serialize(flow.device.accessory));
  let cachedService = flow.device.accessory.getService(hap.Service.Thermostat);
  let cachedControl = cachedService.getCharacteristic(C.EcoMode);
  await flow.device.onAdd();
  await flow.device.onUpdate(flow.device.deviceData);
  assert.equal(flow.device.accessory.UUID, uuid);
  assert.deepEqual(
    flow.device.accessory.services.map((item) => [item.UUID, item.subtype]),
    services,
  );
  assert.equal(flow.device.thermostatService, cachedService);
  assert.equal(cachedService.getCharacteristic(C.EcoMode), cachedControl);
  assert.equal(cachedService.characteristics.filter((item) => item.UUID === control.UUID).length, 1);
  assert.equal(await cachedControl.handleGetRequest(), true);
  assert.equal(typeof cachedControl.setHandler, 'function');
  assert.equal(typeof cachedControl.getHandler, 'function');
  assert.deepEqual(flow.writes, []);
  assert.deepEqual(flow.warnings, []);
});

for (let name of ['thermostat', 'tempsensor']) {
  test(name + ' migrates cached source selection to a shared writable characteristic', async (context) => {
    let flow = await setup(context, name, { active_sensor: true, active_rcs_sensor: 'REMOTE' });
    let device = flow.device;
    let service = name === 'thermostat' ? device.thermostatService : device.temperatureService;
    let control = service.getCharacteristic(C.ActiveTemperatureSensor);
    assert.equal(control.UUID, CUSTOM_CHARACTERISTIC_UUID.ACTIVE_TEMPERATURE_SENSOR);
    assert.equal(control.displayName, 'Active Temperature Sensor');
    assert.equal(control.props.format, hap.Formats.BOOL);
    assert.deepEqual(control.props.perms, [hap.Perms.PAIRED_READ, hap.Perms.PAIRED_WRITE, hap.Perms.NOTIFY]);
    assert.equal(service.testCharacteristic(C.StatusActive), true);
    let identity = [device.accessory.UUID, service.UUID, service.subtype];
    // Simulate cached selection state from the previous release.
    service.updateCharacteristic(C.StatusActive, false);
    device.accessory = hap.Accessory.deserialize(hap.Accessory.serialize(device.accessory));
    let cached = device.accessory.getService(name === 'thermostat' ? hap.Service.Thermostat : hap.Service.TemperatureSensor);
    let cachedControl = cached.getCharacteristic(C.ActiveTemperatureSensor);
    await device.onAdd();
    await device.onUpdate(device.deviceData);
    assert.deepEqual([device.accessory.UUID, cached.UUID, cached.subtype], identity);
    assert.equal(name === 'thermostat' ? device.thermostatService : device.temperatureService, cached);
    assert.equal(cached.getCharacteristic(C.ActiveTemperatureSensor), cachedControl);
    assert.equal(cached.testCharacteristic(C.StatusActive), true);
    let cachedStatus = cached.getCharacteristic(C.StatusActive);
    assert.equal(cachedStatus.value, true);
    assert.equal(await cachedControl.handleGetRequest(), name === 'tempsensor');
    await cachedControl.handleSetRequest(true);
    assert.deepEqual(flow.writes, [{ uuid: 'DEVICE_TEST', active_sensor: true }]);
    if (name === 'thermostat') {
      await assert.rejects(
        cachedControl.handleSetRequest(false),
        (error) => (error.hapStatus ?? error) === hap.HAPStatus.INVALID_VALUE_IN_REQUEST,
      );
      await device.update({ active_rcs_sensor: '', online: false });
      assert.equal(cachedControl.value, true);
      assert.equal(await cachedControl.handleGetRequest(), true);
      await device.update({ active_rcs_sensor: 'ANOTHER_REMOTE' });
      assert.equal(cachedControl.value, false);
    } else {
      await cachedControl.handleSetRequest(false);
      assert.deepEqual(flow.writes[1], { uuid: 'DEVICE_TEST', active_sensor: false });
      await device.update({ active_sensor: false });
      await cachedControl.handleSetRequest(false);
      assert.equal(flow.writes.length, 2, 'Off on an unselected sensor must not clear another selection');
      await device.update({ active_sensor: true, online: false });
      assert.equal(cachedControl.value, true, 'offline selection remains independent of availability');
      await device.update({ associated_thermostat: '' });
      await assert.rejects(
        cachedControl.handleSetRequest(true),
        (error) => (error.hapStatus ?? error) === hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE,
      );
      await device.update({ associated_thermostat: 'DEVICE_PARENT' });
    }
    assert.equal(cachedStatus.value, false, 'offline availability is independent of the selected sensor');
    await device.update({ online: true });
    assert.equal(cachedStatus.value, true);
    assert.equal(cached.getCharacteristic(C.StatusActive), cachedStatus);
    device.set = async () => {
      throw new Error('fixture command rejected');
    };
    await assert.rejects(
      cachedControl.handleSetRequest(true),
      (error) => (error.hapStatus ?? error) === hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
    );
    assert.equal(cached.characteristics.filter((item) => item.UUID === control.UUID).length, 1);
    assert.deepEqual(flow.warnings, []);
  });
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
    ['implicit', 8, undefined],
    ['', undefined, undefined],
  ]) {
    test('lock ' + state + ' by ' + (actor || 'unspecified actor') + ' maps current, target and action', async (context) => {
      let flow = await setup(context, 'lock');
      let service = flow.device.lockService;
      await flow.device.update({ bolt_state: state, bolt_actor: actor, tampered: true, online: false });
      assert.equal(value(service, C.LockCurrentState), current);
      assert.equal(value(service, C.LockTargetState), target);
      let action = state === 'locked' ? secureAction : state === 'unlocked' ? unsecureAction : undefined;
      assert.equal(service.testCharacteristic(C.LockLastKnownAction), action !== undefined);
      if (action !== undefined) {
        assert.equal(value(service, C.LockLastKnownAction), action);
        assert.equal(await service.getCharacteristic(C.LockLastKnownAction).handleGetRequest(), action);
      }
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
test('lock last action follows available methods without retaining inferred cached actions', async (context) => {
  let flow = await setup(context, 'lock', { bolt_actor: null });
  let service = flow.device.lockService;
  let uuid = flow.device.accessory.UUID;
  assert.equal(service.testCharacteristic(C.LockLastKnownAction), false);
  await flow.device.update({ bolt_state: 'locked', bolt_actor: 'keypad' });
  let actionUUID = service.getCharacteristic(C.LockLastKnownAction).UUID;
  assert.equal(await service.getCharacteristic(C.LockLastKnownAction).handleGetRequest(), C.LockLastKnownAction.SECURED_BY_KEYPAD);
  await flow.device.update({ bolt_state: 'unlocked', bolt_actor: null });
  assert.equal(service.testCharacteristic(C.LockLastKnownAction), false);
  await flow.device.update({ bolt_state: 'unlocked', bolt_actor: 'physical' });
  assert.equal(service.getCharacteristic(C.LockLastKnownAction).UUID, actionUUID);
  assert.equal(await service.getCharacteristic(C.LockLastKnownAction).handleGetRequest(), C.LockLastKnownAction.UNSECURED_PHYSICALLY);
  assert.equal(flow.device.lockService, service);
  assert.equal(flow.device.accessory.UUID, uuid);
  assert.deepEqual(flow.writes, []);

  // An old cached service may contain a last-action characteristic without a current method.
  flow.device.accessory = hap.Accessory.deserialize(hap.Accessory.serialize(flow.device.accessory));
  flow.device.deviceData.bolt_actor = null;
  await flow.device.onAdd();
  assert.equal(flow.device.lockService.testCharacteristic(C.LockLastKnownAction), false);
  assert.equal(flow.device.accessory.UUID, uuid);
  assert.equal(flow.device.lockService.UUID, service.UUID);
  assert.equal(flow.device.lockService.subtype, service.subtype);
});

for (let online of [true, false]) {
  for (let associated of ['', 'DEVICE_PARENT']) {
    for (let active of [true, false]) {
      test('sensor availability: online=' + online + ', parent=' + associated + ', selected=' + active, async (context) => {
        let flow = await setup(context, 'tempsensor', { associated_thermostat: associated });
        for (let battery of [0, LOW_BATTERY_LEVEL, LOW_BATTERY_LEVEL + 1, 100]) {
          await flow.device.update({ online, active_sensor: active, battery_level: battery, current_temperature: 18.5 });
          assert.equal(value(flow.device.temperatureService, C.StatusActive), online);
          assert.equal(value(flow.device.temperatureService, C.ActiveTemperatureSensor), active);
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

for (let softwareVersion of ['3.6.8', '5.0.31', '5.0.38', '5.1.0', '6.0.0']) {
  test('Protect motion availability follows firmware series: ' + softwareVersion, async (context) => {
    let flow = await setup(context, 'protect', { wired_or_battery: false, softwareVersion, logMotionEvents: true });
    let affected = softwareVersion.startsWith('5.');
    assert.equal(flow.device.motionService === undefined, affected);
    assert.equal(flow.device.accessory.getService(hap.Service.MotionSensor) === undefined, affected);
    let logs = [];
    flow.device.log = { info: (...args) => logs.push(args) };
    await flow.device.update({ detected_motion: true });
    assert.equal(logs.length, affected === true ? 0 : 1);
    assert.equal(flow.history.length, affected === true ? 0 : 1);
    if (affected === false) {
      assert.equal(value(flow.device.motionService, C.MotionDetected), true);
    }
    assert.deepEqual(flow.warnings, []);
  });
}

test('Protect removes cached motion on 5.x without replacing other services', async (context) => {
  let flow = await setup(context, 'protect', { wired_or_battery: false, softwareVersion: '3.6.8', logMotionEvents: true });
  let accessory = flow.device.accessory;
  let services = [flow.device.smokeService, flow.device.carbonMonoxideService, flow.device.batteryService];
  let motion = flow.device.motionService;
  let logs = [];
  flow.device.log = { info: (...args) => logs.push(args) };
  flow.device.deviceData.softwareVersion = '5.0.38';
  await flow.device.onAdd();
  await flow.device.update({ detected_motion: false });
  await flow.device.update({ detected_motion: true, smoke_status: true, co_status: true });
  await flow.device.onShutdown();
  assert.equal(flow.device.accessory, accessory);
  assert.equal(flow.device.motionService, undefined);
  assert.equal(accessory.services.includes(motion), false);
  assert.equal(accessory.getService(hap.Service.MotionSensor), undefined);
  assert.deepEqual([flow.device.smokeService, flow.device.carbonMonoxideService, flow.device.batteryService], services);
  assert.equal(value(flow.device.smokeService, C.SmokeDetected), C.SmokeDetected.SMOKE_DETECTED);
  assert.equal(value(flow.device.carbonMonoxideService, C.CarbonMonoxideDetected), C.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL);
  assert.deepEqual(logs, []);
  assert.deepEqual(flow.history, []);
  assert.deepEqual(flow.warnings, []);
});

for (let [name, primary] of [
  ['thermostat', 'thermostatService'],
  ['heatlink', 'thermostatService'],
  ['lock', 'lockService'],
  ['protect', 'smokeService'],
  ['tempsensor', 'temperatureService'],
  ['weather', 'temperatureService'],
]) {
  test(name + ' service options retain primary and hidden flags across repeated setup', async (context) => {
    let flow = await setup(context, name);
    assert.equal(flow.device[primary].isPrimaryService, true);
    if (flow.device.batteryService !== undefined) {
      assert.equal(flow.device.batteryService.isHiddenService, true);
    }
    let service = flow.device[primary];
    await flow.device.onAdd();
    assert.equal(flow.device[primary], service);
    assert.equal(service.isPrimaryService, true);
    if (flow.device.batteryService !== undefined) {
      assert.equal(flow.device.batteryService.isHiddenService, true);
    }
  });
}

test('custom services use real HAP characteristic lists, distinct subtypes and restored cache instances', async (context) => {
  let flow = await setup(context, 'protect');
  let definition = {
    name: 'Custom Test Sensor',
    uuid: '12345678-1234-4123-8123-123456789ABC',
    required: [C.Name, C.StatusActive],
    optional: [C.StatusFault],
  };
  context.after(() => delete hap.Service.CustomTestSensor);
  let first = flow.device.addService(definition, 'First', 'first', { primary: true, hidden: true });
  let type = hap.Service.CustomTestSensor;
  assert.ok(first instanceof hap.Service);
  assert.equal(first.constructor, type);
  assert.equal(first.isPrimaryService, true);
  assert.equal(first.isHiddenService, true);
  assert.equal(
    Object.getOwnPropertySymbols(first).some((key) => first[key]?.history !== undefined),
    false,
    'flags alone must not request history linking',
  );
  assert.equal(first.getCharacteristic(C.Name).value, 'First');
  assert.equal(first.characteristics.filter((item) => item.UUID === C.Name.UUID).length, 1);
  assert.equal(first.testCharacteristic(C.StatusActive), true);
  assert.equal(first.testCharacteristic(C.StatusFault), false);
  assert.equal(
    first.optionalCharacteristics.some((item) => item.UUID === C.StatusFault.UUID),
    true,
  );
  assert.equal(flow.device.addService(definition, 'Ignored', 'first'), first);
  assert.equal(first.isPrimaryService, true);
  assert.equal(first.isHiddenService, true);
  let second = flow.device.addService(type, 'Second', 'second');
  assert.notEqual(second, first);

  // Restore before custom type registration, as happens when loading an accessory cache.
  delete hap.Service.CustomTestSensor;
  let cached = hap.Service.deserialize(hap.Service.serialize(first));
  assert.notEqual(cached.constructor, type);
  flow.device.accessory.removeService(first);
  flow.device.accessory.addService(cached);
  assert.equal(flow.device.addService(definition, 'Ignored', 'first'), cached);
  assert.equal(cached.isPrimaryService, true);
  assert.equal(cached.isHiddenService, true);
  assert.equal(flow.device.addService(definition, 'Ignored', 'first', { primary: false, hidden: false }), cached);
  assert.equal(cached.isPrimaryService, false);
  assert.equal(cached.isHiddenService, false);
  flow.device.addService(type, 'Ignored', 'first', { hidden: true });
  assert.equal(cached.isPrimaryService, false);
  assert.equal(cached.isHiddenService, true);
  assert.equal(flow.device.addService(type, 'Ignored', 'second'), second);
  assert.deepEqual(flow.warnings, []);
});

test('Protect exposes its replacement date as a read-only local string and preserves cached identity', async (context) => {
  let timestamp = Date.UTC(2030, 9, 25, 12) / 1000;
  let flow = await setup(context, 'protect', { replacement_date: timestamp });
  await flow.device.onUpdate(flow.device.deviceData);
  let type = C.ReplaceByDate;
  let service = flow.device.smokeService;
  let characteristic = service.getCharacteristic(type);
  assert.equal(type.UUID, CUSTOM_CHARACTERISTIC_UUID.REPLACE_BY_DATE);
  assert.equal(characteristic.displayName, 'Replace By Date');
  assert.equal(characteristic.getHandler, undefined);
  assert.equal(
    characteristic.value,
    new Date(timestamp * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }),
  );
  assert.equal(characteristic.props.format, hap.Formats.STRING);
  assert.deepEqual(characteristic.props.perms, [hap.Perms.PAIRED_READ, hap.Perms.NOTIFY]);
  assert.equal(characteristic.props.perms.includes(hap.Perms.PAIRED_WRITE), false);
  assert.equal(
    await characteristic.handleGetRequest(),
    new Date(timestamp * 1000).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }),
  );
  await flow.device.update({ replacement_date: timestamp + 86400 });
  assert.equal(
    await characteristic.handleGetRequest(),
    new Date((timestamp + 86400) * 1000).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }),
  );
  await flow.device.onAdd();
  assert.equal(flow.device.smokeService, service);
  assert.equal(service.getCharacteristic(type), characteristic);
  assert.equal(service.characteristics.filter((item) => item.UUID === type.UUID).length, 1);
  assert.equal(flow.device.carbonMonoxideService.testCharacteristic(type), false);
  let second = await setup(context, 'protect', { replacement_date: timestamp });
  assert.equal(C.ReplaceByDate, type);
  assert.equal(second.device.smokeService.getCharacteristic(type).UUID, characteristic.UUID);
  assert.deepEqual(flow.writes, []);
  assert.deepEqual(flow.warnings, []);
});

test('Protect stores Unavailable for unknown replacement dates and recovers on the next valid update', async (context) => {
  for (let replacement_date of [undefined, null, 0, -1, NaN, Infinity, 'invalid', 1e20]) {
    let flow = await setup(context, 'protect', { replacement_date });
    await flow.device.onUpdate(flow.device.deviceData);
    let characteristic = flow.device.smokeService.getCharacteristic(C.ReplaceByDate);
    assert.equal(await characteristic.handleGetRequest(), 'Unavailable');
    assert.equal(characteristic.statusCode, hap.HAPStatus.SUCCESS);
    await flow.device.update({ replacement_date: Date.UTC(2030, 9, 25) / 1000 });
    assert.equal(
      characteristic.value,
      new Date(Date.UTC(2030, 9, 25)).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }),
    );
    assert.equal(await characteristic.handleGetRequest(), characteristic.value);
    // Undefined partial updates preserve known fields; null explicitly clears the date.
    await flow.device.update({ replacement_date: replacement_date ?? null });
    assert.equal(await characteristic.handleGetRequest(), 'Unavailable');
    assert.equal(characteristic.statusCode, hap.HAPStatus.SUCCESS);
    assert.equal(flow.device.smokeService.getCharacteristic(C.ReplaceByDate), characteristic);
    assert.deepEqual(flow.writes, []);
    assert.deepEqual(flow.warnings, []);
  }
});

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
for (let [operation, type, key, initial, requested, setting] of [
  ['Celsius', C.TemperatureDisplayUnits, 'temperature_scale', 'F', C.TemperatureDisplayUnits.CELSIUS, 'C'],
  ['Fahrenheit', C.TemperatureDisplayUnits, 'temperature_scale', 'C', C.TemperatureDisplayUnits.FAHRENHEIT, 'F'],
  ['water temperature', C.TargetTemperature, 'hot_water_temperature', 55, 60, 60],
  ['boost on', C.On, 'hot_water_boost_active', false, true, { state: true, time: 1800 }],
  ['boost off', C.On, 'hot_water_boost_active', true, false, { state: false, time: 1800 }],
]) {
  for (let accepted of [false, true]) {
    test('Heat Link HAP waits for ' + operation + ' cloud outcome, accepted=' + accepted, async (context) => {
      let flow = await setup(context, 'heatlink', { [key]: initial });
      let info = context.mock.fn();
      flow.device.log = { info, warn() {}, debug() {} };
      // Exercise the accessory SET lifecycle while delaying the parent thermostat request.
      flow.device.set = HomeKitDevice.prototype.set;
      let pending = Promise.withResolvers();
      let started = Promise.withResolvers();
      HomeKitDevice.message(flow.device.uuid, HomeKitDevice.SET, async (values) => {
        flow.writes.push(values);
        started.resolve();
        await pending.promise;
      });
      let service = type === C.On ? flow.device.switchService : flow.device.thermostatService;
      let characteristic = service.getCharacteristic(type);
      let before = characteristic.value;
      let settled = false;
      let result = characteristic.handleSetRequest(requested).then(
        () => {
          settled = true;
        },
        (error) => {
          settled = true;
          return error;
        },
      );
      await started.promise;
      await nextTurn();
      let observed = { settled, value: characteristic.value, logs: info.mock.calls.length };
      // Unblock teardown before checking behaviour so a failing regression cannot hang cleanup.
      if (accepted === true) {
        pending.resolve();
      } else {
        pending.reject(new Error('Fixture cloud rejection'));
      }
      assert.equal(observed.settled, false, 'HAP must wait for the cloud response');
      assert.equal(observed.value, before);
      assert.equal(observed.logs, 0);
      assert.deepEqual(flow.writes, [{ uuid: 'DEVICE_PARENT', [key]: setting }]);

      if (accepted === true) {
        assert.equal(await result, undefined);
      } else {
        assert.equal(await result, hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        assert.equal(characteristic.statusCode, hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        assert.equal(characteristic.value, before);
        assert.equal(flow.device.deviceData[key], initial);
        assert.equal(info.mock.calls.length, 0);
        pending = Promise.withResolvers();
        pending.resolve();
        await characteristic.handleSetRequest(requested);
      }

      assert.equal(characteristic.value, requested);
      assert.equal(characteristic.statusCode, hap.HAPStatus.SUCCESS);
      assert.equal(info.mock.calls.length, 1);
      // Observe supplies the normalised boost state; its command carries state and duration together.
      await flow.device.update({ [key]: type === C.On ? requested : setting });
      assert.equal(await characteristic.handleGetRequest(), requested);
      assert.equal(service, type === C.On ? flow.device.switchService : flow.device.thermostatService);
    });
  }
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

for (let operation of ['on', 'off', 'brightness']) {
  for (let accepted of [false, true]) {
    test('floodlight HAP waits for ' + operation + ' cloud outcome, accepted=' + accepted, async (context) => {
      let flow = await setup(context, 'floodlight', { has_light: true, light_enabled: operation === 'off', light_brightness: 50 });
      let info = context.mock.fn();
      flow.device.log = { info, warn() {}, debug() {} };
      // Use the real SET commit boundary with only cloud acceptance held pending.
      flow.device.set = HomeKitDevice.prototype.set;
      let pending = Promise.withResolvers();
      let started = Promise.withResolvers();
      HomeKitDevice.message(flow.device.uuid, HomeKitDevice.SET, async (values) => {
        flow.writes.push(values);
        started.resolve();
        await pending.promise;
      });
      let brightness = operation === 'brightness';
      let key = brightness === true ? 'light_brightness' : 'light_enabled';
      let characteristic = flow.device.lightService.getCharacteristic(brightness === true ? C.Brightness : C.On);
      let before = flow.device.deviceData[key];
      characteristic.updateValue(before);
      let requested = brightness === true ? 70 : operation === 'on';
      let settled = false;
      let result = characteristic.handleSetRequest(requested).then(
        () => {
          settled = true;
        },
        (error) => {
          settled = true;
          return error;
        },
      );
      await started.promise;
      await nextTurn();
      let observed = { settled, value: characteristic.value, logs: info.mock.calls.length };
      // Release the pending request even if a pre-acceptance assertion fails.
      if (accepted === true) {
        pending.resolve();
      } else {
        pending.reject(new Error('Fixture cloud rejection'));
      }
      assert.equal(observed.settled, false, 'HAP must wait for the cloud response');
      assert.equal(observed.value, before);
      assert.equal(observed.logs, 0);
      assert.deepEqual(flow.writes, [{ uuid: 'DEVICE_TEST', [key]: requested }]);

      if (accepted === true) {
        assert.equal(await result, undefined);
      } else {
        assert.equal(await result, hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        assert.equal(characteristic.statusCode, hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        assert.equal(characteristic.value, before);
        assert.equal(flow.device.deviceData[key], before);
        assert.equal(info.mock.calls.length, 0);
        pending = Promise.withResolvers();
        pending.resolve();
        await characteristic.handleSetRequest(requested);
      }

      assert.equal(characteristic.value, requested);
      assert.equal(flow.device.deviceData[key], requested);
      assert.equal(characteristic.statusCode, hap.HAPStatus.SUCCESS);
      assert.equal(info.mock.calls.length, 1);
      // Repeating an accepted setting must not send or log another command.
      let writes = flow.writes.length;
      await characteristic.handleSetRequest(requested);
      assert.equal(flow.writes.length, writes);
      assert.equal(info.mock.calls.length, 1);
    });
  }
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
  for (let [humidifier, dehumidifier, expected] of [
    [true, false, [1]],
    [true, true, [0, 1, 2]],
    [false, true, [2]],
    [true, true, [0, 1, 2]],
  ]) {
    await flow.device.update({ has_humidifier: humidifier, has_dehumidifier: dehumidifier, current_humidity: 55 });
    assert.equal(flow.device.humidifierDehumidifierService, service);
    let target = service.getCharacteristic(C.TargetHumidifierDehumidifierState);
    assert.deepEqual(target.props.validValues, expected);
    assert.equal(expected.includes(target.value), true);
    assert.equal(expected.includes(await target.handleGetRequest()), true);
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
  let flow = await setup(context, 'weather', {
    elevation: 50,
    forecast: 'Fine',
    station: 'Sydney',
    condition: 'Clear',
    wind_direction: 'NE',
    wind_speed: 0,
    sunrise: 0,
    sunset: 0,
  });
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
  assert.equal(flow.device.airPressureService, undefined);
  assert.equal(flow.device.accessory.getService(hap.Service.EveAirPressureSensor), undefined);
  await flow.device.update({ current_temperature: 20 });
  assert.equal(value(service, C.Condition), 'Clear');
  assert.equal(flow.device.temperatureService, service);
  // A home can differ from the host zone; Sydney changes offset seasonally, Phoenix does not.
  for (let [date, timezone, offset] of [
    ['2026-01-15T00:00:00Z', 'Australia/Sydney', 11],
    ['2026-07-15T00:00:00Z', 'Australia/Sydney', 10],
    ['2026-01-15T00:00:00Z', 'America/Phoenix', -7],
    ['2026-07-15T00:00:00Z', 'America/Phoenix', -7],
  ]) {
    let sunrise = Date.parse(date) / 1000;
    let sunset = sunrise + 12 * 3600;
    await flow.device.update({ timezone, sunrise, sunset });
    for (let [name, timestamp] of [
      ['SunriseTime', sunrise],
      ['SunsetTime', sunset],
    ]) {
      let expected = new Date((timestamp + offset * 3600) * 1000).toLocaleTimeString(undefined, { timeZone: 'UTC' });
      assert.equal(value(service, C[name]), expected);
    }
  }
  // Refresh the same timestamps on zone-only changes, including clearing an invalid/missing mapped zone.
  for (let timezone of ['Australia/Sydney', 'America/Phoenix', null]) {
    await flow.device.update({ timezone });
    for (let [name, field] of [
      ['SunriseTime', 'sunrise'],
      ['SunsetTime', 'sunset'],
    ]) {
      assert.equal(
        value(service, C[name]),
        new Date(flow.device.deviceData[field] * 1000).toLocaleTimeString(undefined, { timeZone: timezone ?? undefined }),
      );
    }
    assert.equal(flow.device.temperatureService, service);
  }
  assert.deepEqual(flow.warnings, []);
  // Restored optional characteristics and the old pressure service are removed
  // during setup when the new source supplies no corresponding readings.
  flow.device.accessory.addService(hap.Service.EveAirPressureSensor, '', 1);
  for (let field of ['forecast', 'station', 'condition', 'wind_direction', 'wind_speed', 'sunrise', 'sunset']) {
    flow.device.deviceData[field] = null;
  }
  flow.device.onAdd();
  assert.equal(flow.device.temperatureService, service);
  assert.equal(flow.device.accessory.getService(hap.Service.EveAirPressureSensor), undefined);
  for (let name of names.filter((name) => name !== 'EveElevation')) {
    assert.equal(service.testCharacteristic(C[name]), false);
  }

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

for (let [operation, serviceName, type, requested, hvacMode = 'heat'] of [
  ['child lock', 'thermostatService', C.LockPhysicalControls, C.LockPhysicalControls.CONTROL_LOCK_ENABLED],
  ['display units', 'thermostatService', C.TemperatureDisplayUnits, C.TemperatureDisplayUnits.FAHRENHEIT],
  ['HVAC mode', 'thermostatService', C.TargetHeatingCoolingState, C.TargetHeatingCoolingState.COOL],
  ['temperature', 'thermostatService', C.TargetTemperature, 23],
  ['heating threshold', 'thermostatService', C.HeatingThresholdTemperature, 21, 'range'],
  ['cooling threshold', 'thermostatService', C.CoolingThresholdTemperature, 25, 'range'],
  ['fan power', 'fanService', C.Active, C.Active.ACTIVE],
  ['fan speed', 'fanService', C.RotationSpeed, 100],
  ['humidity power', 'humidifierDehumidifierService', C.Active, C.Active.ACTIVE],
  ['humidity mode', 'humidifierDehumidifierService', C.TargetHumidifierDehumidifierState, C.TargetHumidifierDehumidifierState.HUMIDIFIER],
  ['humidifier threshold', 'humidifierDehumidifierService', C.RelativeHumidityHumidifierThreshold, 50],
  ['dehumidifier threshold', 'humidifierDehumidifierService', C.RelativeHumidityDehumidifierThreshold, 65],
  ['Eco', 'thermostatService', C.EcoMode, true],
]) {
  for (let accepted of [false, true]) {
    test('thermostat HAP waits for ' + operation + ', accepted=' + accepted, async (context) => {
      let flow = await setup(context, 'thermostat', { has_fan: true, has_humidifier: true, has_dehumidifier: true, hvac_mode: hvacMode });
      await flow.device.onUpdate(flow.device.deviceData);
      let service = flow.device[serviceName];
      let characteristic = service.getCharacteristic(type ?? C.EcoMode);
      let before = service.characteristics.map((item) => [item.UUID, item.value]);
      let info = context.mock.fn();
      flow.device.log = { info, warn() {}, debug() {} };
      flow.device.set = HomeKitDevice.prototype.set;
      let pending = Promise.withResolvers();
      let started = Promise.withResolvers();
      HomeKitDevice.message(flow.device.uuid, HomeKitDevice.SET, async (values) => {
        flow.writes.push(values);
        started.resolve();
        await pending.promise;
      });
      let settled = false;
      let result = characteristic.handleSetRequest(requested).then(
        () => {
          settled = true;
        },
        (error) => {
          settled = true;
          return error;
        },
      );
      await started.promise;
      await nextTurn();
      let observed = { settled, values: service.characteristics.map((item) => [item.UUID, item.value]), logs: info.mock.calls.length };
      if (accepted === true) {
        pending.resolve();
      } else {
        pending.reject(new Error('Fixture cloud rejection'));
      }
      assert.equal(observed.settled, false);
      assert.deepEqual(observed.values, before, 'No characteristic should change before cloud acceptance');
      assert.equal(observed.logs, 0);
      assert.equal(flow.writes[0].uuid, 'DEVICE_TEST');
      if (accepted === true) {
        assert.equal(await result, undefined);
      } else {
        assert.equal(await result, hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        assert.deepEqual(
          service.characteristics.map((item) => [item.UUID, item.value]),
          before,
        );
        assert.equal(info.mock.calls.length, 0);
        pending = Promise.withResolvers();
        pending.resolve();
        await characteristic.handleSetRequest(requested);
      }
      assert.equal(characteristic.value, requested);
      assert.equal(characteristic.statusCode, hap.HAPStatus.SUCCESS);
      assert.equal(info.mock.calls.length, 1);
      assert.equal(flow.device[serviceName], service);
    });
  }
}

test('thermostat humidity does not publish combined success when the second equipment request fails', async (context) => {
  let flow = await setup(context, 'thermostat', { has_humidifier: true, has_dehumidifier: true });
  await flow.device.onUpdate(flow.device.deviceData);
  let service = flow.device.humidifierDehumidifierService;
  let before = service.characteristics.map((item) => [item.UUID, item.value]);
  let info = context.mock.fn();
  flow.device.log = { info, warn() {}, debug() {} };
  flow.device.set = HomeKitDevice.prototype.set;
  let pending = Promise.withResolvers();
  let started = Promise.withResolvers();
  HomeKitDevice.message(flow.device.uuid, HomeKitDevice.SET, async (values) => {
    flow.writes.push(values);
    if (flow.writes.length === 2) {
      started.resolve();
      await pending.promise;
    }
  });
  let request = service.getCharacteristic(C.Active).handleSetRequest(C.Active.ACTIVE);
  let rejected = assert.rejects(request, (error) => error === hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  await started.promise;
  let observed = service.characteristics.map((item) => [item.UUID, item.value]);
  pending.reject(new Error('Fixture second equipment failure'));
  await rejected;
  assert.equal(flow.writes.length, 2);
  assert.deepEqual(observed, before);
  assert.deepEqual(
    service.characteristics.map((item) => [item.UUID, item.value]),
    before,
  );
  assert.equal(info.mock.calls.length, 0);
});

test('thermostat Eve vacation commands return their SET failure to the caller', async (context) => {
  let previous = HomeKitDevice.EVEHOME;
  HomeKitDevice.EVEHOME = { GET: 'fixture-eve-get', SET: 'fixture-eve-set' };
  context.after(() => {
    HomeKitDevice.EVEHOME = previous;
  });
  let flow = await setup(context, 'thermostat');
  let failure = new Error('Fixture vacation failure');
  flow.device.set = async () => {
    throw failure;
  };
  await assert.rejects(flow.device.onMessage(HomeKitDevice.EVEHOME.SET, { vacation: { status: true } }), (error) => error === failure);
});

for (let operation of ['lock', 'unlock', 'auto-relock duration']) {
  for (let accepted of [false, true]) {
    test('lock HAP waits for ' + operation + ' cloud outcome, accepted=' + accepted, async (context) => {
      let locked = operation === 'unlock';
      let flow = await setup(context, 'lock', { bolt_state: locked === true ? 'locked' : 'unlocked' });
      await flow.device.onUpdate(flow.device.deviceData);
      let info = context.mock.fn();
      flow.device.log = { info, warn() {}, debug() {} };
      // Retain real SET dispatch and commit handling; delay only the cloud boundary.
      flow.device.set = HomeKitDevice.prototype.set;
      let pending = Promise.withResolvers();
      let started = Promise.withResolvers();
      HomeKitDevice.message(flow.device.uuid, HomeKitDevice.SET, async (values) => {
        flow.writes.push(values);
        started.resolve();
        await pending.promise;
      });
      let duration = operation === 'auto-relock duration';
      let characteristic = flow.device.lockService.getCharacteristic(
        duration === true ? C.LockManagementAutoSecurityTimeout : C.LockTargetState,
      );
      let before = characteristic.value;
      let requested = duration === true ? 60 : locked === true ? C.LockTargetState.UNSECURED : C.LockTargetState.SECURED;
      let settled = false;
      let result = characteristic.handleSetRequest(requested).then(
        () => {
          settled = true;
        },
        (error) => {
          settled = true;
          return error;
        },
      );
      await started.promise;
      await nextTurn();
      let observed = { settled, value: characteristic.value, logs: info.mock.calls.length };
      // Settle the cloud boundary before assertions so failed tests can still tear down.
      if (accepted === true) {
        pending.resolve();
      } else {
        pending.reject(new Error('Fixture cloud rejection'));
      }
      assert.equal(observed.settled, false, 'HAP must wait for the cloud response');
      assert.equal(observed.value, before);
      assert.equal(observed.logs, 0);
      assert.deepEqual(flow.writes, [
        { uuid: 'DEVICE_TEST', ...(duration === true ? { auto_relock_duration: 60 } : { bolt_lock: locked === false }) },
      ]);

      if (accepted === true) {
        assert.equal(await result, undefined);
      } else {
        assert.equal(await result, hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        assert.equal(characteristic.statusCode, hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        assert.equal(characteristic.value, before);
        assert.equal(info.mock.calls.length, 0);
        assert.equal(flow.device.deviceData.auto_relock_duration, 0);
        // A rejected write must not suppress a subsequent successful retry.
        pending = Promise.withResolvers();
        pending.resolve();
        await characteristic.handleSetRequest(requested);
      }

      assert.equal(characteristic.value, requested);
      assert.equal(characteristic.statusCode, hap.HAPStatus.SUCCESS);
      assert.equal(info.mock.calls.length, 1);
      if (duration === true) {
        assert.equal(flow.device.deviceData.auto_relock_duration, 60);
      } else {
        assert.deepEqual(info.mock.calls[0].arguments, ['Set lock on "%s" to "%s"', 'lock', locked === true ? 'Unlocked' : 'Locked']);
        assert.equal(
          flow.device.lockService.getCharacteristic(C.LockCurrentState).value,
          locked === true ? C.LockCurrentState.SECURED : C.LockCurrentState.UNSECURED,
        );
        await flow.device.update({ bolt_state: locked === true ? 'unlocked' : 'locked' });
        assert.equal(flow.device.lockService.getCharacteristic(C.LockCurrentState).value, requested);
      }
    });
  }
}

test('lock optional characteristics are set up inline and preserve false and zero', async (context) => {
  let flow = await setup(context, 'lock', { tampered: null, auto_relock_duration: null, max_auto_relock_duration: null });
  let service = flow.device.lockService;
  let identity = [service.UUID, service.subtype];
  assert.equal(service.testCharacteristic(C.StatusTampered), false);
  assert.equal(service.testCharacteristic(C.LockManagementAutoSecurityTimeout), false);
  await flow.device.update({ battery_level: 79 });
  assert.equal(service.testCharacteristic(C.StatusTampered), false);
  assert.equal(service.testCharacteristic(C.LockManagementAutoSecurityTimeout), false);

  await flow.device.update({ tampered: false, auto_relock_duration: 0, max_auto_relock_duration: 300 });
  assert.equal(service.testCharacteristic(C.StatusTampered), false);
  assert.equal(service.testCharacteristic(C.LockManagementAutoSecurityTimeout), false);
  await flow.device.onAdd();
  let tamper = service.getCharacteristic(C.StatusTampered);
  let timeout = service.getCharacteristic(C.LockManagementAutoSecurityTimeout);
  assert.equal(await tamper.handleGetRequest(), C.StatusTampered.NOT_TAMPERED);
  assert.equal(await timeout.handleGetRequest(), 0);
  assert.equal(timeout.props.maxValue, 300);
  await flow.device.update({ tampered: true, auto_relock_duration: 60 });
  assert.equal(service.getCharacteristic(C.StatusTampered), tamper);
  assert.equal(service.getCharacteristic(C.LockManagementAutoSecurityTimeout), timeout);
  assert.equal(tamper.value, C.StatusTampered.TAMPERED);
  assert.equal(timeout.value, 60);

  await flow.device.update({ tampered: null, auto_relock_duration: null, max_auto_relock_duration: null });
  assert.equal(service.getCharacteristic(C.StatusTampered), tamper);
  assert.equal(service.getCharacteristic(C.LockManagementAutoSecurityTimeout), timeout);
  assert.equal(await tamper.handleGetRequest(), C.StatusTampered.TAMPERED);
  assert.equal(await timeout.handleGetRequest(), 60);
  assert.deepEqual([service.UUID, service.subtype], identity);
  assert.equal(service.testCharacteristic(C.LockCurrentState), true);
  assert.equal(service.testCharacteristic(C.LockTargetState), true);
  assert.deepEqual(flow.writes, []);
});

test('cached locks remove stale optional controls without changing accessory or service identity', async (context) => {
  let flow = await setup(context, 'lock');
  let uuid = flow.device.accessory.UUID;
  let identities = flow.device.accessory.services.map((service) => [service.UUID, service.subtype]);
  flow.device.accessory = hap.Accessory.deserialize(hap.Accessory.serialize(flow.device.accessory));
  let cached = flow.device.accessory.getService(hap.Service.LockMechanism);
  assert.equal(cached.testCharacteristic(C.StatusTampered), true);
  assert.equal(cached.testCharacteristic(C.LockManagementAutoSecurityTimeout), true);
  flow.device.deviceData.tampered = null;
  flow.device.deviceData.auto_relock_duration = null;
  flow.device.deviceData.max_auto_relock_duration = null;
  await flow.device.onAdd();
  await flow.device.onUpdate(flow.device.deviceData);
  assert.equal(flow.device.lockService, cached);
  assert.equal(cached.testCharacteristic(C.StatusTampered), false);
  assert.equal(cached.testCharacteristic(C.LockManagementAutoSecurityTimeout), false);
  assert.equal(flow.device.accessory.UUID, uuid);
  assert.deepEqual(
    flow.device.accessory.services.map((service) => [service.UUID, service.subtype]),
    identities,
  );
  await flow.device.update({ auto_relock_duration: 0, max_auto_relock_duration: 300, tampered: false });
  assert.equal(cached.testCharacteristic(C.LockManagementAutoSecurityTimeout), false);
  await flow.device.onAdd();
  let timeout = cached.getCharacteristic(C.LockManagementAutoSecurityTimeout);
  await timeout.handleSetRequest(60);
  assert.deepEqual(flow.writes, [{ uuid: 'DEVICE_TEST', auto_relock_duration: 60 }]);
});

test('mapped HomeGraph lock source updates retain optional characteristics and route basic lock writes', async (context) => {
  let { processRawData } = await importSource(new URL('../src/plugins/lock.js', import.meta.url));
  let raw = {
    [getResourceKey('account', 'HomeGraph', 'home', 'STRUCTURE')]: {
      source: DATA_SOURCE.HOMEGRAPH,
      connection: 'account',
      value: { home: { uuid: 'home' } },
    },
    [getResourceKey('account', 'HomeGraph', 'lock')]: {
      source: DATA_SOURCE.HOMEGRAPH,
      connection: 'account',
      value: {
        structureId: 'home',
        technicalInformation: { serialNumber: 'YALE_NATIVE_FIXTURE' },
        googleHome: {
          id: { googleUuid: 'lock', thirdPartyId: { idType: 'nest-home-assistant-prod' } },
          type: 'action.devices.types.LOCK',
          displayName: 'Lock',
          hardware: { softwareVersion: '1.2.3' },
        },
        'deviceStatus.online': { boolean: true },
        'lockUnlock.isLocked': { boolean: false },
        'charging.capacityRemainingPercentage': { number: 80 },
      },
    },
  };
  let mapped = processRawData(undefined, raw, { options: {} }).YALE_NATIVE_FIXTURE;
  assert.equal(mapped.full, true);
  let flow = await setup(context, 'lock', { serialNumber: 'YALE_NATIVE_FIXTURE' });
  let uuid = flow.device.accessory.UUID;
  let service = flow.device.lockService;
  await flow.device.update(mapped.data);
  assert.equal(service.testCharacteristic(C.StatusTampered), true);
  assert.equal(service.testCharacteristic(C.LockManagementAutoSecurityTimeout), true);
  assert.equal(flow.device.deviceData.auto_relock_duration, null);
  await service.getCharacteristic(C.LockTargetState).handleSetRequest(C.LockTargetState.SECURED);
  assert.deepEqual(flow.writes, [{ uuid: getResourceKey('account', 'HomeGraph', 'lock'), bolt_lock: true }]);
  await flow.device.update({
    nest_google_device_uuid: 'DEVICE_PROTO',
    tampered: false,
    auto_relock_duration: 0,
    max_auto_relock_duration: 300,
  });
  assert.equal(service.testCharacteristic(C.StatusTampered), true);
  await flow.device.onAdd();
  assert.equal(service.testCharacteristic(C.StatusTampered), true);
  await service.getCharacteristic(C.LockManagementAutoSecurityTimeout).handleSetRequest(60);
  assert.deepEqual(flow.writes.at(-1), { uuid: 'DEVICE_PROTO', auto_relock_duration: 60 });
  assert.equal(flow.device.lockService, service);
  assert.equal(flow.device.accessory.UUID, uuid);
});

for (let fields of [{ auto_relock_duration: undefined }, { max_auto_relock_duration: undefined }, { auto_relock_duration: '0' }]) {
  test('lock omits auto-relock control for unavailable fields: ' + JSON.stringify(fields), async (context) => {
    let flow = await setup(context, 'lock', fields);
    assert.equal(flow.device.lockService.testCharacteristic(C.LockManagementAutoSecurityTimeout), false);
  });
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

test('thermostat Eco control retains its handlers and service across source mode changes', async (context) => {
  let flow = await setup(context, 'thermostat', { eco_mode: 'off' });
  let service = flow.device.thermostatService;
  let control = service.getCharacteristic(C.EcoMode);
  assert.equal(await control.handleGetRequest(), false);
  await flow.device.update({ ...flow.device.deviceData, eco_mode: 'auto' });
  assert.equal(flow.device.thermostatService, service);
  assert.equal(service.testCharacteristic(C.EcoMode), true);
  assert.equal(service.getCharacteristic(C.EcoMode).value, true);
  assert.equal(service.getCharacteristic(C.EcoMode), control);
  assert.equal(await control.handleGetRequest(), true);
  await control.handleSetRequest(false);
  assert.deepEqual(flow.writes, [{ uuid: 'DEVICE_TEST', eco_mode: 'off' }]);
  await flow.device.update({ eco_mode: 'off' });
  assert.equal(flow.device.thermostatService, service);
  assert.equal(service.getCharacteristic(C.EcoMode), control);
  assert.equal(await control.handleGetRequest(), false);
  assert.deepEqual(flow.warnings, []);
});

test('Protect cleans cached battery percentage and false low warning without recreating services', async (context) => {
  let flow = await setup(context, 'protect', {
    wired_or_battery: false,
    battery_level: undefined,
    battery_low: false,
  });
  let service = flow.device.batteryService;
  service.updateCharacteristic(C.BatteryLevel, 0);
  service.updateCharacteristic(C.StatusLowBattery, C.StatusLowBattery.BATTERY_LEVEL_LOW);
  let warning = service.getCharacteristic(C.StatusLowBattery);
  let serviceCount = flow.device.accessory.services.length;
  // Re-run setup against the existing services, as restored Homebridge accessories do.
  await flow.device.onAdd();
  assert.equal(flow.device.batteryService, service);
  assert.equal(flow.device.accessory.services.length, serviceCount);
  assert.equal(service.testCharacteristic(C.BatteryLevel), false);
  await flow.device.onUpdate(flow.device.deviceData);
  assert.equal(service.getCharacteristic(C.StatusLowBattery), warning);
  assert.equal(warning.value, C.StatusLowBattery.BATTERY_LEVEL_NORMAL);
  assert.deepEqual(flow.warnings, []);
});

test('Protect reconciles battery percentage availability and independent health during live updates', async (context) => {
  let flow = await setup(context, 'protect', { battery_level: 26, battery_low: false });
  let service = flow.device.batteryService;
  await flow.device.onUpdate(flow.device.deviceData);
  assert.equal(value(service, C.BatteryLevel), 26);
  await flow.device.update({ battery_level: null, battery_low: true });
  assert.equal(service.testCharacteristic(C.BatteryLevel), false);
  assert.equal(value(service, C.StatusLowBattery), C.StatusLowBattery.BATTERY_LEVEL_LOW);
  await flow.device.update({ battery_level: 5, battery_low: false });
  assert.equal(value(service, C.BatteryLevel), 5);
  assert.equal(value(service, C.StatusLowBattery), C.StatusLowBattery.BATTERY_LEVEL_NORMAL);
  assert.equal(flow.device.batteryService, service);
  assert.deepEqual(flow.warnings, []);
});

for (let [level, expected] of [
  [5, 1],
  [10, 1],
  [80, 0],
  [undefined, 0],
]) {
  test('Protect retains percentage fallback when explicit battery health is unavailable: ' + level, async (context) => {
    let flow = await setup(context, 'protect', { battery_level: level });
    await flow.device.onUpdate(flow.device.deviceData);
    assert.equal(value(flow.device.batteryService, C.StatusLowBattery), expected);
    assert.equal(flow.device.batteryService.testCharacteristic(C.BatteryLevel), level !== undefined);
    assert.deepEqual(flow.warnings, []);
  });
}

// Keep enum zero valid when both equipment types are available, including first creation.
for (let [humidifier, dehumidifier, expected] of [
  [true, false, [1]],
  [false, true, [2]],
  [true, true, [0, 1, 2]],
]) {
  test('initial humidity mode constraints: humidifier=' + humidifier + ', dehumidifier=' + dehumidifier, async (context) => {
    let flow = await setup(context, 'thermostat', { has_humidifier: humidifier, has_dehumidifier: dehumidifier });
    let target = flow.device.humidifierDehumidifierService.getCharacteristic(C.TargetHumidifierDehumidifierState);
    assert.deepEqual(target.props.validValues, expected);
    assert.equal(expected.includes(target.value), true);
    assert.equal(expected.includes(await target.handleGetRequest()), true);
  });
}

for (let [previous, next, control, target] of [
  ['cooling', 'heating', 'heat', 20],
  ['heating', 'cooling', 'cool', 26],
]) {
  test('external ' + control + ' waits for off and completes before the thermostat update resolves', async (context) => {
    let directory = await mkdtemp(path.join(tmpdir(), 'nest-external-order-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    let file = path.join(directory, 'control.mjs');
    await writeFile(
      file,
      'export const state = { calls: [], stopping: Promise.withResolvers(), starting: Promise.withResolvers() };' +
        'export default () => ({ off: () => { state.calls.push("off");' +
        'if (state.failure !== undefined) throw state.failure; return state.stopping.promise; },' +
        'heat: value => { state.calls.push(["heat", value]); return state.starting.promise; },' +
        'cool: value => { state.calls.push(["cool", value]); return state.starting.promise; } });',
    );
    let { state } = await import(pathToFileURL(file).href);
    let flow = await setup(context, 'thermostat', {
      external: '"' + file + '"',
      hvac_state: previous,
      target_temperature_low: 20,
      target_temperature_high: 26,
    });
    let finished = false;
    let update = flow.device.update({ hvac_state: next }).then(() => {
      finished = true;
    });
    try {
      await nextTurn();
      assert.deepEqual(state.calls, ['off']);
      assert.equal(finished, false);
      state.stopping.resolve();
      await nextTurn();
      assert.deepEqual(state.calls, ['off', [control, target]]);
      assert.equal(finished, false);
    } finally {
      state.stopping.resolve();
      state.starting.resolve();
      await update;
    }
    assert.equal(finished, true);
    let failure = new Error('External off failed');
    state.failure = failure;
    // A failed stop must never start its replacement.
    await assert.rejects(flow.device.update({ hvac_state: previous }), (error) => error === failure);
    assert.deepEqual(state.calls, ['off', [control, target], 'off']);
  });
}

for (let eco of ['manual', 'auto']) {
  for (let [mode, requested] of [
    ['ecoheat', C.TargetHeatingCoolingState.HEAT],
    ['ecocool', C.TargetHeatingCoolingState.COOL],
    ['ecorange', C.TargetHeatingCoolingState.AUTO],
    ['off', C.TargetHeatingCoolingState.OFF],
  ]) {
    test('same displayed mode requests Eco Off and normal mode: ' + eco + '/' + mode, async (context) => {
      let flow = await setup(context, 'thermostat', { eco_mode: eco, hvac_mode: mode });
      await flow.device.update({}, { force: true });
      flow.device.set = HomeKitDevice.prototype.set;
      HomeKitDevice.message(flow.device.uuid, HomeKitDevice.SET, async (values) => flow.writes.push(values));
      let control = flow.device.thermostatService.getCharacteristic(C.TargetHeatingCoolingState);
      assert.equal(await control.handleGetRequest(), requested);
      await control.handleSetRequest(requested);
      assert.deepEqual(flow.writes, [{ uuid: 'DEVICE_TEST', eco_mode: 'off', hvac_mode: ['off', 'heat', 'cool', 'range'][requested] }]);
      assert.equal(flow.device.deviceData.eco_mode, 'off');
      await control.handleSetRequest(requested);
      assert.equal(flow.writes.length, 1, 'Normal-mode no-op behavior remains intact once Eco is off');
    });
  }
}

for (let [mode, type, key, normal] of [
  ['ecoheat', C.TargetTemperature, 'target_temperature_low', 'heat'],
  ['ecocool', C.TargetTemperature, 'target_temperature_high', 'cool'],
  ['ecorange', C.HeatingThresholdTemperature, 'target_temperature_low', 'range'],
  ['ecorange', C.CoolingThresholdTemperature, 'target_temperature_high', 'range'],
]) {
  test('Eco temperature request includes exit, mode and normal target: ' + key + '/' + normal, async (context) => {
    let flow = await setup(context, 'thermostat', { eco_mode: 'manual', hvac_mode: mode });
    await flow.device.update({}, { force: true });
    flow.device.set = HomeKitDevice.prototype.set;
    HomeKitDevice.message(flow.device.uuid, HomeKitDevice.SET, async (values) => flow.writes.push(values));
    let characteristic = flow.device.thermostatService.getCharacteristic(type);
    await characteristic.handleSetRequest(23);
    assert.deepEqual(flow.writes, [{ uuid: 'DEVICE_TEST', eco_mode: 'off', hvac_mode: normal, [key]: 23 }]);
    assert.equal(flow.device.deviceData.eco_mode, 'off');
    assert.equal(characteristic.value, 23);
  });
}

for (let [mode, type, requested, expected] of [
  ['off', C.TargetTemperature, 23, hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE],
  ['ecorange', C.TargetTemperature, 23, hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE],
  ['ecoheat', C.CoolingThresholdTemperature, 23, hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE],
  ['ecoheat', C.TargetTemperature, 4.5, hap.HAPStatus.INVALID_VALUE_IN_REQUEST],
  ['ecocool', C.TargetTemperature, 40, hap.HAPStatus.INVALID_VALUE_IN_REQUEST],
]) {
  test('invalid or ambiguous Eco target leaves settings untouched: ' + mode + '/' + type.name + '/' + requested, async (context) => {
    let flow = await setup(context, 'thermostat', { eco_mode: 'manual', hvac_mode: mode });
    await flow.device.update({}, { force: true });
    let before = structuredClone(flow.device.deviceData);
    let control = flow.device.thermostatService.getCharacteristic(type);
    let previous = await control.handleGetRequest();
    await assert.rejects(control.handleSetRequest(requested), (error) => error === expected);
    assert.equal(control.statusCode, expected);
    assert.equal(control.value, previous);
    assert.deepEqual(flow.writes, []);
    assert.deepEqual(flow.device.deviceData, before);
    assert.equal(await control.handleGetRequest(), previous);
    assert.equal(control.statusCode, hap.HAPStatus.SUCCESS);
  });
}

for (let [codes, expected] of [
  [['ERR_ECO_TEMPERATURE_READ_ONLY'], hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE],
  [['ERR_THERMOSTAT_MODE_CONFLICT'], hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE],
  [['ECONNRESET'], hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE],
  [['ERR_THERMOSTAT_MODE_CONFLICT', 'ECONNRESET'], hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE],
]) {
  test('thermostat HAP write rejects and recovers after ' + codes.join('/'), async (context) => {
    let flow = await setup(context, 'thermostat', { hvac_mode: 'cool' });
    await flow.device.update({}, { force: true });
    flow.device.set = HomeKitDevice.prototype.set;
    let failure = new AggregateError(codes.map((code) => Object.assign(new Error('Fixture rejection'), { code })));
    HomeKitDevice.message(flow.device.uuid, HomeKitDevice.SET, async (values) => {
      flow.writes.push(values);
      if (failure !== undefined) {
        throw failure;
      }
    });
    let control = flow.device.thermostatService.getCharacteristic(C.TargetTemperature);
    let previous = await control.handleGetRequest();
    let before = structuredClone(flow.device.deviceData);
    await assert.rejects(control.handleSetRequest(23), (error) => error === expected);
    assert.equal(control.statusCode, expected);
    assert.equal(control.value, previous);
    assert.deepEqual(flow.device.deviceData, before);
    assert.equal(await control.handleGetRequest(), previous);
    assert.equal(control.statusCode, hap.HAPStatus.SUCCESS);
    failure = undefined;
    await control.handleSetRequest(23);
    assert.equal(control.value, 23);
    assert.equal(control.statusCode, hap.HAPStatus.SUCCESS);
    assert.equal(flow.device.deviceData.target_temperature_high, 23);
    assert.equal(flow.writes.length, 2);
  });
}

test('mapped HomeGraph temperature sensors reuse cached HomeKit services and keep selection writable', async (context) => {
  let { processRawData } = await importSource(new URL('../src/plugins/tempsensor.js', import.meta.url));
  let raw = {
    [getResourceKey('account', 'HomeGraph', 'sensor')]: {
      connection: 'account',
      source: DATA_SOURCE.HOMEGRAPH,
      value: {
        googleHome: {
          id: { googleUuid: 'sensor', thirdPartyId: { idType: 'nest-home-assistant-prod' } },
          type: 'action.devices.types.SENSOR',
          displayName: 'Sensor (Office)',
          hardware: { model: 'Nest Temperature Sensor' },
        },
        structureId: 'home',
        technicalInformation: { serialNumber: '22AA_NATIVE_FIXTURE' },
        'temperatureSetting.ambientAirTemperatureC': { number: 21 },
        'charging.descriptiveCapacityRemaining': { text: 'high' },
        'deviceStatus.online': { boolean: true },
      },
    },
    [getResourceKey('account', 'HomeGraph', 'parent')]: {
      connection: 'account',
      source: DATA_SOURCE.HOMEGRAPH,
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
  let mapped = processRawData(undefined, raw, { options: {} })['22AA_NATIVE_FIXTURE'];
  assert.equal(mapped.full, true);
  let flow = await setup(context, 'tempsensor', mapped.data);
  await flow.device.onUpdate(flow.device.deviceData);
  let identities = flow.device.accessory.services.map((service) => [service.UUID, service.subtype]);
  let uuid = flow.device.accessory.UUID;
  flow.device.accessory = hap.Accessory.deserialize(hap.Accessory.serialize(flow.device.accessory));
  let cached = flow.device.accessory.getService(hap.Service.TemperatureSensor);
  let cachedBattery = flow.device.accessory.getService(hap.Service.Battery);
  await flow.device.onAdd();
  assert.equal(flow.device.temperatureService, cached);
  assert.equal(flow.device.batteryService, cachedBattery);
  assert.equal(flow.device.accessory.UUID, uuid);
  assert.deepEqual(
    flow.device.accessory.services.map((service) => [service.UUID, service.subtype]),
    identities,
  );
  let selection = cached.getCharacteristic(C.ActiveTemperatureSensor);
  assert.deepEqual(selection.props.perms, [hap.Perms.PAIRED_READ, hap.Perms.PAIRED_WRITE, hap.Perms.NOTIFY]);
  await selection.handleSetRequest(true);
  assert.deepEqual(flow.writes, [{ uuid: getResourceKey('account', 'HomeGraph', 'sensor'), active_sensor: true }]);
  raw[getResourceKey('account', 'HomeGraph', 'sensor')].value['temperatureSetting.ambientAirTemperatureC'].number = 23.5;
  raw[getResourceKey('account', 'HomeGraph', 'sensor')].value['charging.descriptiveCapacityRemaining'].text = 'low';
  raw[getResourceKey('account', 'HomeGraph', 'sensor')].value['deviceStatus.online'].boolean = false;
  raw[getResourceKey('account', 'HomeGraph', 'parent')].value['temperatureSetting.activeThermostatTemperatureSensors'].array.values = [
    { text: 'parent' },
  ];
  mapped = processRawData(undefined, raw, { options: {} })['22AA_NATIVE_FIXTURE'];
  await flow.device.update(mapped.data);
  assert.equal(value(cached, C.CurrentTemperature), 23.5);
  assert.equal(value(cached, C.StatusActive), false);
  assert.equal(value(cached, C.ActiveTemperatureSensor), false);
  assert.equal(value(cachedBattery, C.BatteryLevel), LOW_BATTERY_LEVEL);
  assert.equal(value(cachedBattery, C.StatusLowBattery), C.StatusLowBattery.BATTERY_LEVEL_LOW);
  assert.deepEqual(flow.warnings, []);
});

test('Off-mode thermostat without cloud setpoints returns finite HomeKit temperatures and reuses cached services', async (context) => {
  let flow = await setup(context, 'thermostat', {
    target_temperature: undefined,
    target_temperature_low: undefined,
    target_temperature_high: undefined,
  });
  let service = flow.device.thermostatService;
  for (let characteristic of [C.TargetTemperature, C.HeatingThresholdTemperature, C.CoolingThresholdTemperature]) {
    let control = service.getCharacteristic(characteristic);
    assert.equal(Number.isFinite(await control.handleGetRequest()), true);
  }
  let identities = flow.device.accessory.services.map((entry) => [entry.UUID, entry.subtype]);
  let uuid = flow.device.accessory.UUID;
  flow.device.accessory = hap.Accessory.deserialize(hap.Accessory.serialize(flow.device.accessory));
  await flow.device.onAdd();
  assert.equal(flow.device.accessory.UUID, uuid);
  assert.deepEqual(
    flow.device.accessory.services.map((entry) => [entry.UUID, entry.subtype]),
    identities,
  );
  await flow.device.update({ hvac_mode: 'cool', target_temperature: 24.5, target_temperature_high: 24.5 });
  assert.equal(await flow.device.thermostatService.getCharacteristic(C.TargetTemperature).handleGetRequest(), 24.5);
  await flow.device.thermostatService.getCharacteristic(C.TargetTemperature).handleSetRequest(25);
  assert.deepEqual(flow.writes, [{ uuid: 'DEVICE_TEST', target_temperature_high: 25 }]);
  assert.deepEqual(flow.warnings, []);
});

test('mapped HomeGraph Protect updates alarm and battery services without changing cached identity', async (context) => {
  let { processRawData } = await importSource(new URL('../src/plugins/protect.js', import.meta.url));
  let raw = protectHomeGraphFixture();
  let mapped = () => processRawData(undefined, raw, { options: {} })['06TESTPROTECT'].data;
  let flow = await setup(context, 'protect', mapped());
  await flow.device.onUpdate(flow.device.deviceData);
  let uuid = flow.device.accessory.UUID;
  let identities = flow.device.accessory.services.map((service) => [service.UUID, service.subtype]);
  flow.device.accessory = hap.Accessory.deserialize(hap.Accessory.serialize(flow.device.accessory));
  let smoke = flow.device.accessory.getService(hap.Service.SmokeSensor);
  let co = flow.device.accessory.getService(hap.Service.CarbonMonoxideSensor);
  let battery = flow.device.accessory.getService(hap.Service.Battery);
  await flow.device.onAdd();
  assert.equal(flow.device.smokeService, smoke);
  assert.equal(flow.device.carbonMonoxideService, co);
  assert.equal(flow.device.batteryService, battery);
  assert.equal(flow.device.accessory.UUID, uuid);
  assert.deepEqual(
    flow.device.accessory.services.map((service) => [service.UUID, service.subtype]),
    identities,
  );
  protectSensorProperty(raw, 0, 'currentSensorState', 'smoke detected');
  protectSensorProperty(raw, 0, 'alarmSilenceState', 'SILENCED');
  protectSensorProperty(raw, 1, 'currentSensorState', 'carbon monoxide detected');
  raw[getResourceKey('account', 'HomeGraph', 'protect')].value['charging.descriptiveCapacityRemaining'].text = 'low';
  await flow.device.update(mapped());
  assert.equal(smoke.getCharacteristic(C.SmokeDetected).value, C.SmokeDetected.SMOKE_DETECTED);
  assert.equal(co.getCharacteristic(C.CarbonMonoxideDetected).value, C.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL);
  assert.equal(battery.getCharacteristic(C.StatusLowBattery).value, C.StatusLowBattery.BATTERY_LEVEL_LOW);
  assert.equal(battery.getCharacteristic(C.BatteryLevel).value, 10);
  protectSensorProperty(raw, 0, 'currentSensorState', 'no smoke detected');
  protectSensorProperty(raw, 1, 'currentSensorState', 'no carbon monoxide detected');
  raw[getResourceKey('account', 'HomeGraph', 'protect')].value['charging.descriptiveCapacityRemaining'].text = 'unknown';
  await flow.device.update(mapped());
  assert.equal(smoke.getCharacteristic(C.SmokeDetected).value, C.SmokeDetected.SMOKE_NOT_DETECTED);
  assert.equal(co.getCharacteristic(C.CarbonMonoxideDetected).value, C.CarbonMonoxideDetected.CO_LEVELS_NORMAL);
  assert.equal(battery.testCharacteristic(C.BatteryLevel), false);
  assert.deepEqual(flow.writes, []);
  assert.deepEqual(flow.warnings, []);
});

test('Protect Eve reads preserve retained details when HomeGraph fields are unavailable', async (context) => {
  let previous = HomeKitDevice.EVEHOME;
  context.after(() => {
    HomeKitDevice.EVEHOME = previous;
  });
  HomeKitDevice.EVEHOME = { GET: 'fixture-eve-get', SET: 'fixture-eve-set' };
  let { processRawData } = await importSource(new URL('../src/plugins/protect.js', import.meta.url));
  let raw = protectHomeGraphFixture();
  let fields = raw[getResourceKey('account', 'HomeGraph', 'home', 'STRUCTURE')].value.home.traits[0].fields;
  fields.audioTest.structValue.fields.status = { stringValue: 'SELF_TEST_STATUS_COMPLETED' };
  let mapped = () => processRawData(undefined, raw, { options: {} })['06TESTPROTECT'].data;
  let flow = await setup(context, 'protect', mapped());
  let retained = {
    lastalarmtest: 0,
    alarmtest: true,
    heatstatus: false,
    statusled: true,
    smoketestpassed: true,
    heattestpassed: true,
    hushedstate: true,
  };
  let result = flow.device.onMessage(HomeKitDevice.EVEHOME.GET, { ...retained });
  assert.deepEqual(result, { ...retained, lastalarmtest: 1785047209, alarmtest: false, hushedstate: false });
  delete fields.manualTest;
  delete fields.audioTest;
  let unavailable = await setup(context, 'protect', {
    ...mapped(),
    serialNumber: '06TESTUNAVAILABLE',
    self_test_in_progress: undefined,
    latest_alarm_test: undefined,
    hushed_state: undefined,
  });
  assert.deepEqual(unavailable.device.onMessage(HomeKitDevice.EVEHOME.GET, { ...retained }), retained);
  assert.deepEqual(flow.writes, []);
  assert.deepEqual(flow.warnings, []);
});

test('Protect HomeGraph Eve configuration passes the real history encoder without refresh warnings', async (context) => {
  let previous = HomeKitDevice.EVEHOME;
  context.after(() => {
    HomeKitDevice.EVEHOME = previous;
  });
  HomeKitDevice.EVEHOME = HomeKitHistory;
  let { processRawData } = await importSource(new URL('../src/plugins/protect.js', import.meta.url));
  let raw = protectHomeGraphFixture();
  raw[getResourceKey('account', 'HomeGraph', 'home', 'STRUCTURE')].value.home.traits[0].fields.audioTest.structValue.fields.status = {
    stringValue: 'SELF_TEST_STATUS_COMPLETED',
  };
  let mapped = processRawData(undefined, raw, { options: {} })['06TESTPROTECT'].data;
  let flow = await setup(context, 'protect', mapped);
  let warnings = [];
  let history = new HomeKitHistory(
    flow.device.accessory,
    { version: 2.5, hap: { ...hap, HAPStorage: { storage: () => ({ getItem: () => undefined, setItemSync() {} }) } } },
    { warn: (...args) => warnings.push(args) },
  );
  await history.linkToEveHome(flow.device.smokeService, { messages: (type, message) => flow.device.onMessage(type, message) });
  let configuration = flow.device.smokeService.getCharacteristic(C.EveGetConfiguration);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal(typeof (await configuration.handleGetRequest()), 'string');
  }
  assert.equal(history.EveSmokePersist.alarmtest, false);
  assert.equal(history.EveSmokePersist.lastalarmtest, 1785047209);
  assert.deepEqual(warnings, []);
  assert.deepEqual(flow.writes, []);
});

test('HomeGraph active-cooling delta updates HomeKit current state while retaining Cool target mode', async (context) => {
  let { processRawData } = await importSource(new URL('../src/plugins/thermostat.js', import.meta.url));
  let id = getResourceKey('cooling', DATA_SOURCE.HOMEGRAPH, 'thermostat');
  let raw = {
    [getResourceKey('cooling', DATA_SOURCE.HOMEGRAPH, 'home', 'STRUCTURE')]: {
      source: DATA_SOURCE.HOMEGRAPH,
      connection: 'cooling',
      value: { home: { uuid: 'home', name: 'Fixture' } },
    },
    [id]: {
      source: DATA_SOURCE.HOMEGRAPH,
      connection: 'cooling',
      value: {
        structureId: 'home',
        technicalInformation: { serialNumber: 'THERMOSTAT_COOLING_DELTA' },
        googleHome: {
          id: { googleUuid: 'thermostat', thirdPartyId: { idType: 'nest-home-assistant-prod' } },
          type: 'action.devices.types.THERMOSTAT',
          displayName: 'Thermostat',
          hardware: { model: 'Nest Thermostat E', softwareVersion: '6.5-14' },
        },
        'deviceStatus.online': { boolean: true },
        'temperatureSetting.mode': { text: 'cool' },
        'temperatureSetting.activeThermostatMode': { text: 'none' },
        'temperatureSetting.thermostatTemperatureSetpointC': { number: 24.5 },
        'attributes.temperatureSetting.availableThermostatModes': {
          array: { values: ['heat', 'cool', 'heatcool', 'off'].map((text) => ({ text })) },
        },
        'fanSettings.fanTimerEndTimestampSec': { number: 0 },
        'fanSpeed.currentFanSpeedSetting': { text: 'OFF' },
      },
    },
  };
  let mapped = (changes) => processRawData(undefined, raw, { options: {} }, undefined, changes).THERMOSTAT_COOLING_DELTA.data;
  let flow = await setup(context, 'thermostat', mapped());
  await flow.device.onUpdate(flow.device.deviceData);
  let service = flow.device.thermostatService;
  assert.equal(value(service, C.TargetHeatingCoolingState), C.TargetHeatingCoolingState.COOL);
  assert.equal(value(service, C.CurrentHeatingCoolingState), C.CurrentHeatingCoolingState.OFF);
  let delta = {
    'fanSpeed.currentFanSpeedSetting': { text: 'S1' },
    'temperatureSetting.activeThermostatMode': { text: 'cool' },
    'temperatureSetting.compactCaptions': {
      array: { values: [{ properties: { properties: [{ name: 'hvacStatusText', value: { text: 'Cooling' } }] } }] },
    },
  };
  Object.assign(raw[id].value, delta);
  await flow.device.update(mapped(new Map([[id, { fields: new Set(Object.keys(delta)) }]])));
  assert.equal(flow.device.thermostatService, service);
  assert.equal(value(service, C.TargetHeatingCoolingState), C.TargetHeatingCoolingState.COOL);
  assert.equal(value(service, C.CurrentHeatingCoolingState), C.CurrentHeatingCoolingState.COOL);
  assert.equal(value(service, C.TargetTemperature), 24.5);
  assert.equal(flow.device.deviceData.hvac_state, 'cooling');
  assert.equal(flow.device.deviceData.fan_timer_speed, 1);
  raw[id].value['temperatureSetting.activeThermostatMode'] = { text: 'none' };
  await flow.device.update(mapped(new Map([[id, { fields: new Set(['temperatureSetting.activeThermostatMode']) }]])));
  assert.equal(value(service, C.CurrentHeatingCoolingState), C.CurrentHeatingCoolingState.OFF);
  assert.equal(value(service, C.TargetHeatingCoolingState), C.TargetHeatingCoolingState.COOL);
  assert.deepEqual(flow.writes, []);
  assert.deepEqual(flow.warnings, []);
});

for (let humidity of [undefined, 0]) {
  test('cached weather reconciles only its humidity service at setup: humidity=' + humidity, async (context) => {
    let flow = await setup(context, 'weather');
    let uuid = flow.device.accessory.UUID;
    flow.device.accessory.addService(hap.Service.HumiditySensor, 'Other humidity', 2);
    flow.device.accessory = hap.Accessory.deserialize(hap.Accessory.serialize(flow.device.accessory));
    let temperature = flow.device.accessory.getServiceById(hap.Service.TemperatureSensor, 1);
    let battery = flow.device.accessory.getServiceById(hap.Service.Battery, 1);
    let cachedHumidity = flow.device.accessory.getServiceById(hap.Service.HumiditySensor, 1);
    let otherHumidity = flow.device.accessory.getServiceById(hap.Service.HumiditySensor, 2);
    flow.device.deviceData.current_humidity = humidity;
    flow.device.onAdd();
    flow.device.onUpdate(flow.device.deviceData);
    assert.equal(flow.device.accessory.UUID, uuid);
    assert.equal(flow.device.temperatureService, temperature);
    assert.equal(flow.device.batteryService, battery);
    assert.equal(flow.device.accessory.getServiceById(hap.Service.HumiditySensor, 2), otherHumidity);
    assert.equal(flow.device.humidityService, humidity === undefined ? undefined : cachedHumidity);
    assert.equal(flow.device.accessory.getServiceById(hap.Service.HumiditySensor, 1), humidity === undefined ? undefined : cachedHumidity);
    if (humidity === 0) {
      assert.equal(cachedHumidity.getCharacteristic(C.CurrentRelativeHumidity).value, 0);
    }
  });
}
