// Verify field-scoped protobuf requests and model a backend that honours masks.
// Remote mask support remains a live-device check; the fake backend is explicit.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import protobuf from 'protobufjs';
import { getProtoType } from '../src/protobuf.js';
import { platformHarness } from './helpers/platform-harness.js';

const schema = fileURLToPath(new URL('../src/protobuf/root.proto', import.meta.url));
const actor = 'target_temperature.current_actor_info';
const traits = {
  eco_mode_state: { ecoMode: 'ECO_MODE_INACTIVE' },
  target_temperature_settings: {
    enabled: { value: true },
    targetTemperature: {
      setpointType: 'SET_POINT_TYPE_RANGE',
      heatingTarget: { value: 20 },
      coolingTarget: { value: 24 },
    },
  },
  display_settings: { temperatureScale: 'TEMPERATURE_SCALE_C' },
  temperature_lock_settings: { enabled: false },
  fan_control_settings: { timerSpeed: 'FAN_SPEED_SETTING_STAGE1', timerEnd: { seconds: 0, nanos: 0 } },
  hot_water_settings: { temperature: { value: 50 }, boostTimerEnd: { seconds: 0, nanos: 0 } },
  humidity_control_settings: {
    humidifierTargetHumidity: { enabled: false, value: 40 },
    dehumidifierTargetHumidity: { enabled: true, value: 60 },
  },
  hvac_equipment_capabilities: { hasHotWaterControl: true, hasHotWaterTemperature: true, hasHumidifier: true, hasDehumidifier: true },
  remote_comfort_sensing_settings: { activeRcsSelection: { activeRcsSensor: { resourceId: 'DEVICE_SENSOR' } } },
};

for (let [values, paths] of [
  [{ target_temperature_low: 19 }, ['target_temperature.heating_target', actor]],
  [{ target_temperature_high: 26 }, ['target_temperature.cooling_target', actor]],
  [{ target_temperature: 22 }, ['target_temperature.heating_target', 'target_temperature.cooling_target', actor]],
  [{ hvac_mode: 'off' }, ['enabled', actor]],
  [{ hvac_mode: 'heat' }, ['target_temperature.setpoint_type', 'enabled', actor]],
  [{ hvac_mode: 'cool' }, ['target_temperature.setpoint_type', 'enabled', actor]],
  [{ hvac_mode: 'range' }, ['target_temperature.setpoint_type', 'enabled', actor]],
  [{ temperature_scale: 'F' }, ['temperature_scale']],
  [{ temperature_lock: true }, ['enabled']],
  [{ fan_state: true, fan_duration: 60 }, ['timer_end']],
  [{ fan_state: false, fan_duration: 60, fan_timer_speed: 0 }, ['timer_end']],
  [{ fan_state: true, fan_duration: 60, fan_timer_speed: 3 }, ['timer_end', 'timer_speed']],
  [{ fan_timer_speed: 2 }, ['timer_speed']],
  [{ streaming_enabled: false }, ['target_camera_state', 'change_mode_reason', 'settings_updated']],
  [{ audio_enabled: false }, ['enable_microphone']],
  [{ light_brightness: 70 }, ['brightness']],
  [{ hot_water_boost_active: { state: false } }, ['boost_timer_end']],
  [{ hot_water_temperature: 55 }, ['temperature.value']],
  [{ auto_relock_duration: 0 }, ['auto_relock_duration.seconds']],
  [{ humidifier_state: false }, ['humidifier_target_humidity.enabled']],
  [{ dehumidifier_state: false }, ['dehumidifier_target_humidity.enabled']],
  [{ target_humidity_humidifier: 45 }, ['humidifier_target_humidity.value']],
  [{ target_humidity_dehumidifier: 65 }, ['dehumidifier_target_humidity.value']],
  [{ active_sensor: true }, ['rcs_control_mode', 'active_rcs_selection']],
]) {
  test('protobuf request masks only intended fields: ' + JSON.stringify(values), async (context) => {
    let flow = await platformHarness(context, { value: traits });
    await flow.device.set({ uuid: 'DEVICE_TEST', ...values });
    assert.equal(flow.commands.length, 1);
    let update = flow.commands[0][3].batchUpdateStateRequest[0];
    assert.deepEqual(update.stateMask.paths, paths);

    // Validate every path against the concrete trait schema, not the Any envelope.
    let type = getProtoType(schema, update.state.type_url.split('/')[1]);
    for (let path of paths) {
      let fieldType = type;
      for (let part of path.split('.')) {
        let name = part.replace(/_([a-z])/g, (match, letter) => letter.toUpperCase());
        let field = fieldType.fields[name];
        assert.notEqual(field, undefined, 'Unknown masked field: ' + path);
        field.resolve();
        fieldType = field.resolvedType;
      }
    }
    // Encode the concrete Any payload and gateway request as the transport does.
    let payload = type.encode(type.fromObject(update.state.value)).finish();
    let envelope = getProtoType(schema, 'nestlabs.gateway.v1.TraitUpdateStateRequest');
    let request = { ...update, state: { ...update.state, value: payload } };
    let decoded = envelope.decode(envelope.encode(envelope.fromObject(request)).finish());
    assert.deepEqual([...decoded.stateMask.paths], paths);
    assert.equal(type.decode(decoded.state.value) !== undefined, true);
  });
}

