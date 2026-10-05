// FFmpeg Session Manager
// Part of homebridge-nest-accfactory
//
// Discovers and probes the FFmpeg binary once per instance, exposing version,
// codec and format capabilities for camera and doorbell streaming.
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
// Code version 2026.10.05
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

// FFmpeg object
export default class FFmpeg {
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
    return (
      this.#features?.h264_nvenc === true ||
      this.#features?.h264_vaapi === true ||
      this.#features?.h264_v4l2m2m === true ||
      this.#features?.h264_qsv === true ||
      this.#features?.h264_videotoolbox === true
    );
  }

  get hardwareH264Codec() {
    return this.#features?.hardwareH264Codec;
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

    // Reuse the parsed encoder list for hardware H264 detection without probing again.
    let encoders = this.#features.encoders;
    if (encoders.length > 0) {
      this.#features.h264_nvenc = encoders.includes('h264_nvenc') === true;
      this.#features.h264_vaapi = encoders.includes('h264_vaapi') === true;
      this.#features.h264_v4l2m2m = encoders.includes('h264_v4l2m2m') === true;
      this.#features.h264_qsv = encoders.includes('h264_qsv') === true;
      this.#features.h264_videotoolbox = encoders.includes('h264_videotoolbox') === true;

      // Platform-aware preferred hardware encoder
      this.#features.hardwareH264Codec = undefined;
      let platform = os.platform();
      let hasDri = fs.existsSync('/dev/dri/renderD128') === true || fs.existsSync('/dev/dri/card0') === true;
      let hasVideo = fs.existsSync('/dev/video0') === true;
      let hasIntelQSV = false;
      try {
        hasIntelQSV = fs.readdirSync('/dev/dri').some((f) => f.startsWith('render')) === true;
      } catch {
        // Missing, inaccessible or disappearing device metadata must not prevent software encoding.
      }

      // macOS: prefer videotoolbox
      if (platform === 'darwin' && this.#features.h264_videotoolbox === true) {
        this.#features.hardwareH264Codec = 'h264_videotoolbox';
      }

      // Linux: prioritise nvenc > qsv > vaapi > v4l2m2m, only if required devices exist
      else if (platform === 'linux') {
        // Pi codec nodes are dynamically numbered; identify the encoder rather than a camera or decoder.
        try {
          if (fs.readFileSync('/sys/firmware/devicetree/base/model', 'utf8').startsWith('Raspberry Pi') === true) {
            // Pi DRM nodes provide graphics, not evidence of NVENC, QSV or VAAPI encoding support.
            hasDri = false;
            hasIntelQSV = false;
            hasVideo = false;
            hasVideo = fs.readdirSync('/sys/class/video4linux').some((device) => {
              if (/^video\d+$/.test(device) === false) {
                return false;
              }
              try {
                if (fs.readFileSync('/sys/class/video4linux/' + device + '/name', 'utf8').trim() !== 'bcm2835-codec-encode') {
                  return false;
                }
                fs.accessSync('/dev/' + device, fs.constants.R_OK | fs.constants.W_OK);
                return true;
              } catch {
                // A missing or inaccessible node is not available to this process.
                return false;
              }
            });
          }
        } catch {
          // Missing host metadata keeps the generic check; missing Pi codec metadata leaves acceleration disabled.
        }

        let linuxEncoders = [
          { key: 'h264_nvenc', device: hasDri },
          { key: 'h264_qsv', device: hasIntelQSV },
          { key: 'h264_vaapi', device: hasDri },
          { key: 'h264_v4l2m2m', device: hasVideo },
        ];

        for (let encoder of linuxEncoders) {
          if (this.#features[encoder.key] === true) {
            if (encoder.device !== true) {
              this.#features[encoder.key] = false; // Disable if device not available
            } else if (this.#features.hardwareH264Codec === undefined) {
              this.#features.hardwareH264Codec = encoder.key; // First match becomes selected codec
            }
          }
        }
      }

      // Windows: qsv preferred
      else if (platform === 'win32' && this.#features.h264_qsv === true) {
        this.#features.hardwareH264Codec = 'h264_qsv';
      }
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
