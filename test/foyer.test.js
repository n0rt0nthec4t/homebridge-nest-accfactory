// Verify shared HomeGraph lookup matches one device without mixing aliases or owning transports.
import assert from 'node:assert/strict';
import test from 'node:test';
import GrpcTransport from '../src/grpctransport.js';
import { resolveCameraIds, setupGoogleHomeFoyer } from '../src/plugins/camera/foyer.js';
import { GOOGLE_HOME_FOYER_PREFIX, GOOGLE_HOME_FOYER_ENDPOINTS } from '../src/consts.js';

function graph(devices) {
  return { data: [{ homes: [{ devices }] }] };
}
function device(id, aliases) {
  return { id: { googleUuid: id }, otherIds: { otherThirdPartyId: aliases } };
}

test('Foyer resolves both IDs from the same device in a single bounded request', async () => {
  let response = graph([
    device('other-google', [
      { idType: 'PHX', id: 'DEVICE_OTHER' },
      { idType: 'CAMERA', id: 'quartz.wrong' },
    ]),
    device('google-match', [
      { idType: 'PHX', id: 'DEVICE_MATCH' },
      { idType: 'CAMERA', id: 'quartz.original' },
    ]),
  ]);
  let before = structuredClone(response);
  let requests = [];
  let transport = {
    command: async (...args) => {
      requests.push(args);
      return response;
    },
  };
  assert.deepEqual(await resolveCameraIds(transport, 'DEVICE_MATCH'), { googleDeviceId: 'google-match', legacyDeviceId: 'original' });
  assert.equal(requests.length, 1);
  let [prefix, service, method, values, options] = requests[0];
  assert.equal(prefix, GOOGLE_HOME_FOYER_PREFIX);
  assert.equal(service, 'StructuresService');
  assert.equal(method, 'GetHomeGraph');
  assert.match(values.requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(options, { retry: 2 });
  assert.deepEqual(response, before);
  assert.equal(new URL(GOOGLE_HOME_FOYER_ENDPOINTS.PRODUCTION).protocol, 'https:');
  assert.equal(new URL(GOOGLE_HOME_FOYER_ENDPOINTS.FIELD_TEST).protocol, 'https:');
});

for (let aliases of [
  [{ id: 'DEVICE_MATCH' }],
  [{ id: 'DEVICE_MATCH' }, null, { idType: 'CAMERA' }],
  [{ id: 'DEVICE_MATCH' }, { idType: 'CAMERA', id: 42 }],
  [{ id: 'DEVICE_MATCH' }, { idType: 'CAMERA', id: 'quartz.' }],
  [{ id: 'DEVICE_MATCH' }, { idType: 'CAMERA', id: 'DEVICE_OTHER' }],
  [{ id: 'DEVICE_MATCH' }, { idType: 'PHX', id: 'quartz.wrong-type' }],
]) {
  test('Foyer retains a WebRTC UUID without a valid Quartz alias: ' + JSON.stringify(aliases), async () => {
    assert.deepEqual(await resolveCameraIds({ command: async () => graph([device('google-only', aliases)]) }, 'DEVICE_MATCH'), {
      googleDeviceId: 'google-only',
      legacyDeviceId: undefined,
    });
  });
}

test('Foyer resolves a Quartz-only device without requiring a Google UUID', async () => {
  let response = graph([
    {
      otherIds: {
        otherThirdPartyId: [
          { idType: 'PHX', id: 'DEVICE_MATCH' },
          { idType: 'CAMERA', id: 'quartz.original' },
        ],
      },
    },
  ]);
  assert.deepEqual(await resolveCameraIds({ command: async () => response }, 'DEVICE_MATCH'), {
    googleDeviceId: undefined,
    legacyDeviceId: 'original',
  });
});

for (let response of [
  undefined,
  {},
  { data: [] },
  { data: [{}] },
  { data: [{ homes: [null, {}] }] },
  graph([null, {}, { otherIds: {} }]),
  graph([device('other', [{ id: 'DEVICE_OTHER' }])]),
]) {
  test('Foyer returns no IDs for an unmatched or incomplete graph: ' + JSON.stringify(response), async () => {
    assert.deepEqual(await resolveCameraIds({ command: async () => response }, 'DEVICE_MATCH'), {});
  });
}

test('Foyer propagates failures so each caller controls retry and logging', async () => {
  let failure = new Error('fabricated failure');
  await assert.rejects(
    resolveCameraIds(
      {
        command: async () => {
          throw failure;
        },
      },
      'DEVICE_MATCH',
    ),
    (error) => error === failure,
  );
});

for (let fieldTest of [false, true]) {
  test('Foyer setup reuses its caller-owned client: fieldTest=' + fieldTest, async (context) => {
    let command = context.mock.method(GrpcTransport.prototype, 'command', async () =>
      graph([device('google-match', [{ id: 'DEVICE_MATCH' }, { idType: 'CAMERA', id: 'quartz.original' }])]),
    );
    let options = { uuid: 'DEVICE_MATCH', fieldTest, getAuthHeader: () => 'Bearer fabricated-token' };
    let first = setupGoogleHomeFoyer(options);
    assert.equal(first.transport instanceof GrpcTransport, true);
    assert.deepEqual(await first.promise, { googleDeviceId: 'google-match', legacyDeviceId: 'original' });
    let second = setupGoogleHomeFoyer(options, first.transport);
    assert.equal(second.transport, first.transport);
    assert.deepEqual(await second.promise, { googleDeviceId: 'google-match', legacyDeviceId: 'original' });
    assert.equal(command.mock.callCount(), 2);
    assert.equal(command.mock.calls[0].this, first.transport);
    first.transport.release();
  });
}
