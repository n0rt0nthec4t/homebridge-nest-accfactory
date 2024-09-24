// Homebridge platform allowing Nest devices to be used with HomeKit
// This is a port from my standalone project, Nest_accfactory to Homebridge
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
// 'preliminary' support for using FieldTest account types also.
//
// Supports both Nest REST and protobuf APIs for communication to Nest systems
//
// Code version 24/9/2024
// Mark Hulskamp
'use strict';

// Define Homebridge module requirements
import HAP from 'hap-nodejs';

// Define nodejs module requirements
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setInterval } from 'node:timers';

// Import our modules
import NestAccfactory from './system.js';

import HomeKitDevice from './HomeKitDevice.js';
HomeKitDevice.PLUGIN_NAME = 'Nest-accfactory';
HomeKitDevice.PLATFORM_NAME = 'NestAccfactory';

import HomeKitHistory from './HomeKitHistory.js';
HomeKitDevice.HISTORY = HomeKitHistory;

import Logger from './logger.js';
const log = Logger.withPrefix(HomeKitDevice.PLATFORM_NAME);

const __filename = fileURLToPath(import.meta.url); // Make a defined for JS __dirname
const __dirname = path.dirname(fileURLToPath(import.meta.url)); // Make a defined for JS __dirname
const ACCESSORYPINCODE = '031-45-154'; // Default HomeKit pairing code
const CONFIGURATIONFILE = 'Nest_config.json'; // Default configuration file name

