// Exercise retained Nest subscriptions and Google Observe restarts through the real platform cache and lifecycle.
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { DATA_SOURCE, DEVICE_TYPE } from '../src/consts.js';
import { platformHarness } from './helpers/platform-harness.js';

for (let status of [401, 403]) {
  test('Nest subscription authentication failure ' + status + ' stops polling and invalidates the account', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let flow = await platformHarness(context, {
      subscribe: async () => {
        throw Object.assign(new Error('Fixture unauthorised'), { status });
      },
    });
    await setImmediate();
    assert.equal(flow.connection.authorised, false);
    assert.equal(
      flow.logs.some((entry) => entry[0] === 'unauthorised' && entry[2] === 'nest-api-' + status),
      true,
    );
    let count = flow.requests.length;
    context.mock.timers.tick(120000);
    await setImmediate();
    assert.equal(flow.requests.length, count);
  });
}
test('Nest subscription backs off to its cap and resets after successful ingestion', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  await platformHarness(context, {
    subscribe: async () => {
      if (attempts++ < 5) {
        throw new Error('Fixture subscription unavailable');
      }
      return { json: async () => ({ objects: [] }) };
    },
  });
  await setImmediate();
  assert.equal(attempts, 1);
  for (let delay of [5000, 10000, 20000, 40000, 60000]) {
    let before = attempts;
    context.mock.timers.tick(delay - 1);
    await setImmediate();
    assert.equal(attempts, before);
    context.mock.timers.tick(1);
    await setImmediate();
    assert.equal(attempts, before + 1);
  }
  context.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(attempts, 7);
});
test('Nest topology removal unregisters the accessory and requests a full refresh', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let batches = [
    {
      updated_buckets: [
        { object_key: 'topaz.TEST', object_revision: 1, object_timestamp: 10, value: { serial_number: 'FIXTURE', smoke_status: 0 } },
        { object_key: 'buckets.home', value: { buckets: ['topaz.TEST'] } },
      ],
    },
    { objects: [{ object_key: 'buckets.home', value: { buckets: [] } }] },
    { updated_buckets: [] },
  ];
  let flow = await platformHarness(context, {
    source: DATA_SOURCE.NEST,
    id: 'topaz.TEST',
    subscribe: async () => ({ json: async () => batches.shift() ?? {} }),
  });
  await setImmediate();
  assert.equal(flow.registered.length, 1);
  let accessory = flow.device.accessory;
  context.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(flow.raw['topaz.TEST'], undefined);
  assert.deepEqual(flow.removed, [accessory]);
  let subscription = flow.requests.find((request) => String(request[1]).includes('/v5/subscribe') === true);
  assert.deepEqual(
    subscription[3].objects.find((entry) => entry.object_key === 'topaz.TEST'),
    { object_key: 'topaz.TEST', object_revision: 1, object_timestamp: 10 },
  );
  context.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(flow.requests.filter((request) => String(request[1]).includes('/app_launch') === true).length, 2);
  context.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(flow.requests.at(-1)[3].objects, undefined, 'an empty full discovery clears the old cursor and requires another full read');
  assert.equal(flow.requests.filter((request) => String(request[1]).includes('/app_launch') === true).length, 3);
  assert.equal(flow.raw['buckets.home'].object_revision, undefined, 'System no longer stores subscription metadata');
});
for (let order of ['swarm first', 'buckets first', 'separate replies']) {
  test('Nest removal preserves accessory identity with ' + order, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let swarm = { object_key: 'structure.home', value: { swarm: [] } };
    let buckets = { object_key: 'buckets.home', value: { buckets: [] } };
    let batches = [
      {
        updated_buckets: [
          { object_key: 'structure.home', value: { name: 'Home', swarm: ['topaz.TEST'] } },
          { object_key: 'buckets.home', value: { buckets: ['topaz.TEST'] } },
          { object_key: 'topaz.TEST', value: { serial_number: 'FIXTURE', smoke_status: 0 } },
        ],
      },
    ];
    batches.push(
      ...(order === 'separate replies'
        ? [{ objects: [swarm] }, { objects: [buckets] }]
        : [{ objects: order === 'swarm first' ? [swarm, buckets] : [buckets, swarm] }]),
    );
    let flow = await platformHarness(context, {
      source: DATA_SOURCE.NEST,
      id: 'topaz.TEST',
      subscribe: async () => ({ json: async () => batches.shift() ?? {} }),
    });
    await setImmediate();
    let accessory = flow.device.accessory;
    assert.equal(flow.registered.length, 1);
    context.mock.timers.tick(1000);
    await setImmediate();
    if (order === 'separate replies') {
      assert.equal(flow.raw['topaz.TEST'], undefined);
      context.mock.timers.tick(1000);
      await setImmediate();
    }
    assert.equal(flow.raw['topaz.TEST'], undefined);
    assert.deepEqual(flow.removed, [accessory]);
  });
}

