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
// - Reorder bounded RTP queues, releasing held audio at its deadline without owning output pacing
// - Parse H264 RTP payloads including:
//   - Single NAL units
//   - STAP-A aggregation packets
//   - FU-A fragmented NAL reassembly
//   - RTX retransmission recovery
// - Assemble each complete jitter group independently and emit Annex-B frames
// - Inject SPS/PPS before IDR frames when required
// - Preserve ordered native Opus audio for downstream Streamer outputs
// - Inject media into Streamer for live streaming and HKSV recording
// - Support two-way audio (talkback) via outbound RTP/Opus pipeline
// - Detect stream stalls and perform automatic reconnect handling
//
// Features:
// - Secure media transport over DTLS-SRTP
// - Google Home Foyer gRPC signaling and stream lifecycle control
// - RTCP feedback support (PLI/NACK/FIR) for video recovery
// - Codec negotiation (H264 video, Opus audio, RTX retransmissions)
// - Source RTP clock mapping with paired RTCP sender-report synchronization
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
// - Audio remains compressed until FFmpeg performs the HomeKit codec conversion
// - Emitted timestamps preserve RTP intervals; paired sender reports establish the A/V relationship
// - Arrival time is an estimate until both sender reports are available; synchronization never rewinds either track
// - Output playout timing, catch-up, and live latency policy are owned by Streamer
// - Incomplete keyframes and pathological access units are dropped/recovered locally rather than blocking the plugin process
//
// Code version 2026.10.23
// Mark Hulskamp
'use strict';

// Define external module requirements
import * as werift from 'werift';

// Define nodejs module requirements
import { Buffer } from 'node:buffer';
import { setInterval, clearInterval, setTimeout, clearTimeout } from 'node:timers';
import path from 'node:path';
import crypto from 'node:crypto';

// Define our modules
import Streamer from './streamer.js';
import StreamTransport from './streamtransport.js';
import GrpcTransport from '../../grpctransport.js';
import H264 from './h264.js';

