// Cover complete platform command routing without extracting or copying private methods.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DATA_SOURCE } from '../src/consts.js';
import { importSource } from './helpers/import-source.js';
import { platformHarness } from './helpers/platform-harness.js';
import GrpcTransport from '../src/grpctransport.js';

let { default: HomeGraphAPI } = await importSource(new URL('../src/api/homegraph.js', import.meta.url));

let traits = {
  eco_mode_state: { ecoMode: 'ECO_MODE_INACTIVE' },
  target_temperature_settings: {
    enabled: { value: true },
    targetTemperature: {
      setpointType: 'SET_POINT_TYPE_RANGE',
      heatingTarget: { value: 20 },
      coolingTarget: { value: 24 },
    },
  },
  display_settings: { retained: 'display' },
  temperature_lock_settings: {},
  fan_control_settings: { timerSpeed: 'FAN_SPEED_SETTING_STAGE2' },
  hvac_equipment_capabilities: { hasHotWaterControl: true, hasHotWaterTemperature: true, hasHumidifier: true, hasDehumidifier: true },
  hot_water_settings: { temperature: { value: 55 } },
  humidity_control_settings: {},
  related_resources: {
    relatedResources: {
      light: {
        resourceTypeName: { resourceName: 'google.resource.AzizResource' },
        resourceId: { resourceId: 'SERVICE_LIGHT' },
      },
    },
  },
  device_info: { typeName: 'google.resource.SpencerResource', pairerId: { resourceId: 'STRUCTURE_HOME' } },
};
for (let [values, label, expected] of [
  [{ hvac_mode: 'off' }, 'target_temperature_settings', { enabled: { value: false } }],
  [{ hvac_mode: 'heat' }, 'target_temperature_settings', { enabled: { value: true } }],
  [{ target_temperature_low: 21 }, 'target_temperature_settings', { targetTemperature: { heatingTarget: { value: 21 } } }],
  [{ target_temperature_high: 26 }, 'target_temperature_settings', { targetTemperature: { coolingTarget: { value: 26 } } }],
  [{ temperature_scale: 'f' }, 'display_settings', { temperatureScale: 'TEMPERATURE_SCALE_F', retained: 'display' }],
  [{ temperature_scale: 'C' }, 'display_settings', { temperatureScale: 'TEMPERATURE_SCALE_C' }],
  [{ temperature_lock: true }, 'temperature_lock_settings', { enabled: true }],
  [{ temperature_lock: false }, 'temperature_lock_settings', { enabled: false }],
  [
    { fan_state: false, fan_duration: 60, fan_timer_speed: 0 },
    'fan_control_settings',
    { timerEnd: { seconds: 0, nanos: 0 }, timerSpeed: 'FAN_SPEED_SETTING_STAGE2' },
  ],
  [{ fan_timer_speed: 3 }, 'fan_control_settings', { timerSpeed: 'FAN_SPEED_SETTING_STAGE3' }],
  [{ fan_timer_speed: 0 }, 'fan_control_settings', { timerSpeed: 'FAN_SPEED_SETTING_STAGE2' }],
  [{ streaming_enabled: true }, 'recording_toggle_settings', { targetCameraState: 'CAMERA_ON', changeModeReason: 2 }],
  [{ streaming_enabled: false }, 'recording_toggle_settings', { targetCameraState: 'CAMERA_OFF' }],
  [{ audio_enabled: true }, 'microphone_settings', { enableMicrophone: true }],
  [{ audio_enabled: false }, 'microphone_settings', { enableMicrophone: false }],
  [{ light_brightness: 70 }, 'floodlight_settings', { brightness: 7 }],
  [{ hot_water_boost_active: { state: false } }, 'hot_water_settings', { boostTimerEnd: { seconds: 0, nanos: 0 } }],
  [{ hot_water_temperature: 60 }, 'hot_water_settings', { temperature: { value: 60 } }],
  [{ auto_relock_duration: 120 }, 'bolt_lock_settings', { autoRelockDuration: { seconds: 120 } }],
  [{ humidifier_state: true }, 'humidity_control_settings', { humidifierTargetHumidity: { enabled: true } }],
  [{ dehumidifier_state: false }, 'humidity_control_settings', { dehumidifierTargetHumidity: { enabled: false } }],
  [{ target_humidity_humidifier: 40 }, 'humidity_control_settings', { humidifierTargetHumidity: { value: 40 } }],
  [{ target_humidity_dehumidifier: 65 }, 'humidity_control_settings', { dehumidifierTargetHumidity: { value: 65 } }],
]) {
  test('platform SET ' + JSON.stringify(values) + ' updates ' + label, async (context) => {
    let flow = await platformHarness(context, { value: traits });
    let before = structuredClone(flow.raw.DEVICE_TEST.value);
    await flow.device.set({ uuid: 'DEVICE_TEST', ...values });
    assert.equal(flow.commands.length, 1);
    let [namespace, service, method, request] = flow.commands[0];
    assert.deepEqual([namespace, service, method], ['nestlabs.gateway.v1.', 'TraitBatchApi', 'BatchUpdateState']);
    let update = request.batchUpdateStateRequest[0];
    assert.equal(update.traitRequest.resourceId, 'DEVICE_TEST');
    assert.equal(update.traitRequest.traitLabel, label);
    assert.partialDeepStrictEqual(update.state.value, expected);
    assert.deepEqual(flow.raw.DEVICE_TEST.value, before, 'commands must not mutate the Observe cache');
  });
}
for (let [values, label, resource, expected] of [
  [{ bolt_lock: true }, 'bolt_lock', 'DEVICE_TEST', { state: 'BOLT_STATE_EXTENDED' }],
  [{ bolt_lock: false }, 'bolt_lock', 'DEVICE_TEST', { state: 'BOLT_STATE_RETRACTED' }],
  [{ light_enabled: true }, 'on_off', 'SERVICE_LIGHT', { on: true }],
  [{ light_enabled: false }, 'on_off', 'SERVICE_LIGHT', { on: false }],
  [{ vacation_mode: true }, 'structure_mode', 'STRUCTURE_HOME', { structureMode: 'STRUCTURE_MODE_VACATION' }],
  [{ vacation_mode: false }, 'structure_mode', 'STRUCTURE_HOME', { structureMode: 'STRUCTURE_MODE_HOME' }],
]) {
  test('platform SET ' + JSON.stringify(values) + ' commands ' + resource, async (context) => {
    let flow = await platformHarness(context, { value: traits });
    await flow.device.set({ uuid: 'DEVICE_TEST', ...values });
    let request = flow.commands[0][3];
    assert.equal(flow.commands[0][2], 'SendCommand');
    assert.equal(request.resourceRequest.resourceId, resource);
    assert.equal(request.resourceCommands[0].traitLabel, label);
    assert.partialDeepStrictEqual(request.resourceCommands[0].command.value, expected);
  });
}
for (let enabled of [true, false]) {
  test('platform sensor selection routes to parent, selected=' + enabled, async (context) => {
    let flow = await platformHarness(context, { value: { device_identity: { serialNumber: 'SENSOR' } } });
    await flow.send('DEVICE_PARENT', {
      remote_comfort_sensing_settings: {
        retained: true,
        associatedRcsSensors: [{ deviceId: { resourceId: 'DEVICE_TEST' } }],
        activeRcsSelection: { activeRcsSensor: { resourceId: 'DEVICE_TEST' } },
      },
    });
    await flow.device.set({ uuid: 'DEVICE_TEST', active_sensor: enabled });
    let request = flow.commands[0][3].batchUpdateStateRequest[0];
    assert.equal(request.traitRequest.resourceId, 'DEVICE_PARENT');
    assert.deepEqual(
      request.state.value.activeRcsSelection,
      enabled === true
        ? { rcsSourceType: 'RCS_SOURCE_TYPE_SINGLE_SENSOR', activeRcsSensor: { resourceId: 'DEVICE_TEST' } }
        : { rcsSourceType: 'RCS_SOURCE_TYPE_BACKPLATE' },
    );
  });
}

