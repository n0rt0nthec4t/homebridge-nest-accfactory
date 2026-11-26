// Translate captured camera buckets independently of media transport and events.
import { getResourceKey } from '../src/utils.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { importSource } from './helpers/import-source.js';
import { DATA_SOURCE, DEVICE_TYPE } from '../src/consts.js';
import { fixtures } from './helpers/discovery-fixtures.js';

let { processRawData } = await importSource(new URL('../src/plugins/camera.js', import.meta.url));
let doorbell = await importSource(new URL('../src/plugins/doorbell.js', import.meta.url));
let config = { options: { ffmpeg: {} }, homes: [], devices: [] };
function fixture(legacy = false) {
  return {
    [getResourceKey('account', 'HomeGraph', 'home', 'STRUCTURE')]: {
      source: DATA_SOURCE.HOMEGRAPH,
      connection: 'account',
      value: { home: { uuid: 'home', name: 'Home', rooms: [{ uuid: 'room', name: 'Outside' }] } },
    },
    [getResourceKey('account', 'HomeGraph', 'camera')]: {
      source: DATA_SOURCE.HOMEGRAPH,
      connection: 'account',
      value: {
        structureId: 'home',
        roomId: 'room',
        technicalInformation: { serialNumber: 'CAMERA', model: legacy === true ? 'NEST_HELLO.0' : 'NEST_CAM_OUTDOOR.0' },
        googleHome: {
          id: { googleUuid: 'camera', thirdPartyId: { idType: 'nest-home-assistant-prod' } },
          type: legacy === true ? 'action.devices.types.DOORBELL' : 'action.devices.types.CAMERA',
          displayName: 'Outside',
          hardware: {
            model: legacy === true ? 'Nest Doorbell' : 'Nest Cam Outdoor',
            softwareVersion: legacy === true ? '4110055' : 'nestcamoutdoor-user 1 OPENMASTER 14120018 release-keys',
          },
          traits: ['action.devices.traits.CameraStream', 'action.devices.traits.MotionDetection'],
        },
        'deviceStatus.online': { boolean: true },
        'onOff.onOff': { boolean: true },
        'cameraStream.audioCommunicationType': { text: legacy === true ? 'FDX' : 'HDX' },
        'attributes.cameraStream.cameraStreamSupportedProtocols': {
          array: { values: (legacy === true ? ['nexustalk', 'rtsp', 'hls'] : ['webrtc', 'mpegdash']).map((text) => ({ text })) },
        },
        'attributes.cameraStream.aspectRatio': {
          properties: {
            properties: [
              { name: 'width', value: { number: legacy === true ? 4 : 16 } },
              { name: 'height', value: { number: legacy === true ? 3 : 9 } },
            ],
          },
        },
        'cameraStream.streamHost': {
          properties: {
            properties: [
              { name: 'nexustalk', value: { text: 'nttrap-us1.dropcam.com' } },
              { name: 'hlsmaster', value: { text: 'https://nest-camera-frontend.googleapis.com/hlsplaylist/example' } },
              { name: 'mpegdash', value: { text: 'https://nest-camera-frontend.googleapis.com/dashmanifest/example' } },
            ],
          },
        },
        'cameraStream.preMigration': {
          properties: { properties: [{ name: 'cameraStreamSupportedProtocols', value: { array: { values: [{ text: 'nexustalk' }] } } }] },
        },
        'migration.legacyCameraMigrationStatus': { text: legacy === true ? 'unknown' : 'succeeded' },
      },
    },
  };
}
function map(raw, changed, type) {
  return processRawData(undefined, raw, config, type, changed)?.CAMERA;
}

test('HomeGraph cameras do not substitute the plugin version for missing firmware', () => {
  let raw = fixture();
  for (let value of [undefined, '', '   ']) {
    raw[getResourceKey('account', 'HomeGraph', 'camera')].value.googleHome.hardware.softwareVersion = value;
    assert.equal(map(raw).data.softwareVersion, undefined);
  }
});

