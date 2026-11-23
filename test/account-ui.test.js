// Fabricated credentials exercise draft preservation, review and cancellation without network access.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { ACCOUNT_TYPE } from '../src/consts.js';
import { ACCOUNT_TYPE as UI_ACCOUNT_TYPE } from '../homebridge-ui/public/constants.js';
import { stageAccount } from '../homebridge-ui/public/config.js';
import { startSetup } from '../homebridge-ui/public/main.js';

const credentials = { issueToken: 'https://accounts.google.com/token', cookie: 'SIDCC=fabricated-cookie' };
const account = { name: 'Existing', type: 'google', ...credentials, exclude: true, custom: { preserve: true } };
const configs = [
  { platform: 'NestAccfactory', accounts: [account], homes: [{ name: 'Home' }], devices: [{ serialNumber: 'SERIAL' }], unknown: 1 },
];

for (let type of ['google', 'nest']) {
  test('reviewed ' + type + ' account preserves unknown configuration and rejects stale reconnects', () => {
    let fields = type === 'google' ? credentials : { access_token: 'fabricated-nest-token' };
    let before = structuredClone(configs);
    let result = stageAccount(configs, { name: ' Added ', type, credentials: fields });
    assert.deepEqual(configs, before);
    assert.deepEqual(result[0].accounts[1], { name: 'Added', type, ...fields });
    assert.deepEqual(result[0].homes, configs[0].homes);
    assert.deepEqual(result[0].devices, configs[0].devices);
    assert.equal(result[0].unknown, 1);
    assert.throws(() => stageAccount(configs, { name: 'Stale', type, credentials: fields, target: { index: 0, expected: '{}' } }));
  });
}

test('account staging validates credential type and Google destination', () => {
  for (let fields of [
    undefined,
    {},
    { ...credentials, issueToken: 'https://untrusted.invalid/token' },
    { ...credentials, issueToken: 'https://user:password@accounts.google.com/token' },
  ]) {
    assert.throws(() => stageAccount(configs, { name: 'Name', type: 'google', credentials: fields }));
  }
  assert.throws(() => stageAccount(configs, { name: 'Name', type: 'googlehome', credentials: {} }));
  let updated = stageAccount(configs, {
    name: 'Renamed',
    type: 'google',
    credentials,
    target: { index: 0, expected: JSON.stringify(account) },
  });
  assert.deepEqual(updated[0].accounts[0], { ...account, name: 'Renamed' });
});

class Element {
  value = '';
  textContent = '';
  children = [];
  handlers = new Map();
  addEventListener(type, handler) {
    this.handlers.set(type, handler);
  }

  dispatchEvent(event) {
    return this.handlers.get(event.type)?.();
  }

  emit(type = 'click') {
    return this.handlers.get(type)?.();
  }

  append(child) {
    this.children.push(child);
  }

  replaceChildren() {
    this.children = [];
  }
}
async function ui(request) {
  let elements = new Map();
  let document = {
    getElementById: (id) => {
      if (elements.has(id) !== true) {
        elements.set(id, new Element());
      }
      return elements.get(id);
    },
    createElement: () => new Element(),
  };
  let updates = [];
  let calls = [];
  let homebridge = {
    getPluginConfig: async () => structuredClone(configs),
    updatePluginConfig: async (next) => updates.push(next),
    showSchemaForm() {},
    hideSchemaForm() {},
    request: async (route, payload) => {
      calls.push({ route, payload });
      return request?.(route, payload) ?? { status: 'success' };
    },
  };
  await startSetup(homebridge, document);
  await document.getElementById('open-connection').emit();
  return { get: document.getElementById, updates, calls };
}
for (let type of ['google', 'nest']) {
  test('guided ' + type + ' connection clears input and stages only the reviewed account', async () => {
    let flow = await ui();
    flow.get('account-type').value = type;
    flow.get('account-type').emit('change');
    assert.equal(flow.get('google-fields').hidden, type !== 'google');
    flow.get('account-name').value = 'My account';
    flow.get('issue-token').value = credentials.issueToken;
    flow.get('account-cookie').value = credentials.cookie;
    flow.get('access-token').value = 'fabricated-nest-token';
    await flow.get('connect').emit();
    assert.equal(flow.calls[0].route, '/accounts/test');
    assert.equal(flow.calls[0].payload.type, type);
    assert.equal(flow.get('account-cookie').value, '');
    assert.equal(flow.get('access-token').value, '');
    assert.equal(flow.updates.length, 0);
    assert.equal(flow.get('connection-status').textContent, 'Connection successful');
    assert.equal(flow.get('connection-status').className, 'text-success');
    await flow.get('use-account').emit();
    assert.equal(flow.updates.length, 1);
    assert.equal(flow.updates[0][0].accounts[1].type, type);
  });
}

