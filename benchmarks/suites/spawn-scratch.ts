/**
 * Spawn Scratch
 *
 * Measures the ordinary and large posix_spawn transport paths plus retained
 * scratch capacity. This is intentionally separate from process-lifecycle:
 * the established hello/fork/exec/clone metrics continue to boot the default
 * rootfs, while this fully supplied workload can run against an empty VFS.
 */
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { runCentralizedProgram } from "../../host/test/centralized-test-helper.js";
import { collectSpawnScratchEvidence } from "../spawn-scratch-evidence.js";
import type { BenchmarkSuite } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const wasmDir = resolve(__dirname, "../wasm");

const suite: BenchmarkSuite = {
  name: "spawn-scratch",

  async run(): Promise<Record<string, number>> {
    const helloPath = resolve(wasmDir, "hello.wasm");
    const execPrograms = new Map<string, string>([
      ["/bin/hello", helloPath],
    ]);
    const spawnBench = await runCentralizedProgram({
      // WHY: both executables are supplied explicitly. Keeping this isolated
      // from process-lifecycle avoids changing that suite's default-rootfs
      // timing semantics merely to gather spawn scratch evidence.
      useDefaultRootfs: false,
      programPath: resolve(wasmDir, "spawn-bench.wasm"),
      argv: ["spawn-bench"],
      execPrograms,
      timeout: 30_000,
      captureSpawnScratchStats: true,
    });
    if (spawnBench.exitCode !== 0) {
      throw new Error(`spawn-bench failed: ${spawnBench.stderr}`);
    }
    if (
      spawnBench.spawnScratchCapacity === undefined ||
      spawnBench.kernelMemoryPages === undefined
    ) {
      throw new Error("spawn-bench did not return kernel scratch telemetry");
    }

    return collectSpawnScratchEvidence({
      stdout: spawnBench.stdout,
      retainedCapacity: spawnBench.spawnScratchCapacity,
      kernelMemoryPages: spawnBench.kernelMemoryPages,
    });
  },
};

export default suite;
