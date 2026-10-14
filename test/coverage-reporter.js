// Coverage scope reporter for the plugin's source test suite.
// Lists production modules omitted by Node's loaded-file coverage report so
// dynamically imported or extracted test code cannot imply whole-project coverage.
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

/**
 * Supplement the standard test reporter with a production-source inventory.
 * @param {AsyncIterable<{type: string, data: {summary?: {files: {path: string}[]}}}>} events Test runner events.
 * @returns {AsyncGenerator<string>} Coverage scope and modules absent from file-backed measurements.
 */
export default async function* coverageScope(events) {
  for await (let event of events) {
    if (event.type !== 'test:coverage') {
      continue;
    }
    let root = fileURLToPath(new URL('../', import.meta.url));
    let files = (await readdir(path.join(root, 'src'), { recursive: true }))
      .filter(
        (file) => /\.(?:js|mjs)$/.test(file) === true && file.endsWith('.test.js') === false && path.basename(file) !== 'eslint.config.js',
      )
      .map((file) => path.join('src', file))
      .sort();
    let measured = new Set(event.data.summary.files.map((file) => path.relative(root, file.path)));
    let omitted = files.filter((file) => measured.has(file) === false);
    yield '\nCoverage scope: ' + (files.length - omitted.length) + '/' + files.length + ' production source modules measured.\n';
    yield 'Percentages describe loaded file-backed source only; omitted modules are excluded from the aggregate.\n';
    yield 'Data-URL imports and extracted methods may be tested without measuring their original source files.\n';
    if (omitted.length > 0) {
      yield 'Production modules absent from coverage:\n' + omitted.map((file) => '  ' + file).join('\n') + '\n';
    }
  }
}
