/**
 * npm-based asset fetchers for Phase 2.
 * Each fetcher installs a package (or set of packages) into a staging directory
 * using `bun add --exact`, then returns an AssetEntry describing the result.
 *
 * embedPath for directory assets is the absolute path of the staging directory.
 * digest is computed as the sha256 of staging/<id>/package.json (the build step
 * must handle directory assets specially — see build-exe.ts).
 */

import { join } from "path";
import { readFileSync, existsSync, writeFileSync } from "fs";
import type { FetchContext, FetchResult, AssetEntry } from "./types.ts";
import { platformFromTarget } from "./types.ts";
import { ensureDir, retryFetch, computeDigest, fileSize } from "./util.ts";

// ---------------------------------------------------------------------------
// Core helpers
// ---------------------------------------------------------------------------

/**
 * Fetch the latest published version of an npm package from the registry.
 * Returns the version string, e.g. "1.2.3".
 */
async function getNpmLatestVersion(pkg: string): Promise<string> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(pkg).replace(/%40/, "@").replace(/%2F/, "/")}/latest`;
  const res = await retryFetch<Response>(() =>
    fetch(url).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${url}`);
      return r;
    }),
  );
  const data = (await res.json()) as { version: string };
  return data.version;
}

/** sha256 of a file; returns "" and logs a warning if file is missing. */
async function safeDigest(filePath: string): Promise<string> {
  try { return await computeDigest(filePath); } catch { return ""; }
}

/** Size in bytes of a file; returns 0 if missing. */
async function safeSizeOf(filePath: string): Promise<number> {
  try { return await fileSize(filePath); } catch { return 0; }
}

/**
 * Create a minimal staging package.json (commonjs, private) if none exists,
 * run `bun add --exact <packages...>` in stagingDir, then read back the
 * resolved versions from the written package.json.
 *
 * Returns a map of package name → resolved version.
 */
async function installNpmPackage(
  stagingDir: string,
  packages: string[],
): Promise<{ resolvedVersions: Record<string, string> }> {
  await ensureDir(stagingDir);

  const pkgJsonPath = join(stagingDir, "package.json");
  if (!existsSync(pkgJsonPath)) {
    writeFileSync(
      pkgJsonPath,
      JSON.stringify({ name: "staging", private: true, type: "commonjs" }, null, 2),
      "utf8",
    );
  }

  const proc = Bun.spawn(
    ["bun", "add", "--exact", ...packages],
    {
      cwd: stagingDir,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(
      `bun add failed in ${stagingDir} (exit ${exitCode}):\n${stderr}`,
    );
  }

  // Bun rewrites package.json with the pinned versions it resolved.
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };

  const deps = pkgJson.dependencies ?? {};
  // Strip leading "^", "~", "=" characters to get bare version strings.
  const resolvedVersions: Record<string, string> = {};
  for (const [name, ver] of Object.entries(deps)) {
    resolvedVersions[name] = ver.replace(/^[~^=]/, "");
  }

  return { resolvedVersions };
}

// ---------------------------------------------------------------------------
// Exported fetchers
// ---------------------------------------------------------------------------

/**
 * Fetch the oh-my-opencode plugin package.
 * Tries `oh-my-opencode` first; falls back to `oh-my-openagent` if the primary
 * package returns a 404 from the registry.
 */
export async function fetchOhMyOpencode(ctx: FetchContext): Promise<FetchResult> {
  const id = "oh-my-opencode";
  const stagingDir = join(ctx.stagingRoot, "plugin");

  let pkgName = "oh-my-opencode";
  let version: string;

  if (ctx.pinnedVersions?.[id]) {
    version = ctx.pinnedVersions[id];
  } else {
    try {
      version = await getNpmLatestVersion("oh-my-opencode");
    } catch {
      // Fallback to alternate package name.
      pkgName = "oh-my-openagent";
      version = await getNpmLatestVersion("oh-my-openagent");
    }
  }

  const { resolvedVersions } = await installNpmPackage(stagingDir, [
    `${pkgName}@${version}`,
  ]);

  const resolvedVersion = resolvedVersions[pkgName] ?? version;

  const pkgJsonPath = join(stagingDir, "package.json");
  const digest = await safeDigest(pkgJsonPath);

  if (ctx.pinnedDigests?.[id] && ctx.pinnedDigests[id] !== digest) {
    throw new Error(
      `Digest mismatch for ${id}: expected ${ctx.pinnedDigests[id]}, got ${digest}`,
    );
  }

  const entry: AssetEntry = {
    id,
    kind: "plugin",
    version: resolvedVersion,
    digest,
    embedPath: stagingDir,
    extractTo: "plugin/oh-my-opencode",
    archive: "none",
    bytes: await safeSizeOf(pkgJsonPath),
  };

  return [entry];
}

