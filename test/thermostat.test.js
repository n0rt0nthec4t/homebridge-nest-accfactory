// Verify source preference using the file-backed thermostat mapper.
import assert from 'node:assert/strict';
import test from 'node:test';
import { importSource } from './helpers/import-source.js';
import { DATA_SOURCE } from '../src/consts.js';

let { processRawData } = await importSource(new URL('../src/plugins/thermostat.js', import.meta.url));

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
