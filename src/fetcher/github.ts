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
 * Build headers for api.github.com requests. A build-time GITHUB_TOKEN / GH_TOKEN
 * (never embedded in the exe, never on the air-gapped target) lifts the
 * unauthenticated 60 req/hr rate limit to 5000 req/hr, avoiding the HTTP 403
 * that otherwise breaks the build on shared CI IPs.
 */
function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": UA,
    Accept: "application/vnd.github+json",
  };
  const token = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return headers;
}

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
    const res = await Bun.fetch(url, { headers: githubHeaders() });
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
    const res = await Bun.fetch(url, { headers: githubHeaders() });
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
 * Stage the gopls binary (Go LSP).
 *
 * gopls is NOT distributed as a GitHub release binary — golang/tools only
 * publishes `gopls/vX.Y.Z` tags with no attached assets. Its only supported
 * channel is `go install golang.org/x/tools/gopls@vX.Y.Z`, which downloads the
 * module through the official, sum-verified Go module proxy (no third-party
 * mirrors). We build it on the BUILD machine when a Go toolchain is present.
 *
 * Go LSP is optional: if Go is not on PATH, or the build fails, we log a clear
 * warning and SKIP it (return []) rather than failing the whole build.
 */
export async function fetchGopls(ctx: FetchContext): Promise<FetchResult> {
  const { os, arch } = platformFromTarget(ctx.target);
  const goOs = os === "windows" ? "windows" : os === "linux" ? "linux" : "darwin";
  const goArch = os === "darwin" && arch === "arm64" ? "arm64" : "amd64";
  const exe = goOs === "windows" ? ".exe" : "";

  try {
    if (!Bun.which("go")) {
      process.stderr.write(
        "[gopls] Go toolchain not found on PATH — skipping Go LSP. gopls ships " +
          "only via `go install`; install Go on the build machine to include it.\n",
      );
      return [];
    }

    const version = await resolveVersion(ctx, "gopls", () => fetchLatestGoplsVersion());
    const bare = version.replace(/^v/, "");

    const stagingDir = path.join(ctx.stagingRoot, "lsp", "gopls");
    await ensureDir(stagingDir);

    // Build from source via the official module proxy (Go verifies it against
    // sum.golang.org). GOBIN captures the binary; GOOS/GOARCH cross-compile.
    process.stderr.write(
      `[gopls] go install golang.org/x/tools/gopls@v${bare} (GOOS=${goOs} GOARCH=${goArch})\n`,
    );
    const proc = Bun.spawn(["go", "install", `golang.org/x/tools/gopls@v${bare}`], {
      env: { ...process.env, GOBIN: stagingDir, GOOS: goOs, GOARCH: goArch, CGO_ENABLED: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const errText = await new Response(proc.stderr).text();
      process.stderr.write(
        `[gopls] go install failed (exit ${code}) — skipping Go LSP:\n${errText.slice(0, 500)}\n`,
      );
      return [];
    }

    // Native builds land in GOBIN; cross-compiles land in GOBIN/{GOOS}_{GOARCH}/.
    const candidates = [
      path.join(stagingDir, `gopls${exe}`),
      path.join(stagingDir, `${goOs}_${goArch}`, `gopls${exe}`),
    ];
    let binPath = "";
    for (const c of candidates) {
      if (await Bun.file(c).exists()) {
        binPath = c;
        break;
      }
    }
    if (!binPath) {
      process.stderr.write(
        `[gopls] go install reported success but no binary found under ${stagingDir} — skipping.\n`,
      );
      return [];
    }

    await verifyDigest(ctx, "gopls", binPath);
    const digest = await computeDigest(binPath);
    const bytes = await fileSize(binPath);

    const entry: AssetEntry = {
      id: "gopls",
      kind: "lsp",
      version: `v${bare}`,
      digest,
      embedPath: binPath,
      extractTo: `lsp/gopls/gopls${exe}`,
      archive: "none",
      executable: true,
      bytes,
    };
    return [entry];
  } catch (err) {
    process.stderr.write(
      `[gopls] skipped — ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return [];
  }
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
    const res = await Bun.fetch(url, { headers: githubHeaders() });
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
