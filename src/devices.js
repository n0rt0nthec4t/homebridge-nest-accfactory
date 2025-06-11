// Device support loader
// Part of homebridge-nest-accfactory
//
// Code version 2025.06.11
// Mark Hulskamp
'use strict';

import path from 'node:path';
import fs from 'node:fs/promises';
import url from 'node:url';

import HomeKitDevice from './HomeKitDevice.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

export async function loadDeviceModules(log, pluginDir = '') {
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
        while (proto && proto.name !== '') {
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

            if (!deviceMap.has(exported.TYPE)) {
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

export function getDeviceHKCategory(type) {
  let category = 1; // Categories.OTHER
  if (type === 'Thermostat') {
    category = 9; // Categories.THERMOSTAT
  }

  if (type === 'TemperatureSensor' || type === 'Heatlink' || type === 'Protect' || type === 'Weather') {
    category = 10; // Categories.SENSOR
  }

  if (type === 'Camera' || type === 'FloodlightCamera') {
    category = 17; // Categories.IP_CAMERA
  }

  if (type === 'Doorbell') {
    category = 18; // Categories.VIDEO_DOORBELL
  }

  return category;
}
