// Nest 'virtual' weather station
// Part of homebridge-nest-accfactory
//
// Code version 17/8/2024
// Mark Hulskamp
'use strict';

// Define our modules
import HomeKitDevice from './HomeKitDevice.js';
import HAP from 'hap-nodejs';

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
        if (typeof HAP.Service?.EveAirPressureSensor === 'object') {
            this.airPressureService = this.accessory.getService(HAP.Service.EveAirPressureSensor);
            if (this.airPressureService === undefined) {
                this.airPressureService = this.accessory.addService(HAP.Service.EveAirPressureSensor, '', 1);
            }
        }

        if (typeof HAP.Characteristic?.ForecastDay === 'object' &&
            this.temperatureService.testCharacteristic(HAP.Characteristic.ForecastDay) === false) {

            this.temperatureService.addCharacteristic(HAP.Characteristic.ForecastDay);
        }
        if (typeof HAP.Characteristic?.ObservationStation === 'object' &&
            this.temperatureService.testCharacteristic(HAP.Characteristic.ObservationStation) === false) {

            this.temperatureService.addCharacteristic(HAP.Characteristic.ObservationStation);
        }
        if (typeof HAP.Characteristic?.Condition === 'object' &&
            this.temperatureService.testCharacteristic(HAP.Characteristic.Condition) === false) {

            this.temperatureService.addCharacteristic(HAP.Characteristic.Condition);
        }
        if (typeof HAP.Characteristic?.WindDirection === 'object' &&
            this.temperatureService.testCharacteristic(HAP.Characteristic.WindDirection) === false) {

            this.temperatureService.addCharacteristic(HAP.Characteristic.WindDirection);
        }
        if (typeof HAP.Characteristic?.WindSpeed === 'object' &&
            this.temperatureService.testCharacteristic(HAP.Characteristic.WindSpeed) === false) {

            this.temperatureService.addCharacteristic(HAP.Characteristic.WindSpeed);
        }
        if (typeof HAP.Characteristic?.SunriseTime === 'object' &&
            this.temperatureService.testCharacteristic(HAP.Characteristic.SunriseTime) === false) {

            this.temperatureService.addCharacteristic(HAP.Characteristic.SunriseTime);
        }
        if (typeof HAP.Characteristic?.SunsetTime === 'object' &&
            this.temperatureService.testCharacteristic(HAP.Characteristic.SunsetTime) === false) {

            this.temperatureService.addCharacteristic(HAP.Characteristic.SunsetTime);
        }

        // Setup linkage to EveHome app if configured todo so
        if (this.deviceData?.eveApp === true &&
            this.airPressureService !== undefined &&
            typeof this.historyService?.linkToEveHome === 'function') {

            this.historyService.linkToEveHome(this.accessory, this.airPressureService, {
                description: this.deviceData.description,
            });
        }
    }

    updateServices(deviceData) {
        if (typeof deviceData !== 'object' ||
            this.temperatureService === undefined ||
            this.humidityService === undefined ||
            this.batteryService === undefined ) {

            return;
        }

        this.temperatureService.updateCharacteristic(this.hap.Characteristic.CurrentTemperature, deviceData.current_temperature);

        this.batteryService.updateCharacteristic(this.hap.Characteristic.BatteryLevel, 100);
        this.batteryService.updateCharacteristic(this.hap.Characteristic.StatusLowBattery, this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
        this.batteryService.updateCharacteristic(this.hap.Characteristic.ChargingState, this.hap.Characteristic.ChargingState.NOT_CHARGEABLE);

        this.humidityService.updateCharacteristic(this.hap.Characteristic.CurrentRelativeHumidity, deviceData.current_humidity);

        if (this.airPressureService !== undefined) {
            //this.airPressureService.updateCharacteristic(HAP.Characteristic.EveAirPressure, 0);   // Where from??
            this.airPressureService.updateCharacteristic(HAP.Characteristic.EveElevation, deviceData.elevation);
        }

        // Update custom characteristics if present on the accessory
        if (typeof HAP.Characteristic?.ForecastDay === 'object' &&
            this.temperatureService.testCharacteristic(HAP.Characteristic.ForecastDay) === true &&
            this.deviceData?.forecast !== undefined) {

            this.temperatureService.updateCharacteristic(HAP.Characteristic.ForecastDay, deviceData.forecast);
        }
        if (typeof HAP.Characteristic?.ObservationStation === 'object' &&
            this.temperatureService.testCharacteristic(HAP.Characteristic.ObservationStation) === true &&
            this.deviceData?.station !== undefined) {

            this.temperatureService.updateCharacteristic(HAP.Characteristic.ObservationStation, deviceData.station);
        }
        if (typeof HAP.Characteristic?.Condition === 'object' &&
            this.temperatureService.testCharacteristic(HAP.Characteristic.Condition) === true &&
            this.deviceData?.condition !== undefined) {

            this.temperatureService.updateCharacteristic(HAP.Characteristic.Condition, deviceData.condition);
        }
        if (typeof HAP.Characteristic?.WindDirection === 'object' &&
            this.temperatureService.testCharacteristic(HAP.Characteristic.WindDirection) === true &&
            this.deviceData?.wind_direction !== undefined) {

            this.temperatureService.updateCharacteristic(HAP.Characteristic.WindDirection, deviceData.wind_direction);
        }
        if (typeof HAP.Characteristic?.WindSpeed === 'object' &&
            this.temperatureService.testCharacteristic(HAP.Characteristic.WindSpeed) === true &&
            this.deviceData?.wind_speed !== undefined) {

            this.temperatureService.updateCharacteristic(HAP.Characteristic.WindSpeed, deviceData.wind_speed);
        }
        if (typeof HAP.Characteristic?.SunriseTime === 'object' &&
            this.temperatureService.testCharacteristic(HAP.Characteristic.SunriseTime) === true &&
            this.deviceData?.sunrise !== undefined) {

            let dateString = new Date(deviceData.sunrise * 1000).toLocaleTimeString();
            this.temperatureService.updateCharacteristic(HAP.Characteristic.SunriseTime, dateString);
        }
        if (typeof HAP.Characteristic?.SunsetTime === 'object' &&
            this.temperatureService.testCharacteristic(HAP.Characteristic.SunsetTime) === true &&
            this.deviceData?.sunset !== undefined) {

            let dateString = new Date(deviceData.sunset * 1000).toLocaleTimeString();
            this.temperatureService.updateCharacteristic(HAP.Characteristic.SunsetTime, dateString);
        }

        // If we have the history service running, record temperature and humity every 5mins
        if (this.airPressureService !== undefined &&
            typeof this.historyService?.addHistory === 'function') {

            this.historyService.addHistory(this.airPressureService, {
                'time': Math.floor(Date.now() / 1000),
                'temperature': deviceData.current_temperature,
                'humidity': deviceData.current_humidity,
                'pressure': 0,
            }, 300);
        }
    }
}