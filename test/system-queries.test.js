// Follow real GET dispatch to weather, camera history and snapshot request paths with deterministic cloud responses.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { platformHarness } from './helpers/platform-harness.js';
import { runtime } from './helpers/platform-runtime.js';
import { getProtoType } from '../src/protobuf.js';
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
    let timers = new Set(runtime.timers);
    let result = (await flow.device.get({ uuid: 'quartz.TEST', camera_snapshot: true })).camera_snapshot;
    assert.deepEqual(result, image?.length > 0 ? image : undefined);
    assert.deepEqual(runtime.timers, timers, 'Completed snapshot queries must retire their deadline timer');
  });
}

test('Nest snapshot retains the overall deadline for an image request that never completes', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  let pending = Promise.withResolvers();
  let flow = await platformHarness(context, {
    source: DATA_SOURCE.NEST,
    id: 'quartz.TEST',
    value: { nexus_api_http_server_url: 'https://nexus.invalid' },
    fetch: () => pending.promise,
  });
  let settled = false;
  let request = flow.connection.nestAPI.get('quartz.TEST', 'camera_snapshot');
  let rejected = assert.rejects(request, /Snapshot request timeout/).then(() => {
    settled = true;
  });
  context.mock.timers.tick(6999);
  await setImmediate();
  assert.equal(settled, false);
  context.mock.timers.tick(1);
  await rejected;
  // Release the isolated image fetch after proving the caller's deadline still works.
  pending.resolve({ arrayBuffer: async () => Buffer.from([1]) });
  await setImmediate();
});

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
  assert.equal(flow.requests.at(-1)[1], 'https://image.invalid/new.jpg');
});
test('snapshot command rejection cleans its waiter and GET degrades safely', async (context) => {
  let flow = await platformHarness(context, { value: { device_info: { typeName: 'google.resource.SpencerResource' } } });
  flow.connection.grpcTransport.command = async () => {
    throw new Error('Fixture command failure');
  };
  assert.equal((await flow.device.get({ uuid: 'DEVICE_TEST', camera_snapshot: true })).camera_snapshot, undefined);
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
  context.mock.timers.tick(3000);
  assert.deepEqual((await request).camera_snapshot, Buffer.from([4]));
  await replayed;
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
  context.mock.timers.tick(6000);
  assert.equal(await first, undefined);
  await flow.send('DEVICE_TEST', { upload_live_image: { liveImageUrl: 'https://image.invalid/fresh.jpg' } });
  let success = { status: 0, data: [{ traitOperations: [{ progress: 'COMPLETE', event: { event: { status: 'STATUS_SUCCESSFUL' } } }] }] };
  commands[1].resolve(success);
  assert.deepEqual(await second, Buffer.from([8]));
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
});

