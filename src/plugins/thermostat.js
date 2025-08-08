// Nest Thermostat
// Part of homebridge-nest-accfactory
//
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import path from 'node:path';
import fs from 'node:fs';

// Define our modules
import HomeKitDevice from '../HomeKitDevice.js';
import { processCommonData, scaleValue, adjustTemperature } from '../utils.js';

// Define constants
import {
  DATA_SOURCE,
  THERMOSTAT_MIN_TEMPERATURE,
  THERMOSTAT_MAX_TEMPERATURE,
  LOW_BATTERY_LEVEL,
  PROTOBUF_RESOURCES,
  DAYS_OF_WEEK_FULL,
  DAYS_OF_WEEK_SHORT,
  __dirname,
  DEVICE_TYPE,
} from '../consts.js';

export default class NestThermostat extends HomeKitDevice {
  static TYPE = 'Thermostat';
  static VERSION = '2025.08.07'; // Code version

  thermostatService = undefined;
  batteryService = undefined;
  occupancyService = undefined;
  humidityService = undefined;
  fanService = undefined; // Fan control
  dehumidifierService = undefined; // dehumidifier (only) control
  externalCool = undefined; // External module function
  externalHeat = undefined; // External module function
  externalFan = undefined; // External module function
  externalDehumidifier = undefined; // External module function

  // Class functions
  async onAdd() {
    // Setup the thermostat service if not already present on the accessory, and link it to the Eve app if configured to do so
    this.thermostatService = this.addHKService(this.hap.Service.Thermostat, '', 1, { messages: this.message.bind(this) });
    this.thermostatService.setPrimaryService();

    // Setup set characteristics

    // Patch to avoid characteristic errors when setting initial property ranges
    this.hap.Characteristic.TargetTemperature.prototype.getDefaultValue = () => {
      return THERMOSTAT_MIN_TEMPERATURE; // start at minimum target temperature
    };
    this.hap.Characteristic.HeatingThresholdTemperature.prototype.getDefaultValue = () => {
      return THERMOSTAT_MIN_TEMPERATURE; // start at minimum heating threshold
    };
    this.hap.Characteristic.CoolingThresholdTemperature.prototype.getDefaultValue = () => {
      return THERMOSTAT_MAX_TEMPERATURE; // start at maximum cooling threshold
    };

    // Used to indicate active temperature if the thermostat is using its temperature sensor data
    // or an external temperature sensor ie: Nest Temperature Sensor
    this.addHKCharacteristic(this.thermostatService, this.hap.Characteristic.StatusActive);

    this.addHKCharacteristic(this.thermostatService, this.hap.Characteristic.StatusFault);

    this.addHKCharacteristic(this.thermostatService, this.hap.Characteristic.LockPhysicalControls, {
      onSet: (value) => {
        this.setChildlock('', value);
      },
      onGet: () => {
        return this.deviceData.temperature_lock === true
          ? this.hap.Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED
          : this.hap.Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED;
      },
    });

    this.addHKCharacteristic(this.thermostatService, this.hap.Characteristic.CurrentRelativeHumidity, {
      onGet: () => {
        return this.deviceData.current_humidity;
      },
    });

    this.addHKCharacteristic(this.thermostatService, this.hap.Characteristic.TemperatureDisplayUnits, {
      onSet: (value) => {
        this.setDisplayUnit(value);
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
        return this.deviceData.current_temperature;
      },
    });

    this.addHKCharacteristic(this.thermostatService, this.hap.Characteristic.TargetTemperature, {
      props: {
        minStep: 0.5,
        minValue: THERMOSTAT_MIN_TEMPERATURE,
        maxValue: THERMOSTAT_MAX_TEMPERATURE,
      },
      onSet: (value) => {
        this.setTemperature(this.hap.Characteristic.TargetTemperature, value);
      },
      onGet: () => {
        return this.getTemperature(this.hap.Characteristic.TargetTemperature);
      },
    });

    this.addHKCharacteristic(this.thermostatService, this.hap.Characteristic.CoolingThresholdTemperature, {
      props: {
        minStep: 0.5,
        minValue: THERMOSTAT_MIN_TEMPERATURE,
        maxValue: THERMOSTAT_MAX_TEMPERATURE,
      },
      onSet: (value) => {
        this.setTemperature(this.hap.Characteristic.CoolingThresholdTemperature, value);
      },
      onGet: () => {
        return this.getTemperature(this.hap.Characteristic.CoolingThresholdTemperature);
      },
    });

    this.addHKCharacteristic(this.thermostatService, this.hap.Characteristic.HeatingThresholdTemperature, {
      props: {
        minStep: 0.5,
        minValue: THERMOSTAT_MIN_TEMPERATURE,
        maxValue: THERMOSTAT_MAX_TEMPERATURE,
      },
      onSet: (value) => {
        this.setTemperature(this.hap.Characteristic.HeatingThresholdTemperature, value);
      },
      onGet: () => {
        return this.getTemperature(this.hap.Characteristic.HeatingThresholdTemperature);
      },
    });

    this.addHKCharacteristic(this.thermostatService, this.hap.Characteristic.TargetHeatingCoolingState, {
      props: {
        validValues:
          this.deviceData?.can_cool === true && this.deviceData?.can_heat === true
            ? [
                this.hap.Characteristic.TargetHeatingCoolingState.OFF,
                this.hap.Characteristic.TargetHeatingCoolingState.HEAT,
                this.hap.Characteristic.TargetHeatingCoolingState.COOL,
                this.hap.Characteristic.TargetHeatingCoolingState.AUTO,
              ]
            : this.deviceData?.can_heat === true
              ? [this.hap.Characteristic.TargetHeatingCoolingState.OFF, this.hap.Characteristic.TargetHeatingCoolingState.HEAT]
              : this.deviceData?.can_cool === true
                ? [this.hap.Characteristic.TargetHeatingCoolingState.OFF, this.hap.Characteristic.TargetHeatingCoolingState.COOL]
                : [this.hap.Characteristic.TargetHeatingCoolingState.OFF],
      },
      onSet: (value) => {
        this.setMode(value);
      },
      onGet: () => {
        return this.getMode();
      },
    });

    if (this.deviceData?.has_air_filter === true) {
      // We have the capability for an air filter, so setup filter change characterisitc
      this.addHKCharacteristic(this.thermostatService, this.hap.Characteristic.FilterChangeIndication);
    }
    if (this.deviceData?.has_air_filter === false) {
      // No longer configured to have an air filter, so remove characteristic from the accessory
      this.thermostatService.removeCharacteristic(this.hap.Characteristic.FilterChangeIndication);
    }

    // Setup occupancy service if not already present on the accessory
    this.occupancyService = this.addHKService(this.hap.Service.OccupancySensor, '', 1);
    this.thermostatService.addLinkedService(this.occupancyService);

    // Setup battery service if not already present on the accessory
    this.batteryService = this.addHKService(this.hap.Service.Battery, '', 1);
    this.batteryService.setHiddenService(true);
    this.thermostatService.addLinkedService(this.batteryService);

    // Setup fan service if supported by the thermostat and not already present on the accessory
    if (this.deviceData?.has_fan === true) {
      this.#setupFan();
    }
    if (this.deviceData?.has_fan === false) {
      // No longer have a Fan configured and service present, so removed it
      this.fanService = this.accessory.getService(this.hap.Service.Fanv2);
      if (this.fanService !== undefined) {
        this.accessory.removeService(this.fanService);
      }
      this.fanService = undefined;
    }

    // Setup dehumifider service if supported by the thermostat and not already present on the accessory
    if (this.deviceData?.has_dehumidifier === true) {
      this.#setupDehumidifier();
    }
    if (this.deviceData?.has_dehumidifier === false) {
      // No longer have a dehumidifier configured and service present, so removed it
      this.dehumidifierService = this.accessory.getService(this.hap.Service.HumidifierDehumidifier);
      if (this.dehumidifierService !== undefined) {
        this.accessory.removeService(this.dehumidifierService);
      }
      this.dehumidifierService = undefined;
    }

    // Setup humdity service if configured to be seperate and not already present on the accessory
    if (this.deviceData?.humiditySensor === true) {
      this.humidityService = this.addHKService(this.hap.Service.HumiditySensor, '', 1);
      this.thermostatService.addLinkedService(this.humidityService);

      this.addHKCharacteristic(this.humidityService, this.hap.Characteristic.CurrentRelativeHumidity, {
        onGet: () => {
          return this.deviceData.current_humidity;
        },
      });
    }
    if (this.deviceData?.humiditySensor === false) {
      // No longer have a seperate humidity sensor configure and service present, so removed it
      this.humidityService = this.accessory.getService(this.hap.Service.HumiditySensor);
      if (this.humidityService !== undefined) {
        this.accessory.removeService(this.humidityService);
      }
      this.humidityService = undefined;
    }

    // Attempt to load any external modules for this thermostat
    // We support external cool/heat/fan/dehumidifier module functions
    // This is all undocumented on how to use, as its for my specific use case :-)
    this.externalCool = await this.#loadExternalModule(this.deviceData?.externalCool, ['cool', 'off']);
    this.externalHeat = await this.#loadExternalModule(this.deviceData?.externalHeat, ['heat', 'off']);
    this.externalFan = await this.#loadExternalModule(this.deviceData?.externalFan, ['fan', 'off']);
    this.externalDehumidifier = await this.#loadExternalModule(this.deviceData?.externalDehumidifier, ['dehumidifier', 'off']);

    // Extra setup details for output
    this.humidityService !== undefined && this.postSetupDetail('Seperate humidity sensor');
    this.externalCool !== undefined && this.postSetupDetail('Using external cooling module');
    this.externalHeat !== undefined && this.postSetupDetail('Using external heating module');
    this.externalFan !== undefined && this.postSetupDetail('Using external fan module');
    this.externalDehumidifier !== undefined && this.postSetupDetail('Using external dehumidification module');
  }

