// Google SSO challenge engine
// Part of homebridge-nest-accfactory
//
// Processes Google enrollment challenges and validates their callback exchange.
//
// Responsibilities:
// - Load and validate the bundled reflection context and enrollment schema
// - Execute bounded challenge workers and provide simulated Objective-C operations
// - Request sign-in advice and exchange a validated callback using PKCE
//
// Ownership:
// - Each enrollment attempt owns its device identity, verifier and challenge state
// - Workers own guest execution; the caller owns native presentation and cancellation
//
// Code version 2026.11.28
'use strict';

// Define node.js modules
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

// Define external modules
import protobuf from 'protobufjs';

// Define our modules
import { getProtoRoot } from '../../src/protobuf.js';

// Define constants
const LIMIT = 2 * 1024 * 1024;

// One advertised device profile for the HTTP request, protobuf challenge and
// sign-in user agent. Updating these strings does not replace the SDK model or
// establish that simulated runtime observations match this iOS release.
const DEVICE = Object.freeze({ model: 'iPhone17,3', os: '26.2', build: '23C55' });
const BRIDGE = '(' + bridge.toString() + ')()';
const ADVICE = 'https://oauthaccountmanager.googleapis.com/v1/authadvice';
const CHALLENGE_FAILURE_CODES = new Set([
  'WORKER_FAILED',
  'WORKER_TIMEOUT',
  'BRIDGE_FAILED',
  'SETUP_FAILED',
  'CHALLENGE_SCRIPT_FAILED',
  'CHALLENGE_NOT_FUNCTION',
  'CHALLENGE_CALL_FAILED',
  'UNSUPPORTED_CLASS',
  'UNSUPPORTED_SELECTOR',
  'UNSUPPORTED_SYMBOL',
  'UNSUPPORTED_MEMORY_READ',
  'UNKNOWN_TYPE_ENCODING',
  'RESPONSE_INVALID',
]);

const CONTEXT_HASH = '8b66b8796143febbe78c62deef586383ab11ca0d21f6d987beb549eb0d22f434';

// Preserve the exact fixed64 wire values despite the shared loader disabling
// protobufjs Long objects. This reader override is local to SSO decoding.
export function decode(type, bytes) {
  const reader = protobuf.Reader.create(bytes);
  reader.fixed64 = () => ({ low: reader.fixed32(), high: reader.fixed32(), unsigned: true });
  return type.decode(reader);
}

export function readContext() {
  // Check compressed size and the expected digest before bounded decompression.
  const file = new URL('./context.json.gz', import.meta.url);
  if (fs.statSync(file).size > 2 * 1024 * 1024) {
    throw new Error('SSO context too large');
  }
  const bytes = fs.readFileSync(file);
  if (bytes.length > 2 * 1024 * 1024 || crypto.createHash('sha256').update(bytes).digest('hex') !== CONTEXT_HASH) {
    throw new Error('SSO context integrity check failed');
  }

  return JSON.parse(zlib.gunzipSync(bytes, { maxOutputLength: 8 * 1024 * 1024 }));
}

// Index SDK declarations for class, method and framework lookups. Reject
// out-of-range indexes before dispatching simulated runtime operations.
export class RuntimeDatabase {
  constructor(model) {
    // Retain a serialisable model for workers and index selectors for local lookup.
    this.model = { images: model.images, classes: model.classes };
    this.images = new Map(model.images.map((text) => [text, { text, classes: [] }]));
    this.classes = new Map(
      model.classes.map(([text, superclass, image, entries]) => {
        const methods = entries.map(([selector, encoding], methodIdx) => ({ selector, encoding, methodIdx, class: text, image }));
        return [text, { text, superclass, image, methods, selectors: new Map(methods.map((entry) => [entry.selector, entry])) }];
      }),
    );
    this.records = { classes: [...this.classes.values()], images: [...this.images.values()] };
    for (const record of this.classes.values()) {
      if (record.image !== null) {
        this.records.images[record.image].classes.push(record.text);
      }
    }
  }

  record(name, index) {
    if (Object.hasOwn(this.records, name) !== true || Number.isInteger(index) !== true || index < 0 || index >= this.records[name].length) {
      throw new Error('Invalid model index');
    }

    return this.records[name][index];
  }

  isClass(name) {
    return this.classes.has(name);
  }

  classRecord(name) {
    return this.classes.get(name);
  }

  classImage(name) {
    const image = this.classes.get(name)?.image;
    return image === null || image === undefined ? undefined : this.record('images', image).text;
  }

  method(name, index) {
    const value = Number.isInteger(index) === true && index >= 0 ? this.classes.get(name)?.methods[index] : undefined;
    if (value === undefined) {
      throw new Error('Invalid model method index');
    }

    return value;
  }

  methodImage(name, index) {
    const image = this.method(name, index).image;
    return image === null ? null : this.record('images', image).text;
  }

  findMethod(name, selector) {
    // Resolve inherited methods in superclass order, matching Objective-C lookup.
    for (let entry = this.classes.get(name); entry !== undefined; entry = this.classes.get(entry.superclass)) {
      if (entry.selectors.has(selector) === true) {
        return entry.selectors.get(selector);
      }
    }
  }

  imageClasses(name) {
    return this.images.get(name)?.classes ?? null;
  }
}

// Diagnostics contain only fixed identifiers, never remote messages or arguments.
export class ChallengeProcessingError extends Error {
  constructor(code, response = false) {
    super(response === true ? 'Local iOSGuard response rejected' : 'Local iOSGuard challenge failed');
    this.code = CHALLENGE_FAILURE_CODES.has(code) === true ? code : 'WORKER_FAILED';
  }
}

