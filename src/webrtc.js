// WebRTC
// Part of homebridge-nest-accfactory
//
// Handles connection and data from Google WebRTC systems
//
// Code version 18/9/2024
// Mark Hulskamp
'use strict';

// Define external library requirements
import protobuf from 'protobufjs';
import wrtc from 'werift';

// Define nodejs module requirements
import http2 from 'node:http2';
import { Buffer } from 'node:buffer';
import { setInterval, clearInterval } from 'node:timers';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Define our modules
import Streamer from './streamer.js';

// Define constants
const EXTENDINTERVAL = 120000; // Send extend command to Google Home Foyer every this period for active streams
//const RTP_PACKET_HEADER_SIZE = 12;
const RTP_VIDEO_PAYLOAD_TYPE = 96;
const RTP_AUDIO_PAYLOAD_TYPE = 97;
//const RTP_TALKBACK_PAYLOAD_TYPE = 110;
const USERAGENT = 'Nest/5.78.0 (iOScom.nestlabs.jasper.release) os=18.0'; // User Agent string
const __dirname = path.dirname(fileURLToPath(import.meta.url)); // Make a defined for JS __dirname

// WebRTC object
export default class WebRTC extends Streamer {
  token = undefined; // oauth2 token
  localAccess = false; // Do we try direct local access to the camera or via Google Home first
  extendTimer = undefined; // Stream extend timer
  talking = undefined;

  // Internal data only for this class
  #protobufFoyer = undefined; // Protobuf for Google Home Foyer
  #googleHomeFoyer = undefined; // HTTP/2 connection to Google Home Foyer APIs
  #id = undefined; // Session ID
  #googleHomeDeviceUUID = undefined; // Normal Nest/Google protobuf device ID translated to a Google Foyer device ID
  #peerConnection = undefined;
  #videoTransceiver = undefined;
  #audioTransceiver = undefined;

  constructor(deviceData, options) {
    super(deviceData, options);

    // Load the protobuf for Google Home Foyer. Needed to communicate with camera devices using webrtc
    if (fs.existsSync(path.resolve(__dirname + '/protobuf/googlehome/foyer.proto')) === true) {
      protobuf.util.Long = null;
      protobuf.configure();
      this.#protobufFoyer = protobuf.loadSync(path.resolve(__dirname + '/protobuf/googlehome/foyer.proto'));
    }

    // Store data we need from the device data passed it
    this.token = deviceData?.apiAccess?.oauth2;
    this.localAccess = deviceData?.localAccess === true;

    // Set our streamer codec types
    this.codecs = {
      video: 'h264',
      audio: 'opus',
      talk: 'opus',
    };

    // If specified option to start buffering, kick off
    if (typeof options?.buffer === 'boolean' && options.buffer === true) {
      this.startBuffering();
    }
  }

  // Class functions
  async connect() {
    this.extendTimer = clearInterval(this.extendTimer);
    this.#id = undefined;
    this.talking = undefined;

    if (this.#googleHomeDeviceUUID === undefined) {
      // We don't have the 'google id' yet for this device, so obtain
      let homeFoyerResponse = await this.#googleHomeFoyerCommand('StructuresService', 'GetHomeGraph', {
        requestId: crypto.randomUUID(),
        unknown1: 1,
      });

