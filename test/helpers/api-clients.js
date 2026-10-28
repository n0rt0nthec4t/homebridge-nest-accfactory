// Real protocol request handlers with an isolated HTTP boundary for command/query tests.
import { readFile } from 'node:fs/promises';
import { importSource } from './import-source.js';
let boundary =
  'data:text/javascript,' +
  encodeURIComponent(
    'export const network = {}; export function fetchWrapper(...args) { return network.fetch(...args); }' +
      'fetchWrapper.GET = "get"; fetchWrapper.POST = "post"; export function getProtoTypes() { return []; }' +
      'export default class Transport { constructor() { return network.transport; } }',
  );
let { network } = await import(boundary);
let classes = {};
for (let name of ['nest', 'google']) {
  let location = new URL('../../src/api/' + name + '.js', import.meta.url);
  let source = (await readFile(location, 'utf8')).replace(
    /from '(\.\.\/(?:fetchWrapper|grpctransport|protobuf)\.js)'/g,
    'from ' + JSON.stringify(boundary),
  );
  classes[name] = (await importSource(location, source)).default;
}
export function attachAPIClients(connection, raw, fetch, log = undefined) {
  network.fetch = fetch;
  let options = { session: { account: connection, connect: () => connection.authorised, on() {} }, log };
  network.transport = connection.grpcTransport;
  connection.nestAPI = new classes.nest(options);
  connection.googleAPI = new classes.google({
    ...options,
  });
  let connecting = undefined;
  // Supply protocol fixtures through the API-owned store. No System callbacks
  // or production cache injection options are needed by the command boundary.
  for (let api of [connection.nestAPI, connection.googleAPI]) {
    for (let method of ['get', 'set']) {
      let request = api[method].bind(api);
      api[method] = (...args) => {
        for (let [id, resource] of Object.entries(raw)) {
          api.resources.set(id, resource);
        }
        return api === connection.googleAPI && connecting !== undefined ? connecting.then(() => request(...args)) : request(...args);
      };
    }
  }
  if (connection.grpcTransport !== undefined && connection.authorised === true) {
    connecting = connection.googleAPI.connect();
  }
}
