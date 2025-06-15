// Configuration validation and processing
// Part of homebridge-nest-accfactory
//
// Code version 2025.06.15
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import fs from 'fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import child_process from 'node:child_process';

// Define constants
const FFMPEG_VERSION = '6.0.0';
const ACCOUNT_TYPE = {
  NEST: 'Nest',
  GOOGLE: 'Google',
};

function processConfig(config, log) {
  let options = (config.options = typeof config?.options === 'object' ? config.options : {});

  options.eveHistory = config.options?.eveHistory === true;
  options.weather = config.options?.weather === true;
  options.hksv = config.options?.hksv === true;
  options.exclude = config.options?.exclude === true;

  options.elevation =
    isNaN(config.options?.elevation) === false && Number(config.options.elevation) >= 0 && Number(config.options.elevation) <= 8848
      ? Number(config.options.elevation)
      : 0;

  // Controls what APIs we use, default is to use both Nest and protobuf APIs
  options.useNestAPI = config.options?.useNestAPI === true || config.options?.useNestAPI === undefined;
  options.useGoogleAPI = config.options?.useGoogleAPI === true || config.options?.useGoogleAPI === undefined;

  // Get configuration for max number of concurrent 'live view' streams. For HomeKit Secure Video, this will always be 1
  options.maxStreams = isNaN(config.options?.maxStreams) === false ? Number(config.options.maxStreams) : 2;

  // Check if a ffmpeg binary exist via a specific path in configuration OR /usr/local/bin
  options.ffmpeg = {};
  options.ffmpeg.debug = config.options?.ffmpegDebug === true;
  options.ffmpeg.binary = path.resolve(
    typeof config.options?.ffmpegPath === 'string' && config.options.ffmpegPath !== '' ? config.options.ffmpegPath : '/usr/local/bin',
  );

  // If the path doesn't include 'ffmpeg' on the end, we'll add it here
  if (options.ffmpeg.binary.endsWith('/ffmpeg') === false) {
    options.ffmpeg.binary += '/ffmpeg';
  }

  options.ffmpeg.version = undefined;
  options.ffmpeg.libspeex = false;
  options.ffmpeg.libopus = false;
  options.ffmpeg.libx264 = false;
  options.ffmpeg.libfdk_aac = false;

  if (fs.existsSync(options.ffmpeg.binary) === false) {
    // If we flag ffmpegPath as undefined, no video streaming/record support enabled for camers/doorbells
    log?.warn?.('Specified ffmpeg binary "%s" was not found', options.ffmpeg.binary);
    log?.warn?.('Stream video/recording from camera/doorbells will be unavailable');
    options.ffmpeg.binary = undefined;
  }

  if (fs.existsSync(options.ffmpeg.binary) === true) {
    let ffmpegProcess = child_process.spawnSync(options.ffmpeg.binary, ['-version'], {
      env: process.env,
    });

    if (ffmpegProcess.stdout !== null) {
      let stdout = ffmpegProcess.stdout.toString();

      // Determine what libraries ffmpeg is compiled with
      options.ffmpeg.version = stdout.match(/(?:ffmpeg version:(\d+)\.)?(?:(\d+)\.)?(?:(\d+)\.\d+)(.*?)/gim)?.[0];
      options.ffmpeg.libspeex = stdout.includes('--enable-libspeex') === true;
      options.ffmpeg.libopus = stdout.includes('--enable-libopus') === true;
      options.ffmpeg.libx264 = stdout.includes('--enable-libx264') === true;
      options.ffmpeg.libfdk_aac = stdout.includes('--enable-libfdk-aac') === true;

      let versionTooOld =
        options.ffmpeg.version?.localeCompare(FFMPEG_VERSION, undefined, {
          numeric: true,
          sensitivity: 'case',
          caseFirst: 'upper',
        }) === -1;

      if (
        versionTooOld ||
        options.ffmpeg.libspeex === false ||
        options.ffmpeg.libopus === false ||
        options.ffmpeg.libx264 === false ||
        options.ffmpeg.libfdk_aac === false
      ) {
        log?.warn?.('ffmpeg binary "%s" does not meet the minimum support requirements', options.ffmpeg.binary);

        if (versionTooOld) {
          log?.warn?.('Minimum binary version is "%s", however the installed version is "%s"', FFMPEG_VERSION, options.ffmpeg.version);
          log?.warn?.('Stream video/recording from camera/doorbells will be unavailable');
          options.ffmpeg.binary = undefined; // No ffmpeg since below min version
        }

        if (!options.ffmpeg.libspeex && options.ffmpeg.libx264 && options.ffmpeg.libfdk_aac) {
          log?.warn?.('Missing libspeex in ffmpeg binary, talkback on certain camera/doorbells will be unavailable');
        }

        if (options.ffmpeg.libx264 && !options.ffmpeg.libfdk_aac && !options.ffmpeg.libopus) {
          log?.warn?.('Missing libfdk_aac and libopus in ffmpeg binary, audio from camera/doorbells will be unavailable');
        }

        if (options.ffmpeg.libx264 && !options.ffmpeg.libfdk_aac) {
          log?.warn?.('Missing libfdk_aac in ffmpeg binary, audio from camera/doorbells will be unavailable');
        }

        if (options.ffmpeg.libx264 && options.ffmpeg.libfdk_aac && !options.ffmpeg.libopus) {
          log?.warn?.('Missing libopus in ffmpeg binary, audio (including talkback) from certain camera/doorbells will be unavailable');
        }

        if (!options.ffmpeg.libx264) {
          log?.warn?.('Missing libx264 in ffmpeg binary, stream video/recording from camera/doorbells will be unavailable');
          options.ffmpeg.binary = undefined; // No ffmpeg since we do not have all the required libraries
        }
      }
    }
  }

  if (options.ffmpeg.binary !== undefined) {
    log?.success?.('Found valid ffmpeg binary in %s', options.ffmpeg.binary);
  }

  // Process per device configuration(s)
  if (config?.devices === undefined) {
    config.devices = [];
  }

  if (config?.devices !== undefined && Array.isArray(config.devices) === false) {
    // If the devices section is a JSON oject keyed by the devices serial number, convert to devices array object
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
    log?.warn?.('> Consider updating your configuration file as the mapping from legacy to current per device configuration maybe removed');
    log?.warn?.('> https://github.com/n0rt0nthec4t/homebridge-nest-accfactory/blob/main/src/README.md');
    log?.warn?.('');
  }

  return config;
}

