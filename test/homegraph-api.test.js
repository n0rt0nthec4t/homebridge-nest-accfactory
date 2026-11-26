// Exercise native Foyer ingestion and commands through a fabricated, account-scoped boundary.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { importSource } from './helpers/import-source.js';
import { ACCOUNT_TYPE, DATA_SOURCE, GOOGLE_HOME_FOYER_ENDPOINTS } from '../src/consts.js';

let boundary =
  'data:text/javascript,' +
  encodeURIComponent('export const runtime = {}; export default class { constructor(options) { return runtime.create(options); } }');
let timers =
  'data:text/javascript,' +
  encodeURIComponent(
    'import timers from "node:timers"; export function setTimeout(...args) { return timers.setTimeout(...args); } ' +
      'export function clearTimeout(...args) { return timers.clearTimeout(...args); }',
  );
let pushBoundary =
  'data:text/javascript,' +
  encodeURIComponent(
    'export const kind = \'push\'; export const runtime = {}; ' +
      'export default class { constructor(options) { return runtime.create(options); } }',
  );
let { runtime: pushRuntime } = await import(pushBoundary);
let { runtime } = await import(boundary);
let location = new URL('../src/api/homegraph.js', import.meta.url);
let source = (await readFile(location, 'utf8'))
  .replace('from \'../grpctransport.js\'', 'from ' + JSON.stringify(boundary))
  .replace('from \'./homegraphpush.js\'', 'from ' + JSON.stringify(pushBoundary))
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
  let flow = { pushes: [], transports: [], graph: structuredClone(graph), traits: undefined };
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
  pushRuntime.create = (options) => {
    let push = {
      options,
      connect: context.mock.fn(async (ids) => {
        push.ids = ids;
        options.onStatus(true);
      }),
      disconnect: context.mock.fn(() => options.onStatus(false)),
    };
    flow.pushes.push(push);
    return push;
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
    assert.equal(Buffer.from(transport.options.foyerEnvironment, 'base64').toString('hex'), '0801120b1209342e33332e32372e35');
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
    let traits = await flow.client.get('thermostat', 'traits');
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
  assert.deepEqual([...batches[1].changes[0].fields], ['temperatureSetting.mode']);
  assert.deepEqual(batches[1].changes[0].value, { 'temperatureSetting.mode': { text: 'heat' } });
  assert.equal(flow.client.resources.get('thermostat').value.googleHome !== undefined, true);
  assert.equal(JSON.stringify(batches).includes('private-local-token'), false);
  flow.graph.homes[0].devices.pop();
  flow.traits.pop();
  await flow.client.refresh();
  assert.deepEqual(batches[2].changes, [{ resourceId: 'lock', kind: 'DEVICE', remove: true, notify: true }]);
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

test('weather GET publishes normalized readings for its own home without changing devices', async (context) => {
  let batches = [];
  let flow = setup(context, { onData: (batch) => batches.push(batch) });
  flow.graph.homes[0].address = { coordinates: { latitude: 0, longitude: 0 } };
  await flow.client.connect();
  let transport = flow.transports[0];
  let reply = { weather: { temperatureC: { value: 0 }, description: 'Cloudy' }, airQuality: { index: 0, description: 'Good' } };
  transport.command.mock.mockImplementation(async () => ({ status: 0, data: [reply] }));
  let before = batches.length;
  let resources = structuredClone(flow.client.resources);
  let expected = { current_temperature: 0, condition: 'Cloudy' };
  assert.deepEqual(await flow.client.get('home', 'location_weather'), expected);
  assert.deepEqual(transport.command.mock.calls.at(-1).arguments.slice(0, 4), [
    'google.internal.home.foyer.v1.',
    'StructuresService',
    'GetOutdoorWeatherInfo',
    { structureId: 'home', latitude: 0, longitude: 0 },
  ]);
  assert.equal(batches.length, before + 1);
  assert.deepEqual(flow.client.homes.get('home').weather, expected);
  assert.deepEqual(batches.at(-1).changes[0].value.home.weather, expected);
  assert.deepEqual(flow.client.resources, resources);
  assert.deepEqual(await flow.client.get('home', 'location_weather'), expected);
  assert.equal(batches.length, before + 1, 'Unchanged weather must not publish another delta');
});

test('weather GET skips unknown homes, invalid locations and unavailable credentials without network work', async (context) => {
  let flow = setup(context);
  assert.equal(await flow.client.get('home', 'location_weather'), undefined);
  assert.equal(flow.transports.length, 0);
  await flow.client.connect();
  let transport = flow.transports[0];
  let calls = transport.command.mock.callCount();
  for (let id of ['foreign-home', 'thermostat']) {
    assert.equal(await flow.client.get(id, 'location_weather'), undefined);
  }
  for (let coordinates of [
    undefined,
    {},
    { latitude: '1', longitude: 2 },
    { latitude: 1, longitude: NaN },
    { latitude: 91, longitude: 2 },
    { latitude: 1, longitude: -181 },
  ]) {
    flow.client.homes.get('home').address = { coordinates };
    assert.equal(await flow.client.get('home', 'location_weather'), undefined);
  }
  flow.client.homes.get('home').address = { coordinates: { latitude: 1, longitude: 2 } };
  flow.session.account.authorised = false;
  assert.equal(await flow.client.get('home', 'location_weather'), undefined);
  assert.equal(transport.command.mock.callCount(), calls);
});

test('weather GET reports sanitized RPC failures', async (context) => {
  let flow = setup(context);
  flow.graph.homes[0].address = { coordinates: { latitude: 1, longitude: 2 } };
  await flow.client.connect();
  flow.transports[0].command.mock.mockImplementation(async () => ({ status: 7, message: 'Bearer fixture-secret', data: [] }));
  await assert.rejects(flow.client.get('home', 'location_weather'), {
    message: 'HomeGraph GetOutdoorWeatherInfo request failed',
    status: 7,
  });
});

for (let retired of ['removed', 'moved', 'token', 'connection']) {
  test('weather GET discards a reply after its target is retired: ' + retired, async (context) => {
    let flow = setup(context);
    flow.graph.homes[0].address = { coordinates: { latitude: 1, longitude: 2 } };
    await flow.client.connect();
    let reply = Promise.withResolvers();
    flow.transports[0].command.mock.mockImplementation(() => reply.promise);
    let pending = flow.client.get('home', 'location_weather');
    if (retired === 'removed') {
      flow.client.homes.delete('home');
    } else if (retired === 'moved') {
      flow.client.homes.get('home').address.coordinates.latitude = 3;
    } else if (retired === 'token') {
      flow.session.account.cameraAuth.oauth2 = 'replacement-fixture';
    } else {
      flow.client.disconnect();
    }
    reply.resolve({ status: 0, data: [{ weather: { temperatureC: { value: 25 } } }] });
    assert.equal(await pending, undefined);
  });
}

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
    { bolt_lock: true },
    'UpdateTraits',
    {
      request: [
        {
          deviceId: { uuid: 'lock', internalId: { source: 'nest-home-assistant-prod' } },
          categories: [category('lockUnlock', { isLocked: { boolean: true } })],
        },
      ],
    },
  ],
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
    { deviceId: 'thermostat', mode: 'THERMOSTAT_MODE_HEAT', temperature: { value: 21 }, hvacActor: 'HVAC_ACTOR_IOS' },
  ],
  [
    'thermostat',
    { hvac_mode: 'range', target_temperature_low: 18, target_temperature_high: 25 },
    'UpdateTargetTemperatureRange',
    { deviceId: 'thermostat', tempLow: { value: 18 }, tempHigh: { value: 25 }, hvacActor: 'HVAC_ACTOR_IOS' },
  ],
  [
    'thermostat',
    { target_temperature_high: 24.5 },
    'UpdateTargetTemperature',
    { deviceId: 'thermostat', mode: 'THERMOSTAT_MODE_COOL', temperature: { value: 24.5 }, hvacActor: 'HVAC_ACTOR_IOS' },
  ],
  [
    'thermostat',
    { eco_mode: 'manual' },
    'UpdateThermostatMode',
    { deviceId: 'thermostat', mode: 'THERMOSTAT_MODE_ECO', hvacActor: 'HVAC_ACTOR_IOS' },
  ],
  [
    'thermostat',
    { eco_mode: 'off' },
    'UpdateThermostatMode',
    { deviceId: 'thermostat', mode: 'THERMOSTAT_MODE_COOL', hvacActor: 'HVAC_ACTOR_IOS' },
  ],
  ['thermostat', { eco_mode: 'off', hvac_mode: 'heat' }, 'UpdateThermostatMode', undefined],
  [
    'thermostat',
    { hot_water_boost_active: { state: true } },
    'UpdateHotWaterBoost',
    { deviceId: 'thermostat', duration: { seconds: 1800 } },
  ],
  [
    'thermostat',
    { hot_water_boost_active: { state: true, time: 1800 } },
    'UpdateHotWaterBoost',
    { deviceId: 'thermostat', duration: { seconds: 1800 } },
  ],
  [
    'thermostat',
    { hot_water_boost_active: { state: true, time: 3600 } },
    'UpdateHotWaterBoost',
    { deviceId: 'thermostat', duration: { seconds: 3600 } },
  ],
  [
    'thermostat',
    { hot_water_boost_active: { state: true, time: 7200 } },
    'UpdateHotWaterBoost',
    { deviceId: 'thermostat', duration: { seconds: 7200 } },
  ],
  [
    'thermostat',
    { hot_water_boost_active: { state: false, time: 3600 } },
    'UpdateHotWaterBoost',
    { deviceId: 'thermostat', duration: { seconds: 0 } },
  ],
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
    await flow.client.set(id, values);
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
  ['lock', { auto_relock_duration: 60 }],
  ['sensor', { bolt_lock: true }],
  ['thermostat', { active_sensor: false }],
  ['sensor', { active_sensor: 1 }],
  ['thermostat', { hvac_mode: 'invalid' }],
  ['thermostat', { hvac_mode: 'auto' }],
  ['sensor', { hvac_mode: 'heat' }],
  ['thermostat', { eco_mode: 'invalid' }],
  ['thermostat', { target_temperature: NaN }],
  ['thermostat', { target_temperature: 100 }],
  ['thermostat', { target_temperature_low: 20 }],
  ['sensor', { hot_water_boost_active: { state: true, time: 1800 } }],
  ['thermostat', { hot_water_boost_active: null }],
  ['thermostat', { hot_water_boost_active: true }],
  ['thermostat', { hot_water_boost_active: { state: 'on' } }],
  ['thermostat', { hot_water_boost_active: { state: true, time: -1 } }],
  ['thermostat', { hot_water_boost_active: { state: true, time: NaN } }],
  ['thermostat', { hot_water_boost_active: { state: true, time: 900 } }],
  ['thermostat', { hot_water_boost_active: { state: true, time: 7201 } }],
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

