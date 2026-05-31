# Spike 3 — Node-LSP / MCP Runtime Decision

## Goal

Determine whether Bun can directly host a representative Node-based LSP
(`tsserver`) well enough to replace a portable Node runtime embed, OR whether
portable Node must be bundled in the exe.

The plan default is **embed-node**. This spike is the only path to the
optimisation of NOT embedding Node (saving ~50-80 MB). It is classified as a
hard gate alongside Spike 1: Phase 2+ proceeds only after this decision is
confirmed.

Specifically this spike tests:

- (a) Spawn `tsserver` under **Bun** and send a minimal LSP `initialize`
  request over stdio; check for a valid `Content-Length`-framed response.
- (b) Repeat under **Node** as the control group.
- (c) Print a `DECISION: bun-host | embed-node` line with reasoning.

---

## Files

| File | Purpose |
|------|---------|
| `run.sh` | macOS/Linux test — runnable NOW on the dev machine |
| `run.ps1` | Windows host equivalent for final confirmation |

`tsserver` is sourced from `../../node_modules/.bin/tsserver` (TypeScript devDep
already installed in the repo).

---

## How to Run

### macOS (runnable immediately)

```bash
cd spikes/spike3-node-lsp
chmod +x run.sh
./run.sh
```

This script:
1. Verifies `tsserver`, `node`, and `bun` are available.
2. Starts `tsserver` via Node, sends LSP `initialize`, waits up to 10 s for
   a `Content-Length`-framed response, prints result.
3. Repeats with Bun as the runtime.
4. Prints `DECISION: bun-host` or `DECISION: embed-node` with reasoning.

### Windows host (required for final confirmation)

```powershell
cd spikes\spike3-node-lsp
.\run.ps1
```

Requirements on Windows:
- Bun installed: `winget install oven-sh.bun`
- Node installed: `winget install OpenJS.NodeJS`
- `bun install` run in repo root so `node_modules\typescript` exists

---

## PASS / FAIL Criteria

This spike does not have a binary PASS/FAIL — it produces a **DECISION**:

### DECISION: bun-host

Conditions:
- Bun hosting tsserver returns a valid LSP-framed response (`Content-Length` header present).
- Node hosting tsserver also works (confirming tsserver itself is functional).

Implication: **Node runtime embed is optional** (saves ~50-80 MB). Verify the
remaining Node-based MCPs under Bun before removing the embed. Update plan Node
runtime decision to "Bun-host confirmed".

### DECISION: embed-node

Conditions:
- Bun hosting tsserver fails (no response / crash / wrong output) even though
  Node hosting succeeds.
- OR both fail (tsserver setup issue — fix tsserver first, then re-run).

Implication: **Portable Node runtime MUST be embedded**. Plan default (휴대용
Node 임베드) is confirmed. Proceed to Phase 2 with Node embed in scope.

---

## Why This Is a Hard Gate

Many of the target LSPs (tsserver, pyright, Volar) and local MCPs are Node
packages. In the air-gap target there is no system Node. If Bun cannot host them,
every LSP and MCP that depends on Node will fail silently unless a portable Node
binary is extracted at runtime. The decision here directly determines a ~50-80 MB
size delta in the final exe and a corresponding extraction-time delta.

---

## Notes

- The macOS verdict is strongly indicative but the Windows cross-compiled exe
  is the authoritative test. Re-run `run.ps1` on Windows before finalising.
- `tsserver` is launched with `--useNodeIpc=false` so it uses stdio JSON-RPC,
  which is the mode opencode's LSP client uses.
- If `tsserver` is not in `node_modules/.bin/`, run `bun install` in the repo
  root (typescript is a devDependency).
- For a more complete verdict, also test a representative local MCP
  (e.g. `@modelcontextprotocol/server-filesystem`) under both runtimes after
  this initial tsserver result.
