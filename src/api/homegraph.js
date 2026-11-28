// HomeGraphAPI
// Part of homebridge-nest-accfactory
//
// Handles HomeGraph discovery, trait reads and device commands for one account,
// using an OAuth access token and a client-owned Foyer gRPC transport.
//
// connect()/refresh() discover resources and publish accepted field deltas;
// get()/set() handle shared device queries and settings. getUserPreferences()
// reads a caller-selected page within a discovered device's home.
//
// Owns Foyer transport, source cache, snapshot requests and reconciliation polling.
// GoogleHomePush owns receiver registration and retries; unavailable push uses polling.
// AccountSession (or getAccessToken()) owns OAuth. Retired work cannot commit data.
// onData({ source, changes, isCurrent }) must accept the cache update before it is
// committed; System handles accessory delivery separately. poll:false disables polling.
//
// Code version 2026.11.28
// Mark Hulskamp

// Define node.js modules
import { setTimeout, clearTimeout } from 'node:timers';
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

// Define our modules
import { fetchWrapper } from '../fetchWrapper.js';
import GrpcTransport from '../grpctransport.js';
import { getProtoType } from '../protobuf.js';
import { adjustTemperature } from '../utils.js';
import GoogleHomePush from './homegraphpush.js';

// Define constants
import {
  ACCOUNT_TYPE,
  DATA_SOURCE,
  DEVICE_TYPE,
  GOOGLE_HOME_FOYER_PREFIX,
  GOOGLE_HOME_CLIENT_ENVIRONMENT,
  GOOGLE_HOME_FOYER_ENDPOINTS,
  GOOGLE_HOME_REFERER,
  GOOGLE_HOME_USER_AGENT,
  GOOGLE_HOME_HEATLINK_MODEL,
  THERMOSTAT_MIN_TEMPERATURE,
  THERMOSTAT_MAX_TEMPERATURE,
  HOTWATER_BOOST_TIMES,
  __dirname,
} from '../consts.js';

const POLL_INTERVAL = 2000;
const RECONCILE_INTERVAL = 30000;
const RETRY_INITIAL = 5000;
const RETRY_MAX = 60000;
const MAX_DEVICES = 500;
const SNAPSHOT_TIMEOUT = 7000;
const SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;
const CAMERA_HISTORY_LIMIT = 100;
const CAMERA_EVENT_WINDOW = 15000;

