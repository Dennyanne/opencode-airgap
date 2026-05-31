# Windows Manual Verification Checklist

These criteria require a live Windows host or VM and cannot be automated on the
build machine (macOS/Linux).  Run each check in order.  Record PASS or FAIL and
any relevant log excerpts.

---

## AC2 — First-run extraction on a clean Windows 11 x64 machine

**Prerequisites**
- Windows 11 x64 VM with no Node, Bun, or JVM installed.
- Copy `opencode-airgap.exe` to the VM (e.g. via USB stick or internal file share).
- If SmartScreen or AV blocks the file, use `More info -> Run anyway` or add an AV
  allowlist entry for the hash.  Document any bypass steps taken.

**Steps**
1. Open a terminal (cmd or PowerShell).
2. Run: `opencode-airgap.exe`
3. Watch for extraction log messages on stderr/stdout.

**Expected result**
- Extraction log confirms assets were written to
  `%LOCALAPPDATA%\opencode-airgap\<version>\` (e.g.
  `C:\Users\<user>\AppData\Local\opencode-airgap\1.2.3\`).
- opencode TUI appears in the terminal after extraction completes.
- No error messages referencing missing Node, Bun, or Java.

**PASS signal**: TUI is visible and extraction path matches the pattern above.
**FAIL signal**: Crash, missing TUI, or extraction path absent from log.

---

## AC3 — Air-gapped operation (firewall all-deny except vLLM endpoint)

**Prerequisites**
- Same VM as AC2 (assets already extracted, or freshly extracted).
- Windows Firewall or a VM-level network policy blocking all outbound traffic
  except the IP/port of the local vLLM server.
- `opencode-airgap.config.json` (or env vars) configured with the vLLM
  `baseURL`, `apiKey`, and `model`.
- Wireshark or Windows Event Log network monitoring enabled.

**Steps**
1. Apply the all-deny firewall rule, allowing only `<vLLM_IP>:<vLLM_PORT>`.
2. Run `opencode-airgap.exe`.
3. In the TUI, send one chat message and wait for a response.
4. Stop Wireshark / review Event Log for any blocked outbound connections.

**Expected result**
- Chat round-trip succeeds (response received from vLLM).
- Wireshark/Event Log shows zero outbound connections to any IP other than
  the vLLM endpoint.
- No "download" or "fetch" errors in the opencode log.

**PASS signal**: Chat succeeds and network capture shows only vLLM traffic.
**FAIL signal**: Chat fails, or non-vLLM outbound connections observed.

---

## AC4 — Java LSP (jdtls) starts without downloading anything

**Prerequisites**
- VM from AC2 with `OPENCODE_DISABLE_LSP_DOWNLOAD=true` set in the environment
  (the embedded config sets this; confirm it is active).
- A `.java` file accessible from the TUI working directory.

**Steps**
1. Run `opencode-airgap.exe`.
2. Open a `.java` source file in the TUI.
3. Wait up to 30 seconds for LSP initialization.
4. Hover over a symbol or trigger diagnostics.

**Expected result**
- opencode log (check `%LOCALAPPDATA%\opencode-airgap\logs\` or stderr) contains
  `JDT initialized` or similar jdtls startup message.
- Hover tooltip or at least one diagnostic appears in the TUI.
- No log lines containing "download" or network error related to jdtls/JRE.
- `OPENCODE_DISABLE_LSP_DOWNLOAD=true` is visible in the process environment
  (run `set` in the same terminal before launching).

**PASS signal**: jdtls starts from extracted JRE, hover/diagnostic appears, zero
download attempts.
**FAIL signal**: jdtls fails to start, no LSP response, or download attempt logged.

---

## AC5 — Vue LSP (Volar) starts without downloading anything

**Prerequisites**
- Same VM.  A `.vue` file accessible from the TUI working directory.

**Steps**
1. Run `opencode-airgap.exe`.
2. Open a `.vue` source file in the TUI.
3. Wait up to 15 seconds for LSP initialization.
4. Hover over a symbol or trigger diagnostics.

**Expected result**
- opencode log contains `Volar` or `@vue/language-server` startup message.
- Hover tooltip or at least one diagnostic appears.
- No download attempt in the log.

**PASS signal**: Volar starts, hover/diagnostic appears.
**FAIL signal**: Volar fails to start, no LSP response, or download attempt logged.

---

## AC6 — Offline ast-grep pattern search

**Prerequisites**
- Same VM.  Any source file present in the working directory.

**Steps**
1. Run `opencode-airgap.exe`.
2. In the TUI or via an opencode tool call, trigger an ast-grep-based structural
   search pattern (e.g. search for `console.log($ARG)` in the working directory).

**Expected result**
- Search returns results (or an empty result set for a non-matching pattern) without
  any network error or "ast-grep binary not found" message.
- The ast-grep binary was loaded from the extracted cache path
  (`%LOCALAPPDATA%\opencode-airgap\<ver>\tool\ast-grep\`).

**PASS signal**: ast-grep search completes offline with a result or empty set.
**FAIL signal**: Error about missing binary, or search hangs awaiting a network
resource.

---

## AC7 — Local MCP responds; remote MCPs disabled cleanly

**Prerequisites**
- Same VM.  `opencode-airgap.exe` running.

**Steps**
1. Launch the TUI and inspect the MCP status output (opencode typically prints MCP
   server statuses at startup).
2. Trigger at least one call to the `filesystem` MCP (e.g. list files in the
   working directory).
3. Observe log messages for `websearch`, `context7`, and `grep_app`.

**Expected result**
- `filesystem` MCP responds with a file listing (at least one entry).
- Log contains lines matching `disabled (air-gapped)` for `websearch`, `context7`,
  and `grep_app`.
- No hang or error related to the disabled remote MCPs.

**PASS signal**: filesystem MCP responds; remote MCPs log "disabled (air-gapped)"
and do not block startup.
**FAIL signal**: filesystem MCP errors, or remote MCPs attempt a network connection
or hang.

---

## AC11 — Concurrent first-run (two instances, same machine)

**Prerequisites**
- Clean VM (no prior extraction; delete `%LOCALAPPDATA%\opencode-airgap\` if it
  exists to simulate first run).

**Steps**
1. Open two terminal windows.
2. In both terminals simultaneously, run `opencode-airgap.exe` (launch within a
   second of each other).
3. Watch the extraction logs in both terminals.

**Expected result**
- Exactly one terminal shows the full extraction log
  (`Extracting assets...` through `Extraction complete`).
- The other terminal shows a lock-wait message (e.g. `waiting for extraction lock`)
  and then proceeds to the TUI after the first instance finishes.
- Both terminals reach the TUI without error.
- No duplicate or interleaved extraction artefacts under
  `%LOCALAPPDATA%\opencode-airgap\<ver>\`.

**PASS signal**: One extraction, two TUIs reached, no corruption.
**FAIL signal**: Both instances attempt extraction simultaneously, or either
instance errors out.

---

## AC12 — Incomplete cache triggers re-extraction

**Prerequisites**
- VM from AC2 with a previously successful extraction under
  `%LOCALAPPDATA%\opencode-airgap\<ver>\`.

**Steps**
1. Delete one file from the extracted cache, e.g.:
   `del "%LOCALAPPDATA%\opencode-airgap\<ver>\tool\ast-grep\ast-grep.exe"`
2. Also delete or rename the `.complete` sentinel:
   `del "%LOCALAPPDATA%\opencode-airgap\<ver>\.complete"`
3. Relaunch `opencode-airgap.exe`.

**Expected result**
- The bootstrap detects the missing `.complete` sentinel (and/or checksum mismatch)
  and performs a full re-extraction.
- Extraction log appears again in the terminal.
- After re-extraction the TUI starts normally.
- No silent corruption: the previously deleted file is restored.

**PASS signal**: Re-extraction triggered, TUI reaches ready state, deleted file
restored.
**FAIL signal**: Bootstrap skips re-extraction despite missing sentinel, or TUI
fails due to the missing file.
