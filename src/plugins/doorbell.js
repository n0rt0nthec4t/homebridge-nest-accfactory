// Nest Doorbell - HomeKit integration
// Part of homebridge-nest-accfactory
//
// HomeKit accessory implementation for Nest Doorbells.
// Extends NestCamera to add doorbell-specific behaviour including
// doorbell press handling and optional indoor chime control.
//
// Responsibilities:
// - Extend camera functionality with doorbell event handling
// - Process doorbell press events and trigger HomeKit doorbell service
// - Manage indoor chime enable/disable via optional switch service
// - Apply cooldown logic to prevent repeated doorbell triggers
// - Synchronise chime state with HomeKit and upstream API
//
// Inherits from NestCamera:
// - Video streaming (WebRTC / NexusTalk with HKSV support)
// - Motion detection and smart alerts
// - Snapshot handling and recording (HKSV)
// - Two-way audio (talkback)
// - Event processing and history integration
//
// Services:
// - DoorbellController (via NestCamera)
// - Switch (optional, for indoor chime control)
//
// Features:
// - Doorbell press detection with cooldown protection
// - Indoor chime control with HomeKit switch (optional)
// - Two-way audio support
// - Full HomeKit Secure Video support
// - Eve Home activity history integration
//
// Notes:
// - Streaming and recording are handled entirely by NestCamera
// - This module only adds doorbell-specific behaviour and services
// - Doorbell press events may be suppressed if chime is disabled or quiet time is active
//
// Mark Hulskamp
'use strict';

// Define external module requirements
import NestCamera, { processRawData as processCameraRawData } from './camera.js';

// Define constants
import { TIMERS } from '../consts.js';

export default class NestDoorbell extends NestCamera {
  static TYPE = 'Doorbell';
  static VERSION = '2026.04.16'; // Code version

  switchService = undefined; // HomeKit switch for enabling/disabling chime

  // Internal data only for this class
  #doorbellCooldownActive = false; // Flag to track if doorbell cooldown is active

  // Class functions
  onAdd() {
    if (this.deviceData?.has_indoor_chime === true && this.deviceData?.chimeSwitch === true) {
      // Add service to allow automation and enabling/disabling indoor chiming.
      // This needs to be explicitly enabled via a configuration option for the device
      this.switchService = this.addHKService(this.hap.Service.Switch, '', 1);

      // Setup set callback for this switch service
      this.addHKCharacteristic(this.switchService, this.hap.Characteristic.On, {
        onSet: (value) => {
          if (value !== this.deviceData.indoor_chime_enabled) {
            // only change indoor chime status value if different than on-device
            this.set({ uuid: this.deviceData.nest_google_device_uuid, indoor_chime_enabled: value });

            this?.log?.info?.('Indoor chime on "%s" was turned %s', this.deviceData.description, value === true ? 'on' : 'off');
          }
        },
        onGet: () => {
          return this.deviceData.indoor_chime_enabled === true;
        },
      });

      // Extra setup details for output
      this.switchService !== undefined && this.postSetupDetail('Chime switch');
    }
    if (this.deviceData?.has_indoor_chime !== true || this.deviceData?.chimeSwitch !== true) {
      // No longer required to have the switch service
      // This is to handle Homebridge cached restored accessories and if configuration options have changed
      this.switchService = this.accessory.getService(this.hap.Service.Switch);
      if (this.switchService !== undefined) {
        this.accessory.removeService(this.switchService);
      }
      this.switchService = undefined;
    }
  }

  onRemove() {
    if (this.switchService !== undefined) {
      this.accessory.removeService(this.switchService);
    }
    this.switchService = undefined;
  }

  onUpdate(deviceData) {
    if (typeof deviceData !== 'object' || this.controller === undefined) {
      return;
    }

    if (this.switchService !== undefined) {
      // Update status of indoor chime enable/disable switch
      this.switchService.updateCharacteristic(this.hap.Characteristic.On, deviceData.indoor_chime_enabled);
    }

    // Log indoor chime state changes
    if (typeof deviceData?.indoor_chime_enabled === 'boolean' && deviceData.indoor_chime_enabled !== this.deviceData.indoor_chime_enabled) {
      this?.log?.info?.('Indoor chime on "%s" turned %s', deviceData.description, deviceData.indoor_chime_enabled === true ? 'on' : 'off');
    }

    for (const event of deviceData.events || []) {
      // Handle doorbell event, should always be handled first
      if (event.types.includes('doorbell') === true && this.#doorbellCooldownActive === false) {
        // Cooldown for doorbell button being pressed (filters out constant pressing for time period)
        // Start the cooldown timer only when event occurs
        this.addTimer(TIMERS.DOORBELL_COOLDOWN.name, {
          delay: this.deviceData.doorbellCooldown * 1000,
          reset: true,
        });
        this.#doorbellCooldownActive = true;

        if (deviceData.indoor_chime_enabled === false || deviceData.quiet_time_enabled === true) {
          // Indoor chime is disabled or quiet time is enabled, so we won't 'ring' the doorbell
          this?.log?.warn?.('Doorbell rung at "%s" but indoor chime is silenced', deviceData.description);
        }
        if (deviceData.indoor_chime_enabled === true && deviceData.quiet_time_enabled === false) {
          // Indoor chime is enabled and quiet time isn't enabled, so 'ring' the doorbell
          this?.log?.info?.('Doorbell rung at "%s"', deviceData.description);
          this.controller.ringDoorbell();
        }

        // Record a doorbell press and unpress event to our history
        this.history(this.controller.doorbellService, { status: 1 }, { timegap: 2, force: true });
        this.history(this.controller.doorbellService, { status: 0 }, { timegap: 2, force: true });
      }
    }
  }

  async onTimer(message) {
    if (typeof message !== 'object') {
      return;
    }

    // Handle doorbell-specific cooldown expiry
    if (message?.timer === TIMERS.DOORBELL_COOLDOWN.name) {
      // Doorbell cooldown timer has completed, reset the cooldown active flag to allow for new doorbell events to be processed
      this.#doorbellCooldownActive = false;
    }
  }
}

// Doorbell extra field translation map
// Maps raw source data -> normalised doorbell-specific fields
// - fields: top-level raw fields this mapping depends on (for delta updates)
// - related: top-level raw fields on related objects this mapping depends on
// - translate: converts raw -> final normalised value
// - required: extends base camera required fields
const EXTRA_FIELD_MAP = {
  has_indoor_chime: {
    required: true,
    google: {
      fields: ['doorbell_indoor_chime_settings'],
      translate: ({ raw }) =>
        raw?.value?.doorbell_indoor_chime_settings?.chimeType === 'CHIME_TYPE_MECHANICAL' ||
        raw?.value?.doorbell_indoor_chime_settings?.chimeType === 'CHIME_TYPE_ELECTRONIC',
    },
    nest: {
      fields: ['capabilities'],
      translate: ({ raw }) => raw?.value?.capabilities?.includes?.('indoor_chime') === true,
    },
  },

  indoor_chime_enabled: {
    required: true,
    google: {
      fields: ['doorbell_indoor_chime_settings'],
      translate: ({ raw }) => raw?.value?.doorbell_indoor_chime_settings?.chimeEnabled === true,
    },
    nest: {
      fields: ['properties'],
      translate: ({ raw }) => raw?.value?.properties?.['doorbell.indoor_chime.enabled'] === true,
    },
  },
};

export function processRawData(log, rawData, config, deviceType = undefined, changedData = undefined) {
  return processCameraRawData(log, rawData, config, deviceType, changedData, EXTRA_FIELD_MAP);
}
