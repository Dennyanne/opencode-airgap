/**
 * GitHub release fetchers for Phase 2 asset staging.
 * Fetches: opencode core, opencode TUI, jdtls, gopls.
 */

import * as path from "node:path";
import {
  ensureDir,
  downloadFile,
  retryFetch,
  computeDigest,
  fileSize,
  resolveVersion,
  verifyDigest,
} from "./util.ts";
import { platformFromTarget } from "./types.ts";
import type { FetchContext, FetchResult } from "./types.ts";
import type { AssetEntry } from "./types.ts";

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

const GH_API = "https://api.github.com";
const UA = "airbuild/1 (https://github.com/sst/opencode)";

/**
 * Fetch the latest release tag_name for a GitHub repo.
 * Retried via retryFetch.
 */
export async function getLatestReleaseTag(
  owner: string,
  repo: string,
): Promise<string> {
  return retryFetch(async () => {
    const url = `${GH_API}/repos/${owner}/${repo}/releases/latest`;
    process.stderr.write(`[github] GET ${url}\n`);
    const res = await Bun.fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) {
      throw new Error(`[github] HTTP ${res.status} fetching latest release for ${owner}/${repo}`);
    }
    const json = (await res.json()) as Record<string, unknown>;
    const tag = json["tag_name"];
    if (typeof tag !== "string") {
      throw new Error(`[github] unexpected response shape from ${url}: ${JSON.stringify(json).slice(0, 200)}`);
    }
    return tag;
  });
}

/**
 * Find a release asset whose name matches namePattern for the given tag.
 * Returns the browser_download_url of the first matching asset.
 * Throws if no asset matches.
 */
export async function getReleaseAssetUrl(
  owner: string,
  repo: string,
  tag: string,
  namePattern: RegExp,
): Promise<string> {
  return retryFetch(async () => {
    const url = `${GH_API}/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`;
    process.stderr.write(`[github] GET ${url}\n`);
    const res = await Bun.fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) {
      throw new Error(`[github] HTTP ${res.status} fetching release ${tag} for ${owner}/${repo}`);
    }
    const json = (await res.json()) as Record<string, unknown>;
    const assets = json["assets"];
    if (!Array.isArray(assets)) {
      throw new Error(`[github] no assets array in release ${tag} for ${owner}/${repo}`);
    }
    for (const asset of assets) {
      const name: unknown = (asset as Record<string, unknown>)["name"];
      if (typeof name === "string" && namePattern.test(name)) {
        const dlUrl: unknown = (asset as Record<string, unknown>)["browser_download_url"];
        if (typeof dlUrl !== "string") {
          throw new Error(`[github] asset "${name}" has no browser_download_url`);
        }
        return dlUrl;
      }
    }
    const names = (assets as Array<Record<string, unknown>>)
      .map((a) => a["name"])
      .filter((n) => typeof n === "string")
      .join(", ");
    throw new Error(
      `[github] no asset matching ${namePattern} in release ${tag} for ${owner}/${repo}. ` +
        `Available: ${names || "(none)"}`,
    );
  });
}

// ---------------------------------------------------------------------------
// 1. opencode core
// ---------------------------------------------------------------------------

/**
 * Fetch the opencode core binary from sst/opencode GitHub releases.
 * Windows x64 asset: opencode-x86_64-pc-windows-msvc.exe (or similar .exe).
 */
