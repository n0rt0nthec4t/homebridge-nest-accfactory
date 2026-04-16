// Nest × Yale Lock - HomeKit integration
// Part of homebridge-nest-accfactory
//
// HomeKit accessory implementation for Nest × Yale Lock devices.
// Provides secure lock control, battery monitoring, auto-relock configuration,
// tamper reporting, and activity tracking using Google protobuf API data.
//
// Responsibilities:
// - Expose lock state and control via HomeKit LockMechanism service
// - Synchronise current and target lock state with HomeKit
// - Support auto-relock timeout control
// - Report tamper, fault, and battery status
// - Record lock activity history for Eve Home integration
//
// Services:
// - LockMechanism (primary service)
// - Battery (hidden, for battery level and low battery alerts)
//
// Features:
// - Real-time lock state synchronisation with HomeKit
// - Remote lock and unlock control
// - Configurable auto-relock timeout
// - Lock action source tracking (physical, keypad, remote, voice, implicit)
// - Tamper detection support
// - Battery monitoring with low battery alerts
// - Eve Home history integration
//
// Notes:
// - Google protobuf API support only
// - Nest REST API is not used for lock devices
// - Lock state and actor details are normalised before presentation to HomeKit
//
// Data Translation:
// - Raw Google lock data is mapped using LOCK_FIELD_MAP
// - processRawData() builds device objects and applies configuration overrides
// - Field mapping keeps upstream API changes separate from HomeKit presentation
//
// Mark Hulskamp
'use strict';

// Define our modules
import HomeKitDevice from '../HomeKitDevice.js';
import { processSoftwareVersion, scaleValue } from '../utils.js';
import { buildMappedObject, createMappingContext } from '../translator.js';

// Define constants
import { DATA_SOURCE, DEVICE_TYPE, PROTOBUF_RESOURCES, LOW_BATTERY_LEVEL } from '../consts.js';

export default class NestLock extends HomeKitDevice {
  static TYPE = 'Lock';
  static VERSION = '2026.04.13'; // Code version

  // Define lock bolt states
  static STATE = {
    JAMMED: 'jammed',
    LOCKING: 'locking',
    UNLOCKING: 'unlocking',
    LOCKED: 'locked',
    UNLOCKED: 'unlocked',
    UNKNOWN: 'unknown',
  };

  static LAST_ACTION = {
    PHYSICAL: 'physical',
    KEYPAD: 'keypad',
    REMOTE: 'remote',
    IMPLICIT: 'implicit',
    VOICE: 'voice',
  };

  lockService = undefined;
  batteryService = undefined;

