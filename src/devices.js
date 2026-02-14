// Device support loader
// Part of homebridge-nest-accfactory
//
// Code version 2026.02.14
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

  log?.debug?.('Base module "v%s"', HomeKitDevice.VERSION);

  for (const file of files) {
    if (file.endsWith('.js') === false) {
      continue;
    }

    try {
      let modulePath = url.pathToFileURL(path.join(baseDir, file)).href;
      let module = await import(modulePath);
      let chosenClass = undefined;

      // First pass: find a valid subclass of HomeKitDevice
      for (const exported of Object.values(module)) {
        if (
          typeof exported === 'function' &&
          HomeKitDevice.prototype.isPrototypeOf(exported.prototype) &&
          typeof exported.TYPE === 'string' &&
          typeof exported.VERSION === 'string'
        ) {
          chosenClass = exported;
          break; // first valid one wins (like your original)
        }
      }

      if (chosenClass && deviceMap.has(chosenClass.TYPE) === false) {
        let entry = { class: chosenClass };

        // Add additional named functions (like processRawData)
        for (const [key, value] of Object.entries(module)) {
          if (typeof value === 'function' && value !== chosenClass) {
            entry[key] = value;
          }
        }

        deviceMap.set(chosenClass.TYPE, entry);
        log?.info?.('Loaded %s module "v%s"', chosenClass.TYPE, chosenClass.VERSION);
      }
    } catch (error) {
      log?.warn?.('Failed to load device support file "%s": %s', file, error.message);
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
