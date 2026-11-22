import { expect, test } from "../playwright-test";
import { resolve } from "node:path";
import { runFetchedWasmProgram } from "./run-fetched-wasm-program";

const programPath = resolve(import.meta.dirname, "../../../examples/random_read_test.wasm");

test("reads random devices across host entropy quotas as uid 1000", async ({ page, baseURL }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(new URL("/pages/test-runner/?minimal=1", baseURL).href);
  await page.waitForFunction(() => (window as any).__testRunnerReady === true);
  const result = await page.evaluate(runFetchedWasmProgram, {
    programUrl: new URL(`/@fs/${programPath}`, baseURL).href,
    argv: ["random-read-test"],
    timeoutMs: 30_000,
  });
  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("RANDOM_READ_PASS uid=1000");
  expect(result.stderr).toBe("");
  expect(errors).toEqual([]);
});

for (const [mode, marker] of [["--interrupt", "RANDOM_INTERRUPT_PASS"], ["--pending-exit", "RANDOM_PENDING_EXIT"]]) {
  test(`retires pending entropy through ${mode}`, async ({ page, baseURL }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(new URL("/pages/test-runner/?minimal=1", baseURL).href);
    await page.waitForFunction(() => (window as any).__testRunnerReady === true);
    const result = await page.evaluate(runFetchedWasmProgram, {
      programUrl: new URL(`/@fs/${programPath}`, baseURL).href,
      argv: ["random-read-test", mode], timeoutMs: 30_000,
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(marker);
    expect(result.stderr).toBe("");
    expect(errors).toEqual([]);
  });
}

test("keeps kernel memory flat during increasing and repeated entropy reads", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  await page.goto(new URL("/pages/test-runner/?minimal=1", baseURL).href);
  const result = await page.evaluate(async ({ programUrl, moduleUrl }) => {
    const { BrowserKernel } = await import(/* @vite-ignore */ moduleUrl);
    let stdout = "", stderr = "", pid = 0;
    const pages: number[] = [];
    let checks = Promise.resolve();
    const kernel = new BrowserKernel({
      onStdout: (bytes: Uint8Array) => {
        stdout += new TextDecoder().decode(bytes);
        const phases = [...stdout.matchAll(/RANDOM_MEMORY_PHASE (\d+)\n/g)].length;
        while (pages.length < phases) {
          const index = pages.length;
          pages.push(-1);
          checks = checks.then(async () => {
            pages[index] = await kernel.getKernelMemoryPages();
            kernel.appendStdinData(pid, new Uint8Array([1]));
          });
        }
      },
      onStderr: (bytes: Uint8Array) => { stderr += new TextDecoder().decode(bytes); },
    });
    try {
      await kernel.initFromImage({ vfsImage: "default" });
      const response = await fetch(programUrl);
      if (!response.ok) throw new Error(`fixture fetch failed: ${response.status}`);
      const exitCode = await kernel.spawn(await response.arrayBuffer(), ["random-read-test", "--memory"],
        { onStarted: (started: number) => { pid = started; } });
      await checks;
      return { exitCode, stdout, stderr, pages };
    } finally { await kernel.destroy(); }
  }, {
    programUrl: new URL(`/@fs/${programPath}`, baseURL).href,
    moduleUrl: new URL(`/@fs/${resolve(import.meta.dirname, "../../../host/src/browser-kernel-host.ts")}`, baseURL).href,
  });
  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.pages).toHaveLength(5);
  expect(Math.max(...result.pages.slice(1)), JSON.stringify(result.pages)).toBeLessThanOrEqual(result.pages[0] + 4);
  expect(result.pages[4], JSON.stringify(result.pages)).toBe(result.pages[3]);
});
