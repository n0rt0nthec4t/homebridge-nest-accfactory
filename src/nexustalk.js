// NexusTalk
// Part of homebridge-nest-accfactory
//
// Protocol-specific streaming transport for Nest legacy "Nexus" backend systems.
//
// Manages bidirectional media transport over secure TLS connections using
// Nest's proprietary protobuf-based NexusTalk protocol.
//
// NexusTalk owns:
// - TLS connection/session lifecycle
// - Nexus authentication and authorisation
// - Protobuf message framing and parsing
// - Playback session control
// - H264 video access-unit assembly
// - AAC audio frame handling
// - Speex talkback/audio send handling
// - Redirect, reconnect, stall, host-change, and backend-closure recovery
// - Queued outbound control messages while socket/auth state is unavailable
// - Transport-level runtime updates for auth, host, and device availability
//
// NexusTalk receives normalised transport options from the parent camera device
// and emits complete media frames plus transport state transitions to the
// configured media consumer. It does not own device raw-data processing,
// buffering, output pacing, HomeKit live/record sessions, fallback frames,
// or ffmpeg process handling.
//
// Features:
// - TLS-encrypted Nexus backend connection management
// - Shared protobuf schema/type caching via protobuf.js helper module
// - Protobuf message serialization for proprietary NexusTalk protocol
// - Multiplexed media and control messages over a single connection
// - Buffered outbound control-message queue using RingBuffer
// - H264 video access-unit assembly before media emission
// - AAC audio frame emission with Nexus-derived media timing
// - Two-way audio/talkback support via Speex
// - Buffered packet parsing with bounded memory protection
//
// Notes:
// - Video is delivered as H264 NAL units and assembled into complete Annex-B access units before emission
// - Audio is delivered as AAC frames and emitted directly
// - Emitted timestamps are source media timeline values; Streamer owns output playout timing
// - Protobuf schemas and message types are shared/cached globally to avoid repeated protobufjs parsing across multiple camera instances
//
// Note: Based on foundational work from https://github.com/Brandawg93/homebridge-nest-cam
//
// Code version 2026.05.13
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { Buffer } from 'node:buffer';
import { setInterval, clearInterval } from 'node:timers';
import path from 'node:path';
import tls from 'tls';
import crypto from 'crypto';

// Define our modules
import Streamer from './streamer.js';
import StreamTransport from './streamtransport.js';
import RingBuffer from './ringbuffer.js';
import { getProtoType } from './protobuf.js';

// Define constants
import { USER_AGENT, __dirname } from './consts.js';

const PING_INTERVAL = 15000; // Ping interval to nexus server while stream active
const STALLED_TIMEOUT = 10000; // Time with no playback packets received before we consider stream stalled and attempt restart
const PENDING_MESSAGE_QUEUE_CAPACITY = 64; // Initial slot count for pending outbound control messages
const MAX_PENDING_MESSAGES = 256; // Hard cap for queued outbound control messages while unauthorised/disconnected
const INITIAL_PACKET_BUFFER_SIZE = 256 * 1024;
const MAX_PACKET_BUFFER_SIZE = 10 * 1024 * 1024;
const MAX_PACKET_PAYLOAD_SIZE = 5 * 1024 * 1024;

const MEDIA_TYPE = {
  PING: 1,
  HELLO: 100,
  PING_CAMERA: 101,
  AUDIO_PAYLOAD: 102,
  START_PLAYBACK: 103,
  STOP_PLAYBACK: 104,
  CLOCK_SYNC_ECHO: 105,
  LATENCY_MEASURE: 106,
  TALKBACK_LATENCY: 107,
  METADATA_REQUEST: 108,
  OK: 200,
  ERROR: 201,
  PLAYBACK_BEGIN: 202,
  PLAYBACK_END: 203,
  PLAYBACK_PACKET: 204,
  LONG_PLAYBACK_PACKET: 205,
  CLOCK_SYNC: 206,
  REDIRECT: 207,
  TALKBACK_BEGIN: 208,
  TALKBACK_END: 209,
  METADATA: 210,
  METADATA_ERROR: 211,
  AUTHORIZE_REQUEST: 212,
};

// Blank audio in AAC format, mono channel @48000
const AAC_MONO_48000_BLANK = Buffer.from([
  0xff, 0xf1, 0x4c, 0x40, 0x03, 0x9f, 0xfc, 0xde, 0x02, 0x00, 0x4c, 0x61, 0x76, 0x63, 0x35, 0x39, 0x2e, 0x31, 0x38, 0x2e, 0x31, 0x30, 0x30,
  0x00, 0x02, 0x30, 0x40, 0x0e,
]);

const MAX_PENDING_VIDEO_PARTS = 200;
const MAX_PENDING_VIDEO_BYTES = 4 * 1024 * 1024;

// nexusTalk object
export default class NexusTalk extends StreamTransport {
  nexustalk_host = undefined; // Main nexustalk streaming host
  token = undefined;
  useGoogleAuth = false; // Nest vs google auth

