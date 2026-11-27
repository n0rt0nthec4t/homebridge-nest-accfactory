// Helper release metadata regression tests
// Part of homebridge-nest-accfactory
//
// Verify version/tag ownership and exact changelog extraction without publishing,
// downloading runtimes or contacting Google.
'use strict';

// Define node.js modules
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import vm from 'node:vm';

// Define our modules
import { releaseMetadata } from '../build.mjs';
import { requireNativeRuntime, executable } from '../cli.mjs';

// Define fabricated release notes
const notes =
  '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-11-28\n\n### Added\n\n- First release.\n\n## [0.0.1]\n\n- Older release.\n';

test('native runtime guard accepts Apple Silicon without starting a translation probe', async () => {
  await requireNativeRuntime('arm64', () => assert.fail('Native ARM needs no Intel probe'));
});

test('native runtime guard rejects translated Intel Node before helper execution', async () => {
  await assert.rejects(
    requireNativeRuntime('x64', async (command, args) => {
      assert.equal(command, '/usr/bin/arch');
      assert.deepEqual(args, ['-arm64', '/usr/bin/true']);
    }),
    /Rosetta execution is not supported/,
  );
});

test('native runtime guard accepts Intel hardware but rejects inconclusive probe failures', async () => {
  await requireNativeRuntime('x64', async () => {
    throw Object.assign(new Error('CPU unavailable'), { code: 1 });
  });
  await assert.rejects(
    requireNativeRuntime('x64', async () => {
      throw Object.assign(new Error('private diagnostic'), { code: 'EACCES' });
    }),
    { message: 'Unable to verify the native Mac architecture.' },
  );
  await assert.rejects(requireNativeRuntime('unsupported'), /requires native/);
});

test(
  'cached native helper contains both CPU slices and requires native execution',
  {
    skip: process.platform !== 'darwin',
  },
  async () => {
    const run = promisify(execFile);
    const result = await run('/usr/bin/lipo', ['-archs', executable]);
    assert.deepEqual(result.stdout.trim().split(/\s+/).sort(), ['arm64', 'x86_64']);
    const plist = path.resolve(executable, '../../Info.plist');
    const setting = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :LSRequiresNativeExecution', plist]);
    assert.equal(setting.stdout.trim(), 'true');
  },
);

test('helper release requires matching manifest version, tag and exact notes', () => {
  assert.deepEqual(releaseMetadata('0.1.0', notes, 'mac-sign-in-v0.1.0'), {
    version: '0.1.0',
    tag: 'mac-sign-in-v0.1.0',
    prerelease: false,
    notes: '### Added\n\n- First release.',
  });
  assert.throws(() => releaseMetadata('0.1.0', notes, 'v0.1.0'), /must match/);
  assert.throws(() => releaseMetadata('0.1.0', notes, 'mac-sign-in-v0.2.0'), /must match/);
  assert.throws(() => releaseMetadata('0.1.1', notes), /Missing helper changelog/);
});

test('helper prerelease notes distinguish beta.1 from beta.10 and omit comparison links', () => {
  const changelog =
    '## [0.1.0-beta.10]\n\n- Later.\n\n' +
    '## [0.1.0-beta.1] - 2026-11-28\n\n### Added\n\n- Preview.\n\n' +
    '[0.1.0-beta.1]: https://example.invalid/compare\n';
  const result = releaseMetadata('0.1.0-beta.1', changelog.replace(/\n/g, '\r\n'));
  assert.equal(result.prerelease, true);
  assert.equal(result.notes, '### Added\n\n- Preview.');
});

for (const version of ['01.0.0', '0.1', '0.1.0-beta.01', '../0.1.0', '0.1.0\nprivate', '0.1.0-']) {
  test('helper rejects invalid release version ' + JSON.stringify(version), () => {
    assert.throws(() => releaseMetadata(version, notes), /semantic version/);
  });
}

test('helper refuses an empty release section', () => {
  assert.throws(() => releaseMetadata('0.1.0', '## [0.1.0]\n\n### Added\n'), /must contain an entry/);
});

test('prepared helper version has independently owned release notes', async () => {
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const result = releaseMetadata(pkg.version, await fs.readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8'));
  assert.equal(result.tag.startsWith('mac-sign-in-v'), true);
  assert.equal(pkg.private, true);
});

test('helper publishing admits only its own pushed version tags', async () => {
  const workflow = await fs.readFile(new URL('../../../.github/workflows/macos-sign-in.yml', import.meta.url), 'utf8');
  const expression = /\n  release:\n    if: ([^\n]+)/.exec(workflow)?.[1];
  assert.equal(typeof expression, 'string');
  for (const [event_name, ref, expected] of [
    ['push', 'refs/heads/main', false],
    ['workflow_dispatch', 'refs/tags/mac-sign-in-v0.1.0', false],
    ['pull_request', 'refs/pull/1/merge', false],
    ['push', 'refs/tags/v1.0.0', false],
    ['push', 'refs/tags/other-tool-v0.1.0', false],
    ['push', 'refs/tags/mac-sign-in-v0.1.0', true],
    ['push', 'refs/tags/mac-sign-in-v0.2.0-beta.1', true],
  ]) {
    const result = vm.runInNewContext(
      expression,
      {
        github: { event_name, ref },
        startsWith: (value, prefix) => value.toLowerCase().startsWith(prefix.toLowerCase()),
      },
      { timeout: 1000 },
    );
    assert.equal(result, expected, event_name + ': ' + ref);
  }
});

test('prebuilt execution does not fall back to compilation when the helper is absent', async (t) => {
  // Copy the CLI beside its unchanged engine imports, then remove that private
  // copy on teardown. --prebuilt must fail before any network or compiler use.
  const folder = await fs.mkdtemp(new URL('../.missing-helper-', import.meta.url));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const source = await fs.readFile(new URL('../cli.mjs', import.meta.url), 'utf8');
  await fs.writeFile(folder + '/cli.mjs', source.replace('from \'./engine.mjs\'', 'from \'../engine.mjs\''));
  await assert.rejects(promisify(execFile)(process.execPath, [folder + '/cli.mjs', '--prebuilt', '--check']), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /native helper is missing/);
    assert.equal(error.stdout.includes('Building'), false);
    return true;
  });
});
