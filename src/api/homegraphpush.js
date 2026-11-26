// GoogleHomePush
// Part of homebridge-nest-accfactory
//
// Handles Google Home push delivery for one account. MCS (Mobile Connection
// Server) delivers push updates over a persistent TLS connection; the account
// owner's Foyer gRPC transport selects devices and renews their subscription.
//
// connect(deviceIds) enrolls this receiver, logs into MCS and subscribes through
// the borrowed Foyer transport. This client owns all retry/renewal timers, its TLS
// socket, bounded delivery queue and private receiver storage. disconnect() retires
// that work without releasing the shared transport or logging the account out.
//
// onData(state, isCurrent) delivers partial traits; false/rejection triggers recovery.
// onRefresh(isCurrent) requests reconciliation; onStatus(ready) controls fallback polling.
// OAuth refresh belongs to AccountSession. Receiver secrets never enter device data.
//
// Code version 2026.11.27
// Mark Hulskamp

// Define node.js modules
import { setTimeout, clearTimeout } from 'node:timers';
import { Buffer } from 'node:buffer';
import tls from 'node:tls';
import path from 'node:path';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import crypto from 'node:crypto';

// Define external modules
import protobuf from 'protobufjs';

// Define our modules
import { fetchWrapper } from '../fetchWrapper.js';
import { getProtoRoot } from '../protobuf.js';

// Define constants
import { __dirname, GOOGLE_HOME_FOYER_PREFIX, GOOGLE_HOME_USER_AGENT } from '../consts.js';

// Upstream MCS schema: https://github.com/chromium/chromium/blob/main/google_apis/gcm/protocol/mcs.proto
const mcs = getProtoRoot(path.join(__dirname, 'protobuf/googlehome/mcs.proto'));
const foyer = getProtoRoot(path.join(__dirname, 'protobuf/googlehome/foyer.proto'));
// Google Home client configuration recovered from the distributed Android app.
// Identifies Google's app/project; these are not user authentication credentials.
// Used by this unofficial integration; registration behaviour may change.
const APP = 'com.google.android.apps.chromecast.app';
const APP_ID = '1:498579633514:android:c533a2ef520ccec9';
const SENDER = APP_ID.split(':')[1];
const CERT = '24BB24C05E47E0AEFA68A58A766179D9B613A600';
const INSTALL = 'https://firebaseinstallations.googleapis.com/v1/projects/google.com:api-project-' + SENDER + '/installations';
const HEADERS = {
  'x-goog-api-key': 'AIzaSyD4Ok1UA0HHmyKCm5s_cQhWD7ZHZwnhorc',
  'X-Android-Package': APP,
  'X-Android-Cert': CERT,
  'User-Agent': GOOGLE_HOME_USER_AGENT,
};
const schema = getProtoRoot(path.join(__dirname, 'protobuf/googlehome/push.proto'));
const CHECKIN = schema.lookupType('homebridge.nest.push.CheckinRequest');
const TARGET = schema.lookupType('homebridge.nest.push.StoreTargetRequest');

const PUSH_RETRY_INITIAL = 5000;
const PUSH_RETRY_MAX = 60000;
const PUSH_LOGIN_TIMEOUT = 20000;
const PUSH_RENEWAL_INTERVAL = 90000;
const PUSH_HEARTBEAT_INTERVAL = 150000;
const PUSH_HEARTBEAT_TIMEOUT = 30000;
const PUSH_MAX_FRAME_BYTES = 1024 * 1024;

export default class GoogleHomePush {
  #options = {}; // Account identity, registration, shared transport and change consumers.
  #connection = undefined; // Current MCS socket, subscription timers and pending state delivery.

  #state; // Private receiver enrollment reused by MCS reconnects.
  #binding; // Account binding for persisted receiver credentials.
  #file; // Optional private Homebridge storage file.

