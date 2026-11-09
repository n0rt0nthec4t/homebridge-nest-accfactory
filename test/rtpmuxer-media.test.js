// Optional real FFmpeg receiver checks. Set FFMPEG_TEST_BINARY to a 7.1+ binary.
// Synthetic source media verifies timing and decoding, not camera/HomeKit hardware.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import dgram from 'node:dgram';
import tls from 'node:tls';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import H264 from '../src/plugins/camera/h264.js';
import RTPMuxer from '../src/plugins/camera/rtpmuxer.js';
import FFmpeg from '../src/plugins/camera/ffmpeg.js';
import StreamTransport from '../src/plugins/camera/streamtransport.js';
import { UDPPorts } from '../src/utils.js';
import { importSource } from './helpers/import-source.js';
import { nexusPacket, nexusSocket } from './helpers/nexustalk-fixtures.js';

let { default: Streamer } = await importSource(new URL('../src/plugins/camera/streamer.js', import.meta.url));
let { default: NexusTalk } = await importSource(new URL('../src/plugins/camera/nexustalk.js', import.meta.url));

const binary = process.env.FFMPEG_TEST_BINARY;
let frames;
let markerVideo = new Map();
let aac;
let markerAAC = new Map();
// A complete 20 ms Opus silence packet lets FFmpeg verify native decoding/timing
// without installing a separate JavaScript codec library to generate test media.
let opusSilence = Buffer.from([0xf8, 0xff, 0xfe]);

