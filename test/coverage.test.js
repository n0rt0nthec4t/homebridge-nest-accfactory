// Verify coverage cannot silently omit modules, lose a metric or accept a malformed floor.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { coverageFailures } from './coverage-reporter.js';
import { importSource } from './helpers/import-source.js';

let files = ['src/example.js'];
let minimums = { 'src/example.js': { lines: 80, branches: 70, functions: 90 } };
let passing = { 'src/example.js': { lines: 80, branches: 70, functions: 90 } };

test('coverage accepts exact floors and rejects an entirely unmeasured module', () => {
  assert.deepEqual(coverageFailures(files, passing, minimums), []);
  assert.deepEqual(coverageFailures(files, {}, minimums), ['src/example.js: absent from coverage']);
  assert.deepEqual(coverageFailures(files, passing, {}), ['src/example.js: missing reviewed coverage floor']);
});
for (let metric of ['lines', 'branches', 'functions']) {
  for (let value of [0, undefined, NaN]) {
    test('coverage rejects insufficient or missing ' + metric + ': ' + value, () => {
      let measurements = structuredClone(passing);
      measurements['src/example.js'][metric] = value;
      assert.equal(coverageFailures(files, measurements, minimums).length, 1);
    });
  }
  for (let value of [undefined, NaN, -1, 101]) {
    test('coverage rejects invalid ' + metric + ' floor: ' + value, () => {
      let floors = structuredClone(minimums);
      floors['src/example.js'][metric] = value;
      assert.deepEqual(coverageFailures(files, passing, floors), ['src/example.js: invalid ' + metric + ' coverage floor']);
    });
  }
}
test('coverage import helper refuses production body edits that would corrupt source offsets', async () => {
  let location = new URL('../src/utils.js', import.meta.url);
  let source = await readFile(location, 'utf8');
  await assert.rejects(importSource(location, source + '\nexport const changed = true;'), /unchanged production code/);
});
