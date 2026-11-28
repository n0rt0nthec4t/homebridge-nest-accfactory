// Google Home Foyer
// Part of homebridge-nest-accfactory
//
// Resolves Google Foyer and legacy Quartz device IDs from HomeGraph for
// WebRTC and NexusTalk camera transports.
//
// Responsibilities:
// - Create or reuse the camera transport's account-authenticated Foyer client
// - Apply shared endpoint, browser headers, timeout and response-buffer settings
// - Request HomeGraph and return the client with its pending ID lookup
// - Match the source device ID and resolve aliases from that same device
// - Return Google UUID, PHX streaming ID and legacy ID without the quartz. prefix
//
// Notes:
// - Missing aliases remain undefined; unmatched devices return an empty object
// - Request failures propagate to the caller for logging and retry handling
// - Callers own constructor prefetch, lazy retries and client cleanup
// - No credentials or global lookup cache are stored by this module
//
// Code version 2026.11.28
'use strict';

// Define node.js modules
import crypto from 'node:crypto';
import { Buffer } from 'node:buffer';
import path from 'node:path';

// Define our modules
import GrpcTransport from '../../grpctransport.js';
import { getProtoType } from '../../protobuf.js';

// Define constants
import {
  GOOGLE_HOME_FOYER_PREFIX,
  GOOGLE_HOME_CLIENT_ENVIRONMENT,
  GOOGLE_HOME_FOYER_ENDPOINTS,
  GOOGLE_HOME_REFERER,
  GOOGLE_HOME_USER_AGENT,
  __dirname,
} from '../../consts.js';

// Callers supply log, uuid, fieldTest and getAuthHeader; an existing client is reused.
// The returned transport remains caller-owned, alongside its pending lookup promise.
function setupGoogleHomeFoyer(options, transport = undefined) {
  if (transport === undefined) {
    let protoPath = path.join(__dirname, 'protobuf/googlehome/foyer.proto');
    let environmentType = getProtoType(protoPath, GOOGLE_HOME_FOYER_PREFIX + 'ClientEnvironment');
    transport = new GrpcTransport({
      log: options.log,
      protoPath,
      foyerEnvironment: Buffer.from(environmentType.encode(GOOGLE_HOME_CLIENT_ENVIRONMENT).finish()).toString('base64'),
      endpointHost: options.fieldTest === true ? GOOGLE_HOME_FOYER_ENDPOINTS.FIELD_TEST : GOOGLE_HOME_FOYER_ENDPOINTS.PRODUCTION,
      uuid: options.uuid,
      userAgent: GOOGLE_HOME_USER_AGENT,
      referer: GOOGLE_HOME_REFERER,
      origin: GOOGLE_HOME_REFERER,
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
  if (typeof resourceId !== 'string' || resourceId.trim() === '') {
    return {};
  }

  let response = await transport.command(
    GOOGLE_HOME_FOYER_PREFIX,
    'StructuresService',
    'GetHomeGraph',
    { requestId: crypto.randomUUID() },
    { retry: 2 },
  );

  // Foyer can place cameras under a home, inside its rooms, or in the unassigned
  // list. Discovery and streaming must recognise the same topology.
  let graph = response?.data?.[0];
  let groups = Object.values(graph?.homes ?? {}).flatMap((home) => [
    home?.devices,
    ...Object.values(home?.rooms ?? {}).map((room) => room?.devices),
  ]);
  groups.push(graph?.unassignedDevices);
  for (let devices of groups) {
    for (let device of Object.values(devices ?? {})) {
      let aliases = [device?.id?.thirdPartyId, ...Object.values(device?.otherIds?.otherThirdPartyId ?? {})];

      // Resolve aliases on the same device; never borrow another camera's ID.
      if (device?.id?.googleUuid !== resourceId && aliases.some((alias) => alias?.id === resourceId) === false) {
        continue;
      }
      let camera = aliases.find(
        (alias) =>
          alias?.idType === 'CAMERA' &&
          typeof alias.id === 'string' &&
          alias.id.startsWith('quartz.') === true &&
          alias.id.length > 'quartz.'.length,
      );

      // JoinStream uses the PHX resource ID, also supplied as the primary third-party
      // ID on Google Home accounts. Wake-up and talkback use the Google UUID.
      let streaming = aliases.find(
        (alias) =>
          alias?.idType === 'PHX' && typeof alias.id === 'string' && alias.id.startsWith('DEVICE_') === true && alias.id.length > 7,
      );
      let primaryId = device?.id?.thirdPartyId?.id;
      let streamingDeviceId =
        streaming?.id ??
        (typeof primaryId === 'string' && primaryId.startsWith('DEVICE_') === true && primaryId.length > 7 ? primaryId : undefined);
      return {
        streamingDeviceId,
        googleDeviceId: device?.id?.googleUuid,
        legacyDeviceId: camera?.id.slice('quartz.'.length),
      };
    }
  }
  return {};
}

export { setupGoogleHomeFoyer, resolveCameraIds };