for (let [
  reordered,
  requestOffset = 0,
  sourceClockOffset = 0,
  arriveDuringStart = false,
  audioOffset = 40,
  viaNexus = false,
  openingAudioDelta = 0,
] of [
    [false],
    [true],
    [false, 100],
    [false, 100, -1000],
    [false, 100, 1000],
    [true, 100],
    [true, 100, -1000],
    [false, 2499.999],
    [false, 2500],
    [false, 2500.001],
    [false, 66.667],
    [true, 1999.999],
    [true, 2000],
    [true, 2000.001],
    [true, 133.334],
    [true, 200.001],
    [false, 100, -3000],
    [true, 100, -3000],
    [false, 100, 0, true],
    [true, 100, 0, true],
    [false, 100, 0, false, 1.322021484375],
    [true, 100, 0, false, 1.322021484375],
    [false, 100, 0, false, -40],
    [true, 100, 0, false, -40],
    [false, 100, 0, false, 2336],
    [false, 100, 0, false, 1.322021484375, true],
    [true, 100, 0, false, 1.322021484375, true],
    [true, 2000.001, 0, false, -40, true],
    [false, 100, 0, true, 40, true],
    [false, 100, 0, false, 35, true, 1024],
    [true, 2000.001, 0, false, 51, true, 3072],
    [false, 100, 0, false, -40, true, -1024],
  ]) {
  test(
    'Streamer HKSV prebuffer preserves flash/tone alignment; B-frames=' +
      reordered +
      ' requestOffset=' +
      requestOffset +
      ' sourceClockOffset=' +
      sourceClockOffset +
      ' newArrivals=' +
      arriveDuringStart +
      ' audioOffset=' +
      audioOffset +
      ' NexusTalk=' +
      viaNexus +
      ' openingAudioDelta=' +
      openingAudioDelta,
    { skip: binary === undefined ? 'Set FFMPEG_TEST_BINARY for real media checks' : false, timeout: 15000 },
    async (context) => {
      let controller = new AbortController();
      let reading;
      let sockets = [];
      let transport;
      if (viaNexus === true) {
        context.mock.method(tls, 'connect', (settings, handshake) => {
          let socket = nexusSocket(settings, handshake);
          sockets.push(socket);
          return socket;
        });
        transport = new NexusTalk({ uuid: 'camera.test', host: 'camera.example', apiAccess: { token: 'fixture-token' } });
      } else {
        transport = new StreamTransport();
        Object.assign(transport.audio, { codec: 'aac', sampleRate: 48000, channels: 1 });
        transport.open = async () => transport.setState(StreamTransport.STATE.READY);
        transport.close = async () => transport.setState(StreamTransport.STATE.CLOSED);
      }
      let streamer = new Streamer(
        'prebuffer-marker-' + reordered + '-' + requestOffset + '-' + sourceClockOffset,
        { online: true, streaming_enabled: true, audio_enabled: true },
        { transport, bufferDuration: 15000 },
      );
      context.after(async () => {
        controller.abort();
        await streamer.stopEverything();
        await reading;
        for (let socket of sockets) {
          socket.emit('close');
        }
      });
      let buffering = streamer.onMessage(Streamer.MESSAGE_TYPE.START_BUFFER);
      if (viaNexus === true) {
        let deadline = performance.now() + 2000;
        while (sockets.length === 0 && performance.now() < deadline) {
          await delay(1);
        }
        assert.equal(sockets.length, 1, 'NexusTalk did not acquire its TLS socket');
        sockets[0].handshake();
      }
      await buffering;
      let source = reordered === true ? bFrameVideo(true, 75).units : videoFrames(true, 70);
      // Supply enough trailing video to close the complete fragment containing
      // the marker before normal HomeKit cancellation discards the partial tail.
      let events = [...source, ...source.slice(0, 40)].map((data, index) => ({
        type: 'video',
        codec: 'h264',
        data,
        keyFrame: H264.getNALUnits(data).some((nal) => nal.type === 5),
        timestamp:
          reordered === true
            ? index < source.length
              ? bFrameVideo(true, 75).times[index]
              : 6000 + bFrameVideo(true, 75).times[index - source.length]
            : index >= source.length
              ? 6000 + (index - source.length) * 75
              : index < 20
                ? index * 100
                : index < 60
                  ? 2000 + (index - 20) * 50
                  : 4000 + (index - 60) * 100,
      }));
      // Place markers at five source seconds, after the IDR selected by cuts
      // immediately beyond the earlier keyframe. Original four-second fixtures
      // remain available to the independent receiver tests below.
      let audio = aacFrames(true, 5);
      for (let [index, data] of [...audio, ...audio.slice(0, 140)].entries()) {
        let timestamp = audioOffset + (index * 1024 * 1000) / 48000;
        // Keep seek cases continuous, matching the reported zero-gap session.
        // The original cases separately exercise short missing audio stretches.
        if (requestOffset > 0 || timestamp < 500 || timestamp >= 3500 || timestamp % 500 >= 40) {
          events.push({ type: 'audio', codec: 'aac', timestamp, data });
        }
      }
      let watermark = {};
      for (let event of events) {
        watermark[event.type] = Math.max(watermark[event.type] ?? -Infinity, event.timestamp);
        event.deliverAt = watermark[event.type];
      }
      events.sort((left, right) => left.deliverAt - right.deliverAt);
      let epoch = 1700000000000;
      let previousTicks = { video: 0, audio: 0 };
      let firstNexusAudio = true;
      if (viaNexus === true) {
        sockets[0].emit('data', nexusPacket(200));
        sockets[0].emit(
          'data',
          nexusPacket(202, 'PlaybackBegin', {
            sessionId: 7,
            channels: [
              { channelId: 1, codec: 'H264', sampleRate: 90000, startTime: (epoch + sourceClockOffset) / 1000 },
              { channelId: 2, codec: 'AAC', sampleRate: 48000, startTime: (epoch + sourceClockOffset + audioOffset) / 1000 },
            ],
          }),
        );
      }
      let deliver = (event) => {
        if (viaNexus === true) {
          // Exercise the production protobuf parser and signed tick conversion,
          // including negative B-frame deltas and independent channel anchors.
          let ticks = event.type === 'video' ? Math.round(event.timestamp * 90) : Math.round((event.timestamp - audioOffset) * 48);
          let delta = ticks - previousTicks[event.type];
          if (event.type === 'audio' && firstNexusAudio === true) {
            delta += openingAudioDelta;
            firstNexusAudio = false;
          }
          sockets[0].emit(
            'data',
            nexusPacket(204, 'PlaybackPacket', {
              sessionId: 7,
              channelId: event.type === 'video' ? 1 : 2,
              timestampDelta: delta,
              payload: event.data,
            }),
          );
          previousTicks[event.type] = ticks;
        } else {
          transport.emitMedia({ ...event, timestamp: epoch + sourceClockOffset + event.timestamp });
        }
      };
      for (let event of events.filter((event) => arriveDuringStart === false || event.deliverAt < 1500)) {
        deliver(event);
      }

      let output = await streamer.onMessage(Streamer.MESSAGE_TYPE.START_RECORD, {
        sessionID: 'prebuffer-marker',
        options: { includeAudio: true, recordTime: epoch + requestOffset, signal: controller.signal },
      });
      let manager = new FFmpeg(binary);
      let handle;
      let startRecording = manager.startRecording.bind(manager);
      context.mock.method(manager, 'startRecording', (settings) => {
        handle = startRecording(settings);
        return handle;
      });
      output.start(manager, {
        sourceAudio: 'aac',
        video: { profile: 'baseline', level: '3.1', fps: 30, iFrameInterval: 2000, bitRate: 200 },
      });
      if (arriveDuringStart === true) {
        // The next IDR and marker arrive after the prebuffer boundary was
        // captured and FFmpeg started. Exercise startup together with new media.
        for (let event of events.filter((event) => event.deliverAt >= 1500)) {
          deliver(event);
        }
      }
      let chunks = [];
      reading = (async () => {
        for await (let fragment of output.fragments()) {
          chunks.push(fragment);
        }
      })();
      let deadline = performance.now() + 6000;
      let inspected = 0;
      let markersReady = false;
      while (markersReady === false && handle.active === true && performance.now() < deadline) {
        await delay(10);
        if (chunks.length < 2 || chunks.length === inspected) {
          continue;
        }
        inspected = chunks.length;
        // Scene changes and late cuts change fragment lengths. Wait for both
        // actual markers instead of assuming a fragment count means six seconds.
        let probe = spawnSync(
          binary,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-i',
            'pipe:0',
            '-map',
            '0:a:0',
            '-ar',
            '16000',
            '-ac',
            '1',
            '-f',
            's16le',
            'pipe:1',
            '-map',
            '0:v:0',
            '-vf',
            'scale=1:1,format=gray',
            '-f',
            'rawvideo',
            'pipe:3',
          ],
          { input: Buffer.concat(chunks), stdio: ['pipe', 'pipe', 'pipe', 'pipe'], timeout: 2000, maxBuffer: 1024 * 1024 },
        );
        assert.equal(probe.status, 0, probe.stderr?.toString());
        let toneReady = false;
        for (let offset = 0; offset + 2 <= probe.stdout.length; offset += 2) {
          if (Math.abs(probe.stdout.readInt16LE(offset)) > 1000) {
            toneReady = true;
            break;
          }
        }
        markersReady = toneReady === true && probe.output[3].some((value) => value > 200);
      }
      assert.equal(markersReady, true, 'The selected recording did not deliver both markers: ' + handle.diagnosticLines.join('\n'));
      controller.abort();
      await output.stop();
      await reading;
      let decoded = spawnSync(
        binary,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          'pipe:0',
          '-map',
          '0:a:0',
          '-ar',
          '16000',
          '-ac',
          '1',
          '-f',
          's16le',
          'pipe:1',
          '-map',
          '0:v:0',
          '-f',
          'framecrc',
          'pipe:3',
          '-map',
          '0:v:0',
          '-vf',
          'scale=1:1,format=gray',
          '-f',
          'rawvideo',
          'pipe:4',
          '-map',
          '0:a:0',
          '-f',
          'framecrc',
          'pipe:5',
        ],
        { input: Buffer.concat(chunks), stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'], timeout: 5000, maxBuffer: 1024 * 1024 },
      );
      assert.equal(decoded.status, 0, decoded.stderr?.toString());
      let videoCRC = decoded.output[3].toString();
      let base = /^#tb 0: (\d+)\/(\d+)$/m.exec(videoCRC);
      let videoPTS = videoCRC.split('\n').filter((line) => line.startsWith('0,') === true);
      assert.ok(videoPTS.length > 0, 'The selected recording has no decoded video');
      let videoStart = (Number(videoPTS[0].split(',')[2]) * Number(base[1])) / Number(base[2]);
      let audioCRC = decoded.output[5].toString();
      let audioBase = /^#tb 0: (\d+)\/(\d+)$/m.exec(audioCRC);
      let firstAudio = audioCRC.split('\n').find((line) => line.startsWith('0,') === true);
      let audioStart = (Number(firstAudio.split(',')[2]) * Number(audioBase[1])) / Number(audioBase[2]);
      context.diagnostic('Decoded starts: video=' + videoStart + ' audio=' + audioStart);
      if (requestOffset === 0 && sourceClockOffset === 0) {
        assert.ok(Math.abs(videoStart) < 1 / 30, 'The decoded video lost its source start: ' + videoStart);
      }
      context.diagnostic('PCM duration=' + decoded.stdout.length / 32000 + '; fragments=' + chunks.length);
      let onset;
      for (let offset = 0; offset + 2 <= decoded.stdout.length; offset += 2) {
        if (Math.abs(decoded.stdout.readInt16LE(offset)) > 1000) {
          onset = offset / 32000;
          break;
        }
      }
      context.diagnostic('Decoded prebuffer tone starts at ' + onset + ' seconds');
      // Seek can discard the original IDR and its audio, or select a different
      // window when the camera clock differs from wall time. Compare actual
      // flash/tone content after that selection, not just the first output PTS.
      let flashIndex = decoded.output[4].findIndex((value) => value > 200);
      assert.ok(flashIndex >= 0, 'The selected recording lost the video flash');
      let flashTime = (Number(videoPTS[flashIndex].split(',')[2]) * Number(base[1])) / Number(base[2]);
      let difference = onset + audioStart - flashTime;
      context.diagnostic('Selected recording tone/flash difference=' + difference);
      // The generated ADTS fixture includes one 1024-sample AAC priming block.
      // Allow one output video frame for marker placement after CFR conversion.
      let expectedDifference = audioOffset / 1000 + 1024 / 48000;
      assert.ok(Math.abs(difference - expectedDifference) < 1 / 30, 'Recording selection changed A/V alignment: ' + difference);
    },
  );
}