export default class HomeGraphAPI {
  resources = new Map(); // Device records keyed by the account's Foyer UUIDs.
  homes = new Map(); // Home records keyed by the account's structure UUIDs.
  #options = {}; // Account session, current-token callback, logging and source-change consumer.
  #connection = undefined; // Current transport, push receiver, cache commits and reconciliation timer.

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
    connection?.push?.disconnect();
    for (let controller of connection?.snapshots ?? []) {
      controller.abort();
    }
    connection?.snapshots?.clear();
    connection?.transport?.release();
  }

  // Read credentials at request time so token renewal does not require rebuilding the client.
  #token() {
    let session = this.#options.session;
    if (session !== undefined && session.account.authorised !== true) {
      return;
    }
    let token =
      typeof this.#options.getAccessToken === 'function'
        ? this.#options.getAccessToken()
        : (session?.account.oauth2 ?? session?.account.cameraAuth?.oauth2);
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
      let protoPath = path.join(__dirname, 'protobuf/googlehome/foyer.proto');
      let environmentType = getProtoType(protoPath, GOOGLE_HOME_FOYER_PREFIX + 'ClientEnvironment');
      connection.transport = new GrpcTransport({
        log: this.#options.log,
        uuid: this.#options.uuid,
        protoPath,
        foyerEnvironment: Buffer.from(environmentType.encode(GOOGLE_HOME_CLIENT_ENVIRONMENT).finish()).toString('base64'),
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

  // Telemetry may replace a cache record while a command is pending. Only a
  // changed device/provider identity, type or home retires that command target.
  #isDeviceCurrent(id, resource) {
    let current = this.resources.get(id);
    return (
      resource !== undefined &&
      current !== undefined &&
      current.structureId === resource.structureId &&
      current.device.type === resource.device.type &&
      isDeepStrictEqual(current.device.id, resource.device.id) === true
    );
  }

  // All Foyer calls share credential, connection and response checks. Callers can
  // additionally bind a request to its device identity and a shorter deadline.
  async #request(connection, service, method, values, targetCurrent = () => true, options = {}) {
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
      response = await connection.transport.command(GOOGLE_HOME_FOYER_PREFIX, service, method, values, options);
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
      let updates = new Map();
      connection.readUpdates = updates;
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
          let types = {
            THERMOSTAT: DEVICE_TYPE.THERMOSTAT,
            SENSOR: GOOGLE_HOME_HEATLINK_MODEL.test(device.hardware?.model ?? '') === true ? DEVICE_TYPE.HEATLINK : DEVICE_TYPE.TEMPSENSOR,
            LOCK: DEVICE_TYPE.LOCK,
            SMOKE_DETECTOR: DEVICE_TYPE.PROTECT,
            CAMERA: DEVICE_TYPE.CAMERA,
            DOORBELL: DEVICE_TYPE.DOORBELL,
          };
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
          // Seed virtual weather discovery once per location. Accessory timers
          // refresh readings; ordinary graph reconciliation reuses accepted data.
          let previous = this.homes.get(home.uuid);
          if (previous?.weather !== undefined && isDeepStrictEqual(previous.address?.coordinates, home.address?.coordinates) === true) {
            home.weather = previous.weather;
          } else {
            try {
              let weather = await this.#getWeather(home.uuid, home);
              if (weather !== undefined) {
                home.weather = weather;
              }
            } catch {
              this.#options.log?.debug?.('HomeGraph weather unavailable; discovery retained');
            }
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
            let previous = this.#isDeviceCurrent(id, resources.get(id)) === true ? this.resources.get(id).traits : [];
            resources.get(id).traits = this.#mergeTraits(previous, state.category ?? [], true);
          }
          if (seen.size !== resources.size) {
            throw new Error('Incomplete HomeGraph trait response');
          }
        }
        if (isCurrent() !== true || this.#token() !== token) {
          return;
        }
        for (let [id, home] of homes) {
          // Exclude linked-user records, credentials and response timestamps from source updates.
          let value = {
            home: {
              uuid: id,
              name: home.name,
              address: home.address,
              traits: home.traits,
              rooms: (home.rooms ?? []).map((room) => ({ uuid: room.uuid, name: room.name })),
            },
          };
          if (home.weather !== undefined) {
            value.home.weather = home.weather;
          }
          homes.set(id, value.home);
        }
        for (let id of connection.technicalRetry?.keys() ?? []) {
          if (resources.has(id) !== true) {
            connection.technicalRetry.delete(id);
          }
        }
        for (let resource of resources.values()) {
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
          if (device.parentDevice !== undefined) {
            resource.value.googleHome.parentDevice = device.parentDevice;
          }
        }
        let accepted = await this.#commit(
          connection,
          () => {
            // A weather timer can finish while discovery is in flight.
            for (let [id, home] of homes) {
              let current = this.homes.get(id);
              if (current?.weather !== undefined && isDeepStrictEqual(current.address?.coordinates, home.address?.coordinates) === true) {
                home.weather = current.weather;
              }
            }
            // Metadata may finish while this poll is in flight. Reuse only the
            // latest accepted identity for the same cloud device and home.
            for (let resource of resources.values()) {
              if (this.#isDeviceCurrent(resource.id, resource) === true) {
                let value = this.resources.get(resource.id).value;
                if (value.technicalInformation !== undefined) {
                  resource.value.technicalInformation = value.technicalInformation;
                }
                if (value.floodlightId !== undefined) {
                  resource.value.floodlightId = value.floodlightId;
                }
              }
            }
            // Apply push deltas accepted while this read was in flight. Only those
            // fields override the full response; unrelated poll changes still reconcile.
            for (let [id, categories] of updates) {
              let resource = resources.get(id);
              if (resource !== undefined) {
                resource.traits = this.#mergeTraits(resource.traits, categories);
                resource.value.traits = resource.traits;
              }
            }
            return { homes, resources, graph };
          },
          () => isCurrent() === true && this.#token() === token,
        );
        if (accepted !== true) {
          return;
        }
        connection.ready = true;
        connection.retryDelay = undefined;
        succeeded = true;
        this.#refreshDeviceInformation(connection);
      } finally {
        if (connection.readUpdates === updates) {
          connection.readUpdates = undefined;
        }
        // Schedule after completion so slow requests never accumulate polling work.
        this.#schedule(connection, succeeded);
      }
    })();
    try {
      return await connection.pending;
    } finally {
      connection.pending = undefined;
      await this.#syncPush(connection);
    }
  }

  // Polling remains the fallback while push is unavailable. A healthy receiver
  // reduces reads to reconciliation; failures retain the established retry backoff.
  #schedule(connection, succeeded = true) {
    clearTimeout(connection.timer);
    if (this.#connection !== connection || this.#token() === undefined || this.#options.poll === false) {
      return;
    }
    connection.retryDelay = succeeded === true ? undefined : Math.min((connection.retryDelay ?? RETRY_INITIAL / 2) * 2, RETRY_MAX);
    connection.timer = setTimeout(
      () => {
        if (this.#connection !== connection || this.#token() === undefined) {
          return;
        }
        this.refresh().catch(() => this.#options.log?.debug?.('HomeGraph refresh failed; previous state retained'));
      },
      succeeded === true ? (connection.pushReady === true ? RECONCILE_INTERVAL : POLL_INTERVAL) : connection.retryDelay,
    );
    connection.timer.unref?.();
  }

  // Share one commit boundary between full reads and partial pushes. Network
  // requests stay outside this queue so MCS can continue delivering during a poll.
  async #commit(connection, update, isCurrent) {
    let pending = (connection.committing ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (isCurrent() !== true) {
          return false;
        }
        let next = update();
        let previous = new Map();
        let values = new Map();
        let devicePrefix = 'DEVICE_';
        // Push identifies its one device. Full reads also reconcile topology and
        // removals; a single-device update need not scan every cached resource.
        if (next.id === undefined) {
          for (let [id, home] of this.homes) {
            previous.set('STRUCTURE_' + id, { home });
          }
          for (let [id, home] of next.homes) {
            values.set('STRUCTURE_' + id, { home });
          }
        }
        let ids = next.id === undefined ? new Set([...this.resources.keys(), ...next.resources.keys()]) : [next.id];
        for (let id of ids) {
          let before = this.resources.get(id);
          let after = next.resources.get(id);
          if (before !== undefined) {
            previous.set(devicePrefix + id, this.#notificationValue(before.value));
          }
          if (after !== undefined) {
            values.set(devicePrefix + id, this.#notificationValue(after.value));
          }
        }
        let changes = [];
        for (let [resourceId, value] of values) {
          // Initial resources contain every bucket. Thereafter compare against
          // the last accepted state and emit only changed or removed buckets.
          let before = previous.get(resourceId);
          let fields = new Set([...Object.keys(before ?? {}), ...Object.keys(value)]);
          for (let key of fields) {
            if (isDeepStrictEqual(before?.[key], value[key]) === true) {
              fields.delete(key);
            }
          }
          if (fields.size > 0) {
            let patch = Object.fromEntries([...fields].map((key) => [key, value[key]]));
            let kind = resourceId.startsWith('STRUCTURE_') === true ? 'STRUCTURE' : 'DEVICE';
            let nativeId = resourceId.slice(kind.length + 1);
            let change = { resourceId: nativeId, kind, value: structuredClone(patch), fields };
            // Use the existing home notification contract to resolve configured
            // exclusions by name, without source-specific handling in System.
            if (resourceId.startsWith('STRUCTURE_') === true && typeof value.home?.name === 'string') {
              change.home = { name: value.home.name, values: { homegraph_home_uuid: nativeId } };
            }
            changes.push(change);
          } else if (resourceId.startsWith(devicePrefix) === true) {
            // An identical poll must not retire an in-flight command. Genuine
            // source changes still replace the record and invalidate stale work.
            let id = resourceId.slice(devicePrefix.length);
            next.resources.set(id, this.resources.get(id));
          }
        }
        for (let resourceId of previous.keys()) {
          if (values.has(resourceId) !== true) {
            let kind = resourceId.startsWith('STRUCTURE_') === true ? 'STRUCTURE' : 'DEVICE';
            changes.push({ resourceId: resourceId.slice(kind.length + 1), kind, remove: true, notify: true });
          }
        }
        if (changes.length > 0 && (await this.#options.onData?.({ source: DATA_SOURCE.HOMEGRAPH, changes, isCurrent })) === false) {
          throw new Error('HomeGraph resource batch was not accepted');
        }
        if (isCurrent() !== true) {
          return false;
        }
        this.homes = next.homes;
        this.resources = next.resources;
        // Snapshot requests wait for accepted image updates from either push or polling.
        for (let [waiter, id] of connection.snapshotWaiters ?? []) {
          waiter(this.resources.get(id)?.traits);
        }
        // Discovery retires cached reads for removed, moved or replaced cameras.
        for (let [id, read] of next.id === undefined ? (connection.cameraEvents ?? []) : []) {
          let resource = this.resources.get(id);
          if (
            this.homes.has(read.home) !== true ||
            resource?.structureId !== read.home ||
            isDeepStrictEqual(resource?.value.googleHome?.id, read.identity) !== true
          ) {
            connection.cameraEvents.delete(id);
          }
        }
        connection.graph = next.graph;
        if (next.categories !== undefined && connection.readUpdates !== undefined) {
          let { id, categories } = next;
          connection.readUpdates.set(id, this.#mergeTraits(connection.readUpdates.get(id) ?? [], categories));
        }
        return true;
      });
    connection.committing = pending;
    try {
      return await pending;
    } finally {
      if (connection.committing === pending) {
        connection.committing = undefined;
      }
    }
  }

  // Start for Google Home accounts or an owner-supplied receiver. Reconfigure
  // for discovery or token changes; the receiver owns startup and reconnect retries.
  async #syncPush(connection) {
    if (
      this.#connection !== connection ||
      connection.ready !== true ||
      this.#token() === undefined ||
      (this.#options.session?.account?.type !== ACCOUNT_TYPE.GOOGLE_HOME && typeof this.#options.registerPush !== 'function')
    ) {
      return;
    }
    let ids = new Set(this.resources.keys());
    let token = this.#token();
    if (connection.push !== undefined && connection.pushToken === token && isDeepStrictEqual(connection.pushIds, ids) === true) {
      return;
    }
    connection.push?.disconnect();
    connection.pushReady = undefined;
    connection.pushIds = ids;
    connection.pushToken = token;
    if (ids.size === 0) {
      connection.push = undefined;
      return;
    }
    let push;
    let isCurrent = () => this.#connection === connection && connection.push === push && this.#token() === token;
    push = new GoogleHomePush({
      uuid: this.#options.uuid,
      log: this.#options.log,
      transport: connection.transport,
      account: this.#options.session?.account,
      storagePath: this.#options.storagePath,
      register: this.#options.registerPush,
      onStatus: (ready) => {
        if (isCurrent() === true) {
          if (ready !== connection.pushReady) {
            this.#options.log?.debug?.(
              ready === true ? 'HomeGraph push active; polling reduced to reconciliation' : 'HomeGraph push unavailable; polling retained',
            );
          }
          connection.pushReady = ready;
          // Push availability changes normal polling cadence, not a failed
          // discovery's retry deadline or accumulated backoff.
          if (connection.retryDelay === undefined) {
            this.#schedule(connection);
          }
        }
      },
      onRefresh: (pushCurrent) => {
        if (isCurrent() === true && pushCurrent() === true) {
          this.refresh().catch(() => this.#options.log?.debug?.('HomeGraph push reconciliation failed; previous state retained'));
        }
      },
      onData: (state, pushCurrent) =>
        this.#commit(
          connection,
          () => {
            let id = state.uuid?.value;
            let resource = this.resources.get(id);
            // Removed or unassigned foreign IDs never create resources through push.
            if (resource === undefined) {
              return { homes: this.homes, resources: this.resources, graph: connection.graph };
            }
            let categories = this.#mergeTraits([], state.category);
            let traits = this.#mergeTraits(resource.traits, categories);
            let value = { ...resource.value, traits };
            let resources = new Map(this.resources);
            resources.set(id, { ...resource, traits, value });
            let accepted = categories.map((category) => {
              let values = new Map(traits.find((item) => item.name === category.name).traits.map((trait) => [trait.name, trait]));
              return { ...category, traits: category.traits.map((trait) => values.get(trait.name)) };
            });
            return { homes: this.homes, resources, graph: connection.graph, id, categories: accepted };
          },
          () => isCurrent() === true && pushCurrent() === true,
        ),
    });
    connection.push = push;
    try {
      await push.connect([...ids]);
    } catch {
      // The receiver reports unavailable status and owns its next retry.
    }
  }

  // values contains shared setting names, e.g. { target_temperature: 21 }.
  // Success resolves without a value; SET does not mutate the committed cache.
  // AggregateError can mean partial cloud success; polling reconciles actual state.
  async set(resourceId, values) {
    let connection = this.#connection;
    let isCurrent = () => connection !== undefined && this.#connection === connection && this.#token() !== undefined;

    // Validate parameters before resource lookup or network work.
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
    let id = resourceId;
    if (this.resources.has(id) !== true) {
      throw new Error('SET requires an available authorised device account');
    }

    // Commands depend on traits read by this connection's initial discovery.
    if (connection?.ready !== true || isCurrent() !== true) {
      throw new Error('Google Home command transport is unavailable');
    }

    // Build protocol requests from the shared setting names.
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
        if (
          modeChangeFailed === true &&
          ['hvac_mode', 'target_temperature', 'target_temperature_low', 'target_temperature_high'].includes(key) === true
        ) {
          throw new Error('Thermostat mode change failed; dependent setting was not sent');
        }
        let resource = this.resources.get(id);
        let setting = this.#buildSetting(id, key, value, values, resource, appliedMode, isCurrent);
        if (setting.skip === true) {
          continue;
        }
        let { request, service, method, targetId, targetCurrent } = setting;

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
        // remains unchanged until ingestion confirms the device's state.
        if (key === 'hvac_mode' || key === 'eco_mode') {
          appliedMode = setting.mode;
        }
        // Push and reconciliation remain the authoritative state writers for Google Home
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

  #buildSetting(resourceId, key, value, values, resource, appliedMode, isCurrent) {
    // Return one protocol request; set() owns execution, accepted mode and errors.
    // Related-device settings retain their ownership checks for the pending write.
    let request;
    let thermostatTraits;
    let targetId = resourceId;
    let service = 'HomeControlService';
    let method = 'UpdateTraits';
    let targetCurrent = () => isCurrent() === true && this.#isDeviceCurrent(resourceId, resource) === true;
    // Index the nested Foyer categories locally; their reported attributes describe
    // supported thermostat modes and temperature limits for this device.
    let traits = Object.fromEntries(
      (resource?.traits ?? []).map((category) => [
        category.name,
        Object.fromEntries((category.traits ?? []).map((trait) => [trait.name, trait.value])),
      ]),
    );
    let temperature = traits.temperatureSetting;
    let attributes = resource?.traits?.find((category) => category.name === 'temperatureSetting')?.attributes?.properties;
    let modes = attributes
      ?.find((property) => property.name === 'availableThermostatModes')
      ?.value?.array?.values?.map((mode) => mode.text);
    let mode = appliedMode ?? temperature?.mode?.text;

    switch (key) {
      case 'streaming_enabled': {
        if (
          [DEVICE_TYPE.CAMERA, DEVICE_TYPE.DOORBELL].includes(resource?.metadata?.type) !== true ||
          resource?.device?.id?.thirdPartyId?.idType?.startsWith('nest') !== true ||
          typeof traits.onOff?.onOff?.boolean !== 'boolean' ||
          typeof value !== 'boolean'
        ) {
          break;
        }
        // Camera power is a wrapped property; false must be sent explicitly.
        service = 'CameraService';
        method = 'UpdateCameraProperty';
        request = { hgsDeviceId: resourceId, properties: { streamingEnabled: { value } } };
        break;
      }
      case 'light_enabled':
      case 'light_brightness': {
        // The camera's preference link identifies the light; never send light commands
        // to the camera itself or to a similarly named device in another home/account.
        let light = this.resources.get(resource?.value?.floodlightId);
        let source = light?.device?.id?.thirdPartyId?.idType;
        let category = key === 'light_enabled' ? 'onOff' : 'brightness';
        let current = light?.traits?.find((entry) => entry.name === category)?.traits?.find((entry) => entry.name === category)?.value;
        if (
          resource?.metadata?.type !== DEVICE_TYPE.CAMERA ||
          typeof resource.structureId !== 'string' ||
          light?.structureId !== resource.structureId ||
          light?.device?.type !== 'action.devices.types.LIGHT' ||
          source?.startsWith('nest') !== true ||
          (key === 'light_enabled'
            ? typeof value !== 'boolean' || typeof current?.boolean !== 'boolean'
            : typeof value !== 'number' ||
              Number.isFinite(value) !== true ||
              value < 0 ||
              value > 100 ||
              typeof current?.number !== 'number')
        ) {
          break;
        }
        targetId = light.id;
        targetCurrent = () =>
          isCurrent() === true &&
          this.#isDeviceCurrent(resourceId, resource) === true &&
          this.#isDeviceCurrent(targetId, light) === true &&
          this.resources.get(resourceId)?.value.floodlightId === targetId;
        request = {
          request: [
            {
              deviceId: { uuid: targetId, internalId: { source } },
              categories: [
                { name: category, traits: [{ name: category, value: key === 'light_enabled' ? { boolean: value } : { number: value } }] },
              ],
            },
          ],
        };
        break;
      }
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
              deviceId: { uuid: resourceId, internalId: { source } },
              categories: [{ name: 'lockUnlock', traits: [{ name: 'isLocked', value: { boolean: value } }] }],
            },
          ],
        };
        break;
      }
      case 'active_sensor': {
        let sensor = resource;
        let parent;
        if (typeof value !== 'boolean') {
          break;
        }
        // The thermostat selects its built-in sensor directly. Remote sensors
        // resolve exactly one parent from this account's explicit sensor list.
        if (sensor?.metadata?.type === DEVICE_TYPE.THERMOSTAT && value === true) {
          if (temperature?.activeThermostatTemperatureSensors?.array === undefined) {
            break;
          }
          parent = sensor;
        } else {
          if (sensor?.metadata?.type !== DEVICE_TYPE.TEMPSENSOR || typeof sensor.structureId !== 'string') {
            break;
          }
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
                  entry?.properties?.properties?.some((property) => property.name === 'sensorId' && property.value?.text === sensor.id) ===
                  true,
              )
            );
          });
          if (parents.length !== 1) {
            break;
          }
          parent = parents[0];
          let selected = parent.traits
            ?.find((category) => category.name === 'temperatureSetting')
            ?.traits?.find((trait) => trait.name === 'activeThermostatTemperatureSensors')?.value?.array?.values;
          if (Array.isArray(selected) !== true || (value === false && selected.some((entry) => entry.text === sensor.id) !== true)) {
            break;
          }
          // Turning off a selected remote sensor restores the parent's built-in
          // sensor. Recheck ownership/selection if ingestion replaces either record.
          targetCurrent = () =>
            isCurrent() === true &&
            this.#isDeviceCurrent(resourceId, sensor) === true &&
            this.#isDeviceCurrent(parent.id, parent) === true &&
            this.resources
              .get(parent.id)
              ?.traits?.find((category) => category.name === 'temperatureSetting')
              ?.traits?.find((trait) => trait.name === 'knownThermostatTemperatureSensors')
              ?.value?.array?.values?.some(
                (entry) =>
                  entry.properties?.properties?.some((property) => property.name === 'sensorId' && property.value?.text === resourceId) ===
                  true,
              ) === true;
        }
        let source = parent.device?.id?.thirdPartyId?.idType;
        if (typeof source !== 'string' || source.trim() === '') {
          break;
        }
        targetId = parent.id;
        request = {
          request: [
            {
              deviceId: { uuid: targetId, internalId: { source } },
              categories: [
                {
                  name: 'temperatureSetting',
                  traits: [
                    {
                      name: 'activeThermostatTemperatureSensors',
                      value: { array: { values: [{ text: value === true ? sensor.id : targetId }] } },
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
            return { skip: true }; // The explicit normal-mode command exits Eco in the same operation.
          }
          requested = value.toLowerCase() === 'manual' ? 'eco' : value.toLowerCase() === 'off' && mode !== 'eco' ? mode : undefined;
        } else {
          requested = value.toLowerCase() === 'range' ? 'heatcool' : value.toLowerCase();
        }
        if (['heat', 'cool', 'heatcool', 'off', 'eco'].includes(requested) !== true || modes?.includes(requested) !== true) {
          break;
        }
        mode = requested;
        thermostatTraits = [{ name: 'mode', value: { text: mode } }];
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
        // Range writes send only requested properties, so a later write cannot resend
        // a stale companion threshold. Observed companions are used only for validation.
        if (mode === 'heatcool') {
          if (
            key === 'target_temperature' ||
            (key === 'target_temperature_high' && Object.hasOwn(values, 'target_temperature_low') === true)
          ) {
            if (key === 'target_temperature_high') {
              return { skip: true };
            }
            break;
          }
          let hasLow = Object.hasOwn(values, 'target_temperature_low');
          let hasHigh = Object.hasOwn(values, 'target_temperature_high');
          let low = hasLow === true ? values.target_temperature_low : temperature?.thermostatTemperatureSetpointLowC?.number;
          let high = hasHigh === true ? values.target_temperature_high : temperature?.thermostatTemperatureSetpointHighC?.number;
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
          // APK mapping uses unsuffixed write names; the observed Celsius names have a C suffix.
          thermostatTraits = [
            ...(hasLow === true ? [{ name: 'thermostatTemperatureSetpointLow', value: { number: low } }] : []),
            ...(hasHigh === true ? [{ name: 'thermostatTemperatureSetpointHigh', value: { number: high } }] : []),
          ];
        } else {
          if ((key === 'target_temperature_low' && mode !== 'heat') || (key === 'target_temperature_high' && mode !== 'cool')) {
            break;
          }
          // The generic setpoint applies to the device's current mode without
          // reasserting a mode from our potentially stale observed state.
          thermostatTraits = [{ name: 'thermostatTemperatureSetpoint', value: { number: value } }];
        }
        break;
      }
      case 'hot_water_boost_active': {
        let duration = value?.time === undefined ? 1800 : Number(value.time);
        if (
          resource?.metadata?.type !== DEVICE_TYPE.THERMOSTAT ||
          typeof value !== 'object' ||
          value === null ||
          Array.isArray(value) === true ||
          typeof value.state !== 'boolean' ||
          (value.state === true && HOTWATER_BOOST_TIMES.includes(duration) !== true)
        ) {
          break;
        }
        // Boost targets the associated thermostat; an explicit zero duration cancels it.
        service = 'EnergyService';
        method = 'UpdateHotWaterBoost';
        request = { deviceId: resourceId, duration: { seconds: value.state === true ? duration : 0 } };
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
        request = { deviceId: resourceId, runTimeSeconds: { value: value === true ? duration : 0 } };
        break;
      }
      case 'fan_duration':
      case 'fan_timer_speed':
        if (Object.hasOwn(values, 'fan_state') === true) {
          return { skip: true };
        }
        break;
      default:
        break;
    }
    if (thermostatTraits !== undefined) {
      // Mode and temperature properties share the APK's UpdateTraits routing.
      let source = resource?.device?.id?.thirdPartyId?.idType;
      if (typeof source === 'string' && source.trim() !== '') {
        // Generic write properties use the thermostat's unit, unlike the C-suffixed
        // read properties. Convert HomeKit Celsius without changing the device's unit.
        let fahrenheit = attributes?.find((property) => property.name === 'temperatureUnit')?.value?.text === 'F';
        let changes = thermostatTraits.map((trait) =>
          fahrenheit === true && typeof trait.value.number === 'number'
            ? { ...trait, value: { number: adjustTemperature(trait.value.number, 'C', 'F', false) } }
            : trait,
        );
        request = {
          request: [
            {
              deviceId: { uuid: resourceId, internalId: { source } },
              categories: [{ name: 'temperatureSetting', traits: changes }],
            },
          ],
        };
      }
    }
    return { request, service, method, targetId, targetCurrent, mode };
  }

  // A graph GET may start discovery. Device queries use this account's discovered
  // resources; location_weather uses the shared virtual weather field names.
  async get(resourceId = undefined, key = undefined) {
    if (resourceId === undefined) {
      if ((await this.connect()) !== true) {
        return;
      }
      return { source: DATA_SOURCE.HOMEGRAPH, value: structuredClone(this.#connection.graph) };
    }
    if (key === 'location_weather') {
      let connection = this.#connection;
      let token = this.#token();
      let home = this.homes.get(resourceId);
      let weather = await this.#getWeather(resourceId);
      if (weather !== undefined) {
        // Keep later home updates from replaying the initial weather reading.
        let accepted = await this.#commit(
          connection,
          () => {
            let homes = new Map(this.homes);
            homes.set(resourceId, { ...home, weather });
            let graph = {
              ...connection.graph,
              homes: connection.graph.homes.map((item) => (item.uuid === resourceId ? { ...item, weather } : item)),
            };
            return { homes, resources: this.resources, graph };
          },
          () => this.#connection === connection && this.homes.get(resourceId) === home && this.#token() === token,
        );
        return accepted === true ? weather : undefined;
      }
      return;
    }
    let id = resourceId;
    let resource = this.resources.get(id);
    if (resource === undefined || this.#connection === undefined || this.#token() === undefined) {
      throw new Error('HomeGraph device GET requires a discovered device');
    }
    let result = Object.hasOwn(resource?.value ?? {}, key) === true ? structuredClone(resource.value[key]) : undefined;

    // Camera queries require a committed Nest resource and this account's live transport.
    let cameraAvailable =
      typeof resource?.value === 'object' &&
      resource.value !== null &&
      resource.value.googleHome?.id?.thirdPartyId?.idType?.startsWith('nest') === true &&
      this.#connection.transport !== undefined;

    if (key === 'camera_snapshot') {
      let type = resource?.value?.googleHome?.type;

      if (cameraAvailable === true && ['action.devices.types.CAMERA', 'action.devices.types.DOORBELL'].includes(type) === true) {
        // The query owns its deadline and cancellation.
        let connection = this.#connection;
        let controller = new AbortController();
        let timer = undefined;
        (connection.snapshots ??= new Set()).add(controller);

        try {
          result = await Promise.race([
            this.#getCameraSnapshot(id, controller.signal),
            new Promise((_, reject) => {
              controller.signal.addEventListener('abort', () => reject(new Error('HomeGraph camera snapshot request failed')), {
                once: true,
              });
              timer = setTimeout(() => controller.abort(), SNAPSHOT_TIMEOUT);
            }),
          ]);
        } finally {
          clearTimeout(timer);
          controller.abort();
          connection.snapshots.delete(controller);
        }
      }
    } else if (key === 'camera_events') {
      result = [];
      if (
        cameraAvailable === true &&
        this.#connection.ready === true &&
        this.homes.has(resource.structureId) === true &&
        [DEVICE_TYPE.CAMERA, DEVICE_TYPE.DOORBELL].includes(resource.metadata.type) === true
      ) {
        result = await this.#getCameraEvents(id);
      }
    }

    return result;
  }

  // Weather belongs to a discovered home, or a home in the current discovery read.
  // Return only verified virtual weather fields; missing measurements stay unknown.
  async #getWeather(structureId, home = this.homes.get(structureId)) {
    let connection = this.#connection;
    let previous = this.homes.get(structureId);
    let previousCoordinates = structuredClone(previous?.address?.coordinates);
    let coordinates = home?.address?.coordinates;
    if (
      connection?.transport === undefined ||
      Number.isFinite(coordinates?.latitude) !== true ||
      Math.abs(coordinates.latitude) > 90 ||
      Number.isFinite(coordinates?.longitude) !== true ||
      Math.abs(coordinates.longitude) > 180
    ) {
      return;
    }
    let { latitude, longitude } = coordinates;
    let response = await this.#request(
      connection,
      'StructuresService',
      'GetOutdoorWeatherInfo',
      {
        structureId,
        latitude,
        longitude,
      },
      () => {
        // A moved or removed home must not receive weather for its previous location.
        return (
          this.homes.get(structureId) === previous &&
          isDeepStrictEqual(this.homes.get(structureId)?.address?.coordinates, previousCoordinates) === true
        );
      },
    );
    // A present FloatValue wrapper with an omitted scalar represents 0 °C.
    let temperature = response?.weather?.temperatureC;
    let value = temperature?.value ?? (temperature?.constructor === Object ? 0 : undefined);
    if (Number.isFinite(value) === true) {
      return {
        current_temperature: value,
        condition: typeof response.weather.description === 'string' ? response.weather.description : undefined,
      };
    }
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
      field5Proto: '',
    });
    return response === undefined ? undefined : structuredClone(response);
  }

  // Resolve and download this camera's current image. GET owns cancellation;
  // discovery/push processing continues to own the source cache.
  async #getCameraSnapshot(id, signal) {
    let connection = this.#connection;

    try {
      let device = structuredClone(this.resources.get(id).value.googleHome);
      let token = this.#token();
      let isCurrent = () => {
        let current = this.resources.get(id)?.value.googleHome;
        return (
          this.#connection === connection &&
          signal.aborted === false &&
          this.#token() === token &&
          isDeepStrictEqual(current?.id, device.id) === true &&
          isDeepStrictEqual(current?.otherIds, device.otherIds) === true
        );
      };
      let traits = this.resources.get(id).value.traits;
      let before = traits
        .find((category) => category.name === 'cameraStream')
        ?.traits?.find((trait) => trait.name === 'cameraStreamLiveViewImage')?.value;
      let oldTimestamp = before?.properties?.properties?.find((property) => property.name === 'timestampSeconds')?.value?.number;
      let { promise, resolve } = Promise.withResolvers();
      let accepted;
      let waiter = (updated) => {
        let image = updated
          ?.find((category) => category.name === 'cameraStream')
          ?.traits?.find((trait) => trait.name === 'cameraStreamLiveViewImage')?.value;
        let properties = image?.properties?.properties ?? [];
        let url = properties.find((property) => property.name === 'imageUrl')?.value?.text;
        let timestamp = properties.find((property) => property.name === 'timestampSeconds')?.value?.number;
        if (
          typeof url === 'string' &&
          url !== '' &&
          (Number.isFinite(timestamp) === true && Number.isFinite(oldTimestamp) === true
            ? timestamp > oldTimestamp
            : isDeepStrictEqual(image, before) !== true)
        ) {
          accepted = updated;
          resolve();
        }
      };
      let cancelWait = () => resolve();
      let waitTimer;
      (connection.snapshotWaiters ??= new Map()).set(waiter, id);
      signal.addEventListener('abort', cancelWait, { once: true });
      try {
        // Reading an image URL does not take a picture. Ask the camera to capture
        // one, with the waiter installed first because push can precede the reply.
        let response = await this.#request(
          connection,
          'HomeControlService',
          'UpdateTraits',
          {
            request: [
              {
                deviceId: { uuid: id, internalId: { source: device.id.thirdPartyId.idType } },
                categories: [{ name: 'cameraStream', traits: [{ name: 'cameraStreamLiveViewImage', value: { boolean: true } }] }],
              },
            ],
          },
          isCurrent,
          { timeout: 2000, retry: 1 },
        );
        if (response !== undefined && isCurrent() === true) {
          waiter(this.resources.get(id)?.traits);
          waitTimer = setTimeout(resolve, 2000);
          await promise;
          if (accepted === undefined && isCurrent() === true) {
            // Polling fallback: read this camera only, leaving discovery and the
            // committed source cache under their existing ingestion lifecycle.
            let refreshed = await this.#request(
              connection,
              'HomeControlService',
              'GetTraits',
              {
                deviceIds: [{ uuid: id }],
                reason: 'REASON_FETCH_CAMERA_STREAM_TRAIT',
              },
              isCurrent,
              { timeout: 1000, retry: 1 },
            );
            waiter(refreshed?.device?.find((entry) => entry.uuid?.value === id)?.category);
          }
        }
      } catch {
        // A failed capture can still use the camera's existing image reference.
      } finally {
        clearTimeout(waitTimer);
        signal.removeEventListener('abort', cancelWait);
        connection.snapshotWaiters.delete(waiter);
      }
      if (isCurrent() !== true) {
        return;
      }
      traits = accepted ?? this.resources.get(id).traits;
      let images = traits.find((category) => category.name === 'cameraStream')?.traits;
      // Migrated cameras may publish only the placeholder image reference.
      // Prefer a live capture; use the supplied fallback without constructing a URL.
      let imageUrl;
      for (let name of ['cameraStreamLiveViewImage', 'cameraStreamPlaceholderImage']) {
        let properties = images?.find((trait) => trait.name === name)?.value?.properties?.properties;
        imageUrl = properties?.find((property) => property.name === 'imageUrl')?.value?.text;
        if (typeof imageUrl === 'string' && imageUrl !== '') {
          break;
        }
      }
      if (typeof imageUrl !== 'string' || imageUrl === '') {
        return;
      }
      let url = new URL(imageUrl);
      let legacy = /^nexusapi-[a-z0-9-]+\.camera\.home\.(?:ft\.)?nest\.com$/.test(url.hostname) === true;
      let media = url.hostname === 'nest-camera-media.googleapis.com';
      let path =
        legacy === true
          ? /^\/resources\/([^/]+)\/live_image$/.exec(url.pathname)
          : /^\/download\/thumbnails\/(?:[A-Za-z0-9_-]+\/)+devices\/([^/]+)(?:\/id\/[^/]+)?$/.exec(url.pathname);
      let aliases = [
        device.id.googleUuid,
        ...(device.otherIds?.otherThirdPartyId ?? []).filter((alias) => alias.idType === 'PHX').map((alias) => alias.id),
      ];

      // Never forward credentials to arbitrary hosts, redirected URLs or another
      // camera's resource path. HomeGraph's PHX alias binds these URLs to the device.
      if (
        url.protocol !== 'https:' ||
        url.username !== '' ||
        url.password !== '' ||
        url.port !== '' ||
        url.hash !== '' ||
        (legacy !== true && media !== true) ||
        path === null ||
        aliases.includes(path[1]) !== true
      ) {
        throw new Error('Untrusted snapshot image reference');
      }

      let authorization = legacy === true ? 'Basic ' + (await this.#getOliveToken(connection, token, isCurrent)) : 'Bearer ' + token;
      if (isCurrent() !== true) {
        return;
      }
      let response = await fetchWrapper(fetchWrapper.GET, url.href, {
        headers: {
          Authorization: authorization,
          Referer: GOOGLE_HOME_REFERER + '/',
          Origin: GOOGLE_HOME_REFERER,
          'User-Agent': GOOGLE_HOME_USER_AGENT,
        },
        redirect: 'error',
        retry: 1,
        timeout: SNAPSHOT_TIMEOUT,
        signal,
      });
      if (Number(response.headers.get('content-length')) > SNAPSHOT_MAX_BYTES) {
        await response.body?.cancel();
        throw new Error('Snapshot exceeds image size limit');
      }

      // Bound the streamed body even when Content-Length is missing or inaccurate.
      let chunks = [];
      let size = 0;
      for await (let chunk of response.body) {
        size += chunk.length;
        if (size > SNAPSHOT_MAX_BYTES) {
          throw new Error('Snapshot exceeds image size limit');
        }
        chunks.push(chunk);
      }
      let buffer = Buffer.concat(chunks, size);
      // HomeKit expects JPEG snapshots; reject empty bodies and HTML/error responses.
      return isCurrent() === true && buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255 ? buffer : undefined;
    } catch {
      // HTTP errors can contain signed URLs or credentials; keep the public error fixed.
      throw new Error('HomeGraph camera snapshot request failed');
    }
  }

  // Nexus images require a Foyer-issued Nest credential. Cache it only for this
  // connection and OAuth identity, renewing before expiry and rejecting stale replies.
  async #getOliveToken(connection, token, isCurrent) {
    let cached = connection.oliveToken;
    if (cached?.oauth !== token || cached.expires <= Date.now()) {
      let result = await this.#request(connection, 'ClientOliveTokenService', 'GetOliveToken', {}, isCurrent);
      if (isCurrent() !== true) {
        return;
      }
      let duration = Number(result?.response?.validity?.seconds);
      let olive = result?.response?.token;
      if (typeof olive !== 'string' || olive.trim() === '' || Number.isFinite(duration) !== true || duration <= 0) {
        throw new Error('Snapshot credential unavailable');
      }
      cached = { oauth: token, token: olive, expires: Date.now() + Math.min(duration, 3600) * 1000 - 10000 };
      connection.oliveToken = cached;
    }
    return cached.token;
  }

  // One camera-scoped timeline read supplies detection tracks directly. Coalesce
  // overlapping polls and bound each attempt like protobuf camera history reads.
  async #getCameraEvents(id) {
    let connection = this.#connection;
    let resource = this.resources.get(id);
    let home = resource.structureId;
    let identity = structuredClone(resource.value.googleHome?.id);
    let token = this.#token();
    let isCurrent = () =>
      this.#connection === connection &&
      this.#token() === token &&
      this.resources.get(id)?.structureId === home &&
      isDeepStrictEqual(this.resources.get(id)?.value.googleHome?.id, identity) === true;
    let caches = (connection.cameraEvents ??= new Map());
    let read = caches.get(id);
    let now = Date.now();
    if (
      read === undefined ||
      read.token !== token ||
      read.home !== home ||
      isDeepStrictEqual(read.identity, identity) !== true ||
      (read.done === true && now - read.at >= POLL_INTERVAL)
    ) {
      read = { token, home, identity, at: now };
      let pending = read;
      caches.set(id, pending);
      pending.promise = this.#request(
        connection,
        'CameraService',
        'ListTimelinePeriods',
        {
          request: {
            deviceId: id,
            startTime: { seconds: Math.floor(now / 1000) - 60 },
            endTime: { seconds: Math.floor(now / 1000) },
          },
          field2: 1,
          strongRead: true,
        },
        () => isCurrent() === true && caches.get(id) === pending,
        { timeout: 4000, retry: 1 },
      )
        .catch((error) => {
          // A failed read must not prevent the next scheduled poll from retrying.
          if (caches.get(id) === pending) {
            caches.delete(id);
          }
          throw error;
        })
        .finally(() => {
          pending.done = true;
        });
    }
    let response;
    try {
      response = await read.promise;
    } catch (error) {
      // Match protobuf's expected history-timeout handling without hiding other failures.
      if (error.status === 4) {
        return [];
      }
      throw error;
    }
    if (response === undefined || isCurrent() !== true || caches.get(id) !== read) {
      return [];
    }
    let events = new Map();
    now = Date.now();
    for (let period of (response.periods ?? []).slice(0, CAMERA_HISTORY_LIMIT)) {
      let session = period.recorded?.session ?? period.noVideo?.session ?? period.unknown?.session;
      for (let track of (session?.tracks ?? []).slice(0, CAMERA_HISTORY_LIMIT)) {
        let start = Number(track.startTime?.seconds) * 1000 + Number(track.startTime?.nanos ?? 0) / 1e6;
        let end = track.endTime === undefined ? start : Number(track.endTime.seconds) * 1000 + Number(track.endTime.nanos ?? 0) / 1e6;
        if (
          typeof track.trackId !== 'string' ||
          track.trackId === '' ||
          track.trackId.length > 512 ||
          Number.isFinite(start) !== true ||
          Number.isFinite(end) !== true ||
          start < 0 ||
          end < start ||
          end < now - CAMERA_EVENT_WINDOW ||
          end > now + CAMERA_EVENT_WINDOW
        ) {
          continue;
        }
        // Keep the event vocabulary and millisecond timestamps used by protobuf
        // cameras. Session media padding must not become the detection timestamp.
        let types = [
          ...new Set(
            (track.eventTypes ?? [])
              .map((type) => {
                let aliases = {
                  EVENT_TYPE_FACE_FAMILIAR: 'face',
                  EVENT_TYPE_FACE_UNFAMILIAR: 'unfamiliar-face',
                  EVENT_TYPE_MOVING_VEHICLE: 'vehicle',
                  EVENT_TYPE_ANIMAL_OTHER: 'animal',
                };
                return (
                  aliases[type] ??
                  (typeof type === 'string' && type.startsWith('EVENT_TYPE_') === true
                    ? type.slice(11).toLowerCase().replaceAll('_', '-')
                    : undefined)
                );
              })
              .filter((type) => type !== undefined && type !== 'unspecified'),
          ),
        ];
        if (types.length > 0 && (events.get(track.trackId)?.end_time ?? -1) <= end) {
          events.set(track.trackId, {
            id: track.trackId,
            playback_time: start,
            start_time: start,
            end_time: end,
            types,
            zone_ids: (track.activityZones ?? [])
              .map((zone) => zone.zoneId)
              .filter((zone) => typeof zone === 'string' && zone.length > 0 && zone.length <= 128),
          });
        }
      }
    }
    return [...events.values()].sort((a, b) => b.start_time - a.start_time);
  }

  // Push merges partial categories; full reads replace absent fields. Structured
  // values remain atomic, and older image timestamps never overwrite newer ones.
  #mergeTraits(previous, updates, replace = false) {
    if (Array.isArray(updates) !== true || updates.length > 128) {
      throw new Error('Invalid HomeGraph push categories');
    }
    // Untouched categories are immutable here. Copy only updated categories and
    // incoming trait values so rejected commits cannot mutate the accepted cache.
    let prior = new Map(previous.map((category) => [category.name, category]));
    let categories = replace === true ? new Map() : prior;
    for (let category of updates) {
      if (
        typeof category?.name !== 'string' ||
        category.name.length === 0 ||
        category.name.length > 128 ||
        Array.isArray(category.traits ?? []) !== true ||
        (category.traits?.length ?? 0) > 1024
      ) {
        throw new Error('Invalid HomeGraph push category');
      }
      let existing = categories.get(category.name);
      let traits = new Map((existing?.traits ?? []).map((trait) => [trait.name, trait]));
      let { traits: incomingTraits, ...details } = category;
      for (let trait of incomingTraits ?? []) {
        if (typeof trait?.name !== 'string' || trait.name.length === 0 || trait.name.length > 128 || trait.value === undefined) {
          throw new Error('Invalid HomeGraph push trait');
        }
        // Camera references can be replayed at registration. An older capture must
        // not replace a newer URL already obtained through GetTraits or push.
        if (category.name === 'cameraStream' && trait.name === 'cameraStreamLiveViewImage') {
          let old = traits.get(trait.name) ?? prior.get(category.name)?.traits?.find((entry) => entry.name === trait.name);
          let before = old?.value?.properties?.properties?.find((item) => item.name === 'timestampSeconds')?.value?.number;
          let after = trait.value?.properties?.properties?.find((item) => item.name === 'timestampSeconds')?.value?.number;
          if (Number.isFinite(before) === true && Number.isFinite(after) === true && after < before) {
            traits.set(trait.name, old);
            continue;
          }
        }
        traits.set(trait.name, structuredClone(trait));
      }
      if (traits.size > 1024) {
        throw new Error('HomeGraph push trait limit exceeded');
      }
      categories.set(category.name, { ...existing, ...structuredClone(details), traits: [...traits.values()] });
    }
    if (categories.size > 128) {
      throw new Error('HomeGraph push category limit exceeded');
    }
    return [...categories.values()];
  }

  // Publish each named Foyer trait as an ordinary top-level bucket, just as Observe
  // publishes trait labels. System's existing shallow merge then preserves siblings.
  // Structured trait values and lists remain atomic; only the transport envelope is flattened.
  // The API's own resource cache retains the original category/trait representation.
  #notificationValue(value) {
    let { traits, ...result } = value;
    for (let category of traits ?? []) {
      for (let trait of category.traits ?? []) {
        result[category.name + '.' + trait.name] = trait.value;
      }
      for (let property of category.attributes?.properties ?? []) {
        result['attributes.' + category.name + '.' + property.name] = property.value;
      }
    }
    return result;
  }

  // Preferences enrich accepted discovery in the background. A single pass
  // prevents duplicate reads; each result merges into the latest device state.
  #refreshDeviceInformation(connection) {
    if (connection.technicalPending !== undefined) {
      return;
    }
    let token = this.#token();
    let isCurrent = () => this.#connection === connection && this.#token() === token;
    connection.technicalPending = (async () => {
      for (let resource of this.resources.values()) {
        if (isCurrent() !== true) {
          return;
        }
        let model = resource.device.hardware?.model;
        if (
          ((resource.metadata.type === DEVICE_TYPE.TEMPSENSOR && model === 'Nest Temperature Sensor') ||
            (resource.metadata.type === DEVICE_TYPE.THERMOSTAT && typeof model === 'string') ||
            (resource.metadata.type === DEVICE_TYPE.PROTECT && model === 'Nest Protect') ||
            (resource.metadata.type === DEVICE_TYPE.LOCK && typeof model === 'string') ||
            [DEVICE_TYPE.CAMERA, DEVICE_TYPE.DOORBELL, DEVICE_TYPE.HEATLINK].includes(resource.metadata.type) === true) !== true ||
          resource.value.technicalInformation !== undefined ||
          typeof resource.structureId !== 'string' ||
          (connection.technicalRetry?.get(resource.id) ?? 0) > Date.now()
        ) {
          continue;
        }
        try {
          let response = await this.#request(
            connection,
            'UsersService',
            'GetUserPreferences',
            {
              structureId: resource.structureId,
              pageCode: [resource.metadata.type === DEVICE_TYPE.THERMOSTAT ? 18 : resource.metadata.type === DEVICE_TYPE.LOCK ? 11 : 25],
              uuid: { value: resource.id },
              field5Proto: '',
            },
            () => this.#isDeviceCurrent(resource.id, resource),
          );
          if (response === undefined || isCurrent() !== true || this.#isDeviceCurrent(resource.id, resource) !== true) {
            continue;
          }
          let returnedId = response.item?.itemRef?.associatedId?.value;
          if (returnedId !== undefined && returnedId !== resource.id) {
            throw new Error('Unexpected technical-information device');
          }
          let details = this.#readDeviceInformation(response);
          if (resource.metadata.type !== DEVICE_TYPE.CAMERA) {
            delete details.floodlightId;
          }
          if (details.technicalInformation !== undefined) {
            await this.#commit(
              connection,
              () => {
                let current = this.resources.get(resource.id);
                let resources = new Map(this.resources);
                resources.set(resource.id, { ...current, value: { ...current.value, ...details } });
                return { homes: this.homes, resources, graph: connection.graph, id: resource.id };
              },
              () => isCurrent() === true && this.#isDeviceCurrent(resource.id, resource) === true,
            );
            connection.technicalRetry?.delete(resource.id);
            continue;
          }
        } catch {
          if (isCurrent() === true) {
            this.#options.log?.debug?.('HomeGraph device technical information unavailable; retrying later');
          }
        }
        if (isCurrent() === true && this.#isDeviceCurrent(resource.id, resource) === true) {
          (connection.technicalRetry ??= new Map()).set(resource.id, Date.now() + 60000);
        }
      }
    })().finally(() => {
      connection.technicalPending = undefined;
    });
  }

  // Preference item 238 (1360 on other settings pages) contains the captured HTML
  // Technical Information block. Decode physical identity, a technical model code and
  // the floodlight association only; never publish settings pages or app links.
  #readDeviceInformation(response) {
    let details = {};
    let pending = [response?.item];
    let visited = 0;
    while (pending.length > 0 && ++visited <= 4096) {
      let item = pending.pop();
      if (item === undefined) {
        continue;
      }
      // The associated ID belongs to the floodlight settings entry, not the camera's
      // technical-information item. Retain it independently of physical identity.
      if (item.itemRef?.id === 1118 && typeof item.itemRef.associatedId?.value === 'string' && item.itemRef.associatedId.value !== '') {
        details.floodlightId = item.itemRef.associatedId.value;
      }
      if (
        details.technicalInformation === undefined &&
        [238, 1360].includes(item.itemRef?.id) === true &&
        typeof item.subtitle === 'string' &&
        item.subtitle.length <= 65536
      ) {
        // Google emits ASCII and full-width label separators; identity values retain the same validation.
        let serial = item.subtitle.match(/(?:^|<br\s*\/?>)\s*Serial (?:no\.?|number)\s*[:：]\s*([a-z0-9]{1,128})\s*(?=<br\s*\/?>|$)/i)?.[1];
        if (serial !== undefined) {
          // Model codes distinguish variants that share a generic hardware display name.
          let model = item.subtitle.match(/(?:^|<br\s*\/?>)\s*Model\s*[:：]\s*(NEST_[A-Z0-9_]+\.\d{1,4})\s*(?=<br\s*\/?>|$)/)?.[1];
          details.technicalInformation = { serialNumber: serial.toUpperCase(), ...(model !== undefined ? { model } : {}) };
        }
      }
      for (let child of item.subitems ?? []) {
        if (pending.length >= 4096) {
          return {};
        }
        pending.push(child);
      }
    }
    return details;
  }
}
