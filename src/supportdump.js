// Support Dump Writer
// Part of homebridge-nest-accfactory
//
// Prepares Nest and Google API data for support logging without exposing
// credentials, personal details, or the original device and home identifiers.
// Keeps the raw API cache available for normal device processing and commands.
//
// Responsibilities:
// - Select full resource data or changed fields for the requested connection
// - Apply the redaction dictionary to Nest and Google field names
// - Replace identifiers in object keys, values, and references with aliases
// - Format redacted data into separate Nest and Google support-dump blocks
// - Bound identifier storage, traversal, and diagnostic output
//
// Features:
// - Shared rules for snake_case, camelCase, and dotted property names
// - Stable aliases across full and delta dumps within one platform instance
// - Address and URL detection outside the named redaction fields
// - Firmware version preservation when values resemble IPv4 addresses
// - Safe omission of binary data and unsafe or oversized dump payloads
//
// Notes:
// - system.js creates the writer only when supportDump is enabled
// - An absent changed-field map requests a full dump; an empty map logs nothing
// - Redaction builds diagnostic copies and does not change live API values
// - Aliases remain private to the writer and are released on platform shutdown
// - Normal plugin logs and streaming debug messages are outside this module
//
// Code version 2026.10.16
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { isIP } from 'node:net';

// Define constants
import { DATA_SOURCE, NEST_API_BUCKETS } from './consts.js';

// Diagnostic limits apply to each emission, except the identifier map retained across calls.
// Stop collection before excessive depth or size can turn malformed API data into unbounded logging.
const REDACTED = '**REDACTED**';
const MAX_IDENTIFIERS = 4096;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_NODES = 8192;
const MAX_DEPTH = 32;
const MAX_STRING_LENGTH = 4096;
const MAX_OUTPUT_CHARACTERS = 65536;
// Retain retired REST prefixes for private references even though they are no longer requested.
// A prefixed resource and its bare serial must still share an alias.
const RESOURCE_PREFIX = new RegExp(
  '^(?:' +
    [...NEST_API_BUCKETS, 'device', 'shared', 'track', 'link', 'rcs_settings', 'kryptonite', 'schedule'].join('|') +
    ')\\.|^(?:DEVICE|STRUCTURE|SERVICE|USER|RESOURCE)_',
);

// Structure-mode enums share the resource prefix but describe state, not private identifiers.
const STRUCTURE_MODE_ENUMS = new Set([
  'STRUCTURE_MODE_UNSPECIFIED',
  'STRUCTURE_MODE_HOME',
  'STRUCTURE_MODE_AWAY',
  'STRUCTURE_MODE_SLEEP',
  'STRUCTURE_MODE_VACATION',
  'STRUCTURE_MODE_REASON_UNSPECIFIED',
  'STRUCTURE_MODE_REASON_EXPLICIT_INTENT',
  'STRUCTURE_MODE_REASON_IMPLICIT_INTENT',
  'STRUCTURE_MODE_REASON_ACTIVITY',
  'STRUCTURE_MODE_REASON_EXTENDED_INACTIVITY',
  'STRUCTURE_MODE_REASON_IDENTIFIED_PRESENCE',
  'STRUCTURE_MODE_REASON_IDENTIFIED_ABSENCE',
  'STRUCTURE_MODE_REASON_SCHEDULE',
  'STRUCTURE_MODE_ACTOR_METHOD_UNSPECIFIED',
  'STRUCTURE_MODE_ACTOR_METHOD_LEGACY_NEST_APP',
  'STRUCTURE_MODE_ACTOR_METHOD_GOOGLE_HOME_APP',
  'STRUCTURE_MODE_ACTOR_METHOD_GOOGLE_ASSISTANT',
]);

