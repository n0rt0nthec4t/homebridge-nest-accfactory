// Remove only the repository's generated distributable, regardless of the working directory.
import { rmSync } from 'node:fs';

rmSync(new URL('../dist/', import.meta.url), { recursive: true, force: true });
