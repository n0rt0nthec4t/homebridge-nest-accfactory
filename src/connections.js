// Connections
// Part of homebridge-nest-accfactory
//
// Manages account-level Nest/Google connection state.
//
// Provides a centralised registry for configured account connections,
// authentication state, timers, gRPC transports, camera authentication
// details, and pending snapshot waiters.
//
// Responsibilities:
// - Build runtime connection entries from processed configuration
// - Perform account authorisation and token refresh
// - Manage reconnect and retry behaviour
// - Store and manage connection state by UUID
// - Track authorisation status
// - Create and manage gRPC transports
// - Handle connection cleanup and shutdown
// - Release transports and clear timers safely
// - Resolve/cleanup pending snapshot waiters during disconnect
//
// Notes:
// - Connections are stored internally using a Map keyed by UUID
// - fromConfig() creates runtime connection entries from processed config data
// - runtime cleanup releases transient connection resources but keeps scheduled lifecycle timers intact
// - shutdown() fully cleans up all connections and clears the registry
//
// Code version 2026.05.09
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import path from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';
import { URL } from 'node:url';

// Import our modules
import GrpcTransport from './grpctransport.js';
import { fetchWrapper } from './utils.js';

// Define constants
import { ACCOUNT_TYPE, USER_AGENT, __dirname } from './consts.js';

const CONNECTION_RETRY_INITIAL = 15000; // First retry delay after auth/refresh failure
const CONNECTION_RETRY_MAX = 60000; // Maximum retry delay after repeated failures
const CONNECTION_REFRESH_FALLBACK = 3600; // Fallback refresh delay in seconds when endpoint expiry is unavailable

export default class Connections {
  // Internal connection registry
  #connections = new Map();
  #config = {};
  #log = undefined;
  #onAuthorised = undefined;

  constructor(options = {}) {
    if (options !== null && typeof options === 'object') {
      this.#config = options?.config ?? {};
      this.#log = options?.log;
      this.#onAuthorised = typeof options?.onAuthorised === 'function' ? options.onAuthorised : undefined;
    }
  }

  static fromConfig(config = {}, options = {}) {
    let manager = new Connections({
      ...options,
      config,
    });

    // Configuration has already been normalised by the caller; this step creates
    // runtime state entries with UUIDs, endpoint hosts, timers, and waiters.
    for (let account of config.accounts || []) {
      let entry = undefined;

      if (account?.exclude === true) {
        options?.log?.warn?.('Account "%s" is ignored due to it being marked as excluded', account?.name);
        continue;
      }

      // Skip invalid account records. Validation should already have happened,
      // but this keeps the runtime builder tolerant of partial input.
      if (typeof account?.name !== 'string' || account.name.trim() === '') {
        continue;
      }

      let accountName = account.name.trim();
      let fieldTest = account?.fieldTest === true;
      let baseEntry = {
        name: accountName,
        authorised: false,
        allowRetry: undefined,
        fieldTest,

        timer: undefined,
        connecting: false,
        retryDelay: CONNECTION_RETRY_INITIAL,
        refreshDelay: CONNECTION_REFRESH_FALLBACK * 1000,
        subscribeTimer: undefined,
        observeTimer: undefined,

        grpcTransport: undefined,
        cameraAuth: undefined,
        snapshotWaiters: new Map(),

        referer: fieldTest === true ? 'home.ft.nest.com' : 'home.nest.com',
        restAPIHost: fieldTest === true ? 'home.ft.nest.com' : 'home.nest.com',
        cameraAPIHost: fieldTest === true ? 'camera.home.ft.nest.com' : 'camera.home.nest.com',
        grpcEndpointHost: fieldTest === true ? 'apigw.ft.nest.com' : 'apigw.production.nest.com',
        protobufAPIHost: fieldTest === true ? 'grpc-web.ft.nest.com' : 'grpc-web.production.nest.com',
      };

      // Nest accounts authenticate from a long-lived access token.
      if (account.type === 'nest' && typeof account.access_token === 'string' && account.access_token.trim() !== '') {
        entry = {
          ...baseEntry,
          type: ACCOUNT_TYPE.NEST,
          access_token: account.access_token.trim(),
        };
      }

      // Google accounts authenticate from issueToken/cookie pair.
      if (
        account.type === 'google' &&
        typeof account.issueToken === 'string' &&
        account.issueToken.trim() !== '' &&
        typeof account.cookie === 'string' &&
        account.cookie.trim() !== ''
      ) {
        entry = {
          ...baseEntry,
          type: ACCOUNT_TYPE.GOOGLE,
          issueToken: account.issueToken.trim(),
          cookie: account.cookie.trim(),
        };
      }

      if (entry !== undefined) {
        manager.#connections.set(crypto.randomUUID(), entry);
      }
    }

    return manager;
  }

