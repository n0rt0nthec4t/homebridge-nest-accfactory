// Configuration validation and processing
// Part of homebridge-nest-accfactory
//
// Validates and processes the platform configuration from Homebridge settings
// Handles account configuration (supports multiple accounts of mixed types)
// Migrates legacy single account format to new accounts array format
// Processes options (logging, elevation, FFmpeg, API selection, etc.)
//
// Exported functions:
//
// processConfig(config, log) - validates and normalizes config object
//   Returns: normalized config with accounts array, options object, devices array, homes array
//   Performs legacy account format migration (nest/google objects -> accounts array)
//
// buildConnections(config) - creates connection objects from accounts array
//   Returns: connections object with UUID keys, each containing account credentials and settings
//   Prepares connections for use with Nest and Google APIs
//
// Code version 2026.03.15
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Define external library requirements
import chalk from 'chalk';

// Import our modules
import FFmpeg from './ffmpeg.js';

// Define constants
import { FFMPEG_VERSION, ACCOUNT_TYPE, MIN_ELEVATION, MAX_ELEVATION } from './consts.js';

function processConfig(config, log, api) {
  // Process account configuration(s)
  if (Array.isArray(config?.accounts) === false) {
    config.accounts = [];
  }

  // Migrate legacy Nest/Google account configuration if accounts array is empty
  // Remove this migration logic in a future major release after giving users sufficient time to update their configuration.
  if (config.accounts.length === 0) {
    let newAccounts = [];

    if (typeof config?.nest === 'object' && typeof config.nest?.access_token === 'string' && config.nest.access_token.trim() !== '') {
      newAccounts.push({
        name: 'Nest',
        type: 'nest',
        access_token: config.nest.access_token.trim(),
        fieldTest: config.nest.fieldTest === true,
      });
    }

    if (
      typeof config?.google === 'object' &&
      typeof config.google?.issueToken === 'string' &&
      config.google.issueToken.trim() !== '' &&
      typeof config.google?.cookie === 'string' &&
      config.google.cookie.trim() !== ''
    ) {
      newAccounts.push({
        name: 'Google',
        type: 'google',
        issueToken: config.google.issueToken.trim(),
        cookie: config.google.cookie.trim(),
        fieldTest: config.google.fieldTest === true,
      });
    }

    if (newAccounts.length > 0) {
      config.accounts = newAccounts;

      if (persistMigratedAccounts(config, newAccounts, log, api) === false) {
        log?.warn?.('');
        log?.warn?.('NOTICE');
        log?.warn?.('> Legacy account configuration detected');
        log?.warn?.('> Nest / Google account settings have been migrated in memory for this startup');
        log?.warn?.('> Please review and re-save your configuration using the Homebridge UI');
        log?.warn?.('> See README for updated configuration examples');
        log?.warn?.('');
      }
    }
  }

  let options = (config.options = typeof config?.options === 'object' ? config.options : {});

  options.eveHistory = config.options?.eveHistory === true;
  options.weather = config.options?.weather === true;
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

  // Verbose Logging. Independent of Homebridge debug mode.
  options.debug = config.options?.debug === true;

  if (options.debug === true) {
    // Force chalk to output colours for debug messages even if Homebridge debug mode is not enabled.
    // This improves readability of verbose logs in some terminals.
    chalk.level = 1;

    log?.warn?.('Verbose logging enabled via configuration');
  }

  // Override log.debug to output gray coloured messages when verbose logging is enabled.
  // When disabled, debug logging becomes a no-op.
  log.debug = options.debug === true ? (message, ...parameters) => log?.info?.(chalk.gray(message), ...parameters) : () => {};

  // Support Dump for Nest and Google API data.
  // When enabled, the plugin will output raw API objects to the log to assist with troubleshooting.
  // This may produce a large amount of log output and should normally only be enabled temporarily.
  options.supportDump = config?.options?.supportDump === true;

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
      log?.success?.('Valid ffmpeg found for camera/doorbell streaming support');
      log?.debug?.('Binary "%s"', ffmpeg.binary);
      log?.debug?.('Version "%s"', ffmpeg.version);
      options.ffmpeg.binary = ffmpeg.binary;
      options.ffmpeg.version = ffmpeg.version;
      options.ffmpeg.hwaccel = ffmpeg.supportsHardwareH264 === true;
      if (ffmpeg.supportsHardwareH264 === true) {
        log?.debug?.('Hardware H264 encoding available via "%s"', ffmpeg.hardwareH264Codec);
      }
    }
  }

  // Process per device configuration(s)
  if (Array.isArray(config?.devices) === false) {
    config.devices = [];
  }

  // Per home configuration(s)
  if (Array.isArray(config?.homes) === false) {
    config.homes = [];
  }

  return config;
}

