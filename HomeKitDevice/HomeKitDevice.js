// HomeKitDevice class
//
// This is the base class for all HomeKit accessories we code for in Homebridge/HAP-NodeJS
//
// The deviceData structure should at a minimum contain the following elements:
//
// Homebridge Plugin:
//
// serialNumber
// softwareVersion
// description
// manufacturer
// model
//
// HAP-NodeJS Library Accessory:
//
// serialNumber
// softwareVersion
// description
// manufacturer
// model
// hkUsername
// hkPairingCode
//
// Following constants should be overridden in the module loading this class file
//
// HomeKitDevice.HOMEKITHISTORY
// HomeKitDevice.PLUGIN_NAME
// HomeKitDevice.PLATFORM_NAME
//
// The following functions should be overriden in your class which extends this
//
// HomeKitDevice.addServices()
// HomeKitDevice.removeServices()
// HomeKitDevice.updateServices(deviceData)
// HomeKitDevice.messageServices(type, message)
//
// Code version 8/10/2024
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import crypto from 'crypto';
import EventEmitter from 'node:events';

// Define our HomeKit device class
export default class HomeKitDevice {
  static ADD = 'HomeKitDevice.add'; // Device add message
  static UPDATE = 'HomeKitDevice.update'; // Device update message
  static REMOVE = 'HomeKitDevice.remove'; // Device remove message
  static SET = 'HomeKitDevice.set'; // Device set property message
  static GET = 'HomeKitDevice.get'; // Device get property message
  static PLUGIN_NAME = undefined; // Homebridge plugin name (override)
  static PLATFORM_NAME = undefined; // Homebridge platform name (override)
  static HISTORY = undefined; // HomeKit History object (override)

  deviceData = {}; // The devices data we store
  historyService = undefined; // HomeKit history service
  accessory = undefined; // Accessory service for this device
  hap = undefined; // HomeKit Accessory Protocol API stub
  log = undefined; // Logging function object
  uuid = undefined; // UUID for this instance

  // Internal data only for this class
  #platform = undefined; // Homebridge platform api
  #eventEmitter = undefined; // Event emitter to use for comms

  constructor(accessory, api, log, eventEmitter, deviceData) {
    // Validate the passed in logging object. We are expecting certain functions to be present
    if (
      typeof log?.info === 'function' &&
      typeof log?.success === 'function' &&
      typeof log?.warn === 'function' &&
      typeof log?.error === 'function' &&
      typeof log?.debug === 'function'
    ) {
      this.log = log;
    }

    // Workout if we're running under HomeBridge or HAP-NodeJS library
    if (isNaN(api?.version) === false && typeof api?.hap === 'object' && api?.HAPLibraryVersion === undefined) {
      // We have the HomeBridge version number and hap API object
      this.hap = api.hap;
      this.#platform = api;

      this?.log?.debug && this.log.debug('HomeKitDevice module using Homebridge backend for "%s"', deviceData?.description);
    }

    if (typeof api?.HAPLibraryVersion === 'function' && api?.version === undefined && api?.hap === undefined) {
      // As we're missing the HomeBridge entry points but have the HAP library version
      this.hap = api;

      this?.log?.debug && this.log.debug('HomeKitDevice module using HAP-NodeJS library for "%s"', deviceData?.description);
    }

    // Generate UUID for this device instance
    // Will either be a random generated one or HAP generated one
    // HAP is based upon defined plugin name and devices serial number
    this.uuid = crypto.randomUUID();
    if (
      typeof HomeKitDevice.PLUGIN_NAME === 'string' &&
      HomeKitDevice.PLUGIN_NAME !== '' &&
      typeof deviceData.serialNumber === 'string' &&
      deviceData.serialNumber !== '' &&
      typeof this?.hap?.uuid?.generate === 'function'
    ) {
      this.uuid = this.hap.uuid.generate(HomeKitDevice.PLUGIN_NAME + '_' + deviceData.serialNumber.toUpperCase());
    }

    // See if we were passed in an existing accessory object or array of accessory objects
    // Mainly used to restore a HomeBridge cached accessory
    if (typeof accessory === 'object' && this.#platform !== undefined) {
      if (Array.isArray(accessory) === true) {
        this.accessory = accessory.find((accessory) => accessory?.UUID === this.uuid);
      }
      if (Array.isArray(accessory) === false && accessory?.UUID === this.uuid) {
        this.accessory = accessory;
      }
    }

    // Validate if eventEmitter object passed to us is an instance of EventEmitter
    // If valid, setup an event listener for messages to this device using our generated uuid
    if (eventEmitter instanceof EventEmitter === true) {
      this.#eventEmitter = eventEmitter;
      this.#eventEmitter.addListener(this.uuid, this.#message.bind(this));
    }

    // Make a clone of current data and store in this object
    // Important that we done have a 'linked' copy of the object data
    // eslint-disable-next-line no-undef
    this.deviceData = structuredClone(deviceData);
  }

