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
import { processSoftwareVersion, adjustTemperature, parseDurationToSeconds } from '../utils.js';
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
  static VERSION = '2026.04.16'; // Code version

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

// Heat Link field translation map
// Maps raw source data -> normalised heat link device fields
// - fields: top-level raw fields this mapping depends on (for delta updates)
// - related: top-level raw fields on related objects this mapping depends on
// - translate: converts raw -> final normalised value
const HEATLINK_FIELD_MAP = {
  // Identity fields
  serialNumber: {
    required: true,
    google: {
      fields: [],
      translate: ({ raw }) =>
        (raw?.value?.heat_link?.heatLinkSerialNumber?.value?.trim?.() ?? '') !== ''
          ? raw.value.heat_link.heatLinkSerialNumber.value.trim().toUpperCase()
          : undefined,
    },
    nest: {
      fields: [],
      translate: ({ raw }) =>
        (raw?.value?.heat_link_serial_number?.trim?.() ?? '') !== '' ? raw.value.heat_link_serial_number.trim().toUpperCase() : undefined,
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
    google: {
      fields: ['device_info'],
      translate: ({ raw }) => raw?.value?.device_info?.pairerId?.resourceId,
    },
    nest: {
      fields: ['serial_number'],
      related: ['structure'],
      translate: ({ rawData, raw }) => rawData?.['link.' + raw?.value?.serial_number]?.value?.structure,
    },
  },

  // Model identification
  model: {
    required: true,
    google: {
      fields: ['heat_link'],
      translate: ({ raw }) => {
        let model = raw?.value?.heat_link?.heatLinkModel?.value ?? '';

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
    nest: {
      fields: ['heat_link_model'],
      translate: ({ raw }) => {
        let model = raw?.value?.heat_link_model ?? '';

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
  },

  softwareVersion: {
    required: true,
    google: {
      fields: ['heat_link'],
      translate: ({ raw }) =>
        typeof raw?.value?.heat_link?.heatLinkSwVersion?.value === 'string' && raw.value.heat_link.heatLinkSwVersion.value.trim() !== ''
          ? processSoftwareVersion(raw.value.heat_link.heatLinkSwVersion.value)
          : undefined,
    },
    nest: {
      fields: ['heat_link_sw_version'],
      translate: ({ raw }) =>
        typeof raw?.value?.heat_link_sw_version === 'string' && raw.value.heat_link_sw_version.trim() !== ''
          ? processSoftwareVersion(raw.value.heat_link_sw_version)
          : undefined,
    },
  },

  // Thermostat association
  associated_thermostat: {
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

  temperature_scale: {
    required: true,
    google: {
      fields: ['display_settings'],
      translate: ({ raw }) => (raw?.value?.display_settings?.temperatureScale === 'TEMPERATURE_SCALE_F' ? 'F' : 'C'),
    },
    nest: {
      fields: ['temperature_scale'],
      translate: ({ raw }) => (raw?.value?.temperature_scale?.toUpperCase?.() === 'F' ? 'F' : 'C'),
    },
  },

  online: {
    required: true,
    google: {
      fields: ['liveness'],
      translate: ({ raw }) => raw?.value?.liveness?.status === 'LIVENESS_DEVICE_STATUS_ONLINE',
    },
    nest: {
      fields: ['serial_number'],
      related: ['online'],
      translate: ({ rawData, raw }) => rawData?.['track.' + raw?.value?.serial_number]?.value?.online === true,
    },
  },

  has_hot_water_control: {
    required: true,
    google: {
      fields: ['hvac_equipment_capabilities'],
      translate: ({ raw }) => raw?.value?.hvac_equipment_capabilities?.hasHotWaterControl === true,
    },
    nest: {
      fields: ['has_hot_water_control'],
      translate: ({ raw }) => raw?.value?.has_hot_water_control === true,
    },
  },

  hot_water_active: {
    google: {
      fields: ['hot_water_trait'],
      translate: ({ raw }) => raw?.value?.hot_water_trait?.boilerActive === true,
    },
    nest: {
      fields: ['hot_water_active'],
      translate: ({ raw }) => raw?.value?.hot_water_active === true,
    },
  },

  hot_water_boost_active: {
    required: true,
    google: {
      fields: ['hot_water_settings'],
      translate: ({ raw }) =>
        isNaN(raw?.value?.hot_water_settings?.boostTimerEnd?.seconds) === false &&
        Number(raw.value.hot_water_settings.boostTimerEnd.seconds) > 0,
    },
    nest: {
      fields: ['hot_water_boost_time_to_end'],
      translate: ({ raw }) => isNaN(raw?.value?.hot_water_boost_time_to_end) === false && Number(raw.value.hot_water_boost_time_to_end) > 0,
    },
  },

  has_hot_water_temperature: {
    required: true,
    google: {
      fields: ['hvac_equipment_capabilities'],
      translate: ({ raw }) => raw?.value?.hvac_equipment_capabilities?.hasHotWaterTemperature === true,
    },
    nest: {
      fields: ['has_hot_water_temperature'],
      translate: ({ raw }) => raw?.value?.has_hot_water_temperature === true,
    },
  },

  current_water_temperature: {
    google: {
      fields: ['hot_water_trait'],
      translate: ({ raw }) =>
        isNaN(raw?.value?.hot_water_trait?.temperature?.value) === false
          ? adjustTemperature(Number(raw.value.hot_water_trait.temperature.value), 'C', 'C', true)
          : undefined,
    },
    nest: {
      fields: ['current_water_temperature'],
      translate: ({ raw }) =>
        isNaN(raw?.value?.current_water_temperature) === false
          ? adjustTemperature(Number(raw.value.current_water_temperature), 'C', 'C', true)
          : undefined,
    },
  },

  hot_water_temperature: {
    google: {
      fields: ['hot_water_settings'],
      translate: ({ raw }) =>
        isNaN(raw?.value?.hot_water_settings?.temperature?.value) === false
          ? adjustTemperature(Number(raw.value.hot_water_settings.temperature.value), 'C', 'C', true)
          : undefined,
    },
    nest: {
      fields: ['hot_water_temperature'],
      translate: ({ raw }) =>
        isNaN(raw?.value?.hot_water_temperature) === false
          ? adjustTemperature(Number(raw.value.hot_water_temperature), 'C', 'C', true)
          : undefined,
    },
  },

  description: {
    required: true,

    google: {
      fields: ['label', 'device_info', 'device_located_settings'],
      related: ['located_annotations'],
      translate: ({ rawData, raw }) => {
        let description = String(raw?.value?.label?.label ?? '').trim();
        let location = String(
          [
            ...Object.values(rawData?.[raw?.value?.device_info?.pairerId?.resourceId]?.value?.located_annotations?.predefinedWheres || {}),
            ...Object.values(rawData?.[raw?.value?.device_info?.pairerId?.resourceId]?.value?.located_annotations?.customWheres || {}),
          ].find((where) => where?.whereId?.resourceId === raw?.value?.device_located_settings?.whereAnnotationRid?.resourceId)?.label
            ?.literal ?? '',
        ).trim();

        if (description === '' && location !== '') {
          description = location;
          location = '';
        }

        if (description === '' && location === '') {
          description = 'unknown description';
        }

        return HomeKitDevice.makeValidHKName(location === '' ? description : description + ' - ' + location);
      },
    },

    nest: {
      fields: ['serial_number', 'where_id'],
      related: ['name', 'wheres', 'structure'],
      translate: ({ rawData, raw }) => {
        let description = String(rawData?.['shared.' + raw?.value?.serial_number]?.value?.name ?? '').trim();
        let location = String(
          rawData?.['where.' + rawData?.['link.' + raw?.value?.serial_number]?.value?.structure?.split?.('.')[1]]?.value?.wheres?.find(
            (where) => where?.where_id === raw?.value?.where_id,
          )?.name ?? '',
        ).trim();

        if (description === '' && location !== '') {
          description = location;
          location = '';
        }

        if (description === '' && location === '') {
          description = 'unknown description';
        }

        return HomeKitDevice.makeValidHKName(location === '' ? description : description + ' - ' + location);
      },
    },
  },
};

// Function to process our RAW Nest or Google data for heat link devices
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

  // Process data for any heat link devices found via thermostat resources
  let devices = {};

  Object.entries(rawData)
    .filter(
      ([key, value]) =>
        key.startsWith('device.') === true ||
        (key.startsWith('DEVICE_') === true && PROTOBUF_RESOURCES.THERMOSTAT.includes(value?.value?.device_info?.typeName) === true),
    )
    .forEach(([object_key, value]) => {
      try {
        // Only process supported Google or Nest thermostat resources that can expose Heat Link data
        if (
          (value?.source !== DATA_SOURCE.GOOGLE && value?.source !== DATA_SOURCE.NEST) ||
          (value?.source === DATA_SOURCE.GOOGLE &&
            (value?.value?.configuration_done?.deviceReady !== true ||
              typeof rawData?.[value?.value?.device_info?.pairerId?.resourceId] !== 'object' ||
              ['HEAT_LINK_CONNECTION_TYPE_ON_OFF', 'HEAT_LINK_CONNECTION_TYPE_OPENTHERM'].some(
                (type) =>
                  value?.value?.heat_link_settings?.heatConnectionType === type ||
                  value?.value?.heat_link_settings?.hotWaterConnectionType === type,
              ) !== true)) ||
          (value?.source === DATA_SOURCE.NEST &&
            (typeof rawData?.['track.' + value?.value?.serial_number] !== 'object' ||
              typeof rawData?.['shared.' + value?.value?.serial_number] !== 'object'))
        ) {
          return;
        }

        // Map raw device data into our normalised heat link schema
        let mappedResult = buildMappedObject(
          HEATLINK_FIELD_MAP,
          createMappingContext(rawData, object_key, {
            nest: value?.source === DATA_SOURCE.NEST ? value : undefined,
            google: value?.source === DATA_SOURCE.GOOGLE ? value : undefined,
          }),
          changedData instanceof Map ? changedData.get(object_key)?.fields : undefined,
        );

        let serialNumber = mappedResult?.data?.serialNumber;
        let existingDevice = devices[serialNumber];

        // If we have all required fields, build the full heat link device data object
        if (mappedResult?.hasRequired === true) {
          let tempDevice = {
            type: DEVICE_TYPE.HEATLINK,
            manufacturer: 'Nest',
            ...mappedResult.data,
          };

          // Respect requested device type if specified
          if (deviceType !== undefined && (typeof deviceType !== 'string' || deviceType === '' || tempDevice.type !== deviceType)) {
            return;
          }

          // Check for any device or home configuration options that match this device
          // We'll use the serial number to match against device options, and the home uuid to match against home options
          let deviceOptions = config?.devices?.find(
            (device) => device?.serialNumber?.toUpperCase?.() === tempDevice?.serialNumber?.toUpperCase?.(),
          );
          let homeOptions = config?.homes?.find(
            (home) =>
              home?.nest_home_uuid?.toUpperCase?.() === tempDevice?.nest_google_home_uuid?.toUpperCase?.() ||
              home?.google_home_uuid?.toUpperCase?.() === tempDevice?.nest_google_home_uuid?.toUpperCase?.(),
          );

          // Insert configuration options
          tempDevice.eveHistory =
            deviceOptions?.eveHistory !== undefined ? deviceOptions.eveHistory === true : config?.options?.eveHistory === true;

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

          // Process additional exclusion details
          tempDevice.excluded =
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

        // Only store partial data if nothing has already been stored for this serial in this pass.
        // A later full payload will replace an earlier partial payload.
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
        log?.error?.('Error processing heat link data for "%s": %s', object_key, String(error));
      }
    });

  return devices;
}
