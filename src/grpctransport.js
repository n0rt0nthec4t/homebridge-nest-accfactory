// GrpcTransport
// Part of homebridge-nest-accfactory
//
// Handles protobuf-based gRPC communication with Google endpoints over HTTP/2.
//
// Responsibilities:
// - Load and manage protobuf schema definitions
// - Encode request messages and frame them using gRPC wire format
// - Parse and decode streaming gRPC responses (5-byte framed messages)
// - Manage pooled HTTP/2 sessions with keepalive (ping)
// - Handle request lifecycle including timeouts, errors, trailers, and cleanup
//
// Scope:
// - Designed for Google Home / Foyer / Gateway style APIs using protobuf + gRPC
// - Supports unary requests and streaming-style responses via incremental frame parsing
//
// Notes:
// - Compression is not supported. Only uncompressed gRPC frames are accepted
// - Authentication is supplied dynamically via getAuthHeader()
// - HTTP/2 sessions are pooled and reused by either:
//   - endpoint + logical connection uuid, when uuid is supplied
//   - endpoint + auth identity, when uuid is not supplied
// - Different logical connections must not accidentally share the same session
//
// Code version 2026.04.13
// Mark Hulskamp
'use strict';

// Define external module requirements
import protobuf from 'protobufjs';

// Define nodejs module requirements
import EventEmitter from 'node:events';
import http2 from 'node:http2';
import { Buffer } from 'node:buffer';
import { setInterval, clearInterval, setTimeout, clearTimeout } from 'node:timers';
import fs from 'node:fs';
import crypto from 'node:crypto';

// GrpcTransport class definition
export default class GrpcTransport {
  // Static pool of HTTP/2 sessions.
  // Sessions are keyed so that:
  // - the same logical connection can reuse an existing connection
  // - different auth identities to the same host do not accidentally share one
  //
  // sessionKey => {
  //   session: ClientHttp2Session,
  //   pingTimer: Timeout,
  //   refCount: number,
  //   endpointHost: string
  // }
  static #sessionPool = new Map();

  log = undefined;

  // Internal data only for this class
  #protobufRoot = undefined;
  #session = undefined;
  #sessionKey = '';
  #attachedSessionKey = '';

  #endpointHost = '';
  #userAgent = '';
  #requestTimeout = 15000;

  #bufferInitial = 8 * 1024;
  #bufferMax = 10 * 1024 * 1024;
  #pingInterval = 60000;

  #uuid = '';
  #getAuthHeader = undefined;

  constructor(options = {}) {
    // Configure transport instance for one gRPC endpoint + protobuf schema.
    // Protobuf schema is loaded once here and reused for all later requests.
    this.log = options?.log;
    this.#userAgent = typeof options?.userAgent === 'string' ? options.userAgent : '';
    this.#getAuthHeader = typeof options?.getAuthHeader === 'function' ? options.getAuthHeader : undefined;
    this.#uuid = typeof options?.uuid === 'string' ? options.uuid.trim() : '';

    let endpointHost = options?.endpointHost ?? options?.apiHost;

    if (typeof endpointHost === 'object' && endpointHost !== null && typeof endpointHost.origin === 'string') {
      this.#endpointHost = endpointHost.origin;
    }

    if (typeof endpointHost === 'string' && endpointHost.trim() !== '') {
      try {
        let endpointUrl = new globalThis.URL(endpointHost);
        this.#endpointHost = endpointUrl.origin;
      } catch {
        // Empty
      }
    }

    if (typeof options?.requestTimeout === 'number' && options.requestTimeout > 0) {
      this.#requestTimeout = options.requestTimeout;
    }

    if (typeof options?.bufferInitial === 'number' && options.bufferInitial > 0) {
      this.#bufferInitial = options.bufferInitial;
    }

    if (typeof options?.bufferMax === 'number' && options.bufferMax > 0) {
      this.#bufferMax = options.bufferMax;
    }

    if (typeof options?.pingInterval === 'number' && options.pingInterval > 0) {
      this.#pingInterval = options.pingInterval;
    }

    // Build an initial session key.
    // For uuid-based pooling this is stable for the life of the instance.
    // For auth-based pooling this may be refreshed before each request.
    this.#sessionKey = this.#buildSessionKey();

    // Load protobuf schema once. Session creation is lazy and happens on first request.
    let protoPath = typeof options?.protoPath === 'string' ? options.protoPath : '';

    if (protoPath !== '' && fs.existsSync(protoPath) === true) {
      protobuf.util.Long = null;
      protobuf.configure();
      this.#protobufRoot = protobuf.loadSync(protoPath);
      return;
    }

    this.log?.debug?.('gRPC proto file not found: %s', protoPath);
  }

