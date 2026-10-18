// Exercise cloud SET outcomes through the production routing method and real device commit boundary.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DATA_SOURCE } from '../src/consts.js';
import HomeKitDevice from '../src/HomeKitDevice/HomeKitDevice.js';

let source = await readFile(new URL('../src/system.js', import.meta.url), 'utf8');
let begin = source.indexOf('  async #set(');
let end = source.indexOf('  async #get(', begin);
assert.ok(begin !== -1 && end > begin, 'SET method boundaries must exist');

// Only cloud I/O and account/resource lookup are supplied by the test host.
let createHost = new Function(
  'connection',
  'rawData',
  'fetchWrapper',
  'DATA_SOURCE',
  'crypto',
  'USER_AGENT',
  'return new class {' +
    '#connections = new Map([["account", connection]]); #rawData = rawData;' +
    'run(id, values) { return this.#set("account", id, values); }' +
    source.slice(begin, end) +
    '};',
);

function setup(source, response, options = {}) {
  let requests = [];
  let id = options.id ?? (source === DATA_SOURCE.GOOGLE ? 'DEVICE_TEST' : 'topaz.TEST');
  let connection = {
    authorised: true,
    referer: 'example.test',
    cameraAPIHost: 'example.test',
    transport_url: 'https://example.test',
    token: 'test-token',
    cameraAuth: { key: 'Authorization', value: 'Basic ', token: 'test-token' },
    grpcTransport: {
      command: async (...args) => {
        requests.push(args);
        return typeof response === 'function' ? response(...args) : response;
      },
    },
    ...options.connection,
  };
  let raw = { [id]: { source, value: { display_settings: {}, temperature_lock_settings: {} } } };
  let fetcher = Object.assign(
    async (...args) => {
      requests.push(args);
      let data = typeof response === 'function' ? await response(...args) : response;
      return { json: async () => data };
    },
    { POST: 'post' },
  );
  let host = createHost(
    options.missingConnection === true ? undefined : connection,
    raw,
    fetcher,
    DATA_SOURCE,
    globalThis.crypto,
    'test-agent',
  );
  return { run: (values) => host.run(id, values), requests, raw, id };
}

HomeKitDevice.PLUGIN_NAME = 'system-set-test';
let nextSerial = 0;
function deviceFor(context, flow, values) {
  let device = new HomeKitDevice(
    undefined,
    { version: 2.7, hap: { uuid: { generate: (value) => value } } },
    {
      serialNumber: 'set-' + nextSerial++,
      manufacturer: 'Nest',
      model: 'Test',
      description: 'SET test',
      softwareVersion: '1.0.0',
      ...values,
    },
  );
  HomeKitDevice.message(device.uuid, HomeKitDevice.SET, (payload) => flow.run(payload));
  context.after(() => device.remove());
  return device;
}

for (let id of ['topaz.TEST', 'quartz.TEST']) {
  test('REST failure rejects SET without committing requested values: ' + id, async (context) => {
    let failure = new Error('HTTP 503');
    let flow = setup(
      DATA_SOURCE.NEST,
      () => {
        throw failure;
      },
      { id },
    );
    let key = id.startsWith('topaz.') === true ? 'ntp_green_led_enable' : 'streaming_enabled';
    let device = deviceFor(context, flow, { [key]: false });
    await assert.rejects(device.set({ [key]: true }), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [failure]);
      return true;
    });
    assert.equal(flow.requests.length, 1);
    assert.equal(device.deviceData[key], false);
  });
}

for (let [id, response] of [
  ['topaz.TEST', { objects: [] }],
  ['quartz.TEST', { status: 1 }],
]) {
  test('REST application rejection propagates: ' + id, async () => {
    let flow = setup(DATA_SOURCE.NEST, response, { id });
    await assert.rejects(flow.run({ ntp_green_led_enable: true }), AggregateError);
  });
}

for (let command of [false, true]) {
  for (let response of [
    { status: 14, data: [] },
    { status: 14, data: [{ traitOperations: [{ progress: 'COMPLETE' }] }] },
    { status: 0, data: [] },
    { status: 0, data: [{ traitOperations: [{ progress: 'PENDING' }] }] },
    { status: 0, data: [{ traitOperations: [{ progress: 'COMPLETE', status: { code: 7 } }] }] },
  ]) {
    test(
      'Google SET rejects unsuccessful ' + (command === true ? 'command' : 'update') + ': ' + JSON.stringify(response),
      async (context) => {
        let flow = setup(DATA_SOURCE.GOOGLE, response);
        let initial = command === true ? { bolt_lock: false } : { temperature_scale: 'C' };
        let requested = command === true ? { bolt_lock: true } : { temperature_scale: 'F' };
        let device = deviceFor(context, flow, initial);
        await assert.rejects(device.set(requested), AggregateError);
        for (let [key, value] of Object.entries(initial)) {
          assert.equal(device.deviceData[key], value);
        }
      },
    );
  }
}

test('mixed Google outcomes attempt remaining fields and reject the whole local commit', async (context) => {
  let attempts = 0;
  let flow = setup(DATA_SOURCE.GOOGLE, () => ({
    status: attempts++ === 0 ? 14 : 0,
    data: [{ traitOperations: [{ progress: 'COMPLETE' }] }],
  }));
  let device = deviceFor(context, flow, { temperature_scale: 'C', temperature_lock: false });
  await assert.rejects(device.set({ temperature_scale: 'F', temperature_lock: true }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 1);
    return true;
  });
  assert.equal(attempts, 2);
  assert.equal(device.deviceData.temperature_scale, 'C');
  assert.equal(device.deviceData.temperature_lock, false);
});

for (let code of [undefined, 0]) {
  test('successful Google SET commits and accepts omitted protobuf zero status: ' + code, async (context) => {
    let flow = setup(DATA_SOURCE.GOOGLE, {
      status: 0,
      data: [{ traitOperations: [{ progress: 'COMPLETE', status: { code } }] }],
    });
    let device = deviceFor(context, flow, { temperature_scale: 'C' });
    await device.set({ temperature_scale: 'F' });
    assert.equal(device.deviceData.temperature_scale, 'F');
  });
}

test('successful REST SET still commits', async (context) => {
  let flow = setup(DATA_SOURCE.NEST, { objects: [{}] });
  let device = deviceFor(context, flow, { ntp_green_led_enable: false });
  await device.set({ ntp_green_led_enable: true });
  assert.equal(device.deviceData.ntp_green_led_enable, true);
});

for (let [reason, options] of [
  ['missing resource', {}],
  ['missing connection', { missingConnection: true }],
  ['unauthorised connection', { connection: { authorised: false } }],
  ['missing transport', { connection: { grpcTransport: undefined } }],
]) {
  test('unavailable connection or transport rejects SET: ' + reason, async () => {
    let flow = setup(DATA_SOURCE.GOOGLE, {}, options);
    if (reason === 'missing resource') {
      delete flow.raw[flow.id];
    }
    await assert.rejects(flow.run({ temperature_scale: 'F' }));
    assert.equal(flow.requests.length, 0);
  });
}
