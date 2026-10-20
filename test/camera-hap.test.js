// Exercise camera-family setup, characteristic controls, upstream state and removal with real HAP controllers.
// Protocol transports and FFmpeg probes are isolated; source lifecycle and Streamer remain real.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import childProcess from 'node:child_process';
import { readFile } from 'node:fs/promises';
import hap from './helpers/homebridge-hap.js';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import HomeKitDevice from '../src/HomeKitDevice/HomeKitDevice.js';
import FFmpeg from '../src/plugins/camera/ffmpeg.js';
import { TIMERS } from '../src/consts.js';
import { importSource } from './helpers/import-source.js';

let C = hap.Characteristic;
let transport =
  'data:text/javascript,' +
  encodeURIComponent(
    'import StreamTransport from ' +
      JSON.stringify(new URL('../src/plugins/camera/streamtransport.js', import.meta.url).href) +
      ';' +
      'export default class extends StreamTransport {' +
      'async doOpen() { this.setState(StreamTransport.STATE.READY); }' +
      'async doClose() { this.setState(StreamTransport.STATE.CLOSED); } }',
  );
let location = new URL('../src/plugins/camera.js', import.meta.url);
let source = (await readFile(location, 'utf8')).replace(
  /from '(\.\/camera\/(?:webrtc|nexustalk)\.js)'/g,
  () => 'from ' + JSON.stringify(transport),
);
let classes = { camera: (await importSource(location, source)).default };
for (let name of ['doorbell', 'floodlight']) {
  classes[name] = (await importSource(new URL('../src/plugins/' + name + '.js', import.meta.url))).default;
}
HomeKitDevice.PLUGIN_NAME = 'camera-hap-test';
let serial = 0;
async function setup(context, name = 'camera', data = {}, prepareAccessory = undefined) {
  context.mock.method(childProcess, 'spawnSync', () => ({ error: new Error('Fixture probe unavailable') }));
  context.mock.method(FFmpeg.prototype, 'supportsEncoder', () => true);
  let device = new classes[name](
    undefined,
    { version: 2.7, hap },
    {
      serialNumber: 'CAMERA-HAP-' + serial++,
      softwareVersion: '1.0.0',
      manufacturer: 'Nest',
      model: 'Camera (battery)',
      description: name,
      type: classes[name].TYPE,
      nest_google_device_uuid: 'DEVICE_CAMERA',
      online: true,
      streaming_enabled: true,
      audio_enabled: true,
      maxStreams: 2,
      battery_level: 80,
      motionCooldown: 30,
      doorbellCooldown: 5,
      has_motion_detection: true,
      motion_detection_enabled: true,
      has_microphone: true,
      has_speaker: true,
      speaker_volume: 50,
      has_statusled: true,
      statusled_brightness: 0,
      has_irled: true,
      irled_enabled: true,
      has_video_flip: true,
      video_flipped: false,
      has_light: name === 'floodlight',
      light_enabled: false,
      light_brightness: 50,
      has_indoor_chime: true,
      indoor_chime_enabled: true,
      events: [],
      streaming_protocols: ['PROTOCOL_WEBRTC'],
      ffmpeg: { valid: true, binary: 'fixture', hwaccel: false, transcode: false },
      ...data,
    },
  );
  device.accessory = new hap.Accessory(name, hap.uuid.generate(device.deviceData.serialNumber));
  prepareAccessory?.(device.accessory);
  let writes = [];
  device.set = async (values) => {
    writes.push(values);
  };
  context.after(() => device.remove());
  // Exercise the same base/subclass hook sequence as the lifecycle without publishing an accessory.
  await classes.camera.prototype.onAdd.call(device);
  if (name !== 'camera') {
    await device.onAdd();
  }
  await device.update({});
  return { device, writes };
}
for (let name of ['camera', 'doorbell', 'floodlight']) {
  test(name + ' creates real HKSV services and reflects upstream software-off and recovery', async (context) => {
    let flow = await setup(context, name);
    let device = flow.device;
    let accessory = device.accessory;
    let controller = device.controller;
    assert.equal(controller instanceof (name === 'doorbell' ? hap.DoorbellController : hap.CameraController), true);
    assert.notEqual(controller.recordingManagement, undefined);
    let service = controller.recordingManagement.operatingModeService;
    await device.update({ streaming_enabled: false, audio_enabled: false, events: [] });
    assert.equal(service.getCharacteristic(C.HomeKitCameraActive).value, C.HomeKitCameraActive.OFF);
    assert.equal(controller.microphoneService.getCharacteristic(C.Mute).value, true);
    await device.update({ streaming_enabled: true, audio_enabled: true });
    assert.equal(service.getCharacteristic(C.HomeKitCameraActive).value, C.HomeKitCameraActive.ON);
    assert.equal(controller.microphoneService.getCharacteristic(C.Mute).value, false);
    assert.equal(device.controller, controller);
    assert.equal(device.accessory, accessory);
    assert.deepEqual(flow.writes, []);
    await device.remove();
    assert.equal(device.controller, undefined);
    assert.equal(device.streamer, undefined);
  });
}
for (let [label, type, value, expected] of [
  ['status LED off', C.CameraOperatingModeIndicator, false, { statusled_brightness: 1 }],
  ['night vision off', C.NightVision, false, { irled_enabled: 'always_off' }],
  ['camera off', C.HomeKitCameraActive, 0, { streaming_enabled: false }],
]) {
  test('camera HomeKit control: ' + label, async (context) => {
    let flow = await setup(context);
    let service = flow.device.controller.recordingManagement.operatingModeService;
    await service.getCharacteristic(type).handleSetRequest(value);
    assert.deepEqual(flow.writes, [{ uuid: 'DEVICE_CAMERA', ...expected }]);
  });
}
test('camera recording audio control forwards enable/disable to the device', async (context) => {
  let flow = await setup(context);
  let service = flow.device.controller.recordingManagement.recordingManagementService;
  assert.equal(await service.getCharacteristic(C.RecordingAudioActive).handleGetRequest(), C.RecordingAudioActive.ENABLE);
  await service.getCharacteristic(C.RecordingAudioActive).handleSetRequest(C.RecordingAudioActive.DISABLE);
  assert.deepEqual(flow.writes, [{ uuid: 'DEVICE_CAMERA', audio_enabled: false }]);
});
test('motion, detection disable, offline and shutdown clear the same HomeKit service', async (context) => {
  let flow = await setup(context);
  let device = flow.device;
  let service = device.motionService;
  let event = { id: 'motion-1', types: ['motion'] };
  await device.update({ events: [event] });
  assert.equal(service.getCharacteristic(C.MotionDetected).value, true);
  await device.update({ events: [], motion_detection_enabled: false });
  assert.equal(service.getCharacteristic(C.MotionDetected).value, false);
  await device.update({ motion_detection_enabled: true, events: [event] });
  assert.equal(service.getCharacteristic(C.MotionDetected).value, true);
  await device.onTimer({ timer: TIMERS.MOTION_COOLDOWN.name });
  assert.equal(service.getCharacteristic(C.MotionDetected).value, false);
  await device.update({ events: [{ ...event, id: 'motion-2' }] });
  await device.onShutdown();
  assert.equal(service.getCharacteristic(C.MotionDetected).value, false);
  assert.equal(device.motionService, service);
});
for (let [label, data] of [
  ['not battery powered', { model: 'Camera' }],
  ['no optional controls', { has_statusled: false, has_irled: false, has_video_flip: false, has_microphone: false, has_speaker: false }],
  ['no FFmpeg', { ffmpeg: {} }],
  ['protocol unavailable', { streaming_protocols: [] }],
  ['NexusTalk', { streaming_protocols: ['PROTOCOL_NEXUSTALK'] }],
  ['migration', { migrating: true }],
]) {
  test('camera capability setup: ' + label, async (context) => {
    let flow = await setup(context, 'camera', data);
    let device = flow.device;
    assert.notEqual(device.controller, undefined);
    if (label === 'not battery powered') {
      assert.equal(device.batteryService, undefined);
    }
    if (label === 'no FFmpeg') {
      assert.equal(device.controller.recordingManagement, undefined);
    }
    if (label === 'protocol unavailable' || label === 'migration') {
      assert.equal(device.streamer, undefined);
    }
    assert.deepEqual(flow.writes, []);
  });
}
test('camera protocol replacement and migration preserve controller identity', async (context) => {
  let flow = await setup(context);
  let device = flow.device;
  let controller = device.controller;
  await device.update({ streaming_protocols: ['PROTOCOL_NEXUSTALK'] });
  assert.equal(device.controller, controller);
  await device.update({ migrating: true });
  assert.equal(device.streamer, undefined);
  await device.update({ migrating: false, streaming_protocols: ['PROTOCOL_WEBRTC'] });
  assert.notEqual(device.streamer, undefined);
  assert.equal(device.controller, controller);
});

