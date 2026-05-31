/**
 * Spike 1 — Bun embed + spawn validation
 *
 * Imports a native binary as an embedded asset via Bun's file import,
 * writes it to a temp path, marks it executable, spawns it, and prints
 * the result.  The goal is to reproduce-or-refute oven-sh/bun#10344
 * (Windows crash when spawning an extracted embedded binary).
 *
 * The embedded binary is selected at build time via the SPIKE_EMBED_PATH
 * env var (see run.sh / run.ps1).  For the local macOS smoke test the
 * build script copies /bin/echo to ./payload/dummy-bin and passes that.
 * On Windows the user supplies a small .exe (see README).
 */

// @ts-ignore — resolved by Bun at compile time when --asset-naming is used.
// The path must be relative to THIS file and exist at bun build time.
import embeddedBinary from "./payload/dummy-bin" with { type: "file" };

import { mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";

const IS_WINDOWS = process.platform === "win32";

async function main() {
  console.log("Spike 1: Bun embed-spawn harness");
  console.log(`  platform : ${process.platform}`);
  console.log(`  arch     : ${process.arch}`);
  console.log(`  bun      : ${Bun.version}`);

  // ------------------------------------------------------------------
  // 1. Locate the embedded asset (Bun resolves this to a temp path when
  //    running as a compiled exe, or to the original file during dev run).
  // ------------------------------------------------------------------
  const embeddedPath: string = embeddedBinary;
  console.log(`  embedded asset path resolved to: ${embeddedPath}`);

  // ------------------------------------------------------------------
  // 2. Read the embedded bytes and write them to our own temp location.
  //    This mirrors what bootstrap.ts will do for real payloads.
  // ------------------------------------------------------------------
  const tmpDir = join(tmpdir(), `spike1-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const ext = IS_WINDOWS ? ".exe" : "";
  const destPath = join(tmpDir, `extracted-bin${ext}`);

  const bytes = await Bun.file(embeddedPath).arrayBuffer();
  writeFileSync(destPath, Buffer.from(bytes));
  console.log(`  wrote ${bytes.byteLength} bytes -> ${destPath}`);

  // ------------------------------------------------------------------
  // 3. Mark executable (no-op on Windows but harmless).
  // ------------------------------------------------------------------
  if (!IS_WINDOWS) {
    chmodSync(destPath, 0o755);
  }

  // ------------------------------------------------------------------
  // 4. Spawn and capture output.
  // ------------------------------------------------------------------
  console.log("  spawning extracted binary...");

  // On macOS smoke test we embedded /bin/echo, so pass a greeting arg.
  // On Windows the payload is where.exe. Called with NO args it prints
  // "ERROR: The syntax of the command is incorrect." to stderr and exits 2,
  // which the verdict below would wrongly read as a FAIL. Passing a real
  // search term ("where" itself, always on PATH) makes it print a path to
  // stdout and exit 0 — exercising both the spawn and stdout-capture paths.
  const spawnArgs: string[] = IS_WINDOWS ? ["where"] : ["hello from spike1"];
  const result = Bun.spawnSync([destPath, ...spawnArgs], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = result.stdout ? new TextDecoder().decode(result.stdout) : "";
  const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : "";

  console.log(`  exit code : ${result.exitCode}`);
  console.log(`  stdout    : ${stdout.trim()}`);
  if (stderr.trim()) {
    console.log(`  stderr    : ${stderr.trim()}`);
  }

  // ------------------------------------------------------------------
  // 5. Cleanup temp dir.
  // ------------------------------------------------------------------
  rmSync(tmpDir, { recursive: true, force: true });

  // ------------------------------------------------------------------
  // 6. Verdict.
  // ------------------------------------------------------------------
  const passed =
    result.exitCode === 0 && !result.signal && stdout.trim().length > 0;

  if (passed) {
    console.log("\nRESULT: PASS — embedded binary extracted and spawned successfully. #10344 NOT reproduced.");
    process.exit(0);
  } else {
    console.error(
      `\nRESULT: FAIL — exit=${result.exitCode} signal=${result.signal} stdout='${stdout.trim()}'`
    );
    console.error("  => Bun#10344 MAY be reproduced. Option A is at risk — escalate to user.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  console.error("RESULT: FAIL — unhandled exception during spawn harness.");
  process.exit(1);
});