for (let [heat, cool, key] of [
  [true, false, 'target_temperature', 22, 27],
  [false, true, 'target_temperature', 17, 22],
  [true, true, 'target_temperature_low', 22, 27],
  [true, true, 'target_temperature_high', 17, 22],
]) {
  test('direct Eco temperature SET rejects ' + key + ', heat=' + heat + ', cool=' + cool, async (context) => {
    let flow = await platformHarness(context, {
      value: {
        ...traits,
        eco_mode_state: { ecoMode: 'ECO_MODE_MANUAL_ECO' },
        eco_mode_settings: {
          ecoTemperatureHeat: { enabled: heat, value: { value: 17 } },
          ecoTemperatureCool: { enabled: cool, value: { value: 27 } },
        },
      },
    });
    let before = structuredClone(flow.raw.DEVICE_TEST.value);
    await assert.rejects(
      flow.device.set({ uuid: 'DEVICE_TEST', [key]: 22 }),
      (error) => error instanceof AggregateError && error.errors[0].code === 'ERR_ECO_TEMPERATURE_READ_ONLY',
    );
    assert.deepEqual(flow.commands, []);
    assert.deepEqual(flow.raw.DEVICE_TEST.value, before);
    await flow.send('DEVICE_TEST', { eco_mode_state: { ecoMode: 'ECO_MODE_INACTIVE' } });
    await flow.device.set({ uuid: 'DEVICE_TEST', [key]: 22 });
    assert.equal(flow.commands[0][3].batchUpdateStateRequest[0].traitRequest.traitLabel, 'target_temperature_settings');
  });
}
for (let [values, label, seconds] of [
  [{ fan_state: true, fan_duration: 60, fan_timer_speed: 3 }, 'fan_control_settings', 60],
  [{ hot_water_boost_active: { state: true, time: 120 } }, 'hot_water_settings', 120],
  [{ hot_water_boost_active: { state: true } }, 'hot_water_settings', 1800],
]) {
  test('timed command derives protobuf time consistently: ' + JSON.stringify(values), async (context) => {
    context.mock.timers.enable({ apis: ['Date'], now: 100123 });
    let flow = await platformHarness(context, { value: traits });
    await flow.device.set({ uuid: 'DEVICE_TEST', ...values });
    let update = flow.commands[0][3].batchUpdateStateRequest[0];
    assert.equal(update.traitRequest.traitLabel, label);
    let timestamp = update.state.value.timerEnd ?? update.state.value.boostTimerEnd;
    assert.deepEqual(timestamp, { seconds: 100 + seconds, nanos: 123000000 });
  });
}
for (let response of [
  { status: 14 },
  { status: 0, data: [] },
  { status: 0, data: [{ traitOperations: [{ progress: 'PENDING' }] }] },
  { status: 0, data: [{ traitOperations: [{ progress: 'COMPLETE', status: { code: 7 } }] }] },
]) {
  for (let command of [true, false]) {
    test(
      'real platform rejects unsuccessful ' + (command === true ? 'command' : 'update') + ': ' + JSON.stringify(response),
      async (context) => {
        let flow = await platformHarness(context, { value: traits });
        flow.connection.grpcTransport.command = async () => response;
        await assert.rejects(
          flow.device.set({ uuid: 'DEVICE_TEST', ...(command === true ? { bolt_lock: true } : { temperature_scale: 'F' }) }),
          AggregateError,
        );
        assert.equal(flow.device.deviceData.temperature_scale, undefined);
        assert.equal(flow.device.deviceData.bolt_lock, undefined);
      },
    );
  }
}
for (let unavailable of ['account', 'authorisation', 'transport', 'resource']) {
  test('public SET fails without ' + unavailable, async (context) => {
    let flow = await platformHarness(context, { value: traits });
    if (unavailable === 'account') {
      flow.accounts.delete('account');
    }
    if (unavailable === 'authorisation') {
      flow.connection.authorised = false;
    }
    if (unavailable === 'transport') {
      flow.connection.googleProtobufAPI.disconnect();
    }
    if (unavailable === 'resource') {
      delete flow.raw.DEVICE_TEST;
    }
    await assert.rejects(flow.device.set({ uuid: 'DEVICE_TEST', temperature_scale: 'F' }));
    assert.deepEqual(flow.commands, []);
  });
}