  onRemove() {
    this.accessory.removeService(this.thermostatService);
    this.accessory.removeService(this.batteryService);
    this.accessory.removeService(this.occupancyService);
    this.accessory.removeService(this.humidityService);
    this.accessory.removeService(this.fanService);
    this.accessory.removeService(this.dehumidifierService);
    this.thermostatService = undefined;
    this.batteryService = undefined;
    this.occupancyService = undefined;
    this.humidityService = undefined;
    this.fanService = undefined;
    this.dehumidifierService = undefined;
    this.externalCool = undefined;
    this.externalHeat = undefined;
    this.externalFan = undefined;
    this.externalDehumidifier = undefined;
  }

  onUpdate(deviceData) {
    if (
      typeof deviceData !== 'object' ||
      this.thermostatService === undefined ||
      this.batteryService === undefined ||
      this.occupancyService === undefined
    ) {
      return;
    }

    let historyEntry = {};

    this.thermostatService.updateCharacteristic(
      this.hap.Characteristic.TemperatureDisplayUnits,
      deviceData.temperature_scale.toUpperCase() === 'C'
        ? this.hap.Characteristic.TemperatureDisplayUnits.CELSIUS
        : this.hap.Characteristic.TemperatureDisplayUnits.FAHRENHEIT,
    );

    this.thermostatService.updateCharacteristic(this.hap.Characteristic.CurrentTemperature, deviceData.current_temperature);

    // If thermostat isn't online or removed from base, report in HomeKit
    this.thermostatService.updateCharacteristic(
      this.hap.Characteristic.StatusFault,
      deviceData.online === true && deviceData.removed_from_base === false
        ? this.hap.Characteristic.StatusFault.NO_FAULT
        : this.hap.Characteristic.StatusFault.GENERAL_FAULT,
    );

    this.thermostatService.updateCharacteristic(
      this.hap.Characteristic.LockPhysicalControls,
      deviceData.temperature_lock === true
        ? this.hap.Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED
        : this.hap.Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED,
    );

    // Update air filter status if has been added
    if (this.thermostatService.testCharacteristic(this.hap.Characteristic.FilterChangeIndication) === true) {
      this.thermostatService.updateCharacteristic(
        this.hap.Characteristic.FilterChangeIndication,
        deviceData.has_air_filter && deviceData.filter_replacement_needed === true
          ? this.hap.Characteristic.FilterChangeIndication.CHANGE_FILTER
          : this.hap.Characteristic.FilterChangeIndication.FILTER_OK,
      );
    }

    // Using a temperature sensor as active temperature?
    // Probably not the best way for HomeKit, but works ;-)
    // Maybe a custom characteristic would be better?
    this.thermostatService.updateCharacteristic(this.hap.Characteristic.StatusActive, deviceData.active_rcs_sensor === '');

    // Update battery status
    this.batteryService.updateCharacteristic(this.hap.Characteristic.BatteryLevel, deviceData.battery_level);
    this.batteryService.updateCharacteristic(
      this.hap.Characteristic.StatusLowBattery,
      deviceData.battery_level > LOW_BATTERY_LEVEL
        ? this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
        : this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW,
    );
    this.batteryService.updateCharacteristic(
      this.hap.Characteristic.ChargingState,
      (deviceData.battery_level > this.deviceData.battery_level && this.deviceData.battery_level !== 0 ? true : false)
        ? this.hap.Characteristic.ChargingState.CHARGING
        : this.hap.Characteristic.ChargingState.NOT_CHARGING,
    );

    // Update for away/home status. Away = no occupancy detected, Home = Occupancy Detected
    this.occupancyService.updateCharacteristic(
      this.hap.Characteristic.OccupancyDetected,
      deviceData.occupancy === true
        ? this.hap.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
        : this.hap.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
    );

    // Update seperate humidity sensor if configured todo so
    if (this.humidityService !== undefined) {
      this.humidityService.updateCharacteristic(this.hap.Characteristic.CurrentRelativeHumidity, deviceData.current_humidity);
    }

    // Update humity on thermostat
    this.thermostatService.updateCharacteristic(this.hap.Characteristic.CurrentRelativeHumidity, deviceData.current_humidity);

    // Check for fan setup change on thermostat
    if (deviceData.has_fan !== this.deviceData.has_fan) {
      if (deviceData.has_fan === true && this.deviceData.has_fan === false && this.fanService === undefined) {
        // Fan has been added
        this.#setupFan();
      }
      if (deviceData.has_fan === false && this.deviceData.has_fan === true && this.fanService !== undefined) {
        // Fan has been removed
        this.accessory.removeService(this.fanService);
        this.fanService = undefined;
      }

      this?.log?.info?.(
        'Fan setup on thermostat "%s" has changed. Fan was',
        deviceData.description,
        this.fanService === undefined ? 'removed' : 'added',
      );
    }

    // Check for dehumidifer setup change on thermostat
    if (deviceData.has_dehumidifier !== this.deviceData.has_dehumidifier) {
      if (deviceData.has_dehumidifier === true && this.deviceData.has_dehumidifier === false && this.dehumidifierService === undefined) {
        // Dehumidifier has been added
        this.#setupDehumidifier();
      }
      if (deviceData.has_dehumidifier === false && this.deviceData.has_dehumidifier === true && this.dehumidifierService !== undefined) {
        // Dehumidifer has been removed
        this.accessory.removeService(this.dehumidifierService);
        this.dehumidifierService = undefined;
      }

      this?.log?.info?.(
        'Dehumidifier setup on thermostat "%s" has changed. Dehumidifier was',
        deviceData.description,
        this.dehumidifierService === undefined ? 'removed' : 'added',
      );
    }

    if (deviceData.can_cool !== this.deviceData.can_cool || deviceData.can_heat !== this.deviceData.can_heat) {
      // Heating and/cooling setup has changed on thermostat

      // Limit prop ranges
      if (deviceData.can_cool === false && deviceData.can_heat === true) {
        // Can heat only, so set values allowed for mode off/heat
        this.thermostatService.getCharacteristic(this.hap.Characteristic.TargetHeatingCoolingState).setProps({
          validValues: [this.hap.Characteristic.TargetHeatingCoolingState.OFF, this.hap.Characteristic.TargetHeatingCoolingState.HEAT],
        });
      }
      if (deviceData.can_cool === true && deviceData.can_heat === false) {
        // Can cool only
        this.thermostatService.getCharacteristic(this.hap.Characteristic.TargetHeatingCoolingState).setProps({
          validValues: [this.hap.Characteristic.TargetHeatingCoolingState.OFF, this.hap.Characteristic.TargetHeatingCoolingState.COOL],
        });
      }
      if (deviceData.can_cool === true && deviceData.can_heat === true) {
        // heat and cool
        this.thermostatService.getCharacteristic(this.hap.Characteristic.TargetHeatingCoolingState).setProps({
          validValues: [
            this.hap.Characteristic.TargetHeatingCoolingState.OFF,
            this.hap.Characteristic.TargetHeatingCoolingState.HEAT,
            this.hap.Characteristic.TargetHeatingCoolingState.COOL,
            this.hap.Characteristic.TargetHeatingCoolingState.AUTO,
          ],
        });
      }
      if (deviceData.can_cool === false && deviceData.can_heat === false) {
        // only off mode
        this.thermostatService.getCharacteristic(this.hap.Characteristic.TargetHeatingCoolingState).setProps({
          validValues: [this.hap.Characteristic.TargetHeatingCoolingState.OFF],
        });
      }

      this?.log?.info?.('Heating/cooling setup on thermostat on "%s" has changed', deviceData.description);
    }

    // Update current mode temperatures
    if (
      deviceData.can_heat === true &&
      (deviceData.hvac_mode.toUpperCase() === 'HEAT' || deviceData.hvac_mode.toUpperCase() === 'ECOHEAT')
    ) {
      // heating mode, either eco or normal
      this.thermostatService.updateCharacteristic(this.hap.Characteristic.HeatingThresholdTemperature, deviceData.target_temperature_low);
      this.thermostatService.updateCharacteristic(this.hap.Characteristic.TargetTemperature, deviceData.target_temperature_low);
      this.thermostatService.updateCharacteristic(
        this.hap.Characteristic.TargetHeatingCoolingState,
        this.hap.Characteristic.TargetHeatingCoolingState.HEAT,
      );
      historyEntry.target = { low: 0, high: deviceData.target_temperature_low }; // single target temperature for heating limit
    }
    if (
      deviceData.can_cool === true &&
      (deviceData.hvac_mode.toUpperCase() === 'COOL' || deviceData.hvac_mode.toUpperCase() === 'ECOCOOL')
    ) {
      // cooling mode, either eco or normal
      this.thermostatService.updateCharacteristic(this.hap.Characteristic.CoolingThresholdTemperature, deviceData.target_temperature_high);
      this.thermostatService.updateCharacteristic(this.hap.Characteristic.TargetTemperature, deviceData.target_temperature_high);
      this.thermostatService.updateCharacteristic(
        this.hap.Characteristic.TargetHeatingCoolingState,
        this.hap.Characteristic.TargetHeatingCoolingState.COOL,
      );
      historyEntry.target = { low: deviceData.target_temperature_high, high: 0 }; // single target temperature for cooling limit
    }
    if (
      deviceData.can_cool === true &&
      deviceData.can_heat === true &&
      (deviceData.hvac_mode.toUpperCase() === 'RANGE' || deviceData.hvac_mode.toUpperCase() === 'ECORANGE')
    ) {
      // range mode, either eco or normal
      this.thermostatService.updateCharacteristic(this.hap.Characteristic.HeatingThresholdTemperature, deviceData.target_temperature_low);
      this.thermostatService.updateCharacteristic(this.hap.Characteristic.CoolingThresholdTemperature, deviceData.target_temperature_high);
      this.thermostatService.updateCharacteristic(this.hap.Characteristic.TargetTemperature, deviceData.target_temperature);
      this.thermostatService.updateCharacteristic(
        this.hap.Characteristic.TargetHeatingCoolingState,
        this.hap.Characteristic.TargetHeatingCoolingState.AUTO,
      );
      historyEntry.target = { low: deviceData.target_temperature_low, high: deviceData.target_temperature_high };
    }
    if (deviceData.can_cool === false && deviceData.can_heat === false && deviceData.hvac_mode.toUpperCase() === 'OFF') {
      // off mode
      this.thermostatService.updateCharacteristic(this.hap.Characteristic.TargetTemperature, deviceData.target_temperature);
      this.thermostatService.updateCharacteristic(
        this.hap.Characteristic.TargetHeatingCoolingState,
        this.hap.Characteristic.TargetHeatingCoolingState.OFF,
      );
      historyEntry.target = { low: 0, high: 0 }; // thermostat off, so no target temperatures
    }

    // Update current state
    if (deviceData.hvac_state.toUpperCase() === 'HEATING') {
      if (this.deviceData.hvac_state.toUpperCase() === 'COOLING' && typeof this.externalCool?.off === 'function') {
        // Switched to heating mode and external cooling external code was being used, so stop cooling via cooling external code
        this.externalCool.off();
      }
      if (
        (this.deviceData.hvac_state.toUpperCase() !== 'HEATING' ||
          deviceData.target_temperature_low !== this.deviceData.target_temperature_low) &&
        typeof this.externalHeat?.heat === 'function'
      ) {
        // Switched to heating mode and external heating external code is being used
        // Start heating via heating external code OR adjust heating target temperature due to change
        this.externalHeat.heat(deviceData.target_temperature_low);
      }
      this.thermostatService.updateCharacteristic(
        this.hap.Characteristic.CurrentHeatingCoolingState,
        this.hap.Characteristic.CurrentHeatingCoolingState.HEAT,
      );
      historyEntry.status = 2; // heating
    }
    if (deviceData.hvac_state.toUpperCase() === 'COOLING') {
      if (this.deviceData.hvac_state.toUpperCase() === 'HEATING' && typeof this.externalHeat?.off === 'function') {
        // Switched to cooling mode and external heating external code was being used, so stop heating via heating external code
        this.externalHeat.off();
      }
      if (
        (this.deviceData.hvac_state.toUpperCase() !== 'COOLING' ||
          deviceData.target_temperature_high !== this.deviceData.target_temperature_high) &&
        typeof this.externalCool?.cool === 'function'
      ) {
        // Switched to cooling mode and external cooling external code is being used
        // Start cooling via cooling external code OR adjust cooling target temperature due to change
        this.externalCool.cool(deviceData.target_temperature_high);
      }
      this.thermostatService.updateCharacteristic(
        this.hap.Characteristic.CurrentHeatingCoolingState,
        this.hap.Characteristic.CurrentHeatingCoolingState.COOL,
      );
      historyEntry.status = 1; // cooling
    }
    if (deviceData.hvac_state.toUpperCase() === 'OFF') {
      if (this.deviceData.hvac_state.toUpperCase() === 'COOLING' && typeof this.externalCool?.off === 'function') {
        // Switched to off mode and external cooling external code was being used, so stop cooling via cooling external code{
        this.externalCool.off();
      }
      if (this.deviceData.hvac_state.toUpperCase() === 'HEATING' && typeof this.externalHeat?.off === 'function') {
        // Switched to off mode and external heating external code was being used, so stop heating via heating external code
        this.externalHeat.off();
      }
      this.thermostatService.updateCharacteristic(
        this.hap.Characteristic.CurrentHeatingCoolingState,
        this.hap.Characteristic.CurrentHeatingCoolingState.OFF,
      );
      historyEntry.status = 0; // off
    }

    if (this.fanService !== undefined) {
      // fan status on or off
      if (this.deviceData.fan_state === false && deviceData.fan_state === true && typeof this.externalFan?.fan === 'function') {
        // Fan mode was switched on and external fan external code is being used, so start fan via fan external code
        this.externalFan.fan(0); // Fan speed will be auto
      }
      if (this.deviceData.fan_state === true && deviceData.fan_state === false && typeof this.externalFan?.off === 'function') {
        // Fan mode was switched off and external fan external code was being used, so stop fan via fan external code
        this.externalFan.off();
      }

      this.fanService.updateCharacteristic(
        this.hap.Characteristic.RotationSpeed,
        deviceData.fan_state === true ? (deviceData.fan_timer_speed / deviceData.fan_max_speed) * 100 : 0,
      );

      this.fanService.updateCharacteristic(
        this.hap.Characteristic.Active,
        deviceData.fan_state === true ? this.hap.Characteristic.Active.ACTIVE : this.hap.Characteristic.Active.INACTIVE,
      );

      this.history(this.fanService, {
        status: deviceData.fan_state === true ? 1 : 0,
        temperature: deviceData.current_temperature,
        humidity: deviceData.current_humidity,
      });
    }

    if (this.dehumidifierService !== undefined) {
      // dehumidifier status on or off
      if (
        this.deviceData.dehumidifier_state === false &&
        deviceData.dehumidifier_state === true &&
        typeof this.externalDehumidifier?.dehumidifier === 'function'
      ) {
        // Dehumidifier mode was switched on and external dehumidifier external code is being used
        // Start dehumidifier via dehumidifier external code
        this.externalDehumidifier.dehumidifier(0);
      }
      if (
        this.deviceData.dehumidifier_state === true &&
        deviceData.dehumidifier_state === false &&
        typeof this.externalDehumidifier?.off === 'function'
      ) {
        // Dehumidifier mode was switched off and external dehumidifier external code was being used
        // Stop dehumidifier via dehumidifier external code
        this.externalDehumidifier.off();
      }

      this.dehumidifierService.updateCharacteristic(
        this.hap.Characteristic.Active,
        deviceData.dehumidifier_state === true ? this.hap.Characteristic.Active.ACTIVE : this.hap.Characteristic.Active.INACTIVE,
      );

      this.history(this.dehumidifierService, {
        status: deviceData.dehumidifier_state === true ? 1 : 0,
        temperature: deviceData.current_temperature,
        humidity: deviceData.current_humidity,
      });
    }

    // Log thermostat metrics to history only if changed to previous recording
    this.history(this.thermostatService, {
      status: historyEntry.status,
      temperature: deviceData.current_temperature,
      target: historyEntry.target,
      humidity: deviceData.current_humidity,
    });

    // Update our internal data with properties Eve will need to process then Notify Eve App of device status changes if linked
    this.deviceData.online = deviceData.online;
    this.deviceData.removed_from_base = deviceData.removed_from_base;
    this.deviceData.vacation_mode = deviceData.vacation_mode;
    this.deviceData.hvac_mode = deviceData.hvac_mode;
    this.deviceData.schedules = deviceData.schedules;
    this.deviceData.schedule_mode = deviceData.schedule_mode;
    this.historyService?.updateEveHome?.(this.thermostatService);
  }

