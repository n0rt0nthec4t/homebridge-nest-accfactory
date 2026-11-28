// macOS Google Home sign-in command
// Part of homebridge-nest-accfactory
//
// Runs native Google sign-in and prints persistent credentials for account setup.
//
// Responsibilities:
// - Build the native authentication-session helper with local Apple tools
// - Keep PKCE in Node and pass only presentation input through private pipes
// - Validate callback responses and print credentials for deliberate UI copying
//
// Ownership:
// - This command owns the helper process, cancellation and enrollment attempt
// - The user owns copying credentials and saving account configuration
//
// Code version 2026.11.28
'use strict';

/* eslint-disable no-console -- This command prints progress and credentials for deliberate user copying. */

// Define node.js modules
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Define our modules
import { loadRuntime, googlePost, exchangeCode, GoogleRequestError, ChallengeProcessingError, CallbackInputError } from './engine.mjs';

// Define constants
const directory = fileURLToPath(new URL('./mac-helper/', import.meta.url));
const appPath = path.join(directory, 'build', 'Nest Accfactory Sign-in.app');
export const executable = path.join(appPath, 'Contents', 'MacOS', 'SSOTest');
const run = promisify(execFile);

export class NativeTestError extends Error {}

// A translated Node process must not choose the helper's Intel slice on Apple
// Silicon. The native ARM system executable probes CPU support without Rosetta.
export async function requireNativeRuntime(architecture = process.arch, execute = run) {
  if (architecture === 'arm64') {
    return;
  }
  if (architecture !== 'x64') {
    throw new NativeTestError('This helper requires native Apple Silicon or Intel Node.js.');
  }

  let appleSilicon = false;
  try {
    await execute('/usr/bin/arch', ['-arm64', '/usr/bin/true']);
    appleSilicon = true;
  } catch (error) {
    // arch exits with status 1 when the CPU cannot execute the requested slice.
    // Other failures cannot establish which architecture is safe to launch.
    if (error.code !== 1) {
      throw new NativeTestError('Unable to verify the native Mac architecture.');
    }
  }
  if (appleSilicon === true) {
    throw new NativeTestError('Use native Apple Silicon Node.js or the arm64 download. Rosetta execution is not supported.');
  }
}

