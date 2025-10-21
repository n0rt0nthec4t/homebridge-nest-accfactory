<p align="center">
  <a href="https://homebridge.io"><img src="https://raw.githubusercontent.com/homebridge/branding/latest/logos/homebridge-color-round-stylized.png" height="140"></a>
</p>
<span align="center">

# Nest Accfactory

[![npm](https://badgen.net/npm/v/homebridge-nest-accfactory/latest)](https://www.npmjs.com/package/homebridge-nest-accfactory)
[![npm](https://badgen.net/npm/dt/homebridge-nest-accfactory?label=downloads)](https://www.npmjs.com/package/homebridge-nest-accfactory)
[![verified-by-homebridge](https://badgen.net/badge/homebridge/verified/purple)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

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
* Nest HeatLinks
* Nest x Yale Locks (more testers required)

**Note:** Google has announced it will discontinue support for 1st and 2nd generation Nest Thermostats as of **October 25, 2025**.  
Based on their stated intentions, these models are expected to stop functioning with this Homebridge plugin after that date.

The accessory supports connection to Nest using a Nest account AND/OR a Google (migrated Nest account) account.

## Configuration

### Nest Account

If you have a **Nest Account**, you’ll need to obtain an **access token** from the Nest web app.

1. Go to [home.nest.com](https://home.nest.com) and click **Sign in with Nest**.  
2. After logging in, open [home.nest.com/session](https://home.nest.com/session).  
3. You’ll see a JSON string similar to:  
   ```json
   {"2fa_state":"enrolled","access_token":"XXX", ...}
4. Copy the value of **access_token** near the start (a long string beginning with `b`) and paste it into your Homebridge configuration.  
   - Ignore any other `access_token` entries further down the string.

**Note:** Do **not** log out of [home.nest.com](https://home.nest.com), as this will invalidate your credentials.

### Obtaining a Google cookie token for a Google Account (Safari)

Google Accounts require an **"issueToken"** and **"cookie"**, which are unique to your account. You only need to do this once as long as you stay logged into your Google Account.

1. Open Safari in a **Private Window**  
2. Enable the **Develop Menu** (Safari ▸ Settings ▸ Advanced ▸ check *Show Develop menu in menu bar*)  
3. Open **Develop ▸ Show Web Inspector**, then select the **Network** tab  
4. Ensure **Preserve Log** is checked  
5. In the filter box, type **issueToken**  
6. Go to [home.nest.com](https://home.nest.com) and click **Sign in with Google**  
7. After login, click the **iframerpc** network request  
8. In **Headers**, copy:  
   - **Request URL** - this is your **Issue Token**  
   - **cookie:** value under *Request Headers* - this is your **Cookie**  
9. Enter both into your Homebridge configuration  

**Note:** Do **not** log out of [home.nest.com](https://home.nest.com), as this will invalidate your credentials.

## config.json configuration

When using the plugin configuration with [homebridge-config-ui-x](https://github.com/homebridge/homebridge-config-ui-x), the config.json will be updated/generated with the configuration options available via the web-form. Additional options can be specified in the config.json directly.

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
    "devices": [
        {
            "serialNumber": "XXXXXXXX",
            "exclude": false
        },
        {
            "serialNumber": "YYYYYYYY",
            "hksv": true
        }
    ],
    "platform": "NestAccfactory"
}
```

#### options

The following options are available in the config.json options object. These apply to all discovered devices.

| Name               | Description                                                                                  | Default        |
|--------------------|----------------------------------------------------------------------------------------------|----------------|
| elevation          | Height above sea level for the weather station                                               | 0              |
| eveHistory         | Provide history in EveHome application where applicable                                      | true           |
| exclude            | Exclude ALL devices                                                                          | false          |
| ffmpegDebug        | Turns on specific debugging output for when ffmpeg is invoked                                | false          |
| ffmpegHWaccel      | Enable video hardware acceleration for supported camera(s) and doorbell(s)                   | false          |  
| ffmpegPath         | Path to an ffmpeg binary (looks for binary named `ffmpeg` in path)                           | /usr/local/bin |
| hksv               | Enable HomeKit Secure Video for supported camera(s) and doorbell(s)                          | false          |
| weather            | Virtual weather station for each Nest/Google home we discover                                | false          |

#### devices

The following options are available on a per-device level in the `config.json` `devices` array. Each device is specified as a JSON object, and the device is identified using the `"serialNumber"` key with the value of its serial number (in uppercase).

| Name               | Description                                                                                  | Default        |
|--------------------|----------------------------------------------------------------------------------------------|----------------|
| chimeSwitch        | Create a switch for supported doorbell(s) which allows the indoor chime to be turned on/off  | false          |
| doorbellCooldown   | Time in seconds between doorbell press events                                                | 60             |
| elevation          | Height above sea level for the specific weather station                                      | 0              |
| eveHistory         | Provide history in EveHome application where applicable for the specific device              | true           |
| exclude            | Exclude the device                                                                           | false          |
| fanDuration        | Override fan runtime duration                                                                |                |
| ffmpegDebug        | Turns on specific debugging output for when ffmpeg is invoked                                | false          |
| ffmpegHWaccel      | Enable video hardware acceleration for supported camera(s) and doorbell(s)                   | false          |
| hksv               | Enable HomeKit Secure Video for supported camera(s) and doorbell(s)                          | false          |
| hotwaterBoostTime  | Time in seconds for hotwater boost heating (30, 160, 120mins)                                | 30mins         |
| hotwaterMaxTemp    | Maximum supported temperature for hotwater heating                                           | 70c            |
| hotwaterMinTemp    | Minimum supported temperature for hotwater heating                                           | 30c            |
| humiditySensor     | Create a separate humidity sensor for supported thermostat(s)                                | false          |
| localAccess        | Use direct access to supported camera(s) and doorbell(s) for video streaming and recording   | false          |
| motionCooldown     | Time in seconds between detected motion events                                               | 60             |
| personCooldown     | Time in seconds between detected person events                                               | 120            |
| serialNumber       | Device serial number to which these settings belong to                                       |                |

## ffmpeg

To support streaming and recording from cameras, an ffmpeg binary needs to be present. We have specific requirements, which are:
- version 6.0 or later
- compiled with:
  - libx264
  - libfdk-aac
  - libspeex
  - libopus

By default, we look in /usr/local/bin for an ffmpeg binary, however, you can specify a specific ffmpeg binary to use via the configuration option 'ffmpegPath'

## Disclaimer

This is a personal hobby project, provided "as-is," with no warranty whatsoever, express or implied, including but not limited to warranties of merchantability or fitness for a particular purpose. Building and running this project is done entirely at your own risk.

This plugin is only supported when used with **official Homebridge installations**.  
Other platforms or forks such as **HOOBS**, **Home Assistant**, or similar derivatives are **not officially supported** and may not function as intended.

Please note that I am not affiliated with any companies, including but not limited to Google, Apple, or any other entities. The author of this project shall not be held liable for any damages or issues arising from its use.  

If you encounter a problem with the source code, please [raise an issue](https://github.com/n0rt0nthec4t/homebridge-nest-accfactory/issues) on the project's **GitHub repository** so it can be reviewed and investigated.
