// Exercise native Foyer ingestion and commands through a fabricated, account-scoped boundary.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { importSource } from './helpers/import-source.js';
import { DATA_SOURCE, GOOGLE_HOME_FOYER_ENDPOINTS } from '../src/consts.js';

let boundary =
  'data:text/javascript,' +
  encodeURIComponent('export const runtime = {}; export default class { constructor(options) { return runtime.create(options); } }');
let timers =
  'data:text/javascript,' +
  encodeURIComponent(
    'import timers from "node:timers"; export function setTimeout(...args) { return timers.setTimeout(...args); } ' +
      'export function clearTimeout(...args) { return timers.clearTimeout(...args); }',
  );
let { runtime } = await import(boundary);
let location = new URL('../src/api/homegraph.js', import.meta.url);
let source = (await readFile(location, 'utf8'))
  .replace('from \'../grpctransport.js\'', 'from ' + JSON.stringify(boundary))
  .replace('from \'node:timers\'', 'from ' + JSON.stringify(timers));
let { default: HomeGraphAPI } = await importSource(location, source);
let device = (id, type) => ({
  id: { googleUuid: id, thirdPartyId: { idType: 'nest-home-assistant-prod', id: 'private-' + id } },
  displayName: id,
  type: 'action.devices.types.' + type,
});
let graph = {
  homes: [
    { uuid: 'home', name: 'Fixture', devices: [device('thermostat', 'THERMOSTAT'), device('sensor', 'SENSOR'), device('lock', 'LOCK')] },
  ],
};
let category = (name, traits) => ({ name, traits: Object.entries(traits).map(([name, value]) => ({ name, value })) });
let temperatureTraits = () => ({
  ...category('temperatureSetting', {
    mode: { text: 'cool' },
    thermostatTemperatureSetpointLowC: { number: 19 },
    thermostatTemperatureSetpointHighC: { number: 24 },
    activeThermostatTemperatureSensors: { array: { values: [{ text: 'sensor' }] } },
    knownThermostatTemperatureSensors: {
      array: { values: [{ properties: { properties: [{ name: 'sensorId', value: { text: 'sensor' } }] } }] },
    },
  }),
  attributes: {
    properties: [
      {
        name: 'availableThermostatModes',
        value: { array: { values: ['heat', 'cool', 'heatcool', 'off', 'eco'].map((text) => ({ text })) } },
      },
    ],
  },
});

function setup(context, options = {}) {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let flow = { transports: [], graph: structuredClone(graph), traits: undefined };
  flow.traits = [
    { uuid: { value: 'thermostat' }, category: [temperatureTraits(), category('fanSettings', { fanTimerEndTimestampSec: { number: 0 } })] },
    { uuid: { value: 'sensor' }, category: [] },
    { uuid: { value: 'lock' }, category: [category('lockUnlock', { isLocked: { boolean: true } })] },
  ];
  runtime.create = (options) => {
    let transport = {
      options,
      release: context.mock.fn(),
      command: context.mock.fn(async (prefix, service, method) => ({
        status: 0,
        data: [
          structuredClone(
            method === 'GetHomeGraph'
              ? flow.graph
              : method === 'GetTraits'
                ? { device: flow.traits }
                : method === 'GetUserPreferences'
                  ? { item: { name: 'Technical Information' } }
                  : {},
          ),
        ],
      })),
    };
    flow.transports.push(transport);
    return transport;
  };
  let session = new EventEmitter();
  session.account = { authorised: true, fieldTest: options.fieldTest === true, cameraAuth: { oauth2: 'oauth-fixture' } };
  session.connect = context.mock.fn(async () => true);
  flow.session = session;
  flow.client = new HomeGraphAPI({ session, uuid: 'account', poll: false, ...options });
  context.after(() => flow.client.disconnect());
  return flow;
}

