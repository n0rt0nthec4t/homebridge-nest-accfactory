// Verify RTP wire formats through the output backend contract.
// Synthetic payloads exercise framing and clocks, not codec decoding.
import test from 'node:test';
import assert from 'node:assert/strict';
import RTPMuxer from '../src/plugins/camera/rtpmuxer.js';

const opus = { codec: 'opus', sampleRate: 48000, channels: 2 };
const aac = { codec: 'aac-lc', sampleRate: 48000, channels: 1, config: Buffer.from('1188', 'hex') };

function setup({ audio, maxPacketBytes = 1200, keyNal = Buffer.from([0x65, 1]) } = {}) {
  let now = 0;
  const packets = [];
  const muxer = new RTPMuxer({
    audio,
    maxPacketBytes,
    unixNow: () => 1700000000000 + now,
    writePacket: (data, metadata) => packets.push({ data, ...metadata }),
  });
  const video = (timestamp, nalUnits) =>
    muxer.writeVideo(Buffer.concat(nalUnits.flatMap((nal) => [Buffer.from([0, 0, 0, 1]), nal])), timestamp);
  video(0, [Buffer.from([0x67, 0x42]), Buffer.from([0x68, 1]), keyNal]);
  return {
    muxer,
    packets,
    video,
    audio: (timestamp, data) => muxer.writeAudio(data, timestamp),
    pump: (time) => {
      now = time;
      muxer.tick();
    },
    media: (track) => packets.filter((packet) => packet.kind === 'rtp' && packet.track === track).map((packet) => packet.data),
  };
}

test('H264 timestamps follow VFR source intervals independently of delivery time', () => {
  const flow = setup();
  flow.pump(0);
  for (const timestamp of [100, 200, 250, 300]) {
    flow.video(timestamp, [Buffer.from([0x61, 1])]);
  }
  flow.pump(300);
  const times = flow
    .media('video')
    .filter((data) => (data[1] & 0x80) !== 0)
    .map((data) => data.readUInt32BE(4));
  assert.deepEqual(
    times.slice(1).map((time, index) => (time - times[index]) >>> 0),
    [9000, 9000, 4500, 4500],
  );
  flow.muxer.close();
});

test('FU-A preserves NAL bytes, packet bounds and the access-unit marker', () => {
  const nal = Buffer.concat([Buffer.from([0x65]), Buffer.alloc(35, 0x33)]);
  const flow = setup({ maxPacketBytes: 24, keyNal: nal });
  flow.pump(0);
  const packets = flow.media('video');
  assert.equal(
    packets.every((data) => data.length <= 24),
    true,
  );
  assert.deepEqual(
    packets.map((data) => (data[1] & 0x80) !== 0),
    [false, false, false, false, false, true],
  );
  assert.equal(
    packets.every((data) => data.readUInt32BE(4) === packets[0].readUInt32BE(4)),
    true,
  );
  const fragments = packets.slice(2);
  assert.equal(fragments[0][13] & 0x80, 0x80);
  assert.equal(fragments.at(-1)[13] & 0x40, 0x40);
  assert.deepEqual(
    Buffer.concat([Buffer.from([(fragments[0][12] & 0xe0) | (fragments[0][13] & 31)]), ...fragments.map((data) => data.subarray(14))]),
    nal,
  );
  for (let index = 1; index < packets.length; index += 1) {
    assert.equal(packets[index].readUInt16BE(2), (packets[index - 1].readUInt16BE(2) + 1) & 0xffff);
  }
  flow.muxer.close();
});

test('Opus payloads remain compressed with source timing on a 48 kHz clock', () => {
  const format = { ...opus };
  const flow = setup({ audio: format });
  format.sampleRate = 16000;
  const data = Buffer.from([0xf8, 0xff, 0xfe]);
  for (const timestamp of [20, 40, 100]) {
    flow.audio(timestamp, data);
  }
  flow.pump(0);
  flow.pump(100);
  const packets = flow.media('audio');
  assert.deepEqual(
    packets.map((packet) => packet.subarray(12)),
    [data, data, data],
  );
  assert.equal((packets[1].readUInt32BE(4) - packets[0].readUInt32BE(4)) >>> 0, 960);
  assert.equal((packets[2].readUInt32BE(4) - packets[1].readUInt32BE(4)) >>> 0, 2880);
  assert.equal(
    packets.every((packet) => (packet[1] & 0x7f) === 97),
    true,
  );
  flow.muxer.close();
});

