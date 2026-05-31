/**
 * Spike 2 — JRE embed / extract / java -version timing harness
 *
 * Imports the Temurin JRE 21 archive as an embedded asset, extracts it
 * to a temp directory, spawns `java -version`, and reports:
 *   - archive size (bytes)
 *   - extraction wall-clock time (ms)
 *   - java -version output
 *
 * PASS criteria (from plan Phase 0 #2):
 *   - java -version succeeds (exit 0, output contains "21")
 *   - extraction time <= 60 000 ms (60 s)
 *
 * NOTE: This file is compiled WITH the JRE archive embedded.
 *   The prepare.sh script downloads the archive into ./payload/ first.
 *   On macOS the archive is a .tar.gz; on Windows the expected format
 *   is a .zip.  This entry handles both via Bun's built-in decompress.
 */

// @ts-ignore — resolved by Bun at compile time
import jreArchive from "./payload/jre21.zip" with { type: "file" };

import { mkdirSync, rmSync, readdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUDGET_MS = 60_000;

async function extractZip(archivePath: string, destDir: string): Promise<void> {
  // Bun 1.x does not expose a built-in zip extractor at the JS level, so
  // we shell out to the platform's unzip / Expand-Archive.
  const IS_WINDOWS = process.platform === "win32";
  if (IS_WINDOWS) {
    const r = Bun.spawnSync(
      ["powershell", "-NoProfile", "-Command",
        `Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${destDir}'`],
      { stdout: "inherit", stderr: "inherit" }
    );
    if (r.exitCode !== 0) throw new Error(`Expand-Archive failed: exit ${r.exitCode}`);
  } else {
    // macOS / Linux: use unzip or tar depending on extension
    const isZip = archivePath.endsWith(".zip");
    const cmd = isZip
      ? ["unzip", "-q", archivePath, "-d", destDir]
      : ["tar", "-xzf", archivePath, "-C", destDir];
    const r = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
    if (r.exitCode !== 0) throw new Error(`Extraction failed: exit ${r.exitCode}`);
  }
}

function findJava(extractRoot: string): string | null {
  // Temurin archives unpack to a single top-level dir like
  // jdk-21.0.x+XX-jre/ or jre-21.0.x/ — walk one level to find bin/java.
  const IS_WINDOWS = process.platform === "win32";
  const javaBin = IS_WINDOWS ? "java.exe" : "java";
  for (const entry of readdirSync(extractRoot)) {
    const candidate = join(extractRoot, entry, "bin", javaBin);
    if (existsSync(candidate)) return candidate;
  }
  // Fallback: check directly under extractRoot/bin/
  const direct = join(extractRoot, "bin", javaBin);
  if (existsSync(direct)) return direct;
  return null;
}

async function main() {
  console.log("Spike 2: JRE embed/extract harness");
  console.log(`  platform : ${process.platform}`);
  console.log(`  arch     : ${process.arch}`);
  console.log(`  bun      : ${Bun.version}`);

  // ------------------------------------------------------------------
  // 1. Measure the embedded archive size.
  // ------------------------------------------------------------------
  const archivePath: string = jreArchive;
  const archiveStat = statSync(archivePath);
  const archiveSizeBytes = archiveStat.size;
  const archiveSizeMB = (archiveSizeBytes / 1_048_576).toFixed(1);
  console.log(`  archive  : ${archivePath}`);
  console.log(`  size     : ${archiveSizeMB} MB (${archiveSizeBytes} bytes)`);

  // ------------------------------------------------------------------
  // 2. Extract and time it.
  // ------------------------------------------------------------------
  const tmpDir = join(tmpdir(), `spike2-jre-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  console.log(`  dest     : ${tmpDir}`);
  console.log("  extracting...");

  const t0 = performance.now();
  await extractZip(archivePath, tmpDir);
  const extractMs = Math.round(performance.now() - t0);

  console.log(`  extraction time: ${extractMs} ms`);

  // ------------------------------------------------------------------
  // 3. Locate java binary.
  // ------------------------------------------------------------------
  const javaPath = findJava(tmpDir);
  if (!javaPath) {
    rmSync(tmpDir, { recursive: true, force: true });
    console.error("RESULT: FAIL — could not locate java binary in extracted JRE.");
    process.exit(1);
  }
  console.log(`  java binary: ${javaPath}`);

  // ------------------------------------------------------------------
  // 4. Spawn java -version.
  // ------------------------------------------------------------------
  console.log("  running java -version...");
  const result = Bun.spawnSync([javaPath, "-version"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  // java -version writes to stderr by convention
  const versionOut = [
    result.stdout ? new TextDecoder().decode(result.stdout) : "",
    result.stderr ? new TextDecoder().decode(result.stderr) : "",
  ].join("").trim();

  console.log(`  exit code : ${result.exitCode}`);
  console.log(`  output    : ${versionOut.split("\n")[0]}`);

  // ------------------------------------------------------------------
  // 5. Cleanup.
  // ------------------------------------------------------------------
  rmSync(tmpDir, { recursive: true, force: true });

  // ------------------------------------------------------------------
  // 6. Verdict.
  // ------------------------------------------------------------------
  const javaOk = result.exitCode === 0 && versionOut.includes("21");
  const budgetOk = extractMs <= BUDGET_MS;

  console.log("\n--- MEASUREMENTS ---");
  console.log(`  Archive size    : ${archiveSizeMB} MB`);
  console.log(`  Extraction time : ${extractMs} ms (budget: ${BUDGET_MS} ms)`);
  console.log(`  java -version   : ${javaOk ? "OK" : "FAIL"}`);
  console.log(`  Budget OK       : ${budgetOk ? "YES" : "NO (OVER BUDGET)"}`);

  if (javaOk && budgetOk) {
    console.log("\nRESULT: PASS — JRE extracted and operational within budget.");
    process.exit(0);
  } else {
    const reasons: string[] = [];
    if (!javaOk) reasons.push("java -version failed or did not report JRE 21");
    if (!budgetOk) reasons.push(`extraction ${extractMs}ms > budget ${BUDGET_MS}ms`);
    console.error(`\nRESULT: FAIL — ${reasons.join("; ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  console.error("RESULT: FAIL — unhandled exception.");
  process.exit(1);
});
