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
let referencePayload = Buffer.from(
  [
    '08d20912e6020a08686f6d652d6f6e651208486f6d65204f6e653acf020a240a0d676f6f676c652d63616d6572611213',
    '0a046e657374120b6e6573742d63616d657261220c46726f6e742043616d657261321b616374696f6e2e646576696365',
    '732e74797065732e43414d4552413a0c43616d65726153747265616d3a0f4f626a656374446574656374696f6e820108',
    '4e6573742043616d82010643616d6572618a01190a06476f6f676c6512084e6573742043616d2205312e322e33920131',
    '120c46726f6e742043616d6572611a084e6573742043616d1a0643616d657261220546726f6e742208456e7472616e63',
    '65a2015e0a130a0d737570706f727473417564696f120220010a270a0b7265736f6c7574696f6e73121832160a091100',
    '00000000e090400a091100000000008086400a1e0a0764657461696c7312132a110a0f0a05636f64656312061a044832',
    '3634ba02170a150a0643414d455241120b6e6573742d63616d65726112330a08686f6d652d74776f1208486f6d652054',
    '776f3a1d0a110a0f676f6f676c652d646f6f7262656c6c2208446f6f7262656c6c',
  ].join(''),
  'hex',
);

test('reference Foyer bytes preserve multiple homes, camera IDs and device metadata', () => {
  let graph = response.decode(referencePayload).toJSON();
  assert.equal(Object.hasOwn(graph, 'responseTimestamp'), false);
  assert.deepEqual(
    graph.homes.map((home) => [home.uuid, home.name]),
    [
      ['home-one', 'Home One'],
      ['home-two', 'Home Two'],
    ],
  );
  let camera = graph.homes[0].devices[0];
  assert.deepEqual(camera.id, {
    googleUuid: 'google-camera',
    thirdPartyId: { idType: 'nest', id: 'nest-camera' },
  });
  assert.deepEqual(camera.otherIds, { otherThirdPartyId: [{ idType: 'CAMERA', id: 'nest-camera' }] });
  assert.equal(camera.displayName, 'Front Camera');
  assert.equal(camera.type, 'action.devices.types.CAMERA');
  assert.deepEqual(camera.traits, ['CameraStream', 'ObjectDetection']);
  assert.deepEqual(camera.hardware, { manufacturer: 'Google', model: 'Nest Cam', softwareVersion: '1.2.3' });
  assert.deepEqual(camera.names, {
    name: 'Front Camera',
    defaultNames: ['Nest Cam', 'Camera'],
    nicknames: ['Front', 'Entrance'],
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
  assert.deepEqual(graph.homes, [
    {
      uuid: 'home',
      devices: [
        {
          id: { googleUuid: 'google-id' },
          otherIds: { otherThirdPartyId: [{ idType: 'CAMERA', id: 'nest-id' }] },
        },
      ],
    },
  ]);
});

test('Foyer read requests encode account and device routing with the verified tags', () => {
  let traits = getProtoType(schema, 'google.internal.home.foyer.v1.GetTraitsRequest');
  assert.equal(Buffer.from(traits.encode({ deviceIds: [{ uuid: 'a' }, { uuid: 'b' }] }).finish()).toString('hex'), '0a030a01610a030a0162');
  let prefs = getProtoType(schema, 'google.internal.home.foyer.v1.GetUserPreferencesRequest');
  let encoded = prefs.encode({ structureId: 'h', pageCode: [18, 25], uuid: { value: 'd' }, field5Proto: '' }).finish();
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

test('Foyer thermostat energy commands encode the verified Celsius, mode and timer request fields', () => {
  for (let [name, values, hex] of [
    ['UpdateThermostatModeRequest', { deviceId: 't', mode: 'THERMOSTAT_MODE_COOL', hvacActor: 'HVAC_ACTOR_IOS' }, '0a017410021807'],
    [
      'UpdateTargetTemperatureRequest',
      { deviceId: 't', mode: 'THERMOSTAT_MODE_COOL', temperature: { value: 24.5 }, hvacActor: 'HVAC_ACTOR_IOS' },
      '0a017410021a050d0000c4412007',
    ],
    [
      'UpdateTargetTemperatureRangeRequest',
      { deviceId: 't', tempLow: { value: 20 }, tempHigh: { value: 26 }, hvacActor: 'HVAC_ACTOR_IOS' },
      '0a017412050d0000a0411a050d0000d0412007',
    ],
    ['UpdateThermostatFanModeRequest', { deviceId: 't', runTimeSeconds: { value: 900 } }, '0a01741203088407'],
  ]) {
    let type = getProtoType(schema, 'google.internal.home.foyer.v1.' + name);
    assert.equal(Buffer.from(type.encode(type.fromObject(values)).finish()).toString('hex'), hex);
    assert.deepEqual(type.decode(Buffer.from(hex, 'hex')).toJSON(), values);
  }
});

test('typed empty iOS context preserves client context bytes and oneof selection', () => {
  let type = getProtoType(schema, 'google.internal.home.foyer.v1.ClientEnvironment');
  let values = { platform: 2, iosClientInfo: {} };
  let bytes = Buffer.from('08021a00', 'hex');
  assert.equal(Buffer.from(type.encode(type.fromObject(values)).finish()).toString('hex'), bytes.toString('hex'));
  let decoded = type.decode(bytes);
  assert.deepEqual(decoded.toJSON(), values);
  assert.equal(decoded.clientInfo, 'iosClientInfo');
  assert.equal(Object.hasOwn(decoded, 'androidClientInfo'), false);
  // Unused client metadata stays skippable inside the retained iOS envelope.
  assert.deepEqual(type.decode(Buffer.from('1a023000', 'hex')).iosClientInfo.toJSON(), {});
  assert.match(type.verify({ androidClientInfo: {}, iosClientInfo: {} }), /multiple values/);
});

test('timeline requests encode camera routing, start/end timestamps and strong reads with fixed tags', () => {
  let type = getProtoType(schema, 'google.internal.home.foyer.v1.ListTimelinePeriodsRequest');
  let hex = '0a0c0a0163120208641a0308c80110011801';
  let values = {
    request: { deviceId: 'c', startTime: { seconds: '100' }, endTime: { seconds: '200' } },
    field2: 1,
    strongRead: true,
  };
  assert.deepEqual(type.decode(Buffer.from(hex, 'hex')).toJSON(), values);
  assert.equal(Buffer.from(type.encode(type.fromObject(values)).finish()).toString('hex'), hex);
});

// Independently assembled timeline/session bytes, with the established track wire layout.
for (let [variant, hex] of [
  ['recorded', '121f0a020864120208691a150a130a0173320e0a0174120208641a020869220108'],
  ['noVideo', '121f0a02086412020869221522130a0173320e0a0174120208641a020869220108'],
  ['unknown', '121f0a020864120208692a1522130a0173320e0a0174120208641a020869220108'],
]) {
  test('timeline ' + variant + ' periods decode embedded session tracks from fixed bytes', () => {
    let type = getProtoType(schema, 'google.internal.home.foyer.v1.ListTimelinePeriodsResponse');
    let period = type.decode(Buffer.from(hex, 'hex')).toJSON().periods[0];
    assert.deepEqual(period.startTime, { seconds: '100' });
    assert.deepEqual(period.endTime, { seconds: '105' });
    assert.equal(period[variant].session.sessionId, 's');
    assert.deepEqual(period[variant].session.tracks, [
      {
        trackId: 't',
        startTime: { seconds: '100' },
        endTime: { seconds: '105' },
        eventTypes: ['EVENT_TYPE_DOORBELL'],
      },
    ]);
  });
}

test('camera tracks retain fixed detection timestamps, event types and activity zones', () => {
  let type = getProtoType(schema, 'google.internal.home.foyer.v1.CameraEventTrack');
  assert.deepEqual(type.decode(Buffer.from('0a0174120208641a0208692202010832030a017a', 'hex')).toJSON(), {
    trackId: 't',
    startTime: { seconds: '100' },
    endTime: { seconds: '105' },
    eventTypes: ['EVENT_TYPE_MOTION', 'EVENT_TYPE_DOORBELL'],
    activityZones: [{ zoneId: 'z' }],
  });
});

test('Foyer hot water requests preserve device routing and explicit cancellation', () => {
  for (let [name, value, hex] of [
    ['UpdateHotWaterBoostRequest', { deviceId: 't', duration: { seconds: '3600' } }, '0a0174120308901c'],
    ['UpdateHotWaterBoostRequest', { deviceId: 't', duration: { seconds: '0' } }, '0a01741200'],
  ]) {
    let type = getProtoType(schema, 'google.internal.home.foyer.v1.' + name);
    assert.equal(Buffer.from(type.encode(type.fromObject(value)).finish()).toString('hex'), hex);
    let decoded = type.decode(Buffer.from(hex, 'hex'));
    if (name === 'UpdateHotWaterBoostRequest' && value.duration.seconds === '0') {
      assert.deepEqual(decoded.toJSON(), { deviceId: 't', duration: {} });
      assert.equal(Number(decoded.duration.seconds), 0);

    } else {
      assert.deepEqual(decoded.toJSON(), value);
    }
  }
});

test('camera power preserves a disabled wrapper on the wire', () => {
  let type = getProtoType(schema, 'google.internal.home.foyer.v1.UpdateCameraPropertyRequest');
  let bytes = type.encode(type.fromObject({ hgsDeviceId: 'c', properties: { streamingEnabled: { value: false } } })).finish();
  assert.equal(Buffer.from(bytes).toString('hex'), '0a01631a020a00');
  let decoded = type.decode(bytes);
  assert.ok(decoded.properties.streamingEnabled);
  assert.equal(decoded.properties.streamingEnabled.value, false);
});

test('Foyer weather fields decode fixed request and response wire payloads', () => {
  let request = getProtoType(schema, 'google.internal.home.foyer.v1.GetOutdoorWeatherInfoRequest');
  assert.deepEqual(request.decode(Buffer.from('0a0474657374150000803f1d00000040', 'hex')).toJSON(), {
    structureId: 'test',
    latitude: 1,
    longitude: 2,
  });
  let response = getProtoType(schema, 'google.internal.home.foyer.v1.GetOutdoorWeatherInfoResponse');
  assert.deepEqual(response.decode(Buffer.from('0a110a050d0000c0412208436c6f7564792121120a082a2206476f6f642121', 'hex')).toJSON(), {
    weather: { temperatureC: { value: 24 }, description: 'Cloudy!!' },
  });
});

test('Foyer device field 57 retains the parent UUID independently of its own identity', () => {
  let type = getProtoType(schema, 'google.internal.home.foyer.v1.Device');
  assert.deepEqual(type.decode(Buffer.from('ca03080a06706172656e74', 'hex')).toJSON(), {
    parentDevice: { googleUuid: 'parent' },
  });
});

// Keep the runtime RPC contract explicit so unused research APIs stay out of the package.
test('Foyer exposes only the RPCs used by the production clients', () => {
  let root = getProtoRoot(schema);
  let services = {
    StructuresService: ['GetHomeGraph', 'GetOutdoorWeatherInfo'],
    UsersService: ['GetUserPreferences', 'AppSubscriptionUpdate'],
    HomeControlService: ['GetTraits', 'UpdateTraits'],
    EnergyService: [
      'UpdateThermostatMode',
      'UpdateTargetTemperature',
      'UpdateTargetTemperatureRange',
      'UpdateThermostatFanMode',
      'UpdateHotWaterBoost',
    ],
    CameraService: ['UpdateCameraProperty', 'ListTimelinePeriods', 'SendCameraViewIntent', 'JoinStream', 'SendTalkback'],
    ClientOliveTokenService: ['GetOliveToken'],
  };
  let namespace = root.lookup('google.internal.home.foyer.v1');
  assert.deepEqual(
    namespace.nestedArray.filter((type) => type.methods !== undefined).map((type) => type.name).sort(),
    Object.keys(services).sort(),
  );
  for (let [name, methods] of Object.entries(services)) {
    let service = root.lookupService('google.internal.home.foyer.v1.' + name);
    assert.deepEqual(Object.keys(service.methods).sort(), [...methods].sort());
    for (let method of methods) {
      assert.equal(service.methods[method].resolve().resolvedRequestType.name, method + 'Request');
      assert.equal(service.methods[method].resolvedResponseType.name, method + 'Response');
    }
  }
});

test('Foyer discovery and snapshot refresh requests preserve the used enum wire values', () => {
  let graph = getProtoType(schema, 'google.internal.home.foyer.v1.GetHomeGraphRequest');
  let values = { requestId: 'r', deviceTypesToUnhideArray: [0, 1, 2, 3, 4, 5] };
  assert.equal(Buffer.from(graph.encode(values).finish()).toString('hex'), '1a01725206000102030405');
  let traits = getProtoType(schema, 'google.internal.home.foyer.v1.GetTraitsRequest');
  let request = { deviceIds: [{ uuid: 'c' }], reason: 'REASON_FETCH_CAMERA_STREAM_TRAIT' };
  assert.equal(Buffer.from(traits.encode(traits.fromObject(request)).finish()).toString('hex'), '0a030a01631811');
  assert.equal(traits.decode(Buffer.from('1863', 'hex')).reason, 99);
});

test('Foyer client header retains Android release context', () => {
  let type = getProtoType(schema, 'google.internal.home.foyer.v1.ClientEnvironment');
  let values = { platform: 1, androidClientInfo: { appReleaseVersion: '4.33.27.5' } };
  let hex = '0801120b1209342e33332e32372e35';
  assert.equal(Buffer.from(type.encode(values).finish()).toString('hex'), hex);
  assert.deepEqual(type.decode(Buffer.from(hex, 'hex')).toJSON(), values);
});

test('Foyer structure location preserves coordinates and Home/Away address labels', () => {
  let type = getProtoType(schema, 'google.internal.home.foyer.v1.Address');
  // Fixed doubles and field tags; no production encoder generates this fixture.
  let hex = '121209000000000000f03f11000000000000004032035554433a081a0253542a024354';
  assert.deepEqual(type.decode(Buffer.from(hex, 'hex')).toJSON(), {
    coordinates: { latitude: 1, longitude: 2 },
    timezone: 'UTC',
    addressComponents: { state: 'ST', city: 'CT' },
  });
});
