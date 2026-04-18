/**
 * Suite 4: Syscall/IO Throughput
 *
 * Measures channel IPC and I/O performance using small C benchmark programs.
 *
 * Metrics:
 *   pipe_mbps        — Write 1MB through a pipe
 *   file_write_mbps  — Write 1MB to a file
 *   file_read_mbps   — Read 1MB from a file
 *   syscall_latency_us — Average getpid round-trip over 1000 calls
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
  name: "syscall-io",

  async run(): Promise<Record<string, number>> {
    const results: Record<string, number> = {};

    // Pipe throughput
    const pipe = await runCentralizedProgram({
      programPath: resolve(wasmDir, "pipe-throughput.wasm"),
      argv: ["pipe-throughput"],
      timeout: 60_000,
    });
    if (pipe.exitCode !== 0) throw new Error(`pipe-throughput failed: ${pipe.stderr}`);
    Object.assign(results, parseMetrics(pipe.stdout));

    // File throughput
    const file = await runCentralizedProgram({
      programPath: resolve(wasmDir, "file-throughput.wasm"),
      argv: ["file-throughput"],
      timeout: 60_000,
    });
    if (file.exitCode !== 0) throw new Error(`file-throughput failed: ${file.stderr}`);
    Object.assign(results, parseMetrics(file.stdout));

    // Syscall latency
    const syscall = await runCentralizedProgram({
      programPath: resolve(wasmDir, "syscall-latency.wasm"),
      argv: ["syscall-latency"],
      timeout: 60_000,
    });
    if (syscall.exitCode !== 0) throw new Error(`syscall-latency failed: ${syscall.stderr}`);
    Object.assign(results, parseMetrics(syscall.stdout));

    return results;
  },
};

export default suite;
