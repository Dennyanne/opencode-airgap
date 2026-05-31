#!/usr/bin/env bash
# Spike 3: Node-LSP/MCP runtime decision
# Runs on macOS (or Linux) with Bun + Node present.
# Final confirmation on Windows target still required — see README.
#
# What this does:
#   1. Sends a minimal LSP initialize handshake to tsserver under Node.
#   2. Repeats under Bun.
#   3. Compares results and prints a DECISION line.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TSSERVER="${REPO_ROOT}/node_modules/.bin/tsserver"

if [[ ! -x "${TSSERVER}" ]]; then
  echo "ERROR: tsserver not found at ${TSSERVER}"
  echo "  Run: cd ${REPO_ROOT} && bun install"
  exit 1
fi

NODE_BIN="$(which node)"
BUN_BIN="$(which bun)"

echo "==================================================="
echo " Spike 3 — Node-LSP runtime decision"
echo "==================================================="
echo "  tsserver : ${TSSERVER}"
echo "  node     : ${NODE_BIN} ($(node --version))"
echo "  bun      : ${BUN_BIN} ($(bun --version))"
echo ""

# ------------------------------------------------------------------
# LSP initialize JSON-RPC message builder
# Content-Length framing per LSP spec.
# ------------------------------------------------------------------
make_initialize_request() {
  local seq="${1:-1}"
  # Minimal LSP InitializeRequest that tsserver understands
  local body
  body=$(cat <<EOF
{"seq":${seq},"type":"request","command":"initialize","arguments":{"processId":$$,"rootPath":"/tmp","capabilities":{},"hostInfo":"spike3-harness"}}
EOF
)
  # Strip trailing newline to get exact byte count
  body="${body%$'\n'}"
  local len=${#body}
  printf "Content-Length: %d\r\n\r\n%s" "${len}" "${body}"
}

# ------------------------------------------------------------------
# Try to get an LSP response from a given runtime.
# Returns 0 (success/PASS) or 1 (fail).
# ------------------------------------------------------------------
try_lsp() {
  local label="${1}"
  local runtime="${2}"
  local timeout_s=10

  echo "--- Testing: ${label} ---"
  echo "  runtime: ${runtime}"

  local tmpdir
  tmpdir="$(mktemp -d)"
  local in_fifo="${tmpdir}/in.fifo"
  local out_file="${tmpdir}/out.txt"
  local pid_file="${tmpdir}/pid"

  mkfifo "${in_fifo}"

  # Start tsserver, reading from fifo and writing stdout to file.
  # tsserver logs go to stderr; we discard those for cleanliness.
  "${runtime}" "${TSSERVER}" \
    --useNodeIpc=false \
    < "${in_fifo}" \
    > "${out_file}" \
    2>/dev/null &
  local server_pid=$!
  echo "${server_pid}" > "${pid_file}"
  echo "  server PID: ${server_pid}"

  # Write the initialize request to the fifo.
  make_initialize_request 1 > "${in_fifo}" &
  local writer_pid=$!

  # Wait up to timeout_s for a response.
  local elapsed=0
  local got_response=0
  while [[ ${elapsed} -lt ${timeout_s} ]]; do
    sleep 0.5
    elapsed=$((elapsed + 1))
    if [[ -s "${out_file}" ]]; then
      got_response=1
      break
    fi
    # Check if server died early
    if ! kill -0 "${server_pid}" 2>/dev/null; then
      echo "  server exited prematurely"
      break
    fi
  done

  # Cleanup
  kill "${server_pid}" 2>/dev/null || true
  wait "${server_pid}" 2>/dev/null || true
  wait "${writer_pid}" 2>/dev/null || true

  if [[ ${got_response} -eq 1 ]]; then
    local first_line
    first_line="$(head -1 "${out_file}")"
    local response_size
    response_size="$(wc -c < "${out_file}" | tr -d ' ')"
    echo "  response bytes : ${response_size}"
    echo "  first line     : ${first_line:0:120}"

    # Check for Content-Length header (LSP framing) indicating a real response
    if grep -q "Content-Length" "${out_file}" 2>/dev/null; then
      echo "  verdict        : PASS — received LSP-framed response"
      rm -rf "${tmpdir}"
      return 0
    elif [[ ${response_size} -gt 0 ]]; then
      echo "  verdict        : PARTIAL — got output but no LSP Content-Length framing"
      rm -rf "${tmpdir}"
      return 0
    fi
  fi

  echo "  verdict        : FAIL — no response within ${timeout_s}s"
  rm -rf "${tmpdir}"
  return 1
}

# ------------------------------------------------------------------
# Run both trials
# ------------------------------------------------------------------
node_pass=0
bun_pass=0

echo ""
try_lsp "Node (control)" "${NODE_BIN}" && node_pass=1 || node_pass=0
echo ""
try_lsp "Bun  (candidate)" "${BUN_BIN}" && bun_pass=1 || bun_pass=0

echo ""
echo "==================================================="
echo " RESULTS"
echo "==================================================="
echo "  Node hosting tsserver : $([ ${node_pass} -eq 1 ] && echo PASS || echo FAIL)"
echo "  Bun  hosting tsserver : $([ ${bun_pass} -eq 1 ] && echo PASS || echo FAIL)"
echo ""

if [[ ${bun_pass} -eq 1 ]]; then
  echo "DECISION: bun-host"
  echo "  Reasoning: Bun can directly host tsserver. Node embed is not required"
  echo "  for tsserver. Verify remaining Node MCPs under Bun before removing"
  echo "  the portable Node embed entirely."
else
  echo "DECISION: embed-node"
  if [[ ${node_pass} -eq 1 ]]; then
    echo "  Reasoning: Node can host tsserver but Bun cannot. Portable Node"
    echo "  runtime must be embedded in the exe."
  else
    echo "  Reasoning: Even Node failed (check tsserver install). Cannot confirm"
    echo "  Bun hosting. Default to embedding portable Node runtime."
  fi
fi

echo ""
echo "NOTE: This verdict is for macOS/Linux. Re-run on the Windows target"
echo "      with the cross-compiled exe to confirm the final decision."
echo "      Windows path: run.ps1 (see README.md)"
