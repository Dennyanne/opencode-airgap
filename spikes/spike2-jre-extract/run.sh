#!/usr/bin/env bash
# Spike 2 — run.sh
# macOS/Linux smoke test: compile entry.ts with the JRE zip embedded and run it.
# The macOS JRE is used for local testing; the Windows version is compiled on Windows.
#
# Requirements: bun >= 1.1.0, curl (for prepare.sh)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==================================================="
echo " Spike 2 — JRE embed/extract (macOS smoke test)"
echo "==================================================="

# --- Step 1: ensure payload exists ---
if [[ ! -f "${SCRIPT_DIR}/payload/jre21.zip" ]]; then
  echo "Payload not found. Running prepare.sh first..."
  bash "${SCRIPT_DIR}/prepare.sh"
fi

# For the macOS local smoke test, redirect jre21.zip to the macOS tar.gz
# so extraction actually works.  This is transparent to entry.ts.
ARCH="$(uname -m)"
case "${ARCH}" in
  arm64)  MAC_ARCH="aarch64" ;;
  x86_64) MAC_ARCH="x64" ;;
  *)      MAC_ARCH="x64" ;;
esac
MAC_ARCHIVE="${SCRIPT_DIR}/payload/jre21-mac-${MAC_ARCH}.tar.gz"
LINKED="${SCRIPT_DIR}/payload/jre21.zip"

if [[ -f "${MAC_ARCHIVE}" ]]; then
  # Re-point the symlink to the macOS archive for local smoke test
  ln -sf "$(basename "${MAC_ARCHIVE}")" "${LINKED}"
  echo "  (local smoke test: jre21.zip -> $(basename "${MAC_ARCHIVE}"))"
fi

# --- Step 2: compile for local target ---
mkdir -p "${SCRIPT_DIR}/dist"
TARGET="bun-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/arm64/arm64/;s/x86_64/x64/')"

echo ""
echo "Compiling for ${TARGET} ..."
bun build \
  --compile \
  --target="${TARGET}" \
  --outfile "${SCRIPT_DIR}/dist/spike2-local" \
  "${SCRIPT_DIR}/entry.ts"

echo ""
echo "Running spike2-local ..."
"${SCRIPT_DIR}/dist/spike2-local"
