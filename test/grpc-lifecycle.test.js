// Verify real gRPC validation, connection pooling, retries, timeout and serial Observe delivery with fake HTTP/2 sessions.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import http2 from 'node:http2';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { importSource } from './helpers/import-source.js';

let location = new URL('../src/grpctransport.js', import.meta.url);
let timers =
  'data:text/javascript,' +
  encodeURIComponent(
    'import timers from "node:timers";' +
      ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
        .map((name) => 'export function ' + name + '(...args) { return timers.' + name + '(...args); }')
        .join(''),
  );
let source = (await readFile(location, 'utf8')).replace('from \'node:timers\'', 'from ' + JSON.stringify(timers));
let { default: Grpc } = await importSource(location, source);
let protoPath = fileURLToPath(new URL('../src/protobuf/root.proto', import.meta.url));
let prefix = 'nestlabs.gateway.v1.';

function setup(
  context,
  respond = (request) => {
    request.emit('response', { ':status': 200, 'content-type': 'application/grpc' });
    request.emit('data', Buffer.alloc(5));
    request.emit('trailers', { 'grpc-status': '0' });
    request.close();
  },
  options = {},
) {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 100000 });
  let sessions = [];
  let requests = [];
  context.mock.method(http2, 'connect', () => {
    let session = new EventEmitter();
    session.ping = (callback) => callback(null);
    session.destroy = () => {
      session.destroyed = true;
      session.emit('close');
    };
    session.request = (headers) => {
      let request = new EventEmitter();
      request.headers = headers;
      request.cork = request.uncork = () => {};
      request.write = (frame) => {
        request.frame = frame;
      };
      request.close = () => {
        if (request.closed !== true) {
          request.closed = true;
          request.emit('close');
        }
      };
      request.destroy = () => {
        request.destroyed = true;
      };
      request.end = () => globalThis.queueMicrotask(() => respond(request, requests.length));
      requests.push(request);
      return request;
    };
    sessions.push(session);
    return session;
  });
  let transport = new Grpc({ protoPath, endpointHost: new URL('https://grpc.invalid/path'), getAuthHeader: () => 'fixture', ...options });
  context.after(() => transport.release());
  return { transport, sessions, requests };
}
for (let args of [
  [null, 'Service', 'SendCommand', {}],
  [prefix, '', 'SendCommand', {}],
  [prefix, 'Service', '', {}],
  [prefix, 'Service', 'SendCommand', null],
]) {
  test('gRPC rejects invalid request before opening a session: ' + JSON.stringify(args), async (context) => {
    let flow = setup(context);
    assert.equal((await flow.transport.command(...args)).code, 'INVALID_ARGUMENT');
    assert.deepEqual(flow.sessions, []);
  });
}
for (let [label, options, code] of [
  ['missing schema', { protoPath: '/missing.proto' }, 'PROTOBUF_UNAVAILABLE'],
  ['missing auth', { getAuthHeader: undefined }, 'AUTH_UNAVAILABLE'],
  ['blank auth', { getAuthHeader: () => '' }, 'AUTH_UNAVAILABLE'],
]) {
  test('gRPC reports ' + label + ' without opening HTTP/2', async (context) => {
    let flow = setup(context, undefined, options);
    assert.equal((await flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {})).code, code);
    assert.deepEqual(flow.sessions, []);
  });
}
test('gRPC rejects unavailable protobuf methods without starting a request', async (context) => {
  let flow = setup(context);
  assert.equal((await flow.transport.command(prefix, 'ResourceApi', 'Missing', {})).code, 'PROTO_TYPE_UNAVAILABLE');
  assert.deepEqual(flow.requests, []);
});
for (let [headers, code] of [
  [{ ':status': 502, 'content-type': 'text/html' }, 'HTTP_RESPONSE_INVALID'],
  [{ ':status': 200, 'content-type': 'application/json' }, 'HTTP_RESPONSE_INVALID'],
  [{ 'content-type': 'application/grpc' }, 'HTTP_RESPONSE_INVALID'],
]) {
  test('gRPC refuses a non-gRPC response: ' + JSON.stringify(headers), async (context) => {
    let flow = setup(context, (request) => request.emit('response', headers));
    assert.equal((await flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {})).code, code);
    assert.equal(flow.requests[0].destroyed, true);
    assert.notEqual(flow.sessions[0].destroyed, true);
  });
}
for (let error of [
  Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
  Object.assign(new Error('aborted'), { name: 'AbortError' }),
  Object.assign(new Error('connection'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
  new Error('unexpected'),
]) {
  test('gRPC maps stream error ' + error.message, async (context) => {
    let flow = setup(context, (request) => {
      request.emit('error', error);
      request.close();
    });
    let result = await flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {});
    assert.equal(result.status, error.message === 'unexpected' ? Grpc.STATUS.UNAVAILABLE : Grpc.STATUS.DEADLINE_EXCEEDED);
    assert.equal(flow.requests[0].destroyed, true);
  });
}
test('unary timeout cancels just its request and preserves the pooled session', async (context) => {
  let flow = setup(context, () => {});
  let request = flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {}, { timeout: 1234 });
  await setImmediate();
  assert.equal(flow.requests[0].headers['grpc-timeout'], '2S');
  context.mock.timers.tick(1234);
  assert.equal((await request).code, 'REQUEST_TIMEOUT');
  assert.equal(flow.requests[0].destroyed, true);
  assert.notEqual(flow.sessions[0].destroyed, true);
});
for (let observe of [false, true]) {
  test((observe === true ? 'Observe' : 'unary') + ' transient failure retries after backoff', async (context) => {
    let flow = setup(context, (request, count) => {
      request.emit('trailers', { 'grpc-status': count === 1 ? '14' : '0' });
      request.close();
    });
    let result =
      observe === true
        ? flow.transport.observe(prefix, 'ResourceApi', 'SendCommand', {}, () => {}, { retry: 2 })
        : flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {}, { retry: 2 });
    await setImmediate();
    assert.equal(flow.requests.length, 1);
    context.mock.timers.tick(499);
    await setImmediate();
    assert.equal(flow.requests.length, 1);
    context.mock.timers.tick(1);
    assert.equal((await result).status, 0);
    assert.equal(flow.requests.length, 2);
  });
}
test('Observe waits for asynchronous callbacks in order and reports handler failure after stream completion', async (context) => {
  let flow = setup(context, (request) => {
    request.emit('data', Buffer.alloc(10));
    request.emit('trailers', { 'grpc-status': '0' });
    request.close();
  });
  let gate = Promise.withResolvers();
  let calls = [];
  let completed = false;
  let result = flow.transport.observe(prefix, 'ResourceApi', 'SendCommand', {}, async () => {
    calls.push(calls.length + 1);
    if (calls.length === 1) {
      await gate.promise;
    } else {
      throw new Error('Fixture handler failure');
    }
  });
  result.then(() => {
    completed = true;
  });
  await setImmediate();
  assert.deepEqual(calls, [1]);
  assert.equal(completed, false);
  gate.resolve();
  assert.equal((await result).code, 'GRPC_HANDLER_FAILED');
  assert.deepEqual(calls, [1, 2]);
});
test('auth-based pooling shares a session, rotates on new credentials and releases only the final owner', async (context) => {
  let token = 'first';
  let flow = setup(context, undefined, { getAuthHeader: () => token });
  let second = new Grpc({ protoPath, endpointHost: 'https://grpc.invalid', getAuthHeader: () => token });
  context.after(() => second.release());
  await flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {});
  await second.command(prefix, 'ResourceApi', 'SendCommand', {});
  assert.equal(flow.sessions.length, 1);
  flow.transport.release();
  assert.notEqual(flow.sessions[0].destroyed, true);
  token = 'second';
  await second.command(prefix, 'ResourceApi', 'SendCommand', {});
  assert.equal(flow.sessions.length, 2);
  assert.equal(flow.sessions[0].destroyed, true);
  second.release();
  assert.equal(flow.sessions[1].destroyed, true);
});
test('session failure removes stale pooling state and a later command opens a replacement', async (context) => {
  let flow = setup(context);
  await flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {});
  flow.sessions[0].emit('connect');
  flow.sessions[0].emit('goaway');
  flow.sessions[0].emit('error', new Error('Fixture session failure'));
  assert.equal(flow.sessions[0].destroyed, true);
  await flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {});
  assert.equal(flow.sessions.length, 2);
  flow.sessions[1].ping = () => {
    throw new Error('Fixture ping failure');
  };
  context.mock.timers.tick(60000);
  assert.equal((await flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {})).status, 0);
});

