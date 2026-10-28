// Follow real GET dispatch to weather, camera history and snapshot request paths with deterministic cloud responses.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { platformHarness } from './helpers/platform-harness.js';
import { DATA_SOURCE } from '../src/consts.js';

let weather = {
  now: {
    current_temperature: 21.2,
    current_humidity: 45,
    conditions: 'Sunny',
    wind_direction: 'N',
    current_wind: 12,
    sunrise: 100,
    sunset: 200,
  },
  forecast: { daily: [{ conditions: 'Cloudy' }] },
  display_city: 'Fixture City',
};

for (let source of [DATA_SOURCE.NEST, DATA_SOURCE.GOOGLE]) {
  test('platform routes weather query parameters for ' + source + ' resources directly to Nest REST', async (context) => {
    let id = source === DATA_SOURCE.NEST ? 'structure.home' : 'STRUCTURE_HOME';
    let flow = await platformHarness(context, {
      source,
      id,
      value: { fixture: {} },
      fetch: async () => ({ json: async () => weather }),
    });
    let result = await flow.device.get({ uuid: id, location_weather: { location: { postal_code: '2000', country_code: 'AU' } } });
    assert.equal(result.location_weather.current_temperature, weather.now.current_temperature);
    assert.equal(result.location_weather.postal_code, '2000');
    assert.equal(new URL(flow.requests.at(-1)[1]).pathname, '/api/0.1/weather/forecast/2000,AU');
    assert.equal(flow.raw[id].value.weather, undefined, 'Query parameters must not change the committed resource');
  });
}

