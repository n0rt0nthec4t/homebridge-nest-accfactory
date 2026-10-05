// Exercise selected private system API methods without booting Homebridge or contacting upstream services.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { URL } from 'node:url';
import test from 'node:test';

let source = await readFile(new URL('../../src/system.js', import.meta.url), 'utf8');

let begin = source.indexOf('  async #observeGoogleAPI(uuid) {');
let end = source.indexOf('  async #processData(', begin);
assert.ok(begin !== -1 && end > begin, 'Observe method boundaries must exist');
let constants = source.match(/^const API_STREAM_.*$/gm);
assert.equal(constants?.length, 3);

// Expose only this method in a test host. Returning its existing promise chain
// lets tests await completion without sleeps or changes to production visibility.
let createHost = new Function(
  'connection',
  'getProtoTypes',
  'setTimeout',
  'clearTimeout',
  'path',
  constants.join('\n') +
    '\n' +
    'const __dirname = "."; const ACCOUNT_TYPE = { GOOGLE: "google", NEST: "nest" };\n' +
    'return new class {\n' +
    '  #connections = new Map([["account", connection]]);\n' +
    '  #rawData = {}; #trackedDevices = new Map();\n' +
    '  config = { options: { useGoogleAPI: true } };\n' +
    '  async #processData() {}\n' +
    '  async #getLocationWeather() {}\n' +
    '  run() { return this.#observeGoogleAPI("account"); }\n' +
    '  replace(value) { this.#connections.set("account", value); }\n' +
    source.slice(begin, end).replace('    connection.grpcTransport\n', '    return connection.grpcTransport\n') +
    '};',
);

