import { readFileSync } from "fs";
import type { TargetTriple, VersionsLock } from "../embed/manifest.ts";
import type { BuildExeOptions } from "../../script/build-exe.ts";
import { buildExe } from "../../script/build-exe.ts";
import { stageAssets } from "../fetcher/index.ts";

export interface BuildOpts {
  target: TargetTriple;
  outfile: string;
  /** If set, pin asset versions to those recorded in this versions.lock file. */
  fromLock?: string;
}

/**
 * Parse a versions.lock JSON file and return the typed value.
 * Throws on malformed content — the caller surfaces the error.
 */
function loadVersionsLock(lockPath: string): VersionsLock {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf-8");
  } catch {
    throw new Error(`cannot read lock file: ${lockPath}`);
  }
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Record<string, unknown>)["schema"] !== 1
  ) {
    throw new Error(`invalid versions.lock schema in ${lockPath}`);
  }
  return parsed as VersionsLock;
}

/**
 * Main entry point for the `airbuild build` subcommand.
 *
 * Orchestration:
 *   1. (optional) load versions.lock for pinned reproducible rebuild
 *   2. Stage all assets via src/fetcher/index.ts (Phase 2)
 *   3. TODO(phase3): synthesize opencode.json config from templates/opencode.json
 *   4. Compile single exe via script/build-exe.ts (Phase 4)
 */
export async function runBuild(opts: BuildOpts): Promise<void> {
  let pinnedLock: VersionsLock | undefined;
  if (opts.fromLock) {
    console.log(`loading versions.lock from ${opts.fromLock}`);
    pinnedLock = loadVersionsLock(opts.fromLock);
    console.log(
      `pinning to opencode@${pinnedLock.opencodeVersion} plugin@${pinnedLock.pluginVersion}`,
    );
  }

  console.log(`staging assets for target ${opts.target}...`);
  const manifest = await stageAssets({ target: opts.target, pinnedLock });

  // Phase 3 complete: fetchConfig() in stageAssets() stages templates/opencode.json
  // → staging/config/opencode.json and adds it as a "config" AssetEntry. At
  // runtime the bootstrap seeds it into ~/.config/opencode when absent.

  console.log(`compiling exe → ${opts.outfile}`);
  const exeOpts: BuildExeOptions = { target: opts.target, outfile: opts.outfile };
  const result = await buildExe(manifest, exeOpts);
  console.log(`build complete: ${result.outfile}`);
}
