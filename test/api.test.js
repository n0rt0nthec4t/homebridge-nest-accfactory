// Exercise account-scoped API ingestion without cloud access or platform-private method extraction.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { importSource } from './helpers/import-source.js';
import { ACCOUNT_TYPE, DATA_SOURCE, NEST_API_BUCKETS } from '../src/consts.js';

let boundary =
  'data:text/javascript,' +
  encodeURIComponent(
    'import timers from "node:timers"; export const runtime = { fetch: undefined, types: [] };' +
      'export function setTimeout(...args) { return timers.setTimeout(...args); }' +
      'export function clearTimeout(...args) { return timers.clearTimeout(...args); }' +
      'export function fetchWrapper(...args) { return runtime.fetch(...args); }' +
      'export function getProtoTypes() { return runtime.types; }' +
      'export default class Transport { static STATUS = { UNAUTHENTICATED: 16 }; constructor() { return runtime.transport(); } }',
  );
let { runtime } = await import(boundary);
let classes = {};
for (let name of ['nest', 'google']) {
  let location = new URL('../src/api/' + name + '.js', import.meta.url);
  let source = (await readFile(location, 'utf8')).replace(
    /from '([^']+)'/g,
    (match, specifier) =>
      'from ' +
      JSON.stringify(
        ['node:timers', '../fetchWrapper.js', '../protobuf.js', '../grpctransport.js'].includes(specifier) === true ? boundary : specifier,
      ),
  );
  classes[name] = (await importSource(location, source)).default;
}

