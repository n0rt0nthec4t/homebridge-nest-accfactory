// Nest x Yale Lock (inital class - still todo)
// Part of homebridge-nest-accfactory
//
// Mark Hulskamp
'use strict';

// Define our modules
import HomeKitDevice from '../HomeKitDevice.js';
import { getDeviceLocationName, processCommonData } from '../utils.js';

// Define constants
import { DATA_SOURCE, DEVICE_TYPE, PROTOBUF_YALE_RESOURCES } from '../consts.js';

export default class NestLock extends HomeKitDevice {
  static TYPE = 'Lock';
  static VERSION = '2025.07.24'; // Code version

  lockService = undefined;
  batteryService = undefined;

  onAdd() {
    // Setup lock service if not already present on the accessory and link it to the Eve app if configured to do so
    this.lockService = this.addHKService(this.hap.Service.LockMechanism, '', 1, {});
    this.lockService.setPrimaryService();

    // Setup battery service if not already present on the accessory
    this.batteryService = this.addHKService(this.hap.Service.Battery, '', 1);
    this.batteryService.setHiddenService(true);
  }

  onRemove() {
    this.accessory.removeService(this.lockService);
    this.accessory.removeService(this.batteryService);
    this.lockService = undefined;
    this.batteryService = undefined;
  }

  onUpdate(deviceData) {
    if (typeof deviceData !== 'object') {
      return;
    }
  }
}

// Function to process our RAW Nest or Google for this device type
export function processRawData(rawData, config, deviceType = undefined, deviceUUID = undefined) {
  if (
    rawData === null ||
    typeof rawData !== 'object' ||
    rawData?.constructor !== Object ||
    typeof config !== 'object' ||
    config?.constructor !== Object
  ) {
    return;
  }

  // Process data for any thermostat(s) we have in the raw data
  let devices = {};
  Object.entries(rawData)
    .filter(
      ([key, value]) =>
        (key.startsWith('yale.') === true ||
          (key.startsWith('DEVICE_') === true && PROTOBUF_YALE_RESOURCES.includes(value.value?.device_info?.typeName) === true)) &&
        (deviceUUID === undefined || deviceUUID === key),
    )
    .forEach(([object_key, value]) => {
      let tempDevice = {};
      try {
        if (
          value?.source === DATA_SOURCE.GOOGLE &&
          config.options?.useGoogleAPI === true &&
          value.value?.configuration_done?.deviceReady === true
        ) {
          // eslint-disable-next-line no-undef
          console.log('Nest x Yale - protobuf api data', value.value);
          tempDevice = processCommonData(
            object_key,
            {
              type: DEVICE_TYPE.LOCK,
              model: 'x Yale',
              softwareVersion: value.value.device_identity.softwareVersion,
              serialNumber: value.value.device_identity.serialNumber,
              description: typeof value.value?.label?.label === 'string' ? value.value.label.label : '',
              location: getDeviceLocationName(
                rawData,
                value.value?.device_info?.pairerId?.resourceId,
                value.value?.device_located_settings?.whereAnnotationRid?.resourceId,
              ),
            },
            config,
          );
        }

        if (value?.source === DATA_SOURCE.NEST && config.options?.useNestAPI === true && value.value?.where_id !== undefined) {
          // eslint-disable-next-line no-undef
          console.log('Nest x Yale - nest api data', value.value);
          tempDevice = processCommonData(
            object_key,
            {
              type: DEVICE_TYPE.LOCK,
              model: 'x Yale',
              softwareVersion: value.value.current_version,
              serialNumber: value.value.serialNumber,
              description: value.value?.description,
              location: getDeviceLocationName(rawData, value.value.structure_id, value.value.where_id),
            },
            config,
          );
        }
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        // Empty
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

        // devices[tempDevice.serialNumber] = tempDevice; // Store processed device
      }
    });

  return devices;
}
