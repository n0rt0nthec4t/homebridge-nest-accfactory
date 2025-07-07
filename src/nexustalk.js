// NexusTalk
// Part of homebridge-nest-accfactory
//
// Handles connection and data from Nest 'nexus' systems
//
// Credit to https://github.com/Brandawg93/homebridge-nest-cam for the work on the Nest Camera comms code on which this is based
//
// Code version 2025.07.07
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
import { fileURLToPath } from 'node:url';

// Define our modules
import Streamer from './streamer.js';

// Define constants
const PING_INTERVAL = 15000; // Ping interval to nexus server while stream active
const USER_AGENT = 'Nest/5.78.0 (iOScom.nestlabs.jasper.release) os=18.0'; // User Agent string
const __dirname = path.dirname(fileURLToPath(import.meta.url)); // Make a defined for JS __dirname

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
  token = undefined;
  tokenType = undefined;
  pingTimer = undefined; // Timer object for ping interval
  stalledTimer = undefined; // Timer object for no received data
  host = ''; // Host to connect to or connected too
  blankAudio = AAC_MONO_48000_BLANK;
  video = {}; // Video stream details once connected
  audio = {}; // Audio stream details once connected

  // Internal data only for this class
  #protobufNexusTalk = undefined; // Protobuf for NexusTalk
  #socket = undefined; // TCP socket object
  #packets = []; // Incoming packets
  #messages = []; // Incoming messages
  #authorised = false; // Have we been authorised
  #id = undefined; // Session ID

  // Codecs being used for video, audio and talking
  get codecs() {
    return {
      video: Streamer.CODEC_TYPE.H264, // Video codec
      audio: Streamer.CODEC_TYPE.AAC, // Audio codec
      talk: Streamer.CODEC_TYPE.SPEEX, // Talkback codec
    };
  }

  constructor(uuid, deviceData, options) {
    super(uuid, deviceData, options);

    if (fs.existsSync(path.resolve(__dirname + '/protobuf/nest/nexustalk.proto')) === true) {
      protobuf.util.Long = null;
      protobuf.configure();
      this.#protobufNexusTalk = protobuf.loadSync(path.resolve(__dirname + '/protobuf/nest/nexustalk.proto'));
    }

    // Store data we need from the device data passed it
    this.token = deviceData?.apiAccess?.token;
    this.tokenType = deviceData?.apiAccess?.oauth2 !== undefined ? 'google' : 'nest';
    this.host = deviceData?.streaming_host; // Host we'll connect to
  }

  // Class functions
  async connect(host) {
    // Clear any timers we have running
    clearInterval(this.pingTimer);
    clearTimeout(this.stalledTimer);
    this.pingTimer = undefined;
    this.stalledTimer = undefined;
    this.#id = undefined; // No session ID yet

    if (this.online === true && this.videoEnabled === true) {
      if (typeof host === 'undefined' || host === null) {
        // No host parameter passed in, so we'll set this to our internally stored host
        host = this.host;
      }

      this.connected = false; // Starting connection
      this?.log?.debug?.('Connection started to "%s"', host);
      this.host = host; // Update internal host name since we’re about to connect

      // Wrap tls.connect() in a Promise so we can await the TLS handshake
      await new Promise((resolve, reject) => {
        this.#socket = tls.connect({ host: host, port: 1443 }, () => {
          // Opened connection to Nexus server, so now need to authenticate ourselves
          this?.log?.debug?.('Connection established to "%s"', host);

          this.#socket.setKeepAlive(true); // Keep socket connection alive
          this.connected = true;
          this.#Authenticate(false); // Send authentication request
          resolve(); // Allow await connect() to continue
        });

        this.#socket.on('error', (err) => {
          // TLS error (could be refused, timeout, etc.)
          this?.log?.warn?.('TLS error on connect to "%s": %s', host, err?.message || err);
          this.connected = undefined;
          reject(err);
        });

        this.#socket.on('end', () => {});

        this.#socket.on('data', (data) => {
          this.#handleNexusData(data);
        });

        this.#socket.on('close', (hadError) => {
          this?.log?.debug?.('Connection closed to "%s"', host);

          clearInterval(this.pingTimer);
          clearTimeout(this.stalledTimer);
          this.pingTimer = undefined;
          this.stalledTimer = undefined;
          this.#authorised = false; // Since connection closed, we can't be authorised anymore
          this.#socket = undefined; // Clear socket object
          this.connected = undefined;
          this.#id = undefined; // Not an active session anymore

          if (hadError === true && (this.isStreaming() === true || this.isBuffering() === true)) {
            // We still have either active buffering occurring or output streams running
            // so attempt to restart connection to existing host
            this.connect(host);
          }
        });
      });
    }
  }

  async close(stopStreamFirst) {
    // Close an authenicated socket stream gracefully
    if (this.#socket !== undefined) {
      if (stopStreamFirst === true) {
        // Send a notifcation to nexus we're finished playback
        await this.#stopNexusData();
      }
      this.#socket.destroy();
    }

    this.connected = undefined;
    this.#socket = undefined;
    this.#id = undefined; // Not an active session anymore
    this.#packets = [];
    this.#messages = [];
    this.video = {};
    this.audio = {};
  }

  async onUpdate(deviceData) {
    if (typeof deviceData !== 'object') {
      return;
    }

    if (deviceData?.apiAccess?.token !== undefined && deviceData.apiAccess.token !== this.token) {
      // access token has changed so re-authorise
      this?.log?.debug?.('Access token has changed for uuid "%s". Updating token', this.nest_google_uuid);
      this.token = deviceData.apiAccess.token;

      if (this.#socket !== undefined) {
        this.#Authenticate(true); // Update authorisation only if connected
      }
    }

    if (deviceData?.streaming_host !== undefined && this.host !== deviceData.streaming_host) {
      this.host = deviceData.streaming_host;
      this?.log?.debug?.('New host has been requested for connection. Host requested is "%s"', this.host);
    }
  }

  sendTalkback(talkingBuffer) {
    if (Buffer.isBuffer(talkingBuffer) === false || this.#protobufNexusTalk === undefined || this.#id === undefined) {
      return;
    }

    // Encode audio packet for sending to camera
    let TraitMap = this.#protobufNexusTalk.lookup('nest.nexustalk.v1.AudioPayload');
    if (TraitMap !== null) {
      let encodedData = TraitMap.encode(
        TraitMap.fromObject({
          payload: talkingBuffer,
          sessionId: this.#id,
          codec: this.codecs.talk.toUpperCase(),
          sampleRate: 16000,
        }),
      ).finish();
      this.#sendMessage(PACKET_TYPE.AUDIO_PAYLOAD, encodedData);
    }
  }

  #startNexusData() {
    if (this.videoEnabled === false || this.online === false || this.#protobufNexusTalk === undefined) {
      return;
    }

    // Setup streaming profiles
    // We'll use the highest profile as the main, with others for fallback
    let otherProfiles = ['VIDEO_H264_530KBIT_L31', 'VIDEO_H264_100KBIT_L30'];

    if (this.audioEnabled === true) {
      // Include AAC profile if audio is enabled on camera
      otherProfiles.push('AUDIO_AAC');
    }

    let TraitMap = this.#protobufNexusTalk.lookup('nest.nexustalk.v1.StartPlayback');
    if (TraitMap !== null) {
      let encodedData = TraitMap.encode(
        TraitMap.fromObject({
          sessionId: Math.floor(Math.random() * (100 - 1) + 1),
          profile: 'VIDEO_H264_2MBIT_L40',
          otherProfiles: otherProfiles,
          profileNotFoundAction: 'REDIRECT',
        }),
      ).finish();
      this.#sendMessage(PACKET_TYPE.START_PLAYBACK, encodedData);
    }
  }

  #stopNexusData() {
    if (this.#id !== undefined && this.#protobufNexusTalk !== undefined) {
      let TraitMap = this.#protobufNexusTalk.lookup('nest.nexustalk.v1.StopPlayback');
      if (TraitMap !== null) {
        let encodedData = TraitMap.encode(
          TraitMap.fromObject({
            sessionId: this.#id,
          }),
        ).finish();
        this.#sendMessage(PACKET_TYPE.STOP_PLAYBACK, encodedData);
      }
    }
  }

  #sendMessage(type, data) {
    if (this.#socket?.readyState !== 'open' || (type !== PACKET_TYPE.HELLO && this.#authorised === false)) {
      // We're not connect and/or authorised yet, so 'cache' message for processing once this occurs
      this.#messages.push({ type: type, data: data });
      return;
    }

    // Create nexusTalk message header
    let header = Buffer.alloc(3);
    if (type !== PACKET_TYPE.LONG_PLAYBACK_PACKET) {
      header.writeUInt8(type, 0);
      header.writeUInt16BE(data.length, 1);
    }
    if (type === PACKET_TYPE.LONG_PLAYBACK_PACKET) {
      header = Buffer.alloc(5);
      header.writeUInt8(type, 0);
      header.writeUInt32BE(data.length, 1);
    }

    // write our composed message out to the socket back to NexusTalk
    this.#socket.write(Buffer.concat([header, Buffer.from(data)]), () => {
      // Message sent. Don't do anything?
    });
  }

  #Authenticate(reauthorise) {
    // Authenticate over created socket connection
    if (this.#protobufNexusTalk !== undefined) {
      this.#authorised = false; // We're nolonger authorised

      let authoriseRequest = null;
      let TraitMap = this.#protobufNexusTalk.lookup('nest.nexustalk.v1.AuthoriseRequest');
      if (TraitMap !== null) {
        authoriseRequest = TraitMap.encode(
          TraitMap.fromObject(
            this.tokenType === 'nest' ? { sessionToken: this.token } : this.tokenType === 'google' ? { oliveToken: this.token } : {},
          ),
        ).finish();
      }

      if (reauthorise === true && authoriseRequest !== null) {
        // Request to re-authorise only
        this?.log?.debug?.('Re-authentication requested to "%s"', this.host);
        this.#sendMessage(PACKET_TYPE.AUTHORIZE_REQUEST, authoriseRequest);
      }

      if (reauthorise === false && authoriseRequest !== null) {
        // This isn't a re-authorise request, so perform 'Hello' packet
        let TraitMap = this.#protobufNexusTalk.lookup('nest.nexustalk.v1.Hello');
        if (TraitMap !== null) {
          this?.log?.debug?.('Performing authentication to "%s"', this.host);

          let encodedData = TraitMap.encode(
            TraitMap.fromObject({
              protocolVersion: 'VERSION_3',
              uuid: this.nest_google_uuid.split(/[._]+/)[1],
              requireConnectedCamera: false,
              USER_AGENT: USER_AGENT,
              deviceId: crypto.randomUUID(),
              clientType: 'IOS',
              authoriseRequest: authoriseRequest,
            }),
          ).finish();
          this.#sendMessage(PACKET_TYPE.HELLO, encodedData);
        }
      }
    }
  }

  #handleRedirect(payload) {
    let redirectToHost = undefined;
    if (typeof payload === 'object' && this.#protobufNexusTalk !== undefined) {
      let decodedMessage = this.#protobufNexusTalk.lookup('nest.nexustalk.v1.Redirect').decode(payload).toJSON();
      redirectToHost = decodedMessage?.newHost;
    }
    if (typeof payload === 'string') {
      // Payload parameter is a string, we'll assume this is a direct hostname
      redirectToHost = payload;
    }

    if (typeof redirectToHost !== 'string' || redirectToHost === '') {
      return;
    }

    this?.log?.debug?.('Redirect requested from "%s" to "%s"', this.host, redirectToHost);

    // Setup listener for socket close event. Once socket is closed, we'll perform the redirect
    this.#socket?.on?.('close', () => {
      this.connect(redirectToHost); // Connect to new host
    });
    this.close(true); // Close existing socket
  }

  #handlePlaybackBegin(payload) {
    if (typeof payload === 'object' && this.#protobufNexusTalk !== undefined) {
      let decodedMessage = this.#protobufNexusTalk.lookup('nest.nexustalk.v1.PlaybackBegin').decode(payload).toJSON();
      decodedMessage.channels.forEach((stream) => {
        // Find which channels match our video and audio streams
        if (stream.codecType === this.codecs.video.toUpperCase()) {
          this.video = {
            id: stream.channelId,
            baseTimestamp: stream.startTimestamp,
            baseTime: Date.now(),
            sampleRate: stream.sampleRate,
          };
        }
        if (stream.codecType === this.codecs.audio.toUpperCase()) {
          this.audio = {
            id: stream.channelId,
            baseTimestamp: stream.startTimestamp,
            baseTime: Date.now(),
            sampleRate: stream.sampleRate,
          };
        }
      });

      // Since this is the beginning of playback, clear any active buffers contents
      this.#id = decodedMessage.sessionId;
      this.#packets = [];
      this.#messages = [];

      this?.log?.debug?.('Playback started from "%s" with session ID "%s"', this.host, this.#id);
    }
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
    if (typeof payload === 'object' && this.#protobufNexusTalk !== undefined) {
      let decodedMessage = this.#protobufNexusTalk.lookup('nest.nexustalk.v1.PlaybackPacket').decode(payload).toJSON();

      // Setup up a timeout to monitor for no packets recieved in a certain period
      // If its trigger, we'll attempt to restart the stream and/or connection
      // <-- testing to see how often this occurs first
      clearTimeout(this.stalledTimer);
      this.stalledTimer = setTimeout(() => {
        this?.log?.debug?.(
          'We have not received any data from nexus in the past "%s" seconds for uuid "%s". Attempting restart',
          10,
          this.nest_google_uuid,
        );

        // Setup listener for socket close event. Once socket is closed, we'll perform the re-connection
        this.#socket?.on?.('close', () => {
          this.connect(); // try reconnection
        });
        this.close(false); // Close existing socket
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
    // Decode playpack ended packet
    if (typeof payload === 'object' && this.#protobufNexusTalk !== undefined) {
      let decodedMessage = this.#protobufNexusTalk.lookup('nest.nexustalk.v1.PlaybackEnd').decode(payload).toJSON();

      if (this.#id !== undefined && decodedMessage.reason === 'USER_ENDED_SESSION') {
        // Normal playback ended ie: when we stopped playback
        this?.log?.debug?.('Playback ended on "%s"', this.host);
      }

      if (decodedMessage.reason !== 'USER_ENDED_SESSION') {
        // Error during playback, so we'll attempt to restart by reconnection to host
        this?.log?.debug?.('Playback ended on "%s" with error "%s". Attempting reconnection', this.host, decodedMessage.reason);

        // Setup listener for socket close event. Once socket is closed, we'll perform the re-connection
        this.#socket?.on?.('close', () => {
          this.connect(); // try reconnection to existing host
        });
        this.close(false); // Close existing socket
      }
    }
  }

  #handleNexusError(payload) {
    // Decode error packet
    if (typeof payload === 'object' && this.#protobufNexusTalk !== undefined) {
      let decodedMessage = this.#protobufNexusTalk.lookup('nest.nexustalk.v1.Error').decode(payload).toJSON();
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
    if (typeof payload === 'object' && this.#protobufNexusTalk !== undefined) {
      //let decodedMessage = this.#protobufNexusTalk.lookup('nest.nexustalk.v1.TalkbackBegin').decode(payload).toJSON();
      this.audio.talking = true;
      this?.log?.debug?.('Talking started on uuid "%s"', this.nest_google_uuid);
    }
  }

  #handleTalkbackEnd(payload) {
    // Decode talk end packet
    if (typeof payload === 'object' && this.#protobufNexusTalk !== undefined) {
      //let decodedMessage = this.#protobufNexusTalk.lookup('nest.nexustalk.v1.TalkbackEnd').decode(payload).toJSON();
      this.audio.talking = false;
      this?.log?.debug?.('Talking ended on uuid "%s"', this.nest_google_uuid);
    }
  }

  #handleNexusData(data) {
    // Process the rawdata from our socket connection and convert into nexus packets to take action against
    this.#packets = this.#packets.length === 0 ? data : Buffer.concat([this.#packets, data]);

    while (this.#packets.length >= 3) {
      let headerSize = 3;
      let packetType = this.#packets.readUInt8(0);
      let packetSize = this.#packets.readUInt16BE(1);

      if (packetType === PACKET_TYPE.LONG_PLAYBACK_PACKET) {
        headerSize = 5;
        packetSize = this.#packets.readUInt32BE(1);
      }

      if (this.#packets.length < headerSize + packetSize) {
        // We dont have enough data in the buffer yet to process the full packet
        // so, exit loop and await more data
        break;
      }

      let protoBufPayload = this.#packets.subarray(headerSize, headerSize + packetSize);
      this.#packets = this.#packets.subarray(headerSize + packetSize);

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
          clearInterval(this.pingTimer);
          this.pingTimer = setInterval(() => {
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
}