      // Translate our uuid (DEVICE_xxxxxxxxxx) into the associated 'google id' from the Google Home Foyer
      // We need this id for SOME calls to Google Home Foyer services. Gotta love consistancy :-)
      if (homeFoyerResponse?.data?.[0]?.homes !== undefined) {
        Object.values(homeFoyerResponse?.data?.[0]?.homes).forEach((home) => {
          Object.values(home.devices).forEach((device) => {
            if (device?.id?.googleUuid !== undefined && device?.otherIds?.otherThirdPartyId !== undefined) {
              // Test to see if our uuid matches here
              let currentGoogleUuid = device?.id?.googleUuid;
              Object.values(device.otherIds.otherThirdPartyId).forEach((other) => {
                if (other?.id === this.uuid) {
                  this.#googleHomeDeviceUUID = currentGoogleUuid;
                }
              });
            }
          });
        });
      }
    }

    if (this.#googleHomeDeviceUUID !== undefined) {
      // Start setting up connection to camera stream
      let homeFoyerResponse = await this.#googleHomeFoyerCommand('CameraService', 'SendCameraViewIntent', {
        request: {
          googleDeviceId: {
            value: this.#googleHomeDeviceUUID,
          },
          command: 'VIEW_INTENT_START',
        },
      });

      if (homeFoyerResponse.status === 0) {
        // Setup our WwebWRTC peerconnection for this device
        this.#peerConnection = new wrtc.RTCPeerConnection({
          bundlePolicy: 'max-bundle',
          codecs: {
            audio: [
              new wrtc.RTCRtpCodecParameters({
                mimeType: 'audio/opus',
                clockRate: 48000,
                channels: 2,
                payloadType: RTP_AUDIO_PAYLOAD_TYPE,
              }),
            ],
            video: [
              new wrtc.RTCRtpCodecParameters({
                mimeType: 'video/H264',
                clockRate: 90000,
                rtcpFeedback: [
                  { type: 'transport-cc' },
                  { type: 'ccm', parameter: 'fir' },
                  { type: 'nack' },
                  { type: 'nack', parameter: 'pli' },
                  { type: 'goog-remb' },
                ],
                parameters: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
                payloadType: RTP_VIDEO_PAYLOAD_TYPE,
              }),
            ],
          },
        });
        this.#peerConnection.createDataChannel('webrtc-datachannel');

        this.#audioTransceiver = this.#peerConnection.addTransceiver('audio', {
          direction: 'sendrecv',
        });

        this.#videoTransceiver = this.#peerConnection.addTransceiver('video', {
          direction: 'recvonly',
        });

        let webRTCOffer = await this.#peerConnection.createOffer();
        await this.#peerConnection.setLocalDescription(webRTCOffer);

        this?.log?.debug && this.log.debug('Sending webWRTC offer for uuid "%s"', this.uuid);

        homeFoyerResponse = await this.#googleHomeFoyerCommand('CameraService', 'JoinStream', {
          command: 'offer',
          deviceId: this.uuid,
          local: this.localAccess,
          streamContext: 'STREAM_CONTEXT_DEFAULT',
          requestedVideoResolution: 'VIDEO_RESOLUTION_STANDARD',
          sdp: webRTCOffer.sdp,
        });

        if (
          homeFoyerResponse.status === 0 &&
          homeFoyerResponse.data?.[0]?.responseType === 'answer' &&
          homeFoyerResponse.data?.[0]?.streamId !== undefined
        ) {
          this?.log?.debug && this.log.debug('WebWTC offer agreed with remote for uuid "%s"', this.uuid);

          this.#audioTransceiver.onTrack.subscribe((track) => {
            this.#handlePlaybackBegin(track);

            track.onReceiveRtp.subscribe((rtp) => {
              this.#handlePlaybackPacket(rtp);
            });
          });

          this.#videoTransceiver.onTrack.subscribe((track) => {
            this.#handlePlaybackBegin(track);

            track.onReceiveRtp.subscribe((rtp) => {
              this.#handlePlaybackPacket(rtp);
            });
            track.onReceiveRtcp.once(() => {
              setInterval(() => {
                if (this.#videoTransceiver?.receiver !== undefined) {
                  this.#videoTransceiver.receiver.sendRtcpPLI(track.ssrc);
                }
              }, 2000);
            });
          });

          this.#id = homeFoyerResponse.data[0].streamId;
          await this.#peerConnection.setRemoteDescription({
            type: 'answer',
            sdp: homeFoyerResponse.data[0].sdp,
          });

          this.connected = true;

          // Create a timer to extend the active stream every period as defined
          this.extendTimer = setInterval(async () => {
            if (this.connected === true && this.#id !== undefined && this.#googleHomeDeviceUUID !== undefined) {
              let homeFoyerResponse = await this.#googleHomeFoyerCommand('CameraService', 'JoinStream', {
                command: 'extend',
                deviceId: this.uuid,
                streamId: this.#id,
              });

              if (homeFoyerResponse?.status !== 0 || homeFoyerResponse?.[0]?.data?.streamExtensionStatus !== 'STATUS_STREAM_EXTENDED') {
                this?.log?.debug && this.log.debug('Error occured while requested stream extentions for uuid "%s"', this.uuid);

                // Do we try to reconnect???
              }
            }
          }, EXTENDINTERVAL);
        }
      }
    }
  }

  close() {
    if (this.#id !== undefined) {
      this?.log?.debug && this.log.debug('Notifying remote about us closing connection for uuid "%s"', this.uuid);
      this.#googleHomeFoyerCommand('CameraService', 'JoinStream', {
        command: 'end',
        deviceId: this.uuid,
        streamId: this.#id,
        endStreamReason: 'REASON_USER_EXITED_SESSION',
      });

      if (this.talking !== undefined) {
        this.#googleHomeFoyerCommand('CameraService', 'SendTalkback', {
          googleDeviceId: {
            value: this.#googleHomeDeviceUUID,
          },
          streamId: this.#id,
          command: 'COMMAND_STOP',
        });
      }
    }

    if (typeof this.#peerConnection?.close === 'function') {
      this.#peerConnection.close();
      this.#peerConnection = undefined;
    }

    this.#videoTransceiver = undefined;
    this.#audioTransceiver = undefined;
    this.extendTimer = clearInterval(this.extendTimer);
    this.connected = false;
    this.#id = undefined;
    this.video = {};
    this.audio = {};
    this.talking = undefined;
  }

  update(deviceData) {
    if (typeof deviceData !== 'object') {
      return;
    }

    if (deviceData.apiAccess.oauth2 !== this.token) {
      // OAuth2 token has changed
      this.token = deviceData.apiAccess.oauth2;
    }

    // Let our parent handle the remaining updates
    super.update(deviceData);
  }

  async talkingAudio(talkingData) {
    if (Buffer.isBuffer(talkingData) === false || this.#googleHomeDeviceUUID === undefined || this.#id === undefined) {
      return;
    }

    if (talkingData.length !== 0) {
      if (this.talking === undefined) {
        this.talking = false;
        let homeFoyerResponse = await this.#googleHomeFoyerCommand('CameraService', 'SendTalkback', {
          googleDeviceId: {
            value: this.#googleHomeDeviceUUID,
          },
          streamId: this.#id,
          command: 'COMMAND_START',
        });
        if (homeFoyerResponse?.status !== 0) {
          this.talking = undefined;
          this?.log?.debug && this.log.debug('Error occured while requesting talkback to start for uuid "%s"', this.uuid);
        }
        if (homeFoyerResponse?.status === 0) {
          this.talking = true;
        }
      }

      if (this.talking === true) {
        // Output talkdata to stream
      }
    }

    if (talkingData.length === 0) {
      // Buffer length of zero, ised to signal no more talking data for the moment
      let homeFoyerResponse = await this.#googleHomeFoyerCommand('CameraService', 'SendTalkback', {
        googleDeviceId: {
          value: this.#googleHomeDeviceUUID,
        },
        streamId: this.#id,
        command: 'COMMAND_STOP',
      });
      if (homeFoyerResponse?.status !== 0) {
        this?.log?.debug && this.log.debug('Error occured while requesting talkback to stop for uuid "%s"', this.uuid);
      }
      this.talking = undefined;
    }
  }

  #handlePlaybackBegin(weriftTrack) {
    if (weriftTrack === undefined || typeof weriftTrack !== 'object') {
      return;
    }

    if (weriftTrack?.codec?.payloadType === RTP_AUDIO_PAYLOAD_TYPE) {
      // Store details about the audio track
      this.audio = {
        id: weriftTrack.codec.payloadType,
        startTime: Date.now(),
        sampleRate: 4800,
        timeStamp: 0,
        opus: undefined,
      };
    }

    if (weriftTrack?.codec?.payloadType === RTP_VIDEO_PAYLOAD_TYPE) {
      // Store details about the video track
      this.video = {
        id: weriftTrack.codec.payloadType,
        startTime: Date.now(),
        sampleRate: 90000,
        timeStamp: 0,
        h264: undefined,
      };
    }
  }

  #handlePlaybackPacket(weriftRtpPacket) {
    if (weriftRtpPacket === undefined || typeof weriftRtpPacket !== 'object') {
      return;
    }

    if (weriftRtpPacket?.header?.payloadType === this.video?.id) {
      // Process video RTP packets. Need to re-assemble the H264 NALUs into a singl H264 frame we can output
      this.video.timeStamp = weriftRtpPacket.header.timestamp;
      this.video.h264 = wrtc.H264RtpPayload.deSerialize(weriftRtpPacket.payload, this.video.h264?.fragment);
      if (this.video.h264?.payload !== undefined) {
        this.addToOutput('video', this.video.timeStamp, this.video.h264.payload);
      }
    }

    if (weriftRtpPacket?.header?.payloadType === this.audio?.id) {
      // Process audio RTP packet
      this.audio.timeStamp = weriftRtpPacket.header.timestamp;
      this.audio.opus = wrtc.OpusRtpPayload.deSerialize(weriftRtpPacket.payload);
      if (this.audio.opus?.payload !== undefined) {
        // this.addToOutput('audio', this.audio.timeStamp, this.audio.opus.payload);
        this.addToOutput(
          'audio',
          this.audio.timeStamp,
          Buffer.from([
            0xff, 0xf1, 0x4c, 0x40, 0x03, 0x9f, 0xfc, 0xde, 0x02, 0x00, 0x4c, 0x61, 0x76, 0x63, 0x35, 0x39, 0x2e, 0x31, 0x38, 0x2e, 0x31,
            0x30, 0x30, 0x00, 0x02, 0x30, 0x40, 0x0e, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c,
            0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1,
            0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff,
            0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07,
            0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20,
            0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18,
            0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01,
            0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc,
            0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f,
            0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01,
            0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40,
            0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c,
            0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1,
            0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff,
            0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07,
            0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20,
            0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18,
            0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01,
            0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc,
            0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f,
            0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01,
            0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40,
            0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c,
            0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1,
            0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07, 0xff, 0xf1, 0x4c, 0x40, 0x01, 0x7f, 0xfc, 0x01, 0x18, 0x20, 0x07,
          ]),
        );
      }
    }
  }

  // Need more work in here
  // <--- perodic ping
  // <--- error handling
  // <--- timeout?
  async #googleHomeFoyerCommand(service, command, values) {
    if (typeof service !== 'string' || service === '' || typeof command !== 'string' || command === '' || typeof values !== 'object') {
      return;
    }

    return new Promise((resolve, reject) => {
      // Attempt to retrieve both 'Request' and 'Reponse' traits for the associated service and command
      let TraitMapRequest = this.#protobufFoyer.lookup('google.internal.home.foyer.v1.' + command + 'Request');
      let TraitMapResponse = this.#protobufFoyer.lookup('google.internal.home.foyer.v1.' + command + 'Response');
      let buffer = Buffer.alloc(0);
      let commandResponse = {
        status: undefined,
        message: '',
        data: [],
      };

      if (TraitMapRequest !== null && TraitMapResponse !== null && this.token !== undefined) {
        if (this.#googleHomeFoyer === undefined) {
          this.#googleHomeFoyer = http2.connect('https://googlehomefoyer-pa.googleapis.com');
        }

        this.#googleHomeFoyer.on('connect', () => {
          this?.log?.debug && this.log.debug('Connected to Google Home Foyer');

          this.#googleHomeFoyer.setTimeout(0);
        });

        this.#googleHomeFoyer.on('error', (error) => {
          console.log('http2 error', error);
        });

        this.#googleHomeFoyer.on('close', () => {
          this?.log?.debug && this.log.debug('Connection closed to Google Home Foyer');
          this.#googleHomeFoyer = undefined;
        });

        let request = this.#googleHomeFoyer.request({
          ':method': 'post',
          ':path': '/google.internal.home.foyer.v1.' + service + '/' + command,
          authorization: 'Bearer ' + this.token,
          'content-type': 'application/grpc',
          'user-agent': USERAGENT,
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

            commandResponse.data.push(TraitMapResponse.decode(buffer.subarray(headerSize, headerSize + dataSize)).toJSON());
            buffer = buffer.subarray(headerSize + dataSize);
          }
        });

        request.on('trailers', (headers) => {
          if (isNaN(Number(headers?.['grpc-status'])) === false) {
            commandResponse.status = Number(headers['grpc-status']);
          }
          if (headers?.['grpc-message'] !== undefined) {
            commandResponse.message = headers['grpc-message'];
          }
        });

        request.on('error', (error) => {
          if (request.destroyed === false) {
            request.destroy();
          }
          reject({
            status: request.rstCode,
            detail: error?.cause?.code === undefined ? error?.code : error.cause.code,
            data: [],
          });
        });

        request.on('close', () => {
          if (commandResponse.status !== undefined) {
            resolve(commandResponse);
          } else {
            reject(commandResponse);
          }
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
    });
  }
}