for (let throws of [false, true]) {
  test('keepalive failure retires its pooled session and reconnects: throws=' + throws, async (context) => {
    let flow = setup(context);
    await flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {});
    let old = flow.sessions[0];
    old.ping = (callback) => {
      let error = new Error('Fixture keepalive failure');
      if (throws === true) {
        throw error;
      }
      callback(error);
    };
    context.mock.timers.tick(60000);
    assert.equal(old.destroyed, true);
    assert.equal((await flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {})).status, 0);
    assert.equal(flow.sessions.length, 2);
    assert.notEqual(flow.sessions[1].destroyed, true);
  });
}

test('successful keepalive retains its pooled session', async (context) => {
  let flow = setup(context);
  await flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {});
  flow.sessions[0].ping = (callback) => callback(null);
  context.mock.timers.tick(60000);
  assert.equal((await flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {})).status, 0);
  assert.equal(flow.sessions.length, 1);
  assert.notEqual(flow.sessions[0].destroyed, true);
});

test('late keepalive failure cannot retire the pooled replacement', async (context) => {
  let flow = setup(context);
  await flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {});
  let old = flow.sessions[0];
  let callback;
  old.ping = (onPing) => {
    callback = onPing;
  };
  context.mock.timers.tick(60000);
  old.closed = true;
  await flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {});
  callback(new Error('Fixture delayed keepalive failure'));
  assert.equal((await flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {})).status, 0);
  assert.equal(flow.sessions.length, 2);
  assert.notEqual(flow.sessions[1].destroyed, true);
});

