// Nest System communications
// Part of homebridge-nest-accfactory
//
// Code version 2025.06.16
// Mark Hulskamp
'use strict';

// Define external module requirements
import protobuf from 'protobufjs';

// Define nodejs module requirements
import EventEmitter from 'node:events';
import { Buffer } from 'node:buffer';
import { setInterval, clearInterval, setTimeout, clearTimeout } from 'node:timers';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Import our modules
import HomeKitDevice from './HomeKitDevice.js';
import { DEVICE_TYPE, loadDeviceModules, getDeviceHKCategory } from './devices.js';
import { ACCOUNT_TYPE, processConfig, buildConnections } from './config.js';

// Define constants
const CAMERA_ALERT_POLLING = 2000; // Camera alerts polling timer
const CAMERA_ZONE_POLLING = 30000; // Camera zones changes polling timer
const WEATHER_POLLING = 300000; // Weather data polling timer
const NEST_API_TIMEOUT = 10000; // Nest API timeout
const USER_AGENT = 'Nest/5.78.0 (iOScom.nestlabs.jasper.release) os=18.0'; // User Agent string
const __dirname = path.dirname(fileURLToPath(import.meta.url)); // Make a defined for JS __dirname
const DATASOURCE = {
  NEST_API: 'Nest', // From the Nest API
  PROTOBUF_API: 'Protobuf', // From the Protobuf API
};

// We handle the connections to Nest/Google
// Perform device management (additions/removals/updates)
export default class NestAccfactory {
  cachedAccessories = []; // Track restored cached accessories

  // Internal data only for this class
  #connections = undefined; // Object of confirmed connections
  #rawData = {}; // Cached copy of data from both Nest and Protobuf APIs
  #eventEmitter = new EventEmitter(); // Used for object messaging from this platform
  #protobufRoot = null; // Protobuf loaded protos
  #trackedDevices = {}; // Object of devices we've created. used to track data source type, comms uuid. key'd by serial #
  #deviceModules = undefined; // No loaded device support modules to start

  constructor(log, config, api, eventEmitter) {
    // If no explicit event emitter was passed, and the api is an EventEmitter (e.g., in Homebridge),
    // we'll treat it as the source for lifecycle messages like didFinishLaunching/shutdown in this constructor
    if (api instanceof EventEmitter && eventEmitter === undefined) {
      eventEmitter = api;
    }

    this.log = log;
    this.api = api;

    // Perform validation on the configuration passed into us and set defaults if not present
    this.config = processConfig(config, this.log);
    this.#connections = buildConnections(this.config);

    // Check for valid connections, either a Nest and/or Google one specified. Otherwise, return back.
    if (Object.keys(this.#connections).length === 0) {
      this?.log?.error?.('No connections have been specified in the JSON configuration. Please review');
      return;
    }

    eventEmitter?.on?.('didFinishLaunching', async () => {
      // We got notified that Homebridge (or Docker) has finished loading

      // Load device support modules from the plugins folder if not already done
      this.#deviceModules = await loadDeviceModules(this.log, 'plugins');

      // Start reconnect loop per connection with backoff for failed tries
      // This also initiates both Nest and Protobuf subscribes
      for (const uuid of Object.keys(this.#connections)) {
        let reconnectDelay = 15000;

        const reconnectLoop = async () => {
          if (this.#connections?.[uuid]?.authorised === false) {
            try {
              await this.#connect(uuid);
              this.#subscribeNest(uuid, true);
              this.#subscribeProtobuf(uuid, true);
              // eslint-disable-next-line no-unused-vars
            } catch (error) {
              // Empty
            }

            reconnectDelay = this.#connections?.[uuid]?.authorised === true ? 15000 : Math.min(reconnectDelay * 2, 60000);
          } else {
            reconnectDelay = 15000;
          }

          setTimeout(reconnectLoop, reconnectDelay);
        };

        reconnectLoop();
      }
    });

    eventEmitter?.on?.('shutdown', async () => {
      // We got notified that Homebridge is shutting down
      // Perform cleanup of internal state
      this.#eventEmitter?.removeAllListeners();

      Object.values(this.#trackedDevices).forEach((device) => {
        Object.values(device?.timers || {}).forEach((timer) => clearInterval(timer));
      });

      this.#trackedDevices = {};
      this.#rawData = {};
      this.#protobufRoot = null;
      this.#eventEmitter = undefined;
    });

    // Setup event listeners for set/get calls from devices if not already done so
    this.#eventEmitter.addListener(HomeKitDevice.SET, (uuid, values) => {
      this.#set(values);
    });