for (let fieldTest of [false, true]) {
  test('connect reads graph/traits once and uses owning session OAuth: fieldTest=' + fieldTest, async (context) => {
    let batches = [];
    let flow = setup(context, { fieldTest, onData: (batch) => batches.push(batch) });
    assert.equal(await flow.client.connect(), true);
    assert.equal(await flow.client.connect(), true);
    let transport = flow.transports[0];
    assert.equal(flow.transports.length, 1);
    assert.equal(
      transport.options.endpointHost,
      fieldTest === true ? GOOGLE_HOME_FOYER_ENDPOINTS.FIELD_TEST : GOOGLE_HOME_FOYER_ENDPOINTS.PRODUCTION,
    );
    assert.equal(transport.options.getAuthHeader(), 'Bearer oauth-fixture');
    assert.equal(transport.options.origin, 'https://home.google.com');
    assert.equal(transport.command.mock.callCount(), 2);
    assert.equal(flow.client.resources.size, 3);
    assert.equal(flow.client.homes.size, 1);
    assert.equal(batches[0].source, DATA_SOURCE.HOMEGRAPH);
    assert.equal(batches[0].changes.length, 4);
    assert.equal(batches[0].isCurrent(), true);
    assert.equal(transport.command.mock.calls[0].arguments[3].deviceTypesToUnhideArray.length, 5);
    let result = await flow.client.get();
    assert.deepEqual(result.value, flow.graph);
    result.value.homes[0].name = 'caller-change';
    assert.equal((await flow.client.get()).value.homes[0].name, 'Fixture');
    let traits = await flow.client.get('DEVICE_GH_account_thermostat', 'traits');
    traits.length = 0;
    assert.equal(flow.client.resources.get('thermostat').traits.length, 2);
    assert.equal(await flow.client.get('sensor', 'missing'), undefined);
  });
}

test('direct OAuth provider works without a Nest login and reads renewed credentials', async (context) => {
  let token = 'external-oauth';
  let flow = setup(context, { session: undefined, getAccessToken: () => token });
  await flow.client.connect();
  let headers = flow.transports[0].options.getAuthHeader;
  assert.equal(headers(), 'Bearer external-oauth');
  token = 'renewed-oauth';
  await flow.client.refresh();
  assert.equal(headers(), 'Bearer renewed-oauth');
  token = undefined;
  assert.equal(headers(), '');
});

for (let reason of ['missing session', 'denied login', 'unauthorised', 'missing OAuth', 'empty OAuth']) {
  test('refuses unavailable credentials: ' + reason, async (context) => {
    let flow = setup(context, reason === 'missing session' ? { session: undefined } : {});
    if (reason === 'denied login') {
      flow.session.connect = async () => false;
    }
    if (reason === 'unauthorised') {
      flow.session.account.authorised = false;
    }
    if (reason === 'missing OAuth') {
      delete flow.session.account.cameraAuth;
    }
    if (reason === 'empty OAuth') {
      flow.session.account.cameraAuth.oauth2 = ' ';
    }
    await assert.rejects(flow.client.connect(), /authenticate|Google OAuth/);
    assert.equal(flow.transports.length, 0);
  });
}

test('identical reads suppress updates, volatile credentials do not generate changes, and removals are source scoped', async (context) => {
  let batches = [];
  let flow = setup(context, { onData: (batch) => batches.push(batch) });
  await flow.client.connect();
  flow.graph.responseTimestamp = 'new timestamp';
  flow.graph.homes[0].devices[0].localAuthToken = 'private-local-token';
  await flow.client.refresh();
  assert.equal(batches.length, 1);
  flow.traits[0].category[0].traits[0].value.text = 'heat';
  await flow.client.refresh();
  assert.equal(batches.length, 2);
  assert.deepEqual([...batches[1].changes[0].fields], ['traits']);
  assert.equal(JSON.stringify(batches).includes('private-local-token'), false);
  flow.graph.homes[0].devices.pop();
  flow.traits.pop();
  await flow.client.refresh();
  assert.deepEqual(batches[2].changes, [{ resourceId: 'DEVICE_GH_account_lock', remove: true, notify: true }]);
  flow.graph.homes = [];
  await flow.client.refresh();
  assert.equal(flow.client.resources.size, 0);
  assert.equal(flow.client.homes.size, 0);
});

