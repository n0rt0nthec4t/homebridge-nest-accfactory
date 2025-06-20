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
// streamer.codecs() <- return codecs beeing used in
//
// The following defines should be overriden in your class which extends this
//
// blankAudio - Buffer containing a blank audio segment for the type of audio being used
//
// Code version 2025.06.20
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { Buffer } from 'node:buffer';
import { setInterval, setTimeout, clearTimeout } from 'node:timers';
import fs from 'fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Define constants
const CAMERA_RESOURCE = {
  OFFLINE: 'Nest_camera_offline.h264',
  OFF: 'Nest_camera_off.h264',
  TRANSFER: 'Nest_camera_transfer.h264',
};
const TALKBACK_AUDIO_TIMEOUT = 1000;
const MAX_BUFFER_AGE = 5000; // Keep last 5s of media in buffer
const STREAM_FRAME_INTERVAL = 1000 / 30; // 30fps approx
const RESOURCE_PATH = './res';
const __dirname = path.dirname(fileURLToPath(import.meta.url)); // Make a defined for JS __dirname
const LOG_LEVELS = {
  INFO: 'info',
  SUCCESS: 'success',
  WARN: 'warn',
  ERROR: 'error',
  DEBUG: 'debug',
};

// Streamer object
export default class Streamer {
  static H264NALUS = {
    START_CODE: Buffer.from([0x00, 0x00, 0x00, 0x01]),
    TYPES: {
      SLICE_NON_IDR: 1,
      SLICE_PART_A: 2,
      SLICE_PART_B: 3,
      SLICE_PART_C: 4,
      IDR: 5, // Instantaneous Decoder Refresh
      SEI: 6,
      SPS: 7,
      PPS: 8,
      AUD: 9,
      END_SEQUENCE: 10,
      END_STREAM: 11,
      STAP_A: 24,
      FU_A: 28,
    },
  };

  log = undefined; // Logging function object
  videoEnabled = undefined; // Video stream on camera enabled or not
  audioEnabled = undefined; // Audio from camera enabled or not
  online = undefined; // Camera online or not
  uuid = undefined; // UUID of the device connecting
  connected = undefined; // Stream endpoint connection: undefined = not connected , false = connecting , true = connected and streaming
  blankAudio = undefined; // Blank audio 'frame'

  // Internal data only for this class
  #outputTimer = undefined; // Timer for non-blocking loop to stream output data
  #outputs = {}; // Output streams ie: buffer, live, record
  #cameraOfflineFrame = undefined; // Camera offline video frame
  #cameraVideoOffFrame = undefined; // Video turned off on camera video frame
  #cameraTransferringFrame = undefined; // Camera transferring between Nest/Google Home video frame
  #lastSPS = undefined; // last H264 SPS we saw
  #lastPPS = undefined; // Last H264 PPS we saw
  #seenIDR = undefined; // Have we seen a H264 IDR

  // Codecs being used for video, audio and talking
  get codecs() {
    return {
      video: undefined,
      audio: undefined,
      talk: undefined,
    };
  }

