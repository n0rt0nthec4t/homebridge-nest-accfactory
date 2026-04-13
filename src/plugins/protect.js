// Nest Protect - HomeKit integration
// Part of homebridge-nest-accfactory
//
// HomeKit accessory implementation for Nest Protect devices.
// Provides smoke and carbon monoxide detection, battery monitoring,
// alarm state handling, and activity tracking using Nest and Google APIs.
//
// Responsibilities:
// - Expose smoke and carbon monoxide detection via HomeKit services
// - Synchronise alarm states with HomeKit (smoke, CO, test events)
// - Monitor battery status and low battery conditions
// - Report device status (online/offline, fault conditions)
// - Record event history for Eve Home integration
//
// Services:
// - SmokeSensor
// - CarbonMonoxideSensor
// - Battery (hidden, for battery level and low battery alerts)
//
// Features:
// - Real-time smoke and CO alarm state synchronisation
// - Support for alarm test events
// - Battery monitoring with low battery alerts
// - Device online/offline state tracking
// - Eve Home history integration
//
// Notes:
// - Supports both Nest and Google APIs depending on device/account type
// - Alarm states are normalised before presentation to HomeKit
// - HomeKit does not differentiate alarm sources beyond service type
//
// Data Translation:
// - Raw API data is mapped using PROTECT_FIELD_MAP
// - processRawData() builds device objects and applies configuration overrides
// - Field mapping isolates upstream API differences from HomeKit representation
//
// Mark Hulskamp
'use strict';

// Define our modules
import HomeKitDevice from '../HomeKitDevice.js';
import { processCommonData, scaleValue } from '../utils.js';
import { buildMappedObject, createMappingContext } from '../translator.js';

// Define constants
import { LOW_BATTERY_LEVEL, DATA_SOURCE, PROTOBUF_RESOURCES, DEVICE_TYPE } from '../consts.js';

export default class NestProtect extends HomeKitDevice {
  static TYPE = 'Protect';
  static VERSION = '2026.04.12'; // Code version

  batteryService = undefined;
  smokeService = undefined;
  motionService = undefined;
  carbonMonoxideService = undefined;

