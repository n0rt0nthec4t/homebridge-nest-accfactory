// Exercise the verified generic lock trait schema with fabricated identities.
// No physical lock capture or device commands are used by these mapping tests.
import { getResourceKey } from '../src/utils.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { importSource } from './helpers/import-source.js';
import { fixtures } from './helpers/discovery-fixtures.js';
import { DATA_SOURCE, LOW_BATTERY_LEVEL } from '../src/consts.js';

let { processRawData } = await importSource(new URL('../src/plugins/lock.js', import.meta.url));
const deviceId = getResourceKey('account', 'HomeGraph', 'lock');
const homeId = getResourceKey('account', 'HomeGraph', 'home', 'STRUCTURE');
function fixture() {
  return {
    [homeId]: {
      source: DATA_SOURCE.HOMEGRAPH,
      connection: 'account',
      value: { home: { uuid: 'home', rooms: [{ uuid: 'room', name: 'Entrance' }] } },
    },
    [deviceId]: {
      source: DATA_SOURCE.HOMEGRAPH,
      connection: 'account',
      value: {
        structureId: 'home',
        roomId: 'room',
        technicalInformation: { serialNumber: 'LOCKTEST' },
        googleHome: {
          id: { googleUuid: 'lock', thirdPartyId: { idType: 'nest-home-assistant-prod' } },
          type: 'action.devices.types.LOCK',
          displayName: 'Front Door',
          hardware: { softwareVersion: '1.2-3' },
        },
        'deviceStatus.online': { boolean: true },
        'lockUnlock.isLocked': { boolean: true },
        'lockUnlock.isJammed': { boolean: false },
        'charging.capacityRemainingPercentage': { number: 80 },
      },
    },
  };
}
function map(raw, changed) {
  return processRawData(undefined, raw, { options: {} }, undefined, changed)?.LOCKTEST;
}

test('HomeGraph locks are complete without optional tamper and auto-relock data', () => {
  let raw = fixture();
  let before = structuredClone(raw);
  let result = map(raw);
  assert.equal(result.full, true);
  assert.equal(result.data.serialNumber, 'LOCKTEST');
  assert.equal(result.data.nest_google_device_uuid, deviceId);
  assert.equal(result.data.nest_google_home_uuid, homeId);
  assert.equal(result.data.softwareVersion, '1.2.3');
  assert.equal(result.data.description, 'Front Door - Entrance');
  assert.equal(result.data.online, true);
  assert.equal(result.data.bolt_state, 'locked');
  assert.equal(result.data.battery_level, 80);
  for (let field of ['bolt_actor', 'tampered', 'auto_relock_duration', 'max_auto_relock_duration']) {
    assert.equal(result.data[field], null);
  }
  for (let field of ['source', 'googleHome']) {
    assert.equal(result.data[field], undefined);
  }
  assert.deepEqual(raw, before);
});

for (let [locked, jammed, expected] of [
  [true, false, 'locked'],
  [false, false, 'unlocked'],
  [true, true, 'jammed'],
  [false, true, 'jammed'],
  [undefined, true, 'jammed'],
  [undefined, false, undefined],
  ['true', false, undefined],
  [false, undefined, 'unlocked'],
]) {
  test('HomeGraph lock maps explicit bolt state: ' + JSON.stringify([locked, jammed]), () => {
    let raw = fixture();
    raw[deviceId].value['lockUnlock.isLocked'] = { boolean: locked };
    raw[deviceId].value['lockUnlock.isJammed'] = { boolean: jammed };
    raw[deviceId].value['lockUnlock.actorName'] = { text: 'Someone' };
    let result = map(raw, new Map([[deviceId, { fields: new Set(['lockUnlock.isLocked']) }]]));
    assert.equal(result.data.bolt_state, expected);
    assert.equal(result.data.bolt_actor, null);
    assert.equal(result.full, expected !== undefined);
  });
}

for (let [level, capacity, expected] of [
  [0, 'full', 0],
  [75.5, 'low', 76],
  [undefined, 'high', 75],
  [-1, 'low', LOW_BATTERY_LEVEL],
  [101, 'critically_low', Math.floor(LOW_BATTERY_LEVEL / 2)],
  ['80', 'medium', 50],
  [NaN, 'full', 100],
  [undefined, 'unknown', undefined],
]) {
  test('HomeGraph lock battery uses percentage units and known categories: ' + JSON.stringify([level, capacity]), () => {
    let raw = fixture();
    raw[deviceId].value['charging.capacityRemainingPercentage'] = { number: level };
    raw[deviceId].value['charging.descriptiveCapacityRemaining'] = { text: capacity };
    assert.equal(map(raw).data.battery_level, expected);
  });
}

