// Verify account-bound push registration, private persistence and exact 64-bit
// credentials using fabricated network replies; no Google endpoints are contacted.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { importSource } from './helpers/import-source.js';
import { getProtoRoot } from '../src/protobuf.js';
import { GOOGLE_HOME_USER_AGENT } from '../src/consts.js';

let { default: Registration } = await importSource(new URL('../src/api/homegraphpush.js', import.meta.url));
let proto = getProtoRoot(fileURLToPath(new URL('../src/protobuf/googlehome/push.proto', import.meta.url)));
let checkinBytes = Buffer.alloc(18);
checkinBytes[0] = 57;
checkinBytes.writeBigUInt64LE(18446744073709551614n, 1);
checkinBytes[9] = 65;
checkinBytes.writeBigUInt64LE(18446744073709551613n, 10);
const checkin = { androidId: '18446744073709551614', securityToken: '18446744073709551613' };
const install = { refreshToken: 'fixture-fis-refresh', authToken: { token: 'fixture-fis-token', expiresIn: '3600s' } };

async function setup(t, storage = false) {
  let storagePath = storage === true ? await fs.mkdtemp(path.join(os.tmpdir(), 'homegraph-registration-')) : undefined;
  if (storagePath !== undefined) {
    t.after(() => fs.rm(storagePath, { recursive: true, force: true }));
  }
  let account = { name: 'Fixture', refreshToken: 'fixture-sso-secret', authorised: true, oauth2: 'fixture-oauth' };
  let requests = [];
  let flow = { account, requests, storagePath };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    if (flow.respond !== undefined) {
      let response = await flow.respond(url, options);
      if (response !== undefined) {
        return response;
      }
    }
    if (url.endsWith('/installations') === true) {
      return Response.json(install);
    }
    if (url.endsWith('/authTokens:generate') === true) {
      return Response.json(install.authToken);
    }
    if (url.endsWith('/checkin') === true) {
      return new Response(checkinBytes);
    }
    if (url.endsWith('/register3') === true) {
      return new Response('token=fixture-gcm-token');
    }
    assert.equal(url, 'https://notifications-pa.googleapis.com/v1/storetarget');
    return new Response(null, { status: 204 });
  });
  flow.options = { uuid: 'account', account, storagePath };
  flow.registration = new Registration(flow.options);
  flow.signal = new AbortController().signal;
  flow.file = async () => path.join(storagePath, 'nest-accfactory', (await fs.readdir(path.join(storagePath, 'nest-accfactory')))[0]);
  return flow;
}

test('registration installs once, preserves uint64 identities, and rebinds after OAuth refresh', async (t) => {
  let flow = await setup(t, true);
  assert.deepEqual(await flow.registration.register(flow.signal), { uuid: 'account', ...checkin });
  assert.equal(flow.requests.length, 4);
  let request = proto.lookupType('homebridge.nest.push.CheckinRequest').decode(flow.requests[1].options.body);
  assert.equal(request.checkin.build.hardware, 'flo');
  assert.equal(request.version, 3);
  assert.match(JSON.parse(flow.requests[0].options.body).fid, /^[cdef][A-Za-z0-9_-]{21}$/);
  assert.equal(flow.requests[0].options.headers['User-Agent'], GOOGLE_HOME_USER_AGENT);
  assert.equal(flow.requests[0].options.headers['X-Android-Package'], 'com.google.android.apps.chromecast.app');
  assert.equal(flow.requests[0].options.headers['X-Android-Cert'], '24BB24C05E47E0AEFA68A58A766179D9B613A600');
  assert.equal(JSON.parse(flow.requests[0].options.body).appId, '1:498579633514:android:c533a2ef520ccec9');
  let gcm = new URLSearchParams(flow.requests[2].options.body);
  assert.equal(gcm.get('device'), checkin.androidId);
  assert.equal(flow.requests[2].options.headers.Authorization, 'AidLogin ' + checkin.androidId + ':' + checkin.securityToken);
  let target = flow.requests[3];
  assert.equal(target.options.body.includes(Buffer.from('18feffffffffffffffff01', 'hex')), true, 'uint64 must remain exact');
  assert.equal(target.options.headers.Authorization, 'Bearer fixture-oauth');
  for (let { options } of flow.requests) {
    assert.equal(options.redirect, 'error');
  }
  let file = await flow.file();
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  }
  let saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(saved.checkin, checkin);
  assert.equal(JSON.stringify(saved).includes(flow.account.refreshToken), false);
  assert.equal(JSON.stringify(saved).includes(flow.account.oauth2), false);
  assert.deepEqual(await flow.registration.register(flow.signal), { uuid: 'account', ...checkin });
  assert.equal(flow.requests.length, 5);
  flow.account.oauth2 = 'replacement-oauth';
  assert.deepEqual(await flow.registration.register(flow.signal), { uuid: 'account', ...checkin });
  assert.equal(flow.requests.at(-1).options.headers.Authorization, 'Bearer replacement-oauth');
  let restored = new Registration(flow.options);
  await restored.register(flow.signal);
  assert.equal(flow.requests.length, 7, 'restart reuses enrollment and only rebinds its account target');
  assert.equal((await fs.readdir(path.dirname(file))).length, 1, 'no temporary credentials remain');
});

