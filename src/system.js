// Overall system communications and device management
// Part of homebridge-nest-accfactory
//
// Core platform manager for coordinating Nest/Google cloud data with
// HomeKit device modules.
//
// Handles platform startup/shutdown, device discovery, raw data aggregation,
// protobuf-backed observe/subscribe processing, snapshot coordination, and
// routing of updates and commands between cloud APIs and HomeKit devices.
//
// Responsibilities:
// - Initialise validated configuration and device support modules
// - Build and start configured Nest/Google account connections
// - Observe and subscribe to cloud updates in near real-time
// - Aggregate and maintain raw device data from multiple API sources
// - Coordinate protobuf-backed camera snapshot requests and responses
// - Discover, create, update, and remove supported device instances
// - Route HomeKit get/set requests to the correct upstream API
// - Build protobuf-backed observe trait subscriptions
// - Generate support dumps for troubleshooting when enabled
//
// Features:
// - Multi-account support through the Connections module
// - Nest REST API subscribe loop and Google protobuf observe loop
// - Shared protobuf schema/type caching via protobuf.js helpers
// - Raw data merging across Nest and Google sources
// - Promise-based snapshot waiter handling for upload_live_image updates
// - Dynamic device module loading and HomeKit category selection
//
// Notes:
// - Account authorisation, token refresh, retry handling, and connection cleanup are handled by connections.js
// - HomeKit characteristic and service management is handled by individual device modules
// - Camera, thermostat, sensor, and lock behaviour is implemented in device-specific modules
//
// Architecture:
// - Exports the main NestAccfactory platform class
// - Maintains raw data cache and tracked HomeKit device instances
// - Uses Connections for account/session state and gRPC transport ownership
// - Uses shared protobuf helpers for schema/type loading and traversal
// - Creates and updates HomeKitDevice-based instances for supported device types
//
// Code version 2026.05.15
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { Buffer } from 'node:buffer';
import { setTimeout, clearTimeout } from 'node:timers';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import os from 'node:os';
import { URL } from 'node:url';

// Import our modules
import HomeKitDevice from './HomeKitDevice.js';
import Connections from './connections.js';
import { loadDeviceModules, getDeviceHKCategory } from './devices.js';
import { processConfig } from './config.js';
import { adjustTemperature, scaleValue, fetchWrapper } from './utils.js';
import { getProtoTypes } from './protobuf.js';

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
const API_STREAM_LOOP_INTERVAL = 1000; // Normal subscribe/observe loop restart delay
const API_STREAM_RETRY_INITIAL = 5000; // Initial retry delay after subscribe/observe failure
const API_STREAM_RETRY_MAX = 60000; // Maximum retry delay during API outage/failure

// We handle the connections to Nest/Google
// Perform device management (additions/removals/updates)
export default class NestAccfactory {
  cachedAccessories = []; // Track restored cached accessories

  // Internal data only for this class
  #connections = undefined; // Connections manager
  #rawData = {}; // Cached copy of data from both Nest and Google APIs
  #trackedDevices = new Map(); // Devices we've created, keyed by serial number
  #deviceModules = undefined; // No loaded device support modules to start

  constructor(log, config, api) {
    this.log = log;
    this.api = api;

    // Set the shared HomeKitDevice module logger so device modules don't need it passed in.
    HomeKitDevice.LOGGER = log;

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

    api?.on?.('didFinishLaunching', async () => {
      // We got notified that Homebridge has finished loading

      // Load device support modules from the plugins folder if not already done
      this.#deviceModules = await loadDeviceModules(this.log, 'plugins');

      // Build runtime connection state now that cached accessories have been restored
      // and device modules are ready to receive cloud updates.
      this.#connections = this.#createConnections();

      // Check for valid connections, either a Nest and/or Google one specified. Otherwise, return back.
      if (this.#connections.size === 0) {
        this?.log?.error?.('No active connections have been specified in the JSON configuration. Please review');
        return;
      }

      // Start connection lifecycle per configured account.
      for (let [uuid] of this.#connections.entries()) {
        this.#connections.start(uuid);
      }
    });

    api?.on?.('shutdown', async () => {
      // We got notified that Homebridge is shutting down
      // Perform cleanup of internal state
      this.#connections?.shutdown?.();

      // Cleanup internal data
      this.#trackedDevices.clear();
      this.#rawData = {};
      this.#connections = undefined;
      this.#deviceModules?.clear?.();
      this.cachedAccessories = [];
    });
  }

