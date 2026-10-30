// Exercise account ownership, source selection and diagnostics through the real platform lifecycle.
// Network and device mapping remain fixture boundaries; System and both API clients retain their source bodies.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { DATA_SOURCE, DEVICE_TYPE } from '../src/consts.js';
import { platformHarness } from './helpers/platform-harness.js';
import { runtime } from './helpers/platform-runtime.js';

let data = {
  serialNumber: 'FIXTURE',
  manufacturer: 'Nest',
  model: 'Fixture',
  softwareVersion: '1',
  description: 'Fixture',
  excluded: false,
};

for (let type of [DEVICE_TYPE.CAMERA, DEVICE_TYPE.DOORBELL, DEVICE_TYPE.FLOODLIGHT, DEVICE_TYPE.THERMOSTAT]) {
  test(type + ' authorisation and refresh update only owned camera-family credentials', async (context) => {
    let flow = await platformHarness(context, {
      type,
      map: (raw) =>
        Object.fromEntries(
          Object.keys(raw)
            .filter((id) => id.startsWith('DEVICE_'))
            .map((id) => [
              id,
              {
                full: true,
                data: { ...data, serialNumber: id, nest_google_device_uuid: id },
              },
            ]),
        ),
    });
    let other = {
      ...flow.connection,
      nestAPI: undefined,
      googleAPI: undefined,
      dataQueue: Promise.resolve(),
      grpcTransport: { ...flow.connection.grpcTransport },
      cameraAuth: { token: 'other-token' },
    };
    flow.accounts.set('other', other);
    await flow.authorise('other', other);
    await flow.send('DEVICE_OTHER', { fixture: {} });
    assert.equal(runtime.devices.length, 2);
    for (let wasAuthorised of [false, true]) {
      for (let [owner, account] of flow.accounts) {
        runtime.messages.length = 0;
        account.cameraAuth = { token: owner + '-refreshed-' + wasAuthorised };
        await flow.authorise(owner, account, { wasAuthorised });
        assert.equal(runtime.messages.length, type === DEVICE_TYPE.THERMOSTAT ? 0 : 1);
        if (type !== DEVICE_TYPE.THERMOSTAT) {
          assert.equal(runtime.messages[0].nest_google_device_uuid, owner === 'account' ? 'DEVICE_TEST' : 'DEVICE_OTHER');
          assert.deepEqual(runtime.messages[0].apiAccess, account.cameraAuth);
        }
      }
    }
    assert.equal(flow.registered.length, 2);
  });
}

test('camera credential refresh follows the resource owner across Nest/Google source switches', async (context) => {
  let selected = 'quartz.TEST';
  let flow = await platformHarness(context, {
    source: DATA_SOURCE.NEST,
    id: selected,
    type: DEVICE_TYPE.CAMERA,
    map: (raw) => (raw[selected] === undefined ? {} : { FIXTURE: { full: true, data: { ...data, nest_google_device_uuid: selected } } }),
  });
  let accessory = flow.device.accessory;
  let other = {
    ...flow.connection,
    nestAPI: undefined,
    googleAPI: undefined,
    dataQueue: Promise.resolve(),
    grpcTransport: { ...flow.connection.grpcTransport },
    cameraAuth: { token: 'google-token' },
  };
  flow.accounts.set('other', other);
  await flow.authorise('other', other);
  for (let [resource, owner] of [
    ['quartz.TEST', 'account'],
    ['DEVICE_GOOGLE', 'other'],
    ['quartz.TEST', 'account'],
  ]) {
    selected = resource;
    await flow.send('DEVICE_GOOGLE', { fixture: { selected: resource } });
    assert.equal(flow.device.deviceData.nest_google_device_uuid, resource);
    for (let [id, account] of flow.accounts) {
      runtime.messages.length = 0;
      account.cameraAuth = { token: id + '-token' };
      await flow.authorise(id, account, { wasAuthorised: true });
      assert.equal(runtime.messages.length, owner === id ? 1 : 0);
      if (owner === id) {
        assert.deepEqual(flow.device.deviceData.apiAccess, account.cameraAuth);
      }
    }
  }
  assert.equal(flow.device.accessory, accessory);
  assert.equal(flow.registered.length, 1);
});

test('credential refresh skips a tracked camera after its selected resource disappears', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let flow = await platformHarness(context, {
    source: DATA_SOURCE.NEST,
    id: 'quartz.TEST',
    type: DEVICE_TYPE.CAMERA,
  });
  // Structure membership removes a REST resource without recreating its accessory.
  context.mock.timers.tick(1000);
  await flow.sendNest([{ object_key: 'structure.HOME', value: { swarm: ['quartz.TEST'] } }]);
  context.mock.timers.tick(1000);
  await flow.sendNest([{ object_key: 'structure.HOME', value: { swarm: [] } }]);
  assert.equal(flow.raw['quartz.TEST'], undefined);
  runtime.messages.length = 0;
  await flow.authorise('account', flow.connection, { wasAuthorised: true });
  assert.deepEqual(runtime.messages, []);
  assert.equal(flow.registered.length, 1);
});