  onMessage(type, message) {
    if (typeof type !== 'string' || type === '' || message === null || typeof message !== 'object' || message?.constructor !== Object) {
      return;
    }

    if (type === HomeKitDevice?.EVEHOME?.GET) {
      // Extend Eve Thermo GET payload with device state
      message.enableschedule = this.deviceData.schedule_mode === 'heat';
      message.attached = this.deviceData.online === true && this.deviceData.removed_from_base === false;
      message.vacation = this.deviceData.vacation_mode === true;
      message.programs = [];

      if (['HEAT', 'RANGE'].includes(this.deviceData.schedule_mode?.toUpperCase?.()) === true) {
        Object.entries(this.deviceData.schedules || {}).forEach(([day, entries]) => {
          let tempSchedule = [];
          let tempTemperatures = [];

          Object.values(entries || {}).forEach((schedule) => {
            if (schedule.entry_type === 'setpoint' && ['HEAT', 'RANGE'].includes(schedule.type)) {
              let temp = typeof schedule['temp-min'] === 'number' ? schedule['temp-min'] : schedule.temp;
              tempSchedule.push({ start: schedule.time, duration: 0, temperature: temp });
              tempTemperatures.push(temp);
            }
          });

          tempSchedule.sort((a, b) => a.start - b.start);

          let ecoTemp = tempTemperatures.length === 0 ? 0 : Math.min(...tempTemperatures);
          let comfortTemp = tempTemperatures.length === 0 ? 0 : Math.max(...tempTemperatures);

          let program = {
            id: parseInt(day),
            days: isNaN(day) === false && DAYS_OF_WEEK_SHORT?.[day] !== undefined ? DAYS_OF_WEEK_SHORT[day].toLowerCase() : 'mon',
            schedule: [],
          };

          let lastTime = 86400;
          [...tempSchedule].reverse().forEach((entry) => {
            if (entry.temperature === comfortTemp) {
              program.schedule.push({
                start: entry.start,
                duration: lastTime - entry.start,
                ecotemp: ecoTemp,
                comforttemp: comfortTemp,
              });
            }
            lastTime = entry.start;
          });

          message.programs.push(program);
        });
      }

      return message;
    }

    if (type === HomeKitDevice?.EVEHOME?.SET) {
      if (typeof message?.vacation?.status === 'boolean') {
        this.message(HomeKitDevice.SET, { uuid: this.deviceData.nest_google_uuid, vacation_mode: message.vacation.status });
      }

      if (typeof message?.programs === 'object') {
        // Future: convert to Nest format and apply via .set()
        // this.message(HomeKitDevice.SET, { uuid: ..., days: { ... } });
      }
    }
  }