export function createChallengeRuntime({ database, appInfo, receipt, jsValueOffsets, deviceId, bundleInstanceId }) {
  // Each execution owns a worker so timeouts and failures retire its guest state.
  return {
    async execute(setupCode, challengeCode) {
      if (typeof setupCode !== 'string' || typeof challengeCode !== 'string' || setupCode.length + challengeCode.length > LIMIT) {
        throw new Error('Invalid local challenge input');
      }

      // A VM timeout can disturb Node async hooks. The worker owns its VM and all
      // callbacks; its watchdog also covers initialization and native bridge work.
      const worker = new Worker(new URL(import.meta.url), {
        execArgv: [],
        env: {},
        resourceLimits: { maxOldGenerationSizeMb: 128 },
        workerData: {
          model: database.model,
          appInfo,
          receipt,
          jsValueOffsets,
          deviceId,
          bundleInstanceId,
          setupCode,
          challengeCode,
        },
      });
      let timer;
      try {
        return await new Promise((resolve, reject) => {
          const fail = (code) => reject(new ChallengeProcessingError(code));
          timer = setTimeout(() => fail('WORKER_TIMEOUT'), 10000);
          worker.once('error', () => fail('WORKER_FAILED'));
          worker.once('exit', () => fail('WORKER_FAILED'));
          worker.once('message', (message) => {
            if (typeof message?.result !== 'string' || message.result.length === 0 || message.result.length > LIMIT) {
              fail(message?.code);
            } else {
              resolve(message.result);
            }
          });
        });
      } finally {
        clearTimeout(timer);
        await worker.terminate();
      }
    },
  };
}

// Internal worker entry point. The parent uses only primitive result/error messages.
export function createChallengeRealm({ database, appInfo, receipt, jsValueOffsets, deviceId, bundleInstanceId }) {
  return {
    execute(setupCode, challengeCode) {
      if (typeof setupCode !== 'string' || typeof challengeCode !== 'string' || setupCode.length + challengeCode.length > LIMIT) {
        throw new Error('Invalid local challenge input');
      }

      // Track allocation across host operations, including compressed and encoded data.
      let allocated = 0;
      let bridgeFailure;
      let stage = 'BRIDGE_FAILED';
      const reportFailure = (code) => {
        if (CHALLENGE_FAILURE_CODES.has(code) === true) {
          bridgeFailure = code;
        }
      };
      const reserve = (length) => {
        if (Number.isSafeInteger(length) !== true || length < 0 || length > LIMIT || allocated + length > 8 * LIMIT) {
          throw new Error('Data allocation limit exceeded');
        }
        allocated += length;
      };
      const base64 = (value, source, target) => {
        if (typeof value !== 'string' || value.length > LIMIT) {
          throw new Error('Invalid base64 input');
        }
        reserve(value.length);
        return Buffer.from(value, source).toString(target);
      };

      // Expose the bounded data and reflection operations required by the challenge.
      const host = Object.freeze({
        reportFailure,
        deviceId,
        bundleInstanceId,
        appInfo: JSON.stringify(appInfo),
        jsValueOffsets: Object.freeze([...jsValueOffsets]),
        hasReceipt: Buffer.isBuffer(receipt) === true && receipt.length > 0,
        receipt: () => {
          reserve(receipt.length);
          return Buffer.from(receipt);
        },
        allocate(length) {
          reserve(length);
          return Buffer.alloc(length);
        },
        gzip: (buffer, offset, length) => {
          if (
            Buffer.isBuffer(buffer) !== true ||
            Number.isSafeInteger(offset) !== true ||
            offset < 0 ||
            Number.isSafeInteger(length) !== true ||
            length < 0 ||
            offset + length > buffer.length
          ) {
            throw new Error('Invalid gzip memory range');
          }
          reserve(length);
          return zlib.gzipSync(buffer.subarray(offset, offset + length), { maxOutputLength: LIMIT });
        },
        decodeBase64: (value) => base64(value, 'base64', 'binary'),
        encodeBase64: (value) => base64(value, 'binary', 'base64'),
        isClass: (name) => database.isClass(name),
        lookupMethod: (name, selector) => {
          const method = database.findMethod(name, selector);
          return method === undefined ? undefined : { class: method.class, methodIdx: method.methodIdx };
        },
        methodSignature: (name, index) => {
          const encoding = database.method(name, index).encoding;
          if (encoding === null) {
            reportFailure('UNKNOWN_TYPE_ENCODING');
            throw new Error('Unsupported model type signature');
          }
          return encoding;
        },
        classCount: database.classes.size,
        imageCount: database.images.size,
        methodCount: (name) => database.classRecord(name)?.methods.length ?? 0,
        classImage: (name) => database.classImage(name),
        methodName: (name, index) => database.method(name, index).selector,
        methodImage: (name, index) => database.methodImage(name, index),
        imageName: (index) => database.record('images', index).text,
        className: (index) => database.record('classes', index).text,
        imageClassCount: (name) => database.imageClasses(name)?.length ?? null,
        imageClass: (name, index) => database.imageClasses(name)?.[index] ?? '',
      });

      // Keep guest microtasks within evaluation deadlines and disable WebAssembly.
      const context = vm.createContext(
        { __runtimeHost: host, console: Object.freeze({ log() {}, warn() {}, error() {} }) },
        {
          microtaskMode: 'afterEvaluate',
          codeGeneration: { strings: true, wasm: false },
        },
      );
      const run = (source, filename) => vm.runInContext(source, context, { timeout: 2000, filename });
      try {
        run(BRIDGE, 'local-objc-bridge.vm');
        stage = 'SETUP_FAILED';
        run(setupCode, 'device_challenge_setup.vm');

        // Evaluation and both returned function invocations stay under one deadline.
        // Copy only a primitive string out of the realm, never guest objects/getters.
        stage = 'CHALLENGE_SCRIPT_FAILED';

        // A challenge is a Script, not necessarily one JavaScript expression.
        // Preserve completion values and trailing semicolons; define the returned
        // function directly without invoking a guest setter outside a deadline.
        const challenge = run(challengeCode, 'device_challenge.vm');
        if (typeof challenge !== 'function') {
          stage = 'CHALLENGE_NOT_FUNCTION';
          throw new Error();
        }
        Object.defineProperty(context, '__challengeFunction', { value: challenge });
        stage = 'CHALLENGE_CALL_FAILED';
        const result = run(
          '(function __executeChallenge() {' +
            'const result = __challengeFunction(__createEnvironment())({});' +
            'if (typeof result !== "string" || result.length === 0 || result.length > 2097152 ||' +
            '__runtimeStats().failed === true) throw new Error();' +
            'return result;' +
            '})()',
          'local-challenge-execution.vm',
        );
        return result;
      } catch {
        // Challenge exceptions and stack frames can contain account/challenge data.
        throw new ChallengeProcessingError(bridgeFailure ?? stage);
      }
    },
  };
}

