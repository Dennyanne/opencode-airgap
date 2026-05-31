/**
 * Runtime bootstrap for the air-gapped single-exe build.
 *
 * Responsibility: on first run, extract embedded assets to a per-version local
 * cache, verify integrity, set env vars, and return the resolved environment
 * ready for opencode main. On subsequent runs with a valid cache, skip
 * extraction and return immediately.
 *
 * This module is safety-critical: it must never silently accept a corrupt or
 * partial cache. Any integrity failure triggers a full re-extraction.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import {
  type AssetManifest,
  type AssetEntry,
  COMPLETE_SENTINEL,
  EXTRACT_LOCK,
  CACHE_NAMESPACE_PREFIX,
} from "./manifest.ts";

// ------------------------------------------------------------------
// Public types
// ------------------------------------------------------------------

export interface BootstrapResult {
  /** Absolute path of the resolved per-version cache root. */
  cacheRoot: string;
  /** Env vars to apply before launching opencode. Callers must apply these. */
  env: Record<string, string>;
  /** True if extraction ran during this invocation; false if cache was valid. */
  extracted: boolean;
}

// ------------------------------------------------------------------
// Constants
// ------------------------------------------------------------------

/** Millis before a lock held by a still-alive PID is considered stale. */
const LOCK_STALE_MS = 5 * 60 * 1000; // 5 minutes
/** How long to wait for another process to finish extraction before giving up. */
const LOCK_WAIT_TIMEOUT_MS = 120 * 1000; // 2 minutes
/** Poll interval while waiting for another process to finish. */
const LOCK_POLL_INTERVAL_MS = 1_000;
/** Windows MAX_PATH hard limit. */
const WIN_MAX_PATH = 260;

// ------------------------------------------------------------------
// Step 11a — target path selection
// ------------------------------------------------------------------

/**
 * Probe whether `dir` is writable by creating and removing a sentinel file.
 * Returns true only if the probe round-trips successfully.
 */
