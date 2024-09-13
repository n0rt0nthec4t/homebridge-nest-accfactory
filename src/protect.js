// Nest Protect
// Part of homebridge-nest-accfactory
//
// Code version 12/9/2024
// Mark Hulskamp
'use strict';

// Define our modules
import HomeKitDevice from './HomeKitDevice.js';

const LOWBATTERYLEVEL = 10; // Low battery level percentage

export default class NestProtect extends HomeKitDevice {
  batteryService = undefined;
  smokeService = undefined;
  motionService = undefined;
  carbonMonoxideService = undefined;

  constructor(accessory, api, log, eventEmitter, deviceData) {
    super(accessory, api, log, eventEmitter, deviceData);
  }

  // Class functions
  addServices() {
    // Create extra details for output
    let postSetupDetails = [];

    // Setup the smoke sensor service if not already present on the accessory
    this.smokeService = this.accessory.getService(this.hap.Service.SmokeSensor);
    if (this.smokeService === undefined) {
      this.smokeService = this.accessory.addService(this.hap.Service.SmokeSensor, '', 1);
    }
    if (this.smokeService.testCharacteristic(this.hap.Characteristic.StatusActive) === false) {
      this.smokeService.addCharacteristic(this.hap.Characteristic.StatusActive);
    }
    if (this.smokeService.testCharacteristic(this.hap.Characteristic.StatusFault) === false) {
      this.smokeService.addCharacteristic(this.hap.Characteristic.StatusFault);
    }
    this.smokeService.setPrimaryService();

    // Setup the carbon monoxide service if not already present on the accessory
    this.carbonMonoxideService = this.accessory.getService(this.hap.Service.CarbonMonoxideSensor);
    if (this.carbonMonoxideService === undefined) {
      this.carbonMonoxideService = this.accessory.addService(this.hap.Service.CarbonMonoxideSensor, '', 1);
    }
    if (this.carbonMonoxideService.testCharacteristic(this.hap.Characteristic.StatusActive) === false) {
      this.carbonMonoxideService.addCharacteristic(this.hap.Characteristic.StatusActive);
    }
    if (this.carbonMonoxideService.testCharacteristic(this.hap.Characteristic.StatusFault) === false) {
      this.carbonMonoxideService.addCharacteristic(this.hap.Characteristic.StatusFault);
    }

    // Setup battery service if not already present on the accessory
    this.batteryService = this.accessory.getService(this.hap.Service.Battery);
    if (this.batteryService === undefined) {
      this.batteryService = this.accessory.addService(this.hap.Service.Battery, '', 1);
    }
    this.batteryService.setHiddenService(true);

    // Setup motion service if not already present on the accessory and Nest protect is a wired version
    if (typeof this.deviceData?.wired_or_battery === 'number' && this.deviceData?.wired_or_battery === 0) {
      this.motionService = this.accessory.getService(this.hap.Service.MotionSensor);
      if (this.motionService === undefined) {
        this.motionService = this.accessory.addService(this.hap.Service.MotionSensor, '', 1);
      }
      postSetupDetails.push('With motion sensor');
    }

    // Setup linkage to EveHome app if configured todo so
    if (
      this.deviceData?.eveHistory === true &&
      this.smokeService !== undefined &&
      typeof this.historyService?.linkToEveHome === 'function'
    ) {
      this.historyService.linkToEveHome(this.smokeService, {
        description: this.deviceData.description,
        getcommand: this.#EveHomeGetcommand.bind(this),
        setcommand: this.#EveHomeSetcommand.bind(this),
        EveSmoke_lastalarmtest: this.deviceData.latest_alarm_test,
        EveSmoke_alarmtest: this.deviceData.self_test_in_progress,
        EveSmoke_heatstatus: this.deviceData.heat_status,
        EveSmoke_hushedstate: this.deviceData.hushed_state,
        EveSmoke_statusled: this.deviceData.ntp_green_led_enable,
        EveSmoke_smoketestpassed: this.deviceData.smoke_test_passed,
        EveSmoke_heattestpassed: this.deviceData.heat_test_passed,
      });
    }

    return postSetupDetails;
  }

