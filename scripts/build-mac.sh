#!/bin/bash
# Builds the macOS app: LNP Lab.app and a .dmg to send, for Apple Silicon and Intel Macs at once (universal).
#
#   ./scripts/build-mac.sh            universal app + dmg, signed ad hoc (works on your Mac; others right-click › Open)
#   ./scripts/build-mac.sh --native   only for this Mac's processor (faster; for trying it out)
#
# Needs Xcode (or its command line tools) and Node.js 18+. Rust is installed on the first run if it is missing.
# With an Apple Developer ID the app is signed and notarised instead, so others can open it with a double-click:
#   APPLE_SIGNING_IDENTITY="Developer ID Application: Name (TEAMID)" APPLE_ID=you@example.com \
#   APPLE_PASSWORD=app-specific-password APPLE_TEAM_ID=TEAMID ./scripts/build-mac.sh
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(uname)" = "Darwin" ] || { echo "This builds the macOS app and has to run on a Mac."; exit 1; }
xcode-select -p >/dev/null 2>&1 || { echo "Xcode command line tools are missing: run  xcode-select --install  and start again."; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js is missing: install it from https://nodejs.org (LTS) or with  brew install node."; exit 1; }

if ! command -v cargo >/dev/null 2>&1; then
  [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
fi
if ! command -v cargo >/dev/null 2>&1; then
  say "Installing Rust (rustup, into ~/.cargo) …"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  . "$HOME/.cargo/env"
fi

TARGET=(--target universal-apple-darwin)
if [ "${1:-}" = "--native" ]; then TARGET=(); else
  say "Adding the Apple Silicon and Intel targets …"
  rustup target add aarch64-apple-darwin x86_64-apple-darwin
fi

say "Installing the build tool …"
npm install --no-audit --no-fund

say "Checking the app before building it …"
npm test

say "Building LNP Lab (the first build compiles everything and takes several minutes) …"
npx tauri build "${TARGET[@]}"

OUT=src-tauri/target/$([ ${#TARGET[@]} -gt 0 ] && echo universal-apple-darwin/)release/bundle
say "Done."
ls -1 "$OUT"/dmg/*.dmg "$OUT"/macos/*.app 2>/dev/null || true
echo "Your records are kept in ~/Library/Application Support/org.lnplab.app/lnp-lab.db"
open "$OUT/dmg" 2>/dev/null || true
