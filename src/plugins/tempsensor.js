// Nest Temperature Sensor - HomeKit integration
// Part of homebridge-nest-accfactory
//
// HomeKit accessory implementation for Nest Temperature Sensor devices.
// Provides temperature monitoring, battery status, online/offline detection,
// and integration with thermostat remote sensing.
//
// Responsibilities:
// - Expose current temperature via HomeKit TemperatureSensor service
// - Synchronise sensor availability and active status with HomeKit
// - Monitor battery level and low battery conditions
// - Determine online/offline state based on last update timestamps
// - Record temperature history for Eve Home integration
//
// Services:
// - TemperatureSensor (primary service)
// - Battery (hidden, linked to temperature service)
//
// Features:
// - Real-time temperature updates with HomeKit synchronisation
// - Active sensor indication when paired with thermostat (RCS support)
// - Battery monitoring with low battery alerts
// - Online/offline detection using timestamp-based validation (4-hour threshold)
// - Eve Home history integration (5-minute interval recording)
//
// Notes:
// - Uses protobuf API data only
// - Sensors may exist in one or both APIs; data is merged and deduplicated
// - Serial number is used as the unique key across APIs
// - Temperature values are normalised before HomeKit presentation
//
// Data Translation:
// - Raw data is mapped using TEMPSENSOR_FIELD_MAP
// - processRawData() builds device objects from thermostat-linked sensors
// - Protobuf sensors are identified by their physical serial number
// - Field mapping isolates upstream API differences from HomeKit representation
//
// Mark Hulskamp
'use strict';

// Define our modules
import HomeKitDevice from '../HomeKitDevice.js';
import { adjustTemperature, scaleValue, buildDeviceDescription } from '../utils.js';
import { buildMappedObject, createMappingContext } from '../translator.js';

// Define constants
import { LOW_BATTERY_LEVEL, DATA_SOURCE, PROTOBUF_RESOURCES, DEVICE_TYPE } from '../consts.js';

export default class NestTemperatureSensor extends HomeKitDevice {
  static TYPE = DEVICE_TYPE.TEMPSENSOR;
  static VERSION = '2026.10.15'; // Code version

  batteryService = undefined;
  temperatureService = undefined;

  // Class functions
  onAdd() {
    // Setup temperature service if not already present on the accessory and link it to the Eve app if configured to do so
    this.temperatureService = this.addService(this.hap.Service.TemperatureSensor, '', 1, {});
    this.temperatureService.setPrimaryService();

    // Setup battery service if not already present on the accessory
    this.batteryService = this.addService(this.hap.Service.Battery, '', 1);
    this.batteryService.setHiddenService(true);
    this.temperatureService.addLinkedService(this.batteryService);
  }

  onRemove() {
    this.removeService(this.temperatureService);
    this.removeService(this.batteryService);
    this.temperatureService = undefined;
    this.batteryService = undefined;
  }

