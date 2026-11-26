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
// - Translate protobuf and HomeGraph sensor data using the normal field map
// - Physical serial numbers preserve accessory identity across resource updates
// - Temperature values are normalised before HomeKit presentation
//
// Data Translation:
// - Raw data is mapped using TEMPSENSOR_FIELD_MAP
// - processRawData() builds device objects from thermostat-linked sensors
// - Physical serial numbers keep sensor accessory identity independent of source
// - Field mapping isolates upstream API differences from HomeKit representation
//
// Mark Hulskamp
'use strict';

// Define our modules
import HomeKitDevice from '../HomeKitDevice.js';
import { getResourceKey, adjustTemperature, scaleValue, buildDeviceDescription } from '../utils.js';
import { buildMappedObject, createMappingContext, normaliseSourceContext } from '../translator.js';

// Define constants
import { LOW_BATTERY_LEVEL, DATA_SOURCE, PROTOBUF_RESOURCES, DEVICE_TYPE, CUSTOM_CHARACTERISTIC_UUID } from '../consts.js';

export default class NestTemperatureSensor extends HomeKitDevice {
  static TYPE = DEVICE_TYPE.TEMPSENSOR;
  static VERSION = '2026.11.26'; // Code version

  batteryService = undefined;
  temperatureService = undefined;

  // Class functions
  onAdd() {
    // Setup temperature service if not already present on the accessory and link it to the Eve app if configured to do so
    this.temperatureService = this.addService(this.hap.Service.TemperatureSensor, '', 1, { primary: true, history: {} });

    // Report whether the temperature sensor is online.
    this.addCharacteristic(this.temperatureService, this.hap.Characteristic.StatusActive);

    // Report and control whether this sensor supplies the thermostat's control temperature.
    this.addCharacteristic(
      this.temperatureService,
      {
        name: 'Active Temperature Sensor',
        uuid: CUSTOM_CHARACTERISTIC_UUID.ACTIVE_TEMPERATURE_SENSOR,
        props: { format: this.hap.Formats.BOOL, perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.PAIRED_WRITE, this.hap.Perms.NOTIFY] },
      },
      {
        onGet: () => this.deviceData.active_sensor === true,
        onSet: async (value) => {
          if (typeof value !== 'boolean') {
            throw new this.hap.HapStatusError(this.hap.HAPStatus.INVALID_VALUE_IN_REQUEST);
          }
          if (typeof this.deviceData.associated_thermostat !== 'string' || this.deviceData.associated_thermostat === '') {
            throw new this.hap.HapStatusError(this.hap.HAPStatus.NOT_ALLOWED_IN_CURRENT_STATE);
          }
          // An Off action on an unselected sensor must not deselect another sensor.
          if (value === false && this.deviceData.active_sensor !== true) {
            return;
          }
          await this.set({ uuid: this.deviceData.nest_google_device_uuid, active_sensor: value });
        },
      },
    );

