// Fabricated MCS peers exercise account ownership, bounded framing and lifecycle.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { importSource } from './helpers/import-source.js';
import { getProtoRoot } from '../src/protobuf.js';

let boundary =
  'data:text/javascript,' +
  encodeURIComponent('export const runtime = {}; export default {connect(options) { return runtime.connect(options); }}');
let timers =
  'data:text/javascript,' +
  encodeURIComponent(
    'import timers from "node:timers"; ' +
      'export function setTimeout(...args) { return timers.setTimeout(...args); } ' +
      'export function clearTimeout(...args) { return timers.clearTimeout(...args); }',
  );
let { runtime } = await import(boundary);
let location = new URL('../src/api/homegraphpush.js', import.meta.url);
let source = (await readFile(location, 'utf8'))
  .replace('from \'node:tls\'', 'from ' + JSON.stringify(boundary))
  .replace('from \'node:timers\'', 'from ' + JSON.stringify(timers));
let { default: GoogleHomePush } = await importSource(location, source);
let mcs = getProtoRoot(fileURLToPath(new URL('../src/protobuf/googlehome/mcs.proto', import.meta.url)));
let foyer = getProtoRoot(fileURLToPath(new URL('../src/protobuf/googlehome/foyer.proto', import.meta.url)));
let credentials = { uuid: 'account', androidId: '18446744073709551614', securityToken: '18446744073709551613' };
let state = {
  uuid: { value: 'device' },
  category: [
    {
      name: 'temperatureSetting',
      traits: [
        { name: 'mode', value: { text: 'cool' } },
        { name: 'setpoint', value: { number: 24.5 } },
      ],
    },
  ],
};
const settle = async () => {
  for (let n = 0; n < 5; n++) {
    await setImmediate();
  }
};
function frame(tag, name, value = {}, version = false) {
  let type = mcs.lookupType('mcs_proto.' + name);
  return Buffer.concat([Buffer.from(version === true ? [40, tag] : [tag]), type.encodeDelimited(type.fromObject(value)).finish()]);
}
function push(value = state, overrides = {}) {
  let type = foyer.lookupType('google.internal.home.foyer.v1.RealtimeMessage');
  return frame(8, 'DataMessageStanza', {
    from: '498579633514',
    category: 'com.google.android.apps.chromecast.app',
    appData: [
      {
        key: 'gcm_realtime_message_proto',
        value: Buffer.from(type.encode(type.fromObject({ event: { deviceState: value } })).finish()).toString('base64'),
      },
    ],
    ...overrides,
  });
}
function setup(context, options = {}) {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let flow = { sockets: [], data: [], refreshes: [], logs: [] };
  runtime.connect = (options) => {
    let socket = new EventEmitter();
    socket.options = options;
    socket.write = context.mock.fn();
    socket.destroy = context.mock.fn(() => socket.emit('close'));
    socket.setKeepAlive = context.mock.fn();
    flow.sockets.push(socket);
    return socket;
  };
  flow.transport = { command: context.mock.fn(async () => ({ status: 0, data: [{}] })), release: context.mock.fn() };
  flow.client = new GoogleHomePush({
    uuid: 'account',
    transport: flow.transport,
    register: async () => credentials,
    onData: (value, current) => flow.data.push({ value, current }),
    onRefresh: (current) => flow.refreshes.push(current),
    log: { debug: (message) => flow.logs.push(message) },
    ...options,
  });
  context.after(() => flow.client.disconnect());
  flow.start = async (ids = ['device']) => {
    let pending = flow.client.connect(ids);
    await settle();
    let socket = flow.sockets.at(-1);
    socket.emit('secureConnect');
    socket.emit('data', frame(3, 'LoginResponse', { id: 'fixture' }, true));
    await pending;
    return socket;
  };
  return flow;
}