  onUpdate(deviceData) {
    if (
      typeof deviceData !== 'object' ||
      deviceData?.constructor !== Object ||
      this.temperatureService === undefined ||
      this.batteryService === undefined
    ) {
      return;
    }

    // If device isn't online report in HomeKit
    this.temperatureService.updateCharacteristic(
      this.hap.Characteristic.StatusFault,
      deviceData.online === true ? this.hap.Characteristic.StatusFault.NO_FAULT : this.hap.Characteristic.StatusFault.GENERAL_FAULT,
    );

    // Status active: if linked to thermostat, must be online AND the active sensor; otherwise just online
    this.temperatureService.updateCharacteristic(
      this.hap.Characteristic.StatusActive,
      typeof deviceData?.associated_thermostat === 'string' && deviceData.associated_thermostat !== ''
        ? deviceData.online === true && deviceData?.active_sensor === true
        : deviceData.online === true,
    );

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

// Temperature sensor field translation map
// Maps raw source data -> normalised device fields
// - fields: top-level raw fields this mapping depends on (for delta updates)
// - translate: converts raw -> candidate value
// - merge: combines source values into the final normalised value
// IMPORTANT:
// `raw` in this map represents the temperature sensor resource itself.
// Thermostat relationship details are passed separately via mapping context.
const TEMPSENSOR_FIELD_MAP = {
  // Identity fields
  serialNumber: {
    required: true,
    google: {
      fields: [],
      translate: ({ raw }) => {
        let value = raw?.value;

        return typeof value?.device_identity?.serialNumber === 'string' && value.device_identity.serialNumber !== ''
          ? value.device_identity.serialNumber
          : undefined;
      },
    },
  },

  nest_google_device_uuid: {
    required: true,
    google: {
      fields: [],
      translate: ({ sensorUUID }) => sensorUUID,
    },
  },

  nest_google_home_uuid: {
    google: {
      fields: [],
      translate: ({ homeUUID }) => homeUUID,
    },
  },

  // Naming / descriptive fields
  model: {
    required: true,
    google: {
      fields: ['device_info', 'device_identity'],
      translate: ({ raw }) => {
        let value = raw?.value;
        let typeName = value?.device_info?.typeName ?? '';
        let productId = value?.device_identity?.productIdDescription?.literal ?? '';

        return typeName === 'nest.resource.NestKryptoniteResource' && productId === 'KRX'
          ? 'Temperature Sensor (2nd gen)'
          : typeName === 'nest.resource.NestKryptoniteResource' && productId === 'KR1'
            ? 'Temperature Sensor (1st gen)'
            : 'Temperature Sensor (unknown)';
      },
    },
  },

  description: {
    required: true,
    google: {
      fields: ['label', 'device_info', 'device_located_settings'],
      related: ['located_annotations'],
      translate: ({ rawData, raw }) => HomeKitDevice.makeValidHKName(buildDeviceDescription(rawData, raw)),
    },
  },

  battery_level: {
    required: true,
    google: {
      fields: ['battery'],
      translate: ({ raw }) => {
        let value = raw?.value;

        return Number.isFinite(Number(value?.battery?.assessedVoltage?.value)) === true
          ? Math.round(scaleValue(Number(value.battery.assessedVoltage.value), 2.5, 3.2, 0, 100))
          : undefined;
      },
    },
  },

  current_temperature: {
    required: true,
    google: {
      fields: ['current_temperature'],
      translate: ({ raw }) => {
        let value = raw?.value;

        return Number.isFinite(Number(value?.current_temperature?.temperatureValue?.temperature?.value)) === true
          ? adjustTemperature(Number(value.current_temperature.temperatureValue.temperature.value), 'C', 'C', true)
          : undefined;
      },
    },
  },

  online: {
    required: true,
    google: {
      fields: ['last_updated_beacon'],
      translate: ({ raw }) => {
        let value = raw?.value;

        return (
          Number.isFinite(Number(value?.last_updated_beacon?.lastBeaconTime?.seconds)) === true &&
          Math.floor(Date.now() / 1000) - Number(value.last_updated_beacon.lastBeaconTime.seconds) < 3600 * 4
        );
      },
    },
  },

  associated_thermostat: {
    google: {
      fields: [],
      translate: ({ parentUUID }) => parentUUID,
    },
  },

  active_sensor: {
    google: {
      fields: [],
      translate: ({ active_sensor }) => active_sensor === true,
    },
  },
};

// Process protobuf temperature sensors linked to supported thermostats.
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

  // Discover linked protobuf sensors and retain their physical serial identities.
  let devices = {};
  let candidates = {};

  const storeCandidate = (mappedResult, associatedThermostat) => {
    let serialNumber = mappedResult?.data?.serialNumber;

    if (
      mappedResult?.hasRequired !== true ||
      typeof mappedResult?.data !== 'object' ||
      mappedResult.data?.constructor !== Object ||
      typeof serialNumber !== 'string' ||
      serialNumber.trim() === ''
    ) {
      return;
    }

    candidates[serialNumber] = {
      type: DEVICE_TYPE.TEMPSENSOR,
      softwareVersion: NestTemperatureSensor.VERSION,
      manufacturer: 'Nest',
      associated_thermostat: associatedThermostat,
      ...mappedResult.data,
    };
  };

  Object.entries(rawData)
    .filter(
      ([key, value]) =>
        key.startsWith('DEVICE_') === true &&
        value?.source === DATA_SOURCE.GOOGLE &&
        PROTOBUF_RESOURCES.THERMOSTAT.includes(value?.value?.device_info?.typeName) === true,
    )
    .forEach(([object_key, value]) => {
      try {
        let homeUUID = value?.value?.device_info?.pairerId?.resourceId;
        let settings = value?.value?.remote_comfort_sensing_settings;
        if (
          value?.value?.configuration_done?.deviceReady !== true ||
          typeof homeUUID !== 'string' ||
          rawData?.[homeUUID] === undefined ||
          Array.isArray(settings?.associatedRcsSensors) !== true
        ) {
          return;
        }

        settings.associatedRcsSensors.forEach((sensor) => {
          let sensorUUID = sensor?.deviceId?.resourceId;
          let sensorRaw = rawData?.[sensorUUID];
          let sensorValue = sensorRaw?.value;
          if (
            typeof sensorUUID !== 'string' ||
            sensorUUID === '' ||
            sensorRaw?.source !== DATA_SOURCE.GOOGLE ||
            typeof sensorValue !== 'object' ||
            sensorValue === null ||
            sensorValue.constructor !== Object
          ) {
            return;
          }
          let pairerUUID = sensorValue?.device_info?.pairerId?.resourceId;
          if (changedData instanceof Map && [sensorUUID, object_key, homeUUID, pairerUUID].some((id) => changedData.has(id)) === false) {
            return;
          }

          // Rebuild from cached sensor traits when the sensor or its parent changes. Parent-only RCS
          // selection updates must refresh StatusActive even when no sensor traits have changed.
          storeCandidate(
            buildMappedObject(
              TEMPSENSOR_FIELD_MAP,
              createMappingContext(
                rawData,
                sensorUUID,
                { google: sensorRaw },
                {
                  sensorUUID: sensorUUID,
                  homeUUID: homeUUID,
                  parentUUID: object_key,
                  pairerUUID: pairerUUID,
                  active_sensor: settings?.activeRcsSelection?.activeRcsSensor?.resourceId === sensorUUID,
                },
              ),
              new Set([...Object.keys(sensorValue), 'located_annotations']),
            ),
            object_key,
          );
        });
      } catch (error) {
        log?.error?.('Error processing temperature sensor data for "%s": %s', object_key, String(error));
      }
    });

  Object.values(candidates).forEach((candidate) => {
    if (deviceType !== undefined && (typeof deviceType !== 'string' || deviceType === '' || candidate.type !== deviceType)) {
      return;
    }

    // Check for any device or home configuration options that match this device
    // We'll use the serial number to match against device options, and the home uuid to match against home options
    let deviceOptions = config?.devices?.find(
      (device) => device?.serialNumber?.toUpperCase?.() === candidate?.serialNumber?.toUpperCase?.(),
    );
    let homeOptions = config?.homes?.find(
      (home) =>
        home?.nest_home_uuid?.toUpperCase?.() === candidate?.nest_google_home_uuid?.toUpperCase?.() ||
        home?.google_home_uuid?.toUpperCase?.() === candidate?.nest_google_home_uuid?.toUpperCase?.(),
    );

    // Insert any extra options we've read in from configuration file for this device
    candidate.eveHistory =
      deviceOptions?.eveHistory !== undefined ? deviceOptions.eveHistory === true : config?.options?.eveHistory === true;

    // Process additional exclusion details
    candidate.excluded =
      deviceOptions?.exclude === true ||
      (deviceOptions?.exclude !== false &&
        (homeOptions?.exclude === true || (homeOptions?.exclude !== false && config?.options?.exclude === true)));

    // Store full device
    devices[candidate.serialNumber] = {
      full: true,
      data: candidate,
    };
  });

  return devices;
}
