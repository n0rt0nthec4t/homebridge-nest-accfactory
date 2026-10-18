// Test account lifecycle through public APIs with isolated HTTP responses and mocked timers.
import assert from 'node:assert/strict';
import { importSource } from './helpers/import-source.js';
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
// Capture the transport contract without opening a network session.
let grpcModule =
  'data:text/javascript,' +
  encodeURIComponent(
    'export default class Transport { constructor(options) { this.options = options; } release() { this.released = true; } }',
  );
// Forward named timer imports to the per-test Node timer mocks.
let timerModule =
  'data:text/javascript,' +
  encodeURIComponent(
    'import timers from "node:timers"; ' +
      'export function setTimeout(...args) { return timers.setTimeout(...args); } ' +
      'export function clearTimeout(...args) { return timers.clearTimeout(...args); }',
  );
let location = new URL('../src/connections.js', import.meta.url);
let source = await readFile(location, 'utf8');
source = source.replace(/from '([^']+)'/g, (match, specifier) => {
  let target =
    specifier === './fetchWrapper.js'
      ? networkModule
      : specifier === './grpctransport.js'
        ? grpcModule
        : specifier === 'node:timers'
          ? timerModule
          : specifier.startsWith('.') === true
            ? new URL(specifier, location).href
            : specifier;
  return 'from ' + JSON.stringify(target);
});
let { default: Connections } = await importSource(location, source);
let account = { name: 'Test', type: 'nest', access_token: 'access-token' };
let session = { access_token: 'session-token', userid: 'user', urls: { transport_url: 'https://transport.example' } };
let response = (value) => ({ json: async () => value });

