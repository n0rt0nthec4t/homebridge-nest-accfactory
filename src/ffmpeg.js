// FFmpeg Session Manager
// Part of homebridge-nest-accfactory
//
// Provides a lightweight wrapper around the FFmpeg binary for managing
// streaming and recording sessions used by camera and doorbell devices.
//
// Responsibilities:
// - Locate and validate FFmpeg binary and feature support
// - Spawn and manage FFmpeg processes
// - Track active FFmpeg sessions per device
// - Provide controlled lifecycle management (create / replace / stop sessions)
// - Ensure stderr is safely drained to prevent process blocking
//
// Features:
// - Automatic FFmpeg binary discovery across common platform paths (macOS, Linux, Windows)
// - One-time binary probing (version + codec capability detection)
// - Session-based process management via createSession() / killSession()
// - Safe replacement of existing sessions with the same key
// - Externalised error handling via callback hooks
// - Support for multiple concurrent session types (e.g. live, record, talkback)
// - Safe process cleanup and resource handling
//
// Notes:
// - Used primarily by camera and doorbell modules for:
//   - Live streaming to HomeKit
//   - HomeKit Secure Video (HKSV) recording
//   - Two-way audio (talkback)
// - Does NOT perform any media processing itself — only manages FFmpeg execution
// - Logging and debugging are handled by the calling module
// - Binary validation and capability checks are performed during initialisation
//
// Code version 2026.05.06
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
      this.killSession(uuid, sessionID, sessionType);
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

    child?.on?.('error', (error) => {
      if (this.#sessions.get(key) === child) {
        this.#sessions.delete(key);
      }

      errorCallback?.('Failed to start ffmpeg session "' + key + '". Error was "' + String(error?.message || error) + '"');
    });

    child?.on?.('exit', () => {
      if (this.#sessions.get(key) === child) {
        this.#sessions.delete(key);
      }
    });

    for (let i = 0; i < pipeCount; i++) {
      child?.stdio?.[i]?.on?.('error', (error) => {
        if (error?.code === 'EPIPE') {
          // Empty
        }
      });
    }

    return {
      process: child,
      stdin: child.stdio[0],
      stdout: child.stdio[1],
      stderr: child.stdio[2],
      stdio: child.stdio,
      on: (...args) => child.on(...args),
      once: (...args) => child.once(...args),
      kill: (signal) => child.kill(signal),
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