  // Class functions
  async add(accessoryName, accessoryCategory, useHistoryService) {
    if (
      this.hap === undefined ||
      typeof HomeKitDevice.PLUGIN_NAME !== 'string' ||
      HomeKitDevice.PLUGIN_NAME === '' ||
      typeof HomeKitDevice.PLATFORM_NAME !== 'string' ||
      HomeKitDevice.PLATFORM_NAME === '' ||
      typeof accessoryName !== 'string' ||
      accessoryName === '' ||
      typeof this.hap.Categories[accessoryCategory] === 'undefined' ||
      typeof useHistoryService !== 'boolean' ||
      typeof this.deviceData !== 'object' ||
      typeof this.deviceData?.serialNumber !== 'string' ||
      this.deviceData.serialNumber === '' ||
      typeof this.deviceData?.softwareVersion !== 'string' ||
      this.deviceData.softwareVersion === '' ||
      (typeof this.deviceData?.description !== 'string' && this.deviceData.description === '') ||
      typeof this.deviceData?.model !== 'string' ||
      this.deviceData.model === '' ||
      typeof this.deviceData?.manufacturer !== 'string' ||
      this.deviceData.manufacturer === '' ||
      (this.#platform === undefined &&
        (typeof this.deviceData?.hkPairingCode !== 'string' ||
          (new RegExp(/^([0-9]{3}-[0-9]{2}-[0-9]{3})$/).test(this.deviceData.hkPairingCode) === false &&
            new RegExp(/^([0-9]{4}-[0-9]{4})$/).test(this.deviceData.hkPairingCode) === false) ||
          typeof this.deviceData?.hkUsername !== 'string' ||
          new RegExp(/^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/).test(this.deviceData.hkUsername) === false))
    ) {
      return;
    }

    // If we do not have an existing accessory object, create a new one
    if (this.accessory === undefined && this.#platform !== undefined) {
      // Create HomeBridge platform accessory
      this.accessory = new this.#platform.platformAccessory(this.deviceData.description, this.uuid);
      this.#platform.registerPlatformAccessories(HomeKitDevice.PLUGIN_NAME, HomeKitDevice.PLATFORM_NAME, [this.accessory]);
    }

    if (this.accessory === undefined && this.#platform === undefined) {
      // Create HAP-NodeJS libray accessory
      this.accessory = new this.hap.Accessory(accessoryName, this.uuid);

      this.accessory.username = this.deviceData.hkUsername;
      this.accessory.pincode = this.deviceData.hkPairingCode;
      this.accessory.category = accessoryCategory;
    }

    // Setup accessory information
    let informationService = this.accessory.getService(this.hap.Service.AccessoryInformation);
    if (informationService !== undefined) {
      informationService.updateCharacteristic(this.hap.Characteristic.Manufacturer, this.deviceData.manufacturer);
      informationService.updateCharacteristic(this.hap.Characteristic.Model, this.deviceData.model);
      informationService.updateCharacteristic(this.hap.Characteristic.SerialNumber, this.deviceData.serialNumber);
      informationService.updateCharacteristic(this.hap.Characteristic.FirmwareRevision, this.deviceData.softwareVersion);
      informationService.updateCharacteristic(this.hap.Characteristic.Name, this.deviceData.description);
    }

    // Setup our history service if module has been defined and requested to be active for this device
    if (typeof HomeKitDevice?.HISTORY === 'function' && this.historyService === undefined && useHistoryService === true) {
      this.historyService = new HomeKitDevice.HISTORY(this.accessory, this.log, this.hap, {});
    }

    if (typeof this.addServices === 'function') {
      try {
        let postSetupDetails = await this.addServices();
        this?.log?.info &&
          this.log.info('Setup %s %s as "%s"', this.deviceData.manufacturer, this.deviceData.model, this.deviceData.description);
        if (this.historyService?.EveHome !== undefined) {
          this?.log?.info && this.log.info('  += EveHome support as "%s"', this.historyService.EveHome.evetype);
        }
        if (typeof postSetupDetails === 'object') {
          postSetupDetails.forEach((output) => {
            this?.log?.info && this.log.info('  += %s', output);
          });
        }
      } catch (error) {
        this?.log?.error && this.log.error('addServices call for device "%s" failed. Error was', this.deviceData.description, error);
      }
    }

    // Perform an initial update using current data
    this.update(this.deviceData, true);

    // If using HAP-NodeJS library, publish accessory on local network
    if (this.#platform === undefined && this.accessory !== undefined) {
      this.accessory.publish({
        username: this.accessory.username,
        pincode: this.accessory.pincode,
        category: this.accessory.category,
      });

      this?.log?.info && this.log.info('  += Advertising as "%s"', this.accessory.displayName);
      this?.log?.info && this.log.info('  += Pairing code is "%s"', this.accessory.pincode);
    }

    return this.accessory; // Return our HomeKit accessory
  }

