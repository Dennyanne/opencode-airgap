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
  /**
   * Absolute path to the extracted opencode executable to spawn, or "" if the
   * opencode-core asset is absent / its binary could not be located.
   */
  opencodeBinary: string;
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

  // bsdtar ships with Windows 10+, Linux, and macOS and extracts BOTH .zip and
  // .tar.gz (it auto-detects the format), giving one cross-platform code path.
  const proc = Bun.spawn(["tar", "-xf", rawPath, "-C", destDir], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(
      `[bootstrap] failed to extract ${asset.archive} asset "${asset.id}" ` +
        `(tar exit ${code}): ${err.slice(0, 300)}`,
    );
  }
}

/** Windows raises these transiently while AV / the indexer hold a handle. */
const TRANSIENT_FS_CODES = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"]);

function errnoCode(err: unknown): string | undefined {
  return err && typeof err === "object" && "code" in err
    ? (err as { code?: string }).code
    : undefined;
}

/**
 * Move a single filesystem entry from `src` to `dest`, riding out the transient
 * EPERM/EACCES/EBUSY failures Windows raises while antivirus or the search
 * indexer briefly hold a handle on just-extracted files (node.exe, npm under
 * node_modules, the JRE, …). If rename keeps failing — some Windows directory
 * renames, e.g. trees containing junctions, never succeed via MoveFileEx no
 * matter how long we wait — fall back to a recursive copy + remove so the
 * flatten always completes.
 */
async function moveEntry(src: string, dest: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await fs.rename(src, dest);
      return;
    } catch (err: unknown) {
      lastErr = err;
      const code = errnoCode(err);
      if (!code || !TRANSIENT_FS_CODES.has(code)) throw err;
      await sleep(250 * Math.pow(2, attempt)); // 0.25s, 0.5s … ~8s
    }
  }
  // Last resort: copy the tree into place, then delete the source. Copying
  // succeeds in the locked-handle / junction cases where rename cannot.
  try {
    await fs.cp(src, dest, { recursive: true, force: true });
    await fs.rm(src, { recursive: true, force: true });
  } catch {
    throw lastErr;
  }
}

/**
 * If `dir` contains exactly one entry and it is a directory, hoist that inner
 * directory's contents up one level. Upstream archives (Temurin JRE, Node.js,
 * opencode) wrap everything in a single top-level folder; our own
 * directory-asset tarballs store multiple entries at the root, so this is a
 * no-op for them.
 */
async function flattenLoneTopDir(dir: string): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isDirectory()) return;
  const inner = path.join(dir, entries[0].name);
  for (const name of await fs.readdir(inner)) {
    await moveEntry(path.join(inner, name), path.join(dir, name));
  }
  await fs.rm(inner, { recursive: true, force: true });
}

/**
 * Promote the verified temp extraction to the final cache root.
 *
 * Rather than deleting the previous cache in place, move it aside in a single
 * rename and then move the temp dir into place. On Windows an in-place
 * recursive rm of a just-written tree frequently fails with EPERM/EACCES/EBUSY
 * — antivirus real-time scanning or the search indexer hold transient handles,
 * and extracted files can carry a read-only attribute that blocks deletion —
 * whereas renaming the whole directory in one shot usually still succeeds. The
 * moved-aside copy is then removed best-effort (and any leftover is swept on the
 * next run). Retry with exponential backoff to ride out transient locks.
 *
 * If the previous cache cannot even be moved, a process is almost certainly
 * holding a file inside it open (Windows refuses to rename a directory tree
 * with an open handle) — surface an actionable error rather than a raw EACCES.
 */
async function promoteCache(tmpRoot: string, cacheRoot: string): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      // Move any existing cache aside (single rename), then move temp into place.
      let stale: string | null = null;
      if (await pathExists(cacheRoot)) {
        stale = `${cacheRoot}.stale-${process.pid}-${attempt}`;
        await fs.rename(cacheRoot, stale);
      }
      await fs.rename(tmpRoot, cacheRoot);
      // Old cache is out of the way; deleting it is no longer on the critical
      // path, so a lingering lock here cannot fail the promotion.
      if (stale) await fs.rm(stale, { recursive: true, force: true }).catch(() => {});
      return;
    } catch (err: unknown) {
      lastErr = err;
      const code = errnoCode(err);
      if (!code || !TRANSIENT_FS_CODES.has(code)) throw err;
      await sleep(250 * Math.pow(2, attempt)); // 0.25s, 0.5s … ~8s
    }
  }
  throw new Error(
    `[bootstrap] Could not replace the existing cache at ${cacheRoot} ` +
      `(${errnoCode(lastErr) ?? "unknown error"}). A running process is likely ` +
      `using it — close any opencode / node / java processes started from that ` +
      `folder (or reboot), then run again. As a last resort delete the folder ` +
      `manually while nothing is running.`,
    { cause: lastErr },
  );
}

