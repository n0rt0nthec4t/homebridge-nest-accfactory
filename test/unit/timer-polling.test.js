// Exercise the actual camera timer hook through the shared lifecycle queue.
// Media imports are isolated; GET routing, timer dispatch and UPDATE commits are real.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { URL } from 'node:url';
import HomeKitDevice from '../../src/HomeKitDevice/HomeKitDevice.js';
import { TIMERS } from '../../src/consts.js';

let modules = {};
for (let name of ['camera']) {
  let location = new URL('../../src/plugins/' + name + '.js', import.meta.url);
  let source = await readFile(location, 'utf8');
  source = source.replace(/from '([^']+)'/g, (match, specifier) => {
    let target = specifier === '../HomeKitDevice.js'
      ? new URL('../../src/HomeKitDevice/HomeKitDevice.js', import.meta.url).href
      : ['../streamer.js', '../nexustalk.js', '../webrtc.js', '../ffmpeg.js'].includes(specifier) === true
          ? 'data:text/javascript,export default class {}'
          : specifier.startsWith('.') === true ? new URL(specifier, location).href : specifier;
    return 'from ' + JSON.stringify(target);
  });
  modules[name] = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).default;
}

HomeKitDevice.PLUGIN_NAME = 'timer-polling-test';
let api = { version: 2.7, hap: { uuid: { generate: (value) => value } } };

for (let name of ['camera']) {
  test(name + ' timer polls with real GET routing and commits the returned UPDATE', { timeout: 2000 }, async (context) => {
    let device = new HomeKitDevice(undefined, api, {
      serialNumber: name, softwareVersion: '1.0.0', description: name, manufacturer: 'Nest', model: name,
      nest_google_device_uuid: 'upstream-' + name,
    });
    context.after(() => device.remove());
    // Use the production hook on a shared device without starting media or HAP services.
    device.onTimer = modules[name].prototype.onTimer;
    let updated = Promise.withResolvers();
    let queries = [];
    let events = [{ id: 'motion-1' }];
    await HomeKitDevice.message(device.uuid, HomeKitDevice.GET, async (query) => {
      queries.push(query);
      return { camera_events: events };
    });
    device.onUpdate = () => updated.resolve();
    let timer = TIMERS.CAMERA_EVENTS.name;
    device.addTimer(timer, { delay: 1 });
    await updated.promise;
    // Wait behind the UPDATE so the assertions observe the committed state.
    await device.message('polling-complete');
    assert.deepEqual(queries, [{ uuid: 'upstream-' + name, camera_events: true }]);
    assert.deepEqual(device.deviceData.events, events);
  });
}