test('expired Firebase installation credentials renew without repeating checkin or GCM enrollment', async (t) => {
  let flow = await setup(t, true);
  await flow.registration.register(flow.signal);
  let file = await flow.file();
  let saved = JSON.parse(await fs.readFile(file, 'utf8'));
  saved.fisExpires = 0;
  await fs.writeFile(file, JSON.stringify(saved));
  flow.requests.length = 0;
  await new Registration(flow.options).register(flow.signal);
  assert.equal(flow.requests.length, 2);
  assert.equal(flow.requests[0].url.endsWith('/authTokens:generate'), true);
  assert.equal(flow.requests[0].options.headers.Authorization, 'FIS_v2 fixture-fis-refresh');
});

for (let stage of ['installations', 'checkin', 'register3', 'storetarget']) {
  test('registration failures are private and retryable by the push owner: ' + stage, async (t) => {
    let flow = await setup(t);
    flow.respond = (url) =>
      url.endsWith('/' + stage) === true ? new Response('fixture-private-response-secret', { status: 403 }) : undefined;
    await assert.rejects(flow.registration.register(flow.signal), /^Error: Google Home push registration failed$/);
    flow.respond = undefined;
    assert.deepEqual(await flow.registration.register(flow.signal), { uuid: 'account', ...checkin });
  });
}

for (let [stage, response] of [
  ['installations', () => Response.json({})],
  ['installations', () => Response.json({ ...install, authToken: { token: 'private', expiresIn: 'invalid' } })],
  ['checkin', () => new Response(Buffer.from([57, 1]))],
  ['checkin', () => new Response(Buffer.alloc(0))],
  ['checkin', () => new Response(Buffer.from([8, 1]))],
  ['register3', () => new Response('Error=private-secret')],
  ['register3', () => new Response('token=bad\nvalue')],
  ['installations', () => new Response(Buffer.alloc(1024 * 1024 + 1))],
]) {
  test('malformed or oversized registration reply is rejected: ' + stage, async (t) => {
    let flow = await setup(t);
    flow.respond = (url) => (url.endsWith('/' + stage) === true ? response() : undefined);
    await assert.rejects(flow.registration.register(flow.signal), /^Error: Google Home push registration failed$/);
  });
}

for (let retired of ['aborted', 'unauthorised', 'replaced']) {
  test('late registration cannot bind a retired account: ' + retired, async (t) => {
    let flow = await setup(t);
    let controller = new AbortController();
    flow.respond = (url) => {
      if (url.endsWith('/installations') === true) {
        if (retired === 'aborted') {
          controller.abort();
        } else if (retired === 'unauthorised') {
          flow.account.authorised = false;
        } else {
          flow.account.oauth2 = 'new-oauth';
        }
        return Response.json(install);
      }
    };
    await assert.rejects(flow.registration.register(controller.signal), /Google Home push registration failed/);
    assert.equal(flow.requests.length, 1);
  });
}

test('already aborted or unavailable sessions cannot start registration', async (t) => {
  let flow = await setup(t);
  await assert.rejects(flow.registration.register(AbortSignal.abort()), /Google Home push registration failed/);
  flow.account.oauth2 = undefined;
  await assert.rejects(flow.registration.register(flow.signal), /Google Home push registration failed/);
  assert.equal(flow.requests.length, 0);
});

for (let invalid of ['binding', 'version', 'fid', 'checkin', 'gcmToken', 'fis', 'permissions', 'size', 'symlink', 'json']) {
  test(
    'invalid private receiver storage cannot be used: ' + invalid,
    {
      skip: process.platform === 'win32' && ['permissions', 'symlink'].includes(invalid),
    },
    async (t) => {
      let flow = await setup(t, true);
      await flow.registration.register(flow.signal);
      let file = await flow.file();
      let value = JSON.parse(await fs.readFile(file, 'utf8'));
      if (invalid === 'permissions') {
        await fs.chmod(file, 0o644);
      } else if (invalid === 'size') {
        await fs.writeFile(file, Buffer.alloc(65537));
      } else if (invalid === 'symlink') {
        await fs.rename(file, file + '.original');
        await fs.symlink(file + '.original', file);
      } else if (invalid === 'json') {
        await fs.writeFile(file, 'invalid-json');
      } else {
        value[invalid] =
          invalid === 'binding'
            ? 'another-account'
            : invalid === 'checkin'
              ? { androidId: '18446744073709551616', securityToken: '1' }
              : invalid === 'fis'
                ? {}
                : invalid === 'gcmToken'
                  ? 'bad value'
                  : 'invalid';
        await fs.writeFile(file, JSON.stringify(value));
      }
      flow.requests.length = 0;
      await assert.rejects(new Registration(flow.options).register(flow.signal), /^Error: Google Home push registration failed$/);
      assert.equal(flow.requests.length, 0);
    },
  );
}

test('failed private persistence never reports successful registration', async (t) => {
  let flow = await setup(t, true);
  // Fail the actual save consistently: blocked parent paths can report ENOENT
  // on Windows but ENOTDIR on Unix, stopping registration at different stages.
  t.mock.method(fs, 'writeFile', async () => {
    throw Object.assign(new Error('Fixture persistence failure'), { code: 'EACCES' });
  });
  await assert.rejects(flow.registration.register(flow.signal), /Google Home push registration failed/);
  assert.equal(flow.requests.length, 1, 'Failed enrollment persistence must stop before checkin, GCM and target registration');
  assert.equal(flow.requests[0].url.endsWith('/installations'), true);
  assert.deepEqual(await fs.readdir(path.join(flow.storagePath, 'nest-accfactory')), [], 'No partial receiver file remains');
});
