# Change Log

All notable changes to `homebridge-nest-accfactory` will be documented in this file. This project tries to adhere to [Semantic Versioning](http://semver.org/).

### alpha

Currently all releases are considered 'alpha' status, where things may or may not be working. Use at your own risk :-)

## v0.0.4 (alpha)

- Camera/Doorbell support for snapshots and live video re-introduced
- HomeKit Secure Video recording support re-introduced
- Should support Nest Thermostat 4th Gen (untested)
- *might* have finally resolved audio sync issues for both live and recording
- Depending on the libraries present in ffmpeg binary, we limit functionality for camera/doorbells
    - missing libspeex = no two-way audio
    - missing libfdk_aac = no audio
    - missing libx264 = no streaming/recording

## v0.0.1 (2024-08-27)

- Inital re-coding from Nest_accfactory code base. These projects will now share a common code base
- Camera/Doorbell support currently removed will re-worked