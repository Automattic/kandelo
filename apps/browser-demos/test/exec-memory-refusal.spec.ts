import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { createExecMemoryRefusalImage, EXEC_MEMORY_REFUSAL_LIMITS } from "../../../host/test/fixtures/exec-memory-refusal-image";

test("exec ENOMEM preserves PID and CLOEXEC descriptors and permits a later spawn", async ({ page, baseURL }, testInfo) => {
  expect(baseURL).toBeTruthy();
  const response = await page.goto("/trap-signal-test.html");
  expect(response?.ok()).toBe(true);
  const image = await createExecMemoryRefusalImage();
  const modulePath = resolve(import.meta.dirname, "../../../host/src/browser-kernel-host.ts");
  const result = await page.evaluate(async ({ moduleUrl, image, limits }) => {
    const { BrowserKernel } = await import(/* @vite-ignore */ moduleUrl);
    let stdout = "";
    let stderr = "";
    const decoder = new TextDecoder();
    const kernel = new BrowserKernel({
      ...limits,
      onStdout: (bytes: Uint8Array) => { stdout += decoder.decode(bytes); },
      onStderr: (bytes: Uint8Array) => { stderr += decoder.decode(bytes); },
    });
    try {
      await kernel.initFromImage({ vfsImage: new Uint8Array(image) });
      const process = await kernel.spawnFromVfs("/bin/parent", ["/bin/parent"], {
        ownedJob: { id: "exec-memory-refusal", timeoutMs: 20_000 },
      });
      return { status: await process.exit, stdout, stderr };
    } finally {
      await kernel.destroy();
    }
  }, { moduleUrl: new URL(`/@fs/${modulePath}`, baseURL).href,
    image: Array.from(image), limits: EXEC_MEMORY_REFUSAL_LIMITS,
  });
  await testInfo.attach("guest-exec-refusal", { contentType: "application/json", body: JSON.stringify(result) });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("EXEC_REFUSAL_ERRNO=12");
  expect(result.stdout).toContain("EXEC_REFUSAL_OLD_IMAGE_AND_NEXT_LAUNCH_OK");
  expect(result.stderr).toBe("");
});
