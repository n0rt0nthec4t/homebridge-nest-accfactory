// Nest System communications
// Part of homebridge-nest-accfactory
//
// Code version 2025.07.28
// Mark Hulskamp
'use strict';

// Define external module requirements
import protobuf from 'protobufjs';

// Define nodejs module requirements
import { Buffer } from 'node:buffer';
import { setInterval, clearInterval, setTimeout, clearTimeout } from 'node:timers';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Import our modules
import HomeKitDevice from './HomeKitDevice.js';
import { loadDeviceModules, getDeviceHKCategory } from './devices.js';
import { processConfig, buildConnections } from './config.js';
import { adjustTemperature, scaleValue, fetchWrapper, logJSONObject } from './utils.js';

// Define constants
import { TIMERS, USER_AGENT, __dirname, DATA_SOURCE, DEVICE_TYPE, ACCOUNT_TYPE, NEST_API_BAD_OBJECTS } from './consts.js';

// We handle the connections to Nest/Google
// Perform device management (additions/removals/updates)
export default class NestAccfactory {
  cachedAccessories = []; // Track restored cached accessories

  // Internal data only for this class
  #connections = undefined; // Object of confirmed connections
  #rawData = {}; // Cached copy of data from both Nest and Google APIs
  #protobufRoot = null; // Protobuf loaded protos
  #trackedDevices = {}; // Object of devices we've created. used to track data source type, comms uuid. key'd by serial #
  #deviceModules = undefined; // No loaded device support modules to start

