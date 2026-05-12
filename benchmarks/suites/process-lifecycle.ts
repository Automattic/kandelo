/**
 * Suite 3: Process Lifecycle
 *
 * Measures core process management primitives.
 *
 * Metrics:
 *   hello_start_ms — Hello world cold start (load wasm + run to exit)
 *   fork_ms        — Fork + child exit
 *   exec_ms        — Exec new program
 *   clone_ms       — Thread creation via clone
 */
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { runCentralizedProgram } from "../../host/test/centralized-test-helper.js";
import type { BenchmarkSuite } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmDir = resolve(__dirname, "../wasm");

function parseMetrics(stdout: string): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const line of stdout.split("\n")) {
    const match = line.match(/^(\w+)=([\d.eE+-]+)$/);
    if (match) {
      metrics[match[1]] = parseFloat(match[2]);
    }
  }
  return metrics;
}

const suite: BenchmarkSuite = {
  name: "process-lifecycle",

  async run(): Promise<Record<string, number>> {
    const results: Record<string, number> = {};

    // Hello world cold start — wall clock from JS side
    const helloPath = resolve(wasmDir, "hello.wasm");
    const t0 = performance.now();
    const hello = await runCentralizedProgram({
      programPath: helloPath,
      argv: ["hello"],
      timeout: 30_000,
    });
    const t1 = performance.now();
    if (hello.exitCode !== 0) throw new Error(`hello failed: ${hello.stderr}`);
    results.hello_start_ms = t1 - t0;

    // Fork + child exit
    const fork = await runCentralizedProgram({
      programPath: resolve(wasmDir, "fork-bench.wasm"),
      argv: ["fork-bench"],
      timeout: 30_000,
    });
    if (fork.exitCode !== 0) throw new Error(`fork-bench failed: ${fork.stderr}`);
    Object.assign(results, parseMetrics(fork.stdout));

    // Exec new program — measured from JS side as total wall clock
    const execBenchPath = resolve(wasmDir, "exec-bench.wasm");
    const execPrograms = new Map<string, string>();
    execPrograms.set("/bin/hello", helloPath);
    const t2 = performance.now();
    const exec = await runCentralizedProgram({
      programPath: execBenchPath,
      argv: ["exec-bench"],
      execPrograms,
      timeout: 30_000,
    });
    const t3 = performance.now();
    if (exec.exitCode !== 0) throw new Error(`exec-bench failed: ${exec.stderr}`);
    results.exec_ms = t3 - t2;

    // Thread creation via clone
    const clone = await runCentralizedProgram({
      programPath: resolve(wasmDir, "clone-bench.wasm"),
      argv: ["clone-bench"],
      timeout: 30_000,
    });
    if (clone.exitCode !== 0) throw new Error(`clone-bench failed: ${clone.stderr}`);
    Object.assign(results, parseMetrics(clone.stdout));

    // posix_spawn — the non-forking SYS_SPAWN fast path. Distinct from
    // exec_ms (which times execve replacing the same process) and
    // fork_ms (which times fork's asyncify rewind). spawn_ms exists
    // because popen / system / shell pipelines all go through
    // posix_spawn, and that path used to cost a fork-instrument unwind
    // we no longer pay.
    const spawnBench = await runCentralizedProgram({
      programPath: resolve(wasmDir, "spawn-bench.wasm"),
      argv: ["spawn-bench"],
      execPrograms,
      timeout: 30_000,
    });
    if (spawnBench.exitCode !== 0) throw new Error(`spawn-bench failed: ${spawnBench.stderr}`);
    Object.assign(results, parseMetrics(spawnBench.stdout));

    return results;
  },
};

export default suite;
