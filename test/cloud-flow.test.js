// Follow Google Observe -> cache -> mapper -> accessory -> HAP, and HomeKit SET -> cloud -> commit.
// Only account authorisation and remote gRPC are replaced; platform and device code stay file-backed.
import assert from 'node:assert/strict';
import hap from './helpers/homebridge-hap.js';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { importSource } from './helpers/import-source.js';
import HomeKitDevice from '../src/HomeKitDevice/HomeKitDevice.js';

let { default: Platform } = await importSource(new URL('../src/system.js', import.meta.url));
let { default: Connections } = await importSource(new URL('../src/connections.js', import.meta.url));
let { default: Thermostat } = await importSource(new URL('../src/plugins/thermostat.js', import.meta.url));
HomeKitDevice.PLUGIN_NAME = 'cloud-flow-test';
HomeKitDevice.PLATFORM_NAME = 'CloudFlow';
let nextSerial = 0;
let success = () => ({ status: 0, data: [{ traitOperations: [{ progress: 'COMPLETE', status: { code: 0 } }] }] });
function trait(resourceId, traitLabel, values, state = 'ACCEPTED') {
  return { traitId: { resourceId, traitLabel }, stateTypes: [state], patch: { values: structuredClone(values) } };
}
async function setup(context, options = {}) {
  let callbacks = new Map();
  let registered = [];
  let removed = [];
  let commands = [];
  let consume;
  let auth;
  let device;
  let pending = Promise.withResolvers();
  let connection = {
    name: 'Test',
    referer: 'home.invalid',
    restAPIHost: 'rest.invalid',
    transport_url: 'https://transport.invalid',
    token: 'fixture-token',
    userID: 'fixture-user',
    type: 'Google',
    authorised: true,
    snapshotWaiters: new Map(),
    grpcTransport: {
      observe: (...args) => {
        consume = args.at(-1);
        return pending.promise;
      },
      command: async (...args) => {
        commands.push(args);
        return success();
      },
    },
  };
  let connections = new Map([['account', connection]]);
  connections.start = () => {};
  connections.shutdown = () => {
    connection.authorised = false;
    pending.resolve({ status: 0 });
  };
  context.mock.method(Connections, 'fromConfig', (config, supplied) => {
    auth = supplied.onAuthorised;
    return connections;
  });
  let original = Thermostat.prototype.onUpdate;
  context.mock.method(Thermostat.prototype, 'onUpdate', function (data) {
    device = this;
    return original.call(this, data);
  });
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
  let diagnostics = [];
  let log = Object.fromEntries(['debug', 'info', 'warn', 'error', 'success'].map((level) => [level, (...args) => diagnostics.push(args)]));
  let platform = new Platform(log, { options: { useNestAPI: false, eveHistory: false }, ...options }, api);
  context.after(async () => {
    if (device !== undefined) {
      await device.remove();
    }
    for (let callback of callbacks.get('shutdown') ?? []) {
      await callback();
    }
  });
  for (let callback of callbacks.get('didFinishLaunching')) {
    await callback();
  }
  await auth('account', connection);
  assert.equal(typeof consume, 'function', JSON.stringify(diagnostics));
  let serialNumber = 'FLOW-' + nextSerial++;
  let values = {
    device_identity: { serialNumber, softwareVersion: '1.0.0' },
    device_info: { typeName: 'nest.resource.NestLearningThermostat3Resource', pairerId: { resourceId: 'STRUCTURE_HOME' } },
    configuration_done: { deviceReady: true },
    label: { label: 'Kitchen' },
    display_settings: { temperatureScale: 'TEMPERATURE_SCALE_C' },
    liveness: { status: 'LIVENESS_DEVICE_STATUS_ONLINE' },
    hvac_equipment_capabilities: { hasStage1Heat: true, hasStage1Cool: true },
    current_temperature: { temperatureValue: { temperature: { value: 21 } } },
    target_temperature_settings: {
      enabled: { value: true },
      targetTemperature: { setpointType: 'SET_POINT_TYPE_HEAT', heatingTarget: { value: 20 }, coolingTarget: { value: 24 } },
    },
    eco_mode_state: { ecoMode: 'ECO_MODE_INACTIVE' },
    battery_voltage: { batteryValue: { batteryVoltage: { value: 3.9 } } },
    current_humidity: { humidityValue: { humidity: { value: 45 } } },
  };
  await consume({ traitStates: [trait('STRUCTURE_HOME', 'structure_info', { name: 'Home' })] });
  return {
    platform,
    values,
    connection,
    registered,
    removed,
    commands,
    send: (traits) => consume({ traitStates: traits }),
    consume,
    get device() {
      return device;
    },
  };
}

