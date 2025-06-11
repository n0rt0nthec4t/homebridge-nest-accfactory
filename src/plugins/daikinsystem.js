// Thermostat external control plugin for homebridge-nest-accfactory
// Controls a daikin wifi connected a/c system via thermostat with no physical connection to it
//
// Code version 2025.06.12
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { setTimeout } from 'node:timers';
import { URL } from 'node:url';

// Define constants
const LOGLEVELS = ['info', 'success', 'warn', 'error', 'debug'];
const Power = {
  ON: 1,
  OFF: 0,
};

const Mode = {
  AUTO: 7,
  DEHUMIDIFIER: 2,
  COOL: 3,
  HEAT: 4,
  FAN: 6,
};

const FanRate = {
  AUTO: 'A',
  QUIET: 'B',
  LEVEL1: '3',
  LEVEL2: '4',
  LEVEL3: '5',
  LEVEL4: '6',
  LEVEL5: '7',
};

const FanDirection = {
  STOP: 0,
  VERTICAL: 1,
  HORIZONTAL: 2,
  SWING: 3,
};

let systemURL = undefined;
let log = undefined;
let lastMode = Mode.AUTO;
let lastTemperature = 0;
// eslint-disable-next-line no-unused-vars
let lastHumidity = 0;
let lastFanRate = FanRate.AUTO;
let lastFanMode = FanDirection.SWING;

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
      Power.ON +
      '&mode=' +
      Mode.COOL +
      '&stemp=' +
      temperature +
      '&shum=0&f_rate=' +
      FanRate.AUTO +
      '&f_dir=' +
      FanDirection.SWING,
    {},
  )
    .then((response) => response.text())
    .then((data) => {
      if (data.search('OK') === -1) {
        throw new Error('Daikin A/C system get failed with error');
      }

      log?.info && log.info('[External Daikin] Cool mode on "%s" with target temperature of "%s °C"', systemURL, temperature);
    })
    // eslint-disable-next-line no-unused-vars
    .catch((error) => {
      log?.error && log.error('[External Daikin] Failed to set cool mode on "%s"', systemURL);
    });
  lastMode = Mode.COOL;
  lastTemperature = temperature;
  lastFanMode = FanDirection.SWING;
  lastFanRate = FanRate.AUTO; // Auto fan mode
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
      Power.ON +
      '&mode=' +
      Mode.HEAT +
      '&stemp=' +
      temperature +
      '&shum=0&f_rate=' +
      FanRate.AUTO +
      '&f_dir=' +
      FanDirection.SWING,
    {},
  )
    .then((response) => response.text())
    .then((data) => {
      if (data.search('OK') === -1) {
        throw new Error('Daikin A/C system get failed with error');
      }

      log?.info && log.info('[External Daikin] Heat mode on "%s" with target temperature of "%s °C"', systemURL, temperature);
    })
    // eslint-disable-next-line no-unused-vars
    .catch((error) => {
      log?.error && log.error('[External Daikin] Failed to set heat mode on "%s"', systemURL);
    });
  lastMode = Mode.HEAT;
  lastTemperature = temperature;
  lastFanMode = FanDirection.SWING;
  lastFanRate = FanRate.AUTO; // Auto fan mode
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
      Power.ON +
      '&mode=' +
      Mode.DEHUMIDIFIER +
      '&stemp=M&shum=' +
      humidity +
      '&f_rate=' +
      FanRate.AUTO +
      '&f_dir=' +
      FanDirection.SWING,
    {},
  )
    .then((response) => response.text())
    .then((data) => {
      if (data.search('OK') === -1) {
        throw new Error('Daikin A/C system get failed with error');
      }

      log?.info && log.info('[External Daikin] Dehumidifier mode on "%s" with target humidity of "%s"', systemURL, humidity);
    })
    // eslint-disable-next-line no-unused-vars
    .catch((error) => {
      log?.error && log.error('[External Daikin] Failed to set dehumidifier mode on "%s"', systemURL);
    });
  lastMode = Mode.DEHUMIDIFIER;
  lastHumidity = humidity;
}

async function fan(speed) {
  // Convert a HomeKit fan speed value into a Daikin fan speed value
  if (systemURL === undefined) {
    return;
  }

  let fanRates = [FanRate.AUTO, FanRate.QUIET, FanRate.LEVEL1, FanRate.LEVEL2, FanRate.LEVEL3, FanRate.LEVEL4, FanRate.LEVEL5];
  let index = Math.min(Math.floor((speed / 100) * fanRates.length), fanRates.length - 1);
  let rate = fanRates[index];

  // Power on, set to fan mode, fan mode is Auto and fan is swing
  await fetchWrapper(
    'get',
    systemURL +
      '/aircon/set_control_info?pow=' +
      Power.ON +
      '&mode=' +
      Mode.FAN +
      '&stemp=--&shum=--&f_rate=' +
      rate +
      '&f_dir=' +
      FanDirection.SWING,
    {},
  )
    .then((response) => response.text())
    .then((data) => {
      if (data.search('OK') === -1) {
        throw new Error('Daikin A/C system get failed with error');
      }

      log?.info && log.info('[External Daikin] Fan mode on "%s" with speed of "%s"', systemURL, rate);
    })
    // eslint-disable-next-line no-unused-vars
    .catch((error) => {
      log?.error && log.error('[External Daikin] Failed to set fan mode on "%s"', systemURL);
    });
  lastMode = Mode.FAN;
  lastFanMode = FanDirection.SWING;
  lastFanRate = FanRate.AUTO; // Auto fan mode
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
      Power.OFF +
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

      log?.info && log.info('[External Daikin] Turned off "%s"', systemURL);
    })
    // eslint-disable-next-line no-unused-vars
    .catch((error) => {
      log?.error && log.error('[External Daikin] Failed to turn off "%s"', systemURL);
    });
  lastMode = Mode.OFF;
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

  // eslint-disable-next-line no-undef
  let response = await fetch(url, options);

  if (response.ok === false && options.retry > 1) {
    options.retry--;
    options._retryCount++;

    let delay = 500 * 2 ** (options._retryCount - 1);
    await new Promise((resolve) => setTimeout(resolve, delay));

    response = await fetchWrapper(method, url, options, data);
  }

  if (response.ok === false && options.retry === 0) {
    const error = new Error(response.statusText);
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
  // Validate the passed in logging object. We are expecting certain functions to be present
  if (LOGLEVELS.every((fn) => typeof logger?.[fn] === 'function')) {
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
