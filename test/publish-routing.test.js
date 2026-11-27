// Verify the npm workflow's actual release guards using fabricated GitHub events.
// Conditions use the JavaScript-compatible subset of GitHub expressions, with
// startsWith matching GitHub's case-insensitive string semantics.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const workflow = readFileSync(new URL('../.github/workflows/npm-publish.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const jobs = [...workflow.matchAll(/^  ([\w-]+):\n/gm)].filter((entry) => entry.index > workflow.indexOf('\njobs:\n'));
const startsWith = (value, prefix) =>
  String(value ?? '')
    .toLowerCase()
    .startsWith(prefix.toLowerCase());

for (const [label, event, expected] of [
  ['plugin prerelease push', { event_name: 'push' }, true],
  ['stable plugin release', { event_name: 'release', event: { release: { tag_name: 'v1.2.3', prerelease: false } } }, true],
  ['plugin prerelease event', { event_name: 'release', event: { release: { tag_name: 'v1.2.3-beta.1', prerelease: true } } }, false],
  ['stable helper release', { event_name: 'release', event: { release: { tag_name: 'mac-sign-in-v0.1.0', prerelease: false } } }, false],
  ['helper prerelease', { event_name: 'release', event: { release: { tag_name: 'mac-sign-in-v0.1.0-beta.1', prerelease: true } } }, false],
  ['another tool release', { event_name: 'release', event: { release: { tag_name: 'other-tool-v2.0.0', prerelease: false } } }, false],
  ['unrelated event', { event_name: 'workflow_dispatch' }, false],
]) {
  test('npm jobs route ' + label, () => {
    assert.equal(jobs.length, 3);
    for (const [index, job] of jobs.entries()) {
      const section = workflow.slice(job.index, jobs[index + 1]?.index ?? workflow.length);
      const condition = /^    if: (.+)$/m.exec(section)?.[1];
      assert.equal(typeof condition, 'string', job[1] + ' must guard release ownership');
      assert.equal(vm.runInNewContext(condition, { github: event, startsWith }, { timeout: 1000 }), expected, job[1]);
    }
  });
}

test('helper releases cannot enter the plugin publishing concurrency queue', () => {
  const group = /^  group: (.+)$/m.exec(workflow)?.[1];
  assert.equal(typeof group, 'string');
  const key = (event_name, tag_name) =>
    group.replace(/\$\{\{ (.*?) \}\}/g, (_match, expression) =>
      vm.runInNewContext(
        expression,
        {
          github: { repository: 'fixture/plugin', event_name, event: { release: { tag_name } } },
          startsWith,
        },
        { timeout: 1000 },
      ),
    );
  assert.equal(key('push'), 'npm-publish-fixture/plugin');
  assert.equal(key('release', 'v1.2.3'), key('push'));
  assert.notEqual(key('release', 'mac-sign-in-v0.1.0'), key('push'));
});

test('npm push publishing watches plugin release files rather than helper files', () => {
  const paths = workflow.split('    paths:\n')[1]?.split('  release:')[0];
  assert.equal(typeof paths, 'string');
  assert.deepEqual(
    [...paths.matchAll(/^      - (.+)$/gm)].map((entry) => entry[1]),
    ['package.json', 'package-lock.json', 'CHANGELOG.md', 'PRERELEASE_NOTES.md'],
  );
});