for (let result of ['rejected', 'thrown']) {
  test('consumer failure retains the committed snapshot and retries delivery: ' + result, async (context) => {
    let reject = false;
    let flow = setup(context, {
      onData: () => {
        if (reject === true) {
          if (result === 'thrown') {
            throw new Error('fixture consumer failure');
          }
          return false;
        }
      },
    });
    await flow.client.connect();
    let previous = flow.client.resources;
    reject = true;
    flow.graph.homes[0].devices[0].displayName = 'Changed';
    await assert.rejects(flow.client.refresh());
    assert.equal(flow.client.resources, previous);
    reject = false;
    await flow.client.refresh();
    assert.equal(flow.client.resources.get('thermostat').value.googleHome.displayName, 'Changed');
  });
}

for (let failure of ['status', 'throw', 'missing', 'incomplete', 'foreign', 'duplicate']) {
  test('failed or mismatched refresh retains previous state and sanitises failures: ' + failure, async (context) => {
    let flow = setup(context);
    await flow.client.connect();
    let previous = flow.client.resources;
    let transport = flow.transports[0];
    let original = transport.command;
    transport.command = async (...args) => {
      if (failure === 'status') {
        return { status: 7, message: 'Bearer private-token' };
      }
      if (failure === 'throw') {
        throw new Error('Bearer private-token');
      }
      if (failure === 'missing') {
        return { status: 0, data: [] };
      }
      if (args[2] === 'GetTraits') {
        let states = structuredClone(flow.traits);
        if (failure === 'incomplete') {
          states.pop();
        }
        if (failure === 'foreign') {
          states[0].uuid.value = 'foreign-account-device';
        }
        if (failure === 'duplicate') {
          states[1] = states[0];
        }
        return { status: 0, data: [{ device: states }] };
      }
      return original(...args);
    };
    await assert.rejects(flow.client.refresh(), (error) => {
      assert.equal(String(error).includes('private-token'), false);
      return true;
    });
    assert.equal(flow.client.resources, previous);
    assert.equal(flow.session.account.authorised, true);
  });
}

for (let retire of ['disconnect', 'logout', 'token replacement']) {
  test('pending graph completion cannot commit after ' + retire, async (context) => {
    let token = 'original-oauth';
    let flow = setup(context, { getAccessToken: () => token });
    await flow.client.connect();
    let previous = flow.client.resources;
    let reply = Promise.withResolvers();
    flow.transports[0].command = () => reply.promise;
    let first = flow.client.refresh();
    let second = flow.client.refresh();
    await setImmediate();
    if (retire === 'disconnect') {
      flow.client.disconnect();
    }
    if (retire === 'logout') {
      flow.session.account.authorised = false;
    }
    if (retire === 'token replacement') {
      token = 'replacement-oauth';
    }
    reply.resolve({ status: 0, data: [flow.graph] });
    await Promise.all([first, second]);
    assert.equal(flow.client.resources, previous);
  });
}

test('session refresh resumes an active client but explicit disconnect prevents restart', async (context) => {
  let flow = setup(context);
  await flow.client.connect();
  flow.session.emit('disconnect', true);
  flow.session.account.cameraAuth.oauth2 = 'replacement';
  flow.session.emit('authorised');
  await setImmediate();
  assert.equal(flow.transports.length, 2);
  assert.equal(flow.transports[0].release.mock.callCount(), 1);
  assert.equal(flow.transports[1].options.getAuthHeader(), 'Bearer replacement');
  flow.client.disconnect();
  flow.session.emit('authorised');
  await setImmediate();
  assert.equal(flow.transports.length, 2);
});

test('initial login credential replacement does not cancel connect', async (context) => {
  let flow = setup(context);
  flow.session.connect = async () => {
    flow.session.emit('disconnect', true);
    return true;
  };
  assert.equal(await flow.client.connect(), true);
});

test('disconnect during login cannot create a late transport', async (context) => {
  let flow = setup(context);
  let login = Promise.withResolvers();
  flow.session.connect = () => login.promise;
  let pending = flow.client.connect();
  flow.client.disconnect();
  login.resolve(true);
  assert.equal(await pending, false);
  assert.equal(flow.transports.length, 0);
  await assert.rejects(flow.client.refresh(), /disconnected/);
});

