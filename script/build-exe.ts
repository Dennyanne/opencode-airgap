/**
 * Phase 4 — Step 12: compile the single-exe artifact via `bun build --compile`.
 *
 * Responsibilities:
 *   1. Generate a temporary runtime entry module (staging/.entry.generated.ts)
 *      that imports every manifest asset with `with { type: "file" }`, builds
 *      the embeddedFiles Map consumed by bootstrap(), applies the returned env,
 *      then invokes opencode main.
 *   2. Invoke the Bun compiler. Throw on non-zero exit (AC1).
 *   3. Write asset-manifest.json beside the output exe for reference.
 *
 * versions.lock helpers are co-located here and re-exported for use by the CLI.
 */

import * as fs from "node:fs/promises";
import * as fss from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { AssetManifest, VersionsLock } from "../src/embed/manifest.ts";
import { MANIFEST_FILENAME, VERSIONS_LOCK_FILENAME } from "../src/embed/manifest.ts";
import type { TargetTriple } from "../src/embed/manifest.ts";

// ---------------------------------------------------------------------------
// Public interface — these names are imported verbatim by src/cli/build.ts.
// ---------------------------------------------------------------------------

export interface BuildExeOptions {
  target: TargetTriple;
  outfile: string;
}

// ---------------------------------------------------------------------------
// Entry generator
// ---------------------------------------------------------------------------

/**
 * Staging directory where the generated entry file is written.
 * The tsconfig.json excludes "staging" so this file is not type-checked by tsc.
 */
const STAGING_DIR = path.resolve(import.meta.dir, "..", "staging");
const GENERATED_ENTRY = path.join(STAGING_DIR, ".entry.generated.ts");

/**
 * Bun can only embed single FILES via `import x with { type: "file" }`. Several
 * assets (npm packages, the oh-my-opencode plugin) are staged as DIRECTORIES,
 * so we pack each directory asset into a single .tar.gz under staging/.embed/
 * and rewrite its manifest entry (embedPath/archive/digest/bytes) to point at
 * that archive. Bootstrap unpacks `archive: "tar.gz"` assets into extractTo at
 * runtime. File assets (already-archived upstream downloads) are left as-is.
 *
 * tar is available on all build hosts (Windows 10+ ships bsdtar; Linux/macOS
 * have it natively). Members are stored relative to the directory root so they
 * extract straight into extractTo.
 */
async function packDirectoryAssets(manifest: AssetManifest): Promise<void> {
  const embedDir = path.join(STAGING_DIR, ".embed");
  await fs.mkdir(embedDir, { recursive: true });

  for (const asset of manifest.assets) {
    const abs = path.resolve(asset.embedPath);
    let isDir = false;
    try {
      isDir = (await fs.stat(abs)).isDirectory();
    } catch {
      continue; // missing path; stagingAssetsPresent will catch it
    }
    if (!isDir) continue;

    const safe = asset.id.replace(/[^a-zA-Z0-9_]/g, "_");
    const tarball = path.join(embedDir, `${safe}.tar.gz`);
    const proc = Bun.spawn(["tar", "-czf", tarball, "-C", abs, "."], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(
        `[build-exe] failed to archive directory asset "${asset.id}" ` +
          `(tar exit ${code}): ${err.slice(0, 300)}`,
      );
    }

    // Rewrite the entry so the embedded blob, inlined manifest, and runtime
    // extraction all agree on the archived form.
    asset.embedPath = tarball;
    asset.archive = "tar.gz";
    asset.digest = await computeDigest(tarball);
    asset.bytes = (await fs.stat(tarball)).size;
  }
}

/**
 * Generate the runtime entry TypeScript module and write it to
 * staging/.entry.generated.ts.
 *
 * The generated module:
 *   - Imports every manifest asset with `with { type: "file" }` so Bun embeds
 *     the bytes at compile time (Bun.embeddedFiles / the returned string refs).
 *   - Builds the embeddedFiles Map<id, Blob> that bootstrap() consumes.
 *   - Calls bootstrap(manifest, embeddedFiles) from src/embed/bootstrap.ts.
 *   - Applies the returned env overlay to process.env.
 *   - Delegates to opencode main.
 */
