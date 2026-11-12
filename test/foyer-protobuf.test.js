// Verify Foyer metadata and identity against fixed bytes encoded with the independent
// KapJI/ghome-foyer-api HomeGraph schema, retrieved 2026-11-09 (synthetic data, not a capture).
// https://github.com/KapJI/ghome-foyer-api/blob/main/ghome_foyer_api/api.proto
// The production schema must never generate these fixtures during the test.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { getProtoType } from '../src/protobuf.js';

let schema = fileURLToPath(new URL('../src/protobuf/googlehome/foyer.proto', import.meta.url));
let response = getProtoType(schema, 'google.internal.home.foyer.v1.GetHomeGraphResponse');
let referencePayload = Buffer.from([
  '08d20912e6020a08686f6d652d6f6e651208486f6d65204f6e653acf020a240a0d676f6f676c652d63616d6572611213',
  '0a046e657374120b6e6573742d63616d657261220c46726f6e742043616d657261321b616374696f6e2e646576696365',
  '732e74797065732e43414d4552413a0c43616d65726153747265616d3a0f4f626a656374446574656374696f6e820108',
  '4e6573742043616d82010643616d6572618a01190a06476f6f676c6512084e6573742043616d2205312e322e33920131',
  '120c46726f6e742043616d6572611a084e6573742043616d1a0643616d657261220546726f6e742208456e7472616e63',
  '65a2015e0a130a0d737570706f727473417564696f120220010a270a0b7265736f6c7574696f6e73121832160a091100',
  '00000000e090400a091100000000008086400a1e0a0764657461696c7312132a110a0f0a05636f64656312061a044832',
  '3634ba02170a150a0643414d455241120b6e6573742d63616d65726112330a08686f6d652d74776f1208486f6d652054',
  '776f3a1d0a110a0f676f6f676c652d646f6f7262656c6c2208446f6f7262656c6c',
].join(''), 'hex');

test('reference Foyer bytes preserve multiple homes, camera IDs and device metadata', () => {
  let graph = response.decode(referencePayload).toJSON();
  assert.equal(graph.responseTimestamp, '1234');
  assert.deepEqual(graph.homes.map((home) => [home.uuid, home.name]), [['home-one', 'Home One'], ['home-two', 'Home Two']]);
  let camera = graph.homes[0].devices[0];
  assert.deepEqual(camera.id, {
    googleUuid: 'google-camera', thirdPartyId: { idType: 'nest', id: 'nest-camera' },
  });
  assert.deepEqual(camera.otherIds, { otherThirdPartyId: [{ idType: 'CAMERA', id: 'nest-camera' }] });
  assert.equal(camera.displayName, 'Front Camera');
  assert.equal(camera.type, 'action.devices.types.CAMERA');
  assert.deepEqual(camera.traits, ['CameraStream', 'ObjectDetection']);
  assert.deepEqual(camera.defaultNames, ['Nest Cam', 'Camera']);
  assert.deepEqual(camera.hardware, { manufacturer: 'Google', model: 'Nest Cam', softwareVersion: '1.2.3' });
  assert.deepEqual(camera.names, {
    name: 'Front Camera', defaultNames: ['Nest Cam', 'Camera'], nicknames: ['Front', 'Entrance'],
  });
  assert.deepEqual(camera.attributes, {
    fields: {
      supportsAudio: { boolValue: true },
      resolutions: { listValue: { values: [{ numberValue: 1080 }, { numberValue: 720 }] } },
      details: { structValue: { fields: { codec: { stringValue: 'H264' } } } },
    },
  });
  assert.deepEqual(graph.homes[1].devices, [{ id: { googleUuid: 'google-doorbell' }, displayName: 'Doorbell' }]);
});

test('identity-only Foyer replies remain usable without optional metadata', () => {
  let payload = Buffer.from('122b0a04686f6d653a230a0b0a09676f6f676c652d6964ba02130a110a0643414d45524112076e6573742d6964', 'hex');
  // An unknown future field remains skippable alongside the identity-only reply.
  let graph = response.decode(Buffer.concat([payload, Buffer.from([0x9a, 0x06, 0x01, 0xff])])).toJSON();
  assert.deepEqual(graph.homes, [{
    uuid: 'home',
    devices: [{
      id: { googleUuid: 'google-id' },
      otherIds: { otherThirdPartyId: [{ idType: 'CAMERA', id: 'nest-id' }] },
    }],
  }]);
});

// Encoded with the same independent reference schema as referencePayload.
let cataloguePayload = Buffer.from([
  '12390a036f6e65aa01310a0c4578616d706c655472616974120d0a07656e61626c65641202200112120a056c6576656c',
  '120911000000000000004012230a0374776faa011b0a0a4f746865725472616974120d0a07656e61626c656412022000',
  '1a1b0a0a0a0867726f75702d6964220d537065616b65722047726f757022120a07424544524f4f4d1207426564726f6f',
  '6d22120a074b49544348454e12074b69746368656e2a0e73796e7468657469632d6861736830013a250a1b616374696f',
  '6e2e646576696365732e74797065732e43414d455241120643616d6572614a4a0a046e65737412044e657374221b6874',
  '7470733a2f2f6578616d706c652e696e76616c69642f696f732a1f68747470733a2f2f6578616d706c652e696e76616c',
  '69642f616e64726f69645a1c0a16544f54414c5f41535349474e45445f44455649434553120210025a380a1541535349',
  '474e45445f4445564943455f5459504553121f1a1d0a1b616374696f6e2e646576696365732e74797065732e43414d45',
  '5241620d120b4578616d706c6520417070',
].join(''), 'hex');

test('reference Foyer catalogues, unassigned devices and home traits decode independently', () => {
  let graph = response.decode(cataloguePayload).toJSON();
  assert.deepEqual(graph.homes, [
    { uuid: 'one', traits: [{ name: 'ExampleTrait', fields: { enabled: { boolValue: true }, level: { numberValue: 2 } } }] },
    { uuid: 'two', traits: [{ name: 'OtherTrait', fields: { enabled: { boolValue: false } } }] },
  ]);
  assert.deepEqual(graph.unassignedDevices, [{ id: { googleUuid: 'group-id' }, displayName: 'Speaker Group' }]);
  assert.deepEqual(graph.spaceTypes, [{ code: 'BEDROOM', name: 'Bedroom' }, { code: 'KITCHEN', name: 'Kitchen' }]);
  assert.equal(graph.stableHash, 'synthetic-hash');
  assert.equal(graph.homeGraphHasChanged, true);
  assert.deepEqual(graph.deviceTypes, [{ code: 'action.devices.types.CAMERA', name: 'Camera' }]);
  assert.deepEqual(graph.agentsInfo, [{
    apiProjectId: 'nest', name: 'Nest', appStoreUrl: 'https://example.invalid/ios', playStoreUrl: 'https://example.invalid/android',
  }]);
  assert.deepEqual(graph.homeGraphState, {
    TOTAL_ASSIGNED_DEVICES: { count: 2 },
    ASSIGNED_DEVICE_TYPES: { deviceTypes: { types: ['action.devices.types.CAMERA'] } },
  });
  assert.deepEqual(graph.linkableApplications, [{ name: 'Example App' }]);
});
