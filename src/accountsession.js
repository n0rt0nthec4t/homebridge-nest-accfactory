// AccountSession
// Part of homebridge-nest-accfactory
//
// Authenticates one Nest, Google or Google Home account and maintains the credential
// record shared by its API and camera clients.
//
// Responsibilities:
// - Select production or field-test endpoints and perform the account login flow
// - Share one pending authentication attempt across concurrent API connects
// - Maintain session tokens and camera authentication details
// - Schedule token refresh and bounded retries, stopping on terminal auth failures
// - Notify clients when authentication is replaced or invalidated
// - Retire timers and late authentication replies on account shutdown
//
// Ownership:
// - Accounts registers the account and starts its primary API client
// - API clients retire their own subscriptions and transports on session events
// - Successful refresh replaces active source transports
// - Camera credential notification completes before clients resume ingestion
// - This session does not own resource data, API transports or HomeKit accessories
//
// Code version 2026.11.28
// Mark Hulskamp
'use strict';

// Define node.js modules
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { setTimeout, clearTimeout } from 'node:timers';
import { URL } from 'node:url';
import { fetchWrapper } from './fetchWrapper.js';
import { ACCOUNT_TYPE, USER_AGENT } from './consts.js';

// Define constants
const AUTH_RETRY_INITIAL = 15000;
const AUTH_RETRY_MAX = 60000;
const AUTH_REFRESH_FALLBACK = 3600;
// Client context used when enrolling the experimental Google Home SSO credential.
// Each session reuses its account-specific device ID for token renewal.
const GOOGLE_HOME_SSO_CLIENT_ID = '498579633514-hhlrn8mcjv1427j0s19dgfoe5cqaba4l.apps.googleusercontent.com';
const GOOGLE_HOME_SSO_USER_AGENT = 'com.google.Chromecast/3.11 iSL/3.4 iPhone/17.5 hw/iPhone15_2 (gzip)';

export default class AccountSession extends EventEmitter {
  #account = undefined;
  #uuid = undefined;
  #active = true; // False permanently retires this session, including late login replies.
  #pending = undefined; // Shared login/refresh promise for the protobuf client and the auth scheduler.
  #log = undefined;
  #onAuthorised = undefined;

  constructor(account, { uuid, log, onAuthorised } = {}) {
    super();

    // Account type selects only the login exchange. The protobuf client uses this
    // resulting credential record, including field-test endpoint selection.
    let fieldTest = account.fieldTest === true;
    this.#account = {
      ...account,
      type: account.type,
      authorised: false,
      allowRetry: undefined,
      timer: undefined,
      connecting: false,
      retryDelay: AUTH_RETRY_INITIAL,
      refreshDelay: AUTH_REFRESH_FALLBACK * 1000,
      fieldTest,
      referer: fieldTest === true ? 'home.ft.nest.com' : 'home.nest.com',
      restAPIHost: fieldTest === true ? 'home.ft.nest.com' : 'home.nest.com',
      cameraAPIHost: fieldTest === true ? 'camera.home.ft.nest.com' : 'camera.home.nest.com',
      grpcEndpointHost: fieldTest === true ? 'apigw.ft.nest.com' : 'apigw.production.nest.com',
    };

