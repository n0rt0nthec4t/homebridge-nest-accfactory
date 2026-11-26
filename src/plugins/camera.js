// Nest Cameras and Doorbells - HomeKit integration
// Part of homebridge-nest-accfactory
//
// HomeKit accessory implementation for Nest Cameras, Doorbells, and Floodlight Cameras.
// Integrates camera streaming, HomeKit Secure Video (HKSV), motion events, and snapshots
// into HomeKit using HAP-NodeJS controllers.
//
// Responsibilities:
// - Configure HomeKit CameraController or DoorbellController services
// - Manage HomeKit live streaming and recording session requests
// - Select and initialise the appropriate streaming backend (WebRTC or NexusTalk)
// - Translate HomeKit media requirements for Streamer-owned live and recording outputs
// - Supply HomeKit return-audio routing to the Streamer-owned RTPMuxer
// - Adapt bounded FFmpeg recording fragments to the HomeKit async generator
// - Retain HomeKit session identity, port reservations and the live RTCP watchdog
// - Handle motion events, cooldown timing, and Eve history integration
// - Request snapshot buffers through the selected API and provide HomeKit fallback images
// - Translate Nest / Google camera data into HomeKit-facing state
//
// Services:
// - CameraController or DoorbellController (primary streaming service)
// - MotionSensor (motion detection with eventSnapshot support)
// - RecordingManagement (HomeKit Secure Video configuration and recording state)
// - Battery (optional, for battery-powered models)
//
// Features:
// - Streaming via WebRTC and NexusTalk protocols
// - RTP/RTSP media input for WebRTC and NexusTalk live view and HKSV
// - HomeKit Secure Video live streaming and recording support
// - Stream copy or transcoding via ffmpeg (configurable per device)
// - Motion-triggered recording with prebuffer support
// - Two-way audio support where available and supported by ffmpeg
// - Snapshot handling with fallback support for offline or unavailable states
// - Night vision, status LED, microphone, speaker, and image rotation controls
// - Battery level monitoring for supported models
// - Eve Home activity history integration when enabled
//
// Notes:
// - Streamer owns source retention, transport/output lifecycle, pacing, and fallback video
// - Protocol-specific media transport is handled by StreamTransport implementations
// - FFmpeg owns command construction, process lifecycle and MP4 fragment reading
// - Recording keeps isLast false for the existing HAP-NodeJS workaround
// - Motion events trigger HKSV recording and HomeKit automations
// - API clients own snapshot refresh, URL construction, authentication and image download
// - This module selects fallback images for offline, disabled, migration or failed snapshots
//
// Mark Hulskamp
'use strict';

// Define node.js modules
import { Buffer } from 'node:buffer';
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';

// Define our modules
import HomeKitDevice from '../HomeKitDevice.js';
import Streamer from './camera/streamer.js';
import NexusTalk from './camera/nexustalk.js';
import WebRTC from './camera/webrtc.js';
import FFmpeg from './camera/ffmpeg.js';
import { getResourceKey, processSoftwareVersion, parseDurationToSeconds, scaleValue, buildDeviceDescription, UDPPorts } from '../utils.js';
import { buildMappedObject, createMappingContext, normaliseSourceContext } from '../translator.js';

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
  REDACTED,
} from '../consts.js';

const STREAMING_PROTOCOL = {
  WEBRTC: 'PROTOCOL_WEBRTC',
  NEXUSTALK: 'PROTOCOL_NEXUSTALK',
  MPEGDASH: 'PROTOCOL_MPEGDASH',
};

const TRANSPORTS = {
  [STREAMING_PROTOCOL.WEBRTC]: { module: WebRTC, label: 'WebRTC transport' },
  [STREAMING_PROTOCOL.NEXUSTALK]: { module: NexusTalk, label: 'NexusTalk transport' },
};

const PREBUFFER_LENGTH = 4000;

export default class NestCamera extends HomeKitDevice {
  static TYPE = DEVICE_TYPE.CAMERA;
  static VERSION = '2026.11.26'; // Code version

  controller = undefined; // HomeKit Camera/Doorbell controller service
  streamer = undefined; // Streamer object for live/recording stream
  motionService = undefined; // Single motion sensor for camera(s)
  batteryService = undefined; // Service for Camera/doorbell with battery
  ffmpeg = undefined; // FFMpeg object class

  // Internal data only for this class
  #liveSessions = new Map(); // Track active HomeKit live stream sessions (ports, crypto, talkback routing)
  #recordingSessions = new Map(); // Exact recording owners from RTP preparation through FFmpeg completion
  #recordingConfig = {}; // HomeKit Secure Video recording configuration
  #cameraImages = {}; // Snapshot resource images
  #motionCooldownActive = false; // Flag to track if motion cooldown is active
  #lastMotionEvent = { start: 0, end: 0 }; // Stable episode start and latest continuation; survives cooldown and empty polls.

