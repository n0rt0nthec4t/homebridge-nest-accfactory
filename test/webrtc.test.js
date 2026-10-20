// Exercise WebRTC signalling and lifecycle without network access or native media codecs.
import assert from 'node:assert/strict';
import { importSource } from './helpers/import-source.js';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import { URL } from 'node:url';
import test from 'node:test';
import GrpcTransport from '../src/grpctransport.js';
import StreamTransport from '../src/plugins/camera/streamtransport.js';
import H264 from '../src/plugins/camera/h264.js';
import { sequenceParameterSet } from './helpers/h264-fixtures.js';

// Replace external boundaries, keeping the real WebRTC and shared transport implementations.
let peerModule =
  'data:text/javascript,' +
  encodeURIComponent(
    'export { RtpHeader, RtpPacket, RtcpPayloadSpecificFeedback, ReceiverEstimatedMaxBitrate } from ' +
      JSON.stringify(import.meta.resolve('werift')) +
      ';' +
      'export const runtime = {}; ' +
      'export class RTCPeerConnection { constructor(options) { return runtime.create(options); } } ' +
      'export class RTCRtpCodecParameters { constructor(options) { Object.assign(this, options); } } ' +
      'export function useAudioLevelIndication() { return {}; }',
  );
let { runtime } = await import(peerModule);
let decoderModule =
  'data:text/javascript,' +
  encodeURIComponent(
    'export const decoder = { decode: (payload) => payload }; export class Decoder { decode(payload) { return decoder.decode(payload); } }',
  );
let { decoder } = await import(decoderModule);
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
  '@evan/opus': decoderModule,
  './streamer.js': 'data:text/javascript,export default { MEDIA_TYPE: { AUDIO: "audio", VIDEO: "video" } };',
  'node:timers': timerModule,
};
let location = new URL('../src/plugins/camera/webrtc.js', import.meta.url);
let source = await readFile(location, 'utf8');
source = source.replace(/from '([^']+)'/g, (match, specifier) => {
  let target = replacements[specifier] ?? (specifier.startsWith('.') === true ? new URL(specifier, location).href : specifier);
  return 'from ' + JSON.stringify(target);
});
let { default: WebRTC } = await importSource(location, source);

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

