// Nest Doorbell(s)
// Part of homebridge-nest-accfactory
//
// Code version 21/8/2024
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { setTimeout, clearTimeout } from 'node:timers';

// Define external module requirements
import NestCamera from './camera.js';
import NexusStreamer from './nexusstreamer.js';

export default class NestDoorbell extends NestCamera {
  doorbellTimer = undefined; // Cooldown timer for doorbell events
  switchService = undefined; // HomeKit switch for enabling/disabling chime

  constructor(accessory, api, log, eventEmitter, deviceData) {
    super(accessory, api, log, eventEmitter, deviceData);
  }

  // Class functions
  addServices() {
    this.createCameraMotionServices();

    // Setup HomeKit doorbell controller
    this.controller = new this.hap.DoorbellController(this.generateControllerOptions());
    this.accessory.configureController(this.controller);

    // Setup additional HomeKit services and characteristics we'll use
    if (this.controller.doorbellService.testCharacteristic(this.hap.Characteristic.StatusActive) === false) {
      this.controller.doorbellService.addCharacteristic(this.hap.Characteristic.StatusActive);
    }
    if (this.controller.microphoneService.testCharacteristic(this.hap.Characteristic.StatusActive) === false) {
      this.controller.microphoneService.addCharacteristic(this.hap.Characteristic.StatusActive);
    }
    if (this.controller.speakerService.testCharacteristic(this.hap.Characteristic.StatusActive) === false) {
      this.controller.speakerService.addCharacteristic(this.hap.Characteristic.StatusActive);
    }

    if (this.deviceData.has_indoor_chime === true && this.deviceData.chimeSwitch === true) {
      // Add service to allow automation and enabling/disabling indoor chiming.
      // This needs to be explically enabled via a configuration option for the device
      this.switchService = this.accessory.getService(this.hap.Service.Switch);
      if (this.switchService === undefined) {
        this.switchService = this.accessory.addService(this.hap.Service.Switch, '', 1);
      }
      if (this.switchService.testCharacteristic(this.hap.Characteristic.StatusActive) === false) {
        this.switchService.addCharacteristic(this.hap.Characteristic.StatusActive);
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
    if (this.switchService !== undefined && this.deviceData.chimeSwitch === false) {
      // No longer required to have the switch service
      // This is to handle Homebridge cached restored accessories
      this.accessory.removeService(this.switchService);
    }

    // Setup additional services/characteristics after we have a controller created
    this.createCameraServices();

    // Setup our streaming object
    this.NexusStreamer = new NexusStreamer(this.deviceData, { log: this.log });

    // Setup linkage to EveHome app if configured todo so
    if (
      this.deviceData?.eveHistory === true &&
      typeof this.motionServices?.[1]?.service === 'object' &&
      typeof this.historyService?.linkToEveHome === 'function'
    ) {
      this.historyService.linkToEveHome(this.motionServices[1].service, {
        description: this.deviceData.description,
      });
    }

    // Create extra details for output
    let postSetupDetails = [];
    this.deviceData.hksv === true && postSetupDetails.push('Using HomeKit Secure Video');
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
    if (typeof deviceData !== 'object' || (this.controller === undefined && this.controller?.doorbellService === undefined)) {
      return;
    }

    // Get the camera class todo all its updates first, then we'll handle the doorbell specific stuff
    super.updateServices(deviceData);

    // Update online status of Doorbell in HomeKit
    this.controller.doorbellService.updateCharacteristic(this.hap.Characteristic.StatusActive, deviceData.online);

    if (this.switchService !== undefined) {
      // Update status of indoor chime enable/disable switch
      this.switchService.updateCharacteristic(this.hap.Characteristic.StatusActive, deviceData.online);
      this.switchService.updateCharacteristic(this.hap.Characteristic.On, deviceData.indoor_chime_enabled);
    }

    deviceData.alerts.forEach((event) => {
      // Handle doorbell event, should always be handled first
      if (event.types.includes('doorbell') === true && this.doorbellTimer === undefined) {
        // Cooldown for doorbell button being pressed (filters out constant pressing for time period)
        // Start this before we process further
        this.doorbellTimer = setTimeout(() => {
          // Clear snapshot event image after timeout
          this.snapshotEvent = {
            type: '',
            time: 0,
            id: 0,
            done: false,
          };
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