  configureAccessory(accessory) {
    // This gets called from Homebridge each time it restores an accessory from its cache
    this?.log?.info?.('Loading accessory from cache:', accessory.displayName);

    let informationService = accessory?.getService?.(this.api.hap.Service.AccessoryInformation);
    if (informationService === undefined) {
      // Accessory is missing the required AccessoryInformation service
      // means it's not going to work and is likely a stale entry in the cache. Remove it and log an error.
      this?.log?.warn?.('Cached accessory "%s" is missing AccessoryInformation service. Removing from cache', accessory.displayName);

      try {
        this.api.unregisterPlatformAccessories(HomeKitDevice.PLUGIN_NAME, HomeKitDevice.PLATFORM_NAME, [accessory]);
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        // Empty
      }

      return;
    }

    // Accessory has the required AccessoryInformation service, so we can add the restored accessory to the accessories cache
    // This allows us to track if it has already been registered
    this.cachedAccessories.push(accessory);
  }

  #createConnections() {
    return Connections.fromConfig(this.config, {
      log: this.log,
      onAuthorised: async (uuid, connection, details = {}) => {
        // Notify any camera related devices (camera/doorbell/floodlight) of updated auth details.
        for (let [, trackedDevice] of this.#trackedDevices) {
          if (typeof trackedDevice !== 'object' || trackedDevice === null) {
            continue;
          }

          if (
            trackedDevice.type !== DEVICE_TYPE.CAMERA &&
            trackedDevice.type !== DEVICE_TYPE.DOORBELL &&
            trackedDevice.type !== DEVICE_TYPE.FLOODLIGHT
          ) {
            // Not a camera/doorbell/floodlight device, so skip
            continue;
          }

          try {
            // Send an update message onto the device so it can update its api access details if needed.
            await HomeKitDevice.message(trackedDevice.uuid, HomeKitDevice.UPDATE, {
              apiAccess: connection.cameraAuth,
            });
          } catch (error) {
            this?.log?.debug?.(
              'Unable to update camera auth for tracked device "%s": %s',
              trackedDevice.uuid,
              typeof error?.message === 'string' ? error.message : String(error),
            );
          }
        }

        // Initial authorisation/re-authorisation should start ingestion loops.
        // Token refreshes keep existing loops running.
        if (details?.wasAuthorised !== true) {
          this.#subscribeNestAPI(uuid).catch((error) => {
            this?.log?.debug?.(
              'Unable to start Nest API subscribe for connection "%s": %s',
              connection?.name,
              typeof error?.message === 'string' ? error.message : String(error),
            );
          });
          this.#observeGoogleAPI(uuid).catch((error) => {
            this?.log?.debug?.(
              'Unable to start Google API observe for connection "%s": %s',
              connection?.name,
              typeof error?.message === 'string' ? error.message : String(error),
            );
          });
        }
      },
    });
  }

  async #subscribeNestAPI(uuid, firstRun = true, fullRead = true) {
    let connection = this.#connections?.get(uuid);
    let subscribeFailed = false;

    if (
      typeof connection !== 'object' ||
      connection === null ||
      connection.authorised !== true ||
      this.config?.options?.useNestAPI !== true
    ) {
      // Not a valid connection object and/or we're not authorised
      return;
    }

    // By default, setup for a full data read from the Nest API
    let subscribeJSONData = undefined;
    if (firstRun !== false || fullRead !== false) {
      this?.log?.debug?.('Starting Nest API subscribe for connection "%s"', connection.name);
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
        ? new URL('/v5/subscribe', connection.transport_url).href
        : new URL('/api/0.1/user/' + connection.userID + '/app_launch', 'https://' + connection.restAPIHost).href,
      {
        headers: {
          Referer: 'https://' + connection.referer,
          Origin: 'https://' + connection.referer,
          Authorization: 'Basic ' + connection.token,
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

              // Detect removed objects and clean up local state
              existingValue.buckets.forEach((childObjectKey) => {
                if (newBucketsSet.has(childObjectKey) === false) {
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
                      // Send removed notice onto HomeKit device for it to process
                      HomeKitDevice.message(trackedDevice.uuid, HomeKitDevice.REMOVE, {});

                      // Finally, remove from tracked devices
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

        connection.subscribeRetryDelay = undefined;
      })
      .catch((error) => {
        subscribeFailed = true;

        // Attempt to extract HTTP status code from error cause or error object
        let statusCode =
          error?.code !== undefined && error?.code !== null
            ? error.code
            : error?.status !== undefined && error?.status !== null
              ? error.status
              : undefined;

        // If we get a 401 Unauthorized or 403 Forbidden, wake the connection
        // lifecycle so it can re-authorise and reschedule itself.
        if ((statusCode === 401 || statusCode === 403) && connection.authorised === true) {
          this?.log?.debug?.('Connection "%s" is no longer authorised with the Nest API, will attempt to reconnect', connection.name);
          this.#connections?.markUnauthorised?.(uuid, 'nest-api-' + statusCode);
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
            connection.name,
            typeof error?.message === 'string' ? error.message : String(error),
          );
        }
      })
      .finally(() => {
        // Only continue the subscription loop if this exact connection is still active and authorised.
        if (this.#connections?.get(uuid) === connection && connection.authorised === true) {
          let subscribeDelay = API_STREAM_LOOP_INTERVAL;

          if (subscribeFailed === true) {
            subscribeDelay =
              Number.isFinite(connection.subscribeRetryDelay) === true && connection.subscribeRetryDelay > 0
                ? Math.min(connection.subscribeRetryDelay * 2, API_STREAM_RETRY_MAX)
                : API_STREAM_RETRY_INITIAL;

            connection.subscribeRetryDelay = subscribeDelay;
          }

          clearTimeout(connection.subscribeTimer);
          connection.subscribeTimer = setTimeout(() => this.#subscribeNestAPI(uuid, false, fullRead), subscribeDelay);
        }
      });
  }

  async #observeGoogleAPI(uuid) {
    let connection = this.#connections?.get(uuid);
    let observeFailed = false;

    if (
      typeof connection !== 'object' ||
      connection === null ||
      connection.authorised !== true ||
      connection.grpcTransport === undefined ||
      this.config?.options?.useGoogleAPI !== true
    ) {
      // Not a valid connection object and/or we're not authorised
      return;
    }

    // Dynamically build the 'observe' post body data from cached protobuf message types
    let observeTraitsList = getProtoTypes(path.join(__dirname, 'protobuf/root.proto'), this.log)
      .filter((type) => {
        return (
          (connection.type === ACCOUNT_TYPE.NEST &&
            type.fullName.startsWith('.nest.trait.product.camera') === false &&
            type.fullName.startsWith('.nest.trait.product.doorbell') === false &&
            (type.fullName.startsWith('.nest.trait') === true || type.fullName.startsWith('.weave.') === true)) ||
          (connection.type === ACCOUNT_TYPE.GOOGLE &&
            (type.fullName.startsWith('.nest.trait') === true ||
              type.fullName.startsWith('.weave.') === true ||
              type.fullName.startsWith('.google.trait.product.camera') === true))
        );
      })
      .map((type) => ({
        traitType: type.fullName.replace(/^\.*|\.*$/g, ''),
      }));

    // Dedupe the observe traits list since there can be some overlap in the traits
    // due to the dynamic nature of the protobuf loading and trait type matching
    observeTraitsList = [...new Map(observeTraitsList.map((entry) => [entry.traitType, entry])).values()];

    // If protobuf support is unavailable or no observable traits were found,
    // do not start the observe loop. Retrying every second would only create
    // noise until the underlying protobuf load problem is fixed.
    if (observeTraitsList.length === 0) {
      this?.log?.warn?.(
        'Google API observe cannot start for connection "%s" because no observable protobuf traits were loaded',
        connection.name,
      );
      return;
    }

    connection.grpcTransport
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
                if (traitLabel === 'upload_live_image' && connection.snapshotWaiters instanceof Map) {
                  let waiter = connection.snapshotWaiters.get(resourceId);

                  connection.snapshotWaiters.delete(resourceId);

                  if (typeof waiter === 'function') {
                    waiter();
                  }
                }
              }
            }
          }

          await this.#processData(uuid, changedData);

          connection.observeRetryDelay = undefined;
        },
      )
      .catch((error) => {
        observeFailed = true;

        this?.log?.debug?.(
          'Google API observe failed for connection "%s": %s',
          connection.name,
          typeof error?.message === 'string' ? error.message : String(error),
        );
      })
      .finally(() => {
        // Only continue the observe loop if this exact connection is still active and authorised.
        if (this.#connections?.get(uuid) === connection && connection.authorised === true) {
          let observeDelay = API_STREAM_LOOP_INTERVAL;

          if (observeFailed === true) {
            observeDelay =
              Number.isFinite(connection.observeRetryDelay) === true && connection.observeRetryDelay > 0
                ? Math.min(connection.observeRetryDelay * 2, API_STREAM_RETRY_MAX)
                : API_STREAM_RETRY_INITIAL;

            connection.observeRetryDelay = observeDelay;
          }

          clearTimeout(connection.observeTimer);
          connection.observeTimer = setTimeout(() => this.#observeGoogleAPI(uuid), observeDelay);
        }
      });
  }

  async #processData(uuid, changedData = undefined) {
    let connection = this.#connections?.get(uuid);

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
        typeof connection !== 'object' ||
        connection === null ||
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
                type: deviceModule.class.TYPE, // Store type of device
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

                // For camera type devices, inject camera API auth credentials before initial setup
                // so streaming backends have auth details during their first construction/update pass.
                if (
                  deviceModule.class.TYPE === DEVICE_TYPE.CAMERA ||
                  deviceModule.class.TYPE === DEVICE_TYPE.DOORBELL ||
                  deviceModule.class.TYPE === DEVICE_TYPE.FLOODLIGHT
                ) {
                  deviceData.apiAccess = this.#connections?.get(
                    this.#rawData?.[deviceData?.nest_google_device_uuid]?.connection,
                  )?.cameraAuth;
                }

                let tempDevice = new deviceModule.class(this.cachedAccessories, this.api, deviceData);
                await tempDevice.add(accessoryName, getDeviceHKCategory(deviceModule.class.TYPE), deviceData?.eveHistory === true);

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
                  type: deviceModule.class.TYPE, // Store type of device
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
              let resourceId = deviceData?.nest_google_device_uuid;
              let resourceData = this.#rawData?.[resourceId];
              let newSource = resourceData?.source;

              if (newSource !== undefined && newSource !== trackedDevice.source) {
                // Data source for this device has changed.
                // Allow initial source assignment and Nest -> Google upgrades.
                // Camera, doorbell, and floodlight devices may also move back
                // from Google -> Nest because streaming can depend on Nest data.
                if (
                  trackedDevice.source === undefined ||
                  (trackedDevice.source === DATA_SOURCE.NEST && newSource === DATA_SOURCE.GOOGLE) ||
                  ((deviceModule.class.TYPE === DEVICE_TYPE.CAMERA ||
                    deviceModule.class.TYPE === DEVICE_TYPE.DOORBELL ||
                    deviceModule.class.TYPE === DEVICE_TYPE.FLOODLIGHT) &&
                    trackedDevice.source === DATA_SOURCE.GOOGLE)
                ) {
                  this?.log?.debug?.(
                    'Using %s API as data source for "%s" from connection "%s"',
                    newSource,
                    deviceData.description,
                    this.#connections.get(resourceData.connection)?.name,
                  );

                  trackedDevice.source = newSource;
                  trackedDevice.nest_google_device_uuid = resourceId;
                }
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
    let connection = this.#connections?.get(uuid);

    if (
      typeof values !== 'object' ||
      values === null ||
      typeof this.#rawData?.[nest_google_device_uuid] !== 'object' ||
      typeof connection !== 'object' ||
      connection === null ||
      connection.authorised !== true
    ) {
      return;
    }

    for (let [key, value] of Object.entries(values)) {
      try {
        if (key === 'uuid') {
          // We don't do anything with the key containing the uuid
          continue;
        }

        if (this.#rawData?.[nest_google_device_uuid]?.source === DATA_SOURCE.GOOGLE && connection.grpcTransport !== undefined) {
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
              Number.isFinite(Number(value)) === true)
          ) {
            // Set either the 'mode' and/or non-eco temperatures on the target thermostat
            setUpdateTrait('target_temperature_settings', 'type.nestlabs.com/nest.trait.hvac.TargetTemperatureSettingsTrait');

            if (
              (key === 'target_temperature_low' || key === 'target_temperature') &&
              (updateElement.state.value.targetTemperature.setpointType === 'SET_POINT_TYPE_HEAT' ||
                updateElement.state.value.targetTemperature.setpointType === 'SET_POINT_TYPE_RANGE')
            ) {
              // Changing heating target temperature
              updateElement.state.value.targetTemperature.heatingTarget = { value: Number(value) };
            }
            if (
              (key === 'target_temperature_high' || key === 'target_temperature') &&
              (updateElement.state.value.targetTemperature.setpointType === 'SET_POINT_TYPE_COOL' ||
                updateElement.state.value.targetTemperature.setpointType === 'SET_POINT_TYPE_RANGE')
            ) {
              // Changing cooling target temperature
              updateElement.state.value.targetTemperature.coolingTarget = { value: Number(value) };
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
            Number.isFinite(Number(value)) === true
          ) {
            // Set eco mode temperatures on the target thermostat
            setUpdateTrait('eco_mode_settings', 'type.nestlabs.com/nest.trait.hvac.EcoModeSettingsTrait');

            updateElement.state.value.ecoTemperatureHeat.value.value =
              updateElement.state.value.ecoTemperatureHeat.enabled === true &&
              updateElement.state.value.ecoTemperatureCool.enabled === false
                ? Number(value)
                : updateElement.state.value.ecoTemperatureHeat.value.value;
            updateElement.state.value.ecoTemperatureCool.value.value =
              updateElement.state.value.ecoTemperatureHeat.enabled === false &&
              updateElement.state.value.ecoTemperatureCool.enabled === true
                ? Number(value)
                : updateElement.state.value.ecoTemperatureCool.value.value;
            updateElement.state.value.ecoTemperatureHeat.value.value =
              updateElement.state.value.ecoTemperatureHeat.enabled === true &&
              updateElement.state.value.ecoTemperatureCool.enabled === true &&
              key === 'target_temperature_low'
                ? Number(value)
                : updateElement.state.value.ecoTemperatureHeat.value.value;
            updateElement.state.value.ecoTemperatureCool.value.value =
              updateElement.state.value.ecoTemperatureHeat.enabled === true &&
              updateElement.state.value.ecoTemperatureCool.enabled === true &&
              key === 'target_temperature_high'
                ? Number(value)
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

          if (key === 'fan_state' && typeof value === 'boolean' && Number.isFinite(Number(values?.fan_duration)) === true) {
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

          if (key === 'fan_timer_speed' && Number.isFinite(Number(value)) === true && values?.fan_state === undefined) {
            // Set fan speed on the target thermostat only if we're not changing fan on/off state also
            setUpdateTrait('fan_control_settings', 'type.nestlabs.com/nest.trait.hvac.FanControlSettingsTrait');
            updateElement.state.value.timerSpeed =
              value !== 0
                ? 'FAN_SPEED_SETTING_STAGE' + value
                : this.#rawData[nest_google_device_uuid].value.fan_control_settings.timerSpeed;
          }

          if (key === 'statusled_brightness' && Number.isFinite(Number(value)) === true) {
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

          if (key === 'light_brightness' && Number.isFinite(Number(value)) === true) {
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

            let boostTime = Number.isFinite(Number(value?.time)) === true ? Number(value.time) : 30 * 60;
            let boostEnd = Math.floor(Date.now() / 1000) + boostTime;

            updateElement.state.value.boostTimerEnd =
              value?.state === true
                ? {
                    seconds: boostEnd,
                    nanos: (boostEnd % 1000) * 1e6,
                  }
                : { seconds: 0, nanos: 0 };
          }

          if (
            key === 'hot_water_temperature' &&
            Number.isFinite(Number(value)) === true &&
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

          if (key === 'auto_relock_duration' && Number.isFinite(Number(value)) === true) {
            // Set lock auto-relock duration
            setUpdateTrait('bolt_lock_settings', 'type.nestlabs.com/weave.trait.security.BoltLockSettingsTrait');
            updateElement.state.value.autoRelockDuration = {
              ...(updateElement.state.value.autoRelockDuration ?? {}),
              seconds: Number(value),
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
            Number.isFinite(Number(value)) === true &&
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
            Number.isFinite(Number(value)) === true &&
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
            let grpcResult = await connection.grpcTransport.command('nestlabs.gateway.v1.', 'TraitBatchApi', 'BatchUpdateState', {
              batchUpdateStateRequest: updatedTraits,
            });
            let commandResponse = Array.isArray(grpcResult?.data) === true ? grpcResult.data[0] : undefined;
            if (commandResponse?.traitOperations?.[0]?.progress !== 'COMPLETE') {
              this?.log?.debug?.('Google API had error updating traits for device uuid "%s"', nest_google_device_uuid);
            }
          }

          // Perform any trait updates required via resource commands. Each one is done separately
          for (let command of commandTraits ?? []) {
            let grpcResult = await connection.grpcTransport.command('nestlabs.gateway.v1.', 'ResourceApi', 'SendCommand', command);
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
              new URL('/api/dropcams.set_properties', 'https://webapi.' + connection.cameraAPIHost).href,
              {
                headers: {
                  Referer: 'https://' + connection.referer,
                  Origin: 'https://' + connection.referer,
                  [connection.cameraAuth.key]: connection.cameraAuth.value + connection.cameraAuth.token,
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
              Number.isFinite(Number(value)) === true &&
              nest_google_device_uuid.startsWith('device.') === true
            ) {
              // Set temperatures on thermostat
              subscribeJSONData.objects.push({
                object_key: 'shared.' + nest_google_device_uuid.trim().split('.')[1],
                op: 'MERGE',
                value: { target_change_pending: true, [key]: Number(value) },
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
              Number.isFinite(Number(values?.fan_duration)) === true &&
              nest_google_device_uuid.startsWith('device.') === true
            ) {
              // Set fan on/off on thermostat
              // Duration also needs to be passed in
              subscribeJSONData.objects.push({
                object_key: nest_google_device_uuid,
                op: 'MERGE',
                value: {
                  fan_state: value,
                  fan_timer_timeout: value === true ? Number(values.fan_duration) + Math.floor(Date.now() / 1000) : 0,
                },
              });
            }

            if (
              key === 'fan_timer_speed' &&
              Number.isFinite(Number(value)) === true &&
              nest_google_device_uuid.startsWith('device.') === true
            ) {
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
              Number.isFinite(Number(value?.time)) === true &&
              nest_google_device_uuid.startsWith('device.') === true &&
              this.#rawData?.[nest_google_device_uuid]?.value?.has_hot_water_control === true
            ) {
              // Set hotwater boost time on heatlink (associated thermostat)
              subscribeJSONData.objects.push({
                object_key: nest_google_device_uuid,
                op: 'MERGE',
                value: {
                  hot_water_boost_time_to_end: value.state === true ? Number(value.time) + Math.floor(Date.now() / 1000) : 0,
                },
              });
            }

            if (
              key === 'hot_water_temperature' &&
              Number.isFinite(Number(value)) === true &&
              nest_google_device_uuid.startsWith('device.') === true &&
              this.#rawData?.[nest_google_device_uuid]?.value?.has_hot_water_temperature === true
            ) {
              // Set hotwater temperature on heatlink (associated thermostat)
              subscribeJSONData.objects.push({
                object_key: nest_google_device_uuid,
                op: 'MERGE',
                value: {
                  hot_water_temperature: Number(value),
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
              Number.isFinite(Number(values?.target_humidity)) === true &&
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
              Number.isFinite(Number(values?.target_humidity)) === true &&
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
                new URL('/v5/put', connection.transport_url).href,
                {
                  headers: {
                    Referer: 'https://' + connection.referer,
                    Origin: 'https://' + connection.referer,
                    Authorization: 'Basic ' + connection.token,
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
    let connection = this.#connections?.get(uuid);

    if (
      typeof connection !== 'object' ||
      connection === null ||
      connection.authorised !== true ||
      (connection.referer ?? '') === '' ||
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
      (connection?.cameraAPIHost ?? '') !== '' &&
      (connection?.cameraAuth?.key ?? '') !== '' &&
      (connection?.cameraAuth?.value ?? '') !== '' &&
      (connection?.cameraAuth?.token ?? '') !== ''
    ) {
      // Nest cameras provide a direct image endpoint, so just fetch the latest image available
      snapshot = await fetchSnapshotImage(
        new URL(
          '/get_image?uuid=' + nest_google_device_uuid.trim().split('.')[1],
          this.#rawData[nest_google_device_uuid].value.nexus_api_http_server_url.trim(),
        ).href,
        {
          Referer: 'https://' + connection.referer,
          Origin: 'https://' + connection.referer,
          [connection.cameraAuth.key]: connection.cameraAuth.value + connection.cameraAuth.token,
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
      (connection?.token ?? '') !== '' &&
      connection?.grpcTransport !== undefined &&
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
      connection?.snapshotWaiters?.delete?.(nest_google_device_uuid);
      let waitForSnapshotUpdate = new Promise((resolve) => {
        connection.snapshotWaiters.set(nest_google_device_uuid, () => {
          snapshotUpdated = true;
          resolve();
        });
      });

      // Ask Google to refresh the live image
      let grpcResult = await connection.grpcTransport.command('nestlabs.gateway.v1.', 'ResourceApi', 'SendCommand', {
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
        connection?.snapshotWaiters?.delete?.(nest_google_device_uuid);
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
          Referer: 'https://' + connection.referer,
          Origin: 'https://' + connection.referer,
          Authorization: 'Basic ' + connection.token,
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
    let connection = this.#connections?.get(uuid);

    if (
      typeof connection !== 'object' ||
      connection === null ||
      connection.authorised !== true ||
      (connection.referer ?? '') === '' ||
      (connection.token ?? '') === '' ||
      (connection.restAPIHost ?? '') === '' ||
      (postal_code?.trim?.() ?? '') === '' ||
      (country_code?.trim?.() ?? '') === '' ||
      (nest_google_device_uuid?.trim?.() ?? '') === ''
    ) {
      // Not a valid connection object and/or we're not authorised
      return;
    }

    try {
      let response = await fetchWrapper(
        'get',
        new URL('/api/0.1/weather/forecast/' + postal_code + ',' + country_code, 'https://' + connection.restAPIHost).href,
        {
          headers: {
            Referer: 'https://' + connection.referer,
            Origin: 'https://' + connection.referer,
            Authorization: 'Basic ' + connection.token,
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
    let connection = this.#connections?.get(uuid);

    if (
      typeof connection !== 'object' ||
      connection === null ||
      connection.authorised !== true ||
      (connection.referer ?? '') === '' ||
      (connection.cameraAPIHost ?? '') === '' ||
      (connection.cameraAuth?.key ?? '') === '' ||
      (connection.cameraAuth?.value ?? '') === '' ||
      (connection.cameraAuth?.token ?? '') === '' ||
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
          'https://webapi.' + connection.cameraAPIHost,
        ).href,
        {
          headers: {
            Referer: 'https://' + connection.referer,
            Origin: 'https://' + connection.referer,
            [connection.cameraAuth.key]: connection.cameraAuth.value + connection.cameraAuth.token,
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
    let connection = this.#connections?.get(uuid);

    if (
      typeof connection !== 'object' ||
      connection === null ||
      connection.authorised !== true ||
      (uuid?.trim?.() ?? '') === '' ||
      (nest_google_device_uuid?.trim?.() ?? '') === ''
    ) {
      // Not a valid connection object and/or we're not authorised
      return [];
    }

    if (
      this.config?.options?.useGoogleAPI === true &&
      nest_google_device_uuid.startsWith('DEVICE_') === true &&
      connection?.grpcTransport !== undefined
    ) {
      let grpcResult = await connection.grpcTransport.command(
        'nestlabs.gateway.v1.',
        'ResourceApi',
        'SendCommand',
        {
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
        },
        { timeout: 4000 },
      );

      let commandResponse = Array.isArray(grpcResult?.data) === true ? grpcResult.data[0] : undefined;

      // Camera history queries can legitimately time out when Google has no recent
      // event data ready. Treat that as no events rather than logging duplicate noise.
      if (grpcResult?.status === 4 || grpcResult?.code === 'REQUEST_TIMEOUT') {
        return [];
      }

      // Only continue if gRPC reports the camera history request completed successfully
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
          'Google API had error retrieving camera/doorbell activity notifications for device "%s"',
          nest_google_device_uuid,
        );
        return [];
      }
    }

    if (
      this.config?.options?.useNestAPI === true &&
      nest_google_device_uuid.startsWith('quartz.') === true &&
      (connection?.referer ?? '') !== '' &&
      (connection?.cameraAPIHost ?? '') !== '' &&
      (connection?.cameraAuth?.key ?? '') !== '' &&
      (connection?.cameraAuth?.value ?? '') !== '' &&
      (connection?.cameraAuth?.token ?? '') !== '' &&
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
              Referer: 'https://' + connection.referer,
              Origin: 'https://' + connection.referer,
              [connection.cameraAuth.key]: connection.cameraAuth.value + connection.cameraAuth.token,
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
}
