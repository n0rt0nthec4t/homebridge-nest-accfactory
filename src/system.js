// System - cloud data and HomeKit device management
// Part of homebridge-nest-accfactory
//
// Coordinates configured accounts, committed Nest/Google resource data and
// HomeKit device modules throughout platform startup and shutdown.
//
// Responsibilities:
// - Initialise configuration, device modules and the Accounts registry
// - Apply ordered API batches to the shared raw-data cache
// - Merge partial resource updates and resolve configured home identifiers
// - Enrich Google structure locations through the account's Nest REST weather query
// - Acknowledge cache commits independently of HomeKit accessory delivery
// - Coalesce changed fields and reconcile devices through one delivery worker
// - Discover, create, update and remove accessories without changing their identity
// - Route device GET/SET requests through the selected resource's API client
// - Refresh camera credentials for devices belonging to the authorised account
// - Collect bounded support dumps when enabled
//
// Ownership:
// - Accounts registers accounts and coordinates their sessions and API clients
// - AccountSession owns authentication, token refresh and auth retry scheduling
// - API clients own protocol requests, subscription retries and transport cleanup
// - Device modules interpret source data, apply source preference and configure HomeKit
// - API clients own source caches; System owns the combined cache and HomeKit delivery
//
// Code version 2026.10.29
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import process from 'node:process';
import os from 'node:os';

// Import our modules
import HomeKitDevice from './HomeKitDevice.js';
import Accounts from './accounts.js';
import { loadDeviceModules, getDeviceHKCategory } from './devices.js';
import { processConfig } from './config.js';
import { createSupportDump } from './supportdump.js';

// Define constants
import { MIN_NODE_VERSION, DATA_SOURCE, DEVICE_TYPE } from './consts.js';

// Data flows from account callbacks through cache commits to accessory reconciliation.
// HomeKit GET/SET handlers route back to the API owning the selected resource.
export default class NestAccfactory {
  cachedAccessories = []; // Track restored cached accessories

  // Internal data only for this class
  #accounts = undefined; // Accounts manager
  #rawData = {}; // Cached copy of data from both Nest and Google APIs
  #trackedDevices = new Map(); // Devices we've created, keyed by serial number
  #pendingData = new Map(); // Changed field names per account, not queued payloads
  #processingData = false; // One accessory reconciliation worker across account sources
  #deviceModules = undefined; // No loaded device support modules to start
  #supportDumpWriter = undefined; // Diagnostic writer and aliases, created only when enabled

  // Platform lifecycle: prepare dependencies, restore accessories, then start accounts.
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

    // Configuration installs the plugin debug logger independently of Homebridge's
    // debug flag. Initialise it before emitting startup runtime diagnostics.
    this.config = processConfig(config, this.log, this.api);

    // Output some debug info about the system we're running on, which can be useful for troubleshooting
    this?.log?.debug?.('System: %s %s (%s)', os.platform(), os.release(), os.arch());
    this?.log?.debug?.('CPU: %s (%d cores)', os.cpus()?.[0]?.model, os.cpus()?.length);
    this?.log?.debug?.('Memory: %d MB total', Math.round(os.totalmem() / 1024 / 1024));
    this?.log?.debug?.('Node.js: v%s', process.versions.node);

    api?.on?.('didFinishLaunching', async () => {
      // We got notified that Homebridge has finished loading

      // Load device support modules from the plugins folder if not already done
      this.#deviceModules = await loadDeviceModules(this.log, 'plugins');

      // Build runtime account state now that cached accessories have been restored
      // and device modules are ready to receive cloud updates.
      this.#accounts = this.#createAccounts();

      // Check for valid accounts with either legacy Nest or Google authentication. Otherwise, return back.
      if (this.#accounts.size === 0) {
        this?.log?.error?.('No active accounts have been specified in the JSON configuration. Please review');
        return;
      }

      // Start account lifecycle per configured account.
      for (let [uuid] of this.#accounts.entries()) {
        this.#accounts.start(uuid);
      }
    });

    api?.on?.('shutdown', async () => {
      // We got notified that Homebridge is shutting down
      // Perform cleanup of internal state
      this.#accounts?.shutdown?.();

      // Cleanup internal data
      this.#trackedDevices.clear();
      this.#pendingData.clear();
      this.#rawData = {};
      this.#supportDumpWriter = undefined;
      this.#accounts = undefined;
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

  #createAccounts() {
    // API clients own their source caches. These callbacks commit their changes
    // to System's combined view and refresh credentials on existing camera accessories.
    return Accounts.fromConfig(this.config, {
      log: this.log,
      onData: (uuid, batch) => this.#applyData(uuid, batch),

      onAuthorised: async (uuid, account) => {
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

          // Refresh credentials only for cameras whose selected resource belongs to this account.
          if (this.#rawData?.[trackedDevice.nest_google_device_uuid]?.connection !== uuid) {
            continue;
          }

          try {
            // Send an update message onto the device so it can update its api access details if needed.
            await HomeKitDevice.message(trackedDevice.uuid, HomeKitDevice.UPDATE, {
              apiAccess: account.cameraAuth,
            });
          } catch (error) {
            this?.log?.debug?.(
              'Unable to update camera auth for tracked device "%s": %s',
              trackedDevice.uuid,
              typeof error?.message === 'string' ? error.message : String(error),
            );
          }
        }
      },
    });
  }