test('push enrolls its own receiver before MCS login without an account callback', async (t) => {
  let requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(url);
    if (url.endsWith('/installations') === true) {
      return Response.json({ refreshToken: 'fixture-fis-refresh', authToken: { token: 'fixture-fis', expiresIn: '3600s' } });
    }
    if (url.endsWith('/checkin') === true) {
      let bytes = Buffer.alloc(18);
      bytes[0] = 57;
      bytes.writeBigUInt64LE(BigInt(credentials.androidId), 1);
      bytes[9] = 65;
      bytes.writeBigUInt64LE(BigInt(credentials.securityToken), 10);
      return new Response(bytes);
    }
    return new Response(url.endsWith('/register3') === true ? 'token=fixture-gcm-token' : '');
  });
  let flow = setup(t, {
    register: undefined,
    account: { name: 'Fixture', refreshToken: 'fixture-sso', oauth2: 'fixture-oauth', authorised: true },
  });
  let socket = await flow.start();
  assert.equal(requests.length, 4);
  assert.equal(requests.at(-1), 'https://notifications-pa.googleapis.com/v1/storetarget');
  socket.emit('data', push());
  await settle();
  assert.equal(flow.data.length, 1);
  // Replacing the subscription reuses this receiver's in-memory enrollment.
  await flow.start();
  assert.equal(requests.length, 5);
  assert.equal(socket.destroy.mock.callCount(), 1);
});

test('push uses native Foyer subscription and secure MCS; scalar shape matches GetTraits', async (t) => {
  let flow = setup(t);
  let socket = await flow.start();
  assert.deepEqual(socket.options, { host: 'mtalk.google.com', port: 5228, servername: 'mtalk.google.com', rejectUnauthorized: true });
  let login = mcs.lookupType('mcs_proto.LoginRequest').decodeDelimited(socket.write.mock.calls[0].arguments[0].subarray(2));
  assert.equal(login.user, credentials.androidId);
  assert.equal(login.authToken, credentials.securityToken);
  assert.equal(login.deviceId, 'android-fffffffffffffffe');
  let call = flow.transport.command.mock.calls[0].arguments;
  assert.equal(call[1], 'UsersService');
  assert.equal(call[2], 'AppSubscriptionUpdate');
  assert.deepEqual(call[3].subscriptionEntities.deviceWithTraitsArray, [{ hgsDeviceId: 'device' }]);
  // Resolve and encode the actual schema used by GrpcTransport, not just a mock name.
  let method = foyer.lookupService('google.internal.home.foyer.v1.UsersService').methods.AppSubscriptionUpdate;
  method.resolve();
  assert.equal(
    method.resolvedRequestType.decode(method.resolvedRequestType.encode(method.resolvedRequestType.fromObject(call[3])).finish()).ttl
      .seconds,
    120,
  );
  socket.emit('data', push());
  await settle();
  assert.equal(flow.data[0].value.category[0].traits[0].value.text, 'cool');
  assert.equal(flow.data[0].value.category[0].traits[1].value.number, 24.5);
  assert.equal(flow.data[0].current(), true);
  assert.equal(socket.write.mock.calls.at(-1).arguments[0][0], 7);
  t.mock.timers.tick(90000);
  await settle();
  assert.equal(flow.transport.command.mock.callCount(), 2);
  flow.client.disconnect();
  assert.equal(flow.data[0].current(), false);
  assert.equal(flow.transport.release.mock.callCount(), 0);
});

test('fragmented frames, empty chunks and multi-byte lengths wait for complete payloads', async (t) => {
  let flow = setup(t);
  let pending = flow.client.connect(['device']);
  await settle();
  let socket = flow.sockets[0];
  socket.emit('data', Buffer.alloc(0));
  let login = frame(3, 'LoginResponse', { id: 'fixture' }, true);
  for (let byte of login) {
    socket.emit('data', Buffer.from([byte]));
  }
  await pending;
  let message = push({ ...state, category: [{ name: 'x'.repeat(200), traits: [] }] });
  for (let byte of message) {
    socket.emit('data', Buffer.from([byte]));
  }
  await settle();
  assert.equal(flow.data.length, 1);
  socket.emit('data', frame(0, 'HeartbeatPing'));
  assert.equal(socket.write.mock.calls.at(-1).arguments[0][0], 1);
});

