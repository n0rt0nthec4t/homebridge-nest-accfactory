// Nest Doorbell(s)
// Part of homebridge-nest-accfactory
//
// Code version 2025/06/10
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { setTimeout, clearTimeout } from 'node:timers';

// Define external module requirements
import NestCamera from './camera.js';

export default class NestDoorbell extends NestCamera {
  doorbellTimer = undefined; // Cooldown timer for doorbell events
  switchService = undefined; // HomeKit switch for enabling/disabling chime

  constructor(accessory, api, log, eventEmitter, deviceData) {
    super(accessory, api, log, eventEmitter, deviceData);
  }

  // Class functions
  setupDevice() {
    // Call parent to setup the common camera things. Once we return, we can add in the specifics for our doorbell
    // We pass in the HAP Doorbell controller constructor function here also
    super.setupDevice(this.hap.DoorbellController);

    if (this.deviceData?.has_indoor_chime === true && this.deviceData?.chimeSwitch === true) {
      // Add service to allow automation and enabling/disabling indoor chiming.
      // This needs to be explically enabled via a configuration option for the device
      this.switchService = this.setupService(this.hap.Service.Switch, '', 1);

      // Setup set callback for this switch service
      this.setupCharacteristic(this.switchService, this.hap.Characteristic.On, {
        onSet: (value) => {
          if (value !== this.deviceData.indoor_chime_enabled) {
            // only change indoor chime status value if different than on-device
            this.set({ uuid: this.deviceData.nest_google_uuid, indoor_chime_enabled: value });

            this?.log?.info?.('Indoor chime on "%s" was turned', this.deviceData.description, value === true ? 'on' : 'off');
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

  removeDevice() {
    super.removeDevice();

    clearTimeout(this.doorbellTimer);
    this.doorbellTimer = undefined;

    if (this.switchService !== undefined) {
      this.accessory.removeService(this.switchService);
    }
    this.switchService = undefined;
  }

  updateDevice(deviceData) {
    if (typeof deviceData !== 'object' || this.controller === undefined) {
      return;
    }

    // Get the camera class todo all its updates first, then we'll handle the doorbell specific stuff
    super.updateDevice(deviceData);

    if (this.switchService !== undefined) {
      // Update status of indoor chime enable/disable switch
      this.switchService.updateCharacteristic(this.hap.Characteristic.On, deviceData.indoor_chime_enabled);
    }

    deviceData.alerts.forEach((event) => {
      // Handle doorbell event, should always be handled first
      if (event.types.includes('doorbell') === true && this.doorbellTimer === undefined) {
        // Cooldown for doorbell button being pressed (filters out constant pressing for time period)
        // Start this before we process further
        this.doorbellTimer = setTimeout(() => {
          this.doorbellTimer = undefined; // No doorbell timer active
        }, this.deviceData.doorbellCooldown * 1000);

        if (deviceData.indoor_chime_enabled === false || deviceData.quiet_time_enabled === true) {
          // Indoor chime is disabled or quiet time is enabled, so we won't 'ring' the doorbell
          this?.log?.warn?.('Doorbell rung at "%s" but indoor chime is silenced', deviceData.description);
        }
        if (deviceData.indoor_chime_enabled === true && deviceData.quiet_time_enabled === false) {
          // Indoor chime is enabled and quiet time isn't enabled, so 'ring' the doorbell
          this?.log?.info?.('Doorbell rung at "%s"', deviceData.description);
          this.controller.ringDoorbell();
        }

        if (this.controller?.doorbellService !== undefined && typeof this.historyService?.addHistory === 'function') {
          // Record a doorbell press and unpress event to our history
          this.historyService.addHistory(this.controller.doorbellService, {
            time: Math.floor(Date.now() / 1000),
            status: 1,
          });
          this.historyService.addHistory(this.controller.doorbellService, {
            time: Math.floor(Date.now() / 1000),
            status: 0,
          });
        }
      }
    });
  }
}