// Normalised dictionary keys match snake_case, camelCase, and dotted REST property names.
// Remove credentials and private details outright; aliases are reserved for diagnostic relationships.
const REDACTION = {
  remove: new Set([
    // Authentication credentials, pairing secrets, and lock access codes.
    'accesstoken',
    'authorization',
    'authentication',
    'cameraauth',
    'cookie',
    'cookies',
    'issuetoken',
    'jwt',
    'oauth2',
    'oauthaccesstoken',
    'refreshtoken',
    'token',
    'invitationtoken',
    'pairingtoken',
    'password',
    'secret',
    'pincode',
    'pin',
    'pinhash',
    'userpincode',
    'userpincodes',
    'usernfctoken',
    'usernfctokens',
    'topazhushkey',
    // Account and contact details.
    'email',
    'guestemail',
    'phonenumber',
    'phonenumbers',
    'emergencycontactdescription',
    'emergencycontactphone',
    'profileimageurl',
    'username',
    'user',
    // Home addresses, coordinates, geofencing, and location-derived details.
    'address',
    'addresslines',
    'streetaddress',
    'city',
    'country',
    'countrycode',
    'postalcode',
    'structurepostalcode',
    'zip',
    'latitude',
    'longitude',
    'location',
    'geocoordinate',
    'geofences',
    'sunrise',
    'sunset',
    'timezone',
    'timezonename',
    // Network addresses and names, including thread and WiFi identifiers.
    'ipaddress',
    'ipaddresses',
    'lastip',
    'localip',
    'localipv6',
    'hashedipv6address',
    'threadipaddress',
    'wifiipaddress',
    'macaddress',
    'threadmacaddress',
    'wifimacaddress',
    'bssid',
    'bssidhash',
    'extaddr',
    'extaddress',
    'ssid',
    'networkname',
    // Camera links can identify a device or provide access to media.
    'clipurl',
    'dashurl',
    'downloadurl',
    'hlsurl',
    'imageurl',
    'liveimageurl',
    'liveurl',
    'snapshoturl',
    'weburl',
    'nexusapihttpserverurl',
    'directhost',
    'directnexustalkhost',
    // User-chosen names, room labels, and opaque service configuration.
    'name',
    'description',
    'title',
    'label',
    'wherelabel',
    'fixturenamelabel',
    'roomname',
    'customwheres',
    'serviceconfig',
  ]),
  alias: new Set([
    // Device identity and upstream resource references.
    'serialnumber',
    'deviceserialnumber',
    'heatlinkserialnumber',
    'rtsserialnumber',
    'deviceid',
    'rtsdeviceid',
    'resourceid',
    'objectkey',
    'nestgoogledeviceuuid',
    'nestgooglehomeuuid',
    // Home identity and links between Nest and Google structures.
    'structure',
    'structureid',
    'structureids',
    'rtsstructureid',
    'hgsstructureid',
    // Account references retain relationships without showing their real IDs.
    'userid',
    'rtsuserid',
    'userresourceid',
    'uniqueid',
    'initiatinguserid',
    'previoususerid',
    'targetuserid',
    'toucheduserid',
    // Fabric, geofence, and location references used by related resources.
    'fabricid',
    'primaryfabricid',
    'auxprimaryfabricid',
    'ifjprimaryfabricid',
    'weavedeviceid',
    'fenceid',
    'geofenceid',
    'rtsfenceid',
    'whereid',
    'spokenwhereid',
  ]),
};

// Remove separators and case differences before matching the dictionary.
// Token/password suffixes also cover qualified property names such as camera.pairing_token.
function fieldRule(key) {
  let normalised = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return REDACTION.remove.has(normalised) === true ||
    normalised.endsWith('token') === true ||
    normalised.endsWith('tokens') === true ||
    normalised.endsWith('password') === true
    ? 'remove'
    : REDACTION.alias.has(normalised) === true
      ? 'alias'
      : undefined;
}

