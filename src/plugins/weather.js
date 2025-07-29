// Nest 'virtual' weather station
// Part of homebridge-nest-accfactory
//
// Mark Hulskamp
'use strict';

// Define our modules
import HomeKitDevice from '../HomeKitDevice.js';
import { processCommonData, adjustTemperature, crc24 } from '../utils.js';

// Define constants
import { DATA_SOURCE, DEVICE_TYPE, NESTLABS_MAC_PREFIX } from '../consts.js';

export default class NestWeather extends HomeKitDevice {
  static TYPE = 'Weather';
  static VERSION = '2025.07.26'; // Code version

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

// Function to process our RAW Nest or Google for this device type
export function processRawData(log, rawData, config, deviceType = undefined, deviceUUID = undefined) {
  if (
    rawData === null ||
    typeof rawData !== 'object' ||
    rawData?.constructor !== Object ||
    typeof config !== 'object' ||
    config?.constructor !== Object
  ) {
    return;
  }

  // Process data for any structure(s) for both Nest and Protobuf API data
  // We use this to created virtual weather station(s) for each structure that has location data
  let devices = {};
  Object.entries(rawData)
    .filter(
      ([key]) =>
        (key.startsWith('structure.') === true || key.startsWith('STRUCTURE_') === true) &&
        (deviceUUID === undefined || deviceUUID === key) &&
        config?.options?.weather === true, // Only if weather enabled
    )
    .forEach(([object_key, value]) => {
      let tempDevice = {};
      try {
        if (
          value?.source === DATA_SOURCE.GOOGLE &&
          value.value?.structure_location !== undefined &&
          value.value?.structure_info?.rtsStructureId !== undefined &&
          value.value?.weather !== undefined
        ) {
          tempDevice = processCommonData(
            object_key,
            {
              type: DEVICE_TYPE.WEATHER,
              model: 'Weather',
              softwareVersion: '1.0.0',
              // Use the Nest API structure ID from the Protobuf structure. This will ensure we generate the same serial number
              // This should prevent two 'weather' objects being created
              serialNumber: NESTLABS_MAC_PREFIX + crc24(value.value.structure_info.rtsStructureId.toUpperCase()).toUpperCase(),
              description: String(
                (value.value?.structure_location?.city?.value ?? '') !== '' && (value.value?.structure_location?.state?.value ?? '') !== ''
                  ? value.value.structure_location.city.value + ' - ' + value.value.structure_location.state.value
                  : value.value.structure_info.name,
              ),
              postal_code: value.value?.structure_location?.postalCode.value ?? '',
              country_code: value.value?.structure_location?.countryCode.value ?? '',
              city: value.value?.structure_location?.city?.value ?? '',
              state: value.value?.structure_location?.state?.value ?? '',
              latitude: value.value?.structure_location?.geoCoordinate.latitude,
              longitude: value.value?.structure_location?.geoCoordinate.longitude,
              current_temperature: adjustTemperature(value.value.weather.current_temperature, 'C', 'C', true),
              current_humidity: value.value.weather.current_humidity,
              condition: value.value.weather.condition,
              wind_direction: value.value.weather.wind_direction,
              wind_speed: value.value.weather.wind_speed,
              sunrise: value.value.weather.sunrise,
              sunset: value.value.weather.sunset,
              station: value.value.weather.station,
              forecast: value.value.weather.forecast,
            },
            config,
          );
        }

        if (
          value?.source === DATA_SOURCE.NEST &&
          value.value?.latitude !== undefined &&
          value.value?.longitude !== undefined &&
          value.value?.weather !== undefined
        ) {
          tempDevice = processCommonData(
            object_key,
            {
              type: DEVICE_TYPE.WEATHER,
              model: 'Weather',
              softwareVersion: '1.0.0',
              serialNumber: NESTLABS_MAC_PREFIX + crc24(object_key.toUpperCase()).toUpperCase(),
              description: String(
                (value.value?.city ?? '') !== '' && (value.value?.state ?? '') !== ''
                  ? value.value.city + ' - ' + value.value.state
                  : value.value.name,
              ),
              postal_code: value.value?.postal_code ?? '',
              country_code: value.value?.country_code ?? '',
              city: value.value?.city ?? '',
              state: value.value?.state ?? '',
              latitude: value.value.latitude,
              longitude: value.value.longitude,
              current_temperature: adjustTemperature(value.value.weather.current_temperature, 'C', 'C', true),
              current_humidity: value.value.weather.current_humidity,
              condition: value.value.weather.condition,
              wind_direction: value.value.weather.wind_direction,
              wind_speed: value.value.weather.wind_speed,
              sunrise: value.value.weather.sunrise,
              sunset: value.value.weather.sunset,
              station: value.value.weather.station,
              forecast: value.value.weather.forecast,
            },
            config,
          );
        }
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        log?.debug?.('Error processing weather data for "%s"', object_key);
      }

      if (
        Object.entries(tempDevice).length !== 0 &&
        typeof devices[tempDevice.serialNumber] === 'undefined' &&
        (deviceType === undefined || (typeof deviceType === 'string' && deviceType !== '' && tempDevice.type === deviceType))
      ) {
        let deviceOptions = config?.devices?.find(
          (device) => device?.serialNumber?.toUpperCase?.() === tempDevice?.serialNumber?.toUpperCase?.(),
        );
        // Insert any extra options we've read in from configuration file for this device
        tempDevice.eveHistory = config.options.eveHistory === true || deviceOptions?.eveHistory === true;
        tempDevice.elevation =
          isNaN(deviceOptions?.elevation) === false && Number(deviceOptions?.elevation) >= 0 && Number(deviceOptions?.elevation) <= 8848
            ? Number(deviceOptions?.elevation)
            : config.options.elevation;
        devices[tempDevice.serialNumber] = tempDevice; // Store processed device
      }
    });

  return devices;
}
