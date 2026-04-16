// WebRTC
// Part of homebridge-nest-accfactory
//
// Implements WebRTC-based streaming for Google Nest cameras using Google Home
// Foyer/gRPC signaling and control.
// Handles peer connection setup, RTP media processing, and integration with the
// Streamer pipeline for HomeKit live streaming and recording.
//
// Responsibilities:
// - Establish and manage RTCPeerConnection using the werift library
// - Use a pooled Google gRPC transport/client for Foyer signaling and stream control
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
// - WebRTC signaling and stream control are performed via the shared Google gRPC transport/client
// - Video readiness is determined by first video RTP packet arrival, not connection state
// - ICE "connected" indicates transport readiness, not media availability
// - Startup delays may occur due to upstream (Google) keyframe delivery behaviour
//
// Code version 2026.04.14
// Mark Hulskamp
'use strict';

// Define external module requirements
import * as werift from 'werift';
import { Decoder } from '@evan/opus';

// Define nodejs module requirements
import { Buffer } from 'node:buffer';
import { setInterval, clearInterval } from 'node:timers';
import path from 'node:path';
import crypto from 'node:crypto';

// Define our modules
import Streamer from './streamer.js';
import GrpcTransport from './grpctransport.js';

// Define constants
import { USER_AGENT, __dirname } from './consts.js';

const EXTEND_INTERVAL = 30000; // Send extend command to Google Home Foyer every this period for active streams
const GOOGLE_HOME_FOYER_REQUEST_TIMEOUT = 15000; // Client-side timeout for Google Home Foyer gRPC requests
const GOOGLE_HOME_FOYER_BUFFER_INITIAL = 8 * 1024; // Initial 8KB buffer for gRPC responses
const GOOGLE_HOME_FOYER_BUFFER_MAX = 10 * 1024 * 1024; // Maximum 10MB buffer limit
const RTP_SEQUENCE_WRAP = 0x10000; // For wrapping sequence calculations
const RTP_SEQUENCE_MASK = 0xffff; // 16-bit RTP sequence number mask
const RTP_TIMESTAMP_MASK = 0x100000000; // 32-bit RTP timestamp wrap mask
const RTP_TIMESTAMP_MAX_DELTA = 0x7fffffff; // Max positive delta for timestamp comparison
const RTP_PACKET_HEADER_SIZE = 12; // RTP packet header size in bytes
const RTP_H264_VIDEO_PAYLOAD_TYPE = 98; // H.264 video payload type
const RTP_H264_VIDEO_RTX_PAYLOAD_TYPE = 99; // H.264 RTX payload type for retransmissions
const RTP_OPUS_AUDIO_PAYLOAD_TYPE = 111; // Opus audio payload type
const GOOGLE_HOME_FOYER_PREFIX = 'google.internal.home.foyer.v1.';
const TIMESTAMP_MAX_VIDEO_DELTA = 2300; // Track observed ~2.2s IDR assembly windows without forcing aggressive timestamp compression
const TIMESTAMP_MAX_KEYFRAME_DELTA = 450; // Cap keyframe playout step more aggressively
const TIMESTAMP_VIDEO_MAX_BEHIND = 500; // Keep emitted timestamps from lagging too far behind wall clock
const TIMESTAMP_VIDEO_MAX_AHEAD = 450; // Allow variable-FPS bursts without compressing frame emission too aggressively
const TIMESTAMP_MAX_AUDIO_DELTA = 120;
const TIMESTAMP_AUDIO_RESYNC_BEHIND = 180; // Only hard-resync audio when callback delay has grown materially large
const KEYFRAME_MAX_ASSEMBLY_MS = 2500; // Drop pathological keyframes assembled too slowly
const KEYFRAME_MAX_BYTES = 120000; // Drop oversized keyframes that cause visible playback shock
const HEALTH_BAD_WINDOW_MS = 3000; // Rolling window for stream-health bad events
const HEALTH_UNSTABLE_BAD_THRESHOLD = 4; // Enter UNSTABLE when recent bad event score reaches this
const HEALTH_RECOVERING_CLEAN_TARGET = 6; // Exit RECOVERING after this weighted clean score
const DELTA_FU_SWITCH_GRACE_MS = 70; // Tiny grace before abandoning a young non-keyframe FU-A on timestamp switch
const STALLED_TIMEOUT = 10000; // Time with no playback packets before we consider stream stalled and attempt restart
const PCM_S16LE_48000_STEREO_BLANK = Buffer.alloc(960 * 2 * 2); // Default blank audio frame (20ms) in PCM S16LE, stereo @ 48kHz

// WebRTC object
export default class WebRTC extends Streamer {
  token = undefined; // oauth2 token
  blankAudio = PCM_S16LE_48000_STEREO_BLANK;

  // Internal data only for this class
  #grpcTransport = undefined; // Shared protobuf/gRPC client for Google Home Foyer APIs
  #streamId = undefined; // Stream ID
  #googleHomeDeviceUUID = undefined; // Normal Nest/Google protobuf device ID translated to a Google Foyer device ID
  #googleHomeDeviceUUIDPromise = undefined; // Promise for in-flight HomeGraph lookup of Google Foyer device UUID
  #peerConnection = undefined;
  #videoTransceiver = undefined;
  #audioTransceiver = undefined;
  #opusDecoder = new Decoder({ channels: 2, sample_rate: 48000 });
  #extendTimer = undefined; // Stream extend timer
  #stalledTimer = undefined; // Interval object for no received data checks
  #lastPacketAt = undefined; // Last playback packet receipt time in ms
  #closeInProgress = false; // True while close() teardown is running to avoid re-entrant shutdown races
  #connectToken = 0; // Monotonic token to invalidate stale async connect/close paths
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

    // Store data we need from the device data passed it
    this.token = deviceData?.apiAccess?.oauth2;

