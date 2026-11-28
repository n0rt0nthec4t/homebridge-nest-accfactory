// Nest Accfactory settings UI
// Part of homebridge-nest-accfactory
//
// Renders branded account, home, device and plugin settings inside Homebridge.
//
// Entry points:
// - startSettings() loads the current configuration and schema, then binds the UI
//
// Responsibilities:
// - Edit existing configuration fields while preserving unknown fields and defaults
// - Check account connections and edit home/device overrides manually
// - Stage draft updates in order and persist only through the explicit Save action
// - Fit the custom UI into its own settings popup without changing other dialogs
//
// Ownership:
// - This iframe owns the local draft and temporary connection status
// - The guided connection controller stages accounts through this host's draft facade
// - Homebridge owns configuration persistence and the surrounding settings dialog
//
// Code version 2026.11.28
// Mark Hulskamp

// Define our modules
import { ACCOUNT_TYPE } from './constants.js';
import { startSetup } from './main.js';
import { googleHomeCredentials } from './config.js';

// Define popup lifecycle state. The fallback form must restore the host layout.
let restoreSettingsWindow = () => {};

// Scope the surrounding popup layout to this iframe's
// own dialog, and leave other hosts unchanged when parent access is unavailable.
function fitSettingsPopup(document) {
  try {
    // Find only the dialog containing our own iframe; standalone previews and
    // cross-origin hosts retain their normal layout instead of altering the page.
    const view = document.defaultView;
    const frame = view?.frameElement;
    const dialog = frame?.closest('.modal-dialog');

    if (dialog === null || dialog === undefined) {
      return;
    }

    const stylesheet = frame.ownerDocument.createElement('link');

    // Install scoped parent styles and remove them when this iframe is retired.
    // Homebridge still owns the popup dimensions and its rounded outer corners.
    stylesheet.rel = 'stylesheet';
    stylesheet.href = new URL('./window.css', import.meta.url).href;
    frame.ownerDocument.head.append(stylesheet);
    dialog.classList.add('nest-settings-window');
    restoreSettingsWindow = () => {
      dialog.classList.remove('nest-settings-window');
      stylesheet.remove();
      view.removeEventListener('pagehide', restoreSettingsWindow);
    };

    view.addEventListener('pagehide', restoreSettingsWindow, { once: true });
  } catch {
    // A cross-origin host retains its normal modal and our working settings UI.
  }
}

