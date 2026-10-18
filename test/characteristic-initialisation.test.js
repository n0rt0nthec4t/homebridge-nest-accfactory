// Verify thermostat/Heat Link setup uses real instance-scoped HAP bounds without changing shared defaults or service identity.
import assert from 'node:assert/strict';
import { importSource } from './helpers/import-source.js';
import { readFile } from 'node:fs/promises';
import hap from './helpers/homebridge-hap.js';
import test from 'node:test';
import HomeKitDevice from '../src/HomeKitDevice/HomeKitDevice.js';

let classes = {};
for (let name of ['thermostat', 'heatlink']) {
  let location = new URL('../src/plugins/' + name + '.js', import.meta.url);
  let source = (await readFile(location, 'utf8')).replace(/from '([^']+)'/g, (match, specifier) => {
    let target =
      specifier === '../HomeKitDevice.js'
        ? new URL('../src/HomeKitDevice/HomeKitDevice.js', import.meta.url).href
        : specifier.startsWith('.') === true
          ? new URL(specifier, location).href
          : specifier;
    return 'from ' + JSON.stringify(target);
  });
  classes[name] = (await importSource(location, source)).default;
}

HomeKitDevice.PLUGIN_NAME = 'characteristic-initialisation-test';
let nextSerial = 0;
function setup(context, name, data = {}, cached = undefined) {
  let serialNumber = 'CHARACTERISTIC-' + nextSerial++;
  let device = new classes[name](
    undefined,
    { version: 2.7, hap },
    {
      serialNumber,
      manufacturer: 'Nest',
      model: name,
      description: name,
      softwareVersion: '1.0.0',
      temperature_scale: 'C',
      current_temperature: 21,
      current_humidity: 45,
      target_temperature: 22,
      target_temperature_low: 20,
      target_temperature_high: 24,
      can_heat: true,
      can_cool: true,
      has_humidifier: false,
      has_dehumidifier: false,
      humidifier_state: false,
      dehumidifier_state: false,
      target_humidity_humidifier: 50,
      target_humidity_dehumidifier: 60,
      has_hot_water_temperature: true,
      has_hot_water_control: false,
      current_water_temperature: 50,
      hot_water_temperature: 55,
      hotwaterMinTemp: 45,
      hotwaterMaxTemp: 80,
      ...data,
    },
  );
  device.accessory = cached ?? new hap.Accessory(name, hap.uuid.generate(serialNumber));
  let warnings = [];
  device.accessory.on('characteristic-warning', (warning) => warnings.push(warning));
  let writes = [];
  device.set = async (values) => {
    writes.push(values);
  };
  context.after(() => device.remove());
  return { device, warnings, writes };
}

test('mixed thermostat and Heat Link setup preserves shared HAP defaults and emits no bounds diagnostics', async (context) => {
  let types = [
    hap.Characteristic.TargetTemperature,
    hap.Characteristic.HeatingThresholdTemperature,
    hap.Characteristic.CoolingThresholdTemperature,
    hap.Characteristic.TargetHeatingCoolingState,
    hap.Characteristic.TargetHumidifierDehumidifierState,
  ];
  let defaults = types.map((type) => ({
    type,
    method: type.prototype.getDefaultValue,
    value: new type().value,
    descriptor: Object.getOwnPropertyDescriptor(type.prototype, 'getDefaultValue'),
  }));
  // Keep failed regressions from contaminating the following cases in this process.
  context.after(() => {
    for (let { type, descriptor } of defaults) {
      if (descriptor === undefined) {
        delete type.prototype.getDefaultValue;
      } else {
        Object.defineProperty(type.prototype, 'getDefaultValue', descriptor);
      }
    }
  });

  for (let [name, data] of [
    ['heatlink', {}],
    ['thermostat', { has_humidifier: true }],
    ['thermostat', { has_dehumidifier: true }],
    ['thermostat', { has_humidifier: true, has_dehumidifier: true }],
    ['heatlink', { hotwaterMinTemp: 1, hotwaterMaxTemp: 5, hot_water_temperature: 3 }],
  ]) {
    let flow = setup(context, name, data);
    await flow.device.onAdd();
    assert.deepEqual(flow.warnings, []);
    assert.deepEqual(flow.writes, []);
    for (let { type, method, value } of defaults) {
      assert.equal(type.prototype.getDefaultValue, method, type.name + ' shared method must remain unchanged');
      assert.equal(new type().value, value, type.name + ' unrelated default must remain unchanged');
    }
    if (name === 'thermostat') {
      assert.equal(flow.device.thermostatService.getCharacteristic(hap.Characteristic.TargetTemperature).value, 22);
      assert.equal(flow.device.thermostatService.getCharacteristic(hap.Characteristic.HeatingThresholdTemperature).value, 20);
      assert.equal(flow.device.thermostatService.getCharacteristic(hap.Characteristic.CoolingThresholdTemperature).value, 24);
      let target = data.has_humidifier === true && data.has_dehumidifier === true ? 0 : data.has_humidifier === true ? 1 : 2;
      assert.equal(
        flow.device.humidifierDehumidifierService.getCharacteristic(hap.Characteristic.TargetHumidifierDehumidifierState).value,
        target,
      );
    } else {
      assert.equal(
        flow.device.thermostatService.getCharacteristic(hap.Characteristic.TargetTemperature).value,
        flow.device.deviceData.hot_water_temperature,
      );
      assert.deepEqual(
        flow.device.thermostatService.getCharacteristic(hap.Characteristic.TargetHeatingCoolingState).props.validValues,
        [1],
      );
    }
  }
});

