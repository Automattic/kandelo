/**
 * Vitest globalSetup — compiles C test programs to .wasm, assembles
 * .wat test fixtures, and ensures the Playwright chromium browser is
 * installed before tests run.
 *
 * Uses wasm32posix-cc from the SDK for C, and wat2wasm (wabt) for WAT
 * fixtures. Outputs are only rebuilt when the source is newer. The
 * chromium check is a no-op when the binary is already cached.
 */

import { execFileSync } from "node:child_process";
import { statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../..");
const examplesDir = join(repoRoot, "examples");
const fixturesDir = join(__dirname, "fixtures");

/** C programs that tests depend on. */
const TEST_PROGRAMS = [
  "putenv_test.c",
  "getaddrinfo_test.c",
  "sysv_ipc_test.c",
  "wasm_trap_test.c",
  "abort_test.c",
];

/** WAT fixtures used by host/test/wasi-shim.test.ts. */
const WAT_FIXTURES = ["wasi-args.wat", "wasi-hello.wat"];

function needsRebuild(srcFile: string, outFile: string): boolean {
  if (!existsSync(outFile)) return true;
  const srcStat = statSync(srcFile);
  const outStat = statSync(outFile);
  return srcStat.mtimeMs > outStat.mtimeMs;
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

  for (const watFile of WAT_FIXTURES) {
    const src = join(fixturesDir, watFile);
    const out = src.replace(/\.wat$/, ".wasm");

    if (!existsSync(src)) {
      console.warn(`[global-setup] Source not found: ${src}, skipping`);
      continue;
    }

    if (!needsRebuild(src, out)) continue;

    console.log(`[global-setup] Assembling ${watFile}...`);
    execFileSync("wat2wasm", ["--enable-threads", src, "-o", out], {
      cwd: repoRoot,
      stdio: "pipe",
    });
  }

  // examples/wordpress/test/wordpress-site-editor.test.ts calls
  // chromium.launch() directly (not via the `playwright test` runner),
  // so the browser binary must be present before vitest runs. `npm
  // install` only fetches the @playwright/test JS package, not the
  // ~150 MB chromium-headless-shell. Owning this here means workflow
  // YAMLs no longer need to remember `npx playwright install chromium`
  // — every caller of `vitest run` gets the prereq for free.
  let chromiumPath = "";
  try {
    chromiumPath = chromium.executablePath();
  } catch {
    // executablePath() can throw on some Playwright versions when the
    // browser hasn't been downloaded yet; treat that the same as a
    // missing file and let the install step below run.
  }
  if (!chromiumPath || !existsSync(chromiumPath)) {
    console.log("[global-setup] Installing Playwright chromium...");
    execFileSync("npx", ["playwright", "install", "chromium"], {
      cwd: join(repoRoot, "host"),
      stdio: "inherit",
    });
  }
}