    this.#eventEmitter.addListener(HomeKitDevice.GET, async (uuid, values) => {
      let results = await this.#get(values);
      // Send the results back to the device via a special event (only if still active)
      this.#eventEmitter?.emit?.(HomeKitDevice.GET + '->' + uuid, results);
    });
  }

  configureAccessory(accessory) {
    // This gets called from Homebridge each time it restores an accessory from its cache
    this?.log?.info?.('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache, so we can track if it has already been registered
    this.cachedAccessories.push(accessory);
  }

  async #connect(uuid) {
    if (typeof this.#connections?.[uuid] === 'object') {
      this?.log?.info?.(
        'Performing authorisation for connection "%s" %s',
        this.#connections[uuid].name,
        this.#connections[uuid].fieldTest === true ? 'using field test endpoints' : '',
      );
      if (this.#connections[uuid].type === ACCOUNT_TYPE.GOOGLE) {
        // Google cookie method as refresh token method no longer supported by Google since October 2022
        // Instructions from homebridge_nest or homebridge_nest_cam to obtain this
        this?.log?.debug?.('Performing authorisation using Google account for connection uuid "%s"', uuid);

        await fetchWrapper('get', this.#connections[uuid].issuetoken, {
          headers: {
            referer: 'https://accounts.google.com/o/oauth2/iframe',
            'User-Agent': USER_AGENT,
            cookie: this.#connections[uuid].cookie,
            'Sec-Fetch-Mode': 'cors',
            'X-Requested-With': 'XmlHttpRequest',
          },
        })
          .then((response) => response.json())
          .then(async (data) => {
            let googleOAuth2Token = data.access_token;

            await fetchWrapper(
              'post',
              'https://nestauthproxyservice-pa.googleapis.com/v1/issue_jwt',
              {
                headers: {
                  referer: 'https://' + this.#connections[uuid].referer,
                  'User-Agent': USER_AGENT,
                  Authorization: data.token_type + ' ' + data.access_token,
                  'Content-Type': 'application/x-www-form-urlencoded',
                },
              },
              'embed_google_oauth_access_token=true&expire_after=3600s&google_oauth_access_token=' +
                data.access_token +
                '&policy_id=authproxy-oauth-policy',
            )
              .then((response) => response.json())
              .then(async (data) => {
                let googleToken = data.jwt;
                let tokenExpire = Math.floor(new Date(data.claims.expirationTime).valueOf() / 1000); // Token expiry, should be 1hr

                await fetchWrapper('get', 'https://' + this.#connections[uuid].restAPIHost + '/session', {
                  headers: {
                    referer: 'https://' + this.#connections[uuid].referer,
                    'User-Agent': USER_AGENT,
                    Authorization: 'Basic ' + googleToken,
                  },
                })
                  .then((response) => response.json())
                  .then((data) => {
                    // Store successful connection details
                    this.#connections[uuid].authorised = true;
                    this.#connections[uuid].userID = data.userid;
                    this.#connections[uuid].transport_url = data.urls.transport_url;
                    this.#connections[uuid].weather_url = data.urls.weather_url;
                    this.#connections[uuid].token = googleToken;
                    this.#connections[uuid].cameraAPI = {
                      key: 'Authorization',
                      value: 'Basic ', // NOTE: extra space required
                      token: googleToken,
                      oauth2: googleOAuth2Token,
                      fieldTest: this.#connections[uuid]?.fieldTest === true,
                    };

                    // Set timeout for token expiry refresh
                    clearTimeout(this.#connections[uuid].timer);
                    this.#connections[uuid].timer = setTimeout(
                      () => {
                        this?.log?.info?.('Performing periodic token refresh for connection "%s"', this.#connections[uuid].name);
                        this.#connect(uuid);
                      },
                      (tokenExpire - Math.floor(Date.now() / 1000) - 60) * 1000,
                    ); // Refresh just before token expiry

                    this?.log?.success?.('Successfully authorised connection "%s"', this.#connections[uuid].name);
                  });
              });
          })
          // eslint-disable-next-line no-unused-vars
          .catch((error) => {
            // The token we used to obtained a Nest session failed, so overall authorisation failed
            this.#connections[uuid].authorised = false;
            this?.log?.debug?.('Failed to connect using credential details for connection uuid "%s"', uuid);
            this?.log?.error?.('Authorisation failed on connection "%s"', this.#connections[uuid].name);
          });
      }

      if (this.#connections[uuid].type === ACCOUNT_TYPE.NEST) {
        // Nest access token method. Get WEBSITE2 cookie for use with camera API calls if needed later
        this?.log?.debug?.('Performing authorisation using Nest account for connection uuid "%s"', uuid);

        await fetchWrapper(
          'post',
          'https://webapi.' + this.#connections[uuid].cameraAPIHost + '/api/v1/login.login_nest',
          {
            withCredentials: true,
            headers: {
              referer: 'https://' + this.#connections[uuid].referer,
              'User-Agent': USER_AGENT,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          },
          Buffer.from('access_token=' + this.#connections[uuid].access_token, 'utf8'),
        )
          .then((response) => response.json())
          .then(async (data) => {
            if (data?.items?.[0]?.session_token === undefined) {
              throw new Error('No Nest session token was obtained');
            }

            let nestToken = data.items[0].session_token;

            await fetchWrapper('get', 'https://' + this.#connections[uuid].restAPIHost + '/session', {
              headers: {
                referer: 'https://' + this.#connections[uuid].referer,
                'User-Agent': USER_AGENT,
                Authorization: 'Basic ' + this.#connections[uuid].access_token,
              },
            })
              .then((response) => response.json())
              .then((data) => {
                // Store successful connection details
                this.#connections[uuid].authorised = true;
                this.#connections[uuid].userID = data.userid;
                this.#connections[uuid].transport_url = data.urls.transport_url;
                this.#connections[uuid].weather_url = data.urls.weather_url;
                this.#connections[uuid].token = this.#connections[uuid].access_token;
                this.#connections[uuid].cameraAPI = {
                  key: 'cookie',
                  value: this.#connections[uuid].fieldTest === true ? 'website_ft=' : 'website_2=',
                  token: nestToken,
                  fieldTest: this.#connections[uuid]?.fieldTest === true,
                };

                // Set timeout for token expiry refresh
                clearTimeout(this.#connections[uuid].timer);
                this.#connections[uuid].timer = setTimeout(
                  () => {
                    this?.log?.info?.('Performing periodic token refresh for connection "%s"', this.#connections[uuid].name);
                    this.#connect(uuid);
                  },
                  1000 * 3600 * 24,
                ); // Refresh token every 24hrs

                this?.log?.success?.('Successfully authorised connection "%s"', this.#connections[uuid].name);
              });
          })
          // eslint-disable-next-line no-unused-vars
          .catch((error) => {
            // The token we used to obtained a Nest session failed, so overall authorisation failed
            this.#connections[uuid].authorised = false;
            this?.log?.debug?.('Failed to connect using credential details for connection uuid "%s"', uuid);
            this?.log?.error?.('Authorisation failed on connection "%s"', this.#connections[uuid].name);
          });
      }
    }
  }

  async #subscribeNest(uuid, fullRefresh) {
    if (
      typeof this.#connections?.[uuid] !== 'object' ||
      this.#connections?.[uuid]?.authorised === false ||
      this.config?.options?.useNestAPI === false
    ) {
      // Not a valid connection object and/or we're not authorised
      return;
    }

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
      'occupancy',
    ];

    // By default, setup for a full data read from the Nest API
    let subscribeURL = 'https://' + this.#connections[uuid].restAPIHost + '/api/0.1/user/' + this.#connections[uuid].userID + '/app_launch';
    let subscribeJSONData = { known_bucket_types: REQUIREDBUCKETS, known_bucket_versions: [] };

    if (fullRefresh === false) {
      // We have data stored from this Nest API, so setup read using known object
      subscribeURL = this.#connections[uuid].transport_url + '/v6/subscribe';
      subscribeJSONData = { objects: [] };
      Object.entries(this.#rawData)
        // eslint-disable-next-line no-unused-vars
        .filter(([object_key, object]) => object.source === DATASOURCE.NEST_API && object.connection === uuid)
        .forEach(([object_key, object]) => {
          subscribeJSONData.objects.push({
            object_key: object_key,
            object_revision: object.object_revision,
            object_timestamp: object.object_timestamp,
          });
        });
    }

    if (fullRefresh === true) {
      this?.log?.debug?.('Starting Nest API subscribe for connection uuid "%s"', uuid);
    }

    fetchWrapper(
      'post',
      subscribeURL,
      {
        headers: {
          referer: 'https://' + this.#connections[uuid].referer,
          'User-Agent': USER_AGENT,
          Authorization: 'Basic ' + this.#connections[uuid].token,
        },
        keepalive: true,
        //timeout: (5 * 60000),
      },
      JSON.stringify(subscribeJSONData),
    )
      .then((response) => response.json())
      .then(async (data) => {
        if (typeof data?.updated_buckets === 'object') {
          // This response is full data read
          data = data.updated_buckets;
        }
        if (typeof data?.objects === 'object') {
          // This response contains subscribed data updates
          data = data.objects;
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
              value.value.weather = await this.#getWeather(uuid, value.object_key, value.value.latitude, value.value.longitude);

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

              try {
                let response = await fetchWrapper(
                  'get',
                  'https://webapi.' +
                    this.#connections[uuid].cameraAPIHost +
                    '/api/cameras.get_with_properties?uuid=' +
                    value.object_key.split('.')[1],
                  {
                    headers: {
                      referer: 'https://' + this.#connections[uuid].referer,
                      'User-Agent': USER_AGENT,
                      [this.#connections[uuid].cameraAPI.key]:
                        this.#connections[uuid].cameraAPI.value + this.#connections[uuid].cameraAPI.token,
                    },
                    timeout: NEST_API_TIMEOUT,
                  },
                );
                let data = await response.json();
                value.value.properties = data.items[0].properties;
              } catch (error) {
                if (error?.cause !== undefined && String(error.cause).toUpperCase().includes('TIMEOUT') === false) {
                  this?.log?.debug?.(
                    'Nest API had error retrieving camera/doorbell details during subscribe. Error was "%s"',
                    error?.code ?? String(error),
                  );
                }
              }

              value.value.activity_zones =
                typeof this.#rawData[value.object_key]?.value?.activity_zones === 'object'
                  ? this.#rawData[value.object_key].value.activity_zones
                  : [];

              try {
                let response = await fetchWrapper(
                  'get',
                  value.value.nexus_api_http_server_url + '/cuepoint_category/' + value.object_key.split('.')[1],
                  {
                    headers: {
                      referer: 'https://' + this.#connections[uuid].referer,
                      'User-Agent': USER_AGENT,
                      [this.#connections[uuid].cameraAPI.key]:
                        this.#connections[uuid].cameraAPI.value + this.#connections[uuid].cameraAPI.token,
                    },
                    timeout: NEST_API_TIMEOUT,
                  },
                );
                let data = await response.json();
                value.value.activity_zones = data
                  .filter((zone) => zone?.type?.toUpperCase() === 'ACTIVITY' || zone?.type?.toUpperCase() === 'REGION')
                  .map((zone) => ({
                    id: zone.id === 0 ? 1 : zone.id,
                    name: HomeKitDevice.makeValidHKName(zone.label),
                    hidden: zone.hidden === true,
                    uri: zone.nexusapi_image_uri,
                  }));
              } catch (error) {
                if (error?.cause !== undefined && String(error.cause).toUpperCase().includes('TIMEOUT') === false) {
                  this?.log?.debug?.(
                    'Nest API had error retrieving camera/doorbell activity zones during subscribe. Error was "%s"',
                    error?.code ?? String(error),
                  );
                }
              }
            }

            if (value.object_key.startsWith('buckets.') === true) {
              if (
                typeof this.#rawData[value.object_key] === 'object' &&
                typeof this.#rawData[value.object_key].value?.buckets === 'object'
              ) {
                // Check for added objects
                value.value.buckets.map((object_key) => {
                  if (this.#rawData[value.object_key].value.buckets.includes(object_key) === false) {
                    // Since this is an added object to the raw Nest API structure, we need to do a full read of the data
                    fullRefresh = true;
                  }
                });

                // Check for removed objects
                this.#rawData[value.object_key].value.buckets.map((object_key) => {
                  if (value.value.buckets.includes(object_key) === false) {
                    // Object is present in the old buckets list, but not in the new buckets list
                    // so we assume it has been removed
                    // It also could mean device(s) have been removed from Nest
                    if (
                      object_key.startsWith('structure.') === true ||
                      object_key.startsWith('device.') === true ||
                      object_key.startsWith('kryptonite.') === true ||
                      object_key.startsWith('topaz.') === true ||
                      object_key.startsWith('quartz.') === true
                    ) {
                      // Tidy up tracked devices since this one is removed
                      if (this.#trackedDevices[this.#rawData?.[object_key]?.value?.serial_number] !== undefined) {
                        // Remove any active running timers we have for this device
                        Object.values(this.#trackedDevices[this.#rawData[object_key].value.serial_number].timers).forEach((timers) => {
                          clearInterval(timers);
                        });

                        // Send removed notice onto HomeKit device for it to process
                        this.#eventEmitter?.emit?.(
                          this.#trackedDevices[this.#rawData[object_key].value.serial_number].uuid,
                          HomeKitDevice.REMOVE,
                          {},
                        );

                        // Finally, remove from tracked devices
                        delete this.#trackedDevices[this.#rawData[object_key].value.serial_number];
                      }
                    }
                    delete this.#rawData[object_key];
                  }
                });
              }
            }

            // Store or update the date in our internally saved raw Nest API data
            if (typeof this.#rawData[value.object_key] === 'undefined') {
              this.#rawData[value.object_key] = {};
              this.#rawData[value.object_key].object_revision = value.object_revision;
              this.#rawData[value.object_key].object_timestamp = value.object_timestamp;
              this.#rawData[value.object_key].connection = uuid;
              this.#rawData[value.object_key].source = DATASOURCE.NEST_API;
              this.#rawData[value.object_key].value = {};
            }

            // Finally, update our internal raw Nest API data with the new values
            this.#rawData[value.object_key].object_revision = value.object_revision; // Used for future subscribes
            this.#rawData[value.object_key].object_timestamp = value.object_timestamp; // Used for future subscribes
            for (const [fieldKey, fieldValue] of Object.entries(value.value)) {
              this.#rawData[value.object_key]['value'][fieldKey] = fieldValue;
            }
          }),
        );

        await this.#processPostSubscribe();
      })
      .catch((error) => {
        if (
          error?.cause === undefined ||
          (typeof error.cause === 'object' && String(error.cause).toUpperCase().includes('TIMEOUT') === false)
        ) {
          this?.log?.debug?.(
            'Nest API had an error performing subscription with connection uuid "%s"',
            uuid,
            error?.message ?? String(error),
          );
          this?.log?.debug?.('Restarting Nest API subscription for connection uuid "%s"', uuid);
        }
      })
      .finally(() => {
        setTimeout(() => this.#subscribeNest(uuid, fullRefresh), 1000);
      });
  }

  async #subscribeProtobuf(uuid, firstRun) {
    if (
      typeof this.#connections?.[uuid] !== 'object' ||
      this.#connections?.[uuid]?.authorised === false ||
      this.config?.options?.useGoogleAPI === false
    ) {
      // Not a valid connection object and/or we're not authorised
      return;
    }

    const calculate_message_size = (inputBuffer) => {
      let varint = 0;
      let shift = 0;

      for (let i = 1; i <= 5; i++) {
        // Start at index 1 (skip tag byte)
        let byte = inputBuffer[i];
        varint |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) {
          return varint + i + 1; // +1 to include initial tag byte
        }
        shift += 7;
      }

      throw new Error('VarInt exceeds allowed bounds.');
    };

    const traverseTypes = (trait, callback) => {
      if (trait instanceof protobuf.Type === true) {
        callback(trait);
      }

      for (const nested of trait && trait.nestedArray ? trait.nestedArray : []) {
        traverseTypes(nested, callback);
      }
    };

    // Attempt to load in protobuf files if not already done so
    if (this.#protobufRoot === null && fs.existsSync(path.resolve(__dirname + '/protobuf/root.proto')) === true) {
      protobuf.util.Long = null;
      protobuf.configure();
      this.#protobufRoot = protobuf.loadSync(path.resolve(__dirname + '/protobuf/root.proto'));
      if (this.#protobufRoot !== null) {
        this?.log?.debug?.('Loaded protobuf support files for Protobuf API');
      }
    }

    if (this.#protobufRoot === null) {
      this?.log?.warn?.('Failed to loaded Protobuf API support files. This will cause certain Nest/Google devices to be un-supported');
      return;
    }

    // We have loaded Protobuf proto files, so now dynamically build the 'observe' post body data
    let observeTraitsList = [];
    let observeBody = Buffer.alloc(0);
    let traitTypeObserveParam = this.#protobufRoot.lookup('nestlabs.gateway.v2.TraitTypeObserveParams');
    let observeRequest = this.#protobufRoot.lookup('nestlabs.gateway.v2.ObserveRequest');
    if (traitTypeObserveParam !== null && observeRequest !== null) {
      traverseTypes(this.#protobufRoot, (type) => {
        // We only want to have certain trait 'families' in our observe reponse we are building
        // This also depends on the account type we connected with
        // Nest accounts cannot observe camera/doorbell product traits
        if (
          (this.#connections[uuid].type === ACCOUNT_TYPE.NEST &&
            type.fullName.startsWith('.nest.trait.product.camera') === false &&
            type.fullName.startsWith('.nest.trait.product.doorbell') === false &&
            (type.fullName.startsWith('.nest.trait') === true || type.fullName.startsWith('.weave.') === true)) ||
          (this.#connections[uuid].type === ACCOUNT_TYPE.GOOGLE &&
            (type.fullName.startsWith('.nest.trait') === true ||
              type.fullName.startsWith('.weave.') === true ||
              type.fullName.startsWith('.google.trait.product.camera') === true))
        ) {
          observeTraitsList.push(traitTypeObserveParam.create({ traitType: type.fullName.replace(/^\.*|\.*$/g, '') }));
        }
      });
      observeBody = observeRequest.encode(observeRequest.create({ stateTypes: [1, 2], traitTypeParams: observeTraitsList })).finish();
    }

    if (firstRun === true) {
      this?.log?.debug?.('Starting Protobuf API trait observe for connection uuid "%s"', uuid);
    }

    fetchWrapper(
      'post',
      'https://' + this.#connections[uuid].protobufAPIHost + '/nestlabs.gateway.v2.GatewayService/Observe',
      {
        headers: {
          referer: 'https://' + this.#connections[uuid].referer,
          'User-Agent': USER_AGENT,
          Authorization: 'Basic ' + this.#connections[uuid].token,
          'Content-Type': 'application/x-protobuf',
          'X-Accept-Content-Transfer-Encoding': 'binary',
          'X-Accept-Response-Streaming': 'true',
        },
        keepalive: true,
        //timeout: (5 * 60000),
      },
      observeBody,
    )
      .then((response) => response.body)
      .then(async (data) => {
        let buffer = Buffer.alloc(0);
        for await (const chunk of data) {
          buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
          let messageSize = calculate_message_size(buffer);
          if (buffer.length >= messageSize) {
            let decodedMessage = {};
            try {
              // Attempt to decode the Protobuf message(s) we extracted from the stream and get a JSON object representation
              decodedMessage = this.#protobufRoot
                .lookup('nestlabs.gateway.v2.ObserveResponse')
                .decode(buffer.subarray(0, messageSize))
                .toJSON();

              // Tidy up our received messages. This ensures we only have one status for the trait in the data we process
              // We'll favour a trait with accepted status over the same with confirmed status
              if (decodedMessage?.observeResponse?.[0]?.traitStates !== undefined) {
                let notAcceptedStatus = decodedMessage.observeResponse[0].traitStates.filter(
                  (trait) => trait.stateTypes.includes('ACCEPTED') === false,
                );
                let acceptedStatus = decodedMessage.observeResponse[0].traitStates.filter(
                  (trait) => trait.stateTypes.includes('ACCEPTED') === true,
                );
                let difference = acceptedStatus.map((trait) => trait.traitId.resourceId + '/' + trait.traitId.traitLabel);
                decodedMessage.observeResponse[0].traitStates =
                  ((notAcceptedStatus = notAcceptedStatus.filter(
                    (trait) => difference.includes(trait.traitId.resourceId + '/' + trait.traitId.traitLabel) === false,
                  )),
                  [...notAcceptedStatus, ...acceptedStatus]);
              }
              // We'll use the resource status message to look for structure and/or device removals
              // We could also check for structure and/or device additions here, but we'll want to be flagged
              // that a device is 'ready' for use before we add in. This data is populated in the trait data
              if (decodedMessage?.observeResponse?.[0]?.resourceMetas !== undefined) {
                decodedMessage.observeResponse[0].resourceMetas.map(async (resource) => {
                  if (
                    resource.status === 'REMOVED' &&
                    (resource.resourceId.startsWith('STRUCTURE_') || resource.resourceId.startsWith('DEVICE_'))
                  ) {
                    // We have the removal of a 'home' and/or device
                    // Tidy up tracked devices since this one is removed
                    if (this.#trackedDevices[this.#rawData?.[resource.resourceId]?.value?.device_identity?.serialNumber] !== undefined) {
                      // Remove any active running timers we have for this device
                      if (
                        this.#trackedDevices[this.#rawData[resource.resourceId].value.device_identity.serialNumber]?.timers !== undefined
                      ) {
                        Object.values(
                          this.#trackedDevices[this.#rawData[resource.resourceId].value.device_identity.serialNumber]?.timers,
                        ).forEach((timers) => {
                          clearInterval(timers);
                        });
                      }

                      // Send removed notice onto HomeKit device for it to process
                      this.#eventEmitter?.emit?.(
                        this.#trackedDevices[this.#rawData[resource.resourceId].value.device_identity.serialNumber].uuid,
                        HomeKitDevice.REMOVE,
                        {},
                      );

                      // Finally, remove from tracked devices
                      delete this.#trackedDevices[this.#rawData[resource.resourceId].value.device_identity.serialNumber];
                    }
                    delete this.#rawData[resource.resourceId];
                  }
                });
              }
              // eslint-disable-next-line no-unused-vars
            } catch (error) {
              // Empty
            }
            buffer = buffer.subarray(messageSize); // Remove the message from the beginning of the buffer

            if (typeof decodedMessage?.observeResponse?.[0]?.traitStates === 'object') {
              await Promise.all(
                decodedMessage.observeResponse[0].traitStates.map(async (trait) => {
                  if (typeof this.#rawData[trait.traitId.resourceId] === 'undefined') {
                    this.#rawData[trait.traitId.resourceId] = {};
                    this.#rawData[trait.traitId.resourceId].connection = uuid;
                    this.#rawData[trait.traitId.resourceId].source = DATASOURCE.PROTOBUF_API;
                    this.#rawData[trait.traitId.resourceId].value = {};
                  }
                  this.#rawData[trait.traitId.resourceId]['value'][trait.traitId.traitLabel] =
                    typeof trait.patch.values !== 'undefined' ? trait.patch.values : {};

                  // We don't need to store the trait type, so remove it
                  delete this.#rawData[trait.traitId.resourceId]['value'][trait.traitId.traitLabel]['@type'];

                  // If we have structure location details and associated geo-location details, get the weather data for the location
                  // We'll store this in the object key/value as per Nest API
                  if (
                    trait.traitId.resourceId.startsWith('STRUCTURE_') === true &&
                    trait.traitId.traitLabel === 'structure_location' &&
                    isNaN(trait.patch.values?.geoCoordinate?.latitude) === false &&
                    isNaN(trait.patch.values?.geoCoordinate?.longitude) === false
                  ) {
                    this.#rawData[trait.traitId.resourceId].value.weather = await this.#getWeather(
                      uuid,
                      trait.traitId.resourceId,
                      Number(trait.patch.values.geoCoordinate.latitude),
                      Number(trait.patch.values.geoCoordinate.longitude),
                    );
                  }
                }),
              );

              await this.#processPostSubscribe();
            }
          }
        }
      })
      .catch((error) => {
        if (
          error?.cause === undefined ||
          (typeof error.cause === 'object' && String(error.cause).toUpperCase().includes('TIMEOUT') === false)
        ) {
          this?.log?.debug?.(
            'Protobuf API had an error performing trait observe with connection uuid "%s". Error: "%s"',
            uuid,
            error?.message ?? String(error),
          );
          this?.log?.debug?.('Restarting Protobuf API trait observe for connection uuid "%s"', uuid);
        }
      })
      .finally(() => {
        setTimeout(() => this.#subscribeProtobuf(uuid, false), 1000);
      });
  }

  async #processPostSubscribe() {
    Object.values(this.#processData('')).forEach((deviceData) => {
      if (this.#trackedDevices?.[deviceData?.serialNumber] === undefined && deviceData?.excluded === true) {
        // We haven't tracked this device before (ie: should be a new one) and but its excluded
        this?.log?.warn?.('Device "%s" is ignored due to it being marked as excluded', deviceData.description);

        // Track this device even though its excluded
        this.#trackedDevices[deviceData.serialNumber] = {
          uuid: HomeKitDevice.generateUUID(HomeKitDevice.PLUGIN_NAME, this.api, deviceData.serialNumber),
          rawDataUuid: deviceData.nest_google_uuid,
          source: undefined,
          timers: undefined,
          exclude: true,
        };

        // If we're running under Homebridge, and the device is now marked as excluded and present in accessory cache
        // Then we'll unregister it from the Homebridge platform
        if (typeof this?.api?.unregisterPlatformAccessories === 'function') {
          let accessory = this.cachedAccessories.find(
            (accessory) => accessory?.UUID === this.#trackedDevices[deviceData.serialNumber].uuid,
          );
          if (accessory !== undefined && typeof accessory === 'object') {
            this.api.unregisterPlatformAccessories(HomeKitDevice.PLUGIN_NAME, HomeKitDevice.PLATFORM_NAME, [accessory]);
          }
        }
      }

      if (this.#trackedDevices?.[deviceData?.serialNumber] === undefined && deviceData?.excluded === false) {
        // We haven't tracked this device before (ie: should be a new one) and its not excluded
        // so create the required HomeKit accessories based upon the device data
        let deviceClass = this.#deviceModules.get(deviceData.device_type);
        if (deviceClass !== undefined) {
          // We have found a device class for this device type, so we can create the device
          let accessoryName =
            (deviceData.manufacturer?.trim() || 'Nest') +
            ' ' +
            deviceClass.TYPE.replace(/([a-z])([A-Z])/g, '$1 $2')
              .replace(/[^a-zA-Z0-9 ]+/g, ' ')
              .toLowerCase()
              .replace(/\b\w/g, (character) => character.toUpperCase());
          let tempDevice = new deviceClass(this.cachedAccessories, this.api, this.log, this.#eventEmitter, deviceData);
          tempDevice.add(accessoryName, getDeviceHKCategory(deviceClass.TYPE), true);

          // Track this device once created
          this.#trackedDevices[deviceData.serialNumber] = {
            uuid: tempDevice.uuid,
            rawDataUuid: deviceData.nest_google_uuid,
            source: undefined,
            timers: {},
            exclude: false,
          };

          // Optional things for each device type
          if (
            deviceClass.TYPE === DEVICE_TYPE.CAMERA ||
            deviceClass.TYPE === DEVICE_TYPE.DOORBELL ||
            deviceClass.TYPE === DEVICE_TYPE.FLOODLIGHT
          ) {
            // Setup polling loop for camera/doorbell zone data
            // This is only required for Nest API data sources as these details are present in Protobuf API
            clearInterval(this.#trackedDevices?.[deviceData.serialNumber]?.timers?.zones);
            this.#trackedDevices[deviceData.serialNumber].timers.zones = setInterval(async () => {
              let nest_google_uuid = this.#trackedDevices?.[deviceData?.serialNumber]?.rawDataUuid;
              if (
                this.#rawData?.[nest_google_uuid]?.value !== undefined &&
                this.#trackedDevices?.[deviceData?.serialNumber]?.source === DATASOURCE.NEST_API
              ) {
                try {
                  let response = await fetchWrapper(
                    'get',
                    this.#rawData[nest_google_uuid].value.nexus_api_http_server_url +
                      '/cuepoint_category/' +
                      nest_google_uuid.split('.')[1],
                    {
                      headers: {
                        referer: 'https://' + this.#connections[this.#rawData[nest_google_uuid].connection].referer,
                        'User-Agent': USER_AGENT,
                        [this.#connections[this.#rawData[nest_google_uuid].connection].cameraAPI.key]:
                          this.#connections[this.#rawData[nest_google_uuid].connection].cameraAPI.value +
                          this.#connections[this.#rawData[nest_google_uuid].connection].cameraAPI.token,
                      },
                      timeout: CAMERA_ZONE_POLLING,
                    },
                  );
                  let data = await response.json();

                  // Transform activity zones if present
                  let zones =
                    Array.isArray(data) === true
                      ? data
                          .filter((zone) => zone.type.toUpperCase() === 'ACTIVITY' || zone.type.toUpperCase() === 'REGION')
                          .map((zone) => ({
                            id: zone.id === 0 ? 1 : zone.id,
                            name: HomeKitDevice.makeValidHKName(zone.label),
                            hidden: zone.hidden === true,
                            uri: zone.nexusapi_image_uri,
                          }))
                      : [];

                  // Update internal structure with new zone details.
                  // We do a test to see if it's still present, not interval loop not finished or device removed
                  if (this.#rawData?.[nest_google_uuid]?.value !== undefined) {
                    this.#rawData[nest_google_uuid].value.activity_zones = zones;

                    // Send updated data onto HomeKit device for it to process
                    this.#trackedDevices?.[deviceData?.serialNumber]?.uuid &&
                      this.#eventEmitter?.emit?.(this.#trackedDevices[deviceData.serialNumber].uuid, HomeKitDevice.UPDATE, {
                        activity_zones: zones,
                      });
                  }
                } catch (error) {
                  // Log debug message if it wasn't a timeout
                  if (error?.cause !== undefined && String(error.cause).toUpperCase().includes('TIMEOUT') === false) {
                    this?.log?.debug?.(
                      'Nest API had error retrieving camera/doorbell activity zones for "%s". Error was "%s"',
                      deviceData.description,
                      error?.code,
                    );
                  }
                }
              }
            }, CAMERA_ZONE_POLLING);

            // Setup polling loop for camera/doorbell alert data, clearing any existing polling loop
            clearInterval(this.#trackedDevices?.[deviceData.serialNumber]?.timers?.alerts);
            this.#trackedDevices[deviceData.serialNumber].timers.alerts = setInterval(async () => {
              let alerts = []; // No alerts to processed yet
              let nest_google_uuid = this.#trackedDevices?.[deviceData?.serialNumber]?.rawDataUuid;
              if (
                this.#rawData?.[nest_google_uuid]?.value !== undefined &&
                this.#trackedDevices?.[deviceData?.serialNumber]?.source === DATASOURCE.PROTOBUF_API
              ) {
                let commandResponse = await this.#protobufCommand(
                  this.#rawData[nest_google_uuid].connection,
                  'ResourceApi',
                  'SendCommand',
                  {
                    resourceRequest: {
                      resourceId: nest_google_uuid,
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
                  },
                );

                if (
                  Array.isArray(
                    commandResponse?.sendCommandResponse?.[0]?.traitOperations?.[0]?.event?.event?.cameraEventWindow?.cameraEvent,
                  ) === true
                ) {
                  alerts = commandResponse.sendCommandResponse[0].traitOperations[0].event.event.cameraEventWindow.cameraEvent
                    .map((event) => ({
                      playback_time: parseInt(event.startTime.seconds) * 1000 + parseInt(event.startTime.nanos) / 1000000,
                      start_time: parseInt(event.startTime.seconds) * 1000 + parseInt(event.startTime.nanos) / 1000000,
                      end_time: parseInt(event.endTime.seconds) * 1000 + parseInt(event.endTime.nanos) / 1000000,
                      id: event.eventId,
                      zone_ids:
                        typeof event.activityZone === 'object'
                          ? event.activityZone.map((zone) => (zone?.zoneIndex !== undefined ? zone.zoneIndex : zone.internalIndex))
                          : [],
                      types: event.eventType
                        .map((event) => {
                          if (event === 'EVENT_UNFAMILIAR_FACE') {
                            return 'unfamiliar-face';
                          }
                          if (event === 'EVENT_PERSON_TALKING') {
                            return 'personHeard';
                          }
                          if (event === 'EVENT_DOG_BARKING') {
                            return 'dogBarking';
                          }
                          return event.startsWith('EVENT_') ? event.split('EVENT_')[1].toLowerCase() : '';
                        })
                        .filter((event) => event),
                    }))
                    .sort((a, b) => b.start_time - a.start_time);
                }
              }

              if (
                this.#rawData?.[nest_google_uuid]?.value !== undefined &&
                this.#trackedDevices?.[deviceData?.serialNumber]?.source === DATASOURCE.NEST_API
              ) {
                try {
                  let response = await fetchWrapper(
                    'get',
                    this.#rawData[nest_google_uuid].value.nexus_api_http_server_url +
                      '/cuepoint/' +
                      nest_google_uuid.split('.')[1] +
                      '/2?start_time=' +
                      Math.floor(Date.now() / 1000 - 30),
                    {
                      headers: {
                        referer: 'https://' + this.#connections[this.#rawData[nest_google_uuid].connection].referer,
                        'User-Agent': USER_AGENT,
                        [this.#connections[this.#rawData[nest_google_uuid].connection].cameraAPI.key]:
                          this.#connections[this.#rawData[nest_google_uuid].connection].cameraAPI.value +
                          this.#connections[this.#rawData[nest_google_uuid].connection].cameraAPI.token,
                      },
                      timeout: CAMERA_ALERT_POLLING,
                      retry: 3,
                    },
                  );

                  let data = await response.json();

                  alerts =
                    Array.isArray(data) === true
                      ? data
                          .map((alert) => {
                            alert.zone_ids = alert.zone_ids.map((id) => (id !== 0 ? id : 1));
                            if (alert.zone_ids.length === 0) {
                              alert.zone_ids.push(1);
                            }
                            return {
                              playback_time: alert.playback_time,
                              start_time: alert.start_time,
                              end_time: alert.end_time,
                              id: alert.id,
                              zone_ids: alert.zone_ids,
                              types: alert.types,
                            };
                          })
                          .sort((a, b) => b.start_time - a.start_time)
                      : [];
                } catch (error) {
                  if (error?.cause !== undefined && String(error.cause).toUpperCase().includes('TIMEOUT') === false) {
                    this?.log?.debug?.(
                      'Nest API had error retrieving camera/doorbell activity notifications for "%s". Error was "%s"',
                      deviceData.description,
                      error?.code,
                    );
                  }
                }
              }

              // Update internal structure with new alerts.
              // We do a test to see if its still present not interval loop not finished or device removed
              if (this.#rawData?.[nest_google_uuid]?.value !== undefined) {
                this.#rawData[nest_google_uuid].value.alerts = alerts;

                // Send updated alerts onto HomeKit device for it to process
                this.#trackedDevices?.[deviceData?.serialNumber]?.uuid &&
                  this.#eventEmitter?.emit?.(this.#trackedDevices[deviceData.serialNumber].uuid, HomeKitDevice.UPDATE, { alerts: alerts });
              }
            }, CAMERA_ALERT_POLLING);
          }

          if (deviceClass.TYPE === DEVICE_TYPE.WEATHER) {
            // Setup polling loop for weather data, clearing any existing polling loop
            clearInterval(this.#trackedDevices?.[deviceData.serialNumber]?.timers?.weather);
            this.#trackedDevices[deviceData.serialNumber].timers.weather = setInterval(async () => {
              if (this.#rawData?.[this.#trackedDevices?.[deviceData.serialNumber]?.rawDataUuid] !== undefined) {
                this.#rawData[this.#trackedDevices[deviceData.serialNumber].rawDataUuid].value.weather = await this.#getWeather(
                  this.#rawData[this.#trackedDevices[deviceData.serialNumber].rawDataUuid].connection,
                  this.#trackedDevices[deviceData.serialNumber].rawDataUuid,
                  this.#rawData[this.#trackedDevices[deviceData.serialNumber].rawDataUuid].value.weather.latitude,
                  this.#rawData[this.#trackedDevices[deviceData.serialNumber].rawDataUuid].value.weather.longitude,
                );

                this.#trackedDevices?.[deviceData.serialNumber]?.uuid &&
                  this.#eventEmitter?.emit?.(
                    this.#trackedDevices[deviceData.serialNumber].uuid,
                    HomeKitDevice.UPDATE,
                    this.#processData(this.#trackedDevices[deviceData.serialNumber].rawDataUuid)?.[deviceData.serialNumber],
                  );
              }
            }, WEATHER_POLLING);
          }
        }
      }

      // Finally, if device is not excluded, send updated data to device for it to process
      if (deviceData.excluded === false && this.#trackedDevices?.[deviceData?.serialNumber] !== undefined) {
        if (
          this.#rawData[deviceData?.nest_google_uuid]?.source !== undefined &&
          this.#rawData[deviceData.nest_google_uuid].source !== this.#trackedDevices[deviceData.serialNumber].source
        ) {
          // Data source for this device has been updated
          this?.log?.debug?.(
            'Using %s API as data source for "%s" from connection uuid "%s"',
            this.#rawData[deviceData.nest_google_uuid]?.source,
            deviceData.description,
            this.#rawData[deviceData.nest_google_uuid].connection,
          );

          this.#trackedDevices[deviceData.serialNumber].source = this.#rawData[deviceData.nest_google_uuid].source;
          this.#trackedDevices[deviceData.serialNumber].rawDataUuid = deviceData.nest_google_uuid;
        }

        this.#trackedDevices?.[deviceData?.serialNumber]?.uuid &&
          this.#eventEmitter?.emit?.(this.#trackedDevices[deviceData.serialNumber].uuid, HomeKitDevice.UPDATE, deviceData);
      }
    });
  }

  #processData(deviceUUID) {
    if (typeof deviceUUID !== 'string') {
      deviceUUID = '';
    }
    let devices = {};

    // Get the device(s) location from structure
    // We'll test in both Nest and Protobuf API data
    const get_location_name = (structure_id, where_id) => {
      let location = '';

      if (typeof structure_id === 'string' && typeof where_id === 'string') {
        // Check Nest data
        if (typeof this.#rawData?.['where.' + structure_id]?.value === 'object') {
          this.#rawData['where.' + structure_id].value.wheres.forEach((value) => {
            if (where_id === value.where_id) {
              location = value.name;
            }
          });
        }

        // Check Protobuf data (combined predefined and custom)
        let protobufWheres = [
          ...Object.values(this.#rawData?.[structure_id]?.value?.located_annotations?.predefinedWheres || {}),
          ...Object.values(this.#rawData?.[structure_id]?.value?.located_annotations?.customWheres || {}),
        ];

        protobufWheres.forEach((value) => {
          if (value?.whereId?.resourceId === where_id) {
            location = value.label?.literal;
          }
        });
      }
      return location;
    };

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

        if (Array.isArray(match)) {
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

    // Process common data for all devices
    const process_common_data = (object_key, data) => {
      let processed = {};
      try {
        // Fix up data we need to
        let deviceOptions = this.config?.devices?.find(
          (device) => device?.serialNumber?.toUpperCase?.() === data?.serialNumber?.toUpperCase?.(),
        );
        data.nest_google_uuid = object_key;
        data.serialNumber = data.serialNumber.toUpperCase(); // ensure serial numbers are in upper case
        data.excluded = this?.config?.options?.exclude === true ? deviceOptions?.exclude !== false : deviceOptions?.exclude === true;
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

        // Insert HomeKit pairing code for when using HAP-NodeJS library rather than Homebridge
        // Validate the pairing code is in the format of "xxx-xx-xxx" or "xxxx-xxxx"
        if (
          typeof this.config?.options?.hkPairingCode === 'string' &&
          (HomeKitDevice.HK_PIN_3_2_3.test(this.config.options.hkPairingCode) ||
            HomeKitDevice.HK_PIN_4_4.test(this.config.options.hkPairingCode))
        ) {
          data.hkPairingCode = this.config.options.hkPairingCode;
        } else if (
          typeof deviceOptions?.hkPairingCode === 'string' &&
          (HomeKitDevice.HK_PIN_3_2_3.test(deviceOptions.hkPairingCode) || HomeKitDevice.HK_PIN_4_4.test(deviceOptions.hkPairingCode))
        ) {
          data.hkPairingCode = deviceOptions.hkPairingCode;
        }

        // If we have a hkPairingCode defined, we need to generate a hkUsername also
        if (data?.hkPairingCode !== undefined) {
          // Use a Nest Labs prefix for first 6 digits, followed by a CRC24 based off serial number for last 6 digits.
          data.hkUsername = ('18B430' + crc24(data.serialNumber.toUpperCase()))
            .toString('hex')
            .split(/(..)/)
            .filter((s) => s)
            .join(':');
        }

        processed = data;
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        // Empty
      }
      return processed;
    };

    // Process data for any thermostat(s) we have in the raw data
    const process_thermostat_data = (object_key, data) => {
      let processed = {};
      try {
        // Fix up data we need to
        data.device_type = DEVICE_TYPE.THERMOSTAT; // Nest Thermostat

        // If we have hot water control, it should be a 'UK/EU' model, so add that after the 'gen' tag in the model name
        data.model = data.has_hot_water_control === true ? data.model.replace(/\bgen\)/, 'gen, EU)') : data.model;

        data = process_common_data(object_key, data);
        data.target_temperature_high = adjustTemperature(data.target_temperature_high, 'C', 'C', true);
        data.target_temperature_low = adjustTemperature(data.target_temperature_low, 'C', 'C', true);
        data.target_temperature = adjustTemperature(data.target_temperature, 'C', 'C', true);
        data.backplate_temperature = adjustTemperature(data.backplate_temperature, 'C', 'C', true);
        data.current_temperature = adjustTemperature(data.current_temperature, 'C', 'C', true);
        data.battery_level = scaleValue(data.battery_level, 3.6, 3.9, 0, 100);

        processed = data;
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        // Empty
      }
      return processed;
    };

    const PROTOBUF_THERMOSTAT_RESOURCES = [
      'nest.resource.NestAmber1DisplayResource',
      'nest.resource.NestAmber2DisplayResource',
      'nest.resource.NestLearningThermostat1Resource',
      'nest.resource.NestLearningThermostat2Resource',
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
          if (
            value?.source === DATASOURCE.PROTOBUF_API &&
            this.config.options?.useGoogleAPI === true &&
            value.value?.configuration_done?.deviceReady === true
          ) {
            let RESTTypeData = {};
            RESTTypeData.serialNumber = value.value.device_identity.serialNumber;
            RESTTypeData.softwareVersion = value.value.device_identity.softwareVersion;
            RESTTypeData.model = 'Thermostat (unknown)';
            if (value.value.device_info.typeName === 'nest.resource.NestLearningThermostat1Resource') {
              RESTTypeData.model = 'Learning Thermostat (1st gen)';
            }
            if (value.value.device_info.typeName === 'nest.resource.NestLearningThermostat2Resource') {
              RESTTypeData.model = 'Learning Thermostat (2nd gen)';
            }
            if (
              value.value.device_info.typeName === 'nest.resource.NestLearningThermostat3Resource' ||
              value.value.device_info.typeName === 'nest.resource.NestAmber2DisplayResource'
            ) {
              RESTTypeData.model = 'Learning Thermostat (3rd gen)';
            }
            if (value.value.device_info.typeName === 'google.resource.GoogleBismuth1Resource') {
              RESTTypeData.model = 'Learning Thermostat (4th gen)';
            }
            if (
              value.value.device_info.typeName === 'nest.resource.NestOnyxResource' ||
              value.value.device_info.typeName === 'nest.resource.NestAgateDisplayResource'
            ) {
              RESTTypeData.model = 'Thermostat E (1st gen)';
            }
            if (value.value.device_info.typeName === 'google.resource.GoogleZirconium1Resource') {
              RESTTypeData.model = 'Thermostat (2020)';
            }
            RESTTypeData.current_humidity =
              isNaN(value.value?.current_humidity?.humidityValue?.humidity?.value) === false
                ? Number(value.value.current_humidity.humidityValue.humidity.value)
                : 0.0;
            RESTTypeData.temperature_scale = value.value?.display_settings?.temperatureScale === 'TEMPERATURE_SCALE_F' ? 'F' : 'C';
            RESTTypeData.removed_from_base =
              Array.isArray(value.value?.display?.thermostatState) === true && value.value?.display.thermostatState.includes('bpd');
            RESTTypeData.backplate_temperature = parseFloat(value.value.backplate_temperature.temperatureValue.temperature.value);
            RESTTypeData.current_temperature = parseFloat(value.value.current_temperature.temperatureValue.temperature.value);
            RESTTypeData.battery_level = parseFloat(value.value.battery_voltage.batteryValue.batteryVoltage.value);
            RESTTypeData.online = value.value?.liveness?.status === 'LIVENESS_DEVICE_STATUS_ONLINE';
            RESTTypeData.leaf = value.value?.leaf?.active === true;
            RESTTypeData.has_humidifier = value.value?.hvac_equipment_capabilities?.hasHumidifier === true;
            RESTTypeData.has_dehumidifier = value.value?.hvac_equipment_capabilities?.hasDehumidifier === true;
            RESTTypeData.has_fan =
              typeof value.value?.fan_control_capabilities?.maxAvailableSpeed === 'string' &&
              value.value.fan_control_capabilities.maxAvailableSpeed !== 'FAN_SPEED_SETTING_OFF';
            RESTTypeData.can_cool =
              value.value?.hvac_equipment_capabilities?.hasStage1Cool === true ||
              value.value?.hvac_equipment_capabilities?.hasStage2Cool === true ||
              value.value?.hvac_equipment_capabilities?.hasStage3Cool === true;
            RESTTypeData.can_heat =
              value.value?.hvac_equipment_capabilities?.hasStage1Heat === true ||
              value.value?.hvac_equipment_capabilities?.hasStage2Heat === true ||
              value.value?.hvac_equipment_capabilities?.hasStage3Heat === true;
            RESTTypeData.temperature_lock = value.value?.temperature_lock_settings?.enabled === true;
            RESTTypeData.temperature_lock_pin_hash =
              value.value?.temperature_lock_settings?.enabled === true ? value.value.temperature_lock_settings.pinHash : '';
            RESTTypeData.away = value.value?.structure_mode?.structureMode === 'STRUCTURE_MODE_AWAY';
            RESTTypeData.occupancy = value.value?.structure_mode?.structureMode === 'STRUCTURE_MODE_HOME';
            //RESTTypeData.occupancy = (value.value.structure_mode.occupancy.activity === 'ACTIVITY_ACTIVE');
            RESTTypeData.vacation_mode = value.value?.structure_mode?.structureMode === 'STRUCTURE_MODE_VACATION';
            RESTTypeData.description = value.value.label?.label !== undefined ? value.value.label.label : '';
            RESTTypeData.location = get_location_name(
              value.value?.device_info?.pairerId?.resourceId,
              value.value?.device_located_settings?.whereAnnotationRid?.resourceId,
            );

            // Work out current mode. ie: off, cool, heat, range and get temperature low/high and target
            RESTTypeData.hvac_mode =
              value.value?.target_temperature_settings?.enabled?.value === true &&
              value.value?.target_temperature_settings?.targetTemperature?.setpointType !== undefined
                ? value.value.target_temperature_settings.targetTemperature.setpointType.split('SET_POINT_TYPE_')[1].toLowerCase()
                : 'off';
            RESTTypeData.target_temperature_low =
              isNaN(value.value?.target_temperature_settings?.targetTemperature?.heatingTarget?.value) === false
                ? Number(value.value.target_temperature_settings.targetTemperature.heatingTarget.value)
                : 0.0;
            RESTTypeData.target_temperature_high =
              isNaN(value.value?.target_temperature_settings?.targetTemperature?.coolingTarget?.value) === false
                ? Number(value.value.target_temperature_settings.targetTemperature.coolingTarget.value)
                : 0.0;
            RESTTypeData.target_temperature =
              value.value?.target_temperature_settings?.targetTemperature?.setpointType === 'SET_POINT_TYPE_COOL' &&
              isNaN(value.value?.target_temperature_settings?.targetTemperature?.coolingTarget?.value) === false
                ? Number(value.value.target_temperature_settings.targetTemperature.coolingTarget.value)
                : value.value?.target_temperature_settings?.targetTemperature?.setpointType === 'SET_POINT_TYPE_HEAT' &&
                    isNaN(value.value?.target_temperature_settings?.targetTemperature?.heatingTarget?.value) === false
                  ? Number(value.value.target_temperature_settings.targetTemperature.heatingTarget.value)
                  : value.value?.target_temperature_settings?.targetTemperature?.setpointType === 'SET_POINT_TYPE_RANGE' &&
                      isNaN(value.value?.target_temperature_settings?.targetTemperature?.coolingTarget?.value) === false &&
                      isNaN(value.value?.target_temperature_settings?.targetTemperature?.heatingTarget?.value) === false
                    ? (Number(value.value.target_temperature_settings.targetTemperature.coolingTarget.value) +
                        Number(value.value.target_temperature_settings.targetTemperature.heatingTarget.value)) *
                      0.5
                    : 0.0;

            // Work out if eco mode is active and adjust temperature low/high and target
            if (value.value?.eco_mode_state?.ecoMode !== 'ECO_MODE_INACTIVE') {
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
              value.value?.hvac_control?.hvacState?.coolStage1Active === true ||
              value.value?.hvac_control?.hvacState?.coolStage2Active === true ||
              value.value?.hvac_control?.hvacState?.coolStage2Active === true
            ) {
              // A cooling source is on, so we're in cooling mode
              RESTTypeData.hvac_state = 'cooling';
            }
            if (
              value.value?.hvac_control?.hvacState?.heatStage1Active === true ||
              value.value?.hvac_control?.hvacState?.heatStage2Active === true ||
              value.value?.hvac_control?.hvacState?.heatStage3Active === true ||
              value.value?.hvac_control?.hvacState?.alternateHeatStage1Active === true ||
              value.value?.hvac_control?.hvacState?.alternateHeatStage2Active === true ||
              value.value?.hvac_control?.hvacState?.auxiliaryHeatActive === true ||
              value.value?.hvac_control?.hvacState?.emergencyHeatActive === true
            ) {
              // A heating source is on, so we're in heating mode
              RESTTypeData.hvac_state = 'heating';
            }

            // Update fan status, on or off and max number of speeds supported
            RESTTypeData.fan_state =
              isNaN(value.value?.fan_control_settings?.timerEnd?.seconds) === false &&
              Number(value.value.fan_control_settings.timerEnd.seconds) > 0;
            RESTTypeData.fan_timer_speed =
              value.value.fan_control_settings.timerSpeed.includes('FAN_SPEED_SETTING_STAGE') === true &&
              isNaN(value.value.fan_control_settings.timerSpeed.split('FAN_SPEED_SETTING_STAGE')[1]) === false
                ? Number(value.value.fan_control_settings.timerSpeed.split('FAN_SPEED_SETTING_STAGE')[1])
                : 0;
            RESTTypeData.fan_max_speed =
              value.value.fan_control_capabilities.maxAvailableSpeed.includes('FAN_SPEED_SETTING_STAGE') === true &&
              isNaN(value.value.fan_control_capabilities.maxAvailableSpeed.split('FAN_SPEED_SETTING_STAGE')[1]) === false
                ? Number(value.value.fan_control_capabilities.maxAvailableSpeed.split('FAN_SPEED_SETTING_STAGE')[1])
                : 0;

            // Humidifier/dehumidifier details
            RESTTypeData.target_humidity = value.value.humidity_control_settings.targetHumidity.value;
            RESTTypeData.humidifier_state = value.value.hvac_control.hvacState.humidifierActive === true;
            RESTTypeData.dehumidifier_state = value.value.hvac_control.hvacState.dehumidifierActive === true;

            // Air filter details
            RESTTypeData.has_air_filter = value.value.hvac_equipment_capabilities.hasAirFilter === true;
            RESTTypeData.filter_replacement_needed = value.value.filter_reminder.filterReplacementNeeded.value === true;

            // Hotwater details
            RESTTypeData.has_hot_water_control = value.value?.hvac_equipment_capabilities?.hasHotWaterControl === true;
            RESTTypeData.hot_water_active = value.value?.hot_water?.boilerActive === true;
            RESTTypeData.hot_water_boost_active =
              isNaN(value.value?.hot_water_settings?.boostTimerEnd?.seconds) === false &&
              Number(value.value.hot_water_settings.boostTimerEnd.seconds) > 0;

            // Process any temperature sensors associated with this thermostat
            RESTTypeData.active_rcs_sensor =
              value.value?.remote_comfort_sensing_settings?.activeRcsSelection?.activeRcsSensor !== undefined
                ? value.value.remote_comfort_sensing_settings.activeRcsSelection.activeRcsSensor.resourceId
                : '';
            RESTTypeData.linked_rcs_sensors = [];
            if (Array.isArray(value.value?.remote_comfort_sensing_settings?.associatedRcsSensors) === true) {
              value.value.remote_comfort_sensing_settings.associatedRcsSensors.forEach((sensor) => {
                if (typeof this.#rawData?.[sensor?.deviceId?.resourceId]?.value === 'object') {
                  this.#rawData[sensor.deviceId.resourceId].value.associated_thermostat = object_key; // Sensor is linked to this thermostat
                }

                RESTTypeData.linked_rcs_sensors.push(sensor.deviceId.resourceId);
              });
            }

            RESTTypeData.schedule_mode =
              typeof value.value?.target_temperature_settings?.targetTemperature?.setpointType === 'string' &&
              value.value.target_temperature_settings.targetTemperature.setpointType.split('SET_POINT_TYPE_')[1].toLowerCase() !== 'off'
                ? value.value.target_temperature_settings.targetTemperature.setpointType.split('SET_POINT_TYPE_')[1].toLowerCase()
                : '';
            RESTTypeData.schedules = {};
            if (
              value.value[RESTTypeData.schedule_mode + '_schedule_settings']?.setpoints !== undefined &&
              value.value[RESTTypeData.schedule_mode + '_schedule_settings']?.type ===
                'SET_POINT_SCHEDULE_TYPE_' + RESTTypeData.schedule_mode.toUpperCase()
            ) {
              Object.values(value.value[RESTTypeData.schedule_mode + '_schedule_settings'].setpoints).forEach((schedule) => {
                // Create Nest API schedule entries
                const DAYSOFWEEK = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
                let dayofWeekIndex = DAYSOFWEEK.indexOf(schedule.dayOfWeek.split('DAY_OF_WEEK_')[1]);

                if (typeof RESTTypeData.schedules[dayofWeekIndex] === 'undefined') {
                  RESTTypeData.schedules[dayofWeekIndex] = {};
                }

                RESTTypeData.schedules[dayofWeekIndex][Object.entries(RESTTypeData.schedules[dayofWeekIndex]).length] = {
                  'temp-min': adjustTemperature(schedule.heatingTarget.value, 'C', 'C', true),
                  'temp-max': adjustTemperature(schedule.coolingTarget.value, 'C', 'C', true),
                  time: isNaN(schedule?.secondsInDay) === false ? Number(schedule.secondsInDay) : 0,
                  type: RESTTypeData.schedule_mode.toUpperCase(),
                  entry_type: 'setpoint',
                };
              });
            }

            tempDevice = process_thermostat_data(object_key, RESTTypeData);
          }

          if (value?.source === DATASOURCE.NEST_API && this.config.options?.useNestAPI === true && value.value?.where_id !== undefined) {
            let RESTTypeData = {};
            RESTTypeData.serialNumber = value.value.serial_number;
            RESTTypeData.softwareVersion = value.value.current_version;
            RESTTypeData.model = 'Thermostat (unknown)';
            if (value.value.serial_number.substring(0, 2) === '15') {
              RESTTypeData.model = 'Thermostat E (1st gen)'; // Nest Thermostat E
            }
            if (value.value.serial_number.substring(0, 2) === '09' || value.value.serial_number.substring(0, 2) === '10') {
              RESTTypeData.model = 'Learning Thermostat (3rd gen)'; // Nest Thermostat 3rd gen
            }
            if (value.value.serial_number.substring(0, 2) === '02') {
              RESTTypeData.model = 'Learning Thermostat (2nd gen)'; // Nest Thermostat 2nd gen
            }
            if (value.value.serial_number.substring(0, 2) === '01') {
              RESTTypeData.model = 'Learning Thermostat (1st gen)'; // Nest Thermostat 1st gen
            }
            RESTTypeData.current_humidity = value.value.current_humidity;
            RESTTypeData.temperature_scale = value.value.temperature_scale;
            RESTTypeData.removed_from_base = value.value.nlclient_state.toUpperCase() === 'BPD';
            RESTTypeData.backplate_temperature = value.value.backplate_temperature;
            RESTTypeData.current_temperature = value.value.backplate_temperature;
            RESTTypeData.battery_level = value.value.battery_level;
            RESTTypeData.online = this.#rawData?.['track.' + value.value.serial_number]?.value?.online === true;
            RESTTypeData.leaf = value.value.leaf === true;
            RESTTypeData.has_humidifier = value.value.has_humidifier === true;
            RESTTypeData.has_dehumidifier = value.value.has_dehumidifier === true;
            RESTTypeData.has_fan = value.value.has_fan === true;
            RESTTypeData.can_cool = this.#rawData?.['shared.' + value.value.serial_number]?.value?.can_cool === true;
            RESTTypeData.can_heat = this.#rawData?.['shared.' + value.value.serial_number]?.value?.can_heat === true;
            RESTTypeData.temperature_lock = value.value.temperature_lock === true;
            RESTTypeData.temperature_lock_pin_hash = value.value.temperature_lock_pin_hash;

            // Look in two possible locations for away status
            RESTTypeData.away =
              this.#rawData?.['structure.' + this.#rawData?.['link.' + value.value.serial_number].value.structure.split('.')[1]]?.value
                ?.away === true ||
              this.#rawData?.['structure.' + this.#rawData?.['link.' + value.value.serial_number].value.structure.split('.')[1]]?.value
                ?.structure_mode?.structureMode === 'STRUCTURE_MODE_AWAY';

            RESTTypeData.occupancy = RESTTypeData.away === false; // Occupancy is opposite of away status ie: away is false, then occupied

            // Look in two possible locations for vacation status
            RESTTypeData.vacation_mode =
              this.#rawData['structure.' + this.#rawData?.['link.' + value.value.serial_number].value.structure.split('.')[1]]?.value
                ?.vacation_mode === true ||
              this.#rawData?.['structure.' + this.#rawData?.['link.' + value.value.serial_number].value.structure.split('.')[1]]?.value
                ?.structure_mode?.structureMode === 'STRUCTURE_MODE_VACATION';

            RESTTypeData.description =
              this.#rawData?.['shared.' + value.value.serial_number]?.value?.name !== undefined
                ? HomeKitDevice.makeValidHKName(this.#rawData['shared.' + value.value.serial_number].value.name)
                : '';
            RESTTypeData.location = get_location_name(
              this.#rawData?.['link.' + value.value.serial_number].value.structure.split('.')[1],
              value.value.where_id,
            );

            // Work out current mode. ie: off, cool, heat, range and get temperature low (heat) and high (cool)
            RESTTypeData.hvac_mode =
              this.#rawData?.['shared.' + value.value.serial_number]?.value?.target_temperature_type !== undefined
                ? this.#rawData?.['shared.' + value.value.serial_number].value.target_temperature_type
                : 'off';
            RESTTypeData.target_temperature =
              isNaN(this.#rawData?.['shared.' + value.value.serial_number]?.value?.target_temperature) === false
                ? Number(this.#rawData['shared.' + value.value.serial_number].value.target_temperature)
                : 0.0;
            RESTTypeData.target_temperature_low =
              isNaN(this.#rawData?.['shared.' + value.value.serial_number]?.value?.target_temperature_low) === false
                ? Number(this.#rawData['shared.' + value.value.serial_number].value.target_temperature_low)
                : 0.0;
            RESTTypeData.target_temperature_high =
              isNaN(this.#rawData?.['shared.' + value.value.serial_number]?.value?.target_temperature_high) === false
                ? Number(this.#rawData['shared.' + value.value.serial_number].value.target_temperature_high)
                : 0.0;
            if (this.#rawData?.['shared.' + value.value.serial_number]?.value?.target_temperature_type.toUpperCase() === 'COOL') {
              // Target temperature is the cooling point
              RESTTypeData.target_temperature =
                isNaN(this.#rawData?.['shared.' + value.value.serial_number]?.value?.target_temperature_high) === false
                  ? Number(this.#rawData['shared.' + value.value.serial_number].value.target_temperature_high)
                  : 0.0;
            }
            if (this.#rawData?.['shared.' + value.value.serial_number]?.value?.target_temperature_type.toUpperCase() === 'HEAT') {
              // Target temperature is the heating point
              RESTTypeData.target_temperature =
                isNaN(this.#rawData?.['shared.' + value.value.serial_number]?.value?.target_temperature_low) === false
                  ? Number(this.#rawData['shared.' + value.value.serial_number].value.target_temperature_low)
                  : 0.0;
            }
            if (this.#rawData?.['shared.' + value.value.serial_number]?.value?.target_temperature_type.toUpperCase() === 'RANGE') {
              // Target temperature is in between the heating and cooling point
              RESTTypeData.target_temperature =
                isNaN(this.#rawData?.['shared.' + value.value.serial_number]?.value?.target_temperature_low) === false &&
                isNaN(this.#rawData?.['shared.' + value.value.serial_number]?.value?.target_temperature_high) === false
                  ? (Number(this.#rawData['shared.' + value.value.serial_number].value.target_temperature_low) +
                      Number(this.#rawData['shared.' + value.value.serial_number].value.target_temperature_high)) *
                    0.5
                  : 0.0;
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
              this.#rawData?.['shared.' + value.value.serial_number]?.value?.hvac_heater_state === true ||
              this.#rawData?.['shared.' + value.value.serial_number]?.value?.hvac_heat_x2_state === true ||
              this.#rawData?.['shared.' + value.value.serial_number]?.value?.hvac_heat_x3_state === true ||
              this.#rawData?.['shared.' + value.value.serial_number]?.value?.hvac_aux_heater_state === true ||
              this.#rawData?.['shared.' + value.value.serial_number]?.value?.hvac_alt_heat_x2_state === true ||
              this.#rawData?.['shared.' + value.value.serial_number]?.value?.hvac_emer_heat_state === true ||
              this.#rawData?.['shared.' + value.value.serial_number]?.value?.hvac_alt_heat_state === true
            ) {
              // A heating source is on, so we're in heating mode
              RESTTypeData.hvac_state = 'heating';
            }
            if (
              this.#rawData?.['shared.' + value.value.serial_number]?.value?.hvac_ac_state === true ||
              this.#rawData?.['shared.' + value.value.serial_number]?.value?.hvac_cool_x2_state === true ||
              this.#rawData?.['shared.' + value.value.serial_number]?.value?.hvac_cool_x3_state === true
            ) {
              // A cooling source is on, so we're in cooling mode
              RESTTypeData.hvac_state = 'cooling';
            }

            // Update fan status, on or off
            RESTTypeData.fan_state = isNaN(value.value.fan_timer_timeout) === false && Number(value.value.fan_timer_timeout) > 0;
            RESTTypeData.fan_timer_speed =
              value.value.fan_timer_speed.includes('stage') === true && isNaN(value.value.fan_timer_speed.split('stage')[1]) === false
                ? Number(value.value.fan_timer_speed.split('stage')[1])
                : 0;
            RESTTypeData.fan_max_speed =
              value.value.fan_capabilities.includes('stage') === true && isNaN(value.value.fan_capabilities.split('stage')[1]) === false
                ? Number(value.value.fan_capabilities.split('stage')[1])
                : 0;

            // Humidifier/dehumidifier details
            RESTTypeData.target_humidity = isNaN(value.value.target_humidity) === false ? Number(value.value.target_humidity) : 0.0;
            RESTTypeData.humidifier_state = value.value.humidifier_state === true;
            RESTTypeData.dehumidifier_state = value.value.dehumidifier_state === true;

            // Air filter details
            RESTTypeData.has_air_filter = value.value.has_air_filter === true;
            RESTTypeData.filter_replacement_needed = value.value.filter_replacement_needed === true;

            // Hotwater details
            RESTTypeData.has_hot_water_control = value.value.has_hot_water_control === true;
            RESTTypeData.hot_water_active = value.value?.hot_water_active === true;
            RESTTypeData.hot_water_boost_active =
              isNaN(value.value?.hot_water_boost_time_to_end) === false && Number(value.value.hot_water_boost_time_to_end) > 0;

            // Process any temperature sensors associated with this thermostat
            RESTTypeData.active_rcs_sensor = '';
            RESTTypeData.linked_rcs_sensors = [];
            if (this.#rawData?.['rcs_settings.' + value.value.serial_number]?.value?.associated_rcs_sensors !== undefined) {
              this.#rawData?.['rcs_settings.' + value.value.serial_number].value.associated_rcs_sensors.forEach((sensor) => {
                if (typeof this.#rawData[sensor]?.value === 'object') {
                  this.#rawData[sensor].value.associated_thermostat = object_key; // Sensor is linked to this thermostat

                  // Is this sensor the active one? If so, get some details about it
                  if (
                    this.#rawData?.['rcs_settings.' + value.value.serial_number]?.value?.active_rcs_sensors !== undefined &&
                    this.#rawData?.['rcs_settings.' + value.value.serial_number]?.value?.active_rcs_sensors.includes(sensor)
                  ) {
                    RESTTypeData.active_rcs_sensor = this.#rawData[sensor].value.serial_number.toUpperCase();
                    RESTTypeData.current_temperature = this.#rawData[sensor].value.current_temperature;
                  }
                  RESTTypeData.linked_rcs_sensors.push(this.#rawData[sensor].value.serial_number.toUpperCase());
                }
              });
            }

            // Get associated schedules
            if (this.#rawData?.['schedule.' + value.value.serial_number] !== undefined) {
              Object.values(this.#rawData['schedule.' + value.value.serial_number].value.days).forEach((schedules) => {
                Object.values(schedules).forEach((schedule) => {
                  // Fix up temperatures in the schedule
                  if (isNaN(schedule['temp']) === false) {
                    schedule.temp = adjustTemperature(Number(schedule.temp), 'C', 'C', true);
                  }
                  if (isNaN(schedule['temp-min']) === false) {
                    schedule['temp-min'] = adjustTemperature(Number(schedule['temp-min']), 'C', 'C', true);
                  }
                  if (isNaN(schedule['temp-max']) === false) {
                    schedule['temp-max'] = adjustTemperature(Number(schedule['temp-max']), 'C', 'C', true);
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
          this?.log?.debug?.('Error processing data for thermostat(s)');
        }

        if (Object.entries(tempDevice).length !== 0 && typeof devices[tempDevice.serialNumber] === 'undefined') {
          let deviceOptions = this.config?.devices?.find(
            (device) => device?.serialNumber?.toUpperCase?.() === tempDevice?.serialNumber?.toUpperCase?.(),
          );
          // Insert any extra options we've read in from configuration file for this device
          tempDevice.eveHistory = this.config.options.eveHistory === true || deviceOptions?.eveHistory === true;
          tempDevice.humiditySensor = deviceOptions?.humiditySensor === true;
          tempDevice.externalCool =
            typeof deviceOptions?.externalCool === 'string' && deviceOptions.externalCool !== '' ? deviceOptions.externalCool : undefined; // Config option for external cooling source
          tempDevice.externalHeat =
            typeof deviceOptions?.externalHeat === 'string' && deviceOptions.externalHeat !== '' ? deviceOptions.externalHeat : undefined; // Config option for external heating source
          tempDevice.externalFan =
            typeof deviceOptions?.externalFan === 'string' && deviceOptions.externalFan !== '' ? deviceOptions.externalFan : undefined; // Config option for external fan source
          tempDevice.externalDehumidifier =
            typeof deviceOptions?.externalDehumidifier === 'string' && deviceOptions.externalDehumidifier !== ''
              ? deviceOptions.externalDehumidifier
              : undefined; // Config option for external dehumidifier source
          tempDevice.hotWaterBoostTime = parseDurationToSeconds(deviceOptions?.hotWaterBoostTime, {
            defaultValue: 30 * 60, // 30mins
            min: 60, // 1min
            max: 7200, // 2hrs
          });
          devices[tempDevice.serialNumber] = tempDevice; // Store processed device
        }
      });

    // Process data for any temperature sensors we have in the raw data
    // This is done AFTER where have processed thermostat(s) as we inserted some extra details in there
    // We only process if the sensor has been associated to a thermostat
    const process_kryptonite_data = (object_key, data) => {
      let processed = {};
      try {
        // Fix up data we need to
        data.device_type = DEVICE_TYPE.TEMPSENSOR; // Nest Temperature sensor
        data.model = 'Temperature Sensor';
        data.softwareVersion = '1.0.0';
        data = process_common_data(object_key, data);
        data.current_temperature = adjustTemperature(data.current_temperature, 'C', 'C', true);
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
            value?.source === DATASOURCE.PROTOBUF_API &&
            this.config.options?.useGoogleAPI === true &&
            value.value?.configuration_done?.deviceReady === true &&
            typeof value?.value?.associated_thermostat === 'string' &&
            value?.value?.associated_thermostat !== ''
          ) {
            let RESTTypeData = {};
            RESTTypeData.serialNumber = value.value.device_identity.serialNumber;
            // Guessing battery minimum voltage is 2v??
            RESTTypeData.battery_level = scaleValue(Number(value.value.battery.assessedVoltage.value), 2.0, 3.0, 0, 100);
            RESTTypeData.current_temperature = value.value.current_temperature.temperatureValue.temperature.value;
            RESTTypeData.online =
              isNaN(value.value?.last_updated_beacon?.lastBeaconTime?.seconds) === false &&
              Math.floor(Date.now() / 1000) - Number(value.value.last_updated_beacon.lastBeaconTime.seconds) < 3600 * 4;
            RESTTypeData.associated_thermostat = value.value.associated_thermostat;
            RESTTypeData.description = typeof value.value?.label?.label === 'string' ? value.value.label.label : '';
            RESTTypeData.location = get_location_name(
              value.value?.device_info?.pairerId?.resourceId,
              value.value?.device_located_settings?.whereAnnotationRid?.resourceId,
            );
            RESTTypeData.active_sensor =
              this.#rawData?.[value.value?.associated_thermostat].value?.remote_comfort_sensing_settings?.activeRcsSelection
                ?.activeRcsSensor?.resourceId === object_key;
            tempDevice = process_kryptonite_data(object_key, RESTTypeData);
          }
          if (
            value?.source === DATASOURCE.NEST_API &&
            this.config.options?.useNestAPI === true &&
            value.value?.where_id !== undefined &&
            value.value?.structure_id !== undefined &&
            typeof value?.value?.associated_thermostat === 'string' &&
            value?.value?.associated_thermostat !== ''
          ) {
            let RESTTypeData = {};
            RESTTypeData.serialNumber = value.value.serial_number;
            RESTTypeData.battery_level = scaleValue(Number(value.value.battery_level), 0, 100, 0, 100);
            RESTTypeData.current_temperature = value.value.current_temperature;
            RESTTypeData.online = Math.floor(Date.now() / 1000) - value.value.last_updated_at < 3600 * 4;
            RESTTypeData.associated_thermostat = value.value.associated_thermostat;
            RESTTypeData.description = value.value.description;
            RESTTypeData.location = get_location_name(value.value.structure_id, value.value.where_id);
            RESTTypeData.active_sensor =
              this.#rawData?.['rcs_settings.' + value.value?.associated_thermostat]?.value?.active_rcs_sensors.includes(object_key) ===
              true;
            tempDevice = process_kryptonite_data(object_key, RESTTypeData);
          }
          // eslint-disable-next-line no-unused-vars
        } catch (error) {
          this?.log?.debug?.('Error processing data for temperature sensor(s)');
        }
        if (Object.entries(tempDevice).length !== 0 && typeof devices[tempDevice.serialNumber] === 'undefined') {
          let deviceOptions = this.config?.devices?.find(
            (device) => device?.serialNumber?.toUpperCase?.() === tempDevice?.serialNumber?.toUpperCase?.(),
          );
          // Insert any extra options we've read in from configuration file for this device
          tempDevice.eveHistory = this.config.options.eveHistory === true || deviceOptions?.eveHistory === true;
          devices[tempDevice.serialNumber] = tempDevice; // Store processed device
        }
      });

    // Process data for any heatlink devices we have in the raw data
    const process_heatlink_data = (object_key, data) => {
      let processed = {};
      try {
        // Fix up data we need to
        data.device_type = DEVICE_TYPE.HEATLINK;
        data = process_common_data(object_key, data);
        data.current_temperature = adjustTemperature(data.current_temperature, 'C', 'C', true);
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
          key.startsWith('DEVICE_') === true &&
          value.value?.device_info?.typeName === 'nest.resource.NestAgateHeatlinkResource' &&
          (deviceUUID === '' || deviceUUID === key),
      )
      .forEach(([object_key, value]) => {
        let tempDevice = {};
        try {
          if (
            value?.source === DATASOURCE.PROTOBUF_API &&
            this.config.options?.useGoogleAPI === true &&
            value.value?.configuration_done?.deviceReady === true
          ) {
            let RESTTypeData = {};
            RESTTypeData.serialNumber = value.value.device_identity.serialNumber;
            RESTTypeData.softwareVersion = value.value.device_identity.softwareVersion;
            RESTTypeData.model = 'Heatlink (unknown)';
            if (value.value.device_info.typeName === 'nest.resource.NestAgateHeatlinkResource') {
              RESTTypeData.model = 'Heatlink';
            }
            RESTTypeData.battery_level = 100; // Not sure what it is
            RESTTypeData.current_temperature = value.value.temperature.temperatureValue.temperature.value;
            RESTTypeData.online = value.value?.liveness?.status === 'LIVENESS_DEVICE_STATUS_ONLINE';
            RESTTypeData.description = typeof value.value?.label?.label === 'string' ? value.value.label.label : '';
            RESTTypeData.location = get_location_name(
              value.value?.device_info?.pairerId?.resourceId,
              value.value?.device_located_settings?.whereAnnotationRid?.resourceId,
            );
            RESTTypeData.active_sensor = true; // This should be active always?
            tempDevice = process_heatlink_data(object_key, RESTTypeData);
          }
          // eslint-disable-next-line no-unused-vars
        } catch (error) {
          this?.log?.debug?.('Error processing data for heatlink(s)');
        }
        if (Object.entries(tempDevice).length !== 0 && typeof devices[tempDevice.serialNumber] === 'undefined') {
          let deviceOptions = this.config?.devices?.find(
            (device) => device?.serialNumber?.toUpperCase?.() === tempDevice?.serialNumber?.toUpperCase?.(),
          );
          // Insert any extra options we've read in from configuration file for this device
          tempDevice.eveHistory = this.config.options.eveHistory === true || deviceOptions?.eveHistory === true;
          devices[tempDevice.serialNumber] = tempDevice; // Store processed device
        }
      });

    // Process data for any smoke detectors we have in the raw data
    const process_protect_data = (object_key, data) => {
      let processed = {};
      try {
        // Fix up data we need to
        data.device_type = DEVICE_TYPE.SMOKESENSOR; // Nest Protect
        data = process_common_data(object_key, data);
        processed = data;
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        // Empty
      }
      return processed;
    };

    const PROTOBUF_PROTECT_RESOURCES = [
      'nest.resource.NestProtect1LinePoweredResource',
      'nest.resource.NestProtect1BatteryPoweredResource',
      'nest.resource.NestProtect2LinePoweredResource',
      'nest.resource.NestProtect2BatteryPoweredResource',
      'NestProtect2Resource',
    ];
    Object.entries(this.#rawData)
      .filter(
        ([key, value]) =>
          (key.startsWith('topaz.') === true ||
            (key.startsWith('DEVICE_') === true && PROTOBUF_PROTECT_RESOURCES.includes(value.value?.device_info?.typeName) === true)) &&
          (deviceUUID === '' || deviceUUID === key),
      )
      .forEach(([object_key, value]) => {
        let tempDevice = {};
        try {
          if (
            value?.source === DATASOURCE.PROTOBUF_API &&
            this.config.options?.useGoogleAPI === true &&
            value.value?.configuration_done?.deviceReady === true
          ) {
            let RESTTypeData = {};
            RESTTypeData.serialNumber = value.value.device_identity.serialNumber;
            RESTTypeData.softwareVersion = value.value.device_identity.softwareVersion;
            RESTTypeData.model = 'Protect (unknown)';
            if (value.value.device_info.typeName === 'nest.resource.NestProtect1LinePoweredResource') {
              RESTTypeData.model = 'Protect (1st gen, wired)';
            }
            if (value.value.device_info.typeName === 'nest.resource.NestProtect1BatteryPoweredResource') {
              RESTTypeData.model = 'Protect (1st gen, battery)';
            }
            if (value.value.device_info.typeName === 'nest.resource.NestProtect2LinePoweredResource') {
              RESTTypeData.model = 'Protect (2nd gen, wired)';
            }
            if (value.value.device_info.typeName === 'nest.resource.NestProtect2BatteryPoweredResource') {
              RESTTypeData.model = 'Protect (2nd gen, battery)';
            }
            RESTTypeData.online = value.value?.liveness?.status === 'LIVENESS_DEVICE_STATUS_ONLINE';
            RESTTypeData.line_power_present = value.value?.wall_power?.status === 'POWER_SOURCE_STATUS_ACTIVE';
            RESTTypeData.wired_or_battery = typeof value.value?.wall_power?.status === 'string' ? 0 : 1;
            RESTTypeData.battery_level =
              isNaN(value.value?.battery_voltage_bank1?.batteryValue?.batteryVoltage?.value) === false
                ? scaleValue(Number(value.value.battery_voltage_bank1.batteryValue.batteryVoltage.value), 0, 5.4, 0, 100)
                : 0;
            RESTTypeData.battery_health_state =
              value.value?.battery_voltage_bank0?.faultInformation === undefined &&
              value.value?.battery_voltage_bank1?.faultInformation === undefined
                ? 0
                : 1;
            RESTTypeData.smoke_status = value.value?.safety_alarm_smoke?.alarmState === 'ALARM_STATE_ALARM';
            RESTTypeData.co_status = value.value?.safety_alarm_co?.alarmState === 'ALARM_STATE_ALARM';
            RESTTypeData.heat_status = false; // TODO <- need to find in protobuf
            RESTTypeData.hushed_state =
              value.value?.safety_alarm_smoke?.silenceState === 'SILENCE_STATE_SILENCED' ||
              value.value?.safety_alarm_co?.silenceState === 'SILENCE_STATE_SILENCED';
            RESTTypeData.ntp_green_led = value.value?.night_time_promise_settings?.greenLedEnabled === true;
            RESTTypeData.smoke_test_passed =
              typeof value.value.safety_summary?.warningDevices?.failures === 'object'
                ? value.value.safety_summary?.warningDevices?.failures.includes('FAILURE_TYPE_SMOKE') === false
                : true;
            RESTTypeData.heat_test_passed =
              typeof value.value.safety_summary?.warningDevices?.failures === 'object'
                ? value.value.safety_summary?.warningDevices?.failures.includes('FAILURE_TYPE_TEMP') === false
                : true;
            RESTTypeData.latest_alarm_test =
              isNaN(value.value?.self_test?.lastMstEnd?.seconds) === false ? Number(value.value.self_test.lastMstEnd.seconds) : 0;
            RESTTypeData.self_test_in_progress =
              value.value?.legacy_structure_self_test?.mstInProgress === true ||
              value.value?.legacy_structure_self_test?.astInProgress === true;
            RESTTypeData.replacement_date =
              isNaN(value.value?.legacy_protect_device_settings?.replaceByDate?.seconds) === false
                ? Number(value.value.legacy_protect_device_settings.replaceByDate.seconds)
                : 0;
            RESTTypeData.topaz_hush_key =
              typeof value.value?.safety_structure_settings?.structureHushKey === 'string'
                ? value.value.safety_structure_settings.structureHushKey
                : '';
            RESTTypeData.detected_motion = value.value?.legacy_protect_device_info?.autoAway !== true; // undefined or false = motion
            RESTTypeData.description = typeof value.value?.label?.label === 'string' ? value.value.label.label : '';
            RESTTypeData.location = get_location_name(
              value.value?.device_info?.pairerId?.resourceId,
              value.value?.device_located_settings?.whereAnnotationRid?.resourceId,
            );
            tempDevice = process_protect_data(object_key, RESTTypeData);
          }
          if (
            value?.source === DATASOURCE.NEST_API &&
            this.config.options?.useNestAPI === true &&
            value.value?.where_id !== undefined &&
            value.value?.structure_id !== undefined
          ) {
            let RESTTypeData = {};
            RESTTypeData.serialNumber = value.value.serial_number;
            RESTTypeData.softwareVersion = value.value.software_version;
            RESTTypeData.model = 'Protect (unknown)';
            if (RESTTypeData.serialNumber.substring(0, 2) === '06') {
              RESTTypeData.model = 'Protect (2nd gen)'; // Nest Protect 2nd gen
            }
            if (RESTTypeData.serialNumber.substring(0, 2) === '05') {
              RESTTypeData.model = 'Protect (1st gen)'; // Nest Protect 1st gen
            }
            RESTTypeData.model =
              value.value.wired_or_battery === 1
                ? RESTTypeData.model.replace(/\bgen\)/, 'gen, battery)')
                : value.value.wired_or_battery === 0
                  ? RESTTypeData.model.replace(/\bgen\)/, 'gen, wired)')
                  : RESTTypeData.model;
            RESTTypeData.online =
              typeof value?.value?.thread_mac_address === 'string'
                ? this.#rawData?.['widget_track.' + value?.value?.thread_mac_address.toUpperCase()]?.value?.online === true
                : false;
            RESTTypeData.line_power_present = value.value.line_power_present === true;
            RESTTypeData.wired_or_battery = value.value.wired_or_battery;
            RESTTypeData.battery_level = scaleValue(value.value.battery_level, 0, 5400, 0, 100);
            RESTTypeData.battery_health_state = value.value.battery_health_state;
            RESTTypeData.smoke_status = value.value.smoke_status !== 0;
            RESTTypeData.co_status = value.value.co_status !== 0;
            RESTTypeData.heat_status = value.value.heat_status !== 0;
            RESTTypeData.hushed_state = value.value.hushed_state === true;
            RESTTypeData.ntp_green_led_enable = value.value.ntp_green_led_enable === true;
            RESTTypeData.smoke_test_passed = value.value.component_smoke_test_passed === true;
            RESTTypeData.heat_test_passed = value.value.component_temp_test_passed === true;
            RESTTypeData.latest_alarm_test = value.value.latest_manual_test_end_utc_secs;
            RESTTypeData.self_test_in_progress =
              this.#rawData?.['safety.' + value.value.structure_id]?.value?.manual_self_test_in_progress === true;
            RESTTypeData.replacement_date = value.value.replace_by_date_utc_secs;
            RESTTypeData.topaz_hush_key =
              typeof this.#rawData?.['structure.' + value.value.structure_id]?.value?.topaz_hush_key === 'string'
                ? this.#rawData?.['structure.' + value.value.structure_id]?.value?.topaz_hush_key
                : '';
            RESTTypeData.detected_motion = value.value.auto_away === false;
            RESTTypeData.description = value.value?.description;
            RESTTypeData.location = get_location_name(value.value.structure_id, value.value.where_id);
            tempDevice = process_protect_data(object_key, RESTTypeData);
          }
          // eslint-disable-next-line no-unused-vars
        } catch (error) {
          this?.log?.debug?.('Error processing data for smoke sensor(s)');
        }

        if (Object.entries(tempDevice).length !== 0 && typeof devices[tempDevice.serialNumber] === 'undefined') {
          let deviceOptions = this.config?.devices?.find(
            (device) => device?.serialNumber?.toUpperCase?.() === tempDevice?.serialNumber?.toUpperCase?.(),
          );
          // Insert any extra options we've read in from configuration file for this device
          tempDevice.eveHistory = this.config.options.eveHistory === true || deviceOptions?.eveHistory === true;
          devices[tempDevice.serialNumber] = tempDevice; // Store processed device
        }
      });

    // Process data for any camera/doorbell(s) we have in the raw data
    const process_camera_doorbell_data = (object_key, data) => {
      let processed = {};
      try {
        // Fix up data we need to
        data.device_type = DEVICE_TYPE.CAMERA;
        if (data.model.toUpperCase().includes('DOORBELL') === true) {
          data.device_type = DEVICE_TYPE.DOORBELL;
        }
        if (data.model.toUpperCase().includes('FLOODLIGHT') === true) {
          data.device_type = DEVICE_TYPE.FLOODLIGHT;
        }
        data = process_common_data(object_key, data);
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
          if (
            value?.source === DATASOURCE.PROTOBUF_API &&
            this.config.options?.useGoogleAPI === true &&
            Array.isArray(value.value?.streaming_protocol?.supportedProtocols) === true &&
            value.value.streaming_protocol.supportedProtocols.includes('PROTOCOL_WEBRTC') === true &&
            (value.value?.configuration_done?.deviceReady === true ||
              value.value?.camera_migration_status?.state?.where === 'MIGRATED_TO_GOOGLE_HOME')
          ) {
            let RESTTypeData = {};
            RESTTypeData.serialNumber = value.value.device_identity.serialNumber;
            RESTTypeData.softwareVersion = value.value.device_identity.softwareVersion;
            RESTTypeData.model = 'Camera (unknown)';
            if (
              value.value.device_info.typeName === 'google.resource.NeonQuartzResource' &&
              value.value?.floodlight_settings === undefined &&
              value.value?.floodlight_state === undefined
            ) {
              RESTTypeData.model = 'Cam (battery)';
            }
            if (value.value.device_info.typeName === 'google.resource.GreenQuartzResource') {
              RESTTypeData.model = 'Doorbell (2nd gen, battery)';
            }
            if (value.value.device_info.typeName === 'google.resource.SpencerResource') {
              RESTTypeData.model = 'Cam (wired)';
            }
            if (value.value.device_info.typeName === 'google.resource.VenusResource') {
              RESTTypeData.model = 'Doorbell (2nd gen, wired)';
            }
            if (value.value.device_info.typeName === 'nest.resource.NestCamIndoorResource') {
              RESTTypeData.model = 'Cam Indoor (1st gen)';
            }
            if (value.value.device_info.typeName === 'nest.resource.NestCamIQResource') {
              RESTTypeData.model = 'Cam IQ';
            }
            if (value.value.device_info.typeName === 'nest.resource.NestCamIQOutdoorResource') {
              RESTTypeData.model = 'Cam Outdoor (1st gen)';
            }
            if (value.value.device_info.typeName === 'nest.resource.NestHelloResource') {
              RESTTypeData.model = 'Doorbell (1st gen, wired)';
            }
            if (
              value.value.device_info.typeName === 'google.resource.NeonQuartzResource' &&
              value.value?.floodlight_settings !== undefined &&
              value.value?.floodlight_state !== undefined
            ) {
              RESTTypeData.model = 'Cam with Floodlight';
            }

            RESTTypeData.online = value.value?.liveness?.status === 'LIVENESS_DEVICE_STATUS_ONLINE';
            RESTTypeData.description = value.value?.label?.label !== undefined ? value.value.label.label : '';
            RESTTypeData.location = get_location_name(
              value.value?.device_info?.pairerId?.resourceId,
              value.value?.device_located_settings?.whereAnnotationRid?.resourceId,
            );
            RESTTypeData.audio_enabled = value.value?.microphone_settings?.enableMicrophone === true;
            RESTTypeData.has_indoor_chime =
              value.value?.doorbell_indoor_chime_settings?.chimeType === 'CHIME_TYPE_MECHANICAL' ||
              value.value?.doorbell_indoor_chime_settings?.chimeType === 'CHIME_TYPE_ELECTRONIC';
            RESTTypeData.indoor_chime_enabled = value.value?.doorbell_indoor_chime_settings?.chimeEnabled === true;
            RESTTypeData.streaming_enabled = value.value?.recording_toggle?.currentCameraState === 'CAMERA_ON';
            // Still need to find below in protobuf
            //RESTTypeData.has_irled =
            //RESTTypeData.irled_enabled =
            //RESTTypeData.has_statusled =
            //RESTTypeData.statusled_brightness =
            RESTTypeData.has_microphone = value.value?.microphone_settings?.enableMicrophone === true;
            RESTTypeData.has_speaker = value.value?.speaker_volume?.volume !== undefined;
            RESTTypeData.has_motion_detection = value.value?.observation_trigger_capabilities?.videoEventTypes?.motion?.value === true;
            RESTTypeData.activity_zones = [];
            if (value.value?.activity_zone_settings?.activityZones !== undefined) {
              value.value.activity_zone_settings.activityZones.forEach((zone) => {
                RESTTypeData.activity_zones.push({
                  id: zone.zoneProperties?.zoneId !== undefined ? zone.zoneProperties.zoneId : zone.zoneProperties.internalIndex,
                  name: HomeKitDevice.makeValidHKName(zone.zoneProperties?.name !== undefined ? zone.zoneProperties.name : ''),
                  hidden: false,
                  uri: '',
                });
              });
            }
            RESTTypeData.alerts = typeof value.value?.alerts === 'object' ? value.value.alerts : [];
            RESTTypeData.quiet_time_enabled =
              isNaN(value.value?.quiet_time_settings?.quietTimeEnds?.seconds) === false &&
              Number(value.value.quiet_time_settings.quietTimeEnds.seconds) !== 0 &&
              Math.floor(Date.now() / 1000) < Number(value.value.quiet_time_settings.quietTimeEnds.second);
            RESTTypeData.camera_type = value.value.device_identity.vendorProductId;
            RESTTypeData.streaming_protocols =
              value.value?.streaming_protocol?.supportedProtocols !== undefined ? value.value.streaming_protocol.supportedProtocols : [];
            RESTTypeData.streaming_host =
              typeof value.value?.streaming_protocol?.directHost?.value === 'string' ? value.value.streaming_protocol.directHost.value : '';

            // Floodlight settings/status
            RESTTypeData.has_light = value.value?.floodlight_settings !== undefined && value.value?.floodlight_state !== undefined;
            RESTTypeData.light_enabled = value.value?.floodlight_state?.currentState === 'LIGHT_STATE_ON';
            RESTTypeData.light_brightness =
              isNaN(value.value?.floodlight_settings?.brightness) === false
                ? scaleValue(Number(value.value.floodlight_settings.brightness), 0, 10, 0, 100)
                : 0;

            // Status of where the device sites between Nest/Google Home App
            RESTTypeData.migrating =
              value.value?.camera_migration_status?.state?.progress !== undefined &&
              value.value?.camera_migration_status?.state?.progress !== 'PROGRESS_COMPLETE' &&
              value.value?.camera_migration_status?.state?.progress !== 'PROGRESS_NONE';

            // Details to allow access to camera API calls for the device
            RESTTypeData.apiAccess = this.#connections?.[value.connection]?.cameraAPI;

            tempDevice = process_camera_doorbell_data(object_key, RESTTypeData);
          }

          if (
            value?.source === DATASOURCE.NEST_API &&
            this.config.options?.useNestAPI === true &&
            value.value?.where_id !== undefined &&
            value.value?.structure_id !== undefined &&
            value.value?.nexus_api_http_server_url !== undefined &&
            (value.value?.properties?.['cc2migration.overview_state'] === 'NORMAL' ||
              value.value?.properties?.['cc2migration.overview_state'] === 'REVERSE_MIGRATION_IN_PROGRESS')
          ) {
            // We'll only use the Nest API data for Camera's which have NOT been migrated to Google Home
            let RESTTypeData = {};
            RESTTypeData.serialNumber = value.value.serial_number;
            RESTTypeData.softwareVersion = value.value.software_version;
            RESTTypeData.model = value.value.model.replace(/nest\s*/gi, ''); // Use camera/doorbell model that Nest supplies
            RESTTypeData.description = value.value?.description;
            RESTTypeData.location = get_location_name(value.value.structure_id, value.value.where_id);
            RESTTypeData.streaming_enabled = value.value.streaming_state.includes('enabled') === true;
            RESTTypeData.nexus_api_http_server_url = value.value.nexus_api_http_server_url;
            RESTTypeData.online = value.value.streaming_state.includes('offline') === false;
            RESTTypeData.audio_enabled = value.value.audio_input_enabled === true;
            RESTTypeData.has_indoor_chime = value.value?.capabilities.includes('indoor_chime') === true;
            RESTTypeData.indoor_chime_enabled = value.value?.properties['doorbell.indoor_chime.enabled'] === true;
            RESTTypeData.has_irled = value.value?.capabilities.includes('irled') === true;
            RESTTypeData.irled_enabled = value.value?.properties['irled.state'] !== 'always_off';
            RESTTypeData.has_statusled = value.value?.capabilities.includes('statusled') === true;
            RESTTypeData.has_video_flip = value.value?.capabilities.includes('video.flip') === true;
            RESTTypeData.video_flipped = value.value?.properties['video.flipped'] === true;
            RESTTypeData.statusled_brightness =
              isNaN(value.value?.properties?.['statusled.brightness']) === false
                ? Number(value.value.properties['statusled.brightness'])
                : 0;
            RESTTypeData.has_microphone = value.value?.capabilities.includes('audio.microphone') === true;
            RESTTypeData.has_speaker = value.value?.capabilities.includes('audio.speaker') === true;
            RESTTypeData.has_motion_detection = value.value?.capabilities.includes('detectors.on_camera') === true;
            RESTTypeData.activity_zones = value.value.activity_zones; // structure elements we added
            RESTTypeData.alerts = typeof value.value?.alerts === 'object' ? value.value.alerts : [];
            RESTTypeData.streaming_protocols = ['PROTOCOL_NEXUSTALK'];
            RESTTypeData.streaming_host = value.value.direct_nexustalk_host;
            RESTTypeData.quiet_time_enabled = false;
            RESTTypeData.camera_type = value.value.camera_type;

            // Active migration status between Nest/Google Home App
            RESTTypeData.migrating =
              value.value?.properties?.['cc2migration.overview_state'] !== undefined &&
              value.value?.properties?.['cc2migration.overview_state'] !== 'NORMAL';

            // Details to allow access to camera API calls for the device
            RESTTypeData.apiAccess = this.#connections?.[value.connection]?.cameraAPI;

            tempDevice = process_camera_doorbell_data(object_key, RESTTypeData);
          }
          // eslint-disable-next-line no-unused-vars
        } catch (error) {
          this?.log?.debug?.('Error processing data for camera/doorbell(s)');
        }

        if (Object.entries(tempDevice).length !== 0 && typeof devices[tempDevice.serialNumber] === 'undefined') {
          let deviceOptions = this.config?.devices?.find(
            (device) => device?.serialNumber?.toUpperCase?.() === tempDevice?.serialNumber?.toUpperCase?.(),
          );
          // Insert any extra options we've read in from configuration file for this device
          tempDevice.eveHistory = this.config.options.eveHistory === true || deviceOptions?.eveHistory === true;
          tempDevice.hksv = this.config.options.hksv === true || deviceOptions?.hksv === true;
          tempDevice.doorbellCooldown = parseDurationToSeconds(deviceOptions?.doorbellCooldown, { defaultValue: 60, min: 0, max: 300 });
          tempDevice.motionCooldown = parseDurationToSeconds(deviceOptions?.motionCooldown, { defaultValue: 60, min: 0, max: 300 });
          tempDevice.personCooldown = parseDurationToSeconds(deviceOptions?.personCooldown, { defaultValue: 120, min: 0, max: 300 });
          tempDevice.chimeSwitch = deviceOptions?.chimeSwitch === true; // Control 'indoor' chime by switch
          tempDevice.localAccess = deviceOptions?.localAccess === true; // Local network video streaming rather than from cloud from camera/doorbells
          // eslint-disable-next-line no-undef
          tempDevice.ffmpeg = structuredClone(this.config.options.ffmpeg); // ffmpeg details, path, libraries. No ffmpeg = undefined
          if (deviceOptions?.ffmpegDebug !== undefined) {
            // Device specific ffmpeg debugging
            tempDevice.ffmpeg.debug = deviceOptions?.ffmpegDebug === true;
          }
          tempDevice.maxStreams = this.config.options.hksv === true || deviceOptions?.hksv === true ? 1 : 2;
          devices[tempDevice.serialNumber] = tempDevice; // Store processed device
        }
      });

    // Process data for any structure(s) for both Nest and Protobuf API data
    // We use this to created virtual weather station(s) for each structure that has location data
    const process_structure_data = (object_key, data) => {
      let processed = {};
      try {
        // Fix up data we need to
        data.device_type = DEVICE_TYPE.WEATHER;
        data.model = 'Weather';
        data.softwareVersion = '1.0.0';
        data = process_common_data(object_key, data);
        data.current_temperature = adjustTemperature(data.weather.current_temperature, 'C', 'C', true);
        data.current_humidity = data.weather.current_humidity;
        data.condition = data.weather.condition;
        data.wind_direction = data.weather.wind_direction;
        data.wind_speed = data.weather.wind_speed;
        data.sunrise = data.weather.sunrise;
        data.sunset = data.weather.sunset;
        data.station = data.weather.station;
        data.forecast = data.weather.forecast;
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
          (key.startsWith('structure.') === true || key.startsWith('STRUCTURE_') === true) &&
          (deviceUUID === '' || deviceUUID === key) &&
          this.config?.options?.weather === true, // Only if weather enabled
      )
      .forEach(([object_key, value]) => {
        let tempDevice = {};
        try {
          if (
            value?.source === DATASOURCE.PROTOBUF_API &&
            this.config.options?.useGoogleAPI === true &&
            value.value?.structure_location?.geoCoordinate?.latitude !== undefined &&
            value.value?.structure_location?.geoCoordinate?.longitude !== undefined
          ) {
            let RESTTypeData = {};
            RESTTypeData.serialNumber = '18B430' + crc24(value.value.structure_info.rtsStructureId.toUpperCase()).toUpperCase();
            RESTTypeData.postal_code = value.value.structure_location.postalCode.value;
            RESTTypeData.country_code = value.value.structure_location.countryCode.value;
            RESTTypeData.city = value.value?.structure_location?.city !== undefined ? value.value.structure_location.city.value : '';
            RESTTypeData.state = value.value?.structure_location?.state !== undefined ? value.value.structure_location.state.value : '';
            RESTTypeData.latitude = value.value.structure_location.geoCoordinate.latitude;
            RESTTypeData.longitude = value.value.structure_location.geoCoordinate.longitude;
            RESTTypeData.description =
              RESTTypeData.city !== '' && RESTTypeData.state !== ''
                ? RESTTypeData.city + ' - ' + RESTTypeData.state
                : value.value.structure_info.name;
            RESTTypeData.weather = value.value.weather;

            // Use the Nest API structure ID from the Protobuf structure. This will ensure we generate the same serial number
            // This should prevent two 'weather' objects being created
            tempDevice = process_structure_data(object_key, RESTTypeData);
          }

          if (
            value?.source === DATASOURCE.NEST_API &&
            this.config.options?.useNestAPI === true &&
            value.value?.latitude !== undefined &&
            value.value?.longitude !== undefined
          ) {
            let RESTTypeData = {};
            RESTTypeData.serialNumber = '18B430' + crc24(object_key.toUpperCase()).toUpperCase();
            RESTTypeData.postal_code = value.value.postal_code;
            RESTTypeData.country_code = value.value.country_code;
            RESTTypeData.city = value.value?.city !== undefined ? value.value.city : '';
            RESTTypeData.state = value.value?.state !== undefined ? value.value.state : '';
            RESTTypeData.latitude = value.value.latitude;
            RESTTypeData.longitude = value.value.longitude;
            RESTTypeData.description =
              RESTTypeData.city !== '' && RESTTypeData.state !== '' ? RESTTypeData.city + ' - ' + RESTTypeData.state : value.value.name;
            RESTTypeData.weather = value.value.weather;
            tempDevice = process_structure_data(object_key, RESTTypeData);
          }
          // eslint-disable-next-line no-unused-vars
        } catch (error) {
          this?.log?.debug?.('Error processing data for weather');
        }

        if (Object.entries(tempDevice).length !== 0 && typeof devices[tempDevice.serialNumber] === 'undefined') {
          let deviceOptions = this.config?.devices?.find(
            (device) => device?.serialNumber?.toUpperCase?.() === tempDevice?.serialNumber?.toUpperCase?.(),
          );
          // Insert any extra options we've read in from configuration file for this device
          tempDevice.eveHistory = this.config.options.eveHistory === true || deviceOptions?.eveHistory === true;
          tempDevice.elevation =
            isNaN(deviceOptions?.elevation) === false && Number(deviceOptions?.elevation) >= 0 && Number(deviceOptions?.elevation) <= 8848
              ? Number(deviceOptions?.elevation)
              : this.config.options.elevation;
          devices[tempDevice.serialNumber] = tempDevice; // Store processed device
        }
      });

    return devices; // Return our processed data
  }

  async #set(values) {
    if (
      typeof values !== 'object' ||
      values?.uuid === undefined ||
      typeof this.#rawData?.[values?.uuid] !== 'object' ||
      typeof this.#connections?.[this.#rawData?.[values?.uuid]?.connection] !== 'object'
    ) {
      return;
    }

    let nest_google_uuid = values.uuid; // Nest/Google structure uuid for this get request
    let uuid = this.#rawData[values.uuid].connection; // Connection uuid for this device

    if (this.#protobufRoot !== null && this.#rawData?.[nest_google_uuid]?.source === DATASOURCE.PROTOBUF_API) {
      let updatedTraits = [];
      let protobufElement = {
        traitRequest: {
          resourceId: nest_google_uuid,
          traitLabel: '',
          requestId: crypto.randomUUID(),
        },
        state: {
          type_url: '',
          value: {},
        },
      };

      await Promise.all(
        Object.entries(values)
          .filter(([key]) => key !== 'uuid')
          .map(async ([key, value]) => {
            // Reset elements at start of loop
            protobufElement.traitRequest.traitLabel = '';
            protobufElement.state.type_url = '';
            protobufElement.state.value = {};

            if (
              (key === 'hvac_mode' &&
                typeof value === 'string' &&
                (value.toUpperCase() === 'OFF' ||
                  value.toUpperCase() === 'COOL' ||
                  value.toUpperCase() === 'HEAT' ||
                  value.toUpperCase() === 'RANGE')) ||
              (key === 'target_temperature' &&
                this.#rawData?.[nest_google_uuid]?.value?.eco_mode_state?.ecoMode === 'ECO_MODE_INACTIVE' &&
                isNaN(value) === false) ||
              (key === 'target_temperature_low' &&
                this.#rawData?.[nest_google_uuid]?.value?.eco_mode_state?.ecoMode === 'ECO_MODE_INACTIVE' &&
                isNaN(value) === false) ||
              (key === 'target_temperature_high' &&
                this.#rawData?.[nest_google_uuid]?.value?.eco_mode_state?.ecoMode === 'ECO_MODE_INACTIVE' &&
                isNaN(value) === false)
            ) {
              // Set either the 'mode' and/or non-eco temperatures on the target thermostat
              protobufElement.traitRequest.traitLabel = 'target_temperature_settings';
              protobufElement.state.type_url = 'type.nestlabs.com/nest.trait.hvac.TargetTemperatureSettingsTrait';
              protobufElement.state.value = this.#rawData[nest_google_uuid].value.target_temperature_settings;

              if (
                (key === 'target_temperature_low' || key === 'target_temperature') &&
                (protobufElement.state.value.targetTemperature.setpointType === 'SET_POINT_TYPE_HEAT' ||
                  protobufElement.state.value.targetTemperature.setpointType === 'SET_POINT_TYPE_RANGE')
              ) {
                // Changing heating target temperature
                protobufElement.state.value.targetTemperature.heatingTarget = { value: value };
              }
              if (
                (key === 'target_temperature_high' || key === 'target_temperature') &&
                (protobufElement.state.value.targetTemperature.setpointType === 'SET_POINT_TYPE_COOL' ||
                  protobufElement.state.value.targetTemperature.setpointType === 'SET_POINT_TYPE_RANGE')
              ) {
                // Changing cooling target temperature
                protobufElement.state.value.targetTemperature.coolingTarget = { value: value };
              }

              if (key === 'hvac_mode' && value.toUpperCase() !== 'OFF') {
                protobufElement.state.value.targetTemperature.setpointType = 'SET_POINT_TYPE_' + value.toUpperCase();
                protobufElement.state.value.enabled = { value: true };
              }

              if (key === 'hvac_mode' && value.toUpperCase() === 'OFF') {
                protobufElement.state.value.enabled = { value: false };
              }

              // Tag 'who' is doing the temperature/mode change. We are :-)
              protobufElement.state.value.targetTemperature.currentActorInfo = {
                method: 'HVAC_ACTOR_METHOD_IOS',
                originator: this.#rawData[nest_google_uuid].value.target_temperature_settings.targetTemperature.currentActorInfo.originator,
                timeOfAction: { seconds: Math.floor(Date.now() / 1000), nanos: (Date.now() % 1000) * 1e6 },
                originatorRtsId: '',
              };
            }

            if (
              (key === 'target_temperature' &&
                this.#rawData?.[nest_google_uuid]?.value?.eco_mode_state?.ecoMode !== 'ECO_MODE_INACTIVE' &&
                isNaN(value) === false) ||
              (key === 'target_temperature_low' &&
                this.#rawData?.[nest_google_uuid]?.value?.eco_mode_state?.ecoMode !== 'ECO_MODE_INACTIVE' &&
                isNaN(value) === false) ||
              (key === 'target_temperature_high' &&
                this.#rawData?.[nest_google_uuid]?.value?.eco_mode_state?.ecoMode !== 'ECO_MODE_INACTIVE' &&
                isNaN(value) === false)
            ) {
              // Set eco mode temperatures on the target thermostat
              protobufElement.traitRequest.traitLabel = 'eco_mode_settings';
              protobufElement.state.type_url = 'type.nestlabs.com/nest.trait.hvac.EcoModeSettingsTrait';
              protobufElement.state.value = this.#rawData[nest_google_uuid].value.eco_mode_settings;

              protobufElement.state.value.ecoTemperatureHeat.value.value =
                protobufElement.state.value.ecoTemperatureHeat.enabled === true &&
                protobufElement.state.value.ecoTemperatureCool.enabled === false
                  ? value
                  : protobufElement.state.value.ecoTemperatureHeat.value.value;
              protobufElement.state.value.ecoTemperatureCool.value.value =
                protobufElement.state.value.ecoTemperatureHeat.enabled === false &&
                protobufElement.state.value.ecoTemperatureCool.enabled === true
                  ? value
                  : protobufElement.state.value.ecoTemperatureCool.value.value;
              protobufElement.state.value.ecoTemperatureHeat.value.value =
                protobufElement.state.value.ecoTemperatureHeat.enabled === true &&
                protobufElement.state.value.ecoTemperatureCool.enabled === true &&
                key === 'target_temperature_low'
                  ? value
                  : protobufElement.state.value.ecoTemperatureHeat.value.value;
              protobufElement.state.value.ecoTemperatureCool.value.value =
                protobufElement.state.value.ecoTemperatureHeat.enabled === true &&
                protobufElement.state.value.ecoTemperatureCool.enabled === true &&
                key === 'target_temperature_high'
                  ? value
                  : protobufElement.state.value.ecoTemperatureCool.value.value;
            }

            if (key === 'temperature_scale' && typeof value === 'string' && (value.toUpperCase() === 'C' || value.toUpperCase() === 'F')) {
              // Set the temperature scale on the target thermostat
              protobufElement.traitRequest.traitLabel = 'display_settings';
              protobufElement.state.type_url = 'type.nestlabs.com/nest.trait.hvac.DisplaySettingsTrait';
              protobufElement.state.value = this.#rawData[nest_google_uuid].value.display_settings;
              protobufElement.state.value.temperatureScale = value.toUpperCase() === 'F' ? 'TEMPERATURE_SCALE_F' : 'TEMPERATURE_SCALE_C';
            }

            if (key === 'temperature_lock' && typeof value === 'boolean') {
              // Set lock mode on the target thermostat
              protobufElement.traitRequest.traitLabel = 'temperature_lock_settings';
              protobufElement.state.type_url = 'type.nestlabs.com/nest.trait.hvac.TemperatureLockSettingsTrait';
              protobufElement.state.value = this.#rawData[nest_google_uuid].value.temperature_lock_settings;
              protobufElement.state.value.enabled = value === true;
            }

            if (key === 'fan_state' && typeof value === 'boolean') {
              // Set fan mode on the target thermostat
              protobufElement.traitRequest.traitLabel = 'fan_control_settings';
              protobufElement.state.type_url = 'type.nestlabs.com/nest.trait.hvac.FanControlSettingsTrait';
              protobufElement.state.value = this.#rawData[nest_google_uuid].value.fan_control_settings;
              protobufElement.state.value.timerEnd =
                value === true
                  ? {
                      seconds: Number(Math.floor(Date.now() / 1000) + Number(protobufElement.state.value.timerDuration.seconds)),
                      nanos: Number(
                        ((Math.floor(Date.now() / 1000) + Number(protobufElement.state.value.timerDuration.seconds)) % 1000) * 1e6,
                      ),
                    }
                  : { seconds: 0, nanos: 0 };
              if (values?.fan_timer_speed !== undefined) {
                // We have a value to set fan speed also, so handle here as combined setting
                protobufElement.state.value.timerSpeed =
                  values?.fan_timer_speed !== 0
                    ? 'FAN_SPEED_SETTING_STAGE' + values?.fan_timer_speed
                    : this.#rawData[nest_google_uuid].value.fan_control_settings.timerSpeed;
              }
            }

            if (key === 'fan_timer_speed' && isNaN(value) === false && values?.fan_state === undefined) {
              // Set fan speed on the target thermostat only if we're not changing fan on/off state also
              protobufElement.traitRequest.traitLabel = 'fan_control_settings';
              protobufElement.state.type_url = 'type.nestlabs.com/nest.trait.hvac.FanControlSettingsTrait';
              protobufElement.state.value = this.#rawData[nest_google_uuid].value.fan_control_settings;
              protobufElement.state.value.timerSpeed =
                value !== 0 ? 'FAN_SPEED_SETTING_STAGE' + value : this.#rawData[nest_google_uuid].value.fan_control_settings.timerSpeed;
            }

            if (key === 'statusled_brightness' && isNaN(value) === false) {
              // 0
              // 1
            }

            if (key === 'irled_enabled' && typeof value === 'string') {
              // 'auto_on'
              // 'always_off'
            }

            if (key === 'streaming_enabled' && typeof value === 'boolean') {
              // Turn camera video on/off
              protobufElement.traitRequest.traitLabel = 'recording_toggle_settings';
              protobufElement.state.type_url = 'type.nestlabs.com/nest.trait.product.camera.RecordingToggleSettingsTrait';
              protobufElement.state.value = this.#rawData[nest_google_uuid].value.recording_toggle_settings;
              protobufElement.state.value.targetCameraState = value === true ? 'CAMERA_ON' : 'CAMERA_OFF';
              protobufElement.state.value.changeModeReason = 2;
              protobufElement.state.value.settingsUpdated = {
                seconds: Math.floor(Date.now() / 1000),
                nanos: (Date.now() % 1000) * 1e6,
              };
            }

            if (key === 'audio_enabled' && typeof value === 'boolean') {
              // Enable/disable microphone on camera/doorbell
              protobufElement.traitRequest.traitLabel = 'microphone_settings';
              protobufElement.state.type_url = 'type.nestlabs.com/nest.trait.audio.MicrophoneSettingsTrait';
              protobufElement.state.value = this.#rawData[nest_google_uuid].value.microphone_settings;
              protobufElement.state.value.enableMicrophone = value;
            }

            if (key === 'indoor_chime_enabled' && typeof value === 'boolean') {
              // Enable/disable chime status on doorbell
              protobufElement.traitRequest.traitLabel = 'doorbell_indoor_chime_settings';
              protobufElement.state.type_url = 'type.nestlabs.com/nest.trait.product.doorbell.DoorbellIndoorChimeSettingsTrait';
              protobufElement.state.value = this.#rawData[nest_google_uuid].value.doorbell_indoor_chime_settings;
              protobufElement.state.value.chimeEnabled = value;
            }

            if (key === 'light_enabled' && typeof value === 'boolean') {
              // Turn on/off light on supported camera devices. Need to find the related or 'SERVICE_' object for the device
              let serviceUUID = undefined;
              if (this.#rawData[nest_google_uuid].value?.related_resources?.relatedResources !== undefined) {
                Object.values(this.#rawData[nest_google_uuid].value?.related_resources?.relatedResources).forEach((values) => {
                  if (
                    values?.resourceTypeName?.resourceName === 'google.resource.AzizResource' &&
                    values?.resourceId?.resourceId.startsWith('SERVICE_') === true
                  ) {
                    serviceUUID = values.resourceId.resourceId;
                  }
                });

                if (serviceUUID !== undefined) {
                  let commandResponse = await this.#protobufCommand(uuid, 'ResourceApi', 'SendCommand', {
                    resourceRequest: {
                      resourceId: serviceUUID,
                      requestId: crypto.randomUUID(),
                    },
                    resourceCommands: [
                      {
                        traitLabel: 'on_off',
                        command: {
                          type_url: 'type.nestlabs.com/weave.trait.actuator.OnOffTrait.SetStateRequest',
                          value: {
                            on: value,
                          },
                        },
                      },
                    ],
                  });

                  if (commandResponse.sendCommandResponse?.[0]?.traitOperations?.[0]?.progress !== 'COMPLETE') {
                    this?.log?.debug?.('Protobuf API had error setting light status on uuid "%s"', nest_google_uuid);
                  }
                }
              }
            }

            if (key === 'light_brightness' && isNaN(value) === false) {
              // Set light brightness on supported camera devices
              protobufElement.traitRequest.traitLabel = 'floodlight_settings';
              protobufElement.state.type_url = 'type.nestlabs.com/google.trait.product.camera.FloodlightSettingsTrait';
              protobufElement.state.value = this.#rawData[nest_google_uuid].value.floodlight_settings;
              protobufElement.state.value.brightness = scaleValue(Number(value), 0, 100, 0, 10); // Scale to required level
            }

            if (
              key === 'active_sensor' &&
              typeof value === 'boolean' &&
              typeof this.#rawData?.[this.#rawData[nest_google_uuid]?.value?.associated_thermostat]?.value
                ?.remote_comfort_sensing_settings === 'object'
            ) {
              // Set active temperature sensor for associated thermostat
              protobufElement.traitRequest.resourceId = this.#rawData[nest_google_uuid].value.associated_thermostat;
              protobufElement.traitRequest.traitLabel = 'remote_comfort_sensing_settings';
              protobufElement.state.type_url = 'type.nestlabs.com/nest.trait.hvac.RemoteComfortSensingSettingsTrait';
              protobufElement.state.value =
                this.#rawData[this.#rawData[nest_google_uuid].value.associated_thermostat].value.remote_comfort_sensing_settings;
              protobufElement.state.value.activeRcsSelection =
                value === true
                  ? { rcsSourceType: 'RCS_SOURCE_TYPE_SINGLE_SENSOR', activeRcsSensor: { resourceId: nest_google_uuid } }
                  : { rcsSourceType: 'RCS_SOURCE_TYPE_BACKPLATE' };
            }

            if (key === 'hot_water_boost_active' && typeof value === 'object') {
              // Turn hotwater boost heating on/off
              protobufElement.traitRequest.traitLabel = 'hot_water_settings';
              protobufElement.state.type_url = 'type.nestlabs.com/nest.trait.hvac.HotWaterSettingsTrait';
              protobufElement.state.value = this.#rawData[nest_google_uuid].value.hot_water_settings;
              protobufElement.state.value.boostTimerEnd =
                value?.state === true
                  ? {
                      seconds: Number(Math.floor(Date.now() / 1000) + Number(isNaN(value?.time) === false ? value?.time : 30 * 60)),
                      nanos: Number(
                        (Math.floor(Date.now() / 1000) + (Number(isNaN(value?.time) === false ? value?.time : 30 * 60) % 1000)) * 1e6,
                      ),
                    }
                  : { seconds: 0, nanos: 0 };
            }

            if (protobufElement.traitRequest.traitLabel === '' || protobufElement.state.type_url === '') {
              this?.log?.debug?.('Unknown Protobuf set key "%s" for device uuid "%s"', key, nest_google_uuid);
            }

            if (protobufElement.traitRequest.traitLabel !== '' && protobufElement.state.type_url !== '') {
              // eslint-disable-next-line no-undef
              updatedTraits.push(structuredClone(protobufElement));
            }
          }),
      );

      if (updatedTraits.length !== 0) {
        let commandResponse = await this.#protobufCommand(uuid, 'TraitBatchApi', 'BatchUpdateState', {
          batchUpdateStateRequest: updatedTraits,
        });
        if (
          commandResponse === undefined ||
          commandResponse?.batchUpdateStateResponse?.[0]?.traitOperations?.[0]?.progress !== 'COMPLETE'
        ) {
          this?.log?.debug?.('Protobuf API had error updating device traits for uuid "%s"', nest_google_uuid);
        }
      }
    }

    if (this.#rawData?.[nest_google_uuid]?.source === DATASOURCE.NEST_API && nest_google_uuid.startsWith('quartz.') === true) {
      // Set value on Nest Camera/Doorbell
      await Promise.all(
        Object.entries(values)
          .filter(([key]) => key !== 'uuid')
          .map(async ([key, value]) => {
            let mappedKey =
              {
                indoor_chime_enabled: 'doorbell.indoor_chime.enabled',
                statusled_brightness: 'statusled.brightness',
                irled_enabled: 'irled.state',
                streaming_enabled: 'streaming.enabled',
                audio_enabled: 'audio.enabled',
              }[key] ?? key;

            try {
              let response = await fetchWrapper(
                'post',
                'https://webapi.' + this.#connections[uuid].cameraAPIHost + '/api/dropcams.set_properties',
                {
                  headers: {
                    referer: 'https://' + this.#connections[uuid].referer,
                    'User-Agent': USER_AGENT,
                    'Content-Type': 'application/x-www-form-urlencoded',
                    [this.#connections[uuid].cameraAPI.key]:
                      this.#connections[uuid].cameraAPI.value + this.#connections[uuid].cameraAPI.token,
                  },
                  timeout: NEST_API_TIMEOUT,
                },
                mappedKey + '=' + value + '&uuid=' + nest_google_uuid.split('.')[1],
              );

              let data = await response.json();
              if (data?.status !== 0) {
                throw new Error('Nest API camera update failed');
              }
            } catch (error) {
              if (error?.cause !== undefined && String(error.cause).toUpperCase().includes('TIMEOUT') === false) {
                this?.log?.debug?.('Nest API camera update failed for uuid "%s". Error was "%s"', nest_google_uuid, error?.code);
              }
            }
          }),
      );
    }

    if (this.#rawData?.[nest_google_uuid]?.source === DATASOURCE.NEST_API && nest_google_uuid.startsWith('quartz.') === false) {
      // set values on other Nest devices besides cameras/doorbells
      await Promise.all(
        Object.entries(values)
          .filter(([key]) => key !== 'uuid')
          .map(async ([key, value]) => {
            let subscribeJSONData = { objects: [] };
            let RESTStructureUUID = nest_google_uuid;

            if (nest_google_uuid.startsWith('kryptonite.') === true) {
              if (
                key === 'active_sensor' &&
                typeof value === 'boolean' &&
                typeof this.#rawData?.['rcs_settings.' + this.#rawData?.[nest_google_uuid]?.value?.associated_thermostat.split('.')[1]]
                  ?.value?.active_rcs_sensors === 'object'
              ) {
                // Set active temperature sensor for associated thermostat
                RESTStructureUUID = 'rcs_settings.' + this.#rawData[nest_google_uuid].value.associated_thermostat.split('.')[1];
                subscribeJSONData.objects.push({
                  object_key: RESTStructureUUID,
                  op: 'MERGE',
                  value:
                    value === true
                      ? { active_rcs_sensors: [nest_google_uuid], rcs_control_setting: 'OVERRIDE' }
                      : { active_rcs_sensors: [], rcs_control_setting: 'OFF' },
                });
              }
            }

            if (nest_google_uuid.startsWith('device.') === true) {
              // Set thermostat settings. Some settings are located in a different ocject location, so we handle this below also
              if (
                (key === 'hvac_mode' &&
                  typeof value === 'string' &&
                  (value.toUpperCase() === 'OFF' ||
                    value.toUpperCase() === 'COOL' ||
                    value.toUpperCase() === 'HEAT' ||
                    value.toUpperCase() === 'RANGE')) ||
                (key === 'target_temperature' && isNaN(value) === false) ||
                (key === 'target_temperature_low' && isNaN(value) === false) ||
                (key === 'target_temperature_high' && isNaN(value) === false)
              ) {
                RESTStructureUUID = 'shared.' + nest_google_uuid.split('.')[1];
                subscribeJSONData.objects.push({ object_key: RESTStructureUUID, op: 'MERGE', value: { target_change_pending: true } });
              }

              if (key === 'fan_state' && typeof value === 'boolean') {
                key = 'fan_timer_timeout';
                value = value === true ? this.#rawData[nest_google_uuid].value.fan_duration + Math.floor(Date.now() / 1000) : 0;
              }

              if (key === 'fan_timer_speed' && isNaN(value) === false) {
                value = value !== 0 ? 'stage' + value : 'stage1';
              }

              if (key === 'hot_water_boost_active' && typeof value === 'object') {
                key = 'hot_water_boost_time_to_end';
                value =
                  value?.state === true ? Number(isNaN(value?.time) === false ? value?.time : 30 * 60) + Math.floor(Date.now() / 1000) : 0;
              }

              subscribeJSONData.objects.push({ object_key: RESTStructureUUID, op: 'MERGE', value: { [key]: value } });
            }

            if (nest_google_uuid.startsWith('device.') === false && nest_google_uuid.startsWith('kryptonite.') === false) {
              // Set other Nest object settings ie: not thermostat or temperature sensors
              subscribeJSONData.objects.push({ object_key: nest_google_uuid, op: 'MERGE', value: { [key]: value } });
            }

            if (subscribeJSONData.objects.length !== 0) {
              try {
                await fetchWrapper(
                  'post',
                  this.#connections[uuid].transport_url + '/v5/put',
                  {
                    referer: 'https://' + this.#connections[uuid].referer,
                    headers: {
                      'User-Agent': USER_AGENT,
                      Authorization: 'Basic ' + this.#connections[uuid].token,
                    },
                  },
                  JSON.stringify(subscribeJSONData),
                );
              } catch (error) {
                if (error?.cause !== undefined && String(error.cause).toUpperCase().includes('TIMEOUT') === false) {
                  this?.log?.debug?.('Nest API property update failed for uuid "%s". Error was "%s"', nest_google_uuid, error?.code);
                }
              }
            }
          }),
      );
    }
  }

  async #get(values) {
    if (
      typeof values !== 'object' ||
      values?.uuid === undefined ||
      typeof this.#rawData?.[values?.uuid] !== 'object' ||
      typeof this.#connections?.[this.#rawData?.[values?.uuid]?.connection] !== 'object'
    ) {
      return;
    }

    let nest_google_uuid = values.uuid; // Nest/Google structure uuid for this get request
    let uuid = this.#rawData[values.uuid].connection; // Connection uuid for this device

    await Promise.all(
      Object.entries(values)
        .filter(([key]) => key !== 'uuid')
        .map(async ([key]) => {
          // We'll return the data under the original key value
          // By default, the returned value will be undefined. If call is successful, the key value will have the data requested
          values[key] = undefined;

          if (
            this.#rawData?.[nest_google_uuid]?.source === DATASOURCE.NEST_API &&
            key === 'camera_snapshot' &&
            nest_google_uuid.startsWith('quartz.') === true &&
            typeof this.#rawData?.[nest_google_uuid]?.value?.nexus_api_http_server_url === 'string' &&
            this.#rawData[nest_google_uuid].value.nexus_api_http_server_url !== ''
          ) {
            // Attempt to retrieve snapshot from camera via Nest API
            try {
              let response = await fetchWrapper(
                'get',
                this.#rawData[nest_google_uuid].value.nexus_api_http_server_url + '/get_image?uuid=' + nest_google_uuid.split('.')[1],
                {
                  headers: {
                    referer: 'https://' + this.#connections[uuid].referer,
                    'User-Agent': USER_AGENT,
                    [this.#connections[uuid].cameraAPI.key]:
                      this.#connections[uuid].cameraAPI.value + this.#connections[uuid].cameraAPI.token,
                  },
                  timeout: 3000,
                },
              );
              values[key] = Buffer.from(await response.arrayBuffer());
            } catch (error) {
              if (error?.cause !== undefined && String(error.cause).toUpperCase().includes('TIMEOUT') === false) {
                this?.log?.debug?.(
                  'Nest API camera snapshot failed with error for uuid "%s". Error was "%s"',
                  nest_google_uuid,
                  error?.code,
                );
              }
            }
          }

          if (
            this.#rawData?.[nest_google_uuid]?.source === DATASOURCE.PROTOBUF_API &&
            this.#protobufRoot !== null &&
            this.#rawData[nest_google_uuid]?.value?.device_identity?.vendorProductId !== undefined &&
            key === 'camera_snapshot'
          ) {
            // Attempt to retrieve snapshot from camera via Protobuf API
            // First, request to get snapshot url image updated
            let commandResponse = await this.#protobufCommand(uuid, 'ResourceApi', 'SendCommand', {
              resourceRequest: {
                resourceId: nest_google_uuid,
                requestId: crypto.randomUUID(),
              },
              resourceCommands: [
                {
                  traitLabel: 'upload_live_image',
                  command: {
                    type_url: 'type.nestlabs.com/nest.trait.product.camera.UploadLiveImageTrait.UploadLiveImageRequest',
                    value: {},
                  },
                },
              ],
            });

            if (
              commandResponse?.sendCommandResponse?.[0]?.traitOperations?.[0]?.progress === 'COMPLETE' &&
              typeof this.#rawData?.[nest_google_uuid]?.value?.upload_live_image?.liveImageUrl === 'string' &&
              this.#rawData[nest_google_uuid].value.upload_live_image.liveImageUrl !== ''
            ) {
              // Snapshot url image has been updated, so now retrieve it
              try {
                let response = await fetchWrapper('get', this.#rawData[nest_google_uuid].value.upload_live_image.liveImageUrl, {
                  referer: 'https://' + this.#connections[uuid].referer,
                  headers: {
                    'User-Agent': USER_AGENT,
                    Authorization: 'Basic ' + this.#connections[uuid].token,
                  },
                  timeout: 3000,
                });
                values[key] = Buffer.from(await response.arrayBuffer());
              } catch (error) {
                if (error?.cause !== undefined && String(error.cause).toUpperCase().includes('TIMEOUT') === false) {
                  this?.log?.debug?.(
                    'Protobuf API camera snapshot failed with error for uuid "%s". Error was "%s"',
                    nest_google_uuid,
                    error?.code,
                  );
                }
              }
            }
          }
        }),
    );

    return values;
  }

  async #getWeather(uuid, deviceUUID, latitude, longitude) {
    let weather = typeof this.#rawData?.[deviceUUID]?.value?.weather === 'object' ? this.#rawData[deviceUUID].value.weather : {};

    let location = latitude + ',' + longitude;

    if (typeof this.#connections?.[uuid]?.weather_url === 'string' && this.#connections[uuid].weather_url !== '') {
      try {
        let response = await fetchWrapper('get', this.#connections[uuid].weather_url + location, {
          referer: 'https://' + this.#connections[uuid].referer,
          headers: {
            'User-Agent': USER_AGENT,
          },
          timeout: NEST_API_TIMEOUT,
        });

        let data = await response.json();
        let locationData = data?.[location];

        // Store the lat/long details in the weather data object
        weather.latitude = latitude;
        weather.longitude = longitude;

        // Update weather data
        if (locationData?.current !== undefined) {
          weather.current_temperature = adjustTemperature(locationData.current.temp_c, 'C', 'C', false);
          weather.current_humidity = locationData.current.humidity;
          weather.condition = locationData.current.condition;
          weather.wind_direction = locationData.current.wind_dir;
          weather.wind_speed = locationData.current.wind_mph * 1.609344; // convert to km/h
          weather.sunrise = locationData.current.sunrise;
          weather.sunset = locationData.current.sunset;
        }

        weather.station = typeof locationData?.location?.short_name === 'string' ? locationData.location.short_name : '';
        weather.forecast = locationData?.forecast?.daily?.[0]?.condition !== undefined ? locationData.forecast.daily[0].condition : '';
      } catch (error) {
        if (error?.cause !== undefined && String(error.cause).toUpperCase().includes('TIMEOUT') === false) {
          this?.log?.debug?.('Nest API failed to retrieve weather details for uuid "%s". Error was "%s"', deviceUUID, error?.code);
        }
      }
    }

    return weather;
  }

  async #protobufCommand(uuid, service, command, values) {
    if (
      this.#protobufRoot === null ||
      typeof uuid !== 'string' ||
      !uuid ||
      typeof service !== 'string' ||
      !service ||
      typeof command !== 'string' ||
      !command ||
      typeof values !== 'object' ||
      values === null ||
      this.#connections?.[uuid] === undefined ||
      typeof this.#connections?.[uuid].protobufAPIHost !== 'string' ||
      typeof this.#connections?.[uuid].referer !== 'string' ||
      typeof this.#connections?.[uuid].token !== 'string'
    ) {
      return;
    }

    const encodeValues = (object) => {
      if (typeof object === 'object' && object !== null) {
        // We have a type_url and value object at this same level, we'll treat this a trait requiring encoding
        if (typeof object.type_url === 'string' && object.value !== undefined) {
          let typeName = object.type_url.split('/')[1];
          let TraitMap = this.#protobufRoot.lookup(typeName);
          if (TraitMap !== null) {
            object.value = TraitMap.encode(TraitMap.fromObject(object.value)).finish();
          }
        }

        for (const key in object) {
          if (object[key] !== undefined) {
            encodeValues(object[key]);
          }
        }
      }
    };

    // Attempt to retrieve both 'Request' and 'Reponse' traits for the associated service and command
    let TraitMapRequest = this.#protobufRoot.lookup('nestlabs.gateway.v1.' + command + 'Request');
    let TraitMapResponse = this.#protobufRoot.lookup('nestlabs.gateway.v1.' + command + 'Response');
    let commandResponse = undefined;

    if (TraitMapRequest !== null && TraitMapResponse !== null) {
      // Encode any trait values in our passed in object
      encodeValues(values);

      let encodedData = TraitMapRequest.encode(TraitMapRequest.fromObject(values)).finish();
      try {
        let response = await fetchWrapper(
          'post',
          'https://' + this.#connections[uuid].protobufAPIHost + '/nestlabs.gateway.v1.' + service + '/' + command,
          {
            headers: {
              referer: 'https://' + this.#connections[uuid].referer,
              'User-Agent': USER_AGENT,
              Authorization: 'Basic ' + this.#connections[uuid].token,
              'Content-Type': 'application/x-protobuf',
              'X-Accept-Content-Transfer-Encoding': 'binary',
              'X-Accept-Response-Streaming': 'true',
            },
          },
          encodedData,
        );
        let buffer = await response.arrayBuffer();
        commandResponse = TraitMapResponse.decode(Buffer.from(buffer)).toJSON();
      } catch (error) {
        this?.log?.debug?.('Protobuf gateway service command failed with error. Error was "%s"', error?.code);
      }
    }
    return commandResponse;
  }
}

// General helper functions which don't need to be part of an object class
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

  const buffer = Buffer.from(valueToHash);

  for (let i = 0; i < buffer.length; i++) {
    const index = ((crc >> 16) ^ buffer[i]) & 0xff;
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

function parseDurationToSeconds(inputDuration, { defaultValue = null, min = 0, max = Infinity } = {}) {
  let normalisedSeconds = defaultValue;

  if (inputDuration !== undefined && inputDuration !== null && inputDuration !== '') {
    inputDuration = String(inputDuration).trim().toLowerCase();

    // Case: plain numeric seconds (e.g. "30")
    if (/^\d+$/.test(inputDuration) === true) {
      normalisedSeconds = Number(inputDuration);
    } else {
      // Process input into normalised units. We'll convert in standard h (hours), m (minutes), s (seconds)
      inputDuration = inputDuration
        .replace(/hrs?|hours?/g, 'h')
        .replace(/mins?|minutes?/g, 'm')
        .replace(/secs?|s\b/g, 's')
        .replace(/ +/g, '');

      // Match duration format like "1h30m15s"
      let match = inputDuration.match(/^((\d+)h)?((\d+)m)?((\d+)s?)?$/);

      if (Array.isArray(match) === true) {
        let total = Number(match[2] || 0) * 3600 + Number(match[4] || 0) * 60 + Number(match[6] || 0);
        normalisedSeconds = Math.floor(total / 3600) * 3600 + Math.floor((total % 3600) / 60) * 60 + (total % 60);
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
