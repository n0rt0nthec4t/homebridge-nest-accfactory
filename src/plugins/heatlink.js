// Nest Heatlink
// Part of homebridge-nest-accfactory
//
// Mark Hulskamp
'use strict';

// Define our modules
import HomeKitDevice from '../HomeKitDevice.js';

export default class NestHeatlink extends HomeKitDevice {
  static TYPE = 'Heatlink';
  static VERSION = '2025.07.12'; // Code version

  thermostatService = undefined; // Hotwater temperature control
  switchService = undefined; // Hotwater heating boost control

  async onAdd() {
    // Patch to avoid characteristic errors when setting initial property ranges
    this.hap.Characteristic.TargetTemperature.prototype.getDefaultValue = function () {
      return this.deviceData.hotWaterMinTemp; // start at minimum heating threshold
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
      this.postSetupDetail('Temperature control (' + this.deviceData.hotWaterMinTemp + '–' + this.deviceData.hotWaterMaxTemp + '°C)');
  }

  async onUpdate(deviceData) {
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
    if (typeof message !== 'object' || message === null) {
      return;
    }

    if (type === HomeKitDevice?.HISTORY?.GET) {
      // Extend Eve Thermo GET payload with device state
      message.attached = this.deviceData.online === true;
    }
  }

  #setupHotwaterTemperature() {
    this.thermostatService = this.addHKService(this.hap.Service.Thermostat, '', 1, { messages: this.message.bind(this) });
    this.thermostatService.setPrimaryService();

    this.addHKCharacteristic(this.thermostatService, this.hap.Characteristic.StatusActive);

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
        return this.deviceData.current_water_temperature;
      },
    });

    this.addHKCharacteristic(this.thermostatService, this.hap.Characteristic.TargetTemperature, {
      props: {
        minStep: 0.5,
        minValue: this.deviceData.hotWaterMinTemp,
        maxValue: this.deviceData.hotWaterMaxTemp,
      },
      onSet: (value) => {
        this.set({ uuid: this.deviceData.associated_thermostat, hot_water_temperature: value });

        this?.log?.info?.('Set hotwater boiler temperature on heatlink "%s" to "%s °C"', this.deviceData.description, value);
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
        this.set({
          uuid: this.deviceData.associated_thermostat,
          hot_water_boost_active: { state: value === true, time: this.deviceData.hotWaterBoostTime },
        });

        this.switchService.updateCharacteristic(this.hap.Characteristic.On, value);

        this?.log?.info?.(
          'Set hotwater boost heating on heatlink "%s" to "%s"',
          this.deviceData.description,
          value === true
            ? 'On for ' +
                (this.deviceData.hotWaterBoostTime >= 3600
                  ? Math.floor(this.deviceData.hotWaterBoostTime / 3600) +
                    ' hr' +
                    (Math.floor(this.deviceData.hotWaterBoostTime / 3600) > 1 ? 's ' : ' ')
                  : '') +
                Math.floor((this.deviceData.hotWaterBoostTime % 3600) / 60) +
                ' min' +
                (Math.floor((this.deviceData.hotWaterBoostTime % 3600) / 60) !== 1 ? 's' : '')
            : 'Off',
        );
      },
      onGet: () => {
        return this.deviceData?.hot_water_boost_active === true;
      },
    });
  }
}
