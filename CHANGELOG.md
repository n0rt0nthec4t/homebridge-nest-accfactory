# Change Log

All notable changes to `homebridge-nest-accfactory` will be documented in this file. This project tries to adhere to [Semantic Versioning](http://semver.org/).

## Breaking changes v0.2.0+

Unfornunately, from version **0.2.0**, I've made some breaking changes in the code to help move forward with the project. 
So, what does this mean for you, the end user.
1) You'll need to remove all previously discovered devices from HomeKit before adding them back in after upgrading to this version
2) If using Homebridge version, remove any cached acccesory data associated with this plug-in
3) If using docker/standalone version, remove the 'persist' folder
4) Re-add devices to HomeKit once version upgraded
5) Any HomeKit Secure Video recordings will be lost
6) Will need to re-configure camera streaming and notification options
6) Any automations will need to be re-created in HomeKit
7) History in EveHome app will be lost

Appologies for this change, as I can understand what an inconvience and frustration it will be :-(

## Known Issues

- Audio from newer Nest/Google camera/doorbell devices is still blank
- npm package [ip](https://github.com/advisories/GHSA-2p57-rm9w-gvfp) has severity issue. This is being used in external library (werift)

## v0.2.0 (alpha)

- General code cleanup and bug fixes
- Common configuration between Homebridge plug-in and docker/standalone versions
- Seemlessly allow Nest/Google devices to be migrated between Nest <-> Google Home apps

## v0.1.9 (alpha)

- General code cleanup and bug fixes
- Aligned version numbering to old Nest_accfactory repo
- Audio talkback support for newer Nest/Google camera/doorbell devices

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