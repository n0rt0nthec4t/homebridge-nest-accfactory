// Exercise the publish workflow's actual note extractor against isolated Markdown fixtures.
// No publishing, repository mutations or network requests are performed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/npm-publish.yml', import.meta.url), 'utf8');
function extract(context, content, version, prerelease = true, workflowText = workflow) {
  // Git checkouts can use CRLF on Windows; normalise before locating the workflow heredoc.
  const normalised = workflowText.replace(/\r\n/g, '\n');
  const extraction = normalised.slice(normalised.indexOf('      - name: Extract release notes'));
  const script = /          node <<'NODE'\n([\s\S]*?)\n          NODE/.exec(extraction)?.[1].replace(/^ {10}/gm, '');
  assert.equal(typeof script, 'string');
  const directory = mkdtempSync(path.join(os.tmpdir(), 'nest-release-notes-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path.join(directory, prerelease === true ? 'PRERELEASE_NOTES.md' : 'CHANGELOG.md'), content);
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: directory,
    env: { ...process.env, VERSION: version, IS_PRERELEASE: String(prerelease) },
    encoding: 'utf8',
    timeout: 5000,
  });
  return { ...result, read: () => readFileSync(path.join(directory, 'RELEASE_NOTES.md'), 'utf8') };
}
for (const [label, newline] of [
  ['LF', '\n'],
  ['CRLF', '\r\n'],
]) {
  test('release extraction handles ' + label + ' workflow and changelog line endings', (context) => {
    const content = ['## [1.2.3-beta.1] - 2026-11-23', '', '### Fixed', '', '- Intended change', ''].join(newline);
    const result = extract(context, content, '1.2.3-beta.1', true, workflow.replace(/\r?\n/g, newline));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.read(), '### Fixed\n\n- Intended change\n');
  });
}

for (const heading of [
  '## [1.2.3-beta.1] - 2026-11-23',
  '## v1.2.3-beta.1 (2026/11/23)',
  '## [1.2.3-beta.1]',
  '## [1.2.3-beta.1] - 2026-11-23 [YANKED]',
]) {
  test('release extraction accepts ' + heading, (context) => {
    const result = extract(
      context,
      '## [Unreleased]\n\n### Added\n\n- Future change\n\n' +
        heading +
        '\n\n### Fixed\n\n- Intended change\n\n## [1.2.3-beta.0] - 2026-11-22\n\n- Older change\n',
      '1.2.3-beta.1',
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.read(), '### Fixed\n\n- Intended change\n');
  });
}
for (const heading of ['## v1.2.3 (2026/11/23)', '## [1.2.3] - 2026-11-23']) {
  test('stable release extraction retains only global known issues: ' + heading, (context) => {
    const result = extract(
      context,
      '# Changelog\n\n### Known Issues\n\n- Current limitation\n\n' +
        heading +
        '\n\n### Fixed\n\n- Stable fix\n\n## v1.2.2 (2026/11/22)\n\n### Known Issues\n\n- Historical limitation\n',
      '1.2.3',
      false,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.read(), '### Fixed\n\n- Stable fix\n\n### Known Issues\n\n- Current limitation\n');
  });
}
test('version references at the end of the last release are excluded from generated notes', (context) => {
  const result = extract(
    context,
    '## [1.2.3-beta.1] - 2026-11-23\n\n### Changed\n\n- Last release\n\n' +
      '[Unreleased]: https://example.invalid/compare\n[1.2.3-beta.1]: https://example.invalid/tag\n',
    '1.2.3-beta.1',
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.read(), '### Changed\n\n- Last release\n');
});
for (const content of ['## [1.2.3-beta.10] - 2026-11-23\n\n- Different version\n', '## [1.2.3-beta.1] - 2026-11-23\n']) {
  test('release extraction rejects missing or empty exact-version notes: ' + content.trim(), (context) => {
    const result = extract(context, content, '1.2.3-beta.1');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing release notes section|Empty release notes section/);
  });
}
const notes = readFileSync(new URL('../PRERELEASE_NOTES.md', import.meta.url), 'utf8');
for (const match of notes.matchAll(/^## \[([^\]]+)\]/gm)) {
  const version = match[1];
  if (version === 'Unreleased') {
    continue;
  }
  test('publish workflow extracts the recorded pre-release ' + version, (context) => {
    const result = extract(context, notes, version);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.read(), /^## |^\[(?:Unreleased|\d)/m);
  });
}