test(
  'HKSV recording preserves three flash/tone markers across 15 to 30 to 15 fps input',
  { skip: binary === undefined ? 'Set FFMPEG_TEST_BINARY for real media checks' : false, timeout: 15000 },
  async (context) => {
    let source = videoFrames(true, 15);
    let markerTimes = [1, 80 / 15 + 15 / 30, 80 / 15 + 80 / 30 + 1];
    // Each segment begins with an IDR and black pictures, then turns white at
    // frame 15. Source timestamps, not packet delivery speed, set the frame rate.
    let events = [15, 30, 15].flatMap((fps, segment) =>
      source.map((data, index) => ({
        type: 'video',
        data,
        timestamp: (segment === 0 ? 0 : segment === 1 ? 80000 / 15 : 80000 / 15 + 80000 / 30) + (index * 1000) / fps,
      })),
    );
    let encoded = spawnSync(
      binary,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'aevalsrc=0.125*sin(2*PI*440*t)*(' +
          markerTimes.map((time) => 'between(t\\,' + time + '\\,' + (time + 0.2) + ')').join('+') +
          '):s=48000',
        '-t',
        String(80 / 15 + 80 / 30 + 80 / 15),
        '-c:a',
        'aac',
        '-b:a',
        '64k',
        '-ac',
        '1',
        '-f',
        'adts',
        'pipe:1',
      ],
      { timeout: 10000, maxBuffer: 2 * 1024 * 1024 },
    );
    assert.equal(encoded.status, 0, encoded.stderr?.toString());
    let audio = [];
    for (let offset = 0; offset < encoded.stdout.length;) {
      let data = encoded.stdout;
      let size = ((data[offset + 3] & 3) << 11) | (data[offset + 4] << 3) | (data[offset + 5] >> 5);
      assert.ok(size > 7 && offset + size <= data.length, 'Invalid generated AAC frame');
      audio.push(data.subarray(offset, offset + size));
      offset += size;
    }
    for (let [index, data] of audio.entries()) {
      events.push({ type: 'audio', data, timestamp: (index * 1024 * 1000) / 48000 });
    }
    events.sort((left, right) => left.timestamp - right.timestamp);
    let output = new RTPMuxer({ audio: { codec: 'aac', sampleRate: 48000, channels: 1 } });
    output.configureAudio(audio[0]);
    context.after(() => output.close());
    await output.prepare();
    let manager = new FFmpeg(binary);
    let handle = manager.startRecording({
      id: 'fps-transition',
      input: output.input,
      sourceAudio: 'aac',
      video: { profile: 'baseline', level: '3.1', fps: 30, iFrameInterval: 2000, bitRate: 200 },
    });
    context.after(() => handle.stop('SIGKILL'));
    let chunks = [];
    let reading = (async () => {
      for await (let fragment of manager.fragments(handle)) {
        chunks.push(fragment);
      }
    })();
    let deadline = performance.now() + 5000;
    while (output.blocked('video') === true && handle.active === true && performance.now() < deadline) {
      await delay(5);
    }
    assert.equal(output.blocked('video'), false, handle.diagnosticLines.join('\n'));
    let started = performance.now();
    for (let event of events) {
      let due = started + event.timestamp / 4;
      if (due > performance.now()) {
        await delay(due - performance.now());
      }
      while (output.blocked(event.type) === true && handle.active === true && performance.now() < deadline + 5000) {
        await delay(5);
      }
      assert.equal(handle.active, true, handle.diagnosticLines.join('\n'));
      if (event.type === 'video') {
        output.writeVideo(event.data, event.timestamp);
      } else {
        output.writeAudio(event.data, event.timestamp);
      }
      output.tick();
    }
    while (output.queuedBytes() > 0 && performance.now() < deadline + 5000) {
      await delay(5);
    }
    await output.close();
    let result = await handle.finished;
    await reading;
    assert.equal(result.code, 0, handle.diagnosticLines.join('\n'));
    let decoded = spawnSync(
      binary,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        'pipe:0',
        '-map',
        '0:a:0',
        '-ar',
        '16000',
        '-ac',
        '1',
        '-f',
        's16le',
        'pipe:1',
        '-map',
        '0:v:0',
        '-f',
        'framecrc',
        'pipe:3',
        '-map',
        '0:v:0',
        '-vf',
        'scale=1:1,format=gray',
        '-f',
        'rawvideo',
        'pipe:4',
        '-map',
        '0:a:0',
        '-f',
        'framecrc',
        'pipe:5',
      ],
      { input: Buffer.concat(chunks), stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'], timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
    );
    assert.equal(decoded.status, 0, decoded.stderr?.toString());
    let videoCRC = decoded.output[3].toString();
    let videoBase = /^#tb 0: (\d+)\/(\d+)$/m.exec(videoCRC);
    let videoPTS = videoCRC
      .split('\n')
      .filter((line) => line.startsWith('0,') === true)
      .map((line) => (Number(line.split(',')[2]) * Number(videoBase[1])) / Number(videoBase[2]));
    assert.ok(videoPTS.length >= 390, 'Recording lost video duration across a rate transition');
    for (let index = 1; index < videoPTS.length; index++) {
      assert.ok(Math.abs(videoPTS[index] - videoPTS[index - 1] - 1 / 30) < 0.00001, 'Recording is not continuous 30 fps');
    }
    let flashes = [];
    for (let index = 0; index < decoded.output[4].length; index++) {
      if (decoded.output[4][index] > 200 && (index === 0 || decoded.output[4][index - 1] <= 200)) {
        flashes.push(videoPTS[index]);
      }
    }
    let audioCRC = decoded.output[5].toString();
    let audioBase = /^#tb 0: (\d+)\/(\d+)$/m.exec(audioCRC);
    let firstAudio = audioCRC.split('\n').find((line) => line.startsWith('0,') === true);
    let audioStart = (Number(firstAudio.split(',')[2]) * Number(audioBase[1])) / Number(audioBase[2]);
    let tones = [];
    for (let offset = 0; offset + 2 <= decoded.stdout.length; offset += 2) {
      let time = audioStart + offset / 32000;
      if (Math.abs(decoded.stdout.readInt16LE(offset)) > 1000 && (tones.length === 0 || time - tones.at(-1) > 0.5)) {
        tones.push(time);
      }
    }
    assert.equal(flashes.length, 3, 'Missing a video marker before, during or after the transitions');
    assert.equal(tones.length, 3, 'Missing an audio marker before, during or after the transitions');
    let offsets = tones.map((time, index) => time - flashes[index]);
    for (let [index, offset] of offsets.entries()) {
      assert.ok(Math.abs(flashes[index] - markerTimes[index]) <= 1 / 30, 'Video marker moved at a rate transition');
      // The source AAC fixture includes a 1024-sample encoder priming block.
      assert.ok(Math.abs(offset - 1024 / 48000) < 1 / 30, 'A/V alignment changed: ' + offsets.join(', '));
    }
    assert.ok(Math.max(...offsets) - Math.min(...offsets) < 1 / 30, 'A/V offset accumulated across rate transitions');
    context.diagnostic('Decoded tone-minus-flash offsets (seconds): ' + offsets.join(', '));
  },
);

