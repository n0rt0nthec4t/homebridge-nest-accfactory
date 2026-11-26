// Nest × Yale Lock - HomeKit integration
// Part of homebridge-nest-accfactory
//
// HomeKit accessory implementation for Nest × Yale Lock devices.
// Provides secure lock control, battery monitoring, auto-relock configuration,
// tamper reporting, activity tracking, and structured state synchronisation
// using Google protobuf and HomeGraph API data.
//
// Responsibilities:
// - Expose lock state and control via HomeKit LockMechanism service
// - Synchronise current and target lock state with HomeKit
// - Support auto-relock timeout control
// - Report tamper, fault, and battery status
// - Record lock activity history for Eve Home integration
// - Track lock action source and transitional lock states
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
// - Transitional lock state handling (locking/unlocking)
// - Structured logging for HomeKit and external lock state changes
// - Tamper detection support
// - Battery monitoring with low battery alerts
// - Eve Home history integration
//
// Notes:
// - Tamper and auto-relock characteristics depend on reported optional fields
// - HomeGraph lock/unlock uses the shared device setting keys
// - Nest REST API is not used for lock devices
// - Lock state and actor details are normalised before presentation to HomeKit
// - Transitional lock packets may temporarily report empty actor details
// - Final lock state updates are used to synchronise HomeKit current/target state
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
import { getResourceKey, processSoftwareVersion, scaleValue, buildDeviceDescription } from '../utils.js';
import { buildMappedObject, createMappingContext, normaliseSourceContext } from '../translator.js';

// Define constants
import { DATA_SOURCE, DEVICE_TYPE, PROTOBUF_RESOURCES, LOW_BATTERY_LEVEL } from '../consts.js';

export default class NestLock extends HomeKitDevice {
  static TYPE = DEVICE_TYPE.LOCK;
  static VERSION = '2026.11.26'; // Code version

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
    this.lockService = this.addService(this.hap.Service.LockMechanism, '', 1, { primary: true, history: {} });

    // Setup set characteristics
    this.addCharacteristic(this.lockService, this.hap.Characteristic.LockCurrentState, {
      onGet: () => {
        return this.#currentState(this.deviceData);
      },
    });

    this.addCharacteristic(this.lockService, this.hap.Characteristic.LockTargetState, {
      onSet: async (value) => {
        if (value !== this.lockService.getCharacteristic(this.hap.Characteristic.LockTargetState).value) {
          let locked = value === this.hap.Characteristic.LockTargetState.SECURED;

          // Wait for cloud acceptance before HAP commits the target value.
          await this.set({
            uuid: this.deviceData.nest_google_device_uuid,
            bolt_lock: locked,
          });

          // Log lock state change with source and actor details if available
          this.#logLockChange('HomeKit', locked === true ? NestLock.STATE.LOCKED : NestLock.STATE.UNLOCKED);
        }
      },
      onGet: () => {
        return this.#targetState(this.deviceData);
      },
    });

    // Cached accessories must not retain an action inferred from an unknown actor.
    if (this.#lastAction(this.deviceData) !== undefined) {
      this.addCharacteristic(this.lockService, this.hap.Characteristic.LockLastKnownAction, {
        onGet: () => this.#lastAction(this.deviceData),
      });
    } else {
      this.removeCharacteristic(this.lockService, this.hap.Characteristic.LockLastKnownAction);
    }