test('Nest structure swarm removal evicts stale raw data and incremental updates preserve existing fields', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let batches = [
    {
      updated_buckets: [
        { object_key: 'structure.home', value: { name: 'Home', swarm: ['topaz.TEST'] } },
        { object_key: 'topaz.TEST', value: { serial_number: 'FIXTURE', smoke_status: 0, co_status: 0 } },
      ],
    },
    { objects: [{ object_key: 'topaz.TEST', value: { smoke_status: 1 } }] },
    { objects: [{ object_key: 'structure.home', value: { swarm: [] } }] },
  ];
  let flow = await platformHarness(context, {
    source: DATA_SOURCE.NEST,
    id: 'topaz.TEST',
    subscribe: async () => ({ json: async () => batches.shift() ?? {} }),
  });
  await setImmediate();
  context.mock.timers.tick(1000);
  await setImmediate();
  assert.deepEqual(flow.raw['topaz.TEST'].value, { serial_number: 'FIXTURE', smoke_status: 1, co_status: 0 });
  context.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(flow.raw['topaz.TEST'], undefined);
  assert.equal(flow.raw['structure.home'].value.name, 'Home');
  context.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(
    flow.requests.at(-1)[3].objects.some((entry) => entry.object_key === 'topaz.TEST'),
    false,
    'swarm removals also retire the bucket revision',
  );
});
for (let status of [16]) {
  test('Observe terminal authentication status ' + status + ' invalidates the account', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let flow = await platformHarness(context);
    flow.pending.resolve({ status });
    await setImmediate();
    assert.equal(flow.connection.authorised, false);
    context.mock.timers.tick(60000);
    await setImmediate();
    assert.equal(flow.observations.length, 1);
  });
}
test('Observe transient failures back off to the retry cap', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let flow = await platformHarness(context);
  flow.pending.resolve({ status: 14 });
  await setImmediate();
  for (let delay of [5000, 10000, 20000, 40000, 60000]) {
    let before = flow.observations.length;
    context.mock.timers.tick(delay - 1);
    await setImmediate();
    assert.equal(flow.observations.length, before);
    context.mock.timers.tick(1);
    await setImmediate();
    assert.equal(flow.observations.length, before + 1);
  }
});

test('Observe permission denial keeps the account and uses failure backoff', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let flow = await platformHarness(context);
  flow.pending.resolve({ status: 7 });
  await setImmediate();
  assert.equal(flow.connection.authorised, true);
  context.mock.timers.tick(4999);
  await setImmediate();
  assert.equal(flow.observations.length, 1);
  context.mock.timers.tick(1);
  await setImmediate();
  assert.equal(flow.observations.length, 2);
  assert.equal(
    flow.logs.some((entry) => entry[0] === 'unauthorised'),
    false,
  );
});
for (let status of [0, 16]) {
  test('retired Observe completion ' + status + ' cannot restart ingestion or invalidate refreshed credentials', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let flow = await platformHarness(context);
    let replacement = Promise.withResolvers();
    flow.connection.grpcTransport = {
      ...flow.connection.grpcTransport,
      observe: (...args) => {
        flow.observations.push(args);
        return replacement.promise;
      },
    };
    await flow.authorise('account', flow.connection, { wasAuthorised: true });
    flow.pending.resolve({ status });
    await setImmediate();
    assert.equal(flow.connection.authorised, true);
    context.mock.timers.tick(60000);
    await setImmediate();
    assert.equal(flow.observations.length, 2);
    replacement.resolve({ status: 0 });
  });
}

