# Change Log

All notable changes to `homebridge-nest-accfactory` will be documented in this file. This project tries to adhere to [Semantic Versioning](http://semver.org/).

### alpha

Currently all releases are considered 'alpha' status, where things may or may not be working. Use at your own risk :-)

## v0.1.9 (alpha)

- General code cleanup and bug fixes
- Aligned version numbering to old Nest_accfactory repo
- Audio talkback support for newer Nest/Google camera/doorbell devices
- Fixed issue with camera/doorbell devices between migrated to/fro between Nest and Google Home on docker/standalone

## v0.0.7 (alpha)

- General code cleanup and bug fixes
- Updated streaming/recording support for newer Nest/Google camera/doorbell devices
    - No incoming audio, just video stream

## v0.0.6 (2024-09-14)

- Fix for two/way audio starting on non-enabled HKSV camera/doorbells

## v0.0.5 (2024-09-13)

- General code cleanup and bug fixes
- External dependancy reductions, dropped pbf and axios libraries
- Nest Cam with Floodlight support with light on/off and brightness control
- Fixed issued with setting range temperatures on Nest Thermostat(s)

## v0.0.4 (2024-09-07)

- Camera/Doorbell support for snapshots and live video re-introduced
- HomeKit Secure Video recording support re-introduced
- Should support Nest Thermostat 4th Gen (untested)
- *might* have finally resolved audio sync issues with live video and recording
- Depending on the libraries present in ffmpeg binary, we limit functionality for camera/doorbells
    - missing libspeex = no two-way audio
    - missing libfdk_aac = no audio
    - missing libx264 = no streaming/recording
- Cleanup fix for when removing a camera/doorbell from Nest/Google
- Fix for virtual weather device when missing configured city and/or state details
- Fix for retrieving data from Nest systems when using both a Nest and Google accounts
- Initial support for newer Nest/Google camera/doorbell devices (streaming/recording - coming)

## v0.0.1 (2024-08-27)

- Inital re-coding from Nest_accfactory code base. These projects will now share a common code base
- Camera/Doorbell support currently removed will re-worked