async function isWritable(dir: string): Promise<boolean> {
  const probe = path.join(dir, `.write-probe-${process.pid}`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(probe, "");
    await fs.unlink(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Select the first writable candidate root for the extraction cache.
 *
 * Candidates (in priority order):
 *   1. %LOCALAPPDATA%\<namespace>
 *   2. %TEMP%\<namespace>
 *   3. <dir-of-exe>\.cache\<namespace>
 *
 * On non-Windows hosts this function uses equivalent env vars so typechecking
 * and testing work on macOS/Linux while Windows-specific vars are preferred at
 * runtime.
 */
export async function resolveCacheRoot(namespace: string): Promise<string> {
  const exeDir = path.dirname(process.execPath);

  const candidates: string[] = [
    // Windows primary
    process.env["LOCALAPPDATA"]
      ? path.join(process.env["LOCALAPPDATA"], namespace)
      : "",
    // Fallback 1: temp dir (works cross-platform, good enough for air-gap)
    path.join(os.tmpdir(), namespace),
    // Fallback 2: beside the exe (last resort; may be read-only in Program Files)
    path.join(exeDir, ".cache", namespace),
  ].filter(Boolean);

  let shortest: string | null = null;

  for (const candidate of candidates) {
    if (process.platform === "win32" && candidate.length > WIN_MAX_PATH - 50) {
      // Leave headroom for files under this root; warn and skip.
      process.stderr.write(
        `[bootstrap] WARNING: candidate path too long (${candidate.length} chars), skipping: ${candidate}\n`,
      );
      continue;
    }
    if (await isWritable(candidate)) {
      // Priority-ordered list: first writable candidate wins.
      shortest = candidate;
      break;
    }
  }

  if (shortest === null) {
    throw new Error(
      `[bootstrap] No writable cache root found. Tried: ${candidates.join(", ")}`,
    );
  }
  return shortest;
}

// ------------------------------------------------------------------
// Step 11b — concurrency lock
// ------------------------------------------------------------------

interface LockPayload {
  pid: number;
  timestamp: number;
}

function lockPath(cacheRoot: string): string {
  return path.join(cacheRoot, EXTRACT_LOCK);
}

function sentinelPath(cacheRoot: string): string {
  return path.join(cacheRoot, COMPLETE_SENTINEL);
}

/** Returns true if a process with the given PID is running. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // ESRCH = no such process; EPERM = exists but no permission (still alive).
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EPERM") {
      return true;
    }
    return false;
  }
}

/**
 * Acquire the extraction lock using CREATE_NEW semantics (`flag: "wx"`).
 * Returns true if this process won the lock.
 * Returns false if another live, non-stale process holds the lock.
 * Reclaims a stale lock (dead PID or timestamp > LOCK_STALE_MS) automatically.
 */
async function acquireLock(cacheRoot: string): Promise<boolean> {
  const lk = lockPath(cacheRoot);
  await fs.mkdir(cacheRoot, { recursive: true });

  const payload: LockPayload = { pid: process.pid, timestamp: Date.now() };

  try {
    // "wx" = O_CREAT | O_EXCL — fails if file already exists (Windows CREATE_NEW).
    await fs.writeFile(lk, JSON.stringify(payload), { flag: "wx" });
    return true;
  } catch (err: unknown) {
    if (!isErrnoCode(err, "EEXIST")) {
      throw err;
    }
    // Lock exists — inspect it.
    return await handleExistingLock(cacheRoot, lk, payload);
  }
}

async function handleExistingLock(
  cacheRoot: string,
  lk: string,
  ourPayload: LockPayload,
): Promise<boolean> {
  let existing: LockPayload | null = null;
  try {
    existing = JSON.parse(await fs.readFile(lk, "utf8")) as LockPayload;
  } catch {
    // Unreadable lock — treat as stale.
  }

  const isStale =
    existing === null ||
    !isPidAlive(existing.pid) ||
    Date.now() - existing.timestamp > LOCK_STALE_MS;

  if (isStale) {
    // Reclaim by overwriting (best-effort; a race here is benign — the winner
    // of the overwrite will proceed and the loser will re-enter the poll path).
    try {
      await fs.writeFile(lk, JSON.stringify(ourPayload));
      return true;
    } catch {
      return false;
    }
  }

  // Another live process holds the lock; we are the waiter.
  return false;
}

/**
 * Release the lock. Only removes the file if it still contains our PID (guards
 * against accidentally removing a lock reclaimed by another process).
 */
async function releaseLock(cacheRoot: string): Promise<void> {
  const lk = lockPath(cacheRoot);
  try {
    const content = JSON.parse(await fs.readFile(lk, "utf8")) as LockPayload;
    if (content.pid === process.pid) {
      await fs.unlink(lk);
    }
  } catch {
    // Already gone or unreadable — nothing to do.
  }
}

/**
 * Wait for the winning process to finish extraction (indicated by the presence
 * of COMPLETE_SENTINEL). Polls every LOCK_POLL_INTERVAL_MS.
 * Throws if the timeout is exceeded without a sentinel appearing.
 */
async function waitForExtraction(cacheRoot: string): Promise<void> {
  const sentinel = sentinelPath(cacheRoot);
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      await fs.access(sentinel);
      return; // Sentinel found — extraction complete.
    } catch {
      // Not yet; keep polling.
    }
    await sleep(LOCK_POLL_INTERVAL_MS);
  }

  throw new Error(
    `[bootstrap] Timed out waiting for extraction to complete (${LOCK_WAIT_TIMEOUT_MS / 1000}s). ` +
      `Remove ${lockPath(cacheRoot)} manually if the other process crashed.`,
  );
}

// ------------------------------------------------------------------
// Step 11c — integrity verification & extraction
// ------------------------------------------------------------------

/** Compute sha256 hex digest of a file on disk. */
async function sha256File(filePath: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const data = await fs.readFile(filePath);
  hasher.update(data);
  return hasher.digest("hex");
}

/** Compute sha256 hex digest of a Blob (embedded file). */
async function sha256Blob(blob: Blob): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const buf = await blob.arrayBuffer();
  hasher.update(buf);
  return hasher.digest("hex");
}

/**
 * Verify the on-disk cache is complete and intact:
 *   1. COMPLETE_SENTINEL must exist.
 *   2. Spot-check every asset: the file must exist and its sha256 must match
 *      AssetEntry.digest. (Full check — never trust partial presence.)
 *
 * Returns true only if every check passes.
 */
