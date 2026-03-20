// Nest weather station - virtual accessory for HomeKit
// Part of homebridge-nest-accfactory
//
// Creates a virtual weather station accessory from Nest/Google location and weather data.
// Exposes temperature, humidity, and optional air pressure/elevation via HomeKit services.
//
// Services:
// - TemperatureSensor (primary service with custom Eve characteristics)
// - HumiditySensor
// - Battery (hidden, required for Eve Home support)
// - EveAirPressureSensor (optional, if available in HAP)
//
// Custom Eve characteristics: ForecastDay, ObservationStation, Condition, WindDirection,
// WindSpeed, SunriseTime, SunsetTime
//
// Data processing:
// - Translates raw Nest and Google API structures into unified HomeKit format
// - Field mapping decouples API changes from HomeKit presentation
// - Polling timer fetches fresh weather data from remote API
// - History recording enabled for temperature and humidity trends
//
// Mark Hulskamp
'use strict';

// Define our modules
import HomeKitDevice from '../HomeKitDevice.js';
import { processCommonData, adjustTemperature, crc24 } from '../utils.js';
import { buildMappedObject, createMappingContext } from '../translator.js';

// Define constants
import { DATA_SOURCE, DEVICE_TYPE, MAX_ELEVATION, MIN_ELEVATION, NESTLABS_MAC_PREFIX, TIMERS } from '../consts.js';

export default class NestWeather extends HomeKitDevice {
  static TYPE = 'Weather';
  static VERSION = '2026.03.21'; // Code version

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

    // Setup battery service if not already present on the accessory (required for EveHome support)
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

    // Setup repeat polling for weather data updates
    this.addTimer(TIMERS.WEATHER.name, { interval: TIMERS.WEATHER.interval });
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
      deviceData?.constructor !== Object ||
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
      deviceData?.forecast !== undefined
    ) {
      this.temperatureService.updateCharacteristic(this.hap.Characteristic.ForecastDay, deviceData.forecast);
    }
    if (
      this.hap.Characteristic?.ObservationStation !== undefined &&
      this.temperatureService.testCharacteristic(this.hap.Characteristic.ObservationStation) === true &&
      deviceData?.station !== undefined
    ) {
      this.temperatureService.updateCharacteristic(this.hap.Characteristic.ObservationStation, deviceData.station);
    }
    if (
      this.hap.Characteristic?.Condition !== undefined &&
      this.temperatureService.testCharacteristic(this.hap.Characteristic.Condition) === true &&
      deviceData?.condition !== undefined
    ) {
      this.temperatureService.updateCharacteristic(this.hap.Characteristic.Condition, deviceData.condition);
    }
    if (
      this.hap.Characteristic?.WindDirection !== undefined &&
      this.temperatureService.testCharacteristic(this.hap.Characteristic.WindDirection) === true &&
      deviceData?.wind_direction !== undefined
    ) {
      this.temperatureService.updateCharacteristic(this.hap.Characteristic.WindDirection, deviceData.wind_direction);
    }
    if (
      this.hap.Characteristic?.WindSpeed !== undefined &&
      this.temperatureService.testCharacteristic(this.hap.Characteristic.WindSpeed) === true &&
      deviceData?.wind_speed !== undefined
    ) {
      this.temperatureService.updateCharacteristic(this.hap.Characteristic.WindSpeed, deviceData.wind_speed);
    }
    if (
      this.hap.Characteristic?.SunriseTime !== undefined &&
      this.temperatureService.testCharacteristic(this.hap.Characteristic.SunriseTime) === true &&
      deviceData?.sunrise !== undefined
    ) {
      let dateString = new Date(deviceData.sunrise * 1000).toLocaleTimeString();
      this.temperatureService.updateCharacteristic(this.hap.Characteristic.SunriseTime, dateString);
    }
    if (
      this.hap.Characteristic?.SunsetTime !== undefined &&
      this.temperatureService.testCharacteristic(this.hap.Characteristic.SunsetTime) === true &&
      deviceData?.sunset !== undefined
    ) {
      let dateString = new Date(deviceData.sunset * 1000).toLocaleTimeString();
      this.temperatureService.updateCharacteristic(this.hap.Characteristic.SunsetTime, dateString);
    }

    // If we have the history service running, record temperature and humidity every 5mins
    this.history(
      this.airPressureService,
      { temperature: deviceData.current_temperature, humidity: deviceData.current_humidity, pressure: 0 },
      { timegap: 300, force: true },
    );
  }

  async onTimer(message) {
    if (typeof message !== 'object' || message?.timer !== TIMERS.WEATHER.name) {
      return;
    }

    let response = await this.get({ uuid: this.deviceData.nest_google_device_uuid, location_weather: true });
    if (typeof response?.location_weather === 'object' && Object.keys(response.location_weather).length > 0) {
      // Send updated weather data via UPDATE message to refresh characteristics
      this.update({
        current_temperature: response.location_weather.current_temperature,
        current_humidity: response.location_weather.current_humidity,
        condition: response.location_weather.condition,
        wind_direction: response.location_weather.wind_direction,
        wind_speed: response.location_weather.wind_speed,
        sunrise: response.location_weather.sunrise,
        sunset: response.location_weather.sunset,
        station: response.location_weather.station,
        forecast: response.location_weather.forecast,
      });
    }
  }
}

