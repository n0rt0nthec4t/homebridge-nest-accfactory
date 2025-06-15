// Device support loader
// Part of homebridge-nest-accfactory
//
// Code version 2025.06.15
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import path from 'node:path';
import fs from 'node:fs/promises';
import url from 'node:url';

// Import our modules
import HomeKitDevice from './HomeKitDevice.js';

// Define constants
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const DEVICE_TYPE = Object.freeze({
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
});

async function loadDeviceModules(log, pluginDir = '') {
  let baseDir = path.join(__dirname, pluginDir);
  let deviceMap = new Map();
  let files = (await fs.readdir(baseDir)).sort();

  for (const file of files) {
    if (file.endsWith('.js') === false) {
      continue;
    }

    try {
      let module = await import(url.pathToFileURL(path.join(baseDir, file)).href);
      let exportsToCheck = Object.values(module);

      for (const exported of exportsToCheck) {
        if (typeof exported !== 'function') {
          continue;
        }

        let proto = Object.getPrototypeOf(exported);
        while (proto !== undefined && proto.name !== '') {
          if (proto === HomeKitDevice) {
            if (
              typeof exported.TYPE !== 'string' ||
              exported.TYPE === '' ||
              typeof exported.VERSION !== 'string' ||
              exported.VERSION === ''
            ) {
              log?.warn?.('Skipping device module %s (missing TYPE or VERSION)', file);
              break;
            }

            if (deviceMap.has(exported.TYPE) === false) {
              deviceMap.set(exported.TYPE, exported);
              log?.info?.('Loaded device module "%s" (v%s)', exported.TYPE, exported.VERSION);
            }

            break;
          }

          proto = Object.getPrototypeOf(proto);
        }
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

  if (type === DEVICE_TYPE.THERMOSTAT) {
    category = 9; // Categories.THERMOSTAT
  }

  if (
    type === DEVICE_TYPE.TEMPSENSOR ||
    type === DEVICE_TYPE.HEATLINK ||
    type === DEVICE_TYPE.SMOKESENSOR ||
    type === DEVICE_TYPE.WEATHER
  ) {
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
export { DEVICE_TYPE, loadDeviceModules, getDeviceHKCategory };
