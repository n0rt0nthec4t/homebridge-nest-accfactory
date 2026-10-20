# Contributing

## Development setup

Use Node.js 22 or 24. Node.js 26 support depends on the Homebridge version; use the compatibility ranges in `package.json` as authoritative. Preserve supported Homebridge 1.x and 2.x behaviour.

Clone the repository with its shared submodules and install dependencies:

```sh
git clone --recurse-submodules https://github.com/n0rt0nthec4t/homebridge-nest-accfactory.git
cd homebridge-nest-accfactory
npm ci
```

For an existing checkout with missing submodules, run `git submodule update --init --recursive` before installing dependencies.

## Running checks

| Command | Purpose |
| --- | --- |
| `npm test` | Run the complete automated test suite without coverage instrumentation |
| `npm run test:coverage` | Run tests with coverage gates and write `coverage/summary.json` |
| `npm run lint` | Check source and test code with ESLint |
| `npm run build` | Build the distributable files in `dist/` |
| `npm run check` | Run lint, tests with coverage gates, and the build |

Run `npm run check` before submitting a change. Generated coverage reports remain in the ignored `coverage/` directory.

Tests use Node's built-in test runner. Network, process, filesystem and clock boundaries are isolated where needed; the automated suite does not require live account credentials or camera hardware.

## Native HomeKit functionality

This project exposes device functionality through HomeKit services and characteristics that accurately represent its purpose. Standard HomeKit representations are preferred, while custom characteristics may be considered where they provide a meaningful and accurate representation of device-specific functionality. It does not aim to expose every feature available in the Nest or Google apps.

Custom characteristics must accurately represent the underlying device capability and use appropriate identifiers, data types, permissions and values.

Where no appropriate HomeKit representation exists, do not expose the functionality through an unrelated service or characteristic:

- Do not create artificial switches, outlets, lights or other unrelated services to work around missing native HomeKit functionality.
- Do not repurpose standard HomeKit characteristics or their defined values to represent unrelated device functionality.
- Making a workaround optional, configurable or disabled by default does not exempt it from this policy.

Functionality without an appropriate HomeKit representation should remain in the Nest or Google app.

This is an intentional project design constraint, not a missing feature to work around. Feature requests and pull requests must follow this policy; proposals that depend on these accessory workarounds may be rejected.

## Making changes

- Keep each fix focused on the demonstrated problem. Avoid unrelated refactoring or formatting.
- Preserve supported devices, configuration compatibility, accessory identity and Nest/Google source handling.
- Add regression tests that assert observable state, commands or lifecycle outcomes. Cover failure paths relevant to the change.
- For device controls, test both upstream updates and HomeKit writes. For camera changes, consider live streaming, HKSV recording, talkback, reconnect and asynchronous teardown.
- Follow the repository's `AGENTS.md` instructions when using coding agents.

Every production `.js` and `.mjs` module under `src/` must appear in the coverage report, including the shared submodules. New modules need tests and an explicit entry in `test/coverage-baseline.json`.

Coverage floors apply separately to lines, branches and functions in each module. Do not lower floors simply to make checks pass; raise them as verified coverage improves. The existing floors allow for runtime accounting differences. Importing a module or reaching a percentage does not establish complete behaviour coverage.

Test dependency replacements must preserve production code and its source locations. Executions through rewritten data URLs or extracted methods do not measure coverage of the original source file.

## Verification limits

Successful automated tests do not verify live Nest/Google services, physical HomeKit or Matter accessories, camera hardware, or FFmpeg hardware acceleration.

For affected behaviour, separately check native-app and HomeKit changes, offline recovery, cached accessory restoration and shutdown. Camera checks should include snapshots, live streaming, two-way audio, HKSV playback and stop/replacement races. FFmpeg verification requires version 7.1 or newer and the actual software or hardware encoder being tested.

Describe what you tested and what remains unverified. For live checks, record relevant runtime, Homebridge/HAP and FFmpeg versions, device models, source API and observed outcomes. Never include credentials, cookies or tokens in fixtures, logs or issue reports.

CI is configured to run checks with Node.js 22 and 24 against Homebridge 1.11.4 and 2.4.0, and Node.js 26 against Homebridge 2.4.0. A local pass does not establish that all CI combinations passed.

## Release notes

Record meaningful alpha and beta changes under the current version in `PRERELEASE_NOTES.md`. Entries describe that pre-release only and are not cumulative.

For a final release, consolidate meaningful outcomes into `CHANGELOG.md`. Shared modules may maintain their own code-date changelogs. Update existing source code-date metadata when changing those files, without changing unrelated package or release versions.
