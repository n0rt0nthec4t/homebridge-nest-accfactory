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
  static VERSION = '2025.06.28'; // Code version

  batteryService = undefined;
  temperatureService = undefined;

  // Class functions
  onAdd() {
    // Setup temperature service if not already present on the accessory and link it to the Eve app if configured to do so
    this.temperatureService = this.addHKService(this.hap.Service.TemperatureSensor, '', 1, {});
    this.temperatureService.setPrimaryService();

    // Setup battery service if not already present on the accessory
    this.batteryService = this.addHKService(this.hap.Service.Battery, '', 1);
    this.batteryService.setHiddenService(true);
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
    this.history(
      this.temperatureService,
      {
        temperature: deviceData.current_temperature,
      },
      { timegap: 300, force: true },
    );
  }
}
