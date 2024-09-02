// nexusstreamer device class
//
// Buffers a single audio/video stream from Nest 'nexus' systems.
// Allows multiple HomeKit devices to connect to the single stream
// for live viewing and/or recording
//
// Mark Hulskamp
// 1/9/2024
'use strict';

// Define external library requirements
import protoBuf from 'pbf'; // Proto buffer

// Define nodejs module requirements
import { Buffer } from 'node:buffer';
import { setInterval, clearInterval, setTimeout, clearTimeout } from 'node:timers';
import fs from 'fs';
import path from 'node:path';
import tls from 'tls';
import crypto from 'crypto';
import { fileURLToPath } from 'node:url';

// Define constants
const PINGINTERVAL = 15000; // Ping interval to nexus server while stream active
const CAMERAOFFLINEH264FILE = 'Nest_camera_offline.h264'; // Camera offline H264 frame file
const CAMERAOFFH264FILE = 'Nest_camera_off.h264'; // Camera off H264 frame file
const CAMERACONNECTING264FILE = 'Nest_camera_connecting.h264'; // Camera connecting H264 frame file

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

/*const H264NALUnitType = {
  STAP_A: 0x18,
  FU_A: 0x1c,
  NON_IDR: 0x01,
  IDR: 0x05,
  SEI: 0x06,
  SPS: 0x07,
  PPS: 0x08,
  AUD: 0x09,
};*/

