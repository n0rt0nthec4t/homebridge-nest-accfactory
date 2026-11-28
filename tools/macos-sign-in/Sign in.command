#!/bin/bash
# Start the bundled runtime from the extracted folder, including paths with spaces.
cd -- "$(dirname -- "$0")" || exit 1

# Force the hardware's native slice even when Terminal itself is translated.
# arch rejects an incompatible Node binary before it can start under Rosetta.
if /usr/bin/arch -arm64 /usr/bin/true 2>/dev/null; then
  native=arm64
else
  native=x86_64
fi
if /usr/bin/arch -"$native" ./runtime/node --version >/dev/null 2>&1; then
  /usr/bin/arch -"$native" ./runtime/node ./tools/macos-sign-in/cli.mjs --prebuilt "$@"
  result=$?
else
  printf 'This download cannot run natively on this Mac.\nUse arm64 for Apple Silicon or x64 for Intel, and extract the whole ZIP.\n'
  result=1
fi

# Keep a Finder-launched terminal open so credentials or failures remain readable.
if [[ "$#" -eq 0 && -t 0 ]]; then
  printf '\nPress Return to close this window...'
  read -r reply
fi
exit "$result"
