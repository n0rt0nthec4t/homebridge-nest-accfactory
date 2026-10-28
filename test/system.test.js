// Exercise selected private system API methods without booting Homebridge or contacting upstream services.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';
import test from 'node:test';
import { DATA_SOURCE, DEVICE_TYPE } from '../src/consts.js';
import { createSupportDump } from '../src/supportdump.js';
import { attachAPIClients } from './helpers/api-clients.js';

let source = await readFile(new URL('../src/system.js', import.meta.url), 'utf8');

let accountsBegin = source.indexOf('  #createAccounts() {');
let accountsEnd = source.indexOf('  async #applyData(', accountsBegin);
assert.ok(accountsBegin !== -1 && accountsEnd > accountsBegin, 'Connection callback boundaries must exist');

// Capture the production authorisation callback while isolating cloud ingestion and device delivery.
let createAuthHost = new Function(
  'trackedDevices',
  'rawData',
  'HomeKitDevice',
  'DEVICE_TYPE',
  'const Accounts = { fromConfig: (config, options) => options };' +
    'return new class {' +
    '#trackedDevices = trackedDevices; #rawData = rawData; config = { options: {} };' +
    '#accounts; async #applyData() {}' +
    'callback() { return this.#createAccounts().onAuthorised; }' +
    source.slice(accountsBegin, accountsEnd) +
    '};',
);

test('account authorisation and refresh update only owned camera-family credentials', async () => {
  let tracked = new Map();
  let raw = {};
  for (let account of ['account-A', 'account-B']) {
    for (let type of [DEVICE_TYPE.CAMERA, DEVICE_TYPE.DOORBELL, DEVICE_TYPE.FLOODLIGHT, DEVICE_TYPE.THERMOSTAT]) {
      let id = account + '-' + type;
      tracked.set(id, { uuid: id, type, nest_google_device_uuid: id });
      raw[id] = { connection: account };
    }
  }
  tracked.set('missing', { uuid: 'missing', type: DEVICE_TYPE.CAMERA, nest_google_device_uuid: 'removed' });
  let updates = [];
  let host = createAuthHost(tracked, raw, { UPDATE: 'UPDATE', message: async (...args) => updates.push(args) }, DEVICE_TYPE);
  for (let wasAuthorised of [false, true]) {
    for (let account of ['account-A', 'account-B']) {
      updates.length = 0;
      let cameraAuth = { token: account + '-new-token' };
      await host.callback()(account, { cameraAuth }, { wasAuthorised });
      assert.deepEqual(
        updates,
        [DEVICE_TYPE.CAMERA, DEVICE_TYPE.DOORBELL, DEVICE_TYPE.FLOODLIGHT].map((type) => [
          account + '-' + type,
          'UPDATE',
          { apiAccess: cameraAuth },
        ]),
      );
    }
  }
});

test('camera credential refresh follows the selected resource after Nest/Google source switches', async () => {
  let tracked = new Map([['camera', { uuid: 'camera', type: DEVICE_TYPE.CAMERA, nest_google_device_uuid: 'quartz.camera' }]]);
  let raw = { 'quartz.camera': { connection: 'nest-account' }, DEVICE_CAMERA: { connection: 'google-account' } };
  let updates = [];
  let host = createAuthHost(tracked, raw, { UPDATE: 'UPDATE', message: async (...args) => updates.push(args) }, DEVICE_TYPE);
  let refresh = host.callback();
  for (let [resource, owner] of [
    ['quartz.camera', 'nest-account'],
    ['DEVICE_CAMERA', 'google-account'],
    ['quartz.camera', 'nest-account'],
  ]) {
    tracked.get('camera').nest_google_device_uuid = resource;
    for (let account of ['nest-account', 'google-account']) {
      updates.length = 0;
      let cameraAuth = { token: account + '-token' };
      await refresh(account, { cameraAuth }, { wasAuthorised: true });
      assert.deepEqual(updates, owner === account ? [['camera', 'UPDATE', { apiAccess: cameraAuth }]] : []);
    }
  }
});