async function verifyCacheIntegrity(
  cacheRoot: string,
  assets: AssetEntry[],
): Promise<boolean> {
  // Fast path: sentinel must exist.
  try {
    await fs.access(sentinelPath(cacheRoot));
  } catch {
    return false;
  }

  // Full digest check for every non-archive asset.
  for (const asset of assets) {
    const dest = path.join(cacheRoot, asset.extractTo);
    let actual: string;
    try {
      actual = await sha256File(dest);
    } catch {
      // Missing file.
      return false;
    }
    if (actual !== asset.digest) {
      process.stderr.write(
        `[bootstrap] Integrity mismatch for ${asset.id}: expected ${asset.digest}, got ${actual}\n`,
      );
      return false;
    }
  }

  return true;
}

/**
 * Unpack an archive asset that was extracted to `rawPath`.
 * Currently only the "none" (plain copy) case is fully implemented.
 *
 * TODO(phase4-entry): Implement zip/tar.gz unpacking. Bun has no built-in
 * decompression for arbitrary archives; options:
 *   a) Bundle a tiny embedded `unzip.exe` / `tar` binary as a "tool" asset
 *      and invoke it via `Bun.spawn` after its own extraction completes.
 *   b) Use a pure-JS/TS zip library (e.g. fflate) bundled into the exe.
 *   c) Use Node's `node:zlib` + streaming tar parse for tar.gz.
 * The extraction caller must unpack archives AFTER renaming the temp dir but
 * BEFORE writing COMPLETE_SENTINEL so partial unpacks are detected on retry.
 */
async function unpackArchive(
  asset: AssetEntry,
  rawPath: string,
  destDir: string,
): Promise<void> {
  if (!asset.archive || asset.archive === "none") {
    // Plain file: already at the right place, nothing to unpack.
    return;
  }

  if (asset.archive === "zip") {
    // TODO(phase4-entry): spawn embedded unzip tool or use fflate.
    throw new Error(
      `[bootstrap] zip unpacking not yet implemented for asset "${asset.id}". ` +
        `See TODO(phase4-entry) in unpackArchive.`,
    );
  }

  if (asset.archive === "tar.gz") {
    // TODO(phase4-entry): stream-decompress with node:zlib + tar parser.
    throw new Error(
      `[bootstrap] tar.gz unpacking not yet implemented for asset "${asset.id}". ` +
        `See TODO(phase4-entry) in unpackArchive.`,
    );
  }

  // Exhaustive narrowing guard.
  const _: never = asset.archive;
  throw new Error(`[bootstrap] Unknown archive type: ${_}`);
}

/**
 * Extract all assets into a temp sibling directory, verify checksums, then
 * atomically rename to the final cache root, and write COMPLETE_SENTINEL.
 *
 * On any failure the temp dir is cleaned up so the next run re-extracts cleanly.
 */
async function extractAssets(
  cacheRoot: string,
  assets: AssetEntry[],
  embeddedFiles: Map<string, Blob>,
): Promise<void> {
  const tmpRoot = `${cacheRoot}.tmp-${process.pid}`;

  // Clean up any leftover temp dir from a prior crashed run.
  await fs.rm(tmpRoot, { recursive: true, force: true });

  try {
    await fs.mkdir(tmpRoot, { recursive: true });

    for (const asset of assets) {
      const blob = embeddedFiles.get(asset.id);
      if (!blob) {
        throw new Error(
          `[bootstrap] Embedded file not found for asset id "${asset.id}". ` +
            `The exe may be corrupt or built with a mismatched manifest.`,
        );
      }

      // Verify the blob's digest before writing to disk.
      const blobDigest = await sha256Blob(blob);
      if (blobDigest !== asset.digest) {
        throw new Error(
          `[bootstrap] Digest mismatch for embedded asset "${asset.id}": ` +
            `expected ${asset.digest}, got ${blobDigest}`,
        );
      }

      const dest = path.join(tmpRoot, asset.extractTo);
      await fs.mkdir(path.dirname(dest), { recursive: true });

      const buf = await blob.arrayBuffer();
      await fs.writeFile(dest, new Uint8Array(buf));

      // On POSIX targets, mark executable bits for binary assets.
      if (asset.executable && process.platform !== "win32") {
        await fs.chmod(dest, 0o755);
      }

      // Unpack archive formats (zip/tar.gz) in-place.
      if (asset.archive && asset.archive !== "none") {
        await unpackArchive(asset, dest, path.join(tmpRoot, path.dirname(asset.extractTo)));
      }
    }

    // All files written and verified; atomically promote temp → final.
    // Remove any previously failed partial extraction that somehow got renamed.
    await fs.rm(cacheRoot, { recursive: true, force: true });
    await fs.rename(tmpRoot, cacheRoot);

    // Write sentinel LAST — this is the signal that the cache is trustworthy.
    await fs.writeFile(sentinelPath(cacheRoot), String(Date.now()));
  } catch (err) {
    // Clean up the temp dir so the next run starts fresh.
    await fs.rm(tmpRoot, { recursive: true, force: true });
    throw err;
  }
}

