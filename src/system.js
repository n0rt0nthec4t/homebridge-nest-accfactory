/* eslint-disable @stylistic/indent */
// Nest System communications
// Part of homebridge-nest-accfactory
//
// Code version 2/9/2024
// Mark Hulskamp
'use strict';

// Define external module requirements
import axios from 'axios';
import protobuf from 'protobufjs';

// Define nodejs module requirements
import EventEmitter from 'node:events';
import { Buffer } from 'node:buffer';
import { setInterval, clearInterval, setTimeout } from 'node:timers';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import child_process from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Import our modules
import HomeKitDevice from './HomeKitDevice.js';
import NestCamera from './camera.js';
import NestDoorbell from './doorbell.js';
import NestProtect from './protect.js';
import NestTemperatureSensor from './tempsensor.js';
import NestWeather from './weather.js';
import NestThermostat from './thermostat.js';

const CAMERAALERTPOLLING = 2000; // Camera alerts polling timer
const CAMERAZONEPOLLING = 30000; // Camera zones changes polling timer
const WEATHERPOLLING = 300000; // Weather data polling timer
const NESTAPITIMEOUT = 10000; // Nest API timeout
const USERAGENT = 'Nest/5.75.0 (iOScom.nestlabs.jasper.release) os=17.4.1'; // User Agent string
const FFMPEGVERSION = '6.0'; // Minimum version of ffmpeg we require

const __dirname = path.dirname(fileURLToPath(import.meta.url)); // Make a defined for JS __dirname

// We handle the connections to Nest/Google
// Perform device management (additions/removals/updates)
export default class NestAccfactory {
  static DeviceType = {
    THERMOSTAT: 'thermostat',
    TEMPSENSOR: 'temperature',
    SMOKESENSOR: 'protect',
    CAMERA: 'camera',
    DOORBELL: 'doorbell',
    WEATHER: 'weather',
    LOCK: 'lock', // yet to implement
    ALARM: 'alarm', // yet to implement
  };

  static DataSource = {
    REST: 'REST', // From the REST API
    PROTOBUF: 'PROTOBUF', // From the protobuf API
  };

  static GoogleConnection = 'google';
  static NestConnection = 'nest';

  cachedAccessories = []; // Track restored cached accessories

  // Internal data we use within the platform accessory for various things
  #connections = {}; // Array of confirmed connections, indexed by type
  #rawData = {}; // Cached copy of data from both Rest and Protobuf APIs
  #eventEmitter = new EventEmitter(); // Used for object messaging from this platform

  constructor(log, config, api) {
    this.config = config;
    this.log = log;
    this.api = api;

    // Perform validation on the configuration passed into us and set defaults if not present
    if (typeof this.config?.nest !== 'object') {
      this.config.nest = {};
    }
    this.config.nest.access_token = typeof this.config.nest?.access_token === 'string' ? this.config.nest.access_token : '';
    this.config.nest.fieldTest = typeof this.config.nest?.fieldTest === 'boolean' ? this.config.nest.fieldTest : false;

    if (typeof this.config?.google !== 'object') {
      this.config.google = {};
    }
    this.config.google.issuetoken = typeof this.config.google?.issuetoken === 'string' ? this.config.google.issuetoken : '';
    this.config.google.cookie = typeof this.config.google?.cookie === 'string' ? this.config.google.cookie : '';
    this.config.google.fieldTest = typeof this.config.google?.fieldTest === 'boolean' ? this.config.google.fieldTest : false;

    if (typeof this.config?.options !== 'object') {
      this.config.options = {};
    }

    this.config.options.eveHistory = typeof this.config.options?.eveHistory === 'boolean' ? this.config.options.eveHistory : false;
    this.config.options.elevation = typeof this.config.options?.elevation === 'number' ? this.config.options.elevation : 0;
    this.config.options.weather = typeof this.config.options?.weather === 'boolean' ? this.config.options.weather : false;
    this.config.options.hksv = typeof this.config.options?.hksv === 'boolean' ? this.config.options.hksv : false;

    // Get configuration for max number of concurrent 'live view' streams. For HomeKit Secure Video, this will always be 1
    this.config.options.maxStreams =
      typeof this.config.options?.maxStreams === 'number' && this.deviceData?.hksv === false
        ? this.config.options.maxStreams
        : this.deviceData?.hksv === true
          ? 1
          : 2;

    // Check if a ffmpeg binary exists in current path OR the specific path via configuration
    // If using HomeBridge, the default path will be where the Homebridge user folder is, otherwise the current directory
    this.config.options.ffmpeg = {};
    this.config.options.ffmpeg['path'] =
      typeof this.config.options?.ffmpegPath === 'string' && this.config.options.ffmpegPath !== ''
        ? this.config.options.ffmpegPath
        : typeof api?.user?.storagePath === 'function'
          ? api.user.storagePath()
          : __dirname;

    this.config.options.ffmpeg['version'] = undefined;
    this.config.options.ffmpeg.libspeex = false;
    this.config.options.ffmpeg.libx264 = false;
    this.config.options.ffmpeg.libfdk_aac = false;

    if (fs.existsSync(path.resolve(this.config.options.ffmpeg.path + '/ffmpeg')) === false) {
      if (this?.log?.warn) {
        this.log.warn('No ffmpeg binary found in "%s"', this.config.options.ffmpeg.path);
        this.log.warn('Streaming/recording video will be unavailable for cameras/doorbells');
      }

      // If we flag ffmpegPath as undefined, no video streaming/record support enabled for camers/doorbells
      this.config.options.ffmpeg.path = undefined;
    }

    if (fs.existsSync(path.resolve(this.config.options.ffmpeg.path + '/ffmpeg')) === true) {
      let ffmpegProcess = child_process.spawnSync(path.resolve(this.config.options.ffmpeg.path + '/ffmpeg'), ['-version'], {
        env: process.env,
      });
      if (ffmpegProcess.stdout !== null) {
        // Determine ffmpeg version
        this.config.options.ffmpeg.version = ffmpegProcess.stdout
          .toString()
          .match(/(?:ffmpeg version:(\d+)\.)?(?:(\d+)\.)?(?:(\d+)\.\d+)(.*?)/gim)[0];

        // Determine what libraries ffmpeg is compiled with
        this.config.options.ffmpeg.libspeex = ffmpegProcess.stdout.toString().includes('--enable-libspeex') === true;
        this.config.options.ffmpeg.libx264 = ffmpegProcess.stdout.toString().includes('--enable-libx264') === true;
        this.config.options.ffmpeg.libfdk_aac = ffmpegProcess.stdout.toString().includes('--enable-libfdk-aac') === true;

        if (
          this.config.options.ffmpeg.version.replace(/\./gi, '') < parseFloat(FFMPEGVERSION.toString().replace(/\./gi, '')) ||
          this.config.options.ffmpeg.libspeex === false ||
          this.config.options.ffmpeg.libx264 === false ||
          this.config.options.ffmpeg.libfdk_aac === false
        ) {
          this?.log?.warn && this.log.warn('ffmpeg binary in "%s" does not meet the minimum requirements', this.config.options.ffmpeg.path);
          if (this.config.options.ffmpeg.version.replace(/\./gi, '') < parseFloat(FFMPEGVERSION.toString().replace(/\./gi, ''))) {
            this?.log?.warn &&
              this.log.warn(
                'Minimum binary version is "%s", however the installed version is "%s"',
                FFMPEGVERSION,
                this.config.options.ffmpeg.version,
              );
            this?.log?.warn && this.log.warn('Stream video/recording from camera/doorbells will be unavailable');

            this.config.options.ffmpeg.path = undefined; // No ffmpeg since below min version
          }
          if (
            this.config.options.ffmpeg.libspeex === false &&
            (this.config.options.ffmpeg.libx264 === true && this.config.options.ffmpeg.libfdk_aac) === true
          ) {
            this?.log?.warn && this.log.warn('Missing libspeex in ffmpeg binary, two-way audio on camera/doorbells will be unavailable');
          }
          if (this.config.options.ffmpeg.libx264 === true && this.config.options.ffmpeg.libfdk_aac === false) {
            this?.log?.warn && this.log.warn('Missing libfdk_aac in ffmpeg binary, audio from camera/doorbells will be unavailable');
          }
          if (this.config.options.ffmpeg.libx264 === false) {
            this?.log?.warn &&
              this.log.warn('Missing libx264 in ffmpeg binary, stream video/recording from camera/doorbells will be unavailable');

            this.config.options.ffmpeg.path = undefined; // No ffmpeg since we do not have all the required libraries
          }
        }
      }
    }

    // If we don't have either a Nest access_token and/or a Google issuetoken/cookie, return back.
    if (this.config.nest.access_token === '' && (this.config.google.issuetoken === '' || this.config.google.cookie === '')) {
      this?.log?.error && this.log.error('JSON plugin configuration is invalid. Please review');
      return;
    }

    if (this.api instanceof EventEmitter === true) {
      this.api.on('didFinishLaunching', async () => {
        // We got notified that Homebridge has finished loading, so we are ready to process
        this.discoverDevices();
      });

      this.api.on('shutdown', async () => {
        // We got notified that Homebridge is shutting down. Perform cleanup??
      });
    }
  }

  configureAccessory(accessory) {
    // This gets called from HomeBridge each time it restores an accessory from its cache
    this?.log?.info && this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache, so we can track if it has already been registered
    this.cachedAccessories.push(accessory);
  }

