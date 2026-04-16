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
import { processSoftwareVersion, scaleValue } from '../utils.js';
import { buildMappedObject, createMappingContext } from '../translator.js';

// Define constants
import { LOW_BATTERY_LEVEL, DATA_SOURCE, PROTOBUF_RESOURCES, DEVICE_TYPE } from '../consts.js';

export default class NestProtect extends HomeKitDevice {
  static TYPE = 'Protect';
  static VERSION = '2026.04.16'; // Code version

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

// Protect field translation map
// Maps raw source data -> normalised protect device fields
// - fields: top-level raw fields this mapping depends on (for delta updates)
// - related: top-level raw fields on related objects this mapping depends on
// - translate: converts raw -> final normalised value
const PROTECT_FIELD_MAP = {
  // Identity fields
  serialNumber: {
    required: true,
    google: {
      fields: [],
      translate: ({ raw }) =>
        typeof raw?.value?.device_identity?.serialNumber === 'string' && raw.value.device_identity.serialNumber.trim() !== ''
          ? raw.value.device_identity.serialNumber.trim().toUpperCase()
          : undefined,
    },
    nest: {
      fields: [],
      translate: ({ raw }) =>
        typeof raw?.value?.serial_number === 'string' && raw.value.serial_number.trim() !== ''
          ? raw.value.serial_number.trim().toUpperCase()
          : undefined,
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
      fields: ['structure_id'],
      translate: ({ raw }) =>
        typeof raw?.value?.structure_id === 'string' && raw.value.structure_id.trim() !== ''
          ? 'structure.' + raw.value.structure_id.trim()
          : undefined,
    },
  },

  // Naming / descriptive fields
  model: {
    required: true,
    google: {
      fields: ['device_info'],
      translate: ({ raw }) => {
        let typeName = raw?.value?.device_info?.typeName ?? '';

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
    },
    nest: {
      fields: ['serial_number', 'wired_or_battery'],
      translate: ({ raw }) => {
        let model =
          raw?.value?.serial_number?.substring?.(0, 2) === '06'
            ? 'Protect (2nd gen)'
            : raw?.value?.serial_number?.substring?.(0, 2) === '05'
              ? 'Protect (1st gen)'
              : 'Protect (unknown)';

        return raw?.value?.wired_or_battery === true
          ? model.replace(/\bgen\)/, 'gen, battery)')
          : raw?.value?.wired_or_battery === false
            ? model.replace(/\bgen\)/, 'gen, wired)')
            : model;
      },
    },
  },