  async connect(uuid) {
    let connection = this.#connections.get(uuid);

    // Ignore unknown connection IDs; callers can safely request reconnects
    // against entries that may have been removed during shutdown.
    if (typeof connection !== 'object' || connection === null) {
      return;
    }

    let isRetry = connection.allowRetry === true;
    let accountLabel = connection.type === ACCOUNT_TYPE.GOOGLE ? 'Google' : 'Nest';

    if (connection.authorised === true) {
      this.#log?.debug?.('Performing periodic token refresh using %s account for connection "%s"', accountLabel, connection.name);
    } else {
      // First authorisation is user-visible; retries are debug-only.
      this.#log?.[isRetry === true ? 'debug' : 'info']?.(
        'Performing authorisation for connection "%s" %s',
        connection.name,
        connection.fieldTest === true ? 'using field test endpoints' : '',
      );
    }

    if (connection.type === ACCOUNT_TYPE.GOOGLE) {
      await this.#connectGoogle(uuid, isRetry, accountLabel);
      return;
    }

    if (connection.type === ACCOUNT_TYPE.NEST) {
      await this.#connectNest(uuid, isRetry, accountLabel);
    }
  }

  start(uuid) {
    let connection = this.#connections.get(uuid);

    if (connection === undefined) {
      return false;
    }

    // Start the lifecycle immediately. The scheduler will choose refresh or
    // retry timing after each attempt.
    this.#run(uuid);

    return true;
  }

  markUnauthorised(uuid, reason = '') {
    let connection = this.#connections.get(uuid);

    if (connection === undefined) {
      return false;
    }

    connection.authorised = false;
    connection.allowRetry = true;

    if (reason !== '') {
      this.#log?.debug?.('Connection "%s" marked unauthorised: %s', connection.name, reason);
    }

    // Drop transient auth-bound resources before retrying with a fresh session.
    this.#cleanupRuntime(uuid);

    // Wake the lifecycle scheduler quickly instead of waiting for the old
    // refresh timer to fire.
    this.#run(uuid, CONNECTION_RETRY_INITIAL);

    return true;
  }

  async #run(uuid, delay = 0) {
    let connection = this.#connections.get(uuid);
    let scheduleDelay = Math.max(0, Number(delay) || 0);

    if (connection === undefined || connection.allowRetry === false) {
      return false;
    }

    if (scheduleDelay > 0) {
      clearTimeout(connection.timer);
      connection.timer = setTimeout(() => this.#run(uuid), scheduleDelay);
      return true;
    }

    if (connection.connecting === true) {
      return false;
    }

    connection.connecting = true;

    try {
      await this.connect(uuid);
    } catch (error) {
      // connect() handles expected auth errors internally. This guard catches
      // unexpected failures and lets the scheduler retry later.
      this.#log?.debug?.(
        'Unexpected connection lifecycle error for "%s": %s',
        connection.name,
        typeof error?.message === 'string' ? error.message : String(error),
      );
      connection.authorised = false;
      connection.allowRetry = true;
    } finally {
      connection.connecting = false;
    }

    // Stop if this entry was removed/replaced while the attempt was running.
    if (this.#connections.get(uuid) !== connection || connection.allowRetry === false) {
      return;
    }

    if (connection.authorised === true) {
      connection.retryDelay = CONNECTION_RETRY_INITIAL;
      this.#run(uuid, connection.refreshDelay);
      return true;
    }

    let retryDelay = Number.isFinite(Number(connection.retryDelay)) === true ? Number(connection.retryDelay) : CONNECTION_RETRY_INITIAL;

    connection.retryDelay = Math.min(retryDelay * 2, CONNECTION_RETRY_MAX);
    this.#run(uuid, retryDelay);
    return true;
  }

  async #connectGoogle(uuid, isRetry, accountLabel) {
    let connection = this.#connections.get(uuid);

    try {
      // Exchange Google account cookie/issueToken for an OAuth access token.
      let tokenResponse = await fetchWrapper('get', connection.issueToken, {
        headers: {
          Referer: 'https://accounts.google.com/',
          Cookie: connection.cookie,
          'User-Agent': USER_AGENT,
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          'X-Requested-With': 'XmlHttpRequest',
        },
      });

      let tokenData = await tokenResponse.json();

      if (typeof tokenData?.error === 'string') {
        let error = new Error(
          (tokenData?.detail ? String(tokenData.detail) : '') + (tokenData?.error ? ' (' + String(tokenData.error) + ')' : ''),
        );
        error.name = 'GoogleAuthError';
        error.code = tokenData.error;
        error.statusText = tokenData.detail || 'OAuth error';
        throw error;
      }

      let googleOAuth2Token = tokenData.access_token.trim();

      // Convert the OAuth token into the JWT expected by the Nest session endpoint.
      let jwtResponse = await fetchWrapper(
        'post',
        'https://nestauthproxyservice-pa.googleapis.com/v1/issue_jwt',
        {
          headers: {
            Referer: 'https://' + connection.referer,
            Origin: 'https://' + connection.referer,
            Authorization: tokenData.token_type + ' ' + tokenData.access_token,
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/json',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'cross-site',
          },
        },
        {
          policy_id: 'authproxy-oauth-policy',
          google_oauth_access_token: tokenData.access_token,
          embed_google_oauth_access_token: true,
          expire_after: '3600s',
        },
      );

      let jwtData = await jwtResponse.json();

      if ((jwtData?.jwt?.trim?.() ?? '') === '') {
        this.#log?.debug?.('JWT response object', jwtData);
        throw new Error('Missing jwt in JWT response');
      }

      let sessionData = await this.#fetchSession(connection, 'Basic ' + jwtData.jwt);

      // Store authorised runtime state and schedule token refresh.
      await this.#applyAuthorisedConnection(
        uuid,
        sessionData,
        {
          key: 'Authorization',
          value: 'Basic ',
          token: sessionData.access_token,
          oauth2: googleOAuth2Token,
          fieldTest: connection.fieldTest === true,
        },
        tokenData.expires_in - 300,
        isRetry === true
          ? 'Successfully performed token refresh using Google account for connection "%s"'
          : 'Successfully authorised using Google account for connection "%s"',
        isRetry,
      );
    } catch (error) {
      this.#handleConnectError(
        uuid,
        error,
        ['USER_LOGGED_OUT', 'ERR_INVALID_URL', 401, 403],
        'Token refresh failed using Google account for connection "%s"',
        'Authorisation failed using Google account for connection "%s"',
        accountLabel,
      );
    }
  }

  async #connectNest(uuid, isRetry, accountLabel) {
    let connection = this.#connections.get(uuid);

    try {
      // Legacy Nest accounts first exchange their configured access token for
      // a camera API session cookie.
      let loginResponse = await fetchWrapper(
        'post',
        new URL('/api/v1/login.login_nest', 'https://webapi.' + connection.cameraAPIHost).href,
        {
          withCredentials: true,
          headers: {
            Referer: 'https://' + connection.referer,
            Origin: 'https://' + connection.referer,
            'User-Agent': USER_AGENT,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
          },
        },
        Buffer.from('access_token=' + connection.access_token, 'utf8'),
      );

      let loginData = await loginResponse.json();

      if ((loginData?.items?.[0]?.session_token?.trim?.() ?? '') === '') {
        let error = new Error(
          (loginData?.status_detail ? String(loginData.status_detail) : '') +
            (loginData?.status_description ? ' (' + String(loginData.status_description) + ')' : '') +
            (loginData?.status_detail || loginData?.status_description ? '' : 'Nest login failed with status ' + loginData.status),
        );
        error.name = 'NestAuthError';
        error.code = loginData.status;
        error.message = loginData?.status_description || 'Error';
        throw error;
      }

      let nestToken = loginData.items[0].session_token;

      let sessionData = await this.#fetchSession(connection, 'Basic ' + connection.access_token);

      // Store authorised runtime state and schedule token refresh.
      await this.#applyAuthorisedConnection(
        uuid,
        sessionData,
        {
          key: 'cookie',
          value: connection.fieldTest === true ? 'website_ft=' : 'website_2=',
          token: nestToken,
          fieldTest: connection.fieldTest === true,
        },
        3600 * 24,
        isRetry === true
          ? 'Successfully performed token refresh using Nest account for connection "%s"'
          : 'Successfully authorised using Nest account for connection "%s"',
        isRetry,
      );
    } catch (error) {
      this.#handleConnectError(
        uuid,
        error,
        ['ERR_INVALID_URL', 401, 403],
        'Token refresh failed using Nest account for connection "%s"',
        'Authorisation failed using Nest account for connection "%s"',
        accountLabel,
      );
    }
  }

  async #fetchSession(connection, authorization) {
    // Both Google and legacy Nest auth flows finish by asking the Nest session
    // endpoint for the access token and service URLs used by runtime APIs.
    let response = await fetchWrapper('get', new URL('/session', 'https://' + connection.restAPIHost).href, {
      headers: {
        Referer: 'https://' + connection.referer,
        Origin: 'https://' + connection.referer,
        Authorization: authorization,
        'User-Agent': USER_AGENT,
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
      },
    });

    let data = await response.json();

    // Without an access token the connection cannot subscribe, observe, or make
    // authenticated camera/weather requests, so fail this auth attempt clearly.
    if ((data?.access_token?.trim?.() ?? '') === '') {
      this.#log?.debug?.('Nest session response object', data);
      throw new Error('Missing access_token in session response');
    }

    return data;
  }

  async #applyAuthorisedConnection(uuid, sessionData, cameraAuth, refreshSeconds, successMessage, isRetry) {
    let connection = this.#connections.get(uuid);
    let refreshSecondsSafe =
      Number.isFinite(Number(refreshSeconds)) === true ? Math.max(60, Number(refreshSeconds)) : CONNECTION_REFRESH_FALLBACK;
    let wasAuthorised = connection?.authorised === true;

    if (connection === undefined) {
      return;
    }

    this.#log?.[isRetry === true ? 'debug' : 'success']?.(successMessage, connection.name);

    // Drop old transports/waiters before installing the refreshed session.
    this.#cleanupRuntime(uuid);

    // Mutate the live connection object so callers holding a reference see
    // refreshed tokens/transports without needing a registry replacement.
    Object.assign(connection, {
      authorised: true,
      allowRetry: true,
      userID: sessionData.userid,
      transport_url: sessionData?.urls?.transport_url,
      weather_url: sessionData?.urls?.weather_url,
      token: sessionData.access_token,
      cameraAuth,
      grpcTransport:
        this.#config?.options?.useGoogleAPI === true
          ? new GrpcTransport({
              log: this.#log,
              protoPath: path.join(__dirname, 'protobuf/root.proto'),
              endpointHost: 'https://' + connection.grpcEndpointHost,
              uuid,
              userAgent: USER_AGENT,
              getAuthHeader: () => {
                let token = this.#connections.get(uuid)?.token;
                return typeof token === 'string' && token.trim() !== '' ? 'Basic ' + token : '';
              },
            })
          : undefined,
      snapshotWaiters: new Map(),
      refreshDelay: refreshSecondsSafe * 1000,
      retryDelay: CONNECTION_RETRY_INITIAL,
    });

    if (typeof this.#onAuthorised !== 'function') {
      return;
    }

    try {
      // The manager owns auth state only. Device updates and data-ingestion
      // startup stay with the callback owner.
      await this.#onAuthorised(uuid, connection, { wasAuthorised, isRetry });
    } catch (error) {
      this.#log?.debug?.(
        'Authorised connection callback failed for connection "%s": %s',
        connection?.name,
        typeof error?.message === 'string' ? error.message : String(error),
      );
    }
  }

  #handleConnectError(uuid, error, nonRetryableCodes, retryErrorMessage, authErrorMessage, accountLabel) {
    let connection = this.#connections.get(uuid);

    if (connection === undefined) {
      return;
    }

    let statusCode =
      error?.code !== undefined && error?.code !== null
        ? error.code
        : error?.status !== undefined && error?.status !== null
          ? error.status
          : undefined;

    // Some failures are terminal until the user updates credentials/config.
    if (nonRetryableCodes.includes(statusCode) === true) {
      connection.allowRetry = false;
    } else {
      connection.allowRetry = true;
    }

    connection.authorised = false;
    this.#cleanupRuntime(uuid);

    // Treat anything other than explicit false as retryable.
    let retryState = connection.allowRetry === false ? 'will not retry' : 'will retry';

    // Debug log keeps exact failure detail available without making normal logs noisy.
    this.#log?.debug?.(
      'Failed to connect using %s credentials for connection "%s" %s: Error was "%s"',
      accountLabel,
      connection.name,
      retryState,
      typeof error?.message === 'string' ? error.message : String(error),
    );

    this.#log?.error?.(connection.allowRetry === false ? authErrorMessage : retryErrorMessage, connection.name);
  }

  get size() {
    return this.#connections.size;
  }

  get(uuid) {
    return this.#connections.get(uuid);
  }

  entries() {
    return this.#connections.entries();
  }

  #cleanupRuntime(uuid) {
    let connection = this.#connections.get(uuid);

    if (connection === undefined) {
      return;
    }

    // Runtime cleanup is used during re-auth paths. Keep lifecycle timers
    // intact; only release transient transport/waiter state.
    connection.grpcTransport?.release?.();
    connection.grpcTransport = undefined;

    if (connection.snapshotWaiters instanceof Map !== true) {
      return;
    }

    // Resolve waiters rather than reject so in-flight snapshot requests can
    // continue through their normal fallback path during disconnect/shutdown.
    for (let waiter of connection.snapshotWaiters.values()) {
      if (typeof waiter === 'function') {
        waiter();
      }
    }

    connection.snapshotWaiters.clear();
  }

  #cleanup(uuid) {
    let connection = this.#connections.get(uuid);

    if (connection === undefined) {
      return;
    }

    // Full cleanup is used for shutdown/delete and owns all scheduled work.
    clearTimeout(connection.timer);
    connection.timer = undefined;

    connection.connecting = false;

    clearTimeout(connection.subscribeTimer);
    connection.subscribeTimer = undefined;

    clearTimeout(connection.observeTimer);
    connection.observeTimer = undefined;

    this.#cleanupRuntime(uuid);
  }

  #clear() {
    // Snapshot keys first so cleanup remains safe if entries are mutated later.
    for (let uuid of Array.from(this.#connections.keys())) {
      this.#cleanup(uuid);
    }

    this.#connections.clear();
  }

  shutdown() {
    this.#clear();
  }
}