test('HomeGraph locks require own home, Nest provider and physical serial', () => {
  for (let change of [
    (raw) => {
      delete raw[homeId];
    },
    (raw) => {
      raw[homeId].connection = 'foreign';
    },
    (raw) => {
      raw[homeId].source = DATA_SOURCE.PROTOBUF;
    },
    (raw) => {
      raw[deviceId].value.googleHome.id.thirdPartyId.idType = 'unrelated-provider';
    },
    (raw) => {
      raw[deviceId].value.googleHome.type = 'action.devices.types.SENSOR';
    },
    (raw) => {
      delete raw[deviceId].value.technicalInformation;
    },
  ]) {
    let raw = fixture();
    change(raw);
    assert.equal(map(raw), undefined);
  }
  assert.equal(map(fixture(), new Map([['foreign', {}]])), undefined);
  assert.equal(map(fixture(), new Map([[homeId, {}]])).full, true);
  let raw = fixture();
  raw[deviceId].value['deviceStatus.online'].boolean = false;
  delete raw[deviceId].value.googleHome.hardware.softwareVersion;
  assert.equal(map(raw).data.online, false);
  assert.equal(map(raw).data.softwareVersion, undefined);
});

for (let reverse of [false, true]) {
  test('lock fields prefer HomeGraph, fall back individually and preserve writable capabilities, reverse=' + reverse, () => {
    let raw = fixture();
    let protobuf = fixtures.find((entry) => entry.name === 'lock');
    raw.STRUCTURE_HOME = { source: DATA_SOURCE.PROTOBUF, value: {} };
    raw.DEVICE_PROTO = { source: DATA_SOURCE.PROTOBUF, value: structuredClone(protobuf.value) };
    raw.DEVICE_PROTO.value.device_identity.serialNumber = 'LOCKTEST';
    raw.DEVICE_PROTO.value.bolt_lock.boltLockActor = { method: 'BOLT_LOCK_ACTOR_METHOD_KEYPAD_PIN' };
    if (reverse === true) {
      raw = Object.fromEntries(Object.entries(raw).reverse());
    }
    let result = map(raw);
    assert.equal(result.full, true);
    assert.equal(result.data.nest_google_device_uuid, deviceId);
    assert.equal(result.data.bolt_actor, null, 'a protobuf actor must not describe HomeGraph state');
    assert.equal(result.data.tampered, null);
    assert.equal(result.data.auto_relock_duration, null);
    assert.equal(result.data.max_auto_relock_duration, null);
    raw[deviceId].value['lockUnlock.isLocked'].boolean = false;
    let update = map(raw, new Map([['DEVICE_PROTO', {}]])).data;
    assert.equal(update.bolt_state, 'unlocked');
    assert.equal(update.nest_google_device_uuid, deviceId);
    assert.equal(update.nest_google_home_uuid, homeId);
    assert.equal(update.auto_relock_duration, null);
    delete raw[deviceId].value['charging.capacityRemainingPercentage'];
    let fallback = map(raw);
    assert.equal(fallback.full, true);
    assert.equal(fallback.data.nest_google_device_uuid, deviceId);
    assert.equal(fallback.data.auto_relock_duration, null);
    assert.equal(fallback.data.max_auto_relock_duration, null);
    delete raw[deviceId].value.technicalInformation;
    fallback = map(raw);
    assert.equal(fallback.data.nest_google_device_uuid, 'DEVICE_PROTO');
    assert.equal(fallback.data.bolt_actor, 'keypad');
    assert.equal(fallback.data.auto_relock_duration, 60);
    assert.equal(fallback.data.max_auto_relock_duration, 300);
  });
}

for (let [method, expected] of [
  ['PHYSICAL', 'physical'], ['KEYPAD_PIN', 'keypad'],
  ['REMOTE_USER_EXPLICIT', 'remote'], ['REMOTE_USER_IMPLICIT', 'remote'],
  ['REMOTE_USER_OTHER', 'remote'], ['REMOTE_DELEGATE', 'remote'],
  ['VOICE_ASSISTANT', 'voice'], ['LOCAL_IMPLICIT', 'implicit'],
  ['LOW_POWER_SHUTDOWN', null], ['UNSPECIFIED', null], ['OTHER', null],
]) {
  test('protobuf lock actor method ' + method, () => {
    let protobuf = fixtures.find((entry) => entry.name === 'lock');
    let raw = {
      STRUCTURE_HOME: { source: DATA_SOURCE.PROTOBUF, value: {} },
      DEVICE_PROTO: { source: DATA_SOURCE.PROTOBUF, value: structuredClone(protobuf.value) },
    };
    raw.DEVICE_PROTO.value.device_identity.serialNumber = 'LOCKTEST';
    raw.DEVICE_PROTO.value.bolt_lock.boltLockActor = { method: 'BOLT_LOCK_ACTOR_METHOD_' + method };
    assert.equal(map(raw).data.bolt_actor, expected);
    delete raw.DEVICE_PROTO.value.bolt_lock.boltLockActor;
    assert.equal(map(raw).data.bolt_actor, null, 'missing actors clear previously committed methods');
  });
}
