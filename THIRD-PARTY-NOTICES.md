# Third-Party Notices

The `opencode-airgap.exe` produced by this project is a **self-extracting
bundle** that embeds and redistributes the third-party software listed below.
This repository's own source code is licensed under the MIT License (see
`LICENSE`); the bundled components are **not** — each is governed by its own
license and its own redistribution obligations.

> The exact versions of every embedded component for a given build are recorded
> in `asset-manifest.json`, which is written next to the exe at build time.
> This file should be distributed alongside the exe.

> Disclaimer: this summary is provided for convenience and is not legal advice.
> Confirm the license of the exact version you ship (from the component's own
> `LICENSE`/`NOTICE` files) and seek legal review before commercial
> redistribution.

## Bundled components

| Component | Role | Source | License |
|---|---|---|---|
| opencode (core + TUI) | AI coding agent runtime + terminal UI | https://github.com/sst/opencode | MIT |
| oh-my-opencode | opencode plugin (agents, commands, skills) | https://www.npmjs.com/package/oh-my-opencode | MIT |
| Eclipse Temurin JRE 21 | Java runtime for the Java language server | https://adoptium.net | **GPLv2 with Classpath Exception** |
| Node.js (LTS) | JavaScript runtime for Node-based LSP/MCP servers | https://nodejs.org | MIT (umbrella; bundles V8, OpenSSL, ICU, etc. under their own licenses — see Node's `LICENSE`) |
| Pyright | Python language server | https://www.npmjs.com/package/pyright | MIT |
| typescript-language-server | TypeScript/JavaScript language server | https://www.npmjs.com/package/typescript-language-server | MIT |
| TypeScript (tsserver) | TypeScript compiler/tsserver | https://www.npmjs.com/package/typescript | Apache-2.0 |
| @vue/language-server (Volar) | Vue language server | https://www.npmjs.com/package/@vue/language-server | MIT |
| @modelcontextprotocol/server-filesystem | Local filesystem MCP server | https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem | MIT |
| ast-grep | Structural search/lint tool | https://www.npmjs.com/package/@ast-grep/cli | MIT |
| @ai-sdk/openai-compatible | OpenAI-compatible provider for the vLLM backend | https://www.npmjs.com/package/@ai-sdk/openai-compatible | Apache-2.0 |

Optional components, included only when available at build time:

| Component | Role | Source | License |
|---|---|---|---|
| Eclipse JDT Language Server (jdtls) | Java language server | https://github.com/eclipse-jdtls/eclipse.jdt.ls | EPL-2.0 |
| gopls | Go language server | https://pkg.go.dev/golang.org/x/tools/gopls | BSD-3-Clause |

## Obligations when redistributing the exe

### Permissive licenses (MIT / BSD-3-Clause / Apache-2.0 / EPL-2.0)
You must preserve and include each component's copyright notice and license
text in your redistribution. For **Apache-2.0** components (TypeScript,
`@ai-sdk/openai-compatible`), you must also include the contents of their
`NOTICE` file (if present) and state any modifications you made.

### Eclipse Temurin JRE — GPLv2 with Classpath Exception (important)
The JRE binary is licensed under **GPLv2 with the Classpath Exception**
(https://openjdk.org/legal/gplv2+ce.html).

- The **Classpath Exception** means bundling/running the JRE does **not** impose
  GPL terms on this project's own code or the other bundled components. Do not
  remove or modify the Classpath Exception.
- Redistributing the JRE binary still carries GPLv2 obligations:
  1. Include the GPLv2 license text and the JRE's `legal/` notices.
  2. Make the **corresponding source code** available to recipients (ship it, or
     provide a written offer / URL pointing to it).

**Written offer for source (Eclipse Temurin):** The complete corresponding
source code for the bundled Eclipse Temurin JRE is available from Adoptium at
https://adoptium.net and https://github.com/adoptium/temurin21-binaries for the
exact version recorded in `asset-manifest.json`.

## Trademarks
"opencode" and other product names are the marks of their respective owners.
`opencode-airgap` is an **unofficial** repackaging for air-gapped use and is not
affiliated with, endorsed by, or sponsored by the upstream projects.