for (let [label, data, available] of [
  ['online', {}, true],
  ['offline', { online: false }, true],
  ['software off', { streaming_enabled: false }, true],
  ['migration', { migrating: true }, true],
  ['missing upstream image', {}, false],
]) {
  test('camera snapshot callback: ' + label, async (context) => {
    let flow = await setup(context, 'camera', data);
    let image = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
    let requests = [];
    flow.device.get = async (values) => {
      requests.push(values);
      return { camera_snapshot: available === true ? image : undefined };
    };
    let result;
    await flow.device.handleSnapshotRequest({}, (error, snapshot) => {
      result = { error, snapshot };
    });
    if (available === true) {
      assert.equal(result.error, null);
      assert.equal(Buffer.isBuffer(result.snapshot), true);
      assert.ok(result.snapshot.length > 0);
    } else {
      assert.match(result.error.message, /Unable to obtain/);
      assert.equal(result.snapshot, undefined);
    }
    assert.equal(requests.length, label === 'online' || label === 'missing upstream image' ? 1 : 0);
    if (label === 'online') {
      assert.equal(result.snapshot, image);
    }
  });
}
test('HKSV active changes start and stop the real retained buffer without recreating its controller', async (context) => {
  let flow = await setup(context);
  let controller = flow.device.controller;
  await flow.device.update({ speaker_volume: 51 });
  assert.notEqual(flow.device.streamer, undefined);
  await flow.device.updateRecordingActive(true);
  assert.equal(flow.device.streamer.isBuffering(), true);
  await flow.device.updateRecordingActive(true);
  assert.equal(flow.device.controller, controller);
  await flow.device.updateRecordingActive(false);
  assert.equal(flow.device.streamer.isBuffering(), false);
});

