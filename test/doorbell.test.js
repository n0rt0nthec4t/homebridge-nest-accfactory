// Verify Quiet Time suppression, chime-independent ringing, cooldown and retired switch cleanup without media or network services.
import assert from 'node:assert/strict';
import { importSource } from './helpers/import-source.js';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { URL } from 'node:url';
import { TIMERS } from '../src/consts.js';
import { buildMappedObject, createMappingContext, getMappedValue } from '../src/translator.js';

// Replace only the camera boundary so the real doorbell hooks and field map run unchanged.
let cameraModule =
  'data:text/javascript,' +
  encodeURIComponent(
    'export default class { constructor(data) { this.deviceData = data; } }' +
      'export function processRawData(log, raw, config, type, changed, map) { return map; }',
  );
let location = new URL('../src/plugins/doorbell.js', import.meta.url);
let source = (await readFile(location, 'utf8')).replace(/from '([^']+)'/g, (match, specifier) => {
  return 'from ' + JSON.stringify(specifier === './camera.js' ? cameraModule : new URL(specifier, location).href);
});
let { default: Doorbell, processRawData } = await importSource(location, source);

function setup(t, data = {}, cached = new Map()) {
  let doorbell = new Doorbell({
    description: 'Front door',
    nest_google_device_uuid: 'doorbell',
    doorbellCooldown: 60,
    quiet_time_ends: 0,
    ...data,
  });
  doorbell.hap = { Service: { Switch: { UUID: 'switch' } }, Characteristic: { On: 'on' } };
  for (let service of cached.values()) {
    service.UUID = 'switch';
  }
  doorbell.accessory = {
    services: [...cached.values()],
    getService: () => cached.values().next().value,
    getServiceById: (type, subtype) => cached.get(subtype),
  };
  doorbell.addService = t.mock.fn((type, name, subtype) => ({ name, subtype, updateCharacteristic: t.mock.fn() }));
  doorbell.removeService = t.mock.fn();
  doorbell.addCharacteristic = t.mock.fn((service, characteristic, callbacks) => {
    doorbell.callbacks = callbacks;
  });
  doorbell.postSetupDetail = t.mock.fn();
  doorbell.addTimer = t.mock.fn();
  doorbell.removeTimer = t.mock.fn();
  doorbell.set = t.mock.fn();
  doorbell.history = t.mock.fn();
  doorbell.controller = { ringDoorbell: t.mock.fn(), doorbellService: {} };
  return doorbell;
}

for (let chimeEnabled of [undefined, true, false]) {
  for (let override of [undefined, false, true]) {
    for (let quietTime of [false, true]) {
      test('doorbell delivery: chime=' + chimeEnabled + ', override=' + override + ', quiet=' + quietTime, async (t) => {
        let doorbell = setup(t, {
          indoor_chime_enabled: chimeEnabled,
          ignoreIndoorChime: override,
          quiet_time_ends: quietTime === true ? Date.now() / 1000 + 600 : 0,
        });
        let update = { ...doorbell.deviceData, events: [{ types: ['doorbell'], start_time: 1795640000000 }] };
        let expectedRings = quietTime === false ? 1 : 0;
        doorbell.onUpdate(update);
        doorbell.onUpdate(update);
        assert.equal(doorbell.controller.ringDoorbell.mock.callCount(), expectedRings);
        assert.equal(doorbell.history.mock.callCount(), 2);
        await doorbell.onTimer({ timer: TIMERS.DOORBELL_COOLDOWN.name });
        doorbell.onUpdate(update);
        assert.equal(doorbell.controller.ringDoorbell.mock.callCount(), expectedRings);
        assert.equal(doorbell.history.mock.callCount(), 2);
        update.events[0].start_time += 61000;
        doorbell.onUpdate(update);
        assert.equal(doorbell.controller.ringDoorbell.mock.callCount(), expectedRings * 2);
        assert.equal(doorbell.history.mock.callCount(), 4);
      });
    }
  }
}

