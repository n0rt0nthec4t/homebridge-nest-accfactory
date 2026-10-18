// Test-only ESM loader: preserve source URLs and resolve the shared modules flattened by the build.
let target;
let replacements;
let shared = new Map(
  ['HomeKitDevice', 'HomeKitHistory', 'fetchWrapper'].map((name) => [
    new URL('../../src/' + name + '.js', import.meta.url).href,
    new URL('../../src/' + name + '/' + name + '.js', import.meta.url).href,
  ]),
);

export function initialize(options) {
  target = options.target;
  replacements = new Map(options.replacements);
}

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL === target && replacements.has(specifier) === true) {
    specifier = replacements.get(specifier);
  }
  let resolved =
    specifier.startsWith('.') === true && context.parentURL?.startsWith('file:') === true
      ? new URL(specifier, context.parentURL).href
      : specifier;
  return nextResolve(shared.get(resolved) ?? specifier, context);
}