test('gRPC encodes nested Any payloads without mutating caller objects', async (context) => {
  let flow = setup(context);
  let values = {
    resourceRequest: { resourceId: 'DEVICE_FIXTURE' },
    resourceCommands: [
      {
        traitLabel: 'bolt_lock',
        command: {
          type_url: 'type.nestlabs.com/weave.trait.security.BoltLockTrait.BoltLockChangeRequest',
          value: { state: 'BOLT_STATE_EXTENDED' },
        },
      },
    ],
  };
  let before = structuredClone(values);
  assert.equal((await flow.transport.command(prefix, 'ResourceApi', 'SendCommand', values)).status, 0);
  assert.deepEqual(values, before);
  assert.ok(flow.requests[0].frame.length > 5);
});

test('gRPC malformed protobuf response fails only the current request', async (context) => {
  let flow = setup(context, (request) => {
    request.emit('data', Buffer.from([0, 0, 0, 0, 1, 0xff]));
  });
  assert.equal((await flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {})).code, 'GRPC_DECODE_FAILED');
  assert.equal(flow.requests[0].destroyed, true);
  assert.notEqual(flow.sessions[0].destroyed, true);
});
test('gRPC stream closed without trailers returns an explicit unknown status', async (context) => {
  let flow = setup(context, (request) => request.close());
  assert.equal((await flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {})).status, Grpc.STATUS.UNKNOWN);
});
test('gRPC propagates an unavailable auth-provider error before opening a session', async (context) => {
  let failure = new Error('Fixture auth provider failed');
  let flow = setup(context, undefined, {
    getAuthHeader: () => {
      throw failure;
    },
  });
  await assert.rejects(flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {}), (error) => error === failure);
  assert.deepEqual(flow.requests, []);
});

