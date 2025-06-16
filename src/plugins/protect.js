// Nest Protect
// Part of homebridge-nest-accfactory
//
// Mark Hulskamp
'use strict';

// Define our modules
import HomeKitDevice from '../HomeKitDevice.js';

const LOW_BATTERY_LEVEL = 10; // Low battery level percentage

export default class NestProtect extends HomeKitDevice {
  static TYPE = 'Protect';
  static VERSION = '2025.06.16';

  batteryService = undefined;
  smokeService = undefined;
  motionService = undefined;
  carbonMonoxideService = undefined;

  constructor(accessory, api, log, eventEmitter, deviceData) {
    super(accessory, api, log, eventEmitter, deviceData);
  }

  // Class functions
  onAdd() {
    // Setup the smoke sensor service if not already present on the accessory
    this.smokeService = this.addHKService(this.hap.Service.SmokeSensor, '', 1);
    this.smokeService.setPrimaryService();

    this.addHKCharacteristic(this.smokeService, this.hap.Characteristic.StatusActive);
    this.addHKCharacteristic(this.smokeService, this.hap.Characteristic.StatusFault);

    // Setup the carbon monoxide service if not already present on the accessory
    this.carbonMonoxideService = this.addHKService(this.hap.Service.CarbonMonoxideSensor, '', 1);

    // Setup battery service if not already present on the accessory
    this.batteryService = this.addHKService(this.hap.Service.Battery, '', 1);
    this.batteryService.setHiddenService(true);

    // Setup motion service if not already present on the accessory and Nest protect is a wired version
    if (this.deviceData?.wired_or_battery === 0) {
      this.motionService = this.addHKService(this.hap.Service.MotionSensor, '', 1);
      this.postSetupDetail('With motion sensor');
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
        Evesmoke_statusled: this.deviceData.ntp_green_led_enable,
        EveSmoke_smoketestpassed: this.deviceData.smoke_test_passed,
        EveSmoke_heattestpassed: this.deviceData.heat_test_passed,
      });
    }
  }

  onUpdate(deviceData) {
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
      deviceData.battery_level > LOW_BATTERY_LEVEL && deviceData.battery_health_state === 0
        ? this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
        : this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW,
    );
    this.batteryService.updateCharacteristic(this.hap.Characteristic.ChargingState, this.hap.Characteristic.ChargingState.NOT_CHARGEABLE);

    // Update smoke details
    // If protect isn't online, replacement date past, report in HomeKit
    this.smokeService.updateCharacteristic(
      this.hap.Characteristic.StatusActive,
      deviceData.online === true && Math.floor(Date.now() / 1000) <= deviceData.replacement_date,
    );

    this.smokeService.updateCharacteristic(
      this.hap.Characteristic.StatusFault,
      deviceData.online === true && Math.floor(Date.now() / 1000) <= deviceData.replacement_date
        ? this.hap.Characteristic.StatusFault.NO_FAULT
        : this.hap.Characteristic.StatusFault.GENERAL_FAULT,
    );

    this.smokeService.updateCharacteristic(
      this.hap.Characteristic.SmokeDetected,
      deviceData.smoke_status === true
        ? this.hap.Characteristic.SmokeDetected.SMOKE_DETECTED
        : this.hap.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED,
    );

    if (deviceData.smoke_status === true && this.deviceData.smoke_status === false) {
      this?.log?.warn?.('Smoke detected in "%s"', deviceData.description);
    }

    if (deviceData.smoke_status === false && this.deviceData.smoke_status === true) {
      this?.log?.info?.('Smoke is nolonger detected in "%s"', deviceData.description);
    }

    // Update carbon monoxide details
    this.carbonMonoxideService.updateCharacteristic(
      this.hap.Characteristic.CarbonMonoxideDetected,
      deviceData.co_status === true
        ? this.hap.Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL
        : this.hap.Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL,
    );

    if (deviceData.co_status === true && this.deviceData.co_status === false) {
      this?.log?.warn?.('Abnormal carbon monoxide levels detected in "%s"', deviceData.description);
    }

    if (deviceData.co_status === false && this.deviceData.co_status === true) {
      this?.log?.info?.('Carbon monoxide levels have returned to normal in "%s"', deviceData.description);
    }

    // Update self testing details
    if (deviceData.self_test_in_progress === true && this.deviceData.self_test_in_progress === false) {
      this?.log?.warn?.('Smoke and Carbon monoxide sensor testing has started in "%s"', deviceData.description);
    }

    if (deviceData.self_test_in_progress === false && this.deviceData.self_test_in_progress === true) {
      this?.log?.info?.('Smoke and Carbon monoxide sensor testing completed in "%s"', deviceData.description);
    }

    // Update motion service if present
    if (this.motionService !== undefined) {
      this.motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, deviceData.detected_motion === true);

      if (deviceData.detected_motion === true && this.deviceData.detected_motion === false) {
        this?.log?.info?.('Motion detected in "%s"', deviceData.description);
      }

      // Log motion to history only if changed to previous recording
      if (deviceData.detected_motion !== this.deviceData.detected_motion && typeof this.historyService?.addHistory === 'function') {
        this.historyService.addHistory(this.motionService, {
          time: Math.floor(Date.now() / 1000),
          status: deviceData.detected_motion === true ? 1 : 0,
        });
      }
    }

    // Notify Eve App of device status changes if linked
    if (
      this.deviceData.eveHistory === true &&
      this.smokeService !== undefined &&
      typeof this.historyService?.updateEveHome === 'function'
    ) {
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
    // Pass back extra data for Eve Smoke onGet() to process command
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
      //this?.log?.info?.('Eve Smoke Alarm test', (EveHomeSetData.alarmtest === true ? 'start' : 'stop'));
    }
    if (typeof EveHomeSetData?.statusled === 'boolean') {
      this.set({ uuid: this.deviceData.nest_google_uuid, ntp_green_led_enable: EveHomeSetData.statusled });
    }
  }
}