/**
 * Fetch the @vue/language-server (Volar) LSP package.
 */
export async function fetchVolar(ctx: FetchContext): Promise<FetchResult> {
  const id = "volar";
  const pkgName = "@vue/language-server";
  const stagingDir = join(ctx.stagingRoot, "lsp", "volar");

  let version: string;
  if (ctx.pinnedVersions?.[id]) {
    version = ctx.pinnedVersions[id];
  } else {
    version = await getNpmLatestVersion(pkgName);
  }

  const { resolvedVersions } = await installNpmPackage(stagingDir, [
    `${pkgName}@${version}`,
  ]);

  const resolvedVersion = resolvedVersions[pkgName] ?? version;

  const pkgJsonPath = join(stagingDir, "package.json");
  const digest = await safeDigest(pkgJsonPath);

  if (ctx.pinnedDigests?.[id] && ctx.pinnedDigests[id] !== digest) {
    throw new Error(
      `Digest mismatch for ${id}: expected ${ctx.pinnedDigests[id]}, got ${digest}`,
    );
  }

  const entry: AssetEntry = {
    id,
    kind: "lsp",
    version: resolvedVersion,
    digest,
    embedPath: stagingDir,
    extractTo: "lsp/volar",
    archive: "none",
    bytes: await safeSizeOf(pkgJsonPath),
  };

  return [entry];
}

/**
 * Fetch typescript-language-server + typescript into the same staging directory.
 * Both packages are required for the tsserver LSP.
 */
export async function fetchTsserver(ctx: FetchContext): Promise<FetchResult> {
  const id = "tsserver";
  const stagingDir = join(ctx.stagingRoot, "lsp", "tsserver");

  // Resolve versions — either pinned or latest.
  // The pinnedVersions key is the asset id "tsserver"; we use it to pin
  // typescript-language-server and derive typescript@latest separately.
  let tlsVersion: string;
  let tsVersion: string;

  if (ctx.pinnedVersions?.[id]) {
    tlsVersion = ctx.pinnedVersions[id];
    tsVersion = await getNpmLatestVersion("typescript");
  } else {
    [tlsVersion, tsVersion] = await Promise.all([
      getNpmLatestVersion("typescript-language-server"),
      getNpmLatestVersion("typescript"),
    ]);
  }

  const { resolvedVersions } = await installNpmPackage(stagingDir, [
    `typescript-language-server@${tlsVersion}`,
    `typescript@${tsVersion}`,
  ]);

  const resolvedVersion =
    resolvedVersions["typescript-language-server"] ?? tlsVersion;

  const pkgJsonPath = join(stagingDir, "package.json");
  const digest = await safeDigest(pkgJsonPath);

  if (ctx.pinnedDigests?.[id] && ctx.pinnedDigests[id] !== digest) {
    throw new Error(
      `Digest mismatch for ${id}: expected ${ctx.pinnedDigests[id]}, got ${digest}`,
    );
  }

  const entry: AssetEntry = {
    id,
    kind: "lsp",
    version: resolvedVersion,
    digest,
    embedPath: stagingDir,
    extractTo: "lsp/tsserver",
    archive: "none",
    bytes: await safeSizeOf(pkgJsonPath),
  };

  return [entry];
}

/**
 * Fetch the @modelcontextprotocol/server-filesystem MCP server package.
 */
