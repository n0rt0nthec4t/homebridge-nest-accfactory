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
// - Track last known state for safe and valid control requests
// - Provide optional filtering of supported control modes
//
// Features:
// - Supports cooling, heating, dehumidifier, fan, and power-off control
// - Maps HomeKit fan percentage to Daikin discrete fan levels
// - Maintains last mode, temperature, humidity, and fan settings
// - Validates and normalises system URL before enabling control
// - Retry-aware HTTP helper with timeout and exponential backoff
// - Optional "modes=" filter to expose only selected functions
//
// Notes:
// - Stateless integration with no read-back from the Daikin system
// - off() requires a previously established operating state
// - Intended for use via thermostat external module configuration
// - Returns a set of control functions dynamically based on configuration
//
// Usage:
// - default(logger, [url])
// - default(logger, [url, deviceDescription])
// - default(logger, [url, deviceDescription, 'modes=cool,fan,off'])
//
// Code version 2026.03.25
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { URL } from 'node:url';
import { setTimeout } from 'node:timers';

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

let systemURL = undefined;
let log = undefined;
let logPrefix = '[External]';
let lastMode = MODE.AUTO;
let lastTemperature = undefined;
let lastHumidity = undefined;
let lastFanRate = FAN_RATE.AUTO;
let lastFanMode = FAN_DIRECTION.SWING;

// Define functions
async function cool(temperature) {
  // Power on, set to cool mode with appropriate temperature, fan mode is Auto and fan is swing
  if (systemURL === undefined) {
    return;
  }

  await fetchWrapper(
    'get',
    systemURL +
      '/aircon/set_control_info?pow=' +
      POWER.ON +
      '&mode=' +
      MODE.COOL +
      '&stemp=' +
      temperature +
      '&shum=0&f_rate=' +
      FAN_RATE.AUTO +
      '&f_dir=' +
      FAN_DIRECTION.SWING,
    {},
  )
    .then((response) => response.text())
    .then((data) => {
      if (data.search('OK') === -1) {
        throw new Error('Daikin A/C system get failed with error');
      }

      log?.debug?.('%s Cool mode on "%s" with target temperature of "%s °C"', logPrefix, systemURL, temperature);
    })
    // eslint-disable-next-line no-unused-vars
    .catch((error) => {
      log?.error?.('%s Failed to set cool mode on "%s"', logPrefix, systemURL);
    });
  lastMode = MODE.COOL;
  lastTemperature = temperature;
  lastFanMode = FAN_DIRECTION.SWING;
  lastFanRate = FAN_RATE.AUTO; // Auto fan mode
}

async function heat(temperature) {
  // Power on, set to heat mode with appropriate temperature, fan mode is Auto and fan is swing
  if (systemURL === undefined) {
    return;
  }

  await fetchWrapper(
    'get',
    systemURL +
      '/aircon/set_control_info?pow=' +
      POWER.ON +
      '&mode=' +
      MODE.HEAT +
      '&stemp=' +
      temperature +
      '&shum=0&f_rate=' +
      FAN_RATE.AUTO +
      '&f_dir=' +
      FAN_DIRECTION.SWING,
    {},
  )
    .then((response) => response.text())
    .then((data) => {
      if (data.search('OK') === -1) {
        throw new Error('Daikin A/C system get failed with error');
      }

      log?.debug?.('%s Heat mode on "%s" with target temperature of "%s °C"', logPrefix, systemURL, temperature);
    })
    // eslint-disable-next-line no-unused-vars
    .catch((error) => {
      log?.error?.('%s Failed to set heat mode on "%s"', logPrefix, systemURL);
    });
  lastMode = MODE.HEAT;
  lastTemperature = temperature;
  lastFanMode = FAN_DIRECTION.SWING;
  lastFanRate = FAN_RATE.AUTO; // Auto fan mode
}

