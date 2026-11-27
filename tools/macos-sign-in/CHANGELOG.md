# Changelog

Notable changes to Nest Accfactory Sign-in are documented in this file.
Each release records its own changes and is not cumulative. The helper is versioned and released independently of the Homebridge plugin.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this tool follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-28

### Added

- macOS Google sign-in for obtaining a Google Home refresh token and device ID to copy into the plugin settings.
- Offline verification of the native helper and authentication context with `--check`.
- Native Apple Silicon and Intel downloads with a bundled Node runtime, universal authentication helper and a double-click launcher. Rosetta execution is rejected.
- Independent tagged releases and manual test builds through GitHub Actions.