const TOKEN = 'https://oauth2.googleapis.com/token';

export class GoogleRequestError extends Error {
  constructor(url, status, code) {
    let allowed = [
      'invalid_scope',
      'invalid_grant',
      'invalid_client',
      'unauthorized_client',
      'access_denied',
      'invalid_request',
      'immediate_failed',
      'login_required',
      'interaction_required',
      'UNAUTHENTICATED',
      'PERMISSION_DENIED',
      'INVALID_ARGUMENT',
    ];
    super(
      'Google request failed: ' +
        new URL(url).pathname +
        (Number.isInteger(status) === true ? ' (HTTP ' + status + ')' : '') +
        (allowed.includes(code) === true ? '; ' + code : ''),
    );
  }
}

// Fixed URLs, no redirects, normal TLS validation and bounded response reads. Backend
// descriptions and request bodies may contain credentials, so errors expose only stage/status.
export async function googlePost(url, body, headers = {}, fetchImpl = fetch) {
  if ([ADVICE, TOKEN].includes(url) !== true) {
    throw new Error('Unsupported Google endpoint');
  }
  let form = body instanceof URLSearchParams;
  let response;
  let code;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
      headers: { ...headers, 'Content-Type': form === true ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: form === true ? body.toString() : JSON.stringify(body),
    });
    let chunks = [],
      length = 0;
    for await (let chunk of response.body) {
      length += chunk.length;
      if (length > 2 * 1024 * 1024) {
        throw new Error('Response too large');
      }
      chunks.push(chunk);
    }
    let data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (response.ok !== true || data.error !== undefined) {
      code = typeof data.error === 'string' ? data.error : data.error?.status;
      throw new Error('Google rejected request');
    }

    return data;
  } catch {
    throw new GoogleRequestError(url, response?.status, code);
  }
}

/**
 * Prepare one enrollment attempt. advice() contacts Google and returns a private
 * object containing its browser URL, verifier and generated device ID. Pass that
 * object and the captured callback to exchangeCode(); keep it out of logs.
 * @param {{post?: Function, flow?: 'server'}} [options] HTTP adapter and optional server-selected routing mode.
 * @returns {{advice: Function}} Enrollment using this attempt's generated device context.
 */
