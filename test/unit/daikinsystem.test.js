// Verify independent Daikin state, power-off parameters and failure recovery with mocked HTTP.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { URL } from 'node:url';

// Preserve the runtime import layout while replacing only the flattened shared-module path.
let location = new URL('../../src/plugins/daikinsystem.mjs', import.meta.url);
let source = (await readFile(location, 'utf8')).replace(
  '../fetchWrapper.js',
  new URL('../../src/fetchWrapper/fetchWrapper.js', import.meta.url).href,
);
let { default: createDaikin } = await import('data:text/javascript,' + encodeURIComponent(source));

for (let [mode, value, temperature, humidity] of [
  ['fan', 50, '--', '--'],
  ['dehumidifier', 45, 'M', '45'],
]) {
  test(mode + '-only operation can be switched off with its accepted parameters', async (t) => {
    let requests = [];
    t.mock.method(globalThis, 'fetch', async (url) => {
      requests.push(new URL(url));
      return new globalThis.Response('ret=OK');
    });
    let unit = createDaikin(undefined, ['http://unit.invalid', 'Unit', 'modes=' + mode + ',off']);
    await unit[mode](value);
    await unit.off();
    assert.equal(requests.length, 2);
    assert.equal(requests[0].searchParams.get('pow'), '1');
    assert.equal(requests[1].searchParams.get('pow'), '0');
    for (let key of ['mode', 'stemp', 'shum', 'f_rate', 'f_dir']) {
      assert.equal(requests[1].searchParams.get(key), requests[0].searchParams.get(key));
    }
    assert.equal(requests[1].searchParams.get('stemp'), temperature);
    assert.equal(requests[1].searchParams.get('shum'), humidity);
  });
}

test('awaited commands retain state while another unit proceeds independently', async (t) => {
  let requests = [];
  let pending = Promise.withResolvers();
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(new URL(url));
    if (requests.length === 1) {
      return await pending.promise;
    }
    return new globalThis.Response('ret=OK');
  });
  let first = createDaikin(undefined, ['http://unit-a.invalid']);
  let second = createDaikin(undefined, ['http://unit-b.invalid']);
  let heating = first.heat(26);
  await setImmediate();
  assert.equal(requests.length, 1);
  await second.fan(50);
  assert.equal(requests[1].hostname, 'unit-b.invalid');
  assert.equal(requests.length, 2);
  pending.resolve(new globalThis.Response('ret=OK'));
  await heating;
  await first.off();
  await first.cool(19);
  await first.off();
  assert.deepEqual(
    requests.filter((url) => url.hostname === 'unit-a.invalid').map((url) => Object.fromEntries(url.searchParams)),
    [
      { pow: '1', mode: '4', stemp: '26', shum: '0', f_rate: 'A', f_dir: '3' },
      { pow: '0', mode: '4', stemp: '26', shum: '0', f_rate: 'A', f_dir: '3' },
      { pow: '1', mode: '3', stemp: '19', shum: '0', f_rate: 'A', f_dir: '3' },
      { pow: '0', mode: '3', stemp: '19', shum: '0', f_rate: 'A', f_dir: '3' },
    ],
  );
});

for (let [mode, value] of [
  ['cool', 19],
  ['heat', 20],
  ['fan', 50],
  ['dehumidifier', 45],
  ['off', undefined],
]) {
  for (let failure of ['device', 'network']) {
    test(mode + ' ' + failure + ' failure preserves accepted state and does not block later commands', async (t) => {
      let requests = [];
      let errors = [];
      let logger = Object.fromEntries(['info', 'success', 'warn', 'debug'].map((level) => [level, () => {}]));
      logger.error = (...args) => errors.push(args);
      t.mock.method(globalThis, 'fetch', async (url) => {
        requests.push(new URL(url));
        if (requests.length === 2) {
          if (failure === 'network') {
            throw new Error('Network unavailable');
          }
          return new globalThis.Response('ret=NOT_OK');
        }
        return new globalThis.Response('ret=OK');
      });
      let unit = createDaikin(logger, ['http://unit.invalid']);
      await unit.heat(26);
      await unit[mode](value);
      await unit.off();
      await unit.cool(19);
      await unit.off();
      assert.equal(errors.length, 1);
      assert.equal(requests.length, 5);
      assert.equal(requests[2].searchParams.get('pow'), '0');
      assert.equal(requests[2].searchParams.get('mode'), '4');
      assert.equal(requests[2].searchParams.get('stemp'), '26');
      assert.equal(requests[4].searchParams.get('pow'), '0');
      assert.equal(requests[4].searchParams.get('mode'), '3');
      assert.equal(requests[4].searchParams.get('stemp'), '19');
    });
  }
}

test('a failed first command does not invent power-off state and a later command can succeed', async (t) => {
  let requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(new URL(url));
    return new globalThis.Response(requests.length === 1 ? 'ret=PARAM NG' : 'ret=OK');
  });
  let unit = createDaikin(undefined, ['http://unit.invalid']);
  await unit.cool(19);
  await unit.off();
  assert.equal(requests.length, 1);
  await unit.fan(50);
  await unit.off();
  assert.equal(requests.length, 3);
  assert.equal(requests[2].searchParams.get('pow'), '0');
  assert.equal(requests[2].searchParams.get('stemp'), '--');
});

test('two thermostats keep their unit URL, logs, mode filters and last command state isolated', async (t) => {
  let requests = [];
  let logs = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(new URL(url));
    return new globalThis.Response('ret=OK');
  });
  let logger = Object.fromEntries(['info', 'success', 'warn', 'error', 'debug'].map((level) => [level, (...args) => logs.push(args)]));
  let first = createDaikin(logger, ['http://unit-a.invalid', 'Unit A', 'modes=cool,off']);
  let second = createDaikin(logger, ['http://unit-b.invalid', 'Unit B', 'modes=heat,off']);
  assert.deepEqual(Object.keys(first), ['cool', 'off']);
  assert.deepEqual(Object.keys(second), ['heat', 'off']);
  await first.cool(20);
  await second.heat(27);
  await first.off();
  await second.off();
  assert.deepEqual(
    requests.map((url) => url.hostname),
    ['unit-a.invalid', 'unit-b.invalid', 'unit-a.invalid', 'unit-b.invalid'],
  );
  assert.deepEqual(
    requests.map((url) => url.searchParams.get('mode')),
    ['3', '4', '3', '4'],
  );
  assert.deepEqual(
    requests.map((url) => url.searchParams.get('stemp')),
    ['20', '27', '20', '27'],
  );
  assert.deepEqual(
    logs.map((entry) => entry[1]),
    ['[Unit A]', '[Unit B]', '[Unit A]', '[Unit B]'],
  );
});

test('an invalid later unit cannot disable existing controls or borrow an earlier temperature', async (t) => {
  let requests = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(new URL(url));
    return new globalThis.Response('ret=OK');
  });
  let first = createDaikin(undefined, ['http://unit-a.invalid']);
  await first.cool(19);
  let fresh = createDaikin(undefined, ['http://unit-b.invalid']);
  let invalid = createDaikin(undefined, ['invalid']);
  await fresh.off();
  await invalid.cool(30);
  await first.off();
  assert.deepEqual(
    requests.map((url) => url.hostname),
    ['unit-a.invalid', 'unit-a.invalid'],
  );
  assert.equal(requests[1].searchParams.get('stemp'), '19');
});
