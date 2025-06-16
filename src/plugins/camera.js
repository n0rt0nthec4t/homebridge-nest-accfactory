// Nest Cameras
// Part of homebridge-nest-accfactory
//
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

// Define our modules
import HomeKitDevice from '../HomeKitDevice.js';
import NexusTalk from '../nexustalk.js';
import WebRTC from '../webrtc.js';

const CAMERA_RESOURCE = {
  OFFLINE: 'Nest_camera_offline.jpg',
  OFF: 'Nest_camera_off.jpg',
  TRANSFER: 'Nest_camera_transfer.jpg',
};
const MP4BOX = 'mp4box'; // MP4 box fragement event for HKSV recording
const SNAPSHOT_CACHE_TIMEOUT = 30000; // Timeout for retaining snapshot image (in milliseconds)
const STREAMING_PROTOCOL = {
  WEBRTC: 'PROTOCOL_WEBRTC',
  NEXUSTALK: 'PROTOCOL_NEXUSTALK',
};
const RESOURCE_PATH = '../res';
const __dirname = path.dirname(fileURLToPath(import.meta.url)); // Make a defined for JS __dirname

export default class NestCamera extends HomeKitDevice {
  static TYPE = 'Camera';
  static VERSION = '2025.06.16';

  controller = undefined; // HomeKit Camera/Doorbell controller service
  streamer = undefined; // Streamer object for live/recording stream
  motionServices = undefined; // Object of Camera/Doorbell motion sensor(s)
  batteryService = undefined; // If a camera has a battery <-- todo
  operatingModeService = undefined; // Link to camera/doorbell operating mode service
  personTimer = undefined; // Cooldown timer for person/face events
  motionTimer = undefined; // Cooldown timer for motion events
  snapshotTimer = undefined; // Timer for cached snapshot images
  lastSnapshotImage = undefined; // JPG image buffer for last camera snapshot
  snapshotEvent = undefined; // Event for which to get snapshot for

  // Internal data only for this class
  #hkSessions = []; // Track live and recording active sessions
  #recordingConfig = {}; // HomeKit Secure Video recording configuration
  #cameraOfflineImage = undefined; // JPG image buffer for camera offline
  #cameraVideoOffImage = undefined; // JPG image buffer for camera video off
  #cameraTransferringImage = undefined; // JPG image buffer for camera transferring between Nest/Google Home

  constructor(accessory, api, log, eventEmitter, deviceData) {
    super(accessory, api, log, eventEmitter, deviceData);

    // Load supporrt image files as required
    const loadImageIfExists = (filename, label) => {
      let buffer = undefined;
      let file = path.resolve(__dirname, RESOURCE_PATH, filename);
      if (fs.existsSync(file) === true) {
        buffer = fs.readFileSync(file);
      } else {
        this.log?.warn?.('Failed to load %s image resource for "%s"', label, this.deviceData.description);
      }
      return buffer;
    };

    this.#cameraOfflineImage = loadImageIfExists(CAMERA_RESOURCE.OFFLINE, 'offline');
    this.#cameraVideoOffImage = loadImageIfExists(CAMERA_RESOURCE.OFF, 'video off');
    this.#cameraTransferringImage = loadImageIfExists(CAMERA_RESOURCE.TRANSFER, 'transferring');
  }