// Mutate only the fake cloud state. Client Observe state intentionally stays stale.
async function maskedBackend(context) {
  let flow = await platformHarness(context, { value: traits });
  let cloud = structuredClone(traits);
  let original = flow.connection.grpcTransport.command;
  flow.connection.grpcTransport.command = async (...args) => {
    let update = args[3].batchUpdateStateRequest[0];
    assert.ok(update.stateMask.paths.length > 0);
    for (let path of update.stateMask.paths) {
      let fields = path.split('.').map((part) => part.replace(/_([a-z])/g, (match, letter) => letter.toUpperCase()));
      let leaf = fields.pop();
      let source = update.state.value;
      let target = cloud[update.traitRequest.traitLabel];
      for (let field of fields) {
        source = source[field];
        target = target[field] ??= {};
      }
      target[leaf] = structuredClone(source[leaf]);
    }
    return await original(...args);
  };
  return { ...flow, cloud, write: (values) => flow.device.set({ uuid: 'DEVICE_TEST', ...values }) };
}

for (let reverse of [false, true]) {
  test('back-to-back range writes preserve both accepted targets without Observe, reverse=' + reverse, async (context) => {
    let flow = await maskedBackend(context);
    let writes = [{ target_temperature_high: 26 }, { target_temperature_low: 19 }];
    if (reverse === true) {
      writes.reverse();
    }
    for (let values of writes) {
      await flow.write(values);
    }
    let target = flow.cloud.target_temperature_settings.targetTemperature;
    assert.equal(target.heatingTarget.value, 19);
    assert.equal(target.coolingTarget.value, 26);
    assert.equal(flow.raw.DEVICE_TEST.value.target_temperature_settings.targetTemperature.coolingTarget.value, 24);
  });
}

for (let external of [23, 24]) {
  test('external cooling adjustment survives the next heating write, value=' + external, async (context) => {
    let flow = await maskedBackend(context);
    await flow.write({ target_temperature_high: 26 });
    flow.cloud.target_temperature_settings.targetTemperature.coolingTarget.value = external;
    await flow.write({ target_temperature_low: 19 });
    let target = flow.cloud.target_temperature_settings.targetTemperature;
    assert.equal(target.heatingTarget.value, 19);
    assert.equal(target.coolingTarget.value, external);
  });
}

for (let [name, first, second, label, field] of [
  ['fan runtime/speed', { fan_state: true, fan_duration: 60 }, { fan_timer_speed: 3 }, 'fan_control_settings', 'timerEnd'],
  [
    'hot water boost/temperature',
    { hot_water_boost_active: { state: true } },
    { hot_water_temperature: 55 },
    'hot_water_settings',
    'boostTimerEnd',
  ],
  [
    'humidity enabled/target',
    { humidifier_state: true },
    { target_humidity_humidifier: 45 },
    'humidity_control_settings',
    'humidifierTargetHumidity',
  ],
]) {
  test('separate writes preserve accepted companion fields: ' + name, async (context) => {
    let flow = await maskedBackend(context);
    await flow.write(first);
    let accepted = structuredClone(flow.cloud[label][field]);
    await flow.write(second);
    if (label === 'humidity_control_settings') {
      assert.equal(flow.cloud[label][field].enabled, true);
      assert.equal(flow.cloud[label][field].value, 45);
    } else {
      assert.deepEqual(flow.cloud[label][field], accepted);
    }
  });
}

for (let zero of [0, '0']) {
  test('zero fan speed retains cloud stage without a stale speed write: ' + JSON.stringify(zero), async (context) => {
    let flow = await maskedBackend(context);
    flow.cloud.fan_control_settings.timerSpeed = 'FAN_SPEED_SETTING_STAGE3';
    await flow.write({ fan_timer_speed: zero });
    assert.equal(flow.commands.length, 0);
    await flow.write({ fan_state: true, fan_duration: 60, fan_timer_speed: zero });
    assert.equal(flow.cloud.fan_control_settings.timerSpeed, 'FAN_SPEED_SETTING_STAGE3');
    assert.deepEqual(flow.commands[0][3].batchUpdateStateRequest[0].stateMask.paths, ['timer_end']);
  });
}

test('failed writes reject without committing state; later writes mask out the rejected field', async (context) => {
  let flow = await maskedBackend(context);
  let command = flow.connection.grpcTransport.command;
  flow.connection.grpcTransport.command = async () => ({ status: 7 });
  await assert.rejects(flow.write({ target_temperature_high: 26 }), AggregateError);
  flow.connection.grpcTransport.command = command;
  await flow.write({ target_temperature_low: 19 });
  assert.equal(flow.cloud.target_temperature_settings.targetTemperature.coolingTarget.value, 24);
});

