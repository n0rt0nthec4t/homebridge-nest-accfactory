// Use the HAP dependency owned by the installed Homebridge version, including nested installs.
// Homebridge 1.x uses hap-nodejs; Homebridge 2.x uses @homebridge/hap-nodejs.
import { createRequire } from 'node:module';

let require = createRequire(import.meta.url);
let homebridgeRequire = createRequire(require.resolve('homebridge'));
let hapPath;
try {
  hapPath = homebridgeRequire.resolve('@homebridge/hap-nodejs');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') {
    throw error;
  }
  hapPath = homebridgeRequire.resolve('hap-nodejs');
}

export default homebridgeRequire(hapPath);
