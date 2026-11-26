// Drive discovery decisions, cached identity and account/source ownership through the public platform lifecycle.
import { getResourceKey } from '../src/utils.js';
import assert from 'node:assert/strict';
import hap from './helpers/homebridge-hap.js';
import test from 'node:test';
import HomeKitDevice from '../src/HomeKitDevice/HomeKitDevice.js';
import { DEVICE_TYPE, DATA_SOURCE } from '../src/consts.js';
import { platformHarness } from './helpers/platform-harness.js';
import { fixtures } from './helpers/discovery-fixtures.js';
import { importSource } from './helpers/import-source.js';
import { setImmediate } from 'node:timers/promises';

let { processRawData: mapLock } = await importSource(new URL('../src/plugins/lock.js', import.meta.url));

test('startup enforces the complete minimum Node.js version', async (context) => {
  const { default: Platform } = await importSource(new URL('../src/system.js', import.meta.url));
  const original = Object.getOwnPropertyDescriptor(process.versions, 'node');
  context.after(() => Object.defineProperty(process.versions, 'node', original));
  for (const [version, supported] of [
    ['20.99.0', false],
    ['22.12.99', false],
    ['22.13.0', true],
    ['22.13.1', true],
    ['22.100.0', true],
    ['24.0.0', true],
    ['26.0.0', true],
  ]) {
    Object.defineProperty(process.versions, 'node', { ...original, value: version });
    const errors = [];
    const events = [];
    new Platform({ error: (...args) => errors.push(args) }, {}, { on: (event) => events.push(event) });
    assert.equal(events.includes('didFinishLaunching'), supported, version);
    assert.equal(errors.length, supported === true ? 0 : 1, version);
    if (supported === false) {
      assert.deepEqual(errors[0].slice(1), [version, '22.13.0']);
    }
  }
});

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

