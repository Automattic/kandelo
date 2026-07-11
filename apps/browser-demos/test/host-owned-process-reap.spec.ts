import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const browserKernelModulePath = resolve(
  repoRoot,
  "host/src/browser-kernel-host.ts",
);
const kernelBootHelpersModulePath = resolve(
  repoRoot,
  "apps/browser-demos/lib/kernel-owned-boot.ts",
);
const helloWasmPath = resolve(repoRoot, "examples/hello.wasm");

test("browser reaps a completed host-owned top-level process", async ({
  page,
  baseURL,
  browserName,
}) => {
  test.skip(
    browserName === "webkit",
    "Vite dev module workers are blocked by WebKit COEP; bundled WebKit demos have separate smoke coverage",
  );
  expect(baseURL).toBeTruthy();
  const runtimeErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);

  const result = await page.evaluate(
    async ({ browserKernelUrl, bootHelpersUrl, helloBytes }) => {
      const { BrowserKernel } = await import(/* @vite-ignore */ browserKernelUrl);
      const { createEmptyBuildFs, finalizeKernelOwnedImage } = await import(
        /* @vite-ignore */ bootHelpersUrl
      );
      const vfsImage = await finalizeKernelOwnedImage(createEmptyBuildFs());
      const kernel = new BrowserKernel({ kernelOwnedFs: true });

      try {
        await kernel.initFromImage({ vfsImage });

        let pid: number | undefined;
        const exitCode = await kernel.spawn(
          new Uint8Array(helloBytes).buffer,
          ["hello"],
          {
            // Supplying onStarted would otherwise leave stdin open. Preserve
            // the ordinary non-interactive spawn contract while capturing the
            // real top-level pid allocated for this browser worker.
            stdin: new Uint8Array(),
            onStarted(startedPid: number) {
              pid = startedPid;
            },
          },
        );
        if (pid === undefined) throw new Error("spawn did not report its pid");

        // The main-thread exit notification can arrive while worker teardown
        // is still finishing. Poll the authoritative kernel process table,
        // not enumProcs() (which intentionally omits exited entries), until
        // the completed ppid=0 process is no longer addressable.
        const deadline = performance.now() + 5_000;
        let procMapsAfterExit = await kernel.readProcMaps(pid);
        while (procMapsAfterExit !== null && performance.now() < deadline) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
          procMapsAfterExit = await kernel.readProcMaps(pid);
        }

        return { exitCode, pid, procMapsAfterExit };
      } finally {
        await kernel.destroy();
      }
    },
    {
      browserKernelUrl: new URL(`/@fs/${browserKernelModulePath}`, baseURL).href,
      bootHelpersUrl: new URL(`/@fs/${kernelBootHelpersModulePath}`, baseURL).href,
      helloBytes: Array.from(readFileSync(helloWasmPath)),
    },
  );

  expect(result.exitCode, runtimeErrors.join("\n")).toBe(0);
  expect(result.pid).toBeGreaterThan(0);
  expect(result.procMapsAfterExit).toBeNull();
});
