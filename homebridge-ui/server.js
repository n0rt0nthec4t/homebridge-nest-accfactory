// Nest Accfactory settings server
// Part of homebridge-nest-accfactory
//
// Provides isolated Google and Nest account connection checks for the custom
// Homebridge settings UI without starting device subscriptions or discovery.
//
// Responsibilities:
// - Register the Homebridge UI /accounts/test route for Google and Nest accounts
// - Run one isolated authentication check at a time through AccountSession
// - Return only success, failed or timeout status without exposing credentials
//
// Notes:
// - AccountSession owns validation, request deadlines and authentication cleanup
// - Configuration is saved by the UI; this server only reports connection status
// - Routine IPC route notices are suppressed; other console output is preserved
//
// Code version 2026.11.23
// Mark Hulskamp
'use strict';

// Define external module requirements
import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';

// Define our modules
import AccountSession from '../dist/accountsession.js';

// The helper logs route names unconditionally; suppress only our routine IPC notice.
const uiConsole = globalThis.console;
const writeLog = uiConsole.log.bind(uiConsole);
uiConsole.log = (...args) => {
  if (args.length === 2 && args[0] === 'Incoming Request:' && args[1] === '/accounts/test') {
    return;
  }
  writeLog(...args);
};

export class NestAccfactoryUiServer extends HomebridgePluginUiServer {
  #checking = false;

  constructor() {
    super();
    this.onRequest('/accounts/test', (payload) => this.#testConnection(payload));
    this.ready();
  }

  async #testConnection(payload) {
    if (this.#checking === true) {
      throw new RequestError('An account connection check is already in progress.');
    }
    this.#checking = true;
    try {
      // The shared helper validates account fields and the Google cookie destination,
      // uses a 15-second deadline, and returns only success, failed or timeout.
      return { status: await AccountSession.testConnection(payload) };
    } catch {
      // IPC errors must never expose backend error bodies or supplied credentials.
      return { status: 'failed' };
    } finally {
      this.#checking = false;
    }
  }
}

new NestAccfactoryUiServer();
