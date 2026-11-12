// Verify camera history field structures against independently assembled wire bytes.
// The thumbnail URL is synthetic; timestamp bytes come from the 2026-11-10 capture.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { getProtoType } from '../src/protobuf.js';

let schema = fileURLToPath(new URL('../src/protobuf/root.proto', import.meta.url));
let response = getProtoType(schema, 'nest.trait.history.CameraObservationHistoryTrait.CameraObservationHistoryResponse');

test('camera history decodes wrapped thumbnail URL and unidentified timestamp from fixed wire bytes', () => {
  // Response field 1 contains window fields 8 (URLs, with wrapped field 5) and 11 (timestamp).
  let payload = Buffer.from(
    '0a3542252a230a2168747470733a2f2f6578616d706c652e696e76616c69642f7468756d626e61696c5a0c089386c9d70610d79e8eaf01',
    'hex',
  );
  assert.deepEqual(response.decode(payload).toJSON(), {
    cameraEventWindow: {
      timeWindowUrls: { thumbnailUrl: { value: 'https://example.invalid/thumbnail' } },
      unknown11: { seconds: '1794261779', nanos: 367234903 },
    },
  });
});

test('camera history preserves legacy URLs and skips unidentified scalar fields', () => {
  // Window: URLs.snapshotUrl = "old", unknown field 9 = 4, unknown field 14 = 2.
  let payload = Buffer.from('0a0d42070a036f6c64120048047002', 'hex');
  assert.deepEqual(response.decode(payload).toJSON(), {
    cameraEventWindow: { timeWindowUrls: { snapshotUrl: 'old', clipUrl: {} } },
  });
  let window = response.lookupType('CameraEventTimeWindow');
  assert.equal(window.fieldsById[9], undefined);
  assert.equal(window.fieldsById[14], undefined);
});
