# homebridge-nest-accfactory — Agent Instructions

Apply the `core-engineering-principles` skill to all code changes, reviews, refactors, and bug fixes in this repository.

These project instructions take precedence where they narrow or override a general rule from the skill.

## Project

`homebridge-nest-accfactory` provides HomeKit integration for Nest and Google Home devices through Homebridge.

Supported devices include cameras, doorbells, floodlight cameras, thermostats, Heat Links, Nest Protect, temperature sensors, Nest × Yale locks, weather accessories, and Home/Away accessories.

Preserve existing device support and compatibility unless the change intentionally modifies it.

## Provenance and Attribution

Preserve accurate authorship, source history, copyright notices, licence notices, and attribution when modifying or reusing code.

Distinguish inherited implementation from subsequent contributions. Renaming, restructuring, translating, or extending existing code does not by itself establish independent development. Independent maintenance does not imply independent development.

When assessing code from a fork, establish its relationship to this project using commit history and actual code comparisons. Do not attribute inherited upstream functionality to the fork, or attribute the fork's original additions to upstream.

Support provenance statements with specific evidence and identify uncertainty where the history is incomplete. Do not infer authorship solely from repository ownership, package names, rewritten history, or project descriptions. Keep individual disputes and unsupported allegations out of project instructions.

## Runtime and Homebridge Support

- Use `engines.node` and `engines.homebridge` in `package.json` for the declared runtime ranges.
- Preserve Homebridge 1.x compatibility where currently supported. Verify the affected API against both supported Homebridge lines when their behaviour differs.
- Use Node.js APIs available across the declared range. When validating Node.js 26, check the specific Homebridge version in use and report the pairing tested.

## Repository Map

| Area | Path |
| --- | --- |
| Shared accessory lifecycle | `src/HomeKitDevice/HomeKitDevice.js` |
| Shared streaming and transport interface | `src/plugins/camera/streamer.js`, `src/plugins/camera/streamtransport.js` |
| Camera transports | `src/plugins/camera/webrtc.js`, `src/plugins/camera/nexustalk.js` |
| FFmpeg probing and capabilities | `src/plugins/camera/ffmpeg.js` |
| Nest and Google API clients and gRPC transport | `src/api/nest.js`, `src/api/google.js`, `src/grpctransport.js` |
| Support dumps | `src/supportdump.js` |

## Documentation and JSDoc

Do not add JSDoc solely because existing code is undocumented. Update existing JSDoc when a change makes it inaccurate. Add new JSDoc only when the task requests documentation, a new public or shared API needs a documented contract, or the surrounding documented interface requires it. Do not add JSDoc merely to satisfy the core skill.

Use ordinary comments for non-obvious implementation reasoning, protocol behaviour, lifecycle decisions, compatibility requirements, workarounds, and failure handling.

## HomeKitDevice

`HomeKitDevice` provides the shared accessory lifecycle and HomeKit abstraction. Changes affecting it can impact many device types and runtime environments.

When changing its integration or callers, identify and verify the affected paths from this list:

- Homebridge HAP
- Standalone HAP-NodeJS where supported
- Optional Homebridge Matter
- Cached Homebridge accessories
- Accessory registration and removal
- Persistence
- Lifecycle messages including `ADD`, `UPDATE`, `REMOVE`, and `SHUTDOWN`
- Existing accessory identity

Preserve the accessory UUID derived by `HomeKitDevice.generateUUID` from the plugin name and device serial number. Preserve each existing HAP service's type UUID and the subtype supplied by its device plugin, including where a subtype is absent. When changing device mapping or registration, check that an existing cached accessory and its services still resolve to the same identities.

Fix genuinely shared lifecycle behaviour in `HomeKitDevice`. Keep device-specific behaviour in the relevant device plugin.

## Nest and Google APIs

The same physical device may be represented through both Nest and Google data sources.

Where both sources are available:

- Preserve the established preference for Google data where applicable.
- Check each source's schema and semantics before treating properties as equivalent.
- Normalise equivalent states at an appropriate shared boundary.
- Retain source-specific handling where behaviour genuinely differs.
- Preserve required fallback behaviour.

