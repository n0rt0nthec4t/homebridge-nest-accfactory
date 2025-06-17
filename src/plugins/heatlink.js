// Nest Heatlink
// Part of homebridge-nest-accfactory
//
// Mark Hulskamp
'use strict';

// Define our modules
import NestTemperatureSensor from './tempsensor.js';

export default class NestHeatlink extends NestTemperatureSensor {
  static TYPE = 'Heatlink';
  static VERSION = '2025.06.17';

  constructor(accessory, api, log, deviceData) {
    super(accessory, api, log, deviceData);
  }
}
