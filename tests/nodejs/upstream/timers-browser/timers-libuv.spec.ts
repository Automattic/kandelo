import { test, expect } from "../../../../apps/browser-demos/playwright-test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { resolveBinary } from "../../../../host/src/binary-resolver";

const programArgument = process.env.KANDELO_NODE_UV_ENGINE_WASM;
if (!programArgument || !isAbsolute(programArgument)) {
  throw new Error("KANDELO_NODE_UV_ENGINE_WASM must name the absolute focused engine artifact");
}
const program = programArgument;
const kernel = resolveBinary("kernel.wasm");
const fixture = resolve("tests/nodejs/upstream/timers-engine-controls.js");
function identity(path: string) {
  const bytes = readFileSync(path);
  return { path, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

test("native Node timers use actual libuv", async ({ page, baseURL, browser }, testInfo) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  const resources: Array<Record<string, unknown>> = [];
  const responses: Promise<void>[] = [];
  const runs: Array<Record<string, unknown>> = [];
  page.on("pageerror", (error) => errors.push("pageerror: " + error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push("console: " + message.text());
  });
  page.on("requestfailed", (request) => errors.push("requestfailed: " + request.url() + " " + request.failure()?.errorText));
  page.on("response", (response) => {
    // The program's exact consumed buffer is hashed in-page below. Inspector
    // body storage cannot retain this engine-sized response on all browsers.
    if (response.url().includes(".wasm") && !response.url().includes("js.wasm") &&
        !response.url().includes("?import")) responses.push((async () => {
      const bytes = await response.body();
      resources.push({ url: response.url(), status: response.status(), bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex") });
    })());
  });
  const setup = "__kandeloUpstreamTest.initializeContext();const realm=__kandeloUpstreamTest.initializeRealm();const timers=realm.internalBinding('timers');";
  const cases = [
    { name: "binding-controls", source: readFileSync(fixture, "utf8"), code: 0 },
    { name: "unreferenced-timer-natural-exit", source: setup + "timers.setupTimers(()=>{throw new Error('unexpected immediate')},()=>{throw new Error('unexpected timer')});timers.getLibuvNow();timers.scheduleTimer(0);timers.toggleTimerRef(false);print('UNREF_PENDING');", code: 0 },
    { name: "unreferenced-immediate-natural-exit", source: setup + "timers.setupTimers(()=>{throw new Error('unexpected immediate')},()=>{throw new Error('unexpected timer')});timers.immediateInfo[0]=1;timers.toggleImmediateRef(false);print('UNREF_PENDING');", code: 0 },
    { name: "callback-quit-status", source: setup + "timers.setupTimers(()=>{},()=>quit(23));timers.getLibuvNow();timers.scheduleTimer(0);timers.toggleTimerRef(true);", code: 23 },
  ];
  let failure: unknown;
  try {
    await page.goto(new URL("/pages/test-runner/?minimal=1", baseURL).href);
    await page.waitForFunction(() => (window as any).__testRunnerReady === true);
    const artifactModuleUrl = new URL("/@fs/" + resolve("tests/nodejs/upstream/timers-browser/artifact-url.ts"), baseURL).href;
    const programUrl = await page.evaluate(async (url) => (await import(url)).default as string, artifactModuleUrl);
    for (const control of cases) {
      const observed = await page.evaluate(async ({ url, source }) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`engine fetch failed: ${response.status}`);
        const bytes = await response.arrayBuffer();
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
        const artifact = { url: response.url, bytes: bytes.byteLength, sha256 };
        const result = await (window as any).__runTest(bytes,
          ["js", "--kandelo-test-upstream", "-e", source], 90_000,
          { seedEtc: false, env: ["PATH=/usr/bin:/bin"] });
        return { artifact, result };
      }, { url: programUrl, source: control.source });
      expect(observed.artifact.bytes).toBe(identity(program).bytes);
      expect(observed.artifact.sha256).toBe(identity(program).sha256);
      resources.push(observed.artifact);
      const result = observed.result;
      const entry: Record<string, unknown> = { name: control.name, result, status: "observed" };
      runs.push(entry);
      expect(result.exitCode, JSON.stringify(result)).toBe(control.code);
      expect(result.stderr).toBe("");
      expect(result.hostDiagnostics).toEqual([]);
      if (control.name === "binding-controls") {
        const rows = result.stdout.trim().split("\n").map((line: string) => JSON.parse(line));
        expect(rows).toHaveLength(1);
        const row = rows[0];
        expect(row.kind).toBe("native-timers-controls");
        expect(row.cases).toBe(27); expect(row.failures).toBe(0);
        expect(row.observations).toHaveLength(27);
        expect(new Set(row.observations.map((item: { name: string }) => item.name)).size).toBe(27);
        expect(row.observations.every((item: { status: string }) => item.status === "pass")).toBe(true);
        entry.detail = row;
      } else if (control.name.startsWith("unreferenced")) {
        expect(result.stdout.trim()).toBe("UNREF_PENDING");
      }
      entry.status = "pass";
    }
    await Promise.all(responses);
    expect(resources.some((item) => item.sha256 === identity(program).sha256)).toBe(true);
    expect(resources.some((item) => item.sha256 === identity(kernel).sha256)).toBe(true);
    expect(errors).toEqual([]);
  } catch (caught) {
    failure = caught instanceof Error ? { name: caught.name, message: caught.message, stack: caught.stack } : String(caught);
    throw caught;
  } finally {
    await Promise.allSettled(responses);
    writeFileSync(join(process.env.KANDELO_LIBUV_REPORT_DIR!, "timers-" + testInfo.project.name + ".json"), JSON.stringify({
      schema: 1, completedAt: new Date().toISOString(), host: testInfo.project.name,
      browserVersion: browser.version(), scope: "Native Node timers/libuv binding controls; not upstream Node startup",
      program: identity(program), kernel: identity(kernel), fixture: identity(fixture),
      resources, errors, runs, failure,
    }, null, 2) + "\n");
  }
});