for (let legacy of [false, true]) {
  test(
    'captured ' +
      (legacy === true ? 'NexusTalk doorbell' : 'migrated WebRTC camera') +
      ' translates known fields and keeps missing settings unknown',
    () => {
      let raw = fixture(legacy);
      let before = structuredClone(raw);
      let result = map(raw);
      assert.equal(result.full, false);
      assert.equal(result.data.serialNumber, 'CAMERA');
      assert.equal(result.data.type, legacy === true ? DEVICE_TYPE.DOORBELL : DEVICE_TYPE.CAMERA);
      assert.equal(result.data.model, legacy === true ? 'Nest Doorbell' : 'Cam Outdoor (1st gen, wired)');
      assert.deepEqual(
        result.data.streaming_protocols,
        legacy === true ? ['PROTOCOL_NEXUSTALK'] : ['PROTOCOL_WEBRTC', 'PROTOCOL_MPEGDASH'],
      );
      assert.equal(result.data.aspect_ratio, legacy === true ? 4 / 3 : 16 / 9);
      assert.equal(result.data.online, true);
      assert.equal(result.data.streaming_enabled, true);
      assert.equal(result.data.has_microphone, true);
      assert.equal(result.data.has_speaker, true);
      assert.equal(result.data.has_motion_detection, true);
      assert.equal(result.data.audio_enabled, undefined);
      assert.equal(result.data.motion_detection_enabled, undefined);
      assert.equal(result.data.events, undefined);
      assert.equal(result.data.apiAccess, undefined);
      assert.equal(result.data.source, undefined);
      assert.equal(result.data.nexustalk_host, 'nttrap-us1.dropcam.com');
      assert.equal(result.data.hls_url, 'https://nest-camera-frontend.googleapis.com/hlsplaylist/example');
      assert.equal(result.data.migrating, legacy === true ? undefined : false);
      assert.deepEqual(raw, before);
      if (legacy === true) {
        assert.equal(doorbell.processRawData(undefined, raw, config, DEVICE_TYPE.DOORBELL).CAMERA.full, false);
        assert.equal(map(raw, undefined, DEVICE_TYPE.CAMERA), undefined);
      }
    },
  );
}

test('camera partial deltas translate cached state and scoped home naming', () => {
  let raw = fixture();
  raw[getResourceKey('account', 'HomeGraph', 'camera')].value['onOff.onOff'].boolean = false;
  raw[getResourceKey('account', 'HomeGraph', 'camera')].value['deviceStatus.online'].boolean = false;
  let result = map(
    raw,
    new Map([[getResourceKey('account', 'HomeGraph', 'camera'), { fields: new Set(['onOff.onOff', 'deviceStatus.online']) }]]),
  );
  assert.equal(result.data.streaming_enabled, false);
  assert.equal(result.data.online, false);
  raw[getResourceKey('account', 'HomeGraph', 'home', 'STRUCTURE')].value.home.rooms[0].name = 'Garden';
  assert.equal(map(raw, new Map([[getResourceKey('account', 'HomeGraph', 'home', 'STRUCTURE'), {}]])).data.description, 'Outside - Garden');
  assert.equal(map(raw, new Map([['other-device', {}]])), undefined);
  raw[getResourceKey('account', 'HomeGraph', 'home', 'STRUCTURE')].connection = 'other';
  assert.equal(map(raw), undefined);
});

for (let [prefix, expected] of [
  ['quartz-user', 'Cam Indoor (1st gen)'],
  ['venus-user', 'Doorbell (2nd gen, wired)'],
  ['nq-user', 'Cam (2nd gen, battery)'],
  ['gq-user', 'Doorbell (2nd gen, battery)'],
  ['spencer-user', 'Cam (2nd gen, wired)'],
  ['bla4-user', 'Cam Outdoor (2nd gen, wired)'],
  ['2rs4-user', 'Doorbell (3rd gen, wired)'],
  ['linosa-user', 'Nest Cam Outdoor'],
  ['rhodes-user', 'Nest Cam Outdoor'],
  ['ustica-user', 'Cam Indoor (3rd gen, wired)'],
  ['rquartz-user', 'Doorbell (1st gen, wired)'],
  ['unknown-user', 'Nest Cam Outdoor'],
]) {
  test('camera firmware model prefix ' + prefix, () => {
    let raw = fixture();
    delete raw[getResourceKey('account', 'HomeGraph', 'camera')].value.technicalInformation.model;
    raw[getResourceKey('account', 'HomeGraph', 'camera')].value.googleHome.hardware.softwareVersion = prefix + ' 1 release';
    assert.equal(map(raw).data.model, expected);
  });
}