test('credential refresh resumes Observe updates without restarting Nest subscriptions or replacing accessories', async (context) => {
  let flow = await platformHarness(context);
  let oldCallback = flow.consume;
  let subscriptions = flow.requests.filter((request) => String(request[1]).includes('/app_launch') === true).length;
  let replacement = Promise.withResolvers();
  flow.connection.grpcTransport = {
    ...flow.connection.grpcTransport,
    observe: (...args) => {
      flow.observations.push(args);
      return replacement.promise;
    },
  };
  await flow.authorise('account', flow.connection, { wasAuthorised: true });
  assert.equal(flow.observations.length, 2);
  assert.equal(flow.requests.filter((request) => String(request[1]).includes('/app_launch') === true).length, subscriptions);
  let currentCallback = flow.observations.at(-1).at(-1);
  let message = (value) => ({
    traitStates: [
      { traitId: { resourceId: 'DEVICE_TEST', traitLabel: 'fixture' }, stateTypes: ['ACCEPTED'], patch: { values: { value } } },
    ],
  });
  await currentCallback(message('fresh'));
  let accessory = flow.device.accessory;
  await oldCallback(message('stale'));
  await oldCallback({ resourceMetas: [{ resourceId: 'DEVICE_TEST', status: 'REMOVED' }] });
  assert.equal(flow.raw.DEVICE_TEST.value.fixture.value, 'fresh');
  assert.equal(flow.device.accessory, accessory);
  assert.deepEqual(flow.removed, []);
  replacement.resolve({ status: 0 });
});

for (let status of [0, 14]) {
  test('credential refresh cancels the pending Observe retry after status ' + status, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let flow = await platformHarness(context, { type: DEVICE_TYPE.CAMERA });
    flow.pending.resolve({ status });
    await setImmediate();
    let replacement = Promise.withResolvers();
    flow.connection.grpcTransport = {
      ...flow.connection.grpcTransport,
      observe: (...args) => {
        flow.observations.push(args);
        return replacement.promise;
      },
    };
    let refresh = flow.authorise('account', flow.connection, { wasAuthorised: true });
    // The old retry must not fire while camera credential updates are pending.
    context.mock.timers.tick(60000);
    await refresh;
    assert.equal(flow.observations.length, 2);
    context.mock.timers.tick(60000);
    await setImmediate();
    assert.equal(flow.observations.length, 2);
    replacement.resolve({ status: 0 });
  });
}

test('slow accessory delivery coalesces state notifications while every source patch still commits', async (context) => {
  let flow = await platformHarness(context, {
    value: { fixture: { state: 0 } },
    map: (raw) => ({
      FIXTURE: {
        full: true,
        data: {
          serialNumber: 'FIXTURE',
          manufacturer: 'Nest',
          model: 'Fixture',
          softwareVersion: '1.0.0',
          description: 'Fixture',
          nest_google_device_uuid: 'DEVICE_TEST',
          excluded: false,
          state: raw.DEVICE_TEST.value.fixture.state,
        },
      },
    }),
  });
  let entered = Promise.withResolvers();
  let release = Promise.withResolvers();
  let delivered = [];
  let accessory = flow.device.accessory;
  context.mock.method(flow.device, 'onUpdate', async (data) => {
    delivered.push(data.state);
    if (data.state === 1) {
      entered.resolve();
      await release.promise;
    }
  });
  await flow.send('DEVICE_TEST', { fixture: { state: 1 } });
  await entered.promise;
  for (let state = 2; state <= 20; state++) {
    await flow.send('DEVICE_TEST', { fixture: { state } });
    assert.equal(flow.raw.DEVICE_TEST.value.fixture.state, state);
  }
  assert.deepEqual(delivered, [1]);
  release.resolve();
  await setImmediate();
  assert.deepEqual(delivered, [1, 20]);
  assert.equal(flow.device.deviceData.state, 20);
  assert.equal(flow.device.accessory, accessory);
});

