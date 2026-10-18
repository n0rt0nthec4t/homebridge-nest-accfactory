// Shared complete cloud fixtures for discovery, mapper contracts and configuration precedence.
import { DATA_SOURCE, DEVICE_TYPE } from '../../src/consts.js';

export let config = { options: { ffmpeg: {}, eveHistory: true }, devices: [], homes: [] };
export let home = {
  source: DATA_SOURCE.GOOGLE,
  value: { located_annotations: { predefinedWheres: { room: { whereId: { resourceId: 'ROOM' }, label: { literal: 'Kitchen' } } } } },
};
let common = {
  device_identity: { serialNumber: 'TEST', softwareVersion: '1.0.0' },
  device_info: { typeName: 'nest.resource.NestLearningThermostat3Resource', pairerId: { resourceId: 'STRUCTURE_HOME' } },
  configuration_done: { deviceReady: true },
  label: { label: 'Device' },
  device_located_settings: { whereAnnotationRid: { resourceId: 'ROOM' } },
  liveness: { status: 'LIVENESS_DEVICE_STATUS_ONLINE' },
};
let camera = {
  ...common,
  device_info: { ...common.device_info, typeName: 'google.resource.SpencerResource' },
  streaming_protocol: { supportedProtocols: ['PROTOCOL_WEBRTC'] },
  recording_toggle: { currentCameraState: 'CAMERA_ON' },
  microphone_settings: { enableMicrophone: true },
  speaker_volume: { volume: 50 },
  observation_trigger_capabilities: { videoEventTypes: { motion: { value: true } } },
};
let thermostat = {
  ...common,
  display_settings: { temperatureScale: 'TEMPERATURE_SCALE_C' },
  current_temperature: { temperatureValue: { temperature: { value: 21 } } },
  hvac_equipment_capabilities: { hasStage1Heat: true, hasHotWaterControl: true, hasHotWaterTemperature: true },
  heat_link: {
    heatLinkSerialNumber: { value: 'HEATLINK' },
    heatLinkModel: { value: 'Amber-2' },
    heatLinkSwVersion: { value: '1.2.3' },
  },
  heat_link_settings: { heatConnectionType: 'HEAT_LINK_CONNECTION_TYPE_OPENTHERM' },
  hot_water_settings: { boostTimerEnd: { seconds: '0' }, temperature: { value: 55 } },
};
export let fixtures = [
  { name: 'camera', type: DEVICE_TYPE.CAMERA, value: camera },
  {
    name: 'doorbell',
    type: DEVICE_TYPE.DOORBELL,
    value: {
      ...camera,
      device_info: { ...common.device_info, typeName: 'google.resource.GreenQuartzResource' },
      doorbell_indoor_chime_settings: { chimeType: 'CHIME_TYPE_MECHANICAL', chimeEnabled: true },
    },
  },
  {
    name: 'floodlight',
    type: DEVICE_TYPE.FLOODLIGHT,
    value: {
      ...camera,
      device_info: { ...common.device_info, typeName: 'google.resource.NeonQuartzResource' },
      related_resources: {
        relatedResources: {
          light: {
            resourceId: { resourceId: 'SERVICE_LIGHT' },
            resourceTypeName: { resourceName: 'google.resource.AzizResource' },
          },
        },
      },
      floodlight_settings: { brightness: 5 },
      floodlight_state: { currentState: 'LIGHT_STATE_ON' },
    },
  },
  { name: 'thermostat', type: DEVICE_TYPE.THERMOSTAT, value: thermostat },
  { name: 'heatlink', type: DEVICE_TYPE.HEATLINK, value: thermostat },
  {
    name: 'protect',
    type: DEVICE_TYPE.PROTECT,
    value: {
      ...common,
      device_info: { ...common.device_info, typeName: 'nest.resource.NestProtect2BatteryPoweredResource' },
      safety_alarm_smoke: {},
      safety_alarm_co: {},
      legacy_protect_device_settings: { replaceByDate: { seconds: '2000000000' } },
    },
  },
  {
    name: 'lock',
    type: DEVICE_TYPE.LOCK,
    value: {
      ...common,
      device_info: { ...common.device_info, typeName: 'yale.resource.LinusLockResource' },
      tamper: {},
      bolt_lock: { lockedState: 'BOLT_LOCKED_STATE_LOCKED' },
      battery_power_source: { remaining: { remainingPercent: { value: 0.8 } } },
      bolt_lock_settings: { autoRelockDuration: { seconds: '60' } },
      bolt_lock_capabilities: { maxAutoRelockDuration: { seconds: '300' } },
    },
  },
  {
    name: 'homeaway',
    type: DEVICE_TYPE.HOMEAWAY,
    id: 'STRUCTURE_HOME',
    parents: {},
    value: {
      structure_info: { rtsStructureId: 'structure.home', name: 'Home' },
      structure_mode: { structureMode: 'STRUCTURE_MODE_HOME' },
    },
  },
];

let nestCamera = {
  serial_number: 'TEST',
  structure_id: 'home',
  where_id: 'ROOM',
  model: 'Nest Cam',
  software_version: '1.0.0',
  description: 'Device',
  streaming_state: 'enabled',
  audio_input_enabled: true,
  capabilities: [],
  nexus_api_http_server_url: 'https://camera.invalid',
  properties: { 'cc2migration.overview_state': 'NORMAL' },
};
for (let name of ['camera', 'doorbell']) {
  fixtures.push({
    name,
    type: name === 'camera' ? DEVICE_TYPE.CAMERA : DEVICE_TYPE.DOORBELL,
    source: DATA_SOURCE.NEST,
    id: 'quartz.TEST',
    parents: { 'where.home': { value: { wheres: [{ where_id: 'ROOM', name: 'Kitchen' }] } } },
    value: { ...nestCamera, capabilities: name === 'doorbell' ? ['indoor_chime'] : [] },
  });
}
fixtures.push({
  name: 'protect',
  type: DEVICE_TYPE.PROTECT,
  source: DATA_SOURCE.NEST,
  id: 'topaz.TEST',
  parents: {
    'where.home': { value: { wheres: [{ where_id: 'ROOM', name: 'Kitchen' }] } },
    'safety.home': { value: { manual_self_test_in_progress: false } },
    'widget_track.AABB': { value: { online: true } },
  },
  value: {
    serial_number: 'TEST',
    structure_id: 'home',
    where_id: 'ROOM',
    software_version: '1.0.0',
    description: 'Device',
    thread_mac_address: 'aabb',
    smoke_status: 0,
    co_status: 0,
    replace_by_date_utc_secs: 2000000000,
  },
});
