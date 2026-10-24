// FFmpeg
// Part of homebridge-nest-accfactory
//
// FFmpeg capability discovery, media command construction and process ownership.
// Camera supplies HomeKit requirements; Streamer outputs own the returned handles.
//
// Responsibilities:
// - Share successful binary capability discovery across camera instances
// - Validate hardware encoders with bounded probes and retain software fallback
// - Build live, talkback and recording commands from normalised requirements
// - Keep encoder-specific profiles, tuning and input options in one place
// - Own child processes and connected pipes without owning caller streams
// - Supply finite talkback SDP on stdin and optionally pipe stdout to its destination
// - Read bounded MP4 initialization segments and fragments through an async iterator
// - Retain bounded stderr diagnostics after process completion
//
// Session lifecycle:
// - Emit STARTED, STATE_CHANGED and COMPLETE on this manager
// - STARTED confirms spawn; finished and COMPLETE follow process/pipe closure
// - Replace an older session only after its replacement successfully spawns
// - Retain stopping/replaced processes until closure so shutdown can await them
// - Escalate graceful termination to SIGKILL after two seconds by default
// - Keep expected EPIPE errors silent and report other pipe failures to the caller
//
// Recording:
// - Read stdout with backpressure rather than a separate MP4 event queue
// - Support split and extended box headers with bounded segment accumulation
// - Drain complete output after exit; requested stop may discard an incomplete tail
// - Camera retains the HomeKit generator adapter and isLast workaround
//
// Code version 2026.10.25
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import child_process from 'node:child_process';
import { Buffer } from 'node:buffer';
import { StringDecoder } from 'node:string_decoder';
import timers from 'node:timers';
import EventEmitter from 'node:events';

// Define constants
const MAX_DIAGNOSTIC_CHARACTERS = 16384;
const MAX_DIAGNOSTIC_LINES = 20;

const SHUTDOWN_TIMEOUT_MS = 2000;
const BINARY_PROBE_TIMEOUT_MS = 2000;

const HARDWARE_PROBE_TIMEOUT_MS = 2000;
const HARDWARE_PROBE_BUDGET_MS = 4000;
const HARDWARE_PROBE_CACHE_CAPACITY = 32;
const CAPABILITY_CACHE_CAPACITY = 32;

// FFmpeg object
export default class FFmpeg extends EventEmitter {
  static #capabilityCache = new Map(); // Private binary capabilities only; session ownership stays per manager.
  static #hardwareProbeCache = new Map(); // Bounded process-local results; session ownership stays per manager.

  static SESSION_EVENT = {
    STARTED: 'started',
    STATE_CHANGED: 'state_changed',
    COMPLETE: 'complete',
  };

  static SESSION_STATE = {
    STARTING: 'starting',
    RUNNING: 'running',
    STOPPING: 'stopping',
    EXITED: 'exited',
    FAILED: 'failed',
  };

  #binary = undefined;
  #version = undefined;
  #features = {};
  #hardwareEncoder = undefined; // The validated configuration; undefined keeps software as the default.

  #sessions = new Set(); // Private records, including replacements still shutting down
  #shutdown = undefined; // A terminal instance shutdown shares one completion promise.

  constructor(binaryPath = undefined) {
    super(); // Setup event emitter for our class ONLY

    let binaryName = 'ffmpeg' + (os.platform() === 'win32' ? '.exe' : '');

    if ((binaryPath?.trim?.() ?? '') !== '') {
      binaryPath = binaryPath.trim();

      if (path.isAbsolute(binaryPath) === false && binaryPath.includes('/') === false && binaryPath.includes('\\') === false) {
        // Bare command name, allow PATH lookup
        this.#binary = binaryPath;
      } else {
        // If path starts with '~' expand to user home directory
        if (binaryPath.startsWith('~') === true) {
          binaryPath = path.join(os.homedir(), binaryPath.slice(1));
        }

        let resolved = path.resolve(binaryPath);
        let resolvedNormalised = resolved.replace(/[\\/]+$/, '');

        if (fs.existsSync(resolvedNormalised) === true && fs.statSync(resolvedNormalised).isDirectory() === true) {
          this.#binary = path.join(resolvedNormalised, binaryName);
        } else if (path.basename(resolvedNormalised).toLowerCase() === binaryName.toLowerCase()) {
          this.#binary = resolvedNormalised;
        } else {
          this.#binary = path.join(resolvedNormalised, binaryName);
        }
      }
    } else {
      this.#binary = this.#findBinary();
    }

    this.#probeBinary();
  }

