// Exercise cloud SET outcomes through the real platform, API clients and device commit boundary.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DATA_SOURCE } from '../src/consts.js';
import { platformHarness } from './helpers/platform-harness.js';

async function setup(context, source, response, options = {}) {
  let id = options.id ?? (source === DATA_SOURCE.GOOGLE ? 'DEVICE_TEST' : 'topaz.TEST');
  let writes = [];
  let flow = await platformHarness(context, {
    source,
    id,
    value: options.value ?? { display_settings: {}, temperature_lock_settings: {} },
    fetch: async (...args) => {
      writes.push(args);
      let data = typeof response === 'function' ? await response(...args) : response;
      return { json: async () => data };
    },
    map: () => ({
      FIXTURE: {
        full: true,
        data: {
          serialNumber: 'FIXTURE',
          manufacturer: 'Nest',
          model: 'Fixture',
          softwareVersion: '1',
          description: 'SET fixture',
          nest_google_device_uuid: id,
          excluded: false,
          ...options.initial,
        },
      },
    }),
  });
  flow.connection.grpcTransport.command = async (...args) => {
    writes.push(args);
    return typeof response === 'function' ? response(...args) : response;
  };
  return { ...flow, id, writes };
}

for (let id of ['topaz.TEST', 'quartz.TEST']) {
  test('REST failure rejects SET without committing requested values: ' + id, async (context) => {
    let failure = new Error('HTTP 503');
    let key = id.startsWith('topaz.') === true ? 'ntp_green_led_enable' : 'streaming_enabled';
    let flow = await setup(
      context,
      DATA_SOURCE.NEST,
      () => {
        throw failure;
      },
      { id, initial: { [key]: false } },
    );
    await assert.rejects(flow.device.set({ uuid: id, [key]: true }), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [failure]);
      return true;
    });
    assert.equal(flow.writes.length, 1);
    assert.equal(flow.device.deviceData[key], false);
  });
}

for (let [id, response, key] of [
  ['topaz.TEST', { objects: [] }, 'ntp_green_led_enable'],
  ['quartz.TEST', { status: 1 }, 'streaming_enabled'],
]) {
  test('REST application rejection propagates: ' + id, async (context) => {
    let flow = await setup(context, DATA_SOURCE.NEST, response, { id, initial: { [key]: false } });
    await assert.rejects(flow.device.set({ uuid: id, [key]: true }), AggregateError);
    assert.equal(flow.writes.length, 1, 'The supported setting must reach the application rejection');
    assert.equal(flow.device.deviceData[key], false);
  });
}

for (let command of [false, true]) {
  for (let response of [
    { status: 14, data: [] },
    { status: 14, data: [{ traitOperations: [{ progress: 'COMPLETE' }] }] },
    { status: 0, data: [] },
    { status: 0, data: [{ traitOperations: [{ progress: 'PENDING' }] }] },
    { status: 0, data: [{ traitOperations: [{ progress: 'COMPLETE', status: { code: 7 } }] }] },
  ]) {
    test(
      'Google SET rejects unsuccessful ' + (command === true ? 'command' : 'update') + ': ' + JSON.stringify(response),
      async (context) => {
        let initial = command === true ? { bolt_lock: false } : { temperature_scale: 'C' };
        let requested = command === true ? { bolt_lock: true } : { temperature_scale: 'F' };
        let flow = await setup(context, DATA_SOURCE.GOOGLE, response, { initial });
        await assert.rejects(flow.device.set({ uuid: flow.id, ...requested }), AggregateError);
        assert.equal(flow.writes.length, 1);
        for (let [key, value] of Object.entries(initial)) {
          assert.equal(flow.device.deviceData[key], value);
        }
      },
    );
  }
}

