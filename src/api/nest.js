// NestAPI
// Part of homebridge-nest-accfactory
//
// Handles Nest REST subscriptions, queries and supported device commands for one
// account, using credentials from the shared AccountSession.
//
// Entry points:
// - connect() ensures account authentication and starts resource ingestion
// - disconnect() retires this API without logging the shared account out
// - get(resourceId, key, values = {}) reads source fields, snapshots, events or weather
// - set(resourceId, values) sends supported Nest device settings
//
// Responsibilities:
// - Discover buckets and own the revision state used by incremental subscriptions
// - Stage partial updates, resource removals and discovered home identifiers
// - Enrich camera properties and weather while retaining available cached fallbacks
// - Build authenticated snapshot URLs and download image buffers
// - Maintain source resources and optionally notify consumers of committed changes
// - Own subscription retries and reject callbacks from retired runs
//
// Ownership:
// - AccountSession owns login, token refresh and authentication retry scheduling
// - Successful token refresh preserves polling and its acknowledged bucket revisions
// - A new polling run starts with fresh discovery and an empty revision map
// - This client owns source resources; System maintains its combined HomeKit view
// - connect() starts ingestion without a consumer; onData optionally reports committed changes
// - Camera media streaming belongs to the separate camera transport modules
//
// Code version 2026.10.30
// Mark Hulskamp

// Define nodejs module requirements
import { setTimeout, clearTimeout } from 'node:timers';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';

// Define our modules
import { fetchWrapper } from '../fetchWrapper.js';
import { isNumeric, adjustTemperature } from '../utils.js';

// Define constants
import { DATA_SOURCE, NEST_API_BUCKETS, USER_AGENT } from '../consts.js';

const SNAPSHOT_TIMEOUT = 7000;
const SNAPSHOT_FETCH_TIMEOUT = 3000;

const API_STREAM_LOOP_INTERVAL = 1000;
const API_STREAM_RETRY_INITIAL = 5000;
const API_STREAM_RETRY_MAX = 60000;

export default class NestAPI {
  resources = new Map(); // Source resource records maintained by this client.
  #options = {}; // Shared authentication, logging and optional change notification
  #subscription = undefined; // Requested polling lifecycle, including login and recovery.
  #buckets = new Map(); // Acknowledged bucket revisions used by incremental subscriptions.
  #timer = undefined;
  #retryDelay = undefined;

  // Authentication is shared; resource state and subscription identity are local.
  // onData is optional. Consumers may return false or reject to retry delivery;
  // source data remains available through resources and get() independently.
  constructor(options = {}) {
    this.#options = { session: options.session, uuid: options.uuid, log: options.log, onData: options.onData };

    options.session?.on('authorised', () => {
      if (this.#subscription !== undefined) {
        this.connect().catch((error) => options.log?.debug?.('Unable to connect nest API: %s', String(error)));
      }
    });
    options.session?.on('disconnect', (refreshing) => {
      if (refreshing !== true) {
        this.#stop(true);
      }
    });
  }

  // Authenticate through the shared session, then start this API once.
  // Returning means startup was requested; resource data arrives through onData.
  async connect() {
    // Allocate the requested connection before login. An explicit disconnect or
    // a replaced run makes this particular login completion stale.
    let subscription = (this.#subscription ??= {});
    let authorised = await this.#options.session?.connect();
    if (authorised !== true) {
      throw new Error('Unable to authenticate account');
    }

    if (this.#subscription !== subscription) {
      return;
    }

    // Start one subscription loop for this authorised account.
    if (subscription.request !== undefined || this.#options.session?.account?.authorised !== true) {
      return;
    }

    // The authenticated run begins with full discovery. Repeated connect calls
    // retain the current run's request and acknowledged bucket revisions.
    this.#buckets.clear();

    return await this.#subscribe();
  }

  // An explicit disconnect also prevents session refresh from reopening this API.
  // The other API can continue using the account and its refresh scheduler.
  disconnect() {
    this.#stop();
  }

  #stop(reconnect = false) {
    // Recovery retains a fresh pending connection; explicit disconnect clears it.
    // Both invalidate replies and queued work belonging to the previous run.
    this.#subscription = reconnect === true && this.#subscription !== undefined ? {} : undefined;
    this.#buckets.clear();
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#retryDelay = undefined;
  }

  async #subscribe() {
    let { log, session } = this.#options;
    let account = session.account;
    let subscription = this.#subscription;
    let buckets = this.#buckets;

    // Account identity and this exact run must both survive asynchronous work.
    let isCurrent = () => subscription !== undefined && this.#subscription === subscription && account.authorised === true;
    let subscribeFailed = false;

    // A scheduled retry can outlive disconnect or account shutdown.
    if (isCurrent() !== true) {
      return;
    }

    // app_launch discovers buckets initially and after a topology change. Normal
    // subscribe requests resume from revisions acknowledged during this run.
    let subscribeJSONData = undefined;

