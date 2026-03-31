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
import { processCommonData, adjustTemperature, scaleValue } from '../utils.js';
import { buildMappedObject, createMappingContext } from '../translator.js';

// Define constants
import { LOW_BATTERY_LEVEL, DATA_SOURCE, PROTOBUF_RESOURCES, DEVICE_TYPE } from '../consts.js';

export default class NestTemperatureSensor extends HomeKitDevice {
  static TYPE = 'TemperatureSensor';
  static VERSION = '2026.04.01'; // Code version

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

// Data translation functions for temperature sensor data.
// We use this to translate RAW Nest and Google data into the format we want for our
// Nest Temperature Sensor device(s) using the field map below.
//
// This keeps all translation logic in one place and makes it easier to maintain as
// Nest and Google sources evolve over time.
//
// Field map conventions:
// - Return undefined for missing values rather than placeholder defaults
// - Let processRawData() decide if there is enough data to build the device
// - Let downstream code decide how to handle optional fields
//
// Temperature sensor field translation map
const TEMPSENSOR_FIELD_MAP = {
  nest_google_device_uuid: {
    google: ({ sensorUUID }) => sensorUUID,
    nest: ({ sensorUUID }) => sensorUUID,
  },

  nest_google_home_uuid: {
    google: ({ homeUUID }) => homeUUID,
    nest: ({ homeUUID }) => homeUUID,
  },

  serialNumber: {
    google: ({ sensorData }) =>
      typeof sensorData?.device_identity?.serialNumber === 'string' && sensorData.device_identity.serialNumber !== ''
        ? sensorData.device_identity.serialNumber
        : undefined,
    nest: ({ sensorData }) =>
      typeof sensorData?.serial_number === 'string' && sensorData.serial_number !== '' ? sensorData.serial_number : undefined,
  },

  description: {
    google: ({ sensorData }) => String(sensorData?.label?.label ?? ''),
    nest: ({ sensorData }) => String(sensorData?.description?.trim?.() ?? ''),
  },

  location: {
    google: ({ rawData, pairerUUID, sensorData }) =>
      String(
        [
          ...Object.values(rawData?.[pairerUUID]?.value?.located_annotations?.predefinedWheres || {}),
          ...Object.values(rawData?.[pairerUUID]?.value?.located_annotations?.customWheres || {}),
        ].find((where) => where?.whereId?.resourceId === sensorData?.device_located_settings?.whereAnnotationRid?.resourceId)?.label
          ?.literal ?? '',
      ),

    nest: ({ rawData, sensorData }) =>
      String(
        rawData?.['where.' + sensorData?.structure_id]?.value?.wheres?.find((where) => where?.where_id === sensorData?.where_id)?.name ??
          '',
      ),
  },

  battery_level: {
    google: ({ sensorData }) =>
      // CR2 lithium battery discharge range used by Nest Temperature Sensors
      // 3.2V ≈ fresh battery
      // ~2.6V ≈ low battery warning
      // 2.5V treated as empty
      isNaN(sensorData?.battery?.assessedVoltage?.value) === false
        ? scaleValue(Number(sensorData.battery.assessedVoltage.value), 2.5, 3.2, 0, 100)
        : undefined,

    nest: ({ sensorData }) =>
      // Nest API already reports battery as percentage (0–100)
      isNaN(sensorData?.battery_level) === false ? scaleValue(Number(sensorData.battery_level), 0, 100, 0, 100) : undefined,
  },

  current_temperature: {
    google: ({ sensorData }) =>
      // Google API reports temperature as nested protobuf value
      // temperatureValue.temperature.value (°C)
      isNaN(sensorData?.current_temperature?.temperatureValue?.temperature?.value) === false
        ? adjustTemperature(Number(sensorData.current_temperature.temperatureValue.temperature.value), 'C', 'C', true)
        : undefined,

    nest: ({ sensorData }) =>
      // Nest API reports temperature directly as °C
      isNaN(sensorData?.current_temperature) === false
        ? adjustTemperature(Number(sensorData.current_temperature), 'C', 'C', true)
        : undefined,
  },

  online: {
    google: ({ sensorData }) =>
      // Google API uses last beacon timestamp to indicate activity
      // Sensor considered offline if no beacon received within 4 hours
      isNaN(sensorData?.last_updated_beacon?.lastBeaconTime?.seconds) === false &&
      Math.floor(Date.now() / 1000) - Number(sensorData.last_updated_beacon.lastBeaconTime.seconds) < 3600 * 4,

    nest: ({ sensorData }) =>
      // Nest API reports last update timestamp directly
      // Same 4-hour threshold used for offline detection
      isNaN(sensorData?.last_updated_at) === false && Math.floor(Date.now() / 1000) - Number(sensorData.last_updated_at) < 3600 * 4,
  },

  associated_thermostat: {
    google: ({ parentUUID }) => parentUUID,
    nest: ({ parentUUID }) => parentUUID,
  },

  active_sensor: {
    google: ({ active_sensor }) =>
      // Indicates whether this temperature sensor is currently selected
      // by the thermostat's Remote Comfort Sensing feature
      active_sensor === true,

    nest: ({ active_sensor }) =>
      // Nest API reports active sensors via rcs_settings.active_rcs_sensors
      active_sensor === true,
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

  // Process data for any temperature sensors we have in the raw data
  // We do this using any thermostat data. Temperature sensors can come from either Google or Nest APIs,
  // with Google API data prioritised when sensors exist on both. Some thermostats may have sensors
  // that only exist on one API (e.g., 2 on Google + 1 on Nest), so both APIs are processed and sensors
  // are deduplicated by serialNumber to build a complete sensor list.
  let devices = {};
  let candidates = {};

  Object.entries(rawData)
    .filter(
      ([key, value]) =>
        key.startsWith('device.') === true ||
        (key.startsWith('DEVICE_') === true && PROTOBUF_RESOURCES.THERMOSTAT.includes(value.value?.device_info?.typeName) === true),
    )
    .forEach(([object_key, value]) => {
      try {
        if (
          value?.source === DATA_SOURCE.GOOGLE &&
          value.value?.configuration_done?.deviceReady === true &&
          rawData?.[value.value?.device_info?.pairerId?.resourceId] !== undefined &&
          Array.isArray(value.value?.remote_comfort_sensing_settings?.associatedRcsSensors) === true
        ) {
          value.value.remote_comfort_sensing_settings.associatedRcsSensors.forEach((sensor) => {
            if (typeof rawData?.[sensor?.deviceId?.resourceId]?.value !== 'object') {
              return;
            }

            let sensorUUID = sensor.deviceId.resourceId;
            let sensorData = rawData[sensorUUID].value;
            let mappedData = buildMappedObject(
              TEMPSENSOR_FIELD_MAP,
              createMappingContext(rawData, sensorUUID, undefined, value, {
                sensorUUID: sensorUUID,
                homeUUID: value.value.device_info.pairerId.resourceId,
                parentUUID: object_key,
                pairerUUID: sensorData?.device_info?.pairerId?.resourceId,
                sensorData: sensorData,
                active_sensor: value.value?.remote_comfort_sensing_settings?.activeRcsSelection?.activeRcsSensor?.resourceId === sensorUUID,
              }),
            );

            if (
              mappedData.serialNumber !== undefined &&
              mappedData.current_temperature !== undefined &&
              mappedData.battery_level !== undefined &&
              mappedData.nest_google_device_uuid !== undefined &&
              mappedData.nest_google_home_uuid !== undefined
            ) {
              candidates[mappedData.serialNumber] = {
                type: DEVICE_TYPE.TEMPSENSOR,
                model: 'Temperature Sensor',
                softwareVersion: NestTemperatureSensor.VERSION,
                ...mappedData,
              };
            }
          });
        }

        if (
          value?.source === DATA_SOURCE.NEST &&
          Array.isArray(rawData?.['rcs_settings.' + value.value?.serial_number]?.value?.associated_rcs_sensors) === true
        ) {
          rawData['rcs_settings.' + value.value.serial_number].value.associated_rcs_sensors.forEach((sensor) => {
            if (
              typeof rawData?.[sensor]?.value !== 'object' ||
              (rawData?.[sensor]?.value?.structure_id?.trim() ?? '') === '' ||
              typeof rawData?.['where.' + rawData[sensor].value.structure_id] !== 'object'
            ) {
              return;
            }

            let sensorData = rawData[sensor].value;
            let mappedData = buildMappedObject(
              TEMPSENSOR_FIELD_MAP,
              createMappingContext(rawData, sensor, value, undefined, {
                sensorUUID: sensor,
                homeUUID: 'structure.' + sensorData.structure_id,
                parentUUID: object_key,
                pairerUUID: undefined,
                sensorData: sensorData,
                active_sensor:
                  rawData?.['rcs_settings.' + value.value.serial_number]?.value?.active_rcs_sensors?.includes?.(sensor) === true,
              }),
            );

            if (
              mappedData.serialNumber !== undefined &&
              mappedData.current_temperature !== undefined &&
              mappedData.battery_level !== undefined &&
              mappedData.nest_google_device_uuid !== undefined &&
              mappedData.nest_google_home_uuid !== undefined &&
              candidates[mappedData.serialNumber] === undefined
            ) {
              candidates[mappedData.serialNumber] = {
                type: DEVICE_TYPE.TEMPSENSOR,
                model: 'Temperature Sensor',
                softwareVersion: NestTemperatureSensor.VERSION,
                ...mappedData,
              };
            }
          });
        }

        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        log?.debug?.('Error processing temperature sensor data for "%s"', object_key);
      }
    });

  Object.values(candidates).forEach((candidate) => {
    let tempDevice = processCommonData(
      candidate.nest_google_device_uuid,
      candidate.nest_google_home_uuid,
      {
        ...candidate,
      },
      config,
    );

    if (
      Object.entries(tempDevice).length !== 0 &&
      (deviceType === undefined || (typeof deviceType === 'string' && deviceType !== '' && tempDevice.type === deviceType))
    ) {
      let deviceOptions = config?.devices?.find(
        (device) => device?.serialNumber?.toUpperCase?.() === tempDevice?.serialNumber?.toUpperCase?.(),
      );
      //eslint-disable-next-line no-unused-vars
      let homeOptions = config?.homes?.find(
        (home) =>
          home?.nest_home_uuid?.toUpperCase?.() === tempDevice?.nest_google_home_uuid?.toUpperCase?.() ||
          home?.google_home_uuid?.toUpperCase?.() === tempDevice?.nest_google_home_uuid?.toUpperCase?.(),
      );

      tempDevice.eveHistory =
        deviceOptions?.eveHistory !== undefined ? deviceOptions.eveHistory === true : config.options?.eveHistory === true;

      devices[tempDevice.serialNumber] = tempDevice;
    }
  });

  return devices;
}
