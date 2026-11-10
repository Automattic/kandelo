import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import type { TestModule, TestSpecification } from "vitest/node";
import SuiteHealthReporter from "./support/suite-health-reporter";

const hostRoot = fileURLToPath(new URL("..", import.meta.url));
const cli = fileURLToPath(new URL("../vitest.mjs", import.meta.resolve("vitest")));
const reporter = fileURLToPath(new URL("./support/suite-health-reporter.ts", import.meta.url));

async function runWorker(source: string): Promise<{ code: number | null; output: string }> {
  const cache = join(hostRoot, "node_modules/.cache");
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, "suite-health-"));
  try {
    await writeFile(join(root, "worker.test.js"), source);
    const config = join(root, "vitest.config.mjs");
    await writeFile(config, `export default ${JSON.stringify({ test: {
      root, include: ["worker.test.js"], globals: true,
      pool: "forks", maxWorkers: 1, reporters: [reporter],
    } })};`);
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cli, "run", "--config", config], {
        cwd: root, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      // WHY: the fixture deliberately kills only its own Vitest worker. A
      // missing runner completion must fail this test, never hang the suite.
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Nested Vitest did not complete:\n${output}`));
      }, 30_000);
      child.once("error", (error) => { clearTimeout(timeout); reject(error); });
      child.once("close", (code) => { clearTimeout(timeout); resolve({ code, output }); });
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it("reports a real lost worker as failed even when Vitest's end reason is passed", async () => {
  const result = await runWorker(`
    test("completed control", () => expect(2 + 2).toBe(4));
    test.skip("explicit skip", () => {});
    afterAll(() => process.kill(process.pid, "SIGKILL"));
  `);
  expect(result.code, result.output).toBe(1);
  expect(result.output).toMatch(/1 unhandled errors/);
  // A worker can die before or after its last test-result update is flushed.
  // Keep those reported counts truthful without assuming an IPC flush order.
  expect(result.output).toMatch(/files 1 \(0 did not load, 0 fully skipped\); tests [12]: [01] passed, 0 failed, 1 skipped/);
  expect(result.output).toMatch(/\[suite-health\].*; run failed/);
  expect(result.output).not.toMatch(/\[suite-health\].*; run passed/);
}, 40_000);

it("preserves successful and skipped test counts for a healthy worker", async () => {
  const result = await runWorker(`
    test("completed control", () => expect(2 + 2).toBe(4));
    test.skip("explicit skip", () => {});
  `);
  expect(result.code, result.output).toBe(0);
  expect(result.output).toMatch(/files 1 \(0 did not load, 0 fully skipped\); tests 2: 1 passed, 0 failed, 1 skipped; run passed/);
}, 40_000);

function moduleResult(id: string, state: "passed" | "failed" | "pending" | "queued" | "skipped", tests: string[] = []): TestModule {
  return {
    id, relativeModuleId: `${id}.test.ts`, state: () => state, ok: () => state !== "failed",
    errors: () => [],
    children: { allTests: () => tests.map((state) => ({ name: "control", result: () => ({ state }), diagnostic: () => ({ duration: 1 }) })) },
  } as unknown as TestModule;
}

function selection(...ids: string[]): TestSpecification[] {
  // Two projects may select the same path; task IDs still identify each run.
  return ids.map((taskId) => ({ taskId, moduleId: "/same.test.ts" } as TestSpecification));
}

function summary(reporter: SuiteHealthReporter, modules: TestModule[], reason: "passed" | "interrupted" = "passed"): string {
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    reporter.onTestRunEnd(modules, [], reason);
    return output.mock.calls.map(([text]) => String(text)).join("");
  } finally {
    output.mockRestore();
  }
}

it("fails a selected worker with no returned module and resets selection on a rerun", () => {
  const reporter = new SuiteHealthReporter();
  reporter.onTestRunStart(selection("project-a", "project-b"));
  const output = summary(reporter, [moduleResult("project-a", "passed", ["passed", "skipped"])]);
  expect(output).toContain("tests 2: 1 passed, 0 failed, 1 skipped; run failed");
  expect(output).toContain("1 selected file(s) did not finish: 1 missing reports, 0 pending tests");
  reporter.onTestRunStart(selection("project-a"));
  expect(summary(reporter, [moduleResult("project-a", "passed", ["passed"])])).toContain("; run passed");
});

it.each(["pending", "queued", "passed"] as const)("fails an incomplete %s worker without inventing failed tests", (state) => {
  const output = summary(new SuiteHealthReporter(), [moduleResult("incomplete", state, ["passed", "pending", "skipped"])]);
  expect(output).toContain("tests 2: 1 passed, 0 failed, 1 skipped; run failed");
  expect(output).toContain("1 selected file(s) did not finish: 0 missing reports, 1 pending tests");
});

it("fails a module-level failure after passing tests", () => {
  expect(summary(new SuiteHealthReporter(), [moduleResult("afterAll", "failed", ["passed"])])).toContain("1 passed, 0 failed, 0 skipped; run failed");
});

it("preserves fully skipped files as skipped rather than incomplete", () => {
  const output = summary(new SuiteHealthReporter(), [moduleResult("optional", "skipped", ["skipped", "skipped"])]);
  expect(output).toContain("files 1 (0 did not load, 1 fully skipped); tests 2: 0 passed, 0 failed, 2 skipped; run passed");
  expect(output).not.toContain("did not finish");
});

it("keeps intentional cancellation interrupted while reporting incomplete coverage", () => {
  const reporter = new SuiteHealthReporter();
  reporter.onTestRunStart(selection("not-started"));
  const output = summary(reporter, [], "interrupted");
  expect(output).toContain("; run interrupted");
  expect(output).toContain("1 missing reports");
});