for (let [label, response, expected] of [
  [
    'complete',
    weather,
    { current_temperature: 21.2, current_humidity: 45, condition: 'Sunny', station: 'Fixture City', forecast: 'Cloudy' },
  ],
  ['API error', { error: 'Unavailable' }, undefined],
  ['missing fields', { now: {} }, undefined],
]) {
  test('platform weather GET: ' + label, async (context) => {
    let flow = await platformHarness(context, {
      value: { weather: { postal_code: '2000', country_code: 'AU' } },
      fetch: async () => ({ json: async () => response }),
    });
    let result = await flow.device.get({ uuid: 'DEVICE_TEST', location_weather: true });
    if (expected === undefined) {
      assert.equal(result.location_weather, undefined);
    } else {
      assert.partialDeepStrictEqual(result.location_weather, expected);
    }
    assert.equal(new URL(flow.requests.at(-1)[1]).pathname, '/api/0.1/weather/forecast/2000,AU');
  });
}
for (let [label, override] of [
  ['missing token', { token: '' }],
  ['unauthorised', { authorised: false }],
]) {
  test('weather GET skips unavailable account: ' + label, async (context) => {
    let flow = await platformHarness(context, { value: { weather: { postal_code: '2000', country_code: 'AU' } } });
    Object.assign(flow.connection, override);
    let before = flow.requests.length;
    assert.equal((await flow.device.get({ uuid: 'DEVICE_TEST', location_weather: true })).location_weather, undefined);
    assert.equal(flow.requests.length, before);
  });
}
for (let [label, response] of [
  ['deadline', { status: 4 }],
  ['request timeout', { code: 'REQUEST_TIMEOUT' }],
  ['no response', {}],
  ['incomplete', { data: [{ traitOperations: [{ progress: 'PENDING' }] }] }],
  ['complete without events', { data: [{ traitOperations: [{ progress: 'COMPLETE' }] }] }],
]) {
  test('Google camera history returns an empty list for ' + label, async (context) => {
    let flow = await platformHarness(context);
    flow.connection.grpcTransport.command = async () => response;
    assert.deepEqual((await flow.device.get({ uuid: 'DEVICE_TEST', camera_events: true })).camera_events, []);
  });
}
test('Google camera history normalises timestamps, zones and event enums and orders newest first', async (context) => {
  let flow = await platformHarness(context);
  flow.connection.grpcTransport.command = async () => ({
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
                      eventId: 'older',
                      startTime: { seconds: '10', nanos: '500000000' },
                      endTime: { seconds: '11', nanos: '0' },
                      activityZone: [{ zoneIndex: 2 }, { internalIndex: 4 }],
                      eventType: ['EVENT_PERSON', 'EVENT_FUTURE_TYPE', 'OTHER'],
                    },
                    { eventId: 'newer', startTime: { seconds: '20', nanos: '0' }, endTime: { seconds: '21', nanos: '0' } },
                  ],
                },
              },
            },
          },
        ],
      },
    ],
  });
  let events = (await flow.device.get({ uuid: 'DEVICE_TEST', camera_events: true })).camera_events;
  assert.deepEqual(events, [
    { id: 'newer', start_time: 20000, playback_time: 20000, end_time: 21000, zone_ids: [], types: [] },
    { id: 'older', start_time: 10500, playback_time: 10500, end_time: 11000, zone_ids: [2, 4], types: ['person', 'future-type'] },
  ]);
});
for (let [label, response] of [
  ['empty zones', [{ id: 'a', start_time: 1, zone_ids: [] }]],
  ['zone zero', [{ id: 'a', start_time: 1, zone_ids: [0, 2] }]],
  ['missing zones', [{ id: 'a', start_time: 1 }]],
  ['invalid JSON shape', { status_detail: 'Unavailable' }],
]) {
  test('retained REST camera history: ' + label, async (context) => {
    let flow = await platformHarness(context, {
      source: DATA_SOURCE.NEST,
      id: 'quartz.TEST',
      value: { nexus_api_http_server_url: 'https://nexus.invalid' },
      fetch: async () => ({ json: async () => response }),
    });
    let events = (await flow.device.get({ uuid: 'quartz.TEST', camera_events: true })).camera_events;
    assert.deepEqual(
      events.map((event) => event.zone_ids),
      Array.isArray(response) === true ? [label === 'zone zero' ? [1, 2] : [1]] : [],
    );
    assert.equal(flow.requests.at(-1)[2].retry, 1);
  });
}
for (let code of ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UNEXPECTED']) {
  test('REST camera history handles transport error ' + code, async (context) => {
    let flow = await platformHarness(context, {
      source: DATA_SOURCE.NEST,
      id: 'quartz.TEST',
      value: { nexus_api_http_server_url: 'https://nexus.invalid' },
      fetch: async () => {
        throw Object.assign(new Error(code), { code });
      },
    });
    assert.deepEqual((await flow.device.get({ uuid: 'quartz.TEST', camera_events: true })).camera_events, []);
  });
}
for (let [label, image, fail] of [
  ['image', Buffer.from([1, 2, 3]), false],
  ['empty', Buffer.alloc(0), false],
  ['error', undefined, true],
]) {
  test('Nest snapshot GET handles ' + label, async (context) => {
    let flow = await platformHarness(context, {
      source: DATA_SOURCE.NEST,
      id: 'quartz.TEST',
      value: { nexus_api_http_server_url: 'https://nexus.invalid' },
      fetch: async () => {
        if (fail === true) {
          throw new Error('Fixture snapshot fetch failed');
        }
        return { arrayBuffer: async () => image };
      },
    });
    let result = (await flow.device.get({ uuid: 'quartz.TEST', camera_snapshot: true })).camera_snapshot;
    assert.deepEqual(result, image?.length > 0 ? image : undefined);
  });
}
for (let [label, url] of [
  ['cached URL', 'https://image.invalid/old.jpg'],
  ['no URL', ''],
]) {
  test('Google snapshot falls back to ' + label + ' after rejected refresh', async (context) => {
    let image = Buffer.from([5, 6, 7]);
    let flow = await platformHarness(context, {
      value: {
        device_info: { typeName: 'google.resource.SpencerResource' },
        upload_live_image: { liveImageUrl: url },
      },
      fetch: async () => ({ arrayBuffer: async () => image }),
    });
    flow.connection.grpcTransport.command = async () => ({ status: 14 });
    let result = (await flow.device.get({ uuid: 'DEVICE_TEST', camera_snapshot: true })).camera_snapshot;
    assert.deepEqual(result, url === '' ? undefined : image);
    assert.equal(flow.connection.snapshotWaiters.size, 0);
  });
}
test('Google snapshot observes a fresh image, clears its waiter and fetches the new URL', async (context) => {
  let flow = await platformHarness(context, {
    value: {
      device_info: { typeName: 'google.resource.SpencerResource' },
      upload_live_image: { liveImageUrl: 'https://image.invalid/old.jpg' },
    },
    fetch: async () => ({ arrayBuffer: async () => Buffer.from([9]) }),
  });
  let delivered;
  flow.connection.grpcTransport.command = async () => {
    delivered = flow.send('DEVICE_TEST', { upload_live_image: { liveImageUrl: 'https://image.invalid/new.jpg' } });
    return { status: 0, data: [{ traitOperations: [{ progress: 'COMPLETE', event: { event: { status: 'STATUS_SUCCESSFUL' } } }] }] };
  };
  assert.deepEqual((await flow.device.get({ uuid: 'DEVICE_TEST', camera_snapshot: true })).camera_snapshot, Buffer.from([9]));
  await delivered;
  assert.equal(flow.connection.snapshotWaiters.size, 0);
  assert.equal(flow.requests.at(-1)[1], 'https://image.invalid/new.jpg');
});
test('snapshot command rejection cleans its waiter and GET degrades safely', async (context) => {
  let flow = await platformHarness(context, { value: { device_info: { typeName: 'google.resource.SpencerResource' } } });
  flow.connection.grpcTransport.command = async () => {
    throw new Error('Fixture command failure');
  };
  assert.equal((await flow.device.get({ uuid: 'DEVICE_TEST', camera_snapshot: true })).camera_snapshot, undefined);
  assert.equal(flow.connection.snapshotWaiters.size, 0);
  delete flow.raw.DEVICE_TEST;
  assert.equal(await flow.device.get({ uuid: 'DEVICE_TEST', unknown: true }), undefined);
});

