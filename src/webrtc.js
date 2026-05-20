// WebRTC
// Part of homebridge-nest-accfactory
//
// Implements WebRTC-based streaming for Google Nest cameras using Google Home
// Foyer/gRPC signaling and control.
// Handles peer connection setup, RTP media processing, talkback audio,
// and integration with the Streamer pipeline for HomeKit live streaming
// and recording.
//
// Responsibilities:
// - Establish and manage RTCPeerConnection using the werift library
// - Use Google Home Foyer gRPC transport for signaling and stream control
// - Handle ICE negotiation and connection state lifecycle
// - Receive and process RTP media streams (H264 video, Opus audio, RTX)
// - Track RTP timing, sequence continuity, and stream health
// - Reorder bounded RTP audio/video jitter queues without owning output pacing
// - Parse H264 RTP payloads including:
//   - Single NAL units
//   - STAP-A aggregation packets
//   - FU-A fragmented NAL reassembly
//   - RTX retransmission recovery
// - Assemble complete H264 access units and emit Annex-B frames
// - Inject SPS/PPS before IDR frames when required
// - Decode Opus audio to PCM for downstream Streamer output
// - Inject media into Streamer for live streaming and HKSV recording
// - Support two-way audio (talkback) via outbound RTP/Opus pipeline
// - Detect stream stalls and perform automatic reconnect handling
//
// Features:
// - Secure media transport over DTLS-SRTP
// - Google Home Foyer gRPC signaling and stream lifecycle control
// - RTCP feedback support (PLI/NACK/FIR) for video recovery
// - Codec negotiation (H264 video, Opus audio, RTX retransmissions)
// - RTP timestamp mapping from source media clocks
// - Bounded synchronous jitter draining so bad media bursts cannot monopolise the Node.js event loop
// - Stream health monitoring with recovery/suppression logic
// - Startup timing and stream diagnostics logging
// - Automatic handling of packet loss, corruption, and stalled playback
// - Local vs remote stream path detection based on SDP candidates
//
// Notes:
// - WebRTC signaling and stream control are performed via the shared
//   Google Home Foyer gRPC transport/client
// - ICE "connected" indicates transport readiness, not media availability
// - Stream readiness is determined by successful video frame delivery
//   (first decodable keyframe), not connection state
// - Startup delays may occur due to upstream (Google) keyframe delivery behaviour
// - Audio is decoded to PCM; output pacing is owned by Streamer
// - Emitted media timestamps describe source media time derived from RTP timing
// - Output playout timing, catch-up, and live latency policy are owned by Streamer
// - Incomplete keyframes and pathological access units are dropped/recovered locally rather than blocking the plugin process
//
// Code version 2026.05.20
// Mark Hulskamp
'use strict';

// Define external module requirements
import * as werift from 'werift';
import { Decoder } from '@evan/opus';

// Define nodejs module requirements
import { Buffer } from 'node:buffer';
import { setInterval, clearInterval, setTimeout } from 'node:timers';
import path from 'node:path';
import crypto from 'node:crypto';

// Define our modules
import Streamer from './streamer.js';
import StreamTransport from './streamtransport.js';
import GrpcTransport from './grpctransport.js';
import H264 from './h264.js';
import RtpH264 from './rtph264.js';

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
const KEYFRAME_MAX_ASSEMBLY_MS = 2500; // Drop pathological keyframes assembled too slowly
const KEYFRAME_STARTUP_MAX_ASSEMBLY_MS = 4000; // First decodable keyframe may be slow while WebRTC starts
const KEYFRAME_BLOCKING_MAX_ASSEMBLY_MS = 900; // Do not let one broken IDR block newer timestamp groups for seconds
const KEYFRAME_MAX_BYTES = 140000; // Drop oversized keyframes that cause visible playback shock
const DELTA_FU_SWITCH_GRACE_MS = 180; // Tiny grace before abandoning a young non-keyframe FU-A on timestamp switch
const STALLED_TIMEOUT = 10000; // Time with no playback packets before we consider stream stalled and attempt restart
const AUDIO_RTP_REORDER_DELAY_MS = 50; // Hold audio RTP briefly so reordered Opus packets can arrive before decode
const AUDIO_RTP_REORDER_MAX_PACKETS = 64; // Bound audio RTP reorder queue
const VIDEO_RTP_REORDER_DELAY_MS = 250; // Hold video RTP briefly so reordered fragments/RTX can arrive before FU-A assembly
const VIDEO_RTP_REORDER_MAX_PACKETS = 512; // Bound video RTP reorder queue; large IDRs can exceed 100 RTP packets
const VIDEO_RTP_DRAIN_MAX_GROUPS = 8; // Bound synchronous video jitter release work per callback
const VIDEO_RTP_DRAIN_MAX_PACKETS = 128; // Bound synchronous H264 assembly work per callback
const STARTUP_KEYFRAME_PLI_INTERVAL_MS = 1500; // Retry startup keyframe requests while waiting for first decodable IDR
const STARTUP_KEYFRAME_PLI_MAX_MS = 12000; // Bound startup PLI retries so slow sources do not spam RTCP forever

// WebRTC object
export default class WebRTC extends StreamTransport {
  token = undefined; // oauth2 token
  fieldTest = undefined;

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
  #startupKeyframeTimer = undefined; // Interval object for bounded startup keyframe PLI retries
  #startupKeyframeStartedAt = undefined; // Wall-clock time when startup keyframe retry began
  #lastPacketAt = undefined; // Last playback packet receipt time in ms
  #closeInProgress = false; // True while close() teardown is running to avoid re-entrant shutdown races
  #reconnectPending = false; // Reconnect requested once socket closes
  #tracks = { audio: {}, video: {}, talkback: {} }; // Track state for audio and video

  constructor(options = {}) {
    super(options);

    // Setup WebRTC-specific codec defaults; StreamTransport owns the shared media shape.
    this.video.codec = StreamTransport.CODEC_TYPE.H264;
    this.video.clockRate = 90000;
    this.audio.codec = StreamTransport.CODEC_TYPE.PCM;
    this.audio.profile = 's16le';
    this.audio.sampleRate = 48000;
    this.audio.channels = 2;
    this.audio.bitrate = this.audio.sampleRate * this.audio.channels * 16;
    this.audio.frameDuration = 20;
    this.talkback.codec = StreamTransport.CODEC_TYPE.OPUS;
    this.talkback.sampleRate = 48000;
    this.talkback.channels = 2;

    this.update(options);

    this.#setupGoogleHomeFoyer();
  }