for (let reason of ['token', 'identity', 'throw']) {
  test('pending commands reject retired work: ' + reason, async (context) => {
    let flow = setup(context);
    await flow.client.connect();
    let reply = Promise.withResolvers();
    flow.transports[0].command = () => reply.promise;
    let pending = flow.client.set('sensor', { active_sensor: true });
    if (reason === 'token') {
      flow.session.account.cameraAuth.oauth2 = 'replacement-token';
    }
    if (reason === 'identity') {
      let replacement = structuredClone(flow.client.resources.get('thermostat'));
      replacement.device.id.thirdPartyId.id = 'replacement-provider';
      flow.client.resources.set('thermostat', replacement);
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

const snapshotJpeg = Buffer.from([255, 216, 255, 224, 0, 1, 255, 217]);
async function cameraSetup(
  context,
  { legacy = false, url = undefined, token = undefined, missing = false, type = 'CAMERA', registerPush = undefined } = {},
) {
  let flow = setup(context, { ...(token === undefined ? {} : { getAccessToken: token }), registerPush });
  let camera = device('camera', type);
  camera.otherIds = { otherThirdPartyId: [{ idType: 'PHX', id: 'DEVICE_CAMERA' }] };
  flow.graph.homes[0].devices.push(camera);
  flow.url =
    url ??
    (legacy === true
      ? 'https://nexusapi-us1.camera.home.nest.com/resources/DEVICE_CAMERA/live_image?thumbnail_id=fixture'
      : 'https://nest-camera-media.googleapis.com/download/thumbnails/activity-zone/prod/devices/DEVICE_CAMERA/id/fixture');
  flow.traits.push({
    uuid: { value: 'camera' },
    category:
      missing === true
        ? []
        : [
            category('cameraStream', {
              cameraStreamLiveViewImage: { properties: { properties: [{ name: 'imageUrl', value: { text: flow.url } }] } },
            }),
          ],
  });
  flow.fetch = context.mock.method(
    globalThis,
    'fetch',
    async () => new Response(snapshotJpeg, { headers: { 'content-type': 'image/jpeg' } }),
  );
  await flow.client.connect();
  await flushPush();
  flow.olive = { response: { token: 'private-olive-fixture', validity: { seconds: 3600 } } };
  flow.transports[0].command.mock.mockImplementation(async (_prefix, _service, method) =>
    method === 'UpdateTraits' ? { status: 12, data: [] } : { status: 0, data: [flow.olive] },
  );
  return flow;
}

test('HomeGraph camera_snapshot downloads the device image using its current OAuth without changing the cache', async (context) => {
  let flow = await cameraSetup(context);
  let callsBefore = flow.transports[0].command.mock.callCount();
  let before = structuredClone(flow.client.resources.get('camera'));
  assert.deepEqual(await flow.client.get('camera', 'camera_snapshot'), snapshotJpeg);
  let [url, options] = flow.fetch.mock.calls[0].arguments;
  assert.equal(url, flow.url);
  assert.equal(options.headers.Authorization, 'Bearer oauth-fixture');
  assert.equal(options.headers.Origin, 'https://home.google.com');
  assert.equal(options.redirect, 'error');
  assert.equal(options.signal.aborted, true);
  assert.deepEqual(flow.client.resources.get('camera'), before);
  assert.equal(flow.transports[0].command.mock.callCount(), callsBefore + 1);
});

for (let live of ['missing', 'empty', 'available']) {
  test('snapshot uses the supplied placeholder only without a live URL: ' + live, async (context) => {
    let flow = await cameraSetup(context);
    let traits = flow.client.resources.get('camera').value.traits[0].traits;
    if (live === 'missing') {
      traits.splice(0, 1);
    } else if (live === 'empty') {
      traits[0].value.properties.properties[0].value.text = '';
    }
    let placeholder = 'https://nest-camera-media.googleapis.com/download/thumbnails/placeholder/prod/devices/DEVICE_CAMERA';
    traits.push({
      name: 'cameraStreamPlaceholderImage',
      value: {
        properties: { properties: [{ name: 'imageUrl', value: { text: placeholder } }] },
      },
    });
    let before = structuredClone(flow.client.resources.get('camera'));
    assert.deepEqual(await flow.client.get('camera', 'camera_snapshot'), snapshotJpeg);
    assert.equal(flow.fetch.mock.calls[0].arguments[0], live === 'available' ? flow.url : placeholder);
    assert.equal(flow.fetch.mock.calls[0].arguments[1].headers.Authorization, 'Bearer oauth-fixture');
    assert.deepEqual(flow.client.resources.get('camera'), before);
  });
}

for (let placeholder of [
  'https://nest-camera-media.googleapis.com/download/thumbnails/placeholder/prod/devices/OTHER_CAMERA',
  'https://evil.invalid/download/thumbnails/placeholder/prod/devices/DEVICE_CAMERA',
  'https://nest-camera-media.googleapis.com/download/thumbnails/placeholder/prod/devices/DEVICE_CAMERA/extra',
]) {
  test('snapshot fallback preserves host and device checks: ' + placeholder, async (context) => {
    let flow = await cameraSetup(context, { missing: true });
    flow.client.resources.get('camera').value.traits.push(
      category('cameraStream', {
        cameraStreamPlaceholderImage: { properties: { properties: [{ name: 'imageUrl', value: { text: placeholder } }] } },
      }),
    );
    await assert.rejects(flow.client.get('camera', 'camera_snapshot'), /HomeGraph camera snapshot request failed/);
    assert.equal(flow.fetch.mock.callCount(), 0);
  });
}

test('legacy snapshot requests use cached Foyer Olive credentials and renew expired credentials', async (context) => {
  let flow = await cameraSetup(context, { legacy: true });
  let callsBefore = flow.transports[0].command.mock.callCount();
  assert.deepEqual(await flow.client.get('camera', 'camera_snapshot'), snapshotJpeg);
  assert.deepEqual(await flow.client.get('camera', 'camera_snapshot'), snapshotJpeg);
  assert.equal(flow.transports[0].command.mock.calls.filter((call) => call.arguments[2] === 'GetOliveToken').length, 1);
  let rpc = flow.transports[0].command.mock.calls[callsBefore + 1].arguments;
  assert.equal(rpc[1], 'ClientOliveTokenService');
  assert.equal(rpc[2], 'GetOliveToken');
  assert.equal(flow.fetch.mock.calls[0].arguments[1].headers.Authorization, 'Basic private-olive-fixture');
  // Replacing OAuth retires the cached secondary credential even within the same connection.
  flow.session.account.cameraAuth.oauth2 = 'new-oauth';
  flow.olive.response.validity.seconds = 1;
  await flow.client.get('camera', 'camera_snapshot');
  await flow.client.get('camera', 'camera_snapshot');
  assert.equal(flow.transports[0].command.mock.calls.filter((call) => call.arguments[2] === 'GetOliveToken').length, 3);
});

for (let url of [
  'http://nest-camera-media.googleapis.com/download/thumbnails/activity-zone/prod/devices/DEVICE_CAMERA/id/x',
  'https://nest-camera-media.googleapis.com.evil.invalid/download/thumbnails/activity-zone/prod/devices/DEVICE_CAMERA/id/x',
  'https://nest-camera-media.googleapis.com:444/download/thumbnails/activity-zone/prod/devices/DEVICE_CAMERA/id/x',
  'https://secret@nest-camera-media.googleapis.com/download/thumbnails/activity-zone/prod/devices/DEVICE_CAMERA/id/x',
  'https://nest-camera-media.googleapis.com/download/thumbnails/activity-zone/prod/devices/OTHER_CAMERA/id/x',
  'https://nest-camera-media.googleapis.com/download/thumbnails/activity-zone/prod/devices/DEVICE_CAMERA/id/x#secret',
  'https://nexusapi-us1.camera.home.nest.com/resources/OTHER_CAMERA/live_image',
  'https://nest-camera-media.googleapis.com/unsupported',
  'not-a-url',
]) {
  test('snapshot rejects untrusted host, path or identity: ' + url.replace('secret', 'fixture'), async (context) => {
    let flow = await cameraSetup(context, { url });
    await assert.rejects(flow.client.get('camera', 'camera_snapshot'), /^Error: HomeGraph camera snapshot request failed$/);
    assert.equal(flow.fetch.mock.callCount(), 0);
  });
}

for (let options of [{ missing: true }, { type: 'THERMOSTAT' }, { type: 'DOORBELL', missing: true }]) {
  test('missing or unsupported snapshots return undefined: ' + JSON.stringify(options), async (context) => {
    let flow = await cameraSetup(context, options);
    assert.equal(await flow.client.get('camera', 'camera_snapshot'), undefined);
    assert.equal(flow.fetch.mock.callCount(), 0);
  });
}

test('third-party cameras cannot use this account OAuth snapshot route', async (context) => {
  let flow = await cameraSetup(context);
  flow.client.resources.get('camera').value.googleHome.id.thirdPartyId.idType = 'other-provider';
  assert.equal(await flow.client.get('camera', 'camera_snapshot'), undefined);
  assert.equal(flow.fetch.mock.callCount(), 0);
});

for (let body of [Buffer.alloc(0), Buffer.from('<html>private</html>')]) {
  test('snapshot rejects empty or non-JPEG image bodies: bytes=' + body.length, async (context) => {
    let flow = await cameraSetup(context);
    flow.fetch.mock.mockImplementation(async () => new Response(body));
    assert.equal(await flow.client.get('camera', 'camera_snapshot'), undefined);
  });
}

for (let declared of [true, false]) {
  test('snapshot download bounds both advertised and streamed body size: declared=' + declared, async (context) => {
    let flow = await cameraSetup(context);
    flow.fetch.mock.mockImplementation(
      async () =>
        new Response(declared === true ? snapshotJpeg : Buffer.alloc(8 * 1024 * 1024 + 1), {
          headers: declared === true ? { 'content-length': String(8 * 1024 * 1024 + 1) } : {},
        }),
    );
    await assert.rejects(flow.client.get('camera', 'camera_snapshot'), /HomeGraph camera snapshot request failed/);
  });
}

for (let value of [
  {},
  { response: { token: '', validity: { seconds: 3600 } } },
  { response: { token: 'secret', validity: { seconds: 0 } } },
]) {
  test('legacy image credentials must be usable and remain private: ' + JSON.stringify(value), async (context) => {
    let flow = await cameraSetup(context, { legacy: true });
    flow.olive = value;
    await assert.rejects(flow.client.get('camera', 'camera_snapshot'), /^Error: HomeGraph camera snapshot request failed$/);
    assert.equal(flow.fetch.mock.callCount(), 0);
  });
}

test('snapshot failures redact HTTP response details and image URLs', async (context) => {
  let flow = await cameraSetup(context);
  flow.fetch.mock.mockImplementation(async () => {
    throw new Error('private-url?token=private-oauth');
  });
  await assert.rejects(flow.client.get('camera', 'camera_snapshot'), /^Error: HomeGraph camera snapshot request failed$/);
});

for (let reason of ['disconnect', 'timeout']) {
  test('pending image requests are cancelled on ' + reason, async (context) => {
    let flow = await cameraSetup(context);
    let signal;
    flow.fetch.mock.mockImplementation((_url, options) => {
      signal = options.signal;
      return new Promise(() => {});
    });
    let pending = flow.client.get('camera', 'camera_snapshot');
    let rejected = assert.rejects(pending, /HomeGraph camera snapshot request failed/);
    await setImmediate();
    if (reason === 'disconnect') {
      flow.client.disconnect();
    } else {
      context.mock.timers.tick(7000);
    }
    await rejected;
    assert.equal(signal.aborted, true);
  });
}

for (let reason of ['oauth', 'removed', 'alias', 'connection']) {
  test('late image replies cannot affect a replaced account/device: ' + reason, async (context) => {
    let flow = await cameraSetup(context);
    let finish;
    flow.fetch.mock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let pending = flow.client.get('camera', 'camera_snapshot');
    await setImmediate();
    if (reason === 'oauth') {
      flow.session.account.cameraAuth.oauth2 = 'replacement';
    }
    if (reason === 'removed') {
      flow.client.resources.delete('camera');
    }
    if (reason === 'alias') {
      flow.client.resources.get('camera').value.googleHome.otherIds = undefined;
    }
    if (reason === 'connection') {
      flow.client.disconnect();
    }
    let rejected = reason === 'connection' ? assert.rejects(pending, /snapshot request failed/) : undefined;
    finish(new Response(snapshotJpeg));
    if (rejected !== undefined) {
      await rejected;
    } else {
      assert.equal(await pending, undefined);
    }
  });
}

test('retired Olive replies do not start image downloads or cache credentials', async (context) => {
  let flow = await cameraSetup(context, { legacy: true });
  let finish;
  flow.transports[0].command.mock.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  let pending = flow.client.get('camera', 'camera_snapshot');
  await setImmediate();
  flow.session.account.cameraAuth.oauth2 = 'replacement';
  finish({ status: 0, data: [flow.olive] });
  assert.equal(await pending, undefined);
  assert.equal(flow.fetch.mock.callCount(), 0);
});

const pushRegistration = async () => ({ uuid: 'account', androidId: '123', securityToken: '456' });
const pushed = (id, name, values) => ({ uuid: { value: id }, category: [category(name, values)] });
const traitValue = (client, id, name, key) =>
  client.resources
    .get(id)
    .traits.find((item) => item.name === name)
    ?.traits.find((item) => item.name === key)?.value;
const flushPush = async () => {
  for (let index = 0; index < 8; index++) {
    await setImmediate();
  }
};

function captureCategory(url, timestamp) {
  return category('cameraStream', {
    cameraStreamLiveViewImage: {
      properties: {
        properties: [
          { name: 'imageUrl', value: { text: url } },
          { name: 'timestampSeconds', value: { number: timestamp } },
        ],
      },
    },
  });
}

for (let overlapping of [false, true]) {
  test('snapshot accepts fresh push before the capture command completes; overlapping=' + overlapping, async (context) => {
    let flow = await cameraSetup(context, { registerPush: pushRegistration });
    let captureReply;
    flow.transports[0].command.mock.mockImplementation(async (_prefix, _service, method, values) => {
      assert.equal(method, 'UpdateTraits');
      assert.deepEqual(values.request[0].deviceId, { uuid: 'camera', internalId: { source: 'nest-home-assistant-prod' } });
      assert.deepEqual(values.request[0].categories[0].traits, [{ name: 'cameraStreamLiveViewImage', value: { boolean: true } }]);
      return new Promise((resolve) => {
        captureReply = resolve;
      });
    });
    let pending = flow.client.get('camera', 'camera_snapshot');
    await flushPush();
    let firstReply = captureReply;
    let second = overlapping === true ? flow.client.get('camera', 'camera_snapshot') : undefined;
    await flushPush();
    let url = flow.url.replace('/fixture', '/fresh');
    await flow.pushes[0].options.onData({ uuid: { value: 'camera' }, category: [captureCategory(url, 100)] }, () => true);
    firstReply({ status: 0, data: [{}] });
    if (overlapping === true) {
      captureReply({ status: 0, data: [{}] });
    }
    assert.deepEqual(await pending, snapshotJpeg);
    if (second !== undefined) {
      assert.deepEqual(await second, snapshotJpeg);
    }
    assert.equal(
      flow.fetch.mock.calls.every((call) => call.arguments[0] === url),
      true,
    );
  });
}

for (let matching of [true, false]) {
  test('snapshot uses a targeted trait read when capture push is absent; matching device=' + matching, async (context) => {
    let flow = await cameraSetup(context);
    let url = flow.url.replace('/fixture', '/captured');
    let before = structuredClone(flow.client.resources.get('camera'));
    flow.transports[0].command.mock.mockImplementation(async (_prefix, _service, method, values) => {
      if (method === 'UpdateTraits') {
        return { status: 0, data: [{}] };
      }
      assert.equal(method, 'GetTraits');
      assert.deepEqual(values.deviceIds, [{ uuid: 'camera' }]);
      return {
        status: 0,
        data: [{ device: [{ uuid: { value: matching === true ? 'camera' : 'other' }, category: [captureCategory(url, 100)] }] }],
      };
    });
    let pending = flow.client.get('camera', 'camera_snapshot');
    await flushPush();
    context.mock.timers.tick(2000);
    assert.deepEqual(await pending, snapshotJpeg);
    assert.equal(flow.fetch.mock.calls[0].arguments[0], matching === true ? url : flow.url);
    assert.deepEqual(flow.client.resources.get('camera'), before, 'request-local read does not bypass ingestion');
  });
}

test('disconnect retires a snapshot waiting for the capture push without downloading', async (context) => {
  let flow = await cameraSetup(context);
  flow.transports[0].command.mock.mockImplementation(async () => ({ status: 0, data: [{}] }));
  let pending = flow.client.get('camera', 'camera_snapshot');
  let rejected = assert.rejects(pending, /snapshot request failed/);
  await flushPush();
  flow.client.disconnect();
  await rejected;
  await flushPush();
  assert.equal(flow.fetch.mock.callCount(), 0);
});

test('HomeGraph starts push after discovery and uses the same account transport and source pipeline', async (context) => {
  let batches = [];
  let flow = setup(context, { registerPush: pushRegistration, onData: (batch) => batches.push(batch) });
  await flow.client.connect();
  let push = flow.pushes[0];
  assert.equal(flow.pushes.length, 1);
  assert.deepEqual(push.ids, ['thermostat', 'sensor', 'lock']);
  assert.equal(push.options.transport, flow.transports[0]);
  assert.deepEqual(await push.options.register(new AbortController().signal), await pushRegistration());
  await push.options.onData(pushed('thermostat', 'temperatureSetting', { mode: { text: 'heat' } }), () => true);
  assert.equal(traitValue(flow.client, 'thermostat', 'temperatureSetting', 'mode').text, 'heat');
  assert.equal(traitValue(flow.client, 'thermostat', 'temperatureSetting', 'thermostatTemperatureSetpointHighC').number, 24);
  assert.deepEqual([...batches[1].changes[0].fields], ['temperatureSetting.mode']);
  assert.equal(batches[1].changes[0].resourceId, 'thermostat');
  assert.equal(batches[1].source, DATA_SOURCE.HOMEGRAPH);
  let count = batches.length;
  await push.options.onData(pushed('thermostat', 'temperatureSetting', { mode: { text: 'heat' } }), () => true);
  assert.equal(batches.length, count);
  assert.equal(flow.client.resources.get('thermostat').traits[0].attributes.properties[0].name, 'availableThermostatModes');
  assert.equal(JSON.stringify(batches).includes('securityToken'), false);
});

test('production Google Home accounts start their own receiver without registration callbacks', async (context) => {
  let flow = setup(context, { storagePath: '/fixture/private-storage' });
  flow.session.account.type = ACCOUNT_TYPE.GOOGLE_HOME;
  await flow.client.connect();
  assert.equal(flow.pushes.length, 1);
  assert.equal(flow.pushes[0].options.register, undefined);
  assert.equal(flow.pushes[0].options.account, flow.session.account);
  assert.equal(flow.pushes[0].options.storagePath, '/fixture/private-storage');
  assert.equal(flow.pushes[0].options.transport, flow.transports[0]);
});

test('partial push adds categories and replaces complete trait values without deleting omitted fields', async (context) => {
  let flow = setup(context, { registerPush: pushRegistration });
  await flow.client.connect();
  let push = flow.pushes[0];
  await Promise.all([
    push.options.onData(pushed('sensor', 'temperatureSetting', { ambientAirTemperatureC: { number: 22.5 } }), () => true),
    push.options.onData(
      pushed('thermostat', 'temperatureSetting', { activeThermostatTemperatureSensors: { array: { values: [{ text: 'replacement' }] } } }),
      () => true,
    ),
    push.options.onData(pushed('thermostat', 'temperatureSetting', { optional: { nullValue: 0 } }), () => true),
  ]);
  assert.equal(traitValue(flow.client, 'sensor', 'temperatureSetting', 'ambientAirTemperatureC').number, 22.5);
  assert.equal(traitValue(flow.client, 'thermostat', 'temperatureSetting', 'mode').text, 'cool');
  assert.equal(traitValue(flow.client, 'thermostat', 'temperatureSetting', 'optional').nullValue, 0);
  assert.deepEqual(traitValue(flow.client, 'thermostat', 'temperatureSetting', 'activeThermostatTemperatureSensors').array.values, [
    { text: 'replacement' },
  ]);
  assert.equal(await push.options.onData(pushed('foreign', 'temperatureSetting', { mode: { text: 'heat' } }), () => true), true);
  assert.equal(flow.client.resources.has('foreign'), false);
});

test('push commits during an in-flight poll and its deltas survive reconciliation', async (context) => {
  let flow = setup(context, { registerPush: pushRegistration });
  await flow.client.connect();
  let finish;
  let entered = Promise.withResolvers();
  flow.traits[0].category.push(category('newPollCategory', { value: { boolean: true } }));
  flow.transports[0].command.mock.mockImplementation(async (_p, _s, method) => {
    if (method === 'GetTraits') {
      entered.resolve();
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    return { status: 0, data: [flow.graph] };
  });
  let read = flow.client.refresh();
  await entered.promise;
  await flow.pushes[0].options.onData(pushed('thermostat', 'temperatureSetting', { mode: { text: 'heat' } }), () => true);
  await flow.pushes[0].options.onData(pushed('sensor', 'temperatureSetting', { ambientAirTemperatureC: { number: 21 } }), () => true);
  assert.equal(traitValue(flow.client, 'thermostat', 'temperatureSetting', 'mode').text, 'heat');
  finish({ status: 0, data: [{ device: flow.traits }] });
  await read;
  assert.equal(traitValue(flow.client, 'thermostat', 'temperatureSetting', 'mode').text, 'heat');
  assert.equal(traitValue(flow.client, 'thermostat', 'newPollCategory', 'value').boolean, true);
  assert.equal(traitValue(flow.client, 'sensor', 'temperatureSetting', 'ambientAirTemperatureC').number, 21);
});

for (let refusal of ['false', 'reject']) {
  test('rejected push commits retain cache and do not block later delivery: ' + refusal, async (context) => {
    let fail = false;
    let flow = setup(context, {
      registerPush: pushRegistration,
      onData: () => {
        if (fail === true) {
          if (refusal === 'reject') {
            throw new Error('private');
          }
          return false;
        }
      },
    });
    await flow.client.connect();
    fail = true;
    await assert.rejects(flow.pushes[0].options.onData(pushed('thermostat', 'temperatureSetting', { mode: { text: 'heat' } }), () => true));
    assert.equal(traitValue(flow.client, 'thermostat', 'temperatureSetting', 'mode').text, 'cool');
    fail = false;
    await flow.pushes[0].options.onData(pushed('thermostat', 'temperatureSetting', { mode: { text: 'heat' } }), () => true);
    assert.equal(traitValue(flow.client, 'thermostat', 'temperatureSetting', 'mode').text, 'heat');
  });
}

test('retiring push during a pending consumer prevents a late cache commit', async (context) => {
  let finish;
  let entered = Promise.withResolvers();
  let batches = [];
  let flow = setup(context, {
    registerPush: pushRegistration,
    onData: (batch) => {
      batches.push(batch);
      if (batches.length === 2) {
        entered.resolve();
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
    },
  });
  await flow.client.connect();
  let push = flow.pushes[0];
  let pending = push.options.onData(pushed('thermostat', 'temperatureSetting', { mode: { text: 'heat' } }), () => true);
  await entered.promise;
  flow.client.disconnect();
  finish(true);
  assert.equal(await pending, false);
  assert.equal(batches[1].isCurrent(), false);
  assert.equal(traitValue(flow.client, 'thermostat', 'temperatureSetting', 'mode').text, 'cool');
  assert.equal(push.disconnect.mock.callCount(), 1);
});

test('healthy push slows reconciliation to 30s; receiver failure restores 2s polling', async (context) => {
  let flow = setup(context, { poll: true, registerPush: pushRegistration });
  await flow.client.connect();
  let push = flow.pushes[0];
  let transport = flow.transports[0];
  context.mock.timers.tick(29999);
  await flushPush();
  assert.equal(transport.command.mock.callCount(), 2);
  context.mock.timers.tick(1);
  await flushPush();
  assert.equal(transport.command.mock.callCount(), 4);
  assert.equal(flow.pushes.length, 1);
  push.options.onStatus(false);
  context.mock.timers.tick(2000);
  await flushPush();
  assert.equal(transport.command.mock.callCount(), 6);
  assert.equal(flow.pushes.length, 1, 'MCS owns established reconnects');
  push.options.onStatus(true);
  context.mock.timers.tick(2000);
  await flushPush();
  assert.equal(transport.command.mock.callCount(), 6);
  flow.client.disconnect();
  let calls = transport.command.mock.callCount();
  push.options.onStatus(false);
  push.options.onRefresh(() => true);
  context.mock.timers.tick(60000);
  await flushPush();
  assert.equal(transport.command.mock.callCount(), calls);
});

test('push reconfigures for discovery and rejects callbacks from removed subscriptions', async (context) => {
  let flow = setup(context, { registerPush: pushRegistration });
  await flow.client.connect();
  let old = flow.pushes[0];
  flow.graph.homes[0].devices = [device('sensor', 'SENSOR')];
  flow.traits = [flow.traits[1]];
  await flow.client.refresh();
  assert.equal(flow.pushes.length, 2);
  assert.equal(old.disconnect.mock.callCount(), 1);
  assert.deepEqual(flow.pushes[1].ids, ['sensor']);
  assert.equal(await old.options.onData(pushed('thermostat', 'temperatureSetting', { mode: { text: 'heat' } }), () => true), false);
  assert.equal(flow.client.resources.has('thermostat'), false);
  flow.graph.homes[0].devices = [];
  flow.traits = [];
  await flow.client.refresh();
  assert.equal(flow.pushes[1].disconnect.mock.callCount(), 1);
  assert.equal(flow.pushes.length, 2);
});

test('token replacement retires the old push source and registers the current account', async (context) => {
  let flow = setup(context, { registerPush: pushRegistration });
  await flow.client.connect();
  let old = flow.pushes[0];
  flow.session.account.cameraAuth.oauth2 = 'replacement';
  assert.equal(await old.options.onData(pushed('thermostat', 'temperatureSetting', { mode: { text: 'heat' } }), () => true), false);
  await flow.client.refresh();
  assert.equal(flow.pushes.length, 2);
  assert.equal(old.disconnect.mock.callCount(), 1);
});

test('initial push failure preserves polling without creating a second retry owner', async (context) => {
  let logs = [];
  let flow = setup(context, { poll: true, registerPush: pushRegistration, log: { debug: (text) => logs.push(text) } });
  let create = pushRuntime.create;
  pushRuntime.create = (options) => {
    let push = create(options);
    if (flow.pushes.length === 1) {
      push.connect.mock.mockImplementation(async () => {
        options.onStatus(false);
        throw new Error('PRIVATE-CREDENTIAL');
      });
    }
    return push;
  };
  assert.equal(await flow.client.connect(), true);
  assert.equal(flow.client.resources.size, 3);
  context.mock.timers.tick(2000);
  await flushPush();
  assert.equal(flow.pushes.length, 1, 'fallback reads must not retry registration early');
  context.mock.timers.tick(3000);
  await flushPush();
  assert.equal(flow.pushes.length, 1, 'the receiver owns registration retries');
  assert.equal(flow.pushes[0].connect.mock.callCount(), 1);
  assert.match(logs.join('\n'), /polling retained/);
  assert.doesNotMatch(logs.join('\n'), /PRIVATE-CREDENTIAL/);
});

test('invalidation coalesces with an in-flight refresh and failure remains diagnostic only', async (context) => {
  let logs = [];
  let flow = setup(context, { registerPush: pushRegistration, log: { debug: (text) => logs.push(text) } });
  await flow.client.connect();
  let push = flow.pushes[0];
  let read = context.mock.method(flow.client, 'refresh', async () => {
    throw new Error('PRIVATE');
  });
  push.options.onRefresh(() => false);
  assert.equal(read.mock.callCount(), 0);
  push.options.onRefresh(() => true);
  await flushPush();
  assert.equal(read.mock.callCount(), 1);
  assert.equal(
    logs.some((text) => /push reconciliation failed/.test(text)),
    true,
  );
  assert.doesNotMatch(JSON.stringify(logs), /PRIVATE/);
});

for (let categories of [
  undefined,
  {},
  Array(129).fill({}),
  [{ name: '' }],
  [{ name: 'x', traits: {} }],
  [{ name: 'x', traits: [{ name: '' }] }],
  [{ name: 'x', traits: [{ name: 'x' }] }],
]) {
  test('malformed push state cannot change the cache: ' + JSON.stringify(categories)?.slice(0, 50), async (context) => {
    let flow = setup(context, { registerPush: pushRegistration });
    await flow.client.connect();
    let before = structuredClone(flow.client.resources.get('sensor'));
    await assert.rejects(flow.pushes[0].options.onData({ uuid: { value: 'sensor' }, category: categories }, () => true));
    assert.deepEqual(flow.client.resources.get('sensor'), before);
  });
}

test('merged category and trait limits remain bounded across partial pushes', async (context) => {
  let flow = setup(context, { registerPush: pushRegistration });
  await flow.client.connect();
  let push = flow.pushes[0];
  let resource = flow.client.resources.get('sensor');
  resource.traits = Array.from({ length: 128 }, (_, index) => ({ name: 'category' + index, traits: [] }));
  resource.value.traits = resource.traits;
  await assert.rejects(
    push.options.onData(pushed('sensor', 'extra', {}), () => true),
    /category limit/,
  );
  resource.traits = [
    { name: 'x', traits: Array.from({ length: 1024 }, (_, index) => ({ name: 'trait' + index, value: { number: index } })) },
  ];
  resource.value.traits = resource.traits;
  await assert.rejects(
    push.options.onData(pushed('sensor', 'x', { extra: { boolean: true } }), () => true),
    /trait limit/,
  );
});

test('replayed older camera image references cannot replace the current snapshot URL', async (context) => {
  let flow = await cameraSetup(context, { registerPush: pushRegistration });
  let resource = flow.client.resources.get('camera');
  resource.traits[0].traits[0].value.properties.properties.push({ name: 'timestampSeconds', value: { number: 100 } });
  let image = (seconds, url) =>
    pushed('camera', 'cameraStream', {
      cameraStreamLiveViewImage: {
        properties: {
          properties: [
            { name: 'imageUrl', value: { text: url } },
            { name: 'timestampSeconds', value: { number: seconds } },
          ],
        },
      },
    });
  await flow.pushes[0].options.onData(image(90, 'https://old.invalid'), () => true);
  let current = traitValue(flow.client, 'camera', 'cameraStream', 'cameraStreamLiveViewImage');
  assert.equal(current.properties.properties[0].value.text, flow.url);
  await flow.pushes[0].options.onData(image(110, 'https://new.invalid'), () => true);
  current = traitValue(flow.client, 'camera', 'cameraStream', 'cameraStreamLiveViewImage');
  assert.equal(current.properties.properties[0].value.text, 'https://new.invalid');
});

test('pending push startup coalesces across refreshes and cannot survive disconnect', async (context) => {
  let flow = setup(context, { registerPush: pushRegistration });
  let finish;
  let create = pushRuntime.create;
  pushRuntime.create = (options) => {
    let push = create(options);
    push.connect.mock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    return push;
  };
  let start = flow.client.connect();
  await flushPush();
  let refresh = flow.client.refresh();
  await flushPush();
  assert.equal(flow.pushes.length, 1);
  flow.client.disconnect();
  finish();
  assert.equal(await start, false);
  await refresh;
  assert.equal(flow.pushes[0].disconnect.mock.callCount(), 1);
});

test('a queued commit recovers when the preceding consumer rejects', async (context) => {
  let entered = Promise.withResolvers();
  let finish;
  let calls = 0;
  let flow = setup(context, {
    registerPush: pushRegistration,
    onData: async () => {
      if (++calls === 2) {
        entered.resolve();
        await new Promise((resolve) => {
          finish = resolve;
        });
        throw new Error('consumer refused');
      }
    },
  });
  await flow.client.connect();
  let push = flow.pushes[0];
  let first = push.options.onData(pushed('thermostat', 'temperatureSetting', { mode: { text: 'heat' } }), () => true);
  let rejected = assert.rejects(first, /consumer refused/);
  await entered.promise;
  let second = push.options.onData(pushed('sensor', 'temperatureSetting', { ambientAirTemperatureC: { number: 21 } }), () => true);
  finish();
  await rejected;
  assert.equal(await second, true);
  assert.equal(traitValue(flow.client, 'thermostat', 'temperatureSetting', 'mode').text, 'cool');
  assert.equal(traitValue(flow.client, 'sensor', 'temperatureSetting', 'ambientAirTemperatureC').number, 21);
});

test('full polling reads produce named trait deltas and ignore array reordering', async (context) => {
  let batches = [];
  let flow = setup(context, { onData: (batch) => batches.push(batch) });
  await flow.client.connect();
  let first = batches[0].changes.find((change) => change.resourceId === 'thermostat');
  assert.deepEqual(first.value['temperatureSetting.mode'], { text: 'cool' });
  assert.deepEqual(first.value['fanSettings.fanTimerEndTimestampSec'], { number: 0 });
  assert.equal(first.value['attributes.temperatureSetting.availableThermostatModes'] !== undefined, true);
  flow.traits[0].category[0].traits[0].value = { text: 'heat' };
  await flow.client.refresh();
  let delta = batches[1].changes[0];
  assert.deepEqual([...delta.fields], ['temperatureSetting.mode']);
  assert.deepEqual(delta.value, { 'temperatureSetting.mode': { text: 'heat' } });
  assert.equal(flow.client.resources.get('thermostat').traits.length, 2);
  assert.equal(traitValue(flow.client, 'thermostat', 'temperatureSetting', 'thermostatTemperatureSetpointHighC').number, 24);
  flow.traits[0].category.reverse();
  flow.traits[0].category.forEach((entry) => entry.traits.reverse());
  await flow.client.refresh();
  assert.equal(batches.length, 2);
  // Removed buckets are explicitly cleared once; unchanged siblings are omitted.
  flow.traits[0].category = [category('fanSettings', { fanTimerEndTimestampSec: { number: 0 } })];
  await flow.client.refresh();
  let removed = batches[2].changes[0];
  assert.equal(removed.fields.has('temperatureSetting.mode'), true);
  assert.equal(Object.hasOwn(removed.value, 'temperatureSetting.mode'), true);
  assert.equal(removed.value['temperatureSetting.mode'], undefined);
  assert.equal(removed.fields.has('fanSettings.fanTimerEndTimestampSec'), false);
  await flow.client.refresh();
  assert.equal(batches.length, 3);
});

test('rejected polling deltas are retried against the last accepted trait state', async (context) => {
  let batches = [];
  let reject = false;
  let flow = setup(context, {
    onData: (batch) => {
      batches.push(batch);
      return reject === false;
    },
  });
  await flow.client.connect();
  flow.traits[0].category[0].traits[0].value = { text: 'off' };
  reject = true;
  await assert.rejects(flow.client.refresh());
  assert.equal(traitValue(flow.client, 'thermostat', 'temperatureSetting', 'mode').text, 'cool');
  reject = false;
  await flow.client.refresh();
  assert.deepEqual(batches[2].changes[0].value, batches[1].changes[0].value);
  assert.equal(traitValue(flow.client, 'thermostat', 'temperatureSetting', 'mode').text, 'off');
});

test('HomeGraph attributes are independent buckets and property order does not produce deltas', async (context) => {
  let batches = [];
  let flow = setup(context, { onData: (batch) => batches.push(batch) });
  let properties = flow.traits[0].category[0].attributes.properties;
  properties.push({ name: 'supported', value: { boolean: true } }, { name: 'level', value: { number: 3 } });
  await flow.client.connect();
  let initial = batches[0].changes.find((change) => change.resourceId === 'thermostat');
  assert.deepEqual(initial.value['attributes.temperatureSetting.supported'], { boolean: true });
  assert.deepEqual(initial.value['attributes.temperatureSetting.level'], { number: 3 });
  assert.equal(Object.hasOwn(initial.value, 'attributes.temperatureSetting'), false);
  properties.reverse();
  await flow.client.refresh();
  assert.equal(batches.length, 1);
  properties.find((property) => property.name === 'level').value.number = 4;
  await flow.client.refresh();
  assert.deepEqual(batches[1].changes[0].value, { 'attributes.temperatureSetting.level': { number: 4 } });
  assert.deepEqual([...batches[1].changes[0].fields], ['attributes.temperatureSetting.level']);
  assert.equal(flow.client.resources.get('thermostat').traits[0].attributes.properties.length, 3);
  properties.splice(
    properties.findIndex((property) => property.name === 'level'),
    1,
  );
  await flow.client.refresh();
  assert.equal(Object.hasOwn(batches[2].changes[0].value, 'attributes.temperatureSetting.level'), true);
  assert.equal(batches[2].changes[0].value['attributes.temperatureSetting.level'], undefined);
});

for (let [id, values] of [
  ['thermostat', { hvac_mode: 'heat' }],
  ['sensor', { active_sensor: true }],
  ['lock', { bolt_lock: false }],
]) {
  test('unchanged polling preserves a pending command and its routing records: ' + id, async (context) => {
    let batches = [];
    let flow = setup(context, { onData: (batch) => batches.push(batch) });
    await flow.client.connect();
    let transport = flow.transports[0];
    let original = transport.command;
    let reply = Promise.withResolvers();
    transport.command = (...args) => (['GetHomeGraph', 'GetTraits'].includes(args[2]) === true ? original(...args) : reply.promise);
    let before = new Map(flow.client.resources);
    let pending = flow.client.set(id, values);
    await flow.client.refresh();
    assert.equal(batches.length, 1);
    for (let [uuid, resource] of before) {
      assert.equal(flow.client.resources.get(uuid), resource);
    }
    reply.resolve({ status: 0, data: [{}] });
    await pending;
  });
}

test('polling still invalidates a command when its provider identity changes', async (context) => {
  let flow = setup(context);
  await flow.client.connect();
  let transport = flow.transports[0];
  let original = transport.command;
  let reply = Promise.withResolvers();
  transport.command = (...args) => (['GetHomeGraph', 'GetTraits'].includes(args[2]) === true ? original(...args) : reply.promise);
  let pending = flow.client.set('thermostat', { hvac_mode: 'heat' });
  let rejected = assert.rejects(pending, AggregateError);
  flow.graph.homes[0].devices[0].id.thirdPartyId.id = 'replacement-provider-device';
  await flow.client.refresh();
  reply.resolve({ status: 0, data: [{}] });
  await rejected;
});

test('push compares only its device and retains untouched categories without mutating accepted state', async (context) => {
  let flow = setup(context, { registerPush: pushRegistration });
  await flow.client.connect();
  let before = flow.client.resources.get('thermostat');
  let original = structuredClone(before);
  let unrelated = flow.client.resources.get('lock');
  let unrelatedValue = unrelated.value;
  let reads = 0;
  Object.defineProperty(unrelated, 'value', {
    get() {
      reads++;
      return unrelatedValue;
    },
    configurable: true,
  });
  let state = pushed('thermostat', 'temperatureSetting', { mode: { text: 'heat' } });
  await flow.pushes[0].options.onData(state, () => true);
  assert.equal(reads, 0, 'a thermostat push must not flatten or compare lock buckets');
  let after = flow.client.resources.get('thermostat');
  assert.notEqual(after.traits[0], before.traits[0]);
  assert.equal(after.traits[1], before.traits[1], 'untouched fan category is retained');
  assert.equal(after.traits[0].traits[1], before.traits[0].traits[1], 'untouched setpoint is retained');
  assert.deepEqual(before, original, 'the previously accepted resource was not mutated');
  state.category[0].traits[0].value.text = 'off';
  assert.equal(traitValue(flow.client, 'thermostat', 'temperatureSetting', 'mode').text, 'heat');
});

test('HomeGraph home notifications resolve configured home identity through the shared System contract', async (context) => {
  let batches = [];
  let flow = setup(context, { onData: (batch) => batches.push(batch) });
  flow.graph.homes[0].traits = [
    { name: 'home.platform.traits.AreaPresenceStateTrait', fields: { presenceState: { stringValue: 'PRESENCE_STATE_OCCUPIED' } } },
  ];
  await flow.client.connect();
  let home = batches[0].changes.find((change) => change.kind === 'STRUCTURE');
  assert.deepEqual(home.home, { name: 'Fixture', values: { homegraph_home_uuid: 'home' } });
  flow.graph.homes[0].traits[0].fields.presenceState.stringValue = 'PRESENCE_STATE_VACANT';
  await flow.client.refresh();
  assert.equal(batches[1].changes.length, 1);
  assert.deepEqual([...batches[1].changes[0].fields], ['home']);
  assert.equal(batches[1].changes[0].value.home.traits[0].fields.presenceState.stringValue, 'PRESENCE_STATE_VACANT');
});

function sensorPreferences(context, response) {
  let flow = setup(context);
  flow.graph.homes[0].devices[1].hardware = { manufacturer: 'NEST', model: 'Nest Temperature Sensor' };
  let create = runtime.create;
  runtime.create = (options) => {
    let transport = create(options);
    let original = transport.command;
    transport.command = context.mock.fn((...args) => (args[2] === 'GetUserPreferences' ? response(...args) : original(...args)));
    return transport;
  };
  return flow;
}

for (let itemId of [238, 1360]) {
  for (let [label, serialSeparator, modelSeparator] of [
    ['Serial no.', ':', ':'],
    ['Serial number', '：', '：'],
    ['Serial Number', '：', ':'],
    ['Serial no.', ' : ', ' ： '],
  ]) {
    test('technical identity punctuation: ' + JSON.stringify([itemId, label, serialSeparator, modelSeparator]), async (context) => {
      let flow = sensorPreferences(context, async () => ({
        status: 0,
        data: [
          {
            item: {
              itemRef: { id: itemId },
              subtitle: 'Model' + modelSeparator + ' NEST_PROTECT_2_LINE.9<br/>' + label + serialSeparator + ' protectfixture123 ',
            },
          },
        ],
      }));
      await flow.client.connect();
      await flushPush();
      assert.deepEqual(flow.client.resources.get('sensor').value.technicalInformation, {
        serialNumber: 'PROTECTFIXTURE123',
        model: 'NEST_PROTECT_2_LINE.9',
      });
    });
  }
}

test('sensor technical identity is read once, published without opaque settings, and scoped to its provider', async (context) => {
  let reads = [];
  let flow = sensorPreferences(context, async (...args) => {
    reads.push(args);
    return {
      status: 0,
      data: [
        {
          item: {
            subitems: [
              {
                itemRef: { id: 238 },
                subtitle: 'Device ID: hidden<br/>Serial no.: 22AATEST123<br/>Battery state: High',
                appLink: 'private-settings-link',
              },
            ],
          },
        },
      ],
    };
  });
  await flow.client.connect();
  await flushPush();
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0][3], { structureId: 'home', pageCode: [25], uuid: { value: 'sensor' }, field5Proto: '' });
  assert.deepEqual(flow.client.resources.get('sensor').value.technicalInformation, { serialNumber: '22AATEST123' });
  assert.equal(JSON.stringify(flow.client.resources.get('sensor').value).includes('private-settings-link'), false);
  await flow.client.refresh();
  await flushPush();
  assert.equal(reads.length, 1);
  flow.graph.homes[0].devices[1].id.thirdPartyId.id = 'replacement-provider';
  await flow.client.refresh();
  await flushPush();
  assert.equal(reads.length, 2);
});

test('technical information failures back off independently while normal discovery continues', async (context) => {
  let now = Date.now();
  context.mock.method(Date, 'now', () => now);
  let reads = 0;
  let flow = sensorPreferences(context, async () => {
    reads++;
    return reads === 1
      ? { status: 7, message: 'private backend' }
      : { status: 0, data: [{ item: { itemRef: { id: 1360 }, subtitle: 'Serial number: 22AARETRY123' } }] };
  });
  await flow.client.connect();
  await flushPush();
  assert.equal(flow.client.resources.size, 3);
  assert.equal(flow.client.resources.get('sensor').value.technicalInformation, undefined);
  await flow.client.refresh();
  await flushPush();
  assert.equal(reads, 1);
  now += 60000;
  context.mock.timers.tick(60000);
  await flow.client.refresh();
  await flushPush();
  assert.equal(reads, 2);
  assert.equal(flow.client.resources.get('sensor').value.technicalInformation.serialNumber, '22AARETRY123');
});

for (let item of [
  undefined,
  {},
  { itemRef: { id: 238 }, subtitle: 'No serial information' },
  { itemRef: { id: 238 }, subtitle: 'Serial Number： https://private.invalid/serial' },
  { itemRef: { id: 238 }, subtitle: 'Serial Number： ＰＲＯＴＥＣＴ１２３' },
  { itemRef: { id: 999 }, subtitle: 'Serial no.: WRONG' },
  { itemRef: { id: 238, associatedId: { value: 'foreign-device' } }, subtitle: 'Serial no.: WRONG' },
  { itemRef: { id: 238 }, subtitle: 'x'.repeat(65537) },
  { subitems: Array.from({ length: 4097 }, () => ({})) },
]) {
  test(
    'unrecognised sensor preferences leave identity unknown without blocking discovery: ' + String(JSON.stringify(item)).slice(0, 70),
    async (context) => {
      let flow = sensorPreferences(context, async () => ({ status: 0, data: [{ item }] }));
      await flow.client.connect();
      await flushPush();
      assert.equal(flow.client.resources.size, 3);
      assert.equal(flow.client.resources.get('sensor').value.technicalInformation, undefined);
    },
  );
}

test('retired technical-information requests cannot commit sensor identities', async (context) => {
  let reply = Promise.withResolvers();
  let flow = sensorPreferences(context, () => reply.promise);
  let pending = flow.client.connect();
  await flushPush();
  flow.client.disconnect();
  reply.resolve({ status: 0, data: [{ item: { itemRef: { id: 238 }, subtitle: 'Serial no.: 22AALATE123' } }] });
  assert.equal(await pending, true);
  await flushPush();
  assert.equal(flow.client.resources.size, 3);
  assert.equal(flow.client.resources.get('sensor').value.technicalInformation, undefined);
});

test('removed sensors discard technical-info retry bookkeeping before a later rediscovery', async (context) => {
  let reads = 0;
  let flow = sensorPreferences(context, async () => {
    reads++;
    return { status: 7 };
  });
  await flow.client.connect();
  await flushPush();
  let sensor = flow.graph.homes[0].devices.splice(1, 1)[0];
  let state = flow.traits.splice(1, 1)[0];
  await flow.client.refresh();
  await flushPush();
  flow.graph.homes[0].devices.push(sensor);
  flow.traits.push(state);
  await flow.client.refresh();
  await flushPush();
  assert.equal(reads, 2);
});

test('thermostat discovery reads page 18 physical identity and caches only the serial', async (context) => {
  let reads = [];
  let flow = sensorPreferences(context, async (...args) => {
    reads.push(args[3]);
    return {
      status: 0,
      data: [
        {
          item: {
            itemRef: { associatedId: { value: args[3].uuid.value } },
            subitems: [
              {
                itemRef: { id: 238 },
                subtitle: 'Model: Nest Thermostat E<br/>Serial no.: THERMO123<br/>Battery voltage: 3.91 V<br/>IP: private',
              },
            ],
          },
        },
      ],
    };
  });
  flow.graph.homes[0].devices[0].hardware = { manufacturer: 'NEST', model: 'Nest Thermostat E' };
  delete flow.graph.homes[0].devices[1].hardware;
  await flow.client.connect();
  await flushPush();
  assert.deepEqual(reads, [{ structureId: 'home', pageCode: [18], uuid: { value: 'thermostat' }, field5Proto: '' }]);
  assert.deepEqual(flow.client.resources.get('thermostat').value.technicalInformation, { serialNumber: 'THERMO123' });
  await flow.client.refresh();
  await flushPush();
  assert.equal(reads.length, 1);
});

test('Protect discovery reads page 25 serial and technical model without exposing settings', async (context) => {
  let reads = [];
  let flow = sensorPreferences(context, async (...args) => {
    reads.push(args[3]);
    return {
      status: 0,
      data: [
        {
          item: {
            itemRef: { id: 238, associatedId: { value: 'protect' } },
            subtitle: 'Model: NEST_PROTECT_2_LINE.9<br/>Serial no.: 06PROTECTTEST<br/>IP: private-address',
          },
        },
      ],
    };
  });
  delete flow.graph.homes[0].devices[1].hardware;
  flow.graph.homes[0].devices.push({ ...device('protect', 'SMOKE_DETECTOR'), hardware: { model: 'Nest Protect' } });
  flow.traits.push({ uuid: { value: 'protect' }, category: [] });
  await flow.client.connect();
  await flushPush();
  assert.deepEqual(reads, [{ structureId: 'home', pageCode: [25], uuid: { value: 'protect' }, field5Proto: '' }]);
  assert.deepEqual(flow.client.resources.get('protect').value.technicalInformation, {
    serialNumber: '06PROTECTTEST',
    model: 'NEST_PROTECT_2_LINE.9',
  });
  await flow.client.refresh();
  await flushPush();
  assert.equal(reads.length, 1);
  assert.equal(JSON.stringify(flow.client.resources.get('protect').value).includes('private-address'), false);
});

test('lock discovery reads only physical identity from device settings page 11', async (context) => {
  let reads = [];
  let flow = sensorPreferences(context, async (...args) => {
    reads.push(args[3]);
    return {
      status: 0,
      data: [
        { item: { itemRef: { id: 238, associatedId: { value: 'lock' } }, subtitle: 'Serial no.: LOCKTEST123<br/>IP: private-address' } },
      ],
    };
  });
  delete flow.graph.homes[0].devices[1].hardware;
  flow.graph.homes[0].devices[2].hardware = { model: 'Nest x Yale Lock' };
  await flow.client.connect();
  await flushPush();
  assert.deepEqual(reads, [{ structureId: 'home', pageCode: [11], uuid: { value: 'lock' }, field5Proto: '' }]);
  assert.deepEqual(flow.client.resources.get('lock').value.technicalInformation, { serialNumber: 'LOCKTEST123' });
  assert.equal(JSON.stringify(flow.client.resources.get('lock').value).includes('private-address'), false);
  await flow.client.refresh();
  await flushPush();
  assert.equal(reads.length, 1);
});

test('camera discovery reads physical serial and technical model from page 25', async (context) => {
  let reads = [];
  let flow = sensorPreferences(context, async (...args) => {
    reads.push(args[3]);
    return {
      status: 0,
      data: [
        {
          item: {
            itemRef: { id: 238, associatedId: { value: 'camera' } },
            subtitle: 'Model: NEST_CAM_OUTDOOR.0<br/>Serial no.: CAMERATEST123<br/>IP: private-address',
          },
        },
      ],
    };
  });
  delete flow.graph.homes[0].devices[1].hardware;
  flow.graph.homes[0].devices.push({ ...device('camera', 'CAMERA'), hardware: { model: 'Nest Cam Outdoor' } });
  flow.traits.push({ uuid: { value: 'camera' }, category: [] });
  await flow.client.connect();
  await flushPush();
  assert.deepEqual(reads, [{ structureId: 'home', pageCode: [25], uuid: { value: 'camera' }, field5Proto: '' }]);
  assert.deepEqual(flow.client.resources.get('camera').value.technicalInformation, {
    serialNumber: 'CAMERATEST123',
    model: 'NEST_CAM_OUTDOOR.0',
  });
  assert.equal(JSON.stringify(flow.client.resources.get('camera').value).includes('private-address'), false);
});

async function cameraEventSetup(context) {
  context.mock.method(Date, 'now', () => flow.now);
  let flow = setup(context);
  flow.now = 1700000000000;
  flow.graph.homes[0].devices.push(device('camera', 'CAMERA'), device('bell', 'DOORBELL'));
  flow.traits.push({ uuid: { value: 'camera' }, category: [] }, { uuid: { value: 'bell' }, category: [] });
  await flow.client.connect();
  await flushPush();
  flow.time = (offset) => ({ seconds: String((flow.now + offset) / 1000) });
  flow.track = (id = 'track', overrides = {}) => ({
    trackId: id,
    startTime: flow.time(-6000),
    endTime: flow.time(-1000),
    eventTypes: ['EVENT_TYPE_MOTION', 'EVENT_TYPE_MOTION', 'EVENT_TYPE_DOORBELL'],
    activityZones: [{ zoneId: 'zone-1' }],
    ...overrides,
  });
  flow.period = (tracks, variant = 'recorded') => ({ [variant]: { session: { sessionId: 'session', tracks } } });
  flow.timelines = {
    camera: { periods: [flow.period([flow.track()])] },
    bell: { periods: [flow.period([flow.track('bell-track', { eventTypes: ['EVENT_TYPE_DOORBELL'] })])] },
  };
  let transport = flow.transports[0];
  let original = transport.command;
  transport.command = context.mock.fn(async (...args) =>
    args[2] === 'ListTimelinePeriods'
      ? { status: 0, data: [structuredClone(flow.timelines[args[3].request.deviceId])] }
      : original(...args),
  );
  flow.eventCalls = () => transport.command.mock.calls.map((call) => call.arguments);
  return flow;
}

test('camera event GET uses one camera-scoped timeline RPC and returns the protobuf event contract', async (context) => {
  let flow = await cameraEventSetup(context);
  let [camera, bell] = await Promise.all([flow.client.get('camera', 'camera_events'), flow.client.get('bell', 'camera_events')]);
  assert.deepEqual(camera, [
    {
      id: 'track',
      playback_time: flow.now - 6000,
      start_time: flow.now - 6000,
      end_time: flow.now - 1000,
      types: ['motion', 'doorbell'],
      zone_ids: ['zone-1'],
    },
  ]);
  assert.deepEqual(
    bell.map((event) => event.id),
    ['bell-track'],
  );
  assert.equal(flow.eventCalls().length, 2);
  for (let [index, id] of ['camera', 'bell'].entries()) {
    let call = flow.eventCalls()[index];
    assert.deepEqual(call.slice(0, 3), ['google.internal.home.foyer.v1.', 'CameraService', 'ListTimelinePeriods']);
    assert.deepEqual(call[3], {
      request: { deviceId: id, startTime: { seconds: flow.now / 1000 - 60 }, endTime: { seconds: flow.now / 1000 } },
      field2: 1,
      strongRead: true,
    });
    assert.deepEqual(call[4], { retry: 1, timeout: 4000 });
  }
  camera[0].types.push('caller-mutation');
  assert.deepEqual((await flow.client.get('camera', 'camera_events'))[0].types, ['motion', 'doorbell']);
  assert.equal(flow.eventCalls().length, 2);
  await assert.rejects(flow.client.get('foreign-camera', 'camera_events'), /discovered device/);
  assert.equal(flow.eventCalls().length, 2);
  flow.now += 2000;
  assert.equal((await flow.client.get('camera', 'camera_events')).length, 1);
  assert.equal(flow.eventCalls().length, 3);
  flow.now += 2000;
  flow.timelines.camera.periods[0].recorded.session.tracks[0].endTime = flow.time(0);
  assert.equal((await flow.client.get('camera', 'camera_events'))[0].end_time, flow.now);
  assert.equal(flow.eventCalls().length, 4);
});

test('same-camera timeline reads coalesce while an RPC is pending', async (context) => {
  let flow = await cameraEventSetup(context);
  let transport = flow.transports[0];
  let pending = Promise.withResolvers();
  transport.command = context.mock.fn(async () => pending.promise);
  let first = flow.client.get('camera', 'camera_events');
  flow.now += 5000;
  let second = flow.client.get('camera', 'camera_events');
  assert.equal(transport.command.mock.callCount(), 1);
  pending.resolve({ status: 0, data: [flow.timelines.camera] });
  assert.deepEqual(await first, await second);
});

test('timeline normalization handles all period variants and excludes invalid, expired and duplicate tracks', async (context) => {
  let flow = await cameraEventSetup(context);
  flow.timelines.camera.periods = [
    {},
    flow.period([
      flow.track('track'),
      flow.track('track', { endTime: flow.time(-3000) }),
      flow.track(''),
      flow.track('x'.repeat(513)),
      flow.track('expired', { startTime: flow.time(-25000), endTime: flow.time(-16000) }),
      flow.track('future', { startTime: flow.time(20000), endTime: flow.time(21000) }),
      flow.track('bad-end', { endTime: flow.time(-9000) }),
      flow.track('bad-start', { startTime: { seconds: 'invalid' } }),
      flow.track('negative', { startTime: { seconds: '-1' } }),
      flow.track('unknown', { eventTypes: [200, 'EVENT_TYPE_UNSPECIFIED'] }),
    ]),
    flow.period(
      [
        flow.track('missing-end', {
          endTime: undefined,
          activityZones: undefined,
          eventTypes: ['EVENT_TYPE_FACE_FAMILIAR', 'EVENT_TYPE_FACE_UNFAMILIAR', 'EVENT_TYPE_MOVING_VEHICLE', 'EVENT_TYPE_ANIMAL_OTHER'],
        }),
      ],
      'noVideo',
    ),
    flow.period(
      [
        flow.track('newer', {
          startTime: flow.time(-2000),
          activityZones: [{ zoneId: '' }, {}, { zoneId: 'x'.repeat(129) }],
        }),
      ],
      'unknown',
    ),
  ];
  let events = await flow.client.get('camera', 'camera_events');
  assert.deepEqual(
    events.map((event) => event.id),
    ['newer', 'track', 'missing-end'],
  );
  assert.equal(events.find((event) => event.id === 'track').end_time, flow.now - 1000);
  assert.deepEqual(events.find((event) => event.id === 'missing-end').types, ['face', 'unfamiliar-face', 'vehicle', 'animal']);
  assert.deepEqual(events[0].zone_ids, []);
  assert.equal(
    events.some((event) => Object.hasOwn(event, 'source')),
    false,
  );
});

test('unexpected timeline errors stay sanitized and failed reads can be retried', async (context) => {
  let flow = await cameraEventSetup(context);
  let transport = flow.transports[0];
  let base = transport.command;
  let fail = true;
  transport.command = context.mock.fn(async (...args) => (fail === true ? { status: 7, message: 'private-token-url' } : base(...args)));
  await assert.rejects(
    flow.client.get('camera', 'camera_events'),
    (error) => error.message === 'HomeGraph ListTimelinePeriods request failed' && error.status === 7,
  );
  fail = false;
  assert.equal((await flow.client.get('camera', 'camera_events')).length, 1);
});

test('timeline deadlines return no events without retrying or retaining the failed read', async (context) => {
  let flow = await cameraEventSetup(context);
  let transport = flow.transports[0];
  let base = transport.command;
  transport.command = context.mock.fn(async () => ({ status: 4, code: 'REQUEST_TIMEOUT' }));
  assert.deepEqual(await flow.client.get('camera', 'camera_events'), []);
  assert.equal(transport.command.mock.callCount(), 1);
  assert.deepEqual(transport.command.mock.calls[0].arguments[4], { retry: 1, timeout: 4000 });
  transport.command = base;
  assert.equal((await flow.client.get('camera', 'camera_events')).length, 1);
});

for (let retirement of ['disconnect', 'token', 'move', 'identity', 'remove']) {
  test('late timeline replies cannot survive ' + retirement, async (context) => {
    let flow = await cameraEventSetup(context);
    let transport = flow.transports[0];
    let pending = Promise.withResolvers();
    transport.command = async () => pending.promise;
    let read = flow.client.get('camera', 'camera_events');
    await setImmediate();
    if (retirement === 'disconnect') {
      flow.client.disconnect();
    }
    if (retirement === 'token') {
      flow.session.account.cameraAuth.oauth2 = 'replacement';
    }
    if (retirement === 'move') {
      flow.client.resources.get('camera').structureId = 'another-home';
    }
    if (retirement === 'identity') {
      flow.client.resources.get('camera').value.googleHome.id.thirdPartyId.id = 'another-device';
    }
    if (retirement === 'remove') {
      flow.client.resources.delete('camera');
    }
    pending.resolve({ status: 0, data: [flow.timelines.camera] });
    assert.deepEqual(await read, []);
  });
}

test('timeline caches expire results and cannot serve removed, unassigned or non-camera resources', async (context) => {
  let flow = await cameraEventSetup(context);
  await flow.client.get('camera', 'camera_events');
  flow.now += 20000;
  assert.deepEqual(await flow.client.get('camera', 'camera_events'), []);
  flow.timelines.camera = { periods: [] };
  flow.now += 2000;
  assert.deepEqual(await flow.client.get('camera', 'camera_events'), []);
  assert.deepEqual(await flow.client.get('thermostat', 'camera_events'), []);
  flow.client.resources.get('camera').structureId = undefined;
  assert.deepEqual(await flow.client.get('camera', 'camera_events'), []);
  flow.graph.homes = [];
  await flow.client.refresh();
  await flushPush();
  await assert.rejects(flow.client.get('camera', 'camera_events'), /discovered device/);
});

test('a replacement camera cannot accept an old in-flight timeline reply', async (context) => {
  let flow = await cameraEventSetup(context);
  let transport = flow.transports[0];
  let base = transport.command;
  let old = Promise.withResolvers();
  let first = true;
  transport.command = context.mock.fn(async (...args) => {
    if (first === true) {
      first = false;
      return old.promise;
    }
    return base(...args);
  });
  let pending = flow.client.get('camera', 'camera_events');
  await setImmediate();
  flow.client.resources.get('camera').value.googleHome.id.thirdPartyId.id = 'replacement';
  flow.timelines.camera.periods[0].recorded.session.tracks[0].endTime = flow.time(0);
  let newer = await flow.client.get('camera', 'camera_events');
  old.resolve({ status: 0, data: [{ periods: [] }] });
  assert.deepEqual(await pending, []);
  assert.equal(newer[0].end_time, flow.now);
  assert.deepEqual(await flow.client.get('camera', 'camera_events'), newer);
  assert.equal(transport.command.mock.callCount(), 2);
});

function floodlightSetup(context, options = {}) {
  let flow = setup(context, options);
  flow.graph.homes[0].devices.push(device('camera', 'CAMERA'), device('light', 'LIGHT'));
  flow.traits.push(
    { uuid: { value: 'camera' }, category: [] },
    {
      uuid: { value: 'light' },
      category: [category('onOff', { onOff: { boolean: false } }), category('brightness', { brightness: { number: 50 } })],
    },
  );
  flow.preferences = {
    item: {
      itemRef: { associatedId: { value: 'camera' } },
      subitems: [
        { itemRef: { id: 1118, associatedId: { value: 'light' } }, appLink: 'private-settings-link' },
        { itemRef: { id: 238 }, subtitle: 'Serial no.: FLOODLIGHT<br/>Model: NEST_CAM.0' },
      ],
    },
  };
  let create = runtime.create;
  runtime.create = (options) => {
    let transport = create(options);
    let command = transport.command;
    transport.command = context.mock.fn((...args) =>
      args[2] === 'GetUserPreferences' ? Promise.resolve({ status: 0, data: [structuredClone(flow.preferences)] }) : command(...args),
    );
    return transport;
  };
  return flow;
}

test('camera preferences retain only the associated floodlight ID and reuse it with cached technical identity', async (context) => {
  let batches = [];
  let flow = floodlightSetup(context, { onData: (batch) => batches.push(batch) });
  await flow.client.connect();
  await flushPush();
  let camera = batches.at(-1).changes.find((change) => change.resourceId === 'camera');
  assert.equal(camera.value.floodlightId, 'light');
  assert.equal(camera.value.technicalInformation.serialNumber, 'FLOODLIGHT');
  assert.equal(JSON.stringify(camera.value).includes('private-settings-link'), false);
  await flow.client.refresh();
  await flushPush();
  assert.equal(flow.transports[0].command.mock.calls.filter((call) => call.arguments[2] === 'GetUserPreferences').length, 1);
  assert.equal(flow.client.resources.get('camera').value.floodlightId, 'light');
  assert.equal(batches.length, 2);
});

for (let [key, value, name, scalar] of [
  ['light_enabled', true, 'onOff', { boolean: true }],
  ['light_enabled', false, 'onOff', { boolean: false }],
  ['light_brightness', 0, 'brightness', { number: 0 }],
  ['light_brightness', 37, 'brightness', { number: 37 }],
  ['light_brightness', 100, 'brightness', { number: 100 }],
]) {
  test('HomeGraph sends ' + key + '=' + value + ' to the associated light, preserving observed state', async (context) => {
    let flow = floodlightSetup(context);
    await flow.client.connect();
    await flushPush();
    let camera = flow.client.resources.get('camera');
    let light = flow.client.resources.get('light');
    let before = structuredClone(light);
    await flow.client.set('camera', { [key]: value });
    let call = flow.transports[0].command.mock.calls.find((call) => call.arguments[2] === 'UpdateTraits').arguments;
    assert.deepEqual(call.slice(1, 4), [
      'HomeControlService',
      'UpdateTraits',
      {
        request: [
          {
            deviceId: { uuid: 'light', internalId: { source: 'nest-home-assistant-prod' } },
            categories: [{ name, traits: [{ name, value: scalar }] }],
          },
        ],
      },
    ]);
    assert.equal(flow.client.resources.get('camera'), camera);
    assert.deepEqual(light, before);
  });
}

for (let invalid of ['unlinked', 'missing', 'home', 'provider', 'camera', 'trait', 'unavailable-home']) {
  test('HomeGraph rejects an unverified floodlight control target: ' + invalid, async (context) => {
    let flow = floodlightSetup(context);
    await flow.client.connect();
    await flushPush();
    let light = flow.client.resources.get('light');
    let camera = flow.client.resources.get('camera');
    if (invalid === 'unlinked') {
      delete camera.value.floodlightId;
    }
    if (invalid === 'missing') {
      flow.client.resources.delete('light');
    }
    if (invalid === 'home') {
      light.structureId = 'other';
    }
    if (invalid === 'provider') {
      light.device.id.thirdPartyId.idType = 'third-party';
    }
    if (invalid === 'camera') {
      light.device.type = 'action.devices.types.CAMERA';
    }
    if (invalid === 'trait') {
      light.traits = [];
    }
    if (invalid === 'unavailable-home') {
      camera.structureId = undefined;
    }
    await assert.rejects(flow.client.set('camera', { light_enabled: true }), AggregateError);
    assert.equal(
      flow.transports[0].command.mock.calls.some((call) => call.arguments[2] === 'UpdateTraits'),
      false,
    );
  });
}

for (let [key, value] of [
  ['light_enabled', 1],
  ['light_enabled', 'true'],
  ['light_enabled', null],
  ['light_brightness', '50'],
  ['light_brightness', -1],
  ['light_brightness', 101],
  ['light_brightness', NaN],
  ['light_brightness', Infinity],
]) {
  test('HomeGraph rejects malformed light settings: ' + key + '=' + String(value), async (context) => {
    let flow = floodlightSetup(context);
    await flow.client.connect();
    await flushPush();
    await assert.rejects(flow.client.set('camera', { [key]: value }), AggregateError);
    assert.equal(
      flow.transports[0].command.mock.calls.some((call) => call.arguments[2] === 'UpdateTraits'),
      false,
    );
  });
}

for (let failure of ['challenge', 'error', 'wrong-device', 'transport', 'replaced-light', 'replaced-camera']) {
  test('HomeGraph floodlight command cannot report success after ' + failure, async (context) => {
    let flow = floodlightSetup(context);
    await flow.client.connect();
    await flushPush();
    let command = flow.transports[0].command;
    flow.transports[0].command = context.mock.fn(async (...args) => {
      if (args[2] !== 'UpdateTraits') {
        return command(...args);
      }
      if (failure === 'transport') {
        return { status: 7, data: [] };
      }
      if (failure === 'replaced-light') {
        let replacement = structuredClone(flow.client.resources.get('light'));
        replacement.device.id.thirdPartyId.id = 'new-light-provider';
        flow.client.resources.set('light', replacement);
      }
      if (failure === 'replaced-camera') {
        let replacement = structuredClone(flow.client.resources.get('camera'));
        replacement.device.id.thirdPartyId.id = 'new-camera-provider';
        flow.client.resources.set('camera', replacement);
      }
      return {
        status: 0,
        data: [
          {
            device: [
              {
                uuid: { value: failure === 'wrong-device' ? 'camera' : 'light' },
                category: ['challenge', 'error'].includes(failure)
                  ? [category('deviceStatus', { [failure]: { text: 'fixture-rejection' } })]
                  : [],
              },
            ],
          },
        ],
      };
    });
    await assert.rejects(flow.client.set('camera', { light_brightness: 40 }), AggregateError);
  });
}

test('HomeGraph floodlight push remains a child-only state delta for the existing mapping pipeline', async (context) => {
  let batches = [];
  let flow = floodlightSetup(context, { onData: (batch) => batches.push(batch), registerPush: async () => ({}) });
  await flow.client.connect();
  await flushPush();
  await flow.pushes[0].options.onData(
    {
      uuid: { value: 'light' },
      category: [category('onOff', { onOff: { boolean: true } })],
    },
    () => true,
  );
  let last = batches.at(-1);
  assert.equal(last.changes.length, 1);
  assert.equal(last.changes[0].resourceId, 'light');
  assert.deepEqual(last.changes[0].value, { 'onOff.onOff': { boolean: true } });
  assert.equal(flow.client.resources.get('camera').value.floodlightId, 'light');
});

for (let selfEcho of [false, true]) {
  test('pending SET accepts telemetry or its own state echo for the same device: selfEcho=' + selfEcho, async (context) => {
    let flow = setup(context, { registerPush: pushRegistration });
    await flow.client.connect();
    let reply = Promise.withResolvers();
    flow.transports[0].command.mock.mockImplementation(() => reply.promise);
    let pending = flow.client.set('thermostat', { target_temperature_high: 24.5 });
    await flow.pushes[0].options.onData(
      pushed(
        'thermostat',
        'temperatureSetting',
        selfEcho === true ? { thermostatTemperatureSetpointHighC: { number: 24.5 } } : { ambientAirTemperatureC: { number: 22.5 } },
      ),
      () => true,
    );
    reply.resolve({ status: 0, data: [{}] });
    await pending;
  });
}

test('sensor deselection accepts its successful push echo without losing parent ownership checks', async (context) => {
  let flow = setup(context, { registerPush: pushRegistration });
  await flow.client.connect();
  let reply = Promise.withResolvers();
  flow.transports[0].command.mock.mockImplementation(() => reply.promise);
  let pending = flow.client.set('sensor', { active_sensor: false });
  await flow.pushes[0].options.onData(
    pushed('thermostat', 'temperatureSetting', {
      activeThermostatTemperatureSensors: { array: { values: [{ text: 'thermostat' }] } },
    }),
    () => true,
  );
  reply.resolve({ status: 0, data: [{}] });
  await pending;
});

test('a full poll preserves a newer image while still removing other absent traits', async (context) => {
  let flow = await cameraSetup(context, { registerPush: pushRegistration });
  let newer = flow.url.replace('/fixture', '/newer');
  await flow.pushes[0].options.onData(
    { uuid: { value: 'camera' }, category: [captureCategory(newer, 200), category('transient', { temporary: { boolean: true } })] },
    () => true,
  );
  flow.transports[0].command.mock.mockImplementation(async (_prefix, _service, method) => ({
    status: 0,
    data: [
      method === 'GetHomeGraph'
        ? flow.graph
        : {
            device: flow.traits.map((state) =>
              state.uuid.value === 'camera' ? { uuid: { value: 'camera' }, category: [captureCategory(flow.url, 100)] } : state,
            ),
          },
    ],
  }));
  await flow.client.refresh();
  let properties = traitValue(flow.client, 'camera', 'cameraStream', 'cameraStreamLiveViewImage').properties.properties;
  assert.equal(properties.find((property) => property.name === 'timestampSeconds').value.number, 200);
  assert.equal(properties.find((property) => property.name === 'imageUrl').value.text, newer);
  assert.equal(traitValue(flow.client, 'camera', 'transient', 'temporary'), undefined);
});

test('slow technical information does not block discovery, push or ordinary telemetry', async (context) => {
  let response = Promise.withResolvers();
  let batches = [];
  let flow = setup(context, { registerPush: pushRegistration, onData: (batch) => batches.push(batch) });
  flow.graph.homes[0].devices[1].hardware = { model: 'Nest Temperature Sensor' };
  let create = runtime.create;
  runtime.create = (options) => {
    let transport = create(options);
    let command = transport.command;
    transport.command = context.mock.fn((...args) => (args[2] === 'GetUserPreferences' ? response.promise : command(...args)));
    return transport;
  };
  assert.equal(await flow.client.connect(), true);
  assert.equal(flow.pushes.length, 1);
  assert.equal(batches.length, 1);
  await flow.client.refresh();
  assert.equal(flow.transports[0].command.mock.calls.filter((call) => call.arguments[2] === 'GetUserPreferences').length, 1);
  await flow.pushes[0].options.onData(pushed('sensor', 'temperatureSetting', { ambientAirTemperatureC: { number: 22.5 } }), () => true);
  response.resolve({ status: 0, data: [{ item: { itemRef: { id: 238 }, subtitle: 'Serial no.: FIXTURE123' } }] });
  await flushPush();
  assert.equal(flow.client.resources.get('sensor').value.technicalInformation.serialNumber, 'FIXTURE123');
  assert.equal(traitValue(flow.client, 'sensor', 'temperatureSetting', 'ambientAirTemperatureC').number, 22.5);
  assert.deepEqual([...batches.at(-1).changes[0].fields], ['technicalInformation']);
});

test('metadata committed during a full read survives that read without being fetched again', async (context) => {
  let preference = Promise.withResolvers();
  let flow = sensorPreferences(context, () => preference.promise);
  await flow.client.connect();
  let transport = flow.transports[0];
  let command = transport.command;
  let traits = Promise.withResolvers();
  transport.command = context.mock.fn((...args) => (args[2] === 'GetTraits' ? traits.promise : command(...args)));
  let refresh = flow.client.refresh();
  await flushPush();
  preference.resolve({ status: 0, data: [{ item: { itemRef: { id: 238 }, subtitle: 'Serial no.: OVERLAP123' } }] });
  await flushPush();
  traits.resolve({ status: 0, data: [{ device: flow.traits }] });
  await refresh;
  await flushPush();
  assert.equal(flow.client.resources.get('sensor').value.technicalInformation.serialNumber, 'OVERLAP123');
  assert.equal(command.mock.calls.filter((call) => call.arguments[2] === 'GetUserPreferences').length, 1);
});

for (let type of ['CAMERA', 'DOORBELL']) {
  for (let enabled of [true, false]) {
    test('HomeGraph camera power sends an explicit wrapped boolean: ' + type + ' enabled=' + enabled, async (context) => {
      let flow = setup(context);
      flow.graph.homes[0].devices.push(device('camera', type));
      flow.traits.push({ uuid: { value: 'camera' }, category: [category('onOff', { onOff: { boolean: !enabled } })] });
      await flow.client.connect();
      let before = structuredClone(flow.client.resources.get('camera'));
      await flow.client.set('camera', { streaming_enabled: enabled });
      let calls = flow.transports[0].command.mock.calls.filter((call) => call.arguments[2] === 'UpdateCameraProperty');
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].arguments.slice(1, 4), [
        'CameraService',
        'UpdateCameraProperty',
        { hgsDeviceId: 'camera', properties: { streamingEnabled: { value: enabled } } },
      ]);
      assert.deepEqual(flow.client.resources.get('camera'), before, 'only observed updates change the cache');
    });
  }
}

for (let invalid of ['value', 'type', 'provider', 'missing-trait', 'transport', 'replacement']) {
  test('HomeGraph camera power rejects ' + invalid, async (context) => {
    let flow = setup(context);
    let camera = device('camera', invalid === 'type' ? 'LIGHT' : 'CAMERA');
    if (invalid === 'provider') {
      camera.id.thirdPartyId.idType = 'other-provider';
    }
    flow.graph.homes[0].devices.push(camera);
    flow.traits.push({
      uuid: { value: 'camera' },
      category: invalid === 'missing-trait' ? [] : [category('onOff', { onOff: { boolean: true } })],
    });
    await flow.client.connect();
    let command = flow.transports[0].command;
    command.mock.mockImplementation(async (_prefix, _service, method) => {
      assert.equal(method, 'UpdateCameraProperty');
      if (invalid === 'replacement') {
        let replacement = structuredClone(flow.client.resources.get('camera'));
        replacement.device.id.thirdPartyId.id = 'replacement-camera';
        flow.client.resources.set('camera', replacement);
      }
      return invalid === 'transport' ? { status: 7, data: [] } : { status: 0, data: [{}] };
    });
    let count = command.mock.callCount();
    await assert.rejects(flow.client.set('camera', { streaming_enabled: invalid === 'value' ? 'false' : false }), AggregateError);
    assert.equal(command.mock.callCount() - count, ['transport', 'replacement'].includes(invalid) === true ? 1 : 0);
  });
}

test('HomeGraph seeds weather at discovery, retains it through reconciliation and refreshes when the location moves', async (context) => {
  let flow = setup(context);
  await flow.client.connect();
  let transport = flow.transports[0];
  let weatherCalls = 0;
  transport.command.mock.mockImplementation(async (prefix, service, method) => {
    if (method === 'GetOutdoorWeatherInfo') {
      weatherCalls++;
      return { status: 0, data: [{ weather: { temperatureC: {}, description: 'Cloudy' } }] };
    }
    return { status: 0, data: [structuredClone(method === 'GetHomeGraph' ? flow.graph : { device: flow.traits })] };
  });
  flow.graph.homes[0].address = { coordinates: { latitude: 1, longitude: 2 } };
  await flow.client.refresh();
  assert.deepEqual(flow.client.homes.get('home').weather, { current_temperature: 0, condition: 'Cloudy' });
  assert.equal(weatherCalls, 1);
  await flow.client.refresh();
  assert.equal(weatherCalls, 1, 'Graph reconciliation must not poll weather repeatedly');
  flow.graph.homes[0].address.coordinates.latitude = 3;
  await flow.client.refresh();
  assert.equal(weatherCalls, 2);
  assert.equal(transport.command.mock.calls.findLast((call) => call.arguments[2] === 'GetOutdoorWeatherInfo').arguments[3].latitude, 3);
});

test('a weather failure leaves HomeGraph discovery usable and retries on the next read', async (context) => {
  let flow = setup(context);
  await flow.client.connect();
  let transport = flow.transports[0];
  transport.command.mock.mockImplementation(async (prefix, service, method) =>
    method === 'GetOutdoorWeatherInfo'
      ? { status: 7, data: [] }
      : { status: 0, data: [structuredClone(method === 'GetHomeGraph' ? flow.graph : { device: flow.traits })] },
  );
  flow.graph.homes[0].address = { coordinates: { latitude: 1, longitude: 2 } };
  await flow.client.refresh();
  assert.equal(flow.client.resources.size, 3);
  assert.equal(flow.client.homes.get('home').weather, undefined);
  let calls = transport.command.mock.calls.filter((call) => call.arguments[2] === 'GetOutdoorWeatherInfo').length;
  await flow.client.refresh();
  assert.equal(transport.command.mock.calls.filter((call) => call.arguments[2] === 'GetOutdoorWeatherInfo').length, calls + 1);
});

for (let model of ['Heat Link E', 'HEAT_LINK', 'Nest Heat-Link', 'HeatLink']) {
  test('Heat Link discovery reads its own technical identity and retains its thermostat reference: ' + model, async (context) => {
    let reads = [];
    let flow = sensorPreferences(context, async (...args) => {
      reads.push(args);
      return {
        status: 0,
        data: [
          {
            item: {
              itemRef: { associatedId: { value: 'sensor' } },
              subitems: [
                { itemRef: { id: 238 }, subtitle: 'Serial number: HEATLINK123<br/>Software: 1.2.3', appLink: 'private-settings-link' },
              ],
            },
          },
        ],
      };
    });
    flow.graph.homes[0].devices[1].hardware = { model, softwareVersion: '1.2.3' };
    flow.graph.homes[0].devices[1].parentDevice = { googleUuid: 'thermostat' };
    await flow.client.connect();
    await flushPush();
    let resource = flow.client.resources.get('sensor');
    assert.equal(resource.metadata.type, 'Heatlink');
    assert.equal(resource.value.googleHome.hardware.softwareVersion, '1.2.3');
    assert.deepEqual(resource.value.googleHome.parentDevice, { googleUuid: 'thermostat' });
    assert.deepEqual(resource.value.technicalInformation, { serialNumber: 'HEATLINK123' });
    assert.equal(reads.length, 1);
    assert.deepEqual(reads[0][3], { structureId: 'home', pageCode: [25], uuid: { value: 'sensor' }, field5Proto: '' });
    assert.equal(JSON.stringify(resource.value).includes('private-settings-link'), false);
  });
}

test('ordinary HomeGraph reads and writes retain the transport single-attempt default', async (context) => {
  let flow = setup(context);
  await flow.client.connect();
  let transport = flow.transports[0];
  for (let call of transport.command.mock.calls) {
    assert.deepEqual(call.arguments[4], {});
  }
  await flow.client.set('lock', { bolt_lock: true });
  assert.deepEqual(transport.command.mock.calls.at(-1).arguments[4], {});
  transport.command = context.mock.fn(async () => ({ status: 14 }));
  await assert.rejects(flow.client.refresh(), /GetHomeGraph request failed/);
  assert.equal(transport.command.mock.callCount(), 1);
  assert.deepEqual(transport.command.mock.calls[0].arguments[4], {});
});

for (let ready of [false, true]) {
  test('push status preserves discovery retry deadline and backoff: ready=' + ready, async (context) => {
    let flow = setup(context, { poll: true, registerPush: pushRegistration });
    await flow.client.connect();
    let push = flow.pushes[0];
    push.options.onStatus(ready !== true);
    let transport = flow.transports[0];
    transport.command = context.mock.fn(async () => ({ status: 14 }));
    await assert.rejects(flow.client.refresh(), /GetHomeGraph request failed/);
    await assert.rejects(flow.client.refresh(), /GetHomeGraph request failed/);
    assert.equal(transport.command.mock.callCount(), 2);

    context.mock.timers.tick(3000);
    push.options.onStatus(ready);
    context.mock.timers.tick(6999);
    await flushPush();
    assert.equal(transport.command.mock.callCount(), 2, 'push status must not shorten or replace the ten-second deadline');
    context.mock.timers.tick(1);
    await flushPush();
    assert.equal(transport.command.mock.callCount(), 3, 'the original retry deadline remains active');

    context.mock.timers.tick(19999);
    await flushPush();
    assert.equal(transport.command.mock.callCount(), 3);
    context.mock.timers.tick(1);
    await flushPush();
    assert.equal(transport.command.mock.callCount(), 4, 'the next failure continues the twenty-second backoff');
  });
}
