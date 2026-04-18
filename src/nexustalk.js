// NexusTalk
// Part of homebridge-nest-accfactory
//
// Handles streaming connections with Nest legacy 'Nexus' backend systems.
// Manages bidirectional media streams (audio/video) over secure TLS connections
// using Nest's proprietary protobuf-based protocol.
//
// Extends Streamer base class to provide Nest-specific streaming transport,
// feeding H264 video and AAC audio directly into the shared Streamer pipeline.
//
// Responsibilities:
// - Establish and manage TLS connection to Nexus backend hosts
// - Perform session authentication and authorisation
// - Exchange protobuf messages for session control and media transport
// - Receive and forward H264 video and AAC audio into Streamer
// - Handle two-way talkback audio using Speex encoding
// - Queue outbound control messages while socket/auth state is unavailable
// - Reconnect cleanly on redirect, stall, host change, or backend closure
//
// Features:
// - TLS-encrypted connection management with Nexus backend
// - Protobuf message serialization for proprietary NexusTalk protocol
// - Multiplexed media and control messages over a single connection
// - Buffered outbound control-message queue using RingBuffer
// - Direct media injection into Streamer with minimal processing overhead
// - Two-way audio (talkback) support via Speex
//
// Notes:
// - Video is delivered as H264 NAL units and assembled into complete access units
//   before being injected into Streamer
// - Audio is delivered as AAC frames and passed directly into Streamer
//
// Note: Based on foundational work from https://github.com/Brandawg93/homebridge-nest-cam
//
// Code version 2026.04.18
// Mark Hulskamp
'use strict';

// Define external library requirements
import protobuf from 'protobufjs';

// Define nodejs module requirements
import { Buffer } from 'node:buffer';
import { setInterval, clearInterval } from 'node:timers';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'tls';
import crypto from 'crypto';

// Define our modules
import Streamer, { RingBuffer } from './streamer.js';

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
export default class NexusTalk extends Streamer {
  nexustalk_host = undefined; // Main nexustalk streaming host
  token = undefined;
  useGoogleAuth = false; // Nest vs google auth
  blankAudio = AAC_MONO_48000_BLANK;