    // Configure Google Home Foyer protobuf/gRPC client.
    this.#grpcTransport = new GrpcTransport({
      log: this.log,
      protoPath: path.resolve(__dirname + '/protobuf/googlehome/foyer.proto'),
      endpointHost:
        deviceData?.apiAccess?.fieldTest === true
          ? 'https://preprod-googlehomefoyer-pa.sandbox.googleapis.com'
          : 'https://googlehomefoyer-pa.googleapis.com',
      uuid: this.nest_google_device_uuid,
      userAgent: USER_AGENT,
      requestTimeout: GOOGLE_HOME_FOYER_REQUEST_TIMEOUT,
      bufferInitial: GOOGLE_HOME_FOYER_BUFFER_INITIAL,
      bufferMax: GOOGLE_HOME_FOYER_BUFFER_MAX,
      getAuthHeader: () => (typeof this.token === 'string' && this.token.trim() !== '' ? 'Bearer ' + this.token : ''),
    });

    // Start resolving the Google Home Foyer device UUID in the background so the
    // first live stream does not always pay the full HomeGraph lookup cost.
    this.#googleHomeDeviceUUIDPromise = this.#grpcTransport
      .command(
        GOOGLE_HOME_FOYER_PREFIX,
        'StructuresService',
        'GetHomeGraph',
        {
          requestId: crypto.randomUUID(),
        },
        {
          retry: 2,
        },
      )
      .then((homeFoyerResponse) => {
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

        return this.#googleHomeDeviceUUID;
      })
      .catch((error) => {
        this.log?.warn?.(
          'Unable to resolve Google Home device ID for "%s" (%s). Stream video/recording will be unavailable: %s',
          this.deviceData.description,
          this.nest_google_device_uuid,
          String(error),
        );
        return undefined;
      })
      .finally(() => {
        this.#googleHomeDeviceUUIDPromise = undefined;
      });
  }

  // Class functions
  // eslint-disable-next-line no-unused-vars
  async connect(options = {}) {
    let connectToken = ++this.#connectToken;

    if (connectToken !== this.#connectToken) {
      return;
    }

    // Reset any previous session timers/state before attempting a new connection.
    // This ensures a reconnect starts from a clean baseline rather than reusing
    // timers or partially assembled media from an earlier session.
    clearInterval(this.#extendTimer);
    clearInterval(this.#stalledTimer);
    this.#extendTimer = undefined;
    this.#stalledTimer = undefined;
    this.#lastPacketAt = undefined;
    this.#streamId = undefined;
    this.#reconnectPending = false;
    this.#reconnectReason = undefined;
    this.#tracks = { audio: {}, video: {}, talkback: {} };

    if (this.online !== true || this.videoEnabled !== true) {
      return;
    }

    if (connectToken !== this.#connectToken) {
      return;
    }

    if (typeof this.#googleHomeDeviceUUID !== 'string' && this.#googleHomeDeviceUUIDPromise instanceof Promise) {
      await this.#googleHomeDeviceUUIDPromise;

      if (connectToken !== this.#connectToken) {
        return;
      }
    }

    if (typeof this.#googleHomeDeviceUUID !== 'string' || this.#googleHomeDeviceUUID === '') {
      this.log.debug('Google Home device UUID not resolved for uuid "%s"', this.nest_google_device_uuid);
      this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_CLOSED, 'google-device-id-missing');
      return;
    }

    if (this.#googleHomeDeviceUUID === undefined) {
      this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_CLOSED, 'google-device-id-missing');
      return;
    }

    // Tell the Streamer base that we are beginning source setup.
    // This is transport/control readiness only and does not mean media is flowing yet.
    this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_CONNECTING);

    let homeFoyerResponse = await this.#grpcTransport.command(GOOGLE_HOME_FOYER_PREFIX, 'CameraService', 'SendCameraViewIntent', {
      request: {
        googleDeviceId: {
          value: this.#googleHomeDeviceUUID,
        },
        command: 'VIEW_INTENT_START',
      },
    });

    if (connectToken !== this.#connectToken) {
      return;
    }

    if (homeFoyerResponse?.status !== 0) {
      this?.log?.debug?.('Request to start camera viewing was not accepted for uuid "%s"', this.nest_google_device_uuid);
      this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_CLOSED, 'view-intent-failed');
      return;
    }

    // Create our local WebRTC peer connection and advertise the codecs we support.
    // We receive H264 video and Opus audio from the camera, then convert that into
    // Streamer media items for live view and recording.
    let peerConnection = new werift.RTCPeerConnection({
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

    this.#peerConnection = peerConnection;

    peerConnection.createDataChannel('webrtc-datachannel');

    this.#audioTransceiver = peerConnection.addTransceiver('audio', {
      direction: 'sendrecv',
    });

    this.#videoTransceiver = peerConnection.addTransceiver('video', {
      direction: 'recvonly',
    });

    // Create our SDP offer and send it to Google Home Foyer.
    // If accepted, we will get an SDP answer back plus a streamId for later extend/end/talkback calls.
    let webRTCOffer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(webRTCOffer);

    homeFoyerResponse = await this.#grpcTransport.command(GOOGLE_HOME_FOYER_PREFIX, 'CameraService', 'JoinStream', {
      command: 'offer',
      deviceId: this.nest_google_device_uuid,
      local: false, // Request direct peer-to-peer connection if possible
      streamContext: 'STREAM_CONTEXT_DEFAULT',
      requestedVideoResolution: 'VIDEO_RESOLUTION_STANDARD',
      sdp: webRTCOffer.sdp,
    });

    if (connectToken !== this.#connectToken) {
      try {
        await peerConnection?.close?.();
      } catch {
        // Empty
      }
      return;
    }

    if (
      homeFoyerResponse?.status !== 0 ||
      homeFoyerResponse?.data?.[0]?.responseType !== 'answer' ||
      homeFoyerResponse?.data?.[0]?.streamId === undefined ||
      homeFoyerResponse?.data?.[0]?.sdp === undefined
    ) {
      peerConnection?.close?.();
      this.#peerConnection = undefined;
      this?.log?.debug?.(
        'WebRTC offer was not agreed with remote for uuid "%s". Response: %j',
        this.nest_google_device_uuid,
        homeFoyerResponse,
      );
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
      this.#handlePlaybackBegin(Streamer.MEDIA_TYPE.AUDIO);

      track.onReceiveRtp.subscribe((rtpPacket) => {
        if (track.codec.payloadType !== RTP_OPUS_AUDIO_PAYLOAD_TYPE) {
          // Not the payload type we expect for audio, so ignore
          return;
        }

        this.#handlePlaybackAudioPacket(rtpPacket);
      });
    });

    this.#videoTransceiver?.onTrack?.subscribe?.((track) => {
      this.#handlePlaybackBegin(Streamer.MEDIA_TYPE.VIDEO);

      track.onReceiveRtp.subscribe((rtpPacket) => {
        if (track.codec.payloadType !== RTP_H264_VIDEO_PAYLOAD_TYPE && track.codec.payloadType !== RTP_H264_VIDEO_RTX_PAYLOAD_TYPE) {
          // Not the payload types we expect for video, so ignore
          return;
        }

        this.#handlePlaybackVideoPacket(rtpPacket);
      });
    });

    this.#streamId = homeFoyerResponse.data[0].streamId;

    // connect() can overlap with close() during fast stream stop/reopen cycles.
    // If teardown replaced or cleared the active peer connection while this async
    // setup was in-flight, abort this stale connect attempt safely.
    if (this.#peerConnection !== peerConnection) {
      try {
        await peerConnection?.close?.();
      } catch {
        // Empty
      }
      return;
    }

    await peerConnection?.setRemoteDescription?.({
      type: 'answer',
      sdp: homeFoyerResponse.data[0].sdp,
    });

    this?.log?.debug?.('Playback started from WebRTC for uuid "%s" with stream ID "%s"', this.nest_google_device_uuid, this.#streamId);

    // Monitor connection status. ICE "connected" means transport is ready,
    // not that media has actually started. Actual source readiness is promoted
    // later on first video packet arrival.
    peerConnection.iceConnectionStateChange.subscribe(() => {
      if (this.#peerConnection !== peerConnection) {
        return;
      }

      if (this.#closeInProgress === true) {
        return;
      }

      let state = peerConnection?.iceConnectionState;

      if (state === 'connected' || state === 'completed' || state === 'checking') {
        if (this.sourceState !== Streamer.MESSAGE_TYPE.SOURCE_CONNECTED) {
          this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_CONNECTED);
        }
        return;
      }

      if (
        (state === 'failed' || state === 'disconnected' || (state === 'closed' && this.hasActiveStreams() === true)) &&
        this.sourceState !== Streamer.MESSAGE_TYPE.SOURCE_CLOSING &&
        this.sourceState !== Streamer.MESSAGE_TYPE.SOURCE_CLOSED
      ) {
        this?.log?.debug?.('WebRTC ICE state "%s" for uuid "%s", requesting reconnect', state, this.nest_google_device_uuid);
        this.#requestReconnect('ice-' + state);

        if (this.hasActiveStreams() === true) {
          this.requestSourceClose();
        }
      }
    });

    // Periodically extend the active stream only when we do not have local access.
    // Local streams are expected to remain valid without needing explicit extend requests.
    if (localAccessGranted !== true) {
      this.#extendTimer = setInterval(async () => {
        if (
          this.#grpcTransport !== undefined &&
          this.sourceState === Streamer.MESSAGE_TYPE.SOURCE_READY &&
          this.#streamId !== undefined &&
          this.#googleHomeDeviceUUID !== undefined
        ) {
          let extendResponse = await this.#grpcTransport.command(GOOGLE_HOME_FOYER_PREFIX, 'CameraService', 'JoinStream', {
            command: 'extend',
            deviceId: this.nest_google_device_uuid,
            streamId: this.#streamId,
          });

          if (extendResponse?.data?.[0]?.streamExtensionStatus !== 'STATUS_STREAM_EXTENDED') {
            this?.log?.debug?.('Error occurred while requesting stream extension for uuid "%s"', this.nest_google_device_uuid);
            this.#requestReconnect('extend-failed');
            this.requestSourceClose();
          }
        }
      }, EXTEND_INTERVAL);
    }
  }

  async close() {
    let closeToken = this.#connectToken;
    let closingPeerConnection = this.#peerConnection;
    let closingStreamId = this.#streamId;
    let reconnectReason = this.#reconnectReason;
    let talkbackActive = this.#tracks?.talkback?.active === true;

    // Mark source as closing immediately so any in-flight playback callbacks
    // stop accepting new packets while teardown is happening.
    this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_CLOSING);

    // Stop timers first so we stop producing any new work immediately.
    clearInterval(this.#extendTimer);
    clearInterval(this.#stalledTimer);
    this.#extendTimer = undefined;
    this.#stalledTimer = undefined;
    this.#lastPacketAt = undefined;

    // Flush any pending video access unit before tearing state down.
    // Video is emitted frame-by-frame, so the last completed frame would otherwise
    // be lost if close occurs before another packet triggers a normal flush.
    this.#flushPendingVideoFrame();

    // Clear transceiver/local track state before closing remote transport.
    // This lets any in-flight callbacks naturally no-op while shutdown continues.
    this.#videoTransceiver = undefined;
    this.#audioTransceiver = undefined;
    this.#tracks = { audio: {}, video: {}, talkback: {} };

    if (closingStreamId !== undefined && talkbackActive === true) {
      await this.#grpcTransport.command(GOOGLE_HOME_FOYER_PREFIX, 'CameraService', 'SendTalkback', {
        googleDeviceId: {
          value: this.#googleHomeDeviceUUID,
        },
        streamId: closingStreamId,
        command: 'COMMAND_STOP',
      });
    }

    if (closingStreamId !== undefined) {
      this?.log?.debug?.('Notifying remote about closing connection for uuid "%s"', this.nest_google_device_uuid);

      // Tell remote to end the stream session
      await this.#grpcTransport.command(GOOGLE_HOME_FOYER_PREFIX, 'CameraService', 'JoinStream', {
        command: 'end',
        deviceId: this.nest_google_device_uuid,
        streamId: closingStreamId,
        endStreamReason: 'REASON_USER_EXITED_SESSION',
      });
    }

    try {
      await closingPeerConnection?.close?.();
    } catch {
      // Empty
    }

    // NOTE: Do NOT release the gRPC client here. It should be reused across WebRTC reconnects
    // and only released during final shutdown in onShutdown(). Releasing it during
    // temporary disconnects causes in-flight requests to be canceled with "pending stream has been canceled".
    if (this.#streamId === closingStreamId) {
      this.#streamId = undefined;
    }

    if (this.#peerConnection === closingPeerConnection) {
      this.#peerConnection = undefined;
    }

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
        this.requestSourceConnect().catch((error) => {
          this?.log?.debug?.('Error reconnecting WebRTC for uuid "%s": %s', this.nest_google_device_uuid, String(error));
        });
        return;
      }
    }

    if (
      closeToken === this.#connectToken &&
      this.hasActiveStreams() !== true &&
      this.sourceState === Streamer.MESSAGE_TYPE.SOURCE_CLOSING
    ) {
      this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_CLOSED);
    }
  }

  async close() {
    if (this.#closeInProgress === true) {
      return;
    }

    this.#closeInProgress = true;
    let closeToken = this.#connectToken;
    let closingPeerConnection = this.#peerConnection;
    let closingStreamId = this.#streamId;
    let reconnectReason = this.#reconnectReason;
    let talkbackActive = this.#tracks?.talkback?.active === true;

    try {
      // Mark source as closing immediately so any in-flight playback callbacks
      // stop accepting new packets while teardown is happening.
      this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_CLOSING);

      // Stop timers first so we stop producing any new work immediately.
      clearInterval(this.#extendTimer);
      clearInterval(this.#stalledTimer);
      this.#extendTimer = undefined;
      this.#stalledTimer = undefined;
      this.#lastPacketAt = undefined;

      // Flush any pending video access unit before tearing state down.
      // Video is emitted frame-by-frame, so the last completed frame would otherwise
      // be lost if close occurs before another packet triggers a normal flush.
      this.#flushPendingVideoFrame();

      // Clear transceiver/local track state before closing remote transport.
      // This lets any in-flight callbacks naturally no-op while shutdown continues.
      this.#videoTransceiver = undefined;
      this.#audioTransceiver = undefined;
      this.#tracks = { audio: {}, video: {}, talkback: {} };

      if (closingStreamId !== undefined && talkbackActive === true) {
        await this.#grpcTransport.command(GOOGLE_HOME_FOYER_PREFIX, 'CameraService', 'SendTalkback', {
          googleDeviceId: {
            value: this.#googleHomeDeviceUUID,
          },
          streamId: closingStreamId,
          command: 'COMMAND_STOP',
        });
      }

      if (closingStreamId !== undefined) {
        this?.log?.debug?.('Notifying remote about closing connection for uuid "%s"', this.nest_google_device_uuid);

        // Tell remote to end the stream session
        await this.#grpcTransport.command(GOOGLE_HOME_FOYER_PREFIX, 'CameraService', 'JoinStream', {
          command: 'end',
          deviceId: this.nest_google_device_uuid,
          streamId: closingStreamId,
          endStreamReason: 'REASON_USER_EXITED_SESSION',
        });
      }

      try {
        await closingPeerConnection?.close?.();
      } catch {
        // Empty
      }

      // NOTE: Do NOT release the gRPC client here. It should be reused across WebRTC reconnects
      // and only released during final shutdown in onShutdown(). Releasing it during
      // temporary disconnects causes in-flight requests to be canceled with "pending stream has been canceled".
      if (this.#streamId === closingStreamId) {
        this.#streamId = undefined;
      }

      if (this.#peerConnection === closingPeerConnection) {
        this.#peerConnection = undefined;
      }

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
          this.requestSourceConnect().catch((error) => {
            this?.log?.debug?.('Error reconnecting WebRTC for uuid "%s": %s', this.nest_google_device_uuid, String(error));
          });
          return;
        }
      }

      if (
        closeToken === this.#connectToken &&
        this.hasActiveStreams() !== true &&
        this.sourceState === Streamer.MESSAGE_TYPE.SOURCE_CLOSING
      ) {
        this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_CLOSED);
      }
    } finally {
      this.#closeInProgress = false;
    }
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
    await this.requestSourceClose(); // Gracefully close peer connection

    // Release the gRPC client only during final shutdown, not on temporary disconnects
    try {
      this.#grpcTransport?.release?.();
    } catch {
      // Empty
    }
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

        let homeFoyerResponse = await this.#grpcTransport.command(GOOGLE_HOME_FOYER_PREFIX, 'CameraService', 'SendTalkback', {
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

      let homeFoyerResponse = await this.#grpcTransport.command(GOOGLE_HOME_FOYER_PREFIX, 'CameraService', 'SendTalkback', {
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

  #handlePlaybackBegin(mediaType) {
    let video = undefined;
    let audio = undefined;

    if (this.sourceState === Streamer.MESSAGE_TYPE.SOURCE_CLOSING || this.sourceState === Streamer.MESSAGE_TYPE.SOURCE_CLOSED) {
      return;
    }

    if (typeof this.#tracks !== 'object' || this.#tracks === null) {
      this.#tracks = {};
    }

    if (mediaType === Streamer.MEDIA_TYPE.VIDEO) {
      if (typeof this.#tracks.video !== 'object' || this.#tracks.video === null) {
        this.#tracks.video = {};
      }

      video = this.#tracks.video;

      if (typeof video.id !== 'number') {
        video.id = RTP_H264_VIDEO_PAYLOAD_TYPE;
      }

      if (typeof video.rtxId !== 'number') {
        video.rtxId = RTP_H264_VIDEO_RTX_PAYLOAD_TYPE;
      }

      if (typeof video.rtxSsrc !== 'number') {
        video.rtxSsrc = undefined;
      }

      if (typeof video.codec !== 'string') {
        video.codec = Streamer.CODEC_TYPE.H264;
      }

      if (typeof video.sampleRate !== 'number') {
        video.sampleRate = 90000;
      }

      // RTP packet tracking for video timing/order checks
      if (typeof video.rtp !== 'object' || video.rtp === null) {
        video.rtp = {
          lastSequence: undefined,
          lastTimestamp: undefined,
          lastCalculatedTimestamp: undefined,
          lastEmittedTimestamp: undefined,
        };
      }

      // H264 frame assembly and cached parameter sets
      if (typeof video.h264 !== 'object' || video.h264 === null) {
        video.h264 = {
          fuParts: [],
          fuBytes: 0,
          fuNalType: 0,
          fuRtpTimestamp: undefined,
          fuFirstPacketTime: undefined,
          lastSPS: undefined,
          lastPPS: undefined,
          lastIDR: undefined,
          lastSpsEmitTime: undefined,
          pendingParts: [],
          pendingRtpTimestamp: undefined,
          pendingFirstPacketTime: undefined,
          pendingKeyFrame: false,
          pendingBytes: 0,
          pendingHasVcl: false,
          pendingMarkerSeen: false,
          pendingCorrupt: false,
        };
      }

      // Output timestamp tracking used when handing frames to Streamer
      if (typeof video.output !== 'object' || video.output === null) {
        video.output = {
          lastTimestamp: undefined,
        };
      }

      if (typeof video.lastPLITime === 'undefined') {
        video.lastPLITime = undefined;
      }

      if (typeof video.lastNACKTime === 'undefined') {
        video.lastNACKTime = undefined;
      }

      if (typeof video.lastIDRTime === 'undefined') {
        video.lastIDRTime = undefined;
      }

      if (typeof video.health !== 'object' || video.health === null) {
        video.health = {
          state: 'STABLE',
          events: [],
          cleanScore: 0,
          lastCleanKeyframeTime: undefined,
          suppressDeltas: false,
          lastSuppressedLogTime: undefined,
        };
      }

      if (typeof video.deltaAudit !== 'object' || video.deltaAudit === null) {
        video.deltaAudit = {
          hasAcceptedKeyframe: false,
          lastAcceptedKeyframeTime: undefined,
          deltaEmittedSinceKeyframe: 0,
          deltaFuStartsSinceKeyframe: 0,
          deltaFuCompletesSinceKeyframe: 0,
          deltaFuGraceDefers: 0,
          deltaFuAbandonedTsSwitch: 0,
          deltaPendingAbandonedTsSwitch: 0,
          deltaEarlyAbandon: 0,
          auditLegendLogged: false,
        };
      }

      // Ask once for a startup keyframe, then let the source continue naturally.
      this.#sendVideoPLI('startup');

      this.#refreshStallTimer();
      return;
    }

    if (mediaType === Streamer.MEDIA_TYPE.AUDIO) {
      if (typeof this.#tracks.audio !== 'object' || this.#tracks.audio === null) {
        this.#tracks.audio = {};
      }

      audio = this.#tracks.audio;

      if (typeof audio.id !== 'number') {
        audio.id = RTP_OPUS_AUDIO_PAYLOAD_TYPE;
      }

      if (typeof audio.codec !== 'string') {
        audio.codec = Streamer.CODEC_TYPE.OPUS;
      }

      if (typeof audio.sampleRate !== 'number') {
        audio.sampleRate = 48000;
      }

      if (typeof audio.channels !== 'number') {
        audio.channels = 2;
      }

      if (typeof audio.packetTime !== 'number') {
        audio.packetTime = 20;
      }

      // RTP packet tracking for audio timing/order checks
      if (typeof audio.rtp !== 'object' || audio.rtp === null) {
        audio.rtp = {
          lastSequence: undefined,
          lastTimestamp: undefined,
        };
      }

      // Output timestamp tracking used when handing PCM frames to Streamer
      if (typeof audio.output !== 'object' || audio.output === null) {
        audio.output = {
          lastTimestamp: undefined,
        };
      }

      if (typeof audio.lastTimingClampLogTime !== 'number') {
        audio.lastTimingClampLogTime = undefined;
      }

      if (typeof audio.lastDecodeFallbackLogTime !== 'number') {
        audio.lastDecodeFallbackLogTime = undefined;
      }

      this.#refreshStallTimer();
    }
  }

  #handlePlaybackVideoPacket(rtpPacket) {
    if (this.sourceState === Streamer.MESSAGE_TYPE.SOURCE_CLOSING || this.sourceState === Streamer.MESSAGE_TYPE.SOURCE_CLOSED) {
      // We are closing or closed, so ignore any incoming packets. This can happen when remote is still sending
      // before we finish tearing down the connection, but we do not want to process any new packets at this point.
      return;
    }

    let fuHeader = 0;
    let fuStart = false;
    let fuEnd = false;
    let fuNalType = 0;
    let fuNalHeader = 0;
    let fragment = undefined;
    let part = undefined;
    let stapOffset = 0;
    let stapLength = 0;
    let stapNal = undefined;
    let stapNalType = 0;
    let seqDelta = 0;
    let rtxOriginalSequence = 0;
    let isRtxPacket = false;
    let acceptAsRecoveredRtx = false;
    let pendingAgeMs = undefined;
    let fuAgeMs = undefined;
    let pendingTsDeltaTicks = 0;
    let pendingTsWrapCandidate = false;
    let fuTsDeltaTicks = 0;
    let fuTsWrapCandidate = false;
    let incomingNalType = 0;
    let incomingFuHeader = 0;
    let incomingFuStart = false;
    let incomingFuNalType = 0;
    let incomingIsIdrFuStart = false;
    let pendingPartCount = 0;
    let pendingByteCount = 0;
    let pendingHasContent = false;

    // Ensure we have a valid RTP packet with a payload before processing video data
    if (
      typeof rtpPacket !== 'object' ||
      rtpPacket === null ||
      typeof rtpPacket?.header !== 'object' ||
      rtpPacket.header === null ||
      Buffer.isBuffer(rtpPacket?.payload) !== true ||
      rtpPacket.payload.length === 0
    ) {
      return;
    }

    // Pull out the RTP header details we use repeatedly below
    let header = rtpPacket.header;
    let payload = rtpPacket.payload;
    let marker = header.marker === true;
    let sequenceNumber = Number.isInteger(header.sequenceNumber) === true ? header.sequenceNumber : 0;
    let rtpTimestamp = Number.isInteger(header.timestamp) === true ? header.timestamp >>> 0 : 0;
    let payloadType = Number.isInteger(header.payloadType) === true ? header.payloadType : undefined;
    let ssrc = Number.isInteger(header.ssrc) === true ? header.ssrc >>> 0 : undefined;

    // Ensure playback state exists even if packets arrive before track open handling finishes
    if (
      typeof this.#tracks?.video !== 'object' ||
      this.#tracks.video === null ||
      typeof this.#tracks.video?.h264 !== 'object' ||
      this.#tracks.video.h264 === null ||
      typeof this.#tracks.video?.rtp !== 'object' ||
      this.#tracks.video.rtp === null ||
      typeof this.#tracks.video?.output !== 'object' ||
      this.#tracks.video.output === null
    ) {
      this.#handlePlaybackBegin(Streamer.MEDIA_TYPE.VIDEO);
    }

    let video = this.#tracks.video;
    let h264 = video.h264;
    let videoRtp = video.rtp;
    let deltaAudit = video.deltaAudit;
    isRtxPacket = typeof payloadType === 'number' && payloadType === video.rtxId;

    if (typeof deltaAudit !== 'object' || deltaAudit === null) {
      deltaAudit = {
        hasAcceptedKeyframe: false,
        lastAcceptedKeyframeTime: undefined,
        deltaEmittedSinceKeyframe: 0,
        deltaFuStartsSinceKeyframe: 0,
        deltaFuCompletesSinceKeyframe: 0,
        deltaFuGraceDefers: 0,
        deltaFuAbandonedTsSwitch: 0,
        deltaPendingAbandonedTsSwitch: 0,
        deltaEarlyAbandon: 0,
        auditLegendLogged: false,
      };
      video.deltaAudit = deltaAudit;
    }

    // Track primary video SSRC separately from RTX SSRC. Google can send retransmissions
    // on a distinct SSRC, and we do not want that to disturb primary stream locking.
    if (isRtxPacket !== true) {
      if (typeof video.ssrc !== 'number' && typeof ssrc === 'number') {
        video.ssrc = ssrc;
      }

      if (typeof video.ssrc === 'number' && typeof ssrc === 'number' && ssrc !== video.ssrc) {
        return;
      }
    }

    // Rebuild original H264 payload from RFC4588 RTX packets.
    // RTX payload starts with 2-byte original sequence number followed by original RTP payload.
    if (isRtxPacket === true) {
      if (typeof video.rtxSsrc !== 'number' && typeof ssrc === 'number') {
        video.rtxSsrc = ssrc;
      }

      if (typeof video.rtxSsrc === 'number' && typeof ssrc === 'number' && ssrc !== video.rtxSsrc) {
        return;
      }

      if (Buffer.isBuffer(payload) !== true || payload.length < 3) {
        return;
      }

      // We need the primary SSRC lock before reinjecting RTX into normal ordering logic.
      if (typeof video.ssrc !== 'number') {
        return;
      }

      rtxOriginalSequence = payload.readUInt16BE(0);
      payload = payload.subarray(2);
      sequenceNumber = rtxOriginalSequence;
      payloadType = video.id;
      ssrc = video.ssrc;
      acceptAsRecoveredRtx = true;
    }

    if (typeof payloadType === 'number' && payloadType !== video.id) {
      return;
    }

    // Drop duplicate or clearly late/out-of-order packets before they touch assembly state.
    // This mirrors the protection already used on audio and avoids duplicate fragments or
    // old retransmits corrupting pending H264 access units.
    if (acceptAsRecoveredRtx !== true) {
      if (typeof videoRtp.lastSequence === 'number') {
        seqDelta = (sequenceNumber - videoRtp.lastSequence + RTP_SEQUENCE_WRAP) % RTP_SEQUENCE_WRAP;

        if (seqDelta === 0 || seqDelta > RTP_SEQUENCE_WRAP / 2) {
          return;
        }
      }

      videoRtp.lastSequence = sequenceNumber;
    }

    // Any valid incoming video RTP packet means the playback path is still alive
    this.#refreshStallTimer();

    // Normalise pending frame state so packets for the same RTP timestamp can be grouped together
    if (Array.isArray(h264.pendingParts) !== true) {
      h264.pendingParts = [];
    }

    if (typeof h264.pendingBytes !== 'number') {
      h264.pendingBytes = 0;
    }

    if (typeof h264.pendingHasVcl !== 'boolean') {
      h264.pendingHasVcl = false;
    }

    if (typeof h264.pendingMarkerSeen !== 'boolean') {
      h264.pendingMarkerSeen = false;
    }

    if (typeof h264.pendingCorrupt !== 'boolean') {
      h264.pendingCorrupt = false;
    }

    if (typeof h264.pendingKeyFrame !== 'boolean') {
      h264.pendingKeyFrame = false;
    }

    if (typeof h264.pendingFirstPacketTime !== 'number') {
      h264.pendingFirstPacketTime = undefined;
    }

    // Normalise FU-A assembly state used for fragmented H264 NAL units
    if (Array.isArray(h264.fuParts) !== true) {
      h264.fuParts = [];
    }

    if (typeof h264.fuBytes !== 'number') {
      h264.fuBytes = 0;
    }

    if (typeof h264.fuNalType !== 'number') {
      h264.fuNalType = 0;
    }

    if (typeof h264.fuRtpTimestamp !== 'number') {
      h264.fuRtpTimestamp = undefined;
    }

    if (typeof h264.fuFirstPacketTime !== 'number') {
      h264.fuFirstPacketTime = undefined;
    }

    // Peek at incoming packet type so keyframe FU-A starts can preempt delta grace.
    incomingNalType = payload[0] & 0x1f;

    if (incomingNalType === Streamer.H264NALUS.TYPES.FU_A && payload.length >= 2) {
      incomingFuHeader = payload[1];
      incomingFuStart = (incomingFuHeader & 0x80) === 0x80;
      incomingFuNalType = incomingFuHeader & 0x1f;
      incomingIsIdrFuStart = incomingFuStart === true && incomingFuNalType === Streamer.H264NALUS.TYPES.IDR;
    }

    // Tiny grace for young non-keyframe FU-A units:
    // ignore a newer timestamp briefly so we do not abandon a nearly-finished delta FU
    // due to slight packet reordering/timing skew.
    if (
      typeof h264.fuRtpTimestamp === 'number' &&
      h264.fuRtpTimestamp !== rtpTimestamp &&
      h264.fuNalType === Streamer.H264NALUS.TYPES.SLICE_NON_IDR
    ) {
      fuAgeMs = typeof h264.fuFirstPacketTime === 'number' ? Date.now() - h264.fuFirstPacketTime : undefined;

      if (Number.isFinite(fuAgeMs) === true && fuAgeMs <= DELTA_FU_SWITCH_GRACE_MS) {
        if (incomingIsIdrFuStart !== true) {
          deltaAudit.deltaFuGraceDefers++;

          return;
        }
      }
    }

    // If a new RTP timestamp arrives while a previous pending frame is still open, flush it if complete
    // Otherwise drop it as incomplete and start building the new frame instead
    if (acceptAsRecoveredRtx === true && typeof h264.pendingRtpTimestamp === 'number' && h264.pendingRtpTimestamp !== rtpTimestamp) {
      // Recovered RTX for an already-closed or superseded access unit is not useful here.
      // Drop it rather than disturbing current frame assembly state.
      return;
    }

    if (typeof h264.pendingRtpTimestamp === 'number' && h264.pendingRtpTimestamp !== rtpTimestamp) {
      pendingTsDeltaTicks = (rtpTimestamp - h264.pendingRtpTimestamp + RTP_TIMESTAMP_MASK) % RTP_TIMESTAMP_MASK;
      pendingTsWrapCandidate = h264.pendingRtpTimestamp > rtpTimestamp && pendingTsDeltaTicks < video.sampleRate * 2;
      pendingPartCount = Array.isArray(h264.pendingParts) === true ? h264.pendingParts.length : 0;
      pendingByteCount = Number.isFinite(h264.pendingBytes) === true ? h264.pendingBytes : 0;
      pendingHasContent = pendingPartCount > 0 || pendingByteCount > 0;

      if (pendingHasContent !== true) {
        // Timestamp changed with no buffered access-unit payload: reset silently.
        this.#resetPendingVideoFrame();
      } else if (Array.isArray(h264.pendingParts) === true && h264.pendingParts.length > 0 && h264.pendingMarkerSeen === true) {
        this.#flushPendingVideoFrame();
      } else {
        pendingAgeMs = typeof h264.pendingFirstPacketTime === 'number' ? Date.now() - h264.pendingFirstPacketTime : undefined;

        if (h264.pendingKeyFrame !== true) {
          deltaAudit.deltaPendingAbandonedTsSwitch++;

          if (Number.isFinite(pendingAgeMs) === true && pendingAgeMs <= 80) {
            deltaAudit.deltaEarlyAbandon++;
          }
        }

        this?.log?.debug?.(
          'Drop incomplete pending video uuid "%s": oldTs=%s newTs=%s deltaTicks=%s wrapCandidate=%s parts=%s bytes=%s ageMs=%s marker=%s',
          this.nest_google_device_uuid,
          h264.pendingRtpTimestamp,
          rtpTimestamp,
          pendingTsDeltaTicks,
          pendingTsWrapCandidate === true ? 'true' : 'false',
          pendingPartCount,
          pendingByteCount,
          pendingAgeMs,
          h264.pendingMarkerSeen === true ? 'true' : 'false',
        );

        if (h264.pendingKeyFrame === true || (Number.isFinite(pendingAgeMs) === true && pendingAgeMs >= 300)) {
          this.#sendVideoPLI('pending-incomplete');
          this.#recordVideoHealthEvent('pending-incomplete');
        }

        this.#resetPendingVideoFrame();
      }
    }

    // If a fragmented FU-A frame is still in progress but a new RTP timestamp arrives, drop the old fragment set
    if (typeof h264.fuRtpTimestamp === 'number' && h264.fuRtpTimestamp !== rtpTimestamp) {
      fuTsDeltaTicks = (rtpTimestamp - h264.fuRtpTimestamp + RTP_TIMESTAMP_MASK) % RTP_TIMESTAMP_MASK;
      fuTsWrapCandidate = h264.fuRtpTimestamp > rtpTimestamp && fuTsDeltaTicks < video.sampleRate * 2;
      fuAgeMs = typeof h264.fuFirstPacketTime === 'number' ? Date.now() - h264.fuFirstPacketTime : undefined;

      if (h264.fuNalType === Streamer.H264NALUS.TYPES.SLICE_NON_IDR) {
        deltaAudit.deltaFuAbandonedTsSwitch++;

        if (Number.isFinite(fuAgeMs) === true && fuAgeMs <= 80) {
          deltaAudit.deltaEarlyAbandon++;
        }
      }

      this?.log?.debug?.(
        'Drop incomplete FU-A uuid "%s": oldTs=%s newTs=%s deltaTicks=%s wrapCandidate=%s nalType=%s parts=%s bytes=%s ageMs=%s',
        this.nest_google_device_uuid,
        h264.fuRtpTimestamp,
        rtpTimestamp,
        fuTsDeltaTicks,
        fuTsWrapCandidate === true ? 'true' : 'false',
        h264.fuNalType,
        Array.isArray(h264.fuParts) === true ? h264.fuParts.length : 0,
        Number.isFinite(h264.fuBytes) === true ? h264.fuBytes : 0,
        fuAgeMs,
      );

      if (h264.fuNalType === Streamer.H264NALUS.TYPES.IDR || (Number.isFinite(fuAgeMs) === true && fuAgeMs >= 300)) {
        this.#sendVideoPLI('fu-incomplete');
        this.#recordVideoHealthEvent('fu-incomplete');
      }

      this.#resetFragmentedVideoFrame();
    }

    // Initialise the pending frame timestamp from the first packet we see for this frame
    if (typeof h264.pendingRtpTimestamp !== 'number') {
      h264.pendingRtpTimestamp = rtpTimestamp;
      h264.pendingFirstPacketTime = Date.now();
    }

    let nalHeader = payload[0];
    let nalType = nalHeader & 0x1f;
    let nri = nalHeader & 0x60;

    // Single NAL units can be appended directly to the pending frame
    if (nalType > 0 && nalType < 24) {
      part = Buffer.allocUnsafe(Streamer.H264NALUS.START_CODE.length + payload.length);
      Streamer.H264NALUS.START_CODE.copy(part, 0);
      payload.copy(part, Streamer.H264NALUS.START_CODE.length);
      h264.pendingParts.push(part);
      h264.pendingBytes += part.length;

      if (nalType === Streamer.H264NALUS.TYPES.SPS) {
        h264.lastSPS = Buffer.from(payload);
      }

      if (nalType === Streamer.H264NALUS.TYPES.PPS) {
        h264.lastPPS = Buffer.from(payload);
      }

      if (nalType === Streamer.H264NALUS.TYPES.IDR) {
        h264.pendingKeyFrame = true;
        h264.pendingHasVcl = true;
        h264.lastIDR = Buffer.from(payload);
      }

      if (nalType === Streamer.H264NALUS.TYPES.SLICE_NON_IDR) {
        h264.pendingHasVcl = true;
      }

      // Marker means this RTP packet finishes the access unit, so flush the frame now
      if (marker === true) {
        h264.pendingMarkerSeen = true;
        this.#flushPendingVideoFrame();
      }

      return;
    }

    // STAP-A contains multiple complete NAL units in a single RTP packet
    if (nalType === Streamer.H264NALUS.TYPES.STAP_A) {
      stapOffset = 1;

      while (stapOffset + 2 <= payload.length) {
        stapLength = payload.readUInt16BE(stapOffset);
        stapOffset += 2;

        if (stapLength <= 0 || stapOffset + stapLength > payload.length) {
          h264.pendingCorrupt = true;
          break;
        }

        stapNal = payload.subarray(stapOffset, stapOffset + stapLength);
        stapOffset += stapLength;

        if (Buffer.isBuffer(stapNal) !== true || stapNal.length === 0) {
          continue;
        }

        part = Buffer.allocUnsafe(Streamer.H264NALUS.START_CODE.length + stapNal.length);
        Streamer.H264NALUS.START_CODE.copy(part, 0);
        stapNal.copy(part, Streamer.H264NALUS.START_CODE.length);
        h264.pendingParts.push(part);
        h264.pendingBytes += part.length;

        stapNalType = stapNal[0] & 0x1f;

        if (stapNalType === Streamer.H264NALUS.TYPES.SPS) {
          h264.lastSPS = Buffer.from(stapNal);
        }

        if (stapNalType === Streamer.H264NALUS.TYPES.PPS) {
          h264.lastPPS = Buffer.from(stapNal);
        }

        if (stapNalType === Streamer.H264NALUS.TYPES.IDR) {
          h264.pendingKeyFrame = true;
          h264.pendingHasVcl = true;
          h264.lastIDR = Buffer.from(stapNal);
        }

        if (stapNalType === Streamer.H264NALUS.TYPES.SLICE_NON_IDR) {
          h264.pendingHasVcl = true;
        }
      }

      // Marker means this packet completed the frame payload for this timestamp
      if (marker === true) {
        h264.pendingMarkerSeen = true;
        this.#flushPendingVideoFrame();
      }

      return;
    }

    // FU-A carries one large NAL unit split across multiple RTP packets
    if (nalType === Streamer.H264NALUS.TYPES.FU_A) {
      if (payload.length < 2) {
        h264.pendingCorrupt = true;
        return;
      }

      fuHeader = payload[1];
      fuStart = (fuHeader & 0x80) === 0x80;
      fuEnd = (fuHeader & 0x40) === 0x40;
      fuNalType = fuHeader & 0x1f;
      fuNalHeader = nri | fuNalType;
      fragment = payload.subarray(2);

      if (Buffer.isBuffer(fragment) !== true || fragment.length === 0) {
        h264.pendingCorrupt = true;
        return;
      }

      // Start a new fragmented NAL reconstruction on the first FU-A packet
      if (fuStart === true) {
        this.#resetFragmentedVideoFrame();
        h264.fuRtpTimestamp = rtpTimestamp;
        h264.fuNalType = fuNalType;
        h264.fuParts = [];
        h264.fuBytes = 0;
        h264.fuFirstPacketTime = Date.now();

        // Important:
        // for fragmented keyframes, the real frame arrival time starts with the FU-A start packet,
        // not when the FU-A end finally arrives and the completed NAL is appended to pendingParts.
        if (typeof h264.pendingRtpTimestamp !== 'number') {
          h264.pendingRtpTimestamp = rtpTimestamp;
        }

        if (typeof h264.pendingFirstPacketTime !== 'number') {
          h264.pendingFirstPacketTime = Date.now();
        }

        part = Buffer.allocUnsafe(Streamer.H264NALUS.START_CODE.length + 1 + fragment.length);
        Streamer.H264NALUS.START_CODE.copy(part, 0);
        part.writeUInt8(fuNalHeader, Streamer.H264NALUS.START_CODE.length);
        fragment.copy(part, Streamer.H264NALUS.START_CODE.length + 1);
        h264.fuParts.push(part);
        h264.fuBytes += part.length;

        if (fuNalType === Streamer.H264NALUS.TYPES.SLICE_NON_IDR) {
          deltaAudit.deltaFuStartsSinceKeyframe++;
        }
      } else {
        // Non-start FU-A packets must belong to an existing fragmented NAL for the same RTP timestamp
        if (
          typeof h264.fuRtpTimestamp !== 'number' ||
          h264.fuRtpTimestamp !== rtpTimestamp ||
          Array.isArray(h264.fuParts) !== true ||
          h264.fuParts.length === 0
        ) {
          this?.log?.debug?.(
            'Dropping orphaned WebRTC FU-A fragment for uuid "%s": seq="%s" ts="%s" nal="%s"',
            this.nest_google_device_uuid,
            sequenceNumber,
            rtpTimestamp,
            fuNalType,
          );

          this.#resetFragmentedVideoFrame();
          h264.pendingCorrupt = true;
          return;
        }

        h264.fuParts.push(fragment);
        h264.fuBytes += fragment.length;
      }

      // Once the FU-A end fragment arrives, move the rebuilt NAL into the pending frame
      if (fuEnd === true) {
        h264.pendingParts = h264.pendingParts.concat(h264.fuParts);
        h264.pendingBytes += h264.fuBytes;

        if (fuNalType === Streamer.H264NALUS.TYPES.IDR) {
          h264.pendingKeyFrame = true;
          h264.pendingHasVcl = true;
          h264.lastIDR = Buffer.concat(h264.fuParts);
        }

        if (fuNalType === Streamer.H264NALUS.TYPES.SLICE_NON_IDR) {
          h264.pendingHasVcl = true;
          deltaAudit.deltaFuCompletesSinceKeyframe++;
        }

        this.#resetFragmentedVideoFrame();

        // If this was also the last packet for the access unit, flush the completed frame
        if (marker === true) {
          h264.pendingMarkerSeen = true;
          this.#flushPendingVideoFrame();
        }
      }

      return;
    }

    // Log other H264 packetisation types for now so we can see if the source ever starts using them
    this?.log?.debug?.(
      'Ignoring unsupported WebRTC H264 packet for uuid "%s": seq="%s" ts="%s" nal="%s" marker="%s"',
      this.nest_google_device_uuid,
      sequenceNumber,
      rtpTimestamp,
      nalType,
      marker === true ? 'true' : 'false',
    );
  }

  #resetFragmentedVideoFrame() {
    let h264 = this.#tracks?.video?.h264;

    if (typeof h264 !== 'object' || h264 === null) {
      return;
    }

    h264.fuParts = []; // Fragment buffers
    h264.fuBytes = 0; // Total fragment size
    h264.fuNalType = 0; // NAL type being rebuilt
    h264.fuRtpTimestamp = undefined; // RTP timestamp for fragment
    h264.fuFirstPacketTime = undefined; // Wall-clock time first FU-A fragment was received
  }

  #resetPendingVideoFrame() {
    let h264 = this.#tracks?.video?.h264;

    if (typeof h264 !== 'object' || h264 === null) {
      return;
    }

    h264.pendingParts = []; // NAL units for frame
    h264.pendingRtpTimestamp = undefined; // RTP timestamp for frame
    h264.pendingFirstPacketTime = undefined; // Wall-clock arrival time for first packet in frame
    h264.pendingKeyFrame = false; // IDR present
    h264.pendingBytes = 0; // Total frame size
    h264.pendingHasVcl = false; // Has video slice
    h264.pendingMarkerSeen = false; // RTP marker seen
    h264.pendingCorrupt = false; // Marked invalid
  }

  #flushPendingVideoFrame() {
    let video = this.#tracks?.video;
    let deltaAudit = video?.deltaAudit;
    let h264 = video?.h264;
    let videoRtp = video?.rtp;
    let videoOutput = video?.output;
    let pendingParts = h264?.pendingParts;
    let pendingRtpTimestamp = h264?.pendingRtpTimestamp;
    let pendingFirstPacketTime = h264?.pendingFirstPacketTime;
    let pendingKeyFrame = h264?.pendingKeyFrame;
    let pendingTimestamp = undefined;
    let now = Date.now();
    let index = 0;
    let part = undefined;
    let data = undefined;
    let deltaTicks = 0;
    let deltaMs = 0;
    let totalLength = 0;
    let writeOffset = 0;
    let emitParts = [];
    let emitBytes = 0;
    let hasSPS = false;
    let hasPPS = false;
    let partOffset = 0;
    let partType = 0;
    let spsPart = undefined;
    let ppsPart = undefined;
    let maxVideoDeltaMs = TIMESTAMP_MAX_VIDEO_DELTA;
    let keyframeAssemblyMs = undefined;
    let recoveringDeltaProbe = false;

    if (
      typeof video !== 'object' ||
      video === null ||
      typeof h264 !== 'object' ||
      h264 === null ||
      typeof videoRtp !== 'object' ||
      videoRtp === null
    ) {
      return;
    }

    if (typeof deltaAudit !== 'object' || deltaAudit === null) {
      deltaAudit = {
        hasAcceptedKeyframe: false,
        lastAcceptedKeyframeTime: undefined,
        deltaEmittedSinceKeyframe: 0,
        deltaFuStartsSinceKeyframe: 0,
        deltaFuCompletesSinceKeyframe: 0,
        deltaFuGraceDefers: 0,
        deltaFuAbandonedTsSwitch: 0,
        deltaPendingAbandonedTsSwitch: 0,
        deltaEarlyAbandon: 0,
        auditLegendLogged: false,
      };
      video.deltaAudit = deltaAudit;
    }

    // Output timing state is kept separate from RTP timing so we can pace frames cleanly to Streamer
    if (typeof videoOutput !== 'object' || videoOutput === null) {
      video.output = {
        lastTimestamp: undefined,
      };
      videoOutput = video.output;
    }

    // Nothing queued for this frame, so just clear stale timestamp state if needed
    if (Array.isArray(pendingParts) !== true || pendingParts.length === 0) {
      if (typeof pendingRtpTimestamp === 'number') {
        this.#resetPendingVideoFrame();
      }

      return;
    }

    // Pending frame must always have an RTP timestamp
    if (typeof pendingRtpTimestamp !== 'number') {
      this.#resetPendingVideoFrame();
      return;
    }

    // Normalise pending frame bookkeeping in case any fields were not initialised yet
    if (typeof h264.pendingBytes !== 'number') {
      h264.pendingBytes = 0;
    }

    if (typeof h264.pendingHasVcl !== 'boolean') {
      h264.pendingHasVcl = false;
    }

    if (typeof h264.pendingMarkerSeen !== 'boolean') {
      h264.pendingMarkerSeen = false;
    }

    if (typeof h264.pendingCorrupt !== 'boolean') {
      h264.pendingCorrupt = false;
    }

    // Ignore access-unit fragments that never contained an actual video slice
    if (h264.pendingHasVcl !== true) {
      this.#resetPendingVideoFrame();
      return;
    }

    // Wait until marker bit says the full frame/access unit has arrived
    if (h264.pendingMarkerSeen !== true) {
      return;
    }

    // For keyframes, make sure SPS/PPS are present before the IDR if the source did not include them
    if (pendingKeyFrame === true) {
      index = 0;

      while (index < pendingParts.length) {
        part = pendingParts[index];

        if (Buffer.isBuffer(part) === true && part.length > 0) {
          partOffset = 0;

          if (part.indexOf(Streamer.H264NALUS.START_CODE) === 0) {
            partOffset = Streamer.H264NALUS.START_CODE.length;
          }

          if (part.length > partOffset) {
            partType = part[partOffset] & 0x1f;

            if (partType === Streamer.H264NALUS.TYPES.SPS) {
              hasSPS = true;
            }

            if (partType === Streamer.H264NALUS.TYPES.PPS) {
              hasPPS = true;
            }
          }
        }

        index++;
      }

      if (hasSPS !== true && Buffer.isBuffer(h264?.lastSPS) === true && h264.lastSPS.length > 0) {
        spsPart = Buffer.concat([Streamer.H264NALUS.START_CODE, h264.lastSPS]);
        emitParts.push(spsPart);
        emitBytes += spsPart.length;
      }

      if (hasPPS !== true && Buffer.isBuffer(h264?.lastPPS) === true && h264.lastPPS.length > 0) {
        ppsPart = Buffer.concat([Streamer.H264NALUS.START_CODE, h264.lastPPS]);
        emitParts.push(ppsPart);
        emitBytes += ppsPart.length;
      }
    }

    // Final frame is SPS/PPS injection (if any) plus the collected pending NAL units
    emitParts = emitParts.concat(pendingParts);
    emitBytes += h264.pendingBytes;

    // Avoid concatenation when only a single buffer needs to be emitted
    if (emitParts.length === 1 && Buffer.isBuffer(emitParts[0]) === true && emitParts[0].length > 0) {
      data = emitParts[0];
    }

    if (data === undefined) {
      totalLength = emitBytes;

      if (totalLength <= 0) {
        this.#resetPendingVideoFrame();
        return;
      }

      data = Buffer.allocUnsafe(totalLength);
      index = 0;

      while (index < emitParts.length) {
        part = emitParts[index];

        if (Buffer.isBuffer(part) === true && part.length > 0) {
          part.copy(data, writeOffset);
          writeOffset += part.length;
        }

        index++;
      }
    }

    // Final safety check before handing frame to Streamer
    if (Buffer.isBuffer(data) !== true || data.length === 0) {
      this.#resetPendingVideoFrame();
      return;
    }

    // Drop frames already marked corrupt during packet assembly
    if (h264.pendingCorrupt === true) {
      this?.log?.debug?.(
        'Dropping corrupt WebRTC video frame for uuid "%s": rtpTs="%s" bytes="%s"',
        this.nest_google_device_uuid,
        pendingRtpTimestamp,
        data.length,
      );

      if (pendingKeyFrame === true) {
        this.#sendVideoPLI('corrupt-keyframe');
        this.#recordVideoHealthEvent('corrupt-keyframe');
      }

      this.#resetPendingVideoFrame();
      return;
    }

    // While suppression is enabled, UNSTABLE drops deltas.
    // RECOVERING lets a delta attempt pass deeper checks, but does not clear
    // suppression until that delta is actually accepted for emission.
    if (pendingKeyFrame !== true && video?.health?.suppressDeltas === true) {
      if (video?.health?.state === 'UNSTABLE') {
        if (typeof video?.health?.lastSuppressedLogTime !== 'number' || Date.now() - video.health.lastSuppressedLogTime >= 1000) {
          video.health.lastSuppressedLogTime = Date.now();
          this?.log?.debug?.(
            'Suppressing WebRTC delta frame for uuid "%s" while stream health is "%s"',
            this.nest_google_device_uuid,
            video.health.state,
          );
        }

        this.#resetPendingVideoFrame();
        return;
      }

      if (video?.health?.state === 'RECOVERING') {
        recoveringDeltaProbe = true;
        this?.log?.debug?.('Probing WebRTC delta frame in RECOVERING for uuid "%s"', this.nest_google_device_uuid);
      }
    }

    // Do not emit delta frames until at least one IDR has been accepted
    if (pendingKeyFrame !== true && (Buffer.isBuffer(h264.lastIDR) !== true || h264.lastIDR.length === 0)) {
      this?.log?.debug?.(
        'Dropping pre-keyframe WebRTC video frame for uuid "%s": bytes="%s" rtpTs="%s"',
        this.nest_google_device_uuid,
        data.length,
        pendingRtpTimestamp,
      );

      this.#resetPendingVideoFrame();
      return;
    }

    // Keyframe shock absorber:
    // avoid emitting giant/slow IDRs that tend to land as visible jumps.
    if (pendingKeyFrame === true) {
      keyframeAssemblyMs = typeof pendingFirstPacketTime === 'number' ? now - pendingFirstPacketTime : undefined;

      if (
        (Number.isFinite(keyframeAssemblyMs) === true && keyframeAssemblyMs > KEYFRAME_MAX_ASSEMBLY_MS) ||
        data.length > KEYFRAME_MAX_BYTES
      ) {
        this?.log?.debug?.(
          'Dropping shock keyframe for uuid "%s": rtpTs=%s bytes=%s assemblyMs=%s (limits: bytes<=%s assemblyMs<=%s)',
          this.nest_google_device_uuid,
          pendingRtpTimestamp,
          data.length,
          keyframeAssemblyMs,
          KEYFRAME_MAX_BYTES,
          KEYFRAME_MAX_ASSEMBLY_MS,
        );

        this.#sendVideoPLI('shock-keyframe');
        this.#recordVideoHealthEvent('shock-keyframe');
        this.#resetPendingVideoFrame();
        return;
      }
    }

    // Hybrid timestamp model:
    // - First frame anchors to first packet arrival time
    // - Subsequent frames advance by RTP delta
    // - Timestamps are clamped near wall clock so they neither run far behind nor race ahead
    if (typeof videoRtp.lastTimestamp === 'number') {
      deltaTicks = (pendingRtpTimestamp - videoRtp.lastTimestamp + RTP_TIMESTAMP_MASK) % RTP_TIMESTAMP_MASK;

      if (deltaTicks > RTP_TIMESTAMP_MAX_DELTA) {
        this?.log?.debug?.(
          'Dropping reordered/backwards WebRTC video frame for uuid "%s": pendingTs="%s" lastTs="%s" deltaTicks="%s"',
          this.nest_google_device_uuid,
          pendingRtpTimestamp,
          videoRtp.lastTimestamp,
          deltaTicks,
        );

        this.#resetPendingVideoFrame();
        return;
      }

      deltaMs = (deltaTicks / video.sampleRate) * 1000;

      if (Number.isFinite(deltaMs) !== true || deltaMs < 0) {
        deltaMs = 0;
      }

      if (pendingKeyFrame === true) {
        maxVideoDeltaMs = TIMESTAMP_MAX_KEYFRAME_DELTA;
      }

      if (deltaMs > maxVideoDeltaMs) {
        if (pendingKeyFrame === true) {
          this?.log?.debug?.(
            'Clamping keyframe RTP delta for uuid "%s": rtpTs=%s deltaMs=%s capMs=%s',
            this.nest_google_device_uuid,
            pendingRtpTimestamp,
            Math.round(deltaMs),
            maxVideoDeltaMs,
          );

          this.#recordVideoHealthEvent('keyframe-clamp');
        }

        deltaMs = maxVideoDeltaMs;
      }
    }

    if (typeof videoOutput.lastTimestamp !== 'number') {
      pendingTimestamp = typeof pendingFirstPacketTime === 'number' ? pendingFirstPacketTime : now;

      // On startup, first packet timestamps can already be stale if keyframe wait took time.
      // Clamp to a reasonable recent window so follow-up frames do not get time-compressed.
      if (pendingTimestamp < now - TIMESTAMP_VIDEO_MAX_BEHIND) {
        pendingTimestamp = now - TIMESTAMP_VIDEO_MAX_BEHIND;
      }
    }

    if (typeof pendingTimestamp !== 'number') {
      pendingTimestamp = videoOutput.lastTimestamp + deltaMs;

      // Prevent output time from drifting too far behind wall clock
      if (pendingTimestamp < now - TIMESTAMP_VIDEO_MAX_BEHIND) {
        pendingTimestamp = now - TIMESTAMP_VIDEO_MAX_BEHIND;
      }

      // Prevent output time from racing ahead and causing frames to queue up waiting
      if (pendingTimestamp > now + TIMESTAMP_VIDEO_MAX_AHEAD) {
        pendingTimestamp = now + TIMESTAMP_VIDEO_MAX_AHEAD;
      }
    }

    // Enforce monotonic output timestamps even when upstream timing is noisy
    pendingTimestamp =
      typeof videoOutput.lastTimestamp === 'number' ? Math.max(pendingTimestamp, videoOutput.lastTimestamp + 1) : pendingTimestamp;

    videoRtp.lastTimestamp = pendingRtpTimestamp;
    videoOutput.lastTimestamp = pendingTimestamp;

    // A good keyframe means startup is complete and any startup PLI loop can stop
    if (pendingKeyFrame === true) {
      video.lastIDRTime = now;
    }

    // Mark source ready once the first decodable keyframe is emitted
    if (
      pendingKeyFrame === true &&
      this.sourceState !== Streamer.MESSAGE_TYPE.SOURCE_READY &&
      this.sourceState !== Streamer.MESSAGE_TYPE.SOURCE_CLOSED
    ) {
      this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_READY);
    }

    if (recoveringDeltaProbe === true && video?.health?.state === 'RECOVERING' && video?.health?.suppressDeltas === true) {
      video.health.suppressDeltas = false;
      video.health.lastSuppressedLogTime = undefined;
      this?.log?.debug?.('Re-enabled WebRTC deltas in RECOVERING after accepted delta for uuid "%s"', this.nest_google_device_uuid);
    }

    // Push final access unit into Streamer using paced output timestamp
    this.addMedia({
      type: Streamer.MEDIA_TYPE.VIDEO,
      codec: this.codecs.video,
      profile: typeof this.video?.profile === 'string' ? this.video.profile : undefined,
      bitrate: Number.isFinite(this.video?.bitrate) === true && this.video.bitrate > 0 ? this.video.bitrate : undefined,
      timestamp: pendingTimestamp,
      keyFrame: pendingKeyFrame === true,
      data: data,
    });

    this.#recordCleanVideoFrame(pendingKeyFrame === true);

    // Clear pending frame state ready for the next access unit
    this.#resetPendingVideoFrame();
  }

  #refreshStallTimer() {
    this.#lastPacketAt = Date.now();

    if (this.#stalledTimer !== undefined) {
      return;
    }

    this.#stalledTimer = setInterval(
      () => {
        if (typeof this.#lastPacketAt !== 'number') {
          return;
        }

        if (Date.now() - this.#lastPacketAt <= STALLED_TIMEOUT) {
          return;
        }

        if (
          this.#peerConnection === undefined ||
          this.#streamId === undefined ||
          this.sourceState === Streamer.MESSAGE_TYPE.SOURCE_CLOSED
        ) {
          // Stream was stopped/closed after this timer was armed, so ignore the timeout
          return;
        }

        this?.log?.debug?.(
          'No WebRTC playback packets received for uuid "%s" in the past %s seconds. Closing connection',
          this.nest_google_device_uuid,
          Math.round(STALLED_TIMEOUT / 1000),
        );

        this.#lastPacketAt = undefined;
        this.#requestReconnect('stall');
        this.close();
      },
      Math.max(1000, Math.round(STALLED_TIMEOUT / 2)),
    );
  }

  #handlePlaybackAudioPacket(rtpPacket) {
    if (this.sourceState === Streamer.MESSAGE_TYPE.SOURCE_CLOSING || this.sourceState === Streamer.MESSAGE_TYPE.SOURCE_CLOSED) {
      // We are closing or closed, so ignore any incoming packets. This can happen when remote is still sending
      // before we finish tearing down the connection, but we do not want to process any new packets at this point.
      return;
    }

    let now = Date.now();
    let delta = 0;
    let deltaTicks = 0;
    let deltaMs = 0;
    let timestamp = undefined;
    let pcm = undefined;
    let decoded = undefined;
    let mediaData = undefined;
    let audioLateByMs = 0;
    let decodeUsedFallback = false;

    // Validate RTP packet structure before touching any fields
    if (
      typeof rtpPacket !== 'object' ||
      rtpPacket === null ||
      typeof rtpPacket?.header !== 'object' ||
      rtpPacket.header === null ||
      Buffer.isBuffer(rtpPacket?.payload) !== true ||
      rtpPacket.payload.length === 0
    ) {
      // Not a valid RTP packet, ignore
      return;
    }

    // Extract RTP header fields with sanity checks and defaults
    let header = rtpPacket.header;
    let payload = rtpPacket.payload;
    let sequenceNumber = Number.isInteger(header.sequenceNumber) === true ? header.sequenceNumber : 0;
    let rtpTimestamp = Number.isInteger(header.timestamp) === true ? header.timestamp >>> 0 : 0;
    let payloadType = Number.isInteger(header.payloadType) === true ? header.payloadType : undefined;
    let ssrc = Number.isInteger(header.ssrc) === true ? header.ssrc >>> 0 : undefined;

    // Ensure playback state exists (in case packets arrive before onOpen fires)
    if (
      typeof this.#tracks?.audio !== 'object' ||
      this.#tracks.audio === null ||
      typeof this.#tracks.audio?.rtp !== 'object' ||
      this.#tracks.audio.rtp === null ||
      typeof this.#tracks.audio?.output !== 'object' ||
      this.#tracks.audio.output === null
    ) {
      this.#handlePlaybackBegin(Streamer.MEDIA_TYPE.AUDIO);
    }

    let audio = this.#tracks.audio;
    let audioRtp = audio.rtp;
    let audioOutput = audio.output;

    if (typeof audio.ssrc !== 'number' && typeof ssrc === 'number') {
      audio.ssrc = ssrc;
    }

    if (typeof payloadType === 'number' && payloadType !== audio.id) {
      return;
    }

    // Any valid incoming audio RTP packet means the playback path is still alive
    this.#refreshStallTimer();

    // Ignore older/reordered audio packets so timing remains monotonic
    if (typeof audioRtp.lastSequence === 'number') {
      delta = (sequenceNumber - audioRtp.lastSequence + RTP_SEQUENCE_WRAP) % RTP_SEQUENCE_WRAP;

      if (delta > RTP_SEQUENCE_WRAP / 2) {
        return;
      }
    }

    // Derive audio playout time from RTP timestamp deltas, same general model as video.
    // This keeps audio and video progressing from the source clock rather than forcing
    // audio onto a synthetic fixed 20ms ladder when upstream timing shifts.
    if (typeof audioRtp.lastTimestamp === 'number') {
      deltaTicks = (rtpTimestamp - audioRtp.lastTimestamp + RTP_TIMESTAMP_MASK) % RTP_TIMESTAMP_MASK;

      if (deltaTicks > RTP_TIMESTAMP_MAX_DELTA) {
        return;
      }

      deltaMs = (deltaTicks / audio.sampleRate) * 1000;

      if (Number.isFinite(deltaMs) !== true || deltaMs < 0) {
        deltaMs = 0;
      }

      if (deltaMs > TIMESTAMP_MAX_AUDIO_DELTA) {
        deltaMs = TIMESTAMP_MAX_AUDIO_DELTA;
      }
    }

    if (typeof audioOutput.lastTimestamp !== 'number') {
      timestamp = now;
    }

    if (typeof timestamp !== 'number') {
      timestamp = audioOutput.lastTimestamp + deltaMs;

      if (timestamp < now - TIMESTAMP_AUDIO_RESYNC_BEHIND) {
        audioLateByMs = now - timestamp;
        timestamp = now - Math.min(Number.isFinite(audio.packetTime) === true ? audio.packetTime : 20, 20);

        if (typeof audio.lastTimingClampLogTime !== 'number' || now - audio.lastTimingClampLogTime >= 10000) {
          audio.lastTimingClampLogTime = now;
          this?.log?.debug?.(
            'Resyncing delayed WebRTC audio for uuid "%s": lateMs=%s deltaMs=%s',
            this.nest_google_device_uuid,
            Math.round(audioLateByMs),
            Math.round(deltaMs),
          );
        }
      }

      if (timestamp > now + TIMESTAMP_MAX_AUDIO_DELTA) {
        timestamp = now + 1;
      }
    }

    timestamp = typeof audioOutput.lastTimestamp === 'number' ? Math.max(timestamp, audioOutput.lastTimestamp + 1) : timestamp;

    audioRtp.lastSequence = sequenceNumber;
    audioRtp.lastTimestamp = rtpTimestamp;
    audioOutput.lastTimestamp = timestamp;

    // Decode Opus RTP payload to PCM for downstream ffmpeg / streamer consumption
    if (payload.length > 0) {
      try {
        decoded = this.#opusDecoder.decode(payload);

        if (Buffer.isBuffer(decoded) === true && decoded.length > 0) {
          pcm = decoded;
        }

        if (pcm === undefined && decoded instanceof Uint8Array && decoded.length > 0) {
          pcm = Buffer.from(decoded.buffer, decoded.byteOffset, decoded.byteLength);
        }
      } catch (error) {
        this?.log?.debug?.('Error decoding Opus audio for uuid "%s": %s', this.nest_google_device_uuid, String(error));
      }
    }

    // On decode failure, emit silence so audio timing remains continuous
    mediaData = Buffer.isBuffer(pcm) === true && pcm.length > 0 ? pcm : PCM_S16LE_48000_STEREO_BLANK;
    decodeUsedFallback = mediaData === PCM_S16LE_48000_STEREO_BLANK;

    if (decodeUsedFallback === true) {
      if (typeof audio.lastDecodeFallbackLogTime !== 'number' || now - audio.lastDecodeFallbackLogTime >= 10000) {
        audio.lastDecodeFallbackLogTime = now;
        this?.log?.debug?.(
          'Using blank WebRTC audio frame for uuid "%s": payloadBytes=%s decoded=%s',
          this.nest_google_device_uuid,
          payload.length,
          Buffer.isBuffer(decoded) === true || decoded instanceof Uint8Array ? decoded.length : 0,
        );
      }
    }

    this.addMedia({
      type: Streamer.MEDIA_TYPE.AUDIO,
      codec: this.codecs.audio,
      sampleRate: audio.sampleRate,
      channels: audio.channels,
      timestamp: timestamp,
      keyFrame: false,
      data: mediaData,
    });
  }

  #recordVideoHealthEvent(type = '') {
    let video = this.#tracks?.video;
    let health = video?.health;
    let now = Date.now();
    let clampCount = 0;
    let hasOtherBad = false;
    let isBad = true;
    let badScore = 0;
    let expired = undefined;

    if (typeof video !== 'object' || video === null) {
      return;
    }

    if (typeof health !== 'object' || health === null) {
      health = {
        state: 'STABLE',
        events: [],
        eventsStart: 0,
        badEvents: 0,
        badNonClampEvents: 0,
        clampEvents: 0,
        cleanScore: 0,
        lastCleanKeyframeTime: undefined,
        suppressDeltas: false,
        lastSuppressedLogTime: undefined,
      };
      video.health = health;
    }

    if (Array.isArray(health.events) !== true) {
      health.events = [];
    }

    if (Number.isInteger(health.eventsStart) !== true || health.eventsStart < 0) {
      health.eventsStart = 0;
    }

    if (Number.isInteger(health.badEvents) !== true || health.badEvents < 0) {
      health.badEvents = 0;
    }

    if (Number.isInteger(health.badNonClampEvents) !== true || health.badNonClampEvents < 0) {
      health.badNonClampEvents = 0;
    }

    if (Number.isInteger(health.clampEvents) !== true || health.clampEvents < 0) {
      health.clampEvents = 0;
    }

    // Prune expired rolling-window entries without reallocating on every call.
    while (health.eventsStart < health.events.length) {
      expired = health.events[health.eventsStart];

      if (typeof expired?.time !== 'number' || now - expired.time <= HEALTH_BAD_WINDOW_MS) {
        break;
      }

      if (expired.bad === true) {
        health.badEvents = Math.max(0, health.badEvents - 1);

        if (expired.type !== 'keyframe-clamp') {
          health.badNonClampEvents = Math.max(0, health.badNonClampEvents - 1);
        }
      }

      if (expired.type === 'keyframe-clamp') {
        health.clampEvents = Math.max(0, health.clampEvents - 1);
      }

      health.eventsStart++;
    }

    // Compact occasionally so storage stays bounded without per-event churn.
    if (health.eventsStart > 0 && (health.eventsStart >= 64 || health.eventsStart * 2 >= health.events.length)) {
      health.events = health.events.slice(health.eventsStart);
      health.eventsStart = 0;
    }

    if (type === 'keyframe-clamp') {
      clampCount = health.clampEvents;
      hasOtherBad = health.badNonClampEvents > 0;

      // Clamp is only considered bad when repeated in-window or alongside other bad signals.
      // Current event is not pushed yet, so clampCount>=1 means this is at least the second clamp.
      isBad = clampCount >= 1 || hasOtherBad === true;
    }

    health.events.push({
      time: now,
      type: type,
      bad: isBad === true,
    });

    if (type === 'keyframe-clamp') {
      health.clampEvents++;
    }

    if (isBad === true) {
      health.badEvents++;

      if (type !== 'keyframe-clamp') {
        health.badNonClampEvents++;
      }
    }

    badScore = health.badEvents;

    if (health.state === 'RECOVERING' && isBad === true) {
      health.state = 'UNSTABLE';
      health.cleanScore = 0;
      health.suppressDeltas = true;
      return;
    }

    if (badScore >= HEALTH_UNSTABLE_BAD_THRESHOLD && health.state !== 'UNSTABLE') {
      health.state = 'UNSTABLE';
      health.cleanScore = 0;
      health.suppressDeltas = true;
    }
  }

  #recordCleanVideoFrame(isKeyFrame = false) {
    let health = this.#tracks?.video?.health;
    let now = Date.now();
    let expired = undefined;

    if (typeof health !== 'object' || health === null) {
      return;
    }

    if (Array.isArray(health.events) === true) {
      if (Number.isInteger(health.eventsStart) !== true || health.eventsStart < 0) {
        health.eventsStart = 0;
      }

      if (Number.isInteger(health.badEvents) !== true || health.badEvents < 0) {
        health.badEvents = 0;
      }

      if (Number.isInteger(health.badNonClampEvents) !== true || health.badNonClampEvents < 0) {
        health.badNonClampEvents = 0;
      }

      if (Number.isInteger(health.clampEvents) !== true || health.clampEvents < 0) {
        health.clampEvents = 0;
      }

      while (health.eventsStart < health.events.length) {
        expired = health.events[health.eventsStart];

        if (typeof expired?.time !== 'number' || now - expired.time <= HEALTH_BAD_WINDOW_MS) {
          break;
        }

        if (expired.bad === true) {
          health.badEvents = Math.max(0, health.badEvents - 1);

          if (expired.type !== 'keyframe-clamp') {
            health.badNonClampEvents = Math.max(0, health.badNonClampEvents - 1);
          }
        }

        if (expired.type === 'keyframe-clamp') {
          health.clampEvents = Math.max(0, health.clampEvents - 1);
        }

        health.eventsStart++;
      }

      if (health.eventsStart > 0 && (health.eventsStart >= 64 || health.eventsStart * 2 >= health.events.length)) {
        health.events = health.events.slice(health.eventsStart);
        health.eventsStart = 0;
      }
    }

    if (isKeyFrame === true) {
      health.lastCleanKeyframeTime = now;
    }

    if (health.state === 'UNSTABLE' && isKeyFrame === true) {
      health.state = 'RECOVERING';
      // Slightly stricter: first clean keyframe enters RECOVERING.
      // Delta emission is re-enabled only after an accepted delta in flush path.
      health.suppressDeltas = true;
      health.cleanScore = 2;
      return;
    }

    if (health.state === 'RECOVERING') {
      health.cleanScore += isKeyFrame === true ? 2 : 1;

      if (health.cleanScore >= HEALTH_RECOVERING_CLEAN_TARGET) {
        health.state = 'STABLE';
        health.cleanScore = 0;
        health.events = [];
        health.eventsStart = 0;
        health.badEvents = 0;
        health.badNonClampEvents = 0;
        health.clampEvents = 0;
      }
    }
  }

  // eslint-disable-next-line no-unused-vars
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

    // Disabled: too noisy in practice. Stream health logging already captures PLI-related behaviour.
    //this?.log?.debug?.('Sending RTCP PLI for uuid "%s"%s', this.nest_google_device_uuid, reason !== '' ? ' (' + reason + ')' : '');

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
}
