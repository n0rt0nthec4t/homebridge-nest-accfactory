<p align="center">
  <img src="../../branding/homebridge-nest-accfactory-256.png" alt="Nest Accfactory" width="120" height="120">
</p>

<h1 align="center">Nest Accfactory Sign-in</h1>

<p align="center">Sign in on your Mac. Connect your Google Home account to Homebridge.</p>

This helper opens Google's sign-in through macOS and returns the **Refresh token** and **Device ID** needed to configure a Google Home account in [Nest Accfactory](../../README.md). Complete sign-in, copy the two values into the plugin settings, and save your account.

Run the helper on your Mac even if Homebridge runs on a Raspberry Pi, NAS or another computer.

> Download a published helper build when available, or run from source. You can also build a ZIP locally using the instructions below.

[Downloads](#downloads) · [Source requirements](#requirements-for-running-from-source) · [Sign in](#sign-in) · [Connect to Homebridge](#connect-to-homebridge) · [Troubleshooting](#troubleshooting) · [Development](#development) · [Changelog](CHANGELOG.md)

## Downloads

Published helper versions appear as **Nest Accfactory Sign-in** releases on the project's [GitHub Releases page](https://github.com/n0rt0nthec4t/homebridge-nest-accfactory/releases), with tags beginning `mac-sign-in-v`.

Choose **arm64** for Apple Silicon or **x64** for an Intel Mac. Extract the entire ZIP and double-click **Sign in.command**. The download includes Node and the native helper; users do not need Node or Xcode installed. Keep the extracted files together. The launcher forces native execution and rejects a download for the wrong Mac architecture.

Downloaded builds require **macOS 13.5 or later**. They are locally signed, but are not Developer ID signed or Apple notarized. macOS may block them; review the download's origin before allowing it through **System Settings → Privacy & Security**. Leave macOS security protections enabled.

After sign-in, follow [Connect to Homebridge](#connect-to-homebridge) below. The security-alert note also applies to downloaded builds.

## Requirements for running from source

- **macOS 13.5 or later** when using the bundled/recommended Node.js 24 runtime.
- **Node.js 22.13.0 or later within Node 22, Node 24 or Node 26**, with npm.
- **Xcode command-line tools**, used to build the small native authentication helper. If needed, install them with `xcode-select --install` and complete Apple's installer before continuing.
- A checkout of this repository and a Google account with access to your Google Home devices.

The helper is for the **Google Home** account section. **Google (Nest)** uses an Issue Token URL and Cookie; an unmigrated **Nest** account uses an Access Token. See the plugin's [account configuration guide](../../README.md#configuration) for those methods.

### Google security alerts

Google may send a security alert describing a new sign-in on an **Apple iPhone 16**, even though you ran the helper on a Mac. The helper uses an iPhone device profile for Google Home authentication, so that device name can appear in Google's account activity.

Check that the account, time and location match your sign-in attempt. Only confirm activity you recognise; investigate any alert that does not match your own attempt.

## Sign in

1. Open Terminal in the repository folder and install its dependencies:

   ```sh
   npm ci
   ```

2. Start the helper:

   ```sh
   node tools/macos-sign-in/cli.mjs
   ```

3. Wait for the native helper to compile, then complete Google's sign-in prompts in the macOS authentication session. Use your account's usual verification method, including its passkey when offered.

4. Return to Terminal. On success, the command prints the values to copy:

   ```text
   Copy into the account fields in Homebridge:
   Refresh token:
   <your refresh token>
   Device ID:
   <your device ID>
   ```

Keep the two values together. Treat the refresh token as a password; do not include it in screenshots, issues or support logs. The helper prints credentials to Terminal and does not save them to a file.

To cancel, press **Ctrl+C** in Terminal or close the helper window.

## Connect to Homebridge

1. Open the **Nest Accfactory** plugin settings in the Homebridge UI.
2. Under **Accounts → Google Home**, select **Connect Account**.
3. Paste the printed **Refresh token** and **Device ID** into their matching fields.
4. Select **Check connection**.
5. After a successful check, enter an account name and select **Add to Accounts**.
6. Select **Save** to apply the plugin settings.

For an existing Google Home account, use its **Reconnect** action, enter the replacement credentials, check the connection and save the update.

The UI does not launch this helper or collect its output automatically. The helper also does not change your Homebridge configuration.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| The command cannot find `cli.mjs` | Run it from the repository root, where `package.json` lives. |
| A dependency such as `protobufjs` cannot be found | Run `npm ci` from the repository root, then retry. |
| Compilation fails or Apple tools cannot be found | Complete the Xcode command-line tools installation, then run the offline check below. |
| Sign-in is cancelled, expires or returns no authorization code | Start the command again and complete a fresh sign-in attempt. |
| The command reports `Challenge failed: …` | Record the fixed error code and run the offline check. When reporting a failure, include the code and your macOS/Node.js versions, without credentials or full sign-in URLs. |
| Homebridge rejects the result | Use the **Google Home** section and copy both values from the same successful attempt. Check that neither value includes its label or surrounding spaces. |

A successful helper run confirms that enrollment returned a refresh credential. **Check connection** verifies runtime authentication separately; neither establishes that every device feature works. Renewal after token expiry and camera streaming with this enrollment flow remain unverified.

## Development

### Offline checks

From the repository root:

```sh
node tools/macos-sign-in/cli.mjs --check
node --test "tools/macos-sign-in/test/*.test.mjs"
```

Run `--check` first on macOS. It compiles and locally signs the helper, validates the private input pipe and loads the bundled context. It makes no Google requests and does not open sign-in. The native tests use the compiled helper; other tests use fabricated callbacks and credentials.

### Implementation

| File | Responsibility |
| --- | --- |
| `cli.mjs` | Build and launch the native helper, manage cancellation and print the result. |
| `engine.mjs` | Process enrollment challenges, hold the PKCE verifier and exchange the validated callback. |
| `mac-helper/Session.swift` | Present `ASWebAuthenticationSession` and return its callback over a private pipe. |
| `mac-helper/Info.plist` | Define the locally built macOS app bundle. |
| `iosguard.proto` | Define the challenge request and response envelopes. |
| `context.json.gz` | Supply the reflection and application context used during enrollment. |
| `test/cli.test.mjs` | Exercise native input, callback validation, cancellation and diagnostic redaction. |
| `build.mjs` | Assemble and verify downloads, validate helper versions and extract release notes. |
| `test/build.test.mjs` | Check version ownership, release notes and prebuilt execution failures. |

The engine uses the repository's protobuf loader and `protobufjs` dependency. Node owns the verifier and token exchange; the Swift process receives only the sign-in URL and callback scheme. Challenge execution runs in bounded workers. The JavaScript VM is not an operating-system security sandbox.

Generated bundles and compiler caches belong in ignored `mac-helper/build/`.

### Packaging and downloads

The helper source lives under `tools/`, outside the plugin's npm `files` allowlist. Verify that it stays excluded before publishing the plugin:

```sh
npm pack --dry-run --ignore-scripts
```

Build a ZIP for your current Mac architecture with **Node.js 24**:

```sh
node tools/macos-sign-in/build.mjs
```

The builder includes the current Node runtime and its licence, a universal native helper, the engine and its runtime dependencies. Builds require a native Node process on the target Mac architecture; Rosetta builds are rejected. It may download the matching Node licence from the official Node.js source repository if the local installation omits it. Custom Node installations linked to Homebrew libraries are rejected; use an official Node.js runtime for portable builds.

Outputs are written to ignored `tools/macos-sign-in/release/`, alongside a SHA-256 checksum. Before writing the final archive, the builder runs the packaged offline check, extracts the ZIP into a new directory and runs that check again. No Google requests or account sign-in are performed by packaging.

### Release workflow

The **Mac Sign-in Helper** workflow is independent of npm publishing:

- A push affecting the helper on `main`, or a matching pull request, builds and tests both architectures.
- **Actions → Mac Sign-in Helper → Run workflow** produces downloadable test artifacts without publishing a release.
- Pushing a tag such as **`mac-sign-in-v0.1.0`** publishes the two ZIPs and their checksums in a separate GitHub Release after both builds pass.

For a new release:

1. Update the helper version in `tools/macos-sign-in/package.json`.
2. Move completed entries from **Unreleased** into a matching dated version section in [CHANGELOG.md](CHANGELOG.md).
3. Commit and push those changes. Review the build results.
4. Tag the reviewed commit and push that tag:

   ```sh
   git tag mac-sign-in-v0.1.0
   git push origin mac-sign-in-v0.1.0
   ```

Substitute the version being released. The workflow requires the tag, helper version and changelog section to match exactly. It does not create or move tags, replace existing releases, publish to npm or mark the helper as the repository's Latest plugin release. Pre-release versions such as `0.2.0-beta.1` produce GitHub prereleases.

A successful workflow publishes the assets automatically. If publication fails after creating a draft, inspect that draft before retrying; do not move a released tag to different code.
