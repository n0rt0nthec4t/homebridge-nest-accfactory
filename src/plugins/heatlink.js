// Nest HeatLink - HomeKit integration
// Part of homebridge-nest-accfactory
//
// HomeKit accessory implementation for Nest Heat Link devices.
// Provides hot water temperature control and/or boost heating control
// depending on device capabilities and configuration.
//
// Responsibilities:
// - Expose hot water temperature control via Thermostat service (when supported)
// - Expose hot water boost control via Switch service (when supported)
// - Synchronise temperature, heating state, and boost state with HomeKit
// - Route control changes to the associated Nest thermostat device
// - Record heating activity and temperature history for Eve Home integration
//
// Services:
// - Thermostat (optional, for hot water temperature control)
// - Switch (optional, for hot water boost control)
//
// Features:
// - Configurable temperature range (min/max per device)
// - Hot water boost with configurable duration (mapped to Nest presets)
// - Real-time water temperature monitoring
// - Heating active state reporting (HEAT / OFF)
// - Temperature unit synchronisation (Celsius / Fahrenheit)
// - Online/offline status reporting
// - Eve Home history integration (temperature, target, heating state)
//
// Notes:
// - Heat Link devices are controlled via their associated thermostat
// - Not all devices support both temperature control and boost control
// - Services are created or removed dynamically based on device capabilities
// - Temperature values are normalised via shared utility helpers
//
// Data Translation:
// - Raw Nest and Google data is mapped using HEATLINK_FIELD_MAP
// - Google API data is preferred, with Nest as fallback
// - processRawData() builds device objects and applies configuration overrides
//
// Mark Hulskamp
'use strict';

// Define our modules
import HomeKitDevice from '../HomeKitDevice.js';
import { processCommonData, adjustTemperature, parseDurationToSeconds } from '../utils.js';
import { buildMappedObject, createMappingContext } from '../translator.js';

// Define constants
import {
  DATA_SOURCE,
  DEVICE_TYPE,
  HOTWATER_MAX_TEMPERATURE,
  HOTWATER_MIN_TEMPERATURE,
  PROTOBUF_RESOURCES,
  HOTWATER_BOOST_TIMES,
} from '../consts.js';

export default class NestHeatlink extends HomeKitDevice {
  static TYPE = 'Heatlink';
  static VERSION = '2026.04.01'; // Code version

  thermostatService = undefined; // Hotwater temperature control
  switchService = undefined; // Hotwater heating boost control