  constructor(log, config, api) {
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

    api?.on?.('didFinishLaunching', async () => {
      // We got notified that Homebridge (or Docker) has finished loading

      // Load device support modules from the plugins folder if not already done
      this.#deviceModules = await loadDeviceModules(this.log, 'plugins');

      // Start reconnect loop per connection with backoff for failed tries
      // This also initiates both Nest and Protobuf subscribes
      for (const uuid of Object.keys(this.#connections)) {
        let reconnectDelay = 15000;

        const reconnectLoop = async () => {
          if (this.#connections?.[uuid]?.authorised !== true) {
            try {
              await this.#connect(uuid);
              this.#subscribeNest(uuid);
              this.#subscribeProtobuf(uuid);
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

    api?.on?.('shutdown', async () => {
      // We got notified that Homebridge is shutting down
      // Perform cleanup of internal state

      for (let device of Object.values(this.#trackedDevices)) {
        // Send a message to each device we've tracked and isn't excluded, that Homebridge is shutting down
        if (device.exclude === false && device.uuid !== undefined) {
          await HomeKitDevice.message(device.uuid, HomeKitDevice.SHUTDOWN, {});
        }

        // Cleanup any timers we have running the devices ie: weather, alerts, zones polling etc
        Object.values(device?.timers || {}).forEach((timer) => clearInterval(timer));
      }

      // Cleanup internal data
      this.#trackedDevices = {};
      this.#rawData = {};
      this.#protobufRoot = null;
      this.#connections = undefined;
      this.#deviceModules = undefined;
      this.cachedAccessories = [];
    });
  }

  configureAccessory(accessory) {
    // This gets called from Homebridge each time it restores an accessory from its cache
    this?.log?.info?.('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache, so we can track if it has already been registered
    this.cachedAccessories.push(accessory);
  }

  async #connect(uuid, refresh = false) {
    if (typeof this.#connections?.[uuid] !== 'object') {
      return;
    }

    if (refresh !== true) {
      this?.log?.info?.(
        'Performing authorisation for connection "%s" %s',
        this.#connections[uuid].name,
        this.#connections[uuid].fieldTest === true ? 'using field test endpoints' : '',
      );
    }

    if (this.#connections[uuid].type === ACCOUNT_TYPE.GOOGLE) {
      // Authorisation using Google account (cookie-based since 2022)
      try {
        let tokenResponse = await fetchWrapper('get', this.#connections[uuid].issuetoken, {
          headers: {
            referer: 'https://accounts.google.com/o/oauth2/iframe',
            'User-Agent': USER_AGENT,
            cookie: this.#connections[uuid].cookie,
            'Sec-Fetch-Mode': 'cors',
            'X-Requested-With': 'XmlHttpRequest',
          },
        });

        let tokenData = await tokenResponse.json();

        let googleOAuth2Token = tokenData.access_token;
        if (typeof googleOAuth2Token !== 'string') {
          this?.log?.debug?.('OAuth reponse object', tokenData);
          throw new Error('Missing access_token in OAuth response');
        }

        let jwtResponse = await fetchWrapper(
          'post',
          'https://nestauthproxyservice-pa.googleapis.com/v1/issue_jwt',
          {
            headers: {
              referer: 'https://' + this.#connections[uuid].referer,
              'User-Agent': USER_AGENT,
              Authorization: tokenData.token_type + ' ' + tokenData.access_token,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
          },
          'embed_google_oauth_access_token=true&expire_after=3600s&google_oauth_access_token=' +
            tokenData.access_token +
            '&policy_id=authproxy-oauth-policy',
        );

        let jwtData = await jwtResponse.json();

        let googleToken = jwtData.jwt;
        if (typeof googleToken !== 'string') {
          this?.log?.debug?.('JWT reponse object', jwtData);
          throw new Error('Missing jwt in JWT response');
        }

        let sessionResponse = await fetchWrapper('get', 'https://' + this.#connections[uuid].restAPIHost + '/session', {
          headers: {
            referer: 'https://' + this.#connections[uuid].referer,
            'User-Agent': USER_AGENT,
            Authorization: 'Basic ' + googleToken,
          },
        });

        let sessionData = await sessionResponse.json();

        // Store authorised session details
        Object.assign(this.#connections[uuid], {
          authorised: true,
          userID: sessionData.userid,
          transport_url: sessionData.urls.transport_url,
          weather_url: sessionData.urls.weather_url,
          token: googleToken,
          cameraAPI: {
            key: 'Authorization',
            value: 'Basic ',
            token: googleToken,
            oauth2: googleOAuth2Token,
            fieldTest: this.#connections[uuid]?.fieldTest === true, // preserve fieldTest flag
          },
        });

        clearTimeout(this.#connections[uuid].timer);
        this.#connections[uuid].timer = setTimeout(
          () => {
            this?.log?.debug?.('Performing periodic token refresh using Google account for connection "%s"', this.#connections[uuid].name);
            this.#connect(uuid, true);
          },
          (tokenData.expires_in - 180) * 1000, // Refresh Google token, 3mins before expires
        );

        if (refresh !== true) {
          this?.log?.success?.('Successfully authorised using Google account for connection "%s"', this.#connections[uuid].name);
        } else {
          this?.log?.debug?.('Successfully performed token refesh using Google account for connection "%s"', this.#connections[uuid].name);
        }
      } catch (error) {
        this.#connections[uuid].authorised = false;
        this?.log?.debug?.(
          'Failed to connect using Google credentials for connection "%s": %s',
          this.#connections[uuid].name,
          typeof error?.message === 'string' ? error.message : String(error),
        );
        if (refresh !== true) {
          this?.log?.error?.('Authorisation failed using Google account for connection "%s"', this.#connections[uuid].name);
        } else {
          this?.log?.error?.('Token refresh failed using Google account for connection "%s"', this.#connections[uuid].name);
        }
      }
    }

    if (this.#connections[uuid].type === ACCOUNT_TYPE.NEST) {
      // Authorisation using legacy Nest account
      try {
        // Login to get website_2/ft session token
        let loginResponse = await fetchWrapper(
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
        );

        let loginData = await loginResponse.json();
        if (loginData?.items?.[0]?.session_token === undefined) {
          throw new Error('No Nest session token was obtained');
        }

        let nestToken = loginData.items[0].session_token;

        // Once we have session token, get further details we need
        let sessionResponse = await fetchWrapper('get', 'https://' + this.#connections[uuid].restAPIHost + '/session', {
          headers: {
            referer: 'https://' + this.#connections[uuid].referer,
            'User-Agent': USER_AGENT,
            Authorization: 'Basic ' + this.#connections[uuid].access_token,
          },
        });

        let sessionData = await sessionResponse.json();

        // Store authorised session details
        Object.assign(this.#connections[uuid], {
          authorised: true,
          userID: sessionData.userid,
          transport_url: sessionData.urls.transport_url,
          weather_url: sessionData.urls.weather_url,
          token: this.#connections[uuid].access_token,
          cameraAPI: {
            key: 'cookie',
            value: this.#connections[uuid].fieldTest === true ? 'website_ft=' : 'website_2=',
            token: nestToken,
            fieldTest: this.#connections[uuid].fieldTest === true,
          },
        });

        // Schedule token refresh every 24h
        clearTimeout(this.#connections[uuid].timer);
        this.#connections[uuid].timer = setTimeout(
          () => {
            this?.log?.debug?.('Performing periodic token refresh using Nest account for connection "%s"', this.#connections[uuid].name);
            this.#connect(uuid, true);
          },
          1000 * 3600 * 24, // Refresh Nest session token every 24hrs
        );
        if (refresh !== true) {
          this?.log?.success?.('Successfully authorised using Nest account for connection "%s"', this.#connections[uuid].name);
        } else {
          this?.log?.debug?.('Successfully performed token refresh using Nest account for connection "%s"', this.#connections[uuid].name);
        }
      } catch (error) {
        this.#connections[uuid].authorised = false;
        this?.log?.debug?.(
          'Failed to connect using Nest credentials for connection "%s": %s',
          this.#connections[uuid].name,
          typeof error?.message === 'string' ? error.message : String(error),
        );
        if (refresh !== true) {
          this?.log?.error?.('Authorisation failed using Nest account for connection "%s"', this.#connections[uuid].name);
        } else {
          this?.log?.error?.('Token refresh failed using Nest account for connection "%s"', this.#connections[uuid].name);
        }
      }
    }
  }

  async #subscribeNest(uuid, firstRun = true, fullRead = true) {
    if (
      typeof this.#connections?.[uuid] !== 'object' ||
      this.#connections?.[uuid]?.authorised !== true ||
      this.config?.options?.useNestAPI !== true
    ) {
      // Not a valid connection object and/or we're not authorised
      return;
    }

    // By default, setup for a full data read from the Nest API
    // Generate a list of "known" objects for future subscribes
    let subscribeJSONData = { known_bucket_types: [], known_bucket_versions: [] };
    if (firstRun !== false || fullRead !== false) {
      this?.log?.debug?.('Starting Nest API subscribe for connection "%s"', this.#connections[uuid].name);
      try {
        await fetchWrapper('get', this.#connections[uuid].transport_url + '/v3/mobile/user.' + this.#connections[uuid].userID, {
          headers: {
            referer: 'https://' + this.#connections[uuid].referer,
            'User-Agent': USER_AGENT,
            Authorization: 'Basic ' + this.#connections[uuid].token,
          },
        })
          .then((response) => response.json())
          .then(async (data) => {
            // Build a list of known objects for Nest API. Filter out know "bad" objects ie: ones we cannot perform subscribe to
            subscribeJSONData.known_bucket_types = Object.keys(data).filter((key) => NEST_API_BAD_OBJECTS.includes(key) === false);
          });
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        // Empty
      }
    }

    // We have data stored from this Nest API, so setup read using known object
    if (firstRun === false || fullRead === false) {
      subscribeJSONData = { objects: [] };
      subscribeJSONData.objects.push(
        ...Object.entries(this.#rawData)
          // eslint-disable-next-line no-unused-vars
          .filter(([key, value]) => value.source === DATA_SOURCE.NEST && value.connection === uuid)
          .map(([key, value]) => ({
            object_key: key,
            object_revision: value.object_revision,
            object_timestamp: value.object_timestamp,
          })),
      );
    }

    fetchWrapper(
      'post',
      Array.isArray(subscribeJSONData?.objects) === true
        ? this.#connections[uuid].transport_url + '/v6/subscribe'
        : 'https://' + this.#connections[uuid].restAPIHost + '/api/0.1/user/' + this.#connections[uuid].userID + '/app_launch',
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
        fullRead = false; // Not a full data refresh required when we start again
        for (let value of data) {
          if (value.object_key.startsWith('structure.') === true) {
            // Since we have a structure key, need to add in weather data for the location using latitude and longitude details
            value.value.weather = await this.#getWeather(uuid, value.object_key, value.value.latitude, value.value.longitude);

            // Check for changes in the swarm property. This seems to indicate changes in devices
            if (typeof this.#rawData[value.object_key]?.value?.swarm === 'object' && Array.isArray(value.value?.swarm) === true) {
              this.#rawData[value.object_key].value.swarm.forEach((object_key) => {
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
                  timeout: TIMERS.NEST_API,
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

            value.value.activity_zones = await this.#getCameraActivityZones(uuid, value.object_key);
          }

          if (value.object_key.startsWith('buckets.') === true) {
            if (typeof this.#rawData[value.object_key] === 'object' && typeof this.#rawData[value.object_key].value?.buckets === 'object') {
              // Check for added objects
              value.value.buckets.map((object_key) => {
                if (this.#rawData[value.object_key].value.buckets.includes(object_key) === false) {
                  // Since this is an added object to the raw Nest API structure, we need to do a full read of the data
                  fullRead = true;
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
                      HomeKitDevice.message(
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

          // Create or update raw data entry by merging current and new values
          this.#rawData[value.object_key] = {
            object_revision: value.object_revision, // Used for future subscribes
            object_timestamp: value.object_timestamp, // Used for future subscribes
            connection: uuid,
            source: DATA_SOURCE.NEST,
            value: Object.assign(
              {}, // base empty object
              this.#rawData?.[value.object_key]?.value, // existing value (if any)
              value.value, // latest values to merge in
            ),
          };
        }

        // Dump the the raw data if configured todo so
        // This can be used for user support, rather than specific build to dump this :-)
        if (this?.config?.options?.rawdump === true) {
          Object.entries(this.#rawData)
            .filter(([, data]) => data?.source === DATA_SOURCE.NEST)
            .forEach(([serial, data]) => {
              this?.log?.debug?.('Raw data [%s]', serial);
              logJSONObject(this.log, data);
            });
        }

        await this.#processData();
      })
      .catch((error) => {
        // Attempt to extract HTTP status code from error cause or error object
        let statusCode = error && error.code !== null ? error.code : error && error.status !== null ? error.status : undefined;

        // If we get a 401 Unauthorized and the connection was previously authorised,
        // mark it as unauthorised so the reconnect loop will handle it
        if (statusCode === 401 && this.#connections?.[uuid]?.authorised === true) {
          this?.log?.debug?.(
            'Connection "' + this.#connections[uuid].name + '" is no longer authorised with the Nest API, will attempt to reconnect',
          );
          this.#connections[uuid].authorised = false;
          return;
        }

        // Log unexpected errors (excluding timeouts) for debugging
        if (
          error?.cause === undefined ||
          (typeof error.cause === 'object' && String(error.cause).toUpperCase().includes('TIMEOUT') === false)
        ) {
          this?.log?.debug?.(
            'Nest API had an error performing subscription with connection "%s": %s',
            this.#connections[uuid].name,
            typeof error?.message === 'string' ? error.message : String(error),
          );
          this?.log?.debug?.('Restarting Nest API subscription for connection "' + this.#connections[uuid].name + '"');
        }
      })
      .finally(() => {
        // Only continue the subscription loop if still authorised
        if (this.#connections?.[uuid]?.authorised === true) {
          setTimeout(() => this.#subscribeNest(uuid, false, fullRead), 1000);
        }
      });
  }

  async #subscribeProtobuf(uuid, firstRun = true) {
    if (
      typeof this.#connections?.[uuid] !== 'object' ||
      this.#connections?.[uuid]?.authorised !== true ||
      this.config?.options?.useGoogleAPI !== true
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
    if (this.#protobufRoot === null && fs.existsSync(path.join(__dirname, 'protobuf/root.proto')) === true) {
      protobuf.util.Long = null;
      protobuf.configure();
      this.#protobufRoot = protobuf.loadSync(path.join(__dirname, 'protobuf/root.proto'));
      if (this.#protobufRoot !== null) {
        this?.log?.debug?.('Loaded protobuf support files for Google API');
      }
    }

    if (this.#protobufRoot === null) {
      this?.log?.warn?.(
        'Failed to loaded protobuf support files for Google API. This will cause certain Nest/Google devices to be un-supported',
      );
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

    if (firstRun === true || firstRun === undefined) {
      this?.log?.debug?.('Starting protobuf trait observe for connection "%s"', this.#connections[uuid].name);
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
                      HomeKitDevice.message(
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
              for (let trait of decodedMessage.observeResponse[0].traitStates) {
                // Create or update trait entry and assign latest patch values
                this.#rawData[trait.traitId.resourceId] = {
                  connection: uuid,
                  source: DATA_SOURCE.GOOGLE,
                  value: Object.assign(
                    {}, // base object
                    this.#rawData?.[trait.traitId.resourceId]?.value, // existing values (if any)
                    {
                      [trait.traitId.traitLabel]: trait?.patch?.values ?? {}, // latest patch for this trait
                    },
                  ),
                };

                // Remove trait type metadata — we don't need to store it
                delete this.#rawData[trait.traitId.resourceId]?.value?.[trait.traitId.traitLabel]?.['@type'];

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
              }

              // Inject any data for testing. Even thou we're using the "serialNumber" from this should actually be the device uuid etc
              // This code MAY NOT stay here
              for (let device of this.config?.devices) {
                if (typeof device?.serialNumber !== 'string' || device.serialNumber === '' || typeof device?.inject !== 'object') {
                  continue;
                }

                this.#rawData[device.serialNumber] = {
                  connection: uuid,
                  source: DATA_SOURCE.GOOGLE,
                  value: Object.assign(
                    {}, // new base object
                    this.#rawData[device.serialNumber]?.value, // existing value (if any)
                    device.inject, // new inject data
                  ),
                };
              }

              // Dump the the raw data if configured todo so
              // This can be used for user support, rather than specific build to dump this :-)
              if (this?.config?.options?.rawdump === true) {
                Object.entries(this.#rawData)
                  .filter(([, data]) => data?.source === DATA_SOURCE.GOOGLE)
                  .forEach(([serial, data]) => {
                    this?.log?.debug?.('Raw data [%s]', serial);
                    logJSONObject(this.log, data);
                  });
              }

              await this.#processData();
            }
          }
        }
      })
      .catch((error) => {
        // Attempt to extract HTTP status code from error cause or error object
        let statusCode = error && error.code !== null ? error.code : error && error.status !== null ? error.status : undefined;

        // If we get a 401 Unauthorized and the connection was previously authorised,
        // mark it as unauthorised so the reconnect loop will handle it
        if (statusCode === 401 && this.#connections?.[uuid]?.authorised === true) {
          this?.log?.debug?.(
            'Connection "' + this.#connections[uuid].name + '" is no longer authorised with the Google API, will attempt to reconnect',
          );
          this.#connections[uuid].authorised = false;
          return;
        }

        // Log unexpected errors (excluding timeouts) for debugging
        if (
          error?.cause === undefined ||
          (typeof error.cause === 'object' && String(error.cause).toUpperCase().includes('TIMEOUT') === false)
        ) {
          this?.log?.debug?.(
            'Google API had an error performing observe with connection "%s": %s',
            this.#connections[uuid].name,
            typeof error?.message === 'string' ? error.message : String(error),
          );
          this?.log?.debug?.('Restarting Google API observe for connection "' + this.#connections[uuid].name + '"');
        }
      })
      .finally(() => {
        // Only restart trait observation if still authorised
        if (this.#connections?.[uuid]?.authorised === true) {
          setTimeout(() => this.#subscribeProtobuf(uuid, false), 1000);
        }
      });
  }

  async #processData() {
    for (let [deviceType, deviceModule] of this.#deviceModules) {
      if (typeof deviceModule?.processRawData === 'function') {
        let devices = {};
        try {
          devices = deviceModule.processRawData(this.log, this.#rawData, this.config, deviceType);
        } catch (error) {
          this?.log?.warn?.('%s module failed to process data. Error was %s', deviceType, String(error));
        }
        if (devices && typeof devices === 'object') {
          for (let deviceData of Object.values(devices)) {
            if (this.#trackedDevices?.[deviceData?.serialNumber] === undefined && deviceData?.excluded === true) {
              // We haven't tracked this device before (ie: should be a new one) and but its excluded
              this?.log?.warn?.('Device "%s" is ignored due to it being marked as excluded', deviceData.description);

              // Track this device even though its excluded
              this.#trackedDevices[deviceData.serialNumber] = {
                uuid: HomeKitDevice.generateUUID(HomeKitDevice.PLUGIN_NAME, this.api, deviceData.serialNumber),
                nest_google_uuid: deviceData.nest_google_uuid,
                source: undefined, // gets filled out later
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
              if (
                typeof deviceModule?.class === 'function' &&
                typeof deviceModule.class.TYPE === 'string' &&
                deviceModule.class.TYPE !== '' &&
                typeof deviceModule.class.VERSION === 'string' &&
                deviceModule.class.VERSION !== ''
              ) {
                // We have found a device class for this device type, so we can create the device
                let accessoryName =
                  (deviceData.manufacturer?.trim() || 'Nest') +
                  ' ' +
                  deviceModule.class.TYPE.replace(/([a-z])([A-Z])/g, '$1 $2')
                    .replace(/[^a-zA-Z0-9 ]+/g, ' ')
                    .toLowerCase()
                    .replace(/\b\w/g, (character) => character.toUpperCase());

                let tempDevice = new deviceModule.class(this.cachedAccessories, this.api, this.log, deviceData);
                tempDevice.add(accessoryName, getDeviceHKCategory(deviceModule.class.TYPE), true);

                // Register per-device set/get handlers
                HomeKitDevice.message(tempDevice.uuid, HomeKitDevice.SET, async (values) => {
                  await this.#set(this.#rawData?.[values?.uuid]?.connection, values?.uuid, values);
                });

                HomeKitDevice.message(tempDevice.uuid, HomeKitDevice.GET, async (values) => {
                  return await this.#get(this.#rawData?.[values?.uuid]?.connection, values?.uuid, values);
                });

                // Track this device once created
                this.#trackedDevices[deviceData.serialNumber] = {
                  uuid: tempDevice.uuid,
                  nest_google_uuid: deviceData.nest_google_uuid,
                  source: undefined, // gets filled out later
                  timers: {},
                  exclude: false,
                };

                // Optional things for each device type
                if (
                  deviceModule.class.TYPE === DEVICE_TYPE.CAMERA ||
                  deviceModule.class.TYPE === DEVICE_TYPE.DOORBELL ||
                  deviceModule.class.TYPE === DEVICE_TYPE.FLOODLIGHT
                ) {
                  // Setup polling loop for camera/doorbell zone data
                  // This is only required for Nest API data sources as these details are present in Protobuf API
                  clearInterval(this.#trackedDevices?.[deviceData.serialNumber]?.timers?.zones);
                  this.#trackedDevices[deviceData.serialNumber].timers.zones = setInterval(async () => {
                    try {
                      let nest_google_uuid = this.#trackedDevices?.[deviceData?.serialNumber]?.nest_google_uuid;

                      if (
                        typeof this.#trackedDevices?.[deviceData?.serialNumber]?.uuid === 'string' &&
                        this.#trackedDevices?.[deviceData?.serialNumber]?.source === DATA_SOURCE.NEST &&
                        typeof this.#rawData?.[nest_google_uuid]?.value === 'object'
                      ) {
                        this.#rawData[nest_google_uuid].value.activity_zones = await this.#getCameraActivityZones(
                          this.#rawData[nest_google_uuid].connection,
                          nest_google_uuid,
                        );

                        // Send updated data onto HomeKit device for it to process
                        HomeKitDevice.message(this.#trackedDevices?.[deviceData?.serialNumber]?.uuid, HomeKitDevice.UPDATE, {
                          activity_zones: this.#rawData[nest_google_uuid].value.activity_zones,
                        });
                      }
                      // eslint-disable-next-line no-unused-vars
                    } catch (error) {
                      // Empty
                    }
                  }, TIMERS.ZONES);

                  // Setup polling loop for camera/doorbell alert data, clearing any existing polling loop
                  clearInterval(this.#trackedDevices?.[deviceData.serialNumber]?.timers?.alerts);
                  this.#trackedDevices[deviceData.serialNumber].timers.alerts = setInterval(async () => {
                    try {
                      let nest_google_uuid = this.#trackedDevices?.[deviceData?.serialNumber]?.nest_google_uuid;

                      if (
                        typeof this.#trackedDevices?.[deviceData?.serialNumber]?.uuid === 'string' &&
                        typeof this.#rawData?.[nest_google_uuid]?.value === 'object'
                      ) {
                        this.#rawData[nest_google_uuid].value.alerts = await this.#getCameraActivityAlerts(
                          this.#rawData[nest_google_uuid].connection,
                          nest_google_uuid,
                        );

                        // Send updated data onto HomeKit device for it to process
                        HomeKitDevice.message(this.#trackedDevices?.[deviceData?.serialNumber]?.uuid, HomeKitDevice.UPDATE, {
                          alerts: this.#rawData[nest_google_uuid].value.alerts,
                        });
                      }
                      // eslint-disable-next-line no-unused-vars
                    } catch (error) {
                      // Empty
                    }
                  }, TIMERS.ALERTS);
                }
              }

              if (deviceModule.class.TYPE === DEVICE_TYPE.WEATHER) {
                // Setup polling loop for weather data, clearing any existing polling loop
                clearInterval(this.#trackedDevices?.[deviceData.serialNumber]?.timers?.weather);
                this.#trackedDevices[deviceData.serialNumber].timers.weather = setInterval(async () => {
                  try {
                    let nest_google_uuid = this.#trackedDevices?.[deviceData?.serialNumber]?.nest_google_uuid;

                    if (
                      typeof this.#trackedDevices?.[deviceData?.serialNumber]?.uuid === 'string' &&
                      typeof this.#rawData?.[nest_google_uuid]?.value === 'object'
                    ) {
                      this.#rawData[nest_google_uuid].value.weather = await this.#getWeather(
                        this.#rawData[nest_google_uuid].connection,
                        nest_google_uuid,
                        this.#rawData[nest_google_uuid].value.weather.latitude,
                        this.#rawData[nest_google_uuid].value.weather.longitude,
                      );

                      // Send updated data onto HomeKit device for it to process
                      HomeKitDevice.message(this.#trackedDevices?.[deviceData?.serialNumber]?.uuid, HomeKitDevice.UPDATE, {
                        current_temperature: adjustTemperature(
                          this.#rawData[nest_google_uuid].value.weather.current_temperature,
                          'C',
                          'C',
                          true,
                        ),
                        current_humidity: this.#rawData[nest_google_uuid].value.weather.current_humidity,
                        condition: this.#rawData[nest_google_uuid].value.weather.condition,
                        wind_direction: this.#rawData[nest_google_uuid].value.weather.wind_direction,
                        wind_speed: this.#rawData[nest_google_uuid].value.weather.wind_speed,
                        sunrise: this.#rawData[nest_google_uuid].value.weather.sunrise,
                        sunset: this.#rawData[nest_google_uuid].value.weather.sunset,
                        station: this.#rawData[nest_google_uuid].value.weather.station,
                        forecast: this.#rawData[nest_google_uuid].value.weather.forecast,
                      });
                    }
                    // eslint-disable-next-line no-unused-vars
                  } catch (error) {
                    // Empty
                  }
                }, TIMERS.WEATHER);
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
                  'Using %s API as data source for "%s" from connection "%s"',
                  this.#rawData[deviceData.nest_google_uuid].source,
                  deviceData.description,
                  this.#connections[this.#rawData[deviceData.nest_google_uuid].connection].name,
                );

                this.#trackedDevices[deviceData.serialNumber].source = this.#rawData[deviceData.nest_google_uuid].source;
                this.#trackedDevices[deviceData.serialNumber].nest_google_uuid = deviceData.nest_google_uuid;
              }

              // For any camera type devices, inject camera API call access credentials for that device
              // from its associated connection here
              if (
                deviceModule.class.TYPE === DEVICE_TYPE.CAMERA ||
                deviceModule.class.TYPE === DEVICE_TYPE.DOORBELL ||
                deviceModule.class.TYPE === DEVICE_TYPE.FLOODLIGHT
              ) {
                deviceData.apiAccess = this.#connections?.[this.#rawData?.[deviceData?.nest_google_uuid]?.connection]?.cameraAPI;
              }

              // Send updated data onto HomeKit device for it to process
              HomeKitDevice.message(this.#trackedDevices?.[deviceData?.serialNumber]?.uuid, HomeKitDevice.UPDATE, deviceData);
            }
          }
        }
      }
    }
  }

  async #set(uuid, nest_google_uuid, values) {
    if (
      typeof values !== 'object' ||
      typeof this.#rawData?.[nest_google_uuid] !== 'object' ||
      typeof this.#connections?.[uuid] !== 'object' ||
      this.#connections?.[uuid]?.authorised !== true
    ) {
      return;
    }

    if (this.#protobufRoot !== null && this.#rawData?.[nest_google_uuid]?.source === DATA_SOURCE.GOOGLE) {
      let updatedTraits = [];
      let commandTraits = [];
      await Promise.all(
        Object.entries(values)
          .filter(([key]) => key !== 'uuid')
          .map(async ([key, value]) => {
            let updateElement = {
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
            let commandElement = {
              resourceRequest: {
                resourceId: nest_google_uuid,
                requestId: crypto.randomUUID(),
              },
              resourceCommands: [],
            };

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
              updateElement.traitRequest.traitLabel = 'target_temperature_settings';
              updateElement.state.type_url = 'type.nestlabs.com/nest.trait.hvac.TargetTemperatureSettingsTrait';
              updateElement.state.value = this.#rawData[nest_google_uuid].value.target_temperature_settings;

              if (
                (key === 'target_temperature_low' || key === 'target_temperature') &&
                (updateElement.state.value.targetTemperature.setpointType === 'SET_POINT_TYPE_HEAT' ||
                  updateElement.state.value.targetTemperature.setpointType === 'SET_POINT_TYPE_RANGE')
              ) {
                // Changing heating target temperature
                updateElement.state.value.targetTemperature.heatingTarget = { value: value };
              }
              if (
                (key === 'target_temperature_high' || key === 'target_temperature') &&
                (updateElement.state.value.targetTemperature.setpointType === 'SET_POINT_TYPE_COOL' ||
                  updateElement.state.value.targetTemperature.setpointType === 'SET_POINT_TYPE_RANGE')
              ) {
                // Changing cooling target temperature
                updateElement.state.value.targetTemperature.coolingTarget = { value: value };
              }

              if (key === 'hvac_mode' && value.toUpperCase() !== 'OFF') {
                updateElement.state.value.targetTemperature.setpointType = 'SET_POINT_TYPE_' + value.toUpperCase();
                updateElement.state.value.enabled = { value: true };
              }

              if (key === 'hvac_mode' && value.toUpperCase() === 'OFF') {
                updateElement.state.value.enabled = { value: false };
              }

              // Tag 'who' is doing the temperature/mode change. We are ie: the device :-)
              updateElement.state.value.targetTemperature.currentActorInfo = {
                method: 'HVAC_ACTOR_METHOD_IOS',
                originator: { resourceId: nest_google_uuid },
                timeOfAction: { seconds: Math.floor(Date.now() / 1000), nanos: (Date.now() % 1000) * 1e6 },
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
              updateElement.traitRequest.traitLabel = 'eco_mode_settings';
              updateElement.state.type_url = 'type.nestlabs.com/nest.trait.hvac.EcoModeSettingsTrait';
              updateElement.state.value = this.#rawData[nest_google_uuid].value.eco_mode_settings;

              updateElement.state.value.ecoTemperatureHeat.value.value =
                updateElement.state.value.ecoTemperatureHeat.enabled === true &&
                updateElement.state.value.ecoTemperatureCool.enabled === false
                  ? value
                  : updateElement.state.value.ecoTemperatureHeat.value.value;
              updateElement.state.value.ecoTemperatureCool.value.value =
                updateElement.state.value.ecoTemperatureHeat.enabled === false &&
                updateElement.state.value.ecoTemperatureCool.enabled === true
                  ? value
                  : updateElement.state.value.ecoTemperatureCool.value.value;
              updateElement.state.value.ecoTemperatureHeat.value.value =
                updateElement.state.value.ecoTemperatureHeat.enabled === true &&
                updateElement.state.value.ecoTemperatureCool.enabled === true &&
                key === 'target_temperature_low'
                  ? value
                  : updateElement.state.value.ecoTemperatureHeat.value.value;
              updateElement.state.value.ecoTemperatureCool.value.value =
                updateElement.state.value.ecoTemperatureHeat.enabled === true &&
                updateElement.state.value.ecoTemperatureCool.enabled === true &&
                key === 'target_temperature_high'
                  ? value
                  : updateElement.state.value.ecoTemperatureCool.value.value;
            }

            if (key === 'temperature_scale' && typeof value === 'string' && (value.toUpperCase() === 'C' || value.toUpperCase() === 'F')) {
              // Set the temperature scale on the target thermostat
              updateElement.traitRequest.traitLabel = 'display_settings';
              updateElement.state.type_url = 'type.nestlabs.com/nest.trait.hvac.DisplaySettingsTrait';
              updateElement.state.value = this.#rawData[nest_google_uuid].value.display_settings;
              updateElement.state.value.temperatureScale = value.toUpperCase() === 'F' ? 'TEMPERATURE_SCALE_F' : 'TEMPERATURE_SCALE_C';
            }

            if (key === 'temperature_lock' && typeof value === 'boolean') {
              // Set lock mode on the target thermostat
              updateElement.traitRequest.traitLabel = 'temperature_lock_settings';
              updateElement.state.type_url = 'type.nestlabs.com/nest.trait.hvac.TemperatureLockSettingsTrait';
              updateElement.state.value = this.#rawData[nest_google_uuid].value.temperature_lock_settings;
              updateElement.state.value.enabled = value === true;
            }

            if (key === 'fan_state' && typeof value === 'boolean') {
              // Set fan mode on the target thermostat
              updateElement.traitRequest.traitLabel = 'fan_control_settings';
              updateElement.state.type_url = 'type.nestlabs.com/nest.trait.hvac.FanControlSettingsTrait';
              updateElement.state.value = this.#rawData[nest_google_uuid].value.fan_control_settings;
              updateElement.state.value.timerEnd =
                value === true
                  ? {
                      seconds: Number(Math.floor(Date.now() / 1000) + Number(updateElement.state.value.timerDuration.seconds)),
                      nanos: Number(
                        ((Math.floor(Date.now() / 1000) + Number(updateElement.state.value.timerDuration.seconds)) % 1000) * 1e6,
                      ),
                    }
                  : { seconds: 0, nanos: 0 };
              if (values?.fan_timer_speed !== undefined) {
                // We have a value to set fan speed also, so handle here as combined setting
                updateElement.state.value.timerSpeed =
                  values?.fan_timer_speed !== 0
                    ? 'FAN_SPEED_SETTING_STAGE' + values?.fan_timer_speed
                    : this.#rawData[nest_google_uuid].value.fan_control_settings.timerSpeed;
              }
            }

            if (key === 'fan_timer_speed' && isNaN(value) === false && values?.fan_state === undefined) {
              // Set fan speed on the target thermostat only if we're not changing fan on/off state also
              updateElement.traitRequest.traitLabel = 'fan_control_settings';
              updateElement.state.type_url = 'type.nestlabs.com/nest.trait.hvac.FanControlSettingsTrait';
              updateElement.state.value = this.#rawData[nest_google_uuid].value.fan_control_settings;
              updateElement.state.value.timerSpeed =
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
              updateElement.traitRequest.traitLabel = 'recording_toggle_settings';
              updateElement.state.type_url = 'type.nestlabs.com/nest.trait.product.camera.RecordingToggleSettingsTrait';
              updateElement.state.value = this.#rawData[nest_google_uuid].value.recording_toggle_settings;
              updateElement.state.value.targetCameraState = value === true ? 'CAMERA_ON' : 'CAMERA_OFF';
              updateElement.state.value.changeModeReason = 2;
              updateElement.state.value.settingsUpdated = {
                seconds: Math.floor(Date.now() / 1000),
                nanos: (Date.now() % 1000) * 1e6,
              };
            }

            if (key === 'audio_enabled' && typeof value === 'boolean') {
              // Enable/disable microphone on camera/doorbell
              updateElement.traitRequest.traitLabel = 'microphone_settings';
              updateElement.state.type_url = 'type.nestlabs.com/nest.trait.audio.MicrophoneSettingsTrait';
              updateElement.state.value = this.#rawData[nest_google_uuid].value.microphone_settings;
              updateElement.state.value.enableMicrophone = value;
            }

            if (key === 'indoor_chime_enabled' && typeof value === 'boolean') {
              // Enable/disable chime status on doorbell
              updateElement.traitRequest.traitLabel = 'doorbell_indoor_chime_settings';
              updateElement.state.type_url = 'type.nestlabs.com/nest.trait.product.doorbell.DoorbellIndoorChimeSettingsTrait';
              updateElement.state.value = this.#rawData[nest_google_uuid].value.doorbell_indoor_chime_settings;
              updateElement.state.value.chimeEnabled = value;
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
                  commandElement.resourceRequest.requestId = serviceUUID;
                  commandElement.resourceCommands = [
                    {
                      traitLabel: 'on_off',
                      command: {
                        type_url: 'type.nestlabs.com/weave.trait.actuator.OnOffTrait.SetStateRequest',
                        value: {
                          on: value,
                        },
                      },
                    },
                  ];
                }
              }
            }

            if (key === 'light_brightness' && isNaN(value) === false) {
              // Set light brightness on supported camera devices
              updateElement.traitRequest.traitLabel = 'floodlight_settings';
              updateElement.state.type_url = 'type.nestlabs.com/google.trait.product.camera.FloodlightSettingsTrait';
              updateElement.state.value = this.#rawData[nest_google_uuid].value.floodlight_settings;
              updateElement.state.value.brightness = scaleValue(Number(value), 0, 100, 0, 10); // Scale to required level
            }

            if (
              key === 'active_sensor' &&
              typeof value === 'boolean' &&
              typeof this.#rawData?.[this.#rawData[nest_google_uuid]?.value?.associated_thermostat]?.value
                ?.remote_comfort_sensing_settings === 'object'
            ) {
              // Set active temperature sensor for associated thermostat
              updateElement.traitRequest.resourceId = this.#rawData[nest_google_uuid].value.associated_thermostat;
              updateElement.traitRequest.traitLabel = 'remote_comfort_sensing_settings';
              updateElement.state.type_url = 'type.nestlabs.com/nest.trait.hvac.RemoteComfortSensingSettingsTrait';
              updateElement.state.value =
                this.#rawData[this.#rawData[nest_google_uuid].value.associated_thermostat].value.remote_comfort_sensing_settings;
              updateElement.state.value.activeRcsSelection =
                value === true
                  ? { rcsSourceType: 'RCS_SOURCE_TYPE_SINGLE_SENSOR', activeRcsSensor: { resourceId: nest_google_uuid } }
                  : { rcsSourceType: 'RCS_SOURCE_TYPE_BACKPLATE' };
            }

            if (key === 'hot_water_boost_active' && typeof value === 'object') {
              // Turn hotwater boost heating on/off
              updateElement.traitRequest.traitLabel = 'hot_water_settings';
              updateElement.state.type_url = 'type.nestlabs.com/nest.trait.hvac.HotWaterSettingsTrait';
              updateElement.state.value = this.#rawData[nest_google_uuid].value.hot_water_settings;
              updateElement.state.value.boostTimerEnd =
                value?.state === true
                  ? {
                      seconds: Number(Math.floor(Date.now() / 1000) + Number(isNaN(value?.time) === false ? value?.time : 30 * 60)),
                      nanos: Number(
                        (Math.floor(Date.now() / 1000) + (Number(isNaN(value?.time) === false ? value?.time : 30 * 60) % 1000)) * 1e6,
                      ),
                    }
                  : { seconds: 0, nanos: 0 };
            }

            if (key === 'hot_water_temperature' && isNaN(value) === false) {
              // Set hotwater boiler temperature
              updateElement.traitRequest.traitLabel = 'hot_water_settings';
              updateElement.state.type_url = 'type.nestlabs.com/nest.trait.hvac.HotWaterSettingsTrait';
              updateElement.state.value = this.#rawData[nest_google_uuid].value.hot_water_settings;
              updateElement.state.value.temperature.value = value;
            }

            if (key === 'bolt_lock' && typeof value === 'boolean') {
              // Set lock state
              commandElement.resourceCommands = [
                {
                  traitLabel: 'bolt_lock',
                  command: {
                    type_url: 'type.nestlabs.com/weave.trait.security.BoltLockTrait.BoltLockChangeRequest',
                    value: {
                      state: value === true ? 'BOLT_STATE_EXTENDED' : 'BOLT_STATE_RETRACTED',
                      boltLockActor: {
                        method: 'BOLT_LOCK_ACTOR_METHOD_REMOTE_USER_EXPLICIT',
                        originator: { resourceId: nest_google_uuid },
                        agent: null,
                      },
                    },
                  },
                },
              ];
            }

            if (key === 'auto_relock_duration' && isNaN(value) === false) {
              // Set lock auto-relock duration
              updateElement.traitRequest.traitLabel = 'bolt_lock_settings';
              updateElement.state.type_url = 'type.nestlabs.com/weave.trait.security.BoltLockSettingsTrait';
              updateElement.state.value = this.#rawData[nest_google_uuid].value.bolt_lock_settings;
              updateElement.state.value.autoRelockDuration.seconds = value;
            }

            if (updateElement.traitRequest.traitLabel !== '' && updateElement.state.type_url !== '') {
              updatedTraits.push(structuredClone(updateElement));
            }

            if (Array.isArray(commandElement?.resourceCommands) === true && commandElement.resourceCommands.length !== 0) {
              commandTraits.push(structuredClone(commandElement));
            }
          }),
      );

      // Perform any direct trait updates we have todo. This can be done via a single call in a batch
      if (updatedTraits.length !== 0) {
        let commandResponse = await this.#protobufCommand(uuid, 'TraitBatchApi', 'BatchUpdateState', {
          batchUpdateStateRequest: updatedTraits,
        });
        if (
          commandResponse === undefined ||
          commandResponse?.batchUpdateStateResponse?.[0]?.traitOperations?.[0]?.progress !== 'COMPLETE'
        ) {
          this?.log?.debug?.('Protobuf API had error updating traits for device uuid "%s"', nest_google_uuid);
        }
      }

      // Perform any trait updates required via resource commands. Each one is done seperately
      if (commandTraits.length !== 0) {
        for (let command of commandTraits) {
          let commandResponse = await this.#protobufCommand(uuid, 'ResourceApi', 'SendCommand', structuredClone(command));
          if (commandResponse === undefined || commandResponse.sendCommandResponse?.[0]?.traitOperations?.[0]?.progress !== 'COMPLETE') {
            this?.log?.debug?.(
              'Protobuf API had error setting "%s" for device uuid "%s"',
              command.resourceCommands?.[0].traitLabel,
              nest_google_uuid,
            );
          }
        }
      }
    }

    if (this.#rawData?.[nest_google_uuid]?.source === DATA_SOURCE.NEST && nest_google_uuid.startsWith('quartz.') === true) {
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
                  timeout: TIMERS.NEST_API,
                },
                mappedKey + '=' + value + '&uuid=' + nest_google_uuid.split('.')[1],
              );

              let data = await response.json();
              if (data?.status !== 0) {
                throw new Error('Nest API camera update failed');
              }
            } catch (error) {
              if (error?.cause !== undefined && String(error.cause).toUpperCase().includes('TIMEOUT') === false) {
                this?.log?.debug?.('Nest API camera update failed for device uuid "%s". Error was "%s"', nest_google_uuid, error?.code);
              }
            }
          }),
      );
    }

    if (this.#rawData?.[nest_google_uuid]?.source === DATA_SOURCE.NEST && nest_google_uuid.startsWith('quartz.') === false) {
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
              // Set thermostat settings. Some settings are located in a different object location, so we handle this below also
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
                  this?.log?.debug?.('Nest API property update failed for device uuid "%s". Error was "%s"', nest_google_uuid, error?.code);
                }
              }
            }
          }),
      );
    }
  }

  async #get(uuid, nest_google_uuid, values) {
    if (
      typeof values !== 'object' ||
      typeof this.#rawData?.[nest_google_uuid] !== 'object' ||
      typeof this.#connections?.[uuid] !== 'object' ||
      this.#connections?.[uuid]?.authorised !== true
    ) {
      return;
    }

    await Promise.all(
      Object.entries(values)
        .filter(([key]) => key !== 'uuid')
        .map(async ([key]) => {
          // We'll return the data under the original key value
          // By default, the returned value will be undefined. If call is successful, the key value will have the data requested
          values[key] = undefined;

          if (
            this.#rawData?.[nest_google_uuid]?.source === DATA_SOURCE.NEST &&
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
                  'Nest API camera snapshot failed with error for device uuid "%s". Error was "%s"',
                  nest_google_uuid,
                  error?.code,
                );
              }
            }
          }

          if (
            this.#rawData?.[nest_google_uuid]?.source === DATA_SOURCE.GOOGLE &&
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
                    'Protobuf API camera snapshot failed with error for device uuid "%s". Error was "%s"',
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

  async #getWeather(uuid, nest_google_uuid, latitude, longitude) {
    let weather =
      typeof this.#rawData?.[nest_google_uuid]?.value?.weather === 'object' ? this.#rawData[nest_google_uuid].value.weather : {};

    let location = latitude + ',' + longitude;
    if (typeof this.#connections?.[uuid]?.weather_url === 'string' && this.#connections[uuid].weather_url !== '') {
      try {
        let response = await fetchWrapper('get', this.#connections[uuid].weather_url + location, {
          referer: 'https://' + this.#connections[uuid].referer,
          headers: {
            'User-Agent': USER_AGENT,
          },
          timeout: TIMERS.NEST_API,
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
          this?.log?.debug?.(
            'Nest API failed to retrieve weather details for device uuid "%s". Error was "%s"',
            nest_google_uuid,
            error?.code,
          );
        }
      }
    }

    return weather;
  }

  async #getCameraActivityZones(uuid, nest_google_uuid) {
    if (
      typeof this.#connections?.[uuid] !== 'object' ||
      (this.#connections?.[uuid]?.authorised !== true && typeof nest_google_uuid !== 'string') ||
      nest_google_uuid === ''
    ) {
      // Not a valid connection object and/or we're not authorised
      return;
    }

    let activityZones =
      typeof this.#rawData?.[nest_google_uuid]?.value?.activity_zones === 'object'
        ? this.#rawData[nest_google_uuid].value.activity_zones
        : [];

    if (this.config?.options?.useNestAPI === true && nest_google_uuid.startsWith('quartz.') === true) {
      try {
        let response = await fetchWrapper('get', 'https://nexusapi.dropcam.com/cuepoint_category/' + nest_google_uuid.split('.')[1], {
          headers: {
            referer: 'https://' + this.#connections[uuid].referer,
            'User-Agent': USER_AGENT,
            [this.#connections[uuid].cameraAPI.key]: this.#connections[uuid].cameraAPI.value + this.#connections[uuid].cameraAPI.token,
          },
          timeout: TIMERS.ZONES,
        });
        let data = await response.json();

        // Transform zones if present in the returned data
        if (Array.isArray(data) === true) {
          activityZones = data
            .filter((zone) => zone?.type?.toUpperCase() === 'ACTIVITY' || zone?.type?.toUpperCase() === 'REGION')
            .map((zone) => ({
              id: zone.id === 0 ? 1 : zone.id,
              name: HomeKitDevice.makeValidHKName(zone.label),
              hidden: zone.hidden === true,
              uri: zone.nexusapi_image_uri,
            }));
        }
      } catch (error) {
        if (error?.cause !== undefined && String(error.cause).toUpperCase().includes('TIMEOUT') === false) {
          this?.log?.debug?.(
            'Nest API had error retrieving camera/doorbell activity zones for device "%s". Error was "%s"',
            nest_google_uuid,
            error?.code === undefined ? String(error) : error.code,
          );
        }
      }
    }
    return activityZones;
  }

  async #getCameraActivityAlerts(uuid, nest_google_uuid) {
    if (typeof this.#connections?.[uuid] !== 'object' || this.#connections?.[uuid]?.authorised !== true) {
      // Not a valid connection object and/or we're not authorised
      return;
    }

    let alerts = typeof this.#rawData?.[nest_google_uuid]?.value?.alerts === 'object' ? this.#rawData[nest_google_uuid].value.alerts : [];

    if (this.config?.options?.useGoogleAPI === true && this.#rawData?.[nest_google_uuid]?.source === DATA_SOURCE.GOOGLE) {
      let commandResponse = await this.#protobufCommand(uuid, 'ResourceApi', 'SendCommand', {
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
      });

      if (
        Array.isArray(commandResponse?.sendCommandResponse?.[0]?.traitOperations?.[0]?.event?.event?.cameraEventWindow?.cameraEvent) ===
        true
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

    if (this.config?.options?.useNestAPI === true && this.#rawData?.[nest_google_uuid]?.source === DATA_SOURCE.NEST) {
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
              referer: 'https://' + this.#connections[uuid].referer,
              'User-Agent': USER_AGENT,
              [this.#connections[uuid].cameraAPI.key]: this.#connections[uuid].cameraAPI.value + this.#connections[uuid].cameraAPI.token,
            },
            timeout: TIMERS.ALERTS,
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
            'Nest API had error retrieving camera/doorbell activity notifications for device "%s". Error was "%s"',
            nest_google_uuid,
            error?.code === undefined ? String(error) : error.code,
          );
        }
      }
    }

    return alerts;
  }

  async #protobufCommand(uuid, service, command, values) {
    if (
      this.#protobufRoot === null ||
      typeof uuid !== 'string' ||
      uuid === '' ||
      typeof service !== 'string' ||
      service === '' ||
      typeof command !== 'string' ||
      command === '' ||
      typeof values !== 'object' ||
      this.#connections?.[uuid] === undefined ||
      this.#connections?.[uuid]?.authorised !== true ||
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
