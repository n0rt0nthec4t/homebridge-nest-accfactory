// Nest x Yale Lock (initial class - protobuf support only)
// Part of homebridge-nest-accfactory
//
// Mark Hulskamp
'use strict';

// Define our modules
import HomeKitDevice from '../HomeKitDevice.js';
import { processCommonData, scaleValue } from '../utils.js';

// Define constants
import { DATA_SOURCE, DEVICE_TYPE, PROTOBUF_RESOURCES, LOW_BATTERY_LEVEL } from '../consts.js';

export default class NestLock extends HomeKitDevice {
  static TYPE = 'Lock';
  static VERSION = '2025.08.13'; // Code version

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

          this.message(HomeKitDevice.SET, {
            uuid: this.deviceData.nest_google_uuid,
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
          this.message(HomeKitDevice.SET, {
            uuid: this.deviceData.nest_google_uuid,
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
    this.batteryService = this.addHKService(this.hap.Service.Battery, 'Battery', 1);
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

  // Process data for any lock(s) we have in the raw data
  let devices = {};
  Object.entries(rawData)
    .filter(
      ([key, value]) => key.startsWith('DEVICE_') === true && PROTOBUF_RESOURCES.LOCK.includes(value.value?.device_info?.typeName) === true,
    )
    .forEach(([object_key, value]) => {
      let tempDevice = {};
      try {
        if (
          value?.source === DATA_SOURCE.GOOGLE &&
          value.value?.configuration_done?.deviceReady === true &&
          rawData?.[value.value?.device_info?.pairerId?.resourceId] !== undefined
        ) {
          tempDevice = processCommonData(
            object_key,
            {
              type: DEVICE_TYPE.LOCK,
              model: 'x Yale Lock',
              softwareVersion: value.value.device_identity.softwareVersion,
              serialNumber: value.value.device_identity.serialNumber,
              description: String(value.value?.label?.label ?? ''),
              location: String(
                [
                  ...Object.values(
                    rawData?.[value.value?.device_info?.pairerId?.resourceId]?.value?.located_annotations?.predefinedWheres || {},
                  ),
                  ...Object.values(
                    rawData?.[value.value?.device_info?.pairerId?.resourceId]?.value?.located_annotations?.customWheres || {},
                  ),
                ].find((where) => where?.whereId?.resourceId === value.value?.device_located_settings?.whereAnnotationRid?.resourceId)
                  ?.label?.literal ?? '',
              ),
              online: value.value?.liveness?.status === 'LIVENESS_DEVICE_STATUS_ONLINE',
              tampered: value.value?.tamper?.tamperState === 'TAMPER_STATE_TAMPERED',
              bolt_state:
                value.value?.bolt_lock?.actuatorState.startsWith('BOLT_ACTUATOR_STATE_JAMMED') === true
                  ? NestLock.STATE.JAMMED
                  : value.value?.bolt_lock?.actuatorState === 'BOLT_ACTUATOR_STATE_LOCKING'
                    ? NestLock.STATE.LOCKING
                    : value.value?.bolt_lock?.actuatorState === 'BOLT_ACTUATOR_STATE_UNLOCKING'
                      ? NestLock.STATE.UNLOCKING
                      : value.value?.bolt_lock?.lockedState === 'BOLT_LOCKED_STATE_LOCKED'
                        ? NestLock.STATE.LOCKED
                        : value.value?.bolt_lock?.lockedState === 'BOLT_LOCKED_STATE_UNLOCKED'
                          ? NestLock.STATE.UNLOCKED
                          : NestLock.STATE.UNKNOWN,
              bolt_actor:
                value.value?.bolt_lock?.boltLockActor?.method === 'BOLT_LOCK_ACTOR_METHOD_PHYSICAL'
                  ? NestLock.LAST_ACTION.PHYSICAL
                  : value.value?.bolt_lock?.boltLockActor?.method === 'BOLT_LOCK_ACTOR_METHOD_KEYPAD_PIN'
                    ? NestLock.LAST_ACTION.KEYPAD
                    : [
                        'BOLT_LOCK_ACTOR_METHOD_REMOTE_USER_EXPLICIT',
                        'BOLT_LOCK_ACTOR_METHOD_REMOTE_USER_IMPLICIT',
                        'BOLT_LOCK_ACTOR_METHOD_REMOTE_USER_OTHER',
                        'BOLT_LOCK_ACTOR_METHOD_REMOTE_DELEGATE',
                      ].includes(value.value?.bolt_lock?.boltLockActor?.method) === true
                        ? NestLock.LAST_ACTION.REMOTE
                        : value.value?.bolt_lock?.boltLockActor?.method === 'BOLT_LOCK_ACTOR_METHOD_VOICE_ASSISTANT'
                          ? NestLock.LAST_ACTION.VOICE
                          : ['BOLT_LOCK_ACTOR_METHOD_LOCAL_IMPLICIT', 'BOLT_LOCK_ACTOR_METHOD_LOW_POWER_SHUTDOWN'].includes(
                              value.value?.bolt_lock?.boltLockActor?.method,
                            ) === true
                              ? NestLock.LAST_ACTION.IMPLICIT
                              : NestLock.LAST_ACTION.PHYSICAL,
              battery_level:
                isNaN(value.value?.battery_power_source?.remaining?.remainingPercent?.value) === false
                  ? scaleValue(Number(value.value?.battery_power_source?.remaining?.remainingPercent?.value), 0, 1, 0, 100)
                  : 0,
              auto_relock_duration:
                isNaN(value.value?.bolt_lock_settings?.autoRelockDuration?.seconds) === false
                  ? Number(value.value.bolt_lock_settings.autoRelockDuration.seconds)
                  : 0,
              max_auto_relock_duration:
                isNaN(value.value?.bolt_lock_capabilities?.maxAutoRelockDuration?.seconds) === false
                  ? Number(value.value.bolt_lock_capabilities.maxAutoRelockDuration.seconds)
                  : 300,
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

        // Insert any extra options we've read in from configuration file for this device
        tempDevice.eveHistory = config.options.eveHistory === true || deviceOptions?.eveHistory === true;

        devices[tempDevice.serialNumber] = tempDevice; // Store processed device
      }
    });

  return devices;
}