for (let value of [undefined, null, true, false, 0, 1, 'unknown', 'ECO_MODE_MANUAL_ECO', 'INVALID', '__proto__', 'constructor']) {
  test('Eco command rejects unsupported mode: ' + value, async (context) => {
    let flow = await platformHarness(context, { value: traits });
    await assert.rejects(flow.device.set({ uuid: 'DEVICE_TEST', eco_mode: value }), AggregateError);
    assert.deepEqual(flow.commands, []);
  });
}
for (let ecoMode of [undefined, null, 'ECO_MODE_UNSPECIFIED', 'ECO_MODE_UNKNOWN']) {
  test('Eco command can request a valid mode before recognised Observe state: ' + ecoMode, async (context) => {
    let flow = await platformHarness(context, { value: { eco_mode_state: { ecoMode } } });
    await flow.device.set({ uuid: 'DEVICE_TEST', eco_mode: 'manual' });
    assert.equal(flow.commands.length, 1);
    assert.equal(flow.commands[0][3].resourceCommands[0].command.value.ecoMode, 'ECO_MODE_MANUAL_ECO');
    assert.equal(flow.raw.DEVICE_TEST.value.eco_mode_state.ecoMode, ecoMode, 'SET leaves the raw Observe cache unchanged');
  });
}

for (let key of [
  'hvac_mode',
  'temperature_scale',
  'temperature_lock',
  'streaming_enabled',
  'audio_enabled',
  'light_enabled',
  'bolt_lock',
  'vacation_mode',
  'humidifier_state',
  'dehumidifier_state',
  'active_sensor',
]) {
  test('unsupported value cannot silently succeed for ' + key, async (context) => {
    let flow = await platformHarness(context, { value: traits });
    await assert.rejects(flow.device.set({ uuid: 'DEVICE_TEST', [key]: 'invalid' }), AggregateError);
    assert.deepEqual(flow.commands, []);
  });
}
for (let key of [
  'target_temperature',
  'target_temperature_low',
  'target_temperature_high',
  'fan_timer_speed',
  'light_brightness',
  'hot_water_temperature',
  'auto_relock_duration',
  'target_humidity_humidifier',
  'target_humidity_dehumidifier',
]) {
  for (let value of [null, true, '', ' ', [], {}, Infinity, 'invalid']) {
    test('numeric SET rejects nonnumeric input for ' + key + ': ' + JSON.stringify(value), async (context) => {
      let flow = await platformHarness(context, { value: traits });
      await assert.rejects(flow.device.set({ uuid: 'DEVICE_TEST', [key]: value }), AggregateError);
      assert.deepEqual(flow.commands, []);
    });
  }
}
for (let [values, raw] of [
  [{ softwareVersion: 'changed' }, traits],
  [{ statusled_brightness: 1 }, traits],
  [{ irled_enabled: true }, traits],
  [{ active_sensor: true }, traits],
  [{ light_enabled: true }, { ...traits, related_resources: {} }],
  [{ vacation_mode: true }, { ...traits, device_info: {} }],
  [{ hot_water_boost_active: { state: true } }, { ...traits, hvac_equipment_capabilities: {} }],
  [{ hot_water_temperature: 60 }, { ...traits, hvac_equipment_capabilities: {} }],
  [{ humidifier_state: true }, { ...traits, hvac_equipment_capabilities: {} }],
  [{ dehumidifier_state: true }, { ...traits, hvac_equipment_capabilities: {} }],
  [{ target_humidity_humidifier: 50 }, { ...traits, hvac_equipment_capabilities: {} }],
  [{ target_humidity_dehumidifier: 50 }, { ...traits, hvac_equipment_capabilities: {} }],
]) {
  test('unavailable setting rejects without a command: ' + JSON.stringify(values), async (context) => {
    let flow = await platformHarness(context, { value: raw });
    let before = structuredClone(flow.device.deviceData);
    await assert.rejects(flow.device.set({ uuid: 'DEVICE_TEST', ...values }), AggregateError);
    assert.deepEqual(flow.commands, []);
    assert.deepEqual(flow.device.deviceData, before);
  });
}
for (let values of [
  { fan_duration: 60 },
  { fan_state: true },
  { fan_state: true, fan_duration: null },
  { fan_duration: -1, fan_state: true },
  { fan_state: true, fan_duration: 60, fan_timer_speed: 'invalid' },
  { fan_timer_speed: 4, fan_duration: 60, fan_state: true },
  { fan_timer_speed: 1.5 },
  { light_brightness: 101 },
  { auto_relock_duration: -1 },
  { target_humidity_humidifier: 101 },
  { target_humidity_dehumidifier: -1 },
  { hot_water_boost_active: null },
  { hot_water_boost_active: {} },
  { hot_water_boost_active: { state: 'on' } },
  { hot_water_boost_active: { state: true, time: 'invalid' } },
  { hot_water_boost_active: { state: true, time: -1 } },
]) {
  test('invalid compound or out-of-range SET rejects: ' + JSON.stringify(values), async (context) => {
    let flow = await platformHarness(context, { value: traits });
    await assert.rejects(flow.device.set({ uuid: 'DEVICE_TEST', ...values }), AggregateError);
    assert.deepEqual(flow.commands, []);
  });
}
for (let values of [
  { fan_duration: 60, fan_timer_speed: 3, fan_state: true },
  { fan_timer_speed: 3, fan_state: true, fan_duration: 60 },
  { fan_state: true, fan_duration: '60', fan_timer_speed: '3' },
]) {
  test('fan companion fields remain valid in any order: ' + JSON.stringify(values), async (context) => {
    context.mock.timers.enable({ apis: ['Date'], now: 100000 });
    let flow = await platformHarness(context, { value: traits });
    await flow.device.set({ uuid: 'DEVICE_TEST', ...values });
    assert.equal(flow.commands.length, 1);
    let state = flow.commands[0][3].batchUpdateStateRequest[0].state.value;
    assert.equal(state.timerEnd.seconds, 160);
    assert.equal(state.timerSpeed, 'FAN_SPEED_SETTING_STAGE3');
  });
}