for (let kind of ['humidifier', 'dehumidifier']) {
  for (let reversed of [false, true]) {
    test('paired Google ' + kind + ' settings preserve both changes; reversed=' + reversed, async (context) => {
      let trait = kind + 'TargetHumidity';
      let flow = await setup(
        context,
        DATA_SOURCE.GOOGLE,
        { status: 0, data: [{ traitOperations: [{ progress: 'COMPLETE' }] }] },
        {
          value: {
            hvac_equipment_capabilities: { [kind === 'humidifier' ? 'hasHumidifier' : 'hasDehumidifier']: true },
            humidity_control_settings: { [trait]: { enabled: false, value: 40 } },
          },
        },
      );
      let fields = [
        [kind + '_state', true],
        ['target_humidity_' + kind, 45],
      ];
      await flow.device.set({ uuid: flow.id, ...Object.fromEntries(reversed === true ? fields.reverse() : fields) });
      let sent = flow.writes.at(-1)[3].batchUpdateStateRequest[0].state.value;
      assert.deepEqual(sent[trait], { enabled: true, value: 45 });
      assert.deepEqual(flow.raw[flow.id].value.humidity_control_settings[trait], { enabled: false, value: 40 });
    });
  }
}

test('rejected Google trait changes do not leak into a later setting in the same request', async (context) => {
  let attempts = 0;
  let flow = await setup(
    context,
    DATA_SOURCE.GOOGLE,
    () => ({
      status: attempts++ === 0 ? 14 : 0,
      data: [{ traitOperations: [{ progress: 'COMPLETE' }] }],
    }),
    {
      value: {
        hvac_equipment_capabilities: { hasHumidifier: true },
        humidity_control_settings: { humidifierTargetHumidity: { enabled: false, value: 40 } },
      },
    },
  );
  await assert.rejects(flow.device.set({ uuid: flow.id, humidifier_state: true, target_humidity_humidifier: 45 }), AggregateError);
  assert.equal(flow.writes.length, 2);
  assert.deepEqual(flow.writes.at(-1)[3].batchUpdateStateRequest[0].state.value.humidifierTargetHumidity, { enabled: false, value: 45 });
});

test('mixed Google outcomes attempt remaining fields and reject the whole local commit', async (context) => {
  let attempts = 0;
  let flow = await setup(
    context,
    DATA_SOURCE.GOOGLE,
    () => ({
      status: attempts++ === 0 ? 14 : 0,
      data: [{ traitOperations: [{ progress: 'COMPLETE' }] }],
    }),
    { initial: { temperature_scale: 'C', temperature_lock: false } },
  );
  await assert.rejects(flow.device.set({ uuid: flow.id, temperature_scale: 'F', temperature_lock: true }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 1);
    return true;
  });
  assert.equal(attempts, 2);
  assert.equal(flow.device.deviceData.temperature_scale, 'C');
  assert.equal(flow.device.deviceData.temperature_lock, false);
});

for (let code of [undefined, 0]) {
  test('successful Google SET commits and accepts omitted protobuf zero status: ' + code, async (context) => {
    let flow = await setup(
      context,
      DATA_SOURCE.GOOGLE,
      {
        status: 0,
        data: [{ traitOperations: [{ progress: 'COMPLETE', status: { code } }] }],
      },
      { initial: { temperature_scale: 'C' } },
    );
    await flow.device.set({ uuid: flow.id, temperature_scale: 'F' });
    assert.equal(flow.device.deviceData.temperature_scale, 'F');
  });
}

test('successful REST SET still commits', async (context) => {
  let flow = await setup(context, DATA_SOURCE.NEST, { objects: [{}] }, { initial: { ntp_green_led_enable: false } });
  await flow.device.set({ uuid: flow.id, ntp_green_led_enable: true });
  assert.equal(flow.device.deviceData.ntp_green_led_enable, true);
});

for (let reason of ['missing resource', 'missing connection', 'unauthorised connection', 'missing transport']) {
  test('unavailable connection or transport rejects SET: ' + reason, async (context) => {
    let flow = await setup(context, DATA_SOURCE.GOOGLE, {});
    if (reason === 'missing resource') {
      delete flow.raw[flow.id];
    } else if (reason === 'missing connection') {
      flow.accounts.delete('account');
    } else if (reason === 'unauthorised connection') {
      flow.connection.authorised = false;
    } else {
      flow.connection.googleAPI.disconnect();
    }
    await assert.rejects(flow.device.set({ uuid: flow.id, temperature_scale: 'F' }));
    assert.equal(flow.writes.length, 0);
  });
}

