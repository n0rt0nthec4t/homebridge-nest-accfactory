// WebRTC
// Part of homebridge-nest-accfactory
//
// Implements WebRTC-based streaming for Google Nest cameras using the Foyer API.
// Handles peer connection setup, RTP media processing, and integration with the
// Streamer pipeline for HomeKit live streaming and recording.
//
// Responsibilities:
// - Establish and manage RTCPeerConnection using the werift library
// - Handle ICE negotiation and connection state lifecycle
// - Receive and process RTP packets (H264 video, Opus audio)
// - Perform H264 NAL unit parsing and frame reassembly (including FU-A)
// - Decode Opus audio to PCM for downstream processing
// - Inject media into Streamer for live and recording outputs
// - Support two-way audio (talkback) via outbound RTP/Opus pipeline
//
// Features:
// - Secure media transport over DTLS-SRTP
// - RTCP feedback support (PLI/FIR/NACK) for video recovery
// - Codec negotiation (H264 video, Opus audio)
// - Startup timing and stream diagnostics logging
// - Resilient handling of packet loss and stream stalls
//
// Notes:
// - Video readiness is determined by first valid video frame (IDR), not connection state
// - ICE "connected" indicates transport readiness, not media availability
// - Startup delays may occur due to upstream (Google) video pipeline behaviour
//
// Code version 2026.03.31
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
const RTP_PACKET_HEADER_SIZE = 12; // RTP packet header size in bytes
const RTP_H264_VIDEO_PAYLOAD_TYPE = 98; // H.264 video payload type
const RTP_H264_VIDEO_RTX_PAYLOAD_TYPE = 99; // H.264 RTX payload type for retransmissions
const RTP_OPUS_AUDIO_PAYLOAD_TYPE = 111; // Opus audio payload type
const GOOGLE_HOME_FOYER_PREFIX = 'google.internal.home.foyer.v1.';
const FU_A_TIMEOUT = 1500; // Time to wait for the completion of a fragmented FU-A NAL unit before discarding the incomplete data
const IDR_TIMEOUT = 5000; // Time to wait for an IDR frame before considering the video stream stalled and attempting a reconnect
const TIMESTAMP_MAX_VIDEO_DELTA = 80;
const TIMESTAMP_MAX_AUDIO_DELTA = 120;
const STALLED_TIMEOUT = 10000; // Time with no playback packets before we consider stream stalled and attempt restart
const PCM_S16LE_48000_STEREO_BLANK = Buffer.alloc(1920 * 2 * 2); // Default blank audio frame (20ms) in PCM S16LE, stereo @ 48kHz

// WebRTC object
export default class WebRTC extends Streamer {
  token = undefined; // oauth2 token
  blankAudio = PCM_S16LE_48000_STEREO_BLANK;

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
  #reconnectPending = false; // Reconnect requested once socket closes
  #reconnectReason = undefined; // Reason for reconnect
  #tracks = { audio: {}, video: {}, talkback: {} }; // Track state for audio and video

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

