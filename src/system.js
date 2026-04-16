// Overall system communications and device management
// Part of homebridge-nest-accfactory
//
// Core platform manager for communication with Nest and Google APIs.
// Handles account authorisation, connection lifecycle, device discovery,
// raw data aggregation, snapshot coordination, and routing of updates
// and commands between cloud APIs and HomeKit device modules.
//
// Responsibilities:
// - Authorise and maintain connections to Nest and Google accounts
// - Manage Nest REST API and Google protobuf API communication
// - Observe and subscribe to cloud updates in near real-time
// - Aggregate and maintain raw device data from multiple API sources
// - Coordinate protobuf-backed camera snapshot requests and responses
// - Discover, create, update, and remove supported device instances
// - Route HomeKit get/set requests to the correct upstream API
// - Load and coordinate device support modules
//
// Features:
// - Multi-account support (multiple Google and/or Nest accounts simultaneously)
// - Automatic reconnect and token/session refresh handling
// - Nest REST API subscribe loop and Google protobuf observe loop
// - Raw data merging across Nest and Google sources
// - Promise-based snapshot waiter handling for upload_live_image updates
// - Support dump generation for troubleshooting when enabled
// - Dynamic device module loading and HomeKit category selection
//
// Notes:
// - HomeKit characteristic and service management is handled by individual device modules
// - This module is responsible for platform orchestration, API communication, snapshot coordination, and device lifecycle
// - Camera, thermostat, sensor, and lock behaviour is implemented in device-specific modules
//
// Architecture:
// - Exports the main NestAccfactory platform class
// - Maintains connection state, protobuf definitions, raw data cache, snapshot waiters, and tracked devices
// - Creates and updates HomeKitDevice-based instances for supported device types
//
// Code version 2026.04.15
// Mark Hulskamp
'use strict';

// Define external module requirements
import protobuf from 'protobufjs';

// Define nodejs module requirements
import { Buffer } from 'node:buffer';
import { setTimeout, clearTimeout } from 'node:timers';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import os from 'node:os';
import { URL } from 'node:url';

// Import our modules
import GrpcTransport from './grpctransport.js';
import HomeKitDevice from './HomeKitDevice.js';
import { loadDeviceModules, getDeviceHKCategory } from './devices.js';
import { processConfig, buildConnections } from './config.js';
import { adjustTemperature, scaleValue, fetchWrapper } from './utils.js';

// Define constants
import {
  MIN_NODE_VERSION,
  USER_AGENT,
  __dirname,
  DATA_SOURCE,
  DEVICE_TYPE,
  ACCOUNT_TYPE,
  NEST_API_BUCKETS,
  PROTOBUF_RESOURCES,
} from './consts.js';

const SNAPSHOT_TIMEOUT = 7000; // Overall HomeKit snapshot timeout
const SNAPSHOT_WAIT_TIMEOUT = 3000; // Wait for Google upload_live_image observe update
const SNAPSHOT_FETCH_TIMEOUT = 3000; // HTTP fetch timeout for snapshot image

// We handle the connections to Nest/Google
// Perform device management (additions/removals/updates)
export default class NestAccfactory {
  cachedAccessories = []; // Track restored cached accessories

  // Internal data only for this class
  #connections = undefined; // Object of confirmed connections
  #rawData = {}; // Cached copy of data from both Nest and Google APIs
  #protobufRoot = null; // Protobuf loaded protos
  #trackedDevices = new Map(); // Devices we've created, keyed by serial number
  #deviceModules = undefined; // No loaded device support modules to start

