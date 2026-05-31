/**
 * Phase 3 — config synthesis.
 * Copies templates/opencode.json into the staging directory so it is embedded
 * in the exe and extracted at runtime. The bootstrap sets OPENCODE_CONFIG to
 * the extracted path so opencode loads it as the default config.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { FetchContext, FetchResult } from "./types.ts";
import { computeDigest, fileSize, ensureDir } from "./util.ts";

/** Path to the source config template, relative to the project root. */
const TEMPLATE_CONFIG = path.resolve(
  new URL("../../templates/opencode.json", import.meta.url).pathname,
);

/** Extraction path within the cache root where the config is placed. */
export const CONFIG_EXTRACT_TO = "config/opencode.json";

/**
 * Stage the embedded default opencode.json config.
 * Copies templates/opencode.json → staging/config/opencode.json.
 * At runtime, bootstrap extracts it and sets OPENCODE_CONFIG to its path.
 */
export async function fetchConfig(ctx: FetchContext): Promise<FetchResult> {
  const destDir = path.join(ctx.stagingRoot, "config");
  const destFile = path.join(destDir, "opencode.json");

  await ensureDir(destDir);
  await fs.copyFile(TEMPLATE_CONFIG, destFile);

  const digest = await computeDigest(destFile);
  const bytes = await fileSize(destFile);

  return [
    {
      id: "config",
      kind: "config",
      version: "embedded",
      digest,
      embedPath: destFile,
      extractTo: CONFIG_EXTRACT_TO,
      archive: "none",
      executable: false,
      bytes,
    },
  ];
}
