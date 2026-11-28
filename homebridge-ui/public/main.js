// Google/Nest guided connection UI
// Part of homebridge-nest-accfactory
//
// Guides Google/Nest sign-in, connection checks and account reconnection without device discovery.
//
// Entry points:
// - startSetup() binds the connection controls and returns an open() action
//
// Responsibilities:
// - Clear the sign-in fields from the input as soon as a request starts
// - Ignore late replies after cancellation and reject stale reconnect targets
// - Stage the account credentials only after the user accepts the review
//
// Ownership:
// - The settings host owns the surrounding draft and final Save/Cancel actions
// - The UI server owns network requests and temporary API clients
//
// Code version 2026.11.28
// Mark Hulskamp

// Define our modules
import { ACCOUNT_TYPE } from './constants.js';
import { stageAccount, googleHomeCredentials } from './config.js';

export async function startSetup(homebridge, document) {
  // Define DOM access and wizard state. Pending credentials exist only during
  // review; generation identifies replies belonging to the currently open flow.
  const element = (id) => document.getElementById(id);

  let generation = 0;
  let pending;
  let target;
  let busy = false;
  let allowedTypes = [ACCOUNT_TYPE.GOOGLE, ACCOUNT_TYPE.NEST];

  const status = (message, failed = false, successful = false) => {
    // All callers provide fixed messages; backend exception bodies are not shown.
    element('connection-status').textContent = message;
    element('connection-status').className = failed === true ? 'text-danger' : successful === true ? 'text-success' : 'text-muted';
  };

  const reset = () => {
    // Discard the previous review and cookie before another connection attempt.
    // Resetting the wizard does not write or replace any account configuration.
    pending = undefined;
    for (const key of ['issue-token', 'account-cookie', 'access-token', 'google-home-refresh', 'google-home-device']) {
      element(key).value = '';
    }
    element('connection-review').hidden = true;
    element('setup-inputs').hidden = false;
    element('connect').hidden = false;
    element('use-account').hidden = true;
    element('connect').textContent = 'Check connection';
    status('Ready to connect. Enter your account sign-in fields to continue.');
  };

  const close = () => {
    // Retire the pending reply before restoring the settings form. Cancellation
    // can race a successful server response, so aborting the request alone is insufficient.
    generation++;
    reset();
    element('connection-panel').hidden = true;
    element('connection-toolbar').hidden = false;
    homebridge.showSchemaForm();
  };

  const open = async (type = ACCOUNT_TYPE.GOOGLE, reconnectIndex) => {
    // Add has no existing-account selection. Only a card's Reconnect action
    // supplies a target; preserve its snapshot to reject stale updates later.
    try {
      const configs = await homebridge.getPluginConfig();
      const block = configs.find((entry) => entry.platform === 'NestAccfactory');

      const selected = reconnectIndex === undefined ? undefined : block?.accounts?.[reconnectIndex];
      if (reconnectIndex !== undefined && (Number.isInteger(reconnectIndex) !== true || selected?.type !== type)) {
        throw new Error('Reconnect target changed');
      }
      target = selected === undefined ? undefined : { index: reconnectIndex, expected: JSON.stringify(selected) };
      element('settings-status').textContent = '';
      element('connection-heading').textContent = selected === undefined ? 'Add account' : 'Reconnect account';
      element('connection-description').textContent =
        selected === undefined
          ? 'Check the sign-in details before adding a new account.'
          : 'Update sign-in details for “' + selected.name + '”.';
      element('account-name').value = selected?.name ?? (type === ACCOUNT_TYPE.GOOGLE_HOME ? 'Google Home' : 'Google');
      element('field-test').checked = selected?.fieldTest === true;
      // The section owns the available account types; reconnect retains the
      // selected account's type and never turns it into another data source.
      allowedTypes =
        selected !== undefined
          ? [type]
          : type === ACCOUNT_TYPE.GOOGLE_HOME
            ? [ACCOUNT_TYPE.GOOGLE_HOME]
            : [ACCOUNT_TYPE.GOOGLE, ACCOUNT_TYPE.NEST];
      const selector = element('account-type');
      selector.replaceChildren();
      for (const value of allowedTypes) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = { googlehome: 'Google Home', google: 'Google (Nest)', nest: 'Nest' }[value];
        selector.append(option);
      }
      element('account-type').value = type;
      element('account-type').disabled = allowedTypes.length === 1;
      element('google-fields').hidden = type !== ACCOUNT_TYPE.GOOGLE;
      element('nest-fields').hidden = type !== ACCOUNT_TYPE.NEST;
      element('google-home-fields').hidden = type !== ACCOUNT_TYPE.GOOGLE_HOME;
      reset();
      homebridge.hideSchemaForm();
      element('connection-toolbar').hidden = true;
      element('connection-panel').hidden = false;
    } catch {
      element('settings-status').textContent = 'Unable to load account settings. Close and reopen settings to retry.';
    }
  };

  element('account-type').addEventListener('change', () => {
    generation++;
    reset();
    if (allowedTypes.includes(element('account-type').value) !== true) {
      element('account-type').value = allowedTypes[0];
    }
    element('google-fields').hidden = element('account-type').value !== ACCOUNT_TYPE.GOOGLE;
    element('nest-fields').hidden = element('account-type').value !== ACCOUNT_TYPE.NEST;
    element('google-home-fields').hidden = element('account-type').value !== ACCOUNT_TYPE.GOOGLE_HOME;
  });

  element('open-connection').addEventListener('click', () => open());
  element('open-google-home').addEventListener('click', () => open(ACCOUNT_TYPE.GOOGLE_HOME));

  element('cancel-connection').addEventListener('click', () => {
    // The bounded authentication check may still finish; ignore its reply after closing.
    close();
  });

  element('connect').addEventListener('click', async () => {
    if (busy === true) {
      return;
    }

    const type = element('account-type').value;
    if (allowedTypes.includes(type) !== true) {
      status('Choose an account type from this section.', true);
      return;
    }
    const usingSso = type === ACCOUNT_TYPE.GOOGLE_HOME;
    let credentials =
      usingSso === true
        ? {
            refreshToken: element('google-home-refresh').value.trim(),
            ...(element('google-home-device').value.trim() !== '' ? { deviceId: element('google-home-device').value.trim() } : {}),
          }
        : type === ACCOUNT_TYPE.GOOGLE
          ? {
              issueToken: element('issue-token').value.trim(),
              cookie: element('account-cookie').value.trim(),
            }
          : { access_token: element('access-token').value.trim() };
    if (usingSso === true) {
      try {
        credentials = googleHomeCredentials(credentials);
      } catch {
        status('Enter a valid refresh token and, if supplied, its device ID.', true);
        return;
      }
    }
    if (Object.values(credentials).some((value) => value === '')) {
      status('Complete the sign-in fields.', true);
      return;
    }

    const current = ++generation;

    // Keep the cookie only for this request. A successful reply stays in memory
    // for review and is not staged until Add/Update account is selected.
    for (const key of ['issue-token', 'account-cookie', 'access-token', 'google-home-refresh', 'google-home-device']) {
      element(key).value = '';
    }
    busy = true;
    element('connect').disabled = true;
    element('connect').textContent = 'Checking…';
    element('account-name').disabled = true;
    element('field-test').disabled = true;
    element('account-type').disabled = true;
    status('Checking account connection…');
    try {
      const payload = { type, ...credentials, fieldTest: element('field-test').checked === true };
      const result = await homebridge.request('/accounts/test', payload);

      if (current !== generation) {
        return;
      }

      if (result.status !== 'success') {
        status(result.status === 'timeout' ? 'Connection timed out. Try again.' : 'Connection failed. Check the sign-in fields.', true);
        return;
      }
      // Keep only the supplied persistent fields for review. The server never
      // returns credentials, device data or a long-lived session to the UI.
      pending = { type, credentials };

      element('setup-inputs').hidden = true;
      element('connect').hidden = true;
      element('connection-review').hidden = false;
      element('use-account').hidden = false;
      element('use-account').textContent = target === undefined ? 'Add to Accounts' : 'Update account';
      status('Connection successful', false, true);
    } catch {
      if (current === generation) {
        status('Unable to check the connection. Try again.', true);
      }
    } finally {
      busy = false;
      element('connect').disabled = false;
      element('connect').textContent = 'Check connection';
      element('account-name').disabled = false;
      element('field-test').disabled = false;
      element('account-type').disabled = allowedTypes.length === 1;
    }
  });

  element('use-account').addEventListener('click', async () => {
    if (pending === undefined || busy === true) {
      return;
    }

    if (element('account-name').value.trim() === '') {
      status('Enter an account name before finishing setup.', true);

      return;
    }

    busy = true;
    element('use-account').disabled = true;
    element('cancel-connection').disabled = true;

    const current = generation;

    try {
      // Read the latest draft and reject stale reconnect targets. Never replace
      // the entire config with the snapshot captured before network requests.
      const configs = await homebridge.getPluginConfig();

      if (current !== generation) {
        return;
      }

      const staged = stageAccount(configs, {
        name: element('account-name').value,
        credentials: pending.credentials,
        type: pending.type,
        target,
        fieldTest: element('field-test').checked === true,
      });

      await homebridge.updatePluginConfig(staged);

      // This accepts the reviewed account into the host draft. The surrounding
      // settings Save action still owns persistence of the complete configuration.
      close();
      element('settings-status').textContent =
        (target === undefined ? 'Account added' : 'Account updated') + ' in settings. Use Save below to apply your changes.';
    } catch {
      status('Unable to update settings. The account may have changed; cancel and reopen setup to retry.', true);
    } finally {
      busy = false;
      element('use-account').disabled = false;
      element('cancel-connection').disabled = false;
    }
  });

  homebridge.showSchemaForm();

  return { open };
}
