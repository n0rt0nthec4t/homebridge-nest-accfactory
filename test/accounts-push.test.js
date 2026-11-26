// Verify the account factory passes its session and private storage to HomeGraph;
// the push receiver owns registration without an Accounts callback.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { importSource } from './helpers/import-source.js';

let boundary =
  'data:text/javascript,' + encodeURIComponent('export default class { constructor(options) { this.options = options; } disconnect() {} }');
let location = new URL('../src/accounts.js', import.meta.url);
let source = (await readFile(location, 'utf8'))
  .replace('from \'./api/homegraph.js\'', 'from ' + JSON.stringify(boundary))
  .replace('from \'./api/protobuf.js\'', 'from ' + JSON.stringify(boundary));
let { default: Accounts } = await importSource(location, source);
let { default: GoogleHomePush } = await importSource(new URL('../src/api/homegraphpush.js', import.meta.url));

test('Google Home account factory wires private registration while other account types stay on protobuf', async (t) => {
  let directory = await fs.mkdtemp(path.join(os.tmpdir(), 'accounts-push-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let accounts = Accounts.fromConfig(
    {
      accounts: [
        { name: 'Home', type: 'googlehome', refreshToken: 'fixture-sso-token' },
        { name: 'Google', type: 'google', issueToken: 'https://accounts.google.com/token', cookie: 'fixture-cookie' },
        { name: 'Nest', type: 'nest', access_token: 'fixture-nest-token' },
      ],
    },
    { storagePath: directory },
  );
  t.after(() => accounts.shutdown());
  let [uuid, account] = [...accounts.entries()][0];
  let options = account.homegraphAPI.options;
  assert.equal(options.registerPush, undefined);
  assert.equal(options.storagePath, directory);
  assert.equal(options.session, account.session);
  assert.equal(options.uuid, uuid);
  account.authorised = true;
  account.oauth2 = 'fixture-home-oauth';
  let requests = [];
  let bytes = Buffer.alloc(18);
  bytes[0] = 57;
  bytes.writeBigUInt64LE(1n, 1);
  bytes[9] = 65;
  bytes.writeBigUInt64LE(2n, 10);
  t.mock.method(globalThis, 'fetch', async (url, settings) => {
    requests.push({ url, settings });
    if (url.endsWith('/installations') === true) {
      return Response.json({ refreshToken: 'fixture-fis-refresh', authToken: { token: 'fixture-fis', expiresIn: '3600s' } });
    }
    if (url.endsWith('/checkin') === true) {
      return new Response(bytes);
    }
    return new Response(url.endsWith('/register3') === true ? 'token=fixture-gcm-token' : '');
  });
  assert.deepEqual(
    await new GoogleHomePush({ uuid, account: options.session.account, storagePath: options.storagePath }).register(
      new AbortController().signal,
    ),
    { uuid, androidId: '1', securityToken: '2' },
  );
  assert.equal(requests.at(-1).settings.headers.Authorization, 'Bearer fixture-home-oauth');
  assert.equal((await fs.readdir(path.join(directory, 'nest-accfactory'))).length, 1);
  for (let [, other] of [...accounts.entries()].slice(1)) {
    assert.equal(other.homegraphAPI.options.registerPush, undefined);
    assert.equal(other.googleProtobufAPI.options.registerPush, undefined);
  }
});
