import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runFetchedWasmProgram } from "./run-fetched-wasm-program";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
for (const [arch, file] of [
  ["wasm32", "examples/epoll_semantics_test.wasm"],
  ["wasm64", "examples/epoll_semantics_test.wasm64.wasm"],
]) {
  test(`${arch} epoll semantics in production browser workers`, async ({ page, baseURL }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto("/pages/test-runner/?minimal=1");
    await page.waitForFunction(() => (window as any).__testRunnerReady === true);
    const program = resolve(root, file);
    const result = await page.evaluate(runFetchedWasmProgram, {
      programUrl: new URL(`/@fs/${program}`, baseURL).href,
      argv: ["epoll-semantics"], timeoutMs: 60_000, wasmByteDataFiles: ["/epoll-self"],
      // Match the Node probe's empty image; no default rootfs programs are used.
      seedEtc: false,
    });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("EPOLL_SEMANTICS_PASS");
    expect(result.stderr).toBe("");
    expect(result.hostDiagnostics).toEqual([]);
    expect(errors).toEqual([]);
  });
}