    // Setup battery service if not already present on the accessory
    this.batteryService = this.addService(this.hap.Service.Battery, '', 1, { hidden: true });
    this.temperatureService.addLinkedService(this.batteryService);
  }

  onRemove() {
    this.removeService(this.temperatureService);
    this.removeService(this.batteryService);
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

    this.temperatureService.updateCharacteristic(this.hap.Characteristic.StatusActive, deviceData.online === true);

    // If device isn't online report in HomeKit
    this.temperatureService.updateCharacteristic(
      this.hap.Characteristic.StatusFault,
      deviceData.online === true ? this.hap.Characteristic.StatusFault.NO_FAULT : this.hap.Characteristic.StatusFault.GENERAL_FAULT,
    );

    // Selection remains visible while offline; StatusFault reports sensor availability.
    this.temperatureService.updateCharacteristic(this.hap.Characteristic.ActiveTemperatureSensor, deviceData.active_sensor === true);

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

// Temperature sensor field translation map
// Maps raw source data -> normalised device fields
// - fields: top-level raw fields this mapping depends on (for delta updates)
// - translate: converts raw -> candidate value
// - merge: combines source values into the final normalised value
// IMPORTANT:
// `raw` in this map represents the temperature sensor resource itself.
// Thermostat relationship details are passed separately via mapping context.
const TEMPSENSOR_FIELD_MAP = {
  // Identity fields
  serialNumber: {
    required: true,
    google: {
      fields: [],
      translate: ({ raw }) => {
        let value = raw?.value;

        return typeof value?.device_identity?.serialNumber === 'string' && value.device_identity.serialNumber !== ''
          ? value.device_identity.serialNumber.trim().toUpperCase()
          : undefined;
      },
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
      translate: ({ sensorUUID }) => sensorUUID,
    },
    prefer: 'googlehome',
    googlehome: { fields: [], translate: ({ objectKey }) => objectKey },
  },

  nest_google_home_uuid: {
    google: {
      fields: [],
      translate: ({ homeUUID }) => homeUUID,
    },
    prefer: 'googlehome',
    googlehome: { fields: ['structureId'], translate: ({ homeUUID }) => homeUUID },
  },

  // Naming / descriptive fields
  model: {
    required: true,
    google: {
      fields: ['device_info', 'device_identity'],
      translate: ({ raw }) => {
        let value = raw?.value;
        let typeName = value?.device_info?.typeName ?? '';
        let productId = value?.device_identity?.productIdDescription?.literal ?? '';

        return typeName === 'nest.resource.NestKryptoniteResource' && productId === 'KRX'
          ? 'Temperature Sensor (2nd gen)'
          : typeName === 'nest.resource.NestKryptoniteResource' && productId === 'KR1'
            ? 'Temperature Sensor (1st gen)'
            : 'Temperature Sensor (unknown)';
      },
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['googleHome'],
      // Current samples do not identify the temperature-sensor generation.
      translate: () => 'Temperature Sensor',
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

  battery_level: {
    required: true,
    google: {
      fields: ['battery'],
      translate: ({ raw }) => {
        let value = raw?.value;

        return Number.isFinite(Number(value?.battery?.assessedVoltage?.value)) === true
          ? Math.round(scaleValue(Number(value.battery.assessedVoltage.value), 2.5, 3.2, 0, 100))
          : undefined;
      },
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['charging.descriptiveCapacityRemaining'],
      translate: ({ raw }) => {
        // Google supplies a category, not a measured percentage. Keep low
        // categories at/below the existing low-battery threshold.
        let levels = { full: 100, high: 75, medium: 50, low: LOW_BATTERY_LEVEL, critically_low: Math.floor(LOW_BATTERY_LEVEL / 2) };
        let capacity = raw.value['charging.descriptiveCapacityRemaining']?.text;
        return Object.hasOwn(levels, capacity) === true ? levels[capacity] : undefined;
      },
    },
  },

  current_temperature: {
    required: true,
    google: {
      fields: ['current_temperature'],
      translate: ({ raw }) => {
        let value = raw?.value;

        return Number.isFinite(Number(value?.current_temperature?.temperatureValue?.temperature?.value)) === true
          ? adjustTemperature(Number(value.current_temperature.temperatureValue.temperature.value), 'C', 'C', true)
          : undefined;
      },
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['temperatureSetting.ambientAirTemperatureC'],
      translate: ({ raw }) => {
        let temperature = raw.value['temperatureSetting.ambientAirTemperatureC']?.number;
        return typeof temperature === 'number' && Number.isFinite(temperature) === true && temperature >= -270 && temperature <= 100
          ? adjustTemperature(temperature, 'C', 'C', true)
          : undefined;
      },
    },
  },

  online: {
    required: true,
    google: {
      fields: ['last_updated_beacon'],
      translate: ({ raw }) => {
        let value = raw?.value;

        return (
          Number.isFinite(Number(value?.last_updated_beacon?.lastBeaconTime?.seconds)) === true &&
          Math.floor(Date.now() / 1000) - Number(value.last_updated_beacon.lastBeaconTime.seconds) < 3600 * 4
        );
      },
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['deviceStatus.online'],
      translate: ({ raw }) =>
        typeof raw.value['deviceStatus.online']?.boolean === 'boolean' ? raw.value['deviceStatus.online'].boolean : undefined,
    },
  },

  // Parent identity and selection must belong to the API receiving sensor commands.
  associated_thermostat: {
    merge: ({ values, context }) => (context.sources.googlehome !== undefined ? values.googlehome : values.google),
    google: {
      fields: [],
      translate: ({ parentUUID }) => parentUUID,
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['googleHome', 'structureId'],
      related: ['temperatureSetting.knownThermostatTemperatureSensors'],
      translate: ({ parentUUID }) => parentUUID,
    },
  },

  active_sensor: {
    merge: ({ values, context }) => (context.sources.googlehome !== undefined ? values.googlehome : values.google),
    google: {
      fields: [],
      translate: ({ active_sensor }) => active_sensor === true,
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['googleHome', 'structureId'],
      related: ['temperatureSetting.activeThermostatTemperatureSensors', 'temperatureSetting.knownThermostatTemperatureSensors'],
      translate: ({ active_sensor }) => active_sensor,
    },
  },
};

// Process thermostat-linked protobuf sensors and discovered Google Home sensors.
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

  // Discover linked protobuf sensors and retain their physical serial identities.
  let devices = {};
  let contexts = new Map();

  // Both APIs identify the same physical sensor; only relationship discovery differs.
  const addSource = (objectKey, raw, source, details, relatedIds) => {
    let serial = raw.value.technicalInformation?.serialNumber ?? raw.value.device_identity?.serialNumber;
    if (typeof serial !== 'string' || serial.trim() === '') {
      return;
    }
    serial = serial.trim().toUpperCase();
    let candidate = contexts.get(serial) ?? {
      context: createMappingContext(rawData, objectKey),
      fields: new Set(['home', 'located_annotations']),
      changed: changedData instanceof Map !== true,
    };
    candidate.context.sources[source] = normaliseSourceContext(source, objectKey, raw, details);
    for (let field of Object.keys(raw.value)) {
      candidate.fields.add(field);
    }
    candidate.changed = candidate.changed === true || [objectKey, ...relatedIds].some((id) => changedData?.has?.(id) === true);
    contexts.set(serial, candidate);
  };

  Object.entries(rawData)
    .filter(
      ([key, value]) =>
        key.startsWith('DEVICE_') === true &&
        value?.source === DATA_SOURCE.PROTOBUF &&
        PROTOBUF_RESOURCES.THERMOSTAT.includes(value?.value?.device_info?.typeName) === true,
    )
    .forEach(([object_key, value]) => {
      try {
        let homeUUID = value?.value?.device_info?.pairerId?.resourceId;
        let settings = value?.value?.remote_comfort_sensing_settings;
        if (
          value?.value?.configuration_done?.deviceReady !== true ||
          typeof homeUUID !== 'string' ||
          rawData?.[homeUUID] === undefined ||
          Array.isArray(settings?.associatedRcsSensors) !== true
        ) {
          return;
        }

        settings.associatedRcsSensors.forEach((sensor) => {
          let sensorUUID = sensor?.deviceId?.resourceId;
          let sensorRaw = rawData?.[sensorUUID];
          let sensorValue = sensorRaw?.value;
          if (
            typeof sensorUUID !== 'string' ||
            sensorUUID === '' ||
            sensorRaw?.source !== DATA_SOURCE.PROTOBUF ||
            typeof sensorValue !== 'object' ||
            sensorValue === null ||
            sensorValue.constructor !== Object
          ) {
            return;
          }
          let pairerUUID = sensorValue?.device_info?.pairerId?.resourceId;
          addSource(
            sensorUUID,
            sensorRaw,
            'google',
            {
              sensorUUID,
              homeUUID,
              parentUUID: object_key,
              pairerUUID,
              active_sensor: settings?.activeRcsSelection?.activeRcsSensor?.resourceId === sensorUUID,
            },
            [object_key, homeUUID, pairerUUID],
          );
        });
      } catch (error) {
        log?.error?.('Error processing temperature sensor data for "%s": %s', object_key, String(error));
      }
    });

  for (let [objectKey, raw] of Object.entries(rawData)) {
    let device = raw?.value?.googleHome;
    if (
      raw?.source !== DATA_SOURCE.HOMEGRAPH ||
      device?.type !== 'action.devices.types.SENSOR' ||
      device.hardware?.model !== 'Nest Temperature Sensor' ||
      device.id?.thirdPartyId?.idType?.startsWith('nest') !== true
    ) {
      continue;
    }
    let structureId = raw.value.structureId;
    let homeUUID = typeof structureId === 'string' ? getResourceKey(raw.connection, raw.source, structureId, 'STRUCTURE') : undefined;
    // Resolve parents only through their explicit sensor list in this account/home.
    // Re-evaluate when any thermostat in that home changes, including deselection
    // or removal from a previously reported sensor list.
    let thermostats = Object.entries(rawData).filter(
      ([, parent]) =>
        parent?.source === DATA_SOURCE.HOMEGRAPH &&
        parent.connection === raw.connection &&
        typeof structureId === 'string' &&
        parent.value?.structureId === structureId &&
        parent.value?.googleHome?.type === 'action.devices.types.THERMOSTAT' &&
        parent.value.googleHome.id?.thirdPartyId?.idType?.startsWith('nest') === true,
    );
    let parents = thermostats.filter(
      ([, parent]) =>
        parent.value['temperatureSetting.knownThermostatTemperatureSensors']?.array?.values?.some(
          (sensor) =>
            sensor?.properties?.properties?.some(
              (property) => property.name === 'sensorId' && property.value?.text === device.id.googleUuid,
            ) === true,
        ) === true,
    );
    let parentUUID;
    let active_sensor;
    if (parents.length === 1) {
      parentUUID = parents[0][0];
      let selected = parents[0][1].value['temperatureSetting.activeThermostatTemperatureSensors']?.array?.values;
      if (Array.isArray(selected) === true && selected.every((sensor) => typeof sensor?.text === 'string') === true) {
        active_sensor = selected.some((sensor) => sensor.text === device.id.googleUuid);
      }
    }
    addSource(objectKey, raw, 'googlehome', { homeUUID, parentUUID, active_sensor }, [homeUUID, ...thermostats.map(([key]) => key)]);
  }

  for (let entry of contexts.values()) {
    if (entry.changed !== true) {
      continue;
    }
    let mapped = buildMappedObject(TEMPSENSOR_FIELD_MAP, entry.context, entry.fields);
    if (mapped.hasRequired !== true) {
      continue;
    }
    let candidate = { type: DEVICE_TYPE.TEMPSENSOR, softwareVersion: NestTemperatureSensor.VERSION, manufacturer: 'Nest', ...mapped.data };
    if (deviceType !== undefined && (typeof deviceType !== 'string' || deviceType === '' || candidate.type !== deviceType)) {
      continue;
    }

    let deviceOptions = config?.devices?.find(
      (device) => device?.serialNumber?.toUpperCase?.() === candidate?.serialNumber?.toUpperCase?.(),
    );
    let homeOptions = config?.homes?.find(
      (home) =>
        home?.protobuf_home_uuid?.toUpperCase?.() === candidate?.nest_google_home_uuid?.toUpperCase?.() ||
        home?.homegraph_home_uuid?.toUpperCase?.() === candidate?.nest_google_home_uuid?.toUpperCase?.(),
    );

    candidate.eveHistory =
      deviceOptions?.eveHistory !== undefined ? deviceOptions.eveHistory === true : config?.options?.eveHistory === true;

    candidate.excluded =
      deviceOptions?.exclude === true ||
      (deviceOptions?.exclude !== false &&
        (homeOptions?.exclude === true || (homeOptions?.exclude !== false && config?.options?.exclude === true)));

    devices[candidate.serialNumber] = {
      full: true,
      data: candidate,
    };
  }

  return devices;
}
