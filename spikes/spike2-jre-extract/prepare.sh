#!/usr/bin/env bash
# Spike 2 — prepare.sh
# Downloads the Temurin JRE 21 archive for windows-x64 into ./payload/
# so that bun build can embed it in entry.ts.
#
# The Windows .zip is used regardless of the build-host OS because
# entry.ts will eventually be compiled targeting bun-windows-x64.
# For the macOS LOCAL smoke test a separate macOS .tar.gz is also fetched.
#
# Adoptium API: https://api.adoptium.net/v3/assets/latest/21/jre
# Direct download pattern:
#   https://api.adoptium.net/v3/binary/latest/21/ga/<OS>/<ARCH>/jre/hotspot/normal/eclipse
#   where OS = windows|mac|linux, ARCH = x64|aarch64

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAYLOAD_DIR="${SCRIPT_DIR}/payload"
mkdir -p "${PAYLOAD_DIR}"

# -----------------------------------------------------------------------
# Primary download: Windows x64 JRE 21 ZIP (for the actual spike target)
# -----------------------------------------------------------------------
WIN_URL="https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse"
WIN_OUT="${PAYLOAD_DIR}/jre21-win-x64.zip"

if [[ -f "${WIN_OUT}" ]]; then
  echo "Windows JRE already present: ${WIN_OUT} ($(du -sh "${WIN_OUT}" | cut -f1))"
else
  echo "Downloading Temurin JRE 21 (windows/x64) ..."
  echo "  URL  : ${WIN_URL}"
  echo "  dest : ${WIN_OUT}"
  curl -L --progress-bar --fail -o "${WIN_OUT}" "${WIN_URL}"
  echo "Done: $(du -sh "${WIN_OUT}" | cut -f1)"
fi

# entry.ts imports ./payload/jre21.zip — create a symlink/copy for that name.
# For the Windows-host spike, run.ps1 will set this up via Copy-Item.
# For macOS dev environment, we symlink the Windows zip under the expected name.
LINKED="${PAYLOAD_DIR}/jre21.zip"
if [[ ! -f "${LINKED}" && ! -L "${LINKED}" ]]; then
  ln -s "$(basename "${WIN_OUT}")" "${LINKED}"
  echo "Symlinked: ${LINKED} -> $(basename "${WIN_OUT}")"
fi

# -----------------------------------------------------------------------
# Optional: macOS/Linux JRE for a local smoke test of entry.ts with bun run
# (not needed for the actual Windows compilation target)
# -----------------------------------------------------------------------
case "$(uname -s)" in
  Darwin)
    ARCH="$(uname -m)"
    case "${ARCH}" in
      arm64)  LOCAL_ARCH="aarch64" ;;
      x86_64) LOCAL_ARCH="x64" ;;
      *)      LOCAL_ARCH="x64" ;;
    esac
    LOCAL_URL="https://api.adoptium.net/v3/binary/latest/21/ga/mac/${LOCAL_ARCH}/jre/hotspot/normal/eclipse"
    LOCAL_OUT="${PAYLOAD_DIR}/jre21-mac-${LOCAL_ARCH}.tar.gz"
    if [[ -f "${LOCAL_OUT}" ]]; then
      echo "macOS JRE already present: ${LOCAL_OUT}"
    else
      echo "Downloading Temurin JRE 21 (mac/${LOCAL_ARCH}) for local smoke test ..."
      curl -L --progress-bar --fail -o "${LOCAL_OUT}" "${LOCAL_URL}"
      echo "Done: $(du -sh "${LOCAL_OUT}" | cut -f1)"
    fi
    echo ""
    echo "NOTE: For local 'bun run entry.ts' smoke test, jre21.zip points to the Windows"
    echo "      archive. The macOS archive is at ${LOCAL_OUT}."
    echo "      To smoke-test extraction on macOS, temporarily change the symlink:"
    echo "        ln -sf $(basename "${LOCAL_OUT}") ${LINKED}"
    ;;
esac

echo ""
echo "prepare.sh done. Payload directory:"
ls -lh "${PAYLOAD_DIR}/"
