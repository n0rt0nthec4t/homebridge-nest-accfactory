// Protobuf
// Part of homebridge-nest-accfactory
//
// Shared protobuf loading and type lookup helpers.
//
// Responsibilities:
// - Load protobuf schema roots once per proto file
// - Cache protobuf type lookups for reuse across modules
// - Configure protobufjs consistently for this plugin
// - Avoid repeated protobuf schema parsing in transport and streamer modules
//
// Features:
// - Shared root cache keyed by resolved proto file path
// - Shared type cache keyed by proto file path and type name
// - Safe missing-file handling
// - Optional logging for load and lookup failures
//
// Notes:
// - This module does not know about Nest, Google, Foyer, WebRTC, or NexusTalk specifics
// - Callers decide which protobuf file and type names they need
// - protobufjs Long support is disabled to preserve existing plain number/object behaviour
//
// Code version 2026.05.07
// Mark Hulskamp
'use strict';

// Define external module requirements
import protobuf from 'protobufjs';

// Define nodejs module requirements
import fs from 'node:fs';
import path from 'node:path';

// Cached protobuf roots and types
const roots = new Map();
const types = new Map();

// Load and cache a protobuf root for the supplied proto file
export function getProtoRoot(protoPath, log = undefined) {
  if (typeof protoPath !== 'string' || protoPath.trim() === '') {
    return;
  }

  let resolvedPath = path.resolve(protoPath);

  if (roots.has(resolvedPath) === true) {
    return roots.get(resolvedPath);
  }

  if (fs.existsSync(resolvedPath) !== true) {
    log?.warn?.('Protobuf file not found: %s', resolvedPath);
    return;
  }

  try {
    // Keep protobufjs behaviour consistent with the rest of the plugin.
    // This avoids Long objects being returned for integer fields.
    protobuf.util.Long = null;
    protobuf.configure();

    let root = protobuf.loadSync(resolvedPath);

    roots.set(resolvedPath, root);

    return root;
  } catch (error) {
    log?.warn?.(
      'Failed to load protobuf file "%s". Error was "%s"',
      resolvedPath,
      typeof error?.message === 'string' ? error.message : String(error),
    );
  }
}

// Lookup and cache a protobuf type from the supplied proto file
export function getProtoType(protoPath, typeName, log = undefined) {
  if (typeof protoPath !== 'string' || protoPath.trim() === '' || typeof typeName !== 'string' || typeName.trim() === '') {
    return;
  }

  let resolvedPath = path.resolve(protoPath);
  let key = resolvedPath + ':' + typeName;

  if (types.has(key) === true) {
    return types.get(key);
  }

  try {
    let type = getProtoRoot(resolvedPath, log)?.lookup?.(typeName);

    if (type === undefined || type === null) {
      log?.warn?.('Protobuf type "%s" was not found in "%s"', typeName, resolvedPath);
      return;
    }

    types.set(key, type);

    return type;
  } catch (error) {
    log?.warn?.(
      'Failed to lookup protobuf type "%s" in "%s". Error was "%s"',
      typeName,
      resolvedPath,
      typeof error?.message === 'string' ? error.message : String(error),
    );
  }
}

// Lookup and cache all protobuf types from the supplied proto file
export function getProtoTypes(protoPath, log = undefined) {
  if (typeof protoPath !== 'string' || protoPath.trim() === '') {
    return [];
  }

  let resolvedPath = path.resolve(protoPath);
  let key = resolvedPath + ':*';

  // Return cached protobuf type list if already processed
  if (types.has(key) === true) {
    return types.get(key);
  }

  let protoTypes = [];

  // Recursively walk protobuf nested objects collecting protobuf.Type instances.
  // protobufjs stores message types inside nestedArray trees rather than a flat structure.
  const traverseTypes = (item) => {
    if (item instanceof protobuf.Type) {
      protoTypes.push(item);
    }

    // Walk any nested protobuf namespaces/types/messages recursively
    for (let nested of item?.nestedArray ?? []) {
      traverseTypes(nested);
    }
  };

  try {
    // Load shared protobuf root from cache or disk
    let root = getProtoRoot(resolvedPath, log);

    if (root === undefined || root === null) {
      return [];
    }

    // Traverse full protobuf tree collecting all protobuf message types
    traverseTypes(root);

    // Cache collected type list for future lookups
    types.set(key, protoTypes);

    return protoTypes;
  } catch (error) {
    log?.warn?.(
      'Failed to lookup protobuf types in "%s". Error was "%s"',
      resolvedPath,
      typeof error?.message === 'string' ? error.message : String(error),
    );
  }

  return [];
}

// Clear cached protobuf roots and types.
// Mostly useful for tests or controlled plugin reload paths.
export function clearProtoCache() {
  roots.clear();
  types.clear();
}
