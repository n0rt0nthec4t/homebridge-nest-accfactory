// Nest Doorbell - HomeKit integration
// Part of homebridge-nest-accfactory
//
// HomeKit accessory implementation for Nest Doorbells.
// Extends NestCamera to add doorbell-specific behaviour including
// doorbell press handling and Quiet Time suppression.
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
// - Quiet Time suppresses HomeKit rings independently of the physical indoor chime
//
// Mark Hulskamp
'use strict';

// Define external modules
import NestCamera, { processRawData as processCameraRawData } from './camera.js';

// Define constants
import { DEVICE_TYPE, TIMERS } from '../consts.js';

export default class NestDoorbell extends NestCamera {
  static TYPE = DEVICE_TYPE.DOORBELL;
  static VERSION = '2026.11.27'; // Code version

  // Internal data only for this class
  #doorbellCooldownActive = false; // Flag to track if doorbell cooldown is active
  #lastDoorbellTime = 0; // Latest observed press, including suppressed presses.

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
      if (event.types.includes('doorbell') !== true) {
        continue;
      }

      // History can repeat or extend an event after cooldown. Its start identifies
      // the press; consume suppressed presses too so they cannot ring later.
      let eventTime = event.start_time;
      if (Number.isFinite(eventTime) !== true) {
        continue;
      }
      eventTime = eventTime < 1e12 ? eventTime * 1000 : eventTime;
      if (eventTime <= this.#lastDoorbellTime) {
        continue;
      }
      this.#lastDoorbellTime = eventTime;

      // Handle doorbell event, should always be handled first
      if (this.#doorbellCooldownActive === false) {
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
        if (quietTimeActive === false) {
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
    prefer: 'googlehome',
    googlehome: {
      fields: ['quietTime.quietTimeEnabled', 'quietTime.endTime'],
      translate: ({ raw }) => {
        let enabled = raw.value['quietTime.quietTimeEnabled']?.boolean;
        let endTime = raw.value['quietTime.endTime']?.number;
        // End time is Unix seconds. An explicit disable overrides a retained expiry.
        if (enabled === false) {
          return 0;
        }
        return enabled === true && typeof endTime === 'number' && Number.isFinite(endTime) === true && endTime >= 0 ? endTime : undefined;
      },
    },
  },
};

export function processRawData(log, rawData, config, deviceType = undefined, changedData = undefined) {
  return processCameraRawData(log, rawData, config, deviceType, changedData, EXTRA_FIELD_MAP);
}
