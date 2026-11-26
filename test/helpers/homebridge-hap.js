// Use Homebridge 2.x's own HAP dependency, including nested installs.
import { createRequire } from 'node:module';

let require = createRequire(import.meta.url);
let homebridgeRequire = createRequire(require.resolve('homebridge'));
export default homebridgeRequire('@homebridge/hap-nodejs');