for (let type of [DEVICE_TYPE.CAMERA, DEVICE_TYPE.DOORBELL, DEVICE_TYPE.FLOODLIGHT]) {
  test(type + ' account refresh changes credentials only for its selected resource owner', async (context) => {
    let flow = await platformHarness(context, { type });
    let before = structuredClone(flow.device.deviceData.apiAccess);
    let other = { ...flow.connection, cameraAuth: { token: 'other-account-token' } };
    flow.accounts.set('other', other);
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

for (let debug of [true, false]) {
  test('startup runtime diagnostics respect configuration debug=' + debug, async (context) => {
    let flow = await platformHarness(context, { config: { debug } });
    for (let label of ['System:', 'CPU:', 'Memory:', 'Node.js:']) {
      let messages = flow.logs.filter((entry) => String(entry[1]).includes(label));
      assert.equal(messages.length, debug === true ? 1 : 0, label);
      if (debug === true) {
        assert.equal(messages[0][0], 'info', 'configuration debug must work without Homebridge debug mode');
      }
    }
  });
}

for (let type of [DEVICE_TYPE.CAMERA, DEVICE_TYPE.DOORBELL, DEVICE_TYPE.FLOODLIGHT, DEVICE_TYPE.THERMOSTAT]) {
  test(type + ' protobuf resource replacement preserves accessory and service identity', async (context) => {
    let selected = 'DEVICE_TEST';
    let flow = await platformHarness(context, {
      type,
      map: (raw) =>
        raw[selected] === undefined
          ? {}
          : {
              FIXTURE: { full: true, data: { ...data, nest_google_device_uuid: selected } },
            },
    });
    let accessory = flow.device.accessory;
    let uuid = accessory.UUID;
    let services = accessory.services.map((service) => [service.UUID, service.subtype]);
    selected = 'DEVICE_REPLACEMENT';
    await flow.send(selected, { fixture: { replacement: true } });
    assert.equal(flow.device.accessory, accessory);
    assert.equal(accessory.UUID, uuid);
    assert.deepEqual(
      accessory.services.map((service) => [service.UUID, service.subtype]),
      services,
    );
    assert.equal(flow.device.deviceData.nest_google_device_uuid, selected);
    assert.equal(flow.registered.length, 1);
  });
}

for (let source of [DATA_SOURCE.PROTOBUF, DATA_SOURCE.HOMEGRAPH]) {
  test('System delivers accepted ' + source + ' deltas after discovery without replacing the accessory', async (context) => {
    let selected = 'DEVICE_TEST';
    let flow = await platformHarness(context, {
      map: (raw) => ({
        FIXTURE: { full: true, data: { ...data, nest_google_device_uuid: selected, reading: raw[selected]?.value.fixture?.reading } },
      }),
    });
    selected = source === DATA_SOURCE.HOMEGRAPH ? getResourceKey('account', source, 'DEVICE_TEST') : selected;
    let accessory = flow.device.accessory;
    for (let reading of ['cooling', 'off']) {
      await flow.sendBatch({
        source,
        isCurrent: () => true,
        changes: [{ resourceId: 'DEVICE_TEST', value: { fixture: { reading } }, fields: new Set(['fixture']) }],
      });
      assert.equal(flow.raw[selected].source, source);
      assert.equal(flow.device.deviceData.reading, reading);
      assert.equal(flow.device.accessory, accessory);
    }
    assert.equal(flow.registered.length, 1);
    await flow.sendBatch({
      source,
      isCurrent: () => false,
      changes: [{ resourceId: 'DEVICE_TEST', value: { fixture: { reading: 'stale' } }, fields: new Set(['fixture']) }],
    });
    assert.equal(flow.device.deviceData.reading, 'off');
  });
}

test('HomeGraph native IDs are scoped by account/source/kind and routed without cache keys', async (context) => {
  let selected = 'DEVICE_TEST';
  let flow = await platformHarness(context, {
    type: DEVICE_TYPE.CAMERA,
    map: (raw) => (raw[selected] === undefined ? {} : { FIXTURE: { full: true, data: { ...data, nest_google_device_uuid: selected } } }),
  });
  let accessory = flow.device.accessory;
  let services = accessory.services.map((service) => [service.UUID, service.subtype]);
  let homegraph = { get: context.mock.fn(async () => 'reading'), set: context.mock.fn(async () => {}) };
  flow.connection.homegraphAPI = homegraph;
  flow.accounts.set('other', { authorised: true, homegraphAPI: { set: context.mock.fn() } });
  let nativeId = 'DEVICE_TEST';
  let primary = getResourceKey('account', DATA_SOURCE.HOMEGRAPH, nativeId);
  let foreign = getResourceKey('other', DATA_SOURCE.HOMEGRAPH, nativeId);
  let home = getResourceKey('account', DATA_SOURCE.HOMEGRAPH, nativeId, 'STRUCTURE');
  let batch = (kind = 'DEVICE') => ({
    source: DATA_SOURCE.HOMEGRAPH,
    isCurrent: () => true,
    changes: [{ resourceId: nativeId, kind, value: { fixture: { active: true } }, fields: new Set(['fixture']) }],
  });
  selected = primary;
  await flow.sendBatch(batch());
  await flow.sendBatch(batch(), 'other');
  await flow.sendBatch(batch('STRUCTURE'));
  assert.equal(flow.raw.DEVICE_TEST.source, DATA_SOURCE.PROTOBUF);
  assert.equal(flow.raw[primary].connection, 'account');
  assert.equal(flow.raw[foreign].connection, 'other');
  assert.equal(flow.raw[home].source, DATA_SOURCE.HOMEGRAPH);
  assert.equal(flow.raw[primary].resourceId, nativeId);
  assert.equal(flow.device.deviceData.apiAccess.resourceId, nativeId);
  assert.equal(flow.device.accessory, accessory);
  assert.equal(flow.registered.length, 1);
  assert.deepEqual(
    accessory.services.map((service) => [service.UUID, service.subtype]),
    services,
  );
  await flow.device.set({ uuid: primary, streaming_enabled: false });
  assert.deepEqual(homegraph.set.mock.calls[0].arguments, [nativeId, { streaming_enabled: false }]);
  assert.deepEqual(await flow.device.get({ uuid: primary, camera_snapshot: true }), { uuid: primary, camera_snapshot: 'reading' });
  assert.equal(homegraph.get.mock.calls[0].arguments[0], nativeId);
  await assert.rejects(flow.device.set({ uuid: foreign, streaming_enabled: false }), /authorised device account/);
  await flow.sendBatch(
    {
      source: DATA_SOURCE.HOMEGRAPH,
      isCurrent: () => true,
      changes: [{ resourceId: nativeId, kind: 'DEVICE', remove: true, notify: true }],
    },
    'other',
  );
  assert.equal(flow.raw[foreign], undefined);
  assert.notEqual(flow.raw[primary], undefined);
  assert.notEqual(flow.raw.DEVICE_TEST, undefined);
  assert.equal(flow.removed.length, 0);
});

for (let fallback of ['complete', 'partial', 'absent']) {
  test('selected HomeGraph lock removal reconciles ' + fallback + ' protobuf fallback', async (context) => {
    let protobuf = structuredClone(fixtures.find((entry) => entry.name === 'lock').value);
    protobuf.device_identity.serialNumber = 'LOCKTEST';
    let flow = await platformHarness(context, {
      type: DEVICE_TYPE.LOCK,
      value: protobuf,
      map: (raw, changed) => mapLock(undefined, raw, { options: {} }, undefined, changed),
      onAdd: (device) => device.addService(hap.Service.LockMechanism, '', 1),
    });
    await flow.send('STRUCTURE_HOME', { fixture: {} });
    let accessory = flow.device.accessory;
    let service = accessory.getService(hap.Service.LockMechanism);
    let device = {
      structureId: 'home',
      technicalInformation: { serialNumber: 'LOCKTEST' },
      googleHome: {
        id: { googleUuid: 'lock', thirdPartyId: { idType: 'nest-home-assistant-prod' } },
        type: 'action.devices.types.LOCK', displayName: 'Front Door', hardware: { softwareVersion: '1.2.3' },
      },
      'deviceStatus.online': { boolean: true },
      'lockUnlock.isLocked': { boolean: true },
      'charging.capacityRemainingPercentage': { number: 80 },
    };
    await flow.sendBatch({ source: DATA_SOURCE.HOMEGRAPH, isCurrent: () => true, changes: [
      { resourceId: 'home', kind: 'STRUCTURE', value: { home: { uuid: 'home', name: 'Test' } }, fields: new Set(['home']) },
      { resourceId: 'lock', kind: 'DEVICE', value: device, fields: new Set(Object.keys(device)) },
    ] });
    assert.equal(flow.device.deviceData.nest_google_device_uuid, getResourceKey('account', DATA_SOURCE.HOMEGRAPH, 'lock'));
    if (fallback === 'partial') {
      delete flow.raw.DEVICE_TEST.value.battery_power_source;
    } else if (fallback === 'absent') {
      delete flow.raw.DEVICE_TEST;
    }
    let set = context.mock.method(flow.connection.googleProtobufAPI, 'set', async () => {});
    await flow.sendBatch({ source: DATA_SOURCE.HOMEGRAPH, isCurrent: () => true,
      changes: [{ resourceId: 'lock', kind: 'DEVICE', remove: true, notify: true }],
    });
    assert.equal(flow.registered.length, 1);
    if (fallback === 'complete') {
      assert.equal(flow.removed.length, 0);
      assert.equal(flow.device.accessory, accessory);
      assert.equal(accessory.getService(hap.Service.LockMechanism), service);
      assert.equal(flow.device.deviceData.nest_google_device_uuid, 'DEVICE_TEST');
      await flow.device.set({ uuid: 'DEVICE_TEST', bolt_lock: false });
      assert.deepEqual(set.mock.calls[0].arguments, ['DEVICE_TEST', { bolt_lock: false }]);
    } else {
      assert.deepEqual(flow.removed, [accessory]);
      assert.equal(set.mock.callCount(), 0);
    }
  });
}

for (let restored of [false, true]) {
  test('coalesced removal survives pending delivery; restored=' + restored, async (context) => {
    let flow = await platformHarness(context, {
      map: (raw) => raw.DEVICE_TEST === undefined ? {} : {
        FIXTURE: { full: true, data: { ...data, reading: raw.DEVICE_TEST.value.fixture?.reading } },
      },
    });
    let accessory = flow.device.accessory;
    let release = Promise.withResolvers();
    let started = Promise.withResolvers();
    let original = HomeKitDevice.message;
    let blocked = true;
    context.after(() => release.resolve());
    context.mock.method(HomeKitDevice, 'message', async (...args) => {
      if (args[1] === HomeKitDevice.UPDATE && blocked === true) {
        blocked = false;
        started.resolve();
        await release.promise;
      }
      return original.apply(HomeKitDevice, args);
    });
    await flow.send('DEVICE_TEST', { fixture: { reading: 'busy' } });
    await started.promise;
    await flow.sendBatch({ source: DATA_SOURCE.PROTOBUF, isCurrent: () => true,
      changes: [{ resourceId: 'DEVICE_TEST', remove: true, notify: true }],
    });
    // Another queued batch must not discard the removal marker for this resource.
    await flow.sendBatch({ source: DATA_SOURCE.PROTOBUF, isCurrent: () => true, changes: [
      restored === true
        ? { resourceId: 'DEVICE_TEST', value: { fixture: { reading: 'restored' } }, fields: new Set(['fixture']) }
        : { resourceId: 'DEVICE_TEST', remove: true, notify: false },
    ] });
    assert.equal(flow.removed.length, 0, 'removal belongs to the existing delivery worker');
    release.resolve();
    await setImmediate();
    await setImmediate();
    assert.equal(flow.registered.length, 1);
    if (restored === true) {
      assert.equal(flow.removed.length, 0);
      assert.equal(flow.device.accessory, accessory);
      assert.equal(flow.device.deviceData.reading, 'restored');
    } else {
      assert.deepEqual(flow.removed, [accessory]);
    }
  });
}

for (let [type, removedSource] of [[DEVICE_TYPE.CAMERA, DATA_SOURCE.PROTOBUF], [DEVICE_TYPE.THERMOSTAT, DATA_SOURCE.HOMEGRAPH]]) {
  test('cached ' + type + ' keeps its services when ' + removedSource + ' disappears', async (context) => {
    let uuid = HomeKitDevice.generateUUID('platform-harness', { version: 2.7, hap }, 'FIXTURE');
    let cached = new hap.Accessory('Cached fixture', uuid);
    let serviceType = type === DEVICE_TYPE.CAMERA ? hap.Service.MotionSensor : hap.Service.Thermostat;
    let service = cached.addService(serviceType, '', 1);
    let homegraphId = getResourceKey('account', DATA_SOURCE.HOMEGRAPH, 'alternate');
    let flow = await platformHarness(context, {
      type,
      cachedAccessories: [cached],
      onAdd: (device) => device.addService(serviceType, '', 1),
      map: (raw, changed) => {
        let preferred = removedSource === DATA_SOURCE.PROTOBUF ? 'DEVICE_TEST' : homegraphId;
        let fallback = preferred === 'DEVICE_TEST' ? homegraphId : 'DEVICE_TEST';
        let selected = raw[preferred] === undefined ? fallback : preferred;
        return raw[selected] === undefined || (changed instanceof Map && changed.has(selected) === false)
          ? {}
          : { FIXTURE: { full: true, data: { ...data, nest_google_device_uuid: selected } } };
      },
    });
    let homegraph = { set: context.mock.fn(async () => {}) };
    flow.connection.homegraphAPI = homegraph;
    await flow.sendBatch({ source: DATA_SOURCE.HOMEGRAPH, isCurrent: () => true, changes: [
      { resourceId: 'alternate', kind: 'DEVICE', value: { fixture: {} }, fields: new Set(['fixture']) },
    ] });
    let services = cached.services.map((item) => [item.UUID, item.subtype]);
    await flow.sendBatch({ source: removedSource, isCurrent: () => true, changes: [
      { resourceId: removedSource === DATA_SOURCE.PROTOBUF ? 'DEVICE_TEST' : 'alternate', kind: 'DEVICE', remove: true, notify: true },
    ] });
    assert.equal(flow.device.accessory, cached);
    assert.equal(cached.UUID, uuid);
    assert.equal(cached.getService(serviceType), service);
    assert.deepEqual(cached.services.map((item) => [item.UUID, item.subtype]), services);
    assert.equal(flow.removed.length, 0);
    assert.equal(flow.registered.length, 0, 'the cached accessory must not be registered again');
    if (removedSource === DATA_SOURCE.PROTOBUF) {
      assert.equal(flow.device.deviceData.nest_google_device_uuid, homegraphId);
      assert.equal(flow.device.deviceData.apiAccess.resourceId, 'alternate');
      await flow.device.set({ uuid: homegraphId, streaming_enabled: true });
      assert.deepEqual(homegraph.set.mock.calls[0].arguments, ['alternate', { streaming_enabled: true }]);
    } else {
      assert.equal(flow.device.deviceData.nest_google_device_uuid, 'DEVICE_TEST');
    }
  });
}
