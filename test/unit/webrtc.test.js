// Exercise WebRTC signalling and lifecycle without network access or native media codecs.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { URL } from 'node:url';
import test from 'node:test';
import GrpcTransport from '../../src/grpctransport.js';
import StreamTransport from '../../src/streamtransport.js';

// Replace external boundaries, keeping the real WebRTC and shared transport implementations.
let peerModule =
  'data:text/javascript,' +
  encodeURIComponent(
    'export const runtime = {}; ' +
      'export class RTCPeerConnection { constructor(options) { return runtime.create(options); } } ' +
      'export class RTCRtpCodecParameters { constructor(options) { Object.assign(this, options); } } ' +
      'export function useAudioLevelIndication() { return {}; }',
  );
let { runtime } = await import(peerModule);
let timerModule =
  'data:text/javascript,' +
  encodeURIComponent(
    'import timers from "node:timers"; ' +
      'export function setInterval(...args) { return timers.setInterval(...args); } ' +
      'export function clearInterval(...args) { return timers.clearInterval(...args); } ' +
      'export function setTimeout(...args) { return timers.setTimeout(...args); }',
  );
let replacements = {
  werift: peerModule,
  '@evan/opus': 'data:text/javascript,export class Decoder { decode(payload) { return payload; } }',
  './streamer.js': 'data:text/javascript,export default { MEDIA_TYPE: { AUDIO: "audio", VIDEO: "video" } };',
  'node:timers': timerModule,
};
let location = new URL('../../src/webrtc.js', import.meta.url);
let source = await readFile(location, 'utf8');
source = source.replace(/from '([^']+)'/g, (match, specifier) => {
  let target = replacements[specifier] ?? (specifier.startsWith('.') === true ? new URL(specifier, location).href : specifier);
  return 'from ' + JSON.stringify(target);
});
let { default: WebRTC } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

function event() {
  let callbacks = [];
  return {
    subscribe: (callback) => callbacks.push(callback),
    emit: (...args) => callbacks.forEach((callback) => callback(...args)),
  };
}

let homeGraph = {
  status: 0,
  data: [
    {
      homes: [
        {
          devices: [
            {
              id: { googleUuid: 'google-camera' },
              otherIds: { otherThirdPartyId: [{ id: 'camera' }] },
            },
          ],
        },
      ],
    },
  ],
};
let answer = { status: 0, data: [{ responseType: 'answer', streamId: 'stream', sdp: 'answer-sdp' }] };

function setup(t, responses = {}) {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 100000 });
  let peers = [];
  let media = [];
  let active = true;
  let commands = t.mock.method(GrpcTransport.prototype, 'command', async (prefix, service, command, values) => {
    let key = command === 'JoinStream' ? values.command : command;
    if (typeof responses[key] === 'function') {
      return responses[key](values);
    }
    return responses[key] ?? (key === 'GetHomeGraph' ? homeGraph : key === 'offer' ? answer : { status: 0 });
  });
  let released = t.mock.method(GrpcTransport.prototype, 'release', () => {});
  runtime.create = (options) => {
    let peer = {
      options,
      closed: 0,
      transceivers: [],
      iceConnectionState: 'new',
      iceConnectionStateChange: event(),
      createDataChannel() {},
      addTransceiver(kind) {
        let transceiver = { kind, onTrack: event(), sender: { sendRtp() {} } };
        this.transceivers.push(transceiver);
        return transceiver;
      },
      async createOffer() {
        return { type: 'offer', sdp: 'initial-offer' };
      },
      async setLocalDescription() {
        this.localDescription = { type: 'offer', sdp: 'gathered-offer' };
      },
      async setRemoteDescription(value) {
        this.remoteDescription = value;
      },
      async close() {
        this.closed++;
      },
    };
    peers.push(peer);
    return peer;
  };
  let transport = new WebRTC({
    uuid: 'camera',
    apiAccess: { oauth2: 'oauth-token' },
    consumer: { active: () => active, media: (item) => media.push(item) },
  });
  t.after(async () => {
    active = false;
    await transport.close();
    await transport.shutdown();
  });
  return {
    transport,
    peers,
    media,
    released,
    calls: (command) => commands.mock.calls.filter((call) => call.arguments[2] === command).map((call) => call.arguments[3]),
    stopConsumers: () => {
      active = false;
    },
  };
}