test('two-second polling is sequential, backs off failures and stops on disconnect', async (context) => {
  let flow = setup(context, { poll: true });
  await flow.client.connect();
  let transport = flow.transports[0];
  let reply = Promise.withResolvers();
  transport.command = context.mock.fn(() => reply.promise);
  context.mock.timers.tick(2000);
  await setImmediate();
  assert.equal(transport.command.mock.callCount(), 1);
  context.mock.timers.tick(20000);
  await setImmediate();
  assert.equal(transport.command.mock.callCount(), 1);
  reply.resolve({ status: 14, message: 'private' });
  await setImmediate();
  context.mock.timers.tick(4999);
  assert.equal(transport.command.mock.callCount(), 1);
  context.mock.timers.tick(1);
  await setImmediate();
  assert.equal(transport.command.mock.callCount(), 2);
  flow.client.disconnect();
  context.mock.timers.tick(60000);
  await setImmediate();
  assert.equal(transport.command.mock.callCount(), 2);
});

test('cached device queries and preferences cannot discover or address an unrelated device', async (context) => {
  let flow = setup(context);
  await assert.rejects(flow.client.get('unknown', 'traits'), /discovered device/);
  assert.equal(flow.transports.length, 0);
  await flow.client.connect();
  await assert.rejects(flow.client.getUserPreferences('foreign-home', 'sensor', 25), /discovered device/);
  let value = await flow.client.getUserPreferences('home', 'sensor', 25);
  assert.equal(value.item.name, 'Technical Information');
  assert.equal(flow.transports[0].command.mock.calls.at(-1).arguments[2], 'GetUserPreferences');
});

for (let [id, values, method, expected] of [
  [
    'lock',
    { bolt_lock: false },
    'UpdateTraits',
    {
      request: [
        {
          deviceId: { uuid: 'lock', internalId: { source: 'nest-home-assistant-prod' } },
          categories: [category('lockUnlock', { isLocked: { boolean: false } })],
        },
      ],
    },
  ],
  ['thermostat', { active_sensor: true }, 'UpdateTraits', undefined],
  ['sensor', { active_sensor: true }, 'UpdateTraits', undefined],
  ['sensor', { active_sensor: false }, 'UpdateTraits', undefined],
  [
    'thermostat',
    { hvac_mode: 'heat', target_temperature: 21 },
    'UpdateTargetTemperature',
    { deviceId: 'thermostat', mode: 'heat', temperature: { value: 21 }, unknown4: 6 },
  ],
  [
    'thermostat',
    { hvac_mode: 'range', target_temperature_low: 18, target_temperature_high: 25 },
    'UpdateTargetTemperatureRange',
    { deviceId: 'thermostat', tempLow: { value: 18 }, tempHigh: { value: 25 }, unknown4: 6 },
  ],
  [
    'thermostat',
    { target_temperature_high: 24.5 },
    'UpdateTargetTemperature',
    { deviceId: 'thermostat', mode: 'cool', temperature: { value: 24.5 }, unknown4: 6 },
  ],
  ['thermostat', { eco_mode: 'manual' }, 'UpdateThermostatMode', { deviceId: 'thermostat', mode: 'eco', unknown3: 6 }],
  ['thermostat', { eco_mode: 'off' }, 'UpdateThermostatMode', { deviceId: 'thermostat', mode: 'cool', unknown3: 6 }],
  ['thermostat', { eco_mode: 'off', hvac_mode: 'heat' }, 'UpdateThermostatMode', undefined],
  ['thermostat', { fan_state: true }, 'UpdateThermostatFanMode', { deviceId: 'thermostat', runTimeSeconds: { value: 900 } }],
  [
    'thermostat',
    { fan_state: true, fan_duration: 1800, fan_timer_speed: 1 },
    'UpdateThermostatFanMode',
    { deviceId: 'thermostat', runTimeSeconds: { value: 1800 } },
  ],
  [
    'thermostat',
    { fan_state: false, fan_timer_speed: 0 },
    'UpdateThermostatFanMode',
    { deviceId: 'thermostat', runTimeSeconds: { value: 0 } },
  ],
]) {
  test('known SET maps ' + JSON.stringify(values), async (context) => {
    let flow = setup(context);
    await flow.client.connect();
    let before = structuredClone(flow.client.resources);
    await flow.client.set('DEVICE_GH_account_' + id, values);
    let call = flow.transports[0].command.mock.calls.at(-1).arguments;
    assert.equal(call[2], method);
    if (expected !== undefined) {
      assert.deepEqual(call[3], expected);
    }
    if (Object.hasOwn(values, 'active_sensor') === true) {
      let request = call[3].request[0];
      assert.equal(request.deviceId.uuid, 'thermostat');
      assert.deepEqual(request.categories[0].traits[0].value.array.values, [
        { text: id === 'sensor' && values.active_sensor === true ? 'sensor' : 'thermostat' },
      ]);
    }
    assert.deepEqual(flow.client.resources, before);
  });
}