  // Internal data only for this class
  #protobufNexusTalk = undefined; // Protobuf for NexusTalk
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
  #messages = new RingBuffer(0, PENDING_MESSAGE_QUEUE_CAPACITY);
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
      codec: Streamer.CODEC_TYPE.H264,
      profile: undefined,
      startOffset: 0,
      mediaTime: undefined,
      sampleRate: undefined,
      lastEmittedTimestamp: undefined,
      pendingTimestamp: undefined,
      pendingKeyFrame: false,
      pendingParts: [],
      pendingBytes: 0,
    },
    audio: {
      id: undefined,
      codec: Streamer.CODEC_TYPE.AAC,
      profile: undefined,
      startOffset: 0,
      mediaTime: undefined,
      sampleRate: undefined,
    },
  };

  #talkback = {
    active: false,
    codec: Streamer.CODEC_TYPE.SPEEX,
    sampleRate: 16000,
    channels: 1,
    lastPacketTime: undefined,
  };

  // Codecs being used for video, audio and talking
  get codecs() {
    return {
      video: this.#channels.video.codec,
      audio: this.#channels.audio.codec,
      talkback: this.#talkback.codec,
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

    if (fs.existsSync(path.join(__dirname, 'protobuf/nest/nexustalk.proto')) === true) {
      // Load NexusTalk protobuf schema once for this streamer instance.
      // protobufjs is configured here so decoded/encoded message handling
      // stays consistent with the generated Nest protocol structures.
      protobuf.util.Long = null;
      protobuf.configure();
      this.#protobufNexusTalk = protobuf.loadSync(path.resolve(__dirname + '/protobuf/nest/nexustalk.proto'));

      // Cache protobuf message types up front so we avoid repeated lookup()
      // calls during connect, control messaging, and packet handling paths.
      let lookup = (typeName) => {
        try {
          return this.#protobufNexusTalk.lookup(typeName);
        } catch {
          return undefined;
        }
      };

      this.#protobufTypes.AudioPayload = lookup('nest.nexustalk.v1.AudioPayload');
      this.#protobufTypes.StartPlayback = lookup('nest.nexustalk.v1.StartPlayback');
      this.#protobufTypes.StopPlayback = lookup('nest.nexustalk.v1.StopPlayback');
      this.#protobufTypes.AuthoriseRequest = lookup('nest.nexustalk.v1.AuthoriseRequest');
      this.#protobufTypes.Hello = lookup('nest.nexustalk.v1.Hello');
      this.#protobufTypes.Redirect = lookup('nest.nexustalk.v1.Redirect');
      this.#protobufTypes.PlaybackBegin = lookup('nest.nexustalk.v1.PlaybackBegin');
      this.#protobufTypes.PlaybackPacket = lookup('nest.nexustalk.v1.PlaybackPacket');
      this.#protobufTypes.PlaybackEnd = lookup('nest.nexustalk.v1.PlaybackEnd');
      this.#protobufTypes.Error = lookup('nest.nexustalk.v1.Error');
    }

    // Store data we need from the device data passed in
    this.token = deviceData?.apiAccess?.token;
    this.nexustalk_host = deviceData?.nexustalk_host; // Host we'll connect to
    this.useGoogleAuth = typeof deviceData?.apiAccess?.oauth2 === 'string' && deviceData?.apiAccess?.oauth2 !== '';
  }

  // Class functions
  async connect(options = {}) {
    if (this.online === true && this.videoEnabled === true) {
      if (this.#socket !== undefined && this.#socket.destroyed === false) {
        // Existing socket is still opening/open, avoid duplicate concurrent connects.
        return;
      }

      clearInterval(this.#pingTimer);
      this.#stopStalledMonitor();
      this.#pingTimer = undefined;
      this.#sessionId = undefined; // No session ID yet
      this.#reconnectPending = false;
      this.#reconnectHost = undefined;
      this.#reconnectReason = undefined;
      this.#resetPacketState(true);

      if (typeof options?.host === 'undefined' || options?.host === null) {
        // No host parameter passed in, so we'll set this to our internally stored host
        options.host = this.nexustalk_host;
      }

      this?.log?.debug?.('Connection started to "%s"', options.host);
      this.#host = options.host; // Update internal host name since we’re about to connect
      this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_CONNECTING);

      // Wrap tls.connect() in a Promise so we can await the TLS handshake
      try {
        await new Promise((resolve, reject) => {
          let socket = tls.connect({ host: options.host, port: 1443 }, () => {
            if (this.#socket !== socket) {
              resolve();
              return;
            }

            // Opened connection to Nexus server, so now need to authenticate ourselves
            this?.log?.debug?.('Connection established to "%s"', options.host);
            this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_CONNECTED);

            socket.setKeepAlive(true); // Keep socket connection alive
            this.#reconnectPending = false;
            this.#reconnectHost = undefined;
            this.#reconnectReason = undefined;
            this.#Authenticate(false); // Send authentication request
            resolve(); // Allow await connect() to continue
          });
          this.#socket = socket;

          socket.on('error', (error) => {
            if (this.#socket !== socket) {
              return;
            }

            // TLS error (could be refused, timeout, etc.)
            this?.log?.warn?.('TLS error on connect to "%s": %s', options.host, String(error));
            this.#authorised = false; // Since we had an error, we can't be authorised
            this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_CLOSED, 'tls-error');
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

            if (this.hasActiveStreams() === true && this.#reconnectPending === false) {
              this.#requestReconnect(options.host, 'service-close');
            }

            let reconnecting = this.#reconnectPending === true;
            let reconnectHost = this.#reconnectHost;
            let reconnectReason = this.#reconnectReason;

            if (reconnecting === true && typeof reconnectHost === 'string' && reconnectHost !== '') {
              this.#reconnectPending = false;
              this.#reconnectHost = undefined;
              this.#reconnectReason = undefined;

              this?.log?.debug?.(
                'Connection closed to "%s", %s to "%s"',
                options.host,
                reconnectReason === 'redirect' ? 'redirecting' : 'attempting reconnection',
                reconnectHost,
              );

              this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_CLOSED, 'socket-close');
              this.requestSourceConnect({ host: reconnectHost });
              return;
            }

            this?.log?.debug?.('Connection closed to "%s"', options.host);
            this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_CLOSED, 'socket-close');
          });
        });
      } catch (error) {
        this?.log?.error?.('Failed to connect to "%s": %s', options.host, String(error));
        this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_CLOSED, 'connect-failed');
      }
    }
  }

  async close(stopStreamFirst = true) {
    // Mark source as closing only for a normal/manual shutdown path.
    // During reconnect/redirect we already emitted SOURCE_RECONNECTING,
    // so SOURCE_CLOSING just adds noise to the state flow.
    if (this.#reconnectPending !== true) {
      this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_CLOSING);
    }

    // Close an authenticated socket stream gracefully
    // Clear any running timers before closing socket to prevent race conditions
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

    // Flush any final pending NexusTalk video frame before resetting channel state.
    // This prevents the last access unit from being lost when the stream closes
    // without another video timestamp arriving to trigger a normal flush.
    this.#flushPendingVideo(this.#channels.video);

    // Reset current playback channel timing/state on close since we'll need to renegotiate this on the next stream
    this.#resetChannelDetails();

    this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_CLOSED);

    this.#sessionId = undefined; // Not an active session anymore
    this.#resetPacketState(true);
    this.#clearMessageQueue(0);
  }

  async onUpdate(deviceData) {
    if (typeof deviceData !== 'object') {
      return;
    }

    if (deviceData?.apiAccess?.token !== undefined && deviceData.apiAccess.token !== this.token) {
      // Access token has changed, so update stored token and re-authenticate if we have an active connection
      // Log this as a debug message only if we actually have active outputs
      // otherwise it can be normal for tokens to update when not streaming and would just be noise in the logs
      if (this.hasActiveStreams() === true) {
        this?.log?.debug?.(
          'Access token has changed for uuid "%s" while NexusTalk session is active. Updating stored token.',
          this.nest_google_device_uuid,
        );
      }
      this.token = deviceData.apiAccess.token;
    }

    if (deviceData?.nexustalk_host !== undefined && this.nexustalk_host !== deviceData.nexustalk_host) {
      this.nexustalk_host = deviceData.nexustalk_host;

      if (this.hasActiveStreams() === true) {
        this?.log?.debug?.('New host has been requested for connection. Host requested is "%s"', this.nexustalk_host);

        this.#requestReconnect(this.nexustalk_host, 'host-change');
        this.requestSourceClose();
      }
    }
  }

  async onShutdown() {
    await this.requestSourceClose(); // Gracefully stop stream and close socket
  }

  sendTalkback(talkingBuffer) {
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
          codec: this.#talkback.codec,
          sampleRate: this.#talkback.sampleRate,
        }),
      ).finish();
    } catch (error) {
      this?.log?.debug?.('AudioPayload encode failed for uuid "%s": %s', this.nest_google_device_uuid, String(error));
      return;
    }

    this.#talkback.lastPacketTime = Date.now();
    this.#sendMessage(MEDIA_TYPE.AUDIO_PAYLOAD, encodedData);
  }

  #startNexusData() {
    if (this.videoEnabled === false || this.online === false) {
      return;
    }

    // Setup streaming profiles
    // We'll use the highest profile as the main, with others for fallback
    let otherProfiles = ['VIDEO_H264_530KBIT_L31', 'VIDEO_H264_100KBIT_L30'];

    if (this.audioEnabled === true) {
      // Include AAC profile if audio is enabled on camera
      otherProfiles.push('AUDIO_AAC');
    }

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
      this?.log?.debug?.('StartPlayback encode failed for uuid "%s": %s', this.nest_google_device_uuid, String(error));
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
      this?.log?.debug?.('StopPlayback encode failed for uuid "%s": %s', this.nest_google_device_uuid, String(error));
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
      this?.log?.warn?.('Dropped oldest pending NexusTalk message for uuid "%s" as queue is full', this.nest_google_device_uuid);
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

  #Authenticate(reauthorise) {
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
      this?.log?.debug?.('AuthoriseRequest encode failed for uuid "%s": %s', this.nest_google_device_uuid, String(error));
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
          uuid: this.nest_google_device_uuid.split(/[._]+/)[1],
          requireConnectedCamera: false,
          userAgent: USER_AGENT,
          deviceId: crypto.randomUUID(),
          clientType: 'IOS',
          authoriseRequest: authoriseRequest,
        }),
      ).finish();
    } catch (error) {
      this?.log?.debug?.('Hello encode failed for uuid "%s": %s', this.nest_google_device_uuid, String(error));
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
        this?.log?.debug?.('Redirect packet decode failed for uuid "%s": %s', this.nest_google_device_uuid, String(error));
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
    this.requestSourceClose();
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

    if (this.sourceState === Streamer.MESSAGE_TYPE.SOURCE_CLOSING || this.sourceState === Streamer.MESSAGE_TYPE.SOURCE_CLOSED) {
      // We received a PlaybackBegin message but we're already closing/closed
      // so ignore this message since we're not going to be able to do anything with it
      return;
    }

    try {
      decodedMessage = this.#protobufTypes.PlaybackBegin.decode(payload).toJSON();
    } catch (error) {
      this?.log?.debug?.('PlaybackBegin decode failed for uuid "%s": %s', this.nest_google_device_uuid, String(error));
      return;
    }

    // Reset current playback channel timing/state before applying new channel details
    this.#resetChannelDetails();

    if (Array.isArray(decodedMessage?.channels) === true) {
      videoStream = decodedMessage.channels.find((stream) => stream?.codec === this.codecs.video.toUpperCase());
      audioStream = decodedMessage.channels.find((stream) => stream?.codec === this.codecs.audio.toUpperCase());
    }

    // Use the earliest available stream start time as the shared session anchor
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
      this.#channels.video.profile = videoStream.profile;
      this.#channels.video.sampleRate = videoStream.sampleRate;

      startDelta = typeof videoStream.startTime === 'number' ? videoStream.startTime * 1000 - sessionStart : 0;
      this.#channels.video.startOffset = Math.max(-250, Math.min(250, Math.round(startDelta)));
      this.#channels.video.mediaTime = sessionStart + this.#channels.video.startOffset;
    }

    if (typeof audioStream === 'object' && audioStream !== null) {
      this.#channels.audio.id = audioStream.channelId;
      this.#channels.audio.profile = audioStream.profile;
      this.#channels.audio.sampleRate = audioStream.sampleRate;

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
    if (this.sourceState === Streamer.MESSAGE_TYPE.SOURCE_CLOSING || this.sourceState === Streamer.MESSAGE_TYPE.SOURCE_CLOSED) {
      // We received a PlaybackPacket message but we're already closing/closed
      // so ignore this message since we're not going to be able to do anything with it
      return;
    }

    if (
      Buffer.isBuffer(payload) !== true ||
      this.#protobufTypes.PlaybackPacket === undefined ||
      this.#protobufTypes.PlaybackPacket === null
    ) {
      return;
    }

    // Decode playback packet
    let decodedMessage = undefined;
    let Type = this.#protobufTypes.PlaybackPacket;
    let video = undefined;
    let audio = undefined;
    let timestamp = 0;
    let data = undefined;
    let keyFrame = false;

    try {
      decodedMessage = Type.decode(payload);
    } catch (error) {
      this?.log?.debug?.('Playback packet decode failed for uuid "%s": %s', this.nest_google_device_uuid, String(error));
      return;
    }

    // Update the last packet receipt time used by the stalled monitor.
    this.#lastPacketAt = Date.now();

    if (decodedMessage?.channelId === undefined) {
      return;
    }

    // Handle video packet
    if (decodedMessage.channelId === this.#channels.video?.id) {
      video = this.#channels.video;
      timestamp = this.#calculateTimestamp(decodedMessage.timestampDelta, video, 80);
      data = this.#getPayloadBuffer(decodedMessage.payload);

      if (typeof timestamp !== 'number' || Buffer.isBuffer(data) !== true || data.length === 0) {
        return;
      }

      keyFrame = this.#hasH264NAL(data, Streamer.H264NALUS.TYPES.IDR);

      if (this.sourceState === Streamer.MESSAGE_TYPE.SOURCE_CONNECTED) {
        // Transition to READY now that we have real video packets
        this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_READY);
      }

      // New timestamp means the previous buffered NALs belong to the prior frame/access unit
      if (typeof video.pendingTimestamp === 'number' && timestamp !== video.pendingTimestamp) {
        this.#flushPendingVideo(video);
      }

      // Initialise pending frame state for this timestamp
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
      // This gives Streamer a stable "complete access unit in Annex-B format" contract
      // and avoids it having to rebuild multi-NAL video again later.
      if (data.indexOf(Streamer.H264NALUS.START_CODE) !== 0) {
        let buffer = Buffer.allocUnsafe(Streamer.H264NALUS.START_CODE.length + data.length);
        Streamer.H264NALUS.START_CODE.copy(buffer, 0);
        data.copy(buffer, Streamer.H264NALUS.START_CODE.length);
        data = buffer;
      }

      video.pendingParts.push(data);
      video.pendingBytes += data.length;

      if (keyFrame === true) {
        video.pendingKeyFrame = true;
      }

      // Guard against pathological growth if a frame never flushes cleanly
      if (video.pendingParts.length > MAX_PENDING_VIDEO_PARTS || video.pendingBytes > MAX_PENDING_VIDEO_BYTES) {
        this?.log?.warn?.(
          'Resetting oversized pending NexusTalk video frame for uuid "%s" (%s parts, %s bytes)',
          this.nest_google_device_uuid,
          video.pendingParts.length,
          video.pendingBytes,
        );

        this.#resetPendingVideo(video);
        return;
      }

      return;
    }

    // Handle audio packet
    if (decodedMessage.channelId === this.#channels.audio?.id) {
      audio = this.#channels.audio;
      timestamp = this.#calculateTimestamp(decodedMessage.timestampDelta, audio, 120);
      data = this.#getPayloadBuffer(decodedMessage.payload);

      if (typeof timestamp !== 'number' || Buffer.isBuffer(data) !== true || data.length === 0) {
        return;
      }

      this.addMedia({
        type: Streamer.MEDIA_TYPE.AUDIO,
        codec: this.codecs.audio,
        profile: typeof audio?.profile === 'string' ? audio.profile : undefined,
        sampleRate: Number.isFinite(audio?.sampleRate) === true && audio.sampleRate > 0 ? audio.sampleRate : undefined,
        channels: Number.isFinite(audio?.channels) === true && audio.channels > 0 ? audio.channels : 1, // NexusTalk is typically mono
        bitrate: Number.isFinite(audio?.bitrate) === true && audio.bitrate > 0 ? audio.bitrate : undefined,
        timestamp: timestamp,
        keyFrame: false,
        data: data,
      });
    }
  }

  #handlePlaybackEnd(payload) {
    // Decode playback ended packet
    if (Buffer.isBuffer(payload) === true && this.#protobufTypes.PlaybackEnd !== undefined && this.#protobufTypes.PlaybackEnd !== null) {
      let decodedMessage = undefined;
      try {
        decodedMessage = this.#protobufTypes.PlaybackEnd.decode(payload).toJSON();
      } catch (error) {
        this?.log?.debug?.('PlaybackEnd decode failed for uuid "%s": %s', this.nest_google_device_uuid, String(error));
        return;
      }

      // Flush any final buffered NexusTalk video frame before ending playback.
      // NexusTalk frames are emitted when the timestamp changes, so the final frame
      // would otherwise be lost if the stream ends without a newer timestamp arriving.
      this.#flushPendingVideo(this.#channels.video);

      if (this.#sessionId !== undefined && decodedMessage.reason === 'USER_ENDED_SESSION') {
        // Normal playback ended ie: when we stopped playback
        this?.log?.debug?.('Playback ended on "%s"', this.#host);

        if (this.sourceState !== Streamer.MESSAGE_TYPE.SOURCE_CLOSING && this.sourceState !== Streamer.MESSAGE_TYPE.SOURCE_RECONNECTING) {
          this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_CLOSED, 'playback-ended');
        }
      }

      if (decodedMessage.reason !== 'USER_ENDED_SESSION') {
        // Error during playback, so we'll attempt to restart by reconnection to host
        this?.log?.debug?.('Playback ended on "%s" with error "%s". Attempting reconnection', this.#host, decodedMessage.reason);

        this.#requestReconnect(this.#host, 'playback-end');
        this.requestSourceClose(); // Close existing socket and reconnect
      }
    }
  }

  #handleNexusError(payload) {
    // Decode error packet
    if (Buffer.isBuffer(payload) === true && this.#protobufTypes.Error !== undefined && this.#protobufTypes.Error !== null) {
      let decodedMessage = undefined;
      try {
        decodedMessage = this.#protobufTypes.Error.decode(payload).toJSON();
      } catch (error) {
        this?.log?.debug?.('Error packet decode failed for uuid "%s": %s', this.nest_google_device_uuid, String(error));
        return;
      }

      if (decodedMessage.code === 'ERROR_AUTHORIZATION_FAILED') {
        // NexusStreamer Updating authentication
        this.#Authenticate(true); // Update authorisation only
      } else {
        // NexusStreamer Error, packet.message contains the message
        this?.log?.debug?.('Error', decodedMessage.message);
      }
    }
  }

  #handleTalkbackBegin(payload) {
    // No payload fields currently required here
    if (Buffer.isBuffer(payload) === true) {
      this.#talkback.active = true;
      this.#talkback.lastPacketTime = undefined; // reset timing for new session
      this?.log?.debug?.('Talking started on uuid "%s"', this.nest_google_device_uuid);
    }
  }

  #handleTalkbackEnd(payload) {
    // No payload fields currently required here
    if (Buffer.isBuffer(payload) === true) {
      this.#talkback.active = false;
      this.#talkback.lastPacketTime = undefined;
      this?.log?.debug?.('Talking ended on uuid "%s"', this.nest_google_device_uuid);
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
        this?.log?.warn?.('Packet buffer exceeded maximum size, resetting for uuid "%s"', this.nest_google_device_uuid);
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
        this?.log?.warn?.('Packet buffer required size exceeded maximum, resetting for uuid "%s"', this.nest_google_device_uuid);
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
        this?.log?.warn?.('Invalid packet size %d, resetting buffer for uuid "%s"', packetSize, this.nest_google_device_uuid);
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

    // Always update reconnect target info
    if (typeof host === 'string' && host !== '') {
      this.#reconnectHost = host;
    }

    if ((this.#reconnectHost ?? '') === '') {
      this.#reconnectHost = this.#host ?? this.nexustalk_host;
    }

    this.#reconnectReason = reason;

    // Only emit once
    if (this.#reconnectPending === true) {
      return;
    }

    this.#reconnectPending = true;
    this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_RECONNECTING, reason);
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
          this.nest_google_device_uuid,
          Math.round(STALLED_TIMEOUT / 1000),
        );
        this.#requestReconnect(this.#host, 'stalled');
        this.requestSourceClose();
      },
      Math.max(1000, Math.round(STALLED_TIMEOUT / 2)),
    );
  }

  #stopStalledMonitor() {
    clearInterval(this.#stalledTimer);
    this.#stalledTimer = undefined;
    this.#lastPacketAt = undefined;
  }

  #hasH264NAL(data, nalType) {
    let offset = 0;

    // Check whether the supplied H264 payload contains a given NAL type.
    // Supports both raw single-NAL payloads and Annex-B formatted buffers.
    if (Buffer.isBuffer(data) !== true || data.length === 0) {
      return false;
    }

    // Raw NAL unit without Annex B start code
    if ((data[0] & 0x1f) === nalType) {
      return true;
    }

    while (offset < data.length) {
      // 4-byte Annex B start code
      if (
        offset + 3 < data.length &&
        data[offset] === 0x00 &&
        data[offset + 1] === 0x00 &&
        data[offset + 2] === 0x00 &&
        data[offset + 3] === 0x01
      ) {
        offset += 4;
        if (offset < data.length && (data[offset] & 0x1f) === nalType) {
          return true;
        }
        continue;
      }

      // 3-byte Annex B start code
      if (offset + 2 < data.length && data[offset] === 0x00 && data[offset + 1] === 0x00 && data[offset + 2] === 0x01) {
        offset += 3;
        if (offset < data.length && (data[offset] & 0x1f) === nalType) {
          return true;
        }
        continue;
      }

      offset++;
    }

    return false;
  }

  #calculateTimestamp(delta, stream, maxStepMs = undefined) {
    let deltaMs = 0;

    // Convert NexusTalk timestamp deltas into a monotonic media timestamp
    // anchored to the shared playback session start time.
    if (typeof stream?.mediaTime !== 'number') {
      stream.mediaTime = typeof this.#sessionStartTime === 'number' ? this.#sessionStartTime + (stream?.startOffset ?? 0) : Date.now();
    }

    if (typeof stream?.sampleRate !== 'number' || Number.isFinite(stream.sampleRate) !== true || stream.sampleRate <= 0) {
      return stream.mediaTime;
    }

    if (typeof delta === 'number') {
      deltaMs = (delta / stream.sampleRate) * 1000;

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
    // Copy payload bytes out of protobuf-decoded objects so downstream media
    // handling never depends on protobufjs backing-buffer lifetime/aliasing.
    // This does add one allocation per packet, so revisit if profiling shows
    // meaningful GC pressure in NexusTalk playback.
    if (Buffer.isBuffer(payload) === true) {
      return Buffer.from(payload);
    }

    if (payload instanceof Uint8Array) {
      return Buffer.from(payload);
    }

    // Fallback: assume it's a base64-encoded string
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

    // If we know FPS, use it to keep flushed frame timestamps moving forward
    // by at least one frame interval when duplicate/regressing timestamps occur
    if (typeof this.video?.fps === 'number' && Number.isFinite(this.video.fps) === true && this.video.fps > 0) {
      minimumStep = Math.max(1, Math.round(1000 / this.video.fps));
    }

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

    this.addMedia({
      type: Streamer.MEDIA_TYPE.VIDEO,
      codec: this.codecs.video,
      profile: typeof video?.profile === 'string' ? video.profile : undefined,
      bitrate:
        video?.profile?.includes?.('2MBIT') === true
          ? 2000000
          : video?.profile?.includes?.('530KBIT') === true
            ? 530000
            : video?.profile?.includes?.('100KBIT') === true
              ? 100000
              : undefined,
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
    this.#channels.video.profile = undefined;
    this.#channels.video.startOffset = 0;
    this.#channels.video.mediaTime = undefined;
    this.#channels.video.sampleRate = undefined;
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
    this.#channels.audio.profile = undefined;
    this.#channels.audio.startOffset = 0;
    this.#channels.audio.mediaTime = undefined;
    this.#channels.audio.sampleRate = undefined;

    // Reset talkback state as well since this can also change on each stream
    this.#talkback.active = false;
    this.#talkback.lastPacketTime = undefined;
  }
}