/**
 * Best-effort removal of leftover `.tmp-*` / `.stale-*` sibling dirs from prior
 * crashed or partially-promoted runs, so they do not accumulate. Never throws.
 */
async function sweepLeftovers(cacheRoot: string): Promise<void> {
  const parent = path.dirname(cacheRoot);
  const base = path.basename(cacheRoot);
  let entries: string[];
  try {
    entries = await fs.readdir(parent);
  } catch {
    return; // parent missing — nothing to sweep
  }
  for (const name of entries) {
    if (name.startsWith(`${base}.tmp-`) || name.startsWith(`${base}.stale-`)) {
      await fs.rm(path.join(parent, name), { recursive: true, force: true }).catch(() => {});
    }
  }
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

  // Clean up our own temp dir plus any leftover temp/stale dirs from prior
  // crashed or partially-promoted runs (the lock guarantees we are the only
  // extractor, so sweeping siblings is safe).
  await fs.rm(tmpRoot, { recursive: true, force: true });
  await sweepLeftovers(cacheRoot);

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

      const buf = new Uint8Array(await blob.arrayBuffer());

      if (asset.archive && asset.archive !== "none") {
        // Write the archive to a scratch file, extract its contents into the
        // asset's extractTo directory, then drop a single wrapping top dir.
        const scratchDir = path.join(tmpRoot, ".archives");
        await fs.mkdir(scratchDir, { recursive: true });
        const safe = asset.id.replace(/[^a-zA-Z0-9_]/g, "_");
        const archivePath = path.join(
          scratchDir,
          `${safe}.${asset.archive === "zip" ? "zip" : "tar.gz"}`,
        );
        await fs.writeFile(archivePath, buf);

        const outDir = path.join(tmpRoot, asset.extractTo);
        await fs.mkdir(outDir, { recursive: true });
        await unpackArchive(asset, archivePath, outDir);
        await fs.rm(archivePath, { force: true });
        await flattenLoneTopDir(outDir);
      } else {
        // Plain file asset — write it directly at extractTo.
        const dest = path.join(tmpRoot, asset.extractTo);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, buf);
        if (asset.executable && process.platform !== "win32") {
          await fs.chmod(dest, 0o755);
        }
      }
    }

    // Remove the scratch archive directory before promoting the cache.
    await fs.rm(path.join(tmpRoot, ".archives"), { recursive: true, force: true });

    // All files written and verified; atomically promote temp → final.
    await promoteCache(tmpRoot, cacheRoot);

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
    // opencode expands {env:VAR} textually into the raw config text BEFORE parsing it
    // as JSON(C). On Windows cacheRoot contains backslashes (C:\Users\...), which the
    // JSON parser then rejects as invalid escape sequences (\U, \A, ...). Forward
    // slashes parse cleanly and are accepted by node/java/etc. on Windows all the same.
    OPENCODE_AIRGAP_CACHE: cacheRoot.replace(/\\/g, "/"),
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
 * Strip `//` line and slash-star block comments from JSONC text, scanning
 * string literals so delimiters inside strings (e.g. the `//` in a URL) are
 * left untouched. Used only to validate a config, never to rewrite it.
 */
function stripJsoncComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++; // land on the '/'; loop's i++ steps past it
      continue;
    }
    out += c;
  }
  return out;
}

/** Drop trailing commas before `}`/`]`, scanning strings so commas inside them survive. */
function dropTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i++;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === "}" || text[j] === "]") continue; // skip trailing comma
    }
    out += c;
  }
  return out;
}

/**
 * Best-effort check that `text` is acceptable to opencode's tolerant config
 * parser (JSON plus comments and trailing commas). Conservative by design: any
 * file we cannot prove broken is treated as valid so a user's config is never
 * clobbered on a false positive.
 */
function isParseableJsonc(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    // not plain JSON — retry with JSONC tolerances below
  }
  try {
    JSON.parse(dropTrailingCommas(stripJsoncComments(text)));
    return true;
  } catch {
    return false;
  }
}

/**
 * If the user's seeded opencode.json exists but no longer parses (corrupted or
 * partially-written), move it aside to a timestamped backup and restore the
 * bundled default. Valid user configs — including JSONC with comments or
 * trailing commas — are left untouched. No-op when either file is absent.
 */
