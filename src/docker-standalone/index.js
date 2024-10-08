// HAP-NodeJS acessory allowing Nest devices to be used with HomeKit
// This is a wrapper around homebridge-nest-accessory to replicate Nest_accfactory
// using common code based with homebridge-nest-accfactory
//
// This includes having support for HomeKit Secure Video (HKSV) on doorbells and cameras
//
// The following Nest devices are supported
//
// Nest Thermostats (1st gen, 2nd gen, 3rd gen, E, 2020 mirror edition, 4th gen)
// Nest Protects (1st and 2nd gen)
// Nest Temp Sensors (1st gen)
// Nest Cameras (Cam Indoor, IQ Indoor, Outdoor, IQ Outdoor, Cam with Floodlight)
// Nest Doorbells (wired 1st gen)
//
// The accessory supports authentication to Nest/Google using either a Nest account OR Google (migrated Nest account) account.
// "preliminary" support for using FieldTest account types also.
//
// Supports both Nest REST and Protobuf APIs for communication
//
// Code version 5/10/2024
// Mark Hulskamp
'use strict';

// Define HAP-NodeJS module requirements
import HAP from 'hap-nodejs';

// Define nodejs module requirements
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setInterval } from 'node:timers';
import { createRequire } from 'node:module';

// Import our modules
import NestAccfactory from './system.js';

import HomeKitDevice from './HomeKitDevice.js';
HomeKitDevice.PLUGIN_NAME = 'Nest-accfactory';
HomeKitDevice.PLATFORM_NAME = 'NestAccfactory';

import HomeKitHistory from './HomeKitHistory.js';
HomeKitDevice.HISTORY = HomeKitHistory;

import Logger from './logger.js';
const log = Logger.withPrefix(HomeKitDevice.PLATFORM_NAME);

// Import the package.json file to get the version number
const { version } = createRequire(import.meta.url)('../package.json');

const __dirname = path.dirname(fileURLToPath(import.meta.url)); // Make a defined for JS __dirname
const ACCESSORYPINCODE = '031-45-154'; // Default HomeKit pairing code
const CONFIGURATIONFILE = 'Nest_config.json'; // Default configuration file name

