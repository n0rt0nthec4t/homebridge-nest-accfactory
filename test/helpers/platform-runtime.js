// Test boundary for platform discovery and HTTP: the platform retains its real cache, routing and lifecycle.
import timers from 'node:timers';
import HomeKitDevice from '../../src/HomeKitDevice/HomeKitDevice.js';
import { DEVICE_CATEGORY_MAP } from '../../src/consts.js';
export function getDeviceHKCategory(type) {
  return DEVICE_CATEGORY_MAP[type] ?? 1;
}

export let runtime = {};
export function resetRuntime(options = {}) {
  runtime = { ...options, devices: [], messages: [], raw: undefined, timers: new Set() };
}
export async function fetchWrapper(...args) {
  return runtime.fetch(...args);
}
fetchWrapper.GET = 'get';
fetchWrapper.POST = 'post';

export async function loadDeviceModules() {
  class Device extends HomeKitDevice {
    static TYPE = runtime.type ?? 'Fixture';
    static VERSION = 'test';
    constructor(...args) {
      super(...args);
      runtime.devices.push(this);
    }

    onUpdate(data) {
      runtime.messages.push(structuredClone(data));
    }
  }
  return new Map([
    [
      Device.TYPE,
      {
        class: Device,
        processRawData(log, raw, config, type, changed) {
          runtime.raw = raw;
          if (typeof runtime.map === 'function') {
            return runtime.map(raw, changed);
          }
          let id = runtime.id ?? 'DEVICE_TEST';
          return raw[id] === undefined
            ? {}
            : {
                FIXTURE: {
                  full: true,
                  data: {
                    serialNumber: 'FIXTURE',
                    manufacturer: 'Nest',
                    model: 'Fixture',
                    softwareVersion: '1.0.0',
                    description: 'Fixture',
                    nest_google_device_uuid: id,
                    excluded: false,
                  },
                },
              };
        },
      },
    ],
  ]);
}

// Track test-owned platform timers so successful timeout races cannot keep the runner alive.
export function setTimeout(callback, delay) {
  let owned = runtime.timers;
  let handle = timers.setTimeout(() => {
    owned.delete(handle);
    callback();
  }, delay);
  owned.add(handle);
  return handle;
}
export function clearTimeout(handle) {
  runtime.timers?.delete(handle);
  timers.clearTimeout(handle);
}
export function clearTimers() {
  for (let handle of runtime.timers) {
    timers.clearTimeout(handle);
  }
  runtime.timers.clear();
}