test('split Observe traits create one thermostat, publish remote Off, then remove the same accessory', async (context) => {
  let flow = await setup(context);
  for (let [label, values] of Object.entries(flow.values)) {
    await flow.send([trait('DEVICE_THERMOSTAT', label, values)]);
  }
  assert.equal(flow.registered.length, 1);
  assert.equal(flow.device.deviceData.serialNumber, flow.values.device_identity.serialNumber);
  let accessory = flow.device.accessory;
  let target = flow.device.thermostatService.getCharacteristic(hap.Characteristic.TargetHeatingCoolingState);
  assert.equal(target.value, hap.Characteristic.TargetHeatingCoolingState.HEAT);
  await flow.send([
    trait('DEVICE_THERMOSTAT', 'target_temperature_settings', {
      ...flow.values.target_temperature_settings,
      enabled: { value: false },
    }),
  ]);
  assert.equal(target.value, hap.Characteristic.TargetHeatingCoolingState.OFF);
  assert.equal(flow.device.deviceData.can_heat, true);
  assert.equal(flow.device.deviceData.can_cool, true);
  assert.equal(flow.device.accessory, accessory);
  assert.deepEqual(flow.commands, []);
  await flow.consume({ resourceMetas: [{ resourceId: 'DEVICE_THERMOSTAT', status: 'REMOVED' }] });
  assert.deepEqual(flow.removed, [accessory]);
});

test('accepted Observe state wins over confirmed state regardless of arrival order', async (context) => {
  let flow = await setup(context);
  await flow.send(Object.entries(flow.values).map(([label, values]) => trait('DEVICE_THERMOSTAT', label, values)));
  for (let reverse of [true, false]) {
    let states = [
      trait('DEVICE_THERMOSTAT', 'current_temperature', { temperatureValue: { temperature: { value: 19 } } }, 'CONFIRMED'),
      trait('DEVICE_THERMOSTAT', 'current_temperature', { temperatureValue: { temperature: { value: 23 } } }),
    ];
    await flow.send(reverse === true ? states.reverse() : states);
    assert.equal(flow.device.deviceData.current_temperature, 23);
    assert.equal(flow.device.thermostatService.getCharacteristic(hap.Characteristic.CurrentTemperature).value, 23);
  }
  assert.equal(flow.registered.length, 1);
});

test('HomeKit SET completes the real command route and rejects failed cloud writes without committing data', async (context) => {
  let flow = await setup(context);
  await flow.send(Object.entries(flow.values).map(([label, values]) => trait('DEVICE_THERMOSTAT', label, values)));
  await flow.device.set({ uuid: 'DEVICE_THERMOSTAT', temperature_scale: 'F' });
  assert.equal(flow.device.deviceData.temperature_scale, 'F');
  assert.equal(flow.commands.length, 1);
  assert.equal(flow.commands[0][2], 'BatchUpdateState');
  assert.equal(flow.commands[0][3].batchUpdateStateRequest[0].traitRequest.resourceId, 'DEVICE_THERMOSTAT');
  flow.connection.grpcTransport.command = async () => ({ status: 14 });
  await assert.rejects(flow.device.set({ uuid: 'DEVICE_THERMOSTAT', temperature_scale: 'C' }), AggregateError);
  assert.equal(flow.device.deviceData.temperature_scale, 'F');
  flow.connection.grpcTransport.command = async () => success();
  await flow.device.set({ uuid: 'DEVICE_THERMOSTAT', temperature_scale: 'C' });
  assert.equal(flow.device.deviceData.temperature_scale, 'C');
  await setImmediate();
  assert.equal(flow.registered.length, 1);
});