const H264NALStartcode = Buffer.from([0x00, 0x00, 0x00, 0x01]);
const AACAudioSilence = Buffer.from([0x21, 0x10, 0x01, 0x78, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

const __dirname = path.dirname(fileURLToPath(import.meta.url)); // Make a defined for JS __dirname

// NeuxsStreamer object
export default class NexusStreamer {
  cameraOfflineFrame = undefined;
  cameraVideoOffFrame = undefined;
  cameraConnectingVideoFrame = undefined;

  nexusTalk = {
    id: undefined, // Session ID
    authorised: false, // Have wee been authorised
    host: '', // Host to connect to or connected too
    socket: null, // TCP socket object
    pingTimer: undefined, // Timer object for ping interval
    stalledTimer: undefined, // Timer object for no received data
    outputTimer: undefined, // Timer for non-block loop stream outputs
    packets: [], // Incoming packets
    messages: [], // Incoming messages
    video: {}, // Video stream details
    audio: {}, // Audio stream details
    outputs: {}, // Output streams ie: buffer, live, record
  };

  token = undefined;
  tokenType = undefined;
  videoEnabled = undefined;
  audioEnabled = undefined;
  online = undefined;
  uuid = undefined;

  constructor(deviceData, options) {
    // Setup logger object if passed as option
    if (
      typeof options?.log?.info === 'function' &&
      typeof options?.log?.success === 'function' &&
      typeof options?.log?.warn === 'function' &&
      typeof options?.log?.error === 'function' &&
      typeof options?.log?.debug === 'function'
    ) {
      this.log = options.log;
    }

    // Store data we need from the device data passed it
    this.online = deviceData?.online === true;
    this.videoEnabled = deviceData?.streaming_enabled === true;
    this.audioEnabled = deviceData?.audio_enabled === true;
    this.token = deviceData?.apiAccess.token;
    if (deviceData?.apiAccess.key === 'Authorization') {
      this.tokenType = 'google';
    }
    if (deviceData?.apiAccess.key === 'cookie') {
      this.tokenType = 'nest';
    }
    this.uuid = deviceData?.uuid;
    this.nexusTalk.host = deviceData?.direct_nexustalk_host; // Host we'll connect to

    this.pendingHost = null;
    this.weDidClose = true; // Flag if we did the socket close gracefully

    // Setup location for *.h264 frame files. This can be overriden by a passed in option
    let resourcePath = path.resolve(__dirname + '/res'); // Default location for *.h264 files
    if (
      typeof options?.resourcePath === 'string' &&
      options.resourcePath !== '' &&
      fs.existsSync(path.resolve(options.resourcePath)) === true
    ) {
      resourcePath = path.resolve(options.resourcePath);
    }

    // load buffer for camera offline image in .h264 frame
    if (fs.existsSync(path.resolve(resourcePath + '/' + CAMERAOFFLINEH264FILE)) === true) {
      this.cameraOfflineFrame = fs.readFileSync(path.resolve(resourcePath + '/' + CAMERAOFFLINEH264FILE));
      // remove any H264 NALU from beginning of any video data. We do this as they are added later when output by our ffmpeg router
      if (this.cameraOfflineFrame.indexOf(H264NALStartcode) === 0) {
        this.cameraOfflineFrame = this.cameraOfflineFrame.subarray(H264NALStartcode.length);
      }
    }

    // load buffer for camera stream off image in .h264 frame
    if (fs.existsSync(path.resolve(resourcePath + '/' + CAMERAOFFH264FILE)) === true) {
      this.cameraVideoOffFrame = fs.readFileSync(path.resolve(resourcePath + '/' + CAMERAOFFH264FILE));
      // remove any H264 NALU from beginning of any video data. We do this as they are added later when output by our ffmpeg router
      if (this.cameraVideoOffFrame.indexOf(H264NALStartcode) === 0) {
        this.cameraVideoOffFrame = this.cameraVideoOffFrame.subarray(H264NALStartcode.length);
      }
    }

    // load buffer for camera stream connecting image in .h264 frame
    if (fs.existsSync(path.resolve(resourcePath + '/' + CAMERACONNECTING264FILE) === true)) {
      this.cameraConnectingVideoFrame = fs.readFileSync(path.resolve(resourcePath + '/' + CAMERACONNECTING264FILE));
      // remove any H264 NALU from beginning of any video data. We do this as they are added later when output by our ffmpeg router
      if (this.cameraConnectingVideoFrame.indexOf(H264NALStartcode) === 0) {
        this.cameraConnectingVideoFrame = this.cameraConnectingVideoFrame.subarray(H264NALStartcode.length);
      }
    }

    // Start a non-blocking loop for output to the various streams which connect to our streamer object
    // This process will also handle the rolling-buffer size we require
    // Record streams will always start from the beginning of the buffer (tail)
    // Live streams will always start from the end of the buffer (head)
    let lastTimeVideo = Date.now();
    this.nexusTalk.outputTimer = setInterval(() => {
      let dateNow = Date.now();
      let outputVideoFrame = dateNow > lastTimeVideo + 90000 / 30;
      Object.values(this.nexusTalk.outputs).forEach((output) => {
        // Monitor for camera going offline and/or video enabled/disabled
        // We'll insert the appropriate video frame into the stream
        if (this.online === false && this.cameraOfflineFrame !== undefined && outputVideoFrame === true) {
          // Camera is offline so feed in our custom h264 frame and AAC silence
          output.buffer.push({ type: 'video', time: dateNow, data: this.cameraOfflineFrame });
          output.buffer.push({ type: 'audio', time: dateNow, data: AACAudioSilence });
          lastTimeVideo = dateNow;
        }
        if (this.online === true && this.videoEnabled === false && this.cameraVideoOffFrame !== undefined && outputVideoFrame === true) {
          // Camera video is turned off so feed in our custom h264 frame and AAC silence
          output.buffer.push({ type: 'video', time: dateNow, data: this.cameraVideoOffFrame });
          output.buffer.push({ type: 'audio', time: dateNow, data: AACAudioSilence });
          lastTimeVideo = dateNow;
        }

        // Keep our 'main' rolling buffer under a certain size
        // Live/record buffers will always reduce in length in the next section
        if (output.type === 'buffer' && output.buffer.length > 1000) {
          output.buffer.shift();
        }

        // Output the packet data to any streams 'live' or 'recording' streams
        if (output.type === 'live' || output.type === 'record') {
          let packet = output.buffer.shift();
          if (packet?.type === 'video' && typeof output?.video?.write === 'function') {
            // H264 NAL Units '0001' are required to be added to beginning of any video data we output
            output.video.write(Buffer.concat([H264NALStartcode, packet.data]));
          }
          if (packet?.type === 'audio' && typeof output?.audio?.write === 'function') {
            output.audio.write(packet.data);
          }
        }
      });
    }, 0);

    // If specified option to start buffering, kick off
    if (typeof options?.buffer === 'boolean' && options.buffer === true) {
      this.startBuffering();
    }
  }

  // Class functions
  startBuffering() {
    if (this.nexusTalk.outputs?.buffer === undefined) {
      // No active buffer session, start connection to nexus
      if (this.nexusTalk.socket === null && typeof this.nexusTalk.host === 'string' && this.nexusTalk.host !== '') {
        this.#connect(this.nexusTalk.host);
        this?.log?.debug && this.log.debug('Started buffering from "%s"', this.nexusTalk.host);
      }

      this.nexusTalk.outputs.buffer = {
        type: 'buffer',
        buffer: [],
      };
    }
  }

  startLiveStream(sessionID, videoStream, audioStream, talkbackStream) {
    // Setup error catching for video/audio/talkback streams
    if (videoStream !== null && typeof videoStream === 'object') {
      videoStream.on('error', () => {
        // EPIPE errors??
      });
    }

    if (audioStream !== null && typeof audioStream === 'object') {
      audioStream.on('error', () => {
        // EPIPE errors??
      });
    }

    if (talkbackStream !== null && typeof talkbackStream === 'object') {
      let talkbackTimeout = undefined;

      talkbackStream.on('error', () => {
        // EPIPE errors??
      });

      talkbackStream.on('data', (data) => {
        // Received audio data to send onto nexus for output to camera/doorbell
        this.#AudioPayload(data);

        talkbackTimeout = clearTimeout(talkbackTimeout);
        talkbackTimeout = setTimeout(() => {
          // no audio received in 500ms, so mark end of stream
          this.#AudioPayload(Buffer.alloc(0));
        }, 500);
      });
    }

    if (this.nexusTalk.socket === null && typeof this.nexusTalk.host === 'string' && this.nexusTalk.host !== '') {
      // We do not have an active socket connection, so startup connection to nexus
      this.#connect(this.nexusTalk.host);
    }

    // Add video/audio streams for our output loop to handle outputting to
    this.nexusTalk.outputs[sessionID] = {
      type: 'live',
      video: videoStream,
      audio: audioStream,
      talk: talkbackStream,
      buffer: [],
    };

    // finally, we've started live stream
    this?.log?.debug &&
      this.log.debug(
        'Started live stream from "%s" %s and sesssion id of "%s"',
        this.nexusTalk.host,
        talkbackStream !== null && typeof talkbackStream === 'object' ? 'with two-way audio' : '',
        sessionID,
      );
  }

  startRecordStream(sessionID, videoStream, audioStream) {
    // Setup error catching for video/audio streams
    if (videoStream !== null && typeof videoStream === 'object') {
      videoStream.on('error', () => {
        // EPIPE errors??
      });
    }

    if (audioStream !== null && typeof audioStream === 'object') {
      audioStream.on('error', () => {
        // EPIPE errors??
      });
    }

    if (this.nexusTalk.socket === null && typeof this.nexusTalk.host === 'string' && this.nexusTalk.host !== '') {
      // We do not have an active socket connection, so startup connection to nexus
      this.#connect(this.nexusTalk.host);
    }

    // Add video/audio streams for our output loop to handle outputting to
    this.nexusTalk.outputs[sessionID] = {
      type: 'record',
      video: videoStream,
      audio: audioStream,
      // eslint-disable-next-line no-undef
      buffer: this.nexusTalk.outputs?.buffer?.buffer !== undefined ? structuredClone(this.nexusTalk.outputs.buffer.buffer) : [],
    };

    // Finally we've started the recording stream
    this?.log?.debug && this.log.debug('Started recording stream from "%s" with sesison id of "%s"', this.nexusTalk.host, sessionID);
  }

  stopRecordStream(sessionID) {
    // Request to stop a recording stream
    if (typeof this.nexusTalk.outputs[sessionID] === 'object') {
      this?.log?.debug && this.log.debug('Stopped recording stream from "%s"', this.nexusTalk.host);
      delete this.nexusTalk.outputs[sessionID];
    }

    // If we have no more output streams active, we'll close the connection to nexus
    if (Object.keys(this.nexusTalk.outputs).length === 0) {
      this.#close(true);
    }
  }

  stopLiveStream(sessionID) {
    // Request to stop an active live stream
    if (typeof this.nexusTalk.outputs[sessionID] === 'object') {
      this?.log?.debug && this.log.debug('Stopped live stream from "%s"', this.nexusTalk.host);
      delete this.nexusTalk.outputs[sessionID];
    }

    // If we have no more output streams active, we'll close the connection to nexus
    if (Object.keys(this.nexusTalk.outputs).length === 0) {
      this.#close(true);
    }
  }

  stopBuffering() {
    if (this.nexusTalk.outputs?.buffer !== undefined) {
      this?.log?.debug && this.log.debug('Stopped buffering from "%s"', this.nexusTalk.host);
      delete this.nexusTalk.outputs.buffer;
    }

    // If we have no more output streams active, we'll close the connection to nexus
    if (Object.keys(this.nexusTalk.outputs).length === 0) {
      this.#close(true);
    }
  }

  update(deviceData) {
    if (typeof deviceData !== 'object') {
      return;
    }

    if (deviceData.apiAccess.token !== this.token) {
      // access token has changed so re-authorise
      this.token = deviceData.apiAccess.token;

      if (this.nexusTalk.socket !== null) {
        this.#Authenticate(true); // Update authorisation only if connected
      }
    }

    this.online = deviceData?.online === true;
    this.videoEnabled = deviceData?.streaming_enabled === true;
    this.audioEnabled = deviceData?.audio_enabled === true;
    this.token = deviceData?.apiAccess.token;
    this.nexusTalk.host = deviceData?.direct_nexustalk_host; // Host we'll connect to

    if (this.online !== deviceData.online || this.videoEnabled !== deviceData.streaming_enabled) {
      // Online status or streaming status has changed has changed
      this.online = deviceData?.online === true;
      this.videoEnabled = deviceData?.streaming_enabled === true;
      this.nexusTalk.host = deviceData?.direct_nexustalk_host; // Host we'll connect to
      if (this.online === false || this.videoEnabled === false) {
        this.#close(true); // as offline or streaming not enabled, close socket
      }
      if (this.online === true && this.videoEnabled === true) {
        this.#connect(this.nexusTalk.host); // Connect to Nexus for stream
      }
    }

    if (this.nexusTalk.host !== deviceData.direct_nexustalk_host) {
      this.nexusTalk.host = deviceData.direct_nexustalk_host;
      this?.log?.debug && this.log.debug('Updated Nexusstreamer host "%s"', deviceData.direct_nexustalk_host);
    }
  }

  #connect(host) {
    // Clear any timers we have running
    this.nexusTalk.pingTimer = clearInterval(this.nexusTalk.pingTimer);
    this.nexusTalk.stalledTimer = clearInterval(this.nexusTalk.stalledTimer);

    this.nexusTalk.id = undefined; // No session ID yet

    if (this.online === true && this.videoEnabled === true) {
      if (typeof host === 'undefined' || host === null) {
        // No host parameter passed in, so we'll set this to our internally stored host
        host = this.nexusTalk.host;
      }

      if (this.pendingHost !== null) {
        host = this.pendingHost;
        this.pendingHost = null;
      }

      this?.log?.debug && this.log.debug('Starting connection to "%s"', host);

      this.nexusTalk.socket = tls.connect({ host: host, port: 1443 }, () => {
        // Opened connection to Nexus server, so now need to authenticate ourselves
        this?.log?.debug && this.log.debug('Connection established to "%s"', host);

        this.nexusTalk.socket.setKeepAlive(true); // Keep socket connection alive
        this.nexusTalk.host = host; // update internal host name since we've connected
        this.#Authenticate(false);
      });

      this.nexusTalk.socket.on('error', () => {});

      this.nexusTalk.socket.on('end', () => {});

      this.nexusTalk.socket.on('data', (data) => {
        this.#handleNexusData(data);
      });

      this.nexusTalk.socket.on('close', (hadError) => {
        if (hadError === true) {
          //
        }
        let normalClose = this.weDidClose; // Cache this, so can reset it below before we take action

        this.nexusTalk.stalledTimer = clearTimeout(this.nexusTalk.stalledTimer); // Clear stalled timer
        this.nexusTalk.pingTimer = clearInterval(this.nexusTalk.pingTimer); // Clear ping timer
        this.nexusTalk.authorised = false; // Since connection close, we can't be authorised anymore
        this.nexusTalk.socket = null; // Clear socket object
        this.nexusTalk.id = undefined; // Not an active session anymore

        this.weDidClose = false; // Reset closed flag

        this?.log?.debug && this.log.debug('Connection closed to "%s"', host);

        if (normalClose === false && Object.keys(this.nexusTalk.outputs).length > 0) {
          // We still have either active buffering occuring or output streams running
          // so attempt to restart connection to existing host
          this.#connect(host);
        }
      });
    }
  }

  #close(sendStop) {
    // Close an authenicated socket stream gracefully
    if (this.nexusTalk.socket !== null) {
      if (sendStop === true) {
        // Send a notifcation to nexus we're finished playback
        this.#stopNexusData();
      }
      this.nexusTalk.socket.destroy();
    }

    this.nexusTalk.socket = null;
    this.nexusTalk.id = undefined; // Not an active session anymore
    this.nexusTalk.packets = [];
    this.nexusTalk.messages = [];

    this.weDidClose = true; // Flag we did the socket close
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
    stopBuffer.writeVarintField(1, this.nexusTalk.id); // Session ID
    this.#sendMessage(PacketType.STOP_PLAYBACK, stopBuffer.finish());
  }

  #sendMessage(type, data) {
    if (
      this.nexusTalk.socket === null ||
      this.nexusTalk.socket.readyState !== 'open' ||
      (type !== PacketType.HELLO && this.nexusTalk.authorised === false)
    ) {
      // We're not connect and/or authorised yet, so 'cache' message for processing once this occurs
      this.nexusTalk.messages.push({ type: type, data: data });
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
    this.nexusTalk.socket.write(Buffer.concat([header, Buffer.from(data)]), () => {
      // Message sent. Don't do anything?
    });
  }

  #Authenticate(reauthorise) {
    // Authenticate over created socket connection
    let tokenBuffer = new protoBuf();
    let helloBuffer = new protoBuf();

    this.nexusTalk.authorised = false; // We're nolonger authorised

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
      this?.log?.debug && this.log.debug('Re-authentication requested to "%s"', this.nexusTalk.host);
      this.#sendMessage(PacketType.AUTHORIZE_REQUEST, tokenBuffer.finish());
    } else {
      // This isn't a re-authorise request, so perform 'Hello' packet
      this?.log?.debug && this.log.debug('Performing authentication to "%s"', this.nexusTalk.host);
      helloBuffer.writeVarintField(1, ProtocolVersion.VERSION_3);
      helloBuffer.writeStringField(2, this.uuid.split('.')[1]); // UUID should be 'quartz.xxxxxx'. We want the xxxxxx part
      helloBuffer.writeBooleanField(3, false); // Doesnt required a connected camera
      helloBuffer.writeStringField(6, crypto.randomUUID()); // Random UUID for this connection attempt
      helloBuffer.writeStringField(7, 'Nest/5.75.0 (iOScom.nestlabs.jasper.release) os=17.4.1');
      helloBuffer.writeVarintField(9, ClientType.IOS);
      this.#sendMessage(PacketType.HELLO, helloBuffer.finish());
    }
  }

  #AudioPayload(payload) {
    // Encode audio packet for sending to camera
    let audioBuffer = new protoBuf();
    audioBuffer.writeBytesField(1, payload); // audio data
    audioBuffer.writeVarintField(2, this.nexusTalk.id); // session ID
    audioBuffer.writeVarintField(3, CodecType.SPEEX); // codec
    audioBuffer.writeVarintField(4, 16000); // sample rate, 16k
    //audioBuffer.writeVarintField(5, ????);  // Latency measure tag. What does this do?
    this.#sendMessage(PacketType.AUDIO_PAYLOAD, audioBuffer.finish());
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

    this?.log?.debug && this.log.debug('Redirect requested from "%s" to "%s"', this.nexusTalk.host, redirectToHost);

    // Setup listener for socket close event. Once socket is closed, we'll perform the redirect
    this.nexusTalk.socket &&
      this.nexusTalk.socket.on('close', () => {
        this.#connect(redirectToHost); // Connect to new host
      });
    this.#close(true); // Close existing socket
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
          this.nexusTalk.video = {
            channel_id: stream.channel_id,
            start_time: Date.now() + stream.start_time,
            sample_rate: stream.sample_rate,
            timestamp_delta: 0,
          };
        }
        if (stream.codec_type === CodecType.AAC || stream.codec_type === CodecType.OPUS || stream.codec_type === CodecType.SPEEX) {
          this.nexusTalk.audio = {
            channel_id: stream.channel_id,
            start_time: Date.now() + stream.start_time,
            sample_rate: stream.sample_rate,
            timestamp_delta: 0,
          };
        }
      });

    // Since this is the beginning of playback, clear any active buffers contents
    this.nexusTalk.id = packet.session_id;
    this.nexusTalk.packets = [];
    this.nexusTalk.messages = [];

    this?.log?.debug && this.log.debug('Playback started from "%s" with session ID "%s"', this.nexusTalk.host, this.nexusTalk.id);
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
    this.nexusTalk.stalledTimer = clearTimeout(this.nexusTalk.stalledTimer);
    this.nexusTalk.stalledTimer = setTimeout(() => {
      this?.log?.debug && this.log.debug('We have not received any data from nexus in the past "%s" seconds. Attempting restart', 8);

      // Setup listener for socket close event. Once socket is closed, we'll perform the re-connection
      this.nexusTalk.socket &&
        this.nexusTalk.socket.on('close', () => {
          this.#connect(this.nexusTalk.host); // try reconnection
        });
      this.#close(false); // Close existing socket
    }, 8000);

    Object.values(this.nexusTalk.outputs).forEach((output) => {
      // Handle video packet
      if (packet.channel_id === this.nexusTalk.video.channel_id) {
        this.nexusTalk.video.timestamp_delta += packet.timestamp_delta;
        output.buffer.push({
          type: 'video',
          time: this.nexusTalk.video.start_time + this.nexusTalk.video.timestamp_delta,
          data: packet.payload,
        });
      }

      // Handle audio packet
      if (packet.channel_id === this.nexusTalk.audio.channel_id) {
        this.nexusTalk.audio.timestamp_delta += packet.timestamp_delta;
        output.buffer.push({
          type: 'audio',
          time: this.nexusTalk.audio.start_time + this.nexusTalk.audio.timestamp_delta,
          data: packet.payload,
        });
      }
    });
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

    if (this.nexusTalk.id !== null && packet.reason === 0) {
      // Normal playback ended ie: when we stopped playback
      this?.log?.debug && this.log.debug('Playback ended on "%s"', this.nexusTalk.host);
    }

    if (packet.reason !== 0) {
      // Error during playback, so we'll attempt to restart by reconnection to host
      this?.log?.debug &&
        this.log.debug('Playback ended on "%s" with error "%s". Attempting reconnection', this.nexusTalk.host, packet.reason);

      // Setup listener for socket close event. Once socket is closed, we'll perform the re-connection
      this.nexusTalk.socket &&
        this.nexusTalk.socket.on('close', () => {
          this.#connect(this.nexusTalk.host); // try reconnection to existing host
        });
      this.#close(false); // Close existing socket
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
    this.nexusTalk.packets = this.nexusTalk.packets.length === 0 ? data : Buffer.concat([this.nexusTalk.packets, data]);

    while (this.nexusTalk.packets.length >= 3) {
      let headerSize = 3;
      let packetType = this.nexusTalk.packets.readUInt8(0);
      let packetSize = this.nexusTalk.packets.readUInt16BE(1);

      if (packetType === PacketType.LONG_PLAYBACK_PACKET) {
        headerSize = 5;
        packetSize = this.nexusTalk.packets.readUInt32BE(1);
      }

      if (this.nexusTalk.packets.length < headerSize + packetSize) {
        // We dont have enough data in the buffer yet to process the full packet
        // so, exit loop and await more data
        break;
      }

      let protoBufPayload = new protoBuf(this.nexusTalk.packets.slice(headerSize, headerSize + packetSize));
      switch (packetType) {
        case PacketType.PING: {
          break;
        }

        case PacketType.OK: {
          // process any pending messages we have stored
          this.nexusTalk.authorised = true; // OK message, means we're connected and authorised to Nexus
          for (let message = this.nexusTalk.messages.shift(); message; message = this.nexusTalk.messages.shift()) {
            this.#sendMessage(message.type, message.data);
          }

          // Periodically send PING message to keep stream alive
          this.nexusTalk.pingTimer = clearInterval(this.nexusTalk.pingTimer);
          this.nexusTalk.pingTimer = setInterval(() => {
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
      this.nexusTalk.packets = this.nexusTalk.packets.slice(headerSize + packetSize);
    }
  }
}
