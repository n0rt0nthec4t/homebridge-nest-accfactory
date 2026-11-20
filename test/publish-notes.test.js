// Run the publish workflow's actual extraction script against isolated Markdown fixtures.
// No publishing, git mutation or network requests are performed.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

let workflow = readFileSync(new URL('../.github/workflows/npm-publish.yml', import.meta.url), 'utf8');
let step = workflow.slice(workflow.indexOf('      - name: Extract release notes'));
let script = /          node <<'NODE'\n([\s\S]*?)\n          NODE/.exec(step)?.[1].replace(/^ {10}/gm, '');
assert.equal(typeof script, 'string', 'the workflow must retain a testable release-note extraction step');

function extract(context, version, prerelease, files) {
  let directory = mkdtempSync(path.join(tmpdir(), 'publish-notes-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  for (let [filename, content] of Object.entries(files)) {
    writeFileSync(path.join(directory, filename), content);
  }
  let result = spawnSync(process.execPath, ['-'], {
    cwd: directory,
    input: script,
    encoding: 'utf8',
    env: { ...process.env, VERSION: version, IS_PRERELEASE: String(prerelease) },
  });
  let output = path.join(directory, 'RELEASE_NOTES.md');
  return { ...result, body: existsSync(output) === true ? readFileSync(output, 'utf8') : undefined };
}

for (let prerelease of [true, false]) {
  for (let format of ['linked', 'legacy', 'legacy dated']) {
    test('publish notes select the exact ' + format + ' version; prerelease=' + prerelease, (context) => {
      let version = prerelease === true ? '1.0.0-beta.1' : '1.0.0';
      let neighbour = prerelease === true ? '1.0.0-beta.10' : '1.0.10';
      let heading = (value) =>
        format === 'linked' ? '## [' + value + '] - 2026-11-20' : '## v' + value + (format === 'legacy dated' ? ' (2026/11/20)' : '');
      let content =
        '# Notes\n\n[' +
        version +
        ']: https://example.invalid/release\n\n## [Unreleased]\n\n- Future change\n\n' +
        heading(neighbour) +
        '\n\n- Different version\n\n' +
        heading(version) +
        '\n\n### Fixed\n\n- Selected change\n\n' +
        '## v0.9.0\n\n- Older change\n';
      let filename = prerelease === true ? 'PRERELEASE_NOTES.md' : 'CHANGELOG.md';
      let other = prerelease === true ? 'CHANGELOG.md' : 'PRERELEASE_NOTES.md';
      let result = extract(context, version, prerelease, { [filename]: content.replaceAll('\n', '\r\n'), [other]: 'Wrong file' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.body, '### Fixed\n\n- Selected change\n');
    });
  }
}

for (let level of ['##', '###']) {
  for (let heading of ['## [1.0.0] - 2026-11-20', '## v1.0.0 (2026/11/20)']) {
    test('stable notes append global issues at ' + level + ' before ' + heading, (context) => {
      let result = extract(context, '1.0.0', false, {
        'CHANGELOG.md':
          '# Changelog\n\n' +
          level +
          ' Known Issues\n\n- Global issue\n\n## [Unreleased]\n\n### Known Issues\n\n- Future issue\n\n' +
          heading +
          '\n\n- Current change\n\n## v0.9.0\n\n### Known Issues\n\n- Historical issue\n',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.body, '- Current change\n\n### Known Issues\n\n- Global issue\n');
    });
  }
}

test('stable release-specific issues take precedence over global issues', (context) => {
  let result = extract(context, '1.0.0', false, {
    'CHANGELOG.md':
      '## Known Issues\n\n- Global issue\n\n## [1.0.0] - 2026-11-20\n\n### Fixed\n\n- Change\n\n### Known Issues\n\n- Specific issue\n',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.body, '### Fixed\n\n- Change\n\n### Known Issues\n\n- Specific issue\n');
});

for (let [label, content, error] of [
  ['missing', '## [1.0.0-beta.10] - 2026-11-20\n\n- Other version\n', 'Missing release notes section'],
  ['empty', '## [1.0.0-beta.1] - 2026-11-20\n\n## v0.9.0\n\n- Older change\n', 'Empty release notes section'],
  ['withdrawn', '## [1.0.0-beta.1] - 2026-11-20 [YANKED]\n\n- Withdrawn change\n', 'Cannot publish a withdrawn release'],
]) {
  test('publish notes reject a ' + label + ' release before writing output', (context) => {
    let result = extract(context, '1.0.0-beta.1', true, { 'PRERELEASE_NOTES.md': content });
    assert.notEqual(result.status, 0);
    assert.equal(result.stderr.includes(error), true);
    assert.equal(result.body, undefined);
  });
}

for (let [version, prerelease, filename] of [
  ['1.0.0-beta.1', true, 'PRERELEASE_NOTES.md'],
  ['0.4.4', false, 'CHANGELOG.md'],
]) {
  test('publish notes extract the repository entry for ' + version, (context) => {
    let result = extract(context, version, prerelease, {
      [filename]: readFileSync(new URL('../' + filename, import.meta.url), 'utf8'),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(/^###\s+\S/m.test(result.body), true);
    assert.equal(/^##\s/m.test(result.body), false, 'another release or Unreleased section must not leak into the body');
    assert.equal(result.body.includes('### Known Issues'), prerelease === false);
  });
}