test('retained Nest REST ingestion creates Protect and ignores retired thermostat/sensor buckets', { timeout: 2000 }, async (context) => {
  let { default: Protect } = await importSource(new URL('../src/plugins/protect.js', import.meta.url));
  let protect;
  let ready = Promise.withResolvers();
  let original = Protect.prototype.onUpdate;
  context.mock.method(Protect.prototype, 'onUpdate', function (data) {
    protect = this;
    let result = original.call(this, data);
    ready.resolve();
    return result;
  });
  let requests = [];
  let buckets = [
    ['where.home', { wheres: [{ where_id: 'ROOM', name: 'Kitchen' }] }],
    ['safety.home', { manual_self_test_in_progress: false }],
    ['widget_track.AABB', { online: true }],
    [
      'topaz.REST',
      {
        serial_number: 'REST_PROTECT',
        structure_id: 'home',
        where_id: 'ROOM',
        software_version: '1.0.0',
        description: 'Protect',
        thread_mac_address: 'aabb',
        smoke_status: 0,
        co_status: 0,
        replace_by_date_utc_secs: 2000000000,
        component_smoke_test_passed: true,
        component_co_test_passed: true,
      },
    ],
    ['device.RETIRED', { serial_number: 'RETIRED', hvac_mode: 'heat' }],
    ['kryptonite.RETIRED', { serial_number: 'RETIRED_SENSOR' }],
  ];
  context.mock.method(globalThis, 'fetch', async (url) => {
    requests.push(String(url));
    return new Response(JSON.stringify({ updated_buckets: buckets.map(([object_key, value]) => ({ object_key, value })) }));
  });
  // The test account supplies only fixture credentials and never opens a real remote connection.
  let flow = await setup(context, { options: { useNestAPI: true, eveHistory: false } });
  context.after(() => protect?.remove());
  await ready.promise;
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0]).hostname, 'rest.invalid');
  assert.equal(flow.registered.length, 1);
  assert.equal(protect.deviceData.serialNumber, 'REST_PROTECT');
  assert.equal(protect.smokeService.getCharacteristic(hap.Characteristic.SmokeDetected).value, 0);
  assert.equal(protect.smokeService.getCharacteristic(hap.Characteristic.StatusActive).value, true);
});

