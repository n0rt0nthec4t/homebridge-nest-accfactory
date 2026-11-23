// Exercise cloud SET outcomes through the real platform, API clients and device commit boundary.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DATA_SOURCE } from '../src/consts.js';
import { platformHarness } from './helpers/platform-harness.js';

async function setup(context, source, response, options = {}) {
  let id = options.id ?? 'DEVICE_TEST';
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
        let flow = await setup(context, DATA_SOURCE.PROTOBUF, response, { initial });
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
        DATA_SOURCE.PROTOBUF,
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
    DATA_SOURCE.PROTOBUF,
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
    DATA_SOURCE.PROTOBUF,
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
      DATA_SOURCE.PROTOBUF,
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

for (let reason of ['missing resource', 'missing connection', 'unauthorised connection', 'missing transport']) {
  test('unavailable connection or transport rejects SET: ' + reason, async (context) => {
    let flow = await setup(context, DATA_SOURCE.PROTOBUF, {});
    if (reason === 'missing resource') {
      delete flow.raw[flow.id];
    } else if (reason === 'missing connection') {
      flow.accounts.delete('account');
    } else if (reason === 'unauthorised connection') {
      flow.connection.authorised = false;
    } else {
      flow.connection.googleProtobufAPI.disconnect();
    }
    await assert.rejects(flow.device.set({ uuid: flow.id, temperature_scale: 'F' }));
    assert.equal(flow.writes.length, 0);
  });
}

test('System removes HomeKit routing before ' + DATA_SOURCE.PROTOBUF + ' SET without mutating the request', async (context) => {
  let flow = await setup(context, DATA_SOURCE.PROTOBUF, {});
  let api = flow.connection.googleProtobufAPI;
  let send = context.mock.method(api, 'set', async () => undefined);
  let values = { uuid: flow.id, temperature_scale: 'F' };
  await flow.device.set(values);
  assert.deepEqual(send.mock.calls[0].arguments, [flow.id, { temperature_scale: 'F' }]);
  assert.deepEqual(values, { uuid: flow.id, temperature_scale: 'F' });
});

for (let failedStage of [0, 1]) {
  test('compound thermostat write stops dependent fields after failure: ' + DATA_SOURCE.PROTOBUF + '/' + failedStage, async (context) => {
    let attempt = 0;
    let id = 'DEVICE_TEST';
    let value = {
      eco_mode_state: { ecoMode: 'ECO_MODE_MANUAL_ECO' },
      display_settings: {},
      target_temperature_settings: {
        enabled: { value: true },
        targetTemperature: { setpointType: 'SET_POINT_TYPE_HEAT', heatingTarget: { value: 19 }, coolingTarget: { value: 25 } },
      },
    };
    let flow = await setup(
      context,
      DATA_SOURCE.PROTOBUF,
      () => {
        let failed = attempt++ === failedStage;
        return {
          status: failed === true ? 4 : 0,
          data: [{ traitOperations: [{ progress: 'COMPLETE', status: { code: 0 } }] }],
        };
      },
      { id, value },
    );

    // Property order must not send mode before Eco Off. Independent display
    // units still get their existing partial-success attempt after a failure.
    await assert.rejects(
      flow.device.set({
        uuid: id,
        hvac_mode: 'cool',
        target_temperature_high: 26,
        eco_mode: 'off',
        temperature_scale: 'F',
      }),
      AggregateError,
    );
    assert.equal(flow.writes.length, failedStage === 0 ? 2 : 3);

    assert.equal(flow.writes[0][2], 'SendCommand');
    assert.equal(flow.writes[0][3].resourceCommands[0].traitLabel, 'eco_mode_state');
    assert.equal(flow.writes.at(-1)[3].batchUpdateStateRequest[0].traitRequest.traitLabel, 'display_settings');
  });
}
