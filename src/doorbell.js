// Nest Doorbell(s)
// Part of homebridge-nest-accfactory
//
// Code version 3/9/2024
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
  addServices() {
    // Setup some details around the doorbell BEFORE will call out parent addServices function
    this.createCameraMotionServices();
    this.controller = new this.hap.DoorbellController(this.generateControllerOptions());
    this.accessory.configureController(this.controller);

    // Call parent to setup the common camera things. Once we return, we can add in the specifics for our doorbell
    let postSetupDetails = super.addServices();

    this.switchService = this.accessory.getService(this.hap.Service.Switch);
    if (this.deviceData.has_indoor_chime === true && this.deviceData.chimeSwitch === true) {
      // Add service to allow automation and enabling/disabling indoor chiming.
      // This needs to be explically enabled via a configuration option for the device
      if (this.switchService === undefined) {
        this.switchService = this.accessory.addService(this.hap.Service.Switch, '', 1);
      }

      // Setup set callback for this switch service
      this.switchService.getCharacteristic(this.hap.Characteristic.On).onSet((value) => {
        if (value !== this.deviceData.indoor_chime_enabled) {
          // only change indoor chime status value if different than on-device
          this.set({ 'doorbell.indoor_chime.enabled': value });

          this?.log?.info && this.log.info('Indoor chime on "%s" was turned', this.deviceData.description, value === true ? 'on' : 'off');
        }
      });

      this.switchService.getCharacteristic(this.hap.Characteristic.On).onGet(() => {
        return this.deviceData.indoor_chime_enabled === true;
      });
    }
    if (this.switchService !== undefined && (this.deviceData.has_indoor_chime === false || this.deviceData.chimeSwitch === false)) {
      // No longer required to have the switch service
      // This is to handle Homebridge cached restored accessories and if configuration options have changed
      this.accessory.removeService(this.switchService);
      this.switchService === undefined;
    }

    // Create extra details for output
    this.switchService !== undefined && postSetupDetails.push('Chime switch');
    return postSetupDetails;
  }

  removeServices() {
    super.removeServices();

    this.doorbellTimer = clearTimeout(this.doorbellTimer);
    if (this.switchService !== undefined) {
      this.accessory.removeService(this.switchService);
    }
    this.switchService = undefined;
  }

  updateServices(deviceData) {
    if (typeof deviceData !== 'object' || this.controller === undefined) {
      return;
    }

    // Get the camera class todo all its updates first, then we'll handle the doorbell specific stuff
    super.updateServices(deviceData);

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
          this.snapshotEvent = undefined; // Clear snapshot event image after timeout
          this.doorbellTimer = undefined; // No doorbell timer active
        }, this.deviceData.doorbellCooldown * 1000);

        if (event.types.includes('motion') === false) {
          // No motion event with the doorbell alert, add one to trigger HKSV recording if configured
          // seems in HomeKit, EventTriggerOption.DOORBELL gets ignored
          event.types.push('motion');
        }

        this.snapshotEvent = {
          type: 'ring',
          time: event.playback_time,
          id: event.id,
          done: false,
        };

        if (deviceData.indoor_chime_enabled === false || deviceData.quiet_time_enabled === true) {
          // Indoor chime is disabled or quiet time is enabled, so we won't 'ring' the doorbell
          this?.log?.warn && this.log.warn('Doorbell rung at "%s" but indoor chime is silenced', this.deviceData.description);
        }
        if (deviceData.indoor_chime_enabled === true && deviceData.quiet_time_enabled === false) {
          // Indoor chime is enabled and quiet time isn't enabled, so 'ring' the doorbell
          this?.log?.info && this.log.info('Doorbell rung at "%s"', this.deviceData.description);
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
