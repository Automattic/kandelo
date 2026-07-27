import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinary } from "../../../host/src/binary-resolver";

const __dirname = dirname(fileURLToPath(import.meta.url));
const programPath = resolve(
  __dirname,
  "../../../examples/kernel_allocator_churn_test.wasm",
);
const kernelWasmPath = resolveBinary("kernel.wasm");
const reusableKernelWorkerPath = resolve(
  __dirname,
  "fixtures/reusable-kernel-export-stack-worker.ts",
);
const browserKernelModulePath = resolve(
  __dirname,
  "../../../host/src/browser-kernel-host.ts",
);
const kernelOwnedBootModulePath = resolve(
  __dirname,
  "../lib/kernel-owned-boot.ts",
);
const spawnChildPath = "/bin/kernel_allocator_churn_test";

interface ChurnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  hostDiagnostics: Array<{ message: string }>;
  kernelMemoryPages: number;
}

interface StackProbeResult {
  baselineStackPointer: number;
  finalStackPointer: number;
  iterations: number;
}

test("kernel allocations and reusable exports remain bounded under churn in Chromium", async ({
  page,
  baseURL,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "the aggregate browser gate uses Chromium");
  test.setTimeout(900_000);
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
  const kernelWasmUrl = asViteFsUrl(kernelWasmPath);
  const reusableKernelWorkerUrl = asViteFsUrl(reusableKernelWorkerPath);
  const browserKernelModuleUrl = asViteFsUrl(browserKernelModulePath);
  const kernelOwnedBootModuleUrl = asViteFsUrl(kernelOwnedBootModulePath);
  const results = await page.evaluate(async ({
    browserKernelModuleUrl,
    kernelWasmUrl,
    kernelOwnedBootModuleUrl,
    programUrl,
    reusableKernelWorkerUrl,
    spawnChildPath,
  }) => {
    const { BrowserKernel } = await import(
      /* @vite-ignore */ browserKernelModuleUrl
    );
    const {
      createEmptyBuildFs,
      finalizeKernelOwnedImage,
    } = await import(/* @vite-ignore */ kernelOwnedBootModuleUrl);
    const run = async (
      mode: "pipe" | "fork" | "spawn",
      count: number,
    ): Promise<ChurnResult> => {
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
        let vfsImage: "default" | Uint8Array = "default";
        if (mode === "spawn") {
          const size = Number(response.headers.get("content-length"));
          if (!Number.isSafeInteger(size) || size <= 0) {
            throw new Error(`program response has invalid content length: ${size}`);
          }
          const buildFs = createEmptyBuildFs();
          buildFs.registerLazyFile(spawnChildPath, programUrl, size, 0o755);
          vfsImage = await finalizeKernelOwnedImage(buildFs);
        }
        await kernel.initFromImage({ vfsImage });
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
    const runReusableKernelProbe = (
      iterations: number,
    ): Promise<StackProbeResult> => new Promise((resolve, reject) => {
      const worker = new Worker(reusableKernelWorkerUrl, { type: "module" });
      worker.onerror = (event) => {
        worker.terminate();
        reject(new Error(event.message));
      };
      worker.onmessage = (
        event: MessageEvent<StackProbeResult | { error: string }>,
      ) => {
        worker.terminate();
        if ("error" in event.data) {
          reject(new Error(event.data.error));
        } else {
          resolve(event.data);
        }
      };
      worker.postMessage({ kernelWasmUrl, iterations });
    });
    return {
      pipeWarm: await run("pipe", 1_000),
      pipeStress: await run("pipe", 20_000),
      forkWarm: await run("fork", 8),
      // Keep this below Chromium's separate, existing process-memory
      // reclamation limit so this test isolates the kernel heap allocator.
      forkStress: await run("fork", 64),
      spawnWarm: await run("spawn", 8),
      // Chromium currently delays reclaiming disposable process-worker
      // memories under long serial spawn churn. Keep a real transport smoke
      // below that separate host-resource boundary, then exercise the exact
      // reusable kernel exit/reap invariant in one dedicated Worker without
      // allocating thousands of unrelated guest memories.
      spawnStress: await run("spawn", 16),
      reusableKernel: await runReusableKernelProbe(4_096),
    };
  }, {
    browserKernelModuleUrl,
    kernelWasmUrl,
    kernelOwnedBootModuleUrl,
    programUrl,
    reusableKernelWorkerUrl,
    spawnChildPath,
  });

  const { reusableKernel, ...churnResults } = results;
  for (const [name, result] of Object.entries(churnResults)) {
    expect(result.exitCode, `${name}: ${JSON.stringify(result)}`).toBe(0);
    expect(result.stderr, name).toBe("");
    expect(result.hostDiagnostics, name).toEqual([]);
  }
  expect(results.pipeWarm.stdout).toContain("KERNEL_ALLOCATOR_PIPE_PASS count=1000");
  expect(results.pipeStress.stdout).toContain("KERNEL_ALLOCATOR_PIPE_PASS count=20000");
  expect(results.forkWarm.stdout).toContain("KERNEL_ALLOCATOR_FORK_PASS count=8");
  expect(results.forkStress.stdout).toContain("KERNEL_ALLOCATOR_FORK_PASS count=64");
  expect(results.spawnWarm.stdout).toContain("KERNEL_ALLOCATOR_SPAWN_PASS count=8");
  expect(results.spawnStress.stdout).toContain("KERNEL_ALLOCATOR_SPAWN_PASS count=16");
  expect(reusableKernel.iterations).toBe(4_096);
  expect(reusableKernel.finalStackPointer).toBe(
    reusableKernel.baselineStackPointer,
  );

  expect(results.pipeStress.kernelMemoryPages).toBeLessThanOrEqual(
    results.pipeWarm.kernelMemoryPages + 16,
  );
  expect(results.forkStress.kernelMemoryPages).toBeLessThanOrEqual(
    results.forkWarm.kernelMemoryPages + 64,
  );
  expect(results.spawnStress.kernelMemoryPages).toBeLessThanOrEqual(
    results.spawnWarm.kernelMemoryPages + 64,
  );
  expect(runtimeErrors).toEqual([]);
});
