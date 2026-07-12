import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tryResolveBinary } from "../../../host/src/binary-resolver";

const __dirname = dirname(fileURLToPath(import.meta.url));
const browserKernelModulePath = resolve(
  __dirname,
  "../../../host/src/browser-kernel-host.ts",
);
const programPath = tryResolveBinary("programs/p_10_fork_child_creates_thread.wasm");

test("fork child creates and joins a pthread in the browser host", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  test.skip(!programPath, "P-10 fixture is not built");
  expect(baseURL).toBeTruthy();

  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);

  const result = await page.evaluate(
    async ({ moduleUrl, programUrl }) => {
      const { BrowserKernel } = await import(/* @vite-ignore */ moduleUrl);
      const programResponse = await fetch(programUrl);
      if (!programResponse.ok) {
        throw new Error(`failed to fetch P-10 fixture: ${programResponse.status}`);
      }

      let stdout = "";
      let stderr = "";
      const decoder = new TextDecoder();
      const kernel = new BrowserKernel({
        onStdout: (data: Uint8Array) => { stdout += decoder.decode(data); },
        onStderr: (data: Uint8Array) => { stderr += decoder.decode(data); },
      });

      try {
        await kernel.initFromImage({ vfsImage: "default" });
        const programBytes = await programResponse.arrayBuffer();
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error("P-10 browser run timed out")),
            30_000,
          );
        });
        const exitCode = await Promise.race([
          kernel.spawn(programBytes, ["p_10_fork_child_creates_thread"]),
          timeout,
        ]).finally(() => clearTimeout(timeoutId));
        return { exitCode, stdout, stderr };
      } finally {
        await kernel.destroy();
      }
    },
    {
      moduleUrl: new URL(`/@fs/${browserKernelModulePath}`, baseURL).href,
      programUrl: new URL(`/@fs/${programPath}`, baseURL).href,
    },
  );

  expect(result.exitCode, `stderr=${result.stderr}\nstdout=${result.stdout}`).toBe(0);
  expect(result.stdout).toContain("CHILD_THREAD: ok");
  expect(result.stdout).toContain("CHILD: joined");
  expect(result.stdout).toContain("PASS: P-10");
  expect(result.stderr).toBe("");
});