function setup(t, accounts = [account], options = {}, runtimeOptions = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let manager = Connections.fromConfig({ accounts, options: runtimeOptions }, options);
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
  assert.equal(manager.start(uuid), true);
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

for (let [label, replies, retry] of [
  ['logged out', [{ error: 'USER_LOGGED_OUT', detail: 'Session expired' }], false],
  ['temporary OAuth error', [{ error: 'TEMPORARY', detail: 'Try again' }], true],
  ['missing JWT', [{ access_token: 'oauth', token_type: 'Bearer', expires_in: 3600 }, {}], true],
  ['missing session token', [{ access_token: 'oauth', token_type: 'Bearer', expires_in: 3600 }, { jwt: 'jwt' }, {}], true],
]) {
  test('Google account rejects ' + label + ' with the expected retry policy', async (context) => {
    let { manager, uuid, connection } = setup(context, [
      { name: 'Google', type: 'google', issueToken: 'https://accounts.example/token', cookie: 'fixture' },
    ]);
    context.mock.method(network, 'request', async () => response(replies.shift()));
    await manager.connect(uuid);
    assert.equal(connection.authorised, false);
    assert.equal(connection.allowRetry, retry);
    assert.equal(connection.grpcTransport, undefined);
  });
}
for (let [expires, delay] of [
  [301, 60000],
  [120, 60000],
  [undefined, 3600000],
]) {
  test('Google account expiry ' + expires + ' uses a bounded refresh delay', async (context) => {
    let { manager, uuid, connection } = setup(context, [
      { name: 'Google', type: 'google', issueToken: 'https://accounts.example/token', cookie: 'fixture' },
    ]);
    let replies = [{ access_token: 'oauth', token_type: 'Bearer', expires_in: expires }, { jwt: 'jwt' }, session];
    context.mock.method(network, 'request', async () => response(replies.shift()));
    await manager.connect(uuid);
    assert.equal(connection.authorised, true);
    assert.equal(connection.refreshDelay, delay);
  });
}
for (let login of [
  { status: 403, status_detail: 'Denied', status_description: 'Forbidden' },
  { status: 500 },
  { items: [{ session_token: ' ' }] },
]) {
  test('Nest login rejects invalid camera session: ' + JSON.stringify(login), async (context) => {
    let { manager, uuid, connection } = setup(context);
    let requests = context.mock.method(network, 'request', async () => response(login));
    await manager.connect(uuid);
    assert.equal(connection.authorised, false);
    assert.equal(connection.allowRetry, login.status !== 403);
    assert.equal(requests.mock.callCount(), 1);
  });
}
for (let failure of [undefined, {}, { access_token: ' ' }]) {
  test('Nest session response rejects missing runtime credentials: ' + JSON.stringify(failure), async (context) => {
    let { manager, uuid, connection } = setup(context);
    context.mock.method(network, 'request', async (method, url) =>
      response(url.endsWith('/session') === true ? failure : { items: [{ session_token: 'cookie' }] }),
    );
    await manager.connect(uuid);
    assert.equal(connection.authorised, false);
    assert.equal(connection.allowRetry, true);
  });
}
test('successful authorisation completing after shutdown cannot recreate an account', async (context) => {
  let notices = [];
  let { manager, uuid } = setup(context, [account], { onAuthorised: (...args) => notices.push(args) });
  let pending = Promise.withResolvers();
  context.mock.method(network, 'request', async (method, url) =>
    url.endsWith('/session') === true ? pending.promise : response({ items: [{ session_token: 'cookie' }] }),
  );
  let connecting = manager.connect(uuid);
  await setImmediate();
  manager.shutdown();
  pending.resolve(response(session));
  await connecting;
  assert.equal(manager.size, 0);
  assert.deepEqual(notices, []);
});
test('unexpected scheduler errors are contained and retried without duplicate connection work', async (context) => {
  let { manager, uuid, connection } = setup(context);
  let attempts = context.mock.method(manager, 'connect', async () => {
    throw new Error('Fixture unexpected lifecycle failure');
  });
  manager.start(uuid);
  await setImmediate();
  assert.equal(connection.connecting, false);
  assert.equal(connection.allowRetry, true);
  assert.equal(connection.authorised, false);
  context.mock.timers.tick(15000);
  await setImmediate();
  assert.equal(attempts.mock.callCount(), 2);
});

for (let fieldTest of [false, true]) {
  test('Google-enabled connections create and replace transports with current auth; fieldTest=' + fieldTest, async (context) => {
    let { manager, uuid, connection } = setup(context, [{ ...account, fieldTest }], {}, { useGoogleAPI: true });
    let token = 'first-session';
    context.mock.method(network, 'request', async (method, url) =>
      response(url.endsWith('/session') === true ? { ...session, access_token: token } : { items: [{ session_token: 'camera-cookie' }] }),
    );
    await manager.connect(uuid);
    let transport = connection.grpcTransport;
    assert.equal(transport.options.uuid, uuid);
    assert.equal(transport.options.endpointHost, fieldTest === true ? 'https://apigw.ft.nest.com' : 'https://apigw.production.nest.com');
    assert.equal(transport.options.getAuthHeader(), 'Basic first-session');
    assert.equal(connection.cameraAuth.value, fieldTest === true ? 'website_ft=' : 'website_2=');
    assert.equal(connection.cameraAuth.fieldTest, fieldTest);
    assert.equal(transport.options.protoPath.endsWith('protobuf/root.proto'), true);
    for (let invalid of [undefined, null, '', ' ']) {
      connection.token = invalid;
      assert.equal(transport.options.getAuthHeader(), '');
    }
    connection.token = 'new-live-token';
    assert.equal(transport.options.getAuthHeader(), 'Basic new-live-token');
    token = 'refreshed-session';
    await manager.connect(uuid);
    assert.equal(transport.released, true);
    assert.notEqual(connection.grpcTransport, transport);
    let replacement = connection.grpcTransport;
    assert.equal(replacement.options.getAuthHeader(), 'Basic refreshed-session');
    manager.shutdown();
    assert.equal(replacement.released, true);
    assert.equal(replacement.options.getAuthHeader(), '');
  });
}

test('Connections validates partial account records and logs only explicitly excluded accounts', (context) => {
  let warnings = [];
  let { manager } = setup(
    context,
    [
      null,
      {},
      { ...account, exclude: true },
      { ...account, type: 'unknown' },
      { name: 'Google', type: 'google', issueToken: '', cookie: 'cookie' },
      { name: 'Google', type: 'google', issueToken: 'issue', cookie: '' },
      { name: ' Google ', type: 'google', issueToken: ' issue ', cookie: ' cookie ' },
    ],
    { log: { warn: (...args) => warnings.push(args) } },
  );
  assert.equal(manager.size, 1);
  let connection = [...manager.entries()][0][1];
  assert.equal(connection.name, 'Google');
  assert.equal(connection.issueToken, 'issue');
  assert.equal(connection.cookie, 'cookie');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][1], account.name);
});

