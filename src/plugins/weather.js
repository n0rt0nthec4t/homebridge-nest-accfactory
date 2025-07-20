// Nest 'virtual' weather station
// Part of homebridge-nest-accfactory
//
// Mark Hulskamp
'use strict';

// Define our modules
import HomeKitDevice from '../HomeKitDevice.js';

export default class NestWeather extends HomeKitDevice {
  static TYPE = 'Weather';
  static VERSION = '2025.07.13'; // Code version

  batteryService = undefined;
  airPressureService = undefined;
  temperatureService = undefined;
  humidityService = undefined;

  // Class functions
  onAdd() {
    // Setup temperature service if not already present on the accessory
    this.temperatureService = this.addHKService(this.hap.Service.TemperatureSensor, '', 1);
    this.temperatureService.setPrimaryService();

    // Setup humidity service if not already present on the accessory
    this.humidityService = this.addHKService(this.hap.Service.HumiditySensor, '', 1);

    // Setup battery service if not already present on the accessory
    this.batteryService = this.addHKService(this.hap.Service.Battery, '', 1);
    this.batteryService.setHiddenService(true);

    // Add custom weather service and characteristics if they have been defined
    if (this.hap.Service?.EveAirPressureSensor !== undefined) {
      // This will be linked to the Eve app if configured to do so
      this.airPressureService = this.addHKService(this.hap.Service.EveAirPressureSensor, '', 1, {});
    }

    if (this.hap.Characteristic?.ForecastDay !== undefined) {
      this.addHKCharacteristic(this.temperatureService, this.hap.Characteristic.ForecastDay);
    }
    if (this.hap.Characteristic?.ObservationStation !== undefined) {
      this.addHKCharacteristic(this.temperatureService, this.hap.Characteristic.ObservationStation);
    }
    if (this.hap.Characteristic?.Condition !== undefined) {
      this.addHKCharacteristic(this.temperatureService, this.hap.Characteristic.Condition);
    }
    if (this.hap.Characteristic?.WindDirection !== undefined) {
      this.addHKCharacteristic(this.temperatureService, this.hap.Characteristic.WindDirection);
    }
    if (this.hap.Characteristic?.WindSpeed !== undefined) {
      this.addHKCharacteristic(this.temperatureService, this.hap.Characteristic.WindSpeed);
    }
    if (this.hap.Characteristic?.SunriseTime !== undefined) {
      this.addHKCharacteristic(this.temperatureService, this.hap.Characteristic.SunriseTime);
    }
    if (this.hap.Characteristic?.SunsetTime !== undefined) {
      this.addHKCharacteristic(this.temperatureService, this.hap.Characteristic.SunsetTime);
    }

    // Extra setup details for output
    this.deviceData?.elevation !== undefined && this.postSetupDetail('Elevation of ' + this.deviceData.elevation + 'm');
  }

  onRemove() {
    this.accessory.removeService(this.temperatureService);
    this.accessory.removeService(this.humidityService);
    this.accessory.removeService(this.batteryService);
    this.accessory.removeService(this.airPressureService);
    this.temperatureService = undefined;
    this.humidityService = undefined;
    this.batteryService = undefined;
    this.airPressureService = undefined;
  }

  onUpdate(deviceData) {
    if (
      typeof deviceData !== 'object' ||
      this.temperatureService === undefined ||
      this.humidityService === undefined ||
      this.batteryService === undefined
    ) {
      return;
    }

    this.temperatureService.updateCharacteristic(this.hap.Characteristic.CurrentTemperature, deviceData.current_temperature);

    this.batteryService.updateCharacteristic(this.hap.Characteristic.BatteryLevel, 100);
    this.batteryService.updateCharacteristic(
      this.hap.Characteristic.StatusLowBattery,
      this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );
    this.batteryService.updateCharacteristic(this.hap.Characteristic.ChargingState, this.hap.Characteristic.ChargingState.NOT_CHARGEABLE);

    this.humidityService.updateCharacteristic(this.hap.Characteristic.CurrentRelativeHumidity, deviceData.current_humidity);

    if (this.airPressureService !== undefined) {
      // this.airPressureService.updateCharacteristic(this.hap.Characteristic.EveAirPressure, 0);   // Where from??
      this.airPressureService.updateCharacteristic(this.hap.Characteristic.EveElevation, deviceData.elevation);
    }

    // Update custom characteristics if present on the accessory
    if (
      this.hap.Characteristic?.ForecastDay !== undefined &&
      this.temperatureService.testCharacteristic(this.hap.Characteristic.ForecastDay) === true &&
      this.deviceData?.forecast !== undefined
    ) {
      this.temperatureService.updateCharacteristic(this.hap.Characteristic.ForecastDay, deviceData.forecast);
    }
    if (
      this.hap.Characteristic?.ObservationStation !== undefined &&
      this.temperatureService.testCharacteristic(this.hap.Characteristic.ObservationStation) === true &&
      this.deviceData?.station !== undefined
    ) {
      this.temperatureService.updateCharacteristic(this.hap.Characteristic.ObservationStation, deviceData.station);
    }
    if (
      this.hap.Characteristic?.Condition !== undefined &&
      this.temperatureService.testCharacteristic(this.hap.Characteristic.Condition) === true &&
      this.deviceData?.condition !== undefined
    ) {
      this.temperatureService.updateCharacteristic(this.hap.Characteristic.Condition, deviceData.condition);
    }
    if (
      this.hap.Characteristic?.WindDirection !== undefined &&
      this.temperatureService.testCharacteristic(this.hap.Characteristic.WindDirection) === true &&
      this.deviceData?.wind_direction !== undefined
    ) {
      this.temperatureService.updateCharacteristic(this.hap.Characteristic.WindDirection, deviceData.wind_direction);
    }
    if (
      this.hap.Characteristic?.WindSpeed !== undefined &&
      this.temperatureService.testCharacteristic(this.hap.Characteristic.WindSpeed) === true &&
      this.deviceData?.wind_speed !== undefined
    ) {
      this.temperatureService.updateCharacteristic(this.hap.Characteristic.WindSpeed, deviceData.wind_speed);
    }
    if (
      this.hap.Characteristic?.SunriseTime !== undefined &&
      this.temperatureService.testCharacteristic(this.hap.Characteristic.SunriseTime) === true &&
      this.deviceData?.sunrise !== undefined
    ) {
      let dateString = new Date(deviceData.sunrise * 1000).toLocaleTimeString();
      this.temperatureService.updateCharacteristic(this.hap.Characteristic.SunriseTime, dateString);
    }
    if (
      this.hap.Characteristic?.SunsetTime !== undefined &&
      this.temperatureService.testCharacteristic(this.hap.Characteristic.SunsetTime) === true &&
      this.deviceData?.sunset !== undefined
    ) {
      let dateString = new Date(deviceData.sunset * 1000).toLocaleTimeString();
      this.temperatureService.updateCharacteristic(this.hap.Characteristic.SunsetTime, dateString);
    }

    // If we have the history service running, record temperature and humity every 5mins
    this.history(
      this.airPressureService,
      { temperature: deviceData.current_temperature, humidity: deviceData.current_humidity, pressure: 0 },
      { timegap: 300, force: true },
    );
  }
}
