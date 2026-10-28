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
    'export const grpcRuntime = { observations: [], transports: [] };' +
      'export default class Transport { static STATUS = { UNAUTHENTICATED: 16 };' +
      'constructor(options) { this.options = options; grpcRuntime.transports.push(this); }' +
      'observe(...args) { grpcRuntime.observations.push(args); return new Promise(() => {}); }' +
      'release() { this.released = true; } }',
  );
let { grpcRuntime } = await import(grpcModule);
// Forward named timer imports to the per-test Node timer mocks.
let timerModule =
  'data:text/javascript,' +
  encodeURIComponent(
    'import timers from "node:timers"; ' +
      'export function setTimeout(...args) { return timers.setTimeout(...args); } ' +
      'export function clearTimeout(...args) { return timers.clearTimeout(...args); }',
  );
let location = new URL('../src/accounts.js', import.meta.url);
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
let sessionLocation = new URL('../src/accountsession.js', import.meta.url);
let sessionSource = (await readFile(sessionLocation, 'utf8'))
  .replace('from \'./fetchWrapper.js\'', 'from ' + JSON.stringify(networkModule))
  .replace('from \'node:timers\'', 'from ' + JSON.stringify(timerModule));
await importSource(sessionLocation, sessionSource);
// Authentication and protocol classes share the same isolated HTTP/timer boundary.
for (let name of ['nest', 'google']) {
  let apiLocation = new URL('../src/api/' + name + '.js', import.meta.url);
  let apiSource = (await readFile(apiLocation, 'utf8'))
    .replace('from \'../fetchWrapper.js\'', 'from ' + JSON.stringify(networkModule))
    .replace('from \'node:timers\'', 'from ' + JSON.stringify(timerModule))
    .replace('from \'../grpctransport.js\'', 'from ' + JSON.stringify(grpcModule));
  await importSource(apiLocation, apiSource);
}
let { default: Accounts } = await importSource(location, source);
let account = { name: 'Test', type: 'nest', access_token: 'access-token' };
let session = { access_token: 'session-token', userid: 'user', urls: { transport_url: 'https://transport.example' } };
let response = (value) => ({ json: async () => value });

let owners = new WeakMap();
function transportFor(connection) {
  return grpcRuntime.transports.findLast((transport) => transport.options.uuid === owners.get(connection) && transport.released !== true);
}

function setup(t, accounts = [account], options = {}, runtimeOptions = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let manager = Accounts.fromConfig({ accounts, options: runtimeOptions }, options);
  t.after(() => manager.shutdown());
  let [uuid, connection] = manager.entries().next().value ?? [];
  if (connection !== undefined) {
    owners.set(connection, uuid);
  }
  return { manager, uuid, connection };
}

// Startup is the registry's only connection entry point. Tests explicitly await
// the shared session, requesting a refresh when exercising a second login.
async function startAndAuthenticate(manager, uuid) {
  manager.start(uuid);
  return await manager.get(uuid)?.session.connect(true);
}

test('Accounts builds isolated runtime entries and skips excluded/invalid accounts', (t) => {
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
  assert.equal(Object.hasOwn(entries[0][1], 'snapshotWaiters'), false);
  assert.equal(Object.hasOwn(entries[1][1], 'grpcTransport'), false);
  assert.equal(manager.start('missing'), false);
});

test('Accounts authenticates Nest and refreshes the same entry while releasing old runtime state', async (t) => {
  let notices = [];
  let { manager, uuid, connection } = setup(t, [account], {
    onAuthorised: (...args) => notices.push(args),
  });
  let requests = t.mock.method(network, 'request', async (method, url) =>
    response(url.endsWith('/session') === true ? session : { items: [{ session_token: 'camera-cookie' }] }),
  );
  await startAndAuthenticate(manager, uuid);
  assert.equal(connection.authorised, true);
  assert.equal(connection.token, 'session-token');
  assert.equal(connection.cameraAuth.token, 'camera-cookie');
  assert.equal(connection.refreshDelay, 86400000);
  assert.equal(requests.mock.calls[1].arguments[2].headers.Authorization, 'Basic access-token');
  let released = 0;
  if (transportFor(connection) === undefined) {
    await connection.googleAPI.connect();
  }
  t.mock.method(transportFor(connection), 'release', function () {
    this.released = true;
    released++;
  });
  await startAndAuthenticate(manager, uuid);
  assert.equal(manager.get(uuid), connection);
  assert.equal(released, 1);
  assert.equal(notices[1][2].wasAuthorised, true);
});

