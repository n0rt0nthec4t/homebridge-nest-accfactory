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

## Project scope

This project develops and maintains Nest and Google device integration with HomeKit through Homebridge.

Contributions should focus on functionality, compatibility and improvements relevant to that integration.

Integration with third-party platforms is outside the scope of this project. Changes requested solely to accommodate those platforms will not be accepted.

## Provenance and attribution

Preserve source attribution, copyright notices, and applicable licence notices when contributing or reusing code. Identify the source of adapted code and distinguish inherited implementation from original additions. Independent maintenance, renaming, or extending a project does not by itself establish independent development of its underlying implementation.

Describe provenance accurately and support disputed authorship claims with specific source or history evidence. Credit both upstream work and original contributions made in forks.

## Security

Design security into the implementation. Enforce account and device boundaries, validate inputs at trust boundaries, minimise credential exposure, and ensure failure and recovery paths preserve those protections. Use regression tests to verify the affected behaviour.

Code must not emit credentials, OAuth tokens, cookies, authorisation headers, or credential-bearing URLs in logs or support dumps, including debug output and error paths. Use fabricated credentials in tests.

Use redacted examples in issues and pull requests. Before sharing logs, support dumps, screenshots, or fixtures, check for and remove secrets and private account or device details. This review is an additional safeguard, not a substitute for preventing secret disclosure in code.

If you suspect a vulnerability, use GitHub private vulnerability reporting if enabled, or an established private maintainer contact. If neither route is available, use a public issue only to ask for a private way to get in touch, keeping vulnerability details out of the issue.

Preserve TLS certificate validation and account and device boundaries. For changes to authentication, session refresh, device routing, or diagnostics, include regression coverage for the affected failure paths. For a dependency security update, identify the affected package and verify the resolved version in the lockfile, including affected transitive dependencies.

## Native HomeKit functionality

This project exposes device functionality through HomeKit services and characteristics that accurately represent its purpose. Standard HomeKit representations are preferred, while custom characteristics may be considered where they provide a meaningful and accurate representation of device-specific functionality. It does not aim to expose every feature available in the Nest or Google apps.

Custom characteristics must accurately represent the underlying device capability and use appropriate identifiers, data types, permissions and values.

New plugin-owned custom HomeKit types use UUID v5 with the permanent project
namespace `FBDB87BD-3DCF-5B78-9699-80FA1610AEA1`, stored privately in `src/consts.js`.
It was generated once from `uuidv5('homebridge-nest-accfactory', uuidv5.DNS)`.
Keep the stored namespace unchanged even if the project is renamed.

Derive each type UUID from a permanent, case-sensitive identifier such as
`characteristic.replace-by-date`. Use `characteristic.` for characteristic types
and `service.` for service types, keeping their identities separate. Display
names, device identifiers and translated text must not be used as generation
inputs. Renaming a generation identifier changes its UUID, so keep identifiers
and their meaning permanent even when a type is renamed for display or retired.

Record built-in characteristic UUIDs in `CUSTOM_CHARACTERISTIC_UUID` in
`src/consts.js`. For example, an entry in that registry is:

```js
REPLACE_BY_DATE: uuidv5('characteristic.replace-by-date', CUSTOM_UUID_NAMESPACE).toUpperCase(),
```

Device plugins import `CUSTOM_CHARACTERISTIC_UUID` and use the corresponding
property, such as `CUSTOM_CHARACTERISTIC_UUID.REPLACE_BY_DATE`; individual
characteristic UUIDs are not separate named exports. If plugin-owned custom
services are introduced, register their `service.*` UUIDs in a separate
`CUSTOM_SERVICE_UUID` object in `src/consts.js`, using the same permanent namespace.
No custom service registry is currently defined.

The catalogue below documents existing types; numeric allocation is unnecessary.
Retain retired entries and identifiers to prevent their reuse. Independent
third-party addons must define their own permanent namespace unless their type
is explicitly included in this project. Existing Apple, Eve and other established
third-party UUIDs retain their original identifiers. HomeKitDevice accepts supplied
UUIDs and does not generate project-specific identities.

| Permanent identifier | Registry name | UUID | Purpose | Status |
| --- | --- | --- | --- | --- |
| `characteristic.replace-by-date` | `REPLACE_BY_DATE` | `391ED041-9783-577A-81EB-4B6BFEE97869` | Reported device replacement date, exposed as a read-only local date string | Active |
| `characteristic.eco-mode` | `ECO_MODE` | `3EA35F7F-3CB1-5991-84B7-00B36A8CF698` | Boolean thermostat Eco control; On enables manual Eco, Off disables Eco | Active |

Where no appropriate HomeKit representation exists, do not expose the functionality through an unrelated service or characteristic:

- Do not create artificial switches, outlets, lights or other unrelated services to work around missing native HomeKit functionality.
- Do not repurpose standard HomeKit characteristics or their defined values to represent unrelated device functionality.
- Making a workaround optional, configurable or disabled by default does not exempt it from this policy.

Functionality without an appropriate HomeKit representation should remain in the Nest or Google app.

This is an intentional project design constraint, not a missing feature to work around. Feature requests and pull requests must follow this policy. Proposals that conflict with these guidelines may be rejected.

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

Choose verification that covers the affected behaviour, including native-app and HomeKit changes, offline recovery, cached accessory restoration and shutdown where relevant. For camera changes, exercise the affected paths among snapshots, live streaming, two-way audio, HKSV playback and stop/replacement races. Identify relevant hardware checks that could not be run rather than treating every camera change as requiring the full hardware checklist. FFmpeg verification must meet the minimum declared by `FFMPEG_VERSION` in `src/consts.js` and exercise the actual software or hardware encoder being tested.

Describe what you tested and what remains unverified. For live checks, record relevant runtime, Homebridge/HAP and FFmpeg versions, device models, source API and observed outcomes. Never include credentials, cookies or tokens in fixtures, logs or issue reports.

CI is configured to run checks with Node.js 22 and 24 against Homebridge 1.11.4 and 2.5.0, and Node.js 26 against Homebridge 2.5.0. See `.github/workflows/test.yml` for the configured matrix and `package.json` for the declared compatibility ranges. A local pass does not establish that all CI combinations passed.

## Release notes

Record meaningful alpha and beta changes under the current version in `PRERELEASE_NOTES.md`. Entries describe that pre-release only and are not cumulative.

For a final release, consolidate meaningful outcomes into `CHANGELOG.md`. Shared modules may maintain their own code-date changelogs. Update existing source code-date metadata when changing those files, without changing unrelated package or release versions.
