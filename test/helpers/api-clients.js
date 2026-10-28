// Real protocol request handlers with an isolated HTTP boundary for command/query tests.
import { readFile } from 'node:fs/promises';
import { importSource } from './import-source.js';
let boundary =
  'data:text/javascript,' +
  encodeURIComponent(
    'export const network = {}; export function fetchWrapper(...args) { return network.fetch(...args); }' +
      'fetchWrapper.GET = "get"; fetchWrapper.POST = "post";',
  );
let { network } = await import(boundary);
let classes = {};
for (let name of ['nest', 'google']) {
  let location = new URL('../../src/api/' + name + '.js', import.meta.url);
  let source = (await readFile(location, 'utf8')).replace('from \'../fetchWrapper.js\'', 'from ' + JSON.stringify(boundary));
  classes[name] = (await importSource(location, source)).default;
}
export function attachAPIClients(connection, raw, fetch, log = undefined) {
  network.fetch = fetch;
  let options = { account: connection, log, getResource: (id) => raw[id] };
  connection.nestAPI = new classes.nest(options);
  connection.googleAPI = new classes.google({
    ...options,
  });
}
