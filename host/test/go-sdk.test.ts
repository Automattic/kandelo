import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { expect, it } from "vitest";
import { goRuntimeEnv } from "../../sdk/go-runtime-env.js";
import { NodeKernelHost } from "../src/node-kernel-host";
import { createGoSdkImage, goSdkProbeOutput, goSdkProbeParallelism, goSdkProbePath } from "./fixtures/go-sdk-image";

const probe = process.env.KANDELO_GO_SDK_PROBE;

it("chooses a Go default only within the embedding's budget", () => {
  expect(goRuntimeEnv(["PATH=/bin"], { hostHint: 8, budget: 2 }))
    .toEqual(["PATH=/bin", "GOMAXPROCS=2"]);
  expect(goRuntimeEnv([], { hostHint: 2, budget: 8 })).toEqual(["GOMAXPROCS=2"]);
  expect(goRuntimeEnv([], { hostHint: 8 })).toEqual(["GOMAXPROCS=1"]);
  expect(goRuntimeEnv([], { hostHint: NaN, budget: 4 })).toEqual(["GOMAXPROCS=1"]);
  expect(goRuntimeEnv(["GOMAXPROCS=4"], { hostHint: 2, budget: 1 }))
    .toEqual(["GOMAXPROCS=4"]);
});

it.skipIf(!probe).each(goSdkProbeParallelism)("runs the Go SDK probe with parallelism %s", async (procs) => {
  const image = await createGoSdkImage(probe!);
  const kernelPath = process.env.KANDELO_GO_TEST_KERNEL;
  const kernelBytes = kernelPath ? new Uint8Array(readFileSync(kernelPath)).buffer : undefined;
  let stdout = "";
  let stderr = "";
  const decoder = new TextDecoder();
  const host = new NodeKernelHost({
    rootfsImage: image,
    onStdout: (_, bytes) => { stdout += decoder.decode(bytes); },
    onStderr: (_, bytes) => { stderr += decoder.decode(bytes); },
  });
  try {
    await host.init(kernelBytes);
    const hostHint = availableParallelism();
    const desired = procs === "auto" ? Math.min(hostHint, 2) : procs;
    const env = procs === 1 ? [] : goRuntimeEnv(procs === "auto" ? [] : [`GOMAXPROCS=${procs}`], {
      hostHint,
      budget: procs === "auto" ? 2 : 1,
    });
    const process = await host.spawnFromVfs(goSdkProbePath, [goSdkProbePath, String(desired)], { env });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Go SDK probe stalled.\n${stdout}${stderr}`)), 30_000);
      });
      expect(await Promise.race([process.exit, deadline]), stderr).toBe(0);
    } finally {
      clearTimeout(timer);
    }
    expect(stdout).toBe(goSdkProbeOutput);
    expect(stderr).toBe("");
  } finally {
    await host.destroy();
  }
}, 60_000);
