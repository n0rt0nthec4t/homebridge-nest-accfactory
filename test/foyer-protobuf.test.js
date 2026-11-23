// Verify Foyer metadata and identity against fixed bytes encoded with the independent
// KapJI/ghome-foyer-api HomeGraph schema, retrieved 2026-11-09 (synthetic data, not a capture).
// https://github.com/KapJI/ghome-foyer-api/blob/main/ghome_foyer_api/api.proto
// The production schema must never generate these fixtures during the test.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { getProtoRoot, getProtoType } from '../src/protobuf.js';

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

// Generated separately with KapJI/ghome-foyer-api HomeGraph, retrieved 2026-11-21.
// Includes an unmapped numeric field and fabricated local-auth token. Protocol
// decoding retains credentials; diagnostic output owns redaction separately.
let deviceStatePayload = Buffer.from(
  [
    '12b0030a0c6578616d706c652d686f6d653a9f030a340a0e6578616d706c652d63616d65726112220a0d6578616d70',
    '6c652d6167656e7412116578616d706c652d6f726967696e2d6964220e4578616d706c652043616d657261321b616374',
    '696f6e2e646576696365732e74797065732e43414d4552419801eda6b8d79f34d201170a156f776e6572406578616d70',
    '6c652e696e76616c6964d201180a166d656d626572406578616d706c652e696e76616c6964e2011b6661627269636174',
    '65642d6c6f63616c2d617574682d746f6b656ef201440a0c646576696365537461747573120c0a066f6e6c696e651202',
    '200012130a0673746174757312091a076f66666c696e651a110a0f0a0971756572794f6e6c7912022001f201540a1274',
    '656d706572617475726553657474696e6712130a06746172676574120911000000000080334012290a0773656e736f72',
    '73121e321c0a0c1a0a73656e736f722d6f6e650a0c1a0a73656e736f722d74776f8202220a0d616e6f746865722d61',
    '67656e741211616e6f746865722d6f726967696e2d6964880207ba02180a160a03504858120f6578697374696e672d70',
    '68782d6964',
  ].join(''),
  'hex',
);

test('reference Foyer device state, linked users and alternate IDs preserve established identity', () => {
  let graph = response.decode(deviceStatePayload).toJSON();
  let device = graph.homes[0].devices[0];
  assert.equal(device.timestamp19, '1795211268973');
  assert.deepEqual(device.linkedUsers, [{ value: 'owner@example.invalid' }, { value: 'member@example.invalid' }]);
  assert.deepEqual(device.traitStates, [
    {
      name: 'deviceStatus',
      state: { online: { boolValue: false }, status: { stringValue: 'offline' } },
      attributes: { fields: { queryOnly: { boolValue: true } } },
    },
    {
      name: 'temperatureSetting',
      state: {
        target: { numberValue: 19.5 },
        sensors: { listValue: { values: [{ stringValue: 'sensor-one' }, { stringValue: 'sensor-two' }] } },
      },
    },
  ]);
  assert.deepEqual(device.additionalThirdPartyId, { idType: 'another-agent', id: 'another-origin-id' });
  assert.deepEqual(device.id, {
    googleUuid: 'example-camera',
    thirdPartyId: { idType: 'example-agent', id: 'example-origin-id' },
  });
  assert.deepEqual(device.otherIds, { otherThirdPartyId: [{ idType: 'PHX', id: 'existing-phx-id' }] });
  assert.equal(device.localAuthToken, 'fabricated-local-auth-token');
  assert.equal(Object.hasOwn(device, 'num33'), false);
});

test('Foyer hardware revision decodes from independently constructed field-3 wire bytes', () => {
  // Hardware field 3 is hwVersion in the supplied decoded 2024.51.3 VendorInfo schema.
  // These bytes were constructed directly, without the production schema.
  let payload = Buffer.from('121c0a04686f6d653a140a080a0663616d6572618a01071a057265762d32', 'hex');
  let device = response.decode(payload).toJSON().homes[0].devices[0];
  assert.deepEqual(device, { id: { googleUuid: 'camera' }, hardware: { hardwareVersion: 'rev-2' } });
});