test('L16 converts endian order without changing retained PCM or splitting stereo samples', () => {
  const flow = setup({ audio: { codec: 'pcm-s16le', sampleRate: 48000, channels: 2 }, maxPacketBytes: 20 });
  const data = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0]);
  flow.audio(0, data);
  flow.pump(0);
  const packets = flow.media('audio');
  assert.deepEqual(
    packets.map((packet) => packet.subarray(12)),
    [Buffer.from([0, 1, 0, 2, 0, 3, 0, 4]), Buffer.from([0, 5, 0, 6])],
  );
  assert.equal((packets[1].readUInt32BE(4) - packets[0].readUInt32BE(4)) >>> 0, 2);
  assert.deepEqual(data, Buffer.from([1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0]));
  flow.muxer.close();
});

test('AAC-hbr includes a correctly sized raw AU and an access-unit marker', () => {
  const flow = setup({ audio: aac });
  const data = Buffer.from([0x21, 2, 3]);
  flow.audio(0, data);
  flow.pump(0);
  const packet = flow.media('audio')[0];
  assert.equal(packet.readUInt16BE(12), 16);
  assert.equal(packet.readUInt16BE(14), data.length << 3);
  assert.deepEqual(packet.subarray(16), data);
  assert.equal(packet[1] & 0x80, 0x80);
  flow.muxer.close();
});

test('invalid audio configuration is rejected without guessing codec metadata', () => {
  const flow = setup({ audio: aac });
  assert.throws(() => new RTPMuxer({ audio: { ...opus, sampleRate: 16000 }, writePacket: () => {} }), /48000/);
  assert.throws(() => new RTPMuxer({ audio: { ...aac, channels: 2 }, writePacket: () => {} }), /AudioSpecificConfig/);
  flow.pump(0);
  assert.equal(flow.media('video').length, 3);
  flow.muxer.close();
});

test('RTCP relates independent track origins to common NTP and retains their A/V offset', () => {
  const flow = setup({ audio: opus });
  flow.audio(40, Buffer.from([0xf8, 0xff, 0xfe]));
  flow.pump(0);
  flow.pump(1000);
  const reports = flow.packets.filter((packet) => packet.kind === 'rtcp').slice(-2);
  assert.deepEqual(reports[0].data.subarray(8, 16), reports[1].data.subarray(8, 16));
  const offsets = [];
  for (const { data, track } of reports) {
    const media = flow.media(track)[0];
    const rate = track === 'video' ? 90000 : 48000;
    offsets.push(1000 + (((media.readUInt32BE(4) - data.readUInt32BE(16)) | 0) * 1000) / rate);
    assert.equal(data[0], 0x80);
    assert.equal(data[1], 200);
    assert.equal(data.readUInt16BE(2), 6);
    assert.equal(data.readUInt32BE(4), media.readUInt32BE(8));
    assert.equal(data.readUInt32BE(20), flow.media(track).length);
    assert.equal(
      data.readUInt32BE(24),
      flow.media(track).reduce((sum, packet) => sum + packet.length - 12, 0),
    );
    assert.equal(data[28], 0x81);
    assert.equal(data[29], 202);
    assert.equal((data.readUInt16BE(30) + 1) * 4, data.length - 28);
    assert.equal(data.readUInt32BE(32), media.readUInt32BE(8));
    assert.equal(data[36], 1);
    assert.equal(data[38 + data[37]], 0);
    assert.equal(data.length % 4, 0);
  }
  assert.deepEqual(offsets, [0, 40]);
  assert.deepEqual(reports[0].data.subarray(38, 38 + reports[0].data[37]), reports[1].data.subarray(38, 38 + reports[1].data[37]));
  assert.equal(reports[0].data.readUInt32BE(8), 1700000001 + 2208988800);
  flow.muxer.close();
});

test('sender reports advance with the playback clock rather than the last media frame', () => {
  const flow = setup();
  flow.pump(0);
  flow.video(1000, [Buffer.from([0x61, 1])]);
  flow.pump(1100);
  const origin = flow.media('video')[0].readUInt32BE(4);
  const report = flow.packets.filter((packet) => packet.kind === 'rtcp').at(-1).data;
  assert.equal((flow.media('video').at(-1).readUInt32BE(4) - origin) >>> 0, 90000);
  assert.equal((report.readUInt32BE(16) - origin) >>> 0, 99000);
  assert.equal(report.readUInt32BE(20), 4);
  flow.muxer.close();
});

