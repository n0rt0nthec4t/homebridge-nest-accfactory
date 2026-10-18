// Nest Home/Away Sensor - HomeKit integration
// Part of homebridge-nest-accfactory
//
// Virtual HomeKit accessory representing Nest structure home/away status.
// Provides a single occupancy sensor that reflects whether the structure
// is currently marked as Home or Away by the protobuf API.
//
// Responsibilities:
// - Create a virtual Home/Away accessory per structure/home
// - Expose structure occupancy state via HomeKit OccupancySensor service
// - Translate protobuf structure mode into HomeKit occupancy
// - Update HomeKit occupancy status when upstream structure mode changes
//
// Services:
// - OccupancySensor
//
// Features:
// - Structure-level virtual accessory (not tied to a physical Nest device)
// - Real-time HomeKit characteristic updates
// - Uses protobuf structure data only
// - Stable synthetic serial number derived from structure identity
//
// Notes:
// - This is a virtual device (not a physical Nest device)
// - One Home/Away accessory is created per structure/home
// - Occupancy detected = structure is Home
// - Occupancy not detected = structure is Away
// - REST structure data is ignored
//
// Data Translation:
// - Raw data is mapped using HOMEAWAY_FIELD_MAP
// - processRawData() builds virtual devices from structure-level data
// - Protobuf structure data is normalised into a HomeKit model
// - Serial number is derived from structure ID with a virtual device type prefix
//
// Mark Hulskamp
'use strict';

// Define our modules
import HomeKitDevice from '../HomeKitDevice.js';
import { crc24 } from '../utils.js';
import { buildMappedObject, createMappingContext } from '../translator.js';

// Define constants
import { DATA_SOURCE, DEVICE_TYPE, NESTLABS_MAC_PREFIX } from '../consts.js';

export default class NestHomeAway extends HomeKitDevice {
  static TYPE = DEVICE_TYPE.HOMEAWAY;
  static VERSION = '2026.10.18'; // Code version

  occupancyService = undefined;

  // Class functions
  onAdd() {
    // Setup occupancy service if not already present on the accessory
    this.occupancyService = this.addService(this.hap.Service.OccupancySensor, '', 1);
  }

  onRemove() {
    this.removeService(this.occupancyService);
    this.occupancyService = undefined;
  }

  onUpdate(deviceData) {
    if (typeof deviceData !== 'object' || deviceData?.constructor !== Object || this.occupancyService === undefined) {
      return;
    }

    // Update for away/home status. Away = no occupancy detected, Home = Occupancy Detected
    this.occupancyService.updateCharacteristic(
      this.hap.Characteristic.OccupancyDetected,
      deviceData.occupancy === true
        ? this.hap.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
        : this.hap.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
    );

    // Log away/home state changes
    if (typeof deviceData?.occupancy === 'boolean' && deviceData.occupancy !== this.deviceData.occupancy) {
      this?.log?.info?.('Home/Away on "%s" changed to "%s"', deviceData.description, deviceData.occupancy === true ? 'Home' : 'Away');
    }
  }
}

// Home/Away field translation map
// Maps raw source data -> normalised home/away device fields
// - fields: top-level raw fields this mapping depends on (for delta updates)
// - translate: converts raw -> candidate value
// - merge: combines source values into the final normalised value
const HOMEAWAY_FIELD_MAP = {
  // Identity fields
  serialNumber: {
    required: true,
    google: {
      // Use the legacy REST structure ID supplied by protobuf to preserve the existing synthetic serial number.
      // Include it on every delta so mode-only changes can reach the tracked accessory.
      fields: [],
      translate: ({ raw }) =>
        typeof raw?.value?.structure_info?.rtsStructureId === 'string' && raw.value.structure_info.rtsStructureId.trim() !== ''
          ? NESTLABS_MAC_PREFIX +
            crc24(DEVICE_TYPE.HOMEAWAY.toUpperCase() + ':' + raw.value.structure_info.rtsStructureId.trim().toUpperCase()).toUpperCase()
          : undefined,
    },
  },

  nest_google_device_uuid: {
    required: true,
    google: {
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
  },

  // Naming / descriptive fields
  description: {
    required: true,
    merge: ({ values }) =>
      HomeKitDevice.makeValidHKName(
        typeof values?.google === 'string' && values.google.trim() !== '' ? values.google.trim() : 'unknown description',
      ),
    google: {
      fields: ['structure_location', 'structure_info'],
      translate: ({ raw }) =>
        String(raw?.value?.structure_location?.city?.value ?? '').trim() !== '' &&
        String(raw?.value?.structure_location?.state?.value ?? '').trim() !== ''
          ? String(raw.value.structure_location.city.value).trim() + ' - ' + String(raw.value.structure_location.state.value).trim()
          : String(raw?.value?.structure_info?.name ?? '').trim() !== ''
            ? String(raw.value.structure_info.name).trim()
            : undefined,
    },
  },

  // Core required home/away fields
  occupancy: {
    required: true,
    google: {
      fields: ['structure_mode'],
      // Missing and unspecified modes are not evidence that the home is Away.
      translate: ({ raw }) => {
        let mode = raw?.value?.structure_mode?.structureMode;
        return ['STRUCTURE_MODE_HOME', 'STRUCTURE_MODE_AWAY', 'STRUCTURE_MODE_SLEEP', 'STRUCTURE_MODE_VACATION'].includes(mode) === true
          ? mode === 'STRUCTURE_MODE_HOME'
          : undefined;
      },
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
    .filter(([key, value]) => key.startsWith('STRUCTURE_') === true && value?.source === DATA_SOURCE.GOOGLE)
    .forEach(([object_key, value]) => {
      try {
        if (changedData instanceof Map && changedData.has(object_key) === false) {
          return;
        }

        // Required traits may arrive separately; map the affected structure from its complete cache.
        let mappedResult = buildMappedObject(
          HOMEAWAY_FIELD_MAP,
          createMappingContext(rawData, object_key, {
            google: value,
          }),
          new Set(Object.keys(value?.value ?? {})),
        );

        let serialNumber = mappedResult?.data?.serialNumber;
        let existingDevice = devices[serialNumber];

        // If we have all required fields, build a full home/away device
        if (mappedResult?.hasRequired === true) {
          let tempDevice = {
            type: DEVICE_TYPE.HOMEAWAY,
            model: 'Home/Away',
            manufacturer: 'Nest',
            softwareVersion: NestHomeAway.VERSION, // Use class version for consistency
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
        log?.error?.('Error processing home/away data for object "%s": %s', object_key, String(error));
      }
    });

  return devices;
}
