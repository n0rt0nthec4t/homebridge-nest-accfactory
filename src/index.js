// Homebridge platform plugin entry point: NestAccfactory
// Part of homebridge-nest-accfactory
//
// Exports default function that validates Homebridge API and registers the NestAccfactory platform.
// Delegates all platform logic to system manager (system.js) and device wrapper (HomeKitDevice.js).
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
