// Verify cached discovery across split cloud messages, late parents and unrelated updates without media or network I/O.
import assert from 'node:assert/strict';
import { importSource } from './helpers/import-source.js';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { DATA_SOURCE } from '../src/consts.js';
import { config, fixtures, home } from './helpers/discovery-fixtures.js';

let modules = new Map();
let base = 'data:text/javascript,' + encodeURIComponent('export default class { static makeValidHKName(name) { return name; } }');
for (let name of ['camera', 'doorbell', 'floodlight', 'thermostat', 'heatlink', 'protect', 'homeaway', 'lock']) {
  let location = new URL('../src/plugins/' + name + '.js', import.meta.url);
  let source = (await readFile(location, 'utf8')).replace(/from '([^']+)'/g, (match, specifier) => {
    let target =
      specifier === '../HomeKitDevice.js'
        ? base
        : specifier === './camera.js'
          ? modules.get('camera').url
          : ['./camera/streamer.js', './camera/nexustalk.js', './camera/webrtc.js'].includes(specifier) === true
              ? 'data:text/javascript,export default class {}'
              : specifier.startsWith('.') === true
                ? new URL(specifier, location).href
                : specifier;
    return 'from ' + JSON.stringify(target);
  });
  let url = location.href;
  modules.set(name, { url, ...(await importSource(location, source)) });
}

function setup(fixture) {
  let id = fixture.id ?? 'DEVICE_TEST';
  let parents = structuredClone(fixture.parents ?? { STRUCTURE_HOME: home });
  let raw = { ...parents, [id]: { source: fixture.source ?? DATA_SOURCE.GOOGLE, value: structuredClone(fixture.value) } };
  let run = (changed) =>
    modules.get(fixture.name).processRawData({ error: (...args) => assert.fail(args.join(' ')) }, raw, config, fixture.type, changed);
  let delta = (key, fields = []) => new Map([[key, { fields: new Set(fields) }]]);
  return { id, raw, parents, run, delta };
}

for (let fixture of fixtures) {
  let label = fixture.name + ' / ' + (fixture.source ?? DATA_SOURCE.GOOGLE);
  for (let reverse of [false, true]) {
    test('discovery combines separately arriving cached fields: ' + label + ', reversed=' + reverse, () => {
      let flow = setup(fixture);
      let expected = flow.run(flow.delta(flow.id, Object.keys(fixture.value)));
      assert.equal(Object.values(expected)[0]?.full, true, 'complete fixture must be discoverable');
      flow.raw[flow.id].value = {};
      let fields = Object.entries(fixture.value);
      if (reverse === true) {
        fields.reverse();
      }
      let result;
      for (let [key, value] of fields) {
        flow.raw[flow.id].value[key] = structuredClone(value);
        result = flow.run(flow.delta(flow.id, [key]));
      }
      assert.deepEqual(result, expected);
    });
  }

  test('discovery ignores unrelated and empty deltas: ' + label, () => {
    let flow = setup(fixture);
    assert.deepEqual(flow.run(new Map()), {});
    assert.deepEqual(flow.run(flow.delta('DEVICE_OTHER', ['liveness'])), {});
  });

  if (fixture.name !== 'homeaway') {
    test('late parent data unlocks cached discovery: ' + label, () => {
      let flow = setup(fixture);
      let expected = flow.run(flow.delta(flow.id, Object.keys(fixture.value)));
      for (let key of Object.keys(flow.parents)) {
        delete flow.raw[key];
      }
      assert.deepEqual(flow.run(flow.delta(flow.id, Object.keys(fixture.value))), {});
      let result;
      for (let [key, value] of Object.entries(flow.parents)) {
        flow.raw[key] = value;
        result = flow.run(flow.delta(key, Object.keys(value.value)));
      }
      assert.deepEqual(result, expected);
    });

    test('parent-only naming changes update the same identity: ' + label, () => {
      let flow = setup(fixture);
      let initial = flow.run(flow.delta(flow.id, Object.keys(fixture.value)));
      let key = fixture.source === DATA_SOURCE.NEST ? 'where.home' : 'STRUCTURE_HOME';
      if (fixture.source === DATA_SOURCE.NEST) {
        flow.raw[key].value.wheres[0].name = 'Hallway';
      } else {
        flow.raw[key].value.located_annotations.predefinedWheres.room.label.literal = 'Hallway';
      }
      let updated = flow.run(flow.delta(key, fixture.source === DATA_SOURCE.NEST ? ['wheres'] : ['located_annotations']));
      assert.deepEqual(Object.keys(updated), Object.keys(initial));
      assert.equal(Object.values(updated)[0].data.description, 'Device - Hallway');
    });
  }
}
