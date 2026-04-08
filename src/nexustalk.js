// NexusTalk
// Part of homebridge-nest-accfactory
//
// Handles streaming connections with Nest legacy 'Nexus' systems.
// Manages bidirectional media streams (audio/video) over secure TLS connections
// using Nest's proprietary protobuf-based protocol.
//
// Extends Streamer base class to provide Nest API-specific streaming capabilities,
// feeding H264 video and AAC audio directly into the Streamer pipeline.
//
// Responsibilities:
// - Establish and manage TLS connection to Nest backend
// - Exchange protobuf messages for session control and media transport
// - Receive and forward H264 video NAL units and AAC audio frames
// - Inject media into Streamer for live streaming and recording
// - Handle talkback audio using Speex encoding
//
// Features:
// - TLS-encrypted connection management with Nest backend
// - Protobuf message serialization for Nest protocol communication
// - Multiplexed media and control messages over a single connection
// - Low-overhead packet handling (no RTP/jitter buffering required)
// - Two-way audio (talkback) support via Speex
//
// Notes:
// - Video is delivered as discrete H264 NAL units (no reassembly required)
// - Audio is delivered as AAC frames
// - Media is passed directly into Streamer without jitter buffering or reordering
// - Simpler pipeline compared to WebRTC (no RTP, no ICE, no DTLS)
//
// Note: Based on foundational work from https://github.com/Brandawg93/homebridge-nest-cam
//
// Code version 2026.04.08
// Mark Hulskamp
'use strict';

// Define external library requirements
import protobuf from 'protobufjs';

// Define nodejs module requirements
import { Buffer } from 'node:buffer';
import { setInterval, clearInterval, setTimeout, clearTimeout } from 'node:timers';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'tls';
import crypto from 'crypto';

// Define our modules
import Streamer from './streamer.js';

// Define constants
import { USER_AGENT, __dirname } from './consts.js';