test('Eco translation normalises Observe states, including missing and unknown values', async (context) => {
  let flow = await setup(context);
  delete flow.values.eco_mode_state;
  await flow.send(Object.entries(flow.values).map(([label, values]) => trait('DEVICE_THERMOSTAT', label, values)));
  assert.equal(flow.device.deviceData.eco_mode, 'unknown');
  let control = flow.device.thermostatService.getCharacteristic(hap.Characteristic.EcoMode);
  await assert.rejects(control.handleGetRequest(), (error) => error === hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  for (let [mode, expected] of [
    ['ECO_MODE_INACTIVE', 'off'],
    ['ECO_MODE_MANUAL_ECO', 'manual'],
    ['ECO_MODE_AUTO_ECO', 'auto'],
    [null, 'unknown'],
    ['ECO_MODE_UNSPECIFIED', 'unknown'],
    ['ECO_MODE_UNKNOWN', 'unknown'],
    ['ECO_MODE_INACTIVE', 'off'],
  ]) {
    await flow.send([trait('DEVICE_THERMOSTAT', 'eco_mode_state', { ecoMode: mode })]);
    assert.equal(flow.device.deviceData.eco_mode, expected);
    if (expected === 'unknown') {
      await assert.rejects(control.handleGetRequest(), (error) => error === hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      await assert.rejects(control.handleSetRequest(true), (error) => error === hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    } else {
      assert.equal(await control.handleGetRequest(), expected !== 'off');
    }
  }
  assert.deepEqual(flow.commands, []);
});

test('Eco characteristic writes use the existing command path and publish accepted state', async (context) => {
  let flow = await setup(context);
  await flow.send(Object.entries(flow.values).map(([label, values]) => trait('DEVICE_THERMOSTAT', label, values)));
  let control = flow.device.thermostatService.getCharacteristic(hap.Characteristic.EcoMode);
  let notifications = [];
  control.on('change', (change) => notifications.push(change.newValue));
  assert.equal(await control.handleGetRequest(), false);
  for (let [value, mode] of [
    [1, 'manual'],
    [0, 'off'],
  ]) {
    await control.handleSetRequest(value, {});
    assert.equal(flow.device.deviceData.eco_mode, mode);
    assert.equal(await control.handleGetRequest(), value === 1);
    assert.equal(flow.commands.at(-1)[3].resourceRequest.resourceId, 'DEVICE_THERMOSTAT');
    assert.equal(
      flow.commands.at(-1)[3].resourceCommands[0].command.value.ecoMode,
      value === 1 ? 'ECO_MODE_MANUAL_ECO' : 'ECO_MODE_INACTIVE',
    );
  }
  await flow.send([trait('DEVICE_THERMOSTAT', 'eco_mode_state', { ecoMode: 'ECO_MODE_AUTO_ECO' })]);
  assert.equal(await control.handleGetRequest(), true);
  await control.handleSetRequest(false);
  assert.equal(flow.device.deviceData.eco_mode, 'off');
  assert.equal(await control.handleGetRequest(), false);
  assert.equal(flow.commands.length, 3, 'Observe changes must not echo commands');
  assert.deepEqual(notifications, [true, false, true, false]);
  await flow.send([trait('DEVICE_THERMOSTAT', 'eco_mode_state', { ecoMode: 'ECO_MODE_AUTO_ECO' })]);
  await control.handleSetRequest(true);
  assert.equal(flow.device.deviceData.eco_mode, 'manual', 'On explicitly selects manual Eco even when automatic Eco is active');
  assert.equal(await control.handleGetRequest(), true);
  assert.equal(flow.commands.at(-1)[3].resourceCommands[0].command.value.ecoMode, 'ECO_MODE_MANUAL_ECO');
  assert.equal(flow.commands.length, 4);
  assert.equal(flow.device.deviceData.target_temperature_low, 20);
  assert.equal(flow.device.deviceData.target_temperature_high, 24);
});

test('Eco characteristic waits for command acceptance and reports failures without changing state', async (context) => {
  let flow = await setup(context);
  await flow.send(Object.entries(flow.values).map(([label, values]) => trait('DEVICE_THERMOSTAT', label, values)));
  let control = flow.device.thermostatService.getCharacteristic(hap.Characteristic.EcoMode);
  let command = flow.connection.grpcTransport.command;
  let started = Promise.withResolvers();
  let response = Promise.withResolvers();
  flow.connection.grpcTransport.command = () => {
    started.resolve();
    return response.promise;
  };
  let rejected = assert.rejects(control.handleSetRequest(true), (error) => error === hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  await started.promise;
  assert.equal(flow.device.deviceData.eco_mode, 'off');
  assert.equal(control.value, false);
  response.resolve({ status: 4 });
  await rejected;
  assert.equal(flow.device.deviceData.eco_mode, 'off');
  assert.equal(control.value, false);
  assert.equal(await control.handleGetRequest(), false, 'A failed write must not hide known device state');
  flow.connection.grpcTransport.command = command;
  await control.handleSetRequest(true);
  assert.equal(await control.handleGetRequest(), true);
  flow.connection.grpcTransport.command = async () => ({
    status: 0,
    data: [{ traitOperations: [{ progress: 'COMPLETE', status: { code: 7 } }] }],
  });
  await assert.rejects(control.handleSetRequest(false), (error) => error === hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  assert.equal(flow.device.deviceData.eco_mode, 'manual');
  assert.equal(control.value, true);
  assert.equal(await control.handleGetRequest(), true, 'A rejected command must not poison subsequent reads');
  await flow.send([trait('DEVICE_THERMOSTAT', 'eco_mode_state', { ecoMode: 'ECO_MODE_INACTIVE' })]);
  assert.equal(await control.handleGetRequest(), false);
});

test('Eco characteristic blocks unavailable devices and recovers from upstream state', async (context) => {
  let flow = await setup(context);
  await flow.send(Object.entries(flow.values).map(([label, values]) => trait('DEVICE_THERMOSTAT', label, values)));
  let control = flow.device.thermostatService.getCharacteristic(hap.Characteristic.EcoMode);
  for (let data of [
    { online: false, removed_from_base: false, eco_mode: 'manual' },
    { online: true, removed_from_base: true, eco_mode: 'manual' },
    { online: true, removed_from_base: false, eco_mode: 'unknown' },
  ]) {
    await flow.device.update(data);
    await assert.rejects(control.handleGetRequest(), (error) => error === hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    for (let value of [false, true]) {
      await assert.rejects(control.handleSetRequest(value), (error) => error === hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    await flow.device.update({ online: true, removed_from_base: false, eco_mode: 'auto' });
    assert.equal(await control.handleGetRequest(), true);
  }
  assert.deepEqual(flow.commands, []);
});

test('Eco commands target one thermostat, commit accepted state and reconcile Observe updates', async (context) => {
  let flow = await setup(context);
  await flow.send(Object.entries(flow.values).map(([label, values]) => trait('DEVICE_THERMOSTAT', label, values)));
  for (let [value, mode] of [
    ['manual', 'ECO_MODE_MANUAL_ECO'],
    ['auto', 'ECO_MODE_AUTO_ECO'],
    ['off', 'ECO_MODE_INACTIVE'],
    ['MANUAL', 'ECO_MODE_MANUAL_ECO'],
    ['AUTO', 'ECO_MODE_AUTO_ECO'],
    ['OFF', 'ECO_MODE_INACTIVE'],
    ['mAnUaL', 'ECO_MODE_MANUAL_ECO'],
    ['aUtO', 'ECO_MODE_AUTO_ECO'],
    ['oFf', 'ECO_MODE_INACTIVE'],
  ]) {
    await flow.device.set({ uuid: 'DEVICE_THERMOSTAT', eco_mode: value });
    let [namespace, api, method, request] = flow.commands.at(-1);
    assert.deepEqual([namespace, api, method], ['nestlabs.gateway.v1.', 'ResourceApi', 'SendCommand']);
    assert.equal(request.resourceRequest.resourceId, 'DEVICE_THERMOSTAT');
    assert.equal(request.resourceCommands.length, 1);
    let command = request.resourceCommands[0];
    assert.equal(command.traitLabel, 'eco_mode_state');
    assert.equal(command.command.type_url, 'type.nestlabs.com/nest.trait.hvac.EcoModeStateTrait.EcoModeChangeRequest');
    assert.equal(command.command.value.ecoMode, mode);
    assert.equal(command.command.value.setAll, false);
    assert.equal(command.command.value.ecoModeActor.method, 'HVAC_ACTOR_METHOD_IOS');
    assert.equal(command.command.value.ecoModeActor.originator.resourceId, 'DEVICE_THERMOSTAT');
    assert.equal(flow.device.deviceData.eco_mode, value, 'Accepted SET commits the requested value, matching HVAC mode');
    await flow.send([trait('DEVICE_THERMOSTAT', 'eco_mode_state', { ecoMode: mode })]);
    assert.equal(flow.device.deviceData.eco_mode, value.toLowerCase(), 'Observe restores canonical lowercase state');
  }
  await flow.send([trait('DEVICE_THERMOSTAT', 'eco_mode_state', { ecoMode: 'ECO_MODE_AUTO_ECO' })]);
  await flow.device.set({ uuid: 'DEVICE_THERMOSTAT', eco_mode: 'off' });
  assert.equal(flow.commands.at(-1)[3].resourceCommands[0].command.value.ecoMode, 'ECO_MODE_INACTIVE');
  assert.equal(flow.device.deviceData.eco_mode, 'off');
  await flow.send([trait('DEVICE_THERMOSTAT', 'eco_mode_state', { ecoMode: 'ECO_MODE_AUTO_ECO' })]);
  assert.equal(flow.device.deviceData.eco_mode, 'auto', 'Observe overrides the optimistic state');
  assert.equal(flow.commands.length, 10, 'Observe changes must not send commands');
  assert.equal(flow.device.deviceData.target_temperature_low, 20);
  assert.equal(flow.device.deviceData.target_temperature_high, 24);
});

test('Eco command failures preserve state and allow a subsequent command', async (context) => {
  let flow = await setup(context);
  await flow.send(Object.entries(flow.values).map(([label, values]) => trait('DEVICE_THERMOSTAT', label, values)));
  let command = flow.connection.grpcTransport.command;
  for (let response of [
    { status: 14 },
    { status: 0, data: [] },
    { status: 0, data: [{ traitOperations: [{ progress: 'PENDING' }] }] },
    { status: 0, data: [{ traitOperations: [{ progress: 'COMPLETE', status: { code: 7 } }] }] },
  ]) {
    flow.connection.grpcTransport.command = async () => response;
    await assert.rejects(flow.device.set({ uuid: 'DEVICE_THERMOSTAT', eco_mode: 'manual' }), AggregateError);
    assert.equal(flow.device.deviceData.eco_mode, 'off');
  }
  flow.connection.grpcTransport.command = command;
  await flow.device.set({ uuid: 'DEVICE_THERMOSTAT', eco_mode: 'manual' });
  assert.equal(flow.commands.length, 1);
  assert.equal(flow.device.deviceData.eco_mode, 'manual');
  await flow.send([trait('DEVICE_THERMOSTAT', 'eco_mode_state', { ecoMode: 'ECO_MODE_INACTIVE' })]);
  assert.equal(flow.device.deviceData.eco_mode, 'off');
});

for (let value of ['unknown', true, 'ECO_MODE_AUTO_ECO']) {
  test('invalid Eco SET preserves existing accessory state: ' + value, async (context) => {
    let flow = await setup(context);
    await flow.send(Object.entries(flow.values).map(([label, values]) => trait('DEVICE_THERMOSTAT', label, values)));
    await assert.rejects(flow.device.set({ uuid: 'DEVICE_THERMOSTAT', eco_mode: value }), AggregateError);
    assert.equal(flow.device.deviceData.eco_mode, 'off');
    assert.deepEqual(flow.commands, []);
  });
}