// General helper functions which don't need to be part of an object class
function loadConfiguration(filename) {
  if (typeof filename !== 'string' || filename === '' || fs.existsSync(filename) === false) {
    return;
  }

  let config = undefined;

  try {
    let loadedConfig = JSON.parse(fs.readFileSync(filename));

    config = {
      nest: {},
      google: {},
      options: {},
      devices: {},
    };

    Object.entries(loadedConfig).forEach(([key, value]) => {
      // Global options if not an object
      if (key === 'Connections' && typeof value === 'object') {
        // Array of 'connections' to different logins. Can be a combination of Nest, google and SDM
        Object.entries(value).forEach(([subKey, value]) => {
          if (typeof value === 'object' && typeof value?.access_token === 'string' && value.access_token !== '') {
            // Nest accounts access_token to use for Nest API calls
            config[subKey] = {
              access_token: value.access_token.trim(),
              fieldTest: value?.FieldTest === true,
            };
          }
          if (typeof value === 'object' &&
            typeof value?.issuetoken === 'string' &&
            value.issuetoken !== '' &&
            typeof value?.cookie === 'string' &&
            value.cookie !== ''
          ) {
            // Google account issue token and cookie for Nest API calls
            config[subKey] = {
              issuetoken: value.issuetoken.trim(),
              cookie: value.cookie.trim(),
              fieldTest: value?.FieldTest === true,
            };
          }
        });
      }
      if (key === 'SessionToken' && typeof value === 'string' && value !== '') {
        // Nest accounts Session token to use for Nest API calls
        // NOTE: Legacy option. Use Connections option(s)
        config['legacynest'] = {
          access_token: value.trim(),
          fieldTest: value?.FieldTest === true,
        };
      }
      if (
        key === 'GoogleToken' &&
        typeof value === 'object' &&
        typeof value?.issuetoken === 'string' &&
        value.issuetoken !== '' &&
        typeof value?.cookie === 'string' &&
        value.cookie !== ''
      ) {
        // Google account issue token and cookie for Nest API calls
        // NOTE: Legacy option. Use Connections option(s)
        config['legacygoogle'] = {
          issuetoken: value.issuetoken.trim(),
          cookie: value.cookie.trim(),
          fieldTest: value?.FieldTest === true,
        };
      }
      if (key === 'mDNS' && (typeof value === 'string') & (value !== '')) {
        if (value.trim().toUpperCase() === 'CIAO') {
          // Use ciao as the mDNS advertiser
          config.options.mDNS = HAP.MDNSAdvertiser.CIAO;
        }
        if (value.trim().toUpperCase() === 'BONJOUR') {
          // Use bonjour as the mDNS advertiser
          config.options.mDNS = HAP.MDNSAdvertiser.BONJOUR;
        }
        if (value.trim().toUpperCase() === 'AVAHI') {
          // Use avahi as the mDNS advertiser
          config.options.mDNS = HAP.MDNSAdvertiser.AVAHI;
        }
      }
      if (key === 'EveApp' && typeof value === 'boolean') {
        // Global Evehome app integration
        config.options.eveHistory = value;
      }
      if (key === 'Weather' && typeof value === 'boolean') {
        // Global weather device(s)
        config.options.weather = value;
      }
      if (key === 'HKSV' && typeof value === 'boolean') {
        // Global HomeKit Secure Video
        config.options.hksv = value;
      }
      if (key === 'HomeKitCode' && typeof value === 'string' && value !== '') {
        // Global HomeKit paring code
        config.options.hkPairingCode = value;
      }
      if (key === 'DoorbellCooldown' && typeof value === 'number') {
        if (value >= 1000) {
          // If greather than 1000, assume milliseconds value passed in, so convert to seconds
          value = Math.floor(value / 1000);
        }
        config.options.doorbellCooldown = value;
      }
      if (key === 'MotionCooldown' && typeof value === 'number') {
        if (value >= 1000) {
          // If greather than 1000, assume milliseconds value passed in, so convert to seconds
          value = Math.floor(value / 1000);
        }
        config.options.motionCooldown = value;
      }
      if (key === 'PersonCooldown' && typeof value === 'number') {
        if (value >= 1000) {
          // If greather than 1000, assume milliseconds value passed in, so convert to seconds
          value = Math.floor(value / 1000);
        }
        config.options.personCooldown = value;
      }
      if (key !== 'Connections' && key !== 'GoogleToken' && typeof value === 'object') {
        // Since key value is an object, and not an object for a value we expect
        // Ssumme its a device configuration for matching serial number
        key = key.toUpperCase();
        config.devices[key] = {};
        Object.entries(value).forEach(([subKey, value]) => {
          if (subKey === 'Exclude' && typeof value === 'boolean') {
            // Per device excluding
            config.devices[key]['exclude'] = value;
          }
          if (subKey === 'HumiditySensor' && typeof value === 'boolean') {
            // Seperate humidity sensor for this device (Only valid for thermostats)
            config.devices[key]['humiditySensor'] = value;
          }
          if (subKey === 'EveApp' && typeof value === 'boolean') {
            // Per device Evehome app integration
            config.devices[key]['eveHistory'] = value;
          }
          if (subKey === 'HKSV' && typeof value === 'boolean') {
            // Per device HomeKit Secure Video
            config.devices[key]['hksv'] = value;
          }
          if (subKey === 'Option.indoor_chime_switch' && typeof value === 'boolean') {
            // Per device silence indoor chime
            config.devices[key]['chimeSwitch'] = value;
          }
          if (subKey === 'Option.elevation' && typeof value === 'number') {
            // Per device elevation setting (for weather)
            config.devices[key]['elevation'] = value;
          }
          if (subKey === 'HomeKitCode' && typeof value === 'string' && value !== '') {
            // Per device HomeKit paring code
            config.devices[key]['hkPairingCode'] = value;
          }
          if (subKey === 'DoorbellCooldown' && typeof value === 'number') {
            if (value >= 1000) {
              // If greather than 1000, assume milliseconds value passed in, so convert to seconds
              value = Math.floor(value / 1000);
            }
            config.devices[key]['doorbellCooldown'] = value;
          }
          if (subKey === 'MotionCooldown' && typeof value === 'number') {
            if (value >= 1000) {
              // If greather than 1000, assume milliseconds value passed in, so convert to seconds
              value = Math.floor(value / 1000);
            }
            config.devices[key]['motionCooldown'] = value;
          }
          if (subKey === 'PersonCooldown' && typeof value === 'number') {
            if (value >= 1000) {
              // If greather than 1000, assume milliseconds value passed in, so convert to seconds
              value = Math.floor(value / 1000);
            }
            config.devices[key]['personCooldown'] = value;
          }
          if (subKey.startsWith('External') === true && typeof value === 'string' && value !== '') {
            config.devices[key]['external' + subKey.substring(8)] = value;
          }
        });
      }
    });

    // If we do not have a default HomeKit pairing code, add one in
    if (config?.options?.hkPairingCode === undefined) {
      config.options.hkPairingCode = ACCESSORYPINCODE;
    }

    // eslint-disable-next-line no-unused-vars
  } catch (error) {
    // Empty
  }

  return config;
}

// Startup code
log.info('Starting ' + __filename + ' using HAP-NodeJS library v' + HAP.HAPLibraryVersion());

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
log.info('Configuration will be read from "%s"', configurationFile);
let config = loadConfiguration(configurationFile);
if (config === undefined) {
  log.info('Configuration file contains invalid JSON options');
  log.info('Exiting.');
  process.exit(1);
}
if (config?.nest === undefined || config?.google === undefined) {
  log.info('Either a Nest and/or Google connection details were not specified in the configuration file');
  log.info('Exiting.');
  process.exit(1);
}

log.info(
  'Devices will be advertised to HomeKit using "%s" mDNS provider',
  typeof config?.options?.mDNS !== 'undefined' ? config.options?.mDNS : HAP.MDNSAdvertiser.CIAO,
);
let nest = new NestAccfactory(log, config, HAP);
nest.discoverDevices(); // Kick things off :-)
setInterval(nest.discoverDevices.bind(nest), 15000);