async function dehumidifier(humidity) {
  // Power on, set to dehumidifier mode with appropriate target humidity, fan mode is Auto and fan is swing
  if (systemURL === undefined) {
    return;
  }

  await fetchWrapper(
    'get',
    systemURL +
      '/aircon/set_control_info?pow=' +
      POWER.ON +
      '&mode=' +
      MODE.DEHUMIDIFIER +
      '&stemp=M&shum=' +
      humidity +
      '&f_rate=' +
      FAN_RATE.AUTO +
      '&f_dir=' +
      FAN_DIRECTION.SWING,
    {},
  )
    .then((response) => response.text())
    .then((data) => {
      if (data.search('OK') === -1) {
        throw new Error('Daikin A/C system get failed with error');
      }

      log?.debug?.('%s Dehumidifier mode on "%s" with target humidity of "%s"', logPrefix, systemURL, humidity);
    })
    // eslint-disable-next-line no-unused-vars
    .catch((error) => {
      log?.error?.('%s Failed to set dehumidifier mode on "%s"', logPrefix, systemURL);
    });
  lastMode = MODE.DEHUMIDIFIER;
  lastHumidity = humidity;
}

async function fan(speed) {
  // Convert a HomeKit fan speed value into a Daikin fan speed value
  if (systemURL === undefined) {
    return;
  }

  let fanRates = [FAN_RATE.AUTO, FAN_RATE.QUIET, FAN_RATE.LEVEL1, FAN_RATE.LEVEL2, FAN_RATE.LEVEL3, FAN_RATE.LEVEL4, FAN_RATE.LEVEL5];
  let index = Math.min(Math.floor((speed / 100) * fanRates.length), fanRates.length - 1);
  let rate = fanRates[index];

  // Power on, set to fan mode, fan mode is Auto and fan is swing
  await fetchWrapper(
    'get',
    systemURL +
      '/aircon/set_control_info?pow=' +
      POWER.ON +
      '&mode=' +
      MODE.FAN +
      '&stemp=--&shum=--&f_rate=' +
      rate +
      '&f_dir=' +
      FAN_DIRECTION.SWING,
    {},
  )
    .then((response) => response.text())
    .then((data) => {
      if (data.search('OK') === -1) {
        throw new Error('Daikin A/C system get failed with error');
      }

      log?.debug?.('%s Fan mode on "%s" with speed of "%s"', logPrefix, systemURL, rate);
    })
    // eslint-disable-next-line no-unused-vars
    .catch((error) => {
      log?.error?.('%s Failed to set fan mode on "%s"', logPrefix, systemURL);
    });
  lastMode = MODE.FAN;
  lastFanMode = FAN_DIRECTION.SWING;
  lastFanRate = rate;
}

async function off() {
  // Power off with all mandatory parameters - if state is invalid, don't send
  if (systemURL === undefined || lastTemperature === undefined) {
    return;
  }

  await fetchWrapper(
    'get',
    systemURL +
      '/aircon/set_control_info?pow=' +
      POWER.OFF +
      '&mode=' +
      lastMode +
      '&stemp=' +
      lastTemperature +
      '&shum=' +
      (lastHumidity ?? 0) +
      '&f_rate=' +
      lastFanRate +
      '&f_dir=' +
      lastFanMode,
    {},
  )
    .then((response) => response.text())
    .then((data) => {
      if (data.search('OK') === -1) {
        throw new Error('Daikin A/C system get failed with error');
      }

      log?.debug?.('%s Turned off "%s"', logPrefix, systemURL);
    })
    // eslint-disable-next-line no-unused-vars
    .catch((error) => {
      log?.error?.('%s Failed to turn off "%s"', logPrefix, systemURL);
    });
}

