// Start the real platform against injected account/discovery/HTTP boundaries.
// Tests feed Observe/subscribe messages and exercise public device SET/GET routes without exposing private methods.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import hap from './homebridge-hap.js';
import { setImmediate } from 'node:timers/promises';
import HomeKitDevice from '../../src/HomeKitDevice/HomeKitDevice.js';
import { DATA_SOURCE } from '../../src/consts.js';
import { importSource } from './import-source.js';
import { runtime, resetRuntime, clearTimers } from './platform-runtime.js';

let location = new URL('../../src/system.js', import.meta.url);
let boundary = new URL('./platform-runtime.js', import.meta.url).href;
let source = (await readFile(location, 'utf8'))
  .replace('from \'./devices.js\'', 'from ' + JSON.stringify(boundary))
  .replace('from \'./fetchWrapper.js\'', 'from ' + JSON.stringify(boundary))
  .replace('from \'node:timers\'', 'from ' + JSON.stringify(boundary));
// Ingestion classes retain their real code; redirect only HTTP and timer boundaries.
let apiClasses = {};
for (let name of ['nest', 'google']) {
  let apiLocation = new URL('../../src/api/' + name + '.js', import.meta.url);
  let apiSource = (await readFile(apiLocation, 'utf8'))
    .replace('from \'../fetchWrapper.js\'', 'from ' + JSON.stringify(boundary))
    .replace('from \'node:timers\'', 'from ' + JSON.stringify(boundary))
    .replace('from \'../grpctransport.js\'', 'from ' + JSON.stringify(boundary));
  apiClasses[name] = (await importSource(apiLocation, apiSource)).default;
}
let { default: Platform } = await importSource(location, source);
let { default: Accounts } = await importSource(new URL('../../src/accounts.js', import.meta.url));
HomeKitDevice.PLUGIN_NAME = 'platform-harness';
HomeKitDevice.PLATFORM_NAME = 'Fixture';
let complete = () => ({ status: 0, data: [{ traitOperations: [{ progress: 'COMPLETE', status: { code: 0 } }] }] });

export async function platformHarness(context, options = {}) {
  resetRuntime(options);
  let consume;
  let authorise;
  let callbacks = new Map();
  let registered = [];
  let removed = [];
  let requests = [];
  let commands = [];
  let observations = [];
  let logs = [];
  let pending = Promise.withResolvers();
  let connection = {
    name: 'Fixture account',
    type: 'Google',
    authorised: true,
    referer: 'home.invalid',
    restAPIHost: 'rest.invalid',
    cameraAPIHost: 'camera.invalid',
    transport_url: 'https://transport.invalid',
    token: 'fixture-token',
    userID: 'fixture-user',
    cameraAuth: { key: 'Authorization', value: 'Basic ', token: 'fixture-token' },
    grpcTransport: {
      observe: (...args) => {
        observations.push(args);
        consume = args.at(-1);
        return pending.promise;
      },
      command: async (...args) => {
        commands.push(args);
        return complete();
      },
    },
  };
  let accounts = new Map([['account', connection]]);
  accounts.start = () => {};
  accounts.shutdown = () => {
    connection.nestAPI?.disconnect();
    connection.googleAPI?.disconnect();
    connection.authorised = false;
    pending.resolve({ status: 0 });
  };
  let markUnauthorised = (...args) => {
    connection.nestAPI?.disconnect();
    connection.googleAPI?.disconnect();
    connection.authorised = false;
    logs.push(['unauthorised', ...args]);
  };
  context.mock.method(Accounts, 'fromConfig', (config, supplied) => {
    // Emulate the authenticated manager boundary; protocol clients and System's
    // commit/reconciliation code remain real in this platform integration harness.
    connection.dataQueue = Promise.resolve();
    authorise = async (uuid, account, details = {}) => {
      // Tests install the replacement transport before announcing refreshed auth.
      let transport = account.grpcTransport;
      account.googleAPI?.disconnect();
      account.grpcTransport = transport;
      runtime.transport = transport;
      let options = {
        uuid,
        session: {
          account,
          connect: async () => account.authorised,
          on() {},
          markUnauthorised: (reason) => markUnauthorised(uuid, reason),
        },
        log: supplied.log,
        onData: (batch) => {
          let run = account.dataQueue.then(() => (batch.isCurrent() === true ? supplied.onData(uuid, batch) : undefined));
          account.dataQueue = run.catch(() => {});
          return run;
        },
      };
      account.nestAPI ??= new apiClasses.nest(options);
      account.googleAPI ??= new apiClasses.google(options);
      await supplied.onAuthorised(uuid, account, details);
      if (details.wasAuthorised !== true) {
        account.nestAPI.connect();
      }
      account.googleAPI.connect();
    };
    return accounts;
  });
  let subscription = Promise.withResolvers();
  runtime.fetch = async (...args) => {
    requests.push(args);
    if (String(args[1]).includes('/app_launch') === true || String(args[1]).includes('/v5/subscribe') === true) {
      if (typeof options.subscribe === 'function') {
        return options.subscribe(...args);
      }
      return subscription.promise;
    }
    if (String(args[1]).includes('cameras.get_with_properties') === true) {
      return { json: async () => ({ items: [{ properties: {} }] }) };
    }
    if (typeof options.fetch === 'function') {
      return options.fetch(...args);
    }
    return { json: async () => ({ status: 0, objects: [{}] }) };
  };
  let api = {
    version: 2.7,
    hap,
    platformAccessory: hap.Accessory,
    on: (event, callback) => {
      let handlers = callbacks.get(event) ?? [];
      handlers.push(callback);
      callbacks.set(event, handlers);
    },
    registerPlatformAccessories: (plugin, platform, accessories) => registered.push(...accessories),
    unregisterPlatformAccessories: (plugin, platform, accessories) => removed.push(...accessories),
    updatePlatformAccessories() {},
  };
  let log = Object.fromEntries(
    ['debug', 'info', 'warn', 'error', 'success'].map((level) => [level, (...args) => logs.push([level, ...args])]),
  );
  let platform = new Platform(log, { options: { eveHistory: false, debug: true, ...options.config } }, api);
  for (let accessory of options.cachedAccessories ?? []) {
    platform.configureAccessory(accessory);
  }
  context.after(async () => {
    for (let device of runtime.devices) {
      await device.remove();
    }
    for (let callback of callbacks.get('shutdown') ?? []) {
      await callback();
    }
    subscription.resolve({ json: async () => ({ objects: [] }) });
    await setImmediate();
    clearTimers();
  });
  for (let callback of callbacks.get('didFinishLaunching')) {
    await callback();
  }
  await authorise('account', connection);
  assert.equal(typeof consume, 'function');
  let send = async (id, values) => {
    await consume({
      traitStates: Object.entries(values).map(([traitLabel, values]) => ({
        traitId: { resourceId: id, traitLabel },
        stateTypes: ['ACCEPTED'],
        patch: { values: structuredClone(values) },
      })),
    });
    await setImmediate();
  };
  let id = options.id ?? 'DEVICE_TEST';
  if (options.source === DATA_SOURCE.NEST) {
    subscription.resolve({ json: async () => ({ updated_buckets: [{ object_key: id, value: options.value ?? {} }] }) });
    await setImmediate();
  } else {
    await send(id, options.value ?? { fixture: {} });
  }
  return {
    platform,
    connection,
    accounts,
    registered,
    removed,
    requests,
    commands,
    observations,
    logs,
    send,
    consume,
    pending,
    authorise,
    get device() {
      return runtime.devices[0];
    },
    get raw() {
      return runtime.raw;
    },
  };
}
