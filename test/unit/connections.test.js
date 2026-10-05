// Test account lifecycle through public APIs with isolated HTTP responses and mocked timers.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { URL } from 'node:url';
import test from 'node:test';

let networkModule =
  'data:text/javascript,' +
  encodeURIComponent(
    'export const network = { request() { throw new Error("Unexpected HTTP request"); } }; ' +
      'export function fetchWrapper(...args) { return network.request(...args); }',
  );
let { network } = await import(networkModule);
// Forward named timer imports to the per-test Node timer mocks.
let timerModule =
  'data:text/javascript,' +
  encodeURIComponent(
    'import timers from "node:timers"; ' +
      'export function setTimeout(...args) { return timers.setTimeout(...args); } ' +
      'export function clearTimeout(...args) { return timers.clearTimeout(...args); }',
  );
let location = new URL('../../src/connections.js', import.meta.url);
let source = await readFile(location, 'utf8');
source = source.replace(/from '([^']+)'/g, (match, specifier) => {
  let target =
    specifier === './fetchWrapper.js'
      ? networkModule
      : specifier === 'node:timers'
        ? timerModule
        : specifier.startsWith('.') === true
          ? new URL(specifier, location).href
          : specifier;
  return 'from ' + JSON.stringify(target);
});
let { default: Connections } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
let account = { name: 'Test', type: 'nest', access_token: 'access-token' };
let session = { access_token: 'session-token', userid: 'user', urls: { transport_url: 'https://transport.example' } };
let response = (value) => ({ json: async () => value });

function setup(t, accounts = [account], options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let manager = Connections.fromConfig({ accounts }, options);
  t.after(() => manager.shutdown());
  let [uuid, connection] = manager.entries().next().value ?? [];
  return { manager, uuid, connection };
}

test('Connections builds isolated runtime entries and skips excluded/invalid accounts', (t) => {
  let { manager } = setup(t, [
    account,
    { ...account, name: 'Field', fieldTest: true },
    { ...account, name: 'Excluded', exclude: true },
    { ...account, name: ' ' },
    { ...account, access_token: '' },
  ]);
  assert.equal(manager.size, 2);
  let entries = [...manager.entries()];
  assert.notEqual(entries[0][0], entries[1][0]);
  assert.equal(entries[0][1].cameraAPIHost, 'camera.home.nest.com');
  assert.equal(entries[1][1].cameraAPIHost, 'camera.home.ft.nest.com');
  assert.notEqual(entries[0][1].snapshotWaiters, entries[1][1].snapshotWaiters);
  assert.equal(manager.start('missing'), false);
  assert.equal(manager.markUnauthorised('missing'), false);
});

test('Connections authenticates Nest and refreshes the same entry while releasing old runtime state', async (t) => {
  let notices = [];
  let { manager, uuid, connection } = setup(t, [account], {
    onAuthorised: (...args) => notices.push(args),
  });
  let requests = t.mock.method(network, 'request', async (method, url) =>
    response(url.endsWith('/session') === true ? session : { items: [{ session_token: 'camera-cookie' }] }),
  );
  await manager.connect(uuid);
  assert.equal(connection.authorised, true);
  assert.equal(connection.token, 'session-token');
  assert.equal(connection.cameraAuth.token, 'camera-cookie');
  assert.equal(connection.refreshDelay, 86400000);
  assert.equal(requests.mock.calls[1].arguments[2].headers.Authorization, 'Basic access-token');
  let released = 0;
  let resolved = 0;
  connection.grpcTransport = { release: () => released++ };
  connection.snapshotWaiters.set(() => resolved++, 'camera');
  await manager.connect(uuid);
  assert.equal(manager.get(uuid), connection);
  assert.equal(released, 1);
  assert.equal(resolved, 1);
  assert.equal(connection.snapshotWaiters.size, 0);
  assert.equal(notices[1][2].wasAuthorised, true);
});

