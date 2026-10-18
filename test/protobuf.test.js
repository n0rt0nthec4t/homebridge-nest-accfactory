// Verify real schema parsing, cache isolation, invalid inputs and recovery after failed reads/lookups.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { getProtoRoot, getProtoType, getProtoTypes, clearProtoCache } from '../src/protobuf.js';

async function fixture(
  context,
  contents = 'syntax = "proto3"; package fixture; message Sample { string label = 1; message Nested { int32 value = 1; } }',
) {
  let directory = await mkdtemp(path.join(tmpdir(), 'nest-protobuf-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  context.after(() => clearProtoCache());
  let file = path.join(directory, 'fixture.proto');
  await writeFile(file, contents);
  let warnings = [];
  return { file, warnings, log: { warn: (...args) => warnings.push(args) } };
}
for (let invalid of [undefined, null, '', ' ', 1, {}]) {
  test('protobuf rejects invalid path ' + JSON.stringify(invalid), () => {
    assert.equal(getProtoRoot(invalid), undefined);
    assert.equal(getProtoType(invalid, 'Sample'), undefined);
    assert.deepEqual(getProtoTypes(invalid), []);
  });
}
test('protobuf caches root, named and nested type identity until explicitly cleared', async (context) => {
  let { file, log, warnings } = await fixture(context);
  let root = getProtoRoot(file, log);
  assert.equal(getProtoRoot(file, log), root);
  let type = getProtoType(file, 'fixture.Sample', log);
  assert.equal(getProtoType(file, 'fixture.Sample', log), type);
  let types = getProtoTypes(file, log);
  assert.deepEqual(
    types.map((entry) => entry.fullName),
    ['.fixture.Sample', '.fixture.Sample.Nested'],
  );
  assert.equal(getProtoTypes(file, log), types);
  assert.equal(type.decode(type.encode({ label: 'round trip' }).finish()).label, 'round trip');
  clearProtoCache();
  assert.notEqual(getProtoRoot(file, log), root);
  assert.notEqual(getProtoType(file, 'fixture.Sample', log), type);
  assert.deepEqual(warnings, []);
});
test('protobuf missing and malformed files do not poison later successful loads', async (context) => {
  let { file, log, warnings } = await fixture(context, 'this is invalid protobuf');
  assert.equal(getProtoRoot(file + '.missing', log), undefined);
  assert.deepEqual(getProtoTypes(file + '.missing', log), []);
  assert.equal(getProtoRoot(file, log), undefined);
  assert.equal(getProtoType(file, 'fixture.Sample', log), undefined);
  await writeFile(file, 'syntax = "proto3"; package fixture; message Sample {}');
  assert.notEqual(getProtoRoot(file, log), undefined);
  assert.equal(getProtoTypes(file, log).length, 1);
  assert.ok(warnings.length >= 3);
});
test('protobuf validates type names and reports failed or unknown lookups', async (context) => {
  let { file, log, warnings } = await fixture(context);
  for (let name of [undefined, null, '', ' ', 1]) {
    assert.equal(getProtoType(file, name, log), undefined);
  }
  assert.equal(getProtoType(file, 'fixture.Missing', log), undefined);
  let root = getProtoRoot(file, log);
  context.mock.method(root, 'lookup', () => {
    throw new Error('Fixture lookup failed');
  });
  assert.equal(getProtoType(file, 'fixture.Uncached', log), undefined);
  assert.equal(warnings.length, 2);
  assert.equal(warnings[1].at(-1), 'Fixture lookup failed');
});
test('protobuf type traversal reports unexpected library failures instead of crashing startup', async (context) => {
  let { file, log, warnings } = await fixture(context);
  let root = getProtoRoot(file, log);
  let descriptor = Object.getOwnPropertyDescriptor(root, 'nestedArray');
  Object.defineProperty(root, 'nestedArray', {
    configurable: true,
    get() {
      throw new Error('Fixture traversal failed');
    },
  });
  try {
    assert.deepEqual(getProtoTypes(file, log), []);
    assert.equal(warnings.at(-1).at(-1), 'Fixture traversal failed');
  } finally {
    if (descriptor === undefined) {
      delete root.nestedArray;
    } else {
      Object.defineProperty(root, 'nestedArray', descriptor);
    }
  }
});