  // Internal data only for this class
  #protobufTypes = {
    AudioPayload: undefined,
    StartPlayback: undefined,
    StopPlayback: undefined,
    AuthoriseRequest: undefined,
    Hello: undefined,
    Redirect: undefined,
    PlaybackBegin: undefined,
    PlaybackPacket: undefined,
    PlaybackEnd: undefined,
    Error: undefined,
  };

  #socket = undefined; // TCP socket object
  #packetBuffer = undefined; // Incoming packet buffer
  #packetOffset = undefined; // Current offset in packet buffer
  #packetReadIndex = 0; // Current read offset for packet parsing loop
  // Pending outbound control messages while socket is unavailable/unauthorised
  #messages = new RingBuffer(0, PENDING_MESSAGE_QUEUE_CAPACITY, PENDING_MESSAGE_QUEUE_CAPACITY * 4);
  #authorised = false; // Have we been authorised
  #sessionId = undefined; // Session ID
  #host = undefined; // Current host connected to
  #pingTimer = undefined; // Timer object for ping interval
  #stalledTimer = undefined; // Interval object for no received data checks
  #lastPacketAt = undefined; // Last playback packet receipt time in ms
  #reconnectPending = false; // Reconnect requested once socket closes
  #reconnectHost = undefined; // Host to reconnect to
  #reconnectReason = undefined; // Reason for reconnect
  #sessionStartTime = undefined; // Shared session time anchor in ms for all playback channels
  #channels = {
    video: {
      id: undefined,
      startOffset: 0,
      mediaTime: undefined,
      lastEmittedTimestamp: undefined,
      pendingTimestamp: undefined,
      pendingKeyFrame: false,
      pendingParts: [],
      pendingBytes: 0,
    },
    audio: {
      id: undefined,
      startOffset: 0,
      mediaTime: undefined,
    },
  };

  #talkback = {
    active: false,
    lastPacketTime: undefined,
  };

  constructor(options = {}) {
    super(options);

    let protoPath = path.join(__dirname, 'protobuf/nest/nexustalk.proto');

    // Cache protobuf message types up front so we avoid repeated lookup()
    // calls during connect, control messaging, and packet handling paths.
    // Types are shared globally via protobuf.js helper caching.
    this.#protobufTypes.AudioPayload = getProtoType(protoPath, 'nest.nexustalk.v1.AudioPayload', this.log);
    this.#protobufTypes.StartPlayback = getProtoType(protoPath, 'nest.nexustalk.v1.StartPlayback', this.log);
    this.#protobufTypes.StopPlayback = getProtoType(protoPath, 'nest.nexustalk.v1.StopPlayback', this.log);
    this.#protobufTypes.AuthoriseRequest = getProtoType(protoPath, 'nest.nexustalk.v1.AuthoriseRequest', this.log);
    this.#protobufTypes.Hello = getProtoType(protoPath, 'nest.nexustalk.v1.Hello', this.log);
    this.#protobufTypes.Redirect = getProtoType(protoPath, 'nest.nexustalk.v1.Redirect', this.log);
    this.#protobufTypes.PlaybackBegin = getProtoType(protoPath, 'nest.nexustalk.v1.PlaybackBegin', this.log);
    this.#protobufTypes.PlaybackPacket = getProtoType(protoPath, 'nest.nexustalk.v1.PlaybackPacket', this.log);
    this.#protobufTypes.PlaybackEnd = getProtoType(protoPath, 'nest.nexustalk.v1.PlaybackEnd', this.log);
    this.#protobufTypes.Error = getProtoType(protoPath, 'nest.nexustalk.v1.Error', this.log);

    // Setup initial codec profiles based on device data, with Nexus defaults as fallback.
    this.video = {
      codec: StreamTransport.CODEC_TYPE.H264,
      profile: undefined,
      clockRate: undefined,
      width: undefined,
      height: undefined,
      fps: undefined,
      bitrate: undefined,
    };

    this.audio = {
      codec: StreamTransport.CODEC_TYPE.AAC,
      profile: undefined,
      sampleRate: undefined,
      channels: 1,
      bitrate: undefined,
      blank: AAC_MONO_48000_BLANK,
    };

    this.talkback = {
      codec: StreamTransport.CODEC_TYPE.SPEEX,
      sampleRate: 16000,
      channels: 1,
    };

    this.update(options);
  }

  // Class functions
  async open(options = {}) {
    let connectHost = typeof options?.host === 'string' && options.host !== '' ? options.host : this.nexustalk_host;

    if (typeof connectHost !== 'string' || connectHost === '') {
      this.setState(StreamTransport.STATE.CLOSED, 'host-missing');
      return;
    }

    if (this.#socket !== undefined && this.#socket.destroyed === false) {
      // Existing socket is still opening/open, avoid duplicate concurrent connects.
      return;
    }

    clearInterval(this.#pingTimer);
    this.#stopStalledMonitor();
    this.#pingTimer = undefined;
    this.#sessionId = undefined; // No session ID yet
    this.#authorised = false;
    this.#resetPacketState(true);

    this?.log?.debug?.('Connection started to "%s"', connectHost);
    this.#host = connectHost; // Update internal host name since we’re about to connect
    this.setState(StreamTransport.STATE.CONNECTING);

    // Wrap tls.connect() in a Promise so we can await the TLS handshake
    try {
      await new Promise((resolve, reject) => {
        let socket = tls.connect({ host: connectHost, port: 1443 }, () => {
          if (this.#socket !== socket) {
            resolve();
            return;
          }

          // Opened connection to Nexus server, so now need to authenticate ourselves
          this?.log?.debug?.('Connection established to "%s"', connectHost);
          this.setState(StreamTransport.STATE.CONNECTED);

          socket.setKeepAlive(true); // Keep socket connection alive
          this.#authenticate(false); // Send authentication request
          resolve(); // Allow await connect() to continue
        });
        this.#socket = socket;

        socket.on('error', (error) => {
          if (this.#socket !== socket) {
            return;
          }

          // TLS error (could be refused, timeout, etc.)
          this?.log?.warn?.('TLS error on connect to "%s": %s', connectHost, String(error));
          this.#authorised = false; // Since we had an error, we can't be authorised
          reject(error);
        });

        socket.on('end', () => {
          // Do nothing
        });

        socket.on('data', (data) => {
          if (this.#socket !== socket) {
            return;
          }

          this.#handleNexusData(data);
        });

        socket.on('close', () => {
          if (this.#socket !== socket) {
            return;
          }

          clearInterval(this.#pingTimer);
          this.#stopStalledMonitor();
          this.#pingTimer = undefined;
          this.#authorised = false; // Since connection closed, we can't be authorised anymore
          this.#socket = undefined; // Clear socket object
          this.#sessionId = undefined; // Not an active session anymore
          this.#host = undefined;

          if (this.hasConsumers() === true && this.#reconnectPending !== true && this.closing !== true) {
            this.#requestReconnect(connectHost, 'service-close');
          }

          if (this.#reconnectPending === true && this.hasConsumers() === true) {
            let reconnectHost = this.#reconnectHost;
            let reconnectReason = this.#reconnectReason;

            this.#reconnectPending = false;
            this.#reconnectHost = undefined;
            this.#reconnectReason = undefined;

            if (typeof reconnectHost === 'string' && reconnectHost !== '') {
              this?.log?.debug?.(
                'Connection closed to "%s", %s to "%s"',
                connectHost,
                reconnectReason === 'redirect' ? 'redirecting' : 'attempting reconnection',
                reconnectHost,
              );

              this.open({ host: reconnectHost, forceReconnect: true }).catch((error) => {
                this?.log?.debug?.('Error reconnecting NexusTalk for uuid "%s": %s', this.uuid, String(error));
                this.setState(StreamTransport.STATE.CLOSED, 'reconnect-failed');
              });
              return;
            }
          }

          this?.log?.debug?.('Connection closed to "%s"', connectHost);
          this.setState(StreamTransport.STATE.CLOSED, 'socket-close');
        });
      });
    } catch (error) {
      this?.log?.error?.('Failed to connect to "%s": %s', connectHost, String(error));

      if (this.#socket === undefined && this.hasConsumers() === true) {
        this.#requestReconnect(connectHost, 'connect-failed');
        this.open({ host: this.#reconnectHost }).catch((connectError) => {
          this?.log?.debug?.('Error reconnecting NexusTalk for uuid "%s": %s', this.uuid, String(connectError));
          this.setState(StreamTransport.STATE.CLOSED, 'reconnect-failed');
        });
        return;
      }

      this.setState(StreamTransport.STATE.CLOSED, 'connect-failed');
    }
  }

  async close(stopStreamFirst = true) {
    let reconnecting = this.#reconnectPending === true;
    let hadSocket = this.#socket !== undefined;

    // Close an authenticated socket stream gracefully.
    // Clear any running timers before closing socket to prevent race conditions.
    clearInterval(this.#pingTimer);
    this.#stopStalledMonitor();
    this.#pingTimer = undefined;

    if (this.#socket !== undefined) {
      let socket = this.#socket;

      if (stopStreamFirst === true) {
        await this.#stopNexusData();
      }

      try {
        socket.destroy();
      } catch {
        // Empty
      }
    }

    if (reconnecting !== true) {
      // Do not emit CLOSED here when a socket exists.
      // The terminal closed state is owned by the socket 'close' handler.
      // For reconnect/redirect paths we keep the state as RECONNECTING
      // until the next connect attempt begins.
      this.setState(StreamTransport.STATE.CLOSING);

      // Flush any final pending NexusTalk video frame before resetting channel state.
      // Do not do this during reconnect, otherwise the final frame from the old session
      // can repopulate Streamer timing state just before the new session starts.
      this.#flushPendingVideo(this.#channels.video);

      this.#clearMessageQueue(0);

      if (hadSocket !== true) {
        this.setState(StreamTransport.STATE.CLOSED, 'closed');
      }
    }

    // Always reset channel/session state.
    this.#resetChannelDetails();

    this.#sessionId = undefined; // Not an active session anymore
    this.#resetPacketState(true);
  }

  async update(options = {}) {
    let newToken = undefined;
    let newHost = undefined;
    let newUuid = undefined;
    let newGoogleAuth = undefined;
    let hadToken = typeof this.token === 'string' && this.token !== '';
    let hadHost = typeof this.nexustalk_host === 'string' && this.nexustalk_host !== '';

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
    //   host,
    //   apiAccess
    // }
    //
    // NexusTalk derives:
    // - token from apiAccess.token
    // - Google auth mode from apiAccess.oauth2 presence
    newUuid = typeof options?.uuid === 'string' && options.uuid !== '' ? options.uuid : undefined;
    newHost = typeof options?.host === 'string' && options.host !== '' ? options.host : undefined;
    newToken = typeof options?.apiAccess?.token === 'string' && options.apiAccess.token !== '' ? options.apiAccess.token : undefined;
    newGoogleAuth = typeof options?.apiAccess?.oauth2 === 'string' && options.apiAccess.oauth2 !== '';

    // Update device UUID if supplied.
    // Used for logging, reconnects and transport identity.
    if (typeof newUuid === 'string') {
      this.uuid = newUuid;
    }

    // Update access token if changed.
    // Active sessions continue until reconnect; new requests use the updated token.
    if (typeof newToken === 'string' && newToken !== this.token) {
      if (hadToken === true && this.hasConsumers() === true) {
        this?.log?.debug?.('Access token has changed for uuid "%s" while NexusTalk session is active. Updating stored token.', this.uuid);
      }

      this.token = newToken;
    }

    // Update authentication mode.
    // Google OAuth availability determines whether Google auth is used.
    if (this.useGoogleAuth !== newGoogleAuth) {
      this.useGoogleAuth = newGoogleAuth;
    }

    // Host changes require reconnecting the active NexusTalk session.
    // Existing sockets cannot migrate between hosts safely.
    if (typeof newHost === 'string' && newHost !== this.nexustalk_host) {
      if (hadHost === true) {
        this?.log?.debug?.(
          'NexusTalk host has changed for uuid "%s" from "%s" to "%s"%s',
          this.uuid,
          this.nexustalk_host,
          newHost,
          this.hasConsumers() === true ? '. Reconnecting active session.' : '',
        );
      }

      this.nexustalk_host = newHost;

      // Force reconnect when consumers are active.
      // Avoid duplicate reconnect requests if one is already pending.
      if (hadHost === true && this.hasConsumers() === true && this.#reconnectPending !== true) {
        this.#requestReconnect(newHost, 'host-update');

        await this.close().catch((error) => {
          this?.log?.debug?.('Error closing NexusTalk for uuid "%s": %s', this.uuid, String(error));
        });
      }
    }
  }

  sendAudio(talkingBuffer) {
    let AudioPayload = undefined;
    let encodedData = undefined;

    if (Buffer.isBuffer(talkingBuffer) !== true || this.#sessionId === undefined) {
      return;
    }

    AudioPayload = this.#protobufTypes.AudioPayload;
    if (AudioPayload === undefined || AudioPayload === null) {
      return;
    }

    try {
      encodedData = AudioPayload.encode(
        AudioPayload.fromObject({
          payload: talkingBuffer,
          sessionId: this.#sessionId,
          codec: this.talkback.codec,
          sampleRate: this.talkback.sampleRate,
        }),
      ).finish();
    } catch (error) {
      this?.log?.debug?.('AudioPayload encode failed for uuid "%s": %s', this.uuid, String(error));
      return;
    }

    this.#talkback.lastPacketTime = Date.now();
    this.#sendMessage(MEDIA_TYPE.AUDIO_PAYLOAD, encodedData);
  }

  #startNexusData() {
    // Setup streaming profiles
    // We'll use the highest profile as the main, with others for fallback
    let otherProfiles = ['VIDEO_H264_530KBIT_L31', 'VIDEO_H264_100KBIT_L30'];

    // Include AAC profile for audio
    otherProfiles.push('AUDIO_AAC');

    let StartPlayback = this.#protobufTypes.StartPlayback;
    if (StartPlayback === undefined || StartPlayback === null) {
      return;
    }

    let encodedData = null;

    try {
      encodedData = StartPlayback.encode(
        StartPlayback.fromObject({
          sessionId: Math.floor(Math.random() * 1000000), // larger range to reduce collisions
          profile: 'VIDEO_H264_2MBIT_L40',
          otherProfiles: otherProfiles,
          profileNotFoundAction: 'REDIRECT',
        }),
      ).finish();
    } catch (error) {
      this?.log?.debug?.('StartPlayback encode failed for uuid "%s": %s', this.uuid, String(error));
      return;
    }

    this.#sendMessage(MEDIA_TYPE.START_PLAYBACK, encodedData);
  }

  #stopNexusData() {
    if (this.#sessionId === undefined) {
      return;
    }

    let StopPlayback = this.#protobufTypes.StopPlayback;
    if (StopPlayback === undefined || StopPlayback === null) {
      return;
    }

    let encodedData = null;
    try {
      encodedData = StopPlayback.encode(
        StopPlayback.fromObject({
          sessionId: this.#sessionId,
        }),
      ).finish();
    } catch (error) {
      this?.log?.debug?.('StopPlayback encode failed for uuid "%s": %s', this.uuid, String(error));
      return;
    }

    this.#sendMessage(MEDIA_TYPE.STOP_PLAYBACK, encodedData);
  }

  #sendNow(type, data) {
    let header = undefined;

    // Raw socket send path for already-connected / already-authorised messages.
    // This bypasses queue logic and is used by both direct sends and queued flushes.
    if (Buffer.isBuffer(data) !== true || this.#canWrite() !== true) {
      return false;
    }

    if (type === MEDIA_TYPE.LONG_PLAYBACK_PACKET) {
      header = Buffer.alloc(5);
      header.writeUInt8(type, 0);
      header.writeUInt32BE(data.length, 1);
    } else {
      header = Buffer.alloc(3);
      header.writeUInt8(type, 0);
      header.writeUInt16BE(data.length, 1);
    }

    // Write composed message to NexusTalk without concatenating buffers.
    this.#socket.cork();
    try {
      this.#socket.write(header);
      this.#socket.write(data);
    } finally {
      this.#socket.uncork();
    }

    return true;
  }

  #queueMessage(type, data) {
    // Queue outbound control messages until socket/auth state is ready.
    // Oldest messages are dropped once the hard cap is reached so memory stays bounded.
    if (Buffer.isBuffer(data) !== true) {
      return;
    }

    if (this.#messages instanceof RingBuffer !== true) {
      this.#messages = new RingBuffer(0, PENDING_MESSAGE_QUEUE_CAPACITY);
    }

    if (this.#messages.size >= MAX_PENDING_MESSAGES) {
      this.#messages.shift(1);
      this?.log?.warn?.('Dropped oldest pending NexusTalk message for uuid "%s" as queue is full', this.uuid);
    }

    this.#messages.push({ type: type, data: data });
  }

  #flushQueuedMessages() {
    let queuedMessage = undefined;

    // Drain queued outbound messages using the raw send path.
    // Do not call #sendMessage() from here or messages could be re-queued.
    if (this.#messages instanceof RingBuffer !== true) {
      return;
    }

    while (this.#messages.size > 0) {
      if (this.#canWrite(true) !== true) {
        break;
      }

      queuedMessage = this.#messages.getByOffset(0);

      if (typeof queuedMessage !== 'object' || queuedMessage === null) {
        this.#messages.shift(1);
        continue;
      }

      if (this.#sendNow(queuedMessage.type, queuedMessage.data) !== true) {
        break;
      }

      this.#messages.shift(1);
    }
  }

  #sendMessage(type, data) {
    if (Buffer.isBuffer(data) !== true) {
      return;
    }

    // Bootstrap/auth messages must be allowed before authorisation exists
    if (type === MEDIA_TYPE.HELLO || type === MEDIA_TYPE.AUTHORIZE_REQUEST) {
      if (this.#canWrite() === true) {
        this.#sendNow(type, data);
      }
      return;
    }

    // Normal messages require an authorised writable socket
    if (this.#canWrite(true) !== true) {
      this.#queueMessage(type, data);
      return;
    }

    this.#sendNow(type, data);
  }

  #authenticate(reauthorise) {
    this.#authorised = false; // We're no longer authorised

    let authoriseRequest = null;
    let AuthoriseRequest = this.#protobufTypes.AuthoriseRequest;

    if (AuthoriseRequest === undefined || AuthoriseRequest === null) {
      return;
    }

    try {
      authoriseRequest = AuthoriseRequest.encode(
        AuthoriseRequest.fromObject(this.useGoogleAuth === true ? { oliveToken: this.token } : { sessionToken: this.token }),
      ).finish();
    } catch (error) {
      this?.log?.debug?.('AuthoriseRequest encode failed for uuid "%s": %s', this.uuid, String(error));
      return;
    }

    if (reauthorise === true) {
      if (this.#canWrite() !== true) {
        return;
      }

      this?.log?.debug?.('Re-authentication requested to "%s"', this.#host);
      this.#sendMessage(MEDIA_TYPE.AUTHORIZE_REQUEST, authoriseRequest);
      return;
    }

    // This isn't a re-authorise request, so perform 'Hello' packet
    let Hello = this.#protobufTypes.Hello;
    if (Hello === undefined || Hello === null) {
      return;
    }

    let encodedData = null;
    try {
      encodedData = Hello.encode(
        Hello.fromObject({
          protocolVersion: 'VERSION_3',
          uuid: typeof this.uuid === 'string' && this.uuid.includes('.') === true ? this.uuid.split(/[.]+/)[1] : this.uuid,
          requireConnectedCamera: false,
          userAgent: USER_AGENT,
          deviceId: crypto.randomUUID(),
          clientType: 'IOS',
          authoriseRequest: authoriseRequest,
        }),
      ).finish();
    } catch (error) {
      this?.log?.debug?.('Hello encode failed for uuid "%s": %s', this.uuid, String(error));
      return;
    }

    this?.log?.debug?.('Performing authentication to "%s"', this.#host);
    this.#sendMessage(MEDIA_TYPE.HELLO, encodedData);
  }

  #handleRedirect(payload) {
    let redirectToHost = undefined;

    if (Buffer.isBuffer(payload) === true && this.#protobufTypes.Redirect !== undefined && this.#protobufTypes.Redirect !== null) {
      let decodedMessage = undefined;

      try {
        decodedMessage = this.#protobufTypes.Redirect.decode(payload);
      } catch (error) {
        this?.log?.debug?.('Redirect packet decode failed for uuid "%s": %s', this.uuid, String(error));
        return;
      }

      redirectToHost = decodedMessage?.newHost;
    } else if (typeof payload === 'string' && payload !== '') {
      // Payload parameter is a string, we'll assume this is a direct hostname
      redirectToHost = payload;
    }

    if (typeof redirectToHost !== 'string' || redirectToHost === '') {
      return;
    }

    this?.log?.debug?.('Redirect requested from "%s" to "%s"', this.#host, redirectToHost);
    this.#requestReconnect(redirectToHost, 'redirect');
    this.close().catch((error) => {
      this?.log?.debug?.('Error closing NexusTalk for uuid "%s": %s', this.uuid, String(error));
    });
  }

  #handlePlaybackBegin(payload) {
    let decodedMessage = undefined;
    let now = Date.now();
    let videoStream = undefined;
    let audioStream = undefined;
    let sessionStart = undefined;
    let startDelta = 0;

    if (
      Buffer.isBuffer(payload) !== true ||
      this.#protobufTypes.PlaybackBegin === undefined ||
      this.#protobufTypes.PlaybackBegin === null
    ) {
      return;
    }

    if (this.closing === true || this.closed === true) {
      // We received a PlaybackBegin message but we're already closing/closed
      // so ignore this message since we're not going to be able to do anything with it.
      return;
    }

    try {
      decodedMessage = this.#protobufTypes.PlaybackBegin.decode(payload).toJSON();
    } catch (error) {
      this?.log?.debug?.('PlaybackBegin decode failed for uuid "%s": %s', this.uuid, String(error));
      return;
    }

    // Reset current playback channel timing/state before applying new channel details.
    this.#resetChannelDetails();

    // Relearn stream properties for each playback session.
    this.video.fps = undefined;
    this.video.width = undefined;
    this.video.height = undefined;

    if (Array.isArray(decodedMessage?.channels) === true) {
      videoStream = decodedMessage.channels.find((stream) => stream?.codec === this.video.codec.toUpperCase());
      audioStream = decodedMessage.channels.find((stream) => stream?.codec === this.audio.codec.toUpperCase());
    }

    // Use the earliest available stream start time as the shared session anchor.
    if (typeof videoStream?.startTime === 'number' && typeof audioStream?.startTime === 'number') {
      sessionStart = Math.min(videoStream.startTime, audioStream.startTime) * 1000;
    }

    if (typeof sessionStart !== 'number' && typeof videoStream?.startTime === 'number') {
      sessionStart = videoStream.startTime * 1000;
    }

    if (typeof sessionStart !== 'number' && typeof audioStream?.startTime === 'number') {
      sessionStart = audioStream.startTime * 1000;
    }

    if (typeof sessionStart !== 'number') {
      sessionStart = now;
    }

    this.#sessionStartTime = sessionStart;

    if (typeof videoStream === 'object' && videoStream !== null) {
      this.#channels.video.id = videoStream.channelId;

      // Store video stream details reported by NexusTalk.
      // FPS and resolution are learned dynamically during playback from
      // observed frame timing and SPS data respectively.
      this.video.profile = typeof videoStream.profile === 'string' ? videoStream.profile : undefined;
      this.video.clockRate =
        Number.isFinite(videoStream.sampleRate) === true && videoStream.sampleRate > 0 ? videoStream.sampleRate : undefined;
      this.video.bitrate =
        videoStream?.profile?.includes?.('2MBIT') === true
          ? 2000000
          : videoStream?.profile?.includes?.('530KBIT') === true
            ? 530000
            : videoStream?.profile?.includes?.('100KBIT') === true
              ? 100000
              : undefined;

      // Audio/video channels may start slightly offset from each other.
      // Clamp offset so reconnect jitter or backend timing anomalies do not
      // produce unrealistic media timestamps.
      startDelta = typeof videoStream.startTime === 'number' ? videoStream.startTime * 1000 - sessionStart : 0;
      this.#channels.video.startOffset = Math.max(-250, Math.min(250, Math.round(startDelta)));
      this.#channels.video.mediaTime = sessionStart + this.#channels.video.startOffset;
    }

    if (typeof audioStream === 'object' && audioStream !== null) {
      this.#channels.audio.id = audioStream.channelId;

      // Store audio stream details reported by NexusTalk.
      this.audio.profile = typeof audioStream.profile === 'string' ? audioStream.profile : undefined;
      this.audio.sampleRate =
        Number.isFinite(audioStream.sampleRate) === true && audioStream.sampleRate > 0 ? audioStream.sampleRate : undefined;
      this.audio.channels = Number.isFinite(audioStream.channels) === true && audioStream.channels > 0 ? audioStream.channels : 1;
      this.audio.bitrate = Number.isFinite(audioStream.bitrate) === true && audioStream.bitrate > 0 ? audioStream.bitrate : undefined;

      // Audio/video channels may start slightly offset from each other.
      // Clamp offset so reconnect jitter or backend timing anomalies do not
      // produce unrealistic media timestamps.
      startDelta = typeof audioStream.startTime === 'number' ? audioStream.startTime * 1000 - sessionStart : 0;
      this.#channels.audio.startOffset = Math.max(-250, Math.min(250, Math.round(startDelta)));
      this.#channels.audio.mediaTime = sessionStart + this.#channels.audio.startOffset;
    }

    // Store active playback session id for stop-playback and talkback messages.
    this.#sessionId = decodedMessage?.sessionId;
    this.#lastPacketAt = Date.now();
    this.#startStalledMonitor();

    this?.log?.debug?.('Playback started from "%s" with session ID "%s"', this.#host, this.#sessionId);
  }

  #handlePlaybackPacket(payload) {
    let decodedMessage = undefined;
    let Type = this.#protobufTypes.PlaybackPacket;
    let video = undefined;
    let audio = undefined;
    let timestamp = 0;
    let data = undefined;
    let keyFrame = false;
    let resolution = undefined;

    if (this.closing === true || this.closed === true) {
      // We received a PlaybackPacket message but we're already closing/closed,
      // so ignore it.
      return;
    }

    if (
      Buffer.isBuffer(payload) !== true ||
      this.#protobufTypes.PlaybackPacket === undefined ||
      this.#protobufTypes.PlaybackPacket === null
    ) {
      return;
    }

    try {
      decodedMessage = Type.decode(payload);
    } catch (error) {
      this?.log?.debug?.('Playback packet decode failed for uuid "%s": %s', this.uuid, String(error));
      return;
    }

    // Update the last packet receipt time used by the stalled monitor.
    this.#lastPacketAt = Date.now();

    if (decodedMessage?.channelId === undefined) {
      return;
    }

    // Handle video packet.
    if (decodedMessage.channelId === this.#channels.video?.id) {
      video = this.#channels.video;
      timestamp = this.#calculateTimestamp(decodedMessage.timestampDelta, video, this.video.clockRate, 80);
      data = this.#getPayloadBuffer(decodedMessage.payload);

      if (typeof timestamp !== 'number' || Buffer.isBuffer(data) !== true || data.length === 0) {
        return;
      }

      // Learn video frame size from H264 SPS when available.
      // NexusTalk can change profile/resolution between playback sessions, so
      // this is intentionally relearned after each PlaybackBegin reset.
      if (Number.isFinite(this.video.width) !== true || Number.isFinite(this.video.height) !== true) {
        for (let nalu of StreamTransport.getH264NALUnits(data)) {
          // Only inspect SPS NAL units.
          if (nalu.type !== StreamTransport.H264NALUS.TYPES.SPS) {
            continue;
          }

          resolution = StreamTransport.getH264Resolution(nalu.data);

          if (Number.isFinite(resolution?.width) === true && Number.isFinite(resolution?.height) === true) {
            this.video.width = resolution.width;
            this.video.height = resolution.height;

            this?.log?.debug?.('Detected NexusTalk video resolution for uuid "%s": %sx%s', this.uuid, this.video.width, this.video.height);
          }

          // Only one SPS is needed.
          break;
        }
      }

      keyFrame = StreamTransport.hasH264NAL(data, StreamTransport.H264NALUS.TYPES.IDR);

      if (this.connected === true && this.ready !== true) {
        // Transition to READY now that we have real video packets.
        this.setState(StreamTransport.STATE.READY);
      }

      // New timestamp means the previous buffered NALs belong to the prior frame/access unit.
      if (typeof video.pendingTimestamp === 'number' && timestamp !== video.pendingTimestamp) {
        this.#flushPendingVideo(video);
      }

      // Initialise pending frame state for this timestamp.
      if (typeof video.pendingTimestamp !== 'number') {
        video.pendingTimestamp = timestamp;
        video.pendingKeyFrame = false;

        if (Array.isArray(video.pendingParts) === true) {
          video.pendingParts.length = 0;
        } else {
          video.pendingParts = [];
        }

        video.pendingBytes = 0;
      }

      if (Array.isArray(video.pendingParts) !== true) {
        video.pendingParts = [];
      }

      if (typeof video.pendingBytes !== 'number') {
        video.pendingBytes = 0;
      }

      // Normalise incoming NexusTalk video payloads to Annex-B once, here.
      // This gives the consumer a stable "complete access unit in Annex-B format"
      // contract and avoids rebuilding multi-NAL video later.
      if (data.indexOf(StreamTransport.H264NALUS.START_CODE) !== 0) {
        let buffer = Buffer.allocUnsafe(StreamTransport.H264NALUS.START_CODE.length + data.length);

        StreamTransport.H264NALUS.START_CODE.copy(buffer, 0);
        data.copy(buffer, StreamTransport.H264NALUS.START_CODE.length);
        data = buffer;
      }

      video.pendingParts.push(data);
      video.pendingBytes += data.length;

      if (keyFrame === true) {
        video.pendingKeyFrame = true;
      }

      // Guard against pathological growth if a frame never flushes cleanly.
      if (video.pendingParts.length > MAX_PENDING_VIDEO_PARTS || video.pendingBytes > MAX_PENDING_VIDEO_BYTES) {
        this.recordVideoDrop('oversized-pending-frame');

        this?.log?.warn?.(
          'Resetting oversized pending NexusTalk video frame for uuid "%s" (%s parts, %s bytes)',
          this.uuid,
          video.pendingParts.length,
          video.pendingBytes,
        );

        this.#resetPendingVideo(video);
        return;
      }

      return;
    }

    // Handle audio packet.
    if (decodedMessage.channelId === this.#channels.audio?.id) {
      audio = this.#channels.audio;
      timestamp = this.#calculateTimestamp(decodedMessage.timestampDelta, audio, this.audio.sampleRate, 120);
      data = this.#getPayloadBuffer(decodedMessage.payload);

      if (typeof timestamp !== 'number' || Buffer.isBuffer(data) !== true || data.length === 0) {
        return;
      }

      this.emitMedia({
        type: Streamer.MEDIA_TYPE.AUDIO,
        codec: this.audio.codec,
        profile: this.audio.profile,
        sampleRate: this.audio.sampleRate,
        channels: this.audio.channels,
        bitrate: this.audio.bitrate,
        timestamp: timestamp,
        keyFrame: false,
        data: data,
      });
    }
  }

  #handlePlaybackEnd(payload) {
    let decodedMessage = undefined;

    if (Buffer.isBuffer(payload) !== true || this.#protobufTypes.PlaybackEnd === undefined || this.#protobufTypes.PlaybackEnd === null) {
      return;
    }

    try {
      decodedMessage = this.#protobufTypes.PlaybackEnd.decode(payload).toJSON();
    } catch (error) {
      this?.log?.debug?.('PlaybackEnd decode failed for uuid "%s": %s', this.uuid, String(error));
      return;
    }

    // Flush any final buffered NexusTalk video frame before ending playback.
    // NexusTalk frames are emitted when the timestamp changes, so the final frame
    // would otherwise be lost if the stream ends without a newer timestamp arriving.
    this.#flushPendingVideo(this.#channels.video);

    if (this.#sessionId !== undefined && decodedMessage.reason === 'USER_ENDED_SESSION') {
      // Normal playback ended ie: when we stopped playback.
      this?.log?.debug?.('Playback ended on "%s"', this.#host);

      this.close().catch((error) => {
        this?.log?.debug?.('Error closing NexusTalk for uuid "%s": %s', this.uuid, String(error));
      });

      return;
    }

    if (decodedMessage.reason === 'ERROR_LEAF_NODE_CANNOT_REACH_CAMERA') {
      // Camera is currently unreachable from the Nest backend.
      // Do not reconnect immediately, otherwise we hammer the Dropcam service
      // until the device comes back online. Streamer/device update handling will
      // reconnect when the camera reports online again.
      this?.log?.debug?.(
        'Playback ended on "%s" because camera uuid "%s" is currently unreachable. Waiting for device online update.',
        this.#host,
        this.uuid,
      );

      this.setState(StreamTransport.STATE.CLOSING, 'camera-unreachable');

      this.close().catch((error) => {
        this?.log?.debug?.('Error closing NexusTalk for uuid "%s": %s', this.uuid, String(error));
      });

      return;
    }

    // Error during playback, so we'll attempt to restart by reconnection to host.
    this?.log?.debug?.('Playback ended on "%s" with error "%s". Attempting reconnection', this.#host, decodedMessage.reason);

    this.#requestReconnect(this.#host, 'playback-end');

    this.close().catch((error) => {
      this?.log?.debug?.('Error closing NexusTalk for uuid "%s": %s', this.uuid, String(error));
    });
  }

  #handleNexusError(payload) {
    // Decode error packet
    if (Buffer.isBuffer(payload) === true && this.#protobufTypes.Error !== undefined && this.#protobufTypes.Error !== null) {
      let decodedMessage = undefined;
      try {
        decodedMessage = this.#protobufTypes.Error.decode(payload).toJSON();
      } catch (error) {
        this?.log?.debug?.('Error packet decode failed for uuid "%s": %s', this.uuid, String(error));
        return;
      }

      if (decodedMessage.code === 'ERROR_AUTHORIZATION_FAILED') {
        this?.log?.debug?.('Authorisation failed on "%s" for uuid "%s". Reconnecting NexusTalk session.', this.#host, this.uuid);
        this.#requestReconnect(this.#host, 'reauthorise');
        this.close().catch((error) => {
          this?.log?.debug?.('Error closing NexusTalk for uuid "%s": %s', this.uuid, String(error));
        });
      } else {
        // NexusStreamer Error, packet.message contains the message
        this?.log?.debug?.('NexusTalk error from "%s": %s', this.#host, decodedMessage.message);
      }
    }
  }

  #handleTalkbackBegin(payload) {
    // No payload fields currently required here
    if (Buffer.isBuffer(payload) === true) {
      this.#talkback.active = true;
      this.#talkback.lastPacketTime = undefined; // reset timing for new session
      this?.log?.debug?.('Talking started on uuid "%s"', this.uuid);
    }
  }

  #handleTalkbackEnd(payload) {
    // No payload fields currently required here
    if (Buffer.isBuffer(payload) === true) {
      this.#talkback.active = false;
      this.#talkback.lastPacketTime = undefined;
      this?.log?.debug?.('Talking ended on uuid "%s"', this.uuid);
    }
  }

  #handleNexusData(data) {
    if (Buffer.isBuffer(data) !== true || data.length === 0) {
      return;
    }

    // Inbound NexusTalk packets arrive as a length-prefixed byte stream over TLS.
    // We accumulate bytes into a growable buffer and parse packets using a read index
    // so we do not memmove the buffer on every decoded packet.
    if (Buffer.isBuffer(this.#packetBuffer) !== true) {
      this.#packetBuffer = Buffer.allocUnsafe(INITIAL_PACKET_BUFFER_SIZE);
    }

    if (typeof this.#packetOffset !== 'number') {
      this.#packetOffset = 0;
      this.#packetReadIndex = 0;
    }

    // Check if we need to compact the buffer to make room for incoming data.
    // Only compact if: (1) not enough space for incoming data, AND (2) significant prefix waste
    let unreadBytes = this.#packetOffset - this.#packetReadIndex;
    let availableSpace = this.#packetBuffer.length - this.#packetOffset;

    if (availableSpace < data.length && this.#packetReadIndex > 0) {
      // Smart compaction: only if we have enough unread data worth preserving
      // or if we're critically low on space
      if (unreadBytes > 0 || availableSpace + this.#packetReadIndex < data.length) {
        // Compact unread bytes to the front of the buffer.
        if (unreadBytes > 0) {
          this.#packetBuffer.copy(this.#packetBuffer, 0, this.#packetReadIndex, this.#packetOffset);
        }
        this.#packetOffset = unreadBytes;
        this.#packetReadIndex = 0;
      }
    }

    // If still not enough space or buffer uninitialized, grow it
    if (this.#packetOffset + data.length > this.#packetBuffer.length) {
      if (this.#packetBuffer.length >= MAX_PACKET_BUFFER_SIZE) {
        // 10MB max buffer
        this?.log?.warn?.('Packet buffer exceeded maximum size, resetting for uuid "%s"', this.uuid);
        this.#resetPacketState(false);
        return;
      }

      let requiredSize = this.#packetOffset + data.length;
      let newSize = this.#packetBuffer.length;

      while (newSize < requiredSize && newSize < MAX_PACKET_BUFFER_SIZE) {
        newSize *= 2;
      }

      newSize = Math.min(newSize, MAX_PACKET_BUFFER_SIZE);
      if (requiredSize > newSize) {
        this?.log?.warn?.('Packet buffer required size exceeded maximum, resetting for uuid "%s"', this.uuid);
        this.#resetPacketState(false);
        return;
      }

      let newBuffer = Buffer.allocUnsafe(newSize);
      if (this.#packetOffset > this.#packetReadIndex) {
        this.#packetBuffer.copy(newBuffer, 0, this.#packetReadIndex, this.#packetOffset);
      }
      this.#packetOffset -= this.#packetReadIndex;
      this.#packetReadIndex = 0;
      this.#packetBuffer = newBuffer;
    }

    data.copy(this.#packetBuffer, this.#packetOffset);
    this.#packetOffset += data.length;

    // Parse as many complete packets as are currently available in the unread window.
    while (this.#packetOffset - this.#packetReadIndex >= 3) {
      let packetType = this.#packetBuffer.readUInt8(this.#packetReadIndex);
      let headerSize = 3;
      let packetSize = 0;

      if (packetType === MEDIA_TYPE.LONG_PLAYBACK_PACKET) {
        if (this.#packetOffset - this.#packetReadIndex < 5) {
          break;
        }
        headerSize = 5;
        packetSize = this.#packetBuffer.readUInt32BE(this.#packetReadIndex + 1);
      } else {
        packetSize = this.#packetBuffer.readUInt16BE(this.#packetReadIndex + 1);
      }

      if (packetSize > MAX_PACKET_PAYLOAD_SIZE) {
        // invalid size
        this?.log?.warn?.('Invalid packet size %d, resetting buffer for uuid "%s"', packetSize, this.uuid);
        this.#resetPacketState(true);
        break;
      }

      if (this.#packetOffset - this.#packetReadIndex < headerSize + packetSize) {
        break;
      }

      let protoBufPayload = this.#packetBuffer.subarray(
        this.#packetReadIndex + headerSize,
        this.#packetReadIndex + headerSize + packetSize,
      );
      this.#packetReadIndex += headerSize + packetSize;

      switch (packetType) {
        case MEDIA_TYPE.PING: {
          break;
        }

        case MEDIA_TYPE.OK: {
          // Process any pending messages we have stored.
          this.#authorised = true; // OK message, means we're connected and authorised to Nexus
          this.#flushQueuedMessages();

          // Periodically send PING message to keep stream alive
          clearInterval(this.#pingTimer);
          this.#pingTimer = setInterval(() => {
            this.#sendMessage(MEDIA_TYPE.PING, Buffer.alloc(0));
          }, PING_INTERVAL);

          // Start processing data
          this.#startNexusData();
          break;
        }

        case MEDIA_TYPE.ERROR: {
          this.#handleNexusError(protoBufPayload);
          break;
        }

        case MEDIA_TYPE.PLAYBACK_BEGIN: {
          this.#handlePlaybackBegin(protoBufPayload);
          break;
        }

        case MEDIA_TYPE.PLAYBACK_END: {
          this.#handlePlaybackEnd(protoBufPayload);
          break;
        }

        case MEDIA_TYPE.PLAYBACK_PACKET:
        case MEDIA_TYPE.LONG_PLAYBACK_PACKET: {
          this.#handlePlaybackPacket(protoBufPayload);
          break;
        }

        case MEDIA_TYPE.REDIRECT: {
          this.#handleRedirect(protoBufPayload);
          break;
        }

        case MEDIA_TYPE.TALKBACK_BEGIN: {
          this.#handleTalkbackBegin(protoBufPayload);
          break;
        }

        case MEDIA_TYPE.TALKBACK_END: {
          this.#handleTalkbackEnd(protoBufPayload);
          break;
        }

        default: {
          this?.log?.debug?.('Unknown packet type "%d" received from "%s"', packetType, this.#host);
          break;
        }
      }
    }

    // Normalise fully consumed parser state to keep offsets small and stable.
    if (this.#packetReadIndex === this.#packetOffset) {
      this.#packetReadIndex = 0;
      this.#packetOffset = 0;
    }
  }

  #requestReconnect(host, reason) {
    // Request a reconnect once the current socket is closed.
    // This does NOT perform the reconnect immediately.
    // The actual reconnect is handled centrally in the socket 'close' handler.

    if (typeof host === 'string' && host !== '') {
      this.#reconnectHost = host;
    }

    if ((this.#reconnectHost ?? '') === '') {
      this.#reconnectHost = this.#host ?? this.nexustalk_host;
    }

    this.#reconnectReason = reason;

    if (this.#reconnectPending === true) {
      return;
    }

    this.#reconnectPending = true;
    this.setState(StreamTransport.STATE.RECONNECTING, reason);
  }

  #canWrite(requiresAuthorisation = false) {
    return (
      this.#socket?.readyState === 'open' &&
      this.#socket?.writable === true &&
      (requiresAuthorisation !== true || this.#authorised === true)
    );
  }

  #clearMessageQueue(resetStartIndex = 0) {
    if (this.#messages instanceof RingBuffer === true) {
      this.#messages.clear(resetStartIndex);
      return;
    }

    this.#messages = new RingBuffer(resetStartIndex, PENDING_MESSAGE_QUEUE_CAPACITY);
  }

  #resetPacketState(reuseBuffer = true) {
    if (reuseBuffer === true && Buffer.isBuffer(this.#packetBuffer) === true) {
      this.#packetOffset = 0;
      this.#packetReadIndex = 0;
      return;
    }

    this.#packetBuffer = undefined;
    this.#packetOffset = undefined;
    this.#packetReadIndex = 0;
  }

  #startStalledMonitor() {
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

        this?.log?.debug?.(
          'No NexusTalk playback packets received for uuid "%s" in the past %s seconds. Closing connection',
          this.uuid,
          Math.round(STALLED_TIMEOUT / 1000),
        );
        this.#requestReconnect(this.#host, 'stalled');
        this.close().catch((error) => {
          this?.log?.debug?.('Error closing NexusTalk for uuid "%s": %s', this.uuid, String(error));
        });
      },
      Math.max(1000, Math.round(STALLED_TIMEOUT / 2)),
    );
  }

  #stopStalledMonitor() {
    clearInterval(this.#stalledTimer);
    this.#stalledTimer = undefined;
    this.#lastPacketAt = undefined;
  }

  #calculateTimestamp(delta, stream, sampleRate, maxStepMs = undefined) {
    let deltaMs = 0;

    // Convert NexusTalk timestamp deltas into monotonic source media time
    // anchored to the shared playback session start time. Streamer later maps
    // this source media time onto each output's playout schedule.
    if (typeof stream?.mediaTime !== 'number') {
      stream.mediaTime = typeof this.#sessionStartTime === 'number' ? this.#sessionStartTime + (stream?.startOffset ?? 0) : Date.now();
    }

    if (Number.isFinite(sampleRate) !== true || sampleRate <= 0) {
      return stream.mediaTime;
    }

    if (typeof delta === 'number') {
      deltaMs = (delta / sampleRate) * 1000;

      if (Number.isFinite(deltaMs) !== true || deltaMs < 0) {
        deltaMs = 0;
      }

      if (typeof maxStepMs === 'number' && maxStepMs > 0 && deltaMs > maxStepMs) {
        deltaMs = maxStepMs;
      }
    }

    if (deltaMs > 0) {
      stream.mediaTime += deltaMs;
    }

    return stream.mediaTime;
  }

  #getPayloadBuffer(payload) {
    // Copy payload bytes out of protobuf-decoded objects before retaining them.
    // Streamer treats media buffers as immutable, but protobufjs byte fields may
    // alias the reusable NexusTalk packet buffer, which is compacted/overwritten
    // as more TLS data arrives.
    if (Buffer.isBuffer(payload) === true) {
      return Buffer.from(payload);
    }

    if (payload instanceof Uint8Array) {
      return Buffer.from(payload);
    }

    // Fallback: protobufjs may expose bytes as a base64-encoded string.
    if (typeof payload === 'string') {
      return Buffer.from(payload, 'base64');
    }

    return undefined;
  }

  #resetPendingVideo(video) {
    if (typeof video !== 'object' || video === null) {
      return;
    }

    video.pendingTimestamp = undefined;
    video.pendingKeyFrame = false;

    if (Array.isArray(video.pendingParts) === true) {
      video.pendingParts.length = 0;
    } else {
      video.pendingParts = [];
    }

    video.pendingBytes = 0;
  }

  #flushPendingVideo(video) {
    let pendingTimestamp = undefined;
    let minimumStep = 1;
    let pendingData = undefined;

    if (typeof video !== 'object' || video === null) {
      return;
    }

    // Nothing buffered, so just clear any stale pending state
    if (Array.isArray(video.pendingParts) !== true || video.pendingParts.length === 0 || typeof video.pendingTimestamp !== 'number') {
      this.#resetPendingVideo(video);
      return;
    }

    pendingTimestamp = video.pendingTimestamp;

    // Calculate FPS from the original emitted access-unit timing.
    // Use smoothing to avoid oscillation due to jitter.
    if (typeof video.lastEmittedTimestamp === 'number' && pendingTimestamp > video.lastEmittedTimestamp) {
      let frameDuration = pendingTimestamp - video.lastEmittedTimestamp;
      let instantFps = frameDuration > 0 ? 1000 / frameDuration : undefined;
      let previousFPS = this.video.fps;

      if (Number.isFinite(instantFps) === true && instantFps >= 1 && instantFps <= 60) {
        this.video.fps =
          Number.isFinite(this.video.fps) === true && this.video.fps > 0 ? this.video.fps * 0.8 + instantFps * 0.2 : instantFps;

        // Log initial FPS detection.
        if (Number.isFinite(previousFPS) !== true) {
          this?.log?.debug?.('Detected NexusTalk video FPS for uuid "%s": %sfps', this.uuid, Math.round(this.video.fps));
        }

        // Log significant FPS changes (camera profile changes, adaptive streams, etc).
        if (
          Number.isFinite(previousFPS) === true &&
          Math.abs(Math.round(this.video.fps) - Math.round(previousFPS)) >= 3 &&
          (typeof video.lastFPSLogTime !== 'number' || Date.now() - video.lastFPSLogTime >= 30000)
        ) {
          video.lastFPSLogTime = Date.now();

          this?.log?.debug?.('NexusTalk video FPS changed for uuid "%s": %sfps', this.uuid, Math.round(this.video.fps));
        }
      }
    }

    // Use learned transport video FPS metadata to keep emitted source media
    // timestamps moving forward. Fallback to 30fps until we learn the cadence.
    minimumStep = Math.max(1, Math.round(1000 / (Number.isFinite(this.video.fps) === true && this.video.fps > 0 ? this.video.fps : 30)));

    // Keep emitted frame timestamps monotonic.
    if (typeof video.lastEmittedTimestamp === 'number' && pendingTimestamp <= video.lastEmittedTimestamp) {
      pendingTimestamp = video.lastEmittedTimestamp + minimumStep;
    }

    video.lastEmittedTimestamp = pendingTimestamp;

    // Avoid Buffer.concat() for the common/small case where a NexusTalk frame
    // only has a single pending Annex-B NAL/access unit part.
    if (video.pendingParts.length === 1) {
      pendingData = video.pendingParts[0];
    }

    if (video.pendingParts.length > 1) {
      pendingData = Buffer.concat(video.pendingParts, video.pendingBytes);
    }

    if (Buffer.isBuffer(pendingData) !== true || pendingData.length === 0) {
      this.#resetPendingVideo(video);
      return;
    }

    this.emitMedia({
      type: Streamer.MEDIA_TYPE.VIDEO,
      codec: this.video.codec,
      profile: this.video.profile,
      width: this.video.width,
      height: this.video.height,
      fps: this.video.fps,
      bitrate: this.video.bitrate,
      timestamp: pendingTimestamp,
      keyFrame: video.pendingKeyFrame,
      data: pendingData,
    });

    this.#resetPendingVideo(video);
  }

  #resetChannelDetails() {
    this.#sessionStartTime = undefined;

    // Reset video channel details
    this.#channels.video.id = undefined;
    this.#channels.video.startOffset = 0;
    this.#channels.video.mediaTime = undefined;
    this.#channels.video.lastEmittedTimestamp = undefined;
    this.#channels.video.pendingTimestamp = undefined;
    this.#channels.video.pendingKeyFrame = false;
    if (Array.isArray(this.#channels.video.pendingParts) === true) {
      this.#channels.video.pendingParts.length = 0;
    } else {
      this.#channels.video.pendingParts = [];
    }
    this.#channels.video.pendingBytes = 0;

    // Reset audio channel details
    this.#channels.audio.id = undefined;
    this.#channels.audio.startOffset = 0;
    this.#channels.audio.mediaTime = undefined;

    // Reset talkback state as well since this can also change on each stream
    this.#talkback.active = false;
    this.#talkback.lastPacketTime = undefined;
  }
}