export async function fetchFilesystemMcp(ctx: FetchContext): Promise<FetchResult> {
  const id = "mcp-filesystem";
  const pkgName = "@modelcontextprotocol/server-filesystem";
  const stagingDir = join(ctx.stagingRoot, "mcp", "filesystem");

  let version: string;
  if (ctx.pinnedVersions?.[id]) {
    version = ctx.pinnedVersions[id];
  } else {
    version = await getNpmLatestVersion(pkgName);
  }

  const { resolvedVersions } = await installNpmPackage(stagingDir, [
    `${pkgName}@${version}`,
  ]);

  const resolvedVersion = resolvedVersions[pkgName] ?? version;

  const pkgJsonPath = join(stagingDir, "package.json");
  const digest = await safeDigest(pkgJsonPath);

  if (ctx.pinnedDigests?.[id] && ctx.pinnedDigests[id] !== digest) {
    throw new Error(
      `Digest mismatch for ${id}: expected ${ctx.pinnedDigests[id]}, got ${digest}`,
    );
  }

  const entry: AssetEntry = {
    id,
    kind: "mcp",
    version: resolvedVersion,
    digest,
    embedPath: stagingDir,
    extractTo: "mcp/filesystem",
    archive: "none",
    bytes: await safeSizeOf(pkgJsonPath),
  };

  return [entry];
}

/**
 * Map from npmOs + arch to the @ast-grep/napi-* optional package name.
 */
function astGrepNativePackage(
  npmOs: "win32" | "linux" | "darwin",
  arch: "x64" | "arm64",
): string {
  if (npmOs === "win32" && arch === "x64") return "@ast-grep/napi-win32-x64-msvc";
  if (npmOs === "linux" && arch === "x64") return "@ast-grep/napi-linux-x64-gnu";
  if (npmOs === "darwin" && arch === "arm64") return "@ast-grep/napi-darwin-arm64";
  // Fallback for any other combination.
  return `@ast-grep/napi-${npmOs}-${arch}-gnu`;
}

/**
 * Find the native ast-grep binary inside the installed node_modules tree.
 * Searches common locations:
 *   - node_modules/<nativePkg>/sg (or sg.exe)
 *   - node_modules/@ast-grep/cli/node_modules/<nativePkg>/sg (nested)
 */
function findAstGrepBinary(
  stagingDir: string,
  nativePkg: string,
  exeSuffix: string,
): string | undefined {
  const binaryName = `sg${exeSuffix}`;
  const candidates = [
    join(stagingDir, "node_modules", nativePkg, binaryName),
    join(stagingDir, "node_modules", "@ast-grep", "cli", "node_modules", nativePkg, binaryName),
    join(stagingDir, "node_modules", nativePkg, "sg"),
    join(stagingDir, "node_modules", nativePkg, "ast-grep" + exeSuffix),
  ];

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

/**
 * Fetch @ast-grep/cli plus the platform-specific native binary package.
 * The native binary is marked executable in the AssetEntry.
 */
export async function fetchAstGrep(ctx: FetchContext): Promise<FetchResult> {
  const id = "ast-grep";
  const stagingDir = join(ctx.stagingRoot, "tool", "ast-grep");

  const platform = platformFromTarget(ctx.target);
  const nativePkg = astGrepNativePackage(platform.npmOs, platform.arch);

  let cliVersion: string;
  if (ctx.pinnedVersions?.[id]) {
    cliVersion = ctx.pinnedVersions[id];
  } else {
    cliVersion = await getNpmLatestVersion("@ast-grep/cli");
  }

  // Install the CLI wrapper and the native package at the same version.
  const { resolvedVersions } = await installNpmPackage(stagingDir, [
    `@ast-grep/cli@${cliVersion}`,
    `${nativePkg}@${cliVersion}`,
  ]);

  const resolvedVersion = resolvedVersions["@ast-grep/cli"] ?? cliVersion;

  const pkgJsonPath = join(stagingDir, "package.json");
  const digest = await safeDigest(pkgJsonPath);

  if (ctx.pinnedDigests?.[id] && ctx.pinnedDigests[id] !== digest) {
    throw new Error(
      `Digest mismatch for ${id}: expected ${ctx.pinnedDigests[id]}, got ${digest}`,
    );
  }

  // Locate the native binary and record it as executable.
  // If the binary is not found (cross-compile or optional dep not extracted),
  // we still return the directory entry — the build step logs a warning.
  const binaryPath = findAstGrepBinary(stagingDir, nativePkg, platform.exeSuffix);

  const entry: AssetEntry = {
    id,
    kind: "tool",
    version: resolvedVersion,
    digest,
    embedPath: stagingDir,
    extractTo: "tool/ast-grep",
    archive: "none",
    executable: binaryPath !== undefined,
    bytes: await safeSizeOf(pkgJsonPath),
  };

  return [entry];
}