test('camera scalar limits and protocol fallback preserve unknown values', () => {
  let raw = fixture();
  let value = raw[getResourceKey('account', 'HomeGraph', 'camera')].value;
  value['audioSettings.microphoneEnabled'] = { boolean: false };
  value['charging.capacityRemainingPercentage'] = { number: 48.5 };
  assert.equal(map(raw).data.audio_enabled, false);
  assert.equal(map(raw).data.battery_level, 49);
  value['charging.capacityRemainingPercentage'] = { number: Infinity };
  value['charging.descriptiveCapacityRemaining'] = { text: 'low' };
  assert.equal(map(raw).data.battery_level, 10);
  value['attributes.cameraStream.aspectRatio'].properties.properties[1].value.number = 0;
  assert.equal(map(raw).data.aspect_ratio, undefined);
  delete value['attributes.cameraStream.cameraStreamSupportedProtocols'];
  value.attributes = { fields: { cameraStreamSupportedProtocols: { listValue: { values: [{ stringValue: 'webrtc' }] } } } };
  assert.deepEqual(map(raw).data.streaming_protocols, ['PROTOCOL_WEBRTC']);
  delete value.attributes;
  assert.equal(map(raw).data.streaming_protocols, undefined);
});

for (let changed of [
  undefined,
  getResourceKey('account', 'HomeGraph', 'camera'),
  getResourceKey('account', 'HomeGraph', 'home', 'STRUCTURE'),
  'DEVICE_PROTO',
]) {
  test('camera field preference retains HomeGraph routing and fills missing fields from protobuf: ' + changed, () => {
    let raw = fixture();
    raw.DEVICE_PROTO = { source: DATA_SOURCE.PROTOBUF, value: structuredClone(fixtures.find((entry) => entry.name === 'camera').value) };
    raw.DEVICE_PROTO.value.device_identity.serialNumber = 'CAMERA';
    raw.STRUCTURE_HOME = { value: {} };
    let result = map(raw, changed === undefined ? undefined : new Map([[changed, {}]]));
    assert.equal(result.full, true);
    assert.equal(result.data.nest_google_device_uuid, getResourceKey('account', 'HomeGraph', 'camera'));
  });
}

test('HomeGraph doorbell Quiet Time deltas use the shared camera mapper without inventing chime settings', () => {
  let raw = fixture(true);
  let value = raw[getResourceKey('account', 'HomeGraph', 'camera')].value;
  let future = Math.floor(Date.now() / 1000) + 600;
  value['quietTime.quietTimeEnabled'] = { boolean: true };
  value['quietTime.endTime'] = { number: future };
  let before = structuredClone(raw);
  let result = doorbell.processRawData(undefined, raw, config, DEVICE_TYPE.DOORBELL)?.CAMERA;
  assert.equal(result.data.quiet_time_ends, future);
  assert.equal(result.data.has_indoor_chime, undefined);
  assert.equal(result.data.indoor_chime_enabled, undefined);
  assert.equal(result.full, false);
  assert.deepEqual(raw, before);
  value['quietTime.quietTimeEnabled'].boolean = false;
  result = doorbell.processRawData(
    undefined,
    raw,
    config,
    DEVICE_TYPE.DOORBELL,
    new Map([[getResourceKey('account', 'HomeGraph', 'camera'), { fields: new Set(['quietTime.quietTimeEnabled']) }]]),
  )?.CAMERA;
  assert.equal(result.data.quiet_time_ends, 0);
  assert.equal(result.data.type, DEVICE_TYPE.DOORBELL);
  assert.equal(value['quietTime.endTime'].number, future);
});

