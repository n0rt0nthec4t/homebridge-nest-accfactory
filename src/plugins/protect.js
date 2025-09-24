// Nest Protect
// Part of homebridge-nest-accfactory
//
// Mark Hulskamp
'use strict';

// Define our modules
import HomeKitDevice from '../HomeKitDevice.js';
import { processCommonData, scaleValue } from '../utils.js';

// Define constants
import { LOW_BATTERY_LEVEL, DATA_SOURCE, PROTOBUF_RESOURCES, DEVICE_TYPE } from '../consts.js';

export default class NestProtect extends HomeKitDevice {
  static TYPE = 'Protect';
  static VERSION = '2025.09.08'; // Code version

  batteryService = undefined;
  smokeService = undefined;
  motionService = undefined;
  carbonMonoxideService = undefined;

  // Class functions
  onAdd() {
    // Setup the smoke sensor service if not already present on the accessory
    this.smokeService = this.addHKService(this.hap.Service.SmokeSensor, '', 1, {
      messages: this.message.bind(this),
      EveSmoke_lastalarmtest: this.deviceData.latest_alarm_test,
      EveSmoke_alarmtest: this.deviceData.self_test_in_progress,
      EveSmoke_heatstatus: this.deviceData.heat_status,
      EveSmoke_hushedstate: this.deviceData.hushed_state,
      Evesmoke_statusled: this.deviceData.ntp_green_led_enable,
      EveSmoke_smoketestpassed: this.deviceData.smoke_test_passed,
      EveSmoke_heattestpassed: this.deviceData.heat_test_passed,
    });
    this.smokeService.setPrimaryService();

    this.addHKCharacteristic(this.smokeService, this.hap.Characteristic.StatusActive);
    this.addHKCharacteristic(this.smokeService, this.hap.Characteristic.StatusFault);

    // Setup the carbon monoxide service if not already present on the accessory
    this.carbonMonoxideService = this.addHKService(this.hap.Service.CarbonMonoxideSensor, '', 1);

    // Setup battery service if not already present on the accessory
    this.batteryService = this.addHKService(this.hap.Service.Battery, '', 1);
    this.batteryService.setHiddenService(true);

    // Setup motion service if not already present on the accessory and Nest protect is a wired version
    if (this.deviceData?.wired_or_battery === 0) {
      this.motionService = this.addHKService(this.hap.Service.MotionSensor, '', 1);
      this.postSetupDetail('With motion sensor');
    }
  }

  onRemove() {
    this.accessory.removeService(this.smokeService);
    this.accessory.removeService(this.carbonMonoxideService);
    this.accessory.removeService(this.batteryService);
    this.accessory.removeService(this.motionService);
    this.smokeService = undefined;
    this.carbonMonoxideService = undefined;
    this.batteryService = undefined;
    this.motionService = undefined;
  }

