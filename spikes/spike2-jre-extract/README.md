# Spike 2 — JRE Embed / Extract / java -version

## Goal

Embed a portable Temurin JRE 21 archive into a Bun compiled exe, extract it at
runtime, and measure:

1. **Archive size** — how much does a JRE add to the exe?
2. **First-run extraction time** — must be <= 60 000 ms (60 s) to meet plan budget.
3. **Operational verification** — `java -version` succeeds and reports JRE 21.

This gates plan Phase 2 step 7 (휴대용 JRE 21 임베드) and the Java LSP acceptance
criterion AC4. The budget numbers from this spike feed the plan's extraction-time
allowance.

---

## Files

| File | Purpose |
|------|---------|
| `entry.ts` | Harness: imports JRE zip as file-asset, extracts to temp, spawns `java -version`, reports size + time |
| `prepare.sh` | Downloads Temurin JRE 21 zip (win-x64 + optional macOS) via Adoptium API |
| `run.sh` | macOS/Linux smoke test: calls prepare.sh then compiles + runs entry.ts |
| `run.ps1` | **Windows host run**: downloads JRE zip, compiles `--target=bun-windows-x64`, runs |
| `payload/` | Created by prepare.sh — holds `jre21.zip` (symlink or copy) |
| `dist/` | Created by build step — holds compiled executables |

---

## How to Run

### macOS smoke test (measures macOS extraction; Windows timing may differ)

```bash
cd spikes/spike2-jre-extract
chmod +x prepare.sh run.sh
./run.sh
```

This downloads the Temurin JRE 21 archives (windows/x64 and macOS), points
`payload/jre21.zip` at the macOS archive for the local test, then compiles and
runs the harness. The extraction timing on macOS is indicative; **re-run on
Windows for the authoritative budget measurement**.

### Windows host run (REQUIRED for budget confirmation)

**Requirements:**
- Bun installed: `winget install oven-sh.bun`
- Internet access on the build machine (only needed to download the JRE once)

```powershell
cd spikes\spike2-jre-extract
.\run.ps1
```

The script:
1. Downloads the Temurin JRE 21 Windows/x64 zip from Adoptium (if not cached).
   URL: `https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse`
2. Compiles `entry.ts` targeting `bun-windows-x64` with the JRE zip embedded.
3. Runs the compiled exe, which extracts the JRE to `%TEMP%\spike2-jre-<timestamp>`,
   spawns `java -version`, and reports measurements.

**Manual download** (if Invoke-WebRequest is blocked):

```powershell
# Paste this URL into a browser or use curl:
# https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jre/hotspot/normal/eclipse
# Save the downloaded .zip as:  spikes\spike2-jre-extract\payload\jre21.zip
# Then run:  .\run.ps1
```

---

## PASS / FAIL Criteria

### PASS

```
RESULT: PASS -- JRE extracted and operational within budget.
```

All of the following hold:
- `java -version` exits 0 and output contains `"21"`.
- Extraction time <= 60 000 ms.
- Archive size is measured and reported (no hard limit, just informational).

=> **Record the measured values** (archive size MB, extraction ms) and update the
   plan's budget table. Proceed to Spike 3.

### FAIL

One or more of the following:

| Failure mode | Implication |
|---|---|
| `java -version` fails / no java found | Extraction broken or JRE archive corrupt |
| Extraction time > 60 000 ms | Budget exceeded — reconsider JRE packaging (use jlink minimal JRE, pre-extracted cache, or progress UI) |
| `bun build` fails with archive embedded | Bun `--compile` file-asset size limit hit — investigate splitting approach |

=> Escalate to project owner with measured numbers before proceeding to Phase 2.

---

## Expected Measurements (for reference)

Temurin JRE 21 Windows x64 is approximately 60-70 MB compressed. Extraction time
on a typical SSD Windows machine is expected to be 5-20 s. These are estimates;
the spike exists to produce real numbers.

---

## Notes

- `payload/` and `dist/` are gitignored (large binary files).
- The Adoptium API URL always resolves to the latest GA release of JRE 21. To pin
  a specific version, use:
  `https://api.adoptium.net/v3/binary/version/<version>/windows/x64/jre/hotspot/normal/eclipse`
  where `<version>` is e.g. `jdk-21.0.3+9`.
- Extraction uses the platform's `unzip`/`tar` (macOS/Linux) or PowerShell
  `Expand-Archive` (Windows) — no third-party dependency.