  updateServices(deviceData) {
    if (
      typeof deviceData !== 'object' ||
      this.smokeService === undefined ||
      this.carbonMonoxideService === undefined ||
      this.batteryService === undefined
    ) {
      return;
    }

    // Update battery level and status
    this.batteryService.updateCharacteristic(this.hap.Characteristic.BatteryLevel, deviceData.battery_level);
    this.batteryService.updateCharacteristic(
      this.hap.Characteristic.StatusLowBattery,
      deviceData.battery_level > LOWBATTERYLEVEL && deviceData.battery_health_state === 0
        ? this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
        : this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW,
    );

    // Update smoke details
    // If Nest isn't online or removed from base, report in HomeKit
    this.smokeService.updateCharacteristic(
      this.hap.Characteristic.StatusActive,
      deviceData.online === true && deviceData.removed_from_base === false,
    );

    // General fault if replacement date past or Nest isn't online or removed from base
    this.smokeService.updateCharacteristic(
      this.hap.Characteristic.StatusFault,
      deviceData.online === true && deviceData.removed_from_base === false && Math.floor(Date.now() / 1000) <= deviceData.replacement_date
        ? this.hap.Characteristic.StatusFault.NO_FAULT
        : this.hap.Characteristic.StatusFault.GENERAL_FAULT,
    );

    this.smokeService.updateCharacteristic(
      this.hap.Characteristic.SmokeDetected,
      deviceData.smoke_status === 2
        ? this.hap.Characteristic.SmokeDetected.SMOKE_DETECTED
        : this.hap.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED,
    );

    if (deviceData.smoke_status !== 0 && this.deviceData.smoke_status === 0) {
      this?.log?.warn && this.log.warn('Smoke detected in "%s"', deviceData.description);
    }

    if (deviceData.smoke_status === 0 && this.deviceData.smoke_status !== 0) {
      this?.log?.info && this.log.info('Smoke is nolonger detected in "%s"', deviceData.description);
    }

    // Update carbon monoxide details
    // If Nest isn't online or removed from base, report in HomeKit
    this.carbonMonoxideService.updateCharacteristic(
      this.hap.Characteristic.StatusActive,
      deviceData.online === true && deviceData.removed_from_base === false,
    );

    // General fault if replacement date past or Nest isn't online or removed from base
    this.carbonMonoxideService.updateCharacteristic(
      this.hap.Characteristic.StatusFault,
      deviceData.online === true && deviceData.removed_from_base === false && Math.floor(Date.now() / 1000) <= deviceData.replacement_date
        ? this.hap.Characteristic.StatusFault.NO_FAULT
        : this.hap.Characteristic.StatusFault.GENERAL_FAULT,
    );

    this.carbonMonoxideService.updateCharacteristic(
      this.hap.Characteristic.CarbonMonoxideDetected,
      deviceData.co_status === 2
        ? this.hap.Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL
        : this.hap.Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL,
    );

    if (deviceData.co_status !== 0 && this.deviceData.co_status === 0) {
      this?.log?.warn && this.log.warn('Abnormal carbon monoxide levels detected in "%s"', deviceData.description);
    }

    if (deviceData.co_status === 0 && this.deviceData.co_status !== 0) {
      this?.log?.info && this.log.info('Carbon monoxide levels have returned to normal in "%s"', deviceData.description);
    }

    // Update motion service if present
    if (this.motionService !== undefined) {
      // Motion detect if auto_away = false. Not supported on battery powered Nest Protects
      // If Nest isn't online or removed from base, report in HomeKit
      this.motionService.updateCharacteristic(
        this.hap.Characteristic.StatusActive,
        deviceData.online === true && deviceData.removed_from_base === false,
      );

      // General fault if replacement date past or Nest isn't online or removed from base
      this.motionService.updateCharacteristic(
        this.hap.Characteristic.StatusFault,
        deviceData.online === true && deviceData.removed_from_base === false && Math.floor(Date.now() / 1000) <= deviceData.replacement_date
          ? this.hap.Characteristic.StatusFault.NO_FAULT
          : this.hap.Characteristic.StatusFault.GENERAL_FAULT,
      );

      this.motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, deviceData.detected_motion === false);

      // Log motion to history only if changed to previous recording
      if (deviceData.detected_motion !== this.deviceData.detected_motion && typeof this.historyService?.addHistory === 'function') {
        this.historyService.addHistory(this.motionService, {
          time: Math.floor(Date.now() / 1000),
          status: deviceData.detected_motion === true ? 1 : 0,
        });
      }
    }

    // Notify Eve App of device status changes if linked
    if (this.deviceData.eveHistory === true && typeof this.historyService?.updateEveHome === 'function') {
      // Update our internal data with properties Eve will need to process
      this.deviceData.latest_alarm_test = deviceData.latest_alarm_test;
      this.deviceData.self_test_in_progress = deviceData.self_test_in_progress;
      this.deviceData.heat_status = deviceData.heat_status;
      this.deviceData.ntp_green_led_enable = deviceData.ntp_green_led_enable;
      this.deviceData.smoke_test_passed = deviceData.smoke_test_passed;
      this.deviceData.heat_test_passed = deviceData.heat_test_passed;
      this.historyService.updateEveHome(this.smokeService, this.#EveHomeGetcommand.bind(this));
    }
  }

  #EveHomeGetcommand(EveHomeGetData) {
    // Pass back extra data for Eve Smoke this.hap.CharacteristicEventTypes.GET process command
    // Data will already be an object, our only job is to add/modify to it
    if (typeof EveHomeGetData === 'object') {
      EveHomeGetData.lastalarmtest = this.deviceData.latest_alarm_test;
      EveHomeGetData.alarmtest = this.deviceData.self_test_in_progress;
      EveHomeGetData.heatstatus = this.deviceData.heat_status;
      EveHomeGetData.statusled = this.deviceData.ntp_green_led_enable;
      EveHomeGetData.smoketestpassed = this.deviceData.smoke_test_passed;
      EveHomeGetData.heattestpassed = this.deviceData.heat_test_passed;
      EveHomeGetData.hushedstate = this.deviceData.hushed_state;
    }
    return EveHomeGetData;
  }

  #EveHomeSetcommand(EveHomeSetData) {
    if (typeof EveHomeSetData !== 'object') {
      return;
    }

    if (typeof EveHomeSetData?.alarmtest === 'boolean') {
      //this.log.info('Eve Smoke Alarm test', (EveHomeSetData.alarmtest === true ? 'start' : 'stop'));
    }
    if (typeof EveHomeSetData?.statusled === 'boolean') {
      this.set({ ntp_green_led_enable: EveHomeSetData.statusled });
    }
  }
}
