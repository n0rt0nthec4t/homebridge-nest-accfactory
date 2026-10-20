// RTPMuxer output
// Part of homebridge-nest-accfactory
//
// RTP/RTCP delivery for complete media selected by Streamer.
//
// Responsibilities:
// - Packetize H264 access units and compressed Opus or AAC-LC audio
// - Support PCM s16le through L16 and NexusTalk ADTS AAC through AAC-hbr
// - Learn AAC configuration from source headers before publishing receiver SDP
// - Preserve source media intervals using per-track RTP clocks
// - Relate audio/video clocks through RTCP sender reports and a shared CNAME
// - Report per-track backpressure and retire packet delivery on close
//
// Streamer owns the shared buffer, output cursors, decoder bootstrap and pacing.
// This muxer has no media timeline, output registry, scheduler or hidden queue.
// A loopback RTSP endpoint carries RTP/RTCP over TCP after the receiver's PLAY.
// Tests may inject a synchronous packet sink instead of opening that endpoint.
//
// Code version 2026.10.20
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import net from 'node:net';

// Define our modules
import H264 from './h264.js';

// Define constants
const MAX_CONTROL_BYTES = 128 * 1024;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const MAX_ACCESS_UNIT_BYTES = 4 * 1024 * 1024;
const MAX_AAC_FRAMES_PER_UNIT = 256;
const AAC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];

// RTPMuxer object
export default class RTPMuxer {
  #output = undefined;
  #unixNow = undefined;
  #blocked = new Set(); // Tracks whose sink accepted data but needs to drain
  #failure = undefined;
  #server = undefined;
  #socket = undefined;
  #prepared = undefined;
  #closing = undefined;
  #playing = false;
  #adtsAudio = false;
  #audioPending = false;
  #descriptionCSeq = undefined;
  #url = undefined;
  #session = randomBytes(12).toString('hex');
  #channels = new Map();
  #control = Buffer.alloc(0);

  constructor({ audio, includeAudio = true, writePacket, maxPacketBytes = 1200, unixNow = () => Date.now() } = {}) {
    if ((writePacket !== undefined && typeof writePacket !== 'function') || typeof unixNow !== 'function') {
      throw new TypeError('A packet sink and wallclock are required');
    }
    if (Number.isInteger(maxPacketBytes) !== true || maxPacketBytes < 20 || maxPacketBytes > 65507) {
      throw new RangeError('Invalid RTP packet size');
    }

    // Existing StreamTransport describes decoded PCM using codec and profile.
    // Accept that known format while leaving AAC configuration explicit.
    if (audio?.codec === 'pcm' && audio.profile === 's16le') {
      audio = { ...audio, codec: 'pcm-s16le' };
    }
    // Generic AAC metadata does not tell us the decoder configuration. Keep the
    // audio track pending until a source ADTS header supplies its clock and format.
    this.#adtsAudio = includeAudio === true && audio?.codec === 'aac';
    this.#audioPending = this.#adtsAudio === true;
    let format = this.#adtsAudio === true ? { codec: 'aac' } : this.#snapshotAudio(includeAudio === true ? audio : undefined);
    if (Buffer.isBuffer(format?.config) === true) {
      format.config = Buffer.from(format.config);
    }
    this.#unixNow = unixNow;
    this.#output = {
      audio: format,
      writePacket,
      payloadBytes: maxPacketBytes - 12,
      closed: false,
      tracks: new Map(),
      epochMs: undefined,
      playbackEpochUnixMs: undefined,
      lastReportUnixMs: undefined,
    };