  setFan(fanState, speed) {
    let currentState = this.fanService.getCharacteristic(this.hap.Characteristic.Active).value;
    let currentSpeed = this.fanService.getCharacteristic(this.hap.Characteristic.RotationSpeed).value;

    if (fanState !== currentState || speed !== currentSpeed) {
      let isActive = fanState === this.hap.Characteristic.Active.ACTIVE;
      let scaledSpeed = Math.round((speed / 100) * this.deviceData.fan_max_speed);

      this.message(HomeKitDevice.SET, {
        uuid: this.deviceData.nest_google_uuid,
        fan_state: isActive,
        fan_timer_speed: scaledSpeed,
      });

      this.fanService.updateCharacteristic(this.hap.Characteristic.Active, fanState);
      this.fanService.updateCharacteristic(this.hap.Characteristic.RotationSpeed, speed);

      this?.log?.info?.(
        'Set fan on thermostat "%s" to "%s"',
        this.deviceData.description,
        isActive ? 'On with fan speed of ' + speed + '%' : 'Off',
      );
    }
  }

  setDehumidifier(dehumidiferState) {
    let isActive = dehumidiferState === this.hap.Characteristic.Active.ACTIVE;

    this.message(HomeKitDevice.SET, {
      uuid: this.deviceData.nest_google_uuid,
      dehumidifier_state: isActive,
    });

    this.dehumidifierService.updateCharacteristic(this.hap.Characteristic.Active, dehumidiferState);

    this?.log?.info?.(
      'Set dehumidifer on thermostat "%s" to "%s"',
      this.deviceData.description,
      isActive ? 'On with target humidity level of ' + this.deviceData.target_humidity + '%' : 'Off',
    );
  }

  setDisplayUnit(temperatureUnit) {
    let unit = temperatureUnit === this.hap.Characteristic.TemperatureDisplayUnits.CELSIUS ? 'C' : 'F';

    this.message(HomeKitDevice.SET, {
      uuid: this.deviceData.nest_google_uuid,
      temperature_scale: unit,
    });

    this.thermostatService.updateCharacteristic(this.hap.Characteristic.TemperatureDisplayUnits, temperatureUnit);

    this?.log?.info?.('Set temperature units on thermostat "%s" to "%s"', this.deviceData.description, unit === 'C' ? '°C' : '°F');
  }

  setMode(thermostatMode) {
    if (thermostatMode !== this.thermostatService.getCharacteristic(this.hap.Characteristic.TargetHeatingCoolingState).value) {
      // Work out based on the HomeKit requested mode, what can the thermostat really switch too
      // We may over-ride the requested HomeKit mode
      if (thermostatMode === this.hap.Characteristic.TargetHeatingCoolingState.HEAT && this.deviceData.can_heat === false) {
        thermostatMode = this.hap.Characteristic.TargetHeatingCoolingState.OFF;
      }
      if (thermostatMode === this.hap.Characteristic.TargetHeatingCoolingState.COOL && this.deviceData.can_cool === false) {
        thermostatMode = this.hap.Characteristic.TargetHeatingCoolingState.OFF;
      }
      if (thermostatMode === this.hap.Characteristic.TargetHeatingCoolingState.AUTO) {
        // Workaround for 'Hey Siri, turn on my thermostat'
        // Appears to automatically request mode as 'auto', but we need to see what Nest device supports
        if (this.deviceData.can_cool === true && this.deviceData.can_heat === false) {
          thermostatMode = this.hap.Characteristic.TargetHeatingCoolingState.COOL;
        }
        if (this.deviceData.can_cool === false && this.deviceData.can_heat === true) {
          thermostatMode = this.hap.Characteristic.TargetHeatingCoolingState.HEAT;
        }
        if (this.deviceData.can_cool === false && this.deviceData.can_heat === false) {
          thermostatMode = this.hap.Characteristic.TargetHeatingCoolingState.OFF;
        }
      }

      let mode = '';
      if (thermostatMode === this.hap.Characteristic.TargetHeatingCoolingState.OFF) {
        this.thermostatService.updateCharacteristic(this.hap.Characteristic.TargetTemperature, this.deviceData.target_temperature);
        this.thermostatService.updateCharacteristic(
          this.hap.Characteristic.TargetHeatingCoolingState,
          this.hap.Characteristic.TargetHeatingCoolingState.OFF,
        );
        mode = 'off';
      }
      if (thermostatMode === this.hap.Characteristic.TargetHeatingCoolingState.COOL) {
        this.thermostatService.updateCharacteristic(this.hap.Characteristic.TargetTemperature, this.deviceData.target_temperature_high);
        this.thermostatService.updateCharacteristic(
          this.hap.Characteristic.TargetHeatingCoolingState,
          this.hap.Characteristic.TargetHeatingCoolingState.COOL,
        );
        mode = 'cool';
      }
      if (thermostatMode === this.hap.Characteristic.TargetHeatingCoolingState.HEAT) {
        this.thermostatService.updateCharacteristic(this.hap.Characteristic.TargetTemperature, this.deviceData.target_temperature_low);
        this.thermostatService.updateCharacteristic(
          this.hap.Characteristic.TargetHeatingCoolingState,
          this.hap.Characteristic.TargetHeatingCoolingState.HEAT,
        );
        mode = 'heat';
      }
      if (thermostatMode === this.hap.Characteristic.TargetHeatingCoolingState.AUTO) {
        this.thermostatService.updateCharacteristic(
          this.hap.Characteristic.TargetTemperature,
          (this.deviceData.target_temperature_low + this.deviceData.target_temperature_high) * 0.5,
        );
        this.thermostatService.updateCharacteristic(
          this.hap.Characteristic.TargetHeatingCoolingState,
          this.hap.Characteristic.TargetHeatingCoolingState.AUTO,
        );
        mode = 'range';
      }

      this.message(HomeKitDevice.SET, { uuid: this.deviceData.nest_google_uuid, hvac_mode: mode });

      this?.log?.info?.('Set mode on "%s" to "%s"', this.deviceData.description, mode);
    }
  }

  getMode() {
    let currentMode = null;
    let mode = this.deviceData.hvac_mode.toUpperCase();

    if (mode === 'HEAT' || mode === 'ECOHEAT') {
      // heating mode, either eco or normal
      currentMode = this.hap.Characteristic.TargetHeatingCoolingState.HEAT;
    }
    if (mode === 'COOL' || mode === 'ECOCOOL') {
      // cooling mode, either eco or normal
      currentMode = this.hap.Characteristic.TargetHeatingCoolingState.COOL;
    }
    if (mode === 'RANGE' || mode === 'ECORANGE') {
      // range mode, either eco or normal
      currentMode = this.hap.Characteristic.TargetHeatingCoolingState.AUTO;
    }
    if (mode === 'OFF' || (this.deviceData.can_cool === false && this.deviceData.can_heat === false)) {
      // off mode or no heating or cooling capability
      currentMode = this.hap.Characteristic.TargetHeatingCoolingState.OFF;
    }

    return currentMode;
  }

