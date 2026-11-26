// Map verified HomeGraph Protect fields without inventing unknown alarm/test states.
import { getResourceKey } from '../src/utils.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { importSource } from './helpers/import-source.js';
import { protectHomeGraphFixture, protectSensorProperty } from './helpers/protect-homegraph-fixture.js';
import { DATA_SOURCE } from '../src/consts.js';

let { processRawData } = await importSource(new URL('../src/plugins/protect.js', import.meta.url));
function map(raw, changed) {
  return processRawData(
    undefined,
    raw,
    { options: {}, homes: [{ homegraph_home_uuid: getResourceKey('account', 'HomeGraph', 'home', 'STRUCTURE'), exclude: true }] },
    undefined,
    changed,
  )?.['06TESTPROTECT'];
}

test('HomeGraph Protect firmware must be device reported', () => {
  let raw = protectHomeGraphFixture();
  delete raw[getResourceKey('account', 'HomeGraph', 'protect')].value.googleHome.hardware.softwareVersion;
  let result = map(raw);
  assert.equal(result.data.softwareVersion, undefined);
  assert.equal(result.full, false);
});

for (let [code, name, battery] of [
  ['NEST_PROTECT_1_LINE.1', 'Protect (1st gen, wired)', false],
  ['NEST_PROTECT_1_BATTERY.1', 'Protect (1st gen, battery)', true],
  ['NEST_PROTECT_2_LINE.9', 'Protect (2nd gen, wired)', false],
  ['NEST_PROTECT_2_BATTERY.9', 'Protect (2nd gen, battery)', true],
]) {
  test('HomeGraph Protect model, capabilities and complete state: ' + code, () => {
    let raw = protectHomeGraphFixture(code);
    let before = structuredClone(raw);
    let result = map(raw);
    assert.equal(result.full, true);
    assert.equal(result.data.model, name);
    assert.equal(result.data.wired_or_battery, battery);
    assert.equal(result.data.serialNumber, '06TESTPROTECT');
    assert.equal(result.data.nest_google_device_uuid, getResourceKey('account', 'HomeGraph', 'protect'));
    assert.equal(result.data.nest_google_home_uuid, getResourceKey('account', 'HomeGraph', 'home', 'STRUCTURE'));
    assert.equal(result.data.smoke_status, false);
    assert.equal(result.data.co_status, false);
    assert.equal(result.data.hushed_state, false);
    assert.equal(result.data.battery_level, 100);
    assert.equal(result.data.battery_low, false);
    assert.equal(result.data.replacement_date, 1887519600);
    assert.equal(result.data.latest_alarm_test, 1785047209);
    assert.equal(result.data.excluded, true);
    for (let field of [
      'line_power_present',
      'heat_status',
      'smoke_test_passed',
      'co_test_passed',
      'self_test_in_progress',
      'ntp_green_led_enable',
      'detected_motion',
      'source',
      'googleHome',
    ]) {
      assert.equal(result.data[field], undefined, field + ' must remain unknown');
    }
    assert.deepEqual(raw, before);
  });
}

for (let [sensor, state, expected] of [
  [0, 'smoke detected', true],
  [0, 'high', true],
  [0, 'unknown', undefined],
  [1, 'carbon monoxide detected', true],
  [1, 'high', true],
  [1, 'medium', false],
  [1, 'low', false],
  [1, 'unknown', undefined],
]) {
  test('HomeGraph Protect alarm ' + sensor + '/' + state, () => {
    let raw = protectHomeGraphFixture();
    protectSensorProperty(raw, sensor, 'currentSensorState', state);
    protectSensorProperty(raw, sensor, 'alarmSilenceState', 'SILENCED');
    let result = map(raw);
    assert.equal(result.data[sensor === 0 ? 'smoke_status' : 'co_status'], expected);
    assert.equal(result.full, expected !== undefined);
    assert.equal(result.data.hushed_state, true, 'Silencing must not clear a detected alarm');
  });
}

for (let [capacity, level, low] of [
  ['full', 100, false],
  ['high', 75, false],
  ['medium', 50, false],
  ['low', 10, true],
  ['critically_low', 5, true],
  ['unknown', null, undefined],
]) {
  test('HomeGraph Protect qualitative battery ' + capacity, () => {
    let raw = protectHomeGraphFixture();
    raw[getResourceKey('account', 'HomeGraph', 'protect')].value['charging.descriptiveCapacityRemaining'] = { text: capacity };
    let result = map(raw).data;
    assert.equal(result.battery_level, level);
    assert.equal(result.battery_low, low);
    raw[getResourceKey('account', 'HomeGraph', 'protect')].value['charging.capacityRemainingPercentage'] = { number: 47 };
    assert.equal(map(raw).data.battery_level, 47);
    raw[getResourceKey('account', 'HomeGraph', 'protect')].value['charging.capacityRemainingPercentage'] = { number: NaN };
    assert.equal(map(raw).data.battery_level, level);
  });
}