  constructor(options = {}) {
    this.#options = options;
    if (typeof options.account?.refreshToken === 'string') {
      this.#binding = crypto.createHash('sha256').update(options.account.refreshToken).digest('hex');
      // Keep names and credentials out of filenames; duplicate accounts own separate receivers.
      let key = crypto
        .createHash('sha256')
        .update(this.#binding + '\0' + options.account.name)
        .digest('hex');
      if (typeof options.storagePath === 'string' && options.storagePath !== '') {
        this.#file = path.join(options.storagePath, 'nest-accfactory', 'push-' + key + '.json');
      }
    }
  }

  // Replace the requested device subscription and wait for MCS login and Foyer acceptance.
  async connect(deviceIds) {
    this.disconnect();

    // Check account ownership and bound the subscription before registration or network work.
    if (
      typeof this.#options.uuid !== 'string' ||
      this.#options.uuid.length === 0 ||
      Array.isArray(deviceIds) !== true ||
      deviceIds.length === 0 ||
      deviceIds.length > 500 ||
      deviceIds.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 256) === true
    ) {
      throw new Error('Push requires an account and discovered device IDs');
    }

    // Keep cancellation, retries and pending delivery together for this connection.
    let connection = {
      ids: new Set(deviceIds),
      controller: new AbortController(),
      retryDelay: PUSH_RETRY_INITIAL,
      queue: [],
      delivering: false,
    };
    this.#connection = connection;

    try {
      await this.#open(connection);
      // A socket can fail while subscription acceptance is still in flight.
      if (this.#connection !== connection) {
        throw new Error('Push startup superseded');
      }
    } catch {
      // A replaced startup must not disconnect the newer receiver.
      if (this.#connection === connection) {
        this.#failed(connection);
      }

      throw new Error('Google Home push connection failed');
    }
  }

  // Retire callbacks before destroying the socket; the account keeps its Foyer transport.
  disconnect() {
    let connection = this.#connection;
    this.#connection = undefined;

    if (connection !== undefined) {
      this.#close(connection);
      this.#options.onStatus?.(false);
    }
  }

  #close(connection) {
    // Cancel registration and every timer owned by this connection.
    connection.controller.abort();
    clearTimeout(connection.renewal);
    clearTimeout(connection.retry);
    clearTimeout(connection.heartbeat);
    clearTimeout(connection.deadline);

