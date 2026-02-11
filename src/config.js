// Configuration validation and processing
// Part of homebridge-nest-accfactory
//
// Code version 2026.02.11
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import crypto from 'node:crypto';

// Import our modules
import FFmpeg from './ffmpeg.js';

// Define constants
import { FFMPEG_VERSION, ACCOUNT_TYPE, MIN_ELEVATION, MAX_ELEVATION } from './consts.js';

function processConfig(config, log) {
  let options = (config.options = typeof config?.options === 'object' ? config.options : {});

  options.eveHistory = config.options?.eveHistory === true;
  options.weather = config.options?.weather === true;
  options.hksv = config.options?.hksv === true;
  options.exclude = config.options?.exclude === true;

  options.elevation =
    isNaN(config.options?.elevation) === false &&
    Number(config.options.elevation) >= MIN_ELEVATION &&
    Number(config.options.elevation) <= MAX_ELEVATION
      ? Number(config.options.elevation)
      : MIN_ELEVATION;

  // Controls what APIs we use, default is to use both Nest and Google APIs
  options.useNestAPI = config.options?.useNestAPI === true || config.options?.useNestAPI === undefined;
  options.useGoogleAPI = config.options?.useGoogleAPI === true || config.options?.useGoogleAPI === undefined;

  // Get configuration for max number of concurrent 'live view' streams. For HomeKit Secure Video, this will always be 1
  options.maxStreams = isNaN(config.options?.maxStreams) === false ? Number(config.options.maxStreams) : 2;

  // Check if an ffmpeg binary exists via a specific path in configuration OR /usr/local/bin
  options.ffmpeg = {
    binary: undefined,
    valid: false,
    debug: config.options?.ffmpegDebug === true,
    hwaccel: false,
  };

  let ffmpegPath = (config?.options?.ffmpegPath?.trim?.() ?? '') !== '' ? config.options.ffmpegPath.trim() : '/usr/local/bin';

  // Create FFmpeg probe
  let ffmpeg = new FFmpeg(ffmpegPath, log);

  if (typeof ffmpeg.version !== 'string') {
    log?.warn?.('ffmpeg binary "%s" not found or not executable, camera/doorbell streaming will be unavailable', ffmpeg.binary);
  } else {
    // Proceed with compatibility checks
    options.ffmpeg.valid = ffmpeg.hasMinimumSupport({
      version: FFMPEG_VERSION,
      encoders: ['libx264', 'libfdk_aac', 'libopus'],
      decoders: ['libspeex'],
    });
    if (options.ffmpeg.valid === false) {
      log?.warn?.('ffmpeg binary "%s" does not meet the minimum support requirements', ffmpeg.binary);
      log?.warn?.('Stream video/recording from camera/doorbells will be unavailable');
      if (
        ffmpeg.version?.localeCompare(FFMPEG_VERSION, undefined, {
          numeric: true,
          sensitivity: 'case',
          caseFirst: 'upper',
        }) === -1
      ) {
        log?.warn?.('Minimum binary version is "%s", however the installed version is "%s"', FFMPEG_VERSION, ffmpeg.version);
      }

      if ((ffmpeg.features?.decoders || []).includes('libspeex') === false) {
        log?.warn?.('Missing speex decoder in ffmpeg');
      }

      if ((ffmpeg.features?.encoders || []).includes('libfdk_aac') === false) {
        log?.warn?.('Missing fdk_aac encoder in ffmpeg');
      }

      if ((ffmpeg.features?.encoders || []).includes('libopus') === false) {
        log?.warn?.('Missing opus encoder in ffmpeg');
      }

      if ((ffmpeg.features?.encoders || []).includes('libx264') === false) {
        log?.warn?.('Missing libx264 encoder in ffmpeg');
      }
    }

    if (options.ffmpeg.valid === true) {
      log?.success?.('Found valid ffmpeg binary in %s', ffmpeg.binary);
      options.ffmpeg.binary = ffmpeg.binary;
      options.ffmpeg.hwaccel = ffmpeg.supportsHardwareH264 === true;
      if (ffmpeg.supportsHardwareH264 === true) {
        log?.debug?.('Hardware H264 encoding available via "%s"', ffmpeg.hardwareH264Codec);
      }
    }
  }

  // Process per device configuration(s)
  if (config?.devices === undefined) {
    config.devices = [];
  }

  if (config?.devices !== undefined && Array.isArray(config.devices) === false) {
    // If the devices section is a JSON object keyed by the devices serial number, convert to devices array object
    let newDeviceArray = [];
    for (const [serialNumber, props] of Object.entries(config.devices)) {
      newDeviceArray.push({
        serialNumber,
        ...props,
      });
    }
    config.devices = newDeviceArray;

    // Alert user to changed configuration for them to update config
    log?.warn?.('');
    log?.warn?.('NOTICE');
    log?.warn?.('> The per device configuration contains legacy options. Please review the readme at the link below');
    log?.warn?.(
      '> Consider updating your configuration file as the mapping from legacy to current per device configuration may be removed',
    );
    log?.warn?.('> https://github.com/n0rt0nthec4t/homebridge-nest-accfactory/blob/main/src/README.md');
    log?.warn?.('');
  }

  // Per home configuration(s)
  if (Array.isArray(config?.homes) === false) {
    config.homes = [];
  }

  return config;
}

function buildConnections(config) {
  let connections = {};

  Object.keys(config).forEach((key) => {
    let section = config[key];

    if (typeof section?.access_token === 'string' && section.access_token.trim() !== '') {
      let fieldTest = section?.fieldTest === true;
      connections[crypto.randomUUID()] = {
        name: key,
        type: ACCOUNT_TYPE.NEST,
        authorised: false,
        allowRetry: undefined, // On purpose having this as undefined
        access_token: section.access_token.trim(),
        fieldTest: fieldTest,
        referer: fieldTest ? 'home.ft.nest.com' : 'home.nest.com',
        restAPIHost: fieldTest ? 'home.ft.nest.com' : 'home.nest.com',
        cameraAPIHost: fieldTest ? 'camera.home.ft.nest.com' : 'camera.home.nest.com',
        protobufAPIHost: fieldTest ? 'grpc-web.ft.nest.com' : 'grpc-web.production.nest.com',
      };
    }

    if (
      typeof section?.issuetoken === 'string' &&
      section.issuetoken.trim() !== '' &&
      typeof section?.cookie === 'string' &&
      section.cookie.trim() !== ''
    ) {
      let fieldTest = section?.fieldTest === true;
      connections[crypto.randomUUID()] = {
        name: key,
        type: ACCOUNT_TYPE.GOOGLE,
        authorised: false,
        allowRetry: undefined, // On purpose having this as undefined
        issuetoken: section.issuetoken.trim(),
        cookie: section.cookie.trim(),
        fieldTest: fieldTest,
        referer: fieldTest ? 'home.ft.nest.com' : 'home.nest.com',
        restAPIHost: fieldTest ? 'home.ft.nest.com' : 'home.nest.com',
        cameraAPIHost: fieldTest ? 'camera.home.ft.nest.com' : 'camera.home.nest.com',
        protobufAPIHost: fieldTest ? 'grpc-web.ft.nest.com' : 'grpc-web.production.nest.com',
      };
    }
  });

  return connections;
}

// Define exports
export { processConfig, buildConnections };
