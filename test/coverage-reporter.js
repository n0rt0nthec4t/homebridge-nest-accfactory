// Coverage scope reporter for the plugin's source test suite.
// Require every production module to be measured, retain per-module coverage floors,
// and write a portable summary for review and CI artifacts.
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

// Measurements and minimums are keyed by repository-relative source path.
// Each entry has numeric lines, branches and functions percentages.
export function coverageFailures(files, measurements, minimums) {
  let failures = [];
  for (let file of files) {
    let measured = measurements[file];
    let minimum = minimums[file];
    if (measured === undefined) {
      failures.push(file + ': absent from coverage');
      continue;
    }
    if (minimum === undefined) {
      failures.push(file + ': missing reviewed coverage floor');
      continue;
    }
    for (let metric of ['lines', 'branches', 'functions']) {
      if (Number.isFinite(minimum[metric]) !== true || minimum[metric] < 0 || minimum[metric] > 100) {
        failures.push(file + ': invalid ' + metric + ' coverage floor');
        continue;
      }
      if (Number.isFinite(measured[metric]) !== true || measured[metric] < minimum[metric]) {
        failures.push(file + ': ' + metric + ' ' + measured[metric] + '% is below ' + minimum[metric] + '%');
      }
    }
  }
  return failures;
}

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
    let measurements = Object.fromEntries(
      event.data.summary.files.map((file) => [
        path.relative(root, file.path),
        { lines: file.coveredLinePercent, branches: file.coveredBranchPercent, functions: file.coveredFunctionPercent },
      ]),
    );
    let output = path.join(root, 'coverage');
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, 'summary.json'), JSON.stringify({ measurements, omitted }, null, 2) + '\n');
    yield '\nCoverage scope: ' + (files.length - omitted.length) + '/' + files.length + ' production source modules measured.\n';
    yield 'Percentages describe loaded file-backed source only; omitted modules are excluded from the aggregate.\n';
    yield 'Data-URL imports and extracted methods may be tested without measuring their original source files.\n';
    if (omitted.length > 0) {
      yield 'Production modules absent from coverage:\n' + omitted.map((file) => '  ' + file).join('\n') + '\n';
    }
    let minimums = JSON.parse(await readFile(new URL('./coverage-baseline.json', import.meta.url), 'utf8'));
    let failures = coverageFailures(files, measurements, minimums);
    if (failures.length > 0) {
      process.exitCode = 1;
      yield 'Coverage gate failed:\n' + failures.map((failure) => '  ' + failure).join('\n') + '\n';
    } else {
      yield 'Coverage gate passed for every production module. Summary: coverage/summary.json\n';
    }
  }
}
