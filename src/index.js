// Homebridge platform allowing Nest devices to be used with HomeKit
// This is a port from my standalone project, Nest_accfactory to Homebridge
//
// This includes having support for HomeKit Secure Video (HKSV) on doorbells and cameras
//
// The following Nest devices are supported
//
// Nest Thermostats (1st gen, 2nd gen, 3rd gen, E, 2020 mirror edition, 4th gen)
// Nest Protects (1st and 2nd gen)
// Nest Temp Sensors (1st gen)
// Nest Cameras (Cam Indoor, IQ Indoor, Outdoor, IQ Outdoor, Cam with Floodlight)
// Nest Doorbells (wired 1st gen)
//
// The accessory supports authentication to Nest/Google using either a Nest account OR Google (migrated Nest account) account.
// "preliminary" support for using FieldTest account types also.
//
// Supports both Nest REST and Protobuf APIs for communication
//
// Code version 7/10/2024
// Mark Hulskamp
'use strict';

// Import our modules
import NestAccfactory from './system.js';
import HomeKitDevice from './HomeKitDevice.js';
HomeKitDevice.PLUGIN_NAME = 'homebridge-nest-accfactory';
HomeKitDevice.PLATFORM_NAME = 'NestAccfactory';

import HomeKitHistory from './HomeKitHistory.js';
HomeKitDevice.HISTORY = HomeKitHistory;

export default (api) => {
  // Register our platform with HomeBridge
  api.registerPlatform(HomeKitDevice.PLATFORM_NAME, NestAccfactory);
};
