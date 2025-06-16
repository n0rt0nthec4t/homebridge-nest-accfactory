// Nest Temperature Sensor
// Part of homebridge-nest-accfactory
//
// Mark Hulskamp
'use strict';

// Define our modules
import HomeKitDevice from '../HomeKitDevice.js';

const LOW_BATTERY_LEVEL = 10; // Low battery level percentage

export default class NestTemperatureSensor extends HomeKitDevice {
  static TYPE = 'TemperatureSensor';
  static VERSION = '2025.06.16';

  batteryService = undefined;
  temperatureService = undefined;

  constructor(accessory, api, log, eventEmitter, deviceData) {
    super(accessory, api, log, eventEmitter, deviceData);
  }

  // Class functions
  onAdd() {
    // Setup temperature service if not already present on the accessory
    this.temperatureService = this.addHKService(this.hap.Service.TemperatureSensor, '', 1);
    this.temperatureService.setPrimaryService();

    // Setup battery service if not already present on the accessory
    this.batteryService = this.addHKService(this.hap.Service.Battery, '', 1);
    this.batteryService.setHiddenService(true);

    // Setup linkage to EveHome app if configured todo so
    if (
      this.deviceData?.eveHistory === true &&
      this.temperatureService !== undefined &&
      typeof this.historyService?.linkToEveHome === 'function'
    ) {
      this.historyService.linkToEveHome(this.temperatureService, {
        description: this.deviceData.description,
      });
    }
  }

  onUpdate(deviceData) {
    if (typeof deviceData !== 'object' || this.temperatureService === undefined || this.batteryService === undefined) {
      return;
    }

    // If device isn't online report in HomeKit
    this.temperatureService.updateCharacteristic(
      this.hap.Characteristic.StatusFault,
      deviceData.online === true ? this.hap.Characteristic.StatusFault.NO_FAULT : this.hap.Characteristic.StatusFault.GENERAL_FAULT,
    );

    this.temperatureService.updateCharacteristic(this.hap.Characteristic.StatusActive, deviceData.online === true);
    if (typeof deviceData?.associated_thermostat === 'string' && deviceData.associated_thermostat !== '') {
      // This temperature sensor is assocated with a thermostat
      // Update status if providing active temperature for the thermostats
      this.temperatureService.updateCharacteristic(
        this.hap.Characteristic.StatusActive,
        deviceData.online === true && deviceData?.active_sensor === true,
      );
    }

    // Update temperature
    this.temperatureService.updateCharacteristic(this.hap.Characteristic.CurrentTemperature, deviceData.current_temperature);

    // Update battery level and status
    this.batteryService.updateCharacteristic(this.hap.Characteristic.BatteryLevel, deviceData.battery_level);
    this.batteryService.updateCharacteristic(
      this.hap.Characteristic.StatusLowBattery,
      deviceData.battery_level > LOW_BATTERY_LEVEL
        ? this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
        : this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW,
    );
    this.batteryService.updateCharacteristic(this.hap.Characteristic.ChargingState, this.hap.Characteristic.ChargingState.NOT_CHARGEABLE);

    // If we have the history service running and temperature has changed to previous in past 5mins
    if (
      deviceData.current_temperature !== this.deviceData.current_temperature &&
      this.temperatureService !== undefined &&
      typeof this.historyService?.addHistory === 'function'
    ) {
      this.historyService.addHistory(
        this.temperatureService,
        {
          time: Math.floor(Date.now() / 1000),
          temperature: deviceData.current_temperature,
        },
        300,
      );
    }
  }
}