// Data translation functions for weather station data.
// We use this to translate RAW Nest and Google data into the format we want for our
// weather station device(s) using the field map below.
//
// This keeps all translation logic in one place and makes it easier to maintain as
// Nest and Google sources evolve over time.
//
// Field map conventions:
// - Return undefined for missing values rather than placeholder defaults
// - Let processRawData() decide if there is enough data to build the device
// - Let downstream code decide how to handle optional fields
//
// Weather field translation map
const WEATHER_FIELD_MAP = {
  // Identity fields
  serialNumber: {
    google: ({ sourceValue }) =>
      typeof sourceValue?.value?.structure_info?.rtsStructureId === 'string' &&
      sourceValue.value.structure_info.rtsStructureId.trim() !== ''
        ? NESTLABS_MAC_PREFIX + crc24(sourceValue.value.structure_info.rtsStructureId.trim().toUpperCase()).toUpperCase()
        : undefined,
    nest: ({ objectKey }) => NESTLABS_MAC_PREFIX + crc24(objectKey.toUpperCase()).toUpperCase(),
  },

  nest_google_device_uuid: {
    google: ({ objectKey }) => objectKey,
    nest: ({ objectKey }) => objectKey,
  },

  nest_google_home_uuid: {
    google: ({ objectKey }) => objectKey,
    nest: ({ objectKey }) => objectKey,
  },

  // Naming / descriptive fields
  description: {
    google: ({ sourceValue }) =>
      (sourceValue?.value?.structure_location?.city?.value?.trim() ?? '') !== '' &&
      (sourceValue?.value?.structure_location?.state?.value?.trim() ?? '') !== ''
        ? sourceValue.value.structure_location.city.value.trim() + ' - ' + sourceValue.value.structure_location.state.value.trim()
        : (sourceValue?.value?.structure_info?.name?.trim() ?? '') !== ''
            ? sourceValue.value.structure_info.name.trim()
            : undefined,
    nest: ({ sourceValue }) =>
      (sourceValue?.value?.city?.trim() ?? '') !== '' && (sourceValue?.value?.state?.trim() ?? '') !== ''
        ? sourceValue.value.city.trim() + ' - ' + sourceValue.value.state.trim()
        : (sourceValue?.value?.name?.trim() ?? '') !== ''
            ? sourceValue.value.name.trim()
            : undefined,
  },

  // Core required weather fields
  current_temperature: {
    google: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.weather?.current_temperature) === false
        ? adjustTemperature(Number(sourceValue.value.weather.current_temperature), 'C', 'C', true)
        : undefined,
    nest: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.weather?.current_temperature) === false
        ? adjustTemperature(Number(sourceValue.value.weather.current_temperature), 'C', 'C', true)
        : undefined,
  },

  current_humidity: {
    google: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.weather?.current_humidity) === false ? Number(sourceValue.value.weather.current_humidity) : undefined,
    nest: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.weather?.current_humidity) === false ? Number(sourceValue.value.weather.current_humidity) : undefined,
  },

  // Optional weather detail fields
  condition: {
    google: ({ sourceValue }) =>
      (sourceValue?.value?.weather?.condition?.trim() ?? '') !== '' ? sourceValue.value.weather.condition.trim() : undefined,
    nest: ({ sourceValue }) =>
      (sourceValue?.value?.weather?.condition?.trim() ?? '') !== '' ? sourceValue.value.weather.condition.trim() : undefined,
  },

  wind_direction: {
    google: ({ sourceValue }) =>
      (sourceValue?.value?.weather?.wind_direction?.trim() ?? '') !== '' ? sourceValue.value.weather.wind_direction.trim() : undefined,
    nest: ({ sourceValue }) =>
      (sourceValue?.value?.weather?.wind_direction?.trim() ?? '') !== '' ? sourceValue.value.weather.wind_direction.trim() : undefined,
  },

  wind_speed: {
    google: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.weather?.wind_speed) === false ? Number(sourceValue.value.weather.wind_speed) : undefined,
    nest: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.weather?.wind_speed) === false ? Number(sourceValue.value.weather.wind_speed) : undefined,
  },

  sunrise: {
    google: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.weather?.sunrise) === false ? Number(sourceValue.value.weather.sunrise) : undefined,
    nest: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.weather?.sunrise) === false ? Number(sourceValue.value.weather.sunrise) : undefined,
  },

  sunset: {
    google: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.weather?.sunset) === false ? Number(sourceValue.value.weather.sunset) : undefined,
    nest: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.weather?.sunset) === false ? Number(sourceValue.value.weather.sunset) : undefined,
  },

  station: {
    google: ({ sourceValue }) =>
      (sourceValue?.value?.weather?.station?.trim() ?? '') !== '' ? sourceValue.value.weather.station.trim() : undefined,
    nest: ({ sourceValue }) =>
      (sourceValue?.value?.weather?.station?.trim() ?? '') !== '' ? sourceValue.value.weather.station.trim() : undefined,
  },

  forecast: {
    google: ({ sourceValue }) =>
      (sourceValue?.value?.weather?.forecast?.trim() ?? '') !== '' ? sourceValue.value.weather.forecast.trim() : undefined,
    nest: ({ sourceValue }) =>
      (sourceValue?.value?.weather?.forecast?.trim() ?? '') !== '' ? sourceValue.value.weather.forecast.trim() : undefined,
  },
};