let processDataBegin = source.indexOf('  async #processData(uuid, changedData = undefined) {');
let processDataEnd = source.indexOf('  async #set(', processDataBegin);
assert.ok(processDataBegin !== -1 && processDataEnd > processDataBegin, 'Data processing method boundaries must exist');

// Run discovery, source selection, UPDATE dispatch and SET-handler registration from the production method.
// Device mapping and cloud writes are boundaries supplied by the test; no cloud or Homebridge instance is started.
let createDataHost = new Function(
  'HomeKitDevice',
  'DATA_SOURCE',
  'DEVICE_TYPE',
  'deviceModules',
  'rawData',
  'getDeviceHKCategory',
  'createSupportDump',
  'return new class {' +
    '#accounts = new Map([["nest-account", { name: "Nest" }], ["google-account", { name: "Google" }]]);' +
    '#deviceModules = deviceModules; #rawData = rawData; #trackedDevices = new Map(); #supportDumpWriter;' +
    'config = { options: {} }; api = {}; cachedAccessories = []; writes = [];' +
    'async #set(...args) { this.writes.push(args); } async #get() {}' +
    'run() { return this.#processData("google-account"); }' +
    'tracked() { return this.#trackedDevices.get("SERIAL"); }' +
    source.slice(processDataBegin, processDataEnd) +
    '};',
);

function setupDataProcessing(type) {
  let accessory;
  let handlers = new Map();
  let updates = [];
  class Device {
    static TYPE = type;
    static VERSION = 'test';
    constructor(cached, api, data) {
      this.uuid = 'stable-homekit-id';
      this.deviceData = structuredClone(data);
      accessory = this;
    }

    async add() {}
  }
  let mapped = {};
  let modules = new Map([[type, { class: Device, processRawData: () => mapped }]]);
  let raw = {
    'device.nest': { source: DATA_SOURCE.NEST, connection: 'nest-account' },
    DEVICE_GOOGLE: { source: DATA_SOURCE.GOOGLE, connection: 'google-account' },
  };
  let homeKit = {
    SET: 'SET',
    GET: 'GET',
    UPDATE: 'UPDATE',
    message: async (uuid, type, payload) => {
      assert.equal(uuid, 'stable-homekit-id');
      if (typeof payload === 'function') {
        handlers.set(type, payload);
      } else if (type === 'UPDATE') {
        updates.push(payload);
        accessory.deviceData = { ...accessory.deviceData, ...payload };
      }
    },
  };
  let host = createDataHost(homeKit, DATA_SOURCE, DEVICE_TYPE, modules, raw, () => 1, createSupportDump);
  return {
    host,
    raw,
    updates,
    update: async (source, temperature, full = false) => {
      mapped.SERIAL = {
        full,
        data: {
          serialNumber: 'SERIAL',
          description: 'Device',
          excluded: false,
          nest_google_device_uuid: source === DATA_SOURCE.NEST ? 'device.nest' : 'DEVICE_GOOGLE',
          current_temperature: temperature,
        },
      };
      await host.run();
    },
    data: () => accessory.deviceData,
    set: () => handlers.get('SET')({ uuid: accessory.deviceData.nest_google_device_uuid, target_temperature: 23 }),
  };
}

test('disabled support dumps do not inspect raw payloads during device updates', async () => {
  let flow = setupDataProcessing(DEVICE_TYPE.THERMOSTAT);
  let reads = 0;
  Object.defineProperty(flow.raw['device.nest'], 'value', {
    get() {
      reads++;
      throw new Error('Diagnostic payload read');
    },
  });
  await flow.update(DATA_SOURCE.NEST, 20, true);
  assert.equal(reads, 0);
  assert.equal(flow.data().current_temperature, 20);
});