for (let [status, message, expected] of [
  [1, 'cancelled', 0],
  [4, 'context timed out', 0],
  [4, 'deadline reached', 0],
  [4, 'read timeout', 0],
  [4, 'quota exhausted', 4],
  [16, 'expired credentials', 16],
]) {
  test('gRPC Observe terminal status ' + status + ' / ' + message + ' is classified correctly', async (context) => {
    let flow = setup(context, (request) => {
      request.emit('trailers', { 'grpc-status': String(status), 'grpc-message': message });
      request.close();
    });
    let result = await flow.transport.observe(prefix, 'ResourceApi', 'SendCommand', {}, () => {});
    assert.equal(result.status, expected);
    assert.equal(result.message, expected === 0 ? '' : message);
    assert.equal(result.code, expected === 0 ? undefined : 'GRPC_STATUS_' + status);
    assert.equal(flow.requests[0].headers['grpc-timeout'], undefined, 'long-running Observe has no unary deadline header');
  });
}
for (let operation of ['request', 'write', 'end']) {
  test('gRPC synchronous ' + operation + ' failure releases only that request and allows reuse', async (context) => {
    let flow = setup(context);
    await flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {});
    let session = flow.sessions[0];
    let create = session.request;
    let uncorked = 0;
    session.request = (headers) => {
      if (operation === 'request') {
        throw new Error('Fixture request failed');
      }
      let request = create(headers);
      request.uncork = () => {
        uncorked++;
      };
      request[operation] = () => {
        throw new Error('Fixture ' + operation + ' failed');
      };
      return request;
    };
    let result = await flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {});
    assert.equal(result.status, Grpc.STATUS.UNAVAILABLE);
    assert.equal(result.code, 'TRANSPORT_ERROR');
    assert.notEqual(session.destroyed, true);
    if (operation !== 'request') {
      assert.equal(flow.requests.at(-1).destroyed, true);
      assert.equal(uncorked, 1);
    }
    session.request = create;
    assert.equal((await flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {})).status, 0);
    assert.equal(flow.sessions.length, 1);
  });
}
test('gRPC timeout errors nested in cause keep their error classification and allow a later command', async (context) => {
  let attempts = 0;
  let flow = setup(context, (request) => {
    if (attempts++ === 0) {
      request.emit('error', Object.assign(new Error('Fixture nested timeout'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } }));
    } else {
      request.emit('trailers', { 'grpc-status': '0' });
    }
    request.close();
  });
  let result = await flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {});
  assert.equal(result.status, Grpc.STATUS.DEADLINE_EXCEEDED);
  assert.equal(result.code, 'UND_ERR_HEADERS_TIMEOUT');
  assert.equal((await flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {})).status, 0);
  assert.equal(flow.sessions.length, 1);
});
test('gRPC stale session close and release cannot evict its pooled replacement', async (context) => {
  let flow = setup(context);
  await flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {});
  let old = flow.sessions[0];
  old.closed = true;
  await flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {});
  assert.equal(flow.sessions.length, 2);
  old.emit('close');
  await flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {});
  assert.equal(flow.sessions.length, 2);
  assert.notEqual(flow.sessions[1].destroyed, true);
});

