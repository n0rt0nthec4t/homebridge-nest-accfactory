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
// - Apply jitter buffering and packet reordering for RTP streams
// - Perform H264 NAL unit parsing and frame reassembly (including FU-A), emitting Annex-B frames
// - Assemble complete video frames before injecting into Streamer
// - Decode Opus audio to PCM for downstream processing
// - Inject media into Streamer for live and recording outputs
// - Support two-way audio (talkback) via outbound RTP/Opus pipeline
//
// Features:
// - Secure media transport over DTLS-SRTP
// - RTCP feedback support (PLI/FIR/NACK) for video recovery
// - Codec negotiation (H264 video, Opus audio, RTX video)
// - Startup timing and stream diagnostics logging
// - Resilient handling of packet loss and stream stalls
//
// Notes:
// - Video readiness is determined by first video RTP packet arrival, not connection state
// - ICE "connected" indicates transport readiness, not media availability
// - Startup delays may occur due to upstream (Google) keyframe delivery behaviour
//
// Code version 2026.04.06
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
const RTP_SEQUENCE_MASK = 0xffff; // 16-bit RTP sequence number mask
const RTP_SEQUENCE_WRAP = 0x10000; // For wrapping sequence calculations
const RTP_TIMESTAMP_MASK = 0x100000000; // 32-bit RTP timestamp wrap mask
const RTP_TIMESTAMP_MAX_DELTA = 0x7fffffff; // Max positive delta for timestamp comparison
const RTP_PACKET_HEADER_SIZE = 12; // RTP packet header size in bytes
const RTP_H264_VIDEO_PAYLOAD_TYPE = 98; // H.264 video payload type
const RTP_H264_VIDEO_RTX_PAYLOAD_TYPE = 99; // H.264 RTX payload type for retransmissions
const RTP_OPUS_AUDIO_PAYLOAD_TYPE = 111; // Opus audio payload type
const GOOGLE_HOME_FOYER_PREFIX = 'google.internal.home.foyer.v1.';
const FU_A_TIMEOUT = 1500; // Time to wait for the completion of a fragmented FU-A NAL unit before discarding the incomplete data
const IDR_TIMEOUT = 5000; // Time to wait for an IDR frame before considering the video stream stalled and attempting a reconnect
const TIMESTAMP_MAX_VIDEO_DELTA = 250;
const TIMESTAMP_MAX_AUDIO_DELTA = 120;
const STALLED_TIMEOUT = 10000; // Time with no playback packets before we consider stream stalled and attempt restart
const PCM_S16LE_48000_STEREO_BLANK = Buffer.alloc(960 * 2 * 2); // Default blank audio frame (20ms) in PCM S16LE, stereo @ 48kHz
const PLAYOUT_TICK = 10; // Period used to drain jitter/reorder buffers and release media toward Streamer
const AUDIO_PLAYOUT_DELAY = 100; // Startup playout delay for audio to absorb modest jitter
const VIDEO_PLAYOUT_DELAY = 130; // Startup playout delay for video to absorb modest jitter
const ADAPTIVE_PLAYOUT_ENABLED = true; // Enable adaptive playout delay adjustment
const ADAPTIVE_PLAYOUT_MAX_DELAY = 500; // Maximum adaptive delay (ms)
const ADAPTIVE_PLAYOUT_MIN_DELAY = 50; // Minimum adaptive delay (ms)
const ADAPTIVE_PLAYOUT_ADJUST_RATE = 0.1; // Adjustment rate (0.1 = 10% per tick)
const MAX_NACK_BURST = 8; // Maximum number of missing video sequences to include in one NACK request
const MAX_AUDIO_NACK_BURST = 4; // Maximum number of missing audio sequences to include in one NACK request

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
  #playoutTimer = undefined; // Internal playout timer to release reordered RTP toward Streamer
  #reconnectPending = false; // Reconnect requested once socket closes
  #reconnectReason = undefined; // Reason for reconnect
  #tracks = { audio: {}, video: {}, talkback: {} }; // Track state for audio and video
  #audioSilenceCache = new Map();

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
    // Reset any previous session timers/state before attempting a new connection.
    // This ensures a reconnect starts from a clean baseline rather than reusing
    // timers or partially assembled media from an earlier session.
    clearInterval(this.#extendTimer);
    clearTimeout(this.#stalledTimer);
    clearInterval(this.#pingTimer);
    clearInterval(this.#playoutTimer);
    clearTimeout(this.#tracks?.video?.h264?.fuTimer);
    clearInterval(this.#tracks?.video?.startupPLITimer);
    this.#extendTimer = undefined;
    this.#stalledTimer = undefined;
    this.#pingTimer = undefined;
    this.#playoutTimer = undefined;
    this.#streamId = undefined;
    this.#reconnectPending = false;
    this.#reconnectReason = undefined;
    this.#tracks = { audio: {}, video: {}, talkback: {} };

    if (this.online !== true || this.videoEnabled !== true) {
      return;
    }

    if (this.#googleHomeDeviceUUID === undefined) {
      // We do not yet have the Google Home Foyer-specific device identifier for this camera.
      // Resolve it once from HomeGraph using our normal Nest/Google device UUID, then cache it
      // for future stream sessions.
      let homeFoyerResponse = await this.#googleHomeFoyerCommand('StructuresService', 'GetHomeGraph', {
        requestId: crypto.randomUUID(),
      });

      if (homeFoyerResponse?.data?.[0]?.homes !== undefined) {
        Object.values(homeFoyerResponse.data[0].homes || {}).forEach((home) => {
          Object.values(home?.devices || {}).forEach((device) => {
            if (device?.id?.googleUuid !== undefined && device?.otherIds?.otherThirdPartyId !== undefined) {
              let currentGoogleUuid = device.id.googleUuid;

              Object.values(device.otherIds.otherThirdPartyId || {}).forEach((other) => {
                if (other?.id === this.nest_google_device_uuid) {
                  this.#googleHomeDeviceUUID = currentGoogleUuid;
                }
              });
            }
          });
        });
      }
    }

    if (this.#googleHomeDeviceUUID === undefined) {
      this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_CLOSED, 'google-device-id-missing');
      return;
    }

    // Tell the Streamer base that we are beginning source setup.
    // This is transport/control readiness only and does not mean media is flowing yet.
    this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_CONNECTING);

    let homeFoyerResponse = await this.#googleHomeFoyerCommand('CameraService', 'SendCameraViewIntent', {
      request: {
        googleDeviceId: {
          value: this.#googleHomeDeviceUUID,
        },
        command: 'VIEW_INTENT_START',
      },
    });

    if (homeFoyerResponse?.status !== 0) {
      this?.log?.debug?.('Request to start camera viewing was not accepted for uuid "%s"', this.nest_google_device_uuid);
      this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_CLOSED, 'view-intent-failed');
      return;
    }

    // Create our local WebRTC peer connection and advertise the codecs we support.
    // We receive H264 video and Opus audio from the camera, then convert that into
    // Streamer media items for live view and recording.
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
            rtcpFeedback: [{ type: 'ccm', parameter: 'fir' }, { type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'goog-remb' }],
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

    // Create our SDP offer and send it to Google Home Foyer.
    // If accepted, we will get an SDP answer back plus a streamId for later extend/end/talkback calls.
    let webRTCOffer = await this.#peerConnection.createOffer();
    await this.#peerConnection.setLocalDescription(webRTCOffer);

    homeFoyerResponse = await this.#googleHomeFoyerCommand('CameraService', 'JoinStream', {
      command: 'offer',
      deviceId: this.nest_google_device_uuid,
      local: options?.localAccess === true,
      streamContext: 'STREAM_CONTEXT_DEFAULT',
      requestedVideoResolution: 'VIDEO_RESOLUTION_FULL_HIGH',
      sdp: webRTCOffer.sdp,
    });

    if (
      homeFoyerResponse?.status !== 0 ||
      homeFoyerResponse?.data?.[0]?.responseType !== 'answer' ||
      homeFoyerResponse?.data?.[0]?.streamId === undefined ||
      homeFoyerResponse?.data?.[0]?.sdp === undefined
    ) {
      this.#peerConnection?.close?.();
      this.#peerConnection = undefined;
      this?.log?.debug?.('WebRTC offer was not agreed with remote for uuid "%s"', this.nest_google_device_uuid);
      this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_CLOSED, 'offer-rejected');
      return;
    }

    // If the SDP answer contains a private/local candidate, then local access was granted.
    // Otherwise traffic will use the normal routed/remote path and we should continue sending
    // periodic stream extension requests to keep the session alive.
    let localAccessGranted =
      /a=candidate:.* (10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+|fd[0-9a-f]{2}:[0-9a-f:]+)/i.test(
        homeFoyerResponse.data[0].sdp || '',
      ) === true;

    this?.log?.debug?.(
      'WebRTC offer agreed with remote for uuid "%s"%s',
      this.nest_google_device_uuid,
      localAccessGranted === true ? ' with local access granted' : '',
    );

    // Track subscription callbacks only ingest RTP into our jitter/reorder buffers.
    // They do not emit media directly.
    this.#audioTransceiver?.onTrack?.subscribe?.((track) => {
      // Audio track has been established, so setup our internal data for audio tracking/handling
      this.#setupTracks(track);

      track.onReceiveRtp.subscribe((rtpPacket) => {
        this.#ingestAudioRtpPacket(rtpPacket);
      });
    });

    this.#videoTransceiver?.onTrack?.subscribe?.((track) => {
      // Video track has been established, so setup our internal data for video tracking/handling
      this.#setupTracks(track);

      track.onReceiveRtp.subscribe((rtpPacket) => {
        this.#ingestVideoRtpPacket(rtpPacket);
      });
    });

    this.#streamId = homeFoyerResponse.data[0].streamId;

    await this.#peerConnection?.setRemoteDescription?.({
      type: 'answer',
      sdp: homeFoyerResponse.data[0].sdp,
    });

    this?.log?.debug?.('Playback started from WebRTC for uuid "%s" with stream ID "%s"', this.nest_google_device_uuid, this.#streamId);

    // Start a lightweight playout loop that drains buffered RTP in sequence order.
    // This is the main separation between WebRTC and NexusTalk:
    // WebRTC gives us RTP packets that can be reordered, delayed or missing,
    // so we normalise that first before emitting media into Streamer.
    this.#ensurePlayoutLoop();

    // Monitor connection status. ICE "connected" means transport is ready,
    // not that media has actually started. Actual source readiness is promoted
    // later on first video packet arrival.
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

    // Periodically extend the active stream only when we do not have local access.
    // Local streams are expected to remain valid without needing explicit extend requests.
    if (localAccessGranted !== true) {
      this.#extendTimer = setInterval(async () => {
        if (
          this.#googleHomeFoyer !== undefined &&
          this.sourceState === Streamer.MESSAGE_TYPE.SOURCE_READY &&
          this.#streamId !== undefined &&
          this.#googleHomeDeviceUUID !== undefined
        ) {
          let extendResponse = await this.#googleHomeFoyerCommand('CameraService', 'JoinStream', {
            command: 'extend',
            deviceId: this.nest_google_device_uuid,
            streamId: this.#streamId,
          });

          if (extendResponse?.data?.[0]?.streamExtensionStatus !== 'STATUS_STREAM_EXTENDED') {
            this?.log?.debug?.('Error occurred while requesting stream extension for uuid "%s"', this.nest_google_device_uuid);
            this.#requestReconnect('extend-failed');
            this.close();
          }
        }
      }, EXTEND_INTERVAL);
    }
  }

  async close() {
    let reconnectReason = this.#reconnectReason;
    let talkbackActive = this.#tracks?.talkback?.active === true;

    // Stop timers first so we stop producing any new work immediately.
    clearInterval(this.#extendTimer);
    clearTimeout(this.#stalledTimer);
    clearInterval(this.#pingTimer);
    clearInterval(this.#playoutTimer);
    clearTimeout(this.#tracks?.video?.h264?.fuTimer);
    clearInterval(this.#tracks?.video?.startupPLITimer);
    this.#extendTimer = undefined;
    this.#stalledTimer = undefined;
    this.#pingTimer = undefined;
    this.#playoutTimer = undefined;

    // Flush any pending video access unit before tearing state down.
    // Video is emitted frame-by-frame, so the last completed frame would otherwise
    // be lost if close occurs before another packet triggers a normal flush.
    this.#flushPendingVideoFrame();

    // Clear transceiver/local track state before closing remote transport.
    // This lets any in-flight callbacks naturally no-op while shutdown continues.
    this.#videoTransceiver = undefined;
    this.#audioTransceiver = undefined;
    this.#tracks = { audio: {}, video: {}, talkback: {} };

    if (this.#streamId !== undefined && talkbackActive === true) {
      await this.#googleHomeFoyerCommand('CameraService', 'SendTalkback', {
        googleDeviceId: {
          value: this.#googleHomeDeviceUUID,
        },
        streamId: this.#streamId,
        command: 'COMMAND_STOP',
      });
    }

    if (this.#streamId !== undefined) {
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
      await this.#peerConnection?.close?.();
    } catch {
      // Empty
    }

    try {
      this.#googleHomeFoyer?.destroy?.();
    } catch {
      // Empty
    }

    this.#streamId = undefined;
    this.#googleHomeFoyer = undefined;
    this.#peerConnection = undefined;

    if (this.#reconnectPending === true) {
      // We have a reconnect pending, so reset the flag and attempt to reconnect.
      // We do this only after the current session has really closed to avoid racing
      // a new stream setup against a half-torn-down old connection.
      this.#reconnectPending = false;
      this.#reconnectReason = undefined;

      this?.log?.debug?.(
        'Connection closed to WebRTC for uuid "%s", attempting reconnect%s',
        this.nest_google_device_uuid,
        typeof reconnectReason === 'string' && reconnectReason !== '' ? ' (' + reconnectReason + ')' : '',
      );

      if (this.hasActiveStreams() === true) {
        this.connect().catch((error) => {
          this?.log?.debug?.('Error reconnecting WebRTC for uuid "%s": %s', this.nest_google_device_uuid, String(error));
        });
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

    let talk = this.#tracks.talkback;

    if (typeof talk !== 'object' || talk === null) {
      return;
    }

    // Start or send talkback audio
    if (talkingBuffer.length > 0) {
      // First packet for a new talkback session:
      // ask the remote device to enable talkback audio path.
      //
      // Important:
      // sendTalkback() may be called repeatedly while the async start request is still in-flight.
      // Use a separate "starting" flag so we only issue one COMMAND_START request.
      if (talk.active !== true) {
        if (talk.started === true) {
          return;
        }

        talk.started = true;

        let homeFoyerResponse = await this.#googleHomeFoyerCommand('CameraService', 'SendTalkback', {
          googleDeviceId: { value: this.#googleHomeDeviceUUID },
          streamId: this.#streamId,
          command: 'COMMAND_START',
        });

        talk.started = false;

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

      // Initialise RTP state if not already done.
      // We need this to build correct RTP headers for the talkback audio packets we send.
      if (typeof talk.rtp !== 'object' || talk.rtp === null) {
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
      header.sequenceNumber = talk.rtp.sequenceNumber++ & RTP_SEQUENCE_MASK;
      header.timestamp = talk.rtp.timestamp >>> 0;
      header.marker = true;
      header.payloadOffset = RTP_PACKET_HEADER_SIZE;

      let packet = new werift.RtpPacket(header, talkingBuffer);
      this.#audioTransceiver.sender.sendRtp(packet.serialize());

      // Increment timestamp for next packet (monotonic RTP clock)
      // 20ms @ 48kHz = 960 samples per packet
      talk.rtp.timestamp = (talk.rtp.timestamp + Math.round((talk.sampleRate * talk.packetTime) / 1000)) >>> 0;
      return;
    }

    // Empty buffer means talkback session has ended
    if (talkingBuffer.length === 0 && (talk.active === true || talk.started === true)) {
      // If a start request is still in-flight, do not issue stop yet.
      // We'll just reset local state and let the next session start cleanly.
      if (talk.started === true) {
        talk.started = false;
        talk.active = undefined;
        talk.rtp = undefined;
        return;
      }

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
      talk.started = false;
      talk.rtp = undefined;
    }
  }

  // Helper to calculate RTP sequence number delta, handling wraparound
  #sequenceDelta(current, expected) {
    return (current - expected + RTP_SEQUENCE_WRAP) % RTP_SEQUENCE_WRAP;
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
        id: weriftTrack.codec.payloadType, // RTP payload type for audio
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
        ssrc: typeof weriftTrack?.ssrc === 'number' ? weriftTrack.ssrc : undefined,
        lastNACKTime: undefined,
        receive: {
          // Buffered receive / playout state for audio RTP packets
          buffer: new Map(),
          expectedSequence: undefined,
          waitStart: undefined,
          playoutStart: undefined,
          playoutDelay: AUDIO_PLAYOUT_DELAY,
          maxWait: 160,
          maxSize: 256,
        },
        adaptive: {
          // Adaptive playout state for audio
          lastArrivalTime: undefined,
          lastRtpTimestamp: undefined,
          jitter: 0,
          currentDelay: AUDIO_PLAYOUT_DELAY,
        },
      };

      // Audio track is bidirectional (sendrecv), so we initialise talkback format from it,
      // but maintain separate RTP state for outbound talkback
      this.#tracks.talkback = {
        id: weriftTrack.codec.payloadType, // Talkback RTP payload type is the same as in the incoming audio track
        codec: Streamer.CODEC_TYPE.OPUS, // Talkback uses Opus
        sampleRate: sampleRate, // Sample rate for talkback matches incoming audio track
        channels: channels, // Same for channels
        packetTime: 20,
        rtp: {
          sequenceNumber: 0,
          timestamp: undefined,
        },
        active: undefined,
        started: undefined,
      };

      return;
    }

    if (weriftTrack?.kind === 'video' && weriftTrack?.codec?.payloadType === RTP_H264_VIDEO_PAYLOAD_TYPE) {
      this.#tracks.video = {
        id: weriftTrack.codec.payloadType, // RTP payload type for video
        rtxId: RTP_H264_VIDEO_RTX_PAYLOAD_TYPE, // RTP payload type for video RTX packets
        codec: Streamer.CODEC_TYPE.H264, // H.264 incoming, we pass through as H.264 output
        sampleRate:
          Number.isInteger(weriftTrack?.codec?.clockRate) === true && weriftTrack.codec.clockRate > 0 ? weriftTrack.codec.clockRate : 90000,
        ssrc: typeof weriftTrack?.ssrc === 'number' ? weriftTrack.ssrc : undefined,
        lastPLITime: undefined,
        lastNACKTime: undefined,
        lastIDRTime: undefined,
        startupPLIStartedAt: undefined,
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
          pendingRtpTimestamp: undefined,
          pendingKeyFrame: false,
        },
        receive: {
          // Buffered receive / playout state for video RTP packets
          buffer: new Map(),
          expectedSequence: undefined,
          waitStart: undefined,
          playoutStart: undefined,
          playoutDelay: VIDEO_PLAYOUT_DELAY,
          maxWait: 220,
          maxSize: 256,
        },
        adaptive: {
          // Adaptive playout state for video
          lastArrivalTime: undefined,
          lastRtpTimestamp: undefined,
          jitter: 0,
          currentDelay: VIDEO_PLAYOUT_DELAY,
        },
        startupPLITimer: undefined,
      };

      // Setup a short startup PLI retry loop for this video track.
      // This helps request a fresh keyframe during initial stream startup.
      clearInterval(this.#tracks.video.startupPLITimer);
      this.#tracks.video.startupPLITimer = undefined;
      this.#tracks.video.startupPLIStartedAt = Date.now();

      this.#sendVideoPLI('startup');

      this.#tracks.video.startupPLITimer = setInterval(() => {
        if (typeof this.#tracks?.video?.lastIDRTime === 'number') {
          clearInterval(this.#tracks.video.startupPLITimer);
          this.#tracks.video.startupPLITimer = undefined;
          this.#tracks.video.startupPLIStartedAt = undefined;
          return;
        }

        if (typeof this.#tracks?.video?.startupPLIStartedAt === 'number' && Date.now() - this.#tracks.video.startupPLIStartedAt >= 3000) {
          clearInterval(this.#tracks.video.startupPLITimer);
          this.#tracks.video.startupPLITimer = undefined;
          this.#tracks.video.startupPLIStartedAt = undefined;
          return;
        }

        this.#sendVideoPLI('startup keyframe retry');
      }, 1000);
    }
  }

  #ingestAudioRtpPacket(rtpPacket) {
    let audio = this.#tracks?.audio;
    let sequenceNumber = 0;
    let sequenceDelta = 0;

    if (
      typeof audio?.receive !== 'object' ||
      audio.receive === null ||
      typeof rtpPacket?.header?.sequenceNumber !== 'number' ||
      Buffer.isBuffer(rtpPacket?.payload) !== true
    ) {
      return;
    }

    // If we dont receive a packet in 10s, force a reconnect
    this.#refreshStallTimer();

    sequenceNumber = rtpPacket.header.sequenceNumber & RTP_SEQUENCE_MASK;

    // Track arrival timing for adaptive jitter estimation.
    // We compare actual wallclock packet arrival spacing against the expected
    // spacing derived from RTP timestamp progression.
    let now = Date.now();
    let rtpTimestamp = rtpPacket.header.timestamp >>> 0;

    if (ADAPTIVE_PLAYOUT_ENABLED === true) {
      if (typeof audio.adaptive.lastArrivalTime === 'number') {
        let interArrival = now - audio.adaptive.lastArrivalTime;
        let expectedInterArrival =
          typeof audio.adaptive.lastRtpTimestamp === 'number'
            ? (((rtpTimestamp - audio.adaptive.lastRtpTimestamp + RTP_TIMESTAMP_MASK) % RTP_TIMESTAMP_MASK) / audio.sampleRate) * 1000
            : audio.packetTime;

        // Guard against invalid or nonsensical RTP-derived spacing.
        // If that happens, fall back to the expected packet time for Opus audio.
        if (Number.isFinite(expectedInterArrival) !== true || expectedInterArrival < 0) {
          expectedInterArrival = audio.packetTime;
        }

        let deviation = Math.abs(interArrival - expectedInterArrival);

        // Smooth jitter estimate so playout delay changes gradually rather than jumping.
        audio.adaptive.jitter = audio.adaptive.jitter * 0.9 + deviation * 0.1;
      }

      audio.adaptive.lastArrivalTime = now;
      audio.adaptive.lastRtpTimestamp = rtpTimestamp;
    }

    // Initialise expected sequence and playout start on first packet.
    // This establishes the first packet we want to consume from the jitter buffer
    // and the initial delay before playback begins.
    if (typeof audio.receive.expectedSequence !== 'number') {
      audio.receive.expectedSequence = sequenceNumber;
      audio.receive.playoutStart = Date.now() + audio.receive.playoutDelay;
    }

    // Ignore packets older than the current expected sequence once we have moved past them.
    sequenceDelta = this.#sequenceDelta(sequenceNumber, audio.receive.expectedSequence);
    if (sequenceDelta > 0x8000) {
      return;
    }

    // Ignore duplicates already buffered.
    if (audio.receive.buffer.has(sequenceNumber) === true) {
      return;
    }

    audio.receive.buffer.set(sequenceNumber, rtpPacket);
  }

  #ingestVideoRtpPacket(rtpPacket) {
    let video = this.#tracks?.video;
    let sequenceNumber = 0;
    let sequenceDelta = 0;

    if (
      typeof video?.receive !== 'object' ||
      video.receive === null ||
      typeof rtpPacket?.header?.sequenceNumber !== 'number' ||
      Buffer.isBuffer(rtpPacket?.payload) !== true
    ) {
      return;
    }

    // If we dont receive a packet in 10s, force a reconnect
    this.#refreshStallTimer();

    // RTX packets are unwrapped back into the original media packet before they enter the
    // shared video reorder buffer. This allows retransmissions to repair frame assembly
    // without forcing a separate media path further downstream.
    if (rtpPacket.header.payloadType === video.rtxId) {
      this?.log?.debug?.(
        'Received WebRTC RTX packet for uuid "%s" at RTX sequence "%s"',
        this.nest_google_device_uuid,
        rtpPacket.header.sequenceNumber,
      );

      rtpPacket = this.#unwrapVideoRTXPacket(rtpPacket);
      if (rtpPacket === undefined) {
        return;
      }
    }

    // First video packet arrival indicates actual media has started arriving.
    // Keep this behaviour aligned with the earlier module.
    if (this.sourceState !== Streamer.MESSAGE_TYPE.SOURCE_READY && this.sourceState !== Streamer.MESSAGE_TYPE.SOURCE_CLOSED) {
      this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_READY);
    }

    sequenceNumber = rtpPacket.header.sequenceNumber & RTP_SEQUENCE_MASK;

    // Track arrival timing for adaptive jitter estimation.
    // For video we derive expected spacing from RTP timestamp movement, but clamp
    // obviously unreasonable values since video frame cadence can vary more than audio.
    let now = Date.now();
    let rtpTimestamp = rtpPacket.header.timestamp >>> 0;

    if (ADAPTIVE_PLAYOUT_ENABLED === true) {
      if (typeof video.adaptive.lastArrivalTime === 'number') {
        let interArrival = now - video.adaptive.lastArrivalTime;
        let expectedInterArrival =
          typeof video.adaptive.lastRtpTimestamp === 'number'
            ? (((rtpTimestamp - video.adaptive.lastRtpTimestamp + RTP_TIMESTAMP_MASK) % RTP_TIMESTAMP_MASK) / video.sampleRate) * 1000
            : 33;

        // Guard against invalid or unrealistic frame intervals.
        // If the RTP-derived spacing looks wrong, fall back to a nominal ~30fps interval.
        if (Number.isFinite(expectedInterArrival) !== true || expectedInterArrival < 0 || expectedInterArrival > 250) {
          expectedInterArrival = 33;
        }

        let deviation = Math.abs(interArrival - expectedInterArrival);

        // Smooth jitter estimate so playout delay adapts gradually.
        video.adaptive.jitter = video.adaptive.jitter * 0.9 + deviation * 0.1;
      }

      video.adaptive.lastArrivalTime = now;
      video.adaptive.lastRtpTimestamp = rtpTimestamp;
    }

    // Initialise expected sequence and playout start on first packet.
    // This establishes the first packet we want to drain from the reorder buffer
    // and the initial holdback before playback begins.
    if (typeof video.receive.expectedSequence !== 'number') {
      video.receive.expectedSequence = sequenceNumber;
      video.receive.playoutStart = Date.now() + video.receive.playoutDelay;
    }

    // Ignore packets older than the current expected sequence once we have moved past them.
    sequenceDelta = this.#sequenceDelta(sequenceNumber, video.receive.expectedSequence);
    if (sequenceDelta > 0x8000) {
      return;
    }

    // Ignore duplicates already buffered.
    if (video.receive.buffer.has(sequenceNumber) === true) {
      return;
    }

    video.receive.buffer.set(sequenceNumber, rtpPacket);
  }

  #ensurePlayoutLoop() {
    if (this.#playoutTimer !== undefined) {
      return;
    }

    // Drain buffered RTP on a short interval so we can:
    // - absorb modest network jitter
    // - release packets in sequence order
    // - give retransmissions a chance to arrive before declaring loss
    this.#playoutTimer = setInterval(() => {
      this.#drainAudioPackets();
      this.#drainVideoPackets();
    }, PLAYOUT_TICK);
  }

  #refreshStallTimer() {
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
  }

  #drainAudioPackets() {
    let audio = this.#tracks?.audio;
    let now = Date.now();
    let packet = undefined;
    let skippedPackets = 0;
    let syntheticPackets = 0;
    let maxSyntheticPacketsPerTick = 5;
    let frameSamples = 0;
    let syntheticSequence = 0;
    let syntheticTimestamp = 0;
    let receive = undefined;
    let receiveBuffer = undefined;
    let targetDelay = 0;

    if (typeof audio?.receive !== 'object' || audio.receive === null || typeof audio.receive.expectedSequence !== 'number') {
      return;
    }

    // Adjust our playout delay based on observed jitter.
    // We estimate how "messy" packet arrival is and then gently move the playout delay
    // up or down rather than jumping abruptly on every packet.
    if (ADAPTIVE_PLAYOUT_ENABLED === true) {
      targetDelay = Math.min(ADAPTIVE_PLAYOUT_MAX_DELAY, Math.max(ADAPTIVE_PLAYOUT_MIN_DELAY, audio.adaptive.jitter * 2));
      audio.adaptive.currentDelay =
        audio.adaptive.currentDelay * (1 - ADAPTIVE_PLAYOUT_ADJUST_RATE) + targetDelay * ADAPTIVE_PLAYOUT_ADJUST_RATE;
      audio.receive.playoutDelay = Math.round(audio.adaptive.currentDelay);
    }

    receive = audio.receive;
    receiveBuffer = receive.buffer;

    // Do not start draining until the initial playout delay has expired.
    // This gives late/reordered packets a short window to arrive before we begin
    // consuming from the jitter buffer.
    if (typeof receive.playoutStart === 'number' && now < receive.playoutStart) {
      return;
    }

    // Drain as many ordered packets as we reasonably can this tick.
    // We stop when:
    // - the next expected packet has not arrived yet and we still want to wait
    // - the jitter buffer is empty
    // - or we have inserted as much synthetic silence as we are willing to in one pass
    while (receiveBuffer.size !== 0 || typeof receive.waitStart === 'number') {
      // Best case: the exact next packet we want is present.
      // Consume it immediately, advance expected sequence, and clear any "waiting for gap repair" state.
      if (receiveBuffer.has(receive.expectedSequence) === true) {
        packet = receiveBuffer.get(receive.expectedSequence);
        receiveBuffer.delete(receive.expectedSequence);
        receive.expectedSequence = (receive.expectedSequence + 1) & RTP_SEQUENCE_MASK;
        receive.waitStart = undefined;
        this.#handleOrderedAudioPacket(packet, false);
        continue;
      }

      // We have detected a gap.
      // Start a short wait window and send an RTCP NACK to give retransmission a chance
      // before we decide the packet is really lost.
      if (typeof receive.waitStart !== 'number') {
        receive.waitStart = now;
        this.#sendAudioNACK(receive.expectedSequence, 1);
        break;
      }

      // We are already waiting on a missing packet, but have not yet reached the point
      // where we want to give up and conceal the loss with synthetic silence.
      if (now - receive.waitStart < receive.maxWait) {
        break;
      }

      skippedPackets = 0;

      // We have waited long enough, so move forward through a limited number of missing
      // sequence numbers looking for the next packet we actually have buffered.
      // Each skipped sequence will later be represented by a synthetic silent audio frame
      // so the downstream timeline remains continuous and monotonic.
      while (
        receiveBuffer.size !== 0 &&
        receiveBuffer.has(receive.expectedSequence) !== true &&
        skippedPackets < maxSyntheticPacketsPerTick
      ) {
        skippedPackets++;
        receive.expectedSequence = (receive.expectedSequence + 1) & RTP_SEQUENCE_MASK;

        if (receiveBuffer.has(receive.expectedSequence) === true) {
          break;
        }
      }

      if (skippedPackets > 0) {
        // We are filling a small gap with synthetic silence.
        //
        // Important:
        // build explicit synthetic RTP timestamps here rather than reusing the same
        // derived timestamp repeatedly. This keeps sequence and RTP time moving forward
        // in a predictable way during packet loss concealment.
        syntheticPackets = skippedPackets;
        frameSamples = Math.round((audio.sampleRate * audio.packetTime) / 1000);
        syntheticSequence = (receive.expectedSequence - skippedPackets + RTP_SEQUENCE_WRAP) & RTP_SEQUENCE_MASK;
        // Ensure RTP state exists
        if (typeof audio?.rtp !== 'object' || audio.rtp === null) {
          audio.rtp = {};
        }

        // Ensure timestamp baseline
        if (typeof audio.rtp.lastTimestamp !== 'number') {
          audio.rtp.lastTimestamp = 0;
        }
        syntheticTimestamp =
          typeof audio.rtp.lastTimestamp === 'number' ? (audio.rtp.lastTimestamp + frameSamples) >>> 0 : frameSamples >>> 0;

        while (syntheticPackets > 0) {
          this.#handleOrderedAudioPacket(
            {
              header: {
                payloadType: audio.id,
                sequenceNumber: syntheticSequence,
                timestamp: syntheticTimestamp,
              },
              payload: Buffer.alloc(0),
            },
            true,
          );

          syntheticSequence = (syntheticSequence + 1) & RTP_SEQUENCE_MASK;
          syntheticTimestamp = (syntheticTimestamp + frameSamples) >>> 0;
          syntheticPackets--;
        }

        // Start another short wait window from "now" before deciding whether we need
        // to conceal more loss. This prevents us from racing too far ahead in one tick.
        receive.waitStart = now;

        // If we still do not have the next expected real packet, stop here and wait for
        // the next scheduler tick rather than over-draining or generating too much silence.
        if (receiveBuffer.size === 0 || receiveBuffer.has(receive.expectedSequence) !== true) {
          break;
        }

        continue;
      }

      // We could not recover cleanly and could not find a nearby packet to resume from.
      // At this point the jitter buffer state is likely no longer trustworthy, so reset it
      // and allow the next arriving packet to establish a fresh baseline.
      this?.log?.debug?.('Resetting WebRTC audio jitter buffer for uuid "%s" due to excessive gap', this.nest_google_device_uuid);
      receiveBuffer.clear();
      receive.expectedSequence = undefined;
      receive.waitStart = undefined;
      receive.playoutStart = undefined;
      audio.adaptive.lastArrivalTime = undefined;
      audio.adaptive.lastRtpTimestamp = undefined;
      break;
    }

    // Safety guard: if the audio jitter buffer grows too large, discard it and restart
    // cleanly rather than letting latency grow without bound.
    if (receiveBuffer.size > receive.maxSize) {
      this?.log?.debug?.('Resetting WebRTC audio jitter buffer for uuid "%s" due to overflow', this.nest_google_device_uuid);
      receiveBuffer.clear();
      receive.expectedSequence = undefined;
      receive.waitStart = undefined;
      receive.playoutStart = undefined;
      audio.adaptive.lastArrivalTime = undefined;
      audio.adaptive.lastRtpTimestamp = undefined;
    }
  }

  #drainVideoPackets() {
    let video = this.#tracks?.video;
    let now = Date.now();
    let packet = undefined;
    let skippedPackets = 0;
    let maxSkippedPacketsPerTick = 4;
    let receive = undefined;
    let receiveBuffer = undefined;
    let targetDelay = 0;

    if (typeof video?.receive !== 'object' || video.receive === null || typeof video.receive.expectedSequence !== 'number') {
      return;
    }

    // Adapt playout delay based on observed jitter.
    // Same concept as audio: we slowly converge toward a delay that smooths jitter
    // without introducing unnecessary latency.
    if (ADAPTIVE_PLAYOUT_ENABLED === true) {
      targetDelay = Math.min(ADAPTIVE_PLAYOUT_MAX_DELAY, Math.max(ADAPTIVE_PLAYOUT_MIN_DELAY, video.adaptive.jitter * 2));
      video.adaptive.currentDelay =
        video.adaptive.currentDelay * (1 - ADAPTIVE_PLAYOUT_ADJUST_RATE) + targetDelay * ADAPTIVE_PLAYOUT_ADJUST_RATE;
      video.receive.playoutDelay = Math.round(video.adaptive.currentDelay);
    }

    receive = video.receive;
    receiveBuffer = receive.buffer;

    // Do not start draining until initial playout delay has elapsed.
    // This allows time for out-of-order packets to arrive before playback begins.
    if (typeof receive.playoutStart === 'number' && now < receive.playoutStart) {
      return;
    }

    // Drain loop:
    // We consume packets in strict sequence order, handling:
    // 1. Normal ordered delivery
    // 2. Short wait for missing packets (with NACK)
    // 3. Loss recovery via skip + frame reset + optional PLI
    while (receiveBuffer.size !== 0 || typeof receive.waitStart === 'number') {
      // === 1. Normal case: expected packet is available ===
      if (receiveBuffer.has(receive.expectedSequence) === true) {
        packet = receiveBuffer.get(receive.expectedSequence);
        receiveBuffer.delete(receive.expectedSequence);

        receive.expectedSequence = (receive.expectedSequence + 1) & RTP_SEQUENCE_MASK;
        receive.waitStart = undefined;

        this.#handleOrderedVideoPacket(packet);
        continue;
      }

      // === 2. Missing packet detected (start wait window + NACK) ===
      if (typeof receive.waitStart !== 'number') {
        receive.waitStart = now;

        // Ask sender for retransmission of the missing packet.
        // We only request a single packet here to avoid excessive RTCP traffic.
        this.#sendVideoNACK(receive.expectedSequence, 1);
        break;
      }

      // Still within wait window — give retransmission a chance.
      if (now - receive.waitStart < receive.maxWait) {
        break;
      }

      // === 3. Gap recovery (packet considered lost) ===
      skippedPackets = 0;

      // Advance forward through a limited number of missing packets.
      // Unlike audio, we do NOT generate synthetic frames — instead we:
      // - drop partial frame assembly
      // - resync at next valid packet
      while (
        receiveBuffer.size !== 0 &&
        receiveBuffer.has(receive.expectedSequence) !== true &&
        skippedPackets < maxSkippedPacketsPerTick
      ) {
        skippedPackets++;

        receive.expectedSequence = (receive.expectedSequence + 1) & RTP_SEQUENCE_MASK;

        if (receiveBuffer.has(receive.expectedSequence) === true) {
          break;
        }
      }

      if (skippedPackets > 0) {
        // We have skipped one or more packets → current frame is likely corrupted.
        // Reset FU-A / frame assembly state so we do not emit partial frames.
        this.#resetVideoAssemblyAfterLoss();

        // If more than one packet was lost, request a new keyframe (IDR) via PLI.
        // This helps recover decoder state quickly instead of waiting indefinitely.
        if (skippedPackets > 1) {
          this.#sendVideoPLI('video packet loss');
        }

        // Start a new wait window before attempting further recovery.
        // Prevents runaway skipping within a single tick.
        receive.waitStart = now;
        break;
      }

      // Could not recover a usable next packet → jitter buffer likely invalid.
      // Reset jitter buffer and allow fresh resync from next arriving packet.
      this?.log?.debug?.('Resetting WebRTC video jitter buffer for uuid "%s" due to excessive gap', this.nest_google_device_uuid);

      receiveBuffer.clear();
      receive.expectedSequence = undefined;
      receive.waitStart = undefined;
      receive.playoutStart = undefined;

      video.adaptive.lastArrivalTime = undefined;
      video.adaptive.lastRtpTimestamp = undefined;

      this.#resetVideoAssemblyAfterLoss();
      break;
    }

    // Safety: prevent unbounded jitter buffer growth.
    // If too many packets accumulate, drop everything and resync.
    if (receiveBuffer.size > receive.maxSize) {
      this?.log?.debug?.('Resetting WebRTC video jitter buffer for uuid "%s" due to overflow', this.nest_google_device_uuid);

      receiveBuffer.clear();
      receive.expectedSequence = undefined;
      receive.waitStart = undefined;
      receive.playoutStart = undefined;

      video.adaptive.lastArrivalTime = undefined;
      video.adaptive.lastRtpTimestamp = undefined;

      this.#resetVideoAssemblyAfterLoss();
    }
  }

  #calculateTimestamp(packet, track, maxStepMs = undefined, options = {}) {
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

    let deltaTicks = (rtpTimestamp - track.rtp.lastTimestamp + RTP_TIMESTAMP_MASK) % RTP_TIMESTAMP_MASK;

    // Older / reordered packet
    if (deltaTicks > RTP_TIMESTAMP_MAX_DELTA) {
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
  }

  #handleOrderedAudioPacket(rtpPacket, silencePacket = false) {
    let audio = this.#tracks?.audio;
    let pcm = undefined;
    let timestamp = undefined;
    let mediaData = undefined;

    if (typeof audio !== 'object' || audio === null || typeof rtpPacket?.header?.payloadType !== 'number') {
      return;
    }

    // Track RTP sequence numbers for audio packets so our timing and sequence
    // state remains continuous even when synthetic silence is inserted.
    if (typeof audio?.rtp?.lastSequence === 'number') {
      let sequenceDelta = this.#sequenceDelta(rtpPacket.header.sequenceNumber, audio.rtp.lastSequence);

      if (silencePacket !== true && sequenceDelta > 1 && sequenceDelta < RTP_SEQUENCE_WRAP / 2) {
        // Removed noisy audio sequence gap log
      }

      // Older/reordered audio packet
      if (sequenceDelta > RTP_SEQUENCE_WRAP / 2) {
        return;
      }
    }

    audio.rtp.lastSequence = rtpPacket.header.sequenceNumber;

    timestamp = this.#calculateTimestamp(rtpPacket, audio, TIMESTAMP_MAX_AUDIO_DELTA, { allowEqual: false });
    if (typeof timestamp !== 'number') {
      return;
    }

    if (silencePacket !== true) {
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
    }

    // Emit exactly one audio media item per ordered audio unit.
    // On decode failure or packet loss we substitute silence so Streamer still receives
    // a clean, monotonic audio timeline from a single code path.
    mediaData = Buffer.isBuffer(pcm) === true && pcm.length > 0 ? pcm : this.#buildAudioSilenceFrame();

    this.addMedia({
      type: Streamer.MEDIA_TYPE.AUDIO,
      codec: this.codecs.audio,
      sampleRate: Number.isFinite(audio?.sampleRate) === true && audio.sampleRate > 0 ? audio.sampleRate : undefined,
      channels: Number.isFinite(audio?.channels) === true && audio.channels > 0 ? audio.channels : undefined,
      timestamp: timestamp,
      keyFrame: false,
      data: mediaData,
    });
  }

  #handleOrderedVideoPacket(rtpPacket) {
    let video = this.#tracks?.video;
    let now = Date.now();
    let payload = undefined;
    let nalHeader = 0;
    let type = 0;
    let rtpTimestamp = 0;
    let fuHeader = 0;
    let fuType = 0;
    let reconstructedNal = undefined;
    let fragmentPayload = undefined;
    let completedBuffer = undefined;
    let completedType = undefined;
    let completedRtpTimestamp = undefined;
    let offset = 0;
    let naluLength = 0;
    let nalu = undefined;
    let naluType = 0;

    if (
      typeof video !== 'object' ||
      video === null ||
      typeof rtpPacket?.header?.payloadType !== 'number' ||
      Buffer.isBuffer(rtpPacket?.payload) !== true ||
      rtpPacket.payload.length === 0
    ) {
      return;
    }

    // Track RTP sequence numbers for video and detect packet loss.
    // Loss can invalidate any frame currently being assembled, so we reset
    // frame assembly state on forward gaps.
    if (typeof video?.rtp?.lastSequence === 'number') {
      let sequenceDelta = this.#sequenceDelta(rtpPacket.header.sequenceNumber, video.rtp.lastSequence);

      if (sequenceDelta > 1 && sequenceDelta < RTP_SEQUENCE_WRAP / 2) {
        // Removed noisy sequence gap log
        this.#resetVideoAssemblyAfterLoss();

        if (sequenceDelta > 2) {
          this.#sendVideoPLI('video packet loss');
        }
      }

      // Older/reordered video packet
      if (sequenceDelta > RTP_SEQUENCE_WRAP / 2) {
        return;
      }
    }

    video.rtp.lastSequence = rtpPacket.header.sequenceNumber;

    // If we have not received an IDR frame in a while, request a new one with a PLI to help recovery
    if (typeof video.lastIDRTime === 'number' && now - video.lastIDRTime > IDR_TIMEOUT) {
      this.#sendVideoPLI('idr refresh timeout');
    }

    payload = rtpPacket.payload;
    nalHeader = payload[0];
    type = nalHeader & 0x1f;
    rtpTimestamp = rtpPacket.header.timestamp >>> 0;

    if (typeof video?.h264 !== 'object' || video.h264 === null) {
      video.h264 = {};
    }

    if (Array.isArray(video.h264.pendingParts) !== true) {
      video.h264.pendingParts = [];
    }

    // Single-Time Aggregation Packet (STAP-A)
    if (type === Streamer.H264NALUS.TYPES.STAP_A) {
      offset = 1;

      while (offset + 2 <= payload.length) {
        naluLength = payload.readUInt16BE(offset);
        offset += 2;

        if (naluLength <= 0 || offset + naluLength > payload.length) {
          break;
        }

        nalu = payload.subarray(offset, offset + naluLength);
        naluType = nalu[0] & 0x1f;
        offset += naluLength;

        this.#appendVideoNalu(nalu, rtpTimestamp, naluType, now);
      }

      if (rtpPacket.header.marker === true) {
        this.#flushPendingVideoFrame();
      }
      return;
    }

    // Fragmentation Unit A (FU-A)
    if (type === Streamer.H264NALUS.TYPES.FU_A) {
      if (payload.length < 3) {
        return;
      }

      fuHeader = payload[1];
      fuType = fuHeader & 0x1f;
      reconstructedNal = Buffer.from([(nalHeader & 0xe0) | fuType]);
      fragmentPayload = payload.subarray(2);

      if (fragmentPayload.length === 0) {
        return;
      }

      if (((fuHeader & 0x80) !== 0) === true) {
        // Start of FU-A, initialise buffer and store type and timestamp
        clearTimeout(video.h264.fuTimer);
        video.h264.fuBuffer = [reconstructedNal, fragmentPayload];
        video.h264.fuType = fuType;
        video.h264.fuTimestamp = rtpTimestamp;

        video.h264.fuTimer = setTimeout(() => {
          // Removed noisy FU-A discard log
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
        let completedLength = 0;
        for (let fragment of video.h264.fuBuffer) {
          if (Buffer.isBuffer(fragment) === true && fragment.length > 0) {
            completedLength += fragment.length;
          }
        }

        completedBuffer = Buffer.allocUnsafe(completedLength);
        let writeOffset = 0;
        for (let fragment of video.h264.fuBuffer) {
          if (Buffer.isBuffer(fragment) === true && fragment.length > 0) {
            fragment.copy(completedBuffer, writeOffset);
            writeOffset += fragment.length;
          }
        }

        completedType = video.h264.fuType;
        completedRtpTimestamp = video.h264.fuTimestamp;

        clearTimeout(video.h264.fuTimer);
        video.h264.fuBuffer = [];
        video.h264.fuType = undefined;
        video.h264.fuTimestamp = undefined;

        this.#appendVideoNalu(completedBuffer, completedRtpTimestamp, completedType, now);

        if (rtpPacket.header.marker === true) {
          this.#flushPendingVideoFrame();
        }
      }

      return;
    }

    // Raw NAL unit
    this.#appendVideoNalu(payload, rtpTimestamp, type, now);

    if (rtpPacket.header.marker === true) {
      this.#flushPendingVideoFrame();
    }
  }

  #appendVideoNalu(nalu, rtpTimestamp, naluType, now) {
    let video = this.#tracks?.video;
    let h264 = video?.h264;

    if (
      Buffer.isBuffer(nalu) !== true ||
      nalu.length === 0 ||
      typeof rtpTimestamp !== 'number' ||
      typeof h264 !== 'object' ||
      h264 === null
    ) {
      return;
    }

    // If a new RTP timestamp arrives while we are still buffering NALs
    // for a previous frame, drop the incomplete frame completely so the
    // next access unit starts from a clean timestamp boundary.
    if (typeof h264.pendingRtpTimestamp === 'number' && h264.pendingRtpTimestamp !== rtpTimestamp && h264.pendingParts.length > 0) {
      // Removed noisy incomplete frame drop log
      this.#resetPendingVideoFrame();
    }

    // Track frame timestamp
    if (typeof h264.pendingRtpTimestamp !== 'number') {
      h264.pendingRtpTimestamp = rtpTimestamp;
    }

    // Cache SPS / PPS / IDR safely (copy buffers!)
    if (naluType === Streamer.H264NALUS.TYPES.SPS) {
      h264.lastSPS = Buffer.from(nalu);
    }

    if (naluType === Streamer.H264NALUS.TYPES.PPS) {
      h264.lastPPS = Buffer.from(nalu);
    }

    if (naluType === Streamer.H264NALUS.TYPES.IDR) {
      h264.lastIDR = Buffer.from(nalu);
      video.lastIDRTime = now;
      h264.pendingKeyFrame = true;
    }

    // Store NAL (copy to avoid shared memory issues)
    h264.pendingParts.push(Buffer.from(nalu));
  }

  #buildAudioSilenceFrame() {
    let audio = this.#tracks?.audio;
    let key = undefined;
    let samples = 0;
    let buffer = undefined;

    if (typeof audio !== 'object' || audio === null) {
      return this.blankAudio;
    }

    key = String(audio.sampleRate) + '-' + String(audio.channels) + '-' + String(audio.packetTime);

    if (this.#audioSilenceCache.has(key) === true) {
      return this.#audioSilenceCache.get(key);
    }

    samples = Math.round((audio.sampleRate * audio.packetTime) / 1000);
    buffer = Buffer.alloc(samples * audio.channels * 2);

    this.#audioSilenceCache.set(key, buffer);
    return buffer;
  }

  #unwrapVideoRTXPacket(rtpPacket) {
    let video = this.#tracks?.video;
    let originalSequence = 0;
    let payload = undefined;
    let header = undefined;

    if (
      typeof video !== 'object' ||
      video === null ||
      rtpPacket?.header?.payloadType !== video?.rtxId ||
      Buffer.isBuffer(rtpPacket?.payload) !== true ||
      rtpPacket.payload.length <= 2
    ) {
      return;
    }

    // RFC 4588:
    // the first two bytes of the RTX payload carry the original media packet sequence number.
    originalSequence = rtpPacket.payload.readUInt16BE(0);
    payload = rtpPacket.payload.subarray(2);

    if (payload.length === 0) {
      return;
    }

    // Rebuild a packet that looks like the original media packet so our normal video
    // pipeline can handle it without needing a separate downstream path.
    header = {
      ...rtpPacket.header,
      payloadType: video.id,
      sequenceNumber: originalSequence,
      ssrc: typeof video?.ssrc === 'number' ? video.ssrc : rtpPacket.header.ssrc,
    };

    return {
      header: header,
      payload: payload,
    };
  }

  #resetVideoAssemblyAfterLoss() {
    let video = this.#tracks?.video;

    if (typeof video !== 'object' || video === null) {
      return;
    }

    clearTimeout(video.h264?.fuTimer);
    video.h264.fuBuffer = undefined;
    video.h264.fuType = undefined;
    video.h264.fuTimestamp = undefined;

    this.#resetPendingVideoFrame();

    // Reset frame RTP timing baseline so the next completed frame starts from a clean anchor
    // after packet loss, but preserve the last emitted output timestamp so downstream video
    // timing is still forced to remain monotonic.
    video.rtp.lastTimestamp = undefined;
    video.rtp.lastCalculatedTimestamp = undefined;
    video.adaptive.lastArrivalTime = undefined;
    video.adaptive.lastRtpTimestamp = undefined;
  }

  #sendVideoPLI(reason = '') {
    let video = this.#tracks?.video;
    let now = Date.now();

    if (this.#videoTransceiver === undefined || video === undefined || typeof video?.ssrc !== 'number') {
      return;
    }

    if (typeof video.lastPLITime === 'number' && now - video.lastPLITime < 1500) {
      return;
    }

    video.lastPLITime = now;

    this?.log?.debug?.('Sending RTCP PLI for uuid "%s"%s', this.nest_google_device_uuid, reason !== '' ? ' (' + reason + ')' : '');

    this.#videoTransceiver?.receiver?.sendRtcpPLI?.(video.ssrc);
  }

  #sendVideoNACK(startSequence, count = 1) {
    let video = this.#tracks?.video;
    let now = Date.now();
    let lost = [];
    let index = 0;

    if (
      this.#videoTransceiver === undefined ||
      video === undefined ||
      typeof startSequence !== 'number' ||
      count <= 0 ||
      typeof this.#videoTransceiver?.receiver?.sendRtcpNack !== 'function'
    ) {
      return;
    }

    if (typeof video.lastNACKTime === 'number' && now - video.lastNACKTime < 100) {
      return;
    }

    while (index < count && lost.length < MAX_NACK_BURST) {
      lost.push((startSequence + index) & RTP_SEQUENCE_MASK);
      index++;
    }

    if (lost.length === 0) {
      return;
    }

    video.lastNACKTime = now;

    try {
      // Different werift versions may expose NACK sending with slightly different signatures.
      // We first try the common form of passing media SSRC and sequence list, then fall back
      // to a sequence-list-only call if needed.
      this.#videoTransceiver.receiver.sendRtcpNack(video.ssrc, lost);
    } catch {
      try {
        this.#videoTransceiver.receiver.sendRtcpNack(lost);
      } catch {
        // Empty
      }
    }
  }

  #sendAudioNACK(startSequence, count = 1) {
    let audio = this.#tracks?.audio;
    let now = Date.now();
    let lost = [];
    let index = 0;

    if (
      this.#audioTransceiver === undefined ||
      audio === undefined ||
      typeof startSequence !== 'number' ||
      count <= 0 ||
      typeof this.#audioTransceiver?.receiver?.sendRtcpNack !== 'function' ||
      typeof audio?.ssrc !== 'number'
    ) {
      return;
    }

    if (typeof audio.lastNACKTime === 'number' && now - audio.lastNACKTime < 100) {
      return;
    }

    while (index < count && lost.length < MAX_AUDIO_NACK_BURST) {
      lost.push((startSequence + index) & RTP_SEQUENCE_MASK);
      index++;
    }

    if (lost.length === 0) {
      return;
    }

    audio.lastNACKTime = now;

    try {
      this.#audioTransceiver.receiver.sendRtcpNack(audio.ssrc, lost);
    } catch {
      try {
        this.#audioTransceiver.receiver.sendRtcpNack(lost);
      } catch {
        // Empty
      }
    }
  }

  #requestReconnect(reason) {
    if (this.#reconnectPending === true) {
      return;
    }

    this.#reconnectPending = true;
    this.#reconnectReason = reason;

    this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_RECONNECTING, reason);
  }

  #resetPendingVideoFrame() {
    if (typeof this.#tracks?.video?.h264 !== 'object' || this.#tracks.video.h264 === null) {
      return;
    }

    this.#tracks.video.h264.pendingParts = [];
    this.#tracks.video.h264.pendingRtpTimestamp = undefined;
    this.#tracks.video.h264.pendingKeyFrame = false;
  }

  #flushPendingVideoFrame() {
    let video = this.#tracks?.video;
    let h264 = video?.h264;
    let videoRtp = video?.rtp;
    let pendingParts = h264?.pendingParts;
    let pendingRtpTimestamp = h264?.pendingRtpTimestamp;
    let pendingKeyFrame = h264?.pendingKeyFrame;
    let pendingTimestamp = undefined;
    let index = 0;
    let part = undefined;
    let data = undefined;
    let deltaTicks = 0;
    let deltaMs = 0;
    let totalLength = 0;
    let writeOffset = 0;
    let emitParts = [];
    let hasSPS = false;
    let hasPPS = false;
    let partType = 0;

    // Nothing buffered for the current access unit, so just clear state and return
    if (Array.isArray(pendingParts) !== true || pendingParts.length === 0 || typeof pendingRtpTimestamp !== 'number') {
      this.#resetPendingVideoFrame();
      return;
    }

    if (typeof videoRtp !== 'object' || videoRtp === null) {
      this.#resetPendingVideoFrame();
      return;
    }

    // Ensure keyframes can recover decoders by prepending cached SPS/PPS when
    // they are not already part of the assembled access unit.
    if (pendingKeyFrame === true) {
      index = 0;

      while (index < pendingParts.length) {
        part = pendingParts[index];

        if (Buffer.isBuffer(part) === true && part.length > 0) {
          partType = part[0] & 0x1f;

          if (partType === Streamer.H264NALUS.TYPES.SPS) {
            hasSPS = true;
          }

          if (partType === Streamer.H264NALUS.TYPES.PPS) {
            hasPPS = true;
          }
        }

        index++;
      }

      if (hasSPS !== true && Buffer.isBuffer(h264?.lastSPS) === true && h264.lastSPS.length > 0) {
        emitParts.push(Buffer.from(h264.lastSPS));
      }

      if (hasPPS !== true && Buffer.isBuffer(h264?.lastPPS) === true && h264.lastPPS.length > 0) {
        emitParts.push(Buffer.from(h264.lastPPS));
      }
    }

    emitParts = emitParts.concat(pendingParts);

    // Build one Annex-B frame from the collected raw NAL units.
    index = 0;
    while (index < emitParts.length) {
      part = emitParts[index];

      if (Buffer.isBuffer(part) === true && part.length > 0) {
        if (part.indexOf(Streamer.H264NALUS.START_CODE) === 0) {
          totalLength += part.length;
        } else {
          totalLength += Streamer.H264NALUS.START_CODE.length + part.length;
        }
      }

      index++;
    }

    if (totalLength === 0) {
      this.#resetPendingVideoFrame();
      return;
    }

    data = Buffer.allocUnsafe(totalLength);
    index = 0;

    while (index < emitParts.length) {
      part = emitParts[index];

      if (Buffer.isBuffer(part) === true && part.length > 0) {
        if (part.indexOf(Streamer.H264NALUS.START_CODE) === 0) {
          part.copy(data, writeOffset);
          writeOffset += part.length;
        } else {
          Streamer.H264NALUS.START_CODE.copy(data, writeOffset);
          writeOffset += Streamer.H264NALUS.START_CODE.length;
          part.copy(data, writeOffset);
          writeOffset += part.length;
        }
      }

      index++;
    }

    // Safety guard: if concatenation produced nothing useful, discard the pending frame
    if (Buffer.isBuffer(data) !== true || data.length === 0) {
      this.#resetPendingVideoFrame();
      return;
    }

    // First emitted frame for this track:
    // initialise our RTP timing baseline directly from the completed frame RTP timestamp
    if (typeof videoRtp.lastTimestamp !== 'number' || typeof videoRtp.lastCalculatedTimestamp !== 'number') {
      videoRtp.lastTimestamp = pendingRtpTimestamp;
      videoRtp.lastCalculatedTimestamp = Date.now();
      pendingTimestamp = videoRtp.lastCalculatedTimestamp;
    }

    // For subsequent frames, calculate one timestamp per completed access unit
    // from the difference between this frame RTP timestamp and the previous frame RTP timestamp
    if (typeof pendingTimestamp !== 'number') {
      deltaTicks = (pendingRtpTimestamp - videoRtp.lastTimestamp + RTP_TIMESTAMP_MASK) % RTP_TIMESTAMP_MASK;

      // If this looks like an older/reordered frame timestamp, drop it rather than emit backwards time
      if (deltaTicks > RTP_TIMESTAMP_MAX_DELTA) {
        this.#resetPendingVideoFrame();
        return;
      }

      deltaMs = (deltaTicks / video.sampleRate) * 1000;

      // Clamp invalid values back to zero rather than poisoning output timing
      if (Number.isFinite(deltaMs) !== true || deltaMs < 0) {
        deltaMs = 0;
      }

      // Guard against very large RTP jumps causing huge frame time jumps downstream
      if (deltaMs > TIMESTAMP_MAX_VIDEO_DELTA) {
        deltaMs = TIMESTAMP_MAX_VIDEO_DELTA;
      }

      pendingTimestamp = videoRtp.lastCalculatedTimestamp + deltaMs;
    }

    // Final monotonicity guard:
    // completed video frames must always move forward in output time, even if RTP timing
    // wobbles slightly after packet loss, reordering or frame assembly resets.
    pendingTimestamp =
      typeof videoRtp.lastEmittedTimestamp === 'number' ? Math.max(pendingTimestamp, videoRtp.lastEmittedTimestamp + 1) : pendingTimestamp;

    // Update RTP/frame timing state only once per fully assembled frame
    videoRtp.lastTimestamp = pendingRtpTimestamp;
    videoRtp.lastCalculatedTimestamp = pendingTimestamp;
    videoRtp.lastEmittedTimestamp = pendingTimestamp;

    if (pendingKeyFrame === true) {
      video.lastIDRTime = Date.now();
      h264.lastSpsEmitTime = Date.now();
      clearInterval(video?.startupPLITimer);
      video.startupPLITimer = undefined;
    }

    // Emit exactly one media item per completed video frame/access unit.
    // This is the only place video addMedia() should be called from WebRTC.
    this.addMedia({
      type: Streamer.MEDIA_TYPE.VIDEO,
      codec: this.codecs.video,
      profile: typeof this.video?.profile === 'string' ? this.video.profile : undefined,
      bitrate: Number.isFinite(this.video?.bitrate) === true && this.video.bitrate > 0 ? this.video.bitrate : undefined,
      timestamp: pendingTimestamp,
      keyFrame: pendingKeyFrame === true,
      data: data,
    });

    this.#resetPendingVideoFrame();
  }

  // Need more work in here*
  // < error handling
  // < timeout?
  async #googleHomeFoyerCommand(service, command, values) {
    let buffer = undefined;
    let offset = 0;
    let TraitMapRequest = undefined;
    let TraitMapResponse = undefined;
    let commandResponse = {
      status: undefined,
      message: '',
      data: [],
    };

    if (
      typeof service !== 'string' ||
      service === '' ||
      typeof command !== 'string' ||
      command === '' ||
      typeof values !== 'object' ||
      values === null
    ) {
      return;
    }

    if (this.#protobufFoyer === undefined) {
      commandResponse.status = 500;
      commandResponse.message = 'Google Home Foyer protobuf support is unavailable';
      return commandResponse;
    }

    TraitMapRequest = this.#protobufFoyer.lookup(GOOGLE_HOME_FOYER_PREFIX + command + 'Request');
    TraitMapResponse = this.#protobufFoyer.lookup(GOOGLE_HOME_FOYER_PREFIX + command + 'Response');
    buffer = Buffer.allocUnsafe(GOOGLE_HOME_FOYER_BUFFER_INITIAL);

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
          let newSize = 0;
          let newBuffer = undefined;

          if (commandResponse.status === 413) {
            return;
          }

          if (offset + data.length > GOOGLE_HOME_FOYER_BUFFER_MAX) {
            commandResponse.status = 413;
            commandResponse.message = 'gRPC response exceeds maximum buffer size';
            try {
              request.close();
            } catch {
              // Empty
            }
            return;
          }

          while (offset + data.length > buffer.length) {
            newSize = buffer.length * 2;
            if (newSize > GOOGLE_HOME_FOYER_BUFFER_MAX) {
              newSize = GOOGLE_HOME_FOYER_BUFFER_MAX;
            }

            if (newSize < offset + data.length) {
              if (newSize === GOOGLE_HOME_FOYER_BUFFER_MAX) {
                commandResponse.status = 413;
                commandResponse.message = 'gRPC response exceeds maximum buffer size';
                try {
                  request.close();
                } catch {
                  // Empty
                }
                return;
              }

              continue;
            }

            newBuffer = Buffer.allocUnsafe(newSize);
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