  onAdd() {
    // Setup lock service if not already present on the accessory and link it to the Eve app if configured to do so
    this.lockService = this.addHKService(this.hap.Service.LockMechanism, '', 1, {});
    this.lockService.setPrimaryService();

    // Setup set characteristics
    this.addHKCharacteristic(this.lockService, this.hap.Characteristic.LockCurrentState, {
      onGet: () => {
        return this.#currentState(this.deviceData);
      },
    });

    this.addHKCharacteristic(this.lockService, this.hap.Characteristic.LockTargetState, {
      onSet: (value) => {
        if (value !== this.lockService.getCharacteristic(this.hap.Characteristic.LockTargetState).value) {
          let locked = value === this.hap.Characteristic.LockTargetState.SECURED;

          this.set({
            uuid: this.deviceData.nest_google_device_uuid,
            bolt_lock: locked,
          });

          this.lockService.updateCharacteristic(this.hap.Characteristic.LockTargetState, value);

          this?.log?.info?.('Setting lock on "%s" to "%s"', this.deviceData.description, locked ? 'Locked' : 'Unlocked');
        }
      },
      onGet: () => {
        return this.#targetState(this.deviceData);
      },
    });

    this.addHKCharacteristic(this.lockService, this.hap.Characteristic.LockManagementAutoSecurityTimeout, {
      props: {
        minValue: 0,
        maxValue: this.deviceData.max_auto_relock_duration,
      },
      onSet: (value) => {
        value = Math.floor(value); // Make a round number

        if (value !== this.deviceData.auto_relock_duration) {
          this.set({
            uuid: this.deviceData.nest_google_device_uuid,
            auto_relock_duration: value,
          });

          this?.log?.info?.(
            'Setting lock auto-relocking duration on "%s" to "%s"',
            this.deviceData.description,
            value !== 0 ? value + ' seconds' : 'Disabled',
          );
        }
      },
      onGet: () => {
        return this.deviceData.auto_relock_duration;
      },
    });

    this.addHKCharacteristic(this.lockService, this.hap.Characteristic.LockLastKnownAction, {
      onGet: () => {
        return this.#lastAction(this.deviceData);
      },
    });

    this.addHKCharacteristic(this.lockService, this.hap.Characteristic.StatusTampered, {
      onGet: () => {
        return this.deviceData.tampered === true
          ? this.hap.Characteristic.StatusTampered.TAMPERED
          : this.hap.Characteristic.StatusTampered.NOT_TAMPERED;
      },
    });

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

    // Update lock state
    this.lockService.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.#currentState(deviceData));
    this.lockService.updateCharacteristic(this.hap.Characteristic.LockTargetState, this.#targetState(deviceData));
    this.lockService.updateCharacteristic(this.hap.Characteristic.LockLastKnownAction, this.#lastAction(deviceData));
    this.lockService.updateCharacteristic(this.hap.Characteristic.LockManagementAutoSecurityTimeout, deviceData.auto_relock_duration);

    // If device isn't online report in HomeKit
    this.lockService.updateCharacteristic(
      this.hap.Characteristic.StatusFault,
      deviceData.online === true ? this.hap.Characteristic.StatusFault.NO_FAULT : this.hap.Characteristic.StatusFault.GENERAL_FAULT,
    );

    // Update battery level and status
    this.batteryService.updateCharacteristic(this.hap.Characteristic.BatteryLevel, deviceData.battery_level);
    this.batteryService.updateCharacteristic(
      this.hap.Characteristic.StatusLowBattery,
      deviceData.battery_level > LOW_BATTERY_LEVEL
        ? this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
        : this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW,
    );
    this.batteryService.updateCharacteristic(this.hap.Characteristic.ChargingState, this.hap.Characteristic.ChargingState.NOT_CHARGEABLE);

    // Update tampered state
    this.lockService.updateCharacteristic(
      this.hap.Characteristic.StatusTampered,
      deviceData.tampered !== true ? this.hap.Characteristic.StatusTampered.NOT_TAMPERED : this.hap.Characteristic.StatusTampered.TAMPERED,
    );

    // Log lock state changes
    if (deviceData.bolt_state === NestLock.STATE.LOCKED && this.deviceData.bolt_state === NestLock.STATE.UNLOCKED) {
      this?.log?.info?.('Lock locked on "%s" by %s', deviceData.description, deviceData.bolt_actor);
    }

    if (deviceData.bolt_state === NestLock.STATE.UNLOCKED && this.deviceData.bolt_state === NestLock.STATE.LOCKED) {
      this?.log?.warn?.('Lock unlocked on "%s" by %s', deviceData.description, deviceData.bolt_actor);
    }

    if (deviceData.bolt_state === NestLock.STATE.JAMMED && this.deviceData.bolt_state !== NestLock.STATE.JAMMED) {
      this?.log?.error?.('Lock jammed on "%s"', deviceData.description);
    }

    if (deviceData.bolt_state !== NestLock.STATE.JAMMED && this.deviceData.bolt_state === NestLock.STATE.JAMMED) {
      this?.log?.info?.('Lock unjammed on "%s"', deviceData.description);
    }

    // Log lock status to history only if changed to previous recording
    if (deviceData.bolt_state === NestLock.STATE.LOCKED || deviceData.bolt_state === NestLock.STATE.UNLOCKED) {
      this.history(this.lockService, {
        status: deviceData.bolt_state === NestLock.STATE.LOCKED ? 0 : 1, // 0 = locked, 1 = unlocked
      });
    }
  }

  #currentState(deviceData) {
    return deviceData.bolt_state === NestLock.STATE.JAMMED
      ? this.hap.Characteristic.LockCurrentState.JAMMED
      : deviceData.bolt_state === NestLock.STATE.LOCKED || deviceData.bolt_state === NestLock.STATE.UNLOCKING
        ? this.hap.Characteristic.LockCurrentState.SECURED
        : deviceData.bolt_state === NestLock.STATE.UNLOCKED || deviceData.bolt_state === NestLock.STATE.LOCKING
          ? this.hap.Characteristic.LockCurrentState.UNSECURED
          : this.hap.Characteristic.LockCurrentState.UNKNOWN;
  }

  #targetState(deviceData) {
    return deviceData.bolt_state === NestLock.STATE.LOCKED || deviceData.bolt_state === NestLock.STATE.LOCKING
      ? this.hap.Characteristic.LockTargetState.SECURED
      : this.hap.Characteristic.LockTargetState.UNSECURED;
  }