  constructor(accessory, api, deviceData) {
    super(accessory, api, deviceData);

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
      this.ffmpeg = new FFmpeg(this.deviceData?.ffmpeg?.binary);
    }
  }

  // Class functions
  onAdd() {
    // Pre-0.4.0 cleanup
    // Remove legacy extra motion services so only the primary motion service remains
    this.accessory.services
      .filter((service) => service.UUID === this.hap.Service.MotionSensor.UUID)
      .forEach((service) => {
        if (service.subtype !== 1) {
          this?.log?.debug?.(
            'Removing legacy extra motion service from "%s" with id of "%s"',
            this.deviceData.description,
            service.subtype,
          );
          this.removeService(service);
        }
      });

    // Remove legacy CameraOperatingMode service which was created when HKSV was disabled
    if (this.accessory?.context?.hksv === false) {
      this.accessory.services
        .filter((service) => service.UUID === this.hap.Service.CameraOperatingMode.UUID)
        .forEach((service) => {
          this?.log?.debug?.('Removing legacy CameraOperatingMode service from "%s"', this.deviceData.description);
          this.removeService(service);
        });
    }
    // End of pre-0.4.0 cleanup

    // Setup the motion service if not already present on the accessory, and link it to the Eve app if configured to do so
    // We also need to add the active characteristic to the motion service for it to work with HKSV
    // This needs to be done before we setup the HomeKit camera controller
    this.motionService = this.addService(this.hap.Service.MotionSensor, '', 1, { history: {} });
    this.addCharacteristic(this.motionService, this.hap.Characteristic.Active, {}); // Required for HKSV
    this.motionService.updateCharacteristic(this.hap.Characteristic.Active, true); // Required for HKSV
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

      // Nest software-off is remotely reversible, so represent it using HomeKitCameraActive.
      // Remove ManuallyDisabled in case it was persisted by an earlier plugin version.
      this.removeCharacteristic(this.controller?.recordingManagement?.operatingModeService, this.hap.Characteristic.ManuallyDisabled);
    }

    // Setup battery service if required and not already present on the accessory
    if (this.deviceData.model.includes('battery') === true && Number.isFinite(Number(this.deviceData?.battery_level)) === true) {
      this.batteryService = this.addService(this.hap.Service.Battery, '', 1, { hidden: true });
    }

    // Setup set characteristics
    if (this.controller?.recordingManagement?.operatingModeService !== undefined && this.deviceData?.has_statusled === true) {
      this.addCharacteristic(
        this.controller.recordingManagement.operatingModeService,
        this.hap.Characteristic.CameraOperatingModeIndicator,
        {
          onSet: async (value) => {
            // 0 = auto, 1 = low, 2 = high
            // We'll use auto mode for led on and low for led off
            // Newer HAP runtimes expose this control as a 0/1 enum; older ones use a boolean.
            let enabled = value === true || value === 1;
            if (
              (enabled === true && this.deviceData.statusled_brightness !== 0) ||
              (enabled === false && this.deviceData.statusled_brightness !== 1)
            ) {
              // Let the shared characteristic boundary report rejected writes.
              await this.set({
                uuid: this.deviceData.nest_google_device_uuid,
                statusled_brightness: enabled === true ? 0 : 1,
              });
              this?.log?.info?.('Recording status LED on "%s" was turned %s', this.deviceData.description, enabled === true ? 'on' : 'off');
            }
          },
          onGet: () => {
            return this.deviceData.statusled_brightness !== 1;
          },
        },
      );
    }

    if (this.controller?.recordingManagement?.operatingModeService !== undefined && this.deviceData?.has_irled === true) {
      this.addCharacteristic(this.controller.recordingManagement.operatingModeService, this.hap.Characteristic.NightVision, {
        onSet: async (value) => {
          // only change IRLed status value if different than on-device
          if ((value === false && this.deviceData.irled_enabled === true) || (value === true && this.deviceData.irled_enabled === false)) {
            await this.set({
              uuid: this.deviceData.nest_google_device_uuid,
              irled_enabled: value,
            });

            this?.log?.info?.('Night vision on "%s" was turned %s', this.deviceData.description, value === true ? 'on' : 'off');
          }
        },
        onGet: () => {
          return this.deviceData.irled_enabled;
        },
      });
    }

    if (this.controller?.recordingManagement?.operatingModeService !== undefined) {
      this.addCharacteristic(this.controller.recordingManagement.operatingModeService, this.hap.Characteristic.HomeKitCameraActive, {
        onSet: async (value) => {
          if (
            (this.deviceData.streaming_enabled === false && value === this.hap.Characteristic.HomeKitCameraActive.ON) ||
            (this.deviceData.streaming_enabled === true && value === this.hap.Characteristic.HomeKitCameraActive.OFF)
          ) {
            // Camera state does not reflect requested state, so fix
            await this.set({
              uuid: this.deviceData.nest_google_device_uuid,
              streaming_enabled: value === this.hap.Characteristic.HomeKitCameraActive.ON ? true : false,
            });
            this?.log?.info?.(
              'Camera on "%s" was turned %s',
              this.deviceData.description,
              value === this.hap.Characteristic.HomeKitCameraActive.ON ? 'on' : 'off',
            );
          }
        },
      });
    }

    if (this.controller?.recordingManagement?.operatingModeService !== undefined && this.deviceData?.has_video_flip === true) {
      this.addCharacteristic(this.controller.recordingManagement.operatingModeService, this.hap.Characteristic.ImageRotation, {
        onGet: () => {
          return this.deviceData.video_flipped === true ? 180 : 0;
        },
      });
    }

    if (this.controller?.recordingManagement?.recordingManagementService !== undefined && this.deviceData.has_microphone === true) {
      this.addCharacteristic(this.controller.recordingManagement.recordingManagementService, this.hap.Characteristic.RecordingAudioActive, {
        onSet: async (value) => {
          if (
            (this.deviceData.audio_enabled === true && value === this.hap.Characteristic.RecordingAudioActive.DISABLE) ||
            (this.deviceData.audio_enabled === false && value === this.hap.Characteristic.RecordingAudioActive.ENABLE)
          ) {
            await this.set({
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
      });
    }

    if (this.deviceData.migrating === true) {
      // Migration happening between Nest <-> Google Home apps
      this?.log?.warn?.('Migration between Nest <-> Google Home apps is underway for "%s"', this.deviceData.description);
    }

    this.deviceData?.streaming_protocols?.some?.((protocol) => TRANSPORTS[protocol]?.module !== undefined) !== true &&
      this?.log?.error?.(
        'No suitable streaming protocol is present for "%s". Streaming and recording will be unavailable',
        this.deviceData.description,
      );

    // Extra setup details for output
    if (Number.isFinite(this.deviceData.aspect_ratio) === true) {
      let ratio = this.deviceData.aspect_ratio;
      let label = { [4 / 3]: '4:3', [16 / 9]: '16:9', [3 / 4]: '3:4', [9 / 16]: '9:16', 1: '1:1' }[ratio] ?? ratio + ':1';
      this.postSetupDetail('Aspect ratio "%s"', label, LOG_LEVELS.DEBUG);
    }

    this.deviceData?.streaming_protocols?.forEach?.((protocol) => {
      TRANSPORTS[protocol]?.module !== undefined && this.postSetupDetail(TRANSPORTS[protocol].label, LOG_LEVELS.DEBUG);
    });

    this.postSetupDetail(
      'HomeKit Secure Video support' +
        (this.deviceData.model.includes('battery') === true && Number.isFinite(Number(this.deviceData?.battery_level)) === true
          ? ' (on battery)'
          : ''),
    );
    this.deviceData.ffmpeg.hwaccel === true && this.postSetupDetail('Hardware video acceleration');
    this.deviceData.ffmpeg.transcode === true && this.postSetupDetail('Video transcoding');

    // Setup repeat polling for camera events.
    // This is time-sensitive and we want to trigger HomeKit automations as close to real-time as possible
    this.addTimer(TIMERS.CAMERA_EVENTS.name, { interval: TIMERS.CAMERA_EVENTS.interval });
  }

  async onRemove() {
    // Clean up our camera object since this device is being removed
    // Stop all streamer logic (buffering, output, etc)
    await this.streamer?.stopEverything?.();

    // Terminate all live sessions and ffmpeg processes for this camera/doorbell
    for (let sessionID of [...this.#liveSessions.keys()]) {
      this.#cleanupLiveSession(sessionID);
    }

    // Cleanup any recording sessions and wake HKSV generators
    this.#cleanupRecordingSession();

    // Ensure all ffmpeg processes are removed
    await this.ffmpeg?.shutdown?.();

    // Remove any motion services we created
    if (this.motionService !== undefined) {
      this.motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);
      this.removeService(this.motionService);
    }

    // Remove the camera controller
    if (this.controller !== undefined) {
      this.accessory.removeController(this.controller);
    }

    // Clear references
    this.motionService = undefined;
    this.batteryService = undefined;
    this.streamer = undefined;
    this.controller = undefined;
    this.ffmpeg = undefined;
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

    if (this.deviceData.migrating !== true && deviceData.migrating === true) {
      // Migration happening between Nest <-> Google Home apps. We'll stop any active streams, close the current streaming object
      this?.log?.warn?.('Migration between Nest <-> Google Home apps has started for "%s"', deviceData.description);
      await this.streamer?.stopEverything?.();
      this.streamer = undefined;
    }

    if (this.deviceData.migrating === true && deviceData.migrating !== true) {
      // Migration has completed between Nest <-> Google Home apps
      this?.log?.success?.('Migration between Nest <-> Google Home apps has completed for "%s"', deviceData.description);
    }

    // Handle case of changes in streaming protocols OR just finished migration between Nest <-> Google Home apps
    if (
      this.streamer !== undefined &&
      JSON.stringify(deviceData.streaming_protocols) !== JSON.stringify(this.deviceData.streaming_protocols)
    ) {
      this?.log?.warn?.('Available streaming protocols have changed for "%s"', deviceData.description);
      await this.streamer.stopEverything();
      this.streamer = undefined;
    }

    if (this.streamer === undefined && deviceData.migrating !== true) {
      this.streamer = this.#createStreamer(deviceData, this.deviceData.migrating === true ? ' after migration' : '');

      if (
        this?.streamer?.isBuffering() === false &&
        this?.controller?.recordingManagement?.recordingManagementService !== undefined &&
        this.controller.recordingManagement.recordingManagementService.getCharacteristic(this.hap.Characteristic.Active).value ===
          this.hap.Characteristic.Active.ACTIVE
      ) {
        await this.message(Streamer.MESSAGE, Streamer.MESSAGE_TYPE.START_BUFFER, {
          options: {},
        });
      }
    }

    // Pass updated auth/host details through to an already-created streamer.
    await this.streamer?.onUpdate?.(deviceData);

    if (this.controller?.recordingManagement?.operatingModeService !== undefined) {
      // Update camera off/on status
      this.controller.recordingManagement.operatingModeService.updateCharacteristic(
        this.hap.Characteristic.HomeKitCameraActive,
        deviceData.streaming_enabled === true
          ? this.hap.Characteristic.HomeKitCameraActive.ON
          : this.hap.Characteristic.HomeKitCameraActive.OFF,
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
      if (deviceData.audio_enabled === true && Number.isFinite(Number(deviceData.speaker_volume)) === true) {
        this.controller.speakerService.updateCharacteristic(this.hap.Characteristic.Volume, deviceData.speaker_volume);
      }

      // if audio is disabled, we'll mute speaker
      this.controller.setSpeakerMuted(deviceData.audio_enabled === false ? true : false);
    }

    // Process camera events, the most recent event is first
    for (const event of deviceData.events || []) {
      if (
        this.controller?.recordingManagement?.operatingModeService?.getCharacteristic?.(this.hap.Characteristic.HomeKitCameraActive)
          .value === this.hap.Characteristic.HomeKitCameraActive.ON
      ) {
        // We're configured to handle camera events
        // https://github.com/Supereg/secure-video-specification?tab=readme-ov-file#33-homekitcameraactive

        // Handle motion event
        // We will use this to trigger the starting of the HKSV recording if the camera is active
        if (event.types.includes('motion') === true) {
          // The start identifies an episode; its end can advance when Google
          // revises retained history. Extend active motion, but never rearm an
          // expired episode solely because its reported end changed.
          let start = Number.isFinite(event.start_time) === true && event.start_time > 0 ? event.start_time : event.end_time;
          if (Number.isFinite(start) !== true || start <= 0) {
            continue;
          }
          start = start < 1e12 ? start * 1000 : start;
          let end = Number.isFinite(event.end_time) === true && event.end_time > 0 ? event.end_time : undefined;
          end = end === undefined ? start : Math.max(start, end < 1e12 ? end * 1000 : end);
          if (
            start < this.#lastMotionEvent.start ||
            (start === this.#lastMotionEvent.start && (end <= this.#lastMotionEvent.end || this.#motionCooldownActive === false))
          ) {
            continue;
          }
          this.#lastMotionEvent = { start, end };

          // Only set motion to true on first detection
          if (this.#motionCooldownActive === false) {
            if (typeof this.motionService === 'object') {
              if (this.deviceData?.logMotionEvents === true) {
                this?.log?.info?.('Motion detected in "%s"', deviceData.description);
              }

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
    }
  }

  async onShutdown() {
    // Clear any motion
    if (this.motionService !== undefined) {
      this.motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);
    }

    // Stop all streamer logic (buffering, output, etc)
    await this.streamer?.stopEverything?.();

    // Terminate all live sessions and ffmpeg processes for this camera/doorbell
    for (let sessionID of [...this.#liveSessions.keys()]) {
      this.#cleanupLiveSession(sessionID);
    }

    // Cleanup any recording sessions and wake HKSV generators
    this.#cleanupRecordingSession();

    // Ensure all ffmpeg processes are removed
    await this.ffmpeg?.shutdown?.();
  }

  async onTimer(message) {
    if (typeof message !== 'object' || typeof message?.timer !== 'string') {
      return;
    }

    // HomeKit stopped sending live-video RTCP feedback; use the normal stop path.
    if (message.timer === 'live-rtcp-' + message.sessionID && this.#liveSessions.has(message.sessionID) === true) {
      await this.handleStreamRequest({ type: this.hap.StreamRequestTypes.STOP, sessionID: message.sessionID });
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

  async onMessage(type, message, ...args) {
    // Only the current streamer receives commands after migration or protocol replacement.
    if (Object.values(Streamer.MESSAGE_TYPE).includes(type) === true) {
      return await this.streamer?.onMessage(type, message, ...args);
    }

    if (typeof type !== 'string' || type === '' || (message !== undefined && (typeof message !== 'object' || message === null))) {
      return;
    }

    if (type === HomeKitDevice.ONLINE) {
      // Notified that camera is back online

      if (this.motionService !== undefined) {
        // Re-enable motion service in HomeKit now camera is reachable again
        this.motionService.updateCharacteristic(this.hap.Characteristic.StatusActive, true);
      }

      // If HKSV recording is enabled, ensure prebuffering is running again.
      // This allows us to capture footage leading up to any motion event.
      if (
        this?.streamer?.isBuffering?.() === false &&
        this?.controller?.recordingManagement?.recordingManagementService !== undefined &&
        this.controller.recordingManagement.recordingManagementService.getCharacteristic(this.hap.Characteristic.Active).value ===
          this.hap.Characteristic.Active.ACTIVE
      ) {
        // Restart buffer pipeline so camera is ready for motion-triggered recording
        await this.message(Streamer.MESSAGE, Streamer.MESSAGE_TYPE.START_BUFFER, {
          options: {},
        });
      }

      return;
    }

    if (type === HomeKitDevice.OFFLINE) {
      // Notified that camera is offline
      if (this.motionService !== undefined) {
        // Clear any existing motion status in HomeKit since camera is now offline
        // This will also naturally stop any inflight motion-triggered recording
        this.motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);
        this.motionService.updateCharacteristic(this.hap.Characteristic.StatusActive, false);
        this.#motionCooldownActive = false;
        this.removeTimer(TIMERS.MOTION_COOLDOWN.name);
        this.history(this.motionService, { status: 0 });
      }

      // Stop any prebuffering/record buffering
      await this.message(Streamer.MESSAGE, Streamer.MESSAGE_TYPE.STOP_BUFFER, {});
      return;
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

    if (this.#recordingConfig?.videoCodec === undefined) {
      this?.log?.debug?.(
        'Received request to start recording for "%s" before HKSV recording configuration was available',
        this.deviceData.description,
      );
      return;
    }

    let includeAudio =
      this.deviceData.audio_enabled === true &&
      this.controller?.recordingManagement?.recordingManagementService?.getCharacteristic(this.hap.Characteristic.RecordingAudioActive)
        ?.value === this.hap.Characteristic.RecordingAudioActive.ENABLE;

    // Keep one owner through RTP preparation and process startup. HomeKit close
    // or shutdown can retire it before either asynchronous stage completes.
    let recording = { controller: new AbortController(), output: undefined };
    this.#cleanupRecordingSession(sessionID);
    this.#recordingSessions.set(sessionID, recording);

    try {
      recording.output = await this.message(Streamer.MESSAGE, Streamer.MESSAGE_TYPE.START_RECORD, {
        sessionID,
        options: {
          includeAudio,
          recordTime: Date.now() - PREBUFFER_LENGTH,
          signal: recording.controller.signal,
          onClose: (error) => {
            if (error !== undefined) {
              this.log?.error?.('Recording output for "%s" stopped: %s', this.deviceData.description, error.message);
            }

            // The core already owns teardown. Preserve unexpected parser errors;
            // only a HomeKit cancellation should abort the fragment reader.
            if (this.#recordingSessions.get(sessionID) === recording) {
              this.#recordingSessions.delete(sessionID);
            }
          },
        },
      });
      if (this.#recordingSessions.get(sessionID) !== recording) {
        await recording.output?.stop();
        return;
      }

      let config = this.#recordingConfig.videoCodec;
      recording.output.start(this.ffmpeg, {
        video: {
          ...this.#homeKitVideo(config.parameters),
          width: config.resolution[0],
          height: config.resolution[1],
          fps: config.resolution[2],
          iFrameInterval: config.parameters.iFrameInterval,
          bitRate: config.parameters.bitRate,
        },
        includeAudio,
        sourceAudio: this.streamer.codecs.audio,
        hardware: this.deviceData.ffmpeg.hwaccel === true,
        onCommand: (kind, args) => this.#logCommand(kind, args),
      });
      this.log?.info?.('Started recording from "%s" %s', this.deviceData.description, includeAudio === false ? 'without audio' : '');

      // Keep isLast false for HAP-NodeJS issue #966. The readable owns stdout
      // backpressure and drains complete fragments even after FFmpeg exits.
      for await (let data of recording.output.fragments()) {
        yield { data, isLast: false };
      }
    } finally {
      this.#cleanupRecordingSession(sessionID, recording);
      await recording.output?.stop();
    }
  }

  async closeRecordingStream(sessionID, closeReason) {
    // Cancel the exact HomeKit recording owner before awaiting source teardown.
    this.#cleanupRecordingSession(sessionID);
    await this.message(Streamer.MESSAGE, Streamer.MESSAGE_TYPE.STOP_RECORD, {
      sessionID: sessionID,
    });

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
      await this.message(Streamer.MESSAGE, Streamer.MESSAGE_TYPE.START_BUFFER, {
        options: {},
      });
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

    // Get current image from camera/doorbell
    let imageBuffer = undefined;

    if (this.deviceData.migrating !== true && this.deviceData.streaming_enabled === true && this.deviceData.online === true) {
      // Request a snapshot image from upstream.
      // The selected account API owns snapshot refresh and fallback handling.
      let response = await this.get({ uuid: this.deviceData.nest_google_device_uuid, camera_snapshot: true });

      if (Buffer.isBuffer(response?.camera_snapshot) === true && response.camera_snapshot.length > 0) {
        imageBuffer = response.camera_snapshot;
      }
    }

    if (
      this.deviceData.migrating !== true &&
      this.deviceData.streaming_enabled === false &&
      this.deviceData.online === true &&
      this.#cameraImages?.off !== undefined
    ) {
      // Return 'camera switched off' jpg to image buffer
      imageBuffer = this.#cameraImages.off;
    }

    if (this.deviceData.migrating !== true && this.deviceData.online === false && this.#cameraImages?.offline !== undefined) {
      // Return 'camera offline' jpg to image buffer
      imageBuffer = this.#cameraImages.offline;
    }

    if (this.deviceData.migrating === true && this.#cameraImages?.transfer !== undefined) {
      // Return 'camera transferring' jpg to image buffer
      imageBuffer = this.#cameraImages.transfer;
    }

    callback(
      Buffer.isBuffer(imageBuffer) === true && imageBuffer.length > 0 ? null : new Error('Unable to obtain Camera/Doorbell snapshot'),
      imageBuffer,
    );
  }

  async prepareStream(request, callback) {
    // HomeKit has asked us to prepare ports and encryption details for video/audio streaming

    if (this.#liveSessions.has(request.sessionID) === true) {
      this.#cleanupLiveSession(request.sessionID);
    }

    let localVideoPort = undefined;
    let rtpSplitterPort = undefined;
    try {
      localVideoPort = await UDPPorts.allocate();
      rtpSplitterPort = await UDPPorts.allocate();
    } catch (error) {
      // Preparation may fail after selecting the first port. Release both numbers
      // before reporting failure so subsequent sessions can reuse them.
      UDPPorts.release(localVideoPort);
      UDPPorts.release(rtpSplitterPort);
      return callback(error);
    }

    // Generate streaming session information
    let sessionInfo = {
      address: request.targetAddress,
      videoPort: request.video.port,
      localVideoPort,
      videoCryptoSuite: request.video.srtpCryptoSuite,
      videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
      videoSSRC: this.hap.CameraController.generateSynchronisationSource(),

      audioPort: request.audio.port,
      rtpSplitterPort,
      audioCryptoSuite: request.audio.srtpCryptoSuite,
      audioSRTP: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
      audioSSRC: this.hap.CameraController.generateSynchronisationSource(),
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
    let session = this.#liveSessions.get(request.sessionID);

    if (request.type === this.hap.StreamRequestTypes.START && session !== undefined) {
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

      let includeAudio = this.deviceData.audio_enabled === true && this.streamer?.codecs?.audio !== undefined;

      let enableTalkback =
        includeAudio === true &&
        this.deviceData.has_speaker === true &&
        this.deviceData.has_microphone === true &&
        this.ffmpeg.supportsEncoder('libfdk_aac') === true &&
        ((this.streamer?.codecs?.talkback === Streamer.CODEC_TYPE.SPEEX && this.ffmpeg.supportsEncoder('libspeex') === true) ||
          (this.streamer?.codecs?.talkback === Streamer.CODEC_TYPE.OPUS && this.ffmpeg.supportsEncoder('libopus') === true));

      // Start the live streamer process
      try {
        session.controller = new AbortController();
        session.output = await this.message(Streamer.MESSAGE, Streamer.MESSAGE_TYPE.START_LIVE, {
          sessionID: request.sessionID,
          options: {
            includeAudio,
            talkback: enableTalkback === true ? { port: session.rtpSplitterPort, payloadType: request.audio.pt } : undefined,
            waitForReady: 2000,
            signal: session.controller.signal,
            onClose: (error) => {
              if (this.#liveSessions.get(request.sessionID) !== session) {
                return;
              }
              if (error !== undefined) {
                this.log?.error?.('Live output for "%s" stopped: %s', this.deviceData.description, error.message);
              }
              this.#cleanupLiveSession(request.sessionID);
              this.controller?.forceStopStreamingSession?.(request.sessionID);
            },
          },
        });
        if (this.#liveSessions.get(request.sessionID) !== session) {
          await session.output?.stop();
          return callback?.();
        }
        session.output.start(this.ffmpeg, {
          video: {
            ...this.#homeKitVideo(request.video),
            bitRate: request.video.max_bit_rate,
            payloadType: request.video.pt,
            mtu: request.video.mtu,
          },
          audio:
            includeAudio === true
              ? {
                  codec: request.audio.codec === this.hap.AudioStreamingCodecType.AAC_ELD ? 'aac-eld' : 'opus',
                  sampleRate: request.audio.sample_rate * 1000,
                  bitRate: request.audio.max_bit_rate,
                  channels: request.audio.channel,
                  packetTime: request.audio.packet_time,
                  payloadType: request.audio.pt,
                }
              : undefined,
          target: {
            address: session.address,
            videoPort: session.videoPort,
            audioPort: session.audioPort,
            videoSSRC: session.videoSSRC,
            audioSSRC: session.audioSSRC,
            videoSRTP: session.videoSRTP,
            audioSRTP: session.audioSRTP,
            videoSuite: this.hap.SRTPCryptoSuites[session.videoCryptoSuite],
            audioSuite: this.hap.SRTPCryptoSuites[session.audioCryptoSuite],
          },
          sourceAudio: this.streamer.codecs.audio,
          talkbackCodec: this.streamer.codecs.talkback,
          hardware: this.deviceData.ffmpeg.hwaccel === true,
          transcode: this.deviceData.ffmpeg.transcode === true,
          onCommand: (kind, args) => this.#logCommand(kind, args),
        });

        // Allow startup time for the first RTCP report, then require regular HomeKit feedback.
        if (this.#liveSessions.get(request.sessionID) === session && session.rtcpSocket === undefined) {
          let timer = 'live-rtcp-' + request.sessionID;
          session.rtcpSocket = dgram.createSocket(session.address.includes(':') === true ? 'udp6' : 'udp4');
          this.addTimer(timer, { delay: 30000, message: { sessionID: request.sessionID } });
          session.rtcpSocket.on('message', (packet) => {
            if (packet.length < 4 || packet[0] >> 6 !== 2 || packet[1] < 192 || packet[1] > 223) {
              return;
            }
            this.addTimer(timer, {
              delay: Math.max(10000, (request.video.rtcp_interval ?? 5) * 2000),
              reset: true,
              message: { sessionID: request.sessionID },
            });
          });
          session.rtcpSocket.on('error', (error) => {
            // Leave the watchdog armed so a failed listener cannot leave a live session running indefinitely.
            this?.log?.warn?.('Live stream RTCP listener failed on "%s": %s', this.deviceData.description, error.message);
          });
          session.rtcpSocket.bind(session.localVideoPort);
        }

        // We've started the live streaming session with or without two-way audio depending on configuration
        this?.log?.info?.(
          'Starting live stream from "%s"%s',
          this.deviceData.description,
          enableTalkback === true ? ' (two-way audio enabled)' : '',
        );
      } catch (error) {
        if (this.#liveSessions.get(request.sessionID) === session) {
          this.#cleanupLiveSession(request.sessionID);
        }
        await session.output?.stop();
        if (typeof callback === 'function') {
          callback(error);
          return;
        }
        throw error;
      }
    }

    if (request.type === this.hap.StreamRequestTypes.STOP && session !== undefined) {
      // Remove session ownership before awaiting source shutdown so a pending START cannot resume it.
      this.#cleanupLiveSession(request.sessionID);
      this.controller?.forceStopStreamingSession?.(request.sessionID);
      await this.message(Streamer.MESSAGE, Streamer.MESSAGE_TYPE.STOP_LIVE, {
        sessionID: request.sessionID,
      });

      this?.log?.info?.('Live stream stopped on "%s"', this.deviceData.description);
    }

    if (request.type === this.hap.StreamRequestTypes.RECONFIGURE && session !== undefined) {
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

    // Google's per-model source resolutions and quality settings:
    // https://support.google.com/googlehome/answer/9245832
    // Advertised HomeKit sizes are independent of the camera quality setting.
    // One height ladder supplies both lists; even widths suit H264. Fall back
    // to 16:9 if metadata is missing, invalid or produces no recording choices.
    let resolutions = [];
    let recordingResolutions = [];
    for (let aspectRatio of [this.deviceData.aspect_ratio, 16 / 9]) {
      if (Number.isFinite(aspectRatio) === false || aspectRatio <= 0) {
        continue;
      }
      let sizes = [1440, 1200, 1080, 960, 864, 768, 720, 540, 480, 384, 360, 240, 180].flatMap((height) => {
        let width = Math.round((height * aspectRatio) / 2) * 2;
        return width > 0 && width <= 2560 ? [[width, height, 30]] : [];
      });
      recordingResolutions = sizes.filter(([width, height]) => width <= 1920 && height <= 1080);
      if (recordingResolutions.length > 0) {
        resolutions = sizes.flatMap(([width, height]) => [
          [width, height, 30],
          [width, height, 15],
        ]);
        break;
      }
    }

    // Apple Watch needs this live option even when the camera has another ratio.
    if (resolutions.some(([width, height, fps]) => width === 320 && height === 240 && fps === 15) === false) {
      resolutions.push([320, 240, 15]);
    }

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
                  this.ffmpeg?.supportsEncoder('libfdk_aac') === true &&
                  (this.ffmpeg?.supportsEncoder('libspeex') === true || this.ffmpeg?.supportsEncoder('libopus') === true) &&
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
                prebufferLength: PREBUFFER_LENGTH, // Seems to always be 4000???
                video: {
                  resolutions: recordingResolutions,
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

  #createStreamer(deviceData, reason = '') {
    // Camera selects and configures the source transport; Streamer owns media lifecycle and RTP delivery.
    // Prefer WebRTC when available, falling back to NexusTalk for older Nest-capable cameras.
    let protocol = undefined;
    let TransportClass = undefined;
    let transportInstance = undefined;

    if (Array.isArray(deviceData?.streaming_protocols) !== true) {
      return undefined;
    }

    if (deviceData.streaming_protocols.includes(STREAMING_PROTOCOL.WEBRTC) === true && WebRTC !== undefined) {
      protocol = STREAMING_PROTOCOL.WEBRTC;
    } else if (deviceData.streaming_protocols.includes(STREAMING_PROTOCOL.NEXUSTALK) === true && NexusTalk !== undefined) {
      protocol = STREAMING_PROTOCOL.NEXUSTALK;
    }

    TransportClass = TRANSPORTS[protocol]?.module;

    if (TransportClass === undefined) {
      return undefined;
    }

    if (typeof reason === 'string' && reason !== '') {
      this?.log?.debug?.('Using %s for "%s"%s', TRANSPORTS[protocol]?.label ?? 'selected streamer', deviceData.description, reason);
    }

    transportInstance = new TransportClass({
      log: this.log,
      uuid: deviceData.apiAccess?.resourceId ?? deviceData.nest_google_device_uuid,
      apiAccess: deviceData?.apiAccess,
      fieldTest: deviceData?.apiAccess?.fieldTest === true,
      host: protocol === STREAMING_PROTOCOL.NEXUSTALK ? deviceData.nexustalk_host : undefined,
    });

    return new Streamer(this.uuid, deviceData, {
      log: this.log,
      ffmpegDebug: deviceData.ffmpeg?.debug === true,
      bufferDuration: PREBUFFER_LENGTH * 2,
      transport: transportInstance,
    });
  }

  #homeKitVideo(video) {
    // HomeKit enums are interpreted here; encoder-specific values belong to FFmpeg.
    return {
      profile: video.profile === this.hap.H264Profile.HIGH ? 'high' : video.profile === this.hap.H264Profile.MAIN ? 'main' : 'baseline',
      level: video.level === this.hap.H264Level.LEVEL4_0 ? '4.0' : video.level === this.hap.H264Level.LEVEL3_2 ? '3.2' : '3.1',
    };
  }

  #logCommand(kind, args) {
    // Command diagnostics must never disclose HomeKit SRTP key material.
    let safe = args.map((arg, index) => (args[index - 1] === '-srtp_out_params' ? REDACTED : arg));
    this.log?.debug?.(
      'ffmpeg process for %s from "%s" will be called using the following commandline: %s',
      kind,
      this.deviceData.description,
      safe.join(' '),
    );
  }

  #cleanupLiveSession(sessionID) {
    let session = this.#liveSessions.get(sessionID);

    this.removeTimer('live-rtcp-' + sessionID);
    session?.rtcpSocket?.removeAllListeners('message');
    try {
      session?.rtcpSocket?.close();
    } catch {
      // A listener whose bind failed may already be closed.
    }

    UDPPorts.release(session?.localVideoPort);
    UDPPorts.release(session?.rtpSplitterPort);

    this.#liveSessions.delete(sessionID);
    session?.controller?.abort();
    session?.output?.stop().catch((error) => this.log?.error?.('Live output cleanup failed: %s', error.message));
  }

  #cleanupRecordingSession(sessionID, owner) {
    for (let [id, recording] of this.#recordingSessions) {
      if ((sessionID === undefined || id === sessionID) && (owner === undefined || recording === owner)) {
        // Detach ownership first: stopping a process can notify lifecycle listeners.
        this.#recordingSessions.delete(id);
        recording.controller.abort();
        recording.output?.stop().catch((error) => this.log?.error?.('Recording output cleanup failed: %s', error.message));
      }
    }
  }
}

// Camera field translation map
// Maps raw source data -> normalised camera device fields
// - fields: top-level raw fields this mapping depends on (for delta updates)
// - related: top-level raw fields on related objects this mapping depends on
// - translate: converts raw -> final normalised value
const CAMERA_FIELD_MAP = {
  // Identity fields
  serialNumber: {
    required: true,
    google: {
      fields: [],
      translate: ({ raw }) =>
        typeof raw?.value?.device_identity?.serialNumber === 'string' && raw.value.device_identity.serialNumber.trim() !== ''
          ? raw.value.device_identity.serialNumber.trim().toUpperCase()
          : undefined,
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['technicalInformation'],
      translate: ({ raw }) => raw.value.technicalInformation?.serialNumber?.trim?.().toUpperCase(),
    },
  },

  nest_google_device_uuid: {
    required: true,
    google: {
      fields: [],
      translate: ({ objectKey }) => objectKey,
    },
    prefer: 'googlehome',
    googlehome: { fields: [], translate: ({ objectKey }) => objectKey },
  },

  nest_google_home_uuid: {
    google: {
      fields: ['device_info'],
      translate: ({ raw }) => raw?.value?.device_info?.pairerId?.resourceId,
    },
    prefer: 'googlehome',
    googlehome: { fields: ['structureId'], translate: ({ homeId }) => homeId },
  },

  // Device classification
  type: {
    required: true,
    google: {
      fields: [],
      translate: ({ raw, objectKey }) =>
        raw?.value?.doorbell_indoor_chime_settings?.chimeType !== undefined
          ? DEVICE_TYPE.DOORBELL
          : objectKey.startsWith('DEVICE_') === true &&
              PROTOBUF_RESOURCES.FLOODLIGHT.includes(raw?.value?.device_info?.typeName) === true &&
              Object.values(raw?.value?.related_resources?.relatedResources ?? {}).some(
                (resource) =>
                  resource?.resourceId?.resourceId?.startsWith('SERVICE_') === true &&
                  PROTOBUF_RESOURCES.FLOODLIGHT.includes(resource?.resourceTypeName?.resourceName) === true,
              ) === true
            ? DEVICE_TYPE.FLOODLIGHT
            : DEVICE_TYPE.CAMERA,
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['entitlement.triggerCapabilities', 'googleHome', 'floodlightId'],
      related: ['onOff.onOff', 'brightness.brightness'],
      translate: ({ raw, light }) => {
        let triggers = raw.value['entitlement.triggerCapabilities']?.array?.values;
        return raw.value.googleHome?.type === 'action.devices.types.DOORBELL' ||
          (Array.isArray(triggers) === true && triggers.some((trigger) => trigger?.text === 'doorbell') === true)
          ? DEVICE_TYPE.DOORBELL
          : typeof raw.value.floodlightId === 'string'
            ? light !== undefined
              ? DEVICE_TYPE.FLOODLIGHT
              : undefined
            : DEVICE_TYPE.CAMERA;
      },
    },
  },

  model: {
    required: true,
    google: {
      fields: ['device_info', 'related_resources'],
      translate: ({ raw, objectKey }) => {
        let typeName = raw?.value?.device_info?.typeName ?? '';

        // The battery camera and floodlight share camera hardware; the related
        // light service distinguishes the complete floodlight product.
        if (objectKey.startsWith('DEVICE_') === true && PROTOBUF_RESOURCES.FLOODLIGHT.includes(typeName) === true) {
          let hasLight = Object.values(raw?.value?.related_resources?.relatedResources ?? {}).some(
            (resource) =>
              resource?.resourceId?.resourceId?.startsWith('SERVICE_') === true &&
              PROTOBUF_RESOURCES.FLOODLIGHT.includes(resource?.resourceTypeName?.resourceName) === true,
          );
          return hasLight === true ? 'Cam with Floodlight (1st gen, wired)' : 'Cam (2nd gen, battery)';
        }

        let models = {
          'google.resource.GreenQuartzResource': 'Doorbell (2nd gen, battery)',
          'google.resource.UsticaResource': 'Cam Indoor (3rd gen, wired)',
          'google.resource.SpencerResource': 'Cam (2nd gen, wired)',
          'google.resource.VenusResource': 'Doorbell (2nd gen, wired)',
          'google.resource.RhodesResource': 'Doorbell (3rd gen, wired)',
          'nest.resource.NestCamOutdoorResource': 'Cam Outdoor (1st gen, wired)',
          'google.resource.LinosaResource': 'Cam Outdoor (2nd gen, wired)',
          'nest.resource.NestCamIndoorResource': 'Cam Indoor (1st gen)',
          'nest.resource.NestCamIQResource': 'Cam IQ Indoor (1st gen)',
          'nest.resource.NestCamIQOutdoorResource': 'Cam IQ Outdoor (1st gen, wired)',
          'nest.resource.NestHelloResource': 'Doorbell (1st gen, wired)',
          'google.resource.GoogleNewmanResource': 'Max Hub (1st gen, wired)',
        };
        return Object.hasOwn(models, typeName) === true ? models[typeName] : 'Camera (unknown)';
      },
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['googleHome', 'floodlightId'],
      related: ['googleHome'],
      translate: ({ raw, light }) => {
        if (light !== undefined) {
          return 'Cam with Floodlight (1st gen, wired)';
        }

        let models = {
          'nestcamoutdoor-user': 'Cam Outdoor (1st gen, wired)',
          'rquartz-user': 'Doorbell (1st gen, wired)',
          'quartz-user': 'Cam Indoor (1st gen)',
          'venus-user': 'Doorbell (2nd gen, wired)',
          'nq-user': 'Cam (2nd gen, battery)',
          'gq-user': 'Doorbell (2nd gen, battery)',
          'spencer-user': 'Cam (2nd gen, wired)',
          'bla4-user': 'Cam Outdoor (2nd gen, wired)',
          '2rs4-user': 'Doorbell (3rd gen, wired)',
          // Inferred from the resource name; this prefix awaits a device sample.
          'ustica-user': 'Cam Indoor (3rd gen, wired)',
        };
        let prefix = raw.value.googleHome?.hardware?.softwareVersion?.split(' ')[0];
        return Object.hasOwn(models, prefix) === true ? models[prefix] : raw.value.googleHome?.hardware?.model;
      },
    },
  },

  softwareVersion: {
    required: true,
    google: {
      fields: ['device_identity'],
      translate: ({ raw }) =>
        typeof raw?.value?.device_identity?.softwareVersion === 'string' && raw.value.device_identity.softwareVersion.trim() !== ''
          ? processSoftwareVersion(raw.value.device_identity.softwareVersion)
          : undefined,
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['googleHome'],
      translate: ({ raw }) =>
        typeof raw.value.googleHome?.hardware?.softwareVersion === 'string' && raw.value.googleHome.hardware.softwareVersion.trim() !== ''
          ? processSoftwareVersion(raw.value.googleHome.hardware.softwareVersion)
          : undefined,
    },
  },

  // Naming / descriptive fields
  description: {
    required: true,
    google: {
      fields: ['label', 'device_info', 'device_located_settings'],
      related: ['located_annotations'],
      translate: ({ rawData, raw }) => HomeKitDevice.makeValidHKName(buildDeviceDescription(rawData, raw)),
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['googleHome', 'roomId', 'structureId'],
      related: ['home'],
      translate: ({ rawData, raw }) => HomeKitDevice.makeValidHKName(buildDeviceDescription(rawData, raw)),
    },
  },

  // Numeric width/height ratio, independent of the source's current pixel resolution.
  aspect_ratio: {
    google: {
      fields: ['aspect_ratio'],
      translate: ({ raw }) => {
        let width = raw?.value?.aspect_ratio?.widthRelative;
        let height = raw?.value?.aspect_ratio?.heightRelative;
        return Number.isSafeInteger(width) === true && width > 0 && Number.isSafeInteger(height) === true && height > 0
          ? width / height
          : undefined;
      },
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['attributes.cameraStream.aspectRatio'],
      translate: ({ raw }) => {
        let dimensions = raw.value['attributes.cameraStream.aspectRatio']?.properties?.properties;
        let width = dimensions?.find((property) => property.name === 'width')?.value?.number;
        let height = dimensions?.find((property) => property.name === 'height')?.value?.number;
        return Number.isFinite(width) === true && width > 0 && Number.isFinite(height) === true && height > 0 ? width / height : undefined;
      },
    },
  },

  // Core operational fields
  online: {
    required: true,
    google: {
      fields: ['liveness'],
      translate: ({ raw }) => raw?.value?.liveness?.status === 'LIVENESS_DEVICE_STATUS_ONLINE',
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['deviceStatus.online'],
      translate: ({ raw }) =>
        typeof raw.value['deviceStatus.online']?.boolean === 'boolean' ? raw.value['deviceStatus.online'].boolean : undefined,
    },
  },

  streaming_enabled: {
    required: true,
    google: {
      fields: ['recording_toggle'],
      translate: ({ raw }) => raw?.value?.recording_toggle?.currentCameraState === 'CAMERA_ON',
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['onOff.onOff'],
      translate: ({ raw }) => (typeof raw.value['onOff.onOff']?.boolean === 'boolean' ? raw.value['onOff.onOff'].boolean : undefined),
    },
  },

  audio_enabled: {
    required: true,
    google: {
      fields: ['microphone_settings'],
      translate: ({ raw }) => raw?.value?.microphone_settings?.enableMicrophone === true,
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['audioSettings.microphoneEnabled'],
      translate: ({ raw }) =>
        typeof raw.value['audioSettings.microphoneEnabled']?.boolean === 'boolean'
          ? raw.value['audioSettings.microphoneEnabled'].boolean
          : undefined,
    },
  },

  has_microphone: {
    required: true,
    google: {
      fields: ['microphone_settings'],
      translate: ({ raw }) => raw?.value?.microphone_settings?.enableMicrophone === true,
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['cameraStream.audioCommunicationType', 'audioSettings.microphoneEnabled'],
      translate: ({ raw }) =>
        ['HDX', 'FDX'].includes(raw.value['cameraStream.audioCommunicationType']?.text) === true ||
        typeof raw.value['audioSettings.microphoneEnabled']?.boolean === 'boolean'
          ? true
          : undefined,
    },
  },

  has_speaker: {
    required: true,
    google: {
      fields: ['speaker_volume'],
      translate: ({ raw }) => raw?.value?.speaker_volume?.volume !== undefined,
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['cameraStream.audioCommunicationType'],
      translate: ({ raw }) => (['HDX', 'FDX'].includes(raw.value['cameraStream.audioCommunicationType']?.text) === true ? true : undefined),
    },
  },

  has_motion_detection: {
    required: true,
    google: {
      fields: ['observation_trigger_capabilities'],
      translate: ({ raw }) => raw?.value?.observation_trigger_capabilities?.videoEventTypes?.motion?.value === true,
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['entitlement.triggerCapabilities', 'googleHome'],
      translate: ({ raw }) => {
        // Available event types describe capability, independently of enablement.
        let triggers = raw.value['entitlement.triggerCapabilities']?.array?.values;
        return Array.isArray(triggers) === true
          ? triggers.some((trigger) => trigger?.text === 'motionSeen')
          : Array.isArray(raw.value.googleHome?.traits) === true
            ? raw.value.googleHome.traits.includes('action.devices.traits.MotionDetection')
            : undefined;
      },
    },
  },

  speaker_volume: {
    google: {
      fields: ['speaker_volume'],
      translate: ({ raw }) =>
        Number.isFinite(Number(raw?.value?.speaker_volume?.volume)) === true ? Number(raw.value.speaker_volume.volume) : undefined,
    },
  },

  camera_type: {
    google: {
      fields: ['device_identity'],
      translate: ({ raw }) => raw?.value?.device_identity?.vendorProductId,
    },
  },

  streaming_protocols: {
    required: true,
    google: {
      fields: ['streaming_protocol'],
      translate: ({ raw }) =>
        Array.isArray(raw?.value?.streaming_protocol?.supportedProtocols) === true ? raw.value.streaming_protocol.supportedProtocols : [],
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['attributes.cameraStream.cameraStreamSupportedProtocols', 'attributes'],
      translate: ({ raw }) => {
        // Current supported protocols take precedence over pre-migration transport data.
        let supported = raw.value['attributes.cameraStream.cameraStreamSupportedProtocols']?.array?.values;
        if (Array.isArray(supported) !== true) {
          supported = raw.value.attributes?.fields?.cameraStreamSupportedProtocols?.listValue?.values?.map((value) => ({
            text: value.stringValue,
          }));
        }
        return Array.isArray(supported) === true
          ? [
              ...new Set(
                supported
                  .map(
                    (value) =>
                      ({
                        webrtc: STREAMING_PROTOCOL.WEBRTC,
                        nexustalk: STREAMING_PROTOCOL.NEXUSTALK,
                        mpegdash: STREAMING_PROTOCOL.MPEGDASH,
                      })[value.text],
                  )
                  .filter((protocol) => protocol !== undefined),
              ),
            ]
          : undefined;
      },
    },
  },

  nexustalk_host: {
    google: {
      fields: ['streaming_protocol'],
      translate: ({ raw }) =>
        typeof raw?.value?.streaming_protocol?.directHost?.value === 'string' ? raw.value.streaming_protocol.directHost.value : undefined,
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['cameraStream.streamHost'],
      translate: ({ streamHosts }) => streamHosts?.find((property) => property.name === 'nexustalk')?.value?.text,
    },
  },

  mpegdash_url: {
    google: {
      fields: ['streaming_protocol'],
      translate: ({ raw }) =>
        typeof raw?.value?.streaming_protocol?.dashUrl?.value === 'string' ? raw.value.streaming_protocol.dashUrl.value : undefined,
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['cameraStream.streamHost'],
      translate: ({ streamHosts }) => streamHosts?.find((property) => property.name === 'mpegdash')?.value?.text,
    },
  },

  hls_url: {
    google: {
      fields: ['streaming_protocol'],
      translate: ({ raw }) =>
        typeof raw?.value?.streaming_protocol?.hlsUrl?.value === 'string' ? raw.value.streaming_protocol.hlsUrl.value : undefined,
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['cameraStream.streamHost'],
      translate: ({ streamHosts }) => streamHosts?.find((property) => property.name === 'hlsmaster')?.value?.text,
    },
  },

  migrating: {
    google: {
      fields: ['camera_migration_status'],
      translate: ({ raw }) =>
        raw?.value?.camera_migration_status?.state?.progress !== undefined &&
        raw.value.camera_migration_status.state.progress !== 'PROGRESS_COMPLETE' &&
        raw.value.camera_migration_status.state.progress !== 'PROGRESS_NONE',
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['migration.legacyCameraMigrationStatus'],
      translate: ({ raw }) => {
        let status = raw.value['migration.legacyCameraMigrationStatus']?.text;
        return status === 'succeeded' ? false : undefined;
      },
    },
  },

  battery_level: {
    google: {
      fields: ['battery_power_source'],
      translate: ({ raw }) =>
        Number.isFinite(Number(raw?.value?.battery_power_source?.remaining?.remainingPercent?.value)) === true
          ? Math.round(scaleValue(Number(raw.value.battery_power_source.remaining.remainingPercent.value), 0, 1, 0, 100))
          : undefined,
    },
    prefer: 'googlehome',
    googlehome: {
      fields: ['charging.capacityRemainingPercentage', 'charging.descriptiveCapacityRemaining'],
      translate: ({ raw }) => {
        let level = raw.value['charging.capacityRemainingPercentage']?.number;
        if (typeof level === 'number' && Number.isFinite(level) === true && level >= 0 && level <= 100) {
          return Math.round(level);
        }
        let capacity = raw.value['charging.descriptiveCapacityRemaining']?.text;
        let levels = { full: 100, high: 75, medium: 50, low: LOW_BATTERY_LEVEL, critically_low: Math.floor(LOW_BATTERY_LEVEL / 2) };
        return Object.hasOwn(levels, capacity) === true ? levels[capacity] : undefined;
      },
    },
  },
};

// Translate each physical camera once, using field-map preference and cached source data.
export function processRawData(log, rawData, config, deviceType = undefined, changedData = undefined, extraFieldMap = undefined) {
  if (
    rawData === null ||
    typeof rawData !== 'object' ||
    rawData.constructor !== Object ||
    config === null ||
    typeof config !== 'object' ||
    config.constructor !== Object
  ) {
    return;
  }

  let devices = {};
  let cameras = new Map();
  let fieldMap = { ...CAMERA_FIELD_MAP, ...(extraFieldMap?.constructor === Object ? extraFieldMap : {}) };
  for (let [objectKey, raw] of Object.entries(rawData)) {
    let homeGraph = raw?.source === DATA_SOURCE.HOMEGRAPH;
    let device = raw?.value?.googleHome;
    if (
      homeGraph === true
        ? ['action.devices.types.CAMERA', 'action.devices.types.DOORBELL'].includes(device?.type) !== true ||
          device.id?.thirdPartyId?.idType?.startsWith('nest') !== true
        : raw?.source !== DATA_SOURCE.PROTOBUF ||
          objectKey.startsWith('DEVICE_') !== true ||
          [...PROTOBUF_RESOURCES.CAMERA, ...PROTOBUF_RESOURCES.DOORBELL, ...PROTOBUF_RESOURCES.FLOODLIGHT].includes(
            raw?.value?.device_info?.typeName,
          ) !== true
    ) {
      continue;
    }
    let serial = homeGraph === true ? raw.value.technicalInformation?.serialNumber : raw.value.device_identity?.serialNumber;
    if (typeof serial !== 'string' || serial.trim() === '') {
      continue;
    }
    serial = serial.trim().toUpperCase();
    let homeId =
      homeGraph === true
        ? getResourceKey(raw.connection, raw.source, raw.value.structureId, 'STRUCTURE')
        : raw.value.device_info?.pairerId?.resourceId;
    let lightId =
      homeGraph === true && typeof raw.value.floodlightId === 'string'
        ? getResourceKey(raw.connection, raw.source, raw.value.floodlightId)
        : undefined;
    let camera = cameras.get(serial) ?? {
      context: createMappingContext(rawData, objectKey),
      fields: new Set(),
      changed: changedData instanceof Map !== true,
    };
    cameras.set(serial, camera);
    // Dependency changes trigger translation; field preference chooses values independently.
    camera.changed = camera.changed === true || [objectKey, homeId, lightId].some((id) => changedData?.has?.(id) === true);
    let home = rawData[homeId];
    let light = rawData[lightId];
    if (homeGraph === true) {
      if (home?.source !== DATA_SOURCE.HOMEGRAPH || home.connection !== raw.connection) {
        continue;
      }
      // The linked light must belong to this camera's account/home and Nest provider.
      if (
        light?.source !== DATA_SOURCE.HOMEGRAPH ||
        light.connection !== raw.connection ||
        light.value?.structureId !== raw.value.structureId ||
        light.value?.googleHome?.type !== 'action.devices.types.LIGHT' ||
        light.value.googleHome.id?.thirdPartyId?.idType?.startsWith('nest') !== true
      ) {
        light = undefined;
      }
    } else {
      let protocols = raw.value.streaming_protocol?.supportedProtocols;
      let ready = raw.value.configuration_done?.deviceReady;
      // Legacy Quartz devices can omit readiness only for NexusTalk with a usable host.
      let legacy =
        Array.isArray(protocols) === true &&
        protocols.includes(STREAMING_PROTOCOL.NEXUSTALK) === true &&
        protocols.includes(STREAMING_PROTOCOL.WEBRTC) === false &&
        typeof raw.value.streaming_protocol?.directHost?.value === 'string' &&
        raw.value.streaming_protocol.directHost.value.trim() !== '' &&
        (ready === undefined || ready === true);
      if (
        home === undefined ||
        Array.isArray(protocols) !== true ||
        ((protocols.includes(STREAMING_PROTOCOL.WEBRTC) !== true ||
          (ready !== true && raw.value.camera_migration_status?.state?.where !== 'MIGRATED_TO_GOOGLE_HOME')) &&
          legacy !== true)
      ) {
        continue;
      }
    }
    let source = homeGraph === true ? 'googlehome' : 'google';
    camera.context.sources[source] = normaliseSourceContext(source, objectKey, raw, {
      homeId,
      light,
      streamHosts: raw.value['cameraStream.streamHost']?.properties?.properties,
    });
    for (let field of Object.keys(raw.value)) {
      camera.fields.add(field);
    }
  }

  for (let [serial, camera] of cameras) {
    if (camera.changed !== true) {
      continue;
    }
    try {
      let result = buildMappedObject(fieldMap, camera.context, camera.fields);
      if (
        result.data.serialNumber === undefined ||
        (typeof deviceType === 'string' && deviceType !== '' && result.data.type !== deviceType)
      ) {
        continue;
      }
      let tempDevice = { manufacturer: 'Nest', ...result.data };
      if (result.hasRequired === true) {
        // Check for any device or home configuration options that match this device
        // We'll use the serial number to match against device options, and the home uuid to match against home options
        let deviceOptions = config?.devices?.find(
          (device) => device?.serialNumber?.toUpperCase?.() === tempDevice?.serialNumber?.toUpperCase?.(),
        );
        let homeOptions = config?.homes?.find(
          (home) =>
            home?.protobuf_home_uuid?.toUpperCase?.() === tempDevice?.nest_google_home_uuid?.toUpperCase?.() ||
            home?.homegraph_home_uuid?.toUpperCase?.() === tempDevice?.nest_google_home_uuid?.toUpperCase?.(),
        );

        // Insert any extra options we've read in from configuration file for this device
        tempDevice.eveHistory =
          deviceOptions?.eveHistory !== undefined ? deviceOptions.eveHistory === true : config.options?.eveHistory === true;
        tempDevice.doorbellCooldown = parseDurationToSeconds(deviceOptions?.doorbellCooldown, { defaultValue: 60, min: 0, max: 300 });
        tempDevice.motionCooldown = parseDurationToSeconds(deviceOptions?.motionCooldown, { defaultValue: 60, min: 0, max: 300 });
        tempDevice.ffmpeg = {
          binary: config.options.ffmpeg.binary,
          valid: config.options.ffmpeg.valid === true,
          debug: deviceOptions?.ffmpegDebug === true || config.options?.ffmpeg.debug === true,
          hwaccel:
            (deviceOptions?.ffmpegHWAccel === true || config.options?.ffmpegHWAccel === true) &&
            config.options.ffmpeg.valid === true &&
            config.options.ffmpeg.hwaccel === true,
          transcode:
            (deviceOptions?.ffmpegTranscode === true || config.options?.ffmpegTranscode === true) && config.options.ffmpeg.valid === true,
        };
        // Live-view capacity comes from normalized configuration, independently of HKSV recording.
        tempDevice.maxStreams = config.options?.maxStreams ?? 2;
        tempDevice.logMotionEvents =
          deviceOptions?.logMotionEvents !== undefined
            ? deviceOptions.logMotionEvents === true
            : config.options?.logMotionEvents === false
              ? false
              : true;

        // Process additional exclusion details
        tempDevice.excluded =
          deviceOptions?.exclude === true ||
          (deviceOptions?.exclude !== false &&
            (homeOptions?.exclude === true || (homeOptions?.exclude !== false && config?.options?.exclude === true)));
      }
      devices[serial] = { full: result.hasRequired, data: result.hasRequired === true ? tempDevice : result.data };
    } catch (error) {
      log?.error?.('Error processing camera data for "%s": %s', serial, String(error));
    }
  }
  return devices;
}