    this.#uuid = uuid;
    // Google accepts a generated device ID with the stored SSO credential. Keep
    // it stable for this account's retries and renewals without changing config.
    if (account.type === ACCOUNT_TYPE.GOOGLE_HOME) {
      this.#account.deviceId = typeof account.deviceId === 'string' ? account.deviceId.trim() : account.deviceId;
      this.#account.deviceId ??= randomUUID();
    }
    this.#log = log;
    this.#onAuthorised = onAuthorised;
  }

  get account() {
    return this.#account;
  }

  static async testConnection(account) {
    // Static so supplied credentials are checked in a fresh session, without reusing or changing a running session.
    // Validate credentials before testing; Google cookies must only be sent to its HTTPS account endpoint.
    let fields =
      account?.type === ACCOUNT_TYPE.GOOGLE
        ? ['issueToken', 'cookie']
        : account?.type === ACCOUNT_TYPE.NEST
          ? ['access_token']
          : account?.type === ACCOUNT_TYPE.GOOGLE_HOME
            ? ['refreshToken']
            : undefined;
    if (fields === undefined || fields.some((field) => typeof account[field] !== 'string' || account[field].trim() === '')) {
      return 'failed';
    }
    let credentials = Object.fromEntries(fields.map((field) => [field, account[field].trim()]));
    if (account.type === ACCOUNT_TYPE.GOOGLE) {
      let url = URL.parse(credentials.issueToken);
      if (url?.origin !== 'https://accounts.google.com' || url.username !== '' || url.password !== '') {
        return 'failed';
      }
    }

    // Use an isolated, quiet session with a 15-second deadline for the complete authentication exchange.
    let session = new AccountSession({
      type: account.type,
      fieldTest: account.fieldTest === true,
      ...credentials,
      ...(account.type === ACCOUNT_TYPE.GOOGLE_HOME ? { deviceId: account.deviceId } : {}),
    });
    let controller = new AbortController();
    let timer = setTimeout(() => controller.abort(), 15000);
    try {
      // Bypass connect()'s scheduler; the same login exchange runs without a logger or API clients.
      let authorised = await session.#authenticate(controller.signal);
      // Return only success, failed or timeout, keeping credentials and backend errors private.
      return controller.signal.aborted === true ? 'timeout' : authorised === true ? 'success' : 'failed';
    } finally {
      // Always retire the temporary session and deadline timer.
      clearTimeout(timer);
      session.disconnect();
    }
  }

  // API clients reuse valid credentials. The scheduler and callers requesting
  // an explicit reconnect pass refresh=true to repeat the original login exchange.
  async connect(refresh = false) {
    if (this.#active !== true) {
      throw new Error('Account session has been disconnected');
    }

    if (this.#account.authorised === true && refresh !== true) {
      return true;
    }

    if (this.#pending === undefined) {
      // This attempt replaces the scheduled one. Concurrent callers below await
      // the same promise instead of exchanging the account credentials again.
      clearTimeout(this.#account.timer);
      this.#account.timer = undefined;
      this.#pending = this.#authenticate().finally(() => {
        this.#pending = undefined;

        // API connect() calls share this scheduler, so standalone clients also
        // keep refresh/retry ownership without starting another login.
        if (this.#account.connecting !== true) {
          this.#schedule();
        }
      });
    }

    return await this.#pending;
  }

  async #authenticate(signal) {
    let uuid = this.#uuid;
    let account = this.#account;

    let isRetry = account.allowRetry === true;
    let accountLabel = account.type === ACCOUNT_TYPE.GOOGLE_HOME ? 'Google Home' : account.type === ACCOUNT_TYPE.GOOGLE ? 'Google' : 'Nest';

    if (account.authorised === true) {
      this.#log?.debug?.('Performing periodic token refresh using %s account for account "%s"', accountLabel, account.name);
    } else {
      // First authorisation is user-visible; retries are debug-only.
      this.#log?.[isRetry === true ? 'debug' : 'info']?.(
        'Performing authorisation for account "%s" %s',
        account.name,
        account.fieldTest === true ? 'using field test endpoints' : '',
      );
    }

    try {
      let session =
        account.type === ACCOUNT_TYPE.GOOGLE_HOME
          ? await this.#connectGoogleHome(account, signal)
          : account.type === ACCOUNT_TYPE.GOOGLE
            ? await this.#connectGoogle(account, signal)
            : await this.#connectNest(account, signal);

      // Authentication can finish after shutdown; only its original account may adopt the session.
      if (this.#active === true) {
        await this.#applyAuthorisedSession(uuid, session, isRetry);
      }
    } catch (error) {
      if (this.#active === true) {
        this.#handleConnectError(account, error);
      }
    }

    return this.#active === true && account.authorised === true;
  }

  start() {
    // Start the lifecycle immediately. The scheduler will choose refresh or
    // retry timing after each attempt.
    this.#run();

    return true;
  }

  markUnauthorised(reason = '') {
    let account = this.#account;

    account.authorised = false;
    account.allowRetry = true;

    if (reason !== '') {
      this.#log?.debug?.('Account "%s" marked unauthorised: %s', account.name, reason);
    }

    // false means authentication was lost: Observe stops and releases
    // its transport and pending image waiters before the account retries login.
    this.emit('disconnect', false);

    // Wake the lifecycle scheduler quickly instead of waiting for the old
    // refresh timer to fire.
    this.#run(AUTH_RETRY_INITIAL);

    return true;
  }

  async #run(delay = 0) {
    let account = this.#account;
    let scheduleDelay = Math.max(0, Number(delay) || 0);

    if (this.#active !== true || account.allowRetry === false) {
      return false;
    }

    if (scheduleDelay > 0) {
      clearTimeout(account.timer);
      account.timer = setTimeout(() => this.#run(), scheduleDelay);

      return true;
    }

    // Prevent two scheduler runs from choosing competing retry deadlines.
    // connect() separately shares the login promise with direct API callers.
    if (account.connecting === true) {
      return false;
    }

    account.connecting = true;

    try {
      await this.connect(true);
    } catch (error) {
      // connect() handles expected auth errors internally. This guard catches
      // unexpected failures and lets the scheduler retry later.
      this.#log?.debug?.(
        'Unexpected account lifecycle error for "%s": %s',
        account.name,
        typeof error?.message === 'string' ? error.message : String(error),
      );
      account.authorised = false;
      account.allowRetry = true;
    } finally {
      account.connecting = false;
    }

    this.#schedule();
  }

  #schedule() {
    let account = this.#account;

    // Shutdown can occur during login or camera credential notification. A retired
    // session must not install another timer; terminal auth failures also stop here.
    if (this.#active !== true || account.allowRetry === false) {
      return;
    }

    if (account.authorised === true) {
      account.retryDelay = AUTH_RETRY_INITIAL;
      this.#log?.debug?.('Next token refresh for account "%s" in %s seconds', account.name, account.refreshDelay / 1000);
      this.#run(account.refreshDelay);

      return true;
    }

    let retryDelay = Number.isFinite(Number(account.retryDelay)) === true ? Number(account.retryDelay) : AUTH_RETRY_INITIAL;

    // Wait the current delay now; retain the doubled, capped delay for the next
    // failure. A successful login resets the sequence to its initial value.
    account.retryDelay = Math.min(retryDelay * 2, AUTH_RETRY_MAX);
    this.#run(retryDelay);

    return true;
  }

  async #connectGoogle(account, signal) {
    // Google login has three steps: browser credentials -> OAuth token -> Nest JWT
    // -> Nest session. The resulting session is used by protobuf and camera authentication.
    let tokenResponse = await fetchWrapper('get', account.issueToken, {
      signal,
      headers: {
        Referer: 'https://accounts.google.com/',
        Cookie: account.cookie,
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

    // WebRTC Foyer signalling needs the OAuth token as well as the Nest session
    // credentials used by device queries and legacy camera endpoints.
    let googleOAuth2Token = tokenData.access_token.trim();
    this.#log?.debug?.(
      'Google OAuth token lifetime for account "%s": %s seconds; requesting a Nest JWT lasting 3600 seconds',
      account.name,
      Number.isFinite(Number(tokenData.expires_in)) === true ? Number(tokenData.expires_in) : 'unknown',
    );

    // Convert the OAuth token into the JWT expected by the Nest session endpoint.
    let jwtResponse = await fetchWrapper(
      'post',
      'https://nestauthproxyservice-pa.googleapis.com/v1/issue_jwt',
      {
        signal,
        headers: {
          Referer: 'https://' + account.referer,
          Origin: 'https://' + account.referer,
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
      throw new Error('Missing jwt in JWT response');
    }

    let sessionData = await this.#fetchSession(account, 'Basic ' + jwtData.jwt, signal);

    return {
      sessionData,
      cameraAuth: {
        key: 'Authorization',
        value: 'Basic ',
        token: sessionData.access_token,
        oauth2: googleOAuth2Token,
        fieldTest: account.fieldTest === true,
      },
      refreshSeconds: tokenData.expires_in - 300,
    };
  }

  async #connectGoogleHome(account, signal, notifications = true) {
    // Enrollment is separate from runtime renewal. Exchange only this account's
    // stored SSO credential; never use Nest cookies or a proprietary runtime here.
    if (/^[A-Fa-f0-9-]{36}$/.test(account.deviceId ?? '') !== true || /[\r\n]/.test(account.refreshToken) === true) {
      throw Object.assign(new Error('Invalid Google Home enrollment credentials'), { code: 401 });
    }

    let data;
    try {
      let response = await fetchWrapper(
        'post',
        'https://oauthaccountmanager.googleapis.com/v1/issuetoken',
        {
          signal,
          timeout: 15000,
          redirect: 'error',
          headers: {
            Authorization: 'Bearer ' + account.refreshToken,
            'x-oauth-client-id': GOOGLE_HOME_SSO_CLIENT_ID,
            'User-Agent': GOOGLE_HOME_SSO_USER_AGENT,
            'Accept-Language': 'en-US,en;q=0.9',
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
        Buffer.from(
          new URLSearchParams({
            app_id: 'com.google.Chromecast',
            client_id: GOOGLE_HOME_SSO_CLIENT_ID,
            device_id: account.deviceId,
            hl: 'en-US',
            lib_ver: '3.4',
            passcode_present: 'YES',
            response_type: 'token',
            scope: [
              'https://www.googleapis.com/auth/userinfo.profile',
              'https://www.googleapis.com/auth/userinfo.email',
              'https://www.googleapis.com/auth/homegraph',
              'https://www.googleapis.com/auth/nest-account',
              ...(notifications === true ? ['https://www.googleapis.com/auth/notifications'] : []),
            ].join(' '),
          }).toString(),
        ),
      );
      data = await response.json();
    } catch (error) {
      // Notification access is optional: a refused scope must not prevent
      // HomeGraph login and its polling fallback from working.
      if (notifications === true && error?.status === 403) {
        return await this.#connectGoogleHome(account, signal, false);
      }
      // Backend bodies can contain credentials. Preserve retry status without
      // forwarding response descriptions or transport error text into logs.
      throw Object.assign(new Error('Google Home token exchange failed'), { code: error?.status ?? error?.code });
    }

    if (data?.error !== undefined) {
      if (
        notifications === true &&
        ['invalid_scope', 'PERMISSION_DENIED'].includes(typeof data.error === 'string' ? data.error : data.error?.status) === true
      ) {
        return await this.#connectGoogleHome(account, signal, false);
      }
      let terminal = ['invalid_grant', 'invalid_client', 'unauthorized_client', 'access_denied', 'UNAUTHENTICATED', 'PERMISSION_DENIED'];
      throw Object.assign(new Error('Google Home token exchange rejected'), {
        code: terminal.includes(typeof data.error === 'string' ? data.error : data.error?.status) === true ? 401 : undefined,
      });
    }
    let token = [data?.token, data?.accessToken, data?.access_token].find((value) => typeof value === 'string' && value.trim() !== '');
    if (token === undefined) {
      throw new Error('Google Home token exchange returned no access token');
    }

    return {
      sessionData: { access_token: token.trim() },
      cameraAuth: { oauth2: token.trim(), fieldTest: account.fieldTest === true },
      oauth2: token.trim(),
      refreshSeconds: Number(data.expiresIn ?? data.expires_in) - 300,
    };
  }

  async #connectNest(account, signal) {
    // Legacy camera endpoints require a website session cookie. Obtain that
    // separately; Protobuf uses the token returned by the Nest session endpoint.
    let loginResponse = await fetchWrapper(
      'post',
      new URL('/api/v1/login.login_nest', 'https://webapi.' + account.cameraAPIHost).href,
      {
        signal,
        withCredentials: true,
        headers: {
          Referer: 'https://' + account.referer,
          Origin: 'https://' + account.referer,
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
        },
      },
      Buffer.from('access_token=' + account.access_token, 'utf8'),
    );

    let loginData = await loginResponse.json();

    if ((loginData?.items?.[0]?.session_token?.trim?.() ?? '') === '') {
      let error = new Error(loginData?.status_description || 'Error');
      error.name = 'NestAuthError';
      error.code = loginData.status;
      throw error;
    }

    let sessionData = await this.#fetchSession(account, 'Basic ' + account.access_token, signal);

    return {
      sessionData,
      cameraAuth: {
        key: 'cookie',
        value: account.fieldTest === true ? 'website_ft=' : 'website_2=',
        token: loginData.items[0].session_token,
        fieldTest: account.fieldTest === true,
      },
      refreshSeconds: 3600 * 24,
    };
  }

  async #fetchSession(account, authorisation, signal) {
    // Both Google and legacy Nest auth flows finish by asking the Nest session
    // endpoint for the access token and service URLs used by runtime APIs.
    let response = await fetchWrapper('get', new URL('/session', 'https://' + account.restAPIHost).href, {
      signal,
      headers: {
        Referer: 'https://' + account.referer,
        Origin: 'https://' + account.referer,
        Authorization: authorisation,
        'User-Agent': USER_AGENT,
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
      },
    });

    let data = await response.json();

    // Without an access token the account cannot subscribe, observe, or make
    // authenticated camera/weather requests, so fail this auth attempt clearly.
    if ((data?.access_token?.trim?.() ?? '') === '') {
      throw new Error('Missing access_token in session response');
    }

    return data;
  }

  async #applyAuthorisedSession(uuid, { sessionData, cameraAuth, oauth2, refreshSeconds }, isRetry) {
    let account = this.#account;

    // Google already subtracts its expiry safety margin. Clamp short/expired
    // lifetimes here to avoid an immediate authentication loop on bad expiry data.
    let refreshSecondsSafe =
      Number.isFinite(Number(refreshSeconds)) === true ? Math.max(60, Number(refreshSeconds)) : AUTH_REFRESH_FALLBACK;
    let wasAuthorised = account?.authorised === true;

    let accountLabel = account.type === ACCOUNT_TYPE.GOOGLE_HOME ? 'Google Home' : account.type === ACCOUNT_TYPE.GOOGLE ? 'Google' : 'Nest';
    this.#log?.[isRetry === true ? 'debug' : 'success']?.(
      (isRetry === true ? 'Successfully performed token refresh using ' : 'Successfully authorised using ') +
        accountLabel +
        ' account for account "%s"',
      account.name,
    );

    // true marks a credential replacement rather than lost authentication.
    // Close the old Observe transport before replacing the credentials.
    this.emit('disconnect', true);

    // Keep one credential record for both API clients and camera transports.
    // Google Home camera transports receive OAuth without Nest session credentials.
    Object.assign(account, {
      authorised: true,
      allowRetry: true,
      userID: sessionData.userid,
      token: sessionData.access_token,
      cameraAuth,
      oauth2,
      refreshDelay: refreshSecondsSafe * 1000,
      retryDelay: AUTH_RETRY_INITIAL,
    });

    // Existing camera transports receive refreshed credentials before new source
    // updates can be delivered. Accessory notification may await device work.
    try {
      await this.#onAuthorised?.(uuid, account, { wasAuthorised, isRetry });
    } catch (error) {
      // Accessory notification failure does not invalidate valid cloud credentials.
      this.#log?.debug?.(
        'Authorised account callback failed for account "%s": %s',
        account.name,
        typeof error?.message === 'string' ? error.message : String(error),
      );
    }

    // The callback can await device work while invalidation or shutdown retires
    // this session. Never restart ingestion after that asynchronous boundary.
    if (this.#active !== true || account.authorised !== true) {
      return;
    }

    this.emit('authorised');
  }

  #handleConnectError(account, error) {
    let statusCode = error?.code ?? error?.status;

    let accountLabel = account.type === ACCOUNT_TYPE.GOOGLE_HOME ? 'Google Home' : account.type === ACCOUNT_TYPE.GOOGLE ? 'Google' : 'Nest';

    // Logged-out OAuth cookies require new credentials; transient failures retain backoff retries.
    account.allowRetry =
      ['ERR_INVALID_URL', 401, 403].includes(statusCode) === false &&
      (account.type !== ACCOUNT_TYPE.GOOGLE || statusCode !== 'USER_LOGGED_OUT');

    account.authorised = false;
    this.emit('disconnect', false);

    // Treat anything other than explicit false as retryable.
    let retryState = account.allowRetry === false ? 'will not retry' : 'will retry';

    // Debug log keeps exact failure detail available without making normal logs noisy.
    this.#log?.debug?.(
      'Failed to connect using %s credentials for account "%s" %s: Error was "%s"',
      accountLabel,
      account.name,
      retryState,
      typeof error?.message === 'string' ? error.message : String(error),
    );

    this.#log?.error?.(
      (account.allowRetry === false ? 'Authorisation failed using ' : 'Token refresh failed using ') +
        accountLabel +
        ' account for account "%s"',
      account.name,
    );
  }

  // Account shutdown is permanent for this instance. Retire it before notifying
  // clients so an in-flight login cannot restore credentials during their cleanup.
  disconnect() {
    this.#active = false;
    let account = this.#account;
    clearTimeout(account.timer);
    account.timer = undefined;
    account.connecting = false;
    account.authorised = false;
    account.allowRetry = false;
    this.emit('disconnect', false);
    account.token = undefined;
    account.cameraAuth = undefined;
    account.oauth2 = undefined;
    this.removeAllListeners();
  }
}
