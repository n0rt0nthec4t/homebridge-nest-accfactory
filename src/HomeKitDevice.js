// HomeKitDevice class
//
// This is the base class for all HomeKit accessories we code for in Homebridge/HAP-NodeJS
//
// The deviceData structure should at a minimum contain the following elements:
//
// Homebridge Plugin:
//
// uuid
// serial_number
// software_version
// description
// manufacturer
// model
//
// HAP-NodeJS Library Accessory:
//
// uuid
// serial_number
// software_version
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
// Code version 24/8/2024
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
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

  // Internal data we use within the accessory for various things
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
    if (typeof api?.version === 'number' && typeof api?.hap === 'object' && typeof api?.HAPLibraryVersion === 'undefined') {
      // We have the HomeBridge version number and hap API object
      this.hap = api.hap;
      this.#platform = api;

      this?.log?.debug && this.log.debug('HomeKitDevice module using Homebridge backend for "%s"', deviceData?.description);
    }

    if (typeof api?.HAPLibraryVersion === 'function' && typeof api?.version === 'undefined' && typeof api?.hap === 'undefined') {
      // As we're missing the HomeBridge entry points but have the HAP library version
      this.hap = api;

      this?.log?.debug && this.log.debug('HomeKitDevice module using HAP-NodeJS library for "%s"', deviceData?.description);
    }

    // Validate if eventEmitter object passed to us is an instance of EventEmitter
    if (eventEmitter instanceof EventEmitter === true) {
      this.#eventEmitter = eventEmitter;
    }

    // If we have a valid EventEmitter and a device uuid
    // Setup a listener for messages to this device
    if (this.#eventEmitter !== undefined && typeof this.deviceData?.uuid === 'string' && this.deviceData.uuid !== '') {
      this.#eventEmitter.addListener(this.deviceData.uuid, this.#message.bind(this));
    }

    // Make copy of current data and store in this object

    // eslint-disable-next-line no-undef
    this.deviceData = structuredClone(deviceData);

    // See if we were passed in an existing accessory object or array of accessory objects
    // Mainly used to restore a HomeBridge cached accessory
    if (
      typeof accessory === 'object' &&
      typeof this?.hap?.uuid?.generate === 'function' &&
      typeof deviceData.uuid === 'string' &&
      this.#platform !== undefined
    ) {
      let uuid = this.hap.uuid.generate(HomeKitDevice.PLUGIN_NAME + '_' + deviceData.uuid);

      if (Array.isArray(accessory) === true) {
        this.accessory = accessory.find((accessory) => accessory.UUID === uuid);
      }
      if (Array.isArray(accessory) === false && typeof accessory?.UUID === 'string' && accessory.UUID === uuid) {
        this.accessory = accessory;
      }
    }
  }

  // Class functions
  async add(accessoryName, accessoryCategory, useHistoryService) {
    if (
      this.hap === undefined ||
      HomeKitDevice.PLUGIN_NAME === undefined ||
      HomeKitDevice.PLATFORM_NAME === undefined ||
      typeof accessoryName !== 'string' ||
      accessoryName === '' ||
      typeof this.hap.Categories[accessoryCategory] === 'undefined' ||
      typeof useHistoryService !== 'boolean' ||
      typeof this.deviceData !== 'object' ||
      typeof this.deviceData?.uuid !== 'string' ||
      this.deviceData.uuid === '' ||
      typeof this.deviceData?.serial_number !== 'string' ||
      this.deviceData.serial_number === '' ||
      typeof this.deviceData?.software_version !== 'string' ||
      this.deviceData.software_version === '' ||
      (typeof this.deviceData?.description !== 'string' && this.deviceData.description === '') ||
      typeof this.deviceData?.model !== 'string' ||
      this.deviceData.model === '' ||
      typeof this.deviceData?.manufacturer !== 'string' ||
      this.deviceData.manufacturer === '' ||
      (this.#platform === undefined && typeof this.deviceData?.hkPairingCode !== 'string' && this.deviceData.hkPairingCode === '') ||
      (this.#platform === undefined &&
        typeof this.deviceData?.hkUsername !== 'string' &&
        new RegExp(/^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/).test(this.deviceData.hkUsername) === false)
    ) {
      return;
    }

    // Special case for Homebridge 'restored' accessories. Pain in the arse
    // Remove all services accept on the accessory EXCEPT for the accessory information service
    // These will be added back via the 'addServices' call we execute below
    if (this.accessory !== undefined) {
      this.accessory.services.forEach((service) => {
        if (service.UUID !== this.hap.Service.AccessoryInformation.UUID) {
          this.accessory.removeService(service);
        }
      });
    }

    // If we do not have an existing accessory object, create a new one
    if (this.accessory === undefined && this.#platform !== undefined) {
      // Create HomeBridge platform accessory
      this.accessory = new this.#platform.platformAccessory(
        this.deviceData.description,
        this.hap.uuid.generate(HomeKitDevice.PLUGIN_NAME + '_' + this.deviceData.uuid),
      );
      this.#platform.registerPlatformAccessories(HomeKitDevice.PLUGIN_NAME, HomeKitDevice.PLATFORM_NAME, [this.accessory]);
    }

    if (this.accessory === undefined && this.#platform === undefined) {
      // Create HAP-NodeJS libray accessory
      // We're using our previous parameters to generate the uuid, rather than the 'new' way we do for Homebridge
      this.accessory = new this.hap.Accessory(
        accessoryName,
        this.hap.uuid.generate(
          'hap-nodejs:accessories:' + this.deviceData.manufacturer.toLowerCase() + '_' + this.deviceData.serial_number,
        ),
      );
      this.accessory.username = this.deviceData.hkUsername;
      this.accessory.pincode = this.deviceData.hkPairingCode;
      this.accessory.category = accessoryCategory;
    }

    // Setup accessory information
    let informationService = this.accessory.getService(this.hap.Service.AccessoryInformation);
    if (informationService !== undefined) {
      informationService.updateCharacteristic(this.hap.Characteristic.Manufacturer, this.deviceData.manufacturer);
      informationService.updateCharacteristic(this.hap.Characteristic.Model, this.deviceData.model);
      informationService.updateCharacteristic(this.hap.Characteristic.SerialNumber, this.deviceData.serial_number);
      informationService.updateCharacteristic(this.hap.Characteristic.FirmwareRevision, this.deviceData.software_version);
    }
    informationService.updateCharacteristic(this.hap.Characteristic.Name, this.deviceData.description);

    // Restore any data we have stored in this.accessory.context
    if (this.#platform !== undefined) {
      this.#platform.updatePlatformAccessories([this.accessory]);
    }

    // Setup our history service if module has been defined and requested to be active for this device
    if (typeof HomeKitDevice?.HISTORY === 'function' && this.historyService === undefined && useHistoryService === true) {
      this.historyService = new HomeKitDevice.HISTORY(this.accessory, this.log, {});
    }

    if (typeof this.addServices === 'function') {
      try {
        let postSetupDetails = await this.addServices();
        if (this?.log?.info) {
          this.log.info('Setup %s %s as "%s"', this.deviceData.manufacturer, this.deviceData.model, this.deviceData.description);
          if (this.historyService?.EveHome !== undefined) {
            this.log.info('  += EveHome support as "%s"', this.historyService.EveHome.evetype);
          }
          if (typeof postSetupDetails === 'object') {
            postSetupDetails.forEach((output) => {
              if (this?.log?.info) {
                this.log.info('  += %s', output);
              }
            });
          }
        }
      } catch (error) {
        this?.log?.error && this.log.error('addServices call for device "%s" failed. Error was', this.deviceData.description, error);
      }
    }

    // if we have a valid EventEmitter and we have not previously setup an message event handler, do so now
    if (this.#eventEmitter !== undefined && this.#eventEmitter.listenerCount(this.deviceData.uuid) === 0) {
      this.#eventEmitter.addListener(this.deviceData.uuid, this.#message.bind(this));
    }

    // Perform an initial update using current data
    this.update(this.deviceData, true);

    // If using HAP-NodeJS library, publish accessory on local network
    if (this.#platform === undefined && this.accessory !== undefined) {
      if (this?.log?.info) {
        this.log.info('  += Advertising as "%s"', accessoryName);
        this.log.info('  += Pairing code is "%s"', this.accessory.pincode);
      }
      this.accessory.publish({
        username: this.accessory.username,
        pincode: this.accessory.pincode,
        category: this.accessory.category,
      });
    }
  }

  async remove() {
    this?.log?.warn && this.log.warn('Device "%s" has been removed', this.deviceData.description);

    if (this.#eventEmitter === undefined && typeof this.deviceData?.uuid === 'string' && this.deviceData.uuid !== '') {
      // Remove listener for 'messages'
      this.#eventEmitter.removeAllListeners(this.deviceData.uuid);
    }

    if (typeof this.removeServices === 'function') {
      try {
        await this.removeServices();
      } catch (error) {
        this?.log?.error && this.log.error('removeServices call for device "%s" failed. Error was', this.deviceData.description, error);
      }
    }

    if (this.accessory !== undefined && this.#platform !== undefined) {
      // Unregister the accessory from Homebridge
      this.#platform.unregisterPlatformAccessories(HomeKitDevice.PLUGIN_NAME, HomeKitDevice.PLATFORM_NAME, [this.accessory]);
    }

    if (this.accessory !== undefined && this.#platform === undefined) {
      // Unpublish the accessory from HAP
      this.accessory.unpublish();
    }

    this.deviceData = {};
    this.accessory = undefined;
    this.historyService = undefined;
    this.hap = undefined;
    this.log = undefined;
    this.#platform = undefined;
    this.#eventEmitter = undefined;

    // Do we destroy this object??
    // this = null;
    // delete this;
  }

  async update(deviceData, forceUpdate) {
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
          // Update serial number on the HomeKit accessory
          informationService.updateCharacteristic(this.hap.Characteristic.Manufacturer, this.deviceData.manufacturer);
        }

        if (typeof deviceData?.model === 'string' && deviceData.model !== '' && deviceData.model !== this.deviceData.model) {
          // Update serial number on the HomeKit accessory
          informationService.updateCharacteristic(this.hap.Characteristic.Model, this.deviceData.model);
        }

        if (
          typeof deviceData?.serial_number === 'string' &&
          deviceData.serial_number !== '' &&
          deviceData.serial_number !== this.deviceData.serial_number
        ) {
          // Update serial number on the HomeKit accessory
          informationService.updateCharacteristic(this.hap.Characteristic.SerialNumber, this.deviceData.serial_number);
        }

        if (
          typeof deviceData?.software_version === 'string' &&
          deviceData.software_version !== '' &&
          deviceData.software_version !== this.deviceData.software_version
        ) {
          // Update software version on the HomeKit accessory
          informationService.updateCharacteristic(this.hap.Characteristic.FirmwareRevision, this.deviceData.software_version);
        }
      }

      if (typeof deviceData?.online === 'boolean' && deviceData.online !== this.deviceData.online) {
        // Output device online/offline status
        if (deviceData.online === false && this?.log?.warn) {
          this.log.warn('Device "%s" is offline', this.deviceData.description);
        }

        if (deviceData.online === true && this?.log?.success) {
          this.log.success('Device "%s" is online', this.deviceData.description);
        }
      }

      if (typeof this.updateServices === 'function') {
        try {
          await this.updateServices(deviceData); // Pass updated data on for accessory to process as it needs
        } catch (error) {
          this?.log?.error && this.log.error('updateServices call for device "%s" failed. Error was', this.deviceData.description, error);
        }
      }

      // Finally, update our internally stored data with the new data
      // eslint-disable-next-line no-undef
      this.deviceData = structuredClone(deviceData);
    }
  }

  async set(values) {
    if (
      typeof values !== 'object' ||
      this.#eventEmitter === undefined ||
      typeof this.deviceData?.uuid !== 'string' ||
      this.deviceData.uuid === ''
    ) {
      return;
    }

    // Send event with data to set
    this.#eventEmitter.emit(HomeKitDevice.SET, this.deviceData.uuid, values);
  }

  async get(values) {
    if (
      typeof values !== 'object' ||
      this.#eventEmitter === undefined ||
      typeof this.deviceData?.uuid !== 'string' ||
      this.deviceData.uuid === ''
    ) {
      return;
    }

    // <---- TODO
    // Send event with data to get. Once get has completed, callback will be called with the requested data
    //this.#eventEmitter.emit(HomeKitDevice.GET, this.deviceData.uuid, values);
    //
    // await ....
    // return gottenValues;
    // <---- TODO
    // Probable need some sort of await event
  }

  async #message(type, message) {
    switch (type) {
      case HomeKitDevice.ADD: {
        // Got message for device add
        if (typeof message?.name === 'string' && typeof message?.category === 'number' && typeof message?.history === 'boolean') {
          this.add(message.name, message.category, message.history);
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
            await this.messageServices(type, message);
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
