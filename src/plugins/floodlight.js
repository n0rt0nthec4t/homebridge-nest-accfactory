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
import NestCamera, { processRawData as processCameraRawData } from './camera.js';
import { scaleValue } from '../utils.js';

export default class NestFloodlight extends NestCamera {
  static TYPE = 'FloodlightCamera';
  static VERSION = '2026.04.15'; // Code version

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
            this.set({ uuid: this.deviceData.nest_google_device_uuid, light_enabled: value });

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
    if (this.lightService !== undefined) {
      this.accessory.removeService(this.lightService);
    }
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

// Floodlight extra field translation map
// Maps raw source data -> normalised floodlight-specific fields
// - fields: top-level raw fields this mapping depends on (for delta updates)
// - related: top-level raw fields on related objects this mapping depends on
// - translate: converts raw -> final normalised value
// - required: extends base camera required fields
const EXTRA_FIELD_MAP = {
  has_light: {
    required: true,
    google: {
      fields: ['floodlight_settings', 'floodlight_state'],
      translate: ({ raw }) => typeof raw?.value?.floodlight_settings === 'object' && typeof raw?.value?.floodlight_state === 'object',
    },
  },

  light_enabled: {
    required: true,
    google: {
      fields: ['floodlight_state'],
      translate: ({ raw }) => raw?.value?.floodlight_state?.currentState === 'LIGHT_STATE_ON',
    },
  },

  light_brightness: {
    required: true,
    google: {
      fields: ['floodlight_settings'],
      translate: ({ raw }) =>
        isNaN(raw?.value?.floodlight_settings?.brightness) === false
          ? scaleValue(Number(raw.value.floodlight_settings.brightness), 0, 10, 0, 100)
          : undefined,
    },
  },
};

export function processRawData(log, rawData, config, deviceType = undefined, changedData = undefined) {
  return processCameraRawData(log, rawData, config, deviceType, changedData, EXTRA_FIELD_MAP);
}
