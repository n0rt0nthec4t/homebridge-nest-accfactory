// Nest Cameras
// Part of homebridge-nest-accfactory
//
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import EventEmitter from 'node:events';
import { Buffer } from 'node:buffer';
import { setTimeout, clearTimeout } from 'node:timers';
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';

// Define our modules
import HomeKitDevice from '../HomeKitDevice.js';
import Streamer from '../streamer.js';
import NexusTalk from '../nexustalk.js';
import WebRTC from '../webrtc.js';
import FFmpeg from '../ffmpeg.js';
import { processCommonData, parseDurationToSeconds, scaleValue } from '../utils.js';
import { buildMappedObject, createMappingContext } from '../translator.js';

// Define constants
import {
  DATA_SOURCE,
  PROTOBUF_RESOURCES,
  __dirname,
  RESOURCE_PATH,
  RESOURCE_IMAGES,
  DEVICE_TYPE,
  TIMERS,
  LOW_BATTERY_LEVEL,
  LOG_LEVELS,
} from '../consts.js';

const MP4BOX = 'mp4box';

const STREAMING_PROTOCOL = {
  WEBRTC: 'PROTOCOL_WEBRTC',
  NEXUSTALK: 'PROTOCOL_NEXUSTALK',
  MPEGDASH: 'PROTOCOL_MPEGDASH',
};

const STREAMERS = {
  [STREAMING_PROTOCOL.WEBRTC]: { module: WebRTC, label: 'WebRTC streamer' },
  [STREAMING_PROTOCOL.NEXUSTALK]: { module: NexusTalk, label: 'NexusTalk streamer' },
};

export default class NestCamera extends HomeKitDevice {
  static TYPE = 'Camera';
  static VERSION = '2026.03.12'; // Code version

  controller = undefined; // HomeKit Camera/Doorbell controller service
  streamer = undefined; // Streamer object for live/recording stream
  motionService = undefined; // Single motion sensor for camera(s)
  batteryService = undefined; // Service for Camera/doorbell with battery
  snapshotEvent = undefined; // Event for which to get snapshot for
  ffmpeg = undefined; // FFMpeg object class

  // Internal data only for this class
  #liveSessions = new Map(); // Track active HomeKit live stream sessions (port, crypto, rtpSplitter)
  #recordingConfig = {}; // HomeKit Secure Video recording configuration
  #cameraImages = {}; // Snapshot resource images
  #snapshotTimer = undefined; // Timer for cached snapshot images
  #lastSnapshotImage = undefined; // JPG image buffer for last camera snapshot
  #motionCooldownActive = false; // Flag to track if motion cooldown is active

  constructor(accessory, api, log, deviceData) {
    super(accessory, api, log, deviceData);

    // Load support image files as required
    const loadImageResource = (filename, label) => {
      let buffer = undefined;
      let file = path.resolve(__dirname, RESOURCE_PATH, filename);
      if (fs.existsSync(file) === true) {
        buffer = fs.readFileSync(file);
      } else {
        this.log?.warn?.('Failed to load %s image resource for "%s"', label, this.deviceData.description);
      }
      return buffer;
    };

    this.#cameraImages = {
      offline: loadImageResource(RESOURCE_IMAGES.CAMERA_OFFLINE, 'offline'),
      off: loadImageResource(RESOURCE_IMAGES.CAMERA_OFF, 'video off'),
      transfer: loadImageResource(RESOURCE_IMAGES.CAMERA_TRANSFER, 'transferring'),
    };

