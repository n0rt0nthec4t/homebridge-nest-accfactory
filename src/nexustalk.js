// NexusTalk
// Part of homebridge-nest-accfactory
//
// Handles connection and data from Nest 'nexus' systems
//
// Code version 4/9/2024
// Mark Hulskamp
'use strict';

// Define external library requirements
import protoBuf from 'pbf'; // Proto buffer

// Define nodejs module requirements
import { Buffer } from 'node:buffer';
import { setInterval, clearInterval, setTimeout, clearTimeout } from 'node:timers';
import tls from 'tls';
import crypto from 'crypto';

// Define our modules
import Streamer from './streamer.js';

// Define constants
const PINGINTERVAL = 15000; // Ping interval to nexus server while stream active

const CodecType = {
  SPEEX: 0,
  PCM_S16_LE: 1,
  H264: 2,
  AAC: 3,
  OPUS: 4,
  META: 5,
  DIRECTORS_CUT: 6,
};

const StreamProfile = {
  AVPROFILE_MOBILE_1: 1,
  AVPROFILE_HD_MAIN_1: 2,
  AUDIO_AAC: 3,
  AUDIO_SPEEX: 4,
  AUDIO_OPUS: 5,
  VIDEO_H264_50KBIT_L12: 6,
  VIDEO_H264_530KBIT_L31: 7,
  VIDEO_H264_100KBIT_L30: 8,
  VIDEO_H264_2MBIT_L40: 9,
  VIDEO_H264_50KBIT_L12_THUMBNAIL: 10,
  META: 11,
  DIRECTORS_CUT: 12,
  AUDIO_OPUS_LIVE: 13,
  VIDEO_H264_L31: 14,
  VIDEO_H264_L40: 15,
};

const ErrorCode = {
  ERROR_CAMERA_NOT_CONNECTED: 1,
  ERROR_ILLEGAL_PACKET: 2,
  ERROR_AUTHORIZATION_FAILED: 3,
  ERROR_NO_TRANSCODER_AVAILABLE: 4,
  ERROR_TRANSCODE_PROXY_ERROR: 5,
  ERROR_INTERNAL: 6,
};