  // Class functions
  onAdd() {
    // Setup the smoke sensor service if not already present on the accessory
    this.smokeService = this.addHKService(this.hap.Service.SmokeSensor, '', 1, {
      messages: this.message.bind(this),
      EveSmoke_lastalarmtest: this.deviceData.latest_alarm_test,
      EveSmoke_alarmtest: this.deviceData.self_test_in_progress,
      EveSmoke_heatstatus: this.deviceData.heat_status,
      EveSmoke_hushedstate: this.deviceData.hushed_state,
      EveSmoke_statusled: this.deviceData.ntp_green_led_enable,
      EveSmoke_smoketestpassed: this.deviceData.smoke_test_passed,
      EveSmoke_heattestpassed: this.deviceData.heat_test_passed,
    });
    this.smokeService.setPrimaryService();

    this.addHKCharacteristic(this.smokeService, this.hap.Characteristic.StatusActive);
    this.addHKCharacteristic(this.smokeService, this.hap.Characteristic.StatusFault);

    // Setup the carbon monoxide service if not already present on the accessory
    this.carbonMonoxideService = this.addHKService(this.hap.Service.CarbonMonoxideSensor, '', 1);

    // Setup battery service if not already present on the accessory
    this.batteryService = this.addHKService(this.hap.Service.Battery, '', 1);
    this.batteryService.setHiddenService(true);

    // Setup motion service if not already present on the accessory and Nest protect is a wired version
    if (this.deviceData?.wired_or_battery === false) {
      this.motionService = this.addHKService(this.hap.Service.MotionSensor, '', 1);
      this.motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, false); // No motion initially
      this.postSetupDetail('With motion sensor');
    }
  }

  onRemove() {
    this.accessory.removeService(this.smokeService);
    this.accessory.removeService(this.carbonMonoxideService);
    this.accessory.removeService(this.batteryService);
    this.accessory.removeService(this.motionService);
    this.smokeService = undefined;
    this.carbonMonoxideService = undefined;
    this.batteryService = undefined;
    this.motionService = undefined;
  }

  onShutdown() {
    // Clear motion sensor on shutdown to prevent stale status in HomeKit after restart
    if (this.motionService !== undefined) {
      this.motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);
    }
  }

  onUpdate(deviceData) {
    if (
      typeof deviceData !== 'object' ||
      deviceData?.constructor !== Object ||
      this.smokeService === undefined ||
      this.carbonMonoxideService === undefined ||
      this.batteryService === undefined
    ) {
      return;
    }

    // Update battery level and status
    if (deviceData.battery_level !== undefined) {
      this.batteryService.updateCharacteristic(this.hap.Characteristic.BatteryLevel, deviceData.battery_level);
      this.batteryService.updateCharacteristic(
        this.hap.Characteristic.StatusLowBattery,
        deviceData.battery_level > LOW_BATTERY_LEVEL
          ? this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
          : this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW,
      );
    }
    this.batteryService.updateCharacteristic(this.hap.Characteristic.ChargingState, this.hap.Characteristic.ChargingState.NOT_CHARGEABLE);

    // Update smoke details
    // If protect isn't online, replacement date past, report in HomeKit
    this.smokeService.updateCharacteristic(
      this.hap.Characteristic.StatusActive,
      deviceData.online === true && Math.floor(Date.now() / 1000) <= deviceData.replacement_date,
    );

    this.smokeService.updateCharacteristic(
      this.hap.Characteristic.StatusFault,
      deviceData.online === true && Math.floor(Date.now() / 1000) <= deviceData.replacement_date
        ? this.hap.Characteristic.StatusFault.NO_FAULT
        : this.hap.Characteristic.StatusFault.GENERAL_FAULT,
    );

    this.smokeService.updateCharacteristic(
      this.hap.Characteristic.SmokeDetected,
      deviceData.smoke_status === true
        ? this.hap.Characteristic.SmokeDetected.SMOKE_DETECTED
        : this.hap.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED,
    );

    if (deviceData.smoke_status === true && this.deviceData.smoke_status === false) {
      this?.log?.warn?.('Smoke detected in "%s"', deviceData.description);
    }

    if (deviceData.smoke_status === false && this.deviceData.smoke_status === true) {
      this?.log?.info?.('Smoke is no longer detected in "%s"', deviceData.description);
    }

    // Update carbon monoxide details
    this.carbonMonoxideService.updateCharacteristic(
      this.hap.Characteristic.CarbonMonoxideDetected,
      deviceData.co_status === true
        ? this.hap.Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL
        : this.hap.Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL,
    );

    if (deviceData.co_status === true && this.deviceData.co_status === false) {
      this?.log?.warn?.('Abnormal carbon monoxide levels detected in "%s"', deviceData.description);
    }

    if (deviceData.co_status === false && this.deviceData.co_status === true) {
      this?.log?.info?.('Carbon monoxide levels have returned to normal in "%s"', deviceData.description);
    }

    // Update self testing details
    if (deviceData.self_test_in_progress === true && this.deviceData.self_test_in_progress === false) {
      this?.log?.warn?.('Smoke and Carbon monoxide sensor testing has started in "%s"', deviceData.description);
    }

    if (deviceData.self_test_in_progress === false && this.deviceData.self_test_in_progress === true) {
      this?.log?.info?.('Smoke and Carbon monoxide sensor testing completed in "%s"', deviceData.description);
    }

    // Update motion service if present
    if (this.motionService !== undefined) {
      this.motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, deviceData.detected_motion === true);

      if (this.deviceData?.logMotionEvents === true && deviceData?.detected_motion === true && this.deviceData?.detected_motion !== true) {
        this?.log?.info?.('Motion detected in "%s"', deviceData.description);
      }

      // Log motion to history only if changed to previous recording
      this.history(this.motionService, {
        status: deviceData.detected_motion === true ? 1 : 0,
      });
    }

    // Update our internal data with properties Eve will need to process then Notify Eve App of device status changes if linked
    this.deviceData.latest_alarm_test = deviceData.latest_alarm_test;
    this.deviceData.self_test_in_progress = deviceData.self_test_in_progress;
    this.deviceData.heat_status = deviceData.heat_status;
    this.deviceData.ntp_green_led_enable = deviceData.ntp_green_led_enable;
    this.deviceData.smoke_test_passed = deviceData.smoke_test_passed;
    this.deviceData.heat_test_passed = deviceData.heat_test_passed;
    this.historyService?.updateEveHome?.(this.smokeService);
  }

  onMessage(type, message) {
    if (typeof type !== 'string' || type === '' || typeof message !== 'object' || message === '') {
      return;
    }

    if (type === HomeKitDevice?.EVEHOME?.GET) {
      // Pass back extra data for Eve Smoke onGet() to process command
      // Data will already be an object, our only job is to add/modify to it
      message.lastalarmtest = this.deviceData.latest_alarm_test;
      message.alarmtest = this.deviceData.self_test_in_progress;
      message.heatstatus = this.deviceData.heat_status;
      message.statusled = this.deviceData.ntp_green_led_enable;
      message.smoketestpassed = this.deviceData.smoke_test_passed;
      message.heattestpassed = this.deviceData.heat_test_passed;
      message.hushedstate = this.deviceData.hushed_state;
      return message;
    }

    if (type === HomeKitDevice?.EVEHOME?.SET) {
      if (typeof message?.alarmtest === 'boolean') {
        // TODO - How do we trigger an alarm test :-)
        //this?.log?.info?.('Eve Smoke Alarm test', (message.alarmtest === true ? 'start' : 'stop'));
      }
      if (typeof message?.statusled === 'boolean') {
        this.set({ uuid: this.deviceData.nest_google_device_uuid, ntp_green_led_enable: message.statusled });
      }
    }
  }
}