  softwareVersion: {
    required: true,
    google: {
      fields: ['device_identity'],
      translate: ({ raw }) =>
        typeof raw?.value?.device_identity?.softwareVersion === 'string' && raw.value.device_identity.softwareVersion.trim() !== ''
          ? processSoftwareVersion(raw.value.device_identity.softwareVersion)
          : undefined,
    },
    nest: {
      fields: ['software_version'],
      translate: ({ raw }) =>
        typeof raw?.value?.software_version === 'string' && raw.value.software_version.trim() !== ''
          ? processSoftwareVersion(raw.value.software_version)
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
      fields: ['description', 'structure_id', 'where_id'],
      related: ['wheres'],
      translate: ({ rawData, raw }) => {
        let description = String(raw?.value?.description ?? '').trim();
        let location = String(
          rawData?.['where.' + raw?.value?.structure_id]?.value?.wheres?.find((where) => where?.where_id === raw?.value?.where_id)?.name ??
            '',
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

  // Core state
  online: {
    required: true,
    google: {
      fields: ['liveness'],
      translate: ({ raw }) => raw?.value?.liveness?.status === 'LIVENESS_DEVICE_STATUS_ONLINE',
    },
    nest: {
      fields: ['thread_mac_address'],
      related: ['online'],
      translate: ({ rawData, raw }) => rawData?.['widget_track.' + raw?.value?.thread_mac_address?.toUpperCase?.()]?.value?.online === true,
    },
  },

  line_power_present: {
    google: {
      fields: ['wall_power'],
      translate: ({ raw }) => raw?.value?.wall_power?.status === 'POWER_SOURCE_STATUS_ACTIVE',
    },
    nest: {
      fields: ['line_power_present'],
      translate: ({ raw }) => raw?.value?.line_power_present === true,
    },
  },

  wired_or_battery: {
    google: {
      fields: ['wall_power'],
      translate: ({ raw }) => raw?.value?.wall_power?.present !== true,
    },
    nest: {
      fields: ['wired_or_battery'],
      translate: ({ raw }) => raw?.value?.wired_or_battery === 1,
    },
  },

  battery_level: {
    google: {
      fields: ['battery_voltage_bank0', 'battery_voltage_bank1'],
      translate: ({ raw }) => {
        let bank0 =
          isNaN(raw?.value?.battery_voltage_bank0?.batteryValue?.batteryVoltage?.value) === false &&
          Number(raw.value.battery_voltage_bank0.batteryValue.batteryVoltage.value) > 0
            ? Number(raw.value.battery_voltage_bank0.batteryValue.batteryVoltage.value)
            : undefined;

        let bank1 =
          isNaN(raw?.value?.battery_voltage_bank1?.batteryValue?.batteryVoltage?.value) === false &&
          Number(raw.value.battery_voltage_bank1.batteryValue.batteryVoltage.value) > 0
            ? Number(raw.value.battery_voltage_bank1.batteryValue.batteryVoltage.value)
            : undefined;

        let voltage =
          isNaN(bank0) === false && isNaN(bank1) === false
            ? Math.min(bank0, bank1)
            : isNaN(bank0) === false
              ? bank0
              : isNaN(bank1) === false
                ? bank1
                : undefined;

        return isNaN(voltage) === false ? Math.round(scaleValue(voltage, 4.5, 5.4, 0, 100)) : undefined;
      },
    },
    nest: {
      fields: ['battery_level'],
      translate: ({ raw }) =>
        isNaN(raw?.value?.battery_level) === false && Number(raw.value.battery_level) > 0
          ? Math.round(scaleValue(Number(raw.value.battery_level), 4500, 5400, 0, 100))
          : undefined,
    },
  },

  smoke_status: {
    required: true,
    google: {
      fields: ['safety_alarm_smoke'],
      translate: ({ raw }) => raw?.value?.safety_alarm_smoke?.alarmState === 'ALARM_STATE_ALARM',
    },
    nest: {
      fields: ['smoke_status'],
      translate: ({ raw }) => raw?.value?.smoke_status !== 0,
    },
  },

  co_status: {
    required: true,
    google: {
      fields: ['safety_alarm_co'],
      translate: ({ raw }) => raw?.value?.safety_alarm_co?.alarmState === 'ALARM_STATE_ALARM',
    },
    nest: {
      fields: ['co_status'],
      translate: ({ raw }) => raw?.value?.co_status !== 0,
    },
  },

  heat_status: {
    google: {
      fields: [],
      translate: () => false, // TODO <- need to find in protobuf
    },
    nest: {
      fields: ['heat_status'],
      translate: ({ raw }) => raw?.value?.heat_status !== 0,
    },
  },

  hushed_state: {
    google: {
      fields: ['safety_alarm_smoke', 'safety_alarm_co'],
      translate: ({ raw }) =>
        raw?.value?.safety_alarm_smoke?.silenceState === 'SILENCE_STATE_SILENCED' ||
        raw?.value?.safety_alarm_co?.silenceState === 'SILENCE_STATE_SILENCED',
    },
    nest: {
      fields: ['hushed_state'],
      translate: ({ raw }) => raw?.value?.hushed_state === true,
    },
  },

  ntp_green_led_enable: {
    google: {
      fields: ['night_time_promise_settings'],
      translate: ({ raw }) => raw?.value?.night_time_promise_settings?.greenLedEnabled === true,
    },
    nest: {
      fields: ['ntp_green_led_enable'],
      translate: ({ raw }) => raw?.value?.ntp_green_led_enable === true,
    },
  },

  smoke_test_passed: {
    google: {
      fields: ['safety_summary', 'smoke'],
      translate: ({ raw }) =>
        raw?.value?.safety_summary?.warningDevices?.failures?.includes?.('FAILURE_TYPE_SMOKE') === false
          ? true
          : typeof raw?.value?.smoke !== 'object'
            ? undefined
            : raw?.value?.smoke?.infraredLedFault === undefined || raw?.value?.smoke?.blueLedFault === undefined
              ? true
              : raw?.value?.smoke?.infraredLedFault?.type === 'SMOKE_FAULT_TYPE_NONE' &&
                raw?.value?.smoke?.blueLedFault?.type === 'SMOKE_FAULT_TYPE_NONE',
    },
    nest: {
      fields: ['component_smoke_test_passed'],
      translate: ({ raw }) => raw?.value?.component_smoke_test_passed === true,
    },
  },

  heat_test_passed: {
    google: {
      fields: ['safety_summary', 'passive_infrared'],
      translate: ({ raw }) =>
        raw?.value?.safety_summary?.warningDevices?.failures?.includes?.('FAILURE_TYPE_TEMP') === false
          ? true
          : typeof raw?.value?.passive_infrared !== 'object'
            ? undefined
            : raw?.value?.passive_infrared?.faultInformation === undefined
              ? true
              : raw?.value?.passive_infrared?.faultInformation?.type === 'PASSIVE_INFRARED_FAULT_TYPE_NONE',
    },
    nest: {
      fields: ['component_temp_test_passed'],
      translate: ({ raw }) => raw?.value?.component_temp_test_passed === true,
    },
  },

  co_test_passed: {
    google: {
      fields: ['carbon_monoxide'],
      translate: ({ raw }) =>
        typeof raw?.value?.carbon_monoxide !== 'object'
          ? undefined
          : raw?.value?.carbon_monoxide?.faultInformation === undefined
            ? true
            : raw?.value?.carbon_monoxide?.faultInformation?.type === 'CO_FAULT_TYPE_NONE',
    },
    nest: {
      fields: ['component_co_test_passed'],
      translate: ({ raw }) => raw?.value?.component_co_test_passed === true,
    },
  },

  latest_alarm_test: {
    google: {
      fields: ['self_test'],
      translate: ({ raw }) =>
        isNaN(raw?.value?.self_test?.lastMstEnd?.seconds) === false ? Number(raw.value.self_test.lastMstEnd.seconds) : undefined,
    },
    nest: {
      fields: ['latest_manual_test_end_utc_secs'],
      translate: ({ raw }) =>
        isNaN(raw?.value?.latest_manual_test_end_utc_secs) === false ? Number(raw.value.latest_manual_test_end_utc_secs) : undefined,
    },
  },

  self_test_in_progress: {
    google: {
      fields: ['legacy_structure_self_test'],
      translate: ({ raw }) =>
        raw?.value?.legacy_structure_self_test?.mstInProgress === true || raw?.value?.legacy_structure_self_test?.astInProgress === true,
    },
    nest: {
      fields: ['structure_id'],
      related: ['manual_self_test_in_progress'],
      translate: ({ rawData, raw }) => rawData?.['safety.' + raw?.value?.structure_id]?.value?.manual_self_test_in_progress === true,
    },
  },

  replacement_date: {
    required: true,
    google: {
      fields: ['legacy_protect_device_settings'],
      translate: ({ raw }) =>
        isNaN(raw?.value?.legacy_protect_device_settings?.replaceByDate?.seconds) === false
          ? Number(raw.value.legacy_protect_device_settings.replaceByDate.seconds)
          : undefined,
    },
    nest: {
      fields: ['replace_by_date_utc_secs'],
      translate: ({ raw }) =>
        isNaN(raw?.value?.replace_by_date_utc_secs) === false ? Number(raw.value.replace_by_date_utc_secs) : undefined,
    },
  },

  topaz_hush_key: {
    google: {
      fields: ['safety_structure_settings'],
      translate: ({ raw }) =>
        typeof raw?.value?.safety_structure_settings?.structureHushKey === 'string'
          ? raw.value.safety_structure_settings.structureHushKey
          : '',
    },
    nest: {
      fields: ['structure_id'],
      related: ['topaz_hush_key'],
      translate: ({ rawData, raw }) =>
        typeof rawData?.['structure.' + raw?.value?.structure_id]?.value?.topaz_hush_key === 'string'
          ? rawData['structure.' + raw.value.structure_id].value.topaz_hush_key
          : '',
    },
  },

  detected_motion: {
    google: {
      fields: ['legacy_protect_device_info'],
      translate: ({ raw }) =>
        typeof raw?.value?.legacy_protect_device_info === 'object' ? raw.value.legacy_protect_device_info.autoAway !== true : false,
    },
    nest: {
      fields: ['auto_away'],
      translate: ({ raw }) => raw?.value?.auto_away === false,
    },
  },
};

// Function to process our RAW Nest or Google data for protect devices

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

  // Process data for any smoke detectors we have in the raw data
  let devices = {};

  Object.entries(rawData)
    .filter(
      ([key, value]) =>
        key.startsWith('topaz.') === true ||
        (key.startsWith('DEVICE_') === true && PROTOBUF_RESOURCES.PROTECT.includes(value?.value?.device_info?.typeName) === true),
    )
    .forEach(([object_key, value]) => {
      try {
        // Only process valid Google or Nest Protect resources
        if (
          (value?.source !== DATA_SOURCE.GOOGLE && value?.source !== DATA_SOURCE.NEST) ||
          (value?.source === DATA_SOURCE.GOOGLE &&
            (value?.value?.configuration_done?.deviceReady !== true ||
              rawData?.[value?.value?.device_info?.pairerId?.resourceId] === undefined)) ||
          (value?.source === DATA_SOURCE.NEST &&
            (rawData?.['where.' + value?.value?.structure_id] === undefined ||
              rawData?.['safety.' + value?.value?.structure_id] === undefined ||
              rawData?.['widget_track.' + value?.value?.thread_mac_address?.toUpperCase?.()] === undefined))
        ) {
          return;
        }

        // Map raw device data into our normalised protect schema
        let mappedResult = buildMappedObject(
          PROTECT_FIELD_MAP,
          createMappingContext(rawData, object_key, {
            nest: value?.source === DATA_SOURCE.NEST ? value : undefined,
            google: value?.source === DATA_SOURCE.GOOGLE ? value : undefined,
          }),
          changedData instanceof Map ? changedData.get(object_key)?.fields : undefined,
        );

        let serialNumber = mappedResult?.data?.serialNumber;
        let existingDevice = devices[serialNumber];

        // If we have all required fields, build the full protect device data object
        if (mappedResult?.hasRequired === true) {
          let tempDevice = {
            type: DEVICE_TYPE.PROTECT,
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

          // Insert any extra options we've read in from configuration file for this device
          tempDevice.eveHistory =
            deviceOptions?.eveHistory !== undefined ? deviceOptions.eveHistory === true : config?.options?.eveHistory === true;
          tempDevice.logMotionEvents =
            deviceOptions?.logMotionEvents !== undefined
              ? deviceOptions.logMotionEvents === true
              : config?.options?.logMotionEvents === false
                ? false
                : true;

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
        log?.error?.('Error processing protect data for "%s": %s', object_key, String(error));
      }
    });

  return devices;
}