test('unsupported audio framing and RTCP sink failures surface to the backend owner', () => {
  for (const [audio, data, expected] of [
    [aac, Buffer.from([0xff, 0xf1, 0x4c]), /ADTS/],
    [aac, Buffer.alloc(1500), /fragmentation/],
    [opus, Buffer.alloc(1500), /packet budget/],
    [{ codec: 'pcm-s16le', sampleRate: 48000, channels: 2 }, Buffer.alloc(3), /whole sample/],
  ]) {
    const flow = setup({ audio });
    assert.throws(() => flow.audio(0, data), expected);
    flow.muxer.close();
  }
  const output = new RTPMuxer({
    unixNow: () => 1700000000000,
    writePacket: (data, metadata) => {
      if (metadata.kind === 'rtcp') {
        throw new Error('control failed');
      }
    },
  });
  output.writeVideo(Buffer.from([0x65, 1]), 0);
  assert.throws(() => output.tick(1700000000000), /control failed/);
  assert.equal(output.blocked('video'), true);
  assert.throws(() => output.writeVideo(Buffer.from([0x61, 1]), 1), /closed/);
});

test('RTP timestamp arithmetic wraps at 32 bits without changing source duration', () => {
  const flow = setup();
  flow.pump(0);
  const timestamp = (0x100000000 + 9000) / 90;
  flow.video(timestamp, [Buffer.from([0x61, 1])]);
  flow.pump(timestamp);
  const packets = flow.media('video');
  assert.equal((packets.at(-1).readUInt32BE(4) - packets[0].readUInt32BE(4)) >>> 0, 9000);
  assert.throws(() => new RTPMuxer({ maxPacketBytes: 10, writePacket: () => {} }), /packet size/);
  flow.muxer.close();
});

for (let crc of [false, true]) {
  test('NexusTalk ADTS derives AAC configuration and strips headers: CRC=' + crc, async () => {
    let { adts } = await import('./helpers/aac-fixtures.js');
    let packets = [];
    let output = new RTPMuxer({ audio: { codec: 'aac' }, writePacket: (data, metadata) => packets.push({ data, ...metadata }) });
    let raw = Buffer.from([0x21, 0x10, 0x56]);
    let framed = adts(raw, { crc });
    let snapshot = Buffer.from(framed);
    assert.equal(output.hasAudio, true);
    assert.equal(output.blocked('video'), true);
    output.configureAudio(framed);
    assert.equal(output.needsAudioConfig, false);
    assert.equal(output.blocked('video'), false);
    output.writeVideo(Buffer.from([0, 0, 0, 1, 0x65, 1]), 1000);
    output.writeAudio(Buffer.concat([framed, framed]), 1040);
    let audio = packets.filter((packet) => packet.kind === 'rtp' && packet.track === 'audio');
    assert.equal(audio.length, 2);
    for (let packet of audio) {
      assert.deepEqual(packet.data.subarray(16), raw);
      assert.equal(packet.data.readUInt16BE(14) >> 3, raw.length);
    }
    assert.equal((audio[1].data.readUInt32BE(4) - audio[0].data.readUInt32BE(4)) >>> 0, 1024);
    assert.deepEqual(framed, snapshot);
    await output.close();
  });
}

test('ADTS rejects unsupported/truncated framing without guessing the source codec', async () => {
  let { adts } = await import('./helpers/aac-fixtures.js');
  let raw = Buffer.from([0x21, 0x10]);
  for (let frame of [
    Buffer.alloc(0),
    Buffer.from([0xff, 0xf1]),
    adts(raw, { profile: 1 }),
    adts(raw, { frequency: 15 }),
    adts(raw, { channels: 0 }),
    adts(raw, { blocks: 1 }),
    adts(raw).subarray(0, 8),
  ]) {
    let output = new RTPMuxer({ audio: { codec: 'aac' }, writePacket: () => {} });
    output.configureAudio(frame);
    assert.equal(output.closed, true);
    assert.match(output.error.message, /ADTS/);
    await output.close();
  }
});

