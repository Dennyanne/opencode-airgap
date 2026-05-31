/**
 * Fetcher: Node.js LTS runtime from nodejs.org.
 *
 * Version resolution:
 *   GET https://nodejs.org/dist/index.json — find the first entry where
 *   lts !== false. Its "version" field is the LTS release tag (e.g. "v20.11.0").
 *
 * Download URL patterns:
 *   Windows x64:   https://nodejs.org/dist/{version}/node-{version}-win-x64.zip
 *   Linux x64:     https://nodejs.org/dist/{version}/node-{version}-linux-x64.tar.gz
 *   Darwin arm64:  https://nodejs.org/dist/{version}/node-{version}-darwin-arm64.tar.gz
 *
 * Staging paths:
 *   Windows: {stagingRoot}/runtime/node/node-lts.zip
 *   Other:   {stagingRoot}/runtime/node/node-lts.tar.gz
 *
 * NOTE: If Spike 3 (spikes/spike3-node-lsp/) returns DECISION: bun-host on Windows,
 * this asset can be omitted from the final manifest. The fetcher is still implemented
 * so the build can include or exclude it via a flag (e.g. --no-node-runtime).
 */

import * as path from "node:path";
import {
  downloadFile,
  ensureDir,
  fileSize,
  computeDigest,
  resolveVersion,
  verifyDigest,
  retryFetch,
} from "./util.ts";
import { platformFromTarget } from "./types.ts";
import type { FetchContext, FetchResult } from "./types.ts";

const ASSET_ID = "node-lts";
const INDEX_URL = "https://nodejs.org/dist/index.json";

interface NodeDistEntry {
  version: string;
  lts: string | false;
}

/** Fetch the latest LTS version tag from the nodejs.org dist index. */
async function fetchLatestLtsVersion(): Promise<string> {
  const res = await retryFetch(() =>
    Bun.fetch(INDEX_URL, {
      headers: { "User-Agent": "airbuild/1 (https://github.com/sst/opencode)" },
    }),
  );

  if (!res.ok) {
    throw new Error(
      `[nodejs-rt] HTTP ${res.status} fetching Node.js dist index`,
    );
  }

  const entries = (await res.json()) as NodeDistEntry[];
  const lts = entries.find((e) => e.lts !== false);
  if (!lts) {
    throw new Error("[nodejs-rt] No LTS entry found in nodejs.org dist index");
  }
  return lts.version; // e.g. "v20.11.0"
}

/** Build the download URL and archive extension for the given target and version. */
function buildDownloadUrl(
  target: FetchContext["target"],
  version: string,
): { url: string; archive: "zip" | "tar.gz" } {
  const p = platformFromTarget(target);

  if (p.os === "windows") {
    return {
      url: `https://nodejs.org/dist/${version}/node-${version}-win-x64.zip`,
      archive: "zip",
    };
  }
  if (p.os === "darwin") {
    return {
      url: `https://nodejs.org/dist/${version}/node-${version}-darwin-arm64.tar.gz`,
      archive: "tar.gz",
    };
  }
  // linux x64
  return {
    url: `https://nodejs.org/dist/${version}/node-${version}-linux-x64.tar.gz`,
    archive: "tar.gz",
  };
}

/**
 * Download the Node.js LTS runtime for ctx.target.
 * Stages to: {stagingRoot}/runtime/node/node-lts.{zip|tar.gz}
 */
export async function fetchNodeRuntime(ctx: FetchContext): Promise<FetchResult> {
  const stagingDir = path.join(ctx.stagingRoot, "runtime", "node");
  await ensureDir(stagingDir);

  const version = await resolveVersion(ctx, ASSET_ID, fetchLatestLtsVersion);
  const { url, archive } = buildDownloadUrl(ctx.target, version);

  const ext = archive; // "zip" | "tar.gz"
  const filename = `node-lts.${ext}`;
  const destPath = path.join(stagingDir, filename);

  await retryFetch(() => downloadFile(url, destPath, `Node.js LTS ${version}`));

  await verifyDigest(ctx, ASSET_ID, destPath);

  const digest = await computeDigest(destPath);
  const bytes = await fileSize(destPath);

  return [
    {
      id: ASSET_ID,
      kind: "runtime-node",
      version,
      digest,
      embedPath: destPath,
      extractTo: "runtime/node",
      archive,
      bytes,
    },
  ];
}