  onAdd() {
    // Patch to avoid characteristic errors when setting initial property ranges
    this.hap.Characteristic.TargetTemperature.prototype.getDefaultValue = () => {
      return this.deviceData.hotwaterMinTemp; // start at minimum heating threshold
    };
    this.hap.Characteristic.TargetHeatingCoolingState.prototype.getDefaultValue = () => {
      return this.hap.Characteristic.TargetHeatingCoolingState.HEAT; // Only heating
    };

    // If the heatlink supports hotwater temperature control
    // Setup the thermostat service if not already present on the accessory, and link it to the Eve app if configured to do so
    if (this.deviceData?.has_hot_water_temperature === true) {
      this.#setupHotwaterTemperature();
    }

    if (this.deviceData?.has_hot_water_temperature === false) {
      // No longer have hotwater temperature control configured and service present, so removed it
      this.thermostatService = this.accessory.getService(this.hap.Service.Thermostat);
      if (this.thermostatService !== undefined) {
        this.accessory.removeService(this.thermostatService);
      }
      this.thermostatService = undefined;
    }

    // Setup hotwater boost heating service if supported by the thermostat and not already present on the accessory
    if (this.deviceData?.has_hot_water_control === true) {
      this.#setupHotwaterBoost();
    }
    if (this.deviceData?.has_hot_water_control === false) {
      // No longer have hotwater heating configured and service present, so removed it
      this.switchService = this.accessory.getService(this.hap.Service.Switch);
      if (this.switchService !== undefined) {
        this.accessory.removeService(this.switchService);
      }
      this.switchService = undefined;
    }

    // Extra setup details for output
    this.switchService !== undefined && this.postSetupDetail('Boost time ' + this.#logHotwaterBoostTime(this.deviceData.hotwaterBoostTime));
    this.thermostatService !== undefined &&
      this.postSetupDetail('Temperature control (' + this.deviceData.hotwaterMinTemp + '–' + this.deviceData.hotwaterMaxTemp + '°C)');
  }

  onRemove() {
    this.accessory.removeService(this.thermostatService);
    this.accessory.removeService(this.switchService);
    this.thermostatService = undefined;
    this.switchService = undefined;
  }

  onUpdate(deviceData) {
    if (typeof deviceData !== 'object') {
      return;
    }

    // TODO dynamic changes to hotwater setup ie: boost control and temperature control

    if (this.thermostatService !== undefined) {
      // Update when we have hot water temperature control
      this.thermostatService.updateCharacteristic(
        this.hap.Characteristic.TemperatureDisplayUnits,
        deviceData.temperature_scale.toUpperCase() === 'C'
          ? this.hap.Characteristic.TemperatureDisplayUnits.CELSIUS
          : this.hap.Characteristic.TemperatureDisplayUnits.FAHRENHEIT,
      );

      this.thermostatService.updateCharacteristic(this.hap.Characteristic.CurrentTemperature, deviceData.current_water_temperature);
      this.thermostatService.updateCharacteristic(this.hap.Characteristic.TargetTemperature, deviceData.hot_water_temperature);
      this.thermostatService.updateCharacteristic(
        this.hap.Characteristic.CurrentHeatingCoolingState,
        deviceData.hot_water_active === true
          ? this.hap.Characteristic.CurrentHeatingCoolingState.HEAT
          : this.hap.Characteristic.CurrentHeatingCoolingState.OFF,
      );

      this.thermostatService.updateCharacteristic(this.hap.Characteristic.StatusActive, deviceData.online === true);

      // Log thermostat metrics to history only if changed to previous recording
      this.history(this.thermostatService, {
        status: deviceData.hot_water_active === true ? 2 : 0, // 2 - heating water, 0 - not heating water
        temperature: deviceData.current_water_temperature,
        target: deviceData.hot_water_temperature,
      });

      // Update our internal data with properties Eve will need to process then Notify Eve App of device status changes if linked
      this.deviceData.online = deviceData.online;
      this.historyService?.updateEveHome?.(this.thermostatService);
    }

    if (this.switchService !== undefined) {
      // Hotwater boost status on or off
      this.switchService.updateCharacteristic(this.hap.Characteristic.On, deviceData.hot_water_boost_active === true);
    }
  }

  onMessage(type, message) {
    if (typeof type !== 'string' || type === '' || message === null || typeof message !== 'object' || message?.constructor !== Object) {
      return;
    }

    if (type === HomeKitDevice?.HISTORY?.GET) {
      // Extend Eve Thermo GET payload with device state
      message.attached = this.deviceData.online === true;
      return message;
    }
  }

  #setupHotwaterTemperature() {
    this.thermostatService = this.addHKService(this.hap.Service.Thermostat, '', 1, { messages: this.message.bind(this) });
    this.thermostatService.setPrimaryService();

    this.addHKCharacteristic(this.thermostatService, this.hap.Characteristic.StatusActive);

    this.addHKCharacteristic(this.thermostatService, this.hap.Characteristic.TemperatureDisplayUnits, {
      onSet: (value) => {
        let unit = value === this.hap.Characteristic.TemperatureDisplayUnits.CELSIUS ? 'C' : 'F';

        this.set({
          uuid: this.deviceData.associated_thermostat,
          temperature_scale: unit,
        });

        this.thermostatService.updateCharacteristic(this.hap.Characteristic.TemperatureDisplayUnits, value);

        this?.log?.info?.('Set temperature units on heat link "%s" to "%s"', this.deviceData.description, unit === 'C' ? '°C' : '°F');
      },
      onGet: () => {
        return this.deviceData.temperature_scale.toUpperCase() === 'C'
          ? this.hap.Characteristic.TemperatureDisplayUnits.CELSIUS
          : this.hap.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
      },
    });

    this.addHKCharacteristic(this.thermostatService, this.hap.Characteristic.CurrentTemperature, {
      props: { minStep: 0.5 },
      onGet: () => {
        return this.deviceData.current_water_temperature;
      },
    });

    this.addHKCharacteristic(this.thermostatService, this.hap.Characteristic.TargetTemperature, {
      props: {
        minStep: 0.5,
        minValue: this.deviceData.hotwaterMinTemp,
        maxValue: this.deviceData.hotwaterMaxTemp,
      },
      onSet: (value) => {
        if (value !== this.deviceData.hot_water_temperature) {
          this.set({ uuid: this.deviceData.associated_thermostat, hot_water_temperature: value });

          this?.log?.info?.('Set hotwater boiler temperature on heat link "%s" to "%s °C"', this.deviceData.description, value);
        }
      },
      onGet: () => {
        return this.deviceData.hot_water_temperature;
      },
    });

    // We only support heating for this thermostat service
    this.addHKCharacteristic(this.thermostatService, this.hap.Characteristic.TargetHeatingCoolingState, {
      props: {
        validValues: [this.hap.Characteristic.TargetHeatingCoolingState.HEAT],
      },
    });
  }

