/**
 * Shared types for Phase 2 asset fetchers.
 * Every sub-fetcher receives a FetchContext and returns AssetEntry[] via
 * the AssetManifest populated by src/fetcher/index.ts → stageAssets().
 */

import type { AssetEntry, AssetKind, TargetTriple } from "../embed/manifest.ts";

// Re-export so callers import from one place.
export type { AssetEntry, AssetKind, TargetTriple };

/** Runtime context passed to every sub-fetcher. */
export interface FetchContext {
  /** Bun target triple the exe is compiled for. */
  target: TargetTriple;
  /** Absolute path to the staging/ root directory. */
  stagingRoot: string;
  /**
   * When set, each fetcher MUST resolve this exact version instead of latest.
   * Keys are AssetEntry.id values; values are the pinned version strings.
   */
  pinnedVersions?: Record<string, string>;
  /**
   * When set, each fetcher MUST verify the downloaded file's sha256 digest
   * matches this value before returning the AssetEntry.
   * Keys are AssetEntry.id values.
   */
  pinnedDigests?: Record<string, string>;
}

/**
 * Return type of every sub-fetcher.
 * A single fetcher call may produce multiple AssetEntry records
 * (e.g. the JRE fetcher returns one entry; the npm fetcher for an LSP
 * server may return one entry for the package dir).
 */
export type FetchResult = AssetEntry[];

/** Sub-fetcher function signature. */
export type Fetcher = (ctx: FetchContext) => Promise<FetchResult>;

/**
 * Platform suffix helpers derived from the Bun target triple.
 * Fetchers use these to select the correct binary artefact.
 */
export function platformFromTarget(target: TargetTriple): {
  os: "windows" | "linux" | "darwin";
  arch: "x64" | "arm64";
  exeSuffix: "" | ".exe";
  nodeOs: "win" | "linux" | "darwin";
  nodeArch: "x64" | "arm64";
  npmOs: "win32" | "linux" | "darwin";
} {
  switch (target) {
    case "bun-windows-x64":
      return { os: "windows", arch: "x64", exeSuffix: ".exe", nodeOs: "win", nodeArch: "x64", npmOs: "win32" };
    case "bun-linux-x64":
      return { os: "linux", arch: "x64", exeSuffix: "", nodeOs: "linux", nodeArch: "x64", npmOs: "linux" };
    case "bun-darwin-arm64":
      return { os: "darwin", arch: "arm64", exeSuffix: "", nodeOs: "darwin", nodeArch: "arm64", npmOs: "darwin" };
  }
}
