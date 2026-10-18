// Exercise retained Nest subscriptions and Google Observe restarts through the real platform cache and lifecycle.
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { DATA_SOURCE } from '../src/consts.js';
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
    assert.equal(flow.connection.subscribeTimer, undefined);
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
  let flow = await platformHarness(context, {
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
    assert.equal(flow.connection.subscribeRetryDelay, delay);
    context.mock.timers.tick(delay - 1);
    await setImmediate();
    assert.equal(attempts, before);
    context.mock.timers.tick(1);
    await setImmediate();
    assert.equal(attempts, before + 1);
  }
  assert.equal(flow.connection.subscribeRetryDelay, undefined);
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
});
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
});
for (let status of [16]) {
  test('Observe terminal authentication status ' + status + ' invalidates the account', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let flow = await platformHarness(context);
    flow.pending.resolve({ status });
    await setImmediate();
    assert.equal(flow.connection.authorised, false);
    assert.equal(flow.connection.observeTimer, undefined);
    context.mock.timers.tick(60000);
    await setImmediate();
    assert.equal(flow.observations.length, 1);
  });
}
test('Observe transient failures back off and token refresh does not duplicate ingestion loops', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let flow = await platformHarness(context);
  await flow.authorise('account', flow.connection, { wasAuthorised: true });
  assert.equal(flow.observations.length, 1);
  flow.pending.resolve({ status: 14 });
  await setImmediate();
  for (let delay of [5000, 10000, 20000, 40000, 60000]) {
    let before = flow.observations.length;
    assert.equal(flow.connection.observeRetryDelay, delay);
    context.mock.timers.tick(delay);
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
  assert.equal(flow.connection.observeRetryDelay, 5000);
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
    await flow.authorise('account', flow.connection, { wasAuthorised: false });
    flow.pending.resolve({ status });
    await setImmediate();
    assert.equal(flow.connection.authorised, true);
    assert.equal(flow.connection.observeTimer, undefined);
    context.mock.timers.tick(60000);
    await setImmediate();
    assert.equal(flow.observations.length, 2);
    replacement.resolve({ status: 0 });
  });
}

test('retired Observe callbacks cannot overwrite newer data or remove a replacement accessory', async (context) => {
  let flow = await platformHarness(context);
  let oldCallback = flow.consume;
  let replacement = Promise.withResolvers();
  flow.connection.grpcTransport = {
    ...flow.connection.grpcTransport,
    observe: (...args) => {
      flow.observations.push(args);
      return replacement.promise;
    },
  };
  await flow.authorise('account', flow.connection, { wasAuthorised: false });
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