test('active Quiet Time suppresses rings without a switch or expiry timer', (t) => {
  let doorbell = setup(t, { quiet_time_ends: Date.now() / 1000 + 600 });
  doorbell.onUpdate({ ...doorbell.deviceData, events: [{ types: ['doorbell'], start_time: 1795640000000 }] });
  assert.equal(doorbell.controller.ringDoorbell.mock.callCount(), 0);
  assert.equal(doorbell.history.mock.callCount(), 2);
  assert.equal(
    doorbell.addTimer.mock.calls.some((call) => call.arguments[0] !== TIMERS.DOORBELL_COOLDOWN.name),
    false,
  );
  assert.equal(doorbell.removeTimer.mock.callCount(), 0);
});

test('expired nonzero Quiet Time permits rings', (t) => {
  let doorbell = setup(t, { quiet_time_ends: Date.now() / 1000 - 1 });
  doorbell.onUpdate({ ...doorbell.deviceData, events: [{ types: ['doorbell'], start_time: 1795640000000 }] });
  assert.equal(doorbell.controller.ringDoorbell.mock.callCount(), 1);
});

test('retired chime and Quiet Time switches are removed without adding services or changing upstream settings', (t) => {
  let chime = {};
  let quiet = {};
  let doorbell = setup(
    t,
    {},
    new Map([
      [1, chime],
      [2, quiet],
    ]),
  );
  let other = { UUID: 'other' };
  doorbell.accessory.services.push(other);
  doorbell.onAdd();
  assert.deepEqual(
    doorbell.removeService.mock.calls.map((call) => call.arguments[0]),
    [chime, quiet],
  );
  assert.equal(doorbell.addService.mock.callCount(), 0);
  assert.equal(doorbell.addCharacteristic.mock.callCount(), 0);
  assert.equal(doorbell.set.mock.callCount(), 0);
});

test('Quiet Time mapping retains protobuf expiry without a Nest REST mapping', () => {
  let map = processRawData();
  let raw = { value: { quiet_time_settings: { quietTimeEnds: { seconds: '12345' } } } };
  assert.equal(map.quiet_time_ends.google.translate({ raw }), 12345);
  assert.equal(map.quiet_time_ends.google.translate({ raw: { value: {} } }), 0);
  assert.equal(map.quiet_time_ends.nest, undefined);
});

for (let [value, expected] of [
  [{}, undefined],
  [{ 'quietTime.quietTimeEnabled': { boolean: false } }, 0],
  [{ 'quietTime.quietTimeEnabled': { boolean: false }, 'quietTime.endTime': { number: 2000000000 } }, 0],
  [{ 'quietTime.quietTimeEnabled': { boolean: true }, 'quietTime.endTime': { number: 2000000000 } }, 2000000000],
  [{ 'quietTime.quietTimeEnabled': { boolean: true }, 'quietTime.endTime': { number: 1 } }, 1],
  [{ 'quietTime.quietTimeEnabled': { boolean: true } }, undefined],
  [{ 'quietTime.endTime': { number: 2000000000 } }, undefined],
  [{ 'quietTime.quietTimeEnabled': { text: 'true' }, 'quietTime.endTime': { number: 2000000000 } }, undefined],
  [{ 'quietTime.quietTimeEnabled': { boolean: true }, 'quietTime.endTime': { text: '2000000000' } }, undefined],
  [{ 'quietTime.quietTimeEnabled': { boolean: true }, 'quietTime.endTime': { number: -1 } }, undefined],
  [{ 'quietTime.quietTimeEnabled': { boolean: true }, 'quietTime.endTime': { number: NaN } }, undefined],
  [{ 'quietTime.quietTimeEnabled': { boolean: true }, 'quietTime.endTime': { number: Infinity } }, undefined],
]) {
  test('Google Home Quiet Time maps explicit state and valid seconds: ' + JSON.stringify(value), () => {
    let map = processRawData();
    assert.equal(getMappedValue(map.quiet_time_ends.googlehome, { raw: { value } }), expected);
  });
}

