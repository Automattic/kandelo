import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import { createGoSdkImage, goSdkProbeOutput, goSdkProbePath } from "./fixtures/go-sdk-image";

const probe = process.env.KANDELO_GO_SDK_PROBE;

it.skipIf(!probe)("runs an SDK-built Go module from the guest VFS", async () => {
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
    const process = await host.spawnFromVfs(goSdkProbePath, [goSdkProbePath]);
    expect(await process.exit, stderr).toBe(0);
    expect(stdout).toBe(goSdkProbeOutput);
    expect(stderr).toBe("");
  } finally {
    await host.destroy();
  }
}, 60_000);