async function fetchWrapper(method, url, options, data) {
  if ((method !== 'get' && method !== 'post') || typeof url !== 'string' || url === '' || typeof options !== 'object') {
    return;
  }

  if (isNaN(options?.timeout) === false && Number(options.timeout) > 0) {
    // eslint-disable-next-line no-undef
    options.signal = AbortSignal.timeout(Number(options.timeout));
  }

  if (isNaN(options.retry) || options.retry < 1) {
    options.retry = 1;
  }

  if (isNaN(options._retryCount)) {
    options._retryCount = 0;
  }

  options.method = method;

  if (method === 'post' && data !== undefined) {
    if (typeof data === 'object' && data !== null && data.constructor === Object) {
      options.body = JSON.stringify(data);

      // Set Content-Type header only if not already set
      options.headers = options.headers || {};
      if (options.headers['Content-Type'] === undefined) {
        options.headers['Content-Type'] = 'application/json';
      }
    } else {
      options.body = data;
    }
  }

  try {
    // eslint-disable-next-line no-undef
    let response = await fetch(url, {
      ...options,
      ...(options?.dispatcher !== undefined ? { dispatcher: options.dispatcher } : {}),
    });

    if (response?.ok === false) {
      if (options.retry > 1) {
        options.retry--;
        options._retryCount++;

        let delay = 500 * Math.pow(2, options._retryCount - 1);
        await new Promise((resolve) => {
          setTimeout(resolve, delay);
        });

        return fetchWrapper(method, url, options, data);
      }

      // Optionally get response body
      let body;
      try {
        body = await response.text();
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        body = '';
      }
      throw Object.assign(
        new Error('HTTP ' + response.status + ' on ' + method.toUpperCase() + ' ' + url + ': ' + (response.statusText || 'Unknown error')),
        { code: response.status, status: response.status, body },
      );
    }

    return response;
  } catch (error) {
    let original = error?.cause ?? error;

    // Detect invalid URL and rethrow immediately
    if (original?.code === 'ERR_INVALID_URL') {
      throw Object.assign(new Error('Invalid URL: ' + url), { code: 'ERR_INVALID_URL', cause: original });
    }

    // Retry only on retry-eligible errors
    if (
      options.retry > 1 &&
      (original?.code === 'UND_ERR_HEADERS_TIMEOUT' ||
        original?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
        original?.name === 'AbortError' ||
        original?.name === 'TypeError')
    ) {
      options.retry--;
      options._retryCount++;

      let delay = 500 * Math.pow(2, options._retryCount - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));

      return fetchWrapper(method, url, options, data);
    }

    // Final error wrap
    throw Object.assign(
      new Error(
        method.toUpperCase() +
          ' ' +
          url +
          ' failed after ' +
          (options._retryCount + 1) +
          ' attempt' +
          (options._retryCount + 1 > 1 ? 's' : '') +
          ': ' +
          (original?.message || String(original)),
      ),
      { code: original?.code, cause: original },
    );
  }
}

// Export functions for use in our dynamically loaded library
//
// Example usage:
//
// let test = await import('./daikinsystem.mjs');
//
// returned = test.default(loggerFunctions, ['http://x.x.x.x']);
// or
// returned = test.default(loggerFunctions, ['http://x.x.x.x', 'Logging Prefix']);
// or with mode filtering
// returned = test.default(loggerFunctions, ['http://x.x.x.x', 'Logging Prefix', 'modes=cool,fan,off']);
//
// When the optional "modes=" argument is provided, only the listed
// functions will be returned to the caller.
export default (logger, options) => {
  // Validate the passed in logging object
  if (Object.values(LOG_LEVELS).every((fn) => typeof logger?.[fn] === 'function')) {
    log = logger;
  }

  // Set log prefix from device name if provided
  // options[1] is passed in from the thermostat as the device description
  if (typeof options[1] === 'string' && options[1] !== '') {
    logPrefix = '[' + options[1] + ']';
  }

  // Reset system URL before validation so that if the module is reloaded with new options, the URL will be updated correctly
  systemURL = undefined;

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
    cool,
    heat,
    dehumidifier,
    fan,
    off,
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
        Object.entries(moduleFunctions).filter(([mode, fn]) => allowedModes.has(mode) && typeof fn === 'function'),
      );
    }
  }

  // Return the filtered (or full) set of functions to the thermostat module
  return moduleFunctions;
};
