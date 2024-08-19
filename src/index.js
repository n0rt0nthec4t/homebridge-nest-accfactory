// Homebridge platform allowing Nest devices to be used with HomeKit
// This is a port from my standalone project, Nest_accfactory to Homebridge
//
// This includes having support for HomeKit Secure Video (HKSV) on doorbells and cameras
//
// The following Nest devices are supported
//
// Nest Thermostats (Gen 1, Gen 2, Gen 3, E, Mirrored 2020)
// Nest Protects (Gen 1, Gen 2)
// Nest Temperature Sensors
// Nest Cameras (Cam Indoor, IQ Indoor, Outdoor, IQ Outdoor)
// Nest Hello (Wired Gen 1)
//
// The accessory supports authentication to Nest/Google using either a Nest account OR Google (migrated Nest account) account.
// "preliminary" support for using FieldTest account types also.
//
// Supports both Nest REST and protobuf APIs for communication to Nest systems
//
// Code version 20/8/2024
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
