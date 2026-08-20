import assert from 'node:assert/strict';
import test from 'node:test';

import {
  adjustTemperature,
  buildDeviceDescription,
  crc24,
  parseDurationToSeconds,
  processSoftwareVersion,
  scaleValue,
} from '../../src/utils.js';

test('adjustTemperature converts and applies HomeKit rounding', () => {
  assert.equal(adjustTemperature(68, 'F', 'C', false), 20);
  assert.equal(adjustTemperature(70, 'F', 'C', true), 21);
  assert.equal(adjustTemperature(20.4, 'C', 'F', true), 69);
  assert.equal(adjustTemperature('invalid', 'C', 'F'), undefined);
});

test('scaleValue clamps values to the source range', () => {
  assert.equal(scaleValue(5, 0, 10, 0, 100), 50);
  assert.equal(scaleValue(-1, 0, 10, 0, 100), 0);
  assert.equal(scaleValue(11, 0, 10, 0, 100), 100);
  assert.equal(scaleValue(5, 1, 1, 20, 30), 20);
});

test('parseDurationToSeconds accepts compound units and bounds results', () => {
  assert.equal(parseDurationToSeconds('1w 2d 3h 4m 5s'), 788645);
  assert.equal(parseDurationToSeconds('90', { max: 60 }), 60);
  assert.equal(parseDurationToSeconds('-1h', { defaultValue: 30 }), 30);
  assert.equal(parseDurationToSeconds('invalid', { defaultValue: 30 }), 30);
});

test('crc24 returns stable six-digit identifiers', () => {
  assert.equal(crc24('abc'), 'ba1c7b');
  assert.equal(crc24('Nest'), '166f65');
  assert.equal(crc24(undefined), undefined);
});

test('processSoftwareVersion normalises common Nest version formats', () => {
  assert.equal(processSoftwareVersion('1.0a17'), '1.0.17');
  assert.equal(processSoftwareVersion('3.6rc8'), '3.6.8');
  assert.equal(processSoftwareVersion('nq-user 1.73 OPENMASTER 422270 release-keys'), '422270');
  assert.equal(processSoftwareVersion(undefined), '0.0.0');
});

test('buildDeviceDescription avoids repeating an existing location', () => {
  let raw = {
    value: {
      label: { label: 'Front Door Camera' },
      device_located_settings: {
        fixtureNameLabel: { literal: 'Front Door' },
      },
    },
  };

  assert.equal(buildDeviceDescription({}, raw), 'Front Door Camera');
  assert.equal(buildDeviceDescription({}, { value: {} }), 'unknown description');
});
