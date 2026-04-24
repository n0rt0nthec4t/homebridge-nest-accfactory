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
// - Supports both Nest and Google APIs
// - Sensors may exist in one or both APIs; data is merged and deduplicated
// - Serial number is used as the unique key across APIs
// - Temperature values are normalised before HomeKit presentation
//
// Data Translation:
// - Raw data is mapped using TEMPSENSOR_FIELD_MAP
// - processRawData() builds device objects from thermostat-linked sensors
// - Google and Nest sources are merged and deduplicated by serialNumber
// - Field mapping isolates upstream API differences from HomeKit representation
//
// Mark Hulskamp
'use strict';

// Define our modules
import HomeKitDevice from '../HomeKitDevice.js';
import { adjustTemperature, scaleValue } from '../utils.js';
import { buildMappedObject, createMappingContext } from '../translator.js';

// Define constants
import { LOW_BATTERY_LEVEL, DATA_SOURCE, PROTOBUF_RESOURCES, DEVICE_TYPE } from '../consts.js';

export default class NestTemperatureSensor extends HomeKitDevice {
  static TYPE = DEVICE_TYPE.TEMPSENSOR;
  static VERSION = '2026.04.22'; // Code version

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
    this.temperatureService.addLinkedService(this.batteryService);
  }

  onRemove() {
    this.accessory.removeService(this.temperatureService);
    this.accessory.removeService(this.batteryService);
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
    nest: {
      fields: [],
      translate: ({ raw }) => {
        let value = raw?.value;

        return typeof value?.serial_number === 'string' && value.serial_number !== '' ? value.serial_number : undefined;
      },
    },
  },

  nest_google_device_uuid: {
    required: true,
    google: {
      fields: [],
      translate: ({ sensorUUID }) => sensorUUID,
    },
    nest: {
      fields: [],
      translate: ({ sensorUUID }) => sensorUUID,
    },
  },

  nest_google_home_uuid: {
    google: {
      fields: [],
      translate: ({ homeUUID }) => homeUUID,
    },
    nest: {
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
    nest: {
      fields: ['model'],
      translate: ({ raw }) => {
        let value = raw?.value;

        return value?.model === 'KRX'
          ? 'Temperature Sensor (2nd gen)'
          : value?.model === 'KR1'
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
      translate: ({ rawData, raw }) => {
        let value = raw?.value;
        let description = String(value?.label?.label ?? '').trim();
        let location = '';

        let pairerId = value?.device_info?.pairerId?.resourceId;
        let whereId = value?.device_located_settings?.whereAnnotationRid?.resourceId;

        if (typeof pairerId === 'string' && pairerId !== '' && typeof whereId === 'string' && whereId !== '') {
          let wheres = [
            ...Object.values(rawData?.[pairerId]?.value?.located_annotations?.predefinedWheres || {}),
            ...Object.values(rawData?.[pairerId]?.value?.located_annotations?.customWheres || {}),
          ];

          location = String(wheres.find((where) => where?.whereId?.resourceId === whereId)?.label?.literal ?? '').trim();
        }

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
      fields: ['description', 'structure_id', 'where_id'],
      related: ['wheres'],
      translate: ({ rawData, raw }) => {
        let value = raw?.value;
        let description = String(value?.description ?? '').trim();
        let location = '';

        let structureId = value?.structure_id;
        let whereId = value?.where_id;

        if (typeof structureId === 'string' && structureId !== '' && typeof whereId === 'string' && whereId !== '') {
          location = String(
            rawData?.['where.' + structureId]?.value?.wheres?.find((where) => where?.where_id === whereId)?.name ?? '',
          ).trim();
        }

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
    nest: {
      fields: ['battery_level'],
      translate: ({ raw }) => {
        let value = raw?.value;

        return Number.isFinite(Number(value?.battery_level)) === true
          ? Math.round(scaleValue(Number(value.battery_level), 0, 100, 0, 100))
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
    nest: {
      fields: ['current_temperature'],
      translate: ({ raw }) => {
        let value = raw?.value;

        return Number.isFinite(Number(value?.current_temperature)) === true
          ? adjustTemperature(Number(value.current_temperature), 'C', 'C', true)
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
    nest: {
      fields: ['last_updated_at'],
      translate: ({ raw }) => {
        let value = raw?.value;

        return (
          Number.isFinite(Number(value?.last_updated_at)) === true &&
          Math.floor(Date.now() / 1000) - Number(value.last_updated_at) < 3600 * 4
        );
      },
    },
  },

  associated_thermostat: {
    google: {
      fields: [],
      translate: ({ parentUUID }) => parentUUID,
    },
    nest: {
      fields: [],
      translate: ({ parentUUID }) => parentUUID,
    },
  },

  active_sensor: {
    google: {
      fields: [],
      translate: ({ active_sensor }) => active_sensor === true,
    },
    nest: {
      fields: [],
      translate: ({ active_sensor }) => active_sensor === true,
    },
  },
};

// Function to process our RAW Nest or Google data for temperature sensor devices
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

  // Temperature sensors are discovered via thermostat resources and may exist in
  // Google, Nest, or both. We collect candidate sensors and deduplicate by serial
  // number, preferring Google data when the same sensor exists in both APIs.
  let devices = {};
  let candidates = {};

  const storeCandidate = (mappedResult, source, associatedThermostat) => {
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

    // Prefer Google candidate when the same sensor exists in both APIs
    if (candidates[serialNumber] !== undefined && source !== DATA_SOURCE.GOOGLE) {
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
        key.startsWith('device.') === true ||
        (key.startsWith('DEVICE_') === true && PROTOBUF_RESOURCES.THERMOSTAT.includes(value?.value?.device_info?.typeName) === true),
    )
    .forEach(([object_key, value]) => {
      try {
        // Source type for this thermostat (Google or Nest)
        let source = undefined;

        // Normalised list of sensors for this thermostat
        // Each entry contains sensor UUID and whether it is the active RCS sensor
        let sensors = [];

        // Google uses pairerId as the home identifier
        let homeUUID = undefined;

        // Nest stores RCS data in a separate resource
        let rcsSettings = undefined;

        // Extract temperature sensors linked to a Google thermostat
        if (
          value?.source === DATA_SOURCE.GOOGLE &&
          value?.value?.configuration_done?.deviceReady === true &&
          rawData?.[value?.value?.device_info?.pairerId?.resourceId] !== undefined &&
          Array.isArray(value?.value?.remote_comfort_sensing_settings?.associatedRcsSensors) === true
        ) {
          source = DATA_SOURCE.GOOGLE;

          // Home UUID used for grouping and config matching
          homeUUID = value.value.device_info.pairerId.resourceId;

          // Build normalised sensor list from Google RCS configuration
          sensors = value.value.remote_comfort_sensing_settings.associatedRcsSensors.map((sensor) => ({
            sensorUUID: sensor?.deviceId?.resourceId,

            // Active sensor is defined by the thermostat's current RCS selection
            active_sensor:
              value?.value?.remote_comfort_sensing_settings?.activeRcsSelection?.activeRcsSensor?.resourceId ===
              sensor?.deviceId?.resourceId,
          }));
        }

        // Extract temperature sensors linked to a Nest thermostat
        if (
          value?.source === DATA_SOURCE.NEST &&
          Array.isArray(rawData?.['rcs_settings.' + value?.value?.serial_number]?.value?.associated_rcs_sensors) === true
        ) {
          source = DATA_SOURCE.NEST;

          // Full RCS settings object for this thermostat
          rcsSettings = rawData['rcs_settings.' + value.value.serial_number]?.value;

          // Build normalised sensor list from Nest RCS configuration
          sensors = rcsSettings.associated_rcs_sensors.map((sensorUUID) => ({
            sensorUUID: sensorUUID,

            // Active sensor is defined by active_rcs_sensors list
            active_sensor: rcsSettings?.active_rcs_sensors?.includes?.(sensorUUID) === true,
          }));
        }

        // Process each discovered sensor using the same mapping pipeline
        sensors.forEach((sensor) => {
          let sensorUUID = sensor?.sensorUUID;

          // Raw sensor resource, passed as `raw` into the translator
          let sensorRaw = rawData?.[sensorUUID];

          // Convenience reference to sensor payload
          let sensorValue = sensorRaw?.value;

          // Validate sensor resource exists and is well-formed
          if (
            typeof sensorUUID !== 'string' ||
            sensorUUID === '' ||
            typeof sensorRaw !== 'object' ||
            sensorRaw?.constructor !== Object ||
            typeof sensorValue !== 'object' ||
            sensorValue?.constructor !== Object
          ) {
            return;
          }

          // Google sensors must have a valid home UUID
          if (source === DATA_SOURCE.GOOGLE && typeof homeUUID !== 'string') {
            return;
          }

          // Nest sensors must have valid structure and where mapping for description resolution
          if (
            source === DATA_SOURCE.NEST &&
            ((sensorValue?.structure_id?.trim?.() ?? '') === '' || typeof rawData?.['where.' + sensorValue.structure_id] !== 'object')
          ) {
            return;
          }

          // Build mapped sensor object
          // `raw` represents the sensor resource inside TEMPSENSOR_FIELD_MAP
          storeCandidate(
            buildMappedObject(
              TEMPSENSOR_FIELD_MAP,
              createMappingContext(rawData, sensorUUID, source === DATA_SOURCE.GOOGLE ? { google: sensorRaw } : { nest: sensorRaw }, {
                // Unique sensor identifier
                sensorUUID: sensorUUID,

                // Home identifier differs between Google and Nest
                homeUUID: source === DATA_SOURCE.GOOGLE ? homeUUID : 'structure.' + sensorValue.structure_id,

                // Thermostat this sensor is associated with
                parentUUID: object_key,

                // Pairer UUID (only present for Google devices)
                pairerUUID: source === DATA_SOURCE.GOOGLE ? sensorValue?.device_info?.pairerId?.resourceId : undefined,

                // Whether this sensor is currently active for RCS
                active_sensor: sensor.active_sensor === true,
              }),
              changedData instanceof Map ? changedData.get(sensorUUID)?.fields : undefined,
            ),
            source,
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