for (let [method, values] of [
  ['UpdateHotWaterBoost', { deviceId: 'thermostat', duration: { seconds: '3600' } }],
  ['UpdateThermostatMode', { deviceId: 'thermostat', mode: 'THERMOSTAT_MODE_COOL', hvacActor: 'HVAC_ACTOR_IOS' }],
  [
    'UpdateTargetTemperature',
    { deviceId: 'thermostat', mode: 'THERMOSTAT_MODE_COOL', temperature: { value: 24.5 }, hvacActor: 'HVAC_ACTOR_IOS' },
  ],
  [
    'UpdateTargetTemperatureRange',
    { deviceId: 'thermostat', tempLow: { value: 19 }, tempHigh: { value: 25 }, hvacActor: 'HVAC_ACTOR_IOS' },
  ],
  ['UpdateThermostatFanMode', { deviceId: 'thermostat', runTimeSeconds: { value: 900 } }],
]) {
  test('Foyer ' + method + ' resolves its schema and sends a native gRPC request', async (context) => {
    let flow = setup(context, undefined, { protoPath: fileURLToPath(new URL('../src/protobuf/googlehome/foyer.proto', import.meta.url)) });
    let result = await flow.transport.command('google.internal.home.foyer.v1.', 'EnergyService', method, values);
    assert.equal(result.status, 0, result.code);
    assert.deepEqual(result.data, [{}]);
    assert.equal(flow.requests.length, 1);
    assert.equal(flow.requests[0].headers[':path'], '/google.internal.home.foyer.v1.EnergyService/' + method);
    assert.equal(flow.requests[0].frame.length > 5, true);
  });
}

test('Foyer trait reads resolve production request/reply types through native gRPC', async (context) => {
  let response = Buffer.from('0a050a030a0163', 'hex');
  let flow = setup(
    context,
    (request) => {
      let frame = Buffer.alloc(5 + response.length);
      frame.writeUInt32BE(response.length, 1);
      response.copy(frame, 5);
      request.emit('response', { ':status': 200, 'content-type': 'application/grpc' });
      request.emit('data', frame);
      request.emit('trailers', { 'grpc-status': '0' });
      request.close();
    },
    { protoPath: fileURLToPath(new URL('../src/protobuf/googlehome/foyer.proto', import.meta.url)) },
  );
  let result = await flow.transport.command('google.internal.home.foyer.v1.', 'HomeControlService', 'GetTraits', {
    deviceIds: [{ uuid: 'c' }],
  });
  assert.equal(result.status, 0, result.code);
  assert.equal(flow.requests[0].headers[':path'], '/google.internal.home.foyer.v1.HomeControlService/GetTraits');
  assert.equal(result.data[0].device[0].uuid.value, 'c');
});

for (let [service, method, values, reply, expected] of [
  [
    'CameraService',
    'ListTimelinePeriods',
    { request: { deviceId: 'c', startTime: { seconds: '100' }, endTime: { seconds: '200' } }, field2: 1, strongRead: true },
    '121f0a020864120208691a150a130a0173320e0a0174120208641a020869220108',
    (data) => assert.deepEqual(data.periods[0].recorded.session.tracks[0].eventTypes, ['EVENT_TYPE_DOORBELL']),
  ],
]) {
  test('Foyer ' + method + ' decodes camera history through the native transport', async (context) => {
    let payload = Buffer.from(reply, 'hex');
    let flow = setup(
      context,
      (request) => {
        let frame = Buffer.alloc(5 + payload.length);
        frame.writeUInt32BE(payload.length, 1);
        payload.copy(frame, 5);
        request.emit('response', { ':status': 200, 'content-type': 'application/grpc' });
        request.emit('data', frame);
        request.emit('trailers', { 'grpc-status': '0' });
        request.close();
      },
      { protoPath: fileURLToPath(new URL('../src/protobuf/googlehome/foyer.proto', import.meta.url)) },
    );
    let result = await flow.transport.command('google.internal.home.foyer.v1.', service, method, values);
    assert.equal(result.status, 0, result.code);
    assert.equal(flow.requests[0].headers[':path'], '/google.internal.home.foyer.v1.' + service + '/' + method);
    expected(result.data[0]);
  });
}

