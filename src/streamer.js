// streamer
// Part of homebridge-nest-accfactory
//
// This is the base class for all Camera/Doorbell streaming
//
// Buffers a single audio/video stream which allows multiple HomeKit devices to connect to the single stream
// for live viewing and/or recording
//
// The following functions should be overriden in your class which extends this
//
// streamer.connect()
// streamer.close()
// streamer.talkingAudio(talkingData)
// streamer.update(deviceData) <- call super after
//
// The following defines should be overriden in your class which extends this
//
// blankAudio - Buffer containing a blank audio segment for the type of audio being used
//
// Code version 2025/03/25
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { Buffer } from 'node:buffer';
import { setInterval, setTimeout, clearTimeout } from 'node:timers';
import fs from 'fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Define constants
const CAMERAOFFLINEH264FILE = 'Nest_camera_offline.h264'; // Camera offline H264 frame file
const CAMERAOFFH264FILE = 'Nest_camera_off.h264'; // Camera off H264 frame file
const CAMERATRANSFERJPGFILE = 'Nest_camera_transfer.jpg'; // Camera transferring H264 frame file
const TALKBACKAUDIOTIMEOUT = 1000;
const H264NALSTARTCODE = Buffer.from([0x00, 0x00, 0x00, 0x01]);

const __dirname = path.dirname(fileURLToPath(import.meta.url)); // Make a defined for JS __dirname

// Streamer object
export default class Streamer {
  videoEnabled = undefined; // Video stream on camera enabled or not
  audioEnabled = undefined; // Audio from camera enabled or not
  online = undefined; // Camera online or not
  uuid = undefined; // UUID of the device connecting
  connected = undefined; // Stream endpoint connection: undefined = not connected , false = connecting , true = connected and streaming
  blankAudio = undefined; // Blank audio 'frame'
  codecs = {
    video: undefined, // Video codec being used
    audio: undefined, // Audio codec being used
    talk: undefined, // Talking codec being used
  };

  // Internal data only for this class
  #outputTimer = undefined; // Timer for non-blocking loop to stream output data
  #outputs = {}; // Output streams ie: buffer, live, record
  #cameraOfflineFrame = undefined; // Camera offline video frame
  #cameraVideoOffFrame = undefined; // Video turned off on camera video frame
  #cameraTransferringFrame = undefined; // Camera transferring between Nest/Google Home video frame

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
    this.migrating = deviceData?.migrating === true;
    this.online = deviceData?.online === true;
    this.videoEnabled = deviceData?.streaming_enabled === true;
    this.audioEnabled = deviceData?.audio_enabled === true;
    this.uuid = deviceData?.nest_google_uuid;

    // Setup location for *.h264 frame files. This can be overriden by a passed in option
    let resourcePath = path.resolve(__dirname + '/res'); // Default location for *.h264 files
    if (
      typeof options?.resourcePath === 'string' &&
      options.resourcePath !== '' &&
      fs.existsSync(path.resolve(options.resourcePath)) === true
    ) {
      resourcePath = path.resolve(options.resourcePath);
    }

    // load buffer for camera offline in .h264 frame
    if (fs.existsSync(path.resolve(resourcePath + '/' + CAMERAOFFLINEH264FILE)) === true) {
      this.#cameraOfflineFrame = fs.readFileSync(path.resolve(resourcePath + '/' + CAMERAOFFLINEH264FILE));
    }

    // load buffer for camera stream off in .h264 frame
    if (fs.existsSync(path.resolve(resourcePath + '/' + CAMERAOFFH264FILE)) === true) {
      this.#cameraVideoOffFrame = fs.readFileSync(path.resolve(resourcePath + '/' + CAMERAOFFH264FILE));
    }

    // load buffer for camera transferring in .h264 frame
    if (fs.existsSync(path.resolve(resourcePath + '/' + CAMERATRANSFERJPGFILE)) === true) {
      this.#cameraTransferringFrame = fs.readFileSync(path.resolve(resourcePath + '/' + CAMERATRANSFERJPGFILE));
    }