test('Connections Google auth exchanges OAuth and JWT then applies expiry safety margin', async (t) => {
  let { manager, uuid, connection } = setup(t, [
    {
      name: 'Google',
      type: 'google',
      issueToken: 'https://accounts.example/token',
      cookie: 'cookie',
    },
  ]);
  let results = [{ access_token: 'oauth-token', token_type: 'Bearer', expires_in: 3600 }, { jwt: 'jwt-token' }, session];
  let requests = t.mock.method(network, 'request', async () => response(results.shift()));
  await manager.connect(uuid);
  assert.equal(connection.authorised, true);
  assert.equal(connection.cameraAuth.oauth2, 'oauth-token');
  assert.equal(connection.refreshDelay, 3300000);
  assert.equal(requests.mock.calls[1].arguments[2].headers.Authorization, 'Bearer oauth-token');
  assert.equal(requests.mock.calls[2].arguments[2].headers.Authorization, 'Basic jwt-token');
});

test('Connections scheduler retries transient failures at 15, 30, then 60 seconds', async (t) => {
  let { manager, uuid, connection } = setup(t);
  let requests = t.mock.method(network, 'request', async () => {
    throw new Error('offline');
  });
  manager.start(uuid);
  await setImmediate();
  assert.equal(requests.mock.callCount(), 1);
  for (let delay of [15000, 30000, 60000, 60000]) {
    let count = requests.mock.callCount();
    t.mock.timers.tick(delay - 1);
    await setImmediate();
    assert.equal(requests.mock.callCount(), count);
    t.mock.timers.tick(1);
    await setImmediate();
    assert.equal(requests.mock.callCount(), count + 1);
  }
  assert.equal(connection.retryDelay, 60000);
});

test('Connections does not retry terminal authentication failures', async (t) => {
  let { manager, uuid, connection } = setup(t);
  let requests = t.mock.method(network, 'request', async () => {
    throw Object.assign(new Error('forbidden'), { code: 403 });
  });
  manager.start(uuid);
  await setImmediate();
  assert.equal(connection.allowRetry, false);
  t.mock.timers.tick(120000);
  await setImmediate();
  assert.equal(requests.mock.callCount(), 1);
});

test('Connections schedules refresh after successful auth and tolerates callback failure', async (t) => {
  let { manager, uuid, connection } = setup(t, [account], {
    onAuthorised: () => {
      throw new Error('consumer failed');
    },
  });
  let requests = t.mock.method(network, 'request', async (method, url) =>
    response(url.endsWith('/session') === true ? session : { items: [{ session_token: 'camera-cookie' }] }),
  );
  manager.start(uuid);
  await setImmediate();
  assert.equal(connection.authorised, true);
  assert.equal(requests.mock.callCount(), 2);
  t.mock.timers.tick(connection.refreshDelay - 1);
  await setImmediate();
  assert.equal(requests.mock.callCount(), 2);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.equal(requests.mock.callCount(), 4);
});

test('Connections prevents duplicate auth attempts and cannot resurrect after shutdown', async (t) => {
  let { manager, uuid } = setup(t);
  let pending = Promise.withResolvers();
  let requests = t.mock.method(network, 'request', () => pending.promise);
  manager.start(uuid);
  manager.start(uuid);
  assert.equal(requests.mock.callCount(), 1);
  manager.shutdown();
  pending.reject(new Error('request ended after shutdown'));
  await setImmediate();
  t.mock.timers.tick(120000);
  await setImmediate();
  assert.equal(manager.size, 0);
  assert.equal(requests.mock.callCount(), 1);
});

test('Connections invalidation resolves all snapshot waiters and shutdown cancels scheduled retries', async (t) => {
  let { manager, uuid, connection } = setup(t);
  let requests = t.mock.method(network, 'request', async () => {
    throw new Error('unexpected request');
  });
  let released = 0;
  let resolved = 0;
  connection.authorised = true;
  connection.grpcTransport = { release: () => released++ };
  connection.snapshotWaiters.set(() => resolved++, 'same-camera');
  connection.snapshotWaiters.set(() => resolved++, 'same-camera');
  assert.equal(manager.markUnauthorised(uuid), true);
  assert.equal(connection.authorised, false);
  assert.equal(released, 1);
  assert.equal(resolved, 2);
  manager.shutdown();
  manager.shutdown();
  t.mock.timers.tick(60000);
  await setImmediate();
  assert.equal(connection.timer, undefined);
  assert.equal(connection.grpcTransport, undefined);
  assert.equal(manager.size, 0);
  assert.equal(requests.mock.callCount(), 0);
});