// ------------------------------------------------------------------
// Step 11d — env setup
// ------------------------------------------------------------------

/**
 * Build the env overlay to apply before launching opencode.
 * Reads extracted asset paths from the manifest to wire JAVA_HOME, PATH, etc.
 */
function buildEnv(
  cacheRoot: string,
  assets: AssetEntry[],
): Record<string, string> {
  const env: Record<string, string> = {
    OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
    // Resolved cache root for {env:OPENCODE_AIRGAP_CACHE} placeholders in opencode.json.
    OPENCODE_AIRGAP_CACHE: cacheRoot,
    // Disable the oh-my-opencode plugin's PostHog telemetry. On an air-gapped
    // host the outbound call to us.i.posthog.com cannot complete, so leaving it
    // on stalls startup on DNS/TCP timeouts every run. These are the plugin's
    // own published opt-out switches, so this just exercises its supported API.
    OMO_DISABLE_POSTHOG: "1",
    OMO_SEND_ANONYMOUS_TELEMETRY: "0",
    OMO_CODEX_DISABLE_POSTHOG: "1",
    OMO_CODEX_SEND_ANONYMOUS_TELEMETRY: "0",
    // NOTE: we deliberately do NOT set OPENCODE_CONFIG here. Instead,
    // seedUserConfig() copies the bundled default config into the user's
    // ~/.config/opencode directory on first run (only when absent), so
    // opencode resolves it from the standard location and any user edits in
    // that directory are preserved. A user-set OPENCODE_CONFIG still wins
    // because opencode honours it and we never override it.
  };

  const pathPrepends: string[] = [];

  for (const asset of assets) {
    const assetDir = path.join(cacheRoot, path.dirname(asset.extractTo));

    switch (asset.kind) {
      case "runtime-jre":
        // JAVA_HOME points to the JRE root (parent of bin/).
        env["JAVA_HOME"] = assetDir;
        pathPrepends.push(path.join(assetDir, "bin"));
        break;

      case "runtime-node":
        // Prepend the Node bin dir so LSPs and MCPs find the right node.
        pathPrepends.push(assetDir);
        break;

      case "lsp":
      case "mcp":
      case "tool":
        // Prepend the asset's directory so native binaries are on PATH.
        pathPrepends.push(assetDir);
        break;

      default:
        // opencode-core, tui, plugin — no PATH wiring needed here.
        break;
    }
  }

  if (pathPrepends.length > 0) {
    const separator = process.platform === "win32" ? ";" : ":";
    const existing = process.env["PATH"] ?? "";
    // Deduplicate while preserving order.
    const unique = [...new Set(pathPrepends)];
    env["PATH"] = unique.join(separator) + (existing ? separator + existing : "");
  }

  return env;
}

// ------------------------------------------------------------------
// Step 11e — seed user config directory
// ------------------------------------------------------------------

/** Resolve opencode's config directory, mirroring its own XDG-based lookup. */
function userConfigDir(): string {
  const configHome =
    process.env["XDG_CONFIG_HOME"] || path.join(os.homedir(), ".config");
  return path.join(configHome, "opencode");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively copy files from srcDir into destDir, skipping any whose
 * destination already exists. Existing user files are never overwritten.
 */
async function copyMissing(srcDir: string, destDir: string): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(srcDir, { withFileTypes: true });
  } catch {
    return; // nothing bundled to seed
  }
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyMissing(src, dest);
    } else if (!(await pathExists(dest))) {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
      process.stderr.write(`[bootstrap] seeded default config → ${dest}\n`);
    }
  }
}