    // Update Google Home Foyer api host if using field test
    if (deviceData?.apiAccess?.fieldTest === true) {
      this.#googleHomeFoyerAPIHost = 'https://preprod-googlehomefoyer-pa.sandbox.googleapis.com';
    }
  }

  // Class functions
  async connect(options = {}) {
    clearInterval(this.#extendTimer);
    clearTimeout(this.#stalledTimer);
    this.#extendTimer = undefined;
    this.#stalledTimer = undefined;
    this.#streamId = undefined;
    this.#reconnectPending = false;
    this.#reconnectReason = undefined;

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
        this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_CONNECTING);
        let homeFoyerResponse = await this.#googleHomeFoyerCommand('CameraService', 'SendCameraViewIntent', {
          request: {
            googleDeviceId: {
              value: this.#googleHomeDeviceUUID,
            },
            command: 'VIEW_INTENT_START',
          },
        });

        if (homeFoyerResponse.status !== 0) {
          this?.log?.debug?.('Request to start camera viewing was not accepted for uuid "%s"', this.nest_google_device_uuid);
          this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_CLOSED, 'view-intent-failed');
          return;
        }

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
                payloadType: RTP_OPUS_AUDIO_PAYLOAD_TYPE,
              }),
            ],
            video: [
              new werift.RTCRtpCodecParameters({
                mimeType: 'video/H264',
                clockRate: 90000,
                rtcpFeedback: [
                  { type: 'ccm', parameter: 'fir' },
                  { type: 'nack' },
                  { type: 'nack', parameter: 'pli' },
                  { type: 'goog-remb' },
                ],
                parameters: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
                payloadType: RTP_H264_VIDEO_PAYLOAD_TYPE,
              }),
              new werift.RTCRtpCodecParameters({
                mimeType: 'video/rtx',
                clockRate: 90000,
                parameters: 'apt=' + RTP_H264_VIDEO_PAYLOAD_TYPE,
                payloadType: RTP_H264_VIDEO_RTX_PAYLOAD_TYPE,
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

        // After setting our local description, we should have gathered some ICE candidates and have them included in the SDP offer.
        // We can now send this offer to the Google Home Foyer to request starting the stream and get the SDP answer back if accepted
        homeFoyerResponse = await this.#googleHomeFoyerCommand('CameraService', 'JoinStream', {
          command: 'offer',
          deviceId: this.nest_google_device_uuid,
          local: options?.localAccess === true,
          streamContext: 'STREAM_CONTEXT_DEFAULT',
          requestedVideoResolution: 'VIDEO_RESOLUTION_FULL_HIGH',
          sdp: webRTCOffer.sdp,
        });

        if (
          homeFoyerResponse.status !== 0 ||
          homeFoyerResponse.data?.[0]?.responseType !== 'answer' ||
          homeFoyerResponse.data?.[0]?.streamId === undefined ||
          homeFoyerResponse.data?.[0]?.sdp === undefined
        ) {
          // Offer was not accepted or answer was malformed, so close the peer connection and clean up state
          this.#peerConnection?.close?.();
          this.#peerConnection = undefined;
          this?.log?.debug?.('WebRTC offer was not agreed with remote for uuid "%s"', this.nest_google_device_uuid);
          this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_CLOSED, 'offer-rejected');
          return;
        }

        // Check if the answer contains a candidate with a local IP address to determine if local access has been granted
        let localAccessGranted =
          /a=candidate:.* (10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+|fd[0-9a-f]{2}:[0-9a-f:]+)/i.test(
            homeFoyerResponse.data?.[0].sdp || '',
          ) === true;

        this?.log?.debug?.(
          'WebRTC offer agreed with remote for uuid "%s"%s',
          this.nest_google_device_uuid,
          localAccessGranted === true ? ' with local access granted' : '',
        );

        this.#audioTransceiver?.onTrack?.subscribe?.((track) => {
          this.#setupTracks(track);

          track.onReceiveRtp.subscribe((rtpPacket) => {
            const audio = this.#tracks.audio;

            // If no jitter buffer or sequence number, just handle the packet immediately
            if (audio === undefined || typeof audio?.jitter !== 'object' || typeof rtpPacket?.header?.sequenceNumber !== 'number') {
              this.#handlePlaybackPacket(rtpPacket);
              return;
            }

            // Store the incoming RTP packet in the jitter buffer, keyed by sequence number
            let sequenceNumber = rtpPacket.header.sequenceNumber & 0xffff;
            audio.jitter.buffer.set(sequenceNumber, rtpPacket);

            // Initialise the expected sequence if this is the first packet
            if (typeof audio.jitter.expectedSequence !== 'number') {
              audio.jitter.expectedSequence = sequenceNumber;
            }

            // Release all in-order packets immediately (as long as the next expected sequence is present)
            while (audio.jitter.buffer.has(audio.jitter.expectedSequence) === true) {
              let packet = audio.jitter.buffer.get(audio.jitter.expectedSequence);

              // Remove from buffer and advance state
              audio.jitter.buffer.delete(audio.jitter.expectedSequence);
              audio.jitter.lastReleasedSequence = audio.jitter.expectedSequence;
              audio.jitter.expectedSequence = (audio.jitter.expectedSequence + 1) & 0xffff;
              audio.jitter.waitStart = undefined; // Reset wait timer since we are in-order again

              // Pass the packet to the playback handler
              this.#handlePlaybackPacket(packet);
            }

            // If a packet is missing (gap in sequence), start a wait timer for the missing sequence
            // Only start the timer if we haven't already
            if (
              audio.jitter.buffer.size !== 0 &&
              audio.jitter.buffer.has(audio.jitter.expectedSequence) !== true &&
              typeof audio.jitter.waitStart !== 'number'
            ) {
              audio.jitter.waitStart = Date.now();
            }

            // If the wait timer expires and the missing packet still hasn't arrived, skip it
            // This prevents the buffer from stalling on lost packets
            if (
              audio.jitter.buffer.size !== 0 &&
              audio.jitter.buffer.has(audio.jitter.expectedSequence) !== true &&
              typeof audio.jitter.waitStart === 'number' &&
              Date.now() - audio.jitter.waitStart >= audio.jitter.maxWait
            ) {
              this?.log?.debug?.(
                'Skipping missing WebRTC audio RTP packet for uuid "%s" at sequence "%s"',
                this.nest_google_device_uuid,
                audio.jitter.expectedSequence,
              );

              // Skip the missing sequence and advance
              audio.jitter.expectedSequence = (audio.jitter.expectedSequence + 1) & 0xffff;
              audio.jitter.waitStart = Date.now(); // Restart wait timer for next gap

              // After skipping, release any now-in-order packets
              while (audio.jitter.buffer.has(audio.jitter.expectedSequence) === true) {
                let packet = audio.jitter.buffer.get(audio.jitter.expectedSequence);

                audio.jitter.buffer.delete(audio.jitter.expectedSequence);
                audio.jitter.lastReleasedSequence = audio.jitter.expectedSequence;
                audio.jitter.expectedSequence = (audio.jitter.expectedSequence + 1) & 0xffff;
                audio.jitter.waitStart = undefined;

                this.#handlePlaybackPacket(packet);
              }
            }

            // If the buffer grows too large, reset it to avoid memory bloat
            if (audio.jitter.buffer.size > audio.jitter.maxSize) {
              this?.log?.debug?.('Resetting WebRTC audio jitter buffer for uuid "%s" due to overflow', this.nest_google_device_uuid);

              audio.jitter.buffer.clear();
              audio.jitter.expectedSequence = undefined;
              audio.jitter.lastReleasedSequence = undefined;
              audio.jitter.waitStart = undefined;
            }
          });
        });

        this.#videoTransceiver?.onTrack?.subscribe?.((track) => {
          this.#setupTracks(track);

          // Request a keyframe immediately to speed up startup
          this.#sendVideoPLI('startup');

          track.onReceiveRtp.subscribe((rtpPacket) => {
            const video = this.#tracks.video;
            let packet = undefined;

            if (video === undefined || typeof video?.jitter !== 'object' || typeof rtpPacket?.header?.sequenceNumber !== 'number') {
              this.#handlePlaybackPacket(rtpPacket);
              return;
            }

            // First actual video RTP packet for this track, indicates media flowing
            if (this.sourceState !== Streamer.MESSAGE_TYPE.SOURCE_READY && this.sourceState !== Streamer.MESSAGE_TYPE.SOURCE_CLOSED) {
              // Transition to READY now that we have real video packets and not closed
              this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_READY);
            }

            // Store the incoming RTP packet in the jitter buffer, keyed by sequence number
            let sequenceNumber = rtpPacket.header.sequenceNumber & 0xffff;
            video.jitter.buffer.set(sequenceNumber, rtpPacket);

            // Initialise the expected sequence if this is the first packet
            if (typeof video.jitter.expectedSequence !== 'number') {
              video.jitter.expectedSequence = sequenceNumber;
            }

            // Release all in-order packets immediately (as long as the next expected sequence is present)
            while (video.jitter.buffer.has(video.jitter.expectedSequence) === true) {
              packet = video.jitter.buffer.get(video.jitter.expectedSequence);

              // Remove from buffer and advance state
              video.jitter.buffer.delete(video.jitter.expectedSequence);
              video.jitter.lastReleasedSequence = video.jitter.expectedSequence;
              video.jitter.expectedSequence = (video.jitter.expectedSequence + 1) & 0xffff;
              video.jitter.waitStart = undefined;

              // Pass the packet to playback handler
              this.#handlePlaybackPacket(packet);
            }

            // If a packet is missing (gap in sequence), start a wait timer for the missing sequence
            // Only start the timer if we haven't already
            if (
              video.jitter.buffer.size !== 0 &&
              video.jitter.buffer.has(video.jitter.expectedSequence) !== true &&
              typeof video.jitter.waitStart !== 'number'
            ) {
              video.jitter.waitStart = Date.now();
            }

            // If the wait timer expires and the missing packet still hasn't arrived, skip it
            // This prevents the buffer from stalling on lost packets
            if (
              video.jitter.buffer.size !== 0 &&
              video.jitter.buffer.has(video.jitter.expectedSequence) !== true &&
              typeof video.jitter.waitStart === 'number' &&
              Date.now() - video.jitter.waitStart >= video.jitter.maxWait
            ) {
              this?.log?.debug?.(
                'Skipping missing WebRTC video RTP packet for uuid "%s" at sequence "%s"',
                this.nest_google_device_uuid,
                video.jitter.expectedSequence,
              );

              // Advance to the next sequence number, skipping the missing one
              video.jitter.expectedSequence = (video.jitter.expectedSequence + 1) & 0xffff;
              video.jitter.waitStart = Date.now();

              // After skipping, release any now-in-order packets
              while (video.jitter.buffer.has(video.jitter.expectedSequence) === true) {
                packet = video.jitter.buffer.get(video.jitter.expectedSequence);

                video.jitter.buffer.delete(video.jitter.expectedSequence);
                video.jitter.lastReleasedSequence = video.jitter.expectedSequence;
                video.jitter.expectedSequence = (video.jitter.expectedSequence + 1) & 0xffff;
                video.jitter.waitStart = undefined;

                // Pass the packet to playback handler
                this.#handlePlaybackPacket(packet);
              }
            }

            // If the buffer grows too large, reset it to avoid memory bloat
            if (video.jitter.buffer.size > video.jitter.maxSize) {
              this?.log?.debug?.('Resetting WebRTC video jitter buffer for uuid "%s" due to overflow', this.nest_google_device_uuid);

              video.jitter.buffer.clear();
              video.jitter.expectedSequence = undefined;
              video.jitter.lastReleasedSequence = undefined;
              video.jitter.waitStart = undefined;
            }
          });
        });

        this.#streamId = homeFoyerResponse.data[0].streamId;

        await this.#peerConnection?.setRemoteDescription?.({
          type: 'answer',
          sdp: homeFoyerResponse.data[0].sdp,
        });

        this?.log?.debug?.('Playback started from WebRTC for uuid "%s" with stream ID "%s"', this.nest_google_device_uuid, this.#streamId);

        // Monitor connection status. If closed and there are still output streams, re-connect
        this.#peerConnection.iceConnectionStateChange.subscribe(() => {
          let state = this.#peerConnection?.iceConnectionState;

          if (state === 'connected' || state === 'completed' || state === 'checking') {
            if (this.sourceState !== Streamer.MESSAGE_TYPE.SOURCE_CONNECTED) {
              this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_CONNECTED);
            }
            return;
          }

          if (state === 'failed' || state === 'disconnected' || (state === 'closed' && this.hasActiveStreams() === true)) {
            this?.log?.debug?.('WebRTC ICE state "%s" for uuid "%s", requesting reconnect', state, this.nest_google_device_uuid);
            this.#requestReconnect('ice-' + state);

            if (this.hasActiveStreams() === true) {
              this.close();
            }
          }
        });

        // Create a timer to extend the active stream every period as defined only if we don't have local access.
        // If we have local access, the stream should stay alive without needing to send extend commands
        if (localAccessGranted === false) {
          this.#extendTimer = setInterval(async () => {
            if (
              this.#googleHomeFoyer !== undefined &&
              this.sourceState === Streamer.MESSAGE_TYPE.SOURCE_READY &&
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

                this.#requestReconnect('extend-failed');
                this.close();
              }
            }
          }, EXTEND_INTERVAL);
        }
      }
    }
  }

  async close() {
    let reconnectReason = this.#reconnectReason;

    // Preserve talkback state before we tear down tracks below
    let talkbackActive = this.#tracks?.talkback?.active === true;

    // Stop timers first so we stop generating any new work immediately
    clearInterval(this.#extendTimer);
    clearTimeout(this.#stalledTimer);
    clearInterval(this.#pingTimer);
    clearTimeout(this.#tracks?.video?.h264?.fuTimer);
    clearInterval(this.#tracks?.video?.startupPLITimer);
    this.#extendTimer = undefined;
    this.#stalledTimer = undefined;
    this.#pingTimer = undefined;

    // Immediately tear down local track state so any in-flight WebRTC packet handlers
    // naturally no-op while we are still shutting down the remote connection.
    // This prevents buffered FU-A / jitter frames from flushing after close starts.
    this.#videoTransceiver = undefined;
    this.#audioTransceiver = undefined;
    this.#tracks = { audio: {}, video: {}, talkback: {} }; // Track state for audio and video

    if (this.#streamId !== undefined) {
      if (talkbackActive === true) {
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

      // Tell remote to end the stream session
      await this.#googleHomeFoyerCommand('CameraService', 'JoinStream', {
        command: 'end',
        deviceId: this.nest_google_device_uuid,
        streamId: this.#streamId,
        endStreamReason: 'REASON_USER_EXITED_SESSION',
      });
    }

    try {
      // Close the WebRTC peer connection
      await this.#peerConnection?.close?.();
    } catch {
      // Empty
    }

    try {
      // Destroy underlying transport/socket
      this.#googleHomeFoyer?.destroy?.();
    } catch {
      // Empty
    }

    // Clear remaining connection state
    this.#streamId = undefined;
    this.#googleHomeFoyer = undefined;
    this.#peerConnection = undefined;

    if (this.#reconnectPending === true) {
      // We have a reconnect pending, so reset the flag and attempt to reconnect.
      // We do this to avoid trying to reconnect while the socket is still closing which would cause errors.
      // Instead we wait for the socket to fully close and then reconnect if we still have active outputs at that time
      // (if the user stopped streaming while we were waiting for the socket to close, then we won't reconnect which is good).
      this.#reconnectPending = false;
      this.#reconnectReason = undefined;

      this?.log?.debug?.(
        'Connection closed to WebRTC for uuid "%s", attempting reconnect%s',
        this.nest_google_device_uuid,
        typeof reconnectReason === 'string' && reconnectReason !== '' ? ' (' + reconnectReason + ')' : '',
      );

      if (this.hasActiveStreams() === true) {
        this.connect();
        return;
      }
    }

    this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_CLOSED);
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
      Buffer.isBuffer(talkingBuffer) !== true ||
      this.#googleHomeDeviceUUID === undefined ||
      this.#streamId === undefined ||
      typeof this.#audioTransceiver?.sender?.sendRtp !== 'function' ||
      typeof this.#tracks?.talkback !== 'object'
    ) {
      return;
    }

    const talk = this.#tracks.talkback;

    // Setup state for talkback if not already done.
    // We need this to manage talkback sessions and RTP state for outgoing talkback audio packets
    if (talkingBuffer.length > 0) {
      // First time → request talkback start from device
      if (talk.active === undefined) {
        let homeFoyerResponse = await this.#googleHomeFoyerCommand('CameraService', 'SendTalkback', {
          googleDeviceId: { value: this.#googleHomeDeviceUUID },
          streamId: this.#streamId,
          command: 'COMMAND_START',
        });

        if (homeFoyerResponse?.status !== 0) {
          this?.log?.debug?.('Error starting talkback for uuid "%s"', this.nest_google_device_uuid);
          talk.active = undefined;
          return;
        }

        talk.active = true;
        this?.log?.debug?.('Talking started on uuid "%s"', this.nest_google_device_uuid);
      }

      if (talk.active !== true) {
        return;
      }

      // Initalise RTP state if not already done. We need this to build correct RTP headers for the talkback audio packets we send
      if (typeof talk.rtp !== 'object') {
        talk.rtp = {};
      }
      if (typeof talk.rtp.sequenceNumber !== 'number') {
        talk.rtp.sequenceNumber = 0;
      }
      if (typeof talk.rtp.timestamp !== 'number') {
        // RTP timestamps are sample-based, not wallclock
        talk.rtp.timestamp = Math.floor(Math.random() * 0xffffffff);
      }

      // Build RTP packet with appropriate headers and payload
      let header = new werift.RtpHeader();
      header.ssrc = this.#audioTransceiver.sender.ssrc;
      header.payloadType = talk.id;
      header.sequenceNumber = talk.rtp.sequenceNumber++ & 0xffff;
      header.timestamp = talk.rtp.timestamp >>> 0;
      header.marker = true;
      header.payloadOffset = RTP_PACKET_HEADER_SIZE;

      // Send the RTP packet using the audio transceiver's sender
      let packet = new werift.RtpPacket(header, talkingBuffer);
      this.#audioTransceiver.sender.sendRtp(packet.serialize());

      // Increment timestamp for next packet (monotonic RTP clock)
      // 20ms @ 48kHz = 960 samples per packet
      talk.rtp.timestamp = (talk.rtp.timestamp + Math.round((talk.sampleRate * talk.packetTime) / 1000)) >>> 0;
      return;
    }

    // Since we only send talkback audio when we have an active stream
    // if we get an empty buffer this means the talkback session has ended (e.g. user stopped talking or released button)
    if (talkingBuffer.length === 0 && talk.active === true) {
      let homeFoyerResponse = await this.#googleHomeFoyerCommand('CameraService', 'SendTalkback', {
        googleDeviceId: { value: this.#googleHomeDeviceUUID },
        streamId: this.#streamId,
        command: 'COMMAND_STOP',
      });

      if (homeFoyerResponse?.status !== 0) {
        this?.log?.debug?.('Error stopping talkback for uuid "%s"', this.nest_google_device_uuid);
      } else {
        this?.log?.debug?.('Talking ended on uuid "%s"', this.nest_google_device_uuid);
      }

      // Reset state ready for next session
      talk.active = undefined;
      talk.rtp.timestamp = undefined;
    }
  }

  #setupTracks(weriftTrack) {
    // Handle the beginning of RTP playback for an audio or video track
    if (weriftTrack === undefined || typeof weriftTrack !== 'object') {
      return;
    }

    if (weriftTrack?.kind === 'audio' && weriftTrack?.codec?.payloadType === RTP_OPUS_AUDIO_PAYLOAD_TYPE) {
      let sampleRate =
        Number.isInteger(weriftTrack?.codec?.clockRate) === true && weriftTrack.codec.clockRate > 0 ? weriftTrack.codec.clockRate : 48000;
      let channels =
        Number.isInteger(weriftTrack?.codec?.channels) === true && weriftTrack.codec.channels > 0 ? weriftTrack.codec.channels : 2;

      this.#tracks.audio = {
        id: weriftTrack?.codec?.payloadType, // RTP payload type for audio
        codec: Streamer.CODEC_TYPE.OPUS, // Opus incoming, we decode to PCM output
        sampleRate: sampleRate,
        channels: channels,
        packetTime: 20,
        rtp: {
          // RTP state for timestamp calculation
          lastSequence: undefined,
          lastTimestamp: undefined,
          lastCalculatedTimestamp: undefined,
        },
        decode: {
          // Opus decoding state
          lastDecodedPCMSize: undefined,
        },
        jitter: {
          // Packet reorder buffer for audio RTP packets
          buffer: new Map(),
          expectedSequence: undefined,
          lastReleasedSequence: undefined,
          waitStart: undefined,
          maxWait: 25,
          maxSize: 32,
        },
      };

      // Audio track is bidirectional (sendrecv), so we initialise talkback format from it,
      // but maintain separate RTP state for outbound talkback
      this.#tracks.talkback = {
        codec: Streamer.CODEC_TYPE.OPUS, // Talkback uses Opus
        sampleRate: sampleRate, // Sample rate for talkback matches incoming audio track
        channels: channels, // Same for channels
        packetTime: 20,
        rtp: {
          sequenceNumber: 0,
          timestamp: undefined,
        },
        active: undefined,
      };
    }

    if (weriftTrack?.kind === 'video' && weriftTrack?.codec?.payloadType === RTP_H264_VIDEO_PAYLOAD_TYPE) {
      this.#tracks.video = {
        id: weriftTrack?.codec?.payloadType, // RTP payload type for video
        codec: Streamer.CODEC_TYPE.H264, // H.264 incoming, we pass through as H.264 output
        sampleRate:
          Number.isInteger(weriftTrack?.codec?.clockRate) === true && weriftTrack.codec.clockRate > 0 ? weriftTrack.codec.clockRate : 90000,
        ssrc: typeof weriftTrack?.ssrc === 'number' ? weriftTrack.ssrc : undefined,
        lastPLITime: undefined,
        lastIDRTime: undefined,
        rtp: {
          // RTP state for timestamp calculation
          lastSequence: undefined,
          lastTimestamp: undefined,
          lastCalculatedTimestamp: undefined,
          lastEmittedTimestamp: undefined,
        },
        h264: {
          // FU-A reassembly state
          fuBuffer: undefined,
          fuTimer: undefined,
          fuType: undefined,
          fuTimestamp: undefined,

          // SPS/PPS/IDR caching & emission tracking
          lastSPS: undefined,
          lastPPS: undefined,
          lastIDR: undefined,
          lastSpsEmitTime: undefined,

          // Frame assembly state
          pendingParts: [],
          pendingTimestamp: undefined,
          pendingRtpTimestamp: undefined,
          pendingKeyFrame: false,
        },
        jitter: {
          // Packet reorder buffer for video RTP packets
          buffer: new Map(),
          expectedSequence: undefined,
          lastReleasedSequence: undefined,
          waitStart: undefined,
          maxWait: 50,
          maxSize: 128,
        },
        startupPLITimer: undefined,
      };
    }
  }

  #handlePlaybackPacket(rtpPacket) {
    let calculateTimestamp = (packet, track, maxStepMs = undefined, options = {}) => {
      if (
        typeof packet?.header?.timestamp !== 'number' ||
        typeof track?.sampleRate !== 'number' ||
        track.sampleRate <= 0 ||
        typeof track?.rtp !== 'object' ||
        track.rtp === null
      ) {
        return undefined;
      }

      let rtpTimestamp = packet.header.timestamp >>> 0;

      if (typeof track.rtp.lastTimestamp !== 'number' || typeof track.rtp.lastCalculatedTimestamp !== 'number') {
        track.rtp.lastTimestamp = rtpTimestamp;
        track.rtp.lastCalculatedTimestamp = Date.now();
        return track.rtp.lastCalculatedTimestamp;
      }

      let deltaTicks = (rtpTimestamp - track.rtp.lastTimestamp + 0x100000000) % 0x100000000;

      // Older / reordered packet
      if (deltaTicks > 0x7fffffff) {
        return undefined;
      }

      let deltaMs = (deltaTicks / track.sampleRate) * 1000;

      if (Number.isFinite(deltaMs) !== true || deltaMs < 0) {
        deltaMs = 0;
      }

      if (typeof maxStepMs === 'number' && maxStepMs > 0 && deltaMs > maxStepMs) {
        deltaMs = maxStepMs;
      }

      // For video, equal RTP timestamps are valid and should remain the same frame time
      if (deltaMs === 0 && options?.allowEqual !== false) {
        return track.rtp.lastCalculatedTimestamp;
      }

      let timestamp = track.rtp.lastCalculatedTimestamp + deltaMs;

      track.rtp.lastTimestamp = rtpTimestamp;
      track.rtp.lastCalculatedTimestamp = timestamp;

      return timestamp;
    };

    let resetPendingVideo = () => {
      if (typeof this.#tracks?.video?.h264 !== 'object' || this.#tracks.video.h264 === null) {
        return;
      }

      this.#tracks.video.h264.pendingParts = [];
      this.#tracks.video.h264.pendingTimestamp = undefined;
      this.#tracks.video.h264.pendingRtpTimestamp = undefined;
      this.#tracks.video.h264.pendingKeyFrame = false;
    };

    let flushPendingVideo = () => {
      let pendingParts = this.#tracks?.video?.h264?.pendingParts;
      let pendingRtpTimestamp = this.#tracks?.video?.h264?.pendingRtpTimestamp;
      let pendingKeyFrame = this.#tracks?.video?.h264?.pendingKeyFrame;
      let pendingTimestamp = undefined;
      let minimumStep = 1;

      // Nothing buffered for the current access unit, so just clear state and return
      if (Array.isArray(pendingParts) !== true || pendingParts.length === 0 || typeof pendingRtpTimestamp !== 'number') {
        resetPendingVideo();
        return;
      }

      // Join all collected NAL units for this access unit into one H264 frame payload
      let data = Buffer.concat(pendingParts);

      // Safety guard: if concatenation produced nothing useful, discard the pending frame
      if (Buffer.isBuffer(data) !== true || data.length === 0) {
        resetPendingVideo();
        return;
      }

      // We need RTP timing state to convert the frame RTP timestamp into a monotonic frame timestamp
      if (typeof this.#tracks?.video?.rtp !== 'object' || this.#tracks.video.rtp === null) {
        resetPendingVideo();
        return;
      }

      // First emitted frame for this track:
      // initialise our RTP timing baseline directly from the completed frame RTP timestamp
      if (typeof this.#tracks.video.rtp.lastTimestamp !== 'number' || typeof this.#tracks.video.rtp.lastCalculatedTimestamp !== 'number') {
        this.#tracks.video.rtp.lastTimestamp = pendingRtpTimestamp;
        this.#tracks.video.rtp.lastCalculatedTimestamp = Date.now();
        pendingTimestamp = this.#tracks.video.rtp.lastCalculatedTimestamp;
      }

      // For subsequent frames, calculate one timestamp per completed access unit
      // from the difference between this frame RTP timestamp and the previous frame RTP timestamp
      if (typeof pendingTimestamp !== 'number') {
        let deltaTicks = (pendingRtpTimestamp - this.#tracks.video.rtp.lastTimestamp + 0x100000000) % 0x100000000;

        // If this looks like an older/reordered frame timestamp, drop it rather than emit backwards time
        if (deltaTicks > 0x7fffffff) {
          resetPendingVideo();
          return;
        }

        let deltaMs = (deltaTicks / this.#tracks.video.sampleRate) * 1000;

        // Clamp invalid values back to zero rather than poisoning output timing
        if (Number.isFinite(deltaMs) !== true || deltaMs < 0) {
          deltaMs = 0;
        }

        // Guard against very large RTP jumps causing huge frame time jumps downstream
        if (deltaMs > TIMESTAMP_MAX_VIDEO_DELTA) {
          deltaMs = TIMESTAMP_MAX_VIDEO_DELTA;
        }

        pendingTimestamp = this.#tracks.video.rtp.lastCalculatedTimestamp + deltaMs;
      }

      let previousTimestamp = this.#tracks.video.rtp.lastEmittedTimestamp;

      // Use the detected stream fps, when available, as the minimum forward step for emitted frame times.
      // This helps avoid multiple completed frames collapsing onto the same millisecond and causing DTS wobble.
      if (typeof this.video?.fps === 'number' && Number.isFinite(this.video.fps) === true && this.video.fps > 0) {
        minimumStep = Math.max(1, Math.round(1000 / this.video.fps));
      }

      // Final monotonicity guard:
      // if the newly calculated frame timestamp does not move forward, force it forward by at least one frame step
      if (typeof previousTimestamp === 'number' && pendingTimestamp <= previousTimestamp) {
        pendingTimestamp = previousTimestamp + minimumStep;
      }

      // Update RTP/frame timing state only once per fully assembled frame
      this.#tracks.video.rtp.lastTimestamp = pendingRtpTimestamp;
      this.#tracks.video.rtp.lastCalculatedTimestamp = pendingTimestamp;
      this.#tracks.video.rtp.lastEmittedTimestamp = pendingTimestamp;

      // Track most recent IDR arrival and move source state to ready once we have a usable keyframe
      if (pendingKeyFrame === true) {
        this.#tracks.video.lastIDRTime = Date.now();
        clearTimeout(this.#tracks?.video?.startupPLITimer);
        this.#tracks.video.startupPLITimer = undefined;
      }

      // Emit exactly one packet per completed video frame/access unit
      this.addPacket({
        type: Streamer.PACKET_TYPE.VIDEO,
        codec: this.codecs.video,
        timestamp: pendingTimestamp,
        keyFrame: pendingKeyFrame,
        data: data,
      });

      // Clear the pending access-unit assembly state ready for the next frame
      resetPendingVideo();
    };

    let startPendingVideoFrame = (timestamp, rtpTimestamp) => {
      if (typeof this.#tracks?.video?.h264 !== 'object' || this.#tracks.video.h264 === null) {
        return;
      }

      this.#tracks.video.h264.pendingRtpTimestamp = rtpTimestamp;
      this.#tracks.video.h264.pendingTimestamp = timestamp;
      this.#tracks.video.h264.pendingKeyFrame = false;
      this.#tracks.video.h264.pendingParts = [];
    };

    let appendPendingVideoPart = (data) => {
      if (
        Buffer.isBuffer(data) !== true ||
        data.length === 0 ||
        typeof this.#tracks?.video?.h264 !== 'object' ||
        this.#tracks.video.h264 === null
      ) {
        return;
      }

      if (Array.isArray(this.#tracks.video.h264.pendingParts) !== true) {
        this.#tracks.video.h264.pendingParts = [];
      }

      if (data.indexOf(Streamer.H264NALUS.START_CODE) !== 0) {
        data = Buffer.concat([Streamer.H264NALUS.START_CODE, data]);
      }

      this.#tracks.video.h264.pendingParts.push(data);
    };

    let appendVideoNalu = (nalu, timestamp, rtpTimestamp, naluType, now) => {
      if (
        Buffer.isBuffer(nalu) !== true ||
        nalu.length === 0 ||
        typeof timestamp !== 'number' ||
        typeof rtpTimestamp !== 'number' ||
        typeof this.#tracks?.video?.h264 !== 'object' ||
        this.#tracks.video.h264 === null
      ) {
        return;
      }

      if (typeof this.#tracks.video.h264.pendingRtpTimestamp === 'number' && this.#tracks.video.h264.pendingRtpTimestamp !== rtpTimestamp) {
        flushPendingVideo();
      }

      if (typeof this.#tracks.video.h264.pendingRtpTimestamp !== 'number') {
        startPendingVideoFrame(timestamp, rtpTimestamp);
      }

      if (naluType === Streamer.H264NALUS.TYPES.SPS) {
        this.#tracks.video.h264.lastSPS = Buffer.from(nalu);
      }

      if (naluType === Streamer.H264NALUS.TYPES.PPS) {
        this.#tracks.video.h264.lastPPS = Buffer.from(nalu);
      }

      if (naluType === Streamer.H264NALUS.TYPES.IDR) {
        this.#tracks.video.h264.lastIDR = Buffer.from(nalu);

        // Ensure codec config is present at the beginning of the same access unit as the IDR
        if (
          Buffer.isBuffer(this.#tracks.video.h264.lastSPS) === true &&
          this.#tracks.video.h264.lastSPS.length > 0 &&
          this.#tracks.video.h264.pendingParts.length === 0
        ) {
          appendPendingVideoPart(this.#tracks.video.h264.lastSPS);
        }

        if (Buffer.isBuffer(this.#tracks.video.h264.lastPPS) === true && this.#tracks.video.h264.lastPPS.length > 0) {
          appendPendingVideoPart(this.#tracks.video.h264.lastPPS);
        }

        this.#tracks.video.h264.pendingKeyFrame = true;
        this.#tracks.video.h264.lastSpsEmitTime = now;
      }

      appendPendingVideoPart(nalu);
    };

    if (rtpPacket?.header === undefined || Buffer.isBuffer(rtpPacket.payload) !== true) {
      // Invalid packet, so return
      return;
    }

    if (this.#peerConnection === undefined || this.#streamId === undefined || this.sourceState === Streamer.MESSAGE_TYPE.SOURCE_CLOSED) {
      // Source is shutting down or invalid state
      return;
    }

    // If we dont receive a packet in 10s, force a reconnect
    clearTimeout(this.#stalledTimer);
    this.#stalledTimer = setTimeout(() => {
      if (this.#peerConnection === undefined || this.#streamId === undefined || this.sourceState === Streamer.MESSAGE_TYPE.SOURCE_CLOSED) {
        // Stream was stopped/closed after this timer was armed, so ignore the timeout
        return;
      }

      this?.log?.debug?.(
        'No WebRTC playback packets received for uuid "%s" in the past %s seconds. Closing connection',
        this.nest_google_device_uuid,
        Math.round(STALLED_TIMEOUT / 1000),
      );

      this.#requestReconnect('stall');
      this.close();
    }, STALLED_TIMEOUT);

    // Handle video playback packets
    if (rtpPacket.header.payloadType === this.#tracks.video?.id) {
      const video = this.#tracks.video;
      let now = Date.now();
      let payload = rtpPacket.payload;
      let nalHeader = payload[0];
      let type = nalHeader & 0x1f;
      let timestamp = undefined;
      let rtpTimestamp = rtpPacket.header.timestamp >>> 0;

      if (typeof video?.h264 !== 'object' || video.h264 === null) {
        video.h264 = {};
      }

      if (Array.isArray(video.h264.pendingParts) !== true) {
        video.h264.pendingParts = [];
      }

      // Track RTP sequence numbers for video
      if (typeof video?.rtp?.lastSequence === 'number') {
        let sequenceDelta = (rtpPacket.header.sequenceNumber - video.rtp.lastSequence + 0x10000) % 0x10000;

        // Forward gap
        if (sequenceDelta > 1 && sequenceDelta < 0x8000) {
          this?.log?.debug?.(
            'WebRTC video RTP sequence gap for uuid "%s". Expected "%s" got "%s"',
            this.nest_google_device_uuid,
            (video.rtp.lastSequence + 1) & 0xffff,
            rtpPacket.header.sequenceNumber,
          );

          // Drop any incomplete in-progress frame on packet loss rather than emitting a partial frame
          resetPendingVideo();

          if (video.h264?.fuBuffer !== undefined) {
            clearTimeout(video.h264?.fuTimer);
            video.h264.fuBuffer = undefined;
            video.h264.fuType = undefined;
            video.h264.fuTimestamp = undefined;

            this.#sendVideoPLI('fu-a packet loss');
          }
        }

        // Older/reordered packet
        if (sequenceDelta > 0x8000) {
          return;
        }
      }
      video.rtp.lastSequence = rtpPacket.header.sequenceNumber;

      if (
        typeof video?.startupPLIStartedAt === 'number' &&
        typeof video?.lastIDRTime !== 'number' &&
        now - video.startupPLIStartedAt <= 5000
      ) {
        this.#sendVideoPLI('waiting for first keyframe');
      }

      // If we haven't received an IDR frame in a while, request a new one with a PLI to help recovery
      if (typeof video.lastIDRTime === 'number' && now - video.lastIDRTime > IDR_TIMEOUT) {
        this.#sendVideoPLI('idr refresh timeout');
      }

      // Single-Time Aggregation Packet (STAP-A)
      if (type === Streamer.H264NALUS.TYPES.STAP_A) {
        let offset = 1;
        let naluLength = 0;
        let nalu = undefined;
        let naluType = 0;

        timestamp = calculateTimestamp(rtpPacket, video, TIMESTAMP_MAX_VIDEO_DELTA, { allowEqual: true });
        if (typeof timestamp !== 'number') {
          return;
        }

        while (offset + 2 <= payload.length) {
          naluLength = payload.readUInt16BE(offset);
          offset += 2;

          if (naluLength <= 0 || offset + naluLength > payload.length) {
            break;
          }

          nalu = payload.subarray(offset, offset + naluLength);
          naluType = nalu[0] & 0x1f;
          offset += naluLength;

          appendVideoNalu(Buffer.from(nalu), timestamp, rtpTimestamp, naluType, now);
        }

        if (rtpPacket.header.marker === true) {
          flushPendingVideo();
        }
        return;
      }

      // Fragmentation Unit A (FU-A)
      if (type === Streamer.H264NALUS.TYPES.FU_A) {
        let fuHeader = payload[1];
        let fuType = fuHeader & 0x1f;
        let reconstructedNal = Buffer.from([(nalHeader & 0xe0) | fuType]);
        let fragmentPayload = payload.subarray(2);
        let completedBuffer = undefined;
        let completedType = undefined;
        let completedTimestamp = undefined;
        let completedRtpTimestamp = undefined;

        if (payload.length < 3 || fragmentPayload.length === 0) {
          return;
        }

        if (((fuHeader & 0x80) !== 0) === true) {
          // Start of FU-A, initialise buffer and store type and timestamp
          clearTimeout(video.h264.fuTimer);
          video.h264.fuBuffer = [reconstructedNal, fragmentPayload];
          video.h264.fuType = fuType;
          video.h264.fuTimestamp = rtpPacket.header.timestamp >>> 0;

          video.h264.fuTimer = setTimeout(() => {
            this?.log?.debug?.('Discarding stale FU-A buffer for uuid "%s"', this.nest_google_device_uuid);
            video.h264.fuBuffer = [];
            video.h264.fuType = undefined;
            video.h264.fuTimestamp = undefined;
          }, FU_A_TIMEOUT);

          return;
        }

        if (Array.isArray(video.h264.fuBuffer) !== true || video.h264.fuBuffer.length === 0) {
          return;
        }

        // Middle or end fragment, add to buffer
        video.h264.fuBuffer.push(fragmentPayload);

        if (((fuHeader & 0x40) !== 0) === true) {
          completedBuffer = Buffer.concat(video.h264.fuBuffer);
          completedType = video.h264.fuType;
          completedRtpTimestamp = video.h264.fuTimestamp;
          completedTimestamp = calculateTimestamp({ header: { timestamp: completedRtpTimestamp } }, video, TIMESTAMP_MAX_VIDEO_DELTA, {
            allowEqual: true,
          });

          clearTimeout(video.h264.fuTimer);
          video.h264.fuBuffer = [];
          video.h264.fuType = undefined;
          video.h264.fuTimestamp = undefined;

          if (typeof completedTimestamp !== 'number') {
            return;
          }

          appendVideoNalu(completedBuffer, completedTimestamp, completedRtpTimestamp, completedType, now);

          if (rtpPacket.header.marker === true) {
            flushPendingVideo();
          }
        }

        return;
      }

      // Raw NAL unit
      timestamp = calculateTimestamp(rtpPacket, video, TIMESTAMP_MAX_VIDEO_DELTA, { allowEqual: true });
      if (typeof timestamp !== 'number') {
        return;
      }

      appendVideoNalu(payload, timestamp, rtpTimestamp, type, now);

      if (rtpPacket.header.marker === true) {
        flushPendingVideo();
      }
      return;
    }

    // Handle audio playback packets
    if (rtpPacket.header.payloadType === this.#tracks.audio?.id) {
      const audio = this.#tracks.audio;
      let pcm = undefined;

      // Track RTP sequence numbers for audio
      if (typeof audio?.rtp?.lastSequence === 'number') {
        let sequenceDelta = (rtpPacket.header.sequenceNumber - audio.rtp.lastSequence + 0x10000) % 0x10000;

        if (sequenceDelta > 1 && sequenceDelta < 0x8000) {
          this?.log?.debug?.(
            'WebRTC audio RTP sequence gap for uuid "%s". Expected "%s" got "%s"',
            this.nest_google_device_uuid,
            (audio.rtp.lastSequence + 1) & 0xffff,
            rtpPacket.header.sequenceNumber,
          );
        }

        // Older/reordered audio packet
        if (sequenceDelta > 0x8000) {
          return;
        }
      }
      audio.rtp.lastSequence = rtpPacket.header.sequenceNumber;

      let timestamp = calculateTimestamp(rtpPacket, audio, TIMESTAMP_MAX_AUDIO_DELTA, { allowEqual: false });
      if (typeof timestamp !== 'number') {
        return;
      }

      try {
        let opus = werift.OpusRtpPayload.deSerialize(rtpPacket.payload);

        if (Buffer.isBuffer(opus?.payload) === true && opus.payload.length > 0) {
          let decoded = this.#opusDecoder.decode(opus.payload);

          if (Buffer.isBuffer(decoded) === true && decoded.length > 0) {
            pcm = decoded;
          }

          if (pcm === undefined && decoded instanceof Uint8Array && decoded.length > 0) {
            pcm = Buffer.from(decoded.buffer, decoded.byteOffset, decoded.byteLength);
          }

          if (Buffer.isBuffer(pcm) === true && pcm.length > 0) {
            audio.decode.lastDecodedPCMSize = pcm.length;
          }
        }
      } catch (error) {
        this?.log?.debug?.('Error decoding Opus audio for uuid "%s": %s', this.nest_google_device_uuid, String(error));
      }

      if (Buffer.isBuffer(pcm) === true && pcm.length > 0) {
        this.addPacket({
          type: Streamer.PACKET_TYPE.AUDIO,
          codec: this.codecs.audio,
          timestamp: timestamp,
          keyFrame: false,
          data: pcm,
        });
        return;
      }

      this.addPacket({
        type: Streamer.PACKET_TYPE.AUDIO,
        codec: this.codecs.audio,
        timestamp: timestamp,
        keyFrame: false,
        data:
          Number.isInteger(audio.decode?.lastDecodedPCMSize) === true && audio.decode.lastDecodedPCMSize > 0
            ? Buffer.alloc(audio.decode.lastDecodedPCMSize)
            : Buffer.alloc(
                Math.round(
                  ((Number.isInteger(audio?.sampleRate) === true && audio.sampleRate > 0 ? audio.sampleRate : 48000) *
                    (Number.isInteger(audio?.packetTime) === true && audio.packetTime > 0 ? audio.packetTime : 20)) /
                    1000,
                ) *
                  (Number.isInteger(audio?.channels) === true && audio.channels > 0 ? audio.channels : 2) *
                  2,
              ),
      });
    }
  }

  #sendVideoPLI(reason = '') {
    const video = this.#tracks?.video;
    let now = Date.now();

    if (this.#videoTransceiver === undefined || video === undefined || typeof video?.ssrc !== 'number') {
      return;
    }

    if (typeof video.lastPLITime === 'number' && now - video.lastPLITime < 2000) {
      return;
    }

    video.lastPLITime = now;

    this?.log?.debug?.('Sending RTCP PLI for uuid "%s"%s', this.nest_google_device_uuid, reason !== '' ? ' (' + reason + ')' : '');

    this.#videoTransceiver?.receiver?.sendRtcpPLI?.(video.ssrc);
  }

  #requestReconnect(reason) {
    if (this.#reconnectPending === true) {
      return;
    }

    this.#reconnectPending = true;
    this.#reconnectReason = reason;

    this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_RECONNECTING, reason);
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