for (let environment of [undefined, '', {}, 'CAESCxIJNC4zMy4yNy41']) {
  test('Foyer release metadata is opt-in and preserves auth/framing: ' + JSON.stringify(environment), async (context) => {
    let flow = setup(context, undefined, { foyerEnvironment: environment });
    let result = await flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {});
    assert.equal(result.status, Grpc.STATUS.OK);
    assert.equal(
      flow.requests[0].headers['foyer-gha-environment'],
      typeof environment === 'string' && environment !== '' ? environment : undefined,
    );
    assert.equal(flow.requests[0].headers.authorization, 'fixture');
    assert.equal(flow.requests[0].headers['content-type'], 'application/grpc');
    assert.equal(flow.requests[0].headers.te, 'trailers');
    assert.equal(flow.requests[0].headers[':path'], '/' + prefix + 'ResourceApi/SendCommand');
  });
}

test('unanswered keepalive retires only its session after fifteen seconds', async (context) => {
  let flow = setup(context);
  await flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {});
  let old = flow.sessions[0];
  let acknowledge;
  old.ping = (callback) => {
    acknowledge = callback;
  };
  context.mock.timers.tick(60000);
  context.mock.timers.tick(14999);
  assert.notEqual(old.destroyed, true);
  context.mock.timers.tick(1);
  assert.equal(old.destroyed, true);
  assert.equal((await flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {})).status, 0);
  assert.equal(flow.sessions.length, 2);
  acknowledge(null);
  context.mock.timers.tick(15000);
  assert.notEqual(flow.sessions[1].destroyed, true);
});

test('keepalive acknowledgement clears its deadline and close listener', async (context) => {
  let flow = setup(context);
  await flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {});
  let session = flow.sessions[0];
  let count = session.listenerCount('close');
  let acknowledge;
  session.ping = (callback) => {
    acknowledge = callback;
  };
  context.mock.timers.tick(60000);
  assert.equal(session.listenerCount('close'), count + 1);
  context.mock.timers.tick(10000);
  acknowledge(null);
  assert.equal(session.listenerCount('close'), count);
  context.mock.timers.tick(5000);
  assert.notEqual(session.destroyed, true);
});

test('releasing a session clears an unanswered keepalive deadline', async (context) => {
  let flow = setup(context);
  await flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {});
  let session = flow.sessions[0];
  session.ping = () => {};
  let destroy = context.mock.method(session, 'destroy');
  context.mock.timers.tick(60000);
  flow.transport.release();
  assert.equal(destroy.mock.callCount(), 1);
  context.mock.timers.tick(15000);
  assert.equal(destroy.mock.callCount(), 1);
});

test('GOAWAY diagnostics identify ping policy without exposing arbitrary peer data', async (context) => {
  let calls = [];
  let flow = setup(context, undefined, { log: { debug: (...args) => calls.push(args) } });
  await flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {});
  let session = flow.sessions[0];
  session.emit('goaway', 11, 7, Buffer.from('too_many_pings'));
  session.emit('goaway', 0, 9, Buffer.from('fabricated-private-token'));
  let notices = calls.filter((args) => args[0].startsWith('gRPC peer GOAWAY'));
  assert.deepEqual(notices.map((args) => args.slice(2)), [[11, 7, 'too_many_pings'], [0, 9, 'unspecified']]);
  assert.equal(JSON.stringify(calls).includes('fabricated-private-token'), false);
  assert.notEqual(session.destroyed, true, 'diagnostics preserve existing session lifecycle');
});

test('unary timeout diagnostics distinguish absent HTTP headers', async (context) => {
  let calls = [];
  let flow = setup(context, () => {}, { log: { debug: (...args) => calls.push(args) } });
  let pending = flow.transport.command(prefix, 'ResourceApi', 'SendCommand', {}, { timeout: 10 });
  await setImmediate();
  context.mock.timers.tick(10);
  await pending;
  let notice = calls.find((args) => args[0].startsWith('gRPC stream closed'));
  assert.equal(notice.at(-1), 'none');
});
