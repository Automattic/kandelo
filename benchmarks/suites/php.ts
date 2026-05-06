/**
 * Suite: PHP standalone
 *
 * Measures the PHP interpreter on its own — no WordPress, no SQLite
 * plugin, no HTTP server. Two metrics:
 *
 *   php_startup_ms — `php -r 'exit;'` start-to-exit time, isolating
 *                    interpreter startup from any application work.
 *
 *   php_compute_ms — A small arithmetic loop (no I/O, no allocations
 *                    beyond what PHP's runtime needs). Sensitive to
 *                    Zend engine performance and to syscall overhead
 *                    that interrupts compute (e.g. signal-handling
 *                    paths called from hot loops).
 *
 * Lives separately from `wordpress` so a regression here is
 * attributable to the interpreter, not to the framework on top.
 */
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { runCentralizedProgram } from "../../host/test/centralized-test-helper.js";
import { tryResolveBinary } from "../../host/src/binary-resolver.js";
import type { BenchmarkSuite } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");

const phpBinaryPath =
  tryResolveBinary("programs/php/php.wasm") ??
  resolve(repoRoot, "examples/libs/php/php-src/sapi/cli/php");

async function measureStartup(): Promise<number> {
  const t0 = performance.now();
  const result = await runCentralizedProgram({
    programPath: phpBinaryPath,
    argv: ["php", "-r", "exit;"],
    env: ["HOME=/tmp", "TMPDIR=/tmp"],
    timeout: 60_000,
  });
  const t1 = performance.now();
  if (result.exitCode !== 0) {
    throw new Error(`PHP startup failed (exit ${result.exitCode}): ${result.stderr}`);
  }
  return t1 - t0;
}

async function measureCompute(): Promise<number> {
  // Tight integer-arithmetic loop. 100k iterations is enough to be
  // measurable past the spawn-overhead floor, small enough to keep
  // the suite fast even on wasm64. Sum guards against the Zend
  // optimizer eliding the loop.
  const script = "$s = 0; for ($i = 0; $i < 100000; $i++) { $s += $i; } echo $s;";
  const t0 = performance.now();
  const result = await runCentralizedProgram({
    programPath: phpBinaryPath,
    argv: ["php", "-r", script],
    env: ["HOME=/tmp", "TMPDIR=/tmp"],
    timeout: 60_000,
  });
  const t1 = performance.now();
  if (result.exitCode !== 0) {
    throw new Error(`PHP compute failed (exit ${result.exitCode}): ${result.stderr}`);
  }
  return t1 - t0;
}

const suite: BenchmarkSuite = {
  name: "php",

  async run(): Promise<Record<string, number>> {
    const { existsSync } = await import("fs");
    if (!existsSync(phpBinaryPath)) {
      console.warn(`  php.wasm not found, skipping. Run: scripts/fetch-binaries.sh (or build locally).`);
      return {};
    }
    return {
      php_startup_ms: await measureStartup(),
      php_compute_ms: await measureCompute(),
    };
  },
};

export default suite;
