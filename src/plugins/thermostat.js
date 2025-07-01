// Nest Thermostat
// Part of homebridge-nest-accfactory
//
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Define our modules
import HomeKitDevice from '../HomeKitDevice.js';

// Define constants
const LOW_BATTERY_LEVEL = 10; // Low battery level percentage
const MIN_TEMPERATURE = 9; // Minimum temperature for Nest Thermostat
const MAX_TEMPERATURE = 32; // Maximum temperature for Nest Thermostat
const __dirname = path.dirname(fileURLToPath(import.meta.url)); // Make a defined for JS __dirname
const DAYS_OF_WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export default class NestThermostat extends HomeKitDevice {
  static TYPE = 'Thermostat';
  static VERSION = '2025.06.28'; // Code version

  batteryService = undefined;
  occupancyService = undefined;
  humidityService = undefined;
  switchService = undefined; // Hotwater heating boost control
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

    // Patch to avoid characteristic errros when setting inital property ranges
    this.hap.Characteristic.HeatingThresholdTemperature.prototype.getDefaultValue = function () {
      return MIN_TEMPERATURE; // start at minimum heating threshold
    };
    this.hap.Characteristic.CoolingThresholdTemperature.prototype.getDefaultValue = function () {
      return MAX_TEMPERATURE; // start at maximum cooling threshold
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
        return this.deviceData.temperature_scale === 'C'
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
        minValue: MIN_TEMPERATURE,
        maxValue: MAX_TEMPERATURE,
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
        minValue: MIN_TEMPERATURE,
        maxValue: MAX_TEMPERATURE,
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

    // Setup hotwater heating boost service if supported by the thermostat and not already present on the accessory
    if (this.deviceData?.has_hot_water_control === true) {
      this.#setupHotwaterBoost();
    }
    if (this.deviceData?.has_hot_water_control === false) {
      // No longer have hotwater heating boost configured and service present, so removed it
      this.switchService = this.accessory.getService(this.hap.Service.Switch);
      if (this.switchService !== undefined) {
        this.accessory.removeService(this.switchService);
      }
      this.switchService = undefined;
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

  setFan(fanState, speed) {
    if (
      fanState !== this.fanService.getCharacteristic(this.hap.Characteristic.Active).value ||
      speed !== this.fanService.getCharacteristic(this.hap.Characteristic.RotationSpeed).value
    ) {
      this.set({
        uuid: this.deviceData.nest_google_uuid,
        fan_state: fanState === this.hap.Characteristic.Active.ACTIVE ? true : false,
        fan_timer_speed: Math.round((speed / 100) * this.deviceData.fan_max_speed),
      });
      this.fanService.updateCharacteristic(this.hap.Characteristic.Active, fanState);
      this.fanService.updateCharacteristic(this.hap.Characteristic.RotationSpeed, speed);

      this?.log?.info?.(
        'Set fan on thermostat "%s" to "%s"',
        this.deviceData.description,
        fanState === this.hap.Characteristic.Active.ACTIVE ? 'On with fan speed of ' + speed + '%' : 'Off',
      );
    }
  }

  setDehumidifier(dehumidiferState) {
    this.set({
      uuid: this.deviceData.nest_google_uuid,
      dehumidifier_state: dehumidiferState === this.hap.Characteristic.Active.ACTIVE ? true : false,
    });
    this.dehumidifierService.updateCharacteristic(this.hap.Characteristic.Active, dehumidiferState);

    this?.log?.info?.(
      'Set dehumidifer on thermostat "%s" to "%s"',
      this.deviceData.description,
      dehumidiferState === this.hap.Characteristic.Active.ACTIVE
        ? 'On with target humidity level of ' + this.deviceData.target_humidity + '%'
        : 'Off',
    );
  }

  setHotwaterBoost(hotwaterState) {
    this.set({
      uuid: this.deviceData.nest_google_uuid,
      hot_water_boost_active: { state: hotwaterState === true, time: this.deviceData.hotWaterBoostTime },
    });
    this.switchService.updateCharacteristic(this.hap.Characteristic.On, hotwaterState);

    this?.log?.info?.(
      'Set hotwater boost heating on thermostat "%s" to "%s"',
      this.deviceData.description,
      hotwaterState === true ? 'On for ' + formatDuration(this.deviceData.hotWaterBoostTime) : 'Off',
    );
  }

  setDisplayUnit(temperatureUnit) {
    this.set({
      uuid: this.deviceData.nest_google_uuid,
      temperature_scale: temperatureUnit === this.hap.Characteristic.TemperatureDisplayUnits.CELSIUS ? 'C' : 'F',
    });
    this.thermostatService.updateCharacteristic(this.hap.Characteristic.TemperatureDisplayUnits, temperatureUnit);

    this?.log?.info?.(
      'Set temperature units on thermostat "%s" to "%s"',
      this.deviceData.description,
      temperatureUnit === this.hap.Characteristic.TemperatureDisplayUnits.CELSIUS ? '°C' : '°F',
    );
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

      this.set({ uuid: this.deviceData.nest_google_uuid, hvac_mode: mode });

      this?.log?.info?.('Set mode on "%s" to "%s"', this.deviceData.description, mode);
    }
  }

  getMode() {
    let currentMode = null;

    if (this.deviceData.hvac_mode.toUpperCase() === 'HEAT' || this.deviceData.hvac_mode.toUpperCase() === 'ECOHEAT') {
      // heating mode, either eco or normal;
      currentMode = this.hap.Characteristic.TargetHeatingCoolingState.HEAT;
    }
    if (this.deviceData.hvac_mode.toUpperCase() === 'COOL' || this.deviceData.hvac_mode.toUpperCase() === 'ECOCOOL') {
      // cooling mode, either eco or normal
      currentMode = this.hap.Characteristic.TargetHeatingCoolingState.COOL;
    }
    if (this.deviceData.hvac_mode.toUpperCase() === 'RANGE' || this.deviceData.hvac_mode.toUpperCase() === 'ECORANGE') {
      // range mode, either eco or normal
      currentMode = this.hap.Characteristic.TargetHeatingCoolingState.AUTO;
    }
    if (this.deviceData.hvac_mode.toUpperCase() === 'OFF' || (this.deviceData.can_cool === false && this.deviceData.can_heat === false)) {
      // off mode or no heating or cooling capability
      currentMode = this.hap.Characteristic.TargetHeatingCoolingState.OFF;
    }

    return currentMode;
  }

  setTemperature(characteristic, temperature) {
    if (typeof characteristic === 'function' && typeof characteristic?.UUID === 'string') {
      if (
        characteristic.UUID === this.hap.Characteristic.TargetTemperature.UUID &&
        this.thermostatService.getCharacteristic(this.hap.Characteristic.TargetHeatingCoolingState).value !==
          this.hap.Characteristic.TargetHeatingCoolingState.AUTO
      ) {
        this.set({ uuid: this.deviceData.nest_google_uuid, target_temperature: temperature });

        this?.log?.info?.(
          'Set %s%s temperature on "%s" to "%s °C"',
          this.deviceData.hvac_mode.toUpperCase().includes('ECO') ? 'eco mode ' : '',
          this.thermostatService.getCharacteristic(this.hap.Characteristic.TargetHeatingCoolingState).value ===
            this.hap.Characteristic.TargetHeatingCoolingState.HEAT
            ? 'heating'
            : 'cooling',
          this.deviceData.description,
          temperature,
        );
      }
      if (
        characteristic.UUID === this.hap.Characteristic.HeatingThresholdTemperature.UUID &&
        this.thermostatService.getCharacteristic(this.hap.Characteristic.TargetHeatingCoolingState).value ===
          this.hap.Characteristic.TargetHeatingCoolingState.AUTO
      ) {
        this.set({ uuid: this.deviceData.nest_google_uuid, target_temperature_low: temperature });

        this?.log?.info?.(
          'Set %sheating temperature on "%s" to "%s °C"',
          this.deviceData.hvac_mode.toUpperCase().includes('ECO') ? 'eco mode ' : '',
          this.deviceData.description,
          temperature,
        );
      }
      if (
        characteristic.UUID === this.hap.Characteristic.CoolingThresholdTemperature.UUID &&
        this.thermostatService.getCharacteristic(this.hap.Characteristic.TargetHeatingCoolingState).value ===
          this.hap.Characteristic.TargetHeatingCoolingState.AUTO
      ) {
        this.set({ uuid: this.deviceData.nest_google_uuid, target_temperature_high: temperature });

        this?.log?.info?.(
          'Set %scooling temperature on "%s" to "%s °C"',
          this.deviceData.hvac_mode.toUpperCase().includes('ECO') ? 'eco mode ' : '',
          this.deviceData.description,
          temperature,
        );
      }

      this.thermostatService.updateCharacteristic(characteristic, temperature); // Update HomeKit with value
    }
  }

  getTemperature(characteristic) {
    let currentTemperature = null;

    if (typeof characteristic === 'function' && typeof characteristic?.UUID === 'string') {
      if (characteristic.UUID === this.hap.Characteristic.TargetTemperature.UUID) {
        currentTemperature = this.deviceData.target_temperature;
      }
      if (characteristic.UUID === this.hap.Characteristic.HeatingThresholdTemperature.UUID) {
        currentTemperature = this.deviceData.target_temperature_low;
      }
      if (characteristic.UUID === this.hap.Characteristic.CoolingThresholdTemperature.UUID) {
        currentTemperature = this.deviceData.target_temperature_high;
      }
      if (currentTemperature < MIN_TEMPERATURE) {
        currentTemperature = MIN_TEMPERATURE;
      }
      if (currentTemperature > MAX_TEMPERATURE) {
        currentTemperature = MAX_TEMPERATURE;
      }
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
    this.set({
      uuid: this.deviceData.nest_google_uuid,
      temperature_lock: value === this.hap.Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED ? true : false,
    });

    this?.log?.info?.(
      'Setting Childlock on "%s" to "%s"',
      this.deviceData.description,
      value === this.hap.Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED ? 'Enabled' : 'Disabled',
    );
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

    // Update air filter sttaus if has been added
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

    // Check for hotwater heating boost setup change on thermostat
    if (deviceData.has_hot_water_control !== this.deviceData.has_hot_water_control) {
      if (
        deviceData.has_hot_water_control === true &&
        this.deviceData.has_hot_water_control === false &&
        this.switchService === undefined
      ) {
        // hotwater heating boost has been added
        this.switchService = this.accessory.getService(this.hap.Service.Switch);
        if (this.deviceData.has_hot_water_control === true) {
          this.#setupHotwaterBoost();
        }
        if (
          deviceData.has_hot_water_control === false &&
          this.deviceData.has_hot_water_control === true &&
          this.switchService !== undefined
        ) {
          // hotwater heating boost has been removed
          this.accessory.removeService(this.switchService);
          this.switchService = undefined;
        }
      }

      this?.log?.info?.(
        'hotwater heating boost setup on thermostat "%s" has changed. Hotwater heating boost was',
        deviceData.description,
        this.switchService === undefined ? 'removed' : 'added',
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

    if (this.switchService !== undefined) {
      // Hotwater boost status on or off
      this.switchService.updateCharacteristic(this.hap.Characteristic.On, deviceData.hot_water_boost_active === true);
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
    if (typeof message !== 'object' || message === null) {
      return;
    }

    if (type === HomeKitDevice?.HISTORY?.GET) {
      // Extend Eve Thermo GET payload with device state
      message.enableschedule = this.deviceData.schedule_mode === 'heat';
      message.attached = this.deviceData.online === true && this.deviceData.removed_from_base === false;
      message.vacation = this.deviceData.vacation_mode === true;
      message.vacationtemp = this.deviceData.vacation_mode === true ? message.vacationtemp : null;
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
            days: isNaN(day) === false && DAYS_OF_WEEK?.[day] !== undefined ? DAYS_OF_WEEK[day] : 'mon',
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

    if (type === HomeKitDevice?.HISTORY?.SET) {
      if (typeof message.vacation === 'boolean') {
        this.set({ uuid: this.deviceData.nest_google_uuid, vacation_mode: message.vacation.status });
      }

      if (typeof message.programs === 'object') {
        // Future: convert to Nest format and apply via .set()
        // this.set({ uuid: ..., days: { ... } });
      }

      return;
    }

    return;
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

  #setupHotwaterBoost() {
    this.switchService = this.addHKService(this.hap.Service.Switch, '', 1);
    this.thermostatService.addLinkedService(this.switchService);

    this.addHKCharacteristic(this.switchService, this.hap.Characteristic.On, {
      onSet: (value) => this.setHotwaterBoost(value),
      onGet: () => {
        return this.deviceData?.hot_water_boost_active === true;
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

function formatDuration(seconds) {
  return `${
    seconds >= 3600 ? `${Math.floor(seconds / 3600)} hr${Math.floor(seconds / 3600) > 1 ? 's' : ''} ` : ''
  }${Math.floor((seconds % 3600) / 60)} min${Math.floor((seconds % 3600) / 60) !== 1 ? 's' : ''}`;
}