// Data translation functions for Nest Protect data.
// We use this to translate RAW Nest and Google data into the format we want for our
// Protect device(s) using the field map below.
//
// This keeps all translation logic in one place and makes it easier to maintain as
// Nest and Google sources evolve over time.
//
// Field map conventions:
// - Return undefined for missing values rather than placeholder defaults
// - processRawData() determines if enough data exists to build the device
// - Optional fields may remain undefined
//
// Protect field translation map
const PROTECT_FIELD_MAP = {
  // Identity fields
  serialNumber: {
    google: ({ sourceValue }) =>
      typeof sourceValue?.value?.device_identity?.serialNumber === 'string' && sourceValue.value.device_identity.serialNumber.trim() !== ''
        ? sourceValue.value.device_identity.serialNumber
        : undefined,
    nest: ({ sourceValue }) =>
      typeof sourceValue?.value?.serial_number === 'string' && sourceValue.value.serial_number.trim() !== ''
        ? sourceValue.value.serial_number
        : undefined,
  },

  nest_google_device_uuid: {
    google: ({ objectKey }) => objectKey,
    nest: ({ objectKey }) => objectKey,
  },

  nest_google_home_uuid: {
    google: ({ sourceValue }) => sourceValue?.value?.device_info?.pairerId?.resourceId,
    nest: ({ sourceValue }) => 'structure.' + sourceValue?.value?.structure_id,
  },

  // Naming / descriptive fields
  model: {
    google: ({ sourceValue }) => {
      let typeName = sourceValue?.value?.device_info?.typeName ?? '';

      return typeName === 'nest.resource.NestProtect1LinePoweredResource'
        ? 'Protect (1st gen, wired)'
        : typeName === 'nest.resource.NestProtect1BatteryPoweredResource'
          ? 'Protect (1st gen, battery)'
          : typeName === 'nest.resource.NestProtect2LinePoweredResource'
            ? 'Protect (2nd gen, wired)'
            : typeName === 'nest.resource.NestProtect2BatteryPoweredResource'
              ? 'Protect (2nd gen, battery)'
              : 'Protect (unknown)';
    },

    nest: ({ sourceValue }) => {
      let model =
        sourceValue?.value?.serial_number?.substring?.(0, 2) === '06'
          ? 'Protect (2nd gen)'
          : sourceValue?.value?.serial_number?.substring?.(0, 2) === '05'
            ? 'Protect (1st gen)'
            : 'Protect (unknown)';

      return sourceValue?.value?.wired_or_battery === true
        ? model.replace(/\bgen\)/, 'gen, battery)')
        : sourceValue?.value?.wired_or_battery === false
          ? model.replace(/\bgen\)/, 'gen, wired)')
          : model;
    },
  },

  softwareVersion: {
    google: ({ sourceValue }) => sourceValue?.value?.device_identity?.softwareVersion,
    nest: ({ sourceValue }) => sourceValue?.value?.software_version,
  },

  description: {
    google: ({ sourceValue }) => String(sourceValue?.value?.label?.label ?? ''),
    nest: ({ sourceValue }) => String(sourceValue?.value?.description ?? ''),
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
        rawData?.['where.' + sourceValue?.value?.structure_id]?.value?.wheres?.find(
          (where) => where?.where_id === sourceValue?.value?.where_id,
        )?.name ?? '',
      ),
  },

  // Core state
  online: {
    google: ({ sourceValue }) => sourceValue?.value?.liveness?.status === 'LIVENESS_DEVICE_STATUS_ONLINE',
    nest: ({ rawData, sourceValue }) =>
      rawData?.['widget_track.' + sourceValue?.value?.thread_mac_address?.toUpperCase?.()]?.value?.online === true,
  },

  line_power_present: {
    google: ({ sourceValue }) => sourceValue?.value?.wall_power?.status === 'POWER_SOURCE_STATUS_ACTIVE',
    nest: ({ sourceValue }) => sourceValue?.value?.line_power_present === true,
  },

  wired_or_battery: {
    // Device power source:
    // true  = battery powered
    // false = wired / mains powered
    google: ({ sourceValue }) => sourceValue?.value?.wall_power?.present !== true,
    nest: ({ sourceValue }) => sourceValue?.value?.wired_or_battery === 1,
  },

  battery_level: {
    google: ({ sourceValue }) => {
      let bank0 =
        isNaN(sourceValue?.value?.battery_voltage_bank0?.batteryValue?.batteryVoltage?.value) === false &&
        Number(sourceValue.value.battery_voltage_bank0.batteryValue.batteryVoltage.value) > 0
          ? Number(sourceValue.value.battery_voltage_bank0.batteryValue.batteryVoltage.value)
          : undefined;

      let bank1 =
        isNaN(sourceValue?.value?.battery_voltage_bank1?.batteryValue?.batteryVoltage?.value) === false &&
        Number(sourceValue.value.battery_voltage_bank1.batteryValue.batteryVoltage.value) > 0
          ? Number(sourceValue.value.battery_voltage_bank1.batteryValue.batteryVoltage.value)
          : undefined;

      // Battery-powered Protects expose two battery banks. The reported value
      // closely matches the Nest API value but is in volts instead of millivolts
      // (e.g. 5.137 ↔ 5137). Use the minimum of both banks if available.
      let voltage =
        isNaN(bank0) === false && isNaN(bank1) === false
          ? Math.min(bank0, bank1)
          : isNaN(bank0) === false
            ? bank0
            : isNaN(bank1) === false
              ? bank1
              : undefined;

      // Scale Protect battery voltage to HomeKit percentage. The typical range
      // for the lithium cells is ~4.5V (empty) to ~5.4V (fresh).
      return isNaN(voltage) === false ? scaleValue(voltage, 4.5, 5.4, 0, 100) : undefined;
    },

    nest: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.battery_level) === false && Number(sourceValue.value.battery_level) > 0
        ? scaleValue(Number(sourceValue.value.battery_level), 4500, 5400, 0, 100)
        : undefined,
  },

  smoke_status: {
    google: ({ sourceValue }) => sourceValue?.value?.safety_alarm_smoke?.alarmState === 'ALARM_STATE_ALARM',
    nest: ({ sourceValue }) => sourceValue?.value?.smoke_status !== 0,
  },

  co_status: {
    google: ({ sourceValue }) => sourceValue?.value?.safety_alarm_co?.alarmState === 'ALARM_STATE_ALARM',
    nest: ({ sourceValue }) => sourceValue?.value?.co_status !== 0,
  },

  heat_status: {
    google: () => false, // TODO <- need to find in protobuf
    nest: ({ sourceValue }) => sourceValue?.value?.heat_status !== 0,
  },

  hushed_state: {
    google: ({ sourceValue }) =>
      sourceValue?.value?.safety_alarm_smoke?.silenceState === 'SILENCE_STATE_SILENCED' ||
      sourceValue?.value?.safety_alarm_co?.silenceState === 'SILENCE_STATE_SILENCED',
    nest: ({ sourceValue }) => sourceValue?.value?.hushed_state === true,
  },

  ntp_green_led_enable: {
    google: ({ sourceValue }) => sourceValue?.value?.night_time_promise_settings?.greenLedEnabled === true,
    nest: ({ sourceValue }) => sourceValue?.value?.ntp_green_led_enable === true,
  },

  smoke_test_passed: {
    google: ({ sourceValue }) =>
      sourceValue?.value?.safety_summary?.warningDevices?.failures?.includes?.('FAILURE_TYPE_SMOKE') === false
        ? true
        : typeof sourceValue?.value?.smoke !== 'object'
          ? undefined
          : sourceValue?.value?.smoke?.infraredLedFault === undefined || sourceValue?.value?.smoke?.blueLedFault === undefined
            ? true
            : sourceValue?.value?.smoke?.infraredLedFault?.type === 'SMOKE_FAULT_TYPE_NONE' &&
              sourceValue?.value?.smoke?.blueLedFault?.type === 'SMOKE_FAULT_TYPE_NONE',
    nest: ({ sourceValue }) => sourceValue?.value?.component_smoke_test_passed === true,
  },

  heat_test_passed: {
    google: ({ sourceValue }) =>
      sourceValue?.value?.safety_summary?.warningDevices?.failures?.includes?.('FAILURE_TYPE_TEMP') === false
        ? true
        : typeof sourceValue?.value?.passive_infrared !== 'object'
          ? undefined
          : sourceValue?.value?.passive_infrared?.faultInformation === undefined
            ? true
            : sourceValue?.value?.passive_infrared?.faultInformation?.type === 'PASSIVE_INFRARED_FAULT_TYPE_NONE',
    nest: ({ sourceValue }) => sourceValue?.value?.component_temp_test_passed === true,
  },

  co_test_passed: {
    google: ({ sourceValue }) =>
      typeof sourceValue?.value?.carbon_monoxide !== 'object'
        ? undefined
        : sourceValue?.value?.carbon_monoxide?.faultInformation === undefined
          ? true
          : sourceValue?.value?.carbon_monoxide?.faultInformation?.type === 'CO_FAULT_TYPE_NONE',
    nest: ({ sourceValue }) => sourceValue?.value?.component_co_test_passed === true,
  },

  latest_alarm_test: {
    google: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.self_test?.lastMstEnd?.seconds) === false
        ? Number(sourceValue.value.self_test.lastMstEnd.seconds)
        : undefined,
    nest: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.latest_manual_test_end_utc_secs) === false
        ? Number(sourceValue.value.latest_manual_test_end_utc_secs)
        : undefined,
  },

  self_test_in_progress: {
    google: ({ sourceValue }) =>
      sourceValue?.value?.legacy_structure_self_test?.mstInProgress === true ||
      sourceValue?.value?.legacy_structure_self_test?.astInProgress === true,
    nest: ({ rawData, sourceValue }) =>
      rawData?.['safety.' + sourceValue?.value?.structure_id]?.value?.manual_self_test_in_progress === true,
  },

  replacement_date: {
    google: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.legacy_protect_device_settings?.replaceByDate?.seconds) === false
        ? Number(sourceValue.value.legacy_protect_device_settings.replaceByDate.seconds)
        : undefined,
    nest: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.replace_by_date_utc_secs) === false ? Number(sourceValue.value.replace_by_date_utc_secs) : undefined,
  },

  topaz_hush_key: {
    google: ({ sourceValue }) =>
      typeof sourceValue?.value?.safety_structure_settings?.structureHushKey === 'string'
        ? sourceValue.value.safety_structure_settings.structureHushKey
        : '',
    nest: ({ rawData, sourceValue }) =>
      typeof rawData?.['structure.' + sourceValue?.value?.structure_id]?.value?.topaz_hush_key === 'string'
        ? rawData['structure.' + sourceValue.value.structure_id].value.topaz_hush_key
        : '',
  },

  detected_motion: {
    google: ({ sourceValue }) =>
      typeof sourceValue?.value?.legacy_protect_device_info === 'object'
        ? sourceValue.value.legacy_protect_device_info.autoAway !== true
        : false,
    nest: ({ sourceValue }) => sourceValue?.value?.auto_away === false,
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

  // Process data for any smoke detectors we have in the raw data
  let devices = {};

  Object.entries(rawData)
    .filter(
      ([key, value]) =>
        key.startsWith('topaz.') === true ||
        (key.startsWith('DEVICE_') === true && PROTOBUF_RESOURCES.PROTECT.includes(value.value?.device_info?.typeName) === true),
    )
    .forEach(([object_key, value]) => {
      let tempDevice = {};

      try {
        if (
          value?.source === DATA_SOURCE.GOOGLE &&
          value.value?.configuration_done?.deviceReady === true &&
          rawData?.[value.value?.device_info?.pairerId?.resourceId] !== undefined
        ) {
          let mappedData = buildMappedObject(PROTECT_FIELD_MAP, createMappingContext(rawData, object_key, undefined, value));

          if (
            mappedData.serialNumber !== undefined &&
            mappedData.nest_google_device_uuid !== undefined &&
            mappedData.nest_google_home_uuid !== undefined &&
            mappedData.model !== undefined &&
            mappedData.softwareVersion !== undefined &&
            (mappedData.description !== undefined || mappedData.location !== undefined)
          ) {
            tempDevice = processCommonData(
              mappedData.nest_google_device_uuid,
              mappedData.nest_google_home_uuid,
              {
                type: DEVICE_TYPE.PROTECT,
                ...mappedData,
              },
              config,
            );
          }
        }

        // Nest fallback if Google not used or data not available from Google for this device
        if (
          Object.entries(tempDevice).length === 0 &&
          value?.source === DATA_SOURCE.NEST &&
          rawData?.['where.' + value.value?.structure_id] !== undefined &&
          rawData?.['safety.' + value.value?.structure_id] !== undefined &&
          rawData?.['widget_track.' + value.value?.thread_mac_address?.toUpperCase?.()] !== undefined
        ) {
          let mappedData = buildMappedObject(PROTECT_FIELD_MAP, createMappingContext(rawData, object_key, value, undefined));
          if (
            mappedData.serialNumber !== undefined &&
            mappedData.nest_google_device_uuid !== undefined &&
            mappedData.nest_google_home_uuid !== undefined &&
            mappedData.model !== undefined &&
            mappedData.softwareVersion !== undefined &&
            (mappedData.description !== undefined || mappedData.location !== undefined)
          ) {
            tempDevice = processCommonData(
              mappedData.nest_google_device_uuid,
              mappedData.nest_google_home_uuid,
              {
                type: DEVICE_TYPE.PROTECT,
                ...mappedData,
              },
              config,
            );
          }
        }
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        log?.debug?.('Error processing protect data for "%s"', object_key);
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
        tempDevice.eveHistory =
          deviceOptions?.eveHistory !== undefined ? deviceOptions.eveHistory === true : config.options?.eveHistory === true;
        tempDevice.logMotionEvents =
          deviceOptions?.logMotionEvents !== undefined
            ? deviceOptions.logMotionEvents === true
            : config.options?.logMotionEvents === false
              ? false
              : true;

        devices[tempDevice.serialNumber] = tempDevice; // Store processed device
      }
    });

  return devices;
}
