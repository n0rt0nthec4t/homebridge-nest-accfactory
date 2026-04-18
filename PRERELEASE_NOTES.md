# Pre-release Notes

All notable pre-release changes to `homebridge-nest-accfactory` are documented here.  
Entries are specific to individual alpha and beta releases and are not cumulative.  
This project tries to adhere to [Semantic Versioning](http://semver.org/).

## v0.4.0-alpha.24 (2026/04/18)

- Fixed re-authorisation issues in `nexustalk.js`
- Implemented a playout smoothing buffer in `streamer.js`
- Fixed notification for authorisation token changes to camera devices

## v0.4.0-alpha.23 (2026/04/16)

- Refactored thermostat, temperature sensor, lock, camera, and protect data processing to use a unified field mapping structure
- Simplified `processRawData()` across modules to align with updated implementation
- Removed cross-device raw data mutation between thermostat and temperature sensor modules
- Temperature sensor now derives associated thermostat directly from thermostat relationships during processing
- Added `active_rcs_sensor_temperature` to thermostat data model and aligned behaviour across Google and Nest APIs
- Thermostat `current_temperature` now consistently reflects the active remote sensor when selected
- Improved handling of partial vs full updates using shared mapping logic
- Reduced complexity and duplication in device processing pipelines
- Improved consistency between Google and Nest data handling
- Cleaner separation of responsibilities between device modules
- More predictable and maintainable data flow
- Relaxed live camera stream startup logic to improve compatibility with older Nest cameras (Hello, Indoor, Outdoor)  
- Live streams now attach directly to the buffer and begin output immediately instead of waiting for a recent keyframe  
- Improves stream startup time and resolves cases where live view would fail to start  
- Recording (HKSV) pipeline unchanged  

## v0.4.0-alpha.22 (2026/04/13)

Due to the volume of changes in this release, versioning has been reverted to alpha

- Reworked stream processing in `streamer.js` using a shared `RingBuffer` to eliminate O(n) buffer shifts and reduce latency  
- Added reusable `RingBuffer` implementation for media queueing  
- Improved live stream startup, catch-up, and playback responsiveness  
- Simplified and stabilised output loop timing for more consistent real-time playback  
- Improved fallback frame handling for missing or delayed video  
- Improved internal tracking of streaming, recording, and buffering state transitions  
- Fixed issue where stream startup details (resolution and FPS) were not always logged in `streamer.js`  

- Refactored WebRTC pipeline in `webrtc.js`  
  - Improved H264 NAL unit handling and FU-A reassembly  
  - Improved RTP packet handling, ordering, and jitter tolerance  
  - Improved stream readiness and startup behaviour  

- Added shared Google gRPC transport for protobuf-based API communication  
  - Centralised HTTP/2 session pooling and lifecycle management  
  - System-level Google API communication now uses HTTP/2 (gRPC)  
  - Improved request/response parsing and validation  
  - Improved error handling and terminal state tracking  

- Integrated gRPC transport into WebRTC (Google Foyer) signaling and control  
- Improved NexusTalk stability and buffering (aligned with new streamer model)  

- Removed `localAccess` device configuration option  
- Fixed configuration schema types (`fanDuration`, `hotwaterBoostTime`, `motionCooldown`, `doorbellCooldown`)  
  [@retuer-commits](https://github.com/retuer-commits)  

- Fixed regression from `0.3.9` where Nest x Yale locks were no longer discovered  
  [@DigitalFokus](https://github.com/DigitalFokus)  

- Small fix in `thermostat.js` for eco mode temperature checks  

- *Testing* direct local WebRTC stream path enabled by default for Google Home cameras (bypassing remote relay where available) in `webrtc.js`  
- *Testing* 15fps default live transcoding output to better match source frame rate in `camera.js`   

## v0.4.0-beta.12 (2026/04/09)

- Updated project dependencies: `protobufjs` and `HomeKitDevice`
- Refined streaming pipeline across `streamer.js`, `nexustalk.js`, and `webrtc.js`
- Adjusted live streaming pacing to improve startup reliability and compatibility with WebRTC sources
- Updated ffmpeg live stream startup in `camera.js` to wait up to 2000ms for the stream source to become ready
- Added `ffmpegTranscode` option (global and per-device, disabled by default) to enable optional video/audio transcoding for live streams
- Refactored snapshot handling to centralise caching and protobuf freshness logic in `system.js`
- Removed per-camera snapshot caching from `camera.js` to simplify the pipeline and avoid duplicate logic
- Improved snapshot responsiveness by prioritising recent cached images over immediate protobuf refreshing

## v0.4.0-beta.11 (2026/04/02)

- Refactored streaming pipeline to use frame-based video/audio handling across WebRTC and NexusTalk
- Updated Streamer to operate as a unified media output layer
- Improved WebRTC RTP handling with basic jitter buffering for smoother playback
- Fixed HomeKit talkback audio reliability issues
- General stability and performance improvements for live streaming and HKSV

## v0.4.0-beta.10 (2026/04/02)

> ⚠️ This release was pulled and is no longer available.

- This version was unpublished due to issues identified after release.

## v0.4.0-beta.9 (2026/04/01)

- Fixed memory leak introduced in `0.4.0-beta.8` affecting long-running camera streams
- Standardised module header documentation across the codebase

## v0.4.0-beta.8 (2026/03/31)

- Refactored NexusTalk and Streamer to use frame-based output instead of packet-based handling
- Improved streaming performance and stability, especially under load (multiple active cameras)
- Optimised output scheduling to skip inactive streamers and reduce CPU usage
- General efficiency improvements across streaming pipeline

## v0.4.0-beta.7 (2026/03/30)

- Added support dump statistics when live streams end for improved troubleshooting
- Introduced detailed streamer metrics (startup timing, packets, drops, outputs, last activity)
- Refined video gating for more reliable keyframe handling and stream startup
- Improved source state tracking and reconnect visibility
- General streaming pipeline refinements and cleanup

## v0.4.0-beta.6 (2026/03/28)

- Main changes are around the video/audio pipelines in `webrtc.js` and `streamer.js` to improve stability and recovery from packet loss, especially for video streams
- Added logging and cleanup around talkback stream handling