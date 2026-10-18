// Drive discovery decisions, cached identity and account/source ownership through the public platform lifecycle.
import assert from 'node:assert/strict';
import hap from './helpers/homebridge-hap.js';
import test from 'node:test';
import HomeKitDevice from '../src/HomeKitDevice/HomeKitDevice.js';
import { DATA_SOURCE, DEVICE_TYPE } from '../src/consts.js';
import { platformHarness } from './helpers/platform-harness.js';

let data = {
  serialNumber: 'FIXTURE',
  manufacturer: 'Nest',
  model: 'Fixture',
  softwareVersion: '1.0.0',
  description: 'Fixture',
  nest_google_device_uuid: 'DEVICE_TEST',
  excluded: false,
};

test('platform waits for a full mapping then delivers partial updates to the same accessory', async (context) => {
  let full = false;
  let flow = await platformHarness(context, {
    map: (raw) => ({ FIXTURE: { full, data: { ...data, reading: raw.DEVICE_TEST?.value.fixture?.reading } } }),
  });
  assert.equal(flow.registered.length, 0);
  full = true;
  await flow.send('DEVICE_TEST', { fixture: { reading: 1 } });
  assert.equal(flow.registered.length, 1);
  let accessory = flow.device.accessory;
  full = false;
  await flow.send('DEVICE_TEST', { fixture: { reading: 2 } });
  assert.equal(flow.device.deviceData.reading, 2);
  assert.equal(flow.device.accessory, accessory);
  assert.equal(flow.registered.length, 1);
});
for (let type of [DEVICE_TYPE.CAMERA, DEVICE_TYPE.WEATHER]) {
  test('excluded cached ' + type + ' is unregistered once without creating a device', async (context) => {
    let uuid = HomeKitDevice.generateUUID('platform-harness', { version: 2.7, hap }, 'FIXTURE');
    let cached = new hap.Accessory('Excluded', uuid);
    let flow = await platformHarness(context, {
      type,
      cachedAccessories: [cached],
      map: () => ({ FIXTURE: { full: true, data: { ...data, excluded: true } } }),
    });
    assert.equal(flow.device, undefined);
    assert.deepEqual(flow.registered, []);
    assert.deepEqual(flow.removed, [cached]);
    await flow.send('DEVICE_TEST', { fixture: { updated: true } });
    assert.deepEqual(flow.removed, [cached]);
    assert.equal(
      flow.logs.filter((entry) => entry[0] === 'warn' && String(entry[1]).includes('marked as excluded')).length,
      type === DEVICE_TYPE.WEATHER ? 0 : 1,
    );
  });
}
for (let type of [DEVICE_TYPE.CAMERA, DEVICE_TYPE.DOORBELL, DEVICE_TYPE.FLOODLIGHT, DEVICE_TYPE.THERMOSTAT]) {
  test(type + ' source switching preserves identity and honours Nest fallback policy', async (context) => {
    let selected = 'quartz.TEST';
    let flow = await platformHarness(context, {
      source: DATA_SOURCE.NEST,
      id: selected,
      value: { serial_number: 'FIXTURE' },
      type,
      map: (raw) => (raw[selected] === undefined ? {} : { FIXTURE: { full: true, data: { ...data, nest_google_device_uuid: selected } } }),
    });
    let accessory = flow.device.accessory;
    assert.equal(flow.device.deviceData.nest_google_device_uuid, 'quartz.TEST');
    selected = 'DEVICE_TEST';
    await flow.send(selected, { fixture: {} });
    assert.equal(flow.device.deviceData.nest_google_device_uuid, 'DEVICE_TEST');
    selected = 'quartz.TEST';
    await flow.send('DEVICE_TRIGGER', { fixture: {} });
    assert.equal(flow.device.deviceData.nest_google_device_uuid, type === DEVICE_TYPE.THERMOSTAT ? 'DEVICE_TEST' : 'quartz.TEST');
    assert.equal(flow.device.accessory, accessory);
    assert.equal(flow.registered.length, 1);
  });
}
for (let type of [DEVICE_TYPE.CAMERA, DEVICE_TYPE.DOORBELL, DEVICE_TYPE.FLOODLIGHT]) {
  test(type + ' account refresh changes credentials only for its selected resource owner', async (context) => {
    let flow = await platformHarness(context, { type });
    let before = structuredClone(flow.device.deviceData.apiAccess);
    let other = { ...flow.connection, cameraAuth: { token: 'other-account-token' } };
    flow.connections.set('other', other);
    await flow.authorise('other', other, { wasAuthorised: true });
    assert.deepEqual(flow.device.deviceData.apiAccess, before);
    flow.connection.cameraAuth = { token: 'refreshed-owner-token' };
    await flow.authorise('account', flow.connection, { wasAuthorised: true });
    assert.deepEqual(flow.device.deviceData.apiAccess, flow.connection.cameraAuth);
    assert.equal(flow.registered.length, 1);
  });
}
for (let result of [null, undefined, { INVALID: { full: true, data: null } }, { INVALID: { full: true, data: [] } }]) {
  test('invalid mapper output cannot create an accessory: ' + JSON.stringify(result), async (context) => {
    let flow = await platformHarness(context, { map: () => result });
    assert.equal(flow.device, undefined);
    assert.deepEqual(flow.registered, []);
  });
}
test('a failed device mapper is reported and later data can recover without restarting the platform', async (context) => {
  let broken = true;
  let flow = await platformHarness(context, {
    map: () => {
      if (broken === true) {
        throw new Error('Fixture mapper failed');
      }
      return { FIXTURE: { full: true, data: { ...data } } };
    },
  });
  assert.equal(flow.registered.length, 0);
  assert.equal(
    flow.logs.some((entry) => entry[0] === 'warn' && String(entry[3]).includes('Fixture mapper failed')),
    true,
  );
  broken = false;
  await flow.send('DEVICE_TEST', { fixture: { retry: true } });
  assert.equal(flow.registered.length, 1);
});