    // Start a non-blocking loop for output to the various streams which connect to our streamer object
    // This process will also handle the rolling-buffer size we require
    // Record streams will always start from the beginning of the buffer (tail)
    // Live streams will always start from the end of the buffer (head)
    let lastTimeVideo = Date.now();
    this.#outputTimer = setInterval(() => {
      let dateNow = Date.now();
      let outputVideoFrame = dateNow > lastTimeVideo + 90000 / 30; // 30fps
      Object.values(this.#outputs).forEach((output) => {
        // Monitor for camera going offline, video enabled/disabled or being transferred between Nest/Google Home
        // We'll insert the appropriate video frame into the stream
        if (this.online === false && this.#cameraOfflineFrame !== undefined && outputVideoFrame === true) {
          // Camera is offline so feed in our custom h264 frame and AAC silence
          output.buffer.push({ time: dateNow, type: 'video', data: this.#cameraOfflineFrame });
          output.buffer.push({ time: dateNow, type: 'audio', data: this.blankAudio });
          lastTimeVideo = dateNow;
        }
        if (this.online === true && this.videoEnabled === false && this.#cameraVideoOffFrame !== undefined && outputVideoFrame === true) {
          // Camera video is turned off so feed in our custom h264 frame and AAC silence
          output.buffer.push({ time: dateNow, type: 'video', data: this.#cameraVideoOffFrame });
          output.buffer.push({ time: dateNow, type: 'audio', data: this.blankAudio });
          lastTimeVideo = dateNow;
        }
        if (this.migrating === true && this.#cameraTransferringFrame !== undefined && outputVideoFrame === true) {
          // Camera video is turned off so feed in our custom h264 frame and AAC silence
          output.buffer.push({ time: dateNow, type: 'video', data: this.#cameraTransferringFrame });
          output.buffer.push({ time: dateNow, type: 'audio', data: this.blankAudio });
          lastTimeVideo = dateNow;
        }

        // Keep our 'main' rolling buffer under a certain size
        // Live/record buffers will always reduce in length in the next section
        // <---- maybe make this time based x time since first packet in buffer?
        if (output.type === 'buffer' && output.buffer.length > 1250) {
          output.buffer.shift();
        }

        // Output the packet data to any 'live' or 'recording' streams
        if (output.type === 'live' || output.type === 'record') {
          let packet = output.buffer.shift();
          if (packet?.type === 'video' && typeof output?.video?.write === 'function') {
            packet.data = Buffer.concat([H264NALSTARTCODE, packet.data]);
            output.video.write(packet.data);
          }
          if (packet?.type === 'audio' && typeof output?.audio?.write === 'function') {
            output.audio.write(packet.data);
          }
        }
      });
    }, 0);
  }

  // Class functions
  isBuffering() {
    return this.#outputs?.buffer !== undefined;
  }

  startBuffering() {
    if (this.#outputs?.buffer === undefined) {
      // No active buffer session, start connection to streamer
      if (this.online === true && this.videoEnabled === true && this.connected === undefined && typeof this.connect === 'function') {
        this?.log?.debug && this.log.debug('Started buffering for uuid "%s"', this.uuid);
        this.connect();
      }

      this.#outputs.buffer = {
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
        // Received audio data to send onto camera/doorbell for output
        if (typeof this.talkingAudio === 'function') {
          this.talkingAudio(data);

          clearTimeout(talkbackTimeout);
          talkbackTimeout = setTimeout(() => {
            // no audio received in 1000ms, so mark end of stream
            this.talkingAudio(Buffer.alloc(0));
          }, TALKBACKAUDIOTIMEOUT);
        }
      });
    }

    if (this.online === true && this.videoEnabled === true && this.connected === undefined && typeof this.connect === 'function') {
      // We do not have an active connection, so startup connection
      this.connect();
    }

    // Add video/audio streams for our output loop to handle outputting
    this.#outputs[sessionID] = {
      type: 'live',
      video: videoStream,
      audio: audioStream,
      talk: talkbackStream,
      buffer: [],
    };

    // finally, we've started live stream
    this?.log?.debug &&
      this.log.debug(
        'Started live stream from uuid "%s" %s "%s"',
        this.uuid,
        talkbackStream !== null && typeof talkbackStream === 'object' ? 'with two-way audio and sesssion id of' : 'and sesssion id of',
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

    if (this.connected === undefined && typeof this.connect === 'function' && this.online === true && this.videoEnabled === true) {
      // We do not have an active connection, so startup connection
      this.connect();
    }

    // Add video/audio streams for our output loop to handle outputting
    this.#outputs[sessionID] = {
      type: 'record',
      video: videoStream,
      audio: audioStream,
      // eslint-disable-next-line no-undef
      buffer: this.#outputs?.buffer?.buffer !== undefined ? structuredClone(this.#outputs.buffer.buffer) : [],
    };