    // An empty revision map always requires full account discovery.
    if (buckets.size === 0) {
      log?.debug?.('Starting Nest API subscribe for account "%s"', account.name);
      subscribeJSONData = { known_bucket_types: NEST_API_BUCKETS, known_bucket_versions: [] };
    } else {
      subscribeJSONData = {
        objects: Array.from(buckets, ([object_key, revision]) => ({ object_key, ...revision })),
      };
    }

    // Keep the request promise between polls so connect() can recognise a
    // running loop without a separate connection-enabled flag.
    subscription.request = fetchWrapper(
      'post',
      subscribeJSONData?.objects !== undefined
        ? new URL('/v5/subscribe', account.transport_url).href
        : new URL('/api/0.1/user/' + account.userID + '/app_launch', 'https://' + account.restAPIHost).href,
      {
        headers: {
          Referer: 'https://' + account.referer,
          Origin: 'https://' + account.referer,
          Authorization: 'Basic ' + account.token,
          Connection: 'keep-alive',
          'User-Agent': USER_AGENT,
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Site': 'same-origin',
          'X-nl-protocol-version': 1,
          'Content-Type': 'application/json',
        },
        retry: 3,
      },
      subscribeJSONData,
    )
      .then((response) => response.json())
      .then(async (data) => {
        if (isCurrent() !== true) {
          return;
        }

        let changes = [];

        // One reply may change the same bucket more than once. Later entries
        // must see earlier changes/removals before System commits the whole batch.
        let staged = new Map();
        // Keep one unacknowledged notification per run. Source data is already
        // committed, so retries must retain removals that no longer exist in the cache.
        if (subscription.pending !== undefined) {
          let accepted = await this.#options.onData?.(subscription.pending);
          if (isCurrent() !== true) {
            return;
          }
          if (accepted === false) {
            throw new Error('Nest resource batch was not accepted');
          }
          subscription.pending = undefined;
        }

        let getResource = (id) => (staged.has(id) === true ? staged.get(id) : this.resources.get(id));
        let objects = [];

        if (Array.isArray(data?.updated_buckets) === true) {
          // Full data read response
          objects = data.updated_buckets;
        }

        if (Array.isArray(data?.objects) === true) {
          // Incremental subscribe update response
          objects = data.objects;
        }

        for (let object of objects) {
          if (isCurrent() !== true) {
            return;
          }

          let objectKey = object?.object_key;

          // The server may return unrequested buckets; keep them out of the cache and later subscriptions.
          if (typeof objectKey !== 'string' || NEST_API_BUCKETS.includes(objectKey.split('.')[0]) !== true) {
            continue;
          }

          let incomingValue = typeof object?.value === 'object' && object.value !== null ? { ...object.value } : {};
          let existingEntry = getResource(objectKey);
          let existingValue = typeof existingEntry?.value === 'object' && existingEntry.value !== null ? existingEntry.value : {};
          let changedFields = new Set();

          if ((objectKey?.trim?.() ?? '') === '') {
            continue;
          }

          // These field names select which device mappings need recalculation.
          // A shallow comparison may include unchanged nested values; HomeKitDevice
          // compares the final device state before publishing characteristic changes.
          Object.keys(incomingValue).forEach((field) => {
            if (existingValue[field] !== incomingValue[field]) {
              changedFields.add(field);
            }
          });

          if (objectKey.startsWith('structure.') === true) {
            // Add weather data based on the structure location details
            let weatherData = await this.#getWeather(objectKey, incomingValue.postal_code, incomingValue.country_code);

            if (isCurrent() !== true) {
              return;
            }

            if (weatherData !== undefined) {
              incomingValue.weather = weatherData;
              changedFields.add('weather');
            }

            // Swarm removal evicts raw child data. Accessory removal is reported
            // separately by the buckets topology update, which may arrive later.
            if (typeof existingValue?.swarm === 'object' && Array.isArray(incomingValue?.swarm) === true) {
              let newSwarmSet = new Set(incomingValue.swarm);

              existingValue.swarm.forEach((childObjectKey) => {
                if (newSwarmSet.has(childObjectKey) === false) {
                  changes.push({ resourceId: childObjectKey, remove: true, notify: false });
                  staged.set(childObjectKey, undefined);
                }
              });
            }
          }

          if (objectKey.startsWith('quartz.') === true) {
            // Retrieve additional camera/doorbell properties
            let properties = await this.#getCameraProperties(objectKey);

            if (isCurrent() !== true) {
              return;
            }

            // A failed property refresh must not erase previously known camera
            // controls while the normal bucket update is still usable.
            incomingValue.properties =
              typeof properties === 'object' && properties.constructor === Object
                ? properties
                : typeof existingValue?.properties === 'object' && existingValue.properties.constructor === Object
                  ? existingValue.properties
                  : {};

            changedFields.add('properties');
          }

          if (objectKey.startsWith('buckets.') === true) {
            if (
              typeof existingEntry === 'object' &&
              Array.isArray(existingValue?.buckets) === true &&
              Array.isArray(incomingValue?.buckets) === true
            ) {
              // Compare previous vs incoming buckets list to detect topology changes
              let newBucketsSet = new Set(incomingValue.buckets);

              // A removed topology entry can invalidate related device data.
              // Queue its removal and rediscover buckets on the next request.
              for (let childObjectKey of existingValue.buckets) {
                if (newBucketsSet.has(childObjectKey) === false) {
                  // Replace the cursor so this reply cannot refill it after
                  // acknowledgement. The next poll must rediscover the account.
                  if (this.#buckets === buckets) {
                    this.#buckets = new Map();
                  }

                  changes.push({
                    resourceId: childObjectKey,
                    remove: true,
                    notify:
                      childObjectKey.startsWith('structure.') === true ||
                      childObjectKey.startsWith('topaz.') === true ||
                      childObjectKey.startsWith('device.') === true ||
                      childObjectKey.startsWith('kryptonite.') === true ||
                      childObjectKey.startsWith('quartz.') === true,
                  });
                  staged.set(childObjectKey, undefined);
                }
              }
            }
          }

          // Stage revisions alongside the reply-local values. They become the
          // next subscription cursor after optional consumer acknowledgement.
          changes.push({
            resourceId: objectKey,
            value: incomingValue,
            fields: changedFields,
            home:
              objectKey.startsWith('structure.') === true ? { name: incomingValue.name, values: { nest_home_uuid: objectKey } } : undefined,
          });
          staged.set(objectKey, {
            value: { ...existingValue, ...incomingValue },
            revision: { object_revision: object.object_revision, object_timestamp: object.object_timestamp },
          });
        }

        if (isCurrent() !== true) {
          return;
        }

        // Commit source state before notifying consumers. Standalone clients do
        // not require System or a listener to maintain discovery and command data.
        for (let change of changes) {
          if (change.remove === true) {
            this.resources.delete(change.resourceId);
          } else {
            this.resources.set(change.resourceId, {
              source: DATA_SOURCE.NEST,
              value: { ...this.resources.get(change.resourceId)?.value, ...change.value },
            });
          }
        }

        // A failed notification must not advance the cursor past data a consumer
        // has not accepted. Recheck the run after the acknowledgement so late commits cannot
        // populate a replacement subscription's revision map.
        let notification = { source: DATA_SOURCE.NEST, changes, isCurrent };
        try {
          let committed = await this.#options.onData?.(notification);
          if (isCurrent() !== true) {
            return;
          }
          if (committed === false) {
            throw new Error('Nest resource batch was not committed');
          }
        } catch (error) {
          if (changes.length > 0) {
            subscription.pending = notification;
          }
          throw error;
        }

        // Only acknowledge revisions if topology changes did not invalidate
        // this reply's cursor while its resources were being processed.
        if (this.#buckets === buckets) {
          for (let [objectKey, entry] of staged) {
            if (entry === undefined) {
              buckets.delete(objectKey);
            } else {
              buckets.set(objectKey, entry.revision);
            }
          }
        }

        this.#retryDelay = undefined;
      })
      .catch((error) => {
        if (isCurrent() !== true) {
          return;
        }

        subscribeFailed = true;

        // fetchWrapper failures may carry a code or HTTP status. Authentication
        // failures restart the account; other failures use this API's own backoff.
        let statusCode =
          error?.code !== undefined && error?.code !== null
            ? error.code
            : error?.status !== undefined && error?.status !== null
              ? error.status
              : undefined;

        // If we get a 401 Unauthorized or 403 Forbidden, wake the account
        // lifecycle so it can re-authorise and reschedule itself.
        if ((statusCode === 401 || statusCode === 403) && isCurrent() === true) {
          log?.debug?.('Account "%s" is no longer authorised with the Nest API, will attempt to reconnect', account.name);
          this.#options.session?.markUnauthorised('nest-api-' + statusCode);

          return;
        }

        // Log unexpected errors (excluding timeouts) for debugging
        if (
          error?.cause === undefined ||
          (error.cause?.message?.toUpperCase?.()?.includes('TIMEOUT') === false &&
            error.cause?.code?.toUpperCase?.()?.includes('TIMEOUT') === false)
        ) {
          log?.debug?.(
            'Nest API had an error performing subscription with account "%s". Error was "%s"',
            account.name,
            typeof error?.message === 'string' ? error.message : String(error),
          );
        }
      })
      .finally(() => {
        // Recheck the run after all awaited work. A stopped subscription must
        // neither install a retry timer nor interfere with its replacement.
        if (isCurrent() === true) {
          let subscribeDelay = API_STREAM_LOOP_INTERVAL;

          if (subscribeFailed === true) {
            subscribeDelay =
              Number.isFinite(this.#retryDelay) === true && this.#retryDelay > 0
                ? Math.min(this.#retryDelay * 2, API_STREAM_RETRY_MAX)
                : API_STREAM_RETRY_INITIAL;

            this.#retryDelay = subscribeDelay;
          }

          clearTimeout(this.#timer);
          this.#timer = setTimeout(() => {
            this.#timer = undefined;
            if (isCurrent() === true) {
              this.#subscribe();
            }
          }, subscribeDelay);
        }
      });
  }

