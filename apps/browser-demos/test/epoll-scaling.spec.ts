import { expect, test } from "../playwright-test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runFetchedWasmProgram } from "./run-fetched-wasm-program";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
for (const count of [32, 2048]) {
  for (const mode of ["lt", "et"]) {
    test(`${count} registrations, ${mode} scaling diagnostic`, async ({ page, baseURL, browserName }) => {
      test.setTimeout(150_000);
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto("/pages/test-runner/?minimal=1");
      await page.waitForFunction(() => (window as any).__testRunnerReady === true);
      const program = resolve(root, "examples/epoll_semantics_test.wasm");
      const result = await page.evaluate(runFetchedWasmProgram, {
        programUrl: new URL(`/@fs/${program}`, baseURL).href,
        argv: ["epoll-scale", "--bench", String(count), mode], timeoutMs: 120_000,
        seedEtc: false,
      });
      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.hostDiagnostics).toEqual([]);
      expect(errors).toEqual([]);
      expect(result.stdout).toContain('"phase":"total"');
      console.log(`EPOLL_SCALE_CONTEXT ${JSON.stringify({ host: browserName, count, mode })}`);
      console.log(result.stdout);
    });
  }
}
