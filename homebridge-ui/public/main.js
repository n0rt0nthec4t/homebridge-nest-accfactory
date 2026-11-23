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
// Code version 2026.11.23
// Mark Hulskamp

// Define our modules
import { ACCOUNT_TYPE } from './constants.js';
import { stageAccount } from './config.js';

export async function startSetup(homebridge, document) {
  // Define DOM access and wizard state. Pending credentials exist only during
  // review; generation identifies replies belonging to the currently open flow.
  const element = (id) => document.getElementById(id);

  let generation = 0;
  let pending;
  let targets = [];
  let target;
  let busy = false;

  const status = (message, failed = false, successful = false) => {
    // All callers provide fixed messages; backend exception bodies are not shown.
    element('connection-status').textContent = message;
    element('connection-status').className = failed === true ? 'text-danger' : successful === true ? 'text-success' : 'text-muted';
  };

  const reset = () => {
    // Discard the previous review and cookie before another connection attempt.
    // Resetting the wizard does not write or replace any account configuration.
    pending = undefined;
    for (const key of ['issue-token', 'account-cookie', 'access-token']) {
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

  const open = async () => {
    // Build reconnect choices from the latest draft, preserving the exact target
    // snapshot so a later account edit cannot silently receive these credentials.
    try {
      const configs = await homebridge.getPluginConfig();
      const block = configs.find((entry) => entry.platform === 'NestAccfactory');

      targets = (block?.accounts ?? [])
        .map((account, index) => ({ account, index }))
        .filter((entry) => [ACCOUNT_TYPE.GOOGLE, ACCOUNT_TYPE.NEST].includes(entry.account.type) === true);

      const select = element('account-target');

      select.replaceChildren();
      for (const [index, label] of ['Add a new account', ...targets.map((entry) => 'Reconnect: ' + entry.account.name)].entries()) {
        const option = document.createElement('option');

        option.value = String(index);
        option.textContent = label;
        select.append(option);
      }

      target = undefined;
      element('settings-status').textContent = '';
      element('account-name').value = 'Google';
      element('field-test').checked = false;
      element('account-type').value = ACCOUNT_TYPE.GOOGLE;
      element('account-type').disabled = false;
      element('google-fields').hidden = false;
      element('nest-fields').hidden = true;
      reset();
      homebridge.hideSchemaForm();
      element('connection-toolbar').hidden = true;
      element('connection-panel').hidden = false;
    } catch {
      element('settings-status').textContent = 'Unable to load account settings. Close and reopen settings to retry.';
    }
  };

  element('account-type').addEventListener('change', () => {
    element('google-fields').hidden = element('account-type').value !== ACCOUNT_TYPE.GOOGLE;
    element('nest-fields').hidden = element('account-type').value !== ACCOUNT_TYPE.NEST;
  });

  element('open-connection').addEventListener('click', open);

  element('account-target').addEventListener('change', () => {
    // The first dropdown entry means a new account. Other entries retain their
    // original configuration index and snapshot for safe reconnection later.
    const selected = targets[Number(element('account-target').value) - 1];

    target = selected === undefined ? undefined : { index: selected.index, expected: JSON.stringify(selected.account) };
    element('account-name').value = selected?.account.name ?? 'Google';
    element('field-test').checked = selected?.account.fieldTest === true;
    element('account-type').value = selected?.account.type ?? ACCOUNT_TYPE.GOOGLE;
    element('account-type').disabled = selected !== undefined;
    element('account-type').dispatchEvent(new Event('change'));
  });

  element('cancel-connection').addEventListener('click', () => {
    // The bounded authentication check may still finish; ignore its reply after closing.
    close();
  });

  element('connect').addEventListener('click', async () => {
    if (busy === true) {
      return;
    }

    const type = element('account-type').value;
    const credentials =
      type === ACCOUNT_TYPE.GOOGLE
        ? { issueToken: element('issue-token').value.trim(), cookie: element('account-cookie').value.trim() }
        : { access_token: element('access-token').value.trim() };
    if (Object.values(credentials).some((value) => value === '')) {
      status('Complete the sign-in fields.', true);
      return;
    }

    const current = ++generation;

    // Keep the cookie only for this request. A successful reply stays in memory
    // for review and is not staged until Add/Update account is selected.
    for (const key of ['issue-token', 'account-cookie', 'access-token']) {
      element(key).value = '';
    }
    busy = true;
    element('connect').disabled = true;
    element('connect').textContent = 'Checking…';
    element('account-target').disabled = true;
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
      element('account-target').disabled = false;
      element('account-name').disabled = false;
      element('field-test').disabled = false;
      element('account-type').disabled = target !== undefined;
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
