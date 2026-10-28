// GoogleAPI
// Part of homebridge-nest-accfactory
//
// Handles protobuf Observe, queries and device commands for one account, using
// credentials from the shared AccountSession and a client-owned gRPC transport.
//
// Entry points:
// - connect() ensures account authentication and starts resource ingestion
// - disconnect() retires this API without logging the shared account out
// - get(resourceId, key, values = {}) reads source fields, camera snapshots or event history
// - set(resourceId, values) sends supported protobuf settings and commands
//
// Responsibilities:
// - Build Observe streams and resolve ACCEPTED/CONFIRMED trait precedence
// - Maintain source resources and report updates, removals and discovered home identifiers
// - Validate settings and execute protobuf updates and commands
// - Request fresh camera images, await committed references and download image buffers
// - Bound snapshot deadlines and release image waiters with the protobuf transport
// - Own Observe retries and reject callbacks from retired runs or replaced transports
//
// Ownership:
// - AccountSession owns login, token refresh and authentication retry scheduling
// - Either legacy Nest or Google account authentication may use this API
// - This client owns source resources; System maintains its combined HomeKit view
// - connect() starts ingestion without a consumer; onData optionally reports committed changes
// - Google Home Foyer media signalling belongs to the WebRTC camera transport
//
// Code version 2026.10.29
// Mark Hulskamp

// Define nodejs module requirements
import { setTimeout, clearTimeout } from 'node:timers';
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import path from 'node:path';

// Define our modules
import { fetchWrapper } from '../fetchWrapper.js';
import { isNumeric, scaleValue } from '../utils.js';
import GrpcTransport from '../grpctransport.js';
import { getProtoTypes } from '../protobuf.js';

// Define constants
import { ACCOUNT_TYPE, DATA_SOURCE, PROTOBUF_RESOURCES, USER_AGENT, __dirname } from '../consts.js';

const SNAPSHOT_TIMEOUT = 7000;
const SNAPSHOT_FETCH_TIMEOUT = 3000;
const SNAPSHOT_WAIT_TIMEOUT = 3000;

const API_STREAM_LOOP_INTERVAL = 1000;
const API_STREAM_RETRY_INITIAL = 5000;
const API_STREAM_RETRY_MAX = 60000;

export default class GoogleAPI {
  resources = new Map(); // Source resource records maintained by this client.
  #options = {}; // Shared authentication, logging and optional change notification
  #snapshotWaiters = new Map(); // Pending image refreshes owned by this client.
  #observation = undefined; // Requested Observe lifecycle, including login and recovery.
  #timer = undefined;
  #retryDelay = undefined;

  // Authentication is shared; resource state and observation identity are local.
  // onData is optional. Consumers may return false or reject to retry delivery;
  // source data remains available through resources and get() independently.
  constructor(options = {}) {
    this.#options = { session: options.session, uuid: options.uuid, log: options.log, onData: options.onData };

    options.session?.on('authorised', () => {
      if (this.#observation !== undefined) {
        this.connect().catch((error) => options.log?.debug?.('Unable to connect google API: %s', String(error)));
      }
    });
    options.session?.on('disconnect', () => {
      this.#stop(true);
    });
  }

  // Authenticate through the shared session, then start this API once.
  // Returning means startup was requested; resource data arrives through onData.
  async connect() {
    // Allocate the requested connection before login. An explicit disconnect or
    // a replaced run makes this particular login completion stale.
    let observation = (this.#observation ??= {});
    let authorised = await this.#options.session?.connect();
    if (authorised !== true) {
      throw new Error('Unable to authenticate account');
    }

    if (this.#observation !== observation) {
      return;
    }

    let { uuid, log, session } = this.#options;
    let account = session.account;

    // A transport on this run means Observe is already active. Repeated
    // connect calls and the shared authorised event must not start Observe twice.
    if (account.authorised !== true || observation.transport !== undefined) {
      return;
    }

    // The observation owns its transport. Authentication remains owned by the
    // shared session, whose current credentials are read for every request.
    observation.transport = new GrpcTransport({
      log,
      protoPath: path.join(__dirname, 'protobuf/root.proto'),
      endpointHost: 'https://' + account.grpcEndpointHost,
      uuid,
      userAgent: USER_AGENT,
      getAuthHeader: () => {
        let token = session.account.authorised === true ? session.account.token : undefined;
        return typeof token === 'string' && token.trim() !== '' ? 'Basic ' + token : '';
      },
    });

    return await this.#observe();
  }

  // An explicit disconnect also prevents session refresh from reopening this API.
  // The other API can continue using the account and its refresh scheduler.
  disconnect() {
    this.#stop();
  }

  #stop(reconnect = false) {
    let observation = this.#observation;
    // Recovery retains a fresh pending connection; explicit disconnect clears it.
    // Both invalidate replies and queued work belonging to the previous run.
    this.#observation = reconnect === true && observation !== undefined ? {} : undefined;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#retryDelay = undefined;
    observation?.transport?.release?.();

    // A snapshot may be waiting for an Observe update from this transport.
    // Resolve it without an image so it can use its existing fallback URL.
    for (let waiter of this.#snapshotWaiters.keys()) {
      waiter();
    }

    this.#snapshotWaiters.clear();
  }

  async #observe() {
    let { log, session } = this.#options;
    let account = session.account;
    let observation = this.#observation;
    let grpcTransport = observation?.transport;

    // Account identity and this exact run must both survive asynchronous work.
    let isCurrent = () => observation !== undefined && this.#observation === observation && account.authorised === true;
    let observeFailed = false;

    // A scheduled retry can outlive disconnect or account shutdown.
    if (grpcTransport === undefined || isCurrent() !== true) {
      return;
    }

