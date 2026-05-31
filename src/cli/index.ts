#!/usr/bin/env bun
import { parseArgs } from "util";
import type { TargetTriple } from "../embed/manifest.ts";
import { runBuild } from "./build.ts";
import { runUpdate } from "./update.ts";

const TOOL_VERSION = "0.1.0";

const USAGE = `\
airbuild ${TOOL_VERSION} — packages opencode + oh-my-opencode into a single Windows x64 exe

USAGE
  airbuild build   [--target <triple>] [--out <file>] [--from-lock <path>]
  airbuild update  [--target <triple>] [--out <file>]

SUBCOMMANDS
  build     Fetch assets and compile the self-extracting exe.
            If --from-lock is given, pin versions to the supplied versions.lock
            file instead of resolving latest (reproducible rebuild).

  update    Resolve the latest versions of all assets, build to a temp file,
            write versions.lock, and atomically replace --out only on success.

OPTIONS
  --target  Bun target triple (default: bun-windows-x64)
            Accepted values: bun-windows-x64 | bun-linux-x64 | bun-darwin-arm64
  --out     Output exe path (default: opencode-airgap.exe)
  --from-lock
            Path to an existing versions.lock file for a reproducible rebuild
            (build subcommand only)
  --help, -h
            Print this usage text and exit 0

EXAMPLES
  airbuild build
  airbuild build --out dist/opencode-airgap.exe
  airbuild build --from-lock versions.lock
  airbuild update --out opencode-airgap.exe
`;

const VALID_TARGETS: TargetTriple[] = [
  "bun-windows-x64",
  "bun-linux-x64",
  "bun-darwin-arm64",
];

function parseTargetTriple(raw: string): TargetTriple {
  if ((VALID_TARGETS as string[]).includes(raw)) {
    return raw as TargetTriple;
  }
  console.error(`error: unknown --target "${raw}". Valid values: ${VALID_TARGETS.join(", ")}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  const subcommand = argv[0];
  const rest = argv.slice(1);

  if (subcommand === "build") {
    const { values } = parseArgs({
      args: rest,
      options: {
        target: { type: "string", default: "bun-windows-x64" },
        out: { type: "string", default: "opencode-airgap.exe" },
        "from-lock": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    });

    if (values.help) {
      process.stdout.write(USAGE);
      process.exit(0);
    }

    await runBuild({
      target: parseTargetTriple(values.target!),
      outfile: values.out!,
      fromLock: values["from-lock"],
    });
  } else if (subcommand === "update") {
    const { values } = parseArgs({
      args: rest,
      options: {
        target: { type: "string", default: "bun-windows-x64" },
        out: { type: "string", default: "opencode-airgap.exe" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    });

    if (values.help) {
      process.stdout.write(USAGE);
      process.exit(0);
    }

    await runUpdate({
      target: parseTargetTriple(values.target!),
      outfile: values.out!,
    });
  } else {
    console.error(`error: unknown subcommand "${subcommand}". Run airbuild --help for usage.`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error("fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