  onUpdate(deviceData) {
    if (
      typeof deviceData !== 'object' ||
      this.smokeService === undefined ||
      this.carbonMonoxideService === undefined ||
      this.batteryService === undefined
    ) {
      return;
    }

    // Update battery level and status
    this.batteryService.updateCharacteristic(this.hap.Characteristic.BatteryLevel, deviceData.battery_level);
    this.batteryService.updateCharacteristic(
      this.hap.Characteristic.StatusLowBattery,
      deviceData.battery_level > LOW_BATTERY_LEVEL && deviceData.battery_health_state === 0
        ? this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
        : this.hap.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW,
    );
    this.batteryService.updateCharacteristic(this.hap.Characteristic.ChargingState, this.hap.Characteristic.ChargingState.NOT_CHARGEABLE);

    // Update smoke details
    // If protect isn't online, replacement date past, report in HomeKit
    this.smokeService.updateCharacteristic(
      this.hap.Characteristic.StatusActive,
      deviceData.online === true && Math.floor(Date.now() / 1000) <= deviceData.replacement_date,
    );

    this.smokeService.updateCharacteristic(
      this.hap.Characteristic.StatusFault,
      deviceData.online === true && Math.floor(Date.now() / 1000) <= deviceData.replacement_date
        ? this.hap.Characteristic.StatusFault.NO_FAULT
        : this.hap.Characteristic.StatusFault.GENERAL_FAULT,
    );

    this.smokeService.updateCharacteristic(
      this.hap.Characteristic.SmokeDetected,
      deviceData.smoke_status === true
        ? this.hap.Characteristic.SmokeDetected.SMOKE_DETECTED
        : this.hap.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED,
    );

    if (deviceData.smoke_status === true && this.deviceData.smoke_status === false) {
      this?.log?.warn?.('Smoke detected in "%s"', deviceData.description);
    }

    if (deviceData.smoke_status === false && this.deviceData.smoke_status === true) {
      this?.log?.info?.('Smoke is no longer detected in "%s"', deviceData.description);
    }

    // Update carbon monoxide details
    this.carbonMonoxideService.updateCharacteristic(
      this.hap.Characteristic.CarbonMonoxideDetected,
      deviceData.co_status === true
        ? this.hap.Characteristic.CarbonMonoxideDetected.CO_LEVELS_ABNORMAL
        : this.hap.Characteristic.CarbonMonoxideDetected.CO_LEVELS_NORMAL,
    );

    if (deviceData.co_status === true && this.deviceData.co_status === false) {
      this?.log?.warn?.('Abnormal carbon monoxide levels detected in "%s"', deviceData.description);
    }

    if (deviceData.co_status === false && this.deviceData.co_status === true) {
      this?.log?.info?.('Carbon monoxide levels have returned to normal in "%s"', deviceData.description);
    }

    // Update self testing details
    if (deviceData.self_test_in_progress === true && this.deviceData.self_test_in_progress === false) {
      this?.log?.warn?.('Smoke and Carbon monoxide sensor testing has started in "%s"', deviceData.description);
    }

    if (deviceData.self_test_in_progress === false && this.deviceData.self_test_in_progress === true) {
      this?.log?.info?.('Smoke and Carbon monoxide sensor testing completed in "%s"', deviceData.description);
    }

    // Update motion service if present
    if (this.motionService !== undefined) {
      this.motionService.updateCharacteristic(this.hap.Characteristic.MotionDetected, deviceData.detected_motion === true);

      if (deviceData.detected_motion === true && this.deviceData.detected_motion === false) {
        this?.log?.info?.('Motion detected in "%s"', deviceData.description);
      }

      // Log motion to history only if changed to previous recording
      this.history(this.motionService, {
        status: deviceData.detected_motion === true ? 1 : 0,
      });
    }

    // Update our internal data with properties Eve will need to process then Notify Eve App of device status changes if linked
    this.deviceData.latest_alarm_test = deviceData.latest_alarm_test;
    this.deviceData.self_test_in_progress = deviceData.self_test_in_progress;
    this.deviceData.heat_status = deviceData.heat_status;
    this.deviceData.ntp_green_led_enable = deviceData.ntp_green_led_enable;
    this.deviceData.smoke_test_passed = deviceData.smoke_test_passed;
    this.deviceData.heat_test_passed = deviceData.heat_test_passed;
    this.historyService?.updateEveHome?.(this.smokeService);
  }

  onMessage(type, message) {
    if (typeof type !== 'string' || type === '' || typeof message !== 'object' || message === '') {
      return;
    }

    if (type === HomeKitDevice?.HISTORY?.GET) {
      // Pass back extra data for Eve Smoke onGet() to process command
      // Data will already be an object, our only job is to add/modify to it
      message.lastalarmtest = this.deviceData.latest_alarm_test;
      message.alarmtest = this.deviceData.self_test_in_progress;
      message.heatstatus = this.deviceData.heat_status;
      message.statusled = this.deviceData.ntp_green_led_enable;
      message.smoketestpassed = this.deviceData.smoke_test_passed;
      message.heattestpassed = this.deviceData.heat_test_passed;
      message.hushedstate = this.deviceData.hushed_state;
      return message;
    }

    if (type === HomeKitDevice?.HISTORY?.SET) {
      if (typeof message?.alarmtest === 'boolean') {
        // TODO - How do we trigger an alarm test :-)
        //this?.log?.info?.('Eve Smoke Alarm test', (message.alarmtest === true ? 'start' : 'stop'));
      }
      if (typeof message?.statusled === 'boolean') {
        this.message(HomeKitDevice.SET, { uuid: this.deviceData.nest_google_uuid, ntp_green_led_enable: message.statusled });
      }
    }
  }
}

