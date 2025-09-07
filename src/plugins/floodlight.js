// Nest Cam with Floodlight
// Part of homebridge-nest-accfactory
//
// Mark Hulskamp
'use strict';

// Define external module requirements
import NestCamera, { processRawData } from './camera.js';
export { processRawData };

export default class NestFloodlight extends NestCamera {
  static TYPE = 'FloodlightCamera';
  static VERSION = '2025.07.25'; // Code version

  lightService = undefined; // HomeKit light

  // Class functions
  onAdd() {
    if (this.deviceData.has_light === true) {
      // Add service for a light, including brightness control
      this.lightService = this.addHKService(this.hap.Service.Lightbulb, '', 1);
      this.addHKCharacteristic(this.lightService, this.hap.Characteristic.Brightness, {
        props: { minStep: 10 }, // Light only goes in 10% increments
        onSet: (value) => {
          if (value !== this.deviceData.light_brightness) {
            this.message(NestFloodlight.SET, { uuid: this.deviceData.nest_google_uuid, light_brightness: value });

            this?.log?.info?.('Floodlight brightness on "%s" was set to "%s %"', this.deviceData.description, value);
          }
        },
        onGet: () => {
          return this.deviceData.light_brightness;
        },
      });

      this.addHKCharacteristic(this.lightService, this.hap.Characteristic.On, {
        onSet: (value) => {
          if (value !== this.deviceData.light_enabled) {
            this.message(NestFloodlight.SET, { uuid: this.deviceData.nest_google_uuid, light_enabled: value });

            this?.log?.info?.('Floodlight on "%s" was turned', this.deviceData.description, value === true ? 'on' : 'off');
          }
        },
        onGet: () => {
          return this.deviceData.light_enabled === true;
        },
      });
    }
    if (this.deviceData.has_light !== true) {
      // No longer required to have the light service
      this.lightService = this.accessory.getService(this.hap.Service.Lightbulb);
      if (this.lightService !== undefined) {
        this.accessory.removeService(this.lightService);
      }
      this.lightService = undefined;
    }

    // Extra setup details for output
    this.lightService !== undefined && this.postSetupDetail('Light support');
  }

  onRemove() {
    this.accessory.removeService(this.lightService);
    this.lightService = undefined;
  }

  onUpdate(deviceData) {
    if (typeof deviceData !== 'object' || this.controller === undefined) {
      return;
    }

    if (this.lightService !== undefined) {
      // Update status of light, including brightness
      this.lightService.updateCharacteristic(this.hap.Characteristic.On, deviceData.light_enabled);
      this.lightService.updateCharacteristic(this.hap.Characteristic.Brightness, deviceData.light_brightness);
    }
  }
}
