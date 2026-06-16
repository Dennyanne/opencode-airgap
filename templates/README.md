# opencode air-gapped bundle — config reference

This document describes the configuration system for the air-gapped opencode
single-exe bundle. Read this before editing any config file or building the exe.

---

## Placeholder convention: `{env:OPENCODE_AIRGAP_CACHE}`

Every path to an extracted asset (LSP binaries, runtimes, MCP servers) is
written as `{env:OPENCODE_AIRGAP_CACHE}/<relative-path>`.

**Contract for the bootstrap author (src/embed/bootstrap.ts):**
Before launching opencode, `buildEnv()` must include:

```
OPENCODE_AIRGAP_CACHE = <absolute path of the resolved per-version cache root>
```

The bootstrap already resolves the cache root (the `cacheRoot` variable returned
by `resolveCacheRoot()`). Wire it to the env overlay like this:

```ts
env["OPENCODE_AIRGAP_CACHE"] = cacheRoot;
```

opencode's `{env:VAR}` substitution then expands every `{env:OPENCODE_AIRGAP_CACHE}`
in `opencode.json` to the real extracted path at startup — with no hardcoded paths
and no rebuild required when the cache location changes.

The canonical extraction layout under `OPENCODE_AIRGAP_CACHE`:

```
<OPENCODE_AIRGAP_CACHE>/
  runtime/
    jre/          # portable JRE 21 (Temurin), extracted from embedded archive
      bin/java
    node/         # portable Node runtime (LTS), extracted from embedded archive
      node
  lsp/
    jdtls/        # Eclipse JDT Language Server
      plugins/org.eclipse.equinox.launcher_*.jar
      config_win/
      workspace/  # per-session workspace; created on first jdtls start
    volar/        # @vue/language-server
      node_modules/@vue/language-server/bin/vue-language-server.js
    tsserver/     # typescript-language-server + typescript
      node_modules/typescript-language-server/lib/cli.mjs
      node_modules/typescript/lib/tsserver.js
    pyright/      # pyright native binary (best-effort)
      pyright-langserver
    gopls/        # gopls native binary (best-effort)
      gopls
  mcp/
    filesystem/   # @modelcontextprotocol/server-filesystem
      node_modules/@modelcontextprotocol/server-filesystem/dist/index.js
```

**The bootstrap populates this layout during extraction. The config file must
mirror these relative paths exactly.** If extraction paths change in Phase 2/4,
update both `templates/opencode.json` and this table in sync.

---

## Environment variables

### Required at runtime (set before running the exe, or in system env)

| Variable | Purpose | Default |
|---|---|---|
| `VLLM_BASE_URL` | Base URL of the vLLM OpenAI-compatible API endpoint | none — must be set |
| `VLLM_API_KEY` | API key sent in the `Authorization: Bearer` header | `"not-used"` works for most vLLM deployments with no auth |
| `VLLM_MODEL` | Model ID string as reported by the vLLM server | none — must be set |

Example (PowerShell):
```powershell
$env:VLLM_BASE_URL  = "http://192.168.1.100:8000/v1"
$env:VLLM_API_KEY   = "not-used"
$env:VLLM_MODEL     = "meta-llama/Llama-3.1-70B-Instruct"
.\opencode-airgap.exe
```

Alternatively, use a `.env` file. opencode runs on Bun, which auto-loads `.env`
from the **current working directory** into the environment, so the `{env:VAR}`
placeholders in the embedded config resolve from it. Copy the repo-root
`.env.example` to `.env` in the folder you launch opencode from:

```dotenv
VLLM_BASE_URL=http://192.168.1.100:8000/v1
VLLM_API_KEY=not-used
VLLM_MODEL=meta-llama/Llama-3.1-70B-Instruct
```

- Do **not** prefix `VLLM_MODEL` with `vllm/` — the bundled config already wraps
  it as `"model": "vllm/{env:VLLM_MODEL}"`.
