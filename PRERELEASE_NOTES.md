# Pre-release Notes

All notable pre-release changes to `homebridge-nest-accfactory` are documented here.  
Entries are specific to individual alpha and beta releases and are not cumulative.  
This project tries to adhere to [Semantic Versioning](http://semver.org/).

## v0.4.3-alpha.3 (2026/05/13)

### Changed

- `webrtc.js`
  - Increased WebRTC audio playout delay to improve tolerance of transport jitter before PCM is handed to `Streamer`
  - Relaxed WebRTC audio hard-resync thresholds so delayed callbacks do not create avoidable short silence-fill gaps
  - Changed audio silence fill so empty queue ticks are not treated as gaps unless RTP-derived timing shows audio is actually due
  - Added WebRTC audio micro-gap tolerance so small timestamp holes are absorbed by queued real audio instead of immediately inserting blank PCM
  - Added sustained audio-starvation recovery that reconnects only when audio fill persists while video remains active
  - Added a small video RTP reorder window before H264 FU-A assembly so delayed fragments and RTX recovery can arrive before incomplete frames are abandoned
  - Added an extra young FU-A timestamp-switch guard at the drop point to avoid abandoning very recent non-keyframe fragments
  - Normalised recovered RTX packets into the original RTP sequence path before H264 packet parsing
  - Preserved original RTP receive time through the video reorder buffer so emitted source media timestamps are not biased by packet hold time
  - Added a keyframe request in-flight guard so repeated PLI requests cannot stack during recovery

- `streamer.js`
  - Slightly increased live stream playout delay to smooth small transport jitter without changing recording playout behaviour
  - Added adaptive live playout delay so `Streamer` can absorb temporary source jitter and relax back toward lower latency after stable output
  - Added transport media-quality counters to support dumps for audio fill, video reorder recovery, keyframe requests, video drops, and reconnect reasons

- `streamtransport.js`
  - Added shared transport diagnostics counters for media-quality and reconnect-reason tracking
  - Tightened emitted media-frame metadata normalisation before frames are passed to `Streamer`

- `nexustalk.js`
  - Added transport video-drop accounting when an oversized pending NexusTalk frame is reset

- `plugins/camera.js`
  - Tightened the camera/streamer boundary so camera setup now centralises Streamer and transport construction
  - Awaited Streamer teardown when migration or streaming protocol changes require replacing the active streamer

## v0.4.3-alpha.2 (2026/05/13)

### Changed

- `streamer.js`
  - Reworked the media pipeline to use a shared `MediaTimeline` for retained media buffering and indexed playback
  - Added independent video/audio cursors per output session to improve live stream pacing and prevent audio starvation behind bursty video delivery
  - Improved live camera stream pacing to reduce bursty delivery into ffmpeg
  - Ensured media timestamps strictly advance when an upstream source repeats or regresses timestamps
  - Added catch-up handling for lagging outputs to recover smoothly without excessive burst playback
  - Added decoder-safe startup handling with optional keyframe gating for recording outputs
  - Added automatic SPS/PPS bootstrap injection for H264 outputs before first keyframe when required
  - Avoided writing an extra H264 start code for video already normalised to Annex-B before output
  - Adjusted live audio/video drain limits to reduce small audio pauses when video frames arrive in bursts
  - Decoupled live output audio/video cursors so due audio is not pinned behind capped or bursty video output
  - Added support dump diagnostics for:
    - source media arrival gaps
    - output write gaps
    - output catch-up behaviour
    - audio blocked behind capped video output
  - Added transport abstraction layer support via `StreamTransport` for protocol-specific stream backends

- `mediatimeline.js`
  - Added shared ordered media timeline implementation for retained camera media
  - Added media-specific indexes for video, audio, and keyframes to improve lookup performance
  - Added efficient decoder-safe keyframe discovery for new live and recording sessions
  - Improved retention trimming using protected output cursors

- `streamtransport.js`
  - Added new shared transport base class for camera streaming backends
  - Standardised transport lifecycle handling (`connecting`, `ready`, `reconnecting`, `closed`)
  - Added shared codec metadata reporting and media statistics collection
  - Added unified transport-to-streamer media interface for complete audio/video frame delivery

- `webrtc.js`
  - Refactored WebRTC streaming to use the new `StreamTransport` architecture
  - Requested a startup keyframe after the incoming video SSRC is known so WebRTC live streams do not wait for the natural keyframe cadence
  - Allowed slower startup keyframe assembly and delayed decoder-ready output until SPS/PPS parameter sets are available
  - Added a small paced audio playout queue with bounded silence fill so short WebRTC RTP callback gaps do not starve ffmpeg audio input
  - Added runtime transport update support for refreshed OAuth2 credentials and Google Home device UUID changes
  - Improved internal stream recovery and transport lifecycle handling

- `nexustalk.js`
  - Refactored NexusTalk streaming to use the new `StreamTransport` architecture
  - Added runtime transport update support for refreshed access tokens, Nest/Google device UUID changes, NexusTalk host updates, and Google authentication mode changes
  - Improved NexusTalk host-change handling so active sessions reconnect cleanly when the backend redirects or changes host
  - Always request AAC audio from NexusTalk to keep the upstream media profile aligned with the ffmpeg input pipeline
  - Improved offline/unreachable camera handling so `ERROR_LEAF_NODE_CANNOT_REACH_CAMERA` no longer causes rapid reconnect loops
  - Improved separation between transport responsibilities and HomeKit-facing stream output

- `plugins/camera.js`
  - Refactored camera stream setup to inject protocol transports (`WebRTC` / `NexusTalk`) into the shared `Streamer` pipeline
  - Added dynamic transport updates for API access changes without recreating streamer instances
  - Added support for passing shared API access configuration into transport backends
  - Reserved prepared live-stream UDP ports until session cleanup to prevent local port reuse between simultaneous viewers and talkback paths
  - Improved migration handling when switching between Nest and Google Home streaming backends

## v0.4.2-beta.4 (2026/05/11)

- `plugins/protect.js`
  - Fixed Nest Protect `wired_or_battery` translation so `0` is treated as wired and `1` as battery
  - Added `StatusActive` and `StatusFault` handling to the carbon monoxide service to mirror the smoke service
  - Split smoke and carbon monoxide fault reporting so each service uses its own component self-test result while still faulting when the Protect is offline or expired
  - Improved Google API Protect heat/temperature mapping using the temperature fault trait instead of PIR motion data
  - Fixed Google API Protect safety summary failure parsing for smoke, CO, and temperature self-test status

- `config.schema.json` / `config.js`
  - Fixed Homebridge UI-X config validation warnings caused by optional blank Home/Device placeholder rows
  - Tightened account validation so blank Google/Nest credential fields are rejected
  - Ignored placeholder Home/Device override rows at runtime unless they include a home name or device serial number

## v0.4.2-beta.3 (2026/05/10)

- Follow-up beta after `v0.4.2-beta.2` was unpublished.

- `HomeKitDevice`
  - Fixed partial `.UPDATE` payload handling so updates such as refreshed camera API credentials are merged with existing device data before validation
  - Prevents auth-only updates from being dropped when they do not include required full device metadata fields

- `plugins/camera.js`
  - Forwarded updated camera auth/host details to already-created streamer instances
  - Fixes active NexusTalk/WebRTC streams continuing to use stale credentials after token refresh

- `system.js`
  - Injected camera API auth details before initial camera/doorbell/floodlight accessory setup so streaming backends receive credentials during first construction

## v0.4.2-beta.2 (2026/05/10)

> This version was unpublished due to issues identified after release.

- `plugins/heatlink.js`
  - Fixed EveHome GET message handling for Heat Link history/status payloads

- `connections.js`
  - Added a dedicated connection manager for Nest/Google account runtime state, authorisation, token refresh, retry scheduling, gRPC transport ownership, and snapshot waiter cleanup
  - Moved runtime connection building out of `config.js`; configuration processing now stays focused on validation/defaulting
  - Excluded accounts are now filtered during connection creation and are not stored in runtime connection state
  - Consolidated initial authorisation, retry backoff, and token refresh into a single lifecycle timer per connection

- `system.js`
  - Wired platform startup to the new `Connections` manager after Homebridge has finished loading
  - Removed inline account authorisation and reconnect handling from the platform manager
  - Tightened subscribe/observe loop rescheduling so stale in-flight requests cannot restart loops after shutdown
  - Quietened duplicate Google camera activity-history timeout logging by treating gRPC request timeouts as no recent events

## v0.4.2-beta.1 (2026/05/09)

This beta focuses on thermostat and Heat Link control-path fixes. Please test thermostat setpoint changes and any systems with optional fan, humidifier, dehumidifier, or hot water controls.

- `plugins/*.js`
  - Aligned device plugins description/name generation with shared device naming handling

- `plugins/thermostat.js`
  - Fixed HomeKit `TargetTemperature` writes so heat mode updates the Nest heating setpoint and cool mode updates the Nest cooling setpoint
  - Improved dynamic fan setup so newly-added fan services use the incoming device state during update processing
  - Improved dynamic humidifier/dehumidifier setup so newly-added services and threshold characteristics use the incoming device state
  - Added/removes humidifier and dehumidifier threshold characteristics when capabilities change after startup
  - Updated humidity control valid values when humidifier/dehumidifier capabilities change

- `plugins/heatlink.js`
  - Added dynamic HomeKit service handling for hot water temperature and hot water boost capability changes
  - Hot water temperature control now appears only when usable temperature data is available
  - Newly-added hot water services now initialise from the incoming device state during update processing

- Recommended beta testing
  - Verify heat mode setpoint changes stick after HomeKit/Home app changes
  - Verify cool mode setpoint changes stick where cooling is supported
  - Verify range/auto heat and cool thresholds still behave correctly
  - Verify fan speed controls appear only where supported
  - Verify humidifier/dehumidifier threshold controls appear and disappear correctly
  - Verify Heat Link hot water temperature and boost controls appear only when supported

## v0.4.0-beta.16 (2026/04/26)

- Standardised device description and location handling across all device types for improved HomeKit naming consistency, resulting in cleaner and more user-friendly accessory names

- `plugins/*`
  - Added support for `whereLabel.literal` in Google protobuf data as primary location source
  - Improved fallback handling to use `whereAnnotationRid` when literal labels are not present
  - Added case-insensitive de-duplication between description and location to prevent duplicate names (e.g. "Front Door - Front Door")
  - Refined device-specific location handling:
    - Thermostat, Protect, Heat Link, Temperature Sensors: use room (`where`) only
    - Camera/Doorbell: prefer room (`where`) with optional fixture fallback
    - Locks: prefer fixture (door) naming with room as secondary context where applicable
  - Ensured consistent string handling using safe `String(...).trim()` patterns across description translators

- `grpctransport.js`
  - Introduced structured gRPC result handling with `status`, `message`, `code`, and `error` fields
  - Improved transport error classification and timeout detection
  - Normalised gRPC trailer handling to expose server status codes via `code`
  - Added consistent error propagation for decode, handler, and transport failures
  - Improved debug logging to include status, code, message, and frame counts for easier troubleshooting

## v0.4.0-beta.15 (2026/04/24)

- Replaced `isNaN(...)` checks with `Number.isFinite(Number(...))` across the code base for stricter numeric validation

- `system.js`
  - Added validation of restored cached accessories during startup
  - Invalid or incomplete accessories are now removed from cache to prevent stale state issues

- `plugins/camera.js`
  - Added back missing `Active` characteristic back to motion sensor, as got dropped during recoding (required for HKSV recording)
  - Fixes recordings not triggering after plugin restart
  - Refined camera online/offline transitions to ensure correct buffering and recording behaviour

## v0.4.0-beta.14 (2026/04/22)

Perhaps 13 is an unlucky number? I broke some things :-( Thanks to [@marving11](https://github.com/marving11) for catching these.

- `webrtc.js`
  - Fixed WebRTC connection gating issues causing premature connect aborts
  - Removed dependency on `SOURCE_CONNECTING` for async flow control

- `plugins/camera.js`
  - Fixed streaming protocol detection for non-migrated devices
  - Updated migration logic to use `migrating !== true` instead of strict `false`
  - Improved handling of Nest <-> Google migration states
  - Minor translation logic refinements

## v0.4.0-beta.13 (2026/04/21)

- `nexustalk.js`
  - Fixed re-authorisation handling (use reconnect flow instead of inline reauth)
  - Fixed reconnect race condition with `streamer.js`

- `streamer.js`
  - Refinements to playout buffer
  - Prevented stale video frames from previous sessions affecting new stream state on reconnect

- `thermostat.js`
  - Removed OccupancySensor service from thermostat devices

- `plugins/homeaway.js`
  - Added Home/Away accessory exposing structure occupancy as an OccupancySensor

- `system.js`
  - Minor code fixes

- `plugins/tempsensor.js`
  - Added generation values to temperature sensors [@mtcislak-max](https://github.com/mtcislak-max)

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
