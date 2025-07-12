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
import { fileURLToPath } from 'node:url';

// Define our modules
import HomeKitDevice from '../HomeKitDevice.js';
import Streamer from '../streamer.js';
import NexusTalk from '../nexustalk.js';
import WebRTC from '../webrtc.js';
import FFmpeg from '../ffmpeg.js';

// Define constants
const CAMERA_RESOURCE = {
  OFFLINE: 'Nest_camera_offline.jpg',
  OFF: 'Nest_camera_off.jpg',
  TRANSFER: 'Nest_camera_transfer.jpg',
};
const MP4BOX = 'mp4box';
const SNAPSHOT_CACHE_TIMEOUT = 30000; // Timeout for retaining snapshot image (in milliseconds)
const STREAMING_PROTOCOL = {
  WEBRTC: 'PROTOCOL_WEBRTC',
  NEXUSTALK: 'PROTOCOL_NEXUSTALK',
};
const RESOURCE_PATH = '../res';
const __dirname = path.dirname(fileURLToPath(import.meta.url)); // Make a defined for JS __dirname

export default class NestCamera extends HomeKitDevice {
  static TYPE = 'Camera';
  static VERSION = '2025.07.10'; // Code version

  // For messaging back to parent class (Doorbell/Floodlight)
  static SET = HomeKitDevice.SET;
  static GET = HomeKitDevice.GET;

  controller = undefined; // HomeKit Camera/Doorbell controller service
  streamer = undefined; // Streamer object for live/recording stream
  motionServices = undefined; // Object of Camera/Doorbell motion sensor(s)
  batteryService = undefined; // If a camera has a battery <-- todo
  operatingModeService = undefined; // Link to camera/doorbell operating mode service
  personTimer = undefined; // Cooldown timer for person/face events
  motionTimer = undefined; // Cooldown timer for motion events
  snapshotEvent = undefined; // Event for which to get snapshot for
  ffmpeg = undefined; // FFMpeg object class

