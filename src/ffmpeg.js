// FFmpeg manager for binary probing and session tracking
// Part of homebridge-nest-accfactory
//
// Utility class that locates and probes FFmpeg binary for version, features, and codec capabilities.
// Validates minimum version and required codecs for camera streaming support. Detects and selects
// platform-specific hardware H264 encoders. Manages FFmpeg child process sessions with configurable
// stdio piping for encoding/transcoding.
//
// Constructor accepts optional binaryPath (expanded if starts with ~) and log callback function.
// If no path provided, searches system PATH. Private #probeBinary() method validates binary on init
// and populates features object; if binary not found or probe fails, class degrades gracefully
// (features empty, hasMinimumSupport() returns false).
//
// Hardware H264 codec selection priority:
// - macOS: videotoolbox
// - Linux: nvenc > qsv > vaapi > v4l2m2m (only if required /dev/* exists)
// - Windows: qsv
//
// Session key format: "uuid:sessionID:sessionType" (used internally for tracking spawned processes)
//
// Exported properties:
// - binary: Path to FFmpeg executable (string)
// - version: Detected version string (e.g., "6.1.1")
// - features: Object with encoders[], decoders[], muxers[], demuxers[], enabled[], h264_* flags
// - supportsHardwareH264: Boolean indicating if any hardware encoder is available
// - hardwareH264Codec: Selected hardware codec name or undefined
//
// Public methods:
// - hasMinimumSupport(minReqs): Validate version and required codecs
// - createSession(uuid, sessionID, args, sessionType, errorCallback, pipeCount): Spawn FFmpeg
// - killSession(uuid, sessionID, sessionType, signal): Terminate FFmpeg process
// - hasSession(uuid, sessionID, sessionType): Check if session exists
// - listSessions(): Get all active session keys
// - killAllSessions(uuid, signal): Terminate all sessions for UUID
//
// Code version 2026.03.15
// Mark Hulskamp
'use strict';

// Define nodejs module requirements
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import child_process from 'node:child_process';

// FFmpeg object
export default class FFmpeg {
  #binary = undefined;
  #version = undefined;
  #features = {};
  #sessions = new Map(); // Map of "uuid:sessionID:sessionType" => ChildProcess
  #log = undefined; // Logging object

  constructor(binaryPath = undefined, log = undefined) {
    this.#log = log;

    if ((binaryPath?.trim?.() ?? '') !== '') {
      // If path starts with '~' expand to user home directory
      binaryPath = binaryPath.trim();
      if (binaryPath.startsWith('~') === true) {
        binaryPath = path.join(os.homedir(), binaryPath.slice(1));
      }

      let resolved = path.resolve(binaryPath);

      // Check if the resolved path points to a directory or a file
      // If directory, append binary name; if file, use as-is
      // Use path-aware string comparison that handles both forward and backward slashes
      let binaryName = 'ffmpeg' + (os.platform() === 'win32' ? '.exe' : '');
      let resolvedNormalised = resolved.replace(/[\\/]+$/, ''); // Remove trailing slashes
      if (fs.existsSync(resolvedNormalised) === true && fs.statSync(resolvedNormalised).isDirectory() === true) {
        // Path is a directory, append binary name
        this.#binary = path.join(resolvedNormalised, binaryName);
      } else if (path.basename(resolvedNormalised).toLowerCase() === 'ffmpeg' || resolvedNormalised.endsWith(binaryName) === true) {
        // Path already points to ffmpeg binary
        this.#binary = resolvedNormalised;
      } else {
        // Assume it's a directory and append binary name
        this.#binary = path.join(resolvedNormalised, binaryName);
      }
    } else {
      this.#binary = 'ffmpeg'; // Fallback to system PATH
    }

    this.#probeBinary();
  }

