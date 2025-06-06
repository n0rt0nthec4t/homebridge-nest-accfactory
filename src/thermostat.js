// Nest Thermostat
// Part of homebridge-nest-accfactory
//
// Code version 2025/06/04
// Mark Hulskamp
'use strict';

// Define our modules
import HomeKitDevice from './HomeKitDevice.js';

// Define nodejs module requirements
import path from 'node:path';

const LOWBATTERYLEVEL = 10; // Low battery level percentage
const MIN_TEMPERATURE = 9; // Minimum temperature for Nest Thermostat
const MAX_TEMPERATURE = 32; // Maximum temperature for Nest Thermostat

export default class NestThermostat extends HomeKitDevice {
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

  constructor(accessory, api, log, eventEmitter, deviceData) {
    super(accessory, api, log, eventEmitter, deviceData);
  }

  // Class functions
  async addServices() {
    // Setup the thermostat service if not already present on the accessory
    this.thermostatService = this.accessory.getService(this.hap.Service.Thermostat);
    if (this.thermostatService === undefined) {
      this.thermostatService = this.accessory.addService(this.hap.Service.Thermostat, '', 1);
    }
    this.thermostatService.setPrimaryService();

    if (this.thermostatService.testCharacteristic(this.hap.Characteristic.StatusActive) === false) {
      // Used to indicate active temperature if the thermostat is using its temperature sensor data
      // or an external temperature sensor ie: Nest Temperature Sensor
      this.thermostatService.addCharacteristic(this.hap.Characteristic.StatusActive);
    }
    if (this.thermostatService.testCharacteristic(this.hap.Characteristic.StatusFault) === false) {
      this.thermostatService.addCharacteristic(this.hap.Characteristic.StatusFault);
    }
    if (this.thermostatService.testCharacteristic(this.hap.Characteristic.LockPhysicalControls) === false) {
      // Setting can only be accessed via Eve App (or other 3rd party).
      this.thermostatService.addCharacteristic(this.hap.Characteristic.LockPhysicalControls);
    }
    if (
      this.deviceData?.has_air_filter === true &&
      this.thermostatService.testCharacteristic(this.hap.Characteristic.FilterChangeIndication) === false
    ) {
      // Setup air filter change characteristic
      this.thermostatService.addCharacteristic(this.hap.Characteristic.FilterChangeIndication);
    }
    if (
      this.deviceData?.has_air_filter === false &&
      this.thermostatService.testCharacteristic(this.hap.Characteristic.FilterChangeIndication) === true
    ) {
      // No longer configured to have an air filter, so remove characteristic from the accessory
      this.thermostatService.removeCharacteristic(this.hap.Characteristic.FilterChangeIndication);
    }

    if (
      this.deviceData?.has_humidifier === true &&
      this.thermostatService.testCharacteristic(this.hap.Characteristic.TargetRelativeHumidity) === false
    ) {
      // We have the capability for a humidifier, so setup target humidity characterisitc
      this.thermostatService.addCharacteristic(this.hap.Characteristic.TargetRelativeHumidity);
    }

    if (
      this.deviceData?.has_humidifier === false &&
      this.thermostatService.testCharacteristic(this.hap.Characteristic.TargetRelativeHumidity) === true
    ) {
      // No longer configured to use a humdifier, so remove characteristic from the accessory
      this.thermostatService.removeCharacteristic(this.hap.Characteristic.TargetRelativeHumidity);
    }

    if (this.thermostatService.testCharacteristic(this.hap.Characteristic.CurrentRelativeHumidity) === false) {
      this.thermostatService.addCharacteristic(this.hap.Characteristic.CurrentRelativeHumidity);
    }

    // Limit prop ranges
    this.thermostatService.getCharacteristic(this.hap.Characteristic.CurrentTemperature).setProps({
      minStep: 0.5,
    });
    this.thermostatService.getCharacteristic(this.hap.Characteristic.HeatingThresholdTemperature).setProps({
      minStep: 0.5,
      minValue: MIN_TEMPERATURE,
      maxValue: MAX_TEMPERATURE,
    });
    this.thermostatService.getCharacteristic(this.hap.Characteristic.CoolingThresholdTemperature).setProps({
      minStep: 0.5,
      minValue: MIN_TEMPERATURE,
      maxValue: MAX_TEMPERATURE,
    });

    if (this.deviceData?.can_cool === false && this.deviceData?.can_heat === true) {
      // Can heat only, so set values allowed for mode off/heat
      this.thermostatService.getCharacteristic(this.hap.Characteristic.TargetHeatingCoolingState).setProps({
        validValues: [this.hap.Characteristic.TargetHeatingCoolingState.OFF, this.hap.Characteristic.TargetHeatingCoolingState.HEAT],
      });
    }
    if (this.deviceData?.can_cool === true && this.deviceData?.can_heat === false) {
      // Can cool only
      this.thermostatService.getCharacteristic(this.hap.Characteristic.TargetHeatingCoolingState).setProps({
        validValues: [this.hap.Characteristic.TargetHeatingCoolingState.OFF, this.hap.Characteristic.TargetHeatingCoolingState.COOL],
      });
    }
    if (this.deviceData?.can_cool === true && this.deviceData?.can_heat === true) {
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
    if (this.deviceData?.can_cool === false && this.deviceData?.can_heat === false) {
      // only off mode
      this.thermostatService.getCharacteristic(this.hap.Characteristic.TargetHeatingCoolingState).setProps({
        validValues: [this.hap.Characteristic.TargetHeatingCoolingState.OFF],
      });
    }

    // Setup callbacks for characteristics
    this.thermostatService.getCharacteristic(this.hap.Characteristic.TemperatureDisplayUnits).onSet((value) => {
      this.setDisplayUnit(value);
    });
    this.thermostatService.getCharacteristic(this.hap.Characteristic.TargetHeatingCoolingState).onSet((value) => {
      this.setMode(value);
    });
    this.thermostatService.getCharacteristic(this.hap.Characteristic.TargetTemperature).onSet((value) => {
      this.setTemperature(this.hap.Characteristic.TargetTemperature, value);
    });
    this.thermostatService.getCharacteristic(this.hap.Characteristic.CoolingThresholdTemperature).onSet((value) => {
      this.setTemperature(this.hap.Characteristic.CoolingThresholdTemperature, value);
    });
    this.thermostatService.getCharacteristic(this.hap.Characteristic.HeatingThresholdTemperature).onSet((value) => {
      this.setTemperature(this.hap.Characteristic.HeatingThresholdTemperature, value);
    });
    this.thermostatService.getCharacteristic(this.hap.Characteristic.LockPhysicalControls).onSet((value) => {
      this.setChildlock('', value);
    });

    this.thermostatService.getCharacteristic(this.hap.Characteristic.TemperatureDisplayUnits).onGet(() => {
      return this.deviceData.temperature_scale === 'C'
        ? this.hap.Characteristic.TemperatureDisplayUnits.CELSIUS
        : this.hap.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
    });
    this.thermostatService.getCharacteristic(this.hap.Characteristic.TargetTemperature).onGet(() => {
      return this.getTemperature(this.hap.Characteristic.TargetTemperature);
    });
    this.thermostatService.getCharacteristic(this.hap.Characteristic.CoolingThresholdTemperature).onGet(() => {
      return this.getTemperature(this.hap.Characteristic.CoolingThresholdTemperature);
    });
    this.thermostatService.getCharacteristic(this.hap.Characteristic.HeatingThresholdTemperature).onGet(() => {
      return this.getTemperature(this.hap.Characteristic.HeatingThresholdTemperature);
    });
    this.thermostatService.getCharacteristic(this.hap.Characteristic.TargetHeatingCoolingState).onGet(() => {
      return this.getMode();
    });
    this.thermostatService.getCharacteristic(this.hap.Characteristic.LockPhysicalControls).onGet(() => {
      return this.deviceData.temperature_lock === true
        ? this.hap.Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED
        : this.hap.Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED;
    });

    // Setup occupancy service if not already present on the accessory
    this.occupancyService = this.accessory.getService(this.hap.Service.OccupancySensor);
    if (this.occupancyService === undefined) {
      this.occupancyService = this.accessory.addService(this.hap.Service.OccupancySensor, '', 1);
    }
    this.thermostatService.addLinkedService(this.occupancyService);

    // Setup battery service if not already present on the accessory
    this.batteryService = this.accessory.getService(this.hap.Service.Battery);
    if (this.batteryService === undefined) {
      this.batteryService = this.accessory.addService(this.hap.Service.Battery, '', 1);
    }
    this.batteryService.setHiddenService(true);
    this.thermostatService.addLinkedService(this.batteryService);

    // Setup fan service if supported by the thermostat and not already present on the accessory
    this.fanService = this.accessory.getService(this.hap.Service.Fanv2);
    if (this.deviceData?.has_fan === true) {
      if (this.fanService === undefined) {
        this.fanService = this.accessory.addService(this.hap.Service.Fanv2, '', 1);
      }
      if (this.fanService.testCharacteristic(this.hap.Characteristic.RotationSpeed) === false) {
        this.fanService.addCharacteristic(this.hap.Characteristic.RotationSpeed);
      }
      this.fanService.getCharacteristic(this.hap.Characteristic.RotationSpeed).setProps({
        minStep: 100 / this.deviceData.fan_max_speed,
      });

      this.thermostatService.addLinkedService(this.fanService);

      this.fanService.getCharacteristic(this.hap.Characteristic.Active).onSet((value) => {
        this.setFan(
          value,
          value === this.hap.Characteristic.Active.ACTIVE ? (this.deviceData.fan_timer_speed / this.deviceData.fan_max_speed) * 100 : 0,
        );
      });
      this.fanService.getCharacteristic(this.hap.Characteristic.RotationSpeed).onSet((value) => {
        this.setFan(value !== 0 ? this.hap.Characteristic.Active.ACTIVE : this.hap.Characteristic.Active.INACTIVE, value);
      });
      this.fanService.getCharacteristic(this.hap.Characteristic.Active).onGet(() => {
        return this.deviceData.fan_state === true ? this.hap.Characteristic.Active.ACTIVE : this.hap.Characteristic.Active.INACTIVE;
      });
      this.fanService.getCharacteristic(this.hap.Characteristic.RotationSpeed).onGet(() => {
        return (this.deviceData.fan_timer_speed / this.deviceData.fan_max_speed) * 100;
      });
    }
    if (this.deviceData?.has_fan === false && this.fanService !== undefined) {
      // No longer have a Fan configured and service present, so removed it
      this.accessory.removeService(this.fanService);
      this.fanService = undefined;
    }

    // Setup dehumifider service if supported by the thermostat and not already present on the accessory
    this.dehumidifierService = this.accessory.getService(this.hap.Service.HumidifierDehumidifier);
    if (this.deviceData?.has_dehumidifier === true) {
      if (this.dehumidifierService === undefined) {
        this.dehumidifierService = this.accessory.addService(this.hap.Service.HumidifierDehumidifier, '', 1);
      }
      this.thermostatService.addLinkedService(this.dehumidifierService);

      this.dehumidifierService.getCharacteristic(this.hap.Characteristic.TargetHumidifierDehumidifierState).setProps({
        validValues: [this.hap.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER],
      });
      this.dehumidifierService.getCharacteristic(this.hap.Characteristic.Active).onSet((value) => {
        this.setDehumidifier(value);
      });
      this.dehumidifierService.getCharacteristic(this.hap.Characteristic.Active).onGet(() => {
        return this.deviceData.dehumidifier_state === true
          ? this.hap.Characteristic.Active.ACTIVE
          : this.hap.Characteristic.Active.INACTIVE;
      });
    }
    if (this.deviceData?.has_dehumidifier === false && this.dehumidifierService !== undefined) {
      // No longer have a dehumidifier configured and service present, so removed it
      this.accessory.removeService(this.dehumidifierService);
      this.dehumidifierService = undefined;
    }

    // Setup humdity service if configured to be seperate and not already present on the accessory
    this.humidityService = this.accessory.getService(this.hap.Service.HumiditySensor);
    if (this.deviceData?.humiditySensor === true) {
      if (this.humidityService === undefined) {
        this.humidityService = this.accessory.addService(this.hap.Service.HumiditySensor, '', 1);
      }
      this.thermostatService.addLinkedService(this.humidityService);

      this.humidityService.getCharacteristic(this.hap.Characteristic.CurrentRelativeHumidity).onGet(() => {
        return this.deviceData.current_humidity;
      });
    }
    if (this.deviceData?.humiditySensor === false && this.humidityService !== undefined) {
      // No longer have a seperate humidity sensor configure and service present, so removed it
      this.accessory.removeService(this.humidityService);
      this.humidityService = undefined;
    }

    // Setup hotwater heating boost service if supported by the thermostat and not already present on the accessory
    this.switchService = this.accessory.getService(this.hap.Service.Switch);
    if (this.deviceData?.has_hot_water_control === true) {
      if (this.switchService === undefined) {
        this.switchService = this.accessory.addService(this.hap.Service.Switch, '', 1);
      }
      this.thermostatService.addLinkedService(this.switchService);

      this.switchService.getCharacteristic(this.hap.Characteristic.On).onSet((value) => {
        this.setHotwaterBoost(value);
      });
      this.switchService.getCharacteristic(this.hap.Characteristic.On).onGet(() => {
        return this.deviceData.hot_water_boost_active === true;
      });
    }
    if (this.deviceData?.has_hot_water_control === false && this.switchService !== undefined) {
      // No longer have hotwater heating boost configured and service present, so removed it
      this.accessory.removeService(this.switchService);
      this.switchService = undefined;
    }

    // Setup linkage to EveHome app if configured todo so
    if (
      this.deviceData?.eveHistory === true &&
      this.thermostatService !== undefined &&
      typeof this.historyService?.linkToEveHome === 'function'
    ) {
      this.historyService.linkToEveHome(this.thermostatService, {
        description: this.deviceData.description,
        getcommand: this.#EveHomeGetcommand.bind(this),
        setcommand: this.#EveHomeSetcommand.bind(this),
      });
    }

    // Attempt to load any external modules for this thermostat
    // We support external cool/heat/fan/dehumidifier module functions
    // This is all undocumented on how to use, as its for my specific use case :-)
    const loadExternalModule = async (module) => {
      if (typeof module !== 'string' || module === '') {
        return;
      }

      let loadedModule = undefined;
      try {
        let values = module.match(/'[^']*'|[^\s]+/g)?.map((v) => v.replace(/^'(.*)'$/, '$1')) || [];
        let script = path.resolve(values[0]); // external library name
        let options = values.slice(1); // options to be passed into the external library
        let externalModule = await import(script);
        if (typeof externalModule?.default === 'function') {
          loadedModule = externalModule.default(this.log, options);
        }
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        module =
          typeof module === 'string'
            ? module
                .trim()
                .match(/'[^']*'|[^\s]+/)?.[0]
                .replace(/^'(.*)'$/, '$1')
            : '';

        this?.log?.warn && this.log.warn('Failed to load specified external module for thermostat "%s"', module);
      }

      return loadedModule;
    };

    this.externalCool = await loadExternalModule(this.deviceData?.externalCool);
    this.externalHeat = await loadExternalModule(this.deviceData?.externalHeat);
    this.externalFan = await loadExternalModule(this.deviceData?.externalFan);
    this.externalDehumidifier = await loadExternalModule(this.deviceData?.externalDehumidifier);

    // Create extra details for output
    let postSetupDetails = [];
    this.humidityService !== undefined && postSetupDetails.push('Seperate humidity sensor');
    this.externalCool !== undefined && postSetupDetails.push('Using external cooling module');
    this.externalHeat !== undefined && postSetupDetails.push('Using external heating module');
    this.externalFan !== undefined && postSetupDetails.push('Using external fan module');
    this.externalDehumidifier !== undefined && postSetupDetails.push('Using external dehumidification module');

    return postSetupDetails;
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

      this?.log?.info &&
        this.log.info(
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

    this?.log?.info &&
      this.log.info(
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

    this?.log?.info &&
      this.log.info(
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

    this?.log?.info &&
      this.log.info(
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

      this?.log?.info && this.log.info('Set mode on "%s" to "%s"', this.deviceData.description, mode);
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

        this?.log?.info &&
          this.log.info(
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

        this?.log?.info &&
          this.log.info(
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

        this?.log?.info &&
          this.log.info(
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

    this?.log?.info &&
      this.log.info(
        'Setting Childlock on "%s" to "%s"',
        this.deviceData.description,
        value === this.hap.Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED ? 'Enabled' : 'Disabled',
      );
  }

  updateServices(deviceData) {
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
      deviceData.battery_level > LOWBATTERYLEVEL
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
        this.fanService = this.accessory.addService(this.hap.Service.Fanv2, '', 1);

        if (this.fanService.testCharacteristic(this.hap.Characteristic.RotationSpeed) === false) {
          this.fanService.addCharacteristic(this.hap.Characteristic.RotationSpeed);
        }
        this.fanService.getCharacteristic(this.hap.Characteristic.RotationSpeed).setProps({
          minStep: 100 / this.deviceData.fan_max_speed,
        });
        this.thermostatService.addLinkedService(this.fanService);

        this.fanService.getCharacteristic(this.hap.Characteristic.Active).onSet((value) => {
          this.setFan(value);
        });

        this.fanService.getCharacteristic(this.hap.Characteristic.Active).onGet(() => {
          return this.deviceData.fan_state === true ? this.hap.Characteristic.Active.ACTIVE : this.hap.Characteristic.Active.INACTIVE;
        });
      }
      if (deviceData.has_fan === false && this.deviceData.has_fan === true && this.fanService !== undefined) {
        // Fan has been removed
        this.accessory.removeService(this.fanService);
        this.fanService = undefined;
      }

      this?.log?.info &&
        this.log.info(
          'Fan setup on thermostat "%s" has changed. Fan was',
          deviceData.description,
          this.fanService === undefined ? 'removed' : 'added',
        );
    }

    // Check for dehumidifer setup change on thermostat
    if (deviceData.has_dehumidifier !== this.deviceData.has_dehumidifier) {
      if (deviceData.has_dehumidifier === true && this.deviceData.has_dehumidifier === false && this.dehumidifierService === undefined) {
        // Dehumidifier has been added
        this.dehumidifierService = this.accessory.addService(this.hap.Service.HumidifierDehumidifier, '', 1);
        this.thermostatService.addLinkedService(this.dehumidifierService);

        this.dehumidifierService.getCharacteristic(this.hap.Characteristic.TargetHumidifierDehumidifierState).setProps({
          validValues: [this.hap.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER],
        });

        this.dehumidifierService.getCharacteristic(this.hap.Characteristic.Active).onSet((value) => {
          this.setDehumidifier(value);
        });

        this.dehumidifierService.getCharacteristic(this.hap.Characteristic.Active).onGet(() => {
          return this.deviceData.dehumidifier_state === true
            ? this.hap.Characteristic.Active.ACTIVE
            : this.hap.Characteristic.Active.INACTIVE;
        });
      }
      if (deviceData.has_dehumidifier === false && this.deviceData.has_dehumidifier === true && this.dehumidifierService !== undefined) {
        // Dehumidifer has been removed
        this.accessory.removeService(this.dehumidifierService);
        this.dehumidifierService = undefined;
      }

      this?.log?.info &&
        this.log.info(
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
        if (this.deviceData?.has_hot_water_control === true) {
          if (this.switchService === undefined) {
            this.switchService = this.accessory.addService(this.hap.Service.Switch, '', 1);
          }
          this.thermostatService.addLinkedService(this.switchService);

          this.switchService.getCharacteristic(this.hap.Characteristic.On).onSet((value) => {
            this.setHotwaterBoost(value);
          });
          this.switchService.getCharacteristic(this.hap.Characteristic.On).onGet(() => {
            return this.deviceData.hot_water_boost_active === true;
          });
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

      this?.log?.info &&
        this.log.info(
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

      this?.log?.info && this.log.info('Heating/cooling setup on thermostat on "%s" has changed', deviceData.description);
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
      if (this.deviceData.hvac_state.toUpperCase() === 'COOLING' && this.externalCool !== undefined) {
        // Switched to heating mode and external cooling external code was being used, so stop cooling via cooling external code
        if (typeof this.externalCool.off === 'function') {
          this.externalCool.off();
        }
      }
      if (
        (this.deviceData.hvac_state.toUpperCase() !== 'HEATING' ||
          deviceData.target_temperature_low !== this.deviceData.target_temperature_low) &&
        this.externalHeat !== undefined
      ) {
        // Switched to heating mode and external heating external code is being used
        // Start heating via heating external code OR adjust heating target temperature due to change
        if (typeof this.externalHeat.heat === 'function') {
          this.externalHeat.heat(deviceData.deviceData.target_temperature_low);
        }
      }
      this.thermostatService.updateCharacteristic(
        this.hap.Characteristic.CurrentHeatingCoolingState,
        this.hap.Characteristic.CurrentHeatingCoolingState.HEAT,
      );
      historyEntry.status = 2; // heating
    }
    if (deviceData.hvac_state.toUpperCase() === 'COOLING') {
      if (this.deviceData.hvac_state.toUpperCase() === 'HEATING' && this.externalHeat !== undefined) {
        // Switched to cooling mode and external heating external code was being used, so stop heating via heating external code
        if (typeof this.externalHeat.off === 'function') {
          this.externalHeat.off();
        }
      }
      if (
        (this.deviceData.hvac_state.toUpperCase() !== 'COOLING' ||
          deviceData.target_temperature_high !== this.deviceData.target_temperature_high) &&
        this.externalCool !== undefined
      ) {
        // Switched to cooling mode and external cooling external code is being used
        // Start cooling via cooling external code OR adjust cooling target temperature due to change
        if (typeof this.externalCool.cool === 'function') {
          this.externalCool.cool(deviceData.target_temperature_high);
        }
      }
      this.thermostatService.updateCharacteristic(
        this.hap.Characteristic.CurrentHeatingCoolingState,
        this.hap.Characteristic.CurrentHeatingCoolingState.COOL,
      );
      historyEntry.status = 3; // cooling
    }
    if (deviceData.hvac_state.toUpperCase() === 'OFF') {
      if (this.deviceData.hvac_state.toUpperCase() === 'COOLING' && this.externalCool !== undefined) {
        // Switched to off mode and external cooling external code was being used, so stop cooling via cooling external code
        if (typeof this.externalCool.off === 'function') {
          this.externalCool.off();
        }
      }
      if (this.deviceData.hvac_state.toUpperCase() === 'HEATING' && this.externalHeat !== undefined) {
        // Switched to off mode and external heating external code was being used, so stop heating via heating external code
        if (typeof this.externalHeat.heat === 'function') {
          this.externalHeat.off();
        }
      }
      this.thermostatService.updateCharacteristic(
        this.hap.Characteristic.CurrentHeatingCoolingState,
        this.hap.Characteristic.CurrentHeatingCoolingState.OFF,
      );
      historyEntry.status = 0; // off
    }

    if (this.fanService !== undefined) {
      // fan status on or off
      if (this.deviceData.fan_state === false && deviceData.fan_state === true && this.externalFan !== undefined) {
        // Fan mode was switched on and external fan external code is being used, so start fan via fan external code
        if (typeof this.externalFan.fan === 'function') {
          this.externalFan.fan(0); // Fan speed will be auto
        }
      }
      if (this.deviceData.fan_state === true && deviceData.fan_state === false && this.externalFan !== undefined) {
        // Fan mode was switched off and external fan external code was being used, so stop fan via fan external code
        if (typeof this.externalFan.off === 'function') {
          this.externalFan.off();
        }
      }

      this.fanService.updateCharacteristic(
        this.hap.Characteristic.RotationSpeed,
        deviceData.fan_state === true ? (deviceData.fan_timer_speed / deviceData.fan_max_speed) * 100 : 0,
      );

      this.fanService.updateCharacteristic(
        this.hap.Characteristic.Active,
        deviceData.fan_state === true ? this.hap.Characteristic.Active.ACTIVE : this.hap.Characteristic.Active.INACTIVE,
      );
      historyEntry.status = 1; // fan
    }

    if (this.dehumidifierService !== undefined) {
      // dehumidifier status on or off
      if (
        this.deviceData.dehumidifier_state === false &&
        deviceData.dehumidifier_state === true &&
        this.externalDehumidifier !== undefined
      ) {
        // Dehumidifier mode was switched on and external dehumidifier external code is being used
        // Start dehumidifier via dehumidifier external code
        if (typeof this.externalDehumidifier.dehumififier === 'function') {
          this.externalDehumidifier.dehumififier(0);
        }
      }
      if (
        this.deviceData.dehumidifier_state === true &&
        deviceData.dehumidifier_state === false &&
        this.externalDehumidifier !== undefined
      ) {
        // Dehumidifier mode was switched off and external dehumidifier external code was being used
        // Stop dehumidifier via dehumidifier external code
        if (typeof this.externalDehumidifier.off === 'function') {
          this.externalDehumidifier.off();
        }
      }

      this.dehumidifierService.updateCharacteristic(
        this.hap.Characteristic.Active,
        deviceData.dehumidifier_state === true ? this.hap.Characteristic.Active.ACTIVE : this.hap.Characteristic.Active.INACTIVE,
      );
      historyEntry.status = 4; // dehumidifier
    }

    if (this.switchService !== undefined) {
      // Hotwater boost status on or off
      this.switchService.updateCharacteristic(this.hap.Characteristic.On, deviceData.hot_water_boost_active === true);
    }

    // Log thermostat metrics to history only if changed to previous recording
    if (this.thermostatService !== undefined && typeof this.historyService?.addHistory === 'function') {
      let tempEntry = this.historyService.lastHistory(this.thermostatService);
      if (
        tempEntry === undefined ||
        (typeof tempEntry === 'object' && tempEntry.status !== historyEntry.status) ||
        tempEntry.temperature !== deviceData.current_temperature ||
        JSON.stringify(tempEntry.target) !== JSON.stringify(historyEntry.target) ||
        tempEntry.humidity !== deviceData.current_humidity
      ) {
        this.historyService.addHistory(this.thermostatService, {
          time: Math.floor(Date.now() / 1000),
          status: historyEntry.status,
          temperature: deviceData.current_temperature,
          target: historyEntry.target,
          humidity: deviceData.current_humidity,
        });
      }
    }

    // Notify Eve App of device status changes if linked
    if (
      this.deviceData.eveHistory === true &&
      this.thermostatService !== undefined &&
      typeof this.historyService?.updateEveHome === 'function'
    ) {
      // Update our internal data with properties Eve will need to process
      this.deviceData.online = deviceData.online;
      this.deviceData.removed_from_base = deviceData.removed_from_base;
      this.deviceData.vacation_mode = deviceData.vacation_mode;
      this.deviceData.hvac_mode = deviceData.hvac_mode;
      this.deviceData.schedules = deviceData.schedules;
      this.deviceData.schedule_mode = deviceData.schedule_mode;
      this.historyService.updateEveHome(this.thermostatService, this.#EveHomeGetcommand.bind(this));
    }
  }

  #EveHomeGetcommand(EveHomeGetData) {
    // Pass back extra data for Eve Thermo onGet() to process command
    // Data will already be an object, our only job is to add/modify it
    if (typeof EveHomeGetData === 'object') {
      EveHomeGetData.enableschedule = this.deviceData.schedule_mode === 'heat'; // Schedules on/off
      EveHomeGetData.attached = this.deviceData.online === true && this.deviceData.removed_from_base === false;
      EveHomeGetData.vacation = this.deviceData.vacation_mode === true; //   Vaction mode on/off
      EveHomeGetData.vacationtemp = this.deviceData.vacation_mode === true ? EveHomeGetData.vacationtemp : null;
      EveHomeGetData.programs = []; // No programs yet, we'll process this below
      if (this.deviceData.schedule_mode.toUpperCase() === 'HEAT' || this.deviceData.schedule_mode.toUpperCase() === 'RANGE') {
        const DAYSOFWEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

        Object.entries(this.deviceData.schedules).forEach(([day, schedules]) => {
          let tempSchedule = [];
          let tempTemperatures = [];
          Object.values(schedules)
            .reverse()
            .forEach((schedule) => {
              if (schedule.entry_type === 'setpoint' && (schedule.type === 'HEAT' || schedule.type === 'RANGE')) {
                tempSchedule.push({
                  start: schedule.time,
                  duration: 0,
                  temperature: typeof schedule['temp-min'] === 'number' ? schedule['temp-min'] : schedule.temp,
                });
                tempTemperatures.push(typeof schedule['temp-min'] === 'number' ? schedule['temp-min'] : schedule.temp);
              }
            });

          // Sort the schedule array by start time
          tempSchedule = tempSchedule.sort((a, b) => {
            if (a.start < b.start) {
              return -1;
            }
          });

          let ecoTemp = tempTemperatures.length === 0 ? 0 : Math.min(...tempTemperatures);
          let comfortTemp = tempTemperatures.length === 0 ? 0 : Math.max(...tempTemperatures);
          let program = {};
          program.id = parseInt(day) + 1;
          program.days = DAYSOFWEEK[day];
          program.schedule = [];
          let lastTime = 86400; // seconds in a day
          Object.values(tempSchedule)
            .reverse()
            .forEach((schedule) => {
              if (schedule.temperature === comfortTemp) {
                // We only want to add the schedule time if its using the 'max' temperature
                program.schedule.push({
                  start: schedule.start,
                  duration: lastTime - schedule.start,
                  ecotemp: ecoTemp,
                  comforttemp: comfortTemp,
                });
              }
              lastTime = schedule.start;
            });
          EveHomeGetData.programs.push(program);
        });
      }
    }
    return EveHomeGetData;
  }

  #EveHomeSetcommand(EveHomeSetData) {
    if (typeof EveHomeSetData !== 'object') {
      return;
    }

    if (typeof EveHomeSetData?.vacation === 'boolean') {
      this.set({ uuid: this.deviceData.nest_google_uuid, vacation_mode: EveHomeSetData.vacation.status });
    }
    if (typeof EveHomeSetData?.programs === 'object') {
      //EveHomeSetData.programs.forEach((day) => {
      // Convert into Nest thermostat schedule format and set. Need to work this out
      //  this.set({ uuid: this.deviceData.nest_google_uuid, days: { 6: { temp: 17, time: 13400, touched_at: Date.now() } } });
      //});
    }
  }
}

function formatDuration(seconds) {
  return `${
    seconds >= 3600 ? `${Math.floor(seconds / 3600)} hr${Math.floor(seconds / 3600) > 1 ? 's' : ''} ` : ''
  }${Math.floor((seconds % 3600) / 60)} min${Math.floor((seconds % 3600) / 60) !== 1 ? 's' : ''}`;
}
