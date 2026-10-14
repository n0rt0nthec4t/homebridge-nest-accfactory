// FFmpeg Session Manager
// Part of homebridge-nest-accfactory
//
// Discovers and probes the FFmpeg binary once per instance, exposing version,
// codec and format capabilities for camera and doorbell streaming. Hardware
// selection requires a bounded encode probe, cached across managers for the same binary and discovered devices.
// Callers build command arguments, connect media pipes, and handle HomeKit cleanup and logging.
//
// Session management:
// - Track processes by device UUID, session ID and session type (live, record, talkback)
// - Expose lifecycle states and STARTED, STATE_CHANGED and COMPLETE events on session handles
// - STARTED confirms process spawning; COMPLETE follows process and pipe closure
// - Replace older sessions only after successful spawning, preserving them if replacement startup fails
// - Retain stopping and replaced processes until closure so device teardown can await them
// - Support awaitable shutdown, escalating graceful termination to SIGKILL after two seconds by default
//
// Diagnostics:
// - Drain stderr and retain bounded history readable from the session handle after completion
// - Keep expected EPIPE errors silent; retain and report other pipe errors through the caller's callback
// - Tolerate missing or inaccessible DRM metadata during hardware detection
//
// Code version 2026.10.10
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

const MAX_DIAGNOSTIC_CHARACTERS = 16384;
const MAX_DIAGNOSTIC_LINES = 20;
const SHUTDOWN_TIMEOUT_MS = 2000;
const HARDWARE_PROBE_TIMEOUT_MS = 2000;
const HARDWARE_PROBE_BUDGET_MS = 4000;
const HARDWARE_PROBE_CACHE_CAPACITY = 32;

// FFmpeg object
export default class FFmpeg {
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
  #sessions = new Set(); // Session handles, including replacements still shutting down