test('WebRTC caches its device ID across close, shutdown and reopen', async (t) => {
  let context = setup(t);
  await context.transport.open();
  assert.equal(context.calls('GetHomeGraph').length, 1);
  assert.equal(context.calls('SendCameraViewIntent')[0].request.googleDeviceId.value, 'google-camera');
  context.stopConsumers();
  await context.transport.close();
  assert.equal(context.released.mock.callCount(), 0);
  await context.transport.shutdown();
  assert.equal(context.released.mock.callCount(), 1);
  await context.transport.open();
  assert.equal(context.calls('GetHomeGraph').length, 1);
  assert.equal(context.peers.length, 2);
});

test('WebRTC shutdown waits for constructor lookup even when media never opened', async (t) => {
  let pending = Promise.withResolvers();
  let context = setup(t, { GetHomeGraph: () => pending.promise });
  let shutdown = context.transport.shutdown();
  await setImmediate();
  assert.equal(context.released.mock.callCount(), 0);
  pending.resolve(homeGraph);
  await shutdown;
  assert.equal(context.released.mock.callCount(), 1);
  assert.equal(context.peers.length, 0);
});

test('WebRTC retries a failed initial device lookup on a later open', async (t) => {
  let lookups = 0;
  let context = setup(t, {
    GetHomeGraph: () => {
      lookups++;
      if (lookups === 1) {
        throw new Error('lookup unavailable');
      }
      return homeGraph;
    },
  });
  await setImmediate();
  await context.transport.open();
  assert.equal(lookups, 2);
  assert.equal(context.peers.length, 1);
});

test('WebRTC does not create a peer when the device ID is missing', async (t) => {
  let context = setup(t, { GetHomeGraph: { status: 0, data: [] } });
  await context.transport.open();
  assert.equal(context.transport.closed, true);
  assert.equal(context.peers.length, 0);
  assert.equal(context.calls('SendCameraViewIntent').length, 0);
});

test('WebRTC prevents duplicate opens and sends gathered SDP, not the initial offer', async (t) => {
  let context = setup(t);
  await Promise.all([context.transport.open(), context.transport.open()]);
  assert.equal(context.peers.length, 1);
  assert.equal(context.calls('JoinStream')[0].sdp, 'gathered-offer');
  assert.deepEqual(context.peers[0].remoteDescription, { type: 'answer', sdp: 'answer-sdp' });
  context.peers[0].iceConnectionState = 'connected';
  context.peers[0].iceConnectionStateChange.emit();
  assert.equal(context.transport.connected, true);
  assert.equal(context.transport.ready, false);
});

for (let failure of ['view-intent', 'offer']) {
  test('WebRTC closes the peer after rejected ' + failure, async (t) => {
    let context = setup(t, failure === 'offer' ? { offer: { status: 0, data: [{}] } } : { SendCameraViewIntent: { status: 14 } });
    await context.transport.open();
    assert.equal(context.peers[0].closed, 1);
    assert.equal(context.transport.closed, true);
    assert.equal(context.peers[0].remoteDescription, undefined);
    assert.equal(context.released.mock.callCount(), 0);
  });
}

test('WebRTC ignores a late JoinStream answer after close', async (t) => {
  let pending = Promise.withResolvers();
  let context = setup(t, { offer: () => pending.promise });
  let opening = context.transport.open();
  await setImmediate();
  assert.equal(context.calls('JoinStream').length, 1);
  context.stopConsumers();
  await context.transport.close();
  pending.resolve(answer);
  await opening;
  assert.equal(context.transport.closed, true);
  assert.equal(context.peers[0].remoteDescription, undefined);
});

