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
// Code version 2026.11.23
// Mark Hulskamp

export function stageAccount(configs, { name, type, credentials, target, fieldTest } = {}) {
  const fields = type === 'google' ? ['issueToken', 'cookie'] : type === 'nest' ? ['access_token'] : undefined;
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
  if (type === 'google') {
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

  // Preserve the existing optional field. An explicit environment change during
  // reconnect updates it; a new production account needs no stored default.
  if (typeof fieldTest === 'boolean' && (fieldTest === true || Object.hasOwn(account, 'fieldTest') === true)) {
    account.fieldTest = fieldTest;
  }

  accounts[index] = account;
  block.accounts = accounts;

  return result;
}