for (let legacy of [false, true]) {
  test('HomeGraph event types provide motion and doorbell capabilities without implying enabled state: ' + legacy, () => {
    let raw = fixture(legacy);
    let value = raw[getResourceKey('account', 'HomeGraph', 'camera')].value;
    value.googleHome.traits = ['action.devices.traits.CameraStream'];
    value['entitlement.triggerCapabilities'] = {
      array: { values: (legacy === true ? ['motionSeen', 'doorbell'] : ['motionSeen']).map((text) => ({ text })) },
    };
    let before = structuredClone(raw);
    let result = map(raw);
    assert.equal(result.data.has_motion_detection, true);
    assert.equal(result.data.type, legacy === true ? DEVICE_TYPE.DOORBELL : DEVICE_TYPE.CAMERA);
    assert.equal(result.data.motion_detection_enabled, undefined);
    assert.equal(result.data.serialNumber, 'CAMERA');
    assert.deepEqual(raw, before);
    value['entitlement.triggerCapabilities'].array.values = [{ text: 'soundHeard' }, { text: 'personSeen' }];
    result = map(
      raw,
      new Map([[getResourceKey('account', 'HomeGraph', 'camera'), { fields: new Set(['entitlement.triggerCapabilities']) }]]),
    );
    assert.equal(result.data.has_motion_detection, false);
    assert.equal(result.data.type, legacy === true ? DEVICE_TYPE.DOORBELL : DEVICE_TYPE.CAMERA);
  });
}

test('HomeGraph doorbell event capability classifies cameras without adding unrelated capability fields', () => {
  let raw = fixture();
  let value = raw[getResourceKey('account', 'HomeGraph', 'camera')].value;
  value['entitlement.triggerCapabilities'] = { array: { values: [{ text: 'doorbell' }] } };
  let result = map(raw);
  assert.equal(result.data.type, DEVICE_TYPE.DOORBELL);
  assert.equal(result.data.has_motion_detection, false);
  assert.equal(result.data.has_sound_detection, undefined);
  assert.equal(result.data.has_person_detection, undefined);
  // Without a supplied capability list the existing advertised-trait fallback applies.
  for (let invalid of [undefined, { array: { values: {} } }]) {
    value['entitlement.triggerCapabilities'] = invalid;
    assert.equal(map(raw).data.has_motion_detection, true);
    assert.equal(map(raw).data.type, DEVICE_TYPE.CAMERA);
  }
  value['entitlement.triggerCapabilities'] = { array: { values: [] } };
  assert.equal(map(raw).data.has_motion_detection, false);
});

let floodlight = await importSource(new URL('../src/plugins/floodlight.js', import.meta.url));
function floodlightFixture() {
  let raw = fixture();
  raw[getResourceKey('account', 'HomeGraph', 'camera')].value.floodlightId = 'light';
  raw[getResourceKey('account', 'HomeGraph', 'light')] = {
    connection: 'account',
    source: DATA_SOURCE.HOMEGRAPH,
    value: {
      structureId: 'home',
      googleHome: {
        id: { googleUuid: 'light', thirdPartyId: { idType: 'nest-home-assistant-prod', id: 'private-light' } },
        type: 'action.devices.types.LIGHT',
      },
      'onOff.onOff': { boolean: false },
      'brightness.brightness': { number: 37 },
    },
  };
  return raw;
}

