// Nest Weather Station - HomeKit integration
// Part of homebridge-nest-accfactory
//
// Virtual HomeKit accessory representing weather data for a Nest/Google structure.
// Provides temperature, humidity, and optional environmental data using
// location-based weather information from upstream APIs.
//
// Responsibilities:
// - Create a virtual weather accessory per structure with available weather data
// - Expose temperature and humidity via HomeKit services
// - Optionally expose air pressure and elevation (Eve Home support)
// - Poll and refresh weather data at regular intervals
// - Record environmental history for Eve Home integration
//
// Services:
// - TemperatureSensor (primary service with Eve characteristics)
// - HumiditySensor
// - Battery (hidden, required for Eve Home support)
// - EveAirPressureSensor (optional, when supported by HAP)
//
// Features:
// - Periodic polling of upstream weather data (Nest / Google APIs)
// - Real-time HomeKit characteristic updates
// - Eve Home custom characteristics (forecast, condition, wind, sunrise/sunset)
// - Temperature normalisation and unit handling
// - History recording for temperature and humidity trends
//
// Notes:
// - This is a virtual device (not a physical Nest device)
// - One weather accessory is created per structure/home
// - Requires both location and weather data to be available
// - Google and Nest API data are both supported and normalised
//
// Data Translation:
// - Raw data is mapped using WEATHER_FIELD_MAP
// - processRawData() builds virtual devices from structure-level data
// - Nest and Google sources are normalised into a unified HomeKit model
// - Serial number is derived from structure ID for consistent deduplication
//
// Mark Hulskamp
'use strict';

// Define our modules
import HomeKitDevice from '../HomeKitDevice.js';
import { adjustTemperature, crc24 } from '../utils.js';
import { buildMappedObject, createMappingContext } from '../translator.js';

// Define constants
import { DATA_SOURCE, DEVICE_TYPE, MAX_ELEVATION, MIN_ELEVATION, NESTLABS_MAC_PREFIX, TIMERS } from '../consts.js';

