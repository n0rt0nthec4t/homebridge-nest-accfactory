// Nest 'virtual' weather station
// Part of homebridge-nest-accfactory
//
// Code version 28/8/2024
// Mark Hulskamp
'use strict';

// Define our modules
import HomeKitDevice from './HomeKitDevice.js';

export default class NestWeather extends HomeKitDevice {
  batteryService = undefined;
  airPressureService = undefined;
  temperatureService = undefined;
  humidityService = undefined;

  constructor(accessory, api, log, eventEmitter, deviceData) {
    super(accessory, api, log, eventEmitter, deviceData);
  }

  // Class functions
  addServices() {
    // Setup temperature service if not already present on the accessory
    this.temperatureService = this.accessory.getService(this.hap.Service.TemperatureSensor);
    if (this.temperatureService === undefined) {
      this.temperatureService = this.accessory.addService(this.hap.Service.TemperatureSensor, '', 1);
    }
    this.temperatureService.setPrimaryService();

    // Setup humidity service if not already present on the accessory
    this.humidityService = this.accessory.getService(this.hap.Service.HumiditySensor);
    if (this.humidityService === undefined) {
      this.humidityService = this.accessory.addService(this.hap.Service.HumiditySensor, '', 1);
    }

    // Setup battery service if not already present on the accessory
    this.batteryService = this.accessory.getService(this.hap.Service.Battery);
    if (this.batteryService === undefined) {
      this.batteryService = this.accessory.addService(this.hap.Service.Battery, '', 1);
    }
    this.batteryService.setHiddenService(true);

    // Add custom weather service and characteristics if they have been defined
    if (this.hap.Service?.EveAirPressureSensor !== undefined) {
      this.airPressureService = this.accessory.getService(this.hap.Service.EveAirPressureSensor);
      if (this.airPressureService === undefined) {
        this.airPressureService = this.accessory.addService(this.hap.Service.EveAirPressureSensor, '', 1);
      }
    }

    if (
      this.hap.Characteristic?.ForecastDay !== undefined &&
      this.temperatureService.testCharacteristic(this.hap.Characteristic.ForecastDay) === false
    ) {
      this.temperatureService.addCharacteristic(this.hap.Characteristic.ForecastDay);
    }
    if (
      this.hap.Characteristic?.ObservationStation !== undefined &&
      this.temperatureService.testCharacteristic(this.hap.Characteristic.ObservationStation) === false
    ) {
      this.temperatureService.addCharacteristic(this.hap.Characteristic.ObservationStation);
    }
    if (
      this.hap.Characteristic?.Condition !== undefined &&
      this.temperatureService.testCharacteristic(this.hap.Characteristic.Condition) === false
    ) {
      this.temperatureService.addCharacteristic(this.hap.Characteristic.Condition);
    }
    if (
      this.hap.Characteristic?.WindDirection !== undefined &&
      this.temperatureService.testCharacteristic(this.hap.Characteristic.WindDirection) === false
    ) {
      this.temperatureService.addCharacteristic(this.hap.Characteristic.WindDirection);
    }
    if (
      this.hap.Characteristic?.WindSpeed !== undefined &&
      this.temperatureService.testCharacteristic(this.hap.Characteristic.WindSpeed) === false
    ) {
      this.temperatureService.addCharacteristic(this.hap.Characteristic.WindSpeed);
    }
    if (
      this.hap.Characteristic?.SunriseTime !== undefined &&
      this.temperatureService.testCharacteristic(this.hap.Characteristic.SunriseTime) === false
    ) {
      this.temperatureService.addCharacteristic(this.hap.Characteristic.SunriseTime);
    }
    if (
      this.hap.Characteristic?.SunsetTime !== undefined &&
      this.temperatureService.testCharacteristic(this.hap.Characteristic.SunsetTime) === false
    ) {
      this.temperatureService.addCharacteristic(this.hap.Characteristic.SunsetTime);
    }

    // Setup linkage to EveHome app if configured todo so
    if (
      this.deviceData?.eveHistory === true &&
      this.airPressureService !== undefined &&
      typeof this.historyService?.linkToEveHome === 'function'
    ) {
      this.historyService.linkToEveHome(this.airPressureService, {
        description: this.deviceData.description,
      });
    }

    // Create extra details for output
    let postSetupDetails = [];
    this.deviceData?.elevation !== undefined && postSetupDetails.push('Elevation of ' + this.deviceData.elevation + 'm');

    return postSetupDetails;
  }

  updateServices(deviceData) {
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
      //this.airPressureService.updateCharacteristic(this.hap.Characteristic.EveAirPressure, 0);   // Where from??
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
    if (this.airPressureService !== undefined && typeof this.historyService?.addHistory === 'function') {
      this.historyService.addHistory(
        this.airPressureService,
        {
          time: Math.floor(Date.now() / 1000),
          temperature: deviceData.current_temperature,
          humidity: deviceData.current_humidity,
          pressure: 0,
        },
        300,
      );
    }
  }
}
