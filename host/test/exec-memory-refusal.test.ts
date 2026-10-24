import { expect, it } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import { createExecMemoryRefusalImage, EXEC_MEMORY_REFUSAL_LIMITS } from "./fixtures/exec-memory-refusal-image";

it("preserves the old exec image and allows a later spawn after ENOMEM", async () => {
  let stdout = "";
  let stderr = "";
  const decoder = new TextDecoder();
  const host = new NodeKernelHost({
    ...EXEC_MEMORY_REFUSAL_LIMITS,
    rootfsImage: await createExecMemoryRefusalImage(),
    onStdout: (_pid, bytes) => { stdout += decoder.decode(bytes); },
    onStderr: (_pid, bytes) => { stderr += decoder.decode(bytes); },
  });
  try {
    await host.init();
    const process = await host.spawnFromVfs("/bin/parent", ["/bin/parent"], {
      ownedJob: { id: "exec-memory-refusal", timeoutMs: 20_000 },
    });
    expect(await process.exit, stderr).toBe(0);
    expect(stdout).toContain("EXEC_REFUSAL_ERRNO=12");
    expect(stdout).toContain("EXEC_REFUSAL_OLD_IMAGE_AND_NEXT_LAUNCH_OK");
    expect(stderr).toBe("");
  } finally {
    await host.destroy();
  }
}, 30_000);
