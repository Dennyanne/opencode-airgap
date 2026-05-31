/**
 * Phase 3 — config synthesis.
 * Copies templates/opencode.json into the staging directory so it is embedded
 * in the exe and extracted at runtime. On first run the bootstrap seeds the
 * extracted default into the user's ~/.config/opencode directory (only when
 * absent), so opencode loads it from the standard location.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchContext, FetchResult } from "./types.ts";
import { computeDigest, fileSize, ensureDir } from "./util.ts";

/** Path to the source config template, relative to the project root.
 *  Use fileURLToPath, not URL.pathname (Windows yields "/C:/..." which
 *  path.resolve turns into a duplicated drive "C:\C:\..."). */
const TEMPLATE_CONFIG = fileURLToPath(
  new URL("../../templates/opencode.json", import.meta.url),
);

/** Extraction path within the cache root where the config is placed. */
export const CONFIG_EXTRACT_TO = "config/opencode.json";

/**
 * Stage the embedded default opencode.json config.
 * Copies templates/opencode.json → staging/config/opencode.json.
 * At runtime, bootstrap extracts it and seeds it into ~/.config/opencode
 * when that file does not already exist.
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