export async function fetchOpencodeCore(ctx: FetchContext): Promise<FetchResult> {
  const { os, exeSuffix } = platformFromTarget(ctx.target);
  const isWin = os === "windows";

  const version = await resolveVersion(ctx, "opencode-core", () =>
    getLatestReleaseTag("sst", "opencode"),
  );

  // Build an appropriate asset name pattern per platform.
  let assetPattern: RegExp;
  if (isWin) {
    // Matches: opencode-x86_64-pc-windows-msvc.exe, opencode_windows_x64.exe, etc.
    assetPattern = /opencode.*(?:windows.*x(?:64|86_64)|x86_64.*windows).*\.exe$/i;
  } else if (os === "linux") {
    assetPattern = /opencode.*(?:linux.*x(?:64|86_64)|x86_64.*linux)/i;
  } else {
    // darwin
    assetPattern = /opencode.*(?:darwin|macos|mac).*(?:arm64|aarch64)/i;
  }

  const assetUrl = await getReleaseAssetUrl("sst", "opencode", version, assetPattern);

  const stagingDir = path.join(ctx.stagingRoot, "opencode-core");
  await ensureDir(stagingDir);
  const fileName = `opencode${exeSuffix}`;
  const destPath = path.join(stagingDir, fileName);

  await retryFetch(() => downloadFile(assetUrl, destPath, `opencode-core ${version}`));
  await verifyDigest(ctx, "opencode-core", destPath);

  const digest = await computeDigest(destPath);
  const bytes = await fileSize(destPath);

  const entry: AssetEntry = {
    id: "opencode-core",
    kind: "opencode-core",
    version,
    digest,
    embedPath: destPath,
    extractTo: isWin ? "opencode/opencode.exe" : "opencode/opencode",
    archive: "none",
    executable: true,
    bytes,
  };

  return [entry];
}

// ---------------------------------------------------------------------------
// 2. opencode TUI
// ---------------------------------------------------------------------------

/**
 * Fetch the opencode TUI binary from sst/opencode GitHub releases.
 * If no separate TUI asset is found, logs a warning and returns [].
 */
export async function fetchOpencodeTUI(ctx: FetchContext): Promise<FetchResult> {
  const { os } = platformFromTarget(ctx.target);
  const isWin = os === "windows";

  const version = await resolveVersion(ctx, "tui", () =>
    getLatestReleaseTag("sst", "opencode"),
  );

  // TUI asset pattern — may not exist in every release.
  let assetPattern: RegExp;
  if (isWin) {
    assetPattern = /(?:opencode.*tui.*windows|tui.*windows)/i;
  } else if (os === "linux") {
    assetPattern = /(?:opencode.*tui.*linux|tui.*linux)/i;
  } else {
    assetPattern = /(?:opencode.*tui.*(?:darwin|mac)|tui.*(?:darwin|mac))/i;
  }

  let assetUrl: string;
  try {
    assetUrl = await getReleaseAssetUrl("sst", "opencode", version, assetPattern);
  } catch (err) {
    process.stderr.write(
      `[github] warning: no TUI asset found for sst/opencode ${version} — skipping. ` +
        `(${err instanceof Error ? err.message : String(err)})\n`,
    );
    return [];
  }

  const stagingDir = path.join(ctx.stagingRoot, "tui");
  await ensureDir(stagingDir);
  const destPath = path.join(stagingDir, isWin ? "opencode-tui.exe" : "opencode-tui");

  await retryFetch(() => downloadFile(assetUrl, destPath, `opencode-tui ${version}`));
  await verifyDigest(ctx, "tui", destPath);

  const digest = await computeDigest(destPath);
  const bytes = await fileSize(destPath);

  const entry: AssetEntry = {
    id: "tui",
    kind: "tui",
    version,
    digest,
    embedPath: destPath,
    extractTo: isWin ? "tui/opencode-tui.exe" : "tui/opencode-tui",
    archive: "none",
    executable: true,
    bytes,
  };

  return [entry];
}

// ---------------------------------------------------------------------------
// 3. jdtls
// ---------------------------------------------------------------------------

/**
 * Fetch the Eclipse JDT Language Server tarball from eclipse-jdtls/eclipse.jdt.ls.
 */
