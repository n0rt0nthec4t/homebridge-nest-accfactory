// Load production modules at their real file URLs so Node can measure coverage.
// Redirect imports only: coverage offsets must describe the unchanged production source.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { register } from 'node:module';

export async function importSource(location, source = undefined) {
  let replacements = [];
  if (source !== undefined) {
    let original = await readFile(location, 'utf8');
    let pattern = /from ('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/g;
    let imports = [...original.matchAll(pattern)];
    let redirects = [...source.matchAll(pattern)];
    assert.equal(
      original.replace(pattern, 'from "dependency"'),
      source.replace(pattern, 'from "dependency"'),
      'File-backed coverage requires unchanged production code outside import specifiers',
    );
    replacements = imports.map((match, index) => [
      match[1].slice(1, -1),
      redirects[index][1].startsWith('"') === true ? JSON.parse(redirects[index][1]) : redirects[index][1].slice(1, -1),
    ]);
  }
  register('./source-loader.js', import.meta.url, { data: { target: location.href, replacements } });
  return import(location.href);
}