Nest REST and Google Observe/gRPC connections are long-running infrastructure. Preserve established authentication refresh, retry, backoff, reconnect, and shutdown semantics unless the change specifically addresses them.

Before removing a Nest fallback, establish that supported devices and accounts no longer require it.

## Cameras and Doorbells

Trace camera changes across the affected layers, including camera plugin logic, `Streamer`, `StreamTransport`, WebRTC, NexusTalk, FFmpeg, RTP/H264 handling, media timelines, jitter buffering, snapshots, HomeKit live streaming, HomeKit Secure Video, and two-way audio.

Keep transport-specific behaviour in the relevant transport implementation. Keep genuinely protocol-independent media scheduling, buffering, lifecycle, and output behaviour in the shared streaming layer.

When changing streaming lifecycle behaviour, identify and verify the affected transitions from this list:

- Startup and source acquisition
- Replacement and reconnect
- Requested stop and unexpected termination
- Stale sessions
- HomeKit failing to send a STOP request
- Asynchronous teardown
- Application shutdown

A stale or stopping stream must not tear down its replacement.

Ownership of transports, FFmpeg processes, timers, listeners, and gRPC connections must remain clear.

## HomeKit Secure Video

HKSV is required for supported camera and doorbell accessories.

For changes affecting recording, identify and verify the affected parts of the recording path:

- Decoder-safe H264 startup
- SPS/PPS availability
- Keyframe handling
- MP4 initialisation
- Recording session teardown
- FFmpeg encoder behaviour
- Hardware and software encoding
- HomeKit recording lifecycle behaviour

Do not assume behaviour verified for live streaming is automatically correct for HKSV recording.

## FFmpeg

Camera live streaming, HKSV recording, and talkback depend on FFmpeg.

- Use `FFMPEG_VERSION` in `src/consts.js` as the minimum-version requirement, enforced through `FFmpeg.hasMinimumSupport` in `src/plugins/camera/ffmpeg.js`.
- Keep required codec checks enforced.
- Preserve software encoding fallback where supported.
- Select hardware acceleration only when the relevant encoder is actually usable.
- Raspberry Pi DRM graphics nodes are not evidence of NVENC, QSV, or VAAPI encoding support.
- Raspberry Pi V4L2 encoder detection must identify the encoder rather than assuming a fixed `/dev/video*` number.

Avoid unnecessary FFmpeg probes, particularly in frequently constructed or latency-sensitive paths.

## Streaming Performance

RTP processing, jitter buffering, H264 handling, media timelines, and output scheduling are latency-sensitive paths.

Be particularly cautious about introducing:

- Repeated packet or queue scans
- Repeated sorting
- Unnecessary buffer copies
- Unbounded queues
- Synchronous external operations
- Repeated codec parsing
- Diagnostics work when diagnostics are disabled

Preserve bounded buffering, decoder recovery, and stream correctness. Support any performance improvement claim with evidence.

## Native HomeKit Functionality

