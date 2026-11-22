// The settings server checks authentication through the shared quiet helper only.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { importSource } from './helpers/import-source.js';

const boundary =
  'data:text/javascript,' +
  encodeURIComponent(
    'export const runtime = { calls: [] }; export let server;' +
      'export class RequestError extends Error {}' +
      'export class HomebridgePluginUiServer { constructor(){server=this;this.routes=new Map();}' +
      'onRequest(key,handler){this.routes.set(key,handler);} ready(){} }' +
      'export default class Session {static async testConnection(account){runtime.calls.push(account);' +
      'if(runtime.fail===true){throw new Error("private-cookie");}return await (runtime.pending ?? runtime.status);}}',
  );
const fake = await import(boundary);
const location = new URL('../homebridge-ui/server.js', import.meta.url);
const source = (await readFile(location, 'utf8'))
  .replace('\'@homebridge/plugin-ui-utils\'', JSON.stringify(boundary))
  .replace('\'../dist/accountsession.js\'', JSON.stringify(boundary));
await importSource(location, source);
const check = fake.server.routes.get('/accounts/test');
function setup() {
  fake.runtime.calls.length = 0;
  fake.runtime.fail = false;
  fake.runtime.pending = undefined;
  fake.runtime.status = 'success';
}
test('settings server exposes only the account test route, without discovery clients', () => {
  assert.deepEqual([...fake.server.routes.keys()], ['/accounts/test']);
  assert.doesNotMatch(source, /GoogleAPI|loadDeviceModules/);
});
for (let type of ['google', 'nest']) {
  for (let status of ['success', 'failed', 'timeout']) {
    test(type + ' connection check returns only its status: ' + status, async () => {
      setup();
      fake.runtime.status = status;
      let account =
        type === 'google'
          ? { type, issueToken: 'https://accounts.google.com/token', cookie: 'private-cookie', fieldTest: true }
          : { type, access_token: 'private-token', fieldTest: false };
      assert.deepEqual(await check(account), { status });
      assert.deepEqual(fake.runtime.calls, [account]);
    });
  }
}
test('backend exceptions stay out of IPC replies and release the check lock', async () => {
  setup();
  fake.runtime.fail = true;
  let result = await check({ type: 'nest', access_token: 'private-token' });
  assert.deepEqual(result, { status: 'failed' });
  assert.doesNotMatch(JSON.stringify(result), /private-/);
  fake.runtime.fail = false;
  assert.deepEqual(await check({ type: 'nest', access_token: 'private-token' }), { status: 'success' });
});
test('overlapping checks do not start another login and the lock is released on completion', async () => {
  setup();
  let pending = Promise.withResolvers();
  fake.runtime.pending = pending.promise;
  let first = check({ type: 'nest', access_token: 'private-token' });
  await assert.rejects(check({ type: 'nest', access_token: 'private-token' }), /already in progress/);
  assert.equal(fake.runtime.calls.length, 1);
  pending.resolve('timeout');
  assert.deepEqual(await first, { status: 'timeout' });
  fake.runtime.pending = undefined;
  assert.deepEqual(await check({ type: 'nest', access_token: 'private-token' }), { status: 'success' });
});
