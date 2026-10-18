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
    session.ping = () => {};
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
