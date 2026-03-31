// Configuration Processor
// Part of homebridge-nest-accfactory
//
// Validates, normalises, and prepares the platform configuration used by the plugin.
// Handles migration of legacy configuration formats, runtime option processing,
// and initialisation of shared capabilities such as FFmpeg support.
//
// Responsibilities:
// - Validate and normalise Homebridge configuration structure
// - Migrate legacy account and device formats to current schema
// - Process global and per-device runtime options
// - Configure logging behaviour (including debug mode)
// - Probe and validate FFmpeg binary and feature support
// - Build connection objects for Nest and Google accounts
//
// Features:
// - Automatic migration of legacy Nest/Google account configuration
// - Legacy device object-to-array transformation
// - Runtime option defaults and bounds validation
// - FFmpeg capability detection (version, encoders, decoders, hwaccel)
// - Debug logging override with coloured output
// - Optional automatic persistence of migrated config.json
// - Connection builder for multi-account support with retry metadata
//
// Notes:
// - processConfig() mutates the provided config object in place
// - buildConnections() creates runtime connection definitions keyed by UUID
// - persistMigratedConfig() safely updates config.json when migration occurs
// - FFmpeg validation determines availability of camera streaming and HKSV recording
// - Used during plugin startup before any device initialisation
//
// Code version 2026.03.25
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import crypto from 'node:crypto';
import fs from 'node:fs';

// Define external library requirements
import chalk from 'chalk';

// Import our modules
import FFmpeg from './ffmpeg.js';

// Define constants
import { FFMPEG_VERSION, ACCOUNT_TYPE } from './consts.js';

function processConfig(config, log, api) {
  let migratedAccounts = false;
  let migratedDevices = false;

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
      config.google !== null &&
      typeof config.google?.issuetoken === 'string' &&
      config.google.issuetoken.trim() !== '' &&
      typeof config.google?.cookie === 'string' &&
      config.google.cookie.trim() !== ''
    ) {
      newAccounts.push({
        name: 'Google',
        type: 'google',
        issueToken: config.google.issuetoken.trim(),
        cookie: config.google.cookie.trim(),
        fieldTest: config.google.fieldTest === true,
      });
    }

    if (newAccounts.length > 0) {
      config.accounts = newAccounts;
      migratedAccounts = true;
    }
  }

  let options = (config.options = typeof config?.options === 'object' ? config.options : {});

  options.eveHistory = config.options?.eveHistory !== false; // Default to true if not explicitly set to false
  options.exclude = config.options?.exclude === true; // Default to false if not explicitly set to true
  options.logMotionEvents = config.options?.logMotionEvents !== false; // Default to true if not explicitly set to false

  // Controls what APIs we use, default is to use both Nest and Google APIs
  options.useNestAPI = config.options?.useNestAPI === true || config.options?.useNestAPI === undefined;
  options.useGoogleAPI = config.options?.useGoogleAPI === true || config.options?.useGoogleAPI === undefined;

  // Verbose Logging. Independent of Homebridge debug mode.
  options.debug = config.options?.debug === true;
  if (options.debug === true) {
    // Force chalk to output colours for debug messages even if Homebridge debug mode is not enabled.
    // This improves readability of verbose logs in some terminals.
    chalk.level = 1;
  }

  // Override log.debug to output gray coloured messages when verbose logging is enabled.
  // When disabled, debug logging becomes a no-op.
  log.debug = options.debug === true ? (message, ...parameters) => log?.info?.(chalk.gray(message), ...parameters) : () => {};

  // Support Dump for Nest and Google API data.
  // When enabled, the plugin will output raw API objects to the log to assist with troubleshooting.
  // This may produce a large amount of log output and should normally only be enabled temporarily.
  options.supportDump = config?.options?.supportDump === true;

  // Get configuration for max number of concurrent 'live view' streams.
  options.maxStreams =
    isNaN(config.options?.maxStreams) === false && Number(config.options.maxStreams) > 1 && Number(config.options.maxStreams) <= 4
      ? Number(config.options.maxStreams)
      : 2;

  // Check if an ffmpeg binary exists via a specific path in configuration OR /usr/local/bin
  options.ffmpeg = {
    binary: undefined,
    valid: false,
    debug: config.options?.ffmpegDebug === true, // Default to false if not explicitly set to true
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
      log?.debug?.(
        'FFmpeg: v%s "%s" (hwaccel: %s)',
        ffmpeg.version,
        ffmpeg.binary,
        ffmpeg.supportsHardwareH264 === true ? ffmpeg.hardwareH264Codec : 'none',
      );

      options.ffmpeg.binary = ffmpeg.binary;
      options.ffmpeg.version = ffmpeg.version;
      options.ffmpeg.hwaccel = ffmpeg.supportsHardwareH264 === true;
    }
  }

  // Process per device configuration(s)
  if (config?.devices === undefined) {
    config.devices = [];
  }

  if (
    config?.devices !== undefined &&
    Array.isArray(config.devices) === false &&
    typeof config.devices === 'object' &&
    config.devices !== null
  ) {
    let newDeviceArray = [];
    let validLegacyDeviceConfig = true;

    for (const [serialNumber, props] of Object.entries(config.devices)) {
      if (typeof props !== 'object' || props === null || Array.isArray(props) === true) {
        validLegacyDeviceConfig = false;
        break;
      }

      newDeviceArray.push({
        serialNumber,
        ...props,
      });
    }

    if (validLegacyDeviceConfig === true) {
      config.devices = newDeviceArray;
      migratedDevices = true;
    }
  }

  // Per home configuration(s)
  if (Array.isArray(config?.homes) === false) {
    config.homes = [];
  }

  if (migratedAccounts === true || migratedDevices === true) {
    if (persistMigratedConfig(config, log, api) === false) {
      log?.warn?.('');
      log?.warn?.('NOTICE');
      log?.warn?.('> Legacy configuration detected');
      log?.warn?.('> Account and/or device settings have been migrated in memory for this startup');
      log?.warn?.('> Please review and re-save your configuration using the Homebridge UI');
      log?.warn?.('> See README for updated configuration examples');
      log?.warn?.('');
    }
  }

  return config;
}

