// macOS sign-in distribution builder
// Part of homebridge-nest-accfactory
//
// Builds an architecture-specific download with Node, the native helper and only
// the runtime inputs needed for sign-in. Release metadata belongs to this tool.
// Temporary staging is owned by this process and removed on success or failure.
//
// Code version 2026.11.28
'use strict';

/* eslint-disable no-console -- Build progress and output paths are command output. */

// Define node.js modules
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify, parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Define our modules
import { buildHelper, executable, requireNativeRuntime } from './cli.mjs';

// Define constants
const directory = fileURLToPath(new URL('.', import.meta.url));
const repository = path.resolve(directory, '../..');
const run = promisify(execFile);
const require = createRequire(import.meta.url);

// Validate version ownership before any build or release side effects. The tag,
// manifest version and exact changelog heading must describe the same release.
export function releaseMetadata(version, changelog, tag) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version,
    );
  if (match === null || match[4]?.split('.').some((part) => /^0\d+$/.test(part)) === true) {
    throw new Error('Invalid helper semantic version');
  }
  const expected = 'mac-sign-in-v' + version;
  if (tag !== undefined && tag !== expected) {
    throw new Error('Helper tag must match package.json: ' + expected);
  }

  // Match a whole version, keeping beta.1 distinct from beta.10 and excluding
  // another release's entries or trailing changelog comparison links.
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => /^## \[([^\]]+)\](?: - \d{4}-\d{2}-\d{2})?\s*$/.exec(line)?.[1] === version);
  if (start === -1) {
    throw new Error('Missing helper changelog section: ' + version);
  }
  let end = lines.findIndex((line, index) => index > start && (/^## /.test(line) || /^\[[^\]]+\]: /.test(line)));
  if (end === -1) {
    end = lines.length;
  }
  const notes = lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
  if (/^[-*] \S/m.test(notes) !== true) {
    throw new Error('Helper release notes must contain an entry');
  }

  return { version, tag: expected, prerelease: match[4] !== undefined, notes };
}

export async function buildBundle({ outputDirectory = path.join(directory, 'release'), tag } = {}) {
  if (process.platform !== 'darwin' || ['arm64', 'x64'].includes(process.arch) !== true || process.versions.node.split('.')[0] !== '24') {
    throw new Error('Distribution builds require macOS and Node.js 24 on Apple Silicon or Intel');
  }
  await requireNativeRuntime();
  const pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  const metadata = releaseMetadata(pkg.version, await fs.readFile(path.join(directory, 'CHANGELOG.md'), 'utf8'), tag);
  const destination = path.resolve(outputDirectory);
  await fs.mkdir(destination, { recursive: true });
  // Sign outside iCloud and other synchronised folders; copy only finished archives.
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'nest-sign-in-package-'));
  const name = 'Nest-Accfactory-Sign-In-' + metadata.version + '-macOS-' + process.arch;
  const bundle = path.join(staging, 'Nest Accfactory Sign-in');

  try {
    // Use an explicit input list: account files, captures, local caches and tests
    // cannot enter a download through a broad repository copy.
    const tool = path.join(bundle, 'tools/macos-sign-in');
    await fs.mkdir(tool, { recursive: true });
    for (const filename of ['cli.mjs', 'engine.mjs', 'context.json.gz', 'iosguard.proto', 'package.json']) {
      await fs.copyFile(path.join(directory, filename), path.join(tool, filename));
    }
    await fs.mkdir(path.join(bundle, 'src'));
    await fs.copyFile(path.join(repository, 'src/protobuf.js'), path.join(bundle, 'src/protobuf.js'));
    await fs.writeFile(path.join(bundle, 'package.json'), JSON.stringify({ private: true, type: 'module' }) + '\n');
    await fs.copyFile(path.join(directory, 'DOWNLOAD.txt'), path.join(bundle, 'README.txt'));
    await fs.copyFile(path.join(directory, 'CHANGELOG.md'), path.join(bundle, 'CHANGELOG.md'));
    await fs.copyFile(path.join(directory, 'Sign in.command'), path.join(bundle, 'Sign in.command'));
    await fs.chmod(path.join(bundle, 'Sign in.command'), 0o755);

    // Copy only the resolved protobuf runtime dependency graph, including each
    // package's licence files. Refuse conflicting versions in the flat bundle.
    const dependencies = new Map();
    const copyDependency = async (name, parentRequire) => {
      // Some packages export their entry point but hide package.json. Walk
      // outward from that resolved entry until its matching manifest is found.
      let current = path.dirname(await fs.realpath(parentRequire.resolve(name)));
      let filename;
      let info;
      while (info === undefined) {
        try {
          const candidate = path.join(current, 'package.json');
          const manifest = JSON.parse(await fs.readFile(candidate, 'utf8'));
          if (manifest.name === name) {
            filename = candidate;
            info = manifest;
          }
        } catch (error) {
          if (error.code !== 'ENOENT') {
            throw error;
          }
        }
        const parent = path.dirname(current);
        if (info === undefined && parent === current) {
          throw new Error('Missing runtime dependency manifest: ' + name);
        }
        current = parent;
      }
      if (dependencies.has(name) === true) {
        if (dependencies.get(name) !== info.version) {
          throw new Error('Conflicting runtime dependency: ' + name);
        }
        return;
      }
      dependencies.set(name, info.version);
      await fs.cp(path.dirname(filename), path.join(bundle, 'node_modules', name), {
        recursive: true,
        dereference: true,
        filter: (source) => path.basename(source) !== '.DS_Store' && / \d+(?:\.|$)/.test(path.basename(source)) !== true,
      });
      for (const child of Object.keys(info.dependencies ?? {})) {
        await copyDependency(child, createRequire(filename));
      }
    };
    await copyDependency('protobufjs', require);

    // Bundle the build's Node 24 runtime, keeping only this Mac's architecture.
    // Homebrew or custom binaries linked to non-system libraries are not portable.
    await fs.mkdir(path.join(bundle, 'runtime'));
    const node = path.join(bundle, 'runtime/node');
    const libraries = await run('/usr/bin/otool', ['-L', process.execPath]);
    for (const line of libraries.stdout.split('\n').filter((line) => /^\s+\S/.test(line))) {
      if (/^\s+(?:\/usr\/lib\/|\/System\/Library\/)/.test(line) !== true) {
        throw new Error('Node runtime depends on non-system libraries; use an official Node.js binary');
      }
    }
    const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
    const architectures = (await run('/usr/bin/lipo', ['-archs', process.execPath])).stdout.trim().split(/\s+/);
    if (architectures.includes(architecture) !== true) {
      throw new Error('Node runtime architecture does not match this build');
    }
    if (architectures.length > 1) {
      await run('/usr/bin/lipo', [process.execPath, '-thin', architecture, '-output', node]);
    } else {
      await fs.copyFile(process.execPath, node);
    }
    await fs.chmod(node, 0o755);

    // Official Node archives include LICENSE. Local installations may omit it;
    // retrieve the exact runtime version's licence over HTTPS in that case.
    let license;
    try {
      license = await fs.readFile(path.resolve(process.execPath, '../../LICENSE'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      const response = await fetch('https://raw.githubusercontent.com/nodejs/node/' + process.version + '/LICENSE', {
        redirect: 'error',
        signal: AbortSignal.timeout(20000),
      });
      if (response.ok !== true) {
        throw new Error('Unable to obtain the bundled Node runtime licence');
      }
      const chunks = [];
      let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 2 * 1024 * 1024) {
          throw new Error('Node runtime licence exceeds the size limit');
        }
        chunks.push(chunk);
      }
      license = Buffer.concat(chunks);
    }
    if (license.length === 0 || license.length > 2 * 1024 * 1024) {
      throw new Error('Invalid Node runtime licence');
    }
    await fs.writeFile(path.join(bundle, 'runtime/LICENSE'), license);

    // Compile once during packaging. Downloaded runs select the prebuilt path.
    await buildHelper();
    const app = path.resolve(executable, '../../..');
    const packagedApp = path.join(tool, 'mac-helper/build', path.basename(app));
    await fs.cp(app, packagedApp, { recursive: true });

    // Bundle metadata uses the numeric release core; pre-release labels remain
    // in version.json and the archive name rather than Apple's version field.
    const plistFile = path.join(packagedApp, 'Contents/Info.plist');
    const plist = await fs.readFile(plistFile, 'utf8');
    await fs.writeFile(
      plistFile,
      plist.replace(
        /(<key>CFBundleShortVersionString<\/key><string>)[^<]+(<\/string>)/,
        (_match, before, after) => before + metadata.version.split(/[-+]/)[0] + after,
      ),
    );
    await run('/usr/bin/xattr', ['-cr', bundle]);
    await run('/usr/bin/codesign', ['--force', '--sign', '-', node]);
    await run('/usr/bin/codesign', ['--force', '--sign', '-', packagedApp]);

    // Smoke-test the packaged files with their own runtime, without Xcode or a
    // Google request. This also checks relocated imports and executable modes.
    await run(path.join(bundle, 'Sign in.command'), ['--check'], { timeout: 20000, maxBuffer: 1024 * 1024 });
    await fs.writeFile(
      path.join(bundle, 'version.json'),
      JSON.stringify(
        {
          version: metadata.version,
          platform: 'darwin',
          arch: process.arch,
          node: process.version,
          dependencies: Object.fromEntries(dependencies),
        },
        null,
        2,
      ) + '\n',
    );

    // Archive with macOS permissions intact, then verify a fresh extraction.
    const archive = path.join(destination, name + '.zip');
    const stagedArchive = path.join(staging, name + '.zip');
    await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--norsrc', bundle, stagedArchive]);
    const extracted = path.join(staging, 'extracted');
    await run('/usr/bin/ditto', ['-x', '-k', stagedArchive, extracted]);
    await run(path.join(extracted, 'Nest Accfactory Sign-in/Sign in.command'), ['--check'], { timeout: 20000, maxBuffer: 1024 * 1024 });
    await fs.copyFile(stagedArchive, archive);
    const digest = crypto
      .createHash('sha256')
      .update(await fs.readFile(archive))
      .digest('hex');
    await fs.writeFile(archive + '.sha256', digest + '  ' + path.basename(archive) + '\n');

    return { archive, checksum: archive + '.sha256', ...metadata };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { metadata: { type: 'boolean' }, tag: { type: 'string' }, out: { type: 'string' } } });
  try {
    if (values.metadata === true) {
      const pkg = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
      console.log(
        JSON.stringify(releaseMetadata(pkg.version, await fs.readFile(path.join(directory, 'CHANGELOG.md'), 'utf8'), values.tag)),
      );
    } else {
      const result = await buildBundle({ outputDirectory: values.out, tag: values.tag });
      console.log('Created ' + result.archive);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