function buildConnections(config) {
  let connections = {};

  Object.keys(config).forEach((key) => {
    let section = config[key];

    if (typeof section?.access_token === 'string' && section.access_token !== '') {
      let fieldTest = section?.fieldTest === true;
      connections[crypto.randomUUID()] = {
        name: key,
        type: ACCOUNT_TYPE.NEST,
        authorised: false,
        access_token: section.access_token,
        fieldTest,
        referer: fieldTest ? 'home.ft.nest.com' : 'home.nest.com',
        restAPIHost: fieldTest ? 'home.ft.nest.com' : 'home.nest.com',
        cameraAPIHost: fieldTest ? 'camera.home.ft.nest.com' : 'camera.home.nest.com',
        protobufAPIHost: fieldTest ? 'grpc-web.ft.nest.com' : 'grpc-web.production.nest.com',
      };
    }

    if (
      typeof section?.issuetoken === 'string' &&
      section.issuetoken !== '' &&
      typeof section?.cookie === 'string' &&
      section.cookie !== ''
    ) {
      let fieldTest = section?.fieldTest === true;
      connections[crypto.randomUUID()] = {
        name: key,
        type: ACCOUNT_TYPE.GOOGLE,
        authorised: false,
        issuetoken: section.issuetoken,
        cookie: section.cookie,
        fieldTest,
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
export { ACCOUNT_TYPE, processConfig, buildConnections };
