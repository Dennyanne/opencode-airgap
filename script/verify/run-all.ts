#!/usr/bin/env bun
/**
 * Master verification runner for the airbuild acceptance criteria.
 *
 * Runs AC1, AC8, AC9, AC13 in sequence (the criteria testable on
 * the build machine without a live Windows environment), then prints
 * the aggregate summary.
 *
 * Exit code 1 if any test FAILed; 0 otherwise.
 *
 * Usage:
 *   bun run script/verify/run-all.ts
 */
import { runAc1 } from "./ac1-build.ts";
import { runAc8 } from "./ac8-from-lock.ts";
import { runAc9 } from "./ac9-config-override.ts";
import { runAc13 } from "./ac13-rollback.ts";
import { summary } from "./util.ts";

process.stdout.write("=== airbuild verification harness ===\n\n");

await runAc1();
await runAc8();
runAc9();
await runAc13();

const counts = summary();

process.stdout.write(
  "\nWindows manual checks required: see script/verify/checklist-windows.md\n",
);

process.exit(counts.failed > 0 ? 1 : 0);