test('HomeGraph Protect expiry, identity and unknown model fallback do not fabricate data', () => {
  let raw = protectHomeGraphFixture('NEST_PROTECT_FUTURE.1');
  assert.equal(map(raw).data.model, 'Nest Protect');
  delete raw[getResourceKey('account', 'HomeGraph', 'protect')].value.attributes.fields.supportedEnergySources;
  assert.equal(map(raw).data.wired_or_battery, undefined);
  for (let expiry of ['', 'nonsense', '-1', 'Infinity']) {
    raw[getResourceKey('account', 'HomeGraph', 'protect')].value.attributes.fields.expiryDate.stringValue = expiry;
    assert.equal(map(raw).full, false);
    assert.equal(map(raw).data.replacement_date, undefined);
  }
  delete raw[getResourceKey('account', 'HomeGraph', 'protect')].value.technicalInformation;
  assert.equal(map(raw), undefined);
});

test('HomeGraph Protect structure history is scoped to its home and updates independently', () => {
  let raw = protectHomeGraphFixture();
  let home = raw[getResourceKey('account', 'HomeGraph', 'home', 'STRUCTURE')];
  home.value.home.traits[0].fields.manualTest.structValue.fields.endTime.stringValue = '1785047999';
  assert.equal(map(raw, new Map([[getResourceKey('account', 'HomeGraph', 'home', 'STRUCTURE'), {}]])).data.latest_alarm_test, 1785047999);
  assert.equal(map(raw, new Map([['unrelated', {}]])), undefined);
  delete home.value.home.traits[0].fields.manualTest;
  assert.equal(map(raw).data.latest_alarm_test, undefined, 'Do not substitute the audio-test timestamp');
  home.connection = 'another-account';
  assert.equal(map(raw), undefined);
  home.connection = 'account';
  home.source = DATA_SOURCE.PROTOBUF;
  assert.equal(map(raw), undefined);
});

for (let order of ['protobuf-first', 'homegraph-first']) {
  test('HomeGraph Protect preference and incomplete fallback: ' + order, () => {
    let gh = protectHomeGraphFixture();
    let proto = {
      DEVICE_PROTO: {
        source: DATA_SOURCE.PROTOBUF,
        value: {
          device_identity: { serialNumber: '06TESTPROTECT', softwareVersion: '5.0' },
          device_info: { typeName: 'nest.resource.NestProtect2LinePoweredResource', pairerId: { resourceId: 'STRUCTURE_PROTO' } },
          configuration_done: { deviceReady: true },
          label: { label: 'Protect' },
          legacy_protect_device_settings: { replaceByDate: { seconds: '1887519600' } },
        },
      },
      STRUCTURE_PROTO: { value: {} },
    };
    let raw = order === 'protobuf-first' ? { ...proto, ...gh } : { ...gh, ...proto };
    assert.equal(map(raw).data.nest_google_device_uuid, getResourceKey('account', 'HomeGraph', 'protect'));
    assert.equal(map(raw, new Map([['DEVICE_PROTO', {}]])).data.nest_google_device_uuid, getResourceKey('account', 'HomeGraph', 'protect'));
    let preferred = raw[getResourceKey('account', 'HomeGraph', 'protect')].value;
    raw.DEVICE_PROTO.value.liveness = { status: 'LIVENESS_DEVICE_STATUS_ONLINE' };
    preferred['deviceStatus.online'].boolean = false;
    assert.equal(map(raw, new Map([['DEVICE_PROTO', {}]])).data.online, false);
    delete preferred.googleHome.hardware.softwareVersion;
    assert.equal(map(raw, new Map([['DEVICE_PROTO', {}]])).data.softwareVersion, '5.0.0');
    assert.equal(map(raw).data.nest_google_device_uuid, getResourceKey('account', 'HomeGraph', 'protect'));
    delete raw[getResourceKey('account', 'HomeGraph', 'protect')].value.technicalInformation;
    assert.equal(map(raw).data.nest_google_device_uuid, 'DEVICE_PROTO');
  });
}

for (let status of ['SELF_TEST_STATUS_COMPLETED', 'SELF_TEST_STATUS_UNSPECIFIED', undefined]) {
  test('HomeGraph Protect test progress maps only captured completed statuses: ' + status, () => {
    let raw = protectHomeGraphFixture();
    let fields = raw[getResourceKey('account', 'HomeGraph', 'home', 'STRUCTURE')].value.home.traits[0].fields;
    fields.audioTest.structValue.fields.status = { stringValue: status };
    let result = map(raw, new Map([[getResourceKey('account', 'HomeGraph', 'home', 'STRUCTURE'), {}]]));
    assert.equal(result.data.self_test_in_progress, status === 'SELF_TEST_STATUS_COMPLETED' ? false : undefined);
  });
}
