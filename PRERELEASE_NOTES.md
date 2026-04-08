# Pre-release Notes

All notable pre-release changes to `homebridge-nest-accfactory` are documented here.  
Entries are specific to individual alpha and beta releases and are not cumulative.  
This project tries to adhere to [Semantic Versioning](http://semver.org/).

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