  #setupHotwaterBoost() {
    this.switchService = this.addHKService(this.hap.Service.Switch, '', 1);

    this.addHKCharacteristic(this.switchService, this.hap.Characteristic.On, {
      onSet: (value) => {
        if (value !== this.deviceData.hot_water_boost_active) {
          this.set({
            uuid: this.deviceData.associated_thermostat,
            hot_water_boost_active: { state: value === true, time: this.deviceData.hotwaterBoostTime },
          });

          this.switchService.updateCharacteristic(this.hap.Characteristic.On, value);

          this?.log?.info?.(
            'Set hotwater boost heating on heat link "%s" to "%s"',
            this.deviceData.description,
            value === true ? 'On for ' + this.#logHotwaterBoostTime(this.deviceData.hotwaterBoostTime) : 'Off',
          );
        }
      },
      onGet: () => {
        return this.deviceData?.hot_water_boost_active === true;
      },
    });
  }

  #logHotwaterBoostTime(time) {
    let output = '';

    if (isNaN(time) === false) {
      output =
        (time >= 3600 ? Math.floor(time / 3600) + ' hr' + (Math.floor(time / 3600) > 1 ? 's ' : ' ') : '') +
        Math.floor((time % 3600) / 60) +
        ' min' +
        (Math.floor((time % 3600) / 60) !== 1 ? 's' : '');
    }
    return output;
  }
}

