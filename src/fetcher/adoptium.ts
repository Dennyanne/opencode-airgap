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
  resolveVersion,
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

/**
 * Parse the version string out of an Adoptium filename.
 * e.g. "OpenJDK21U-jre_x64_windows_hotspot_21.0.3_9.zip" → "21.0.3+9"
 * e.g. "OpenJDK21U-jre_aarch64_mac_hotspot_21.0.3_9.tar.gz" → "21.0.3+9"
 */
function parseVersionFromFilename(filename: string): string | null {
  // The tail after "hotspot_" is like "21.0.3_9.zip" — map _ back to + for semver.
  const match = filename.match(/hotspot_(\d+\.\d+\.\d+)_(\d+)\./);
  if (match) {
    return `${match[1]}+${match[2]}`;
  }
  return null;
}

/**
 * Issue a HEAD request to the latest-binary URL and follow redirects to
 * discover the resolved filename, which encodes the version.
 */
async function resolveLatestVersion(os: string, arch: string): Promise<string> {
  const url = `${ADOPTIUM_BASE}/binary/latest/21/ga/${os}/${arch}/jre/hotspot/normal/eclipse`;

  // Bun.fetch follows redirects by default; the final URL contains the filename.
  const res = await retryFetch(() =>
    Bun.fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": "airbuild/1 (https://github.com/sst/opencode)" },
      // Bun follows redirects automatically; we want the final URL.
      redirect: "follow",
    }),
  );

  // Try Content-Disposition first.
  const cd = res.headers.get("content-disposition") ?? "";
  const cdMatch = cd.match(/filename="?([^";]+)"?/i);
  if (cdMatch) {
    const ver = parseVersionFromFilename(cdMatch[1]);
    if (ver) return ver;
  }

  // Fall back to parsing the final redirected URL.
  const finalUrl = res.url;
  const urlFilename = finalUrl.split("/").pop() ?? "";
  const ver = parseVersionFromFilename(urlFilename);
  if (ver) return ver;

  throw new Error(
    `[adoptium] Could not parse JRE 21 version from URL "${finalUrl}" or Content-Disposition "${cd}"`,
  );
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

  // Resolve version (pinned or latest).
  const version = await resolveVersion(ctx, ASSET_ID, () =>
    resolveLatestVersion(os, arch),
  );

  // Build download URL.
  let downloadUrl: string;
  if (ctx.pinnedVersions?.[ASSET_ID]) {
    // Adoptium version tags use "+" which must be URL-encoded as "%2B".
    const encodedVersion = encodeURIComponent(version);
    downloadUrl = `${ADOPTIUM_BASE}/binary/version/${encodedVersion}/${os}/${arch}/jre/hotspot/normal/eclipse`;
  } else {
    downloadUrl = `${ADOPTIUM_BASE}/binary/latest/21/ga/${os}/${arch}/jre/hotspot/normal/eclipse`;
  }

  await retryFetch(() => downloadFile(downloadUrl, destPath, `JRE 21 (${os}/${arch})`));

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