test('Google Home Quiet Time translates only when its own state or end time is included', () => {
  let map = processRawData();
  let context = createMappingContext({}, 'device', {
    googlehome: { value: { 'quietTime.quietTimeEnabled': { boolean: false }, 'quietTime.endTime': { number: 2000000000 } } },
  });
  assert.equal(Object.hasOwn(buildMappedObject(map, context, new Set(['deviceStatus.online'])).data, 'quiet_time_ends'), false);
  for (let field of ['quietTime.quietTimeEnabled', 'quietTime.endTime']) {
    assert.equal(buildMappedObject(map, context, new Set([field])).data.quiet_time_ends, 0);
  }
});

test('Google Home Quiet Time disable resumes ringing even when the expiry remains cached', async (context) => {
  let map = processRawData();
  let raw = {
    value: {
      'quietTime.quietTimeEnabled': { boolean: true },
      'quietTime.endTime': { number: Math.floor(Date.now() / 1000) + 600 },
    },
  };
  let doorbell = setup(context);
  doorbell.onUpdate({
    ...doorbell.deviceData,
    quiet_time_ends: getMappedValue(map.quiet_time_ends.googlehome, { raw }),
    events: [{ types: ['doorbell'], start_time: 1795640000000 }],
  });
  assert.equal(doorbell.controller.ringDoorbell.mock.callCount(), 0);
  await doorbell.onTimer({ timer: TIMERS.DOORBELL_COOLDOWN.name });
  raw.value['quietTime.quietTimeEnabled'].boolean = false;
  doorbell.onUpdate({
    ...doorbell.deviceData,
    quiet_time_ends: getMappedValue(map.quiet_time_ends.googlehome, { raw }),
    events: [{ types: ['doorbell'], start_time: 1795640000000 }],
  });
  assert.equal(doorbell.controller.ringDoorbell.mock.callCount(), 0);
  doorbell.onUpdate({
    ...doorbell.deviceData,
    quiet_time_ends: getMappedValue(map.quiet_time_ends.googlehome, { raw }),
    events: [{ types: ['doorbell'], start_time: 1795640061000 }],
  });
  assert.equal(doorbell.controller.ringDoorbell.mock.callCount(), 1);
  assert.equal(doorbell.history.mock.callCount(), 4);
  assert.equal(map.has_indoor_chime, undefined);
  assert.equal(map.indoor_chime_enabled, undefined);
});

test('doorbell history does not replay extended, older or cooldown-suppressed presses', async (t) => {
  let doorbell = setup(t);
  let press = (start, end = start) => doorbell.onUpdate({
    ...doorbell.deviceData, events: [{ id: String(start), types: ['doorbell'], start_time: start, end_time: end }],
  });
  press(1795640000);
  press(1795640010); // A distinct press suppressed during cooldown must stay suppressed.
  await doorbell.onTimer({ timer: TIMERS.DOORBELL_COOLDOWN.name });
  doorbell.onUpdate({ ...doorbell.deviceData, events: [] });
  press(1795640010000, 1795640090000); // Same press in milliseconds with an extended end.
  press(1795640000);
  assert.equal(doorbell.controller.ringDoorbell.mock.callCount(), 1);
  press(1795640100);
  assert.equal(doorbell.controller.ringDoorbell.mock.callCount(), 2);
  assert.equal(doorbell.history.mock.callCount(), 4);
});

test('retired physical chime fields do not participate in discovery', () => {
  let map = processRawData();
  assert.equal(map.has_indoor_chime, undefined);
  assert.equal(map.indoor_chime_enabled, undefined);
  let result = buildMappedObject(map, createMappingContext({}, 'device', { googlehome: { value: {} } }), new Set(['quietTime.endTime']));
  assert.equal(result.hasRequired, true);
});