export async function fetchJdtls(ctx: FetchContext): Promise<FetchResult> {
  const version = await resolveVersion(ctx, "jdtls", () =>
    getLatestReleaseTag("eclipse-jdtls", "eclipse.jdt.ls"),
  );

  // Asset: org.eclipse.jdt.ls.product-*.tar.gz or similar snapshot tarballs.
  const assetPattern = /org\.eclipse\.jdt\.ls.*\.tar\.gz$/i;

  const assetUrl = await getReleaseAssetUrl(
    "eclipse-jdtls",
    "eclipse.jdt.ls",
    version,
    assetPattern,
  );

  const stagingDir = path.join(ctx.stagingRoot, "lsp", "jdtls");
  await ensureDir(stagingDir);
  const destPath = path.join(stagingDir, "jdtls.tar.gz");

  await retryFetch(() => downloadFile(assetUrl, destPath, `jdtls ${version}`));
  await verifyDigest(ctx, "jdtls", destPath);

  const digest = await computeDigest(destPath);
  const bytes = await fileSize(destPath);

  const entry: AssetEntry = {
    id: "jdtls",
    kind: "lsp",
    version,
    digest,
    embedPath: destPath,
    extractTo: "lsp/jdtls",
    archive: "tar.gz",
    executable: false,
    bytes,
  };

  return [entry];
}

// ---------------------------------------------------------------------------
// 4. gopls
// ---------------------------------------------------------------------------

/**
 * Fetch the gopls binary from golang/tools GitHub releases.
 * Release tags are of the form `gopls/v0.x.y`.
 * Binary assets are named `gopls_0.x.y_{os}_{arch}.zip`.
 */
export async function fetchGopls(ctx: FetchContext): Promise<FetchResult> {
  const { os, arch } = platformFromTarget(ctx.target);

  // Determine platform suffix used in gopls asset names.
  let goplsOs: string;
  let goplsArch: string;
  if (os === "windows") {
    goplsOs = "windows";
    goplsArch = "amd64";
  } else if (os === "linux") {
    goplsOs = "linux";
    goplsArch = "amd64";
  } else {
    // darwin
    goplsOs = "darwin";
    goplsArch = arch === "arm64" ? "arm64" : "amd64";
  }

  const version = await resolveVersion(ctx, "gopls", () =>
    fetchLatestGoplsVersion(),
  );

  // Strip the leading "v" to get the bare version number used in asset names.
  const bare = version.replace(/^v/, "");

  // Asset name: gopls_0.x.y_windows_amd64.zip
  const assetPattern = new RegExp(
    `^gopls_${bare.replace(/\./g, "\\.")}_${goplsOs}_${goplsArch}\\.zip$`,
    "i",
  );

  // The tag in the repo is `gopls/v0.x.y` — URL-encoded as `gopls%2Fv0.x.y`.
  const fullTag = `gopls/v${bare}`;

  const assetUrl = await getReleaseAssetUrl("golang", "tools", fullTag, assetPattern);

  const stagingDir = path.join(ctx.stagingRoot, "lsp", "gopls");
  await ensureDir(stagingDir);
  const destPath = path.join(stagingDir, "gopls.zip");

  await retryFetch(() => downloadFile(assetUrl, destPath, `gopls ${version}`));
  await verifyDigest(ctx, "gopls", destPath);

  const digest = await computeDigest(destPath);
  const bytes = await fileSize(destPath);

  const entry: AssetEntry = {
    id: "gopls",
    kind: "lsp",
    version,
    digest,
    embedPath: destPath,
    extractTo: "lsp/gopls",
    archive: "zip",
    executable: false,
    bytes,
  };

  return [entry];
}

// ---------------------------------------------------------------------------
// gopls version helper
// ---------------------------------------------------------------------------

/**
 * Find the latest gopls release from golang/tools.
 * Iterates the releases list (paginated) to find the first tag starting with
 * `gopls/v`, then returns the bare version (e.g. "v0.16.1").
 */
async function fetchLatestGoplsVersion(): Promise<string> {
  return retryFetch(async () => {
    const url = `${GH_API}/repos/golang/tools/releases?per_page=20`;
    process.stderr.write(`[github] GET ${url}\n`);
    const res = await Bun.fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) {
      throw new Error(`[github] HTTP ${res.status} fetching golang/tools releases`);
    }
    const releases = (await res.json()) as Array<Record<string, unknown>>;
    for (const release of releases) {
      const tag = release["tag_name"];
      if (typeof tag === "string" && tag.startsWith("gopls/v")) {
        // Return just the "v0.x.y" portion.
        return tag.slice("gopls/".length);
      }
    }
    throw new Error("[github] no gopls/v* tag found in golang/tools releases (first 20)");
  });
}
