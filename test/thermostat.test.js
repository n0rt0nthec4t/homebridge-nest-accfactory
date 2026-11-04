// Verify source preference and effective operating modes using the file-backed thermostat mapper.
import assert from 'node:assert/strict';
import test from 'node:test';
import { importSource } from './helpers/import-source.js';
import { DATA_SOURCE } from '../src/consts.js';

let { processRawData } = await importSource(new URL('../src/plugins/thermostat.js', import.meta.url));

for (let source of [DATA_SOURCE.NEST, DATA_SOURCE.GOOGLE]) {
  for (let eco of ['manual', 'auto']) {
    for (let normalMode of ['off', 'heat', 'cool', 'range']) {
      test('Eco with both limits disabled maps to Off: ' + source + '/' + eco + '/' + normalMode, () => {
        let isNest = source === DATA_SOURCE.NEST;
        let id = isNest === true ? 'device.SERIAL' : 'DEVICE_GOOGLE';
        let value =
          isNest === true
            ? {
                serial_number: 'SERIAL',
                eco: { mode: eco + '-eco' },
                away_temperature_low_enabled: false,
                away_temperature_high_enabled: false,
                away_temperature_low: 4.5,
                away_temperature_high: 24.5,
              }
            : {
                device_identity: { serialNumber: 'SERIAL' },
                configuration_done: { deviceReady: true },
                device_info: { typeName: 'nest.resource.NestLearningThermostat3Resource', pairerId: { resourceId: 'STRUCTURE_HOME' } },
                eco_mode_state: { ecoMode: eco === 'manual' ? 'ECO_MODE_MANUAL_ECO' : 'ECO_MODE_AUTO_ECO' },
                eco_mode_settings: {
                  ecoTemperatureHeat: { enabled: false, value: { value: 4.5 } },
                  ecoTemperatureCool: { enabled: false, value: { value: 24.5 } },
                },
                target_temperature_settings: {
                  enabled: { value: normalMode !== 'off' },
                  targetTemperature: {
                    setpointType: 'SET_POINT_TYPE_' + (normalMode === 'off' ? 'heat' : normalMode).toUpperCase(),
                    heatingTarget: { value: 19 },
                    coolingTarget: { value: 25 },
                  },
                },
              };
        let raw = {
          [id]: { source, value },
          'shared.SERIAL': {
            source: DATA_SOURCE.NEST,
            value: { target_temperature_type: normalMode, target_temperature_low: 19, target_temperature_high: 25 },
          },
          'track.SERIAL': { value: {} },
          'where.home': { value: {} },
          'link.SERIAL': { value: { structure: 'structure.home' } },
          'structure.home': { value: {} },
          STRUCTURE_HOME: { value: {} },
        };
        let field = isNest === true ? 'eco' : 'eco_mode_state';
        let changed = new Map([[id, { fields: new Set([field]) }]]);
        let before = structuredClone(raw);
        let mapped = processRawData(undefined, raw, { options: {} }, undefined, changed).SERIAL.data;
        assert.equal(mapped.hvac_mode, 'off');
        assert.equal(mapped.eco_mode, eco);
        assert.equal(mapped.target_temperature_low, 19);
        assert.equal(mapped.target_temperature_high, 25);
        assert.deepEqual(raw, before, 'Presentation must not change the source mode needed after Eco');

        // Changing only enable flags must replace only that side's mapped target.
        for (let [heatEnabled, coolEnabled, low, high] of [
          [true, false, 4.5, 25],
          [false, true, 19, 24.5],
          [true, true, 4.5, 24.5],
          [false, false, 19, 25],
        ]) {
          if (isNest === true) {
            value.away_temperature_low_enabled = heatEnabled;
            value.away_temperature_high_enabled = coolEnabled;
          } else {
            value.eco_mode_settings.ecoTemperatureHeat.enabled = heatEnabled;
            value.eco_mode_settings.ecoTemperatureCool.enabled = coolEnabled;
          }
          let flagsChanged = new Map([
            [
              id,
              {
                fields: new Set(
                  isNest === true ? ['away_temperature_low_enabled', 'away_temperature_high_enabled'] : ['eco_mode_settings'],
                ),
              },
            ],
          ]);
          mapped = processRawData(undefined, raw, { options: {} }, undefined, flagsChanged).SERIAL.data;
          assert.equal(mapped.target_temperature_low, low);
          assert.equal(mapped.target_temperature_high, high);
        }

        // Missing settings do not confirm that both Eco sides are disabled.
        if (isNest === true) {
          delete value.away_temperature_low_enabled;
        } else {
          delete value.eco_mode_settings.ecoTemperatureHeat.enabled;
        }
        mapped = processRawData(undefined, raw, { options: {} }, undefined, changed).SERIAL.data;
        assert.equal(mapped.hvac_mode, normalMode);

        if (isNest === true) {
          value.away_temperature_low_enabled = false;
          value.eco.mode = 'unknown';
        } else {
          value.eco_mode_settings.ecoTemperatureHeat.enabled = false;
          value.eco_mode_state.ecoMode = 'ECO_MODE_UNSPECIFIED';
        }
        mapped = processRawData(undefined, raw, { options: {} }, undefined, changed).SERIAL.data;
        assert.equal(mapped.hvac_mode, normalMode);
        assert.equal(mapped.eco_mode, 'unknown');

        if (isNest === true) {
          value.eco.mode = 'schedule';
        } else {
          value.eco_mode_state.ecoMode = 'ECO_MODE_INACTIVE';
        }
        mapped = processRawData(undefined, raw, { options: {} }, undefined, changed).SERIAL.data;
        assert.equal(mapped.hvac_mode, normalMode);
        assert.equal(mapped.eco_mode, 'off');
        assert.equal(mapped.target_temperature_low, 19);
        assert.equal(mapped.target_temperature_high, 25);
      });
    }
  }
}