  // Class functions
  onAdd(hapController = this.hap.CameraController) {
    // Setup motion services
    if (this.motionServices === undefined) {
      this.createCameraMotionServices();
    }

    // Setup HomeKit camera/doorbell controller
    if (this.controller === undefined && typeof hapController === 'function') {
      // Need to cleanup the CameraOperatingMode service. This is to allow seamless configuration
      // switching between enabling hksv or not
      // Thanks to @bcullman (Brad Ullman) for catching this
      this.accessory.removeService(this.accessory.getService(this.hap.Service.CameraOperatingMode));
      this.controller = new hapController(this.generateControllerOptions());
      this.accessory.configureController(this.controller);
    }

    // Setup additional services/characteristics after we have a controller created
    this.operatingModeService = this.controller?.recordingManagement?.operatingModeService;
    if (this.operatingModeService === undefined) {
      // Add in operating mode service for a non-hksv camera/doorbell
      // Allow us to change things such as night vision, camera indicator etc within HomeKit for those also :-)
      this.operatingModeService = this.addHKService(this.hap.Service.CameraOperatingMode, '', 1);
    }

    // Setup set characteristics
    if (this.deviceData?.has_statusled === true) {
      this.addHKCharacteristic(this.operatingModeService, this.hap.Characteristic.CameraOperatingModeIndicator, {
        onSet: (value) => {
          // 0 = auto, 1 = low, 2 = high
          // We'll use auto mode for led on and low for led off
          if (
            (value === true && this.deviceData.statusled_brightness !== 0) ||
            (value === false && this.deviceData.statusled_brightness !== 1)
          ) {
            this.set({ uuid: this.deviceData.nest_google_uuid, statusled_brightness: value === true ? 0 : 1 });
            this?.log?.info?.('Recording status LED on "%s" was turned', this.deviceData.description, value === true ? 'on' : 'off');
          }
        },
        onGet: () => {
          return this.deviceData.statusled_brightness !== 1;
        },
      });
    }

    if (this.deviceData?.has_irled === true) {
      this.addHKCharacteristic(this.operatingModeService, this.hap.Characteristic.NightVision, {
        onSet: (value) => {
          // only change IRLed status value if different than on-device
          if ((value === false && this.deviceData.irled_enabled === true) || (value === true && this.deviceData.irled_enabled === false)) {
            this.set({ uuid: this.deviceData.nest_google_uuid, irled_enabled: value === true ? 'auto_on' : 'always_off' });

            this?.log?.info?.('Night vision on "%s" was turned', this.deviceData.description, value === true ? 'on' : 'off');
          }
        },
        onGet: () => {
          return this.deviceData.irled_enabled;
        },
      });
    }

    this.addHKCharacteristic(this.operatingModeService, this.hap.Characteristic.ManuallyDisabled, {
      onSet: (value) => {
        if (value !== this.operatingModeService.getCharacteristic(this.hap.Characteristic.ManuallyDisabled).value) {
          // Make sure only updating status if HomeKit value *actually changes*
          if (
            (this.deviceData.streaming_enabled === false && value === false) ||
            (this.deviceData.streaming_enabled === true && value === true)
          ) {
            // Camera state does not reflect requested state, so fix
            this.set({ uuid: this.deviceData.nest_google_uuid, streaming_enabled: value === false ? true : false });
            this?.log?.info?.('Camera on "%s" was turned', this.deviceData.description, value === false ? 'on' : 'off');
          }
        }
      },
      onGet: () => {
        return this.deviceData.streaming_enabled === false
          ? this.hap.Characteristic.ManuallyDisabled.DISABLED
          : this.hap.Characteristic.ManuallyDisabled.ENABLED;
      },
    });

    if (this.deviceData?.has_video_flip === true) {
      this.addHKCharacteristic(this.operatingModeService, this.hap.Characteristic.ImageRotation, {
        onGet: () => {
          return this.deviceData.video_flipped === true ? 180 : 0;
        },
      });
    }

    if (this.controller?.recordingManagement?.recordingManagementService !== undefined && this.deviceData.has_microphone === true) {
      this.addHKCharacteristic(
        this.controller.recordingManagement.recordingManagementService,
        this.hap.Characteristic.RecordingAudioActive,
        {
          onSet: (value) => {
            if (
              (this.deviceData.audio_enabled === true && value === this.hap.Characteristic.RecordingAudioActive.DISABLE) ||
              (this.deviceData.audio_enabled === false && value === this.hap.Characteristic.RecordingAudioActive.ENABLE)
            ) {
              this.set({
                uuid: this.deviceData.nest_google_uuid,
                audio_enabled: value === this.hap.Characteristic.RecordingAudioActive.ENABLE ? true : false,
              });
              this?.log?.info?.(
                'Audio recording on "%s" was turned',
                this.deviceData.description,
                value === this.hap.Characteristic.RecordingAudioActive.ENABLE ? 'on' : 'off',
              );
            }
          },
          onGet: () => {
            return this.deviceData.audio_enabled === true
              ? this.hap.Characteristic.RecordingAudioActive.ENABLE
              : this.hap.Characteristic.RecordingAudioActive.DISABLE;
          },
        },
      );
    }

    if (this.deviceData.migrating === true) {
      // Migration happening between Nest <-> Google Home apps
      this?.log?.warn?.('Migration between Nest <-> Google Home apps is underway for "%s"', this.deviceData.description);
    }

    if (
      (this.deviceData.streaming_protocols.includes(STREAMING_PROTOCOL.WEBRTC) === false &&
        this.deviceData.streaming_protocols.includes(STREAMING_PROTOCOL.NEXUSTALK) === false) ||
      (this.deviceData.streaming_protocols.includes(STREAMING_PROTOCOL.WEBRTC) === true && WebRTC === undefined) ||
      (this.deviceData.streaming_protocols.includes(STREAMING_PROTOCOL.NEXUSTALK) === true && NexusTalk === undefined)
    ) {
      this?.log?.error?.(
        'No suitable streaming protocol is present for "%s". Streaming and recording will be unavailable',
        this.deviceData.description,
      );
    }

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

    // Extra setup details for output
    this.deviceData.hksv === true &&
      this.postSetupDetail('HomeKit Secure Video support' + (this.streamer?.isBuffering() === true ? ' and recording buffer started' : ''));
    this.deviceData.localAccess === true && this.postSetupDetail('Local access');
  }

