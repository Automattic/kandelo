import { availableParallelism } from "node:os";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { configureKernelProcessors, hostProcessorCount } from "../src/kernel-worker";
import { NodeKernelHost, resolveRootfsArtifact } from "../src/node-kernel-host";
import { runCentralizedProgram } from "./centralized-test-helper";

// The kernel reports the host's available parallelism, capped at the 32 CPUs
// its four-byte affinity mask can name (runtime_core::processors).
const processors = Math.min(availableParallelism(), 32);

describe("sched_getaffinity", () => {
  it.each([
    ["wasm32", "programs/sched-getaffinity.wasm"],
    ["wasm64", "programs/wasm64/sched-getaffinity.wasm"],
  ])(
    "preserves Linux raw and libc semantics for %s",
    async (_arch, path) => {
      const result = await runCentralizedProgram({
        programPath: resolveBinary(path),
        argv: ["sched-getaffinity", String(processors)],
        timeout: 10_000,
        useDefaultRootfs: false,
      });

      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(
        `sched-getaffinity-ok raw=4 cpus=${processors}\n`,
      );
      expect(result.exitCode).toBe(0);
    },
    30_000,
  );
});

describe("processor count", () => {
  it("reads the worker realm's navigator.hardwareConcurrency", () => {
    expect(hostProcessorCount()).toBe(availableParallelism());
    expect(hostProcessorCount({ navigator: { hardwareConcurrency: 6 } })).toBe(6);
    for (const hardwareConcurrency of [undefined, 0, -1, 2.5, "8", Number.NaN]) {
      expect(hostProcessorCount({ navigator: { hardwareConcurrency } })).toBeUndefined();
    }
    expect(hostProcessorCount({})).toBeUndefined();
  });

  it("passes the host's count to the kernel and returns what it reports", () => {
    const calls: number[] = [];
    const kernel = (answer: (n: number) => number) => ({
      exports: {
        kernel_set_processor_count: (n: number) => { calls.push(n); return answer(n); },
      },
    }) as unknown as WebAssembly.Instance;
    const capped = kernel((n) => Math.min(n, 32));

    expect(configureKernelProcessors(capped, 14)).toBe(14);
    expect(configureKernelProcessors(capped, 64)).toBe(32);
    expect(calls).toEqual([14, 64]);
    // A host that does not say, or a kernel without the export, leaves 1.
    expect(configureKernelProcessors(capped, undefined)).toBeUndefined();
    expect(calls).toEqual([14, 64]);
    expect(configureKernelProcessors(
      { exports: {} } as unknown as WebAssembly.Instance,
      8,
    )).toBeUndefined();
    expect(() => configureKernelProcessors(kernel(() => -16), 8))
      .toThrow("kernel_set_processor_count failed with errno 16");
  });

  it("nproc reports the host's processors through the normal rootfs path", async () => {
    let stdout = "";
    let stderr = "";
    const decoder = new TextDecoder();
    const host = new NodeKernelHost({
      rootfsImage: new Uint8Array(readFileSync(resolveRootfsArtifact().selectedPath)),
      onStdout: (_pid, data) => { stdout += decoder.decode(data); },
      onStderr: (_pid, data) => { stderr += decoder.decode(data); },
    });
    try {
      await host.init();
      for (const argv of [["nproc"], ["nproc", "--all"]]) {
        const { exit } = await host.spawnFromVfs("/usr/bin/nproc", argv, {
          env: ["PATH=/usr/bin:/bin", "HOME=/root"],
        });
        expect(await exit, stderr).toBe(0);
      }
    } finally {
      await host.destroy();
    }
    expect(stderr).toBe("");
    expect(stdout).toBe(`${processors}\n${processors}\n`);
  }, 60_000);
});