test('a rejected field prevents local SET commit while other valid fields are still attempted', async (context) => {
  let flow = await platformHarness(context, { value: traits });
  flow.device.deviceData.hvac_mode = 'heat';
  flow.device.deviceData.temperature_scale = 'C';
  await assert.rejects(flow.device.set({ uuid: 'DEVICE_TEST', hvac_mode: 'invalid', temperature_scale: 'F' }), AggregateError);
  assert.equal(flow.commands.length, 1);
  assert.equal(flow.device.deviceData.hvac_mode, 'heat');
  assert.equal(flow.device.deviceData.temperature_scale, 'C');
});

for (let [key, state] of [
  ['target_temperature_high', { target_temperature_settings: { targetTemperature: { setpointType: 'SET_POINT_TYPE_HEAT' } } }],
  ['target_temperature_low', { target_temperature_settings: { targetTemperature: { setpointType: 'SET_POINT_TYPE_COOL' } } }],
  ['target_temperature', { target_temperature_settings: { targetTemperature: { setpointType: 'SET_POINT_TYPE_UNSPECIFIED' } } }],
  [
    'target_temperature_high',
    { eco_mode_state: { ecoMode: 'ECO_MODE_MANUAL_ECO' }, eco_mode_settings: { ecoTemperatureHeat: { enabled: true } } },
  ],
  [
    'target_temperature_low',
    { eco_mode_state: { ecoMode: 'ECO_MODE_MANUAL_ECO' }, eco_mode_settings: { ecoTemperatureCool: { enabled: true } } },
  ],
  [
    'target_temperature',
    {
      eco_mode_state: { ecoMode: 'ECO_MODE_MANUAL_ECO' },
      eco_mode_settings: { ecoTemperatureHeat: { enabled: true }, ecoTemperatureCool: { enabled: true } },
    },
  ],
]) {
  test('temperature SET rejects an unavailable target: ' + key + ' ' + JSON.stringify(state), async (context) => {
    let flow = await platformHarness(context, { value: { ...traits, ...state } });
    await assert.rejects(flow.device.set({ uuid: 'DEVICE_TEST', [key]: 22 }), AggregateError);
    assert.deepEqual(flow.commands, []);
  });
}
for (let [values, label, expected] of [
  [
    { target_temperature: '21.5' },
    'target_temperature_settings',
    { targetTemperature: { heatingTarget: { value: 21.5 }, coolingTarget: { value: 21.5 } } },
  ],
  [{ fan_timer_speed: '0' }, 'fan_control_settings', { timerSpeed: 'FAN_SPEED_SETTING_STAGE2' }],
  [{ auto_relock_duration: '120' }, 'bolt_lock_settings', { autoRelockDuration: { seconds: 120 } }],
  [{ hot_water_temperature: '60' }, 'hot_water_settings', { temperature: { value: 60 } }],
]) {
  test('valid numeric-string SET remains supported: ' + JSON.stringify(values), async (context) => {
    let flow = await platformHarness(context, { value: traits });
    await flow.device.set({ uuid: 'DEVICE_TEST', ...values });
    assert.equal(flow.commands.length, 1);
    let update = flow.commands[0][3].batchUpdateStateRequest[0];
    assert.equal(update.traitRequest.traitLabel, label);
    assert.partialDeepStrictEqual(update.state.value, expected);
  });
}