// Data translation functions for Heat Link data.
// We use this to translate RAW Nest and Google data into the format we want for our
// Heat Link device(s) using the field map below.
//
// This keeps all translation logic in one place and makes it easier to maintain as
// Nest and Google sources evolve over time.
//
// Field map conventions:
// - Return undefined for missing values rather than placeholder defaults
// - processRawData() determines if enough data exists to build the device
// - Optional fields may remain undefined
//
// Heat Link field translation map
const HEATLINK_FIELD_MAP = {
  // Identity fields
  serialNumber: {
    google: ({ sourceValue }) =>
      (sourceValue?.value?.heat_link?.heatLinkSerialNumber?.value?.trim?.() ?? '') !== ''
        ? sourceValue.value.heat_link.heatLinkSerialNumber.value
        : undefined,

    nest: ({ sourceValue }) =>
      (sourceValue?.value?.heat_link_serial_number?.trim?.() ?? '') !== '' ? sourceValue.value.heat_link_serial_number : undefined,
  },

  nest_google_device_uuid: {
    google: ({ objectKey }) => objectKey,
    nest: ({ objectKey }) => objectKey,
  },

  nest_google_home_uuid: {
    google: ({ sourceValue }) => sourceValue?.value?.device_info?.pairerId?.resourceId,
    nest: ({ rawData, sourceValue }) => rawData?.['link.' + sourceValue?.value?.serial_number]?.value?.structure,
  },

  // Model identification
  model: {
    google: ({ sourceValue }) => {
      let model = sourceValue?.value?.heat_link?.heatLinkModel?.value ?? '';

      if (model.startsWith('Amber-2') === true) {
        return 'Heat Link for Learning Thermostat (3rd gen, EU)';
      }

      if (model.startsWith('Amber-1') === true) {
        return 'Heat Link for Learning Thermostat (2nd gen, EU)';
      }

      if (model.includes('Agate') === true) {
        return 'Heat Link for Thermostat E (1st gen, EU)';
      }

      return model !== '' ? 'Heat Link (unknown - ' + model + ')' : undefined;
    },

    nest: ({ sourceValue }) => {
      let model = sourceValue?.value?.heat_link_model ?? '';

      if (model.startsWith('Amber-2') === true) {
        return 'Heat Link for Learning Thermostat (3rd gen, EU)';
      }

      if (model.startsWith('Amber-1') === true) {
        return 'Heat Link for Learning Thermostat (2nd gen, EU)';
      }

      if (model.includes('Agate') === true) {
        return 'Heat Link for Thermostat E (1st gen, EU)';
      }

      return model !== '' ? 'Heat Link (unknown - ' + model + ')' : undefined;
    },
  },

  // Software version
  softwareVersion: {
    google: ({ sourceValue }) => sourceValue?.value?.heat_link?.heatLinkSwVersion?.value,
    nest: ({ sourceValue }) => sourceValue?.value?.heat_link_sw_version,
  },

  // Thermostat association
  associated_thermostat: {
    google: ({ objectKey }) => objectKey,
    nest: ({ objectKey }) => objectKey,
  },

  // Temperature scale used by thermostat UI
  temperature_scale: {
    google: ({ sourceValue }) => (sourceValue?.value?.display_settings?.temperatureScale === 'TEMPERATURE_SCALE_F' ? 'F' : 'C'),

    nest: ({ sourceValue }) => (sourceValue?.value?.temperature_scale?.toUpperCase?.() === 'F' ? 'F' : 'C'),
  },

  // Online status (thermostat connectivity reflects Heat Link availability)
  online: {
    google: ({ sourceValue }) => sourceValue?.value?.liveness?.status === 'LIVENESS_DEVICE_STATUS_ONLINE',

    nest: ({ rawData, sourceValue }) => rawData?.['track.' + sourceValue?.value?.serial_number]?.value?.online === true,
  },

  // Hot water control support
  has_hot_water_control: {
    google: ({ sourceValue }) => sourceValue?.value?.hvac_equipment_capabilities?.hasHotWaterControl === true,

    nest: ({ sourceValue }) => sourceValue?.value?.has_hot_water_control === true,
  },

  hot_water_active: {
    google: ({ sourceValue }) => sourceValue?.value?.hot_water_trait?.boilerActive === true,

    nest: ({ sourceValue }) => sourceValue?.value?.hot_water_active === true,
  },

  hot_water_boost_active: {
    google: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.hot_water_settings?.boostTimerEnd?.seconds) === false &&
      Number(sourceValue.value.hot_water_settings.boostTimerEnd.seconds) > 0,

    nest: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.hot_water_boost_time_to_end) === false && Number(sourceValue.value.hot_water_boost_time_to_end) > 0,
  },

  has_hot_water_temperature: {
    google: ({ sourceValue }) => sourceValue?.value?.hvac_equipment_capabilities?.hasHotWaterTemperature === true,

    nest: ({ sourceValue }) => sourceValue?.value?.has_hot_water_temperature === true,
  },

  // Current water temperature reported by the boiler
  current_water_temperature: {
    google: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.hot_water_trait?.temperature?.value) === false
        ? adjustTemperature(Number(sourceValue.value.hot_water_trait.temperature.value), 'C', 'C', true)
        : undefined,

    nest: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.current_water_temperature) === false
        ? adjustTemperature(Number(sourceValue.value.current_water_temperature), 'C', 'C', true)
        : undefined,
  },

  // Target water temperature
  hot_water_temperature: {
    google: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.hot_water_settings?.temperature?.value) === false
        ? adjustTemperature(Number(sourceValue.value.hot_water_settings.temperature.value), 'C', 'C', true)
        : undefined,

    nest: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.hot_water_temperature) === false
        ? adjustTemperature(Number(sourceValue.value.hot_water_temperature), 'C', 'C', true)
        : undefined,
  },

  // Naming / descriptive fields
  description: {
    google: ({ sourceValue }) => String(sourceValue?.value?.label?.label ?? ''),
    nest: ({ rawData, sourceValue }) => String(rawData?.['shared.' + sourceValue?.value?.serial_number]?.value?.name ?? ''),
  },

  location: {
    google: ({ rawData, sourceValue }) =>
      String(
        [
          ...Object.values(
            rawData?.[sourceValue?.value?.device_info?.pairerId?.resourceId]?.value?.located_annotations?.predefinedWheres || {},
          ),
          ...Object.values(
            rawData?.[sourceValue?.value?.device_info?.pairerId?.resourceId]?.value?.located_annotations?.customWheres || {},
          ),
        ].find((where) => where?.whereId?.resourceId === sourceValue?.value?.device_located_settings?.whereAnnotationRid?.resourceId)?.label
          ?.literal ?? '',
      ),

    nest: ({ rawData, sourceValue }) =>
      String(
        rawData?.[
          'where.' + rawData?.['link.' + sourceValue?.value?.serial_number]?.value?.structure?.split?.('.')[1]
        ]?.value?.wheres?.find((where) => where?.where_id === sourceValue?.value?.where_id)?.name ?? '',
      ),
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

  // Process data for any heat link devices found via thermostat resources
  let devices = {};

  Object.entries(rawData)
    .filter(
      ([key, value]) =>
        key.startsWith('device.') === true ||
        (key.startsWith('DEVICE_') === true && PROTOBUF_RESOURCES.THERMOSTAT.includes(value.value?.device_info?.typeName) === true),
    )
    .forEach(([object_key, value]) => {
      let tempDevice = {};

      try {
        let mappedData = buildMappedObject(
          HEATLINK_FIELD_MAP,
          createMappingContext(
            rawData,
            object_key,
            value?.source === DATA_SOURCE.NEST ? value : undefined,
            value?.source === DATA_SOURCE.GOOGLE ? value : undefined,
          ),
        );

        // Google API preferred
        if (
          value?.source === DATA_SOURCE.GOOGLE &&
          value.value?.configuration_done?.deviceReady === true &&
          typeof rawData?.[value.value?.device_info?.pairerId?.resourceId] === 'object' &&
          ['HEAT_LINK_CONNECTION_TYPE_ON_OFF', 'HEAT_LINK_CONNECTION_TYPE_OPENTHERM'].some(
            (type) =>
              value.value?.heat_link_settings?.heatConnectionType === type ||
              value.value?.heat_link_settings?.hotWaterConnectionType === type,
          ) === true &&
          mappedData.serialNumber !== undefined &&
          mappedData.model !== undefined &&
          mappedData.softwareVersion !== undefined
        ) {
          tempDevice = processCommonData(
            mappedData.nest_google_device_uuid,
            mappedData.nest_google_home_uuid,
            {
              type: DEVICE_TYPE.HEATLINK,
              ...mappedData,
            },
            config,
          );
        }

        // Nest fallback if Google not used or data not available from Google for this device
        if (
          Object.entries(tempDevice).length === 0 &&
          value?.source === DATA_SOURCE.NEST &&
          typeof rawData?.['track.' + value.value?.serial_number] === 'object' &&
          typeof rawData?.['shared.' + value.value?.serial_number] === 'object' &&
          mappedData.serialNumber !== undefined &&
          mappedData.model !== undefined &&
          mappedData.softwareVersion !== undefined
        ) {
          tempDevice = processCommonData(
            mappedData.nest_google_device_uuid,
            mappedData.nest_google_home_uuid,
            {
              type: DEVICE_TYPE.HEATLINK,
              ...mappedData,
            },
            config,
          );
        }
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        log?.debug?.('Error processing heat link data for "%s"', object_key);
      }

      if (
        Object.entries(tempDevice).length !== 0 &&
        typeof devices[tempDevice.serialNumber] === 'undefined' &&
        (deviceType === undefined || (typeof deviceType === 'string' && deviceType !== '' && tempDevice.type === deviceType))
      ) {
        let deviceOptions = config?.devices?.find(
          (device) => device?.serialNumber?.toUpperCase?.() === tempDevice?.serialNumber?.toUpperCase?.(),
        );
        // eslint-disable-next-line no-unused-vars
        let homeOptions = config?.homes?.find(
          (home) =>
            home?.nest_home_uuid?.toUpperCase?.() === tempDevice?.nest_google_home_uuid?.toUpperCase?.() ||
            home?.google_home_uuid?.toUpperCase?.() === tempDevice?.nest_google_home_uuid?.toUpperCase?.(),
        );

        // Insert configuration options
        tempDevice.eveHistory =
          deviceOptions?.eveHistory !== undefined ? deviceOptions.eveHistory === true : config.options?.eveHistory === true;

        // Hot water boost duration allowed by Nest app presets
        tempDevice.hotwaterBoostTime = parseDurationToSeconds(deviceOptions?.hotwaterBoostTime, {
          defaultValue: 1800,
          min: 1800,
          max: 7200,
        });

        tempDevice.hotwaterBoostTime = HOTWATER_BOOST_TIMES.reduce((a, b) =>
          Math.abs(tempDevice.hotwaterBoostTime - a) < Math.abs(tempDevice.hotwaterBoostTime - b) ? a : b,
        );

        // Configurable temperature bounds
        tempDevice.hotwaterMinTemp =
          isNaN(deviceOptions?.hotwaterMinTemp) === false
            ? adjustTemperature(deviceOptions.hotwaterMinTemp, 'C', 'C', true)
            : HOTWATER_MIN_TEMPERATURE;

        tempDevice.hotwaterMaxTemp =
          isNaN(deviceOptions?.hotwaterMaxTemp) === false
            ? adjustTemperature(deviceOptions.hotwaterMaxTemp, 'C', 'C', true)
            : HOTWATER_MAX_TEMPERATURE;

        devices[tempDevice.serialNumber] = tempDevice;
      }
    });

  return devices;
}
