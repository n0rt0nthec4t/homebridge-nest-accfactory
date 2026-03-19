// Nest Thermostats - HomeKit integration
// Part of homebridge-nest-accfactory
//
// HomeKit accessory for Nest Thermostats providing comprehensive climate control
// with intelligent mode switching, occupancy detection, fan control, humidifier/dehumidifier support,
// and Eve Home integration. Supports external automation modules for custom climate logic.
//
// Services:
// - Thermostat (primary climate control service)
// - Fan (if has_fan - variable or single speed control)
// - OccupancySensor (away/home detection)
// - Battery (hidden, for battery-powered models)
// - HumiditySensor (optional, if humiditySensor config enabled)
// - HumidifierDehumidifier (optional, if has_humidifier or has_dehumidifier)
//
// Thermostat Characteristics:
// - CurrentTemperature: Active sensor reading with 0.5°C/F resolution
// - TargetTemperature: Single target (HEAT/COOL modes) or midpoint (AUTO mode)
// - HeatingThresholdTemperature: Minimum comfort temperature in AUTO mode
// - CoolingThresholdTemperature: Maximum comfort temperature in AUTO mode
// - CurrentHeatingCoolingState: Active operation mode (off/heat/cool)
// - TargetHeatingCoolingState: Requested mode (off/heat/cool/auto)
// - TemperatureDisplayUnits: Celsius/Fahrenheit display preference
// - CurrentRelativeHumidity: Active humidity sensor reading
// - StatusActive: True when using thermostat temperature (false if external sensor active)
// - StatusFault: Set when thermostat offline or removed from base station
// - LockPhysicalControls: Child lock for physical controls (PIN support planned)
// - FilterChangeIndication: Air filter replacement status
//
// Fan Characteristics (if has_fan):
// - Active: Fan on/off control
// - RotationSpeed: Variable speed 0-100% (if fan_max_speed > 1)
//
// HumidifierDehumidifier Characteristics (if configured):
// - Active: Humidifier/dehumidifier on/off
// - CurrentHumidifierDehumidifierState: Operation mode (humidifying/dehumidifying/idle)
// - TargetHumidifierDehumidifierState: Humidifier-only, dehumidifier-only, or both
// - RelativeHumidityHumidifierThreshold: Target percentage for humidifying
// - RelativeHumidityDehumidifierThreshold: Target percentage for dehumidifying
// - CurrentRelativeHumidity: Current humidity reading for the accessory
//
// Features:
// - Four operation modes: Heat, Cool, Auto/Range, Off (eco variants internally mapped to standard modes)
// - Dynamic mode validation: Only valid modes offered based on device capabilities (can_heat, can_cool)
// - Temperature control with 0.5°C/F increments and configurable min/max boundaries
// - Smart temperature mapping: HeatingThresholdTemperature/CoolingThresholdTemperature in AUTO mode
// - Fan control with variable speed (if fan_max_speed > 1) and duration-based timeout
// - Humidifier/dehumidifier control with independent target levels and dual-mode support
// - Occupancy detection: Away (no occupancy) vs Home (occupancy detected)
// - Battery monitoring with low-battery threshold (for battery-powered models)
// - Child lock: Physical control locking with optional PIN (implementation planned)
// - Air filter replacement tracking and HomeKit notification
// - External module automation: Custom .mjs functions for heat/cool/fan/dehumidifier/humidifier/off
// - Eve Home integration: Schedule readout, vacation mode, and eco/comfort temperature payloads
// - Temperature sensor linking: Can use external temperature sensor (e.g., Nest Temperature Sensor)
// - Mode change logging: Tracks source (HomeKit vs Thermostat device); temperature logs preserve eco context
//
// Data processing:
// - HVAC modes normalised to uppercase and eco prefix stripped for HomeKit compatibility
// - Temperature thresholds dynamically updated based on active mode configuration
// - Fan speed scaled between 0-100% and device max_speed boundary
// - Humidity control state transitions trigger external module functions
// - Eve Home payloads include schedule day entries with eco/comfort temperature settings
// - Translates raw Nest and Google API structures into unified HomeKit format
//
// External Module Support:
// Flexible JavaScript (.mjs) modules in plugin directory supporting function signatures:
// - cool(targetTemperature): Called when cooling activated
// - heat(targetTemperature): Called when heating activated
// - fan(value): Called when fan activated
// - dehumidifier(value): Called when dehumidifying
// - humidifier(value): Called when humidifying
// - off(): Called to stop any active operation
//
// Limitations:
// - PIN-based child lock implementation pending API support
// - Humidifier/dehumidifier mode changes trigger both .set() and external module calls
// - Fan/humidifier/dehumidifier callbacks currently receive a generic value rather than target metadata
// - Temperature locking is characteristic-only (no backend PIN encryption yet)
//
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

// Define our modules
import HomeKitDevice from '../HomeKitDevice.js';
import { processCommonData, scaleValue, adjustTemperature, parseDurationToSeconds } from '../utils.js';
import { buildMappedObject, createMappingContext } from '../translator.js';

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
  FAN_DURATION_TIMES,
} from '../consts.js';

export default class NestThermostat extends HomeKitDevice {
  static TYPE = 'Thermostat';
  static VERSION = '2026.03.20'; // Code version

  thermostatService = undefined;
  batteryService = undefined;
  occupancyService = undefined;
  humidityService = undefined;
  fanService = undefined; // Fan control
  humidifierDehumidifierService = undefined; // humidifier & dehumidifier control
  #external = {}; // External module functions

  // Class functions
  async onAdd() {
    // Setup the thermostat service if not already present on the accessory, and link it to the Eve app if configured to do so
    this.thermostatService = this.addHKService(this.hap.Service.Thermostat, '', 1, { messages: this.message.bind(this) });
    this.thermostatService.setPrimaryService();

    // Fix for coding error with versions below 2025.08.20 where fan specific characteristics were added directly to the thermostat service
    // Thanks to @gizmotronic for raising this issue
    this.thermostatService.removeCharacteristic(this.hap.Characteristic.RotationSpeed);
    this.thermostatService.removeCharacteristic(this.hap.Characteristic.Active);

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
    if (this.deviceData?.hasHumidifier === true || this.deviceData?.hasDehumidifier === true) {
      // Set default value for TargetHumidifierDehumidifierState based on capabilities
      this.hap.Characteristic.TargetHumidifierDehumidifierState.prototype.getDefaultValue = () => {
        if (this.deviceData?.has_humidifier === true && this.deviceData?.has_dehumidifier === true) {
          return this.hap.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER_OR_DEHUMIDIFIER;
        } else if (this.deviceData?.has_humidifier === true) {
          return this.hap.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER;
        } else {
          return this.hap.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER;
        }
      };
    }

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
        return isNaN(this.deviceData.current_temperature) === false ? this.deviceData.current_temperature : null;
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

    // Setup humidifier & dehumidifier service if supported by the thermostat and not already present on the accessory
    if (this.deviceData?.has_humidifier === true || this.deviceData?.has_dehumidifier === true) {
      this.#setupHumidifierDehumidifier(this.deviceData?.has_humidifier, this.deviceData?.has_dehumidifier);
    }
    if (this.deviceData?.has_humidifier === false && this.deviceData?.has_dehumidifier === false) {
      // No longer have a dehumidifier or humidifier configured and service present, so removed it
      this.humidifierDehumidifierService = this.accessory.getService(this.hap.Service.HumidifierDehumidifier);
      if (this.humidifierDehumidifierService !== undefined) {
        this.accessory.removeService(this.humidifierDehumidifierService);
      }
      this.humidifierDehumidifierService = undefined;
    }

    // Setup humidity service if configured to be separate and not already present on the accessory
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
      // No longer have a separate humidity sensor configure and service present, so removed it
      this.humidityService = this.accessory.getService(this.hap.Service.HumiditySensor);
      if (this.humidityService !== undefined) {
        this.accessory.removeService(this.humidityService);
      }
      this.humidityService = undefined;
    }