/**
 * On every run, ensure the user's ~/.config/opencode directory is seeded with
 * the bundled default config. Files are copied only when absent, so user edits
 * persist across runs and updates. Best-effort: a failure here must not block
 * launching opencode.
 */
async function seedUserConfig(cacheRoot: string): Promise<void> {
  const dest = userConfigDir();
  try {
    // 1. Bundled default opencode.json (and any other files under config/).
    await copyMissing(path.join(cacheRoot, "config"), dest);
    // 2. The oh-my-opencode plugin ships its own .opencode/command and
    //    .opencode/skills; opencode auto-loads them from ~/.config/opencode.
    //    copyMissing is a no-op if the plugin or these dirs are absent.
    const pluginOpencodeDir = path.join(
      cacheRoot,
      "plugin",
      "oh-my-opencode",
      "node_modules",
      "oh-my-opencode",
      ".opencode",
    );
    await copyMissing(path.join(pluginOpencodeDir, "command"), path.join(dest, "command"));
    await copyMissing(path.join(pluginOpencodeDir, "skills"), path.join(dest, "skills"));
  } catch (err: unknown) {
    process.stderr.write(
      `[bootstrap] warning: could not seed default config: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }
}

/** Seed the user config dir, then assemble the bootstrap result. */
async function buildResult(
  cacheRoot: string,
  assets: AssetEntry[],
  extracted: boolean,
): Promise<BootstrapResult> {
  await seedUserConfig(cacheRoot);
  return { cacheRoot, env: buildEnv(cacheRoot, assets), extracted };
}

// ------------------------------------------------------------------
// Top-level bootstrap
// ------------------------------------------------------------------

/**
 * Bootstrap the air-gapped exe.
 *
 * 1. Resolve a writable cache root (Step 11a).
 * 2. Acquire the extraction lock (Step 11b).
 * 3. Check for a valid, complete cache. If absent or corrupt, extract (Step 11c).
 * 4. Build and return the env overlay (Step 11d).
 *
 * The caller (exe entry point) must apply `result.env` to process.env before
 * delegating to opencode main.
 *
 * TODO(phase4-entry): After applying result.env, the exe entry should invoke
 * opencode's main entry point, e.g.:
 *   const { main } = await import("../opencode/index.ts");
 *   await main();
 */
export async function bootstrap(
  manifest: AssetManifest,
  embeddedFiles: Map<string, Blob>,
): Promise<BootstrapResult> {
  const baseNamespace = `${CACHE_NAMESPACE_PREFIX}\\${manifest.cacheNamespace}`;
  const cacheRoot = await resolveCacheRoot(baseNamespace);

  // Fast path: check if the cache is already valid before taking the lock.
  // This is the common case on every run after the first.
  if (await verifyCacheIntegrity(cacheRoot, manifest.assets)) {
    return await buildResult(cacheRoot, manifest.assets, false);
  }

  // Slow path: we need to extract. Take the concurrency lock.
  const won = await acquireLock(cacheRoot);

  if (!won) {
    // Another process is extracting — wait for it to finish, then use its result.
    process.stderr.write(
      `[bootstrap] Another process is extracting to ${cacheRoot}. Waiting...\n`,
    );
    await waitForExtraction(cacheRoot);

    // Verify the cache the winner produced.
    if (!(await verifyCacheIntegrity(cacheRoot, manifest.assets))) {
      throw new Error(
        `[bootstrap] Cache at ${cacheRoot} is still invalid after waiting for peer extraction.`,
      );
    }

    return await buildResult(cacheRoot, manifest.assets, false);
  }

  // We hold the lock. Re-check integrity in case another process finished
  // between our first check and lock acquisition.
  try {
    if (await verifyCacheIntegrity(cacheRoot, manifest.assets)) {
      return await buildResult(cacheRoot, manifest.assets, false);
    }

    process.stderr.write(
      `[bootstrap] Extracting ${manifest.assets.length} assets to ${cacheRoot}...\n`,
    );
    await extractAssets(cacheRoot, manifest.assets, embeddedFiles);
    process.stderr.write(`[bootstrap] Extraction complete.\n`);

    return await buildResult(cacheRoot, manifest.assets, true);
  } finally {
    await releaseLock(cacheRoot);
  }
}

// ------------------------------------------------------------------
// Utilities
// ------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isErrnoCode(err: unknown, code: string): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === code
  );
}