async function generateEntry(manifest: AssetManifest): Promise<string> {
  await fs.mkdir(STAGING_DIR, { recursive: true });
  // Build the import block.  Each asset gets a unique identifier derived from
  // its id with non-identifier characters replaced by underscores.
  const importLines: string[] = [];
  const mapEntries: string[] = [];

  for (const asset of manifest.assets) {
    const ident = `__asset_${asset.id.replace(/[^a-zA-Z0-9_]/g, "_")}`;
    // embedPath is the build-time path under staging/ recorded in the manifest.
    // The import path in the generated file is relative to staging/.
    const rel = path.relative(STAGING_DIR, path.resolve(asset.embedPath));
    // Use forward slashes for the import specifier regardless of OS.
    const spec = rel.split(path.sep).join("/");
    // A `with { type: "file" }` import resolves to the embedded file's PATH
    // (a string), not its bytes — so we must read it via Bun.file(), which is
    // a Blob whose .arrayBuffer() yields the real embedded contents. Wrapping
    // the path string in `new Blob([...])` would embed the path text instead,
    // failing the runtime digest check.
    importLines.push(`import ${ident} from "./${spec}" with { type: "file" };`);
    mapEntries.push(`  embeddedFiles.set(${JSON.stringify(asset.id)}, Bun.file(${ident}));`);
  }

  // Manifest JSON is inlined as a string literal so it is part of the exe.
  const manifestJson = JSON.stringify(manifest);

  const source = `\
// AUTO-GENERATED by script/build-exe.ts — do not edit by hand.
// This file is re-created on every build and is excluded from tsc.

${importLines.join("\n")}

import { bootstrap } from "../src/embed/bootstrap.ts";

const manifest = JSON.parse(${JSON.stringify(manifestJson)}) as import("../src/embed/manifest.ts").AssetManifest;

const embeddedFiles = new Map<string, Blob>();
${mapEntries.join("\n")}

const result = await bootstrap(manifest, embeddedFiles);

// Apply the env overlay returned by bootstrap before launching opencode.
for (const [key, value] of Object.entries(result.env)) {
  process.env[key] = value;
}

if (!result.opencodeBinary) {
  process.stderr.write("[airgap] FATAL: opencode binary not found in the extracted cache.\\n");
  process.exit(1);
}

// Launch the extracted opencode binary, forwarding CLI args and inheriting the
// terminal so the TUI works. In a Bun-compiled exe process.argv is
// [bun, <embedded entry>, ...userArgs], so user args start at index 2.
//
// Use async Bun.spawn (not spawnSync): spawnSync does not hand the parent's
// interactive console (TTY) to the child on Windows, so opencode's TUI reads an
// immediate EOF on stdin and exits the moment it launches. Non-interactive
// subcommands like \`--version\` survive because they never read stdin. Async
// spawn with inherited stdio attaches the real terminal, keeping the TUI alive.
const child = Bun.spawn([result.opencodeBinary, ...process.argv.slice(2)], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});
const exitCode = await child.exited;
process.exit(exitCode ?? 1);
`;

  await fs.writeFile(GENERATED_ENTRY, source, "utf-8");
  return GENERATED_ENTRY;
}

// ---------------------------------------------------------------------------
// Compiler invocation
// ---------------------------------------------------------------------------

/**
 * Determine whether staging assets are present.
 * Returns true only when at least the generated entry file exists AND all
 * asset embedPaths are resolvable on disk.
 *
 * This guard lets `buildExe` log the dry-run compile command and return early
 * without failing type-check when assets have not yet been staged (which is
 * normal for this dev machine during Phase 4 authoring).
 */
async function stagingAssetsPresent(manifest: AssetManifest): Promise<boolean> {
  // If there are no assets, nothing to check — treat as "present" so the
  // stub-manifest path (empty assets array) exercises the compiler invocation.
  if (manifest.assets.length === 0) {
    // Still need the generated entry itself; check that separately below.
    return fss.existsSync(GENERATED_ENTRY);
  }
  for (const asset of manifest.assets) {
    if (!fss.existsSync(path.resolve(asset.embedPath))) {
      return false;
    }
  }
  return fss.existsSync(GENERATED_ENTRY);
}

/**
 * Construct the `bun build --compile` argv array for the given options and
 * generated entry file.  Kept as a pure function so callers can unit-inspect
 * the command without spawning a child process.
 *
 * Note: Windows .exe icon / VERSIONINFO metadata cannot be embedded when
 * cross-compiling from macOS or Linux — Bun does not support `--windows-icon`
 * or `--windows-version-info` in cross-compile mode as of Bun 1.3.x.
 */
export function buildCompileArgv(
  entryFile: string,
  opts: BuildExeOptions,
): string[] {
  return [
    "bun",
    "build",
    "--compile",
    `--target=${opts.target}`,
    entryFile,
    "--outfile",
    opts.outfile,
  ];
}

// ---------------------------------------------------------------------------
// Main export — called by src/cli/build.ts
// ---------------------------------------------------------------------------

/**
 * Compile the single-exe artifact.
 *
 * Steps:
 *   1. Generate staging/.entry.generated.ts from the manifest.
 *   2. If staging assets are absent, log the dry-run command and return early
 *      (dev-machine guard — does not fail the build tool or tsc).
 *   3. Spawn `bun build --compile …`.  Throw on non-zero exit (AC1).
 *   4. Write asset-manifest.json beside the exe for reference.
 */
