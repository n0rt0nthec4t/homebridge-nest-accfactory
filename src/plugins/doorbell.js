// Nest Doorbell - HomeKit integration
// Part of homebridge-nest-accfactory
//
// HomeKit accessory implementation for Nest Doorbells.
// Extends NestCamera to add doorbell-specific behaviour including
// doorbell press handling and indoor chime notification preferences.
//
// Responsibilities:
// - Extend camera functionality with doorbell event handling
// - Process doorbell press events and trigger HomeKit doorbell service
// - Apply cooldown logic to prevent repeated doorbell triggers
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
//
// Features:
// - Doorbell press detection with cooldown protection
// - Two-way audio support
// - Full HomeKit Secure Video support
// - Eve Home activity history integration
//
// Notes:
// - Streaming and recording are handled entirely by NestCamera
// - This module only adds doorbell-specific behaviour and services
// - Quiet Time always suppresses HomeKit rings; indoor chime suppression can be overridden
//
// Mark Hulskamp
'use strict';

// Define external module requirements
import NestCamera, { processRawData as processCameraRawData } from './camera.js';

// Define constants
import { DEVICE_TYPE, TIMERS } from '../consts.js';

export default class NestDoorbell extends NestCamera {
  static TYPE = DEVICE_TYPE.DOORBELL;
  static VERSION = '2026.10.06'; // Code version

  // Internal data only for this class
  #doorbellCooldownActive = false; // Flag to track if doorbell cooldown is active

  // Class functions
  onAdd() {
    // Pre-0.4.4 cleanup
    // Remove legacy chime switch from the Doorbell accessory
    this.accessory.services
      .filter((service) => service.UUID === this.hap.Service.Switch.UUID)
      .forEach((service) => {
        this.removeService(service);
      });
    // End of pre-0.4.4 cleanup
  }

  onUpdate(deviceData) {
    if (typeof deviceData !== 'object' || this.controller === undefined) {
      return;
    }

    // Check expiry on every press because Observe may not send a delta when Quiet Time ends.
    let quietTimeActive = deviceData.quiet_time_ends > Date.now() / 1000 ? true : false;

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

        if (quietTimeActive === true) {
          // Quiet Time suppresses HomeKit rings as well as upstream visitor announcements.
          this?.log?.warn?.('Doorbell rung at "%s" but quiet time is active', deviceData.description);
        }
        if (quietTimeActive === false && deviceData.indoor_chime_enabled !== true && deviceData.ignoreIndoorChime !== true) {
          this?.log?.warn?.('Doorbell rung at "%s" but indoor chime is silenced', deviceData.description);
        }
        if (quietTimeActive === false && (deviceData.indoor_chime_enabled === true || deviceData.ignoreIndoorChime === true)) {
          // Ignore the physical chime preference only when explicitly configured; Quiet Time still takes precedence.
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
  quiet_time_ends: {
    google: {
      fields: ['quiet_time_settings'],
      translate: ({ raw }) => Number(raw?.value?.quiet_time_settings?.quietTimeEnds?.seconds ?? 0),
    },
    nest: {
      fields: ['properties'],
      translate: ({ raw }) => Number(raw?.value?.properties?.['doorbell.quiet_time.enabled_until'] ?? 0),
    },
  },

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
