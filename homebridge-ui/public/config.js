// Google/Nest account draft updates
// Part of homebridge-nest-accfactory
//
// Applies a reviewed connection to a copy of the existing plugin configuration.
//
// Entry points:
// - stageAccount() adds an account or updates a verified reconnect target
//
// Responsibilities:
// - Validate the account name and account credentials
// - Reject reconnects when the selected account has changed since setup began
// - Preserve other accounts, overrides, options and unknown configuration fields
//
// Ownership:
// - This module performs no network requests, file writes or input mutation
// - The settings host decides when to stage and persist the returned draft
//
// Code version 2026.11.28
// Mark Hulskamp

// Define constants
import { ACCOUNT_TYPE } from './constants.js';

// Accept only persistent SSO fields; names, routing and advanced options
// remain owned by the account setup form.
/**
 * Validate and select persistent Google SSO credentials.
 * @param {unknown} value Manually entered credential record.
 * @returns {{refreshToken: string, deviceId?: string}} Trimmed SSO fields only.
 */
export function googleHomeCredentials(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) === true ||
    (value.type !== undefined && value.type !== ACCOUNT_TYPE.GOOGLE_HOME) ||
    typeof value.refreshToken !== 'string' ||
    /^[^\s]{1,8192}$/u.test(value.refreshToken.trim()) !== true ||
    (value.deviceId !== undefined &&
      (typeof value.deviceId !== 'string' ||
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value.deviceId.trim()) !== true))
  ) {
    throw new Error('Invalid Google Home sign-in result');
  }
  return { refreshToken: value.refreshToken.trim(), ...(value.deviceId !== undefined ? { deviceId: value.deviceId.trim() } : {}) };
}

export function stageAccount(configs, { name, type, credentials, target, fieldTest } = {}) {
  const usingSso = type === ACCOUNT_TYPE.GOOGLE_HOME;
  if (usingSso === true) {
    credentials = googleHomeCredentials(credentials);
  }
  const fields =
    usingSso === true
      ? ['refreshToken', ...(credentials.deviceId !== undefined ? ['deviceId'] : [])]
      : type === ACCOUNT_TYPE.GOOGLE
        ? ['issueToken', 'cookie']
        : type === ACCOUNT_TYPE.NEST
          ? ['access_token']
          : undefined;
  if (
    Array.isArray(configs) !== true ||
    typeof name !== 'string' ||
    name.trim() === '' ||
    fields === undefined ||
    fields.some((key) => typeof credentials?.[key] !== 'string' || credentials[key].trim() === '') ||
    (fieldTest !== undefined && typeof fieldTest !== 'boolean')
  ) {
    throw new Error('Invalid account connection');
  }
  if (type === ACCOUNT_TYPE.GOOGLE && usingSso !== true) {
    const url = URL.parse(credentials.issueToken);
    if (url?.origin !== 'https://accounts.google.com' || url.username !== '' || url.password !== '') {
      throw new Error('Invalid Google sign-in URL');
    }
  }

  let result = structuredClone(configs);

  // Copy the full document rather than rebuilding schema-known fields: advanced
  // options and unrelated plugin blocks must survive account setup unchanged.
  let blockIndex = result.findIndex((block) => block.platform === 'NestAccfactory');

  if (blockIndex < 0) {
    // An absent plugin block is valid for first setup, but never for reconnect:
    // the account selected earlier would no longer exist in the latest draft.
    if (target !== undefined) {
      throw new Error('Account configuration changed');
    }

    blockIndex = result.length;
    result.push({ platform: 'NestAccfactory', name: 'NestAccfactory' });
  }

  let block = result[blockIndex];

  if (block.accounts !== undefined && Array.isArray(block.accounts) !== true) {
    throw new Error('Invalid account configuration');
  }

  let accounts = block.accounts ?? [];
  let index = accounts.length;

  if (target !== undefined) {
    // Compare the complete selected account before updating it, preserving edits
    // made while authentication was in flight instead of overwriting them.
    index = target.index;
    if (Number.isInteger(index) !== true || accounts[index]?.type !== type || JSON.stringify(accounts[index]) !== target.expected) {
      throw new Error('Account configuration changed');
    }
  }

  let account = {
    // Replace only reviewed fields; advanced options and exclusion stay as saved.
    ...accounts[index],
    name: name.trim(),
    type,
    ...Object.fromEntries(fields.map((key) => [key, credentials[key].trim()])),
  };
  if (usingSso === true && credentials.deviceId === undefined) {
    // A new refresh credential without its device ID must not inherit the old
    // account's enrollment context. Runtime will generate an account-local ID.
    delete account.deviceId;
  }

  if (type === ACCOUNT_TYPE.GOOGLE) {
    for (const key of ['refreshToken', 'deviceId']) {
      delete account[key];
    }
  }

  // Preserve the existing optional field. An explicit environment change during
  // reconnect updates it; a new production account needs no stored default.
  if (typeof fieldTest === 'boolean' && (fieldTest === true || Object.hasOwn(account, 'fieldTest') === true)) {
    account.fieldTest = fieldTest;
  }

  accounts[index] = account;
  block.accounts = accounts;

  return result;
}