export function loadRuntime({ post = googlePost, flow } = {}) {
  if (flow !== undefined && flow !== 'server') {
    throw new Error('Custom sign-in routes did not complete SSO and are no longer supported');
  }
  if (typeof post !== 'function') {
    throw new Error('Local runtime requires an HTTP adapter');
  }

  // Keep device identity, client binding and challenge state local to this attempt.
  const data = readContext();
  const database = new RuntimeDatabase(data);
  const receipt = Buffer.from(data.receipt, 'base64');
  const schema = getProtoRoot(fileURLToPath(new URL('./iosguard.proto', import.meta.url)));
  if (schema === undefined) {
    throw new Error('SSO schema unavailable');
  }
  const appInfo = data.appInfo;
  const deviceId = crypto.randomUUID().toUpperCase();
  const bundleInstanceId = crypto.randomUUID().toUpperCase();
  const scheme = (appInfo.CFBundleURLTypes ?? [])
    .flatMap((entry) => entry.CFBundleURLSchemes ?? [])
    .find((value) => typeof value === 'string' && value.startsWith('com.google.sso.') === true);
  if (scheme === undefined) {
    throw new Error('Missing SSO app context');
  }
  const clientId = scheme.split('.').at(-1) + '.apps.googleusercontent.com';
  const redirect = scheme + ':/authCallback';
  const mediatorClientId = '936475272427.apps.googleusercontent.com';
  const userAgent =
    appInfo.CFBundleIdentifier +
    '/' +
    appInfo.CFBundleShortVersionString +
    ' iSL/3.4 iPhone/' +
    DEVICE.os +
    ' hw/' +
    DEVICE.model.replace(',', '_') +
    ' (gzip)';
  let busy = false;
  const challengeRuntime = createChallengeRuntime({
    database,
    appInfo,
    receipt,
    jsValueOffsets: data.jsValueOffsets,
    deviceId,
    bundleInstanceId,
  });
  const encode = (name, value) =>
    schema
      .lookupType('google.iosguard.' + name)
      .encode(value)
      .finish();
  const pack = (outer, inner, value) =>
    Buffer.from(encode(outer, { data: { data: zlib.deflateSync(encode(inner, value)), format: [1] } }))
      .toString('base64')
      .replaceAll('+', '-')
      .replaceAll('/', '_');
  const unpack = (outer, inner, value) => {
    if (typeof value !== 'string' || value.length > LIMIT * 2) {
      throw new Error('Invalid challenge envelope');
    }
    const envelope = decode(schema.lookupType('google.iosguard.' + outer), Buffer.from(value, 'base64'));
    if (envelope.data?.format.includes(1) !== true || envelope.data.format.some((format) => [1, 4].includes(format) !== true) === true) {
      throw new Error('Unsupported challenge compression');
    }

    // ECDSA signature metadata is not verified here. HTTPS
    // authenticates the fixed endpoint; local hashes only check asset consistency.
    return decode(schema.lookupType('google.iosguard.' + inner), zlib.inflateSync(envelope.data.data, { maxOutputLength: LIMIT }));
  };
  return {
    async advice() {
      if (busy === true) {
        throw new Error('Local enrollment already in progress');
      }
      busy = true;
      let received = false;
      try {
        // Build the request before I/O; the request ID binds the encoded response
        // to this challenge, and busy prevents overlapping use of client state.
        const bytes = crypto.randomBytes(8);
        const requestId = { low: bytes.readUInt32LE(0), high: bytes.readUInt32LE(4), unsigned: true };
        const body = {
          external_browser: true,
          report_user_id: true,
          system_version: DEVICE.os,
          app_version: appInfo.CFBundleShortVersionString,
          user_id: [],

          // The presentation adapter sets this flag for a native authentication
          // session; the engine's default describes an external browser.
          safari_authentication_session: false,

          // No supported_service is advertised because the helper implements
          // callback capture rather than an additional app-service handler.
          request_trigger: 'ADD_ACCOUNT',
          lib_ver: '3.4',
          package_name: appInfo.CFBundleIdentifier,
          redirect_uri: redirect,
          device_name: 'iPhone',
          client_id: clientId,
          mediator_client_id: mediatorClientId,
          device_id: deviceId,
          hl: 'en-US',
          device_model: DEVICE.model,
          device_challenge_request: pack('DeviceChallengeRequest', 'IGRequest', {
            requestFlags: 36,
            appVersion: appInfo.CFBundleVersion,
            deviceModel: DEVICE.model,
            deviceOsVersion: DEVICE.os,
            executionTiming1: 0.000065,
            executionTiming2: 0.000075,
            requestFlags2: 16777228,
            requestFlags3: 8,
            appName: appInfo.CFBundleIdentifier,
            deviceOsBuild: DEVICE.build,
            requestId,
          }),
        };
        const response = await post(ADVICE, body, { 'User-Agent': userAgent, 'Accept-Language': 'en-US,en;q=0.9' });
        received = true;

        // Decode bounded protobuf/zlib envelopes before executing any JS. An
        // immediate response bypasses the bridge but retains challenge/request IDs.
        const setup = unpack(
          'DeviceChallengeSetup',
          'DeviceChallengeSetupDecompressed',
          response.iosguard_challenge?.device_challenge_setup,
        );
        const challenge = unpack('DeviceChallenge', 'DeviceChallengeDecompressed', response.iosguard_challenge?.device_challenge);
        let result;
        if (setup.jsCode !== '' && challenge.jsCode !== '') {
          result = await challengeRuntime.execute(setup.jsCode, challenge.jsCode);
        } else if (challenge.responseCode !== '') {
          result = challenge.responseCode;
        } else {
          throw new Error('Unsupported local challenge format');
        }
        const igresponse = pack('IGResponse', 'DeviceResponse', {
          igdResult: result,
          executionTimings: { part1: 0.008, part2: 0.07, part3: 0.005, part4: 0.000001 },
          deviceChallengeId: challenge.deviceChallengeId,
          requestId,
        });
        const url = new URL(decodeURIComponent(response.uri));
        if (
          url.origin !== 'https://accounts.google.com' ||
          url.username !== '' ||
          url.password !== '' ||
          typeof response.code_verifier !== 'string' ||
          response.code_verifier.length === 0 ||
          response.code_verifier.length > 1024
        ) {
          throw new Error('Invalid local sign-in response');
        }

        // Preserve the issued authorization entry and its PKCE binding.
        url.hash = new URLSearchParams({ igresponse }).toString();
        return {
          url: url.href,
          code_verifier: response.code_verifier,
          device_id: deviceId,
          client_id: clientId,
          redirect_uri: redirect,
          mediatorClientId,
          userAgent,
        };
      } catch (error) {
        if (received === true) {
          throw new ChallengeProcessingError(error instanceof ChallengeProcessingError ? error.code : 'RESPONSE_INVALID', true);
        }
        throw error;
      } finally {
        busy = false;
      }
    },
  };
}

export class CallbackInputError extends Error {}