for (let key of ['target_temperature_high', 'target_temperature']) {
  test('Cool-mode temperature writes attach the cooling mask: ' + key, async (context) => {
    let value = structuredClone(traits);
    value.target_temperature_settings.targetTemperature.setpointType = 'SET_POINT_TYPE_COOL';
    let flow = await platformHarness(context, { value });
    await flow.device.set({ uuid: 'DEVICE_TEST', [key]: 25 });
    let update = flow.commands[0][3].batchUpdateStateRequest[0];
    assert.deepEqual(update.stateMask.paths, ['target_temperature.cooling_target', 'target_temperature.current_actor_info']);
    assert.equal(update.state.value.targetTemperature.coolingTarget.value, 25);
  });
}

// Independent descriptor-name model: the production reconstruction uses camelCase.
// Numeric tags are from the existing trait schema. Live testing accepted the
// cooling and actor snake_case paths; this fixture keeps those names independent.
const descriptorTrait = protobuf
  .parse(
    'syntax = "proto3"; package fixture;' +
      'message Temperature { float value = 1; }' +
      'message Actor {}' +
      'message Setpoint { Temperature heating_target = 4; Temperature cooling_target = 5; Actor current_actor_info = 6; }' +
      'message TargetTemperatureSettingsTrait { Setpoint target_temperature = 1; }',
    { keepCase: true },
  )
  .root.lookupType('fixture.TargetTemperatureSettingsTrait');

function descriptorField(path) {
  let type = descriptorTrait;
  for (let name of path.split('.')) {
    let field = type.fields[name];
    if (field === undefined) {
      throw new Error('No such field ' + name + ' on type ' + type.name);
    }
    field.resolve();
    type = field.resolvedType;
  }
}

test('mask parser model reproduces the live rejection of camelCase descriptor paths', () => {
  assert.throws(() => descriptorField('targetTemperature.coolingTarget'), /No such field targetTemperature/);
  assert.doesNotThrow(() => descriptorField('target_temperature.cooling_target'));
  assert.doesNotThrow(() => descriptorField('target_temperature.current_actor_info'));
});

test('wire request keeps snake_case mask paths while encoding the camelCase JavaScript payload', async (context) => {
  let flow = await platformHarness(context, { value: traits });
  await flow.device.set({ uuid: 'DEVICE_TEST', target_temperature_high: 25 });
  let update = flow.commands[0][3].batchUpdateStateRequest[0];
  let schema = fileURLToPath(new URL('../src/protobuf/root.proto', import.meta.url));
  let traitType = getProtoType(schema, 'nest.trait.hvac.TargetTemperatureSettingsTrait');
  let requestType = getProtoType(schema, 'nestlabs.gateway.v1.TraitUpdateStateRequest');
  let payload = traitType.encode(traitType.fromObject(update.state.value)).finish();
  let request = { ...update, state: { ...update.state, value: payload } };
  let decoded = requestType.decode(requestType.encode(requestType.fromObject(request)).finish());
  assert.deepEqual([...decoded.stateMask.paths], ['target_temperature.cooling_target', 'target_temperature.current_actor_info']);
  for (let path of decoded.stateMask.paths) {
    descriptorField(path);
  }
  let serverValue = descriptorTrait.decode(decoded.state.value);
  assert.equal(serverValue.target_temperature.cooling_target.value, 25);
  assert.equal(serverValue.target_temperature.heating_target.value, 20);
});

test('descriptor-name mask model preserves an external heating change despite stale client state', async (context) => {
  let flow = await platformHarness(context, { value: traits });
  let cloud = { target_temperature: { heating_target: { value: 19 }, cooling_target: { value: 24 } } };
  let original = flow.connection.grpcTransport.command;
  flow.connection.grpcTransport.command = async (...args) => {
    let update = args[3].batchUpdateStateRequest[0];
    let schema = fileURLToPath(new URL('../src/protobuf/root.proto', import.meta.url));
    let traitType = getProtoType(schema, 'nest.trait.hvac.TargetTemperatureSettingsTrait');
    let wireState = traitType.encode(traitType.fromObject(update.state.value)).finish();
    let incoming = descriptorTrait.decode(wireState);
    for (let path of update.stateMask.paths) {
      descriptorField(path);
      let [parent, field] = path.split('.');
      cloud[parent][field] = structuredClone(incoming[parent][field]);
    }
    return await original(...args);
  };
  await flow.device.set({ uuid: 'DEVICE_TEST', target_temperature_high: 25 });
  assert.equal(cloud.target_temperature.cooling_target.value, 25);
  assert.equal(cloud.target_temperature.heating_target.value, 19);
  assert.equal(flow.raw.DEVICE_TEST.value.target_temperature_settings.targetTemperature.heatingTarget.value, 20);
});
