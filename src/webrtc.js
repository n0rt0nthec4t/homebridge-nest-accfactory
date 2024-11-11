// WebRTC
// Part of homebridge-nest-accfactory
//
// Handles connection and data from Google WebRTC systems
//
// Code version 10/11/2024
// Mark Hulskamp
'use strict';

// Define external library requirements
import protobuf from 'protobufjs';
import werift from 'werift';

// Define nodejs module requirements
import EventEmitter from 'node:events';
import http2 from 'node:http2';
import { Buffer } from 'node:buffer';
import { setInterval, clearInterval, setTimeout, clearTimeout } from 'node:timers';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Define our modules
import Streamer from './streamer.js';

// Define constants
const EXTENDINTERVAL = 120000; // Send extend command to Google Home Foyer every this period for active streams
const RTP_PACKET_HEADER_SIZE = 12;
const RTP_VIDEO_PAYLOAD_TYPE = 102;
const RTP_AUDIO_PAYLOAD_TYPE = 111;
//const RTP_TALKBACK_PAYLOAD_TYPE = 110;
const USERAGENT = 'Nest/5.78.0 (iOScom.nestlabs.jasper.release) os=18.0'; // User Agent string
const GOOGLEHOMEFOYERPREFIX = 'google.internal.home.foyer.v1.';
const __dirname = path.dirname(fileURLToPath(import.meta.url)); // Make a defined for JS __dirname

// Blank audio in AAC format, mono channel @48000
const AACMONO48000BLANK = Buffer.from([
  0xff, 0xf1, 0x4c, 0x40, 0x03, 0x9f, 0xfc, 0xde, 0x02, 0x00, 0x4c, 0x61, 0x76, 0x63, 0x35, 0x39, 0x2e, 0x31, 0x38, 0x2e, 0x31, 0x30, 0x30,
  0x00, 0x02, 0x30, 0x40, 0x0e,
]);

// Blank audio in opus format, stero channel @48000
//const OPUSSTEREO48000BLANK = Buffer.from([]);