function buildConnections(config) {
  let connections = {};

  (config.accounts || []).forEach((account) => {
    // Skip invalid accounts
    if (typeof account?.name !== 'string' || account.name.trim() === '') {
      return;
    }

    let accountName = account.name.trim();
    let fieldTest = account?.fieldTest === true; // Default to false
    let exclude = account?.exclude === true; // Default to false

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
        exclude: exclude,
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
        exclude: exclude,
      };
    }
  });

  return connections;
}

function persistMigratedConfig(config, log, api) {
  // Ensure Homebridge API supports configPath()
  if (typeof api?.user?.configPath !== 'function') {
    return false;
  }

  try {
    // Resolve config paths (current, backup, temp)
    let configPath = api.user.configPath();
    let backupPath = configPath + '.bak';
    let tempPath = configPath + '.tmp';

    // Load existing Homebridge config
    let rawConfig = fs.readFileSync(configPath, 'utf8');
    let jsonConfig = JSON.parse(rawConfig);
    let matchingPlatforms = [];

    // Ensure platforms array exists
    if (Array.isArray(jsonConfig?.platforms) === false) {
      return false;
    }

    jsonConfig.platforms.forEach((platform, index) => {
      // Only consider our platform name
      if (platform?.platform !== 'NestAccfactory') {
        return;
      }

      // Check for legacy Nest config
      let hasLegacyNest =
        typeof platform?.nest === 'object' &&
        platform.nest !== null &&
        typeof platform.nest?.access_token === 'string' &&
        platform.nest.access_token.trim() !== '';

      // Check for legacy Google config
      let hasLegacyGoogle =
        typeof platform?.google === 'object' &&
        platform.google !== null &&
        typeof platform.google?.issuetoken === 'string' &&
        platform.google.issuetoken.trim() !== '' &&
        typeof platform.google?.cookie === 'string' &&
        platform.google.cookie.trim() !== '';

      // Check for legacy devices block
      let hasLegacyDevices =
        typeof platform?.devices === 'object' && platform.devices !== null && Array.isArray(platform.devices) === false;

      // Skip entries with nothing to migrate
      if (hasLegacyNest === false && hasLegacyGoogle === false && hasLegacyDevices === false) {
        return;
      }

      matchingPlatforms.push(index);
    });

    // Must resolve to exactly one platform to proceed safely
    if (matchingPlatforms.length !== 1) {
      return false;
    }

    // Apply migrated structure
    jsonConfig.platforms[matchingPlatforms[0]].accounts = config.accounts;
    jsonConfig.platforms[matchingPlatforms[0]].devices = config.devices;

    // Remove legacy config blocks
    delete jsonConfig.platforms[matchingPlatforms[0]].nest;
    delete jsonConfig.platforms[matchingPlatforms[0]].google;

    // Backup original config before modifying
    fs.writeFileSync(backupPath, rawConfig, 'utf8');

    // Write updated config to temp file first (safer write)
    fs.writeFileSync(tempPath, JSON.stringify(jsonConfig, null, 2), 'utf8');

    // Atomically replace original config
    fs.renameSync(tempPath, configPath);

    // Inform user of automatic migration
    log?.warn?.('');
    log?.warn?.('NOTICE');
    log?.warn?.('> Legacy configuration detected');
    log?.warn?.('> Account and/or device settings have been migrated to the current configuration format');
    log?.warn?.('> Homebridge configuration has been automatically updated');
    log?.warn?.('> A backup of the previous config has been saved as "config.json.bak"');
    log?.warn?.('');

    return true;
  } catch (error) {
    try {
      // Cleanup temp file if something failed mid-write
      let configPath = api.user.configPath();
      let tempPath = configPath + '.tmp';

      if (fs.existsSync(tempPath) === true) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // Ignore cleanup errors
    }

    // Log failure but do not crash plugin
    log?.warn?.('Unable to automatically update config.json: %s', error?.message || error);
    return false;
  }
}

// Define exports
export { processConfig, buildConnections };