for (let [id, values] of [
  ['foreign', { bolt_lock: true }],
  ['lock', { bolt_lock: 'true' }],
  ['sensor', { bolt_lock: true }],
  ['thermostat', { active_sensor: false }],
  ['sensor', { active_sensor: 1 }],
  ['thermostat', { hvac_mode: 'invalid' }],
  ['sensor', { hvac_mode: 'heat' }],
  ['thermostat', { eco_mode: 'invalid' }],
  ['thermostat', { target_temperature: NaN }],
  ['thermostat', { target_temperature: 100 }],
  ['thermostat', { target_temperature_low: 20 }],
  ['thermostat', { fan_state: 'on' }],
  ['thermostat', { fan_state: true, fan_duration: 2 }],
  ['thermostat', { fan_state: true, fan_timer_speed: 5 }],
  ['thermostat', { fan_duration: 900 }],
  ['thermostat', { unknown: true }],
]) {
  test('invalid SET sends no command: ' + id + ' ' + JSON.stringify(values), async (context) => {
    let flow = setup(context);
    await flow.client.connect();
    let transport = flow.transports[0];
    let count = transport.command.mock.callCount();
    await assert.rejects(flow.client.set(id, values));
    assert.equal(transport.command.mock.callCount(), count);
  });
}

for (let response of [
  { status: 7, message: 'secret-backend' },
  { status: 0, data: [null] },
  { status: 0, data: [{ device: 'bad' }] },
  { status: 0, data: [{ device: [{ uuid: { value: 'foreign' } }] }] },
  {
    status: 0,
    data: [{ device: [{ uuid: { value: 'lock' }, category: [category('deviceStatus', { challenge: { text: 'secret-backend' } })] }] }],
  },
]) {
  test('SET rejects backend failures and challenges without disclosing backend details ' + JSON.stringify(response), async (context) => {
    let flow = setup(context);
    await flow.client.connect();
    flow.transports[0].command = async () => response;
    await assert.rejects(
      flow.client.set('lock', { bolt_lock: false }),
      (error) => error instanceof AggregateError && error.message.includes('secret-backend') === false,
    );
  });
}

test('failed mode change prevents dependent temperatures while independent commands continue', async (context) => {
  let flow = setup(context);
  await flow.client.connect();
  let transport = flow.transports[0];
  transport.command = context.mock.fn(async (prefix, service, method) => ({
    status: method === 'UpdateThermostatMode' ? 7 : 0,
    data: [{}],
  }));
  await assert.rejects(flow.client.set('thermostat', { hvac_mode: 'heat', target_temperature: 21, fan_state: true }), AggregateError);
  assert.deepEqual(
    transport.command.mock.calls.map((call) => call.arguments[2]),
    ['UpdateThermostatMode', 'UpdateThermostatFanMode'],
  );
});