test('receiver filters foreign senders, packages and devices; handles invalidations and alternate state field', async (t) => {
  let flow = setup(t);
  let socket = await flow.start();
  socket.emit('data', push(state, { from: 'foreign' }));
  socket.emit('data', push(state, { category: 'foreign' }));
  socket.emit('data', push({ ...state, uuid: { value: 'foreign' } }));
  socket.emit('data', push(state, { appData: [] }));
  let type = foyer.lookupType('google.internal.home.foyer.v1.RealtimeMessage');
  let notify = (event) =>
    socket.emit(
      'data',
      push(state, {
        appData: [
          { key: 'gcm_realtime_message_proto', value: Buffer.from(type.encode(type.fromObject({ event })).finish()).toString('base64') },
        ],
      }),
    );
  notify({ deviceStateUpdatedEvent: state });
  notify({ refreshHomeGraph: Buffer.from([8, 1]) });
  socket.emit('data', push(state, { appData: [{ key: 'gcm_realtime_message_proto', value: '' }] }));
  await settle();
  assert.equal(flow.data.length, 1);
  assert.equal(flow.refreshes.length, 2);
});

test('reconnect retires stale sockets and retries failed registrations with bounded backoff', async (t) => {
  let calls = 0;
  let flow = setup(t, {
    register: async () => {
      calls++;
      if (calls > 1 && calls < 6) {
        throw new Error('secret-token');
      }
      return credentials;
    },
  });
  let socket = await flow.start();
  socket.emit('error', new Error('secret-token'));
  await settle();
  assert.equal(socket.destroy.mock.callCount(), 1);
  for (let delay of [5000, 10000, 20000, 40000]) {
    t.mock.timers.tick(delay);
    await settle();
  }
  t.mock.timers.tick(60000);
  await settle();
  let replacement = flow.sockets.at(-1);
  assert.notEqual(replacement, socket);
  socket.emit('secureConnect');
  socket.emit('data', push());
  socket.emit('error', new Error('stale'));
  socket.emit('close');
  replacement.emit('secureConnect');
  replacement.emit('data', frame(3, 'LoginResponse', { id: '' }, true));
  await settle();
  replacement.emit('data', push());
  await settle();
  assert.equal(flow.data.length, 1);
  assert.equal(flow.refreshes.length, 2);
  assert.equal(
    flow.logs.some((line) => line.includes('secret')),
    false,
  );
  flow.client.disconnect();
  t.mock.timers.tick(600000);
  await settle();
  assert.equal(flow.sockets.length, 2);
});

test('heartbeat requires an acknowledgement and reconnects on timeout', async (t) => {
  let flow = setup(t);
  let socket = await flow.start();
  t.mock.timers.tick(90000);
  await settle();
  t.mock.timers.tick(60000);
  await settle();
  assert.equal(socket.write.mock.calls.at(-1).arguments[0][0], 0);
  socket.emit('data', frame(1, 'HeartbeatAck'));
  t.mock.timers.tick(30000);
  await settle();
  assert.equal(socket.destroy.mock.callCount(), 0);
  t.mock.timers.tick(120000);
  await settle();
  t.mock.timers.tick(30000);
  await settle();
  assert.equal(socket.destroy.mock.callCount(), 1);
});

for (let [name, bytes] of [
  ['version', Buffer.from([1])],
  ['oversized frame', Buffer.from([40, 8, 255, 255, 255, 127])],
  ['oversized buffer', Buffer.alloc(2 * 1024 * 1024 + 1)],
  ['invalid varint', Buffer.from([40, 8, 128, 128, 128, 128, 128])],
  ['login error', frame(3, 'LoginResponse', { id: '', error: { code: 7, message: 'secret' } }, true)],
]) {
  test('rejects ' + name + ' without leaking private errors', async (t) => {
    let flow = setup(t);
    let pending = flow.client.connect(['device']);
    let rejected = assert.rejects(pending, /^Error: Google Home push connection failed$/);
    await settle();
    flow.sockets[0].emit('data', bytes);
    await rejected;
    t.mock.timers.tick(60000);
    await settle();
    assert.equal(flow.sockets.length, 2, 'startup failure retries inside the receiver');
    flow.client.disconnect();
    t.mock.timers.tick(60000);
    await settle();
    assert.equal(flow.sockets.length, 2);
  });
}

