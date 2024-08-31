// Nest Cameras
// Part of homebridge-nest-accfactory
//
// Code version 30/8/2024
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import EventEmitter from 'node:events';
import { Buffer } from 'node:buffer';
import { setTimeout, clearTimeout } from 'node:timers';
import process from 'node:process';
import child_process from 'node:child_process';
import net from 'node:net';
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Define external module requirements
import axios from 'axios';

// Define our modules
import HomeKitDevice from './HomeKitDevice.js';
import NexusStreamer from './nexusstreamer.js';

// Available video codecs we can use
const VideoCodecs = {
  COPY: 'copy',
  H264_OMX: 'h264_omx',
  LIBX264: 'libx264',
  H264_V4L2M2M: 'h264_v4l2m2m', // Not coded yet
  H264_QSV: 'h264_qsv', // Not coded yet
};

// Audio codecs we use
const AudioCodecs = {
  COPY: 'copy',
  LIBFDK_AAC: 'libfdk_aac',
  LIBSPEEX: 'libspeex',
};

const CAMERAOFFLINEJPGFILE = 'Nest_camera_offline.jpg'; // Camera offline jpg image file
const CAMERAOFFJPGFILE = 'Nest_camera_off.jpg'; // Camera video off jpg image file
const MP4BOX = 'mp4box'; // MP4 box fragement event for HKSV recording
const USERAGENT = 'Nest/5.75.0 (iOScom.nestlabs.jasper.release) os=17.4.1'; // User Agent string
const SNAPSHOTCACHETIMEOUT = 30000; // Timeout for retaining snapshot image (in milliseconds)
const __dirname = path.dirname(fileURLToPath(import.meta.url)); // Make a defined for JS __dirname

export default class NestCamera extends HomeKitDevice {
  controller = undefined; // HomeKit Camera/Doorbell controller service
  NexusStreamer = undefined; // Object for the NexusTalk Streamer
  motionServices = {}; // Object of Camera/Doorbell motion sensor(s)
  operatingModeService = undefined; // Link to camera/doorbell operating mode service
  personTimer = undefined; // Cooldown timer for person/face events
  motionTimer = undefined; // Cooldown timer for motion events
  snapshotTimer = undefined; // Timer for cached snapshot images
  cameraOfflineImage = undefined; // JPG image buffer for camera offline
  cameraVideoOffImage = undefined; // JPG image buffer for camera video off
  lastSnapshotImage = undefined; // JPG image buffer for last camera snapshot
  pendingSessions = [];
  currentSessions = [];

  constructor(accessory, api, log, eventEmitter, deviceData) {
    super(accessory, api, log, eventEmitter, deviceData);

    this.snapshotEvent = {
      type: '',
      time: 0,
      id: 0,
      done: false,
    };

    // HKSV stuff
    this.HKSVRecordingConfiguration = {}; // HomeKit Secure Video recording configuration
    this.HKSVRecorder = {
      record: false, // Tracks updateRecordingActive. default is not recording, but HomeKit will select the current state
      ffmpeg: null, // ffmpeg process for recording
      video: null, // video input stream
      audio: null, // audio input stream
      id: null, // HKSV Recording ID
      time: 0, // Time to record from in buffer, 0 means from start of buffer
      eventEmitter: null, // Event emitter object for MP4 fragments
    };

    // buffer for camera offline jpg image
    let imageFile = path.resolve(__dirname + '/res/' + CAMERAOFFLINEJPGFILE);
    if (fs.existsSync(imageFile) === true) {
      this.cameraOfflineImage = fs.readFileSync(imageFile);
    }

    // buffer for camera stream off jpg image
    imageFile = path.resolve(__dirname + '/res/' + CAMERAOFFJPGFILE);
    if (fs.existsSync(imageFile) === true) {
      this.cameraVideoOffImage = fs.readFileSync(imageFile);
    }

    this.set({ 'watermark.enabled': false }); // 'Try' to turn off Nest watermark in video stream
  }

  // Class functions
  addServices() {
    this.createCameraMotionServices();

    // Setup HomeKit camera controller
    this.controller = new this.hap.CameraController(this.generateControllerOptions());
    this.accessory.configureController(this.controller);

    // Setup additional HomeKit services and characteristics we'll use
    if (this.controller.microphoneService.testCharacteristic(this.hap.Characteristic.StatusActive) === false) {
      this.controller.microphoneService.addCharacteristic(this.hap.Characteristic.StatusActive);
    }
    if (this.controller.speakerService.testCharacteristic(this.hap.Characteristic.StatusActive) === false) {
      this.controller.speakerService.addCharacteristic(this.hap.Characteristic.StatusActive);
    }

    // Setup additional services/characteristics after we have a controller created
    this.createCameraServices();

    // Setup our streaming object
    this.NexusStreamer = new NexusStreamer(this.deviceData, { log: this.log });

    // Setup linkage to EveHome app if configured todo so
    if (
      this.deviceData?.eveHistory === true &&
      typeof this.motionServices?.[1]?.service === 'object' &&
      typeof this.historyService?.linkToEveHome === 'function'
    ) {
      this.historyService.linkToEveHome(this.motionServices[1].service, {
        description: this.deviceData.description,
      });
    }

    // Create extra details for output
    let postSetupDetails = [];
    this.deviceData.hksv === true && postSetupDetails.push('Using HomeKit Secure Video');
    this.switchService !== undefined && postSetupDetails.push('Chime switch');
    return postSetupDetails;
  }

