import { existsSync, renameSync, rmSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import type { TargetTriple, VersionsLock } from "../embed/manifest.ts";
import { VERSIONS_LOCK_FILENAME } from "../embed/manifest.ts";
import { TOOL_VERSION } from "./version.ts";
import { runBuild } from "./build.ts";

export interface UpdateOpts {
  target: TargetTriple;
  outfile: string;
}

/**
 * Derive the temp output path from the final output path.
 * e.g. "opencode-airgap.exe" → "opencode-airgap.exe.tmp"
 */
function tempOutfile(outfile: string): string {
  return `${outfile}.tmp`;
}

/**
 * Write the versions.lock file next to the final output exe.
 */
function writeVersionsLock(manifest: VersionsLock, outfile: string): void {
  const lockPath = join(dirname(outfile), VERSIONS_LOCK_FILENAME);
  writeFileSync(lockPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  console.log(`versions.lock written to ${lockPath}`);
}

/**
 * Build a VersionsLock from the staged manifest data.
 *
 * TODO(phase2): populate assets array from the real AssetManifest returned
 * by stageAssets() — map each AssetEntry to a lockfile record including
 * version, digest, and fetch source URL/npm-spec/git-ref.
 */
function buildVersionsLock(target: TargetTriple): VersionsLock {
  // TODO(phase2): replace with values resolved from stageAssets() output.
  return {
    schema: 1,
    toolVersion: TOOL_VERSION,
    opencodeVersion: "0.0.0-stub",
    pluginVersion: "0.0.0-stub",
    target,
    generatedAt: new Date().toISOString(),
    assets: [],
  };
}

/**
 * Main entry point for the `airbuild update` subcommand.
 *
 * Control flow (rollback-safe):
 *   1. Build the new exe into a temp file (never touches the existing --out)
 *   2. Write versions.lock from the resolved manifest
 *   3. Only if step 1 succeeded, atomically rename temp → final --out
 *   4. On any failure, clean up the temp file; existing --out is preserved
 */
export async function runUpdate(opts: UpdateOpts): Promise<void> {
  const tmp = tempOutfile(opts.outfile);

  // Guard: clean up a leftover temp from a prior interrupted run.
  if (existsSync(tmp)) {
    console.log(`removing stale temp file ${tmp}`);
    rmSync(tmp);
  }

  let buildSucceeded = false;
  try {
    console.log(`resolving latest versions for target ${opts.target}...`);

    // Build into the temp path; no pinned lock — always resolves latest.
    await runBuild({ target: opts.target, outfile: tmp });

    buildSucceeded = true;

    // Write versions.lock next to the final output path (before the rename
    // so that if rename fails the lock still reflects what was built).
    const lock = buildVersionsLock(opts.target);
    writeVersionsLock(lock, opts.outfile);

    // Atomic rename: on success, replace the live exe.
    console.log(`promoting ${tmp} → ${opts.outfile}`);
    renameSync(tmp, opts.outfile);
    console.log(`update complete: ${opts.outfile}`);
  } catch (err: unknown) {
    if (!buildSucceeded) {
      // Build itself failed — the existing --out was never touched.
      console.error(
        `build failed — ${opts.outfile} has NOT been modified:`,
        err instanceof Error ? err.message : String(err),
      );
    } else {
      // Build succeeded but rename failed (e.g. permission error).
      console.error(
        `rename failed — ${opts.outfile} has NOT been modified:`,
        err instanceof Error ? err.message : String(err),
      );
    }
    // Clean up the temp file if it still exists.
    if (existsSync(tmp)) {
      try {
        rmSync(tmp);
      } catch {
        console.error(`warning: could not remove temp file ${tmp}`);
      }
    }
    process.exit(1);
  }
}
