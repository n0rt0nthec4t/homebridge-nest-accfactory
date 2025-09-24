// General helper functions
// Part of homebridge-nest-accfactory
//
// Code version 2025.09.08
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { Buffer } from 'node:buffer';
import { setTimeout } from 'node:timers';

// Define our modules
import HomeKitDevice from './HomeKitDevice.js';

// Define external library requirements
import { Agent } from 'undici';

// Define constants
const defaultFetchAgent = new Agent(); // shared across all requests

function adjustTemperature(temperature, currentTemperatureUnit, targetTemperatureUnit, round) {
  currentTemperatureUnit = currentTemperatureUnit?.toUpperCase?.();
  targetTemperatureUnit = targetTemperatureUnit?.toUpperCase?.();

  if (currentTemperatureUnit === 'F' && targetTemperatureUnit === 'C') {
    temperature = ((temperature - 32) * 5) / 9;
    if (round === true) {
      temperature = Math.round(temperature * 2) / 2; // round to nearest 0.5°C
    }
  } else if (currentTemperatureUnit === 'C' && targetTemperatureUnit === 'F') {
    temperature = (temperature * 9) / 5 + 32;
    if (round === true) {
      temperature = Math.round(temperature); // round to nearest 1°F
    }
  } else if (round === true) {
    // No conversion, just rounding
    temperature = targetTemperatureUnit === 'C' ? Math.round(temperature * 2) / 2 : Math.round(temperature);
  }

  return temperature;
}

function crc24(valueToHash) {
  const crc24HashTable = [
    0x000000, 0x864cfb, 0x8ad50d, 0x0c99f6, 0x93e6e1, 0x15aa1a, 0x1933ec, 0x9f7f17, 0xa18139, 0x27cdc2, 0x2b5434, 0xad18cf, 0x3267d8,
    0xb42b23, 0xb8b2d5, 0x3efe2e, 0xc54e89, 0x430272, 0x4f9b84, 0xc9d77f, 0x56a868, 0xd0e493, 0xdc7d65, 0x5a319e, 0x64cfb0, 0xe2834b,
    0xee1abd, 0x685646, 0xf72951, 0x7165aa, 0x7dfc5c, 0xfbb0a7, 0x0cd1e9, 0x8a9d12, 0x8604e4, 0x00481f, 0x9f3708, 0x197bf3, 0x15e205,
    0x93aefe, 0xad50d0, 0x2b1c2b, 0x2785dd, 0xa1c926, 0x3eb631, 0xb8faca, 0xb4633c, 0x322fc7, 0xc99f60, 0x4fd39b, 0x434a6d, 0xc50696,
    0x5a7981, 0xdc357a, 0xd0ac8c, 0x56e077, 0x681e59, 0xee52a2, 0xe2cb54, 0x6487af, 0xfbf8b8, 0x7db443, 0x712db5, 0xf7614e, 0x19a3d2,
    0x9fef29, 0x9376df, 0x153a24, 0x8a4533, 0x0c09c8, 0x00903e, 0x86dcc5, 0xb822eb, 0x3e6e10, 0x32f7e6, 0xb4bb1d, 0x2bc40a, 0xad88f1,
    0xa11107, 0x275dfc, 0xdced5b, 0x5aa1a0, 0x563856, 0xd074ad, 0x4f0bba, 0xc94741, 0xc5deb7, 0x43924c, 0x7d6c62, 0xfb2099, 0xf7b96f,
    0x71f594, 0xee8a83, 0x68c678, 0x645f8e, 0xe21375, 0x15723b, 0x933ec0, 0x9fa736, 0x19ebcd, 0x8694da, 0x00d821, 0x0c41d7, 0x8a0d2c,
    0xb4f302, 0x32bff9, 0x3e260f, 0xb86af4, 0x2715e3, 0xa15918, 0xadc0ee, 0x2b8c15, 0xd03cb2, 0x567049, 0x5ae9bf, 0xdca544, 0x43da53,
    0xc596a8, 0xc90f5e, 0x4f43a5, 0x71bd8b, 0xf7f170, 0xfb6886, 0x7d247d, 0xe25b6a, 0x641791, 0x688e67, 0xeec29c, 0x3347a4, 0xb50b5f,
    0xb992a9, 0x3fde52, 0xa0a145, 0x26edbe, 0x2a7448, 0xac38b3, 0x92c69d, 0x148a66, 0x181390, 0x9e5f6b, 0x01207c, 0x876c87, 0x8bf571,
    0x0db98a, 0xf6092d, 0x7045d6, 0x7cdc20, 0xfa90db, 0x65efcc, 0xe3a337, 0xef3ac1, 0x69763a, 0x578814, 0xd1c4ef, 0xdd5d19, 0x5b11e2,
    0xc46ef5, 0x42220e, 0x4ebbf8, 0xc8f703, 0x3f964d, 0xb9dab6, 0xb54340, 0x330fbb, 0xac70ac, 0x2a3c57, 0x26a5a1, 0xa0e95a, 0x9e1774,
    0x185b8f, 0x14c279, 0x928e82, 0x0df195, 0x8bbd6e, 0x872498, 0x016863, 0xfad8c4, 0x7c943f, 0x700dc9, 0xf64132, 0x693e25, 0xef72de,
    0xe3eb28, 0x65a7d3, 0x5b59fd, 0xdd1506, 0xd18cf0, 0x57c00b, 0xc8bf1c, 0x4ef3e7, 0x426a11, 0xc426ea, 0x2ae476, 0xaca88d, 0xa0317b,
    0x267d80, 0xb90297, 0x3f4e6c, 0x33d79a, 0xb59b61, 0x8b654f, 0x0d29b4, 0x01b042, 0x87fcb9, 0x1883ae, 0x9ecf55, 0x9256a3, 0x141a58,
    0xefaaff, 0x69e604, 0x657ff2, 0xe33309, 0x7c4c1e, 0xfa00e5, 0xf69913, 0x70d5e8, 0x4e2bc6, 0xc8673d, 0xc4fecb, 0x42b230, 0xddcd27,
    0x5b81dc, 0x57182a, 0xd154d1, 0x26359f, 0xa07964, 0xace092, 0x2aac69, 0xb5d37e, 0x339f85, 0x3f0673, 0xb94a88, 0x87b4a6, 0x01f85d,
    0x0d61ab, 0x8b2d50, 0x145247, 0x921ebc, 0x9e874a, 0x18cbb1, 0xe37b16, 0x6537ed, 0x69ae1b, 0xefe2e0, 0x709df7, 0xf6d10c, 0xfa48fa,
    0x7c0401, 0x42fa2f, 0xc4b6d4, 0xc82f22, 0x4e63d9, 0xd11cce, 0x575035, 0x5bc9c3, 0xdd8538,
  ];

  let crc = 0xb704ce;

  let buffer = Buffer.from(valueToHash);

  for (let i = 0; i < buffer.length; i++) {
    let index = ((crc >> 16) ^ buffer[i]) & 0xff;
    crc = (crc24HashTable[index] ^ (crc << 8)) & 0xffffff;
  }

  return crc.toString(16).padStart(6, '0'); // ensures 6-digit hex
}