  // Validate binary, extract version + feature flags
  #probeBinary() {
    if (fs.existsSync(this.#binary) === false) {
      // Specified binary does not exist
      return;
    }

    let versionOutput = child_process.spawnSync(this.#binary, ['-version'], { env: process.env });
    if (versionOutput?.stdout === null || versionOutput.status !== 0) {
      // Failed to execute specified binary with -version command
      return;
    }

    let stdout = String(versionOutput.stdout);
    let match = stdout.match(/^ffmpeg version (\d+(?:\.\d+)*)(?=[-\s])/);
    if ((match?.[1] ?? '') !== '') {
      this.#version = match[1];
    }

    // Parse --enable-xxx flags from build config
    let enabledLibs = stdout.match(/--enable-[^\s]+/g) || [];
    this.#features.enabled = enabledLibs.map((f) => f.replace('--enable-', ''));

    // Helper function to parse feature lists with different regex patterns
    const parseFeatures = (command, regex) => {
      let output = child_process.spawnSync(this.#binary, [command], { env: process.env });
      if (output?.stdout === null || output.status !== 0) {
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

    // Detect hardware H264 codec flags
    let encoders = String(child_process.spawnSync(this.#binary, ['-encoders'], { env: process.env })?.stdout ?? '');
    if (encoders !== '') {
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
      let hasIntelQSV = fs.existsSync('/dev/dri') === true && fs.readdirSync('/dev/dri').some((f) => f.startsWith('render')) === true;

      // macOS: prefer videotoolbox
      if (platform === 'darwin' && this.#features.h264_videotoolbox === true) {
        this.#features.hardwareH264Codec = 'h264_videotoolbox';
      }

      // Linux: prioritise nvenc > qsv > vaapi > v4l2m2m, only if required devices exist
      else if (platform === 'linux') {
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

    // Helper to check if all required items are in available list
    const hasAllRequired = (required, available) => {
      if (Array.isArray(required) === false || required.length === 0) {
        return true;
      }
      return required.every((item) => available.includes(item) === true);
    };

    let encoders = this.#features.encoders || [];
    let decoders = this.#features.decoders || [];
    let muxers = this.#features.muxers || [];

    // Check all feature requirements
    if (hasAllRequired(min?.encoders, encoders) === false) {
      return false;
    }

    if (hasAllRequired(min?.decoders, decoders) === false) {
      return false;
    }

    if (hasAllRequired(min?.muxers, muxers) === false) {
      return false;
    }

    return true;
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

  createSession(uuid, sessionID, args, sessionType = 'default', errorCallback, pipeCount = 3) {
    let key = String(uuid) + ':' + String(sessionID) + ':' + String(sessionType);
    if (this.#sessions.has(key) === true) {
      return;
    }

    // Ensure at least 3 pipes (stdin, stdout, stderr)
    if (pipeCount < 3) {
      pipeCount = 3;
    }

    let stdio = Array.from({ length: pipeCount }, () => 'pipe');
    let child = child_process.spawn(this.#binary, args, { stdio, env: process.env });
    this.#sessions.set(key, child);

    child?.stderr?.on?.('data', (data) => {
      errorCallback?.(data);
    });

    child?.on?.('exit', () => {
      this.#sessions.delete(key);
    });

    // Safely attach no-op .on('error') to prevent EPIPE crash
    for (let i = 0; i < pipeCount; i++) {
      child?.stdio?.[i]?.on?.('error', (error) => {
        if (error?.code === 'EPIPE') {
          // Empty
        }
      });
    }

    // Return stdin, stdout, stderr as named aliases, plus stdio array
    return {
      process: child,
      stdin: stdio[0] === 'pipe' ? child.stdio[0] : undefined,
      stdout: stdio[1] === 'pipe' ? child.stdio[1] : undefined,
      stderr: stdio[2] === 'pipe' ? child.stdio[2] : undefined,
      stdio: child.stdio, // gives access to [3], [4], etc.
    };
  }

  killSession(uuid, sessionID, sessionType = 'default', signal = 'SIGTERM') {
    let key = String(uuid) + ':' + String(sessionID) + ':' + String(sessionType);
    let child = this.#sessions.get(key);
    child?.kill?.(signal);
    this.#sessions.delete(key);
  }

  hasSession(uuid, sessionID, sessionType = 'default') {
    let key = String(uuid) + ':' + String(sessionID) + ':' + String(sessionType);
    return this.#sessions.has(key);
  }

  listSessions() {
    return Array.from(this.#sessions.keys());
  }

  killAllSessions(uuid, signal = 'SIGKILL') {
    for (let [key, child] of this.#sessions.entries()) {
      if (key.startsWith(String(uuid) + ':') === true) {
        child?.kill?.(signal);
        this.#sessions.delete(key);
      }
    }
  }
}