    // Finally we've started the recording stream
    this?.log?.debug && this.log.debug('Started recording stream from uuid "%s" with sesison id of "%s"', this.uuid, sessionID);
  }

  stopRecordStream(sessionID) {
    // Request to stop a recording stream
    if (this.#outputs?.[sessionID] !== undefined) {
      this?.log?.debug && this.log.debug('Stopped recording stream from uuid "%s"', this.uuid);
      delete this.#outputs[sessionID];
    }

    // If we have no more output streams active, we'll close the connection
    if (this.haveOutputs() === false && typeof this.close === 'function') {
      this.close();
    }
  }

  stopLiveStream(sessionID) {
    // Request to stop an active live stream
    if (this.#outputs?.[sessionID] !== undefined) {
      this?.log?.debug && this.log.debug('Stopped live stream from uuid "%s"', this.uuid);
      delete this.#outputs[sessionID];
    }

    // If we have no more output streams active, we'll close the connection
    if (this.haveOutputs() === false && typeof this.close === 'function') {
      this.close();
    }
  }

  stopBuffering() {
    if (this.#outputs?.buffer !== undefined) {
      this?.log?.debug && this.log.debug('Stopped buffering from uuid "%s"', this.uuid);
      delete this.#outputs.buffer;
    }

    // If we have no more output streams active, we'll close the connection
    if (this.haveOutputs() === false && typeof this.close === 'function') {
      this.close();
    }
  }

  stopEverything() {
    if (this.haveOutputs() === true) {
      this?.log?.debug && this.log.debug('Stopped buffering, live and recording from uuid "%s"', this.uuid);
      this.#outputs = {}; // No more outputs
      if (typeof this.close === 'function') {
        this.close();
      }
    }
  }

  update(deviceData) {
    if (typeof deviceData !== 'object') {
      return;
    }

    this.migrating = deviceData.migrating;

    if (this.uuid !== deviceData?.nest_google_uuid) {
      this.uuid = deviceData?.nest_google_uuid;

      if (this.haveOutputs() === true) {
        // Since the uuid has change and a streamer may use this, if there any any active outputs, close and connect again
        if (typeof this.close === 'function') {
          this.close();
        }
        if (this.online === true && this.videoEnabled === true && this.connected === undefined && typeof this.connect === 'function') {
          this.connect();
        }
      }
    }

    if (
      this.online !== deviceData.online ||
      this.videoEnabled !== deviceData.streaming_enabled ||
      this.audioEnabled !== deviceData?.audio_enabled
    ) {
      // Online status or streaming status has changed has changed
      this.online = deviceData?.online === true;
      this.videoEnabled = deviceData?.streaming_enabled === true;
      this.audioEnabled = deviceData?.audio_enabled === true;

      if (this.haveOutputs() === true) {
        // Since online, video, audio enabled status has changed, if there any any active outputs, close and connect again
        if ((this.online === false || this.videoEnabled === false || this.audioEnabled === false) && typeof this.close === 'function') {
          this.close(); // as offline or streaming not enabled, close streamer
        }
        if (this.online === true && this.videoEnabled === true && this.connected === undefined && typeof this.connect === 'function') {
          this.connect(); // Connect for stream
        }
      }
    }
  }

  addToOutput(type, data) {
    if (typeof type !== 'string' || type === '' || Buffer.isBuffer(data) === false) {
      return;
    }

    if (data.indexOf(H264NALSTARTCODE) === 0) {
      // Strip H264 start code from input buffer. We'll handle this later
      data = data.subarray(H264NALSTARTCODE.length);
    }

    Object.values(this.#outputs).forEach((output) => {
      output.buffer.push({
        time: Date.now(), // Timestamp of when this was added to buffer
        type: type,
        data: data,
      });
    });
  }

  haveOutputs() {
    return Object.keys(this.#outputs).length > 0;
  }
}