  // Ingestion: commit source changes before acknowledging the API batch.
  // HomeKit delivery runs separately so a slow accessory cannot block later commits.
  async #applyData(uuid, batch) {
    let changedData = new Map();

    // Apply patches in source order. Retired subscription work must stop at the next boundary.
    for (let change of batch.changes) {
      if (batch.isCurrent() !== true) {
        return false;
      }

      let resourceId = change.resourceId;

      if (change.remove === true) {
        // Topology removals retire the accessory first; raw-only removals just evict the resource.
        if (change.notify === true) {
          await this.#removeDevice(resourceId);

          if (batch.isCurrent() !== true) {
            return false;
          }
        }

        delete this.#rawData[resourceId];
        continue;
      }

      let incomingValue = change.value;
      let fields = change.fields;
      let location = incomingValue?.structure_location;

      if (
        batch.source === DATA_SOURCE.GOOGLE &&
        resourceId.startsWith('STRUCTURE_') === true &&
        (location?.postalCode?.value?.trim?.() ?? '') !== '' &&
        (location?.countryCode?.value?.trim?.() ?? '') !== ''
      ) {
        // Google supplies the structure location; weather is a Nest REST query.
        // Supply the incoming location because the structure may not be cached yet.
        // A weather failure leaves the source update and any cached forecast usable.
        let weather = undefined;

        try {
          weather = await this.#accounts?.get(uuid)?.nestAPI?.get(resourceId, 'location_weather', {
            location: { postal_code: location.postalCode.value, country_code: location.countryCode.value },
          });
        } catch (error) {
          this.log?.debug?.('Unable to enrich weather for resource "%s": %s', resourceId, String(error));
        }

        // Account shutdown or a replaced Observe run can retire this batch during
        // the REST request. Never commit its location or forecast after that point.
        if (batch.isCurrent() !== true) {
          return false;
        }

