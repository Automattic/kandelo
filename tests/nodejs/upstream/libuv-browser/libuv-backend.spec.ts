import { test, expect } from "../../../../apps/browser-demos/playwright-test";
import { runFetchedWasmProgram } from "../../../../apps/browser-demos/test/run-fetched-wasm-program";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { resolveBinary } from "../../../../host/src/binary-resolver";

const program = process.env.KANDELO_LIBUV_CONTROLS_WASM;
if (!program || !isAbsolute(program)) {
  throw new Error("Set KANDELO_LIBUV_CONTROLS_WASM to the absolute probe path from libuv/test/build-controls.sh");
}
const kernel = resolveBinary("kernel.wasm");
function identity(path: string) {
  const bytes = readFileSync(path);
  return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

test("real libuv loop backend", async ({ page, baseURL, browser }, testInfo) => {
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
      argv: ["libuv-backend-controls"], timeoutMs: 60_000, seedEtc: false,
    });
    const row = result as { exitCode: number; stdout: string; stderr: string; hostDiagnostics: unknown[] };
    expect(row.exitCode, row.stderr).toBe(0);
    expect(row.stderr).toBe("");
    expect(row.hostDiagnostics).toEqual([]);
    const rows = row.stdout.trim().split("\n").map((line) => JSON.parse(line));
    const summary = rows.pop();
    expect(summary).toEqual({ kind: "libuv-backend-controls", cases: 13, failures: 0 });
    expect(rows).toHaveLength(13);
    expect(new Set(rows.map((item) => item.case)).size).toBe(13);
    expect(rows.every((item) => item.status === "pass")).toBe(true);
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
      scope: "Focused libuv controls in real browser-host Kandelo guest; no Node.js startup",
      program: identity(program), kernel: identity(kernel), resources, runtimeErrors, result, error,
    }, null, 2) + "\n");
  }
});