  removeServices() {
    // Clean up our camera object since this device is being removed
    this.motionTimer = clearTimeout(this.motionTimer);
    this.personTimer = clearTimeout(this.personTimer);

    if (this.NexusStreamer !== undefined) {
      this.NexusStreamer.stopBuffering(); // Stop any buffering
    }

    // Stop any on-going HomeKit sessions, including termination of ffmpeg processes
    if (this.HKSVRecorder.ffmpeg !== null) {
      this.HKSVRecorder.ffmpeg.kill('SIGKILL');
    }

    this.currentSessions.forEach((session) => {
      if (typeof session.rtpSplitter?.close === 'function') {
        session.rtpSplitter.close();
      }
      session.ffmpeg.forEach((ffmpeg) => {
        ffmpeg.kill('SIGKILL');
      });
    });

    // Remove any motion services we created
    this.motionServices.forEach((service) => {
      service.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);
      this.accessory.removeService(service);
    });
    this.accessory.removeController(this.controller);
    this.motionServices = {};
    this.NexusStreamer = undefined;
    this.controller = undefined;
  }

  // Taken and adapted from:
  // https://github.com/hjdhjd/homebridge-unifi-protect/blob/eee6a4e379272b659baa6c19986d51f5bf2cbbbc/src/protect-ffmpeg-record.ts
  async *handleRecordingStreamRequest(HKSVRecordingStreamID) {
    if (
      this.motionServices?.[1]?.service !== undefined &&
      this.motionServices[1].service.getCharacteristic(this.hap.Characteristic.MotionDetected).value === false
    ) {
      // Should only be recording if motion detected.
      // Sometimes when starting up, HAP-nodeJS or HomeKit triggers this even when motion isn't occuring
      return;
    }

    // Audio if enabled on camera/doorbell && audio recording configured for HKSV
    let includeAudio =
      this.deviceData.audio_enabled === true &&
      this.deviceData.libfdk_aac === true &&
      this.controller.recordingManagement.recordingManagementService.getCharacteristic(this.hap.Characteristic.RecordingAudioActive)
        .value === 1;
    let recordCodec = VideoCodecs.LIBX264;

    // Build our ffmpeg commandline for the video stream
    let commandLine =
      '-hide_banner -nostats' +
      ' -f h264 -an -thread_queue_size 1024 -copytb 1 -i pipe:0' + // Video data only on stdin
      (includeAudio === true ? ' -f aac -vn -thread_queue_size 1024 -i pipe:3' : ''); // Audio data only on extra pipe created in spawn command

    commandLine =
      commandLine +
      ' -map 0:v' + // stdin, the first input is video data
      ' -an' + // No audio in this stream
      ' -codec:v ' +
      recordCodec +
      ' -fps_mode vfr -time_base 1:90000';

    // Configure for libx264 (software encoder)
    commandLine =
      commandLine +
      ' -pix_fmt yuv420p' +
      ' -level:v ' +
      (this.HKSVRecordingConfiguration.videoCodec.parameters.level === this.hap.H264Level.LEVEL4_0
        ? '4.0'
        : this.HKSVRecordingConfiguration.videoCodec.parameters.level === this.hap.H264Level.LEVEL3_2
          ? '3.2'
          : '3.1') +
      ' -preset veryfast' +
      ' -b:v ' +
      this.HKSVRecordingConfiguration.videoCodec.parameters.bitRate +
      'k' +
      ' -filter:v fps=' +
      this.HKSVRecordingConfiguration.videoCodec.resolution[2] + // convert to framerate HomeKit has requested
      ' -force_key_frames expr:gte(t,n_forced*' +
      this.HKSVRecordingConfiguration.videoCodec.parameters.iFrameInterval / 1000 +
      ')' +
      ' -movflags frag_keyframe+empty_moov+default_base_moof';

    // We have seperate video and audio streams that need to be muxed together if audio recording enabled
    if (includeAudio === true) {
      let audioSampleRates = ['8', '16', '24', '32', '44.1', '48'];

      commandLine =
        commandLine +
        ' -map 1:a' + // pipe:3, the second input is audio data
        ' -vn' + // No video in this stream
        ' -codec:a ' +
        AudioCodecs.LIBFDK_AAC +
        ' -profile:a aac_low' + // HAP.AudioRecordingCodecType.AAC_LC
        ' -ar ' +
        audioSampleRates[this.HKSVRecordingConfiguration.audioCodec.samplerate] +
        'k' +
        ' -b:a ' +
        this.HKSVRecordingConfiguration.audioCodec.bitrate +
        'k' +
        ' -ac ' +
        this.HKSVRecordingConfiguration.audioCodec.audioChannels;
    }

    commandLine =
      commandLine +
      ' -f mp4' + // output is an mp4
      ' pipe:1'; // output to stdout

    this.HKSVRecorder.ffmpeg = child_process.spawn(path.resolve(this.deviceData.ffmpeg.path + '/ffmpeg'), commandLine.split(' '), {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    }); // Extra pipe, #3 for audio data

    this.HKSVRecorder.video = this.HKSVRecorder.ffmpeg.stdin; // Video data on stdio pipe for ffmpeg
    this.HKSVRecorder.audio = includeAudio === true ? this.HKSVRecorder.ffmpeg.stdio[3] : null; // Audio data on extra pipe for ffmpeg or null if audio recording disabled

    // Process FFmpeg output and parse out the fMP4 stream it's generating for HomeKit Secure Video.
    let mp4boxes = [];
    let mp4FragmentData = [];
    this.HKSVRecorder.eventEmitter = new EventEmitter();
    this.HKSVRecorder.ffmpeg.stdout.on('data', (data) => {
      // Process the mp4 data from our socket connection and convert into mp4 fragment boxes we need
      mp4FragmentData = mp4FragmentData.length === 0 ? data : Buffer.concat([mp4FragmentData, data]);
      while (mp4FragmentData.length >= 8) {
        let boxSize = mp4FragmentData.slice(0, 4).readUInt32BE(0); // Includes header and data size

        if (mp4FragmentData.length < boxSize) {
          // We dont have enough data in the buffer yet to process the full mp4 box
          // so, exit loop and await more data
          break;
        }

        // Add it to our queue to be pushed out through the generator function.
        mp4boxes.push({
          header: mp4FragmentData.slice(0, 8),
          type: mp4FragmentData.slice(4, 8).toString(),
          data: mp4FragmentData.slice(8, boxSize),
        });
        this.HKSVRecorder.eventEmitter.emit(MP4BOX);

        // Remove the section of data we've just processed from our buffer
        mp4FragmentData = mp4FragmentData.slice(boxSize);
      }
    });

    this.HKSVRecorder.ffmpeg.on('exit', (code, signal) => {
      this.HKSVRecorder.audio && this.HKSVRecorder.audio.end(); // Tidy up our created extra pipe
      if (signal !== 'SIGKILL') {
        this.log.debug('FFmpeg recorder process exited', code, signal);
      }
    });

    this.HKSVRecorder.ffmpeg.on('error', (error) => {
      this.log.debug('FFmpeg recorder process error', error);
    });

    // ffmpeg outputs to stderr
    this.HKSVRecorder.ffmpeg.stderr.on('data', (data) => {
      if (data.toString().includes('frame=') === false) {
        // Monitor ffmpeg output while testing. Use 'ffmpeg as a debug option'
        this.log.debug(data.toString());
      }
    });

    this.NexusStreamer.startRecordStream('HKSV' + HKSVRecordingStreamID, this.HKSVRecorder.video, this.HKSVRecorder.audio, true, 0);
    this.log.info(
      'Recording started from "%s" %s %s',
      this.deviceData.description,
      includeAudio === false ? 'without audio' : '',
      recordCodec !== VideoCodecs.COPY ? 'using H264 encoder ' + recordCodec : '',
    );

    // Loop generating MOOF/MDAT box pairs for HomeKit Secure Video.
    // HAP-NodeJS cancels this async generator function when recording completes also
    let segment = [];
    for (;;) {
      if (this.HKSVRecorder.ffmpeg === null) {
        // ffmpeg recorder process isn't running, so finish up the loop
        break;
      }

      if (mp4boxes.length === 0) {
        // since the ffmpeg recorder process hasn't notified us of any mp4 fragment boxes, wait until there are some
        await EventEmitter.once(this.HKSVRecorder.eventEmitter, MP4BOX);
      }

      let mp4box = mp4boxes.shift();
      if (typeof mp4box !== 'object') {
        // Not an mp4 fragment box, so try again
        continue;
      }

      // Queue up this fragment mp4 segment
      segment.push(mp4box.header, mp4box.data);

      if (mp4box.type === 'moov' || mp4box.type === 'mdat') {
        yield { data: Buffer.concat(segment), isLast: false };
        segment = [];
      }
    }
  }

  closeRecordingStream(HKSVRecordingStreamID, closeReason) {
    this.NexusStreamer.stopRecordStream('HKSV' + HKSVRecordingStreamID); // Stop the associated recording stream
    this.HKSVRecorder.ffmpeg && this.HKSVRecorder.ffmpeg.kill('SIGKILL'); // Kill the ffmpeg recorder process
    this.HKSVRecorder.ffmpeg = null; // No more ffmpeg process
    this.HKSVRecorder.video = null; // No more video stream handle
    this.HKSVRecorder.audio = null; // No more audio stream handle
    this.HKSVRecorder.eventEmitter.emit(MP4BOX); // This will ensure we cleanly exit out from our segment generator
    this.HKSVRecorder.eventEmitter.removeAllListeners(MP4BOX); // Tidy up our event listeners
    this.HKSVRecorder.eventEmitter = null;

    // Log recording finished messages depending on reason
    if (closeReason === this.hap.HDSProtocolSpecificErrorReason.NORMAL) {
      this?.log?.info && this.log.info('Recording completed from "%s"', this.deviceData.description);
    } else {
      this?.log?.warn &&
        this.log.warn(
          'Recording completed with error from "%s". Reason was "%s"',
          this.deviceData.description,
          this.hap.HDSProtocolSpecificErrorReason[closeReason],
        );
    }
  }

  updateRecordingActive(enableHKSVRecordings) {
    // We'll use the change here to determine if we start/stop any buffering.
    // Also track the HomeKit status here as gets called multiple times with no change
    // Might be fixed in HAP-NodeJS 11.x or later, but we'll keep our internal check
    if (enableHKSVRecordings === this.HKSVRecorder.record || this.NexusStreamer === undefined) {
      return;
    }

    if (enableHKSVRecordings === true) {
      // Start a buffering stream for this camera/doorbell. Ensures motion captures all video on motion trigger
      // Required due to data delays by on prem Nest to cloud to HomeKit accessory to iCloud etc
      // Make sure have appropriate bandwidth!!!
      this?.log?.info && this.log.info('Pre-buffering started for "%s"', this.deviceData.description);
      this.NexusStreamer.startBuffering();
    }
    if (enableHKSVRecordings === false) {
      this.NexusStreamer.stopBuffering();
      this?.log?.info && this.log.info('Pre-buffering stopped for "%s"', this.deviceData.description);
    }

    this.HKSVRecorder.record = enableHKSVRecordings;
  }

  updateRecordingConfiguration(HKSVRecordingConfiguration) {
    this.HKSVRecordingConfiguration = HKSVRecordingConfiguration; // Store the recording configuration HKSV has provided
  }

  async handleSnapshotRequest(snapshotRequestDetails, callback) {
    // snapshotRequestDetails.reason === ResourceRequestReason.PERIODIC
    // snapshotRequestDetails.reason === ResourceRequestReason.EVENT

    // Get current image from camera/doorbell
    let imageBuffer = undefined;

    if (this.deviceData.streaming_enabled === true && this.deviceData.online === true) {
      if (this.deviceData.hksv === false && this.snapshotEvent.type !== '' && this.snapshotEvent.done === false) {
        // Grab event snapshot from camera/doorbell stream for a non-HKSV camera
        let request = {
          method: 'get',
          url:
            this.deviceData.nexus_api_http_server_url +
            '/event_snapshot/' +
            this.deviceData.uuid.split('.')[1] +
            '/' +
            this.snapshotEvent.id +
            '?crop_type=timeline&width=' +
            snapshotRequestDetails.width +
            '&cachebuster=' +
            Math.floor(Date.now() / 1000),
          headers: {
            'User-Agent': USERAGENT,
            accept: '*/*',
            [this.deviceData.apiAccess.key]: this.deviceData.apiAccess.value + this.deviceData.apiAccess.token,
          },
          responseType: 'arraybuffer',
          timeout: 3000,
        };
        await axios(request)
          .then((response) => {
            if (typeof response.status !== 'number' || response.status !== 200) {
              throw new Error('Nest Camera API snapshot failed with error');
            }

            this.snapshotEvent.done = true; // Successfully got the snapshot for the event
            imageBuffer = response.data;
          })
          // eslint-disable-next-line no-unused-vars
          .catch((error) => {
            // Empty
          });
      }
      if (imageBuffer === undefined) {
        // Camera/doorbell image buffer is empty still, so do direct grab from Nest API
        let request = {
          method: 'get',
          url: this.deviceData.nexus_api_http_server_url + '/get_image?uuid=' + this.deviceData.uuid.split('.')[1],
          // + '&width=' + snapshotRequestDetails.width,
          headers: {
            'User-Agent': USERAGENT,
            accept: '*/*',
            [this.deviceData.apiAccess.key]: this.deviceData.apiAccess.value + this.deviceData.apiAccess.token,
          },
          responseType: 'arraybuffer',
          timeout: 3000,
        };
        await axios(request)
          .then((response) => {
            if (typeof response.status !== 'number' || response.status !== 200) {
              throw new Error('Nest Camera API snapshot failed with error');
            }

            imageBuffer = response.data;
            this.lastSnapshotImage = response.data;

            // Keep this snapshot image cached for a certain period
            this.snapshotTimer = clearTimeout(this.snapshotTimer);
            this.snapshotTimer = setTimeout(() => {
              this.lastSnapshotImage = undefined;
            }, SNAPSHOTCACHETIMEOUT);
          })
          // eslint-disable-next-line no-unused-vars
          .catch((error) => {
            // Empty
          });
      }
    }

    if (this.deviceData.streaming_enabled === false && this.deviceData.online === true && this.cameraVideoOffImage !== undefined) {
      // Return 'camera switched off' jpg to image buffer
      imageBuffer = this.cameraVideoOffImage;
    }

    if (this.deviceData.online === false && this.cameraOfflineImage !== undefined) {
      // Return 'camera offline' jpg to image buffer
      imageBuffer = this.cameraOfflineImage;
    }

    if (imageBuffer === undefined) {
      // If we get here, we have no snapshot image
      // We'll use the last success snapshop as long as its within a certain time period
      imageBuffer = this.lastSnapshotImage;
    }

    callback(imageBuffer?.length === 0 ? 'No Camera/Doorbell snapshot obtained' : null, imageBuffer);
  }

  async prepareStream(request, callback) {
    const getPort = async (options) => {
      return new Promise((resolve, reject) => {
        let server = net.createServer();
        server.unref();
        server.on('error', reject);
        server.listen(options, () => {
          let port = server.address().port;
          server.close(() => {
            resolve(port); // return port
          });
        });
      });
    };

    // Generate streaming session information
    let sessionInfo = {
      address: request.targetAddress,
      videoPort: request.video.port,
      localVideoPort: await getPort(),
      videoCryptoSuite: request.video.srtpCryptoSuite,
      videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
      videoSSRC: this.hap.CameraController.generateSynchronisationSource(),

      audioPort: request.audio.port,
      localAudioPort: await getPort(),
      audioTalkbackPort: await getPort(),
      rptSplitterPort: await getPort(),
      audioCryptoSuite: request.video.srtpCryptoSuite,
      audioSRTP: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
      audioSSRC: this.hap.CameraController.generateSynchronisationSource(),

      rtpSplitter: null,
      ffmpeg: [], // Array of ffmpeg processes we create for streaming video/audio and audio talkback
      video: null,
      audio: null,
    };

    // Build response back to HomeKit with the details filled out

    // Drop ip module by using small snippet of code below
    // Convert ipv4 mapped into ipv6 address into pure ipv4
    if (request.addressVersion === 'ipv4' && request.sourceAddress.startsWith('::ffff:') === true) {
      request.sourceAddress = request.sourceAddress.replace('::ffff:', '');
    }

    let response = {
      address: request.sourceAddress, // IP Address version must match
      video: {
        port: sessionInfo.localVideoPort,
        ssrc: sessionInfo.videoSSRC,
        srtp_key: request.video.srtp_key,
        srtp_salt: request.video.srtp_salt,
      },
      audio: {
        port: sessionInfo.rptSplitterPort,
        ssrc: sessionInfo.audioSSRC,
        srtp_key: request.audio.srtp_key,
        srtp_salt: request.audio.srtp_salt,
      },
    };
    this.pendingSessions[request.sessionID] = sessionInfo; // Store the session information
    callback(undefined, response);
  }

  async handleStreamRequest(request, callback) {
    // called when HomeKit asks to start/stop/reconfigure a camera/doorbell stream
    if (this.NexusStreamer === undefined) {
      if (typeof callback === 'function') {
        callback(); // do callback if defined
      }
      return;
    }

    if (this.deviceData?.ffmpeg.path === undefined && request.type === this.hap.StreamRequestTypes.START) {
      this?.log?.warn &&
        this.log.warn(
          'Received request to start live video for "%s" however we do not have an ffmpeg binary present',
          this.deviceData.description,
        );

      if (typeof callback === 'function') {
        callback(); // do callback if defined
      }
      return;
    }

    if (request.type === this.hap.StreamRequestTypes.START) {
      this.currentSessions[request.sessionID] = this.pendingSessions[request.sessionID]; // Move our pending session to ongoing session
      delete this.pendingSessions[request.sessionID]; // remove this pending session information

      // Build our ffmpeg command string for the video stream
      let commandLine =
        '-hide_banner -nostats' +
        ' -use_wallclock_as_timestamps 1' +
        //   ' -f h264 -thread_queue_size 1024 -copytb 1 -i pipe:0' + // Video data only on stdin
        ' -f h264 -thread_queue_size 1024 -i pipe:0' + // Video data only on stdin
        (this.deviceData.audio_enabled === true && this.deviceData.ffmpeg.libfdk_aac === true
          ? ' -f aac -thread_queue_size 1024 -i pipe:3'
          : ''); // Audio data only on extra pipe created in spawn command

      // Build our video command for ffmpeg
      commandLine =
        commandLine +
        ' -map 0:v' + // stdin, the first input is video data
        ' -an' + // No audio in this stream
        ' -codec:v copy' +
        ' -fps_mode vfr' +
        ' -time_base 1:90000' +
        ' -payload_type ' +
        request.video.pt +
        ' -ssrc ' +
        this.currentSessions[request.sessionID].videoSSRC +
        ' -f rtp' +
        ' -srtp_out_suite ' +
        this.hap.SRTPCryptoSuites[this.currentSessions[request.sessionID].videoCryptoSuite] +
        ' -srtp_out_params ' +
        this.currentSessions[request.sessionID].videoSRTP.toString('base64') +
        ' srtp://' +
        this.currentSessions[request.sessionID].address +
        ':' +
        this.currentSessions[request.sessionID].videoPort +
        '?rtcpport=' +
        this.currentSessions[request.sessionID].videoPort +
        '&pkt_size=' +
        request.video.mtu;

      // We have seperate video and audio streams that need to be muxed together if audio enabled
      if (this.deviceData.audio_enabled === true && this.deviceData.ffmpeg.libfdk_aac === true) {
        commandLine =
          commandLine +
          ' -map 1:a' + // pipe:3, the second input is audio data
          ' -vn' + // No video in this stream
          ' -codec:a ' +
          AudioCodecs.LIBFDK_AAC +
          ' -profile:a aac_eld' + //+ this.hap.AudioStreamingCodecType.AAC_ELD
          ' -flags +global_header' +
          ' -ar ' +
          request.audio.sample_rate +
          'k' +
          ' -b:a ' +
          request.audio.max_bit_rate +
          'k' +
          ' -ac ' +
          request.audio.channel +
          ' -payload_type ' +
          request.audio.pt +
          ' -ssrc ' +
          this.currentSessions[request.sessionID].audioSSRC +
          ' -f rtp' +
          ' -srtp_out_suite ' +
          this.hap.SRTPCryptoSuites[this.currentSessions[request.sessionID].audioCryptoSuite] +
          ' -srtp_out_params ' +
          this.currentSessions[request.sessionID].audioSRTP.toString('base64') +
          ' srtp://' +
          this.currentSessions[request.sessionID].address +
          ':' +
          this.currentSessions[request.sessionID].audioPort +
          '?rtcpport=' +
          this.currentSessions[request.sessionID].audioPort +
          '&localrtcpport=' +
          this.currentSessions[request.sessionID].localAudioPort +
          '&pkt_size=188';
      }

      // Start our ffmpeg streaming process and stream from nexus
      let ffmpegStreaming = child_process.spawn(path.resolve(this.deviceData.ffmpeg.path + '/ffmpeg'), commandLine.split(' '), {
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      }); // Extra pipe, #3 for audio data

      // ffmpeg console output is via stderr
      ffmpegStreaming.stderr.on('data', (data) => {
        if (data.toString().includes('frame=') === false) {
          // Monitor ffmpeg output while testing. Use 'ffmpeg as a debug option'
          this.log.debug(data.toString());
        }
      });

      ffmpegStreaming.on('exit', (code, signal) => {
        if (signal !== 'SIGKILL' || signal === null) {
          this.log.info('FFmpeg Audio/Video streaming processes stopped', code, signal);
          this.controller.forceStopStreamingSession(request.sessionID);
        }
      });

      // We only enable two/way audio on camera/doorbell if we have the required libraries in ffmpeg AND two-way/audio is enabled
      let ffmpegAudioTalkback = null; // No ffmpeg process for return audio yet
      if (
        this.deviceData.ffmpeg.libspeex === true &&
        this.deviceData.ffmpeg.libfdk_aac === true &&
        this.deviceData.audio_enabled === true &&
        this.deviceData.has_speaker === true &&
        this.deviceData.has_microphone === true
      ) {
        // Setup RTP splitter for two/away audio
        this.currentSessions[request.sessionID].rtpSplitter = dgram.createSocket('udp4');
        this.currentSessions[request.sessionID].rtpSplitter.bind(this.currentSessions[request.sessionID].rptSplitterPort);

        this.currentSessions[request.sessionID].rtpSplitter.on('error', () => {
          this.currentSessions[request.sessionID].rtpSplitter.close();
        });

        this.currentSessions[request.sessionID].rtpSplitter.on('message', (message) => {
          let payloadType = message.readUInt8(1) & 0x7f;
          if (payloadType === request.audio.pt) {
            // Audio payload type from HomeKit should match our payload type for audio
            if (message.length > 50) {
              // Only send on audio data if we have a longer audio packet.
              // (not sure it makes any difference, as under iOS 15 packets are roughly same length)
              this.currentSessions[request.sessionID].rtpSplitter.send(message, this.currentSessions[request.sessionID].audioTalkbackPort);
            }
          } else {
            this.currentSessions[request.sessionID].rtpSplitter.send(message, this.currentSessions[request.sessionID].localAudioPort);
            // Send RTCP to return audio as a heartbeat
            this.currentSessions[request.sessionID].rtpSplitter.send(message, this.currentSessions[request.sessionID].audioTalkbackPort);
          }
        });

        // Build ffmpeg command
        let commandLine =
          '-hide_banner -nostats' +
          ' -protocol_whitelist pipe,udp,rtp' +
          ' -f sdp' +
          ' -codec:a ' +
          AudioCodecs.LIBFDK_AAC +
          ' -i pipe:0' +
          ' -map 0:a' +
          ' -codec:a ' +
          AudioCodecs.LIBSPEEX +
          ' -frames_per_packet 4' +
          ' -vad 1' + // testing to filter background noise?
          ' -ac 1' +
          ' -ar 16k' +
          ' -f data pipe:1';

        ffmpegAudioTalkback = child_process.spawn(path.resolve(this.deviceData.ffmpeg.path + '/ffmpeg'), commandLine.split(' '), {
          env: process.env,
        });

        ffmpegAudioTalkback.on('error', (error) => {
          this?.log?.debug && this.log.debug('FFmpeg failed to start Nest camera talkback audio process', error.message);
        });

        // ffmpeg console output is via stderr
        ffmpegAudioTalkback.stderr.on('data', (data) => {
          this?.log?.debug && this.log.debug(data.toString());
        });

        // Write out SDP configuration
        // Tried to align the SDP configuration to what HomeKit has sent us in its audio request details
        ffmpegAudioTalkback.stdin.write(
          'v=0\n' +
            'o=- 0 0 IN ' +
            (this.currentSessions[request.sessionID].ipv6 ? 'IP6' : 'IP4') +
            ' ' +
            this.currentSessions[request.sessionID].address +
            '\n' +
            's=Nest Audio Talkback\n' +
            'c=IN ' +
            (this.currentSessions[request.sessionID].ipv6 ? 'IP6' : 'IP4') +
            ' ' +
            this.currentSessions[request.sessionID].address +
            '\n' +
            't=0 0\n' +
            'm=audio ' +
            this.currentSessions[request.sessionID].audioTalkbackPort +
            ' RTP/AVP ' +
            request.audio.pt +
            '\n' +
            'b=AS:' +
            request.audio.max_bit_rate +
            '\n' +
            'a=ptime:' +
            request.audio.packet_time +
            '\n' +
            'a=rtpmap:' +
            request.audio.pt +
            ' MPEG4-GENERIC/' +
            request.audio.sample_rate * 1000 +
            '/1\n' +
            'a=fmtp:' +
            request.audio.pt +
            ' profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3;config=F8F0212C00BC00\n' +
            'a=crypto:1 ' +
            this.hap.SRTPCryptoSuites[this.currentSessions[request.sessionID].audioCryptoSuite] +
            ' inline:' +
            this.currentSessions[request.sessionID].audioSRTP.toString('base64'),
        );
        ffmpegAudioTalkback.stdin.end();
      }

      this?.log?.info &&
        this.log.info(
          'Live stream started on "%s" %s',
          this.deviceData.description,
          ffmpegAudioTalkback?.stdout ? 'with two-way audio' : '',
        );

      // Start the stream from nexus
      this.NexusStreamer.startLiveStream(
        request.sessionID,
        ffmpegStreaming.stdin,
        ffmpegStreaming?.stdio?.[3] ? ffmpegStreaming.stdio[3] : null,
        ffmpegAudioTalkback?.stdout ? ffmpegAudioTalkback.stdout : null,
      );

      // Store our ffmpeg sessions
      ffmpegStreaming && this.currentSessions[request.sessionID].ffmpeg.push(ffmpegStreaming); // Store ffmpeg process ID
      ffmpegAudioTalkback && this.currentSessions[request.sessionID].ffmpeg.push(ffmpegAudioTalkback); // Store ffmpeg audio return process ID
      this.currentSessions[request.sessionID].video = request.video; // Cache the video request details
      this.currentSessions[request.sessionID].audio = request.audio; // Cache the audio request details
    }

    if (request.type === this.hap.StreamRequestTypes.STOP && typeof this.currentSessions[request.sessionID] === 'object') {
      this.NexusStreamer.stopLiveStream(request.sessionID);

      // Close off any running ffmpeg and/or splitter processes we created
      if (typeof this.currentSessions[request.sessionID]?.rtpSplitter?.close === 'function') {
        this.currentSessions[request.sessionID].rtpSplitter.close();
      }
      this.currentSessions[request.sessionID].ffmpeg.forEach((ffmpeg) => {
        ffmpeg.kill('SIGKILL');
      });

      delete this.currentSessions[request.sessionID];

      this?.log?.info && this.log.info('Live stream stopped from "%s"', this.deviceData.description);
    }

    if (request.type === this.hap.StreamRequestTypes.RECONFIGURE && typeof this.currentSessions[request.sessionID] === 'object') {
      this?.log?.debug && this.log.debug('Unsupported reconfiguration request for live stream on "%s"', this.deviceData.description);
    }

    if (typeof callback === 'function') {
      callback(); // do callback if defined
    }
  }

  updateServices(deviceData) {
    if (typeof deviceData !== 'object' || this.controller === undefined || this.NexusStreamer === undefined) {
      return;
    }

    // For non-HKSV enabled devices, we will process any activity zone changes to add or remove any motion services
    if (deviceData.hksv === false && JSON.stringify(deviceData.activity_zones) !== JSON.stringify(this.deviceData.activity_zones)) {
      // Check to see if any activity zones were added
      deviceData.activity_zones.forEach((zone) => {
        if (typeof this.motionServices[zone.id]?.service === 'undefined') {
          // Zone doesn't have an associated motion sensor, so add one
          let tempService = this.accessory.addService(this.hap.Service.MotionSensor, zone.id === 1 ? '' : zone.name, zone.id);
          tempService.updateCharacteristic(this.hap.Characteristic.MotionDetected, false); // No motion initially
          this.motionServices[zone.id] = { service: tempService };
        }
      });

      // Check to see if any activity zones were removed
      Object.entries(this.motionServices).forEach(([zoneID, service]) => {
        if (deviceData.activity_zones.findIndex(({ id }) => id === zoneID) === -1) {
          // Motion service we created doesn't appear in zone list anymore, so assume deleted
          this.accessory.removeService(service.service);
          delete this.motionServices[zoneID];
        }
      });
    }

    if (this.operatingModeService !== undefined) {
      // Update camera off/on status
      // 0 = Enabled
      // 1 = Disabled
      this.operatingModeService.updateCharacteristic(
        this.hap.Characteristic.ManuallyDisabled,
        deviceData.streaming_enabled === true ? 0 : 1,
      );

      if (deviceData.has_statusled === true && typeof deviceData.statusled_brightness === 'number') {
        // Set camera recording indicator. This cannot be turned off on Nest Cameras/Doorbells
        // 0 = auto
        // 1 = low
        // 2 = high
        this.operatingModeService.updateCharacteristic(
          this.hap.Characteristic.CameraOperatingModeIndicator,
          deviceData.statusled_brightness !== 1,
        );
      }

      if (deviceData.has_irled === true) {
        // Set nightvision status in HomeKit
        this.operatingModeService.updateCharacteristic(this.hap.Characteristic.NightVision, deviceData.irled_enabled);
      }

      if (deviceData.has_video_flip === true) {
        // Update image flip status
        this.operatingModeService.updateCharacteristic(this.hap.Characteristic.ImageRotation, deviceData.video_flipped === true ? 180 : 0);
      }
    }

    if (deviceData.hksv === true && this.controller?.recordingManagement?.recordingManagementService !== undefined) {
      // Update recording audio status
      this.controller.recordingManagement.recordingManagementService.updateCharacteristic(
        this.hap.Characteristic.RecordingAudioActive,
        deviceData.audio_enabled === true ? 1 : 0,
      );
    }

    if (this.controller.microphoneService !== undefined) {
      // Update online status
      this.controller.microphoneService.updateCharacteristic(this.hap.Characteristic.StatusActive, deviceData.online);

      // if audio is disabled, we'll mute microphone
      this.controller.setMicrophoneMuted(deviceData.audio_enabled === false ? true : false);
    }
    if (this.controller.speakerService !== undefined) {
      // Update online status
      this.controller.speakerService.updateCharacteristic(this.hap.Characteristic.StatusActive, deviceData.online);

      // if audio is disabled, we'll mute speaker
      this.controller.setSpeakerMuted(deviceData.audio_enabled === false ? true : false);
    }

    // Notify the Nexus object of any camera detail updates that it might need to know about
    this.NexusStreamer.update(deviceData);

    // Process alerts, the most recent alert is first
    // For HKSV, we're interested motion events
    // For non-HKSV, we're interested motion, face and person events (maybe sound and package later)
    deviceData.alerts.forEach((event) => {
      // Handle motion event
      // For a HKSV enabled camera, we will use this to trigger the starting of the HKSV recording if the camera is active
      if (event.types.includes('motion') === true) {
        if (this.motionTimer === undefined) {
          this?.log?.info &&
            this.log.info(
              'Motion detected at "%s" %s',
              this.deviceData.description,
              this.operatingModeService.getCharacteristic(this.hap.Characteristic.HomeKitCameraActive).value === 0
                ? 'but video recording disabled'
                : '',
            );
        }

        event.zone_ids.forEach((zoneID) => {
          if (
            typeof this.motionServices?.[zoneID]?.service === 'object' &&
            this.motionServices[zoneID].service.getCharacteristic(this.hap.Characteristic.MotionDetected).value !== true
          ) {
            // Trigger motion for matching zone of not aleady active
            this.motionServices[zoneID].service.updateCharacteristic(this.hap.Characteristic.MotionDetected, true);

            // Log motion srarted into history
            if (typeof this.historyService?.addHistory === 'function') {
              this.historyService.addHistory(this.motionServices[zoneID].service, {
                time: Math.floor(Date.now() / 1000),
                status: 1,
              });
            }
          }
        });

        // Clear any motion active timer so we can extend of more motion detected
        clearTimeout(this.motionTimer);
        this.motionTimer = setTimeout(() => {
          event.zone_ids.forEach((zoneID) => {
            if (typeof this.motionServices?.[zoneID]?.service === 'object') {
              // Mark associted motion services as motion not detected
              this.motionServices[zoneID].service.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);

              // Log motion srarted into history
              if (typeof this.historyService?.addHistory === 'function') {
                this.historyService.addHistory(this.motionServices[zoneID].service, {
                  time: Math.floor(Date.now() / 1000),
                  status: 0,
                });
              }
            }
          });

          this.motionTimer = undefined; // No motion timer active
        }, this.deviceData.motionCooldown * 1000);
      }

      // Handle person/face event
      // We also treat a 'face' event the same as a person event ie: if you have a face, you have a person
      if (event.types.includes('person') === true || event.types.includes('face') === true) {
        if (this.personTimer === undefined) {
          // We don't have a person cooldown timer running, so we can process the 'person'/'face' event
          if (this?.log?.info && this.deviceData.hksv === false) {
            // We'll only log a person detected event if HKSV is disabled
            this.log.info('Person detected at "%s"', this.deviceData.description);
          }

          // Cooldown for person being detected
          // Start this before we process further
          this.personTimer = setTimeout(() => {
            clearTimeout(this.personTimer);

            // Clear snapshot event image after timeout
            this.snapshotEvent = {
              type: '',
              time: 0,
              id: 0,
              done: false,
            };

            this.personTimer = undefined; // No person timer active
          }, this.deviceData.personCooldown * 1000);

          // Check which zone triggered the person alert and update associated motion sensor(s)
          this.snapshotEvent = {
            type: 'person',
            time: event.playback_time,
            id: event.id,
            done: false,
          };

          if (event.types.includes('motion') === false) {
            // If person/face events doesn't include a motion event, add in here
            // This will handle all the motion trigging stuff
            event.types.push('motion');
          }
        }
      }
    });
  }

  createCameraMotionServices() {
    // First up, remove any motion services present in the accessory
    // This will help with any 'restored' service Homebridge has done
    // And allow for zone changes on the camera/doorbell
    this.motionServices = {};
    this.accessory.services.forEach((service) => {
      if (service.UUID === this.hap.Service.MotionSensor.UUID) {
        this.accessory.removeService(service);
      }
    });

    if (this.deviceData.has_motion_detection === true && typeof this.deviceData.activity_zones === 'object') {
      // We have the capability of motion sensing on device, so setup motion sensor(s)
      // If we have HKSV video enabled, we'll only create a single motion sensor
      // A zone with the ID of 1 is treated as the main motion sensor
      this.deviceData.activity_zones.forEach((zone) => {
        if (this.deviceData.hksv === false || (this.deviceData.hksv === true && zone.id === 1)) {
          let tempService = this.accessory.addService(this.hap.Service.MotionSensor, zone.id === 1 ? '' : zone.name, zone.id);
          tempService.updateCharacteristic(this.hap.Characteristic.MotionDetected, false); // No motion initially
          this.motionServices[zone.id] = {
            service: tempService,
          };
        }
      });
    }
  }

  createCameraServices() {
    if (this.controller === undefined) {
      return;
    }

    this.operatingModeService = this.controller?.recordingManagement?.operatingModeService;
    if (this.operatingModeService === undefined) {
      // Add in operating mode service for a non-hksv camera/doorbell
      // Allow us to change things such as night vision, camera indicator etc within HomeKit fpr those also:-)
      this.operatingModeService = this.accessory.getService(this.hap.Service.CameraOperatingMode);
      if (this.operatingModeService === undefined) {
        this.operatingModeService = this.accessory.addService(this.hap.Service.CameraOperatingMode, '', 1);
      }
    }

    // Setup set callbacks for characteristics
    if (this.deviceData.has_statusled === true && this.operatingModeService !== undefined) {
      if (this.operatingModeService.testCharacteristic(this.hap.Characteristic.CameraOperatingModeIndicator) === false) {
        this.operatingModeService.addOptionalCharacteristic(this.hap.Characteristic.CameraOperatingModeIndicator);
      }
      this.operatingModeService.getCharacteristic(this.hap.Characteristic.CameraOperatingModeIndicator).onSet((value) => {
        // 0 = auto, 1 = low, 2 = high
        // We'll use auto mode for led on and low for led off
        if (
          (value === true && this.deviceData.statusled_brightness !== 0) ||
          (value === false && this.deviceData.statusled_brightness !== 1)
        ) {
          this.set({ 'statusled.brightness': value === true ? 0 : 1 });
          if (this?.log?.info) {
            this.log.info('Recording status LED on "%s" was turned', this.deviceData.description, value === true ? 'on' : 'off');
          }
        }
      });

      this.operatingModeService.getCharacteristic(this.hap.Characteristic.CameraOperatingModeIndicator).onGet(() => {
        return this.deviceData.statusled_brightness !== 1;
      });
    }

    if (this.deviceData.has_irled === true && this.operatingModeService !== undefined) {
      if (this.operatingModeService.testCharacteristic(this.hap.Characteristic.NightVision) === false) {
        this.operatingModeService.addOptionalCharacteristic(this.hap.Characteristic.NightVision);
      }

      this.operatingModeService.getCharacteristic(this.hap.Characteristic.NightVision).onSet((value) => {
        // only change IRLed status value if different than on-device
        if ((value === false && this.deviceData.irled_enabled === true) || (value === true && this.deviceData.irled_enabled === false)) {
          this.set({ 'irled.state': value === true ? 'auto_on' : 'always_off' });

          if (this?.log?.info) {
            this.log.info('Night vision on "%s" was turned', this.deviceData.description, value === true ? 'on' : 'off');
          }
        }
      });

      this.operatingModeService.getCharacteristic(this.hap.Characteristic.NightVision).onGet(() => {
        return this.deviceData.irled_enabled;
      });
    }

    if (this.operatingModeService !== undefined) {
      this.operatingModeService.getCharacteristic(this.hap.Characteristic.HomeKitCameraActive).onSet((value) => {
        if (value !== this.operatingModeService.getCharacteristic(this.hap.Characteristic.HomeKitCameraActive).value) {
          // Make sure only updating status if HomeKit value *actually changes*
          if ((this.deviceData.streaming_enabled === false && value === 1) || (this.deviceData.streaming_enabled === true && value === 0)) {
            // Camera state does not reflect requested state, so fix
            this.set({ 'streaming.enabled': value === 1 ? true : false });
            if (this.log.info) {
              this.log.info('Camera on "%s" was turned', this.deviceData.description, value === 1 ? 'on' : 'off');
            }
          }
        }
      });

      this.operatingModeService.getCharacteristic(this.hap.Characteristic.HomeKitCameraActive).onGet(() => {
        return this.deviceData.streaming_enabled === true ? 1 : 0;
      });
    }

    if (this.deviceData.has_video_flip === true && this.operatingModeService !== undefined) {
      if (this.operatingModeService.testCharacteristic(this.hap.Characteristic.ImageRotation) === false) {
        this.operatingModeService.addOptionalCharacteristic(this.hap.Characteristic.ImageRotation);
      }

      this.operatingModeService.getCharacteristic(this.hap.Characteristic.ImageRotation).onGet(() => {
        return this.deviceData.video_flipped === true ? 180 : 0;
      });
    }

    if (this.deviceData.has_irled === true && this.operatingModeService !== undefined) {
      if (this.operatingModeService.testCharacteristic(this.hap.Characteristic.ManuallyDisabled) === false) {
        this.operatingModeService.addOptionalCharacteristic(this.hap.Characteristic.ManuallyDisabled);
      }

      this.operatingModeService.getCharacteristic(this.hap.Characteristic.ManuallyDisabled).onGet(() => {
        return this.deviceData.streaming_enabled === true ? 0 : 1;
      });
    }

    if (this.deviceData.has_microphone === true && this.controller?.recordingManagement?.recordingManagementService !== undefined) {
      this.controller.recordingManagement.recordingManagementService
        .getCharacteristic(this.hap.Characteristic.RecordingAudioActive)
        .onSet((value) => {
          if ((this.deviceData.audio_enabled === true && value === 0) || (this.deviceData.audio_enabled === false && value === 1)) {
            this.set({ 'audio.enabled': value === 1 ? true : false });
            if (this?.log?.info) {
              this.log.info('Audio recording on "%s" was turned', this.deviceData.description, value === 1 ? 'on' : 'off');
            }
          }
        });

      this.controller.recordingManagement.recordingManagementService
        .getCharacteristic(this.hap.Characteristic.RecordingAudioActive)
        .onGet(() => {
          return this.deviceData.audio_enabled === true ? 1 : 0;
        });
    }
  }

  generateControllerOptions() {
    // Setup HomeKit controller camera/doorbell options
    let controllerOptions = {
      cameraStreamCount: this.deviceData.maxStreams,
      delegate: this,
      streamingOptions: {
        supportedCryptoSuites: [this.hap.SRTPCryptoSuites.NONE, this.hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
        video: {
          resolutions: [
            // width, height, framerate
            [3840, 2160, 30], // 4K
            [1920, 1080, 30], // 1080p
            [1600, 1200, 30], // Native res of Nest Hello
            [1280, 960, 30],
            [1280, 720, 30], // 720p
            [1024, 768, 30],
            [640, 480, 30],
            [640, 360, 30],
            [480, 360, 30],
            [480, 270, 30],
            [320, 240, 30],
            [320, 240, 15], // Apple Watch requires this configuration (Apple Watch also seems to required OPUS @16K)
            [320, 180, 30],
            [320, 180, 15],
          ],
          codec: {
            type: this.hap.VideoCodecType.H264,
            profiles: [this.hap.H264Profile.BASELINE, this.hap.H264Profile.MAIN, this.hap.H264Profile.HIGH],
            levels: [this.hap.H264Level.LEVEL3_1, this.hap.H264Level.LEVEL3_2, this.hap.H264Level.LEVEL4_0],
          },
        },
        audio: {
          twoWayAudio: this.deviceData.has_speaker === true && this.deviceData.has_microphone === true,
          codecs: [
            {
              type: this.hap.AudioStreamingCodecType.AAC_ELD,
              samplerate: this.hap.AudioStreamingSamplerate.KHZ_16,
              audioChannel: 1,
            },
          ],
        },
      },
      recording: undefined,
      sensors: undefined,
    };

    if (this.deviceData.hksv === true) {
      controllerOptions.recording = {
        delegate: this,
        options: {
          overrideEventTriggerOptions: [this.hap.EventTriggerOption.MOTION],
          mediaContainerConfiguration: [
            {
              fragmentLength: 4000,
              type: this.hap.MediaContainerType.FRAGMENTED_MP4,
            },
          ],
          prebufferLength: 4000, // Seems to always be 4000???
          video: {
            resolutions: [
              // width, height, framerate
              [3840, 2160, 30], // 4K
              [1920, 1080, 30], // 1080p
              [1600, 1200, 30], // Native res of Nest Hello
              [1280, 960, 30],
              [1280, 720, 30], // 720p
              [1024, 768, 30],
              [640, 480, 30],
              [640, 360, 30],
              [480, 360, 30],
              [480, 270, 30],
              [320, 240, 30],
              [320, 240, 15], // Apple Watch requires this configuration (Apple Watch also seems to required OPUS @16K)
              [320, 180, 30],
              [320, 180, 15],
            ],
            parameters: {
              profiles: [this.hap.H264Profile.BASELINE, this.hap.H264Profile.MAIN, this.hap.H264Profile.HIGH],
              levels: [this.hap.H264Level.LEVEL3_1, this.hap.H264Level.LEVEL3_2, this.hap.H264Level.LEVEL4_0],
            },
            type: this.hap.VideoCodecType.H264,
          },
          audio: {
            codecs: [
              {
                type: this.hap.AudioRecordingCodecType.AAC_LC,
                samplerate: this.hap.AudioRecordingSamplerate.KHZ_16,
                audioChannel: 1,
              },
            ],
          },
        },
      };

      controllerOptions.sensors = {
        motion: typeof this.motionServices?.[1]?.service === 'object' ? this.motionServices[1].service : false,
      };
    }

    return controllerOptions;
  }
}