  release() {
    let pool = GrpcTransport.#sessionPool;
    let attachedSessionKey = this.#attachedSessionKey;
    let entry = pool.get(attachedSessionKey);

    // Nothing attached for this instance
    if (attachedSessionKey === '') {
      return;
    }

    // Release this instance's reference to the pooled session.
    // The underlying session stays alive until the final transport releases it.
    if (entry !== undefined) {
      entry.refCount--;

      if (entry.refCount <= 0) {
        clearInterval(entry.pingTimer);

        try {
          entry.session.destroy();
        } catch {
          // Empty
        }

        pool.delete(attachedSessionKey);
        this.log?.debug?.('Destroyed pooled gRPC session for "%s"', entry.endpointHost);
      }
    }

    this.#session = undefined;
    this.#attachedSessionKey = '';
  }

  #buildSessionKey() {
    let authHeader = '';
    let authHash = '';

    // If a logical connection uuid is supplied, prefer that.
    // This gives stable pooling per configured connection/account.
    if (this.#uuid !== '') {
      return this.#endpointHost + '|' + this.#uuid;
    }

    // Otherwise build a stable pool key from endpoint + auth identity.
    // Use a hash of the auth header so we do not store raw credentials in the pool key.
    if (typeof this.#getAuthHeader === 'function') {
      try {
        authHeader = this.#getAuthHeader();
      } catch {
        authHeader = '';
      }
    }

    if (typeof authHeader === 'string' && authHeader.trim() !== '') {
      authHash = crypto.createHash('sha256').update(authHeader).digest('hex');
    }

