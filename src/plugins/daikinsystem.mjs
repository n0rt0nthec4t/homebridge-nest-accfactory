// Thermostat external control plugin for homebridge-nest-accfactory
// Controls a daikin wifi connected a/c system via thermostat with no physical connection to it
//
// Code version 2025.06.15
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { setTimeout } from 'node:timers';
import { URL } from 'node:url';

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
let lastMode = MODE.AUTO;
let lastTemperature = 0;
// eslint-disable-next-line no-unused-vars
let lastHumidity = 0;
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

      log?.info?.('[External Daikin] Cool mode on "%s" with target temperature of "%s °C"', systemURL, temperature);
    })
    // eslint-disable-next-line no-unused-vars
    .catch((error) => {
      log?.error?.('[External Daikin] Failed to set cool mode on "%s"', systemURL);
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

      log?.info?.('[External Daikin] Heat mode on "%s" with target temperature of "%s °C"', systemURL, temperature);
    })
    // eslint-disable-next-line no-unused-vars
    .catch((error) => {
      log?.error?.('[External Daikin] Failed to set heat mode on "%s"', systemURL);
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

      log?.info?.('[External Daikin] Dehumidifier mode on "%s" with target humidity of "%s"', systemURL, humidity);
    })
    // eslint-disable-next-line no-unused-vars
    .catch((error) => {
      log?.error && log.error('[External Daikin] Failed to set dehumidifier mode on "%s"', systemURL);
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

      log?.info?.('[External Daikin] Fan mode on "%s" with speed of "%s"', systemURL, rate);
    })
    // eslint-disable-next-line no-unused-vars
    .catch((error) => {
      log?.error?.('[External Daikin] Failed to set fan mode on "%s"', systemURL);
    });
  lastMode = MODE.FAN;
  lastFanMode = FAN_DIRECTION.SWING;
  lastFanRate = FAN_RATE.AUTO; // Auto fan mode
}

async function off() {
  // Power off
  if (systemURL === undefined) {
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
      '&shum=0&f_rate=' +
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

      log?.info?.('[External Daikin] Turned off "%s"', systemURL);
    })
    // eslint-disable-next-line no-unused-vars
    .catch((error) => {
      log?.error?.('[External Daikin] Failed to turn off "%s"', systemURL);
    });
  lastMode = MODE.OFF;
}

function setSystemURL(daikinSystemURL) {
  let validatedSystemURL = undefined;

  if (typeof daikinSystemURL !== 'string' || daikinSystemURL === '') {
    return;
  }

  try {
    let url = new URL(daikinSystemURL);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      validatedSystemURL = daikinSystemURL;
      systemURL = daikinSystemURL;
    }
    // eslint-disable-next-line no-unused-vars
  } catch (error) {
    // Empty
  }

  return validatedSystemURL;
}

async function fetchWrapper(method, url, options, data) {
  if ((method !== 'get' && method !== 'post') || typeof url !== 'string' || url === '' || typeof options !== 'object') {
    return;
  }

  if (isNaN(options?.timeout) === false && Number(options.timeout) > 0) {
    // eslint-disable-next-line no-undef
    options.signal = AbortSignal.timeout(Number(options.timeout));
  }

  if (isNaN(options.retry) === true || options.retry < 1) {
    options.retry = 1;
  }

  if (isNaN(options._retryCount) === true) {
    options._retryCount = 0;
  }

  options.method = method;

  if (method === 'post' && data !== undefined) {
    options.body = data;
  }

  let response;
  try {
    // eslint-disable-next-line no-undef
    response = await fetch(url, options);
  } catch (error) {
    if (options.retry > 1) {
      options.retry--;
      options._retryCount++;

      const delay = 500 * 2 ** (options._retryCount - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));

      return fetchWrapper(method, url, options, data);
    }

    error.message = `Fetch failed for ${method.toUpperCase()} ${url} after ${options._retryCount + 1} attempt(s): ${error.message}`;
    throw error;
  }

  if (response?.ok === false) {
    if (options.retry > 1) {
      options.retry--;
      options._retryCount++;

      let delay = 500 * 2 ** (options._retryCount - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));

      return fetchWrapper(method, url, options, data);
    }

    let error = new Error(`HTTP ${response.status} on ${method.toUpperCase()} ${url}: ${response.statusText || 'Unknown error'}`);
    error.code = response.status;
    throw error;
  }

  return response;
}

// Export functions for use in our dynamically loaded library
//
// let test = await import('./daikinsystem.js', ['cool', 'off]);
// returned = test.default(loggerFunctions, 'http://x.x.x.x');
export default (logger, options) => {
  // Validate the passed in logging object
  if (Object.values(LOG_LEVELS).every((fn) => typeof logger?.[fn] === 'function')) {
    log = logger;
  }

  // Validate the url
  systemURL = setSystemURL(options[0]);

  return {
    cool,
    heat,
    dehumidifier,
    fan,
    off,
  };
};
