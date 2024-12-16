// Thermostat external control plugin for homebridge-nest-accfactory
// Controls a daikin wifi connected a/c system via thermostat with no physical connection to it
//
// Code version 2024/12/17
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { setTimeout } from 'node:timers';
import { URL } from 'node:url';

// Define constants
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
    // eslint-disable-next-line no-unused-vars
    .then((data) => {
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
    // eslint-disable-next-line no-unused-vars
    .then((data) => {
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

async function dehumififier(humidity) {
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
    // eslint-disable-next-line no-unused-vars
    .then((data) => {
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

  let steps = 100 / Object.keys(FanRate).length;
  let rate = FanRate.AUTO;
  if (speed >= 0 && speed <= steps * 1) {
    rate = FanRate.AUTO;
  }
  if (speed > steps * 1 && speed <= steps * 2) {
    rate = FanRate.QUIET;
  }
  if (speed > steps * 2 && speed <= steps * 3) {
    rate = FanRate.LEVEL1;
  }
  if (speed > steps * 3 && speed <= steps * 4) {
    rate = FanRate.LEVEL2;
  }
  if (speed > steps * 4 && speed <= steps * 5) {
    rate = FanRate.LEVEL3;
  }
  if (speed > steps * 5 && speed <= steps * 6) {
    rate = FanRate.LEVEL4;
  }
  if (speed > steps * 6 && speed <= 100) {
    rate = FanRate.LEVEL5;
  }

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
    // eslint-disable-next-line no-unused-vars
    .then((data) => {
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
    // eslint-disable-next-line no-unused-vars
    .then((data) => {
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

async function fetchWrapper(method, url, options, data, response) {
  if ((method !== 'get' && method !== 'post') || typeof url !== 'string' || url === '' || typeof options !== 'object') {
    return;
  }

  if (isNaN(options?.timeout) === false && Number(options?.timeout) > 0) {
    // If a timeout is specified in the options, setup here
    // eslint-disable-next-line no-undef
    options.signal = AbortSignal.timeout(Number(options.timeout));
  }

  if (options?.retry === undefined) {
    // If not retry option specifed , we'll do just once
    options.retry = 1;
  }

  options.method = method; // Set the HTTP method to use

  if (method === 'post' && typeof data !== undefined) {
    // Doing a HTTP post, so include the data in the body
    options.body = data;
  }

  if (options.retry > 0) {
    // eslint-disable-next-line no-undef
    response = await fetch(url, options);
    if (response.ok === false && options.retry > 1) {
      options.retry--; // One less retry to go

      // Try again after short delay (500ms)
      // We pass back in this response also for when we reach zero retries and still not successful
      await new Promise((resolve) => setTimeout(resolve, 500));
      // eslint-disable-next-line no-undef
      response = await fetchWrapper('get', method, url, options, data, structuredClone(response));
    }
    if (response.ok === false && options.retry === 0) {
      let error = new Error(response.statusText);
      error.code = response.status;
      throw error;
    }
  }

  return response;
}

// Export functions for use in our dynamically loaded library
//
// let test = await import('./daikinsystem.js');
// returned = test.default(loggerFunctions, 'http://x.x.x.x');
export default (logger, options) => {
  // Validate the passed in logging object. We are expecting certain functions to be present
  if (
    typeof logger?.info === 'function' &&
    typeof logger?.success === 'function' &&
    typeof logger?.warn === 'function' &&
    typeof logger?.error === 'function' &&
    typeof logger?.debug === 'function'
  ) {
    log = logger;
  }

  // Validate the url
  systemURL = setSystemURL(options[0]);

  return {
    cool,
    heat,
    dehumififier,
    fan,
    off,
  };
};
