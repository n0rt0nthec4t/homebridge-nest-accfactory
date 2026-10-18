// Follow real GET dispatch to weather, camera history and snapshot request paths with deterministic cloud responses.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
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
  await Promise.resolve();
  context.mock.timers.tick(3000);
  assert.deepEqual((await request).camera_snapshot, Buffer.from([4]));
  assert.equal(flow.connection.snapshotWaiters.size, 0);
});

test('overall snapshot timeout lets HomeKit continue when a cloud command never settles', async (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  let flow = await platformHarness(context, { value: { device_info: { typeName: 'google.resource.SpencerResource' } } });
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
  // Finish the late command too so its own cleanup can be verified independently of the outer timeout.
  pending.resolve({ status: 14 });
  await Promise.resolve();
  assert.equal(flow.connection.snapshotWaiters.size, 0);
});