export function callbackCode(input, advice) {
  let value = typeof input === 'string' ? input.trim() : '';
  if (value.length === 0 || value.length > 32768 || /[\r\n]/.test(value) === true) {
    throw new CallbackInputError('Paste a non-empty, single-line authorization code or redirect URL.');
  }

  // Google can expose CheckCookie -> SafariVCRedirect -> app callback rather
  // than navigating visibly to the custom scheme. Unwrap only these known URLs;
  // never scan arbitrary nested parameters or contact any pasted destination.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\//.test(value) === true) {
    try {
      let expected = new URL(advice.redirect_uri);
      let expectedState = new URL(advice.url).searchParams.get('state');
      let receivedState;
      for (let depth = 0; depth < 5; depth += 1) {
        let url = new URL(value);
        if (url.searchParams.has('error') === true) {
          throw new CallbackInputError('Google returned a sign-in error. Start a fresh login attempt.');
        }

        // The visible sign-in page is not a callback. Its path cannot establish
        // whether verification failed or a later app-scheme navigation failed.
        // Keep this attempt and its PKCE context alive; never echo session values.
        if (
          url.origin === 'https://accounts.google.com' &&
          url.username === '' &&
          url.password === '' &&
          /^\/(?:v\d+\/)?signin(?:\/|$)/.test(url.pathname) === true
        ) {
          throw new CallbackInputError(
            'This Google page is not a callback. If Safari shows invalid address, keep this terminal open ' +
              'and check Web Inspector for the attempted callback URL.',
          );
        }
        if (url.searchParams.has('state') === true) {
          let state = url.searchParams.get('state');
          if (expectedState !== null && state !== expectedState) {
            throw new CallbackInputError('Callback state does not match this login attempt.');
          }
          receivedState = state;
        }
        if (url.protocol === expected.protocol && url.host === expected.host && url.pathname === expected.pathname) {
          if (expectedState !== null && receivedState !== expectedState) {
            throw new CallbackInputError('Callback state is missing for this login attempt.');
          }
          value = url.searchParams.get('code') ?? url.searchParams.get('authorization_code') ?? '';
          break;
        }
        if (
          url.origin !== 'https://accounts.google.com' ||
          ['/CheckCookie', '/SafariVCRedirect'].includes(url.pathname) !== true ||
          url.username !== '' ||
          url.password !== ''
        ) {
          throw new CallbackInputError('Paste the Google CheckCookie/SafariVCRedirect URL or the expected app callback.');
        }
        if (
          (url.searchParams.has('client_id') === true && url.searchParams.get('client_id') !== advice.mediatorClientId) ||
          (url.searchParams.has('delegated_client_id') === true && url.searchParams.get('delegated_client_id') !== advice.client_id)
        ) {
          throw new CallbackInputError('Redirect client does not match this login attempt.');
        }
        let redirect = url.searchParams.get('redirect_uri');
        if (redirect !== null) {
          let target = new URL(redirect);
          if (target.protocol !== expected.protocol || target.host !== expected.host || target.pathname !== expected.pathname) {
            throw new CallbackInputError('Redirect destination does not match this login attempt.');
          }
        }
        value = url.pathname === '/CheckCookie' ? (url.searchParams.get('continue') ?? redirect ?? '') : (redirect ?? '');
        if (depth === 4) {
          throw new CallbackInputError('Too many nested Google redirects. Paste the final app callback or code.');
        }
      }
    } catch (error) {
      if (error instanceof CallbackInputError) {
        throw error;
      }
      throw new CallbackInputError('Unable to read the redirect URL. Copy the complete single-line browser URL.');
    }
  }
  if (/^[^\s]{1,8192}$/.test(value) !== true) {
    throw new CallbackInputError('No authorization code was found in that redirect. Finish Google sign-in and copy the final URL.');
  }

  return value;
}

/**
 * Exchange a completed callback using the original attempt's PKCE context.
 * @param {object} advice Private result of runtime.advice().
 * @param {string} input Completed callback URL or authorization code.
 * @param {Function} [post] Optional HTTP adapter for tests.
 * @returns {Promise<{refreshToken: string, deviceId: string}>} Credential and generated device ID.
 */
export async function exchangeCode(advice, input, post = googlePost) {
  let response = await post(
    TOKEN,
    {
      client_id: advice.mediatorClientId,
      code: callbackCode(input, advice),
      code_verifier: advice.code_verifier,
      redirect_uri: advice.redirect_uri + '?login=code',
      grant_type: 'authorization_code',
      scope: 'https://www.google.com/accounts/OAuthLogin',
    },
    { 'User-Agent': advice.userAgent, 'Accept-Language': 'en-US,en;q=0.9' },
  );
  if (typeof response.refresh_token !== 'string' || /^[^\s]{1,8192}$/.test(response.refresh_token) !== true) {
    throw new Error('Code exchange returned no valid refresh credential');
  }

  return {
    refreshToken: response.refresh_token,
    deviceId: advice.device_id,
  };
}

// The worker only receives challenge inputs; it never starts the CLI.
if (isMainThread === false) {
  try {
    const database = new RuntimeDatabase(workerData.model);
    const realm = createChallengeRealm({ ...workerData, database, receipt: Buffer.from(workerData.receipt) });
    const result = realm.execute(workerData.setupCode, workerData.challengeCode);
    parentPort.postMessage({ result });
  } catch (error) {
    parentPort.postMessage({ failed: true, code: error instanceof ChallengeProcessingError ? error.code : 'WORKER_FAILED' });
  }
}

