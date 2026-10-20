// Talkback
// Part of homebridge-nest-accfactory
//
// Implements HomeKit return-audio routing for camera two-way audio.
// Receives encrypted RTP/RTCP packets and forwards them to the local
// FFmpeg talkback receiver and outgoing audio control socket.
//
// Responsibilities:
// - Own one live session's UDP splitter socket
// - Validate incoming RTP/RTCP packet versions
// - Route talkback RTP audio to its FFmpeg receiver
// - Forward sender/receiver reports to both local audio endpoints
// - Preserve conservative forwarding for unknown control packets
// - Handle socket errors and idempotent cleanup
//
// Integration:
// - Camera owns HomeKit port negotiation and the managed FFmpeg process
// - FFmpeg decrypts and converts the incoming HomeKit audio
// - Streamer forwards encoded talkback audio to the active camera transport
//
// Code version 2026.10.20
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import { Buffer } from 'node:buffer';
import dgram from 'node:dgram';

// Talkback object
export default class Talkback {
  #socket = undefined;
  #settings = {};

  constructor({ port, audioPort, talkbackPort, payloadType, description, log }) {
    this.#settings = { audioPort, talkbackPort, payloadType, description, log };
    this.#socket = dgram.createSocket('udp4');
    this.#socket.on('message', (message) => this.#route(message));
    this.#socket.on('error', (error) => {
      this.#settings.log?.error?.(
        'Talkback RTP splitter on "%s" had an error. Error was "%s"',
        this.#settings.description,
        typeof error?.message === 'string' ? error.message : String(error),
      );
      this.close();
    });
    this.#socket.bind(port);
  }

  #route(message) {
    if (this.#socket === undefined || Buffer.isBuffer(message) !== true || message.length < 2) {
      return;
    }

    // RTP and RTCP retain their encrypted payloads. Only the visible version
    // and packet-type bytes are needed to choose the existing local routes.
    let version = message.readUInt8(0) >> 6;
    if (version !== 2) {
      this.#settings.log?.debug?.(
        'Ignoring invalid talkback packet on "%s": unsupported RTP/RTCP version "%s"',
        this.#settings.description,
        version,
      );
      return;
    }

    let packetType = message.readUInt8(1);
    let payloadType = packetType & 0x7f;
    let isRTCP = packetType === 200 || packetType === 201;

    // Mask the RTP marker bit, but classify sender/receiver reports first:
    // their full RTCP types would otherwise look like payload types 72 or 73.
    if (isRTCP !== true && payloadType === this.#settings.payloadType) {
      this.#socket.send(message, this.#settings.talkbackPort);
      return;
    }

    if (isRTCP !== true) {
      // Preserve conservative forwarding for other control/unknown packets.
      this.#settings.log?.debug?.(
        'Talkback unknown RTP/RTCP packet on "%s": type="%s" payloadType="%s" length="%s"',
        this.#settings.description,
        packetType,
        payloadType,
        message.length,
      );
    }

    // Reports reach both the outgoing audio side and the talkback receiver.
    this.#socket.send(message, this.#settings.audioPort);
    this.#socket.send(message, this.#settings.talkbackPort);
  }

  close() {
    let socket = this.#socket;
    if (socket === undefined) {
      return;
    }
    this.#socket = undefined;
    socket.removeAllListeners();
    try {
      socket.close();
    } catch (error) {
      // A failed bind can leave a socket that never entered the running state.
      if (error.code !== 'ERR_SOCKET_DGRAM_NOT_RUNNING') {
        throw error;
      }
    }
  }
}