test('Google snapshot times out its Observe wait and fetches the previously available image', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  let flow = await platformHarness(context, {
    value: {
      device_info: { typeName: 'google.resource.SpencerResource' },
      upload_live_image: { liveImageUrl: 'https://image.invalid/cached.jpg' },
    },
    fetch: async () => ({ arrayBuffer: async () => Buffer.from([4]) }),
  });
  let started = Promise.withResolvers();
  flow.connection.grpcTransport.command = async () => {
    started.resolve();
    return { data: [{ traitOperations: [{ progress: 'COMPLETE', event: { event: { status: 'STATUS_SUCCESSFUL' } } }] }] };
  };
  let request = flow.device.get({ uuid: 'DEVICE_TEST', camera_snapshot: true });
  await started.promise;
  let replayed = flow.send('DEVICE_TEST', { upload_live_image: { liveImageUrl: 'https://image.invalid/cached.jpg' } });
  await setImmediate();
  assert.equal(flow.connection.snapshotWaiters.size, 1);
  context.mock.timers.tick(3000);
  assert.deepEqual((await request).camera_snapshot, Buffer.from([4]));
  await replayed;
  assert.equal(flow.connection.snapshotWaiters.size, 0);
  assert.equal(
    flow.logs.some((args) => String(args[1]).includes('using the last available image')),
    false,
  );
});

test('overall snapshot timeout lets HomeKit continue when a cloud command never settles', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  let flow = await platformHarness(context, {
    value: {
      device_info: { typeName: 'google.resource.SpencerResource' },
      upload_live_image: { liveImageUrl: 'https://image.invalid/cached.jpg' },
    },
  });
  let pending = Promise.withResolvers();
  let started = Promise.withResolvers();
  flow.connection.grpcTransport.command = () => {
    started.resolve();
    return pending.promise;
  };
  let request = flow.device.get({ uuid: 'DEVICE_TEST', camera_snapshot: true });
  await started.promise;
  context.mock.timers.tick(7000);
  assert.equal((await request).camera_snapshot, undefined);
  assert.equal(flow.connection.snapshotWaiters.size, 0);
  let requests = flow.requests.length;
  // A late successful reply must not start another Observe wait or fetch a discarded image.
  pending.resolve({
    status: 0,
    data: [{ traitOperations: [{ progress: 'COMPLETE', event: { event: { status: 'STATUS_SUCCESSFUL' } } }] }],
  });
  await setImmediate();
  context.mock.timers.tick(3000);
  await setImmediate();
  assert.equal(flow.requests.length, requests);
  assert.equal(flow.connection.snapshotWaiters.size, 0);
});