  // values contains Nest setting names, e.g. { ntp_green_led_enable: true }.
  // Success resolves without a value; SET does not mutate the committed cache.
  // AggregateError can mean partial cloud success; subscriptions reconcile actual state.
  async set(resourceId, values) {
    let account = this.#options.session?.account;

    // Reject malformed requests before resource lookup or network work.
    if (
      typeof resourceId !== 'string' ||
      resourceId.trim() === '' ||
      typeof values !== 'object' ||
      values === null ||
      Array.isArray(values) === true ||
      account?.authorised !== true
    ) {
      throw new Error('SET requires valid parameters and an authorised device account');
    }

    let resource = this.resources.get(resourceId);

    if (typeof resource !== 'object' || resource === null || resource.source !== DATA_SOURCE.NEST) {
      throw new Error('SET requires an available authorised device account');
    }

    // Cloud writes are independent and cannot be rolled back as a group. Attempt
    // later settings after a failure, then report any partial success to the caller.
    let failures = [];

    for (let [key, value] of Object.entries(values)) {
      try {
        // Commands consuming companion fields are built once, independent of
        // object property order. Their validation rejects invalid companions.
        if (
          (['fan_duration', 'fan_timer_speed'].includes(key) === true && Object.hasOwn(values, 'fan_state') === true) ||
          (key === 'target_humidity_humidifier' && Object.hasOwn(values, 'humidifier_state') === true) ||
          (key === 'target_humidity_dehumidifier' && Object.hasOwn(values, 'dehumidifier_state') === true)
        ) {
          continue;
        }

        let handled = false;

        // Recheck availability after earlier writes have yielded to subscription updates.
        // Cameras use their property endpoint; other devices use bucket MERGE operations.
        if (this.resources.get(resourceId)?.source === DATA_SOURCE.NEST) {
          let operation = this.#buildSetting(resourceId, key, value, values, resource);

          if (operation?.cameraProperties !== undefined) {
            let response = await fetchWrapper(
              fetchWrapper.POST,
              new URL('/api/dropcams.set_properties', 'https://webapi.' + account.cameraAPIHost).href,
              {
                headers: {
                  Referer: 'https://' + account.referer,
                  Origin: 'https://' + account.referer,
                  [account.cameraAuth.key]: account.cameraAuth.value + account.cameraAuth.token,
                  'Content-Type': 'application/x-www-form-urlencoded',
                  'User-Agent': USER_AGENT,
                  'Sec-Fetch-Mode': 'cors',
                  'Sec-Fetch-Site': 'same-origin',
                },
                retry: 3,
              },
              operation.cameraProperties,
            );

            let data = await response.json();

            if (data?.status !== 0) {
              throw new Error('Nest API camera update failed');
            }

            handled = true;
          } else if (operation !== undefined) {
            // Send supported bucket updates through the Nest transport.
            let response = await fetchWrapper(
              fetchWrapper.POST,
              new URL('/v5/put', account.transport_url).href,
              {
                headers: {
                  Referer: 'https://' + account.referer,
                  Origin: 'https://' + account.referer,
                  Authorization: 'Basic ' + account.token,
                  'User-Agent': USER_AGENT,
                  'Sec-Fetch-Mode': 'cors',
                  'Sec-Fetch-Site': 'same-origin',
                  'X-nl-protocol-version': 1,
                  'Content-Type': 'application/json',
                },
                retry: 3,
              },
              JSON.stringify({ objects: [operation] }),
            );
            let data = await response.json();

            if (Array.isArray(data?.objects) === false || data.objects.length === 0) {
              throw new Error('Nest API property update failed');
            }

            handled = true;
          }
        }

        // Unknown settings must reject: a successful no-op would let the caller
        // commit local state for a change that was never sent to the device.
        if (handled !== true) {
          throw new Error('Invalid or unsupported setting "' + key + '" for this device');
        }
      } catch (error) {
        failures.push(error);
        this.#options.log?.debug?.(
          'Failed processing set request for key "%s" on device uuid "%s". Error was "%s"',
          key,
          resourceId,
          typeof error?.message === 'string' ? error.message : String(error),
        );
      }
    }