for (let source of [DATA_SOURCE.PROTOBUF, DATA_SOURCE.HOMEGRAPH]) {
  test('System dispatches GET and SET to the selected source: ' + source, async (context) => {
    let flow = await platformHarness(context);
    let protobuf = {
      get: context.mock.method(flow.connection.googleProtobufAPI, 'get', async () => 'protobuf-reading'),
      set: context.mock.method(flow.connection.googleProtobufAPI, 'set', async () => undefined),
    };
    let homegraph = {
      get: context.mock.fn(async () => 'homegraph-reading'),
      set: context.mock.fn(async () => undefined),
    };
    flow.connection.homegraphAPI = homegraph;
    flow.raw.DEVICE_TEST.source = source;
    let values = { uuid: 'DEVICE_TEST', target_temperature: 21 };
    await flow.device.set(values);
    assert.deepEqual(values, { uuid: 'DEVICE_TEST', target_temperature: 21 });
    let selected = source === DATA_SOURCE.PROTOBUF ? protobuf : homegraph;
    let other = source === DATA_SOURCE.PROTOBUF ? homegraph : protobuf;
    assert.deepEqual(selected.set.mock.calls[0].arguments, ['DEVICE_TEST', { target_temperature: 21 }]);
    let result = await flow.device.get({ uuid: 'DEVICE_TEST', sample: { selector: 1 }, second: true });
    assert.equal(result.sample, source === DATA_SOURCE.PROTOBUF ? 'protobuf-reading' : 'homegraph-reading');
    assert.deepEqual(
      selected.get.mock.calls.map((call) => call.arguments),
      [
        ['DEVICE_TEST', 'sample', { selector: 1 }],
        ['DEVICE_TEST', 'second', undefined],
      ],
    );
    assert.equal(other.get.mock.callCount(), 0);
    assert.equal(other.set.mock.callCount(), 0);
  });
}

