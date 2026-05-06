/**
 * Suite: Syscall / IPC / IO microbenchmarks
 *
 * Small C programs measuring kernel IPC and I/O paths in isolation.
 * Each program prints `metric_name=value` lines to stdout.
 *
 * Metrics:
 *   pipe_mbps          — 1MiB through a pipe (parent → child via fork)
 *   socketpair_mbps    — 1MiB through socketpair(AF_UNIX, SOCK_STREAM)
 *                        — separate kernel path from pipe
 *   file_write_mbps    — 1MiB sequential write to a file
 *   file_read_mbps     — 1MiB sequential read
 *   syscall_latency_us — Average getpid() round-trip over 1000 calls
 *   signal_latency_us  — Average raise(SIGUSR1) handler round-trip
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

async function runProgram(name: string): Promise<Record<string, number>> {
  const result = await runCentralizedProgram({
    programPath: resolve(wasmDir, `${name}.wasm`),
    argv: [name],
    timeout: 60_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`${name} failed (exit ${result.exitCode}): ${result.stderr}`);
  }
  return parseMetrics(result.stdout);
}

const suite: BenchmarkSuite = {
  name: "syscall-io",

  async run(): Promise<Record<string, number>> {
    const results: Record<string, number> = {};
    Object.assign(results, await runProgram("pipe-throughput"));
    Object.assign(results, await runProgram("socketpair-throughput"));
    Object.assign(results, await runProgram("file-throughput"));
    Object.assign(results, await runProgram("syscall-latency"));
    Object.assign(results, await runProgram("signal-latency"));
    return results;
  },
};

export default suite;