export async function buildExe(
  manifest: AssetManifest,
  opts: BuildExeOptions,
): Promise<{ outfile: string }> {
  // Step 0: pack directory assets into single archives so Bun can embed them.
  await packDirectoryAssets(manifest);

  // Step 1: generate the entry module.
  const entryFile = await generateEntry(manifest);

  // Construct the compiler argv regardless — callers can inspect it.
  const argv = buildCompileArgv(entryFile, opts);

  // Step 2: guard for missing staging assets.
  const assetsReady = await stagingAssetsPresent(manifest);
  if (!assetsReady) {
    process.stderr.write(
      `[build-exe] staging assets not present — skipping compile.\n` +
        `[build-exe] would run: ${argv.join(" ")}\n`,
    );
    // Write manifest for reference even in dry-run mode.
    await writeManifestJson(manifest, opts.outfile);
    await copyNoticesBesideExe(opts.outfile);
    return { outfile: opts.outfile };
  }

  // Step 3: invoke the compiler.
  const proc = Bun.spawn(argv, {
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(
      `[build-exe] bun build --compile exited with code ${exitCode}. Command: ${argv.join(" ")}`,
    );
  }

  // For Windows targets, `bun build --compile` appends ".exe" when the outfile
  // does not already end in it (e.g. an "*.exe.tmp" temp path used by update).
  // Normalize back to exactly opts.outfile so callers (and the atomic rename in
  // `airbuild update`) find the file where they expect it.
  if (opts.target === "bun-windows-x64" && !opts.outfile.endsWith(".exe")) {
    const produced = `${opts.outfile}.exe`;
    if (fss.existsSync(produced)) {
      await fs.rename(produced, opts.outfile);
    }
  }

  // Step 4: write manifest beside the exe.
  await writeManifestJson(manifest, opts.outfile);
  await copyNoticesBesideExe(opts.outfile);

  return { outfile: opts.outfile };
}

// ---------------------------------------------------------------------------
// Manifest JSON output helper
// ---------------------------------------------------------------------------

async function writeManifestJson(manifest: AssetManifest, exePath: string): Promise<void> {
  const manifestPath = path.join(path.dirname(path.resolve(exePath)), MANIFEST_FILENAME);
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

/** File name of the third-party license notices shipped beside the exe. */
const NOTICES_FILENAME = "THIRD-PARTY-NOTICES.md";

/**
 * Copy THIRD-PARTY-NOTICES.md next to the exe so the bundle is always
 * distributed with the third-party license notices required when
 * redistributing the embedded software. Best-effort: a missing notices file
 * warns but never fails the build.
 */
async function copyNoticesBesideExe(exePath: string): Promise<void> {
  const src = path.resolve(import.meta.dir, "..", NOTICES_FILENAME);
  const dest = path.join(path.dirname(path.resolve(exePath)), NOTICES_FILENAME);
  try {
    await fs.copyFile(src, dest);
  } catch (err) {
    process.stderr.write(
      `[build-exe] warning: could not copy ${NOTICES_FILENAME} beside exe ` +
        `(${err instanceof Error ? err.message : String(err)}). ` +
        `Ship it manually — it is required to redistribute the bundled software.\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// versions.lock helpers  (AC8 — reproducibility)
// ---------------------------------------------------------------------------

/**
 * Serialize a VersionsLock to disk as pretty-printed JSON.
 * This is the single source of truth for `--from-lock` reproducible rebuilds
 * and for runtime integrity verification.
 */
export async function writeVersionsLock(lock: VersionsLock, lockPath: string): Promise<void> {
  await fs.mkdir(path.dirname(path.resolve(lockPath)), { recursive: true });
  await fs.writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n", "utf-8");
}

/**
 * Read and validate a versions.lock file.
 *
 * Validates:
 *   - The file is valid JSON.
 *   - `schema === 1` — throws on mismatch so callers surface version drift
 *     before any assets are fetched.
 *
 * Used by `airbuild build --from-lock` (AC8) to pin every asset to the exact
 * version+digest+source recorded in a prior successful build.
 */
export async function readVersionsLock(lockPath: string): Promise<VersionsLock> {
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[versions-lock] cannot read lock file "${lockPath}": ${msg}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[versions-lock] invalid JSON in "${lockPath}": ${msg}`);
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Record<string, unknown>)["schema"] !== 1
  ) {
    throw new Error(
      `[versions-lock] schema mismatch in "${lockPath}": expected schema=1, ` +
        `got schema=${JSON.stringify((parsed as Record<string, unknown>)["schema"] ?? null)}`,
    );
  }

  return parsed as VersionsLock;
}

/**
 * Compute the sha256 hex digest of a file on disk.
 * Uses Bun.CryptoHasher — the same algorithm that bootstrap.ts uses for
 * runtime integrity checks, so build-time and runtime digests match exactly.
 */
export async function computeDigest(filePath: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const data = await fs.readFile(filePath);
  hasher.update(data);
  return hasher.digest("hex");
}

// Re-export for callers that want to derive the lock path from an exe path
// without importing manifest.ts directly.
export { VERSIONS_LOCK_FILENAME, MANIFEST_FILENAME };