test('disabled support dumps do not traverse diagnostic payloads during device updates', async (context) => {
  let flow = await platformHarness(context);
  let reads = 0;
  let diagnostics = {
    get secret() {
      reads++;
      throw new Error('Diagnostic payload read');
    },
  };
  // Deliver directly at Observe's network callback: cloning the fixture itself would read the getter.
  await flow.consume({
    traitStates: [
      { traitId: { resourceId: 'DEVICE_TEST', traitLabel: 'fixture' }, stateTypes: ['ACCEPTED'], patch: { values: { diagnostics } } },
    ],
  });
  await setImmediate();
  assert.equal(reads, 0);
  assert.equal(flow.raw.DEVICE_TEST.value.fixture.diagnostics, diagnostics);
  assert.equal(flow.registered.length, 1);
});

test('enabled support dumps redact secrets without changing raw or accessory data', async (context) => {
  let flow = await platformHarness(context, {
    config: { supportDump: true },
    value: { fixture: { access_token: 'Private Account Token', serial_number: 'PRIVATE_SERIAL0001', temperature: 20 } },
  });
  let lines = flow.logs.map((entry) => entry.slice(1).join(' ')).join('\n');
  assert.equal(lines.includes('Private Account Token'), false);
  assert.equal(lines.includes('PRIVATE_SERIAL0001'), false);
  assert.equal(lines.includes('**REDACTED_'), true);
  assert.equal(flow.raw.DEVICE_TEST.value.fixture.access_token, 'Private Account Token');
  assert.equal(flow.device.deviceData.nest_google_device_uuid, 'DEVICE_TEST');
});

// Both resources map to one accessory. Drive source selection through actual ingestion,
// then verify SET dispatch reaches the selected API rather than only checking mapped state.
for (let type of [
  DEVICE_TYPE.THERMOSTAT,
  DEVICE_TYPE.PROTECT,
  DEVICE_TYPE.TEMPSENSOR,
  DEVICE_TYPE.CAMERA,
  DEVICE_TYPE.DOORBELL,
  DEVICE_TYPE.FLOODLIGHT,
]) {
  for (let initialSource of [DATA_SOURCE.NEST, DATA_SOURCE.GOOGLE]) {
    test(type + ' source preference and SET routing, first source=' + initialSource, async (context) => {
      context.mock.timers.enable({ apis: ['setTimeout'] });
      let selected = initialSource === DATA_SOURCE.NEST ? 'quartz.TEST' : 'DEVICE_TEST';
      let full = true;
      let flow = await platformHarness(context, {
        type,
        source: initialSource,
        id: selected,
        value: initialSource === DATA_SOURCE.NEST ? { temperature: 20 } : { fixture: { temperature: 20 } },
        map: (raw) =>
          raw[selected] === undefined
            ? {}
            : {
                FIXTURE: {
                  full,
                  data: {
                    ...data,
                    nest_google_device_uuid: selected,
                    current_temperature: raw[selected].value.fixture?.temperature ?? raw[selected].value.temperature,
                  },
                },
              },
      });
      let accessory = flow.device.accessory;
      if (initialSource === DATA_SOURCE.GOOGLE) {
        await flow.sendNest([{ object_key: 'quartz.TEST', value: { temperature: 19 } }]);
      }
      full = false;
      selected = 'DEVICE_TEST';
      await flow.send(selected, { fixture: { temperature: 21 } });
      let before = runtime.messages.length;
      selected = 'quartz.TEST';
      context.mock.timers.tick(1000);
      await flow.sendNest([{ object_key: selected, value: { temperature: 19 } }]);
      let camera = [DEVICE_TYPE.CAMERA, DEVICE_TYPE.DOORBELL, DEVICE_TYPE.FLOODLIGHT].includes(type);
      assert.equal(flow.device.deviceData.current_temperature, camera === true ? 19 : 21);
      assert.equal(runtime.messages.length, before + (camera === true ? 1 : 0));
      assert.equal(flow.device.deviceData.nest_google_device_uuid, camera === true ? 'quartz.TEST' : 'DEVICE_TEST');
      let nestSet = context.mock.method(flow.connection.nestAPI, 'set', async () => {});
      let googleSet = context.mock.method(flow.connection.googleAPI, 'set', async () => {});
      await flow.device.set({ uuid: flow.device.deviceData.nest_google_device_uuid, target_temperature: 23 });
      assert.equal(nestSet.mock.calls.length, camera === true ? 1 : 0);
      assert.equal(googleSet.mock.calls.length, camera === true ? 0 : 1);
      assert.equal((camera === true ? nestSet : googleSet).mock.calls[0].arguments[0], camera === true ? 'quartz.TEST' : 'DEVICE_TEST');
      selected = 'DEVICE_TEST';
      await flow.send(selected, { fixture: { temperature: 22 } });
      assert.equal(flow.device.deviceData.current_temperature, 22);
      assert.equal(flow.device.deviceData.nest_google_device_uuid, 'DEVICE_TEST');
      await flow.device.set({ uuid: 'DEVICE_TEST', target_temperature: 24 });
      assert.equal(googleSet.mock.calls.at(-1).arguments[0], 'DEVICE_TEST');
      assert.equal(flow.device.accessory, accessory);
      assert.equal(flow.registered.length, 1);
    });
  }
}