  remove() {
    this?.log?.warn && this.log.warn('Device "%s" has been removed', this.deviceData.description);

    if (this.#eventEmitter !== undefined) {
      // Remove listener for 'messages'
      this.#eventEmitter.removeAllListeners(this.uuid);
    }

    if (typeof this.removeServices === 'function') {
      try {
        this.removeServices();
      } catch (error) {
        this?.log?.error && this.log.error('removeServices call for device "%s" failed. Error was', this.deviceData.description, error);
      }
    }

    if (this.accessory !== undefined && this.#platform !== undefined) {
      // Unregister the accessory from Homebridge platform
      this.#platform.unregisterPlatformAccessories(HomeKitDevice.PLUGIN_NAME, HomeKitDevice.PLATFORM_NAME, [this.accessory]);
    }

    if (this.accessory !== undefined && this.#platform === undefined) {
      // Unpublish the accessory from HAP-NodeJS library
      this.accessory.unpublish();
    }

    this.deviceData = {};
    this.accessory = undefined;
    this.historyService = undefined;
    this.hap = undefined;
    this.log = undefined;
    this.uuid = undefined;
    this.#platform = undefined;
    this.#eventEmitter = undefined;

    // Do we destroy this object??
    // this = null;
    // delete this;
  }

  update(deviceData, forceUpdate) {
    if (typeof deviceData !== 'object' || typeof forceUpdate !== 'boolean') {
      return;
    }

    // Updated data may only contain selected fields, so we'll handle that here by taking our internally stored data
    // and merge with the updates to ensure we have a complete data object
    Object.entries(this.deviceData).forEach(([key, value]) => {
      if (typeof deviceData[key] === 'undefined') {
        // Updated data doesn't have this key, so add it to our internally stored data
        deviceData[key] = value;
      }
    });

    // Check updated device data with our internally stored data. Flag if changes between the two
    let changedData = false;
    Object.keys(deviceData).forEach((key) => {
      if (JSON.stringify(deviceData[key]) !== JSON.stringify(this.deviceData[key])) {
        changedData = true;
      }
    });

    // If we have any changed data OR we've been requested to force an update, do so here
    if ((changedData === true || forceUpdate === true) && this.accessory !== undefined) {
      let informationService = this.accessory.getService(this.hap.Service.AccessoryInformation);
      if (informationService !== undefined) {
        // Update details associated with the accessory
        // ie: Name, Manufacturer, Model, Serial # and firmware version
        if (typeof deviceData?.description === 'string' && deviceData.description !== this.deviceData.description) {
          // Update serial number on the HomeKit accessory
          informationService.updateCharacteristic(this.hap.Characteristic.Name, this.deviceData.description);
        }

        if (
          typeof deviceData?.manufacturer === 'string' &&
          deviceData.manufacturer !== '' &&
          deviceData.manufacturer !== this.deviceData.manufacturer
        ) {
          // Update manufacturer number on the HomeKit accessory
          informationService.updateCharacteristic(this.hap.Characteristic.Manufacturer, deviceData.manufacturer);
        }

        if (typeof deviceData?.model === 'string' && deviceData.model !== '' && deviceData.model !== this.deviceData.model) {
          // Update model on the HomeKit accessory
          informationService.updateCharacteristic(this.hap.Characteristic.Model, deviceData.model);
        }

        if (
          typeof deviceData?.softwareVersion === 'string' &&
          deviceData.softwareVersion !== '' &&
          deviceData.softwareVersion !== this.deviceData.softwareVersion
        ) {
          // Update software version on the HomeKit accessory
          informationService.updateCharacteristic(this.hap.Characteristic.FirmwareRevision, deviceData.softwareVersion);
        }

        // Check for devices serial number changing. Really shouldn't occur, but handle case anyway
        if (
          typeof deviceData?.serialNumber === 'string' &&
          deviceData.serialNumber !== '' &&
          deviceData.serialNumber.toUpperCase() !== this.deviceData.serialNumber.toUpperCase()
        ) {
          this?.log?.warn && this.log.warn('Serial number on "%s" has changed', deviceData.description);
          this?.log?.warn && this.log.warn('This may cause the device to become unresponsive in HomeKit');

          // Update software version on the HomeKit accessory
          informationService.updateCharacteristic(this.hap.Characteristic.SerialNumber, deviceData.serialNumber);
        }
      }

      if (typeof deviceData?.online === 'boolean' && deviceData.online !== this.deviceData.online) {
        // Output device online/offline status
        if (deviceData.online === false) {
          this?.log?.warn && this.log.warn('Device "%s" is offline', deviceData.description);
        }

        if (deviceData.online === true) {
          this?.log?.success && this.log.success('Device "%s" is online', deviceData.description);
        }
      }

      if (typeof this.updateServices === 'function') {
        try {
          this.updateServices(deviceData); // Pass updated data on for accessory to process as it needs
        } catch (error) {
          this?.log?.error && this.log.error('updateServices call for device "%s" failed. Error was', deviceData.description, error);
        }
      }

      // Finally, update our internally stored data with the new data
      // eslint-disable-next-line no-undef
      this.deviceData = structuredClone(deviceData);
    }
  }