function setup(context, kind = 'google', overrides = {}) {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  runtime.types = [{ fullName: '.nest.trait.device.Identity' }];
  let requests = [];
  let observations = [];
  let pending = [];
  let changed = [];
  let removed = [];
  let unauthorised = [];
  let logs = [];
  let connection = {
    authorised: true,
    type: ACCOUNT_TYPE.GOOGLE,
    name: 'Account',
    userID: 'user',
    referer: 'home.invalid',
    restAPIHost: 'rest.invalid',
    transport_url: 'https://transport.invalid',
    token: 'token',
    snapshotWaiters: new Map(),
    grpcTransport: {
      observe: (...args) => {
        observations.push(args);
        let request = Promise.withResolvers();
        pending.push(request);
        return request.promise;
      },
    },
  };
  let transport = connection.grpcTransport;
  runtime.transport = () => ({ ...transport });
  let current = connection;
  runtime.fetch = (...args) => {
    requests.push(args);
    let request = Promise.withResolvers();
    pending.push(request);
    return request.promise;
  };
  let options = {
    uuid: 'account',
    account: connection,
    rawData: {},
    getResource: (id) => options.rawData[id],
    homes: [],
    isCurrent: () => current === connection,
    onData: async (batch) => {
      changed.push(batch);
      return true;
    },
    onRemove: async (id) => removed.push(id),
    onUnauthorised: (reason) => {
      unauthorised.push(reason);
      connection.authorised = false;
    },
    getCameraProperties: async () => undefined,
    log: { debug: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
    ...overrides,
  };
  let api = new classes[kind](options);
  context.after(() => api.disconnect());
  return {
    api,
    options,
    connection,
    requests,
    observations,
    pending,
    changed,
    removed,
    unauthorised,
    logs,
    replace: (value) => {
      current = value;
    },
  };
}
let reply = (data) => ({ json: async () => data });

test('Google Observe normal completion restarts after one second; duplicate starts do not open streams', async (context) => {
  let flow = setup(context);
  await flow.api.connect();
  await flow.api.connect();
  assert.equal(flow.observations.length, 1);
  flow.pending[0].resolve({ status: 0 });
  await setImmediate();
  context.mock.timers.tick(999);
  assert.equal(flow.observations.length, 1);
  context.mock.timers.tick(1);
  assert.equal(flow.observations.length, 2);
  flow.api.disconnect();
  flow.pending[1].resolve({ status: 14 });
  await setImmediate();
  context.mock.timers.tick(120000);
  assert.equal(flow.observations.length, 2);
});

test('Google Observe rejection backs off and a processed update resets the retry delay', async (context) => {
  let flow = setup(context);
  await flow.api.connect();
  flow.pending[0].reject(new Error('network unavailable'));
  await setImmediate();
  context.mock.timers.tick(5000);
  await flow.observations[1][4]({ observeResponse: [] });
  flow.pending[1].reject(new Error('network unavailable again'));
  await setImmediate();
  context.mock.timers.tick(4999);
  assert.equal(flow.observations.length, 2);
  context.mock.timers.tick(1);
  assert.equal(flow.observations.length, 3);
});

for (let kind of ['nest', 'google']) {
  for (let reason of ['unauthorised', 'replaced']) {
    test(kind + ' API does not start when ' + reason, async (context) => {
      let flow = setup(context, kind);
      if (reason === 'unauthorised') {
        flow.connection.authorised = false;
      }
      if (reason === 'replaced') {
        flow.replace(undefined);
      }
      await flow.api.connect();
      assert.equal(flow.pending.length, 0);
    });
  }
  test(kind + ' stopped-run callbacks cannot affect a restart on the same account', async (context) => {
    let flow = setup(context, kind);
    await flow.api.connect();
    flow.api.disconnect();
    await flow.api.connect();
    if (kind === 'nest') {
      flow.pending[0].resolve(reply({ objects: [{ object_key: 'topaz.old', value: { serial_number: 'OLD' } }] }));
      flow.pending[1].resolve(reply({ objects: [{ object_key: 'topaz.new', value: { serial_number: 'NEW' } }] }));
    } else {
      await flow.observations[0][4]({
        traitStates: [{ traitId: { resourceId: 'DEVICE_OLD', traitLabel: 'fixture' }, stateTypes: ['ACCEPTED'], patch: { values: {} } }],
      });
      flow.pending[0].resolve({ status: 16 });
      await flow.observations[1][4]({ observeResponse: [] });
    }
    await setImmediate();
    assert.equal(flow.options.rawData['topaz.old'], undefined);
    assert.equal(flow.options.rawData.DEVICE_OLD, undefined);
    assert.equal(flow.changed.length, 1);
    assert.deepEqual(flow.unauthorised, []);
  });
}

for (let type of [ACCOUNT_TYPE.GOOGLE, ACCOUNT_TYPE.NEST]) {
  test('Google Observe trait selection for account type ' + type, async (context) => {
    let flow = setup(context);
    flow.connection.type = type;
    runtime.types = [
      '.nest.trait.device.Identity',
      '.nest.trait.device.Identity',
      '.weave.trait.Power',
      '.nest.trait.product.camera.Camera',
      '.nest.trait.product.doorbell.Doorbell',
      '.google.trait.product.camera.Camera',
      '.unrelated.Device',
    ].map((fullName) => ({ fullName }));
    await flow.api.connect();
    let traits = flow.observations[0][3].traitTypeParams.map((entry) => entry.traitType);
    assert.equal(new Set(traits).size, traits.length);
    assert.equal(traits.includes('unrelated.Device'), false);
    assert.equal(traits.includes('google.trait.product.camera.Camera'), type === ACCOUNT_TYPE.GOOGLE);
    assert.equal(traits.includes('nest.trait.product.camera.Camera'), type === ACCOUNT_TYPE.GOOGLE);
    assert.equal(traits.includes('nest.trait.product.doorbell.Doorbell'), type === ACCOUNT_TYPE.GOOGLE);
  });
}

test('Google Observe with no schemas or transport does not schedule a restart', async (context) => {
  let flow = setup(context);
  runtime.types = [];
  await flow.api.connect();
  assert.equal(
    flow.logs.some((entry) => entry[0].includes('no observable protobuf traits')),
    true,
  );
  flow.api.disconnect();
  flow.connection.grpcTransport = undefined;
  await flow.api.connect();
  context.mock.timers.tick(120000);
  assert.equal(flow.observations.length, 0);
});

test('Google Observe favours ACCEPTED patches and removes resources through the platform boundary', async (context) => {
  let flow = setup(context);
  flow.options.rawData.DEVICE_OLD = { source: DATA_SOURCE.GOOGLE, value: {} };
  await flow.api.connect();
  await flow.observations[0][4]({
    resourceMetas: [{ resourceId: 'DEVICE_OLD', status: 'REMOVED' }],
    traitStates: [
      {
        traitId: { resourceId: 'DEVICE_NEW', traitLabel: 'fixture' },
        stateTypes: ['ACCEPTED'],
        patch: { values: { '@type': 'metadata', enabled: true } },
      },
      { traitId: { resourceId: 'DEVICE_NEW', traitLabel: 'fixture' }, stateTypes: ['CONFIRMED'], patch: { values: { enabled: false } } },
    ],
  });
  assert.equal(flow.options.rawData.DEVICE_NEW, undefined, 'API publication must not mutate the caller cache');
  assert.ok(flow.options.rawData.DEVICE_OLD);
  assert.deepEqual(flow.changed[0].changes[0], { resourceId: 'DEVICE_OLD', remove: true, notify: true });
  assert.deepEqual(flow.changed[0].changes[1].value.fixture, { enabled: true });
  assert.deepEqual([...flow.changed[0].changes[1].fields], ['fixture']);
});

for (let kind of ['nest', 'google']) {
  test(kind + ' retirement during awaited ingestion cannot mutate a replacement subscription', async (context) => {
    let weather = Promise.withResolvers();
    let flow = setup(context, kind);
    if (kind === 'google') {
      let publish = flow.options.onData;
      flow.options.onData = async (batch) => {
        await weather.promise;
        if (batch.isCurrent() === true) {
          return await publish(batch);
        }
        return false;
      };
    }
    if (kind === 'nest') {
      let fetch = runtime.fetch;
      runtime.fetch = (...args) =>
        String(args[1]).includes('/weather/forecast/') === true
          ? weather.promise.then(() =>
              reply({
                now: {
                  current_temperature: 99,
                  current_humidity: 40,
                  conditions: 'Sunny',
                  wind_direction: 'N',
                  current_wind: 0,
                  sunrise: 1,
                  sunset: 2,
                },
                forecast: { daily: [{ conditions: 'Sunny' }] },
              }),
            )
          : fetch(...args);
    }
    await flow.api.connect();
    let callback;
    if (kind === 'nest') {
      flow.pending[0].resolve(reply({ objects: [{ object_key: 'structure.home', value: { postal_code: '2000', country_code: 'AU' } }] }));
      await setImmediate();
    } else {
      callback = flow.observations[0][4]({
        traitStates: [
          {
            traitId: { resourceId: 'STRUCTURE_HOME', traitLabel: 'structure_location' },
            stateTypes: ['ACCEPTED'],
            patch: { values: { postalCode: { value: '2000' }, countryCode: { value: 'AU' } } },
          },
        ],
      });
    }
    flow.api.disconnect();
    await flow.api.connect();
    weather.resolve({ current_temperature: 99 });
    await callback;
    await setImmediate();
    assert.equal(flow.options.rawData['structure.home'], undefined);
    assert.equal(flow.options.rawData.STRUCTURE_HOME?.value.weather, undefined);
    assert.deepEqual(flow.changed, []);
  });
}

test('Nest subscription keeps bucket allowlisting, account ownership and idempotent start', async (context) => {
  let flow = setup(context, 'nest');
  flow.options.rawData['topaz.other'] = { source: DATA_SOURCE.NEST, connection: 'other', value: {} };
  flow.options.rawData['topaz.injected'] = { source: DATA_SOURCE.NEST, connection: 'account', injected: true, value: {} };
  await flow.api.connect();
  await flow.api.connect();
  assert.deepEqual(flow.requests[0][3].known_bucket_types, NEST_API_BUCKETS);
  assert.equal(flow.requests.length, 1);
  flow.pending[0].resolve(
    reply({
      objects: [
        { object_key: 'topaz.valid', object_revision: 1, object_timestamp: 2, value: { serial_number: 'VALID' } },
        { object_key: 'unsupported.ignored', value: { serial_number: 'IGNORED' } },
      ],
    }),
  );
  await setImmediate();
  let patch = flow.changed[0].changes[0];
  assert.equal(patch.metadata, undefined);
  flow.options.rawData[patch.resourceId] = { source: DATA_SOURCE.NEST, connection: 'account', value: patch.value };
  context.mock.timers.tick(1000);
  assert.deepEqual(flow.requests[1][3].objects, [{ object_key: 'topaz.valid', object_revision: 1, object_timestamp: 2 }]);
  assert.equal(flow.options.rawData['unsupported.ignored'], undefined);
});

for (let kind of ['nest', 'google']) {
  for (let [label, resourceId, values] of [
    ['blank resource', ' ', {}],
    ['non-string resource', 123, {}],
    ['null settings', 'DEVICE_TEST', null],
    ['array settings', 'DEVICE_TEST', []],
    ['boolean settings', 'DEVICE_TEST', true],
  ]) {
    test(kind + ' SET rejects ' + label + ' before resource lookup', async (context) => {
      let flow = setup(context, kind, { getResource: () => assert.fail('Invalid SET reached lookup') });
      await assert.rejects(flow.api.set(resourceId, values), /SET requires valid parameters/);
      assert.equal(flow.requests.length, 0);
    });
  }
  for (let resource of [undefined, null, {}, { source: 'other' }]) {
    test(kind + ' SET rejects unavailable/wrong-source resource: ' + JSON.stringify(resource), async (context) => {
      let flow = setup(context, kind, { getResource: () => resource });
      await assert.rejects(flow.api.set('DEVICE_TEST', { temperature_scale: 'C' }), /SET requires an available/);
      assert.equal(flow.requests.length, 0);
    });
  }
  test(kind + ' SET checks authorisation before looking up a resource', async (context) => {
    let flow = setup(context, kind, { getResource: () => assert.fail('Unauthorised SET reached lookup') });
    flow.connection.authorised = false;
    await assert.rejects(flow.api.set('DEVICE_TEST', {}), /authorised device account/);
  });
}

test('Nest API public SET rejects unavailable input without issuing an HTTP request', async (context) => {
  let flow = setup(context, 'nest');
  await assert.rejects(flow.api.set('topaz.missing', { ntp_green_led_enable: true }), /authorised device account/);
  flow.options.rawData['topaz.valid'] = { source: DATA_SOURCE.NEST, value: {} };
  await assert.rejects(flow.api.set('topaz.valid', null), /authorised device account/);
  flow.connection.authorised = false;
  await assert.rejects(flow.api.set('topaz.valid', { ntp_green_led_enable: true }), /authorised device account/);
  assert.equal(flow.requests.length, 0);
});

for (let missing of ['authorisation', 'resource', 'referer', 'camera host', 'camera auth', 'token', 'key', 'scheme', 'connection']) {
  test('Nest snapshots do not send requests without ' + missing, async (context) => {
    let flow = setup(context, 'nest');
    flow.connection.cameraAPIHost = 'camera.invalid';
    flow.connection.cameraAuth = { key: 'Authorization', value: 'Basic ', token: 'fixture' };
    flow.options.rawData['quartz.TEST'] = { value: { nexus_api_http_server_url: 'https://camera.invalid' } };
    if (missing === 'authorisation') {
      flow.connection.authorised = false;
    }
    if (missing === 'resource') {
      delete flow.options.rawData['quartz.TEST'];
    }
    if (missing === 'referer') {
      delete flow.connection.referer;
    }
    if (missing === 'camera host') {
      delete flow.connection.cameraAPIHost;
    }
    if (missing === 'camera auth') {
      delete flow.connection.cameraAuth;
    }
    if (missing === 'token') {
      delete flow.connection.cameraAuth.token;
    }
    if (missing === 'key') {
      delete flow.connection.cameraAuth.key;
    }
    if (missing === 'scheme') {
      delete flow.connection.cameraAuth.value;
    }
    if (missing === 'connection') {
      flow.options.account = undefined;
    }
    if (['authorisation', 'resource', 'connection'].includes(missing) === true) {
      await assert.rejects(flow.api.get('quartz.TEST', 'camera_snapshot'), /GET requires/);
    } else {
      assert.equal(await flow.api.get('quartz.TEST', 'camera_snapshot'), undefined);
    }
    assert.equal(flow.requests.length, 0);
  });
}

for (let failure of ['transport', 'malformed']) {
  test('Nest property refresh failure preserves cached camera settings: ' + failure, async (context) => {
    let flow = setup(context, 'nest');
    flow.connection.cameraAPIHost = 'camera.invalid';
    flow.connection.cameraAuth = { key: 'Authorization', value: 'Basic ', token: 'fixture' };
    let properties = { 'audio.enabled': true };
    flow.options.rawData['quartz.TEST'] = { source: DATA_SOURCE.NEST, connection: 'account', value: { properties } };
    runtime.fetch = async (method, url) => {
      if (url.includes('/app_launch') === true) {
        return reply({ objects: [{ object_key: 'quartz.TEST', value: { online: true } }] });
      }
      if (failure === 'transport') {
        throw new Error('fixture property outage');
      }
      return reply({});
    };
    await flow.api.connect();
    await setImmediate();
    assert.equal(flow.changed[0].changes[0].value.properties, properties);
    assert.equal(flow.options.rawData['quartz.TEST'].value.online, undefined, 'Only the consumer may commit the patch');
    assert.equal(
      flow.logs.some((entry) => entry[0].includes('error retrieving camera/doorbell properties')),
      true,
    );
    assert.equal(await flow.api.get('quartz.TEST', 'unknown_query'), undefined);
  });
}

for (let outcome of ['committed', 'rejected', 'retired']) {
  test('Google image waiters await the commit acknowledgement: ' + outcome, async (context) => {
    let commit = Promise.withResolvers();
    let flow = setup(context, 'google', { onData: () => commit.promise });
    let received = [];
    let image = { liveImageUrl: 'https://image.invalid/new.jpg' };
    flow.connection.snapshotWaiters.set((value) => received.push(value), 'DEVICE_TEST');
    await flow.api.connect();
    let update = flow.observations[0][4]({
      traitStates: [
        { traitId: { resourceId: 'DEVICE_TEST', traitLabel: 'upload_live_image' }, stateTypes: ['ACCEPTED'], patch: { values: image } },
      ],
    });
    await setImmediate();
    assert.deepEqual(received, []);
    if (outcome === 'retired') {
      flow.api.disconnect();
    }
    commit.resolve(outcome !== 'rejected');
    await update;
    assert.deepEqual(received, outcome === 'committed' ? [image] : outcome === 'retired' ? [undefined] : []);
    assert.equal(flow.connection.snapshotWaiters.size, outcome === 'rejected' ? 1 : 0);
  });
}

for (let cached of [false, true]) {
  test(
    'Nest weather GET uses ' + (cached === true ? 'cached location' : 'incoming location before discovery') + ' before subscriptions start',
    async (context) => {
      let flow = setup(context, 'nest');
      let location = { postal_code: '2000', country_code: 'AU' };
      if (cached === true) {
        flow.options.rawData.STRUCTURE_HOME = { value: { weather: location } };
      }
      let request = flow.api.get('STRUCTURE_HOME', 'location_weather', cached === true ? undefined : { location });
      assert.equal(flow.requests.length, 1);
      assert.equal(new URL(flow.requests[0][1]).pathname, '/api/0.1/weather/forecast/2000,AU');
      flow.pending[0].resolve(
        reply({
          now: {
            current_temperature: 21,
            current_humidity: 40,
            conditions: 'Sunny',
            wind_direction: 'N',
            current_wind: 0,
            sunrise: 1,
            sunset: 2,
          },
          forecast: { daily: [{ conditions: 'Sunny' }] },
        }),
      );
      assert.partialDeepStrictEqual(await request, { current_temperature: 21, postal_code: '2000', country_code: 'AU' });
      if (cached === false) {
        assert.equal(flow.options.rawData.STRUCTURE_HOME, undefined);
      }
      assert.equal(flow.api.getWeather, undefined);
    },
  );
}

for (let kind of ['nest', 'google']) {
  for (let [label, resourceId, key, values] of [
    ['null values', 'DEVICE_TEST', 'camera_snapshot', null],
    ['boolean values', 'DEVICE_TEST', 'camera_snapshot', true],
    ['array values', 'DEVICE_TEST', 'camera_snapshot', []],
    ['string values', 'DEVICE_TEST', 'camera_snapshot', 'invalid'],
    ['blank resource', ' ', 'camera_snapshot', {}],
    ['non-string resource', 123, 'camera_snapshot', {}],
    ['blank key', 'DEVICE_TEST', ' ', {}],
    ['non-string key', 'DEVICE_TEST', null, {}],
  ]) {
    test(kind + ' GET rejects ' + label + ' before lookup or network work', async (context) => {
      let flow = setup(context, kind, { getResource: () => assert.fail('Invalid GET reached resource lookup') });
      await assert.rejects(flow.api.get(resourceId, key, values), /GET requires valid query parameters/);
      assert.equal(flow.requests.length, 0);
    });
  }
  for (let key of ['camera_snapshot', 'camera_events', 'location_weather']) {
    test(kind + ' GET rejects missing resources for ' + key, async (context) => {
      let flow = setup(context, kind);
      await assert.rejects(flow.api.get('DEVICE_MISSING', key), /GET requires an available resource/);
      assert.equal(flow.requests.length, 0);
    });
    test(kind + ' GET rejects unauthorised accounts for ' + key, async (context) => {
      let flow = setup(context, kind, { getResource: () => assert.fail('Unauthorised GET reached resource lookup') });
      flow.connection.authorised = false;
      await assert.rejects(
        flow.api.get('DEVICE_TEST', key, { location: { postal_code: '2000', country_code: 'AU' } }),
        /authorised account/,
      );
      assert.equal(flow.requests.length, 0);
    });
  }
  for (let key of ['camera_snapshot', 'camera_events']) {
    for (let missing of ['device type', 'credentials']) {
      test(kind + ' GET rejects unavailable ' + key + ' at entry: ' + missing, async (context) => {
        let flow = setup(context, kind);
        let id = kind === 'nest' ? 'quartz.TEST' : 'DEVICE_TEST';
        flow.connection.cameraAPIHost = 'camera.invalid';
        flow.connection.cameraAuth = { key: 'Authorization', value: 'Basic ', token: 'fixture' };
        flow.connection.grpcTransport.command = async () => assert.fail('Unavailable camera query reached the transport');
        if (missing === 'device type') {
          id = 'structure.home';
        }
        if (missing === 'credentials') {
          if (kind === 'nest') {
            flow.connection.cameraAuth = undefined;
          } else {
            flow.connection.grpcTransport = undefined;
          }
        }
        flow.options.rawData[id] = {
          value: { nexus_api_http_server_url: 'https://camera.invalid', device_info: { typeName: 'google.resource.SpencerResource' } },
        };
        assert.deepEqual(await flow.api.get(id, key), key === 'camera_events' ? [] : undefined);
        assert.equal(flow.requests.length, 0);
        assert.equal(flow.connection.snapshotWaiters.size, 0);
      });
    }
  }
}

test('Nest account invalidation during camera properties prevents later bucket requests and publication', async (context) => {
  let flow = setup(context, 'nest');
  flow.connection.cameraAPIHost = 'camera.invalid';
  flow.connection.cameraAuth = { key: 'Authorization', value: 'Basic ', token: 'fixture' };
  let propertiesRequested = [];
  runtime.fetch = async (method, url) => {
    if (url.includes('/app_launch') === true) {
      return reply({
        objects: [
          { object_key: 'quartz.FIRST', value: { online: true } },
          { object_key: 'quartz.SECOND', value: { online: true } },
        ],
      });
    }
    propertiesRequested.push(url);
    flow.connection.authorised = false;
    return reply({ items: [{ properties: { 'audio.enabled': true } }] });
  };
  await flow.api.connect();
  await setImmediate();
  assert.equal(propertiesRequested.length, 1);
  assert.equal(new URL(propertiesRequested[0]).searchParams.get('uuid'), 'FIRST');
  assert.deepEqual(flow.changed, []);
  context.mock.timers.tick(120000);
  assert.equal(propertiesRequested.length, 1);
});

test('Google publishes structure location without fetching or adding REST weather', async (context) => {
  let flow = setup(context, 'google');
  let location = { postalCode: { value: '2000' }, countryCode: { value: 'AU' } };
  await flow.api.connect();
  await flow.observations[0][4]({
    traitStates: [
      {
        traitId: { resourceId: 'STRUCTURE_HOME', traitLabel: 'structure_location' },
        stateTypes: ['ACCEPTED'],
        patch: { values: location },
      },
    ],
  });
  assert.deepEqual(flow.changed[0].changes[0].value, { structure_location: location });
  assert.deepEqual([...flow.changed[0].changes[0].fields], ['structure_location']);
  assert.equal(flow.requests.length, 0);
  flow.options.rawData.STRUCTURE_HOME = { value: { structure_location: location } };
  assert.equal(await flow.api.get('STRUCTURE_HOME', 'location_weather'), undefined);
  await assert.rejects(
    flow.api.get('STRUCTURE_MISSING', 'location_weather', { location: { postal_code: '2000', country_code: 'AU' } }),
    /GET requires an available resource/,
  );
});

test('Nest waits for commit acknowledgement before subscribing with its own bucket revisions', async (context) => {
  let commit = Promise.withResolvers();
  let flow = setup(context, 'nest', { onData: () => commit.promise });
  await flow.api.connect();
  flow.pending[0].resolve(
    reply({ updated_buckets: [{ object_key: 'topaz.TEST', object_revision: 1, object_timestamp: 10, value: { smoke_status: 0 } }] }),
  );
  await setImmediate();
  context.mock.timers.tick(10000);
  assert.equal(flow.requests.length, 1, 'the next poll waits for the consumer to store the response');
  commit.resolve(true);
  await setImmediate();
  // Subscription state must not depend on a consumer retaining or changing raw metadata.
  flow.options.rawData['topaz.UNRELATED'] = { source: DATA_SOURCE.NEST, connection: 'account', object_revision: 999 };
  context.mock.timers.tick(1000);
  assert.deepEqual(flow.requests[1][3].objects, [{ object_key: 'topaz.TEST', object_revision: 1, object_timestamp: 10 }]);
  assert.equal(flow.options.rawData['topaz.TEST'], undefined);
});

for (let outcome of ['false', 'reject']) {
  test('Nest retains incremental revisions after a ' + outcome + ' commit acknowledgement', async (context) => {
    let flow = setup(context, 'nest');
    await flow.api.connect();
    flow.pending[0].resolve(
      reply({ updated_buckets: [{ object_key: 'topaz.TEST', object_revision: 1, object_timestamp: 10, value: {} }] }),
    );
    await setImmediate();
    context.mock.timers.tick(1000);
    flow.options.onData = async () => {
      if (outcome === 'reject') {
        throw new Error('Fixture commit failed');
      }
      return false;
    };
    flow.pending[1].resolve(reply({ objects: [{ object_key: 'topaz.TEST', object_revision: 2, object_timestamp: 20, value: {} }] }));
    await setImmediate();
    context.mock.timers.tick(5000);
    assert.deepEqual(flow.requests[2][3].objects, [{ object_key: 'topaz.TEST', object_revision: 1, object_timestamp: 10 }]);
    flow.options.onData = async () => true;
    flow.pending[2].resolve(
      reply({
        objects: [
          { object_key: 'topaz.TEST', object_revision: 3, object_timestamp: 30, value: {} },
          { object_key: 'topaz.TEST', object_revision: 4, object_timestamp: 40, value: {} },
        ],
      }),
    );
    await setImmediate();
    context.mock.timers.tick(1000);
    assert.deepEqual(flow.requests[3][3].objects, [{ object_key: 'topaz.TEST', object_revision: 4, object_timestamp: 40 }]);
  });

  test('Nest retries full discovery after a ' + outcome + ' initial commit acknowledgement', async (context) => {
    let flow = setup(context, 'nest', {
      onData: async () => {
        if (outcome === 'reject') {
          throw new Error('Fixture discovery commit failed');
        }
        return false;
      },
    });
    await flow.api.connect();
    flow.pending[0].resolve(
      reply({ updated_buckets: [{ object_key: 'topaz.TEST', object_revision: 1, object_timestamp: 10, value: {} }] }),
    );
    await setImmediate();
    context.mock.timers.tick(5000);
    assert.equal(flow.requests[1][3].objects, undefined);
    assert.deepEqual(flow.requests[1][3].known_bucket_types, NEST_API_BUCKETS);
    flow.options.onData = async () => true;
    flow.pending[1].resolve(
      reply({ updated_buckets: [{ object_key: 'topaz.TEST', object_revision: 2, object_timestamp: 20, value: {} }] }),
    );
    await setImmediate();
    context.mock.timers.tick(1000);
    assert.deepEqual(flow.requests[2][3].objects, [{ object_key: 'topaz.TEST', object_revision: 2, object_timestamp: 20 }]);
  });
}

for (let outcome of ['resolve', 'reject']) {
  test('a stopped Nest run cannot change replacement revisions after its commit promise ' + outcome + 's', async (context) => {
    let commit = Promise.withResolvers();
    let flow = setup(context, 'nest', { onData: () => commit.promise });
    await flow.api.connect();
    flow.pending[0].resolve(
      reply({ updated_buckets: [{ object_key: 'topaz.TEST', object_revision: 1, object_timestamp: 10, value: {} }] }),
    );
    await setImmediate();
    flow.api.disconnect();
    flow.options.onData = async () => true;
    await flow.api.connect();
    assert.equal(flow.requests[1][3].objects, undefined, 'a new run always rediscovers buckets');
    flow.pending[1].resolve(
      reply({ updated_buckets: [{ object_key: 'topaz.TEST', object_revision: 9, object_timestamp: 90, value: {} }] }),
    );
    await setImmediate();
    if (outcome === 'resolve') {
      commit.resolve(true);
    } else {
      commit.reject(new Error('Fixture retired commit failed'));
    }
    await setImmediate();
    context.mock.timers.tick(1000);
    assert.equal(flow.requests.length, 3, 'only the new run schedules another request');
    assert.deepEqual(flow.requests[2][3].objects, [{ object_key: 'topaz.TEST', object_revision: 9, object_timestamp: 90 }]);
  });
}

for (let objects of [[], [{ object_key: 'unsupported.ignored', object_revision: 1, object_timestamp: 10, value: {} }]]) {
  test(
    'Nest repeats full discovery when the acknowledged response has ' + (objects.length === 0 ? 'no buckets' : 'only unsupported buckets'),
    async (context) => {
      let flow = setup(context, 'nest');
      await flow.api.connect();
      flow.pending[0].resolve(reply({ updated_buckets: objects }));
      await setImmediate();
      context.mock.timers.tick(1000);
      assert.equal(new URL(flow.requests[1][1]).pathname.endsWith('/app_launch'), true);
      assert.equal(flow.requests[1][3].objects, undefined);
      assert.deepEqual(flow.requests[1][3].known_bucket_types, NEST_API_BUCKETS);
      flow.pending[1].resolve(
        reply({ updated_buckets: [{ object_key: 'topaz.TEST', object_revision: 2, object_timestamp: 20, value: {} }] }),
      );
      await setImmediate();
      context.mock.timers.tick(1000);
      assert.equal(new URL(flow.requests[2][1]).pathname, '/v5/subscribe');
      assert.deepEqual(flow.requests[2][3].objects, [{ object_key: 'topaz.TEST', object_revision: 2, object_timestamp: 20 }]);
    },
  );
}

for (let active of [true, false]) {
  test('Nest sensor selection finds its parent in acknowledged API buckets: ' + active, async (context) => {
    let flow = setup(context, 'nest');
    flow.options.rawData['kryptonite.SENSOR'] = { source: DATA_SOURCE.NEST, value: {} };
    flow.options.rawData['rcs_settings.PARENT'] = {
      source: DATA_SOURCE.NEST,
      value: { associated_rcs_sensors: ['kryptonite.SENSOR'] },
    };
    await flow.api.connect();
    flow.pending[0].resolve(
      reply({
        objects: [
          { object_key: 'kryptonite.SENSOR', object_revision: 1, object_timestamp: 10, value: {} },
          { object_key: 'rcs_settings.PARENT', object_revision: 1, object_timestamp: 10, value: {} },
        ],
      }),
    );
    await setImmediate();
    let write = flow.api.set('kryptonite.SENSOR', { active_sensor: active });
    assert.deepEqual(JSON.parse(flow.requests[1][3]).objects, [
      {
        object_key: 'rcs_settings.PARENT',
        op: 'MERGE',
        value: {
          active_rcs_sensors: active === true ? ['kryptonite.SENSOR'] : [],
          rcs_control_setting: active === true ? 'OVERRIDE' : 'OFF',
        },
      },
    ]);
    flow.pending[1].resolve(reply({ objects: [{}] }));
    await write;
    delete flow.options.rawData['rcs_settings.PARENT'];
    await assert.rejects(flow.api.set('kryptonite.SENSOR', { active_sensor: active }), AggregateError);
    assert.equal(flow.requests.length, 2);
  });
}