// Independently encoded with the same 2026-11-21 public HomeGraph reference.
// Numeric metadata is asserted by field number, without assigning enum meanings.
let investigatedMetadataPayload = Buffer.from(
  [
    '12c4020a04686f6d6522190a156f776e6572406578616d706c652e696e76616c696420013a3e0a2c0a0e6578616d706c',
    '652d646576696365121a0a0d6578616d706c652d6167656e7412096f726967696e2d6964220e4578616d706c65204465',
    '766963655a110802120d6578616d706c652d6167656e74622b20012a156f776e6572406578616d706c652e696e76616c',
    '6964420c4578616d706c6520506c616e5a0208018201490a114661766f726974657343617465676f7279180622320a30',
    '0a2c0a0e6578616d706c652d646576696365121a0a0d6578616d706c652d6167656e7412096f726967696e2d69641801',
    'ba01540a0744454641554c5412490a114661766f726974657343617465676f7279180622320a300a2c0a0e6578616d70',
    '6c652d646576696365121a0a0d6578616d706c652d6167656e7412096f726967696e2d696418014a410a0d6578616d70',
    '6c652d6167656e74120d4578616d706c65204167656e741a2168747470733a2f2f6578616d706c652e696e76616c6964',
    '2f6167656e742e706e6762400a0a2f6d2f6578616d706c65120b4578616d706c65204170701801200328023a1f687474',
    '70733a2f2f6578616d706c652e696e76616c69642f6170702e706e67',
  ].join(''),
  'hex',
);

test('investigated HomeGraph metadata decodes favorites, agent links, entitlements and catalogue IDs', () => {
  let graph = response.decode(investigatedMetadataPayload).toJSON();
  let home = graph.homes[0];
  let id = { googleUuid: 'example-device', thirdPartyId: { idType: 'example-agent', id: 'origin-id' } };
  let favorite = { name: 'FavoritesCategory', field3: 6, items: [{ device: { id, field3: 1 } }] };
  assert.deepEqual(home.devices[0].id, id);
  assert.deepEqual(home.agentMetadata, { field1: 2, apiProjectId: 'example-agent' });
  assert.deepEqual(home.linkedUsers, [{ value: 'owner@example.invalid', field4: 1 }]);
  assert.deepEqual(home.entitlement, {
    field4: 1,
    emailAddress: 'owner@example.invalid',
    name: 'Example Plan',
    metadata: { field1: 1 },
  });
  assert.deepEqual(home.favorites, favorite);
  assert.deepEqual(home.favoritesByName, { DEFAULT: favorite });
  assert.deepEqual(graph.agentsInfo, [
    {
      apiProjectId: 'example-agent',
      name: 'Example Agent',
      iconUrl: 'https://example.invalid/agent.png',
    },
  ]);
  assert.deepEqual(graph.linkableApplications, [
    {
      knowledgeGraphId: '/m/example',
      name: 'Example App',
      field3: 1,
      field4: 3,
      field5: 2,
      iconUrl: 'https://example.invalid/app.png',
    },
  ]);
});

// Fixed bytes below were constructed from wire tags, independently of the
// production encoder. Values are synthetic; the tag layout was verified in
// browser captures, the supplied compiled schema and live read-only probes.
test('Foyer read requests encode account and device routing with the verified tags', () => {
  let traits = getProtoType(schema, 'google.internal.home.foyer.v1.GetTraitsRequest');
  assert.equal(Buffer.from(traits.encode({ deviceIds: [{ uuid: 'a' }, { uuid: 'b' }] }).finish()).toString('hex'), '0a030a01610a030a0162');
  let prefs = getProtoType(schema, 'google.internal.home.foyer.v1.GetUserPreferencesRequest');
  let encoded = prefs.encode({ structureId: 'h', pageCode: [18, 25], uuid: { value: 'd' }, unknown5: '' }).finish();
  // Proto3 omits the empty default string in field 5.
  assert.equal(Buffer.from(encoded).toString('hex'), '0a0168120212191a030a0164');
  // Proto repeated numeric fields accept both packed and unpacked wire forms.
  assert.deepEqual(prefs.decode(Buffer.from('10121019', 'hex')).pageCode, [18, 25]);
});