function videoFrames(markers = false, markerFrame = 60) {
  let cached = markers === true ? markerVideo.get(markerFrame) : frames;
  if (cached !== undefined) {
    return cached;
  }
  const encoded = spawnSync(
    binary,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      markers === true
        ? 'color=c=black:size=160x90:rate=30,drawbox=color=white:t=fill:enable=gte(n\\,' + markerFrame + ')'
        : 'testsrc2=size=160x90:rate=30',
      '-frames:v',
      '80',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-tune',
      'zerolatency',
      '-x264-params',
      'aud=1:repeat-headers=1:keyint=30:scenecut=0:bframes=0',
      '-f',
      'h264',
      'pipe:1',
    ],
    { timeout: 10000, maxBuffer: 8 * 1024 * 1024 },
  );
  assert.equal(encoded.status, 0, encoded.stderr?.toString());
  let units = [];
  let parts = [];
  for (const nal of H264.getNALUnits(encoded.stdout)) {
    if (nal.type === 9 && parts.length > 0) {
      units.push(Buffer.concat(parts));
      parts = [];
    }
    parts.push(H264.NALUS.START_CODE, nal.data);
  }
  if (parts.length > 0) {
    units.push(Buffer.concat(parts));
  }
  assert.equal(units.length, 80);
  if (markers === true) {
    markerVideo.set(markerFrame, units);
  } else {
    frames = units;
  }
  return units;
}

let reorderedVideo;
let reorderedMarkerVideo = new Map();
function bFrameVideo(markers = false, markerFrame = 60) {
  let cached = markers === true ? reorderedMarkerVideo.get(markerFrame) : reorderedVideo;
  if (cached !== undefined) {
    return cached;
  }
  // Tee one encoder run to payload bytes and packet PTS, so fixtures have real
  // reference/B/B dependencies and cannot accidentally assign decode time as PTS.
  let encoded = spawnSync(
    binary,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      markers === true
        ? 'color=c=black:size=160x90:rate=15,drawbox=color=white:t=fill:enable=gte(n\\,' + markerFrame + ')'
        : 'testsrc2=size=160x90:rate=15',
      '-frames:v',
      '90',
      '-map',
      '0:v:0',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-x264-params',
      'aud=1:repeat-headers=1:keyint=30:scenecut=0:bframes=2:b-adapt=0:b-pyramid=none',
      '-f',
      'tee',
      '[f=h264]pipe:1|[f=framecrc]pipe:3',
    ],
    { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], timeout: 10000, maxBuffer: 8 * 1024 * 1024 },
  );
  assert.equal(encoded.status, 0, encoded.stderr?.toString());
  let times = encoded.output[3]
    .toString()
    .split('\n')
    .filter((line) => /^0,/.test(line) === true)
    .map((line) => (Number(line.split(',')[2]) * 1000) / 15);
  let units = [];
  let parts = [];
  for (let nal of H264.getNALUnits(encoded.stdout)) {
    if (nal.type === 9 && parts.length > 0) {
      units.push(Buffer.concat(parts));
      parts = [];
    }
    parts.push(H264.NALUS.START_CODE, nal.data);
  }
  if (parts.length > 0) {
    units.push(Buffer.concat(parts));
  }
  assert.equal(units.length, 90);
  assert.equal(times.length, units.length);
  assert.equal(
    times.some((time, index) => index > 0 && time < times[index - 1]),
    true,
  );
  let result = { units, times };
  if (markers === true) {
    reorderedMarkerVideo.set(markerFrame, result);
  } else {
    reorderedVideo = result;
  }
  return result;
}

