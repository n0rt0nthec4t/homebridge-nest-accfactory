// External Module: Daikin HVAC Controller
// Part of homebridge-nest-accfactory
//
// Provides external thermostat control for a Daikin WiFi-connected air
// conditioning system via the Daikin HTTP API (/aircon/set_control_info).
// Designed to integrate with the thermostat external module hook so that
// HomeKit mode changes control an independent HVAC system.
//
// Responsibilities:
// - Translate HomeKit thermostat actions into Daikin API commands
// - Manage HVAC modes (cool, heat, dehumidifier, fan, off)
// - Retain accepted state for safe power-off requests
// - Provide optional filtering of supported control modes
//
// Features:
// - Supports cooling, heating, dehumidifier, fan, and power-off control
// - Maps HomeKit fan percentage to Daikin discrete fan levels
// - Maintains the last accepted mode, temperature, humidity, and fan settings
// - Validates and normalises system URL before enabling control
// - Shared fetchWrapper integration for HTTP requests
// - Optional "modes=" filter to expose only selected functions
//
// Notes:
// - Per command state with no read-back from the Daikin system
// - off() requires a previously established operating state
// - Intended for use via thermostat external module configuration
// - Returns a set of control functions dynamically based on configuration
//
// Usage:
// - default(logger, [url])
// - default(logger, [url, deviceDescription])
// - default(logger, [url, deviceDescription, 'modes=cool,fan,off'])
//
// Code version 2026.10.14
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { URL, URLSearchParams } from 'node:url';

// Import our modules
import { fetchWrapper } from '../fetchWrapper.js';

// Define constants
const POWER = {
  ON: 1,
  OFF: 0,
};

const MODE = {
  AUTO: 7,
  DEHUMIDIFIER: 2,
  COOL: 3,
  HEAT: 4,
  FAN: 6,
};

const FAN_RATE = {
  AUTO: 'A',
  QUIET: 'B',
  LEVEL1: '3',
  LEVEL2: '4',
  LEVEL3: '5',
  LEVEL4: '6',
  LEVEL5: '7',
};

const FAN_DIRECTION = {
  STOP: 0,
  VERTICAL: 1,
  HORIZONTAL: 2,
  SWING: 3,
};

const LOG_LEVELS = {
  INFO: 'info',
  SUCCESS: 'success',
  WARN: 'warn',
  ERROR: 'error',
  DEBUG: 'debug',
};

export default (logger, options) => {
  // ESM caches the module, so mutable destination and command state must belong to each factory invocation.
  let systemURL = undefined;
  let log = undefined;
  let logPrefix = '[External]';
  let lastSettings = undefined; // Only parameters acknowledged by the unit are safe to reuse for power-off.

  // The thermostat awaits external calls; this module only sends a command and retains accepted settings.
  async function sendCommand(settings) {
    if (systemURL === undefined || (settings === undefined && lastSettings === undefined)) {
      return;
    }

    let control =
      settings === undefined
        ? { ...lastSettings, pow: POWER.OFF }
        : { pow: POWER.ON, f_rate: FAN_RATE.AUTO, f_dir: FAN_DIRECTION.SWING, ...settings };
    try {
      let url = systemURL + '/aircon/set_control_info?' + new URLSearchParams(control).toString();
      let response = await fetchWrapper(fetchWrapper.GET, url, {});
      let data = await response.text();
      if (data.split(',').some((field) => field.trim() === 'ret=OK') === false) {
        throw new Error('Daikin A/C system command was rejected');
      }
      lastSettings = control;
      log?.debug?.('%s Daikin command accepted on "%s": power=%s, mode=%s', logPrefix, systemURL, control.pow, control.mode);
    } catch {
      // Failed requests leave the last accepted settings intact for subsequent power-off.
      log?.error?.('%s Failed to send Daikin command to "%s"', logPrefix, systemURL);
    }
  }

  // Validate the passed in logging object
  if (Object.values(LOG_LEVELS).every((fn) => typeof logger?.[fn] === 'function') === true) {
    log = logger;
  }

  // Set log prefix from device name if provided
  // options[1] is passed in from the thermostat as the device description
  if (typeof options[1] === 'string' && options[1] !== '') {
    logPrefix = '[' + options[1] + ']';
  }

  // Validate and normalise the system URL passed in as the first argument
  if (typeof options[0] === 'string' && options[0] !== '') {
    try {
      let url = new URL(options[0]);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        systemURL = url.origin;
      }
    } catch {
      // Invalid URL
    }
  }

  // Define the full set of supported control functions for this module
  // These may be filtered later based on the optional "modes=" argument
  let moduleFunctions = {
    cool: (temperature) => sendCommand({ mode: MODE.COOL, stemp: temperature, shum: 0 }),
    heat: (temperature) => sendCommand({ mode: MODE.HEAT, stemp: temperature, shum: 0 }),
    dehumidifier: (humidity) => sendCommand({ mode: MODE.DEHUMIDIFIER, stemp: 'M', shum: humidity }),
    fan: (speed) => {
      let rates = [FAN_RATE.AUTO, FAN_RATE.QUIET, FAN_RATE.LEVEL1, FAN_RATE.LEVEL2, FAN_RATE.LEVEL3, FAN_RATE.LEVEL4, FAN_RATE.LEVEL5];
      let index = Math.min(Math.floor((speed / 100) * rates.length), rates.length - 1);
      return sendCommand({ mode: MODE.FAN, stemp: '--', shum: '--', f_rate: rates[index] });
    },
    off: () => sendCommand(),
  };

  // Look for an optional "modes=" argument in the options list
  // Example: modes=cool,fan,off
  let allowedModes = options.find((value) => typeof value === 'string' && value.toLowerCase().startsWith('modes=') === true);

  // If valid modes were provided, filter the exported functions
  // so only those listed in "modes=" are returned to the caller
  if (typeof allowedModes === 'string') {
    allowedModes = new Set(
      allowedModes
        .slice(6)
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter((mode) => typeof moduleFunctions?.[mode] === 'function'),
    );

    if (allowedModes.size > 0) {
      moduleFunctions = Object.fromEntries(
        Object.entries(moduleFunctions).filter(([mode, fn]) => allowedModes.has(mode) === true && typeof fn === 'function'),
      );
    }
  }

  // Return the filtered (or full) set of functions to the thermostat module
  return moduleFunctions;
};
