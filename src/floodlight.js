// Nest Cam with Floodlight
// Part of homebridge-nest-accfactory
//
// Code version 12/9/2024
// Mark Hulskamp
'use strict';

// Define external module requirements
import NestCamera from './camera.js';

export default class NestFloodlight extends NestCamera {
  lightService = undefined; // HomeKit light

  constructor(accessory, api, log, eventEmitter, deviceData) {
    super(accessory, api, log, eventEmitter, deviceData);
  }

  // Class functions
  addServices() {
    // Call parent to setup the common camera things. Once we return, we can add in the specifics for our floodlight
    let postSetupDetails = super.addServices();

    this.lightService = this.accessory.getService(this.hap.Service.Switch);
    if (this.deviceData.has_light === true) {
      // Add service to for a light, including brightness control
      if (this.lightService === undefined) {
        this.lightService = this.accessory.addService(this.hap.Service.Lightbulb, '', 1);
      }

      if (this.lightService.testCharacteristic(this.hap.Characteristic.Brightness) === false) {
        this.lightService.addCharacteristic(this.hap.Characteristic.Brightness);
      }

      this.lightService.getCharacteristic(this.hap.Characteristic.Brightness).setProps({
        minStep: 10, // Light only goes in 10% increments
      });

      // Setup set callback for this light service
      this.lightService.getCharacteristic(this.hap.Characteristic.On).onSet((value) => {
        if (value !== this.deviceData.light_enabled) {
          this.set({ light_enabled: value });

          this?.log?.info && this.log.info('Floodlight on "%s" was turned', this.deviceData.description, value === true ? 'on' : 'off');
        }
      });

      this.lightService.getCharacteristic(this.hap.Characteristic.Brightness).onSet((value) => {
        if (value !== this.deviceData.light_brightness) {
          this.set({ light_brightness: value });

          this?.log?.info && this.log.info('Floodlight brightness on "%s" was set to "%s %"', this.deviceData.description);
        }
      });

      this.lightService.getCharacteristic(this.hap.Characteristic.On).onGet(() => {
        return this.deviceData.light_enabled === true;
      });

      this.lightService.getCharacteristic(this.hap.Characteristic.Brightness).onGet(() => {
        return this.deviceData.light_brightness;
      });
    }
    if (this.lightService !== undefined && this.deviceData.has_light !== true) {
      // No longer required to have the light service
      this.accessory.removeService(this.lightService);
      this.lightService === undefined;
    }

    // Create extra details for output
    this.lightService !== undefined && postSetupDetails.push('Light support');
    return postSetupDetails;
  }

  removeServices() {
    super.removeServices();

    if (this.lightService !== undefined) {
      this.accessory.removeService(this.lightService);
    }
    this.lightService = undefined;
  }

  updateServices(deviceData) {
    if (typeof deviceData !== 'object' || this.controller === undefined) {
      return;
    }

    // Get the camera class todo all its updates first, then we'll handle the doorbell specific stuff
    super.updateServices(deviceData);

    if (this.lightService !== undefined) {
      // Update status of light, including brightness
      this.lightService.updateCharacteristic(this.hap.Characteristic.On, deviceData.light_enabled);
      this.lightService.updateCharacteristic(this.hap.Characteristic.Brightness, deviceData.light_brightness);
    }
  }
}
