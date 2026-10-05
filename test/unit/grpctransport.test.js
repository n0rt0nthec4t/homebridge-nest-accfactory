// Exercise real protobuf framing and status handling without network connections.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import http2 from 'node:http2';
import { fileURLToPath, URL } from 'node:url';
import test from 'node:test';

import GrpcTransport from '../../src/grpctransport.js';
import { getProtoRoot } from '../../src/protobuf.js';

test('gRPC failures clean up only the request and preserve the pooled connection', async (t) => {
  for (let failure of ['clone', 'encode', 'write', 'stream']) {
    await t.test(failure, async (t) => {
      let opened = 0;
      let destroyed = 0;
      let session = new EventEmitter();
      session.ping = () => {};
      session.destroy = () => {
        session.destroyed = true;
        session.emit('close');
      };
      session.request = () => {
        opened++;
        let request = new EventEmitter();
        request.cork = request.uncork = () => {};
        request.write = () => {
          if (failure === 'write') throw new Error('Write failed');
        };
        request.end = () => globalThis.queueMicrotask(() => request.emit('error', new Error('Stream failed')));
        request.destroy = () => {
          destroyed++;
          request.emit('close');
        };
        return request;
      };
      t.mock.method(http2, 'connect', () => session);
      let transport = new GrpcTransport({
        protoPath: fileURLToPath(new URL('../../src/protobuf/root.proto', import.meta.url)),
        endpointHost: 'https://grpc-cleanup-test.invalid',
        getAuthHeader: () => 'test',
      });
      try {
        let values = failure === 'clone' ? { bad: () => {} } : failure === 'encode' ? { resourceRequest: 'invalid' } : {};
        let result = await transport.command('nestlabs.gateway.v1.', 'ResourceApi', 'SendCommand', values);
        assert.equal(result.status, GrpcTransport.STATUS.UNAVAILABLE);
        assert.equal(typeof result.error, 'string');
        assert.equal(opened, failure === 'clone' || failure === 'encode' ? 0 : 1);
        assert.equal(destroyed, opened);
        assert.notEqual(session.destroyed, true);
      } finally {
        transport.release();
      }
    });
  }
});

test('gRPC response buffering and terminal status handling', async (t) => {
  let protoPath = fileURLToPath(new URL('../../src/protobuf/root.proto', import.meta.url));
  let responseType = getProtoRoot(protoPath).lookupType('nestlabs.gateway.v1.SendCommandResponse');
  let expected = { resourceRequest: { resourceId: 'x'.repeat(20000) } };
  let payload = responseType.encode(responseType.fromObject(expected)).finish();
  let frame = Buffer.alloc(5 + payload.length);
  frame.writeUInt32BE(payload.length, 1);
  frame.set(payload, 5);
  let emptyFrame = Buffer.alloc(5);
  let cases = [
    { name: 'grows beyond one doubling', chunks: [frame], data: [expected] },
    {
      name: 'retains split header and payload',
      chunks: [frame.subarray(0, 2), frame.subarray(2, 8000), frame.subarray(8000)],
      data: [expected],
    },
    {
      name: 'compacts consumed frames before growth',
      chunks: [Buffer.concat([emptyFrame, frame.subarray(0, 100)]), frame.subarray(100)],
      data: [{}, expected],
    },
    { name: 'accepts exact buffer maximum', chunks: [frame], bufferMax: frame.length, data: [expected] },
    { name: 'rejects data above maximum', chunks: [frame], bufferMax: frame.length - 1, status: 8, code: 'BUFFER_LIMIT_EXCEEDED' },
    {
      name: 'rejects oversized advertised payload',
      chunks: [frame.subarray(0, 5)],
      bufferMax: 1000,
      status: 8,
      code: 'BUFFER_LIMIT_EXCEEDED',
    },
    { name: 'rejects compressed frames', chunks: [Buffer.from([1, 0, 0, 0, 0])], status: 12, code: 'GRPC_COMPRESSED_RESPONSE' },
    { name: 'preserves unary cancellation', chunks: [], trailerStatus: 1, status: 1, code: 'GRPC_STATUS_1' },
    { name: 'normalises observe cancellation', chunks: [], trailerStatus: 1, observe: true },
    { name: 'normalises expected observe deadline', chunks: [], trailerStatus: 4, trailerMessage: 'context timed out', observe: true },
    { name: 'preserves unexpected observe failure', chunks: [], trailerStatus: 14, observe: true, status: 14, code: 'GRPC_STATUS_14' },
  ];

  for (let scenario of cases) {
    await t.test(scenario.name, async (t) => {
      let session = new EventEmitter();
      session.ping = () => {};
      session.destroy = () => {
        session.destroyed = true;
        session.emit('close');
      };
      session.request = () => {
        let request = new EventEmitter();
        request.cork = request.uncork = request.write = request.destroy = () => {};
        request.close = () => {
          if (request.closed !== true) {
            request.closed = true;
            request.emit('close');
          }
        };
        // Deliver events after executeStream has installed its close listener.
        request.end = () =>
          globalThis.queueMicrotask(() => {
            request.emit('response', { ':status': 200, 'content-type': 'application/grpc' });
            for (let chunk of scenario.chunks) {
              request.emit('data', chunk);
            }
            request.emit('trailers', { 'grpc-status': String(scenario.trailerStatus ?? 0), 'grpc-message': scenario.trailerMessage ?? '' });
            request.close();
          });
        return request;
      };
      t.mock.method(http2, 'connect', () => session);
      let transport = new GrpcTransport({
        protoPath,
        endpointHost: 'https://grpc-test.invalid',
        getAuthHeader: () => 'test',
        bufferMax: scenario.bufferMax,
      });
      try {
        let result =
          scenario.observe === true
            ? await transport.observe('nestlabs.gateway.v1.', 'ResourceApi', 'SendCommand', {}, () => {})
            : await transport.command('nestlabs.gateway.v1.', 'ResourceApi', 'SendCommand', {});
        assert.equal(result.status, scenario.status ?? GrpcTransport.STATUS.OK);
        assert.equal(result.code, scenario.code);
        if (scenario.data !== undefined) {
          assert.deepEqual(result.data, scenario.data);
        }
      } finally {
        transport.release();
      }
      assert.equal(session.destroyed, true);
    });
  }
});