function setup() {
  let pending = Promise.withResolvers();
  let timers = [];
  let cleared = [];
  let calls = [];
  let connection = {
    authorised: true,
    type: 'google',
    grpcTransport: {
      observe: (...args) => {
        calls.push(args);
        return pending.promise;
      },
    },
  };
  let host = createHost(
    connection,
    () => [{ fullName: '.nest.trait.device.Identity' }],
    (callback, delay) => {
      let timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    (timer) => cleared.push(timer),
    path,
  );
  return { host, connection, pending, timers, cleared, calls };
}

test('Observe resolved failures increase retry delay up to 60 seconds', async () => {
  let { host, pending, timers, cleared } = setup();
  pending.resolve({ status: 14 });
  for (let index = 0; index < 6; index++) {
    await host.run();
  }
  assert.deepEqual(
    timers.map((timer) => timer.delay),
    [5000, 10000, 20000, 40000, 60000, 60000],
  );
  assert.equal(cleared[1], timers[0]);
});

test('Observe normal completion uses the one-second restart and schedules the same account', async () => {
  let { host, connection, pending, timers, calls } = setup();
  connection.observeRetryDelay = 40000;
  pending.resolve({ status: 0 });
  await host.run();
  assert.equal(timers[0].delay, 1000);
  await timers[0].callback();
  assert.equal(calls.length, 2);
});

test('Observe rejected promises also use failure backoff', async () => {
  let { host, pending, timers } = setup();
  let running = host.run();
  pending.reject(new Error('transport failed'));
  await running;
  assert.equal(timers[0].delay, 5000);
});

test('a processed Observe update resets accumulated retry backoff', async () => {
  let { host, connection, pending, timers, calls } = setup();
  connection.observeRetryDelay = 40000;
  let running = host.run();
  await calls[0][4]({ observeResponse: [] });
  assert.equal(connection.observeRetryDelay, undefined);
  pending.resolve({ status: 14 });
  await running;
  assert.equal(timers[0].delay, 5000);
});

for (let change of ['unauthorised', 'replaced', 'removed']) {
  test('Observe completion does not restart a connection that was ' + change, async () => {
    let { host, connection, pending, timers, cleared } = setup();
    let running = host.run();
    if (change === 'unauthorised') {
      connection.authorised = false;
    } else {
      host.replace(change === 'replaced' ? { authorised: true } : undefined);
    }
    pending.resolve({ status: 14 });
    await running;
    assert.deepEqual(timers, []);
    assert.deepEqual(cleared, []);
  });
}

test('Observe does not start for an unauthorised connection or disabled Google API', async () => {
  let { host, connection, calls } = setup();
  connection.authorised = false;
  await host.run();
  connection.authorised = true;
  host.config.options.useGoogleAPI = false;
  await host.run();
  assert.deepEqual(calls, []);
});

let cameraEventsBegin = source.indexOf('  async #getCameraEvents(');
let cameraEventsEnd = source.lastIndexOf('\n}');
assert.ok(cameraEventsBegin !== -1 && cameraEventsEnd > cameraEventsBegin, 'Camera events method boundaries must exist');

function setupCameraEvents(fetchImplementation) {
  let logs = [];
  let requests = [];
  let fetchWrapper = async (...args) => {
    requests.push(args);
    return fetchImplementation(...args);
  };
  fetchWrapper.GET = 'get';

  let connection = {
    authorised: true,
    referer: 'home.nest.com',
    cameraAPIHost: 'camera.test',
    cameraAuth: {
      key: 'Authorization',
      value: 'Basic ',
      token: 'token',
    },
  };

  let createCameraEventsHost = new Function(
    'connection',
    'fetchWrapper',
    'logs',
    'crypto',
    'USER_AGENT',
    'return new class {\n' +
      '  #connections = new Map([["account", connection]]);\n' +
      '  config = { options: { useNestAPI: true, useGoogleAPI: false } };\n' +
      '  log = { debug: (...args) => logs.push(args) };\n' +
      '  run() { return this.#getCameraEvents("account", "quartz.device-id", "https://nexus.test"); }\n' +
      source.slice(cameraEventsBegin, cameraEventsEnd) +
      '\n};',
  );

  return {
    host: createCameraEventsHost(connection, fetchWrapper, logs, globalThis.crypto, 'test-agent'),
    logs,
    requests,
  };
}

function setupGoogleCameraEvents(eventTypes) {
  let connection = {
    authorised: true,
    grpcTransport: {
      command: async () => ({
        status: 0,
        data: [
          {
            traitOperations: [
              {
                progress: 'COMPLETE',
                event: {
                  event: {
                    cameraEventWindow: {
                      cameraEvent: [
                        {
                          startTime: { seconds: 100, nanos: 0 },
                          endTime: { seconds: 101, nanos: 0 },
                          eventId: 'event-id',
                          eventType: eventTypes,
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        ],
      }),
    },
  };
  let fetchWrapper = () => {};
  fetchWrapper.GET = 'get';

  let createGoogleCameraEventsHost = new Function(
    'connection',
    'fetchWrapper',
    'crypto',
    'USER_AGENT',
    'return new class {\n' +
      '  #connections = new Map([["account", connection]]);\n' +
      '  config = { options: { useNestAPI: false, useGoogleAPI: true } };\n' +
      '  run() { return this.#getCameraEvents("account", "DEVICE_device-id"); }\n' +
      source.slice(cameraEventsBegin, cameraEventsEnd) +
      '\n};',
  );

  return createGoogleCameraEventsHost(connection, fetchWrapper, globalThis.crypto, 'test-agent');
}

test('Nest camera event timeouts are silent and use one request attempt', async () => {
  let timeout = new Error('The operation was aborted due to timeout');
  timeout.name = 'TimeoutError';
  let requestError = new Error('GET failed after 1 attempt');
  requestError.cause = timeout;
  let { host, logs, requests } = setupCameraEvents(async () => {
    throw requestError;
  });

  assert.deepEqual(await host.run(), []);
  assert.equal(logs.length, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0][2].retry, 1);
});

test('Nest camera event HTTP and malformed-response failures remain visible', async () => {
  let httpError = Object.assign(new Error('HTTP 401'), { status: 401 });
  let http = setupCameraEvents(async () => {
    throw httpError;
  });

  assert.deepEqual(await http.host.run(), []);
  assert.equal(http.logs.length, 1);
  assert.match(http.logs[0][0], /activity notifications/);
  assert.equal(http.logs[0][2], 'HTTP 401');

  let malformed = setupCameraEvents(async () => ({
    json: async () => ({ status_detail: 'unexpected payload' }),
  }));

  assert.deepEqual(await malformed.host.run(), []);
  assert.equal(malformed.logs.length, 1);
  assert.equal(malformed.logs[0][2], 'unexpected payload');
});

test('Google camera event types use Nest-compatible kebab-case names', async () => {
  let host = setupGoogleCameraEvents([
    'EVENT_MOTION',
    'EVENT_UNFAMILIAR_FACE',
    'EVENT_PERSON_TALKING',
    'EVENT_DOG_BARKING',
    'EVENT_VEHICLE',
    'EVENT_PACKAGE_DELIVERED',
    'EVENT_PACKAGE_RETRIEVED',
    'EVENT_PACKAGE_IN_TRANSIT',
    'EVENT_FUTURE_EVENT_TYPE',
    'NOT_AN_EVENT',
  ]);

  let events = await host.run();
  assert.deepEqual(events[0].types, [
    'motion',
    'unfamiliar-face',
    'person-talking',
    'dog-barking',
    'vehicle',
    'package-delivered',
    'package-retrieved',
    'package-in-transit',
    'future-event-type',
  ]);
});