test('snapshot expiry removes only its own waiter while an overlapping request completes', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  let flow = await platformHarness(context, {
    value: { device_info: { typeName: 'google.resource.SpencerResource' } },
    fetch: async () => ({ arrayBuffer: async () => Buffer.from([8]) }),
  });
  let commands = [];
  flow.connection.grpcTransport.command = (...args) => {
    assert.equal(args[4].timeout, 7000);
    let command = Promise.withResolvers();
    commands.push(command);
    return command.promise;
  };
  // Exercise the account client directly: HomeKitDevice serialises GETs for one accessory.
  let first = flow.connection.googleAPI.get('DEVICE_TEST', 'camera_snapshot').catch(() => undefined);
  await setImmediate();
  context.mock.timers.tick(1000);
  let second = flow.connection.googleAPI.get('DEVICE_TEST', 'camera_snapshot');
  await setImmediate();
  assert.equal(flow.connection.snapshotWaiters.size, 2);
  context.mock.timers.tick(6000);
  assert.equal(await first, undefined);
  assert.equal(flow.connection.snapshotWaiters.size, 1);
  await flow.send('DEVICE_TEST', { upload_live_image: { liveImageUrl: 'https://image.invalid/fresh.jpg' } });
  let success = { status: 0, data: [{ traitOperations: [{ progress: 'COMPLETE', event: { event: { status: 'STATUS_SUCCESSFUL' } } }] }] };
  commands[1].resolve(success);
  assert.deepEqual(await second, Buffer.from([8]));
  assert.equal(flow.connection.snapshotWaiters.size, 0);
  let requests = flow.requests.length;
  commands[0].resolve(success);
  await setImmediate();
  assert.equal(flow.requests.length, requests);
});

