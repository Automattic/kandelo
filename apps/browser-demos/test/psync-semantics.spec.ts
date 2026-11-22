import { expect, test } from "../playwright-test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runFetchedWasmProgram } from "./run-fetched-wasm-program";
import { checkPsyncSemantics } from "../../../host/test/fixtures/psync-semantics";

const __dirname = dirname(fileURLToPath(import.meta.url));
const programPath = resolve(
  __dirname,
  "../../../examples/psync_semantics_test.wasm",
);

// Process-shared synchronization goes through the same kernel worker on
// both hosts, so the browser must report the same result for every case as
// Node does (host/test/psync-semantics.test.ts, one shared expectation
// table).
test(
  "process-shared synchronization matches the recorded results in Chromium",
  async ({ page, baseURL, browserName }) => {
    test.skip(
      browserName !== "chromium",
      "the aggregate browser gate uses Chromium",
    );
    test.setTimeout(300_000);
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
      argv: ["psync_semantics_test"],
      timeoutMs: 240_000,
    });

    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(checkPsyncSemantics(result.stdout), result.stdout).toEqual([]);
    expect(runtimeErrors).toEqual([]);
  },
);
