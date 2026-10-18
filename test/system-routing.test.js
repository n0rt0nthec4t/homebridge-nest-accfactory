// Cover complete platform command routing without extracting or copying private methods.
import assert from 'node:assert/strict';
import test from 'node:test';
import { platformHarness } from './helpers/platform-harness.js';
import { DATA_SOURCE } from '../src/consts.js';

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
  [{ indoor_chime_enabled: true }, 'doorbell_indoor_chime_settings', { chimeEnabled: true }],
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
    let flow = await platformHarness(context, { value: { associated_thermostat: 'DEVICE_PARENT' } });
    await flow.send('DEVICE_PARENT', { remote_comfort_sensing_settings: { retained: true } });
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
for (let [id, values, expected] of [
  ['topaz.TEST', { ntp_green_led_enable: true }, 'ntp_green_led_enable'],
  ['quartz.TEST', { indoor_chime_enabled: false }, 'doorbell.indoor_chime.enabled=false'],
  ['quartz.TEST', { audio_enabled: false }, 'audio.enabled=false'],
  ['quartz.TEST', { streaming_enabled: true }, 'streaming.enabled=true'],
  ['quartz.TEST', { statusled_brightness: 1 }, 'statusled.brightness=1'],
  ['quartz.TEST', { irled_enabled: 'auto_on' }, 'irled.state=auto_on'],
]) {
  test('retained REST SET ' + JSON.stringify(values) + ' on ' + id, async (context) => {
    let flow = await platformHarness(context, { source: DATA_SOURCE.NEST, id, value: {} });
    let before = flow.requests.length;
    await flow.device.set({ uuid: id, ...values });
    assert.equal(flow.requests.length, before + 1);
    let request = flow.requests.at(-1);
    assert.equal(request[3].includes(expected), true);
    assert.equal(new URL(request[1]).hostname, id.startsWith('quartz.') === true ? 'webapi.camera.invalid' : 'transport.invalid');
  });
}

for (let [heat, cool, key, expectedHeat, expectedCool] of [
  [true, false, 'target_temperature', 22, 27],
  [false, true, 'target_temperature', 17, 22],
  [true, true, 'target_temperature_low', 22, 27],
  [true, true, 'target_temperature_high', 17, 22],
]) {
  test('eco SET routes ' + key + ', heat=' + heat + ', cool=' + cool, async (context) => {
    let flow = await platformHarness(context, {
      value: {
        ...traits,
        eco_mode_state: { ecoMode: 'ECO_MODE_ACTIVE' },
        eco_mode_settings: {
          ecoTemperatureHeat: { enabled: heat, value: { value: 17 } },
          ecoTemperatureCool: { enabled: cool, value: { value: 27 } },
        },
      },
    });
    await flow.device.set({ uuid: 'DEVICE_TEST', [key]: 22 });
    let state = flow.commands[0][3].batchUpdateStateRequest[0].state.value;
    assert.equal(state.ecoTemperatureHeat.value.value, expectedHeat);
    assert.equal(state.ecoTemperatureCool.value.value, expectedCool);
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
      flow.connections.delete('account');
    }
    if (unavailable === 'authorisation') {
      flow.connection.authorised = false;
    }
    if (unavailable === 'transport') {
      flow.connection.grpcTransport = undefined;
    }
    if (unavailable === 'resource') {
      delete flow.raw.DEVICE_TEST;
    }
    await assert.rejects(flow.device.set({ uuid: 'DEVICE_TEST', temperature_scale: 'F' }));
    assert.deepEqual(flow.commands, []);
  });
}