    // Create ffmpeg object if have been told valid binary
    if (typeof this.deviceData?.ffmpeg?.binary === 'string' && this.deviceData?.ffmpeg?.valid === true) {
      this.ffmpeg = new FFmpeg(this.deviceData?.ffmpeg?.binary, log);
    }
  }

  // Class functions
  onAdd() {
    // Setup the motion service if not already present on the accessory, and link it to the Eve app if configured to do so
    // This needs to be done before we setup the HomeKit camera controller
    this.motionService = this.addHKService(this.hap.Service.MotionSensor, '', 1, {});
    this.motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, false); // No motion initially

    // Setup HomeKit camera controller
    // Doorbell device, we'll setup a doorbell controller instead of a standard camera controller
    // Otherwise we'll setup as a standard camera controller
    if (this.deviceData.type === DEVICE_TYPE.DOORBELL) {
      this.controller = new this.hap.DoorbellController(this.generateControllerOptions());
    } else {
      this.controller = new this.hap.CameraController(this.generateControllerOptions());
    }

    if (this.controller !== undefined) {
      // Configure the controller that's been created
      this.accessory.configureController(this.controller);
    }

    // Setup battery service if required and not already present on the accessory
    if (this.deviceData.model.includes('battery') === true && isNaN(this.deviceData?.battery_level) === false) {
      this.batteryService = this.addHKService(this.hap.Service.Battery, '', 1);
      this.batteryService.setHiddenService(true);
    }

    // Setup set characteristics
    if (this.deviceData?.has_statusled === true) {
      this.addHKCharacteristic(
        this.controller.recordingManagement.operatingModeService,
        this.hap.Characteristic.CameraOperatingModeIndicator,
        {
          onSet: (value) => {
            // 0 = auto, 1 = low, 2 = high
            // We'll use auto mode for led on and low for led off
            if (
              (value === true && this.deviceData.statusled_brightness !== 0) ||
              (value === false && this.deviceData.statusled_brightness !== 1)
            ) {
              this.set({
                uuid: this.deviceData.nest_google_device_uuid,
                statusled_brightness: value === true ? 0 : 1,
              });
              this?.log?.info?.('Recording status LED on "%s" was turned %s', this.deviceData.description, value === true ? 'on' : 'off');
            }
          },
          onGet: () => {
            return this.deviceData.statusled_brightness !== 1;
          },
        },
      );
    }

    if (this.deviceData?.has_irled === true) {
      this.addHKCharacteristic(this.controller.recordingManagement.operatingModeService, this.hap.Characteristic.NightVision, {
        onSet: (value) => {
          // only change IRLed status value if different than on-device
          if ((value === false && this.deviceData.irled_enabled === true) || (value === true && this.deviceData.irled_enabled === false)) {
            this.set({
              uuid: this.deviceData.nest_google_device_uuid,
              irled_enabled: value === true ? 'auto_on' : 'always_off',
            });

            this?.log?.info?.('Night vision on "%s" was turned %s', this.deviceData.description, value === true ? 'on' : 'off');
          }
        },
        onGet: () => {
          return this.deviceData.irled_enabled;
        },
      });
    }

    this.addHKCharacteristic(this.controller.recordingManagement.operatingModeService, this.hap.Characteristic.HomeKitCameraActive, {
      onSet: (value) => {
        if (
          value !==
          this.controller.recordingManagement.operatingModeService.getCharacteristic(this.hap.Characteristic.HomeKitCameraActive).value
        ) {
          // Make sure only updating status if HomeKit value *actually changes*
          if (
            (this.deviceData.streaming_enabled === false && value === this.hap.Characteristic.HomeKitCameraActive.ON) ||
            (this.deviceData.streaming_enabled === true && value === this.hap.Characteristic.HomeKitCameraActive.OFF)
          ) {
            // Camera state does not reflect requested state, so fix
            this.set({
              uuid: this.deviceData.nest_google_device_uuid,
              streaming_enabled: value === this.hap.Characteristic.HomeKitCameraActive.ON ? true : false,
            });
            this?.log?.info?.(
              'Camera on "%s" was turned %s',
              this.deviceData.description,
              value === this.hap.Characteristic.HomeKitCameraActive.ON ? 'on' : 'off',
            );
          }
        }
      },
    });

    if (this.deviceData?.has_video_flip === true) {
      this.addHKCharacteristic(this.controller.recordingManagement.operatingModeService, this.hap.Characteristic.ImageRotation, {
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
                uuid: this.deviceData.nest_google_device_uuid,
                audio_enabled: value === this.hap.Characteristic.RecordingAudioActive.ENABLE ? true : false,
              });
              this?.log?.info?.(
                'Audio recording on "%s" was turned %s',
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

    this.deviceData?.streaming_protocols?.some?.((protocol) => STREAMERS[protocol]?.module !== undefined) !== true &&
      this?.log?.error?.(
        'No suitable streaming protocol is present for "%s". Streaming and recording will be unavailable',
        this.deviceData.description,
      );

    // Extra setup details for output
    this.deviceData?.streaming_protocols?.forEach?.((protocol) => {
      STREAMERS[protocol]?.module !== undefined && this.postSetupDetail(STREAMERS[protocol].label, LOG_LEVELS.DEBUG);
    });

    (this.deviceData?.has_motion_detection !== true || this.deviceData?.motion_detection_enabled !== true) &&
      this.postSetupDetail('Camera motion detection not available', LOG_LEVELS.WARN);

    this.postSetupDetail(
      'HomeKit Secure Video support' +
        (this.deviceData.model.includes('battery') === true && isNaN(this.deviceData?.battery_level) === false ? ' (on battery)' : ''),
    );
    this.deviceData.ffmpeg.hwaccel === true && this.postSetupDetail('Video hardware acceleration');

    // Setup repeat polling for camera events.
    // This is time-sensitive and we want to trigger HomeKit automations as close to real-time as possible
    this.addTimer(TIMERS.CAMERA_EVENTS.name, { interval: TIMERS.CAMERA_EVENTS.interval });
  }

  onRemove() {
    // Clean up our camera object since this device is being removed
    clearTimeout(this.#snapshotTimer);
    this.#snapshotTimer = undefined;

    // Stop all streamer logic (buffering, output, etc)
    this.streamer?.stopEverything?.();

    // Terminate any remaining ffmpeg sessions for this camera/doorbell
    this.ffmpeg?.killAllSessions?.(this.uuid);

    // Stop any on-going HomeKit sessions, either live or recording
    // We'll terminate any ffmpeg, rtpSplitter etc processes
    this.#liveSessions?.forEach?.((session) => {
      session?.rtpSplitter?.close?.();
    });

    // Remove any motion services we created
    if (this.motionService !== undefined) {
      this.motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);
      this.accessory.removeService(this.motionService);
    }

    // Remove the camera controller
    this.accessory.removeController(this.controller);

    // Clear references
    this.#liveSessions = undefined;
    this.motionService = undefined;
    this.streamer = undefined;
    this.controller = undefined;
  }

  async onUpdate(deviceData) {
    if (typeof deviceData !== 'object' || deviceData?.constructor !== Object || this.controller === undefined) {
      return;
    }

    // Update battery status
    if (this.batteryService !== undefined) {
      this.batteryService.updateCharacteristic(this.hap.Characteristic.BatteryLevel, deviceData.battery_level);
      this.batteryService.updateCharacteristic(
        this.hap.Characteristic.StatusLowBattery,
        deviceData.battery_level > LOW_BATTERY_LEVEL
          ? this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
          : this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW,
      );
      this.batteryService.updateCharacteristic(
        this.hap.Characteristic.ChargingState,
        (deviceData.battery_level > this.deviceData.battery_level && this.deviceData.battery_level !== 0 ? true : false)
          ? this.hap.Characteristic.ChargingState.CHARGING
          : this.hap.Characteristic.ChargingState.NOT_CHARGING,
      );
    }

    if (this.deviceData.migrating === false && deviceData.migrating === true) {
      // Migration happening between Nest <-> Google Home apps. We'll stop any active streams, close the current streaming object
      this?.log?.warn?.('Migration between Nest <-> Google Home apps has started for "%s"', deviceData.description);
      this.streamer?.stopEverything?.();
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
        this.streamer?.stopEverything?.();
        this.streamer = undefined;
      }
      if (deviceData.streaming_protocols.includes(STREAMING_PROTOCOL.WEBRTC) === true && WebRTC !== undefined) {
        if (this.deviceData.migrating === true && deviceData.migrating === false) {
          this?.log?.debug?.('Using WebRTC streamer for "%s" after migration', deviceData.description);
        }

        this.streamer = new WebRTC(this.uuid, deviceData, {
          log: this.log,
        });
      }

      if (deviceData.streaming_protocols.includes(STREAMING_PROTOCOL.NEXUSTALK) === true && NexusTalk !== undefined) {
        if (this.deviceData.migrating === true && deviceData.migrating === false) {
          this?.log?.debug?.('Using NexusTalk streamer for "%s" after migration', deviceData.description);
        }

        this.streamer = new NexusTalk(this.uuid, deviceData, {
          log: this.log,
        });
      }
      if (
        this?.streamer?.isBuffering() === false &&
        this?.controller?.recordingManagement?.recordingManagementService !== undefined &&
        this.controller.recordingManagement.recordingManagementService.getCharacteristic(this.hap.Characteristic.Active).value ===
          this.hap.Characteristic.Active.ACTIVE
      ) {
        await this.message(Streamer.MESSAGE, Streamer.MESSAGE_TYPE.START_BUFFER);
      }
    }

    // Handle motion detection on camera changes
    if (
      (deviceData.has_motion_detection === true && this.deviceData.has_motion_detection !== true) ||
      (deviceData.motion_detection_enabled === true && this.deviceData.motion_detection_enabled !== true)
    ) {
      this?.log?.info?.('Camera motion detection has been enabled on "%s"', deviceData.description);
    }

    if (
      (deviceData.has_motion_detection !== true && this.deviceData.has_motion_detection === true) ||
      (deviceData.motion_detection_enabled !== true && this.deviceData.motion_detection_enabled === true)
    ) {
      this?.log?.warn?.('Camera motion detection has been disabled on "%s"', deviceData.description);

      // Clear any existing motion status in HomeKit since detection is now disabled
      if (this.motionService !== undefined && this.motionService.getCharacteristic(this.hap.Characteristic.MotionDetected).value === true) {
        this.motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);
        this.#motionCooldownActive = false;
        this.removeTimer(TIMERS.MOTION_COOLDOWN.name);
        this.history(this.motionService, { status: 0 });
      }
    }

    // Handle online status changes for motion sensor
    if (this.motionService !== undefined) {
      this.motionService.updateCharacteristic(this.hap.Characteristic.StatusActive, deviceData.online === true);

      if (deviceData.online === false && this.motionService.getCharacteristic(this.hap.Characteristic.MotionDetected).value === true) {
        this.motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);
        this.#motionCooldownActive = false;
        this.removeTimer(TIMERS.MOTION_COOLDOWN.name);
        this.history(this.motionService, { status: 0 });
      }
    }

    if (this.controller?.recordingManagement?.operatingModeService !== undefined) {
      // Update camera off/on status
      this.controller.recordingManagement.operatingModeService.updateCharacteristic(
        this.hap.Characteristic.ManuallyDisabled,
        deviceData.streaming_enabled === true
          ? this.hap.Characteristic.ManuallyDisabled.ENABLED
          : this.hap.Characteristic.ManuallyDisabled.DISABLED,
      );

      if (deviceData?.has_statusled === true) {
        // Set camera recording indicator. This cannot be turned off on Nest Cameras/Doorbells
        // 0 = auto
        // 1 = low
        // 2 = high
        this.controller.recordingManagement.operatingModeService.updateCharacteristic(
          this.hap.Characteristic.CameraOperatingModeIndicator,
          deviceData.statusled_brightness !== 1,
        );
      }

      if (deviceData?.has_irled === true) {
        // Set nightvision status in HomeKit
        this.controller.recordingManagement.operatingModeService.updateCharacteristic(
          this.hap.Characteristic.NightVision,
          deviceData.irled_enabled === true,
        );
      }

      if (deviceData?.has_video_flip === true) {
        // Update image flip status
        this.controller.recordingManagement.operatingModeService.updateCharacteristic(
          this.hap.Characteristic.ImageRotation,
          deviceData.video_flipped === true ? 180 : 0,
        );
      }
    }

    if (this.controller?.recordingManagement?.recordingManagementService !== undefined) {
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

    // Process camera events, the most recent event is first
    deviceData.events.forEach((event) => {
      if (
        this.controller?.recordingManagement?.operatingModeService?.getCharacteristic?.(this.hap.Characteristic.HomeKitCameraActive)
          .value === this.hap.Characteristic.HomeKitCameraActive.ON
      ) {
        // We're configured to handle camera events
        // https://github.com/Supereg/secure-video-specification?tab=readme-ov-file#33-homekitcameraactive

        // Handle motion event
        // We will use this to trigger the starting of the HKSV recording if the camera is active
        if (event.types.includes('motion') === true) {
          // Only set motion to true on first detection
          if (this.#motionCooldownActive === false) {
            if (typeof this.motionService === 'object') {
              this?.log?.info?.('Motion detected at "%s"', deviceData.description);

              // Trigger motion
              this.motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, true);

              // Log motion started into history
              this.history(this.motionService, {
                status: 1,
              });
            }

            this.#motionCooldownActive = true;
          }

          // Start or extend motion cooldown timer (reset: true extends existing timer)
          this.addTimer(TIMERS.MOTION_COOLDOWN.name, {
            delay: this.deviceData.motionCooldown * 1000,
            reset: true,
          });
        }
      }
    });
  }

  onShutdown() {
    // Clear any motion
    if (this.motionService !== undefined) {
      this.motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);
    }

    // Stop all streamer logic (buffering, output, etc)
    this.streamer?.stopEverything?.();

    // Terminate any remaining ffmpeg sessions for this camera/doorbell
    this.ffmpeg?.killAllSessions?.(this.uuid);

    // Stop any on-going HomeKit sessions, either live or recording
    // We'll terminate any ffmpeg, rtpSplitter etc processes
    this.#liveSessions?.forEach?.((session) => {
      session?.rtpSplitter?.close?.();
    });
  }

  async onTimer(message) {
    if (typeof message !== 'object' || typeof message?.timer !== 'string') {
      return;
    }

    // Handle camera events polling timer
    if (message.timer === TIMERS.CAMERA_EVENTS.name) {
      let response = await this.get({ uuid: this.deviceData.nest_google_device_uuid, camera_events: true });
      // // Send updates (empty array if no events)
      this.update({
        events: Array.isArray(response?.camera_events) === true ? response.camera_events : [],
      });
    }

    // Handle motion cooldown timer expiration
    if (message.timer === TIMERS.MOTION_COOLDOWN.name) {
      // Motion cooldown expired
      if (typeof this.motionService === 'object') {
        // Mark motion service as motion not detected
        this.motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);

        // Log motion stopped into history
        this.history(this.motionService, { status: 0 });
      }
      this.#motionCooldownActive = false;
    }
  }

  // Taken and adapted from:
  // https://github.com/hjdhjd/homebridge-unifi-protect/blob/eee6a4e379272b659baa6c19986d51f5bf2cbbbc/src/protect-ffmpeg-record.ts
  async *handleRecordingStreamRequest(sessionID) {
    if (this.ffmpeg instanceof FFmpeg === false) {
      // No valid ffmpeg binary present, so cannot do recording!!
      this?.log?.warn?.(
        'Received request to start recording for "%s" however we do not have an ffmpeg binary present',
        this.deviceData.description,
      );
      return;
    }

    if (this.streamer === undefined) {
      this?.log?.error?.(
        'Received request to start recording for "%s" however we do not have any associated streaming protocol support',
        this.deviceData.description,
      );
      return;
    }

    if (this.motionService !== undefined && this.motionService.getCharacteristic(this.hap.Characteristic.MotionDetected).value === false) {
      // Should only be recording if motion detected.
      // Sometimes when starting up, HAP-nodeJS or HomeKit triggers this even when motion isn't occurring
      this?.log?.debug?.(
        'Received request to commence recording for "%s" however we have not detected any motion',
        this.deviceData.description,
      );
      return;
    }

    let includeAudio =
      this.deviceData.audio_enabled === true &&
      this.controller?.recordingManagement?.recordingManagementService?.getCharacteristic(this.hap.Characteristic.RecordingAudioActive)
        ?.value === this.hap.Characteristic.RecordingAudioActive.ENABLE;

    let commandLine = [
      '-hide_banner',
      '-nostats',
      '-fflags',
      '+discardcorrupt+genpts',
      '-avoid_negative_ts',
      'make_zero',
      '-max_delay',
      '500000',
      '-flags',
      'low_delay',

      // Video input
      '-f',
      'h264',
      '-i',
      'pipe:0',

      // Audio input (optional)
      ...(includeAudio === true
        ? this.streamer.codecs.audio === Streamer.CODEC_TYPE.PCM
          ? [
              '-thread_queue_size',
              '1024',
              '-f',
              's16le',
              '-ar',
              '48000',
              '-ac',
              '2',
              '-i',
              'pipe:3',
              '-af',
              'aresample=async=1:first_pts=0',
            ]
          : this.streamer.codecs.audio === Streamer.CODEC_TYPE.AAC
            ? ['-thread_queue_size', '1024', '-f', 'aac', '-i', 'pipe:3', '-af', 'aresample=async=1:first_pts=0']
            : []
        : []),

      // Video output including hardware acceleration if available
      '-map',
      '0:v:0',
      '-codec:v',
      this.deviceData?.ffmpeg?.hwaccel === true && this.ffmpeg?.hardwareH264Codec !== undefined ? this.ffmpeg.hardwareH264Codec : 'libx264',
      ...(this.deviceData?.ffmpeg?.hwaccel !== true || ['h264_nvenc', 'h264_qsv'].includes(this.ffmpeg?.hardwareH264Codec || '') === true
        ? [
            '-preset',
            'veryfast',
            '-profile:v',
            this.#recordingConfig.videoCodec.parameters.profile === this.hap.H264Profile.HIGH
              ? 'high'
              : this.#recordingConfig.videoCodec.parameters.profile === this.hap.H264Profile.MAIN
                ? 'main'
                : 'baseline',
            '-level:v',
            this.#recordingConfig.videoCodec.parameters.level === this.hap.H264Level.LEVEL4_0
              ? '4.0'
              : this.#recordingConfig.videoCodec.parameters.level === this.hap.H264Level.LEVEL3_2
                ? '3.2'
                : '3.1',
            '-bf',
            '0',
          ]
        : []),

      '-filter:v',
      'fps=fps=' + this.#recordingConfig.videoCodec.resolution[2] + ',format=yuv420p',
      '-fps_mode',
      'cfr',
      '-g:v',
      Math.round(
        (this.#recordingConfig.videoCodec.resolution[2] * this.#recordingConfig.videoCodec.parameters.iFrameInterval) / 1000,
      ).toString(),
      '-b:v',
      this.#recordingConfig.videoCodec.parameters.bitRate + 'k',
      '-bufsize',
      2 * this.#recordingConfig.videoCodec.parameters.bitRate + 'k',
      '-video_track_timescale',
      '90000',
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',

      // Audio output
      ...(includeAudio === true
        ? ['-map', '1:a:0', '-codec:a', 'libfdk_aac', '-profile:a', 'aac_low', '-ar', '16000', '-b:a', '16k', '-ac', '1']
        : []),

      '-f',
      'mp4',
      'pipe:1',
    ];

    // Start our ffmpeg recording process and stream from our streamer
    // video is pipe #1
    // audio is pipe #3 if including audio
    this?.log?.debug?.(
      'ffmpeg process for recording stream from "%s" will be called using the following commandline: %s',
      this.deviceData.description,
      commandLine.join(' '),
    );

    let ffmpegStream = this.ffmpeg.createSession(
      this.uuid,
      sessionID,
      commandLine,
      'record',
      this.deviceData.ffmpeg.debug === true
        ? (data) => {
            if (data.toString().includes('frame=') === false) {
              this?.log?.debug?.(data.toString());
            }
          }
        : undefined,
      4, // 4 pipes required
    );

    if (ffmpegStream === undefined) {
      return;
    }

    let buffer = Buffer.alloc(0);
    let mp4boxes = [];

    ffmpegStream?.stdout?.on?.('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 8) {
        let boxSize = buffer.readUInt32BE(0);
        if (boxSize < 8 || buffer.length < boxSize) {
          // We don't have enough data in the buffer yet to process the full mp4 box
          // so, exit loop and await more data
          break;
        }

        let boxType = buffer.subarray(4, 8).toString();

        // Add it to our queue to be pushed out through the generator function.
        mp4boxes.push({
          header: buffer.subarray(0, 8),
          type: boxType,
          data: buffer.subarray(8, boxSize),
        });

        buffer = buffer.subarray(boxSize);
        this.emit(MP4BOX);
      }
    });

    ffmpegStream?.on?.('exit', (code, signal) => {
      if (signal !== 'SIGKILL' && (signal !== null || code !== 0)) {
        this?.log?.error?.('ffmpeg recording process for "%s" stopped unexpectedly. Exit code was "%s"', this.deviceData.description, code);
      }

      // Ensure generator wakes up and exits
      this.emit(MP4BOX);
      this.removeAllListeners(MP4BOX);
    });

    // Start the appropriate streamer
    let { video, audio } = await this.message(Streamer.MESSAGE, Streamer.MESSAGE_TYPE.START_RECORD, {
      sessionID: sessionID,
      includeAudio: includeAudio === true,
    });

    // Connect the ffmpeg process to the streamer input/output
    video?.pipe?.(ffmpegStream?.stdin); // Streamer video -> ffmpeg stdin (pipe:0)
    audio?.pipe?.(ffmpegStream?.stdio?.[3]); // Streamer audio (if present) -> ffmpeg pipe:3

    this?.log?.info?.('Started recording from "%s" %s', this.deviceData.description, includeAudio === false ? 'without audio' : '');

    // Loop generating MOOF/MDAT box pairs for HomeKit Secure Video.
    // HAP-NodeJS cancels this async generator function when recording completes also
    let segment = [];
    for (;;) {
      if (this.ffmpeg?.hasSession?.(this.uuid, sessionID, 'record') === false) {
        break;
      }

      if (mp4boxes.length === 0) {
        await EventEmitter.once(this, MP4BOX);

        if (this.ffmpeg?.hasSession?.(this.uuid, sessionID, 'record') === false) {
          break;
        }

        if (mp4boxes.length === 0) {
          continue;
        }
      }

      let box = mp4boxes.shift();
      if (box === undefined) {
        continue;
      }

      segment.push(box.header, box.data);

      if (box.type === 'moov' || box.type === 'mdat') {
        yield { data: Buffer.concat(segment), isLast: false };
        segment = [];
      }
    }
  }

  async closeRecordingStream(sessionID, closeReason) {
    // Stop recording stream from the streamer
    await this.message(Streamer.MESSAGE, Streamer.MESSAGE_TYPE.STOP_RECORD, {
      sessionID: sessionID,
    });

    // Terminate the ffmpeg recording process
    this.ffmpeg?.killSession?.(this.uuid, sessionID, 'record', 'SIGKILL');

    // Wake and clear HomeKit Secure Video generator
    this.emit(MP4BOX);
    this.removeAllListeners(MP4BOX);

    // Log completion depending on reason
    if (closeReason === this.hap.HDSProtocolSpecificErrorReason.NORMAL) {
      this?.log?.info?.('Completed recording from "%s"', this.deviceData.description);
    } else {
      this?.log?.warn?.(
        'Recording from "%s" completed with error. Reason was "%s"',
        this.deviceData.description,
        this.hap.HDSProtocolSpecificErrorReason?.[closeReason] || 'code ' + closeReason,
      );
    }
  }

  async updateRecordingActive(enableRecording) {
    if (this.streamer === undefined) {
      return;
    }

    if (enableRecording === true && this.streamer.isBuffering() === false) {
      // Start a buffering stream for this camera/doorbell. Ensures motion captures all video on motion trigger
      // Required due to data delays by on prem Nest to cloud to HomeKit accessory to iCloud etc
      // Make sure have appropriate bandwidth!!!
      this?.log?.info?.('Recording was turned on for "%s"', this.deviceData.description);
      await this.message(Streamer.MESSAGE, Streamer.MESSAGE_TYPE.START_BUFFER);
    }

    if (enableRecording === false && this.streamer.isBuffering() === true) {
      // Stop buffering stream for this camera/doorbell
      await this.message(Streamer.MESSAGE, Streamer.MESSAGE_TYPE.STOP_BUFFER);
      this?.log?.warn?.('Recording was turned off for "%s"', this.deviceData.description);
    }
  }

  updateRecordingConfiguration(recordingConfig) {
    this.#recordingConfig = recordingConfig; // Store the recording configuration HKSV has provided
  }

  async handleSnapshotRequest(snapshotRequestDetails, callback) {
    // snapshotRequestDetails.reason === ResourceRequestReason.PERIODIC
    // snapshotRequestDetails.reason === ResourceRequestReason.EVENT

    // eslint-disable-next-line no-unused-vars
    const isLikelyBlackImage = (buffer) => {
      // TODO <- Placeholder for actual black image detection logic
      return false;
    };

    // Get current image from camera/doorbell
    let imageBuffer = undefined;

    if (this.deviceData.migrating === false && this.deviceData.streaming_enabled === true && this.deviceData.online === true) {
      // Call the camera/doorbell to get a snapshot image.
      // Prefer onGet() result if implemented; fallback to static handler
      let response = await this.get({ uuid: this.deviceData.nest_google_device_uuid, camera_snapshot: Buffer.alloc(0) });
      if (
        Buffer.isBuffer(response?.camera_snapshot) === true &&
        response.camera_snapshot.length > 0 &&
        isLikelyBlackImage(response.camera_snapshot) === false
      ) {
        imageBuffer = response.camera_snapshot;
        this.#lastSnapshotImage = response.camera_snapshot;

        // Keep this snapshot image cached for a certain period
        clearTimeout(this.#snapshotTimer);
        this.#snapshotTimer = setTimeout(() => {
          this.#lastSnapshotImage = undefined;
        }, TIMERS.SNAPSHOT.interval);
      }
    }

    if (
      this.deviceData.migrating === false &&
      this.deviceData.streaming_enabled === false &&
      this.deviceData.online === true &&
      this.#cameraImages?.off !== undefined
    ) {
      // Return 'camera switched off' jpg to image buffer
      imageBuffer = this.#cameraImages.off;
    }

    if (this.deviceData.migrating === false && this.deviceData.online === false && this.#cameraImages?.offline !== undefined) {
      // Return 'camera offline' jpg to image buffer
      imageBuffer = this.#cameraImages.offline;
    }

    if (this.deviceData.migrating === true && this.#cameraImages?.transfer !== undefined) {
      // Return 'camera transferring' jpg to image buffer
      imageBuffer = this.#cameraImages.transfer;
    }

    if (imageBuffer === undefined) {
      // If we get here, we have no snapshot image
      // We'll use the last successful snapshot as long as its within a certain time period
      imageBuffer = this.#lastSnapshotImage;
    }

    callback(imageBuffer?.length === 0 ? 'Unable to obtain Camera/Doorbell snapshot' : null, imageBuffer);
  }

  async prepareStream(request, callback) {
    // HomeKit has asked us to prepare ports and encryption details for video/audio streaming

    const getPort = async () => {
      return new Promise((resolve, reject) => {
        let server = dgram.createSocket('udp4');
        server.bind({ port: 0, exclusive: true }, () => {
          let port = server.address().port;
          server.close(() => resolve(port));
        });
        server.on('error', reject);
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
      rtpSplitterPort: await getPort(),
      audioCryptoSuite: request.video.srtpCryptoSuite,
      audioSRTP: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
      audioSSRC: this.hap.CameraController.generateSynchronisationSource(),

      rtpSplitter: null, // setup later during stream start
    };

    // Converts ipv4-mapped ipv6 into pure ipv4
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
        port: sessionInfo.rtpSplitterPort,
        ssrc: sessionInfo.audioSSRC,
        srtp_key: request.audio.srtp_key,
        srtp_salt: request.audio.srtp_salt,
      },
    };

    this.#liveSessions.set(request.sessionID, sessionInfo); // Store the session information
    callback(undefined, response);
  }

  async handleStreamRequest(request, callback) {
    // called when HomeKit asks to start/stop/reconfigure a camera/doorbell live stream

    if (request.type === this.hap.StreamRequestTypes.START) {
      if (this.streamer === undefined) {
        // We have no streamer object configured, so cannot do live streams!!
        this?.log?.error?.(
          'Received request to start live video for "%s" however we do not have any associated streaming protocol support',
          this.deviceData.description,
        );
        return callback?.();
      }

      if (this.ffmpeg instanceof FFmpeg === false) {
        // No valid ffmpeg binary present, so cannot do live streams!!
        this?.log?.warn?.(
          'Received request to start live video for "%s" however we do not have a valid ffmpeg binary',
          this.deviceData.description,
        );
        return callback?.();
      }

      let session = this.#liveSessions.get(request.sessionID);
      let includeAudio = this.deviceData.audio_enabled === true && this.streamer?.codecs?.audio !== undefined;

      // Build our ffmpeg command string for the liveview video/audio stream
      let commandLine = [
        '-hide_banner',
        '-nostats',
        '-use_wallclock_as_timestamps',
        '1',
        '-fflags',
        '+discardcorrupt',
        '-max_delay',
        '500000',
        '-flags',
        'low_delay',

        // Video input
        '-f',
        'h264',
        '-i',
        'pipe:0',

        // Audio input (if enabled)
        ...(includeAudio === true
          ? this.streamer.codecs.audio === Streamer.CODEC_TYPE.PCM
            ? ['-thread_queue_size', '512', '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:3']
            : this.streamer.codecs.audio === Streamer.CODEC_TYPE.AAC
              ? ['-thread_queue_size', '512', '-f', 'aac', '-i', 'pipe:3']
              : []
          : []),

        // Video output
        '-map',
        '0:v:0',
        '-codec:v',
        'copy',
        // Below is commented out as we don't use hardware acceleration for live streaming
        //       ...(this.deviceData.ffmpeg.hwaccel === true && this.ffmpeg.hardwareH264Codec !== undefined
        //         ? ['-codec:v', this.ffmpeg.hardwareH264Codec]
        //         : ['-codec:v', 'copy']),
        '-fps_mode',
        'passthrough',
        '-reset_timestamps',
        '1',
        '-video_track_timescale',
        '90000',
        '-payload_type',
        request.video.pt,
        '-ssrc',
        session.videoSSRC,
        '-f',
        'rtp',
        '-srtp_out_suite',
        this.hap.SRTPCryptoSuites[session.videoCryptoSuite],
        '-srtp_out_params',
        session.videoSRTP.toString('base64'),
        'srtp://' + session.address + ':' + session.videoPort + '?rtcpport=' + session.videoPort + '&pkt_size=' + request.video.mtu,

        // Audio output (if enabled)
        ...(includeAudio === true
          ? request.audio.codec === this.hap.AudioStreamingCodecType.AAC_ELD
            ? ['-map', '1:a:0', '-codec:a', 'libfdk_aac', '-profile:a', 'aac_eld']
            : request.audio.codec === this.hap.AudioStreamingCodecType.OPUS
              ? [
                  '-map',
                  '1:a:0',
                  '-codec:a',
                  'libopus',
                  '-application',
                  'lowdelay',
                  '-frame_duration',
                  request.audio.packet_time.toString(),
                ]
              : []
          : []),

        // Shared audio output params
        ...(includeAudio === true
          ? [
              '-flags',
              '+global_header',
              '-ar',
              request.audio.sample_rate.toString() + 'k',
              '-b:a',
              request.audio.max_bit_rate + 'k',
              '-ac',
              request.audio.channel.toString(),
              '-payload_type',
              request.audio.pt,
              '-ssrc',
              session.audioSSRC,
              '-f',
              'rtp',
              '-srtp_out_suite',
              this.hap.SRTPCryptoSuites[session.audioCryptoSuite],
              '-srtp_out_params',
              session.audioSRTP.toString('base64'),
              'srtp://' +
                session.address +
                ':' +
                session.audioPort +
                '?rtcpport=' +
                session.audioPort +
                '&localrtcpport=' +
                session.localAudioPort +
                '&pkt_size=188',
            ]
          : []),
      ];

      this?.log?.debug?.(
        'ffmpeg process for live streaming from "%s" will be called using the following commandline: %s',
        this.deviceData.description,
        commandLine.join(' '),
      );

      // Launch the ffmpeg process for streaming and connect it to streamer input/output
      let ffmpegStream = this.ffmpeg.createSession(
        this.uuid,
        request.sessionID,
        commandLine,
        'live',
        (data) => {
          if (data.toString().includes('frame=') === false && this.deviceData.ffmpeg.debug === true) {
            this?.log?.debug?.(data.toString());
          }
        },
        4, // 4 pipes required
      );

      ffmpegStream?.on?.('exit', async (code, signal) => {
        if (signal !== 'SIGKILL' && (signal !== null || code !== 0)) {
          this?.log?.error?.(
            'ffmpeg live streaming process for "%s" stopped unexpectedly. Exit code was "%s"',
            this.deviceData.description,
            code,
          );

          // Stop the streamer and notify HomeKit that the stream has failed
          try {
            await this.message(Streamer.MESSAGE, Streamer.MESSAGE_TYPE.STOP_LIVE, {
              sessionID: request.sessionID,
            });
          } catch {
            // Ignore errors if streamer already stopped
          }
          this.controller.forceStopStreamingSession(request.sessionID);
          this.#liveSessions.get(request.sessionID)?.rtpSplitter?.close?.();
          this.#liveSessions.delete(request.sessionID);
        }
      });

      // Two-way audio support if enabled and codecs available
      let ffmpegTalk = null;
      if (
        ((this.streamer?.codecs?.talkback === Streamer.CODEC_TYPE.SPEEX &&
          this.ffmpeg?.features?.encoders?.includes('libspeex') === true) ||
          (this.streamer?.codecs?.talkback === Streamer.CODEC_TYPE.OPUS &&
            this.ffmpeg?.features?.encoders?.includes('libopus') === true)) &&
        this.ffmpeg?.features?.encoders?.includes('libfdk_aac') === true &&
        this.deviceData.audio_enabled === true &&
        this.deviceData.has_speaker === true &&
        this.deviceData.has_microphone === true
      ) {
        // Setup RTP splitter for two-way audio
        session.rtpSplitter = dgram.createSocket('udp4');
        session.rtpSplitter.bind(session.rtpSplitterPort);
        session.rtpSplitter.on('error', () => session.rtpSplitter.close());
        session.rtpSplitter.on('message', (message) => {
          let pt = message.readUInt8(1) & 0x7f;
          if (pt === request.audio.pt && message.length > 50) {
            session.rtpSplitter.send(message, session.audioTalkbackPort);
          } else {
            session.rtpSplitter.send(message, session.localAudioPort);
            session.rtpSplitter.send(message, session.audioTalkbackPort); // RTCP keepalive
          }
        });

        let talkbackCommandLine = [
          '-hide_banner',
          '-nostats',
          '-protocol_whitelist',
          'pipe,udp,rtp',
          '-f',
          'sdp',
          '-codec:a',
          'libfdk_aac',
          '-i',
          'pipe:0',
          '-map',
          '0:a',
          ...(this.streamer?.codecs?.talkback === Streamer.CODEC_TYPE.SPEEX
            ? ['-codec:a', 'libspeex', '-frames_per_packet', '4', '-vad', '1', '-ac', '1', '-ar', '16k']
            : []),
          ...(this.streamer?.codecs?.talkback === Streamer.CODEC_TYPE.OPUS
            ? ['-codec:a', 'libopus', '-application', 'lowdelay', '-ac', '2', '-ar', '48k']
            : []),
          '-f',
          'data',
          'pipe:1',
        ];

        this?.log?.debug?.(
          'ffmpeg process for talkback on "%s" will be called using the following commandline: %s',
          this.deviceData.description,
          talkbackCommandLine.join(' '),
        );

        ffmpegTalk = this.ffmpeg.createSession(
          this.uuid,
          request.sessionID,
          talkbackCommandLine,
          'talk',
          (data) => {
            if (data.toString().includes('frame=') === false && this.deviceData.ffmpeg.debug === true) {
              this?.log?.debug?.(data.toString());
            }
          },
          3, // 3 pipes required
        );

        ffmpegTalk?.on?.('exit', async (code, signal) => {
          if (signal !== 'SIGKILL' && (signal !== null || code !== 0)) {
            this?.log?.error?.(
              'ffmpeg talkback process for "%s" stopped unexpectedly. Exit code was "%s"',
              this.deviceData.description,
              code,
            );

            // Stop the streamer and notify HomeKit that the stream has failed
            try {
              await this.message(Streamer.MESSAGE, Streamer.MESSAGE_TYPE.STOP_LIVE, {
                sessionID: request.sessionID,
              });
            } catch {
              // Ignore errors if streamer already stopped
            }
            this.controller.forceStopStreamingSession(request.sessionID);
            this.#liveSessions.get(request.sessionID)?.rtpSplitter?.close?.();
            this.#liveSessions.delete(request.sessionID);
          }
        });

        let sdp = [
          'v=0',
          'o=- 0 0 IN ' + (session.ipv6 ? 'IP6' : 'IP4') + ' ' + session.address,
          's=HomeKit Audio Talkback',
          'c=IN ' + (session.ipv6 ? 'IP6' : 'IP4') + ' ' + session.address,
          't=0 0',
          'm=audio ' + session.audioTalkbackPort + ' RTP/AVP ' + request.audio.pt,
          'b=AS:' + request.audio.max_bit_rate,
          'a=ptime:' + request.audio.packet_time,
        ];

        if (request.audio.codec === this.hap.AudioStreamingCodecType.AAC_ELD) {
          sdp.push(
            'a=rtpmap:' + request.audio.pt + ' MPEG4-GENERIC/' + request.audio.sample_rate * 1000 + '/' + request.audio.channel,
            'a=fmtp:' +
              request.audio.pt +
              ' profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3;config=F8F0212C00BC00',
          );
        }

        if (request.audio.codec === this.hap.AudioStreamingCodecType.OPUS) {
          sdp.push(
            'a=rtpmap:' + request.audio.pt + ' opus/' + request.audio.sample_rate * 1000 + '/' + request.audio.channel,
            'a=fmtp:' + request.audio.pt + ' minptime=10;useinbandfec=1',
          );
        }

        sdp.push('a=crypto:1 ' + this.hap.SRTPCryptoSuites[session.audioCryptoSuite] + ' inline:' + session.audioSRTP.toString('base64'));
        ffmpegTalk?.stdin?.write?.(sdp.join('\r\n'));
        ffmpegTalk?.stdin?.end?.();
      }

      // Start the actual streamer process
      this?.log?.info?.('Live stream started on "%s"%s', this.deviceData.description, ffmpegTalk ? ' (two-way audio enabled)' : '');
      let { video, audio, talkback } = await this.message(Streamer.MESSAGE, Streamer.MESSAGE_TYPE.START_LIVE, {
        sessionID: request.sessionID,
        includeAudio: includeAudio === true,
      });

      // Connect the ffmpeg process to the streamer input/output
      video?.pipe?.(ffmpegStream?.stdin); // Streamer video -> ffmpeg stdin (pipe:0)
      audio?.pipe?.(ffmpegStream?.stdio?.[3]); // Streamer audio (if present) -> ffmpeg pipe:3
      ffmpegTalk?.stdout?.pipe?.(talkback); // ffmpeg talkback stdout -> Streamer talkback pipe:1
    }

    if (request.type === this.hap.StreamRequestTypes.STOP && this.#liveSessions.has(request.sessionID)) {
      // Stop the HomeKit stream and cleanup any associated ffmpeg or RTP splitter sessions
      await this.message(Streamer.MESSAGE, Streamer.MESSAGE_TYPE.STOP_LIVE, {
        sessionID: request.sessionID,
      });
      this.controller.forceStopStreamingSession(request.sessionID);
      this.#liveSessions.get(request.sessionID)?.rtpSplitter?.close?.();
      this.ffmpeg?.killSession?.(this.uuid, request.sessionID, 'live', 'SIGKILL');
      this.ffmpeg?.killSession?.(this.uuid, request.sessionID, 'talk', 'SIGKILL');
      this.#liveSessions.delete(request.sessionID);
      this?.log?.info?.('Live stream stopped from "%s"', this.deviceData.description);
    }

    if (request.type === this.hap.StreamRequestTypes.RECONFIGURE && this.#liveSessions.has(request.sessionID)) {
      // HomeKit is requesting stream parameter adjustments
      // Like other camera implementations, we just ignore this and continue the stream with current parameters
      this?.log?.debug?.(
        'Reconfiguration request ignored for live stream on "%s" - continuing with current parameters',
        this.deviceData.description,
      );
    }

    callback?.(); // do callback if defined
  }

  generateControllerOptions() {
    // Setup HomeKit controller camera/doorbell options

    let resolutions = [
      [3840, 2160, 30], // 4K
      [2560, 1440, 30], // 2K (QHD)
      [1920, 1080, 30], // 1080p
      [1920, 1080, 15], // 1080p low bitrate
      [1600, 1200, 30], // Native res of Nest Hello
      [1280, 960, 30],
      [1280, 720, 30], // 720p
      [1024, 768, 30],
      [640, 480, 30],
      [640, 360, 30],
      [480, 360, 30],
      [480, 270, 30],
      [320, 240, 30],
      [320, 240, 15], // Apple Watch requires this (plus OPUS @16K)
      [320, 180, 30],
      [320, 180, 15],
    ];

    let profiles = [this.hap.H264Profile.BASELINE, this.hap.H264Profile.MAIN];
    let levels = [this.hap.H264Level.LEVEL3_1, this.hap.H264Level.LEVEL3_2, this.hap.H264Level.LEVEL4_0];
    let videoType = this.hap.VideoCodecType.H264;

    let controllerOptions = {
      cameraStreamCount: this.deviceData.maxStreams,
      delegate: this,
      streamingOptions:
        this.ffmpeg instanceof FFmpeg === true
          ? {
              supportedCryptoSuites: [this.hap.SRTPCryptoSuites.NONE, this.hap.SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
              video: {
                resolutions,
                codec: {
                  type: videoType,
                  profiles,
                  levels,
                },
              },
              audio: {
                twoWayAudio:
                  this.ffmpeg?.features?.encoders?.includes('libfdk_aac') === true &&
                  (this.ffmpeg?.features?.encoders?.includes('libspeex') === true ||
                    this.ffmpeg?.features?.encoders?.includes('libopus') === true) &&
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
            }
          : {
              supportedCryptoSuites: [this.hap.SRTPCryptoSuites.NONE],
              video: {
                resolutions: [],
                codec: {
                  type: videoType,
                  profiles: [],
                  levels: [],
                },
              },
              audio: {
                twoWayAudio: false,
                codecs: [],
              },
            },
      recording:
        this.ffmpeg instanceof FFmpeg === true
          ? {
              delegate: this,
              options: {
                overrideEventTriggerOptions: [this.hap.EventTriggerOption.MOTION, this.hap.EventTriggerOption.DOORBELL],
                mediaContainerConfiguration: [
                  {
                    fragmentLength: 4000,
                    type: this.hap.MediaContainerType.FRAGMENTED_MP4,
                  },
                ],
                prebufferLength: 4000, // Seems to always be 4000???
                video: {
                  resolutions,
                  parameters: {
                    profiles,
                    levels,
                  },
                  type: videoType,
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
            }
          : undefined,
      sensors:
        this.ffmpeg instanceof FFmpeg === true
          ? {
              motion: this.motionService !== undefined ? this.motionService : false,
            }
          : undefined,
    };

    return controllerOptions;
  }
}

// Data translation functions for camera, doorbell and floodlight data.
// We use this to translate RAW Nest and Google data into the format we want for our
// camera device(s) using the field map below.
//
// This keeps all translation logic in one place and makes it easier to maintain as
// Nest and Google sources evolve over time.
//
// Field map conventions:
// - Return undefined for missing values rather than placeholder defaults
// - processRawData() determines if enough data exists to build the device
// - Optional fields may remain undefined
//
// Camera field translation map
const CAMERA_FIELD_MAP = {
  // Identity fields
  serialNumber: {
    google: ({ sourceValue }) =>
      typeof sourceValue?.value?.device_identity?.serialNumber === 'string' && sourceValue.value.device_identity.serialNumber.trim() !== ''
        ? sourceValue.value.device_identity.serialNumber
        : undefined,
    nest: ({ sourceValue }) =>
      typeof sourceValue?.value?.serial_number === 'string' && sourceValue.value.serial_number.trim() !== ''
        ? sourceValue.value.serial_number
        : undefined,
  },

  nest_google_device_uuid: {
    google: ({ objectKey }) => objectKey,
    nest: ({ objectKey }) => objectKey,
  },

  nest_google_home_uuid: {
    google: ({ sourceValue }) => sourceValue?.value?.device_info?.pairerId?.resourceId,
    nest: ({ sourceValue }) => 'structure.' + sourceValue?.value?.structure_id,
  },

  // Device classification
  type: {
    google: ({ sourceValue }) =>
      sourceValue?.value?.doorbell_indoor_chime_settings?.chimeType !== undefined
        ? DEVICE_TYPE.DOORBELL
        : typeof sourceValue?.value?.floodlight_settings === 'object' && typeof sourceValue?.value?.floodlight_state === 'object'
          ? DEVICE_TYPE.FLOODLIGHT
          : DEVICE_TYPE.CAMERA,
    nest: ({ sourceValue }) =>
      sourceValue?.value?.capabilities?.includes?.('indoor_chime') === true ? DEVICE_TYPE.DOORBELL : DEVICE_TYPE.CAMERA,
  },

  model: {
    google: ({ sourceValue }) => {
      let typeName = sourceValue?.value?.device_info?.typeName ?? '';

      return typeName === 'google.resource.GreenQuartzResource'
        ? 'Doorbell (2nd gen, battery)'
        : typeName === 'google.resource.UsticaResource'
          ? 'Cam Indoor (3rd gen, wired)'
          : typeName === 'google.resource.SpencerResource'
            ? 'Cam (2nd gen, wired)'
            : typeName === 'google.resource.VenusResource'
              ? 'Doorbell (2nd gen, wired)'
              : typeName === 'google.resource.RhodesResource'
                ? 'Doorbell (3nd gen, wired)'
                : typeName === 'nest.resource.NestCamOutdoorResource'
                  ? 'Cam Outdoor (1st gen, wired)'
                  : typeName === 'google.resource.LinosaResource'
                    ? 'Cam Outdoor (2nd gen, wired)'
                    : typeName === 'nest.resource.NestCamIndoorResource'
                      ? 'Cam Indoor (1st gen)'
                      : typeName === 'nest.resource.NestCamIQResource'
                        ? 'Cam IQ Indoor (1st gen)'
                        : typeName === 'nest.resource.NestCamIQOutdoorResource'
                          ? 'Cam IQ Outdoor (1st gen, wired)'
                          : typeName === 'nest.resource.NestHelloResource'
                            ? 'Doorbell (1st gen, wired)'
                            : typeName === 'google.resource.NeonQuartzResource'
                              ? 'Cam with Floodlight (1st gen, wired)'
                              : typeName === 'google.resource.GoogleNewmanResource'
                                ? 'Max Hub (1st gen, wired)'
                                : 'Camera (unknown)';
    },

    nest: ({ sourceValue }) =>
      typeof sourceValue?.value?.model === 'string' && sourceValue.value.model !== ''
        ? sourceValue.value.model.replace(/nest\s*/gi, '')
        : undefined,
  },

  softwareVersion: {
    google: ({ sourceValue }) => sourceValue?.value?.device_identity?.softwareVersion,
    nest: ({ sourceValue }) => sourceValue?.value?.software_version,
  },

  // Naming / descriptive fields
  description: {
    google: ({ sourceValue }) => String(sourceValue?.value?.label?.label ?? ''),
    nest: ({ sourceValue }) => (typeof sourceValue?.value?.description === 'string' ? sourceValue.value.description : ''),
  },

  location: {
    google: ({ rawData, sourceValue }) =>
      String(
        [
          ...Object.values(
            rawData?.[sourceValue?.value?.device_info?.pairerId?.resourceId]?.value?.located_annotations?.predefinedWheres || {},
          ),
          ...Object.values(
            rawData?.[sourceValue?.value?.device_info?.pairerId?.resourceId]?.value?.located_annotations?.customWheres || {},
          ),
        ].find((where) => where?.whereId?.resourceId === sourceValue?.value?.device_located_settings?.whereAnnotationRid?.resourceId)?.label
          ?.literal ?? '',
      ),

    nest: ({ rawData, sourceValue }) =>
      String(
        rawData?.['where.' + sourceValue?.value?.structure_id]?.value?.wheres?.find(
          (where) => where?.where_id === sourceValue?.value?.where_id,
        )?.name ?? '',
      ),
  },

  // Core operational fields
  online: {
    google: ({ sourceValue }) => sourceValue?.value?.liveness?.status === 'LIVENESS_DEVICE_STATUS_ONLINE',
    nest: ({ sourceValue }) => sourceValue?.value?.streaming_state?.includes?.('offline') === false,
  },

  streaming_enabled: {
    google: ({ sourceValue }) => sourceValue?.value?.recording_toggle?.currentCameraState === 'CAMERA_ON',
    nest: ({ sourceValue }) => sourceValue?.value?.streaming_state?.includes?.('enabled') === true,
  },

  audio_enabled: {
    google: ({ sourceValue }) => sourceValue?.value?.microphone_settings?.enableMicrophone === true,
    nest: ({ sourceValue }) => sourceValue?.value?.audio_input_enabled === true,
  },

  has_indoor_chime: {
    google: ({ sourceValue }) =>
      sourceValue?.value?.doorbell_indoor_chime_settings?.chimeType === 'CHIME_TYPE_MECHANICAL' ||
      sourceValue?.value?.doorbell_indoor_chime_settings?.chimeType === 'CHIME_TYPE_ELECTRONIC',
    nest: ({ sourceValue }) => sourceValue?.value?.capabilities?.includes?.('indoor_chime') === true,
  },

  indoor_chime_enabled: {
    google: ({ sourceValue }) => sourceValue?.value?.doorbell_indoor_chime_settings?.chimeEnabled === true,
    nest: ({ sourceValue }) => sourceValue?.value?.properties?.['doorbell.indoor_chime.enabled'] === true,
  },

  has_irled: {
    nest: ({ sourceValue }) => sourceValue?.value?.capabilities?.includes?.('irled') === true,
  },

  irled_enabled: {
    nest: ({ sourceValue }) => sourceValue?.value?.properties?.['irled.state'] !== 'always_off',
  },

  has_statusled: {
    nest: ({ sourceValue }) => sourceValue?.value?.capabilities?.includes?.('statusled') === true,
  },

  has_video_flip: {
    nest: ({ sourceValue }) => sourceValue?.value?.capabilities?.includes?.('video.flip') === true,
  },

  video_flipped: {
    nest: ({ sourceValue }) => sourceValue?.value?.properties?.['video.flipped'] === true,
  },

  statusled_brightness: {
    nest: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.properties?.['statusled.brightness']) === false
        ? Number(sourceValue.value.properties['statusled.brightness'])
        : undefined,
  },

  has_microphone: {
    google: ({ sourceValue }) => sourceValue?.value?.microphone_settings?.enableMicrophone === true,
    nest: ({ sourceValue }) => sourceValue?.value?.capabilities?.includes?.('audio.microphone') === true,
  },

  has_speaker: {
    google: ({ sourceValue }) => sourceValue?.value?.speaker_volume?.volume !== undefined,
    nest: ({ sourceValue }) => sourceValue?.value?.capabilities?.includes?.('audio.speaker') === true,
  },

  has_motion_detection: {
    google: ({ sourceValue }) => sourceValue?.value?.observation_trigger_capabilities?.videoEventTypes?.motion?.value === true,
    nest: ({ sourceValue }) => sourceValue?.value?.capabilities?.includes?.('detectors.on_camera') === true,
  },

  motion_detection_enabled: {
    google: ({ sourceValue }) =>
      sourceValue?.value?.observation_trigger_capabilities?.videoEventTypes?.motion?.value === true &&
      sourceValue?.value?.observation_trigger_settings?.zoneTriggerSettings?.some?.(
        (zone) => zone?.zoneSettings?.triggerTypes?.motion?.enabled?.value === true,
      ) === true,
    nest: ({ sourceValue }) =>
      sourceValue?.value?.capabilities?.includes?.('detectors.on_camera') === true &&
      sourceValue?.value?.properties?.['notify.motion.enabled'] === true,
  },

  events: {
    google: ({ sourceValue }) => (typeof sourceValue?.value?.events === 'object' ? sourceValue.value.events : []),
    nest: ({ sourceValue }) => (typeof sourceValue?.value?.events === 'object' ? sourceValue.value.events : []),
  },

  quiet_time_enabled: {
    google: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.quiet_time_settings?.quietTimeEnds?.seconds) === false &&
      Number(sourceValue.value.quiet_time_settings.quietTimeEnds.seconds) !== 0 &&
      Math.floor(Date.now() / 1000) < Number(sourceValue.value.quiet_time_settings.quietTimeEnds.seconds),
    nest: () => false,
  },

  camera_type: {
    google: ({ sourceValue }) => sourceValue?.value?.device_identity?.vendorProductId,
    nest: ({ sourceValue }) => sourceValue?.value?.camera_type,
  },

  streaming_protocols: {
    google: ({ sourceValue }) =>
      Array.isArray(sourceValue?.value?.streaming_protocol?.supportedProtocols) === true
        ? sourceValue.value.streaming_protocol.supportedProtocols
        : [],
    nest: () => ['PROTOCOL_NEXUSTALK'],
  },

  nexustalk_host: {
    google: ({ sourceValue }) =>
      typeof sourceValue?.value?.streaming_protocol?.directHost?.value === 'string'
        ? sourceValue.value.streaming_protocol.directHost.value
        : undefined,
    nest: ({ sourceValue }) => sourceValue?.value?.direct_nexustalk_host,
  },

  mpegdash_url: {
    google: ({ sourceValue }) =>
      typeof sourceValue?.value?.streaming_protocol?.dashUrl?.value === 'string'
        ? sourceValue.value.streaming_protocol.dashUrl.value
        : undefined,
    nest: () => undefined,
  },

  hls_url: {
    google: ({ sourceValue }) =>
      typeof sourceValue?.value?.streaming_protocol?.hlsUrl?.value === 'string'
        ? sourceValue.value.streaming_protocol.hlsUrl.value
        : undefined,
    nest: () => undefined,
  },

  has_light: {
    google: ({ sourceValue }) =>
      typeof sourceValue?.value?.floodlight_settings === 'object' && typeof sourceValue?.value?.floodlight_state === 'object',
  },

  light_enabled: {
    google: ({ sourceValue }) => sourceValue?.value?.floodlight_state?.currentState === 'LIGHT_STATE_ON',
  },

  light_brightness: {
    google: ({ sourceValue }) =>
      isNaN(sourceValue?.value?.floodlight_settings?.brightness) === false
        ? scaleValue(Number(sourceValue.value.floodlight_settings.brightness), 0, 10, 0, 100)
        : undefined,
  },

  migrating: {
    google: ({ sourceValue }) =>
      sourceValue?.value?.camera_migration_status?.state?.progress !== undefined &&
      sourceValue.value.camera_migration_status.state.progress !== 'PROGRESS_COMPLETE' &&
      sourceValue.value.camera_migration_status.state.progress !== 'PROGRESS_NONE',
    nest: ({ sourceValue }) =>
      sourceValue?.value?.properties?.['cc2migration.overview_state'] !== undefined &&
      sourceValue.value.properties['cc2migration.overview_state'] !== 'NORMAL',
  },

  battery_level: {
    google: ({ sourceValue }) =>
      // Google API reports battery remaining as fractional percentage (0–1)
      isNaN(sourceValue?.value?.battery_power_source?.remaining?.remainingPercent?.value) === false
        ? scaleValue(Number(sourceValue.value.battery_power_source.remaining.remainingPercent.value), 0, 1, 0, 100)
        : undefined,
    nest: ({ sourceValue }) =>
      // Nest API reports battery voltage for older battery-powered camera products
      isNaN(sourceValue?.value?.properties?.['rq_battery_battery_volt']) === false
        ? scaleValue(Number(sourceValue.value.properties['rq_battery_battery_volt']), 6.2, 8.4, 0, 100)
        : undefined,
  },

  nexus_api_http_server_url: {
    nest: ({ sourceValue }) => sourceValue?.value?.nexus_api_http_server_url ?? '',
  },
};

// Function to process our RAW Nest or Google for this device type
export function processRawData(log, rawData, config, deviceType = undefined) {
  if (
    rawData === null ||
    typeof rawData !== 'object' ||
    rawData?.constructor !== Object ||
    typeof config !== 'object' ||
    config?.constructor !== Object
  ) {
    return;
  }

  let devices = {};

  // Process data for any camera/doorbell(s) we have in the raw data
  Object.entries(rawData)
    .filter(
      ([key, value]) =>
        key.startsWith('quartz.') === true ||
        (key.startsWith('DEVICE_') === true &&
          (PROTOBUF_RESOURCES.CAMERA.includes(value.value?.device_info?.typeName) === true ||
            PROTOBUF_RESOURCES.DOORBELL.includes(value.value?.device_info?.typeName) === true ||
            PROTOBUF_RESOURCES.FLOODLIGHT.includes(value.value?.device_info?.typeName) === true)),
    )
    .forEach(([object_key, value]) => {
      let tempDevice = {};

      try {
        // Process Google API camera/doorbell/floodlight data
        if (
          value?.source === DATA_SOURCE.GOOGLE &&
          rawData?.[value.value?.device_info?.pairerId?.resourceId] !== undefined &&
          Array.isArray(value.value?.streaming_protocol?.supportedProtocols) === true &&
          value.value.streaming_protocol.supportedProtocols.includes('PROTOCOL_WEBRTC') === true &&
          (value.value?.configuration_done?.deviceReady === true ||
            value.value?.camera_migration_status?.state?.where === 'MIGRATED_TO_GOOGLE_HOME')
        ) {
          let mappedData = buildMappedObject(CAMERA_FIELD_MAP, createMappingContext(rawData, object_key, undefined, value));

          if (
            mappedData.serialNumber !== undefined &&
            mappedData.nest_google_device_uuid !== undefined &&
            mappedData.nest_google_home_uuid !== undefined &&
            mappedData.type !== undefined &&
            mappedData.model !== undefined &&
            mappedData.softwareVersion !== undefined &&
            (mappedData.description !== undefined || mappedData.location !== undefined)
          ) {
            tempDevice = processCommonData(
              mappedData.nest_google_device_uuid,
              mappedData.nest_google_home_uuid,
              {
                ...mappedData,
              },
              config,
            );
          }
        }

        // Process Nest API camera/doorbell data
        // Nest API is used for older NexusTalk-capable cameras and cameras not fully migrated to Google Home
        if (
          value?.source === DATA_SOURCE.NEST &&
          rawData?.['where.' + value.value.structure_id] !== undefined &&
          value.value?.nexus_api_http_server_url !== undefined &&
          (value.value?.properties?.['cc2migration.overview_state'] === 'NORMAL' ||
            value.value?.properties?.['cc2migration.overview_state'] === 'REVERSE_MIGRATION_IN_PROGRESS')
        ) {
          let mappedData = buildMappedObject(CAMERA_FIELD_MAP, createMappingContext(rawData, object_key, value, undefined));

          if (
            mappedData.serialNumber !== undefined &&
            mappedData.nest_google_device_uuid !== undefined &&
            mappedData.nest_google_home_uuid !== undefined &&
            mappedData.type !== undefined &&
            mappedData.model !== undefined &&
            mappedData.softwareVersion !== undefined &&
            (mappedData.description !== undefined || mappedData.location !== undefined)
          ) {
            tempDevice = processCommonData(
              mappedData.nest_google_device_uuid,
              mappedData.nest_google_home_uuid,
              {
                ...mappedData,
              },
              config,
            );
          }
        }
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        log?.debug?.('Error processing camera data for "%s"', object_key);
      }

      if (
        Object.entries(tempDevice).length !== 0 &&
        typeof devices[tempDevice.serialNumber] === 'undefined' &&
        (deviceType === undefined || (typeof deviceType === 'string' && deviceType !== '' && tempDevice.type === deviceType))
      ) {
        let deviceOptions = config?.devices?.find(
          (device) => device?.serialNumber?.toUpperCase?.() === tempDevice?.serialNumber?.toUpperCase?.(),
        );
        let homeOptions = config?.homes?.find(
          (home) =>
            home?.nest_home_uuid?.toUpperCase?.() === tempDevice?.nest_google_home_uuid?.toUpperCase?.() ||
            home?.google_home_uuid?.toUpperCase?.() === tempDevice?.nest_google_home_uuid?.toUpperCase?.(),
        );

        // Insert any extra options we've read in from configuration file for this device
        tempDevice.eveHistory =
          deviceOptions?.eveHistory !== undefined
            ? deviceOptions.eveHistory === true
            : homeOptions?.eveHistory !== undefined
              ? homeOptions.eveHistory === true
              : config.options?.eveHistory === true;
        tempDevice.doorbellCooldown = parseDurationToSeconds(deviceOptions?.doorbellCooldown, { defaultValue: 60, min: 0, max: 300 });
        tempDevice.motionCooldown = parseDurationToSeconds(deviceOptions?.motionCooldown, { defaultValue: 60, min: 0, max: 300 });
        tempDevice.chimeSwitch = deviceOptions?.chimeSwitch === true;
        tempDevice.localAccess = deviceOptions?.localAccess === true;
        tempDevice.ffmpeg = {
          binary: config.options.ffmpeg.binary,
          valid: config.options.ffmpeg.valid === true,
          debug: deviceOptions?.ffmpegDebug === true || config.options?.ffmpeg.debug === true,
          hwaccel:
            (deviceOptions?.ffmpegHWaccel === true || config.options?.ffmpegHWaccel === true) &&
            config.options.ffmpeg.valid === true &&
            config.options.ffmpeg.hwaccel === true,
        };
        tempDevice.maxStreams = 1; // Always 1 stream since HKSV is mandatory

        devices[tempDevice.serialNumber] = tempDevice;
      }
    });

  return devices;
}
