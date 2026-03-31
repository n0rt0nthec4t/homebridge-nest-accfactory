// Device Module Loader
// Part of homebridge-nest-accfactory
//
// Loads and registers device support modules used by the platform.
// Discovers HomeKitDevice-based device classes, collects any additional
// exported helpers (such as processRawData), and builds a device registry
// for use by the main system module.
//
// Responsibilities:
// - Discover device support modules from the device directory
// - Load HomeKitDevice subclasses dynamically
// - Validate required module metadata (TYPE and VERSION)
// - Register optional helper exports alongside each device class
// - Provide HomeKit accessory category mapping for supported device types
//
// Features:
// - Dynamic module loading from the plugin devices directory
// - Automatic registration of HomeKitDevice subclasses
// - Support for additional exported helpers such as processRawData()
// - Version logging for loaded device modules
// - HomeKit category resolution via getDeviceHKCategory()
//
// Notes:
// - Device modules must export a class extending HomeKitDevice
// - Device classes must provide static TYPE and VERSION properties
// - Additional named exports are attached to the module entry when present
// - Used by the main system module to create and manage device instances
//
// Code version 2026.03.15
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import path from 'node:path';
import fs from 'node:fs/promises';
import url from 'node:url';

// Import our modules
import HomeKitDevice from './HomeKitDevice.js';

// Define constants
import { __dirname, DEVICE_TYPE } from './consts.js';

async function loadDeviceModules(log, pluginDir = '') {
  let baseDir = path.join(__dirname, pluginDir);
  let deviceMap = new Map();
  let files = (await fs.readdir(baseDir)).sort();

  log?.debug?.('Base module - %s', HomeKitDevice.VERSION);

  for (const file of files) {
    if (file.endsWith('.js') === false) {
      continue;
    }

    try {
      let modulePath = url.pathToFileURL(path.join(baseDir, file)).href;
      let module = await import(modulePath);

      // Check all exports for valid HomeKitDevice subclasses
      for (const exported of Object.values(module)) {
        if (typeof exported !== 'function') {
          continue;
        }

        // Only process if it's a HomeKitDevice subclass
        if (HomeKitDevice.prototype.isPrototypeOf(exported.prototype) === false) {
          continue;
        }

        // Validate TYPE and VERSION
        if (typeof exported.TYPE !== 'string' || exported.TYPE === '' || typeof exported.VERSION !== 'string' || exported.VERSION === '') {
          log?.warn?.('Skipping device module %s (missing TYPE or VERSION)', file);
          continue;
        }

        // Register this class if not already registered
        if (deviceMap.has(exported.TYPE) === false) {
          let entry = { class: exported };

          // Add additional named functions (like processRawData)
          for (const [key, value] of Object.entries(module)) {
            if (typeof value === 'function' && value !== exported) {
              entry[key] = value;
            }
          }

          deviceMap.set(exported.TYPE, entry);
          log?.debug?.('%s module - %s', exported.TYPE, exported.VERSION);
        }
      }
    } catch (error) {
      log?.warn?.('Failed to load device support module "%s": %s', file, error.message);
    }
  }

  return deviceMap;
}

function getDeviceHKCategory(type) {
  let category = 1; // Categories.OTHER

  if (type === DEVICE_TYPE.LOCK) {
    category = 6; // Categories.DOOR_LOCK
  }

  if (type === DEVICE_TYPE.HEATLINK) {
    category = 8; // Categories.SWITCH
  }

  if (type === DEVICE_TYPE.THERMOSTAT) {
    category = 9; // Categories.THERMOSTAT
  }

  if (type === DEVICE_TYPE.TEMPSENSOR || type === DEVICE_TYPE.PROTECT || type === DEVICE_TYPE.WEATHER) {
    category = 10; // Categories.SENSOR
  }

  if (type === DEVICE_TYPE.ALARM) {
    category = 11; // Categories.SECURITY_SYSTEM
  }

  if (type === DEVICE_TYPE.CAMERA || type === DEVICE_TYPE.FLOODLIGHT) {
    category = 17; // Categories.IP_CAMERA
  }

  if (type === DEVICE_TYPE.DOORBELL) {
    category = 18; // Categories.VIDEO_DOORBELL
  }

  return category;
}

// Define exports
export { loadDeviceModules, getDeviceHKCategory };
