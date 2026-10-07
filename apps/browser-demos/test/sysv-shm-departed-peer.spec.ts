import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runFetchedWasmProgram } from "./run-fetched-wasm-program";

const __dirname = dirname(fileURLToPath(import.meta.url));
const programPath = resolve(
  __dirname,
  "../../../examples/sysv_shm_departed_peer_test.wasm",
);

// The browser host shares the kernel worker's SysV coherence path with Node;
// this proves a sole surviving attachment imports a departed child's writes
// there too.
test(
  "SysV sole attachment sees a departed child's writes in Chromium",
  async ({ page, baseURL, browserName }) => {
    test.skip(
      browserName !== "chromium",
      "the aggregate browser gate uses Chromium",
    );
    expect(baseURL).toBeTruthy();

    const runtimeErrors: string[] = [];
    page.on("pageerror", (error) => {
      runtimeErrors.push(`pageerror: ${error.message}`);
    });
    page.on("console", (message) => {
      if (message.type() === "error") {
        runtimeErrors.push(`console: ${message.text()}`);
      }
    });

    await page.goto(new URL("/pages/test-runner/?minimal=1", baseURL).href);
    await page.waitForFunction(
      () => (window as any).__testRunnerReady === true,
    );

    const result = await page.evaluate(runFetchedWasmProgram, {
      programUrl: new URL(`/@fs/${programPath}`, baseURL).href,
      argv: ["sysv-shm-departed-peer-test"],
      timeoutMs: 30_000,
    });

    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("fresh-attach-shmdt: PASS");
    expect(result.stdout).toContain("fresh-attach-exit: PASS");
    expect(result.stdout).toContain("inherited-attach-exit: PASS");
    expect(result.stdout).toContain("SYSV_DEPARTED_PEER_PASS");
    expect(result.stderr).toBe("");
    expect(runtimeErrors).toEqual([]);
  },
);