// General helper functions which don't need to be part of an object class
function loadConfiguration(filename) {
  if (typeof filename !== 'string' || filename === '' || fs.existsSync(filename) === false) {
    return;
  }

  let config = undefined;
  let legacyFormat = false;

  try {
    let loadedConfig = JSON.parse(fs.readFileSync(filename));

    config = {
      options: {},
      devices: {},
    };

    // Load in 'current' configuration structure if present
    // Most of the code below is to handle the 'legacy' structure
    if (typeof loadedConfig?.Connections?.Nest === 'object') {
      legacyFormat = true;
      config.nest = loadedConfig.Connections.Nest;
    }
    if (typeof loadedConfig?.SessionToken === 'string' && loadedConfig.SessionToken !== '') {
      legacyFormat = true;
      config.nest = {
        access_token: loadedConfig.SessionToken,
        fieldTest: false,
      };
    }
    if (typeof loadedConfig?.Connections?.Google === 'object') {
      legacyFormat = true;
      config.google = loadedConfig.Connections.Google;
    }
    if (typeof loadedConfig?.Connections?.GoogleToken === 'object') {
      legacyFormat = true;
      config.google = loadedConfig.Connections.GoogleToken;
    }
    if (typeof loadedConfig?.options === 'object') {
      config.options = loadedConfig.options;
    }
    if (typeof loadedConfig?.devices === 'object') {
      config.devices = loadedConfig.devices;
    }

    Object.entries(loadedConfig).forEach(([key, value]) => {
      if (key === 'Debug' && (value === true || (typeof value === 'string' && value !== ''))) {
        // Debugging enabled
        legacyFormat = true;
        config.options.debug = value === true || (typeof value === 'string' && value !== '');
      }
      if (key === 'EveApp' && typeof value === 'boolean') {
        // Evehome app integration
        legacyFormat = true;
        config.options.eveHistory = value;
      }
      if (key === 'Weather' && typeof value === 'boolean') {
        // weather device(s)
        legacyFormat = true;
        config.options.weather = value;
      }
      if (key === 'HKSV' && typeof value === 'boolean') {
        // HomeKit Secure Video
        legacyFormat = true;
        config.options.hksv = value;
      }
      if (key === 'HomeKitCode' && typeof value === 'string' && value !== '') {
        // HomeKit paring code
        legacyFormat = true;
        config.options.hkPairingCode = value;
      }
      if (key === 'Elevation' && isNaN(value) === false) {
        // Weather location elevation
        legacyFormat = true;
        config.options.elevation = Number(value);
      }
      if (typeof value === 'object' && value?.access_token !== undefined && value?.access_token !== '') {
        // Nest access_token
        config[key.toLocaleLowerCase()] = {
          access_token: value?.access_token,
          fieldTest: value?.fieldTest === true,
        };
      }
      if (
        typeof value === 'object' &&
        value?.issuetoken !== undefined &&
        value?.issuetoken !== '' &&
        value?.cookie !== undefined &&
        value?.cookie !== ''
      ) {
        // Google issue token/cookie
        config[key.toLocaleLowerCase()] = {
          issuetoken: value?.issuetoken,
          cookie: value?.cookie,
          fieldTest: value?.fieldTest === true,
        };
      }

      if (
        key !== 'Connections' &&
        key !== 'SessionToken' &&
        key !== 'GoogleToken' &&
        key !== 'google' &&
        key !== 'nest' &&
        key !== 'options' &&
        key !== 'devices' &&
        typeof value === 'object'
      ) {
        // Since key value is an object, and not an object for a value we expect
        // Ssumme its a device configuration for matching serial number
        key = key.toUpperCase();
        Object.entries(value).forEach(([subKey, value]) => {
          if (subKey === 'Exclude' && typeof value === 'boolean') {
            // Per device excluding
            legacyFormat = true;
            if (config.devices?.[key] === undefined) {
              config.devices[key] = {};
            }
            config.devices[key]['exclude'] = value;
          }
          if (subKey === 'HumiditySensor' && typeof value === 'boolean') {
            // Seperate humidity sensor for this device (Only valid for thermostats)
            legacyFormat = true;
            if (config.devices?.[key] === undefined) {
              config.devices[key] = {};
            }
            config.devices[key]['humiditySensor'] = value;
          }
          if (subKey === 'EveApp' && typeof value === 'boolean') {
            // Per device Evehome app integration
            legacyFormat = true;
            if (config.devices?.[key] === undefined) {
              config.devices[key] = {};
            }
            config.devices[key]['eveHistory'] = value;
          }
          if (subKey === 'HKSV' && typeof value === 'boolean') {
            // Per device HomeKit Secure Video
            legacyFormat = true;
            if (config.devices?.[key] === undefined) {
              config.devices[key] = {};
            }
            config.devices[key]['hksv'] = value;
          }
          if (subKey === 'Option.indoor_chime_switch' && typeof value === 'boolean') {
            // Per device silence indoor chime
            legacyFormat = true;
            if (config.devices?.[key] === undefined) {
              config.devices[key] = {};
            }
            config.devices[key]['chimeSwitch'] = value;
          }
          if (subKey === 'Option.elevation' && isNaN(value) === false) {
            // Per device elevation setting (for weather)
            legacyFormat = true;
            if (config.devices?.[key] === undefined) {
              config.devices[key] = {};
            }
            config.devices[key]['elevation'] = Number(value);
          }
          if ((subKey === 'HomeKitCode' || subKey === 'hkPairingCode') && typeof value === 'string' && value !== '') {
            // Per device HomeKit paring code
            legacyFormat = true;
            if (config.devices?.[key] === undefined) {
              config.devices[key] = {};
            }
            config.devices[key]['hkPairingCode'] = value;
          }
          if (subKey === 'DoorbellCooldown' && isNaN(value) === false) {
            value = Number(value);
            if (value >= 1000) {
              // If greather than 1000, assume milliseconds value passed in, so convert to seconds
              value = Math.floor(value / 1000);
            }
            legacyFormat = true;
            if (config.devices?.[key] === undefined) {
              config.devices[key] = {};
            }
            config.devices[key]['doorbellCooldown'] = value;
          }
          if (subKey === 'MotionCooldown' && isNaN(value) === false) {
            value = Number(value);
            if (value >= 1000) {
              // If greather than 1000, assume milliseconds value passed in, so convert to seconds
              value = Math.floor(value / 1000);
            }
            legacyFormat = true;
            if (config.devices?.[key] === undefined) {
              config.devices[key] = {};
            }
            config.devices[key]['motionCooldown'] = value;
          }
          if (subKey === 'PersonCooldown' && isNaN(value) === false) {
            value = Number(value);
            if (value >= 1000) {
              // If greather than 1000, assume milliseconds value passed in, so convert to seconds
              value = Math.floor(value / 1000);
            }
            legacyFormat = true;
            if (config.devices?.[key] === undefined) {
              config.devices[key] = {};
            }
            config.devices[key]['personCooldown'] = value;
          }
          legacyFormat = true;
          if (subKey.startsWith('External') === true && typeof value === 'string' && value !== '') {
            if (config.devices?.[key] === undefined) {
              config.devices[key] = {};
            }
            config.devices[key]['external' + subKey.substring(8)] = value;
          }
        });
      }
    });

    // If we do not have a default HomeKit pairing code, add one in
    if (config?.options?.hkPairingCode === undefined) {
      config.options.hkPairingCode = ACCESSORYPINCODE;
    }

    // See if we flagged any legacy format options, if so, put warning to user to check and upgrade format/options
    if (legacyFormat === true) {
      log.prefix = '';
      log.warn('');
      log.warn('NOTICE');
      log.warn('> The loaded configuration file contains legacy options. Please review the readme at the link below');
      log.warn('> Consider updating these in your configuration file as the mapping from legacy to current options maybe removed');
      log.warn('> https://github.com/n0rt0nthec4t/homebridge-nest-accfactory/blob/main/src/docker-standalone/README.md');
      log.warn('');
      log.prefix = HomeKitDevice.PLATFORM_NAME;
    }

    // eslint-disable-next-line no-unused-vars
  } catch (error) {
    // Empty
  }

  return config;
}

