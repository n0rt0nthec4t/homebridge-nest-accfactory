// Verify redaction at the log boundary, stable aliases, delta selection, and diagnostic limits.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { format } from 'node:util';
import test from 'node:test';
import { createSupportDump } from '../src/supportdump.js';
import { DATA_SOURCE } from '../src/consts.js';

function capture() {
  let lines = [];
  let warnings = [];
  let dump = createSupportDump({ info: (...args) => lines.push(format(...args)), warn: (...args) => warnings.push(format(...args)) });
  return { dump, lines, warnings };
}

test('full Nest and Google dumps redact private values and retain state and cross-references', () => {
  let fixture = {
    'device.SERIAL00000001': {
      connection: 'account',
      source: DATA_SOURCE.NEST,
      value: {
        serial_number: 'SERIAL00000001',
        structure_id: 'HOME00000001',
        associated_rcs_sensors: ['kryptonite.SENSOR000001'],
        capabilities: ['heat', 'cool'],
        online: true,
        temperature: 21.5,
        software_version: '1.2.3.4',
        model: 'Learning Thermostat',
        description: 'Private Bedroom',
        postal_code: 'Private Postcode',
        cookie: 'Secret Cookie',
        access_token: 'Secret Access Token',
        topaz_hush_key: 'Secret Hush Key',
        last_ip: '192.0.2.10',
        mac_address: 'aa:bb:cc:dd:ee:ff',
        properties: { 'camera.pairing_token': 'Secret Pairing Token' },
      },
    },
    DEVICE_GOOGLE00001: {
      connection: 'account',
      source: DATA_SOURCE.GOOGLE,
      value: {
        device_identity: { serialNumber: 'SERIAL00000001', softwareVersion: '1.2.3.4' },
        pairer: { resourceId: 'STRUCTURE_HOME00000001' },
        network: { macAddress: Buffer.from('aabbccddeeff', 'hex'), networkName: 'Private Wifi' },
        settings: { pairingToken: 'Secret Pairing Token', userPincodes: [{ pinHash: 'Secret PIN' }] },
        located: { whereLabel: { literal: 'Private Room' }, fixtureNameLabel: { literal: 'Private Fixture' } },
        other: { endpoint: 'rtsps://private-camera.invalid/live', address: '2001:db8::1' },
        current_temperature: { value: 22 },
        referenceBeforeDefinition: 'Related: SERIAL00000001 and SENSOR000001',
        sensorSerialNumber: 'SENSOR000001',
      },
    },
    'device.OTHER00000001': { connection: 'other', source: DATA_SOURCE.NEST, value: { temperature: 100, secret: 'Other Account Secret' } },
  };
  let before = JSON.stringify(fixture);
  let output = capture();
  output.dump(fixture, 'account');
  let text = output.lines.join('\n');
  for (let secret of [
    'SERIAL00000001',
    'SENSOR000001',
    'HOME00000001',
    'GOOGLE00001',
    'OTHER00000001',
    'Private Bedroom',
    'Private Postcode',
    'Secret Cookie',
    'Secret Access Token',
    'Secret Hush Key',
    'Secret Pairing Token',
    'Private Wifi',
    'Secret PIN',
    'Private Room',
    'Private Fixture',
    'private-camera.invalid',
    '2001:db8::1',
    '192.0.2.10',
    'aa:bb:cc:dd:ee:ff',
  ]) {
    assert.equal(text.includes(secret), false, secret);
  }
  let serialAlias = text.match(/"serial_number": "([^"]+)"/)[1];
  assert.equal(text.includes('"device.' + serialAlias + '"'), true);
  assert.equal(text.includes('"serialNumber": "' + serialAlias + '"'), true);
  assert.equal(text.includes('Related: ' + serialAlias), true);
  for (let useful of ['Learning Thermostat', '1.2.3.4', '21.5', '22', '"online": true', '"heat"', '"cool"']) {
    assert.equal(text.includes(useful), true, useful);
  }
  assert.equal(JSON.stringify(fixture), before);
  assert.deepEqual(output.warnings, []);
});

test('structure-mode enums remain readable while structure references and private fields stay redacted', () => {
  let output = capture();
  output.dump(
    {
      STRUCTURE_PRIVATEHOME: {
        connection: 'account',
        source: DATA_SOURCE.GOOGLE,
        value: {
          structure_mode: {
            structureMode: 'STRUCTURE_MODE_HOME',
            activityAgnosticStructureMode: 'STRUCTURE_MODE_AWAY',
            structureModeReason: 'STRUCTURE_MODE_REASON_EXPLICIT_INTENT',
            actorMethod: 'STRUCTURE_MODE_ACTOR_METHOD_GOOGLE_HOME_APP',
            occupancy: { activity: 'ACTIVITY_ACTIVE', presence: 'PRESENCE_UNAVAILABLE' },
            resourceId: 'STRUCTURE_PRIVATEHOME',
            otherReference: 'STRUCTURE_MODE_PRIVATEHOME',
            access_token: 'STRUCTURE_MODE_HOME',
          },
        },
      },
    },
    'account',
  );
  let text = output.lines.join('\n');
  for (let state of [
    'STRUCTURE_MODE_HOME',
    'STRUCTURE_MODE_AWAY',
    'STRUCTURE_MODE_REASON_EXPLICIT_INTENT',
    'STRUCTURE_MODE_ACTOR_METHOD_GOOGLE_HOME_APP',
    'ACTIVITY_ACTIVE',
    'PRESENCE_UNAVAILABLE',
  ]) {
    assert.equal(text.includes(state), true, state);
  }
  assert.equal(text.includes('PRIVATEHOME'), false);
  assert.equal(text.includes('"access_token": "**REDACTED**"'), true);
  assert.deepEqual(output.warnings, []);
});

