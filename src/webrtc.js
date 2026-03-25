// WebRTC
// Part of homebridge-nest-accfactory
//
// Handles WebRTC peer connection and streaming with Google Nest API
// Manages bidirectional media streams (audio/video) using SRTP encryption
// Handles connection lifecycle, ICE candidates, and stream synchronization
//
// Extends Streamer base class to provide WebRTC-specific streaming capabilities
// Supports live streaming and talkback audio over WebRTC connections
//
// Key features:
// - WebRTC peer connection management using werift library
// - SRTP encryption for secure media transport
// - Opus audio codec support with decoder
// - Protobuf message handling for protocol communication
// - ICE candidate exchange and connection state tracking
// - Two-way audio (talkback) support over bidirectional media streams
//
// Note: Currently a "work in progress" - feature set may expand
//
// Code version 2026.03.25
// Mark Hulskamp
'use strict';

// Define external library requirements
import protobuf from 'protobufjs';
import * as werift from 'werift';
import { Decoder } from '@evan/opus';

// Define nodejs module requirements
import EventEmitter from 'node:events';
import http2 from 'node:http2';
import { Buffer } from 'node:buffer';
import { setInterval, clearInterval, setTimeout, clearTimeout } from 'node:timers';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Define our modules
import Streamer from './streamer.js';

// Define constants
import { USER_AGENT, __dirname } from './consts.js';

const EXTEND_INTERVAL = 30000; // Send extend command to Google Home Foyer every this period for active streams
const GOOGLE_HOME_FOYER_REQUEST_TIMEOUT = 15000; // Client-side timeout for Google Home Foyer gRPC requests
const GOOGLE_HOME_FOYER_BUFFER_INITIAL = 8 * 1024; // Initial 8KB buffer for gRPC responses
const GOOGLE_HOME_FOYER_BUFFER_MAX = 10 * 1024 * 1024; // Maximum 10MB buffer limit
const RTP_PACKET_HEADER_SIZE = 12;
const RTP_VIDEO_PAYLOAD_TYPE = 102;
const RTP_AUDIO_PAYLOAD_TYPE = 111;
//const RTP_TALKBACK_PAYLOAD_TYPE = 110;
const GOOGLE_HOME_FOYER_PREFIX = 'google.internal.home.foyer.v1.';

// Blank audio in Opus format, mono channel @48000
const PCM_S16LE_48000_STEREO_BLANK = Buffer.alloc(1920 * 2 * 2); // 20ms stereo silence at 48kHz

// WebRTC object
export default class WebRTC extends Streamer {
  token = undefined; // oauth2 token
  localAccess = false; // Do we try direct local access to the camera or via Google Home first
  blankAudio = PCM_S16LE_48000_STEREO_BLANK;
  video = {}; // Video stream details once connected
  audio = {}; // Audio stream details once connected

  // Internal data only for this class
  #protobufFoyer = undefined; // Protobuf for Google Home Foyer
  #googleHomeFoyer = undefined; // HTTP/2 connection to Google Home Foyer APIs
  #googleHomeFoyerAPIHost = 'https://googlehomefoyer-pa.googleapis.com'; // Default API endpoint for Google Home Foyer
  #streamId = undefined; // Stream ID
  #googleHomeDeviceUUID = undefined; // Normal Nest/Google protobuf device ID translated to a Google Foyer device ID
  #peerConnection = undefined;
  #videoTransceiver = undefined;
  #audioTransceiver = undefined;
  #opusDecoder = new Decoder({ channels: 2, sample_rate: 48000 });
  #extendTimer = undefined; // Stream extend timer
  #stalledTimer = undefined; // Timer object for no received data
  #pingTimer = undefined; // Google Home Foyer periodic ping
  #rtcpPLITimer = undefined; // Timer for sending periodic RTCP PLIs

  // Codecs being used for video, audio and talking
  get codecs() {
    return {
      video: Streamer.CODEC_TYPE.H264, // Video is H264
      audio: Streamer.CODEC_TYPE.PCM, // Audio is PCM (we decode Opus to PCM output)
      talkback: Streamer.CODEC_TYPE.OPUS, // Talking is also Opus
    };
  }

  // Capabilities supported by this streamer
  get capabilities() {
    return {
      live: true,
      record: true,
      talkback: true,
      buffering: true,
    };
  }