function setup(t, responses = {}, peerOptions = {}) {
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
      ...peerOptions,
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

// Feed the registered track callback, retaining real jitter release, H264 reconstruction and recovery.
async function videoFlow(context) {
  let flow = setup(context);
  await flow.transport.open();
  let track = { codec: { payloadType: 98 }, onReceiveRtp: event() };
  let transceiver = flow.peers[0].transceivers.find((entry) => entry.kind === 'video');
  transceiver.onTrack.emit(track);
  let sequence = 0;
  let packet = (payload, timestamp = 0, marker = true, overrides = {}) => ({
    header: { payloadType: 98, ssrc: 10, sequenceNumber: sequence++ & 0xffff, timestamp, marker, ...overrides },
    payload,
  });
  let emit = (payload, timestamp = 0, marker = true, overrides = {}) =>
    track.onReceiveRtp.emit(packet(payload, timestamp, marker, overrides));
  let stap = (parts) =>
    Buffer.concat([
      Buffer.from([0x78]),
      ...parts.flatMap((part) => {
        let length = Buffer.alloc(2);
        length.writeUInt16BE(part.length);
        return [length, part];
      }),
    ]);
  let sps = sequenceParameterSet({ widthMbs: 40, heightMbs: 23, crop: [0, 0, 0, 4] });
  let pps = Buffer.from([0x68, 0x01]);
  let keyframe = (timestamp = 0) => emit(stap([sps, pps, Buffer.from([0x65, 1])]), timestamp);
  return { ...flow, track, emit, packet, stap, sps, pps, keyframe };
}

test('WebRTC video starts only at an SPS/PPS-backed IDR, then preserves 90kHz source timing', async (context) => {
  let flow = await videoFlow(context);
  flow.emit(Buffer.from([0x41, 1]));
  assert.deepEqual(flow.media, []);
  flow.keyframe(3000);
  assert.equal(flow.media.length, 1);
  assert.equal(flow.media[0].keyFrame, true);
  assert.deepEqual(
    H264.getNALUnits(flow.media[0].data).map((nal) => nal.type),
    [7, 8, 5],
  );
  assert.equal(flow.transport.ready, true);
  flow.emit(Buffer.from([0x41, 2]), 6000);
  assert.equal(flow.media.length, 2);
  assert.ok(Math.abs(flow.media[1].timestamp - flow.media[0].timestamp - 1000 / 30) < 1);
  assert.equal(flow.media[1].keyFrame, false);
  assert.equal(flow.transport.video.width, 640);
  assert.equal(flow.transport.video.height, 360);
});
for (let reverse of [false, true]) {
  test('WebRTC reassembles FU-A across sequence rollover, reordered=' + reverse, async (context) => {
    let flow = await videoFlow(context);
    flow.emit(flow.stap([flow.sps, flow.pps, Buffer.from([0x65, 1])]), 0, true, { sequenceNumber: 65534 });
    let fragments = [
      flow.packet(Buffer.from([0x7c, 0x81, 1, 2]), 3000, false, { sequenceNumber: 65535 }),
      flow.packet(Buffer.from([0x7c, 0x41, 3, 4]), 3000, true, { sequenceNumber: 0 }),
    ];
    let before = flow.media.length;
    for (let fragment of reverse === true ? fragments.reverse() : fragments) {
      flow.track.onReceiveRtp.emit(fragment);
    }
    assert.equal(flow.media.length, before + 1);
    assert.deepEqual(H264.getNALUnits(flow.media.at(-1).data).at(-1).data, Buffer.from([0x61, 1, 2, 3, 4]));
  });
}

test('WebRTC RTX fills a missing FU-A fragment without forwarding the RTX prefix', async (context) => {
  let flow = await videoFlow(context);
  flow.keyframe();
  flow.emit(Buffer.from([0x7c, 0x81, 1]), 3000, false, { sequenceNumber: 1 });
  flow.emit(Buffer.from([0x7c, 0x41, 3]), 3000, true, { sequenceNumber: 3 });
  let prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(2);
  flow.emit(Buffer.concat([prefix, Buffer.from([0x7c, 0x01, 2])]), 3000, false, { payloadType: 99, ssrc: 11, sequenceNumber: 100 });
  assert.equal(flow.media.length, 2);
  assert.deepEqual(H264.getNALUnits(flow.media[1].data).at(-1).data, Buffer.from([0x61, 1, 2, 3]));
});

for (let [label, payload, overrides] of [
  ['unknown payload', Buffer.from([0x41, 2]), { payloadType: 120 }],
  ['different primary SSRC', Buffer.from([0x41, 2]), { ssrc: 20 }],
  ['duplicate', Buffer.from([0x41, 2]), { sequenceNumber: 0 }],
  ['truncated RTX', Buffer.from([0, 1]), { payloadType: 99, ssrc: 11 }],
  ['invalid STAP-A', Buffer.from([0x78, 0, 10, 0x41]), {}],
  ['zero-length STAP-A', Buffer.from([0x78, 0, 0]), {}],
  ['unsupported NAL', Buffer.from([0x7d, 1]), {}],
]) {
  test('WebRTC ignores ' + label + ' and accepts a later valid frame', async (context) => {
    let flow = await videoFlow(context);
    flow.keyframe();
    flow.emit(payload, 3000, true, overrides);
    assert.equal(flow.media.length, 1);
    flow.emit(Buffer.from([0x41, 3]), 6000, true, { sequenceNumber: 20 });
    assert.equal(flow.media.length, 2);
  });
}

test('WebRTC incomplete keyframe does not discard a complete recovery keyframe queued after it', async (context) => {
  let flow = await videoFlow(context);
  flow.keyframe();
  flow.emit(Buffer.from([0x7c, 0x85, 1]), 3000, false);
  flow.emit(Buffer.from([0x7c, 0x45, 3]), 3000, true, { sequenceNumber: 3 });
  flow.keyframe(6000);
  context.mock.timers.tick(1000);
  // A new arrival triggers bounded jitter draining after the older incomplete group expires.
  flow.emit(Buffer.from([0x41, 4]), 9000, true, { sequenceNumber: 30 });
  assert.equal(
    flow.media.some((frame) => frame.keyFrame === true && frame.timestamp > flow.media[0].timestamp),
    true,
  );
  assert.ok(flow.transport.stats.media.videoDrops['jitter-keyframe-incomplete'] >= 1);
});

test('WebRTC missing parameter sets suppress an IDR until a decodable keyframe arrives', async (context) => {
  let flow = await videoFlow(context);
  flow.emit(Buffer.from([0x65, 1]));
  assert.deepEqual(flow.media, []);
  assert.equal(flow.transport.ready, false);
  flow.keyframe(3000);
  assert.equal(flow.media.length, 1);
  assert.equal(flow.transport.ready, true);
});

test('WebRTC video rejects malformed track packets and packets after teardown', async (context) => {
  let flow = await videoFlow(context);
  for (let packet of [null, {}, { header: null }, { header: {}, payload: Buffer.alloc(0) }]) {
    flow.track.onReceiveRtp.emit(packet);
  }
  assert.deepEqual(flow.media, []);
  flow.keyframe();
  flow.stopConsumers();
  await flow.transport.close();
  let count = flow.media.length;
  flow.emit(Buffer.from([0x41, 1]), 3000);
  assert.equal(flow.media.length, count);
});

test('WebRTC requested close with retained consumers permits a later source reopen', async (context) => {
  let flow = await videoFlow(context);
  flow.keyframe();
  await flow.transport.close();
  assert.equal(flow.transport.closed, true);
  assert.equal(flow.transport.closing, false);
  await flow.transport.open();
  assert.equal(flow.peers.length, 2);
  let track = { codec: { payloadType: 98 }, onReceiveRtp: event() };
  flow.peers[1].transceivers.find((entry) => entry.kind === 'video').onTrack.emit(track);
  track.onReceiveRtp.emit(flow.packet(flow.stap([flow.sps, flow.pps, Buffer.from([0x65, 1])]), 0));
  assert.equal(flow.media.length, 2);
  assert.equal(flow.transport.ready, true);
});

for (let selected of [true, false]) {
  test('WebRTC diagnostics normalise candidate and RTP measurements, selected pair=' + selected, async (context) => {
    let flow = setup(context);
    await flow.transport.open();
    let calls = 0;
    let report = new Map([
      ['transport', { type: 'transport', dtlsState: 'connected', selectedCandidatePairId: selected === true ? 'pair' : undefined }],
      [
        'pair',
        {
          type: 'candidate-pair',
          nominated: true,
          state: 'succeeded',
          localCandidateId: 'local',
          remoteCandidateId: 'remote',
          currentRoundTripTime: 0.0125,
        },
      ],
      ['local', { type: 'local-candidate', protocol: 'udp', candidateType: 'host' }],
      ['remote', { type: 'remote-candidate', protocol: 'udp', candidateType: 'relay' }],
      [
        'video',
        {
          type: 'inbound-rtp',
          kind: 'video',
          packetsReceived: 20,
          bytesReceived: 2000,
          packetsLost: 2,
          jitter: 0.003,
          nackCount: 1,
          pliCount: 2,
        },
      ],
      ['audio', { type: 'inbound-rtp', kind: 'audio' }],
    ]);
    flow.peers[0].getStats = async () => {
      calls++;
      return report;
    };
    let stats = await flow.transport.refreshDiagnostics();
    assert.equal(stats.dtlsState, 'connected');
    assert.equal(stats.candidatePair.roundTripTimeMs, 12.5);
    assert.equal(stats.candidatePair.remoteType, 'relay');
    assert.deepEqual(stats.inbound.video, { packets: 20, bytes: 2000, lost: 2, jitterMs: 3, nacks: 1, plis: 2 });
    assert.equal(stats.inbound.audio.packets, 0);
    assert.equal(await flow.transport.refreshDiagnostics(), stats);
    assert.equal(calls, 1);
    context.mock.timers.tick(1000);
    flow.peers[0].getStats = async () => {
      throw new Error('Fixture stats failure');
    };
    assert.equal(await flow.transport.refreshDiagnostics(), stats);
  });
}
test('WebRTC partial option refresh preserves existing credentials and accepts explicit field-test changes', async (context) => {
  let flow = setup(context);
  await flow.transport.update({ fieldTest: true });
  assert.equal(flow.transport.token, 'oauth-token');
  assert.equal(flow.transport.fieldTest, true);
  await flow.transport.update({ uuid: 'replacement', apiAccess: { oauth2: 'new-token' }, fieldTest: false });
  assert.equal(flow.transport.uuid, 'replacement');
  assert.equal(flow.transport.token, 'new-token');
  assert.equal(flow.transport.fieldTest, false);
  await flow.transport.update(null);
  assert.equal(flow.transport.token, 'new-token');
});

test('WebRTC talkback sends real RTP packets with sequential headers and a 48kHz sample clock', async (context) => {
  let flow = setup(context);
  await flow.transport.open();
  let sender = flow.peers[0].transceivers.find((entry) => entry.kind === 'audio').sender;
  sender.ssrc = 1234;
  let packets = [];
  sender.sendRtp = (packet) => packets.push(packet);
  await flow.transport.sendAudio(Buffer.from([1, 2]));
  await flow.transport.sendAudio(Buffer.from([3, 4]));
  assert.equal(packets.length, 2);
  assert.equal(packets[0].readUInt16BE(2), 0);
  assert.equal(packets[1].readUInt16BE(2), 1);
  assert.equal(packets[0].readUInt32BE(8), 1234);
  assert.equal((packets[1].readUInt32BE(4) - packets[0].readUInt32BE(4)) >>> 0, 960);
  assert.deepEqual(packets[0].subarray(12), Buffer.from([1, 2]));
  await flow.transport.sendAudio(Buffer.alloc(0));
  assert.equal(flow.calls('SendTalkback').at(-1).command, 'COMMAND_STOP');
});
for (let failure of ['start', 'stop']) {
  test('WebRTC talkback ' + failure + ' rejection resets state for the next attempt', async (context) => {
    let attempts = 0;
    let flow = setup(context, { SendTalkback: () => ({ status: attempts++ === (failure === 'start' ? 0 : 1) ? 14 : 0 }) });
    await flow.transport.open();
    await flow.transport.sendAudio(Buffer.from([1]));
    await flow.transport.sendAudio(Buffer.alloc(0));
    await flow.transport.sendAudio(Buffer.from([2]));
    assert.ok(flow.calls('SendTalkback').filter((command) => command.command === 'COMMAND_START').length >= 2);
  });
}
for (let mode of ['success', 'sync failure', 'async failure']) {
  test('WebRTC startup PLI/FIR/REMB request and recovery: ' + mode, async (context) => {
    let flow = await videoFlow(context);
    let plis = [];
    let feedback = [];
    let transceiver = flow.peers[0].transceivers.find((entry) => entry.kind === 'video');
    transceiver.receiver = {
      rtcpSsrc: 99,
      sendRtcpPLI: (ssrc) => {
        plis.push(ssrc);
        if (mode === 'sync failure') {
          throw new Error('Fixture PLI failed');
        }
        return mode === 'async failure' ? Promise.reject(new Error('Fixture PLI rejected')) : Promise.resolve();
      },
      dtlsTransport: {
        sendRtcp: async (packets) => {
          feedback.push(packets);
        },
      },
    };
    flow.emit(Buffer.from([0x68, 1]));
    await setImmediate();
    assert.deepEqual(plis, [10]);
    assert.equal(feedback[0].length, 2);
    context.mock.timers.tick(1500);
    await setImmediate();
    assert.equal(plis.length, 2);
    flow.keyframe(3000);
    let count = plis.length;
    context.mock.timers.tick(1500);
    assert.equal(plis.length, count, 'accepted IDR stops startup requests');
  });
}
test('WebRTC drops an oversized keyframe and recovers on the next normal IDR', async (context) => {
  let flow = await videoFlow(context);
  flow.keyframe();
  let oversized = Buffer.alloc(5 * 1024 * 1024, 1);
  oversized[0] = 0x65;
  flow.emit(oversized, 3000);
  assert.equal(flow.media.length, 1);
  assert.equal(flow.transport.stats.media.videoDrops['oversized-keyframe'], 1);
  flow.keyframe(6000);
  assert.equal(flow.media.length, 2);
});

for (let consumers of [true, false]) {
  test('WebRTC playback stall reconnects only while consumers remain: ' + consumers, async (context) => {
    let flow = await videoFlow(context);
    flow.keyframe();
    context.mock.timers.tick(9000);
    flow.emit(Buffer.from([0x41, 2]), 3000);
    context.mock.timers.tick(6000);
    await setImmediate();
    assert.equal(flow.peers[0].closed, 0, 'valid playback refreshes the stall deadline');
    if (consumers === false) {
      flow.stopConsumers();
    }
    context.mock.timers.tick(10000);
    await setImmediate();
    assert.equal(flow.peers[0].closed, 1);
    context.mock.timers.tick(0);
    await setImmediate();
    assert.equal(flow.peers.length, consumers === true ? 2 : 1);
    assert.equal(flow.transport.stats.lifecycle.reconnectReasons.stall, 1);
  });
}
test('WebRTC rejected stream extension closes the old peer and opens one replacement', async (context) => {
  let flow = setup(context, { extend: { status: 14 } });
  await flow.transport.open();
  flow.transport.setState(StreamTransport.STATE.READY);
  context.mock.timers.tick(30000);
  await setImmediate();
  assert.equal(flow.peers[0].closed, 1);
  context.mock.timers.tick(0);
  await setImmediate();
  assert.equal(flow.peers.length, 2);
  assert.equal(flow.calls('JoinStream').filter((call) => call.command === 'extend').length, 1);
  assert.equal(flow.transport.stats.lifecycle.reconnectReasons['extend-failed'], 1);
});
for (let keyFrame of [false, true]) {
  test(
    'WebRTC fragmented ' + (keyFrame === true ? 'IDR' : 'delta') + ' loss discards corrupt media and accepts a later IDR',
    async (context) => {
      let flow = await videoFlow(context);
      flow.keyframe();
      let nal = keyFrame === true ? 5 : 1;
      flow.emit(Buffer.from([0x7c, 0x80 | nal, 1]), 3000, false, { sequenceNumber: 1 });
      // The missing middle fragment must never become a partially decoded access unit.
      flow.emit(Buffer.from([0x7c, 0x40 | nal, 3]), 3000, true, { sequenceNumber: 3 });
      context.mock.timers.tick(1000);
      flow.emit(flow.stap([flow.sps, flow.pps, Buffer.from([0x65, 9])]), 6000, true, { sequenceNumber: 4 });
      assert.equal(flow.media.length, 2);
      assert.deepEqual(H264.getNALUnits(flow.media.at(-1).data).at(-1).data, Buffer.from([0x65, 9]));
      assert.equal(
        flow.media.every((frame) => frame.keyFrame === true),
        true,
      );
      assert.ok(Object.values(flow.transport.stats.media.videoDrops).reduce((sum, count) => sum + count, 0) > 0);
    },
  );
}

test('WebRTC fragmented IDR reconstructs complete bytes and reuses cached parameter sets', async (context) => {
  let flow = await videoFlow(context);
  flow.keyframe();
  flow.emit(Buffer.from([0x7c, 0x85, 1]), 3000, false);
  flow.emit(Buffer.from([0x7c, 0x05, 2]), 3000, false);
  assert.equal(flow.media.length, 1);
  flow.emit(Buffer.from([0x7c, 0x45, 3]), 3000);
  assert.equal(flow.media.length, 2);
  assert.equal(flow.media[1].keyFrame, true);
  assert.deepEqual(
    H264.getNALUnits(flow.media[1].data).map((entry) => entry.data),
    [flow.sps, flow.pps, Buffer.from([0x65, 1, 2, 3])],
  );
});

test('WebRTC health suppresses unstable deltas and restores them after an accepted recovery IDR', async (context) => {
  let flow = await videoFlow(context);
  flow.keyframe();
  let health = flow.transport.getMediaState('video');
  for (let index = 0; index < health.unstableBadThreshold; index++) {
    flow.transport.markMediaIssue('video', 'fixture-loss');
  }
  flow.emit(Buffer.from([0x41, 2]), 3000);
  assert.equal(flow.media.length, 1);
  flow.keyframe(6000);
  assert.equal(health.state, StreamTransport.MEDIA_STATE.RECOVERING);
  flow.emit(Buffer.from([0x41, 3]), 9000);
  assert.equal(flow.media.length, 3);
  assert.equal(health.suppressDeltas, false);
  assert.equal(flow.media.at(-1).keyFrame, false);
});
for (let result of ['uint8array', 'empty', 'exception']) {
  test('WebRTC Opus decoder ' + result + ' preserves subsequent audio recovery', async (context) => {
    let flow = setup(context);
    await flow.transport.open();
    context.after(() => {
      decoder.decode = (payload) => payload;
    });
    let track = { codec: { payloadType: 111 }, onReceiveRtp: event() };
    flow.peers[0].transceivers.find((entry) => entry.kind === 'audio').onTrack.emit(track);
    decoder.decode = context.mock.fn(() => {
      if (result === 'exception') {
        throw new Error('Fixture decoder failure');
      }
      return result === 'empty' ? Buffer.alloc(0) : new Uint8Array([8, 9]);
    });
    let send = (sequenceNumber, timestamp) =>
      track.onReceiveRtp.emit({
        header: { sequenceNumber, timestamp, payloadType: 111, ssrc: 7 },
        payload: Buffer.from([1, 2]),
      });
    send(1, 0);
    context.mock.timers.tick(60);
    send(2, 960);
    assert.equal(decoder.decode.mock.callCount(), 1, 'the next packet drains the aged jitter entry');
    assert.equal(flow.media.length, result === 'uint8array' ? 1 : 0);
    if (result === 'uint8array') {
      assert.deepEqual(flow.media[0].data, Buffer.from([8, 9]));
    }
    decoder.decode = (payload) => payload;
    context.mock.timers.tick(60);
    send(3, 1920);
    assert.deepEqual(flow.media.at(-1).data, Buffer.from([1, 2]));
    assert.equal(flow.media.at(-1).type, 'audio');
  });
}

// Close can finish before a pending signalling operation returns. Its continuation must stay stale.
test('WebRTC close during device lookup prevents a late lookup from opening a peer', async (context) => {
  let lookup = Promise.withResolvers();
  let flow = setup(context, { GetHomeGraph: () => lookup.promise });
  let opening = flow.transport.open();
  await setImmediate();
  await flow.transport.close();
  lookup.resolve(homeGraph);
  await opening;
  assert.equal(flow.peers.length, 0);
  assert.equal(flow.calls('SendCameraViewIntent').length, 0);
  assert.equal(flow.transport.closed, true);
});
test('WebRTC late remote-description completion cannot install timers on a replacement peer', async (context) => {
  let description = Promise.withResolvers();
  let attempts = 0;
  let flow = setup(
    context,
    { extend: { status: 0, data: [{ streamExtensionStatus: 'STATUS_STREAM_EXTENDED' }] } },
    {
      async setRemoteDescription(value) {
        this.remoteDescription = value;
        if (attempts++ === 0) {
          await description.promise;
        }
      },
    },
  );
  let opening = flow.transport.open();
  await setImmediate();
  await flow.transport.close();
  await flow.transport.open();
  flow.transport.setState(StreamTransport.STATE.READY);
  description.resolve();
  await opening;
  context.mock.timers.tick(30000);
  await setImmediate();
  assert.equal(flow.peers.length, 2);
  assert.equal(flow.calls('JoinStream').filter((call) => call.command === 'extend').length, 1);
  assert.equal(flow.peers[1].closed, 0);
});

for (let [label, response] of [
  ['status', { status: 14, data: answer.data }],
  ['type', { status: 0, data: [{ ...answer.data[0], responseType: 'offer' }] }],
  ['stream ID', { status: 0, data: [{ responseType: 'answer', sdp: 'sdp' }] }],
  ['SDP', { status: 0, data: [{ responseType: 'answer', streamId: 'stream' }] }],
]) {
  test('WebRTC rejects an invalid answer ' + label + ' and permits the next open', async (context) => {
    let attempts = 0;
    let flow = setup(context, { offer: () => (attempts++ === 0 ? response : answer) });
    await flow.transport.open();
    assert.equal(flow.transport.closed, true);
    assert.equal(flow.peers[0].closed, 1);
    await flow.transport.open();
    assert.equal(flow.peers.length, 2);
    assert.deepEqual(flow.peers[1].remoteDescription, { type: 'answer', sdp: 'answer-sdp' });
  });
}
test('WebRTC close while view intent is pending never joins the ended session', async (context) => {
  let intent = Promise.withResolvers();
  let flow = setup(context, { SendCameraViewIntent: () => intent.promise });
  let opening = flow.transport.open();
  await setImmediate();
  await flow.transport.close();
  intent.resolve({ status: 0 });
  await opening;
  assert.equal(flow.calls('JoinStream').length, 0);
  assert.equal(flow.transport.closed, true);
});
test('WebRTC concurrent closes send one talkback stop and one stream end', async (context) => {
  let ending = Promise.withResolvers();
  let flow = setup(context, { end: () => ending.promise });
  await flow.transport.open();
  await flow.transport.sendAudio(Buffer.from([1]));
  let closing = flow.transport.close();
  await setImmediate();
  await flow.transport.close();
  assert.equal(flow.calls('SendTalkback').filter((call) => call.command === 'COMMAND_STOP').length, 1);
  assert.equal(flow.calls('JoinStream').filter((call) => call.command === 'end').length, 1);
  assert.equal(flow.peers[0].closed, 0);
  ending.resolve({ status: 0 });
  await closing;
  assert.equal(flow.peers[0].closed, 1);
  assert.equal(flow.transport.closed, true);
});
for (let started of [false, true]) {
  test('WebRTC discards an excessively slow IDR; already streaming=' + started, async (context) => {
    let flow = await videoFlow(context);
    if (started === true) {
      flow.keyframe();
    } else {
      flow.emit(flow.stap([flow.sps, flow.pps]));
    }
    let before = flow.media.length;
    flow.emit(Buffer.from([0x7c, 0x85, 1]), 3000, false);
    context.mock.timers.tick(started === true ? 2600 : 4100);
    flow.emit(Buffer.from([0x7c, 0x45, 2]), 3000);
    assert.equal(flow.media.length, before);
    assert.equal(flow.transport.stats.media.videoDrops['shock-keyframe'], 1);
    flow.keyframe(6000);
    assert.equal(flow.media.length, before + 1);
  });
}
for (let allowance of ['resolution', 'bitrate']) {
  test('WebRTC accepts a large valid IDR using the learned ' + allowance + ' allowance', async (context) => {
    let flow = await videoFlow(context);
    let sps = allowance === 'resolution' ? sequenceParameterSet({ widthMbs: 240, heightMbs: 135 }) : flow.sps;
    if (allowance === 'bitrate') {
      flow.transport.video.bitrate = 8000000;
    }
    let idr = Buffer.alloc(3 * 1024 * 1024, 1);
    idr[0] = 0x65;
    flow.emit(flow.stap([sps, flow.pps]));
    flow.emit(idr, 3000);
    assert.equal(flow.media.length, 1);
    assert.equal(flow.media[0].keyFrame, true);
    assert.equal(H264.getNALUnits(flow.media[0].data).at(-1).data.length, idr.length);
  });
}
test('WebRTC keeps only one PLI in flight and resumes retries after it settles', async (context) => {
  let flow = await videoFlow(context);
  let pending = Promise.withResolvers();
  let request = context.mock.fn(() => pending.promise);
  flow.peers[0].transceivers.find((entry) => entry.kind === 'video').receiver = { sendRtcpPLI: request };
  flow.emit(flow.pps);
  context.mock.timers.tick(4500);
  assert.equal(request.mock.callCount(), 1);
  pending.resolve();
  await setImmediate();
  context.mock.timers.tick(1500);
  assert.equal(request.mock.callCount(), 2);
  flow.keyframe(3000);
});
for (let mode of ['throw', 'reject']) {
  test('WebRTC FIR/REMB ' + mode + ' failure leaves keyframe recovery usable', async (context) => {
    let flow = await videoFlow(context);
    flow.peers[0].transceivers.find((entry) => entry.kind === 'video').receiver = {
      rtcpSsrc: 99,
      sendRtcpPLI: () => Promise.resolve(),
      dtlsTransport: {
        sendRtcp: () => {
          if (mode === 'throw') {
            throw new Error('Fixture RTCP failed');
          }
          return Promise.reject(new Error('Fixture RTCP rejected'));
        },
      },
    };
    flow.emit(flow.pps);
    await setImmediate();
    flow.keyframe(3000);
    assert.equal(flow.transport.ready, true);
    assert.equal(flow.media.length, 1);
  });
}

test('WebRTC ICE completion after the first keyframe preserves media readiness', async (context) => {
  let flow = await videoFlow(context);
  flow.keyframe();
  for (let state of ['connected', 'completed', 'checking']) {
    flow.peers[0].iceConnectionState = state;
    flow.peers[0].iceConnectionStateChange.emit();
    assert.equal(flow.transport.ready, true, 'ICE ' + state + ' must not downgrade a decoding source');
  }
  flow.emit(Buffer.from([0x41, 9]), 3000);
  assert.equal(flow.media.length, 2);
});
for (let broken of ['interrupted IDR', 'empty FU payload']) {
  test('WebRTC safely recovers from ' + broken + ' within an apparently complete timestamp group', async (context) => {
    let flow = await videoFlow(context);
    flow.keyframe();
    flow.emit(Buffer.from([0x7c, 0x85, 1]), 3000, false);
    if (broken === 'interrupted IDR') {
      flow.emit(Buffer.from([0x7c, 0x85, 2]), 3000, false);
    }
    flow.emit(broken === 'empty FU payload' ? Buffer.from([0x7c, 0x45]) : Buffer.from([0x7c, 0x45, 3]), 3000);
    assert.equal(flow.media.length, 1);
    flow.keyframe(6000);
    assert.equal(flow.media.length, 2);
    assert.equal(flow.media.at(-1).keyFrame, true);
  });
}
test('WebRTC source video timestamps advance monotonically across 32-bit RTP timestamp rollover', async (context) => {
  let flow = await videoFlow(context);
  flow.keyframe(0xfffff000);
  flow.emit(Buffer.from([0x41, 2]), 0x1000);
  assert.equal(flow.media.length, 2);
  assert.ok(Math.abs(flow.media[1].timestamp - flow.media[0].timestamp - 8192 / 90) < 1);
});

// A pending talkback start belongs to its original encoded-media session.
for (let deferredStop of [false, true]) {
  test('WebRTC late talkback start cannot affect a replacement peer; deferred stop=' + deferredStop, async (context) => {
    let pending = Promise.withResolvers();
    let starts = 0;
    let flow = setup(context, {
      SendTalkback: (request) => (request.command === 'COMMAND_START' && starts++ === 0 ? pending.promise : { status: 0 }),
    });
    await flow.transport.open();
    let oldSender = flow.peers[0].transceivers.find((entry) => entry.kind === 'audio').sender;
    oldSender.sendRtp = context.mock.fn();
    let starting = flow.transport.sendAudio(Buffer.from([1]));
    if (deferredStop === true) {
      await flow.transport.sendAudio(Buffer.alloc(0));
    }
    await flow.transport.close();
    await flow.transport.open();
    let sender = flow.peers[1].transceivers.find((entry) => entry.kind === 'audio').sender;
    sender.sendRtp = context.mock.fn();
    pending.resolve({ status: 0 });
    await starting;
    assert.equal(oldSender.sendRtp.mock.callCount(), 0);
    assert.equal(sender.sendRtp.mock.callCount(), 0);
    await flow.transport.sendAudio(Buffer.from([2]));
    assert.equal(sender.sendRtp.mock.callCount(), 1);
    assert.equal(flow.calls('SendTalkback').filter((entry) => entry.command === 'COMMAND_START').length, 2);
  });
}

test('WebRTC bounds startup keyframe retries while an audio-only camera keeps the connection alive', async (context) => {
  let flow = await videoFlow(context);
  let requests = context.mock.fn(() => Promise.resolve());
  flow.peers[0].transceivers.find((entry) => entry.kind === 'video').receiver = { sendRtcpPLI: requests };
  flow.emit(flow.pps);
  let audio = { codec: { payloadType: 111 }, onReceiveRtp: event() };
  flow.peers[0].transceivers.find((entry) => entry.kind === 'audio').onTrack.emit(audio);
  for (let index = 0; index < 12; index++) {
    audio.onReceiveRtp.emit({
      header: { sequenceNumber: index, timestamp: index * 960, payloadType: 111, ssrc: 7 },
      payload: Buffer.from([1]),
    });
    context.mock.timers.tick(1500);
    await setImmediate();
  }
  let count = requests.mock.callCount();
  assert.ok(count > 1 && count <= 9);
  context.mock.timers.tick(1500);
  await setImmediate();
  assert.equal(requests.mock.callCount(), count, 'startup PLI retries stop after their bounded window');
  assert.equal(flow.peers[0].closed, 0);
});
test('WebRTC RTP arriving from a retired video track cannot initialise the replacement source', async (context) => {
  let flow = await videoFlow(context);
  await flow.transport.close();
  await flow.transport.open();
  let current = { codec: { payloadType: 98 }, onReceiveRtp: event() };
  flow.peers[1].transceivers.find((entry) => entry.kind === 'video').onTrack.emit(current);
  flow.keyframe();
  assert.deepEqual(flow.media, []);
  assert.equal(flow.transport.ready, false);
  current.onReceiveRtp.emit(flow.packet(flow.stap([flow.sps, flow.pps, Buffer.from([0x65, 2])]), 3000));
  assert.equal(flow.media.length, 1);
  assert.equal(flow.transport.ready, true);
});
test('WebRTC a retired track event cannot reset decoder state on the replacement video track', async (context) => {
  let flow = await videoFlow(context);
  await flow.transport.close();
  await flow.transport.open();
  let current = { codec: { payloadType: 98 }, onReceiveRtp: event() };
  flow.peers[1].transceivers.find((entry) => entry.kind === 'video').onTrack.emit(current);
  current.onReceiveRtp.emit(flow.packet(flow.stap([flow.sps, flow.pps, Buffer.from([0x65, 2])])));
  flow.peers[0].transceivers.find((entry) => entry.kind === 'video').onTrack.emit({ codec: { payloadType: 98 }, onReceiveRtp: event() });
  current.onReceiveRtp.emit(flow.packet(Buffer.from([0x41, 3]), 3000));
  assert.equal(flow.media.length, 2);
  assert.equal(flow.media.at(-1).keyFrame, false);
});
test('WebRTC RTP from a retired audio track cannot enter the replacement decoder', async (context) => {
  let flow = setup(context);
  await flow.transport.open();
  let old = { codec: { payloadType: 111 }, onReceiveRtp: event() };
  flow.peers[0].transceivers.find((entry) => entry.kind === 'audio').onTrack.emit(old);
  await flow.transport.close();
  await flow.transport.open();
  let current = { codec: { payloadType: 111 }, onReceiveRtp: event() };
  flow.peers[1].transceivers.find((entry) => entry.kind === 'audio').onTrack.emit(current);
  let send = (track, sequence) =>
    track.onReceiveRtp.emit({
      header: { sequenceNumber: sequence, timestamp: sequence * 960, payloadType: 111, ssrc: 7 },
      payload: Buffer.from([sequence]),
    });
  send(old, 1);
  context.mock.timers.tick(60);
  send(old, 2);
  assert.deepEqual(flow.media, []);
  send(current, 3);
  context.mock.timers.tick(60);
  send(current, 4);
  assert.equal(flow.media.length, 1);
  assert.deepEqual(flow.media[0].data, Buffer.from([3]));
});

test('a retired WebRTC audio track event cannot discard the current reorder queue', async (context) => {
  let flow = setup(context);
  await flow.transport.open();
  let old = flow.peers[0];
  await flow.transport.close();
  await flow.transport.open();
  let current = { codec: { payloadType: 111 }, onReceiveRtp: event() };
  flow.peers[1].transceivers.find((entry) => entry.kind === 'audio').onTrack.emit(current);
  let send = (sequence) =>
    current.onReceiveRtp.emit({
      header: { sequenceNumber: sequence, timestamp: sequence * 960, payloadType: 111, ssrc: 7 },
      payload: Buffer.from([sequence]),
    });
  send(1);
  context.mock.timers.tick(60);
  old.transceivers.find((entry) => entry.kind === 'audio').onTrack.emit({ codec: { payloadType: 111 }, onReceiveRtp: event() });
  send(2);
  assert.equal(flow.media.length, 1);
  assert.deepEqual(flow.media[0].data, Buffer.from([1]));
});
for (let kind of ['audio', 'video']) {
  test('WebRTC ignores a track advertising an unsupported ' + kind + ' codec', async (context) => {
    let flow = setup(context);
    await flow.transport.open();
    let track = { codec: { payloadType: 120 }, onReceiveRtp: event() };
    flow.peers[0].transceivers.find((entry) => entry.kind === kind).onTrack.emit(track);
    for (let sequence = 0; sequence < 3; sequence++) {
      track.onReceiveRtp.emit({
        header: { sequenceNumber: sequence, timestamp: sequence * 3000, payloadType: 120, ssrc: 7, marker: true },
        payload: Buffer.from([0x65, 1]),
      });
      context.mock.timers.tick(60);
    }
    assert.deepEqual(flow.media, []);
    assert.equal(flow.transport.ready, false);
  });
}

test('WebRTC a retired extension failure cannot close its replacement peer', async (context) => {
  let pending = Promise.withResolvers();
  let flow = setup(context, { extend: () => pending.promise });
  await flow.transport.open();
  flow.transport.setState(StreamTransport.STATE.READY);
  context.mock.timers.tick(30000);
  await setImmediate();
  assert.equal(flow.calls('JoinStream').filter((entry) => entry.command === 'extend').length, 1);
  await flow.transport.close();
  await flow.transport.open();
  let replacement = flow.peers.at(-1);
  pending.resolve({ status: 14 });
  await setImmediate();
  assert.equal(replacement.closed, 0);
  assert.equal(flow.transport.closed, false);
});