for (let [power, brightness] of [
  [false, 0],
  [true, 37],
  [true, 100],
]) {
  test('HomeGraph floodlight maps its linked light without protobuf brightness scaling: ' + power + '/' + brightness, () => {
    let raw = floodlightFixture();
    raw[getResourceKey('account', 'HomeGraph', 'light')].value['onOff.onOff'].boolean = power;
    raw[getResourceKey('account', 'HomeGraph', 'light')].value['brightness.brightness'].number = brightness;
    let before = structuredClone(raw);
    let data = floodlight.processRawData(undefined, raw, config, DEVICE_TYPE.FLOODLIGHT)?.CAMERA.data;
    assert.equal(data.type, DEVICE_TYPE.FLOODLIGHT);
    assert.equal(data.serialNumber, 'CAMERA');
    assert.equal(data.nest_google_device_uuid, getResourceKey('account', 'HomeGraph', 'camera'));
    assert.equal(data.has_light, true);
    assert.equal(data.light_enabled, power);
    assert.equal(data.light_brightness, brightness);
    assert.equal(data.floodlightId, undefined);
    assert.equal(data.source, undefined);
    assert.deepEqual(raw, before);
  });
}

test('HomeGraph child-only floodlight deltas re-evaluate the owning camera and retain the other light field', () => {
  let raw = floodlightFixture();
  raw[getResourceKey('account', 'HomeGraph', 'light')].value['onOff.onOff'].boolean = true;
  let changed = new Map([[getResourceKey('account', 'HomeGraph', 'light'), { fields: new Set(['onOff.onOff']) }]]);
  let result = floodlight.processRawData(undefined, raw, config, DEVICE_TYPE.FLOODLIGHT, changed)?.CAMERA;
  assert.equal(result.data.light_enabled, true);
  assert.equal(result.data.light_brightness, 37);
  assert.deepEqual(floodlight.processRawData(undefined, raw, config, DEVICE_TYPE.FLOODLIGHT, new Map([['unrelated', {}]])), {});
});

for (let invalid of ['unlinked', 'missing', 'account', 'home', 'provider', 'camera']) {
  test('HomeGraph floodlight does not map an unverified light: ' + invalid, () => {
    let raw = floodlightFixture();
    let light = raw[getResourceKey('account', 'HomeGraph', 'light')];
    if (invalid === 'unlinked') {
      delete raw[getResourceKey('account', 'HomeGraph', 'camera')].value.floodlightId;
    }
    if (invalid === 'missing') {
      delete raw[getResourceKey('account', 'HomeGraph', 'light')];
    }
    if (invalid === 'account') {
      light.connection = 'other';
    }
    if (invalid === 'home') {
      light.value.structureId = 'other';
    }
    if (invalid === 'provider') {
      light.value.googleHome.id.thirdPartyId.idType = 'third-party';
    }
    if (invalid === 'camera') {
      light.value.googleHome.type = 'action.devices.types.CAMERA';
    }
    assert.deepEqual(floodlight.processRawData(undefined, raw, config, DEVICE_TYPE.FLOODLIGHT), {});
  });
}

for (let brightness of [undefined, null, '50', -1, 101, NaN, Infinity]) {
  test('HomeGraph floodlight preserves unknown or malformed brightness: ' + String(brightness), () => {
    let raw = floodlightFixture();
    raw[getResourceKey('account', 'HomeGraph', 'light')].value['brightness.brightness'] = { number: brightness };
    assert.equal(floodlight.processRawData(undefined, raw, config, DEVICE_TYPE.FLOODLIGHT)?.CAMERA.data.light_brightness, undefined);
  });
}

test('HomeGraph floodlight fills missing camera fields from protobuf and retains native light scaling', () => {
  let raw = floodlightFixture();
  raw.DEVICE_PROTO = { source: DATA_SOURCE.PROTOBUF, value: structuredClone(fixtures.find((entry) => entry.name === 'floodlight').value) };
  raw.DEVICE_PROTO.value.device_identity.serialNumber = 'CAMERA';
  raw.STRUCTURE_HOME = { value: {} };
  let changed = new Map([[getResourceKey('account', 'HomeGraph', 'light'), { fields: new Set(['brightness.brightness']) }]]);
  let result = floodlight.processRawData(undefined, raw, config, DEVICE_TYPE.FLOODLIGHT, changed)?.CAMERA;
  assert.equal(result.full, true);
  assert.equal(result.data.nest_google_device_uuid, getResourceKey('account', 'HomeGraph', 'camera'));
  assert.equal(result.data.serialNumber, 'CAMERA');
  assert.equal(result.data.light_brightness, 37);
});

