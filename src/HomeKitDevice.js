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
// Code version 28/9/2024
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import crypto from 'crypto';
import EventEmitter from 'node:events';
import { Buffer } from 'node:buffer';

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
        typeof this.deviceData?.hkPairingCode !== 'string' &&
        (new RegExp(/^([0-9]{3}-[0-9]{2}-[0-9]{3})$/).test(this.deviceData.hkPairingCode) === true ||
          new RegExp(/^([0-9]{4}-[0-9]{4})$/).test(this.deviceData.hkPairingCode) === true))
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

      // Create a HomeKit username for the device in format of xx:xx:xx:xx:xx:xx
      // Use a Nest Labs prefix for first 6 digits, followed by a CRC24 based off serial number for last 6 digits.
      this.accessory.username = ('18B430' + crc24(this.deviceData.serialNumber.toUpperCase()))
        .toString('hex')
        .split(/(..)/)
        .filter((s) => s)
        .join(':');
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

    // Perform an initial update using current data
    this.update(this.deviceData, true);

    // If using HAP-NodeJS library, publish accessory on local network
    if (this.#platform === undefined && this.accessory !== undefined) {
      this.accessory.publish({
        username: this.accessory.username,
        pincode: this.accessory.pincode,
        category: this.accessory.category,
      });
      if (this?.log?.info) {
        this.log.info('  += Advertising as "%s"', this.accessory.displayName);
        this.log.info('  += Pairing code is "%s"', this.accessory.pincode);
      }
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

// General helper functions which don't need to be part of an object class
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