  constructor(uuid, deviceData, options) {
    super(uuid, deviceData, options);

    // Load the protobuf for Google Home Foyer. Needed to communicate with camera devices using webrtc
    if (fs.existsSync(path.resolve(__dirname + '/protobuf/googlehome/foyer.proto')) === true) {
      protobuf.util.Long = null;
      protobuf.configure();
      this.#protobufFoyer = protobuf.loadSync(path.resolve(__dirname + '/protobuf/googlehome/foyer.proto'));
    }

    // Store data we need from the device data passed it
    this.token = deviceData?.apiAccess?.oauth2;
    this.localAccess = deviceData?.localAccess === true;

    // Update Google Home Foyer api host if using field test
    if (deviceData?.apiAccess?.fieldTest === true) {
      this.#googleHomeFoyerAPIHost = 'https://preprod-googlehomefoyer-pa.sandbox.googleapis.com';
    }
  }

  // Class functions
  async connect() {
    clearInterval(this.#extendTimer);
    clearTimeout(this.#stalledTimer);
    this.#extendTimer = undefined;
    this.#stalledTimer = undefined;
    this.#streamId = undefined;

    if (this.online === true && this.videoEnabled === true) {
      if (this.#googleHomeDeviceUUID === undefined) {
        // We don't have the 'google id' yet for this device, so obtain
        let homeFoyerResponse = await this.#googleHomeFoyerCommand('StructuresService', 'GetHomeGraph', {
          requestId: crypto.randomUUID(),
        });

        // Translate our uuid (DEVICE_xxxxxxxxxx) into the associated 'google id' from the Google Home Foyer
        // We need this id for SOME calls to Google Home Foyer services. Gotta love consistency :-)
        if (homeFoyerResponse?.data?.[0]?.homes !== undefined) {
          Object.values(homeFoyerResponse?.data?.[0]?.homes || {}).forEach((home) => {
            Object.values(home?.devices || {}).forEach((device) => {
              if (device?.id?.googleUuid !== undefined && device?.otherIds?.otherThirdPartyId !== undefined) {
                // Test to see if our uuid matches here
                let currentGoogleUuid = device?.id?.googleUuid;
                Object.values(device?.otherIds?.otherThirdPartyId || {}).forEach((other) => {
                  if (other?.id === this.nest_google_device_uuid) {
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
          this?.log?.debug?.('Request to start camera viewing was not accepted for uuid "%s"', this.nest_google_device_uuid);
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
                  rtcpFeedback: [{ type: 'nack' }],
                  parameters: 'minptime=10;useinbandfec=1',
                  payloadType: RTP_AUDIO_PAYLOAD_TYPE,
                }),
              ],
              video: [
                // H264 Baseline profile (constrained), Level 4.2
                new werift.RTCRtpCodecParameters({
                  mimeType: 'video/H264',
                  clockRate: 90000,
                  rtcpFeedback: [{ type: 'ccm', parameter: 'fir' }, { type: 'nack', parameter: 'pli' }, { type: 'goog-remb' }],
                  parameters: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e02a',
                  payloadType: RTP_VIDEO_PAYLOAD_TYPE,
                }),
              ],
            },
            headerExtensions: {
              audio: [werift.useAudioLevelIndication()],
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

          this?.log?.debug?.('Sending WebRTC offer for uuid "%s"', this.nest_google_device_uuid);

          homeFoyerResponse = await this.#googleHomeFoyerCommand('CameraService', 'JoinStream', {
            command: 'offer',
            deviceId: this.nest_google_device_uuid,
            local: this.localAccess,
            streamContext: 'STREAM_CONTEXT_DEFAULT',
            requestedVideoResolution: 'VIDEO_RESOLUTION_FULL_HIGH',
            sdp: webRTCOffer.sdp,
          });

          if (homeFoyerResponse.status !== 0) {
            this.connected = undefined;
            this?.log?.debug?.('WebRTC offer was not agreed with remote for uuid "%s"', this.nest_google_device_uuid);
          }

          if (
            homeFoyerResponse.status === 0 &&
            homeFoyerResponse.data?.[0]?.responseType === 'answer' &&
            homeFoyerResponse.data?.[0]?.streamId !== undefined
          ) {
            this?.log?.debug?.('WebRTC offer agreed with remote for uuid "%s"', this.nest_google_device_uuid);

            this.#audioTransceiver?.onTrack?.subscribe?.((track) => {
              this.#handlePlaybackBegin(track);

              track.onReceiveRtp.subscribe((rtp) => {
                this.#handlePlaybackPacket(rtp);
              });
            });

            this.#videoTransceiver?.onTrack?.subscribe?.((track) => {
              this.#handlePlaybackBegin(track);

              track.onReceiveRtp.subscribe((rtp) => {
                this.#handlePlaybackPacket(rtp);
              });
              track.onReceiveRtcp.once(() => {
                this.#rtcpPLITimer = setInterval(() => {
                  this.#videoTransceiver?.receiver?.sendRtcpPLI?.(track.ssrc);
                }, 2000);
              });
            });

            this.#streamId = homeFoyerResponse.data[0].streamId;

            await this.#peerConnection?.setRemoteDescription?.({
              type: 'answer',
              sdp: homeFoyerResponse.data[0].sdp,
            });