    // Release a connect() still waiting for login, then discard queued state.
    connection.reject?.(new Error('Push connection stopped'));
    connection.reject = undefined;
    connection.socket?.destroy();
    connection.queue.length = 0;
  }

  // Allocate a new connection for each retry so old socket events and registration
  // replies cannot stop its replacement or deliver stale state.
  #failed(connection) {
    if (this.#connection !== connection) {
      return;
    }

    // Startup and established failures share the same receiver-owned backoff.
    this.#options.onStatus?.(false);

    // Retire the old connection before socket destruction can emit close/error events.
    let next = {
      ids: connection.ids,
      controller: new AbortController(),
      retryDelay: Math.min(connection.retryDelay * 2, PUSH_RETRY_MAX),
      queue: [],
      delivering: false,
    };
    this.#connection = next;
    this.#close(connection);

    this.#options.log?.debug?.('Google Home push disconnected; reconnecting');
    next.retry = setTimeout(() => {
      this.#open(next).catch(() => this.#failed(next));
    }, connection.retryDelay);
  }

  // Bind this receiver to the current account before opening its MCS connection.
  async #open(connection) {
    let isCurrent = () => this.#connection === connection;

    // Registration and socket startup share the same cancellation signal.
    let credentials =
      typeof this.#options.register === 'function'
        ? await this.#options.register(connection.controller.signal)
        : await this.register(connection.controller.signal);
    if (isCurrent() !== true) {
      throw new Error('Push registration superseded');
    }

    // These decimal strings are uint64 credentials. Converting through Number
    // would corrupt values beyond Number.MAX_SAFE_INTEGER.
    if (credentials?.uuid !== this.#options.uuid || this.#validCheckin(credentials) !== true) {
      throw new Error('Push registration does not belong to this account');
    }

    await new Promise((resolve, reject) => {
      // Login must finish within the deadline; TLS connection alone is not MCS acceptance.
      connection.reject = reject;
      connection.buffer = Buffer.alloc(0);
      connection.version = false;
      connection.stream = 0;
      connection.deadline = setTimeout(() => this.#failed(connection), PUSH_LOGIN_TIMEOUT);

      // Send receiver credentials only after the server's TLS certificate is verified.
      let socket = tls.connect({ host: 'mtalk.google.com', port: 5228, servername: 'mtalk.google.com', rejectUnauthorized: true });
      connection.socket = socket;
      socket.setKeepAlive(true);

      socket.once('secureConnect', () => {
        if (isCurrent() === true) {
          this.#send(
            connection,
            2,
            'LoginRequest',
            {
              id: 'ios-4.3.0',
              domain: 'mcs.android.com',
              user: credentials.androidId,
              resource: credentials.androidId,
              authToken: credentials.securityToken,
              deviceId: 'android-' + BigInt(credentials.androidId).toString(16),
              lastRmqId: 1,
              setting: [{ name: 'new_vc', value: '1' }],
              useRmq2: true,
              accountId: 1000000,
              authService: 2,
              networkType: 1,
            },
            true,
          );
        }
      });

      // All socket failures use the same cleanup and recovery path.
      socket.on('error', () => this.#failed(connection));
      socket.on('close', () => this.#failed(connection));
      socket.on('data', (chunk) => {
        if (isCurrent() !== true) {
          return;
        }

        try {
          this.#receive(connection, chunk, resolve);
        } catch {
          this.#failed(connection);
        }
      });
    });

    if (isCurrent() !== true) {
      return;
    }
    await this.#subscribe(connection);

    // Reconcile state that may have changed while this receiver was disconnected.
    if (isCurrent() === true) {
      await this.#options.onRefresh?.(isCurrent);
    }
  }

  // Reuse the account-authenticated Foyer transport; no separate gRPC client is needed.
  async #subscribe(connection) {
    let response = await this.#options.transport.command(
      GOOGLE_HOME_FOYER_PREFIX,
      'UsersService',
      'AppSubscriptionUpdate',
      {
        subscriptionEntities: {
          smartPollingInterval: { seconds: 30, nanos: 0 },
          deviceWithTraitsArray: [...connection.ids].map((hgsDeviceId) => ({ hgsDeviceId })),
        },
        ttl: { seconds: 120, nanos: 0 },
      },
      { retry: 0 },
    );
    // The RPC may finish after disconnect() or a replacement connection.
    if (this.#connection !== connection) {
      return;
    }

    if (response?.status !== 0) {
      throw new Error('Push subscription failed');
    }

    // Subscription replies can contain initial states as well as starting push delivery.
    for (let value of response.data ?? []) {
      for (let state of value.initialDeviceStatesArray ?? []) {
        this.#deliver(connection, state);
      }
    }
    connection.retryDelay = PUSH_RETRY_INITIAL;
    this.#options.onStatus?.(true);

    // Renew only after the previous RPC finishes; the 120-second TTL bounds a
    // stopped receiver's server subscription without releasing the shared client.
    connection.renewal = setTimeout(() => {
      this.#subscribe(connection).catch(() => this.#failed(connection));
    }, PUSH_RENEWAL_INTERVAL);
  }

  #send(connection, tag, name, value, version = false) {
    if (this.#connection !== connection) {
      return;
    }

    try {
      // A slow or blocked socket must not accumulate an unbounded acknowledgement queue.
      if (connection.socket.writableLength > PUSH_MAX_FRAME_BYTES) {
        throw new Error('Push output buffer limit exceeded');
      }

      // Only the login frame includes the protocol version before its message tag.
      let type = mcs.lookupType('mcs_proto.' + name);
      connection.socket.write(
        Buffer.concat([Buffer.from(version === true ? [40, tag] : [tag]), type.encodeDelimited(type.fromObject(value)).finish()]),
      );
    } catch {
      this.#failed(connection);
    }
  }

  // MCS starts with a version byte, followed by tag/varint-length/payload frames.
  // Retain incomplete frames until more bytes arrive, within the receive-buffer limit.
  #receive(connection, chunk, resolve) {
    if (connection.buffer.length + chunk.length > 2 * PUSH_MAX_FRAME_BYTES) {
      throw new Error('Push buffer limit exceeded');
    }

    // Only incomplete frames need copying into a combined buffer.
    let buffer = connection.buffer.length === 0 ? chunk : Buffer.concat([connection.buffer, chunk]);
    let offset = 0;
    if (connection.version === false && buffer.length > 0) {
      if (buffer[0] < 38 || buffer[0] > 41) {
        throw new Error('Unsupported MCS version');
      }
      connection.version = true;
      offset = 1;
    }

    // A TCP chunk may contain several frames or only part of a length/payload.
    while (offset + 2 <= buffer.length && this.#connection === connection) {
      let cursor = offset + 1;
      let size = 0;
      let shift = 0;
      let complete = false;

      // Protobuf lengths use a variable-width integer, limited here to five bytes.
      while (cursor < buffer.length && shift < 35) {
        let byte = buffer[cursor++];
        size += (byte & 127) * 2 ** shift;
        if ((byte & 128) === 0) {
          complete = true;
          break;
        }
        shift += 7;
      }

      if (size > PUSH_MAX_FRAME_BYTES || shift >= 35) {
        throw new Error('Push frame limit exceeded');
      }
      if (complete !== true || cursor + size > buffer.length) {
        break;
      }

      let tag = buffer[offset];
      let body = buffer.subarray(cursor, cursor + size);
      connection.stream += 1;

      // MCS tags: login=3, heartbeat ping/ack=0/1, data=8, close/error=4/10.
      if (tag === 3) {
        let response = mcs.lookupType('mcs_proto.LoginResponse').decode(body);
        if (response.error !== null || connection.reject === undefined) {
          throw new Error('Push login rejected');
        }

        clearTimeout(connection.deadline);
        connection.reject = undefined;
        this.#heartbeat(connection);
        resolve();
      } else if (tag === 0) {
        this.#send(connection, 1, 'HeartbeatAck', { lastStreamIdReceived: connection.stream });
      } else if (tag === 1) {
        clearTimeout(connection.deadline);
      } else if (tag === 8 && connection.reject === undefined) {
        let message = mcs.lookupType('mcs_proto.DataMessageStanza').decode(body);

        // Accept Google Home payloads from its sender; device ownership is checked on delivery.
        if (message.category === APP && message.from === '498579633514') {
          let encoded = message.appData.find((entry) => entry.key === 'gcm_realtime_message_proto')?.value;
          if (typeof encoded === 'string') {
            let event = foyer.lookupType('google.internal.home.foyer.v1.RealtimeMessage').decode(Buffer.from(encoded, 'base64')).event;
            let state = event?.deviceState ?? event?.deviceStateUpdatedEvent ?? undefined;
            if (state !== undefined) {
              this.#deliver(connection, state);
            } else if (
              event !== null &&
              event !== undefined &&
              (Object.hasOwn(event, 'refreshDeviceState') === true || Object.hasOwn(event, 'refreshHomeGraph') === true)
            ) {
              // Explicit invalidations request reconciliation. Other event types
              // (including camera activity) remain outside device-state ingestion.
              this.#deliver(connection);
            }
          }
        }

        // Stream acknowledgement confirms receipt; consumer acceptance is handled separately.
        this.#send(connection, 7, 'IqStanza', {
          type: 1,
          id: '',
          extension: { id: 13, data: Buffer.alloc(0) },
          lastStreamIdReceived: connection.stream,
          status: 0,
        });
      } else if (tag === 4 || tag === 10) {
        throw new Error('Push server closed connection');
      }
      offset = cursor + size;
    }

    // Preserve only bytes belonging to the next incomplete frame.
    connection.buffer = buffer.subarray(offset);
  }

  // An unanswered heartbeat retires a connection even when the TLS socket remains open.
  #heartbeat(connection) {
    connection.heartbeat = setTimeout(() => {
      this.#send(connection, 0, 'HeartbeatPing', { lastStreamIdReceived: connection.stream });

      // Sending can fail and retire this connection; do not leave timers behind in that case.
      if (this.#connection === connection) {
        connection.deadline = setTimeout(() => this.#failed(connection), PUSH_HEARTBEAT_TIMEOUT);
        this.#heartbeat(connection);
      }
    }, PUSH_HEARTBEAT_INTERVAL);
  }

  // Bound delivery when an async consumer is slower than MCS. A failed consumer
  // reconnects and requests reconciliation rather than silently losing cache state.
  #deliver(connection, state = undefined) {
    // Subscription IDs come from this account's discovery, never from incoming push data.
    if (state !== undefined && connection.ids.has(state.uuid?.value) !== true) {
      return;
    }

    if (connection.queue.length >= 64) {
      throw new Error('Push consumer queue limit exceeded');
    }

    // One consumer drains the queue in order; undefined represents a reconciliation request.
    connection.queue.push(state);
    if (connection.delivering === true) {
      return;
    }

    connection.delivering = true;
    let isCurrent = () => this.#connection === connection;

    (async () => {
      while (isCurrent() === true && connection.queue.length > 0) {
        let value = connection.queue.shift();
        if (value === undefined) {
          await this.#options.onRefresh?.(isCurrent);
        } else {
          // Refusal or rejection requires recovery so cloud state can be reconciled.
          if ((await this.#options.onData?.(value, isCurrent)) === false) {
            throw new Error('Push state was not accepted');
          }
        }
      }

      connection.delivering = false;
    })().catch(() => this.#failed(connection));
  }

  // Enroll once, reuse private receiver credentials, and rebind with the current OAuth token.
  async register(signal) {
    let account = this.#options.account;
    let token = account.oauth2;
    let current = () => {
      signal.throwIfAborted();
      if (account.authorised !== true || account.oauth2 !== token || typeof token !== 'string' || token === '') {
        throw new Error('Registration session retired');
      }
    };
    try {
      current();
      if (this.#state === undefined) {
        await this.#load();
      }
      current();
      let state = this.#state;
      if (state.fis === undefined || state.fisExpires <= Date.now() + 60000) {
        let renew = state.fis !== undefined;
        let response = JSON.parse(
          (
            await this.#post(
              renew === true ? INSTALL + '/' + state.fid + '/authTokens:generate' : INSTALL,
              JSON.stringify(
                renew === true
                  ? { installation: { appId: APP_ID, sdkVersion: 'a:16.3.1' } }
                  : { fid: state.fid, appId: APP_ID, authVersion: 'FIS_v2', sdkVersion: 'a:17.0.2_1p' },
              ),
              {
                ...HEADERS,
                'Content-Type': 'application/json',
                ...(renew === true ? { Authorization: 'FIS_v2 ' + state.fis.refreshToken } : {}),
              },
              signal,
            )
          ).toString('utf8'),
        );
        current();
        let auth = renew === true ? response : response.authToken;
        if (
          typeof auth?.token !== 'string' ||
          auth.token === '' ||
          /^[1-9][0-9]*s$/.test(auth.expiresIn ?? '') !== true ||
          (renew === false && (typeof response.refreshToken !== 'string' || response.refreshToken === ''))
        ) {
          throw new Error('Invalid Firebase registration');
        }
        state.fis = renew === true ? { ...state.fis, authToken: auth } : response;
        state.fisExpires = Date.now() + Math.min(Number(auth.expiresIn.slice(0, -1)), 604800) * 1000;
        await this.#save(signal);
      }
      if (state.checkin === undefined) {
        let body = CHECKIN.encode({
          androidId: 0,
          checkin: {
            build: {
              fingerprint: 'google/razor/flo:5.0.1/LRX22C/1602158:user/release-keys',
              hardware: 'flo',
              brand: 'google',
              radio: 'FLO-04.04',
              clientId: 'android-google',
            },
            lastCheckinMs: 0,
          },
          locale: 'en',
          loggingId: 1234567890,
          timeZone: 'GMT',
          version: 3,
          otaCert: ['71Q6Rn2DDZl1zPDVaaeEHItd+Yg='],
          macAddressType: ['wifi'],
          fragment: 0,
          userSerialNumber: 0,
        }).finish();
        let bytes = await this.#post(
          'https://android.clients.google.com/checkin',
          Buffer.from(body),
          { 'Content-Type': 'application/x-protobuf' },
          signal,
        );
        current();
        // Shared protobuf decoding uses Number for int64. Read these fixed64
        // credentials directly so no Android ID or security-token bits are lost.
        let reader = protobuf.Reader.create(bytes);
        let checkin = {};
        while (reader.pos < reader.len) {
          let tag = reader.uint32();
          let field = tag >>> 3;
          if ([7, 8].includes(field) === true && (tag & 7) === 1) {
            checkin[field === 7 ? 'androidId' : 'securityToken'] = bytes.readBigUInt64LE(reader.pos).toString();
            reader.pos += 8;
          } else {
            reader.skipType(tag & 7);
          }
        }
        if (this.#validCheckin(checkin) !== true) {
          throw new Error('Invalid checkin');
        }
        state.checkin = checkin;
        await this.#save(signal);
      }
      if (state.gcmToken === undefined) {
        let form = new URLSearchParams({
          'X-subtype': SENDER,
          sender: SENDER,
          'X-app_ver': '741',
          'X-osv': '25',
          'X-cliv': 'fiid-20.2.0',
          'X-gmsv': '201216023',
          'X-appid': state.fid,
          'X-scope': '*',
          'X-Goog-Firebase-Installations-Auth': state.fis.authToken.token,
          'X-gmp_app_id': APP_ID,
          'X-firebase-app-name-hash': 'R1dAH9Ui7M-ynoznwBdw01tLxhI',
          'X-Firebase-Client-Log-Type': '1',
          'X-Firebase-Client':
            'fire-abt/17.1.1+fire-installations/16.3.1+fire-android/+fire-analytics/17.4.2+' +
            'fire-iid/20.2.0+fire-rc/17.0.0+fire-fcm/20.2.0+fire-cls/17.0.0+fire-cls-ndk/17.0.0+fire-core/19.3.0',
          'X-app_ver_name': 'v2.2.2_741',
          app: APP,
          device: state.checkin.androidId,
          app_ver: '741',
          info: 'g3EMJXXElLwaQEb1aBJ6XhxiHjPTUxc',
          gcm_ver: '201216023',
          plat: '0',
          cert: CERT,
          target_ver: '28',
        });
        let response = (
          await this.#post(
            'https://android.clients.google.com/c2dm/register3',
            form.toString(),
            {
              Authorization: 'AidLogin ' + state.checkin.androidId + ':' + state.checkin.securityToken,
              app: APP,
              gcm_ver: '201216023',
              'User-Agent': 'Android-GCM/1.5 (OnePlus5 NMF26X)',
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            signal,
          )
        ).toString('utf8');
        current();
        if (/^token=\S+$/.test(response) !== true) {
          throw new Error('Invalid GCM registration');
        }
        state.gcmToken = response.slice(6);
        await this.#save(signal);
      }
      current();
      // Construct uint64 from exact bits; fromObject would coerce the ID to Number.
      let id = BigInt(state.checkin.androidId);
      let body = TARGET.encode({
        feedId: 'home_pulsar',
        appInfo: {
          field1: 3,
          appAndTokenData: {
            subdata: {
              notificationToken: state.gcmToken,
              appId: APP,
              deviceId: { low: Number(id & 0xffffffffn), high: Number(id >> 32n), unsigned: true },
              field4: 0,
            },
          },
        },
        deviceInfo: {
          languageCode: 'en-US',
          deviceAndChannelData: {
            field2: 1070596096,
            appVersion: '3.25.1.4',
            field4: '11',
            field5: 'RQ1A.210105.003',
            deviceName: 'A10',
            field7: 30,
            deviceVendor: 'Samsung',
            field9: 3,
            field10: '629835953',
            fullDeviceName: 'Galaxy A10',
            field14: 1,
            countryCode: 'us',
            field16: {},
            field17: { field1: { field2: 1 } },
            field18: 0,
          },
          timeZone: 'America/Los_Angeles',
        },
        miniAppInfo: { data: { senderId: Number(SENDER), notificationToken: state.gcmToken } },
        field10: 7,
        field12: { value: 0 },
      }).finish();
      await this.#post(
        'https://notifications-pa.googleapis.com/v1/storetarget',
        Buffer.from(body),
        {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/x-protobuf',
          'x-server-token': '',
          'User-Agent':
            'com.google.android.apps.chromecast.app/30443859 ' +
            '(Linux; U; Android 11; en_US; A10; Build/RQ1A.210105.003; Cronet/125.0.6383.0)',
        },
        signal,
      );
      current();
      return { uuid: this.#options.uuid, ...state.checkin };
    } catch {
      throw new Error('Google Home push registration failed');
    }
  }

  async #post(url, body, headers, signal) {
    signal.throwIfAborted();
    let response = await fetchWrapper(fetchWrapper.POST, url, { signal, timeout: 15000, retry: 1, redirect: 'error', headers }, body);
    let chunks = [];
    let size = 0;
    for await (let chunk of response.body ?? []) {
      size += chunk.length;
      if (size > 1024 * 1024) {
        throw new Error('Oversized push registration');
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  }

  #validCheckin(value) {
    return ['androidId', 'securityToken'].every(
      (key) =>
        typeof value?.[key] === 'string' && /^[1-9][0-9]{0,19}$/.test(value[key]) === true && BigInt(value[key]) <= 0xffffffffffffffffn,
    );
  }

  async #load() {
    try {
      if (this.#file !== undefined) {
        if ((await fs.lstat(this.#file)).isSymbolicLink() === true) {
          throw new Error('Invalid receiver file');
        }
        let file = await fs.open(this.#file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          let stat = await file.stat();
          if (stat.isFile() !== true || stat.size > 65536 || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
            throw new Error('Invalid receiver file');
          }
          let value = JSON.parse(await file.readFile('utf8'));
          if (
            value.version !== 1 ||
            value.binding !== this.#binding ||
            /^[cdef][A-Za-z0-9_-]{21}$/.test(value.fid ?? '') !== true ||
            (value.checkin !== undefined && this.#validCheckin(value.checkin) !== true) ||
            (value.gcmToken !== undefined && (typeof value.gcmToken !== 'string' || /^\S{1,65536}$/.test(value.gcmToken) !== true)) ||
            (value.fis !== undefined &&
              (typeof value.fis.refreshToken !== 'string' ||
                value.fis.refreshToken === '' ||
                typeof value.fis.authToken?.token !== 'string' ||
                value.fis.authToken.token === '' ||
                Number.isFinite(value.fisExpires) !== true))
          ) {
            throw new Error('Invalid receiver state');
          }
          this.#state = value;
        } finally {
          await file.close();
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    if (this.#state === undefined) {
      let bytes = crypto.randomBytes(17);
      bytes[0] = 0x70 | (bytes[0] & 0x0f);
      this.#state = { version: 1, binding: this.#binding, fid: bytes.toString('base64url').slice(0, 22) };
    }
  }

  async #save(signal) {
    signal.throwIfAborted();
    if (this.#file === undefined) {
      return;
    }
    let data = JSON.stringify(this.#state);
    if (data.length > 65536) {
      throw new Error('Oversized receiver state');
    }
    await fs.mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    let temporary = this.#file + '.' + crypto.randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
      signal.throwIfAborted();
      await fs.rename(temporary, this.#file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}
