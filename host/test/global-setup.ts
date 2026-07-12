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
import { statSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../..");
const examplesDir = join(repoRoot, "examples");
const fixturesDir = join(__dirname, "fixtures");

/** C programs that tests depend on. */
const TEST_PROGRAMS = [
  "clock_getcpuclockid_test.c",
  "syscall_cp_offset_test.c",
  "select_signal_test.c",
  "lseek_invalid_test.c",
  "environment_lifecycle_test.c",
  "chown_sentinel_test.c",
  "pthread_channel_reuse_test.c",
  "wait_lifecycle_test.c",
  "pathconf_test.c",
  "rlimit_fsize_test.c",
  "socket_timeout_options_test.c",
  "unix_listener_exec_test.c",
  "putenv_test.c",
  "getaddrinfo_test.c",
  "sysv_ipc_test.c",
  "wasm_trap_test.c",
  "oob_trap_test.c",
  "divzero_trap_test.c",
  "abort_test.c",
  "test-pthread.c",
  "pthread-normal-exit.c",
  "pthread-trap-child.c",
  "pthread-trap-wait.c",
  "echo.c",
  "hello.c",
  "spawn-smoke.c",
  "spawn-coverage.c",
  "spawn-pause.c",
  "mount_probe_test.c",
  "getpwent_smoke.c",
  "thread-exit-group.c",
];

const FORK_INSTRUMENTED_PROGRAMS = new Set([
  "environment_lifecycle_test.c",
  "pthread_channel_reuse_test.c",
  "unix_listener_exec_test.c",
  "wait_lifecycle_test.c",
]);

/** Operation-boundary regressions that must also run through a memory64 guest. */
const WASM64_TEST_PROGRAMS = [
  "chown_sentinel_test.c",
  "pathconf_test.c",
  "rlimit_fsize_test.c",
  "socket_timeout_options_test.c",
  "wait_lifecycle_test.c",
];

/** WAT fixtures used by host runtime tests. */
const WAT_FIXTURES = [
  "deep-wasm-recursion.wat",
  "wasi-args.wat",
  "wasi-hello.wat",
];

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
    if (FORK_INSTRUMENTED_PROGRAMS.has(cFile)) {
      const linked = `${out}.linked`;
      try {
        execFileSync("wasm32posix-cc", [src, "-o", linked], {
          cwd: repoRoot,
          stdio: "pipe",
        });
        execFileSync(
          "bash",
          [
            join(repoRoot, "scripts/run-wasm-fork-instrument.sh"),
            linked,
            "-o",
            out,
          ],
          { cwd: repoRoot, stdio: "pipe" },
        );
      } finally {
        rmSync(linked, { force: true });
      }
    } else {
      execFileSync("wasm32posix-cc", [src, "-o", out], {
        cwd: repoRoot,
        stdio: "pipe",
      });
    }
  }

  for (const cFile of WASM64_TEST_PROGRAMS) {
    const src = join(examplesDir, cFile);
    const out = src.replace(/\.c$/, ".wasm64.wasm");
    if (!needsRebuild(src, out)) continue;

    console.log(`[global-setup] Compiling ${cFile} for wasm64...`);
    execFileSync("wasm64posix-cc", [src, "-o", out], {
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

  // packages/registry/wordpress/test/wordpress-site-editor.test.ts calls
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
