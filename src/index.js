// Plugin Entry Point
// Part of homebridge-nest-accfactory
//
// Entry point for the Homebridge NestAccfactory platform plugin.
// Registers the platform with Homebridge and initialises shared plugin
// metadata used by HomeKitDevice and Eve Home integration.
//
// Responsibilities:
// - Validate the Homebridge API object
// - Register the NestAccfactory platform with Homebridge
// - Initialise shared plugin and platform names
// - Attach Eve Home support helpers to HomeKitDevice
//
// Notes:
// - All platform logic is delegated to system.js
// - Device lifecycle and shared HomeKit helpers are provided by HomeKitDevice.js
// - Eve Home integration is provided via HomeKitHistory.js
//
// Code version 2026.03.15
// Mark Hulskamp
'use strict';

// Import our modules
import NestAccfactory from './system.js';
import HomeKitDevice from './HomeKitDevice.js';
HomeKitDevice.PLUGIN_NAME = 'homebridge-nest-accfactory';
HomeKitDevice.PLATFORM_NAME = 'NestAccfactory';

import HomeKitHistory from './HomeKitHistory.js';
HomeKitDevice.EVEHOME = HomeKitHistory;

export default (api) => {
  // Validate Homebridge API object
  if (typeof api?.registerPlatform !== 'function') {
    throw new Error('NestAccfactory: Invalid Homebridge API object - registerPlatform method not found');
  }

  // Register our platform with Homebridge
  api.registerPlatform(HomeKitDevice.PLATFORM_NAME, NestAccfactory);
};