  setTemperature(characteristic, temperature) {
    if (typeof characteristic !== 'function' || typeof characteristic?.UUID !== 'string') {
      return;
    }

    let mode = this.thermostatService.getCharacteristic(this.hap.Characteristic.TargetHeatingCoolingState).value;
    let isEco = this.deviceData.hvac_mode?.toUpperCase?.().includes('ECO') === true;
    let scale = this.deviceData.temperature_scale?.toUpperCase?.() === 'F' ? 'F' : 'C';
    let tempDisplay = (scale === 'F' ? (temperature * 9) / 5 + 32 : temperature).toFixed(1);
    let tempUnit = scale === 'F' ? '°F' : '°C';
    let ecoPrefix = isEco ? 'eco mode ' : '';

    let targetKey = undefined;
    let modeLabel = '';

    if (
      characteristic.UUID === this.hap.Characteristic.TargetTemperature.UUID &&
      mode !== this.hap.Characteristic.TargetHeatingCoolingState.AUTO
    ) {
      targetKey = 'target_temperature';
      modeLabel = mode === this.hap.Characteristic.TargetHeatingCoolingState.HEAT ? 'heating' : 'cooling';
    } else if (
      characteristic.UUID === this.hap.Characteristic.HeatingThresholdTemperature.UUID &&
      mode === this.hap.Characteristic.TargetHeatingCoolingState.AUTO
    ) {
      targetKey = 'target_temperature_low';
      modeLabel = 'heating';
    } else if (
      characteristic.UUID === this.hap.Characteristic.CoolingThresholdTemperature.UUID &&
      mode === this.hap.Characteristic.TargetHeatingCoolingState.AUTO
    ) {
      targetKey = 'target_temperature_high';
      modeLabel = 'cooling';
    }

    if (targetKey !== undefined) {
      this.message(HomeKitDevice.SET, { uuid: this.deviceData.nest_google_uuid, [targetKey]: temperature });
      this?.log?.info?.(
        'Set %s%s temperature on "%s" to "%s %s"',
        ecoPrefix,
        modeLabel,
        this.deviceData.description,
        tempDisplay,
        tempUnit,
      );
    }

    this.thermostatService.updateCharacteristic(characteristic, temperature);
  }

  getTemperature(characteristic) {
    if (typeof characteristic !== 'function' || typeof characteristic?.UUID !== 'string') {
      return null;
    }

    let currentTemperature = {
      [this.hap.Characteristic.TargetTemperature.UUID]: this.deviceData.target_temperature,
      [this.hap.Characteristic.HeatingThresholdTemperature.UUID]: this.deviceData.target_temperature_low,
      [this.hap.Characteristic.CoolingThresholdTemperature.UUID]: this.deviceData.target_temperature_high,
    }[characteristic.UUID];

    if (isNaN(currentTemperature) === false) {
      currentTemperature = Math.min(Math.max(currentTemperature, THERMOSTAT_MIN_TEMPERATURE), THERMOSTAT_MAX_TEMPERATURE);
    }

    return currentTemperature;
  }

  setChildlock(pin, value) {
    // TODO - pincode setting when turning on.
    // On REST API, writes to device.xxxxxxxx.temperature_lock_pin_hash. How is the hash calculated???
    // Do we set temperature range limits when child lock on??

    this.thermostatService.updateCharacteristic(this.hap.Characteristic.LockPhysicalControls, value); // Update HomeKit with value
    if (value === this.hap.Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED) {
      // Set pin hash????
    }
    if (value === this.hap.Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED) {
      // Clear pin hash????
    }
    this.message(HomeKitDevice.SET, {
      uuid: this.deviceData.nest_google_uuid,
      temperature_lock: value === this.hap.Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED ? true : false,
    });

    this?.log?.info?.(
      'Setting Childlock on "%s" to "%s"',
      this.deviceData.description,
      value === this.hap.Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED ? 'Enabled' : 'Disabled',
    );
  }

  #setupFan() {
    this.fanService = this.addHKService(this.hap.Service.Fanv2, '', 1);
    this.addHKCharacteristic(this.hap.Service.Fanv2, this.hap.Characteristic.RotationSpeed);
    this.thermostatService.addLinkedService(this.fanService);

    this.addHKCharacteristic(this.thermostatService, this.hap.Characteristic.Active, {
      onSet: (value) =>
        this.setFan(
          value,
          value === this.hap.Characteristic.Active.ACTIVE ? (this.deviceData.fan_timer_speed / this.deviceData.fan_max_speed) * 100 : 0,
        ),
      onGet: () => {
        return this.deviceData.fan_state === true ? this.hap.Characteristic.Active.ACTIVE : this.hap.Characteristic.Active.INACTIVE;
      },
    });