const PacketType = {
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

const ProtocolVersion = {
  VERSION_1: 1,
  VERSION_2: 2,
  VERSION_3: 3,
};

const ClientType = {
  ANDROID: 1,
  IOS: 2,
  WEB: 3,
};

// nexusTalk object
export default class NexusTalk extends Streamer {
  token = undefined;
  tokenType = undefined;
  uuid = undefined;
  id = undefined; // Session ID
  authorised = false; // Have wee been authorised
  pingTimer = undefined; // Timer object for ping interval
  stalledTimer = undefined; // Timer object for no received data
  packets = []; // Incoming packets
  messages = []; // Incoming messages
  video = {}; // Video stream details
  audio = {}; // Audio stream details

  constructor(deviceData, options) {
    super(deviceData, options);

    // Store data we need from the device data passed it
    this.token = deviceData?.apiAccess.token;
    if (deviceData?.apiAccess?.key === 'Authorization') {
      this.tokenType = 'google';
    }
    if (deviceData?.apiAccess?.key === 'cookie') {
      this.tokenType = 'nest';
    }
    this.uuid = deviceData?.uuid;
    this.host = deviceData?.streaming_host; // Host we'll connect to

    this.pendingHost = null;
    this.weDidClose = true; // Flag if we did the socket close gracefully

    // If specified option to start buffering, kick off
    if (typeof options?.buffer === 'boolean' && options.buffer === true) {
      this.startBuffering();
    }
  }

  // Class functions
  connect(host) {
    // Clear any timers we have running
    this.pingTimer = clearInterval(this.pingTimer);
    this.stalledTimer = clearInterval(this.stalledTimer);

    this.id = undefined; // No session ID yet

    if (this.online === true && this.videoEnabled === true) {
      if (typeof host === 'undefined' || host === null) {
        // No host parameter passed in, so we'll set this to our internally stored host
        host = this.host;
      }

      if (this.pendingHost !== null) {
        host = this.pendingHost;
        this.pendingHost = null;
      }

      this?.log?.debug && this.log.debug('Starting connection to "%s"', host);

      this.socket = tls.connect({ host: host, port: 1443 }, () => {
        // Opened connection to Nexus server, so now need to authenticate ourselves
        this?.log?.debug && this.log.debug('Connection established to "%s"', host);

        this.socket.setKeepAlive(true); // Keep socket connection alive
        this.host = host; // update internal host name since we've connected
        this.#Authenticate(false);
      });

      this.socket.on('error', () => {});

      this.socket.on('end', () => {});

      this.socket.on('data', (data) => {
        this.#handleNexusData(data);
      });

      this.socket.on('close', (hadError) => {
        if (hadError === true) {
          //
        }
        let normalClose = this.weDidClose; // Cache this, so can reset it below before we take action

        this.stalledTimer = clearTimeout(this.stalledTimer); // Clear stalled timer
        this.pingTimer = clearInterval(this.pingTimer); // Clear ping timer
        this.authorised = false; // Since connection close, we can't be authorised anymore
        this.socket = null; // Clear socket object
        this.id = undefined; // Not an active session anymore

        this.weDidClose = false; // Reset closed flag

        this?.log?.debug && this.log.debug('Connection closed to "%s"', host);

        if (normalClose === false && this.haveOutputs() === true) {
          // We still have either active buffering occuring or output streams running
          // so attempt to restart connection to existing host
          this.connect(host);
        }
      });
    }
  }

  close(stopStreamFirst) {
    // Close an authenicated socket stream gracefully
    if (this.socket !== null) {
      if (stopStreamFirst === true) {
        // Send a notifcation to nexus we're finished playback
        this.#stopNexusData();
      }
      this.socket.destroy();
    }

    this.socket = null;
    this.id = undefined; // Not an active session anymore
    this.packets = [];
    this.messages = [];

    this.weDidClose = true; // Flag we did the socket close
  }

  update(deviceData) {
    if (typeof deviceData !== 'object') {
      return;
    }

    if (deviceData.apiAccess.token !== this.token) {
      // access token has changed so re-authorise
      this.token = deviceData.apiAccess.token;

      if (this.socket !== null) {
        this.#Authenticate(true); // Update authorisation only if connected
      }
    }

    if (this.host !== deviceData.streaming_host) {
      this.host = deviceData.streaming_host;
      this?.log?.debug && this.log.debug('NexusTalk has requested a new host "%s" for connection', this.host);
    }

    // Let our parent handle the remaining updates
    super.update(deviceData);
  }

  talkingAudio(talkingData) {
    // Encode audio packet for sending to camera
    let audioBuffer = new protoBuf();
    audioBuffer.writeBytesField(1, talkingData); // audio data
    audioBuffer.writeVarintField(2, this.id); // session ID
    audioBuffer.writeVarintField(3, CodecType.SPEEX); // codec
    audioBuffer.writeVarintField(4, 16000); // sample rate, 16k
    //audioBuffer.writeVarintField(5, ????);  // Latency measure tag. What does this do?
    this.#sendMessage(PacketType.AUDIO_PAYLOAD, audioBuffer.finish());
  }

  #startNexusData() {
    if (this.videoEnabled === false || this.online === false) {
      return;
    }

    // Setup streaming profiles
    // We'll use the highest profile as the main, with others for fallback
    let otherProfiles = [];
    otherProfiles.push(StreamProfile.VIDEO_H264_530KBIT_L31); // Medium quality
    otherProfiles.push(StreamProfile.VIDEO_H264_100KBIT_L30); // Low quality

    if (this.audioEnabled === true) {
      // Include AAC profile if audio is enabled on camera
      otherProfiles.push(StreamProfile.AUDIO_AAC);
    }

    let startBuffer = new protoBuf();
    startBuffer.writeVarintField(1, Math.floor(Math.random() * (100 - 1) + 1)); // Random session ID between 1 and 100);
    startBuffer.writeVarintField(2, StreamProfile.VIDEO_H264_2MBIT_L40); // Default profile. ie: high quality
    otherProfiles.forEach((otherProfile) => {
      startBuffer.writeVarintField(6, otherProfile); // Other supported profiles
    });

    this.#sendMessage(PacketType.START_PLAYBACK, startBuffer.finish());
  }

  #stopNexusData() {
    let stopBuffer = new protoBuf();
    stopBuffer.writeVarintField(1, this.id); // Session ID
    this.#sendMessage(PacketType.STOP_PLAYBACK, stopBuffer.finish());
  }

  #sendMessage(type, data) {
    if (this.socket === null || this.socket.readyState !== 'open' || (type !== PacketType.HELLO && this.authorised === false)) {
      // We're not connect and/or authorised yet, so 'cache' message for processing once this occurs
      this.messages.push({ type: type, data: data });
      return;
    }

    // Create nexusTalk message header
    let header = Buffer.alloc(3);
    if (type !== PacketType.LONG_PLAYBACK_PACKET) {
      header.writeUInt8(type, 0);
      header.writeUInt16BE(data.length, 1);
    }
    if (type === PacketType.LONG_PLAYBACK_PACKET) {
      header = Buffer.alloc(5);
      header.writeUInt8(type, 0);
      header.writeUInt32BE(data.length, 1);
    }

    // write our composed message out to the socket back to NexusTalk
    this.socket.write(Buffer.concat([header, Buffer.from(data)]), () => {
      // Message sent. Don't do anything?
    });
  }

  #Authenticate(reauthorise) {
    // Authenticate over created socket connection
    let tokenBuffer = new protoBuf();
    let helloBuffer = new protoBuf();

    this.authorised = false; // We're nolonger authorised

    if (this.tokenType === 'nest') {
      tokenBuffer.writeStringField(1, this.token); // Tag 1, session token, Nest auth accounts
      helloBuffer.writeStringField(4, this.token); // Tag 4, session token, Nest auth accounts
    }
    if (this.tokenType === 'google') {
      tokenBuffer.writeStringField(4, this.token); // Tag 4, olive token, Google auth accounts
      helloBuffer.writeBytesField(12, tokenBuffer.finish()); // Tag 12, olive token, Google auth accounts
    }
    if (typeof reauthorise === 'boolean' && reauthorise === true) {
      // Request to re-authorise only
      this?.log?.debug && this.log.debug('Re-authentication requested to "%s"', this.host);
      this.#sendMessage(PacketType.AUTHORIZE_REQUEST, tokenBuffer.finish());
    } else {
      // This isn't a re-authorise request, so perform 'Hello' packet
      this?.log?.debug && this.log.debug('Performing authentication to "%s"', this.host);
      helloBuffer.writeVarintField(1, ProtocolVersion.VERSION_3);
      helloBuffer.writeStringField(2, this.uuid.split('.')[1]); // UUID should be 'quartz.xxxxxx'. We want the xxxxxx part
      helloBuffer.writeBooleanField(3, false); // Doesnt required a connected camera
      helloBuffer.writeStringField(6, crypto.randomUUID()); // Random UUID for this connection attempt
      helloBuffer.writeStringField(7, 'Nest/5.75.0 (iOScom.nestlabs.jasper.release) os=17.4.1');
      helloBuffer.writeVarintField(9, ClientType.IOS);
      this.#sendMessage(PacketType.HELLO, helloBuffer.finish());
    }
  }

  #handleRedirect(payload) {
    let redirectToHost = undefined;
    if (typeof payload === 'object') {
      // Payload parameter is an object, we'll assume its a payload packet
      // Decode redirect packet to determine new host
      let packet = payload.readFields(
        (tag, obj, protoBuf) => {
          if (tag === 1) {
            obj.new_host = protoBuf.readString(); // new host
          }
          if (tag === 2) {
            obj.is_transcode = protoBuf.readBoolean();
          }
        },
        { new_host: '', is_transcode: false },
      );

      redirectToHost = packet.new_host;
    }
    if (typeof payload === 'string') {
      // Payload parameter is a string, we'll assume this is a direct hostname
      redirectToHost = payload;
    }

    if (typeof redirectToHost !== 'string' || redirectToHost === '') {
      return;
    }

    this?.log?.debug && this.log.debug('Redirect requested from "%s" to "%s"', this.host, redirectToHost);

    // Setup listener for socket close event. Once socket is closed, we'll perform the redirect
    this.socket &&
      this.socket.on('close', () => {
        this.connect(redirectToHost); // Connect to new host
      });
    this.close(true); // Close existing socket
  }

  #handlePlaybackBegin(payload) {
    // Decode playback begin packet
    let packet = payload.readFields(
      (tag, obj, protoBuf) => {
        if (tag === 1) {
          obj.session_id = protoBuf.readVarint();
        }
        if (tag === 2) {
          obj.channels.push(
            protoBuf.readFields(
              (tag, obj, protoBuf) => {
                if (tag === 1) {
                  obj.channel_id = protoBuf.readVarint();
                }
                if (tag === 2) {
                  obj.codec_type = protoBuf.readVarint();
                }
                if (tag === 3) {
                  obj.sample_rate = protoBuf.readVarint();
                }
                if (tag === 4) {
                  obj.private_data.push(protoBuf.readBytes());
                }
                if (tag === 5) {
                  obj.start_time = protoBuf.readDouble();
                }
                if (tag === 6) {
                  obj.udp_ssrc = protoBuf.readVarint();
                }
                if (tag === 7) {
                  obj.rtp_start_time = protoBuf.readVarint();
                }
                if (tag === 8) {
                  obj.profile = protoBuf.readVarint();
                }
              },
              { channel_id: 0, codec_type: 0, sample_rate: 0, private_data: [], start_time: 0, udp_ssrc: 0, rtp_start_time: 0, profile: 3 },
              protoBuf.readVarint() + protoBuf.pos,
            ),
          );
        }
        if (tag === 3) {
          obj.srtp_master_key = protoBuf.readBytes();
        }
        if (tag === 4) {
          obj.srtp_master_salt = protoBuf.readBytes();
        }
        if (tag === 5) {
          obj.fec_k_val = protoBuf.readVarint();
        }
        if (tag === 6) {
          obj.fec_n_val = protoBuf.readVarint();
        }
      },
      { session_id: 0, channels: [], srtp_master_key: null, srtp_master_salt: null, fec_k_val: 0, fec_n_val: 0 },
    );

    packet.channels &&
      packet.channels.forEach((stream) => {
        // Find which channels match our video and audio streams
        if (stream.codec_type === CodecType.H264) {
          this.video = {
            channel_id: stream.channel_id,
            start_time: Date.now() + stream.start_time,
            sample_rate: stream.sample_rate,
            timestamp_delta: 0,
          };
        }
        if (stream.codec_type === CodecType.AAC || stream.codec_type === CodecType.OPUS || stream.codec_type === CodecType.SPEEX) {
          this.audio = {
            channel_id: stream.channel_id,
            start_time: Date.now() + stream.start_time,
            sample_rate: stream.sample_rate,
            timestamp_delta: 0,
          };
        }
      });

    // Since this is the beginning of playback, clear any active buffers contents
    this.id = packet.session_id;
    this.packets = [];
    this.messages = [];

    this?.log?.debug && this.log.debug('Playback started from "%s" with session ID "%s"', this.host, this.id);
  }

  #handlePlaybackPacket(payload) {
    // Decode playback packet
    let packet = payload.readFields(
      (tag, obj, protoBuf) => {
        if (tag === 1) {
          obj.session_id = protoBuf.readVarint();
        }
        if (tag === 2) {
          obj.channel_id = protoBuf.readVarint();
        }
        if (tag === 3) {
          obj.timestamp_delta = protoBuf.readSVarint();
        }
        if (tag === 4) {
          obj.payload = protoBuf.readBytes();
        }
        if (tag === 5) {
          obj.latency_rtp_sequence = protoBuf.readVarint();
        }
        if (tag === 6) {
          obj.latency_rtp_ssrc = protoBuf.readVarint();
        }
        if (tag === 7) {
          obj.directors_cut_regions.push(
            protoBuf.readFields(
              (tag, obj, protoBuf) => {
                if (tag === 1) {
                  obj.id = protoBuf.readVarint();
                }
                if (tag === 2) {
                  obj.left = protoBuf.readVarint();
                }
                if (tag === 3) {
                  obj.right = protoBuf.readVarint();
                }
                if (tag === 4) {
                  obj.top = protoBuf.readVarint();
                }
                if (tag === 5) {
                  obj.bottom = protoBuf.readVarint();
                }
              },
              {
                // Defaults
                id: 0,
                left: 0,
                right: 0,
                top: 0,
                bottom: 0,
              },
              protoBuf.readVarint() + protoBuf.pos,
            ),
          );
        }
      },
      {
        // Defaults
        session_id: 0,
        channel_id: 0,
        timestamp_delta: 0,
        payload: null,
        latency_rtp_sequence: 0,
        latency_rtp_ssrc: 0,
        directors_cut_regions: [],
      },
    );

    // Setup up a timeout to monitor for no packets recieved in a certain period
    // If its trigger, we'll attempt to restart the stream and/or connection
    // <-- testing to see how often this occurs first
    this.stalledTimer = clearTimeout(this.stalledTimer);
    this.stalledTimer = setTimeout(() => {
      this?.log?.debug && this.log.debug('We have not received any data from nexus in the past "%s" seconds. Attempting restart', 8);

      // Setup listener for socket close event. Once socket is closed, we'll perform the re-connection
      this.socket &&
        this.socket.on('close', () => {
          this.connect(this.host); // try reconnection
        });
      this.close(false); // Close existing socket
    }, 8000);

    // Handle video packet
    if (packet.channel_id === this.video.channel_id) {
      this.video.timestamp_delta += packet.timestamp_delta;
      this.addToOutput('video', this.video.start_time + this.video.timestamp_delta, packet.payload);
    }

    // Handle audio packet
    if (packet.channel_id === this.audio.channel_id) {
      this.audio.timestamp_delta += packet.timestamp_delta;
      this.addToOutput('audio', this.audio.start_time + this.audio.timestamp_delta, packet.payload);
    }
  }

  #handlePlaybackEnd(payload) {
    // Decode playpack ended packet
    let packet = payload.readFields(
      (tag, obj, protoBuf) => {
        if (tag === 1) {
          obj.session_id = protoBuf.readVarint();
        }
        if (tag === 2) {
          obj.reason = protoBuf.readVarint();
        }
      },
      { session_id: 0, reason: 0 },
    );

    if (this.id !== null && packet.reason === 0) {
      // Normal playback ended ie: when we stopped playback
      this?.log?.debug && this.log.debug('Playback ended on "%s"', this.host);
    }

    if (packet.reason !== 0) {
      // Error during playback, so we'll attempt to restart by reconnection to host
      this?.log?.debug && this.log.debug('Playback ended on "%s" with error "%s". Attempting reconnection', this.host, packet.reason);

      // Setup listener for socket close event. Once socket is closed, we'll perform the re-connection
      this.socket &&
        this.socket.on('close', () => {
          this.connect(this.host); // try reconnection to existing host
        });
      this.close(false); // Close existing socket
    }
  }

  #handleNexusError(payload) {
    // Decode error packet
    let packet = payload.readFields(
      (tag, obj, protoBuf) => {
        if (tag === 1) {
          obj.code = protoBuf.readVarint();
        }
        if (tag === 2) {
          obj.message = protoBuf.readString();
        }
      },
      { code: 1, message: '' },
    );

    if (packet.code === ErrorCode.ERROR_AUTHORIZATION_FAILED) {
      // NexusStreamer Updating authentication
      this.#Authenticate(true); // Update authorisation only
    } else {
      // NexusStreamer Error, packet.message contains the message
      this?.log?.debug && this.log.debug('Error', packet.message);
    }
  }

  #handleTalkbackBegin(payload) {
    // Decode talk begin packet
    let packet = payload.readFields(
      (tag, obj, protoBuf) => {
        if (tag === 1) {
          obj.user_id = protoBuf.readString();
        }
        if (tag === 2) {
          obj.session_id = protoBuf.readVarint();
        }
        if (tag === 3) {
          obj.quick_action_id = protoBuf.readVarint();
        }
        if (tag === 4) {
          obj.device_id = protoBuf.readString();
        }
      },
      { user_id: '', session_id: 0, quick_action_id: 0, device_id: '' },
    );

    this?.log?.debug && this.log.debug('Talkback started on "%s"', packet.device_id);
  }

  #handleTalkbackEnd(payload) {
    // Decode talk end packet
    let packet = payload.readFields(
      (tag, obj, protoBuf) => {
        if (tag === 1) {
          obj.user_id = protoBuf.readString();
        }
        if (tag === 2) {
          obj.session_id = protoBuf.readVarint();
        }
        if (tag === 3) {
          obj.quick_action_id = protoBuf.readVarint();
        }
        if (tag === 4) {
          obj.device_id = protoBuf.readString();
        }
      },
      { user_id: '', session_id: 0, quick_action_id: 0, device_id: '' },
    );

    this?.log?.debug && this.log.debug('Talkback ended on "%s"', packet.device_id);
  }

  #handleNexusData(data) {
    // Process the rawdata from our socket connection and convert into nexus packets to take action against
    this.packets = this.packets.length === 0 ? data : Buffer.concat([this.packets, data]);

    while (this.packets.length >= 3) {
      let headerSize = 3;
      let packetType = this.packets.readUInt8(0);
      let packetSize = this.packets.readUInt16BE(1);

      if (packetType === PacketType.LONG_PLAYBACK_PACKET) {
        headerSize = 5;
        packetSize = this.packets.readUInt32BE(1);
      }

      if (this.packets.length < headerSize + packetSize) {
        // We dont have enough data in the buffer yet to process the full packet
        // so, exit loop and await more data
        break;
      }

      let protoBufPayload = new protoBuf(this.packets.slice(headerSize, headerSize + packetSize));
      switch (packetType) {
        case PacketType.PING: {
          break;
        }

        case PacketType.OK: {
          // process any pending messages we have stored
          this.authorised = true; // OK message, means we're connected and authorised to Nexus
          for (let message = this.messages.shift(); message; message = this.messages.shift()) {
            this.#sendMessage(message.type, message.data);
          }

          // Periodically send PING message to keep stream alive
          this.pingTimer = clearInterval(this.pingTimer);
          this.pingTimer = setInterval(() => {
            this.#sendMessage(PacketType.PING, Buffer.alloc(0));
          }, PINGINTERVAL);

          // Start processing data
          this.#startNexusData();
          break;
        }

        case PacketType.ERROR: {
          this.#handleNexusError(protoBufPayload);
          break;
        }

        case PacketType.PLAYBACK_BEGIN: {
          this.#handlePlaybackBegin(protoBufPayload);
          break;
        }

        case PacketType.PLAYBACK_END: {
          this.#handlePlaybackEnd(protoBufPayload);
          break;
        }

        case PacketType.PLAYBACK_PACKET:
        case PacketType.LONG_PLAYBACK_PACKET: {
          this.#handlePlaybackPacket(protoBufPayload);
          break;
        }

        case PacketType.REDIRECT: {
          this.#handleRedirect(protoBufPayload);
          break;
        }

        case PacketType.TALKBACK_BEGIN: {
          this.#handleTalkbackBegin(protoBufPayload);
          break;
        }

        case PacketType.TALKBACK_END: {
          this.#handleTalkbackEnd(protoBufPayload);
          break;
        }
      }

      // Remove the section of data we've just processed from our pending buffer
      this.packets = this.packets.slice(headerSize + packetSize);
    }
  }
}
