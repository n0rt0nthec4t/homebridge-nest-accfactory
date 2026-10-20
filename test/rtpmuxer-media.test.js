// Optional real FFmpeg receiver checks. Set FFMPEG_TEST_BINARY to a 7.1+ binary.
// Synthetic source media verifies timing and decoding, not camera/HomeKit hardware.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import H264 from '../src/plugins/camera/h264.js';
import RTPMuxer from '../src/plugins/camera/rtpmuxer.js';

const binary = process.env.FFMPEG_TEST_BINARY;
let frames;
let aac;
// A complete 20 ms Opus silence packet lets FFmpeg verify native decoding/timing
// without installing a separate JavaScript codec library to generate test media.
let opusSilence = Buffer.from([0xf8, 0xff, 0xfe]);

function videoFrames() {
  if (frames !== undefined) {
    return frames;
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
      'testsrc2=size=160x90:rate=30',
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
  frames = [];
  let parts = [];
  for (const nal of H264.getNALUnits(encoded.stdout)) {
    if (nal.type === 9 && parts.length > 0) {
      frames.push(Buffer.concat(parts));
      parts = [];
    }
    parts.push(H264.NALUS.START_CODE, nal.data);
  }
  if (parts.length > 0) {
    frames.push(Buffer.concat(parts));
  }
  assert.equal(frames.length, 80);
  return frames;
}

function aacFrames() {
  if (aac !== undefined) {
    return aac;
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
      'sine=frequency=440:sample_rate=48000',
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
  aac = [];
  for (let offset = 0; offset < encoded.stdout.length;) {
    let data = encoded.stdout;
    let size = ((data[offset + 3] & 3) << 11) | (data[offset + 4] << 3) | (data[offset + 5] >> 5);
    assert.equal(size > 7 && offset + size <= data.length, true);
    aac.push(data.subarray(offset, offset + size));
    offset += size;
  }
  assert.equal(aac.length >= 280, true);
  // The AAC encoder can emit a priming packet in addition to the requested frames.
  aac = aac.slice(0, 280);
  return aac;
}

function pcm(timestamp) {
  const data = Buffer.alloc(960 * 4);
  for (let sample = 0; sample < 960; sample += 1) {
    const value = Math.round(Math.sin(((timestamp * 48 + sample) * 2 * Math.PI * 440) / 48000) * 1000);
    data.writeInt16LE(value, sample * 4);
    data.writeInt16LE(value, sample * 4 + 2);
  }
  return data;
}

for (let [rate, codec, audioCodec, audioOffset = 40, lateTrack] of [
  [1, 'rawvideo', 'pcm-s16le'],
  [4, 'rawvideo', 'pcm-s16le'],
  [4, 'copy', 'pcm-s16le'],
  [1, 'rawvideo', 'opus'],
  [4, 'copy', 'opus'],
  [1, 'copy', 'aac'],
  [4, 'copy', 'aac'],
  [4, 'hksv', 'opus'],
  [4, 'hksv', 'aac'],
  [4, 'copy', 'opus', -40, 'audio'],
  [4, 'copy', 'opus', 40, 'video'],
  [4, 'hksv', 'opus', -40, 'audio'],
  [4, 'hksv', 'opus', 40, 'video'],
]) {
  test(
    (codec === 'hksv'
      ? 'FFmpeg ' + audioCodec + ' RTP input produces decodable CFR H264/AAC fragmented MP4 at delivery rate ' + rate
      : 'FFmpeg ' + codec + '/' + audioCodec + ' preserves VFR A/V with a ' + audioOffset + ' ms source offset at delivery rate ' + rate) +
      (lateTrack === undefined ? '' : ' with late first ' + lateTrack),
    { skip: binary === undefined ? 'Set FFMPEG_TEST_BINARY for real media checks' : false, timeout: 20000 },
    async (context) => {
      const video = videoFrames();
      let encodedAAC = audioCodec === 'aac' ? aacFrames() : undefined;
      const output = new RTPMuxer({ audio: { codec: audioCodec, sampleRate: 48000, channels: encodedAAC === undefined ? 2 : 1 } });
      if (encodedAAC !== undefined) {
        output.configureAudio(encodedAAC[0]);
      }
      await output.prepare();
      context.after(() => output.close());
      const child = spawn(binary, [
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
        '-i',
        output.input.url,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0',
        ...(codec === 'hksv'
          ? [
              '-c:v',
              'libx264',
              '-preset',
              'ultrafast',
              '-bf',
              '0',
              '-filter:v',
              'fps=fps=30,format=yuv420p',
              '-fps_mode',
              'cfr',
              '-g:v',
              '120',
              '-b:v',
              '400k',
              '-video_track_timescale',
              '90000',
              '-movflags',
              'frag_keyframe+empty_moov+delay_moov+default_base_moof',
              '-c:a',
              'libfdk_aac',
              '-profile:a',
              'aac_low',
              '-ar',
              '16000',
              '-b:a',
              '16k',
              '-ac',
              '1',
              '-filter:a',
              'aresample=async=1:first_pts=0',
              '-f',
              'mp4',
              'pipe:1',
            ]
          : ['-fps_mode:v', 'passthrough', '-c:v', codec, '-enc_time_base:v', '1:90000', '-c:a', 'pcm_s16le', '-f', 'framecrc', 'pipe:1']),
      ]);
      context.after(() => child.kill('SIGKILL'));
      let stdout = '';
      let mp4 = [];
      let stderr = '';
      let stopped = false;
      context.after(() => {
        if (stopped !== true) {
          context.diagnostic('FFmpeg did not finish. stderr=' + stderr.slice(-4000) + ' stdout=' + stdout.slice(-2000));
        }
      });
      child.stdout.on('data', (data) => {
        if (codec === 'hksv') {
          mp4.push(data);
        } else {
          stdout += data.toString();
        }
      });
      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      const finished = once(child, 'close').then(([code]) => {
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
        timestamp: index < 20 ? index * 100 : index < 60 ? 2000 + (index - 20) * 50 : 4000 + (index - 60) * 100,
      }));
      if (encodedAAC !== undefined) {
        for (let index = 0; index < encodedAAC.length; index++) {
          events.push({ type: 'audio', data: encodedAAC[index], timestamp: audioOffset + (index * 1024 * 1000) / 48000 });
        }
      } else {
        for (let timestamp = audioOffset; timestamp < 6000; timestamp += 20) {
          let data = audioCodec === 'opus' ? opusSilence : pcm(timestamp);
          events.push({ type: 'audio', data, timestamp });
        }
      }
      // Delay one track's delivery without changing its source clock. Its first
      // frame then arrives after the other track established a later RTP epoch.
      for (let event of events) {
        event.deliverAt = event.timestamp + (event.type === lateTrack ? 120 : 0);
      }
      events.sort((left, right) => left.deliverAt - right.deliverAt || (left.type === 'video' ? -1 : 1));
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
      assert.equal(code, 0, stderr);
      assert.doesNotMatch(stderr, /non.monoton|Invalid data|corrupt/i);

      if (codec === 'hksv') {
        let file = Buffer.concat(mp4);
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
      let videoStart = lateTrack === 'video' ? decoded[0][1] - 0.1 : decoded[0][0];
      assert.equal(
        Math.abs(decoded[1][0] - videoStart - audioOffset / 1000) < 0.003,
        true,
        'Lost A/V offset: video=' + videoStart + ' audio=' + decoded[1][0],
      );
      if (lateTrack !== undefined) {
        let sourceVideo = events.filter((event) => event.type === 'video');
        for (let index = 1; index < decoded[0].length; index++) {
          assert.equal(Math.abs(decoded[0][index] - videoStart - sourceVideo[index].timestamp / 1000) < 0.003, true);
        }
      }
      const deltas = decoded[0].slice(1).map((time, index) => time - decoded[0][index]);
      for (const duration of [0.05, 0.1]) {
        assert.equal(
          deltas.some((delta) => Math.abs(delta - duration) < 0.002),
          true,
          'Lost VFR interval ' + duration,
        );
      }
    },
  );
}
