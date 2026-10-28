// Verify shared source preference, fallback, partial mapping and failure handling contracts.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMappedObject,
  createMappingContext,
  mergeMappedObjects,
  getMappedValue,
  getPath,
  hasRequiredFields,
  normaliseSourceContext,
  resolveMappedField,
} from '../src/translator.js';

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

for (let value of [false, 0, [], {}]) {
  test('translator retains meaningful preferred values: ' + JSON.stringify(value), () => {
    let context = createMappingContext({}, 'device', { google: { value }, nest: { value: 'fallback' } });
    let result = buildMappedObject({ setting: { required: true, google: 'value', nest: 'value', prefer: 'google' } }, context, new Set());
    assert.deepEqual(result, { data: { setting: value }, hasRequired: true });
    assert.deepEqual(mergeMappedObjects({ setting: value }, { setting: 'old' }), { setting: value });
  });
}
for (let wrapped of [false, true]) {
  test('translator resolver exceptions fall back to the other source, wrapped=' + wrapped, () => {
    let broken = () => {
      throw new Error('Fixture malformed upstream state');
    };
    let context = createMappingContext({}, 'device', { google: {}, nest: { value: 25 } });
    assert.equal(
      resolveMappedField(
        'temperature',
        { google: wrapped === true ? { translate: broken } : broken, nest: 'value', prefer: 'google' },
        context,
      ),
      25,
    );
  });
}
for (let fallback of [false, 0, undefined]) {
  test('translator failed custom merge uses its declared fallback: ' + fallback, () => {
    let context = createMappingContext({}, 'device', { google: { value: 1 } });
    let result = buildMappedObject(
      {
        setting: {
          google: 'value',
          defaultValue: fallback,
          merge: () => {
            throw new Error('Fixture merge failed');
          },
        },
      },
      context,
      new Set(),
    );
    assert.equal(result.data.setting, fallback);
  });
}
test('translator related-resource changes rebuild only dependent fields with the full shared context', () => {
  let raw = { parent: { enabled: true } };
  let context = createMappingContext(raw, 'device', { google: { value: 2 } }, { parent: 'parent' });
  let result = buildMappedObject(
    {
      enabled: {
        required: true,
        google: { fields: ['self'], related: ['parent_state'], translate: ({ rawData, parent }) => rawData[parent].enabled },
      },
      temperature: { google: { fields: ['temperature'], translate: 'value' } },
    },
    context,
    new Set(['parent_state']),
  );
  assert.deepEqual(result, { data: { enabled: true }, hasRequired: true });
  assert.deepEqual(normaliseSourceContext('nest', 'device', {}, { account: 'owner' }).account, 'owner');
});
test('translator rejects invalid mapping contracts and missing required fields without throwing', () => {
  for (let invalid of [null, undefined, [], 1, 'invalid']) {
    assert.deepEqual(buildMappedObject(invalid, {}, new Set()), { data: {}, hasRequired: false });
    assert.equal(resolveMappedField('field', invalid, {}), undefined);
    assert.equal(hasRequiredFields(invalid, FIELD_MAP), false);
    assert.equal(hasRequiredFields({}, invalid), false);
    assert.equal(getMappedValue(invalid, { raw: {} }), undefined);
    assert.equal(getPath(invalid, 'value'), undefined);
  }
  assert.equal(getPath({}, ''), undefined);
  assert.equal(getPath({}, null), undefined);
  assert.equal(getMappedValue('value', {}), undefined);
  assert.equal(hasRequiredFields({}, { needed: { required: true } }), false);
  assert.deepEqual(buildMappedObject(FIELD_MAP, {}, undefined), { data: {}, hasRequired: false });
  assert.deepEqual(createMappingContext({}, 'device', null, []), { rawData: {}, objectKey: 'device', sources: {} });
});

test('translator preserves translate method receivers and unbound direct functions', () => {
  let context = { raw: { value: 7 } };
  let mapping = {
    translate(input) {
      assert.equal(this, mapping);
      assert.equal(input, context);
      return input.raw.value;
    },
  };
  assert.equal(getMappedValue(mapping, context), 7);
  assert.equal(
    getMappedValue(function (input) {
      assert.equal(this, undefined);
      return input.raw.value;
    }, context),
    7,
  );
  assert.equal(getMappedValue('value', context), 7);
  assert.equal(getMappedValue({ translate: 'value' }, context), 7);
});

for (let value of [false, 0, null, '', undefined]) {
  test('translator completeness retains defined-value semantics: ' + JSON.stringify(value), () => {
    let map = { required: { required: true, google: { fields: [] }, merge: () => value } };
    let result = buildMappedObject(map, createMappingContext({}, 'device', { google: {} }), new Set());
    assert.deepEqual(result, { data: { required: value }, hasRequired: value !== undefined });
    assert.equal(result.hasRequired, hasRequiredFields(result.data, map));
  });
}

test('translator maps later partial fields even when an earlier required dependency is excluded', () => {
  let map = {
    identity: { required: true, google: { fields: ['identity'], translate: 'id' } },
    enabled: { google: { fields: ['state'], translate: 'enabled' } },
  };
  let result = buildMappedObject(map, createMappingContext({}, 'device', { google: { id: 'DEVICE', enabled: false } }), new Set(['state']));
  assert.deepEqual(result, { data: { enabled: false }, hasRequired: false });
});

test('translator retains undefined source membership and the complete merge context', () => {
  let rawData = { parent: { enabled: false } };
  let context = createMappingContext(rawData, 'device', { google: undefined, nest: { enabled: false } }, { parentUUID: 'parent' });
  let result = buildMappedObject(
    {
      identity: { required: true, google: { fields: [], translate: 'id' } },
      enabled: {
        google: { fields: ['other'], translate: 'enabled' },
        nest: { related: ['parent_state'], translate: ({ rawData, parentUUID }) => rawData[parentUUID].enabled },
        merge: ({ values, context: received }) => {
          assert.equal(received, context);
          assert.deepEqual(values, { google: undefined, nest: false });
          return values.nest;
        },
      },
    },
    context,
    new Set(['parent_state']),
  );
  assert.deepEqual(result, { data: { identity: undefined, enabled: false }, hasRequired: false });
});
