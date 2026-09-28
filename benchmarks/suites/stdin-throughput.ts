/**
 * Suite: host stdin throughput
 *
 * The host supplies a fixed buffer as a process's stdin (spawn({ stdin }))
 * and the program (benchmarks/programs/stdin-throughput.c) reads it to EOF,
 * timing only its read(0) loop.
 *
 * Metrics:
 *   stdin_mbps — MiB/s from host-supplied stdin into one reader
 */
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { runCentralizedProgram } from "../../host/test/centralized-test-helper.js";
import type { BenchmarkSuite } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmDir = resolve(__dirname, "../wasm");

/** Large enough that the bounded stdin pipe fills and refills many times. */
export const STDIN_THROUGHPUT_BYTES = 24 * 1024 * 1024;

const suite: BenchmarkSuite = {
  name: "stdin-throughput",

  async run(): Promise<Record<string, number>> {
    const input = new Uint8Array(STDIN_THROUGHPUT_BYTES).map((_, i) => i % 251);
    const result = await runCentralizedProgram({
      programPath: resolve(wasmDir, "stdin-throughput.wasm"),
      argv: ["stdin-throughput"],
      stdinBytes: input,
      timeout: 120_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`stdin-throughput failed: ${result.stderr}`);
    }
    const bytes = Number(/^stdin_bytes=(\d+)$/m.exec(result.stdout)?.[1]);
    const mbps = Number(/^stdin_mbps=([\d.]+)$/m.exec(result.stdout)?.[1]);
    if (bytes !== STDIN_THROUGHPUT_BYTES || !Number.isFinite(mbps)) {
      throw new Error(`stdin-throughput read ${bytes} bytes: ${result.stdout}`);
    }
    return { stdin_mbps: mbps };
  },
};

export default suite;