    // Optional controls are configured only during accessory setup.
    if (typeof this.deviceData.auto_relock_duration === 'number' && typeof this.deviceData.max_auto_relock_duration === 'number') {
      this.addCharacteristic(this.lockService, this.hap.Characteristic.LockManagementAutoSecurityTimeout, {
        initialValue: this.deviceData.auto_relock_duration,
        props: {
          minValue: 0,
          maxValue: this.deviceData.max_auto_relock_duration,
        },
        onSet: async (value) => {
          value = Math.floor(value); // Make a round number

          if (value !== this.deviceData.auto_relock_duration) {
            // A timeout change follows the same cloud acceptance boundary as bolt control.
            await this.set({
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
      });
    } else {
      this.removeCharacteristic(this.lockService, this.hap.Characteristic.LockManagementAutoSecurityTimeout);
    }

    if (typeof this.deviceData.tampered === 'boolean') {
      this.addCharacteristic(this.lockService, this.hap.Characteristic.StatusTampered, {
        initialValue:
          this.deviceData.tampered === true
            ? this.hap.Characteristic.StatusTampered.TAMPERED
            : this.hap.Characteristic.StatusTampered.NOT_TAMPERED,
      });
    } else {
      this.removeCharacteristic(this.lockService, this.hap.Characteristic.StatusTampered);
    }

    // Setup battery service if not already present on the accessory
    this.batteryService = this.addService(this.hap.Service.Battery, '', 1, { hidden: true });
  }

  onRemove() {
    this.removeService(this.lockService);
    this.removeService(this.batteryService);
    this.lockService = undefined;
    this.batteryService = undefined;
  }

  onUpdate(deviceData) {
    if (
      typeof deviceData !== 'object' ||
      deviceData?.constructor !== Object ||
      this.lockService === undefined ||
      this.batteryService === undefined
    ) {
      return;
    }

    // Update lock state
    this.lockService.updateCharacteristic(this.hap.Characteristic.LockCurrentState, this.#currentState(deviceData));
    this.lockService.updateCharacteristic(this.hap.Characteristic.LockTargetState, this.#targetState(deviceData));
    // Only completed actions with a known method have a truthful HAP representation.
    let action = this.#lastAction(deviceData);
    if (action !== undefined) {
      if (this.lockService.testCharacteristic(this.hap.Characteristic.LockLastKnownAction) === false) {
        this.addCharacteristic(this.lockService, this.hap.Characteristic.LockLastKnownAction, {
          onGet: () => this.#lastAction(this.deviceData),
        });
      }
      this.lockService.updateCharacteristic(this.hap.Characteristic.LockLastKnownAction, action);
    } else {
      this.removeCharacteristic(this.lockService, this.hap.Characteristic.LockLastKnownAction);
    }

    // Optional characteristics retain their last value when an update has no reading.
    if (
      this.lockService.testCharacteristic(this.hap.Characteristic.LockManagementAutoSecurityTimeout) === true &&
      typeof deviceData.auto_relock_duration === 'number'
    ) {
      this.lockService.updateCharacteristic(this.hap.Characteristic.LockManagementAutoSecurityTimeout, deviceData.auto_relock_duration);
    }

    if (this.lockService.testCharacteristic(this.hap.Characteristic.StatusTampered) === true && typeof deviceData.tampered === 'boolean') {
      this.lockService.updateCharacteristic(
        this.hap.Characteristic.StatusTampered,
        deviceData.tampered === true
          ? this.hap.Characteristic.StatusTampered.TAMPERED
          : this.hap.Characteristic.StatusTampered.NOT_TAMPERED,
      );
    }

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

    // Log lock state changes with source and actor details if available
    if (deviceData.bolt_state !== this.deviceData.bolt_state) {
      this.#logLockChange('Lock', deviceData.bolt_state, deviceData.bolt_actor);
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
    if (deviceData.bolt_state !== NestLock.STATE.LOCKED && deviceData.bolt_state !== NestLock.STATE.UNLOCKED) {
      return undefined;
    }
    let secured = deviceData.bolt_state === NestLock.STATE.LOCKED;

    // Lock/unlock initiated physically at the lock
    if (deviceData.bolt_actor === NestLock.LAST_ACTION.PHYSICAL) {
      return secured === true
        ? this.hap.Characteristic.LockLastKnownAction.SECURED_PHYSICALLY
        : this.hap.Characteristic.LockLastKnownAction.UNSECURED_PHYSICALLY;
    }

    // Lock/unlock initiated from keypad
    if (deviceData.bolt_actor === NestLock.LAST_ACTION.KEYPAD) {
      return secured === true
        ? this.hap.Characteristic.LockLastKnownAction.SECURED_BY_KEYPAD
        : this.hap.Characteristic.LockLastKnownAction.UNSECURED_BY_KEYPAD;
    }

    // Lock/unlock initiated remotely (app/automation/voice assistant)
    if (deviceData.bolt_actor === NestLock.LAST_ACTION.REMOTE || deviceData.bolt_actor === NestLock.LAST_ACTION.VOICE) {
      return secured === true
        ? this.hap.Characteristic.LockLastKnownAction.SECURED_REMOTELY
        : this.hap.Characteristic.LockLastKnownAction.UNSECURED_REMOTELY;
    }

    // HAP has no automatic-unlock value; do not substitute a remote action.
    if (deviceData.bolt_actor === NestLock.LAST_ACTION.IMPLICIT && secured === true) {
      return this.hap.Characteristic.LockLastKnownAction.SECURED_BY_AUTO_SECURE_TIMEOUT;
    }

    return undefined;
  }

  #logLockChange(source, stateLabel, actor = undefined) {
    // Ignore invalid/empty state labels
    if (typeof stateLabel !== 'string' || stateLabel.trim() === '') {
      return;
    }

    // Jammed state is always noteworthy, regardless of where the change originated
    if (stateLabel === NestLock.STATE.JAMMED) {
      this?.log?.error?.('Lock jammed on "%s"', this.deviceData.description);
      return;
    }

    // Any transition away from jammed means the lock has recovered
    if (this.deviceData.bolt_state === NestLock.STATE.JAMMED) {
      this?.log?.info?.('Lock unjammed on "%s"', this.deviceData.description);
      return;
    }

    // Format state label for cleaner logging output
    stateLabel = stateLabel.charAt(0).toUpperCase() + stateLabel.slice(1).toLowerCase();

    // Convert internal actor enum into user-friendly log label
    actor =
      actor === NestLock.LAST_ACTION.KEYPAD
        ? 'keypad'
        : actor === NestLock.LAST_ACTION.REMOTE
          ? 'remote'
          : actor === NestLock.LAST_ACTION.VOICE
            ? 'voice'
            : actor === NestLock.LAST_ACTION.IMPLICIT
              ? 'auto'
              : actor === NestLock.LAST_ACTION.PHYSICAL
                ? 'physical'
                : undefined;

    // HomeKit-originated changes are explicit user requests
    if (source === 'HomeKit') {
      this?.log?.info?.('Set lock on "%s" to "%s"', this.deviceData.description, stateLabel);
      return;
    }

    // External lock state changes are logged at debug level
    // These may originate from keypad, physical interaction,
    // remote actions, or automatic lock behaviour
    this?.log?.debug?.(
      'Lock on "%s" changed to "%s"%s',
      this.deviceData.description,
      stateLabel,
      actor !== undefined ? ' by ' + actor : '',
    );
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
      fields: [],
      translate: ({ raw }) =>
        typeof raw?.value?.device_identity?.serialNumber === 'string' && raw.value.device_identity.serialNumber.trim() !== ''
          ? raw.value.device_identity.serialNumber.trim().toUpperCase()
          : undefined,
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['technicalInformation'],
      translate: ({ raw }) => {
        let serial = raw.value.technicalInformation?.serialNumber;
        return typeof serial === 'string' && serial.trim() !== '' ? serial.trim().toUpperCase() : undefined;
      },
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

  // Core operational fields
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

  tampered: {
    // Retain absence while HomeGraph has no verified tamper-state mapping.
    merge: ({ values, context }) => (context.sources.googlehome === undefined ? values.google : undefined),
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
    prefer: 'googlehome',
    googlehome: {
      fields: ['lockUnlock.isLocked', 'lockUnlock.isJammed'],
      translate: ({ raw }) => {
        // Jammed takes precedence; absent state must not imply an unlocked door.
        let locked = raw.value['lockUnlock.isLocked']?.boolean;
        return raw.value['lockUnlock.isJammed']?.boolean === true
          ? NestLock.STATE.JAMMED
          : locked === true
            ? NestLock.STATE.LOCKED
            : locked === false
              ? NestLock.STATE.UNLOCKED
              : undefined;
      },
    },
  },

  bolt_actor: {
    // HomeGraph has no verified method or event correlation with protobuf actors.
    merge: ({ values, context }) => (context.sources.googlehome === undefined ? values.google : undefined),
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
                  : raw?.value?.bolt_lock?.boltLockActor?.method === 'BOLT_LOCK_ACTOR_METHOD_LOCAL_IMPLICIT'
                    ? NestLock.LAST_ACTION.IMPLICIT
                    : undefined,
    },
  },

  battery_level: {
    required: true,
    google: {
      fields: ['battery_power_source'],
      translate: ({ raw }) =>
        // Google API reports lock battery remaining as fractional percentage (0–1)
        Number.isFinite(Number(raw?.value?.battery_power_source?.remaining?.remainingPercent?.value)) === true
          ? Math.round(scaleValue(Number(raw.value.battery_power_source.remaining.remainingPercent.value), 0, 1, 0, 100))
          : undefined,
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['charging.capacityRemainingPercentage', 'charging.descriptiveCapacityRemaining'],
      translate: ({ raw }) => {
        let level = raw.value['charging.capacityRemainingPercentage']?.number;
        if (typeof level === 'number' && Number.isFinite(level) === true && level >= 0 && level <= 100) {
          return Math.round(level);
        }
        // Qualitative categories use the same coarse estimates as other devices.
        let levels = { full: 100, high: 75, medium: 50, low: LOW_BATTERY_LEVEL, critically_low: Math.floor(LOW_BATTERY_LEVEL / 2) };
        let capacity = raw.value['charging.descriptiveCapacityRemaining']?.text;
        return Object.hasOwn(levels, capacity) === true ? levels[capacity] : undefined;
      },
    },
  },

  // Auto-relock controls require the selected API to support their writes.
  // Protobuf-only controls must not appear on HomeGraph-backed accessories.
  auto_relock_duration: {
    merge: ({ values, context }) => (context.sources.googlehome === undefined ? values.google : undefined),
    google: {
      fields: ['bolt_lock_settings'],
      translate: ({ raw }) =>
        Number.isFinite(Number(raw?.value?.bolt_lock_settings?.autoRelockDuration?.seconds)) === true
          ? Number(raw.value.bolt_lock_settings.autoRelockDuration.seconds)
          : undefined,
    },
  },

  max_auto_relock_duration: {
    merge: ({ values, context }) => (context.sources.googlehome === undefined ? values.google : undefined),
    google: {
      fields: ['bolt_lock_capabilities'],
      translate: ({ raw }) =>
        Number.isFinite(Number(raw?.value?.bolt_lock_capabilities?.maxAutoRelockDuration?.seconds)) === true
          ? Number(raw.value.bolt_lock_capabilities.maxAutoRelockDuration.seconds)
          : undefined,
    },
  },
};

// Process committed protobuf locks and the verified HomeGraph lock state subset.
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

  let devices = {};
  let contexts = new Map();
  Object.entries(rawData)
    .filter(
      ([key, value]) =>
        key.startsWith('DEVICE_') === true &&
        ((value?.source === DATA_SOURCE.PROTOBUF && PROTOBUF_RESOURCES.LOCK.includes(value?.value?.device_info?.typeName) === true) ||
          (value?.source === DATA_SOURCE.HOMEGRAPH &&
            value?.value?.googleHome?.type === 'action.devices.types.LOCK' &&
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
        // Revisit cached lock traits when the device or its home changes, including late parent discovery.
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
        // Only process valid Google lock devices that are ready and linked to a known home object
        if (
          (isHomeGraph !== true && value?.value?.configuration_done?.deviceReady !== true) ||
          home === undefined ||
          (isHomeGraph === true && (home.source !== DATA_SOURCE.HOMEGRAPH || home.connection !== value.connection))
        ) {
          return;
        }

        let source = isHomeGraph === true ? 'googlehome' : 'google';
        candidate.context.sources[source] = normaliseSourceContext(source, object_key, value, { homeId });
        for (let field of Object.keys(value.value)) {
          candidate.fields.add(field);
        }
      } catch (error) {
        log?.error?.('Error processing lock data for "%s": %s', object_key, String(error));
      }
    });

  for (let [serialNumber, candidate] of contexts) {
    if (candidate.changed !== true) {
      continue;
    }
    try {
      let mappedResult = buildMappedObject(LOCK_FIELD_MAP, candidate.context, candidate.fields);
      // Undefined fields retain old values in accessory delta merges. Explicit
      // absence clears optional data when the selected representation changes.
      for (let field of ['bolt_actor', 'tampered', 'auto_relock_duration', 'max_auto_relock_duration']) {
        mappedResult.data[field] ??= null;
      }

      // If we have all required fields, build the full lock device data object
      if (mappedResult?.hasRequired === true) {
        let tempDevice = {
          type: DEVICE_TYPE.LOCK,
          model: 'x Yale Lock',
          manufacturer: 'Nest',
          ...mappedResult.data,
        };

        let deviceOptions = config?.devices?.find(
          (device) => device?.serialNumber?.toUpperCase?.() === tempDevice?.serialNumber?.toUpperCase?.(),
        );
        let homeOptions = config?.homes?.find(
          (home) =>
            home?.homegraph_home_uuid?.toUpperCase?.() === tempDevice?.nest_google_home_uuid?.toUpperCase?.() ||
            home?.protobuf_home_uuid?.toUpperCase?.() === tempDevice?.nest_google_home_uuid?.toUpperCase?.(),
        );

        tempDevice.eveHistory =
          deviceOptions?.eveHistory !== undefined ? deviceOptions.eveHistory === true : config?.options?.eveHistory === true;

        tempDevice.excluded =
          deviceOptions?.exclude === true ||
          (deviceOptions?.exclude !== false &&
            (homeOptions?.exclude === true || (homeOptions?.exclude !== false && config?.options?.exclude === true)));

        devices[serialNumber] = { full: true, data: tempDevice };
      } else if (mappedResult.data.serialNumber !== undefined) {
        devices[serialNumber] = { full: false, data: mappedResult.data };
      }
    } catch (error) {
      log?.error?.('Error processing lock data for "%s": %s', serialNumber, String(error));
    }
  }
  return devices;
}
