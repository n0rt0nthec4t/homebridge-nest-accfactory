// Nest Heatlink
// Part of homebridge-nest-accfactory
//
// Mark Hulskamp
'use strict';

// Define our modules
import HomeKitDevice from '../HomeKitDevice.js';
import { processCommonData, adjustTemperature, parseDurationToSeconds } from '../utils.js';

// Define constants
import {
  DATA_SOURCE,
  DEVICE_TYPE,
  HOTWATER_MAX_TEMPERATURE,
  HOTWATER_MIN_TEMPERATURE,
  PROTOBUF_RESOURCES,
  HOTWATER_BOOST_TIMES,
} from '../consts.js';

export default class NestHeatlink extends HomeKitDevice {
  static TYPE = 'Heatlink';
  static VERSION = '2025.11.23'; // Code version

  thermostatService = undefined; // Hotwater temperature control
  switchService = undefined; // Hotwater heating boost control

  onAdd() {
    // Patch to avoid characteristic errors when setting initial property ranges
    this.hap.Characteristic.TargetTemperature.prototype.getDefaultValue = () => {
      return this.deviceData.hotwaterMinTemp; // start at minimum heating threshold
    };
    this.hap.Characteristic.TargetHeatingCoolingState.prototype.getDefaultValue = () => {
      return this.hap.Characteristic.TargetHeatingCoolingState.HEAT; // Only heating
    };

    // If the heatlink supports hotwater temperature control
    // Setup the thermostat service if not already present on the accessory, and link it to the Eve app if configured to do so
    if (this.deviceData?.has_hot_water_control === true && this.deviceData?.has_hot_water_temperature === true) {
      this.#setupHotwaterTemperature();
    }

    if (this.deviceData?.has_hot_water_control === false || this.deviceData?.has_hot_water_temperature === false) {
      // No longer have hotwater temperature control configured and service present, so removed it
      this.thermostatService = this.accessory.getService(this.hap.Service.Thermostat);
      if (this.thermostatService !== undefined) {
        this.accessory.removeService(this.thermostatService);
      }
      this.thermostatService = undefined;
    }

    // Setup hotwater boost heating service if supported by the thermostat and not already present on the accessory
    if (this.deviceData?.has_hot_water_control === true) {
      this.#setupHotwaterBoost();
    }
    if (this.deviceData?.has_hot_water_control === false) {
      // No longer have hotwater heating configured and service present, so removed it
      this.switchService = this.accessory.getService(this.hap.Service.Switch);
      if (this.switchService !== undefined) {
        this.accessory.removeService(this.switchService);
      }
      this.switchService = undefined;
    }

    // Extra setup details for output
    this.thermostatService !== undefined &&
      this.postSetupDetail('Temperature control (' + this.deviceData.hotwaterMinTemp + '–' + this.deviceData.hotwaterMaxTemp + '°C)');
  }

  onRemove() {
    this.accessory.removeService(this.thermostatService);
    this.accessory.removeService(this.switchService);
    this.thermostatService = undefined;
    this.switchService = undefined;
  }

  onUpdate(deviceData) {
    if (typeof deviceData !== 'object') {
      return;
    }

    // TODO dynamic changes to hotwater setup ie: boost control and temperature control

    if (this.thermostatService !== undefined) {
      // Update when we have hot water temperature control
      this.thermostatService.updateCharacteristic(
        this.hap.Characteristic.TemperatureDisplayUnits,
        deviceData.temperature_scale.toUpperCase() === 'C'
          ? this.hap.Characteristic.TemperatureDisplayUnits.CELSIUS
          : this.hap.Characteristic.TemperatureDisplayUnits.FAHRENHEIT,
      );

      this.thermostatService.updateCharacteristic(this.hap.Characteristic.CurrentTemperature, deviceData.current_water_temperature);
      this.thermostatService.updateCharacteristic(this.hap.Characteristic.TargetTemperature, deviceData.hot_water_temperature);
      this.thermostatService.updateCharacteristic(
        this.hap.Characteristic.CurrentHeatingCoolingState,
        deviceData.hot_water_active === true
          ? this.hap.Characteristic.CurrentHeatingCoolingState.HEAT
          : this.hap.Characteristic.CurrentHeatingCoolingState.OFF,
      );

      this.thermostatService.updateCharacteristic(this.hap.Characteristic.StatusActive, deviceData.online === true);

      // Log thermostat metrics to history only if changed to previous recording
      this.history(this.thermostatService, {
        status: deviceData.hot_water_active === true ? 2 : 0, // 2 - heating water, 0 - not heating water
        temperature: deviceData.current_water_temperature,
        target: deviceData.hot_water_temperature,
      });

      // Update our internal data with properties Eve will need to process then Notify Eve App of device status changes if linked
      this.deviceData.online = deviceData.online;
      this.historyService?.updateEveHome?.(this.thermostatService);
    }

    if (this.switchService !== undefined) {
      // Hotwater boost status on or off
      this.switchService.updateCharacteristic(this.hap.Characteristic.On, deviceData.hot_water_boost_active === true);
    }
  }

