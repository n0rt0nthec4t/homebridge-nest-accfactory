// Nest Cam with Floodlight - HomeKit integration
// Part of homebridge-nest-accfactory
//
// HomeKit accessory implementation for Nest Cam with Floodlight.
// Extends NestCamera to add floodlight-specific behaviour and light control
// while reusing camera streaming, snapshots, motion handling, and HKSV support.
//
// Responsibilities:
// - Extend camera functionality with floodlight control
// - Manage HomeKit light service creation and removal
// - Synchronise floodlight on/off and brightness state with HomeKit
// - Route light control changes to the upstream API
//
// Inherits from NestCamera:
// - Video streaming (WebRTC / NexusTalk with HKSV support)
// - Motion detection and smart alerts
// - Snapshot handling and recording (HKSV)
// - Two-way audio when supported
// - Event processing and history integration
//
// Services:
// - CameraController (via NestCamera)
// - Lightbulb (optional, when floodlight support is available)
//
// Features:
// - Combined camera and controllable floodlight accessory
// - Dynamic light service creation based on device capabilities
// - Floodlight on/off control
// - Brightness control in 10% increments
// - Real-time light state synchronisation
//
// Notes:
// - Streaming and recording are handled entirely by NestCamera
// - This module only adds floodlight-specific light control behaviour
// - Camera and floodlight states are managed independently
//
// Mark Hulskamp
'use strict';

// Define external module requirements
import NestCamera, { processRawData } from './camera.js';
export { processRawData };

export default class NestFloodlight extends NestCamera {
  static TYPE = 'FloodlightCamera';
  static VERSION = '2026.04.01'; // Code version

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
