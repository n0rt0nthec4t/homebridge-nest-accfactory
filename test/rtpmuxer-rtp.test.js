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

for (let audioDiagnostics of [false, true]) {
  test('audio timing counters observe gaps/overlaps without changing payloads; enabled=' + audioDiagnostics, async () => {
    let packets = [];
    let muxer = new RTPMuxer({ audio: opus, audioDiagnostics, writePacket: (data) => packets.push(data) });
    let payload = Buffer.from([0xf8, 0xff, 0xfe]);
    for (let timestamp of [0, 20, 160, 170, 190]) {
      muxer.writeAudio(payload, timestamp);
    }
    assert.equal(packets.length, 5);
    assert.equal(
      packets.every((packet) => packet.subarray(12).equals(payload)),
      true,
    );
    assert.deepEqual(
      packets.slice(1).map((packet, index) => (packet.readUInt32BE(4) - packets[index].readUInt32BE(4)) >>> 0),
      [960, 6720, 480, 960],
    );
    if (audioDiagnostics === true) {
      assert.deepEqual(muxer.audioTiming, {
        units: 5,
        unknownDurations: 0,
        gaps: 1,
        overlaps: 1,
        maxGapMs: 120,
        maxOverlapMs: 10,
        totalGapMs: 120,
        totalOverlapMs: 10,
      });
      let snapshot = muxer.audioTiming;
      snapshot.gaps = 99;
      assert.equal(muxer.audioTiming.gaps, 1);
    } else {
      assert.equal(muxer.audioTiming, undefined);
    }
    await muxer.close();
  });
}

for (let [toc, count, duration] of [
  [0x00, undefined, 10],
  [0x08, undefined, 20],
  [0x10, undefined, 40],
  [0x18, undefined, 60],
  [0x60, undefined, 10],
  [0x68, undefined, 20],
  [0x80, undefined, 2.5],
  [0x88, undefined, 5],
  [0x90, undefined, 10],
  [0x98, undefined, 20],
  [0x99, undefined, 40],
  [0x9a, undefined, 40],
  [0x9b, 3, 60],
  [0x83, 48, 120],
]) {
  test('Opus timing reads TOC frame configuration and count: ' + toc + '/' + count, async () => {
    let muxer = new RTPMuxer({ audio: opus, audioDiagnostics: true, writePacket: () => {} });
    let payload = Buffer.from([toc, count ?? 0, 1]);
    muxer.writeAudio(payload, 0);
    muxer.writeAudio(payload, duration);
    assert.equal(muxer.audioTiming.gaps, 0);
    assert.equal(muxer.audioTiming.overlaps, 0);
    assert.equal(muxer.audioTiming.unknownDurations, 0);
    await muxer.close();
  });
}

for (let payload of [Buffer.from([0x9b]), Buffer.from([0x9b, 0]), Buffer.from([0x9b, 7])]) {
  test('unknown Opus duration is counted without rejecting or guessing media: ' + payload.toString('hex'), async () => {
    let packets = [];
    let muxer = new RTPMuxer({ audio: opus, audioDiagnostics: true, writePacket: (data) => packets.push(data) });
    muxer.writeAudio(payload, 0);
    muxer.writeAudio(Buffer.from([0xf8, 0xff, 0xfe]), 150);
    assert.equal(packets.length, 2);
    assert.equal(muxer.audioTiming.unknownDurations, 1);
    assert.equal(muxer.audioTiming.gaps, 0);
    await muxer.close();
  });
}

test('batched AAC timing counts each 1024-sample AU using its ADTS sample rate', async () => {
  let { adts } = await import('./helpers/aac-fixtures.js');
  let frame = adts(Buffer.from([0x21, 0x10]), { frequency: 4 });
  let muxer = new RTPMuxer({ audio: { codec: 'aac' }, audioDiagnostics: true, writePacket: () => {} });
  muxer.configureAudio(frame);
  muxer.writeAudio(Buffer.concat([frame, frame]), 0);
  muxer.writeAudio(frame, (2048 * 1000) / 44100);
  assert.equal(muxer.audioTiming.units, 3);
  assert.equal(muxer.audioTiming.gaps, 0);
  assert.equal(muxer.audioTiming.overlaps, 0);
  await muxer.close();
});

test('raw AAC timing uses sample counts rather than delivery intervals', async () => {
  let muxer = new RTPMuxer({ audio: aac, audioDiagnostics: true, writePacket: () => {} });
  let data = Buffer.from([0x21, 0x10]);
  for (let index = 0; index < 100; index++) {
    muxer.writeAudio(data, (index * 1024 * 1000) / 48000);
  }
  assert.equal(muxer.audioTiming.units, 100);
  assert.equal(muxer.audioTiming.gaps, 0);
  assert.equal(muxer.audioTiming.overlaps, 0);
  await muxer.close();
});

test('audio timing handles RTP timestamp rollover without reporting another discontinuity', async () => {
  let packets = [];
  let muxer = new RTPMuxer({ audio: opus, audioDiagnostics: true, writePacket: (packet) => packets.push(packet) });
  let payload = Buffer.from([0xf8, 0xff, 0xfe]);
  muxer.writeAudio(payload, 0);
  let wrapTime = (0x100000000 - packets[0].readUInt32BE(4)) / 48;
  if (wrapTime <= 20) {
    wrapTime += 0x100000000 / 48;
  }
  muxer.writeAudio(payload, wrapTime - 10);
  let before = muxer.audioTiming;
  muxer.writeAudio(payload, wrapTime + 10);
  assert.equal(packets[2].readUInt32BE(4), 480);
  assert.equal(muxer.audioTiming.gaps, before.gaps);
  assert.equal(muxer.audioTiming.overlaps, before.overlaps);
  await muxer.close();
});

test('decoded PCM formats are rejected at RTP output creation', () => {
  for (let audio of [
    { codec: 'pcm', profile: 's16le', sampleRate: 48000, channels: 2 },
    { codec: 'pcm-s16le', sampleRate: 48000, channels: 2 },
  ]) {
    assert.throws(() => new RTPMuxer({ audio, writePacket: () => {} }), /supported mono\/stereo audio format/);
  }
});
