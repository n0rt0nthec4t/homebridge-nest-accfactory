// HomeGraphAPI
// Part of homebridge-nest-accfactory
//
// Handles HomeGraph discovery, trait reads and device commands for one account,
// using an OAuth access token and a client-owned Foyer gRPC transport.
//
// Entry points:
// - connect() ensures authentication and reads the initial graph and device traits
// - disconnect() stops this API without logging the shared account out
// - refresh() reads the graph and traits and reports changed source fields
// - get(resourceId, key) reads cached source fields; get() returns the last graph
// - set(resourceId, values) sends supported trait updates and thermostat commands
// - getUserPreferences(structureId, deviceId, pageCode) requests a device preference page
//
// Responsibilities:
// - Discover homes, rooms and devices, including default-hidden Nest device types
// - Maintain source resources and report field changes and resource removals
// - Map supported shared setting keys to Foyer trait updates or EnergyService commands
// - Keep polling sequential and back off failed reads without replacing cached state
// - Reject replies from retired connections, replaced credentials or stale command targets
//
// Ownership:
// - The account owner acquires and renews OAuth credentials
// - getAccessToken() synchronously supplies the current token; otherwise AccountSession supplies it
// - AccountSession supplies authentication and lifecycle events when provided
// - This client owns its transport, resource cache and polling timer; poll:false disables polling
// - onData receives { source, changes, isCurrent }; false or rejection retains the previous cache
// - System maintains the combined device view and routes HomeKit requests to this client
//
// Code version 2026.11.23
// Mark Hulskamp
'use strict';

// Define node.js modules
import crypto from 'node:crypto';
import path from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';
import { isDeepStrictEqual } from 'node:util';

// Define our modules
import GrpcTransport from '../grpctransport.js';

// Define constants
import {
  DATA_SOURCE,
  DEVICE_TYPE,
  GOOGLE_HOME_FOYER_PREFIX,
  GOOGLE_HOME_FOYER_ENDPOINTS,
  GOOGLE_HOME_REFERER,
  GOOGLE_HOME_USER_AGENT,
  THERMOSTAT_MIN_TEMPERATURE,
  THERMOSTAT_MAX_TEMPERATURE,
  __dirname,
} from '../consts.js';

const POLL_INTERVAL = 2000;
const RETRY_INITIAL = 5000;
const RETRY_MAX = 60000;
const MAX_DEVICES = 500;

export default class HomeGraphAPI {
  resources = new Map(); // Device records keyed by the account's Foyer UUIDs.
  homes = new Map(); // Home records keyed by the account's structure UUIDs.
  #options = {}; // Account session, current-token callback, logging and source-change consumer.
  #connection = undefined; // Current transport, pending refresh, cached graph and polling timer.

  constructor(options = {}) {
    this.#options = { ...options };
    options.session?.on('disconnect', (refreshing) => {
      // First login announces credential replacement before any transport exists.
      if (refreshing !== true || this.#connection?.transport !== undefined) {
        this.#stop(true);
      }
    });
    // Resume only a client that was already started; authentication alone does not start discovery.
    options.session?.on('authorised', () => {
      if (this.#connection !== undefined) {
        this.connect().catch(() => options.log?.debug?.('Unable to resume HomeGraph API'));
      }
    });
  }

