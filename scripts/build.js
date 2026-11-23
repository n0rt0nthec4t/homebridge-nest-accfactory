// Copy the distributable, including API classes and nested camera modules, preserving resource paths
// and flattening the shared HomeKit modules.
import { copyFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCOUNT_TYPE } from '../src/consts.js';

let root = fileURLToPath(new URL('../', import.meta.url));
for (let [source, target, extensions, recursive] of [
  ['src', 'dist', ['.js'], false],
  ['src/res', 'dist/res', ['.h264', '.jpg'], false],
  ['src/protobuf', 'dist/protobuf', ['.proto'], true],
  ['src/api', 'dist/api', ['.js'], true],
  ['src/plugins', 'dist/plugins', ['.js', '.mjs'], true],
]) {
  for (let name of readdirSync(join(root, source), { recursive })) {
    let sourceFile = join(root, source, name);
    if (extensions.includes(extname(name)) === false || statSync(sourceFile).isFile() === false) {
      continue;
    }
    let targetFile = join(root, target, name);
    mkdirSync(dirname(targetFile), { recursive: true });
    copyFileSync(sourceFile, targetFile);
  }
}

// Shared modules are published alongside the platform entry point, without their tests or changelogs.
for (let name of ['HomeKitDevice', 'HomeKitHistory', 'fetchWrapper']) {
  copyFileSync(join(root, 'src', name, name + '.js'), join(root, 'dist', name + '.js'));
}

// Keep the browser's account types generated from the runtime source of truth.
writeFileSync(
  join(root, 'homebridge-ui/public/constants.js'),
  '// Generated from src/consts.js by scripts/build.js. Do not edit directly.\n' +
    'const ACCOUNT_TYPE = {\n' +
    Object.entries(ACCOUNT_TYPE)
      .map(([key, value]) => '  ' + key + ': \'' + value + '\',')
      .join('\n') +
    '\n};\n\nexport { ACCOUNT_TYPE };\n',
);
