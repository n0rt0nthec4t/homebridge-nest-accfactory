// Nest x Yale Lock (initial class - protobuf support only)
// Part of homebridge-nest-accfactory
//
// Mark Hulskamp
'use strict';

// Define our modules
import HomeKitDevice from '../HomeKitDevice.js';
import { processCommonData, scaleValue } from '../utils.js';
import { buildMappedObject, createMappingContext } from '../translator.js';

// Define constants
import { DATA_SOURCE, DEVICE_TYPE, PROTOBUF_RESOURCES, LOW_BATTERY_LEVEL } from '../consts.js';

export default class NestLock extends HomeKitDevice {
  static TYPE = 'Lock';
  static VERSION = '2026.03.12'; // Code version

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

// Data translation functions for lock data.
// We use this to translate RAW Google data into the format we want for our
// lock device(s) using the field map below.
//
// This keeps all translation logic in one place and makes it easier to maintain as
// Google source data evolves over time.
//
// Field map conventions:
// - Return undefined for missing values rather than placeholder defaults
// - processRawData() determines if enough data exists to build the device
// - Optional fields may remain undefined
//
// Lock field translation map
const LOCK_FIELD_MAP = {
  // Identity fields
  serialNumber: {
    google: ({ sourceValue }) =>
      typeof sourceValue?.value?.device_identity?.serialNumber === 'string' && sourceValue.value.device_identity.serialNumber.trim() !== ''
        ? sourceValue.value.device_identity.serialNumber
        : undefined,
  },

  nest_google_device_uuid: {
    google: ({ objectKey }) => objectKey,
  },

  nest_google_home_uuid: {
    google: ({ sourceValue }) => sourceValue?.value?.device_info?.pairerId?.resourceId,
  },

  // Naming / descriptive fields
  description: {
    google: ({ sourceValue }) => String(sourceValue?.value?.label?.label ?? ''),
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
  },

  // Core operational fields
  online: {
    google: ({ sourceValue }) => sourceValue?.value?.liveness?.status === 'LIVENESS_DEVICE_STATUS_ONLINE',
  },

  tampered: {
    google: ({ sourceValue }) => sourceValue?.value?.tamper?.tamperState === 'TAMPER_STATE_TAMPERED',
  },

  bolt_state: {
    google: ({ sourceValue }) =>
      sourceValue?.value?.bolt_lock?.actuatorState?.startsWith?.('BOLT_ACTUATOR_STATE_JAMMED') === true
        ? NestLock.STATE.JAMMED
        : sourceValue?.value?.bolt_lock?.actuatorState === 'BOLT_ACTUATOR_STATE_LOCKING'
          ? NestLock.STATE.LOCKING
          : sourceValue?.value?.bolt_lock?.actuatorState === 'BOLT_ACTUATOR_STATE_UNLOCKING'
            ? NestLock.STATE.UNLOCKING
            : sourceValue?.value?.bolt_lock?.lockedState === 'BOLT_LOCKED_STATE_LOCKED'
              ? NestLock.STATE.LOCKED
              : sourceValue?.value?.bolt_lock?.lockedState === 'BOLT_LOCKED_STATE_UNLOCKED'
                ? NestLock.STATE.UNLOCKED
                : NestLock.STATE.UNKNOWN,
  },

  bolt_actor: {
    google: ({ sourceValue }) =>
      sourceValue?.value?.bolt_lock?.boltLockActor?.method === 'BOLT_LOCK_ACTOR_METHOD_PHYSICAL'
        ? NestLock.LAST_ACTION.PHYSICAL
        : sourceValue?.value?.bolt_lock?.boltLockActor?.method === 'BOLT_LOCK_ACTOR_METHOD_KEYPAD_PIN'
          ? NestLock.LAST_ACTION.KEYPAD
          : [
              'BOLT_LOCK_ACTOR_METHOD_REMOTE_USER_EXPLICIT',
              'BOLT_LOCK_ACTOR_METHOD_REMOTE_USER_IMPLICIT',
              'BOLT_LOCK_ACTOR_METHOD_REMOTE_USER_OTHER',
              'BOLT_LOCK_ACTOR_METHOD_REMOTE_DELEGATE',
            ].includes(sourceValue?.value?.bolt_lock?.boltLockActor?.method) === true
              ? NestLock.LAST_ACTION.REMOTE
              : sourceValue?.value?.bolt_lock?.boltLockActor?.method === 'BOLT_LOCK_ACTOR_METHOD_VOICE_ASSISTANT'
                ? NestLock.LAST_ACTION.VOICE
                : ['BOLT_LOCK_ACTOR_METHOD_LOCAL_IMPLICIT', 'BOLT_LOCK_ACTOR_METHOD_LOW_POWER_SHUTDOWN'].includes(
                    sourceValue?.value?.bolt_lock?.boltLockActor?.method,
                  ) === true
                    ? NestLock.LAST_ACTION.IMPLICIT
                    : NestLock.LAST_ACTION.PHYSICAL,
  },

  battery_level: {
    google: ({ sourceValue }) =>
      // Google API reports lock battery remaining as fractional percentage (0–1)
      isNaN(sourceValue?.value?.battery_power_source?.remaining?.remainingPercent?.value) === false
        ? scaleValue(Number(sourceValue.value.battery_power_source.remaining.remainingPercent.value), 0, 1, 0, 100)
        : undefined,
  },

  // Optional configuration fields
  auto_relock_duration: {
    google: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.bolt_lock_settings?.autoRelockDuration?.seconds) === false
        ? Number(sourceValue.value.bolt_lock_settings.autoRelockDuration.seconds)
        : undefined,
  },