test('resource removal during initial ADD cannot leave a newly published stale accessory', async (context) => {
  let entered = Promise.withResolvers();
  let release = Promise.withResolvers();
  let flow = await platformHarness(context, {
    onAdd: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  await entered.promise;
  await flow.consume({ resourceMetas: [{ resourceId: 'DEVICE_TEST', status: 'REMOVED' }] });
  assert.equal(flow.raw.DEVICE_TEST, undefined);
  release.resolve();
  await setImmediate();
  assert.equal(flow.removed.length, 1);
  assert.equal(flow.removed[0], flow.registered[0]);
});

test('two account sources cannot create the same accessory while initial ADD is pending', async (context) => {
  let release = Promise.withResolvers();
  let flow = await platformHarness(context, { onAdd: () => release.promise });
  let second = { ...flow.connection, nestAPI: undefined, googleAPI: undefined, dataQueue: Promise.resolve() };
  flow.accounts.set('second', second);
  await flow.authorise('second', second);
  let consume = flow.observations.at(-1)[4];
  await consume({
    traitStates: [
      { traitId: { resourceId: 'DEVICE_TEST', traitLabel: 'fixture' }, stateTypes: ['ACCEPTED'], patch: { values: { newer: true } } },
    ],
  });
  assert.equal(flow.raw.DEVICE_TEST.connection, 'second');
  release.resolve();
  await setImmediate();
  assert.equal(flow.registered.length, 1);
  assert.equal(
    flow.logs.some((entry) => String(entry[1]).includes('Device reconciliation failed')),
    false,
  );
  second.nestAPI.disconnect();
  second.googleAPI.disconnect();
});

for (let googleSelected of [false, true]) {
  test('Nest shared-resource removal honours selected source; Google=' + googleSelected, async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let batches = [
      {
        updated_buckets: [
          { object_key: 'buckets.home', value: { buckets: ['device.TEST'] } },
          { object_key: 'device.TEST', value: { serial_number: 'FIXTURE' } },
        ],
      },
      { objects: [{ object_key: 'buckets.home', value: { buckets: [] } }] },
    ];
    let flow = await platformHarness(context, {
      source: DATA_SOURCE.NEST,
      id: 'device.TEST',
      subscribe: async () => ({ json: async () => batches.shift() ?? {} }),
      map: (raw) => {
        let id = raw.DEVICE_GOOGLE !== undefined ? 'DEVICE_GOOGLE' : 'device.TEST';
        return raw[id] === undefined
          ? {}
          : Object.fromEntries(
              ['FIXTURE', 'HEATLINK'].map((serialNumber) => [
                serialNumber,
                {
                  full: true,
                  data: {
                    serialNumber,
                    manufacturer: 'Nest',
                    model: 'Fixture',
                    softwareVersion: '1.0.0',
                    description: serialNumber,
                    nest_google_device_uuid: id,
                    excluded: false,
                  },
                },
              ]),
            );
      },
    });
    assert.equal(flow.registered.length, 2);
    if (googleSelected === true) {
      await flow.send('DEVICE_GOOGLE', { device_identity: { serialNumber: 'FIXTURE' } });
      assert.equal(flow.device.deviceData.nest_google_device_uuid, 'DEVICE_GOOGLE');
    }
    context.mock.timers.tick(1000);
    await setImmediate();
    assert.equal(flow.raw['device.TEST'], undefined);
    assert.equal(flow.removed.length, googleSelected === true ? 0 : 2);
    assert.equal(flow.registered.length, 2);
  });
}