for (let firstSource of [DATA_SOURCE.NEST, DATA_SOURCE.GOOGLE]) {
  test('thermostat mapper prefers protobuf over incomplete REST arriving first from ' + firstSource, () => {
    let nest = ['device.nest', { source: DATA_SOURCE.NEST, value: { serial_number: 'SERIAL', backplate_temperature: 19 } }];
    let google = [
      'DEVICE_GOOGLE',
      {
        source: DATA_SOURCE.GOOGLE,
        value: {
          device_identity: { serialNumber: 'SERIAL' },
          device_info: { typeName: 'nest.resource.NestLearningThermostat3Resource', pairerId: { resourceId: 'STRUCTURE_HOME' } },
          configuration_done: { deviceReady: true },
          current_temperature: { temperatureValue: { temperature: { value: 21 } } },
        },
      },
    ];
    let raw = {
      ...Object.fromEntries(firstSource === DATA_SOURCE.NEST ? [nest, google] : [google, nest]),
      'track.SERIAL': { value: {} },
      'shared.SERIAL': { value: {} },
      'link.SERIAL': { value: { structure: 'structure.home' } },
      'where.home': { value: {} },
      STRUCTURE_HOME: { value: {} },
    };
    let mapped = processRawData(
      undefined,
      raw,
      { options: {} },
      undefined,
      new Map([['DEVICE_GOOGLE', { fields: new Set(['current_temperature']) }]]),
    );
    assert.equal(mapped.SERIAL.full, false);
    assert.equal(mapped.SERIAL.data.nest_google_device_uuid, 'DEVICE_GOOGLE');
    assert.equal(mapped.SERIAL.data.current_temperature, 21);
    assert.deepEqual(
      processRawData(
        undefined,
        raw,
        { options: {} },
        undefined,
        new Map([['device.nest', { fields: new Set(['backplate_temperature']) }]]),
      ),
      {},
    );
    delete raw.DEVICE_GOOGLE;
    assert.deepEqual(
      processRawData(
        undefined,
        raw,
        { options: {} },
        undefined,
        new Map([['device.nest', { fields: new Set(['backplate_temperature']) }]]),
      ),
      {},
    );
  });
}