  constructor(deviceData, options) {
    // Setup logger object if passed as option
    if (Object.values(LOG_LEVELS).every((fn) => typeof options?.log?.[fn] === 'function')) {
      this.log = options.log;
    }

    // Store data we need from the device data passed it
    this.migrating = deviceData?.migrating === true;
    this.online = deviceData?.online === true;
    this.videoEnabled = deviceData?.streaming_enabled === true;
    this.audioEnabled = deviceData?.audio_enabled === true;
    this.uuid = deviceData?.nest_google_uuid;

    // Load support video frame files as required
    const loadFrameResource = (filename, label) => {
      let buffer = undefined;
      let file = path.resolve(__dirname, RESOURCE_PATH, filename);
      if (fs.existsSync(file) === true) {
        buffer = fs.readFileSync(file);
      } else {
        this.log?.warn?.('Failed to load %s video resource for "%s"', label, deviceData.description);
      }
      return buffer;
    };

    this.#cameraOfflineFrame = loadFrameResource(CAMERA_RESOURCE.OFFLINE, 'offline');
    this.#cameraVideoOffFrame = loadFrameResource(CAMERA_RESOURCE.OFF, 'video off');
    this.#cameraTransferringFrame = loadFrameResource(CAMERA_RESOURCE.TRANSFER, 'transferring');

    // Start a non-blocking loop for output to the various streams which connect to our streamer object
    // This process will also handle the rolling-buffer size we require
    // Record streams will always start from the beginning of the buffer (tail)
    // Live streams will always start from the end of the buffer (head)
    let lastVideoFrameTime = Date.now();
    this.#outputTimer = setInterval(() => {
      let dateNow = Date.now();
      let outputVideoFrame = dateNow - lastVideoFrameTime >= STREAM_FRAME_INTERVAL;
      Object.values(this.#outputs).forEach((output) => {
        // Monitor for camera going offline, video enabled/disabled or being transferred between Nest/Google Home
        // We'll insert the appropriate video frame into the stream
        if (this.online === false && this.#cameraOfflineFrame !== undefined && outputVideoFrame === true) {
          // Camera is offline so feed in our custom h264 frame and AAC silence
          output.buffer.push({ time: dateNow, type: 'video', data: this.#cameraOfflineFrame });
          output.buffer.push({ time: dateNow, type: 'audio', data: this.blankAudio });
          lastVideoFrameTime = dateNow;
        }
        if (this.online === true && this.videoEnabled === false && this.#cameraVideoOffFrame !== undefined && outputVideoFrame === true) {
          // Camera video is turned off so feed in our custom h264 frame and AAC silence
          output.buffer.push({ time: dateNow, type: 'video', data: this.#cameraVideoOffFrame });
          output.buffer.push({ time: dateNow, type: 'audio', data: this.blankAudio });
          lastVideoFrameTime = dateNow;
        }
        if (this.migrating === true && this.#cameraTransferringFrame !== undefined && outputVideoFrame === true) {
          // Camera video is turned off so feed in our custom h264 frame and AAC silence
          output.buffer.push({ time: dateNow, type: 'video', data: this.#cameraTransferringFrame });
          output.buffer.push({ time: dateNow, type: 'audio', data: this.blankAudio });
          lastVideoFrameTime = dateNow;
        }

        // Keep our 'main' rolling buffer under a certain size
        // Live/record buffers will always reduce in length in the next section
        if (output.type === 'buffer') {
          let cutoffTime = dateNow - MAX_BUFFER_AGE;
          while (output.buffer.length > 0 && output.buffer[0].time < cutoffTime) {
            output.buffer.shift();
          }
        }

        // Output the packet data to any 'live' or 'recording' streams
        if (output.type === 'live' || output.type === 'record') {
          let packet = output.buffer.shift();
          if (packet?.type === 'video' && typeof output?.video?.write === 'function') {
            if (this.codecs?.video === 'h264') {
              packet.data = Buffer.concat([Streamer.H264NALUS.START_CODE, packet.data]);
            }
            output.video.write(packet.data);
          }
          if (packet?.type === 'audio' && typeof output?.audio?.write === 'function') {
            output.audio.write(packet.data);
          }
        }
      });
    }, 10); // Every 10ms, rather than "next tick"
  }

  // Class functions
  isBuffering() {
    return this.#outputs?.buffer !== undefined;
  }

  startBuffering() {
    if (this.#outputs?.buffer === undefined) {
      // No active buffer session, start connection to streamer
      if (this.online === true && this.videoEnabled === true && this.connected === undefined && typeof this.connect === 'function') {
        this?.log?.debug?.('Started buffering for uuid "%s"', this.uuid);
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
          }, TALKBACK_AUDIO_TIMEOUT);
        }
      });
    }

    // If we do not have an active connection, so startup connection
    this.#doConnect();