test('login timeout and explicit stop reject pending connection and abort registration', async (t) => {
  let signal;
  let flow = setup(t, {
    register: async (value) => {
      signal = value;
      return credentials;
    },
  });
  let pending = flow.client.connect(['device']);
  let rejected = assert.rejects(pending, /connection failed/);
  await settle();
  t.mock.timers.tick(20000);
  await rejected;
  assert.equal(signal.aborted, true);
  pending = flow.client.connect(['device']);
  rejected = assert.rejects(pending, /connection failed/);
  await settle();
  flow.client.disconnect();
  await rejected;
});

test('superseded registration cannot open a socket or stop a newer connection', async (t) => {
  let complete;
  let count = 0;
  let flow = setup(t, {
    register: async () => {
      if (count++ === 0) {
        return new Promise((resolve) => {
          complete = resolve;
        });
      }
      return credentials;
    },
  });
  let pending = flow.client.connect(['device']);
  let rejected = assert.rejects(pending, /connection failed/);
  await settle();
  await flow.start();
  complete(credentials);
  await rejected;
  flow.sockets[0].emit('data', push());
  await settle();
  assert.equal(flow.data.length, 1);
});

for (let value of [
  undefined,
  { ...credentials, uuid: 'other' },
  { ...credentials, androidId: 123 },
  { ...credentials, securityToken: '18446744073709551616' },
  { ...credentials, androidId: '0' },
]) {
  test('rejects invalid or foreign registration before networking: ' + JSON.stringify(value), async (t) => {
    let flow = setup(t, { register: async () => value });
    await assert.rejects(flow.client.connect(['device']), /connection failed/);
    assert.equal(flow.sockets.length, 0);
  });
}
for (let ids of [null, [], [''], [1], ['x'.repeat(257)], Array(501).fill('device')]) {
  test('rejects invalid target lists: ' + String(ids).slice(0, 20), async (t) => {
    let flow = setup(t);
    await assert.rejects(flow.client.connect(ids), /discovered device IDs/);
  });
}

test('initial subscription failure is sanitized and closes the failed socket', async (t) => {
  let flow = setup(t);
  flow.transport.command.mock.mockImplementation(async () => ({ status: 7, message: 'secret' }));
  await assert.rejects(flow.start(), /connection failed/);
  assert.equal(flow.sockets[0].destroy.mock.callCount(), 1);
});

test('subscription replies from a stopped connection are ignored', async (t) => {
  let finish;
  let flow = setup(t);
  flow.transport.command.mock.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let pending = flow.start();
  await settle();
  let rejected = assert.rejects(pending, /connection failed/);
  flow.client.disconnect();
  finish({ status: 0, data: [{ initialDeviceStatesArray: [state] }] });
  await rejected;
  assert.equal(flow.data.length, 0);
  assert.equal(flow.refreshes.length, 0);
});

test('initial subscription states use the same delivery and account filter', async (t) => {
  let flow = setup(t);
  flow.transport.command.mock.mockImplementation(async () => ({ status: 0, data: [{ initialDeviceStatesArray: [state] }] }));
  await flow.start();
  await settle();
  assert.equal(flow.data.length, 1);
  flow.transport.command.mock.mockImplementation(async () => {
    throw new Error('secret');
  });
  t.mock.timers.tick(90000);
  await settle();
  assert.equal(flow.sockets[0].destroy.mock.callCount(), 1);
});

for (let tag of [3, 4, 10]) {
  test('duplicate login or server termination triggers reconnect: ' + tag, async (t) => {
    let flow = setup(t);
    let socket = await flow.start();
    socket.emit('data', tag === 3 ? frame(3, 'LoginResponse', { id: '' }) : Buffer.from([tag, 0]));
    assert.equal(socket.destroy.mock.callCount(), 1);
  });
}

