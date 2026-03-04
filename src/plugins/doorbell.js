// Nest Doorbell(s)
// Part of homebridge-nest-accfactory
//
// Mark Hulskamp
'use strict';

// Define external module requirements
import NestCamera, { processRawData } from './camera.js';
export { processRawData };

// Define constants
import { TIMERS } from '../consts.js';

export default class NestDoorbell extends NestCamera {
  static TYPE = 'Doorbell';
  static VERSION = '2026.03.04'; // Code version

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
    }
    if (this.deviceData?.has_indoor_chime === false || this.deviceData?.chimeSwitch === false) {
      // No longer required to have the switch service
      // This is to handle Homebridge cached restored accessories and if configuration options have changed
      this.switchService = this.accessory.getService(this.hap.Service.Switch);
      if (this.switchService !== undefined) {
        this.accessory.removeService(this.switchService);
      }
      this.switchService = undefined;
    }

    // Extra setup details for output
    this.switchService !== undefined && this.postSetupDetail('Chime switch');
  }

  onRemove() {
    this.accessory.removeService(this.switchService);
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

    deviceData.events.forEach((event) => {
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
    });
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