async function reseedConfigIfBroken(
  bundledConfig: string,
  destConfig: string,
): Promise<void> {
  if (!(await pathExists(destConfig))) return; // copyMissing seeds a fresh one
  if (!(await pathExists(bundledConfig))) return; // nothing to restore from
  let raw: string;
  try {
    raw = await fs.readFile(destConfig, "utf8");
  } catch {
    return; // unreadable — leave it for opencode to report
  }
  if (isParseableJsonc(raw)) return; // valid — never overwrite user edits

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${destConfig}.broken-${stamp}`;
  await fs.rename(destConfig, backup);
  await fs.copyFile(bundledConfig, destConfig);
  process.stderr.write(
    `[bootstrap] opencode.json was not valid JSON; restored bundled default ` +
      `(previous file backed up to ${backup})\n`,
  );
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
    // 1b. Repair a corrupted/partially-written opencode.json from the bundled
    //     default. Only triggers when the existing file fails to parse, so
    //     valid user configs are never overwritten.
    await reseedConfigIfBroken(
      path.join(cacheRoot, "config", "opencode.json"),
      path.join(dest, "opencode.json"),
    );
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
/**
 * Locate the extracted opencode executable under the cache root. Uses the
 * opencode-core asset's extractTo directory and the platform binary name, with
 * a one-level recursive fallback in case the release archive nests the binary.
 * Returns "" if the asset is missing or no binary is found.
 */
async function resolveOpencodeBinary(
  cacheRoot: string,
  assets: AssetEntry[],
): Promise<string> {
  const core = assets.find((a) => a.kind === "opencode-core");
  if (!core) return "";
  const binName = process.platform === "win32" ? "opencode.exe" : "opencode";
  const root = path.join(cacheRoot, core.extractTo);

  const direct = path.join(root, binName);
  if (await pathExists(direct)) return direct;

  // Fallback: search one directory level deep.
  try {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const nested = path.join(root, entry.name, binName);
        if (await pathExists(nested)) return nested;
      }
    }
  } catch {
    // root missing — fall through
  }
  return "";
}

async function buildResult(
  cacheRoot: string,
  assets: AssetEntry[],
  extracted: boolean,
): Promise<BootstrapResult> {
  await seedUserConfig(cacheRoot);
  const opencodeBinary = await resolveOpencodeBinary(cacheRoot, assets);
  return { cacheRoot, env: buildEnv(cacheRoot, assets), extracted, opencodeBinary };
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
  // Stamp the cache dir with a short hash of this exact build (opencode version
  // + config + every asset digest). A new build therefore extracts to a NEW
  // dir instead of replacing the old one — which sidesteps the Windows failure
  // where the previous cache cannot be deleted because a still-running instance
  // (or antivirus) holds its files open. Identical builds reuse the same dir,
  // so the steady-state fast path is unchanged.
  const buildId = computeBuildId(manifest);
  const versionName = manifest.cacheNamespace.split("/").pop() ?? manifest.cacheNamespace;
  const baseNamespace = `${CACHE_NAMESPACE_PREFIX}\\${manifest.cacheNamespace}-${buildId}`;
  const cacheRoot = await resolveCacheRoot(baseNamespace);
  // Prior builds of the same opencode version (different hash) are now stale.
  const versionPrefix = `${versionName}-`;

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

    // Reclaim disk from superseded builds of the same version (best-effort;
    // a dir still in use by another running instance is locked and skipped).
    await gcStaleBuilds(cacheRoot, versionPrefix);

    return await buildResult(cacheRoot, manifest.assets, true);
  } finally {
    await releaseLock(cacheRoot);
  }
}

/** Short, stable id for this exact build: sha256 over each asset's id+digest. */
function computeBuildId(manifest: AssetManifest): string {
  const parts = manifest.assets.map((a) => `${a.id}:${a.digest}`).sort();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(parts.join("\n"));
  return hasher.digest("hex").slice(0, 12);
}

/**
 * Best-effort removal of superseded cache dirs for the same opencode version
 * (i.e. siblings sharing `versionPrefix` but a different build hash, plus their
 * leftover temp/stale scratch dirs), keeping only the current build. A dir held
 * open by a still-running older instance fails the rm and is simply skipped.
 * Never throws.
 */
async function gcStaleBuilds(cacheRoot: string, versionPrefix: string): Promise<void> {
  const parent = path.dirname(cacheRoot);
  const current = path.basename(cacheRoot);
  let entries: string[];
  try {
    entries = await fs.readdir(parent);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === current || !name.startsWith(versionPrefix)) continue;
    await fs.rm(path.join(parent, name), { recursive: true, force: true }).catch(() => {});
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