    // Attempt every setting, then reject the request if any field failed so HomeKitDevice
    // does not commit the full local update. Subscription data reconciles successful cloud changes.
    if (failures.length > 0) {
      throw new AggregateError(failures, 'One or more device settings were rejected');
    }
  }

  // Construct camera form data ({ cameraProperties }) or a bucket MERGE operation
  // ({ object_key, op, value }) without changing the committed resource.
  // Related settings are combined here; set() owns request execution and failures.
  // Thermostat branches select both the payload and its owning bucket:
  // device for Eco, fan, display, hot water and humidity; shared for HVAC mode
  // and setpoints; structure for vacation mode. Sensor selection uses rcs_settings.
  // An invalid value or missing capability leaves setting undefined, which set() rejects.
  #buildSetting(resourceId, key, value, values, resource) {
    let device = resource.value ?? {};
    let objectKey = resourceId;
    let setting = undefined;
    let serial = resourceId.split('.')[1];

    if (resourceId.startsWith('quartz.') === true) {
      // Cameras use the property endpoint rather than the bucket MERGE schema.
      let property = undefined;
      switch (key) {
        case 'indoor_chime_enabled':
        case 'streaming_enabled':
        case 'audio_enabled':
          if (typeof value === 'boolean') {
            property = {
              indoor_chime_enabled: 'doorbell.indoor_chime.enabled',
              streaming_enabled: 'streaming.enabled',
              audio_enabled: 'audio.enabled',
            }[key];
          }
          break;

        case 'statusled_brightness':
          if (isNumeric(value, { type: 'integer', min: 0, max: 1 }) === true) {
            property = 'statusled.brightness';
          }
          break;

        case 'irled_enabled':
          if (typeof value === 'boolean') {
            // Keep device state boolean; Nest's property endpoint uses mode strings.
            property = 'irled.state';
            value = value === true ? 'auto_on' : 'always_off';
          }
          break;
      }

      if (property !== undefined) {
        return { cameraProperties: property + '=' + value + '&uuid=' + resourceId.trim().split('.')[1] };
      }
    } else if (resourceId.startsWith('device.') === true) {
      let shared = this.resources.get('shared.' + serial)?.value;
      switch (key) {
        case 'eco_mode':
          if (typeof value === 'string' && ['MANUAL', 'OFF'].includes(value.toUpperCase()) === true) {
            // Eco belongs to the device bucket. Returning to schedule restores the
            // thermostat's normal mode without overwriting its shared setpoints.
            setting = { eco: { mode: value.toUpperCase() === 'MANUAL' ? 'manual-eco' : 'schedule' } };
          }
          break;

        case 'target_temperature':
        case 'target_temperature_low':
        case 'target_temperature_high': {
          if (isNumeric(value) !== true) {
            break;
          }

          // REST setpoint writes use the shared bucket even while Eco mode is active.
          let mode = shared?.target_temperature_type?.toLowerCase?.();
          let heating = key === 'target_temperature_low' || (key === 'target_temperature' && mode === 'heat');
          let cooling = key === 'target_temperature_high' || (key === 'target_temperature' && mode === 'cool');
          if ((heating === true && shared?.can_heat === true) || (cooling === true && shared?.can_cool === true)) {
            objectKey = 'shared.' + serial;
            setting = { target_change_pending: true, [key]: Number(value) };
          }
          break;
        }

        case 'hvac_mode': {
          if (typeof value !== 'string' || ['OFF', 'HEAT', 'COOL', 'RANGE'].includes(value.toUpperCase()) !== true) {
            break;
          }

          // Off needs no heating/cooling capability; every enabled mode must match
          // the equipment flags before the shared mode is marked pending.
          let mode = value.toLowerCase();
          if (
            mode === 'off' ||
            (mode === 'heat' && shared?.can_heat === true) ||
            (mode === 'cool' && shared?.can_cool === true) ||
            (mode === 'range' && shared?.can_heat === true && shared?.can_cool === true)
          ) {
            objectKey = 'shared.' + serial;
            setting = { target_change_pending: true, target_temperature_type: mode };
          }
          break;
        }

        case 'fan_state':
          if (
            typeof value === 'boolean' &&
            device.has_fan === true &&
            isNumeric(values.fan_duration, { min: 0 }) === true &&
            (values.fan_timer_speed === undefined || isNumeric(values.fan_timer_speed, { type: 'integer', min: 0, max: 3 }) === true)
          ) {
            // fan_state owns the combined request. Nest expects an absolute expiry
            // in seconds, with zero cancelling the timer; speed zero maps to stage1.
            setting = {
              fan_state: value,
              fan_timer_timeout: value === true ? Math.floor(Date.now() / 1000) + Number(values.fan_duration) : 0,
            };
            if (values.fan_timer_speed !== undefined) {
              setting.fan_timer_speed = 'stage' + (Number(values.fan_timer_speed) || 1);
            }
          }
          break;

        case 'fan_timer_speed':
          if (device.has_fan === true && isNumeric(value, { type: 'integer', min: 0, max: 3 }) === true) {
            // A standalone speed change leaves the current fan timer untouched.
            setting = { fan_timer_speed: 'stage' + (Number(value) || 1) };
          }
          break;

        case 'temperature_lock':
          if (typeof value === 'boolean') {
            setting = { temperature_lock: value };
          }
          break;

        case 'temperature_scale':
          if (typeof value === 'string' && ['C', 'F'].includes(value.toUpperCase()) === true) {
            setting = { temperature_scale: value.toUpperCase() };
          }
          break;

        case 'hot_water_boost_active':
          if (
            typeof value === 'object' &&
            value !== null &&
            typeof value.state === 'boolean' &&
            device.has_hot_water_control === true &&
            (value.time === undefined || isNumeric(value.time, { min: 0 }) === true)
          ) {
            // Like the fan timer, boost uses an absolute expiry; omitted duration
            // means 30 minutes and disabling boost clears the expiry.
            let seconds = value.time === undefined ? 1800 : Number(value.time);
            setting = { hot_water_boost_time_to_end: value.state === true ? Math.floor(Date.now() / 1000) + seconds : 0 };
          }
          break;

        case 'hot_water_temperature':
          if (isNumeric(value) === true && device.has_hot_water_temperature === true) {
            setting = { hot_water_temperature: Number(value) };
          }
          break;

        case 'humidifier_state':
        case 'dehumidifier_state':
        case 'target_humidity_humidifier':
        case 'target_humidity_dehumidifier': {
          // Both equipment types map to Nest's generic humidity fields. When state
          // and target arrive together, the state branch owns one combined write.
          let humidifier = ['humidifier_state', 'target_humidity_humidifier'].includes(key) === true;
          let stateKey = humidifier === true ? 'humidifier_state' : 'dehumidifier_state';
          let targetKey = humidifier === true ? 'target_humidity_humidifier' : 'target_humidity_dehumidifier';
          if (device[humidifier === true ? 'has_humidifier' : 'has_dehumidifier'] === true) {
            if (
              key === stateKey &&
              typeof value === 'boolean' &&
              (values[targetKey] === undefined || isNumeric(values[targetKey], { min: 0, max: 100 }) === true)
            ) {
              setting = { target_humidity_enabled: value };
              if (values[targetKey] !== undefined) {
                setting.target_humidity = Number(values[targetKey]);
              }
            } else if (key === targetKey && isNumeric(value, { min: 0, max: 100 }) === true) {
              setting = { target_humidity: Number(value) };
            }
          }
          break;
        }

        case 'vacation_mode':
          if (typeof value === 'boolean') {
            // The device link identifies the owning structure; never write this
            // household-wide setting onto the thermostat's own bucket.
            let structure = this.resources.get('link.' + serial)?.value?.structure;
            if (typeof structure === 'string' && this.resources.get(structure)?.source === DATA_SOURCE.NEST) {
              objectKey = structure;
              setting = { vacation_mode: value };
            }
          }
          break;
      }
    } else if (resourceId.startsWith('kryptonite.') === true && key === 'active_sensor' && typeof value === 'boolean') {
      // RCS selection is owned by the thermostat settings bucket. Use only this
      // client's discovered buckets, and verify the sensor belongs to that parent.
      let parentId = device.associated_thermostat;
      let settingsId = typeof parentId === 'string' ? 'rcs_settings.' + parentId.split('.')[1] : undefined;
      if (settingsId === undefined) {
        settingsId = Array.from(this.#buckets.keys()).find(
          (id) =>
            id.startsWith('rcs_settings.') === true && this.resources.get(id)?.value?.associated_rcs_sensors?.includes(resourceId) === true,
        );
      }
      let settings = settingsId === undefined ? undefined : this.resources.get(settingsId)?.value;
      if (settings?.associated_rcs_sensors?.includes(resourceId) === true) {
        objectKey = settingsId;
        setting =
          value === true
            ? { active_rcs_sensors: [resourceId], rcs_control_setting: 'OVERRIDE' }
            : { active_rcs_sensors: [], rcs_control_setting: 'OFF' };
      }
    } else if (resourceId.startsWith('topaz.') === true && key === 'ntp_green_led_enable' && typeof value === 'boolean') {
      // Protect's night-time status light is stored directly on its topaz bucket.
      setting = { ntp_green_led_enable: value };
    }

    return setting === undefined ? undefined : { object_key: objectKey, op: 'MERGE', value: setting };
  }

  // Returns the query value directly: camera_snapshot -> Buffer/undefined,
  // camera_events -> array, location_weather -> weather object/undefined.
  // Weather accepts { location: { postal_code, country_code } }; omission uses cached location.
  // Invalid input/account/resource rejects; an unknown key on an available resource returns undefined.
  async get(resourceId, key, values = {}) {
    let account = this.#options.session?.account;

    // Validate the public request before any resource lookup or network work.
    if (
      typeof resourceId !== 'string' ||
      resourceId.trim() === '' ||
      typeof key !== 'string' ||
      key.trim() === '' ||
      typeof values !== 'object' ||
      values === null ||
      Array.isArray(values) === true ||
      account?.authorised !== true
    ) {
      throw new Error('GET requires valid query parameters and an authorised account');
    }

    let resource = this.resources.get(resourceId);

    // System can enrich a Google location before its structure has been committed.
    let explicitLocation = key === 'location_weather' && typeof values.location === 'object' && values.location !== null;

    if ((typeof resource !== 'object' || resource === null) && explicitLocation !== true) {
      throw new Error('GET requires an available resource or an explicit weather location');
    }

    let result = Object.hasOwn(resource?.value ?? {}, key) === true ? structuredClone(resource.value[key]) : undefined;
    let endpoint = resource?.value?.nexus_api_http_server_url;

    // Both camera queries require the same Nest source endpoint and credentials.
    let cameraAvailable =
      resourceId.startsWith('quartz.') === true &&
      (endpoint?.trim?.() ?? '') !== '' &&
      (account.referer ?? '') !== '' &&
      (account.cameraAPIHost ?? '') !== '' &&
      (account.cameraAuth?.key ?? '') !== '' &&
      (account.cameraAuth?.value ?? '') !== '' &&
      (account.cameraAuth?.token ?? '') !== '';

    if (key === 'camera_snapshot') {
      if (cameraAvailable === true) {
        // Bound the whole query, including an image request that never completes.
        let timer = undefined;
        try {
          result = await Promise.race([
            this.#getCameraSnapshot(resourceId, endpoint),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error('Snapshot request timeout')), SNAPSHOT_TIMEOUT);
            }),
          ]);
        } finally {
          // A completed image request no longer needs its overall deadline.
          clearTimeout(timer);
        }
      }
    } else if (key === 'camera_events') {
      result = [];
      if (cameraAvailable === true) {
        result = await this.#getCameraEvents(resourceId, endpoint);
      }
    } else if (key === 'location_weather') {
      let weatherLocation = values.location ?? resource?.value?.weather;
      result = await this.#getWeather(resourceId, weatherLocation?.postal_code, weatherLocation?.country_code);
    }

    return result;
  }

  async #getCameraSnapshot(resourceId, nexus_api_url) {
    let account = this.#options.session?.account;

    // Use the camera's Nexus endpoint and the account's camera credentials.
    // This URL/authentication flow differs from Google's protobuf image reference.
    try {
      let response = await fetchWrapper(
        fetchWrapper.GET,
        new URL('/get_image?uuid=' + resourceId.trim().split('.')[1], nexus_api_url.trim()).href,
        {
          headers: {
            Referer: 'https://' + account.referer,
            Origin: 'https://' + account.referer,
            [account.cameraAuth.key]: account.cameraAuth.value + account.cameraAuth.token,
            'User-Agent': USER_AGENT,
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
          },
          retry: 2,
          timeout: SNAPSHOT_FETCH_TIMEOUT,
        },
      );
      let image = Buffer.from(await response.arrayBuffer());

      if (image.length > 0) {
        return image;
      }

      this.#options.log?.debug?.('Snapshot fetch returned empty image for device uuid "%s"', resourceId);
    } catch (error) {
      // Expected HTTP timeouts leave the next snapshot request to retry.
      if (
        error?.cause === undefined ||
        (error.cause?.message?.toUpperCase?.()?.includes('TIMEOUT') === false &&
          error.cause?.code?.toUpperCase?.()?.includes('TIMEOUT') === false)
      ) {
        this.#options.log?.debug?.(
          'Snapshot fetch failed for device uuid "%s". Error was "%s"',
          resourceId,
          typeof error?.message === 'string' ? error.message : String(error),
        );
      }
    }

    return undefined;
  }

  async #getCameraEvents(resourceId, nexus_api_url) {
    let account = this.#options.session?.account;

    try {
      let response = await fetchWrapper(
        fetchWrapper.GET,
        new URL('/cuepoint/' + resourceId.trim().split('.')[1] + '/2?start_time=' + Math.floor(Date.now() / 1000 - 30), nexus_api_url).href,
        {
          headers: {
            Referer: 'https://' + account.referer,
            Origin: 'https://' + account.referer,
            [account.cameraAuth.key]: account.cameraAuth.value + account.cameraAuth.token,
            'User-Agent': USER_AGENT,
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
          },
          // This endpoint is polled frequently, so the next poll is the retry.
          retry: 1,
          timeout: 4000,
        },
      );

      let data = await response.json();

      if (Array.isArray(data) === false) {
        throw new Error(data?.status_detail ?? 'Activity notifications missing or invalid');
      }

      let events = data
        .map((alert) => {
          let zoneIds = Array.isArray(alert.zone_ids) === true ? alert.zone_ids.map((id) => (id !== 0 ? id : 1)) : [1];

          if (zoneIds.length === 0) {
            zoneIds.push(1);
          }

          return {
            playback_time: alert.playback_time,
            start_time: alert.start_time,
            end_time: alert.end_time,
            id: alert.id,
            zone_ids: zoneIds,
            types: alert.types,
          };
        })
        .sort((a, b) => b.start_time - a.start_time);

      return events; // Return events from Nest API
    } catch (error) {
      // Cuepoint timeouts are expected transient misses; the next two-second poll tries again.
      if (
        (error?.cause ?? error)?.name === 'TimeoutError' ||
        (error?.cause ?? error)?.code === 'UND_ERR_HEADERS_TIMEOUT' ||
        (error?.cause ?? error)?.code === 'UND_ERR_CONNECT_TIMEOUT'
      ) {
        return [];
      }

      this.#options.log?.debug?.(
        'Nest API had error retrieving camera/doorbell activity notifications for device "%s". Error was "%s"',
        resourceId,
        typeof error?.message === 'string' ? error.message : String(error),
      );

      return [];
    }
  }

  async #getWeather(resourceId, postal_code, country_code) {
    let account = this.#options.session?.account;

    if (
      account.authorised !== true ||
      (account.referer ?? '') === '' ||
      (account.token ?? '') === '' ||
      (account.restAPIHost ?? '') === '' ||
      (postal_code?.trim?.() ?? '') === '' ||
      (country_code?.trim?.() ?? '') === ''
    ) {
      // Skip the query when the required account, credentials or request details are unavailable.
      return;
    }

    try {
      let response = await fetchWrapper(
        fetchWrapper.GET,
        new URL('/api/0.1/weather/forecast/' + postal_code + ',' + country_code, 'https://' + account.restAPIHost).href,
        {
          headers: {
            Referer: 'https://' + account.referer,
            Origin: 'https://' + account.referer,
            Authorization: 'Basic ' + account.token,
            'User-Agent': USER_AGENT,
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
          },
          retry: 3,
          timeout: 4000,
        },
      );

      let data = await response.json();

      // If returned JSON has an error defined, throw it
      if (data?.error !== undefined) {
        throw new Error(data.error);
      }

      // Ensure we have valid data
      if (
        data?.now?.current_temperature === undefined ||
        data?.now?.current_humidity === undefined ||
        data?.now?.conditions === undefined ||
        data?.now?.wind_direction === undefined ||
        data?.now?.current_wind === undefined ||
        data?.now?.sunrise === undefined ||
        data?.now?.sunset === undefined ||
        data?.forecast?.daily?.[0]?.conditions === undefined
      ) {
        throw new Error('Missing or invalid weather data');
      }

      let weather = {
        // Retain the query location for subsequent weather refreshes.
        postal_code: postal_code,
        country_code: country_code,

        // Return weather fields in the shared plugin format.
        current_temperature: adjustTemperature(data.now.current_temperature, 'C', 'C', false),
        current_humidity: data.now.current_humidity,
        condition: data.now.conditions,
        wind_direction: data.now.wind_direction,
        wind_speed: data.now.current_wind,
        sunrise: data.now.sunrise,
        sunset: data.now.sunset,
        station: data.display_city,
        forecast: data.forecast.daily[0].conditions,
      };

      return weather;
    } catch (error) {
      // Log unexpected errors (excluding timeouts) for debugging
      this.#options.log?.debug?.(
        'Nest API failed to retrieve weather details for device uuid "%s". Error was "%s"',
        resourceId,
        typeof error?.message === 'string' ? error.message : String(error),
      );

      return; // Return undefined if error occurs getting weather data
    }
  }

  async #getCameraProperties(resourceId) {
    // Subscription dispatch has checked the active account and selected a camera bucket.
    let account = this.#options.session?.account;

    try {
      let response = await fetchWrapper(
        fetchWrapper.GET,
        new URL('/api/cameras.get_with_properties?uuid=' + resourceId.trim().split('.')[1], 'https://webapi.' + account.cameraAPIHost).href,
        {
          headers: {
            Referer: 'https://' + account.referer,
            Origin: 'https://' + account.referer,
            [account.cameraAuth.key]: account.cameraAuth.value + account.cameraAuth.token,
            'User-Agent': USER_AGENT,
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
          },
          retry: 3,
          timeout: 4000,
        },
      );

      let data = await response.json();

      // If returned JSON has empty properties, throw it
      if (data?.items?.[0]?.properties === undefined) {
        throw new Error(data?.status_detail ?? 'Properties missing or empty');
      }

      return data.items[0].properties;
    } catch (error) {
      this.#options.log?.debug?.(
        'Nest API had error retrieving camera/doorbell properties. Error was "%s"',
        typeof error?.message === 'string' ? error.message : String(error),
      );

      return;
    }
  }
}