  async discoverDevices() {
    await this.#connect();
    if (typeof this.#connections?.nest === 'object') {
      // We have a 'Nest' connected account, so process accordingly
      this.#eventEmitter.addListener(HomeKitDevice.SET, (deviceUUID, values) => {
        this.#set(NestAccfactory.NestConnection, deviceUUID, values);
      });
      this.#eventEmitter.addListener(HomeKitDevice.GET, (deviceUUID, values) => {
        this.#get(NestAccfactory.NestConnection, deviceUUID, values);
      });

      this.#subscribeREST(NestAccfactory.NestConnection, false);
      this.#subscribeProtobuf(NestAccfactory.NestConnection);
    }

    if (typeof this.#connections?.google === 'object') {
      // We have a 'Google' connected account, so process accordingly
      this.#eventEmitter.addListener(HomeKitDevice.SET, (deviceUUID, values) => {
        this.#set(NestAccfactory.GoogleConnection, deviceUUID, values);
      });
      this.#eventEmitter.addListener(HomeKitDevice.GET, (deviceUUID, values) => {
        this.#get(NestAccfactory.GoogleConnection, deviceUUID, values);
      });

      this.#subscribeREST(NestAccfactory.GoogleConnection, false);
      this.#subscribeProtobuf(NestAccfactory.GoogleConnection);
    }
  }

  async #connect() {
    if (
      typeof this.config?.google === 'object' &&
      typeof this.config?.google?.issuetoken === 'string' &&
      this.config?.google?.issuetoken !== '' &&
      typeof this.config?.google?.cookie === 'string' &&
      this.config?.google?.cookie !== ''
    ) {
      let referer = 'home.nest.com'; // Which host is 'actually' doing the request
      let restAPIHost = 'home.nest.com'; // Root URL for Nest system REST API
      let cameraAPIHost = 'camera.home.nest.com'; // Root URL for Camera system API
      let protobufAPIHost = 'grpc-web.production.nest.com'; // Root URL for Protobuf API

      if (this.config?.google.fieldTest === true) {
        // FieldTest mode support enabled in configuration, so update default endpoints
        // This is all 'untested'
        this?.log?.info && this.log.info('Using FieldTest API endpoints for Google account');

        referer = 'home.ft.nest.com'; // Which host is 'actually' doing the request
        restAPIHost = 'home.ft.nest.com'; // Root FT URL for Nest system REST API
        cameraAPIHost = 'camera.home.ft.nest.com'; // Root FT URL for Camera system API
        protobufAPIHost = 'grpc-web.ft.nest.com'; // Root FT URL for Protobuf API
      }

      // Google cookie method as refresh token method no longer supported by Google since October 2022
      // Instructions from homebridge_nest or homebridge_nest_cam to obtain this
      this?.log?.info && this.log.info('Performing Google account authorisation');

      let request = {
        method: 'get',
        url: this.config.google.issuetoken,
        headers: {
          referer: 'https://accounts.google.com/o/oauth2/iframe',
          'User-Agent': USERAGENT,
          cookie: this.config.google.cookie,
          'Sec-Fetch-Mode': 'cors',
          'X-Requested-With': 'XmlHttpRequest',
        },
      };
      await axios(request)
        .then(async (response) => {
          if (typeof response.status !== 'number' || response.status !== 200) {
            throw new Error('Google API Authorisation failed with error');
          }

          let request = {
            method: 'post',
            url: 'https://nestauthproxyservice-pa.googleapis.com/v1/issue_jwt',
            headers: {
              referer: 'https://' + referer,
              'User-Agent': USERAGENT,
              Authorization: 'Bearer ' + response.data.access_token,
            },
            data:
              'embed_google_oauth_access_token=true&expire_after=3600s&google_oauth_access_token=' +
              response.data.access_token +
              '&policy_id=authproxy-oauth-policy',
          };

          await axios(request).then(async (response) => {
            if (typeof response.status !== 'number' || response.status !== 200) {
              throw new Error('Google Camera API Token get failed with error');
            }

            let googleToken = response.data.jwt;
            let tokenExpire = Math.floor(new Date(response.data.claims.expirationTime).valueOf() / 1000); // Token expiry, should be 1hr

            let request = {
              method: 'get',
              url: 'https://' + restAPIHost + '/session',
              headers: {
                referer: 'https://' + referer,
                'User-Agent': USERAGENT,
                Authorization: 'Basic ' + googleToken,
              },
            };

            await axios(request).then(async (response) => {
              if (typeof response.status !== 'number' || response.status !== 200) {
                throw new Error('Nest Session API get failed with error');
              }

              this?.log?.success && this.log.success('Successfully authorised using Google account');

              // Store successful connection details
              this.#connections['google'] = {
                type: 'google',
                referer: referer,
                restAPIHost: restAPIHost,
                cameraAPIHost: cameraAPIHost,
                protobufAPIHost: protobufAPIHost,
                userID: response.data.userid,
                transport_url: response.data.urls.transport_url,
                weather_url: response.data.urls.weather_url,
                timer: null,
                protobufRoot: null,
                token: googleToken,
                cameraAPI: {
                  key: 'Authorization',
                  value: 'Basic ',
                  token: googleToken,
                },
              };

              // Set timeout for token expiry refresh
              clearInterval(this.#connections['google'].timer);
              this.#connections['google'].timer = setTimeout(
                () => {
                  this?.log?.info && this.log.info('Performing periodic token refresh for Google account');
                  this.#connect();
                },
                (tokenExpire - Math.floor(Date.now() / 1000) - 60) * 1000,
              ); // Refresh just before token expiry
            });
          });
        })
        // eslint-disable-next-line no-unused-vars
        .catch((error) => {
          // The token we used to obtained a Nest session failed, so overall authorisation failed
          this?.log?.error && this.log.error('Authorisation failed using Google account');
        });
    }

    if (typeof this.config?.nest?.access_token === 'string' && this.config?.nest?.access_token !== '') {
      let referer = 'home.nest.com'; // Which host is 'actually' doing the request
      let restAPIHost = 'home.nest.com'; // Root URL for Nest system REST API
      let cameraAPIHost = 'camera.home.nest.com'; // Root URL for Camera system API
      let protobufAPIHost = 'grpc-web.production.nest.com'; // Root URL for Protobuf API

      if (this.config?.nest.fieldTest === true) {
        // FieldTest mode support enabled in configuration, so update default endpoints
        // This is all 'untested'
        this?.log?.info && this.log.info('Using FieldTest API endpoints for Nest account');

        referer = 'home.ft.nest.com'; // Which host is 'actually' doing the request
        restAPIHost = 'home.ft.nest.com'; // Root FT URL for Nest system REST API
        cameraAPIHost = 'camera.home.ft.nest.com'; // Root FT URL for Camera system API
        protobufAPIHost = 'grpc-web.ft.nest.com'; // Root FT URL for Protobuf API
      }

      // Nest access token method. Get WEBSITE2 cookie for use with camera API calls if needed later
      this?.log?.info && this.log.info('Performing Nest account authorisation');

      let request = {
        method: 'post',
        url: 'https://webapi.' + cameraAPIHost + '/api/v1/login.login_nest',
        withCredentials: true,
        headers: {
          referer: 'https://' + referer,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USERAGENT,
        },
        data: Buffer.from('access_token=' + this.config.nest.access_token, 'utf8'),
      };
      await axios(request)
        .then(async (response) => {
          if (
            typeof response.status !== 'number' ||
            response.status !== 200 ||
            typeof response.data.status !== 'number' ||
            response.data.status !== 0
          ) {
            throw new Error('Nest API Authorisation failed with error');
          }

          let nestToken = response.data.items[0].session_token;

          let request = {
            method: 'get',
            url: 'https://' + restAPIHost + '/session',
            headers: {
              referer: 'https://' + referer,
              'User-Agent': USERAGENT,
              Authorization: 'Basic ' + this.config.nest.access_token,
            },
          };

          await axios(request).then((response) => {
            if (typeof response.status !== 'number' || response.status !== 200) {
              throw new Error('Nest Session API get failed with error');
            }

            this?.log?.success && this.log.success('Successfully authorised using Nest account');

            // Store successful connection details
            this.#connections['nest'] = {
              type: 'nest',
              referer: referer,
              restAPIHost: restAPIHost,
              cameraAPIHost: cameraAPIHost,
              protobufAPIHost: protobufAPIHost,
              userID: response.data.userid,
              transport_url: response.data.urls.transport_url,
              weather_url: response.data.urls.weather_url,
              timer: null,
              protobufRoot: null,
              token: this.config.nest.access_token,
              cameraAPI: {
                key: 'cookie',
                value: this.config.fieldTest === true ? 'website_ft=' : 'website_2=',
                token: nestToken,
              },
            };

            // Set timeout for token expiry refresh
            clearInterval(this.#connections['nest'].timer);
            this.#connections['nest'].timer = setTimeout(
              () => {
                this?.log?.info && this.log.info('Performing periodic token refresh for Nest account');
                this.#connect();
              },
              1000 * 3600 * 24,
            ); // Refresh token every 24hrs
          });
        })
        // eslint-disable-next-line no-unused-vars
        .catch((error) => {
          // The token we used to obtained a Nest session failed, so overall authorisation failed
          this?.log?.error && this.log.error('Authorisation failed using Nest account');
        });
    }
  }

  async #subscribeREST(connectionType, fullRefresh) {
    const REQUIREDBUCKETS = [
      'buckets',
      'structure',
      'where',
      'safety',
      'device',
      'shared',
      'track',
      'link',
      'rcs_settings',
      'schedule',
      'kryptonite',
      'topaz',
      'widget_track',
      'quartz',
    ];
    const DEVICEBUCKETS = {
      structure: ['latitude', 'longitude'],
      device: ['where_id'],
      kryptonite: ['where_id', 'structure_id'],
      topaz: ['where_id', 'structure_id'],
      quartz: ['where_id', 'structure_id', 'nexus_api_http_server_url'],
    };

    let restAPIURL = '';
    let restAPIJSONData = {};
    if (Object.keys(this.#rawData).length === 0 || (typeof fullRefresh === 'boolean' && fullRefresh === true)) {
      // Setup for a full data read from Nest REST API
      restAPIURL =
        'https://' +
        this.#connections[connectionType].restAPIHost +
        '/api/0.1/user/' +
        this.#connections[connectionType].userID +
        '/app_launch';
      restAPIJSONData = { known_bucket_types: REQUIREDBUCKETS, known_bucket_versions: [] };
    }
    if (Object.keys(this.#rawData).length !== 0 && typeof fullRefresh === 'boolean' && fullRefresh === false) {
      // Setup to subscribe to object changes we know about from Nest REST API
      restAPIURL = this.#connections[connectionType].transport_url + '/v6/subscribe';
      restAPIJSONData = { objects: [] };

      Object.entries(this.#rawData).forEach(([object_key]) => {
        if (
          typeof this.#rawData[object_key]?.object_revision === 'number' &&
          typeof this.#rawData[object_key]?.object_timestamp === 'number'
        ) {
          restAPIJSONData.objects.push({
            object_key: object_key,
            object_revision: this.#rawData[object_key].object_revision,
            object_timestamp: this.#rawData[object_key].object_timestamp,
          });
        }
      });
    }

    let request = {
      method: 'post',
      url: restAPIURL,
      responseType: 'json',
      headers: {
        'User-Agent': USERAGENT,
        Authorization: 'Basic ' + this.#connections[connectionType].token,
      },
      data: JSON.stringify(restAPIJSONData),
    };
    axios(request)
      .then(async (response) => {
        if (typeof response.status !== 'number' || response.status !== 200) {
          throw new Error('Nest REST API HTTP get data failed with error');
        }

        let data = {};
        let deviceChanges = []; // No REST API devices changes to start with
        if (typeof response.data?.updated_buckets === 'object') {
          // This response is full data read
          data = response.data.updated_buckets;
        }
        if (typeof response.data?.objects === 'object') {
          // This response contains subscribed data updates
          data = response.data.objects;
        }

        // Process the data we received
        fullRefresh = false; // Not a full data refresh required when we start again
        await Promise.all(
          data.map(async (value) => {
            if (value.object_key.startsWith('structure.') === true) {
              // Since we have a structure key, need to add in weather data for the location using latitude and longitude details
              if (typeof value.value?.weather !== 'object') {
                value.value.weather = {};
              }
              if (
                typeof this.#rawData[value.object_key] === 'object' &&
                typeof this.#rawData[value.object_key].value?.weather === 'object'
              ) {
                value.value.weather = this.#rawData[value.object_key].value.weather;
              }
              value.value.weather = await this.#getWeatherData(
                connectionType,
                value.object_key,
                value.value.latitude,
                value.value.longitude,
              );

              // Check for changes in the swarm property. This seems indicate changes in devices
              if (typeof this.#rawData[value.object_key] === 'object') {
                this.#rawData[value.object_key].value.swarm.map((object_key) => {
                  if (value.value.swarm.includes(object_key) === false) {
                    // Object is present in the old swarm list, but not in the new swarm list, so we assume it has been removed
                    // We'll remove the associated object here for future subscribe
                    delete this.#rawData[object_key];
                  }
                });
              }
            }

            if (value.object_key.startsWith('quartz.') === true) {
              // We have camera(s) and/or doorbell(s), so get extra details that are required
              value.value.properties =
                typeof this.#rawData[value.object_key]?.value?.properties === 'object'
                  ? this.#rawData[value.object_key].value.properties
                  : [];

              let request = {
                method: 'get',
                url:
                  'https://webapi.' +
                  this.#connections[connectionType].cameraAPIHost +
                  '/api/cameras.get_with_properties?uuid=' +
                  value.object_key.split('.')[1],
                headers: {
                  referer: 'https://' + this.#connections[connectionType].referer,
                  'User-Agent': USERAGENT,
                  [this.#connections[connectionType].cameraAPI.key]:
                    this.#connections[connectionType].cameraAPI.value + this.#connections[connectionType].cameraAPI.token,
                },
                responseType: 'json',
                timeout: NESTAPITIMEOUT,
              };
              await axios(request)
                .then((response) => {
                  if (typeof response.status !== 'number' || response.status !== 200) {
                    throw new Error('Nest Camera API HTTP get failed with error');
                  }

                  value.value.properties = response.data.items[0].properties;
                })
                .catch(() => {
                  this?.log?.debug && this.log.debug('Error retrieving camera/doorbell additional device properties');
                });

              value.value.activity_zones =
                typeof this.#rawData[value.object_key]?.value?.activity_zones === 'object'
                  ? this.#rawData[value.object_key].value.activity_zones
                  : [];

              request = {
                method: 'get',
                url: value.value.nexus_api_http_server_url + '/cuepoint_category/' + value.object_key.split('.')[1],
                headers: {
                  referer: 'https://' + this.#connections[connectionType].referer,
                  'User-Agent': USERAGENT,
                  [this.#connections[connectionType].cameraAPI.key]:
                    this.#connections[connectionType].cameraAPI.value + this.#connections[connectionType].cameraAPI.token,
                },
                responseType: 'json',
                timeout: NESTAPITIMEOUT,
              };
              await axios(request)
                .then((response) => {
                  if (typeof response.status !== 'number' || response.status !== 200) {
                    throw new Error('Nest Camera Zones API HTTP get failed with error');
                  }

                  let zones = [];
                  response.data.forEach((zone) => {
                    if (zone.type.toUpperCase() === 'ACTIVITY' || zone.type.toUpperCase() === 'REGION') {
                      zones.push({
                        id: zone.id === 0 ? 1 : zone.id,
                        name: makeHomeKitName(zone.label),
                        hidden: zone.hidden === true,
                        uri: zone.nexusapi_image_uri,
                      });
                    }
                  });

                  value.value.activity_zones = zones;
                })
                .catch(() => {
                  this?.log?.debug && this?.log?.debug && this.log.debug('Error retrieving camera/doorbell activity zones');
                });
            }

            if (value.object_key.startsWith('buckets.') === true) {
              if (
                typeof this.#rawData[value.object_key] === 'object' &&
                typeof this.#rawData[value.object_key].value?.buckets === 'object'
              ) {
                // Check for added objects
                value.value.buckets.map((object_key) => {
                  if (this.#rawData[value.object_key].value.buckets.includes(object_key) === false) {
                    // Since this is an added object to the raw Nest REST API structure, we need to do a full read of the data
                    fullRefresh = true;
                  }
                });

                // Check for removed objects
                this.#rawData[value.object_key].value.buckets.map((object_key) => {
                  if (value.value.buckets.includes(object_key) === false) {
                    // Object is present in the old buckets list, but not in the new buckets list
                    // so we assume it has been removed
                    // It also could mean device(s) have been removed from Nest
                    if (Object.keys(DEVICEBUCKETS).includes(object_key.split('.')[0]) === true) {
                      deviceChanges.push({ object_key: object_key, change: 'remove' });
                    }
                    delete this.#rawData[object_key];
                  }
                });
              }
            }

            // Store or update the date in our internally saved raw Nest REST API data
            if (typeof this.#rawData[value.object_key] === 'undefined') {
              this.#rawData[value.object_key] = {};
              this.#rawData[value.object_key].object_revision = value.object_revision;
              this.#rawData[value.object_key].object_timestamp = value.object_timestamp;
              this.#rawData[value.object_key].source = NestAccfactory.DataSource.REST;
              this.#rawData[value.object_key].timers = {}; // No timers running for this object
              this.#rawData[value.object_key].value = {};
            }

            // Need to check for a possible device addition to the raw Nest REST API data.
            // We expect the devices we want to add, have certain minimum properties present in the data
            // We'll perform that check here
            if (
              Object.keys(DEVICEBUCKETS).includes(value.object_key.split('.')[0]) === true &&
              DEVICEBUCKETS[value.object_key.split('.')[0]].every((key) => key in value.value) === true &&
              DEVICEBUCKETS[value.object_key.split('.')[0]].every((key) => key in this.#rawData[value.object_key].value) === false
            ) {
              deviceChanges.push({ object_key: value.object_key, change: 'add' });
            }

            // Finally, update our internal raw Nest REST API data with the new values
            this.#rawData[value.object_key].object_revision = value.object_revision; // Used for future subscribes
            this.#rawData[value.object_key].object_timestamp = value.object_timestamp; // Used for future subscribes
            for (const [fieldKey, fieldValue] of Object.entries(value.value)) {
              this.#rawData[value.object_key]['value'][fieldKey] = fieldValue;
            }
          }),
        );

        await this.#processPostSubscribe(connectionType, deviceChanges);
      })
      .catch((error) => {
        if (error?.code !== 'ECONNRESET') {
          this?.log?.error && this.log.error('REST API subscribe failed. Will retry');
        }
      })
      .finally(() => {
        setTimeout(this.#subscribeREST.bind(this, connectionType, fullRefresh), 1000);
      });
  }

  async #subscribeProtobuf(connectionType) {
    const calculate_message_size = (inputBuffer) => {
      // First byte in the is a tag type??
      // Following is a varint type
      // After varint size, is the buffer content
      let varint = 0;
      let bufferPos = 0;
      let currentByte;

      for (;;) {
        currentByte = inputBuffer[bufferPos + 1]; // Offset in buffer + 1 to skip over starting tag
        varint |= (currentByte & 0x7f) << (bufferPos * 7);
        bufferPos += 1;
        if (bufferPos > 5) {
          throw new Error('VarInt exceeds allowed bounds.');
        }
        if ((currentByte & 0x80) !== 0x80) {
          break;
        }
      }

      // Return length of message in buffer
      return varint + bufferPos + 1;
    };

    const traverseTypes = (currentTrait, callback) => {
      if (currentTrait instanceof protobuf.Type) {
        callback(currentTrait);
      }
      if (currentTrait.nestedArray) {
        currentTrait.nestedArray.map((trait) => {
          traverseTypes(trait, callback);
        });
      }
    };

    let observeTraits = null;
    if (fs.existsSync(path.resolve(__dirname + '/protobuf/root.proto')) === true) {
      protobuf.util.Long = null;
      protobuf.configure();
      this.#connections[connectionType].protobufRoot = protobuf.loadSync(path.resolve(__dirname + '/protobuf/root.proto'));
      if (this.#connections[connectionType].protobufRoot !== null) {
        // Loaded in the protobuf files, so now dynamically build the 'observe' post body data based on what we have loaded
        let observeTraitsList = [];
        let traitTypeObserveParam = this.#connections[connectionType].protobufRoot.lookup('nestlabs.gateway.v2.TraitTypeObserveParams');
        let observeRequest = this.#connections[connectionType].protobufRoot.lookup('nestlabs.gateway.v2.ObserveRequest');
        if (traitTypeObserveParam !== null && observeRequest !== null) {
          traverseTypes(this.#connections[connectionType].protobufRoot, (type) => {
            // We only want to have certain trait main 'families' in our observe reponse we are building
            // This also depends on the account type we connected with. Nest accounts cannot observe camera/doorbell product traits
            if (
              (connectionType === NestAccfactory.NestConnection &&
                type.fullName.startsWith('.nest.trait.product.camera') === false &&
                type.fullName.startsWith('.nest.trait.product.doorbell') === false &&
                (type.fullName.startsWith('.nest.trait') === true || type.fullName.startsWith('.weave.') === true)) ||
              (connectionType === NestAccfactory.GoogleConnection &&
                (type.fullName.startsWith('.nest.trait') === true ||
                  type.fullName.startsWith('.weave.') === true ||
                  type.fullName.startsWith('.google.trait.product.camera') === true))
            ) {
              observeTraitsList.push(traitTypeObserveParam.create({ traitType: type.fullName.replace(/^\.*|\.*$/g, '') }));
            }
          });
          observeTraits = observeRequest.encode(observeRequest.create({ stateTypes: [1, 2], traitTypeParams: observeTraitsList })).finish();
        }
      }
    }

    let request = {
      method: 'post',
      url: 'https://' + this.#connections[connectionType].protobufAPIHost + '/nestlabs.gateway.v2.GatewayService/Observe',
      headers: {
        'User-Agent': USERAGENT,
        Authorization: 'Basic ' + this.#connections[connectionType].token,
        'Content-Type': 'application/x-protobuf',
        'X-Accept-Content-Transfer-Encoding': 'binary',
        'X-Accept-Response-Streaming': 'true',
      },
      responseType: 'stream',
      data: observeTraits,
    };
    axios(request)
      .then(async (response) => {
        if (typeof response.status !== 'number' || response.status !== 200) {
          throw new Error('Nest protobuf API HTTP get data failed with error');
        }

        let deviceChanges = []; // No protobuf API devices changes to start with
        let buffer = Buffer.alloc(0);
        for await (const chunk of response.data) {
          buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
          let messageSize = calculate_message_size(buffer);
          if (buffer.length >= messageSize) {
            let decodedMessage = {};
            try {
              // Attempt to decode the protobuf message(s) we extracted from the stream and get a JSON object representation
              decodedMessage = this.#connections[connectionType].protobufRoot
                .lookup('nest.rpc.StreamBody')
                .decode(buffer.subarray(0, messageSize))
                .toJSON();
              if (typeof decodedMessage?.message !== 'object') {
                decodedMessage.message = [];
              }
              if (typeof decodedMessage?.message[0]?.get !== 'object') {
                decodedMessage.message[0].get = [];
              }
              if (typeof decodedMessage?.message[0]?.resourceMetas !== 'object') {
                decodedMessage.message[0].resourceMetas = [];
              }

              // Tidy up our received messages. This ensures we only have one status for the trait in the data we process
              // We'll favour a trait with accepted status over the same with confirmed status
              let notAcceptedStatus = decodedMessage.message[0].get.filter((trait) => trait.stateTypes.includes('ACCEPTED') === false);
              let acceptedStatus = decodedMessage.message[0].get.filter((trait) => trait.stateTypes.includes('ACCEPTED') === true);
              let difference = acceptedStatus.map((trait) => trait.traitId.resourceId + '/' + trait.traitId.traitLabel);
              decodedMessage.message[0].get =
                ((notAcceptedStatus = notAcceptedStatus.filter(
                  (trait) => difference.includes(trait.traitId.resourceId + '/' + trait.traitId.traitLabel) === false,
                )),
                [...notAcceptedStatus, ...acceptedStatus]);

              // We'll use the resource status message to look for structure and/or device removals
              // We could also check for structure and/or device additions here, but we'll want to be flagged
              // that a device is 'ready' for use before we add in. This data is populated in the trait data
              decodedMessage.message[0].resourceMetas.map(async (resource) => {
                if (
                  resource.status === 'REMOVED' &&
                  (resource.resourceId.startsWith('STRUCTURE_') || resource.resourceId.startsWith('DEVICE_'))
                ) {
                  // We have the removal of a 'home' and/ device
                  deviceChanges.push({ object_key: resource.resourceId, change: 'removed' });
                }
              });
              // eslint-disable-next-line no-unused-vars
            } catch (error) {
              // Empty
            }
            buffer = buffer.subarray(messageSize); // Remove the message from the beginning of the buffer

            if (typeof decodedMessage?.message[0]?.get === 'object') {
              await Promise.all(
                decodedMessage.message[0].get.map(async (trait) => {
                  if (trait.traitId.traitLabel === 'configuration_done') {
                    if (
                      (typeof this.#rawData[trait.traitId.resourceId]?.value?.configuration_done?.deviceReady === 'undefined' &&
                        trait.patch.values?.deviceReady === true) ||
                      (typeof this.#rawData[trait.traitId.resourceId]?.value?.configuration_done?.deviceReady === 'boolean' &&
                        this.#rawData[trait.traitId.resourceId]?.value?.configuration_done?.deviceReady === false &&
                        trait.patch.values?.deviceReady === true)
                    ) {
                      deviceChanges.push({ object_key: trait.traitId.resourceId, change: 'add' });
                    }
                  }

                  if (typeof this.#rawData[trait.traitId.resourceId] === 'undefined') {
                    this.#rawData[trait.traitId.resourceId] = {};
                    this.#rawData[trait.traitId.resourceId].source = NestAccfactory.DataSource.PROTOBUF;
                    this.#rawData[trait.traitId.resourceId].timers = {}; // No timers running for this object
                    this.#rawData[trait.traitId.resourceId].value = {};
                  }
                  this.#rawData[trait.traitId.resourceId]['value'][trait.traitId.traitLabel] =
                    typeof trait.patch.values !== 'undefined' ? trait.patch.values : {};

                  // We don't need to store the trait type, so remove it
                  delete this.#rawData[trait.traitId.resourceId]['value'][trait.traitId.traitLabel]['@type'];

                  // If we have structure location details and associated geo-location details, get the weather data for the location
                  // We'll store this in the object key/value as per REST API
                  if (
                    trait.traitId.resourceId.startsWith('STRUCTURE_') === true &&
                    trait.traitId.traitLabel === 'structure_location' &&
                    typeof trait.patch.values?.geoCoordinate?.latitude === 'number' &&
                    typeof trait.patch.values?.geoCoordinate?.longitude === 'number'
                  ) {
                    this.#rawData[trait.traitId.resourceId].value.weather = await this.#getWeatherData(
                      connectionType,
                      trait.traitId.resourceId,
                      trait.patch.values.geoCoordinate.latitude,
                      trait.patch.values.geoCoordinate.longitude,
                    );
                  }
                }),
              );

              await this.#processPostSubscribe(connectionType, deviceChanges);
              deviceChanges = []; // No more device changes now
            }
          }
        }
      })
      .catch((error) => {
        if (error?.code !== 'ECONNRESET') {
          this?.log?.error && this.log.error('Protobuf observe error occured. Will retry');
        }
      })
      .finally(() => {
        setTimeout(this.#subscribeProtobuf.bind(this, connectionType), 1000);
      });
  }

  async #processPostSubscribe(connectionType, deviceChanges) {
    // Process any device removals we have
    Object.values(deviceChanges)
      .filter((object) => object.change === 'remove')
      .forEach((object) => {
        if (typeof this.#rawData[object.object_key] === 'object') {
          // Remove any timers that might have been associated with this device
          Object.values(this.#rawData[object.object_key].timers).forEach((timerObject) => {
            clearInterval(timerObject);
          });

          // Clean up structure
          delete this.#rawData[object.object_key];
        }

        // Send removed notice onto HomeKit device for it to process
        // This allows handling removal of a device without knowing its previous data
        this.#eventEmitter.emit(object.object_key, HomeKitDevice.REMOVE, {});
      });

    Object.values(this.#processData(connectionType, '')).forEach((deviceData) => {
      // Process any device additions we have
      Object.values(deviceChanges)
        .filter((object) => object.change === 'add')
        .forEach((object) => {
          if (object.object_key === deviceData.uuid && deviceData.excluded === false) {
            // Device isn't marked as excluded, so create the required HomeKit accessories based upon the device data
            if (deviceData.device_type === NestAccfactory.DeviceType.THERMOSTAT && typeof NestThermostat === 'function') {
              // Nest Thermostat(s) - Categories.THERMOSTAT = 9
              let tempDevice = new NestThermostat(this.cachedAccessories, this.api, this.log, this.#eventEmitter, deviceData);
              tempDevice.add('Nest Thermostat', 9, true);
            }

            if (deviceData.device_type === NestAccfactory.DeviceType.TEMPSENSOR && typeof NestTemperatureSensor === 'function') {
              // Nest Temperature Sensor - Categories.SENSOR = 10
              let tempDevice = new NestTemperatureSensor(this.cachedAccessories, this.api, this.log, this.#eventEmitter, deviceData);
              tempDevice.add('Nest Temperature Sensor', 10, true);
            }

            if (deviceData.device_type === NestAccfactory.DeviceType.SMOKESENSOR && typeof NestProtect === 'function') {
              // Nest Protect(s) - Categories.SENSOR = 10
              let tempDevice = new NestProtect(this.cachedAccessories, this.api, this.log, this.#eventEmitter, deviceData);
              tempDevice.add('Nest Protect', 10, true);
            }

            if (
              (deviceData.device_type === NestAccfactory.DeviceType.CAMERA ||
                deviceData.device_type === NestAccfactory.DeviceType.DOORBELL) &&
              (typeof NestCamera === 'function' || typeof NestDoorbell === 'function')
            ) {
              let accessoryName = 'Nest ' + deviceData.model.replace(/\s*(?:\([^()]*\))/gi, '');
              if (deviceData.device_type === NestAccfactory.DeviceType.CAMERA) {
                // Nest Camera(s) - Categories.IP_CAMERA = 17
                let tempDevice = new NestCamera(this.cachedAccessories, this.api, this.log, this.#eventEmitter, deviceData);
                tempDevice.add(accessoryName, 17, true);
              }
              if (deviceData.device_type === NestAccfactory.DeviceType.DOORBELL) {
                // Nest Doorbell(s) - Categories.VIDEO_DOORBELL = 18
                let tempDevice = new NestDoorbell(this.cachedAccessories, this.api, this.log, this.#eventEmitter, deviceData);
                tempDevice.add(accessoryName, 18, true);
              }

              // Setup polling loop for camera/doorbell zone data if not already created.
              // This is only required for Nest REST API data sources as these details are present in protobuf API
              if (
                typeof this.#rawData[object.object_key]?.timers?.zones === 'undefined' &&
                this.#rawData[object.object_key].source === NestAccfactory.DataSource.REST
              ) {
                this.#rawData[object.object_key].timers.zones = setInterval(async () => {
                  if (typeof this.#rawData[object.object_key]?.value === 'object') {
                    let request = {
                      method: 'get',
                      url:
                        this.#rawData[object.object_key].value.nexus_api_http_server_url +
                        '/cuepoint_category/' +
                        object.object_key.split('.')[1],
                      headers: {
                        referer: 'https://' + this.#connections[connectionType].referer,
                        'User-Agent': USERAGENT,
                        [this.#connections[connectionType].cameraAPI.key]:
                          this.#connections[connectionType].cameraAPI.value + this.#connections[connectionType].cameraAPI.token,
                      },
                      responseType: 'json',
                      timeout: CAMERAZONEPOLLING,
                    };
                    await axios(request)
                      .then((response) => {
                        if (typeof response.status !== 'number' || response.status !== 200) {
                          throw new Error('Nest Camera Zones API HTTP get failed with error');
                        }

                        let zones = [];
                        response.data.forEach((zone) => {
                          if (zone.type.toUpperCase() === 'ACTIVITY' || zone.type.toUpperCase() === 'REGION') {
                            zones.push({
                              id: zone.id === 0 ? 1 : zone.id,
                              name: makeHomeKitName(zone.label),
                              hidden: zone.hidden === true,
                              uri: zone.nexusapi_image_uri,
                            });
                          }
                        });

                        this.#rawData[object.object_key].value.activity_zones = zones;

                        // Send updated data onto HomeKit device for it to process
                        this.#eventEmitter.emit(object.object_key, HomeKitDevice.UPDATE, {
                          activity_zones: this.#rawData[object.object_key].value.activity_zones,
                        });
                      })
                      .catch(() => {
                        this?.log?.debug && this.log.debug('Error retrieving camera/doorbell activity zones');
                      });
                  }
                }, CAMERAZONEPOLLING);
              }

              // Setup polling loop for camera/doorbell alert data if not already created
              if (typeof this.#rawData[object.object_key]?.timers?.alerts === 'undefined') {
                this.#rawData[object.object_key].timers.alerts = setInterval(async () => {
                  if (
                    typeof this.#rawData[object.object_key]?.value === 'object' &&
                    this.#rawData[object.object_key]?.source === NestAccfactory.DataSource.PROTOBUF
                  ) {
                    let protobufElement = {
                      resourceRequest: {
                        resourceId: object.object_key,
                        requestId: crypto.randomUUID(),
                      },
                      resourceCommands: [
                        {
                          traitLabel: 'camera_observation_history',
                          command: {
                            type_url: 'type.nestlabs.com/nest.trait.history.CameraObservationHistoryTrait.CameraObservationHistoryRequest',
                            value: {
                              // We want camera history from now for upto 30secs from now
                              queryStartTime: { seconds: Math.floor(Date.now() / 1000), nanos: (Math.round(Date.now()) % 1000) * 1e6 },
                              queryEndTime: {
                                seconds: Math.floor((Date.now() + 30000) / 1000),
                                nanos: (Math.round(Date.now() + 30000) % 1000) * 1e6,
                              },
                            },
                          },
                        },
                      ],
                    };

                    let alerts = []; // No alerts yet
                    let trait = this.#connections[connectionType].protobufRoot.lookup(
                      'nest.trait.history.CameraObservationHistoryTrait.CameraObservationHistoryRequest',
                    );
                    protobufElement.resourceCommands[0].command.value = trait
                      .encode(trait.fromObject(protobufElement.resourceCommands[0].command.value))
                      .finish();
                    let TraitMap = this.#connections[connectionType].protobufRoot.lookup('nestlabs.gateway.v1.ResourceCommandRequest');
                    let encodedData = TraitMap.encode(TraitMap.fromObject(protobufElement)).finish();

                    let request = {
                      method: 'post',
                      url: 'https://' + this.#connections[connectionType].protobufAPIHost + '/nestlabs.gateway.v1.ResourceApi/SendCommand',
                      headers: {
                        'User-Agent': USERAGENT,
                        Authorization: 'Basic ' + this.#connections[connectionType].token,
                        'Content-Type': 'application/x-protobuf',
                        'X-Accept-Content-Transfer-Encoding': 'binary',
                        'X-Accept-Response-Streaming': 'true',
                      },
                      responseType: 'arraybuffer',
                      data: encodedData,
                    };
                    await axios(request)
                      .then((response) => {
                        if (typeof response.status !== 'number' || response.status !== 200) {
                          throw new Error('Nest protobuf API HTTP get data failed with error');
                        }

                        let decodedData = this.#connections[connectionType].protobufRoot
                          .lookupType('nestlabs.gateway.v1.ResourceCommandResponseFromAPI')
                          .decode(response.data)
                          .toJSON();
                        if (
                          typeof decodedData?.resourceCommandResponse[0]?.traitOperations[0]?.event?.event?.cameraEventWindow
                            ?.cameraEvent === 'object'
                        ) {
                          decodedData.resourceCommandResponse[0].traitOperations[0].event.event.cameraEventWindow.cameraEvent.forEach(
                            (event) => {
                              alerts.push({
                                playback_time: parseInt(event.startTime.seconds) * 1000 + parseInt(event.startTime.nanos) / 1000000,
                                start_time: parseInt(event.startTime.seconds) * 1000 + parseInt(event.startTime.nanos) / 1000000,
                                end_time: parseInt(event.endTime.seconds) * 1000 + parseInt(event.endTime.nanos) / 1000000,
                                id: event.eventId,
                                zone_ids:
                                  typeof event.activityZone === 'object'
                                    ? event.activityZone.map((zone) =>
                                        typeof zone?.zoneIndex === 'number' ? zone.zoneIndex : zone.internalIndex,
                                      )
                                    : [],
                                types: event.eventType
                                  .map((event) => (event.startsWith('EVENT_') === true ? event.split('EVENT_')[1].toLowerCase() : ''))
                                  .filter((event) => event),
                              });

                              // Fix up even types to match REST API
                              // <---- TODO (as the ones we use match from protobuf)
                            },
                          );

                          // Sort alerts to be most recent first
                          alerts = alerts.sort((a, b) => {
                            if (a.start_time > b.start_time) {
                              return -1;
                            }
                          });
                        }
                      })
                      .catch(() => {
                        this?.log?.debug && this.log.debug('Error retrieving camera/doorbell activity notifications');
                      });

                    this.#rawData[object.object_key].value.alerts = alerts;

                    // Send updated data onto HomeKit device for it to process
                    this.#eventEmitter.emit(object.object_key, HomeKitDevice.UPDATE, {
                      alerts: this.#rawData[object.object_key].value.alerts,
                    });
                  }

                  if (
                    typeof this.#rawData[object.object_key]?.value === 'object' &&
                    this.#rawData[object.object_key]?.source === NestAccfactory.DataSource.REST
                  ) {
                    let alerts = []; // No alerts yet
                    let request = {
                      method: 'get',
                      url:
                        this.#rawData[object.object_key].value.nexus_api_http_server_url +
                        '/cuepoint/' +
                        object.object_key.split('.')[1] +
                        '/2?start_time=' +
                        Math.floor(Date.now() / 1000 - 30),
                      headers: {
                        referer: 'https://' + this.#connections[connectionType].referer,
                        'User-Agent': USERAGENT,
                        [this.#connections[connectionType].cameraAPI.key]:
                          this.#connections[connectionType].cameraAPI.value + this.#connections[connectionType].cameraAPI.token,
                      },
                      responseType: 'json',
                      timeout: CAMERAALERTPOLLING,
                    };
                    await axios(request)
                      .then((response) => {
                        if (typeof response.status !== 'number' || response.status !== 200) {
                          throw new Error('Nest Camera Alert API HTTP get failed with error');
                        }

                        response.data.forEach((alert) => {
                          // Fix up alert zone IDs. If there is an ID of 0, we'll transform to 1. ie: main zone
                          // If there are NO zone IDs, we'll put a 1 in there ie: main zone
                          alert.zone_ids = alert.zone_ids.map((id) => (id !== 0 ? id : 1));
                          if (alert.zone_ids.length === 0) {
                            alert.zone_ids.push(1);
                          }
                          alerts.push({
                            playback_time: alert.playback_time,
                            start_time: alert.start_time,
                            end_time: alert.end_time,
                            id: alert.id,
                            zone_ids: alert.zone_ids,
                            types: alert.types,
                          });
                        });

                        // Sort alerts to be most recent first
                        alerts = alerts.sort((a, b) => {
                          if (a.start_time > b.start_time) {
                            return -1;
                          }
                        });
                      })
                      .catch(() => {
                        this?.log?.debug && this.log.debug('Error retrieving camera/doorbell activity notifications');
                      });

                    this.#rawData[object.object_key].value.alerts = alerts;

                    // Send updated data onto HomeKit device for it to process
                    this.#eventEmitter.emit(object.object_key, HomeKitDevice.UPDATE, {
                      alerts: this.#rawData[object.object_key].value.alerts,
                    });
                  }
                }, CAMERAALERTPOLLING);
              }
            }

            if (deviceData.device_type === NestAccfactory.DeviceType.WEATHER && typeof NestWeather === 'function') {
              // Nest 'Virtual' weather station - Categories.SENSOR = 10
              let tempDevice = new NestWeather(this.cachedAccessories, this.api, this.log, this.#eventEmitter, deviceData);
              tempDevice.add('Nest Weather', 10, true);

              // Setup polling loop for weather data if not already created
              if (typeof this.#rawData[object.object_key]?.timers?.weather === 'undefined') {
                this.#rawData[object.object_key].timers.weather = setInterval(async () => {
                  this.#rawData[object.object_key].value.weather = await this.#getWeatherData(
                    connectionType,
                    object.object_key,
                    this.#rawData[object.object_key].value.weather.latitude,
                    this.#rawData[object.object_key].value.weather.longitude,
                  );

                  // Send updated data onto HomeKit device for it to process
                  this.#eventEmitter.emit(
                    object.object_key,
                    HomeKitDevice.UPDATE,
                    this.#processData(connectionType, object.object_key)[deviceData.serial_number],
                  );
                }, WEATHERPOLLING);
              }
            }
          }
        });

      // Finally, after processing device additions, if device is not excluded, send updated data to device for it to process
      if (deviceData.excluded === false) {
        this.#eventEmitter.emit(deviceData.uuid, HomeKitDevice.UPDATE, deviceData);
      }
    });
  }

  #processData(connectionType, deviceUUID) {
    if (typeof deviceUUID !== 'string') {
      deviceUUID = '';
    }
    let devices = {};

    // Get the device(s) location from stucture
    // We'll test in both REST and protobuf API data
    const get_location_name = (structure_id, where_id) => {
      let location = '';

      // Check REST data
      if (typeof this.#rawData['where.' + structure_id]?.value === 'object') {
        this.#rawData['where.' + structure_id].value.wheres.forEach((value) => {
          if (where_id === value.where_id) {
            location = value.name;
          }
        });
      }

      // Check protobuf data
      if (typeof this.#rawData[structure_id]?.value?.located_annotations?.predefinedWheres === 'object') {
        Object.values(this.#rawData[structure_id].value.located_annotations.predefinedWheres).forEach((value) => {
          if (value.whereId.resourceId === where_id) {
            location = value.label.literal;
          }
        });
      }
      if (typeof this.#rawData[structure_id]?.value?.located_annotations?.customWheres === 'object') {
        Object.values(this.#rawData[structure_id].value.located_annotations.customWheres).forEach((value) => {
          if (value.whereId.resourceId === where_id) {
            location = value.label.literal;
          }
        });
      }

      return location;
    };

    // Process data for any thermostat(s) we have in the raw data
    const process_thermostat_data = (object_key, data) => {
      let processed = {};
      try {
        // Fix up data we need to
        data.serial_number = data.serial_number.toUpperCase(); // ensure serial numbers are in upper case
        data.excluded =
          typeof this.config?.devices?.[data.serial_number]?.exclude === 'boolean'
            ? this.config.devices[data.serial_number].exclude
            : false; // Mark device as excluded or not
        data.device_type = NestAccfactory.DeviceType.THERMOSTAT; // Nest Thermostat
        data.uuid = object_key; // Internal structure ID
        data.manufacturer = typeof data?.manufacturer === 'string' ? data.manufacturer : 'Nest';
        data.software_version = typeof data?.software_version === 'string' ? data.software_version.replace(/-/g, '.') : '0.0.0';
        data.target_temperature_high = adjustTemperature(data.target_temperature_high, 'C', 'C', true);
        data.target_temperature_low = adjustTemperature(data.target_temperature_low, 'C', 'C', true);
        data.target_temperature = adjustTemperature(data.target_temperature, 'C', 'C', true);
        data.backplate_temperature = adjustTemperature(data.backplate_temperature, 'C', 'C', true);
        data.current_temperature = adjustTemperature(data.current_temperature, 'C', 'C', true);
        data.battery_level = scaleValue(data.battery_level, 3.6, 3.9, 0, 100);
        let description = typeof data?.description === 'string' ? data.description : '';
        let location = typeof data?.location === 'string' ? data.location : '';
        if (description === '') {
          description = location;
          location = '';
        }
        data.description = makeHomeKitName(location === '' ? description : description + ' - ' + location);
        delete data.location;

        // Insert details for when using HAP-NodeJS library rather than Homebridge
        if (typeof this.config?.options?.hkPairingCode === 'string' && this.config.options.hkPairingCode !== '') {
          data.hkPairingCode = this.config.options.hkPairingCode;
        }
        if (
          typeof this.config?.devices?.[data.serial_number]?.hkPairingCode === 'string' &&
          this.config.devices[data.serial_number].hkPairingCode !== ''
        ) {
          data.hkPairingCode = this.config.devices[data.serial_number].hkPairingCode;
        }
        if (data?.hkPairingCode !== undefined && data?.mac_address !== undefined) {
          // Create mac_address in format of xx:xx:xx:xx:xx:xx
          data.hkUsername = data.mac_address
            .toString('hex')
            .split(/(..)/)
            .filter((s) => s)
            .join(':')
            .toUpperCase();
          delete data.mac_address;
        }

        processed = data;
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        // Empty
      }
      return processed;
    };

    const PROTOBUF_THERMOSTAT_RESOURCES = [
      'nest.resource.NestLearningThermostat3Resource',
      'nest.resource.NestAgateDisplayResource',
      'nest.resource.NestOnyxResource',
      'google.resource.GoogleZirconium1Resource',
      'google.resource.GoogleBismuth1Resource',
    ];
    Object.entries(this.#rawData)
      .filter(
        ([key, value]) =>
          (key.startsWith('device.') === true ||
            (key.startsWith('DEVICE_') === true && PROTOBUF_THERMOSTAT_RESOURCES.includes(value.value?.device_info?.typeName) === true)) &&
          (deviceUUID === '' || deviceUUID === key),
      )
      .forEach(([object_key, value]) => {
        let tempDevice = {};
        try {
          if (value.source === NestAccfactory.DataSource.PROTOBUF) {
            let RESTTypeData = {};
            RESTTypeData.mac_address = Buffer.from(value.value.wifi_interface.macAddress, 'base64');
            RESTTypeData.serial_number = value.value.device_identity.serialNumber;
            RESTTypeData.software_version = value.value.device_identity.softwareVersion;
            RESTTypeData.model = 'Thermostat';
            if (value.value.device_info.typeName === 'nest.resource.NestLearningThermostat3Resource') {
              RESTTypeData.model = 'Learning Thermostat (3rd Gen)';
            }
            if (value.value.device_info.typeName === 'google.resource.GoogleBismuth1Resource') {
              RESTTypeData.model = 'Learning Thermostat (4th Gen)';
            }
            if (value.value.device_info.typeName === 'nest.resource.NestAgateDisplayResource') {
              RESTTypeData.model = 'Thermostat E';
            }
            if (value.value.device_info.typeName === 'nest.resource.NestOnyxResource') {
              RESTTypeData.model = 'Thermostat E (1st Gen)';
            }
            if (value.value.device_info.typeName === 'google.resource.GoogleZirconium1Resource') {
              RESTTypeData.model = 'Thermostat (2020 Model)';
            }
            RESTTypeData.current_humidity =
              typeof value.value.current_humidity.humidityValue.humidity.value === 'number'
                ? value.value.current_humidity.humidityValue.humidity.value
                : 0.0;
            RESTTypeData.temperature_scale = value.value.display_settings.temperatureScale === 'TEMPERATURE_SCALE_F' ? 'F' : 'C';
            RESTTypeData.removed_from_base = value.value.display.thermostatState.includes('bpd') === true;
            RESTTypeData.backplate_temperature = parseFloat(value.value.backplate_temperature.temperatureValue.temperature.value);
            RESTTypeData.current_temperature = parseFloat(value.value.current_temperature.temperatureValue.temperature.value);
            RESTTypeData.battery_level = parseFloat(value.value.battery_voltage.batteryValue.batteryVoltage.value);
            RESTTypeData.online = value.value?.liveness?.status === 'LIVENESS_DEVICE_STATUS_ONLINE';
            RESTTypeData.leaf = value.value?.leaf?.active === true;
            RESTTypeData.has_humidifier = value.value.hvac_equipment_capabilities.hasHumidifier === true;
            RESTTypeData.has_dehumidifier = value.value.hvac_equipment_capabilities.hasDehumidifier === true;
            RESTTypeData.has_fan =
              typeof value.value.fan_control_capabilities.maxAvailableSpeed === 'string' &&
              value.value.fan_control_capabilities.maxAvailableSpeed !== 'FAN_SPEED_SETTING_OFF'
                ? true
                : false;
            RESTTypeData.can_cool =
              value.value.hvac_equipment_capabilities.hasStage1Cool === true ||
              value.value.hvac_equipment_capabilities.hasStage2Cool === true ||
              value.value.hvac_equipment_capabilities.hasStage3Cool === true;
            RESTTypeData.can_heat =
              value.value.hvac_equipment_capabilities.hasStage1Heat === true ||
              value.value.hvac_equipment_capabilities.hasStage2Heat === true ||
              value.value.hvac_equipment_capabilities.hasStage3Heat === true;
            RESTTypeData.temperature_lock = value.value.temperature_lock_settings.enabled === true;
            RESTTypeData.temperature_lock_pin_hash =
              typeof value.value.temperature_lock_settings.pinHash === 'string' && value.value.temperature_lock_settings.enabled === true
                ? value.value.temperature_lock_settings.pinHash
                : '';
            RESTTypeData.away = value.value.structure_mode.structureMode === 'STRUCTURE_MODE_AWAY';
            RESTTypeData.occupancy = value.value.structure_mode.structureMode === 'STRUCTURE_MODE_HOME';
            //RESTTypeData.occupancy = (value.value.structure_mode.occupancy.activity === 'ACTIVITY_ACTIVE');
            RESTTypeData.vacation_mode = value.value.structure_mode.structureMode === 'STRUCTURE_MODE_VACATION';
            RESTTypeData.description = typeof value.value.label?.label === 'string' ? value.value.label.label : '';
            RESTTypeData.location = get_location_name(
              value.value.device_info.pairerId.resourceId,
              value.value.device_located_settings.whereAnnotationRid.resourceId,
            );

            // Work out current mode. ie: off, cool, heat, range and get temperature low/high and target
            RESTTypeData.hvac_mode =
              value.value.target_temperature_settings.enabled.value === true
                ? value.value.target_temperature_settings.targetTemperature.setpointType.split('SET_POINT_TYPE_')[1].toLowerCase()
                : 'off';
            RESTTypeData.target_temperature_low =
              typeof value.value.target_temperature_settings.targetTemperature.heatingTarget.value === 'number'
                ? value.value.target_temperature_settings.targetTemperature.heatingTarget.value
                : 0.0;
            RESTTypeData.target_temperature_high =
              typeof value.value.target_temperature_settings.targetTemperature.coolingTarget.value === 'number'
                ? value.value.target_temperature_settings.targetTemperature.coolingTarget.value
                : 0.0;
            if (value.value.target_temperature_settings.targetTemperature.setpointType === 'SET_POINT_TYPE_COOL') {
              // Target temperature is the cooling point
              RESTTypeData.target_temperature = value.value.target_temperature_settings.targetTemperature.coolingTarget.value;
            }
            if (value.value.target_temperature_settings.targetTemperature.setpointType === 'SET_POINT_TYPE_HEAT') {
              // Target temperature is the heating point
              RESTTypeData.target_temperature = value.value.target_temperature_settings.targetTemperature.heatingTarget.value;
            }
            if (value.value.target_temperature_settings.targetTemperature.setpointType === 'SET_POINT_TYPE_RANGE') {
              // Target temperature is in between the heating and cooling point
              RESTTypeData.target_temperature =
                (value.value.target_temperature_settings.targetTemperature.coolingTarget.value +
                  value.value.target_temperature_settings.targetTemperature.heatingTarget.value) *
                0.5;
            }

            // Work out if eco mode is active and adjust temperature low/high and target
            if (value.value.eco_mode_state.ecoMode !== 'ECO_MODE_INACTIVE') {
              RESTTypeData.target_temperature_low = value.value.eco_mode_settings.ecoTemperatureHeat.value.value;
              RESTTypeData.target_temperature_high = value.value.eco_mode_settings.ecoTemperatureCool.value.value;
              if (
                value.value.eco_mode_settings.ecoTemperatureHeat.enabled === true &&
                value.value.eco_mode_settings.ecoTemperatureCool.enabled === false
              ) {
                RESTTypeData.target_temperature = value.value.eco_mode_settings.ecoTemperatureHeat.value.value;
                RESTTypeData.hvac_mode = 'ecoheat';
              }
              if (
                value.value.eco_mode_settings.ecoTemperatureHeat.enabled === false &&
                value.value.eco_mode_settings.ecoTemperatureCool.enabled === true
              ) {
                RESTTypeData.target_temperature = value.value.eco_mode_settings.ecoTemperatureCool.value.value;
                RESTTypeData.hvac_mode = 'ecocool';
              }
              if (
                value.value.eco_mode_settings.ecoTemperatureHeat.enabled === true &&
                value.value.eco_mode_settings.ecoTemperatureCool.enabled === true
              ) {
                RESTTypeData.target_temperature =
                  (value.value.eco_mode_settings.ecoTemperatureCool.value.value +
                    value.value.eco_mode_settings.ecoTemperatureHeat.value.value) *
                  0.5;
                RESTTypeData.hvac_mode = 'ecorange';
              }
            }

            // Work out current state ie: heating, cooling etc
            RESTTypeData.hvac_state = 'off'; // By default, we're not heating or cooling
            if (
              value.value.hvac_control.hvacState.coolStage1Active === true ||
              value.value.hvac_control.hvacState.coolStage2Active === true ||
              value.value.hvac_control.hvacState.coolStage2Active === true
            ) {
              // A cooling source is on, so we're in cooling mode
              RESTTypeData.hvac_state = 'cooling';
            }
            if (
              value.value.hvac_control.hvacState.heatStage1Active === true ||
              value.value.hvac_control.hvacState.heatStage2Active === true ||
              value.value.hvac_control.hvacState.heatStage3Active === true ||
              value.value.hvac_control.hvacState.alternateHeatStage1Active === true ||
              value.value.hvac_control.hvacState.alternateHeatStage2Active === true ||
              value.value.hvac_control.hvacState.auxiliaryHeatActive === true ||
              value.value.hvac_control.hvacState.emergencyHeatActive === true
            ) {
              // A heating source is on, so we're in heating mode
              RESTTypeData.hvac_state = 'heating';
            }

            // Update fan status, on or off and max number of speeds supported
            RESTTypeData.fan_state = parseInt(value.value.fan_control_settings.timerEnd?.seconds) > 0 ? true : false;
            RESTTypeData.fan_current_speed =
              value.value.fan_control_settings.timerSpeed.includes('FAN_SPEED_SETTING_STAGE') === true
                ? parseInt(value.value.fan_control_settings.timerSpeed.split('FAN_SPEED_SETTING_STAGE')[1])
                : 0;
            RESTTypeData.fan_max_speed =
              value.value.fan_control_capabilities.maxAvailableSpeed.includes('FAN_SPEED_SETTING_STAGE') === true
                ? parseInt(value.value.fan_control_capabilities.maxAvailableSpeed.split('FAN_SPEED_SETTING_STAGE')[1])
                : 0;

            // Humidifier/dehumidifier details
            RESTTypeData.target_humidity = value.value.humidity_control_settings.targetHumidity.value;
            RESTTypeData.humidifier_state = value.value.hvac_control.hvacState.humidifierActive === true;
            RESTTypeData.dehumidifier_state = value.value.hvac_control.hvacState.dehumidifierActive === true;

            // Air filter details
            RESTTypeData.has_air_filter = value.value.hvac_equipment_capabilities.hasAirFilter === true;
            RESTTypeData.filter_replacement_needed = value.value.filter_reminder.filterReplacementNeeded.value === true;

            // Process any temperature sensors associated with this thermostat
            RESTTypeData.active_rcs_sensor =
              typeof value.value.remote_comfort_sensing_settings?.activeRcsSelection?.activeRcsSensor === 'string'
                ? value.value.remote_comfort_sensing_settings.activeRcsSelection.activeRcsSensor.resourceId
                : '';
            RESTTypeData.linked_rcs_sensors = [];
            if (typeof value.value.remote_comfort_sensing_settings.associatedRcsSensors === 'object') {
              value.value.remote_comfort_sensing_settings.associatedRcsSensors.forEach((sensor) => {
                if (typeof this.#rawData?.[sensor.deviceId.resourceId]?.value === 'object') {
                  this.#rawData[sensor.deviceId.resourceId].value.associated_thermostat = object_key; // Sensor is linked to this thermostat

                  // Get sensor online/offline status
                  // 'liveness' property doesn't appear in protobuf data for temp sensors, so we'll add that object here
                  this.#rawData[sensor.deviceId.resourceId].value.liveness = {};
                  this.#rawData[sensor.deviceId.resourceId].value.liveness.status = 'LIVENESS_DEVICE_STATUS_UNSPECIFIED';
                  Object.values(value.value.remote_comfort_sensing_state.rcsSensorStatuses).forEach((sensorStatus) => {
                    if (
                      sensorStatus?.sensorId?.resourceId === sensor.deviceId.resourceId &&
                      sensorStatus?.dataRecency?.includes('OK') === true
                    ) {
                      this.#rawData[sensor.deviceId.resourceId].value.liveness.status = 'LIVENESS_DEVICE_STATUS_ONLINE';
                    }
                  });
                }

                RESTTypeData.linked_rcs_sensors.push(sensor.deviceId.resourceId);
              });
            }

            RESTTypeData.schedule_mode =
              value.value.target_temperature_settings.targetTemperature.setpointType.split('SET_POINT_TYPE_')[1].toLowerCase() !== 'off'
                ? value.value.target_temperature_settings.targetTemperature.setpointType.split('SET_POINT_TYPE_')[1].toLowerCase()
                : '';
            RESTTypeData.schedules = {};

            if (
              typeof value.value[RESTTypeData.schedule_mode + '_schedule_settings'].setpoints === 'object' &&
              value.value[RESTTypeData.schedule_mode + '_schedule_settings'].type ===
                'SET_POINT_SCHEDULE_TYPE_' + RESTTypeData.schedule_mode.toUpperCase()
            ) {
              Object.values(value.value[RESTTypeData.schedule_mode + '_schedule_settings'].setpoints).forEach((schedule) => {
                // Create REST API schedule entries
                const DAYSOFWEEK = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
                let dayofWeekIndex = DAYSOFWEEK.indexOf(schedule.dayOfWeek.split('DAY_OF_WEEK_')[1]);

                if (typeof RESTTypeData.schedules[dayofWeekIndex] === 'undefined') {
                  RESTTypeData.schedules[dayofWeekIndex] = {};
                }

                RESTTypeData.schedules[dayofWeekIndex][Object.entries(RESTTypeData.schedules[dayofWeekIndex]).length] = {
                  'temp-min': adjustTemperature(schedule.heatingTarget.value, 'C', 'C', true),
                  'temp-max': adjustTemperature(schedule.coolingTarget.value, 'C', 'C', true),
                  time: typeof schedule.secondsInDay === 'number' ? schedule.secondsInDay : 0,
                  type: RESTTypeData.schedule_mode.toUpperCase(),
                  entry_type: 'setpoint',
                };
              });
            }

            tempDevice = process_thermostat_data(object_key, RESTTypeData);
          }

          if (value.source === NestAccfactory.DataSource.REST) {
            let RESTTypeData = {};
            RESTTypeData.mac_address = value.value.mac_address;
            RESTTypeData.serial_number = value.value.serial_number;
            RESTTypeData.software_version = value.value.current_version;
            RESTTypeData.model = 'Thermostat';
            if (value.value.serial_number.serial_number.substring(0, 2) === '15') {
              RESTTypeData.model = 'Thermostat E (1st Gen)'; // Nest Thermostat E
            }
            if (value.value.serial_number.serial_number.substring(0, 2) === '09') {
              RESTTypeData.model = 'Thermostat (3rd Gen)'; // Nest Thermostat 3rd Gen
            }
            if (value.value.serial_number.serial_number.substring(0, 2) === '02') {
              RESTTypeData.model = 'Thermostat (2nd Gen)'; // Nest Thermostat 2nd Gen
            }
            if (value.value.serial_number.serial_number.substring(0, 2) === '01') {
              RESTTypeData.model = 'Thermostat (1st Gen)'; // Nest Thermostat 1st Gen
            }
            RESTTypeData.current_humidity = value.value.current_humidity;
            RESTTypeData.temperature_scale = value.value.temperature_scale;
            RESTTypeData.removed_from_base = value.value.nlclient_state.toUpperCase() === 'BPD';
            RESTTypeData.backplate_temperature = value.value.backplate_temperature;
            RESTTypeData.current_temperature = value.value.backplate_temperature;
            RESTTypeData.battery_level = value.value.battery_level;
            RESTTypeData.online = this.#rawData['track.' + value.value.serial_number].value.online === true;
            RESTTypeData.leaf = value.value.leaf === true;
            RESTTypeData.has_humidifier = value.value.has_humidifier === true;
            RESTTypeData.has_dehumidifier = value.value.has_dehumidifier === true;
            RESTTypeData.has_fan = value.value.has_fan === true;
            RESTTypeData.can_cool = this.#rawData['shared.' + value.value.serial_number].value.can_cool === true;
            RESTTypeData.can_heat = this.#rawData['shared.' + value.value.serial_number].value.can_heat === true;
            RESTTypeData.temperature_lock = value.value.temperature_lock === true;
            RESTTypeData.temperature_lock_pin_hash = value.value.temperature_lock_pin_hash;
            RESTTypeData.away = false;
            if (
              typeof this.#rawData['structure.' + this.#rawData['link.' + value.value.serial_number].value.structure.split('.')[1]]?.value
                ?.away === 'boolean'
            ) {
              RESTTypeData.away =
                this.#rawData['structure.' + this.#rawData['link.' + value.value.serial_number].value.structure.split('.')[1]].value.away;
            }
            if (
              this.#rawData['structure.' + this.#rawData['link.' + value.value.serial_number].value.structure.split('.')[1]]?.value
                ?.structure_mode?.structureMode === 'STRUCTURE_MODE_AWAY'
            ) {
              RESTTypeData.away = true;
            }
            RESTTypeData.occupancy = RESTTypeData.away === false; // Occupancy is opposite of away status ie: away is false, then occupied
            RESTTypeData.vacation_mode = false;
            if (
              typeof this.#rawData['structure.' + this.#rawData['link.' + value.value.serial_number].value.structure.split('.')[1]]?.value
                ?.vacation_mode === 'boolean'
            ) {
              RESTTypeData.vacation_mode =
                this.#rawData[
                  'structure.' + this.#rawData['link.' + value.value.serial_number].value.structure.split('.')[1]
                ].value.vacation_mode; // vacation mode
            }
            if (
              this.#rawData['structure.' + this.#rawData['link.' + value.value.serial_number].value.structure.split('.')[1]]?.value
                ?.structure_mode?.structureMode === 'STRUCTURE_MODE_VACATION'
            ) {
              RESTTypeData.vacation_mode = true;
            }
            RESTTypeData.description =
              typeof this.#rawData['shared.' + value.value.serial_number]?.value?.name === 'string'
                ? makeHomeKitName(this.#rawData['shared.' + value.value.serial_number].value.name)
                : '';
            RESTTypeData.location = get_location_name(
              this.#rawData['link.' + value.value.serial_number].value.structure.split('.')[1],
              value.value.where_id,
            );

            // Work out current mode. ie: off, cool, heat, range and get temperature low (heat) and high (cool)
            RESTTypeData.hvac_mode = this.#rawData['shared.' + value.value.serial_number].value.target_temperature_type;
            RESTTypeData.target_temperature_low = this.#rawData['shared.' + value.value.serial_number].value.target_temperature_low;
            RESTTypeData.target_temperature_high = this.#rawData['shared.' + value.value.serial_number].value.target_temperature_high;
            if (this.#rawData['shared.' + value.value.serial_number].value.target_temperature_type.toUpperCase() === 'COOL') {
              // Target temperature is the cooling point
              RESTTypeData.target_temperature = this.#rawData['shared.' + value.value.serial_number].value.target_temperature_high;
            }
            if (this.#rawData['shared.' + value.value.serial_number].value.target_temperature_type.toUpperCase() === 'HEAT') {
              // Target temperature is the heating point
              RESTTypeData.target_temperature = this.#rawData['shared.' + value.value.serial_number].value.target_temperature_low;
            }
            if (this.#rawData['shared.' + value.value.serial_number].value.target_temperature_type.toUpperCase() === 'RANGE') {
              // Target temperature is in between the heating and cooling point
              RESTTypeData.target_temperature =
                (this.#rawData['shared.' + value.value.serial_number].value.target_temperature_low +
                  this.#rawData['shared.' + value.value.serial_number].value.target_temperature_high) *
                0.5;
            }

            // Work out if eco mode is active and adjust temperature low/high and target
            if (value.value.eco.mode.toUpperCase() === 'AUTO-ECO' || value.value.eco.mode.toUpperCase() === 'MANUAL-ECO') {
              RESTTypeData.target_temperature_low = value.value.away_temperature_low;
              RESTTypeData.target_temperature_high = value.value.away_temperature_high;
              if (value.value.away_temperature_high_enabled === true && value.value.away_temperature_low_enabled === false) {
                RESTTypeData.target_temperature = value.value.away_temperature_low;
                RESTTypeData.hvac_mode = 'ecoheat';
              }
              if (value.value.away_temperature_high_enabled === true && value.value.away_temperature_low_enabled === false) {
                RESTTypeData.target_temperature = value.value.away_temperature_high;
                RESTTypeData.hvac_mode = 'ecocool';
              }
              if (value.value.away_temperature_high_enabled === true && value.value.away_temperature_low_enabled === true) {
                RESTTypeData.target_temperature = (value.value.away_temperature_low + value.value.away_temperature_high) * 0.5;
                RESTTypeData.hvac_mode = 'ecorange';
              }
            }

            // Work out current state ie: heating, cooling etc
            RESTTypeData.hvac_state = 'off'; // By default, we're not heating or cooling
            if (
              this.#rawData['shared.' + value.value.serial_number].value.hvac_heater_state === true ||
              this.#rawData['shared.' + value.value.serial_number].value.hvac_heat_x2_state === true ||
              this.#rawData['shared.' + value.value.serial_number].value.hvac_heat_x3_state === true ||
              this.#rawData['shared.' + value.value.serial_number].value.hvac_aux_heater_state === true ||
              this.#rawData['shared.' + value.value.serial_number].value.hvac_alt_heat_x2_state === true ||
              this.#rawData['shared.' + value.value.serial_number].value.hvac_emer_heat_state === true ||
              this.#rawData['shared.' + value.value.serial_number].value.hvac_alt_heat_state === true
            ) {
              // A heating source is on, so we're in heating mode
              RESTTypeData.hvac_state = 'heating';
            }
            if (
              this.#rawData['shared.' + value.value.serial_number].value.hvac_ac_state === true ||
              this.#rawData['shared.' + value.value.serial_number].value.hvac_cool_x2_state === true ||
              this.#rawData['shared.' + value.value.serial_number].value.hvac_cool_x3_state === true
            ) {
              // A cooling source is on, so we're in cooling mode
              RESTTypeData.hvac_state = 'cooling';
            }

            // Update fan status, on or off
            RESTTypeData.fan_state = value.value.fan_timer_timeout > 0 ? true : false;
            RESTTypeData.fan_current_speed =
              value.value.fan_timer_speed.includes('stage') === true ? parseInt(value.value.fan_timer_speed.split('stage')[1]) : 0;
            RESTTypeData.fan_max_speed =
              value.value.fan_capabilities.includes('stage') === true ? parseInt(value.value.fan_capabilities.split('stage')[1]) : 0;

            // Humidifier/dehumidifier details
            RESTTypeData.target_humidity = typeof value.value.target_humidity === 'number' ? value.value.target_humidity : 0.0;
            RESTTypeData.humidifier_state = value.value.humidifier_state === true;
            RESTTypeData.dehumidifier_state = value.value.dehumidifier_state === true;

            // Air filter details
            RESTTypeData.has_air_filter = value.value.has_air_filter === true;
            RESTTypeData.filter_replacement_needed = value.value.filter_replacement_needed === true;

            // Process any temperature sensors associated with this thermostat
            RESTTypeData.active_rcs_sensor = '';
            RESTTypeData.linked_rcs_sensors = [];
            this.#rawData['rcs_settings.' + value.value.serial_number].value.associated_rcs_sensors.forEach((sensor) => {
              if (typeof this.#rawData[sensor]?.value === 'object') {
                this.#rawData[sensor].value.associated_thermostat = object_key; // Sensor is linked to this thermostat

                // Is this sensor the active one? If so, get some details about it
                if (this.#rawData['rcs_settings.' + value.value.serial_number].value.active_rcs_sensors.includes(sensor)) {
                  RESTTypeData.active_rcs_sensor = this.#rawData[sensor].value.serial_number.toUpperCase();
                  RESTTypeData.current_temperature = this.#rawData[sensor].value.current_temperature;
                }
                RESTTypeData.linked_rcs_sensors.push(this.#rawData[sensor].value.serial_number.toUpperCase());
              }
            });

            // Get associated schedules
            if (typeof this.#rawData['schedule.' + value.value.serial_number] === 'object') {
              Object.values(this.#rawData['schedule.' + value.value.serial_number].value.days).forEach((schedules) => {
                Object.values(schedules).forEach((schedule) => {
                  // Fix up temperatures in the schedule
                  if (typeof schedule['temp'] === 'number') {
                    schedule.temp = adjustTemperature(schedule.temp, 'C', 'C', true);
                  }
                  if (typeof schedule['temp-min'] === 'number') {
                    schedule['temp-min'] = adjustTemperature(schedule['temp-min'], 'C', 'C', true);
                  }
                  if (typeof schedule['temp-max'] === 'number') {
                    schedule['temp-max'] = adjustTemperature(schedule['temp-max'], 'C', 'C', true);
                  }
                });
              });
              RESTTypeData.schedules = this.#rawData['schedule.' + value.value.serial_number].value.days;
              RESTTypeData.schedule_mode = this.#rawData['schedule.' + value.value.serial_number].value.schedule_mode;
            }

            tempDevice = process_thermostat_data(object_key, RESTTypeData);
          }
          // eslint-disable-next-line no-unused-vars
        } catch (error) {
          this?.log?.debug && this.log.debug('Error processing data for thermostat(s)');
        }

        if (Object.entries(tempDevice).length !== 0 && typeof devices[tempDevice.serial_number] === 'undefined') {
          // Insert any extra options we've read in from configuration file for this device
          tempDevice.eveHistory =
            this.config.options.eveHistory === true || this.config?.devices?.[tempDevice.serial_number]?.eveHistory === true;
          tempDevice.humiditySensor = this.config?.devices?.[tempDevice.serial_number]?.humiditySensor === true;
          tempDevice.externalCool =
            typeof this.config?.devices?.[tempDevice.serial_number]?.externalCool === 'string'
              ? this.config.devices[tempDevice.serial_number].externalCool
              : undefined; // Config option for external cooling source
          tempDevice.externalHeat =
            typeof this.config?.devices?.[tempDevice.serial_number]?.externalHeat === 'string'
              ? this.config.devices[tempDevice.serial_number].externalHeat
              : undefined; // Config option for external heating source
          tempDevice.externalFan =
            typeof this.config?.devices?.[tempDevice.serial_number]?.externalFan === 'string'
              ? this.config.devices[tempDevice.serial_number].externalFan
              : undefined; // Config option for external fan source
          tempDevice.externalDehumidifier =
            typeof this.config?.devices?.[tempDevice.serial_number]?.externalDehumidifier === 'string'
              ? this.config.devices[tempDevice.serial_number].externalDehumidifier
              : undefined; // Config option for external dehumidifier source
          devices[tempDevice.serial_number] = tempDevice; // Store processed device
        }
      });

    // Process data for any temperature sensors we have in the raw data
    // This is done AFTER where have processed thermostat(s) as we inserted some extra details in there
    // We only process if the sensor has been associated to a thermostat
    const process_kryptonite_data = (object_key, data) => {
      let processed = {};
      try {
        // Fix up data we need to
        data.serial_number = data.serial_number.toUpperCase();
        data.excluded =
          typeof this.config?.devices?.[data.serial_number]?.exclude === 'boolean'
            ? this.config.devices[data.serial_number].exclude
            : false; // Mark device as excluded or not
        data.device_type = NestAccfactory.DeviceType.TEMPSENSOR; // Nest Temperature sensor
        data.uuid = object_key; // Internal structure ID
        data.manufacturer = typeof data?.manufacturer === 'string' ? data.manufacturer : 'Nest';
        data.software_version = typeof data?.software_version === 'string' ? data.software_version.replace(/-/g, '.') : '0.0.0';
        data.model = 'Temperature Sensor';
        data.current_temperature = adjustTemperature(data.current_temperature, 'C', 'C', true);
        let description = typeof data?.description === 'string' ? data.description : '';
        let location = typeof data?.location === 'string' ? data.location : '';
        if (description === '') {
          description = location;
          location = '';
        }
        data.description = makeHomeKitName(location === '' ? description : description + ' - ' + location);
        delete data.location;

        // Insert details for when using HAP-NodeJS library rather than Homebridge
        if (typeof this.config?.options?.hkPairingCode === 'string' && this.config.options.hkPairingCode !== '') {
          data.hkPairingCode = this.config.options.hkPairingCode;
        }
        if (
          typeof this.config?.devices?.[data.serial_number]?.hkPairingCode === 'string' &&
          this.config.devices[data.serial_number].hkPairingCode !== ''
        ) {
          data.hkPairingCode = this.config.devices[data.serial_number].hkPairingCode;
        }
        if (data?.hkPairingCode !== undefined) {
          // Use a Nest Labs prefix for first 6 digits, followed by a CRC24 based off serial number for last 6 digits.
          let tempMACAddress = '18B430' + crc24(data.serial_number).toUpperCase();
          data.hkUsername = tempMACAddress
            .toString('hex')
            .split(/(..)/)
            .filter((s) => s)
            .join(':')
            .toUpperCase(); // Create mac_address in format of xx:xx:xx:xx:xx:xx
        }

        processed = data;
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        // Empty
      }
      return processed;
    };

    Object.entries(this.#rawData)
      .filter(
        ([key, value]) =>
          (key.startsWith('kryptonite.') === true ||
            (key.startsWith('DEVICE_') === true && value.value?.device_info?.typeName === 'nest.resource.NestKryptoniteResource')) &&
          (deviceUUID === '' || deviceUUID === key),
      )
      .forEach(([object_key, value]) => {
        let tempDevice = {};
        try {
          if (
            value.source === NestAccfactory.DataSource.PROTOBUF &&
            typeof value?.value?.associated_thermostat === 'string' &&
            value?.value?.associated_thermostat !== ''
          ) {
            let RESTTypeData = {};
            RESTTypeData.serial_number = value.value.device_identity.serialNumber;
            // Guessing battery minimum voltage is 2v??
            RESTTypeData.battery_level = scaleValue(value.value.battery.assessedVoltage.value, 2.0, 3.0, 0, 100);
            RESTTypeData.current_temperature = value.value.current_temperature.temperatureValue.temperature.value;
            // Online status we 'faked' when processing Thermostat protobuf data
            RESTTypeData.online = value.value?.liveness?.status === 'LIVENESS_DEVICE_STATUS_ONLINE';
            RESTTypeData.associated_thermostat = value.value.associated_thermostat;
            RESTTypeData.description = typeof value.value?.label?.label === 'string' ? value.value.label.label : '';
            RESTTypeData.location = get_location_name(
              value.value.device_info.pairerId.resourceId,
              value.value.device_located_settings.whereAnnotationRid.resourceId,
            );
            RESTTypeData.active_sensor =
              this.#rawData[value.value.associated_thermostat].value?.remote_comfort_sensing_settings?.activeRcsSelection?.activeRcsSensor
                ?.resourceId === object_key;
            tempDevice = process_kryptonite_data(object_key, RESTTypeData);
          }
          if (
            value.source === NestAccfactory.DataSource.REST &&
            typeof value?.value?.associated_thermostat === 'string' &&
            value?.value?.associated_thermostat !== ''
          ) {
            let RESTTypeData = {};
            RESTTypeData.serial_number = value.value.sserial_number;
            RESTTypeData.battery_level = scaleValue(value.value.battery_level, 0, 100, 0, 100);
            RESTTypeData.current_temperature = value.value.current_temperature;
            RESTTypeData.online = Math.floor(Date.now() / 1000) - value.value.last_updated_at < 3600 * 4 ? true : false;
            RESTTypeData.associated_thermostat = value.value.associated_thermostat;
            RESTTypeData.description = value.value.description;
            RESTTypeData.location = get_location_name(value.value.structure_id, value.value.where_id);
            RESTTypeData.active_sensor =
              this.#rawData['rcs_settings.' + value.value.associated_thermostat].value.active_rcs_sensors.includes(object_key) === true;
            tempDevice = process_kryptonite_data(object_key, RESTTypeData);
          }
          // eslint-disable-next-line no-unused-vars
        } catch (error) {
          this?.log?.debug && this.log.debug('Error processing data for temperature sensor(s)');
        }
        if (Object.entries(tempDevice).length !== 0 && typeof devices[tempDevice.serial_number] === 'undefined') {
          // Insert any extra options we've read in from configuration file for this device
          tempDevice.eveHistory =
            this.config.options.eveHistory === true || this.config?.devices?.[tempDevice.serial_number]?.eveHistory === true;
          devices[tempDevice.serial_number] = tempDevice; // Store processed device
        }
      });

    // Process data for any smoke detectors we have in the raw data
    const process_protect_data = (object_key, data) => {
      let processed = {};
      try {
        // Fix up data we need to
        data.serial_number = data.serial_number.toUpperCase(); // ensure serial numbers are in upper case
        data.excluded =
          typeof this.config?.devices?.[data.serial_number]?.exclude === 'boolean'
            ? this.config.devices[data.serial_number].exclude
            : false; // Mark device as excluded or not
        data.device_type = NestAccfactory.DeviceType.SMOKESENSOR; // Nest Protect
        data.uuid = object_key; // Internal structure ID
        data.manufacturer = typeof data?.manufacturer === 'string' ? data.manufacturer : 'Nest';
        data.software_version = typeof data?.software_version === 'string' ? data.software_version.replace(/-/g, '.') : '0.0.0';
        data.battery_level = scaleValue(data.battery_level, 0, 5400, 0, 100);
        data.model = 'Protect';
        if (data.wired_or_battery === 0) {
          data.model = data.model + ' (wired'; // Mains powered
        }
        if (data.wired_or_battery === 1) {
          data.model = data.model + ' (battery'; // Battery powered
        }
        if (data.serial_number.substring(0, 2) === '06') {
          data.model = data.model + ', 2nd Gen)'; // Nest Protect 2nd Gen
        }
        if (data.serial_number.substring(0, 2) === '05') {
          data.model = data.model + ', 1st Gen)'; // Nest Protect 1st Gen
        }
        let description = typeof data?.description === 'string' ? data.description : '';
        let location = typeof data?.location === 'string' ? data.location : '';
        if (description === '') {
          description = location;
          location = '';
        }
        data.description = makeHomeKitName(location === '' ? description : description + ' - ' + location);
        delete data.location;

        // Insert details for when using HAP-NodeJS library rather than Homebridge
        if (typeof this.config?.options?.hkPairingCode === 'string' && this.config.options.hkPairingCode !== '') {
          data.hkPairingCode = this.config.options.hkPairingCode;
        }
        if (
          typeof this.config?.devices?.[data.serial_number]?.hkPairingCode === 'string' &&
          this.config.devices[data.serial_number].hkPairingCode !== ''
        ) {
          data.hkPairingCode = this.config.devices[data.serial_number].hkPairingCode;
        }
        if (data?.hkPairingCode !== undefined && data?.mac_address !== undefined) {
          // Create mac_address in format of xx:xx:xx:xx:xx:xx
          data.hkUsername = data.mac_address
            .toString('hex')
            .split(/(..)/)
            .filter((s) => s)
            .join(':')
            .toUpperCase();
          delete data.mac_address;
        }

        processed = data;
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        // Empty
      }
      return processed;
    };

    Object.entries(this.#rawData)
      .filter(
        ([key, value]) =>
          (key.startsWith('topaz.') === true ||
            (key.startsWith('DEVICE_') === true && value.value?.device_info?.className.startsWith('topaz') === true)) &&
          (deviceUUID === '' || deviceUUID === key),
      )
      .forEach(([object_key, value]) => {
        let tempDevice = {};
        try {
          if (value.source === NestAccfactory.DataSource.PROTOBUF) {
            /*
            let RESTTypeData = {};
            RESTTypeData.mac_address = Buffer.from(value.value.wifi_interface.macAddress, 'base64');
            RESTTypeData.serial_number = value.value.device_identity.serialNumber;
            RESTTypeData.software_version = value.value.device_identity.softwareVersion;
            RESTTypeData.online = value.value?.liveness?.status === 'LIVENESS_DEVICE_STATUS_ONLINE';
            RESTTypeData.line_power_present = value.value?.wall_power?.status === 'POWER_SOURCE_STATUS_ACTIVE';
            RESTTypeData.wired_or_battery = typeof value.value?.wall_power === 'object' ? 0 : 1;
            RESTTypeData.battery_level = parseFloat(value.value.battery_voltage_bank1.batteryValue.batteryVoltage.value);
            RESTTypeData.battery_health_state = value.value.battery_voltage_bank1.faultInformation;
            RESTTypeData.smoke_status = value.value.safety_alarm_smoke.alarmState === 'ALARM_STATE_ALARM' ? 2 : 0; // matches REST data
            RESTTypeData.co_status = value.value.safety_alarm_co.alarmState === 'ALARM_STATE_ALARM' ? 2 : 0; // matches REST data
            RESTTypeData.heat_status =
            RESTTypeData.hushed_state =
              value.value.safety_alarm_smoke.silenceState === 'SILENCE_STATE_SILENCED' ||
              value.value.safety_alarm_co.silenceState === 'SILENCE_STATE_SILENCED';
            RESTTypeData.ntp_green_led = value.value.night_time_promise_settings.greenLedEnabled === true;
            RESTTypeData.smoke_test_passed = value.value.safety_summary.warningDevices.failures.includes('FAILURE_TYPE_SMOKE') === false;
            RESTTypeData.heat_test_passed = value.value.safety_summary.warningDevices.failures.includes('FAILURE_TYPE_TEMP') === false;
            RESTTypeData.latest_alarm_test =
              parseInt(value.value.self_test.lastMstEnd?.second) > 0 ? parseInt(value.value.self_test.lastMstEnd.seconds) : 0;
            RESTTypeData.self_test_in_progress =
              value.value.legacy_structure_self_test.mstInProgress === true ||
              value.value.legacy_structure_self_test.astInProgress === true;
            RESTTypeData.replacement_date =
              value.value.legacy_protect_device_settings.replaceByDate.hasOwnProperty('seconds') === true
                ? parseInt(value.value.legacy_protect_device_settings.replaceByDate.seconds)
                : 0;

            RESTTypeData.removed_from_base =
            RESTTypeData.topaz_hush_key =
              typeof value.value.safety_structure_settings.structureHushKey === 'string'
                ? value.value.safety_structure_settings.structureHushKey
                : '';
            RESTTypeData.detected_motion = value.value.legacy_protect_device_info.autoAway === false;
            RESTTypeData.description = typeof value.value?.label?.label === 'string' ? value.value.label.label : '';
            RESTTypeData.location = get_location_name(
              value.value.device_info.pairerId.resourceId,
              value.value.device_located_settings.whereAnnotationRid.resourceId,
            );
            tempDevice = process_protect_data(object_key, RESTTypeData);
            */
          }

          if (value.source === NestAccfactory.DataSource.REST) {
            let RESTTypeData = {};
            RESTTypeData.mac_address = value.value.wifi_mac_address;
            RESTTypeData.serial_number = value.value.serial_number;
            RESTTypeData.software_version = value.value.software_version;
            RESTTypeData.online = this.#rawData['widget_track.' + value.value.thread_mac_address.toUpperCase()].value.online === true;
            RESTTypeData.line_power_present = value.value.line_power_present === true;
            RESTTypeData.wired_or_battery = value.value.wired_or_battery;
            RESTTypeData.battery_level = value.value.battery_level;
            RESTTypeData.battery_health_state = value.value.battery_health_state;
            RESTTypeData.smoke_status = value.value.smoke_status;
            RESTTypeData.co_status = value.value.co_status;
            RESTTypeData.heat_status = value.value.heat_status;
            RESTTypeData.hushed_state = value.value.hushed_state === true;
            RESTTypeData.ntp_green_led = value.value.ntp_green_led_enable === true;
            RESTTypeData.smoke_test_passed = value.value.component_smoke_test_passed === true;
            RESTTypeData.heat_test_passed = value.value.component_temp_test_passed === true;
            RESTTypeData.latest_alarm_test = value.value.latest_manual_test_end_utc_secs;
            RESTTypeData.self_test_in_progress =
              this.#rawData['safety.' + value.value.structure_id].value.manual_self_test_in_progress === true;
            RESTTypeData.replacement_date = value.value.replace_by_date_utc_secs;
            RESTTypeData.removed_from_base = value.value.removed_from_base === true;
            RESTTypeData.topaz_hush_key =
              typeof this.#rawData['structure.' + value.value.structure_id]?.value?.topaz_hush_key === 'string'
                ? this.#rawData['structure.' + value.value.structure_id].value.topaz_hush_key
                : '';
            RESTTypeData.detected_motion = value.value.auto_away === false;
            RESTTypeData.description = value.value?.description;
            RESTTypeData.location = get_location_name(value.value.structure_id, value.value.where_id);
            tempDevice = process_protect_data(object_key, RESTTypeData);
          }
          // eslint-disable-next-line no-unused-vars
        } catch (error) {
          this?.log?.debug && this.log.debug('Error processing data for smoke sensor(s)');
        }

        if (Object.entries(tempDevice).length !== 0 && typeof devices[tempDevice.serial_number] === 'undefined') {
          // Insert any extra options we've read in from configuration file for this device
          tempDevice.eveHistory =
            this.config.options.eveHistory === true || this.config?.devices?.[tempDevice.serial_number]?.eveHistory === true;
          devices[tempDevice.serial_number] = tempDevice; // Store processed device
        }
      });

    // Process data for any camera/doorbell(s) we have in the raw data
    const process_camera_doorbell_data = (object_key, data) => {
      let processed = {};
      try {
        // Fix up data we need to
        data.serial_number = data.serial_number.toUpperCase(); // ensure serial numbers are in upper case
        data.excluded =
          typeof this.config?.devices?.[data.serial_number]?.exclude === 'boolean'
            ? this.config.devices[data.serial_number].exclude
            : false; // Mark device as excluded or not
        data.device_type = NestAccfactory.DeviceType.CAMERA;
        if (data.model.toUpperCase().includes('DOORBELL') === true) {
          data.device_type = NestAccfactory.DeviceType.DOORBELL;
        }
        data.uuid = object_key; // Internal structure ID
        data.manufacturer = typeof data?.manufacturer === 'string' ? data.manufacturer : 'Nest';
        data.software_version = typeof data?.software_version === 'string' ? data.software_version.replace(/-/g, '.') : '0.0.0';
        let description = typeof data?.description === 'string' ? data.description : '';
        let location = typeof data?.location === 'string' ? data.location : '';
        if (description === '') {
          description = location;
          location = '';
        }
        data.description = makeHomeKitName(location === '' ? description : description + ' - ' + location);
        delete data.location;

        // Insert details for when using HAP-NodeJS library rather than Homebridge
        if (typeof this.config?.options?.hkPairingCode === 'string' && this.config.options.hkPairingCode !== '') {
          data.hkPairingCode = this.config.options.hkPairingCode;
        }
        if (
          typeof this.config?.devices?.[data.serial_number]?.hkPairingCode === 'string' &&
          this.config.devices[data.serial_number].hkPairingCode !== ''
        ) {
          data.hkPairingCode = this.config.devices[data.serial_number].hkPairingCode;
        }
        if (data?.hkPairingCode !== undefined && data?.mac_address !== undefined) {
          // Create mac_address in format of xx:xx:xx:xx:xx:xx
          data.hkUsername = data.mac_address
            .toString('hex')
            .split(/(..)/)
            .filter((s) => s)
            .join(':')
            .toUpperCase();
          delete data.mac_address;
        }

        // Insert details to allow access to camera API calls for the device
        if (typeof this.#connections?.[connectionType]?.cameraAPI === 'object') {
          data.apiAccess = this.#connections[connectionType].cameraAPI;
        }

        processed = data;
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        // Empty
      }
      return processed;
    };

    const PROTOBUF_CAMERA_DOORBELL_RESOURCES = [
      'google.resource.NeonQuartzResource',
      'google.resource.GreenQuartzResource',
      'google.resource.SpencerResource',
      'google.resource.VenusResource',
      'nest.resource.NestCamIndoorResource',
      'nest.resource.NestCamIQResource',
      'nest.resource.NestCamIQOutdoorResource',
      'nest.resource.NestHelloResource',
      'google.resource.AzizResource',
      'google.resource.GoogleNewmanResource',
    ];
    Object.entries(this.#rawData)
      .filter(
        ([key, value]) =>
          (key.startsWith('quartz.') === true ||
            (key.startsWith('DEVICE_') === true &&
              PROTOBUF_CAMERA_DOORBELL_RESOURCES.includes(value.value?.device_info?.typeName) === true)) &&
          (deviceUUID === '' || deviceUUID === key),
      )
      .forEach(([object_key, value]) => {
        let tempDevice = {};
        try {
          if (value.source === NestAccfactory.DataSource.PROTOBUF) {
            /*
            let RESTTypeData = {};
            RESTTypeData.mac_address = value.value.wifi_interface.macAddress.toString('hex');
            RESTTypeData.serial_number = value.value.device_identity.serialNumber;
            RESTTypeData.software_version = value.value.device_identity.softwareVersion;
            RESTTypeData.model = 'Camera';
            if (value.value.device_info.typeName === 'google.resource.NeonQuartzResource') {
              RESTTypeData.model = 'Cam (battery)';
            }
            if (value.value.device_info.typeName === 'google.resource.GreenQuartzResource') {
              RESTTypeData.model = 'Doorbell (battery)';
            }
            if (value.value.device_info.typeName === 'google.resource.SpencerResource') {
              RESTTypeData.model = 'Cam (wired)';
            }
            if (value.value.device_info.typeName === 'google.resource.VenusResource') {
              RESTTypeData.model = 'Doorbell (wired, 2nd Gen)';
            }
            if (value.value.device_info.typeName === 'nest.resource.NestCamIndoorResource') {
              RESTTypeData.model = 'Cam Indoor (1st Gen)';
            }
            if (value.value.device_info.typeName === 'nest.resource.NestCamIQResource') {
              RESTTypeData.model = 'Cam IQ';
            }
            if (value.value.device_info.typeName === 'nest.resource.NestCamIQOutdoorResource') {
              RESTTypeData.model = 'Cam Outdoor (1st Gen)';
            }
            if (value.value.device_info.typeName === 'nest.resource.NestHelloResource') {
              RESTTypeData.model = 'Doorbell (wired, 1st Gen)';
            }
            if (value.value.device_info.typeName === 'google.resource.AzizResource') {
              RESTTypeData.model = 'Cam with Floodlight (wired)';
            }
            if (value.value.device_info.typeName === 'google.resource.GoogleNewmanResource') {
              RESTTypeData.model = 'Hub Max';
            }
            RESTTypeData.online = value.value?.liveness?.status === 'LIVENESS_DEVICE_STATUS_ONLINE';
            RESTTypeData.description = typeof value.value?.label?.label === 'string' ? value.value.label.label : '';
            RESTTypeData.location = get_location_name(
              value.value.device_info.pairerId.resourceId,
              value.value.device_located_settings.whereAnnotationRid.resourceId,
            );
            RESTTypeData.audio_enabled = value.value?.microphone_settings?.enableMicrophone === true;
            RESTTypeData.has_indoor_chime =
              value.value?.doorbell_indoor_chime_settings?.chimeType === 'CHIME_TYPE_MECHANICAL' ||
              value.value?.doorbell_indoor_chime_settings?.chimeType === 'CHIME_TYPE_ELECTRONIC';
            RESTTypeData.indoor_chime_enabled = value.value?.doorbell_indoor_chime_settings?.chimeEnabled === true;
            RESTTypeData.streaming_enabled = value.value?.recording_toggle?.currentCameraState === 'CAMERA_ON';
            RESTTypeData.direct_nexustalk_host =
              typeof value.value?.streaming_protocol?.directHost?.value === 'string' ? value.value.streaming_protocol.directHost.value : '';
            //RESTTypeData.has_irled =
            //RESTTypeData.irled_enabled =
            //RESTTypeData.has_statusled =
            //RESTTypeData.statusled_brightness =
            RESTTypeData.has_microphone = value.value?.microphone_settings?.enableMicrophone === true;
            RESTTypeData.has_speaker = value.value?.speaker_volume?.volume === true;
            RESTTypeData.has_motion_detection = value.value?.observation_trigger_capabilities?.videoEventTypes?.motion?.value === true;
            RESTTypeData.activity_zones = [];
            if (value.value?.activity_zone_settings?.activityZones !== undefined) {
              value.value.activity_zone_settings.activityZones.forEach((zone) => {
                RESTTypeData.activity_zones.push({
                  id: typeof zone.zoneProperties?.zoneId === 'number' ? zone.zoneProperties.zoneId : zone.zoneProperties.internalIndex,
                  name: makeHomeKitName(typeof zone.zoneProperties?.name === 'string' ? zone.zoneProperties.name : ''),
                  hidden: false,
                  uri: '',
                });
              });
            }
            RESTTypeData.alerts = typeof value.value?.alerts === 'object' ? value.value.alerts : [];
            RESTTypeData.quiet_time_enabled =
              parseInt(value.value?.quiet_time_settings?.quietTimeEnds?.seconds) !== 0 &&
              Math.floor(Date.now() / 1000) < parseInt(value.value?.quiet_time_settings?.quietTimeEnds?.second);
            RESTTypeData.camera_type = value.value.device_identity.vendorProductId;
            RESTTypeData.migration_in_progress =
              value.value?.camera_migration_status?.state?.progress !== 'PROGRESS_NONE' &&
              value.value?.camera_migration_status?.state?.progress !== 'PROGRESS_COMPLETE';

            tempDevice = process_camera_doorbell_data(object_key, RESTTypeData);
            */
          }

          if (value.source === NestAccfactory.DataSource.REST) {
            // We'll only use the REST API data for Camera's which have NOT been migrated to Google Home
            let RESTTypeData = {};
            RESTTypeData.mac_address = value.value.mac_address;
            RESTTypeData.serial_number = value.value.serial_number;
            RESTTypeData.software_version = value.value.software_version;
            RESTTypeData.model = value.value.model.replace(/nest\s*/gi, ''); // Use camera/doorbell model that Nest supplies
            RESTTypeData.description = value.value?.description;
            RESTTypeData.location = get_location_name(value.value.structure_id, value.value.where_id);
            RESTTypeData.streaming_enabled = value.value.streaming_state.includes('enabled') === true;
            RESTTypeData.direct_nexustalk_host = value.value.direct_nexustalk_host;
            RESTTypeData.nexus_api_http_server_url = value.value.nexus_api_http_server_url;
            RESTTypeData.online = value.value.streaming_state.includes('offline') === false;
            RESTTypeData.audio_enabled = value.value.audio_input_enabled === true;
            RESTTypeData.has_indoor_chime = value.value.capabilities.includes('indoor_chime') === true;
            RESTTypeData.indoor_chime_enabled = value.value.properties['doorbell.indoor_chime.enabled'] === true;
            RESTTypeData.has_irled = value.value.capabilities.includes('irled') === true;
            RESTTypeData.irled_enabled = value.value.properties['irled.state'] !== 'always_off';
            RESTTypeData.has_statusled = value.value.capabilities.includes('statusled') === true;
            RESTTypeData.has_video_flip = value.value.capabilities.includes('video.flip') === true;
            RESTTypeData.video_flipped = value.value.properties['video.flipped'] === true;
            RESTTypeData.statusled_brightness = value.value.properties['statusled.brightness'];
            RESTTypeData.has_microphone = value.value.capabilities.includes('audio.microphone') === true;
            RESTTypeData.has_speaker = value.value.capabilities.includes('audio.speaker') === true;
            RESTTypeData.has_motion_detection = value.value.capabilities.includes('detectors.on_camera') === true;
            RESTTypeData.activity_zones = value.value.activity_zones; // structure elements we added
            RESTTypeData.alerts = typeof value.value?.alerts === 'object' ? value.value.alerts : [];
            RESTTypeData.streaming_protocols = ['NEXUSTALK'];
            RESTTypeData.quiet_time_enabled = false;
            RESTTypeData.camera_type = value.value.camera_type;
            RESTTypeData.migration_in_progress =
              value.value.properties['cc2migration.overview_state'] === 'FORWARD_MIGRATION_IN_PROGRESS' ||
              value.value.properties['cc2migration.overview_state'] === 'REVERSE_MIGRATION_IN_PROGRESS';
            tempDevice = process_camera_doorbell_data(object_key, RESTTypeData);
            // If the camera/doorbell is being/or has been migrated to Google Home, we'll explicitly exclude this device from REST API data
            tempDevice.excluded = value.value.properties['cc2migration.overview_state'] !== 'NORMAL' ? true : tempDevice.excluded;
          }
          // eslint-disable-next-line no-unused-vars
        } catch (error) {
          this?.log?.debug && this.log.debug('Error processing data for camera/doorbell(s)');
        }

        if (Object.entries(tempDevice).length !== 0 && typeof devices[tempDevice.serial_number] === 'undefined') {
          // Insert any extra options we've read in from configuration file for this device
          tempDevice.eveHistory =
            this.config.options.eveHistory === true || this.config?.devices?.[tempDevice.serial_number]?.eveHistory === true;
          tempDevice.hksv = this.config.options.hksv === true || this.config?.devices?.[tempDevice.serial_number]?.hksv === true;
          tempDevice.doorbellCooldown =
            typeof this.config?.devices?.[tempDevice.serial_number]?.doorbellCooldown === 'number'
              ? this.config.devices[tempDevice.serial_number].doorbellCooldown
              : 60;
          tempDevice.motionCooldown =
            typeof this.config?.devices?.[tempDevice.serial_number]?.motionCooldown === 'number'
              ? this.config.devices[tempDevice.serial_number].motionCooldown
              : 60;
          tempDevice.personCooldown =
            typeof this.config?.devices?.[tempDevice.serial_number]?.personCooldown === 'number'
              ? this.config.devices[tempDevice.serial_number].personCooldown
              : 120;
          tempDevice.chimeSwitch = this.config?.devices?.[tempDevice.serial_number]?.chimeSwitch === true; // Config option for chime switch
          tempDevice.ffmpeg = this.config.options.ffmpeg; // ffmpeg details, path, libraries. No ffmpeg = undefined
          (tempDevice.maxStreams =
            typeof this.config.options?.maxStreams === 'number' ? this.config.options.maxStreams : this.deviceData.hksv === true ? 1 : 2),
            (devices[tempDevice.serial_number] = tempDevice); // Store processed device
        }
      });

    // Process data for any structure(s) for both Nest REST and protobuf API data
    // We use this to created virtual weather station(s) for each structure that has location data
    const process_structure_data = (object_key, data) => {
      let processed = {};
      try {
        // Fix up data we need to

        // For the serial number, use a Nest Labs prefix for first 6 digits, followed by a CRC24 based off structure for last 6 digits.
        data.serial_number = '18B430' + crc24(object_key).toUpperCase();
        data.excluded = this.config?.options?.weather === false; // Mark device as excluded or not
        data.device_type = NestAccfactory.DeviceType.WEATHER;
        data.uuid = object_key; // Internal structure ID
        data.manufacturer = typeof data?.manufacturer === 'string' ? data.manufacturer : 'Nest';
        data.software_version = typeof data?.software_version === 'string' ? data.software_version.replace(/-/g, '.') : '0.0.0';
        data.description = typeof data?.description === 'string' ? makeHomeKitName(data.description) : '';
        data.model = 'Weather';
        data.current_temperature = data.weather.current_temperature;
        data.current_humidity = data.weather.current_humidity;
        data.condition = data.weather.condition;
        data.wind_direction = data.weather.wind_direction;
        data.wind_speed = data.weather.wind_speed;
        data.sunrise = data.weather.sunrise;
        data.sunset = data.weather.sunset;
        data.station = data.weather.station;
        data.forecast = data.weather.forecast;
        data.elevation = 0;

        // Either use global elevation setting or one specific for device
        if (typeof this.config?.devices?.[data.serial_number]?.elevation === 'number') {
          data.elevation = this.config.devices[data.serial_number].elevation;
        }

        if (data.elevation === 0 && typeof this.config?.options?.elevation === 'number') {
          // Elevation from configuration
          data.elevation = this.config.options.elevation;
        }

        // Insert details for when using HAP-NodeJS library rather than Homebridge
        if (typeof this.config?.options?.hkPairingCode === 'string' && this.config.options.hkPairingCode !== '') {
          data.hkPairingCode = this.config.options.hkPairingCode;
        }
        if (
          typeof this.config?.devices?.[data.serial_number]?.hkPairingCode === 'string' &&
          this.config.devices[data.serial_number].hkPairingCode !== ''
        ) {
          data.hkPairingCode = this.config.devices[data.serial_number].hkPairingCode;
        }
        if (data?.hkPairingCode !== undefined) {
          // Use a Nest Labs prefix for first 6 digits, followed by a CRC24 based off serial number for last 6 digits.
          let tempMACAddress = '18B430' + crc24(object_key).toUpperCase();
          data.hkUsername = tempMACAddress
            .toString('hex')
            .split(/(..)/)
            .filter((s) => s)
            .join(':')
            .toUpperCase(); // Create mac_address in format of xx:xx:xx:xx:xx:xx
        }

        delete data.weather; // Don't need the 'weather' object in our output

        processed = data;
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        // Empty
      }
      return processed;
    };

    Object.entries(this.#rawData)
      .filter(
        ([key]) =>
          (key.startsWith('structure.') === true || key.startsWith('STRUCTURE_') === true) && (deviceUUID === '' || deviceUUID === key),
      )
      .forEach(([object_key, value]) => {
        let tempDevice = {};
        try {
          if (value.source === NestAccfactory.DataSource.PROTOBUF) {
            let RESTTypeData = {};
            RESTTypeData.postal_code = value.value.structure_location.postalCode.value;
            RESTTypeData.country_code = value.value.structure_location.countryCode.value;
            RESTTypeData.city = typeof value.value.structure_location?.city === 'string' ? value.value.structure_location.city.value : '';
            RESTTypeData.state =
              typeof value.value.structure_location?.state === 'string' ? value.value.structure_location.state.value : '';
            RESTTypeData.latitude = value.value.structure_location.geoCoordinate.latitude;
            RESTTypeData.longitude = value.value.structure_location.geoCoordinate.longitude;
            RESTTypeData.description =
              RESTTypeData.city !== '' && RESTTypeData.state !== ''
                ? RESTTypeData.city + ' - ' + RESTTypeData.state
                : value.value.structure_info.name;
            RESTTypeData.weather = value.value.weather;

            // Use the REST API structure ID from the protobuf structure. This should prevent two 'weather' objects being created
            let tempDevice = process_structure_data(value.value.structure_info.rtsStructureId, RESTTypeData);
            tempDevice.uuid = object_key; // Use the protobuf structure ID post processing
          }
          if (value.source === NestAccfactory.DataSource.REST) {
            let RESTTypeData = {};
            RESTTypeData.postal_code = value.value.postal_code;
            RESTTypeData.country_code = value.value.country_code;
            RESTTypeData.city = value.value.city;
            RESTTypeData.state = value.value.state;
            RESTTypeData.latitude = value.value.latitude;
            RESTTypeData.longitude = value.value.longitude;
            RESTTypeData.description =
              RESTTypeData.city !== '' && RESTTypeData.state !== '' ? RESTTypeData.city + ' - ' + RESTTypeData.state : value.value.name;
            RESTTypeData.weather = value.value.weather;
            tempDevice = process_structure_data(object_key, RESTTypeData);
          }
          // eslint-disable-next-line no-unused-vars
        } catch (error) {
          this?.log?.debug && this.log.debug('Error processing data for weather');
        }

        if (Object.entries(tempDevice).length !== 0 && typeof devices[tempDevice.serial_number] === 'undefined') {
          // Insert any extra options we've read in from configuration file for this device
          tempDevice.eveHistory =
            this.config.options.eveHistory === true || this.config?.devices?.[tempDevice.serial_number]?.eveHistory === true;
          devices[tempDevice.serial_number] = tempDevice; // Store processed device
        }
      });

    return devices; // Return our processed data
  }

  async #set(connectionType, deviceUUID, values) {
    if (typeof deviceUUID !== 'string' && typeof this.#rawData[deviceUUID] !== 'object' && typeof values !== 'object') {
      return;
    }

    if (
      this.#connections[connectionType].protobufRoot !== null &&
      this.#rawData[deviceUUID]?.source === NestAccfactory.DataSource.PROTOBUF
    ) {
      let TraitMap = this.#connections[connectionType].protobufRoot.lookup('nest.rpc.NestTraitSetRequest');
      let setDataToEncode = [];
      let protobufElement = {
        traitId: {
          resourceId: deviceUUID,
          traitLabel: '',
        },
        property: {
          type_url: '',
          value: {},
        },
      };

      await Promise.all(
        Object.entries(values).map(async ([key, value]) => {
          // Reset elements at start of loop
          protobufElement.traitId.traitLabel = '';
          protobufElement.property.type_url = '';
          protobufElement.property.value = {};

          if (
            (key === 'hvac_mode' &&
              typeof value === 'string' &&
              (value.toUpperCase() === 'OFF' ||
                value.toUpperCase() === 'COOL' ||
                value.toUpperCase() === 'HEAT' ||
                value.toUpperCase() === 'RANGE')) ||
            (key === 'target_temperature' &&
              this.#rawData[deviceUUID].value.eco_mode_state.ecoMode === 'ECO_MODE_INACTIVE' &&
              typeof value === 'number') ||
            (key === 'target_temperature_low' &&
              this.#rawData[deviceUUID].value.eco_mode_state.ecoMode === 'ECO_MODE_INACTIVE' &&
              typeof value === 'number') ||
            (key === 'target_temperature_high' &&
              this.#rawData[deviceUUID].value.eco_mode_state.ecoMode === 'ECO_MODE_INACTIVE' &&
              typeof value === 'number')
          ) {
            // Set either the 'mode' and/or non-eco temperatures on the target thermostat
            let coolingTarget = this.#rawData[deviceUUID].value.target_temperature_settings.targetTemperature.coolingTarget.value;
            let heatingTarget = this.#rawData[deviceUUID].value.target_temperature_settings.targetTemperature.heatingTarget.value;

            if (
              key === 'target_temperature_low' ||
              (key === 'target_temperature' &&
                this.#rawData[deviceUUID].value.target_temperature_settings.targetTemperature.setpointType === 'SET_POINT_TYPE_HEAT')
            ) {
              heatingTarget = value;
            }
            if (
              key === 'target_temperature_high' ||
              (key === 'target_temperature' &&
                this.#rawData[deviceUUID].value.target_temperature_settings.targetTemperature.setpointType === 'SET_POINT_TYPE_COOL')
            ) {
              coolingTarget = value;
            }

            protobufElement.traitId.traitLabel = 'target_temperature_settings';
            protobufElement.property.type_url = 'type.nestlabs.com/nest.trait.hvac.TargetTemperatureSettingsTrait';
            // eslint-disable-next-line no-undef
            protobufElement.property.value.targetTemperature = structuredClone(this.#rawData[deviceUUID].value.target_temperature_settings);
            protobufElement.property.value.targetTemperature.setpointType =
              key === 'hvac_mode' && value.toUpperCase() !== 'OFF'
                ? 'SET_POINT_TYPE_' + value.toUpperCase()
                : this.#rawData[deviceUUID].value.target_temperature_settings.targetTemperature.setpointType;
            protobufElement.property.value.targetTemperature.heatingTarget = { value: heatingTarget };
            protobufElement.property.value.targetTemperature.coolingTarget = { value: coolingTarget };
            protobufElement.property.value.targetTemperature.currentActorInfo = {
              method: 'HVAC_ACTOR_METHOD_IOS',
              originator: {
                resourceId: Object.keys(this.#rawData)
                  .filter((key) => key.includes('USER_'))
                  .toString(),
              },
              timeOfAction: { seconds: Math.floor(Date.now() / 1000), nanos: (Date.now() % 1000) * 1e6 },
              originatorRtsId: '',
            };
            protobufElement.property.value.targetTemperature.originalActorInfo = {
              method: 'HVAC_ACTOR_METHOD_UNSPECIFIED',
              originator: null,
              timeOfAction: null,
              originatorRtsId: '',
            };
            protobufElement.property.value.enabled = {
              value:
                key === 'hvac_mode'
                  ? value.toUpperCase() !== 'OFF'
                  : this.#rawData[deviceUUID].value.target_temperature_settings.enabled.value,
            };
          }

          if (
            (key === 'target_temperature' &&
              this.#rawData[deviceUUID].value.eco_mode_state.ecoMode !== 'ECO_MODE_INACTIVE' &&
              typeof value === 'number') ||
            (key === 'target_temperature_low' &&
              this.#rawData[deviceUUID].value.eco_mode_state.ecoMode !== 'ECO_MODE_INACTIVE' &&
              typeof value === 'number') ||
            (key === 'target_temperature_high' &&
              this.#rawData[deviceUUID].value.eco_mode_state.ecoMode !== 'ECO_MODE_INACTIVE' &&
              typeof value === 'number')
          ) {
            // Set eco mode temperatures on the target thermostat
            protobufElement.traitId.traitLabel = 'eco_mode_settings';
            protobufElement.property.type_url = 'type.nestlabs.com/nest.trait.hvac.EcoModeSettingsTrait';
            // eslint-disable-next-line no-undef
            protobufElement.property.value = structuredClone(this.#rawData[deviceUUID].value.eco_mode_settings);
            protobufElement.property.value.ecoTemperatureHeat.value.value =
              protobufElement.property.value.ecoTemperatureHeat.enabled === true &&
              protobufElement.property.value.ecoTemperatureCool.enabled === false
                ? value
                : protobufElement.property.value.ecoTemperatureHeat.value.value;
            protobufElement.property.value.ecoTemperatureCool.value.value =
              protobufElement.property.value.ecoTemperatureHeat.enabled === false &&
              protobufElement.property.value.ecoTemperatureCool.enabled === true
                ? value
                : protobufElement.property.value.ecoTemperatureCool.value.value;
            protobufElement.property.value.ecoTemperatureHeat.value.value =
              protobufElement.property.value.ecoTemperatureHeat.enabled === true &&
              protobufElement.property.value.ecoTemperatureCool.enabled === true &&
              key === 'target_temperature_low'
                ? value
                : protobufElement.property.value.ecoTemperatureHeat.value.value;
            protobufElement.property.value.ecoTemperatureCool.value.value =
              protobufElement.property.value.ecoTemperatureHeat.enabled === true &&
              protobufElement.property.value.ecoTemperatureCool.enabled === true &&
              key === 'target_temperature_high'
                ? value
                : protobufElement.property.value.ecoTemperatureCool.value.value;
          }

          if (key === 'temperature_scale' && typeof value === 'string' && (value.toUpperCase() === 'C' || value.toUpperCase() === 'F')) {
            // Set the temperature scale on the target thermostat
            protobufElement.traitId.traitLabel = 'display_settings';
            protobufElement.property.type_url = 'type.nestlabs.com/nest.trait.hvac.DisplaySettingsTrait';
            // eslint-disable-next-line no-undef
            protobufElement.property.value = structuredClone(this.#rawData[deviceUUID].value.display_settings);
            protobufElement.property.value.temperatureScale = value.toUpperCase() === 'F' ? 'TEMPERATURE_SCALE_F' : 'TEMPERATURE_SCALE_C';
          }

          if (key === 'temperature_lock' && typeof value === 'boolean') {
            // Set lock mode on the target thermostat
            protobufElement.traitId.traitLabel = 'temperature_lock_settings';
            protobufElement.property.type_url = 'type.nestlabs.com/nest.trait.hvac.TemperatureLockSettingsTrait';
            // eslint-disable-next-line no-undef
            protobufElement.property.value = structuredClone(this.#rawData[deviceUUID].value.temperature_lock_settings);
            protobufElement.property.value.enabled = value === true;
          }

          if (key === 'fan_state' && typeof value === 'boolean') {
            // Set fan mode on the target thermostat
            let endTime =
              value === true
                ? Math.floor(Date.now() / 1000) + this.#rawData[deviceUUID].value.fan_control_settings.timerDuration.seconds
                : 0;

            protobufElement.traitId.traitLabel = 'fan_control_settings';
            protobufElement.property.type_url = 'type.nestlabs.com/nest.trait.hvac.FanControlSettingsTrait';
            // eslint-disable-next-line no-undef
            protobufElement.property.value = structuredClone(this.#rawData[deviceUUID].value.fan_control_settings);
            protobufElement.property.value.timerEnd = { seconds: endTime, nanos: (endTime % 1000) * 1e6 };
          }

          //if (key === 'statusled.brightness'
          //if (key === 'irled.state'

          if (key === 'streaming.enabled' && typeof value === 'boolean') {
            // Turn camera video on/off
            protobufElement.traitId.traitLabel = 'recording_toggle_settings';
            protobufElement.property.type_url = 'type.nestlabs.com/nest.trait.product.camera.RecordingToggleSettingsTrait';
            // eslint-disable-next-line no-undef
            protobufElement.property.value = structuredClone(this.#rawData[deviceUUID].value.recording_toggle_settings);
            protobufElement.property.value.targetCameraState = value === true ? 'CAMERA_ON' : 'CAMERA_OFF';
            protobufElement.property.value.changeModeReason = 2;
            protobufElement.property.value.settingsUpdated = { seconds: Math.floor(Date.now() / 1000), nanos: (Date.now() % 1000) * 1e6 };
          }

          if (key === 'watermark.enabled' && typeof value === 'boolean') {
            // Unsupported via protobuf?
          }

          if (key === 'audio.enabled' && typeof value === 'boolean') {
            // Enable/disable microphone on camera/doorbell
            protobufElement.traitId.traitLabel = 'microphone_settings';
            protobufElement.property.type_url = 'type.nestlabs.com/nest.trait.audio.MicrophoneSettingsTrait';
            // eslint-disable-next-line no-undef
            protobufElement.property.value = structuredClone(this.#rawData[deviceUUID].value.microphone_settings);
            protobufElement.property.value.enableMicrophone = value;
          }

          if (key === 'doorbell.indoor_chime.enabled' && typeof value === 'boolean') {
            // Enable/disable chime status on doorbell
            protobufElement.traitId.traitLabel = 'doorbell_indoor_chime_settings';
            protobufElement.property.type_url = 'type.nestlabs.com/nest.trait.product.doorbell.DoorbellIndoorChimeSettingsTrait';
            // eslint-disable-next-line no-undef
            protobufElement.property.value = structuredClone(this.#rawData[deviceUUID].value.doorbell_indoor_chime_settings);
            protobufElement.property.value.chimeEnabled = value;
          }

          if (protobufElement.traitId.traitLabel === '' || protobufElement.property.type_url === '') {
            this.platorm.log.debug('Unknown protobuf set key for device', deviceUUID, key, value);
          }

          if (protobufElement.traitId.traitLabel !== '' && protobufElement.property.type_url !== '') {
            let trait = this.#connections[connectionType].protobufRoot.lookup(protobufElement.property.type_url.split('/')[1]);
            protobufElement.property.value = trait.encode(trait.fromObject(protobufElement.property.value)).finish();
            // eslint-disable-next-line no-undef
            setDataToEncode.push(structuredClone(protobufElement));
          }
        }),
      );

      if (setDataToEncode.length !== 0) {
        let encodedData = TraitMap.encode(TraitMap.fromObject({ set: setDataToEncode })).finish();
        let request = {
          method: 'post',
          url: 'https://' + this.#connections[connectionType].protobufAPIHost + '/nestlabs.gateway.v1.TraitBatchApi/BatchUpdateState',
          headers: {
            'User-Agent': USERAGENT,
            Authorization: 'Basic ' + this.#connections[connectionType].token,
            'Content-Type': 'application/x-protobuf',
            'X-Accept-Content-Transfer-Encoding': 'binary',
            'X-Accept-Response-Streaming': 'true',
          },
          data: encodedData,
        };
        axios(request)
          .then((response) => {
            if (typeof response.status !== 'number' || response.status !== 200) {
              throw new Error('Protobuf API trait update failed');
            }
          })
          .catch(() => {
            this?.log?.debug && this.log.debug('Protobuf API trait update for failed for uuid "%s"', deviceUUID);
          });
      }
    }

    if (this.#rawData[deviceUUID]?.source === NestAccfactory.DataSource.REST && deviceUUID.startsWith('quartz.') === true) {
      // Set value on Nest Camera/Doorbell
      await Promise.all(
        Object.entries(values).map(async ([key, value]) => {
          let request = {
            method: 'post',
            url: 'https://webapi.' + this.#connections[connectionType].cameraAPIHost + '/api/dropcams.set_properties',
            headers: {
              referer: 'https://' + this.#connections[connectionType].referer,
              'User-Agent': USERAGENT,
              'content-type': 'application/x-www-form-urlencoded',
              [this.#connections[connectionType].cameraAPI.key]:
                this.#connections[connectionType].cameraAPI.value + this.#connections[connectionType].cameraAPI.token,
            },
            responseType: 'json',
            timeout: NESTAPITIMEOUT,
            data: [key] + '=' + value + '&uuid=' + deviceUUID.split('.')[1],
          };
          await axios(request)
            .then((response) => {
              if (
                typeof response.status !== 'number' ||
                response.status !== 200 ||
                typeof response.data.status !== 'number' ||
                response.data.status !== 0
              ) {
                throw new Error('REST Camera API update for failed');
              }
            })
            .catch(() => {
              this?.log?.debug && this.log.debug('REST Camera API update for failed for uuid "%s"', deviceUUID);
            });
        }),
      );
    }

    if (this.#rawData[deviceUUID]?.source === NestAccfactory.DataSource.REST && deviceUUID.startsWith('quartz.') === false) {
      // set values on other Nest devices besides cameras/doorbells
      await Promise.all(
        Object.entries(values).map(async ([key, value]) => {
          let restAPIJSONData = { objects: [] };

          if (deviceUUID.startsWith('device.') === false) {
            restAPIJSONData.objects.push({ object_key: deviceUUID, op: 'MERGE', value: { [key]: value } });
          }

          // Some elements when setting thermostat data are located in a different object locations than with the device object
          // Handle this scenario below
          if (deviceUUID.startsWith('device.') === true) {
            let RESTStructureUUID = deviceUUID;

            if (
              (key === 'hvac_mode' &&
                typeof value === 'string' &&
                (value.toUpperCase() === 'OFF' ||
                  value.toUpperCase() === 'COOL' ||
                  value.toUpperCase() === 'HEAT' ||
                  value.toUpperCase() === 'RANGE')) ||
              (key === 'target_temperature' && typeof value === 'number') ||
              (key === 'target_temperature_low' && typeof value === 'number') ||
              (key === 'target_temperature_high' && typeof value === 'number')
            ) {
              RESTStructureUUID = 'shared.' + deviceUUID.split('.')[1];
            }
            restAPIJSONData.objects.push({ object_key: RESTStructureUUID, op: 'MERGE', value: { [key]: value } });
          }

          if (restAPIJSONData.objects.length !== 0) {
            let request = {
              method: 'post',
              url: this.#connections[connectionType].transport_url + '/v5/put',
              responseType: 'json',
              headers: {
                'User-Agent': USERAGENT,
                Authorization: 'Basic ' + this.#connections[connectionType].token,
              },
              data: JSON.stringify(restAPIJSONData),
            };
            await axios(request)
              .then(async (response) => {
                if (typeof response.status !== 'number' || response.status !== 200) {
                  throw new Error('REST API update for failed');
                }
              })
              .catch(() => {
                this?.log?.debug && this.log.debug('REST API update for failed for uuid "%s"', deviceUUID);
              });
          }
        }),
      );
    }
  }

  async #get(connectionType, deviceUUID, values) {
    // <--- Yet to implement
    this?.log?.debug && this.log.debug('function get was called with', connectionType, deviceUUID, values);
  }

  async #getWeatherData(connectionType, deviceUUID, latitude, longitude) {
    let weatherData = {};
    if (typeof this.#rawData[deviceUUID]?.value?.weather === 'object') {
      weatherData = this.#rawData[deviceUUID].value.weather;
    }

    let request = {
      method: 'get',
      url: this.#connections[connectionType].weather_url + latitude + ',' + longitude,
      headers: {
        'User-Agent': USERAGENT,
      },
      responseType: 'json',
      timeout: NESTAPITIMEOUT,
    };
    await axios(request)
      .then((response) => {
        if (typeof response.status !== 'number' || response.status !== 200) {
          throw new Error('REST Weather API retrieving details failed');
        }

        if (typeof response.data[latitude + ',' + longitude].current === 'object') {
          // Store the lat/long details in the weather data object
          weatherData.latitude = latitude;
          weatherData.longitude = longitude;

          // Update weather data object
          weatherData.current_temperature = adjustTemperature(response.data[latitude + ',' + longitude].current.temp_c, 'C', 'C', false);
          weatherData.current_humidity = response.data[latitude + ',' + longitude].current.humidity;
          weatherData.condition = response.data[latitude + ',' + longitude].current.condition;
          weatherData.wind_direction = response.data[latitude + ',' + longitude].current.wind_dir;
          weatherData.wind_speed = response.data[latitude + ',' + longitude].current.wind_mph * 1.609344; // convert to km/h
          weatherData.sunrise = response.data[latitude + ',' + longitude].current.sunrise;
          weatherData.sunset = response.data[latitude + ',' + longitude].current.sunset;
          weatherData.station = response.data[latitude + ',' + longitude].location.short_name;
          weatherData.forecast = response.data[latitude + ',' + longitude].forecast.daily[0].condition;
        }
      })
      .catch(() => {
        this?.log?.debug && this.log.debug('REST Weather API retrieving details failed');
      });
    return weatherData;
  }
}

// General helper functions which don't need to be part of an object class
function adjustTemperature(temperature, currentTemperatureUnit, targetTemperatureUnit, round) {
  // Converts temperatures between C/F and vice-versa
  // Also rounds temperatures to 0.5 increments for C and 1.0 for F
  if (targetTemperatureUnit.toUpperCase() === 'C') {
    if (currentTemperatureUnit.toUpperCase() === 'F') {
      // convert from F to C
      temperature = ((temperature - 32) * 5) / 9;
    }
    if (round === true) {
      // round to nearest 0.5C
      temperature = Math.round(temperature * 2) * 0.5;
    }
  }

  if (targetTemperatureUnit.toUpperCase() === 'F') {
    if (currentTemperatureUnit.toUpperCase() === 'C') {
      // convert from C to F
      temperature = (temperature * 9) / 5 + 32;
    }
    if (round === true) {
      // round to nearest 1F
      temperature = Math.round(temperature);
    }
  }

  return temperature;
}

function makeHomeKitName(nameToMakeValid) {
  // Strip invalid characters to meet HomeKit naming requirements
  // Ensure only letters or numbers are at the beginning AND/OR end of string
  // Matches against uni-code characters
  return nameToMakeValid
    .replace(/[^\p{L}\p{N}\p{Z}\u2019.,-]/gu, '')
    .replace(/^[^\p{L}\p{N}]*/gu, '')
    .replace(/[^\p{L}\p{N}]+$/gu, '');
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

  let crc24 = 0xb704ce; // init crc24 hash;
  valueToHash = Buffer.from(valueToHash); // convert value into buffer for processing
  for (let index = 0; index < valueToHash.length; index++) {
    crc24 = (crc24HashTable[((crc24 >> 16) ^ valueToHash[index]) & 0xff] ^ (crc24 << 8)) & 0xffffff;
  }
  return crc24.toString(16); // return crc24 as hex string
}

function scaleValue(value, sourceRangeMin, sourceRangeMax, targetRangeMin, targetRangeMax) {
  if (value < sourceRangeMin) {
    value = sourceRangeMin;
  }
  if (value > sourceRangeMax) {
    value = sourceRangeMax;
  }
  return ((value - sourceRangeMin) * (targetRangeMax - targetRangeMin)) / (sourceRangeMax - sourceRangeMin) + targetRangeMin;
}