test('ADTS aggregate validation and capacity failures retire only their output before sending audio', async () => {
  let { adts } = await import('./helpers/aac-fixtures.js');
  let framed = adts(Buffer.from([0x21, 0x10]));
  for (let data of [
    Buffer.concat([framed, framed.subarray(0, 8)]),
    Buffer.concat([framed, adts(Buffer.from([1]), { frequency: 4 })]),
    adts(Buffer.alloc(1500)),
    Buffer.concat(Array(257).fill(framed)),
  ]) {
    let packets = [];
    let output = new RTPMuxer({ audio: { codec: 'aac' }, writePacket: (data, metadata) => packets.push({ data, ...metadata }) });
    output.configureAudio(framed);
    output.writeVideo(Buffer.from([0, 0, 0, 1, 0x65, 1]), 0);
    assert.throws(() => output.writeAudio(data, 40), /Truncated|format changed|fragmentation|Too many/);
    assert.equal(output.closed, true);
    assert.equal(packets.filter((packet) => packet.kind === 'rtp' && packet.track === 'audio').length, 0);
    await output.close();
  }
});

test('a shared source epoch preserves audio offset when audio is delivered before its older keyframe', async () => {
  let packets = [];
  let output = new RTPMuxer({
    audio: opus,
    unixNow: () => 1700000000000,
    writePacket: (data, metadata) => packets.push({ data, ...metadata }),
  });
  output.setSourceEpoch(1000);
  output.tick();
  assert.equal(packets.length, 0, 'clock bootstrap alone must not send reports or media');
  output.writeAudio(Buffer.from([0xf8, 0xff, 0xfe]), 1040);
  output.setSourceEpoch(5000);
  output.writeVideo(Buffer.from([0, 0, 0, 1, 0x65, 1]), 1000);
  output.tick();
  for (let track of ['video', 'audio']) {
    let media = packets.find((packet) => packet.kind === 'rtp' && packet.track === track).data;
    let report = packets.find((packet) => packet.kind === 'rtcp' && packet.track === track).data;
    assert.equal((media.readUInt32BE(4) - report.readUInt32BE(16)) >>> 0, track === 'video' ? 0 : 1920);
  }
  await output.close();
});

for (let firstTrack of ['video', 'audio']) {
  test('a late first ' + (firstTrack === 'video' ? 'audio' : 'video') + ' frame can precede the shared RTP epoch', async (context) => {
    let packets = [];
    let output = new RTPMuxer({
      audio: opus,
      unixNow: () => 1700000000000,
      writePacket: (data, metadata) => packets.push({ data, ...metadata }),
    });
    context.after(() => output.close());
    let write = (track, timestamp) => {
      if (track === 'video') {
        output.writeVideo(Buffer.from([0x65, 1]), timestamp);
      } else {
        output.writeAudio(Buffer.from([0xf8, 0xff, 0xfe]), timestamp);
      }
    };
    let lateTrack = firstTrack === 'video' ? 'audio' : 'video';
    output.setSourceEpoch(100040);
    write(firstTrack, 100040);
    output.tick();
    write(lateTrack, 100000);
    write(lateTrack, 100020);
    assert.throws(() => write(lateTrack, 100020), /increasing source/);
    assert.throws(() => write(lateTrack, 99999), /increasing source/);
    assert.throws(() => write(lateTrack, NaN), /source media time/);
    assert.throws(() => write(lateTrack, Infinity), /source media time/);

    for (let track of ['video', 'audio']) {
      let media = packets.find((packet) => packet.kind === 'rtp' && packet.track === track).data;
      let report = packets.find((packet) => packet.kind === 'rtcp' && packet.track === track).data;
      let rate = track === 'video' ? 90000 : 48000;
      // Signed modular differences retain the earlier track's negative offset.
      assert.equal((media.readUInt32BE(4) - report.readUInt32BE(16)) | 0, track === firstTrack ? 0 : -0.04 * rate);
    }
  });
}

test('a scheduler tick captured before first media waits for the playback clock before reporting', async (context) => {
  let now = 1700000000000;
  let packets = [];
  let output = new RTPMuxer({ unixNow: () => now, writePacket: (data, metadata) => packets.push({ data, ...metadata }) });
  context.after(() => output.close());
  let tickStart = now;
  now += 2;
  output.writeVideo(Buffer.from([0x65, 1]), 1000);
  output.tick(tickStart);
  assert.equal(packets.filter((packet) => packet.kind === 'rtcp').length, 0);
  output.tick(now);
  assert.equal(packets.filter((packet) => packet.kind === 'rtcp').length, 1);
  output.writeVideo(Buffer.from([0x61, 1]), 1020);
  output.tick(now - 1);
  assert.equal(packets.filter((packet) => packet.kind === 'rtcp').length, 1);
  output.tick(now + 1000);
  assert.equal(packets.filter((packet) => packet.kind === 'rtcp').length, 2);
});
