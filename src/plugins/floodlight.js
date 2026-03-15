// Nest Cam with Floodlight - HomeKit integration
// Part of homebridge-nest-accfactory
//
// HomeKit accessory for Nest Cam with Floodlight - extends NestCamera with integrated flood light control.
// Provides video streaming from camera plus independent light control with brightness adjustment.
//
// Inherits from NestCamera:
// - Video streaming (WebRTC/NexusTalk with HKSV support)
// - Motion detection and smart alerts
// - Snapshot and recording capabilities
// - Night vision modes
// - Audio streaming when supported
//
// Additional Services (Floodlight):
// - Lightbulb (when has_light enabled)
//
// Lightbulb Characteristics:
// - On: Light on/off control
// - Brightness: Light brightness (0-100%, adjusts in 10% increments)
//
// Features:
// - Dual-function device: camera streaming + controllable light
// - Dynamic light service creation based on device capabilities
// - Brightness control with 10% step increments
// - Real-time light status updates
// - Motion-triggered notification integration
// - Eve Home history support (inherited from camera)
//
// Data processing:
// - Extends camera field mapping with light control fields
// - Synchronises light state (on/off, brightness) with HomeKit
// - Supports brightness updates from remote API
// - Maintains camera and light status independently
//
// Mark Hulskamp
'use strict';

// Define external module requirements
import NestCamera, { processRawData } from './camera.js';
export { processRawData };

export default class NestFloodlight extends NestCamera {
  static TYPE = 'FloodlightCamera';
  static VERSION = '2026.03.15'; // Code version

  lightService = undefined; // HomeKit light

  // Class functions
  onAdd() {
    if (this.deviceData?.has_light === true) {
      // Add service for a light, including brightness control
      this.lightService = this.addHKService(this.hap.Service.Lightbulb, '', 1);
      this.addHKCharacteristic(this.lightService, this.hap.Characteristic.Brightness, {
        props: { minStep: 10 }, // Light only goes in 10% increments
        onSet: (value) => {
          if (value !== this.deviceData.light_brightness) {
            this.set({ uuid: this.deviceData.nest_google_device_uuid, light_brightness: value });

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
            this.message(NestFloodlight.SET, { uuid: this.deviceData.nest_google_device_uuid, light_enabled: value });

            this?.log?.info?.('Floodlight on "%s" was turned %s', this.deviceData.description, value === true ? 'on' : 'off');
          }
        },
        onGet: () => {
          return this.deviceData.light_enabled === true;
        },
      });

      // Extra setup details for output
      this.lightService !== undefined && this.postSetupDetail('Light support');
    }
    if (this.deviceData?.has_light !== true) {
      // No longer required to have the light service
      this.lightService = this.accessory.getService(this.hap.Service.Lightbulb);
      if (this.lightService !== undefined) {
        this.accessory.removeService(this.lightService);
      }
      this.lightService = undefined;
    }
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

      // Log floodlight on/off state changes
      if (typeof deviceData?.light_enabled === 'boolean' && deviceData.light_enabled !== this.deviceData.light_enabled) {
        this?.log?.info?.('Floodlight light on "%s" turned %s', deviceData.description, deviceData.light_enabled === true ? 'on' : 'off');
      }
    }
  }
}