    // Add video/audio streams for our output loop to handle outputting
    this.#outputs[sessionID] = {
      type: 'live',
      video: videoStream,
      audio: audioStream,
      talk: talkbackStream,
      buffer: [],
    };

    // finally, we've started live stream
    this?.log?.debug?.(
      'Started live stream from uuid "%s" %s "%s"',
      this.uuid,
      talkbackStream !== null && typeof talkbackStream === 'object' ? 'with two-way audio and session id of' : 'and session id of',
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

    // If we do not have an active connection, so startup connection
    this.#doConnect();

    // Create buffer copy
    let trimmedBuffer = [];
    let sps = undefined;
    let pps = undefined;
    let startIndex = -1;

    if (this.#outputs?.buffer?.buffer !== undefined) {
      let buffer = this.#outputs.buffer.buffer;

      for (let i = 0; i < buffer.length; i++) {
        if (buffer[i].type === 'video') {
          let nalType = buffer[i].data[0] & 0x1f;
          if (nalType === Streamer.H264NALUS.TYPES.SPS) {
            sps = buffer[i];
          }
          if (nalType === Streamer.H264NALUS.TYPES.PPS) {
            pps = buffer[i];
          }
          if (nalType === Streamer.H264NALUS.TYPES.IDR) {
            startIndex = i;
            break;
          }
        }
      }

      if (startIndex !== -1) {
        if (Buffer.isBuffer(sps?.data) === true) {
          trimmedBuffer.push(sps);
        }
        if (Buffer.isBuffer(pps?.data) === true) {
          trimmedBuffer.push(pps);
        }
        trimmedBuffer.push(...buffer.slice(startIndex));
      } else {
        trimmedBuffer = structuredClone(buffer);
      }
    }

    // Add video/audio streams for our output loop to handle outputting
    this.#outputs[sessionID] = {
      type: 'record',
      video: videoStream,
      audio: audioStream,
      buffer: trimmedBuffer,
    };

    // Finally we've started the recording stream
    this?.log?.debug?.('Started recording stream from uuid "%s" with session id of "%s"', this.uuid, sessionID);
  }

  stopRecordStream(sessionID) {
    // Request to stop a recording stream
    if (this.#outputs?.[sessionID] !== undefined) {
      this?.log?.debug?.('Stopped recording stream from uuid "%s"', this.uuid);

      // Gracefully close audio and video pipes
      this.#outputs?.[sessionID]?.video?.end?.();
      this.#outputs?.[sessionID]?.audio?.end?.();

      delete this.#outputs[sessionID];
    }

    // If we have no more output streams active, we'll close the connection
    if (this.haveOutputs() === false) {
      this.#doClose();
    }
  }

  stopLiveStream(sessionID) {
    // Request to stop an active live stream
    if (this.#outputs?.[sessionID] !== undefined) {
      this?.log?.debug?.('Stopped live stream from uuid "%s"', this.uuid);

      // Gracefully close audio and video pipes
      this.#outputs?.[sessionID]?.video?.end?.();
      this.#outputs?.[sessionID]?.audio?.end?.();

      delete this.#outputs[sessionID];
    }

    // If we have no more output streams active, we'll close the connection
    if (this.haveOutputs() === false) {
      this.#doClose();
    }
  }

  stopBuffering() {
    if (this.#outputs?.buffer !== undefined) {
      this?.log?.debug?.('Stopped buffering from uuid "%s"', this.uuid);
      delete this.#outputs.buffer;
    }

    // If we have no more output streams active, we'll close the connection
    if (this.haveOutputs() === false) {
      this.#doClose();
    }
  }

  stopEverything() {
    if (this.haveOutputs() === true) {
      this?.log?.debug?.('Stopped buffering, live and recording from uuid "%s"', this.uuid);
      this.#outputs = {}; // No more outputs
      this.#doClose();
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
        this.#doClose();
        this.#doConnect();
      }
    }

    if (
      this.online !== deviceData.online ||
      this.videoEnabled !== deviceData.streaming_enabled ||
      this.audioEnabled !== deviceData?.audio_enabled
    ) {
      // Online status or streaming status has changed
      this.online = deviceData?.online === true;
      this.videoEnabled = deviceData?.streaming_enabled === true;
      this.audioEnabled = deviceData?.audio_enabled === true;

      if (this.haveOutputs() === true) {
        // Since online, video, audio enabled status has changed, if there any any active outputs, close and connect again
        if (this.online === false || this.videoEnabled === false || this.audioEnabled === false) {
          this.#doClose(); // as offline or streaming not enabled, close streamer
        }
        this.#doConnect();
      }
    }
  }

  addToOutput(type, data) {
    if (typeof type !== 'string' || type === '' || Buffer.isBuffer(data) === false) {
      return;
    }

    if (type === 'video' && this.codecs?.video === 'h264') {
      // Strip start code if present
      if (data.indexOf(Streamer.H264NALUS.START_CODE) === 0) {
        data = data.subarray(Streamer.H264NALUS.START_CODE.length);
      }

      let naluType = data[0] & 0x1f;

      if (naluType === Streamer.H264NALUS.TYPES.SPS) {
        this.#lastSPS = Buffer.concat([Streamer.H264NALUS.START_CODE, data]);
        return;
      }

      if (naluType === Streamer.H264NALUS.TYPES.PPS) {
        this.#lastPPS = Buffer.concat([Streamer.H264NALUS.START_CODE, data]);
        return;
      }

      // If it's a slice, prepend SPS and PPS if available
      if (
        (naluType === Streamer.H264NALUS.TYPES.IDR || naluType === Streamer.H264NALUS.TYPES.SLICE_NON_IDR) &&
        Buffer.isBuffer(this.#lastSPS) === true &&
        Buffer.isBuffer(this.#lastPPS) === true
      ) {
        data = Buffer.concat([this.#lastSPS, this.#lastPPS, Streamer.H264NALUS.START_CODE, data]);
      } else {
        // Still prepend start code for other NALs
        data = Buffer.concat([Streamer.H264NALUS.START_CODE, data]);
      }
    }

    Object.values(this.#outputs).forEach((output) => {
      output.buffer.push({
        time: Date.now(),
        type: type,
        data: data,
      });
    });
  }

  haveOutputs() {
    return Object.keys(this.#outputs).length > 0;
  }

  #doConnect() {
    if (this.online === true && this.videoEnabled === true && this.connected === undefined && typeof this.connect === 'function') {
      this.connect();
    }
  }

  #doClose() {
    this.#lastSPS = undefined;
    this.#lastPPS = undefined;
    this.#seenIDR = undefined;
    if (typeof this.close === 'function') {
      this.close();
    }
  }
}
