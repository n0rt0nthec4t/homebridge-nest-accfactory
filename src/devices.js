// Device support loader
// Part of homebridge-nest-accfactory
//
// Dynamically discovers and loads device plugin modules from the plugins directory
// Each plugin module exports a device class extending HomeKitDevice
// Manages device instantiation, initialization, and lifecycle across Nest and Google APIs
//
// Device plugins supported:
// - Camera, Doorbell: WebRTC and legacy Nest streaming
// - Thermostat: HVAC control with humidity management
// - Lock: Door unlock control
// - Floodlight: Camera with lighting control
// - Protect: Security/smoke detection
// - TempSensor, Weather: Environmental sensors
// - Others: Platform-specific devices (Heatlink, etc.)
//
// Module exports:
// - loadDeviceModules(log, pluginDir) - asynchronously load all device plugin classes
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