for (let options of [undefined, null, 'invalid']) {
  test('Connections tolerates absent constructor options: ' + options, async () => {
    let manager = new Connections(options);
    assert.equal(manager.size, 0);
    assert.equal(await manager.connect('missing'), undefined);
    manager.shutdown();
  });
}

for (let [failure, retry] of [
  [{ status: 401 }, false],
  [{ code: null, status: 403 }, false],
  [{ code: 'ERR_INVALID_URL' }, false],
  [{ status: 503 }, true],
  ['Fixture network failure', true],
]) {
  test('connection failure classification and diagnostic detail: ' + JSON.stringify(failure), async (context) => {
    let logs = [];
    let log = Object.fromEntries(['info', 'debug', 'error', 'success'].map((level) => [level, (...args) => logs.push([level, ...args])]));
    let { manager, uuid, connection } = setup(context, [account], { log });
    let requests = context.mock.method(network, 'request', async () => {
      throw failure;
    });
    manager.start(uuid);
    await setImmediate();
    assert.equal(connection.authorised, false);
    assert.equal(connection.allowRetry, retry);
    let diagnostic = logs.find((entry) => entry[0] === 'debug');
    assert.equal(diagnostic[2], 'Nest');
    assert.equal(diagnostic[4], retry === true ? 'will retry' : 'will not retry');
    assert.equal(diagnostic[5], String(failure));
    assert.equal(logs.at(-1)[0], 'error');
    context.mock.timers.tick(15000);
    await setImmediate();
    assert.equal(requests.mock.callCount(), retry === true ? 2 : 1);
    if (retry === true) {
      assert.equal(
        logs.some((entry) => entry[0] === 'debug' && String(entry[1]).startsWith('Performing authorisation')),
        true,
      );
    }
  });
}

for (let failure of [new Error('Fixture callback failure'), 'Fixture non-error callback failure']) {
  test('authorisation callback failure is logged without discarding the valid session: ' + failure, async (context) => {
    let logs = [];
    let { manager, uuid, connection } = setup(context, [account], {
      log: { debug: (...args) => logs.push(args) },
      onAuthorised: () => {
        throw failure;
      },
    });
    context.mock.method(network, 'request', async (method, url) =>
      response(url.endsWith('/session') === true ? session : { items: [{ session_token: 'camera-cookie' }] }),
    );
    await manager.connect(uuid);
    assert.equal(connection.authorised, true);
    assert.equal(connection.token, session.access_token);
    assert.equal(logs.at(-1)[2], failure.message ?? String(failure));
    assert.equal(logs.at(-1)[0].startsWith('Authorised connection callback failed'), true);
    await manager.connect(uuid);
    assert.equal(
      logs.some((entry) => entry[0].startsWith('Performing periodic token refresh')),
      true,
    );
  });
}

test('Google refresh retains field-test endpoints and reports retry success at debug level', async (context) => {
  let logs = [];
  let { manager, uuid, connection } = setup(
    context,
    [{ name: 'Google', type: 'google', issueToken: 'https://accounts.example/token', cookie: 'fixture', fieldTest: true }],
    { log: { debug: (...args) => logs.push(args), info: (...args) => logs.push(args) } },
  );
  let requests = context.mock.method(network, 'request', async (method, url) =>
    response(
      url.includes('issue_jwt') === true
        ? { jwt: 'fixture-jwt' }
        : url.endsWith('/session') === true
          ? session
          : { access_token: 'fixture-oauth', token_type: 'Bearer', expires_in: 3600 },
    ),
  );
  await manager.connect(uuid);
  await manager.connect(uuid);
  assert.equal(connection.cameraAuth.fieldTest, true);
  assert.equal(requests.mock.calls[2].arguments[1], 'https://home.ft.nest.com/session');
  assert.equal(requests.mock.calls[1].arguments[2].headers.Origin, 'https://home.ft.nest.com');
  assert.equal(logs[0][2], 'using field test endpoints');
  assert.equal(
    logs.some((entry) => entry[0].startsWith('Successfully performed token refresh using Google')),
    true,
  );
});

