# Spike 1 — Bun Embedded-Binary Spawn

## Goal

Validate that `bun build --compile --target=bun-windows-x64` can embed a native
binary via `import x from "./bin" with { type: "file" }` and that at runtime the
compiled exe can:

1. Read the embedded asset bytes.
2. Write them to a temp path.
3. Spawn the extracted binary and capture its output.

This reproduces-or-refutes **oven-sh/bun#10344** (Windows crash when spawning an
embedded-asset binary from a compiled Bun exe). It is a hard gate for Option A.

---

## Files

| File | Purpose |
|------|---------|
| `entry.ts` | Harness: imports dummy binary as file-asset, writes to temp, spawns, prints verdict |
| `run.sh` | macOS/Linux LOCAL smoke test (embeds `/bin/echo`, compiles + runs) |
| `run.ps1` | **Windows host run** (embeds `where.exe`, compiles `--target=bun-windows-x64`, runs) |
| `payload/` | Created by run scripts — holds the dummy binary to embed |
| `dist/` | Created by build step — holds compiled executables |

---

## How to Run

### macOS smoke test (sanity check only — not the real gate)

```bash
cd spikes/spike1-bun-embed-spawn
chmod +x run.sh
./run.sh
```

This copies `/bin/echo` into `payload/dummy-bin`, compiles for the local macOS
target, and runs the result. A PASS here only confirms the harness logic; it does
**not** confirm Windows behaviour.

### Windows host run (REQUIRED for the real gate)

**Requirements:**
- Bun installed: `winget install oven-sh.bun` (then open a new terminal)
- The repo cloned or this spike directory copied onto the Windows machine

```powershell
cd spikes\spike1-bun-embed-spawn
.\run.ps1
```

The script:
1. Copies `%SystemRoot%\System32\where.exe` into `payload\dummy-bin` (harmless
   small native binary that prints the PATH for a given command name).
2. Runs `bun build --compile --target=bun-windows-x64 --outfile dist\spike1-windows.exe entry.ts`.
3. Executes `dist\spike1-windows.exe` and reports the result.

**If you want to test with a different payload binary**, place any small Windows
`.exe` at `payload\dummy-bin` before running `run.ps1`.

---

## PASS / FAIL Criteria

### PASS

```
RESULT: PASS -- embedded binary extracted and spawned successfully. #10344 NOT reproduced.
```

All of the following hold:
- `bun build --compile --target=bun-windows-x64` exits 0.
- The compiled `spike1-windows.exe` exits 0.
- `stdout` from the spawned embedded binary is non-empty.
- No crash / hang / access-violation.

=> **Option A (single exe) is cleared. Proceed to Spike 2.**

### FAIL

```
RESULT: FAIL -- exit=<N> signal=<S> ...
```

Or the process crashes / hangs before printing the RESULT line.

=> **Bun#10344 is reproduced.** Option A is at risk. Stop and escalate to the
   project owner for a decision: (a) wait for Bun fix, (b) pivot to Option B
   (exe + signed assets.pak sidecar), or (c) use a different embedding approach.

---

## Notes

- The macOS smoke test uses `echo` as the payload. On Windows the payload is
  `where.exe`. Neither is the actual opencode binary — this spike only tests the
  embed/extract/spawn mechanism, not payload content.
- `payload/` and `dist/` are gitignored (add them if not already present in
  `.gitignore`).
- If Bun is not on PATH on Windows, add it: `$env:PATH += ";$env:USERPROFILE\.bun\bin"`.