    // Load external module if configured
    // Supports flexible functions: cool, heat, fan, dehumidifier, humidifier, off
    // This is undocumented as it's for my specific use case
    this.#external = await this.#loadExternalModule(this.deviceData?.external, [
      'cool',
      'heat',
      'fan',
      'dehumidifier',
      'humidifier',
      'off',
    ]);
    if (this.#external !== undefined && Object.keys(this.#external).length > 0) {
      this.postSetupDetail('Using external module with modes ' + Object.keys(this.#external).join(', '));
    } else if (this.#external !== undefined) {
      // Module loaded but provided no valid functions
      this?.log?.warn?.('External module configured but provides no recognised functions');
    }

    // Extra setup details for output
    this.humidityService !== undefined && this.postSetupDetail('Separate humidity sensor');
  }

  onRemove() {
    this.accessory.removeService(this.thermostatService);
    this.accessory.removeService(this.batteryService);
    this.accessory.removeService(this.occupancyService);
    this.accessory.removeService(this.humidityService);
    this.accessory.removeService(this.fanService);
    this.accessory.removeService(this.humidifierDehumidifierService);
    this.thermostatService = undefined;
    this.batteryService = undefined;
    this.occupancyService = undefined;
    this.humidityService = undefined;
    this.fanService = undefined;
    this.humidifierDehumidifierService = undefined;
    this.#external = {};
  }

  onUpdate(deviceData) {
    if (
      typeof deviceData !== 'object' ||
      deviceData?.constructor !== Object ||
      this.thermostatService === undefined ||
      this.batteryService === undefined ||
      this.occupancyService === undefined
    ) {
      return;
    }

    let historyEntry = {};
    let temperatureScale = deviceData.temperature_scale?.toUpperCase?.() === 'F' ? 'F' : 'C';
    let hvacMode = typeof deviceData.hvac_mode === 'string' ? deviceData.hvac_mode.toUpperCase() : 'OFF';
    let previousHvacMode = typeof this.deviceData?.hvac_mode === 'string' ? this.deviceData.hvac_mode.toUpperCase() : 'OFF';
    let hvacState = typeof deviceData.hvac_state === 'string' ? deviceData.hvac_state.toUpperCase() : 'OFF';
    let previousHvacState = typeof this.deviceData?.hvac_state === 'string' ? this.deviceData.hvac_state.toUpperCase() : 'OFF';

    this.thermostatService.updateCharacteristic(
      this.hap.Characteristic.TemperatureDisplayUnits,
      temperatureScale === 'C'
        ? this.hap.Characteristic.TemperatureDisplayUnits.CELSIUS
        : this.hap.Characteristic.TemperatureDisplayUnits.FAHRENHEIT,
    );

    if (deviceData.current_temperature !== undefined) {
      this.thermostatService.updateCharacteristic(this.hap.Characteristic.CurrentTemperature, deviceData.current_temperature);
    }

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
        deviceData.has_air_filter === true && deviceData.filter_replacement_needed === true
          ? this.hap.Characteristic.FilterChangeIndication.CHANGE_FILTER
          : this.hap.Characteristic.FilterChangeIndication.FILTER_OK,
      );
    }

    // Using a temperature sensor as active temperature?
    // Probably not the best way for HomeKit, but works ;-)
    // Maybe a custom characteristic would be better?
    this.thermostatService.updateCharacteristic(this.hap.Characteristic.StatusActive, (deviceData.active_rcs_sensor ?? '') === '');

    // Update battery status
    if (deviceData.battery_level !== undefined) {
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
    }

    // Update for away/home status. Away = no occupancy detected, Home = Occupancy Detected
    this.occupancyService.updateCharacteristic(
      this.hap.Characteristic.OccupancyDetected,
      deviceData.occupancy === true
        ? this.hap.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
        : this.hap.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
    );

    // Update separate humidity sensor if configured to do so
    if (this.humidityService !== undefined && deviceData.current_humidity !== undefined) {
      this.humidityService.updateCharacteristic(this.hap.Characteristic.CurrentRelativeHumidity, deviceData.current_humidity);
    }

    // Update humidity on thermostat
    if (deviceData.current_humidity !== undefined) {
      this.thermostatService.updateCharacteristic(this.hap.Characteristic.CurrentRelativeHumidity, deviceData.current_humidity);
    }

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

    // Check for humidifier/dehumidifier setup change on thermostat
    if (deviceData.has_humidifier !== this.deviceData.has_humidifier || deviceData.has_dehumidifier !== this.deviceData.has_dehumidifier) {
      if (this.humidifierDehumidifierService === undefined) {
        // Service doesn't exist yet, create it if we have at least one capability
        if (deviceData.has_humidifier === true || deviceData.has_dehumidifier === true) {
          this.#setupHumidifierDehumidifier(deviceData.has_humidifier, deviceData.has_dehumidifier);
        }
      } else {
        // Service exists, either adjust props or remove it
        if (deviceData.has_humidifier === true || deviceData.has_dehumidifier === true) {
          // Adjust the validValues based on updated capabilities
          this.humidifierDehumidifierService.getCharacteristic(this.hap.Characteristic.TargetHumidifierDehumidifierState).setProps({
            validValues: [
              deviceData.has_humidifier === true && this.hap.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER,
              deviceData.has_dehumidifier === true && this.hap.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER,
            ].filter(Boolean),
          });
        } else {
          // Both capabilities removed, so remove the service
          this.accessory.removeService(this.humidifierDehumidifierService);
          this.humidifierDehumidifierService = undefined;
        }
      }

      this?.log?.info?.(
        'Humidity control setup on thermostat "%s" has changed: %s',
        deviceData.description,
        [
          deviceData.has_humidifier !== this.deviceData.has_humidifier &&
            'Humidifier ' + (deviceData.has_humidifier === true ? 'added' : 'removed'),
          deviceData.has_dehumidifier !== this.deviceData.has_dehumidifier &&
            'Dehumidifier ' + (deviceData.has_dehumidifier === true ? 'added' : 'removed'),
        ]
          .filter(Boolean)
          .join(', '),
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

    // Update current mode, temperatures and log any changes
    if (deviceData.target_temperature_low !== undefined && deviceData.target_temperature_low !== this.deviceData.target_temperature_low) {
      this.#logTemperatureChange(
        'Thermostat',
        'heating',
        deviceData.target_temperature_low,
        hvacMode.includes('ECO') === true,
        temperatureScale,
      );
    }

    if (
      deviceData.target_temperature_high !== undefined &&
      deviceData.target_temperature_high !== this.deviceData.target_temperature_high
    ) {
      this.#logTemperatureChange(
        'Thermostat',
        'cooling',
        deviceData.target_temperature_high,
        hvacMode.includes('ECO') === true,
        temperatureScale,
      );
    }

    if (hvacMode !== previousHvacMode) {
      this.#logModeChange('Thermostat', deviceData.hvac_mode);
    }

    if (deviceData.can_heat === true && (hvacMode === 'HEAT' || hvacMode === 'ECOHEAT')) {
      // heating mode, either eco or normal
      if (deviceData.target_temperature_low !== undefined) {
        this.thermostatService.updateCharacteristic(this.hap.Characteristic.HeatingThresholdTemperature, deviceData.target_temperature_low);
        this.thermostatService.updateCharacteristic(this.hap.Characteristic.TargetTemperature, deviceData.target_temperature_low);
        historyEntry.target = { low: 0, high: deviceData.target_temperature_low };
      }

      this.thermostatService.updateCharacteristic(
        this.hap.Characteristic.TargetHeatingCoolingState,
        this.hap.Characteristic.TargetHeatingCoolingState.HEAT,
      );
    }

    if (deviceData.can_cool === true && (hvacMode === 'COOL' || hvacMode === 'ECOCOOL')) {
      // cooling mode, either eco or normal
      if (deviceData.target_temperature_high !== undefined) {
        this.thermostatService.updateCharacteristic(
          this.hap.Characteristic.CoolingThresholdTemperature,
          deviceData.target_temperature_high,
        );
        this.thermostatService.updateCharacteristic(this.hap.Characteristic.TargetTemperature, deviceData.target_temperature_high);
        historyEntry.target = { low: deviceData.target_temperature_high, high: 0 };
      }

      this.thermostatService.updateCharacteristic(
        this.hap.Characteristic.TargetHeatingCoolingState,
        this.hap.Characteristic.TargetHeatingCoolingState.COOL,
      );
    }

    if (deviceData.can_cool === true && deviceData.can_heat === true && (hvacMode === 'RANGE' || hvacMode === 'ECORANGE')) {
      // range mode, either eco or normal
      if (deviceData.target_temperature_low !== undefined) {
        this.thermostatService.updateCharacteristic(this.hap.Characteristic.HeatingThresholdTemperature, deviceData.target_temperature_low);
      }
      if (deviceData.target_temperature_high !== undefined) {
        this.thermostatService.updateCharacteristic(
          this.hap.Characteristic.CoolingThresholdTemperature,
          deviceData.target_temperature_high,
        );
      }
      if (deviceData.target_temperature !== undefined) {
        this.thermostatService.updateCharacteristic(this.hap.Characteristic.TargetTemperature, deviceData.target_temperature);
      }

      this.thermostatService.updateCharacteristic(
        this.hap.Characteristic.TargetHeatingCoolingState,
        this.hap.Characteristic.TargetHeatingCoolingState.AUTO,
      );
      historyEntry.target = { low: deviceData.target_temperature_low ?? 0, high: deviceData.target_temperature_high ?? 0 };
    }

    if (deviceData.can_cool === false && deviceData.can_heat === false && hvacMode === 'OFF') {
      // off mode
      if (deviceData.target_temperature !== undefined) {
        this.thermostatService.updateCharacteristic(this.hap.Characteristic.TargetTemperature, deviceData.target_temperature);
      }

      this.thermostatService.updateCharacteristic(
        this.hap.Characteristic.TargetHeatingCoolingState,
        this.hap.Characteristic.TargetHeatingCoolingState.OFF,
      );
      historyEntry.target = { low: 0, high: 0 };
    }

    // Update current state
    if (hvacState === 'HEATING') {
      if (previousHvacState === 'COOLING' && typeof this.#external?.off === 'function') {
        this.#external.off();
      }
      if (
        (previousHvacState !== 'HEATING' || deviceData.target_temperature_low !== this.deviceData.target_temperature_low) &&
        typeof this.#external?.heat === 'function' &&
        deviceData.target_temperature_low !== undefined
      ) {
        this.#external.heat(deviceData.target_temperature_low);
      }
      this.thermostatService.updateCharacteristic(
        this.hap.Characteristic.CurrentHeatingCoolingState,
        this.hap.Characteristic.CurrentHeatingCoolingState.HEAT,
      );
      historyEntry.status = 2;
    }

    if (hvacState === 'COOLING') {
      if (previousHvacState === 'HEATING' && typeof this.#external?.off === 'function') {
        this.#external.off();
      }
      if (
        (previousHvacState !== 'COOLING' || deviceData.target_temperature_high !== this.deviceData.target_temperature_high) &&
        typeof this.#external?.cool === 'function' &&
        deviceData.target_temperature_high !== undefined
      ) {
        this.#external.cool(deviceData.target_temperature_high);
      }
      this.thermostatService.updateCharacteristic(
        this.hap.Characteristic.CurrentHeatingCoolingState,
        this.hap.Characteristic.CurrentHeatingCoolingState.COOL,
      );
      historyEntry.status = 1;
    }

    if (hvacState === 'OFF') {
      if (previousHvacState === 'COOLING' && typeof this.#external?.off === 'function') {
        this.#external.off();
      }
      if (previousHvacState === 'HEATING' && typeof this.#external?.off === 'function') {
        this.#external.off();
      }
      this.thermostatService.updateCharacteristic(
        this.hap.Characteristic.CurrentHeatingCoolingState,
        this.hap.Characteristic.CurrentHeatingCoolingState.OFF,
      );
      historyEntry.status = 0;
    }

    if (this.fanService !== undefined) {
      // fan status on or off
      if (this.deviceData.fan_state === false && deviceData.fan_state === true && typeof this.#external?.fan === 'function') {
        this.#external.fan(0);
      }
      if (this.deviceData.fan_state === true && deviceData.fan_state === false && typeof this.#external?.off === 'function') {
        this.#external.off();
      }

      if (deviceData.fan_max_speed > 1 && deviceData.fan_timer_speed !== undefined) {
        this.fanService.updateCharacteristic(
          this.hap.Characteristic.RotationSpeed,
          deviceData.fan_state === true ? (deviceData.fan_timer_speed / deviceData.fan_max_speed) * 100 : 0,
        );
      }

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

    if (this.humidifierDehumidifierService !== undefined) {
      // humidifier & dehumidifier status on or off
      if (
        this.deviceData.humidifier_state === false &&
        deviceData.humidifier_state === true &&
        typeof this.#external?.humidifier === 'function'
      ) {
        this.#external.humidifier(0);
      }
      if (this.deviceData.humidifier_state === true && deviceData.humidifier_state === false && typeof this.#external?.off === 'function') {
        this.#external.off();
      }
      if (
        this.deviceData.dehumidifier_state === false &&
        deviceData.dehumidifier_state === true &&
        typeof this.#external?.dehumidifier === 'function'
      ) {
        this.#external.dehumidifier(0);
      }
      if (
        this.deviceData.dehumidifier_state === true &&
        deviceData.dehumidifier_state === false &&
        typeof this.#external?.off === 'function'
      ) {
        this.#external.off();
      }

      this.humidifierDehumidifierService.updateCharacteristic(
        this.hap.Characteristic.Active,
        deviceData.humidifier_state === true || deviceData.dehumidifier_state === true
          ? this.hap.Characteristic.Active.ACTIVE
          : this.hap.Characteristic.Active.INACTIVE,
      );

      this.humidifierDehumidifierService.updateCharacteristic(
        this.hap.Characteristic.CurrentHumidifierDehumidifierState,
        deviceData.humidifier_state === true
          ? this.hap.Characteristic.CurrentHumidifierDehumidifierState.HUMIDIFYING
          : deviceData.dehumidifier_state === true
            ? this.hap.Characteristic.CurrentHumidifierDehumidifierState.DEHUMIDIFYING
            : this.hap.Characteristic.CurrentHumidifierDehumidifierState.INACTIVE,
      );

      // Update humidity characteristics if available
      if (
        this.humidifierDehumidifierService.testCharacteristic(this.hap.Characteristic.CurrentRelativeHumidity) === true &&
        deviceData.current_humidity !== undefined
      ) {
        this.humidifierDehumidifierService.updateCharacteristic(
          this.hap.Characteristic.CurrentRelativeHumidity,
          deviceData.current_humidity,
        );
      }
      if (
        this.humidifierDehumidifierService.testCharacteristic(this.hap.Characteristic.RelativeHumidityHumidifierThreshold) === true &&
        deviceData.target_humidity_humidifier !== undefined
      ) {
        this.humidifierDehumidifierService.updateCharacteristic(
          this.hap.Characteristic.RelativeHumidityHumidifierThreshold,
          deviceData.target_humidity_humidifier,
        );
      }
      if (
        this.humidifierDehumidifierService.testCharacteristic(this.hap.Characteristic.RelativeHumidityDehumidifierThreshold) === true &&
        deviceData.target_humidity_dehumidifier !== undefined
      ) {
        this.humidifierDehumidifierService.updateCharacteristic(
          this.hap.Characteristic.RelativeHumidityDehumidifierThreshold,
          deviceData.target_humidity_dehumidifier,
        );
      }

      this.history(this.humidifierDehumidifierService, {
        status: deviceData.humidifier_state === true ? 1 : deviceData.dehumidifier_state === true ? 2 : 0,
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
        this.set({ uuid: this.deviceData.nest_google_device_uuid, vacation_mode: message.vacation.status });
      }

      if (typeof message?.programs === 'object') {
        // Future: convert to Nest format and apply via .set()
        // this.set({ uuid: ..., days: { ... } });
      }
    }
  }

  async setFan(fanState, speed) {
    let currentState = this.fanService.getCharacteristic(this.hap.Characteristic.Active).value;

    // If we have a rotation speed characteristic, use that get the current fan speed, otherwise we use the current fan state to determine
    let currentSpeed =
      this.fanService.testCharacteristic(this.hap.Characteristic.RotationSpeed) === true
        ? this.fanService.getCharacteristic(this.hap.Characteristic.RotationSpeed).value
        : currentState === this.hap.Characteristic.Active.ACTIVE
          ? 100
          : 0;

    if (fanState !== currentState || speed !== currentSpeed) {
      let isActive = fanState === this.hap.Characteristic.Active.ACTIVE;
      let scaledSpeed = Math.round((speed / 100) * this.deviceData.fan_max_speed);

      this.fanService.updateCharacteristic(this.hap.Characteristic.Active, fanState);

      await this.set({
        uuid: this.deviceData.nest_google_device_uuid,
        fan_state: isActive,
        fan_duration: this.deviceData.fan_duration,
        fan_timer_speed: scaledSpeed,
      });

      if (this.fanService.testCharacteristic(this.hap.Characteristic.RotationSpeed) === true) {
        this.fanService.updateCharacteristic(this.hap.Characteristic.RotationSpeed, speed);
      }

      this?.log?.info?.(
        'Set fan on thermostat "%s" to "%s"',
        this.deviceData.description,
        isActive
          ? 'On with fan speed of ' +
              speed +
              '%' +
              (this.deviceData.fan_duration > 0
                ? ' for ' +
                  (Math.floor(this.deviceData.fan_duration / 604800) > 0
                    ? Math.floor(this.deviceData.fan_duration / 604800) +
                      ' wk' +
                      (Math.floor(this.deviceData.fan_duration / 604800) > 1 ? 's ' : ' ')
                    : '') +
                  (Math.floor((this.deviceData.fan_duration % 604800) / 86400) > 0
                    ? Math.floor((this.deviceData.fan_duration % 604800) / 86400) +
                      ' day' +
                      (Math.floor((this.deviceData.fan_duration % 604800) / 86400) > 1 ? 's ' : ' ')
                    : '') +
                  (Math.floor((this.deviceData.fan_duration % 86400) / 3600) > 0
                    ? Math.floor((this.deviceData.fan_duration % 86400) / 3600) +
                      ' hr' +
                      (Math.floor((this.deviceData.fan_duration % 86400) / 3600) > 1 ? 's ' : ' ')
                    : '') +
                  (Math.floor((this.deviceData.fan_duration % 3600) / 60) > 0
                    ? Math.floor((this.deviceData.fan_duration % 3600) / 60) +
                      ' min' +
                      (Math.floor((this.deviceData.fan_duration % 3600) / 60) > 1 ? 's' : '')
                    : '')
                : '')
          : 'Off',
      );
    }
  }

  async setDisplayUnit(temperatureUnit) {
    let unit = temperatureUnit === this.hap.Characteristic.TemperatureDisplayUnits.CELSIUS ? 'C' : 'F';

    this.thermostatService.updateCharacteristic(this.hap.Characteristic.TemperatureDisplayUnits, temperatureUnit);

    await this.set({
      uuid: this.deviceData.nest_google_device_uuid,
      temperature_scale: unit,
    });

    this?.log?.info?.('Set temperature units on thermostat "%s" to "%s"', this.deviceData.description, unit === 'C' ? '°C' : '°F');
  }

  async setMode(thermostatMode) {
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

      await this.set({ uuid: this.deviceData.nest_google_device_uuid, hvac_mode: mode });
      this.#logModeChange('HomeKit', mode);
    }
  }

  getMode() {
    // Determine the current target heating/cooling mode for HomeKit based on Nest hvac_mode.
    // Nest exposes a number of internal states such as ECOHEAT/ECOCOOL/ECORANGE which
    // should map to the same HomeKit modes as their non-eco equivalents.
    //
    // HomeKit only supports the following modes:
    //   OFF, HEAT, COOL, AUTO
    //
    // If the thermostat does not support heating or cooling, we force the mode to OFF.
    let currentMode = null;

    // Normalise hvac_mode to uppercase safely (can occasionally be undefined)
    let mode = this.deviceData.hvac_mode?.toUpperCase?.() ?? 'OFF';

    // Strip ECO prefix from Nest eco modes (ECOHEAT, ECOCOOL, ECORANGE)
    mode = mode.replace(/^ECO/, '');

    if (mode === 'HEAT') {
      // Heating mode
      currentMode = this.hap.Characteristic.TargetHeatingCoolingState.HEAT;
    }

    if (mode === 'COOL') {
      // Cooling mode
      currentMode = this.hap.Characteristic.TargetHeatingCoolingState.COOL;
    }

    if (mode === 'RANGE') {
      // Nest "range" mode means both heating and cooling thresholds are active
      currentMode = this.hap.Characteristic.TargetHeatingCoolingState.AUTO;
    }

    if (mode === 'OFF' || (this.deviceData.can_cool === false && this.deviceData.can_heat === false)) {
      // Thermostat is turned off or does not support heating/cooling
      currentMode = this.hap.Characteristic.TargetHeatingCoolingState.OFF;
    }

    return currentMode;
  }

  async setTemperature(characteristic, temperature) {
    if (typeof characteristic !== 'function' || typeof characteristic?.UUID !== 'string') {
      return;
    }

    let mode = this.thermostatService.getCharacteristic(this.hap.Characteristic.TargetHeatingCoolingState).value;
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

    this.thermostatService.updateCharacteristic(characteristic, temperature);

    if (targetKey !== undefined) {
      // Only set a target temperature if we've determined whicb Nest/Google data key to change
      await this.set({ uuid: this.deviceData.nest_google_device_uuid, [targetKey]: temperature });
      this.#logTemperatureChange(
        'HomeKit',
        modeLabel,
        temperature,
        this.deviceData.hvac_mode?.toUpperCase?.().includes('ECO') === true,
        this.deviceData.temperature_scale?.toUpperCase?.() === 'F' ? 'F' : 'C',
      );
    }
  }

  getTemperature(characteristic) {
    // Return the correct temperature value for the requested HomeKit characteristic.
    // Nest exposes three temperature targets:
    //   target_temperature        -> single heat/cool mode
    //   target_temperature_low    -> heating threshold (range mode)
    //   target_temperature_high   -> cooling threshold (range mode)
    //
    // HomeKit queries different characteristics depending on the thermostat mode,
    // so we return the appropriate value and fallback where needed.
    if (typeof characteristic !== 'function' || typeof characteristic?.UUID !== 'string') {
      return null;
    }

    let currentTemperature = {
      // HomeKit TargetTemperature is used in HEAT or COOL modes.
      // If not present, fallback to either threshold temperature.
      [this.hap.Characteristic.TargetTemperature.UUID]:
        this.deviceData.target_temperature ?? this.deviceData.target_temperature_low ?? this.deviceData.target_temperature_high,

      // Heating threshold used in AUTO/RANGE mode.
      // Fallback to target_temperature if Nest did not provide a low value.
      [this.hap.Characteristic.HeatingThresholdTemperature.UUID]:
        this.deviceData.target_temperature_low ?? this.deviceData.target_temperature,

      // Cooling threshold used in AUTO/RANGE mode.
      // Fallback to target_temperature if Nest did not provide a high value.
      [this.hap.Characteristic.CoolingThresholdTemperature.UUID]:
        this.deviceData.target_temperature_high ?? this.deviceData.target_temperature,
    }[characteristic.UUID];

    // HomeKit requires a finite numeric value or null
    if (isNaN(currentTemperature) === true) {
      return null;
    }

    // Clamp temperature to HomeKit supported range
    currentTemperature = Math.min(Math.max(Number(currentTemperature), THERMOSTAT_MIN_TEMPERATURE), THERMOSTAT_MAX_TEMPERATURE);

    return currentTemperature;
  }

  setChildlock(pin, value) {
    this.thermostatService.updateCharacteristic(this.hap.Characteristic.LockPhysicalControls, value); // Update HomeKit with value
    if (value === this.hap.Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED) {
      // TODO - Implement PIN setting when API supports it
      // Would need: temperature_lock_pin_hash = SHA-1(pin + serialNumber) base64
      // Example code to calculate PIN hash:
      // const crypto = require('crypto');
      // if (typeof pin === 'string' && pin.length > 0 && pin.length <= 4 && typeof this.deviceData?.serialnumber === 'string') {
      //   const combined = pin + this.deviceData.serialnumber;
      //   const pinHash = crypto.createHash('sha1').update(combined).digest('base64');
      //   await this.set({
      //     uuid: this.deviceData.nest_google_device_uuid,
      //     temperature_lock: true,
      //     temperature_lock_pin_hash: pinHash
      //   });
      // }
    }
    if (value === this.hap.Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED) {
      // Clear PIN when disabling child lock
    }
    this.set({
      uuid: this.deviceData.nest_google_device_uuid,
      temperature_lock: value === this.hap.Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED ? true : false,
    });

    this?.log?.info?.(
      'Setting Childlock on "%s" to "%s"',
      this.deviceData.description,
      value === this.hap.Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED ? 'Enabled' : 'Disabled',
    );
  }

  async setHumidifierDehumidifierMode(state, mode) {
    if (this.humidifierDehumidifierService === undefined) {
      return;
    }

    let isActive = state === this.hap.Characteristic.Active.ACTIVE || state === true;
    let humidifier_state = false;
    let dehumidifier_state = false;
    let modeName = 'humidifier/dehumidifier';

    if (mode === this.hap.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER) {
      humidifier_state = isActive === true;
      modeName = 'humidifier';
    }

    if (mode === this.hap.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER) {
      dehumidifier_state = isActive === true;
      modeName = 'dehumidifier';
    }

    if (mode === this.hap.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER_OR_DEHUMIDIFIER) {
      humidifier_state = isActive === true;
      dehumidifier_state = isActive === true;
      modeName = 'humidifier/dehumidifier';
    }

    // Update HomeKit characteristics
    this.humidifierDehumidifierService.updateCharacteristic(
      this.hap.Characteristic.Active,
      isActive === true ? this.hap.Characteristic.Active.ACTIVE : this.hap.Characteristic.Active.INACTIVE,
    );
    this.humidifierDehumidifierService.updateCharacteristic(this.hap.Characteristic.TargetHumidifierDehumidifierState, mode);

    if (this.deviceData.has_humidifier === true) {
      await this.set({
        uuid: this.deviceData.nest_google_device_uuid,
        humidifier_state: humidifier_state === true,
        target_humidity_humidifier: this.deviceData.target_humidity_humidifier,
      });
    }

    if (this.deviceData.has_dehumidifier === true) {
      await this.set({
        uuid: this.deviceData.nest_google_device_uuid,
        dehumidifier_state: dehumidifier_state === true,
        target_humidity_dehumidifier: this.deviceData.target_humidity_dehumidifier,
      });
    }

    let statusText =
      isActive === true
        ? mode === this.hap.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER
          ? '"On" with target humidity level of ' + Math.round(this.deviceData.target_humidity_humidifier) + '%'
          : mode === this.hap.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER
            ? '"On" with target humidity level of ' + Math.round(this.deviceData.target_humidity_dehumidifier) + '%'
            : '"On" with humidity range of ' +
              Math.round(this.deviceData.target_humidity_humidifier) +
              '% to ' +
              Math.round(this.deviceData.target_humidity_dehumidifier) +
              '%'
        : '"Off"';

    this?.log?.info?.('Set %s on thermostat "%s" to %s', modeName, this.deviceData.description, statusText);
  }

  async setHumidifierDehumidifierThreshold(characteristic, value) {
    if (
      typeof characteristic !== 'function' ||
      typeof characteristic?.UUID !== 'string' ||
      this.humidifierDehumidifierService === undefined ||
      isNaN(value) === true
    ) {
      return;
    }

    value = Number(value); // Ensure value is a number

    if (
      characteristic.UUID === this.hap.Characteristic.RelativeHumidityHumidifierThreshold.UUID &&
      this.deviceData.has_humidifier === true
    ) {
      this.humidifierDehumidifierService.updateCharacteristic(this.hap.Characteristic.RelativeHumidityHumidifierThreshold, value);

      await this.set({
        uuid: this.deviceData.nest_google_device_uuid,
        target_humidity_humidifier: value,
      });

      this?.log?.info?.('Set humidifier target humidity on thermostat "%s" to "%s%%"', this.deviceData.description, Math.round(value));
    }

    if (
      characteristic.UUID === this.hap.Characteristic.RelativeHumidityDehumidifierThreshold.UUID &&
      this.deviceData.has_dehumidifier === true
    ) {
      this.humidifierDehumidifierService.updateCharacteristic(this.hap.Characteristic.RelativeHumidityDehumidifierThreshold, value);

      await this.set({
        uuid: this.deviceData.nest_google_device_uuid,
        target_humidity_dehumidifier: value,
      });

      this?.log?.info?.('Set dehumidifier target humidity on thermostat "%s" to "%s%%"', this.deviceData.description, Math.round(value));
    }
  }

  #setupFan() {
    this.fanService = this.addHKService(this.hap.Service.Fanv2, '', 1);
    this.thermostatService.addLinkedService(this.fanService);

    this.addHKCharacteristic(this.fanService, this.hap.Characteristic.Active, {
      onSet: (value) =>
        this.setFan(
          value,
          value === this.hap.Characteristic.Active.ACTIVE ? (this.deviceData.fan_timer_speed / this.deviceData.fan_max_speed) * 100 : 0,
        ),
      onGet: () => {
        return this.deviceData.fan_state === true ? this.hap.Characteristic.Active.ACTIVE : this.hap.Characteristic.Active.INACTIVE;
      },
    });

    if (this.deviceData.fan_max_speed > 1) {
      this.addHKCharacteristic(this.fanService, this.hap.Characteristic.RotationSpeed, {
        props: { minStep: 100 / this.deviceData.fan_max_speed },
        onSet: (value) => this.setFan(value !== 0 ? this.hap.Characteristic.Active.ACTIVE : this.hap.Characteristic.Active.INACTIVE, value),
        onGet: () => {
          return this.deviceData.fan_state === true ? (this.deviceData.fan_timer_speed / this.deviceData.fan_max_speed) * 100 : 0;
        },
      });
    } else {
      // No rotation speed setting as we only support a single fan speed
      this.fanService.removeCharacteristic(this.hap.Characteristic.RotationSpeed);
    }
  }

  #setupHumidifierDehumidifier(hasHumidifier, hasDehumidifier) {
    this.humidifierDehumidifierService = this.addHKService(this.hap.Service.HumidifierDehumidifier, '', 1);
    this.thermostatService.addLinkedService(this.humidifierDehumidifierService);

    this.addHKCharacteristic(this.humidifierDehumidifierService, this.hap.Characteristic.Active, {
      onSet: (value) =>
        this.setHumidifierDehumidifierMode(
          value,
          this.humidifierDehumidifierService.getCharacteristic(this.hap.Characteristic.TargetHumidifierDehumidifierState).value,
        ),
      onGet: () => {
        return this.deviceData.humidifier_enabled === true || this.deviceData.dehumidifier_enabled === true
          ? this.hap.Characteristic.Active.ACTIVE
          : this.hap.Characteristic.Active.INACTIVE;
      },
    });

    this.addHKCharacteristic(this.humidifierDehumidifierService, this.hap.Characteristic.CurrentHumidifierDehumidifierState, {
      onGet: () => {
        if (this.deviceData.humidifier_state === true) {
          return this.hap.Characteristic.CurrentHumidifierDehumidifierState.HUMIDIFYING;
        }
        if (this.deviceData.dehumidifier_state === true) {
          return this.hap.Characteristic.CurrentHumidifierDehumidifierState.DEHUMIDIFYING;
        }

        return this.hap.Characteristic.CurrentHumidifierDehumidifierState.IDLE;
      },
    });

    this.addHKCharacteristic(this.humidifierDehumidifierService, this.hap.Characteristic.TargetHumidifierDehumidifierState, {
      props: {
        validValues: [
          hasHumidifier === true &&
            hasDehumidifier === true &&
            this.hap.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER_OR_DEHUMIDIFIER,
          hasHumidifier === true && this.hap.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER,
          hasDehumidifier === true && this.hap.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER,
        ].filter(Boolean),
      },
      onSet: (value) =>
        this.setHumidifierDehumidifierMode(
          this.humidifierDehumidifierService.getCharacteristic(this.hap.Characteristic.Active).value,
          value,
        ),
      onGet: () => {
        let target_mode = this.hap.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER_OR_DEHUMIDIFIER;
        if (this.deviceData.humidifier_state === true && this.deviceData.dehumidifier_state === false) {
          target_mode = this.hap.Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER;
        }
        if (this.deviceData.dehumidifier_state === true && this.deviceData.humidifier_state === false) {
          target_mode = this.hap.Characteristic.TargetHumidifierDehumidifierState.DEHUMIDIFIER;
        }

        return target_mode;
      },
    });

    if (hasHumidifier === true) {
      this.addHKCharacteristic(this.humidifierDehumidifierService, this.hap.Characteristic.RelativeHumidityHumidifierThreshold, {
        onSet: (value) => {
          this.setHumidifierDehumidifierThreshold(this.hap.Characteristic.RelativeHumidityHumidifierThreshold, value);
        },
        onGet: () => {
          return this.deviceData.target_humidity_humidifier;
        },
      });
    }

    if (hasDehumidifier === true) {
      this.addHKCharacteristic(this.humidifierDehumidifierService, this.hap.Characteristic.RelativeHumidityDehumidifierThreshold, {
        onSet: (value) => {
          this.setHumidifierDehumidifierThreshold(this.hap.Characteristic.RelativeHumidityDehumidifierThreshold, value);
        },
        onGet: () => {
          return this.deviceData.target_humidity_dehumidifier;
        },
      });
    }

    this.addHKCharacteristic(this.humidifierDehumidifierService, this.hap.Characteristic.CurrentRelativeHumidity, {
      onGet: () => {
        return this.deviceData.current_humidity;
      },
    });
  }

  async #loadExternalModule(module, expectedFunctions = []) {
    if (typeof module !== 'string' || module === '' || Array.isArray(expectedFunctions) === false) {
      return undefined;
    }

    // Helper to resolve a module path, defaulting to plugin dir and falling back from .mjs to .js
    const resolveModulePath = async (basePath) => {
      let isRelative = basePath.startsWith('./') === true || basePath.startsWith('../') === true;
      let isAbsolute = path.isAbsolute(basePath) === true;
      let resolvedBase = isAbsolute === true ? basePath : isRelative === true ? path.resolve(basePath) : path.resolve(__dirname, basePath);
      let finalPath = resolvedBase;

      if (path.extname(basePath) === '') {
        let mjsPath = resolvedBase + '.mjs';
        let jsPath = resolvedBase + '.js';

        try {
          await fs.access(mjsPath);
          finalPath = mjsPath;
        } catch {
          try {
            await fs.access(jsPath);
            finalPath = jsPath;
          } catch {
            finalPath = mjsPath;
          }
        }
      }

      return finalPath;
    };

    let loadedModule = undefined;

    try {
      let values = module.match(/"[^"]*"|'[^']*'|[^\s]+/g)?.map((value) => value.replace(/^["'](.*)["']$/, '$1')) || [];
      let modulePath = await resolveModulePath(values[0]);
      let externalModule = await import(pathToFileURL(modulePath).href);

      if (typeof externalModule?.default === 'function') {
        let moduleExports = externalModule.default(this.log, [values[1], this.deviceData.description, ...values.slice(2)]);
        loadedModule = Object.fromEntries(
          expectedFunctions.filter((fn) => typeof moduleExports?.[fn] === 'function').map((fn) => [fn, moduleExports[fn]]),
        );

        if (Object.keys(loadedModule).length === 0) {
          loadedModule = undefined;
        }
      }
      // eslint-disable-next-line no-unused-vars
    } catch (error) {
      let shortName =
        typeof module === 'string'
          ? module
              .trim()
              .match(/"[^"]*"|'[^']*'|[^\s]+/)?.[0]
              ?.replace(/^["'](.*)["']$/, '$1')
          : '';
      this?.log?.warn?.('Failed to load external module "%s" for thermostat "%s"', shortName, this.deviceData.description);
    }

    return loadedModule;
  }

  #logTemperatureChange(source, modeLabel, temperature, isEco, scale) {
    if (typeof temperature !== 'number') {
      return;
    }

    let unitScale = typeof scale === 'string' ? scale.toUpperCase() : this.deviceData.temperature_scale?.toUpperCase?.();
    let isFahrenheit = unitScale === 'F';
    let tempDisplay = (isFahrenheit ? (temperature * 9) / 5 + 32 : temperature).toFixed(1);
    let tempUnit = isFahrenheit ? '°F' : '°C';
    let ecoPrefix = isEco === true ? 'eco mode ' : '';

    modeLabel = modeLabel.charAt(0).toUpperCase() + modeLabel.slice(1).toLowerCase();

    if (source === 'Thermostat') {
      this?.log?.debug?.(
        '%s%s temperature on "%s" changed to "%s %s"',
        ecoPrefix,
        modeLabel,
        this.deviceData.description,
        tempDisplay,
        tempUnit,
      );
    } else {
      this?.log?.info?.(
        'Set %s%s temperature on "%s" to "%s %s"',
        ecoPrefix,
        modeLabel,
        this.deviceData.description,
        tempDisplay,
        tempUnit,
      );
    }
  }

  #logModeChange(source, modeLabel) {
    if (typeof modeLabel !== 'string' || modeLabel.trim() === '') {
      return;
    }

    modeLabel = modeLabel.charAt(0).toUpperCase() + modeLabel.slice(1).toLowerCase();

    if (source === 'Thermostat') {
      this?.log?.debug?.(
        'Mode on "%s" changed to "%s"',
        this.deviceData.description,
        modeLabel.toLowerCase().includes('range') === true ? 'Heat/Cool' : modeLabel,
      );
    } else {
      this?.log?.info?.(
        'Set mode on "%s" to "%s"',
        this.deviceData.description,
        modeLabel.toLowerCase().includes('range') === true ? 'Heat/Cool' : modeLabel,
      );
    }
  }
}