for (let name of ['thermostat', 'heatlink']) {
  test('cached ' + name + ' setup reuses characteristic identity and applies its device values without diagnostics', async (context) => {
    let accessory = new hap.Accessory('Cached device', hap.uuid.generate('cached-' + name));
    let service = accessory.addService(hap.Service.Thermostat, '', 1);
    let target = service.getCharacteristic(hap.Characteristic.TargetTemperature);
    let flow = setup(context, name, {}, accessory);
    await flow.device.onAdd();
    assert.equal(flow.device.thermostatService, service);
    assert.equal(service.getCharacteristic(hap.Characteristic.TargetTemperature), target);
    assert.equal(target.value, name === 'thermostat' ? 22 : 55);
    assert.deepEqual(flow.warnings, []);
    assert.deepEqual(flow.writes, []);
  });
}

for (let [mode, canHeat, canCool, target] of [
  ['heat', true, false, hap.Characteristic.TargetHeatingCoolingState.HEAT],
  ['cool', false, true, hap.Characteristic.TargetHeatingCoolingState.COOL],
  ['range', true, true, hap.Characteristic.TargetHeatingCoolingState.AUTO],
  ['ecoheat', true, false, hap.Characteristic.TargetHeatingCoolingState.HEAT],
  ['ecocool', false, true, hap.Characteristic.TargetHeatingCoolingState.COOL],
  ['ecorange', true, true, hap.Characteristic.TargetHeatingCoolingState.AUTO],
]) {
  test('upstream ' + mode + ' to off updates HomeKit without changing thermostat capabilities', async (context) => {
    let flow = setup(context, 'thermostat', { can_heat: canHeat, can_cool: canCool, hvac_state: 'off' });
    await flow.device.onAdd();
    await flow.device.update({ hvac_mode: mode });
    let characteristic = flow.device.thermostatService.getCharacteristic(hap.Characteristic.TargetHeatingCoolingState);
    assert.equal(characteristic.value, target);
    // This is the normalised state received after an off change in the Nest app.
    await flow.device.update({ hvac_mode: 'off' });
    assert.equal(characteristic.value, hap.Characteristic.TargetHeatingCoolingState.OFF);
    assert.equal(flow.device.deviceData.can_heat, canHeat);
    assert.equal(flow.device.deviceData.can_cool, canCool);
    assert.equal(flow.device.getMode(), hap.Characteristic.TargetHeatingCoolingState.OFF);
    assert.deepEqual(flow.writes, []);
    assert.deepEqual(flow.warnings, []);
  });
}

test('temperature setup uses valid fallbacks when optional target readings are not yet available', async (context) => {
  let thermostat = setup(context, 'thermostat', {
    target_temperature: undefined,
    target_temperature_low: undefined,
    target_temperature_high: undefined,
  });
  await thermostat.device.onAdd();
  assert.equal(thermostat.device.thermostatService.getCharacteristic(hap.Characteristic.TargetTemperature).value, 9);
  assert.equal(thermostat.device.thermostatService.getCharacteristic(hap.Characteristic.HeatingThresholdTemperature).value, 9);
  assert.equal(thermostat.device.thermostatService.getCharacteristic(hap.Characteristic.CoolingThresholdTemperature).value, 32);
  let heatlink = setup(context, 'heatlink', { hot_water_temperature: undefined });
  await heatlink.device.onAdd();
  assert.equal(heatlink.device.thermostatService.getCharacteristic(hap.Characteristic.TargetTemperature).value, 45);
  assert.deepEqual(thermostat.warnings, []);
  assert.deepEqual(heatlink.warnings, []);
});