function scaleValue(value, sourceMin, sourceMax, targetMin, targetMax) {
  if (sourceMax === sourceMin) {
    return targetMin;
  }

  value = Math.max(sourceMin, Math.min(sourceMax, value));

  return ((value - sourceMin) * (targetMax - targetMin)) / (sourceMax - sourceMin) + targetMin;
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
      dispatcher: options?.dispatcher ?? defaultFetchAgent, // Always use a secure default agent unless explicitly overridden
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
    if (
      options.retry > 1 &&
      (error?.cause?.code === 'UND_ERR_HEADERS_TIMEOUT' || error?.name === 'AbortError' || error?.name === 'TypeError')
    ) {
      options.retry--;
      options._retryCount++;

      let delay = 500 * Math.pow(2, options._retryCount - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    throw new Error(
      method.toUpperCase() +
        ' ' +
        url +
        ' failed after ' +
        (options._retryCount + 1) +
        ' attempt' +
        (options._retryCount + 1 > 1 ? 's' : '') +
        ': ' +
        (error?.message || String(error)) +
        (error?.cause?.code ? ' (' + error.cause.code + ')' : ''),
      { cause: error },
    );
  }
}

function parseDurationToSeconds(inputDuration, { defaultValue = null, min = 0, max = Infinity } = {}) {
  let normalisedSeconds = defaultValue;

  if (inputDuration !== undefined && inputDuration !== null && inputDuration !== '') {
    inputDuration = String(inputDuration).trim().toLowerCase();

    // Case: plain numeric seconds (e.g. "30")
    if (/^\d+$/.test(inputDuration) === true) {
      normalisedSeconds = Number(inputDuration);
    } else {
      // Normalise all known unit types to single characters
      inputDuration = inputDuration
        .replace(/\b(weeks?|w)\b/g, 'w')
        .replace(/\b(days?|d)\b/g, 'd')
        .replace(/\b(hours?|hrs?|hr|h)\b/g, 'h')
        .replace(/\b(minutes?|mins?|min|m)\b/g, 'm')
        .replace(/\b(seconds?|secs?|sec|s)\b/g, 's')
        .replace(/ +/g, '');

      // Match format like "1w3d2h15m30s"
      let match = inputDuration.match(/^((\d+)w)?((\d+)d)?((\d+)h)?((\d+)m)?((\d+)s?)?$/);

      if (Array.isArray(match) === true) {
        let total =
          Number(match[2] || 0) * 604800 + // weeks
          Number(match[4] || 0) * 86400 + // days
          Number(match[6] || 0) * 3600 + // hours
          Number(match[8] || 0) * 60 + // minutes
          Number(match[10] || 0); // seconds

        normalisedSeconds = total;
      }
    }

    if (normalisedSeconds === null || isNaN(normalisedSeconds) === true) {
      normalisedSeconds = defaultValue;
    }

    if (isNaN(min) === false && normalisedSeconds < min) {
      normalisedSeconds = min;
    }
    if (isNaN(max) === false && normalisedSeconds > max) {
      normalisedSeconds = max;
    }
  }

  return normalisedSeconds;
}

function processCommonData(deviceUUID, data, config) {
  if (
    typeof deviceUUID !== 'string' ||
    deviceUUID === '' ||
    data === null ||
    typeof data !== 'object' ||
    data?.constructor !== Object ||
    typeof config !== 'object' ||
    config?.constructor !== Object
  ) {
    return;
  }
  // Process common data for all devices

  // Process software version strings and return as x.x.x
  // handles things like:
  // 1.0a17 -> 1.0.17
  // 3.6rc8 -> 3.6.8
  // rquartz-user 1 OPENMASTER 507800056 test-keys stable-channel stable-channel -> 507800056
  // nq-user 1.73 OPENMASTER 422270 release-keys stable-channel stable-channel -> 422270
  const process_software_version = (versionString) => {
    let version = '0.0.0';
    if (typeof versionString === 'string') {
      let normalised = versionString.replace(/[-_]/g, '.');
      let tokens = normalised.split(/\s+/);
      let candidate = tokens[3] || normalised;
      let match = candidate.match(/\d+(?:\.\d+)*[a-zA-Z]*\d*/) || normalised.match(/\d+(?:\.\d+)*[a-zA-Z]*\d*/);

      if (Array.isArray(match) === true) {
        let raw = match[0];
        if (raw.includes('.') === false) {
          return raw; // Return single-number version like "422270" as-is
        }

        let parts = raw.split('.').flatMap((part) => {
          let [, n1, , n2] = part.match(/^(\d+)([a-zA-Z]+)?(\d+)?$/) || [];
          return [n1, n2].filter(Boolean).map(Number);
        });

        while (parts.length < 3) {
          parts.push(0);
        }
        version = parts.slice(0, 3).join('.');
      }
    }

    return version;
  };

  let processed = {};
  try {
    // Fix up data we need to
    let deviceOptions = config?.devices?.find((device) => device?.serialNumber?.toUpperCase?.() === data?.serialNumber?.toUpperCase?.());
    data.nest_google_uuid = deviceUUID;
    data.serialNumber = data.serialNumber.toUpperCase(); // ensure serial numbers are in upper case
    data.excluded = config?.options?.exclude === true ? deviceOptions?.exclude !== false : deviceOptions?.exclude === true;
    data.manufacturer = typeof data?.manufacturer === 'string' && data.manufacturer !== '' ? data.manufacturer : 'Nest';
    data.softwareVersion = process_software_version(data.softwareVersion);
    let description = typeof data?.description === 'string' ? data.description : '';
    let location = typeof data?.location === 'string' ? data.location : '';
    if (description === '' && location !== '') {
      description = location;
      location = '';
    }
    if (description === '' && location === '') {
      description = 'unknown description';
    }
    data.description = HomeKitDevice.makeValidHKName(location === '' ? description : description + ' - ' + location);
    delete data.location;

    processed = data;
    // eslint-disable-next-line no-unused-vars
  } catch (error) {
    // Empty
  }
  return processed;
}

function logJSONObject(log, object) {
  if (typeof object !== 'object' || object.constructor !== Object) {
    return;
  }

  Object.entries(object).forEach(([key, value]) => {
    if (typeof value === 'object' && value !== null) {
      log?.debug?.('  %s:', key);
      String(JSON.stringify(value, null, 2))
        .split('\n')
        .forEach((line) => {
          log?.debug?.('    %s', line);
        });
    } else {
      log?.debug?.('  %s: %j', key, value);
    }
  });
}

// Define exports
export { processCommonData, adjustTemperature, crc24, scaleValue, fetchWrapper, parseDurationToSeconds, logJSONObject };
