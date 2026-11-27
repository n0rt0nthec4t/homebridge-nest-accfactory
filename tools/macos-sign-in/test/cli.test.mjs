// macOS sign-in boundary tests
// Part of homebridge-nest-accfactory
//
// Verify native input, callback validation, cancellation and diagnostic redaction
// with fabricated credentials. Network requests and account sign-in stay disabled.
'use strict';

// Define node.js modules
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Define our modules
import { nativeSessionPost, captureNative, callbackSummary, executable } from '../cli.mjs';
import { exchangeCode } from '../engine.mjs';

// Define fabricated enrollment context
const context = { url: 'https://accounts.google.com/?state=fake-state', redirect_uri: 'com.google.sso.test:/authCallback' };

test('native request changes only the session flag and preserves token request semantics', async () => {
  const calls = [];
  const post = nativeSessionPost(async (...args) => calls.push(args));
  const body = { safari_authentication_session: false, device_challenge_request: 'fake-challenge', client_id: 'fake-client' };
  await post('https://oauthaccountmanager.googleapis.com/v1/authadvice', body, { Test: 'header' });
  assert.equal(body.safari_authentication_session, false);
  assert.deepEqual(calls[0][1], { ...body, safari_authentication_session: true });
  assert.equal(calls[0][1].supported_service, undefined);
  const token = { code: 'fake-code', code_verifier: 'fake-verifier', redirect_uri: context.redirect_uri };
  await post('https://oauth2.googleapis.com/token', token, {});
  assert.equal(calls[1][1], token);
});

test('callback diagnostics expose only categories and field-presence booleans', () => {
  const summary = callbackSummary(context.redirect_uri + '?code=fake-secret&state=fake-state&email=private@example.test');
  assert.deepEqual(summary, {
    scheme: 'com.google.sso.<client>',
    path: '/authCallback',
    hasCode: true,
    hasError: false,
    hasState: true,
    hasAuthorizationCode: false,
    query: { knownFields: ['code', 'state'], otherFieldCount: 1 },
    login: 'absent',
    fragment: { present: false, format: 'absent' },
  });
  assert.equal(JSON.stringify(summary).includes('fake'), false);
  assert.equal(JSON.stringify(summary).includes('private'), false);
  assert.equal(callbackSummary('com.google.sso.test:/other?login=code').hasCode, false);
});

test('code-less native handoffs remain local and fragment diagnostics never expose values or arbitrary names', async () => {
  const callback = context.redirect_uri + '?login=code&private-secret=value#response=private-fragment&code=fake-fragment-code';
  const summary = callbackSummary(callback);
  assert.deepEqual(summary.query, { knownFields: ['login'], otherFieldCount: 1 });
  assert.equal(summary.login, 'code');
  assert.deepEqual(summary.fragment, { present: true, format: 'parameters', knownFields: ['code', 'response'], otherFieldCount: 0 });
  assert.equal(JSON.stringify(summary).includes('private'), false);
  assert.equal(JSON.stringify(summary).includes('fake'), false);
  await assert.rejects(
    exchangeCode({ ...context, url: 'https://accounts.google.com/' }, callback, () => assert.fail('No code, no token request')),
    /No authorization code/,
  );
});

test('callback exchange accepts authorization_code and preserves the attempt verifier', async () => {
  const advice = { ...context, mediatorClientId: 'fake-client', code_verifier: 'fake-verifier', device_id: 'fake-device' };
  const result = await exchangeCode(advice, context.redirect_uri + '?state=fake-state&authorization_code=fake-code', async (_url, body) => {
    assert.equal(body.code, 'fake-code');
    assert.equal(body.code_verifier, 'fake-verifier');
    return { refresh_token: 'fake-refresh' };
  });
  assert.equal(result.refreshToken, 'fake-refresh');
});

test('invalid destinations and cancelled attempts never launch a helper', async () => {
  for (const advice of [
    { ...context, url: 'https://attacker.test/' },
    { ...context, url: 'https://user@accounts.google.com/' },
    { ...context, redirect_uri: 'https://attacker.test/callback' },
  ]) {
    await assert.rejects(captureNative(advice, { helper: '/does-not-exist' }), /Invalid authentication-session/);
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(captureNative(context, { signal: controller.signal, helper: '/does-not-exist' }), /Cancelled/);
});

test(
  'compiled native helper accepts valid private input and rejects invalid input without a browser',
  {
    skip: process.platform !== 'darwin',
  },
  async () => {
    await fs.access(executable);
    assert.deepEqual(await captureNative(context, { selfTest: true }), { status: 'input_valid' });
    const result = await new Promise((resolve, reject) => {
      const child = spawn(executable, ['--self-test'], { stdio: ['pipe', 'pipe', 'ignore'] });
      let output = '';
      child.stdout.on('data', (data) => {
        output += data;
      });
      child.on('error', reject);
      child.on('close', () => resolve(output));
      child.stdin.end(JSON.stringify({ url: 'https://attacker.test/private', scheme: 'com.google.sso.test' }));
    });
    assert.equal(result, '{"status":"invalid_input"}');
  },
);

test('helper output stays private; cancellation and unknown statuses are redacted', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'sso-native-test-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const helper = path.join(folder, 'helper');

  // This local executable models a helper. It verifies the input travels through
  // stdin, not argv, and that the parent never sends its PKCE verifier.
  const source =
    '#!' +
    process.execPath +
    '\n' +
    'let input=""; process.stdin.on("data",d=>input+=d); process.stdin.on("end",()=>{' +
    'const value=JSON.parse(input); if(process.argv.length!==2 || Object.keys(value).sort().join(",")!=="scheme,url")process.exit(1);' +
    'process.stdout.write(JSON.stringify({status:"callback",callback:"com.google.sso.test:/authCallback?code=fake-secret"}));});';
  await fs.writeFile(helper, source, { mode: 0o700 });
  assert.equal(await captureNative(context, { helper }), 'com.google.sso.test:/authCallback?code=fake-secret');
  await fs.writeFile(helper, '#!' + process.execPath + '\nprocess.stdout.write(JSON.stringify({status:"private-secret"}));');
  await assert.rejects(captureNative(context, { helper }), { message: 'Native session: invalid_response' });
  await fs.writeFile(helper, '#!' + process.execPath + '\nsetInterval(()=>{},1000);');
  const controller = new AbortController();
  const pending = captureNative(context, { helper, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { message: 'Cancelled.' });
});