test('System rejects unknown source operations instead of falling back to protobuf', async (context) => {
  let flow = await platformHarness(context);
  flow.raw.DEVICE_TEST.source = 'unknown';
  let get = context.mock.method(flow.connection.googleProtobufAPI, 'get', () => assert.fail('Unexpected protobuf fallback'));
  let set = context.mock.method(flow.connection.googleProtobufAPI, 'set', () => assert.fail('Unexpected protobuf fallback'));
  await assert.rejects(flow.device.set({ uuid: 'DEVICE_TEST', target_temperature: 21 }), /SET is not supported/);
  assert.deepEqual(await flow.device.get({ uuid: 'DEVICE_TEST', sample: true }), { uuid: 'DEVICE_TEST', sample: undefined });
  assert.equal(get.mock.callCount(), 0);
  assert.equal(set.mock.callCount(), 0);
  assert.equal(
    flow.logs.some((entry) => String(entry.at(-1)).includes('GET is not supported')),
    true,
  );
});

test('HomeGraph device requests cannot trigger account discovery or protobuf fallback', async (context) => {
  let flow = await platformHarness(context);
  flow.raw.DEVICE_TEST.source = DATA_SOURCE.HOMEGRAPH;
  flow.connection.homegraphAPI = new HomeGraphAPI();
  context.mock.method(flow.connection.homegraphAPI, 'connect', () => assert.fail('Device GET triggered discovery'));
  context.mock.method(flow.connection.googleProtobufAPI, 'get', () => assert.fail('Unexpected protobuf fallback'));
  context.mock.method(flow.connection.googleProtobufAPI, 'set', () => assert.fail('Unexpected protobuf fallback'));
  await assert.rejects(
    flow.device.set({ uuid: 'DEVICE_TEST', target_temperature: 21 }),
    /SET requires valid parameters and an authorised device account/,
  );
  assert.deepEqual(await flow.device.get({ uuid: 'DEVICE_TEST', sample: true }), { uuid: 'DEVICE_TEST', sample: undefined });
  assert.equal(
    flow.logs.some((entry) => String(entry.at(-1)).includes('HomeGraph device GET requires a discovered device')),
    true,
  );
});