Follow the [native HomeKit functionality policy in CONTRIBUTING.md](CONTRIBUTING.md#native-homekit-functionality) when implementing or reviewing device functionality.

Only expose device functionality through HomeKit services and characteristics that accurately represent its purpose. Prefer standard HomeKit representations. A custom characteristic can be appropriate when it accurately represents a real device capability and follows the identifier, data type, permission, and value requirements in `CONTRIBUTING.md`. A project maintainer decides whether to accept a new custom characteristic. An explicit implementation request from a maintainer is sufficient authorisation to proceed.

Do not create artificial switches, outlets, lights, or other unrelated services to work around missing native HomeKit functionality. Do not repurpose standard HomeKit characteristics or their defined values to represent unrelated device functionality.

Where no appropriate HomeKit representation exists, leave the functionality unexposed. Making a workaround optional or disabled by default does not make it acceptable.

## Device Plugins

Device plugins own interpretation and behaviour specific to their Nest or Google device type.

- Preserve existing HomeKit service and characteristic identity where possible.
- Update service state without recreating the service.
- Add or remove optional services according to actual device capability and configuration.
- Expose controls only for operations the underlying device supports.
- Keep device-specific workarounds in the relevant plugin unless evidence establishes that the behaviour is shared.

## Configuration

Preserve existing configuration compatibility unless a breaking change is explicitly intended.

The project supports plugin-level options, account configuration, per-home configuration, device configuration, and per-device overrides.

Preserve the meaning and default of existing options unless the change explicitly updates them. Prefer reliable automatic detection over adding a configuration option. Keep Homebridge UI configuration consistent with the schema and documented behaviour.

## Logging and Support Dumps

Keep normal logs useful without flooding them with expected camera, network, polling, or lifecycle events. Put detailed streaming and protocol diagnostics in debug logging or support dumps where appropriate.

Keep support-dump collection bounded and avoid significant background processing when it is disabled.

Never expose Nest or Google authentication credentials, cookies, OAuth tokens, or other secrets in logs or support dumps.

When suppressing expected errors or warnings, preserve visibility of unexpected variants that may indicate a real failure.

## Security

Apply the core skill's security-by-design principles to this plugin's account, device, network, and process boundaries. Preserve these protections in failure and recovery paths as well as successful operations. Follow the [security guidance in CONTRIBUTING.md](CONTRIBUTING.md#security).

When changing security-sensitive code, verify the affected paths:

- For authentication, session refresh, or device routing, preserve TLS certificate validation and check that credentials, device data, and commands stay scoped to the correct account and device. When changing refresh or reconnect behaviour, check whether a response from a superseded session can affect the current session.
- For logging or support dumps, prevent secret disclosure and check redaction in debug output and error paths as well as normal output. Use fabricated credentials in regression tests.
- For FFmpeg or other external commands, pass arguments separately from the executable and keep shell execution disabled. Validate externally supplied values against the expected type, range, format, and supported protocols where applicable.
- For Nest and Google input, validate source-specific data before using it to select accounts or devices, construct requests, or update accessory state. Reject unsupported or unauthorised commands without reporting success. Preserve bounded queues, buffers, retries, and resource cleanup in the affected paths.
- For dependency security fixes, check the resolved version in the lockfile, including affected transitive dependencies.

Report the security checks performed and any affected live paths that remain unverified.

## Dependencies

Reuse the runtime or an existing dependency where it meets the requirement. When adding a dependency, explain the gap it fills and verify compatibility with the declared runtime ranges.

## Project Documentation

- During alpha or beta development, record meaningful changes under the current pre-release heading in `PRERELEASE_NOTES.md`. Each heading covers that release only. If no heading is established, flag the missing target and leave version assignment to release preparation.
- When preparing a final release, consolidate meaningful outcomes into `CHANGELOG.md`.
- Shared modules such as `HomeKitDevice` may maintain a separate code-date changelog. Follow the module's existing convention.
- Update existing code-version dates in modified source files using the task environment's current date in `YYYY.MM.DD` format. Use the local date as a fallback. Find source files with these dates using `rg -n -i 'code version' src`.

## Repository-Specific Verification

| Check | Command |
| --- | --- |
| Tests | `npm test` |
| Lint | `npm run lint` |
| Tests with coverage | `npm run test:coverage` |
| Build | `npm run build` |
| Lint, coverage, and build | `npm run check` |

Follow the coverage requirements in [CONTRIBUTING.md](CONTRIBUTING.md). New production modules require test coverage and an entry in `test/coverage-baseline.json`.

Choose checks that cover the changed behaviour. For streaming and HKSV, follow affected behaviour across the transport, `Streamer`, FFmpeg, and HomeKit boundaries. For shared `HomeKitDevice` changes, check the affected lifecycle paths and HAP environments. For Nest and Google data processing, check both sources where either can produce the affected input.

Report which affected paths were exercised and identify any relevant paths that could not be checked. Hardware-specific behaviour that cannot be exercised locally must be identified as **not hardware-verified**. Do not treat successful unit tests as evidence that camera hardware, FFmpeg hardware acceleration, Google or Nest backend behaviour, or physical HomeKit devices have been verified.
