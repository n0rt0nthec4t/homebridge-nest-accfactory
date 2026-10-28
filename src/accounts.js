// Accounts
// Part of homebridge-nest-accfactory
//
// Registers configured accounts, each with one shared AccountSession and both
// Nest REST and Google protobuf API clients. Account type selects the login
// flow; it does not select which API clients are available.
//
// Responsibilities:
// - Assign runtime account identities and create their sessions and API clients
// - Start both API clients and shut down their shared account sessions
// - Serialize both clients' notifications to System through one queue per account
// - Forward optional consumer notifications without owning either source cache
//
// Ownership:
// - AccountSession owns authentication, token refresh and auth retry scheduling
// - API clients own source subscriptions, request retries and transport cleanup
// - Each client owns its source cache; System owns the combined view and HomeKit devices
// - Notification acknowledgement confirms System received a batch, independently of HomeKit delivery
//
// Code version 2026.10.29
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import crypto from 'node:crypto';

// Import our modules
import AccountSession from './accountsession.js';
import NestAPI from './api/nest.js';
import GoogleAPI from './api/google.js';

export default class Accounts {
  #accounts = new Map(); // Stable account objects, keyed by their runtime UUID.
  #log = undefined;

  constructor(options = {}) {
    if (options !== null && typeof options === 'object') {
      this.#log = options?.log;
    }
  }

  static fromConfig(config = {}, options = {}) {
    let manager = new Accounts(options);

    // Configuration processing handles legacy formats and defaults. Build fresh
    // runtime state here so timers, credentials and API clients stay out of config.
    for (let account of config.accounts || []) {
      if (account?.exclude === true) {
        options?.log?.warn?.('Account "%s" is ignored due to it being marked as excluded', account?.name);
        continue;
      }

      // A blank UI account row must not create a session or start authentication.
      if (typeof account?.name !== 'string' || account.name.trim() === '') {
        continue;
      }

      // Keep configured credentials separate from the short-lived session token
      // installed after login. Refresh must repeat the original account's auth flow.
      let fields = account.type === 'nest' ? ['access_token'] : account.type === 'google' ? ['issueToken', 'cookie'] : undefined;

      if (fields === undefined || fields.some((field) => typeof account[field] !== 'string' || account[field].trim() === '')) {
        continue;
      }

      let uuid = crypto.randomUUID();
      let session = new AccountSession(
        {
          name: account.name.trim(),
          type: account.type,
          fieldTest: account.fieldTest === true,
          ...Object.fromEntries(fields.map((field) => [field, account[field].trim()])),
        },
        {
          uuid,
          log: manager.#log,
          onAuthorised: typeof options?.onAuthorised === 'function' ? options.onAuthorised : undefined,
        },
      );

      // Keep the same account object throughout refresh. Both API clients and
      // camera credential updates must see the newly installed session details.
      let entry = session.account;
      entry.session = session;

      manager.#accounts.set(uuid, entry);
      manager.#createAPIClients(uuid, entry, options ?? {});
    }

    return manager;
  }

  #createAPIClients(uuid, account, { onData }) {
    let dataQueue = Promise.resolve(); // Serialize notifications to System across both sources.
    let options = {
      uuid,
      session: account.session,
      log: this.#log,
      onData:
        typeof onData !== 'function'
          ? undefined
          : (batch) => {
              // Nest and Google share one account queue. Await System's cache commit,
              // not HomeKit delivery, so ingestion can satisfy pending snapshot queries.
              let run = dataQueue.then(() => {
                if (this.#accounts.get(uuid) === account && batch.isCurrent() === true) {
                  return onData(uuid, batch);
                }

                // The account or subscription was retired while this batch waited for its turn.
                return false;
              });

              // A rejected commit must reach the producing API so it can retry.
              // Recover the queue tail separately so later batches can still commit.
              dataQueue = run.catch(() => {});

              return run;
            },
    };

    // Clients survive session refresh; each owns its subscription identity and retry timer.
    account.nestAPI = new NestAPI(options);

    account.googleAPI = new GoogleAPI(options);
  }

  // Start background authentication and both APIs. Session and subscription retry
  // loops own later attempts; startup must not wait for the first cloud data.
  start(uuid) {
    let account = this.#accounts.get(uuid);

    if (account === undefined) {
      return false;
    }

    if (account.allowRetry !== false) {
      for (let api of [account.nestAPI, account.googleAPI]) {
        api.connect().catch((error) => {
          // Authentication already reports account failures. Log API startup failures separately.
          if (account.authorised === true) {
            this.#log?.debug?.('Unable to connect API for account "%s": %s', account.name, String(error));
          }
        });
      }
    }

    return true;
  }

  get size() {
    return this.#accounts.size;
  }

  get(uuid) {
    return this.#accounts.get(uuid);
  }

  entries() {
    return this.#accounts.entries();
  }

  // Disconnect sessions before clearing identities: clients first retire their
  // timers, transports and snapshot waiters, then late queued batches become stale.
  shutdown() {
    for (let account of this.#accounts.values()) {
      account.session.disconnect();
    }

    this.#accounts.clear();
  }
}