test('delta dumps select changed fields and keep aliases stable as resources are added', () => {
  let output = capture();
  let raw = {
    'device.SERIAL00000002': {
      connection: 'account',
      source: DATA_SOURCE.NEST,
      value: { serial_number: 'SERIAL00000002', temperature: 20, humidity: 40 },
    },
  };
  output.dump(raw, 'account');
  let alias = output.lines.join('\n').match(/"serial_number": "([^"]+)"/)[1];
  output.lines.length = 0;
  raw['device.SERIAL00000001'] = { connection: 'account', source: DATA_SOURCE.NEST, value: { serial_number: 'SERIAL00000001' } };
  output.dump(raw, 'account');
  assert.equal(output.lines.join('\n').includes('"device.' + alias + '"'), true);
  output.lines.length = 0;
  output.dump(raw, 'account', new Map([['device.SERIAL00000002', { fields: new Set(['temperature']) }]]));
  let text = output.lines.join('\n');
  assert.equal(text.includes('Changed support dump'), true);
  assert.equal(text.includes('"device.' + alias + '"'), true);
  assert.equal(text.includes('"temperature": 20'), true);
  assert.equal(text.includes('humidity'), false);
  assert.equal(text.includes('serial_number'), false);
  output.lines.length = 0;
  output.dump(raw, 'account', new Map());
  assert.deepEqual(output.lines, []);
});

test('network values, nested resource keys and wrapped identifiers are redacted', () => {
  let output = capture();
  output.dump(
    {
      DEVICE_MAIN000001: {
        connection: 'account',
        source: DATA_SOURCE.GOOGLE,
        value: {
          wrapped: { resourceId: { value: 'PRIVATE000001' } },
          links: { 'device.NEST00000001': { peer: 'device.NEST00000001' } },
          unknown: ['192.0.2.1', '2001:db8::1', 'aa-bb-cc-dd-ee-ff', 'See https://private.invalid/image'],
          addresses: { '192.0.2.2': true, '1.2.3.4': true },
          firmwareVersion: '1.2.3.4',
          opaque: Buffer.from('Secret Binary'),
        },
      },
    },
    'account',
  );
  let text = output.lines.join('\n');
  for (let secret of [
    'MAIN000001',
    'PRIVATE000001',
    'NEST00000001',
    '192.0.2.',
    '2001:db8',
    'aa-bb-cc',
    'private.invalid',
    'Secret Binary',
  ]) {
    assert.equal(text.includes(secret), false, secret);
  }
  assert.equal(text.includes('1.2.3.4'), true);
  assert.deepEqual(output.warnings, []);
});

test('alias state belongs to each platform instance', () => {
  let first = capture();
  let second = capture();
  first.dump({ 'device.FIRST0000001': { connection: 'account', source: DATA_SOURCE.NEST, value: { online: true } } }, 'account');
  second.dump({ 'device.SECOND000001': { connection: 'account', source: DATA_SOURCE.NEST, value: { online: true } } }, 'account');
  assert.equal(first.lines.join('\n').includes('device.**REDACTED_1**'), true);
  assert.equal(second.lines.join('\n').includes('device.**REDACTED_1**'), true);
});

for (let failure of ['cycle', 'depth', 'nodes', 'string', 'output', 'identifiers', 'getter']) {
  test('unsafe ' + failure + ' data is omitted without raw logging', () => {
    let value = { access_token: 'Secret That Must Never Be Logged' };
    if (failure === 'cycle') {
      value.loop = value;
    } else if (failure === 'depth') {
      let item = value;
      for (let index = 0; index < 40; index++) {
        item.child = {};
        item = item.child;
      }
    } else if (failure === 'nodes') {
      value.items = Array.from({ length: 9000 }, () => 1);
    } else if (failure === 'string') {
      value.text = 'x'.repeat(5000);
    } else if (failure === 'output') {
      value.items = Array.from({ length: 100 }, () => 'x'.repeat(1000));
    } else if (failure === 'identifiers') {
      value.structureIds = Array.from({ length: 4200 }, (_, index) => 'IDENTIFIER_' + index);
    } else {
      Object.defineProperty(value, 'broken', {
        enumerable: true,
        get() {
          throw new Error('Secret Exception Text');
        },
      });
    }
    let output = capture();
    assert.doesNotThrow(() =>
      output.dump({ 'device.SERIAL00000001': { connection: 'account', source: DATA_SOURCE.NEST, value } }, 'account'),
    );
    assert.deepEqual(output.lines, []);
    assert.equal(output.warnings.length, 1);
    assert.equal(output.warnings[0].includes('Secret'), false);
  });
}

test('serialization cannot invoke a copied toJSON method that bypasses redaction', () => {
  let called = false;
  let output = capture();
  output.dump(
    {
      'device.SERIAL00000001': {
        connection: 'account',
        source: DATA_SOURCE.NEST,
        value: {
          settings: {
            token: 'Secret Token',
            toJSON: () => {
              called = true;
              return 'Secret Token';
            },
          },
        },
      },
    },
    'account',
  );
  assert.equal(called, false);
  assert.equal(output.lines.join('\n').includes('Secret Token'), false);
});