  onMessage(type, message) {
    if (typeof type !== 'string' || type === '' || message === null || typeof message !== 'object' || message?.constructor !== Object) {
      return;
    }

    if (type === HomeKitDevice?.HISTORY?.GET) {
      // Extend Eve Thermo GET payload with device state
      message.attached = this.deviceData.online === true;
      return message;
    }
  }

  #setupHotwaterTemperature() {
    this.thermostatService = this.addHKService(this.hap.Service.Thermostat, '', 1, { messages: this.message.bind(this) });
    this.thermostatService.setPrimaryService();

    this.addHKCharacteristic(this.thermostatService, this.hap.Characteristic.StatusActive);

    this.addHKCharacteristic(this.thermostatService, this.hap.Characteristic.TemperatureDisplayUnits, {
      onSet: (value) => {
        let unit = value === this.hap.Characteristic.TemperatureDisplayUnits.CELSIUS ? 'C' : 'F';

        this.message(HomeKitDevice.SET, {
          uuid: this.deviceData.associated_thermostat,
          temperature_scale: unit,
        });

        this.thermostatService.updateCharacteristic(this.hap.Characteristic.TemperatureDisplayUnits, value);

        this?.log?.info?.('Set temperature units on heatlink "%s" to "%s"', this.deviceData.description, unit === 'C' ? '°C' : '°F');
      },
      onGet: () => {
        return this.deviceData.temperature_scale.toUpperCase() === 'C'
          ? this.hap.Characteristic.TemperatureDisplayUnits.CELSIUS
          : this.hap.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
      },
    });

    this.addHKCharacteristic(this.thermostatService, this.hap.Characteristic.CurrentTemperature, {
      props: { minStep: 0.5 },
      onGet: () => {
        return this.deviceData.current_water_temperature;
      },
    });

    this.addHKCharacteristic(this.thermostatService, this.hap.Characteristic.TargetTemperature, {
      props: {
        minStep: 0.5,
        minValue: this.deviceData.hotwaterMinTemp,
        maxValue: this.deviceData.hotwaterMaxTemp,
      },
      onSet: (value) => {
        if (value !== this.deviceData.hot_water_temperature) {
          this.message(HomeKitDevice.SET, { uuid: this.deviceData.associated_thermostat, hot_water_temperature: value });

          this?.log?.info?.('Set hotwater boiler temperature on heatlink "%s" to "%s °C"', this.deviceData.description, value);
        }
      },
      onGet: () => {
        return this.deviceData.hot_water_temperature;
      },
    });