  // Read credentials at request time so token renewal does not require rebuilding the client.
  #token() {
    let session = this.#options.session;
    if (session !== undefined && session.account.authorised !== true) {
      return;
    }
    let token = typeof this.#options.getAccessToken === 'function' ? this.#options.getAccessToken() : session?.account.cameraAuth?.oauth2;
    return typeof token === 'string' && token.trim() !== '' ? token.trim() : undefined;
  }

  // Share account authentication, but allocate and release this API's own Foyer transport.
  async #prepare(connection) {
    let session = this.#options.session;
    if (session !== undefined && (await session.connect()) !== true) {
      throw new Error('Unable to authenticate account');
    }
    if (this.#connection !== connection) {
      return false;
    }
    if (this.#token() === undefined) {
      throw new Error('HomeGraph requires an authorised account with Google OAuth credentials');
    }
    if (connection.transport === undefined) {
      let fieldTest = this.#options.session?.account.fieldTest ?? this.#options.fieldTest;
      connection.transport = new GrpcTransport({
        log: this.#options.log,
        uuid: this.#options.uuid,
        protoPath: path.join(__dirname, 'protobuf/googlehome/foyer.proto'),
        endpointHost: fieldTest === true ? GOOGLE_HOME_FOYER_ENDPOINTS.FIELD_TEST : GOOGLE_HOME_FOYER_ENDPOINTS.PRODUCTION,
        userAgent: GOOGLE_HOME_USER_AGENT,
        referer: GOOGLE_HOME_REFERER,
        origin: GOOGLE_HOME_REFERER,
        requestTimeout: 15000,
        bufferInitial: 8 * 1024,
        bufferMax: 10 * 1024 * 1024,
        getAuthHeader: () => {
          let token = this.#token();
          return token === undefined ? '' : 'Bearer ' + token;
        },
      });
    }
    return true;
  }

  // Repeated starts reuse discovery; refresh() coalesces starts still awaiting their first snapshot.
  async connect() {
    let connection = (this.#connection ??= {});
    if (connection.ready !== true) {
      await this.refresh();
    } else if ((await this.#prepare(connection)) !== true) {
      return false;
    }
    return this.#connection === connection && this.#token() !== undefined;
  }

  disconnect() {
    this.#stop();
  }

  // Retire callbacks before releasing transport resources. Session-driven stops retain
  // the intent to reconnect; an explicit disconnect clears it. Keep the last resource cache.
  #stop(reconnect = false) {
    let connection = this.#connection;
    this.#connection = reconnect === true && connection !== undefined ? {} : undefined;
    clearTimeout(connection?.timer);
    connection?.transport?.release();
  }

  // All Foyer calls share credential and connection checks. SET also supplies a target
  // check because a refresh can replace its device records while the command is pending.
  async #request(connection, service, method, values, targetCurrent = () => true) {
    let token = this.#token();
    let isCurrent = () =>
      connection !== undefined &&
      this.#connection === connection &&
      token !== undefined &&
      this.#token() === token &&
      targetCurrent() === true;
    if (isCurrent() !== true) {
      return;
    }
    let response;
    try {
      response = await connection.transport.command(GOOGLE_HOME_FOYER_PREFIX, service, method, values, { retry: 2 });
    } catch {
      if (isCurrent() !== true) {
        return;
      }
      throw new Error('HomeGraph ' + method + ' request failed');
    }
    // An access-token replacement also retires replies when no session event was used.
    if (isCurrent() !== true) {
      return;
    }
    if (response?.status !== 0 || response.data?.[0] === undefined) {
      let error = new Error('HomeGraph ' + method + ' request failed');
      // Only numeric protocol status leaves the transport boundary, never backend messages.
      error.status = Number.isInteger(response?.status) === true ? response.status : undefined;
      throw error;
    }
    return response.data[0];
  }

  // Build discovery and traits together before publishing changes. A failed or retired
  // read leaves the previous complete snapshot available to GET and later comparisons.
  async refresh() {
    let connection = this.#connection;
    // Keep the polling run guard local, as in the protobuf Observe loop.
    let isCurrent = () => connection !== undefined && this.#connection === connection && this.#token() !== undefined;
    if (connection === undefined) {
      throw new Error('HomeGraph is disconnected');
    }
    // Manual refreshes and polling share one in-flight read instead of overlapping requests.
    if (connection.pending !== undefined) {
      return connection.pending;
    }
    clearTimeout(connection.timer);
    connection.pending = (async () => {
      if ((await this.#prepare(connection)) !== true) {
        return;
      }
      let token = this.#token();
      let succeeded = false;
      try {
        // Foyer omits these Nest types unless requested explicitly, even for an authorised home.
        let graph = await this.#request(connection, 'StructuresService', 'GetHomeGraph', {
          requestId: crypto.randomUUID(),
          deviceTypesToUnhideArray: [
            'DEVICE_TYPE_TOPAZ',
            'DEVICE_TYPE_KRYPTONITE',
            'DEVICE_TYPE_ANTIGUA',
            'DEVICE_TYPE_NEST_TAG',
            'DEVICE_TYPE_NEST_HEATLINK',
          ],
        });
        if (graph === undefined) {
          return;
        }
        // Devices can appear at home level and inside rooms. Merge repeated UUIDs
        // within one home, retaining room membership, and reject conflicting ownership.
        let homes = new Map();
        let resources = new Map();
        let addDevice = (device, structureId, roomId) => {
          let id = device?.id?.googleUuid;
          if (typeof id !== 'string' || id === '') {
            throw new Error('Invalid HomeGraph device identity');
          }
          let existing = resources.get(id);
          if (existing !== undefined) {
            if (existing.structureId !== structureId) {
              throw new Error('Conflicting HomeGraph device ownership');
            }
            existing.roomId ??= roomId;
            return;
          }
          if (resources.size >= MAX_DEVICES) {
            throw new Error('HomeGraph device limit exceeded');
          }
          // Commands are limited to Nest-backed devices, not arbitrary third-party thermostats/locks.
          let nest = device.id.thirdPartyId?.idType?.startsWith('nest') === true;
          let types = { THERMOSTAT: DEVICE_TYPE.THERMOSTAT, SENSOR: DEVICE_TYPE.TEMPSENSOR, LOCK: DEVICE_TYPE.LOCK };
          let type = nest === true ? types[device.type?.replace('action.devices.types.', '')] : undefined;
          resources.set(id, { id, structureId, roomId, device, metadata: { type }, source: DATA_SOURCE.HOMEGRAPH });
        };
        if (Array.isArray(graph.homes ?? []) !== true || Array.isArray(graph.unassignedDevices ?? []) !== true) {
          throw new Error('Invalid HomeGraph discovery response');
        }
        for (let home of graph.homes ?? []) {
          if (typeof home?.uuid !== 'string' || home.uuid === '' || homes.has(home.uuid) === true) {
            throw new Error('Invalid HomeGraph structure identity');
          }
          homes.set(home.uuid, home);
          for (let device of home.devices ?? []) {
            addDevice(device, home.uuid);
          }
          for (let room of home.rooms ?? []) {
            for (let device of room.devices ?? []) {
              addDevice(device, home.uuid, room.uuid);
            }
          }
        }
        // Preserve unassigned devices without inventing a home or room association.
        for (let device of graph.unassignedDevices ?? []) {
          addDevice(device);
        }
        // Discovery supplies identity and topology; GetTraits supplies current device state.
        // Require one state record per requested device before accepting the snapshot.
        if (resources.size > 0) {
          let response = await this.#request(connection, 'HomeControlService', 'GetTraits', {
            deviceIds: [...resources.keys()].map((uuid) => ({ uuid })),
          });
          if (response === undefined) {
            return;
          }
          let seen = new Set();
          for (let state of response.device ?? []) {
            let id = state?.uuid?.value;
            if (resources.has(id) !== true || seen.has(id) === true || Array.isArray(state.category ?? []) !== true) {
              throw new Error('Unexpected HomeGraph trait device');
            }
            seen.add(id);
            resources.get(id).traits = state.category ?? [];
          }
          if (seen.size !== resources.size) {
            throw new Error('Incomplete HomeGraph trait response');
          }
        }
        if (isCurrent() !== true || this.#token() !== token) {
          return;
        }
        // Compare stable source fields under account-scoped IDs. Keep the raw graph
        // separately for get(); transient response fields must not trigger support dumps.
        let changes = [];
        let previous = new Map();
        let next = new Map();
        for (let [id, home] of this.homes) {
          previous.set('STRUCTURE_GH_' + this.#options.uuid + '_' + id, { home });
        }
        for (let [id, home] of homes) {
          // Exclude linked-user records, credentials and response timestamps from source updates.
          let value = { home: { uuid: id, name: home.name, address: home.address, traits: home.traits } };
          next.set('STRUCTURE_GH_' + this.#options.uuid + '_' + id, value);
          homes.set(id, value.home);
        }
        for (let [id, resource] of this.resources) {
          previous.set('DEVICE_GH_' + this.#options.uuid + '_' + id, resource.value);
        }
        for (let [id, resource] of resources) {
          let device = resource.device;
          resource.value = {
            googleHome: {
              id: device.id,
              displayName: device.displayName,
              type: device.type,
              traits: device.traits,
              hardware: device.hardware,
              names: device.names,
              otherIds: device.otherIds,
            },
            traits: resource.traits ?? [],
            attributes: device.attributes,
            structureId: resource.structureId,
            roomId: resource.roomId,
          };
          next.set('DEVICE_GH_' + this.#options.uuid + '_' + id, resource.value);
        }
        for (let [resourceId, value] of next) {
          let fields = new Set(Object.keys(value).filter((key) => isDeepStrictEqual(previous.get(resourceId)?.[key], value[key]) !== true));
          if (fields.size > 0) {
            changes.push({ resourceId, value: structuredClone(value), fields });
          }
        }
        // An absent device or home is an explicit removal, not an empty state update.
        for (let resourceId of previous.keys()) {
          if (next.has(resourceId) !== true) {
            changes.push({ resourceId, remove: true, notify: true });
          }
        }
        // Wait for the consumer's cache commit before advancing our comparison snapshot.
        // Rejected delivery is retried against the same previous values on the next refresh.
        let notification = { source: DATA_SOURCE.HOMEGRAPH, changes, isCurrent: () => isCurrent() === true && this.#token() === token };
        if (changes.length > 0 && (await this.#options.onData?.(notification)) === false) {
          throw new Error('HomeGraph resource batch was not accepted');
        }
        if (notification.isCurrent() !== true) {
          return;
        }
        this.homes = homes;
        this.resources = resources;
        connection.graph = graph;
        connection.ready = true;
        connection.retryDelay = undefined;
        succeeded = true;
      } finally {
        // Schedule after completion so slow requests never accumulate polling work.
        // Successful reads restore the normal interval; failures back off to the retry cap.
        if (isCurrent() === true && this.#options.poll !== false) {
          connection.retryDelay = succeeded === true ? undefined : Math.min((connection.retryDelay ?? RETRY_INITIAL / 2) * 2, RETRY_MAX);
          connection.timer = setTimeout(
            () => {
              if (isCurrent() !== true) {
                return;
              }
              this.refresh().catch(() => this.#options.log?.debug?.('HomeGraph refresh failed; previous state retained'));
            },
            succeeded === true ? POLL_INTERVAL : connection.retryDelay,
          );
          connection.timer.unref?.();
        }
      }
    })();
    try {
      return await connection.pending;
    } finally {
      connection.pending = undefined;
    }
  }

  // A graph GET may start discovery. Device GETs only read this account's cache,
  // matching System routing without starting another API or returning mutable records.
  async get(resourceId = undefined, key = undefined) {
    if (resourceId === undefined) {
      if ((await this.connect()) !== true) {
        return;
      }
      return { source: DATA_SOURCE.HOMEGRAPH, value: structuredClone(this.#connection.graph) };
    }
    let prefix = 'DEVICE_GH_' + this.#options.uuid + '_';
    let id = typeof resourceId === 'string' && resourceId.startsWith(prefix) === true ? resourceId.slice(prefix.length) : resourceId;
    let resource = this.resources.get(id);
    if (resource === undefined || this.#connection === undefined || this.#token() === undefined) {
      throw new Error('HomeGraph device GET requires a discovered device');
    }
    return structuredClone(resource.value[key]);
  }

  // Preference page codes are supplied by the caller and remain scoped to a discovered home/device pair.
  async getUserPreferences(structureId, deviceId, pageCode) {
    let connection = this.#connection;
    let resource = this.resources.get(deviceId);
    if (connection?.ready !== true || resource?.structureId !== structureId || resource === undefined) {
      throw new Error('HomeGraph preferences require a discovered device in this structure');
    }
    let response = await this.#request(connection, 'UsersService', 'GetUserPreferences', {
      structureId,
      pageCode: [pageCode],
      uuid: { value: deviceId },
      unknown5: '',
    });
    return response === undefined ? undefined : structuredClone(response);
  }

  // values contains shared setting names, e.g. { target_temperature: 21 }.
  // Success resolves without a value; SET does not mutate the committed cache.
  // AggregateError can mean partial cloud success; polling reconciles actual state.
  async set(resourceId, values) {
    let connection = this.#connection;
    let isCurrent = () => connection !== undefined && this.#connection === connection && this.#token() !== undefined;

    // Match protobuf parameter validation before resource lookup or network work.
    // HomeGraph also accepts owner-supplied OAuth without an AccountSession.
    if (
      typeof resourceId !== 'string' ||
      resourceId.trim() === '' ||
      typeof values !== 'object' ||
      values === null ||
      Array.isArray(values) === true ||
      this.#token() === undefined
    ) {
      throw new Error('SET requires valid parameters and an authorised device account');
    }
    let prefix = 'DEVICE_GH_' + this.#options.uuid + '_';
    let id = resourceId.startsWith(prefix) === true ? resourceId.slice(prefix.length) : resourceId;
    if (this.resources.has(id) !== true) {
      throw new Error('SET requires an available authorised device account');
    }

    // Commands depend on traits read by this connection's initial discovery.
    if (connection?.ready !== true || isCurrent() !== true) {
      throw new Error('Google Home command transport is unavailable');
    }

    // Map supported shared setting keys here, as in the Nest and Observe clients.
    // Invalid values leave the request unset and reach one common rejection below.
    // Independent settings may partly succeed; report every failed setting.
    let failures = [];
    let appliedMode;
    let modeChangeFailed = false;
    // Apply mode changes before setpoints, regardless of the caller's property order.
    let settings = {
      ...(Object.hasOwn(values, 'eco_mode') === true ? { eco_mode: values.eco_mode } : {}),
      ...(Object.hasOwn(values, 'hvac_mode') === true ? { hvac_mode: values.hvac_mode } : {}),
      ...values,
    };
    for (let [key, value] of Object.entries(settings)) {
      try {
        let request;
        let targetId = id;
        let resource = this.resources.get(id);
        let service = 'HomeControlService';
        let method = 'UpdateTraits';
        let targetCurrent = () => isCurrent() === true && this.resources.get(id) === resource;
        // Index the nested Foyer categories locally; their reported attributes describe
        // supported thermostat modes and temperature limits for this device.
        let traits = Object.fromEntries(
          (resource?.traits ?? []).map((category) => [
            category.name,
            Object.fromEntries((category.traits ?? []).map((trait) => [trait.name, trait.value])),
          ]),
        );
        let attributes = resource?.traits?.find((category) => category.name === 'temperatureSetting')?.attributes?.properties;
        let modes = attributes
          ?.find((property) => property.name === 'availableThermostatModes')
          ?.value?.array?.values?.map((mode) => mode.text);
        let mode = appliedMode ?? traits.temperatureSetting?.mode?.text;
        if (
          modeChangeFailed === true &&
          ['hvac_mode', 'target_temperature', 'target_temperature_low', 'target_temperature_high'].includes(key) === true
        ) {
          throw new Error('Thermostat mode change failed; dependent setting was not sent');
        }
        switch (key) {
          case 'bolt_lock': {
            // UpdateTraits needs both the Foyer UUID and the device provider's original source ID.
            let source = resource?.device?.id?.thirdPartyId?.idType;
            if (
              resource?.metadata?.type !== DEVICE_TYPE.LOCK ||
              typeof value !== 'boolean' ||
              typeof traits.lockUnlock?.isLocked?.boolean !== 'boolean' ||
              typeof source !== 'string' ||
              source.trim() === ''
            ) {
              break;
            }
            request = {
              request: [
                {
                  deviceId: { uuid: id, internalId: { source } },
                  categories: [{ name: 'lockUnlock', traits: [{ name: 'isLocked', value: { boolean: value } }] }],
                },
              ],
            };
            break;
          }
          case 'active_sensor': {
            let sensor = resource;
            // Selecting the thermostat itself restores its built-in temperature sensor.
            if (sensor?.metadata?.type === DEVICE_TYPE.THERMOSTAT && value === true) {
              if (traits.temperatureSetting?.activeThermostatTemperatureSensors?.array === undefined) {
                break;
              }
              let source = sensor.device?.id?.thirdPartyId?.idType;
              if (typeof source !== 'string' || source.trim() === '') {
                break;
              }
              request = {
                request: [
                  {
                    deviceId: { uuid: id, internalId: { source } },
                    categories: [
                      {
                        name: 'temperatureSetting',
                        traits: [{ name: 'activeThermostatTemperatureSensors', value: { array: { values: [{ text: id }] } } }],
                      },
                    ],
                  },
                ],
              };
              break;
            }
            // Remote sensors route selection through their parent thermostat. Turning
            // off the currently selected remote sensor restores the thermostat sensor.
            if (typeof value !== 'boolean' || sensor?.metadata?.type !== DEVICE_TYPE.TEMPSENSOR || typeof sensor.structureId !== 'string') {
              break;
            }
            // The thermostat owns selection. Resolve it from this account's
            // explicit sensor list, never from caller-supplied routing data.
            let parents = [...this.resources.values()].filter((candidate) => {
              if (candidate.metadata?.type !== DEVICE_TYPE.THERMOSTAT || candidate.structureId !== sensor.structureId) {
                return false;
              }
              let known = candidate.traits
                ?.find((category) => category.name === 'temperatureSetting')
                ?.traits?.find((trait) => trait.name === 'knownThermostatTemperatureSensors')?.value?.array?.values;
              return (
                Array.isArray(known) === true &&
                known.some(
                  (entry) =>
                    entry?.properties?.properties?.some(
                      (property) => property.name === 'sensorId' && property.value?.text === sensor.id,
                    ) === true,
                )
              );
            });
            if (parents.length !== 1) {
              break;
            }
            let parent = parents[0];
            let source = parent.device?.id?.thirdPartyId?.idType;
            let selected = parent.traits
              ?.find((category) => category.name === 'temperatureSetting')
              ?.traits?.find((trait) => trait.name === 'activeThermostatTemperatureSensors')?.value?.array?.values;
            if (typeof source !== 'string' || source.trim() === '' || Array.isArray(selected) !== true) {
              break;
            }
            if (value === false && selected.some((entry) => entry.text === sensor.id) !== true) {
              break;
            }
            // Reject work superseded by a new snapshot or connection. Resource
            // records are replaced by refresh(), so identity fingerprints and
            // repeated discovery scans are unnecessary here.
            let homeId = sensor.structureId;
            targetCurrent = () =>
              isCurrent() === true &&
              this.resources.get(id) === sensor &&
              this.resources.get(parent.id) === parent &&
              sensor.structureId === homeId &&
              parent.structureId === homeId &&
              (value === true ||
                parent.traits
                  ?.find((category) => category.name === 'temperatureSetting')
                  ?.traits?.find((trait) => trait.name === 'activeThermostatTemperatureSensors')
                  ?.value?.array?.values?.some((entry) => entry.text === id) === true);
            targetId = parent.id;
            request = {
              request: [
                {
                  deviceId: { uuid: parent.id, internalId: { source } },
                  categories: [
                    {
                      name: 'temperatureSetting',
                      traits: [
                        {
                          name: 'activeThermostatTemperatureSensors',
                          value: { array: { values: [{ text: value === true ? sensor.id : parent.id }] } },
                        },
                      ],
                    },
                  ],
                },
              ],
            };
            break;
          }
          case 'hvac_mode':
          case 'eco_mode': {
            if (resource?.metadata?.type !== DEVICE_TYPE.THERMOSTAT || typeof value !== 'string') {
              break;
            }
            // Shared range/manual-Eco names map to Foyer heatcool/eco mode values.
            let requested;
            if (key === 'eco_mode') {
              if (value.toLowerCase() === 'off' && Object.hasOwn(values, 'hvac_mode') === true) {
                continue; // The explicit normal-mode command exits Eco in the same operation.
              }
              requested = value.toLowerCase() === 'manual' ? 'eco' : value.toLowerCase() === 'off' && mode !== 'eco' ? mode : undefined;
            } else {
              requested = value.toLowerCase() === 'range' ? 'heatcool' : value.toLowerCase();
            }
            if (['heat', 'cool', 'heatcool', 'off', 'eco'].includes(requested) !== true || modes?.includes(requested) !== true) {
              break;
            }
            service = 'EnergyService';
            method = 'UpdateThermostatMode';
            request = { deviceId: id, mode: requested, unknown3: 6 };
            break;
          }
          case 'target_temperature':
          case 'target_temperature_low':
          case 'target_temperature_high': {
            if (resource?.metadata?.type !== DEVICE_TYPE.THERMOSTAT || typeof value !== 'number' || Number.isFinite(value) !== true) {
              break;
            }
            let range = attributes?.find((property) => property.name === 'thermostatTemperatureRange')?.value?.properties?.properties;
            let minimum = range?.find((property) => property.name === 'minThresholdCelsius')?.value?.number ?? THERMOSTAT_MIN_TEMPERATURE;
            let maximum = range?.find((property) => property.name === 'maxThresholdCelsius')?.value?.number ?? THERMOSTAT_MAX_TEMPERATURE;
            if (value < minimum || value > maximum || ['heat', 'cool', 'heatcool'].includes(mode) !== true) {
              break;
            }
            service = 'EnergyService';
            // Range mode writes both thresholds together, retaining the observed companion
            // value when only one is supplied. A paired update sends one range command.
            if (mode === 'heatcool') {
              if (
                key === 'target_temperature' ||
                (key === 'target_temperature_high' && Object.hasOwn(values, 'target_temperature_low') === true)
              ) {
                if (key === 'target_temperature_high') {
                  continue;
                }
                break;
              }
              let low = values.target_temperature_low ?? traits.temperatureSetting?.thermostatTemperatureSetpointLowC?.number;
              let high = values.target_temperature_high ?? traits.temperatureSetting?.thermostatTemperatureSetpointHighC?.number;
              let buffer = attributes?.find((property) => property.name === 'bufferRangeCelsius')?.value?.number ?? 0;
              if (
                typeof low !== 'number' ||
                typeof high !== 'number' ||
                Number.isFinite(low) !== true ||
                Number.isFinite(high) !== true ||
                low < minimum ||
                high > maximum ||
                high - low < buffer
              ) {
                break;
              }
              method = 'UpdateTargetTemperatureRange';
              request = { deviceId: id, tempLow: { value: low }, tempHigh: { value: high }, unknown4: 6 };
            } else {
              if ((key === 'target_temperature_low' && mode !== 'heat') || (key === 'target_temperature_high' && mode !== 'cool')) {
                break;
              }
              method = 'UpdateTargetTemperature';
              request = { deviceId: id, mode, temperature: { value }, unknown4: 6 };
            }
            break;
          }
          case 'fan_state': {
            // Foyer expresses manual fan operation as a duration; zero cancels it.
            // Duration and speed accompany fan_state rather than creating separate writes.
            let duration = values.fan_duration ?? 900;
            if (
              resource?.metadata?.type !== DEVICE_TYPE.THERMOSTAT ||
              typeof value !== 'boolean' ||
              typeof traits.fanSettings?.fanTimerEndTimestampSec?.number !== 'number' ||
              (value === true &&
                (typeof duration !== 'number' || Number.isInteger(duration) !== true || duration < 900 || duration > 604800)) ||
              (values.fan_timer_speed !== undefined && values.fan_timer_speed !== (value === true ? 1 : 0))
            ) {
              break;
            }
            service = 'EnergyService';
            method = 'UpdateThermostatFanMode';
            request = { deviceId: id, runTimeSeconds: { value: value === true ? duration : 0 } };
            break;
          }
          case 'fan_duration':
          case 'fan_timer_speed':
            if (Object.hasOwn(values, 'fan_state') === true) {
              continue;
            }
            break;
          default:
            break;
        }

        if (request === undefined) {
          throw new Error('Invalid or unsupported setting "' + key + '" for this device');
        }

        let response = await this.#request(connection, service, method, request, targetCurrent);
        if (response?.constructor !== Object || (response.device !== undefined && Array.isArray(response.device) !== true)) {
          throw new Error('Google Home rejected setting');
        }
        // gRPC success may carry a device error/challenge. Never automatically
        // acknowledge a challenge or include backend details in the error.
        for (let state of response.device ?? []) {
          if (state?.uuid?.value !== targetId) {
            throw new Error('Unexpected Google Home setting response');
          }
          for (let category of state.category ?? []) {
            if (
              category?.name === 'deviceStatus' &&
              category.traits?.some(
                (trait) =>
                  ['error', 'challenge'].includes(trait?.name) === true && trait.value?.nullValue === undefined && trait.value?.text !== '',
              ) === true
            ) {
              throw new Error('Google Home rejected setting or requires a challenge');
            }
          }
        }
        // Later setpoints in this SET use the accepted mode while the observed cache
        // remains unchanged until polling confirms the device's state.
        if (method === 'UpdateThermostatMode') {
          appliedMode = request.mode;
        }
        // Normal polling remains the authoritative state writer for Google Home
        // devices; accepted SETs do not fabricate observed state.
      } catch (error) {
        if (key === 'hvac_mode' || key === 'eco_mode') {
          modeChangeFailed = true;
        }
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        'One or more Google Home API settings failed: ' + failures.map((error) => error.message).join('; '),
      );
    }
  }
}
