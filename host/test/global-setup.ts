/**
 * Vitest globalSetup — compiles C test programs to .wasm before tests run.
 *
 * Uses wasm32posix-cc from the SDK. Programs are only recompiled when the
 * source .c file is newer than the output .wasm file.
 */

import { execFileSync } from "node:child_process";
import { statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../..");
const examplesDir = join(repoRoot, "examples");

/** C programs that tests depend on. */
const TEST_PROGRAMS = [
  "putenv_test.c",
  "getaddrinfo_test.c",
  "sysv_ipc_test.c",
];

function needsRebuild(cFile: string, wasmFile: string): boolean {
  if (!existsSync(wasmFile)) return true;
  const cStat = statSync(cFile);
  const wasmStat = statSync(wasmFile);
  return cStat.mtimeMs > wasmStat.mtimeMs;
}

export async function setup() {
  for (const cFile of TEST_PROGRAMS) {
    const src = join(examplesDir, cFile);
    const out = src.replace(/\.c$/, ".wasm");

    if (!existsSync(src)) {
      console.warn(`[global-setup] Source not found: ${src}, skipping`);
      continue;
    }

    if (!needsRebuild(src, out)) continue;

    console.log(`[global-setup] Compiling ${cFile}...`);
    execFileSync("wasm32posix-cc", [src, "-o", out], {
      cwd: repoRoot,
      stdio: "pipe",
    });
  }
}