// Function to process our RAW Nest or Google for this device type
export function processRawData(log, rawData, config, deviceType = undefined) {
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
  // We use this to create virtual weather station(s) for each structure that has location and weather data
  let devices = {};

  Object.entries(rawData)
    .filter(([key]) => key.startsWith('structure.') === true || key.startsWith('STRUCTURE_') === true)
    .forEach(([object_key, value]) => {
      let tempDevice = {};

      try {
        let mappedData = buildMappedObject(
          WEATHER_FIELD_MAP,
          createMappingContext(
            rawData,
            object_key,
            value?.source === DATA_SOURCE.NEST ? value : undefined,
            value?.source === DATA_SOURCE.GOOGLE ? value : undefined,
          ),
        );

        if (
          mappedData.serialNumber !== undefined &&
          mappedData.nest_google_device_uuid !== undefined &&
          mappedData.nest_google_home_uuid !== undefined &&
          mappedData.description !== undefined &&
          mappedData.current_temperature !== undefined &&
          mappedData.current_humidity !== undefined
        ) {
          tempDevice = processCommonData(
            mappedData.nest_google_device_uuid,
            mappedData.nest_google_home_uuid,
            {
              type: DEVICE_TYPE.WEATHER,
              model: 'Weather',
              softwareVersion: NestWeather.VERSION, // We'll use our class version here now
              ...mappedData,
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
        let homeOptions = config?.homes?.find(
          (home) =>
            home?.nest_home_uuid?.toUpperCase?.() === tempDevice?.nest_google_home_uuid?.toUpperCase?.() ||
            home?.google_home_uuid?.toUpperCase?.() === tempDevice?.nest_google_home_uuid?.toUpperCase?.(),
        );

        // Insert any extra options we've read in from configuration file for this device or its associated home
        tempDevice.eveHistory =
          deviceOptions?.eveHistory !== undefined ? deviceOptions.eveHistory === true : config.options.eveHistory === true;

        tempDevice.elevation =
          isNaN(homeOptions?.elevation) === false &&
          Number(homeOptions.elevation) >= MIN_ELEVATION &&
          Number(homeOptions.elevation) <= MAX_ELEVATION
            ? Number(homeOptions.elevation)
            : MIN_ELEVATION; // Default to minimum elevation if not set or invalid

        // Process additional exclusion details based on weather station setting
        tempDevice.excluded = tempDevice.excluded === true;

        if (tempDevice.excluded !== true && homeOptions?.weather === true) {
          devices[tempDevice.serialNumber] = tempDevice; // Store processed device
        }
      }
    });

  return devices;
}