test('an unresolved floodlight association cannot reclassify an existing floodlight as a generic camera', () => {
  let raw = floodlightFixture();
  delete raw[getResourceKey('account', 'HomeGraph', 'light')];
  let result = map(raw);
  assert.equal(result.full, false);
  assert.equal(result.data.type, undefined);
});

for (let [resource, expected] of [
  ['google.resource.GreenQuartzResource', 'Doorbell (2nd gen, battery)'],
  ['google.resource.UsticaResource', 'Cam Indoor (3rd gen, wired)'],
  ['google.resource.SpencerResource', 'Cam (2nd gen, wired)'],
  ['google.resource.VenusResource', 'Doorbell (2nd gen, wired)'],
  ['google.resource.RhodesResource', 'Doorbell (3rd gen, wired)'],
  ['nest.resource.NestCamOutdoorResource', 'Cam Outdoor (1st gen, wired)'],
  ['google.resource.LinosaResource', 'Cam Outdoor (2nd gen, wired)'],
  ['nest.resource.NestCamIndoorResource', 'Cam Indoor (1st gen)'],
  ['nest.resource.NestCamIQResource', 'Cam IQ Indoor (1st gen)'],
  ['nest.resource.NestCamIQOutdoorResource', 'Cam IQ Outdoor (1st gen, wired)'],
  ['nest.resource.NestHelloResource', 'Doorbell (1st gen, wired)'],
  ['google.resource.GoogleNewmanResource', 'Max Hub (1st gen, wired)'],
]) {
  test('protobuf camera model lookup preserves ' + resource, () => {
    let value = structuredClone(fixtures.find((entry) => entry.name === 'camera').value);
    value.device_info.typeName = resource;
    let raw = { DEVICE_PROTO: { source: DATA_SOURCE.PROTOBUF, value }, STRUCTURE_HOME: { value: {} } };
    assert.equal(processRawData(undefined, raw, config)?.TEST.data.model, expected);
  });
}

for (let linked of [true, false]) {
  test('protobuf camera model distinguishes the related floodlight service: ' + linked, () => {
    let value = structuredClone(fixtures.find((entry) => entry.name === 'floodlight').value);
    if (linked === false) {
      delete value.related_resources;
    }
    let raw = { DEVICE_PROTO: { source: DATA_SOURCE.PROTOBUF, value }, STRUCTURE_HOME: { value: {} } };
    assert.equal(
      processRawData(undefined, raw, config)?.TEST.data.model,
      linked === true ? 'Cam with Floodlight (1st gen, wired)' : 'Cam (2nd gen, battery)',
    );
  });
}

test('migrated Nest Hello model resolves from its captured firmware prefix', () => {
  let raw = fixture(true);
  delete raw[getResourceKey('account', 'HomeGraph', 'camera')].value.technicalInformation.model;
  raw[getResourceKey('account', 'HomeGraph', 'camera')].value.googleHome.hardware.softwareVersion =
    'rquartz-user 1 OPENMASTER 517480023 release-keys stable-channel stable-channel';
  assert.equal(map(raw).data.model, 'Doorbell (1st gen, wired)');
});

test('HomeGraph floodlight model uses the verified light association despite a shared camera firmware family', () => {
  let raw = floodlightFixture();
  raw[getResourceKey('account', 'HomeGraph', 'camera')].value.googleHome.hardware.softwareVersion = 'nq-user 1 release';
  let changed = new Map([[getResourceKey('account', 'HomeGraph', 'light'), { fields: new Set(['googleHome']) }]]);
  assert.equal(
    floodlight.processRawData(undefined, raw, config, DEVICE_TYPE.FLOODLIGHT, changed)?.CAMERA.data.model,
    'Cam with Floodlight (1st gen, wired)',
  );
});

