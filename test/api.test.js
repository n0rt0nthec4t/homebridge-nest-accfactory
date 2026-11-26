// Exercise account-scoped API ingestion without cloud access or platform-private method extraction.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { importSource } from './helpers/import-source.js';
import { ACCOUNT_TYPE, DATA_SOURCE } from '../src/consts.js';

let boundary =
  'data:text/javascript,' +
  encodeURIComponent(
    'import timers from "node:timers"; export const runtime = { fetch: undefined, types: [] };' +
      'export function setTimeout(...args) { return timers.setTimeout(...args); }' +
      'export function clearTimeout(...args) { return timers.clearTimeout(...args); }' +
      'export function fetchWrapper(...args) { return runtime.fetch(...args); }' +
      'export function getProtoTypes() { return runtime.types; }' +
      'export default class Transport { static STATUS = { UNAUTHENTICATED: 16 }; constructor() { return runtime.transport(); } }',
  );
let { runtime } = await import(boundary);
let location = new URL('../src/api/protobuf.js', import.meta.url);
let source = (await readFile(location, 'utf8')).replace(
  /from '([^']+)'/g,
  (match, specifier) =>
    'from ' +
    JSON.stringify(
      ['node:timers', '../fetchWrapper.js', '../protobuf.js', '../grpctransport.js'].includes(specifier) === true ? boundary : specifier,
    ),
);
let { default: GoogleProtobufAPI } = await importSource(location, source);