for (let source of [DATA_SOURCE.NEST, DATA_SOURCE.GOOGLE]) {
  test('System removes HomeKit routing before ' + source + ' SET without mutating the request', async (context) => {
    let flow = await setup(context, source, {});
    let api = source === DATA_SOURCE.NEST ? flow.connection.nestAPI : flow.connection.googleAPI;
    let send = context.mock.method(api, 'set', async () => undefined);
    let values = { uuid: flow.id, temperature_scale: 'F' };
    await flow.device.set(values);
    assert.deepEqual(send.mock.calls[0].arguments, [flow.id, { temperature_scale: 'F' }]);
    assert.deepEqual(values, { uuid: flow.id, temperature_scale: 'F' });
  });
}

for (let [key, property, requested, encoded = requested] of [
  ['indoor_chime_enabled', 'doorbell.indoor_chime.enabled', true],
  ['streaming_enabled', 'streaming.enabled', false],
  ['audio_enabled', 'audio.enabled', true],
  ['statusled_brightness', 'statusled.brightness', 0],
  ['statusled_brightness', 'statusled.brightness', 1],
  ['statusled_brightness', 'statusled.brightness', '1'],
  ['irled_enabled', 'irled.state', true, 'auto_on'],
  ['irled_enabled', 'irled.state', false, 'always_off'],
]) {
  test('Nest camera setting reaches the property endpoint: ' + key + '=' + requested, async (context) => {
    let flow = await setup(context, DATA_SOURCE.NEST, { status: 0 }, { id: 'quartz.TEST', initial: { [key]: null } });
    let before = structuredClone(flow.raw[flow.id]);
    await flow.device.set({ uuid: flow.id, [key]: requested });
    assert.equal(flow.writes.length, 1);
    let [method, url, options, body] = flow.writes[0];
    assert.equal(method, 'post');
    assert.equal(url, 'https://webapi.camera.invalid/api/dropcams.set_properties');
    assert.equal(options.headers.Authorization, 'Basic fixture-token');
    assert.equal(options.headers['Content-Type'], 'application/x-www-form-urlencoded');
    assert.equal(options.retry, 3);
    assert.equal(body, property + '=' + encoded + '&uuid=TEST');
    assert.equal(flow.device.deviceData[key], requested);
    assert.deepEqual(flow.raw[flow.id], before, 'A successful write must await subscription reconciliation of the source cache');
  });
}

for (let [key, requested] of [
  ['indoor_chime_enabled', 1],
  ['streaming_enabled', 'true'],
  ['audio_enabled', null],
  ['statusled_brightness', 2],
  ['statusled_brightness', 0.5],
  ['irled_enabled', 'always_on'],
  ['irled_enabled', 'auto_on'],
  ['irled_enabled', 'always_off'],
  ['irled_enabled', 'false'],
  ['irled_enabled', 0],
  ['temperature_scale', 'F'],
  ['unknown_setting', true],
]) {
  test('Nest camera rejects unsupported property values before sending: ' + key + '=' + requested, async (context) => {
    let flow = await setup(context, DATA_SOURCE.NEST, { status: 0 }, { id: 'quartz.TEST' });
    let before = structuredClone(flow.device.deviceData);
    await assert.rejects(flow.device.set({ uuid: flow.id, [key]: requested }), AggregateError);
    assert.equal(flow.writes.length, 0);
    assert.deepEqual(flow.device.deviceData, before);
  });
}

test('a rejected Nest camera setting still attempts remaining fields without committing partial success', async (context) => {
  let flow = await setup(context, DATA_SOURCE.NEST, { status: 0 }, { id: 'quartz.TEST', initial: { streaming_enabled: true } });
  await assert.rejects(flow.device.set({ uuid: flow.id, statusled_brightness: 2, streaming_enabled: false }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 1);
    return true;
  });
  assert.equal(flow.writes.length, 1);
  assert.equal(flow.writes[0][3], 'streaming.enabled=false&uuid=TEST');
  assert.equal(flow.device.deviceData.streaming_enabled, true);
});
