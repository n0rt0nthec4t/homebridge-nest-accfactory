// Verify chime override, Quiet Time precedence, cooldown and retired switch cleanup without media or network services.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { URL } from 'node:url';
import { TIMERS } from '../../src/consts.js';

// Replace only the camera boundary so the real doorbell hooks and field map run unchanged.
let cameraModule =
  'data:text/javascript,' +
  encodeURIComponent(
    'export default class { constructor(data) { this.deviceData = data; } }' +
      'export function processRawData(log, raw, config, type, changed, map) { return map; }',
  );
let location = new URL('../../src/plugins/doorbell.js', import.meta.url);
let source = (await readFile(location, 'utf8')).replace(/from '([^']+)'/g, (match, specifier) => {
  return 'from ' + JSON.stringify(specifier === './camera.js' ? cameraModule : new URL(specifier, location).href);
});
let { default: Doorbell, processRawData } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

function setup(t, data = {}, cached = new Map()) {
  let doorbell = new Doorbell({
    description: 'Front door',
    nest_google_device_uuid: 'doorbell',
    doorbellCooldown: 60,
    quiet_time_ends: 0,
    indoor_chime_enabled: true,
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

for (let chimeEnabled of [true, false]) {
  for (let override of [undefined, false, true]) {
    for (let quietTime of [false, true]) {
      test('doorbell delivery: chime=' + chimeEnabled + ', override=' + override + ', quiet=' + quietTime, async (t) => {
        let doorbell = setup(t, {
          indoor_chime_enabled: chimeEnabled,
          ignoreIndoorChime: override,
          quiet_time_ends: quietTime === true ? Date.now() / 1000 + 600 : 0,
        });
        let update = { ...doorbell.deviceData, events: [{ types: ['doorbell'] }] };
        let expectedRings = quietTime === false && (chimeEnabled === true || override === true) ? 1 : 0;
        doorbell.onUpdate(update);
        doorbell.onUpdate(update);
        assert.equal(doorbell.controller.ringDoorbell.mock.callCount(), expectedRings);
        assert.equal(doorbell.history.mock.callCount(), 2);
        await doorbell.onTimer({ timer: TIMERS.DOORBELL_COOLDOWN.name });
        doorbell.onUpdate(update);
        assert.equal(doorbell.controller.ringDoorbell.mock.callCount(), expectedRings * 2);
        assert.equal(doorbell.history.mock.callCount(), 4);
      });
    }
  }
}

test('active Quiet Time suppresses rings without a switch or expiry timer', (t) => {
  let doorbell = setup(t, { quiet_time_ends: Date.now() / 1000 + 600 });
  doorbell.onUpdate({ ...doorbell.deviceData, events: [{ types: ['doorbell'] }] });
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
  doorbell.onUpdate({ ...doorbell.deviceData, events: [{ types: ['doorbell'] }] });
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

test('Quiet Time mappings retain Google and Nest expiry', () => {
  let map = processRawData();
  let raw = { value: { quiet_time_settings: { quietTimeEnds: { seconds: '12345' } } } };
  assert.equal(map.quiet_time_ends.google.translate({ raw }), 12345);
  assert.equal(map.quiet_time_ends.google.translate({ raw: { value: {} } }), 0);
  let nestRaw = { value: { properties: { 'doorbell.quiet_time.enabled_until': '12345' } } };
  assert.equal(map.quiet_time_ends.nest.translate({ raw: nestRaw }), 12345);
  nestRaw.value.properties['doorbell.quiet_time.enabled_until'] = 0;
  assert.equal(map.quiet_time_ends.nest.translate({ raw: nestRaw }), 0);
  assert.equal(map.quiet_time_ends.nest.translate({ raw: { value: {} } }), 0);
});
