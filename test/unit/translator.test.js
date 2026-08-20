import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMappedObject, createMappingContext, mergeMappedObjects } from '../../src/translator.js';

const FIELD_MAP = {
  online: {
    required: true,
    google: { fields: ['status'], translate: 'status.online' },
    nest: { fields: ['online'], translate: 'online' },
    prefer: 'google',
  },
  temperature: {
    google: { fields: ['temperature'], translate: 'temperature' },
  },
};

test('translator prefers the configured source and reports required fields', () => {
  let context = createMappingContext({}, 'device.test', {
    google: { status: { online: true }, temperature: 21.5 },
    nest: { online: false },
  });
  let result = buildMappedObject(FIELD_MAP, context, new Set(['status', 'online', 'temperature']));

  assert.deepEqual(result, {
    data: { online: true, temperature: 21.5 },
    hasRequired: true,
  });
});

test('translator maps only fields affected by a partial update', () => {
  let context = createMappingContext({}, 'device.test', {
    google: { status: { online: true }, temperature: 21.5 },
  });
  let result = buildMappedObject(FIELD_MAP, context, new Set(['temperature']));

  assert.deepEqual(result, {
    data: { temperature: 21.5 },
    hasRequired: false,
  });
});

test('translator falls back when the preferred source has no usable value', () => {
  let context = createMappingContext({}, 'device.test', {
    google: { status: {} },
    nest: { online: false },
  });
  let result = buildMappedObject(FIELD_MAP, context, new Set(['status', 'online']));

  assert.equal(result.data.online, false);
});

test('translator merges objects without mutating either input', () => {
  let primary = { online: true, name: undefined };
  let secondary = { online: false, name: 'Hallway' };

  assert.deepEqual(mergeMappedObjects(primary, secondary), { online: true, name: 'Hallway' });
  assert.deepEqual(primary, { online: true, name: undefined });
  assert.deepEqual(secondary, { online: false, name: 'Hallway' });
});
