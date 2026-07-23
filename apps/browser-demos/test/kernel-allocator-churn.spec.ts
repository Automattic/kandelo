import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const programPath = resolve(
  __dirname,
  "../../../examples/kernel_allocator_churn_test.wasm",
);
const browserKernelModulePath = resolve(
  __dirname,
  "../../../host/src/browser-kernel-host.ts",
);

interface ChurnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  hostDiagnostics: Array<{ message: string }>;
  kernelMemoryPages: number;
}

test("kernel allocations remain bounded under pipe and fork churn in Chromium", async ({
  page,
  baseURL,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "the aggregate browser gate uses Chromium");
  test.setTimeout(240_000);
  expect(baseURL).toBeTruthy();

  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => {
    runtimeErrors.push(`pageerror: ${error.message}`);
  });
  page.on("requestfailed", (request) => {
    runtimeErrors.push(
      `requestfailed: ${request.url()} ${request.failure()?.errorText ?? "failed"}`,
    );
  });

  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const asViteFsUrl = (path: string) => new URL(`/@fs/${path}`, baseURL).href;
  const programUrl = asViteFsUrl(programPath);
  const browserKernelModuleUrl = asViteFsUrl(browserKernelModulePath);
  const results = await page.evaluate(async ({ browserKernelModuleUrl, programUrl }) => {
    const { BrowserKernel } = await import(
      /* @vite-ignore */ browserKernelModuleUrl
    );
    const run = async (mode: "pipe" | "fork", count: number): Promise<ChurnResult> => {
      let stdout = "";
      let stderr = "";
      const hostDiagnostics: Array<{ message: string }> = [];
      const decoder = new TextDecoder();
      const kernel = new BrowserKernel({
        onStdout: (bytes: Uint8Array) => {
          stdout += decoder.decode(bytes);
        },
        onStderr: (bytes: Uint8Array) => {
          stderr += decoder.decode(bytes);
        },
        onHostDiagnostic: (diagnostic: { message: string }) => {
          hostDiagnostics.push(diagnostic);
        },
      });
      try {
        const response = await fetch(programUrl);
        if (!response.ok) {
          throw new Error(
            `program fetch failed: ${response.status} ${response.url}`,
          );
        }
        await kernel.initFromImage({ vfsImage: "default" });
        const exitCode = await kernel.spawn(await response.arrayBuffer(), [
          "kernel_allocator_churn_test",
          mode,
          String(count),
        ]);
        return {
          exitCode,
          stdout,
          stderr,
          hostDiagnostics,
          kernelMemoryPages: await kernel.getKernelMemoryPages(),
        };
      } finally {
        await kernel.destroy();
      }
    };
    return {
      pipeWarm: await run("pipe", 1_000),
      pipeStress: await run("pipe", 20_000),
      forkWarm: await run("fork", 8),
      // Keep this below Chromium's separate, existing process-memory
      // reclamation limit so this test isolates the kernel heap allocator.
      forkStress: await run("fork", 64),
    };
  }, { browserKernelModuleUrl, programUrl });

  for (const [name, result] of Object.entries(results)) {
    expect(result.exitCode, `${name}: ${JSON.stringify(result)}`).toBe(0);
    expect(result.stderr, name).toBe("");
    expect(result.hostDiagnostics, name).toEqual([]);
  }
  expect(results.pipeWarm.stdout).toContain("KERNEL_ALLOCATOR_PIPE_PASS count=1000");
  expect(results.pipeStress.stdout).toContain("KERNEL_ALLOCATOR_PIPE_PASS count=20000");
  expect(results.forkWarm.stdout).toContain("KERNEL_ALLOCATOR_FORK_PASS count=8");
  expect(results.forkStress.stdout).toContain("KERNEL_ALLOCATOR_FORK_PASS count=64");

  expect(results.pipeStress.kernelMemoryPages).toBeLessThanOrEqual(
    results.pipeWarm.kernelMemoryPages + 16,
  );
  expect(results.forkStress.kernelMemoryPages).toBeLessThanOrEqual(
    results.forkWarm.kernelMemoryPages + 64,
  );
  expect(runtimeErrors).toEqual([]);
});
