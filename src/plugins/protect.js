// Nest Protect - HomeKit integration
// Part of homebridge-nest-accfactory
//
// HomeKit accessory implementation for Nest Protect devices.
// Provides smoke and carbon monoxide detection, battery monitoring,
// alarm state handling, and activity tracking using protobuf and HomeGraph APIs.
//
// Responsibilities:
// - Expose smoke and carbon monoxide detection via HomeKit services
// - Synchronise alarm states with HomeKit (smoke, CO, test events)
// - Monitor battery status and low battery conditions
// - Report device status (online/offline, fault conditions)
// - Record event history for Eve Home integration
// - Expose the reported replacement date as a read-only, locally formatted string
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
// - Supports protobuf and HomeGraph data through the shared field map
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
import { getResourceKey, processSoftwareVersion, scaleValue, buildDeviceDescription } from '../utils.js';
import { buildMappedObject, createMappingContext, normaliseSourceContext } from '../translator.js';

// Define constants
import { LOW_BATTERY_LEVEL, DATA_SOURCE, PROTOBUF_RESOURCES, DEVICE_TYPE, CUSTOM_CHARACTERISTIC_UUID } from '../consts.js';

function hasSafetySummaryFailure(raw, failureType) {
  if (typeof failureType !== 'string' || failureType.trim() === '') {
    return false;
  }

  return ['criticalDevices', 'warningDevices'].some((deviceList) =>
    Array.isArray(raw?.value?.safety_summary?.[deviceList]) === true
      ? raw.value.safety_summary[deviceList].some((device) => device?.failures?.includes?.(failureType) === true)
      : false,
  );
}

export default class NestProtect extends HomeKitDevice {
  static TYPE = DEVICE_TYPE.PROTECT;
  static VERSION = '2026.11.26'; // Code version

  batteryService = undefined;
  smokeService = undefined;
  motionService = undefined;
  carbonMonoxideService = undefined;

  // Class functions
  onAdd() {
    // Pre-0.4.5-alpha.10 cleanup
    // Earlier versions retained a percentage on Protects without voltage data.
    // Remove only that optional characteristic; keep the cached battery service.
    if (typeof this.deviceData.battery_level !== 'number' || Number.isFinite(this.deviceData.battery_level) !== true) {
      for (let service of this.accessory.services) {
        if (service.UUID === this.hap.Service.Battery.UUID) {
          this.removeCharacteristic(service, this.hap.Characteristic.BatteryLevel);
        }
      }
    }
    // End of pre-0.4.5-alpha.10 cleanup

    // Pre-0.4.5-beta.2 cleanup
    // Protect 5.x firmware no longer reliably reports occupancy through either API.
    // Remove cached motion services while preserving the accessory and alarm services.
    if (this.deviceData.softwareVersion?.startsWith('5.') === true) {
      this.accessory.services
        .filter((service) => service.UUID === this.hap.Service.MotionSensor.UUID)
        .forEach((service) => {
          this.removeService(service);
        });
      this.motionService = undefined;
    }
    // End of pre-0.4.5-beta.2 cleanup

    // Setup the smoke sensor service if not already present on the accessory
    this.smokeService = this.addService(this.hap.Service.SmokeSensor, '', 1, {
      primary: true,
      history: {
        messages: this.message.bind(this),
        EveSmoke_lastalarmtest: this.deviceData.latest_alarm_test,
        EveSmoke_alarmtest: this.deviceData.self_test_in_progress,
        EveSmoke_heatstatus: this.deviceData.heat_status,
        EveSmoke_hushedstate: this.deviceData.hushed_state,
        EveSmoke_statusled: this.deviceData.ntp_green_led_enable,
        EveSmoke_smoketestpassed: this.deviceData.smoke_test_passed,
        EveSmoke_heattestpassed: this.deviceData.heat_test_passed,
      },
    });

    this.addCharacteristic(this.smokeService, this.hap.Characteristic.StatusActive);
    this.addCharacteristic(this.smokeService, this.hap.Characteristic.StatusFault);
    this.addCharacteristic(this.smokeService, {
      name: 'Replace By Date',
      uuid: CUSTOM_CHARACTERISTIC_UUID.REPLACE_BY_DATE,
      props: { format: this.hap.Formats.STRING, perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY] },
    });