// Function to process our RAW Nest or Google for this device type
export function processRawData(log, rawData, config, deviceType = undefined) {
  if (
    rawData === null ||
    typeof rawData !== 'object' ||
    rawData?.constructor !== Object ||
    typeof config !== 'object' ||
    config?.constructor !== Object
  ) {
    return;
  }

  // Process data for any smoke detectors we have in the raw data
  let devices = {};
  Object.entries(rawData)
    .filter(
      ([key, value]) =>
        key.startsWith('topaz.') === true ||
        (key.startsWith('DEVICE_') === true && PROTOBUF_RESOURCES.PROTECT.includes(value.value?.device_info?.typeName) === true),
    )
    .forEach(([object_key, value]) => {
      let tempDevice = {};
      try {
        if (
          value?.source === DATA_SOURCE.GOOGLE &&
          value.value?.configuration_done?.deviceReady === true &&
          rawData?.[value.value?.device_info?.pairerId?.resourceId] !== undefined
        ) {
          tempDevice = processCommonData(
            object_key,
            {
              type: DEVICE_TYPE.PROTECT,
              model:
                value.value.device_info.typeName === 'nest.resource.NestProtect1LinePoweredResource'
                  ? 'Protect (1st gen, wired)'
                  : value.value.device_info.typeName === 'nest.resource.NestProtect1BatteryPoweredResource'
                    ? 'Protect (1st gen, battery)'
                    : value.value.device_info.typeName === 'nest.resource.NestProtect2LinePoweredResource'
                      ? 'Protect (2nd gen, wired)'
                      : value.value.device_info.typeName === 'nest.resource.NestProtect2BatteryPoweredResource'
                        ? 'Protect (2nd gen, battery)'
                        : 'Protect (unknown)',
              softwareVersion: value.value.device_identity.softwareVersion,
              serialNumber: value.value.device_identity.serialNumber,
              description: String(value.value?.label?.label ?? ''),
              location: String(
                [
                  ...Object.values(
                    rawData?.[value.value?.device_info?.pairerId?.resourceId]?.value?.located_annotations?.predefinedWheres || {},
                  ),
                  ...Object.values(
                    rawData?.[value.value?.device_info?.pairerId?.resourceId]?.value?.located_annotations?.customWheres || {},
                  ),
                ].find((where) => where?.whereId?.resourceId === value.value?.device_located_settings?.whereAnnotationRid?.resourceId)
                  ?.label?.literal ?? '',
              ),
              online: value.value?.liveness?.status === 'LIVENESS_DEVICE_STATUS_ONLINE',
              line_power_present: value.value?.wall_power?.status === 'POWER_SOURCE_STATUS_ACTIVE',
              wired_or_battery: typeof value.value?.wall_power?.status === 'string' ? 0 : 1,
              battery_level:
                isNaN(value.value?.battery_voltage_bank1?.batteryValue?.batteryVoltage?.value) === false
                  ? scaleValue(Number(value.value.battery_voltage_bank1.batteryValue.batteryVoltage.value), 0, 5.4, 0, 100)
                  : 0,
              battery_health_state:
                value.value?.battery_voltage_bank0?.faultInformation === undefined &&
                value.value?.battery_voltage_bank1?.faultInformation === undefined
                  ? 0
                  : 1,
              smoke_status: value.value?.safety_alarm_smoke?.alarmState === 'ALARM_STATE_ALARM',
              co_status: value.value?.safety_alarm_co?.alarmState === 'ALARM_STATE_ALARM',
              heat_status: false, // TODO <- need to find in protobuf
              hushed_state:
                value.value?.safety_alarm_smoke?.silenceState === 'SILENCE_STATE_SILENCED' ||
                value.value?.safety_alarm_co?.silenceState === 'SILENCE_STATE_SILENCED',
              ntp_green_led: value.value?.night_time_promise_settings?.greenLedEnabled === true,
              smoke_test_passed:
                typeof value.value.safety_summary?.warningDevices?.failures === 'object'
                  ? value.value.safety_summary.warningDevices.failures.includes('FAILURE_TYPE_SMOKE') === false
                  : true,
              heat_test_passed:
                typeof value.value.safety_summary?.warningDevices?.failures === 'object'
                  ? value.value.safety_summary.warningDevices.failures.includes('FAILURE_TYPE_TEMP') === false
                  : true,
              latest_alarm_test:
                isNaN(value.value?.self_test?.lastMstEnd?.seconds) === false ? Number(value.value.self_test.lastMstEnd.seconds) : 0,
              self_test_in_progress:
                value.value?.legacy_structure_self_test?.mstInProgress === true ||
                value.value?.legacy_structure_self_test?.astInProgress === true,
              replacement_date:
                isNaN(value.value?.legacy_protect_device_settings?.replaceByDate?.seconds) === false
                  ? Number(value.value.legacy_protect_device_settings.replaceByDate.seconds)
                  : 0,
              topaz_hush_key:
                typeof value.value?.safety_structure_settings?.structureHushKey === 'string'
                  ? value.value.safety_structure_settings.structureHushKey
                  : '',
              detected_motion:
                value.value?.legacy_protect_device_info?.autoAway !== true || value.value?.structure_mode?.occupancy === 'ACTIVITY_ACTIVE',
            },
            config,
          );
        }

        if (
          value?.source === DATA_SOURCE.NEST &&
          rawData?.['where.' + value.value?.structure_id] !== undefined &&
          rawData?.['safety.' + value.value?.structure_id] !== undefined &&
          rawData?.['widget_track.' + value.value?.thread_mac_address?.toUpperCase()] !== undefined &&
          rawData?.['safety.' + value.value?.structure_id] !== undefined
        ) {
          tempDevice = processCommonData(
            object_key,
            {
              type: DEVICE_TYPE.PROTECT,
              model: (() => {
                let model =
                  value.value.serial_number.substring(0, 2) === '06'
                    ? 'Protect (2nd gen)'
                    : value.value.serial_number.substring(0, 2) === '05'
                      ? 'Protect (1st gen)'
                      : 'Protect (unknown)';
                return value.value.wired_or_battery === 1
                  ? model.replace(/\bgen\)/, 'gen, battery)')
                  : value.value.wired_or_battery === 0
                    ? model.replace(/\bgen\)/, 'gen, wired)')
                    : model;
              })(),
              softwareVersion: value.value.software_version,
              serialNumber: value.value.serial_number,
              description: String(value.value?.description ?? ''),
              location: String(
                rawData?.['where.' + value.value.structure_id]?.value?.wheres?.find((where) => where?.where_id === value.value.where_id)
                  ?.name ?? '',
              ),
              online: rawData?.['widget_track.' + value.value.thread_mac_address.toUpperCase()]?.value?.online === true,
              line_power_present: value.value.line_power_present === true,
              wired_or_battery: value.value.wired_or_battery,
              battery_level: scaleValue(value.value.battery_level, 0, 5400, 0, 100),
              battery_health_state: value.value.battery_health_state,
              smoke_status: value.value.smoke_status !== 0,
              co_status: value.value.co_status !== 0,
              heat_status: value.value.heat_status !== 0,
              hushed_state: value.value.hushed_state === true,
              ntp_green_led_enable: value.value.ntp_green_led_enable === true,
              smoke_test_passed: value.value.component_smoke_test_passed === true,
              heat_test_passed: value.value.component_temp_test_passed === true,
              latest_alarm_test: value.value.latest_manual_test_end_utc_secs,
              self_test_in_progress: rawData?.['safety.' + value.value.structure_id]?.value?.manual_self_test_in_progress === true,
              replacement_date: value.value.replace_by_date_utc_secs,
              topaz_hush_key:
                typeof rawData?.['structure.' + value.value.structure_id]?.value?.topaz_hush_key === 'string'
                  ? rawData['structure.' + value.value.structure_id].value.topaz_hush_key
                  : '',
              detected_motion: value.value.auto_away === false,
            },
            config,
          );
        }
        // eslint-disable-next-line no-unused-vars
      } catch (error) {
        log?.debug?.('Error processing protect data for "%s"', object_key);
      }

      if (
        Object.entries(tempDevice).length !== 0 &&
        typeof devices[tempDevice.serialNumber] === 'undefined' &&
        (deviceType === undefined || (typeof deviceType === 'string' && deviceType !== '' && tempDevice.type === deviceType))
      ) {
        let deviceOptions = config?.devices?.find(
          (device) => device?.serialNumber?.toUpperCase?.() === tempDevice?.serialNumber?.toUpperCase?.(),
        );
        // Insert any extra options we've read in from configuration file for this device
        tempDevice.eveHistory = config.options.eveHistory === true || deviceOptions?.eveHistory === true;
        devices[tempDevice.serialNumber] = tempDevice; // Store processed device
      }
    });

  return devices;
}
