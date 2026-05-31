/**
 * Shared test helpers for the airbuild verification harness.
 */

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;
let skipped = 0;

export function pass(label: string): void {
  passed++;
  process.stdout.write(`${GREEN}PASS${RESET}  ${label}\n`);
}

export function fail(label: string, reason: string): void {
  failed++;
  process.stderr.write(`${RED}FAIL${RESET}  ${label}: ${reason}\n`);
}

export function skip(label: string, reason: string): void {
  skipped++;
  process.stdout.write(`${YELLOW}SKIP${RESET}  ${label}: ${reason}\n`);
}

export function summary(): { passed: number; failed: number; skipped: number } {
  const total = passed + failed + skipped;
  const color = failed > 0 ? RED : GREEN;
  process.stdout.write(
    `\n${color}Results: ${passed} passed, ${failed} failed, ${skipped} skipped (${total} total)${RESET}\n`,
  );
  return { passed, failed, skipped };
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runCmd(
  argv: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
): Promise<RunResult> {
  const [cmd, ...args] = argv;
  const proc = Bun.spawn([cmd, ...args], {
    cwd: opts?.cwd,
    env: opts?.env ? { ...process.env, ...opts.env } : process.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdoutBuf, stderrBuf, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return {
    code: exitCode,
    stdout: stdoutBuf,
    stderr: stderrBuf,
  };
}
