// Nest Temperature Sensor
// Part of homebridge-nest-accfactory
//
// Mark Hulskamp
'use strict';

// Define our modules
import HomeKitDevice from '../HomeKitDevice.js';
import { processCommonData, adjustTemperature, scaleValue } from '../utils.js';

// Define constants
import { LOW_BATTERY_LEVEL, DATA_SOURCE, PROTOBUF_RESOURCES, DEVICE_TYPE } from '../consts.js';

export default class NestTemperatureSensor extends HomeKitDevice {
  static TYPE = 'TemperatureSensor';
  static VERSION = '2026.03.10'; // Code version

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
    if (typeof deviceData !== 'object' || this.temperatureService === undefined || this.batteryService === undefined) {
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
  Object.entries(rawData)
    .filter(
      ([key, value]) =>
        key.startsWith('device.') === true ||
        (key.startsWith('DEVICE_') === true && PROTOBUF_RESOURCES.THERMOSTAT.includes(value.value?.device_info?.typeName) === true),
    )
    .forEach(([object_key, value]) => {
      try {
        // Process Google API temperature sensors for this thermostat
        if (
          value?.source === DATA_SOURCE.GOOGLE &&
          value.value?.configuration_done?.deviceReady === true &&
          rawData?.[value.value?.device_info?.pairerId?.resourceId] !== undefined &&
          Array.isArray(value.value?.remote_comfort_sensing_settings?.associatedRcsSensors) === true
        ) {
          value.value.remote_comfort_sensing_settings.associatedRcsSensors.forEach((sensor) => {
            if (typeof rawData?.[sensor?.deviceId?.resourceId]?.value === 'object') {
              let sensorData = rawData[sensor.deviceId.resourceId].value;
              let tempDevice = processCommonData(
                sensor.deviceId.resourceId,
                value.value.device_info.pairerId.resourceId,
                {
                  type: DEVICE_TYPE.TEMPSENSOR,
                  model: 'Temperature Sensor',
                  softwareVersion: NestTemperatureSensor.VERSION, // We'll use our class version here now
                  serialNumber: sensorData.device_identity.serialNumber,
                  description: String(sensorData?.label?.label ?? ''),
                  location: String(
                    [
                      ...Object.values(
                        rawData?.[sensorData?.device_info?.pairerId?.resourceId]?.value?.located_annotations?.predefinedWheres || {},
                      ),
                      ...Object.values(
                        rawData?.[sensorData?.device_info?.pairerId?.resourceId]?.value?.located_annotations?.customWheres || {},
                      ),
                    ].find((where) => where?.whereId?.resourceId === sensorData?.device_located_settings?.whereAnnotationRid?.resourceId)
                      ?.label?.literal ?? '',
                  ),
                  // CR2 lithium battery discharge range used by Nest Temperature Sensors
                  // 3.2V ≈ fresh, ~2.6V ≈ low battery warning, 2.5V treated as empty
                  battery_level: scaleValue(Number(sensorData.battery.assessedVoltage.value), 2.5, 3.2, 0, 100),
                  current_temperature: adjustTemperature(sensorData.current_temperature.temperatureValue.temperature.value, 'C', 'C', true),
                  online:
                    isNaN(sensorData?.last_updated_beacon?.lastBeaconTime?.seconds) === false &&
                    Math.floor(Date.now() / 1000) - Number(sensorData.last_updated_beacon.lastBeaconTime.seconds) < 3600 * 4,
                  associated_thermostat: object_key,
                  active_sensor:
                    value.value?.remote_comfort_sensing_settings?.activeRcsSelection?.activeRcsSensor?.resourceId ===
                    sensor.deviceId.resourceId,
                },
                config,
              );

              if (
                Object.entries(tempDevice).length !== 0 &&
                typeof devices[tempDevice.serialNumber] === 'undefined' &&
                (deviceType === undefined || (typeof deviceType === 'string' && deviceType !== '' && tempDevice.type === deviceType))
              ) {
                // Deduplicate by serialNumber: Google API data processed first takes priority
                let deviceOptions = config?.devices?.find(
                  (device) => device?.serialNumber?.toUpperCase?.() === tempDevice?.serialNumber?.toUpperCase?.(),
                );
                let homeOptions = config?.homes?.find(
                  (home) => home?.google_home_uuid?.toUpperCase?.() === value.value.device_info.pairerId.resourceId.toUpperCase?.(),
                );

                // Insert any extra options we've read in from configuration file for this device
                tempDevice.eveHistory =
                  deviceOptions?.eveHistory !== undefined
                    ? deviceOptions.eveHistory === true
                    : homeOptions?.eveHistory !== undefined
                      ? homeOptions.eveHistory === true
                      : config.options?.eveHistory === true;

                devices[tempDevice.serialNumber] = tempDevice; // Store processed device
              }
            }
          });
        }

        // Process Nest API temperature sensors for this thermostat
        // Skipped if sensor already processed from Google API (serialNumber uniqueness check below prevents duplicates)
        // This ensures complete sensor coverage when some sensors only exist on Nest API
        if (
          value?.source === DATA_SOURCE.NEST &&
          Array.isArray(rawData?.['rcs_settings.' + value.value?.serial_number]?.value?.associated_rcs_sensors) === true
        ) {
          rawData['rcs_settings.' + value.value.serial_number].value.associated_rcs_sensors.forEach((sensor) => {
            if (
              typeof rawData[sensor]?.value === 'object' &&
              (rawData?.[sensor]?.value?.structure_id?.trim() ?? '') !== '' &&
              typeof rawData?.['where.' + rawData[sensor].value.structure_id] === 'object'
            ) {
              let sensorData = rawData[sensor].value;
              let tempDevice = processCommonData(
                sensor,
                'structure.' + rawData[sensor].value.structure_id,
                {
                  type: DEVICE_TYPE.TEMPSENSOR,
                  model: 'Temperature Sensor',
                  softwareVersion: NestTemperatureSensor.VERSION, // We'll use our class version here now
                  serialNumber: sensorData.serial_number,
                  battery_level: scaleValue(Number(sensorData.battery_level), 0, 100, 0, 100),
                  current_temperature: adjustTemperature(sensorData.current_temperature, 'C', 'C', true),
                  online: Math.floor(Date.now() / 1000) - sensorData.last_updated_at < 3600 * 4,
                  associated_thermostat: object_key,
                  description: String(sensorData.description?.trim() ?? ''),
                  location: String(
                    rawData?.['where.' + sensorData.structure_id]?.value?.wheres?.find((where) => where?.where_id === sensorData.where_id)
                      ?.name ?? '',
                  ),
                  active_sensor:
                    rawData?.['rcs_settings.' + value.value.serial_number]?.value?.active_rcs_sensors?.includes?.(object_key) === true,
                },
                config,
              );

              if (
                Object.entries(tempDevice).length !== 0 &&
                typeof devices[tempDevice.serialNumber] === 'undefined' &&
                (deviceType === undefined || (typeof deviceType === 'string' && deviceType !== '' && tempDevice.type === deviceType))
              ) {
                // Deduplicate by serialNumber: Nest API fills gaps left by Google API (if not already processed)
                let deviceOptions = config?.devices?.find(
                  (device) => device?.serialNumber?.toUpperCase?.() === tempDevice?.serialNumber?.toUpperCase?.(),
                );
                let homeOptions = config?.homes?.find(
                  (home) => home?.nest_home_uuid?.toUpperCase?.() === 'structure.' + rawData[sensor].value.structure_id?.toUpperCase?.(),
                );

                // Insert any extra options we've read in from configuration file for this device
                tempDevice.eveHistory =
                  deviceOptions?.eveHistory !== undefined
                    ? deviceOptions.eveHistory === true
                    : homeOptions?.eveHistory !== undefined
                      ? homeOptions.eveHistory === true
                      : config.options?.eveHistory === true;

                devices[tempDevice.serialNumber] = tempDevice; // Store processed device
              }
            }
          });
        }
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        log?.debug?.('Error processing temperature sensor data for "%s"', object_key);
      }
    });

  return devices;
}