test('system routes enabled API dumps through redaction without changing accessory data', async () => {
  let flow = setupDataProcessing(DEVICE_TYPE.THERMOSTAT);
  let lines = [];
  flow.host.config.options.supportDump = true;
  flow.host.log = { info: (...args) => lines.push(args.join(' ')), warn: () => assert.fail('Unexpected support-dump warning') };
  flow.raw['device.nest'].connection = 'google-account';
  flow.raw['device.nest'].value = { access_token: 'Private Account Token', serial_number: 'PRIVATE_SERIAL0001', temperature: 20 };
  await flow.update(DATA_SOURCE.NEST, 20, true);
  assert.equal(lines.join('\n').includes('Private Account Token'), false);
  assert.equal(lines.join('\n').includes('PRIVATE_SERIAL0001'), false);
  assert.equal(lines.join('\n').includes('**REDACTED_'), true);
  assert.equal(flow.raw['device.nest'].value.access_token, 'Private Account Token');
  assert.equal(flow.data().nest_google_device_uuid, 'device.nest');
});

for (let type of [DEVICE_TYPE.THERMOSTAT, DEVICE_TYPE.PROTECT, DEVICE_TYPE.TEMPSENSOR]) {
  for (let initialSource of [DATA_SOURCE.NEST, DATA_SOURCE.GOOGLE]) {
    test(type + ' retains Google state and SET routing after either source arrives first: ' + initialSource, async () => {
      let flow = setupDataProcessing(type);
      await flow.update(initialSource, 20, true);
      await flow.update(DATA_SOURCE.GOOGLE, 21);
      let before = flow.updates.length;
      await flow.update(DATA_SOURCE.NEST, 19);
      assert.equal(flow.updates.length, before, 'rejected Nest update must not reach the accessory');
      assert.equal(flow.data().current_temperature, 21);
      assert.equal(flow.data().nest_google_device_uuid, 'DEVICE_GOOGLE');
      assert.equal(flow.host.tracked().source, DATA_SOURCE.GOOGLE);
      assert.equal(flow.host.tracked().nest_google_device_uuid, 'DEVICE_GOOGLE');
      await flow.set();
      assert.equal(flow.host.writes[0][0], 'google-account');
      assert.equal(flow.host.writes[0][1], 'DEVICE_GOOGLE');
      // Same-source updates continue to change the accessory after a rejected transition.
      await flow.update(DATA_SOURCE.GOOGLE, 22);
      assert.equal(flow.data().current_temperature, 22);
    });
  }
}

for (let type of [DEVICE_TYPE.CAMERA, DEVICE_TYPE.DOORBELL, DEVICE_TYPE.FLOODLIGHT]) {
  test(type + ' retains Nest fallback and can return to Google with consistent SET routing', async () => {
    let flow = setupDataProcessing(type);
    await flow.update(DATA_SOURCE.GOOGLE, 21, true);
    await flow.update(DATA_SOURCE.NEST, 19);
    assert.equal(flow.data().current_temperature, 19);
    assert.equal(flow.host.tracked().source, DATA_SOURCE.NEST);
    assert.equal(flow.host.tracked().nest_google_device_uuid, 'device.nest');
    await flow.set();
    assert.equal(flow.host.writes[0][0], 'nest-account');
    assert.equal(flow.host.writes[0][1], 'device.nest');
    await flow.update(DATA_SOURCE.GOOGLE, 22);
    assert.equal(flow.host.tracked().source, DATA_SOURCE.GOOGLE);
    assert.equal(flow.data().nest_google_device_uuid, 'DEVICE_GOOGLE');
    await flow.set();
    assert.equal(flow.host.writes[1][0], 'google-account');
    assert.equal(flow.host.writes[1][1], 'DEVICE_GOOGLE');
  });
}

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

  attachAPIClients(connection, { 'quartz.device-id': { value: { nexus_api_http_server_url: 'https://nexus.test' } } }, fetchWrapper, {
    debug: (...args) => logs.push(args),
  });
  return { host: { run: () => connection.nestAPI.get('quartz.device-id', 'camera_events') }, logs, requests };
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

  attachAPIClients(connection, { 'DEVICE_device-id': { source: DATA_SOURCE.GOOGLE, value: {} } }, fetchWrapper);
  return { run: () => connection.googleAPI.get('DEVICE_device-id', 'camera_events') };
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