  // Class functions
  // eslint-disable-next-line no-unused-vars
  async doOpen(options = {}) {
    if (this.connecting === true || this.closing === true || (this.#peerConnection !== undefined && this.closed !== true)) {
      return;
    }

    // Tell the Streamer base that we are beginning source setup.
    // This is transport/control readiness only and does not mean media is flowing yet.
    this.setState(StreamTransport.STATE.CONNECTING);

    // Reset any previous session timers/state before attempting a new connection.
    // This ensures a reconnect starts from a clean baseline rather than reusing
    // timers or partially assembled media from an earlier session.
    clearInterval(this.#extendTimer);
    clearInterval(this.#stalledTimer);
    clearInterval(this.#startupKeyframeTimer);
    this.#extendTimer = undefined;
    this.#stalledTimer = undefined;
    this.#startupKeyframeTimer = undefined;
    this.#startupKeyframeStartedAt = undefined;
    this.#lastPacketAt = undefined;
    this.#streamId = undefined;
    this.#reconnectPending = false;
    this.#tracks = { audio: {}, video: {}, talkback: {} };

    // Resolve Google Foyer device ID lazily so constructor prefetch failure
    // does not permanently prevent future stream attempts.
    if (typeof this.#googleHomeDeviceUUID !== 'string' && this.#googleHomeDeviceUUIDPromise instanceof Promise !== true) {
      this.#setupGoogleHomeFoyer();
    }

    // Wait for any in-flight Google Home device ID lookup to finish.
    if (this.#googleHomeDeviceUUIDPromise instanceof Promise) {
      await this.#googleHomeDeviceUUIDPromise;
    }

    // open() can overlap with close() during fast stop/reopen cycles.
    // Abort if teardown happened while waiting for Google Home lookup.
    if (this.#closeInProgress === true || this.#peerConnection !== undefined) {
      return;
    }

    // We still could not resolve the Google Foyer device ID.
    // Without this mapping we cannot start streaming or recording.
    if (typeof this.#googleHomeDeviceUUID !== 'string' || this.#googleHomeDeviceUUID === '') {
      this?.log?.debug?.('Google Home device UUID not resolved for uuid "%s"', this.uuid);
      this.setState(StreamTransport.STATE.CLOSED, { reason: 'google-device-id-missing' });
      return;
    }

    let homeFoyerResponse = await this.#grpcTransport.command(GOOGLE_HOME_FOYER_PREFIX, 'CameraService', 'SendCameraViewIntent', {
      request: {
        googleDeviceId: {
          value: this.#googleHomeDeviceUUID,
        },
        command: 'VIEW_INTENT_START',
      },
    });

    if (this.#closeInProgress === true || this.#peerConnection !== undefined) {
      return;
    }

    if (homeFoyerResponse?.status !== 0) {
      this?.log?.debug?.('Request to start camera viewing was not accepted for uuid "%s"', this.uuid);
      this.setState(StreamTransport.STATE.CLOSED, { reason: 'view-intent-failed' });
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
      deviceId: this.uuid,
      local: true, // Request direct peer-to-peer connection if possible
      streamContext: 'STREAM_CONTEXT_DEFAULT',
      // Request highest possible resolution; actual delivered resolution may be lower.
      requestedVideoResolution: 'VIDEO_RESOLUTION_FULL_HIGH',
      sdp: webRTCOffer.sdp,
    });

    if (this.#peerConnection !== peerConnection) {
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
      this?.log?.debug?.('WebRTC offer was not agreed with remote for uuid "%s". Response: %j', this.uuid, homeFoyerResponse);

      this.setState(StreamTransport.STATE.CLOSED, { reason: 'offer-rejected' });
      return;
    }

    // If the SDP answer contains a private/local candidate, then local access was granted.
    // Otherwise traffic will use the normal routed/remote path and we should continue sending
    // periodic stream extension requests to keep the session alive.
    let localAccessGranted =
      /a=candidate:.* (10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+|fd[0-9a-f]{2}:[0-9a-f:]+)/i.test(
        homeFoyerResponse.data[0].sdp || '',
      ) === true;

    // Track subscription callbacks feed the media-specific assembly paths.
    // Audio is decoded and emitted as PCM; video is assembled into complete access units.
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
        if (this.connected !== true) {
          this.setState(StreamTransport.STATE.CONNECTED, { sessionId: this.#streamId });
        }
        return;
      }

      if (
        (state === 'failed' || state === 'disconnected' || (state === 'closed' && this.hasConsumers() === true)) &&
        this.closing !== true &&
        this.closed !== true &&
        this.reconnecting !== true
      ) {
        this?.log?.debug?.('WebRTC ICE state "%s" for uuid "%s", requesting reconnect', state, this.uuid);
        this.#requestReconnect('ice-' + state);

        if (this.hasConsumers() === true) {
          this.close();
        }
      }
    });

    // Periodically extend the active stream only when we do not have local access.
    // Local streams are expected to remain valid without needing explicit extend requests.
    if (localAccessGranted !== true) {
      this.#extendTimer = setInterval(async () => {
        if (
          this.#grpcTransport !== undefined &&
          this.ready === true &&
          this.#streamId !== undefined &&
          this.#googleHomeDeviceUUID !== undefined
        ) {
          let extendResponse = await this.#grpcTransport.command(GOOGLE_HOME_FOYER_PREFIX, 'CameraService', 'JoinStream', {
            command: 'extend',
            deviceId: this.uuid,
            streamId: this.#streamId,
          });

          if (extendResponse?.data?.[0]?.streamExtensionStatus !== 'STATUS_STREAM_EXTENDED') {
            this?.log?.debug?.('Error occurred while requesting stream extension for uuid "%s"', this.uuid);
            this.#requestReconnect('extend-failed');
            this.close();
          }
        }
      }, EXTEND_INTERVAL);
    }
  }

  async doClose() {
    if (this.#closeInProgress === true) {
      return;
    }

    this.#closeInProgress = true;
    let closingPeerConnection = this.#peerConnection;
    let closingStreamId = this.#streamId;
    let talkbackActive = this.#tracks?.talkback?.active === true;

    try {
      // Mark source as closing for a normal teardown so any in-flight playback
      // callbacks stop accepting new packets while shutdown is happening.
      // During reconnect we keep SOURCE_RECONNECTING so the lifecycle state
      // does not bounce backwards during transport teardown.
      if (this.#reconnectPending !== true) {
        this.setState(StreamTransport.STATE.CLOSING, { sessionId: closingStreamId });
      }

      // Stop timers first so we stop producing any new work immediately.
      clearInterval(this.#extendTimer);
      clearInterval(this.#stalledTimer);
      clearInterval(this.#startupKeyframeTimer);
      this.#extendTimer = undefined;
      this.#stalledTimer = undefined;
      this.#startupKeyframeTimer = undefined;
      this.#startupKeyframeStartedAt = undefined;
      this.#lastPacketAt = undefined;

      // Release any video packets that were being held briefly for RTP reordering
      // before flushing the final completed access unit.
      this.#drainPlaybackVideoJitterBuffer(true);

      // Flush any pending video access unit before tearing state down.
      // Video is emitted frame-by-frame, so the last completed frame would otherwise
      // be lost if close occurs before another packet triggers a normal flush.
      this.#flushPendingVideoFrame();

      // Clear media/talkback track state before closing remote transport.
      // This lets any in-flight callbacks naturally no-op while shutdown continues.
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
        this?.log?.debug?.('Notifying remote about closing connection for uuid "%s"', this.uuid);

        // Tell remote to end the stream session
        await this.#grpcTransport.command(GOOGLE_HOME_FOYER_PREFIX, 'CameraService', 'JoinStream', {
          command: 'end',
          deviceId: this.uuid,
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
        this.#videoTransceiver = undefined;
        this.#audioTransceiver = undefined;
      }

      if (this.#reconnectPending === true) {
        // We have a reconnect pending, so reset the flag and attempt to reconnect.
        // We do this only after the current session has really closed to avoid racing
        // a new stream setup against a half-torn-down old connection.
        this.#reconnectPending = false;

        if (this.hasConsumers() === true) {
          // Defer reconnect until close() has left finally and #closeInProgress
          // is false. Otherwise open() can see teardown in progress and abort
          // after already moving lifecycle state back to CONNECTING.
          setTimeout(() => {
            this.open();
          }, 0);
          return;
        }
      }

      if (this.hasConsumers() !== true && this.#reconnectPending !== true) {
        this.setState(StreamTransport.STATE.CLOSED, { sessionId: closingStreamId });
      }
    } finally {
      this.#closeInProgress = false;
    }
  }

  doUpdate(options = {}) {
    let newToken = undefined;
    let newUuid = undefined;
    let hadToken = typeof this.token === 'string' && this.token !== '';
    let hadUuid = typeof this.uuid === 'string' && this.uuid !== '';

    // Validate options object.
    if (typeof options !== 'object' || options === null) {
      return;
    }

    // Normalise updated values from transport options.
    // Undefined means "leave existing value unchanged".
    //
    // Streamer now passes a shared transport update payload:
    // {
    //   uuid,
    //   apiAccess,
    //   fieldTest
    // }
    //
    // WebRTC derives:
    // - token from apiAccess.oauth2
    // - field test mode from fieldTest
    newUuid = typeof options?.uuid === 'string' && options.uuid !== '' ? options.uuid : undefined;
    newToken = typeof options?.apiAccess?.oauth2 === 'string' && options.apiAccess.oauth2 !== '' ? options.apiAccess.oauth2 : undefined;

    // Update device UUID used for logging/signalling.
    // Avoid logging on initial assignment since this may be the first update()
    // call used to populate transport state from the parent device.
    if (typeof newUuid === 'string' && newUuid !== this.uuid) {
      if (hadUuid === true && this.hasConsumers() === true) {
        this?.log?.debug?.('Google Home device UUID has changed for uuid "%s" to "%s" while WebRTC session is active.', this.uuid, newUuid);
      }

      this.uuid = newUuid;

      // UUID changed, so cached Google Foyer mapping is no longer valid.
      this.#googleHomeDeviceUUID = undefined;
      this.#googleHomeDeviceUUIDPromise = undefined;
    }

    // Update OAuth2 access token.
    // Avoid logging on initial assignment since token refreshes are normal when
    // there are no active consumers.
    if (typeof newToken === 'string' && newToken !== this.token) {
      if (hadToken === true && this.hasConsumers() === true) {
        this?.log?.debug?.('OAuth2 token has changed for uuid "%s" while WebRTC session is active. Updating stored token.', this.uuid);
      }

      this.token = newToken;
    }

    // Only update field test mode when explicitly supplied.
    // This allows partial update() calls without accidentally changing behaviour.
    if (typeof options?.fieldTest === 'boolean') {
      this.fieldTest = options.fieldTest === true;
    }
  }

  async doSendAudio(talkingBuffer) {
    if (
      Buffer.isBuffer(talkingBuffer) !== true ||
      this.#googleHomeDeviceUUID === undefined ||
      this.#streamId === undefined ||
      typeof this.#audioTransceiver?.sender?.sendRtp !== 'function'
    ) {
      return;
    }

    // Ensure talkback state exists.
    if (typeof this.#tracks.talkback !== 'object' || this.#tracks.talkback === null) {
      this.#tracks.talkback = {};
    }

    let talk = this.#tracks.talkback;

    // Default RTP/codec settings for outbound Opus talkback.
    if (typeof talk.id !== 'number') {
      talk.id = RTP_OPUS_AUDIO_PAYLOAD_TYPE;
    }

    if (typeof talk.sampleRate !== 'number') {
      talk.sampleRate = this.talkback.sampleRate;
    }

    if (typeof talk.packetTime !== 'number') {
      talk.packetTime = 20;
    }

    if (talkingBuffer.length > 0) {
      // If talkback is not active yet, ask the remote device to enable it.
      if (talk.active !== true) {
        // Avoid issuing duplicate async start requests if HomeKit feeds
        // audio faster than Google Home Foyer responds.
        if (talk.starting === true) {
          return;
        }

        talk.starting = true;

        let homeFoyerResponse = await this.#grpcTransport.command(GOOGLE_HOME_FOYER_PREFIX, 'CameraService', 'SendTalkback', {
          googleDeviceId: { value: this.#googleHomeDeviceUUID },
          streamId: this.#streamId,
          command: 'COMMAND_START',
        });

        talk.starting = false;

        // Failed to enable talkback on the remote side.
        if (homeFoyerResponse?.status !== 0) {
          this?.log?.debug?.('Error starting talkback for uuid "%s"', this.uuid);

          talk.active = undefined;
          talk.stopPending = false;
          talk.rtp = undefined;
          return;
        }

        talk.active = true;
        this?.log?.debug?.('Talking started on uuid "%s"', this.uuid);

        // Edge case:
        // HomeKit may stop talking while the async start request was still
        // in-flight. If that happened, immediately stop cleanly.
        if (talk.stopPending === true) {
          talk.stopPending = false;

          await this.sendAudio(Buffer.alloc(0));
          return;
        }
      }

      // Safety guard in case talkback never became active.
      if (talk.active !== true) {
        return;
      }

      // Initialise RTP packet state if not already done.
      // We maintain RTP continuity so the remote endpoint accepts packets.
      if (typeof talk.rtp !== 'object' || talk.rtp === null) {
        talk.rtp = {};
      }

      if (typeof talk.rtp.sequenceNumber !== 'number') {
        talk.rtp.sequenceNumber = 0;
      }

      if (typeof talk.rtp.timestamp !== 'number') {
        // RTP timestamps are sample-clock based, not wall-clock.
        talk.rtp.timestamp = Math.floor(Math.random() * 0xffffffff);
      }

      // Build RTP header for outbound Opus payload.
      let header = new werift.RtpHeader();
      header.ssrc = this.#audioTransceiver.sender.ssrc;
      header.payloadType = talk.id;
      header.sequenceNumber = talk.rtp.sequenceNumber++ & RTP_SEQUENCE_MASK;
      header.timestamp = talk.rtp.timestamp >>> 0;
      header.marker = true;
      header.payloadOffset = RTP_PACKET_HEADER_SIZE;

      // Send outbound RTP packet to the WebRTC sender.
      let packet = new werift.RtpPacket(header, talkingBuffer);
      this.#audioTransceiver.sender.sendRtp(packet.serialize());

      // Advance RTP timestamp for next packet.
      // Example:
      // 20ms @ 48kHz = 960 samples.
      talk.rtp.timestamp = (talk.rtp.timestamp + Math.round((talk.sampleRate * talk.packetTime) / 1000)) >>> 0;
      return;
    }

    // No active or pending talkback session to stop.
    if (talk.active !== true && talk.starting !== true) {
      return;
    }

    // If the async start request is still in-flight, defer the stop until
    // the start completes so we avoid racing START and STOP commands.
    if (talk.starting === true) {
      talk.stopPending = true;
      return;
    }

    // Notify the remote endpoint to disable talkback.
    let homeFoyerResponse = await this.#grpcTransport.command(GOOGLE_HOME_FOYER_PREFIX, 'CameraService', 'SendTalkback', {
      googleDeviceId: { value: this.#googleHomeDeviceUUID },
      streamId: this.#streamId,
      command: 'COMMAND_STOP',
    });

    if (homeFoyerResponse?.status !== 0) {
      this?.log?.debug?.('Error stopping talkback for uuid "%s"', this.uuid);
    } else {
      this?.log?.debug?.('Talking ended on uuid "%s"', this.uuid);
    }

    // Reset talkback state ready for next session.
    talk.active = undefined;
    talk.starting = false;
    talk.stopPending = false;
    talk.rtp = undefined;
  }

  #handlePlaybackBegin(mediaType) {
    if (this.closing === true || this.closed === true) {
      return;
    }

    if (mediaType === Streamer.MEDIA_TYPE.VIDEO) {
      this.#ensurePlaybackVideoTrack();

      this.#tracks.video.rtp = { lastSequence: undefined, lastTimestamp: undefined };
      this.#tracks.video.output = { lastTimestamp: undefined };
      this.#tracks.video.deltaAudit = { hasAcceptedKeyframe: false };
      this.#tracks.video.h264 = this.#createH264State();

      if (typeof this.#tracks.video.jitter === 'object' && this.#tracks.video.jitter !== null) {
        this.clearJitterBuffer(this.#tracks.video.jitter);
      }

      // Start bounded startup keyframe requests. The first call may happen
      // before the RTP SSRC is known, so retries continue until the first IDR.
      this.#startStartupKeyframeTimer();
      this.#sendVideoPLI();

      this.#refreshStallTimer();
      return;
    }

    if (mediaType === Streamer.MEDIA_TYPE.AUDIO) {
      this.#ensurePlaybackAudioTrack();

      this.#tracks.audio.rtp = { lastSequence: undefined, lastTimestamp: undefined };
      this.#tracks.audio.output = { lastTimestamp: undefined };

      if (typeof this.#tracks.audio.jitter === 'object' && this.#tracks.audio.jitter !== null) {
        this.clearJitterBuffer(this.#tracks.audio.jitter);
      }

      this.#refreshStallTimer();
    }
  }

  #ensurePlaybackVideoTrack() {
    // Build or repair the per-session video state once, keeping packet hot paths
    // focused on RTP/H264 work instead of repeated object-shape checks.
    if (typeof this.#tracks !== 'object' || this.#tracks === null) {
      this.#tracks = {};
    }

    if (typeof this.#tracks.video !== 'object' || this.#tracks.video === null) {
      this.#tracks.video = {};
    }

    let video = this.#tracks.video;

    video.id = typeof video.id === 'number' ? video.id : RTP_H264_VIDEO_PAYLOAD_TYPE;
    video.rtxId = typeof video.rtxId === 'number' ? video.rtxId : RTP_H264_VIDEO_RTX_PAYLOAD_TYPE;
    video.rtxSsrc = typeof video.rtxSsrc === 'number' ? video.rtxSsrc : undefined;
    video.codec = typeof video.codec === 'string' ? video.codec : StreamTransport.CODEC_TYPE.H264;
    video.sampleRate = typeof video.sampleRate === 'number' ? video.sampleRate : 90000;
    video.lastPLITime = typeof video.lastPLITime === 'number' ? video.lastPLITime : undefined;
    video.keyframeRequestInFlight = typeof video.keyframeRequestInFlight === 'boolean' ? video.keyframeRequestInFlight : false;
    video.lastKeyframeEventTime = typeof video.lastKeyframeEventTime === 'number' ? video.lastKeyframeEventTime : undefined;

    video.rtp = typeof video.rtp === 'object' && video.rtp !== null ? video.rtp : { lastSequence: undefined, lastTimestamp: undefined };
    video.output = typeof video.output === 'object' && video.output !== null ? video.output : { lastTimestamp: undefined };
    video.health = typeof video.health === 'object' && video.health !== null ? video.health : this.getMediaState('video');
    video.deltaAudit =
      typeof video.deltaAudit === 'object' && video.deltaAudit !== null ? video.deltaAudit : { hasAcceptedKeyframe: false };

    if (typeof video.jitter !== 'object' || video.jitter === null || video.jitter.groupByTimestamp !== true) {
      video.jitter = this.createJitterBuffer({
        groupByTimestamp: true,
        delayMs: VIDEO_RTP_REORDER_DELAY_MS,
        maxPackets: VIDEO_RTP_REORDER_MAX_PACKETS,
      });
    }

    if (typeof video.h264 !== 'object' || video.h264 === null) {
      video.h264 = this.#createH264State();
    }

    return video;
  }

  #ensurePlaybackAudioTrack() {
    // Build or repair the per-session audio state once so packet handling only
    // deals with RTP timing, Opus decode, and decoded-frame emission.
    if (typeof this.#tracks !== 'object' || this.#tracks === null) {
      this.#tracks = {};
    }

    if (typeof this.#tracks.audio !== 'object' || this.#tracks.audio === null) {
      this.#tracks.audio = {};
    }

    let audio = this.#tracks.audio;

    audio.id = typeof audio.id === 'number' ? audio.id : RTP_OPUS_AUDIO_PAYLOAD_TYPE;
    audio.codec = typeof audio.codec === 'string' ? audio.codec : StreamTransport.CODEC_TYPE.OPUS;
    audio.sampleRate = typeof audio.sampleRate === 'number' ? audio.sampleRate : 48000;
    audio.channels = typeof audio.channels === 'number' ? audio.channels : 2;
    audio.packetTime = typeof audio.packetTime === 'number' ? audio.packetTime : 20;
    audio.rtp = typeof audio.rtp === 'object' && audio.rtp !== null ? audio.rtp : { lastSequence: undefined, lastTimestamp: undefined };
    audio.output = typeof audio.output === 'object' && audio.output !== null ? audio.output : { lastTimestamp: undefined };
    audio.lastDecodeFallbackLogTime = typeof audio.lastDecodeFallbackLogTime === 'number' ? audio.lastDecodeFallbackLogTime : undefined;
    audio.lastDecodeErrorLogTime = typeof audio.lastDecodeErrorLogTime === 'number' ? audio.lastDecodeErrorLogTime : undefined;

    if (typeof audio.jitter !== 'object' || audio.jitter === null || audio.jitter.groupByTimestamp === true) {
      audio.jitter = this.createJitterBuffer({
        delayMs: AUDIO_RTP_REORDER_DELAY_MS,
        maxPackets: AUDIO_RTP_REORDER_MAX_PACKETS,
      });
    }

    return audio;
  }

  #createH264State() {
    // H264 assembly state: cached parameter sets, one pending access unit,
    // and one in-progress FU-A NAL reconstruction.
    return {
      fuParts: [],
      fuBytes: 0,
      fuNalType: 0,
      fuRtpTimestamp: undefined,
      fuFirstPacketTime: undefined,
      fuLastSequence: undefined,
      lastSPS: undefined,
      lastPPS: undefined,
      hasIDR: false,
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

  #drainPlaybackVideoJitterBuffer(force = false) {
    let video = this.#tracks?.video;
    let jitter = video?.jitter;
    let now = Date.now();
    let group = undefined;
    let groupAgeMs = 0;
    let keyframeAssemblyLimitMs = KEYFRAME_MAX_ASSEMBLY_MS;
    let keyframeTimedOut = false;
    let packetCount = 0;
    let groupCount = 0;

    if (
      (this.closing === true && force !== true) ||
      this.closed === true ||
      typeof video !== 'object' ||
      video === null ||
      typeof jitter !== 'object' ||
      jitter === null ||
      jitter.groupByTimestamp !== true
    ) {
      return;
    }

    for (group of this.releaseJitterGroups(jitter, {
      force: force,
      maxGroups: force === true ? undefined : VIDEO_RTP_DRAIN_MAX_GROUPS,
      maxPackets: force === true ? undefined : VIDEO_RTP_DRAIN_MAX_PACKETS,
      isComplete: (entry) => {
        groupAgeMs = now - (entry?.firstReceivedAt || now);

        return RtpH264.isTimestampGroupComplete(entry, this.sortJitterGroupPackets(jitter, entry));
      },
      canWait: (entry) => {
        groupAgeMs = now - (entry?.firstReceivedAt || now);
        packetCount = this.countJitterPackets(jitter);
        groupCount = this.sizeJitterBuffer(jitter);
        keyframeAssemblyLimitMs =
          groupCount > 1
            ? KEYFRAME_BLOCKING_MAX_ASSEMBLY_MS
            : this.ready === true
              ? KEYFRAME_MAX_ASSEMBLY_MS
              : KEYFRAME_STARTUP_MAX_ASSEMBLY_MS;
        keyframeTimedOut = entry?.hasKeyFrame === true && groupAgeMs >= keyframeAssemblyLimitMs;

        if (entry?.hasKeyFrame === true && keyframeTimedOut !== true) {
          return true;
        }

        return groupAgeMs < VIDEO_RTP_REORDER_DELAY_MS && packetCount < VIDEO_RTP_REORDER_MAX_PACKETS;
      },
    })) {
      groupAgeMs = now - (group?.firstReceivedAt || now);

      if (RtpH264.isTimestampGroupComplete(group, this.sortJitterGroupPackets(jitter, group)) !== true) {
        jitter.lastReleasedTimestamp = group.rtpTimestamp;
        this.recordVideoDrop(group?.hasKeyFrame === true ? 'jitter-keyframe-incomplete' : 'jitter-frame-incomplete');

        if (group?.hasKeyFrame === true) {
          if (typeof jitter.lastDropLogTime !== 'number' || now - jitter.lastDropLogTime >= 10000) {
            jitter.lastDropLogTime = now;
            this?.log?.debug?.(
              'Dropping incomplete jittered WebRTC keyframe for uuid "%s": rtpTs="%s" packets="%s" ageMs="%s" ' +
                'marker="%s" fuStart="%s" fuEnd="%s"',
              this.uuid,
              group.rtpTimestamp,
              Array.isArray(group.packets) === true ? group.packets.length : 0,
              Math.round(groupAgeMs),
              group.markerSeen === true ? 'true' : 'false',
              group.hasFragmentStart === true ? 'true' : 'false',
              group.hasFragmentEnd === true ? 'true' : 'false',
            );
          }

          this.#sendVideoPLI();
          this.markMediaIssue('video', 'jitter-keyframe-incomplete');
          this.clearJitterBuffer(jitter);
          this.#resetFragmentedVideoFrame();
          this.#resetPendingVideoFrame();
          break;
        }

        continue;
      }

      this.sortJitterGroupPackets(jitter, group);

      for (let packet of group.packets) {
        jitter.lastReleasedSequence = packet.sequenceNumber;
        this.#handlePlaybackVideoPacket(packet.packet, true);
      }

      jitter.lastReleasedTimestamp = group.rtpTimestamp;
    }

    if (force !== true && this.sizeJitterBuffer(jitter) > 0) {
      this.recordVideoReorder('defers');
    }
  }

  #appendH264NalUnit(h264, nal) {
    // Append one complete H264 NAL as Annex-B and update frame/parameter-set state.
    let nalType = 0;
    let part = undefined;

    if (typeof h264 !== 'object' || h264 === null || Buffer.isBuffer(nal) !== true || nal.length === 0) {
      return false;
    }

    part = H264.wrapAnnexB(nal);
    h264.pendingParts.push(part);
    h264.pendingBytes += part.length;

    nalType = nal[0] & 0x1f;

    if (nalType === H264.NALUS.TYPES.SPS) {
      h264.lastSPS = Buffer.from(nal);
    }

    if (nalType === H264.NALUS.TYPES.PPS) {
      h264.lastPPS = Buffer.from(nal);
    }

    if (nalType === H264.NALUS.TYPES.IDR) {
      h264.pendingKeyFrame = true;
      h264.pendingHasVcl = true;
      h264.hasIDR = true;
    }

    if (nalType === H264.NALUS.TYPES.SLICE_NON_IDR) {
      h264.pendingHasVcl = true;
    }

    return true;
  }

  #handlePlaybackVideoPacket(rtpPacket, fromJitterBuffer = false) {
    if ((this.closing === true && fromJitterBuffer !== true) || this.closed === true) {
      // We are closing or closed, so ignore any incoming packets. This can happen when remote is still sending
      // before we finish tearing down the connection, but we do not want to process any new packets at this point.
      return;
    }

    let fuResult = undefined;
    let stapOffset = 0;
    let stapLength = 0;
    let stapNal = undefined;
    let seqDelta = 0;
    let isRtxPacket = false;
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
    let jitter = undefined;
    let payloadInfo = undefined;
    let queueSequenceNumber = 0;
    let packetReceivedAt = 0;

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
    packetReceivedAt = Number.isFinite(rtpPacket.receivedAt) === true ? rtpPacket.receivedAt : Date.now();

    let video = this.#ensurePlaybackVideoTrack();
    let h264 = video.h264;
    let videoRtp = video.rtp;
    let deltaAudit = video.deltaAudit;
    isRtxPacket = typeof payloadType === 'number' && payloadType === video.rtxId;

    if (fromJitterBuffer !== true) {
      jitter = video.jitter;

      if (isRtxPacket === true) {
        if (typeof video.rtxSsrc !== 'number' && typeof ssrc === 'number') {
          video.rtxSsrc = ssrc;
        }

        if (typeof video.rtxSsrc === 'number' && typeof ssrc === 'number' && ssrc !== video.rtxSsrc) {
          return;
        }

        if (Buffer.isBuffer(payload) !== true || payload.length < 3 || typeof video.ssrc !== 'number') {
          return;
        }

        queueSequenceNumber = payload.readUInt16BE(0);
        payload = payload.subarray(2);
        payloadType = video.id;
        ssrc = video.ssrc;
      } else {
        queueSequenceNumber = sequenceNumber;
      }

      if (typeof payloadType === 'number' && payloadType !== video.id) {
        return;
      }

      // Learn the primary video SSRC before jitter release so startup PLI can
      // request a fresh IDR even while the first timestamp group is still queued.
      if (typeof video.ssrc !== 'number' && typeof ssrc === 'number') {
        video.ssrc = ssrc;
      }

      if (typeof video.ssrc === 'number' && typeof ssrc === 'number' && ssrc !== video.ssrc) {
        return;
      }

      payloadInfo = RtpH264.getPayloadInfo(payload);

      if (
        this.pushJitterPacket(jitter, {
          rtpTimestamp: rtpTimestamp,
          sequenceNumber: queueSequenceNumber,
          receivedAt: packetReceivedAt,
          marker: marker,
          group: {
            hasKeyFrame: payloadInfo.hasKeyFrame === true,
            hasFragmentedNal: payloadInfo.hasFragmentedNal === true,
            hasFragmentStart: payloadInfo.hasFragmentStart === true,
            hasFragmentEnd: payloadInfo.hasFragmentEnd === true,
          },
          packet: {
            receivedAt: packetReceivedAt,
            header: {
              ...header,
              payloadType: video.id,
              sequenceNumber: queueSequenceNumber,
              ssrc: ssrc,
            },
            payload: payload,
          },
        }) !== true
      ) {
        return;
      }

      this.#drainPlaybackVideoJitterBuffer();
      return;
    }

    if (typeof deltaAudit !== 'object' || deltaAudit === null) {
      deltaAudit = {
        hasAcceptedKeyframe: false,
      };
      video.deltaAudit = deltaAudit;
    }

    // Packets released from the jitter buffer are already normalised to the
    // primary H264 payload type and SSRC. RTX is unwrapped before queueing.
    if (typeof video.ssrc !== 'number' && typeof ssrc === 'number') {
      video.ssrc = ssrc;
    }

    if (typeof video.ssrc === 'number' && typeof ssrc === 'number' && ssrc !== video.ssrc) {
      return;
    }

    if (typeof payloadType === 'number' && payloadType !== video.id) {
      return;
    }

    if (this.ready !== true && h264?.hasIDR !== true && typeof video.ssrc === 'number') {
      this.#sendVideoPLI();
    }

    // Drop duplicate or clearly late/out-of-order packets before they touch assembly state.
    // This mirrors the protection already used on audio and avoids duplicate fragments or
    // old retransmits corrupting pending H264 access units.
    if (typeof videoRtp.lastSequence === 'number') {
      seqDelta = (sequenceNumber - videoRtp.lastSequence + RTP_SEQUENCE_WRAP) % RTP_SEQUENCE_WRAP;

      if (seqDelta === 0 || seqDelta > RTP_SEQUENCE_WRAP / 2) {
        return;
      }
    }

    videoRtp.lastSequence = sequenceNumber;

    // Any valid incoming video RTP packet means the playback path is still alive
    this.#refreshStallTimer();

    // Peek at incoming packet type so keyframe FU-A starts can preempt delta grace.
    incomingNalType = payload[0] & 0x1f;

    if (incomingNalType === H264.NALUS.TYPES.FU_A && payload.length >= 2) {
      incomingFuHeader = payload[1];
      incomingFuStart = (incomingFuHeader & 0x80) === 0x80;
      incomingFuNalType = incomingFuHeader & 0x1f;
      incomingIsIdrFuStart = incomingFuStart === true && incomingFuNalType === H264.NALUS.TYPES.IDR;
    }

    // If a new RTP timestamp arrives while a previous pending frame is still open, flush it if complete.
    // Otherwise drop it as incomplete and start building the new frame instead.
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

        this.recordVideoDrop(h264.pendingKeyFrame === true ? 'pending-keyframe-incomplete' : 'pending-delta-incomplete');

        this?.log?.debug?.(
          'Drop incomplete pending video uuid "%s": oldTs=%s newTs=%s deltaTicks=%s wrapCandidate=%s parts=%s bytes=%s ageMs=%s marker=%s',
          this.uuid,
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
          this.#sendVideoPLI();
          this.markMediaIssue('video', 'pending-incomplete');
        }

        this.#resetPendingVideoFrame();
      }
    }

    // If a fragmented FU-A frame is still in progress but a new RTP timestamp arrives, drop the old fragment set
    if (typeof h264.fuRtpTimestamp === 'number' && h264.fuRtpTimestamp !== rtpTimestamp) {
      fuTsDeltaTicks = (rtpTimestamp - h264.fuRtpTimestamp + RTP_TIMESTAMP_MASK) % RTP_TIMESTAMP_MASK;
      fuTsWrapCandidate = h264.fuRtpTimestamp > rtpTimestamp && fuTsDeltaTicks < video.sampleRate * 2;
      fuAgeMs = typeof h264.fuFirstPacketTime === 'number' ? Date.now() - h264.fuFirstPacketTime : undefined;

      if (
        h264.fuNalType === H264.NALUS.TYPES.SLICE_NON_IDR &&
        Number.isFinite(fuAgeMs) === true &&
        fuAgeMs <= DELTA_FU_SWITCH_GRACE_MS &&
        incomingIsIdrFuStart !== true
      ) {
        this.recordVideoReorder('fuTimestampDefers');
      } else {
        this.recordVideoDrop(h264.fuNalType === H264.NALUS.TYPES.IDR ? 'fu-keyframe-incomplete' : 'fu-delta-incomplete');

        this?.log?.debug?.(
          'Drop incomplete FU-A uuid "%s": oldTs=%s newTs=%s deltaTicks=%s wrapCandidate=%s nalType=%s parts=%s bytes=%s ageMs=%s',
          this.uuid,
          h264.fuRtpTimestamp,
          rtpTimestamp,
          fuTsDeltaTicks,
          fuTsWrapCandidate === true ? 'true' : 'false',
          h264.fuNalType,
          Array.isArray(h264.fuParts) === true ? h264.fuParts.length : 0,
          Number.isFinite(h264.fuBytes) === true ? h264.fuBytes : 0,
          fuAgeMs,
        );

        if (h264.fuNalType === H264.NALUS.TYPES.IDR || (Number.isFinite(fuAgeMs) === true && fuAgeMs >= 600)) {
          this.#sendVideoPLI();
          this.markMediaIssue('video', 'fu-incomplete');
        }
      }

      this.#resetFragmentedVideoFrame();
    }

    // Initialise the pending frame timestamp from the first packet we see for this frame
    if (typeof h264.pendingRtpTimestamp !== 'number') {
      h264.pendingRtpTimestamp = rtpTimestamp;
      h264.pendingFirstPacketTime = packetReceivedAt;
    }

    let nalHeader = payload[0];
    let nalType = nalHeader & 0x1f;

    // Single NAL units can be appended directly to the pending frame
    if (nalType > 0 && nalType < 24) {
      this.#appendH264NalUnit(h264, payload);

      // Marker means this RTP packet finishes the access unit, so flush the frame now
      if (marker === true) {
        h264.pendingMarkerSeen = true;
        this.#flushPendingVideoFrame();
      }

      return;
    }

    // STAP-A contains multiple complete NAL units in a single RTP packet
    if (nalType === H264.NALUS.TYPES.STAP_A) {
      stapOffset = 1;

      while (stapOffset + 2 <= payload.length) {
        stapLength = payload.readUInt16BE(stapOffset);
        stapOffset += 2;

        if (stapLength <= 0 || stapOffset + stapLength > payload.length) {
          this.recordVideoDrop('stap-a-invalid');
          this.#resetPendingVideoFrame();
          return;
        }

        stapNal = payload.subarray(stapOffset, stapOffset + stapLength);
        stapOffset += stapLength;

        this.#appendH264NalUnit(h264, stapNal);
      }

      // Marker means this packet completed the frame payload for this timestamp
      if (marker === true) {
        h264.pendingMarkerSeen = true;
        this.#flushPendingVideoFrame();
      }

      return;
    }

    // FU-A carries one large NAL unit split across multiple RTP packets
    if (nalType === H264.NALUS.TYPES.FU_A) {
      fuResult = RtpH264.acceptFuA(h264, payload, {
        sequenceNumber: sequenceNumber,
        rtpTimestamp: rtpTimestamp,
        receivedAt: packetReceivedAt,
        sequenceMask: RTP_SEQUENCE_MASK,
      });

      if (fuResult?.ok !== true) {
        if (fuResult?.reason === 'orphan') {
          if (fuResult?.nalType === H264.NALUS.TYPES.IDR) {
            this.recordVideoDrop('fu-keyframe-incomplete');

            this?.log?.debug?.(
              'Dropping orphaned WebRTC FU-A keyframe fragment for uuid "%s": seq="%s" ts="%s"',
              this.uuid,
              sequenceNumber,
              rtpTimestamp,
            );

            this.#sendVideoPLI();
            this.markMediaIssue('video', 'fu-incomplete');
          }

          this.#resetFragmentedVideoFrame();
          if (h264.pendingRtpTimestamp === rtpTimestamp && h264.pendingHasVcl !== true) {
            this.#resetPendingVideoFrame();
          }
          return;
        }

        if (fuResult?.reason === 'gap') {
          this.recordVideoDrop(fuResult?.nalType === H264.NALUS.TYPES.IDR ? 'fu-keyframe-incomplete' : 'fu-delta-incomplete');

          if (fuResult?.nalType === H264.NALUS.TYPES.IDR) {
            h264.pendingCorrupt = true;

            this?.log?.debug?.(
              'Dropping gapped WebRTC FU-A keyframe for uuid "%s": expectedSeq="%s" seq="%s" ts="%s"',
              this.uuid,
              fuResult.expectedSequenceNumber,
              sequenceNumber,
              rtpTimestamp,
            );

            this.#sendVideoPLI();
            this.markMediaIssue('video', 'fu-incomplete');
          }

          this.#resetFragmentedVideoFrame();
          if (h264.pendingRtpTimestamp === rtpTimestamp && h264.pendingHasVcl !== true) {
            this.#resetPendingVideoFrame();
          }
          return;
        }

        h264.pendingCorrupt = true;
        return;
      }

      if (fuResult.interrupted === true) {
        h264.pendingCorrupt = true;
        this.recordVideoDrop(fuResult.previousNalType === H264.NALUS.TYPES.IDR ? 'fu-keyframe-incomplete' : 'fu-delta-incomplete');

        this?.log?.debug?.(
          'Interrupted incomplete WebRTC FU-A for uuid "%s": seq="%s" ts="%s" oldNal="%s" newNal="%s" parts="%s"',
          this.uuid,
          sequenceNumber,
          rtpTimestamp,
          fuResult.previousNalType,
          fuResult.nalType,
          fuResult.previousParts,
        );

        if (fuResult.previousNalType === H264.NALUS.TYPES.IDR) {
          this.#sendVideoPLI();
          this.markMediaIssue('video', 'fu-incomplete');
        }
      }

      // For fragmented keyframes, frame arrival starts with the FU-A start packet,
      // not when the completed NAL is finally appended to pendingParts.
      if (fuResult.start === true) {
        if (typeof h264.pendingRtpTimestamp !== 'number') {
          h264.pendingRtpTimestamp = rtpTimestamp;
        }

        if (typeof h264.pendingFirstPacketTime !== 'number') {
          h264.pendingFirstPacketTime = packetReceivedAt;
        }
      }

      // Once the FU-A end fragment arrives, move the rebuilt NAL into the pending frame
      if (fuResult.complete === true) {
        h264.pendingParts.push(fuResult.data);
        h264.pendingBytes += fuResult.bytes;

        if (fuResult.nalType === H264.NALUS.TYPES.IDR) {
          h264.pendingKeyFrame = true;
          h264.pendingHasVcl = true;
          h264.hasIDR = true;
        }

        if (fuResult.nalType === H264.NALUS.TYPES.SLICE_NON_IDR) {
          h264.pendingHasVcl = true;
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
      this.uuid,
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

    RtpH264.resetFragmentState(h264);
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
    let data = undefined;
    let deltaTicks = 0;
    let deltaMs = 0;
    let accessUnit = undefined;
    let keyframeAssemblyMs = undefined;
    let keyframeAssemblyLimitMs = KEYFRAME_MAX_ASSEMBLY_MS;
    let keyframeHasParameterSets = false;
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
      };
      video.deltaAudit = deltaAudit;
    }

    // Source media timing state is kept separate from raw RTP timing before handing frames to Streamer.
    // WebRTC only maps RTP clock ticks onto a source timestamp; Streamer owns playout policy.
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

    // Ignore access-unit fragments that never contained an actual video slice
    if (h264.pendingHasVcl !== true) {
      this.#resetPendingVideoFrame();
      return;
    }

    // Wait until marker bit says the full frame/access unit has arrived
    if (h264.pendingMarkerSeen !== true) {
      return;
    }

    if (pendingKeyFrame === true && h264.pendingBytes > KEYFRAME_MAX_BYTES) {
      this.recordVideoDrop('oversized-keyframe');

      this?.log?.debug?.(
        'Dropping oversized WebRTC keyframe before access-unit build for uuid "%s": rtpTs=%s bytes=%s limit=%s',
        this.uuid,
        pendingRtpTimestamp,
        h264.pendingBytes,
        KEYFRAME_MAX_BYTES,
      );

      this.#sendVideoPLI();
      this.markMediaIssue('video', 'oversized-keyframe');
      this.#resetPendingVideoFrame();
      return;
    }

    accessUnit = H264.buildAccessUnit(pendingParts, {
      keyFrame: pendingKeyFrame,
      sps: h264.lastSPS,
      pps: h264.lastPPS,
    });

    data = accessUnit?.data;
    keyframeHasParameterSets = pendingKeyFrame === true ? accessUnit?.hasParameterSets === true : false;

    // Final safety check before handing frame to Streamer
    if (Buffer.isBuffer(data) !== true || data.length === 0) {
      this.#resetPendingVideoFrame();
      return;
    }

    // Drop frames already marked corrupt during packet assembly
    if (h264.pendingCorrupt === true) {
      this.recordVideoDrop(pendingKeyFrame === true ? 'corrupt-keyframe' : 'corrupt-delta');

      this?.log?.debug?.(
        'Dropping corrupt WebRTC video frame for uuid "%s": rtpTs="%s" bytes="%s"',
        this.uuid,
        pendingRtpTimestamp,
        data.length,
      );

      if (pendingKeyFrame === true) {
        this.#sendVideoPLI();
        this.markMediaIssue('video', 'corrupt-keyframe');
      }

      this.#resetPendingVideoFrame();
      return;
    }

    // While suppression is enabled, UNSTABLE drops deltas.
    // RECOVERING lets a delta attempt pass deeper checks, but does not clear
    // suppression until that delta is actually accepted for emission.
    if (pendingKeyFrame !== true && video?.health?.suppressDeltas === true) {
      if (video?.health?.state === StreamTransport.MEDIA_STATE.UNSTABLE) {
        if (typeof video?.health?.lastSuppressedLogTime !== 'number' || Date.now() - video.health.lastSuppressedLogTime >= 1000) {
          video.health.lastSuppressedLogTime = Date.now();
          this?.log?.debug?.('Suppressing WebRTC delta frame for uuid "%s" while stream health is "%s"', this.uuid, video.health.state);
        }

        this.#resetPendingVideoFrame();
        return;
      }

      if (video?.health?.state === StreamTransport.MEDIA_STATE.RECOVERING) {
        recoveringDeltaProbe = true;
        this?.log?.debug?.('Probing WebRTC delta frame in RECOVERING for uuid "%s"', this.uuid);
      }
    }

    // Do not emit delta frames until at least one IDR has been accepted
    if (pendingKeyFrame !== true && deltaAudit.hasAcceptedKeyframe !== true) {
      this.recordVideoDrop('pre-keyframe-delta');

      this?.log?.debug?.(
        'Dropping pre-keyframe WebRTC video frame for uuid "%s": bytes="%s" rtpTs="%s"',
        this.uuid,
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
      keyframeAssemblyLimitMs =
        typeof videoRtp.lastTimestamp === 'number' || this.ready === true ? KEYFRAME_MAX_ASSEMBLY_MS : KEYFRAME_STARTUP_MAX_ASSEMBLY_MS;

      if (
        keyframeHasParameterSets !== true ||
        (Number.isFinite(keyframeAssemblyMs) === true && keyframeAssemblyMs > keyframeAssemblyLimitMs) ||
        data.length > KEYFRAME_MAX_BYTES
      ) {
        this.recordVideoDrop('shock-keyframe');

        this?.log?.debug?.(
          'Dropping shock keyframe for uuid "%s": rtpTs=%s bytes=%s assemblyMs=%s hasParameterSets=%s (limits: bytes<=%s assemblyMs<=%s)',
          this.uuid,
          pendingRtpTimestamp,
          data.length,
          keyframeAssemblyMs,
          keyframeHasParameterSets === true ? 'true' : 'false',
          KEYFRAME_MAX_BYTES,
          keyframeAssemblyLimitMs,
        );

        this.#sendVideoPLI();
        this.markMediaIssue('video', 'shock-keyframe');
        this.#resetPendingVideoFrame();
        return;
      }
    }

    // Map RTP video time onto source media time without output pacing policy.
    // Reordering/assembly stays here; smoothing, catch-up, and drops belong to Streamer.
    if (typeof videoRtp.lastTimestamp === 'number') {
      deltaTicks = (pendingRtpTimestamp - videoRtp.lastTimestamp + RTP_TIMESTAMP_MASK) % RTP_TIMESTAMP_MASK;

      if (deltaTicks > RTP_TIMESTAMP_MAX_DELTA) {
        this.recordVideoDrop('backwards-timestamp');

        this?.log?.debug?.(
          'Dropping reordered/backwards WebRTC video frame for uuid "%s": pendingTs="%s" lastTs="%s" deltaTicks="%s"',
          this.uuid,
          pendingRtpTimestamp,
          videoRtp.lastTimestamp,
          deltaTicks,
        );

        this.#resetPendingVideoFrame();
        return;
      }
    }

    // Convert RTP clock deltas into source timestamps.
    // Uses previous accepted RTP timestamp instead of a fixed RTP epoch so reconnects
    // and RTP session restarts do not poison timing.
    if (typeof videoOutput.lastTimestamp !== 'number') {
      pendingTimestamp = typeof pendingFirstPacketTime === 'number' ? pendingFirstPacketTime : now;
    } else {
      deltaTicks = 0;

      if (typeof videoRtp.lastTimestamp === 'number') {
        deltaTicks = (pendingRtpTimestamp - videoRtp.lastTimestamp + RTP_TIMESTAMP_MASK) % RTP_TIMESTAMP_MASK;
      }

      deltaMs = (deltaTicks / video.sampleRate) * 1000;

      if (Number.isFinite(deltaMs) !== true || deltaMs < 0) {
        deltaMs = 1;
      }

      pendingTimestamp = videoOutput.lastTimestamp + Math.max(1, deltaMs);
    }

    // Enforce monotonic source media timestamps even when upstream timing is noisy
    pendingTimestamp =
      typeof videoOutput.lastTimestamp === 'number' ? Math.max(pendingTimestamp, videoOutput.lastTimestamp + 1) : pendingTimestamp;

    videoRtp.lastTimestamp = pendingRtpTimestamp;
    videoOutput.lastTimestamp = pendingTimestamp;

    // A good keyframe means startup is complete and any startup PLI loop can stop
    if (pendingKeyFrame === true) {
      deltaAudit.hasAcceptedKeyframe = true;
      this.#stopStartupKeyframeTimer();
    }

    // Mark source ready once the first decodable keyframe is emitted
    if (pendingKeyFrame === true && this.ready !== true && this.closed !== true) {
      this.setState(StreamTransport.STATE.READY, { sessionId: this.#streamId });
    }

    if (
      recoveringDeltaProbe === true &&
      video?.health?.state === StreamTransport.MEDIA_STATE.RECOVERING &&
      video?.health?.suppressDeltas === true
    ) {
      video.health.suppressDeltas = false;
      video.health.lastSuppressedLogTime = undefined;
      this?.log?.debug?.('Re-enabled WebRTC deltas in RECOVERING after accepted delta for uuid "%s"', this.uuid);
    }

    if (pendingKeyFrame === true) {
      video.lastKeyframeEventTime = now;
    }

    // Push final access unit into Streamer using source media timestamp.
    // Streamer maps this onto each output's playout schedule.
    this.emitMedia({
      type: Streamer.MEDIA_TYPE.VIDEO,
      codec: this.video.codec,
      profile: typeof this.video?.profile === 'string' ? this.video.profile : undefined,
      bitrate: Number.isFinite(this.video?.bitrate) === true && this.video.bitrate > 0 ? this.video.bitrate : undefined,
      timestamp: pendingTimestamp,
      keyFrame: pendingKeyFrame === true,
      data: data,
    });

    this.markMediaFrame('video', { keyFrame: pendingKeyFrame === true });

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

        if (this.#peerConnection === undefined || this.#streamId === undefined || this.closed === true) {
          // Stream was stopped/closed after this timer was armed, so ignore the timeout
          return;
        }

        this?.log?.debug?.(
          'No WebRTC playback packets received for uuid "%s" in the past %s seconds. Closing connection',
          this.uuid,
          Math.round(STALLED_TIMEOUT / 1000),
        );

        this.#lastPacketAt = undefined;
        this.#requestReconnect('stall');
        this.close();
      },
      Math.max(1000, Math.round(STALLED_TIMEOUT / 2)),
    );
  }

  #startStartupKeyframeTimer() {
    if (this.#startupKeyframeTimer !== undefined || this.ready === true || this.closed === true || this.closing === true) {
      return;
    }

    this.#startupKeyframeStartedAt = Date.now();

    this.#startupKeyframeTimer = setInterval(() => {
      let now = Date.now();

      if (this.ready === true || this.closed === true || this.closing === true) {
        this.#stopStartupKeyframeTimer();
        return;
      }

      if (now - this.#startupKeyframeStartedAt > STARTUP_KEYFRAME_PLI_MAX_MS) {
        this.#stopStartupKeyframeTimer();
        this?.log?.debug?.(
          'Stopped WebRTC startup keyframe requests for uuid "%s" after %sms without accepted keyframe',
          this.uuid,
          STARTUP_KEYFRAME_PLI_MAX_MS,
        );
        return;
      }

      this.#sendVideoPLI();
    }, STARTUP_KEYFRAME_PLI_INTERVAL_MS);
  }

  #stopStartupKeyframeTimer() {
    clearInterval(this.#startupKeyframeTimer);
    this.#startupKeyframeTimer = undefined;
    this.#startupKeyframeStartedAt = undefined;
  }

  #drainPlaybackAudioJitterBuffer(force = false) {
    let audio = this.#tracks?.audio;
    let jitter = audio?.jitter;
    let releasedPackets = 0;

    if (
      (this.closing === true && force !== true) ||
      this.closed === true ||
      typeof audio !== 'object' ||
      audio === null ||
      typeof jitter !== 'object' ||
      jitter === null ||
      jitter.groupByTimestamp === true
    ) {
      return;
    }

    for (let packet of this.releaseJitterPackets(jitter, force)) {
      releasedPackets++;
      this.#handlePlaybackAudioPacket(packet.packet, true);
    }

    return releasedPackets;
  }

  #handlePlaybackAudioPacket(rtpPacket, fromJitterBuffer = false) {
    if (this.closing === true || this.closed === true) {
      // We are closing or closed, so ignore any incoming packets. This can happen when remote is still sending
      // before we finish tearing down the connection, but we do not want to process any new packets at this point.
      return;
    }

    let delta = 0;
    let deltaTicks = 0;
    let deltaMs = 0;
    let timestamp = undefined;
    let pcm = undefined;
    let decoded = undefined;
    let now = Date.now();

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
    now = fromJitterBuffer === true && Number.isFinite(rtpPacket.receivedAt) === true ? rtpPacket.receivedAt : now;

    let audio = this.#ensurePlaybackAudioTrack();
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

    if (fromJitterBuffer !== true) {
      if (
        this.pushJitterPacket(audio.jitter, {
          sequenceNumber: sequenceNumber,
          rtpTimestamp: rtpTimestamp,
          receivedAt: now,
          packet: {
            receivedAt: now,
            header: header,
            payload: payload,
          },
        }) !== true
      ) {
        return;
      }

      this.#drainPlaybackAudioJitterBuffer();
      return;
    }

    // Ignore older/reordered audio packets so timing remains monotonic
    if (typeof audioRtp.lastSequence === 'number') {
      delta = (sequenceNumber - audioRtp.lastSequence + RTP_SEQUENCE_WRAP) % RTP_SEQUENCE_WRAP;

      if (delta > RTP_SEQUENCE_WRAP / 2) {
        return;
      }
    }

    // Map RTP audio time onto source media time without output pacing policy.
    // Uses previous accepted RTP timestamp instead of a fixed RTP epoch so reconnects
    // and long-running RTP sessions do not poison timing.
    if (typeof audioRtp.lastTimestamp === 'number') {
      deltaTicks = (rtpTimestamp - audioRtp.lastTimestamp + RTP_TIMESTAMP_MASK) % RTP_TIMESTAMP_MASK;

      if (deltaTicks > RTP_TIMESTAMP_MAX_DELTA) {
        return;
      }
    }

    if (typeof audioOutput.lastTimestamp !== 'number') {
      timestamp = now;
    } else {
      deltaTicks = 0;

      if (typeof audioRtp.lastTimestamp === 'number') {
        deltaTicks = (rtpTimestamp - audioRtp.lastTimestamp + RTP_TIMESTAMP_MASK) % RTP_TIMESTAMP_MASK;
      }

      deltaMs = (deltaTicks / audio.sampleRate) * 1000;

      if (Number.isFinite(deltaMs) !== true || deltaMs < 0) {
        deltaMs = 1;
      }

      timestamp = audioOutput.lastTimestamp + Math.max(1, deltaMs);
    }

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
        if (typeof audio.lastDecodeErrorLogTime !== 'number' || now - audio.lastDecodeErrorLogTime >= 10000) {
          audio.lastDecodeErrorLogTime = now;
          this?.log?.debug?.('Error decoding Opus audio for uuid "%s": %s', this.uuid, String(error));
        }
      }
    }

    if (Buffer.isBuffer(pcm) !== true || pcm.length === 0) {
      if (typeof audio.lastDecodeFallbackLogTime !== 'number' || now - audio.lastDecodeFallbackLogTime >= 10000) {
        audio.lastDecodeFallbackLogTime = now;
        this?.log?.debug?.(
          'Dropping undecoded WebRTC audio frame for uuid "%s": payloadBytes=%s decoded=%s',
          this.uuid,
          payload.length,
          Buffer.isBuffer(decoded) === true || decoded instanceof Uint8Array ? decoded.length : 0,
        );
      }

      return;
    }

    timestamp = typeof audioOutput.lastTimestamp === 'number' ? Math.max(timestamp, audioOutput.lastTimestamp + 1) : timestamp;

    audioRtp.lastSequence = sequenceNumber;
    audioRtp.lastTimestamp = rtpTimestamp;
    audioOutput.lastTimestamp = timestamp;

    this.emitMedia({
      type: Streamer.MEDIA_TYPE.AUDIO,
      codec: this.audio.codec,
      profile: this.audio.profile,
      sampleRate: this.audio.sampleRate,
      channels: this.audio.channels,
      bitrate: Number.isFinite(this.audio?.bitrate) === true && this.audio.bitrate > 0 ? this.audio.bitrate : undefined,
      frameDuration: this.audio.frameDuration,
      timestamp: timestamp,
      keyFrame: false,
      data: pcm,
    });
  }

  #sendVideoPLI() {
    let video = this.#tracks?.video;
    let now = Date.now();
    let sendResult = undefined;

    if (this.#videoTransceiver === undefined || video === undefined || typeof video?.ssrc !== 'number') {
      return;
    }

    if (video.keyframeRequestInFlight === true) {
      return;
    }

    if (typeof video.lastPLITime === 'number' && now - video.lastPLITime < 1500) {
      return;
    }

    video.lastPLITime = now;
    video.keyframeRequestInFlight = true;
    this.recordKeyframeRequest();

    try {
      sendResult = this.#videoTransceiver?.receiver?.sendRtcpPLI?.(video.ssrc);

      if (sendResult instanceof Promise) {
        sendResult
          .catch((error) => {
            this?.log?.debug?.('Error sending WebRTC PLI for uuid "%s": %s', this.uuid, String(error));
          })
          .finally(() => {
            if (this.#tracks?.video === video) {
              video.keyframeRequestInFlight = false;
            }
          });
        return;
      }
    } catch (error) {
      this?.log?.debug?.('Error sending WebRTC PLI for uuid "%s": %s', this.uuid, String(error));
    }

    video.keyframeRequestInFlight = false;
  }

  #requestReconnect(reason) {
    if (this.#reconnectPending === true) {
      return;
    }

    this.#reconnectPending = true;

    this.setState(StreamTransport.STATE.RECONNECTING, { reason: reason, sessionId: this.#streamId });
  }

  #setupGoogleHomeFoyer() {
    // Avoid duplicate lookups if one is already running.
    if (this.#googleHomeDeviceUUIDPromise instanceof Promise) {
      return;
    }

    // Create/recreate the Google Home Foyer transport when needed.
    // This also allows fieldTest/uuid/token updates to be reflected after update().
    if (this.#grpcTransport === undefined) {
      this.#grpcTransport = new GrpcTransport({
        log: this.log,
        protoPath: path.resolve(__dirname + '/protobuf/googlehome/foyer.proto'),
        endpointHost:
          this.fieldTest === true
            ? 'https://preprod-googlehomefoyer-pa.sandbox.googleapis.com'
            : 'https://googlehomefoyer-pa.googleapis.com',
        uuid: this.uuid,
        userAgent: USER_AGENT,
        requestTimeout: GOOGLE_HOME_FOYER_REQUEST_TIMEOUT,
        bufferInitial: GOOGLE_HOME_FOYER_BUFFER_INITIAL,
        bufferMax: GOOGLE_HOME_FOYER_BUFFER_MAX,
        getAuthHeader: () => (typeof this.token === 'string' && this.token.trim() !== '' ? 'Bearer ' + this.token : ''),
      });
    }

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
                Object.values(device.otherIds.otherThirdPartyId || {}).forEach((other) => {
                  if (other?.id === this.uuid) {
                    this.#googleHomeDeviceUUID = device.id.googleUuid;
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
          'Unable to resolve Google Home device ID for "%s". Stream video/recording will be unavailable: %s',
          this.uuid,
          String(error),
        );

        return undefined;
      })
      .finally(() => {
        this.#googleHomeDeviceUUIDPromise = undefined;
      });
  }
}
