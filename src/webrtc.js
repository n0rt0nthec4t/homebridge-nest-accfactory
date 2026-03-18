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
// Code version 2026.03.18
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
                setInterval(() => {
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
                if (this.isStreaming() === true || this.isBuffering() === true) {
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

    clearInterval(this.#extendTimer);
    clearInterval(this.#stalledTimer);
    clearInterval(this.#pingTimer);
    clearInterval(this.video?.h264?.spsPpsRefreshTimer);
    this.#extendTimer = undefined;
    this.#stalledTimer = undefined;
    this.#pingTimer = undefined;
    this.#streamId = undefined;
    this.#googleHomeFoyer = undefined;
    this.#peerConnection = undefined;
    this.#videoTransceiver = undefined;
    this.#audioTransceiver = undefined;
    this.connected = undefined;
    this.video = {};
    this.audio = {};
  }

  #startSpsRefreshTimer() {
    // Start a timer that periodically re-emits cached SPS/PPS to keep them fresh in the buffer
    // Prevents them from aging out (5s max) before ffmpeg connects to read the stream
    if (this.video?.h264?.spsPpsRefreshTimer !== undefined) {
      return; // Already running
    }

    this.video.h264.spsPpsRefreshTimer = setInterval(() => {
      // Skip if video/h264 has been cleaned up (e.g., during shutdown)
      if (typeof this.video?.h264 !== 'object') {
        return;
      }

      // Re-emit cached SPS/PPS with current timestamp to keep them fresh in the buffer
      let currentTimestamp = Date.now();

      if (Buffer.isBuffer(this.video.h264.lastSPS) === true && this.video.h264.lastSPS.length > 0) {
        this.add(Streamer.PACKET_TYPE.VIDEO, this.video.h264.lastSPS, currentTimestamp);
      }

      if (Buffer.isBuffer(this.video.h264.lastPPS) === true && this.video.h264.lastPPS.length > 0) {
        this.add(Streamer.PACKET_TYPE.VIDEO, this.video.h264.lastPPS, currentTimestamp);
      }

      // Update timestamp to indicate we just emitted SPS/PPS
      this.video.h264.lastSpsEmitTime = currentTimestamp;
    }, 2000); // Re-emit every 2 seconds to stay within 5s buffer window
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
      // Just update the token, don't reconnect
      this?.log?.debug?.(
        'OAuth2 access token has changed for uuid "%s" while webRTC session is active. Updating stored token.',
        this.nest_google_device_uuid,
      );
      this.token = deviceData.apiAccess.oauth2;
      // Let the extend timer handle re-auth with new token
      // If extend fails, the error handling will close and reconnect
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
        opus: undefined,
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
        h264: {
          // FU-A reassembly state
          fuBuffer: undefined,
          fuTimer: undefined,
          fuSeqStart: undefined,
          fuType: undefined,
          fuTimestamp: undefined,

          // SPS/PPS caching & emission tracking
          lastSPS: undefined,
          lastPPS: undefined,
          lastSpsEmitTime: undefined, // Timestamp of last SPS/PPS emit for periodic re-checking
          spsPpsRefreshTimer: undefined, // Timer to periodically re-emit SPS/PPS to keep fresh in buffer

          // basic seq tracking
          lastSeq: undefined,
        },
      };
    }
  }

  #handlePlaybackPacket(rtpPacket) {
    if (typeof rtpPacket !== 'object' || rtpPacket === undefined) {
      return;
    }

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

    // Create timer for stalled rtp output. Restart stream if so
    clearTimeout(this.#stalledTimer);
    this.#stalledTimer = setTimeout(async () => {
      await this.#peerConnection?.close?.();
    }, 10000);

    // Video packet processing
    if (rtpPacket.header.payloadType === this.video?.id) {
      if (this.video?.h264 === undefined) {
        return;
      }

      let seq = rtpPacket.header.sequenceNumber;

      if (this.video.h264.lastSeq !== undefined) {
        let gap = (seq - this.video.h264.lastSeq + 0x10000) % 0x10000;
        if (gap !== 1) {
          // sequence gap (ignored silently)
          // If we were in the middle of FU-A reassembly, drop it
          if (Array.isArray(this.video.h264.fuBuffer) === true) {
            clearTimeout(this.video.h264.fuTimer);
            this.video.h264.fuBuffer = undefined;
            this.video.h264.fuTimer = undefined;
            this.video.h264.fuSeqStart = undefined;
            this.video.h264.fuType = undefined;
            this.video.h264.fuTimestamp = undefined;
          }
        }
      }

      this.video.h264.lastSeq = seq;

      let payload = rtpPacket.payload;
      if (Buffer.isBuffer(payload) === false || payload.length < 1) {
        return;
      }

      let nalType = payload[0] & 0x1f;

      // STAP-A (Single-Time Aggregation Packet)
      if (nalType === Streamer.H264NALUS.TYPES.STAP_A) {
        let timestamp = calculateTimestamp(rtpPacket, this.video);
        let offset = 1;
        let foundSPS = false;
        let foundPPS = false;

        while (offset + 2 <= payload.length) {
          let size = payload.readUInt16BE(offset);
          offset += 2;
          if (size < 1 || offset + size > payload.length) {
            break;
          }
          let nalu = payload.subarray(offset, offset + size);
          let type = nalu[0] & 0x1f;

          if (type === Streamer.H264NALUS.TYPES.SPS) {
            this.video.h264.lastSPS = Buffer.from(nalu); // Clone to avoid sharing
            this.add(Streamer.PACKET_TYPE.VIDEO, this.video.h264.lastSPS, timestamp);
            foundSPS = true;
          } else if (type === Streamer.H264NALUS.TYPES.PPS) {
            this.video.h264.lastPPS = Buffer.from(nalu); // Clone to avoid sharing
            this.add(Streamer.PACKET_TYPE.VIDEO, this.video.h264.lastPPS, timestamp);
            foundPPS = true;
          } else {
            // Output other NALs (slicing, etc) as-is from STAP-A
            this.add(Streamer.PACKET_TYPE.VIDEO, Buffer.from(nalu), timestamp);
          }

          offset += size;
        }

        if (foundSPS === true || foundPPS === true) {
          this.video.h264.lastSpsEmitTime = timestamp;

          // Start refresh timer to keep SPS/PPS fresh in buffer if not already running
          if (this.video.h264.spsPpsRefreshTimer === undefined) {
            this.#startSpsRefreshTimer();
          }
        }
        return;
      }

      // FU-A
      if (nalType === Streamer.H264NALUS.TYPES.FU_A) {
        if (payload.length < 2) {
          return;
        }

        let indicator = payload[0];
        let header = payload[1];

        let start = (header & 0x80) !== 0;
        let end = (header & 0x40) !== 0;
        let type = header & 0x1f;

        let nalHeader = (indicator & 0xe0) | type;

        if (start === true) {
          // Start a new FU-A reassembly
          clearTimeout(this.video.h264.fuTimer);

          this.video.h264.fuBuffer = [Buffer.from([nalHeader]), payload.subarray(2)];
          this.video.h264.fuSeqStart = rtpPacket.header.sequenceNumber;
          this.video.h264.fuType = type;
          this.video.h264.fuTimestamp = rtpPacket.header.timestamp;

          // Safety timer: if we don't see the end fragment, drop the partial frame
          this.video.h264.fuTimer = setTimeout(() => {
            if (typeof this.video?.h264 !== 'object') {
              return;
            }
            this.video.h264.fuBuffer = undefined;
            this.video.h264.fuTimer = undefined;
            this.video.h264.fuSeqStart = undefined;
            this.video.h264.fuType = undefined;
            this.video.h264.fuTimestamp = undefined;
          }, 2000);

          return;
        }

        if (Array.isArray(this.video.h264.fuBuffer) === false) {
          return;
        }

        // If timestamp changes mid-frame, drop the current FU-A (bad/mixed fragments)
        if (this.video.h264.fuTimestamp !== undefined && this.video.h264.fuTimestamp !== rtpPacket.header.timestamp) {
          clearTimeout(this.video.h264.fuTimer);
          this.video.h264.fuBuffer = undefined;
          this.video.h264.fuTimer = undefined;
          this.video.h264.fuSeqStart = undefined;
          this.video.h264.fuType = undefined;
          this.video.h264.fuTimestamp = undefined;
          return;
        }

        this.video.h264.fuBuffer.push(payload.subarray(2));

        if (end === true) {
          clearTimeout(this.video.h264.fuTimer);

          let buffer = Buffer.concat(this.video.h264.fuBuffer);
          this.video.h264.fuBuffer = undefined;
          this.video.h264.fuTimer = undefined;
          this.video.h264.fuSeqStart = undefined;

          let timestamp = calculateTimestamp(rtpPacket, this.video);

          // Before outputting ANY FU-A frame, ensure SPS/PPS were emitted recently (within 1 second)
          let now = Date.now();
          let timeSinceSpsEmit = this.video.h264.lastSpsEmitTime ? now - this.video.h264.lastSpsEmitTime : Infinity;

          if (timeSinceSpsEmit > 1000) {
            // More than 1 second since last SPS/PPS emit, send them again to ensure new consumers get them
            let hasSPS = Buffer.isBuffer(this.video.h264.lastSPS) === true && this.video.h264.lastSPS.length > 0;
            let hasPPS = Buffer.isBuffer(this.video.h264.lastPPS) === true && this.video.h264.lastPPS.length > 0;

            if (hasSPS === true) {
              this.add(Streamer.PACKET_TYPE.VIDEO, this.video.h264.lastSPS, timestamp);
              this.video.h264.lastSpsEmitTime = now;
            }

            if (hasPPS === true) {
              this.add(Streamer.PACKET_TYPE.VIDEO, this.video.h264.lastPPS, timestamp);
            }
          }

          this.video.h264.fuType = undefined;
          this.video.h264.fuTimestamp = undefined;

          this.add(Streamer.PACKET_TYPE.VIDEO, buffer, timestamp);
        }

        return;
      }

      // Raw NAL
      let type = nalType;
      if (type === 0) {
        return;
      }

      let timestamp = calculateTimestamp(rtpPacket, this.video);

      // Handle standalone NAL units (SPS/PPS)
      if (type === Streamer.H264NALUS.TYPES.SPS) {
        this.video.h264.lastSPS = payload;
        this.add(Streamer.PACKET_TYPE.VIDEO, payload, timestamp);
        this.video.h264.lastSpsEmitTime = timestamp;

        // Start refresh timer to keep SPS/PPS fresh in buffer if not already running
        if (this.video.h264.spsPpsRefreshTimer === undefined) {
          this.#startSpsRefreshTimer();
        }
        return;
      }
      if (type === Streamer.H264NALUS.TYPES.PPS) {
        this.video.h264.lastPPS = payload;
        this.add(Streamer.PACKET_TYPE.VIDEO, payload, timestamp);
        this.video.h264.lastSpsEmitTime = timestamp;

        // Start refresh timer to keep SPS/PPS fresh in buffer if not already running
        if (this.video.h264.spsPpsRefreshTimer === undefined) {
          this.#startSpsRefreshTimer();
        }
        return;
      }

      // Before outputting ANY frame, ensure SPS/PPS were emitted recently (within 1 second)
      let now = Date.now();
      let timeSinceSpsEmit = this.video.h264.lastSpsEmitTime ? now - this.video.h264.lastSpsEmitTime : Infinity;

      if (timeSinceSpsEmit > 1000) {
        // More than 1 second since last SPS/PPS emit, send them again to ensure new consumers get them
        let hasSPS = Buffer.isBuffer(this.video.h264.lastSPS) === true && this.video.h264.lastSPS.length > 0;
        let hasPPS = Buffer.isBuffer(this.video.h264.lastPPS) === true && this.video.h264.lastPPS.length > 0;

        if (hasSPS === true) {
          this.add(Streamer.PACKET_TYPE.VIDEO, this.video.h264.lastSPS, timestamp);
          this.video.h264.lastSpsEmitTime = now;
        }

        if (hasPPS === true) {
          this.add(Streamer.PACKET_TYPE.VIDEO, this.video.h264.lastPPS, timestamp);
        }
      }

      this.add(Streamer.PACKET_TYPE.VIDEO, payload, timestamp);
      return;
    }

    // Audio packet processing
    if (rtpPacket.header.payloadType === this.audio?.id) {
      let opus = werift.OpusRtpPayload.deSerialize(rtpPacket.payload);
      if (opus?.payload?.[0] === 0xfc) {
        return;
      }

      let timestamp = calculateTimestamp(rtpPacket, this.audio);
      try {
        let pcm = this.#opusDecoder.decode(opus.payload);
        this.add(Streamer.PACKET_TYPE.AUDIO, Buffer.from(pcm), timestamp);
      } catch {
        this.add(Streamer.PACKET_TYPE.AUDIO, PCM_S16LE_48000_STEREO_BLANK, timestamp);
      }
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
