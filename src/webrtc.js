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
import protobuf from 'protobufjs';

// Define nodejs module requirements
import http2 from 'node:http2';
//import EventEmitter from 'node:events';
import { Buffer } from 'node:buffer';
//import { setInterval, clearInterval, setTimeout } from 'node:timers';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
//import process from 'node:process';
//import child_process from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Define our modules
import Streamer from './streamer.js';

// Define constants
const __dirname = path.dirname(fileURLToPath(import.meta.url)); // Make a defined for JS __dirname

// WebRTC object
export default class WebRTC extends Streamer {
  token = undefined;
  oauth2 = undefined;

  // Internal data only for this class
  #protobufFoyer = undefined; // Protobuf for Google Home Foyer
  #googleHomeFoyer = undefined; // HTTP/2 connection to Google Home Foyer APIs

  constructor(deviceData, options) {
    super(deviceData, options);

    if (fs.existsSync(path.resolve(__dirname + '/protobuf/googlehome/foyer.proto')) === true) {
      protobuf.util.Long = null;
      protobuf.configure();
      this.#protobufFoyer = protobuf.loadSync(path.resolve(__dirname + '/protobuf/googlehome/foyer.proto'));
    }

    // Translate our uuid (DEVICE_xxxxxxxxxx) into the associated 'google id' from the Google Home Foyer
    //deviceData.uuid

    // Store data we need from the device data passed it
    this.token = deviceData?.apiAccess?.token;
    this.oauth2 = deviceData?.apiAccess?.oauth2;
    this.host = deviceData?.streaming_host; // Host we'll connect to

    // If specified option to start buffering, kick off
    if (typeof options?.buffer === 'boolean' && options.buffer === true) {
      this.startBuffering();
    }

    this.googleHomeFoyerCommand('StructuresService', 'GetHomeGraph', {
      requestId: crypto.randomBytes(32).toString('hex'),
      unknown1: 1,
    });
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

  async googleHomeFoyerCommand(service, command, values) {
    if (typeof service !== 'string' || service === '' || typeof command !== 'string' || command === '' || typeof values !== 'object') {
      return;
    }

    //   return new Promise((callback) => {
    // Attempt to retrieve both 'Request' and 'Reponse' traits for the associated service and command
    let TraitMapRequest = this.#protobufFoyer.lookup('google.internal.home.foyer.v1.' + command + 'Request');
    let TraitMapResponse = this.#protobufFoyer.lookup('google.internal.home.foyer.v1.' + command + 'Response');
    let buffer = Buffer.alloc(0);
    let commandResponse = [];

    if (TraitMapRequest !== null && TraitMapResponse !== null && this.oauth2 !== undefined) {
      if (this.#googleHomeFoyer === undefined) {
        this.#googleHomeFoyer = http2.connect('https://googlehomefoyer-pa.googleapis.com', { maxOutstandingPings: 2 });

        this.#googleHomeFoyer.on('connect', () => {
          this?.log?.debug && this.log.debug('Connected to Google Home Foyer');

          this.#googleHomeFoyer.setTimeout(0);
        });

        // eslint-disable-next-line no-unused-vars
        this.#googleHomeFoyer.on('error', (error) => {});

        this.#googleHomeFoyer.on('stream', () => {});

        // eslint-disable-next-line no-unused-vars
        this.#googleHomeFoyer.on('ping', (data) => {});

        // eslint-disable-next-line no-unused-vars
        this.#googleHomeFoyer.on('frameError', (type, code, id) => {});

        // eslint-disable-next-line no-unused-vars
        this.#googleHomeFoyer.on('goaway', (errorCode, lastStreamID, opaqueData) => {});

        this.#googleHomeFoyer.on('close', () => {
          this.#googleHomeFoyer = undefined;
          this?.log?.debug && this.log.debug('Connection closed to Google Home Foyer');
        });

        let request = this.#googleHomeFoyer.request({
          ':method': 'post',
          ':path': '/google.internal.home.foyer.v1.' + service + '/' + command,
          authorization: 'Bearer ' + this.oauth2,
          'content-type': 'application/grpc',
          'user-agent': 'grpc-java-cronet/1.40.0-SNAPSHOT',
          te: 'trailers',
          'request-id': crypto.randomUUID(),
          'grpc-timeout': '10S',
        });

        request.on('data', (data) => {
          buffer = Buffer.concat([buffer, data]);
          while (buffer.length >= 5) {
            let headerSize = 5;
            let dataSize = buffer.readUInt32BE(1);
            if (buffer.length < headerSize + dataSize) {
              // We dont have enough data in the buffer yet to process the data
              // so, exit loop and await more data
              break;
            }

            commandResponse.push(TraitMapResponse.decode(buffer.subarray(headerSize, headerSize + dataSize)).toJSON());
            buffer = buffer.subarray(headerSize + dataSize);
          }
        });

        request.on('trailers', (headers, flags) => {
          let responseStatus = Number(headers['grpc-status']);
          let responseMessage = headers['grpc-message'];
        });

        // eslint-disable-next-line no-unused-vars
        request.on('error', (error) => {});

        request.on('close', () => {
          console.log('closed');
        });

        if (request !== undefined && request?.closed === false && request?.destroyed === false) {
          // Encoode our request values, prefix with header (size of data), then send
          let encodedData = TraitMapRequest.encode(TraitMapRequest.fromObject(values)).finish();
          let header = Buffer.alloc(5);
          header.writeUInt32BE(encodedData.length, 1);
          request.write(Buffer.concat([header, encodedData]));
          request.end();
        }
      }
    }
  }
}
