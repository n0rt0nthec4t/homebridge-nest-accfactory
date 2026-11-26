// Exercise account ownership, source selection and diagnostics through the real platform lifecycle.
// Network and device mapping remain fixture boundaries; System and the protobuf client retain their source bodies.
import { getResourceKey } from '../src/utils.js';
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
      googleProtobufAPI: undefined,
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

test('camera credential refresh follows the resource owner across protobuf resource switches', async (context) => {
  let selected = 'DEVICE_OLD';
  let flow = await platformHarness(context, {
    source: DATA_SOURCE.PROTOBUF,
    id: selected,
    type: DEVICE_TYPE.CAMERA,
    map: (raw) => (raw[selected] === undefined ? {} : { FIXTURE: { full: true, data: { ...data, nest_google_device_uuid: selected } } }),
  });
  let accessory = flow.device.accessory;
  let other = {
    ...flow.connection,
    googleProtobufAPI: undefined,
    dataQueue: Promise.resolve(),
    grpcTransport: { ...flow.connection.grpcTransport },
    cameraAuth: { token: 'google-token' },
  };
  flow.accounts.set('other', other);
  await flow.authorise('other', other);
  for (let [resource, owner] of [
    ['DEVICE_OLD', 'account'],
    ['DEVICE_GOOGLE', 'other'],
    ['DEVICE_OLD', 'account'],
  ]) {
    selected = resource;
    await flow.send('DEVICE_GOOGLE', { fixture: { selected: resource } });
    assert.equal(flow.device.deviceData.nest_google_device_uuid, resource);
    for (let [id, account] of flow.accounts) {
      runtime.messages.length = 0;
      account.cameraAuth = { token: id + '-refreshed-' + resource };
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
    source: DATA_SOURCE.PROTOBUF,
    id: 'DEVICE_OLD',
    type: DEVICE_TYPE.CAMERA,
  });
  await flow.consume({ resourceMetas: [{ resourceId: 'DEVICE_OLD', status: 'REMOVED' }] });
  assert.equal(flow.raw['DEVICE_OLD'], undefined);
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

for (let source of [DATA_SOURCE.HOMEGRAPH, DATA_SOURCE.PROTOBUF]) {
  test('support dumps retain unmapped device updates without a HomeKit accessory: ' + source, async (context) => {
    let flow = await platformHarness(context, { config: { supportDump: true }, map: () => ({}) });
    let nativeId = source === DATA_SOURCE.HOMEGRAPH ? 'unmapped' : 'DEVICE_UNMAPPED';
    let id = source === DATA_SOURCE.HOMEGRAPH ? getResourceKey('account', source, nativeId) : nativeId;
    let field = source === DATA_SOURCE.HOMEGRAPH ? 'unmappedDiagnostic.motionEnabled' : 'unmapped_diagnostic';
    let first = { [field]: { boolean: true }, retainedValue: { number: 21.25 } };
    flow.logs.length = 0;
    await flow.sendBatch({
      source,
      isCurrent: () => true,
      changes: [{ resourceId: nativeId, value: first, fields: new Set(Object.keys(first)) }],
    });
    assert.equal(flow.device, undefined);
    assert.deepEqual(flow.registered, []);
    assert.deepEqual(flow.raw[id].value, first);
    let initial = flow.logs.map((entry) => entry.slice(1).join(' ')).join('\n');
    assert.match(initial, /unmappedDiagnostic|unmapped_diagnostic/);
    assert.match(initial, /21.25/);
    flow.logs.length = 0;
    await flow.sendBatch({
      source,
      isCurrent: () => true,
      changes: [{ resourceId: nativeId, value: { [field]: { boolean: false } }, fields: new Set([field]) }],
    });
    let changed = flow.logs.map((entry) => entry.slice(1).join(' ')).join('\n');
    assert.match(changed, /unmappedDiagnostic|unmapped_diagnostic/);
    assert.match(changed, /false/);
    assert.equal(changed.includes('retainedValue'), false, 'unchanged sibling fields are not dumped again');
    assert.equal(flow.raw[id].value.retainedValue.number, 21.25);
    assert.equal(flow.raw[id].value[field].boolean, false);
    assert.deepEqual(flow.registered, []);
  });
}