    return this.#endpointHost + '|' + authHash;
  }

  #buildGrpcFrame(payload) {
    // Build one gRPC wire-format frame:
    // [0]     = compression flag (0 = uncompressed)
    // [1..4]  = payload size (uint32 big-endian)
    // [5..n]  = protobuf-encoded payload
    let frame = Buffer.allocUnsafe(5 + payload.length);

    frame.writeUInt8(0, 0);
    frame.writeUInt32BE(payload.length, 1);
    payload.copy(frame, 5);

    return frame;
  }

  #encodeAnyValues(object) {
    if (typeof object !== 'object' || object === null) {
      return;
    }

    // Protobuf Any:
    // If the caller supplied a plain JS object for value, encode it into bytes
    // using the concrete type referenced by type_url.
    if (typeof object.type_url === 'string' && object.value !== undefined && Buffer.isBuffer(object.value) === false) {
      let typeName = object.type_url.split('/')[1];

      if (typeof typeName === 'string' && typeName !== '') {
        let anyType = this.#protobufRoot?.lookup?.(typeName);

        if (anyType !== null && anyType !== undefined) {
          object.value = anyType.encode(anyType.fromObject(object.value)).finish();
        }
      }
    }

    for (let key in object) {
      if (object[key] !== undefined) {
        this.#encodeAnyValues(object[key]);
      }
    }
  }

  #ensureSession() {
    let pool = GrpcTransport.#sessionPool;
    let sessionKey = this.#sessionKey;
    let entry = pool.get(sessionKey);
    let session = undefined;

    // Reuse pooled HTTP/2 session if it is still valid.
    if (entry === undefined || entry.session.destroyed === true || entry.session.closed === true) {
      session = http2.connect(this.#endpointHost);

      entry = {
        session: session,
        pingTimer: undefined,
        refCount: 0,
        endpointHost: this.#endpointHost,
      };

      // Attach lifecycle handlers once for the pooled session.
      entry.pingTimer = setInterval(() => {
        if (session.destroyed === true || session.closed === true) {
          return;
        }

        try {
          session.ping(() => {});
        } catch {
          clearInterval(entry.pingTimer);
          entry.pingTimer = undefined;
        }
      }, this.#pingInterval);

      session.on('connect', () => {
        this.log?.debug?.('Connection established to gRPC endpoint "%s"', entry.endpointHost);
      });

      session.on('goaway', () => {
        // Empty
      });

      session.on('error', (error) => {
        this.log?.debug?.('gRPC connection error for "%s": %s', entry.endpointHost, String(error));

        clearInterval(entry.pingTimer);
        entry.pingTimer = undefined;

        if (pool.get(sessionKey)?.session === session) {
          pool.delete(sessionKey);
        }

        try {
          session.destroy();
        } catch {
          // Empty
        }
      });

      session.on('close', () => {
        clearInterval(entry.pingTimer);
        entry.pingTimer = undefined;

        if (pool.get(sessionKey)?.session === session) {
          pool.delete(sessionKey);
        }

        this.log?.debug?.('Connection closed to gRPC endpoint "%s"', entry.endpointHost);
      });

      pool.set(sessionKey, entry);
      this.log?.debug?.('Connection started to gRPC endpoint "%s"', entry.endpointHost);
    }

    // Attach this transport instance to the pooled session once.
    if (this.#attachedSessionKey !== sessionKey) {
      if (this.#attachedSessionKey !== '') {
        this.release();
      }

      entry.refCount++;
      this.#attachedSessionKey = sessionKey;
    }

    this.#session = entry.session;
  }

  async #executeStream(messagePrefix, service, command, values, onFrame, timeout = 0) {
    // Core gRPC transport:
    // - validate inputs
    // - resolve protobuf types
    // - open HTTP/2 request stream
    // - send framed protobuf request
    // - parse framed protobuf response messages
    //
    // Calls onFrame(decoded) once per complete response frame.
    // Resolves with { status, message }.
    //
    // timeout > 0:
    // - adds grpc-timeout header
    // - applies local client-side timeout
    //
    // timeout === 0:
    // - no grpc-timeout header
    // - intended for long-lived observe streams
    let buffer = Buffer.allocUnsafe(this.#bufferInitial);
    let bufferOffset = 0;
    let readOffset = 0;
    let result = { status: undefined, message: '' };
    let isTerminal = false;
    let frameCount = 0;
    let httpStatus = undefined;
    let httpContentType = '';
    let authHeader = this.#getAuthHeader?.();
    let request = undefined;
    let requestTimeout = undefined;

    // Validate request parameters before doing any transport work.
    if (
      typeof messagePrefix !== 'string' ||
      messagePrefix === '' ||
      typeof service !== 'string' ||
      service === '' ||
      typeof command !== 'string' ||
      command === '' ||
      typeof values !== 'object' ||
      values === null
    ) {
      result.status = 400;
      result.message = 'Invalid gRPC request parameters';
      return result;
    }

    if (this.#protobufRoot === undefined) {
      result.status = 500;
      result.message = 'gRPC protobuf support is unavailable';
      return result;
    }

    if (typeof authHeader !== 'string' || authHeader.trim() === '') {
      result.status = 401;
      result.message = 'Authorization header is unavailable';
      return result;
    }

    // Refresh session key from current auth state just before request execution.
    // This matters when auth-based pooling is used and the token changes over time.
    this.#sessionKey = this.#buildSessionKey();

    // Resolve protobuf request/response types for the target method.
    let RequestType = undefined;
    let ResponseType = undefined;

    try {
      RequestType = this.#protobufRoot.lookup(messagePrefix + command + 'Request');
      ResponseType = this.#protobufRoot.lookup(messagePrefix + command + 'Response');
    } catch (error) {
      result.status = 500;
      result.message = 'Failed to lookup gRPC protobuf types';
      this.log?.debug?.('gRPC protobuf lookup failed for "%s/%s": %s', service, command, String(error));
      return result;
    }

    if (RequestType === null || RequestType === undefined || ResponseType === null || ResponseType === undefined) {
      result.status = 500;
      result.message = 'gRPC protobuf types are unavailable';
      return result;
    }

    try {
      this.#ensureSession();

      // Create one HTTP/2 request stream for the requested gRPC method.
      // Path format: /<service>/<command>
      //
      // grpc-timeout header is only added for unary requests.
      // Observe streams are intentionally long-lived and omit it.
      let requestHeaders = {
        ':method': 'POST',
        ':path': '/' + messagePrefix + service + '/' + command,
        authorization: authHeader,
        'content-type': 'application/grpc',
        'user-agent': this.#userAgent,
        te: 'trailers',
        'request-id': crypto.randomUUID(),
      };

      if (timeout > 0) {
        requestHeaders['grpc-timeout'] = Math.ceil(timeout / 1000) + 'S';
      }

      request = this.#session.request(requestHeaders);

      request.on('response', (headers) => {
        httpStatus = Number(headers?.[':status']);
        httpContentType = String(headers?.['content-type'] || '');

        // Reject non-gRPC HTTP responses early.
        // This commonly catches endpoint/proxy mismatches before we try to parse frames.
        if (
          isTerminal === false &&
          (isNaN(httpStatus) === true || httpStatus !== 200 || httpContentType.toLowerCase().includes('application/grpc') !== true)
        ) {
          isTerminal = true;
          result.status = isNaN(httpStatus) === false ? httpStatus : 500;
          result.message = 'Non-gRPC HTTP response: status=' + String(httpStatus) + ' content-type=' + httpContentType;

          try {
            request.close();
          } catch {
            // Empty
          }
        }
      });

      request.on('data', (data) => {
        let headerSize = 5;
        let newSize = 0;
        let newBuffer = undefined;
        let compressed = 0;
        let dataSize = 0;
        let decoded = undefined;

        // Data arrives as one or more framed gRPC messages:
        // 5-byte header + protobuf payload
        if (Buffer.isBuffer(data) !== true || data.length === 0 || isTerminal === true) {
          return;
        }

        // Hard cap memory growth for malformed or unexpectedly large responses.
        if (bufferOffset + data.length > this.#bufferMax) {
          result.status = 413;
          result.message = 'gRPC response exceeds maximum buffer size';
          isTerminal = true;

          try {
            request.close();
          } catch {
            // Empty
          }
          return;
        }

        // Grow response buffer as required, preserving unread bytes only.
        while (bufferOffset + data.length > buffer.length) {
          newSize = Math.min(buffer.length * 2, this.#bufferMax);

          if (newSize < bufferOffset + data.length) {
            result.status = 413;
            result.message = 'gRPC response exceeds maximum buffer size';
            isTerminal = true;

            try {
              request.close();
            } catch {
              // Empty
            }
            return;
          }

          newBuffer = Buffer.allocUnsafe(newSize);

          if (bufferOffset > readOffset) {
            buffer.copy(newBuffer, 0, readOffset, bufferOffset);
            bufferOffset -= readOffset;
            readOffset = 0;
          } else {
            bufferOffset = 0;
            readOffset = 0;
          }

          buffer = newBuffer;
        }

        data.copy(buffer, bufferOffset);
        bufferOffset += data.length;

        // Parse as many complete gRPC frames as are currently buffered.
        while (bufferOffset - readOffset >= headerSize) {
          compressed = buffer.readUInt8(readOffset);
          dataSize = buffer.readUInt32BE(readOffset + 1);

          // Only uncompressed gRPC frames are supported by this transport.
          if (compressed !== 0) {
            result.status = 415;
            result.message = 'Unsupported gRPC compressed response';
            isTerminal = true;

            try {
              request.close();
            } catch {
              // Empty
            }
            return;
          }

          if (dataSize > this.#bufferMax) {
            result.status = 413;
            result.message = 'gRPC response exceeds maximum buffer size';
            isTerminal = true;

            try {
              request.close();
            } catch {
              // Empty
            }
            return;
          }

          // Incomplete frame, wait for more bytes.
          if (bufferOffset - readOffset < headerSize + dataSize) {
            break;
          }

          try {
            decoded = ResponseType.decode(buffer.subarray(readOffset + headerSize, readOffset + headerSize + dataSize)).toJSON();
          } catch (error) {
            // Decode failure means the current response stream can no longer be trusted.
            // Abort this request, but do not tear down the pooled HTTP/2 session unless
            // the underlying transport itself later fails.
            result.status = 500;
            result.message = 'Failed decoding gRPC response';
            isTerminal = true;

            this.log?.debug?.('gRPC decode failed for "%s/%s": %s', service, command, String(error));

            try {
              request.close();
            } catch {
              // Empty
            }
            return;
          }

          try {
            // onFrame must stay non-blocking here.
            // observe() serialises async callback execution separately.
            onFrame(decoded);
            frameCount++;
          } catch (error) {
            // Response handler failure means the current request stream can no longer be trusted.
            // Abort this request, but do not tear down the pooled HTTP/2 session unless
            // the underlying transport itself later fails.
            result.status = 500;
            result.message = 'gRPC response handler failed';
            isTerminal = true;

            this.log?.debug?.('gRPC frame handler failed for "%s/%s": %s', service, command, String(error));

            try {
              request.close();
            } catch {
              // Empty
            }
            return;
          }

          readOffset += headerSize + dataSize;
        }

        // Compact fully or partially consumed buffer contents to keep memory bounded.
        if (readOffset > 0) {
          if (readOffset === bufferOffset) {
            bufferOffset = 0;
            readOffset = 0;
            return;
          }

          buffer.copy(buffer, 0, readOffset, bufferOffset);
          bufferOffset -= readOffset;
          readOffset = 0;
        }
      });

      request.on('trailers', (headers) => {
        // gRPC final status is normally carried in trailers.
        // Do not allow trailers to overwrite a local terminal failure.
        if (isTerminal === true) {
          return;
        }

        if (isNaN(Number(headers?.['grpc-status'])) === false) {
          result.status = Number(headers['grpc-status']);
        }

        if (typeof headers?.['grpc-message'] === 'string') {
          result.message = headers['grpc-message'];
        }

        if (result.status !== undefined && result.status !== 0) {
          this.log?.debug?.('gRPC server error for "%s/%s": status=%s message="%s"', service, command, result.status, result.message);
        }
      });

      request.on('error', (error) => {
        // Request or stream-level terminal failure.
        if (isTerminal === true) {
          return;
        }

        isTerminal = true;
        result.status = typeof error?.code === 'number' ? error.code : 500;
        result.message = String(error?.message || error);
      });

      // Encode protobuf request and wrap it in one gRPC frame.
      // Clone and pre-encode Any payloads so callers can pass plain JS objects.
      let requestValues = structuredClone(values);
      this.#encodeAnyValues(requestValues);

      let encodedData = RequestType.encode(RequestType.fromObject(requestValues)).finish();
      let frame = this.#buildGrpcFrame(encodedData);

      request.cork();
      try {
        request.write(frame);
      } finally {
        request.uncork();
      }

      // End outbound request body.
      // The response stream may continue delivering frames afterward.
      request.end();

      // Local client-side timeout for unary requests.
      if (timeout > 0) {
        requestTimeout = setTimeout(() => {
          if (isTerminal === true) {
            return;
          }

          result.status = 408;
          result.message = 'gRPC request timed out';
          isTerminal = true;

          try {
            request.close();
          } catch {
            // Empty
          }
        }, timeout);
      }

      request.on('close', () => {
        clearTimeout(requestTimeout);
        requestTimeout = undefined;

        if (result.status !== 0 && result.status !== undefined) {
          this.log?.debug?.(
            'gRPC stream closed for "%s/%s" with status=%s message="%s" frames=%d',
            service,
            command,
            result.status,
            result.message,
            frameCount,
          );
        }
      });

      // Wait for the response stream to fully finish before returning final status.
      await EventEmitter.once(request, 'close');

      try {
        request.destroy();
      } catch {
        // Empty
      }
    } catch (error) {
      // Catch unexpected higher-level failures.
      // The pooled session remains available unless the underlying HTTP/2 session itself fails.
      result.status = typeof error?.code === 'number' ? error.code : 500;
      result.message = String(error?.message || error);

      this.log?.debug?.('gRPC request failed: %s', result.message);
    }

    // Ensure callers always receive an explicit status.
    if (typeof result.status !== 'number') {
      result.status = 500;
    }

    return result;
  }

  async command(messagePrefix, service, command, values) {
    // Unary gRPC request.
    // Collects all response frames and returns { status, message, data }.
    let data = [];
    let result = await this.#executeStream(messagePrefix, service, command, values, (message) => data.push(message), this.#requestTimeout);

    return {
      ...result,
      data: data,
    };
  }

  async observe(messagePrefix, service, command, values, onMessage) {
    // Server-streaming gRPC request.
    // Calls onMessage(decoded) once per response frame.
    //
    // Message callbacks are serialised so callers do not need to handle
    // concurrent onMessage execution.
    let messageChain = Promise.resolve();
    let result = await this.#executeStream(messagePrefix, service, command, values, (message) => {
      messageChain = messageChain
        .then(() => onMessage?.(message))
        .catch((error) => {
          this.log?.debug?.('gRPC observe callback error for "%s/%s": %s', service, command, String(error));
        });
    });

    // Drain any queued callbacks before resolving.
    await messageChain;
    return result;
  }
}