export default class NestWeather extends HomeKitDevice {
  static TYPE = 'Weather';
  static VERSION = '2026.04.15'; // Code version

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

// Weather field translation map
// Maps raw source data -> normalised weather device fields
// - fields: top-level raw fields this mapping depends on (for delta updates)
// - translate: converts raw -> candidate value
// - merge: combines source values into the final normalised value
const WEATHER_FIELD_MAP = {
  // Identity fields
  serialNumber: {
    required: true,
    google: {
      fields: ['structure_info'],
      translate: ({ raw }) =>
        typeof raw?.value?.structure_info?.rtsStructureId === 'string' && raw.value.structure_info.rtsStructureId.trim() !== ''
          ? NESTLABS_MAC_PREFIX + crc24(raw.value.structure_info.rtsStructureId.trim().toUpperCase()).toUpperCase()
          : undefined,
    },
    nest: {
      fields: [],
      translate: ({ objectKey }) => NESTLABS_MAC_PREFIX + crc24(objectKey.toUpperCase()).toUpperCase(),
    },
  },

  nest_google_device_uuid: {
    required: true,
    google: {
      fields: [],
      translate: ({ objectKey }) => objectKey,
    },
    nest: {
      fields: [],
      translate: ({ objectKey }) => objectKey,
    },
  },

  nest_google_home_uuid: {
    required: true,
    google: {
      fields: [],
      translate: ({ objectKey }) => objectKey,
    },
    nest: {
      fields: [],
      translate: ({ objectKey }) => objectKey,
    },
  },

  // Naming / descriptive fields
  description: {
    required: true,
    merge: ({ values }) =>
      HomeKitDevice.makeValidHKName(
        typeof values?.google === 'string' && values.google.trim() !== ''
          ? values.google.trim()
          : typeof values?.nest === 'string' && values.nest.trim() !== ''
            ? values.nest.trim()
            : 'unknown description',
      ),
    google: {
      fields: ['structure_location', 'structure_info'],
      translate: ({ raw }) =>
        (raw?.value?.structure_location?.city?.value?.trim() ?? '') !== '' &&
        (raw?.value?.structure_location?.state?.value?.trim() ?? '') !== ''
          ? raw.value.structure_location.city.value.trim() + ' - ' + raw.value.structure_location.state.value.trim()
          : (raw?.value?.structure_info?.name?.trim() ?? '') !== ''
              ? raw.value.structure_info.name.trim()
              : undefined,
    },
    nest: {
      fields: ['city', 'state', 'name'],
      translate: ({ raw }) =>
        (raw?.value?.city?.trim() ?? '') !== '' && (raw?.value?.state?.trim() ?? '') !== ''
          ? raw.value.city.trim() + ' - ' + raw.value.state.trim()
          : (raw?.value?.name?.trim() ?? '') !== ''
              ? raw.value.name.trim()
              : undefined,
    },
  },

  // Core required weather fields
  current_temperature: {
    required: true,
    google: {
      fields: ['weather'],
      translate: ({ raw }) =>
        isNaN(raw?.value?.weather?.current_temperature) === false
          ? adjustTemperature(Number(raw.value.weather.current_temperature), 'C', 'C', true)
          : undefined,
    },
    nest: {
      fields: ['weather'],
      translate: ({ raw }) =>
        isNaN(raw?.value?.weather?.current_temperature) === false
          ? adjustTemperature(Number(raw.value.weather.current_temperature), 'C', 'C', true)
          : undefined,
    },
  },

  current_humidity: {
    required: true,
    google: {
      fields: ['weather'],
      translate: ({ raw }) =>
        isNaN(raw?.value?.weather?.current_humidity) === false ? Number(raw.value.weather.current_humidity) : undefined,
    },
    nest: {
      fields: ['weather'],
      translate: ({ raw }) =>
        isNaN(raw?.value?.weather?.current_humidity) === false ? Number(raw.value.weather.current_humidity) : undefined,
    },
  },

  // Optional weather detail fields
  condition: {
    google: {
      fields: ['weather'],
      translate: ({ raw }) => ((raw?.value?.weather?.condition?.trim() ?? '') !== '' ? raw.value.weather.condition.trim() : undefined),
    },
    nest: {
      fields: ['weather'],
      translate: ({ raw }) => ((raw?.value?.weather?.condition?.trim() ?? '') !== '' ? raw.value.weather.condition.trim() : undefined),
    },
  },

  wind_direction: {
    google: {
      fields: ['weather'],
      translate: ({ raw }) =>
        (raw?.value?.weather?.wind_direction?.trim() ?? '') !== '' ? raw.value.weather.wind_direction.trim() : undefined,
    },
    nest: {
      fields: ['weather'],
      translate: ({ raw }) =>
        (raw?.value?.weather?.wind_direction?.trim() ?? '') !== '' ? raw.value.weather.wind_direction.trim() : undefined,
    },
  },

  wind_speed: {
    google: {
      fields: ['weather'],
      translate: ({ raw }) => (isNaN(raw?.value?.weather?.wind_speed) === false ? Number(raw.value.weather.wind_speed) : undefined),
    },
    nest: {
      fields: ['weather'],
      translate: ({ raw }) => (isNaN(raw?.value?.weather?.wind_speed) === false ? Number(raw.value.weather.wind_speed) : undefined),
    },
  },

  sunrise: {
    google: {
      fields: ['weather'],
      translate: ({ raw }) => (isNaN(raw?.value?.weather?.sunrise) === false ? Number(raw.value.weather.sunrise) : undefined),
    },
    nest: {
      fields: ['weather'],
      translate: ({ raw }) => (isNaN(raw?.value?.weather?.sunrise) === false ? Number(raw.value.weather.sunrise) : undefined),
    },
  },

  sunset: {
    google: {
      fields: ['weather'],
      translate: ({ raw }) => (isNaN(raw?.value?.weather?.sunset) === false ? Number(raw.value.weather.sunset) : undefined),
    },
    nest: {
      fields: ['weather'],
      translate: ({ raw }) => (isNaN(raw?.value?.weather?.sunset) === false ? Number(raw.value.weather.sunset) : undefined),
    },
  },

  station: {
    google: {
      fields: ['weather'],
      translate: ({ raw }) => ((raw?.value?.weather?.station?.trim() ?? '') !== '' ? raw.value.weather.station.trim() : undefined),
    },
    nest: {
      fields: ['weather'],
      translate: ({ raw }) => ((raw?.value?.weather?.station?.trim() ?? '') !== '' ? raw.value.weather.station.trim() : undefined),
    },
  },

  forecast: {
    google: {
      fields: ['weather'],
      translate: ({ raw }) => ((raw?.value?.weather?.forecast?.trim() ?? '') !== '' ? raw.value.weather.forecast.trim() : undefined),
    },
    nest: {
      fields: ['weather'],
      translate: ({ raw }) => ((raw?.value?.weather?.forecast?.trim() ?? '') !== '' ? raw.value.weather.forecast.trim() : undefined),
    },
  },
};

// Function to process our RAW source data for this device type
// eslint-disable-next-line no-unused-vars
export function processRawData(log, rawData, config, deviceType = undefined, changedData = undefined) {
  if (
    rawData === null ||
    typeof rawData !== 'object' ||
    rawData?.constructor !== Object ||
    typeof config !== 'object' ||
    config?.constructor !== Object
  ) {
    return;
  }

  // Only store partial data if nothing has already been stored for this serial in this pass.
  // A later full payload will replace an earlier partial payload.
  let devices = {};

  Object.entries(rawData)
    .filter(([key]) => key.startsWith('structure.') === true || key.startsWith('STRUCTURE_') === true)
    .forEach(([object_key, value]) => {
      try {
        // Map raw structure data into our normalised weather schema
        let mappedResult = buildMappedObject(
          WEATHER_FIELD_MAP,
          createMappingContext(rawData, object_key, {
            nest: value?.source === DATA_SOURCE.NEST ? value : undefined,
            google: value?.source === DATA_SOURCE.GOOGLE ? value : undefined,
          }),
          changedData instanceof Map ? changedData.get(object_key)?.fields : undefined,
        );

        let serialNumber = mappedResult?.data?.serialNumber;
        let existingDevice = devices[serialNumber];

        // If we have all required fields, build a full weather device
        if (mappedResult?.hasRequired === true) {
          let tempDevice = {
            type: DEVICE_TYPE.WEATHER,
            model: 'Weather',
            manufacturer: 'Nest',
            softwareVersion: NestWeather.VERSION, // Use class version for consistency
            ...mappedResult.data,
          };

          // Lookup device-specific and home-level configuration
          let deviceOptions = config?.devices?.find(
            (device) => device?.serialNumber?.toUpperCase?.() === tempDevice?.serialNumber?.toUpperCase?.(),
          );

          let homeOptions = config?.homes?.find(
            (home) =>
              home?.nest_home_uuid?.toUpperCase?.() === tempDevice?.nest_google_home_uuid?.toUpperCase?.() ||
              home?.google_home_uuid?.toUpperCase?.() === tempDevice?.nest_google_home_uuid?.toUpperCase?.(),
          );

          // Apply Eve history setting (device overrides global)
          tempDevice.eveHistory =
            deviceOptions?.eveHistory !== undefined ? deviceOptions.eveHistory === true : config?.options?.eveHistory === true;

          // Apply elevation (validated, fallback to minimum if invalid)
          tempDevice.elevation =
            isNaN(homeOptions?.elevation) === false &&
            Number(homeOptions.elevation) >= MIN_ELEVATION &&
            Number(homeOptions.elevation) <= MAX_ELEVATION
              ? Number(homeOptions.elevation)
              : MIN_ELEVATION;

          // Determine exclusion state
          // Priority:
          // 1. Weather disabled at home level (hard exclude)
          // 2. Device explicitly excluded
          // 3. Device not explicitly included AND (home excluded OR global excluded)
          tempDevice.excluded =
            homeOptions?.weather !== true ||
            deviceOptions?.exclude === true ||
            (deviceOptions?.exclude !== false &&
              (homeOptions?.exclude === true || (homeOptions?.exclude !== false && config?.options?.exclude === true)));

          // Store full device
          // Full always overrides partial if present
          if (existingDevice?.full !== true) {
            devices[tempDevice.serialNumber] = {
              full: true,
              data: tempDevice,
            };
          }
        }

        // Refresh existing device reference after potential full insert
        existingDevice = devices[serialNumber];

        // If we only have partial data (no required fields yet), store partial
        // Only if we don't already have a full or partial device
        if (
          mappedResult?.hasRequired === false &&
          serialNumber !== undefined &&
          typeof mappedResult?.data === 'object' &&
          mappedResult.data?.constructor === Object &&
          Object.keys(mappedResult.data).length !== 0 &&
          existingDevice === undefined
        ) {
          devices[serialNumber] = {
            full: false,
            data: mappedResult.data,
          };
        }
      } catch (error) {
        log?.error?.('Error processing weather data for object "%s": %s', object_key, String(error));
      }
    });

  return devices;
}