for (let failure of [new Error('Fixture scheduler failure'), 'Fixture non-error scheduler failure']) {
  test('scheduler logs unexpected failures and falls back from invalid retry delays: ' + failure, async (context) => {
    let logs = [];
    let { manager, uuid, connection } = setup(context, [account], { log: { debug: (...args) => logs.push(args) } });
    connection.retryDelay = NaN;
    let attempts = context.mock.method(manager, 'connect', async () => {
      throw failure;
    });
    manager.start(uuid);
    await setImmediate();
    assert.equal(logs[0][2], failure.message ?? String(failure));
    assert.equal(connection.retryDelay, 30000);
    context.mock.timers.tick(14999);
    await setImmediate();
    assert.equal(attempts.mock.callCount(), 1);
    context.mock.timers.tick(1);
    await setImmediate();
    assert.equal(attempts.mock.callCount(), 2);
  });
}

test('invalidation logs its reason, replaces the refresh timer and releases pending ingestion work on shutdown', async (context) => {
  let logs = [];
  let { manager, uuid, connection } = setup(context, [account], { log: { debug: (...args) => logs.push(args) } });
  let requests = context.mock.method(network, 'request', async (method, url) =>
    response(url.endsWith('/session') === true ? session : { items: [{ session_token: 'cookie' }] }),
  );
  manager.start(uuid);
  await setImmediate();
  let oldTimer = connection.timer;
  let scheduled = 0;
  connection.subscribeTimer = setTimeout(() => scheduled++, 20000);
  connection.observeTimer = setTimeout(() => scheduled++, 20000);
  assert.equal(manager.markUnauthorised(uuid, 'fixture-expired'), true);
  assert.notEqual(connection.timer, oldTimer);
  assert.equal(logs.at(-1)[2], 'fixture-expired');
  context.mock.timers.tick(14999);
  await setImmediate();
  assert.equal(requests.mock.callCount(), 2);
  context.mock.timers.tick(1);
  await setImmediate();
  assert.equal(requests.mock.callCount(), 4);
  assert.equal(connection.authorised, true);
  assert.equal(connection.retryDelay, 15000);
  manager.shutdown();
  context.mock.timers.tick(100000000);
  await setImmediate();
  assert.equal(scheduled, 0);
  assert.equal(requests.mock.callCount(), 4);
});

test('Connections.fromConfig accepts an empty configuration without scheduling network work', async () => {
  let manager = Connections.fromConfig();
  assert.equal(manager.size, 0);
  assert.equal(manager.start('missing'), false);
  assert.equal(await manager.connect('missing'), undefined);
  manager.shutdown();
});

for (let reply of [{ error: 'TEMPORARY' }, { error: '' }]) {
  test('Google OAuth rejection without detail remains retryable: ' + JSON.stringify(reply), async (context) => {
    let logs = [];
    let { manager, uuid, connection } = setup(
      context,
      [{ name: 'Google', type: 'google', issueToken: 'https://accounts.example/token', cookie: 'fixture' }],
      { log: { debug: (...args) => logs.push(args) } },
    );
    let requests = context.mock.method(network, 'request', async () => response(reply));
    await manager.connect(uuid);
    assert.equal(connection.authorised, false);
    assert.equal(connection.allowRetry, true);
    assert.equal(requests.mock.callCount(), 1);
    assert.equal(logs[0][4], reply.error === '' ? '' : ' (TEMPORARY)');
  });
}

for (let [label, replies, diagnostic] of [
  ['JWT', [{ access_token: 'fixture-oauth', token_type: 'Bearer', expires_in: 3600 }, {}], 'JWT response object'],
  [
    'session',
    [{ access_token: 'fixture-oauth', token_type: 'Bearer', expires_in: 3600 }, { jwt: 'fixture-jwt' }, {}],
    'Nest session response object',
  ],
]) {
  test('Google missing ' + label + ' diagnostic retains failure and retry state', async (context) => {
    let logs = [];
    let { manager, uuid, connection } = setup(
      context,
      [{ name: 'Google', type: 'google', issueToken: 'https://accounts.example/token', cookie: 'fixture' }],
      { log: { debug: (...args) => logs.push(args) } },
    );
    context.mock.method(network, 'request', async () => response(replies.shift()));
    await manager.connect(uuid);
    assert.equal(connection.authorised, false);
    assert.equal(connection.allowRetry, true);
    assert.deepEqual(logs[0], [diagnostic, {}]);
    assert.equal(logs[1][4], 'Missing ' + (label === 'JWT' ? 'jwt in JWT' : 'access_token in session') + ' response');
  });
}