  constructor(binaryPath = undefined) {
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

  get features() {
    return this.#features;
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
    return { ...encoding, inputArguments: [...encoding.inputArguments] };
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

  createSession(uuid, sessionID, args, sessionType = 'default', errorCallback, pipeCount = 3) {
    // Default invalid counts to three; always include stdin, stdout and stderr.
    pipeCount = Number.isInteger(pipeCount) === true ? Math.max(3, pipeCount) : 3;

    let child = child_process.spawn(this.#binary, args, {
      stdio: Array.from({ length: pipeCount }, () => 'pipe'),
      env: process.env,
    });

    // Keep lifecycle outcome fields together; expose only snapshots when completion is reported.
    let lifecycle = { state: FFmpeg.SESSION_STATE.STARTING, expected: false, error: undefined };
    let shutdownTimer;
    let completion = Promise.withResolvers();
    const setState = (nextState) => {
      // Update before notifying listeners; repeated requests must not emit duplicate transitions.
      if (lifecycle.state !== nextState) {
        let previousState = lifecycle.state;
        lifecycle.state = nextState;
        child.emit(FFmpeg.SESSION_EVENT.STATE_CHANGED, { state: lifecycle.state, previousState });
      }
    };

    // Keep history on the returned handle, so registry cleanup or replacement cannot lose failure details.
    let diagnosticHistory = '';
    let stderrDecoder = new StringDecoder('utf8');
    const appendDiagnostics = (text) => {
      diagnosticHistory = (diagnosticHistory + text).slice(-MAX_DIAGNOSTIC_CHARACTERS);
    };

    child?.stderr?.on?.('data', (data) => {
      // Stream chunks may split UTF-8 characters and lines; decode before retaining the bounded tail.
      appendDiagnostics(stderrDecoder.write(Buffer.isBuffer(data) === true ? data : Buffer.from(data)));
      errorCallback?.(data);
    });

    child?.stderr?.on?.('end', () => {
      appendDiagnostics(stderrDecoder.end());
    });

    child.once('spawn', () => {
      // A stop requested before spawn must not transition back to running.
      if (lifecycle.state === FFmpeg.SESSION_STATE.STARTING) {
        setState(FFmpeg.SESSION_STATE.RUNNING);
        // Replace only after successful spawn; failed replacements leave the previous process available.
        if (lifecycle.state === FFmpeg.SESSION_STATE.RUNNING) {
          for (let existing of this.#sessions) {
            // Set insertion order identifies older requests; never stop a newer pending replacement.
            if (existing === session) {
              break;
            }
            if (existing.key === session.key) {
              existing.kill();
            }
          }
          // A successful active spawn is not confirmation that FFmpeg is ready to deliver media.
          if (lifecycle.state === FFmpeg.SESSION_STATE.RUNNING) {
            child.emit(FFmpeg.SESSION_EVENT.STARTED, session);
          }
        }
      }
    });

    child.on('error', (error) => {
      lifecycle.error = error;
      let startupFailure = child.pid === undefined;
      // Spawn and signal errors share diagnostics; completion is reported once, after pipes close.
      let message =
        (startupFailure === true ? 'Failed to start ffmpeg session "' : 'Error in ffmpeg session "') +
        session.key +
        '". Error was "' +
        String(error?.message || error) +
        '"';
      appendDiagnostics('\n' + message + '\n');
      if (startupFailure === true) {
        setState(FFmpeg.SESSION_STATE.FAILED);
      }
      errorCallback?.(message);
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
      this.#sessions.delete(session);
      // Both finished and complete share one outcome; expected distinguishes requested shutdown from failure.
      let result = { ...lifecycle, code, signal };
      completion.resolve(result);
      child.emit(FFmpeg.SESSION_EVENT.COMPLETE, result);
    });

    for (let i = 0; i < pipeCount; i++) {
      child?.stdio?.[i]?.on?.('error', (error) => {
        // Writes can race with normal shutdown; keep expected broken-pipe errors silent.
        if (error?.code === 'EPIPE') {
          return;
        }
        lifecycle.error = error;
        let message = 'Error on ffmpeg session "' + session.key + '" pipe ' + i + '. Error was "' + String(error?.message || error) + '"';
        appendDiagnostics('\n' + message + '\n');
        errorCallback?.(message);
      });
    }

    let session = {
      key: String(uuid) + ':' + String(sessionID) + ':' + String(sessionType),
      process: child,
      // State describes the process; finished resolves after the process and its pipes have closed.
      get state() {
        return lifecycle.state;
      },
      finished: completion.promise,
      stdin: child.stdio[0],
      stdout: child.stdio[1],
      stderr: child.stdio[2],
      stdio: child.stdio,
      get diagnosticLines() {
        // Return a fresh snapshot of recent nonempty lines, including unfinished output and startup errors.
        // Character limits may truncate the oldest line; the retained handle keeps diagnostics available after exit.
        return diagnosticHistory
          .split(/[\r\n]+/)
          .map((line) => line.trim())
          .filter((line) => line !== '')
          .slice(-MAX_DIAGNOSTIC_LINES);
      },
      on: (...args) => child.on(...args),
      once: (...args) => child.once(...args),
      kill: (signal = 'SIGTERM', timeout = SHUTDOWN_TIMEOUT_MS) => {
        // Timeout is the grace period in milliseconds; repeated stops share the completion promise.
        // SIGKILL can still accelerate an existing graceful stop.
        if (lifecycle.state === FFmpeg.SESSION_STATE.EXITED || lifecycle.state === FFmpeg.SESSION_STATE.FAILED) {
          return completion.promise;
        }
        if (Number.isFinite(timeout) === false || timeout < 0) {
          throw new RangeError('FFmpeg shutdown timeout must be a nonnegative number');
        }
        if (lifecycle.state === FFmpeg.SESSION_STATE.STOPPING && signal !== 'SIGKILL') {
          return completion.promise;
        }
        // Rejected or unsuccessful signals must not change lifecycle intent or arm forced termination.
        if (child.kill(signal) === false) {
          return completion.promise;
        }
        lifecycle.expected = true;
        timers.clearTimeout(shutdownTimer);
        if (signal !== 'SIGKILL') {
          // Escalate if FFmpeg ignores graceful termination; finish only when the child closes.
          shutdownTimer = timers.setTimeout(() => {
            child.kill('SIGKILL');
          }, timeout);
        }
        // Notify after scheduling and signalling, so listeners can safely request an immediate force-stop.
        if (lifecycle.state === FFmpeg.SESSION_STATE.STARTING || lifecycle.state === FFmpeg.SESSION_STATE.RUNNING) {
          setState(FFmpeg.SESSION_STATE.STOPPING);
        }
        return completion.promise;
      },
    };
    this.#sessions.add(session);
    return session;
  }

  killSession(uuid, sessionID, sessionType = 'default', signal = 'SIGTERM', timeout = SHUTDOWN_TIMEOUT_MS) {
    // Include older replacements with the same key and await their actual closure.
    let key = String(uuid) + ':' + String(sessionID) + ':' + String(sessionType);
    return Promise.all([...this.#sessions].filter((session) => session.key === key).map((session) => session.kill(signal, timeout)));
  }

  hasSession(uuid, sessionID, sessionType = 'default') {
    // Stopping sessions remain tracked for teardown but no longer accept media work.
    let key = String(uuid) + ':' + String(sessionID) + ':' + String(sessionType);
    return [...this.#sessions].some(
      (session) => session.key === key && [FFmpeg.SESSION_STATE.STARTING, FFmpeg.SESSION_STATE.RUNNING].includes(session.state) === true,
    );
  }

  listSessions() {
    // List unique tracked keys, including processes whose shutdown has not completed.
    return [...new Set([...this.#sessions].map((session) => session.key))];
  }

  killAllSessions(uuid, signal = 'SIGKILL', timeout = SHUTDOWN_TIMEOUT_MS) {
    // Wait for every tracked process for this device, including replaced and stopping sessions.
    return Promise.all(
      [...this.#sessions]
        .filter((session) => session.key.startsWith(String(uuid) + ':') === true)
        .map((session) => session.kill(signal, timeout)),
    );
  }

  // Validate binary, extract version + feature flags
  #probeBinary() {
    if ((this.#binary.includes('/') === true || this.#binary.includes('\\') === true) && fs.existsSync(this.#binary) === false) {
      // Specified binary path does not exist
      return;
    }

    let versionOutput = child_process.spawnSync(this.#binary, ['-version'], { env: process.env });
    if (versionOutput?.error !== undefined || versionOutput?.stdout === null || versionOutput.status !== 0) {
      // Failed to execute specified binary with -version command
      return;
    }

    let stdout = String(versionOutput.stdout);
    let match = stdout.match(/^ffmpeg version\s+([0-9]+(?:\.[0-9]+)*)(?:[-\s]|$)/i);
    if ((match?.[1] ?? '') !== '') {
      this.#version = match[1];
    }

    // Parse --enable-xxx flags from build config
    let enabledLibs = stdout.match(/--enable-[^\s]+/g) || [];
    this.#features.enabled = enabledLibs.map((f) => f.replace('--enable-', ''));

    // Helper function to parse feature lists with different regex patterns
    const parseFeatures = (command, regex) => {
      let output = child_process.spawnSync(this.#binary, [command], { env: process.env });
      if (output?.error !== undefined || output?.stdout === null || output.status !== 0) {
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

    // Parse feature lists (encoders, decoders, muxers, demuxers)
    this.#features.encoders = parseFeatures('-encoders', /^\s*[A-Z.]+\s+([^\s]+)/);
    this.#features.decoders = parseFeatures('-decoders', /^\s*[A-Z.]+\s+([^\s]+)/);
    this.#features.muxers = parseFeatures('-muxers', /^\s*[E][A-Z.]*\s+([^\s]+)/);
    this.#features.demuxers = parseFeatures('-demuxers', /^\s*[D][A-Z.]*\s+([^\s]+)/);

    this.#probeHardwareEncoder();
  }

  #discoverHardwareEncoders() {
    let platform = os.platform();
    let renderDevices = [];
    let videoEncoder;
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
  #probeHardwareEncoder() {
    let codecs = ['h264_nvenc', 'h264_qsv', 'h264_vaapi', 'h264_v4l2m2m', 'h264_videotoolbox'];
    for (let codec of codecs) {
      this.#features[codec] = false;
    }
    if (codecs.some((codec) => this.supportsEncoder(codec) === true) === false) {
      return;
    }

    let { platform, videoEncoder, candidates } = this.#discoverHardwareEncoders();
    if (candidates.length === 0) {
      return;
    }

    // Recheck metadata on construction, but reuse successful and failed encode probes across camera managers.
    // Binary metadata invalidates the result when an executable at the same path is replaced.
    let binaryMetadata;
    try {
      let executable = this.#binary;
      if (executable.includes('/') === false && executable.includes('\\') === false) {
        executable =
          (process.env.PATH ?? '')
            .split(path.delimiter)
            .map((directory) => path.resolve(directory, this.#binary))
            .find((file) => fs.existsSync(file) === true) ?? executable;
      }
      let stat = fs.statSync(executable);
      binaryMetadata = [executable, stat.size, stat.mtimeMs, stat.ino];
    } catch {
      // An unresolved command still has a stable process-local identity including PATH and parsed capabilities.
      binaryMetadata = [this.#binary, process.env.PATH];
    }
    let cacheKey = JSON.stringify([binaryMetadata, platform, this.#version, this.#features.encoders, videoEncoder, candidates]);
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
    if (this.#hardwareEncoder !== undefined) {
      // Retain the existing feature flags and codec field for callers of features.
      this.#features[this.#hardwareEncoder.codec] = true;
      this.#features.hardwareH264Codec = this.#hardwareEncoder.codec;
    }
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
