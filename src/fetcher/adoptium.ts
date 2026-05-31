/**
 * Fetcher: Eclipse Temurin JRE 21 from the Adoptium API.
 *
 * Download URL strategy:
 *   - Latest:  https://api.adoptium.net/v3/binary/latest/21/ga/{os}/{arch}/jre/hotspot/normal/eclipse
 *     The redirect chain terminates at a filename like
 *     OpenJDK21U-jre_x64_windows_hotspot_21.0.3_9.zip
 *     from which we parse the version string (e.g. "21.0.3+9").
 *   - Pinned:  https://api.adoptium.net/v3/binary/version/{version}/{os}/{arch}/jre/hotspot/normal/eclipse
 *     where {version} is the full Adoptium release tag (e.g. "21.0.3+9").
 *
 * Platform mapping (from FetchContext.target via platformFromTarget):
 *   bun-windows-x64  → os=windows, arch=x64  → .zip archive
 *   bun-linux-x64    → os=linux,   arch=x64  → .tar.gz archive
 *   bun-darwin-arm64 → os=mac,     arch=aarch64 → .tar.gz archive
 */

import * as path from "node:path";
import {
  downloadFile,
  ensureDir,
  fileSize,
  computeDigest,
  verifyDigest,
  retryFetch,
} from "./util.ts";
import { platformFromTarget } from "./types.ts";
import type { FetchContext, FetchResult } from "./types.ts";

const ASSET_ID = "jre21";
const ADOPTIUM_BASE = "https://api.adoptium.net/v3";

/** Map FetchContext target to Adoptium API path segments. */
function adoptiumPlatform(target: FetchContext["target"]): {
  os: string;
  arch: string;
  archive: "zip" | "tar.gz";
} {
  const p = platformFromTarget(target);
  if (p.os === "windows") {
    return { os: "windows", arch: "x64", archive: "zip" };
  }
  if (p.os === "darwin") {
    return { os: "mac", arch: "aarch64", archive: "tar.gz" };
  }
  // linux x64
  return { os: "linux", arch: "x64", archive: "tar.gz" };
}

const UA = "airbuild/1 (https://github.com/sst/opencode)";

/** A JRE asset resolved from the Adoptium JSON API. */
interface AdoptiumAsset {
  /** Adoptium release name, e.g. "jdk-21.0.7+6" (usable with the version endpoint). */
  version: string;
  /** Direct download URL for the binary package. */
  downloadUrl: string;
  /** SHA-256 hex checksum published by Adoptium for the package. */
  checksum: string;
}

/**
 * Resolve the latest Temurin JRE 21 asset via Adoptium's documented JSON API.
 * This replaces the previous HEAD-redirect/Content-Disposition heuristic, which
 * was brittle: the CDN does not reliably send Content-Disposition on HEAD.
 * The JSON response gives us version, download link, and an authoritative
 * SHA-256 checksum in a single typed call.
 */
async function resolveLatestAsset(os: string, arch: string): Promise<AdoptiumAsset> {
  const url =
    `${ADOPTIUM_BASE}/assets/latest/21/hotspot` +
    `?architecture=${arch}&image_type=jre&os=${os}&vendor=eclipse`;
  const res = await retryFetch(() => Bun.fetch(url, { headers: { "User-Agent": UA } }));
  if (!res.ok) {
    throw new Error(`[adoptium] HTTP ${res.status} fetching ${url}`);
  }
  const arr = (await res.json()) as Array<Record<string, unknown>>;
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error(`[adoptium] empty asset list from ${url}`);
  }
  const first = arr[0];
  const binary = first["binary"] as Record<string, unknown> | undefined;
  const pkg = binary?.["package"] as Record<string, unknown> | undefined;
  const versionData = first["version"] as Record<string, unknown> | undefined;
  const releaseName =
    (typeof first["release_name"] === "string" && (first["release_name"] as string)) ||
    (typeof versionData?.["openjdk_version"] === "string" &&
      (versionData["openjdk_version"] as string)) ||
    "";
  const downloadUrl = typeof pkg?.["link"] === "string" ? (pkg["link"] as string) : "";
  const checksum = typeof pkg?.["checksum"] === "string" ? (pkg["checksum"] as string) : "";
  if (!releaseName || !downloadUrl) {
    throw new Error(
      `[adoptium] unexpected response shape from ${url}: ${JSON.stringify(first).slice(0, 200)}`,
    );
  }
  return { version: releaseName, downloadUrl, checksum };
}

/**
 * Download Temurin JRE 21 for ctx.target.
 * Stages to: {stagingRoot}/runtime/jre/jre21.{zip|tar.gz}
 */
export async function fetchJre21(ctx: FetchContext): Promise<FetchResult> {
  const { os, arch, archive } = adoptiumPlatform(ctx.target);
  const ext = archive; // "zip" | "tar.gz"
  const filename = `jre21.${ext}`;
  const stagingDir = path.join(ctx.stagingRoot, "runtime", "jre");
  const destPath = path.join(stagingDir, filename);

  await ensureDir(stagingDir);

  // Resolve version + download URL (and Adoptium's checksum for latest).
  let version: string;
  let downloadUrl: string;
  let upstreamChecksum = "";
  const pinned = ctx.pinnedVersions?.[ASSET_ID];
  if (pinned) {
    version = pinned;
    const encodedVersion = encodeURIComponent(version);
    downloadUrl = `${ADOPTIUM_BASE}/binary/version/${encodedVersion}/${os}/${arch}/jre/hotspot/normal/eclipse`;
    process.stderr.write(`[fetch] ${ASSET_ID}: using pinned version ${version}\n`);
  } else {
    const asset = await resolveLatestAsset(os, arch);
    version = asset.version;
    downloadUrl = asset.downloadUrl;
    upstreamChecksum = asset.checksum;
    process.stderr.write(`[fetch] ${ASSET_ID}: resolved latest version ${version}\n`);
  }

  await retryFetch(() => downloadFile(downloadUrl, destPath, `JRE 21 (${os}/${arch})`));

  // Cross-verify against Adoptium's published SHA-256 when available.
  if (upstreamChecksum) {
    const actual = await computeDigest(destPath);
    if (actual.toLowerCase() !== upstreamChecksum.toLowerCase()) {
      throw new Error(
        `[adoptium] checksum mismatch for JRE 21:\n` +
          `  expected (Adoptium): ${upstreamChecksum}\n` +
          `  actual:              ${actual}`,
      );
    }
    process.stderr.write(`[adoptium] JRE 21: Adoptium checksum verified OK\n`);
  }

  await verifyDigest(ctx, ASSET_ID, destPath);

  const digest = await computeDigest(destPath);
  const bytes = await fileSize(destPath);

  return [
    {
      id: ASSET_ID,
      kind: "runtime-jre",
      version,
      digest,
      embedPath: destPath,
      extractTo: "runtime/jre",
      archive,
      bytes,
    },
  ];
}
