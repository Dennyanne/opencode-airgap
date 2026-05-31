/**
 * Shared contracts between the build side (script/build-exe.ts) and the
 * runtime side (src/embed/bootstrap.ts).
 *
 * The build embeds every staged asset into the exe and records a manifest.
 * At runtime the bootstrap extracts those assets to a local cache and uses
 * the same digests recorded in the manifest to verify integrity. The build's
 * `versions.lock` is the single source of truth reused for both reproducible
 * rebuilds (`airbuild build --from-lock`) and runtime integrity checks.
 */

/** Target triples supported by the build. Windows x64 is the only gated target. */
export type TargetTriple = "bun-windows-x64" | "bun-linux-x64" | "bun-darwin-arm64";

/** Category of an embedded asset, used to drive extraction layout + env wiring. */
export type AssetKind =
  | "opencode-core" // the opencode runtime entry (handled by bun compile itself)
  | "tui" // Go-compiled opencode TUI binary
  | "plugin" // oh-my-opencode plugin payload
  | "lsp" // language server (node package payload or native binary)
  | "mcp" // local MCP server payload
  | "runtime-jre" // portable JRE for jdtls
  | "runtime-node" // portable Node runtime (default; removable if Spike #3 passes)
  | "tool" // misc native tool (e.g. ast-grep)
  | "config"; // embedded opencode.json default config

/**
 * One embedded asset. `embedPath` is the import specifier used in build-exe.ts
 * (`import x from <embedPath> with { type: "file" }`). `extractTo` is the path
 * RELATIVE to the per-version cache root where bootstrap writes the file.
 */
export interface AssetEntry {
  /** Stable identifier, e.g. "jdtls", "volar", "ast-grep", "jre", "node". */
  id: string;
  kind: AssetKind;
  /** Resolved version string recorded at build time (always-latest by default). */
  version: string;
  /** Hex sha256 of the staged file/archive. Reused for runtime integrity check. */
  digest: string;
  /** Build-time path under staging/, also the embed import specifier. */
  embedPath: string;
  /** Runtime extraction destination, relative to the version cache root. */
  extractTo: string;
  /** If true, the asset is an archive that must be unpacked after extraction. */
  archive?: "zip" | "tar.gz" | "none";
  /** On POSIX targets, mark the extracted file executable. */
  executable?: boolean;
  /** Size in bytes (for extract-time budget reporting / progress). */
  bytes: number;
}

/**
 * The manifest embedded in the exe and emitted alongside the build. Drives the
 * runtime bootstrap. Kept JSON-serializable so it can be embedded as a file.
 */
export interface AssetManifest {
  /** Schema version of this manifest shape. */
  schema: 1;
  /** opencode-airgap tool version that produced the exe. */
  toolVersion: string;
  /** Resolved opencode core version. */
  opencodeVersion: string;
  /** Resolved oh-my-opencode (oh-my-openagent) version. */
  pluginVersion: string;
  /** Target the exe was compiled for. */
  target: TargetTriple;
  /** ISO-8601 build timestamp. */
  builtAt: string;
  /** Cache root folder name (per-version), e.g. "opencode-airgap/<version>". */
  cacheNamespace: string;
  /** All embedded assets requiring extraction. */
  assets: AssetEntry[];
}

/**
 * The lockfile written by every build. Captures the FULL transitive set of
 * resolved versions + digests so `--from-lock` reproduces an identical exe and
 * the runtime can verify what it extracts. Write AND read (never write-only).
 */
export interface VersionsLock {
  schema: 1;
  toolVersion: string;
  opencodeVersion: string;
  pluginVersion: string;
  target: TargetTriple;
  generatedAt: string;
  /** Every resolved asset, keyed by id, with version+digest+source. */
  assets: Array<{
    id: string;
    kind: AssetKind;
    version: string;
    digest: string;
    /** Where this asset was fetched from (url/npm spec/git ref) for reproducibility. */
    source: string;
  }>;
}

/** Sentinel filename written into a cache version dir once extraction is complete. */
export const COMPLETE_SENTINEL = ".complete";

/** Lock filename used to serialize concurrent first-run extraction. */
export const EXTRACT_LOCK = ".extract.lock";

/** Default cache namespace prefix under the OS local-app-data dir. */
export const CACHE_NAMESPACE_PREFIX = "opencode-airgap";

/** Manifest filename embedded in the exe and written to the cache root. */
export const MANIFEST_FILENAME = "asset-manifest.json";

/** Lockfile filename emitted next to the exe by the build. */
export const VERSIONS_LOCK_FILENAME = "versions.lock";