test('SET cannot report success after disconnect or token replacement', async (context) => {
  let flow = setup(context);
  await flow.client.connect();
  let reply = Promise.withResolvers();
  flow.transports[0].command = () => reply.promise;
  let pending = flow.client.set('lock', { bolt_lock: false });
  flow.client.disconnect();
  reply.resolve({ status: 0, data: [{}] });
  await assert.rejects(pending, AggregateError);
  await assert.rejects(flow.client.set('lock', { bolt_lock: false }), /command transport is unavailable/);
});

for (let reason of ['homes', 'unassigned', 'home-id', 'duplicate-home', 'device-id', 'conflicting-home', 'limit']) {
  test('invalid graph preserves previous cache: ' + reason, async (context) => {
    let flow = setup(context);
    await flow.client.connect();
    let before = flow.client.resources;
    if (reason === 'homes') {
      flow.graph.homes = {};
    }
    if (reason === 'unassigned') {
      flow.graph.unassignedDevices = {};
    }
    if (reason === 'home-id') {
      flow.graph.homes[0].uuid = '';
    }
    if (reason === 'duplicate-home') {
      flow.graph.homes.push(structuredClone(flow.graph.homes[0]));
    }
    if (reason === 'device-id') {
      flow.graph.homes[0].devices[0].id = {};
    }
    if (reason === 'conflicting-home') {
      flow.graph.homes.push({ uuid: 'foreign', devices: [device('sensor', 'SENSOR')] });
    }
    if (reason === 'limit') {
      flow.graph.unassignedDevices = Array.from({ length: 501 }, (_, index) => device('extra-' + index, 'SENSOR'));
    }
    await assert.rejects(flow.client.refresh());
    assert.equal(flow.client.resources, before);
  });
}

test('room duplicates are merged and unassigned devices retain no fabricated home', async (context) => {
  let flow = setup(context);
  flow.graph.homes[0].rooms = [{ uuid: 'room', devices: [device('sensor', 'SENSOR')] }];
  flow.graph.unassignedDevices = [device('extra', 'OTHER')];
  flow.traits.push({ uuid: { value: 'extra' }, category: [] });
  await flow.client.connect();
  assert.equal(flow.client.resources.size, 4);
  assert.equal(flow.client.resources.get('sensor').roomId, 'room');
  assert.equal(flow.client.resources.get('extra').structureId, undefined);
  assert.equal(flow.client.resources.get('extra').metadata.type, undefined);
});

for (let reason of [
  'missing-list',
  'foreign-home',
  'ambiguous-parent',
  'missing-source',
  'missing-selected',
  'not-selected',
  'thermostat-list',
  'thermostat-source',
]) {
  test('sensor selection respects capability and thermostat ownership: ' + reason, async (context) => {
    let flow = setup(context);
    await flow.client.connect();
    let parent = flow.client.resources.get('thermostat');
    let traits = parent.traits[0].traits;
    let known = traits.find((trait) => trait.name === 'knownThermostatTemperatureSensors');
    let active = traits.find((trait) => trait.name === 'activeThermostatTemperatureSensors');
    if (reason === 'missing-list') {
      known.value = {};
    }
    if (reason === 'foreign-home') {
      parent.structureId = 'foreign';
    }
    if (reason === 'ambiguous-parent') {
      let other = structuredClone(parent);
      other.id = 'other';
      flow.client.resources.set('other', other);
    }
    if (reason === 'missing-source' || reason === 'thermostat-source') {
      delete parent.device.id.thirdPartyId;
    }
    if (reason === 'missing-selected' || reason === 'thermostat-list') {
      active.value = {};
    }
    if (reason === 'not-selected') {
      active.value.array.values = [{ text: 'thermostat' }];
    }
    let count = flow.transports[0].command.mock.callCount();
    await assert.rejects(
      flow.client.set(reason.startsWith('thermostat') === true ? 'thermostat' : 'sensor', {
        active_sensor: reason === 'not-selected' ? false : true,
      }),
    );
    assert.equal(flow.transports[0].command.mock.callCount(), count);
  });
}