test('Accounts Google auth exchanges OAuth and JWT then applies expiry safety margin', async (t) => {
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
  await startAndAuthenticate(manager, uuid);
  assert.equal(connection.authorised, true);
  assert.equal(connection.cameraAuth.oauth2, 'oauth-token');
  assert.equal(connection.refreshDelay, 3300000);
  assert.equal(requests.mock.calls[1].arguments[2].headers.Authorization, 'Bearer oauth-token');
  assert.equal(requests.mock.calls[2].arguments[2].headers.Authorization, 'Basic jwt-token');
});

test('Accounts scheduler retries transient failures at 15, 30, then 60 seconds', async (t) => {
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

test('Accounts does not retry terminal authentication failures', async (t) => {
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

test('Accounts schedules refresh after successful auth and tolerates callback failure', async (t) => {
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
  assert.equal(
    requests.mock.calls.filter(
      (call) => call.arguments[1].includes('/app_launch') === false && call.arguments[1].includes('/v5/subscribe') === false,
    ).length,
    2,
  );
  t.mock.timers.tick(connection.refreshDelay - 1);
  await setImmediate();
  assert.equal(
    requests.mock.calls.filter(
      (call) => call.arguments[1].includes('/app_launch') === false && call.arguments[1].includes('/v5/subscribe') === false,
    ).length,
    2,
  );
  t.mock.timers.tick(1);
  await setImmediate();
  assert.equal(
    requests.mock.calls.filter(
      (call) => call.arguments[1].includes('/app_launch') === false && call.arguments[1].includes('/v5/subscribe') === false,
    ).length,
    4,
  );
});

test('Accounts prevents duplicate auth attempts and cannot resurrect after shutdown', async (t) => {
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

test('Accounts invalidation releases its API transport and shutdown cancels scheduled retries', async (t) => {
  let { manager, connection } = setup(t);
  let requests = t.mock.method(network, 'request', async () => {
    throw new Error('unexpected request');
  });
  let released = 0;
  connection.authorised = true;
  if (transportFor(connection) === undefined) {
    await connection.googleAPI.connect();
  }
  t.mock.method(transportFor(connection), 'release', function () {
    this.released = true;
    released++;
  });
  assert.equal(connection.session.markUnauthorised(), true);
  assert.equal(connection.authorised, false);
  assert.equal(released, 1);
  manager.shutdown();
  manager.shutdown();
  t.mock.timers.tick(60000);
  await setImmediate();
  assert.equal(connection.timer, undefined);
  assert.equal(transportFor(connection), undefined);
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
    await startAndAuthenticate(manager, uuid);
    assert.equal(connection.authorised, false);
    assert.equal(connection.allowRetry, retry);
    assert.equal(transportFor(connection), undefined);
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
    await startAndAuthenticate(manager, uuid);
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
    await startAndAuthenticate(manager, uuid);
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
    await startAndAuthenticate(manager, uuid);
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
  let connecting = startAndAuthenticate(manager, uuid);
  await setImmediate();
  manager.shutdown();
  pending.resolve(response(session));
  await connecting;
  assert.equal(manager.size, 0);
  assert.deepEqual(notices, []);
});
test('unexpected scheduler errors are contained and retried without duplicate connection work', async (context) => {
  let { connection } = setup(context);
  let attempts = context.mock.method(connection.session, 'connect', async () => {
    throw new Error('Fixture unexpected lifecycle failure');
  });
  connection.session.start();
  await setImmediate();
  assert.equal(connection.connecting, false);
  assert.equal(connection.allowRetry, true);
  assert.equal(connection.authorised, false);
  context.mock.timers.tick(15000);
  await setImmediate();
  assert.equal(attempts.mock.callCount(), 2);
});

for (let fieldTest of [false, true]) {
  test('Authorised accounts create and replace transports with current auth; fieldTest=' + fieldTest, async (context) => {
    let { manager, uuid, connection } = setup(context, [{ ...account, fieldTest }]);
    let token = 'first-session';
    context.mock.method(network, 'request', async (method, url) =>
      response(url.endsWith('/session') === true ? { ...session, access_token: token } : { items: [{ session_token: 'camera-cookie' }] }),
    );
    await startAndAuthenticate(manager, uuid);
    let transport = transportFor(connection);
    assert.equal(transport.options.uuid, uuid);
    assert.equal(transport.options.endpointHost, fieldTest === true ? 'https://apigw.ft.nest.com' : 'https://apigw.production.nest.com');
    assert.equal(transport.options.getAuthHeader(), 'Basic first-session');
    assert.equal(connection.cameraAuth.value, fieldTest === true ? 'website_ft=' : 'website_2=');
    assert.equal(connection.cameraAuth.fieldTest, fieldTest);
    assert.equal(transport.options.protoPath.replaceAll('\\', '/').endsWith('protobuf/root.proto'), true);
    for (let invalid of [undefined, null, '', ' ']) {
      connection.token = invalid;
      assert.equal(transport.options.getAuthHeader(), '');
    }
    connection.token = 'new-live-token';
    assert.equal(transport.options.getAuthHeader(), 'Basic new-live-token');
    token = 'refreshed-session';
    await startAndAuthenticate(manager, uuid);
    assert.equal(transport.released, true);
    assert.notEqual(transportFor(connection), transport);
    let replacement = transportFor(connection);
    assert.equal(replacement.options.getAuthHeader(), 'Basic refreshed-session');
    manager.shutdown();
    assert.equal(replacement.released, true);
    assert.equal(replacement.options.getAuthHeader(), '');
  });
}

test('Accounts validates partial account records and logs only explicitly excluded accounts', (context) => {
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
  test('Accounts tolerates absent constructor options: ' + options, async () => {
    let manager = new Accounts(options);
    assert.equal(manager.size, 0);
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
    await startAndAuthenticate(manager, uuid);
    assert.equal(connection.authorised, true);
    assert.equal(connection.token, session.access_token);
    let failureLog = logs.find((entry) => entry[0].startsWith('Authorised account callback failed'));
    assert.equal(failureLog[2], failure.message ?? String(failure));
    await startAndAuthenticate(manager, uuid);
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
  await startAndAuthenticate(manager, uuid);
  await startAndAuthenticate(manager, uuid);
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
    let { connection } = setup(context, [account], { log: { debug: (...args) => logs.push(args) } });
    connection.retryDelay = NaN;
    let attempts = context.mock.method(connection.session, 'connect', async () => {
      throw failure;
    });
    connection.session.start();
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
  let stopped = [];
  let timer = setTimeout(() => scheduled++, 20000);
  connection.session.on('disconnect', (refreshing) => {
    if (refreshing !== true) {
      stopped.push('nestAPI', 'googleAPI');
      clearTimeout(timer);
    }
  });
  assert.equal(connection.session.markUnauthorised('fixture-expired'), true);
  assert.notEqual(connection.timer, oldTimer);
  assert.deepEqual(stopped, ['nestAPI', 'googleAPI']);
  assert.equal(logs.at(-1)[2], 'fixture-expired');
  context.mock.timers.tick(14999);
  await setImmediate();
  assert.equal(requests.mock.callCount(), 3);
  context.mock.timers.tick(1);
  await setImmediate();
  assert.equal(requests.mock.callCount(), 6);
  assert.equal(connection.authorised, true);
  assert.equal(connection.retryDelay, 15000);
  manager.shutdown();
  context.mock.timers.tick(100000000);
  await setImmediate();
  assert.equal(scheduled, 0);
  assert.equal(requests.mock.callCount(), 6);
});

test('Accounts.fromConfig accepts an empty configuration without scheduling network work', async () => {
  let manager = Accounts.fromConfig();
  assert.equal(manager.size, 0);
  assert.equal(manager.start('missing'), false);
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
    await startAndAuthenticate(manager, uuid);
    assert.equal(connection.authorised, false);
    assert.equal(connection.allowRetry, true);
    assert.equal(requests.mock.callCount(), 1);
    assert.equal(logs[0][4], reply.error === '' ? '' : ' (TEMPORARY)');
  });
}

for (let [label, replies] of [
  ['JWT', [{ access_token: 'fixture-oauth', token_type: 'Bearer', expires_in: 3600 }, {}]],
  ['session', [{ access_token: 'fixture-oauth', token_type: 'Bearer', expires_in: 3600 }, { jwt: 'fixture-jwt' }, {}]],
]) {
  test('Google missing ' + label + ' diagnostic retains failure and retry state', async (context) => {
    let logs = [];
    let { manager, uuid, connection } = setup(
      context,
      [{ name: 'Google', type: 'google', issueToken: 'https://accounts.example/token', cookie: 'fixture' }],
      { log: { debug: (...args) => logs.push(args) } },
    );
    context.mock.method(network, 'request', async () => response(replies.shift()));
    await startAndAuthenticate(manager, uuid);
    assert.equal(connection.authorised, false);
    assert.equal(connection.allowRetry, true);
    assert.equal(logs[0][0].includes('response object'), false);
    assert.equal(logs[0][4], 'Missing ' + (label === 'JWT' ? 'jwt in JWT' : 'access_token in session') + ' response');
  });
}

test('successful refresh retires only Google ingestion; failed refresh retires both APIs before transport cleanup', async (context) => {
  let events = [];
  let fail = false;
  let { manager, uuid, connection } = setup(context, [account], {
    onAuthorised: async () => events.push('authorised'),
  });
  context.mock.method(network, 'request', async (method, url) => {
    if (fail === true) {
      throw Object.assign(new Error('refresh unavailable'), { status: 503 });
    }
    return response(url.endsWith('/session') === true ? session : { items: [{ session_token: 'cookie' }] });
  });
  await startAndAuthenticate(manager, uuid);
  connection.session.on('disconnect', (refreshing) => {
    events.push(refreshing === true ? 'refresh' : 'invalidate');
  });
  context.mock.method(transportFor(connection), 'release', function () {
    this.released = true;
    events.push('transport-release');
  });
  events.length = 0;
  await startAndAuthenticate(manager, uuid);
  assert.deepEqual(events, ['transport-release', 'refresh', 'authorised']);
  assert.equal(connection.authorised, true);

  context.mock.method(transportFor(connection), 'release', function () {
    this.released = true;
    events.push('transport-release');
  });
  events.length = 0;
  fail = true;
  await startAndAuthenticate(manager, uuid);
  assert.deepEqual(events, ['transport-release', 'invalidate']);
  assert.equal(connection.authorised, false);
});

for (let outcome of ['success', 'failure', 'retired']) {
  test('Accounts owns API clients and orders resource batches: ' + outcome, async (context) => {
    grpcRuntime.observations = [];
    let entered = Promise.withResolvers();
    let release = Promise.withResolvers();
    let batches = [];
    let { manager, uuid, connection } = setup(context, [account], {
      onData: async (owner, batch) => {
        assert.equal(owner, uuid);
        if (batch.source !== 'Google') {
          return true;
        }
        batches.push(batch);
        if (batches.length === 1) {
          entered.resolve();
          await release.promise;
          if (outcome === 'failure') {
            throw new Error('fixture consumer failure');
          }
        }
      },
    });
    context.mock.method(network, 'request', async (method, url) =>
      response(url.endsWith('/session') === true ? session : { items: [{ session_token: 'cookie' }] }),
    );
    await startAndAuthenticate(manager, uuid);
    assert.equal(typeof connection.nestAPI.get, 'function');
    assert.equal(typeof connection.googleAPI.set, 'function');
    assert.equal(grpcRuntime.observations.length, 1);
    let consume = grpcRuntime.observations[0][4];
    let first = consume({ observeResponse: [] });
    // Install a rejection handler before releasing the first failed consumer.
    let firstOutcome = first.then(
      () => undefined,
      (error) => error,
    );
    await entered.promise;
    let second = consume({ observeResponse: [] });
    await setImmediate();
    assert.equal(batches.length, 1);
    if (outcome === 'retired') {
      connection.googleAPI.disconnect();
    }
    release.resolve();
    let error = await firstOutcome;
    await second;
    assert.equal(error instanceof Error, outcome === 'failure');
    assert.equal(batches.length, outcome === 'retired' ? 1 : 2);
    assert.equal(batches[0].source, 'Google');
  });
}

test('account clients survive refresh without restarting Nest polling or retaining the old Google transport', async (context) => {
  grpcRuntime.observations = [];
  let { manager, uuid, connection } = setup(context, [account], {
    onData: async () => true,
  });
  let nestAPI = connection.nestAPI;
  let googleAPI = connection.googleAPI;
  let requests = context.mock.method(network, 'request', async (method, url) =>
    response(
      url.endsWith('/session') === true
        ? session
        : url.includes('/app_launch') === true
          ? { objects: [{ object_key: 'topaz.TEST', object_revision: 7, object_timestamp: 70, value: {} }] }
          : { items: [{ session_token: 'cookie' }] },
    ),
  );
  assert.equal(connection.authorised, false);
  assert.equal(requests.mock.callCount(), 0);
  await startAndAuthenticate(manager, uuid);
  let transport = transportFor(connection);
  await startAndAuthenticate(manager, uuid);
  assert.equal(connection.nestAPI, nestAPI);
  assert.equal(connection.googleAPI, googleAPI);
  assert.equal(transport.released, true);
  assert.notEqual(transportFor(connection), transport);
  assert.equal(grpcRuntime.observations.length, 2);
  assert.equal(requests.mock.calls.filter((call) => call.arguments[1].includes('/app_launch')).length, 1);
  context.mock.timers.tick(1000);
  await setImmediate();
  let subscription = requests.mock.calls.find((call) => call.arguments[1].includes('/v5/subscribe'));
  assert.deepEqual(subscription.arguments[3].objects, [{ object_key: 'topaz.TEST', object_revision: 7, object_timestamp: 70 }]);
});

test('both API clients ignore removed flags and share authentication, REST queries and invalidation', async (context) => {
  let batches = [];
  let reject = false;
  let { manager, uuid, connection } = setup(
    context,
    [account],
    {
      onData: async (owner, batch) => {
        batches.push(batch);
        return true;
      },
    },
    { useNestAPI: false, useGoogleAPI: false },
  );
  context.mock.method(network, 'request', async (method, url) => {
    if (url.includes('/app_launch') === true || url.includes('/v5/subscribe') === true) {
      if (reject === true) {
        throw Object.assign(new Error('expired'), { status: 401 });
      }
      return response({ objects: [] });
    }
    return response(url.endsWith('/session') === true ? session : { items: [{ session_token: 'cookie' }] });
  });
  await startAndAuthenticate(manager, uuid);
  await setImmediate();
  assert.equal(batches[0].source, 'Nest');
  assert.notEqual(transportFor(connection), undefined);
  assert.equal(typeof connection.googleAPI.get, 'function');
  assert.equal(
    await connection.nestAPI.get('STRUCTURE_HOME', 'location_weather', { location: { postal_code: '2000', country_code: 'AU' } }),
    undefined,
  );
  context.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(batches.length, 2);
  reject = true;
  context.mock.timers.tick(1000);
  await setImmediate();
  assert.equal(connection.authorised, false);
});

for (let source of ['nest', 'google']) {
  test('API startup failures remain visible without invalidating account auth: ' + source, async (context) => {
    let logs = [];
    let { manager, uuid, connection } = setup(context, [account], {
      log: { debug: (...args) => logs.push(args) },
      onData: async () => true,
      onAuthorised: async () => {
        if (source === 'google') {
          context.mock.method((await import(grpcModule)).default.prototype, 'observe', () => {
            throw new Error('fixture Observe startup failure');
          });
        }
      },
    });
    context.mock.method(network, 'request', (method, url) => {
      if (url.includes('/app_launch') === true && source === 'nest') {
        throw new Error('fixture subscribe startup failure');
      }
      return Promise.resolve(response(url.endsWith('/session') === true ? session : { items: [{ session_token: 'cookie' }] }));
    });
    await startAndAuthenticate(manager, uuid);
    await setImmediate();
    assert.equal(connection.authorised, true);
    assert.equal(
      logs.some((entry) => entry[0].startsWith('Unable to connect ')),
      true,
    );
  });
}

for (let configured of [account, { name: 'Google', type: 'google', issueToken: 'https://oauth.invalid/token', cookie: 'cookie' }]) {
  test('both API entry points share login and scheduled refresh for ' + configured.type + ' accounts', async (context) => {
    let { manager, connection } = setup(context, [configured], {
      onData: async () => true,
    });
    let login = Promise.withResolvers();
    let authCalls = 0;
    let subscriptions = 0;
    context.mock.method(network, 'request', async (method, url) => {
      if (url.includes('/app_launch') === true) {
        subscriptions++;
        return response({ objects: [{ object_key: 'topaz.TEST', object_revision: 1, object_timestamp: 10, value: {} }] });
      }
      if (url.endsWith('/subscribe') === true) {
        return new Promise(() => {});
      }
      authCalls++;
      await login.promise;
      return response(
        url === configured.issueToken
          ? { access_token: 'oauth', token_type: 'Bearer', expires_in: 3600 }
          : url.includes('issue_jwt') === true
            ? { jwt: 'jwt' }
            : url.endsWith('/session') === true
              ? session
              : { items: [{ session_token: 'cookie' }] },
      );
    });
    let nest = connection.nestAPI.connect();
    let google = connection.googleAPI.connect();
    assert.equal(authCalls, 1, 'concurrent API clients share the pending account login');
    login.resolve();
    await Promise.all([nest, google]);
    await setImmediate();
    let callsPerLogin = configured.type === 'nest' ? 2 : 3;
    assert.equal(authCalls, callsPerLogin);
    assert.equal(subscriptions, 1);
    assert.notEqual(transportFor(connection), undefined);
    context.mock.timers.tick(connection.refreshDelay);
    await setImmediate();
    assert.equal(authCalls, callsPerLogin * 2, 'direct API connect also schedules account refresh');
    assert.equal(subscriptions, 1, 'Nest subscription survives refresh');
    connection.googleAPI.disconnect();
    assert.equal(transportFor(connection), undefined);
    await connection.session.connect(true);
    await setImmediate();
    assert.equal(transportFor(connection), undefined, 'account refresh does not reconnect an explicitly disconnected API');
    assert.equal(subscriptions, 1, 'disconnecting protobuf does not stop REST polling');
    let beforeReconnect = authCalls;
    await connection.googleAPI.connect();
    assert.equal(authCalls, beforeReconnect, 'reconnecting one API reuses valid account credentials');
    assert.notEqual(transportFor(connection), undefined);
    manager.shutdown();
    await assert.rejects(connection.nestAPI.connect(), /disconnected/);
  });
}

for (let client of ['nestAPI', 'googleAPI']) {
  test(client + ' disconnect during account login prevents late API startup', async (context) => {
    let { connection } = setup(context);
    let login = Promise.withResolvers();
    context.mock.method(network, 'request', async (method, url) => {
      await login.promise;
      return response(url.endsWith('/session') === true ? session : { items: [{ session_token: 'cookie' }] });
    });
    let connecting = connection[client].connect();
    connection[client].disconnect();
    login.resolve();
    await connecting;
    await setImmediate();
    assert.equal(connection.authorised, true);
    if (client === 'googleAPI') {
      assert.equal(transportFor(connection), undefined);
    }
  });
}

for (let client of ['nestAPI', 'googleAPI']) {
  test(client + ' remains disconnected through shared refresh while the other API continues', async (context) => {
    let { manager, uuid, connection } = setup(context, [account], { onData: async () => true });
    let subscriptions = 0;
    let beforeObserve = grpcRuntime.observations.length;
    context.mock.method(network, 'request', async (method, url) => {
      if (url.includes('/app_launch') === true || url.includes('/v5/subscribe') === true) {
        subscriptions++;
        return new Promise(() => {});
      }
      return response(url.endsWith('/session') === true ? session : { items: [{ session_token: 'cookie' }] });
    });
    await startAndAuthenticate(manager, uuid);
    await setImmediate();
    assert.equal(subscriptions, 1);
    assert.equal(grpcRuntime.observations.length - beforeObserve, 1);
    connection[client].disconnect();
    await connection.session.connect(true);
    await setImmediate();
    assert.equal(subscriptions, 1, 'refresh must not reopen a disconnected or already-running Nest client');
    assert.equal(grpcRuntime.observations.length - beforeObserve, client === 'googleAPI' ? 1 : 2);
    assert.equal(transportFor(connection) === undefined, client === 'googleAPI');
    await connection[client].connect();
    await setImmediate();
    assert.equal(subscriptions, client === 'nestAPI' ? 2 : 1);
    assert.equal(grpcRuntime.observations.length - beforeObserve, 2);
  });

  test(client + ' reconnect during pending login retires the earlier connection request', async (context) => {
    let { connection } = setup(context, [account], { onData: async () => true });
    let login = Promise.withResolvers();
    let subscriptions = 0;
    let beforeObserve = grpcRuntime.observations.length;
    context.mock.method(network, 'request', async (method, url) => {
      if (url.includes('/app_launch') === true || url.includes('/v5/subscribe') === true) {
        subscriptions++;
        return new Promise(() => {});
      }
      await login.promise;
      return response(url.endsWith('/session') === true ? session : { items: [{ session_token: 'cookie' }] });
    });
    let first = connection[client].connect();
    connection[client].disconnect();
    let second = connection[client].connect();
    login.resolve();
    await Promise.all([first, second]);
    await setImmediate();
    assert.equal(subscriptions, client === 'nestAPI' ? 1 : 0);
    assert.equal(grpcRuntime.observations.length - beforeObserve, client === 'googleAPI' ? 1 : 0);
    connection[client].disconnect();
    await connection.session.connect(true);
    await setImmediate();
    assert.equal(subscriptions, client === 'nestAPI' ? 1 : 0);
    assert.equal(grpcRuntime.observations.length - beforeObserve, client === 'googleAPI' ? 1 : 0);
  });
}
