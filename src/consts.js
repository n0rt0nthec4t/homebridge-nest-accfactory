// Common defines
// Part of homebridge-nest-accfactory
//
// Code version 2025.07.23
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import path from 'node:path';
import url from 'node:url';

// Define constants
export const CAMERA_ALERT_POLLING = 2000; // Camera alerts polling timer

export const CAMERA_ZONE_POLLING = 30000; // Camera zones changes polling timer

export const WEATHER_POLLING = 300000; // Weather data polling timer

export const NEST_API_TIMEOUT = 10000; // Nest API timeout

export const USER_AGENT = 'Nest/5.82.2 (iOScom.nestlabs.jasper.release) os=18.5'; // User Agent string

export const __dirname = path.dirname(url.fileURLToPath(import.meta.url)); // Make a defined for JS __dirname

export const DATA_SOURCE = {
  NEST: 'Nest', // From the Nest API
  GOOGLE: 'Google', // From the Protobuf/Google API
};

export const DAYS_OF_WEEK_FULL = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];

export const DAYS_OF_WEEK_SHORT = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

export const PROTOBUF_THERMOSTAT_RESOURCES = [
  'nest.resource.NestAmber1DisplayResource',
  'nest.resource.NestAmber2DisplayResource',
  'nest.resource.NestLearningThermostat1Resource',
  'nest.resource.NestLearningThermostat2Resource',
  'nest.resource.NestLearningThermostat3Resource',
  'nest.resource.NestAgateDisplayResource',
  'nest.resource.NestOnyxResource',
  'google.resource.GoogleZirconium1Resource',
  'google.resource.GoogleBismuth1Resource',
];

export const PROTOBUF_KRYPTONITE_RESOURCES = ['nest.resource.NestKryptoniteResource'];

export const PROTOBUF_YALE_RESOURCES = ['yale.resource.LinusLockResource'];

export const PROTOBUF_PROTECT_RESOURCES = [
  'nest.resource.NestProtect1LinePoweredResource',
  'nest.resource.NestProtect1BatteryPoweredResource',
  'nest.resource.NestProtect2LinePoweredResource',
  'nest.resource.NestProtect2BatteryPoweredResource',
  'NestProtect2Resource',
];

export const PROTOBUF_CAMERA_DOORBELL_RESOURCES = [
  'google.resource.NeonQuartzResource',
  'google.resource.GreenQuartzResource',
  'google.resource.SpencerResource',
  'google.resource.VenusResource',
  'nest.resource.NestCamIndoorResource',
  'nest.resource.NestCamIQResource',
  'nest.resource.NestCamIQOutdoorResource',
  'nest.resource.NestCamOutdoorResource',
  'nest.resource.NestHelloResource',
  'google.resource.GoogleNewmanResource',
];

export const NEST_API_BAD_OBJECTS = ['partner_programs', 'topaz_history', 'structure_metadata'];

export const DEVICE_TYPE = {
  THERMOSTAT: 'Thermostat',
  TEMPSENSOR: 'TemperatureSensor',
  SMOKESENSOR: 'Protect',
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

export const LOW_BATTERY_LEVEL = 10;

export const THERMOSTAT_MIN_TEMPERATURE = 9; // Minimum temperature for Nest Thermostat

export const THERMOSTAT_MAX_TEMPERATURE = 32; // Maximum temperature for Nest Thermostat

export const HOTWATER_MIN_TEMPERATURE = 30; // Minimum temperature for hotwater heating

export const HOTWATER_MAX_TEMPERATURE = 70; // Maximum temperature for hotwater heating

export const CAMERA_RESOURCE_IMAGES = {
  OFFLINE: 'Nest_camera_offline.jpg',
  OFF: 'Nest_camera_off.jpg',
  TRANSFER: 'Nest_camera_transfer.jpg',
};

export const CAMERA_RESOURCE_FRAMES = {
  OFFLINE: 'Nest_camera_offline.h264',
  OFF: 'Nest_camera_off.h264',
  TRANSFER: 'Nest_camera_transfer.h264',
};

export const MP4BOX = 'mp4box';

export const SNAPSHOT_CACHE_TIMEOUT = 30000; // Timeout for retaining snapshot image (in milliseconds)

export const STREAMING_PROTOCOL = {
  WEBRTC: 'PROTOCOL_WEBRTC',
  NEXUSTALK: 'PROTOCOL_NEXUSTALK',
};

export const LOG_LEVELS = {
  INFO: 'info',
  SUCCESS: 'success',
  WARN: 'warn',
  ERROR: 'error',
  DEBUG: 'debug',
};

export const RESOURCE_PATH = './res';