  #lastAction(deviceData) {
    return deviceData.bolt_actor === NestLock.LAST_ACTION.PHYSICAL
      ? deviceData.bolt_state === NestLock.STATE.LOCKED || deviceData.bolt_state === NestLock.STATE.LOCKING
        ? this.hap.Characteristic.LockLastKnownAction.SECURED_PHYSICALLY
        : this.hap.Characteristic.LockLastKnownAction.UNSECURED_PHYSICALLY
      : deviceData.bolt_actor === NestLock.LAST_ACTION.KEYPAD
        ? deviceData.bolt_state === NestLock.STATE.LOCKED || deviceData.bolt_state === NestLock.STATE.LOCKING
          ? this.hap.Characteristic.LockLastKnownAction.SECURED_BY_KEYPAD
          : this.hap.Characteristic.LockLastKnownAction.UNSECURED_BY_KEYPAD
        : deviceData.bolt_actor === NestLock.LAST_ACTION.REMOTE || deviceData.bolt_actor === NestLock.LAST_ACTION.VOICE
          ? deviceData.bolt_state === NestLock.STATE.LOCKED || deviceData.bolt_state === NestLock.STATE.LOCKING
            ? this.hap.Characteristic.LockLastKnownAction.SECURED_REMOTELY
            : this.hap.Characteristic.LockLastKnownAction.UNSECURED_REMOTELY
          : this.hap.Characteristic.LockLastKnownAction.UNSECURED; // Fallback
  }
}