test('consumer rejection and queue overflow request recovery without unbounded delivery', async (t) => {
  let finish;
  let flow = setup(t, {
    onData: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  let socket = await flow.start();
  socket.emit('data', Buffer.concat(Array.from({ length: 66 }, () => push())));
  assert.equal(socket.destroy.mock.callCount(), 1);
  finish();
  await settle();
  flow.client.disconnect();
  t.mock.timers.reset();
  flow = setup(t, {
    onData: async () => {
      throw new Error('private');
    },
  });
  socket = await flow.start();
  socket.emit('data', push());
  await settle();
  assert.equal(socket.destroy.mock.callCount(), 1);
});

test('socket write exceptions and blocked output reconnect safely', async (t) => {
  let flow = setup(t);
  let socket = await flow.start();
  socket.write.mock.mockImplementation(() => {
    throw new Error('private');
  });
  socket.emit('data', frame(0, 'HeartbeatPing'));
  assert.equal(socket.destroy.mock.callCount(), 1);
  flow.client.disconnect();
  t.mock.timers.reset();
  flow = setup(t);
  socket = await flow.start();
  socket.writableLength = 1024 * 1024 + 1;
  t.mock.timers.tick(150000);
  await settle();
  assert.equal(socket.destroy.mock.callCount(), 1);
});

test('consumer refusal triggers recovery and missing optional callbacks are supported', async (t) => {
  let flow = setup(t, { onData: () => false });
  let socket = await flow.start();
  socket.emit('data', push());
  await settle();
  assert.equal(socket.destroy.mock.callCount(), 1);
  flow.client.disconnect();
  t.mock.timers.reset();
  flow = setup(t, { onRefresh: undefined, onData: undefined, log: undefined });
  socket = await flow.start();
  socket.emit('data', push());
  await settle();
  assert.equal(socket.destroy.mock.callCount(), 0);
});

test('reference wire fixture decodes text, temperature and boolean without the extracted codec', () => {
  // Fabricated device/state, encoded independently using the recovered wire schema.
  let bytes = Buffer.from(
    '0a5712550a080a0664657669636512490a1274656d706572617475726553657474696e67' +
      '120e0a046d6f646512061a04636f6f6c12150a08736574706f696e741209110000000000803840120c0a066f6e6c696e6512022001',
    'hex',
  );
  let result = foyer.lookupType('google.internal.home.foyer.v1.RealtimeMessage').decode(bytes).event.deviceState;
  assert.equal(result.uuid.value, 'device');
  assert.equal(result.category[0].traits[0].value.text, 'cool');
  assert.equal(result.category[0].traits[1].value.number, 24.5);
  assert.equal(result.category[0].traits[2].value.boolean, true);
});

test('receiver reports delivery health and ignores unrelated event envelopes', async (t) => {
  let health = [];
  let flow = setup(t, { onStatus: (ready) => health.push(ready) });
  let socket = await flow.start();
  assert.deepEqual(health, [true]);
  let type = foyer.lookupType('google.internal.home.foyer.v1.RealtimeMessage');
  let event = (value) =>
    socket.emit(
      'data',
      push(state, {
        appData: [
          {
            key: 'gcm_realtime_message_proto',
            value: Buffer.from(type.encode(type.fromObject({ event: value })).finish()).toString('base64'),
          },
        ],
      }),
    );
  // Unsupported event fields must not be mistaken for generic trait changes.
  for (let hex of ['0a046202087b', '0a023a00']) {
    socket.emit(
      'data',
      push(state, { appData: [{ key: 'gcm_realtime_message_proto', value: Buffer.from(hex, 'hex').toString('base64') }] }),
    );
  }
  await settle();
  assert.equal(flow.refreshes.length, 1);
  // Unknown envelopes preserve delivery health without emitting device state.
  assert.equal(flow.data.length, 0);
  event({ refreshDeviceState: Buffer.from([8, 1]) });
  await settle();
  assert.equal(flow.refreshes.length, 2);
  // An explicitly present empty invalidation differs from an absent bytes field.
  socket.emit(
    'data',
    push(state, { appData: [{ key: 'gcm_realtime_message_proto', value: Buffer.from('0a021a00', 'hex').toString('base64') }] }),
  );
  await settle();
  assert.equal(flow.refreshes.length, 3);
  socket.emit('error', new Error('private'));
  assert.deepEqual(health, [true, false]);
  flow.client.disconnect();
});

test('socket closure during initial subscription rejects startup and preserves receiver recovery', async (context) => {
  let statuses = [];
  let flow = setup(context, { onStatus: (ready) => statuses.push(ready) });
  let reply = Promise.withResolvers();
  flow.transport.command.mock.mockImplementationOnce(() => reply.promise);
  let pending = flow.start();
  let rejected = assert.rejects(pending, /^Error: Google Home push connection failed$/);
  await settle();
  flow.sockets[0].emit('close');
  reply.resolve({ status: 0, data: [{ initialDeviceStatesArray: [state] }] });
  await rejected;
  assert.deepEqual(statuses, [false]);
  assert.equal(flow.data.length, 0);
  assert.equal(flow.refreshes.length, 0);
  let socket = await flow.start();
  socket.emit('data', push());
  await settle();
  assert.equal(flow.data.length, 1);
  assert.deepEqual(statuses, [false, false, true]);
});

test('a late subscription cannot report successful startup or disconnect its replacement', async (context) => {
  let flow = setup(context);
  let reply = Promise.withResolvers();
  flow.transport.command.mock.mockImplementationOnce(() => reply.promise);
  let first = flow.start();
  let rejected = assert.rejects(first, /connection failed/);
  await settle();
  let replacement = await flow.start();
  reply.resolve({ status: 0, data: [{ initialDeviceStatesArray: [state] }] });
  await rejected;
  assert.equal(replacement.destroy.mock.callCount(), 0);
  assert.equal(flow.data.length, 0);
  replacement.emit('data', push());
  await settle();
  assert.equal(flow.data.length, 1);
  assert.equal(flow.data[0].current(), true);
});

test('complete incoming frames avoid concatenation; fragmented frames still join their pending bytes', async (context) => {
  let flow = setup(context);
  let socket = await flow.start();
  let ack = frame(1, 'HeartbeatAck');
  let concat = context.mock.method(Buffer, 'concat');
  socket.emit('data', ack);
  assert.equal(concat.mock.callCount(), 0);
  socket.emit('data', ack.subarray(0, 1));
  assert.equal(concat.mock.callCount(), 0);
  socket.emit('data', ack.subarray(1));
  assert.equal(concat.mock.callCount(), 1);
  socket.emit('data', ack);
  assert.equal(concat.mock.callCount(), 1);
  assert.equal(socket.destroy.mock.callCount(), 0);
});

test('initial registration failure retries in the same receiver with bounded backoff and cancels on stop', async (t) => {
  let attempts = 0;
  let flow = setup(t, {
    register: async () => {
      attempts += 1;
      if (attempts <= 2) {
        throw new Error('fixture-private-registration');
      }
      return credentials;
    },
  });
  await assert.rejects(flow.client.connect(['device']), /connection failed/);
  assert.equal(attempts, 1);
  t.mock.timers.tick(4999);
  await settle();
  assert.equal(attempts, 1);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(attempts, 2);
  t.mock.timers.tick(9999);
  await settle();
  assert.equal(attempts, 2);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(attempts, 3);
  assert.equal(flow.sockets.length, 1);
  let socket = flow.sockets[0];
  socket.emit('secureConnect');
  socket.emit('data', frame(3, 'LoginResponse', {}, true));
  await settle();
  socket.emit('data', push());
  await settle();
  assert.equal(flow.data.length, 1);
  flow.client.disconnect();
  t.mock.timers.tick(60000);
  await settle();
  assert.equal(attempts, 3);
  assert.equal(socket.destroy.mock.callCount(), 1);
});