test('WebRTC ICE failure defers reconnect until close finishes and ignores stale peer events', async (t) => {
  let context = setup(t);
  await context.transport.open();
  let peer = context.peers[0];
  peer.iceConnectionState = 'failed';
  peer.iceConnectionStateChange.emit();
  await setImmediate();
  assert.equal(peer.closed, 1);
  assert.equal(context.peers.length, 1);
  t.mock.timers.tick(0);
  await setImmediate();
  assert.equal(context.peers.length, 2);
  peer.iceConnectionState = 'connected';
  peer.iceConnectionStateChange.emit();
  assert.equal(context.transport.connecting, true);
  assert.equal(context.calls('GetHomeGraph').length, 1);
});

test('WebRTC serialises talkback start/stop when stop arrives before start completes', async (t) => {
  let pending = Promise.withResolvers();
  let context = setup(t, { SendTalkback: (values) => (values.command === 'COMMAND_START' ? pending.promise : { status: 0 }) });
  await context.transport.open();
  let starting = context.transport.sendAudio(Buffer.from([1]));
  await context.transport.sendAudio(Buffer.from([2]));
  await context.transport.sendAudio(Buffer.alloc(0));
  assert.deepEqual(
    context.calls('SendTalkback').map((call) => call.command),
    ['COMMAND_START'],
  );
  pending.resolve({ status: 0 });
  await starting;
  assert.deepEqual(
    context.calls('SendTalkback').map((call) => call.command),
    ['COMMAND_START', 'COMMAND_STOP'],
  );
});

test('WebRTC audio RTP preserves sample-clock timing and ignores malformed or duplicate packets', async (t) => {
  let context = setup(t);
  await context.transport.open();
  let track = { codec: { payloadType: 111 }, onReceiveRtp: event() };
  context.peers[0].transceivers.find((entry) => entry.kind === 'audio').onTrack.emit(track);
  track.onReceiveRtp.emit(null);
  let packet = (sequenceNumber, timestamp) => ({
    header: { sequenceNumber, timestamp, payloadType: 111, ssrc: 7 },
    payload: Buffer.from([1, 2]),
  });
  track.onReceiveRtp.emit(packet(1, 0));
  t.mock.timers.tick(60);
  track.onReceiveRtp.emit(packet(2, 960));
  t.mock.timers.tick(60);
  track.onReceiveRtp.emit(packet(3, 1920));
  assert.ok(context.media.length >= 2);
  assert.equal(context.media[1].timestamp - context.media[0].timestamp, 20);
  assert.equal(context.media[0].codec, context.transport.audio.codec);
  let count = context.media.length;
  track.onReceiveRtp.emit(packet(2, 960));
  assert.equal(context.media.length, count);
  context.stopConsumers();
  await context.transport.close();
  count = context.media.length;
  track.onReceiveRtp.emit(packet(4, 2880));
  assert.equal(context.media.length, count);
});

for (let local of [false, true]) {
  test('WebRTC extends only ready remote streams; local=' + local, async (t) => {
    let context = setup(t, {
      offer: {
        status: 0,
        data: [{ ...answer.data[0], sdp: local === true ? 'a=candidate:1 1 udp 1 192.168.1.2 123 typ host' : 'answer-sdp' }],
      },
      extend: { status: 0, data: [{ streamExtensionStatus: 'STATUS_STREAM_EXTENDED' }] },
    });
    await context.transport.open();
    t.mock.timers.tick(30000);
    await setImmediate();
    assert.equal(context.calls('JoinStream').filter((call) => call.command === 'extend').length, 0);
    // Readiness is exercised separately from media decoding in this signalling test.
    context.transport.setState(StreamTransport.STATE.READY);
    t.mock.timers.tick(30000);
    await setImmediate();
    assert.equal(context.calls('JoinStream').filter((call) => call.command === 'extend').length, local === true ? 0 : 1);
    context.stopConsumers();
    await context.transport.close();
    let count = context.calls('JoinStream').length;
    t.mock.timers.tick(60000);
    await setImmediate();
    assert.equal(context.calls('JoinStream').length, count);
  });
}