    // Build the observed trait list from the loaded schemas. Legacy Nest logins omit
    // camera/doorbell traits; Google logins also include Google camera traits.
    let observeTraitsList = getProtoTypes(path.join(__dirname, 'protobuf/root.proto'), log)
      .filter((type) => {
        return (
          (account.type === ACCOUNT_TYPE.NEST &&
            type.fullName.startsWith('.nest.trait.product.camera') === false &&
            type.fullName.startsWith('.nest.trait.product.doorbell') === false &&
            (type.fullName.startsWith('.nest.trait') === true || type.fullName.startsWith('.weave.') === true)) ||
          (account.type === ACCOUNT_TYPE.GOOGLE &&
            (type.fullName.startsWith('.nest.trait') === true ||
              type.fullName.startsWith('.weave.') === true ||
              type.fullName.startsWith('.google.trait.product.camera') === true))
        );
      })
      .map((type) => ({
        traitType: type.fullName.replace(/^\.*|\.*$/g, ''),
      }));

    // Observe expects each trait type once, even when schema discovery overlaps.
    observeTraitsList = [...new Map(observeTraitsList.map((entry) => [entry.traitType, entry])).values()];

    // If protobuf support is unavailable or no observable traits were found,
    // do not start the observe loop. Retrying every second would only create
    // noise until the underlying protobuf load problem is fixed.
    if (observeTraitsList.length === 0) {
      log?.warn?.('Google API observe cannot start for account "%s" because no observable protobuf traits were loaded', account.name);

      return;
    }

