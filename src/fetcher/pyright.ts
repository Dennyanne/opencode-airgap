/**
 * Fetcher: Pyright Language Server via npm install.
 *
 * Pyright is a Node.js-based LSP (not a native binary). The langserver entry
 * point is node_modules/pyright/dist/pyright-langserver.js and requires a
 * Node runtime to execute. If Spike 3 (spikes/spike3-node-lsp/) returns
 * DECISION: bun-host, Bun can host it instead of the embedded Node runtime.
 *
 * Strategy:
 *   1. Create staging/lsp/pyright/ directory.
 *   2. Write a minimal package.json there so `bun add` installs into it.
 *   3. Run `bun add --exact pyright` inside that directory.
 *   4. Record the installed version from node_modules/pyright/package.json.
 *   5. Return an AssetEntry with archive="none" (the whole directory is staged
 *      as-is; the embedder zips it, or the bootstrap copies it directly).
 *
 * The embedPath points at the staging directory itself (not an archive) because
 * the build step will decide how to bundle node_module trees.
 *
 * Extraction layout under OPENCODE_AIRGAP_CACHE:
 *   lsp/pyright/
 *     node_modules/pyright/dist/pyright-langserver.js
 *     node_modules/pyright/package.json
 *     package.json
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { ensureDir, retryFetch } from "./util.ts";
import type { FetchContext, FetchResult } from "./types.ts";

const ASSET_ID = "pyright";

interface PackageJson {
  version?: string;
  [key: string]: unknown;
}

/**
 * Resolve the latest published pyright version from the npm registry.
 * Used only when not pinned; the install step itself uses `--exact` so the
 * version recorded here matches what was installed.
 */
async function fetchLatestPyrightVersion(): Promise<string> {
  const res = await retryFetch(() =>
    Bun.fetch("https://registry.npmjs.org/pyright/latest", {
      headers: {
        "User-Agent": "airbuild/1 (https://github.com/sst/opencode)",
        Accept: "application/json",
      },
    }),
  );

  if (!res.ok) {
    throw new Error(
      `[pyright] HTTP ${res.status} fetching latest pyright metadata`,
    );
  }

  const meta = (await res.json()) as PackageJson;
  if (typeof meta.version !== "string") {
    throw new Error("[pyright] npm registry response missing version field");
  }
  return meta.version;
}

/**
 * Install pyright into a staging directory via `bun add` and return an
 * AssetEntry pointing at the staged directory.
 */
export async function fetchPyright(ctx: FetchContext): Promise<FetchResult> {
  const stagingDir = path.join(ctx.stagingRoot, "lsp", "pyright");
  await ensureDir(stagingDir);

  // Determine which version to install.
  const version = ctx.pinnedVersions?.[ASSET_ID]
    ? ctx.pinnedVersions[ASSET_ID]
    : await fetchLatestPyrightVersion();

  // Write a minimal package.json so `bun add` installs locally here.
  const pkgJsonPath = path.join(stagingDir, "package.json");
  const pkgJson = JSON.stringify({ name: "pyright-staging", version: "0.0.0", private: true }, null, 2);
  await Bun.write(pkgJsonPath, pkgJson);

  // Install the exact version.
  const installSpec = `pyright@${version}`;
  process.stderr.write(`[pyright] running: bun add --exact ${installSpec} in ${stagingDir}\n`);

  const proc = Bun.spawn(
    ["bun", "add", "--exact", installSpec],
    {
      cwd: stagingDir,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    process.stderr.write(`[pyright] bun add stdout: ${stdout}\n`);
    process.stderr.write(`[pyright] bun add stderr: ${stderr}\n`);
    throw new Error(`[pyright] bun add exited with code ${exitCode}`);
  }

  // Read back the installed version from the package's own package.json.
  const installedPkgJsonPath = path.join(
    stagingDir,
    "node_modules",
    "pyright",
    "package.json",
  );

  const installedPkgJsonText = await fs.readFile(installedPkgJsonPath, "utf-8");
  const installedPkgJson = JSON.parse(installedPkgJsonText) as PackageJson;
  const installedVersion =
    typeof installedPkgJson.version === "string"
      ? installedPkgJson.version
      : version;

  process.stderr.write(`[pyright] installed pyright@${installedVersion} to ${stagingDir}\n`);

  // Verify pyright-langserver.js is present (sanity check).
  const langserverPath = path.join(
    stagingDir,
    "node_modules",
    "pyright",
    "dist",
    "pyright-langserver.js",
  );
  try {
    await fs.access(langserverPath);
  } catch {
    throw new Error(
      `[pyright] expected langserver binary not found at ${langserverPath}`,
    );
  }

  // The embed path is the staging directory itself; the build step decides
  // how to archive/bundle node_module directories.
  // digest and bytes are not applicable for directory assets (archive="none").
  return [
    {
      id: ASSET_ID,
      kind: "lsp",
      version: installedVersion,
      digest: "",
      embedPath: stagingDir,
      extractTo: "lsp/pyright",
      archive: "none",
      bytes: 0,
    },
  ];
}