export async function buildHelper(signal) {
  // Build only on macOS, where the SDK and native authentication APIs are available.
  if (process.platform !== 'darwin') {
    throw new NativeTestError('This helper requires macOS.');
  }

  // Sign outside cloud-synced folders, which can reattach Finder metadata
  // between cleanup and codesign. Cache the finished app for subsequent runs.
  console.log('Building the local macOS authentication helper...');
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'nest-sign-in-native-'));
  const stagedApp = path.join(staging, path.basename(appPath));
  const stagedExecutable = path.join(stagedApp, 'Contents/MacOS/SSOTest');
  try {
    await fs.mkdir(path.dirname(stagedExecutable), { recursive: true, mode: 0o700 });
    await fs.copyFile(path.join(directory, 'Info.plist'), path.join(stagedApp, 'Contents', 'Info.plist'));

    // Keep the cached app universal: an Intel build must not replace the native
    // Apple Silicon helper with an Intel-only executable in a shared checkout.
    const slices = [];
    for (const architecture of ['arm64', 'x86_64']) {
      const slice = path.join(staging, architecture);
      await run(
        '/usr/bin/xcrun',
        [
          'swiftc',
          path.join(directory, 'Session.swift'),
          '-o',
          slice,
          '-target',
          architecture + '-apple-macosx12.0',
          '-module-cache-path',
          path.join(directory, 'build', 'ModuleCache'),
          '-framework',
          'AppKit',
          '-framework',
          'AuthenticationServices',
        ],
        { signal, timeout: 60000, maxBuffer: 1024 * 1024 },
      );
      slices.push(slice);
    }
    await run('/usr/bin/lipo', ['-create', ...slices, '-output', stagedExecutable], { signal, timeout: 15000 });

    // iCloud can attach Finder/resource-fork metadata to new bundle files, which
    // codesign rejects. Clear it only from this freshly generated helper app.
    await run('/usr/bin/xattr', ['-cr', stagedApp], { signal, timeout: 15000 });
    await run('/usr/bin/codesign', ['--force', '--sign', '-', stagedApp], { signal, timeout: 15000 });
    await fs.rm(appPath, { recursive: true, force: true });
    await fs.mkdir(path.dirname(appPath), { recursive: true });
    await fs.cp(stagedApp, appPath, { recursive: true });
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

// The native-session flag belongs only to authadvice. The token request retains
// PKCE verifier, client and redirect binding unchanged.
export function nativeSessionPost(post = googlePost) {
  return (url, body, headers) =>
    post(
      url,
      url === 'https://oauthaccountmanager.googleapis.com/v1/authadvice' ? { ...body, safari_authentication_session: true } : body,
      headers,
    );
}

export function callbackSummary(value) {
  // Categorise callback structure without exposing account values or arbitrary field names.
  const url = new URL(value);

  // Print only known protocol field names, never arbitrary names or values.
  // A returned app URL can also be an intermediate handoff, not an OAuth code.
  const known = [
    'code',
    'authorization_code',
    'error',
    'error_description',
    'state',
    'login',
    'action',
    'response',
    'continue',
    'redirect_uri',
    'access_token',
    'id_token',
    'token',
    'authuser',
    'scope',
    'sso',
  ];
  const fields = (params) => ({
    knownFields: [...new Set(params.keys())].filter((key) => known.includes(key) === true).sort(),
    otherFieldCount: [...new Set(params.keys())].filter((key) => known.includes(key) !== true).length,
  });
  let fragment = url.hash.slice(1);
  const fragmentParams = new URLSearchParams(fragment.startsWith('?') === true ? fragment.slice(1) : fragment);
  return {
    scheme: url.protocol.startsWith('com.google.sso.') === true ? 'com.google.sso.<client>' : 'other',
    path: url.pathname === '/authCallback' ? '/authCallback' : 'other',
    hasCode: url.searchParams.has('code'),
    hasError: url.searchParams.has('error'),
    hasState: url.searchParams.has('state'),
    hasAuthorizationCode: url.searchParams.has('authorization_code'),
    query: fields(url.searchParams),
    login: url.searchParams.get('login') === 'code' ? 'code' : url.searchParams.has('login') === true ? 'other' : 'absent',
    fragment: {
      present: fragment.length > 0,
      format: fragment.length === 0 ? 'absent' : fragment.includes('=') === true ? 'parameters' : 'opaque',
      ...(fragment.includes('=') === true ? fields(fragmentParams) : {}),
    },
  };
}

export async function captureNative(advice, { signal, helper = executable, selfTest = false } = {}) {
  // Reject presentation destinations outside the Google authentication boundary.
  const url = new URL(advice.url);
  const redirect = new URL(advice.redirect_uri);
  if (
    url.origin !== 'https://accounts.google.com' ||
    url.username !== '' ||
    url.password !== '' ||
    /^com\.google\.sso\.[A-Za-z0-9.-]+:$/u.test(redirect.protocol) !== true
  ) {
    throw new NativeTestError('Invalid authentication-session context.');
  }
  if (signal?.aborted === true) {
    throw new NativeTestError('Cancelled.');
  }

  // The child receives only URL and callback scheme; PKCE stays in this process.
  return new Promise((resolve, reject) => {
    const child = spawn(helper, selfTest === true ? ['--self-test'] : [], {
      shell: false,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled === true) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (error !== undefined) {
        child.kill('SIGTERM');

        // A failed/unresponsive helper must not keep cancellation alive.
        const force = setTimeout(() => child.kill('SIGKILL'), 1000);
        force.unref();
        reject(error);
      } else {
        resolve(result);
      }
    };
    const cancel = () => finish(new NativeTestError('Cancelled.'));
    const timer = setTimeout(() => finish(new NativeTestError('Authentication session expired.')), selfTest === true ? 10000 : 16 * 60000);
    signal?.addEventListener('abort', cancel, { once: true });

    // Bound pipe output and reduce failures to known statuses before returning them.
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > 65536) {
        finish(new NativeTestError('Invalid native-helper response.'));
      }
    });
    child.stdin.on('error', () => finish(new NativeTestError('Native helper input failed.')));
    child.once('error', () => finish(new NativeTestError('Unable to launch native helper.')));
    child.once('close', () => {
      try {
        const result = JSON.parse(output);
        if (selfTest === true && result.status === 'input_valid') {
          finish(undefined, result);
        } else if (result.status === 'callback' && typeof result.callback === 'string' && result.callback.length <= 32768) {
          finish(undefined, result.callback);
        } else {
          const statuses = ['cancelled', 'expired', 'session_failed', 'start_failed', 'invalid_input'];
          const status = statuses.includes(result.status) === true ? result.status : 'invalid_response';
          finish(new NativeTestError('Native session: ' + status));
        }
      } catch {
        finish(new NativeTestError('Invalid native-helper response.'));
      }
    });
    child.stdin.end(JSON.stringify({ url: url.href, scheme: redirect.protocol.slice(0, -1) }));
  });
}