for (let [mode, values, accepted] of [
  ['heatcool', { target_temperature: 21 }, false],
  ['heatcool', { target_temperature_low: 26 }, false],
  ['heatcool', { target_temperature_high: 26 }, true],
  ['heatcool', { target_temperature_low: 18 }, true],
  ['heat', { target_temperature_low: 21 }, true],
  ['heat', { target_temperature_high: 21 }, false],
  ['off', { target_temperature: 21 }, false],
]) {
  test('temperature writes use reported range and operating mode ' + mode + JSON.stringify(values), async (context) => {
    let flow = setup(context);
    let category = flow.traits[0].category[0];
    category.traits.find((trait) => trait.name === 'mode').value.text = mode;
    category.attributes.properties.push(
      {
        name: 'thermostatTemperatureRange',
        value: {
          properties: {
            properties: [
              { name: 'minThresholdCelsius', value: { number: 10 } },
              { name: 'maxThresholdCelsius', value: { number: 30 } },
            ],
          },
        },
      },
      { name: 'bufferRangeCelsius', value: { number: 2 } },
    );
    await flow.client.connect();
    if (accepted === true) {
      await flow.client.set('thermostat', values);
    } else {
      await assert.rejects(flow.client.set('thermostat', values));
    }
  });
}

for (let reason of ['token', 'snapshot', 'throw']) {
  test('pending commands reject retired work: ' + reason, async (context) => {
    let flow = setup(context);
    await flow.client.connect();
    let reply = Promise.withResolvers();
    flow.transports[0].command = () => reply.promise;
    let pending = flow.client.set('sensor', { active_sensor: true });
    if (reason === 'token') {
      flow.session.account.cameraAuth.oauth2 = 'replacement-token';
    }
    if (reason === 'snapshot') {
      flow.client.resources.set('thermostat', structuredClone(flow.client.resources.get('thermostat')));
    }
    if (reason === 'throw') {
      flow.client.disconnect();
      reply.reject(new Error('secret-network'));
    } else {
      reply.resolve({ status: 0, data: [{}] });
    }
    await assert.rejects(pending, AggregateError);
  });
}

test('successful device reply accepts empty or null error markers', async (context) => {
  let flow = setup(context);
  await flow.client.connect();
  flow.transports[0].command = async () => ({
    status: 0,
    data: [
      { device: [{ uuid: { value: 'lock' }, category: [category('deviceStatus', { error: { text: '' }, challenge: { nullValue: 0 } })] }] },
    ],
  });
  await flow.client.set('lock', { bolt_lock: true });
});

test('a failed resumed connection is logged without leaking credentials', async (context) => {
  let logs = [];
  let flow = setup(context, { log: { debug: (message) => logs.push(message) } });
  await flow.client.connect();
  flow.session.emit('disconnect', true);
  flow.session.connect = async () => false;
  flow.session.emit('authorised');
  await setImmediate();
  assert.deepEqual(logs, ['Unable to resume HomeGraph API']);
});

for (let values of [undefined, null, [], true, 'setting']) {
  test('SET parameter validation matches protobuf for ' + JSON.stringify(values), async (context) => {
    let flow = setup(context);
    await flow.client.connect();
    let count = flow.transports[0].command.mock.callCount();
    await assert.rejects(flow.client.set('lock', values), /SET requires valid parameters/);
    assert.equal(flow.transports[0].command.mock.callCount(), count);
  });
}

test('SET accepts empty and null-prototype setting objects like protobuf', async (context) => {
  let flow = setup(context);
  await flow.client.connect();
  let transport = flow.transports[0];
  let count = transport.command.mock.callCount();
  assert.equal(await flow.client.set('lock', {}), undefined);
  assert.equal(transport.command.mock.callCount(), count);
  let values = Object.create(null);
  values.bolt_lock = false;
  await flow.client.set('lock', values);
  assert.equal(transport.command.mock.callCount(), count + 1);
});

test('SET requires discovery before sending commands even with a valid OAuth token', async (context) => {
  let flow = setup(context);
  // Retained cache entries do not substitute for this connection's initial trait read.
  flow.client.resources.set('lock', { source: DATA_SOURCE.HOMEGRAPH });
  await assert.rejects(flow.client.set('lock', { bolt_lock: false }), /command transport is unavailable/);
  assert.equal(flow.transports.length, 0);
});