for (let sameAccount of [true, false]) {
  test('related resource access stays within the accessory account: sameAccount=' + sameAccount, async (context) => {
    let flow = await platformHarness(context);
    let get = context.mock.method(flow.connection.googleProtobufAPI, 'get', async () => 'owned-reading');
    let set = context.mock.method(flow.connection.googleProtobufAPI, 'set', async () => undefined);
    let other = {
      get: context.mock.fn(() => assert.fail('Cross-account read')),
      set: context.mock.fn(() => assert.fail('Cross-account write')),
      disconnect() {},
    };
    flow.accounts.set('other-account', { authorised: true, googleProtobufAPI: other });
    flow.raw.DEVICE_RELATED = { connection: sameAccount === true ? 'account' : 'other-account', source: DATA_SOURCE.PROTOBUF, value: {} };
    if (sameAccount === true) {
      await flow.device.set({ uuid: 'DEVICE_RELATED', target_temperature: 21 });
      assert.equal((await flow.device.get({ uuid: 'DEVICE_RELATED', sample: true })).sample, 'owned-reading');
      assert.equal(get.mock.callCount(), 1);
      assert.equal(set.mock.callCount(), 1);
    } else {
      await assert.rejects(flow.device.set({ uuid: 'DEVICE_RELATED', target_temperature: 21 }), /authorised device account/);
      assert.equal(await flow.device.get({ uuid: 'DEVICE_RELATED', sample: true }), undefined);
      assert.equal(get.mock.callCount(), 0);
      assert.equal(set.mock.callCount(), 0);
    }
    assert.equal(other.get.mock.callCount(), 0);
    assert.equal(other.set.mock.callCount(), 0);
  });
}

test('System camera_events GET reaches the HomeGraph timeline pipeline without protobuf fallback', async (context) => {
  let flow = await platformHarness(context);
  let now = Math.floor(Date.now() / 1000);
  let calls = [];
  context.mock.method(GrpcTransport.prototype, 'command', async (_prefix, _service, method) => {
    calls.push(method);
    let data = {};
    if (method === 'GetHomeGraph') {
      data = {
        homes: [
          {
            uuid: 'home',
            devices: [
              {
                id: { googleUuid: 'DEVICE_TEST', thirdPartyId: { idType: 'nest-home-assistant-prod', id: 'camera' } },
                type: 'action.devices.types.CAMERA',
              },
            ],
          },
        ],
      };
    }
    if (method === 'GetTraits') {
      data = { device: [{ uuid: { value: 'DEVICE_TEST' }, category: [] }] };
    }
    if (method === 'ListTimelinePeriods') {
      data = {
        periods: [
          {
            recorded: {
              session: {
                sessionId: 's',
                tracks: [
                  {
                    trackId: 't',
                    startTime: { seconds: now - 1 },
                    endTime: { seconds: now },
                    eventTypes: ['EVENT_TYPE_MOTION', 'EVENT_TYPE_DOORBELL'],
                  },
                ],
              },
            },
          },
        ],
      };
    }
    return { status: 0, data: [data] };
  });
  let api = new HomeGraphAPI({ uuid: 'account', getAccessToken: () => 'fabricated-oauth', poll: false });
  context.after(() => api.disconnect());
  await api.connect();
  flow.connection.homegraphAPI = api;
  flow.raw.DEVICE_TEST.source = DATA_SOURCE.HOMEGRAPH;
  context.mock.method(flow.connection.googleProtobufAPI, 'get', () => assert.fail('Unexpected protobuf fallback'));
  let result = await flow.device.get({ uuid: 'DEVICE_TEST', camera_events: true });
  assert.deepEqual(result.camera_events, [
    {
      id: 't',
      playback_time: (now - 1) * 1000,
      start_time: (now - 1) * 1000,
      end_time: now * 1000,
      types: ['motion', 'doorbell'],
      zone_ids: [],
    },
  ]);
  assert.equal(calls.filter((method) => method === 'ListTimelinePeriods').length, 1);
});
