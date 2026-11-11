import { assertTracingOutput } from "../v8-tracing-component-assertions";
import { test, expect } from "../../../../apps/browser-demos/playwright-test";
import { runFetchedWasmProgram } from "../../../../apps/browser-demos/test/run-fetched-wasm-program";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { resolveBinary } from "../../../../host/src/binary-resolver";

const program = process.env.KANDELO_V8_TRACING_CONTROLS_WASM;
if (!program || !isAbsolute(program)) {
  throw new Error("Set KANDELO_V8_TRACING_CONTROLS_WASM to the absolute probe path from v8-tracing/test/build-controls.sh");
}
const kernel = resolveBinary("kernel.wasm");
function identity(path: string) {
  const bytes = readFileSync(path);
  return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

test("original standalone tracing library", async ({ page, baseURL, browser }, testInfo) => {
  test.setTimeout(120_000);
  const runtimeErrors: string[] = [];
  const resources: Array<Record<string, unknown>> = [];
  const responses: Promise<void>[] = [];
  page.on("pageerror", (error) => runtimeErrors.push("pageerror: " + error.message));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push("console: " + message.text());
  });
  page.on("requestfailed", (request) => runtimeErrors.push("requestfailed: " + request.url() + " " + request.failure()?.errorText));
  page.on("response", (response) => {
    if (response.url().includes(".wasm") && !response.url().includes("?import")) {
      responses.push((async () => {
        const bytes = await response.body();
        resources.push({ url: response.url(), status: response.status(), bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex") });
      })());
    }
  });
  let result: unknown;
  let error: unknown;
  try {
    await page.goto(new URL("/pages/test-runner/?minimal=1", baseURL).href);
    await page.waitForFunction(() => (window as any).__testRunnerReady === true);
    result = await page.evaluate(runFetchedWasmProgram, {
      programUrl: new URL("/@fs/" + program, baseURL).href,
      argv: ["v8-tracing-component-controls"], timeoutMs: 60_000, seedEtc: false,
    });
    const row = result as { exitCode: number; stdout: string; stderr: string; hostDiagnostics: unknown[] };
    expect(row.exitCode, row.stderr).toBe(0);
    expect(row.stderr).toBe("");
    expect(row.hostDiagnostics).toEqual([]);
    assertTracingOutput(row.stdout);
    await Promise.all(responses);
    expect(resources.some((item) => item.sha256 === identity(program).sha256)).toBe(true);
    expect(resources.some((item) => item.sha256 === identity(kernel).sha256)).toBe(true);
    expect(runtimeErrors).toEqual([]);
  } catch (caught) {
    error = caught instanceof Error ? { name: caught.name, message: caught.message, stack: caught.stack } : String(caught);
    throw caught;
  } finally {
    await Promise.allSettled(responses);
    writeFileSync(join(process.env.KANDELO_LIBUV_REPORT_DIR!, "browser-" + testInfo.project.name + ".json"), JSON.stringify({
      schema: 1, completedAt: new Date().toISOString(), host: testInfo.project.name,
      browserVersion: browser.version(),
      scope: "Standalone original tracing library in real browser-host Kandelo guest; not V8 JS engine, Node binding/agent or startup",
      program: identity(program), kernel: identity(kernel), fixture: identity("packages/registry/v8-tracing/test/component-controls.cpp"), assertions: identity("tests/nodejs/upstream/v8-tracing-component-assertions.ts"), resources, runtimeErrors, result, error,
    }, null, 2) + "\n");
  }
});