export async function startSettings(homebridge, document) {
  // Define DOM helpers. Labels use textContent so account/configuration text is
  // never interpreted as HTML inside the settings iframe.
  const get = (id) => document.getElementById(id);

  const node = (tag, className, text) => {
    const item = document.createElement(tag);

    if (className !== undefined) {
      item.className = className;
    }

    if (text !== undefined) {
      item.textContent = text;
    }

    return item;
  };

  // Load the schema and complete configuration before binding controls. Clone
  // the configuration so local edits cannot mutate a host-owned object directly.
  let [configs, schema] = await Promise.all([homebridge.getPluginConfig(), homebridge.getPluginConfigSchema()]);

  configs = structuredClone(configs);

  let index = configs.findIndex((entry) => entry.platform === 'NestAccfactory');

  if (index < 0) {
    index = configs.length;
    configs.push({ platform: 'NestAccfactory', name: 'NestAccfactory' });
  }

  const block = () => configs[index];

  const accounts = () => block().accounts ?? [];

  // Compare only this plugin's draft. Missing and false account exclusion both mean enabled.
  const settingsSnapshot = () =>
    JSON.stringify({ ...block(), accounts: accounts().map(({ exclude, ...account }) => ({ ...account, exclude: exclude === true })) });
  let savedSnapshot = settingsSnapshot();
  let saving = false;
  const updateSaveState = () => {
    get('save-settings').disabled = saving === true || settingsSnapshot() === savedSnapshot;
  };
  updateSaveState();

  // Connection status belongs to this settings session, never the saved configuration.
  let writes = Promise.resolve();
  let writeFailed = false;
  let connectionStates = new Map();
  let connectionBusy = false;
  let pendingConnection;
  let fieldNumber = 0;
  let guideControls;

  // Define draft update handlers. Global messages describe settings operations;
  // account checks report their own progress and failures within each card.
  const message = (text, failed = false) => {
    get('settings-status').textContent = text;
    get('settings-status').className = failed === true ? 'text-danger' : '';
  };

  const queueDraft = () => {
    // Snapshot each edit before queuing it so slower host updates cannot write
    // older values over newer edits. Saving waits for this same queue to settle.
    const next = structuredClone(configs);
    updateSaveState();

    writes = writes.then(async () => {
      try {
        await homebridge.updatePluginConfig(next);
        writeFailed = false;

        return true;
      } catch {
        writeFailed = true;
        message('Unable to stage settings. Retry saving before closing.', true);

        return false;
      }
    });

    return writes;
  };

  const changed = () => queueDraft();

  // Identify the credentials checked. Cache keys are private comparisons only, never
  // displayed or logged; changing credentials immediately invalidates old results.
  const fingerprint = (account) =>
    JSON.stringify([
      account?.type,
      account?.issueToken,
      account?.cookie,
      account?.access_token,
      account?.refreshToken,
      account?.deviceId,
      account?.fieldTest === true,
    ]);

  // Define form controls. Buttons do not submit the surrounding Homebridge form.
  const button = (label, handler, primary = false) => {
    const item = node('button', primary === true ? 'btn btn-primary' : 'btn btn-secondary', label);

    item.type = 'button';

    item.addEventListener('click', handler);

    return item;
  };

  const option = (select, value, label) => {
    const item = node('option', undefined, label);

    item.value = value;
    select.append(item);

    return item;
  };

  // Shared rendering follows schema types, limits and defaults. Rendering a
  // default does not write it into the draft; changes store an explicit value.
  const field = (parent, key, label, definition, value, set) => {
    const wrapper = node('div', 'field');
    const id = 'setting-' + ++fieldNumber;
    let input;

    if (definition.type === 'boolean') {
      // Boolean settings use checkboxes throughout the settings UI.
      input = node('input');
      input.type = 'checkbox';
      input.checked = typeof value === 'boolean' ? value : definition.default === true;

      const caption = node('label', 'checkbox-label');

      caption.htmlFor = id;
      caption.append(input, node('span', undefined, label));
      wrapper.append(caption);
    } else {
      const caption = node('label', undefined, label);

      caption.htmlFor = id;
      wrapper.append(caption);
      if (Array.isArray(definition.enum) === true) {
        input = node('select');
        for (const entry of definition.enum) {
          option(
            input,
            entry,
            key === 'type'
              ? ({ [ACCOUNT_TYPE.GOOGLE]: 'Google', [ACCOUNT_TYPE.NEST]: 'Nest', [ACCOUNT_TYPE.GOOGLE_HOME]: 'Google Home' }[entry] ??
                  entry)
              : entry,
          );
        }
        input.value = value ?? definition.default ?? '';
      } else {
        // Use schema limits for numeric inputs and mask credential fields. Merely
        // displaying a schema default does not add that default to the draft.
        input = node('input');
        input.type =
          ['number', 'integer'].includes(definition.type) === true ? 'number' : /token|cookie/i.test(key) === true ? 'password' : 'text';
        input.value = value ?? definition.default ?? '';
        if (definition.minimum !== undefined) {
          input.min = definition.minimum;
        }

        if (definition.maximum !== undefined) {
          input.max = definition.maximum;
        }

        if (definition.type === 'integer') {
          input.step = '1';
        }

        if (definition.type === 'number') {
          input.step = 'any';
        }

        if (definition.placeholder !== undefined) {
          input.placeholder = definition.placeholder;
        }

        input.autocomplete = 'off';
      }

      wrapper.append(input);
    }

    input.id = id;

    const updateField = () => {
      // Convert DOM strings and checkbox state back to configuration types.
      let next =
        definition.type === 'boolean'
          ? input.checked
          : input.value === ''
            ? undefined
            : ['number', 'integer'].includes(definition.type) === true
                ? Number(input.value)
                : input.value;

      set(next);
    };
    input.addEventListener('change', updateField);
    // Text and number edits update the draft while typing, so Save need not wait for blur.
    if (definition.type !== 'boolean' && Array.isArray(definition.enum) !== true) {
      input.addEventListener('input', updateField);
    }

    parent.append(wrapper);

    return input;
  };

  const setValue = (object, key, value) => {
    // Deleting an unset override preserves inheritance and existing runtime defaults.
    if (value === undefined) {
      delete object[key];
    } else {
      object[key] = value;
    }
  };

  const writeOption = (key, value) => {
    block().options ??= {};
    setValue(block().options, key, value);
    changed();
    if (['eveHistory', 'exclude'].includes(key) === true) {
      renderDevices();
    }
  };

  // Define the option schema shared by global device settings and plugin options.
  const optionDefinitions = schema.schema.properties.options.properties;

  function renderOptions() {
    // Reuse schema labels, limits and defaults without inserting untouched
    // defaults into the saved configuration.
    get('global-device-settings').replaceChildren();
    get('options-fields').replaceChildren();
    const deviceSettings = schema.layout.find((section) => section.title === 'Device Settings');
    for (const entry of deviceSettings.items.filter((item) => item.key?.startsWith('options.') === true)) {
      const key = entry.key.slice(8);
      field(get('global-device-settings'), key, entry.title, optionDefinitions[key], block().options?.[key], (value) =>
        writeOption(key, value),
      );
    }

    const entries = new Map(schema.layout.find((section) => section.title === 'Options').items.map((entry) => [entry.key, entry]));
    // Keep text/number inputs together, followed by related checkboxes. Schema
    // definitions still own labels, values, constraints and configuration keys.
    for (const [title, keys] of [
      ['FFmpeg and streaming', ['ffmpegPath', 'maxStreams', 'ffmpegHWAccel', 'ffmpegTranscode']],
      ['Logging', ['debug', 'logMotionEvents', 'ffmpegDebug', 'supportDump']],
    ]) {
      const section = node('section', 'options-group');
      const grid = node('div', 'field-grid' + (title === 'FFmpeg and streaming' ? ' video-options' : ''));
      section.append(node('h3', undefined, title), grid);
      get('options-fields').append(section);
      for (const key of keys) {
        const entry = entries.get('options.' + key);
        field(grid, key, entry.title, optionDefinitions[key], block().options?.[key], (value) => writeOption(key, value));
      }
    }
  }

  function renderHomes() {
    // Home overrides retain the configured names without querying device data.
    const list = get('homes-list');

    list.replaceChildren();
    for (const [homeIndex, home] of (block().homes ?? []).entries()) {
      const row = node('article', 'override-row');
      const actions = node('div', 'override-actions');
      const remove = button('×', () => {
        block().homes.splice(homeIndex, 1);
        changed();
        renderHomes();
      });

      remove.setAttribute('aria-label', 'Remove home override');
      remove.title = 'Remove home override';
      actions.append(remove);
      row.append(actions);

      const name = field(row, 'name', 'Home', schema.schema.properties.homes.items.properties.name, home.name, (value) => {
        home.name = value ?? '';
        changed();
      });

      name.required = true;

      const grid = node('div', 'field-grid home-override-fields');

      row.append(grid);
      field(grid, 'exclude', 'Exclude all devices from this home', { type: 'boolean' }, home.exclude, (value) => {
        home.exclude = value;
        changed();
      });
      field(grid, 'weather', 'Enable Weather Station', { type: 'boolean' }, home.weather, (value) => {
        home.weather = value;
        changed();
        renderHomes();
      });
      if (home.weather === true) {
        // Hide elevation when weather is disabled, retaining its saved value for
        // the next time weather is enabled instead of silently resetting it.
        field(grid, 'elevation', 'Elevation (m)', schema.schema.properties.homes.items.properties.elevation, home.elevation, (value) => {
          setValue(home, 'elevation', value);
          changed();
        });
      }

      list.append(row);
    }

    if ((block().homes?.length ?? 0) === 0) {
      list.append(node('p', 'section-description', 'No home overrides. Add a home to configure its settings.'));
    }
  }

  function renderDevices() {
    // Device overrides use physical serials entered by the user.
    const list = get('devices-list');

    list.replaceChildren();

    for (const [deviceIndex, device] of (block().devices ?? []).entries()) {
      const row = node('article', 'override-row');
      const actions = node('div', 'override-actions');
      const remove = button('×', () => {
        block().devices.splice(deviceIndex, 1);
        changed();
        renderDevices();
      });

      remove.setAttribute('aria-label', 'Remove device override');
      remove.title = 'Remove device override';
      actions.append(remove);
      row.append(actions);

      const serial = field(
        row,
        'serialNumber',
        'Serial number',
        schema.schema.properties.devices.items.properties.serialNumber,
        device.serialNumber,
        (value) => {
          device.serialNumber = value ?? '';
          changed();
        },
      );
      serial.required = true;

      const grid = node('div', 'field-grid device-override-fields');

      row.append(grid);

      const definitions = schema.schema.properties.devices.items.properties;

      field(grid, 'name', 'Name override', definitions.name, device.name, (value) => {
        setValue(device, 'name', value);
        changed();
      });
      field(grid, 'exclude', 'Exclude device', definitions.exclude, device.exclude ?? block().options?.exclude ?? false, (value) => {
        setValue(device, 'exclude', value);
        changed();
      });
      field(
        grid,
        'eveHistory',
        'Eve History',
        definitions.eveHistory,
        device.eveHistory ?? block().options?.eveHistory ?? optionDefinitions.eveHistory.default,
        (value) => {
          setValue(device, 'eveHistory', value);
          changed();
        },
      );

      list.append(row);
    }
  }

  function editAccount(accountIndex, trigger, type = ACCOUNT_TYPE.GOOGLE) {
    // Isolate edits until Apply, retaining advanced fields from the original
    // account. Cancel discards only this editor's changes.
    const panel = get('manual-account-editor');
    const originId = trigger.id;

    const closeEditor = () => {
      panel.hidden = true;
      panel.replaceChildren();
      get('accounts-list').inert = false;
      get('connection-toolbar').inert = false;

      // Apply rebuilds account cards, so resolve the new button by its stable ID
      // instead of retaining a detached node. Cancel follows the same return path.
      homebridge.fixScrollHeight?.();
      document.defaultView.requestAnimationFrame(() => {
        if (panel.hidden === true) {
          const origin = get(originId);

          origin?.scrollIntoView({ block: 'center', behavior: 'instant' });
          origin?.focus({ preventScroll: true });
        }
      });
    };

    get('accounts-list').inert = true;
    get('connection-toolbar').inert = true;
    panel.replaceChildren();
    panel.hidden = false;

    let draft = structuredClone(accounts()[accountIndex] ?? { name: '', type });

    const render = () => {
      panel.replaceChildren();
      panel.append(node('h3', undefined, 'Account settings'));
      const definitions = schema.schema.properties.accounts.items.properties;

      field(panel, 'type', 'Account type', { type: 'string', enum: Object.values(ACCOUNT_TYPE) }, draft.type, (value) => {
        draft.type = value;
        for (const key of ['issueToken', 'cookie', 'access_token', 'refreshToken', 'deviceId']) {
          delete draft[key];
        }
        render();
      });
      const usingSso = draft.type === ACCOUNT_TYPE.GOOGLE_HOME;
      for (const key of [
        'name',
        ...(usingSso === true
          ? ['refreshToken', 'deviceId']
          : draft.type === ACCOUNT_TYPE.GOOGLE
            ? ['issueToken', 'cookie']
            : ['access_token']),
      ]) {
        field(
          panel,
          key,
          {
            name: 'Account name',
            issueToken: 'Issue Token',
            cookie: 'Cookie',
            access_token: 'Access Token',
            refreshToken: 'Refresh token',
            deviceId: 'Device ID (optional)',
          }[key],
          definitions[key],
          draft[key],
          (value) => setValue(draft, key, value),
        );
      }

      field(panel, 'fieldTest', 'Use Field Test API', definitions.fieldTest, draft.fieldTest, (value) => {
        draft.fieldTest = value;
      });

      const feedback = node('p', 'text-danger');

      panel.append(feedback);

      const buttons = node('div', 'button-row');

      buttons.append(
        button('Cancel', closeEditor),
        button(
          'Apply account',
          () => {
            const required = [
              'name',
              ...(usingSso === true ? ['refreshToken'] : draft.type === ACCOUNT_TYPE.GOOGLE ? ['issueToken', 'cookie'] : ['access_token']),
            ];

            if (
              required.some(
                (key) =>
                  typeof draft[key] !== 'string' ||
                  draft[key].trim() === '' ||
                  (definitions[key].pattern !== undefined && new RegExp(definitions[key].pattern).test(draft[key].trim()) !== true),
              )
            ) {
              feedback.textContent = 'Complete the account name and valid sign-in fields.';

              return;
            }

            for (const key of required) {
              draft[key] = draft[key].trim();
            }
            if (usingSso === true) {
              try {
                const checked = googleHomeCredentials({
                  refreshToken: draft.refreshToken,
                  ...(typeof draft.deviceId === 'string' && draft.deviceId.trim() !== '' ? { deviceId: draft.deviceId } : {}),
                });
                delete draft.deviceId;
                Object.assign(draft, checked);
              } catch {
                feedback.textContent = 'Enter a valid refresh token and, if supplied, its device ID.';
                return;
              }
            }

            block().accounts ??= [];

            // Apply commits only this editor into the surrounding unsaved draft.
            // Connection status is invalidated when the sign-in fields change.
            // Enable/disable belongs to the card and may have changed while this editor was open.
            if (accountIndex !== undefined) {
              draft.exclude = accounts()[accountIndex].exclude;
            }
            block().accounts[accountIndex ?? block().accounts.length] = draft;
            changed();
            renderAccounts();
            renderHomes();
            renderDevices();
            closeEditor();
          },
          true,
        ),
      );
      panel.append(buttons);
    };

    render();

    // Let Homebridge resize the iframe before revealing the newly opened editor.
    // Focus without a second scroll so the heading and instructions remain visible.
    homebridge.fixScrollHeight?.();
    document.defaultView.requestAnimationFrame(() => {
      if (panel.hidden === false) {
        panel.scrollIntoView({ block: 'start', behavior: 'instant' });
        panel.querySelector('input')?.focus({ preventScroll: true });
      }
    });
  }

  async function checkConnection(accountIndex) {
    // Test authentication only; discard a reply if the account changed meanwhile.
    if (connectionBusy === true) {
      return;
    }

    const account = accounts()[accountIndex];

    if ([ACCOUNT_TYPE.GOOGLE, ACCOUNT_TYPE.NEST, ACCOUNT_TYPE.GOOGLE_HOME].includes(account?.type) === false) {
      return;
    }

    const expected = fingerprint(account);

    connectionBusy = true;
    get('open-connection').disabled = true;
    get('open-google-home').disabled = true;

    // Progress and failures belong to the account whose credentials were used.
    // Fingerprint each state so edits or removals cannot attach it to another account.
    connectionStates.set(accountIndex, { fingerprint: expected, state: 'pending' });
    renderAccounts();
    try {
      const result = await homebridge.request('/accounts/test', {
        type: account.type,
        ...(account.type === ACCOUNT_TYPE.GOOGLE_HOME
          ? { refreshToken: account.refreshToken, deviceId: account.deviceId }
          : account.type === ACCOUNT_TYPE.GOOGLE
            ? { issueToken: account.issueToken, cookie: account.cookie }
            : { access_token: account.access_token }),
        fieldTest: account.fieldTest === true,
      });

      if (fingerprint(accounts()[accountIndex]) !== expected) {
        // The response belongs to removed or changed credentials; discard it
        // without replacing the new account's connection status or global settings notice.
        connectionStates.delete(accountIndex);

        return;
      }

      connectionStates.set(accountIndex, {
        fingerprint: expected,
        state: result.status === 'success' ? 'success' : result.status === 'timeout' ? 'timeout' : 'failed',
      });
    } catch {
      if (fingerprint(accounts()[accountIndex]) === expected) {
        connectionStates.set(accountIndex, { fingerprint: expected, state: 'failed' });
      }
    } finally {
      connectionBusy = false;
      get('open-connection').disabled = false;
      get('open-google-home').disabled = false;
      renderAccounts();
    }
  }

  function renderAccounts() {
    // Enable/disable edits the unsaved configuration; connection status independently
    // reports what this settings session has verified and never changes exclusion.
    const list = get('accounts-list');
    const hasGoogleHome = accounts().some((account) => account.type === ACCOUNT_TYPE.GOOGLE_HOME);
    const legacy = node('details', 'legacy-accounts');
    const legacyList = node('div', 'legacy-account-list');

    // Each section opens its account configuration fields. Nest keeps both
    // Google and legacy Nest credentials available.
    get('open-connection').disabled = connectionBusy === true;
    get('open-google-home').disabled = connectionBusy === true;

    // Retain the disclosure state when checks, toggles or edits rebuild the cards.
    legacy.open = list.querySelector('.legacy-accounts')?.open === true;
    const summary = node('summary');
    // Setup actions stay in the native disclosure header so they remain available when closed.
    summary.append(node('span', 'nest-heading', 'Nest'), get('connection-toolbar'));
    legacy.append(
      summary,
      node('p', 'section-description', 'Access devices through the Nest service using an existing Google or Nest account.'),
      node('p', 'account-guidance', 'Keep these accounts configured until all your devices are supported through Google Home.'),
      legacyList,
    );
    list.replaceChildren();

    for (const [accountIndex, account] of accounts().entries()) {
      const row = node('article', account.exclude === true ? 'account-row account-excluded' : 'account-row');

      if (account.exclude === true) {
        row.setAttribute('aria-label', (account.name ?? 'Unnamed account') + ' (excluded)');
      }

      const info = node('div', 'account-info');

      const heading = node('div', 'account-heading');
      const enabledLabel = node('label', 'account-enabled');
      const enabled = node('input');
      enabled.id = 'enabled-account-' + accountIndex;
      enabled.type = 'checkbox';
      enabled.checked = account.exclude !== true;
      enabled.setAttribute('role', 'switch');
      enabled.setAttribute('aria-label', 'Enable account ' + (account.name ?? 'Unnamed account'));
      enabledLabel.htmlFor = enabled.id;
      enabledLabel.append(enabled, node('span', undefined, enabled.checked === true ? 'Enabled' : 'Disabled'));
      enabled.addEventListener('change', () => {
        // Preserve the existing configuration key; the control presents its inverse.
        account.exclude = enabled.checked !== true;
        changed();
        renderAccounts();
        get(enabled.id).focus();
      });
      heading.append(node('div', 'account-name', account.name ?? 'Unnamed account'), enabledLabel);
      info.append(heading);
      // Pending/error state takes precedence over previous connection checks.
      // Fingerprint checks prevent account-index reuse from showing stale results.
      const savedState = connectionStates.get(accountIndex);
      const state = savedState?.fingerprint === fingerprint(account) ? savedState.state : undefined;

      // Keep the status row during checks so progress never shrinks the card.
      // The action button already says Checking; the reserved status line stays empty.
      const status = node(
        'p',
        state === 'success'
          ? 'account-status text-success'
          : ['failed', 'timeout'].includes(state) === true
              ? 'account-status text-danger'
              : 'account-status',
        state === 'pending'
          ? ''
          : state === 'success'
            ? 'Connection successful'
            : state === 'timeout'
              ? 'Connection timed out'
              : state === 'failed'
                ? 'Connection failed. Check the sign-in fields.'
                : 'Not checked',
      );
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      info.append(status);

      const actions = node('div', 'button-row');
      const actionGroups = node('div', 'account-actions');
      const edit = button('Edit', (event) => editAccount(accountIndex, event.currentTarget));

      edit.id = 'edit-account-' + accountIndex;
      actions.append(edit);
      if ([ACCOUNT_TYPE.GOOGLE, ACCOUNT_TYPE.NEST, ACCOUNT_TYPE.GOOGLE_HOME].includes(account.type) === true) {
        actions.append(
          button('Reconnect', async () => {
            if (connectionBusy === true) {
              message('Wait for the connection check to finish, then reconnect.');

              return;
            }

            await guideControls.open(account.type, accountIndex);
          }),
        );
      }

      const removal = node('div', 'account-removal');

      // Match the manual editor with a separate panel below the account card.
      // Confirmation only stages removal; Save commits the configuration.
      const confirmation = node('section', 'editor-panel account-removal-panel');
      confirmation.hidden = true;
      const question = node('p');
      question.append(
        node('span', undefined, 'Remove '),
        node('strong', undefined, '“' + (account.name ?? 'Unnamed account') + '”'),
        node('span', undefined, ' from this configuration?'),
      );
      question.id = 'remove-account-question-' + accountIndex;
      confirmation.setAttribute('aria-labelledby', question.id);
      const remove = button('Remove', () => {
        confirmation.hidden = false;
        confirmation.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        cancel.focus({ preventScroll: true });
      });
      const cancel = button('Cancel', () => {
        confirmation.hidden = true;
        remove.focus({ preventScroll: true });
      });
      const choices = node('div', 'button-row');
      choices.append(
        cancel,
        button(
          'Remove account',
          () => {
            block().accounts.splice(accountIndex, 1);
            connectionStates.clear();
            changed();
            renderAll();
          },
          true,
        ),
      );
      confirmation.append(question, choices);
      removal.append(remove);
      actionGroups.append(actions);
      if ([ACCOUNT_TYPE.GOOGLE, ACCOUNT_TYPE.NEST, ACCOUNT_TYPE.GOOGLE_HOME].includes(account.type) === true) {
        const connection = node('div', 'account-connection');
        const check = button(state === 'pending' ? 'Checking…' : 'Check connection', () => checkConnection(accountIndex));
        check.disabled = connectionBusy;
        connection.append(check);
        actionGroups.append(connection);
      }

      actionGroups.append(removal);
      row.append(info, actionGroups);
      const entry = node('div', 'account-entry');
      entry.append(row, confirmation);
      (account.type !== ACCOUNT_TYPE.GOOGLE_HOME ? legacyList : list).append(entry);
    }

    if (hasGoogleHome !== true) {
      list.append(node('p', 'account-empty section-description', 'No Google Home accounts configured.'));
    }
    if (legacyList.children.length === 0) {
      legacyList.append(node('p', 'account-empty section-description', 'No Nest accounts configured.'));
      legacy.querySelector('.account-guidance').hidden = true;
    }
    list.append(legacy);
  }

  function renderAll() {
    // Rebuild from the same local draft without reloading or saving the settings page.
    renderAccounts();
    renderOptions();
    renderHomes();
    renderDevices();
  }

  get('add-home').addEventListener('click', () => {
    block().homes ??= [];
    block().homes.push({ name: '' });
    changed();
    renderHomes();
  });

  get('add-device').addEventListener('click', () => {
    block().devices ??= [];
    block().devices.push({ serialNumber: '' });
    changed();
    renderDevices();
  });

  get('cancel-settings').addEventListener('click', () => {
    // Closing settings never persists the draft; an in-flight check has its own deadline.
    homebridge.closeSettings();
  });

  get('save-settings').addEventListener('click', async () => {
    if (saving === true || settingsSnapshot() === savedSnapshot) {
      return;
    }

    // Finish validation before disabling edits, then flush every staged change
    // before asking Homebridge to persist. A failed save leaves the draft open.
    if (get('manual-account-editor').hidden !== true) {
      message('Apply or cancel the account edit before saving.', true);

      return;
    }

    if (
      (block().homes ?? []).some((home) => typeof home.name !== 'string' || home.name.trim() === '') ||
      (block().devices ?? []).some((device) => typeof device.serialNumber !== 'string' || device.serialNumber.trim() === '')
    ) {
      message('Complete the home names and device serial numbers before saving.', true);

      return;
    }

    for (const input of get('settings-form').querySelectorAll('input,select')) {
      if (input.reportValidity() !== true) {
        return;
      }
    }

    saving = true;
    updateSaveState();
    get('settings-fields').disabled = true;
    try {
      await queueDraft();
      if (writeFailed === true) {
        return;
      }

      // Homebridge's native Save also opens the appropriate restart/child-bridge
      // dialog. The SDK save method only persists, so hand off after validation.
      let nativeSave;
      try {
        nativeSave = document.defaultView?.frameElement?.closest('.modal-content')?.querySelector('.modal-footer button.btn-primary');
      } catch {
        // Cross-origin hosts cannot expose their button; retain the SDK fallback.
      }
      if (nativeSave !== undefined && nativeSave !== null) {
        if (nativeSave.disabled !== true) {
          nativeSave.click();
        }
        return;
      }

      await homebridge.savePluginConfig();
      savedSnapshot = settingsSnapshot();
      homebridge.toast?.info?.('Settings saved. Restart Homebridge to apply changes.');
      homebridge.closeSettings();
    } catch {
      message('Unable to save settings. Your draft is retained; retry saving.', true);
    } finally {
      get('settings-fields').disabled = false;
      saving = false;
      updateSaveState();
    }
  });

  const guide = {
    // Give the connection wizard this UI's draft, rather than a separate host
    // snapshot. Retain only the successful check status after staging credentials.
    getPluginConfig: async () => structuredClone(configs),
    updatePluginConfig: async (next) => {
      // Roll back the local reference if Homebridge rejects staging, leaving the
      // wizard open with its review rather than claiming the account was applied.
      const previous = configs;

      configs = next;
      if ((await queueDraft()) !== true) {
        configs = previous;
        updateSaveState();
        throw new Error('Unable to stage account');
      }

      if (pendingConnection !== undefined) {
        const accountIndex = accounts().findIndex((account) => fingerprint(account) === pendingConnection);
        if (accountIndex >= 0) {
          connectionStates.set(accountIndex, { fingerprint: pendingConnection, state: 'success' });
        }
      }
    },
    request: async (route, payload) => {
      const result = await homebridge.request(route, payload);
      if (route === '/accounts/test') {
        pendingConnection = result.status === 'success' ? fingerprint(payload) : undefined;
      }

      return result;
    },
    hideSchemaForm: () => {
      get('settings-form').hidden = true;
    },
    showSchemaForm: () => {
      // Release the temporary connection check before showing the settings again;
      // accepted credentials already live in the account draft, not this UI cache.
      pendingConnection = undefined;
      get('settings-form').hidden = false;
      renderAll();
    },
  };

  homebridge.hideSchemaForm();

  // The surrounding footer is hidden by our scoped styles. Keep its native Save
  // action enabled for our validated handoff and Homebridge's restart prompt.
  homebridge.enableSaveButton?.();
  guideControls = await startSetup(guide, document);
  fitSettingsPopup(document);

  // Check each enabled account once when settings opens. No device subscriptions
  // or background polling are started by this UI.
  for (const [accountIndex, account] of accounts().entries()) {
    if ([ACCOUNT_TYPE.GOOGLE, ACCOUNT_TYPE.NEST, ACCOUNT_TYPE.GOOGLE_HOME].includes(account.type) === true && account.exclude !== true) {
      await checkConnection(accountIndex);
    }
  }
}

if (typeof window !== 'undefined' && window.homebridge !== undefined) {
  startSettings(window.homebridge, window.document).catch(() => {
    restoreSettingsWindow();
    window.document.getElementById('settings-status').textContent =
      'Unable to open custom settings. The standard settings form is available below.';
    window.homebridge.showSchemaForm();
    window.homebridge.enableSaveButton?.();
  });
}