- `.env` is loaded relative to the working directory, not the `.exe`. It is not
  auto-loaded from the config dir or parent folders ([opencode#10458](https://github.com/anomalyco/opencode/issues/10458)).
  To apply regardless of CWD, set the vars as persistent Windows user env vars
  with `setx`.

### Set automatically by the bootstrap (do not set manually unless testing)

| Variable | Set to | Purpose |
|---|---|---|
| `OPENCODE_AIRGAP_CACHE` | Resolved per-version cache root (e.g. `%LOCALAPPDATA%\opencode-airgap\0.1.0`) | Expands `{env:OPENCODE_AIRGAP_CACHE}` in opencode.json LSP/MCP paths |
| `OPENCODE_DISABLE_LSP_DOWNLOAD` | `"true"` | Prevents opencode from attempting network downloads of LSP servers |
| `JAVA_HOME` | `<cache>/runtime/jre` | Used by jdtls and any Java tooling |
| `PATH` | Prepended with extracted runtime and tool bin dirs | Makes node, java, gopls, pyright available without absolute paths |

### Optional / advanced

| Variable | Purpose |
|---|---|
| `OPENCODE_CONFIG` | Path to a user-override config JSON file. Takes precedence over the embedded default config. Use this to point opencode at `opencode-airgap.config.json` without rebuilding the exe. |
| `OPENCODE_CONFIG_CONTENT` | Inline JSON string used as config. Useful for scripted deployments where writing a file is inconvenient. Takes precedence over `OPENCODE_CONFIG`. |

---

## Config discovery and precedence order

opencode merges config from multiple sources. Later sources override earlier ones.

1. **Embedded default** (`templates/opencode.json`) — baked into the exe; sets
   provider, LSP, and MCP defaults. Users should not edit this directly.
2. **User global** (`~/.config/opencode/opencode.json`) — the user's machine-wide
   config. Merged on top of the embedded default.
3. **Project-local** (`opencode.json` in the current working directory) — per-repo
   overrides; checked in to source control.
4. **`$OPENCODE_CONFIG`** — explicit path override. Points opencode at a named file
   (e.g. `opencode-airgap.config.json`). Recommended for air-gapped deployments
   where the user needs to change vLLM settings without touching global config.
5. **`$OPENCODE_CONFIG_CONTENT`** — inline JSON string; highest precedence,
   overrides everything above.

For most air-gapped deployments: set `OPENCODE_CONFIG` to the path of your edited
`opencode-airgap.config.json` copy, or export the three `VLLM_*` env vars and rely
on `{env:VAR}` substitution in the embedded default config.

---

## Changing the vLLM endpoint without rebuilding (AC9)

The embedded `opencode.json` uses `{env:VAR}` placeholders for all three
vLLM-specific values:

```json
"baseURL": "{env:VLLM_BASE_URL}",
"apiKey":  "{env:VLLM_API_KEY}",
"models":  { "{env:VLLM_MODEL}": { "name": "vLLM model" } }
```

opencode resolves these at startup from the process environment. To switch
endpoints or models:

**Option A — env vars (recommended for scripted/CI use):**
```powershell
$env:VLLM_BASE_URL = "http://10.0.0.5:8000/v1"
$env:VLLM_MODEL    = "mistralai/Mistral-7B-Instruct-v0.3"
.\opencode-airgap.exe
```

**Option B — user-override file (recommended for interactive use):**
1. Copy `templates/opencode-airgap.config.json` to any convenient location on the
   air-gapped machine.
2. Edit the `baseURL`, `apiKey`, and model key/name to match your vLLM server.
3. Set `OPENCODE_CONFIG` to the file's absolute path, or place the file as
   `opencode.json` in the working directory where you launch the exe.

The override file only needs the fields you want to change. It is merged on top of
the embedded defaults, so LSP and MCP settings carry through untouched.

Neither option requires rebuilding or redistributing the exe.

---

## LSP configuration

### Gated (required for acceptance criteria AC4 and AC5)

| LSP | Key in config | Extensions | Notes |
|---|---|---|---|
| jdtls (Eclipse JDT) | `lsp.java` | `.java` | Requires embedded JRE 21. `JAVA_HOME` set by bootstrap. Workspace dir auto-created on first start. |
| Volar (@vue/language-server) | `lsp.vue` | `.vue` | Requires embedded Node runtime. |

### Best-effort (non-gated — missing these does not block acceptance)

| LSP | Key in config | Extensions | Notes |
|---|---|---|---|
| typescript-language-server | `lsp.typescript` | `.ts .tsx .js .jsx` | Requires embedded Node. |
| Pyright | `lsp.python` | `.py` | Native binary; no Node/JVM needed. |
| gopls | `lsp.go` | `.go` | Native binary; no Node/JVM needed. |

`OPENCODE_DISABLE_LSP_DOWNLOAD=true` (set automatically by the bootstrap) prevents
opencode from attempting to download any LSP that is not already on disk. LSPs
missing from the cache will simply not start — they will not cause the exe to fail
or hang.

---

## MCP configuration

### Disabled (remote — not reachable on an air-gapped network)

The following oh-my-opencode built-in MCPs require outbound internet access and
are permanently disabled in the embedded config:

| Key | Service | Reason disabled |
|---|---|---|
| `mcp.websearch` | Exa web search | Requires exa.ai API — no internet |
| `mcp.context7` | Context7 library docs | Requires context7.com API — no internet |
| `mcp.grep_app` | grep.app code search | Requires grep.app API — no internet |

These entries are present in `opencode.json` with `"enabled": false` and an
empty `command` array. opencode will log them as disabled and skip them without
errors or hangs (AC7).

### Enabled (local — embedded in the exe)

| Key | Package | Notes |
|---|---|---|
| `mcp.filesystem` | `@modelcontextprotocol/server-filesystem` | Runs via embedded Node; grants access to the current working directory by default. Pass additional root paths by editing the `command` array in your override config. |

To add further local MCP servers, add entries to your `opencode-airgap.config.json`
override with `"type": "local"`, `"enabled": true`, and a `command` array pointing
at the extracted server under `{env:OPENCODE_AIRGAP_CACHE}/mcp/<name>/...`.

---

## Quick-start checklist for a new air-gapped machine

1. Copy `opencode-airgap.exe` to the target machine.
2. Copy `templates/opencode-airgap.config.json` to the same directory; rename it
   if desired.
3. Edit the config file: set `baseURL` to your vLLM server, set the model key and
   name, set `apiKey` if your server requires one.
4. Set `OPENCODE_CONFIG` to the absolute path of the edited config file (or set the
   three `VLLM_*` env vars instead).
5. Run `opencode-airgap.exe`. On first run it extracts ~N GB of assets to
   `%LOCALAPPDATA%\opencode-airgap\<version>\` — this takes up to 60 seconds.
6. Subsequent runs skip extraction and start immediately.
