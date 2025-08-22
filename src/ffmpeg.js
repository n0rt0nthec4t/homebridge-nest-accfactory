// FFmpeg manager for binary probing + session tracking
// Part of homebridge-nest-accfactory
//
// Code version 2025.08.11
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

    if ((binaryPath.trim() ?? '') !== '') {
      // If path starts with '~' expand to user home directory
      binaryPath = binaryPath.trim();
      if (binaryPath.startsWith('~') === true) {
        binaryPath = path.join(os.homedir(), binaryPath.slice(1));
      }

      let resolved = path.resolve(binaryPath);
      if (resolved.endsWith('/ffmpeg') === false) {
        resolved += '/ffmpeg';
      }
      this.#binary = resolved;
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
    let match = stdout.match(/^ffmpeg version ([^\s]+)/);
    if (match !== null) {
      this.#version = match[1];
    }

    // Parse --enable-xxx flags from build config
    let enabledLibs = stdout.match(/--enable-[^\s]+/g) || [];
    this.#features.enabled = enabledLibs.map((f) => f.replace('--enable-', ''));

    // Parse encoders (for HW accel + audio)
    let encodersOutput = child_process.spawnSync(this.#binary, ['-encoders'], { env: process.env });
    if (encodersOutput?.stdout !== null && encodersOutput.status === 0) {
      let encoders = String(encodersOutput.stdout);
      this.#features.encoders = [];
      for (let line of encoders.split('\n')) {
        let match = line.match(/^\s*[A-Z.]+\s+([^\s]+)/);
        if (match !== null) {
          this.#features.encoders.push(match[1]);
        }
      }

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

    // Parse decoders
    let decoderOutput = child_process.spawnSync(this.#binary, ['-decoders'], { env: process.env });
    if (decoderOutput?.stdout !== null && decoderOutput.status === 0) {
      this.#features.decoders = [];
      let lines = String(decoderOutput.stdout).split('\n');
      for (let line of lines) {
        let match = line.match(/^\s*[A-Z.]+\s+([^\s]+)/);
        if (match !== null) {
          this.#features.decoders.push(match[1]);
        }
      }
    }

    // Parse muxers
    let muxerOutput = child_process.spawnSync(this.#binary, ['-muxers'], { env: process.env });
    if (muxerOutput?.stdout !== null && muxerOutput.status === 0) {
      this.#features.muxers = [];
      let lines = String(muxerOutput.stdout).split('\n');
      for (let line of lines) {
        let match = line.match(/^\s*[E][A-Z.]*\s+([^\s]+)/);
        if (match !== null) {
          this.#features.muxers.push(match[1]);
        }
      }
    }

    // Parse demuxers
    let demuxerOutput = child_process.spawnSync(this.#binary, ['-demuxers'], { env: process.env });
    if (demuxerOutput?.stdout !== null && demuxerOutput.status === 0) {
      this.#features.demuxers = [];
      let lines = String(demuxerOutput.stdout).split('\n');
      for (let line of lines) {
        let match = line.match(/^\s*[D][A-Z.]*\s+([^\s]+)/);
        if (match !== null) {
          this.#features.demuxers.push(match[1]);
        }
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

    let encoders = this.#features.encoders || [];
    let decoders = this.#features.decoders || [];
    let muxers = this.#features.muxers || [];

    if (Array.isArray(min?.encoders) === true) {
      for (let encoder of min.encoders) {
        if (encoders.includes(encoder) === false) {
          return false;
        }
      }
    }

    if (Array.isArray(min?.decoders) === true) {
      for (let decoder of min.decoders) {
        if (decoders.includes(decoder) === false) {
          return false;
        }
      }
    }

    if (Array.isArray(min?.muxers) === true) {
      for (let muxer of min.muxers) {
        if (muxers.includes(muxer) === false) {
          return false;
        }
      }
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