  // Internal data only for this class
  #liveSessions = new Map(); // Track active HomeKit live stream sessions (port, crypto, rtpSplitter)
  #recordingConfig = {}; // HomeKit Secure Video recording configuration
  #cameraImages = {}; // Snapshot resource images
  #snapshotTimer = undefined; // Timer for cached snapshot images
  #lastSnapshotImage = undefined; // JPG image buffer for last camera snapshot

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
      offline: loadImageResource(CAMERA_RESOURCE.OFFLINE, 'offline'),
      off: loadImageResource(CAMERA_RESOURCE.OFF, 'video off'),
      transfer: loadImageResource(CAMERA_RESOURCE.TRANSFER, 'transferring'),
    };

    // Create ffmpeg object if have been told valid binary
    if (typeof this.deviceData?.ffmpeg?.binary === 'string' && this.deviceData?.ffmpeg?.valid === true) {
      this.ffmpeg = new FFmpeg(this.deviceData?.ffmpeg?.binary, log);
    }
  }

  // Class functions
  onAdd() {
    // Setup HomeKit camera controller

    // Need to cleanup the CameraOperatingMode service. This is to allow seamless configuration
    // switching between enabling hksv or not
    // Thanks to @bcullman (Brad Ullman) for catching this
    this.accessory.removeService(this.accessory.getService(this.hap.Service.CameraOperatingMode));
    if (this.controller === undefined) {
      // Establish the "camera" controller here
      this.controller = new this.hap.CameraController(this.generateControllerOptions());
    }
    if (this.controller !== undefined) {
      // Configure the controller thats been created
      this.accessory.configureController(this.controller);
    }

    // Setup motion services
    if (this.motionServices === undefined) {
      this.createCameraMotionServices();
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
            this.set({
              uuid: this.deviceData.nest_google_uuid,
              irled_enabled: value === true ? 'auto_on' : 'always_off',
            });

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

    // Extra setup details for output
    this.deviceData.hksv === true &&
      this.postSetupDetail('HomeKit Secure Video support' + (this.streamer?.isBuffering() === true ? ' and recording buffer started' : ''));
    this.deviceData.localAccess === true && this.postSetupDetail('Local access');
    this.deviceData.ffmpeg.hwaccel === true && this.postSetupDetail('Video hardware acceleration');
  }

  async onUpdate(deviceData) {
    if (typeof deviceData !== 'object' || this.controller === undefined) {
      return;
    }

    if (this.deviceData.migrating === false && deviceData.migrating === true) {
      // Migration happening between Nest <-> Google Home apps. We'll stop any active streams, close the current streaming object
      this?.log?.warn?.('Migration between Nest <-> Google Home apps has started for "%s"', deviceData.description);
      this.streamer !== undefined && this.streamer.stopAllStreams();
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
        this.streamer !== undefined && this.streamer.stopAllStreams();
        this.streamer = undefined;
      }
      if (deviceData.streaming_protocols.includes(STREAMING_PROTOCOL.WEBRTC) === true && WebRTC !== undefined) {
        this?.log?.debug?.('Using WebRTC streamer for "%s"', deviceData.description);
        this.streamer = new WebRTC(this.uuid, deviceData, {
          log: this.log,
        });
      }

      if (deviceData.streaming_protocols.includes(STREAMING_PROTOCOL.NEXUSTALK) === true && NexusTalk !== undefined) {
        this?.log?.debug?.('Using NexusTalk streamer for "%s"', deviceData.description);
        this.streamer = new NexusTalk(this.uuid, deviceData, {
          log: this.log,
        });
      }
      if (
        this?.streamer?.isBuffering() === false &&
        deviceData?.hksv === true &&
        this?.controller?.recordingManagement?.recordingManagementService !== undefined &&
        this.controller.recordingManagement.recordingManagementService.getCharacteristic(this.hap.Characteristic.Active).value ===
          this.hap.Characteristic.Active.ACTIVE
      ) {
        await HomeKitDevice.message(this.uuid, Streamer.MESSAGE, Streamer.MESSAGE_TYPE.START_BUFFER);
      }
    }

    // Check to see if any activity zones were added for both non-HKSV and HKSV enabled devices
    if (
      Array.isArray(deviceData.activity_zones) === true &&
      JSON.stringify(deviceData.activity_zones) !== JSON.stringify(this.deviceData.activity_zones)
    ) {
      deviceData.activity_zones.forEach((zone) => {
        if (this.deviceData.hksv === false || (this.deviceData.hksv === true && this.ffmpeg instanceof FFmpeg === true && zone.id === 1)) {
          if (this.motionServices?.[zone.id]?.service === undefined) {
            // Zone doesn't have an associated motion sensor, so add one
            let zoneName = zone.id === 1 ? '' : zone.name;
            let eveOptions = zone.id === 1 ? {} : undefined; // Only link EveHome for zone 1

            let tempService = this.addHKService(this.hap.Service.MotionSensor, zoneName, zone.id, eveOptions);

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
          if (
            this.motionTimer === undefined &&
            (this.deviceData.hksv === false || this.ffmpeg instanceof FFmpeg === false || this.streamer === undefined)
          ) {
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
              this.history(this.motionServices[zoneID].service, {
                status: 1,
              });
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
                this.history(this.motionServices[zoneID].service, { status: 0 });
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
            if (this.deviceData.hksv === false || this.ffmpeg instanceof FFmpeg === false || this.streamer === undefined) {
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

  onRemove() {
    // Clean up our camera object since this device is being removed
    clearTimeout(this.motionTimer);
    clearTimeout(this.personTimer);
    clearTimeout(this.#snapshotTimer);
    this.motionTimer = undefined;
    this.personTimer = undefined;
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
    Object.values(this.motionServices).forEach((service) => {
      service.updateCharacteristic(this.hap.Characteristic.MotionDetected, false);
      this.accessory.removeService(service);
    });

    // Remove the camera controller
    this.accessory.removeController(this.controller);

    // Clear references
    this.operatingModeService = undefined;
    this.#liveSessions = undefined;
    this.motionServices = undefined;
    this.streamer = undefined;
    this.controller = undefined;
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

    if (
      this.motionServices?.[1]?.service !== undefined &&
      this.motionServices[1].service.getCharacteristic(this.hap.Characteristic.MotionDetected).value === false
    ) {
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
          ? ['-thread_queue_size', '512', '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:3']
          : this.streamer.codecs.audio === Streamer.CODEC_TYPE.AAC
            ? ['-thread_queue_size', '512', '-f', 'aac', '-i', 'pipe:3']
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
      'ffmpeg process for recording stream from "%s" will be called using the following commandline',
      this.deviceData.description,
      commandLine.join(' ').toString(),
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
          // We dont have enough data in the buffer yet to process the full mp4 box
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
      if (signal !== 'SIGKILL' || signal === null) {
        this?.log?.error?.('ffmpeg recording process for "%s" stopped unexpectedly. Exit code was "%s"', this.deviceData.description, code);
      }

      // Ensure generator wakes up and exits
      this.emit(MP4BOX);
      this.removeAllListeners(MP4BOX);
    });

    // Start the appropriate streamer
    let { video, audio } = await HomeKitDevice.message(this.uuid, Streamer.MESSAGE, Streamer.MESSAGE_TYPE.START_RECORD, {
      sessionID: sessionID,
    });

    // Connect the ffmpeg process to the streamer input/output
    video?.pipe?.(ffmpegStream?.stdin); // Streamer video → ffmpeg stdin (pipe:0)
    audio?.pipe?.(ffmpegStream?.stdio?.[3]); // Streamer audio → ffmpeg pipe:3

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
    await HomeKitDevice.message(this.uuid, Streamer.MESSAGE, Streamer.MESSAGE_TYPE.STOP_RECORD, {
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
      await HomeKitDevice.message(this.uuid, Streamer.MESSAGE, Streamer.MESSAGE_TYPE.START_BUFFER);
    }

    if (enableRecording === false && this.streamer.isBuffering() === true) {
      // Stop buffering stream for this camera/doorbell
      await HomeKitDevice.message(this.uuid, Streamer.MESSAGE, Streamer.MESSAGE_TYPE.STOP_BUFFER);
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
      let response = await this.get({ uuid: this.deviceData.nest_google_uuid, camera_snapshot: '' });
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
        }, SNAPSHOT_CACHE_TIMEOUT);
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
      // We'll use the last success snapshop as long as its within a certain time period
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
        // Below is comment out as we don't use hardware acceleration for live streaming
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
        'ffmpeg process for live streaming from "%s" will be called using the following commandline',
        this.deviceData.description,
        commandLine.join(' ').toString(),
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
          'ffmpeg process for talkback on "%s" will be called using the following commandline',
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
      let { video, audio, talkback } = await HomeKitDevice.message(this.uuid, Streamer.MESSAGE, Streamer.MESSAGE_TYPE.START_LIVE, {
        sessionID: request.sessionID,
      });
      // Connect the ffmpeg process to the streamer input/output
      video?.pipe?.(ffmpegStream?.stdin); // Streamer video → ffmpeg stdin (pipe:0)
      audio?.pipe?.(ffmpegStream?.stdio?.[3]); // Streamer audio → ffmpeg pipe:3
      ffmpegTalk?.stdout?.pipe?.(talkback); // ffmpeg talkback stdout → Streamer talkback pipe:1
    }

    if (request.type === this.hap.StreamRequestTypes.STOP && this.#liveSessions.has(request.sessionID)) {
      // Stop the HomeKit stream and cleanup any associated ffmpeg or RTP splitter sessions
      await HomeKitDevice.message(this.uuid, Streamer.MESSAGE, Streamer.MESSAGE_TYPE.STOP_LIVE, {
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
      this?.log?.debug?.('Unsupported reconfiguration request for live stream on "%s"', this.deviceData.description);
    }

    callback?.(); // do callback if defined
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
        if (this.deviceData.hksv === true && this.ffmpeg instanceof FFmpeg === true && zone.id !== 1) {
          continue;
        }

        let zoneName = zone.id === 1 ? '' : zone.name;
        let eveOptions = zone.id === 1 ? {} : undefined; // Only link EveHome for zone 1

        let service = this.addHKService(this.hap.Service.MotionSensor, zoneName, zone.id, eveOptions);
        this.addHKCharacteristic(service, this.hap.Characteristic.Active);
        service.updateCharacteristic(this.hap.Characteristic.Name, zoneName);
        service.updateCharacteristic(this.hap.Characteristic.MotionDetected, false); // No motion initially

        this.motionServices[zone.id] = { service, timer: undefined };
      }
    }
  }

  generateControllerOptions() {
    // Setup HomeKit controller camera/doorbell options

    let resolutions = [
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
      [320, 240, 15], // Apple Watch requires this (plus OPUS @16K)
      [320, 180, 30],
      [320, 180, 15],
    ];

    let profiles = [this.hap.H264Profile.MAIN];
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
        this.deviceData.hksv === true && this.ffmpeg instanceof FFmpeg === true
          ? {
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
        this.deviceData.hksv === true && this.ffmpeg instanceof FFmpeg === true
          ? {
              motion: typeof this.motionServices?.[1]?.service === 'object' ? this.motionServices[1].service : false,
            }
          : undefined,
    };
    return controllerOptions;
  }
}
