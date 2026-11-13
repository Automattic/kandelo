import { test, expect } from "../../../../apps/browser-demos/playwright-test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { resolveBinary } from "../../../../host/src/binary-resolver";

const programArgument = process.env.KANDELO_NODE_PROCESS_VERSIONS_ENGINE_WASM;
if (!programArgument || !isAbsolute(programArgument))
  throw new Error("KANDELO_NODE_PROCESS_VERSIONS_ENGINE_WASM must name the absolute focused engine artifact");
const program = programArgument;
const kernel = resolveBinary("kernel.wasm");
const fixture = resolve("tests/nodejs/upstream/process-versions-engine-controls.js");
function identity(path: string) {
  const bytes = readFileSync(path);
  return { path, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

test("native process versions describe actual build and engine metadata", async ({ page, baseURL, browser }, testInfo) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  const resources: Array<Record<string, unknown>> = [];
  const responses: Promise<void>[] = [];
  const runs: Array<Record<string, unknown>> = [];
  page.on("pageerror", (error) => errors.push("pageerror: " + error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push("console: " + message.text()); });
  page.on("requestfailed", (request) => errors.push("requestfailed: " + request.url() + " " + request.failure()?.errorText));
  page.on("response", (response) => {
    if (response.url().includes(".wasm") && !response.url().includes("js.wasm") && !response.url().includes("?import"))
      responses.push((async () => {
        const bytes = await response.body();
        resources.push({ url: response.url(), status: response.status(), bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex") });
      })());
  });
  const setup = "__kandeloUpstreamTest.initializeContext();const realm=__kandeloUpstreamTest.initializeRealm();const queue=realm.internalBinding('task_queue');";
  const cases = [
    { name: "binding-controls", source: readFileSync(fixture, "utf8"), code: 0, stdout: undefined, stderr: undefined },
    { name: "queued-job-natural-exit", source: setup + "queue.enqueueMicrotask(()=>print('MICROTASK_DONE'));", code: 0, stdout: "MICROTASK_DONE", stderr: undefined },
    { name: "queued-job-quit-status", source: setup + "queue.enqueueMicrotask(()=>quit(23));", code: 23, stdout: undefined, stderr: undefined },
    { name: "original-unhandled-job-error-is-preserved", source: setup + "queue.enqueueMicrotask(()=>{throw new Error('UNHANDLED_JOB_FAILURE_BOUNDARY')});", code: 3, stdout: undefined, stderr: "UNHANDLED_JOB_FAILURE_BOUNDARY" },
  ];
  let failure: unknown;
  try {
    await page.goto(new URL("/pages/test-runner/?minimal=1", baseURL).href);
    await page.waitForFunction(() => (window as any).__testRunnerReady === true);
    const artifactModuleUrl = new URL("/@fs/" + resolve("tests/nodejs/upstream/process-versions-browser/artifact-url.ts"), baseURL).href;
    const programUrl = await page.evaluate(async (url) => (await import(url)).default as string, artifactModuleUrl);
    for (const control of cases) {
      const observed = await page.evaluate(async ({ url, source }) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`engine fetch failed: ${response.status}`);
        const bytes = await response.arrayBuffer();
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
        const result = await (window as any).__runTest(bytes,
          ["js", "--kandelo-test-upstream", "-e", source], 90_000,
          { seedEtc: false, env: ["PATH=/usr/bin:/bin"] });
        return { artifact: { url: response.url, bytes: bytes.byteLength, sha256 }, result };
      }, { url: programUrl, source: control.source });
      expect(observed.artifact.bytes).toBe(identity(program).bytes);
      expect(observed.artifact.sha256).toBe(identity(program).sha256);
      resources.push(observed.artifact);
      const result = observed.result;
      const entry: Record<string, unknown> = { name: control.name, result, status: "observed" };
      runs.push(entry);
      expect(result.exitCode, JSON.stringify(result)).toBe(control.code);
      if (control.stderr) expect(result.stderr).toContain(control.stderr);
      else expect(result.stderr).toBe("");
      expect(result.hostDiagnostics).toEqual([]);
      if (control.stdout) expect(result.stdout.trim()).toBe(control.stdout);
      if (control.name === "binding-controls") {
        const rows = result.stdout.trim().split("\n").map((line: string) => JSON.parse(line));
        expect(rows).toHaveLength(1);
        const row = rows[0];
        expect(row.kind).toBe("native-process-versions-controls");
        expect(row.cases).toBe(12); expect(row.failures).toBe(0);
        expect(row.observations).toHaveLength(12);
        expect(new Set(row.observations.map((item: { name: string }) => item.name)).size).toBe(12);
        expect(row.observations.every((item: { status: string }) => item.status === "pass")).toBe(true);
        entry.detail = row;
      }
      entry.status = "pass";
    }
    await Promise.all(responses);
    expect(resources.some((item) => item.sha256 === identity(kernel).sha256)).toBe(true);
    expect(errors).toEqual([]);
  } catch (caught) {
    failure = caught instanceof Error ? { name: caught.name, message: caught.message, stack: caught.stack } : String(caught);
    throw caught;
  } finally {
    await Promise.allSettled(responses);
    writeFileSync(join(process.env.KANDELO_LIBUV_REPORT_DIR!, "process-versions-" + testInfo.project.name + ".json"), JSON.stringify({
      schema: 1, completedAt: new Date().toISOString(), host: testInfo.project.name,
      browserVersion: browser.version(), scope: "Native process version and actual library/engine metadata controls; not successful upstream Node startup",
      program: identity(program), kernel: identity(kernel), fixture: identity(fixture), resources, errors, runs, failure,
    }, null, 2) + "\n");
  }
});
