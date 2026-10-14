// Verify humidifier capability changes preserve automatic mode and existing service identity.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { URL } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { DATA_SOURCE } from '../../src/consts.js';

let require = createRequire(import.meta.url);
let hap = require('@homebridge/hap-nodejs');
let parent = 'data:text/javascript,' + encodeURIComponent('export default class { constructor(data) { this.deviceData = data; } }');
let location = new URL('../../src/plugins/thermostat.js', import.meta.url);
let source = (await readFile(location, 'utf8')).replace(/from '([^']+)'/g, (match, specifier) => {
  return (
    'from ' +
    JSON.stringify(
      specifier === '../HomeKitDevice.js' ? parent : specifier.startsWith('.') === true ? new URL(specifier, location).href : specifier,
    )
  );
});
// Expose the existing setup boundary without changing its body or production visibility.
source = source.replaceAll('#setupHumidifierDehumidifier', 'setupHumidityForTest').replaceAll('#external', 'externalForTest');
let { default: Thermostat, processRawData } = await import('data:text/javascript,' + encodeURIComponent(source));

for (let firstSource of [DATA_SOURCE.NEST, DATA_SOURCE.GOOGLE]) {
  test('thermostat mapper selects the changed source with raw data arriving first from ' + firstSource, () => {
    let nest = ['device.nest', { source: DATA_SOURCE.NEST, value: { serial_number: 'SERIAL', backplate_temperature: 19 } }];
    let google = [
      'DEVICE_GOOGLE',
      {
        source: DATA_SOURCE.GOOGLE,
        value: {
          device_identity: { serialNumber: 'SERIAL' },
          device_info: { typeName: 'nest.resource.NestLearningThermostat3Resource', pairerId: { resourceId: 'STRUCTURE_HOME' } },
          configuration_done: { deviceReady: true },
          current_temperature: { temperatureValue: { temperature: { value: 21 } } },
        },
      },
    ];
    let raw = {
      ...Object.fromEntries(firstSource === DATA_SOURCE.NEST ? [nest, google] : [google, nest]),
      'track.SERIAL': { value: {} },
      'shared.SERIAL': { value: {} },
      'link.SERIAL': { value: { structure: 'structure.home' } },
      'where.home': { value: {} },
      STRUCTURE_HOME: { value: {} },
    };
    for (let [resource, field, temperature] of [
      ['DEVICE_GOOGLE', 'current_temperature', 21],
      ['device.nest', 'backplate_temperature', 19],
    ]) {
      let mapped = processRawData(undefined, raw, { options: {} }, undefined, new Map([[resource, { fields: new Set([field]) }]]));
      assert.equal(mapped.SERIAL.full, false);
      assert.equal(mapped.SERIAL.data.nest_google_device_uuid, resource);
      assert.equal(mapped.SERIAL.data.current_temperature, temperature);
    }
  });
}

function service() {
  let characteristics = new Map();
  return {
    addLinkedService() {},
    getCharacteristic(type) {
      if (characteristics.has(type) === false) {
        characteristics.set(type, {
          props: {},
          setProps(props) {
            this.props = { ...this.props, ...props };
          },
        });
      }
      return characteristics.get(type);
    },
    testCharacteristic: (type) => characteristics.has(type),
    updateCharacteristic(type, value) {
      this.getCharacteristic(type).value = value;
    },
    removeCharacteristic: (type) => characteristics.delete(type),
  };
}

for (let [previous, next, control, target] of [
  ['COOLING', 'HEATING', 'heat', 20],
  ['HEATING', 'COOLING', 'cool', 26],
]) {
  test('external ' + control + ' waits for off and completes before the thermostat update resolves', async () => {
    let device = new Thermostat({ hvac_state: previous });
    device.hap = hap;
    device.thermostatService = service();
    device.batteryService = service();
    device.history = () => {};
    let stopping = Promise.withResolvers();
    let starting = Promise.withResolvers();
    let calls = [];
    device.externalForTest = {
      off: () => {
        calls.push('off');
        return stopping.promise;
      },
      [control]: (temperature) => {
        calls.push([control, temperature]);
        return starting.promise;
      },
    };
    let finished = false;
    let update = device.onUpdate({ hvac_state: next, target_temperature_low: 20, target_temperature_high: 26 });
    update.then(() => {
      finished = true;
    });
    await setImmediate();
    assert.deepEqual(calls, ['off']);
    assert.equal(finished, false);
    stopping.resolve();
    await setImmediate();
    assert.deepEqual(calls, ['off', [control, target]]);
    assert.equal(finished, false);
    starting.resolve();
    await update;
    assert.equal(finished, true);

    let failure = new Error('External off failed');
    device.externalForTest.off = async () => {
      throw failure;
    };
    await assert.rejects(device.onUpdate({ hvac_state: next }), (error) => error === failure);
    assert.equal(calls.length, 2, 'a rejected off must not proceed to the new mode');
  });
}

test('initial and updated humidifier capabilities retain enum zero and reuse the service', async () => {
  let device = new Thermostat({ has_humidifier: true, has_dehumidifier: false });
  device.hap = hap;
  device.thermostatService = service();
  device.batteryService = service();
  device.addService = () => service();
  device.addCharacteristic = (target, type, options = {}) => {
    let characteristic = target.getCharacteristic(type);
    characteristic.setProps(options.props ?? {});
    characteristic.value = options.initialValue;
    characteristic.onGet = options.onGet;
  };
  device.removeCharacteristic = (target, type) => target.removeCharacteristic(type);
  device.log = { info() {}, debug() {} };
  device.history = () => {};
  let type = hap.Characteristic.TargetHumidifierDehumidifierState;
  for (let [humidifier, dehumidifier, expected] of [
    [true, false, [1]],
    [false, true, [2]],
    [true, true, [0, 1, 2]],
  ]) {
    device.deviceData = { has_humidifier: humidifier, has_dehumidifier: dehumidifier };
    device.setupHumidityForTest(humidifier, dehumidifier);
    let characteristic = device.humidifierDehumidifierService.getCharacteristic(type);
    assert.deepEqual(characteristic.props.validValues, expected);
    assert.equal(expected.includes(characteristic.value), true);
    assert.equal(expected.includes(characteristic.onGet()), true);
  }
  let existing = device.humidifierDehumidifierService;
  for (let [humidifier, dehumidifier, expected] of [
    [true, false, [1]],
    [true, true, [0, 1, 2]],
    [false, true, [2]],
  ]) {
    let data = { ...device.deviceData, has_humidifier: humidifier, has_dehumidifier: dehumidifier };
    await device.onUpdate(data);
    assert.equal(device.humidifierDehumidifierService, existing);
    assert.deepEqual(existing.getCharacteristic(type).props.validValues, expected);
    device.deviceData = data;
    assert.equal(expected.includes(existing.getCharacteristic(type).onGet()), true);
  }
});