test('overall snapshot deadline aborts an in-flight HTTP image fetch', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  let started = Promise.withResolvers();
  let signal;
  let flow = await platformHarness(context, {
    value: {
      device_info: { typeName: 'google.resource.SpencerResource' },
      upload_live_image: { liveImageUrl: 'https://image.invalid/cached.jpg' },
    },
    fetch: async (method, url, options) => {
      signal = options.signal;
      started.resolve();
      return await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  flow.connection.grpcTransport.command = async () => ({ status: 14 });
  let request = flow.device.get({ uuid: 'DEVICE_TEST', camera_snapshot: true });
  await started.promise;
  assert.equal(signal.aborted, false);
  context.mock.timers.tick(7000);
  assert.equal((await request).camera_snapshot, undefined);
  assert.equal(signal.aborted, true);
  assert.equal(flow.connection.snapshotWaiters.size, 0);
});

for (let [label, before, fresh] of [
  [
    'new timestamp at the same URL',
    { liveImageUrl: 'https://image.invalid/old.jpg', timestamp: { seconds: 100, nanos: 100 } },
    { liveImageUrl: 'https://image.invalid/old.jpg', timestamp: { seconds: 100, nanos: 101 } },
  ],
  [
    'new timestamp and URL',
    { liveImageUrl: 'https://image.invalid/old.jpg', timestamp: { seconds: 100, nanos: 100 } },
    { liveImageUrl: 'https://image.invalid/new.jpg', timestamp: { seconds: 101 } },
  ],
  ['changed URL without timestamps', { liveImageUrl: 'https://image.invalid/old.jpg' }, { liveImageUrl: 'https://image.invalid/new.jpg' }],
]) {
  test('Google snapshot ignores stale Observe updates until ' + label, async (context) => {
    context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
    let image = Buffer.from([8]);
    let flow = await platformHarness(context, {
      value: { device_info: { typeName: 'google.resource.SpencerResource' }, upload_live_image: before },
      fetch: async () => ({ arrayBuffer: async () => image }),
    });
    let started = Promise.withResolvers();
    flow.connection.grpcTransport.command = async () => {
      started.resolve();
      return { status: 0, data: [{ traitOperations: [{ progress: 'COMPLETE', event: { event: { status: 'STATUS_SUCCESSFUL' } } }] }] };
    };
    let request = flow.device.get({ uuid: 'DEVICE_TEST', camera_snapshot: true });
    await started.promise;
    let fetches = flow.requests.length;
    let delivered = [];
    let stale = [before, { liveImageUrl: '', timestamp: { seconds: 102 } }];
    if (before.timestamp !== undefined) {
      stale.push(
        { liveImageUrl: 'https://image.invalid/replayed.jpg', timestamp: before.timestamp },
        { liveImageUrl: 'https://image.invalid/older.jpg', timestamp: { seconds: 99 } },
      );
    }
    for (let update of stale) {
      delivered.push(flow.send('DEVICE_TEST', { upload_live_image: update }));
      await setImmediate();
      assert.equal(flow.connection.snapshotWaiters.size, 1, 'A stale or empty update must not finish the snapshot wait');
      assert.equal(flow.requests.length, fetches, 'Do not fetch the cached image while a fresh update can still arrive');
    }
    delivered.push(flow.send('DEVICE_TEST', { upload_live_image: fresh }));
    assert.deepEqual((await request).camera_snapshot, image);
    await Promise.all(delivered);
    assert.equal(flow.requests.at(-1)[1], fresh.liveImageUrl);
    assert.equal(flow.connection.snapshotWaiters.size, 0);
  });
}

test('connection cleanup can release a snapshot freshness waiter without an image update', async (context) => {
  let image = Buffer.from([3]);
  let flow = await platformHarness(context, {
    value: {
      device_info: { typeName: 'google.resource.SpencerResource' },
      upload_live_image: { liveImageUrl: 'https://image.invalid/cached.jpg', timestamp: { seconds: 100 } },
    },
    fetch: async () => ({ arrayBuffer: async () => image }),
  });
  let started = Promise.withResolvers();
  flow.connection.grpcTransport.command = async () => {
    started.resolve();
    return { status: 0, data: [{ traitOperations: [{ progress: 'COMPLETE', event: { event: { status: 'STATUS_SUCCESSFUL' } } }] }] };
  };
  let request = flow.device.get({ uuid: 'DEVICE_TEST', camera_snapshot: true });
  await started.promise;
  for (let waiter of flow.connection.snapshotWaiters.keys()) {
    waiter();
  }
  flow.connection.snapshotWaiters.clear();
  assert.deepEqual((await request).camera_snapshot, image);
  assert.equal(flow.connection.snapshotWaiters.size, 0);
});

test('Google snapshot fetches its accepted image even if a later cache update replays an old URL', async (context) => {
  let flow = await platformHarness(context, {
    value: {
      device_info: { typeName: 'google.resource.SpencerResource' },
      upload_live_image: { liveImageUrl: 'https://image.invalid/old.jpg', timestamp: { seconds: 1 } },
    },
    fetch: async () => ({ arrayBuffer: async () => Buffer.from([9]) }),
  });
  flow.connection.grpcTransport.command = async () => {
    await flow.send('DEVICE_TEST', {
      upload_live_image: { liveImageUrl: 'https://image.invalid/new.jpg', timestamp: { seconds: 2 } },
    });
    await flow.send('DEVICE_TEST', {
      upload_live_image: { liveImageUrl: 'https://image.invalid/old.jpg', timestamp: { seconds: 1 } },
    });
    return { data: [{ traitOperations: [{ progress: 'COMPLETE', event: { event: { status: 'STATUS_SUCCESSFUL' } } }] }] };
  };
  assert.deepEqual((await flow.device.get({ uuid: 'DEVICE_TEST', camera_snapshot: true })).camera_snapshot, Buffer.from([9]));
  assert.equal(flow.requests.at(-1)[1], 'https://image.invalid/new.jpg');
  assert.equal(flow.connection.snapshotWaiters.size, 0);
});

test('System enriches a newly discovered Google structure through Nest REST and refreshes its weather location', async (context) => {
  let location = { postalCode: { value: '2000' }, countryCode: { value: 'AU' } };
  let flow = await platformHarness(context, {
    id: 'STRUCTURE_HOME',
    value: { structure_location: location },
    fetch: async () => ({ json: async () => weather }),
  });
  assert.deepEqual(flow.raw.STRUCTURE_HOME.value.structure_location, location);
  assert.partialDeepStrictEqual(flow.raw.STRUCTURE_HOME.value.weather, {
    postal_code: '2000',
    country_code: 'AU',
    current_temperature: 21.2,
  });
  let forecasts = () => flow.requests.filter((request) => String(request[1]).includes('/weather/forecast/') === true);
  assert.equal(forecasts().length, 1);
  assert.equal(forecasts()[0][2].headers.Authorization, 'Basic fixture-token');
  await flow.send('STRUCTURE_HOME', { fixture: { unrelated: true } });
  assert.equal(forecasts().length, 1, 'unrelated traits do not request another forecast');
  await flow.send('STRUCTURE_HOME', {
    structure_location: { postalCode: { value: '3000' }, countryCode: { value: 'AU' } },
  });
  assert.equal(flow.raw.STRUCTURE_HOME.value.weather.postal_code, '3000');
  assert.equal(new URL(forecasts().at(-1)[1]).pathname, '/api/0.1/weather/forecast/3000,AU');
  context.mock.method(flow.connection.googleAPI, 'get', () => assert.fail('Weather must route directly to NestAPI'));
  let result = await flow.device.get({ uuid: 'STRUCTURE_HOME', location_weather: true });
  assert.equal(result.location_weather.postal_code, '3000');
});

for (let [label, id, location] of [
  ['missing postal code', 'STRUCTURE_HOME', { countryCode: { value: 'AU' } }],
  ['blank country code', 'STRUCTURE_HOME', { postalCode: { value: '2000' }, countryCode: { value: ' ' } }],
  ['device location', 'DEVICE_TEST', { postalCode: { value: '2000' }, countryCode: { value: 'AU' } }],
]) {
  test('System commits Google location without a weather request for ' + label, async (context) => {
    let flow = await platformHarness(context, { id, value: { structure_location: location } });
    assert.deepEqual(flow.raw[id].value.structure_location, location);
    assert.equal(flow.raw[id].value.weather, undefined);
    assert.equal(
      flow.requests.some((request) => String(request[1]).includes('/weather/forecast/') === true),
      false,
    );
  });
}

for (let failure of ['backend', 'client', 'missing client']) {
  test('weather enrichment preserves cached forecast and commits Google traits after ' + failure + ' failure', async (context) => {
    let cached = { postal_code: '2000', country_code: 'AU', current_temperature: 17 };
    let flow = await platformHarness(context, {
      id: 'STRUCTURE_HOME',
      value: { weather: cached },
      fetch: async () => {
        throw new Error('Fixture weather outage');
      },
    });
    if (failure === 'client') {
      context.mock.method(flow.connection.nestAPI, 'get', async () => {
        throw new Error('Fixture unavailable account');
      });
    } else if (failure === 'missing client') {
      let client = flow.connection.nestAPI;
      flow.connection.nestAPI = undefined;
      context.after(() => client.disconnect());
    }
    let location = { postalCode: { value: '3000' }, countryCode: { value: 'AU' } };
    await flow.send('STRUCTURE_HOME', { structure_location: location });
    assert.deepEqual(flow.raw.STRUCTURE_HOME.value.structure_location, location);
    assert.deepEqual(flow.raw.STRUCTURE_HOME.value.weather, cached);
  });
}

test('a retired Observe batch cannot commit location or weather after its REST query completes', async (context) => {
  let pending = Promise.withResolvers();
  let flow = await platformHarness(context, {
    id: 'STRUCTURE_HOME',
    value: { fixture: { current: true } },
    fetch: () => pending.promise,
  });
  let update = flow.send('STRUCTURE_HOME', {
    structure_location: { postalCode: { value: '2000' }, countryCode: { value: 'AU' } },
  });
  await setImmediate();
  assert.equal(
    flow.requests.some((request) => String(request[1]).includes('/weather/forecast/') === true),
    true,
  );
  flow.connection.googleAPI.disconnect();
  pending.resolve({ json: async () => weather });
  await update;
  assert.deepEqual(flow.raw.STRUCTURE_HOME.value, { fixture: { current: true } });
});