    this.addHKCharacteristic(this.thermostatService, this.hap.Characteristic.RotationSpeed, {
      props: { minStep: 100 / this.deviceData.fan_max_speed },
      onSet: (value) => this.setFan(value !== 0 ? this.hap.Characteristic.Active.ACTIVE : this.hap.Characteristic.Active.INACTIVE, value),
      onGet: () => {
        return (this.deviceData.fan_timer_speed / this.deviceData.fan_max_speed) * 100;
      },
    });
  }

  #setupDehumidifier() {
    this.dehumidifierService = this.addHKService(this.hap.Service.HumidifierDehumidifier, '', 1);
    this.thermostatService.addLinkedService(this.dehumidifierService);

    this.addHKCharacteristic(this.dehumidifierService, this.hap.Characteristic.TargetHumidifierDehumidifierState, {
      props: { validValues: [this.hap.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER] },
    });

    this.addHKCharacteristic(this.dehumidifierService, this.hap.Characteristic.Active, {
      onSet: (value) => this.setDehumidifier(value),
      onGet: () => {
        return this.deviceData.dehumidifier_state === true
          ? this.hap.Characteristic.Active.ACTIVE
          : this.hap.Characteristic.Active.INACTIVE;
      },
    });
  }

  async #loadExternalModule(module, expectedFunctions = []) {
    if (typeof module !== 'string' || module === '' || Array.isArray(expectedFunctions) === false) {
      return undefined;
    }

    // Helper to resolve a module path, defaulting to plugin dir and falling back from .mjs to .js
    const resolveModulePath = async (basePath) => {
      let hasExtension = path.extname(basePath) !== '';
      let isRelative = basePath.startsWith('./') || basePath.startsWith('../');
      let isAbsolute = path.isAbsolute(basePath);
      let resolvedBase = isAbsolute ? basePath : isRelative ? path.resolve(basePath) : path.resolve(__dirname, basePath);
      let finalPath = resolvedBase;

      if (hasExtension === false) {
        let mjsPath = `${resolvedBase}.mjs`;
        let jsPath = `${resolvedBase}.js`;

        try {
          await fs.access(mjsPath);
          finalPath = mjsPath;
        } catch {
          try {
            await fs.access(jsPath);
            finalPath = jsPath;
          } catch {
            finalPath = mjsPath; // fallback to mjs even if not found
          }
        }
      }
      return finalPath;
    };

    let loadedModule = undefined;

    try {
      let values = module.match(/'[^']*'|[^\s]+/g)?.map((v) => v.replace(/^'(.*)'$/, '$1')) || [];
      let script = await resolveModulePath(values[0]);
      let options = values.slice(1);
      let externalModule = await import(script);

      if (typeof externalModule?.default === 'function') {
        let moduleExports = externalModule.default(this.log, options);
        let valid = Object.fromEntries(
          expectedFunctions.filter((fn) => typeof moduleExports[fn] === 'function').map((fn) => [fn, moduleExports[fn]]),
        );
        loadedModule = Object.keys(valid).length > 0 ? valid : undefined;
      }
      // eslint-disable-next-line no-unused-vars
    } catch (error) {
      let shortName =
        typeof module === 'string'
          ? module
              .trim()
              .match(/'[^']*'|[^\s]+/)?.[0]
              ?.replace(/^'(.*)'$/, '$1')
          : '';
      this?.log?.warn?.('Failed to load external module "%s" for thermostat "%s"', shortName, this.deviceData.description);
    }

    return loadedModule;
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

  const process_thermostat_data = (object_key, data) => {
    let processed = {};
    try {
      // Fix up data we need to

      // If we have hot water control, it should be a 'UK/EU' model, so add that after the 'gen' tag in the model name
      data.model = data.has_hot_water_control === true ? data.model.replace(/\bgen\)/, 'gen, EU)') : data.model;

      data = processCommonData(object_key, data, config);
      data.target_temperature_high = adjustTemperature(data.target_temperature_high, 'C', 'C', true);
      data.target_temperature_low = adjustTemperature(data.target_temperature_low, 'C', 'C', true);
      data.target_temperature = adjustTemperature(data.target_temperature, 'C', 'C', true);
      data.backplate_temperature = adjustTemperature(data.backplate_temperature, 'C', 'C', true);
      data.current_temperature = adjustTemperature(data.current_temperature, 'C', 'C', true);
      data.battery_level = scaleValue(data.battery_level, 3.6, 3.9, 0, 100);

      processed = data;
      // eslint-disable-next-line no-unused-vars
    } catch (error) {
      // Empty
    }
    return processed;
  };

  // Process data for any thermostat(s) we have in the raw data
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
          rawData?.[value.value?.device_info?.pairerId?.resourceId] !== undefined
        ) {
          let RESTTypeData = {};
          RESTTypeData.type = DEVICE_TYPE.THERMOSTAT;
          RESTTypeData.model = 'Thermostat (unknown)';
          if (value.value.device_info.typeName === 'nest.resource.NestLearningThermostat1Resource') {
            RESTTypeData.model = 'Learning Thermostat (1st gen)';
          }
          if (
            value.value.device_info.typeName === 'nest.resource.NestLearningThermostat2Resource' ||
            value.value.device_info.typeName === 'nest.resource.NestAmber1DisplayResource'
          ) {
            RESTTypeData.model = 'Learning Thermostat (2nd gen)';
          }
          if (
            value.value.device_info.typeName === 'nest.resource.NestLearningThermostat3Resource' ||
            value.value.device_info.typeName === 'nest.resource.NestAmber2DisplayResource'
          ) {
            RESTTypeData.model = 'Learning Thermostat (3rd gen)';
          }
          if (value.value.device_info.typeName === 'google.resource.GoogleBismuth1Resource') {
            RESTTypeData.model = 'Learning Thermostat (4th gen)';
          }
          if (
            value.value.device_info.typeName === 'nest.resource.NestOnyxResource' ||
            value.value.device_info.typeName === 'nest.resource.NestAgateDisplayResource'
          ) {
            RESTTypeData.model = 'Thermostat E (1st gen)';
          }
          if (value.value.device_info.typeName === 'google.resource.GoogleZirconium1Resource') {
            RESTTypeData.model = 'Thermostat (2020)';
          }
          RESTTypeData.softwareVersion = value.value.device_identity.softwareVersion;
          RESTTypeData.serialNumber = value.value.device_identity.serialNumber;
          RESTTypeData.description = String(value.value?.label?.label ?? '');
          RESTTypeData.location = String(
            [
              ...Object.values(
                rawData?.[value.value?.device_info?.pairerId?.resourceId]?.value?.located_annotations?.predefinedWheres || {},
              ),
              ...Object.values(rawData?.[value.value?.device_info?.pairerId?.resourceId]?.value?.located_annotations?.customWheres || {}),
            ].find((where) => where?.whereId?.resourceId === value.value?.device_located_settings?.whereAnnotationRid?.resourceId)?.label
              ?.literal ?? '',
          );
          RESTTypeData.current_humidity =
            isNaN(value.value?.current_humidity?.humidityValue?.humidity?.value) === false
              ? Number(value.value.current_humidity.humidityValue.humidity.value)
              : 0.0;
          RESTTypeData.temperature_scale = value.value?.display_settings?.temperatureScale === 'TEMPERATURE_SCALE_F' ? 'F' : 'C';
          RESTTypeData.removed_from_base =
            Array.isArray(value.value?.display?.thermostatState) === true && value.value.display.thermostatState.includes('bpd') === true;
          RESTTypeData.backplate_temperature = parseFloat(value.value.backplate_temperature.temperatureValue.temperature.value);
          RESTTypeData.current_temperature = parseFloat(value.value.current_temperature.temperatureValue.temperature.value);
          RESTTypeData.battery_level = parseFloat(value.value.battery_voltage.batteryValue.batteryVoltage.value);
          RESTTypeData.online = value.value?.liveness?.status === 'LIVENESS_DEVICE_STATUS_ONLINE';
          RESTTypeData.leaf = value.value?.leaf?.active === true;
          RESTTypeData.can_cool =
            value.value?.hvac_equipment_capabilities?.hasStage1Cool === true ||
            value.value?.hvac_equipment_capabilities?.hasStage2Cool === true ||
            value.value?.hvac_equipment_capabilities?.hasStage3Cool === true;
          RESTTypeData.can_heat =
            value.value?.hvac_equipment_capabilities?.hasStage1Heat === true ||
            value.value?.hvac_equipment_capabilities?.hasStage2Heat === true ||
            value.value?.hvac_equipment_capabilities?.hasStage3Heat === true;
          RESTTypeData.temperature_lock = value.value?.temperature_lock_settings?.enabled === true;
          RESTTypeData.temperature_lock_pin_hash =
            value.value?.temperature_lock_settings?.enabled === true ? value.value.temperature_lock_settings.pinHash : '';
          RESTTypeData.away = value.value?.structure_mode?.structureMode === 'STRUCTURE_MODE_AWAY';
          RESTTypeData.occupancy = value.value?.structure_mode?.structureMode === 'STRUCTURE_MODE_HOME';
          //RESTTypeData.occupancy = (value.value.structure_mode.occupancy.activity === 'ACTIVITY_ACTIVE');
          RESTTypeData.vacation_mode = value.value?.structure_mode?.structureMode === 'STRUCTURE_MODE_VACATION';

          // Work out current mode. ie: off, cool, heat, range and get temperature low/high and target
          RESTTypeData.hvac_mode =
            value.value?.target_temperature_settings?.enabled?.value === true &&
            value.value?.target_temperature_settings?.targetTemperature?.setpointType !== undefined
              ? value.value.target_temperature_settings.targetTemperature.setpointType.split('SET_POINT_TYPE_')[1].toLowerCase()
              : 'off';
          RESTTypeData.target_temperature_low =
            isNaN(value.value?.target_temperature_settings?.targetTemperature?.heatingTarget?.value) === false
              ? Number(value.value.target_temperature_settings.targetTemperature.heatingTarget.value)
              : 0.0;
          RESTTypeData.target_temperature_high =
            isNaN(value.value?.target_temperature_settings?.targetTemperature?.coolingTarget?.value) === false
              ? Number(value.value.target_temperature_settings.targetTemperature.coolingTarget.value)
              : 0.0;
          RESTTypeData.target_temperature =
            value.value?.target_temperature_settings?.targetTemperature?.setpointType === 'SET_POINT_TYPE_COOL' &&
            isNaN(value.value?.target_temperature_settings?.targetTemperature?.coolingTarget?.value) === false
              ? Number(value.value.target_temperature_settings.targetTemperature.coolingTarget.value)
              : value.value?.target_temperature_settings?.targetTemperature?.setpointType === 'SET_POINT_TYPE_HEAT' &&
                  isNaN(value.value?.target_temperature_settings?.targetTemperature?.heatingTarget?.value) === false
                ? Number(value.value.target_temperature_settings.targetTemperature.heatingTarget.value)
                : value.value?.target_temperature_settings?.targetTemperature?.setpointType === 'SET_POINT_TYPE_RANGE' &&
                    isNaN(value.value?.target_temperature_settings?.targetTemperature?.coolingTarget?.value) === false &&
                    isNaN(value.value?.target_temperature_settings?.targetTemperature?.heatingTarget?.value) === false
                  ? (Number(value.value.target_temperature_settings.targetTemperature.coolingTarget.value) +
                      Number(value.value.target_temperature_settings.targetTemperature.heatingTarget.value)) *
                    0.5
                  : 0.0;

          // Work out if eco mode is active and adjust temperature low/high and target
          if (value.value?.eco_mode_state?.ecoMode !== 'ECO_MODE_INACTIVE') {
            RESTTypeData.target_temperature_low = value.value.eco_mode_settings.ecoTemperatureHeat.value.value;
            RESTTypeData.target_temperature_high = value.value.eco_mode_settings.ecoTemperatureCool.value.value;
            if (
              value.value.eco_mode_settings.ecoTemperatureHeat.enabled === true &&
              value.value.eco_mode_settings.ecoTemperatureCool.enabled === false
            ) {
              RESTTypeData.target_temperature = value.value.eco_mode_settings.ecoTemperatureHeat.value.value;
              RESTTypeData.hvac_mode = 'ecoheat';
            }
            if (
              value.value.eco_mode_settings.ecoTemperatureHeat.enabled === false &&
              value.value.eco_mode_settings.ecoTemperatureCool.enabled === true
            ) {
              RESTTypeData.target_temperature = value.value.eco_mode_settings.ecoTemperatureCool.value.value;
              RESTTypeData.hvac_mode = 'ecocool';
            }
            if (
              value.value.eco_mode_settings.ecoTemperatureHeat.enabled === true &&
              value.value.eco_mode_settings.ecoTemperatureCool.enabled === true
            ) {
              RESTTypeData.target_temperature =
                (value.value.eco_mode_settings.ecoTemperatureCool.value.value +
                  value.value.eco_mode_settings.ecoTemperatureHeat.value.value) *
                0.5;
              RESTTypeData.hvac_mode = 'ecorange';
            }
          }

          // Work out current state ie: heating, cooling etc
          RESTTypeData.hvac_state = 'off'; // By default, we're not heating or cooling
          if (
            value.value?.hvac_control?.hvacState?.coolStage1Active === true ||
            value.value?.hvac_control?.hvacState?.coolStage2Active === true ||
            value.value?.hvac_control?.hvacState?.coolStage2Active === true
          ) {
            // A cooling source is on, so we're in cooling mode
            RESTTypeData.hvac_state = 'cooling';
          }
          if (
            value.value?.hvac_control?.hvacState?.heatStage1Active === true ||
            value.value?.hvac_control?.hvacState?.heatStage2Active === true ||
            value.value?.hvac_control?.hvacState?.heatStage3Active === true ||
            value.value?.hvac_control?.hvacState?.alternateHeatStage1Active === true ||
            value.value?.hvac_control?.hvacState?.alternateHeatStage2Active === true ||
            value.value?.hvac_control?.hvacState?.auxiliaryHeatActive === true ||
            value.value?.hvac_control?.hvacState?.emergencyHeatActive === true
          ) {
            // A heating source is on, so we're in heating mode
            RESTTypeData.hvac_state = 'heating';
          }

          // Fan details, on or off and max number of speeds supported
          RESTTypeData.has_fan =
            typeof value.value?.fan_control_capabilities?.maxAvailableSpeed === 'string' &&
            value.value.fan_control_capabilities.maxAvailableSpeed !== 'FAN_SPEED_SETTING_OFF';
          RESTTypeData.fan_state =
            isNaN(value.value?.fan_control_settings?.timerEnd?.seconds) === false &&
            Number(value.value.fan_control_settings.timerEnd.seconds) > 0;
          RESTTypeData.fan_timer_speed =
            value.value?.fan_control_settings?.timerSpeed?.includes?.('FAN_SPEED_SETTING_STAGE') === true &&
            isNaN(value.value.fan_control_settings.timerSpeed.split('FAN_SPEED_SETTING_STAGE')[1]) === false
              ? Number(value.value.fan_control_settings.timerSpeed.split('FAN_SPEED_SETTING_STAGE')[1])
              : 0;
          RESTTypeData.fan_max_speed =
            value.value?.fan_control_capabilities?.maxAvailableSpeed?.includes?.('FAN_SPEED_SETTING_STAGE') === true &&
            isNaN(value.value.fan_control_capabilities.maxAvailableSpeed.split('FAN_SPEED_SETTING_STAGE')[1]) === false
              ? Number(value.value.fan_control_capabilities.maxAvailableSpeed.split('FAN_SPEED_SETTING_STAGE')[1])
              : 0;

          // Humidifier/dehumidifier details
          RESTTypeData.has_humidifier = value.value?.hvac_equipment_capabilities?.hasHumidifier === true;
          RESTTypeData.has_dehumidifier = value.value?.hvac_equipment_capabilities?.hasDehumidifier === true;
          RESTTypeData.target_humidity =
            isNaN(value.value?.humidity_control_settings?.targetHumidity?.value) === false
              ? Number(value.value.humidity_control_settings.targetHumidity.value)
              : 0.0;
          RESTTypeData.humidifier_state = value.value?.hvac_control?.hvacState?.humidifierActive === true;
          RESTTypeData.dehumidifier_state = value.value?.hvac_control?.hvacState?.dehumidifierActive === true;

          // Air filter details
          RESTTypeData.has_air_filter = value.value?.hvac_equipment_capabilities?.hasAirFilter === true;
          RESTTypeData.filter_replacement_needed = value.value?.filter_reminder?.filterReplacementNeeded?.value === true;

          // Process any temperature sensors associated with this thermostat
          RESTTypeData.active_rcs_sensor =
            value.value?.remote_comfort_sensing_settings?.activeRcsSelection?.activeRcsSensor !== undefined
              ? value.value.remote_comfort_sensing_settings.activeRcsSelection.activeRcsSensor.resourceId
              : '';
          RESTTypeData.linked_rcs_sensors = [];
          if (Array.isArray(value.value?.remote_comfort_sensing_settings?.associatedRcsSensors) === true) {
            value.value.remote_comfort_sensing_settings.associatedRcsSensors.forEach((sensor) => {
              if (typeof rawData?.[sensor?.deviceId?.resourceId]?.value === 'object') {
                rawData[sensor.deviceId.resourceId].value.associated_thermostat = object_key; // Sensor is linked to this thermostat
              }

              RESTTypeData.linked_rcs_sensors.push(sensor.deviceId.resourceId);
            });
          }

          RESTTypeData.schedule_mode =
            typeof value.value?.target_temperature_settings?.targetTemperature?.setpointType === 'string' &&
            value.value.target_temperature_settings.targetTemperature.setpointType.split('SET_POINT_TYPE_')[1].toLowerCase() !== 'off'
              ? value.value.target_temperature_settings.targetTemperature.setpointType.split('SET_POINT_TYPE_')[1].toLowerCase()
              : '';
          RESTTypeData.schedules = {};
          if (
            value.value[RESTTypeData.schedule_mode + '_schedule_settings']?.setpoints !== undefined &&
            value.value[RESTTypeData.schedule_mode + '_schedule_settings']?.type ===
              'SET_POINT_SCHEDULE_TYPE_' + RESTTypeData.schedule_mode.toUpperCase()
          ) {
            Object.values(value.value[RESTTypeData.schedule_mode + '_schedule_settings'].setpoints).forEach((schedule) => {
              // Create Nest API schedule entries
              if (schedule?.dayOfWeek !== undefined) {
                let dayofWeekIndex = DAYS_OF_WEEK_FULL.indexOf(schedule.dayOfWeek.split('DAY_OF_WEEK_')[1]);

                if (RESTTypeData.schedules?.[dayofWeekIndex] === undefined) {
                  RESTTypeData.schedules[dayofWeekIndex] = {};
                }

                RESTTypeData.schedules[dayofWeekIndex][Object.entries(RESTTypeData.schedules[dayofWeekIndex]).length] = {
                  'temp-min': adjustTemperature(schedule.heatingTarget.value, 'C', 'C', true),
                  'temp-max': adjustTemperature(schedule.coolingTarget.value, 'C', 'C', true),
                  time: isNaN(schedule?.secondsInDay) === false ? Number(schedule.secondsInDay) : 0,
                  type: RESTTypeData.schedule_mode.toUpperCase(),
                  entry_type: 'setpoint',
                };
              }
            });
          }

          tempDevice = process_thermostat_data(object_key, RESTTypeData);
        }

        if (
          value?.source === DATA_SOURCE.NEST &&
          rawData?.['track.' + value.value?.serial_number] !== undefined &&
          rawData?.['link.' + value.value?.serial_number] !== undefined &&
          rawData?.['shared.' + value.value?.serial_number] !== undefined &&
          rawData?.['where.' + rawData?.['link.' + value.value?.serial_number]?.value?.structure?.split?.('.')[1]] !== undefined
        ) {
          let RESTTypeData = {};
          RESTTypeData.type = DEVICE_TYPE.THERMOSTAT;
          RESTTypeData.model = 'Thermostat (unknown)';
          if (value.value.serial_number.substring(0, 2) === '15') {
            RESTTypeData.model = 'Thermostat E (1st gen)'; // Nest Thermostat E
          }
          if (value.value.serial_number.substring(0, 2) === '09' || value.value.serial_number.substring(0, 2) === '10') {
            RESTTypeData.model = 'Learning Thermostat (3rd gen)'; // Nest Thermostat 3rd gen
          }
          if (value.value.serial_number.substring(0, 2) === '02') {
            RESTTypeData.model = 'Learning Thermostat (2nd gen)'; // Nest Thermostat 2nd gen
          }
          if (value.value.serial_number.substring(0, 2) === '01') {
            RESTTypeData.model = 'Learning Thermostat (1st gen)'; // Nest Thermostat 1st gen
          }
          RESTTypeData.softwareVersion = value.value.current_version;
          RESTTypeData.serialNumber = value.value.serial_number;
          RESTTypeData.description = String(rawData?.['shared.' + value.value.serial_number]?.value?.name ?? '');
          RESTTypeData.location = String(
            rawData?.['where.' + rawData?.['link.' + value.value.serial_number]?.value?.structure?.split?.('.')[1]]?.value?.wheres?.find(
              (where) => where?.where_id === value.value.where_id,
            )?.name ?? '',
          );
          RESTTypeData.current_humidity = value.value.current_humidity;
          RESTTypeData.temperature_scale = value.value.temperature_scale.toUpperCase() === 'F' ? 'F' : 'C';
          RESTTypeData.removed_from_base = value.value.nlclient_state.toUpperCase() === 'BPD';
          RESTTypeData.backplate_temperature = value.value.backplate_temperature;
          RESTTypeData.current_temperature = value.value.backplate_temperature;
          RESTTypeData.battery_level = value.value.battery_level;
          RESTTypeData.online = rawData?.['track.' + value.value.serial_number]?.value?.online === true;
          RESTTypeData.leaf = value.value.leaf === true;
          RESTTypeData.has_humidifier = value.value.has_humidifier === true;
          RESTTypeData.has_dehumidifier = value.value.has_dehumidifier === true;
          RESTTypeData.has_fan = value.value.has_fan === true;
          RESTTypeData.can_cool = rawData?.['shared.' + value.value.serial_number]?.value?.can_cool === true;
          RESTTypeData.can_heat = rawData?.['shared.' + value.value.serial_number]?.value?.can_heat === true;
          RESTTypeData.temperature_lock = value.value.temperature_lock === true;
          RESTTypeData.temperature_lock_pin_hash = value.value.temperature_lock_pin_hash;
          RESTTypeData.away = rawData?.[rawData?.['link.' + value.value.serial_number]?.value?.structure]?.value?.away === true;
          RESTTypeData.occupancy = RESTTypeData.away === false; // Occupancy is opposite of away status ie: away is false, then occupied
          RESTTypeData.vacation_mode =
            rawData[rawData?.['link.' + value.value.serial_number]?.value?.structure]?.value?.vacation_mode === true;

          // Work out current mode. ie: off, cool, heat, range and get temperature low (heat) and high (cool)
          RESTTypeData.hvac_mode =
            rawData?.['shared.' + value.value.serial_number]?.value?.target_temperature_type !== undefined
              ? rawData?.['shared.' + value.value.serial_number].value.target_temperature_type
              : 'off';
          RESTTypeData.target_temperature =
            isNaN(rawData?.['shared.' + value.value.serial_number]?.value?.target_temperature) === false
              ? Number(rawData['shared.' + value.value.serial_number].value.target_temperature)
              : 0.0;
          RESTTypeData.target_temperature_low =
            isNaN(rawData?.['shared.' + value.value.serial_number]?.value?.target_temperature_low) === false
              ? Number(rawData['shared.' + value.value.serial_number].value.target_temperature_low)
              : 0.0;
          RESTTypeData.target_temperature_high =
            isNaN(rawData?.['shared.' + value.value.serial_number]?.value?.target_temperature_high) === false
              ? Number(rawData['shared.' + value.value.serial_number].value.target_temperature_high)
              : 0.0;
          if (rawData?.['shared.' + value.value.serial_number]?.value?.target_temperature_type.toUpperCase() === 'COOL') {
            // Target temperature is the cooling point
            RESTTypeData.target_temperature =
              isNaN(rawData?.['shared.' + value.value.serial_number]?.value?.target_temperature_high) === false
                ? Number(rawData['shared.' + value.value.serial_number].value.target_temperature_high)
                : 0.0;
          }
          if (rawData?.['shared.' + value.value.serial_number]?.value?.target_temperature_type.toUpperCase() === 'HEAT') {
            // Target temperature is the heating point
            RESTTypeData.target_temperature =
              isNaN(rawData?.['shared.' + value.value.serial_number]?.value?.target_temperature_low) === false
                ? Number(rawData['shared.' + value.value.serial_number].value.target_temperature_low)
                : 0.0;
          }
          if (rawData?.['shared.' + value.value.serial_number]?.value?.target_temperature_type.toUpperCase() === 'RANGE') {
            // Target temperature is in between the heating and cooling point
            RESTTypeData.target_temperature =
              isNaN(rawData?.['shared.' + value.value.serial_number]?.value?.target_temperature_low) === false &&
              isNaN(rawData?.['shared.' + value.value.serial_number]?.value?.target_temperature_high) === false
                ? (Number(rawData['shared.' + value.value.serial_number].value.target_temperature_low) +
                    Number(rawData['shared.' + value.value.serial_number].value.target_temperature_high)) *
                  0.5
                : 0.0;
          }

          // Work out if eco mode is active and adjust temperature low/high and target
          if (value.value.eco.mode.toUpperCase() === 'AUTO-ECO' || value.value.eco.mode.toUpperCase() === 'MANUAL-ECO') {
            RESTTypeData.target_temperature_low = value.value.away_temperature_low;
            RESTTypeData.target_temperature_high = value.value.away_temperature_high;
            if (value.value.away_temperature_high_enabled === true && value.value.away_temperature_low_enabled === false) {
              RESTTypeData.target_temperature = value.value.away_temperature_low;
              RESTTypeData.hvac_mode = 'ecoheat';
            }
            if (value.value.away_temperature_high_enabled === true && value.value.away_temperature_low_enabled === false) {
              RESTTypeData.target_temperature = value.value.away_temperature_high;
              RESTTypeData.hvac_mode = 'ecocool';
            }
            if (value.value.away_temperature_high_enabled === true && value.value.away_temperature_low_enabled === true) {
              RESTTypeData.target_temperature = (value.value.away_temperature_low + value.value.away_temperature_high) * 0.5;
              RESTTypeData.hvac_mode = 'ecorange';
            }
          }

          // Work out current state ie: heating, cooling etc
          RESTTypeData.hvac_state = 'off'; // By default, we're not heating or cooling
          if (
            rawData?.['shared.' + value.value.serial_number]?.value?.hvac_heater_state === true ||
            rawData?.['shared.' + value.value.serial_number]?.value?.hvac_heat_x2_state === true ||
            rawData?.['shared.' + value.value.serial_number]?.value?.hvac_heat_x3_state === true ||
            rawData?.['shared.' + value.value.serial_number]?.value?.hvac_aux_heater_state === true ||
            rawData?.['shared.' + value.value.serial_number]?.value?.hvac_alt_heat_x2_state === true ||
            rawData?.['shared.' + value.value.serial_number]?.value?.hvac_emer_heat_state === true ||
            rawData?.['shared.' + value.value.serial_number]?.value?.hvac_alt_heat_state === true
          ) {
            // A heating source is on, so we're in heating mode
            RESTTypeData.hvac_state = 'heating';
          }
          if (
            rawData?.['shared.' + value.value.serial_number]?.value?.hvac_ac_state === true ||
            rawData?.['shared.' + value.value.serial_number]?.value?.hvac_cool_x2_state === true ||
            rawData?.['shared.' + value.value.serial_number]?.value?.hvac_cool_x3_state === true
          ) {
            // A cooling source is on, so we're in cooling mode
            RESTTypeData.hvac_state = 'cooling';
          }

          // Update fan status, on or off
          RESTTypeData.fan_state = isNaN(value.value?.fan_timer_timeout) === false && Number(value.value.fan_timer_timeout) > 0;
          RESTTypeData.fan_timer_speed =
            value.value?.fan_timer_speed?.includes?.('stage') === true && isNaN(value.value.fan_timer_speed.split('stage')[1]) === false
              ? Number(value.value.fan_timer_speed.split('stage')[1])
              : 0;
          RESTTypeData.fan_max_speed =
            value.value?.fan_capabilities?.includes?.('stage') === true && isNaN(value.value.fan_capabilities.split('stage')[1]) === false
              ? Number(value.value.fan_capabilities.split('stage')[1])
              : 0;

          // Humidifier/dehumidifier details
          RESTTypeData.target_humidity = isNaN(value.value?.target_humidity) === false ? Number(value.value.target_humidity) : 0.0;
          RESTTypeData.humidifier_state = value.value.humidifier_state === true;
          RESTTypeData.dehumidifier_state = value.value.dehumidifier_state === true;

          // Air filter details
          RESTTypeData.has_air_filter = value.value.has_air_filter === true;
          RESTTypeData.filter_replacement_needed = value.value.filter_replacement_needed === true;

          // Process any temperature sensors associated with this thermostat
          RESTTypeData.active_rcs_sensor = '';
          RESTTypeData.linked_rcs_sensors = [];
          if (rawData?.['rcs_settings.' + value.value.serial_number]?.value?.associated_rcs_sensors !== undefined) {
            rawData?.['rcs_settings.' + value.value.serial_number].value.associated_rcs_sensors.forEach((sensor) => {
              if (typeof rawData[sensor]?.value === 'object') {
                rawData[sensor].value.associated_thermostat = object_key; // Sensor is linked to this thermostat

                // Is this sensor the active one? If so, get some details about it
                if (
                  rawData?.['rcs_settings.' + value.value.serial_number]?.value?.active_rcs_sensors !== undefined &&
                  rawData?.['rcs_settings.' + value.value.serial_number]?.value?.active_rcs_sensors.includes(sensor)
                ) {
                  RESTTypeData.active_rcs_sensor = rawData[sensor].value.serial_number.toUpperCase();
                  RESTTypeData.current_temperature = rawData[sensor].value.current_temperature;
                }
                RESTTypeData.linked_rcs_sensors.push(rawData[sensor].value.serial_number.toUpperCase());
              }
            });
          }

          // Get associated schedules
          if (rawData?.['schedule.' + value.value.serial_number] !== undefined) {
            Object.values(rawData['schedule.' + value.value.serial_number].value.days).forEach((schedules) => {
              Object.values(schedules).forEach((schedule) => {
                // Fix up temperatures in the schedule
                if (isNaN(schedule['temp']) === false) {
                  schedule.temp = adjustTemperature(Number(schedule.temp), 'C', 'C', true);
                }
                if (isNaN(schedule['temp-min']) === false) {
                  schedule['temp-min'] = adjustTemperature(Number(schedule['temp-min']), 'C', 'C', true);
                }
                if (isNaN(schedule['temp-max']) === false) {
                  schedule['temp-max'] = adjustTemperature(Number(schedule['temp-max']), 'C', 'C', true);
                }
              });
            });
            RESTTypeData.schedules = rawData['schedule.' + value.value.serial_number].value.days;
            RESTTypeData.schedule_mode = rawData['schedule.' + value.value.serial_number].value.schedule_mode;
          }

          tempDevice = process_thermostat_data(object_key, RESTTypeData);
        }
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        log?.debug?.('Error processing thermostat data for "%s"', object_key);
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
        tempDevice.humiditySensor = deviceOptions?.humiditySensor === true;
        tempDevice.externalCool =
          typeof deviceOptions?.externalCool === 'string' && deviceOptions.externalCool !== '' ? deviceOptions.externalCool : undefined; // Config option for external cooling source
        tempDevice.externalHeat =
          typeof deviceOptions?.externalHeat === 'string' && deviceOptions.externalHeat !== '' ? deviceOptions.externalHeat : undefined; // Config option for external heating source
        tempDevice.externalFan =
          typeof deviceOptions?.externalFan === 'string' && deviceOptions.externalFan !== '' ? deviceOptions.externalFan : undefined; // Config option for external fan source
        tempDevice.externalDehumidifier =
          typeof deviceOptions?.externalDehumidifier === 'string' && deviceOptions.externalDehumidifier !== ''
            ? deviceOptions.externalDehumidifier
            : undefined; // Config option for external dehumidifier source
        devices[tempDevice.serialNumber] = tempDevice; // Store processed device
      }
    });

  return devices;
}
