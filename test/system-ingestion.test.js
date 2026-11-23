// Exercise protobuf Observe restarts through the real platform cache and lifecycle.
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { DEVICE_TYPE } from '../src/consts.js';
import { platformHarness } from './helpers/platform-harness.js';

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
