<p align="center">
  <a href="https://homebridge.io"><img src="https://raw.githubusercontent.com/homebridge/branding/latest/logos/homebridge-color-round-stylized.png" height="140"></a>
</p>
<span align="center">

# Nest Accfactory

[![npm](https://badgen.net/npm/v/homebridge-nest-accfactory/latest)](https://www.npmjs.com/package/homebridge-nest-accfactory)
[![npm](https://badgen.net/npm/dt/homebridge-nest-accfactory?label=downloads)](https://www.npmjs.com/package/homebridge-nest-accfactory)

</span>

Formally known as [Nest_accfactory](https://github.com/n0rt0nthec4t/Nest_accfactory), this is a Homebridge plugin I have developed to allow Nest devices to be used with HomeKit including having support for HomeKit Secure Video on doorbells and camera devices

Building and maintaining this project takes time, effort, and resources. If you find it valuable, please consider sponsoring to support its development and future improvements. Your support makes a difference—thank you!

## Supported Devices

The following Nest devices are known to be supported

* Nest Thermostats (1st gen, 2nd gen, 3rd gen, E, 2020 mirror edition, 4th gen)
* Nest Protects (1st and 2nd gen)
* Nest Temp Sensors (1st gen)
* Nest Cameras (Cam Indoor, IQ Indoor, Outdoor, IQ Outdoor, Cam with Floodlight)
* Nest Doorbells (wired 1st gen)

The accessory supports connection to Nest using a Nest account OR a Google (migrated Nest account) account.

## Configuration

### Nest Account

If you have a Nest account, you will need to obtain an access token from the Nest web app. Simply go to https://home.nest.com in your browser and log in. Once that's done, go to https://home.nest.com/session in your browser, and you will see a long string that looks like this:

{"2fa_state":"enrolled","access_token":"XXX", ...}

The value of "access_token" near the start of the string (the XXX) (a long sequence of letters, numbers and punctuation beginning with b) can be entered into the plugin-configuration within Homebridge

There may be other keys labelled access_token further along in the string - please ignore these.

**Do not log out of home.nest.com, as this will invalidate your credentials. Just close the browser tab**

### Obtaining a Google cookie token for a Google Account

Google Accounts require an "issueToken" and "cookie". The values of "issueToken" and "cookies" are specific to your Google Account. To get them, follow these steps (only needs to be done once, as long as you stay logged into your Google Account).

1. Open a Chrome browser tab in Incognito Mode (or clear your cache).
2. Open Developer Tools (View/Developer/Developer Tools).
3. Click on 'Network' tab. Make sure 'Preserve Log' is checked.
4. In the 'Filter' box, enter issueToken
5. Go to home.nest.com, and click 'Sign in with Google'. Log into your account.
6. One network call (beginning with iframerpc) will appear in the Dev Tools window. Click on it.
7. In the Headers tab, under General, copy the entire Request URL (beginning with https://accounts.google.com). This is your "Issue Token" which can be entered into the plugin-configuration within Homebridge.
9. In the 'Filter' box, enter oauth2/iframe
10. Several network calls will appear in the Dev Tools window. Click on the last iframe call.
11. In the Headers tab, under Request Headers, copy the entire cookie (include the whole string which is several lines long and has many field/value pairs - do not include the cookie: name). This is your "Cookie" which can be entered into the plugin-configuration within Homebridge.

**Do not log out of home.nest.com, as this will invalidate your credentials. Just close the browser tab**

## config.json configuration

When using the plugin configuration using [homebridge-config-ui-x](https://github.com/homebridge/homebridge-config-ui-x), the config.json will be updated/generated with the configuration options available via the web-form. Additional options can be specified in the config.json directly.

Sample config.json entries below
```
{
    "nest": {
        "access_token": "<nest access token>",
        "fieldTest": false
    },
    "google": {
        "issuetoken": "<google issue token>",
        "cookie": "<google cookie>",
        "fieldTest": false
    },
    "options": {
        "eveHistory": true,
        "weather": true,
        "elevation": 600,
        "hksv": false
    },
    "devices": {
        "XXXXXXXX": {
            "exclude": false
        },
        "YYYYYYYY" : {
            "hksv" : true
        }
    },
    "platform": "NestAccfactory"
}
```

#### options

The following options are available in the config.json options object. These apply to all discovered devices.

| Name              | Description                                                                                   | Default    |
|-------------------|-----------------------------------------------------------------------------------------------|------------|
| elevation         | Height above sea level for the weather station                                                | 0          |
| eveHistory        | Provide history in EveHome application where applicable                                       | true       |
| ffmegDebug        | Turns on specific debugging output for when ffmpeg is envoked                                 | false      |
| ffmegPath         | Path to an ffmpeg binary for us to use. Will look in current directory by default             |            |
| hksv              | Enable HomeKit Secure Video for supported camera(s) and doorbell(s)                           | false      |
| maxStreams        | Maximum number of concurrent video streams in HomeKit for supported camera(s) and doorbell(s) | 2          |
| weather           | Virtual weather station for each Nest/Google home we discover                                 | false      |

#### devices

The following options are available on a per-device level in the config.json devices object. The device is specified by using its serial number (in uppercase)

| Name              | Description                                                                                   | Default    |
|-------------------|-----------------------------------------------------------------------------------------------|------------|
| chimeSwitch       | Create a switch for supported doorbell(s) which allows the indoor chime to be turned on/off   | false      |
| doorbellCooldown  | Time in seconds between doorbell press events                                                 | 60         | 
| elevation         | Height above sea level for the specific weather station                                       | 0          |
| eveHistory        | Provide history in EveHome application where applicable for the specific device               | true       |
| exclude           | Exclude the device                                                                            | false      |
| hksv              | Enable HomeKit Secure Video for supported camera(s) and doorbell(s)                           | false      |
| humiditySensor    | Create a seperate humidity sensor for supported thermostat(s)                                 | false      |
| localAccess       | Use direct access to supported camera(s) and doorbell(s) for video streaming and recording    | false      |    
| motionCooldown    | Time in seconds between detected motion events                                                | 60         |
| personCooldown    | Time in seconds between detected person events                                                | 120        |

## ffmpeg

**As of 3/10/2024, the [Homebridge Docker Image](https://hub.docker.com/r/homebridge/homebridge) includes an ffmpeg binary meeting our requirements. Its located in /usr/local/bin/ffmpeg**

To support streaming and recording from cameras, an ffmpeg binary needs to be present. We have specific requirements, which are:
- version 6.0 or later
- compiled with:
  - libx264
  - libfdk-aac
  - libspeex
  - libopus

By default, we look in the current directory where the plug-in excutes for an ffmpeg binary, however, you can specify a specific ffmpeg binary to use via the configuration option 'ffmpegPath'

## Disclaimer

This is a personal hobby project, provided "as-is," with no warranty whatsoever, express or implied, including but not limited to warranties of merchantability or fitness for a particular purpose. Building and running this project is done entirely at your own risk.

Please note that I am not affiliated with any companies, including but not limited to Google, Apple, or any other entities. The author of this project shall not be held liable for any damages or issues arising from its use. If you do encounter any problems with the source code, feel free to reach out, and we can discuss possible solutions