  async set(values) {
    if (typeof values !== 'object' || this.#eventEmitter === undefined) {
      return;
    }

    // Send event with data to set
    this.#eventEmitter.emit(HomeKitDevice.SET, this.uuid, values);

    // Update the internal data for the set values, as could take sometime once we emit the event
    Object.entries(values).forEach(([key, value]) => {
      if (this.deviceData[key] !== undefined) {
        this.deviceData[key] = value;
      }
    });
  }

  async get(values) {
    if (typeof values !== 'object' || this.#eventEmitter === undefined) {
      return;
    }

    // Send event with data to get
    // Once get has completed, we'll get an event back with the requested data
    this.#eventEmitter.emit(HomeKitDevice.GET, this.uuid, values);

    // This should always return, but we probably should put in a timeout?
    let results = await EventEmitter.once(this.#eventEmitter, HomeKitDevice.GET + '->' + this.uuid);
    return results?.[0];
  }

  #message(type, message) {
    switch (type) {
      case HomeKitDevice.ADD: {
        // Got message for device add
        if (typeof message?.name === 'string' && isNaN(message?.category) === false && typeof message?.history === 'boolean') {
          this.add(message.name, Number(message.category), message.history);
        }
        break;
      }

      case HomeKitDevice.UPDATE: {
        // Got some device data, so process any updates
        this.update(message, false);
        break;
      }

      case HomeKitDevice.REMOVE: {
        // Got message for device removal
        this.remove();
        break;
      }

      default: {
        // This is not a message we know about, so pass onto accessory for it to perform any processing
        if (typeof this.messageServices === 'function') {
          try {
            this.messageServices(type, message);
          } catch (error) {
            this?.log?.error &&
              this.log.error('messageServices call for device "%s" failed. Error was', this.deviceData.description, error);
          }
        }
        break;
      }
    }
  }
}
