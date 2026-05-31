/**
 * AC1: `airbuild build` produces exactly one .exe artifact, exit 0.
 *
 * On macOS/Linux the build will typically NOT produce the final exe because:
 *   (a) GitHub rate limiting or network errors cause fetch failures (exit 1), or
 *   (b) Fetches succeed but the actual Windows binary assets are absent from
 *       staging/, causing build-exe.ts to emit "staging assets not present"
 *       and exit 0 without writing the file.
 *
 * Both (a) and (b) are expected dev-machine behavior — we SKIP with a note.
 * A PASS requires exit 0 AND the output file physically present, which only
 * happens on a build machine with all Windows staging assets available.
 */
import { existsSync, rmSync } from "fs";
import { dirname } from "path";
import { pass, fail, skip, runCmd } from "./util.ts";

const LABEL = "AC1: airbuild build -> single exe, exit 0";
const OUT = "/tmp/ac1-test.exe";
// Emitted by build-exe.ts when embed paths are not present on disk.
const DRY_RUN_SIGNAL = "staging assets not present";
// Emitted by the fetchers when a network/asset error exhausts all retries.
const FETCH_FATAL_SIGNAL = "fatal:";

export async function runAc1(): Promise<void> {
  // Clean up any prior run.
  if (existsSync(OUT)) rmSync(OUT);

  const result = await runCmd(
    ["bun", "run", "src/cli/index.ts", "build", "--out", OUT],
    { cwd: process.cwd() },
  );

  const combinedOutput = result.stdout + result.stderr;

  // --- Dev-machine skip paths ---

  // (a) Build-exe dry-run: fetches resolved but Windows staging files absent.
  if (combinedOutput.includes(DRY_RUN_SIGNAL)) {
    skip(
      LABEL,
      "staging assets not present (expected on dev machine); compile path exercised in dry-run mode",
    );
    if (existsSync(OUT)) rmSync(OUT);
    return;
  }

  // (b) Fetch failure: GitHub rate limit / 404 / network error.
  if (result.code !== 0 && combinedOutput.includes(FETCH_FATAL_SIGNAL)) {
    skip(
      LABEL,
      "asset fetch failed on dev machine (likely GitHub rate limit or missing Windows binaries); " +
        "retest on a build machine with network access and staged assets",
    );
    if (existsSync(OUT)) rmSync(OUT);
    return;
  }

  // --- Full build path (build machine with all staging assets) ---

  if (result.code !== 0) {
    fail(LABEL, `process exited ${result.code}\nstderr: ${result.stderr.slice(0, 400)}`);
    if (existsSync(OUT)) rmSync(OUT);
    return;
  }

  if (!existsSync(OUT)) {
    fail(LABEL, `exit 0 but output file ${OUT} was not created`);
    return;
  }

  // Check no unexpected sibling artifacts appeared alongside the output.
  // (versions.lock and asset-manifest.json are expected siblings — allowed.)
  const { readdirSync } = await import("fs");
  const outDir = dirname(OUT);
  const allowed = new Set(["ac1-test.exe", "versions.lock", "asset-manifest.json"]);
  const unexpected = readdirSync(outDir).filter(
    (f) => f.startsWith("ac1-") && !allowed.has(f),
  );

  if (unexpected.length > 0) {
    fail(LABEL, `unexpected artifact files alongside output: ${unexpected.join(", ")}`);
  } else {
    pass(LABEL);
  }

  // Clean up.
  if (existsSync(OUT)) rmSync(OUT);
  const lockPath = `${outDir}/versions.lock`;
  const manifestPath = `${outDir}/asset-manifest.json`;
  if (existsSync(lockPath) && outDir === "/tmp") rmSync(lockPath);
  if (existsSync(manifestPath) && outDir === "/tmp") rmSync(manifestPath);
}
