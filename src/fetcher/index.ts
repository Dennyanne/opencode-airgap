/**
 * Phase 2 — asset staging orchestrator.
 * Composes all sub-fetchers and returns a fully-populated AssetManifest.
 *
 * Called by src/cli/build.ts::stageAssets() to replace the TODO(phase2) stub.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AssetManifest, VersionsLock, TargetTriple } from "../embed/manifest.ts";
import { TOOL_VERSION } from "../cli/version.ts";
import type { FetchContext } from "./types.ts";

import { fetchOpencodeCore, fetchOpencodeTUI, fetchJdtls, fetchGopls } from "./github.ts";
import {
  fetchOhMyOpencode,
  fetchVolar,
  fetchTsserver,
  fetchFilesystemMcp,
  fetchAstGrep,
} from "./npm.ts";
import { fetchJre21 } from "./adoptium.ts";
import { fetchNodeRuntime } from "./nodejs-rt.ts";
import { fetchPyright } from "./pyright.ts";
import { fetchConfig } from "./config.ts";

/** Default staging root — staging/ relative to the project root.
 *  Use fileURLToPath, not URL.pathname: on Windows the latter yields a
 *  leading-slash path like "/C:/..." that path.resolve mis-reads, producing
 *  a duplicated drive ("C:\C:\..."). */
const DEFAULT_STAGING_ROOT = fileURLToPath(
  new URL("../../staging", import.meta.url),
);

export interface StageAssetsOptions {
  target: TargetTriple;
  stagingRoot?: string;
  /**
   * When provided, pin each asset to the version+digest recorded in the lock
   * instead of resolving latest (airbuild build --from-lock).
   */
  pinnedLock?: VersionsLock;
  /**
   * When true, skip embedding Node runtime. Set after Spike 3 confirms
   * DECISION: bun-host on Windows (saves ~50-80 MB).
   */
  skipNodeRuntime?: boolean;
}

/**
 * Fetch and stage all assets required for the target platform.
 * Returns a fully-populated AssetManifest ready for script/build-exe.ts.
 */
export async function stageAssets(opts: StageAssetsOptions): Promise<AssetManifest> {
  const stagingRoot = opts.stagingRoot ?? DEFAULT_STAGING_ROOT;

  // Build pin maps from the lock if provided.
  const pinnedVersions: Record<string, string> = {};
  const pinnedDigests: Record<string, string> = {};
  if (opts.pinnedLock) {
    for (const a of opts.pinnedLock.assets) {
      pinnedVersions[a.id] = a.version;
      pinnedDigests[a.id] = a.digest;
    }
  }

  const ctx: FetchContext = {
    target: opts.target,
    stagingRoot,
    pinnedVersions: Object.keys(pinnedVersions).length > 0 ? pinnedVersions : undefined,
    pinnedDigests: Object.keys(pinnedDigests).length > 0 ? pinnedDigests : undefined,
  };

  console.log(`[stage] target=${opts.target}  root=${stagingRoot}`);

  // Run all fetchers. Independent groups run concurrently; order within a
  // group only matters where one fetch depends on another's output.
  const [
    coreEntries,
    tuiEntries,
    pluginEntries,
    jdtlsEntries,
    volarEntries,
    tsserverEntries,
    filesystemEntries,
    astGrepEntries,
    jreEntries,
    pyrightEntries,
    goplsEntries,
    nodeEntries,
    configEntries,
  ] = await Promise.all([
    fetchOpencodeCore(ctx).then(log("opencode-core")),
    fetchOpencodeTUI(ctx).then(log("tui")),
    fetchOhMyOpencode(ctx).then(log("oh-my-opencode")),
    fetchJdtls(ctx).then(log("jdtls")),
    fetchVolar(ctx).then(log("volar")),
    fetchTsserver(ctx).then(log("tsserver")),
    fetchFilesystemMcp(ctx).then(log("mcp-filesystem")),
    fetchAstGrep(ctx).then(log("ast-grep")),
    fetchJre21(ctx).then(log("jre21")),
    fetchPyright(ctx).then(log("pyright")),
    fetchGopls(ctx).then(log("gopls")),
    opts.skipNodeRuntime
      ? Promise.resolve([])
      : fetchNodeRuntime(ctx).then(log("node-lts")),
    fetchConfig(ctx).then(log("config")),
  ]);

  const assets = [
    ...coreEntries,
    ...tuiEntries,
    ...pluginEntries,
    ...jdtlsEntries,
    ...volarEntries,
    ...tsserverEntries,
    ...filesystemEntries,
    ...astGrepEntries,
    ...jreEntries,
    ...pyrightEntries,
    ...goplsEntries,
    ...nodeEntries,
    ...configEntries,
  ];

  // Derive key versions from the staged assets for the manifest header.
  const opencodeVersion =
    assets.find((a) => a.id === "opencode-core")?.version ?? "unknown";
  const pluginVersion =
    assets.find((a) => a.id === "oh-my-opencode")?.version ?? "unknown";

  const cacheNamespace = `opencode-airgap/${opencodeVersion}`;

  const manifest: AssetManifest = {
    schema: 1,
    toolVersion: TOOL_VERSION,
    opencodeVersion,
    pluginVersion,
    target: opts.target,
    builtAt: new Date().toISOString(),
    cacheNamespace,
    assets,
  };

  console.log(
    `[stage] done — ${assets.length} assets, opencode@${opencodeVersion}, plugin@${pluginVersion}`,
  );
  return manifest;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type FetchResult = Awaited<ReturnType<typeof fetchOpencodeCore>>;

function log(label: string): (r: FetchResult) => FetchResult {
  return (r) => {
    if (r.length === 0) {
      console.log(`  [stage] ${label}: no assets (skipped or not found)`);
    } else {
      for (const a of r) {
        const mb = (a.bytes / 1_048_576).toFixed(1);
        console.log(`  [stage] ${label}: ${a.id}@${a.version} (${mb} MB)`);
      }
    }
    return r;
  };
}