    grpcTransport
      .observe(
        'nestlabs.gateway.v2.',
        'GatewayService',
        'Observe',
        { stateTypes: ['CONFIRMED', 'ACCEPTED'], traitTypeParams: observeTraitsList },
        async (message) => {
          // A released Observe stream can still finish a queued callback.
          // Only the active account transport may mutate the cache or remove accessories.
          if (isCurrent() !== true) {
            return;
          }

          // Retry a rejected consumer notification before publishing later data.
          // Keep the original removal records even though the source cache owns them already.
          if (observation.pending !== undefined) {
            let accepted = await this.#options.onData?.(observation.pending);
            if (isCurrent() !== true) {
              return;
            }
            if (accepted === false) {
              throw new Error('Google resource batch was not accepted');
            }
            observation.pending = undefined;
          }

          let observeResponses = Array.isArray(message?.observeResponse) === true ? message.observeResponse : [message].filter(Boolean);
          let changes = []; // Ordered source patches for local storage and consumer notification

          // Resource status can remove an existing device immediately. Additions
          // wait for trait data so device modules can check required fields before
          // System constructs an accessory.
          for (let observeResponse of observeResponses) {
            // resourceMetas
            if (Array.isArray(observeResponse?.resourceMetas) === true) {
              for (let resource of observeResponse.resourceMetas) {
                if (
                  resource.status === 'REMOVED' &&
                  (resource.resourceId.startsWith('STRUCTURE_') === true || resource.resourceId.startsWith('DEVICE_') === true)
                ) {
                  changes.push({ resourceId: resource.resourceId, remove: true, notify: true });
                }
              }
            }

            // traitStates
            if (Array.isArray(observeResponse?.traitStates) === true) {
              // Tidy up our received trait states. This ensures we only have one status for the trait in the data we process
              // We'll favour a trait with accepted status over the same with confirmed status
              let traits = observeResponse.traitStates;
              let acceptedKeys = new Set(
                traits
                  .filter((trait) => trait.stateTypes.includes('ACCEPTED') === true)
                  .map((trait) => trait.traitId.resourceId + '/' + trait.traitId.traitLabel),
              );

              observeResponse.traitStates = [
                ...traits.filter((trait) => acceptedKeys.has(trait.traitId.resourceId + '/' + trait.traitId.traitLabel) === false),
                ...traits.filter((trait) => trait.stateTypes.includes('ACCEPTED') === true),
              ];

              for (let trait of observeResponse.traitStates) {
                if (isCurrent() !== true) {
                  return;
                }

                let resourceId = trait.traitId.resourceId;
                let traitLabel = trait.traitId.traitLabel;
                let patchValues = trait?.patch?.values ?? {};

                // Preserve scalar injected fields; copy object traits before stripping metadata.
                if (patchValues !== null && typeof patchValues === 'object') {
                  patchValues = { ...patchValues };
                  delete patchValues['@type'];
                }

                let change = { resourceId, value: { [traitLabel]: patchValues }, fields: new Set([traitLabel]) };
                changes.push(change);

                // Store the internal Nest and Google structure uuids if matched to a defined home array entry
                if (
                  resourceId.startsWith('STRUCTURE_') === true &&
                  traitLabel === 'structure_info' &&
                  (patchValues?.name?.trim?.() ?? '') !== ''
                ) {
                  change.home = {
                    name: patchValues.name,
                    values: { nest_home_uuid: patchValues.rtsStructureId, google_home_uuid: resourceId },
                  };
                }
              }
            }
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
                source: DATA_SOURCE.GOOGLE,
                value: { ...this.resources.get(change.resourceId)?.value, ...change.value },
              });
            }
          }

          // Image requests use this client's committed state immediately; an
          // optional consumer must not delay snapshot completion.
          for (let change of changes) {
            let image = change.value?.upload_live_image;

            if (image !== undefined) {
              for (let [waiter, deviceId] of this.#snapshotWaiters) {
                // A waiter stays registered when its freshness check rejects this image.
                if (deviceId === change.resourceId && waiter(image) !== false) {
                  this.#snapshotWaiters.delete(waiter);
                }
              }
            }
          }

          // A failed consumer keeps one notification for retry, independently
          // of the source cache and image requests that already accepted it.
          let notification = { source: DATA_SOURCE.GOOGLE, changes, isCurrent };
          try {
            let committed = await this.#options.onData?.(notification);
            if (committed === false && changes.length > 0) {
              observation.pending = notification;
            }
          } catch (error) {
            if (changes.length > 0) {
              observation.pending = notification;
            }
            throw error;
          }

          if (isCurrent() === true) {
            this.#retryDelay = undefined;
          }
        },
      )
      .then((result) => {
        // gRPC failures normally resolve with a status rather than reject.
        observeFailed = result.status !== 0;

        // Expired/revoked credentials need account reauthentication, not another
        // Observe request with the same token. A retired transport must not
        // invalidate credentials installed by a refresh while it was closing.
        if (result.status === GrpcTransport.STATUS.UNAUTHENTICATED && isCurrent() === true) {
          this.#options.session?.markUnauthorised('google-api-' + result.status);
        }
      })
      .catch((error) => {
        observeFailed = true;

        log?.debug?.(
          'Google API observe failed for account "%s": %s',
          account.name,
          typeof error?.message === 'string' ? error.message : String(error),
        );
      })
      .finally(() => {
        // Completion can arrive after refresh released this transport. Only the
        // current Observe run may choose the next retry deadline.
        if (isCurrent() === true) {
          let observeDelay = API_STREAM_LOOP_INTERVAL;

          if (observeFailed === true) {
            observeDelay =
              Number.isFinite(this.#retryDelay) === true && this.#retryDelay > 0
                ? Math.min(this.#retryDelay * 2, API_STREAM_RETRY_MAX)
                : API_STREAM_RETRY_INITIAL;

            this.#retryDelay = observeDelay;
          }

          clearTimeout(this.#timer);
          this.#timer = setTimeout(() => {
            this.#timer = undefined;
            if (isCurrent() === true) {
              this.#observe();
            }
          }, observeDelay);
        }
      });
  }

  // values contains Google setting names, e.g. { temperature_scale: 'C' }.
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

    if (typeof resource !== 'object' || resource === null || resource.source !== DATA_SOURCE.GOOGLE) {
      throw new Error('SET requires an available authorised device account');
    }

    if (this.#observation?.transport === undefined) {
      throw new Error('Google command transport is unavailable');
    }

    // Cloud writes are independent and cannot be rolled back as a group. Attempt
    // later settings after a failure, then report any partial success to the caller.
    let failures = [];
    let appliedTraits = new Map(); // Successful writes in this SET; Observe remains the authoritative cache writer.
    for (let [key, value] of Object.entries(values)) {
      try {
        let handled = false;

        // An awaited write can allow Observe to change the selected resource.
        let currentResource = this.resources.get(resourceId);

        if (currentResource?.source === DATA_SOURCE.GOOGLE && this.#observation?.transport !== undefined) {
          // The fan-state command consumes these fields together, regardless of
          // property order. Invalid companions prevent that command being built.
          if (['fan_duration', 'fan_timer_speed'].includes(key) === true && Object.hasOwn(values, 'fan_state') === true) {
            continue;
          }

          let { update, command } = this.#buildSetting(resourceId, key, value, values, currentResource, appliedTraits);

          // Submit the trait update for this setting and verify Google accepted it.
          if (update !== undefined) {
            let grpcResult = await this.#observation?.transport.command('nestlabs.gateway.v1.', 'TraitBatchApi', 'BatchUpdateState', {
              batchUpdateStateRequest: [update],
            });
            let commandResponse = Array.isArray(grpcResult?.data) === true ? grpcResult.data[0] : undefined;
            let operation = commandResponse?.traitOperations?.[0];

            if (grpcResult?.status !== 0 || operation?.progress !== 'COMPLETE' || (operation?.status?.code ?? 0) !== 0) {
              throw new Error('Google API rejected setting "' + key + '"');
            }

            // Later fields targeting this trait must include this accepted write,
            // even when Observe has not echoed it yet. Failed writes stay out.
            appliedTraits.set(update.traitRequest.resourceId + '/' + update.traitRequest.traitLabel, update.state.value);
          }

          // Submit resource commands separately and verify each operation completed.
          if (command !== undefined) {
            let grpcResult = await this.#observation?.transport.command('nestlabs.gateway.v1.', 'ResourceApi', 'SendCommand', command);
            let commandResponse = Array.isArray(grpcResult?.data) === true ? grpcResult.data[0] : undefined;
            let operation = commandResponse?.traitOperations?.[0];

            if (grpcResult?.status !== 0 || operation?.progress !== 'COMPLETE' || (operation?.status?.code ?? 0) !== 0) {
              throw new Error('Google API rejected setting "' + key + '"');
            }
          }

          handled = update !== undefined || command !== undefined;
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

  #buildSetting(resourceId, key, value, values, resource, appliedTraits) {
    // Return protocol requests for one setting; set() owns execution and errors.
    // Settings below choose either a trait-state update or a resource command.
    // Most target this device; light, sensor selection and vacation mode resolve
    // a related service, parent thermostat or structure instead. Unmatched or
    // invalid settings leave both requests empty and are rejected by set().
    // Clone committed traits or earlier accepted writes from this SET so changing
    // one field preserves its siblings without mutating the shared resource cache.
    const timestamp = (milliseconds) => ({
      // Derive both protobuf timestamp fields from the same millisecond value.
      seconds: Math.floor(milliseconds / 1000),
      nanos: (milliseconds % 1000) * 1e6,
    });

    let updateElement = {
      traitRequest: {
        resourceId,
        traitLabel: '',
        requestId: crypto.randomUUID(),
      },
      state: {
        type_url: '',
        value: {},
      },
    };
    let commandElement = {
      resourceRequest: {
        resourceId,
        requestId: crypto.randomUUID(),
      },
      resourceCommands: [],
    };

    // Build a trait update from an earlier accepted write, an explicit related
    // resource value, or this device's committed trait, in that order.
    let setUpdateTrait = (traitLabel, typeURL, traitValue = undefined, updates = undefined) => {
      updateElement.traitRequest.traitLabel = traitLabel;
      updateElement.state.type_url = typeURL;

      // A later field can update the same trait before Observe reflects the
      // earlier write. Carry only accepted changes forward, without mutating raw data.
      let traitKey = updateElement.traitRequest.resourceId + '/' + traitLabel;

      if (appliedTraits.has(traitKey) === true) {
        traitValue = appliedTraits.get(traitKey);
      } else if (traitValue === undefined) {
        traitValue = resource?.value?.[traitLabel];
      }

      updateElement.state.value = typeof traitValue === 'object' && traitValue !== null ? structuredClone(traitValue) : {};

      // Optionally merge in simple top-level updates
      if (typeof updates === 'object' && updates !== null) {
        Object.assign(updateElement.state.value, updates);
      }
    };

    // Build a command for this device, or an explicitly selected related resource.
    let setCommandTrait = (traitLabel, typeURL, commandValue, targetResourceId = resourceId) => {
      commandElement.resourceRequest.resourceId = targetResourceId;
      commandElement.resourceCommands = [
        {
          traitLabel,
          command: {
            type_url: typeURL,
            value: commandValue,
          },
        },
      ];
    };

    // Map the plugin's Eco state to the protobuf command enum. HomeKitDevice
    // applies a successful SET locally; Observe supplies the actual device state.
    if (key === 'eco_mode' && typeof value === 'string' && ['OFF', 'MANUAL', 'AUTO'].includes(value.toUpperCase()) === true) {
      setCommandTrait('eco_mode_state', 'type.nestlabs.com/nest.trait.hvac.EcoModeStateTrait.EcoModeChangeRequest', {
        ecoMode: {
          OFF: 'ECO_MODE_INACTIVE',
          MANUAL: 'ECO_MODE_MANUAL_ECO',
          AUTO: 'ECO_MODE_AUTO_ECO',
        }[value.toUpperCase()],
        ecoModeActor: {
          method: 'HVAC_ACTOR_METHOD_IOS',
          originator: { resourceId },
          timeOfAction: timestamp(Date.now()),
        },
        setAll: false,
      });
    }

    if (
      (key === 'hvac_mode' && typeof value === 'string' && ['OFF', 'COOL', 'HEAT', 'RANGE'].includes(value.toUpperCase()) === true) ||
      (['target_temperature', 'target_temperature_low', 'target_temperature_high'].includes(key) === true &&
        resource?.value?.eco_mode_state?.ecoMode === 'ECO_MODE_INACTIVE' &&
        isNumeric(value) === true)
    ) {
      // HVAC mode always uses the normal target trait. Temperature writes use
      // it only when Eco is explicitly inactive; the next branch handles Eco targets.
      setUpdateTrait('target_temperature_settings', 'type.nestlabs.com/nest.trait.hvac.TargetTemperatureSettingsTrait');

      let setpointType = updateElement.state.value.targetTemperature?.setpointType;
      let setHeatingTarget =
        ['target_temperature_low', 'target_temperature'].includes(key) === true &&
        ['SET_POINT_TYPE_HEAT', 'SET_POINT_TYPE_RANGE'].includes(setpointType) === true;
      let setCoolingTarget =
        ['target_temperature_high', 'target_temperature'].includes(key) === true &&
        ['SET_POINT_TYPE_COOL', 'SET_POINT_TYPE_RANGE'].includes(setpointType) === true;

      // Do not report success for an actor-only update to the wrong target.
      if (key !== 'hvac_mode' && setHeatingTarget !== true && setCoolingTarget !== true) {
        throw new Error('Temperature setting "' + key + '" is unavailable in the current mode');
      }

      if (setHeatingTarget === true) {
        updateElement.state.value.targetTemperature.heatingTarget = { value: Number(value) };
      }

      if (setCoolingTarget === true) {
        updateElement.state.value.targetTemperature.coolingTarget = { value: Number(value) };
      }

      if (key === 'hvac_mode' && value.toUpperCase() !== 'OFF') {
        updateElement.state.value.targetTemperature.setpointType = 'SET_POINT_TYPE_' + value.toUpperCase();
        updateElement.state.value.enabled = { value: true };
      }

      if (key === 'hvac_mode' && value.toUpperCase() === 'OFF') {
        updateElement.state.value.enabled = { value: false };
      }

      // Attribute the request using the Nest client actor fields expected by
      // this trait, with the target resource as the originator.
      updateElement.state.value.targetTemperature.currentActorInfo = {
        method: 'HVAC_ACTOR_METHOD_IOS',
        originator: { resourceId },
        timeOfAction: timestamp(Date.now()),
      };
    }

    if (
      ['target_temperature', 'target_temperature_low', 'target_temperature_high'].includes(key) === true &&
      resource?.value?.eco_mode_state?.ecoMode !== 'ECO_MODE_INACTIVE' &&
      isNumeric(value) === true
    ) {
      // Eco has separate limits and enable flags. A single target is unambiguous
      // only when one side is enabled; with both enabled, require low or high.
      setUpdateTrait('eco_mode_settings', 'type.nestlabs.com/nest.trait.hvac.EcoModeSettingsTrait');

      let heatEnabled = updateElement.state.value.ecoTemperatureHeat?.enabled === true;
      let coolEnabled = updateElement.state.value.ecoTemperatureCool?.enabled === true;
      let setHeatingTarget =
        heatEnabled === true &&
        ['target_temperature', 'target_temperature_low'].includes(key) === true &&
        (coolEnabled !== true || key === 'target_temperature_low');
      let setCoolingTarget =
        coolEnabled === true &&
        ['target_temperature', 'target_temperature_high'].includes(key) === true &&
        (heatEnabled !== true || key === 'target_temperature_high');
      if (setHeatingTarget !== true && setCoolingTarget !== true) {
        throw new Error('Temperature setting "' + key + '" is unavailable in the current Eco mode');
      }

      if (setHeatingTarget === true) {
        updateElement.state.value.ecoTemperatureHeat.value = { value: Number(value) };
      }

      if (setCoolingTarget === true) {
        updateElement.state.value.ecoTemperatureCool.value = { value: Number(value) };
      }
    }

    if (key === 'temperature_scale' && typeof value === 'string' && ['C', 'F'].includes(value.toUpperCase()) === true) {
      // Set the temperature scale on the target thermostat
      setUpdateTrait('display_settings', 'type.nestlabs.com/nest.trait.hvac.DisplaySettingsTrait', undefined, {
        temperatureScale: value.toUpperCase() === 'F' ? 'TEMPERATURE_SCALE_F' : 'TEMPERATURE_SCALE_C',
      });
    }

    if (key === 'temperature_lock' && typeof value === 'boolean') {
      // Set lock mode on the target thermostat
      setUpdateTrait('temperature_lock_settings', 'type.nestlabs.com/nest.trait.hvac.TemperatureLockSettingsTrait', undefined, {
        enabled: value,
      });
    }

    if (
      key === 'fan_state' &&
      typeof value === 'boolean' &&
      isNumeric(values.fan_duration, { min: 0 }) === true &&
      (values.fan_timer_speed === undefined || isNumeric(values.fan_timer_speed, { type: 'integer', min: 0, max: 3 }) === true)
    ) {
      // Set fan mode on the target thermostat, including runtime if turning on
      setUpdateTrait('fan_control_settings', 'type.nestlabs.com/nest.trait.hvac.FanControlSettingsTrait');
      updateElement.state.value.timerEnd = value === true ? timestamp(Date.now() + Number(values.fan_duration) * 1000) : timestamp(0);
      if (values?.fan_timer_speed !== undefined) {
        // A zero speed retains the current stage. fan_state owns the combined
        // on/off, duration and optional speed update for this request.
        updateElement.state.value.timerSpeed =
          Number(values.fan_timer_speed) !== 0
            ? 'FAN_SPEED_SETTING_STAGE' + Number(values.fan_timer_speed)
            : resource.value.fan_control_settings.timerSpeed;
      }
    }

    if (key === 'fan_timer_speed' && isNumeric(value, { type: 'integer', min: 0, max: 3 }) === true) {
      // Set fan speed on the target thermostat only if we're not changing fan on/off state also
      setUpdateTrait('fan_control_settings', 'type.nestlabs.com/nest.trait.hvac.FanControlSettingsTrait');
      updateElement.state.value.timerSpeed =
        Number(value) !== 0 ? 'FAN_SPEED_SETTING_STAGE' + Number(value) : resource.value.fan_control_settings.timerSpeed;
    }

    if (key === 'streaming_enabled' && typeof value === 'boolean') {
      // Camera power uses the recording toggle trait, rather than a live-session
      // command. Carry the change reason and timestamp with the requested state.
      setUpdateTrait('recording_toggle_settings', 'type.nestlabs.com/nest.trait.product.camera.RecordingToggleSettingsTrait');
      updateElement.state.value.targetCameraState = value === true ? 'CAMERA_ON' : 'CAMERA_OFF';
      updateElement.state.value.changeModeReason = 2;
      updateElement.state.value.settingsUpdated = timestamp(Date.now());
    }

    if (key === 'audio_enabled' && typeof value === 'boolean') {
      // Enable/disable microphone on camera/doorbell
      setUpdateTrait('microphone_settings', 'type.nestlabs.com/nest.trait.audio.MicrophoneSettingsTrait', undefined, {
        enableMicrophone: value,
      });
    }

    if (key === 'indoor_chime_enabled' && typeof value === 'boolean') {
      // Enable/disable chime status on doorbell
      setUpdateTrait(
        'doorbell_indoor_chime_settings',
        'type.nestlabs.com/nest.trait.product.doorbell.DoorbellIndoorChimeSettingsTrait',
        undefined,
        { chimeEnabled: value },
      );
    }

    if (key === 'light_enabled' && typeof value === 'boolean' && typeof resource?.value?.related_resources?.relatedResources === 'object') {
      // Floodlight power belongs to the related Aziz service, while brightness
      // below belongs to the camera's floodlight settings trait.
      let serviceUUID = Object.values(resource.value.related_resources.relatedResources).find(
        (resource) =>
          resource?.resourceTypeName?.resourceName === 'google.resource.AzizResource' &&
          resource?.resourceId?.resourceId?.startsWith('SERVICE_') === true,
      )?.resourceId?.resourceId;

      if ((serviceUUID ?? '') !== '') {
        setCommandTrait('on_off', 'type.nestlabs.com/weave.trait.actuator.OnOffTrait.SetStateRequest', { on: value }, serviceUUID);
      }
    }

    if (key === 'light_brightness' && isNumeric(value, { min: 0, max: 100 }) === true) {
      // Set light brightness on supported camera devices. Needs to be scaled to 0-10 for the API
      setUpdateTrait('floodlight_settings', 'type.nestlabs.com/google.trait.product.camera.FloodlightSettingsTrait', undefined, {
        brightness: scaleValue(Number(value), 0, 100, 0, 10),
      });
    }

    if (key === 'active_sensor' && typeof value === 'boolean') {
      // Resolve the parent from this API's observed relationships; a standalone
      // client must not rely on System injecting a thermostat ID into the sensor.
      let parent = [...this.resources].find(
        ([, candidate]) =>
          candidate.value?.remote_comfort_sensing_settings?.associatedRcsSensors?.some(
            (sensor) => sensor.deviceId?.resourceId === resourceId,
          ) === true,
      );
      if (parent !== undefined) {
        updateElement.traitRequest.resourceId = parent[0];
        setUpdateTrait(
          'remote_comfort_sensing_settings',
          'type.nestlabs.com/nest.trait.hvac.RemoteComfortSensingSettingsTrait',
          parent[1].value.remote_comfort_sensing_settings,
        );
        updateElement.state.value.activeRcsSelection =
          value === true
            ? { rcsSourceType: 'RCS_SOURCE_TYPE_SINGLE_SENSOR', activeRcsSensor: { resourceId } }
            : { rcsSourceType: 'RCS_SOURCE_TYPE_BACKPLATE' };
      }
    }

    if (
      key === 'hot_water_boost_active' &&
      typeof value === 'object' &&
      value !== null &&
      typeof value.state === 'boolean' &&
      (value.time === undefined || isNumeric(value.time, { min: 0 }) === true) &&
      resource?.value?.hvac_equipment_capabilities?.hasHotWaterControl === true
    ) {
      // Boost and water temperature share one trait. Preserve its other fields
      // and use an absolute expiry, or zero to cancel; default boost is 30 minutes.
      setUpdateTrait('hot_water_settings', 'type.nestlabs.com/nest.trait.hvac.HotWaterSettingsTrait');

      let boostTime = value.time === undefined ? 30 * 60 : Number(value.time);

      updateElement.state.value.boostTimerEnd = value?.state === true ? timestamp(Date.now() + boostTime * 1000) : timestamp(0);
    }

    if (
      key === 'hot_water_temperature' &&
      isNumeric(value) === true &&
      resource?.value?.hvac_equipment_capabilities?.hasHotWaterTemperature === true
    ) {
      // Set hotwater boiler temperature
      setUpdateTrait('hot_water_settings', 'type.nestlabs.com/nest.trait.hvac.HotWaterSettingsTrait');
      updateElement.state.value.temperature = {
        ...(updateElement.state.value.temperature ?? {}),
        value: Number(value),
      };
    }

    if (key === 'bolt_lock' && typeof value === 'boolean') {
      // Bolt motion is an explicit command with actor metadata; automatic relock
      // below changes a persistent setting instead of moving the bolt now.
      setCommandTrait('bolt_lock', 'type.nestlabs.com/weave.trait.security.BoltLockTrait.BoltLockChangeRequest', {
        state: value === true ? 'BOLT_STATE_EXTENDED' : 'BOLT_STATE_RETRACTED',
        boltLockActor: {
          method: 'BOLT_LOCK_ACTOR_METHOD_REMOTE_USER_EXPLICIT',
          originator: { resourceId },
          agent: null,
        },
      });
    }

    if (key === 'auto_relock_duration' && isNumeric(value, { type: 'integer', min: 0 }) === true) {
      // Set lock auto-relock duration
      setUpdateTrait('bolt_lock_settings', 'type.nestlabs.com/weave.trait.security.BoltLockSettingsTrait');
      updateElement.state.value.autoRelockDuration = {
        ...(updateElement.state.value.autoRelockDuration ?? {}),
        seconds: Number(value),
      };
    }

    if (key === 'vacation_mode' && typeof value === 'boolean' && (resource?.value?.device_info?.pairerId?.resourceId ?? '') !== '') {
      // Vacation mode is a structure command. Target the device's paired
      // structure while retaining the requesting device in the command payload.
      setCommandTrait(
        'structure_mode',
        'type.nestlabs.com/nest.trait.occupancy.StructureModeTrait.StructureModeChangeRequest',
        {
          structureMode: value === true ? 'STRUCTURE_MODE_VACATION' : 'STRUCTURE_MODE_HOME',
          reason: 'STRUCTURE_MODE_REASON_EXPLICIT_INTENT',
          userId: {
            resourceId,
          },
        },
        resource.value.device_info.pairerId.resourceId,
      );
    }

    if (
      key === 'dehumidifier_state' &&
      typeof value === 'boolean' &&
      resource?.value?.hvac_equipment_capabilities?.hasDehumidifier === true
    ) {
      // Humidity controls below share one trait but keep separate equipment
      // targets. Merge each nested object so enable and percentage writes retain
      // one another, including earlier accepted writes from this same SET.
      setUpdateTrait('humidity_control_settings', 'type.nestlabs.com/nest.trait.hvac.HumidityControlSettingsTrait');
      updateElement.state.value.dehumidifierTargetHumidity = {
        ...(updateElement.state.value.dehumidifierTargetHumidity ?? {}),
        enabled: value,
      };
    }

    if (
      key === 'target_humidity_dehumidifier' &&
      isNumeric(value, { min: 0, max: 100 }) === true &&
      resource?.value?.hvac_equipment_capabilities?.hasDehumidifier === true
    ) {
      // Set dehumidifier target humidity on the target thermostat
      setUpdateTrait('humidity_control_settings', 'type.nestlabs.com/nest.trait.hvac.HumidityControlSettingsTrait');
      updateElement.state.value.dehumidifierTargetHumidity = {
        ...(updateElement.state.value.dehumidifierTargetHumidity ?? {}),
        value: Number(value),
      };
    }

    if (key === 'humidifier_state' && typeof value === 'boolean' && resource?.value?.hvac_equipment_capabilities?.hasHumidifier === true) {
      // Set humidifier on/off on the target thermostat
      setUpdateTrait('humidity_control_settings', 'type.nestlabs.com/nest.trait.hvac.HumidityControlSettingsTrait');
      updateElement.state.value.humidifierTargetHumidity = {
        ...(updateElement.state.value.humidifierTargetHumidity ?? {}),
        enabled: value,
      };
    }

    if (
      key === 'target_humidity_humidifier' &&
      isNumeric(value, { min: 0, max: 100 }) === true &&
      resource?.value?.hvac_equipment_capabilities?.hasHumidifier === true
    ) {
      // Set humidifier target humidity on the target thermostat
      setUpdateTrait('humidity_control_settings', 'type.nestlabs.com/nest.trait.hvac.HumidityControlSettingsTrait');
      updateElement.state.value.humidifierTargetHumidity = {
        ...(updateElement.state.value.humidifierTargetHumidity ?? {}),
        value: Number(value),
      };
    }

    return {
      update: updateElement.traitRequest.traitLabel !== '' && updateElement.state.type_url !== '' ? updateElement : undefined,
      command: commandElement.resourceCommands.length > 0 ? commandElement : undefined,
    };
  }

  // Returns the query value directly: camera_snapshot -> Buffer/undefined,
  // camera_events -> array. Location weather is a Nest REST query, routed by System.
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

    if (typeof resource !== 'object' || resource === null) {
      throw new Error('GET requires an available resource');
    }

    let result = Object.hasOwn(resource?.value ?? {}, key) === true ? structuredClone(resource.value[key]) : undefined;

    // Camera queries require a committed resource and its account's live transport.
    let cameraAvailable =
      typeof resource?.value === 'object' &&
      resource.value !== null &&
      resourceId.startsWith('DEVICE_') === true &&
      this.#observation?.transport !== undefined;

    if (key === 'camera_snapshot') {
      let type = resource?.value?.device_info?.typeName;

      if (
        cameraAvailable === true &&
        (account.referer ?? '') !== '' &&
        (account.token ?? '') !== '' &&
        (PROTOBUF_RESOURCES.CAMERA.includes(type) === true ||
          PROTOBUF_RESOURCES.DOORBELL.includes(type) === true ||
          PROTOBUF_RESOURCES.FLOODLIGHT.includes(type) === true)
      ) {
        // The overall deadline also retires the waiter and aborts any HTTP image fetch.
        let controller = new AbortController();
        let timer = undefined;

        try {
          result = await Promise.race([
            this.#getCameraSnapshot(resourceId, controller.signal),
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                let error = new Error('Snapshot request timeout');
                controller.abort(error);
                reject(error);
              }, SNAPSHOT_TIMEOUT);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
    } else if (key === 'camera_events') {
      result = [];
      if (cameraAvailable === true) {
        result = await this.#getCameraEvents(resourceId);
      }
    }

    return result;
  }

  async #getCameraSnapshot(resourceId, signal) {
    let account = this.#options.session?.account;

    let snapshot = undefined;

    // Record the protobuf upload_live_image state before asking for a new snapshot
    // so we can fall back to the previously available image URL if no newer data arrives
    let beforeRequestUploadLiveImage = structuredClone(this.resources.get(resourceId)?.value?.upload_live_image ?? {});
    let beforeRequestUrl = beforeRequestUploadLiveImage?.liveImageUrl ?? '';

    // Each request keeps the image it accepts, even if later Observe updates change the cache.
    let acceptedImage = undefined;

    // Key by request callback so overlapping snapshots remain independent.
    let { promise: waitForSnapshotUpdate, resolve: resolveSnapshotUpdate } = Promise.withResolvers();
    let waiter = (image = undefined) => {
      // Transport cleanup supplies no image; release the wait without treating
      // cleanup as a new capture. Overlapping requests retain separate callbacks.
      if (image !== undefined) {
        let before = beforeRequestUploadLiveImage.timestamp;
        let current = image.timestamp;

        // Prefer capture time, including nanoseconds, over URL changes: Google
        // can reuse a URL for a new image or replay a URL with an old timestamp.
        let newer =
          Number.isFinite(before?.seconds) === true && Number.isFinite(current?.seconds) === true
            ? current.seconds > before.seconds || (current.seconds === before.seconds && (current.nanos ?? 0) > (before.nanos ?? 0))
            : image.liveImageUrl !== beforeRequestUrl;
        if ((image.liveImageUrl ?? '') === '' || newer !== true) {
          return false;
        }
      }

      resolveSnapshotUpdate(image);

      return true;
    };
    this.#snapshotWaiters.set(waiter, resourceId);
    let waitTimer = undefined;
    let cancelWait = () => {
      this.#snapshotWaiters.delete(waiter);
      resolveSnapshotUpdate();
    };
    signal.addEventListener('abort', cancelWait, { once: true });

    // Register the waiter before sending the command: Observe may deliver the
    // image while SendCommand is still awaiting its completion response.
    try {
      let grpcResult = await this.#observation?.transport.command(
        'nestlabs.gateway.v1.',
        'ResourceApi',
        'SendCommand',
        {
          resourceRequest: {
            resourceId,
            requestId: crypto.randomUUID(),
          },
          resourceCommands: [
            {
              traitLabel: 'upload_live_image',
              command: {
                type_url: 'type.nestlabs.com/nest.trait.product.camera.UploadLiveImageTrait.UploadLiveImageRequest',
                value: {},
              },
            },
          ],
        },
        { timeout: SNAPSHOT_TIMEOUT },
      );

      // A caller may already have timed out while this command was in flight.
      // Discard its late reply instead of starting fresh work for a retired request.
      signal.throwIfAborted();

      let commandResponse = Array.isArray(grpcResult?.data) === true ? grpcResult.data[0] : undefined;

      // Wait for an Observe image update only when the snapshot command succeeds.
      if (
        commandResponse?.traitOperations?.[0]?.progress === 'COMPLETE' &&
        commandResponse?.traitOperations?.[0]?.event?.event?.status === 'STATUS_SUCCESSFUL'
      ) {
        // Wait briefly for observe processing to deliver updated upload_live_image data for this device.
        // If no update arrives in time, we'll fall back to whatever URL was already available.
        acceptedImage = await Promise.race([
          waitForSnapshotUpdate,
          new Promise((resolve) => {
            waitTimer = setTimeout(resolve, SNAPSHOT_WAIT_TIMEOUT);
          }),
        ]);
      }
    } finally {
      // Remove only this request, including when the refresh command fails.
      this.#snapshotWaiters.delete(waiter);
      clearTimeout(waitTimer);
      signal.removeEventListener('abort', cancelWait);
    }

    signal.throwIfAborted();

    // Prefer this request's accepted image. An Observe wait timeout or transport
    // cleanup can use the latest committed URL; the overall abort above stops
    // all further work once the caller's snapshot deadline has expired.
    let latestUrl = (acceptedImage ?? this.resources.get(resourceId)?.value?.upload_live_image)?.liveImageUrl ?? '';

    // Use the pre-request URL when the committed image state has no usable URL.
    if (latestUrl === '') {
      latestUrl = beforeRequestUrl;
    }

    if ((latestUrl ?? '') !== '') {
      // The request's overall deadline also cancels this image fetch.
      try {
        let response = await fetchWrapper(fetchWrapper.GET, latestUrl, {
          headers: {
            Referer: 'https://' + account.referer,
            Origin: 'https://' + account.referer,
            Authorization: 'Basic ' + account.token,
            'User-Agent': USER_AGENT,
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
          },
          retry: 2,
          timeout: SNAPSHOT_FETCH_TIMEOUT,
          signal,
        });
        let image = Buffer.from(await response.arrayBuffer());

        if (image.length > 0) {
          snapshot = image;
        } else {
          this.#options.log?.debug?.('Snapshot fetch returned empty image for device uuid "%s"', resourceId);
        }
      } catch (error) {
        // Preserve visibility of unexpected HTTP/body failures while suppressing timeouts.
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

      if (snapshot !== undefined) {
        return snapshot;
      }
    }

    this.#options.log?.debug?.('Google API did not provide a usable snapshot URL for device uuid "%s"', resourceId);

    return;
  }

  async #getCameraEvents(resourceId) {
    let grpcResult = await this.#observation?.transport.command(
      'nestlabs.gateway.v1.',
      'ResourceApi',
      'SendCommand',
      {
        resourceRequest: {
          resourceId,
          requestId: crypto.randomUUID(),
        },
        resourceCommands: [
          {
            traitLabel: 'camera_observation_history',
            command: {
              type_url: 'type.nestlabs.com/nest.trait.history.CameraObservationHistoryTrait.CameraObservationHistoryRequest',
              value: {
                // We want camera history from up to 15 seconds ago until now
                queryStartTime: {
                  seconds: Math.floor((Date.now() - 15000) / 1000),
                  nanos: ((Date.now() - 15000) % 1000) * 1e6,
                },
                queryEndTime: {
                  seconds: Math.floor(Date.now() / 1000),
                  nanos: (Date.now() % 1000) * 1e6,
                },
              },
            },
          },
        ],
      },
      { timeout: 4000 },
    );

    let commandResponse = Array.isArray(grpcResult?.data) === true ? grpcResult.data[0] : undefined;

    // Camera history queries can legitimately time out when Google has no recent
    // event data ready. Treat that as no events rather than logging duplicate noise.
    if (grpcResult?.status === 4 || grpcResult?.code === 'REQUEST_TIMEOUT') {
      return [];
    }

    // Only continue if gRPC reports the camera history request completed successfully
    if (commandResponse?.traitOperations?.[0]?.progress === 'COMPLETE') {
      let events =
        Array.isArray(commandResponse?.traitOperations?.[0]?.event?.event?.cameraEventWindow?.cameraEvent) === true
          ? commandResponse.traitOperations[0].event.event.cameraEventWindow.cameraEvent
              .map((event) => ({
                playback_time: parseInt(event.startTime.seconds) * 1000 + parseInt(event.startTime.nanos) / 1000000,
                start_time: parseInt(event.startTime.seconds) * 1000 + parseInt(event.startTime.nanos) / 1000000,
                end_time: parseInt(event.endTime.seconds) * 1000 + parseInt(event.endTime.nanos) / 1000000,
                id: event.eventId,
                zone_ids:
                  Array.isArray(event.activityZone) === true
                    ? event.activityZone.map((zone) => (zone?.zoneIndex !== undefined ? zone.zoneIndex : zone.internalIndex))
                    : [],
                types:
                  Array.isArray(event.eventType) === true
                    ? event.eventType
                        .map((type) => {
                          // Match Nest REST event names and automatically support future protobuf enum additions.
                          return type.startsWith('EVENT_') === true ? type.slice(6).toLowerCase().replaceAll('_', '-') : '';
                        })
                        .filter(Boolean)
                    : [],
              }))
              .sort((a, b) => b.start_time - a.start_time)
          : [];

      return events; // Return events from Google API
    } else {
      this.#options.log?.debug?.('Google API had error retrieving camera/doorbell activity notifications for device "%s"', resourceId);

      return [];
    }
  }
}
