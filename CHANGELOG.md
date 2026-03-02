# Change Log

All notable changes to `homebridge-nest-accfactory` will be documented in this file. This project tries to adhere to [Semantic Versioning](http://semver.org/).

### Known Issues

- The ip npm package has a known security advisory [GHSA-2p57-rm9w-gvfp](https://github.com/advisories/GHSA-2p57-rm9w-gvfp); this is used indirectly via the werift library
- Some newer Nest/Google cameras may use different video sizes or shapes, causing the video to look slightly cropped or not fill the screen correctly.
- HomeKit Secure Video (HKSV) can be enabled on battery powered cameras, which will significantly reduce battery life

## v0.3.10 (xxxx/xx/xx)

- General code cleanup and stability improvements
- Fixed an issue affecting live view and HKSV recording on migrated Nest/Google cameras
- Fixed an issue affecting audio talkback on some older migrated Nest/Google cameras

## v0.3.9 (2026/02/18)

- General code cleanup and stability improvements
- Fixed remaining issues with snapshot handling on some Nest/Google cameras
- Added strict checks to ensure the ffmpeg binary includes all required libraries for streaming from Nest/Google cameras, as per `README.md`
- Added battery level reporting for Nest/Google battery powered cameras (experimental)
- Updated `README.md` with a recommendation for a pre-built ffmpeg binary option
- Refined thermostat mode and temperature adjustments from the Home app

## v0.3.8 (2026/02/06)

- General code cleanup and stability improvements
- Fixed WebRTC streaming issues when a home does not contain any devices [@benbean303](https://github.com/benbean303)
- Fixed an issue where snapshots could appear empty on some Nest/Google cameras.
- Added support for Nest Cam Outdoor (2nd gen, wired)
- Added support for Nest Doorbell (3rd gen, wired)

## v0.3.7 (2025/12/17)

This marks the final release of 2025. A huge thank you to everyone who’s used the plugin, reported issues, tested changes, and contributed feedback throughout the year. Your support genuinely helps shape the project.

- Fixed parsing of time values in the configuration file [@currybeast](https://github.com/currybeast)
- Added support for Nest Cam Indoor (3rd gen, wired)
- Added support for Nest Doorbell (2nd gen, wired)
- Added support for Nest Thermostat (3rd gen v2)
- Updated `README.md` with instructions to obtain Google issueToken and cookie using Safari (the only supported method)
- Refined repetitive connection status logging to only appear in debug mode [@MorelloCherry](https://github.com/MorelloCherry)

## v0.3.6 (2025/12/01)

- General code cleanup and stability improvements for Homebridge 2.0 compatibility
- Fixed an issue where hot water temperature control was not exposed for certain Nest Heat Link configurations [@josdegroot] (https://github.com/josdegroot)
- Added support for a new `"homes"` section in `config.json` to enable per-home configuration options
- Updated `README.md` with documentation for the new `"homes"` configuration section (`./README.md#homes`)
- Updated `README.md` to clarify Google authentication requirements, including that the required cookie **should start with `SIDCC=`**
- Removed the deprecated `"elevation"` device-specific configuration option

## v0.3.5 (2025/11/21)

- General code cleanup and stability improvements
- Fixed battery level reporting for Nest Thermostat (2020) 
- Updated instructions for obtaining access token for Nest accounts
- Updated instructions for obtaining issue token and cookie for Google accounts  
- Updated disclaimer in `README.md` to clarify support for official Homebridge installations only
- Added debug logging for thermostat mode and temperature changes received from outside of HomeKit [@MorelloCherry](https://github.com/MorelloCherry)

## v0.3.4 (2025/10/17)

- General code cleanup and stability improvements  
- General typo and grammar corrections  
- Fixed handling of the per-device `"hksv"` setting  
- Fixed thermostat cooling stage 3 checking  
- Fixed thermostat fan state checking
- Fixed periodic camera snapshots when camera is turned off
- Updated camera resource assets

## v0.3.3 (2025/08/23)

- Refined timeout warnings for camera and doorbell snapshot capture  
- Fixed video feed on/off control for HKSV-enabled cameras  
- Fixed battery percentage and transition state reporting for Nest × Yale Locks  
- Fixed handling of the global `"exclude"` device setting  
- Fixed support for `~` (home directory) in the `"ffmpegPath"` option  
- Fixed fan-related errors for Nest Thermostats  
- Improved authorisation handling: Nest/Google login will no longer retry repeatedly on `Unauthorized` or `Forbidden` responses  
- Fans that support only a single speed will now expose **only On/Off**, without the `RotationSpeed` control

### Thanks
Special thanks to [@Edwin](https://github.com/DigitalFokus) for testing and feedback on refinements to Nest X Yale support!

## v0.3.2 (2025/08/09)

- Now Homebridge Verified
- Refactored core to use the updated base class
- Refactored plugins for better codebase separation
- General code cleanup and improved stability
- Improved camera streaming and HKSV recording
- Initial support for video hardware acceleration during recording
- Initial support for Nest x Yale locks (more testing needed)
- Fixed missing audio on newer Nest/Google cameras
- Fixed missing Nest/Google cameras after Google Home migration
- Fixed startup errors caused by invalid thermostat temperature settings
- Fixed doorbell notifications
- Fixed EveHome integration (history recording)
- Fixed interference from other `undici`/`fetch` instances in Homebridge
- Fixed issue when setting device properties via Nest API
- Added support for hot water temperature control on compatible EU/UK thermostats — [see README](./README.md#devices)
- Removed support for using Nest Heat Link devices as room temperature sensors
- Removed standalone Docker version

### Thanks
Special thanks to [@Daniel](https://github.com/no1knows), [@Matthew](https://github.com/mphyde), [@Erik](https://github.com/esille), [@Neil](https://github.com/BertrumUK) and [@Guy](https://github.com/grhall) for testing and feedback on this release!
 
## v0.3.1 (2025/06/16)

- Minor stability improvements affecting standalone docker version

## v0.3.0 (2025/06/14)

- General code cleanup and stability improvements
- Introduced plugin-style architecture for Nest/Google devices
- Updated `README.md` to reflect changes to the `"devices"` section in configuration
- Prevent excluded devices from being restored from Homebridge cache
- Added internal support for selecting active temperature sensor (not yet exposed to HomeKit)
- Fixed loss of custom devices section when using the plugin config UI
- Fixed motion services being recreated when restored from Homebridge cache
- Fixed missing devices for Nest FieldTest accounts
- Added hot water heating boost (on/off) support for compatible EU/UK Thermostats
- Added support for Nest Heat Link devices as room temperature sensors

### Deprecation Notice
- Support for the standalone Docker version of this plugin is planned to be deprecated in an upcoming release. While it currently remains functional, future updates may no longer include Docker-specific build support. Users are encouraged to transition to standard Homebridge installations where possible.

### Known Issues

- Audio from newer Nest/Google cameras and doorbells is currently silent (blank audio output)
- The ip npm package has a known security advisory [GHSA-2p57-rm9w-gvfp](https://github.com/advisories/GHSA-2p57-rm9w-gvfp); this is used indirectly via the werift library

### Thanks
Special thanks to [@Daniel](https://github.com/no1knows) and [@Brad](https://github.com/bcullman) for testing and feedback on this release!

## v0.2.11 (2025/04/17)

- General code cleanup and bug fixes

## v0.2.9 (2025/03/23)

- General code cleanup and bug fixes
- Support for Nest Protect(s) in Google Home app
- Default location to check for ffmpeg binary is now `/usr/local/bin`
- Logs Nest Protect(s) self testing status

## v0.2.5 (2024/12/10)

- Fix for dropped sub modules.. Do not know why!

## v0.2.4 (2024/12/10)

- Fix for camera video stream when audio disabled

## v0.2.3 (2024/12/06)

- General code cleanup and bug fixes
- Fix for HomeKit Secure Video recording for migrated camera/doorbell to Google Home

## v0.2.2 (2024/10/05)

- Improved handling of configuration file with docker/standalone version
- Warning about the use of legacy configuration options with docker/standalone version

## Known Issues

- Audio from newer Nest/Google camera/doorbell devices is still blank
- npm package [ip](https://github.com/advisories/GHSA-2p57-rm9w-gvfp) has severity issue. This is being used in external library (werift)

## v0.2.1 (2024/10/05)

- HomeKit support for multiple speeds on thermostat(s)
- Audio library in docker release went walkabout. Added back in

## Known Issues

- Audio from newer Nest/Google camera/doorbell devices is still blank
- npm package [ip](https://github.com/advisories/GHSA-2p57-rm9w-gvfp) has severity issue. This is being used in external library (werift)

## v0.2.0 (2024/10/04)

## Breaking Change

Unfortunately, from version **0.2.0**, I've made some breaking changes in the code to help move forward with the project. 
So, what does this mean for you, the end user.
1) You'll need to remove all previously discovered devices from HomeKit before adding them back in after upgrading to this version
2) If using Homebridge version, remove any cached acccesory data associated with this plug-in
3) If using docker/standalone version, remove the 'persist' folder
4) Re-add devices to HomeKit once version upgraded
5) Any HomeKit Secure Video recordings will be lost
6) Will need to re-configure camera streaming and notification options
6) Any automations will need to be re-created in HomeKit
7) History in EveHome app will be lost

Apologies for this change, as I can understand what an inconvience and frustration it will be :-(

## Changes

- General code cleanup and bug fixes
- Common configuration between Homebridge plug-in and docker/standalone versions
- Seemlessly allow Nest/Google devices to be migrated between Nest <-> Google Home apps

## Known Issues

- Audio from newer Nest/Google camera/doorbell devices is still blank
- npm package [ip](https://github.com/advisories/GHSA-2p57-rm9w-gvfp) has severity issue. This is being used in external library (werift)


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