  hasMinimumSupport(min = {}) {
    if (typeof this.#version !== 'string') {
      return false;
    }

    if (
      typeof min?.version === 'string' &&
      this.#version.localeCompare(min.version, undefined, {
        numeric: true,
        sensitivity: 'case',
        caseFirst: 'upper',
      }) === -1
    ) {
      return false;
    }

    // Use the same capability queries for individual checks and minimum requirements, including aliases.
    const hasAllRequired = (required, supports) => {
      return Array.isArray(required) === false || required.every((item) => supports.call(this, item) === true);
    };

    return (
      hasAllRequired(min?.encoders, this.supportsEncoder) === true &&
      hasAllRequired(min?.decoders, this.supportsDecoder) === true &&
      hasAllRequired(min?.muxers, this.supportsMuxer) === true
    );
  }

  get binary() {
    return this.#binary;
  }

  get version() {
    return this.#version;
  }

  get supportsHardwareH264() {
    return this.#hardwareEncoder !== undefined;
  }

  get hardwareH264Codec() {
    return this.#hardwareEncoder?.codec;
  }

  getH264EncoderOptions(useHardware = false) {
    let encoding =
      useHardware === true && this.#hardwareEncoder !== undefined
        ? this.#hardwareEncoder
        : { codec: 'libx264', inputArguments: [], filter: 'format=yuv420p', preset: 'veryfast' };

    // Share encoder tuning between live transcoding and recording. Camera owns
    // HomeKit profile/level interpretation; this class owns encoder command syntax.
    let outputArguments = [
      ...(encoding.codec === 'h264_v4l2m2m' ? ['-bf:v', '0'] : []),
      ...(encoding.codec === 'h264_videotoolbox' ? ['-realtime', 'true'] : []),
      ...(encoding.preset !== undefined ? ['-preset', encoding.preset, '-bf', '0'] : []),
      ...(encoding.codec === 'h264_nvenc' ? ['-tune', 'll', '-zerolatency', '1'] : []),
    ];

    return { ...encoding, inputArguments: [...encoding.inputArguments], outputArguments };
  }

  #mediaInput(input, audioCodec, encoding, live) {
    // Keep the common RTP clock. AAC needs duration recovery for parser startup;
    // other encoded audio avoids video-rate inference while the input is probed.
    return [
      '-hide_banner',
      '-nostats',
      ...encoding.inputArguments,
      '-copyts',
      '-fflags',
      audioCodec === 'aac' ? '+discardcorrupt+genpts' : '+discardcorrupt+genpts+nofillin',
      '-avoid_negative_ts',
      'make_zero',
      '-max_delay',
      '500000',
      '-flags',
      'low_delay',
      ...(live === true ? ['-analyzeduration', '500000'] : []),
      '-rtsp_transport',
      'tcp',
      '-i',
      input.url,
    ];
  }

  #videoArguments(video, encoding) {
    // V4L2 expects numeric profiles and omits the explicit level used elsewhere.
    return [
      '-codec:v',
      encoding.codec,
      '-profile:v',
      encoding.codec === 'h264_v4l2m2m' ? { baseline: '66', main: '77', high: '100' }[video.profile] : video.profile,
      ...(encoding.codec === 'h264_v4l2m2m' ? [] : ['-level:v', video.level]),
      ...encoding.outputArguments,
    ];
  }

  startLive({
    id,
    input,
    ports,
    video,
    audio,
    target,
    sourceAudio,
    hardware = false,
    transcode = false,
    talkback,
    talkbackCodec,
    onStderr,
    onCommand,
  }) {
    let encoding = this.getH264EncoderOptions(hardware);
    let args = [
      ...this.#mediaInput(input, sourceAudio, transcode === true ? encoding : { inputArguments: [] }, true),
      '-map',
      '0:v:0',
      ...(transcode === true
        ? [
            ...this.#videoArguments(video, encoding),
            '-filter:v',
            encoding.filter,
            '-fps_mode',
            'passthrough',
            '-g:v',
            '15',
            '-b:v',
            Math.round(video.bitRate * 1.25) + 'k',
            '-maxrate',
            Math.round(video.bitRate * 1.25) + 'k',
            '-bufsize',
            Math.round(video.bitRate * 2.5) + 'k',
          ]
        : ['-codec:v', 'copy', '-fps_mode', 'passthrough']),
      '-video_track_timescale',
      '90000',
      '-payload_type',
      video.payloadType,
      '-ssrc',
      target.videoSSRC,
      '-f',
      'rtp',
      '-srtp_out_suite',
      target.videoSuite,
      '-srtp_out_params',
      target.videoSRTP.toString('base64'),
      'srtp://' + target.address + ':' + target.videoPort + '?rtcpport=' + target.videoPort + '&pkt_size=' + video.mtu,
      ...(audio === undefined
        ? []
        : [
            '-map',
            '0:a:0',
            // Apple HAP R2, section 11.8.2 (page 246), requires 480-sample
            // AAC-ELD blocks. Set this explicitly instead of libfdk's 512 default.
            // Reference: non-github/ARCHITECTURE.md, FFmpeg audio block size.
            ...(audio.codec === 'aac-eld'
              ? ['-codec:a', 'libfdk_aac', '-profile:a', 'aac_eld', '-frame_length', '480']
              : ['-codec:a', 'libopus', '-application', 'lowdelay', '-frame_duration', String(audio.packetTime)]),
            '-flags',
            '+global_header',
            '-ar',
            String(audio.sampleRate),
            '-b:a',
            audio.bitRate + 'k',
            '-ac',
            String(audio.channels),
            '-payload_type',
            audio.payloadType,
            '-ssrc',
            target.audioSSRC,
            '-f',
            'rtp',
            '-srtp_out_suite',
            target.audioSuite,
            '-srtp_out_params',
            target.audioSRTP.toString('base64'),
            'srtp://' +
              target.address +
              ':' +
              target.audioPort +
              '?rtcpport=' +
              target.audioPort +
              '&localrtcpport=' +
              ports.audioControl +
              '&pkt_size=188',
          ]),
    ];

    // Live media and return audio belong to one output, but use separate processes.
    onCommand?.('live streaming', args);
    let handles = [this.start({ id: 'live:' + id, args, onStderr })];

    if (talkback !== undefined && talkback !== null && audio !== undefined) {
      try {
        let talkArgs = [
          '-hide_banner',
          '-nostats',
          '-protocol_whitelist',
          'pipe,udp,rtp',
          '-f',
          'sdp',
          // HomeKit sends microphone audio only during Talk; idle is not EOF.
          '-listen_timeout',
          '0',
          '-codec:a',
          'libfdk_aac',
          '-i',
          'pipe:0',
          '-map',
          '0:a',
          ...(talkbackCodec === 'speex'
            ? ['-codec:a', 'libspeex', '-frames_per_packet', '4', '-vad', '1', '-ac', '1', '-ar', '16k']
            : ['-codec:a', 'libopus', '-application', 'lowdelay', '-ac', '2', '-ar', '48k']),
          '-f',
          'data',
          'pipe:1',
        ];

        // RTPMuxer forwards encrypted HomeKit audio to this loopback receiver.
        let sdp = [
          'v=0',
          'o=- 0 0 IN IP4 127.0.0.1',
          's=HomeKit Audio Talkback',
          'c=IN IP4 127.0.0.1',
          't=0 0',
          'm=audio ' + ports.talkback + ' RTP/AVP ' + audio.payloadType,
          'b=AS:' + audio.bitRate,
          'a=ptime:' + audio.packetTime,
          'a=rtpmap:' +
            audio.payloadType +
            (audio.codec === 'aac-eld' ? ' MPEG4-GENERIC/' : ' opus/') +
            audio.sampleRate +
            '/' +
            audio.channels,
          'a=fmtp:' +
            audio.payloadType +
            (audio.codec === 'aac-eld'
              ? ' profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3;config=F8F0212C00BC00'
              : ' minptime=10;useinbandfec=1'),
          'a=crypto:1 ' + target.audioSuite + ' inline:' + target.audioSRTP.toString('base64'),
        ].join('\r\n');

        onCommand?.('talkback', talkArgs);
        handles.push(this.start({ id: 'talk:' + id, args: talkArgs, input: sdp, output: talkback, onStderr }));
      } catch (error) {
        // A failed talkback setup must not leave its live process orphaned.
        handles[0].stop('SIGKILL');
        throw error;
      }
    }

    return handles;
  }

  startRecording({ id, input, video, includeAudio = true, sourceAudio, hardware = false, onStderr, onCommand }) {
    let encoding = this.getH264EncoderOptions(hardware);
    let args = [
      ...this.#mediaInput(input, sourceAudio, encoding, false),
      '-map',
      '0:v:0',
      ...this.#videoArguments(video, encoding),
      // The Pi's V4L2 encoder needs extra capture buffers for sustained HKSV output.
      ...(encoding.codec === 'h264_v4l2m2m' ? ['-num_capture_buffers', '32'] : []),
      '-filter:v',
      'fps=fps=' + video.fps + ',' + encoding.filter,
      '-fps_mode',
      'cfr',
      '-g:v',
      String(Math.max(1, Math.round((video.fps * video.iFrameInterval) / 1000))),
      '-b:v',
      Math.round(video.bitRate * 2) + 'k',
      '-maxrate',
      Math.round(video.bitRate * 2) + 'k',
      '-bufsize',
      Math.round(video.bitRate * 4) + 'k',
      '-video_track_timescale',
      '90000',
      '-movflags',
      'frag_keyframe+empty_moov+delay_moov+default_base_moof',
      // Preserve an initially later audio start without an async sample-clock correction.
      ...(includeAudio === true
        ? [
            '-map',
            '0:a:0',
            '-codec:a',
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
            'aresample=first_pts=0',
          ]
        : []),
      '-f',
      'mp4',
      'pipe:1',
    ];

    onCommand?.('recording', args);
    return this.start({ id: 'record:' + id, args, onStderr });
  }

  async *fragments(handle, signal = undefined) {
    // Readable backpressure bounds queued stdout data. Retain views into chunks
    // until one initialization segment or moof/mdat fragment is complete, copying
    // payload bytes only once at yield. Process exit does not discard its remaining stdout.
    let header = Buffer.allocUnsafe(16);
    let headerSize = 8;
    let headerUsed = 0;
    let remaining = 0;
    let boxType = undefined;
    let parts = [];
    let bytes = 0;

    for await (let chunk of handle.stdout) {
      if (signal?.aborted === true) {
        return;
      }

      let offset = 0;

      while (offset < chunk.length) {
        if (remaining === 0) {
          // Headers can span stdout chunks; size 1 extends the header to 16 bytes.
          let count = Math.min(headerSize - headerUsed, chunk.length - offset);
          chunk.copy(header, headerUsed, offset, offset + count);
          offset += count;
          headerUsed += count;

          if (headerUsed < headerSize) {
            continue;
          }

          let size = header.readUInt32BE(0);
          if (size === 1 && headerSize === 8) {
            headerSize = 16;
            continue;
          }

          size = size === 1 ? Number(header.readBigUInt64BE(8)) : size;
          if (Number.isSafeInteger(size) !== true || size < headerSize || size > 32 * 1024 * 1024 || bytes + size > 32 * 1024 * 1024) {
            throw new RangeError('Invalid or oversized fragmented MP4 box');
          }

          // The header buffer is reused; retain a copy beside zero-copy payload views.
          boxType = header.subarray(4, 8).toString();
          parts.push(Buffer.from(header.subarray(0, headerSize)));
          bytes += size;
          remaining = size - headerSize;
          headerUsed = 0;
          headerSize = 8;
        }

        let count = Math.min(remaining, chunk.length - offset);
        if (count > 0) {
          parts.push(chunk.subarray(offset, offset + count));
        }
        offset += count;
        remaining -= count;

        // Initialization ends at moov; a media fragment ends at its mdat.
        if (remaining === 0 && (boxType === 'moov' || boxType === 'mdat')) {
          yield Buffer.concat(parts, bytes);
          parts = [];
          bytes = 0;
        }
      }
    }

    // HomeKit may stop in the middle of an mdat. Only unexpected truncation is an error.
    if (signal?.aborted !== true && (remaining !== 0 || headerUsed !== 0 || (bytes !== 0 && boxType !== 'mfra'))) {
      throw new Error('Truncated fragmented MP4 output');
    }
  }

  supportsEncoder(encoder) {
    // Compiled encoder support does not guarantee the required hardware is available.
    return this.#features.encoders?.includes(encoder) === true;
  }

  supportsDecoder(decoder) {
    // An unavailable capability list means support could not be confirmed.
    return this.#features.decoders?.includes(decoder) === true;
  }

  supportsMuxer(muxer) {
    // FFmpeg may list multiple names for a format on a single capability row.
    return this.#features.muxers?.some((names) => names.split(',').includes(muxer) === true) === true;
  }

  // Optional finite stdin supplies talkback SDP; stdout may feed a caller-owned writable.
  // Reusing an id replaces its older processes only after successful spawn; omitting it starts independently.
  start({ id, args = [], input = undefined, output = undefined, onStderr } = {}) {
    if (this.#shutdown !== undefined) {
      throw new Error('FFmpeg instance has been shut down');
    }

    id ??= Symbol('ffmpeg');
    let label = typeof id === 'symbol' ? id.description : String(id);

    let child = child_process.spawn(this.#binary, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    // Keep lifecycle outcome fields together; expose only snapshots when completion is reported.
    let lifecycle = { state: FFmpeg.SESSION_STATE.STARTING, expected: false, error: undefined };
    let shutdownTimer = undefined;
    let shutdownSignal = undefined;
    let completion = Promise.withResolvers();

    const setState = (nextState) => {
      // Update before notifying listeners; repeated requests must not emit duplicate transitions.
      if (lifecycle.state !== nextState) {
        let previousState = lifecycle.state;
        lifecycle.state = nextState;

        if (nextState === FFmpeg.SESSION_STATE.STOPPING) {
          // Detach only this process. A replacement may share the destination.
          if (output !== undefined) {
            child.stdout.unpipe(output);
          }
        }

        this.emit(FFmpeg.SESSION_EVENT.STATE_CHANGED, session, { state: lifecycle.state, previousState });
      }
    };

    // Keep history on the returned handle, so registry cleanup or replacement cannot lose failure details.
    let diagnosticHistory = '';
    let stderrDecoder = new StringDecoder('utf8');

    const appendDiagnostics = (text) => {
      diagnosticHistory = (diagnosticHistory + text).slice(-MAX_DIAGNOSTIC_CHARACTERS);
    };

    const stop = (signal = 'SIGTERM', timeout = SHUTDOWN_TIMEOUT_MS, expected = true) => {
      // Timeout is the grace period in milliseconds; repeated stops share the completion promise.
      // SIGKILL can still accelerate an existing graceful stop.
      if (lifecycle.state === FFmpeg.SESSION_STATE.EXITED || lifecycle.state === FFmpeg.SESSION_STATE.FAILED) {
        return completion.promise;
      }

      if (Number.isFinite(timeout) === false || timeout < 0) {
        throw new RangeError('FFmpeg shutdown timeout must be a nonnegative number');
      }

      if (lifecycle.state === FFmpeg.SESSION_STATE.STOPPING && (signal !== 'SIGKILL' || shutdownSignal === 'SIGKILL')) {
        return completion.promise;
      }

      // Rejected or unsuccessful signals must not change lifecycle intent or arm forced termination.
      if (child.kill(signal) === false) {
        return completion.promise;
      }

      lifecycle.expected = expected;
      shutdownSignal = signal;
      timers.clearTimeout(shutdownTimer);

      if (signal !== 'SIGKILL') {
        // Escalate if FFmpeg ignores graceful termination; finish only when the child closes.
        shutdownTimer = timers.setTimeout(() => {
          stop('SIGKILL', SHUTDOWN_TIMEOUT_MS, lifecycle.expected);
        }, timeout);
      }

      // Notify after scheduling and signalling, so listeners can safely request an immediate force-stop.
      if (lifecycle.state === FFmpeg.SESSION_STATE.STARTING || lifecycle.state === FFmpeg.SESSION_STATE.RUNNING) {
        setState(FFmpeg.SESSION_STATE.STOPPING);
      }

      return completion.promise;
    };

    let session = {
      // State describes the process; finished resolves after the process and its pipes have closed.
      get state() {
        return lifecycle.state;
      },

      // Check this process, rather than another active replacement sharing its registry key.
      get active() {
        return lifecycle.state === FFmpeg.SESSION_STATE.STARTING || lifecycle.state === FFmpeg.SESSION_STATE.RUNNING;
      },

      finished: completion.promise,
      stdout: child.stdio[1],

      get diagnosticLines() {
        // Return a fresh snapshot of recent nonempty lines, including unfinished output and startup errors.
        // Character limits may truncate the oldest line; the retained handle keeps diagnostics available after exit.
        return diagnosticHistory
          .split(/[\r\n]+/)
          .map((line) => line.trim())
          .filter((line) => line !== '')
          .slice(-MAX_DIAGNOSTIC_LINES);
      },

      stop: (signal, timeout) => stop(signal, timeout),
    };

    let record = { id, handle: session };

    child?.stderr?.on?.('data', (data) => {
      // Stream chunks may split UTF-8 characters and lines; decode before retaining the bounded tail.
      appendDiagnostics(stderrDecoder.write(Buffer.isBuffer(data) === true ? data : Buffer.from(data)));
      onStderr?.(data);
    });

    child?.stderr?.on?.('end', () => {
      appendDiagnostics(stderrDecoder.end());
    });

    child.once('spawn', () => {
      // A stop requested before spawn must not transition back to running.
      if (lifecycle.state !== FFmpeg.SESSION_STATE.STARTING) {
        return;
      }

      setState(FFmpeg.SESSION_STATE.RUNNING);

      // A state listener may already have stopped this process.
      if (session.active === false) {
        return;
      }

      // Replace only after successful spawn; failed replacements leave the previous process available.
      for (let existing of this.#sessions) {
        // Set insertion order identifies older requests; never stop a newer pending replacement.
        if (existing === record) {
          break;
        }

        if (existing.id === id) {
          existing.handle.stop();
        }
      }

      // A successful active spawn is not confirmation that FFmpeg is ready to deliver media.
      if (session.active === true) {
        this.emit(FFmpeg.SESSION_EVENT.STARTED, session);
      }
    });

    child.on('error', (error) => {
      lifecycle.error = error;
      let startupFailure = child.pid === undefined;

      // Spawn and signal errors share diagnostics; completion is reported once, after pipes close.
      let message =
        (startupFailure === true ? 'Failed to start ffmpeg session "' : 'Error in ffmpeg session "') +
        label +
        '". Error was "' +
        String(error?.message || error) +
        '"';
      appendDiagnostics('\n' + message + '\n');

      if (startupFailure === true) {
        setState(FFmpeg.SESSION_STATE.FAILED);
      }

      onStderr?.(message);
    });

    child.once('exit', (code, signal) => {
      timers.clearTimeout(shutdownTimer);
      setState(
        lifecycle.expected === true || (code === 0 && signal === null && lifecycle.error === undefined)
          ? FFmpeg.SESSION_STATE.EXITED
          : FFmpeg.SESSION_STATE.FAILED,
      );
    });

    child.once('close', (code, signal) => {
      // Exit or spawn failure already set the final state; close guarantees final stderr has been drained.
      timers.clearTimeout(shutdownTimer);
      if (output !== undefined) {
        child.stdout.unpipe(output);
      }
      this.#sessions.delete(record);

      // Both finished and complete share one outcome; expected distinguishes requested shutdown from failure.
      let result = { ...lifecycle, code, signal };
      completion.resolve(result);
      this.emit(FFmpeg.SESSION_EVENT.COMPLETE, session, result);
    });

    for (let i = 0; i < child.stdio.length; i++) {
      child?.stdio?.[i]?.on?.('error', (error) => {
        // Writes can race with normal shutdown; keep expected broken-pipe errors silent.
        if (error?.code === 'EPIPE') {
          return;
        }

        lifecycle.error = error;
        let message = 'Error on ffmpeg session "' + label + '" pipe ' + i + '. Error was "' + String(error?.message || error) + '"';
        appendDiagnostics('\n' + message + '\n');
        onStderr?.(message);
      });
    }

    // Register before attaching pipes so setup failure or a reentrant shutdown still owns this process.
    this.#sessions.add(record);

    try {
      if (input !== undefined) {
        // SDP is finite; ending stdin lets FFmpeg finish reading its description.
        if (typeof input !== 'string' && Buffer.isBuffer(input) !== true) {
          throw new TypeError('FFmpeg input must be a string or buffer');
        }
        child.stdin.end(input);
      }
      if (output !== undefined && session.active === true) {
        if (typeof output?.write !== 'function') {
          throw new TypeError('FFmpeg output must be a writable stream');
        }
        // Natural exit must drain final output. Requested stop only unpipes;
        // it never destroys or ends a destination owned by the caller.
        child.stdout.pipe(output);
      }
    } catch (error) {
      lifecycle.error = error;
      appendDiagnostics(
        '\nFailed to attach ffmpeg session "' + label + '" media pipes. Error was "' + String(error?.message || error) + '"',
      );
      // Setup failure still owns this process and is an unexpected termination.
      stop('SIGKILL', SHUTDOWN_TIMEOUT_MS, false);
    }

    return session;
  }

  // Shutdown is terminal: it rejects new starts and waits for retired processes as well as current ones.
  shutdown(signal = 'SIGKILL', timeout = SHUTDOWN_TIMEOUT_MS) {
    if (this.#shutdown === undefined) {
      this.#shutdown = Promise.withResolvers();
      Promise.all([...this.#sessions].map(async (record) => record.handle.stop(signal, timeout))).then(
        this.#shutdown.resolve,
        this.#shutdown.reject,
      );
    }

    return this.#shutdown.promise;
  }

  // Validate binary, extract version + feature flags
  #probeBinary() {
    if ((this.#binary.includes('/') === true || this.#binary.includes('\\') === true) && fs.existsSync(this.#binary) === false) {
      // Specified binary path does not exist
      return;
    }

    let binaryMetadata = this.#getBinaryMetadata();
    let identity = JSON.stringify(binaryMetadata);
    let cached = FFmpeg.#capabilityCache.get(binaryMetadata?.[0]);
    if (cached !== undefined && cached.identity === identity) {
      this.#version = cached.version;
      this.#features = cached.features;
      this.#probeHardwareEncoder(binaryMetadata);
      return;
    }

    // Capability discovery is synchronous during setup, so a stalled binary must be forcibly bounded.
    let versionOutput = child_process.spawnSync(this.#binary, ['-version'], {
      env: process.env,
      timeout: BINARY_PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });

    if (versionOutput?.error !== undefined || versionOutput?.stdout === null || versionOutput.status !== 0) {
      // Failed to execute specified binary with -version command
      return;
    }

    let stdout = String(versionOutput.stdout);
    let match = stdout.match(/^ffmpeg version\s+([0-9]+(?:\.[0-9]+)*)(?:[-\s]|$)/i);
    if ((match?.[1] ?? '') !== '') {
      this.#version = match[1];
    }

    // Failed queries remain retryable rather than caching an incomplete capability set.
    let complete = true;

    // Helper function to parse feature lists with different regex patterns
    const parseFeatures = (command, regex) => {
      let output = child_process.spawnSync(this.#binary, [command], {
        env: process.env,
        timeout: BINARY_PROBE_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });

      if (output?.error !== undefined || output?.stdout === null || output?.stdout === undefined || output.status !== 0) {
        complete = false;
        return [];
      }

      let features = [];
      for (let line of String(output.stdout).split('\n')) {
        let m = line.match(regex);
        if ((m?.[1] ?? '') !== '') {
          features.push(m[1]);
        }
      }

      return features;
    };

    // Retain only capabilities used by minimum checks and encoder selection.
    this.#features.encoders = parseFeatures('-encoders', /^\s*[A-Z.]+\s+([^\s]+)/);
    this.#features.decoders = parseFeatures('-decoders', /^\s*[A-Z.]+\s+([^\s]+)/);
    this.#features.muxers = parseFeatures('-muxers', /^\s*[E][A-Z.]*\s+([^\s]+)/);

    // Capabilities stay private and are not mutated after discovery. Synchronous
    // setup prevents another constructor from observing a partially filled entry.
    if (binaryMetadata !== undefined && typeof this.#version === 'string' && complete === true) {
      if (FFmpeg.#capabilityCache.has(binaryMetadata[0]) !== true && FFmpeg.#capabilityCache.size >= CAPABILITY_CACHE_CAPACITY) {
        FFmpeg.#capabilityCache.delete(FFmpeg.#capabilityCache.keys().next().value);
      }
      FFmpeg.#capabilityCache.set(binaryMetadata[0], { identity, version: this.#version, features: this.#features });
    }
    this.#probeHardwareEncoder(binaryMetadata);
  }

  #getBinaryMetadata() {
    // Resolve bare commands using executable PATH entries, not merely the first
    // existing filename. Without a verifiable identity, capability discovery is not cached.
    try {
      let executable = this.#binary;
      if (executable.includes('/') === false && executable.includes('\\') === false) {
        executable = (process.env.PATH ?? '')
          .split(path.delimiter)
          .map((directory) => path.resolve(directory, this.#binary))
          .find((file) => {
            try {
              fs.accessSync(file, fs.constants.X_OK);
              return fs.statSync(file).isFile() === true;
            } catch {
              return false;
            }
          });
        if (executable === undefined) {
          return undefined;
        }
      }
      let stat = fs.statSync(executable);
      return Number.isFinite(stat.size) === true && Number.isFinite(stat.mtimeMs) === true && Number.isFinite(stat.ino) === true
        ? [executable, stat.size, stat.mtimeMs, stat.ino]
        : undefined;
    } catch {
      return undefined;
    }
  }

  #discoverHardwareEncoders() {
    let platform = os.platform();
    let renderDevices = [];
    let videoEncoder = undefined;
    let isPi = false;

    if (platform === 'linux') {
      try {
        isPi = fs.readFileSync('/sys/firmware/devicetree/base/model', 'utf8').startsWith('Raspberry Pi') === true;
      } catch {
        // Most non-Pi hosts do not expose device-tree metadata.
      }

      if (isPi === false) {
        try {
          renderDevices = fs
            .readdirSync('/dev/dri')
            .filter((name) => /^renderD\d+$/.test(name) === true)
            .sort()
            .slice(0, 8)
            .map((name) => '/dev/dri/' + name)
            .filter((device) => {
              try {
                fs.accessSync(device, fs.constants.R_OK | fs.constants.W_OK);
                return true;
              } catch {
                return false;
              }
            });
        } catch {
          // Missing or inaccessible render nodes cannot enable QSV or VAAPI.
        }
      }

      try {
        videoEncoder = fs.readdirSync('/sys/class/video4linux').find((device) => {
          if (/^video\d+$/.test(device) === false) {
            return false;
          }

          try {
            let name = fs.readFileSync('/sys/class/video4linux/' + device + '/name', 'utf8').trim();
            if ((isPi === true ? name === 'bcm2835-codec-encode' : /encode/i.test(name) === true) === false) {
              return false;
            }

            fs.accessSync('/dev/' + device, fs.constants.R_OK | fs.constants.W_OK);
            return true;
          } catch {
            return false;
          }
        });
      } catch {
        // Camera/decoder nodes and missing encoder metadata are not encoding capabilities.
      }
    }

    let candidates = [];
    if (platform === 'darwin') {
      candidates.push({ codec: 'h264_videotoolbox', inputArguments: [], filter: 'format=yuv420p', preset: undefined });
    } else if (platform === 'win32') {
      candidates.push({ codec: 'h264_qsv', inputArguments: [], filter: 'format=nv12', preset: 'veryfast' });
    } else if (platform === 'linux') {
      if (isPi === false) {
        candidates.push({ codec: 'h264_nvenc', inputArguments: [], filter: 'format=yuv420p', preset: 'p4' });
        for (let device of renderDevices) {
          candidates.push({ codec: 'h264_qsv', inputArguments: ['-qsv_device', device], filter: 'format=nv12', preset: 'veryfast' });
        }
        for (let device of renderDevices) {
          candidates.push({
            codec: 'h264_vaapi',
            inputArguments: ['-vaapi_device', device],
            filter: 'format=nv12,hwupload',
            preset: undefined,
          });
        }
      }
      if (videoEncoder !== undefined) {
        candidates.push({ codec: 'h264_v4l2m2m', inputArguments: [], filter: 'format=yuv420p', preset: undefined });
      }
    }

    return {
      platform,
      videoEncoder,
      candidates: candidates.filter((candidate) => this.supportsEncoder(candidate.codec) === true),
    };
  }

  // Validate an actual encode, rather than treating compiled encoders or graphics nodes as hardware evidence.
  #probeHardwareEncoder(binaryMetadata) {
    let codecs = ['h264_nvenc', 'h264_qsv', 'h264_vaapi', 'h264_v4l2m2m', 'h264_videotoolbox'];
    if (codecs.some((codec) => this.supportsEncoder(codec) === true) === false) {
      return;
    }

    let { platform, videoEncoder, candidates } = this.#discoverHardwareEncoders();
    if (candidates.length === 0) {
      return;
    }

    // Hardware availability is cached separately from compiled capabilities.
    // Unresolved commands retain the existing PATH-based hardware cache identity.
    let cacheKey = JSON.stringify([
      binaryMetadata ?? [this.#binary, process.env.PATH],
      platform,
      this.#version,
      this.#features.encoders,
      videoEncoder,
      candidates,
    ]);
    let selection = FFmpeg.#hardwareProbeCache.get(cacheKey);

    if (selection === undefined) {
      selection = null; // Cache a failed validation too, without inventing an encoder configuration.
      let startedAt = Date.now();
      for (let candidate of candidates) {
        let remaining = HARDWARE_PROBE_BUDGET_MS - (Date.now() - startedAt);
        if (remaining <= 0) {
          break;
        }

        let probe = child_process.spawnSync(
          this.#binary,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-nostdin',
            ...candidate.inputArguments,
            '-f',
            'lavfi',
            '-i',
            'color=c=black:s=320x240:r=15',
            '-frames:v',
            '1',
            '-an',
            '-codec:v',
            candidate.codec,
            '-filter:v',
            candidate.filter,
            '-profile:v',
            candidate.codec === 'h264_v4l2m2m' ? '66' : 'baseline',
            ...(candidate.codec === 'h264_v4l2m2m' ? [] : ['-level:v', '3.1']),
            '-bf:v',
            '0',
            ...(candidate.preset !== undefined ? ['-preset', candidate.preset] : []),
            '-b:v',
            '500k',
            '-f',
            'h264',
            'pipe:1',
          ],
          {
            env: process.env,
            timeout: Math.min(HARDWARE_PROBE_TIMEOUT_MS, remaining),
            killSignal: 'SIGKILL',
            maxBuffer: 65536,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );

        // Require encoded output too: successful invocation alone does not establish frame production.
        if (probe.error === undefined && probe.status === 0 && probe.stdout?.length > 0) {
          selection = candidate;
          break;
        }
      }

      if (FFmpeg.#hardwareProbeCache.size >= HARDWARE_PROBE_CACHE_CAPACITY) {
        FFmpeg.#hardwareProbeCache.delete(FFmpeg.#hardwareProbeCache.keys().next().value);
      }
      FFmpeg.#hardwareProbeCache.set(cacheKey, selection);
    }

    this.#hardwareEncoder = selection ?? undefined;
  }

  // Locate ffmpeg binary when no explicit path is provided.
  // Searches common install locations per platform and falls back to PATH.
  //
  // Behaviour:
  // - On Unix/macOS:
  //   - Checks common locations such as /usr/local/bin and Homebrew paths
  // - On Windows:
  //   - Checks common install directories and current working directory
  // - Returns the first valid binary found
  // - Falls back to plain "ffmpeg" so OS PATH resolution can be used
  //
  // Notes:
  // - Does not validate binary execution (handled later by #probeBinary())
  // - Order of search paths defines priority
  // - Designed to support typical Homebridge / Node.js environments
  #findBinary() {
    let binaryName = 'ffmpeg' + (os.platform() === 'win32' ? '.exe' : '');

    // Default search paths for Unix/macOS systems
    let searchPaths = [
      '/usr/local/bin', // Common manual install location
      '/opt/homebrew/bin', // Homebrew (Apple Silicon macOS)
      '/usr/bin', // System binaries
      '/bin', // Fallback system path
    ];

    // Override search paths for Windows environments
    if (os.platform() === 'win32') {
      searchPaths = [
        process.cwd(), // Local project directory
        'C:\\ffmpeg\\bin', // Common manual install path
        'C:\\Program Files\\ffmpeg\\bin', // Typical installer location
      ];
    }

    // Iterate through search paths and return first valid binary
    for (let searchPath of searchPaths) {
      let binaryPath = path.join(searchPath, binaryName);

      if (fs.existsSync(binaryPath) === true) {
        return binaryPath;
      }
    }

    // Fallback to PATH resolution (e.g. global install)
    return binaryName;
  }
}