function buildConnections(config) {
  let connections = {};

  (config.accounts || []).forEach((account) => {
    let fieldTest = account?.fieldTest === true;
    let accountName = typeof account?.name === 'string' ? account.name.trim() : '';

    if (accountName === '') {
      return;
    }

    if (account?.type === 'nest' && typeof account?.access_token === 'string' && account.access_token.trim() !== '') {
      connections[crypto.randomUUID()] = {
        name: accountName,
        type: ACCOUNT_TYPE.NEST,
        authorised: false,
        allowRetry: undefined, // On purpose having this as undefined
        access_token: account.access_token.trim(),
        fieldTest: fieldTest,
        referer: fieldTest ? 'home.ft.nest.com' : 'home.nest.com',
        restAPIHost: fieldTest ? 'home.ft.nest.com' : 'home.nest.com',
        cameraAPIHost: fieldTest ? 'camera.home.ft.nest.com' : 'camera.home.nest.com',
        protobufAPIHost: fieldTest ? 'grpc-web.ft.nest.com' : 'grpc-web.production.nest.com',
      };
    }

    if (
      account?.type === 'google' &&
      typeof account?.issueToken === 'string' &&
      account.issueToken.trim() !== '' &&
      typeof account?.cookie === 'string' &&
      account.cookie.trim() !== ''
    ) {
      connections[crypto.randomUUID()] = {
        name: accountName,
        type: ACCOUNT_TYPE.GOOGLE,
        authorised: false,
        allowRetry: undefined, // On purpose having this as undefined
        issueToken: account.issueToken.trim(),
        cookie: account.cookie.trim(),
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

function persistMigratedAccounts(config, newAccounts, log, api) {
  if (typeof api?.user?.storagePath !== 'function' || Array.isArray(newAccounts) === false || newAccounts.length === 0) {
    return false;
  }

  try {
    let configPath = path.join(api.user.storagePath(), 'config.json');
    let backupPath = configPath + '.bak';
    let tempPath = configPath + '.tmp';
    let rawConfig = fs.readFileSync(configPath, 'utf8');
    let jsonConfig = JSON.parse(rawConfig);
    let matchingPlatforms = [];

    if (Array.isArray(jsonConfig?.platforms) === false) {
      log?.warn?.('Unable to automatically update config.json: no platforms array found');
      return false;
    }

    jsonConfig.platforms.forEach((platform, index) => {
      let nestMatches = false;
      let googleMatches = false;

      if (platform?.platform !== 'NestAccfactory') {
        return;
      }

      if (
        typeof config?.nest?.access_token === 'string' &&
        config.nest.access_token.trim() !== '' &&
        typeof platform?.nest?.access_token === 'string' &&
        platform.nest.access_token.trim() === config.nest.access_token.trim()
      ) {
        nestMatches = true;
      }

      if (
        typeof config?.google?.issueToken === 'string' &&
        config.google.issueToken.trim() !== '' &&
        typeof config?.google?.cookie === 'string' &&
        config.google.cookie.trim() !== '' &&
        typeof platform?.google?.issueToken === 'string' &&
        platform.google.issueToken.trim() === config.google.issueToken.trim() &&
        typeof platform?.google?.cookie === 'string' &&
        platform.google.cookie.trim() === config.google.cookie.trim()
      ) {
        googleMatches = true;
      }

      // If both legacy account types exist in the current config, require both to match.
      if (
        typeof config?.nest?.access_token === 'string' &&
        config.nest.access_token.trim() !== '' &&
        typeof config?.google?.issueToken === 'string' &&
        config.google.issueToken.trim() !== '' &&
        typeof config?.google?.cookie === 'string' &&
        config.google.cookie.trim() !== ''
      ) {
        if (nestMatches === true && googleMatches === true) {
          matchingPlatforms.push(index);
        }
        return;
      }

      // If only Nest exists, match only Nest.
      if (typeof config?.nest?.access_token === 'string' && config.nest.access_token.trim() !== '') {
        if (nestMatches === true) {
          matchingPlatforms.push(index);
        }
        return;
      }

      // If only Google exists, match only Google.
      if (
        typeof config?.google?.issueToken === 'string' &&
        config.google.issueToken.trim() !== '' &&
        typeof config?.google?.cookie === 'string' &&
        config.google.cookie.trim() !== ''
      ) {
        if (googleMatches === true) {
          matchingPlatforms.push(index);
        }
      }
    });

    // Secondary disambiguation by name if required
    if (matchingPlatforms.length > 1 && typeof config?.name === 'string' && config.name.trim() !== '') {
      matchingPlatforms = matchingPlatforms.filter((index) => {
        return jsonConfig.platforms[index]?.name === config.name;
      });
    }

    if (matchingPlatforms.length !== 1) {
      log?.warn?.('Unable to automatically update config.json because the matching platform entry was not unique');
      return false;
    }

    jsonConfig.platforms[matchingPlatforms[0]].accounts = newAccounts;
    delete jsonConfig.platforms[matchingPlatforms[0]].nest;
    delete jsonConfig.platforms[matchingPlatforms[0]].google;

    fs.writeFileSync(backupPath, rawConfig, 'utf8');
    fs.writeFileSync(tempPath, JSON.stringify(jsonConfig, null, 2), 'utf8');
    fs.renameSync(tempPath, configPath);

    log?.warn?.('');
    log?.warn?.('NOTICE');
    log?.warn?.('> Legacy account configuration detected');
    log?.warn?.('> Nest / Google account settings have been migrated to the new "accounts" array format');
    log?.warn?.('> Homebridge configuration has been automatically updated');
    log?.warn?.('> A backup of the previous config has been saved as "config.json.bak"');
    log?.warn?.('');

    return true;
  } catch (error) {
    try {
      let configPath = path.join(api.user.storagePath(), 'config.json');
      let tempPath = configPath + '.tmp';

      if (fs.existsSync(tempPath) === true) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // Ignore errors from cleanup
    }

    log?.warn?.('Unable to automatically update config.json: %s', error?.message || error);
    return false;
  }
}

// Define exports
export { processConfig, buildConnections };