  constructor(log, config, api) {
    this.log = log;
    this.api = api;

    // Validate required version of Node.js that we're running on.
    // If less than our minimum required version, log an error and stop initialisation
    let nodeVersion = Number(process.versions.node.split('.')[0]);

    if (nodeVersion < MIN_NODE_VERSION) {
      this.log.error(
        'We no longer support running on Node.js %s. Please upgrade to Node.js %s or newer. The plugin will not be started.',
        process.versions.node,
        MIN_NODE_VERSION,
      );
      return;
    }

    // Output some basic info about the plugin starting up, which can be useful for troubleshooting
    if (config?.options?.debug === true) {
      log?.warn?.('Verbose logging enabled via configuration');
    }

    // Output some debug info about the system we're running on, which can be useful for troubleshooting
    this?.log?.debug?.('System: %s %s (%s)', os.platform(), os.release(), os.arch());
    this?.log?.debug?.('CPU: %s (%d cores)', os.cpus()?.[0]?.model, os.cpus()?.length);
    this?.log?.debug?.('Memory: %d MB total', Math.round(os.totalmem() / 1024 / 1024));
    this?.log?.debug?.('Node.js: v%s', process.versions.node);

    // Perform validation on the configuration passed into us and set defaults if not present
    this.config = processConfig(config, this.log, this.api);
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
        let connection = this.#connections?.[uuid];

        const reconnectLoop = async () => {
          if (connection?.authorised !== true && connection?.allowRetry !== false) {
            try {
              await this.#connect(uuid);
              this.#subscribeNestAPI(uuid);
              this.#observeGoogleAPI(uuid);
              // eslint-disable-next-line no-unused-vars
            } catch (error) {
              // Empty
            }

            reconnectDelay = connection?.authorised === true ? 15000 : Math.min(reconnectDelay * 2, 60000);
          } else {
            reconnectDelay = 15000;
          }

          setTimeout(reconnectLoop, reconnectDelay);
        };

        if (connection?.exclude !== true) {
          reconnectLoop();
        } else {
          this?.log?.warn?.('Account "%s" is ignored due to it being marked as excluded', connection?.name);
        }
      }
    });

    api?.on?.('shutdown', async () => {
      // We got notified that Homebridge is shutting down
      // Perform cleanup of internal state
      for (let uuid of Object.keys(this.#connections ?? {})) {
        // Cleanup any active timers or transports for this connection
        clearTimeout(this.#connections?.[uuid]?.timer);

        // If we have an active gRPC transport for this connection, release it to clean up resources and connections
        this.#connections?.[uuid]?.grpcTransport?.release?.();

        // If we have any pending snapshot waiters for this connection, trigger them
        // so any in-flight snapshot requests can finish cleanly during shutdown
        if (this.#connections?.[uuid]?.snapshotWaiters instanceof Map) {
          for (let waiter of this.#connections[uuid].snapshotWaiters.values()) {
            if (typeof waiter === 'function') {
              waiter();
            }
          }

          this.#connections[uuid].snapshotWaiters.clear();
        }
      }

      // Cleanup internal data
      this.#trackedDevices.clear();
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

    let connection = this.#connections[uuid];
    let isRetry = connection.allowRetry === true;
    let accountLabel = connection.type === ACCOUNT_TYPE.GOOGLE ? 'Google' : 'Nest';

    // If allowRetry is true, we assume this is not the first connection attempt, so we'll only use debug level logging
    // Otherwise, we'll use info level
    this?.log?.[isRetry === true ? 'debug' : 'info']?.(
      'Performing authorisation for connection "%s" %s',
      connection.name,
      connection.fieldTest === true ? 'using field test endpoints' : '',
    );

    // Cleanup runtime state before re-auth
    // Ensures no stale waiters or transports remain
    let cleanupConnectionRuntime = () => {
      if (this.#connections?.[uuid]?.snapshotWaiters instanceof Map) {
        for (let waiter of this.#connections[uuid].snapshotWaiters.values()) {
          if (typeof waiter === 'function') {
            waiter(); // resolve any pending snapshot promises
          }
        }

        this.#connections[uuid].snapshotWaiters.clear();
      }

      this.#connections?.[uuid]?.grpcTransport?.release?.();
    };

    // Create gRPC transport (protobuf backend)
    // Uses the live connection object so refreshed token values are picked up by getAuthHeader()
    let createGrpcTransport = () => {
      if (this.config?.options?.useGoogleAPI !== true) {
        return;
      }

      return new GrpcTransport({
        log: this.log,
        protoPath: path.join(__dirname, 'protobuf/root.proto'),
        endpointHost: 'https://' + this.#connections[uuid].grpcEndpointHost,
        uuid: uuid,
        userAgent: USER_AGENT,
        getAuthHeader: () => {
          let token = this.#connections?.[uuid]?.token;
          return typeof token === 'string' && token.trim() !== '' ? 'Basic ' + token : '';
        },
      });
    };

    // Apply successful auth result
    // Shared across Google and Nest flows
    let applyAuthorisedConnection = (sessionData, cameraAPI, refreshSeconds, successMessage) => {
      this?.log?.[isRetry === true ? 'debug' : 'success']?.(successMessage, connection.name);

      cleanupConnectionRuntime();

      Object.assign(this.#connections[uuid], {
        authorised: true,
        allowRetry: true,
        userID: sessionData.userid,
        transport_url: sessionData.urls.transport_url,
        weather_url: sessionData.urls.weather_url,
        token: sessionData.access_token,
        cameraAPI: cameraAPI,
        grpcTransport: createGrpcTransport(),
        snapshotWaiters: new Map(), // Keyed by resource Id for protobuf snapshot waiters
      });

      // Schedule token refresh before expiry
      clearTimeout(this.#connections[uuid].timer);
      this.#connections[uuid].timer = setTimeout(() => {
        this?.log?.debug?.(
          'Performing periodic token refresh using %s account for connection "%s"',
          accountLabel,
          this.#connections[uuid].name,
        );
        this.#connections[uuid].allowRetry = true;
        this.#connect(uuid);
      }, refreshSeconds * 1000);
    };

    // Common error handling
    // Determines retry behaviour and logs appropriately
    let handleConnectError = (error, nonRetryableCodes, retryErrorMessage, authErrorMessage) => {
      let statusCode =
        error?.code !== undefined && error?.code !== null
          ? error.code
          : error?.status !== undefined && error?.status !== null
            ? error.status
            : undefined;

      if (nonRetryableCodes.includes(statusCode) === true) {
        this.#connections[uuid].allowRetry = false;
      }

      this.#connections[uuid].authorised = false;

      this?.log?.debug?.(
        'Failed to connect using %s credentials for connection "%s" %s: Error was "%s"',
        accountLabel,
        this.#connections[uuid].name,
        this.#connections[uuid].allowRetry === true ? 'will retry' : 'will not retry',
        typeof error?.message === 'string' ? error.message : String(error),
      );

      this?.log?.error?.(this.#connections[uuid].allowRetry === true ? retryErrorMessage : authErrorMessage, this.#connections[uuid].name);
    };

    // Google account authentication flow
    if (connection.type === ACCOUNT_TYPE.GOOGLE) {
      try {
        // Obtain OAuth token from Google using the token exchange endpoint and the cookie we already have from config
        let tokenResponse = await fetchWrapper('get', connection.issueToken, {
          headers: {
            Referer: 'https://accounts.google.com/',
            Cookie: connection.cookie,
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

        // Obtain JWT from Google using the OAuth token we just obtained
        let jwtResponse = await fetchWrapper(
          'post',
          'https://nestauthproxyservice-pa.googleapis.com/v1/issue_jwt',
          {
            headers: {
              Referer: 'https://' + connection.referer,
              Origin: 'https://' + connection.referer,
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

        // Get Nest session using the JWT token we just obtained
        let sessionResponse = await fetchWrapper('get', new URL('/session', 'https://' + connection.restAPIHost).href, {
          headers: {
            Referer: 'https://' + connection.referer,
            Origin: 'https://' + connection.referer,
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

        // Apply final authorised state
        applyAuthorisedConnection(
          sessionData,
          {
            key: 'Authorization',
            value: 'Basic ',
            token: sessionData.access_token,
            oauth2: googleOAuth2Token,
            fieldTest: connection.fieldTest === true,
          },
          tokenData.expires_in - 300,
          isRetry === true
            ? 'Successfully performed token refresh using Google account for connection "%s"'
            : 'Successfully authorised using Google account for connection "%s"',
        );
      } catch (error) {
        handleConnectError(
          error,
          ['USER_LOGGED_OUT', 'ERR_INVALID_URL', 401, 403],
          'Token refresh failed using Google account for connection "%s"',
          'Authorisation failed using Google account for connection "%s"',
        );
      }

      return;
    }

    // Nest account authentication flow (legacy)
    if (connection.type === ACCOUNT_TYPE.NEST) {
      try {
        // Retrieve session token from Nest login endpoint using the access token we already have from config
        let loginResponse = await fetchWrapper(
          'post',
          new URL('/api/v1/login.login_nest', 'https://webapi.' + connection.cameraAPIHost).href,
          {
            withCredentials: true,
            headers: {
              Referer: 'https://' + connection.referer,
              Origin: 'https://' + connection.referer,
              'User-Agent': USER_AGENT,
              'Content-Type': 'application/x-www-form-urlencoded',
              'Sec-Fetch-Mode': 'cors',
              'Sec-Fetch-Site': 'same-origin',
            },
          },
          Buffer.from('access_token=' + connection.access_token, 'utf8'),
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

        // Get Nest session details after successful login
        let sessionResponse = await fetchWrapper('get', new URL('/session', 'https://' + connection.restAPIHost).href, {
          headers: {
            Referer: 'https://' + connection.referer,
            Origin: 'https://' + connection.referer,
            Authorization: 'Basic ' + connection.access_token,
            'User-Agent': USER_AGENT,
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
          },
        });

        let sessionData = await sessionResponse.json();

        // Apply final authorised state
        applyAuthorisedConnection(
          sessionData,
          {
            key: 'cookie',
            value: connection.fieldTest === true ? 'website_ft=' : 'website_2=',
            token: nestToken,
            fieldTest: connection.fieldTest === true,
          },
          3600 * 24,
          isRetry === true
            ? 'Successfully performed token refresh using Nest account for connection "%s"'
            : 'Successfully authorised using Nest account for connection "%s"',
        );
      } catch (error) {
        handleConnectError(
          error,
          ['ERR_INVALID_URL', 401, 403],
          'Token refresh failed using Nest account for connection "%s"',
          'Authorisation failed using Nest account for connection "%s"',
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
        let changedData = new Map(); // Map of objectKey to { fields: Set(...) }
        let objects = [];

        if (Array.isArray(data?.updated_buckets) === true) {
          // Full data read response
          objects = data.updated_buckets;
        }

        if (Array.isArray(data?.objects) === true) {
          // Incremental subscribe update response
          objects = data.objects;
        }

        // Process the data we received
        fullRead = false; // Reset full refresh flag unless triggered below

        for (let object of objects) {
          let objectKey = object?.object_key;
          let incomingValue = typeof object?.value === 'object' && object.value !== null ? { ...object.value } : {};
          let existingEntry = this.#rawData?.[objectKey];
          let existingValue = typeof existingEntry?.value === 'object' && existingEntry.value !== null ? existingEntry.value : {};
          let changedFields = new Set();

          if ((objectKey?.trim?.() ?? '') === '') {
            continue;
          }

          // Detect changed top-level raw fields using shallow comparison.
          // This is intentional:
          // - nested objects/arrays are treated as changed if their reference differs
          // - avoids expensive deep comparison during frequent Nest API updates
          // - HomeKitDevice performs a deeper comparison later on the final merged device data
          //
          // NOTE: This may over-report changes for complex values, but that is acceptable here
          // because this change set is only used to guide downstream processing.
          Object.keys(incomingValue).forEach((field) => {
            if (existingValue[field] !== incomingValue[field]) {
              changedFields.add(field);
            }
          });

          if (objectKey.startsWith('structure.') === true) {
            // Add weather data based on the structure location details
            let weatherData = await this.#getLocationWeather(uuid, objectKey, incomingValue.postal_code, incomingValue.country_code);
            if (weatherData !== undefined) {
              incomingValue.weather = weatherData;
              changedFields.add('weather');
            }

            // Detect removed child objects from the swarm list and clean up local cache
            if (typeof existingValue?.swarm === 'object' && Array.isArray(incomingValue?.swarm) === true) {
              let newSwarmSet = new Set(incomingValue.swarm);

              existingValue.swarm.forEach((childObjectKey) => {
                if (newSwarmSet.has(childObjectKey) === false) {
                  delete this.#rawData[childObjectKey];
                }
              });
            }

            // Store the internal Nest structure uuid if matched to a configured home
            Object.assign(
              this.config?.homes?.find((home) => home?.name?.trim?.().toUpperCase() === incomingValue?.name?.trim?.().toUpperCase()) || {},
              { nest_home_uuid: objectKey },
            );
          }

          if (objectKey.startsWith('quartz.') === true) {
            // Retrieve additional camera/doorbell properties
            let properties = await this.#getCameraProperties(uuid, objectKey);

            incomingValue.properties =
              typeof properties === 'object' && properties.constructor === Object
                ? properties
                : typeof existingValue?.properties === 'object' && existingValue.properties.constructor === Object
                  ? existingValue.properties
                  : {};

            changedFields.add('properties');
          }

          if (objectKey.startsWith('buckets.') === true) {
            if (
              typeof existingEntry === 'object' &&
              Array.isArray(existingValue?.buckets) === true &&
              Array.isArray(incomingValue?.buckets) === true
            ) {
              // Compare previous vs incoming buckets list to detect topology changes
              let newBucketsSet = new Set(incomingValue.buckets);

              // If an existing object is missing from the new list, trigger a full refresh
              existingValue.buckets.forEach((childObjectKey) => {
                if (newBucketsSet.has(childObjectKey) === false) {
                  fullRead = true;
                }
              });

              let oldBucketsSet = new Set(existingValue.buckets);

              // Detect removed objects and clean up local state
              incomingValue.buckets.forEach((childObjectKey) => {
                if (oldBucketsSet.has(childObjectKey) === false) {
                  // Object existed previously but is no longer referenced, so treat as removed
                  if (
                    childObjectKey.startsWith('structure.') === true ||
                    childObjectKey.startsWith('device.') === true ||
                    childObjectKey.startsWith('kryptonite.') === true ||
                    childObjectKey.startsWith('topaz.') === true ||
                    childObjectKey.startsWith('quartz.') === true
                  ) {
                    let serialNumber = this.#rawData?.[childObjectKey]?.value?.serial_number;
                    let trackedDevice = this.#trackedDevices.get(serialNumber);

                    if (trackedDevice !== undefined) {
                      HomeKitDevice.message(trackedDevice.uuid, HomeKitDevice.REMOVE, {});
                      this.#trackedDevices.delete(serialNumber);
                    }
                  }

                  delete this.#rawData[childObjectKey];
                }
              });
            }
          }

          // Only record this object if at least one field changed
          if (changedFields.size !== 0) {
            changedData.set(objectKey, { fields: changedFields });
          }

          // Merge incoming data into the raw data store
          this.#rawData[objectKey] = {
            object_revision: object.object_revision,
            object_timestamp: object.object_timestamp,
            connection: uuid,
            source: DATA_SOURCE.NEST,
            value: {
              ...existingValue,
              ...incomingValue,
            },
          };
        }

        await this.#processData(uuid, changedData);
      })
      .catch((error) => {
        // Attempt to extract HTTP status code from error cause or error object
        let statusCode =
          error?.code !== undefined && error?.code !== null
            ? error.code
            : error?.status !== undefined && error?.status !== null
              ? error.status
              : undefined;

        // If we get a 401 Unauthorized or 403 Forbidden and the connection was previously authorised,
        // mark it as unauthorised so the reconnect loop will handle it
        if ((statusCode === 401 || statusCode === 403) && this.#connections?.[uuid]?.authorised === true) {
          this?.log?.debug?.(
            'Connection "%s" is no longer authorised with the Nest API, will attempt to reconnect',
            this.#connections[uuid].name,
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

  async #observeGoogleAPI(uuid) {
    if (
      this.#protobufRoot === undefined ||
      this.#protobufRoot === null ||
      typeof this.#connections?.[uuid] !== 'object' ||
      this.#connections?.[uuid]?.authorised !== true ||
      this.#connections?.[uuid]?.grpcTransport === undefined ||
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

    // Dedupe the observe traits list since there can be some overlap in the traits
    // due to the dynamic nature of the protobuf loading and trait type matching
    observeTraitsList = [...new Map(observeTraitsList.map((entry) => [entry.traitType, entry])).values()];

    this.#connections[uuid].grpcTransport
      .observe(
        'nestlabs.gateway.v2.',
        'GatewayService',
        'Observe',
        { stateTypes: ['CONFIRMED', 'ACCEPTED'], traitTypeParams: observeTraitsList },
        async (message) => {
          let observeResponses = Array.isArray(message?.observeResponse) === true ? message.observeResponse : [message].filter(Boolean);
          let changedData = new Map(); // Map of resourceId to { fields: Set(...) } for processing after the loop

          // We'll use the resource status message to look for structure and/or device removals
          // We could also check for structure and/or device additions here, but we'll want to be flagged
          // that a device is 'ready' for use before we add in. This data is populated in the trait data
          for (let observeResponse of observeResponses) {
            // resourceMetas
            if (Array.isArray(observeResponse?.resourceMetas) === true) {
              for (let resource of observeResponse.resourceMetas) {
                if (
                  resource.status === 'REMOVED' &&
                  (resource.resourceId.startsWith('STRUCTURE_') === true || resource.resourceId.startsWith('DEVICE_') === true)
                ) {
                  // We have the removal of a 'home' and/or device
                  // Tidy up tracked devices since this one is removed
                  let serialNumber = this.#rawData?.[resource.resourceId]?.value?.device_identity?.serialNumber;
                  let trackedDevice = this.#trackedDevices.get(serialNumber);

                  if (trackedDevice !== undefined) {
                    // Send removed notice onto HomeKit device for it to process
                    HomeKitDevice.message(trackedDevice.uuid, HomeKitDevice.REMOVE, {});

                    // Finally, remove from tracked devices
                    this.#trackedDevices.delete(serialNumber);
                  }

                  delete this.#rawData[resource.resourceId];
                }
              }
            }

            // traitStates
            if (Array.isArray(observeResponse?.traitStates) === true) {
              // Tidy up our received trait states. This ensures we only have one status for the trait in the data we process
              // We'll favour a trait with accepted status over the same with confirmed status
              let traits = observeResponse.traitStates;
              let acceptedKeys = new Set(
                traits
                  .filter((trait) => trait.stateTypes.includes('ACCEPTED') === true)
                  .map((trait) => trait.traitId.resourceId + '/' + trait.traitId.traitLabel),
              );
              observeResponse.traitStates = [
                ...traits.filter((trait) => acceptedKeys.has(trait.traitId.resourceId + '/' + trait.traitId.traitLabel) === false),
                ...traits.filter((trait) => trait.stateTypes.includes('ACCEPTED') === true),
              ];

              for (let trait of observeResponse.traitStates) {
                let resourceId = trait.traitId.resourceId;
                let traitLabel = trait.traitId.traitLabel;
                let patchValues = trait?.patch?.values ?? {};
                let changedEntry = changedData.get(resourceId);

                // Mapped changed data for processing after the loop
                if (changedEntry === undefined) {
                  changedEntry = { fields: new Set() };
                  changedData.set(resourceId, changedEntry);
                }
                changedEntry.fields.add(traitLabel);

                // Create or update trait entry and assign latest patch values
                this.#rawData[resourceId] = {
                  connection: uuid,
                  source: DATA_SOURCE.GOOGLE,
                  value: {
                    ...this.#rawData?.[resourceId]?.value,
                    [traitLabel]: patchValues,
                  },
                };

                // Remove trait type metadata — we don't need to store it
                delete this.#rawData[resourceId]?.value?.[traitLabel]?.['@type'];

                // If we have structure location details and associated geo-location details, get the weather data for the location
                // We'll store this in the object key/value as per Nest API
                if (
                  resourceId.startsWith('STRUCTURE_') === true &&
                  traitLabel === 'structure_location' &&
                  (patchValues?.postalCode?.value?.trim?.() ?? '') !== '' &&
                  (patchValues?.countryCode?.value?.trim?.() ?? '') !== ''
                ) {
                  let weatherData = await this.#getLocationWeather(
                    uuid,
                    resourceId,
                    patchValues.postalCode.value,
                    patchValues.countryCode.value,
                  );

                  if (weatherData !== undefined && typeof this.#rawData?.[resourceId]?.value === 'object') {
                    this.#rawData[resourceId].value.weather = { ...weatherData };
                    changedEntry.fields.add('weather');
                  }
                }

                // Store the internal Nest and Google structure uuids if matched to a defined home array entry
                if (
                  resourceId.startsWith('STRUCTURE_') === true &&
                  traitLabel === 'structure_info' &&
                  (patchValues?.name?.trim?.() ?? '') !== ''
                ) {
                  Object.assign(
                    this.config?.homes?.find((home) => home?.name?.trim?.().toUpperCase() === patchValues.name?.trim?.().toUpperCase()) ||
                      {},
                    { nest_home_uuid: patchValues.rtsStructureId, google_home_uuid: resourceId },
                  );
                }

                // We have an update for a camera live image trait
                // so we'll trigger any waiting snapshot requests to process this new image data
                if (traitLabel === 'upload_live_image' && this.#connections?.[uuid]?.snapshotWaiters instanceof Map) {
                  let waiter = this.#connections[uuid].snapshotWaiters.get(resourceId);

                  this.#connections[uuid].snapshotWaiters.delete(resourceId);

                  if (typeof waiter === 'function') {
                    waiter();
                  }
                }
              }
            }
          }

          await this.#processData(uuid, changedData);
        },
      )
      .catch((error) => {
        this?.log?.debug?.(
          'Google API observe failed for connection "%s": %s',
          this.#connections?.[uuid]?.name,
          typeof error?.message === 'string' ? error.message : String(error),
        );
      })
      .finally(() => {
        // Only continue the observe loop if the connection is still authorised
        if (this.#connections?.[uuid]?.authorised === true) {
          setTimeout(() => this.#observeGoogleAPI(uuid), 1000);
        }
      });
  }

  async #processData(uuid, changedData = undefined) {
    const dumpSupportData = (source, changedData = undefined) => {
      let sourceInfo =
        source === DATA_SOURCE.GOOGLE ? { name: 'Google API' } : source === DATA_SOURCE.NEST ? { name: 'Nest API' } : undefined;
      let didLogAny = false;
      let isDelta = changedData instanceof Map === true && changedData.size !== 0;

      // Validate we should attempt a support dump for this connection/source
      if (
        this?.config?.options?.supportDump !== true ||
        typeof uuid !== 'string' ||
        uuid.trim() === '' ||
        typeof this.#connections?.[uuid] !== 'object' ||
        typeof sourceInfo !== 'object'
      ) {
        return;
      }

      // Iterate raw data directly and decide at object/field level what to output
      Object.entries(this.#rawData).forEach(([objectKey, data]) => {
        let changedFields = isDelta === true ? changedData.get(objectKey)?.fields : undefined;
        let loggedObject = false;

        // Only process objects for this source/connection with valid value payload
        if (
          data?.source !== source ||
          data?.connection !== uuid ||
          typeof data?.value !== 'object' ||
          data.value === null ||
          Object.keys(data.value).length === 0
        ) {
          return;
        }

        // In delta mode, skip objects that were not part of this update
        if (isDelta === true && changedFields instanceof Set !== true) {
          return;
        }

        Object.entries(data.value).forEach(([key, value]) => {
          // In delta mode, only output fields that were part of this update
          if (isDelta === true && changedFields.has(key) !== true) {
            return;
          }

          // Lazily open object and print header only when we actually output something
          if (loggedObject === false) {
            if (didLogAny === false) {
              this?.log?.info?.(
                '%s support dump for %s data will be logged below for troubleshooting purposes.',
                isDelta === true ? 'Changed' : 'Full',
                sourceInfo.name,
              );
            }

            this?.log?.info?.('{');
            this?.log?.info?.('  "%s": {', objectKey);

            loggedObject = true;
            didLogAny = true;
          }

          // Pretty-print nested objects
          if (typeof value === 'object' && value !== null) {
            this?.log?.info?.('  %s:', key);

            String(JSON.stringify(value, null, 2))
              .split('\n')
              .forEach((line) => {
                this?.log?.info?.('    %s', line);
              });

            return;
          }

          // Primitive values
          this?.log?.info?.('  %s: %j', key, value);
        });

        // Close object if we logged any fields
        if (loggedObject === true) {
          this?.log?.info?.('  }');
          this?.log?.info?.('}');
        }
      });

      // Footer only if something was actually logged
      if (didLogAny === true) {
        this?.log?.info?.('End of support dump for %s data.', sourceInfo.name);
      }
    };

    // First run logs a full baseline per source/connection.
    // Later runs log only the changed fields for changed objects in this cycle.
    dumpSupportData(DATA_SOURCE.NEST, changedData);
    dumpSupportData(DATA_SOURCE.GOOGLE, changedData);

    // Process the raw data through each of the device modules to get the latest device details and states
    for (let [deviceType, deviceModule] of this.#deviceModules) {
      if (typeof deviceModule?.processRawData === 'function') {
        let devices = {};

        try {
          devices = deviceModule.processRawData(this.log, this.#rawData, this.config, deviceType, changedData);
        } catch (error) {
          this?.log?.warn?.('%s module failed to process data. Error was "%s"', deviceType, String(error));
        }

        if (typeof devices === 'object' && devices !== null) {
          for (let [serialNumber, result] of Object.entries(devices)) {
            let deviceData = result?.data;
            let isFull = result?.full === true;
            let trackedDevice = this.#trackedDevices.get(serialNumber);

            if (deviceData === null || typeof deviceData !== 'object' || deviceData?.constructor !== Object) {
              continue;
            }

            if (trackedDevice === undefined && isFull === true && deviceData?.excluded === true) {
              // We haven't tracked this device before (ie: should be a new one) and but its excluded
              let homeName =
                this.#rawData?.[deviceData.nest_google_home_uuid]?.value?.name ||
                this.#rawData?.[deviceData.nest_google_home_uuid]?.value?.structure_info?.name;

              if (deviceType !== DEVICE_TYPE.WEATHER) {
                this?.log?.warn?.(
                  'Device "%s"%s is ignored due to it being marked as excluded',
                  deviceData.description,
                  (homeName?.trim?.() ?? '') !== '' ? ' in "' + homeName + '"' : '',
                );
              }

              // Track this device even though its excluded
              this.#trackedDevices.set(serialNumber, {
                uuid: HomeKitDevice.generateUUID(HomeKitDevice.PLUGIN_NAME, this.api, serialNumber),
                nest_google_device_uuid: deviceData.nest_google_device_uuid,
                source: undefined, // gets filled out later
                timers: undefined,
                exclude: true,
              });

              trackedDevice = this.#trackedDevices.get(serialNumber);

              // If the device is now marked as excluded and present in accessory cache
              // Then we'll unregister it from the Homebridge platform
              let accessory = this.cachedAccessories.find((accessory) => accessory?.UUID === trackedDevice.uuid);

              if (accessory !== undefined && typeof accessory === 'object') {
                try {
                  this.api.unregisterPlatformAccessories(HomeKitDevice.PLUGIN_NAME, HomeKitDevice.PLATFORM_NAME, [accessory]);
                  // eslint-disable-next-line no-unused-vars
                } catch (error) {
                  // Empty
                }
              }
            }

            if (trackedDevice === undefined && isFull === true && deviceData?.excluded === false) {
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
                tempDevice.add(accessoryName, getDeviceHKCategory(deviceModule.class.TYPE), deviceData?.eveHistory === true);

                // Register per-device set/get handlers
                HomeKitDevice.message(tempDevice.uuid, HomeKitDevice.SET, async (values) => {
                  await this.#set(this.#rawData?.[values?.uuid]?.connection, values?.uuid, values);
                });

                HomeKitDevice.message(tempDevice.uuid, HomeKitDevice.GET, async (values) => {
                  return await this.#get(this.#rawData?.[values?.uuid]?.connection, values?.uuid, values);
                });

                // Track this device once created
                this.#trackedDevices.set(serialNumber, {
                  uuid: tempDevice.uuid,
                  nest_google_device_uuid: deviceData.nest_google_device_uuid,
                  source: undefined, // gets filled out later
                  timers: {},
                  exclude: false,
                });

                trackedDevice = this.#trackedDevices.get(serialNumber);
              }
            }

            // Ignore partial payloads for devices we have not yet created/tracked
            if (trackedDevice === undefined) {
              continue;
            }

            // Finally, if device is not excluded, send updated data to device for it to process
            if (trackedDevice?.exclude === false) {
              if (
                deviceData?.nest_google_device_uuid !== undefined &&
                this.#rawData?.[deviceData.nest_google_device_uuid]?.source !== undefined &&
                this.#rawData[deviceData.nest_google_device_uuid].source !== trackedDevice.source
              ) {
                // Data source for this device has been updated
                // Only allow switch to Google API (upgrade), not from Google to Nest (downgrade)
                // Exception: Camera, doorbell, and floodlight devices can switch back to Nest
                let isCameraType =
                  deviceModule.class.TYPE === DEVICE_TYPE.CAMERA ||
                  deviceModule.class.TYPE === DEVICE_TYPE.DOORBELL ||
                  deviceModule.class.TYPE === DEVICE_TYPE.FLOODLIGHT;

                let allowSourceSwitch =
                  trackedDevice.source === undefined ||
                  (trackedDevice.source === DATA_SOURCE.NEST &&
                    this.#rawData[deviceData.nest_google_device_uuid].source === DATA_SOURCE.GOOGLE) ||
                  (isCameraType === true && trackedDevice.source === DATA_SOURCE.GOOGLE);

                if (allowSourceSwitch === true) {
                  this?.log?.debug?.(
                    'Using %s API as data source for "%s" from connection "%s"',
                    this.#rawData[deviceData.nest_google_device_uuid].source,
                    deviceData.description,
                    this.#connections[this.#rawData[deviceData.nest_google_device_uuid].connection].name,
                  );

                  trackedDevice.source = this.#rawData[deviceData.nest_google_device_uuid].source;
                  trackedDevice.nest_google_device_uuid = deviceData.nest_google_device_uuid;
                }
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
              HomeKitDevice.message(trackedDevice.uuid, HomeKitDevice.UPDATE, deviceData);
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
      try {
        if (key === 'uuid') {
          // We don't do anything with the key containing the uuid
          continue;
        }

        if (
          this.#rawData?.[nest_google_device_uuid]?.source === DATA_SOURCE.GOOGLE &&
          this.#connections?.[uuid]?.grpcTransport !== undefined
        ) {
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

          // Helper function to set the update trait details based on the key/value passed in.
          // with optional explicit trait value and updates to merge in
          let setUpdateTrait = (traitLabel, typeURL, traitValue = undefined, updates = undefined) => {
            updateElement.traitRequest.traitLabel = traitLabel;
            updateElement.state.type_url = typeURL;

            // If no explicit value passed, infer from rawData
            if (traitValue === undefined) {
              traitValue = this.#rawData?.[nest_google_device_uuid]?.value?.[traitLabel];
            }

            updateElement.state.value = typeof traitValue === 'object' && traitValue !== null ? structuredClone(traitValue) : {};

            // Optionally merge in simple top-level updates
            if (typeof updates === 'object' && updates !== null) {
              Object.assign(updateElement.state.value, updates);
            }
          };

          // Helper function to set the command trait details based on the key/value passed in (optional explicit resourceId override)
          let setCommandTrait = (traitLabel, typeURL, commandValue, resourceId = nest_google_device_uuid) => {
            commandElement.resourceRequest.resourceId = resourceId;
            commandElement.resourceCommands = [
              {
                traitLabel,
                command: {
                  type_url: typeURL,
                  value: commandValue,
                },
              },
            ];
          };

          if (
            (key === 'hvac_mode' && ['OFF', 'COOL', 'HEAT', 'RANGE'].includes(value?.toUpperCase?.())) ||
            (['target_temperature', 'target_temperature_low', 'target_temperature_high'].includes(key) === true &&
              this.#rawData?.[nest_google_device_uuid]?.value?.eco_mode_state?.ecoMode === 'ECO_MODE_INACTIVE' &&
              isNaN(value) === false)
          ) {
            // Set either the 'mode' and/or non-eco temperatures on the target thermostat
            setUpdateTrait('target_temperature_settings', 'type.nestlabs.com/nest.trait.hvac.TargetTemperatureSettingsTrait');

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
            setUpdateTrait('eco_mode_settings', 'type.nestlabs.com/nest.trait.hvac.EcoModeSettingsTrait');

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

          if (key === 'temperature_scale' && (value?.toUpperCase?.() === 'C' || value?.toUpperCase?.() === 'F')) {
            // Set the temperature scale on the target thermostat
            setUpdateTrait('display_settings', 'type.nestlabs.com/nest.trait.hvac.DisplaySettingsTrait', undefined, {
              temperatureScale: value.toUpperCase() === 'F' ? 'TEMPERATURE_SCALE_F' : 'TEMPERATURE_SCALE_C',
            });
          }

          if (key === 'temperature_lock' && typeof value === 'boolean') {
            // Set lock mode on the target thermostat
            setUpdateTrait('temperature_lock_settings', 'type.nestlabs.com/nest.trait.hvac.TemperatureLockSettingsTrait', undefined, {
              enabled: value,
            });
          }

          if (key === 'fan_state' && typeof value === 'boolean' && isNaN(values?.fan_duration) === false) {
            // Set fan mode on the target thermostat, including runtime if turning on
            setUpdateTrait('fan_control_settings', 'type.nestlabs.com/nest.trait.hvac.FanControlSettingsTrait');
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
            setUpdateTrait('fan_control_settings', 'type.nestlabs.com/nest.trait.hvac.FanControlSettingsTrait');
            updateElement.state.value.timerSpeed =
              value !== 0
                ? 'FAN_SPEED_SETTING_STAGE' + value
                : this.#rawData[nest_google_device_uuid].value.fan_control_settings.timerSpeed;
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
            setUpdateTrait('recording_toggle_settings', 'type.nestlabs.com/nest.trait.product.camera.RecordingToggleSettingsTrait');
            updateElement.state.value.targetCameraState = value === true ? 'CAMERA_ON' : 'CAMERA_OFF';
            updateElement.state.value.changeModeReason = 2;
            updateElement.state.value.settingsUpdated = {
              seconds: Math.floor(Date.now() / 1000),
              nanos: (Date.now() % 1000) * 1e6,
            };
          }

          if (key === 'audio_enabled' && typeof value === 'boolean') {
            // Enable/disable microphone on camera/doorbell
            setUpdateTrait('microphone_settings', 'type.nestlabs.com/nest.trait.audio.MicrophoneSettingsTrait', undefined, {
              enableMicrophone: value,
            });
          }

          if (key === 'indoor_chime_enabled' && typeof value === 'boolean') {
            // Enable/disable chime status on doorbell
            setUpdateTrait(
              'doorbell_indoor_chime_settings',
              'type.nestlabs.com/nest.trait.product.doorbell.DoorbellIndoorChimeSettingsTrait',
              undefined,
              { chimeEnabled: value },
            );
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
              setCommandTrait('on_off', 'type.nestlabs.com/weave.trait.actuator.OnOffTrait.SetStateRequest', { on: value }, serviceUUID);
            }
          }

          if (key === 'light_brightness' && isNaN(value) === false) {
            // Set light brightness on supported camera devices. Needs to be scaled to 0-10 for the API
            setUpdateTrait('floodlight_settings', 'type.nestlabs.com/google.trait.product.camera.FloodlightSettingsTrait', undefined, {
              brightness: scaleValue(Number(value), 0, 100, 0, 10),
            });
          }

          if (
            key === 'active_sensor' &&
            typeof value === 'boolean' &&
            typeof this.#rawData?.[this.#rawData[nest_google_device_uuid]?.value?.associated_thermostat]?.value
              ?.remote_comfort_sensing_settings === 'object'
          ) {
            // Set active temperature sensor for associated thermostat
            updateElement.traitRequest.resourceId = this.#rawData[nest_google_device_uuid].value.associated_thermostat;
            setUpdateTrait(
              'remote_comfort_sensing_settings',
              'type.nestlabs.com/nest.trait.hvac.RemoteComfortSensingSettingsTrait',
              this.#rawData[this.#rawData[nest_google_device_uuid].value.associated_thermostat].value.remote_comfort_sensing_settings,
            );
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
            setUpdateTrait('hot_water_settings', 'type.nestlabs.com/nest.trait.hvac.HotWaterSettingsTrait');
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
            setUpdateTrait('hot_water_settings', 'type.nestlabs.com/nest.trait.hvac.HotWaterSettingsTrait');
            updateElement.state.value.temperature = {
              ...(updateElement.state.value.temperature ?? {}),
              value: value,
            };
          }

          if (key === 'bolt_lock' && typeof value === 'boolean') {
            // Set lock state
            setCommandTrait('bolt_lock', 'type.nestlabs.com/weave.trait.security.BoltLockTrait.BoltLockChangeRequest', {
              state: value === true ? 'BOLT_STATE_EXTENDED' : 'BOLT_STATE_RETRACTED',
              boltLockActor: {
                method: 'BOLT_LOCK_ACTOR_METHOD_REMOTE_USER_EXPLICIT',
                originator: { resourceId: nest_google_device_uuid },
                agent: null,
              },
            });
          }

          if (key === 'auto_relock_duration' && isNaN(value) === false) {
            // Set lock auto-relock duration
            setUpdateTrait('bolt_lock_settings', 'type.nestlabs.com/weave.trait.security.BoltLockSettingsTrait');
            updateElement.state.value.autoRelockDuration = {
              ...(updateElement.state.value.autoRelockDuration ?? {}),
              seconds: value,
            };
          }

          if (
            key === 'vacation_mode' &&
            typeof value === 'boolean' &&
            (this.#rawData?.[nest_google_device_uuid]?.value?.device_info?.pairerId?.resourceId ?? '') !== ''
          ) {
            // Set vacation mode on structure
            setCommandTrait(
              'structure_mode',
              'type.nestlabs.com/nest.trait.occupancy.StructureModeTrait.StructureModeChangeRequest',
              {
                structureMode: value === true ? 'STRUCTURE_MODE_VACATION' : 'STRUCTURE_MODE_HOME',
                reason: 'STRUCTURE_MODE_REASON_EXPLICIT_INTENT',
                userId: {
                  resourceId: nest_google_device_uuid,
                },
              },
              this.#rawData[nest_google_device_uuid].value.device_info.pairerId.resourceId,
            );
          }

          if (
            key === 'dehumidifier_state' &&
            typeof value === 'boolean' &&
            this.#rawData?.[nest_google_device_uuid]?.value?.hvac_equipment_capabilities?.hasDehumidifier === true
          ) {
            // Set dehumidifier on/off on the target thermostat
            setUpdateTrait('humidity_control_settings', 'type.nestlabs.com/nest.trait.hvac.HumidityControlSettingsTrait');
            updateElement.state.value.dehumidifierTargetHumidity = {
              ...(updateElement.state.value.dehumidifierTargetHumidity ?? {}),
              enabled: value,
            };
          }

          if (
            key === 'target_humidity_dehumidifier' &&
            isNaN(value) === false &&
            this.#rawData?.[nest_google_device_uuid]?.value?.hvac_equipment_capabilities?.hasDehumidifier === true
          ) {
            // Set dehumidifier target humidity on the target thermostat
            setUpdateTrait('humidity_control_settings', 'type.nestlabs.com/nest.trait.hvac.HumidityControlSettingsTrait');
            updateElement.state.value.dehumidifierTargetHumidity = {
              ...(updateElement.state.value.dehumidifierTargetHumidity ?? {}),
              value: Number(value),
            };
          }

          if (
            key === 'humidifier_state' &&
            typeof value === 'boolean' &&
            this.#rawData?.[nest_google_device_uuid]?.value?.hvac_equipment_capabilities?.hasHumidifier === true
          ) {
            // Set humidifier on/off on the target thermostat
            setUpdateTrait('humidity_control_settings', 'type.nestlabs.com/nest.trait.hvac.HumidityControlSettingsTrait');
            updateElement.state.value.humidifierTargetHumidity = {
              ...(updateElement.state.value.humidifierTargetHumidity ?? {}),
              enabled: value,
            };
          }

          if (
            key === 'target_humidity_humidifier' &&
            isNaN(value) === false &&
            this.#rawData?.[nest_google_device_uuid]?.value?.hvac_equipment_capabilities?.hasHumidifier === true
          ) {
            // Set humidifier target humidity on the target thermostat
            setUpdateTrait('humidity_control_settings', 'type.nestlabs.com/nest.trait.hvac.HumidityControlSettingsTrait');
            updateElement.state.value.humidifierTargetHumidity = {
              ...(updateElement.state.value.humidifierTargetHumidity ?? {}),
              value: Number(value),
            };
          }

          if (updateElement.traitRequest.traitLabel !== '' && updateElement.state.type_url !== '') {
            updatedTraits.push(structuredClone(updateElement));
          }

          if (Array.isArray(commandElement?.resourceCommands) === true && commandElement.resourceCommands.length !== 0) {
            commandTraits.push(structuredClone(commandElement));
          }

          // Perform any direct trait updates we have to do. This can be done via a single call in a batch
          if (updatedTraits.length !== 0) {
            let grpcResult = await this.#connections[uuid].grpcTransport.command(
              'nestlabs.gateway.v1.',
              'TraitBatchApi',
              'BatchUpdateState',
              {
                batchUpdateStateRequest: updatedTraits,
              },
            );
            let commandResponse = Array.isArray(grpcResult?.data) === true ? grpcResult.data[0] : undefined;
            if (commandResponse?.traitOperations?.[0]?.progress !== 'COMPLETE') {
              this?.log?.debug?.('Google API had error updating traits for device uuid "%s"', nest_google_device_uuid);
            }
          }

          // Perform any trait updates required via resource commands. Each one is done separately
          for (let command of commandTraits ?? []) {
            let grpcResult = await this.#connections[uuid].grpcTransport.command(
              'nestlabs.gateway.v1.',
              'ResourceApi',
              'SendCommand',
              command,
            );
            let commandResponse = Array.isArray(grpcResult?.data) === true ? grpcResult.data[0] : undefined;
            if (commandResponse?.traitOperations?.[0]?.progress !== 'COMPLETE') {
              this?.log?.debug?.(
                'Google API had error setting "%s" for device uuid "%s"',
                command?.resourceCommands?.[0]?.traitLabel,
                nest_google_device_uuid,
              );
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
                  fan_state: value,
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
              isNaN(values?.target_humidity) === false &&
              nest_google_device_uuid.startsWith('device.') === true &&
              this.#rawData?.[nest_google_device_uuid]?.value?.has_dehumidifier === true
            ) {
              // Set dehumidifier state on thermostat
              subscribeJSONData.objects.push({
                object_key: nest_google_device_uuid,
                op: 'MERGE',
                value: { dehumidifier_state: value, target_humidity: Number(values.target_humidity) },
              });
            }

            if (
              key === 'humidifier_state' &&
              typeof value === 'boolean' &&
              isNaN(values?.target_humidity) === false &&
              nest_google_device_uuid.startsWith('device.') === true &&
              this.#rawData?.[nest_google_device_uuid]?.value?.has_humidifier === true
            ) {
              // Set humidifier state on thermostat
              subscribeJSONData.objects.push({
                object_key: nest_google_device_uuid,
                op: 'MERGE',
                value: { humidifier_state: value, target_humidity: Number(values.target_humidity) },
              });
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
              let response = await fetchWrapper(
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
              let data = await response.json();
              if (Array.isArray(data?.objects) === false || data.objects.length === 0) {
                throw new Error('Nest API property update failed');
              }
            }
          }
        }
      } catch (error) {
        this?.log?.debug?.(
          'Failed processing set request for key "%s" on device uuid "%s". Error was "%s"',
          key,
          nest_google_device_uuid,
          typeof error?.message === 'string' ? error.message : String(error),
        );
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
        // Keep this timeout shorter than HomeKit's patience so we either return a snapshot
        // quickly or fall back cleanly without prolonged blocking.
        try {
          values[key] = await Promise.race([
            this.#getCameraSnapshot(uuid, nest_google_device_uuid),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Snapshot request timeout')), SNAPSHOT_TIMEOUT)),
          ]);
        } catch (error) {
          this?.log?.debug?.(
            'Camera snapshot request failed for device uuid "%s". Error was "%s"',
            nest_google_device_uuid,
            typeof error?.message === 'string' ? error.message : String(error),
          );
          values[key] = undefined;
        }
      }

      if (key === 'location_weather') {
        // Weather data requested.
        // We'll pass in the postal code and country code for the device if available to get localised weather data
        try {
          values[key] = await this.#getLocationWeather(
            uuid,
            nest_google_device_uuid,
            this.#rawData[nest_google_device_uuid].value?.weather?.postal_code,
            this.#rawData[nest_google_device_uuid].value?.weather?.country_code,
          );
        } catch (error) {
          this?.log?.debug?.(
            'Weather request failed for device uuid "%s". Error was "%s"',
            nest_google_device_uuid,
            typeof error?.message === 'string' ? error.message : String(error),
          );
          values[key] = undefined;
        }
      }

      if (key === 'camera_events') {
        // Camera events requested.
        // We'll pass in the nexus api server url for Nest API devices
        try {
          values[key] = await this.#getCameraEvents(
            uuid,
            nest_google_device_uuid,
            this.#rawData[nest_google_device_uuid]?.value?.nexus_api_http_server_url ?? undefined,
          );
        } catch (error) {
          this?.log?.debug?.(
            'Camera events request failed for device uuid "%s". Error was "%s"',
            nest_google_device_uuid,
            typeof error?.message === 'string' ? error.message : String(error),
          );
          values[key] = undefined;
        }
      }
    }

    return values;
  }

  async #getCameraSnapshot(uuid, nest_google_device_uuid) {
    if (
      this.#connections?.[uuid]?.authorised !== true ||
      (this.#connections?.[uuid]?.referer ?? '') === '' ||
      (nest_google_device_uuid?.trim?.() ?? '') === '' ||
      typeof this.#rawData?.[nest_google_device_uuid]?.value !== 'object'
    ) {
      // Not a valid connection object and/or we're not authorised
      return;
    }

    let snapshot = undefined;

    // Shared image fetch logic for both Nest and Google snapshot paths
    let fetchSnapshotImage = async (url, headers) => {
      try {
        let response = await fetchWrapper('get', url, {
          headers,
          retry: 2,
          timeout: SNAPSHOT_FETCH_TIMEOUT,
        });

        let image = Buffer.from(await response.arrayBuffer());

        if (image?.length === 0) {
          this?.log?.debug?.('Snapshot fetch returned empty image for device uuid "%s"', nest_google_device_uuid);
          return;
        }

        return image;
      } catch (error) {
        if (
          error?.cause === undefined ||
          (error.cause?.message?.toUpperCase?.()?.includes('TIMEOUT') === false &&
            error.cause?.code?.toUpperCase?.()?.includes('TIMEOUT') === false)
        ) {
          this?.log?.debug?.(
            'Snapshot fetch failed for device uuid "%s". Error was "%s"',
            nest_google_device_uuid,
            typeof error?.message === 'string' ? error.message : String(error),
          );
        }
      }
    };

    if (
      this.config?.options?.useNestAPI === true &&
      nest_google_device_uuid.startsWith('quartz.') === true &&
      (this.#rawData?.[nest_google_device_uuid]?.value?.nexus_api_http_server_url ?? '') !== '' &&
      (this.#connections?.[uuid]?.cameraAPIHost ?? '') !== '' &&
      (this.#connections?.[uuid]?.cameraAPI?.key ?? '') !== '' &&
      (this.#connections?.[uuid]?.cameraAPI?.value ?? '') !== '' &&
      (this.#connections?.[uuid]?.cameraAPI?.token ?? '') !== ''
    ) {
      // Nest cameras provide a direct image endpoint, so just fetch the latest image available
      snapshot = await fetchSnapshotImage(
        new URL(
          '/get_image?uuid=' + nest_google_device_uuid.trim().split('.')[1],
          this.#rawData[nest_google_device_uuid].value.nexus_api_http_server_url.trim(),
        ).href,
        {
          Referer: 'https://' + this.#connections[uuid].referer,
          Origin: 'https://' + this.#connections[uuid].referer,
          [this.#connections[uuid].cameraAPI.key]: this.#connections[uuid].cameraAPI.value + this.#connections[uuid].cameraAPI.token,
          'User-Agent': USER_AGENT,
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
        },
      );

      if (Buffer.isBuffer(snapshot) === true && snapshot.length > 0) {
        return snapshot;
      }
    }

    if (
      this.config?.options?.useGoogleAPI === true &&
      nest_google_device_uuid.startsWith('DEVICE_') === true &&
      (this.#connections?.[uuid]?.token ?? '') !== '' &&
      this.#connections?.[uuid]?.grpcTransport !== undefined &&
      (PROTOBUF_RESOURCES.CAMERA.includes(this.#rawData?.[nest_google_device_uuid]?.value?.device_info?.typeName) === true ||
        PROTOBUF_RESOURCES.DOORBELL.includes(this.#rawData?.[nest_google_device_uuid]?.value?.device_info?.typeName) === true ||
        PROTOBUF_RESOURCES.FLOODLIGHT.includes(this.#rawData?.[nest_google_device_uuid]?.value?.device_info?.typeName) === true)
    ) {
      // Record the protobuf upload_live_image state before asking for a new snapshot
      // so we can fall back to the previously available image URL if no newer data arrives
      let beforeRequestUploadLiveImage = structuredClone(this.#rawData?.[nest_google_device_uuid]?.value?.upload_live_image ?? {});
      let beforeRequestUrl = beforeRequestUploadLiveImage?.liveImageUrl ?? '';
      let latestUploadLiveImage = beforeRequestUploadLiveImage;
      let latestUrl = beforeRequestUrl;

      // Register a waiter for this device so observe processing can wake this snapshot request
      let snapshotUpdated = false;
      this.#connections?.[uuid]?.snapshotWaiters?.delete?.(nest_google_device_uuid);
      let waitForSnapshotUpdate = new Promise((resolve) => {
        this.#connections[uuid].snapshotWaiters.set(nest_google_device_uuid, () => {
          snapshotUpdated = true;
          resolve();
        });
      });

      // Ask Google to refresh the live image
      let grpcResult = await this.#connections[uuid].grpcTransport.command('nestlabs.gateway.v1.', 'ResourceApi', 'SendCommand', {
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

      let commandResponse = Array.isArray(grpcResult?.data) === true ? grpcResult.data[0] : undefined;

      // Only continue if gRPC reports the camera event request completed successfully
      if (
        commandResponse?.traitOperations?.[0]?.progress === 'COMPLETE' &&
        commandResponse?.traitOperations?.[0]?.event?.event?.status === 'STATUS_SUCCESSFUL'
      ) {
        // Wait briefly for observe processing to deliver updated upload_live_image data for this device.
        // If no update arrives in time, we'll fall back to whatever URL was already available.
        await Promise.race([waitForSnapshotUpdate, new Promise((resolve) => setTimeout(resolve, SNAPSHOT_WAIT_TIMEOUT))]);
      }

      // If timeout won the race, remove the waiter so a later observe update does not resolve a stale request
      if (snapshotUpdated === false) {
        this.#connections?.[uuid]?.snapshotWaiters?.delete?.(nest_google_device_uuid);
      }

      // Re-read final upload_live_image state after either observe update or timeout
      latestUploadLiveImage = structuredClone(this.#rawData?.[nest_google_device_uuid]?.value?.upload_live_image ?? {});
      latestUrl = latestUploadLiveImage?.liveImageUrl ?? '';

      // If Google did not provide a newer URL in time, fall back to the previous URL as the best available snapshot
      if (latestUrl === '') {
        latestUrl = beforeRequestUrl;
      }

      if ((latestUrl ?? '') !== '') {
        snapshot = await fetchSnapshotImage(latestUrl, {
          Referer: 'https://' + this.#connections[uuid].referer,
          Origin: 'https://' + this.#connections[uuid].referer,
          Authorization: 'Basic ' + this.#connections[uuid].token,
          'User-Agent': USER_AGENT,
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
        });

        if (Buffer.isBuffer(snapshot) === true && snapshot.length > 0) {
          return snapshot;
        }
      }

      this?.log?.debug?.('Google API did not provide a usable snapshot URL for device uuid "%s"', nest_google_device_uuid);
    }

    return;
  }

  async #getLocationWeather(uuid, nest_google_device_uuid, postal_code, country_code) {
    if (
      (postal_code?.trim?.() ?? '') === '' ||
      (country_code?.trim?.() ?? '') === '' ||
      this.#connections?.[uuid]?.authorised !== true ||
      (this.#connections?.[uuid]?.referer ?? '') === '' ||
      (this.#connections?.[uuid]?.token ?? '') === '' ||
      (this.#connections?.[uuid]?.restAPIHost ?? '') === '' ||
      (nest_google_device_uuid?.trim?.() ?? '') === ''
    ) {
      // Not a valid connection object and/or we're not authorised
      return;
    }

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
          timeout: 4000,
        },
      );

      let data = await response.json();

      // If returned JSON has an error defined, throw it
      if (data?.error !== undefined) {
        throw new Error(data.error);
      }

      // Ensure we have valid data
      if (
        data?.now?.current_temperature === undefined ||
        data?.now?.current_humidity === undefined ||
        data?.now?.conditions === undefined ||
        data?.now?.wind_direction === undefined ||
        data?.now?.current_wind === undefined ||
        data?.now?.sunrise === undefined ||
        data?.now?.sunset === undefined ||
        data?.forecast?.daily?.[0]?.conditions === undefined
      ) {
        throw new Error('Missing or invalid weather data');
      }

      let weather = {
        // Store the used post/country codes
        postal_code: postal_code,
        country_code: country_code,

        // Update weather data
        current_temperature: adjustTemperature(data.now.current_temperature, 'C', 'C', false),
        current_humidity: data.now.current_humidity,
        condition: data.now.conditions,
        wind_direction: data.now.wind_direction,
        wind_speed: data.now.current_wind,
        sunrise: data.now.sunrise,
        sunset: data.now.sunset,
        station: data.display_city,
        forecast: data.forecast.daily[0].conditions,
      };
      return weather;
    } catch (error) {
      // Log unexpected errors (excluding timeouts) for debugging
      this?.log?.debug?.(
        'Nest API failed to retrieve weather details for device uuid "%s". Error was "%s"',
        nest_google_device_uuid,
        typeof error?.message === 'string' ? error.message : String(error),
      );
      return; // Return undefined if error occurs getting weather data
    }
  }

  async #getCameraProperties(uuid, nest_google_device_uuid) {
    if (
      this.#connections?.[uuid]?.authorised !== true ||
      (this.#connections?.[uuid]?.referer ?? '') === '' ||
      (this.#connections?.[uuid]?.cameraAPIHost ?? '') === '' ||
      (this.#connections?.[uuid]?.cameraAPI?.key ?? '') === '' ||
      (this.#connections?.[uuid]?.cameraAPI?.value ?? '') === '' ||
      (this.#connections?.[uuid]?.cameraAPI?.token ?? '') === '' ||
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
          timeout: 4000,
        },
      );
      let data = await response.json();

      // If returned JSON has empty properties, throw it
      if (data?.items?.[0]?.properties === undefined) {
        throw new Error(data?.status_detail ?? 'Properties missing or empty');
      }

      return data.items[0].properties;
    } catch (error) {
      this?.log?.debug?.(
        'Nest API had error retrieving camera/doorbell properties. Error was "%s"',
        typeof error?.message === 'string' ? error.message : String(error),
      );
      return;
    }
  }

  async #getCameraEvents(uuid, nest_google_device_uuid, nexus_api_url) {
    if (
      this.#connections?.[uuid]?.authorised !== true ||
      (uuid?.trim?.() ?? '') === '' ||
      (nest_google_device_uuid?.trim?.() ?? '') === ''
    ) {
      // Not a valid connection object and/or we're not authorised
      return [];
    }

    if (
      this.config?.options?.useGoogleAPI === true &&
      nest_google_device_uuid.startsWith('DEVICE_') === true &&
      this.#connections?.[uuid]?.grpcTransport !== undefined
    ) {
      let grpcResult = await this.#connections[uuid].grpcTransport.command('nestlabs.gateway.v1.', 'ResourceApi', 'SendCommand', {
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
                // We want camera history from up to 15 seconds ago until now
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

      let commandResponse = Array.isArray(grpcResult?.data) === true ? grpcResult.data[0] : undefined;

      // Only continue if gRPC reports the snapshot request completed successfully
      if (commandResponse?.traitOperations?.[0]?.progress === 'COMPLETE') {
        let events =
          Array.isArray(commandResponse?.traitOperations?.[0]?.event?.event?.cameraEventWindow?.cameraEvent) === true
            ? commandResponse.traitOperations[0].event.event.cameraEventWindow.cameraEvent
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

        return events; // Return events from Google API
      } else {
        this?.log?.debug?.(
          'Google API had error retrieving camera/doorbell activity notifications for device "%s". Error was "%s"',
          nest_google_device_uuid,
        );
        return [];
      }
    }

    if (
      this.config?.options?.useNestAPI === true &&
      nest_google_device_uuid.startsWith('quartz.') === true &&
      (this.#connections?.[uuid]?.referer ?? '') !== '' &&
      (this.#connections?.[uuid]?.cameraAPIHost ?? '') !== '' &&
      (this.#connections?.[uuid]?.cameraAPI?.key ?? '') !== '' &&
      (this.#connections?.[uuid]?.cameraAPI?.value ?? '') !== '' &&
      (this.#connections?.[uuid]?.cameraAPI?.token ?? '') !== '' &&
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
            timeout: 4000,
          },
        );

        let data = await response.json();

        let events =
          Array.isArray(data) === true
            ? data
                .map((alert) => {
                  let zoneIds = Array.isArray(alert.zone_ids) === true ? alert.zone_ids.map((id) => (id !== 0 ? id : 1)) : [1];
                  if (zoneIds.length === 0) {
                    zoneIds.push(1);
                  }
                  return {
                    playback_time: alert.playback_time,
                    start_time: alert.start_time,
                    end_time: alert.end_time,
                    id: alert.id,
                    zone_ids: zoneIds,
                    types: alert.types,
                  };
                })
                .sort((a, b) => b.start_time - a.start_time)
            : [];

        return events; // Return events from Nest API
      } catch (error) {
        this?.log?.debug?.(
          'Nest API had error retrieving camera/doorbell activity notifications for device "%s". Error was "%s"',
          nest_google_device_uuid,
          typeof error?.message === 'string' ? error.message : String(error),
        );
        return [];
      }
    }

    return [];
  }

  #loadProtobufRoot() {
    if (this.#protobufRoot !== undefined && this.#protobufRoot !== null) {
      return;
    }

    if (fs.existsSync(path.join(__dirname, 'protobuf/root.proto')) === true) {
      try {
        protobuf.util.Long = null;
        protobuf.configure();
        this.#protobufRoot = protobuf.loadSync(path.join(__dirname, 'protobuf/root.proto'));

        if (this.#protobufRoot !== null) {
          this?.log?.debug?.('Loaded protobuf support files for Google API');
        }
      } catch (error) {
        this.#protobufRoot = null;
        this?.log?.warn?.(
          'Failed to load protobuf support files for Google API. Error was "%s"',
          typeof error?.message === 'string' ? error.message : String(error),
        );
      }
    }

    if (this.#protobufRoot === null) {
      this?.log?.warn?.(
        'Failed to load protobuf support files for Google API. This will cause certain Nest/Google devices to be unsupported',
      );
    }
  }
}