const PING_INTERVAL = 15000; // Ping interval to nexus server while stream active
const STALLED_TIMEOUT = 10000; // Time with no playback packets received before we consider stream stalled and attempt restart

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
  #socket = undefined; // TCP socket object
  #packetBuffer = undefined; // Incoming packet buffer
  #packetOffset = undefined; // Current offset in packet buffer
  #messages = []; // Incoming messages
  #authorised = false; // Have we been authorised
  #sessionId = undefined; // Session ID
  #host = undefined; // Current host connected to
  #pingTimer = undefined; // Timer object for ping interval
  #stalledTimer = undefined; // Timer object for no received data
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
      protobuf.util.Long = null;
      protobuf.configure();
      this.#protobufNexusTalk = protobuf.loadSync(path.resolve(__dirname + '/protobuf/nest/nexustalk.proto'));
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
      clearTimeout(this.#stalledTimer);
      this.#pingTimer = undefined;
      this.#stalledTimer = undefined;
      this.#sessionId = undefined; // No session ID yet
      this.#reconnectPending = false;
      this.#reconnectHost = undefined;
      this.#reconnectReason = undefined;

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

            this?.log?.debug?.('Connection closed to "%s"', options.host);

            clearInterval(this.#pingTimer);
            clearTimeout(this.#stalledTimer);
            this.#pingTimer = undefined;
            this.#stalledTimer = undefined;
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
                'Connection closed, %s to "%s"',
                reconnectReason === 'redirect' ? 'redirecting' : 'attempting reconnection',
                reconnectHost,
              );
              this.connect({ host: reconnectHost }); // Attempt reconnect to new host
              return;
            }

            this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_CLOSED, 'socket-close');
          });
        });
      } catch (error) {
        this?.log?.error?.('Failed to connect to "%s": %s', options.host, String(error));
        this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_CLOSED, 'connect-failed');
      }
    }
  }

  async close(stopStreamFirst) {
    // Close an authenticated socket stream gracefully
    // Clear any running timers before closing socket to prevent race conditions
    clearInterval(this.#pingTimer);
    clearTimeout(this.#stalledTimer);
    this.#pingTimer = undefined;
    this.#stalledTimer = undefined;

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

    // Only move to closed state if we are not already reconnecting.
    // Reconnect state is set when reconnect is requested, not during close().
    if (this.#reconnectPending !== true) {
      this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_CLOSED);
    }

    this.#sessionId = undefined; // Not an active session anymore
    this.#packetBuffer = undefined;
    this.#packetOffset = undefined;
    this.#messages = [];
  }

  async onUpdate(deviceData) {
    if (typeof deviceData !== 'object') {
      return;
    }

    if (deviceData?.apiAccess?.token !== undefined && deviceData.apiAccess.token !== this.token) {
      // Aaccess token has changed, so update stored token and re-authenticate if we have an active connection
      // Log this as a debug message only if we actually have active outputs
      // otherwise it can be normal for tokens to update when not streaming and would just be noise in the logs
      if (this.hasActiveStreams() === true) {
        this?.log?.debug?.(
          'Access token has changed for uuid "%s" while NexusTalk session is active. Updating stored token.',
          this.nest_google_device_uuid,
        );
      }
      this.token = deviceData.apiAccess.token;

      if (this.#socket !== undefined) {
        this.#Authenticate(true); // Update authorisation only if connected
      }
    }

    if (deviceData?.nexustalk_host !== undefined && this.nexustalk_host !== deviceData.nexustalk_host) {
      this.nexustalk_host = deviceData.nexustalk_host;

      if (this.hasActiveStreams() === true) {
        this?.log?.debug?.('New host has been requested for connection. Host requested is "%s"', this.nexustalk_host);

        this.#requestReconnect(this.nexustalk_host, 'host-change');
        this.close(true);
      }
    }
  }

  async onShutdown() {
    await this.close(true); // Gracefully stop stream and close socket
  }

  sendTalkback(talkingBuffer) {
    let AudioPayload = undefined;
    let encodedData = undefined;

    if (
      Buffer.isBuffer(talkingBuffer) !== true ||
      this.#protobufNexusTalk === undefined ||
      this.#protobufNexusTalk === null ||
      this.#sessionId === undefined
    ) {
      return;
    }

    AudioPayload = this.#protobufNexusTalk.lookup('nest.nexustalk.v1.AudioPayload');
    if (AudioPayload === null) {
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
    if (this.videoEnabled === false || this.online === false || this.#protobufNexusTalk === undefined || this.#protobufNexusTalk === null) {
      return;
    }

    // Setup streaming profiles
    // We'll use the highest profile as the main, with others for fallback
    let otherProfiles = ['VIDEO_H264_530KBIT_L31', 'VIDEO_H264_100KBIT_L30'];

    if (this.audioEnabled === true) {
      // Include AAC profile if audio is enabled on camera
      otherProfiles.push('AUDIO_AAC');
    }

    let StartPlayback = this.#protobufNexusTalk.lookup('nest.nexustalk.v1.StartPlayback');
    if (StartPlayback === null) {
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
    if (this.#sessionId === undefined || this.#protobufNexusTalk === undefined || this.#protobufNexusTalk === null) {
      return;
    }

    let StopPlayback = this.#protobufNexusTalk.lookup('nest.nexustalk.v1.StopPlayback');
    if (StopPlayback === null) {
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

  #sendMessage(type, data) {
    if (Buffer.isBuffer(data) !== true) {
      return;
    }

    if (this.#socket?.readyState !== 'open' || (type !== MEDIA_TYPE.HELLO && this.#authorised === false)) {
      // We're not connected and/or authorised yet, so 'cache' message for processing once this occurs
      this.#messages.push({ type: type, data: data });
      return;
    }

    let header = undefined;

    if (type === MEDIA_TYPE.LONG_PLAYBACK_PACKET) {
      header = Buffer.alloc(5);
      header.writeUInt8(type, 0);
      header.writeUInt32BE(data.length, 1);
    } else {
      header = Buffer.alloc(3);
      header.writeUInt8(type, 0);
      header.writeUInt16BE(data.length, 1);
    }

    // write our composed message out to the socket back to NexusTalk
    this.#socket.write(Buffer.concat([header, data]), () => {
      // Message sent. Don't do anything?
    });
  }

  #Authenticate(reauthorise) {
    // Authenticate over created socket connection
    if (this.#protobufNexusTalk === undefined || this.#protobufNexusTalk === null) {
      return;
    }

    this.#authorised = false; // We're no longer authorised

    let authoriseRequest = null;
    let AuthoriseRequest = this.#protobufNexusTalk.lookup('nest.nexustalk.v1.AuthoriseRequest');
    if (AuthoriseRequest !== null) {
      try {
        authoriseRequest = AuthoriseRequest.encode(
          AuthoriseRequest.fromObject(this.useGoogleAuth === true ? { oliveToken: this.token } : { sessionToken: this.token }),
        ).finish();
      } catch (error) {
        this?.log?.debug?.('AuthoriseRequest encode failed for uuid "%s": %s', this.nest_google_device_uuid, String(error));
        return;
      }
    }

    if (authoriseRequest === null) {
      return;
    }

    if (reauthorise === true) {
      // Request to re-authorise only
      this?.log?.debug?.('Re-authentication requested to "%s"', this.#host);
      this.#sendMessage(MEDIA_TYPE.AUTHORIZE_REQUEST, authoriseRequest);
      return;
    }

    // This isn't a re-authorise request, so perform 'Hello' packet
    let Hello = this.#protobufNexusTalk.lookup('nest.nexustalk.v1.Hello');
    if (Hello === null) {
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

    if (Buffer.isBuffer(payload) === true && this.#protobufNexusTalk !== undefined && this.#protobufNexusTalk !== null) {
      let decodedMessage = undefined;

      try {
        decodedMessage = this.#protobufNexusTalk.lookup('nest.nexustalk.v1.Redirect').decode(payload).toJSON();
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
    this.close(true);
  }

  #handlePlaybackBegin(payload) {
    if (Buffer.isBuffer(payload) !== true || this.#protobufNexusTalk === undefined || this.#protobufNexusTalk === null) {
      return;
    }

    let decodedMessage = undefined;
    let now = Date.now();
    let videoStream = undefined;
    let audioStream = undefined;
    let sessionStart = undefined;
    let startDelta = 0;

    try {
      decodedMessage = this.#protobufNexusTalk.lookup('nest.nexustalk.v1.PlaybackBegin').decode(payload).toJSON();
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

    // Since this is the beginning of playback, clear any active buffer contents
    this.#sessionId = decodedMessage?.sessionId;
    this.#packetBuffer = undefined;
    this.#packetOffset = undefined;
    this.#messages = [];

    this?.log?.debug?.('Playback started from "%s" with session ID "%s"', this.#host, this.#sessionId);
  }

  #handlePlaybackPacket(payload) {
    // Function to check if a given H264 NAL unit type is present in the data buffer
    let hasH264NAL = (data, nalType) => {
      let offset = 0;

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
    };

    // Function to calculate packet timestamp based on delta and stream details
    let calculateTimestamp = (delta, stream, maxStepMs = undefined) => {
      let deltaMs = 0;

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
    };

    if (Buffer.isBuffer(payload) !== true || this.#protobufNexusTalk === undefined || this.#protobufNexusTalk === null) {
      return;
    }

    // Decode playback packet
    let decodedMessage = undefined;
    let Type = this.#protobufNexusTalk.lookup('nest.nexustalk.v1.PlaybackPacket');
    let reader = new protobuf.Reader(payload);
    let video = undefined;
    let audio = undefined;
    let timestamp = 0;
    let data = undefined;
    let keyFrame = false;

    try {
      decodedMessage = Type.decode(reader);
    } catch (error) {
      this?.log?.debug?.('Playback packet decode failed for uuid "%s": %s', this.nest_google_device_uuid, String(error));
      return;
    }

    // Set up a timeout to monitor for no packets received in a certain period
    // If it's triggered, we'll attempt to restart the stream and/or connection
    clearTimeout(this.#stalledTimer);
    this.#stalledTimer = setTimeout(() => {
      this?.log?.debug?.(
        'No NexusTalk playback packets received for uuid "%s" in the past %s seconds. Closing connection',
        this.nest_google_device_uuid,
        Math.round(STALLED_TIMEOUT / 1000),
      );
      this.#requestReconnect(this.#host, 'stalled');
      this.close(false);
    }, STALLED_TIMEOUT);

    if (decodedMessage?.channelId === undefined) {
      return;
    }

    // Handle video packet
    if (decodedMessage.channelId === this.#channels.video?.id) {
      video = this.#channels.video;
      timestamp = calculateTimestamp(decodedMessage.timestampDelta, video, 80);
      data = Buffer.from(decodedMessage.payload, 'base64');

      if (typeof timestamp !== 'number' || Buffer.isBuffer(data) !== true || data.length === 0) {
        return;
      }

      keyFrame = hasH264NAL(data, Streamer.H264NALUS.TYPES.IDR);

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
        video.pendingParts = [];
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
        data = Buffer.concat([Streamer.H264NALUS.START_CODE, data]);
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
      timestamp = calculateTimestamp(decodedMessage.timestampDelta, audio, 120);
      data = Buffer.from(decodedMessage.payload, 'base64');

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
    if (Buffer.isBuffer(payload) === true && this.#protobufNexusTalk !== undefined && this.#protobufNexusTalk !== null) {
      let decodedMessage = undefined;
      try {
        decodedMessage = this.#protobufNexusTalk.lookup('nest.nexustalk.v1.PlaybackEnd').decode(payload).toJSON();
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
        this.setSourceState(Streamer.MESSAGE_TYPE.SOURCE_CLOSED, 'playback-ended');
      }

      if (decodedMessage.reason !== 'USER_ENDED_SESSION') {
        // Error during playback, so we'll attempt to restart by reconnection to host
        this?.log?.debug?.('Playback ended on "%s" with error "%s". Attempting reconnection', this.#host, decodedMessage.reason);

        this.#requestReconnect(this.#host, 'playback-end');
        this.close(false); // Close existing socket and reconnect
      }
    }
  }

  #handleNexusError(payload) {
    // Decode error packet
    if (Buffer.isBuffer(payload) === true && this.#protobufNexusTalk !== undefined && this.#protobufNexusTalk !== null) {
      let decodedMessage = undefined;
      try {
        decodedMessage = this.#protobufNexusTalk.lookup('nest.nexustalk.v1.Error').decode(payload).toJSON();
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
    // Decode talk begin packet
    if (Buffer.isBuffer(payload) === true && this.#protobufNexusTalk !== undefined && this.#protobufNexusTalk !== null) {
      //let decodedMessage = this.#protobufNexusTalk.lookup('nest.nexustalk.v1.TalkbackBegin').decode(payload).toJSON();
      this.#talkback.active = true;
      this.#talkback.lastPacketTime = undefined; // reset timing for new session
      this?.log?.debug?.('Talking started on uuid "%s"', this.nest_google_device_uuid);
    }
  }

  #handleTalkbackEnd(payload) {
    // Decode talk end packet
    if (Buffer.isBuffer(payload) === true && this.#protobufNexusTalk !== undefined && this.#protobufNexusTalk !== null) {
      //let decodedMessage = this.#protobufNexusTalk.lookup('nest.nexustalk.v1.TalkbackEnd').decode(payload).toJSON();
      this.#talkback.active = false;
      this.#talkback.lastPacketTime = undefined;
      this?.log?.debug?.('Talking ended on uuid "%s"', this.nest_google_device_uuid);
    }
  }

  #handleNexusData(data) {
    if (Buffer.isBuffer(data) !== true || data.length === 0) {
      return;
    }

    if (this.#packetOffset === undefined) {
      this.#packetBuffer = Buffer.allocUnsafe(256 * 1024);
      this.#packetOffset = 0;
    }

    if (this.#packetOffset + data.length > this.#packetBuffer.length) {
      if (this.#packetBuffer.length >= 10 * 1024 * 1024) {
        // 10MB max buffer
        this?.log?.warn?.('Packet buffer exceeded maximum size, resetting for uuid "%s"', this.nest_google_device_uuid);
        this.#packetOffset = 0;
        return;
      }
      let newSize = Math.min(this.#packetBuffer.length * 2, 10 * 1024 * 1024);
      let newBuffer = Buffer.allocUnsafe(newSize);
      this.#packetBuffer.copy(newBuffer, 0, 0, this.#packetOffset);
      this.#packetBuffer = newBuffer;
    }

    data.copy(this.#packetBuffer, this.#packetOffset);
    this.#packetOffset += data.length;

    while (this.#packetOffset >= 3) {
      let packetType = this.#packetBuffer.readUInt8(0);
      let headerSize = 3;
      let packetSize;

      if (packetType === MEDIA_TYPE.LONG_PLAYBACK_PACKET) {
        if (this.#packetOffset < 5) {
          break;
        }
        headerSize = 5;
        packetSize = this.#packetBuffer.readUInt32BE(1);
      } else {
        packetSize = this.#packetBuffer.readUInt16BE(1);
      }

      if (packetSize < 0 || packetSize > 5 * 1024 * 1024) {
        // invalid size
        this?.log?.warn?.('Invalid packet size %d, resetting buffer for uuid "%s"', packetSize, this.nest_google_device_uuid);
        this.#packetOffset = 0;
        break;
      }

      if (this.#packetOffset < headerSize + packetSize) {
        break;
      }

      let protoBufPayload = this.#packetBuffer.subarray(headerSize, headerSize + packetSize);
      this.#packetBuffer.copy(this.#packetBuffer, 0, headerSize + packetSize, this.#packetOffset);
      this.#packetOffset -= headerSize + packetSize;

      switch (packetType) {
        case MEDIA_TYPE.PING: {
          break;
        }

        case MEDIA_TYPE.OK: {
          // process any pending messages we have stored
          this.#authorised = true; // OK message, means we're connected and authorised to Nexus
          for (let message = this.#messages.shift(); message; message = this.#messages.shift()) {
            this.#sendMessage(message.type, message.data);
          }

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

  #resetPendingVideo(video) {
    if (typeof video !== 'object' || video === null) {
      return;
    }

    video.pendingTimestamp = undefined;
    video.pendingKeyFrame = false;
    video.pendingParts = [];
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
    this.#channels.video.pendingParts = [];
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
