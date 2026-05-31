/**
 * Shared download utilities for Phase 2 asset fetchers.
 * All I/O uses Bun.fetch() and node: builtins — no extra npm deps.
 */

import * as fs from "node:fs/promises";
import type { FetchContext } from "./types.ts";

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

/** Ensure a directory (and all parents) exists. */
export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/**
 * Streaming HTTP GET with Bun.fetch(). Pipes the response body directly to a
 * file at destPath. Logs label + bytes on completion. Throws on non-2xx.
 */
export async function downloadFile(
  url: string,
  destPath: string,
  label: string,
): Promise<void> {
  process.stderr.write(`[fetch] fetching ${label} from ${url}\n`);

  const res = await Bun.fetch(url, {
    headers: { "User-Agent": "airbuild/1 (https://github.com/sst/opencode)" },
  });

  if (!res.ok) {
    throw new Error(
      `[fetch] HTTP ${res.status} ${res.statusText} fetching ${label} from ${url}`,
    );
  }

  const blob = await res.blob();
  const buffer = await blob.arrayBuffer();
  await Bun.write(destPath, buffer);

  process.stderr.write(
    `[fetch] wrote ${label} → ${destPath} (${buffer.byteLength} bytes)\n`,
  );
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

/**
 * Simple retry wrapper with exponential backoff.
 * Default: 3 attempts, 1000 ms base delay (doubled each retry).
 */
export async function retryFetch<T>(
  fn: () => Promise<T>,
  attempts: number = 3,
  delayMs: number = 1000,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        const wait = delayMs * Math.pow(2, i);
        process.stderr.write(
          `[fetch] attempt ${i + 1}/${attempts} failed: ${err instanceof Error ? err.message : String(err)}. Retrying in ${wait}ms…\n`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, wait));
      }
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Digest / size
// ---------------------------------------------------------------------------

/**
 * Compute the sha256 hex digest of a file on disk using Bun.CryptoHasher.
 * Matches the algorithm used in script/build-exe.ts so build-time and
 * runtime digests are identical.
 */
export async function computeDigest(filePath: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  const data = await fs.readFile(filePath);
  hasher.update(data);
  return hasher.digest("hex");
}

/** Return the size in bytes of a file. */
export async function fileSize(filePath: string): Promise<number> {
  const stat = await fs.stat(filePath);
  return stat.size;
}

// ---------------------------------------------------------------------------
// Version / digest resolution helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the version for assetId:
 * - If ctx.pinnedVersions?.[assetId] is set, return it immediately.
 * - Otherwise call fetchLatest() and return what it returns.
 */
export async function resolveVersion(
  ctx: FetchContext,
  assetId: string,
  fetchLatest: () => Promise<string>,
): Promise<string> {
  const pinned = ctx.pinnedVersions?.[assetId];
  if (pinned !== undefined) {
    process.stderr.write(`[fetch] ${assetId}: using pinned version ${pinned}\n`);
    return pinned;
  }
  const latest = await fetchLatest();
  process.stderr.write(`[fetch] ${assetId}: resolved latest version ${latest}\n`);
  return latest;
}

/**
 * Verify the sha256 digest of filePath against ctx.pinnedDigests?.[assetId].
 * If no pinned digest is set this is a first-run recording pass — no-op.
 * Throws if the actual digest does not match the pinned digest.
 */
export async function verifyDigest(
  ctx: FetchContext,
  assetId: string,
  filePath: string,
): Promise<void> {
  const expected = ctx.pinnedDigests?.[assetId];
  if (expected === undefined) {
    // First run — not yet recorded; caller is responsible for writing the lock.
    return;
  }
  const actual = await computeDigest(filePath);
  if (actual !== expected) {
    throw new Error(
      `[fetch] digest mismatch for ${assetId}:\n` +
        `  expected: ${expected}\n` +
        `  actual:   ${actual}\n` +
        `  file:     ${filePath}`,
    );
  }
  process.stderr.write(`[fetch] ${assetId}: digest verified OK\n`);
}