test('Foyer trait reads decode all scalar kinds, recursive values and category attributes', () => {
  let type = getProtoType(schema, 'google.internal.home.foyer.v1.GetTraitsResponse');
  let payload = Buffer.from(
    [
      '0ab9010a080a0664657669636512ac010a1274656d706572617475726553657474696e67120a0a046e756c6c12020800',
      '12180a0b74656d70657261747572651209110000000000803640120e0a046d6f646512061a0468656174120d0a07656e',
      '61626c65641202200012200a0764657461696c7312152a130a110a0673746174757312071a057265616479121c0a0773',
      '616d706c65731211320f0a0220010a091100000000000000001a110a0f0a0971756572794f6e6c7912022001',
    ].join(''),
    'hex',
  );
  let decoded = type.decode(payload).toJSON();
  assert.equal(decoded.device[0].uuid.value, 'device');
  let category = decoded.device[0].category[0];
  assert.equal(category.name, 'temperatureSetting');
  assert.deepEqual(
    category.traits.map((trait) => trait.value),
    [
      { nullValue: 0 },
      { number: 22.5 },
      { text: 'heat' },
      { boolean: false },
      { properties: { properties: [{ name: 'status', value: { text: 'ready' } }] } },
      { array: { values: [{ boolean: true }, { number: 0 }] } },
    ],
  );
  assert.deepEqual(category.attributes, { properties: [{ name: 'queryOnly', value: { boolean: true } }] });
  assert.deepEqual(type.decode(Buffer.alloc(0)).toJSON(), {});
});

test('Foyer preferences decode recursive Technical Information pages without interpreting UI labels', () => {
  let type = getProtoType(schema, 'google.internal.home.foyer.v1.GetUserPreferencesResponse');
  let payload = Buffer.from('0a1f321d0a0310ee011a04496e666f221053657269616c206e6f2e3a2046414b45', 'hex');
  assert.deepEqual(type.decode(payload).toJSON(), {
    item: { subitems: [{ itemRef: { id: 238 }, name: 'Info', subtitle: 'Serial no.: FAKE' }] },
  });
  // Unknown future response fields must not prevent existing pages from decoding.
  let extended = Buffer.concat([payload, Buffer.from('980601', 'hex')]);
  assert.deepEqual(type.decode(extended).toJSON(), type.decode(payload).toJSON());
  assert.deepEqual(type.decode(Buffer.alloc(0)).toJSON(), {});
});

test('newly inspected Foyer fields decode against fixed reference wire tags without inventing meanings', () => {
  // Fixed literal tags/types checked against the supplied reference encoder:
  // address 9, names 1, device 37, preference 2 and 26.
  let cases = [
    ['Address', '4a080a060a0141120142', { addressLines: { twoLineAddress: { line1: 'A', line2: 'B' } } }],
    ['Address', '4a0e120c0a04556e69741201411a0142', { addressLines: { threeLineAddress: { aptLine: 'Unit', line1: 'A', line2: 'B' } } }],
    ['Device', '92010b0a09486f6d65204e616d65a80202', { names: { nameFromGoogleHome: 'Home Name' }, deviceSource: 2 }],
    ['GetUserPreferencesResponse', '0a0412020801', { item: { selected: { state: 1 } } }],
    [
      'GetUserPreferencesResponse',
      '0a0dd2010a08461201681a030a0164',
      { item: { prefsPageLink: { pageCode: 70, structureId: 'h', uuid: { value: 'd' } } } },
    ],
  ];
  for (let [name, hex, expected] of cases) {
    let type = getProtoType(schema, 'google.internal.home.foyer.v1.' + name);
    let payload = Buffer.from(hex, 'hex');
    assert.deepEqual(type.decode(payload).toJSON(), expected, name);
  }
});

test('Foyer services expose verified read RPCs alongside the established control and camera methods', () => {
  let root = getProtoRoot(schema);
  for (let [service, method, request, reply] of [
    ['HomeControlService', 'GetTraits', 'GetTraitsRequest', 'GetTraitsResponse'],
    ['UsersService', 'GetUserPreferences', 'GetUserPreferencesRequest', 'GetUserPreferencesResponse'],
    ['HomeControlService', 'UpdateTraits', 'UpdateTraitsRequest', 'UpdateTraitsResponse'],
    ['CameraService', 'JoinStream', 'JoinStreamRequest', 'JoinStreamResponse'],
  ]) {
    let rpc = root.lookupService('google.internal.home.foyer.v1.' + service).methods[method].resolve();
    assert.equal(rpc.resolvedRequestType.name, request);
    assert.equal(rpc.resolvedResponseType.name, reply);
  }
});

