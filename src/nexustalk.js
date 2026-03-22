// NexusTalk
// Part of homebridge-nest-accfactory
//
// Handles streaming connections with Nest legacy 'Nexus' systems
// Manages bidirectional media streams (audio/video) over secure TLS connections
// Implements Nest proprietary protocol using protobuf message serialisation
//
// Extends Streamer base class to provide Nest API-specific streaming capabilities
// Supports live streaming and talkback audio over Nest legacy infrastructure
//
// Key features:
// - TLS-encrypted connection management with Nest backend
// - Protobuf message serialization for Nest protocol communication
// - Stream multiplexing over single connection
// - Audio/video packet handling and synchronization
// - Talkback (two-way audio) support
//
// Note: Based on foundational work from https://github.com/Brandawg93/homebridge-nest-cam
//
// Code version 2026.03.22
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

const PACKET_TYPE = {
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

// nexusTalk object
export default class NexusTalk extends Streamer {
  nexustalk_host = undefined; // Main nexustalk streaming host
  token = undefined;
  useGoogleAuth = false; // Nest vs google auth
  blankAudio = AAC_MONO_48000_BLANK;
  video = {}; // Video stream details once connected
  audio = {}; // Audio stream details once connected

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

  // Codecs being used for video, audio and talking
  get codecs() {
    return {
      video: Streamer.CODEC_TYPE.H264, // Video codec
      audio: Streamer.CODEC_TYPE.AAC, // Audio codec
      talkback: Streamer.CODEC_TYPE.SPEEX, // Talkback codec
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
  async connect(host) {
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

      if (typeof host === 'undefined' || host === null) {
        // No host parameter passed in, so we'll set this to our internally stored host
        host = this.nexustalk_host;
      }

      this.connected = false; // Starting connection
      this?.log?.debug?.('Connection started to "%s"', host);
      this.#host = host; // Update internal host name since we’re about to connect

      // Wrap tls.connect() in a Promise so we can await the TLS handshake
      try {
        await new Promise((resolve, reject) => {
          let socket = tls.connect({ host: host, port: 1443 }, () => {
            if (this.#socket !== socket) {
              resolve();
              return;
            }
            // Opened connection to Nexus server, so now need to authenticate ourselves
            this?.log?.debug?.('Connection established to "%s"', host);

            socket.setKeepAlive(true); // Keep socket connection alive
            this.connected = true;
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
            this?.log?.warn?.('TLS error on connect to "%s": %s', host, String(error));
            this.connected = undefined;
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

            this?.log?.debug?.('Connection closed to "%s"', host);

            clearInterval(this.#pingTimer);
            clearTimeout(this.#stalledTimer);
            this.#pingTimer = undefined;
            this.#stalledTimer = undefined;
            this.#authorised = false; // Since connection closed, we can't be authorised anymore
            this.#socket = undefined; // Clear socket object
            this.connected = undefined; // We're no longer connected
            this.#sessionId = undefined; // Not an active session anymore
            this.#host = undefined;

            if (this.hasActiveOutputs() === true && this.#reconnectPending === false) {
              this.#requestReconnect(host, 'service-close');
            }

            if (this.#reconnectPending === true && typeof this.#reconnectHost === 'string' && this.#reconnectHost !== '') {
              let reconnectHost = this.#reconnectHost;
              let reconnectReason = this.#reconnectReason;

              this.#reconnectPending = false;
              this.#reconnectHost = undefined;
              this.#reconnectReason = undefined;

              this?.log?.debug?.(
                'Connection closed, %s to "%s"',
                reconnectReason === 'redirect' ? 'redirecting' : 'attempting reconnection',
                reconnectHost,
              );
              this.connect(reconnectHost);
            }
          });
        });
      } catch (error) {
        this?.log?.error?.('Failed to connect to "%s": %s', host, String(error));
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

    this.connected = undefined;
    this.#sessionId = undefined; // Not an active session anymore
    this.#packetBuffer = undefined;
    this.#packetOffset = undefined;
    this.#messages = [];
    this.video = {};
    this.audio = {};
  }

  async onUpdate(deviceData) {
    if (typeof deviceData !== 'object') {
      return;
    }

    if (deviceData?.apiAccess?.token !== undefined && deviceData.apiAccess.token !== this.token) {
      // Aaccess token has changed, so update stored token and re-authenticate if we have an active connection
      // Log this as a debug message only if we actually have active outputs
      // otherwise it can be normal for tokens to update when not streaming and would just be noise in the logs
      if (this.hasActiveOutputs() === true) {
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

      if (this.hasActiveOutputs() === true) {
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
    if (
      Buffer.isBuffer(talkingBuffer) === false ||
      talkingBuffer.length === 0 ||
      this.#protobufNexusTalk === undefined ||
      this.#protobufNexusTalk === null ||
      this.#sessionId === undefined
    ) {
      return;
    }

    // Encode audio packet for sending to camera
    let AudioPayload = this.#protobufNexusTalk.lookup('nest.nexustalk.v1.AudioPayload');
    if (AudioPayload === null) {
      return;
    }

    let encodedData = null;

    try {
      encodedData = AudioPayload.encode(
        AudioPayload.fromObject({
          payload: talkingBuffer,
          sessionId: this.#sessionId,
          codec: Streamer.CODEC_TYPE.SPEEX,
          sampleRate: 16000,
        }),
      ).finish();
    } catch (error) {
      this?.log?.debug?.('AudioPayload encode failed for uuid "%s": %s', this.nest_google_device_uuid, String(error));
      return;
    }

    this.#sendMessage(PACKET_TYPE.AUDIO_PAYLOAD, encodedData);
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

    this.#sendMessage(PACKET_TYPE.START_PLAYBACK, encodedData);
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

    this.#sendMessage(PACKET_TYPE.STOP_PLAYBACK, encodedData);
  }

  #sendMessage(type, data) {
    if (Buffer.isBuffer(data) !== true) {
      return;
    }

    if (this.#socket?.readyState !== 'open' || (type !== PACKET_TYPE.HELLO && this.#authorised === false)) {
      // We're not connected and/or authorised yet, so 'cache' message for processing once this occurs
      this.#messages.push({ type: type, data: data });
      return;
    }

    let header = undefined;

    if (type === PACKET_TYPE.LONG_PLAYBACK_PACKET) {
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
      this.#sendMessage(PACKET_TYPE.AUTHORIZE_REQUEST, authoriseRequest);
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
    this.#sendMessage(PACKET_TYPE.HELLO, encodedData);
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
    try {
      decodedMessage = this.#protobufNexusTalk.lookup('nest.nexustalk.v1.PlaybackBegin').decode(payload).toJSON();
    } catch (error) {
      this?.log?.debug?.('PlaybackBegin decode failed for uuid "%s": %s', this.nest_google_device_uuid, String(error));
      return;
    }

    // Get the current time to use as a base for calculating packet timestamps as they come in
    // since they are rolling timestamps based on when playback started
    let now = Date.now();

    if (Array.isArray(decodedMessage?.channels) === true) {
      decodedMessage.channels.forEach((stream) => {
        // Find which channels match our video and audio streams
        if (stream.codec === this.codecs.video.toUpperCase()) {
          this.video = {
            id: stream.channelId,
            baseTimestamp: stream.startTimestamp,
            baseTime: now,
            sampleRate: stream.sampleRate,
          };
        }

        if (stream.codec === this.codecs.audio.toUpperCase()) {
          this.audio = {
            id: stream.channelId,
            baseTimestamp: stream.startTimestamp,
            baseTime: now,
            sampleRate: stream.sampleRate,
          };
        }
      });
    }

    // Since this is the beginning of playback, clear any active buffers contents
    this.#sessionId = decodedMessage?.sessionId;
    this.#packetBuffer = undefined;
    this.#packetOffset = undefined;
    this.#messages = [];

    this?.log?.debug?.('Playback started from "%s" with session ID "%s"', this.#host, this.#sessionId);
  }

  #handlePlaybackPacket(payload) {
    const calculateTimestamp = (delta, stream) => {
      if (
        typeof delta !== 'number' ||
        typeof stream?.sampleRate !== 'number' ||
        stream?.baseTime === undefined ||
        stream?.baseTimestamp === undefined
      ) {
        return Date.now();
      }

      let deltaTicks = stream.baseTimestamp + delta - stream.baseTimestamp;
      let deltaMs = (deltaTicks / stream.sampleRate) * 1000;
      return stream.baseTime + deltaMs;
    };

    // Decode playback packet
    if (Buffer.isBuffer(payload) === true && this.#protobufNexusTalk !== undefined && this.#protobufNexusTalk !== null) {
      let decodedMessage = undefined;
      let Type = this.#protobufNexusTalk.lookup('nest.nexustalk.v1.PlaybackPacket');
      let reader = new protobuf.Reader(payload);

      try {
        decodedMessage = Type.decode(reader).toJSON();
      } catch (error) {
        this?.log?.debug?.('Playback packet decode failed for uuid "%s": %s', this.nest_google_device_uuid, String(error));
        return;
      }

      // Set up a timeout to monitor for no packets received in a certain period
      // If it's triggered, we'll attempt to restart the stream and/or connection
      // <-- testing to see how often this occurs first
      clearTimeout(this.#stalledTimer);
      this.#stalledTimer = setTimeout(() => {
        this?.log?.debug?.(
          'We have not received any data from nexus in the past "%s" seconds for uuid "%s". Attempting restart',
          10,
          this.nest_google_device_uuid,
        );

        this.#requestReconnect(this.#host, 'stalled');
        this.close(false); // Close existing socket and reconnect
      }, 10000);

      // Timestamps are rolling — incremented from startTime using timestampDelta per packet

      // Handle video packet
      if (decodedMessage?.channelId !== undefined && decodedMessage.channelId === this.video?.id) {
        let ts = calculateTimestamp(decodedMessage.timestampDelta, this.video);
        this.add(Streamer.PACKET_TYPE.VIDEO, Buffer.from(decodedMessage.payload, 'base64'), ts);
      }

      // Handle audio packet
      if (decodedMessage?.channelId !== undefined && decodedMessage.channelId === this.audio?.id) {
        let ts = calculateTimestamp(decodedMessage.timestampDelta, this.audio);
        this.add(Streamer.PACKET_TYPE.AUDIO, Buffer.from(decodedMessage.payload, 'base64'), ts);
      }
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

      if (this.#sessionId !== undefined && decodedMessage.reason === 'USER_ENDED_SESSION') {
        // Normal playback ended ie: when we stopped playback
        this?.log?.debug?.('Playback ended on "%s"', this.#host);
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
      this.audio.talking = true;
      this?.log?.debug?.('Talking started on uuid "%s"', this.nest_google_device_uuid);
    }
  }

  #handleTalkbackEnd(payload) {
    // Decode talk end packet
    if (Buffer.isBuffer(payload) === true && this.#protobufNexusTalk !== undefined && this.#protobufNexusTalk !== null) {
      //let decodedMessage = this.#protobufNexusTalk.lookup('nest.nexustalk.v1.TalkbackEnd').decode(payload).toJSON();
      this.audio.talking = false;
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
      let newBuffer = Buffer.allocUnsafe(this.#packetBuffer.length * 2);
      this.#packetBuffer.copy(newBuffer, 0, 0, this.#packetOffset);
      this.#packetBuffer = newBuffer;
    }

    data.copy(this.#packetBuffer, this.#packetOffset);
    this.#packetOffset += data.length;

    while (this.#packetOffset >= 3) {
      let headerSize = 3;
      let packetType = this.#packetBuffer.readUInt8(0);
      let packetSize = this.#packetBuffer.readUInt16BE(1);

      if (packetType === PACKET_TYPE.LONG_PLAYBACK_PACKET) {
        headerSize = 5;
        packetSize = this.#packetBuffer.readUInt32BE(1);
      }

      if (this.#packetOffset < headerSize + packetSize) {
        break;
      }

      let protoBufPayload = this.#packetBuffer.subarray(headerSize, headerSize + packetSize);
      this.#packetBuffer.copy(this.#packetBuffer, 0, headerSize + packetSize, this.#packetOffset);
      this.#packetOffset -= headerSize + packetSize;

      switch (packetType) {
        case PACKET_TYPE.PING: {
          break;
        }

        case PACKET_TYPE.OK: {
          // process any pending messages we have stored
          this.#authorised = true; // OK message, means we're connected and authorised to Nexus
          for (let message = this.#messages.shift(); message; message = this.#messages.shift()) {
            this.#sendMessage(message.type, message.data);
          }

          // Periodically send PING message to keep stream alive
          clearInterval(this.#pingTimer);
          this.#pingTimer = setInterval(() => {
            this.#sendMessage(PACKET_TYPE.PING, Buffer.alloc(0));
          }, PING_INTERVAL);

          // Start processing data
          this.#startNexusData();
          break;
        }

        case PACKET_TYPE.ERROR: {
          this.#handleNexusError(protoBufPayload);
          break;
        }

        case PACKET_TYPE.PLAYBACK_BEGIN: {
          this.#handlePlaybackBegin(protoBufPayload);
          break;
        }

        case PACKET_TYPE.PLAYBACK_END: {
          this.#handlePlaybackEnd(protoBufPayload);
          break;
        }

        case PACKET_TYPE.PLAYBACK_PACKET:
        case PACKET_TYPE.LONG_PLAYBACK_PACKET: {
          this.#handlePlaybackPacket(protoBufPayload);
          break;
        }

        case PACKET_TYPE.REDIRECT: {
          this.#handleRedirect(protoBufPayload);
          break;
        }

        case PACKET_TYPE.TALKBACK_BEGIN: {
          this.#handleTalkbackBegin(protoBufPayload);
          break;
        }

        case PACKET_TYPE.TALKBACK_END: {
          this.#handleTalkbackEnd(protoBufPayload);
          break;
        }
      }
    }
  }

  #requestReconnect(host, reason) {
    // Request a reconnect once the current socket is closed.
    // This does NOT perform the reconnect immediately.
    // The actual reconnect is handled centrally in the socket 'close' handler.
    if (typeof host === 'string' && host !== '') {
      // Use provided host for reconnect (e.g. redirect, host change)
      this.#reconnectHost = host;
    }

    if ((this.#reconnectHost ?? '') === '') {
      // No explicit host provided, fallback to current or configured host
      this.#reconnectHost = this.#host ?? this.nexustalk_host;
    }

    // Mark reconnect as pending so the close handler can action it
    this.#reconnectPending = true;

    // Store reason for reconnect (debugging / logging purposes)
    this.#reconnectReason = reason;
  }
}
