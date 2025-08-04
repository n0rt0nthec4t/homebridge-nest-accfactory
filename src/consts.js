// Common defines
// Part of homebridge-nest-accfactory
//
// Code version 2025.07.30
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import path from 'node:path';
import url from 'node:url';

// Define constants
export const TIMERS = {
  ALERTS: 2000, // Camera alert polling interval (ms)
  ZONES: 30000, // Camera zone polling interval (ms)
  WEATHER: 300000, // Weather data refresh interval (ms)
  NEST_API: 10000, // Nest API request timeout (ms)
  TALKBACK_AUDIO: 1000, // Audio talkback timeout (ms)
  SNAPSHOT: 30000, // Timeout for retaining snapshot image timeout (ms)
};

export const USER_AGENT = 'Nest/5.82.2 (iOScom.nestlabs.jasper.release) os=18.5'; // User Agent string

export const __dirname = path.dirname(url.fileURLToPath(import.meta.url)); // Make a defined for JS __dirname

export const DATA_SOURCE = {
  NEST: 'Nest', // From the Nest API
  GOOGLE: 'Google', // From the Protobuf/Google API
};

export const DAYS_OF_WEEK_FULL = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];

export const DAYS_OF_WEEK_SHORT = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

export const PROTOBUF_RESOURCES = {
  THERMOSTAT: [
    'nest.resource.NestAmber1DisplayResource',
    'nest.resource.NestAmber2DisplayResource',
    'nest.resource.NestLearningThermostat1Resource',
    'nest.resource.NestLearningThermostat2Resource',
    'nest.resource.NestLearningThermostat3Resource',
    'nest.resource.NestAgateDisplayResource',
    'nest.resource.NestOnyxResource',
    'google.resource.GoogleZirconium1Resource',
    'google.resource.GoogleBismuth1Resource',
  ],
  HEATLINK: ['nest.resource.NestAgateHeatlinkResource'],
  KRYPTONITE: ['nest.resource.NestKryptoniteResource'],
  LOCK: ['yale.resource.LinusLockResource'],
  PROTECT: [
    'nest.resource.NestProtect1LinePoweredResource',
    'nest.resource.NestProtect1BatteryPoweredResource',
    'nest.resource.NestProtect2LinePoweredResource',
    'nest.resource.NestProtect2BatteryPoweredResource',
    'nest.resource.NestProtect2Resource',
  ],
  CAMERA: [
    'google.resource.GreenQuartzResource',
    'google.resource.SpencerResource',
    'google.resource.VenusResource',
    'nest.resource.NestCamIndoorResource',
    'nest.resource.NestCamIQResource',
    'nest.resource.NestCamIQOutdoorResource',
    'nest.resource.NestCamOutdoorResource',
    'nest.resource.NestHelloResource',
    'google.resource.GoogleNewmanResource',
  ],
  DOORBELL: ['nest.resource.NestHelloResource', 'google.resource.GreenQuartzResource', 'google.resource.VenusResource'],
  FLOODLIGHT: ['google.resource.NeonQuartzResource', 'google.resource.AzizResource'],
  CONNECT: ['nest.resource.NestConnectResource'],
  DETECT: ['nest.resource.NestDetectResource'],
  GUARD: ['nest.resource.NestHelloResource'],
};

export const NEST_API_BUCKETS = [
  'buckets',
  'delayed_topaz',
  'demand_response',
  'device',
  'device_alert_dialog',
  'geofence_info',
  'kryptonite',
  'link',
  'message',
  'message_center',
  'metadata',
  'occupancy',
  'quartz',
  'safety',
  'rcs_settings',
  'safety_summary',
  'schedule',
  'shared',
  'structure',
  'structure_metadata',
  'topaz',
  'topaz_resource',
  'track',
  'trip',
  'tuneups',
  'user',
  'user_settings',
  'where',
  'widget_track',
];

export const DEVICE_TYPE = {
  THERMOSTAT: 'Thermostat',
  TEMPSENSOR: 'TemperatureSensor',
  PROTECT: 'Protect',
  CAMERA: 'Camera',
  DOORBELL: 'Doorbell',
  FLOODLIGHT: 'FloodlightCamera',
  WEATHER: 'Weather',
  HEATLINK: 'Heatlink',
  LOCK: 'Lock',
  ALARM: 'Alarm',
};

export const FFMPEG_VERSION = '6.0.0';

export const ACCOUNT_TYPE = {
  NEST: 'Nest',
  GOOGLE: 'Google',
};

export const LOW_BATTERY_LEVEL = 10; // Low battery level percentage

export const THERMOSTAT_MIN_TEMPERATURE = 9; // Minimum temperature for Nest Thermostat

export const THERMOSTAT_MAX_TEMPERATURE = 32; // Maximum temperature for Nest Thermostat

export const HOTWATER_MIN_TEMPERATURE = 30; // Minimum temperature for hotwater heating

export const HOTWATER_MAX_TEMPERATURE = 70; // Maximum temperature for hotwater heating

export const RESOURCE_PATH = './res';
export const RESOURCE_IMAGES = {
  CAMERA_OFFLINE: 'Nest_camera_offline.jpg',
  CAMERA_OFF: 'Nest_camera_off.jpg',
  CAMERA_TRANSFER: 'Nest_camera_transfer.jpg',
};

export const RESOURCE_FRAMES = {
  CAMERA_OFFLINE: 'Nest_camera_offline.h264',
  CAMERA_OFF: 'Nest_camera_off.h264',
  CAMERA_TRANSFER: 'Nest_camera_transfer.h264',
};

export const LOG_LEVELS = {
  INFO: 'info',
  SUCCESS: 'success',
  WARN: 'warn',
  ERROR: 'error',
  DEBUG: 'debug',
};

export const NESTLABS_MAC_PREFIX = '18B430';