    // Fresh sender identities belong to this output, rather than to the source RTP session.
    for (let [name, rate, payloadType] of [['video', 90000, 96], ...(format === undefined ? [] : [['audio', format.sampleRate, 97]])]) {
      let identity = randomBytes(10);
      this.#output.tracks.set(name, {
        name,
        rate,
        payloadType,
        ssrc: identity.readUInt32BE(0),
        origin: identity.readUInt32BE(4),
        sequence: identity.readUInt16BE(8),
        packets: 0,
        octets: 0,
        lastTimestamp: undefined,
      });
    }
    this.#output.cname = Buffer.from(randomBytes(12).toString('hex') + '@rtpmuxer');

    // The endpoint is bound during prepare; the descriptor remains stable for callers.
    let muxer = this;
    this.input = Object.freeze({
      type: 'rtp',
      get url() {
        return muxer.#url;
      },
    });
  }

  prepare() {
    if (this.#output.closed === true) {
      return Promise.reject(new Error('Output is closed'));
    }
    if (this.#output.writePacket !== undefined) {
      return Promise.resolve();
    }
    if (this.#prepared !== undefined) {
      return this.#prepared;
    }

    // Own the actual listening socket from allocation through close. No free-port
    // probe/rebind handoff is needed, and media remains blocked until PLAY.
    this.#server = net.createServer({ highWaterMark: 64 * 1024 }, (socket) => this.#accept(socket));
    this.#prepared = new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        this.#url = 'rtsp://127.0.0.1:' + this.#server.address().port + '/' + this.#session;
        resolve();
      });
    });
    this.#server.on('error', (error) => this.#fail(error));
    return this.#prepared;
  }

  #accept(socket) {
    // Each live output belongs to one FFmpeg receiver. A second connection must
    // not replace that receiver or inherit its negotiated channels and RTP clocks.
    if (this.#output.closed === true || this.#socket !== undefined) {
      socket.destroy();
      return;
    }
    this.#socket = socket;
    socket.setNoDelay(true);
    socket.on('data', (data) => {
      try {
        this.#receive(data);
      } catch (error) {
        this.#fail(error);
      }
    });
    // Both tracks share this TCP queue, so one drain releases their socket pressure.
    socket.on('drain', () => this.#blocked.clear());
    socket.on('error', (error) => this.#fail(error));
    socket.on('close', () => {
      if (this.#output.closed !== true) {
        this.#fail(Object.assign(new Error('FFmpeg RTP receiver disconnected'), { code: 'ERR_RTP_RECEIVER_CLOSED' }));
      }
    });
  }

  #receive(data) {
    if (this.#control.length + data.length > MAX_CONTROL_BYTES) {
      throw new Error('RTSP control buffer exceeded its limit');
    }
    // TCP can split a request across reads or combine several messages. Retain
    // only the unfinished suffix and process complete messages in wire order.
    this.#control = this.#control.length === 0 ? data : Buffer.concat([this.#control, data]);

    while (this.#control.length > 0) {
      if (this.#control[0] === 0x24) {
        // Consume bounded receiver RTCP feedback so it cannot block the TCP stream.
        // Retransmission is not needed for this ordered loopback TCP handoff.
        if (this.#control.length < 4) {
          return;
        }
        let length = this.#control.readUInt16BE(2);
        if (this.#control.length < 4 + length) {
          return;
        }
        this.#control = this.#control.subarray(4 + length);
        continue;
      }
      let end = this.#control.indexOf('\r\n\r\n');
      if (end === -1) {
        return;
      }
      let lines = this.#control.subarray(0, end).toString('utf8').split('\r\n');
      let request = /^([A-Z_]+) (\S+) RTSP\/1\.0$/.exec(lines.shift());
      if (request === null) {
        throw new Error('Malformed RTSP request');
      }
      let headers = new Map();
      for (let line of lines) {
        let colon = line.indexOf(':');
        if (colon < 1) {
          throw new Error('Malformed RTSP header');
        }
        headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
      }
      // A header terminator does not guarantee the optional body has arrived.
      // Consume the complete request before looking for the next RTSP message.
      let length = Number(headers.get('content-length') ?? 0);
      if (Number.isInteger(length) !== true || length < 0 || length > 32768) {
        throw new Error('Invalid RTSP content length');
      }
      if (this.#control.length < end + 4 + length) {
        return;
      }
      this.#control = this.#control.subarray(end + 4 + length);
      this.#request(request[1], request[2], headers);
    }
  }

  #reply(code, cseq, headers = [], body = '') {
    let status = {
      200: 'OK',
      400: 'Bad Request',
      404: 'Not Found',
      405: 'Method Not Allowed',
      454: 'Session Not Found',
      455: 'Method Not Valid in This State',
      461: 'Unsupported Transport',
    };
    // Content-Length counts UTF-8 bytes, while CSeq lets FFmpeg match this reply
    // to its request even when the AAC description was deferred.
    let response = [
      'RTSP/1.0 ' + code + ' ' + status[code],
      'CSeq: ' + cseq,
      'Server: Nest-RTP-Output',
      ...headers,
      'Content-Length: ' + Buffer.byteLength(body),
      '',
      body,
    ].join('\r\n');
    if (this.#socket.writableLength + Buffer.byteLength(response) > MAX_PENDING_BYTES) {
      throw new Error('RTSP response queue exceeded its limit');
    }
    this.#socket.write(response);
  }

  #request(method, target, headers) {
    let cseq = headers.get('cseq');
    if (/^\d{1,20}$/.test(cseq ?? '') !== true) {
      throw new Error('RTSP request has no valid sequence');
    }
    // Restrict requests to this output's resource and session. Track selection
    // happens during SETUP; this endpoint never routes another output's media.
    if (
      target !== '*' &&
      target !== this.#url &&
      target !== this.#url + '/' &&
      target !== this.#url + '/trackID=0' &&
      target !== this.#url + '/trackID=1'
    ) {
      this.#reply(404, cseq);
      return;
    }
    if (headers.has('session') === true && headers.get('session').split(';')[0] !== this.#session) {
      this.#reply(454, cseq);
      return;
    }
    if (method === 'OPTIONS') {
      this.#reply(200, cseq, ['Public: OPTIONS, DESCRIBE, SETUP, PLAY, GET_PARAMETER, TEARDOWN']);
    } else if (method === 'DESCRIBE') {
      if (this.#audioPending === true) {
        // NexusTalk's first ADTS frame supplies the actual profile/rate/channels.
        // Retain only one request while Streamer continues receiving source media.
        if (this.#descriptionCSeq !== undefined) {
          this.#reply(455, cseq);
        } else {
          this.#descriptionCSeq = cseq;
        }
        return;
      }
      this.#reply(200, cseq, ['Content-Type: application/sdp', 'Content-Base: ' + this.#url + '/'], this.#sdp());
    } else if (method === 'SETUP') {
      if (this.#audioPending === true) {
        this.#reply(455, cseq);
        return;
      }
      let transport = headers.get('transport') ?? '';
      let channels = /(?:^|;)interleaved=(\d+)-(\d+)(?:;|$)/i.exec(transport);
      let name = target === this.#url + '/trackID=0' ? 'video' : target === this.#url + '/trackID=1' ? 'audio' : undefined;
      if (
        /^RTP\/AVP\/TCP(?:;|$)/i.test(transport) !== true ||
        channels === null ||
        name === undefined ||
        this.#output.tracks.has(name) !== true ||
        this.#playing === true
      ) {
        this.#reply(461, cseq);
        return;
      }
      // Interleaved channel ids are single bytes: one for RTP, one for RTCP.
      // Keep the pairs disjoint so audio cannot be mistaken for video or feedback.
      let pair = [Number(channels[1]), Number(channels[2])];
      if (
        pair.some((channel) => channel > 255) === true ||
        pair[0] === pair[1] ||
        [...this.#channels.entries()].some(
          ([track, allocated]) => track !== name && allocated.some((channel) => pair.includes(channel)),
        ) === true
      ) {
        this.#reply(461, cseq);
        return;
      }
      this.#channels.set(name, pair);
      this.#reply(200, cseq, ['Session: ' + this.#session, 'Transport: RTP/AVP/TCP;unicast;interleaved=' + pair.join('-')]);
    } else if (method === 'PLAY') {
      if (this.#audioPending === true || this.#channels.size !== this.#output.tracks.size) {
        this.#reply(455, cseq);
        return;
      }
      let info = [...this.#output.tracks.values()]
        .map(
          (track) =>
            'url=' + this.#url + '/trackID=' + (track.name === 'video' ? 0 : 1) + ';seq=' + track.sequence + ';rtptime=' + track.origin,
        )
        .join(',');
      // TCP preserves response/media ordering. PLAY is the receiver readiness
      // boundary; process spawn alone must never release buffered startup media.
      this.#reply(200, cseq, ['Session: ' + this.#session, 'Range: npt=0.000-', 'RTP-Info: ' + info]);
      this.#playing = true;
    } else if (method === 'GET_PARAMETER') {
      this.#reply(200, cseq, ['Session: ' + this.#session]);
    } else if (method === 'TEARDOWN') {
      this.#reply(200, cseq, ['Session: ' + this.#session]);
      this.#playing = false;
      this.#socket.end();
    } else {
      this.#reply(405, cseq);
    }
  }

  #sdp() {
    // SDP payload types must match the RTP headers below. H264 parameter sets
    // travel in-band with Streamer's decoder-safe bootstrap rather than in SDP.
    let lines = [
      'v=0',
      'o=- 0 0 IN IP4 127.0.0.1',
      's=Nest camera output',
      'c=IN IP4 127.0.0.1',
      't=0 0',
      'a=control:*',
      'm=video 0 RTP/AVP 96',
      'a=rtpmap:96 H264/90000',
      'a=fmtp:96 packetization-mode=1',
      'a=control:trackID=0',
    ];
    let audio = this.#output.audio;
    if (audio !== undefined) {
      lines.push('m=audio 0 RTP/AVP 97');
      if (audio.codec === 'pcm-s16le') {
        lines.push('a=rtpmap:97 L16/' + audio.sampleRate + '/' + audio.channels);
      } else if (audio.codec === 'opus') {
        // Opus SDP always advertises two channels; sprop-stereo describes the source.
        lines.push('a=rtpmap:97 opus/48000/2', 'a=fmtp:97 sprop-stereo=' + (audio.channels === 2 ? 1 : 0));
      } else {
        lines.push(
          'a=rtpmap:97 MPEG4-GENERIC/' + audio.sampleRate + '/' + audio.channels,
          'a=fmtp:97 streamtype=5;mode=AAC-hbr;config=' +
            audio.config.toString('hex') +
            ';SizeLength=13;IndexLength=3;IndexDeltaLength=3;constantDuration=1024',
        );
      }
      lines.push('a=control:trackID=1');
    }
    return lines.join('\r\n') + '\r\n';
  }

  #fail(error) {
    // Preserve the first failure for Streamer to inspect. Closing is local to this
    // muxer, so a failed viewer cannot shut down another live or HKSV output.
    this.#failure ??= error;
    this.close().catch((closeError) => {
      this.#failure ??= closeError;
    });
  }

  get needsAudioConfig() {
    return this.#audioPending === true && this.#output.closed !== true;
  }

  configureAudio(data) {
    if (this.needsAudioConfig !== true) {
      return;
    }
    try {
      // Turn the source's ADTS profile/frequency/channel fields into the two-byte
      // AudioSpecificConfig FFmpeg expects in MPEG4-GENERIC SDP. No media is sent here.
      let header = this.#readADTS(data, 0);
      let config = Buffer.alloc(2);
      config.writeUInt16BE(header.configWord);
      this.#output.audio = this.#snapshotAudio({ codec: 'aac-lc', sampleRate: header.sampleRate, channels: header.channels, config });
      this.#output.tracks.get('audio').rate = header.sampleRate;
      this.#audioPending = false;
      // Complete the waiting DESCRIBE only after both SDP and the audio clock agree.
      if (this.#descriptionCSeq !== undefined) {
        let cseq = this.#descriptionCSeq;
        this.#descriptionCSeq = undefined;
        this.#reply(200, cseq, ['Content-Type: application/sdp', 'Content-Base: ' + this.#url + '/'], this.#sdp());
      }
    } catch (error) {
      // A malformed or unsupported source format belongs to this output only.
      this.#fail(error);
    }
  }

  #readADTS(data, offset) {
    if (Buffer.isBuffer(data) !== true || data.length - offset < 7 || data[offset] !== 0xff || (data[offset + 1] & 0xf6) !== 0xf0) {
      throw new TypeError('Expected complete ADTS-framed AAC audio from NexusTalk');
    }
    // ADTS stores the frame length across three bytes, including its header.
    // protection_absent selects a seven-byte header or nine bytes with CRC; the
    // CRC is stripped with the header, but its contents are not verified here.
    let frequency = (data[offset + 2] >> 2) & 15;
    let profile = (data[offset + 2] >> 6) + 1;
    let channels = ((data[offset + 2] & 1) << 2) | (data[offset + 3] >> 6);
    let headerBytes = (data[offset + 1] & 1) === 1 ? 7 : 9;
    let frameBytes = ((data[offset + 3] & 3) << 11) | (data[offset + 4] << 3) | (data[offset + 5] >> 5);
    // The packet clock assumes one 1024-sample AAC-LC block. Reject formats that
    // need extra configuration or different timing instead of publishing guessed SDP.
    if (profile !== 2 || AAC_SAMPLE_RATES[frequency] === undefined || [1, 2].includes(channels) !== true || (data[offset + 6] & 3) !== 0) {
      throw new TypeError('ADTS input requires mono/stereo AAC-LC with one 1024-sample block per frame');
    }
    if (frameBytes <= headerBytes || offset + frameBytes > data.length) {
      throw new TypeError('Truncated ADTS AAC frame');
    }
    return {
      sampleRate: AAC_SAMPLE_RATES[frequency],
      channels,
      configWord: (profile << 11) | (frequency << 7) | (channels << 3),
      headerBytes,
      frameBytes,
    };
  }

  get closed() {
    return this.#output.closed === true;
  }

  get error() {
    return this.#failure;
  }

  get hasAudio() {
    return this.#output.audio !== undefined;
  }

  blocked(type) {
    // Readiness and drain are separate gates. Neither FFmpeg spawning nor the
    // listener binding permits delivery before configuration and PLAY finish.
    return (
      this.#audioPending === true ||
      this.#output.closed === true ||
      this.#blocked.has(type) === true ||
      (this.#output.writePacket === undefined && (this.#playing !== true || this.#socket?.writableNeedDrain === true))
    );
  }

  queuedBytes() {
    // TCP owns the only pending-delivery queue; there is no second packet queue.
    return this.#socket?.writableLength ?? 0;
  }

  resume(type) {
    // The injected sink owns drain notification. Streamer resumes on its next tick.
    this.#blocked.delete(type);
  }

  setSourceEpoch(timestamp) {
    // Streamer may prioritize due audio ahead of an older expensive keyframe.
    // Anchor both tracks to its earliest retained candidate before either writes.
    if (this.#output.epochMs === undefined && Number.isFinite(timestamp) === true) {
      this.#output.epochMs = timestamp;
    }
  }

  #start(timestamp) {
    if (this.#output.closed === true) {
      throw new Error('Output is closed');
    }
    if (this.#audioPending === true) {
      throw new Error('AAC configuration is not ready');
    }
    if (Number.isFinite(timestamp) !== true) {
      throw new TypeError('Expected source media time');
    }
    if (this.#output.writePacket === undefined && this.#playing !== true) {
      throw new Error('RTP receiver has not completed PLAY');
    }
    if (this.#output.epochMs === undefined) {
      this.#output.epochMs = timestamp;
    }
    if (this.#output.playbackEpochUnixMs === undefined) {
      this.#output.playbackEpochUnixMs = this.#unixNow();
      // Establish both clock origins before either track delivers media. Otherwise
      // a receiver can independently zero the first audio packet and lose its offset.
      if (this.#output.writePacket === undefined) {
        this.#report(this.#output, this.#output.playbackEpochUnixMs);
      }
    }
  }

  writeVideo(data, timestamp, { sps, pps } = {}) {
    this.#start(timestamp);
    if (this.blocked('video') === true) {
      throw new Error('Video output must drain before the next frame');
    }

    let nalUnits = H264.getNALUnits(data).map((nal) => nal.data);
    if (nalUnits.length === 0 || nalUnits.some((nal) => (nal[0] & 0x80) !== 0 || (nal[0] & 31) < 1 || (nal[0] & 31) > 23)) {
      throw new TypeError('Expected complete H264 access units');
    }

    // Streamer selects bootstrap data; keep those NALs in the same RTP timestamp
    // group as the keyframe rather than emitting separate configuration frames.
    if (pps !== undefined) {
      nalUnits.unshift(pps);
    }
    if (sps !== undefined) {
      nalUnits.unshift(sps);
    }
    let encodedBytes = 0;
    let payloadBytes = 0;
    for (let nal of nalUnits) {
      payloadBytes += nal.length;
      let packets = nal.length <= this.#output.payloadBytes ? 1 : Math.ceil((nal.length - 1) / (this.#output.payloadBytes - 2));
      encodedBytes += nal.length + packets * 18;
    }
    this.#reserve(payloadBytes, encodedBytes);
    this.#writeVideo(this.#output, { timestamp, nalUnits });
    return this.blocked('video') !== true;
  }

  writeAudio(data, timestamp) {
    this.#start(timestamp);
    if (this.blocked('audio') === true) {
      throw new Error('Audio output must drain before the next frame');
    }
    if (this.#adtsAudio === true) {
      try {
        // One Nexus payload may contain several complete ADTS frames. Validate the
        // entire unit before emitting media, then remove headers without copying.
        let frames = [];
        let encodedBytes = 0;
        let payloadBytes = 0;
        if (Buffer.isBuffer(data) !== true || data.length === 0 || data.length > MAX_ACCESS_UNIT_BYTES) {
          throw new TypeError('Invalid ADTS audio delivery unit');
        }
        for (let offset = 0; offset < data.length;) {
          if (frames.length >= MAX_AAC_FRAMES_PER_UNIT) {
            throw new RangeError('Too many ADTS frames in one delivery unit');
          }
          let header = this.#readADTS(data, offset);
          if (header.configWord !== this.#output.audio.config.readUInt16BE(0)) {
            throw new Error('ADTS audio format changed during an RTP session');
          }
          let payload = data.subarray(offset + header.headerBytes, offset + header.frameBytes);
          if (payload.length + 4 > this.#output.payloadBytes) {
            throw new RangeError('AAC AU requires fragmentation');
          }
          frames.push(payload);
          payloadBytes += payload.length;
          encodedBytes += payload.length + 20;
          offset += header.frameBytes;
        }
        this.#reserve(payloadBytes, encodedBytes);
        // The source timestamp belongs to the first AU. Subsequent ADTS frames
        // advance by decoded sample count, regardless of this batch's delivery time.
        for (let index = 0; index < frames.length; index++) {
          this.#writeAudio(this.#output, {
            timestamp: timestamp + (index * 1024 * 1000) / this.#output.audio.sampleRate,
            data: frames[index],
          });
        }
      } catch (error) {
        // A framing/configuration failure retires this receiver, preserving other
        // live viewers and the independent HKSV pipe consumer.
        this.#fail(error);
        throw error;
      }
    } else {
      if (Buffer.isBuffer(data) === true) {
        this.#reserve(data.length, data.length + Math.ceil(data.length / (this.#output.payloadBytes - 4)) * 20);
      }
      this.#writeAudio(this.#output, { timestamp, data });
    }
    return this.blocked('audio') !== true;
  }

  tick(unixMs = this.#unixNow()) {
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
    if (this.#output.closed === true || this.#output.playbackEpochUnixMs === undefined) {
      return;
    }
    if (this.#output.writePacket === undefined && (this.#playing !== true || this.#socket.writableNeedDrain === true)) {
      return;
    }

    // Streamer's scheduler drives reports; packetization never adds another timer.
    if (this.#output.lastReportUnixMs === undefined || unixMs - this.#output.lastReportUnixMs >= 1000) {
      this.#report(this.#output, unixMs);
    }
  }

  #reserve(payloadBytes, encodedBytes) {
    // Reserve capacity for the complete access unit before emitting any prefix or
    // fragment. A false TCP write can then safely finish this bounded unit.
    if (payloadBytes > MAX_ACCESS_UNIT_BYTES || encodedBytes + this.queuedBytes() > MAX_PENDING_BYTES) {
      throw new Error('RTP access unit exceeds the pending-delivery limit');
    }
  }

  #snapshotAudio(audio) {
    if (
      audio !== undefined &&
      (['opus', 'pcm-s16le', 'aac-lc'].includes(audio?.codec) !== true ||
        Number.isInteger(audio.sampleRate) !== true ||
        audio.sampleRate < 8000 ||
        audio.sampleRate > 96000 ||
        [1, 2].includes(audio.channels) !== true)
    ) {
      throw new TypeError('Expected supported mono/stereo audio format');
    }

    // Opus RTP always uses a 48 kHz clock, independent of its encoded audio bandwidth.
    if (audio?.codec === 'opus' && audio.sampleRate !== 48000) {
      throw new TypeError('Opus RTP clock must be 48000 Hz');
    }

    // Snapshot format metadata so caller mutation cannot change an active clock.
    audio = audio === undefined ? undefined : { ...audio };

    // Support two-byte AAC-LC configuration with 1024 samples per access unit.
    // Check the supplied AudioSpecificConfig against the declared track format.
    if (audio?.codec === 'aac-lc') {
      let config = audio.config;
      if (
        Buffer.isBuffer(config) !== true ||
        config.length !== 2 ||
        config[0] >> 3 !== 2 ||
        AAC_SAMPLE_RATES[((config[0] & 7) << 1) | (config[1] >> 7)] !== audio.sampleRate ||
        ((config[1] >> 3) & 15) !== audio.channels ||
        (config[1] & 7) !== 0
      ) {
        throw new TypeError('AAC-LC AudioSpecificConfig must match audio format');
      }
    }

    return audio;
  }

  #timestampFor(output, track, sourceMs) {
    // Preserve source intervals independently of when retained frames are delivered.
    return (track.origin + Math.round(((sourceMs - output.epochMs) * track.rate) / 1000)) >>> 0;
  }

  #validateTime(output, track, timestamp) {
    // Check progression per track, not across tracks: audio can be delivered
    // before an older video frame, but one track must never reuse or reverse time.
    if (output.closed === true) {
      throw new Error('Output is closed');
    }
    if (
      Number.isFinite(timestamp) !== true ||
      timestamp < output.epochMs ||
      (track.lastTimestamp !== undefined && timestamp <= track.lastTimestamp)
    ) {
      throw new RangeError('Expected increasing source presentation times');
    }
  }

  #send(output, data, track, kind) {
    if (output.closed === true) {
      throw new Error('Output is closed');
    }
    try {
      if (output.writePacket !== undefined) {
        if (output.writePacket(data, { track: track.name, kind }) === false) {
          this.#blocked.add(track.name);
        }
      } else {
        let pair = this.#channels.get(track.name);
        if (this.#playing !== true || pair === undefined) {
          throw new Error('RTP receiver has not completed PLAY');
        }
        if (data.length + 4 + this.queuedBytes() > MAX_PENDING_BYTES) {
          throw new Error('RTP pending-delivery limit exceeded');
        }
        // RTSP interleaving wraps each RTP/RTCP packet in '$', channel and length.
        // A false write means accepted but waiting for drain; do not retry this packet.
        let framed = Buffer.allocUnsafe(4 + data.length);
        framed[0] = 0x24;
        framed[1] = pair[kind === 'rtp' ? 0 : 1];
        framed.writeUInt16BE(data.length, 2);
        data.copy(framed, 4);
        if (this.#socket.write(framed) === false) {
          this.#blocked.add(track.name);
        }
      }
    } catch (error) {
      // A failed sink may already have received part of this access unit.
      this.#fail(error);
      throw error;
    }
  }

  #packet(output, track, payload, timestamp, marker) {
    // Fixed RTP v2 header, without CSRCs, extensions or padding.
    let data = Buffer.allocUnsafe(12 + payload.length);
    data[0] = 0x80;
    data[1] = track.payloadType | (marker === true ? 0x80 : 0);
    data.writeUInt16BE(track.sequence, 2);
    track.sequence = (track.sequence + 1) & 0xffff;
    data.writeUInt32BE(timestamp, 4);
    data.writeUInt32BE(track.ssrc, 8);
    payload.copy(data, 12);
    this.#send(output, data, track, 'rtp');

    // Sender-report octets exclude the RTP header.
    track.packets = (track.packets + 1) >>> 0;
    track.octets = (track.octets + payload.length) >>> 0;
  }

  #writeVideo(output, { timestamp, nalUnits }) {
    // Input contains one complete access unit with Annex-B prefixes already removed.
    let track = output.tracks.get('video');
    this.#validateTime(output, track, timestamp);
    let rtpTimestamp = this.#timestampFor(output, track, timestamp);
    track.lastTimestamp = timestamp;
    for (let index = 0; index < nalUnits.length; index += 1) {
      let nal = nalUnits[index];
      let lastNAL = index === nalUnits.length - 1;
      if (nal.length <= output.payloadBytes) {
        this.#packet(output, track, nal, rtpTimestamp, lastNAL);
        continue;
      }

      // Fragment oversized NAL units using RFC 6184 FU-A headers.
      // Only the final packet of the complete access unit carries the marker bit.
      for (let offset = 1; offset < nal.length;) {
        let end = Math.min(nal.length, offset + output.payloadBytes - 2);
        let fragment = Buffer.allocUnsafe(2 + end - offset);
        // FU-A replaces the original NAL header with an indicator and a header
        // carrying its type plus start/end flags; the payload starts after that NAL byte.
        fragment[0] = (nal[0] & 0xe0) | 28;
        fragment[1] = (nal[0] & 0x1f) | (offset === 1 ? 0x80 : 0) | (end === nal.length ? 0x40 : 0);
        nal.copy(fragment, 2, offset, end);
        this.#packet(output, track, fragment, rtpTimestamp, lastNAL === true && end === nal.length);
        offset = end;
      }
    }
  }

  #writeAudio(output, { timestamp, data }) {
    // The timestamp describes the first audio sample on the shared source timeline.
    if (output.closed === true) {
      throw new Error('Output is closed');
    }

    let track = output.tracks.get('audio');
    if (track === undefined) {
      throw new Error('Audio was not configured');
    }

    this.#validateTime(output, track, timestamp);
    if (Buffer.isBuffer(data) !== true || data.length === 0) {
      throw new TypeError('Expected audio bytes');
    }

    let rtpTimestamp = this.#timestampFor(output, track, timestamp);

    if (output.audio.codec === 'pcm-s16le') {
      let sampleBytes = output.audio.channels * 2;
      if (data.length % sampleBytes !== 0) {
        throw new RangeError('PCM must contain whole sample frames');
      }

      let chunkBytes = Math.floor(output.payloadBytes / sampleBytes) * sampleBytes;
      track.lastTimestamp = timestamp;
      for (let offset = 0; offset < data.length; offset += chunkBytes) {
        // L16 uses network byte order. Copy each chunk before swapping bytes
        // so the shared retained PCM stays unchanged and channel groups stay intact.
        let payload = Buffer.from(data.subarray(offset, offset + chunkBytes));
        payload.swap16();
        this.#packet(output, track, payload, (rtpTimestamp + offset / sampleBytes) >>> 0, false);
      }
    } else if (output.audio.codec === 'opus') {
      // Preserve the compressed Opus payload in one output RTP packet.
      // RFC 7587 does not allow splitting it across multiple RTP packets.
      if (data.length > output.payloadBytes) {
        throw new RangeError('Opus packet exceeds output packet budget');
      }

      track.lastTimestamp = timestamp;
      this.#packet(output, track, data, rtpTimestamp, false);
    } else {
      // AAC-hbr carries one raw access unit with a 13-bit size and 3-bit index.
      // ADTS is removed at the delivery boundary; each packet carries one raw AU.
      // Fragmented AAC access units are not implemented here.
      if (data.length >= 2 && data[0] === 0xff && (data[1] & 0xf6) === 0xf0) {
        throw new TypeError('Remove ADTS framing before AAC packetization');
      }

      if (data.length > 8191 || data.length + 4 > output.payloadBytes) {
        throw new RangeError('AAC AU requires fragmentation');
      }

      let payload = Buffer.allocUnsafe(4 + data.length);
      // AU-headers-length is measured in bits. The following 16-bit AU header
      // stores the byte length in its upper 13 bits and a zero AU index below it.
      payload.writeUInt16BE(16, 0);
      payload.writeUInt16BE(data.length << 3, 2);
      data.copy(payload, 4);
      track.lastTimestamp = timestamp;
      this.#packet(output, track, payload, rtpTimestamp, true);
    }
  }

  #report(output, unixMs) {
    // Sender reports pair actual send time with the corresponding playback position.
    // The last packet timestamp may be ahead of that position during prebuffer replay.
    if (output.closed === true) {
      throw new Error('Output is closed');
    }

    if (
      Number.isFinite(unixMs) !== true ||
      unixMs < output.playbackEpochUnixMs ||
      (output.lastReportUnixMs !== undefined && unixMs < output.lastReportUnixMs)
    ) {
      throw new RangeError('Expected increasing report send time');
    }
    output.lastReportUnixMs = unixMs;
    // RTCP uses NTP's 1900 epoch and a 32-bit fractional second. Derive the
    // matching source position from elapsed playback time, not queued media time.
    let seconds = Math.floor(unixMs / 1000);
    let ntpSeconds = (seconds + 2208988800) >>> 0;
    let ntpFraction = Math.floor(((unixMs - seconds * 1000) / 1000) * 0x100000000) >>> 0;
    let sourceMs = output.epochMs + unixMs - output.playbackEpochUnixMs;

    for (let track of output.tracks.values()) {
      // Build a compound RTCP sender report followed by an SDES CNAME chunk.
      // Audio and video share the NTP reference and CNAME while keeping separate SSRCs.
      // RTCP lengths count 32-bit words excluding each packet's first word.
      // Zero-filled allocation supplies the SDES end marker and alignment padding.
      let sdesBytes = Math.ceil((4 + 4 + 2 + output.cname.length + 1) / 4) * 4;
      let compound = Buffer.alloc(28 + sdesBytes);
      compound[0] = 0x80;
      compound[1] = 200;
      compound.writeUInt16BE(6, 2);
      compound.writeUInt32BE(track.ssrc, 4);
      compound.writeUInt32BE(ntpSeconds, 8);
      compound.writeUInt32BE(ntpFraction, 12);
      compound.writeUInt32BE(this.#timestampFor(output, track, sourceMs), 16);
      compound.writeUInt32BE(track.packets, 20);
      compound.writeUInt32BE(track.octets, 24);
      compound[28] = 0x81;
      compound[29] = 202;
      compound.writeUInt16BE(sdesBytes / 4 - 1, 30);
      compound.writeUInt32BE(track.ssrc, 32);
      compound[36] = 1;
      compound[37] = output.cname.length;
      output.cname.copy(compound, 38);
      this.#send(output, compound, track, 'rtcp');
    }
  }

  close() {
    if (this.#closing !== undefined) {
      return this.#closing;
    }
    // Retire delivery synchronously, then await both bound listener and client.
    // Waiting for pending listen avoids a stop-before-listen socket leak.
    this.#output.closed = true;
    this.#playing = false;
    this.#blocked.clear();
    this.#socket?.destroy();
    this.#control = Buffer.alloc(0);
    this.#descriptionCSeq = undefined;
    this.#closing = (async () => {
      if (this.#server === undefined) {
        return;
      }
      // A failed listen still needs the close attempt below; its original error
      // remains available through error. Repeated closes share this same promise.
      await this.#prepared.catch(() => {});
      await new Promise((resolve, reject) => {
        this.#server.close((error) => {
          if (error !== undefined && error.code !== 'ERR_SERVER_NOT_RUNNING') {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    })();
    return this.#closing;
  }
}