function setup(context, overrides = {}) {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  runtime.types = [{ fullName: '.nest.trait.device.Identity' }];
  let requests = [];
  let observations = [];
  let pending = [];
  let changed = [];
  let logs = [];
  let connection = {
    authorised: true,
    type: ACCOUNT_TYPE.GOOGLE,
    name: 'Account',
    userID: 'user',
    referer: 'home.invalid',
    restAPIHost: 'rest.invalid',
    token: 'token',
    grpcTransport: {
      observe: (...args) => {
        observations.push(args);
        let request = Promise.withResolvers();
        pending.push(request);
        return request.promise;
      },
    },
  };
  let transport = connection.grpcTransport;
  runtime.transport = () => ({ ...transport });
  runtime.fetch = (...args) => {
    requests.push(args);
    let request = Promise.withResolvers();
    pending.push(request);
    return request.promise;
  };
  let options = {
    uuid: 'account',
    session: { account: connection, connect: () => connection.authorised, on() {} },
    onData: async (batch) => {
      changed.push(batch);
      return true;
    },
    log: { debug: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
    ...overrides,
  };
  let api = new GoogleProtobufAPI({ ...options, onData: (...args) => options.onData?.(...args) });
  context.after(() => api.disconnect());
  return {
    api,
    options,
    connection,
    requests,
    observations,
    pending,
    changed,
    logs,
  };
}

test('Google Observe normal completion restarts after one second; duplicate starts do not open streams', async (context) => {
  let flow = setup(context);
  await flow.api.connect();
  await flow.api.connect();
  assert.equal(flow.observations.length, 1);
  flow.pending[0].resolve({ status: 0 });
  await setImmediate();
  context.mock.timers.tick(999);
  assert.equal(flow.observations.length, 1);
  context.mock.timers.tick(1);
  assert.equal(flow.observations.length, 2);
  flow.api.disconnect();
  flow.pending[1].resolve({ status: 14 });
  await setImmediate();
  context.mock.timers.tick(120000);
  assert.equal(flow.observations.length, 2);
});

test('Google Observe rejection backs off and a processed update resets the retry delay', async (context) => {
  let flow = setup(context);
  await flow.api.connect();
  flow.pending[0].reject(new Error('network unavailable'));
  await setImmediate();
  context.mock.timers.tick(5000);
  await flow.observations[1][4]({ observeResponse: [] });
  flow.pending[1].reject(new Error('network unavailable again'));
  await setImmediate();
  context.mock.timers.tick(4999);
  assert.equal(flow.observations.length, 2);
  context.mock.timers.tick(1);
  assert.equal(flow.observations.length, 3);
});

test('google API does not start without authorisation', async (context) => {
  let flow = setup(context);
  flow.connection.authorised = false;
  await assert.rejects(flow.api.connect(), /Unable to authenticate/);
  assert.equal(flow.pending.length, 0);
});
test('google API cannot restart a disconnected shared session', async (context) => {
  let flow = setup(context);
  let client = new GoogleProtobufAPI({
    session: {
      account: flow.connection,
      on() {},
      connect: async () => {
        throw new Error('Account session has been disconnected');
      },
    },
  });
  context.after(() => client.disconnect());
  await assert.rejects(client.connect(), /session has been disconnected/);
  assert.equal(flow.pending.length, 0);
});
test('google stopped-run callbacks cannot affect a restart on the same account', async (context) => {
  let flow = setup(context);
  await flow.api.connect();
  flow.api.disconnect();
  await flow.api.connect();

  await flow.observations[0][4]({
    traitStates: [{ traitId: { resourceId: 'DEVICE_OLD', traitLabel: 'fixture' }, stateTypes: ['ACCEPTED'], patch: { values: {} } }],
  });
  flow.pending[0].resolve({ status: 16 });
  await flow.observations[1][4]({ observeResponse: [] });

  await setImmediate();
  assert.equal(flow.api.resources.get('DEVICE_OLD'), undefined);
  assert.equal(flow.changed.length, 1);
  assert.equal(flow.connection.authorised, true);
});

for (let type of [ACCOUNT_TYPE.GOOGLE, ACCOUNT_TYPE.NEST]) {
  test('Google Observe trait selection for account type ' + type, async (context) => {
    let flow = setup(context);
    flow.connection.type = type;
    runtime.types = [
      '.nest.trait.device.Identity',
      '.nest.trait.device.Identity',
      '.weave.trait.Power',
      '.nest.trait.product.camera.Camera',
      '.nest.trait.product.doorbell.Doorbell',
      '.google.trait.product.camera.Camera',
      '.unrelated.Device',
    ].map((fullName) => ({ fullName }));
    await flow.api.connect();
    let traits = flow.observations[0][3].traitTypeParams.map((entry) => entry.traitType);
    assert.equal(new Set(traits).size, traits.length);
    assert.equal(traits.includes('unrelated.Device'), false);
    assert.equal(traits.includes('google.trait.product.camera.Camera'), type === ACCOUNT_TYPE.GOOGLE);
    assert.equal(traits.includes('nest.trait.product.camera.Camera'), type === ACCOUNT_TYPE.GOOGLE);
    assert.equal(traits.includes('nest.trait.product.doorbell.Doorbell'), type === ACCOUNT_TYPE.GOOGLE);
  });
}

test('Google Observe with no schemas does not open or schedule a subscription', async (context) => {
  let flow = setup(context);
  runtime.types = [];
  await flow.api.connect();
  assert.equal(
    flow.logs.some((entry) => entry[0].includes('no observable protobuf traits')),
    true,
  );
  flow.api.disconnect();
  await flow.api.connect();
  context.mock.timers.tick(120000);
  assert.equal(flow.observations.length, 0);
});

test('Google Observe favours ACCEPTED patches and removes resources through the platform boundary', async (context) => {
  let callerCache = { DEVICE_OLD: { source: DATA_SOURCE.PROTOBUF, value: {} } };
  let flow = setup(context, { rawData: callerCache });
  flow.api.resources.set('DEVICE_OLD', structuredClone(callerCache.DEVICE_OLD));
  await flow.api.connect();
  await flow.observations[0][4]({
    resourceMetas: [{ resourceId: 'DEVICE_OLD', status: 'REMOVED' }],
    traitStates: [
      {
        traitId: { resourceId: 'DEVICE_NEW', traitLabel: 'fixture' },
        stateTypes: ['ACCEPTED'],
        patch: { values: { '@type': 'metadata', enabled: true } },
      },
      { traitId: { resourceId: 'DEVICE_NEW', traitLabel: 'fixture' }, stateTypes: ['CONFIRMED'], patch: { values: { enabled: false } } },
    ],
  });
  assert.equal(callerCache.DEVICE_NEW, undefined, 'API publication must not mutate the caller cache');
  assert.ok(callerCache.DEVICE_OLD, 'The caller cache is independent of API-owned resources');
  assert.equal(flow.api.resources.has('DEVICE_OLD'), false);
  assert.deepEqual(flow.api.resources.get('DEVICE_NEW').value.fixture, { enabled: true });
  assert.deepEqual(flow.changed[0].changes[0], { resourceId: 'DEVICE_OLD', remove: true, notify: true });
  assert.deepEqual(flow.changed[0].changes[1].value.fixture, { enabled: true });
  assert.deepEqual([...flow.changed[0].changes[1].fields], ['fixture']);
});

test('google retirement during awaited ingestion cannot mutate a replacement subscription', async (context) => {
  let weather = Promise.withResolvers();
  let flow = setup(context);

  let publish = flow.options.onData;
  flow.options.onData = async (batch) => {
    await weather.promise;
    if (batch.isCurrent() === true) {
      return await publish(batch);
    }
    return false;
  };

  await flow.api.connect();
  let callback;

  callback = flow.observations[0][4]({
    traitStates: [
      {
        traitId: { resourceId: 'STRUCTURE_HOME', traitLabel: 'structure_location' },
        stateTypes: ['ACCEPTED'],
        patch: { values: { postalCode: { value: '2000' }, countryCode: { value: 'AU' } } },
      },
    ],
  });

  flow.api.disconnect();
  await flow.api.connect();
  let resources = structuredClone([...flow.api.resources]);
  weather.resolve({ current_temperature: 99 });
  await callback;
  await setImmediate();
  assert.deepEqual([...flow.api.resources], resources, 'retired ingestion cannot change the replacement cache');
  assert.deepEqual(flow.changed, []);
});

for (let [label, resourceId, values] of [
  ['blank resource', ' ', {}],
  ['non-string resource', 123, {}],
  ['null settings', 'DEVICE_TEST', null],
  ['array settings', 'DEVICE_TEST', []],
  ['boolean settings', 'DEVICE_TEST', true],
]) {
  test('google SET rejects ' + label + ' before resource lookup', async (context) => {
    let flow = setup(context);
    context.mock.method(flow.api.resources, 'get', () => assert.fail('Invalid SET reached lookup'));
    await assert.rejects(flow.api.set(resourceId, values), /SET requires valid parameters/);
    assert.equal(flow.requests.length, 0);
  });
}
for (let resource of [undefined, null, {}, { source: 'other' }, { source: 'Nest' }, { source: DATA_SOURCE.HOMEGRAPH }]) {
  test('google SET rejects unavailable/wrong-source resource: ' + JSON.stringify(resource), async (context) => {
    let flow = setup(context);
    flow.api.resources.set('DEVICE_TEST', resource);
    await assert.rejects(flow.api.set('DEVICE_TEST', { temperature_scale: 'C' }), /SET requires an available/);
    assert.equal(flow.requests.length, 0);
  });
}
test('google SET checks authorisation before looking up a resource', async (context) => {
  let flow = setup(context);
  context.mock.method(flow.api.resources, 'get', () => assert.fail('Unauthorised SET reached lookup'));
  flow.connection.authorised = false;
  await assert.rejects(flow.api.set('DEVICE_TEST', {}), /authorised device account/);
});

for (let outcome of ['committed', 'rejected', 'retired']) {
  test('Google owns image state independently of consumer acknowledgement: ' + outcome, async (context) => {
    let commit = Promise.withResolvers();
    let flow = setup(context, { onData: () => commit.promise });
    await flow.api.connect();
    let image = { liveImageUrl: 'https://image.invalid/new' };
    let update = flow.observations[0][4]({
      traitStates: [
        { traitId: { resourceId: 'DEVICE_TEST', traitLabel: 'upload_live_image' }, stateTypes: ['ACCEPTED'], patch: { values: image } },
      ],
    });
    await setImmediate();
    assert.deepEqual(flow.api.resources.get('DEVICE_TEST').value.upload_live_image, image);
    if (outcome === 'retired') {
      flow.api.disconnect();
    }
    commit.resolve(outcome !== 'rejected');
    await update;
    assert.deepEqual(flow.api.resources.get('DEVICE_TEST').value.upload_live_image, image);
  });
}

for (let [label, resourceId, key, values] of [
  ['null values', 'DEVICE_TEST', 'camera_snapshot', null],
  ['boolean values', 'DEVICE_TEST', 'camera_snapshot', true],
  ['array values', 'DEVICE_TEST', 'camera_snapshot', []],
  ['string values', 'DEVICE_TEST', 'camera_snapshot', 'invalid'],
  ['blank resource', ' ', 'camera_snapshot', {}],
  ['non-string resource', 123, 'camera_snapshot', {}],
  ['blank key', 'DEVICE_TEST', ' ', {}],
  ['non-string key', 'DEVICE_TEST', null, {}],
]) {
  test('google GET rejects ' + label + ' before lookup or network work', async (context) => {
    let flow = setup(context);
    context.mock.method(flow.api.resources, 'get', () => assert.fail('Invalid GET reached resource lookup'));
    await assert.rejects(flow.api.get(resourceId, key, values), /GET requires valid query parameters/);
    assert.equal(flow.requests.length, 0);
  });
}
for (let key of ['camera_snapshot', 'camera_events', 'location_weather']) {
  test('google GET rejects missing resources for ' + key, async (context) => {
    let flow = setup(context);
    await assert.rejects(flow.api.get('DEVICE_MISSING', key), /GET requires an available resource/);
    assert.equal(flow.requests.length, 0);
  });
  test('google GET rejects unauthorised accounts for ' + key, async (context) => {
    let flow = setup(context);
    context.mock.method(flow.api.resources, 'get', () => assert.fail('Unauthorised GET reached resource lookup'));
    flow.connection.authorised = false;
    await assert.rejects(flow.api.get('DEVICE_TEST', key, { location: { postal_code: '2000', country_code: 'AU' } }), /authorised account/);
    assert.equal(flow.requests.length, 0);
  });
}
for (let key of ['camera_snapshot', 'camera_events']) {
  for (let missing of ['device type', 'transport']) {
    test('google GET rejects unavailable ' + key + ' at entry: ' + missing, async (context) => {
      let flow = setup(context);
      let id = 'DEVICE_TEST';
      flow.connection.cameraAPIHost = 'camera.invalid';
      flow.connection.cameraAuth = { key: 'Authorization', value: 'Basic ', token: 'fixture' };
      flow.connection.grpcTransport.command = async () => assert.fail('Unavailable camera query reached the transport');
      if (missing === 'device type') {
        id = 'structure.home';
      }

      await flow.api.connect();
      if (missing === 'transport') {
        flow.api.disconnect();
      }

      flow.api.resources.set(id, {
        value: { device_info: { typeName: 'google.resource.SpencerResource' } },
      });
      assert.deepEqual(await flow.api.get(id, key), key === 'camera_events' ? [] : undefined);
      assert.equal(flow.requests.length, 0);
    });
  }
}

test('Google publishes structure location without fetching or adding REST weather', async (context) => {
  let flow = setup(context);
  let location = { postalCode: { value: '2000' }, countryCode: { value: 'AU' } };
  await flow.api.connect();
  await flow.observations[0][4]({
    traitStates: [
      {
        traitId: { resourceId: 'STRUCTURE_HOME', traitLabel: 'structure_location' },
        stateTypes: ['ACCEPTED'],
        patch: { values: location },
      },
    ],
  });
  assert.deepEqual(flow.changed[0].changes[0].value, { structure_location: location });
  assert.deepEqual([...flow.changed[0].changes[0].fields], ['structure_location']);
  assert.equal(flow.requests.length, 0);
  assert.equal(flow.api.resources.get('STRUCTURE_HOME').value.weather, undefined);
});

test('google client connects, stores data, reads values and sends settings without System or notification callbacks', async (context) => {
  let flow = setup(context);
  let commands = [];
  flow.connection.grpcTransport.command = async (...args) => {
    commands.push(args);
    return { status: 0, data: [{ traitOperations: [{ progress: 'COMPLETE' }] }] };
  };
  let client = new GoogleProtobufAPI({
    session: {
      account: flow.connection,
      connect: async () => true,
      on() {},
    },
  });
  context.after(() => client.disconnect());
  await client.connect();
  let id = 'DEVICE_TEST';
  let value = { temperatureScale: 'TEMPERATURE_SCALE_C' };

  await flow.observations[0][4]({
    traitStates: [{ traitId: { resourceId: id, traitLabel: 'display_settings' }, stateTypes: ['ACCEPTED'], patch: { values: value } }],
  });

  let key = 'display_settings';
  assert.deepEqual(await client.get(id, key), value);
  assert.equal(await client.get(id, 'constructor'), undefined);

  await client.set(id, { temperature_scale: 'F' });
  assert.equal(commands[0][3].batchUpdateStateRequest[0].state.value.temperatureScale, 'TEMPERATURE_SCALE_F');
  let read = await client.get(id, key);
  read.temperatureScale = 'CHANGED_BY_CALLER';
  assert.equal((await client.get(id, key)).temperatureScale, 'TEMPERATURE_SCALE_C');
});

for (let active of [true, false]) {
  test('standalone Google sensor selection resolves its observed parent: ' + active, async (context) => {
    let flow = setup(context);
    let commands = [];
    flow.connection.grpcTransport.command = async (...args) => {
      commands.push(args);
      return { status: 0, data: [{ traitOperations: [{ progress: 'COMPLETE' }] }] };
    };
    await flow.api.connect();
    await flow.observations[0][4]({
      traitStates: [
        {
          traitId: { resourceId: 'DEVICE_SENSOR', traitLabel: 'device_identity' },
          stateTypes: ['ACCEPTED'],
          patch: { values: { serialNumber: 'SENSOR' } },
        },
        {
          traitId: { resourceId: 'DEVICE_PARENT', traitLabel: 'remote_comfort_sensing_settings' },
          stateTypes: ['ACCEPTED'],
          patch: {
            values: {
              associatedRcsSensors: [{ deviceId: { resourceId: 'DEVICE_SENSOR' } }],
              activeRcsSelection: { activeRcsSensor: { resourceId: 'DEVICE_SENSOR' } },
              rcsControlMode: 'RCS_CONTROL_MODE_SCHEDULE',
              rcsControlSchedule: { fixture: true },
            },
          },
        },
      ],
    });
    await flow.api.set('DEVICE_SENSOR', { active_sensor: active });
    let update = commands[0][3].batchUpdateStateRequest[0];
    assert.equal(update.traitRequest.resourceId, 'DEVICE_PARENT');
    assert.equal(
      update.state.value.activeRcsSelection.rcsSourceType,
      active === true ? 'RCS_SOURCE_TYPE_SINGLE_SENSOR' : 'RCS_SOURCE_TYPE_BACKPLATE',
    );
    assert.equal(update.state.value.rcsControlMode, active === true ? 'RCS_CONTROL_MODE_SCHEDULE_OVERRIDE' : 'RCS_CONTROL_MODE_HOLD');
    assert.deepEqual(update.state.value.rcsControlSchedule, { fixture: true });
    assert.equal(flow.api.resources.get('DEVICE_PARENT').value.remote_comfort_sensing_settings.rcsControlMode, 'RCS_CONTROL_MODE_SCHEDULE');
    assert.equal(flow.api.resources.get('DEVICE_SENSOR').value.associated_thermostat, undefined);
  });
}

for (let mode of ['RCS_CONTROL_MODE_HOLD', 'RCS_CONTROL_MODE_SCHEDULE', 'RCS_CONTROL_MODE_SCHEDULE_OVERRIDE']) {
  test('Google thermostat selection switches to backplate from ' + mode, async (context) => {
    let flow = setup(context);
    let commands = [];
    let rejectCommand = false;
    flow.connection.grpcTransport.command = async (...args) => {
      if (rejectCommand === true) {
        return { status: 14 };
      }
      commands.push(args);
      return { status: 0, data: [{ traitOperations: [{ progress: 'COMPLETE' }] }] };
    };
    await flow.api.connect();
    let settings = {
      rcsControlMode: mode,
      activeRcsSelection: { activeRcsSensor: { resourceId: 'DEVICE_SENSOR' } },
      associatedRcsSensors: [{ deviceId: { resourceId: 'DEVICE_SENSOR' } }],
      rcsControlSchedule: { fixture: true },
    };
    flow.api.resources.set('DEVICE_PARENT', { source: DATA_SOURCE.PROTOBUF, value: { remote_comfort_sensing_settings: settings } });
    await flow.api.set('DEVICE_PARENT', { active_sensor: true });
    let update = commands[0][3].batchUpdateStateRequest[0];
    assert.equal(update.traitRequest.resourceId, 'DEVICE_PARENT');
    assert.deepEqual(update.state.value, {
      ...settings,
      rcsControlMode: 'RCS_CONTROL_MODE_HOLD',
      activeRcsSelection: { rcsSourceType: 'RCS_SOURCE_TYPE_BACKPLATE' },
    });
    assert.equal(settings.rcsControlMode, mode);
    for (let invalid of [false, 'true', 1, null]) {
      await assert.rejects(flow.api.set('DEVICE_PARENT', { active_sensor: invalid }), AggregateError);
    }
    rejectCommand = true;
    await assert.rejects(flow.api.set('DEVICE_PARENT', { active_sensor: true }), AggregateError);
    assert.equal(settings.rcsControlMode, mode);
    assert.equal(commands.length, 1);
  });
}

test('google rejects stale remote deselection without clearing the replacement', async (context) => {
  let flow = setup(context);
  let commands = [];

  flow.connection.grpcTransport.command = async (...args) => {
    commands.push(args);
  };
  await flow.api.connect();
  flow.api.resources.set('DEVICE_SENSOR', { source: DATA_SOURCE.PROTOBUF, value: {} });
  flow.api.resources.set('DEVICE_PARENT', {
    source: DATA_SOURCE.PROTOBUF,
    value: {
      remote_comfort_sensing_settings: {
        associatedRcsSensors: [{ deviceId: { resourceId: 'DEVICE_SENSOR' } }],
        activeRcsSelection: { activeRcsSensor: { resourceId: 'DEVICE_REPLACEMENT' } },
      },
    },
  });

  let before = structuredClone([...flow.api.resources]);
  await assert.rejects(flow.api.set('DEVICE_SENSOR', { active_sensor: false }), AggregateError);
  assert.deepEqual([...flow.api.resources], before);
  assert.equal(commands.length, 0);
  assert.equal(flow.requests.length, 0);
  // A related resource from the other source cannot authorise a parent write.
  flow.api.resources.get('DEVICE_PARENT').source = DATA_SOURCE.HOMEGRAPH;
  await assert.rejects(flow.api.set('DEVICE_SENSOR', { active_sensor: true }), AggregateError);
  assert.equal(commands.length, 0);
  assert.equal(flow.requests.length, 0);
});

test('Google snapshots complete from the client cache while a consumer notification is still pending', async (context) => {
  let flow = setup(context);
  let commit = Promise.withResolvers();
  context.after(() => commit.resolve(true));
  flow.connection.grpcTransport.command = async () => ({
    status: 0,
    data: [
      {
        traitOperations: [
          {
            progress: 'COMPLETE',
            event: { event: { status: 'STATUS_SUCCESSFUL' } },
          },
        ],
      },
    ],
  });
  flow.api.resources.set('DEVICE_TEST', {
    source: DATA_SOURCE.PROTOBUF,
    value: {
      device_info: { typeName: 'google.resource.SpencerResource' },
    },
  });
  runtime.fetch = async () => new Response(new Uint8Array([1, 2, 3]));
  await flow.api.connect();
  flow.options.onData = () => commit.promise;
  let snapshot = flow.api.get('DEVICE_TEST', 'camera_snapshot');
  await setImmediate();
  let update = flow.observations[0][4]({
    traitStates: [
      {
        traitId: { resourceId: 'DEVICE_TEST', traitLabel: 'upload_live_image' },
        stateTypes: ['ACCEPTED'],
        patch: {
          values: {
            liveImageUrl: 'https://nest-camera-media.googleapis.com/download/thumbnails/fixture/account/devices/DEVICE_TEST/id/fresh',
          },
        },
      },
    ],
  });
  assert.deepEqual(await snapshot, Buffer.from([1, 2, 3]));
  commit.resolve(true);
  await update;
});

test('google retries a rejected removal notification after its own cache already removed the resource', async (context) => {
  let flow = setup(context);
  await flow.api.connect();
  let id = 'DEVICE_TEST';

  await flow.observations[0][4]({
    traitStates: [
      {
        traitId: { resourceId: id, traitLabel: 'fixture' },
        stateTypes: ['ACCEPTED'],
        patch: { values: { active: true } },
      },
    ],
  });

  assert.equal(flow.api.resources.has(id), true);
  let attempts = 0;
  flow.options.onData = async (batch) => {
    if (batch.changes.some((change) => change.resourceId === id && change.remove === true) === true) {
      attempts++;
      if (attempts === 1) {
        throw new Error('Fixture consumer failed to remove the device');
      }
    }
    return true;
  };

  await assert.rejects(flow.observations[0][4]({ resourceMetas: [{ resourceId: id, status: 'REMOVED' }] }), /consumer failed/);
  assert.equal(flow.api.resources.has(id), false);
  await flow.observations[0][4]({ observeResponse: [] });

  assert.equal(attempts, 2, 'the consumer must receive the removal again instead of losing it with the cached resource');
  assert.equal(flow.api.resources.has(id), false);
});

test('google accepts authentication only through its session', async (context) => {
  let flow = setup(context);
  let client = new GoogleProtobufAPI({ account: flow.connection });
  context.after(() => client.disconnect());
  await assert.rejects(client.connect(), /Unable to authenticate/);
  await assert.rejects(client.get('DEVICE_TEST', 'fixture'), /authorised account/);
  assert.equal(flow.pending.length, 0);
});

test('google reads the current session account instead of retaining a parallel credential record', async (context) => {
  let flow = setup(context);
  let session = { account: { authorised: false }, on() {} };
  let client = new GoogleProtobufAPI({ session });
  context.after(() => client.disconnect());
  client.resources.set('DEVICE_TEST', { value: { fixture: { enabled: true } } });
  await assert.rejects(client.get('DEVICE_TEST', 'fixture'), /authorised account/);
  session.account = { ...flow.connection, authorised: true };
  assert.deepEqual(await client.get('DEVICE_TEST', 'fixture'), { enabled: true });
  assert.equal(flow.pending.length, 0);
});

test('google does not silently accept a HomeKit routing field as an API setting', async (context) => {
  let flow = setup(context);
  let id = 'DEVICE_TEST';
  flow.api.resources.set(id, { source: DATA_SOURCE.PROTOBUF, value: {} });

  await flow.api.connect();

  await assert.rejects(flow.api.set(id, { uuid: id }), AggregateError);
  assert.equal(flow.requests.length, 0);
});

test('Google settings require explicit connection startup before using the command transport', async (context) => {
  let flow = setup(context);
  let value = { display_settings: { temperatureScale: 'TEMPERATURE_SCALE_C' } };
  flow.api.resources.set('DEVICE_TEST', { source: DATA_SOURCE.PROTOBUF, value: structuredClone(value) });
  let command = context.mock.fn(async () => ({ status: 0, data: [{ traitOperations: [{ progress: 'COMPLETE' }] }] }));
  flow.connection.grpcTransport.command = command;
  await assert.rejects(flow.api.set('DEVICE_TEST', { temperature_scale: 'F' }), /command transport is unavailable/);
  assert.equal(command.mock.callCount(), 0);
  assert.equal(flow.observations.length, 0);
  await flow.api.connect();
  await flow.api.set('DEVICE_TEST', { temperature_scale: 'F' });
  assert.equal(command.mock.callCount(), 1);
  assert.equal(flow.observations.length, 1);
  assert.deepEqual(flow.api.resources.get('DEVICE_TEST').value, value);
});

test('protobuf home notifications use source-named routing while retaining the raw RTS identity', async (context) => {
  let flow = setup(context);
  await flow.api.connect();
  await flow.observations[0][4]({
    observeResponse: [
      {
        traitStates: [
          {
            traitId: { resourceId: 'STRUCTURE_HOME', traitLabel: 'structure_info' },
            stateTypes: ['ACCEPTED'],
            patch: { values: { name: 'Fixture', rtsStructureId: 'rest-home' } },
          },
        ],
      },
    ],
  });
  let change = flow.changed.flatMap((batch) => batch.changes).find((item) => item.resourceId === 'STRUCTURE_HOME');
  assert.deepEqual(change.home, { name: 'Fixture', values: { protobuf_home_uuid: 'STRUCTURE_HOME' } });
  assert.equal(change.value.structure_info.rtsStructureId, 'rest-home');
});