// Data translation functions for thermostat data.
// We use this to translate RAW Nest and Google data into the format we want for our
// thermostat device(s) using the field map below.
//
// This keeps all translation logic in one place and makes it easier to maintain as
// Nest and Google sources evolve over time.
//
// Field map conventions:
// - Return undefined for missing values rather than placeholder defaults
// - processRawData() determines if enough data exists to build the device
// - Optional fields may remain undefined
//
// Thermostat field translation map
const THERMOSTAT_FIELD_MAP = {
  // Identity fields
  serialNumber: {
    google: ({ sourceValue }) =>
      typeof sourceValue?.value?.device_identity?.serialNumber === 'string' && sourceValue.value.device_identity.serialNumber.trim() !== ''
        ? sourceValue.value.device_identity.serialNumber
        : undefined,
    nest: ({ sourceValue }) =>
      typeof sourceValue?.value?.serial_number === 'string' && sourceValue.value.serial_number.trim() !== ''
        ? sourceValue.value.serial_number
        : undefined,
  },

  nest_google_device_uuid: {
    google: ({ objectKey }) => objectKey,
    nest: ({ objectKey }) => objectKey,
  },

  nest_google_home_uuid: {
    google: ({ sourceValue }) => sourceValue?.value?.device_info?.pairerId?.resourceId,
    nest: ({ rawData, sourceValue }) => rawData?.['link.' + sourceValue?.value?.serial_number]?.value?.structure,
  },

  // Naming / descriptive fields
  model: {
    google: ({ sourceValue }) => {
      let typeName = sourceValue?.value?.device_info?.typeName ?? '';

      if (typeName === 'nest.resource.NestLearningThermostat1Resource') {
        return 'Learning Thermostat (1st gen)';
      }
      if (typeName === 'nest.resource.NestLearningThermostat2Resource' || typeName === 'nest.resource.NestAmber1DisplayResource') {
        return 'Learning Thermostat (2nd gen)';
      }
      if (
        typeName === 'nest.resource.NestLearningThermostat3Resource' ||
        typeName === 'nest.resource.NestLearningThermostat3v2Resource' ||
        typeName === 'nest.resource.NestAmber2DisplayResource'
      ) {
        return 'Learning Thermostat (3rd gen)';
      }
      if (typeName === 'google.resource.GoogleBismuth1Resource') {
        return 'Learning Thermostat (4th gen)';
      }
      if (typeName === 'nest.resource.NestOnyxResource' || typeName === 'nest.resource.NestAgateDisplayResource') {
        return 'Thermostat E (1st gen)';
      }
      if (typeName === 'google.resource.GoogleZirconium1Resource') {
        return 'Thermostat (2020)';
      }

      return 'Thermostat (unknown)';
    },

    nest: ({ sourceValue }) => {
      let serial = sourceValue?.value?.serial_number ?? '';

      if (serial.substring(0, 2) === '15') {
        return 'Thermostat E (1st gen)';
      }
      if (serial.substring(0, 2) === '09' || serial.substring(0, 2) === '10') {
        return 'Learning Thermostat (3rd gen)';
      }
      if (serial.substring(0, 2) === '02') {
        return 'Learning Thermostat (2nd gen)';
      }
      if (serial.substring(0, 2) === '01') {
        return 'Learning Thermostat (1st gen)';
      }

      return 'Thermostat (unknown)';
    },
  },

  softwareVersion: {
    google: ({ sourceValue }) => sourceValue?.value?.device_identity?.softwareVersion,
    nest: ({ sourceValue }) => sourceValue?.value?.current_version,
  },

  description: {
    google: ({ sourceValue }) => String(sourceValue?.value?.label?.label ?? ''),
    nest: ({ rawData, sourceValue }) => String(rawData?.['shared.' + sourceValue?.value?.serial_number]?.value?.name ?? ''),
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
    nest: ({ rawData, sourceValue }) =>
      String(
        rawData?.[
          'where.' + rawData?.['link.' + sourceValue?.value?.serial_number]?.value?.structure?.split?.('.')[1]
        ]?.value?.wheres?.find((where) => where?.where_id === sourceValue?.value?.where_id)?.name ?? '',
      ),
  },

  // Core environmental / status fields
  current_humidity: {
    google: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.current_humidity?.humidityValue?.humidity?.value) === false
        ? Number(sourceValue.value.current_humidity.humidityValue.humidity.value)
        : undefined,
    nest: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.current_humidity) === false ? Number(sourceValue.value.current_humidity) : undefined,
  },

  temperature_scale: {
    google: ({ sourceValue }) => (sourceValue?.value?.display_settings?.temperatureScale === 'TEMPERATURE_SCALE_F' ? 'F' : 'C'),
    nest: ({ sourceValue }) => (sourceValue?.value?.temperature_scale?.toUpperCase?.() === 'F' ? 'F' : 'C'),
  },

  removed_from_base: {
    google: ({ sourceValue }) =>
      Array.isArray(sourceValue?.value?.display?.thermostatState) === true &&
      sourceValue.value.display.thermostatState.includes('bpd') === true,
    nest: ({ sourceValue }) => sourceValue?.value?.nlclient_state?.toUpperCase?.() === 'BPD',
  },

  backplate_temperature: {
    google: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.backplate_temperature?.temperatureValue?.temperature?.value) === false
        ? adjustTemperature(Number(sourceValue.value.backplate_temperature.temperatureValue.temperature.value), 'C', 'C', true)
        : undefined,
    nest: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.backplate_temperature) === false
        ? adjustTemperature(Number(sourceValue.value.backplate_temperature), 'C', 'C', true)
        : undefined,
  },

  current_temperature: {
    google: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.current_temperature?.temperatureValue?.temperature?.value) === false
        ? adjustTemperature(Number(sourceValue.value.current_temperature.temperatureValue.temperature.value), 'C', 'C', true)
        : undefined,
    nest: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.backplate_temperature) === false
        ? adjustTemperature(Number(sourceValue.value.backplate_temperature), 'C', 'C', true)
        : undefined,
  },

  battery_level: {
    google: ({ sourceValue }) => {
      let voltage =
        isNaN(sourceValue?.value?.battery_voltage?.batteryValue?.batteryVoltage?.value) === false
          ? Number(sourceValue.value.battery_voltage.batteryValue.batteryVoltage.value)
          : undefined;

      if (voltage === undefined) {
        return undefined;
      }

      // Lower battery voltages for the "2020" mirror thermostat. Levels are a guestimate.
      if (sourceValue?.value?.device_info?.typeName === 'google.resource.GoogleZirconium1Resource') {
        return scaleValue(voltage, 2.9, 3.2, 0, 100);
      }

      return scaleValue(voltage, 3.6, 4.0, 0, 100);
    },

    nest: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.battery_level) === false
        ? scaleValue(Number(sourceValue.value.battery_level), 3.6, 4.0, 0, 100)
        : undefined,
  },

  online: {
    google: ({ sourceValue }) => sourceValue?.value?.liveness?.status === 'LIVENESS_DEVICE_STATUS_ONLINE',
    nest: ({ rawData, sourceValue }) => rawData?.['track.' + sourceValue?.value?.serial_number]?.value?.online === true,
  },

  leaf: {
    google: ({ sourceValue }) => sourceValue?.value?.leaf?.active === true,
    nest: ({ sourceValue }) => sourceValue?.value?.leaf === true,
  },

  can_cool: {
    google: ({ sourceValue }) =>
      sourceValue?.value?.hvac_equipment_capabilities?.hasStage1Cool === true ||
      sourceValue?.value?.hvac_equipment_capabilities?.hasStage2Cool === true ||
      sourceValue?.value?.hvac_equipment_capabilities?.hasStage3Cool === true,
    nest: ({ rawData, sourceValue }) => rawData?.['shared.' + sourceValue?.value?.serial_number]?.value?.can_cool === true,
  },

  can_heat: {
    google: ({ sourceValue }) =>
      sourceValue?.value?.hvac_equipment_capabilities?.hasStage1Heat === true ||
      sourceValue?.value?.hvac_equipment_capabilities?.hasStage2Heat === true ||
      sourceValue?.value?.hvac_equipment_capabilities?.hasStage3Heat === true,
    nest: ({ rawData, sourceValue }) => rawData?.['shared.' + sourceValue?.value?.serial_number]?.value?.can_heat === true,
  },

  temperature_lock: {
    google: ({ sourceValue }) => sourceValue?.value?.temperature_lock_settings?.enabled === true,
    nest: ({ sourceValue }) => sourceValue?.value?.temperature_lock === true,
  },

  temperature_lock_pin_hash: {
    google: ({ sourceValue }) =>
      sourceValue?.value?.temperature_lock_settings?.enabled === true ? sourceValue.value.temperature_lock_settings.pinHash : '',
    nest: ({ sourceValue }) =>
      typeof sourceValue?.value?.temperature_lock_pin_hash === 'string' ? sourceValue.value.temperature_lock_pin_hash : '',
  },

  away: {
    google: ({ sourceValue }) => sourceValue?.value?.structure_mode?.structureMode === 'STRUCTURE_MODE_AWAY',
    nest: ({ rawData, sourceValue }) =>
      rawData?.[rawData?.['link.' + sourceValue?.value?.serial_number]?.value?.structure]?.value?.away === true,
  },

  occupancy: {
    google: ({ sourceValue }) => sourceValue?.value?.structure_mode?.structureMode === 'STRUCTURE_MODE_HOME',
    nest: ({ rawData, sourceValue }) =>
      rawData?.[rawData?.['link.' + sourceValue?.value?.serial_number]?.value?.structure]?.value?.away === false,
  },

  vacation_mode: {
    google: ({ sourceValue }) => sourceValue?.value?.structure_mode?.structureMode === 'STRUCTURE_MODE_VACATION',
    nest: ({ rawData, sourceValue }) =>
      rawData?.[rawData?.['link.' + sourceValue?.value?.serial_number]?.value?.structure]?.value?.vacation_mode === true,
  },

  has_humidifier: {
    google: ({ sourceValue }) => sourceValue?.value?.hvac_equipment_capabilities?.hasHumidifier === true,
    nest: ({ sourceValue }) => sourceValue?.value?.has_humidifier === true,
  },

  has_dehumidifier: {
    google: ({ sourceValue }) => sourceValue?.value?.hvac_equipment_capabilities?.hasDehumidifier === true,
    nest: ({ sourceValue }) => sourceValue?.value?.has_dehumidifier === true,
  },

  has_fan: {
    google: ({ sourceValue }) =>
      typeof sourceValue?.value?.fan_control_capabilities?.maxAvailableSpeed === 'string' &&
      sourceValue.value.fan_control_capabilities.maxAvailableSpeed !== 'FAN_SPEED_SETTING_OFF',
    nest: ({ sourceValue }) => sourceValue?.value?.has_fan === true,
  },

  fan_state: {
    google: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.fan_control_settings?.timerEnd?.seconds) === false &&
      Number(sourceValue.value.fan_control_settings.timerEnd.seconds) > 0,
    nest: ({ sourceValue }) => isNaN(sourceValue?.value?.fan_timer_timeout) === false && Number(sourceValue.value.fan_timer_timeout) > 0,
  },

  fan_timer_speed: {
    google: ({ sourceValue }) =>
      sourceValue?.value?.fan_control_settings?.timerSpeed?.includes?.('FAN_SPEED_SETTING_STAGE') === true &&
      isNaN(sourceValue.value.fan_control_settings.timerSpeed.split('FAN_SPEED_SETTING_STAGE')[1]) === false
        ? Number(sourceValue.value.fan_control_settings.timerSpeed.split('FAN_SPEED_SETTING_STAGE')[1])
        : undefined,
    nest: ({ sourceValue }) =>
      sourceValue?.value?.fan_timer_speed?.includes?.('stage') === true &&
      isNaN(sourceValue.value.fan_timer_speed.split('stage')[1]) === false
        ? Number(sourceValue.value.fan_timer_speed.split('stage')[1])
        : undefined,
  },

  fan_max_speed: {
    google: ({ sourceValue }) =>
      sourceValue?.value?.fan_control_capabilities?.maxAvailableSpeed?.includes?.('FAN_SPEED_SETTING_STAGE') === true &&
      isNaN(sourceValue.value.fan_control_capabilities.maxAvailableSpeed.split('FAN_SPEED_SETTING_STAGE')[1]) === false
        ? Number(sourceValue.value.fan_control_capabilities.maxAvailableSpeed.split('FAN_SPEED_SETTING_STAGE')[1])
        : undefined,
    nest: ({ sourceValue }) =>
      sourceValue?.value?.fan_capabilities?.includes?.('stage') === true &&
      isNaN(sourceValue.value.fan_capabilities.split('stage')[1]) === false
        ? Number(sourceValue.value.fan_capabilities.split('stage')[1])
        : undefined,
  },

  fan_duration: {
    google: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.fan_control_settings?.timerDuration?.seconds) === false
        ? Number(sourceValue.value.fan_control_settings.timerDuration.seconds)
        : undefined,
    nest: ({ sourceValue }) => (isNaN(sourceValue?.value?.fan_duration) === false ? Number(sourceValue.value.fan_duration) : undefined),
  },

  target_humidity_humidifier: {
    google: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.humidity_control_settings?.humidifierTargetHumidity?.value) === false
        ? Number(sourceValue.value.humidity_control_settings.humidifierTargetHumidity.value)
        : undefined,
    nest: () => undefined,
  },

  target_humidity_dehumidifier: {
    google: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.humidity_control_settings?.dehumidifierTargetHumidity?.value) === false
        ? Number(sourceValue.value.humidity_control_settings.dehumidifierTargetHumidity.value)
        : undefined,
    nest: () => undefined,
  },

  target_humidity: {
    nest: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.target_humidity) === false ? Number(sourceValue.value.target_humidity) : undefined,
  },

  humidifier_state: {
    google: ({ sourceValue }) => sourceValue?.value?.hvac_control?.hvacState?.humidifierActive === true,
    nest: ({ sourceValue }) => sourceValue?.value?.humidifier_state === true,
  },

  dehumidifier_state: {
    google: ({ sourceValue }) => sourceValue?.value?.hvac_control?.hvacState?.dehumidifierActive === true,
    nest: ({ sourceValue }) => sourceValue?.value?.dehumidifier_state === true,
  },

  has_air_filter: {
    google: ({ sourceValue }) => sourceValue?.value?.hvac_equipment_capabilities?.hasAirFilter === true,
    nest: ({ sourceValue }) => sourceValue?.value?.has_air_filter === true,
  },

  filter_replacement_needed: {
    google: ({ sourceValue }) => sourceValue?.value?.filter_reminder?.filterReplacementNeeded?.value === true,
    nest: ({ sourceValue }) => sourceValue?.value?.filter_replacement_needed === true,
  },

  // HVAC mode / setpoint fields
  hvac_mode: {
    google: ({ sourceValue }) => {
      let mode =
        sourceValue?.value?.target_temperature_settings?.enabled?.value === true &&
        sourceValue?.value?.target_temperature_settings?.targetTemperature?.setpointType !== undefined
          ? sourceValue.value.target_temperature_settings.targetTemperature.setpointType.split('SET_POINT_TYPE_')[1].toLowerCase()
          : 'off';

      if (sourceValue?.value?.eco_mode_state?.ecoMode !== 'ECO_MODE_INACTIVE') {
        if (
          sourceValue?.value?.eco_mode_settings?.ecoTemperatureHeat?.enabled === true &&
          sourceValue?.value?.eco_mode_settings?.ecoTemperatureCool?.enabled === false
        ) {
          return 'ecoheat';
        }
        if (
          sourceValue?.value?.eco_mode_settings?.ecoTemperatureHeat?.enabled === false &&
          sourceValue?.value?.eco_mode_settings?.ecoTemperatureCool?.enabled === true
        ) {
          return 'ecocool';
        }
        if (
          sourceValue?.value?.eco_mode_settings?.ecoTemperatureHeat?.enabled === true &&
          sourceValue?.value?.eco_mode_settings?.ecoTemperatureCool?.enabled === true
        ) {
          return 'ecorange';
        }
      }

      return mode;
    },

    nest: ({ rawData, sourceValue }) => {
      let mode =
        rawData?.['shared.' + sourceValue?.value?.serial_number]?.value?.target_temperature_type !== undefined
          ? rawData['shared.' + sourceValue.value.serial_number].value.target_temperature_type
          : 'off';

      if (
        sourceValue?.value?.eco?.mode?.toUpperCase?.() === 'AUTO-ECO' ||
        sourceValue?.value?.eco?.mode?.toUpperCase?.() === 'MANUAL-ECO'
      ) {
        if (sourceValue?.value?.away_temperature_low_enabled === true && sourceValue?.value?.away_temperature_high_enabled === false) {
          return 'ecoheat';
        }
        if (sourceValue?.value?.away_temperature_high_enabled === true && sourceValue?.value?.away_temperature_low_enabled === false) {
          return 'ecocool';
        }
        if (sourceValue?.value?.away_temperature_high_enabled === true && sourceValue?.value?.away_temperature_low_enabled === true) {
          return 'ecorange';
        }
      }

      return mode;
    },
  },

  target_temperature_low: {
    google: ({ sourceValue }) => {
      let value;

      if (isNaN(sourceValue?.value?.target_temperature_settings?.targetTemperature?.heatingTarget?.value) === false) {
        value = Number(sourceValue.value.target_temperature_settings.targetTemperature.heatingTarget.value);
      }

      if (sourceValue?.value?.eco_mode_state?.ecoMode !== 'ECO_MODE_INACTIVE') {
        if (isNaN(sourceValue?.value?.eco_mode_settings?.ecoTemperatureHeat?.value?.value) === false) {
          value = Number(sourceValue.value.eco_mode_settings.ecoTemperatureHeat.value.value);
        }
      }

      return value !== undefined ? adjustTemperature(value, 'C', 'C', true) : undefined;
    },

    nest: ({ rawData, sourceValue }) => {
      let value;

      if (isNaN(rawData?.['shared.' + sourceValue?.value?.serial_number]?.value?.target_temperature_low) === false) {
        value = Number(rawData['shared.' + sourceValue.value.serial_number].value.target_temperature_low);
      }

      if (
        sourceValue?.value?.eco?.mode?.toUpperCase?.() === 'AUTO-ECO' ||
        sourceValue?.value?.eco?.mode?.toUpperCase?.() === 'MANUAL-ECO'
      ) {
        if (isNaN(sourceValue?.value?.away_temperature_low) === false) {
          value = Number(sourceValue.value.away_temperature_low);
        }
      }

      return value !== undefined ? adjustTemperature(value, 'C', 'C', true) : undefined;
    },
  },

  target_temperature_high: {
    google: ({ sourceValue }) => {
      let value;

      if (isNaN(sourceValue?.value?.target_temperature_settings?.targetTemperature?.coolingTarget?.value) === false) {
        value = Number(sourceValue.value.target_temperature_settings.targetTemperature.coolingTarget.value);
      }

      if (sourceValue?.value?.eco_mode_state?.ecoMode !== 'ECO_MODE_INACTIVE') {
        if (isNaN(sourceValue?.value?.eco_mode_settings?.ecoTemperatureCool?.value?.value) === false) {
          value = Number(sourceValue.value.eco_mode_settings.ecoTemperatureCool.value.value);
        }
      }

      return value !== undefined ? adjustTemperature(value, 'C', 'C', true) : undefined;
    },

    nest: ({ rawData, sourceValue }) => {
      let value;

      if (isNaN(rawData?.['shared.' + sourceValue?.value?.serial_number]?.value?.target_temperature_high) === false) {
        value = Number(rawData['shared.' + sourceValue.value.serial_number].value.target_temperature_high);
      }

      if (
        sourceValue?.value?.eco?.mode?.toUpperCase?.() === 'AUTO-ECO' ||
        sourceValue?.value?.eco?.mode?.toUpperCase?.() === 'MANUAL-ECO'
      ) {
        if (isNaN(sourceValue?.value?.away_temperature_high) === false) {
          value = Number(sourceValue.value.away_temperature_high);
        }
      }

      return value !== undefined ? adjustTemperature(value, 'C', 'C', true) : undefined;
    },
  },

  target_temperature: {
    google: ({ sourceValue }) => {
      let value;
      let setpointType = sourceValue?.value?.target_temperature_settings?.targetTemperature?.setpointType;

      if (
        setpointType === 'SET_POINT_TYPE_COOL' &&
        isNaN(sourceValue?.value?.target_temperature_settings?.targetTemperature?.coolingTarget?.value) === false
      ) {
        value = Number(sourceValue.value.target_temperature_settings.targetTemperature.coolingTarget.value);
      }

      if (
        setpointType === 'SET_POINT_TYPE_HEAT' &&
        isNaN(sourceValue?.value?.target_temperature_settings?.targetTemperature?.heatingTarget?.value) === false
      ) {
        value = Number(sourceValue.value.target_temperature_settings.targetTemperature.heatingTarget.value);
      }

      if (
        setpointType === 'SET_POINT_TYPE_RANGE' &&
        isNaN(sourceValue?.value?.target_temperature_settings?.targetTemperature?.coolingTarget?.value) === false &&
        isNaN(sourceValue?.value?.target_temperature_settings?.targetTemperature?.heatingTarget?.value) === false
      ) {
        value =
          (Number(sourceValue.value.target_temperature_settings.targetTemperature.coolingTarget.value) +
            Number(sourceValue.value.target_temperature_settings.targetTemperature.heatingTarget.value)) *
          0.5;
      }

      if (sourceValue?.value?.eco_mode_state?.ecoMode !== 'ECO_MODE_INACTIVE') {
        if (
          sourceValue?.value?.eco_mode_settings?.ecoTemperatureHeat?.enabled === true &&
          sourceValue?.value?.eco_mode_settings?.ecoTemperatureCool?.enabled === false &&
          isNaN(sourceValue?.value?.eco_mode_settings?.ecoTemperatureHeat?.value?.value) === false
        ) {
          value = Number(sourceValue.value.eco_mode_settings.ecoTemperatureHeat.value.value);
        }
        if (
          sourceValue?.value?.eco_mode_settings?.ecoTemperatureHeat?.enabled === false &&
          sourceValue?.value?.eco_mode_settings?.ecoTemperatureCool?.enabled === true &&
          isNaN(sourceValue?.value?.eco_mode_settings?.ecoTemperatureCool?.value?.value) === false
        ) {
          value = Number(sourceValue.value.eco_mode_settings.ecoTemperatureCool.value.value);
        }
        if (
          sourceValue?.value?.eco_mode_settings?.ecoTemperatureHeat?.enabled === true &&
          sourceValue?.value?.eco_mode_settings?.ecoTemperatureCool?.enabled === true &&
          isNaN(sourceValue?.value?.eco_mode_settings?.ecoTemperatureHeat?.value?.value) === false &&
          isNaN(sourceValue?.value?.eco_mode_settings?.ecoTemperatureCool?.value?.value) === false
        ) {
          value =
            (Number(sourceValue.value.eco_mode_settings.ecoTemperatureCool.value.value) +
              Number(sourceValue.value.eco_mode_settings.ecoTemperatureHeat.value.value)) *
            0.5;
        }
      }

      return value !== undefined ? adjustTemperature(value, 'C', 'C', true) : undefined;
    },

    nest: ({ rawData, sourceValue }) => {
      let targetType = rawData?.['shared.' + sourceValue?.value?.serial_number]?.value?.target_temperature_type?.toUpperCase?.() ?? 'OFF';
      let value;

      if (isNaN(rawData?.['shared.' + sourceValue?.value?.serial_number]?.value?.target_temperature) === false) {
        value = Number(rawData['shared.' + sourceValue.value.serial_number].value.target_temperature);
      }

      if (targetType === 'COOL') {
        if (isNaN(rawData?.['shared.' + sourceValue?.value?.serial_number]?.value?.target_temperature_high) === false) {
          value = Number(rawData['shared.' + sourceValue.value.serial_number].value.target_temperature_high);
        }
      }

      if (targetType === 'HEAT') {
        if (isNaN(rawData?.['shared.' + sourceValue?.value?.serial_number]?.value?.target_temperature_low) === false) {
          value = Number(rawData['shared.' + sourceValue.value.serial_number].value.target_temperature_low);
        }
      }

      if (targetType === 'RANGE') {
        if (
          isNaN(rawData?.['shared.' + sourceValue?.value?.serial_number]?.value?.target_temperature_low) === false &&
          isNaN(rawData?.['shared.' + sourceValue?.value?.serial_number]?.value?.target_temperature_high) === false
        ) {
          value =
            (Number(rawData['shared.' + sourceValue.value.serial_number].value.target_temperature_low) +
              Number(rawData['shared.' + sourceValue.value.serial_number].value.target_temperature_high)) *
            0.5;
        }
      }

      if (
        sourceValue?.value?.eco?.mode?.toUpperCase?.() === 'AUTO-ECO' ||
        sourceValue?.value?.eco?.mode?.toUpperCase?.() === 'MANUAL-ECO'
      ) {
        if (
          sourceValue?.value?.away_temperature_low_enabled === true &&
          sourceValue?.value?.away_temperature_high_enabled === false &&
          isNaN(sourceValue?.value?.away_temperature_low) === false
        ) {
          value = Number(sourceValue.value.away_temperature_low);
        }
        if (
          sourceValue?.value?.away_temperature_high_enabled === true &&
          sourceValue?.value?.away_temperature_low_enabled === false &&
          isNaN(sourceValue?.value?.away_temperature_high) === false
        ) {
          value = Number(sourceValue.value.away_temperature_high);
        }
        if (
          sourceValue?.value?.away_temperature_high_enabled === true &&
          sourceValue?.value?.away_temperature_low_enabled === true &&
          isNaN(sourceValue?.value?.away_temperature_low) === false &&
          isNaN(sourceValue?.value?.away_temperature_high) === false
        ) {
          value = (Number(sourceValue.value.away_temperature_low) + Number(sourceValue.value.away_temperature_high)) * 0.5;
        }
      }

      return value !== undefined ? adjustTemperature(value, 'C', 'C', true) : undefined;
    },
  },

  hvac_state: {
    google: ({ sourceValue }) => {
      let state = 'off';

      if (
        sourceValue?.value?.hvac_control?.hvacState?.coolStage1Active === true ||
        sourceValue?.value?.hvac_control?.hvacState?.coolStage2Active === true ||
        sourceValue?.value?.hvac_control?.hvacState?.coolStage3Active === true
      ) {
        state = 'cooling';
      }
      if (
        sourceValue?.value?.hvac_control?.hvacState?.heatStage1Active === true ||
        sourceValue?.value?.hvac_control?.hvacState?.heatStage2Active === true ||
        sourceValue?.value?.hvac_control?.hvacState?.heatStage3Active === true ||
        sourceValue?.value?.hvac_control?.hvacState?.alternateHeatStage1Active === true ||
        sourceValue?.value?.hvac_control?.hvacState?.alternateHeatStage2Active === true ||
        sourceValue?.value?.hvac_control?.hvacState?.auxiliaryHeatActive === true ||
        sourceValue?.value?.hvac_control?.hvacState?.emergencyHeatActive === true
      ) {
        state = 'heating';
      }

      return state;
    },

    nest: ({ rawData, sourceValue }) => {
      let state = 'off';
      let shared = rawData?.['shared.' + sourceValue?.value?.serial_number]?.value;

      if (
        shared?.hvac_heater_state === true ||
        shared?.hvac_heat_x2_state === true ||
        shared?.hvac_heat_x3_state === true ||
        shared?.hvac_aux_heater_state === true ||
        shared?.hvac_alt_heat_x2_state === true ||
        shared?.hvac_emer_heat_state === true ||
        shared?.hvac_alt_heat_state === true
      ) {
        state = 'heating';
      }
      if (shared?.hvac_ac_state === true || shared?.hvac_cool_x2_state === true || shared?.hvac_cool_x3_state === true) {
        state = 'cooling';
      }

      return state;
    },
  },

  // RCS / remote comfort sensor fields
  active_rcs_sensor: {
    google: ({ sourceValue }) =>
      sourceValue?.value?.remote_comfort_sensing_settings?.activeRcsSelection?.activeRcsSensor !== undefined
        ? sourceValue.value.remote_comfort_sensing_settings.activeRcsSelection.activeRcsSensor.resourceId
        : undefined,
    nest: ({ rawData, sourceValue }) => {
      let activeSensor;

      if (rawData?.['rcs_settings.' + sourceValue?.value?.serial_number]?.value?.associated_rcs_sensors !== undefined) {
        rawData['rcs_settings.' + sourceValue.value.serial_number].value.associated_rcs_sensors.forEach((sensor) => {
          if (
            typeof rawData?.[sensor]?.value === 'object' &&
            rawData?.['rcs_settings.' + sourceValue.value.serial_number]?.value?.active_rcs_sensors?.includes?.(sensor) === true
          ) {
            activeSensor = rawData[sensor].value.serial_number.toUpperCase();
          }
        });
      }

      return activeSensor;
    },
  },

  linked_rcs_sensors: {
    google: ({ sourceValue }) => {
      let sensors = [];

      if (Array.isArray(sourceValue?.value?.remote_comfort_sensing_settings?.associatedRcsSensors) === true) {
        sourceValue.value.remote_comfort_sensing_settings.associatedRcsSensors.forEach((sensor) => {
          sensors.push(sensor.deviceId.resourceId);
        });
      }

      return sensors;
    },

    nest: ({ rawData, sourceValue }) => {
      let sensors = [];

      if (rawData?.['rcs_settings.' + sourceValue?.value?.serial_number]?.value?.associated_rcs_sensors !== undefined) {
        rawData['rcs_settings.' + sourceValue.value.serial_number].value.associated_rcs_sensors.forEach((sensor) => {
          if (typeof rawData?.[sensor]?.value === 'object') {
            sensors.push(rawData[sensor].value.serial_number.toUpperCase());
          }
        });
      }

      return sensors;
    },
  },

  // Schedule fields
  schedule_mode: {
    google: ({ sourceValue }) =>
      typeof sourceValue?.value?.target_temperature_settings?.targetTemperature?.setpointType === 'string' &&
      sourceValue.value.target_temperature_settings.targetTemperature.setpointType.split('SET_POINT_TYPE_')[1].toLowerCase() !== 'off'
        ? sourceValue.value.target_temperature_settings.targetTemperature.setpointType.split('SET_POINT_TYPE_')[1].toLowerCase()
        : '',
    nest: ({ rawData, sourceValue }) => rawData?.['schedule.' + sourceValue?.value?.serial_number]?.value?.schedule_mode ?? '',
  },

  schedules: {
    google: ({ sourceValue }) => {
      let schedules = {};
      let scheduleMode =
        typeof sourceValue?.value?.target_temperature_settings?.targetTemperature?.setpointType === 'string' &&
        sourceValue.value.target_temperature_settings.targetTemperature.setpointType.split('SET_POINT_TYPE_')[1].toLowerCase() !== 'off'
          ? sourceValue.value.target_temperature_settings.targetTemperature.setpointType.split('SET_POINT_TYPE_')[1].toLowerCase()
          : '';

      if (
        sourceValue?.value?.[scheduleMode + '_schedule_settings']?.setpoints !== undefined &&
        sourceValue?.value?.[scheduleMode + '_schedule_settings']?.type === 'SET_POINT_SCHEDULE_TYPE_' + scheduleMode.toUpperCase()
      ) {
        Object.values(sourceValue.value[scheduleMode + '_schedule_settings'].setpoints).forEach((schedule) => {
          if (schedule?.dayOfWeek !== undefined) {
            let dayofWeekIndex = DAYS_OF_WEEK_FULL.indexOf(schedule.dayOfWeek.split('DAY_OF_WEEK_')[1]);

            if (schedules?.[dayofWeekIndex] === undefined) {
              schedules[dayofWeekIndex] = {};
            }

            schedules[dayofWeekIndex][Object.entries(schedules[dayofWeekIndex]).length] = {
              'temp-min': adjustTemperature(schedule.heatingTarget.value, 'C', 'C', true),
              'temp-max': adjustTemperature(schedule.coolingTarget.value, 'C', 'C', true),
              time: isNaN(schedule?.secondsInDay) === false ? Number(schedule.secondsInDay) : 0,
              type: scheduleMode.toUpperCase(),
              entry_type: 'setpoint',
            };
          }
        });
      }

      return schedules;
    },

    nest: ({ rawData, sourceValue }) => {
      if (rawData?.['schedule.' + sourceValue?.value?.serial_number] === undefined) {
        return {};
      }

      Object.values(rawData['schedule.' + sourceValue.value.serial_number].value.days).forEach((daySchedules) => {
        Object.values(daySchedules).forEach((schedule) => {
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

      return rawData['schedule.' + sourceValue.value.serial_number].value.days;
    },
  },
};

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

  let devices = {};

  // Process data for any thermostat(s) we have in the raw data
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
          let mappedData = buildMappedObject(THERMOSTAT_FIELD_MAP, createMappingContext(rawData, object_key, undefined, value));

          if (
            mappedData.serialNumber !== undefined &&
            mappedData.nest_google_device_uuid !== undefined &&
            mappedData.nest_google_home_uuid !== undefined &&
            mappedData.model !== undefined &&
            mappedData.softwareVersion !== undefined &&
            (mappedData.description !== undefined || mappedData.location !== undefined)
          ) {
            // Process any temperature sensors associated with this thermostat
            if (Array.isArray(value.value?.remote_comfort_sensing_settings?.associatedRcsSensors) === true) {
              value.value.remote_comfort_sensing_settings.associatedRcsSensors.forEach((sensor) => {
                if (typeof rawData?.[sensor?.deviceId?.resourceId]?.value === 'object') {
                  rawData[sensor.deviceId.resourceId].value.associated_thermostat = object_key;
                }
              });
            }

            if (mappedData.has_hot_water_control === true) {
              mappedData.model = mappedData.model.replace(/\bgen\)/, 'gen, EU)');
            }

            tempDevice = processCommonData(
              mappedData.nest_google_device_uuid,
              mappedData.nest_google_home_uuid,
              {
                type: DEVICE_TYPE.THERMOSTAT,
                ...mappedData,
              },
              config,
            );
          }
        }

        // Nest fallback if Google not used or data not available from Google for this device
        if (
          Object.entries(tempDevice).length === 0 &&
          value?.source === DATA_SOURCE.NEST &&
          typeof rawData?.['track.' + value.value?.serial_number] === 'object' &&
          (rawData?.['link.' + value.value?.serial_number]?.value?.structure?.trim() ?? '') !== '' &&
          typeof rawData?.['shared.' + value.value?.serial_number] === 'object' &&
          typeof rawData?.['where.' + rawData['link.' + value.value.serial_number].value.structure.split?.('.')[1]] === 'object'
        ) {
          let mappedData = buildMappedObject(THERMOSTAT_FIELD_MAP, createMappingContext(rawData, object_key, value, undefined));

          // Nest-only humidifier target
          mappedData.target_humidity = isNaN(value.value?.target_humidity) === false ? Number(value.value.target_humidity) : 0.0;

          // Process any temperature sensors associated with this thermostat
          if (rawData?.['rcs_settings.' + value.value.serial_number]?.value?.associated_rcs_sensors !== undefined) {
            rawData['rcs_settings.' + value.value.serial_number].value.associated_rcs_sensors.forEach((sensor) => {
              if (typeof rawData?.[sensor]?.value === 'object') {
                rawData[sensor].value.associated_thermostat = object_key;

                if (rawData?.['rcs_settings.' + value.value.serial_number]?.value?.active_rcs_sensors?.includes?.(sensor) === true) {
                  mappedData.current_temperature = adjustTemperature(rawData[sensor].value.current_temperature, 'C', 'C', true);
                }
              }
            });
          }

          if (
            mappedData.serialNumber !== undefined &&
            mappedData.nest_google_device_uuid !== undefined &&
            mappedData.nest_google_home_uuid !== undefined &&
            mappedData.model !== undefined &&
            mappedData.softwareVersion !== undefined &&
            (mappedData.description !== undefined || mappedData.location !== undefined)
          ) {
            if (mappedData.has_hot_water_control === true) {
              mappedData.model = mappedData.model.replace(/\bgen\)/, 'gen, EU)');
            }

            tempDevice = processCommonData(
              mappedData.nest_google_device_uuid,
              mappedData.nest_google_home_uuid,
              {
                type: DEVICE_TYPE.THERMOSTAT,
                ...mappedData,
              },
              config,
            );
          }
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
        //eslint-disable-next-line no-unused-vars
        let homeOptions = config?.homes?.find(
          (home) =>
            home?.nest_home_uuid?.toUpperCase?.() === tempDevice?.nest_google_home_uuid?.toUpperCase?.() ||
            home?.google_home_uuid?.toUpperCase?.() === tempDevice?.nest_google_home_uuid?.toUpperCase?.(),
        );

        // Insert any extra options we've read in from configuration file for this device
        tempDevice.eveHistory =
          deviceOptions?.eveHistory !== undefined ? deviceOptions.eveHistory === true : config.options?.eveHistory === true;

        tempDevice.humiditySensor = deviceOptions?.humiditySensor === true;

        // Process fan running duration.. we only allow values matching app
        tempDevice.fan_duration = parseDurationToSeconds(deviceOptions?.fanDuration, {
          defaultValue: tempDevice.fan_duration,
          min: 900,
          max: 604800,
        });

        tempDevice.fan_duration = FAN_DURATION_TIMES.reduce((a, b) =>
          Math.abs(tempDevice.fan_duration - a) < Math.abs(tempDevice.fan_duration - b) ? a : b,
        );

        // Do we have "external" code module for some thermostat functions
        tempDevice.external =
          typeof deviceOptions?.external === 'string' && deviceOptions.external !== '' ? deviceOptions.external : undefined;

        devices[tempDevice.serialNumber] = tempDevice;
      }
    });

  return devices;
}