// Create one writer per platform so the same identifier keeps its alias between dump emissions.
// The returned function accepts the raw resource store, a connection ID, and an optional changed-field map.
// Each resource has source, connection, and value fields; each delta entry declares its changed fields in a Set.
function createSupportDump(log) {
  let identifiers = new Map(); // Original IDs and prefixed references mapped to their diagnostic replacements.
  let nextAlias = 0; // Assign new numbers without renumbering earlier aliases when another device appears.
  let pattern; // Literal identifier matches used inside longer keys and reference strings.
  let patternSize = 0; // Rebuild the matcher only when identifier discovery has extended the map.

  // Preserve resource prefixes and share the suffix alias with bare serials/IDs and related Nest buckets.
  const registerIdentifier = (value) => {
    if (typeof value !== 'string' || value === '') {
      return REDACTED;
    }
    // Keep retained strings and the alias map bounded for a long-running platform instance.
    if (value.length > MAX_IDENTIFIER_LENGTH || (identifiers.size >= MAX_IDENTIFIERS && identifiers.has(value) === false)) {
      throw new RangeError('Support dump identifier limit');
    }
    let prefix = value.match(RESOURCE_PREFIX)?.[0] ?? '';
    let id = value.slice(prefix.length);
    if (identifiers.has(id) === false) {
      identifiers.set(id, '**REDACTED_' + ++nextAlias + '**');
    }
    let alias = prefix + identifiers.get(id);
    // Retain the full resource reference too, allowing replacement inside arrays and descriptive strings.
    if (identifiers.has(value) === false) {
      if (identifiers.size >= MAX_IDENTIFIERS) {
        throw new RangeError('Support dump identifier limit');
      }
      identifiers.set(value, alias);
    }
    return alias;
  };

  // This is the logging entry point; an unusable logger or connection cannot produce a meaningful dump.
  return (rawData, connectionId, changedData) => {
    if (
      typeof log?.info !== 'function' ||
      rawData === null ||
      typeof rawData !== 'object' ||
      Array.isArray(rawData) === true ||
      typeof connectionId !== 'string' ||
      connectionId.trim() === ''
    ) {
      return;
    }
    let isDelta = changedData instanceof Map;
    let selected = [];
    let nodes = 0;
    try {
      // Discover identifiers before redaction so forward references receive the same alias as their definitions.
      const collect = (value, key, depth) => {
        if (++nodes > MAX_NODES || depth > MAX_DEPTH || key.length > MAX_STRING_LENGTH) {
          throw new RangeError('Support dump traversal limit');
        }
        let rule = fieldRule(key);
        // Private fields will be replaced wholesale, so their contents need no further inspection.
        if (rule === 'remove') {
          return;
        }
        if (typeof value === 'string') {
          if (value.length > MAX_STRING_LENGTH) {
            throw new RangeError('Support dump string limit');
          }
          if (rule === 'alias') {
            registerIdentifier(value);
          } else if (
            STRUCTURE_MODE_ENUMS.has(value) === false &&
            (RESOURCE_PREFIX.test(value) === true || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) === true)
          ) {
            registerIdentifier(value);
          }
        } else if (Array.isArray(value) === true) {
          // Preserve the field rule for ID lists and values wrapped inside protobuf objects.
          for (let item of value) {
            collect(item, key, depth + 1);
          }
        } else if (value !== null && typeof value === 'object' && ArrayBuffer.isView(value) === false) {
          for (let field in value) {
            if (Object.hasOwn(value, field) === true) {
              if (RESOURCE_PREFIX.test(field) === true || isIP(field) !== 0) {
                registerIdentifier(field);
              }
              collect(value[field], rule === 'alias' ? key : field, depth + 1);
            }
          }
        }
      };

      // Delta emissions visit only changed resources; full dumps consider the complete store.
      // Connection and source checks keep unrelated accounts out of the selected payload.
      let keys = isDelta === true ? changedData.keys() : Object.keys(rawData);
      for (let objectKey of keys) {
        let data = rawData[objectKey];
        if (
          data?.connection !== connectionId ||
          [DATA_SOURCE.NEST, DATA_SOURCE.GOOGLE].includes(data?.source) === false ||
          data?.value === null ||
          typeof data?.value !== 'object'
        ) {
          continue;
        }
        let fields = isDelta === true ? changedData.get(objectKey)?.fields : undefined;
        if (isDelta === true && fields instanceof Set === false) {
          continue;
        }
        // Copy selected fields into a container without a prototype, leaving the raw cache intact.
        let value = Object.create(null);
        for (let key in data.value) {
          if (Object.hasOwn(data.value, key) === true && (isDelta === false || fields.has(key) === true)) {
            collect(data.value[key], key, 0);
            value[key] = data.value[key];
          }
        }
        if (Object.keys(value).length > 0) {
          let alias = registerIdentifier(objectKey);
          selected.push({ source: data.source, alias, value });
        }
      }

      if (identifiers.size !== patternSize) {
        // Short identifiers are aliased only in explicit ID fields/keys, avoiding substitutions in ordinary words.
        let names = [...identifiers.keys()].filter((name) => name.length >= 6).sort((left, right) => right.length - left.length);
        // Match longer identifiers first and escape regex characters so IDs are treated as literal text.
        pattern =
          names.length > 0 ? new RegExp(names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : undefined;
        patternSize = identifiers.size;
      }

      // Apply a separate traversal budget to the copy-building pass as well as identifier discovery.
      nodes = 0;
      const redact = (value, key, depth = 0) => {
        if (++nodes > MAX_NODES || depth > MAX_DEPTH) {
          throw new RangeError('Support dump traversal limit');
        }
        let rule = fieldRule(key);
        // Opaque bytes and functions cannot be safely inspected; dropping functions also prevents toJSON bypasses.
        if (rule === 'remove' || ArrayBuffer.isView(value) === true || value instanceof ArrayBuffer || typeof value === 'function') {
          return REDACTED;
        }
        if (Array.isArray(value) === true) {
          return value.map((item) => redact(item, key, depth + 1));
        }
        if (value !== null && typeof value === 'object') {
          // Rewrite identifying keys as well as values, keeping references usable in the diagnostic copy.
          let result = Object.create(null);
          for (let field of Object.keys(value)) {
            let alias = pattern === undefined ? field : field.replace(pattern, (match) => identifiers.get(match));
            result[alias] = redact(value[field], rule === 'alias' ? key : field, depth + 1);
          }
          return result;
        }
        if (typeof value === 'string') {
          if (rule === undefined && STRUCTURE_MODE_ENUMS.has(value) === true) {
            return value;
          }
          // Version values can resemble IPv4 addresses. URLs and MAC addresses remain private under any field name.
          let isVersion = key.toLowerCase().includes('version') === true;
          if (
            /\b[a-z][a-z0-9+.-]*:\/\//i.test(value) === true ||
            /(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i.test(value) === true ||
            (isVersion === false && isIP(value) !== 0)
          ) {
            return REDACTED;
          }
          if (isVersion === true && rule !== 'alias') {
            return value;
          }
          return rule === 'alias'
            ? registerIdentifier(value)
            : pattern === undefined
              ? value
              : value.replace(pattern, (match) => identifiers.get(match));
        }
        // Numeric identifiers are hidden too; ordinary bigint readings are converted for JSON serialisation.
        return rule === 'alias' && value !== null ? REDACTED : typeof value === 'bigint' ? value.toString() : value;
      };

      // Finish all serialisation before logging: unsafe/oversized data must never fall back to unredacted output.
      let output = [];
      let characters = 0;
      for (let entry of selected) {
        let text = JSON.stringify({ [entry.alias]: redact(entry.value, '') }, null, 2);
        characters += text.length;
        if (characters > MAX_OUTPUT_CHARACTERS) {
          throw new RangeError('Support dump output limit');
        }
        output.push({ source: entry.source, text });
      }
      // Emit only the completed redacted blocks, grouping the two API sources under their existing headings.
      for (let source of [DATA_SOURCE.NEST, DATA_SOURCE.GOOGLE]) {
        let entries = output.filter((entry) => entry.source === source);
        if (entries.length === 0) {
          continue;
        }
        log.info(
          '%s support dump for %s API data will be logged below for troubleshooting purposes.',
          isDelta === true ? 'Changed' : 'Full',
          source,
        );
        for (let entry of entries) {
          for (let line of entry.text.split('\n')) {
            log.info('%s', line);
          }
        }
        log.info('End of support dump for %s API data.', source);
      }
    } catch {
      // A static warning explains omission without exposing exception text or falling back to the original payload.
      log?.warn?.('Support dump omitted: data could not be safely redacted within diagnostic limits');
    }
  };
}

// Define exports
export { createSupportDump };
