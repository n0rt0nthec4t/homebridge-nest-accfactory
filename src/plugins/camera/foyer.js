// Google Home Foyer
// Part of homebridge-nest-accfactory
//
// Resolves Google Foyer and legacy Quartz device IDs from HomeGraph for
// WebRTC and NexusTalk camera transports.
//
// Responsibilities:
// - Create or reuse the camera transport's account-authenticated Foyer client
// - Apply shared endpoint, timeout and response-buffer settings
// - Request HomeGraph and return the client with its pending ID lookup
// - Match the source device ID and resolve aliases from that same device
// - Return googleDeviceId and legacyDeviceId without the quartz. prefix
//
// Notes:
// - Missing aliases remain undefined; unmatched devices return an empty object
// - Request failures propagate to the caller for logging and retry handling
// - Callers own constructor prefetch, lazy retries and client cleanup
// - No credentials or global lookup cache are stored by this module
//
// Code version 2026.11.23
'use strict';

// Define nodejs module requirements
import crypto from 'node:crypto';
import path from 'node:path';

// Define our modules
import GrpcTransport from '../../grpctransport.js';

// Define constants
import { GOOGLE_HOME_FOYER_PREFIX, GOOGLE_HOME_FOYER_ENDPOINTS, USER_AGENT, __dirname } from '../../consts.js';

// Callers supply log, uuid, fieldTest and getAuthHeader; an existing client is reused.
// The returned transport remains caller-owned, alongside its pending lookup promise.
function setupGoogleHomeFoyer(options, transport = undefined) {
  if (transport === undefined) {
    transport = new GrpcTransport({
      log: options.log,
      protoPath: path.join(__dirname, 'protobuf/googlehome/foyer.proto'),
      endpointHost: options.fieldTest === true ? GOOGLE_HOME_FOYER_ENDPOINTS.FIELD_TEST : GOOGLE_HOME_FOYER_ENDPOINTS.PRODUCTION,
      uuid: options.uuid,
      userAgent: USER_AGENT,
      requestTimeout: 15000,
      bufferInitial: 8 * 1024,
      bufferMax: 10 * 1024 * 1024,
      getAuthHeader: options.getAuthHeader,
    });
  }
  return { transport, promise: resolveCameraIds(transport, options.uuid) };
}

// Resolve the available Foyer and legacy IDs through the caller-owned transport.
async function resolveCameraIds(transport, resourceId) {
  let response = await transport.command(
    GOOGLE_HOME_FOYER_PREFIX,
    'StructuresService',
    'GetHomeGraph',
    { requestId: crypto.randomUUID() },
    { retry: 2 },
  );
  for (let home of Object.values(response?.data?.[0]?.homes ?? {})) {
    for (let device of Object.values(home?.devices ?? {})) {
      let aliases = Object.values(device?.otherIds?.otherThirdPartyId ?? {});
      // Resolve aliases on the same device; never borrow another camera's ID.
      if (aliases.some((alias) => alias?.id === resourceId) === false) {
        continue;
      }
      let camera = aliases.find(
        (alias) =>
          alias?.idType === 'CAMERA' &&
          typeof alias.id === 'string' &&
          alias.id.startsWith('quartz.') === true &&
          alias.id.length > 'quartz.'.length,
      );
      return {
        googleDeviceId: device?.id?.googleUuid,
        legacyDeviceId: camera?.id.slice('quartz.'.length),
      };
    }
  }
  return {};
}

export { setupGoogleHomeFoyer, resolveCameraIds };
