// WebRTC
// Part of homebridge-nest-accfactory
//
// Handles connection and data from Google WeBRTC systems
//
// Code version 6/9/2024
// Mark Hulskamp
'use strict';

// Define external library requirements
//import axios from 'axios';
//import protobuf from 'protobufjs';

// Define nodejs module requirements
//import { Buffer } from 'node:buffer';
//import { setInterval, clearInterval, setTimeout, clearTimeout } from 'node:timers';
//import tls from 'tls';
//import crypto from 'crypto';

// Define our modules
import Streamer from './streamer.js';

// Define constants

// WebRTC object
export default class WebRTC extends Streamer {
  constructor(deviceData, options) {
    super(deviceData, options);

    this.host = deviceData?.streaming_host; // Host we'll connect to

    // If specified option to start buffering, kick off
    if (typeof options?.buffer === 'boolean' && options.buffer === true) {
      this.startBuffering();
    }
  }

  // Class functions
  connect(host) {
    this.log.info(host);
  }

  close(stopStreamFirst) {
    this.log.info(stopStreamFirst);
  }

  update(deviceData) {
    // Let our parent handle the remaining updates
    super.update(deviceData);
  }

  talkingAudio(talkingData) {
    this.log.info(talkingData);
  }
}