    // We only support heating for this thermostat service
    this.addHKCharacteristic(this.thermostatService, this.hap.Characteristic.TargetHeatingCoolingState, {
      props: {
        validValues: [this.hap.Characteristic.TargetHeatingCoolingState.HEAT],
      },
    });
  }

  #setupHotwaterBoost() {
    this.switchService = this.addHKService(this.hap.Service.Switch, '', 1);

    this.addHKCharacteristic(this.switchService, this.hap.Characteristic.On, {
      onSet: (value) => {
        if (value !== this.deviceData.hot_water_boost_active) {
          this.message(HomeKitDevice.SET, {
            uuid: this.deviceData.associated_thermostat,
            hot_water_boost_active: { state: value === true, time: this.deviceData.hotwaterBoostTime },
          });

          this.switchService.updateCharacteristic(this.hap.Characteristic.On, value);

          this?.log?.info?.(
            'Set hotwater boost heating on heatlink "%s" to "%s"',
            this.deviceData.description,
            value === true
              ? 'On for ' +
                  (this.deviceData.hotwaterBoostTime >= 3600
                    ? Math.floor(this.deviceData.hotwaterBoostTime / 3600) +
                      ' hr' +
                      (Math.floor(this.deviceData.hotwaterBoostTime / 3600) > 1 ? 's ' : ' ')
                    : '') +
                  Math.floor((this.deviceData.hotwaterBoostTime % 3600) / 60) +
                  ' min' +
                  (Math.floor((this.deviceData.hotwaterBoostTime % 3600) / 60) !== 1 ? 's' : '')
              : 'Off',
          );
        }
      },
      onGet: () => {
        return this.deviceData?.hot_water_boost_active === true;
      },
    });
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

  // Process data for any heatlink devices we have in the raw data
  // We do this using any thermostat data
  let devices = {};
  Object.entries(rawData)
    .filter(
      ([key, value]) =>
        key.startsWith('device.') === true ||
        (key.startsWith('DEVICE_') === true && PROTOBUF_RESOURCES.THERMOSTAT.includes(value.value?.device_info?.typeName) === true),
    )
    .forEach(([object_key, value]) => {
      let tempDevice = {};
      try {
        if (
          value?.source === DATA_SOURCE.GOOGLE &&
          value.value?.configuration_done?.deviceReady === true &&
          typeof rawData?.[value.value?.device_info?.pairerId?.resourceId] === 'object' &&
          ['HEAT_LINK_CONNECTION_TYPE_ON_OFF', 'HEAT_LINK_CONNECTION_TYPE_OPENTHERM'].some(
            (type) =>
              value.value?.heat_link_settings?.heatConnectionType === type ||
              value.value?.heat_link_settings?.hotWaterConnectionType === type,
          ) === true &&
          (value.value?.heat_link?.heatLinkModel?.value?.trim?.() ?? '') !== '' &&
          (value.value?.heat_link?.heatLinkSerialNumber?.value?.trim?.() ?? '') !== '' &&
          (value.value?.heat_link?.heatLinkSwVersion?.value?.trim?.() ?? '') !== ''
        ) {
          tempDevice = processCommonData(
            object_key,
            value.value.device_info.pairerId.resourceId,
            {
              type: DEVICE_TYPE.HEATLINK,
              model:
                value.value.heat_link.heatLinkModel.value.startsWith('Amber-2') === true
                  ? 'Heatlink for Learning Thermostat (3rd gen, EU)'
                  : value.value.heat_link.heatLinkModel.value.startsWith('Amber-1') === true
                    ? 'Heatlink for Learning Thermostat (2nd gen, EU)'
                    : value.value.heat_link.heatLinkModel.value.includes('Agate') === true
                      ? 'Heatlink for Thermostat E (1st gen, EU)'
                      : 'Heatlink (unknown - ' + value.value.heat_link.heatLinkModel + ')',
              serialNumber: value.value.heat_link.heatLinkSerialNumber.value,
              softwareVersion: value.value.heat_link.heatLinkSwVersion.value,
              associated_thermostat: object_key, // Thermostat linked to
              temperature_scale: value.value?.display_settings?.temperatureScale === 'TEMPERATURE_SCALE_F' ? 'F' : 'C',
              online: value.value?.liveness?.status === 'LIVENESS_DEVICE_STATUS_ONLINE', // Use thermostat online status
              has_hot_water_control: value.value?.hvac_equipment_capabilities?.hasHotWaterControl === true,
              hot_water_active: value.value?.hot_water_trait?.boilerActive === true,
              hot_water_boost_active:
                isNaN(value.value?.hot_water_settings?.boostTimerEnd?.seconds) === false &&
                Number(value.value.hot_water_settings.boostTimerEnd.seconds) > 0,
              has_hot_water_temperature: value.value?.hvac_equipment_capabilities?.hasHotWaterTemperature === true,
              current_water_temperature:
                isNaN(value.value?.hot_water_trait?.temperature?.value) === false
                  ? adjustTemperature(Number(value.value.hot_water_trait.temperature.value), 'C', 'C', true)
                  : 0.0,
              hot_water_temperature:
                isNaN(value.value?.hot_water_settings?.temperature?.value) === false
                  ? adjustTemperature(Number(value.value.hot_water_settings.temperature.value), 'C', 'C', true)
                  : 0.0,
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
            },
            config,
          );
        }

        if (
          value?.source === DATA_SOURCE.NEST &&
          typeof rawData?.['track.' + value.value?.serial_number] === 'object' &&
          typeof rawData?.['link.' + value.value?.serial_number]?.value?.structure === 'string' &&
          typeof rawData?.['shared.' + value.value?.serial_number] === 'object' &&
          typeof rawData?.['where.' + rawData?.['link.' + value.value?.serial_number]?.value?.structure?.split?.('.')[1]] === 'object' &&
          ['onoff', 'opentherm'].some(
            (type) => value?.value?.heat_link_heat_type === type || value?.value?.heat_link_hot_water_type === type,
          ) === true &&
          (value.value?.heat_link_model?.trim?.() ?? '') !== '' &&
          (value.value?.heat_link_serial_number?.trim?.() ?? '') !== '' &&
          (value.value?.heat_link_sw_version?.trim?.() ?? '') !== ''
        ) {
          tempDevice = processCommonData(
            object_key,
            rawData['link.' + value.value.serial_number].value.structure,
            {
              type: DEVICE_TYPE.HEATLINK,
              model:
                value.value.heat_link_model.startsWith('Amber-2') === true
                  ? 'Heatlink for Learning Thermostat (3rd gen, EU)'
                  : value.value.heat_link_model.startsWith('Amber-1') === true
                    ? 'Heatlink for Learning Thermostat (2nd gen, EU)'
                    : value.value.heat_link_model.includes('Agate') === true
                      ? 'Heatlink for Thermostat E (1st gen, EU)'
                      : 'Heatlink (unknown - ' + value.value.heat_link_model + ')',
              serialNumber: value.value.heat_link_serial_number,
              softwareVersion: value.value.heat_link_sw_version,
              associated_thermostat: object_key, // Thermostat linked to
              temperature_scale: value.value.temperature_scale.toUpperCase() === 'F' ? 'F' : 'C',
              online: rawData?.['track.' + value.value.serial_number]?.value?.online === true, // Use thermostat online status
              has_hot_water_control: value.value.has_hot_water_control === true,
              hot_water_active: value.value?.hot_water_active === true,
              hot_water_boost_active:
                isNaN(value.value?.hot_water_boost_time_to_end) === false && Number(value.value.hot_water_boost_time_to_end) > 0,
              has_hot_water_temperature: value.value?.has_hot_water_temperature === true,
              hot_water_temperature:
                isNaN(value.value?.hot_water_temperature) === false
                  ? adjustTemperature(Number(value.value.hot_water_temperature), 'C', 'C', true)
                  : 0.0,
              current_water_temperature:
                isNaN(value.value?.current_water_temperature) === false
                  ? adjustTemperature(Number(value.value.current_water_temperature), 'C', 'C', true)
                  : 0.0,
              description: String(rawData?.['shared.' + value.value.serial_number]?.value?.name ?? ''),
              location: String(
                rawData?.[
                  'where.' + rawData?.['link.' + value.value.serial_number]?.value?.structure?.split?.('.')[1]
                ]?.value?.wheres?.find((where) => where?.where_id === value.value.where_id)?.name ?? '',
              ),
            },
            config,
          );
        }
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        log?.debug?.('Error processing heatlink data for "%s"', object_key);
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
            home?.nest_home_uuid?.toUpperCase?.() === rawData?.['link.' + value?.value?.serial_number]?.value?.structure?.toUpperCase?.() ||
            home?.google_home_uuid?.toUpperCase?.() === value?.value?.device_info?.pairerId?.resourceId?.toUpperCase?.(),
        );

        // Insert any extra options we've read in from configuration file for this device
        tempDevice.eveHistory =
          deviceOptions?.eveHistory !== undefined
            ? deviceOptions.eveHistory === true
            : homeOptions?.eveHistory !== undefined
              ? homeOptions.eveHistory === true
              : config.options?.eveHistory === true;

        // Process hotwater boost time.. we only allow values matching app
        tempDevice.hotwaterBoostTime = parseDurationToSeconds(deviceOptions?.hotwaterBoostTime, {
          defaultValue: 1800, // 30 mins
          min: 1800, // 30 mins
          max: 7200, // 2 hrs
        });

        tempDevice.hotwaterBoostTime = HOTWATER_BOOST_TIMES.reduce((a, b) =>
          Math.abs(tempDevice.hotwaterBoostTime - a) < Math.abs(tempDevice.hotwaterBoostTime - b) ? a : b,
        );

        tempDevice.hotwaterMinTemp =
          isNaN(deviceOptions?.hotwaterMinTemp) === false
            ? adjustTemperature(deviceOptions.hotwaterMinTemp, 'C', 'C', true)
            : typeof deviceOptions?.hotwaterMinTemp === 'string' && /^([0-9.]+)\s*([CF])$/i.test(deviceOptions.hotwaterMinTemp)
              ? adjustTemperature(
                  parseFloat(deviceOptions.hotwaterMinTemp.match(/^([0-9.]+)\s*([CF])$/i)[1]),
                  deviceOptions.hotwaterMinTemp.match(/^([0-9.]+)\s*([CF])$/i)[2],
                  'C',
                  true,
                )
              : HOTWATER_MIN_TEMPERATURE; // 30c minimum

        tempDevice.hotwaterMaxTemp =
          isNaN(deviceOptions?.hotwaterMaxTemp) === false
            ? adjustTemperature(deviceOptions.hotwaterMaxTemp, 'C', 'C', true)
            : typeof deviceOptions?.hotwaterMaxTemp === 'string' && /^([0-9.]+)\s*([CF])$/i.test(deviceOptions.hotwaterMaxTemp)
              ? adjustTemperature(
                  parseFloat(deviceOptions.hotwaterMaxTemp.match(/^([0-9.]+)\s*([CF])$/i)[1]),
                  deviceOptions.hotwaterMaxTemp.match(/^([0-9.]+)\s*([CF])$/i)[2],
                  'C',
                  true,
                )
              : HOTWATER_MAX_TEMPERATURE; // 70c maximum
        devices[tempDevice.serialNumber] = tempDevice; // Store processed device
      }
    });

  return devices;
}