// Match the transport's decode().toJSON() boundary, which serialises int64 seconds as strings.
let imageTrait = getProtoType(
  fileURLToPath(new URL('../src/protobuf/root.proto', import.meta.url)),
  'nest.trait.product.camera.UploadLiveImageTrait',
);

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
  [
    'new seconds across a digit boundary at the same URL',
    { liveImageUrl: 'https://image.invalid/old.jpg', timestamp: { seconds: 9 } },
    { liveImageUrl: 'https://image.invalid/old.jpg', timestamp: { seconds: 10 } },
  ],
  ['changed URL without timestamps', { liveImageUrl: 'https://image.invalid/old.jpg' }, { liveImageUrl: 'https://image.invalid/new.jpg' }],
]) {
  for (let decoded of [false, true]) {
    test('Google snapshot ignores stale Observe updates until ' + label + ', protobuf JSON=' + decoded, async (context) => {
      let encodeImage = (image) =>
        decoded === true ? imageTrait.decode(imageTrait.encode(imageTrait.fromObject(image)).finish()).toJSON() : image;
      let initial = encodeImage(before);
      if (decoded === true && initial.timestamp !== undefined) {
        assert.equal(typeof initial.timestamp.seconds, 'string');
      }
      context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
      let image = Buffer.from([8]);
      let flow = await platformHarness(context, {
        value: { device_info: { typeName: 'google.resource.SpencerResource' }, upload_live_image: initial },
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
          { liveImageUrl: 'https://image.invalid/older.jpg', timestamp: { seconds: Number(before.timestamp.seconds) - 1 } },
        );
      }
      for (let update of stale) {
        delivered.push(flow.send('DEVICE_TEST', { upload_live_image: encodeImage(update) }));
        await setImmediate();
        assert.equal(flow.requests.length, fetches, 'Do not fetch the cached image while a fresh update can still arrive');
      }
      delivered.push(flow.send('DEVICE_TEST', { upload_live_image: encodeImage(fresh) }));
      assert.deepEqual((await request).camera_snapshot, image);
      await Promise.all(delivered);
      assert.equal(flow.requests.at(-1)[1], fresh.liveImageUrl);
    });
  }
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
  flow.connection.googleAPI.disconnect();
  assert.deepEqual((await request).camera_snapshot, image);
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

test('Nest camera event timeouts are silent and use one request attempt', async (context) => {
  let timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  let failure = new Error('GET failed after 1 attempt', { cause: timeout });
  let flow = await platformHarness(context, {
    source: DATA_SOURCE.NEST,
    id: 'quartz.TEST',
    value: { nexus_api_http_server_url: 'https://nexus.invalid' },
    fetch: async () => {
      throw failure;
    },
  });
  assert.deepEqual((await flow.device.get({ uuid: 'quartz.TEST', camera_events: true })).camera_events, []);
  assert.equal(flow.logs.filter((entry) => String(entry[1]).includes('activity notifications')).length, 0);
  let requests = flow.requests.filter((request) => String(request[1]).includes('/cuepoint'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0][2].retry, 1);
});

for (let [label, response, failure, expected] of [
  ['HTTP failure', undefined, Object.assign(new Error('HTTP 401'), { status: 401 }), 'HTTP 401'],
  ['malformed response', { status_detail: 'unexpected payload' }, undefined, 'unexpected payload'],
]) {
  test('Nest camera event errors remain visible: ' + label, async (context) => {
    let flow = await platformHarness(context, {
      source: DATA_SOURCE.NEST,
      id: 'quartz.TEST',
      value: { nexus_api_http_server_url: 'https://nexus.invalid' },
      fetch: async () => {
        if (failure !== undefined) {
          throw failure;
        }
        return { json: async () => response };
      },
    });
    assert.deepEqual((await flow.device.get({ uuid: 'quartz.TEST', camera_events: true })).camera_events, []);
    let messages = flow.logs.filter((entry) => String(entry[1]).includes('activity notifications'));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].at(-1), expected);
  });
}

test('Google camera event types use Nest-compatible kebab-case names', async (context) => {
  let flow = await platformHarness(context);
  flow.connection.grpcTransport.command = async () => ({
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
                      eventType: [
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
                      ],
                    },
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

for (let source of [DATA_SOURCE.NEST, DATA_SOURCE.GOOGLE]) {
  test('platform quietly skips unavailable-account queries and resumes polling after recovery: ' + source, async (context) => {
    let id = source === DATA_SOURCE.NEST ? 'quartz.TEST' : 'DEVICE_TEST';
    let flow = await platformHarness(context, {
      source,
      id,
      value: { nexus_api_http_server_url: 'https://nexus.invalid' },
      fetch: async () => ({ json: async () => [] }),
    });
    let nestGet = context.mock.method(flow.connection.nestAPI, 'get');
    let googleGet = context.mock.method(flow.connection.googleAPI, 'get');
    let requests = flow.requests.length;
    let commands = flow.commands.length;
    let logs = flow.logs.length;
    flow.connection.authorised = false;
    for (let poll = 0; poll < 3; poll++) {
      let result = await flow.device.get({ uuid: id, camera_events: true, camera_snapshot: true, location_weather: true });
      assert.deepEqual(result, { uuid: id, camera_events: undefined, camera_snapshot: undefined, location_weather: undefined });
    }
    assert.equal(nestGet.mock.calls.length, 0);
    assert.equal(googleGet.mock.calls.length, 0);
    assert.equal(flow.requests.length, requests);
    assert.equal(flow.commands.length, commands);
    assert.equal(flow.logs.length, logs);

    flow.connection.authorised = true;
    assert.deepEqual((await flow.device.get({ uuid: id, camera_events: true })).camera_events, []);
    let selectedGet = source === DATA_SOURCE.NEST ? nestGet : googleGet;
    assert.equal(selectedGet.mock.calls.length, 1, 'The next poll must resume without recreating the accessory or API');
    assert.equal(flow.registered.length, 1);
    selectedGet.mock.mockImplementation(async () => {
      throw new Error('Unexpected query failure');
    });
    assert.equal((await flow.device.get({ uuid: id, camera_events: true })).camera_events, undefined);
    assert.equal(flow.logs.at(-1).at(-1), 'Unexpected query failure', 'Unexpected authorised failures must remain visible');
  });
}