test('unknown firmware names cannot resolve inherited object properties as camera models', () => {
  let raw = fixture();
  delete raw[getResourceKey('account', 'HomeGraph', 'camera')].value.technicalInformation.model;
  for (let prefix of ['__proto__', 'constructor']) {
    raw[getResourceKey('account', 'HomeGraph', 'camera')].value.googleHome.hardware.softwareVersion = prefix;
    assert.equal(map(raw).data.model, 'Nest Cam Outdoor');
  }
});

for (let reverse of [false, true]) {
  test('camera field preference is independent of source order and preserves false, zero and related identities: ' + reverse, () => {
    let raw = fixture();
    let id = getResourceKey('account', DATA_SOURCE.HOMEGRAPH, 'camera');
    raw[id].value.technicalInformation.serialNumber = ' camera ';
    raw[id].value['deviceStatus.online'].boolean = false;
    raw[id].value['onOff.onOff'].boolean = false;
    raw[id].value['charging.capacityRemainingPercentage'] = { number: 0 };
    raw.DEVICE_PROTO = {
      source: DATA_SOURCE.PROTOBUF,
      connection: 'protobuf-account',
      value: structuredClone(fixtures.find((entry) => entry.name === 'camera').value),
    };
    raw.DEVICE_PROTO.value.device_identity.serialNumber = 'CAMERA';
    raw.STRUCTURE_HOME = { value: {} };
    if (reverse === true) {
      raw = Object.fromEntries(Object.entries(raw).reverse());
    }
    let before = structuredClone(raw);
    for (let changed of [id, 'DEVICE_PROTO', getResourceKey('account', DATA_SOURCE.HOMEGRAPH, 'home', 'STRUCTURE')]) {
      let result = map(raw, new Map([[changed, {}]]));
      assert.equal(result.full, true);
      assert.equal(result.data.serialNumber, 'CAMERA');
      assert.equal(result.data.online, false);
      assert.equal(result.data.streaming_enabled, false);
      assert.equal(result.data.battery_level, 0);
      assert.equal(result.data.audio_enabled, true, 'missing preferred field uses the translator fallback');
      assert.equal(result.data.nest_google_device_uuid, id);
      assert.equal(result.data.nest_google_home_uuid, getResourceKey('account', DATA_SOURCE.HOMEGRAPH, 'home', 'STRUCTURE'));
    }
    assert.deepEqual(raw, before);
    delete raw[id].value['deviceStatus.online'];
    assert.equal(map(raw, new Map([['DEVICE_PROTO', {}]])).data.online, true);
    delete raw[getResourceKey('account', DATA_SOURCE.HOMEGRAPH, 'home', 'STRUCTURE')];
    assert.equal(
      map(raw, new Map([[getResourceKey('account', DATA_SOURCE.HOMEGRAPH, 'home', 'STRUCTURE'), {}]])).data.nest_google_device_uuid,
      'DEVICE_PROTO',
    );
  });
}

test('camera mapping honours a field-map preference override rather than source-pass order', () => {
  let raw = fixture();
  raw.DEVICE_PROTO = { source: DATA_SOURCE.PROTOBUF, value: structuredClone(fixtures.find((entry) => entry.name === 'camera').value) };
  raw.DEVICE_PROTO.value.device_identity.serialNumber = 'CAMERA';
  raw.STRUCTURE_HOME = { value: {} };
  raw[getResourceKey('account', DATA_SOURCE.HOMEGRAPH, 'camera')].value['deviceStatus.online'].boolean = false;
  let result = processRawData(undefined, raw, config, undefined, undefined, {
    online: {
      required: true,
      prefer: 'google',
      google: { fields: ['liveness'], translate: ({ raw }) => raw.value.liveness.status === 'LIVENESS_DEVICE_STATUS_ONLINE' },
      googlehome: { fields: ['deviceStatus.online'], translate: ({ raw }) => raw.value['deviceStatus.online'].boolean },
    },
  }).CAMERA;
  assert.equal(result.data.online, true);
  assert.equal(result.data.nest_google_device_uuid, getResourceKey('account', DATA_SOURCE.HOMEGRAPH, 'camera'));
});
