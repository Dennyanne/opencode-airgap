#!/usr/bin/env bash
# Spike 1 — macOS/Linux smoke test
# Compiles entry.ts with /bin/echo embedded as the dummy payload, then runs it.
#
# Requirements: bun >= 1.1.0
# This is a LOCAL SMOKE TEST only. The real Windows gate is run.ps1.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==================================================="
echo " Spike 1 — Bun embed-spawn (macOS smoke test)"
echo "==================================================="

# --- Prepare the dummy payload ---
# We compile a tiny Bun binary rather than copying a system binary.
# macOS SIP prevents re-executing copied system binaries from /tmp (exit 137).
mkdir -p "${SCRIPT_DIR}/payload" "${SCRIPT_DIR}/dist"
PAYLOAD="${SCRIPT_DIR}/payload/dummy-bin"

if [[ ! -f "${PAYLOAD}" ]]; then
  echo "Compiling hello-payload.ts -> ${PAYLOAD} (smoke-test payload)"
  bun build \
    --compile \
    --target="bun-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/arm64/arm64/;s/x86_64/x64/')" \
    --outfile "${PAYLOAD}" \
    "${SCRIPT_DIR}/hello-payload.ts"
  chmod +x "${PAYLOAD}"
fi

# --- Compile for the local (macOS/Linux) target ---
echo ""
echo "Compiling for local target (smoke test)..."
bun build \
  --compile \
  --target="bun-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/arm64/arm64/;s/x86_64/x64/')" \
  --outfile "${SCRIPT_DIR}/dist/spike1-local" \
  "${SCRIPT_DIR}/entry.ts"

echo "Compiled: ${SCRIPT_DIR}/dist/spike1-local"
echo ""
echo "Running..."
"${SCRIPT_DIR}/dist/spike1-local"
