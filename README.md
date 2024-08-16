<p align="center">
  <a href="https://homebridge.io"><img src="https://raw.githubusercontent.com/homebridge/branding/latest/logos/homebridge-color-round-stylized.png" height="140"></a>
</p>
<span align="center">

# Homebridge Nest Accfcatory

 <a href="https://www.npmjs.com/package/homebridge-nest-accfactory"><img title="npm version" src="https://badgen.net/npm/v/homebridge-nest-accfcatory" ></a>
  <a href="https://github.com/n0rt0nthec4t/homebridge-nest-accfactory/releases"><img title="version" src="https://img.shields.io/github/release/n0rt0nthec4t/homebridge-nest-accfactory.svg?include_prereleases" ></a>
    <a href="https://github.com/n0rt0nthec4t/homebridge-nest-accfactory/releases"><img title="date" src="https://img.shields.io/github/release-date/n0rt0nthec4t/homebridge-nest-accfactory" ></a>
  <a href="https://github.com/n0rt0nthec4t/homebridge-nest-accfactory/releases"><img title="homebridge version" src="https://img.shields.io/github/package-json/dependency-version/n0rt0nthec4t/homebridge-nest-accfactory/homebridge"> </a>


</span>

Formally known as 'Nest_accfactory', this is a Homebridge plugin I have developed to allow Nest devices to be used with HomeKit including having support for HomeKit Secure Video on doorbells and camera devices

**HomeKit Secure Video Support is disabled by default and needs to be explicitly enabled by the user**

## Supported Devices

The following Nest devices are supported

* Nest Thermostats (Gen 1, Gen 2, Gen 3, E)
* Nest Protects (Gen 1, Gen 2)
* Nest Temp Sensors
* Nest Cameras (Cam Indoor, IQ Indoor, Outdoor, IQ Outdoor)
* Nest Hello (Wired Gen 1)

The accessory supports connection to Nest using a Nest account OR a Google (migrated Nest account) account.

## Configuration

### Nest Account

If you have a Nest account, you will need to obtain an access token from the Nest web app. Simply go to https://home.nest.com in your browser and log in. Once that's done, go to https://home.nest.com/session in your browser, and you will see a long string that looks like this:

{"2fa_state":"enrolled","access_token":"XXX", ...}

The value of "access_token" near the start of the string (the XXX) (a long sequence of letters, numbers and punctuation beginning with b) can be entered into the plugin-configuration within Homebridge

There may be other keys labelled access_token further along in the string - please ignore these.

**Do not log out of home.nest.com, as this will invalidate your credentials. Just close the browser tab**