            this?.log?.debug?.(
              'Playback started from WebRTC for uuid "%s" with stream ID "%s"',
              this.nest_google_device_uuid,
              this.#streamId,
            );
            this.connected = true;

            // Monitor connection status. If closed and there are still output streams, re-connect
            // Never seem to get a 'connected' status. Could use that for something?
            this.#peerConnection?.iceConnectionStateChange?.subscribe?.((state) => {
              if (state !== 'connected' && state !== 'connecting') {
                this?.log?.debug?.('Connection closed to WebRTC for uuid "%s"', this.nest_google_device_uuid);
                this.connected = undefined;
                if (this.hasActiveStreams() === true) {
                  this.connect();
                }
              }
            });

            // Create a timer to extend the active stream every period as defined
            this.#extendTimer = setInterval(async () => {
              if (
                this.#googleHomeFoyer !== undefined &&
                this.connected === true &&
                this.#streamId !== undefined &&
                this.#googleHomeDeviceUUID !== undefined
              ) {
                let homeFoyerResponse = await this.#googleHomeFoyerCommand('CameraService', 'JoinStream', {
                  command: 'extend',
                  deviceId: this.nest_google_device_uuid,
                  streamId: this.#streamId,
                });

                if (homeFoyerResponse?.data?.[0]?.streamExtensionStatus !== 'STATUS_STREAM_EXTENDED') {
                  this?.log?.debug?.('Error occurred while requesting stream extension for uuid "%s"', this.nest_google_device_uuid);

                  await this.#peerConnection?.close?.();
                }
              }
            }, EXTEND_INTERVAL);
          }
        }
      }
    }
  }

  async close() {
    if (this.#streamId !== undefined) {
      if (this.audio?.talking !== undefined) {
        // If we're starting or started talk, stop it
        await this.#googleHomeFoyerCommand('CameraService', 'SendTalkback', {
          googleDeviceId: {
            value: this.#googleHomeDeviceUUID,
          },
          streamId: this.#streamId,
          command: 'COMMAND_STOP',
        });
      }

      this?.log?.debug?.('Notifying remote about closing connection for uuid "%s"', this.nest_google_device_uuid);
      await this.#googleHomeFoyerCommand('CameraService', 'JoinStream', {
        command: 'end',
        deviceId: this.nest_google_device_uuid,
        streamId: this.#streamId,
        endStreamReason: 'REASON_USER_EXITED_SESSION',
      });
    }

    clearInterval(this.#pingTimer);
    this.#pingTimer = undefined;
    this.#googleHomeFoyer?.destroy?.();

    await this.#peerConnection?.close?.();

    // Clear any running timers and state related to the connection and streaming
    clearInterval(this.#rtcpPLITimer);
    clearInterval(this.#extendTimer);
    clearTimeout(this.#stalledTimer);
    clearInterval(this.#pingTimer);
    clearInterval(this.video?.h264?.spsRefreshTimer);
    clearTimeout(this.video?.h264?.fuTimer);
    this.#rtcpPLITimer = undefined;
    this.#extendTimer = undefined;
    this.#stalledTimer = undefined;
    this.#pingTimer = undefined;
    this.#streamId = undefined;
    this.#googleHomeFoyer = undefined;
    this.#peerConnection = undefined;
    this.#videoTransceiver = undefined;
    this.#audioTransceiver = undefined;
    this.connected = undefined;
    this.video = undefined;
    this.audio = undefined;
  }

  async onUpdate(deviceData) {
    if (typeof deviceData !== 'object') {
      return;
    }

    if (
      typeof deviceData?.apiAccess?.oauth2 === 'string' &&
      deviceData.apiAccess.oauth2 !== '' &&
      deviceData.apiAccess.oauth2 !== this.token
    ) {
      // oauth2 token has changed, so update stored token. If we have an active connection.
      // This token will be used for the next API call that requires authentication and should succeed with the new token
      // Log this as a debug message only if we actually have active outputs
      // otherwise it can be normal for tokens to update when not streaming and would just be noise in the logs
      if (this.hasActiveStreams() === true) {
        this?.log?.debug?.(
          'OAuth2 token has changed for uuid "%s" while webRTC session is active. Updating stored token.',
          this.nest_google_device_uuid,
        );
      }

      this.token = deviceData.apiAccess.oauth2;
    }
  }

  async onShutdown() {
    await this.close(); // Gracefully close peer connection and HTTP/2 session
  }

  async sendTalkback(talkingBuffer) {
    if (
      Buffer.isBuffer(talkingBuffer) === false ||
      this.#googleHomeDeviceUUID === undefined ||
      this.#streamId === undefined ||
      typeof this.#audioTransceiver?.sender?.sendRtp !== 'function'
    ) {
      return;
    }

    if (talkingBuffer.length !== 0) {
      if (this.audio?.talking === undefined) {
        this.audio.talking = false;
        let homeFoyerResponse = await this.#googleHomeFoyerCommand('CameraService', 'SendTalkback', {
          googleDeviceId: {
            value: this.#googleHomeDeviceUUID,
          },
          streamId: this.#streamId,
          command: 'COMMAND_START',
        });

        if (homeFoyerResponse?.status !== 0) {
          this.audio.talking = undefined;
          this?.log?.debug?.('Error occurred while requesting talkback to start for uuid "%s"', this.nest_google_device_uuid);
        }
        if (homeFoyerResponse?.status === 0) {
          this.audio.talking = true;
          this?.log?.debug?.('Talking started on uuid "%s"', this.nest_google_device_uuid);
        }
      }

      if (this.audio.talking === true) {
        // Output talkdata to stream. We need to generate an RTP packet for data
        let rtpHeader = new werift.RtpHeader();
        rtpHeader.ssrc = this.#audioTransceiver.sender.ssrc;
        rtpHeader.marker = true;
        rtpHeader.payloadOffset = RTP_PACKET_HEADER_SIZE;
        rtpHeader.payloadType = this.audio.id; // As the camera is send/recv, we use the same payload type id as the incoming audio
        rtpHeader.timestamp = Date.now() >>> 0; // Think the time stamp difference should be 960ms per audio packet?
        rtpHeader.sequenceNumber = this.audio.talkSequenceNumber++ & 0xffff;
        let rtpPacket = new werift.RtpPacket(rtpHeader, talkingBuffer);
        this.#audioTransceiver.sender.sendRtp(rtpPacket.serialize());
      }
    }

    if (talkingBuffer.length === 0 && this.audio?.talking === true) {
      // Buffer length of zero, used to signal no more talking data for the moment
      let homeFoyerResponse = await this.#googleHomeFoyerCommand('CameraService', 'SendTalkback', {
        googleDeviceId: {
          value: this.#googleHomeDeviceUUID,
        },
        streamId: this.#streamId,
        command: 'COMMAND_STOP',
      });
      if (homeFoyerResponse?.status !== 0) {
        this?.log?.debug?.('Error occurred while requesting talkback to stop for uuid "%s"', this.nest_google_device_uuid);
      }
      if (homeFoyerResponse?.status === 0) {
        this?.log?.debug?.('Talking ended on uuid "%s"', this.nest_google_device_uuid);
      }
      this.audio.talking = undefined;
    }
  }

  #handlePlaybackBegin(weriftTrack) {
    // Handle the beginning of RTP playback for an audio or video track
    if (weriftTrack === undefined || typeof weriftTrack !== 'object') {
      return;
    }

    if (weriftTrack?.kind === 'audio') {
      this.audio = {
        id: weriftTrack.codec.payloadType, // RTP payload type for audio
        baseTimestamp: undefined,
        baseTime: undefined,
        sampleRate: 48000,
        lastSequence: undefined,
        talkSequenceNumber: weriftTrack?.sender?.sequenceNumber === undefined ? 0 : weriftTrack.sender.sequenceNumber,
        talking: undefined,
      };
    }

    if (weriftTrack?.kind === 'video') {
      this.video = {
        id: weriftTrack.codec.payloadType, // RTP payload type for video
        baseTimestamp: undefined,
        baseTime: undefined,
        sampleRate: 90000,
        lastSequence: undefined,
        rtpTimestamp: undefined,
        h264: {
          // FU-A reassembly state
          fuBuffer: undefined,
          fuTimer: undefined,
          fuSeqStart: undefined,
          fuType: undefined,
          fuTimestamp: undefined,

          // SPS/PPS/IDR caching & emission tracking
          lastSPS: undefined,
          lastPPS: undefined,
          lastIDR: undefined,
          lastSpsEmitTime: undefined,
          spsRefreshTimer: undefined,
        },
      };
    }
  }

  #handlePlaybackPacket(rtpPacket) {
    const calculateTimestamp = (packet, stream) => {
      if (typeof packet?.header?.timestamp !== 'number' || typeof stream?.sampleRate !== 'number') {
        return Date.now();
      }
      if (stream.baseTimestamp === undefined) {
        stream.baseTimestamp = packet.header.timestamp;
        stream.baseTime = Date.now();
      }
      // 32-bit wrap handling
      let deltaTicks = (packet.header.timestamp - stream.baseTimestamp + 0x100000000) % 0x100000000;
      let deltaMs = (deltaTicks / stream.sampleRate) * 1000;
      return stream.baseTime + deltaMs;
    };

    const emitVideoPacket = (data, timestamp, nalType, keyFrame = false) => {
      if (Buffer.isBuffer(data) !== true || data.length === 0) {
        return;
      }

      this.addPacket({
        type: Streamer.PACKET_TYPE.VIDEO,
        codec: this.codecs.video,
        timestamp: timestamp,
        keyFrame: keyFrame === true,
        data: data,
      });
    };

    const ensureSpsRefreshTimer = () => {
      clearInterval(this.video?.h264?.spsRefreshTimer);

      this.video.h264.spsRefreshTimer = setInterval(() => {
        let refreshTimestamp = Date.now();

        if (Buffer.isBuffer(this.video.h264.lastSPS) === true && this.video.h264.lastSPS.length > 0) {
          emitVideoPacket(this.video.h264.lastSPS, refreshTimestamp, Streamer.H264NALUS.TYPES.SPS, false);
        }

        if (Buffer.isBuffer(this.video.h264.lastPPS) === true && this.video.h264.lastPPS.length > 0) {
          emitVideoPacket(this.video.h264.lastPPS, refreshTimestamp, Streamer.H264NALUS.TYPES.PPS, false);
        }
      }, 5000);
    };

    if (rtpPacket?.header === undefined || Buffer.isBuffer(rtpPacket.payload) !== true) {
      return;
    }

    // If we dont receive a packet in 10s, force a reconnect
    clearTimeout(this.#stalledTimer);
    this.#stalledTimer = setTimeout(() => {
      this?.log?.debug?.(
        'No WebRTC playback packets received for uuid "%s" in the past 10 seconds. Closing connection',
        this.nest_google_device_uuid,
      );
      this.close();
    }, 10000);

    // Handle video playback packets
    if (rtpPacket.header.payloadType === this.video?.id) {
      let now = Date.now();
      let timestamp = calculateTimestamp(rtpPacket, this.video);
      let payload = rtpPacket.payload;
      let nalHeader = payload[0];
      let type = nalHeader & 0x1f;

      // Track RTP sequence numbers so we can log packet loss or reordering
      if (typeof this.video.lastSequence === 'number') {
        let expected = (this.video.lastSequence + 1) & 0xffff;
        if (rtpPacket.header.sequenceNumber !== expected) {
          this?.log?.debug?.(
            'Video RTP sequence discontinuity for uuid "%s". Expected "%s" got "%s"',
            this.nest_google_device_uuid,
            expected,
            rtpPacket.header.sequenceNumber,
          );
        }
      }
      this.video.lastSequence = rtpPacket.header.sequenceNumber;

      // Single-Time Aggregation Packet (STAP-A)
      if (type === Streamer.H264NALUS.TYPES.STAP_A) {
        let offset = 1;
        let foundSPS = false;
        let foundPPS = false;

        while (offset + 2 <= payload.length) {
          let naluLength = payload.readUInt16BE(offset);
          offset += 2;

          if (naluLength <= 0 || offset + naluLength > payload.length) {
            break;
          }

          let nalu = payload.subarray(offset, offset + naluLength);
          let naluType = nalu[0] & 0x1f;
          offset += naluLength;

          if (naluType === Streamer.H264NALUS.TYPES.SPS) {
            this.video.h264.lastSPS = Buffer.from(nalu);
            foundSPS = true;
            emitVideoPacket(this.video.h264.lastSPS, timestamp, naluType, false);
            continue;
          }

          if (naluType === Streamer.H264NALUS.TYPES.PPS) {
            this.video.h264.lastPPS = Buffer.from(nalu);
            foundPPS = true;
            emitVideoPacket(this.video.h264.lastPPS, timestamp, naluType, false);
            continue;
          }

          if (naluType === Streamer.H264NALUS.TYPES.IDR) {
            this.video.h264.lastIDR = Buffer.from(nalu);
          }

          emitVideoPacket(Buffer.from(nalu), timestamp, naluType, naluType === Streamer.H264NALUS.TYPES.IDR);
        }

        if (foundSPS === true || foundPPS === true) {
          ensureSpsRefreshTimer();
        }

        return;
      }

      // Fragmentation Unit A (FU-A)
      if (type === Streamer.H264NALUS.TYPES.FU_A) {
        let fuHeader = payload[1];
        let start = (fuHeader & 0x80) !== 0;
        let end = (fuHeader & 0x40) !== 0;
        let fuType = fuHeader & 0x1f;
        let reconstructedNal = Buffer.from([(nalHeader & 0xe0) | fuType]);
        let fragmentPayload = payload.subarray(2);

        if (start === true) {
          clearTimeout(this.video.h264.fuTimer);
          this.video.h264.fuBuffer = [reconstructedNal, fragmentPayload];
          this.video.h264.fuType = fuType;
          this.video.h264.fuTimestamp = rtpPacket.header.timestamp;
          return (this.video.h264.fuTimer = setTimeout(() => {
            this?.log?.debug?.('Discarding stale FU-A buffer for uuid "%s"', this.nest_google_device_uuid);
            this.video.h264.fuBuffer = [];
            this.video.h264.fuType = undefined;
            this.video.h264.fuTimestamp = undefined;
          }, 2000));
        }

        if (Array.isArray(this.video.h264.fuBuffer) !== true || this.video.h264.fuBuffer.length === 0) {
          return;
        }

        this.video.h264.fuBuffer.push(fragmentPayload);

        if (end === true) {
          let buffer = Buffer.concat(this.video.h264.fuBuffer);

          clearTimeout(this.video.h264.fuTimer);
          this.video.h264.fuBuffer = [];

          if (this.video.h264.fuType === Streamer.H264NALUS.TYPES.IDR) {
            if (Buffer.isBuffer(this.video.h264.lastSPS) === true && this.video.h264.lastSPS.length > 0) {
              emitVideoPacket(this.video.h264.lastSPS, timestamp, Streamer.H264NALUS.TYPES.SPS, false);
              this.video.h264.lastSpsEmitTime = now;
            }

            if (Buffer.isBuffer(this.video.h264.lastPPS) === true && this.video.h264.lastPPS.length > 0) {
              emitVideoPacket(this.video.h264.lastPPS, timestamp, Streamer.H264NALUS.TYPES.PPS, false);
            }

            this.video.h264.lastIDR = Buffer.from(buffer);
          }

          emitVideoPacket(buffer, timestamp, this.video.h264.fuType, this.video.h264.fuType === Streamer.H264NALUS.TYPES.IDR);

          this.video.h264.fuType = undefined;
          this.video.h264.fuTimestamp = undefined;
        }

        return;
      }

      // Raw NAL unit
      if (type === Streamer.H264NALUS.TYPES.SPS) {
        this.video.h264.lastSPS = Buffer.from(payload);
        emitVideoPacket(this.video.h264.lastSPS, timestamp, type, false);
        ensureSpsRefreshTimer();
        return;
      }

      if (type === Streamer.H264NALUS.TYPES.PPS) {
        this.video.h264.lastPPS = Buffer.from(payload);
        emitVideoPacket(this.video.h264.lastPPS, timestamp, type, false);
        ensureSpsRefreshTimer();
        return;
      }

      if (type === Streamer.H264NALUS.TYPES.IDR) {
        if (Buffer.isBuffer(this.video.h264.lastSPS) === true && this.video.h264.lastSPS.length > 0) {
          emitVideoPacket(this.video.h264.lastSPS, timestamp, Streamer.H264NALUS.TYPES.SPS, false);
          this.video.h264.lastSpsEmitTime = now;
        }

        if (Buffer.isBuffer(this.video.h264.lastPPS) === true && this.video.h264.lastPPS.length > 0) {
          emitVideoPacket(this.video.h264.lastPPS, timestamp, Streamer.H264NALUS.TYPES.PPS, false);
        }

        this.video.h264.lastIDR = Buffer.from(payload);
      }

      emitVideoPacket(payload, timestamp, type, type === Streamer.H264NALUS.TYPES.IDR);
      return;
    }

    // Handle audio playback packets
    if (rtpPacket.header.payloadType === this.audio?.id) {
      let timestamp = calculateTimestamp(rtpPacket, this.audio);
      let pcm = undefined;
      let opus = undefined;

      // Track RTP sequence numbers so we can log packet loss or reordering
      if (typeof this.audio.lastSequence === 'number') {
        let expected = (this.audio.lastSequence + 1) & 0xffff;
        if (rtpPacket.header.sequenceNumber !== expected) {
          this?.log?.debug?.(
            'Audio RTP sequence discontinuity for uuid "%s". Expected "%s" got "%s"',
            this.nest_google_device_uuid,
            expected,
            rtpPacket.header.sequenceNumber,
          );
        }
      }
      this.audio.lastSequence = rtpPacket.header.sequenceNumber;

      try {
        opus = werift.OpusRtpPayload.deSerialize(rtpPacket.payload);
        if (opus?.payload?.[0] === 0xfc) {
          // This is a PLC (Packet Loss Concealment) frame, so we generate blank audio instead of trying to decode it
          return;
        }
        pcm = this.#opusDecoder.decode(opus.payload);
      } catch (error) {
        this?.log?.debug?.('Error decoding Opus audio for uuid "%s": %s', this.nest_google_device_uuid, String(error));
      }

      if (Buffer.isBuffer(pcm) === true && pcm.length > 0) {
        this.addPacket({
          type: Streamer.PACKET_TYPE.AUDIO,
          codec: this.codecs.audio,
          timestamp: timestamp,
          keyFrame: false,
          data: Buffer.from(pcm),
        });
        return;
      }

      // Failed to decode Opus audio, likely due to packet loss or it being a PLC frame. Emit blank audio to maintain stream continuity
      this.addPacket({
        type: Streamer.PACKET_TYPE.AUDIO,
        codec: this.codecs.audio,
        timestamp: timestamp,
        keyFrame: false,
        data: PCM_S16LE_48000_STEREO_BLANK,
      });
    }
  }

  // Need more work in here*
  // < error handling
  // < timeout?
  async #googleHomeFoyerCommand(service, command, values) {
    if (typeof service !== 'string' || service === '' || typeof command !== 'string' || command === '' || typeof values !== 'object') {
      return;
    }

    let buffer = Buffer.allocUnsafe(GOOGLE_HOME_FOYER_BUFFER_INITIAL);
    let offset = 0;
    let TraitMapRequest = this.#protobufFoyer.lookup(GOOGLE_HOME_FOYER_PREFIX + command + 'Request');
    let TraitMapResponse = this.#protobufFoyer.lookup(GOOGLE_HOME_FOYER_PREFIX + command + 'Response');
    let commandResponse = {
      status: undefined,
      message: '',
      data: [],
    };

    if (TraitMapRequest !== null && TraitMapResponse !== null && typeof this.token === 'string' && this.token.trim() !== '') {
      try {
        if (this.#googleHomeFoyer === undefined || (this.#googleHomeFoyer?.connected === false && this.#googleHomeFoyer?.closed === true)) {
          // No current HTTP/2 connection or current session is closed
          this?.log?.debug?.('Connection started to Google Home Foyer "%s"', this.#googleHomeFoyerAPIHost);
          this.#googleHomeFoyer = http2.connect(this.#googleHomeFoyerAPIHost);
        }

        // Register event handlers if not already attached to this connection
        if (this.#googleHomeFoyer?.listenerCount?.('connect') === 0) {
          this.#googleHomeFoyer.on('connect', () => {
            this?.log?.debug?.('Connection established to Google Home Foyer "%s"', this.#googleHomeFoyerAPIHost);

            clearInterval(this.#pingTimer);
            this.#pingTimer = setInterval(() => {
              let session = this.#googleHomeFoyer;
              if (session === undefined || session.destroyed === true || session.closed === true) {
                return;
              }

              try {
                // eslint-disable-next-line no-unused-vars
                session.ping((error, duration, payload) => {
                  // Do we log error to debug?
                });
              } catch {
                clearInterval(this.#pingTimer);
                this.#pingTimer = undefined;
              }
            }, 60000); // Every minute?
          });

          // eslint-disable-next-line no-unused-vars
          this.#googleHomeFoyer.on('goaway', (errorCode, lastStreamID, opaqueData) => {
            //console.log('http2 goaway', errorCode);
          });

          this.#googleHomeFoyer.on('error', (error) => {
            this?.log?.debug?.('Google Home Foyer connection error: %s', String(error));
            clearInterval(this.#pingTimer);
            this.#pingTimer = undefined;
            try {
              this.#googleHomeFoyer.destroy();
            } catch {
              // Empty
            }
            this.#googleHomeFoyer = undefined;
          });

          this.#googleHomeFoyer.on('close', () => {
            clearInterval(this.#pingTimer);
            this.#pingTimer = undefined;
            this.#googleHomeFoyer = undefined;
            this?.log?.debug?.('Connection closed to Google Home Foyer "%s"', this.#googleHomeFoyerAPIHost);
          });
        }

        let request = this.#googleHomeFoyer.request({
          ':method': 'post',
          ':path': '/' + GOOGLE_HOME_FOYER_PREFIX + service + '/' + command,
          authorization: 'Bearer ' + this.token,
          'content-type': 'application/grpc',
          'user-agent': USER_AGENT,
          te: 'trailers',
          'request-id': crypto.randomUUID(),
          'grpc-timeout': '10S',
        });

        request.on('data', (data) => {
          if (offset + data.length > buffer.length) {
            let newSize = buffer.length * 2;
            if (newSize > GOOGLE_HOME_FOYER_BUFFER_MAX) {
              // Response exceeds maximum allowed size, reject it
              commandResponse.status = 413; // Payload too large
              commandResponse.message = 'gRPC response exceeds maximum buffer size';
              try {
                request.close();
              } catch {
                // Empty
              }
              return;
            }
            let newBuffer = Buffer.allocUnsafe(newSize);
            buffer.copy(newBuffer, 0, 0, offset);
            buffer = newBuffer;
          }

          data.copy(buffer, offset);
          offset += data.length;

          while (offset >= 5) {
            let headerSize = 5;
            let dataSize = buffer.readUInt32BE(1);
            if (offset < headerSize + dataSize) {
              break;
            }

            commandResponse.data.push(TraitMapResponse.decode(buffer.subarray(headerSize, headerSize + dataSize)).toJSON());

            buffer.copy(buffer, 0, headerSize + dataSize, offset);
            offset -= headerSize + dataSize;
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
          try {
            request.close();
          } catch {
            // Empty
          }
        });

        if (request !== undefined && request?.closed === false && request?.destroyed === false) {
          // Encode our request values, prefix with header (size of data), then send
          let encodedData = TraitMapRequest.encode(TraitMapRequest.fromObject(values)).finish();
          let header = Buffer.alloc(5);
          header.writeUInt32BE(encodedData.length, 1);
          request.write(Buffer.concat([header, encodedData]));
          request.end();

          // Set client-side timeout to prevent stuck requests
          let requestTimeout = setTimeout(() => {
            try {
              request.close();
            } catch {
              // Empty
            }
          }, GOOGLE_HOME_FOYER_REQUEST_TIMEOUT);

          request.on('close', () => clearTimeout(requestTimeout));

          await EventEmitter.once(request, 'close');
        }

        try {
          // No longer need this request
          request.destroy();
        } catch {
          // Empty
        }
      } catch (error) {
        commandResponse.status = error.code;
        commandResponse.message = String(error.message || error);
        commandResponse.data = [];

        this?.log?.debug?.('Google Home Foyer request failed: %s', commandResponse.message);
        clearInterval(this.#pingTimer);
        this.#pingTimer = undefined;
        try {
          this.#googleHomeFoyer?.destroy();
        } catch {
          // Empty
        }
        this.#googleHomeFoyer = undefined;
      }
    }

    return commandResponse;
  }
}