// Startup code
log.success(HomeKitDevice.PLUGIN_NAME + ' v' + version + ' (HAP v' + HAP.HAPLibraryVersion() + ') (Node v' + process.versions.node + ')');

// Check to see if a configuration file was passed into use and validate if present
let configurationFile = path.resolve(__dirname + '/' + CONFIGURATIONFILE);
if (process.argv.slice(2).length === 1) {
  // We only support/process one argument
  configurationFile = process.argv.slice(2)[0]; // Extract the file name from the argument passed in
  if (configurationFile.indexOf('/') === -1) {
    configurationFile = path.resolve(__dirname + '/' + configurationFile);
  }
}
if (fs.existsSync(configurationFile) === false) {
  // Configuration file, either by default name or specified on commandline is missing
  log.error('Specified configuration "%s" cannot be found', configurationFile);
  log.error('Exiting.');
  process.exit(1);
}

// Have a configuration file, now load the configuration options
let config = loadConfiguration(configurationFile);
if (config === undefined) {
  log.info('Configuration file contains invalid JSON options');
  log.info('Exiting.');
  process.exit(1);
}

log.info('Loaded configuration from "%s"', configurationFile);

// Enable debugging if configured
if (config?.options?.debug === true) {
  Logger.setDebugEnabled();
  log.warn('Debugging has been enabled');
}

let nest = new NestAccfactory(log, config, HAP);
nest.discoverDevices(); // Kick things off :-)
setInterval(nest.discoverDevices.bind(nest), 15000);