        if (weather !== undefined) {
          incomingValue = { ...incomingValue, weather: { ...weather } };
          fields = new Set([...fields, 'weather']);
        }
      }

      // Merge partial traits/buckets without discarding fields absent from this update.
      this.#rawData[resourceId] = {
        connection: uuid,
        source: batch.source,
        value: { ...this.#rawData[resourceId]?.value, ...incomingValue },
      };

      // Resolve configured home names to the source IDs discovered by this account.
      if (change.home !== undefined) {
        Object.assign(
          this.config.homes?.find((home) => home?.name?.trim?.().toUpperCase() === change.home?.name?.trim?.().toUpperCase()) ?? {},
          change.home.values,
        );
      }

      // Combine field names when the same resource appears more than once in a batch.
      let changed = changedData.get(resourceId) ?? { fields: new Set() };

      for (let field of fields) {
        changed.fields.add(field);
      }

      if (changed.fields.size > 0) {
        changedData.set(resourceId, changed);
      }
    }

    // Queue accessory notifications only after this batch has finished updating the cache.
    if (batch.isCurrent() === true) {
      let pending = this.#pendingData.get(uuid);

      if (pending === undefined) {
        this.#pendingData.set(uuid, changedData);
      } else {
        // Retain changed field names, not a payload queue, while delivery is busy.
        for (let [id, changed] of changedData) {
          let entry = pending.get(id) ?? { fields: new Set() };
          for (let field of changed.fields) {
            entry.fields.add(field);
          }
          pending.set(id, entry);
        }
      }

      // Do not await delivery: a HomeKit GET may need a later API image commit.
      void this.#deliverPendingData();

      // Success acknowledges the cache commit, without waiting for HomeKit delivery.
      return true;
    }

    return false;
  }

  // Delivery: one worker drains coalesced field changes across every account.
  // Serialising reconciliation prevents concurrent ADDs for the same accessory.
  async #deliverPendingData() {
    if (this.#processingData === true) {
      return;
    }

    this.#processingData = true;

    try {
      while (this.#pendingData.size > 0 && this.#accounts !== undefined) {
        // Remove this notification before awaiting delivery so new updates can accumulate.
        let [accountId, changed] = this.#pendingData.entries().next().value;
        this.#pendingData.delete(accountId);

        let account = this.#accounts.get(accountId);

        if (account === undefined) {
          continue;
        }

        try {
          await this.#processData(accountId, changed);
        } catch (error) {
          this.log?.error?.('Device reconciliation failed for account "%s": %s', account.name, String(error));
        }
      }
    } finally {
      this.#processingData = false;
    }
  }

  // Accessory reconciliation: topology removals retire every accessory selecting
  // that resource; mapped updates below retain identity across source changes.
  async #removeDevice(resourceId) {
    // One thermostat resource can own both thermostat and Heat Link accessories.
    // Match selected resources rather than serials so an unused fallback source
    // disappearing cannot remove an accessory currently served by the other API.
    for (let [serialNumber, trackedDevice] of this.#trackedDevices) {
      if (trackedDevice.nest_google_device_uuid !== resourceId) {
        continue;
      }

      await HomeKitDevice.message(trackedDevice.uuid, HomeKitDevice.REMOVE, {});

      // An awaited removal must not delete a replacement registered under the same serial number.
      if (this.#trackedDevices.get(serialNumber) === trackedDevice) {
        this.#trackedDevices.delete(serialNumber);
      }
    }
  }

  async #processData(uuid, changedData = undefined) {
    let account = this.#accounts?.get(uuid);

    if (this.config?.options?.supportDump === true && typeof account === 'object' && account !== null) {
      this.#supportDumpWriter ??= createSupportDump(this.log);
      this.#supportDumpWriter(this.#rawData, uuid, changedData);
    }

    // Mapping phase: device modules interpret the combined cache and changed fields.
    // Each result is keyed by physical serial number, independent of its source API.
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

            // Discovery phase: only full mappings can establish a tracked device.
            // Excluded devices still need tracking so repeated updates do not rediscover them.
            if (trackedDevice === undefined && isFull === true && deviceData?.excluded === true) {
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
                  deviceData.apiAccess = this.#accounts?.get(this.#rawData?.[deviceData?.nest_google_device_uuid]?.connection)?.cameraAuth;
                }

                let tempDevice = new deviceModule.class(this.cachedAccessories, this.api, deviceData);
                await tempDevice.add({
                  hapAccessoryName: accessoryName,
                  hapCategory: getDeviceHKCategory(deviceModule.class.TYPE),
                  enableHistory: deviceData?.eveHistory === true,
                });

                // Resource commits continue while ADD awaits HomeKit. Retire an
                // accessory whose source vanished during its initial publication.
                if (this.#rawData[deviceData.nest_google_device_uuid] === undefined || this.#accounts === undefined) {
                  await tempDevice.remove();
                  continue;
                }

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

            // Delivery phase: accept the selected source before changing accessory
            // state or its resource ID, which also determines subsequent GET/SET routing.
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
                    'Using %s API as data source for "%s" from account "%s"',
                    newSource,
                    deviceData.description,
                    this.#accounts.get(resourceData.connection)?.name,
                  );

                  trackedDevice.source = newSource;
                  trackedDevice.nest_google_device_uuid = resourceId;
                } else {
                  // Rejected sources must not overwrite accessory state or its cloud ID used for SET commands.
                  continue;
                }
              }

              // Send updated data onto HomeKit device for it to process
              await HomeKitDevice.message(trackedDevice.uuid, HomeKitDevice.UPDATE, deviceData);
            }
          }
        }
      }
    }
  }

  // HomeKit routing: adapt device requests to the selected account/API without
  // interpreting cloud settings here; protocol validation belongs to each client.
  async #set(uuid, resourceId, values) {
    let account = this.#accounts?.get(uuid);
    let resource = this.#rawData[resourceId];

    if (typeof values !== 'object' || values === null || resource === undefined || account?.authorised !== true) {
      throw new Error('SET requires an available authorised device account');
    }

    // Use the selected resource source; the API client validates and sends each setting.
    let api = resource.source === DATA_SOURCE.GOOGLE ? account.googleAPI : account.nestAPI;

    // HomeKit's routing identifier belongs to this adapter, not the cloud API.
    let settings = { ...values };
    delete settings.uuid;
    return await api.set(resourceId, settings);
  }

  async #get(uuid, resourceId, values) {
    let account = this.#accounts?.get(uuid);
    let resource = this.#rawData[resourceId];

    if (typeof values !== 'object' || values === null || resource === undefined) {
      return;
    }

    // Device queries follow the selected source, while weather always uses Nest REST.
    for (let key of Object.keys(values)) {
      if (key === 'uuid') {
        continue;
      }

      let api = key === 'location_weather' || resource.source !== DATA_SOURCE.GOOGLE ? account?.nestAPI : account?.googleAPI;

      // Object-valued queries supply API parameters; legacy true flags use defaults.
      let parameters = typeof values[key] === 'object' && values[key] !== null ? values[key] : undefined;

      // Weather combines sources here. Nest must receive the location explicitly
      // when the selected resource belongs to Google's independent cache.
      if (key === 'location_weather' && parameters?.location === undefined && resource.value?.weather !== undefined) {
        parameters = { ...parameters, location: resource.value.weather };
      }

      // Failed queries return no value for this field and leave the other queries available.
      values[key] = undefined;

      try {
        values[key] = await api?.get(resourceId, key, parameters);
      } catch (error) {
        let request = { camera_snapshot: 'Camera snapshot', location_weather: 'Weather', camera_events: 'Camera events' }[key] ?? key;
        this.log?.debug?.(
          '%s request failed for device uuid "%s". Error was "%s"',
          request,
          resourceId,
          typeof error?.message === 'string' ? error.message : String(error),
        );
      }
    }

    return values;
  }
}