  onUpdate() {
    // Clean up our camera object since this device is being removed
    clearTimeout(this.motionTimer);
    clearTimeout(this.personTimer);
    clearTimeout(this.snapshotTimer);
    this.motionTimer = undefined;
    this.personTimer = undefined;
    this.snapshotTimer = undefined;

    this.streamer !== undefined && this.streamer.stopEverything();

    // Stop any on-going HomeKit sessions, either live or recording
    // We'll terminate any ffmpeg, rtpSpliter etc processes
    this.#hkSessions.forEach((session) => {
      if (typeof session.rtpSplitter?.close === 'function') {
        session.rtpSplitter.close();
      }
      session.ffmpeg.forEach((ffmpeg) => {
        ffmpeg.kill('SIGKILL');
      });
      if (session?.eventEmitter instanceof EventEmitter === true) {
        session.eventEmitter.removeAllListeners(MP4BOX);
      }
    });

    // Remove any motion services we created
    Object.values(this.motionServices).forEach((service) => {
      service.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);
      this.accessory.removeService(service);
    });

    // Remove the camera controller
    this.accessory.removeController(this.controller);

    this.operatingModeService = undefined;
    this.#hkSessions = undefined;
    this.motionServices = undefined;
    this.streamer = undefined;
    this.controller = undefined;
  }

  // Taken and adapted from:
  // https://github.com/hjdhjd/homebridge-unifi-protect/blob/eee6a4e379272b659baa6c19986d51f5bf2cbbbc/src/protect-ffmpeg-record.ts
  async *handleRecordingStreamRequest(sessionID) {
    if (this.deviceData?.ffmpeg?.binary === undefined) {
      this?.log?.warn?.(
        'Received request to start recording for "%s" however we do not have an ffmpeg binary present',
        this.deviceData.description,
      );
      return;
    }

    if (
      this.motionServices?.[1]?.service !== undefined &&
      this.motionServices[1].service.getCharacteristic(this.hap.Characteristic.MotionDetected).value === false
    ) {
      // Should only be recording if motion detected.
      // Sometimes when starting up, HAP-nodeJS or HomeKit triggers this even when motion isn't occuring
      this?.log?.debug?.('Received request to commence recording for "%s" however we have not detected any motion');
      return;
    }

    if (this.streamer === undefined) {
      this?.log?.error?.(
        'Received request to start recording for "%s" however we do not any associated streaming protocol support',
        this.deviceData.description,
      );
      return;
    }

    // Build our ffmpeg command string for the liveview video/audio stream
    let commandLine = [
      '-hide_banner',
      '-nostats',
      '-use_wallclock_as_timestamps 1',
      '-fflags +discardcorrupt',
      '-max_delay 500000',
      '-flags low_delay',
      '-f h264',
      '-i pipe:0',
    ];

    let includeAudio = false;
    if (
      this.deviceData.audio_enabled === true &&
      this.controller.recordingManagement.recordingManagementService.getCharacteristic(this.hap.Characteristic.RecordingAudioActive)
        .value === this.hap.Characteristic.RecordingAudioActive.ENABLE &&
      this.streamer?.codecs?.audio === 'aac' &&
      this.deviceData?.ffmpeg?.libfdk_aac === true
    ) {
      // Audio data only on extra pipe created in spawn command
      commandLine.push('-f aac -i pipe:3');
      includeAudio = true;
    }

    if (
      this.deviceData.audio_enabled === true &&
      this.controller.recordingManagement.recordingManagementService.getCharacteristic(this.hap.Characteristic.RecordingAudioActive)
        .value === this.hap.Characteristic.RecordingAudioActive.ENABLE &&
      this.streamer?.codecs?.audio === 'opus' &&
      this.deviceData?.ffmpeg?.libopus === true
    ) {
      // Audio data only on extra pipe created in spawn command
      commandLine.push('-i pipe:3');
      includeAudio = true;
    }

    // Build our video command for ffmpeg
    commandLine.push(
      '-map 0:v:0',
      '-codec:v libx264',
      '-preset veryfast',
      '-profile:v ' +
        (this.#recordingConfig.videoCodec.parameters.profile === this.hap.H264Profile.HIGH
          ? 'high'
          : this.#recordingConfig.videoCodec.parameters.profile === this.hap.H264Profile.MAIN
            ? 'main'
            : 'baseline'),
      '-level:v ' +
        (this.#recordingConfig.videoCodec.parameters.level === this.hap.H264Level.LEVEL4_0
          ? '4.0'
          : this.#recordingConfig.videoCodec.parameters.level === this.hap.H264Level.LEVEL3_2
            ? '3.2'
            : '3.1'),
      '-noautoscale',
      '-bf 0',
      '-filter:v fps=fps=' + this.#recordingConfig.videoCodec.resolution[2],
      '-g:v ' + (this.#recordingConfig.videoCodec.resolution[2] * this.#recordingConfig.videoCodec.parameters.iFrameInterval) / 1000,
      '-b:v ' + this.#recordingConfig.videoCodec.parameters.bitRate + 'k',
      '-bufsize ' + 2 * this.#recordingConfig.videoCodec.parameters.bitRate + 'k',
      '-fps_mode passthrough',
      '-reset_timestamps 1',
      '-video_track_timescale 90000',
      '-movflags frag_keyframe+empty_moov+default_base_moof',
    );

    // We have seperate video and audio streams that need to be muxed together if audio enabled
    if (includeAudio === true) {
      let audioSampleRates = ['8', '16', '24', '32', '44.1', '48'];

      commandLine.push(
        '-map 1:a:0',
        '-codec:a libfdk_aac',
        '-profile:a aac_low',
        '-ar ' + audioSampleRates[this.#recordingConfig.audioCodec.samplerate] + 'k',
        '-b:a ' + this.#recordingConfig.audioCodec.bitrate + 'k',
        '-ac ' + this.#recordingConfig.audioCodec.audioChannels,
      );
    }

    commandLine.push('-f mp4 pipe:1'); // output to stdout in mp4

    // Start our ffmpeg recording process and stream from our streamer
    // video is pipe #1
    // audio is pipe #3 if including audio
    this?.log?.debug?.(
      'ffmpeg process for recording stream from "%s" will be called using the following commandline',
      this.deviceData.description,
      commandLine.join(' ').toString(),
    );
    let ffmpegRecording = child_process.spawn(this.deviceData.ffmpeg.binary, commandLine.join(' ').split(' '), {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    });

    // Process FFmpeg output and parse out the fMP4 stream it's generating for HomeKit Secure Video.
    let mp4FragmentData = [];
    let mp4boxes = [];
    let eventEmitter = new EventEmitter();

    ffmpegRecording.stdout.on('data', (data) => {
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
        if (Array.isArray(mp4boxes) === true && eventEmitter !== undefined) {
          mp4boxes.push({
            header: mp4FragmentData.slice(0, 8),
            type: mp4FragmentData.slice(4, 8).toString(),
            data: mp4FragmentData.slice(8, boxSize),
          });
          eventEmitter.emit(MP4BOX);
        }

        // Remove the section of data we've just processed from our buffer
        mp4FragmentData = mp4FragmentData.slice(boxSize);
      }
    });

    ffmpegRecording.on('exit', (code, signal) => {
      if (signal !== 'SIGKILL' || signal === null) {
        this?.log?.error?.('ffmpeg recording process for "%s" stopped unexpectedly. Exit code was "%s"', this.deviceData.description, code);
      }

      if (this.#hkSessions?.[sessionID] !== undefined) {
        delete this.#hkSessions[sessionID];
      }
    });

    // eslint-disable-next-line no-unused-vars
    ffmpegRecording.on('error', (error) => {
      // Empty
    });

    // ffmpeg console output is via stderr
    ffmpegRecording.stderr.on('data', (data) => {
      if (data.toString().includes('frame=') === false && this.deviceData?.ffmpeg?.debug === true) {
        // Monitor ffmpeg output
        this?.log?.debug?.(data.toString());
      }
    });

    // Start the appropriate streamer
    this.streamer !== undefined &&
      this.streamer.startRecordStream(sessionID, ffmpegRecording.stdin, ffmpegRecording?.stdio?.[3] ? ffmpegRecording.stdio[3] : null);

    // Store our ffmpeg sessions
    this.#hkSessions[sessionID] = {};
    this.#hkSessions[sessionID].eventEmitter = eventEmitter;
    this.#hkSessions[sessionID].ffmpeg = ffmpegRecording; // Store ffmpeg process ID

    this?.log?.info?.('Started recording from "%s" %s', this.deviceData.description, includeAudio === false ? 'without audio' : '');

    // Loop generating MOOF/MDAT box pairs for HomeKit Secure Video.
    // HAP-NodeJS cancels this async generator function when recording completes also
    let segment = [];
    for (;;) {
      if (this.#hkSessions?.[sessionID] === undefined || this.#hkSessions?.[sessionID]?.ffmpeg === undefined) {
        // Our session object is not present
        // ffmpeg recorder process is not present
        // so finish up the loop
        break;
      }

      if (mp4boxes?.length === 0 && eventEmitter !== undefined) {
        // since the ffmpeg recorder process hasn't notified us of any mp4 fragment boxes, wait until there are some
        await EventEmitter.once(eventEmitter, MP4BOX);
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

  closeRecordingStream(sessionID, closeReason) {
    // Stop the associated recording stream
    this.streamer !== undefined && this.streamer.stopRecordStream(sessionID);

    if (typeof this.#hkSessions?.[sessionID] === 'object') {
      if (this.#hkSessions[sessionID]?.ffmpeg !== undefined) {
        // Kill the ffmpeg recorder process
        this.#hkSessions[sessionID].ffmpeg.kill('SIGKILL');
      }
      if (this.#hkSessions[sessionID]?.eventEmitter !== undefined) {
        this.#hkSessions[sessionID].eventEmitter.emit(MP4BOX); // This will ensure we cleanly exit out from our segment generator
        this.#hkSessions[sessionID].eventEmitter.removeAllListeners(MP4BOX); // Tidy up our event listeners
      }
      delete this.#hkSessions[sessionID];
    }

    // Log recording finished messages depending on reason
    if (closeReason === this.hap.HDSProtocolSpecificErrorReason.NORMAL) {
      this?.log?.info?.('Completed recording from "%s"', this.deviceData.description);
    } else {
      this?.log?.warn?.(
        'Recording from "%s" completed with error. Reason was "%s"',
        this.deviceData.description,
        this.hap.HDSProtocolSpecificErrorReason[closeReason],
      );
    }
  }

  updateRecordingActive(enableRecording) {
    if (enableRecording === true && this.streamer?.isBuffering() === false) {
      // Start a buffering stream for this camera/doorbell. Ensures motion captures all video on motion trigger
      // Required due to data delays by on prem Nest to cloud to HomeKit accessory to iCloud etc
      // Make sure have appropriate bandwidth!!!
      this?.log?.info?.('Recording was turned on for "%s"', this.deviceData.description);
      this.streamer.startBuffering();
    }

    if (enableRecording === false && this.streamer?.isBuffering() === true) {
      this.streamer.stopBuffering();
      this?.log?.warn?.('Recording was turned off for "%s"', this.deviceData.description);
    }
  }

  updateRecordingConfiguration(recordingConfig) {
    this.#recordingConfig = recordingConfig; // Store the recording configuration HKSV has provided
  }

  async handleSnapshotRequest(snapshotRequestDetails, callback) {
    // snapshotRequestDetails.reason === ResourceRequestReason.PERIODIC
    // snapshotRequestDetails.reason === ResourceRequestReason.EVENT

    // Get current image from camera/doorbell
    let imageBuffer = undefined;

    if (this.deviceData.migrating === false && this.deviceData.streaming_enabled === true && this.deviceData.online === true) {
      let response = await this.get({ uuid: this.deviceData.nest_google_uuid, camera_snapshot: '' });
      if (Buffer.isBuffer(response?.camera_snapshot) === true) {
        imageBuffer = response.camera_snapshot;
        this.lastSnapshotImage = response.camera_snapshot;

        // Keep this snapshot image cached for a certain period
        clearTimeout(this.snapshotTimer);
        this.snapshotTimer = setTimeout(() => {
          this.lastSnapshotImage = undefined;
        }, SNAPSHOT_CACHE_TIMEOUT);
      }
    }

    if (
      this.deviceData.migrating === false &&
      this.deviceData.streaming_enabled === false &&
      this.deviceData.online === true &&
      this.#cameraVideoOffImage !== undefined
    ) {
      // Return 'camera switched off' jpg to image buffer
      imageBuffer = this.#cameraVideoOffImage;
    }

    if (this.deviceData.migrating === false && this.deviceData.online === false && this.#cameraOfflineImage !== undefined) {
      // Return 'camera offline' jpg to image buffer
      imageBuffer = this.#cameraOfflineImage;
    }

    if (this.deviceData.migrating === true && this.#cameraTransferringImage !== undefined) {
      // Return 'camera transferring' jpg to image buffer
      imageBuffer = this.#cameraTransferringImage;
    }

    if (imageBuffer === undefined) {
      // If we get here, we have no snapshot image
      // We'll use the last success snapshop as long as its within a certain time period
      imageBuffer = this.lastSnapshotImage;
    }

    callback(imageBuffer?.length === 0 ? 'Unable to obtain Camera/Doorbell snapshot' : null, imageBuffer);
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

    // Dropped ip module by using small snippet of code below
    // Converts ipv4 mapped into ipv6 address into pure ipv4
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
    this.#hkSessions[request.sessionID] = sessionInfo; // Store the session information
    callback(undefined, response);
  }

  async handleStreamRequest(request, callback) {
    // called when HomeKit asks to start/stop/reconfigure a camera/doorbell live stream
    if (request.type === this.hap.StreamRequestTypes.START && this.streamer === undefined) {
      // We have no streamer object configured, so cannot do live streams!!
      this?.log?.error?.(
        'Received request to start live video for "%s" however we do not any associated streaming protocol support',
        this.deviceData.description,
      );
    }

    if (request.type === this.hap.StreamRequestTypes.START && this.deviceData?.ffmpeg?.binary === undefined) {
      // No ffmpeg binary present, so cannot do live streams!!
      this?.log?.warn?.(
        'Received request to start live video for "%s" however we do not have an ffmpeg binary present',
        this.deviceData.description,
      );
    }

    if (
      request.type === this.hap.StreamRequestTypes.START &&
      this.streamer !== undefined &&
      this.deviceData?.ffmpeg?.binary !== undefined
    ) {
      // Build our ffmpeg command string for the liveview video/audio stream
      let commandLine = [
        '-hide_banner',
        '-nostats',
        '-use_wallclock_as_timestamps 1',
        '-fflags +discardcorrupt',
        '-max_delay 500000',
        '-flags low_delay',
        '-f h264',
        '-i pipe:0',
      ];

      let includeAudio = false;
      if (
        this.deviceData.audio_enabled === true &&
        this.streamer?.codecs?.audio === 'aac' &&
        this.deviceData?.ffmpeg?.libfdk_aac === true
      ) {
        // Audio data only on extra pipe created in spawn command
        commandLine.push('-f aac -i pipe:3');
        includeAudio = true;
      }

      if (this.deviceData.audio_enabled === true && this.streamer?.codecs?.audio === 'opus' && this.deviceData?.ffmpeg?.libopus === true) {
        // Audio data only on extra pipe created in spawn command
        commandLine.push('-i pipe:3');
        includeAudio = true;
      }

      // Build our video command for ffmpeg
      commandLine.push(
        '-map 0:v:0',
        '-codec:v copy',
        '-fps_mode passthrough',
        '-reset_timestamps 1',
        '-video_track_timescale 90000',
        '-payload_type ' + request.video.pt,
        '-ssrc ' + this.#hkSessions[request.sessionID].videoSSRC,
        '-f rtp',
        '-srtp_out_suite ' + this.hap.SRTPCryptoSuites[this.#hkSessions[request.sessionID].videoCryptoSuite],
        '-srtp_out_params ' +
          this.#hkSessions[request.sessionID].videoSRTP.toString('base64') +
          ' srtp://' +
          this.#hkSessions[request.sessionID].address +
          ':' +
          this.#hkSessions[request.sessionID].videoPort +
          '?rtcpport=' +
          this.#hkSessions[request.sessionID].videoPort +
          '&pkt_size=' +
          request.video.mtu,
      );

      // We have seperate video and audio streams that need to be muxed together if audio enabled
      if (includeAudio === true) {
        if (request.audio.codec === this.hap.AudioStreamingCodecType.AAC_ELD) {
          commandLine.push('-map 1:a:0', '-codec:a libfdk_aac', '-profile:a aac_eld');
        }

        if (request.audio.codec === this.hap.AudioStreamingCodecType.OPUS) {
          commandLine.push(
            '-map 1:a:0',
            '-codec:a libopus',
            '-application lowdelay',
            '-frame_duration ' + request.audio.packet_time.toString(),
          );
        }

        commandLine.push(
          '-flags +global_header',
          '-ar ' + request.audio.sample_rate + 'k',
          '-b:a ' + request.audio.max_bit_rate + 'k',
          '-ac ' + request.audio.channel,
          '-payload_type ' + request.audio.pt,
          '-ssrc ' + this.#hkSessions[request.sessionID].audioSSRC,
          '-f rtp',
          '-srtp_out_suite ' + this.hap.SRTPCryptoSuites[this.#hkSessions[request.sessionID].audioCryptoSuite],
          '-srtp_out_params ' +
            this.#hkSessions[request.sessionID].audioSRTP.toString('base64') +
            ' srtp://' +
            this.#hkSessions[request.sessionID].address +
            ':' +
            this.#hkSessions[request.sessionID].audioPort +
            '?rtcpport=' +
            this.#hkSessions[request.sessionID].audioPort +
            '&localrtcpport=' +
            this.#hkSessions[request.sessionID].localAudioPort +
            '&pkt_size=188',
        );
      }

      // Start our ffmpeg streaming process and stream from our streamer
      // video is pipe #1
      // audio is pipe #3 if including audio
      this?.log?.debug?.(
        'ffmpeg process for live streaming from "%s" will be called using the following commandline',
        this.deviceData.description,
        commandLine.join(' ').toString(),
      );
      let ffmpegStreaming = child_process.spawn(this.deviceData.ffmpeg.binary, commandLine.join(' ').split(' '), {
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      });

      ffmpegStreaming.on('exit', (code, signal) => {
        if (signal !== 'SIGKILL' || signal === null) {
          this?.log?.error?.(
            'ffmpeg video/audio live streaming process for "%s" stopped unexpectedly. Exit code was "%s"',
            this.deviceData.description,
            code,
          );

          // Clean up or streaming request, but calling it again with a 'STOP' reques
          this.handleStreamRequest({ type: this.hap.StreamRequestTypes.STOP, sessionID: request.sessionID }, null);
        }
      });

      // ffmpeg console output is via stderr
      ffmpegStreaming.stderr.on('data', (data) => {
        if (data.toString().includes('frame=') === false && this.deviceData?.ffmpeg?.debug === true) {
          // Monitor ffmpeg output
          this?.log?.debug?.(data.toString());
        }
      });

      // eslint-disable-next-line no-unused-vars
      ffmpegStreaming.on('error', (error) => {
        // Empty
      });

      // We only enable two/way audio on camera/doorbell if we have the required libraries in ffmpeg AND two-way/audio is enabled
      let ffmpegAudioTalkback = null; // No ffmpeg process for return audio yet
      if (
        ((this.streamer.codecs.talk === 'speex' && this.deviceData?.ffmpeg?.libspeex === true) ||
          (this.streamer.codecs.talk === 'opus' && this.deviceData?.ffmpeg?.libopus === true)) &&
        this.deviceData?.ffmpeg?.libfdk_aac === true &&
        this.deviceData.audio_enabled === true &&
        this.deviceData.has_speaker === true &&
        this.deviceData.has_microphone === true
      ) {
        // Setup RTP splitter for two/away audio
        this.#hkSessions[request.sessionID].rtpSplitter = dgram.createSocket('udp4');
        this.#hkSessions[request.sessionID].rtpSplitter.bind(this.#hkSessions[request.sessionID].rptSplitterPort);

        this.#hkSessions[request.sessionID].rtpSplitter.on('error', () => {
          this.#hkSessions[request.sessionID].rtpSplitter.close();
        });

        this.#hkSessions[request.sessionID].rtpSplitter.on('message', (message) => {
          let payloadType = message.readUInt8(1) & 0x7f;
          if (payloadType === request.audio.pt) {
            // Audio payload type from HomeKit should match our payload type for audio
            if (message.length > 50) {
              // Only send on audio data if we have a longer audio packet.
              // (not sure it makes any difference, as under iOS 15 packets are roughly same length)
              this.#hkSessions[request.sessionID].rtpSplitter.send(message, this.#hkSessions[request.sessionID].audioTalkbackPort);
            }
          } else {
            this.#hkSessions[request.sessionID].rtpSplitter.send(message, this.#hkSessions[request.sessionID].localAudioPort);
            // Send RTCP to return audio as a heartbeat
            this.#hkSessions[request.sessionID].rtpSplitter.send(message, this.#hkSessions[request.sessionID].audioTalkbackPort);
          }
        });

        // Build ffmpeg command
        let commandLine = [
          '-hide_banner -nostats',
          '-protocol_whitelist pipe,udp,rtp',
          '-f sdp',
          '-codec:a libfdk_aac',
          '-i pipe:0',
          '-map 0:a',
        ];

        if (this.streamer.codecs.talk === 'speex') {
          commandLine.push('-codec:a libspeex', '-frames_per_packet 4', '-vad 1', '-ac 1', '-ar 16k');
        }

        if (this.streamer.codecs.talk === 'opus') {
          commandLine.push('-codec:a libopus', '-application lowdelay', '-ac 2', '-ar 48k');
        }

        commandLine.push('-f data pipe:1');

        this?.log?.debug?.(
          'ffmpeg process for talkback on "%s" will be called using the following commandline',
          this.deviceData.description,
          commandLine.join(' ').toString(),
        );
        ffmpegAudioTalkback = child_process.spawn(this.deviceData.ffmpeg.binary, commandLine.join(' ').split(' '), {
          env: process.env,
        });

        ffmpegAudioTalkback.on('exit', (code, signal) => {
          if (signal !== 'SIGKILL' || signal === null) {
            this?.log?.error?.(
              'ffmpeg audio talkback streaming process for "%s" stopped unexpectedly. Exit code was "%s"',
              this.deviceData.description,
              code,
            );

            // Clean up or streaming request, but calling it again with a 'STOP' request
            this.handleStreamRequest({ type: this.hap.StreamRequestTypes.STOP, sessionID: request.sessionID }, null);
          }
        });

        // eslint-disable-next-line no-unused-vars
        ffmpegAudioTalkback.on('error', (error) => {
          // Empty
        });

        // ffmpeg console output is via stderr
        ffmpegAudioTalkback.stderr.on('data', (data) => {
          if (data.toString().includes('frame=') === false && this.deviceData?.ffmpeg?.debug === true) {
            // Monitor ffmpeg output
            this?.log?.debug?.(data.toString());
          }
        });

        // Write out SDP configuration
        // Tried to align the SDP configuration to what HomeKit has sent us in its audio request details
        let sdpResponse = [
          'v=0',
          'o=- 0 0 IN ' + (this.#hkSessions[request.sessionID].ipv6 ? 'IP6' : 'IP4') + ' ' + this.#hkSessions[request.sessionID].address,
          's=HomeKit Audio Talkback',
          'c=IN ' + (this.#hkSessions[request.sessionID].ipv6 ? 'IP6' : 'IP4') + ' ' + this.#hkSessions[request.sessionID].address,
          't=0 0',
          'm=audio ' + this.#hkSessions[request.sessionID].audioTalkbackPort + ' RTP/AVP ' + request.audio.pt,
          'b=AS:' + request.audio.max_bit_rate,
          'a=ptime:' + request.audio.packet_time,
        ];

        if (request.audio.codec === this.hap.AudioStreamingCodecType.AAC_ELD) {
          sdpResponse.push(
            'a=rtpmap:' + request.audio.pt + ' MPEG4-GENERIC/' + request.audio.sample_rate * 1000 + '/' + request.audio.channel,
            'a=fmtp:' +
              request.audio.pt +
              ' profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3;config=F8F0212C00BC00',
          );
        }

        if (request.audio.codec === this.hap.AudioStreamingCodecType.OPUS) {
          sdpResponse.push(
            'a=rtpmap:' + request.audio.pt + ' opus/' + request.audio.sample_rate * 1000 + '/' + request.audio.channel,
            'a=fmtp:' + request.audio.pt + ' minptime=10;useinbandfec=1"',
          );
        }

        sdpResponse.push(
          'a=crypto:1 ' +
            this.hap.SRTPCryptoSuites[this.#hkSessions[request.sessionID].audioCryptoSuite] +
            ' inline:' +
            this.#hkSessions[request.sessionID].audioSRTP.toString('base64'),
        );

        ffmpegAudioTalkback.stdin.write(sdpResponse.join('\r\n'));
        ffmpegAudioTalkback.stdin.end();
      }

      this?.log?.info?.(
        'Live stream started on "%s" %s',
        this.deviceData.description,
        ffmpegAudioTalkback?.stdout ? 'with two-way audio' : '',
      );

      // Start the appropriate streamer
      this.streamer !== undefined &&
        this.streamer.startLiveStream(
          request.sessionID,
          ffmpegStreaming.stdin,
          ffmpegStreaming?.stdio?.[3] ? ffmpegStreaming.stdio[3] : null,
          ffmpegAudioTalkback?.stdout ? ffmpegAudioTalkback.stdout : null,
        );

      // Store our ffmpeg sessions
      ffmpegStreaming && this.#hkSessions[request.sessionID].ffmpeg.push(ffmpegStreaming); // Store ffmpeg process ID
      ffmpegAudioTalkback && this.#hkSessions[request.sessionID].ffmpeg.push(ffmpegAudioTalkback); // Store ffmpeg audio return process ID
      this.#hkSessions[request.sessionID].video = request.video; // Cache the video request details
      this.#hkSessions[request.sessionID].audio = request.audio; // Cache the audio request details
    }

    if (request.type === this.hap.StreamRequestTypes.STOP && typeof this.#hkSessions[request.sessionID] === 'object') {
      this.streamer !== undefined && this.streamer.stopLiveStream(request.sessionID);

      // Close HomeKit session
      this.controller.forceStopStreamingSession(request.sessionID);

      // Close off any running ffmpeg and/or splitter processes we created
      if (typeof this.#hkSessions[request.sessionID]?.rtpSplitter?.close === 'function') {
        this.#hkSessions[request.sessionID].rtpSplitter.close();
      }
      this.#hkSessions[request.sessionID].ffmpeg.forEach((ffmpeg) => {
        ffmpeg.kill('SIGKILL');
      });

      delete this.#hkSessions[request.sessionID];

      this?.log?.info?.('Live stream stopped from "%s"', this.deviceData.description);
    }

    if (request.type === this.hap.StreamRequestTypes.RECONFIGURE && typeof this.#hkSessions[request.sessionID] === 'object') {
      this?.log?.debug?.('Unsupported reconfiguration request for live stream on "%s"', this.deviceData.description);
    }

    if (typeof callback === 'function') {
      callback(); // do callback if defined
    }
  }

  onUpdate(deviceData) {
    if (typeof deviceData !== 'object' || this.controller === undefined) {
      return;
    }

    if (this.deviceData.migrating === false && deviceData.migrating === true) {
      // Migration happening between Nest <-> Google Home apps. We'll stop any active streams, close the current streaming object
      this?.log?.warn?.('Migration between Nest <-> Google Home apps has started for "%s"', deviceData.description);
      this.streamer !== undefined && this.streamer.stopEverything();
      this.streamer = undefined;
    }

    if (this.deviceData.migrating === true && deviceData.migrating === false) {
      // Migration has completed between Nest <-> Google Home apps
      this?.log?.success?.('Migration between Nest <-> Google Home apps has completed for "%s"', deviceData.description);
    }

    // Handle case of changes in streaming protocols OR just finished migration between Nest <-> Google Home apps
    if (this.streamer === undefined && deviceData.migrating === false) {
      if (JSON.stringify(deviceData.streaming_protocols) !== JSON.stringify(this.deviceData.streaming_protocols)) {
        this?.log?.warn?.('Available streaming protocols have changed for "%s"', deviceData.description);
        this.streamer !== undefined && this.streamer.stopEverything();
        this.streamer = undefined;
      }
      if (deviceData.streaming_protocols.includes(STREAMING_PROTOCOL.WEBRTC) === true && WebRTC !== undefined) {
        this?.log?.debug?.('Using WebRTC streamer for "%s"', deviceData.description);
        this.streamer = new WebRTC(deviceData, {
          log: this.log,
          buffer:
            deviceData.hksv === true &&
            this?.controller?.recordingManagement?.recordingManagementService !== undefined &&
            this.controller.recordingManagement.recordingManagementService.getCharacteristic(this.hap.Characteristic.Active).value ===
              this.hap.Characteristic.Active.ACTIVE,
        });
      }

      if (deviceData.streaming_protocols.includes(STREAMING_PROTOCOL.NEXUSTALK) === true && NexusTalk !== undefined) {
        this?.log?.debug?.('Using NexusTalk streamer for "%s"', deviceData.description);
        this.streamer = new NexusTalk(deviceData, {
          log: this.log,
          buffer:
            deviceData.hksv === true &&
            this?.controller?.recordingManagement?.recordingManagementService !== undefined &&
            this.controller.recordingManagement.recordingManagementService.getCharacteristic(this.hap.Characteristic.Active).value ===
              this.hap.Characteristic.Active.ACTIVE,
        });
      }
    }

    // Check to see if any activity zones were added for both non-HKSV and HKSV enabled devices
    if (
      Array.isArray(deviceData.activity_zones) === true &&
      JSON.stringify(deviceData.activity_zones) !== JSON.stringify(this.deviceData.activity_zones)
    ) {
      deviceData.activity_zones.forEach((zone) => {
        if (this.deviceData.hksv === false || (this.deviceData.hksv === true && zone.id === 1)) {
          if (this.motionServices?.[zone.id]?.service === undefined) {
            // Zone doesn't have an associated motion sensor, so add one
            let zoneName = zone.id === 1 ? '' : zone.name;
            let tempService = this.addHKService(this.hap.Service.MotionSensor, zoneName, zone.id);

            this.addHKCharacteristic(tempService, this.hap.Characteristic.Active);
            tempService.updateCharacteristic(this.hap.Characteristic.Name, zoneName);
            tempService.updateCharacteristic(this.hap.Characteristic.MotionDetected, false); // No motion initially

            this.motionServices[zone.id] = { service: tempService, timer: undefined };
          }
        }
      });
    }

    // Check to see if any activity zones were removed for both non-HKSV and HKSV enabled devices
    // We'll also update the online status of the camera in the motion service here
    Object.entries(this.motionServices).forEach(([zoneID, service]) => {
      // Set online status
      service.service.updateCharacteristic(
        this.hap.Characteristic.Active,
        deviceData.online === true ? this.hap.Characteristic.Active.ACTIVE : this.hap.Characteristic.Active.INACTIVE,
      );

      // Handle deleted zones (excluding zone ID 1 for HKSV)
      if (
        zoneID !== '1' &&
        Array.isArray(deviceData.activity_zones) === true &&
        deviceData.activity_zones.findIndex(({ id }) => id === Number(zoneID)) === -1
      ) {
        // Motion service we created doesn't appear in zone list anymore, so assume deleted
        this.accessory.removeService(service.service);
        delete this.motionServices[zoneID];
      }
    });

    if (this.operatingModeService !== undefined) {
      // Update camera off/on status
      this.operatingModeService.updateCharacteristic(
        this.hap.Characteristic.ManuallyDisabled,
        deviceData.streaming_enabled === false
          ? this.hap.Characteristic.ManuallyDisabled.DISABLED
          : this.hap.Characteristic.ManuallyDisabled.ENABLED,
      );

      if (deviceData?.has_statusled === true) {
        // Set camera recording indicator. This cannot be turned off on Nest Cameras/Doorbells
        // 0 = auto
        // 1 = low
        // 2 = high
        this.operatingModeService.updateCharacteristic(
          this.hap.Characteristic.CameraOperatingModeIndicator,
          deviceData.statusled_brightness !== 1,
        );
      }

      if (deviceData?.has_irled === true) {
        // Set nightvision status in HomeKit
        this.operatingModeService.updateCharacteristic(this.hap.Characteristic.NightVision, deviceData.irled_enabled);
      }

      if (deviceData?.has_video_flip === true) {
        // Update image flip status
        this.operatingModeService.updateCharacteristic(this.hap.Characteristic.ImageRotation, deviceData.video_flipped === true ? 180 : 0);
      }
    }

    if (deviceData.hksv === true && this.controller?.recordingManagement?.recordingManagementService !== undefined) {
      // Update recording audio status
      this.controller.recordingManagement.recordingManagementService.updateCharacteristic(
        this.hap.Characteristic.RecordingAudioActive,
        deviceData.audio_enabled === true
          ? this.hap.Characteristic.RecordingAudioActive.ENABLE
          : this.hap.Characteristic.RecordingAudioActive.DISABLE,
      );
    }

    if (this.controller?.microphoneService !== undefined) {
      // Update microphone volume if specified
      //this.controller.microphoneService.updateCharacteristic(this.hap.Characteristic.Volume, deviceData.xxx);

      // if audio is disabled, we'll mute microphone
      this.controller.setMicrophoneMuted(deviceData.audio_enabled === false ? true : false);
    }
    if (this.controller?.speakerService !== undefined) {
      // Update speaker volume if specified
      //this.controller.speakerService.updateCharacteristic(this.hap.Characteristic.Volume, deviceData.xxx);

      // if audio is disabled, we'll mute speaker
      this.controller.setSpeakerMuted(deviceData.audio_enabled === false ? true : false);
    }

    // Notify our associated streamers about any data changes
    this.streamer !== undefined && this.streamer.update(deviceData);

    // Process alerts, the most recent alert is first
    // For HKSV, we're interested motion events
    // For non-HKSV, we're interested motion, face and person events (maybe sound and package later)
    deviceData.alerts.forEach((event) => {
      if (
        this.operatingModeService === undefined ||
        (this.operatingModeService !== undefined &&
          this.operatingModeService.getCharacteristic(this.hap.Characteristic.HomeKitCameraActive).value ===
            this.hap.Characteristic.HomeKitCameraActive.ON)
      ) {
        // We're configured to handle camera events
        // https://github.com/Supereg/secure-video-specification?tab=readme-ov-file#33-homekitcameraactive

        // Handle motion event
        // For a HKSV enabled camera, we will use this to trigger the starting of the HKSV recording if the camera is active
        if (event.types.includes('motion') === true) {
          if (this.motionTimer === undefined && (this.deviceData.hksv === false || this.streamer === undefined)) {
            this?.log?.info?.('Motion detected at "%s"', deviceData.description);
          }

          event.zone_ids.forEach((zoneID) => {
            if (
              typeof this.motionServices?.[zoneID]?.service === 'object' &&
              this.motionServices[zoneID].service.getCharacteristic(this.hap.Characteristic.MotionDetected).value !== true
            ) {
              // Trigger motion for matching zone of not aleady active
              this.motionServices[zoneID].service.updateCharacteristic(this.hap.Characteristic.MotionDetected, true);

              // Log motion started into history
              if (typeof this.historyService?.addHistory === 'function') {
                this.historyService.addHistory(this.motionServices[zoneID].service, {
                  time: Math.floor(Date.now() / 1000),
                  status: 1,
                });
              }
            }
          });

          // Clear any motion active timer so we can extend if more motion detected
          clearTimeout(this.motionTimer);
          this.motionTimer = setTimeout(() => {
            event.zone_ids.forEach((zoneID) => {
              if (typeof this.motionServices?.[zoneID]?.service === 'object') {
                // Mark associted motion services as motion not detected
                this.motionServices[zoneID].service.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);

                // Log motion started into history
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
            if (this.deviceData.hksv === false || this.streamer === undefined) {
              // We'll only log a person detected event if HKSV is disabled
              this?.log?.info?.('Person detected at "%s"', deviceData.description);
            }

            // Cooldown for person being detected
            // Start this before we process further
            this.personTimer = setTimeout(() => {
              this.personTimer = undefined; // No person timer active
            }, this.deviceData.personCooldown * 1000);

            if (event.types.includes('motion') === false) {
              // If person/face events doesn't include a motion event, add in here
              // This will handle all the motion triggering stuff
              event.types.push('motion');
            }
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
    this.accessory.services
      .filter((service) => service.UUID === this.hap.Service.MotionSensor.UUID)
      .forEach((service) => this.accessory.removeService(service));

    let zones = Array.isArray(this.deviceData.activity_zones) === true ? this.deviceData.activity_zones : [];

    if (this.deviceData.has_motion_detection === true && zones.length > 0) {
      // We have the capability of motion sensing on device, so setup motion sensor(s)
      // If we have HKSV video enabled, we'll only create a single motion sensor
      // A zone with the ID of 1 is treated as the main motion sensor
      for (let zone of zones) {
        if (this.deviceData.hksv === true && zone.id !== 1) {
          continue;
        }

        let zoneName = zone.id === 1 ? '' : zone.name;
        let service = this.addHKService(this.hap.Service.MotionSensor, zoneName, zone.id);
        this.addHKCharacteristic(service, this.hap.Characteristic.Active);
        service.updateCharacteristic(this.hap.Characteristic.Name, zoneName);
        service.updateCharacteristic(this.hap.Characteristic.MotionDetected, false); // No motion initially

        this.motionServices[zone.id] = { service, timer: undefined };
      }
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
            // <--- Need to auto generate this list
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
            profiles: [this.hap.H264Profile.MAIN],
            levels: [this.hap.H264Level.LEVEL3_1, this.hap.H264Level.LEVEL3_2, this.hap.H264Level.LEVEL4_0],
          },
        },
        audio: {
          twoWayAudio:
            this.deviceData?.ffmpeg?.libfdk_aac === true &&
            (this.deviceData?.ffmpeg?.libspeex === true || this.deviceData?.ffmpeg?.libopus === true) &&
            this.deviceData.has_speaker === true &&
            this.deviceData.has_microphone === true,
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
            resolutions: controllerOptions.streamingOptions.video.resolutions,
            parameters: {
              profiles: controllerOptions.streamingOptions.video.codec.profiles,
              levels: controllerOptions.streamingOptions.video.codec.levels,
            },
            type: controllerOptions.streamingOptions.video.codec.type,
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