// Lock field translation map
// Maps raw source data -> normalised lock device fields
// - fields: top-level raw fields this mapping depends on (for delta updates)
// - related: top-level raw fields on related objects this mapping depends on
// - translate: converts raw -> final normalised value
const LOCK_FIELD_MAP = {
  // Identity fields
  serialNumber: {
    required: true,
    google: {
      fields: ['device_identity'],
      translate: ({ raw }) =>
        typeof raw?.value?.device_identity?.serialNumber === 'string' && raw.value.device_identity.serialNumber.trim() !== ''
          ? raw.value.device_identity.serialNumber.trim().toUpperCase()
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
    google: {
      fields: ['device_info'],
      translate: ({ raw }) => raw?.value?.device_info?.pairerId?.resourceId,
    },
  },

  // Naming / descriptive fields
  softwareVersion: {
    required: true,
    google: {
      fields: ['device_identity'],
      translate: ({ raw }) =>
        typeof raw?.value?.device_identity?.softwareVersion === 'string' && raw.value.device_identity.softwareVersion.trim() !== ''
          ? processSoftwareVersion(raw.value.device_identity.softwareVersion)
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
  },

  // Core operational fields
  online: {
    required: true,
    google: {
      fields: ['liveness'],
      translate: ({ raw }) => raw?.value?.liveness?.status === 'LIVENESS_DEVICE_STATUS_ONLINE',
    },
  },

  tampered: {
    required: true,
    google: {
      fields: ['tamper'],
      translate: ({ raw }) => raw?.value?.tamper?.tamperState === 'TAMPER_STATE_TAMPERED',
    },
  },

  bolt_state: {
    required: true,
    google: {
      fields: ['bolt_lock'],
      translate: ({ raw }) =>
        raw?.value?.bolt_lock?.actuatorState?.startsWith?.('BOLT_ACTUATOR_STATE_JAMMED') === true
          ? NestLock.STATE.JAMMED
          : raw?.value?.bolt_lock?.actuatorState === 'BOLT_ACTUATOR_STATE_LOCKING'
            ? NestLock.STATE.LOCKING
            : raw?.value?.bolt_lock?.actuatorState === 'BOLT_ACTUATOR_STATE_UNLOCKING'
              ? NestLock.STATE.UNLOCKING
              : raw?.value?.bolt_lock?.lockedState === 'BOLT_LOCKED_STATE_LOCKED'
                ? NestLock.STATE.LOCKED
                : raw?.value?.bolt_lock?.lockedState === 'BOLT_LOCKED_STATE_UNLOCKED'
                  ? NestLock.STATE.UNLOCKED
                  : NestLock.STATE.UNKNOWN,
    },
  },

  bolt_actor: {
    required: true,
    google: {
      fields: ['bolt_lock'],
      translate: ({ raw }) =>
        raw?.value?.bolt_lock?.boltLockActor?.method === 'BOLT_LOCK_ACTOR_METHOD_PHYSICAL'
          ? NestLock.LAST_ACTION.PHYSICAL
          : raw?.value?.bolt_lock?.boltLockActor?.method === 'BOLT_LOCK_ACTOR_METHOD_KEYPAD_PIN'
            ? NestLock.LAST_ACTION.KEYPAD
            : [
                'BOLT_LOCK_ACTOR_METHOD_REMOTE_USER_EXPLICIT',
                'BOLT_LOCK_ACTOR_METHOD_REMOTE_USER_IMPLICIT',
                'BOLT_LOCK_ACTOR_METHOD_REMOTE_USER_OTHER',
                'BOLT_LOCK_ACTOR_METHOD_REMOTE_DELEGATE',
              ].includes(raw?.value?.bolt_lock?.boltLockActor?.method) === true
                ? NestLock.LAST_ACTION.REMOTE
                : raw?.value?.bolt_lock?.boltLockActor?.method === 'BOLT_LOCK_ACTOR_METHOD_VOICE_ASSISTANT'
                  ? NestLock.LAST_ACTION.VOICE
                  : ['BOLT_LOCK_ACTOR_METHOD_LOCAL_IMPLICIT', 'BOLT_LOCK_ACTOR_METHOD_LOW_POWER_SHUTDOWN'].includes(
                      raw?.value?.bolt_lock?.boltLockActor?.method,
                    ) === true
                      ? NestLock.LAST_ACTION.IMPLICIT
                      : NestLock.LAST_ACTION.PHYSICAL,
    },
  },

  battery_level: {
    required: true,
    google: {
      fields: ['battery_power_source'],
      translate: ({ raw }) =>
        // Google API reports lock battery remaining as fractional percentage (0–1)
        isNaN(raw?.value?.battery_power_source?.remaining?.remainingPercent?.value) === false
          ? Math.round(scaleValue(Number(raw.value.battery_power_source.remaining.remainingPercent.value), 0, 1, 0, 100))
          : undefined,
    },
  },

  // Optional configuration/state fields
  auto_relock_duration: {
    required: true,
    google: {
      fields: ['bolt_lock_settings'],
      translate: ({ raw }) =>
        isNaN(raw?.value?.bolt_lock_settings?.autoRelockDuration?.seconds) === false
          ? Number(raw.value.bolt_lock_settings.autoRelockDuration.seconds)
          : undefined,
    },
  },

  max_auto_relock_duration: {
    required: true,
    google: {
      fields: ['bolt_lock_capabilities'],
      translate: ({ raw }) =>
        isNaN(raw?.value?.bolt_lock_capabilities?.maxAutoRelockDuration?.seconds) === false
          ? Number(raw.value.bolt_lock_capabilities.maxAutoRelockDuration.seconds)
          : undefined,
    },
  },
};

// Function to process our RAW Google data for lock devices
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

  // Process data for any lock(s) we have in the raw data
  let devices = {};

  Object.entries(rawData)
    .filter(
      ([key, value]) =>
        key.startsWith('DEVICE_') === true && PROTOBUF_RESOURCES.LOCK.includes(value?.value?.device_info?.typeName) === true,
    )
    .forEach(([object_key, value]) => {
      try {
        // Only process valid Google lock devices that are ready and linked to a known home object
        if (
          value?.source !== DATA_SOURCE.GOOGLE ||
          value?.value?.configuration_done?.deviceReady !== true ||
          rawData?.[value?.value?.device_info?.pairerId?.resourceId] === undefined
        ) {
          return;
        }

        // Map raw device data into our normalised lock schema
        let mappedResult = buildMappedObject(
          LOCK_FIELD_MAP,
          createMappingContext(rawData, object_key, {
            google: value,
          }),
          changedData instanceof Map ? changedData.get(object_key)?.fields : undefined,
        );

        let serialNumber = mappedResult?.data?.serialNumber;
        let existingDevice = devices[serialNumber];

        // If we have all required fields, build the full lock device data object
        if (mappedResult?.hasRequired === true) {
          let tempDevice = {
            type: DEVICE_TYPE.LOCK,
            model: 'x Yale Lock',
            manufacturer: 'Nest',
            ...mappedResult.data,
          };

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
        log?.error?.('Error processing lock data for "%s": %s', object_key, String(error));
      }
    });

  return devices;
}
