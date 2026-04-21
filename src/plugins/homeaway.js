// Nest Home/Away Sensor - HomeKit integration
// Part of homebridge-nest-accfactory
//
// Virtual HomeKit accessory representing Nest structure home/away status.
// Provides a single occupancy sensor that reflects whether the structure
// is currently marked as Home or Away by upstream Nest / Google APIs.
//
// Responsibilities:
// - Create a virtual Home/Away accessory per structure/home
// - Expose structure occupancy state via HomeKit OccupancySensor service
// - Normalise Nest and Google home/away state into a unified HomeKit model
// - Update HomeKit occupancy status when upstream structure mode changes
//
// Services:
// - OccupancySensor
//
// Features:
// - Structure-level virtual accessory (not tied to a physical Nest device)
// - Real-time HomeKit characteristic updates
// - Supports both Nest and Google APIs
// - Stable synthetic serial number derived from structure identity
//
// Notes:
// - This is a virtual device (not a physical Nest device)
// - One Home/Away accessory is created per structure/home
// - Occupancy detected = structure is Home
// - Occupancy not detected = structure is Away
// - Google and Nest API data are both supported and normalised
//
// Data Translation:
// - Raw data is mapped using HOMEAWAY_FIELD_MAP
// - processRawData() builds virtual devices from structure-level data
// - Nest and Google sources are normalised into a unified HomeKit model
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
  static VERSION = '2026.04.21'; // Code version

  occupancyService = undefined;

  // Class functions
  onAdd() {
    // Setup occupancy service if not already present on the accessory
    this.occupancyService = this.addHKService(this.hap.Service.OccupancySensor, '', 1);
  }

  onRemove() {
    this.accessory.removeService(this.occupancyService);
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
      fields: ['structure_info'],
      translate: ({ raw }) =>
        typeof raw?.value?.structure_info?.rtsStructureId === 'string' && raw.value.structure_info.rtsStructureId.trim() !== ''
          ? NESTLABS_MAC_PREFIX +
            crc24(DEVICE_TYPE.HOMEAWAY.toUpperCase() + ':' + raw.value.structure_info.rtsStructureId.trim().toUpperCase()).toUpperCase()
          : undefined,
    },
    nest: {
      fields: [],
      translate: ({ objectKey }) =>
        NESTLABS_MAC_PREFIX + crc24(DEVICE_TYPE.HOMEAWAY.toUpperCase() + ':' + objectKey.toUpperCase()).toUpperCase(),
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

  // Core required home/away fields
  occupancy: {
    required: true,
    google: {
      fields: ['structure_mode'],
      translate: ({ raw }) => raw?.value?.structure_mode?.structureMode === 'STRUCTURE_MODE_HOME',
    },
    nest: {
      fields: ['away'],
      translate: ({ raw }) => raw?.value?.away === false,
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
        // Map raw structure data into our normalised home/away schema
        let mappedResult = buildMappedObject(
          HOMEAWAY_FIELD_MAP,
          createMappingContext(rawData, object_key, {
            nest: value?.source === DATA_SOURCE.NEST ? value : undefined,
            google: value?.source === DATA_SOURCE.GOOGLE ? value : undefined,
          }),
          changedData instanceof Map ? changedData.get(object_key)?.fields : undefined,
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