async function main() {
  // Offline verification exercises compilation and the pipe without contacting Google.
  const { values } = parseArgs({ options: { check: { type: 'boolean' }, help: { type: 'boolean' }, prebuilt: { type: 'boolean' } } });
  if (values.help === true) {
    console.log('node tools/macos-sign-in/cli.mjs [--check]');
    return;
  }

  // A single cancellation signal retires network work and native presentation.
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  try {
    // Downloaded bundles contain a compiled helper and never invoke Apple build tools.
    if (values.prebuilt === true) {
      try {
        await fs.access(executable, constants.X_OK);
      } catch {
        throw new NativeTestError('The native helper is missing. Extract a fresh copy of the download.');
      }
    }
    await requireNativeRuntime();
    if (values.prebuilt !== true) {
      await buildHelper(controller.signal);
    }
    if (values.check === true) {
      await captureNative(
        { url: 'https://accounts.google.com/', redirect_uri: 'com.google.sso.test:/authCallback' },
        {
          selfTest: true,
          signal: controller.signal,
        },
      );
      loadRuntime();
      console.log('Mac helper, private pipe and SSO context ready. No Google requests made.');
      return;
    }

    // Keep one enrollment context through advice, native callback and code exchange.
    const post = nativeSessionPost((url, body, headers) =>
      googlePost(url, body, headers, (endpoint, options) =>
        fetch(endpoint, {
          ...options,
          signal: AbortSignal.any([options.signal, controller.signal]),
        }),
      ),
    );
    console.log('Preparing Google sign-in for a native authentication session...');
    const advice = await loadRuntime({ post }).advice();
    console.log('Complete sign-in in the system browser. Ctrl+C or close the helper window to cancel.');
    const callback = await captureNative(advice, { signal: controller.signal });
    const summary = callbackSummary(callback);
    console.log('Native callback received: ' + JSON.stringify(summary));

    // Validate code or authorization_code against this attempt before token I/O;
    // intermediate app handoffs without an authorization code cannot be exchanged.
    const account = await exchangeCode(advice, callback, post);
    controller.signal.throwIfAborted();

    // Credential output is intentional: this standalone tool supplies the UI
    // fields. It does not save user credentials or write plugin configuration.
    console.log('Copy into the account fields in Homebridge:');
    console.log('Refresh token:');
    console.log(account.refreshToken);
    console.log('Device ID:');
    console.log(account.deviceId);
  } finally {
    process.off('SIGINT', cancel);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (error instanceof NativeTestError || error instanceof GoogleRequestError || error instanceof CallbackInputError) {
      console.error(error.message);
    } else if (error instanceof ChallengeProcessingError) {
      console.error('Challenge failed: ' + error.code);
    } else {
      console.error('Sign-in stopped. Check Xcode command-line tools and callback completion.');
    }
    process.exitCode = 1;
  });
}
