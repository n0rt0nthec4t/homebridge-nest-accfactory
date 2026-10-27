// Lock custom HomeKit type identities independently of their display names or devices.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CUSTOM_CHARACTERISTIC_UUID } from '../src/consts.js';

test('custom characteristic UUIDs retain their permanent v5 identities', () => {
  // Changing a namespace or generation name must not silently change published identities.
  assert.deepEqual(CUSTOM_CHARACTERISTIC_UUID, {
    REPLACE_BY_DATE: '391ED041-9783-577A-81EB-4B6BFEE97869',
    ECO_MODE: '3EA35F7F-3CB1-5991-84B7-00B36A8CF698',
  });
});