// WebRTC object
export default class WebRTC extends Streamer {
  token = undefined; // oauth2 token
  localAccess = false; // Do we try direct local access to the camera or via Google Home first
  extendTimer = undefined; // Stream extend timer
  stalledTimer = undefined; // Timer object for no received data
  pingTimer = undefined; // Google Hopme Foyer periodic ping
  blankAudio = AACMONO48000BLANK;
  video = {}; // Video stream details once connected
  audio = {}; // Audio stream details once connected

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
    if (options?.buffer === true) {
      this.startBuffering();
    }
  }

  // Class functions
  async connect() {
    clearInterval(this.extendTimer);
    clearTimeout(this.stalledTimer);
    this.extendTimer = undefined;
    this.stalledTimer = undefined;
    this.#id = undefined;

    if (this.#googleHomeDeviceUUID === undefined) {
      // We don't have the 'google id' yet for this device, so obtain
      let homeFoyerResponse = await this.#googleHomeFoyerCommand('StructuresService', 'GetHomeGraph', {
        requestId: crypto.randomUUID(),
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
      this.connected = false; // Starting connection
      let homeFoyerResponse = await this.#googleHomeFoyerCommand('CameraService', 'SendCameraViewIntent', {
        request: {
          googleDeviceId: {
            value: this.#googleHomeDeviceUUID,
          },
          command: 'VIEW_INTENT_START',
        },
      });

      if (homeFoyerResponse.status !== 0) {
        this.connected = undefined;
        this?.log?.debug && this.log.debug('Request to start camera viewing was not accepted for uuid "%s"', this.uuid);
      }

      if (homeFoyerResponse.status === 0) {
        // Setup our WebWRTC peer connection for this device
        this.#peerConnection = new werift.RTCPeerConnection({
          iceUseIpv4: true,
          iceUseIpv6: false,
          bundlePolicy: 'max-bundle',
          codecs: {
            audio: [
              new werift.RTCRtpCodecParameters({
                mimeType: 'audio/opus',
                clockRate: 48000,
                channels: 2,
                rtcpFeedback: [{ type: 'transport-cc' }, { type: 'nack' }],
                parameters: 'minptime=10;useinbandfec=1',
                payloadType: RTP_AUDIO_PAYLOAD_TYPE,
              }),
            ],
            video: [
              // H264 Main profile, level 4.0
              new werift.RTCRtpCodecParameters({
                mimeType: 'video/H264',
                clockRate: 90000,
                rtcpFeedback: [
                  { type: 'transport-cc' },
                  { type: 'ccm', parameter: 'fir' },
                  { type: 'nack' },
                  { type: 'nack', parameter: 'pli' },
                  { type: 'goog-remb' },
                ],
                parameters: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=4de020',
                payloadType: RTP_VIDEO_PAYLOAD_TYPE,
              }),
            ],
          },
          headerExtensions: {
            audio: [werift.useTransportWideCC(), werift.useAudioLevelIndication()],
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

        this?.log?.debug && this.log.debug('Sending WebRTC offer for uuid "%s"', this.uuid);

        homeFoyerResponse = await this.#googleHomeFoyerCommand('CameraService', 'JoinStream', {
          command: 'offer',
          deviceId: this.uuid,
          local: this.localAccess,
          streamContext: 'STREAM_CONTEXT_DEFAULT',
          requestedVideoResolution: 'VIDEO_RESOLUTION_FULL_HIGH',
          sdp: webRTCOffer.sdp,
        });

        if (homeFoyerResponse.status !== 0) {
          this.connected = undefined;
          this?.log?.debug && this.log.debug('WebRTC offer was not agreed with remote for uuid "%s"', this.uuid);
        }

        if (
          homeFoyerResponse.status === 0 &&
          homeFoyerResponse.data?.[0]?.responseType === 'answer' &&
          homeFoyerResponse.data?.[0]?.streamId !== undefined
        ) {
          this?.log?.debug && this.log.debug('WebRTC offer agreed with remote for uuid "%s"', this.uuid);

          this.#audioTransceiver?.onTrack &&
            this.#audioTransceiver.onTrack.subscribe((track) => {
              this.#handlePlaybackBegin(track);

              track.onReceiveRtp.subscribe((rtp) => {
                this.#handlePlaybackPacket(rtp);
              });
            });

          this.#videoTransceiver?.onTrack &&
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
          this.#peerConnection &&
            (await this.#peerConnection.setRemoteDescription({
              type: 'answer',
              sdp: homeFoyerResponse.data[0].sdp,
            }));

          this?.log?.debug && this.log.debug('Playback started from WebRTC for uuid "%s" with session ID "%s"', this.uuid, this.#id);
          this.connected = true;

          // Monitor connection status. If closed and there are still output streams, re-connect
          // Never seem to get a 'connected' status. Could use that for something?
          this.#peerConnection &&
            this.#peerConnection.connectionStateChange.subscribe((state) => {
              if (state !== 'connected' && state !== 'connecting') {
                this?.log?.debug && this.log.debug('Connection closed to WebRTC for uuid "%s"', this.uuid);
                this.connected = undefined;
                if (this.haveOutputs() === true) {
                  this.connect();
                }
              }
            });

          // Create a timer to extend the active stream every period as defined
          this.extendTimer = setInterval(async () => {
            if (
              this.#googleHomeFoyer !== undefined &&
              this.connected === true &&
              this.#id !== undefined &&
              this.#googleHomeDeviceUUID !== undefined
            ) {
              let homeFoyerResponse = await this.#googleHomeFoyerCommand('CameraService', 'JoinStream', {
                command: 'extend',
                deviceId: this.uuid,
                streamId: this.#id,
              });

              if (homeFoyerResponse?.data?.[0]?.streamExtensionStatus !== 'STATUS_STREAM_EXTENDED') {
                this?.log?.debug && this.log.debug('Error occurred while requested stream extension for uuid "%s"', this.uuid);

                if (typeof this.#peerConnection?.close === 'function') {
                  await this.#peerConnection.close();
                }
              }
            }
          }, EXTENDINTERVAL);
        }
      }
    }
  }

  async close() {
    if (this.#id !== undefined) {
      if (this.audio?.talking !== undefined) {
        // If we're starting or started talk, stop it
        await this.#googleHomeFoyerCommand('CameraService', 'SendTalkback', {
          googleDeviceId: {
            value: this.#googleHomeDeviceUUID,
          },
          streamId: this.#id,
          command: 'COMMAND_STOP',
        });
      }

      this?.log?.debug && this.log.debug('Notifying remote about closing connection for uuid "%s"', this.uuid);
      await this.#googleHomeFoyerCommand('CameraService', 'JoinStream', {
        command: 'end',
        deviceId: this.uuid,
        streamId: this.#id,
        endStreamReason: 'REASON_USER_EXITED_SESSION',
      });
    }

    if (this.#googleHomeFoyer !== undefined) {
      this.#googleHomeFoyer.destroy();
    }

    if (typeof this.#peerConnection?.close === 'function') {
      await this.#peerConnection.close();
    }

    clearInterval(this.extendTimer);
    clearInterval(this.stalledTimer);
    this.extendTimer = undefined;
    this.stalledTimer = undefined;
    this.#id = undefined;
    this.#googleHomeFoyer = undefined;
    this.#peerConnection = undefined;
    this.#videoTransceiver = undefined;
    this.#audioTransceiver = undefined;
    this.connected = undefined;
    this.video = {};
    this.audio = {};
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
    if (
      Buffer.isBuffer(talkingData) === false ||
      this.#googleHomeDeviceUUID === undefined ||
      this.#id === undefined ||
      typeof this.#audioTransceiver?.sender?.sendRtp !== 'function'
    ) {
      return;
    }

    if (talkingData.length !== 0) {
      if (this.audio?.talking === undefined) {
        this.audio.talking = false;
        let homeFoyerResponse = await this.#googleHomeFoyerCommand('CameraService', 'SendTalkback', {
          googleDeviceId: {
            value: this.#googleHomeDeviceUUID,
          },
          streamId: this.#id,
          command: 'COMMAND_START',
        });

        if (homeFoyerResponse?.status !== 0) {
          this.audio.talking = undefined;
          this?.log?.debug && this.log.debug('Error occurred while requesting talkback to start for uuid "%s"', this.uuid);
        }
        if (homeFoyerResponse?.status === 0) {
          this.audio.talking = true;
          this?.log?.debug && this.log.debug('Talking start on uuid "%s"', this.uuid);
        }
      }

      if (this.audio.talking === true) {
        // Output talkdata to stream. We need to generate an RTP packet for data
        let rtpHeader = new werift.RtpHeader();
        rtpHeader.ssrc = this.#audioTransceiver.sender.ssrc;
        rtpHeader.marker = true;
        rtpHeader.payloadOffset = RTP_PACKET_HEADER_SIZE;
        rtpHeader.payloadType = this.audio.id; // As the camera is send/recv, we use the same payload type id as the incoming audio
        rtpHeader.timestamp = Date.now() & 0xffffffff; // Think the time stamp difference should be 960ms per audio packet?
        rtpHeader.sequenceNumber = this.audio.talkSquenceNumber++ & 0xffff;
        let rtpPacket = new werift.RtpPacket(rtpHeader, talkingData);
        this.#audioTransceiver.sender.sendRtp(rtpPacket.serialize());
      }
    }

    if (talkingData.length === 0 && this.audio?.talking === true) {
      // Buffer length of zero, ised to signal no more talking data for the moment
      let homeFoyerResponse = await this.#googleHomeFoyerCommand('CameraService', 'SendTalkback', {
        googleDeviceId: {
          value: this.#googleHomeDeviceUUID,
        },
        streamId: this.#id,
        command: 'COMMAND_STOP',
      });
      if (homeFoyerResponse?.status !== 0) {
        this?.log?.debug && this.log.debug('Error occurred while requesting talkback to stop for uuid "%s"', this.uuid);
      }
      if (homeFoyerResponse?.status === 0) {
        this?.log?.debug && this.log.debug('Talking ended on uuid "%s"', this.uuid);
      }
      this.audio.talking = undefined;
    }
  }

  #handlePlaybackBegin(weriftTrack) {
    if (weriftTrack === undefined || typeof weriftTrack !== 'object') {
      return;
    }

    if (weriftTrack?.kind === 'audio') {
      // Store details about the audio track
      this.audio = {
        id: weriftTrack.codec.payloadType, // Audio track payload type being used
        startTime: Date.now(),
        sampleRate: 48000,
        opus: undefined, // Buffer for processing incoming Opus RTP packets
        talkSquenceNumber: weriftTrack?.sender?.sequenceNumber === undefined ? 0 : weriftTrack.sender.sequenceNumber,
        talking: undefined, // undefined = not connected, false = connecting, true = connected and talking
      };
    }

    if (weriftTrack?.kind === 'video') {
      // Store details about the video track
      this.video = {
        id: weriftTrack.codec.payloadType, // Video track payload type being used
        startTime: Date.now(),
        sampleRate: 90000,
        h264: undefined, // Buffer for processing incoming fragmented H264 RTP packets
      };
    }
  }

  async #handlePlaybackPacket(weriftRtpPacket) {
    if (weriftRtpPacket === undefined || typeof weriftRtpPacket !== 'object') {
      return;
    }

    // Setup up a timeout to monitor for no packets recieved in a certain period
    // If its trigger, we'll attempt to restart the stream and/or connection
    clearTimeout(this.stalledTimer);
    this.stalledTimer = setTimeout(async () => {
      this?.log?.debug &&
        this.log.debug(
          'We have not received any data from webrtc in the past "%s" seconds for uuid "%s". Attempting restart',
          10,
          this.uuid,
        );

      if (typeof this.#peerConnection?.close === 'function') {
        await this.#peerConnection.close();
      }
    }, 10000);

    if (weriftRtpPacket.header.payloadType !== undefined && weriftRtpPacket.header.payloadType === this.video?.id) {
      // Process video RTP packets. Need to re-assemble the H264 NALUs into a single H264 frame we can output
      if (weriftRtpPacket.header.padding === false) {
        this.video.h264 = werift.H264RtpPayload.deSerialize(weriftRtpPacket.payload, this.video.h264?.fragment);
        if (this.video.h264?.payload !== undefined) {
          this.addToOutput('video', this.video.h264.payload);
          this.video.h264 = undefined;
        }
      }
    }

    if (weriftRtpPacket.header.payloadType !== undefined && weriftRtpPacket.header.payloadType === this.audio?.id) {
      // Process audio RTP packet
      this.audio.opus = werift.OpusRtpPayload.deSerialize(weriftRtpPacket.payload);
      if (this.audio.opus?.payload !== undefined) {
        // Until work out audio, send blank aac
        this.addToOutput('audio', AACMONO48000BLANK);

        // Decode payload to opus??
        //this.addToOutput('audio', this.audio.opus.payload);
      }
    }
  }

  // Need more work in here*
  // <--- error handling
  // <--- timeout?
  async #googleHomeFoyerCommand(service, command, values) {
    if (typeof service !== 'string' || service === '' || typeof command !== 'string' || command === '' || typeof values !== 'object') {
      return;
    }

    // Attempt to retrieve both 'Request' and 'Reponse' traits for the associated service and command
    let TraitMapRequest = this.#protobufFoyer.lookup(GOOGLEHOMEFOYERPREFIX + command + 'Request');
    let TraitMapResponse = this.#protobufFoyer.lookup(GOOGLEHOMEFOYERPREFIX + command + 'Response');
    let buffer = Buffer.alloc(0);
    let commandResponse = {
      status: undefined,
      message: '',
      data: [],
    };

    if (TraitMapRequest !== null && TraitMapResponse !== null && this.token !== undefined) {
      if (this.#googleHomeFoyer === undefined || (this.#googleHomeFoyer?.connected === false && this.#googleHomeFoyer?.closed === true)) {
        // No current HTTP/2 connection or current session is closed
        this?.log?.debug && this.log.debug('Connection started to Google Home Foyer');
        this.#googleHomeFoyer = http2.connect('https://googlehomefoyer-pa.googleapis.com');

        this.#googleHomeFoyer.on('connect', () => {
          this?.log?.debug && this.log.debug('Connection established to Google Home Foyer');

          clearInterval(this.pingTimer);
          this.pingTimer = setInterval(() => {
            if (this.#googleHomeFoyer !== undefined) {
              // eslint-disable-next-line no-unused-vars
              this.#googleHomeFoyer.ping((error, duration, payload) => {
                // Do we log error to debug?
              });
            }
          }, 60000); // Every minute?
        });

        // eslint-disable-next-line no-unused-vars
        this.#googleHomeFoyer.on('goaway', (errorCode, lastStreamID, opaqueData) => {
          //console.log('http2 goaway', errorCode);
        });

        // eslint-disable-next-line no-unused-vars
        this.#googleHomeFoyer.on('error', (error) => {
          //console.log('http2 error', error);
          // Close??
        });

        this.#googleHomeFoyer.on('close', () => {
          clearInterval(this.pingTimer);
          this.pingTimer = undefined;
          this.#googleHomeFoyer = undefined;
          this?.log?.debug && this.log.debug('Connection closed to Google Home Foyer');
        });
      }

      let request = this.#googleHomeFoyer.request({
        ':method': 'post',
        ':path': '/' + GOOGLEHOMEFOYERPREFIX + service + '/' + command,
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
            // We don't have enough data in the buffer yet to process the data
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
        commandResponse.status = error.code;
        commandResponse.message = error.message;
        commandResponse.data = [];
        request.close();
      });

      if (request !== undefined && request?.closed === false && request?.destroyed === false) {
        // Encode our request values, prefix with header (size of data), then send
        let encodedData = TraitMapRequest.encode(TraitMapRequest.fromObject(values)).finish();
        let header = Buffer.alloc(5);
        header.writeUInt32BE(encodedData.length, 1);
        request.write(Buffer.concat([header, encodedData]));
        request.end();

        await EventEmitter.once(request, 'close');
      }

      request.destroy(); // No longer need this request
    }

    return commandResponse;
  }
}