  max_auto_relock_duration: {
    google: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.bolt_lock_capabilities?.maxAutoRelockDuration?.seconds) === false
        ? Number(sourceValue.value.bolt_lock_capabilities.maxAutoRelockDuration.seconds)
        : undefined,
  },
};

// Function to process our RAW Google data for lock devices
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

  // Process data for any lock(s) we have in the raw data
  let devices = {};

  Object.entries(rawData)
    .filter(
      ([key, value]) => key.startsWith('DEVICE_') === true && PROTOBUF_RESOURCES.LOCK.includes(value.value?.device_info?.typeName) === true,
    )
    .forEach(([object_key, value]) => {
      let tempDevice = {};

      try {
        let mappedData = buildMappedObject(LOCK_FIELD_MAP, createMappingContext(rawData, object_key, undefined, value));

        if (
          value?.source === DATA_SOURCE.GOOGLE &&
          value.value?.configuration_done?.deviceReady === true &&
          rawData?.[value.value?.device_info?.pairerId?.resourceId] !== undefined &&
          mappedData.serialNumber !== undefined &&
          mappedData.nest_google_device_uuid !== undefined &&
          mappedData.nest_google_home_uuid !== undefined &&
          mappedData.description !== undefined &&
          mappedData.bolt_state !== undefined
        ) {
          tempDevice = processCommonData(
            mappedData.nest_google_device_uuid,
            mappedData.nest_google_home_uuid,
            {
              type: DEVICE_TYPE.LOCK,
              model: 'x Yale Lock',
              softwareVersion: value.value.device_identity.softwareVersion,
              ...mappedData,
            },
            config,
          );
        }

        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        log?.debug?.('Error processing lock data for "%s"', object_key);
      }

      if (
        Object.entries(tempDevice).length !== 0 &&
        typeof devices[tempDevice.serialNumber] === 'undefined' &&
        (deviceType === undefined || (typeof deviceType === 'string' && deviceType !== '' && tempDevice.type === deviceType))
      ) {
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
          deviceOptions?.eveHistory !== undefined
            ? deviceOptions.eveHistory === true
            : homeOptions?.eveHistory !== undefined
              ? homeOptions.eveHistory === true
              : config.options?.eveHistory === true;

        devices[tempDevice.serialNumber] = tempDevice;
      }
    });

  return devices;
}