function aacFrames(markers = false, markerTime = 4) {
  let cached = markers === true ? markerAAC.get(markerTime) : aac;
  if (cached !== undefined) {
    return cached;
  }
  let encoded = spawnSync(
    binary,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      markers === true
        ? 'aevalsrc=0.125*sin(2*PI*440*t)*between(t\\,' + markerTime + '\\,' + (markerTime + 1) + '):s=48000'
        : 'sine=frequency=440:sample_rate=48000',
      '-frames:a',
      '280',
      '-c:a',
      'aac',
      '-b:a',
      '64k',
      '-ac',
      '1',
      '-f',
      'adts',
      'pipe:1',
    ],
    { timeout: 10000, maxBuffer: 2 * 1024 * 1024 },
  );
  assert.equal(encoded.status, 0, encoded.stderr?.toString());
  let packets = [];
  for (let offset = 0; offset < encoded.stdout.length;) {
    let data = encoded.stdout;
    let size = ((data[offset + 3] & 3) << 11) | (data[offset + 4] << 3) | (data[offset + 5] >> 5);
    assert.equal(size > 7 && offset + size <= data.length, true);
    packets.push(data.subarray(offset, offset + size));
    offset += size;
  }
  assert.equal(packets.length >= 280, true);
  // The AAC encoder can emit a priming packet in addition to the requested frames.
  packets = packets.slice(0, 280);
  if (markers === true) {
    markerAAC.set(markerTime, packets);
  } else {
    aac = packets;
  }
  return packets;
}

for (let sourceAudio of ['opus', 'aac']) {
  test(
    'HomeKit live AAC-ELD uses 480-sample RTP blocks and managed talkback from ' + sourceAudio + ' input',
    { skip: binary === undefined ? 'Set FFMPEG_TEST_BINARY for real media checks' : false, timeout: 15000 },
    async (context) => {
      let timestamps = [];
      let talkback = new PassThrough();
      let talkbackBytes = 0;
      talkback.on('data', (data) => {
        talkbackBytes += data.length;
      });
      let talkbackPort = await UDPPorts.allocate();
      context.after(() => UDPPorts.release(talkbackPort));
      let videoSink = dgram.createSocket('udp4');
      let audioSink = dgram.createSocket('udp4');
      for (let socket of [videoSink, audioSink]) {
        socket.bind(0, '127.0.0.1');
        await once(socket, 'listening');
        context.after(() => socket.close());
      }

      // SRTP leaves the RTP header readable. Inspect actual wire timestamps
      // without retaining payloads or needing HomeKit's decryption machinery.
      audioSink.on('message', (packet) => {
        if (packet.length >= 12 && packet[0] >> 6 === 2 && (packet[1] & 0x7f) === 110) {
          // Loop the encrypted audio back as a synthetic HomeKit microphone.
          audioSink.send(packet, talkbackPort, '127.0.0.1');
          // An encoded block can span packets at HomeKit's small audio MTU.
          let timestamp = packet.readUInt32BE(4);
          if (timestamp !== timestamps.at(-1)) {
            timestamps.push(timestamp);
          }
        }
      });

      let video = videoFrames();
      let encodedAAC = sourceAudio === 'aac' ? aacFrames() : undefined;
      let output = new RTPMuxer({
        audio: { codec: sourceAudio, sampleRate: 48000, channels: encodedAAC === undefined ? 2 : 1 },
        audioControl: true,
      });
      context.after(() => output.close());
      if (encodedAAC !== undefined) {
        output.configureAudio(encodedAAC[0]);
      }
      await output.prepare();
      let manager = new FFmpeg(binary);
      let [handle, returnAudio] = manager.startLive({
        id: 'homekit-audio-test',
        input: output.input,
        ports: { ...output.ports, talkback: talkbackPort },
        talkback,
        talkbackCodec: sourceAudio === 'aac' ? 'speex' : 'opus',
        sourceAudio,
        video: { payloadType: 99, mtu: 1378 },
        audio: { codec: 'aac-eld', sampleRate: 16000, bitRate: 24, channels: 1, payloadType: 110, packetTime: 20 },
        target: {
          address: '127.0.0.1',
          videoPort: videoSink.address().port,
          audioPort: audioSink.address().port,
          videoSSRC: 1,
          audioSSRC: 2,
          videoSuite: 'AES_CM_128_HMAC_SHA1_80',
          audioSuite: 'AES_CM_128_HMAC_SHA1_80',
          videoSRTP: Buffer.alloc(30, 1),
          audioSRTP: Buffer.alloc(30, 2),
        },
      });
      context.after(async () => {
        handle.stop('SIGKILL');
        returnAudio.stop('SIGKILL');
        await handle.finished;
        await returnAudio.finished;
      });
      let stopped = false;
      let finished = handle.finished.then((result) => {
        stopped = true;
        return result;
      });
      let deadline = performance.now() + 5000;
      while (output.blocked('video') === true && stopped !== true && performance.now() < deadline) {
        await delay(5);
      }
      assert.equal(output.blocked('video'), false, 'FFmpeg never completed PLAY');

      let events = video.map((data, index) => ({ type: 'video', data, timestamp: index * 75 }));
      for (let index = 0; index < (encodedAAC?.length ?? 300); index++) {
        events.push({
          type: 'audio',
          data: encodedAAC?.[index] ?? opusSilence,
          timestamp: index * (encodedAAC === undefined ? 20 : 1024 / 48),
        });
      }
      events.sort((left, right) => left.timestamp - right.timestamp);
      let started = performance.now();
      for (let event of events) {
        let due = started + event.timestamp / 4;
        if (due > performance.now()) {
          await delay(Math.max(1, due - performance.now()));
        }
        assert.equal(stopped, false, 'FFmpeg exited before source completion');
        if (event.type === 'video') {
          output.writeVideo(event.data, event.timestamp);
        } else {
          output.writeAudio(event.data, event.timestamp);
        }
        output.tick();
      }
      await output.close();
      let result = await finished;
      await delay(50);
      assert.equal(result.code, 0, handle.diagnosticLines.join('\n'));
      assert.equal(timestamps.length > 100, true, 'Too few live audio packets to verify the clock');
      let intervals = new Set(timestamps.slice(1).map((timestamp, index) => (timestamp - timestamps[index]) >>> 0));
      assert.deepEqual([...intervals], [480]);
      deadline = performance.now() + 3000;
      while (talkbackBytes === 0 && returnAudio.active === true && performance.now() < deadline) {
        await delay(10);
      }
      assert.equal(talkbackBytes > 0, true, returnAudio.diagnosticLines.join('\n'));
      assert.equal(returnAudio.active, true, 'Idle talkback must keep waiting for microphone audio');
      await returnAudio.stop('SIGKILL');
      assert.equal(talkback.destroyed, false);
      assert.equal(talkback.writableEnded, false);
    },
  );
}

