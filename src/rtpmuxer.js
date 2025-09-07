// rtpmuxer.js
// Unified RTP Muxer + Stream Engine with FFmpeg support
// Part of homebridge-nest-accfactory
//
// Code version 2025.07.04
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import dgram from 'dgram';
import { Writable } from 'stream';
import { Buffer } from 'node:buffer';
import { setInterval, clearInterval } from 'node:timers';

// Define constants
const LOG_LEVELS = {
  INFO: 'info',
  SUCCESS: 'success',
  WARN: 'warn',
  ERROR: 'error',
  DEBUG: 'debug',
};
const RTP_PACKET_HEADER_SIZE = 12;

export default class RTPMuxer {
  static RTP_PORT_START = 50000;
  static RTP_PORT_END = 51000;
  static SAMPLE_RATE_VIDEO = 90000;
  static SAMPLE_RATE_AUDIO = 48000;
  static PAYLOAD_TYPE_H264 = 96;
  static PAYLOAD_TYPE_OPUS = 111;

  static STREAM_TYPE = {
    BUFFER: 'buffer',
    LIVE: 'live',
    RECORD: 'record',
    TALK: 'talk',
  };

  log = undefined; // Logging function object

  #udpServer = undefined; // UDP server for RTP packets
  #port = undefined; // UDP port for RTP packets
  #outputSessions = new Map(); // Output sessions for RTP streams
  #buffer = []; // Buffer for RTP packets
  #bufferDuration = 5000;
  #bufferTimer = undefined; // Timer for buffer cleanup
  #ffmpeg = undefined; // FFmpeg instance for processing RTP streams

  constructor(options) {
    // Setup logger object if passed as option
    if (Object.values(LOG_LEVELS).every((fn) => typeof options?.log?.[fn] === 'function')) {
      this.log = options.log;
    }

    this.#ffmpeg = options.ffmpeg; // pass instance of FFmpeg from ffmpeg.js
  }

  async start() {
    this.#port = await this.#allocatePort();
    this.#udpServer = dgram.createSocket('udp4');
    this.#udpServer.on('message', (msg) => this.#handleRTP(msg));
    this.#udpServer.bind(this.#port);
    this.#startBufferLoop();
  }

  stop(uuid) {
    if (this.#udpServer) {
      this.#udpServer.close();
      this.#udpServer = undefined;
    }

    clearInterval(this.#bufferTimer);
    this.#outputSessions.clear();

    this.#ffmpeg?.killAllSessions?.(uuid);
  }

  getPort() {
    return this.#port;
  }

  getSDP(kind) {
    let sdp = '';
    if (kind === 'video') {
      sdp += 'm=video ' + this.#port + ' RTP/AVP ' + RTPMuxer.PAYLOAD_TYPE_H264 + '\r\n';
      sdp += 'a=rtpmap:' + RTPMuxer.PAYLOAD_TYPE_H264 + ' H264/' + RTPMuxer.SAMPLE_RATE_VIDEO + '\r\n';
    } else if (kind === 'audio') {
      sdp += 'm=audio ' + this.#port + ' RTP/AVP ' + RTPMuxer.PAYLOAD_TYPE_OPUS + '\r\n';
      sdp += 'a=rtpmap:' + RTPMuxer.PAYLOAD_TYPE_OPUS + ' opus/' + RTPMuxer.SAMPLE_RATE_AUDIO + '/2\r\n';
    }
    return sdp;
  }

  attachOutput(sessionID, writableStream, options = {}) {
    this.#outputSessions.set(sessionID, {
      stream: writableStream,
      kind: options.kind,
      isRecording: options.isRecording === true,
    });
  }

  detachOutput(sessionID) {
    this.#outputSessions.delete(sessionID);
  }

  getWritableStream(type) {
    return new Writable({
      write: (chunk, encoding, callback) => {
        if (type === RTPMuxer.STREAM_TYPE.BUFFER) {
          this.#buffer.push({ timestamp: Date.now(), packet: chunk });
        }
        for (let session of this.#outputSessions.values()) {
          if (session.kind === type || session.kind === undefined) {
            session.stream.write(chunk);
          }
        }
        callback();
      },
    });
  }

  getBufferedPackets(kind) {
    let now = Date.now();
    return this.#buffer.filter((p) => p.kind === kind && now - p.timestamp <= this.#bufferDuration).map((p) => p.packet);
  }

  startSession(uuid, sessionID, args, sessionType = 'live', errorCallback, pipeCount = 4) {
    return this.#ffmpeg?.createSession?.(uuid, sessionID, args, sessionType, errorCallback, pipeCount);
  }

  stopSession(uuid, sessionID, sessionType = 'live') {
    return this.#ffmpeg?.killSession?.(uuid, sessionID, sessionType);
  }

  processRTP(packet) {
    this.#handleRTP(packet);
  }

  #handleRTP(packet) {
    if (Buffer.isBuffer(packet) === false || packet.length < RTP_PACKET_HEADER_SIZE) {
      return;
    }

    let payloadType = packet[1] & 0x7f;
    let kind = payloadType === RTPMuxer.PAYLOAD_TYPE_H264 ? 'video' : payloadType === RTPMuxer.PAYLOAD_TYPE_OPUS ? 'audio' : undefined;
    if (kind === undefined) {
      return;
    }

    let copy = Buffer.from(packet);
    this.#buffer.push({ kind, timestamp: Date.now(), packet: copy });

    for (let session of this.#outputSessions.values()) {
      if (session.kind === kind || session.kind === undefined) {
        session.stream.write(copy);
      }
    }
  }

  #startBufferLoop() {
    this.#bufferTimer = setInterval(() => {
      let now = Date.now();
      this.#buffer = this.#buffer.filter((p) => now - p.timestamp <= this.#bufferDuration);
    }, 1000);
  }

  async #allocatePort() {
    for (let port = RTPMuxer.RTP_PORT_START; port <= RTPMuxer.RTP_PORT_END; port += 2) {
      try {
        await new Promise((resolve, reject) => {
          let socket = dgram.createSocket('udp4');
          socket.once('error', reject);
          socket.bind(port, () => {
            socket.close();
            resolve();
          });
        });
        return port;
      } catch {
        // try next port
      }
    }
    throw new Error('No available UDP port');
  }
}