    // Setup the carbon monoxide service if not already present on the accessory
    this.carbonMonoxideService = this.addService(this.hap.Service.CarbonMonoxideSensor, '', 1);

    this.addCharacteristic(this.carbonMonoxideService, this.hap.Characteristic.StatusActive);
    this.addCharacteristic(this.carbonMonoxideService, this.hap.Characteristic.StatusFault);

    // Setup battery service if not already present on the accessory
    this.batteryService = this.addService(this.hap.Service.Battery, '', 1, { hidden: true });

    // Only wired Protects outside the affected 5.x firmware series expose motion.
    if (this.deviceData?.wired_or_battery === false && this.deviceData.softwareVersion?.startsWith('5.') !== true) {
      this.motionService = this.addService(this.hap.Service.MotionSensor, '', 1);
      this.motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, false); // No motion initially
      this.postSetupDetail('With motion sensor');
    }
  }

  onRemove() {
    this.removeService(this.smokeService);
    this.removeService(this.carbonMonoxideService);
    this.removeService(this.batteryService);
    this.removeService(this.motionService);
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

    // Update battery percentage only when a usable reading exists.
    let hasLevel = typeof deviceData.battery_level === 'number' && Number.isFinite(deviceData.battery_level) === true;
    if (hasLevel === true) {
      this.batteryService.updateCharacteristic(this.hap.Characteristic.BatteryLevel, deviceData.battery_level);
    } else {
      this.removeCharacteristic(this.batteryService, this.hap.Characteristic.BatteryLevel);
    }

    // An explicit replacement indicator takes precedence over the voltage estimate.
    // Unknown health preserves the last known warning rather than inventing a state.
    let low =
      typeof deviceData.battery_low === 'boolean'
        ? deviceData.battery_low
        : hasLevel === true
          ? deviceData.battery_level <= LOW_BATTERY_LEVEL
          : undefined;
    if (low !== undefined) {
      this.batteryService.updateCharacteristic(
        this.hap.Characteristic.StatusLowBattery,
        low === true
          ? this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
      );
    }
    this.batteryService.updateCharacteristic(this.hap.Characteristic.ChargingState, this.hap.Characteristic.ChargingState.NOT_CHARGEABLE);

    let isProtectActive = deviceData.online === true && Math.floor(Date.now() / 1000) <= deviceData.replacement_date;

    // Update Protect replacement date.
    let date =
      Number.isFinite(deviceData.replacement_date) === true && deviceData.replacement_date > 0
        ? new Date(deviceData.replacement_date * 1000)
        : undefined;
    let replacementDate =
      date === undefined || Number.isFinite(date.getTime()) !== true
        ? 'Unavailable'
        : date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
    this.smokeService.updateCharacteristic(this.hap.Characteristic.ReplaceByDate, replacementDate);

    // Update smoke details
    // If Protect isn't online, replacement date has passed, or smoke self-test failed, report fault in HomeKit
    this.smokeService.updateCharacteristic(this.hap.Characteristic.StatusActive, isProtectActive);

    this.smokeService.updateCharacteristic(
      this.hap.Characteristic.StatusFault,
      isProtectActive === true && deviceData.smoke_test_passed !== false
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
    this.carbonMonoxideService.updateCharacteristic(this.hap.Characteristic.StatusActive, isProtectActive);

    this.carbonMonoxideService.updateCharacteristic(
      this.hap.Characteristic.StatusFault,
      isProtectActive === true && deviceData.co_test_passed !== false
        ? this.hap.Characteristic.StatusFault.NO_FAULT
        : this.hap.Characteristic.StatusFault.GENERAL_FAULT,
    );

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
    if (typeof type !== 'string' || type === '' || (message !== undefined && (typeof message !== 'object' || message === null))) {
      return;
    }

    if (type === HomeKitDevice?.EVEHOME?.GET) {
      // Eve supplies its retained, typed details. Missing cloud fields must not
      // replace those values with undefined and invalidate the entire refresh.
      for (let [key, value] of Object.entries({
        lastalarmtest: this.deviceData.latest_alarm_test,
        alarmtest: this.deviceData.self_test_in_progress,
        heatstatus: this.deviceData.heat_status,
        statusled: this.deviceData.ntp_green_led_enable,
        smoketestpassed: this.deviceData.smoke_test_passed,
        heattestpassed: this.deviceData.heat_test_passed,
        hushedstate: this.deviceData.hushed_state,
      })) {
        if (value !== undefined) {
          message[key] = value;
        }
      }
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
    prefer: 'googlehome',
    googlehome: {
      fields: ['technicalInformation'],
      translate: ({ raw }) => raw.value.technicalInformation?.serialNumber?.trim?.().toUpperCase(),
    },
  },

  nest_google_device_uuid: {
    required: true,
    google: {
      fields: [],
      translate: ({ objectKey }) => objectKey,
    },
    prefer: 'googlehome',
    googlehome: { fields: [], translate: ({ objectKey }) => objectKey },
  },

  nest_google_home_uuid: {
    google: {
      fields: ['device_info'],
      translate: ({ raw }) => raw?.value?.device_info?.pairerId?.resourceId,
    },
    prefer: 'googlehome',
    googlehome: { fields: ['structureId'], translate: ({ homeId }) => homeId },
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
    prefer: 'googlehome',
    googlehome: {
      fields: ['technicalInformation', 'googleHome'],
      translate: ({ raw }) => {
        // The technical model identifies the variant; a generic display model does not.
        let model = raw.value.technicalInformation?.model ?? '';
        // First-generation prefixes are inferred from protobuf resource names;
        // second-generation prefixes are confirmed by HomeGraph captures.
        return model.startsWith('NEST_PROTECT_1_LINE.') === true
          ? 'Protect (1st gen, wired)'
          : model.startsWith('NEST_PROTECT_1_BATTERY.') === true
            ? 'Protect (1st gen, battery)'
            : model.startsWith('NEST_PROTECT_2_LINE.') === true
              ? 'Protect (2nd gen, wired)'
              : model.startsWith('NEST_PROTECT_2_BATTERY.') === true
                ? 'Protect (2nd gen, battery)'
                : raw.value.googleHome?.hardware?.model;
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
    prefer: 'googlehome',
    googlehome: {
      fields: ['googleHome'],
      translate: ({ raw }) =>
        typeof raw.value.googleHome?.hardware?.softwareVersion === 'string' && raw.value.googleHome.hardware.softwareVersion.trim() !== ''
          ? processSoftwareVersion(raw.value.googleHome.hardware.softwareVersion)
          : undefined,
    },
  },

  description: {
    required: true,
    google: {
      fields: ['label', 'device_info', 'device_located_settings'],
      related: ['located_annotations'],
      translate: ({ rawData, raw }) => HomeKitDevice.makeValidHKName(buildDeviceDescription(rawData, raw)),
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['googleHome', 'roomId', 'structureId'],
      related: ['home'],
      translate: ({ rawData, raw }) => HomeKitDevice.makeValidHKName(buildDeviceDescription(rawData, raw)),
    },
  },

  // Core state
  online: {
    required: true,
    google: {
      fields: ['liveness'],
      translate: ({ raw }) => raw?.value?.liveness?.status === 'LIVENESS_DEVICE_STATUS_ONLINE',
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['deviceStatus.online'],
      translate: ({ raw }) =>
        typeof raw.value['deviceStatus.online']?.boolean === 'boolean' ? raw.value['deviceStatus.online'].boolean : undefined,
    },
  },

  line_power_present: {
    google: {
      fields: ['wall_power'],
      translate: ({ raw }) => raw?.value?.wall_power?.status === 'POWER_SOURCE_STATUS_ACTIVE',
    },
  },

  wired_or_battery: {
    google: {
      fields: ['wall_power'],
      translate: ({ raw }) => raw?.value?.wall_power?.present !== true,
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['attributes'],
      translate: ({ energySources }) =>
        energySources?.includes('WIRE') === true ? false : energySources?.includes('BATTERY') === true ? true : undefined,
    },
  },

  battery_low: {
    google: {
      fields: ['battery'],
      translate: ({ raw }) => {
        let indicator = raw?.value?.battery?.replacementIndicator;
        return indicator === 'BATTERY_REPLACEMENT_INDICATOR_NOT_AT_ALL'
          ? false
          : ['BATTERY_REPLACEMENT_INDICATOR_SOON', 'BATTERY_REPLACEMENT_INDICATOR_IMMEDIATELY'].includes(indicator) === true
              ? true
              : undefined;
      },
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['charging.descriptiveCapacityRemaining'],
      translate: ({ raw }) => {
        let capacity = raw.value['charging.descriptiveCapacityRemaining']?.text;
        return ['full', 'high', 'medium'].includes(capacity) === true
          ? false
          : ['low', 'critically_low'].includes(capacity) === true
              ? true
              : undefined;
      },
    },
  },

  battery_level: {
    google: {
      fields: ['battery_voltage_bank0', 'battery_voltage_bank1'],
      translate: ({ raw }) => {
        let bank0 =
          Number.isFinite(Number(raw?.value?.battery_voltage_bank0?.batteryValue?.batteryVoltage?.value)) === true &&
          Number(raw.value.battery_voltage_bank0.batteryValue.batteryVoltage.value) > 0
            ? Number(raw.value.battery_voltage_bank0.batteryValue.batteryVoltage.value)
            : undefined;

        let bank1 =
          Number.isFinite(Number(raw?.value?.battery_voltage_bank1?.batteryValue?.batteryVoltage?.value)) === true &&
          Number(raw.value.battery_voltage_bank1.batteryValue.batteryVoltage.value) > 0
            ? Number(raw.value.battery_voltage_bank1.batteryValue.batteryVoltage.value)
            : undefined;

        let voltage =
          Number.isFinite(bank0) === true && Number.isFinite(bank1) === true
            ? Math.min(bank0, bank1)
            : Number.isFinite(bank0) === true
              ? bank0
              : Number.isFinite(bank1) === true
                ? bank1
                : undefined;

        return Number.isFinite(voltage) === true ? Math.round(scaleValue(voltage, 4.5, 5.4, 0, 100)) : undefined;
      },
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['charging.capacityRemainingPercentage', 'charging.descriptiveCapacityRemaining'],
      translate: ({ raw }) => {
        let level = raw.value['charging.capacityRemainingPercentage']?.number;
        if (typeof level === 'number' && Number.isFinite(level) === true && level >= 0 && level <= 100) {
          return Math.round(level);
        }
        // Match the existing sensor estimates when Google reports only a capacity category.
        let capacity = raw.value['charging.descriptiveCapacityRemaining']?.text;
        let levels = { full: 100, high: 75, medium: 50, low: LOW_BATTERY_LEVEL, critically_low: Math.floor(LOW_BATTERY_LEVEL / 2) };
        return Object.hasOwn(levels, capacity) === true ? levels[capacity] : undefined;
      },
    },
  },

  smoke_status: {
    required: true,
    google: {
      fields: ['safety_alarm_smoke'],
      translate: ({ raw }) => raw?.value?.safety_alarm_smoke?.alarmState === 'ALARM_STATE_ALARM',
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['sensorState.currentSensorStateData'],
      translate: ({ sensors }) => {
        let state = sensors.SmokeLevel?.currentSensorState?.text;
        return ['smoke detected', 'high'].includes(state) === true ? true : state === 'no smoke detected' ? false : undefined;
      },
    },
  },

  co_status: {
    required: true,
    google: {
      fields: ['safety_alarm_co'],
      translate: ({ raw }) => raw?.value?.safety_alarm_co?.alarmState === 'ALARM_STATE_ALARM',
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['sensorState.currentSensorStateData'],
      translate: ({ sensors }) => {
        let state = sensors.CarbonMonoxideLevel?.currentSensorState?.text;
        return ['carbon monoxide detected', 'high'].includes(state) === true
          ? true
          : ['no carbon monoxide detected', 'low', 'medium'].includes(state) === true
              ? false
              : undefined;
      },
    },
  },

  heat_status: {
    google: {
      fields: ['temperature'],
      translate: ({ raw }) => raw?.value?.temperature?.faultInformation?.type === 'TEMPERATURE_FAULT_TYPE_OUT_OF_NORMAL_RANGE',
    },
  },

  hushed_state: {
    google: {
      fields: ['safety_alarm_smoke', 'safety_alarm_co'],
      translate: ({ raw }) =>
        raw?.value?.safety_alarm_smoke?.silenceState === 'SILENCE_STATE_SILENCED' ||
        raw?.value?.safety_alarm_co?.silenceState === 'SILENCE_STATE_SILENCED',
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['sensorState.currentSensorStateData'],
      translate: ({ sensors }) => {
        let states = [sensors.SmokeLevel?.alarmSilenceState?.text, sensors.CarbonMonoxideLevel?.alarmSilenceState?.text];
        return states.includes('SILENCED') === true ? true : states.every((state) => state === 'DISALLOWED') === true ? false : undefined;
      },
    },
  },

  ntp_green_led_enable: {
    google: {
      fields: ['night_time_promise_settings'],
      translate: ({ raw }) => raw?.value?.night_time_promise_settings?.greenLedEnabled === true,
    },
  },

  smoke_test_passed: {
    google: {
      fields: ['safety_summary', 'smoke'],
      translate: ({ raw }) =>
        hasSafetySummaryFailure(raw, 'FAILURE_TYPE_SMOKE') === true
          ? false
          : typeof raw?.value?.smoke !== 'object'
            ? undefined
            : raw?.value?.smoke?.infraredLedFault === undefined || raw?.value?.smoke?.blueLedFault === undefined
              ? true
              : raw?.value?.smoke?.infraredLedFault?.type === 'SMOKE_FAULT_TYPE_NONE' &&
                raw?.value?.smoke?.blueLedFault?.type === 'SMOKE_FAULT_TYPE_NONE',
    },
  },

  heat_test_passed: {
    google: {
      fields: ['safety_summary', 'temperature'],
      translate: ({ raw }) =>
        hasSafetySummaryFailure(raw, 'FAILURE_TYPE_TEMP') === true
          ? false
          : typeof raw?.value?.temperature !== 'object'
            ? undefined
            : raw?.value?.temperature?.faultInformation === undefined
              ? true
              : raw?.value?.temperature?.faultInformation?.type === 'TEMPERATURE_FAULT_TYPE_NONE',
    },
  },

  co_test_passed: {
    google: {
      fields: ['safety_summary', 'carbon_monoxide'],
      translate: ({ raw }) =>
        hasSafetySummaryFailure(raw, 'FAILURE_TYPE_CO') === true
          ? false
          : typeof raw?.value?.carbon_monoxide !== 'object'
            ? undefined
            : raw?.value?.carbon_monoxide?.faultInformation === undefined
              ? true
              : raw?.value?.carbon_monoxide?.faultInformation?.type === 'CO_FAULT_TYPE_NONE',
    },
  },

  latest_alarm_test: {
    google: {
      fields: ['self_test'],
      translate: ({ raw }) =>
        Number.isFinite(Number(raw?.value?.self_test?.lastMstEnd?.seconds)) === true
          ? Number(raw.value.self_test.lastMstEnd.seconds)
          : undefined,
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['structureId'],
      related: ['home'],
      translate: ({ structureTraits }) => {
        // This is the latest manual test end, not the last successful test or the
        // automatic audio-test timestamp. Structure association is account-scoped.
        let end = structureTraits?.['home.platform.traits.StructureSelfTestTrait']?.manualTest?.structValue?.fields?.endTime?.stringValue;
        let seconds = typeof end === 'string' && end.trim() !== '' ? Number(end) : undefined;
        return Number.isFinite(seconds) === true && seconds > 0 ? seconds : undefined;
      },
    },
  },

  self_test_in_progress: {
    google: {
      fields: ['legacy_structure_self_test'],
      translate: ({ raw }) =>
        raw?.value?.legacy_structure_self_test?.mstInProgress === true || raw?.value?.legacy_structure_self_test?.astInProgress === true,
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['structureId'],
      related: ['home'],
      translate: ({ structureTraits }) => {
        let tests = structureTraits?.['home.platform.traits.StructureSelfTestTrait'];
        let statuses = ['manualTest', 'audioTest'].map((test) => tests?.[test]?.structValue?.fields?.status?.stringValue);
        // Both completed statuses are captured. Other status names still need a
        // running-test capture; missing/unknown status must not imply inactivity.
        return statuses.every((status) => status === 'SELF_TEST_STATUS_COMPLETED') === true ? false : undefined;
      },
    },
  },

  replacement_date: {
    required: true,
    google: {
      fields: ['legacy_protect_device_settings'],
      translate: ({ raw }) =>
        Number.isFinite(Number(raw?.value?.legacy_protect_device_settings?.replaceByDate?.seconds)) === true
          ? Number(raw.value.legacy_protect_device_settings.replaceByDate.seconds)
          : undefined,
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['attributes'],
      translate: ({ raw }) => {
        // Foyer reports expiryDate as Unix seconds in discovery attributes, not GetTraits.
        let value = raw.value.attributes?.fields?.expiryDate?.stringValue;
        let seconds = typeof value === 'string' && value.trim() !== '' ? Number(value) : undefined;
        return Number.isFinite(seconds) === true && seconds > 0 && Number.isFinite(new Date(seconds * 1000).getTime()) === true
          ? seconds
          : undefined;
      },
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
  },

  detected_motion: {
    google: {
      fields: ['legacy_protect_device_info'],
      translate: ({ raw }) =>
        typeof raw?.value?.legacy_protect_device_info === 'object' ? raw.value.legacy_protect_device_info.autoAway !== true : false,
    },
  },
};

// Process protobuf and HomeGraph data for Protect devices
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

  let devices = {};
  let contexts = new Map();
  Object.entries(rawData)
    .filter(
      ([key, value]) =>
        key.startsWith('DEVICE_') === true &&
        ((value?.source === DATA_SOURCE.PROTOBUF && PROTOBUF_RESOURCES.PROTECT.includes(value?.value?.device_info?.typeName) === true) ||
          (value?.source === DATA_SOURCE.HOMEGRAPH &&
            value.value?.googleHome?.type === 'action.devices.types.SMOKE_DETECTOR' &&
            value.value.googleHome.id?.thirdPartyId?.idType?.startsWith('nest') === true)),
    )
    .forEach(([object_key, value]) => {
      try {
        let isHomeGraph = value.source === DATA_SOURCE.HOMEGRAPH;
        let homeId =
          isHomeGraph === true
            ? getResourceKey(value.connection, value.source, value.value.structureId, 'STRUCTURE')
            : value.value?.device_info?.pairerId?.resourceId;
        let home = rawData[homeId];
        let resourceKeys = [object_key, homeId];
        let serial = isHomeGraph === true ? value.value.technicalInformation?.serialNumber : value.value.device_identity?.serialNumber;
        if (typeof serial !== 'string' || serial.trim() === '') {
          return;
        }
        serial = serial.trim().toUpperCase();
        let candidate = contexts.get(serial) ?? {
          context: createMappingContext(rawData, object_key),
          fields: new Set(),
          changed: changedData instanceof Map !== true,
        };
        contexts.set(serial, candidate);
        candidate.changed = candidate.changed === true || resourceKeys.some((id) => changedData?.has?.(id) === true);
        // Require a configured protobuf device or a HomeGraph device with its account-scoped home.
        if (
          (isHomeGraph !== true && value?.value?.configuration_done?.deviceReady !== true) ||
          home === undefined ||
          (isHomeGraph === true && (home.source !== DATA_SOURCE.HOMEGRAPH || home.connection !== value.connection))
        ) {
          return;
        }

        // Sensor entries use named Struct properties. Resolve structure test history
        // only from the same account/home; unknown component fault semantics stay unmapped.
        let sensors = Object.fromEntries(
          (value.value['sensorState.currentSensorStateData']?.array?.values ?? []).map((sensor) => {
            let properties = Object.fromEntries((sensor.properties?.properties ?? []).map((property) => [property.name, property.value]));
            return [properties.name?.text, properties];
          }),
        );
        let energySources = value.value.attributes?.fields?.supportedEnergySources?.listValue?.values?.map((source) => source.stringValue);
        let structureTraits =
          isHomeGraph === true
            ? Object.fromEntries((home.value?.home?.traits ?? []).map((trait) => [trait.name, trait.fields]))
            : undefined;

        let source = isHomeGraph === true ? 'googlehome' : 'google';
        candidate.context.sources[source] = normaliseSourceContext(source, object_key, value, {
          homeId,
          sensors,
          energySources,
          structureTraits,
        });
        for (let field of Object.keys(value.value)) {
          candidate.fields.add(field);
        }
      } catch (error) {
        log?.error?.('Error processing protect data for "%s": %s', object_key, String(error));
      }
    });

  for (let [serialNumber, candidate] of contexts) {
    if (candidate.changed !== true) {
      continue;
    }
    try {
      let mappedResult = buildMappedObject(PROTECT_FIELD_MAP, candidate.context, candidate.fields);
      // An explicit absence clears a previous percentage when HomeKit merges
      // updates; undefined would retain the old value after a source change.
      mappedResult.data.battery_level ??= null;

      // If we have all required fields, build the full protect device data object
      if (mappedResult?.hasRequired === true) {
        let tempDevice = {
          type: DEVICE_TYPE.PROTECT,
          manufacturer: 'Nest',
          ...mappedResult.data,
        };

        // Respect requested device type if specified
        if (deviceType !== undefined && (typeof deviceType !== 'string' || deviceType === '' || tempDevice.type !== deviceType)) {
          continue;
        }

        let deviceOptions = config?.devices?.find(
          (device) => device?.serialNumber?.toUpperCase?.() === tempDevice?.serialNumber?.toUpperCase?.(),
        );
        let homeOptions = config?.homes?.find(
          (home) =>
            home?.protobuf_home_uuid?.toUpperCase?.() === tempDevice?.nest_google_home_uuid?.toUpperCase?.() ||
            home?.homegraph_home_uuid?.toUpperCase?.() === tempDevice?.nest_google_home_uuid?.toUpperCase?.(),
        );

        tempDevice.eveHistory =
          deviceOptions?.eveHistory !== undefined ? deviceOptions.eveHistory === true : config?.options?.eveHistory === true;
        tempDevice.logMotionEvents =
          deviceOptions?.logMotionEvents !== undefined
            ? deviceOptions.logMotionEvents === true
            : config?.options?.logMotionEvents === false
              ? false
              : true;

        tempDevice.excluded =
          deviceOptions?.exclude === true ||
          (deviceOptions?.exclude !== false &&
            (homeOptions?.exclude === true || (homeOptions?.exclude !== false && config?.options?.exclude === true)));

        devices[serialNumber] = { full: true, data: tempDevice };
      } else if (mappedResult.data.serialNumber !== undefined) {
        devices[serialNumber] = { full: false, data: mappedResult.data };
      }
    } catch (error) {
      log?.error?.('Error processing protect data for "%s": %s', serialNumber, String(error));
    }
  }
  return devices;
}
