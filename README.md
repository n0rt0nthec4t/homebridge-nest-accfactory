<p align="center">
  <a href="https://homebridge.io"><img src="https://raw.githubusercontent.com/homebridge/branding/latest/logos/homebridge-color-round-stylized.png" height="140"></a>
</p>
<span align="center">

# Nest Accfactory


![npm](https://img.shields.io/npm/v/homebridge-nest-accfactory/latest?label=npm%40latest&color=%234CAF50)
![npm](https://img.shields.io/npm/v/homebridge-nest-accfactory/beta?label=npm%40beta&color=%23FF9800)
![npm](https://img.shields.io/npm/v/homebridge-nest-accfactory/alpha?label=npm%40alpha&color=%239E9E9E)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=flat)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

</span>

Formally known as [Nest_accfactory](https://github.com/n0rt0nthec4t/Nest_accfactory), this is a Homebridge plugin I have developed to allow Nest devices to be used with HomeKit including having support for HomeKit Secure Video on doorbells and camera devices

Building and maintaining this project takes time, effort, and resources. If you find it valuable, please consider sponsoring to support its development and future improvements. Your support makes a difference—thank you!

## Supported Devices

The following Nest devices are known to be supported by this Homebridge plugin:

- Nest Thermostats
- Nest Protects
- Nest Temperature Sensors
- Nest Cameras
- Nest Doorbells
- Nest Heat Links
- Nest × Yale Locks

**Note:** Google has discontinued support for 1st and 2nd generation Nest Thermostats as of **October 25, 2025**.  
Based on this, these models are expected to stop functioning with this Homebridge plugin.

The accessory supports connections using a Nest account AND/OR a Google (migrated Nest account) account.

## Configuration

### Obtaining an **access token** for Nest Accounts

If you have a **Nest Account**, you’ll need to obtain an **access token** from the Nest web app.

1. Go to [home.nest.com](https://home.nest.com) and click **Sign in with Nest**.  
2. After logging in, open [home.nest.com/session](https://home.nest.com/session).  
3. You’ll see a JSON string similar to:  
   ```json
   {"2fa_state":"enrolled","access_token":"XXX", ...}
   ```
4. Copy the value of **access_token** near the start (a long string beginning with `b`) and paste it into your Homebridge configuration.  
   - Ignore any other `access_token` entries further down the string.

**Note:** Do **not** log out of [home.nest.com](https://home.nest.com), as this will invalidate your credentials.

### Obtaining an **issueToken and cookie token** for Google Accounts (Safari method)

Google Accounts require an **"issueToken"** and **"cookie"**, which are unique to your account. You only need to do this once as long as you stay logged into your Google Account.

1. Open Safari in a **Private Window**  
2. Enable the **Develop Menu** (Safari ▸ Settings ▸ Advanced ▸ check *Show features for web developers*)  
3. Open **Develop ▸ Show Web Inspector**, then select the **Network** tab  
4. Ensure **Preserve Log** is checked  
5. In the filter box, type **issueToken**  
6. Go to [home.nest.com](https://home.nest.com) and click **Sign in with Google**  
7. After login, click the **iframerpc** network request  
8. In **Headers**, copy:  
   - **Summary ▸ URL** this is your **issueToken**  
   - **Request ▸ Cookie:** this is your **cookie**, which must include a key starting with **`SIDCC=`** (if `SIDCC` is missing, the cookie is incomplete and authentication will fail)
9. Enter both into your Homebridge configuration  

**Important:** Tokens **must** be obtained using **Safari**. Other browsers (Chrome, Edge, Firefox, etc.) do not reliably generate valid or non-expiring `issueToken` and `cookie` values and will often result in authentication failures or token expiry.  
If you did not use Safari, re-capture the tokens using Safari.

**Note:** Do **not** log out of [home.nest.com](https://home.nest.com), as this will invalidate your credentials.

## Account Configuration

The plugin now supports **multiple Nest and Google accounts**.

Accounts are configured using the `"accounts"` array in `config.json`.  
Each entry defines the account name, account type, and authentication tokens.

Supported account types:

- **Nest** — requires an `access_token`
- **Google** — requires both `issueToken` and `cookie`

Each account entry may also optionally enable `fieldTest` for testing Nest API endpoints.

## config.json configuration

When using the plugin configuration with [homebridge-config-ui-x](https://github.com/homebridge/homebridge-config-ui-x), the config.json will be updated/generated with the configuration options available via the web-form. Additional options can be specified in the config.json directly.

Sample config.json entries below
```
{
    "accounts": [
        {
            "name": "Nest",
            "type": "nest",
            "access_token": "<nest access token>",
            "fieldTest": false
        },
        {
            "name": "Google",
            "type": "google",
            "issueToken": "<google issue token>",
            "cookie": "<google cookie>",
            "fieldTest": false
        }
    ],
    "options": {
        "eveHistory": true,
        "debug": false
    },
    "homes": [
        {
            "name": "Main Home",
            "elevation": 321,
            "weather": true
        }
    ],
    "devices": [
        {
            "serialNumber": "XXXXXXXX",
            "name", "XXXXX Device",
            "exclude": false
        },
        {
            "serialNumber": "YYYYYYYY",
            "name", "YYYYY Device",
            "humiditySensor": true
        }
    ],
    "platform": "NestAccfactory"
}
```

#### options

The following options are available in the `config.json` `"options"` object. These apply to all discovered devices and homes.

| Name               | Description                                                                                  | Default        |
|--------------------|----------------------------------------------------------------------------------------------|----------------|
| debug              | Enable plugin verbose logging (independent of Homebridge debug setting)                      | false          |
| elevation          | Height above sea level for weather station(s)                                                | 0              |
| eveHistory         | Provide history in EveHome application where applicable                                      | true           |
| exclude            | Exclude all device(s)                                                                        | false          |
| ffmpegDebug        | Enable additional debugging output when ffmpeg is invoked                                    | false          |
| ffmpegHWaccel      | Enable video hardware acceleration for supported camera(s) and doorbell(s)                   | false          |
| ffmpegPath         | Path to an ffmpeg binary (defaults to `ffmpeg` in system path)                               | /usr/local/bin |
| logMotionEvents    | Enable logging of motion events for camera(s), doorbell(s) and Nest Protect device(s)        | true           |
| supportDump        | Enable Support Dump logging of raw Nest and Google API data                                  | false          |

#### devices

Device-specific configuration can be applied using the `"devices"` array. Each entry represents **per-device settings** that are applied when a device with the matching `"serialNumber"` is discovered.

Some options (such as `exclude`, `eveHistory` and `logMotionEvents`) override the global defaults defined in the `"options"` section. Other settings are device-specific and enable or control features available for that particular device type.

The **Device Settings** section in the Homebridge GUI provides basic management of these entries. However, **not all device options are exposed in the GUI**, and some advanced options may need to be configured directly in `config.json`.

Devices are identified using their **serial number**, which must match the value reported by the Nest or Google API. This value is **case-sensitive and must be in uppercase**.

The `"name"` field is optional and is only used to help identify the entry in the configuration. It does **not** rename the device in HomeKit.

| Name               | Description                                                                                  | Default        |
|--------------------|----------------------------------------------------------------------------------------------|----------------|
| chimeSwitch        | Enable a switch to control the indoor doorbell chime                                         | false          |
| doorbellCooldown   | Time between doorbell press events                                                           | 60s            |
| eveHistory         | Provide history in EveHome application where applicable for this device                      | true           |
| exclude            | Exclude this device                                                                          | false          |
| fanDuration        | Fan runtime duration                                                                         |                |
| ffmpegDebug        | Enable additional debugging output when ffmpeg is invoked                                    | false          |
| ffmpegHWaccel      | Enable video hardware acceleration for supported camera(s) and doorbell(s)                   | false          |
| hotwaterBoostTime  | Duration for hot water boost heating (30, 60, 120 mins)                                      | 30mins         |
| hotwaterMaxTemp    | Maximum supported temperature for hot water heating                                          | 70c            |
| hotwaterMinTemp    | Minimum supported temperature for hot water heating                                          | 30c            |
| humiditySensor     | Enable a separate humidity sensor for supported thermostat(s)                                | false          |
| localAccess        | Enable direct access for supported camera(s) and doorbell(s) streaming and recording         | false          |
| logMotionEvents    | Enable logging of motion events for camera(s), doorbell(s) and Nest Protect device(s)        | true           |
| motionCooldown     | Time between detected motion events                                                          | 60s            |
| name               | Optional label to help identify this device entry                                            |                |
| serialNumber       | Device serial number this configuration applies to                                           |                |

#### homes

Home settings are configured using the `"homes"` array in `config.json` or via the GUI **Home Settings** section.

Each entry in the `"homes"` array applies settings to a specific Nest or Google Home.

Homes are identified using the `"name"` field, which must match the Home name shown in the Nest or Google Home app. This match is **case-sensitive**.

| Name               | Description                                                                                  | Default        |
|--------------------|----------------------------------------------------------------------------------------------|----------------|
| elevation          | Height above sea level for the weather station                                               | 0              |
| name               | Name of home (from Nest/Google App) to which these settings belong to                        |                |
| weather            | Virtual weather station for this Home                                                        | false          |

## ffmpeg

To support streaming and recording from cameras, an ffmpeg binary needs to be present. We have specific requirements, which are:
- version 6.0 or later
- compiled with:
  - libx264
  - libfdk-aac
  - libspeex
  - libopus

By default, we look in /usr/local/bin for an ffmpeg binary, however, you can specify a specific ffmpeg binary to use via the configuration option 'ffmpegPath'

A pre-compiled ffmpeg binary that meets these requirements is available from the **ffmpeg-for-homebridge** project and may be used as an alternative to building ffmpeg yourself.

## HomeKit Secure Video (HKSV)

From version **0.4.0**, **HomeKit Secure Video (HKSV)** is always enabled for supported Nest cameras and doorbells.

This plugin streams video directly to HomeKit and allows recordings to be stored in **iCloud** using Apple’s HKSV infrastructure.

### Important Notes

- HKSV being enabled **does not mean cameras record continuously by default**.
- Recording behaviour is controlled **entirely within the Apple Home app**.
- By default, cameras are typically configured as **Stream Only** until recording is enabled in HomeKit.

### Motion Events and Recording

Nest / Google cameras expose **general motion events** to this plugin for recording triggers.

Because of this, the plugin can only trigger HKSV recordings using **general motion detection** from the Nest / Google API.

HomeKit Secure Video may still analyse recorded footage using its own processing, but the plugin does **not** act on person, vehicle, animal, or package-specific trigger events from the Nest / Google API.

This means recording is triggered by **general motion events only**, rather than by individual event types exposed directly by the camera API..

### Camera Streaming

Camera live streaming and HKSV recording require a compatible **ffmpeg** binary with the features described in the section above.

## Support Policy

This plugin is developed and tested specifically for **Homebridge**.

Supported environments include Homebridge installations running on common platforms such as Linux or macOS, as well as official container or image distributions such as **docker-homebridge**, **homebridge-vm-image**, and **homebridge-raspbian-image**.

Platforms that bundle, modify, or wrap Homebridge — such as **HOOBS**, **Home Assistant**, or similar derivatives are **not officially supported** and may behave differently. Issues reported from these environments may be closed without investigation.

If you encounter a problem, please [raise an issue](https://github.com/n0rt0nthec4t/homebridge-nest-accfactory/issues) on the project's **GitHub repository**.

When reporting an issue, providing relevant diagnostic information (logs, configuration snippets, device details, etc.) and being available to assist with follow-up testing is greatly appreciated. Issues reported without sufficient detail may be difficult to investigate.

Feature requests and enhancements are welcome, but please keep in mind that this is a personal open-source project maintained in spare time.

## Disclaimer

This is a personal hobby project provided **"as-is"**, with no warranty whatsoever, express or implied, including but not limited to warranties of merchantability or fitness for a particular purpose.

Building and running this project is done entirely at your own risk.

I am not affiliated with any companies such as Google, Apple, or other related entities. The author of this project shall not be held liable for any damages or issues arising from its use.

If you find this project useful, sponsorship to support ongoing development is always appreciated.
