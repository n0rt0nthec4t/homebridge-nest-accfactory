// Nest System communications
// Part of homebridge-nest-accfactory
//
// Code version 2026.02.20
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
import { URL } from 'node:url';

// Import our modules
import HomeKitDevice from './HomeKitDevice.js';
import { loadDeviceModules, getDeviceHKCategory } from './devices.js';
import { processConfig, buildConnections } from './config.js';
import { adjustTemperature, scaleValue, fetchWrapper, logJSONObject } from './utils.js';

// Define constants
import { TIMERS, USER_AGENT, __dirname, DATA_SOURCE, DEVICE_TYPE, ACCOUNT_TYPE, NEST_API_BUCKETS, PROTOBUF_RESOURCES } from './consts.js';

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
      // We got notified that Homebridge has finished loading

      // Load device support modules from the plugins folder if not already done
      this.#deviceModules = await loadDeviceModules(this.log, 'plugins');

      // Load protobuf files for Google API
      this.#loadProtobufRoot();

      // Start reconnect loop per connection with backoff for failed tries
      // This also initiates both Nest API subscribes and Google API observes
      for (const uuid of Object.keys(this.#connections)) {
        let reconnectDelay = 15000;

        const reconnectLoop = async () => {
          if (this.#connections?.[uuid]?.authorised !== true && this.#connections?.[uuid]?.allowRetry !== false) {
            try {
              await this.#connect(uuid);
              this.#subscribeNestAPI(uuid);
              this.#observeGoogleAPI(uuid);
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
      this.#deviceModules?.clear?.();
      this.cachedAccessories = [];
    });
  }

  configureAccessory(accessory) {
    // This gets called from Homebridge each time it restores an accessory from its cache
    this?.log?.info?.('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache, so we can track if it has already been registered
    this.cachedAccessories.push(accessory);
  }

  async #connect(uuid) {
    if (typeof this.#connections?.[uuid] !== 'object') {
      return;
    }

    // If allowRety is true, we assume this is NOT the first connection attempyt, so we'll only use debug level logging
    // Other wise, we'll use info level
    this?.log?.[this.#connections[uuid].allowRetry === true ? 'debug' : 'info']?.(
      'Performing authorisation for connection "%s" %s',
      this.#connections[uuid].name,
      this.#connections[uuid].fieldTest === true ? 'using field test endpoints' : '',
    );

    if (this.#connections[uuid].type === ACCOUNT_TYPE.GOOGLE) {
      // Authorisation using Google account (cookie-based since 2022)
      try {
        let tokenResponse = await fetchWrapper('get', this.#connections[uuid].issuetoken, {
          headers: {
            Referer: 'https://accounts.google.com/',
            Cookie: this.#connections[uuid].cookie,
            'User-Agent': USER_AGENT,
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'X-Requested-With': 'XmlHttpRequest',
          },
        });

        let tokenData = await tokenResponse.json();

        if (typeof tokenData?.error === 'string') {
          let error = new Error(
            (tokenData?.detail ? String(tokenData.detail) : '') + (tokenData?.error ? ' (' + String(tokenData.error) + ')' : ''),
          );
          error.name = 'GoogleAuthError';
          error.code = tokenData.error;
          error.statusText = tokenData.detail || 'OAuth error';
          throw error;
        }

        let googleOAuth2Token = tokenData.access_token.trim();

        let jwtResponse = await fetchWrapper(
          'post',
          'https://nestauthproxyservice-pa.googleapis.com/v1/issue_jwt',
          {
            headers: {
              Referer: 'https://' + this.#connections[uuid].referer,
              Origin: 'https://' + this.#connections[uuid].referer,
              Authorization: tokenData.token_type + ' ' + tokenData.access_token,
              'User-Agent': USER_AGENT,
              'Content-Type': 'application/json',
              'Sec-Fetch-Mode': 'cors',
              'Sec-Fetch-Site': 'cross-site',
            },
          },
          {
            policy_id: 'authproxy-oauth-policy',
            google_oauth_access_token: tokenData.access_token,
            embed_google_oauth_access_token: true,
            expire_after: '3600s',
          },
        );

        let jwtData = await jwtResponse.json();
        if ((jwtData?.jwt?.trim?.() ?? '') === '') {
          this?.log?.debug?.('JWT response object', jwtData);
          throw new Error('Missing jwt in JWT response');
        }

        let sessionResponse = await fetchWrapper('get', new URL('/session', 'https://' + this.#connections[uuid].restAPIHost).href, {
          headers: {
            Referer: 'https://' + this.#connections[uuid].referer,
            Origin: 'https://' + this.#connections[uuid].referer,
            Authorization: 'Basic ' + jwtData.jwt,
            'User-Agent': USER_AGENT,
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
          },
        });

        let sessionData = await sessionResponse.json();

        if ((sessionData?.access_token?.trim?.() ?? '') === '') {
          this?.log?.debug?.('Nest session response object', sessionData);
          throw new Error('Missing access_token in session response');
        }

        this?.log?.[this.#connections[uuid].allowRetry === true ? 'debug' : 'success']?.(
          this.#connections[uuid].allowRetry === true
            ? 'Successfully performed token refresh using Google account for connection "%s"'
            : 'Successfully authorised using Google account for connection "%s"',
          this.#connections[uuid].name,
        );

        // Store authorised session details
        Object.assign(this.#connections[uuid], {
          authorised: true,
          allowRetry: true,
          userID: sessionData.userid,
          transport_url: sessionData.urls.transport_url,
          weather_url: sessionData.urls.weather_url,
          token: sessionData.access_token,
          cameraAPI: {
            key: 'Authorization',
            value: 'Basic ',
            token: sessionData.access_token,
            oauth2: googleOAuth2Token,
            fieldTest: this.#connections[uuid]?.fieldTest === true, // preserve fieldTest flag
          },
        });

        clearTimeout(this.#connections[uuid].timer);
        this.#connections[uuid].timer = setTimeout(
          () => {
            this?.log?.debug?.('Performing periodic token refresh using Google account for connection "%s"', this.#connections[uuid].name);
            this.#connections[uuid].allowRetry = true;
            this.#connect(uuid);
          },
          (tokenData.expires_in - 300) * 1000, // Refresh Google token, 5mins before expires
        );
      } catch (error) {
        // Attempt to extract HTTP status code from error cause or error object
        let statusCode = error && error.code !== null ? error.code : error && error.status !== null ? error.status : undefined;
        if (statusCode === 'USER_LOGGED_OUT' || statusCode === 'ERR_INVALID_URL' || statusCode === 401 || statusCode === 403) {
          // If unauthorised or forbidden, we won't continue to retry
          this.#connections[uuid].allowRetry = false;
        }

        this.#connections[uuid].authorised = false;
        this?.log?.debug?.(
          'Failed to connect using Google credentials for connection "%s" %s: Error was "%s"',
          this.#connections[uuid].name,
          this.#connections[uuid].allowRetry === true ? 'will retry' : 'will not retry',
          typeof error?.message === 'string' ? error.message : String(error),
        );

        this?.log?.error?.(
          this.#connections[uuid].allowRetry === true
            ? 'Token refresh failed using Google account for connection "%s"'
            : 'Authorisation failed using Google account for connection "%s"',
          this.#connections[uuid].name,
        );
      }
    }

    if (this.#connections[uuid].type === ACCOUNT_TYPE.NEST) {
      // Authorisation using legacy Nest account
      try {
        // Login to get website_2/ft session token
        let loginResponse = await fetchWrapper(
          'post',
          new URL('/api/v1/login.login_nest', 'https://webapi.' + this.#connections[uuid].cameraAPIHost).href,
          {
            withCredentials: true,
            headers: {
              Referer: 'https://' + this.#connections[uuid].referer,
              Origin: 'https://' + this.#connections[uuid].referer,
              'User-Agent': USER_AGENT,
              'Content-Type': 'application/x-www-form-urlencoded',
              'Sec-Fetch-Mode': 'cors',
              'Sec-Fetch-Site': 'same-origin',
            },
          },
          Buffer.from('access_token=' + this.#connections[uuid].access_token, 'utf8'),
        );

        let loginData = await loginResponse.json();
        if (typeof loginData?.status === 'number' && (loginData?.items?.[0]?.session_token.trim?.() ?? '') === '') {
          let error = new Error(
            (loginData?.status_detail ? String(loginData.status_detail) : '') +
              (loginData?.status_description ? ' (' + String(loginData.status_description) + ')' : '') +
              (loginData?.status_detail || loginData?.status_description ? '' : 'Nest login failed with status ' + loginData.status),
          );
          error.name = 'NestAuthError';
          error.code = loginData.status;
          error.message = loginData?.status_description || 'Error';
          throw error;
        }

        let nestToken = loginData.items[0].session_token;

        // Once we have session token, get further details we need
        let sessionResponse = await fetchWrapper('get', new URL('/session', 'https://' + this.#connections[uuid].restAPIHost).href, {
          headers: {
            Referer: 'https://' + this.#connections[uuid].referer,
            Origin: 'https://' + this.#connections[uuid].referer,
            Authorization: 'Basic ' + this.#connections[uuid].access_token,
            'User-Agent': USER_AGENT,
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
          },
        });

        let sessionData = await sessionResponse.json();

        this?.log?.[this.#connections[uuid].allowRetry === true ? 'debug' : 'success']?.(
          this.#connections[uuid].allowRetry === true
            ? 'Successfully performed token refresh using Nest account for connection "%s"'
            : 'Successfully authorised using Nest account for connection "%s"',
          this.#connections[uuid].name,
        );

        // Store authorised session details
        Object.assign(this.#connections[uuid], {
          authorised: true,
          allowRetry: true,
          userID: sessionData.userid,
          transport_url: sessionData.urls.transport_url,
          weather_url: sessionData.urls.weather_url,
          token: sessionData.access_token,
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
            this.#connections[uuid].allowRetry = true;
            this.#connect(uuid);
          },
          1000 * 3600 * 24, // Refresh Nest session token every 24hrs
        );
      } catch (error) {
        // Attempt to extract HTTP status code from error cause or error object
        let statusCode = error && error.code !== null ? error.code : error && error.status !== null ? error.status : undefined;
        if (statusCode === 'ERR_INVALID_URL' || statusCode === 401 || statusCode === 403) {
          // If unauthorised or forbidden, we won't continue to retry
          this.#connections[uuid].allowRetry = false;
        }

        this.#connections[uuid].authorised = false;
        this?.log?.debug?.(
          'Failed to connect using Nest credentials for connection "%s" %s: Error was "%s"',
          this.#connections[uuid].name,
          this.#connections[uuid].allowRetry === true ? 'will retry' : 'will not retry',
          typeof error?.message === 'string' ? error.message : String(error),
        );

        this?.log?.error?.(
          this.#connections[uuid].allowRetry === true
            ? 'Token refresh failed using Nest account for connection "%s"'
            : 'Authorisation failed using Nest account for connection "%s"',
          this.#connections[uuid].name,
        );
      }
    }
  }

  async #subscribeNestAPI(uuid, firstRun = true, fullRead = true) {
    if (
      typeof this.#connections?.[uuid] !== 'object' ||
      this.#connections?.[uuid]?.authorised !== true ||
      this.config?.options?.useNestAPI !== true
    ) {
      // Not a valid connection object and/or we're not authorised
      return;
    }

    // By default, setup for a full data read from the Nest API
    let subscribeJSONData = undefined;
    if (firstRun !== false || fullRead !== false) {
      this?.log?.debug?.('Starting Nest API subscribe for connection "%s"', this.#connections[uuid].name);
      subscribeJSONData = { known_bucket_types: NEST_API_BUCKETS, known_bucket_versions: [] };
    }

    // We have data stored from this Nest API, so setup read using known object
    // We exclude any data source other than from Nest API and also any injected data
    if (firstRun === false || fullRead === false) {
      subscribeJSONData = { objects: [] };
      subscribeJSONData.objects.push(
        ...Object.entries(this.#rawData)
          // eslint-disable-next-line no-unused-vars
          .filter(([key, value]) => value.source === DATA_SOURCE.NEST && value.connection === uuid && value?.injected !== true)
          .map(([key, value]) => ({
            object_key: key,
            object_revision: value.object_revision,
            object_timestamp: value.object_timestamp,
          })),
      );
    }

    fetchWrapper(
      'post',
      subscribeJSONData?.objects !== undefined
        ? new URL('/v5/subscribe', this.#connections[uuid].transport_url).href
        : new URL('/api/0.1/user/' + this.#connections[uuid].userID + '/app_launch', 'https://' + this.#connections[uuid].restAPIHost).href,
      {
        headers: {
          Referer: 'https://' + this.#connections[uuid].referer,
          Origin: 'https://' + this.#connections[uuid].referer,
          Authorization: 'Basic ' + this.#connections[uuid].token,
          Connection: 'keep-alive',
          'User-Agent': USER_AGENT,
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          'X-nl-protocol-version': 1,
          'Content-Type': 'application/json',
        },
        retry: 3,
      },
      subscribeJSONData,
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
            // Since we have a structure key, need to add in weather data for the location using stored post/country codes
            value.value.weather = await this.#getWeather(uuid, value.object_key, value.value.postal_code, value.value.country_code);

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

            // Store the internal Nest structure uuid if matched to a defined home array entry
            Object.assign(
              this.config?.homes?.find((home) => home?.name?.trim?.().toUpperCase() === value?.value?.name?.trim?.().toUpperCase()) || {},
              { nest_home_uuid: value.object_key },
            );
          }

          if (value.object_key.startsWith('quartz.') === true) {
            // Get camera/doorbell additional properties we require
            let properties = await this.#getCameraProperties(uuid, value.object_key, value.value.nexus_api_http_server_url);
            value.value.properties =
              typeof properties === 'object' && properties.constructor === Object
                ? properties
                : typeof this.#rawData?.[value.object_key]?.value?.properties === 'object' &&
                    this.#rawData?.[value.object_key]?.value?.properties.constructor === Object
                  ? this.#rawData[value.object_key].value.properties
                  : {};

            // Get camera/doorbell activity zones
            let zones = await this.#getCameraActivityZones(uuid, value.object_key, value.value.nexus_api_http_server_url);
            value.value.activity_zones =
              Array.isArray(zones) === true
                ? zones
                : Array.isArray(this.#rawData?.[value.object_key]?.value?.activity_zones) === true
                  ? this.#rawData[value.object_key].value.activity_zones
                  : [];
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

        // Dump the raw data if configured to do so
        // This can be used for user support, rather than specific build to dump this :-)
        if (this?.config?.options?.rawdump === true && this.#connections[uuid]?.doneNestRawDump !== true) {
          this.#connections[uuid].doneNestRawDump = true; // Done once
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

        // If we get a 401 Unauthorized or 403 Forbidden and the connection was previously authorised,
        // mark it as unauthorised so the reconnect loop will handle it
        if ((statusCode === 401 || statusCode === 403) && this.#connections?.[uuid]?.authorised === true) {
          this?.log?.debug?.(
            'Connection "' + this.#connections[uuid].name + '" is no longer authorised with the Nest API, will attempt to reconnect',
          );
          this.#connections[uuid].authorised = false;
          this.#connections[uuid].allowRetry = true;
          return;
        }

        // Log unexpected errors (excluding timeouts) for debugging
        if (
          error?.cause === undefined ||
          (error.cause?.message?.toUpperCase?.()?.includes('TIMEOUT') === false &&
            error.cause?.code?.toUpperCase?.()?.includes('TIMEOUT') === false)
        ) {
          this?.log?.debug?.(
            'Nest API had an error performing subscription with connection "%s". Error was "%s"',
            this.#connections[uuid].name,
            typeof error?.message === 'string' ? error.message : String(error),
          );
        }
      })
      .finally(() => {
        // Only continue the subscription loop if the connection is still authorised
        if (this.#connections?.[uuid]?.authorised === true) {
          setTimeout(() => this.#subscribeNestAPI(uuid, false, fullRead), 1000);
        }
      });
  }

  async #observeGoogleAPI(uuid, firstRun = true) {
    if (
      this.#protobufRoot === undefined ||
      this.#protobufRoot === null ||
      typeof this.#connections?.[uuid] !== 'object' ||
      this.#connections?.[uuid]?.authorised !== true ||
      this.config?.options?.useGoogleAPI !== true
    ) {
      // Not a valid connection object and/or we're not authorised
      return;
    }

    const traverseTypes = (trait, callback) => {
      if (trait instanceof protobuf.Type) {
        callback(trait);
      }

      let nestedItems = trait?.nestedArray ?? [];
      for (let nested of nestedItems) {
        traverseTypes(nested, callback);
      }
    };

    // Dynamically build the 'observe' post body data
    let observeTraitsList = [];
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
        observeTraitsList.push({ traitType: type.fullName.replace(/^\.*|\.*$/g, '') });
      }
    });

    if (firstRun === true || firstRun === undefined) {
      this?.log?.debug?.('Starting Google API observe for connection "%s"', this.#connections[uuid].name);
    }

    this.#protobufCommand(
      uuid,
      'nestlabs.gateway.v2.GatewayService',
      'Observe',
      { stateTypes: ['CONFIRMED', 'ACCEPTED'], traitTypeParams: observeTraitsList },
      async (message) => {
        // We'll use the resource status message to look for structure and/or device removals
        // We could also check for structure and/or device additions here, but we'll want to be flagged
        // that a device is 'ready' for use before we add in. This data is populated in the trait data
        if (Array.isArray(message?.observeResponse?.[0]?.resourceMetas) === true) {
          message.observeResponse[0].resourceMetas.map(async (resource) => {
            if (
              resource.status === 'REMOVED' &&
              (resource.resourceId.startsWith('STRUCTURE_') || resource.resourceId.startsWith('DEVICE_'))
            ) {
              // We have the removal of a 'home' and/or device
              // Tidy up tracked devices since this one is removed
              if (this.#trackedDevices[this.#rawData?.[resource.resourceId]?.value?.device_identity?.serialNumber] !== undefined) {
                // Remove any active running timers we have for this device
                if (this.#trackedDevices[this.#rawData[resource.resourceId].value.device_identity.serialNumber]?.timers !== undefined) {
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

        if (Array.isArray(message?.observeResponse?.[0]?.traitStates) === true) {
          // Tidy up our received trait states. This ensures we only have one status for the trait in the data we process
          // We'll favour a trait with accepted status over the same with confirmed status
          let traits = message.observeResponse[0].traitStates;
          let accepted = traits.filter((trait) => trait.stateTypes.includes('ACCEPTED') === true);
          let acceptedKeys = new Set(accepted.map((t) => t.traitId.resourceId + '/' + t.traitId.traitLabel));
          let others = traits.filter((trait) => acceptedKeys.has(trait.traitId.resourceId + '/' + trait.traitId.traitLabel) === false);
          message.observeResponse[0].traitStates = [...others, ...accepted];

          for (let trait of message.observeResponse[0].traitStates) {
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
              (trait.patch.values?.postalCode?.value?.trim?.() ?? '') !== '' &&
              (trait.patch.values?.countryCode?.value?.trim?.() ?? '') !== ''
            ) {
              this.#rawData[trait.traitId.resourceId].value.weather = await this.#getWeather(
                uuid,
                trait.traitId.resourceId,
                trait.patch.values.postalCode.value,
                trait.patch.values.countryCode.value,
              );
            }

            // Store the internal Nest and Google structure uuids if matched to a defined home array entry
            if (
              trait.traitId.resourceId.startsWith('STRUCTURE_') === true &&
              trait.traitId.traitLabel === 'structure_info' &&
              (trait.patch.values?.name?.trim?.() ?? '') !== ''
            ) {
              Object.assign(
                this.config?.homes?.find(
                  (home) => home?.name?.trim?.().toUpperCase() === trait.patch.values.name?.trim?.().toUpperCase(),
                ) || {},
                { nest_home_uuid: trait.patch.values.rtsStructureId, google_home_uuid: trait.traitId.resourceId },
              );
            }
          }

          // Dump the raw data if configured to do so
          // This can be used for user support, rather than specific build to dump this :-)
          if (this?.config?.options?.rawdump === true && this.#connections[uuid]?.doneGoogleRawDump !== true) {
            this.#connections[uuid].doneGoogleRawDump = true; // Done once
            Object.entries(this.#rawData)
              .filter(([, data]) => data?.source === DATA_SOURCE.GOOGLE)
              .forEach(([serial, data]) => {
                this?.log?.debug?.('Raw data [%s]', serial);
                logJSONObject(this.log, data);
              });
          }

          await this.#processData();
        }
      },
    ).finally(() => {
      // Only continue the observe loop if the connection is still authorised
      if (this.#connections?.[uuid]?.authorised === true) {
        setTimeout(() => this.#observeGoogleAPI(uuid, false), 1000);
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
          this?.log?.warn?.('%s module failed to process data. Error was "%s"', deviceType, String(error));
        }
        if (devices && typeof devices === 'object') {
          for (let deviceData of Object.values(devices)) {
            if (this.#trackedDevices?.[deviceData?.serialNumber] === undefined && deviceData?.excluded === true) {
              // We haven't tracked this device before (ie: should be a new one) and but its excluded
              let homeName =
                this.#rawData?.[deviceData.nest_google_home_uuid]?.value?.name ||
                this.#rawData?.[deviceData.nest_google_home_uuid]?.value?.structure_info?.name;
              this?.log?.warn?.(
                'Device "%s"%s is ignored due to it being marked as excluded',
                deviceData.description,
                (homeName?.trim?.() ?? '') !== '' ? ' in "' + homeName + '"' : '',
              );

              // Track this device even though its excluded
              this.#trackedDevices[deviceData.serialNumber] = {
                uuid: HomeKitDevice.generateUUID(HomeKitDevice.PLUGIN_NAME, this.api, deviceData.serialNumber),
                nest_google_device_uuid: deviceData.nest_google_device_uuid,
                source: undefined, // gets filled out later
                timers: undefined,
                exclude: true,
              };

              // If the device is now marked as excluded and present in accessory cache
              // Then we'll unregister it from the Homebridge platform
              let accessory = this.cachedAccessories.find(
                (accessory) => accessory?.UUID === this.#trackedDevices[deviceData.serialNumber].uuid,
              );

              if (accessory !== undefined && typeof accessory === 'object') {
                try {
                  this.api.unregisterPlatformAccessories(HomeKitDevice.PLUGIN_NAME, HomeKitDevice.PLATFORM_NAME, [accessory]);
                  // eslint-disable-next-line no-unused-vars
                } catch (error) {
                  // Empty
                }
              }
            }

            if (this.#trackedDevices?.[deviceData?.serialNumber] === undefined && deviceData?.excluded === false) {
              // We haven't tracked this device before (ie: should be a new one) and its not excluded
              // so create the required HomeKit accessories based upon the device data
              if (
                typeof deviceModule?.class === 'function' &&
                (deviceModule.class.TYPE?.trim?.() ?? '') !== '' &&
                (deviceModule.class.VERSION?.trim?.() ?? '') !== ''
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
                  nest_google_device_uuid: deviceData.nest_google_device_uuid,
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
                      let nest_google_device_uuid = this.#trackedDevices?.[deviceData?.serialNumber]?.nest_google_device_uuid;

                      if (
                        typeof nest_google_device_uuid === 'string' &&
                        nest_google_device_uuid !== '' &&
                        this.#trackedDevices?.[deviceData?.serialNumber]?.uuid &&
                        this.#trackedDevices[deviceData.serialNumber].source === DATA_SOURCE.NEST &&
                        typeof this.#rawData?.[nest_google_device_uuid]?.value === 'object'
                      ) {
                        let zones = await this.#getCameraActivityZones(
                          this.#rawData[nest_google_device_uuid].connection,
                          nest_google_device_uuid,
                          this.#rawData[nest_google_device_uuid].value.nexus_api_http_server_url,
                        );

                        if (Array.isArray(zones) === true) {
                          this.#rawData[nest_google_device_uuid].value.activity_zones = zones;

                          // Send updated data onto HomeKit device for it to process
                          HomeKitDevice.message(this.#trackedDevices[deviceData.serialNumber].uuid, HomeKitDevice.UPDATE, {
                            activity_zones: zones,
                          });
                        }
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
                      let nest_google_device_uuid = this.#trackedDevices?.[deviceData?.serialNumber]?.nest_google_device_uuid;
                      if (
                        (this.#trackedDevices?.[deviceData?.serialNumber]?.uuid ?? '') !== '' &&
                        typeof this.#rawData?.[nest_google_device_uuid]?.value === 'object'
                      ) {
                        let alerts = await this.#getCameraActivityAlerts(
                          this.#rawData[nest_google_device_uuid].connection,
                          nest_google_device_uuid,
                          this.#rawData[nest_google_device_uuid]?.value?.nexus_api_http_server_url ?? undefined,
                        );

                        if (Array.isArray(alerts) === true) {
                          this.#rawData[nest_google_device_uuid].value.alerts = alerts;

                          // Send updated data onto HomeKit device for it to process
                          HomeKitDevice.message(this.#trackedDevices?.[deviceData?.serialNumber]?.uuid, HomeKitDevice.UPDATE, {
                            alerts: this.#rawData[nest_google_device_uuid].value.alerts,
                          });
                        }
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
                    let nest_google_device_uuid = this.#trackedDevices?.[deviceData?.serialNumber]?.nest_google_device_uuid;

                    if (
                      (this.#trackedDevices?.[deviceData?.serialNumber]?.uuid ?? '') !== '' &&
                      typeof this.#rawData?.[nest_google_device_uuid]?.value === 'object'
                    ) {
                      this.#rawData[nest_google_device_uuid].value.weather = await this.#getWeather(
                        this.#rawData[nest_google_device_uuid].connection,
                        nest_google_device_uuid,
                        this.#rawData[nest_google_device_uuid].value?.weather?.postal_code,
                        this.#rawData[nest_google_device_uuid].value?.weather?.country_code,
                      );

                      // Send updated data onto HomeKit device for it to process
                      if (typeof this.#rawData?.[nest_google_device_uuid]?.value?.weather === 'object') {
                        HomeKitDevice.message(this.#trackedDevices?.[deviceData?.serialNumber]?.uuid, HomeKitDevice.UPDATE, {
                          current_temperature: adjustTemperature(
                            this.#rawData[nest_google_device_uuid].value.weather.current_temperature,
                            'C',
                            'C',
                            true,
                          ),
                          current_humidity: this.#rawData[nest_google_device_uuid].value.weather.current_humidity,
                          condition: this.#rawData[nest_google_device_uuid].value.weather.condition,
                          wind_direction: this.#rawData[nest_google_device_uuid].value.weather.wind_direction,
                          wind_speed: this.#rawData[nest_google_device_uuid].value.weather.wind_speed,
                          sunrise: this.#rawData[nest_google_device_uuid].value.weather.sunrise,
                          sunset: this.#rawData[nest_google_device_uuid].value.weather.sunset,
                          station: this.#rawData[nest_google_device_uuid].value.weather.station,
                          forecast: this.#rawData[nest_google_device_uuid].value.weather.forecast,
                        });
                      }
                    }
                    // eslint-disable-next-line no-unused-vars
                  } catch (error) {
                    // Empty
                  }
                }, TIMERS.WEATHER);
              }
            }

            // Finally, if device is not excluded, send updated data to device for it to process
            if (this.#trackedDevices?.[deviceData?.serialNumber]?.exclude === false) {
              if (
                this.#rawData[deviceData?.nest_google_device_uuid]?.source !== undefined &&
                this.#rawData[deviceData.nest_google_device_uuid].source !== this.#trackedDevices[deviceData.serialNumber].source
              ) {
                // Data source for this device has been updated
                this?.log?.debug?.(
                  'Using %s API as data source for "%s" from connection "%s"',
                  this.#rawData[deviceData.nest_google_device_uuid].source,
                  deviceData.description,
                  this.#connections[this.#rawData[deviceData.nest_google_device_uuid].connection].name,
                );

                this.#trackedDevices[deviceData.serialNumber].source = this.#rawData[deviceData.nest_google_device_uuid].source;
                this.#trackedDevices[deviceData.serialNumber].nest_google_device_uuid = deviceData.nest_google_device_uuid;
              }

              // For any camera type devices, inject camera API call access credentials for that device
              // from its associated connection here
              if (
                deviceModule.class.TYPE === DEVICE_TYPE.CAMERA ||
                deviceModule.class.TYPE === DEVICE_TYPE.DOORBELL ||
                deviceModule.class.TYPE === DEVICE_TYPE.FLOODLIGHT
              ) {
                deviceData.apiAccess = this.#connections?.[this.#rawData?.[deviceData?.nest_google_device_uuid]?.connection]?.cameraAPI;
              }

              // Send updated data onto HomeKit device for it to process
              HomeKitDevice.message(this.#trackedDevices?.[deviceData?.serialNumber]?.uuid, HomeKitDevice.UPDATE, deviceData);
            }
          }
        }
      }
    }
  }

  async #set(uuid, nest_google_device_uuid, values) {
    if (
      typeof values !== 'object' ||
      typeof this.#rawData?.[nest_google_device_uuid] !== 'object' ||
      typeof this.#connections?.[uuid] !== 'object' ||
      this.#connections?.[uuid]?.authorised !== true
    ) {
      return;
    }

    for (let [key, value] of Object.entries(values)) {
      if (key === 'uuid') {
        // We don't do anything with the key containing the uuid
        continue;
      }

      if (this.#rawData?.[nest_google_device_uuid]?.source === DATA_SOURCE.GOOGLE) {
        let updatedTraits = [];
        let commandTraits = [];

        let updateElement = {
          traitRequest: {
            resourceId: nest_google_device_uuid,
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
            resourceId: nest_google_device_uuid,
            requestId: crypto.randomUUID(),
          },
          resourceCommands: [],
        };

        if (
          (key === 'hvac_mode' && ['OFF', 'COOL', 'HEAT', 'RANGE'].includes(value?.toUpperCase?.())) ||
          (['target_temperature', 'target_temperature_low', 'target_temperature_high'].includes(key) === true &&
            this.#rawData?.[nest_google_device_uuid]?.value?.eco_mode_state?.ecoMode === 'ECO_MODE_INACTIVE' &&
            isNaN(value) === false)
        ) {
          // Set either the 'mode' and/or non-eco temperatures on the target thermostat
          updateElement.traitRequest.traitLabel = 'target_temperature_settings';
          updateElement.state.type_url = 'type.nestlabs.com/nest.trait.hvac.TargetTemperatureSettingsTrait';
          updateElement.state.value = this.#rawData[nest_google_device_uuid].value.target_temperature_settings;

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
            originator: { resourceId: nest_google_device_uuid },
            timeOfAction: { seconds: Math.floor(Date.now() / 1000), nanos: (Date.now() % 1000) * 1e6 },
          };
        }

        if (
          ['target_temperature', 'target_temperature_low', 'target_temperature_high'].includes(key) === true &&
          this.#rawData?.[nest_google_device_uuid]?.value?.eco_mode_state?.ecoMode !== 'ECO_MODE_INACTIVE' &&
          isNaN(value) === false
        ) {
          // Set eco mode temperatures on the target thermostat
          updateElement.traitRequest.traitLabel = 'eco_mode_settings';
          updateElement.state.type_url = 'type.nestlabs.com/nest.trait.hvac.EcoModeSettingsTrait';
          updateElement.state.value = this.#rawData[nest_google_device_uuid].value.eco_mode_settings;

          updateElement.state.value.ecoTemperatureHeat.value.value =
            updateElement.state.value.ecoTemperatureHeat.enabled === true && updateElement.state.value.ecoTemperatureCool.enabled === false
              ? value
              : updateElement.state.value.ecoTemperatureHeat.value.value;
          updateElement.state.value.ecoTemperatureCool.value.value =
            updateElement.state.value.ecoTemperatureHeat.enabled === false && updateElement.state.value.ecoTemperatureCool.enabled === true
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

        if (key === 'temperature_scale' && (value?.toUpperCase?.() === 'C' || value?.toUpperCase?.() === 'F')) {
          // Set the temperature scale on the target thermostat
          updateElement.traitRequest.traitLabel = 'display_settings';
          updateElement.state.type_url = 'type.nestlabs.com/nest.trait.hvac.DisplaySettingsTrait';
          updateElement.state.value = this.#rawData[nest_google_device_uuid].value.display_settings;
          updateElement.state.value.temperatureScale = value.toUpperCase() === 'F' ? 'TEMPERATURE_SCALE_F' : 'TEMPERATURE_SCALE_C';
        }

        if (key === 'temperature_lock' && typeof value === 'boolean') {
          // Set lock mode on the target thermostat
          updateElement.traitRequest.traitLabel = 'temperature_lock_settings';
          updateElement.state.type_url = 'type.nestlabs.com/nest.trait.hvac.TemperatureLockSettingsTrait';
          updateElement.state.value = this.#rawData[nest_google_device_uuid].value.temperature_lock_settings;
          updateElement.state.value.enabled = value === true;
        }

        if (key === 'fan_state' && typeof value === 'boolean' && isNaN(values?.fan_duration) === false) {
          // Set fan mode on the target thermostat, including runtime if turning on
          updateElement.traitRequest.traitLabel = 'fan_control_settings';
          updateElement.state.type_url = 'type.nestlabs.com/nest.trait.hvac.FanControlSettingsTrait';
          updateElement.state.value = this.#rawData[nest_google_device_uuid].value.fan_control_settings;
          updateElement.state.value.timerEnd =
            value === true
              ? {
                  seconds: Number(Math.floor(Date.now() / 1000) + Number(values.fan_duration)),
                  nanos: Number(((Math.floor(Date.now() / 1000) + Number(values.fan_duration)) % 1000) * 1e6),
                }
              : { seconds: 0, nanos: 0 };
          if (values?.fan_timer_speed !== undefined) {
            // We have a value to set fan speed also, so handle here as combined setting
            updateElement.state.value.timerSpeed =
              values?.fan_timer_speed !== 0
                ? 'FAN_SPEED_SETTING_STAGE' + values?.fan_timer_speed
                : this.#rawData[nest_google_device_uuid].value.fan_control_settings.timerSpeed;
          }
        }

        if (key === 'fan_timer_speed' && isNaN(value) === false && values?.fan_state === undefined) {
          // Set fan speed on the target thermostat only if we're not changing fan on/off state also
          updateElement.traitRequest.traitLabel = 'fan_control_settings';
          updateElement.state.type_url = 'type.nestlabs.com/nest.trait.hvac.FanControlSettingsTrait';
          updateElement.state.value = this.#rawData[nest_google_device_uuid].value.fan_control_settings;
          updateElement.state.value.timerSpeed =
            value !== 0 ? 'FAN_SPEED_SETTING_STAGE' + value : this.#rawData[nest_google_device_uuid].value.fan_control_settings.timerSpeed;
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
          updateElement.state.value = this.#rawData[nest_google_device_uuid].value.recording_toggle_settings;
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
          updateElement.state.value = this.#rawData[nest_google_device_uuid].value.microphone_settings;
          updateElement.state.value.enableMicrophone = value;
        }

        if (key === 'indoor_chime_enabled' && typeof value === 'boolean') {
          // Enable/disable chime status on doorbell
          updateElement.traitRequest.traitLabel = 'doorbell_indoor_chime_settings';
          updateElement.state.type_url = 'type.nestlabs.com/nest.trait.product.doorbell.DoorbellIndoorChimeSettingsTrait';
          updateElement.state.value = this.#rawData[nest_google_device_uuid].value.doorbell_indoor_chime_settings;
          updateElement.state.value.chimeEnabled = value;
        }

        if (
          key === 'light_enabled' &&
          typeof value === 'boolean' &&
          typeof this.#rawData?.[nest_google_device_uuid]?.value?.related_resources?.relatedResources === 'object'
        ) {
          // Turn on/off light on supported camera devices. Need to find the related SERVICE_ object
          let serviceUUID = Object.values(this.#rawData[nest_google_device_uuid].value.related_resources.relatedResources).find(
            (resource) =>
              resource?.resourceTypeName?.resourceName === 'google.resource.AzizResource' &&
              resource?.resourceId?.resourceId?.startsWith('SERVICE_') === true,
          )?.resourceId?.resourceId;

          if ((serviceUUID ?? '') !== '') {
            commandElement.resourceRequest.resourceId = serviceUUID;
            commandElement.resourceCommands = [
              {
                traitLabel: 'on_off',
                command: {
                  type_url: 'type.nestlabs.com/weave.trait.actuator.OnOffTrait.SetStateRequest',
                  value: { on: value },
                },
              },
            ];
          }
        }

        if (key === 'light_brightness' && isNaN(value) === false) {
          // Set light brightness on supported camera devices
          updateElement.traitRequest.traitLabel = 'floodlight_settings';
          updateElement.state.type_url = 'type.nestlabs.com/google.trait.product.camera.FloodlightSettingsTrait';
          updateElement.state.value = this.#rawData[nest_google_device_uuid].value.floodlight_settings;
          updateElement.state.value.brightness = scaleValue(Number(value), 0, 100, 0, 10); // Scale to required level
        }

        if (
          key === 'active_sensor' &&
          typeof value === 'boolean' &&
          typeof this.#rawData?.[this.#rawData[nest_google_device_uuid]?.value?.associated_thermostat]?.value
            ?.remote_comfort_sensing_settings === 'object'
        ) {
          // Set active temperature sensor for associated thermostat
          updateElement.traitRequest.resourceId = this.#rawData[nest_google_device_uuid].value.associated_thermostat;
          updateElement.traitRequest.traitLabel = 'remote_comfort_sensing_settings';
          updateElement.state.type_url = 'type.nestlabs.com/nest.trait.hvac.RemoteComfortSensingSettingsTrait';
          updateElement.state.value =
            this.#rawData[this.#rawData[nest_google_device_uuid].value.associated_thermostat].value.remote_comfort_sensing_settings;
          updateElement.state.value.activeRcsSelection =
            value === true
              ? { rcsSourceType: 'RCS_SOURCE_TYPE_SINGLE_SENSOR', activeRcsSensor: { resourceId: nest_google_device_uuid } }
              : { rcsSourceType: 'RCS_SOURCE_TYPE_BACKPLATE' };
        }

        if (
          key === 'hot_water_boost_active' &&
          typeof value === 'object' &&
          this.#rawData?.[nest_google_device_uuid]?.value?.hvac_equipment_capabilities?.hasHotWaterControl === true
        ) {
          // Turn hotwater boost heating on/off
          updateElement.traitRequest.traitLabel = 'hot_water_settings';
          updateElement.state.type_url = 'type.nestlabs.com/nest.trait.hvac.HotWaterSettingsTrait';
          updateElement.state.value = this.#rawData[nest_google_device_uuid].value.hot_water_settings;
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

        if (
          key === 'hot_water_temperature' &&
          isNaN(value) === false &&
          this.#rawData?.[nest_google_device_uuid]?.value?.hvac_equipment_capabilities?.hasHotWaterTemperature === true
        ) {
          // Set hotwater boiler temperature
          updateElement.traitRequest.traitLabel = 'hot_water_settings';
          updateElement.state.type_url = 'type.nestlabs.com/nest.trait.hvac.HotWaterSettingsTrait';
          updateElement.state.value = this.#rawData[nest_google_device_uuid].value.hot_water_settings;
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
                    originator: { resourceId: nest_google_device_uuid },
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
          updateElement.state.value = this.#rawData[nest_google_device_uuid].value.bolt_lock_settings;
          updateElement.state.value.autoRelockDuration.seconds = value;
        }

        if (
          key === 'vacation_mode' &&
          typeof value === 'boolean' &&
          (this.#rawData?.[nest_google_device_uuid]?.value?.device_info?.pairerId?.resourceId ?? '') !== ''
        ) {
          // Set vaction mode on structure
          // let userID = Object.entries(this.#rawData).find(([key, value]) => key.startsWith('USER_') && value?.connection === uuid)?.[0];
          commandElement.resourceRequest.resourceId = this.#rawData[nest_google_device_uuid].value.device_info.pairerId.resourceId;
          commandElement.resourceCommands = [
            {
              traitLabel: 'structure_mode',
              command: {
                type_url: 'type.nestlabs.com/nest.trait.occupancy.StructureModeTrait.StructureModeChangeRequest',
                value: {
                  structureMode: value === true ? 'STRUCTURE_MODE_VACATION' : 'STRUCTURE_MODE_HOME',
                  reason: 'STRUCTURE_MODE_REASON_EXPLICIT_INTENT',
                  userId: {
                    resourceId: nest_google_device_uuid,
                  },
                },
              },
            },
          ];
        }

        if (
          key === 'dehumidifier_state' &&
          typeof value === 'boolean' &&
          this.#rawData?.[nest_google_device_uuid]?.value?.hvac_equipment_capabilities?.hasDehumidifier === true
        ) {
          // Set dehumidifier on/off on the target thermostat
          updateElement.traitRequest.traitLabel = 'humidity_control_settings';
          updateElement.state.type_url = 'type.nestlabs.com/nest.trait.hvac.HumidityControlSettingsTrait';
          updateElement.state.value = this.#rawData[nest_google_device_uuid].value.humidity_control_settings;
          updateElement.state.value.dehumidifierTargetHumidity.enabled = value;
        }

        if (updateElement.traitRequest.traitLabel !== '' && updateElement.state.type_url !== '') {
          updatedTraits.push(structuredClone(updateElement));
        }

        if (Array.isArray(commandElement?.resourceCommands) === true && commandElement.resourceCommands.length !== 0) {
          commandTraits.push(structuredClone(commandElement));
        }

        // Perform any direct trait updates we have to do. This can be done via a single call in a batch
        if (updatedTraits.length !== 0) {
          let commandResponse = await this.#protobufCommand(uuid, 'nestlabs.gateway.v1.TraitBatchApi', 'BatchUpdateState', {
            batchUpdateStateRequest: updatedTraits,
          });
          if (
            commandResponse === undefined ||
            commandResponse?.batchUpdateStateResponse?.[0]?.traitOperations?.[0]?.progress !== 'COMPLETE'
          ) {
            this?.log?.debug?.('Google API had error updating traits for device uuid "%s"', nest_google_device_uuid);
          }
        }
        // Perform any trait updates required via resource commands. Each one is done separately
        if (commandTraits.length !== 0) {
          for (let command of commandTraits) {
            let commandResponse = await this.#protobufCommand(uuid, 'nestlabs.gateway.v1.ResourceApi', 'SendCommand', command);
            if (commandResponse === undefined || commandResponse.sendCommandResponse?.[0]?.traitOperations?.[0]?.progress !== 'COMPLETE') {
              this?.log?.debug?.(
                'Google API had error setting "%s" for device uuid "%s"',
                command.resourceCommands?.[0].traitLabel,
                nest_google_device_uuid,
              );
            }
          }
        }
      }

      if (this.#rawData?.[nest_google_device_uuid]?.source === DATA_SOURCE.NEST) {
        if (nest_google_device_uuid.startsWith('quartz.') === true) {
          // Set value on Nest Camera/Doorbell
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
              new URL('/api/dropcams.set_properties', 'https://webapi.' + this.#connections[uuid].cameraAPIHost).href,
              {
                headers: {
                  Referer: 'https://' + this.#connections[uuid].referer,
                  Origin: 'https://' + this.#connections[uuid].referer,
                  [this.#connections[uuid].cameraAPI.key]:
                    this.#connections[uuid].cameraAPI.value + this.#connections[uuid].cameraAPI.token,
                  'Content-Type': 'application/x-www-form-urlencoded',
                  'User-Agent': USER_AGENT,
                  'Sec-Fetch-Mode': 'cors',
                  'Sec-Fetch-Site': 'same-origin',
                },
                retry: 3,
              },
              mappedKey + '=' + value + '&uuid=' + nest_google_device_uuid.trim().split('.')[1],
            );

            let data = await response.json();
            if (data?.status !== 0) {
              throw new Error('Nest API camera update failed');
            }
          } catch (error) {
            // Log unexpected errors (excluding timeouts) for debugging
            this?.log?.debug?.(
              'Nest API camera update failed for device uuid "%s". Error was "%s"',
              nest_google_device_uuid,
              typeof error?.message === 'string' ? error.message : String(error),
            );
          }
        }

        if (nest_google_device_uuid.startsWith('quartz.') === false) {
          // set values on other Nest devices besides cameras/doorbells
          let subscribeJSONData = { objects: [] };

          if (
            key === 'active_sensor' &&
            typeof value === 'boolean' &&
            typeof this.#rawData?.['rcs_settings.' + this.#rawData?.[nest_google_device_uuid]?.value?.associated_thermostat.split('.')[1]]
              ?.value?.active_rcs_sensors === 'object' &&
            nest_google_device_uuid.startsWith('kryptonite.') === true
          ) {
            // Set active temperature sensor for associated thermostat
            subscribeJSONData.objects.push({
              object_key: 'rcs_settings.' + this.#rawData[nest_google_device_uuid].value.associated_thermostat.split('.')[1],
              op: 'MERGE',
              value:
                value === true
                  ? { active_rcs_sensors: [nest_google_device_uuid], rcs_control_setting: 'OVERRIDE' }
                  : { active_rcs_sensors: [], rcs_control_setting: 'OFF' },
            });
          }

          if (
            ['target_temperature', 'target_temperature_low', 'target_temperature_high'].includes(key) === true &&
            isNaN(value) === false &&
            nest_google_device_uuid.startsWith('device.') === true
          ) {
            // Set temperatures on thermostat
            subscribeJSONData.objects.push({
              object_key: 'shared.' + nest_google_device_uuid.trim().split('.')[1],
              op: 'MERGE',
              value: { target_change_pending: true, [key]: value },
            });
          }

          if (
            key === 'hvac_mode' &&
            ['off', 'cool', 'heat', 'range'].includes(value?.toLowerCase?.()) === true &&
            nest_google_device_uuid.startsWith('device.') === true
          ) {
            // Set hvac mode on thermostat
            subscribeJSONData.objects.push({
              object_key: 'shared.' + nest_google_device_uuid.trim().split('.')[1],
              op: 'MERGE',
              value: { target_change_pending: true, target_temperature_type: value.toLowerCase() },
            });
          }

          if (
            key === 'fan_state' &&
            typeof value === 'boolean' &&
            isNaN(values?.fan_duration) === false &&
            nest_google_device_uuid.startsWith('device.') === true
          ) {
            // Set fan on/off on thermostat
            // Duration also needs to be passed in
            subscribeJSONData.objects.push({
              object_key: nest_google_device_uuid,
              op: 'MERGE',
              value: {
                fan_timer_timeout: value === true ? values.fan_duration + Math.floor(Date.now() / 1000) : 0,
              },
            });
          }

          if (key === 'fan_timer_speed' && isNaN(value) === false && nest_google_device_uuid.startsWith('device.') === true) {
            // Set fan speed on thermostat
            subscribeJSONData.objects.push({
              object_key: nest_google_device_uuid,
              op: 'MERGE',
              value: { fan_timer_speed: value !== 0 ? 'stage' + value : 'stage1' },
            });
          }

          if (
            key === 'hot_water_boost_active' &&
            typeof value?.state === 'boolean' &&
            isNaN(value?.time) === false &&
            nest_google_device_uuid.startsWith('device.') === true &&
            this.#rawData?.[nest_google_device_uuid]?.value?.has_hot_water_control === true
          ) {
            // Set hotwater boost time on heatlink (associated thermostat)
            subscribeJSONData.objects.push({
              object_key: nest_google_device_uuid,
              op: 'MERGE',
              value: {
                hot_water_boost_time_to_end: value.state === true ? value.time + Math.floor(Date.now() / 1000) : 0,
              },
            });
          }

          if (
            key === 'hot_water_temperature' &&
            isNaN(value) === false &&
            nest_google_device_uuid.startsWith('device.') === true &&
            this.#rawData?.[nest_google_device_uuid]?.value?.has_hot_water_temperature === true
          ) {
            // Set hotwater temperature on heatlink (associated thermostat)
            subscribeJSONData.objects.push({
              object_key: nest_google_device_uuid,
              op: 'MERGE',
              value: {
                hot_water_temperature: value,
              },
            });
          }

          if (key === 'temperature_lock' && typeof value === 'boolean' && nest_google_device_uuid.startsWith('device.') === true) {
            // Set lock controls on thermostat
            subscribeJSONData.objects.push({ object_key: nest_google_device_uuid, op: 'MERGE', value: { temperature_lock: value } });
          }

          if (
            key === 'temperature_scale' &&
            (value?.toUpperCase?.() === 'C' || value?.toUpperCase?.() === 'F') &&
            nest_google_device_uuid.startsWith('device.') === true
          ) {
            // Set temperature scale on thermostat
            subscribeJSONData.objects.push({
              object_key: nest_google_device_uuid,
              op: 'MERGE',
              value: { temperature_scale: value.toUpperCase() },
            });
          }

          if (
            key === 'dehumidifier_state' &&
            typeof value === 'boolean' &&
            nest_google_device_uuid.startsWith('device.') === true &&
            this.#rawData?.[nest_google_device_uuid]?.value?.has_dehumidifier === true
          ) {
            // Set dehumidifier state on thermostat
            subscribeJSONData.objects.push({ object_key: nest_google_device_uuid, op: 'MERGE', value: { dehumidifier_state: value } });
          }

          if (
            key === 'vacation_mode' &&
            typeof value === 'boolean' &&
            typeof this.#rawData?.['link.' + nest_google_device_uuid?.split('.')[1]]?.value?.structure === 'string'
          ) {
            // Set vacation mode on structure associated with thermostat
            subscribeJSONData.objects.push({
              object_key: this.#rawData['link.' + nest_google_device_uuid.split('.')[1]].value.structure,
              op: 'MERGE',
              value: { vacation_mode: value },
            });
          }

          if (key === 'ntp_green_led_enable' && typeof value === 'boolean' && nest_google_device_uuid.startsWith('topaz.') === true) {
            // Set night time promise Led status on Protect
            subscribeJSONData.objects.push({ object_key: nest_google_device_uuid, op: 'MERGE', value: { ntp_green_led_enable: value } });
          }

          if (subscribeJSONData.objects.length !== 0) {
            try {
              await fetchWrapper(
                'post',
                new URL('/v5/put', this.#connections[uuid].transport_url).href,
                {
                  headers: {
                    Referer: 'https://' + this.#connections[uuid].referer,
                    Origin: 'https://' + this.#connections[uuid].referer,
                    Authorization: 'Basic ' + this.#connections[uuid].token,
                    'User-Agent': USER_AGENT,
                    'Sec-Fetch-Mode': 'cors',
                    'Sec-Fetch-Site': 'same-origin',
                    'X-nl-protocol-version': 1,
                    'Content-Type': 'application/json',
                  },
                  retry: 3,
                },
                JSON.stringify(subscribeJSONData),
              );
            } catch (error) {
              // Log unexpected errors (excluding timeouts) for debugging
              this?.log?.debug?.(
                'Nest API property update failed for device uuid "%s". Error was "%s"',
                nest_google_device_uuid,
                typeof error?.message === 'string' ? error.message : String(error),
              );
            }
          }
        }
      }
    }
  }

  async #get(uuid, nest_google_device_uuid, values) {
    if (typeof values !== 'object' || typeof this.#rawData?.[nest_google_device_uuid] !== 'object') {
      return;
    }

    for (let key of Object.keys(values)) {
      if (key === 'uuid') {
        // We don't do anything with the key containing the uuid
        continue;
      }

      // We'll return the data under the original key value
      // By default, the returned value will be undefined. If call is successful, the key value will have the data requested
      values[key] = undefined;

      if (key === 'camera_snapshot') {
        // Camera snapshot requested.
        // We'll pass in either the nexus api server url for Nest API devices OR the resultant uploaded image URL for Google API devices
        values[key] = await this.#getCameraSnapshot(uuid, nest_google_device_uuid);
      }
    }

    return values;
  }

  async #getCameraSnapshot(uuid, nest_google_device_uuid) {
    if (
      typeof this.#connections?.[uuid] !== 'object' ||
      this.#connections[uuid]?.authorised !== true ||
      (nest_google_device_uuid?.trim?.() ?? '') === ''
    ) {
      // Not a valid connection object and/or we're not authorised
      return;
    }

    let snapshot = undefined;

    if (
      this.config?.options?.useNestAPI === true &&
      nest_google_device_uuid.startsWith('quartz.') === true &&
      (this.#rawData?.[nest_google_device_uuid]?.value?.nexus_api_http_server_url ?? '') !== ''
    ) {
      // Attempt to retrieve snapshot from camera via Nest API
      try {
        let response = await fetchWrapper(
          'get',
          new URL(
            '/get_image?uuid=' + nest_google_device_uuid.trim().split('.')[1],
            this.#rawData[nest_google_device_uuid].value.nexus_api_http_server_url.trim(),
          ).href,
          {
            headers: {
              Referer: 'https://' + this.#connections[uuid].referer,
              Origin: 'https://' + this.#connections[uuid].referer,
              [this.#connections[uuid].cameraAPI.key]: this.#connections[uuid].cameraAPI.value + this.#connections[uuid].cameraAPI.token,
              'User-Agent': USER_AGENT,
              'Sec-Fetch-Mode': 'cors',
              'Sec-Fetch-Site': 'same-origin',
            },
            retry: 2,
            timeout: 10000, // 10 seconds to get snapshot
          },
        );
        snapshot = Buffer.from(await response.arrayBuffer());
      } catch (error) {
        // Log unexpected errors (excluding timeouts) for debugging
        if (
          error?.cause === undefined ||
          (error.cause?.message?.toUpperCase?.()?.includes('TIMEOUT') === false &&
            error.cause?.code?.toUpperCase?.()?.includes('TIMEOUT') === false)
        ) {
          this?.log?.debug?.(
            'Nest API camera snapshot failed with error for device uuid "%s". Error was "%s"',
            nest_google_device_uuid,
            typeof error?.message === 'string' ? error.message : String(error),
          );
        }
      }
    }

    if (
      this.config?.options?.useGoogleAPI === true &&
      nest_google_device_uuid.startsWith('DEVICE_') === true &&
      (PROTOBUF_RESOURCES.CAMERA.includes(this.#rawData?.[nest_google_device_uuid]?.value?.device_info?.typeName) === true ||
        PROTOBUF_RESOURCES.DOORBELL.includes(this.#rawData?.[nest_google_device_uuid]?.value?.device_info?.typeName) === true ||
        PROTOBUF_RESOURCES.FLOODLIGHT.includes(this.#rawData?.[nest_google_device_uuid]?.value?.device_info?.typeName) === true)
    ) {
      // First, request to get the snapshot url image updated
      let commandResponse = await this.#protobufCommand(uuid, 'nestlabs.gateway.v1.ResourceApi', 'SendCommand', {
        resourceRequest: {
          resourceId: nest_google_device_uuid,
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
        (this.#rawData?.[nest_google_device_uuid]?.value?.upload_live_image?.liveImageUrl ?? '') !== ''
      ) {
        // The snapshot image has updated, so now attempt to retrieve image from camera via Google API
        try {
          let response = await fetchWrapper('get', this.#rawData[nest_google_device_uuid].value.upload_live_image.liveImageUrl, {
            headers: {
              Referer: 'https://' + this.#connections[uuid].referer,
              Origin: 'https://' + this.#connections[uuid].referer,
              Authorization: 'Basic ' + this.#connections[uuid].token,
              'User-Agent': USER_AGENT,
              'Sec-Fetch-Mode': 'cors',
              'Sec-Fetch-Site': 'same-origin',
            },
            retry: 2,
            timeout: 10000, // 10 seconds to get snapshot
          });
          snapshot = Buffer.from(await response.arrayBuffer());
        } catch (error) {
          // Log unexpected errors (excluding timeouts) for debugging
          if (
            error?.cause === undefined ||
            (error.cause?.message?.toUpperCase?.()?.includes('TIMEOUT') === false &&
              error.cause?.code?.toUpperCase?.()?.includes('TIMEOUT') === false)
          ) {
            this?.log?.debug?.(
              'Google API camera snapshot failed with error for device uuid "%s". Error was "%s"',
              nest_google_device_uuid,
              typeof error?.message === 'string' ? error.message : String(error),
            );
          }
        }
      }
    }
    return snapshot;
  }

  async #getWeather(uuid, nest_google_device_uuid, postal_code, country_code) {
    if (
      (postal_code?.trim?.() ?? '') === '' ||
      (country_code?.trim?.() ?? '') === '' ||
      typeof this.#connections?.[uuid] !== 'object' ||
      this.#connections[uuid]?.authorised !== true ||
      (nest_google_device_uuid?.trim?.() ?? '') === ''
    ) {
      // Not a valid connection object and/or we're not authorised
      return;
    }

    let weather =
      typeof this.#rawData?.[nest_google_device_uuid]?.value?.weather === 'object'
        ? this.#rawData[nest_google_device_uuid].value.weather
        : {};

    try {
      let response = await fetchWrapper(
        'get',
        new URL('/api/0.1/weather/forecast/' + postal_code + ',' + country_code, 'https://' + this.#connections[uuid].restAPIHost).href,
        {
          headers: {
            Referer: 'https://' + this.#connections[uuid].referer,
            Origin: 'https://' + this.#connections[uuid].referer,
            Authorization: 'Basic ' + this.#connections[uuid].token,
            'User-Agent': USER_AGENT,
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
          },
          retry: 3,
        },
      );

      let data = await response.json();

      // If returned JSON has an error defined, throw it
      if (data?.error !== undefined) {
        throw new Error(data.error);
      }

      // Ensure we have valid data
      if (
        data?.now?.current_temperature === undefined &&
        data?.now?.current_humidity === undefined &&
        data?.now?.conditions === undefined &&
        data?.now?.wind_direction === undefined &&
        data?.now?.current_wind === undefined &&
        data?.now?.sunrise === undefined &&
        data?.now?.sunset === undefined
      ) {
        throw new Error('Invalid weather data');
      }

      // Store the used post/country codes
      weather.postal_code = postal_code;
      weather.country_code = country_code;

      // Update weather data
      weather.current_temperature = adjustTemperature(data.now.current_temperature, 'C', 'C', false);
      weather.current_humidity = data.now.current_humidity;
      weather.condition = data.now.conditions;
      weather.wind_direction = data.now.wind_direction;
      weather.wind_speed = data.now.current_wind;
      weather.sunrise = data.now.sunrise;
      weather.sunset = data.now.sunset;
      weather.station = data.display_city;
      weather.forecast = data.forecast.daily[0].conditions;
    } catch (error) {
      // Log unexpected errors (excluding timeouts) for debugging
      this?.log?.debug?.(
        'Nest API failed to retrieve weather details for device uuid "%s". Error was "%s"',
        nest_google_device_uuid,
        typeof error?.message === 'string' ? error.message : String(error),
      );
    }

    return weather;
  }

  async #getCameraActivityZones(uuid, nest_google_device_uuid, nexus_api_url) {
    if (
      typeof this.#connections?.[uuid] !== 'object' ||
      this.#connections[uuid]?.authorised !== true ||
      (nest_google_device_uuid?.trim?.() ?? '') === '' ||
      this.config?.options?.useNestAPI !== true ||
      nest_google_device_uuid.startsWith('quartz.') !== true ||
      (nexus_api_url?.trim?.() ?? '') === ''
    ) {
      // Not a valid connection, not authorised, useNestAPI disabled, invalid device, or no valid URL
      return;
    }

    try {
      let response = await fetchWrapper(
        'get',
        new URL('/cuepoint_category/' + nest_google_device_uuid.trim().split('.')[1], nexus_api_url).href,
        {
          headers: {
            Referer: 'https://' + this.#connections[uuid].referer,
            Origin: 'https://' + this.#connections[uuid].referer,
            [this.#connections[uuid].cameraAPI.key]: this.#connections[uuid].cameraAPI.value + this.#connections[uuid].cameraAPI.token,
            'User-Agent': USER_AGENT,
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
          },
          retry: 3,
          timeout: TIMERS.ZONES,
        },
      );

      let data = await response.json();

      // Transform zones if present in the returned data
      if (Array.isArray(data) === true) {
        let activityZones = data
          .filter((zone) => zone?.type?.toUpperCase() === 'ACTIVITY' || zone?.type?.toUpperCase() === 'REGION')
          .map((zone) => ({
            id: zone.id === 0 ? 1 : zone.id,
            name: HomeKitDevice.makeValidHKName(zone.label),
            hidden: zone.hidden === true,
            uri: zone.nexusapi_image_uri,
          }));

        return activityZones;
      }
    } catch (error) {
      // Log unexpected errors (excluding timeouts) for debugging
      this?.log?.debug?.(
        'Nest API had error retrieving camera/doorbell activity zones for device "%s". Error was "%s"',
        nest_google_device_uuid,
        typeof error?.message === 'string' ? error.message : String(error),
      );
    }
  }

  async #getCameraProperties(uuid, nest_google_device_uuid) {
    if (
      typeof this.#connections?.[uuid] !== 'object' ||
      this.#connections[uuid]?.authorised !== true ||
      (nest_google_device_uuid?.trim?.() ?? '') === '' ||
      this.config?.options?.useNestAPI !== true ||
      nest_google_device_uuid.startsWith('quartz.') !== true
    ) {
      // Not a valid connection, not authorised, useNestAPI disabled or invalid device
      return;
    }

    try {
      let response = await fetchWrapper(
        'get',
        new URL(
          '/api/cameras.get_with_properties?uuid=' + nest_google_device_uuid.trim().split('.')[1],
          'https://webapi.' + this.#connections[uuid].cameraAPIHost,
        ).href,
        {
          headers: {
            Referer: 'https://' + this.#connections[uuid].referer,
            Origin: 'https://' + this.#connections[uuid].referer,
            [this.#connections[uuid].cameraAPI.key]: this.#connections[uuid].cameraAPI.value + this.#connections[uuid].cameraAPI.token,
            'User-Agent': USER_AGENT,
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
          },
          retry: 3,
        },
      );
      let data = await response.json();

      // If returned JSON has empty properties, throw it
      if (data?.items?.[0]?.properties === undefined) {
        throw new Error(data?.status_detail);
      }

      return data.items[0].properties;
    } catch (error) {
      this?.log?.debug?.('Nest API had error retrieving camera/doorbell properties. Error was "%s"', error?.code ?? String(error));
    }
  }

  async #getCameraActivityAlerts(uuid, nest_google_device_uuid, nexus_api_url) {
    if (
      typeof this.#connections?.[uuid] !== 'object' ||
      this.#connections[uuid]?.authorised !== true ||
      (nest_google_device_uuid?.trim?.() ?? '') === ''
    ) {
      // Not a valid connection object and/or we're not authorised
      return;
    }

    if (this.config?.options?.useGoogleAPI === true && nest_google_device_uuid.startsWith('DEVICE_') === true) {
      let commandResponse = await this.#protobufCommand(uuid, 'nestlabs.gateway.v1.ResourceApi', 'SendCommand', {
        resourceRequest: {
          resourceId: nest_google_device_uuid,
          requestId: crypto.randomUUID(),
        },
        resourceCommands: [
          {
            traitLabel: 'camera_observation_history',
            command: {
              type_url: 'type.nestlabs.com/nest.trait.history.CameraObservationHistoryTrait.CameraObservationHistoryRequest',
              value: {
                // We want camera history from upto 15seconds ago until now
                queryStartTime: {
                  seconds: Math.floor((Date.now() - 15000) / 1000),
                  nanos: ((Date.now() - 15000) % 1000) * 1e6,
                },
                queryEndTime: {
                  seconds: Math.floor(Date.now() / 1000),
                  nanos: (Date.now() % 1000) * 1e6,
                },
              },
            },
          },
        ],
      });

      if (
        typeof commandResponse?.sendCommandResponse?.[0]?.traitOperations?.[0]?.event?.event === 'object' &&
        commandResponse?.sendCommandResponse?.[0]?.traitOperations?.[0]?.event?.event.constructor === Object
      ) {
        let alerts =
          Array.isArray(commandResponse?.sendCommandResponse?.[0]?.traitOperations?.[0]?.event?.event?.cameraEventWindow?.cameraEvent) ===
          true
            ? commandResponse.sendCommandResponse[0].traitOperations[0].event.event.cameraEventWindow.cameraEvent
                .map((event) => ({
                  playback_time: parseInt(event.startTime.seconds) * 1000 + parseInt(event.startTime.nanos) / 1000000,
                  start_time: parseInt(event.startTime.seconds) * 1000 + parseInt(event.startTime.nanos) / 1000000,
                  end_time: parseInt(event.endTime.seconds) * 1000 + parseInt(event.endTime.nanos) / 1000000,
                  id: event.eventId,
                  zone_ids:
                    Array.isArray(event.activityZone) === true
                      ? event.activityZone.map((zone) => (zone?.zoneIndex !== undefined ? zone.zoneIndex : zone.internalIndex))
                      : [],
                  types:
                    Array.isArray(event.eventType) === true
                      ? event.eventType
                          .map((type) => {
                            if (type === 'EVENT_UNFAMILIAR_FACE') {
                              return 'unfamiliar-face';
                            }
                            if (type === 'EVENT_PERSON_TALKING') {
                              return 'personHeard';
                            }
                            if (type === 'EVENT_DOG_BARKING') {
                              return 'dogBarking';
                            }
                            return type.startsWith('EVENT_') === true ? type.slice(6).toLowerCase() : '';
                          })
                          .filter(Boolean)
                      : [],
                }))
                .sort((a, b) => b.start_time - a.start_time)
            : [];

        return alerts; // Return alerts from Google API
      }
    }

    if (
      this.config?.options?.useNestAPI === true &&
      nest_google_device_uuid.startsWith('quartz.') === true &&
      (nexus_api_url?.trim?.() ?? '') !== ''
    ) {
      try {
        let response = await fetchWrapper(
          'get',
          new URL(
            '/cuepoint/' + nest_google_device_uuid.trim().split('.')[1] + '/2?start_time=' + Math.floor(Date.now() / 1000 - 30),
            nexus_api_url,
          ).href,
          {
            headers: {
              Referer: 'https://' + this.#connections[uuid].referer,
              Origin: 'https://' + this.#connections[uuid].referer,
              [this.#connections[uuid].cameraAPI.key]: this.#connections[uuid].cameraAPI.value + this.#connections[uuid].cameraAPI.token,
              'User-Agent': USER_AGENT,
              'Sec-Fetch-Mode': 'cors',
              'Sec-Fetch-Site': 'same-origin',
            },
            retry: 3,
          },
        );

        let data = await response.json();

        let alerts =
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
        return alerts; // Return alerts from Nest API
      } catch (error) {
        // Log unexpected errors (excluding timeouts) for debugging
        this?.log?.debug?.(
          'Nest API had error retrieving camera/doorbell activity notifications for device "%s". Error was "%s"',
          nest_google_device_uuid,
          typeof error?.message === 'string' ? error.message : String(error),
        );
      }
    }
  }

  async #protobufCommand(uuid, service, command, values, onMessage = undefined) {
    if (
      this.#protobufRoot === null ||
      (uuid?.trim?.() ?? '') === '' ||
      (service?.trim?.() ?? '') === '' ||
      (command?.trim?.() ?? '') === '' ||
      typeof values !== 'object' ||
      values?.constructor !== Object ||
      typeof this.#connections?.[uuid] !== 'object' ||
      this.#connections[uuid].authorised !== true ||
      (this.#connections[uuid].protobufAPIHost ?? '') === '' ||
      (this.#connections[uuid].referer ?? '') === '' ||
      (this.#connections[uuid].token ?? '') === ''
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

    // Retrieve both 'Request' and 'Response' traits for the associated service and command
    service = service.trim();
    command = command.trim();
    let TraitMapService = this.#protobufRoot.lookup(service);
    let TraitMapRequest = this.#protobufRoot.lookup(TraitMapService?.methods?.[command]?.requestType);
    let TraitMapResponse = this.#protobufRoot.lookup(TraitMapService?.methods?.[command]?.responseType);

    if (TraitMapRequest !== null && TraitMapResponse !== null) {
      // Encode any trait values in our passed in object
      encodeValues(values);
      let encodedRequest = TraitMapRequest.encode(TraitMapRequest.fromObject(values)).finish();

      return fetchWrapper(
        'post',
        new URL('/' + service + '/' + command, 'https://' + this.#connections[uuid].protobufAPIHost).href,
        {
          headers: {
            Referer: 'https://' + this.#connections[uuid].referer,
            Origin: 'https://' + this.#connections[uuid].referer,
            Authorization: 'Basic ' + this.#connections[uuid].token,
            Connection: 'keep-alive',
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/x-protobuf',
            'X-Accept-Content-Transfer-Encoding': 'binary',
            'X-Accept-Response-Streaming': 'true',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
          },
          retry: 3,
        },
        encodedRequest,
      )
        .then(async (response) => {
          let buffer = Buffer.alloc(0);

          if (TraitMapService?.methods?.[command]?.responseStream === true && response.body?.getReader) {
            let reader = response.body.getReader();
            while (true) {
              let { done, value } = await reader.read();
              if (done === true) {
                break;
              }

              if (value instanceof Uint8Array === false || value.length === 0) {
                continue;
              }

              buffer = Buffer.concat([buffer, Buffer.from(value)]);

              while (buffer.length >= 5) {
                // Decode gRPC-Web message length (varint after tag byte)
                let msgLen = 0;
                let shift = 0;
                let varintLen = 0;
                for (varintLen = 1; varintLen <= 5; varintLen++) {
                  let byte = buffer[varintLen];
                  msgLen |= (byte & 0x7f) << shift;
                  if ((byte & 0x80) === 0) {
                    break;
                  }
                  shift += 7;
                }

                let totalLen = 1 + varintLen + msgLen;
                if (buffer.length < totalLen) {
                  break;
                }

                let payload = buffer.subarray(0, totalLen);
                buffer = buffer.slice(totalLen);

                try {
                  // Attempt to decode the assembled response buffer (so far) into a JSON object
                  // If successful, send onto callback if defined.
                  // We don't return the response via function by return
                  let decoded = TraitMapResponse.decode(payload).toJSON();
                  await onMessage?.(decoded);
                } catch (err) {
                  this?.log?.debug?.('Failed to decode gRPC stream chunk: ' + String(err));
                }
              }
            }

            return; // No return value — messages handled via onMessage()
          }

          if (TraitMapService?.methods?.[command]?.responseStream !== true) {
            // If the trait response is not a readable stream, treat as a normal array buffer
            buffer = Buffer.from(await response.arrayBuffer());

            try {
              // Attempt to decode the response buffer into a JSON object.
              // If successful, send onto callback if defined
              // We'll also return the response by function return
              let decoded = TraitMapResponse.decode(buffer).toJSON();
              await onMessage?.(decoded);
              return decoded;
            } catch (err) {
              this?.log?.debug?.('Failed to decode unary gRPC response: ' + String(err));
              return undefined;
            }
          }
        })
        .catch((error) => {
          if (
            error?.cause === undefined ||
            (error.cause?.message?.toUpperCase?.()?.includes('TIMEOUT') === false &&
              error.cause?.code?.toUpperCase?.()?.includes('TIMEOUT') === false)
          ) {
            this?.log?.debug?.(
              'Protobuf command "%s" failed for service "%s": %s',
              command,
              service,
              typeof error?.message === 'string' ? error.message : String(error),
            );
            return undefined;
          }
        });
    }
  }

  #loadProtobufRoot() {
    if (this.#protobufRoot !== undefined && this.#protobufRoot !== null) {
      return;
    }

    // Attempt to load in required protobuf files
    if (fs.existsSync(path.join(__dirname, 'protobuf/root.proto')) === true) {
      protobuf.util.Long = null;
      protobuf.configure();
      this.#protobufRoot = protobuf.loadSync(path.join(__dirname, 'protobuf/root.proto'));
      if (this.#protobufRoot !== null) {
        this?.log?.debug?.('Loaded protobuf support files for Google API');
      }
    }

    if (this.#protobufRoot === null) {
      this?.log?.warn?.(
        'Failed to load protobuf support files for Google API. This will cause certain Nest/Google devices to be unsupported',
      );
    }
  }
}