test('guided cancellation ignores late success without staging credentials', async () => {
  let pending = Promise.withResolvers();
  let flow = await ui((route) => (route === '/accounts/test' ? pending.promise : {}));
  flow.get('issue-token').value = credentials.issueToken;
  flow.get('account-cookie').value = credentials.cookie;
  let connecting = flow.get('connect').emit();
  await flow.get('cancel-connection').emit();
  pending.resolve({ status: 'success' });
  await connecting;
  await flow.get('use-account').emit();
  assert.equal(flow.updates.length, 0);
  assert.equal(flow.calls.length, 1);
});

// The settings host uses the real schema and the same wizard; these elements
// exercise its draft/discovery wiring without requiring a browser or live login.
class SettingsElement extends Element {
  append(...children) {
    this.children.push(...children);
  }

  setAttribute(key, value) {
    this[key] = value;
  }

  scrollIntoView() {}
  focus() {}
  reportValidity() {
    return true;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    const matches = (item) =>
      selector.split(',').includes(item.tag) === true ||
      (selector.startsWith('.') === true && item.className?.split(' ').includes(selector.slice(1)) === true);
    return this.children.flatMap((child) => [...(matches(child) === true ? [child] : []), ...child.querySelectorAll(selector)]);
  }
}
test('settings host checks both account types and edits Nest credentials using the release schema', async () => {
  const { readFile } = await import('node:fs/promises');
  const { startSettings } = await import('../homebridge-ui/public/app.js');
  const schema = JSON.parse(await readFile(new URL('../config.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.customUi, true, 'Homebridge must be instructed to load the custom settings UI');
  const markup = await readFile(new URL('../homebridge-ui/public/index.html', import.meta.url), 'utf8');
  const markupIds = new Set([...markup.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  let elements = new Map();
  let document = {
    getElementById: (id) => {
      if (elements.has(id) !== true) {
        const dynamic = [...elements.values()]
          .flatMap((root) => root.querySelectorAll('button,input,select'))
          .find((item) => item.id === id);
        if (dynamic !== undefined) {
          return dynamic;
        }
        assert.equal(markupIds.has(id), true, 'Missing settings element: ' + id);
        let item = new SettingsElement();
        item.id = id;
        elements.set(id, item);
      }
      return elements.get(id);
    },
    createElement: (tag) => {
      let item = new SettingsElement();
      item.tag = tag;
      return item;
    },
    defaultView: { requestAnimationFrame: (callback) => callback() },
  };
  const get = document.getElementById;
  get('manual-account-editor').hidden = true;
  let requests = [];
  let saves = 0;
  let failSave = false;
  let closes = 0;
  let checkedStatus = 'success';
  let deferredCheck;
  let current = [
    {
      platform: 'NestAccfactory',
      accounts: [
        { ...account, exclude: false },
        { name: 'Nest', type: 'nest', access_token: 'fabricated-nest-token' },
        { name: 'Excluded', type: 'nest', access_token: 'fabricated-excluded-token', exclude: true },
      ],
      homes: [],
      devices: [],
    },
  ];
  let bridge = {
    savePluginConfig: async () => {
      saves += 1;
      if (failSave === true) {
        throw new Error('fabricated save failure');
      }
    },
    closeSettings: () => {
      closes += 1;
    },
    getPluginConfig: async () => structuredClone(current),
    getPluginConfigSchema: async () => schema,
    updatePluginConfig: async (next) => {
      current = next;
    },
    showSchemaForm() {},
    hideSchemaForm() {},
    request: async (route, payload) => {
      requests.push({ route, payload });
      return deferredCheck ?? { status: checkedStatus };
    },
  };
  await startSettings(bridge, document);
  assert.equal(get('save-settings').disabled, true);
  await get('save-settings').handlers.get('click')();
  assert.equal(saves, 0);
  assert.deepEqual(
    requests.map((request) => request.payload.type),
    ['google', 'nest'],
  );
  assert.equal(
    requests.every((request) => request.route === '/accounts/test'),
    true,
  );
  assert.equal(get('accounts-list').children.length, 3);
  assert.deepEqual(
    get('accounts-list').children.map((card) => card.querySelector('input').checked),
    [true, true, false],
  );
  assert.equal(get('accounts-list').children[2].querySelector('input').role, 'switch');

  assert.equal(get('accounts-list').children[2].querySelector('.account-status').textContent, 'Not checked');
  for (let card of get('accounts-list').children.slice(0, 2)) {
    const status = card.querySelector('.account-status');
    assert.equal(status.textContent, 'Connection successful');
    assert.equal(status.className.includes('text-success'), true);
    assert.equal(
      card.querySelectorAll('button').some((button) => button.textContent === 'Discover devices'),
      false,
    );
  }
  // Exclusion skips the automatic login, but an explicit check still shows its
  // result and must never enable the account or persist the check status.
  for (let result of ['failed', 'timeout', 'success']) {
    checkedStatus = result;
    const check = get('accounts-list')
      .children[2].querySelectorAll('button')
      .find((button) => button.textContent === 'Check connection');
    await check.handlers.get('click')();
    const status = get('accounts-list').children[2].querySelector('.account-status');
    assert.equal(status.className.includes(result === 'success' ? 'text-success' : 'text-danger'), true);
    assert.equal(current[0].accounts[2].exclude, true);
  }
  assert.equal(get('save-settings').disabled, true, 'Connection checks do not change configuration');
  // Card toggles stage only exclude, preserving credentials and checked status.
  const beforeToggle = structuredClone(current[0].accounts[2]);
  const requestCount = requests.length;
  let enabled = get('accounts-list').children[2].querySelector('input');
  enabled.checked = true;
  await enabled.handlers.get('change')();
  await setImmediate();
  assert.deepEqual(current[0].accounts[2], { ...beforeToggle, exclude: false });
  assert.equal(get('save-settings').disabled, false);
  assert.equal(get('accounts-list').children[2].className.includes('account-excluded'), false);
  assert.equal(get('accounts-list').children[2].querySelector('.account-status').textContent, 'Connection successful');
  enabled = get('accounts-list').children[2].querySelector('input');
  enabled.checked = false;
  await enabled.handlers.get('change')();
  await setImmediate();
  assert.deepEqual(current[0].accounts[2], beforeToggle);
  assert.equal(get('save-settings').disabled, true, 'Reverting the toggle restores the saved draft');
  // Accounts without an explicit exclude:false also return to the same enabled state.
  let defaultEnabled = get('accounts-list').children[1].querySelector('input');
  defaultEnabled.checked = false;
  await defaultEnabled.handlers.get('change')();
  await setImmediate();
  assert.equal(get('save-settings').disabled, false);
  defaultEnabled = get('accounts-list').children[1].querySelector('input');
  defaultEnabled.checked = true;
  await defaultEnabled.handlers.get('change')();
  await setImmediate();
  assert.equal(get('save-settings').disabled, true);
  assert.equal(get('accounts-list').children[2].className.includes('account-excluded'), true);
  assert.equal(requests.length, requestCount);
  assert.equal(saves, 0);
  assert.equal(
    get('accounts-list')
      .children[2].querySelectorAll('button')
      .filter((button) => button.disabled === true).length,
    0,
  );

  for (let status of ['failed', 'timeout']) {
    checkedStatus = status;
    const check = get('accounts-list')
      .children[1].querySelectorAll('button')
      .find((button) => button.textContent === 'Check connection');
    await check.handlers.get('click')();
    const text = get('accounts-list').children[1].querySelector('.account-status');
    assert.equal(text.className.includes('text-danger'), true);
    assert.equal(text.className.includes('text-success'), false);
  }
  const pending = Promise.withResolvers();
  deferredCheck = pending.promise;
  const check = get('accounts-list')
    .children[1].querySelectorAll('button')
    .find((button) => button.textContent === 'Check connection');
  const checking = check.handlers.get('click')();
  let nestCard = get('accounts-list').children[1];
  assert.equal(nestCard.querySelector('.account-status').textContent, '', 'Pending checks retain an empty status row');
  assert.equal(get('save-settings').disabled, true);
  let edit = nestCard.querySelectorAll('button').find((button) => button.textContent === 'Edit');
  await edit.handlers.get('click')({ currentTarget: edit });
  let labels = get('manual-account-editor')
    .querySelectorAll('label')
    .map((label) => label.textContent);
  assert.equal(labels.includes('Access Token'), true);
  assert.equal(labels.includes('Master Token'), false);
  assert.equal(labels.includes('Exclude account'), false);
  assert.equal(current[0].accounts[1].access_token, 'fabricated-nest-token');
  // A card change made while editing cannot be undone by Apply account.
  enabled = get('accounts-list').children[1].querySelector('input');
  enabled.checked = false;
  await enabled.handlers.get('change')();
  await setImmediate();
  const editor = get('manual-account-editor');
  const label = editor.querySelectorAll('label').find((entry) => entry.textContent === 'Access Token');
  const input = editor.querySelectorAll('input').find((entry) => entry.id === label.htmlFor);
  input.value = 'replacement-nest-token';
  await input.handlers.get('change')();
  await editor
    .querySelectorAll('button')
    .find((button) => button.textContent === 'Apply account')
    .handlers.get('click')();
  pending.resolve({ status: 'success' });
  await checking;
  const status = get('accounts-list').children[1].querySelector('.account-status');
  assert.equal(status.textContent, 'Not checked');
  assert.equal(status.className.includes('text-success'), false);
  assert.equal(current[0].accounts[1].access_token, 'replacement-nest-token');
  assert.equal(current[0].accounts[1].exclude, true);
  assert.equal(saves, 0);
  assert.equal(get('save-settings').disabled, false);
  failSave = true;
  await get('save-settings').handlers.get('click')();
  assert.equal(saves, 1);
  assert.equal(closes, 0);
  assert.equal(get('save-settings').disabled, false, 'Failed saves remain retryable');
  failSave = false;
  await get('save-settings').handlers.get('click')();
  assert.equal(saves, 2);
  assert.equal(closes, 1);
  assert.equal(get('save-settings').disabled, true);
});

for (let status of ['failed', 'timeout', 'unexpected']) {
  test('guided connection never stages failed or unknown check status: ' + status, async () => {
    const flow = await ui(async () => ({ status }));
    flow.get('issue-token').value = credentials.issueToken;
    flow.get('account-cookie').value = credentials.cookie;
    await flow.get('connect').emit();
    assert.equal(flow.get('connection-status').className, 'text-danger');
    await flow.get('use-account').emit();
    assert.equal(flow.updates.length, 0);
  });
}

test('browser account type constants match runtime values and keep Google Home login disabled', () => {
  assert.deepEqual(UI_ACCOUNT_TYPE, ACCOUNT_TYPE);
  assert.throws(
    () => stageAccount(configs, { name: 'Future', type: UI_ACCOUNT_TYPE.GOOGLE_HOME, credentials }),
    /Invalid account connection/,
  );
});