test('fixed Address bytes decode structured country, state, city and postal fields for weather', () => {
  // Literal wire tags: timezone 6, addressComponents 7; nested strings 1,2,3,5,12.
  // This fixture is independent of the production encoder.
  let address = getProtoType(schema, 'google.internal.home.foyer.v1.Address')
    .decode(
      Buffer.from('32104175737472616c69612f5379646e65793a220a02415512094175737472616c69611a034e53572a065379646e6579620432303030', 'hex'),
    )
    .toJSON();
  assert.equal(address.timezone, 'Australia/Sydney');
  assert.deepEqual(address.addressComponents, {
    countryCode: 'AU',
    countryName: 'Australia',
    state: 'NSW',
    city: 'Sydney',
    postalCode: '2000',
  });
});

// Synthetic write bytes were built from the supplied compiled schema's field
// tags, independently of our production encoder.
test('Foyer sensor-selection writes encode repeated requests, routing, categories and string arrays', () => {
  let request = getProtoType(schema, 'google.internal.home.foyer.v1.UpdateTraitsRequest');
  let values = {
    request: [
      {
        deviceId: { uuid: 't', internalId: { source: 'nest' } },
        categories: [
          {
            name: 'temperatureSetting',
            traits: [
              {
                name: 'activeThermostatTemperatureSensors',
                value: { array: { values: [{ text: 's' }] } },
              },
            ],
          },
        ],
      },
    ],
  };
  let bytes = Buffer.from(
    [
      '0a520a0b0a017412060a046e65737412430a1274656d706572617475726553657474696e67122d0a22616374697665',
      '546865726d6f7374617454656d706572617475726553656e736f7273120732050a031a0173',
    ].join(''),
    'hex',
  );
  assert.equal(Buffer.from(request.encode(values).finish()).toString('hex'), bytes.toString('hex'));
  assert.deepEqual(request.decode(bytes).toJSON(), values);
  let response = getProtoType(schema, 'google.internal.home.foyer.v1.UpdateTraitsResponse');
  assert.deepEqual(
    response
      .decode(Buffer.from('0a310a030a0174122a0a0c646576696365537461747573121a0a056572726f7212111a0f696e76616c6964417267756d656e74', 'hex'))
      .toJSON(),
    {
      device: [
        {
          uuid: { value: 't' },
          category: [
            {
              name: 'deviceStatus',
              traits: [
                {
                  name: 'error',
                  value: { text: 'invalidArgument' },
                },
              ],
            },
          ],
        },
      ],
    },
  );
});

// Synthetic thermostat command bytes use the verified EnergyService tags and
// FloatValue/UInt32Value wrappers, independently of the production encoder.
test('Foyer thermostat energy commands encode the verified Celsius, mode and timer request fields', () => {
  for (let [name, values, hex] of [
    ['UpdateThermostatModeRequest', { deviceId: 't', mode: 'cool', unknown3: 6 }, '0a017410021806'],
    [
      'UpdateTargetTemperatureRequest',
      { deviceId: 't', mode: 'cool', temperature: { value: 24.5 }, unknown4: 6 },
      '0a017410021a050d0000c4412006',
    ],
    [
      'UpdateTargetTemperatureRangeRequest',
      { deviceId: 't', tempLow: { value: 20 }, tempHigh: { value: 26 }, unknown4: 6 },
      '0a017412050d0000a0411a050d0000d0412006',
    ],
    ['UpdateThermostatFanModeRequest', { deviceId: 't', runTimeSeconds: { value: 900 } }, '0a01741203088407'],
  ]) {
    let type = getProtoType(schema, 'google.internal.home.foyer.v1.' + name);
    assert.equal(Buffer.from(type.encode(type.fromObject(values)).finish()).toString('hex'), hex);
    assert.deepEqual(type.decode(Buffer.from(hex, 'hex')).toJSON(), values);
  }
});