// Objective-C bridge inside the challenge realm. Dispatches the eight protocol
// operations, models Foundation objects and exposes bounded simulated memory.
function bridge() {
  // This function runs inside the guest realm; host access stays behind __runtimeHost.
  const host = globalThis.__runtimeHost;
  delete globalThis.__runtimeHost;
  const classes = new Map();
  const nativePrototype = { [undefined]: class {} }[undefined].prototype;
  let operationCount = 0;
  let failed = false;

  function nativeFunction(fn) {
    // Match the callable shape expected by runtime probes without exposing host functions.
    Object.defineProperties(fn, {
      __objC_native_function: { value: true },
      toString: { value: () => 'function () {\n    [native code]\n}' },
    });
    fn.prototype = nativePrototype;
    return fn;
  }

  // Challenges inspect tags, hidden fields, constructor objects and prototypes.
  // Keep these objects inside the challenge realm instead of exposing host classes.
  function registerClass(name, fields = [], methods = {}) {
    // Register simulated object layouts and selector methods in the guest class table.
    if (classes.has(name) === true) {
      return classes.get(name);
    }
    const Prototype = { [name + 'Prototype']: class {} }[name + 'Prototype'];
    const Constructor = {
      [name + 'Constructor']: class {
        prototype = new Prototype();
        get [Symbol.toStringTag]() {
          return name + 'Constructor';
        }
      },
    }[name + 'Constructor'];
    const constructor = new Constructor();
    class RuntimeObject {
      constructor(...values) {
        for (let index = 0; index < fields.length; index += 1) {
          Object.defineProperty(this, fields[index], { value: values[index], writable: true });
        }
        if (name === 'NSConcreteValue' && this.offset === undefined) {
          this.offset = 0;
        }
        Object.defineProperty(this, 'constructor', { value: constructor });
      }

      get length() {
        return undefined;
      }

      get [Symbol.toStringTag]() {
        return name;
      }
    }
    Object.defineProperty(RuntimeObject, 'name', { value: name });
    for (let [key, value] of Object.entries(methods)) {
      Object.defineProperty(RuntimeObject.prototype, key, { value });
    }
    classes.set(name, RuntimeObject);
    globalThis[name] = RuntimeObject;
    return RuntimeObject;
  }

  const WrappedClass = registerClass('IGDWrappedClass', ['wrappedClass'], {
    c() {
      return new (registerClass(this.wrappedClass))().constructor;
    },
  });
  const Container = registerClass('IGDContainer', ['object'], {
    clear() {
      this.object = undefined;
    },
  });
  const Pointer = registerClass('NSConcreteValue', ['value', 'offset']);
  const Data = registerClass('NSData', ['buffer']);
  const MutableData = registerClass('NSConcreteMutableData', ['buffer']);
  const Block = registerClass('NSBlock', ['args', 'fn']);
  const Bundle = registerClass('NSBundle', ['id']);
  const URLObject = registerClass('NSURL', ['url']);
  const Device = registerClass('UIDevice', ['uuid']);
  const UUID = registerClass('NSUUID', ['uuid']);
  const FileManager = registerClass('NSFileManager');

  function hashSelector(selector) {
    let hash = 5381;
    for (let index = 0; index < selector.length; index += 1) {
      hash = (hash * 33 + selector.charCodeAt(index)) | 0;
    }

    return hash;
  }

  // Dispatch supported selectors explicitly; unknown operations fail the challenge.
  const selectors = new Map();
  function addSelector(name, operation) {
    selectors.set(name, { name, operation });
    selectors.set(hashSelector(name), { name, operation });
  }
  addSelector('stringValue', (target) => target.toString());
  addSelector('substringToIndex:', (target, index) => target.slice(0, index));
  addSelector('UUIDString', (target) => target.uuid);
  addSelector('intValue', (target) => Number(target));
  addSelector('dataWithContentsOfURL:', () => (host.hasReceipt === true ? new Data(host.receipt()) : undefined));
  addSelector('length', (target) => target.buffer.length);
  addSelector('bytes', (target) => new Pointer(target));
  addSelector('JSValueRef', () => new Pointer({ validOffsets: host.jsValueOffsets }));
  addSelector('invoke', (target) => {
    target.fn('invoke');
  });
  addSelector('mainBundle', () => new Bundle(host.bundleInstanceId));
  addSelector('appStoreReceiptURL', (target) =>
    host.hasReceipt === true
      ? new URLObject('file:///private/var/mobile/Containers/Data/Application/' + target.id + '/StoreKit/receipt')
      : undefined,
  );
  addSelector(
    'gtm_dataByGzippingBytes:length:error:',
    (target, pointer, length) => new Data(host.gzip(pointer?.value?.buffer, pointer?.offset, length)),
  );
  addSelector('currentDevice', () => new Device(host.deviceId));
  addSelector('identifierForVendor', (target) => new UUID(target.uuid));
  addSelector('infoDictionary', () => JSON.parse(host.appInfo));
  addSelector('defaultManager', () => new FileManager());

  // These are simulated iOS observations, never queries of the host filesystem.
  addSelector('fileExistsAtPath:', () => false);
  addSelector('attributesOfItemAtPath:error:', (target, path) => {
    const attributes = {
      NSFileOwnerAccountID: 0,
      NSFileSystemFileNumber: 0xfffffff0005e200,
      NSFileExtensionHidden: false,
      NSFileSystemNumber: 0x32000001,
      NSFileSize: 11,
      NSFileGroupOwnerAccountID: 0,
      NSFileOwnerAccountName: 'root',
      NSFileCreationDate: {},
      NSFilePosixPermissions: 493,
      NSFileType: 'NSFileTypeSymbolicLink',
      NSFileGroupOwnerAccountName: 'wheel',
      NSFileReferenceCount: 1,
      NSFileModificationDate: {},
    };
    if (path === '/var') {
      Object.assign(attributes, {
        NSFileSystemFileNumber: 0xfffffff0005ef80,
        NSFileGroupOwnerAccountID: 80,
        NSFileGroupOwnerAccountName: 'admin',
      });
    }
    if (path === '/private') {
      Object.assign(attributes, { NSFileSize: 224, NSFileType: 'NSFileTypeDirectory', NSFileReferenceCount: 7 });
    }
    if (path === '/private/var') {
      Object.assign(attributes, {
        NSFileSystemFileNumber: 2,
        NSFileSystemNumber: 0x1000007,
        NSFileSize: 1184,
        NSFileType: 'NSFileTypeDirectory',
        NSFileReferenceCount: 36,
      });
    }

    return attributes;
  });
  addSelector('filePosixPermissions', (target) => target.NSFilePosixPermissions ?? 0);
  addSelector('dataWithCapacity:', (target, length) => {
    if (Number.isSafeInteger(length) !== true || length < 0 || length > 2 * 1024 * 1024) {
      throw new Error('Invalid data capacity');
    }

    return new MutableData(host.allocate(length));
  });
  addSelector('mutableBytes', (target) => new Pointer({ buffer: target.buffer }));
  addSelector('container', () => new Container());
  addSelector('clear', (target) => {
    target.clear();
  });
  addSelector('setObject:', (target, value) => {
    target.object = value;
  });

  function callMethod(target, selector, args) {
    const entry = selectors.get(selector);
    if (entry === undefined) {
      host.reportFailure('UNSUPPORTED_SELECTOR');
      throw new Error('Unsupported Objective-C selector');
    }
    if (entry.name.split(':').length - 1 !== args.length) {
      throw new Error('Incorrect Objective-C argument count');
    }

    return entry.operation(target, ...args);
  }

  // Both lookup and enumeration yield Method values. Keep their declaring class
  // and method index together so inherited lookups resolve the correct record.
  function methodInfo(pointer) {
    const value = pointer?.value;
    if (value?.isMethodPtr !== true && value?.isInstanceMethod !== true) {
      return undefined;
    }
    if (typeof value.class !== 'string' || Number.isInteger(value.methodIdx) !== true || value.methodIdx < 0) {
      return undefined;
    }
    host.methodName(value.class, value.methodIdx);
    return { class: value.class, methodIdx: value.methodIdx };
  }

  // Reflection calls return model-backed records rather than native process pointers.
  const runtimeFunctions = {
    NSSelectorFromString(selector) {
      return new Pointer({ selector });
    },
    object_isClass(target) {
      return target instanceof WrappedClass === true && host.isClass(target.wrappedClass) === true;
    },
    method_getTypeEncoding(method) {
      const record = methodInfo(method);
      return record === undefined ? null : host.methodSignature(record.class, record.methodIdx);
    },
    class_getInstanceMethod(target, selector) {
      const record = host.lookupMethod(target?.wrappedClass, selector?.value?.selector);
      return new Pointer(record === undefined ? { isInstanceMethodNull: true } : { ...record, isMethodPtr: true, isInstanceMethod: true });
    },
    objc_copyImageNames(count) {
      count.object = host.imageCount;
      return new Pointer({ isImageList: true, length: count.object });
    },
    objc_copyClassList(count) {
      count.object = host.classCount;
      return new Pointer({ isClassList: true, length: count.object });
    },
    objc_copyClassNamesForImage(image, count) {
      const length = host.imageClassCount(image);
      count.object = length ?? 0;
      if (length === null) {
        failed = true;
        return undefined;
      }
      return new Pointer({ isImageClassList: true, image, length });
    },
    class_copyMethodList(target, count) {
      count.object = host.methodCount(target.wrappedClass);
      return count.object === 0 ? undefined : new Pointer({ class: target.wrappedClass, isMethodList: true, length: count.object });
    },
    class_getImageName(target) {
      const image = host.classImage(target.wrappedClass);
      if (image === undefined) {
        failed = true;
      }
      return image;
    },
    method_getImplementation(method) {
      const record = methodInfo(method);
      return record === undefined ? undefined : new Pointer({ ...record, isMethodImplPtr: true });
    },
    dladdr(pointer, output) {
      if (pointer?.value?.isMethodImplPtr !== true || Number.isInteger(pointer.value.methodIdx) !== true) {
        return 0;
      }
      output.value = { str: host.methodImage(pointer.value.class, pointer.value.methodIdx), isStringPtr: true };
      return 1;
    },
    method_getName(method) {
      const record = methodInfo(method);
      return record === undefined ? undefined : new Pointer({ selector: host.methodName(record.class, record.methodIdx) });
    },
    sel_getName(selector) {
      return typeof selector?.value?.selector === 'string' ? selector.value.selector : undefined;
    },
    free() {},
  };

  function readMemory(pointer, encoding) {
    // Accept only simulated pointers and supported encodings within their backing storage.
    if (
      pointer instanceof Pointer !== true ||
      typeof encoding !== 'string' ||
      Number.isSafeInteger(pointer.offset) !== true ||
      pointer.offset < 0
    ) {
      throw new Error('Non readable');
    }
    const { value, offset } = pointer;
    if (value?.buffer !== undefined) {
      if (encoding === 'i' || encoding === 'I') {
        if (offset + 4 > value.buffer.length) {
          throw new Error('Non readable');
        }
        return encoding === 'i' ? value.buffer.readInt32LE(offset) : value.buffer.readUInt32LE(offset);
      }
      if (/^<[0-9]+$/.test(encoding) === true) {
        const length = Number(encoding.slice(1));
        if (Number.isSafeInteger(length) !== true || offset + length > value.buffer.length) {
          throw new Error('Non readable');
        }
        return [...value.buffer.subarray(offset, offset + length)];
      }
    }
    if (encoding === '^' && Array.isArray(value?.validOffsets) === true) {
      if (value.validOffsets.includes(offset) !== true) {
        throw new Error('Non readable');
      }
      return new Pointer({ validOffsets: value.validOffsets }, offset);
    }
    if (encoding.startsWith('*') === true && value?.isStringPtr === true) {
      return value.str;
    }
    if (offset % 8 === 0 && offset / 8 < value?.length) {
      const index = offset / 8;
      if (encoding.startsWith('^') === true && value.isMethodList === true) {
        return new Pointer({ class: value.class, isMethodPtr: true, methodIdx: index });
      }
      if (encoding.startsWith('*') === true) {
        if (value.isImageList === true) {
          return host.imageName(index);
        }
        if (value.isClassList === true) {
          return host.className(index);
        }
        if (value.isImageClassList === true) {
          return host.imageClass(value.image, index);
        }
      }
    }
    throw new Error('Non readable');
  }

  function executeBridgeOperation(ip, operation, ...args) {
    // Route the operation contract and preserve fixed failure codes for the parent.
    operationCount += 1;
    if (this instanceof Environment !== true) {
      throw new TypeError('Invalid bridge receiver');
    }
    if (Number.isFinite(ip) !== true || Number.isInteger(operation) !== true || operation < 0 || operation > 7) {
      throw new Error('Invalid bridge operation');
    }
    if (operationCount > 250000) {
      throw new Error('Bridge operation limit exceeded');
    }
    if (args.length < [1, 2, 2, 3, 1, 2, 2, 2][operation]) {
      throw new Error('Missing bridge arguments');
    }
    const [target, parameter, value] = args;
    switch (operation) {
      case 0:
        if (host.isClass(target) !== true) {
          host.reportFailure('UNSUPPORTED_CLASS');
          return undefined;
        }
        return new WrappedClass(target);
      case 1:
        return callMethod(target, parameter, args.slice(2));
      case 2:
        try {
          return readMemory(target, parameter);
        } catch {
          host.reportFailure('UNSUPPORTED_MEMORY_READ');
          throw new Error('Non readable');
        }
      case 3: {
        // Correct value/offset order and accept only a bounded signed i32 write.
        if (
          target instanceof Pointer !== true ||
          parameter !== 'i' ||
          target.value?.buffer === undefined ||
          Number.isSafeInteger(target.offset) !== true ||
          target.offset < 0 ||
          target.offset + 4 > target.value.buffer.length ||
          Number.isInteger(value) !== true ||
          value < -2147483648 ||
          value > 2147483647
        ) {
          throw new Error('Non writable');
        }
        return target.value.buffer.writeInt32LE(value, target.offset);
      }
      case 4:
        if (Object.hasOwn(runtimeFunctions, target) !== true) {
          host.reportFailure('UNSUPPORTED_SYMBOL');
          throw new Error('Unsupported runtime symbol');
        }
        return new Pointer(target);
      case 5: {
        const symbol = typeof target === 'string' ? target : target?.value;
        if (Object.hasOwn(runtimeFunctions, symbol) !== true) {
          host.reportFailure('UNSUPPORTED_SYMBOL');
          throw new Error('Unsupported runtime symbol');
        }

        // The ABI keeps a signature slot after the symbol; actual arguments follow.
        return runtimeFunctions[symbol](...args.slice(2));
      }
      case 6:
        if (
          target instanceof Pointer !== true ||
          Number.isSafeInteger(parameter) !== true ||
          Number.isSafeInteger(target.offset + parameter) !== true
        ) {
          throw new Error('Invalid pointer offset');
        }
        return new Pointer(target.value, target.offset + parameter);
      case 7:
        if (typeof parameter !== 'function') {
          throw new Error('Invalid block callback');
        }
        return new Block(target, parameter);
    }
  }

  const Environment = registerClass('IGDJavaScriptEnv', ['0', 'br']);
  const bridge = nativeFunction(executeBridgeOperation);
  const pair = nativeFunction(() => {});
  globalThis.__createEnvironment = () => new Environment(pair, bridge);
  globalThis.__runtimeStats = () => ({ failed, operationCount });
  globalThis.a2b = nativeFunction((value) => host.decodeBase64(value));
  globalThis.b2a = nativeFunction((value) => host.encodeBase64(value));

  // Stack formatting is observable by iOSGuard. Confine Safari-style formatting
  // to this realm; it must never alter Error.prepareStackTrace in the Node host.
  Error.stackTraceLimit = 100;
  Error.prepareStackTrace = (error, frames) => {
    let result = [];
    for (let index = 0; index < frames.length; index += 1) {
      const frame = frames[index];
      const fn = frame.getFunction();
      let name = frame.getFunctionName() ?? '';
      if (name !== '' && frame.getMethodName() !== null && name !== frame.getMethodName()) {
        name = '';
      }
      if (frames[index + 1]?.getFunctionName() === 'runInContext') {
        result.push('global code@');
        break;
      }
      if (name === '__executeChallenge') {
        break;
      }
      if (fn?.constructor?.name === 'AsyncFunction') {
        result.push('@');
      }
      if (fn?.__objC_native_function === true) {
        result = ['@[native code]'];
      } else if (name === 'eval') {
        if (frame.getEvalOrigin()?.includes('device_challenge_setup.vm') === true) {
          result.push('@');
        } else {
          result.push('eval code@', 'eval@[native code]');
        }
      } else {
        result.push(name + '@' + (frame.isNative() === true ? '[native code]' : ''));
      }
    }

    return result.join('\n');
  };
}