test('cached camera cleanup retains the primary motion service and replaces obsolete services', async (context) => {
  let primary;
  let legacyMotion;
  let legacyMode;
  let flow = await setup(context, 'camera', {}, (accessory) => {
    primary = accessory.addService(hap.Service.MotionSensor, 'Primary', 1);
    legacyMotion = accessory.addService(hap.Service.MotionSensor, 'Legacy', 2);
    legacyMode = accessory.addService(hap.Service.CameraOperatingMode, 'Old mode');
    accessory.context = { hksv: false };
  });
  assert.equal(flow.device.motionService, primary);
  assert.equal(flow.device.accessory.services.includes(legacyMotion), false);
  assert.equal(flow.device.accessory.services.includes(legacyMode), false);
  assert.equal(flow.device.accessory.services.filter((service) => service.UUID === hap.Service.MotionSensor.UUID).length, 1);
});
for (let active of [false, true]) {
  test('camera offline/online notifications restore motion and HKSV prebuffer only when active=' + active, async (context) => {
    let flow = await setup(context);
    let device = flow.device;
    await device.update({ events: [{ id: 'before-offline', types: ['motion'] }], speaker_volume: 51 });
    let management = device.controller.recordingManagement.recordingManagementService;
    management.updateCharacteristic(C.Active, active === true ? C.Active.ACTIVE : C.Active.INACTIVE);
    await device.updateRecordingActive(true);
    assert.equal(device.streamer.isBuffering(), true);
    await device.onMessage(HomeKitDevice.OFFLINE, {});
    assert.equal(device.motionService.getCharacteristic(C.MotionDetected).value, false);
    assert.equal(device.motionService.getCharacteristic(C.StatusActive).value, false);
    assert.equal(device.streamer.isBuffering(), false);
    await device.onMessage(HomeKitDevice.ONLINE, {});
    assert.equal(device.motionService.getCharacteristic(C.StatusActive).value, true);
    assert.equal(device.streamer.isBuffering(), active);
  });
}
for (let enabled of [false, true]) {
  test('camera optional control getters and matching writes: enabled=' + enabled, async (context) => {
    let flow = await setup(context, 'camera', {
      statusled_brightness: enabled === true ? 0 : 1,
      irled_enabled: enabled,
      streaming_enabled: enabled,
      video_flipped: enabled,
      audio_enabled: enabled,
    });
    let operating = flow.device.controller.recordingManagement.operatingModeService;
    for (let [type, expected] of [
      [C.CameraOperatingModeIndicator, enabled],
      [C.NightVision, enabled],
      [C.ImageRotation, enabled === true ? 180 : 0],
    ]) {
      assert.equal(await operating.getCharacteristic(type).handleGetRequest(), expected);
    }
    await operating.getCharacteristic(C.CameraOperatingModeIndicator).handleSetRequest(enabled);
    await operating.getCharacteristic(C.NightVision).handleSetRequest(enabled);
    await operating.getCharacteristic(C.HomeKitCameraActive).handleSetRequest(enabled === true ? 1 : 0);
    let recording = flow.device.controller.recordingManagement.recordingManagementService;
    await recording.getCharacteristic(C.RecordingAudioActive).handleSetRequest(enabled === true ? 1 : 0);
    assert.deepEqual(flow.writes, []);
  });
}
for (let events of [undefined, {}, [{ id: 'poll-motion', types: ['motion'] }]]) {
  test('camera event polling publishes ' + (Array.isArray(events) === true ? 'motion' : 'an empty event list'), async (context) => {
    let flow = await setup(context);
    let requests = [];
    flow.device.get = async (request) => {
      requests.push(request);
      return { camera_events: events };
    };
    await flow.device.onTimer({ timer: TIMERS.CAMERA_EVENTS.name });
    await setImmediate();
    assert.deepEqual(requests, [{ uuid: 'DEVICE_CAMERA', camera_events: true }]);
    assert.deepEqual(flow.device.deviceData.events, Array.isArray(events) === true ? events : []);
    assert.equal(flow.device.motionService.getCharacteristic(C.MotionDetected).value, Array.isArray(events));
  });
}
test('camera battery transitions distinguish charging and preserve the same service', async (context) => {
  let flow = await setup(context);
  let service = flow.device.batteryService;
  for (let [battery, charging, low] of [
    [10, false, true],
    [11, true, false],
    [100, true, false],
    [0, false, true],
    [10, false, true],
  ]) {
    await flow.device.update({ battery_level: battery });
    assert.equal(service.getCharacteristic(C.BatteryLevel).value, battery);
    assert.equal(
      service.getCharacteristic(C.ChargingState).value,
      charging === true ? C.ChargingState.CHARGING : C.ChargingState.NOT_CHARGING,
    );
    assert.equal(
      service.getCharacteristic(C.StatusLowBattery).value,
      low === true ? C.StatusLowBattery.BATTERY_LEVEL_LOW : C.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );
    assert.equal(flow.device.batteryService, service);
  }
});