// Define constants
import { USER_AGENT, __dirname } from '../../consts.js';

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
const KEYFRAME_MAX_ASSEMBLY_MS = 2500; // Expire incomplete keyframes during established playback
const KEYFRAME_STARTUP_MAX_ASSEMBLY_MS = 4000; // First decodable keyframe may be slow while WebRTC starts
const KEYFRAME_BLOCKING_MAX_ASSEMBLY_MS = 900; // Do not let one broken IDR block newer timestamp groups for seconds
const KEYFRAME_DEFAULT_BYTES = 2 * 1024 * 1024; // Startup allowance before source resolution/bitrate is known
const KEYFRAME_MAX_BYTES = 4 * 1024 * 1024; // Absolute bound for unusually large high-resolution keyframes
const KEYFRAME_BYTES_PER_PIXEL = 0.5; // Conservative compressed-IDR allowance derived from learned resolution
const KEYFRAME_BITRATE_SECONDS = 4; // Allow an IDR burst up to four seconds of the learned average bitrate
const STALLED_TIMEOUT = 10000; // Time with no playback packets before we consider stream stalled and attempt restart
const AUDIO_RTP_REORDER_DELAY_MS = 50; // Hold audio RTP briefly so reordered Opus packets can arrive before emission
const AUDIO_RTP_REORDER_MAX_PACKETS = 64; // Bound audio RTP reorder queue
const VIDEO_RTP_REORDER_DELAY_MS = 250; // Hold video RTP briefly so reordered fragments/RTX can arrive before FU-A assembly
const VIDEO_RTP_REORDER_MAX_PACKETS = 4096; // Bound video RTP queue while allowing a fragmented 4MiB keyframe plus packet overhead
const VIDEO_RTP_DRAIN_MAX_GROUPS = 8; // Bound synchronous video jitter release work per callback
const VIDEO_RTP_DRAIN_MAX_PACKETS = 128; // Bound synchronous H264 assembly work per callback
const STARTUP_KEYFRAME_REQUEST_INTERVAL_MS = 1500; // Retry startup keyframe requests while waiting for first decodable IDR
const STARTUP_KEYFRAME_REQUEST_MAX_MS = 12000; // Bound startup retries so slow sources do not spam RTCP forever
const VIDEO_REMB_BITRATE = 4_000_000; // Raise the sender's conservative startup estimate while keyframes are requested

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
  #extendTimer = undefined; // Stream extend timer
  #audioJitterTimer = undefined; // Release held audio at its reorder deadline, even without another packet
  #stalledTimer = undefined; // Interval object for no received data checks
  #startupKeyframeTimer = undefined; // Interval object for bounded startup keyframe PLI retries
  #startupKeyframeStartedAt = undefined; // Wall-clock time when startup keyframe retry began
  #lastPacketAt = undefined; // Last playback packet receipt time in ms
  #closeInProgress = false; // True while close() teardown is running to avoid re-entrant shutdown races
  #reconnectPending = false; // Reconnect requested once socket closes
  #clockSynchronized = false; // Sender reports establish one A/V reference per source pair.
  #tracks = { audio: {}, video: {}, talkback: {} }; // Track state for audio and video

  constructor(options = {}) {
    super(options);

    // Setup WebRTC-specific codec defaults; StreamTransport owns the shared media shape.
    this.video.codec = StreamTransport.CODEC_TYPE.H264;
    this.video.clockRate = 90000;
    this.audio.codec = StreamTransport.CODEC_TYPE.OPUS;
    this.audio.sampleRate = 48000;
    this.audio.channels = 2;
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
    clearTimeout(this.#audioJitterTimer);
    this.#audioJitterTimer = undefined;
    clearInterval(this.#startupKeyframeTimer);
    this.#extendTimer = undefined;
    this.#stalledTimer = undefined;
    this.#startupKeyframeTimer = undefined;
    this.#startupKeyframeStartedAt = undefined;
    this.#lastPacketAt = undefined;
    this.stats.webrtc = undefined;
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
    if (this.connecting !== true || this.#closeInProgress === true || this.#peerConnection !== undefined) {
      return;
    }

    // We still could not resolve the Google Foyer device ID.
    // Without this mapping we cannot start streaming or recording.
    if (typeof this.#googleHomeDeviceUUID !== 'string' || this.#googleHomeDeviceUUID === '') {
      this?.log?.debug?.('Google Home device UUID not resolved for uuid "%s"', this.uuid);
      this.setState(StreamTransport.STATE.CLOSED, { reason: 'google-device-id-missing' });
      return;
    }

    // Wake the camera while local certificate, SDP, and ICE candidate work runs.
    // These operations are independent until JoinStream sends the completed offer.
    let viewIntentPromise = this.#grpcTransport.command(GOOGLE_HOME_FOYER_PREFIX, 'CameraService', 'SendCameraViewIntent', {
      request: {
        googleDeviceId: {
          value: this.#googleHomeDeviceUUID,
        },
        command: 'VIEW_INTENT_START',
      },
    });

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
    let localOfferSdp = peerConnection.localDescription?.sdp ?? webRTCOffer.sdp;

    // Both overlapped operations must complete successfully before joining.
    let homeFoyerResponse = await viewIntentPromise;

    if (this.#peerConnection !== peerConnection || this.#closeInProgress === true) {
      try {
        await peerConnection?.close?.();
      } catch {
        // Empty
      }
      return;
    }

    if (homeFoyerResponse?.status !== 0) {
      await peerConnection?.close?.();
      this.#peerConnection = undefined;
      this.#videoTransceiver = undefined;
      this.#audioTransceiver = undefined;
      this?.log?.debug?.('Request to start camera viewing was not accepted for uuid "%s"', this.uuid);
      this.setState(StreamTransport.STATE.CLOSED, { reason: 'view-intent-failed' });
      return;
    }

    homeFoyerResponse = await this.#grpcTransport.command(GOOGLE_HOME_FOYER_PREFIX, 'CameraService', 'JoinStream', {
      command: 'offer',
      deviceId: this.uuid,
      local: false, // Request direct peer-to-peer connection if possible
      streamContext: 'STREAM_CONTEXT_DEFAULT',
      // Request highest possible resolution; actual delivered resolution may be lower.
      requestedVideoResolution: 'VIDEO_RESOLUTION_FULL_HIGH',
      // setLocalDescription() gathers ICE candidates and updates the peer's SDP.
      // The earlier createOffer() value does not contain those candidates.
      sdp: localOfferSdp,
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
    // Audio remains native Opus; video is assembled into complete access units.
    // Track and RTP callbacks retain their peer owner across asynchronous teardown.
    this.#audioTransceiver?.onTrack?.subscribe?.((track) => {
      if (this.#peerConnection !== peerConnection) {
        return;
      }
      this.#handlePlaybackBegin(Streamer.MEDIA_TYPE.AUDIO);
      let clock = this.#tracks.audio.clock;
      track.onReceiveRtcp?.subscribe?.((packet) => {
        if (this.#peerConnection === peerConnection && this.#tracks.audio.clock === clock && this.#closeInProgress !== true) {
          this.#handleSenderReport('audio', packet);
        }
      });

      track.onReceiveRtp.subscribe((rtpPacket) => {
        if (
          this.#peerConnection !== peerConnection ||
          this.#tracks.audio.clock !== clock ||
          track.codec.payloadType !== RTP_OPUS_AUDIO_PAYLOAD_TYPE
        ) {
          // Ignore retired peers and unsupported audio payload types.
          return;
        }

        this.#handlePlaybackAudioPacket(rtpPacket);
      });
    });

    this.#videoTransceiver?.onTrack?.subscribe?.((track) => {
      if (this.#peerConnection !== peerConnection) {
        return;
      }
      this.#handlePlaybackBegin(Streamer.MEDIA_TYPE.VIDEO);
      let clock = this.#tracks.video.clock;
      track.onReceiveRtcp?.subscribe?.((packet) => {
        if (this.#peerConnection === peerConnection && this.#tracks.video.clock === clock && this.#closeInProgress !== true) {
          this.#handleSenderReport('video', packet);
        }
      });

      track.onReceiveRtp.subscribe((rtpPacket) => {
        if (
          this.#peerConnection !== peerConnection ||
          this.#tracks.video.clock !== clock ||
          (track.codec.payloadType !== RTP_H264_VIDEO_PAYLOAD_TYPE && track.codec.payloadType !== RTP_H264_VIDEO_RTX_PAYLOAD_TYPE)
        ) {
          // Ignore retired peers and unsupported video payload types.
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

    // SDP setup can finish after close or replacement. Only the current peer
    // may subscribe to ICE changes and own the stream-extension timer.
    if (this.#peerConnection !== peerConnection || this.#closeInProgress === true) {
      return;
    }

    // Monitor connection status. ICE "connected" means transport is ready,
    // not that media has actually started. Actual source readiness is promoted
    // later on the first decodable keyframe. Subsequent ICE events must not
    // downgrade an already media-ready source and stop downstream playout.
    // ICE checking is still negotiation and must not stamp connectedAt.
    peerConnection.iceConnectionStateChange.subscribe(() => {
      if (this.#peerConnection !== peerConnection) {
        return;
      }

      if (this.#closeInProgress === true) {
        return;
      }

      let state = peerConnection?.iceConnectionState;

      if (state === 'connected' || state === 'completed') {
        if (this.connected !== true && this.ready !== true) {
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

          // A delayed reply belongs to the peer that issued it, never its replacement.
          if (this.#peerConnection !== peerConnection || this.closing === true || this.closed === true) {
            return;
          }

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
      // Preserve final Werift transport/media counters before closing the peer
      // connection. This is especially useful when a reconnect was caused by
      // consent, ICE, or packet-flow failure.
      await this.refreshDiagnostics();

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
      clearTimeout(this.#audioJitterTimer);
      this.#audioJitterTimer = undefined;
      clearInterval(this.#startupKeyframeTimer);
      this.#extendTimer = undefined;
      this.#stalledTimer = undefined;
      this.#startupKeyframeTimer = undefined;
      this.#startupKeyframeStartedAt = undefined;
      this.#lastPacketAt = undefined;

      // Release complete queued timestamp groups before teardown. Incomplete
      // groups are discarded by the same validation used during playback.
      this.#drainPlaybackVideoJitterBuffer(true);

      // Clear media/talkback track state before closing remote transport.
      // This lets any in-flight callbacks naturally no-op while shutdown continues.
      this.#tracks = { audio: {}, video: {}, talkback: {} };
      this.#clockSynchronized = false;

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

      // NOTE: Do NOT release the gRPC client here. Full Streamer teardown calls shutdown().
      // The client is reused across WebRTC reconnects. Releasing it during
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

      // A requested source close is complete even when Streamer retains outputs for fallback video.
      // Leaving CLOSING here prevents open() from reconnecting when the camera becomes available again.
      if (this.#reconnectPending !== true) {
        this.setState(StreamTransport.STATE.CLOSED, { sessionId: closingStreamId });
      }
    } finally {
      this.#closeInProgress = false;
    }
  }

  // Release the retained gRPC connection after Streamer has closed the media transport.
  // Ordinary stream stops and reconnects keep this connection attached.
  async shutdown() {
    // Let constructor lookup retries finish before detaching, so they cannot reattach after teardown.
    await this.#googleHomeDeviceUUIDPromise;
    this.#grpcTransport?.release();
  }

  async refreshDiagnostics() {
    let peerConnection = this.#peerConnection;
    let report = undefined;
    let stats = [];
    let transport = undefined;
    let candidatePair = undefined;
    let localCandidate = undefined;
    let remoteCandidate = undefined;
    let inbound = {};
    let now = Date.now();

    if (peerConnection === undefined || typeof peerConnection?.getStats !== 'function') {
      return this.stats.webrtc;
    }

    if (Number.isFinite(this.stats?.webrtc?.capturedAt) === true && now - this.stats.webrtc.capturedAt < 1000) {
      return this.stats.webrtc;
    }

    try {
      report = await peerConnection.getStats();
      stats = Array.from(report?.values?.() ?? []);
      transport = stats.find((entry) => entry?.type === 'transport');
      candidatePair =
        (typeof transport?.selectedCandidatePairId === 'string' ? report.get(transport.selectedCandidatePairId) : undefined) ??
        stats.find((entry) => entry?.type === 'candidate-pair' && (entry?.nominated === true || entry?.state === 'succeeded'));
      localCandidate = report.get(candidatePair?.localCandidateId);
      remoteCandidate = report.get(candidatePair?.remoteCandidateId);

      for (let entry of stats) {
        if (entry?.type === 'inbound-rtp' && (entry?.kind === 'video' || entry?.kind === 'audio')) {
          inbound[entry.kind] = {
            packets: entry.packetsReceived ?? 0,
            bytes: entry.bytesReceived ?? 0,
            lost: entry.packetsLost ?? 0,
            jitterMs: Number.isFinite(entry.jitter) === true ? Math.round(entry.jitter * 100000) / 100 : undefined,
            nacks: entry.nackCount ?? 0,
            plis: entry.pliCount ?? 0,
          };
        }
      }

      this.stats.webrtc = {
        capturedAt: now,
        iceConnectionState: peerConnection.iceConnectionState,
        dtlsState: transport?.dtlsState,
        candidatePair: {
          state: candidatePair?.state,
          protocol: localCandidate?.protocol ?? remoteCandidate?.protocol,
          localType: localCandidate?.candidateType,
          remoteType: remoteCandidate?.candidateType,
          roundTripTimeMs:
            Number.isFinite(candidatePair?.currentRoundTripTime) === true
              ? Math.round(candidatePair.currentRoundTripTime * 100000) / 100
              : undefined,
          consentExpiredAt: candidatePair?.consentExpiredTimestamp,
        },
        inbound: inbound,
      };
    } catch (error) {
      this?.log?.debug?.('Unable to collect WebRTC stats for uuid "%s": %s', this.uuid, error?.message || String(error));
    }

    return this.stats.webrtc;
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

        // Teardown replaces the talkback state before a new peer can start.
        // A late START response must not send old audio or a deferred STOP to its replacement.
        if (this.#tracks.talkback !== talk) {
          return;
        }

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

      this.#tracks.video.rtp = { lastSequence: undefined };
      this.#tracks.video.clock = { rtpTimestamp: undefined, timestamp: undefined, lastTimestamp: undefined, report: undefined };
      this.#tracks.video.ssrc = undefined;
      this.#clockSynchronized = false;
      this.#tracks.video.deltaAudit = { hasAcceptedKeyframe: false };
      this.#tracks.video.h264 = { lastSPS: undefined, lastPPS: undefined };

      if (typeof this.#tracks.video.jitter === 'object' && this.#tracks.video.jitter !== null) {
        this.clearJitterBuffer(this.#tracks.video.jitter);
      }

      // Start bounded startup keyframe requests. The first call may happen
      // before the RTP SSRC is known, so retries continue until the first IDR.
      this.#startStartupKeyframeTimer();
      this.#requestVideoKeyframe();

      this.#refreshStallTimer();
      return;
    }

    if (mediaType === Streamer.MEDIA_TYPE.AUDIO) {
      this.#ensurePlaybackAudioTrack();
      clearTimeout(this.#audioJitterTimer);
      this.#audioJitterTimer = undefined;

      this.#tracks.audio.rtp = { lastSequence: undefined };
      this.#tracks.audio.clock = { rtpTimestamp: undefined, timestamp: undefined, lastTimestamp: undefined, report: undefined };
      this.#tracks.audio.ssrc = undefined;
      this.#clockSynchronized = false;

      if (typeof this.#tracks.audio.jitter === 'object' && this.#tracks.audio.jitter !== null) {
        this.clearJitterBuffer(this.#tracks.audio.jitter);
      }

      this.#refreshStallTimer();
    }
  }

  #handleSenderReport(mediaType, packet) {
    let track = this.#tracks[mediaType];
    // Receiver callbacks also carry RR and feedback packets. Only an SR from
    // this track's sender describes the relationship between RTP and NTP time.
    if (
      this.#clockSynchronized === true ||
      packet?.type !== 200 ||
      Number.isInteger(packet.ssrc) !== true ||
      (track.ssrc !== undefined && packet.ssrc !== track.ssrc) ||
      typeof packet.senderInfo?.ntpTimestamp !== 'bigint' ||
      packet.senderInfo.ntpTimestamp <= 0n ||
      Number.isInteger(packet.senderInfo.rtpTimestamp) !== true
    ) {
      return;
    }
    track.clock.report = { ssrc: packet.ssrc, ntpTimestamp: packet.senderInfo.ntpTimestamp, rtpTimestamp: packet.senderInfo.rtpTimestamp };
    this.#synchronizePlaybackClocks();
  }

  #synchronizePlaybackClocks() {
    let tracks = [this.#tracks.video, this.#tracks.audio];
    if (
      this.#clockSynchronized === true ||
      tracks.some((track) => track.clock?.report === undefined || (track.ssrc !== undefined && track.clock.report.ssrc !== track.ssrc))
    ) {
      return;
    }
    if (tracks.every((track) => track.clock.timestamp === undefined)) {
      return;
    }

    // Subtract NTP values before converting to Number to retain fractional
    // precision. Reports can refer to different instants and random RTP origins.
    let ntpOrigin = tracks[0].clock.report.ntpTimestamp;
    let sourceTimes = tracks.map((track) => {
      let clock = track.clock;
      return (
        (Number(clock.report.ntpTimestamp - ntpOrigin) * 1000) / 0x100000000 +
        ((((clock.rtpTimestamp ?? clock.report.rtpTimestamp) - clock.report.rtpTimestamp) | 0) * 1000) / track.sampleRate
      );
    });
    let localOrigin = Math.max(
      ...tracks.map((track, index) =>
        track.clock.timestamp === undefined ? Number.NEGATIVE_INFINITY : track.clock.timestamp - sourceTimes[index],
      ),
    );

    // Late reports replace arrival-based estimates for both tracks together.
    // Choose one translation that never rewinds either emitted track. A one-time
    // forward gap is preferable to rewriting retained media or shifting tracks independently.
    for (let index = 0; index < tracks.length; index++) {
      // Early paired reports can seed an unseen track directly at its reported
      // RTP position, avoiding an arrival-based offset on its first media frame.
      tracks[index].clock.rtpTimestamp ??= tracks[index].clock.report.rtpTimestamp;
      tracks[index].clock.timestamp = localOrigin + sourceTimes[index];
    }
    this.#clockSynchronized = true;
    this?.log?.debug?.('Synchronized WebRTC source A/V clocks for uuid "%s" using RTCP sender reports', this.uuid);
  }

  #mapPlaybackTimestamp(mediaType, rtpTimestamp, receivedAt) {
    let track = this.#tracks[mediaType];
    let clock = track.clock;
    if (clock.rtpTimestamp === undefined) {
      // Until both sender reports are available, retain arrival anchoring as an
      // estimate. Subsequent timing always follows RTP ticks, including rollover.
      clock.rtpTimestamp = rtpTimestamp;
      clock.timestamp = receivedAt;
      this.#synchronizePlaybackClocks();
    }
    let deltaTicks = (rtpTimestamp - clock.rtpTimestamp) | 0;
    if (deltaTicks === 0 && clock.lastTimestamp !== undefined) {
      return undefined;
    }
    let timestamp = clock.timestamp + (deltaTicks * 1000) / track.sampleRate;
    if (timestamp <= clock.lastTimestamp) {
      return undefined;
    }
    clock.rtpTimestamp = rtpTimestamp;
    clock.timestamp = timestamp;
    clock.lastTimestamp = timestamp;
    return timestamp;
  }

  #ensurePlaybackVideoTrack() {
    // onTrack calls this before subscribing RTP callbacks, so packet handlers
    // can use stable session state without repairing object shapes per packet.
    let video = this.#tracks.video;

    video.id ??= RTP_H264_VIDEO_PAYLOAD_TYPE;
    video.rtxId ??= RTP_H264_VIDEO_RTX_PAYLOAD_TYPE;
    video.codec ??= StreamTransport.CODEC_TYPE.H264;
    video.sampleRate ??= 90000;
    video.keyframeRequestInFlight ??= false;
    video.rtp ??= { lastSequence: undefined };
    video.health ??= this.getMediaState('video');
    video.deltaAudit ??= { hasAcceptedKeyframe: false };

    if (typeof video.jitter !== 'object' || video.jitter === null || video.jitter.groupByTimestamp !== true) {
      video.jitter = this.createJitterBuffer({
        groupByTimestamp: true,
        delayMs: VIDEO_RTP_REORDER_DELAY_MS,
        maxPackets: VIDEO_RTP_REORDER_MAX_PACKETS,
      });
    }

    if (typeof video.h264 !== 'object' || video.h264 === null) {
      video.h264 = { lastSPS: undefined, lastPPS: undefined };
    }

    return video;
  }

  #ensurePlaybackAudioTrack() {
    // Audio follows the same onTrack-before-packets invariant as video.
    let audio = this.#tracks.audio;

    audio.id ??= RTP_OPUS_AUDIO_PAYLOAD_TYPE;
    audio.codec ??= StreamTransport.CODEC_TYPE.OPUS;
    audio.sampleRate ??= 48000;
    audio.channels ??= 2;
    audio.packetTime ??= 20;
    audio.rtp ??= { lastSequence: undefined };

    if (typeof audio.jitter !== 'object' || audio.jitter === null || audio.jitter.groupByTimestamp === true) {
      audio.jitter = this.createJitterBuffer({
        delayMs: AUDIO_RTP_REORDER_DELAY_MS,
        maxPackets: AUDIO_RTP_REORDER_MAX_PACKETS,
      });
    }

    return audio;
  }

  #keyframeByteLimit() {
    let spsInfo = H264.getSPSInfo(this.#tracks?.video?.h264?.lastSPS);
    let width = this.video?.width ?? spsInfo?.width ?? 0;
    let height = this.video?.height ?? spsInfo?.height ?? 0;
    let bitrate = Number.isFinite(this.video?.bitrate) === true ? this.video.bitrate : 0;

    // The first startup keyframe may arrive before StreamTransport has learned
    // resolution metadata. Use its cached SPS when available so
    // high-resolution startup frames receive the same adaptive allowance.
    return Math.min(
      KEYFRAME_MAX_BYTES,
      Math.max(KEYFRAME_DEFAULT_BYTES, width * height * KEYFRAME_BYTES_PER_PIXEL, (bitrate * KEYFRAME_BITRATE_SECONDS) / 8),
    );
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

        return H264.isTimestampGroupComplete(entry, this.sortJitterGroupPackets(jitter, entry));
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

      if (H264.isTimestampGroupComplete(group, this.sortJitterGroupPackets(jitter, group)) !== true) {
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

          this.#requestVideoRecovery('jitter-keyframe-incomplete');
          // releaseJitterGroups already removed only the failed timestamp.
          // Keep later groups: one may contain the complete recovery keyframe,
          // whereas clearing them here can turn one damaged IDR into a long gap.
          continue;
        }

        continue;
      }

      jitter.lastReleasedSequence = group.packets.at(-1).sequenceNumber;
      this.#assemblePlaybackVideoGroup(group);
      jitter.lastReleasedTimestamp = group.rtpTimestamp;
    }

    if (force !== true && this.sizeJitterBuffer(jitter) > 0) {
      this.recordVideoReorder('defers');
    }
  }

  #appendH264NalUnit(frame, nal) {
    let type = nal[0] & 0x1f;
    let part = H264.wrapAnnexB(nal);

    frame.parts.push(part);
    frame.bytes += part.length;
    frame.keyFrame = frame.keyFrame === true || type === H264.NALUS.TYPES.IDR;
    frame.hasVcl = frame.hasVcl === true || type === H264.NALUS.TYPES.IDR || type === H264.NALUS.TYPES.SLICE_NON_IDR;

    // Parameter sets survive individual groups so an IDR can initialise a new
    // consumer even when the camera does not repeat SPS/PPS with that frame.
    if (type === H264.NALUS.TYPES.SPS) {
      this.#tracks.video.h264.lastSPS = Buffer.from(nal);
    }
    if (type === H264.NALUS.TYPES.PPS) {
      this.#tracks.video.h264.lastPPS = Buffer.from(nal);
    }
  }

  #handlePlaybackVideoPacket(rtpPacket) {
    if (this.closing === true || this.closed === true) {
      return;
    }

    // Validate the source once before filtering and retaining its packet. The
    // assembler receives only ordered, complete groups of primary H264 packets.
    if (
      typeof rtpPacket?.header !== 'object' ||
      rtpPacket.header === null ||
      Buffer.isBuffer(rtpPacket?.payload) !== true ||
      rtpPacket.payload.length === 0
    ) {
      return;
    }

    let header = rtpPacket.header;
    let payload = rtpPacket.payload;
    let marker = header.marker === true;
    let sequenceNumber = Number.isInteger(header.sequenceNumber) === true ? header.sequenceNumber : 0;
    let rtpTimestamp = Number.isInteger(header.timestamp) === true ? header.timestamp >>> 0 : 0;
    let payloadType = Number.isInteger(header.payloadType) === true ? header.payloadType : undefined;
    let ssrc = Number.isInteger(header.ssrc) === true ? header.ssrc >>> 0 : undefined;
    let packetReceivedAt = Number.isFinite(rtpPacket.receivedAt) === true ? rtpPacket.receivedAt : Date.now();
    let video = this.#tracks.video;
    let jitter = video.jitter;
    let payloadInfo = undefined;
    let queueSequenceNumber = 0;
    let learnedPrimarySsrc = false;
    let isRtxPacket = typeof payloadType === 'number' && payloadType === video.rtxId;

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
      learnedPrimarySsrc = true;
    }

    if (typeof video.ssrc === 'number' && typeof ssrc === 'number' && ssrc !== video.ssrc) {
      return;
    }

    payloadInfo = H264.getPayloadInfo(payload);

    if (learnedPrimarySsrc === true && this.ready !== true && payloadInfo.hasKeyFrame !== true) {
      this.#requestVideoKeyframe();
    }

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
  }

  #assemblePlaybackVideoGroup(group) {
    let video = this.#tracks.video;
    let frame = { parts: [], bytes: 0, keyFrame: false, hasVcl: false };
    let fragments = {};
    let failure = undefined;
    let sequenceDelta = 0;

    // Jitter already sorts and deduplicates packets within each group. Retain
    // the cross-group sequence check so old retransmissions cannot move playback backwards.
    if (typeof video.rtp.lastSequence === 'number') {
      sequenceDelta = (group.packets[0].sequenceNumber - video.rtp.lastSequence + RTP_SEQUENCE_WRAP) % RTP_SEQUENCE_WRAP;
      if (sequenceDelta === 0 || sequenceDelta > RTP_SEQUENCE_WRAP / 2) {
        return;
      }
    }
    video.rtp.lastSequence = group.packets.at(-1).sequenceNumber;
    this.#refreshStallTimer();
    H264.resetFragmentState(fragments);

    // All reconstruction state belongs to this timestamp. A failed group can
    // never leave partial NALs attached to its successor or a replacement source.
    for (let item of group.packets) {
      let payload = item.packet.payload;
      let nalType = payload[0] & 0x1f;

      if (fragments.fuParts.length > 0 && nalType !== H264.NALUS.TYPES.FU_A) {
        failure = 'fu-incomplete';
        break;
      }

      if (nalType > 0 && nalType < 24) {
        this.#appendH264NalUnit(frame, payload);
      } else if (nalType === H264.NALUS.TYPES.STAP_A) {
        let offset = 1;
        while (offset + 2 <= payload.length) {
          let length = payload.readUInt16BE(offset);
          offset += 2;
          if (length === 0 || offset + length > payload.length) {
            failure = 'stap-a-invalid';
            break;
          }
          this.#appendH264NalUnit(frame, payload.subarray(offset, offset + length));
          offset += length;
        }
        if (failure !== undefined || offset !== payload.length) {
          failure = 'stap-a-invalid';
          break;
        }
      } else if (nalType === H264.NALUS.TYPES.FU_A) {
        let result = H264.acceptFuA(fragments, payload, {
          sequenceNumber: item.sequenceNumber,
          rtpTimestamp: group.rtpTimestamp,
          receivedAt: item.receivedAt,
          sequenceMask: RTP_SEQUENCE_MASK,
        });
        // Aggregate group flags cannot validate every NAL when a frame contains
        // multiple fragment chains. Keep the byte-level sequence and boundary checks.
        if (result.ok !== true || result.interrupted === true) {
          failure = 'fu-incomplete';
          break;
        }
        if (result.complete === true) {
          frame.parts.push(result.data);
          frame.bytes += result.bytes;
          frame.keyFrame = frame.keyFrame === true || result.nalType === H264.NALUS.TYPES.IDR;
          frame.hasVcl =
            frame.hasVcl === true || result.nalType === H264.NALUS.TYPES.IDR || result.nalType === H264.NALUS.TYPES.SLICE_NON_IDR;
        }
      } else {
        failure = 'unsupported-nal';
        break;
      }
    }

    if (fragments.fuParts.length > 0) {
      failure ??= 'fu-incomplete';
    }
    if (failure !== undefined) {
      this.recordVideoDrop(failure);
      this?.log?.debug?.(
        'Dropping invalid WebRTC timestamp group for uuid "%s": rtpTs="%s" reason="%s"',
        this.uuid,
        group.rtpTimestamp,
        failure,
      );
      if (group.hasKeyFrame === true) {
        this.#requestVideoRecovery(failure);
      }
      return;
    }

    this.#emitPlaybackVideoFrame(group, frame);
  }

  #emitPlaybackVideoFrame(group, frame) {
    let video = this.#tracks.video;
    let h264 = video.h264;
    let deltaAudit = video.deltaAudit;
    let pendingRtpTimestamp = group.rtpTimestamp;
    // Keep the existing source-clock anchor: the first packet in sequence
    // order, rather than an end fragment that happened to arrive ahead of it.
    let pendingFirstPacketTime = group.packets[0].receivedAt;
    let pendingKeyFrame = frame.keyFrame;
    let pendingTimestamp = undefined;
    let now = Date.now();
    let deltaTicks = 0;
    let recoveringDeltaProbe = false;

    if (frame.hasVcl !== true) {
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
        frame.bytes,
        pendingRtpTimestamp,
      );

      return;
    }

    // Reject known unusable frames before allocating their combined access unit.
    // Delta frames do not need keyframe limits or another SPS parse.
    let keyframeByteLimit = pendingKeyFrame === true ? this.#keyframeByteLimit() : undefined;
    if (pendingKeyFrame === true && frame.bytes > keyframeByteLimit) {
      this.recordVideoDrop('oversized-keyframe');
      this.#requestVideoRecovery('oversized-keyframe');
      return;
    }
    let accessUnit = H264.buildAccessUnit(frame.parts, {
      keyFrame: pendingKeyFrame,
      sps: h264.lastSPS,
      pps: h264.lastPPS,
    });
    let data = accessUnit?.data;
    let keyframeHasParameterSets = pendingKeyFrame === true && accessUnit?.hasParameterSets === true;
    if (Buffer.isBuffer(data) !== true || data.length === 0) {
      return;
    }

    // A complete IDR remains usable after slow delivery. Validate decoder
    // configuration and size here; incomplete-frame expiry belongs to jitter release.
    if (pendingKeyFrame === true) {
      if (keyframeHasParameterSets !== true || data.length > keyframeByteLimit) {
        this.recordVideoDrop('invalid-keyframe');

        this?.log?.debug?.(
          'Dropping invalid keyframe for uuid "%s": rtpTs=%s bytes=%s hasParameterSets=%s limitBytes=%s',
          this.uuid,
          pendingRtpTimestamp,
          data.length,
          keyframeHasParameterSets === true ? 'true' : 'false',
          keyframeByteLimit,
        );

        this.#requestVideoRecovery('invalid-keyframe');
        return;
      }
    }

    // Map RTP video time onto source media time without output pacing policy.
    // Source clock validation stays here; Streamer owns retention and delivery pacing.
    if (typeof video.clock.lastTimestamp === 'number') {
      deltaTicks = (pendingRtpTimestamp - video.clock.rtpTimestamp + RTP_TIMESTAMP_MASK) % RTP_TIMESTAMP_MASK;

      if (deltaTicks > RTP_TIMESTAMP_MAX_DELTA) {
        this.recordVideoDrop('backwards-timestamp');

        this?.log?.debug?.(
          'Dropping reordered/backwards WebRTC video frame for uuid "%s": pendingTs="%s" lastTs="%s" deltaTicks="%s"',
          this.uuid,
          pendingRtpTimestamp,
          video.clock.rtpTimestamp,
          deltaTicks,
        );

        return;
      }
    }

    pendingTimestamp = this.#mapPlaybackTimestamp('video', pendingRtpTimestamp, pendingFirstPacketTime ?? now);
    if (pendingTimestamp === undefined) {
      this.recordVideoDrop('non-increasing-timestamp');
      this.#requestVideoRecovery('non-increasing-timestamp');
      return;
    }

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
      timestamp: pendingTimestamp,
      keyFrame: pendingKeyFrame === true,
      codecConfig: {
        sps: h264.lastSPS,
        pps: h264.lastPPS,
        hasSPS: accessUnit?.hasSPS === true,
        hasPPS: accessUnit?.hasPPS === true,
      },
      data: data,
    });

    this.markMediaFrame('video', { keyFrame: pendingKeyFrame === true });
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

      if (now - this.#startupKeyframeStartedAt > STARTUP_KEYFRAME_REQUEST_MAX_MS) {
        this.#stopStartupKeyframeTimer();
        this?.log?.debug?.(
          'Stopped WebRTC startup keyframe requests for uuid "%s" after %sms without accepted keyframe',
          this.uuid,
          STARTUP_KEYFRAME_REQUEST_MAX_MS,
        );
        return;
      }

      this.#requestVideoKeyframe();
    }, STARTUP_KEYFRAME_REQUEST_INTERVAL_MS);
  }

  #stopStartupKeyframeTimer() {
    clearInterval(this.#startupKeyframeTimer);
    this.#startupKeyframeTimer = undefined;
    this.#startupKeyframeStartedAt = undefined;
  }

  #drainPlaybackAudioJitterBuffer() {
    let audio = this.#tracks?.audio;
    let jitter = audio?.jitter;

    if (
      this.closing === true ||
      this.closed === true ||
      typeof audio !== 'object' ||
      audio === null ||
      typeof jitter !== 'object' ||
      jitter === null ||
      jitter.groupByTimestamp === true
    ) {
      return;
    }

    for (let packet of this.releaseJitterPackets(jitter)) {
      this.#handlePlaybackAudioPacket(packet.packet, true);
    }

    // Packet arrivals drain immediately; one pending deadline also releases
    // aged packets during an arrival pause. Reuse the same ordered drain path.
    if (this.#audioJitterTimer === undefined && this.sizeJitterBuffer(jitter) > 0) {
      let first = jitter.queue[0];
      this.#audioJitterTimer = setTimeout(
        () => {
          // A retired track must never drain or replace its successor's timer.
          if (this.#tracks.audio !== audio || this.#closeInProgress === true) {
            return;
          }
          this.#audioJitterTimer = undefined;
          this.#drainPlaybackAudioJitterBuffer();
        },
        Math.max(1, first.receivedAt + jitter.delayMs - Date.now()),
      );
    }
  }

  #handlePlaybackAudioPacket(rtpPacket, fromJitterBuffer = false) {
    if (this.closing === true || this.closed === true) {
      // We are closing or closed, so ignore any incoming packets. This can happen when remote is still sending
      // before we finish tearing down the connection, but we do not want to process any new packets at this point.
      return;
    }

    let delta = 0;
    let deltaTicks = 0;
    let timestamp = undefined;
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

    let audio = this.#tracks.audio;
    let audioRtp = audio.rtp;

    if (typeof audio.ssrc !== 'number' && typeof ssrc === 'number') {
      audio.ssrc = ssrc;
    }
    if (typeof ssrc === 'number' && ssrc !== audio.ssrc) {
      return;
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

      if (delta === 0 || delta > RTP_SEQUENCE_WRAP / 2) {
        return;
      }
    }

    // Reject backwards source time before mapping RTP ticks onto the shared clock.
    // A source reconnect creates fresh anchors instead of repairing packet times.
    if (typeof audio.clock.lastTimestamp === 'number') {
      deltaTicks = (rtpTimestamp - audio.clock.rtpTimestamp + RTP_TIMESTAMP_MASK) % RTP_TIMESTAMP_MASK;

      if (deltaTicks > RTP_TIMESTAMP_MAX_DELTA) {
        return;
      }
    }

    timestamp = this.#mapPlaybackTimestamp('audio', rtpTimestamp, now);
    if (timestamp === undefined) {
      return;
    }

    audioRtp.lastSequence = sequenceNumber;

    this.emitMedia({
      type: Streamer.MEDIA_TYPE.AUDIO,
      codec: this.audio.codec,
      timestamp: timestamp,
      keyFrame: false,
      data: payload,
    });
  }

  #requestVideoRecovery(reason) {
    // A damaged keyframe needs both an upstream replacement request and a
    // health signal so StreamTransport can apply its existing recovery policy.
    this.#requestVideoKeyframe();
    this.markMediaIssue('video', reason);
  }

  #requestVideoKeyframe() {
    let video = this.#tracks?.video;
    let now = Date.now();
    let pliSendResult = undefined;
    let receiver = this.#videoTransceiver?.receiver;

    if (receiver === undefined || video === undefined || typeof video?.ssrc !== 'number') {
      return;
    }

    if (video.keyframeRequestInFlight === true) {
      return;
    }

    if (typeof video.lastKeyframeRequestTime === 'number' && now - video.lastKeyframeRequestTime < STARTUP_KEYFRAME_REQUEST_INTERVAL_MS) {
      return;
    }

    video.lastKeyframeRequestTime = now;
    video.keyframeRequestInFlight = true;
    this.recordKeyframeRequest();

    try {
      pliSendResult = receiver.sendRtcpPLI?.(video.ssrc);

      if (pliSendResult instanceof Promise) {
        pliSendResult
          .catch((error) => {
            this?.log?.debug?.('Error sending WebRTC PLI for uuid "%s": %s', this.uuid, String(error));
          })
          .finally(() => {
            if (this.#tracks?.video === video) {
              video.keyframeRequestInFlight = false;
            }
          });
      }
    } catch (error) {
      this?.log?.debug?.('Error sending WebRTC PLI for uuid "%s": %s', this.uuid, String(error));
    }

    if (pliSendResult instanceof Promise === false) {
      video.keyframeRequestInFlight = false;
    }

    if (typeof receiver?.rtcpSsrc !== 'number' || typeof receiver?.dtlsTransport?.sendRtcp !== 'function') {
      return;
    }

    try {
      let firBuffer = Buffer.alloc(16);
      let rembExponent = 0;
      let rembMantissa = VIDEO_REMB_BITRATE;

      firBuffer.writeUInt32BE(receiver.rtcpSsrc >>> 0, 0);
      firBuffer.writeUInt32BE(video.ssrc >>> 0, 4);
      firBuffer.writeUInt32BE(video.ssrc >>> 0, 8);
      firBuffer[12] = this.stats.media.keyframeRequests & 0xff;

      while (rembMantissa > 0x3ffff) {
        rembMantissa = Math.floor(rembMantissa / 2);
        rembExponent++;
      }

      receiver.dtlsTransport
        .sendRtcp([
          new werift.RtcpPayloadSpecificFeedback({
            feedback: {
              count: 4,
              length: firBuffer.length / 4 - 1,
              serialize: () => firBuffer,
            },
          }),
          new werift.RtcpPayloadSpecificFeedback({
            feedback: new werift.ReceiverEstimatedMaxBitrate({
              senderSsrc: receiver.rtcpSsrc,
              mediaSsrc: 0,
              ssrcNum: 1,
              brExp: rembExponent,
              brMantissa: rembMantissa,
              ssrcFeedbacks: [video.ssrc],
            }),
          }),
        ])
        .catch((error) => {
          this?.log?.debug?.('Error sending WebRTC FIR/REMB for uuid "%s": %s', this.uuid, String(error));
        });
    } catch (error) {
      this?.log?.debug?.('Error building WebRTC FIR/REMB for uuid "%s": %s', this.uuid, String(error));
    }
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