for (let [rate, codec, audioCodec, audioOffset = 40, lateTrack, reordered = false, audioGap = false, commonOffset = 0] of [
  [4, 'hksv', 'aac', 1.322021484375, undefined, false, false, 4436.01123046875],
  [4, 'hksv', 'aac', 40, undefined, false, 'repeated'],
  [1, 'hksv', 'aac', 40, undefined, false, 'repeated'],
  [4, 'hksv', 'aac', 40, undefined, false, true],
  [4, 'hksv', 'opus', 40, undefined, false, true],
  [4, 'rawvideo', 'aac', 40, undefined, true],
  [4, 'copy', 'aac', 40, undefined, true],
  [4, 'hksv', 'aac', 40, undefined, true],
  [4, 'rawvideo', 'opus'],
  [1, 'rawvideo', 'opus'],
  [4, 'copy', 'opus'],
  [1, 'copy', 'aac'],
  [4, 'copy', 'aac'],
  [4, 'hksv', 'opus'],
  [4, 'hksv', 'aac'],
  [4, 'hksv', 'aac', 2336],
  [4, 'copy', 'opus', -40, 'audio'],
  [4, 'copy', 'opus', 40, 'video'],
  [4, 'hksv', 'opus', -40, 'audio'],
  [4, 'hksv', 'opus', 40, 'video'],
]) {
  test(
    (codec === 'hksv'
      ? 'FFmpeg ' + audioCodec + ' RTP input produces decodable CFR H264/AAC fragmented MP4 at delivery rate ' + rate
      : 'FFmpeg ' +
        codec +
        '/' +
        audioCodec +
        ' preserves ' +
        (reordered === true ? 'reordered' : 'VFR') +
        ' A/V with a ' +
        audioOffset +
        ' ms source offset at delivery rate ' +
        rate) +
      (reordered === true ? ' with B-frames in decode order' : '') +
      (lateTrack === undefined ? '' : ' with late first ' + lateTrack) +
      (audioOffset > 1000 ? ' with source audio offset ' + audioOffset + ' ms' : '') +
      (audioGap === true ? ' with a one-second source audio gap' : '') +
      (audioGap === 'repeated' ? ' with repeated short source audio gaps and a timed tone' : '') +
      (commonOffset > 0 ? ' with a ' + commonOffset + ' ms shared startup offset' : ''),
    { skip: binary === undefined ? 'Set FFMPEG_TEST_BINARY for real media checks' : false, timeout: 20000 },
    async (context) => {
      const video = reordered === true ? bFrameVideo().units : videoFrames(commonOffset > 0);
      let encodedAAC = audioCodec === 'aac' ? aacFrames(audioGap === 'repeated' || commonOffset > 0) : undefined;
      const output = new RTPMuxer({ audio: { codec: audioCodec, sampleRate: 48000, channels: encodedAAC === undefined ? 2 : 1 } });
      if (encodedAAC !== undefined) {
        output.configureAudio(encodedAAC[0]);
      }
      await output.prepare();
      if (commonOffset > 0) {
        // Match an epoch established from retained media before the decoder-safe
        // starting IDR. Both tracks retain the time skipped during keyframe recovery.
        output.setSourceEpoch(0);
      }
      context.after(() => output.close());
      let manager = codec === 'hksv' ? new FFmpeg(binary) : undefined;
      let managed = manager?.startRecording({
        id: 'media-test',
        input: output.input,
        sourceAudio: audioCodec,
        video: { profile: 'baseline', level: '3.1', fps: 30, iFrameInterval: 4000, bitRate: 200 },
      });
      const child =
        managed === undefined
          ? spawn(binary, [
              '-hide_banner',
              '-loglevel',
              'warning',
              '-fflags',
              audioCodec === 'aac' ? '+genpts' : '+genpts+nofillin',
              '-flags',
              'low_delay',
              '-copyts',
              '-rtsp_transport',
              'tcp',
              '-analyzeduration',
              '500000',
              '-i',
              output.input.url,
              '-map',
              '0:v:0',
              '-map',
              '0:a:0',
              '-fps_mode:v',
              'passthrough',
              '-c:v',
              codec,
              '-enc_time_base:v',
              '1:90000',
              '-c:a',
              'pcm_s16le',
              '-f',
              'framecrc',
              'pipe:1',
            ])
          : { stdout: managed.stdout, kill: () => managed.stop('SIGKILL') };
      context.after(() => child.kill('SIGKILL'));
      let stdout = '';
      let mp4 = [];
      let stderr = '';
      let stopped = false;
      let audioOnset = undefined;
      let videoMarkerIndex = undefined;
      context.after(() => {
        if (stopped !== true) {
          context.diagnostic('FFmpeg did not finish. stderr=' + stderr.slice(-4000) + ' stdout=' + stdout.slice(-2000));
        }
      });
      let fragments =
        managed === undefined
          ? undefined
          : (async () => {
              for await (let fragment of manager.fragments(managed)) {
                mp4.push(fragment);
              }
            })();
      if (managed === undefined) {
        child.stdout.on('data', (data) => {
          stdout += data.toString();
        });
        child.stderr.on('data', (data) => {
          stderr += data.toString();
        });
      }
      const finished = (
        managed === undefined
          ? once(child, 'close').then(([code]) => code)
          : managed.finished.then((result) => {
              stderr = managed.diagnosticLines.join('\n');
              return result.code;
            })
      ).then((code) => {
        stopped = true;
        return code;
      });

      const deadline = performance.now() + 5000;
      while (output.blocked('video') === true && stopped !== true && performance.now() < deadline) {
        await delay(5);
      }
      assert.equal(output.blocked('video'), false, 'FFmpeg never completed PLAY: ' + stderr);

      const events = video.map((data, index) => ({
        type: 'video',
        data,
        timestamp:
          reordered === true
            ? bFrameVideo().times[index]
            : index < 20
              ? index * 100
              : index < 60
                ? 2000 + (index - 20) * 50
                : 4000 + (index - 60) * 100,
      }));
      if (encodedAAC !== undefined) {
        for (let index = 0; index < encodedAAC.length; index++) {
          events.push({ type: 'audio', data: encodedAAC[index], timestamp: audioOffset + (index * 1024 * 1000) / 48000 });
        }
      } else {
        for (let timestamp = audioOffset; timestamp < 6000; timestamp += 20) {
          events.push({ type: 'audio', data: opusSilence, timestamp });
        }
      }
      // Missing audio must leave its source-time hole in the saved recording;
      // concatenating the remaining samples makes all later sounds play early.
      if (audioGap !== false) {
        for (let index = events.length - 1; index >= 0; index--) {
          let event = events[index];
          if (
            event.type === 'audio' &&
            (audioGap === true
              ? event.timestamp >= 2000 && event.timestamp < 3000
              : event.timestamp >= 500 && event.timestamp < 3500 && event.timestamp % 500 < 40)
          ) {
            events.splice(index, 1);
          }
        }
      }
      // Delay one track's delivery without changing its source clock. Its first
      // frame then arrives after the other track established a later RTP epoch.
      let deliveryTime = {};
      for (let event of events) {
        event.timestamp += commonOffset;
        deliveryTime[event.type] = Math.max(deliveryTime[event.type] ?? -Infinity, event.timestamp);
        event.deliverAt = deliveryTime[event.type] + (event.type === lateTrack ? 120 : 0);
      }
      events.sort((left, right) => left.deliverAt - right.deliverAt || (left.type === right.type ? 0 : left.type === 'video' ? -1 : 1));
      const started = performance.now();
      for (const event of events) {
        const due = started + event.deliverAt / rate;
        if (due > performance.now()) {
          await delay(Math.max(1, due - performance.now()));
        }
        while (output.blocked(event.type) === true && stopped !== true && performance.now() - started < 12000) {
          await delay(5);
        }
        if (stopped === true) {
          break;
        }
        if (event.type === 'video') {
          output.writeVideo(event.data, event.timestamp);
        } else {
          output.writeAudio(event.data, event.timestamp);
        }
        output.tick();
      }
      while (output.queuedBytes() > 0) {
        await delay(5);
      }
      await delay(50);
      await output.close();
      const code = await finished;
      await fragments;
      assert.equal(code, 0, stderr);
      assert.doesNotMatch(stderr, /non.monoton|Invalid data|corrupt/i);

      if (codec === 'hksv') {
        let file = Buffer.concat(mp4);
        if (commonOffset > 0) {
          // A late shared start can produce repeated startup pictures. Measure
          // the actual black-to-white marker, rather than assuming the first
          // displayed frame marks the start of source motion.
          let marker = spawnSync(
            binary,
            [
              '-hide_banner',
              '-loglevel',
              'error',
              '-i',
              'pipe:0',
              '-map',
              '0:v:0',
              '-vf',
              'scale=1:1,format=gray',
              '-f',
              'rawvideo',
              'pipe:1',
            ],
            { input: file, timeout: 10000, maxBuffer: 1024 * 1024 },
          );
          assert.equal(marker.status, 0, marker.stderr?.toString());
          videoMarkerIndex = marker.stdout.findIndex((value) => value > 200);
          assert.ok(videoMarkerIndex >= 0, 'The video flash marker is missing');
        }
        let boxes = [];
        for (let offset = 0; offset < file.length;) {
          let size = file.readUInt32BE(offset);
          assert.equal(size >= 8 && offset + size <= file.length, true);
          boxes.push(file.toString('ascii', offset + 4, offset + 8));
          offset += size;
        }
        assert.equal(boxes.includes('moov'), true);
        assert.equal(boxes.filter((name) => name === 'moof').length >= 2, true);
        assert.equal(boxes.filter((name) => name === 'moof').length, boxes.filter((name) => name === 'mdat').length);
        let decoded = spawnSync(
          binary,
          ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-map', '0:v:0', '-map', '0:a:0', '-f', 'framecrc', 'pipe:1'],
          { input: file, timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
        );
        assert.equal(decoded.status, 0, decoded.stderr?.toString());
        stdout = decoded.stdout.toString();
        if (audioOffset > 1000 || (audioGap !== false && audioCodec === 'aac') || commonOffset > 0) {
          // Measure actual decoded tone placement, not just playable tracks or
          // equal start timestamps: fragmented MP4 can hide a lost audio offset.
          let pcm = spawnSync(
            binary,
            ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-map', '0:a:0', '-ar', '16000', '-ac', '1', '-f', 's16le', 'pipe:1'],
            { input: file, timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
          );
          assert.equal(pcm.status, 0, pcm.stderr?.toString());
          if (audioGap === true) {
            let peak = (start, end) => {
              let value = 0;
              for (let sample = Math.round(start * 16000); sample < Math.round(end * 16000); sample++) {
                value = Math.max(value, Math.abs(pcm.stdout.readInt16LE(sample * 2)));
              }
              return value;
            };
            assert.ok(peak(1.3, 1.6) > 1000, 'Tone before the source gap is missing');
            assert.ok(peak(2.3, 2.6) < 100, 'Source audio gap was collapsed instead of retained as silence');
            assert.ok(peak(3.3, 3.6) > 1000, 'Tone after the source gap is missing');
          }
          for (let offset = 0; offset + 2 <= pcm.stdout.length; offset += 2) {
            if (Math.abs(pcm.stdout.readInt16LE(offset)) > 1000) {
              audioOnset = offset / (2 * 16000);
              break;
            }
          }
        }
      }

      const bases = new Map();
      const decoded = [[], []];
      for (const line of stdout.split('\n')) {
        const base = /^#tb (\d+): (\d+)\/(\d+)$/.exec(line);
        if (base !== null) {
          bases.set(Number(base[1]), Number(base[2]) / Number(base[3]));
        } else if (/^\d+,/.test(line) === true) {
          const fields = line.split(',').map((field) => field.trim());
          decoded[Number(fields[0])].push(Number(fields[2]) * bases.get(Number(fields[0])));
        }
      }
      context.diagnostic(
        'Decoded video frames=' +
          decoded[0].length +
          ', video range=' +
          decoded[0][0] +
          '..' +
          decoded[0].at(-1) +
          ', audio range=' +
          decoded[1][0] +
          '..' +
          decoded[1].at(-1),
      );
      if (codec === 'hksv') {
        if (commonOffset > 0) {
          let markerOffset = audioOnset + decoded[1][0] - decoded[0][videoMarkerIndex];
          context.diagnostic('Decoded audio/flash marker offset=' + markerOffset + ' seconds');
          assert.ok(Math.abs(markerOffset - audioOffset / 1000) < 0.05, 'Startup offset separated the A/V markers: ' + markerOffset);
        }
        if (audioGap === 'repeated') {
          // Raw PCM has no timestamps. Relate its marker to the decoded audio
          // start before comparing against video when both tracks start late.
          let relativeOnset = audioOnset + decoded[1][0] - decoded[0][0];
          context.diagnostic('Tone offset from video start=' + relativeOnset);
          assert.ok(
            Math.abs(relativeOnset - 4 - audioOffset / 1000) < 0.05,
            'The four-second tone moved relative to video: ' + relativeOnset,
          );
        }
        if (reordered === true) {
          assert.equal(decoded[0].length, 180);
          assert.deepEqual(
            decoded[0].map((time) => Math.round(time * 90000)),
            Array.from({ length: 180 }, (_, index) => index * 3000),
          );
        }
        if (audioOffset > 1000) {
          assert.equal(typeof audioOnset, 'number');
          assert.ok(
            Math.abs(audioOnset - decoded[0][0] - audioOffset / 1000) < 0.15,
            'Lost source audio offset: tone=' + audioOnset + ' video=' + decoded[0][0],
          );
        }
        assert.equal(decoded[0].length >= 160, true);
        assert.equal(decoded[1].length > 70, true);
        assert.equal(decoded[0].at(-1) > 5.5 && decoded[1].at(-1) > 5.5, true);
        return;
      }
      assert.equal(decoded[0].length >= 70, true, 'Too few decoded video frames: ' + decoded[0].length);
      assert.equal(decoded[1].length > 200, true, 'Too few decoded audio packets: ' + decoded[1].length);
      // FFmpeg can synthesize zero PTS for the first copied H264 frame when
      // audio started first and video begins before the shared epoch. Check the
      // established offset from the next video frame as well as ongoing timing;
      // this receiver bootstrap behaviour is separate from rejecting the track.
      // The RTP H264 parser may leave the first copied picture's PTS unset
      // while learning B-frame delay. Decoded output must still start at zero;
      // validate all established copy timestamps against the encoder's PTS.
      let missingFirstPTS = reordered === true && codec === 'copy' && decoded[0][0] === -(2 ** 63) / 90000;
      let videoStart =
        missingFirstPTS === true
          ? decoded[0][1] - bFrameVideo().times[1] / 1000
          : lateTrack === 'video'
            ? decoded[0][1] - 0.1
            : decoded[0][0];
      assert.equal(
        Math.abs(decoded[1][0] - videoStart - audioOffset / 1000) < 0.003,
        true,
        'Lost A/V offset: video=' + videoStart + ' audio=' + decoded[1][0],
      );
      if (reordered === true) {
        assert.equal(decoded[0].length, 90, 'all B-frames and references must survive');
        if (codec === 'copy') {
          assert.deepEqual(
            decoded[0].slice(missingFirstPTS === true ? 1 : 0).map((time) => Math.round((time - videoStart) * 90000)),
            bFrameVideo()
              .times.slice(missingFirstPTS === true ? 1 : 0)
              .map((time) => Math.round(time * 90)),
          );
        } else {
          assert.deepEqual(
            decoded[0].map((time) => Math.round(time * 90000)),
            Array.from({ length: 90 }, (_, index) => index * 6000),
          );
        }
      }
      if (lateTrack !== undefined) {
        let sourceVideo = events.filter((event) => event.type === 'video');
        for (let index = 1; index < decoded[0].length; index++) {
          assert.equal(Math.abs(decoded[0][index] - videoStart - sourceVideo[index].timestamp / 1000) < 0.003, true);
        }
      }
      const deltas = decoded[0].slice(1).map((time, index) => time - decoded[0][index]);
      for (const duration of reordered === true ? [1 / 15] : [0.05, 0.1]) {
        assert.equal(
          deltas.some((delta) => Math.abs(delta - duration) < 0.002),
          true,
          'Lost VFR interval ' + duration,
        );
      }
    },
  );
}
