import assert from "node:assert/strict";
import test from "node:test";
import { CaseProgress, ctsAttemptCeilingMs, ctsDeadlineConfig, waitForExitOrStall } from "./cts-progress.mjs";

const config = { startupMs: 100, caseMs: 1000 };

test("reads the startup and per-case limits from the environment and rejects nonsense", () => {
  assert.deepEqual(ctsDeadlineConfig({}), { startupMs: 60_000, caseMs: 600_000 });
  assert.deepEqual(ctsDeadlineConfig({ KANDELO_CTS_ATTEMPT_BASE_MS: "5", KANDELO_CTS_CASE_MS: "7" }), { startupMs: 5, caseMs: 7 });
  for (const bad of ["0", "-1", "x"]) {
    assert.throws(() => ctsDeadlineConfig({ KANDELO_CTS_CASE_MS: bad }), /must be positive/);
    assert.throws(() => ctsDeadlineConfig({ KANDELO_CTS_ATTEMPT_BASE_MS: bad }), /must be positive/);
  }
  assert.equal(ctsAttemptCeilingMs(3, config), 3100);
  assert.equal(ctsAttemptCeilingMs(0, config), 1100);
});

test("gives startup its own limit, then resets the deadline at every case line", () => {
  const progress = new CaseProgress(config, 0);
  assert.equal(progress.deadline(), 100);
  assert.equal(progress.expired(99), false);
  assert.equal(progress.expired(100), true);
  progress.feed("Writing test log into /tmp/result.qpa\n\nTest case 'dEQP-EGL.a'..\n", 50);
  assert.deepEqual([progress.cases, progress.current, progress.deadline()], [1, "dEQP-EGL.a", 1050]);
  progress.feed("  Pass (ok)\n", 900);
  assert.equal(progress.deadline(), 1050, "a result line is not a new case");
  progress.feed("\nTest case 'dEQP-EGL.b'..\n", 1040);
  assert.equal(progress.deadline(), 2040);
  assert.deepEqual(progress.snapshot(2500),
    { casesEntered: 2, lastCase: "dEQP-EGL.b", sinceLastCaseMs: 1460, limitMs: 1000, elapsedMs: 2500 });
});

test("matches case lines split across output pieces and only complete lines", () => {
  const progress = new CaseProgress(config, 0);
  progress.feed("\nTest ca", 10);
  progress.feed("se 'dEQP-EGL.split'", 20);
  assert.equal(progress.cases, 0, "a line is not complete until its newline");
  progress.feed("..\r\n", 30);
  assert.deepEqual([progress.cases, progress.current, progress.lastAt], [1, "dEQP-EGL.split", 30]);
  progress.feed("noise Test case 'dEQP-EGL.embedded'..\n", 40);
  assert.equal(progress.cases, 1, "a case line must start the line");
  progress.feed("x".repeat(10_000), 50);
  assert.ok(progress.partial.length <= 4096);
});

test("resolves exit, error or stall, whichever comes first", async () => {
  const exited = await waitForExitOrStall(Promise.resolve(1), new CaseProgress({ startupMs: 10_000, caseMs: 10_000 }));
  assert.deepEqual(exited, { kind: "exit", code: 1 });
  const failed = await waitForExitOrStall(Promise.reject(new Error("lost")), new CaseProgress(config));
  assert.deepEqual(failed, { kind: "error", message: "Error: lost" });
  const never = new Promise(() => {});
  const started = Date.now();
  const stalled = await waitForExitOrStall(never, new CaseProgress({ startupMs: 30, caseMs: 30 }), { pollMs: 5 });
  assert.deepEqual(stalled, { kind: "timeout" });
  assert.ok(Date.now() - started >= 30);
});

test("keeps a progressing guest alive past the flat budget and stops a stalled one", async () => {
  const progress = new CaseProgress({ startupMs: 40, caseMs: 40 });
  let cases = 0;
  const feeder = setInterval(() => { progress.feed(`\nTest case 'dEQP-EGL.c${cases++}'..\n`); }, 10);
  const exit = new Promise(resolve => setTimeout(() => { clearInterval(feeder); resolve(0); }, 200));
  assert.deepEqual(await waitForExitOrStall(exit, progress, { pollMs: 5 }), { kind: "exit", code: 0 });
  assert.ok(cases > 5);
  const stalled = new CaseProgress({ startupMs: 40, caseMs: 40 });
  stalled.feed("\nTest case 'dEQP-EGL.hang'..\n");
  assert.deepEqual(await waitForExitOrStall(new Promise(() => {}), stalled, { pollMs: 5 }), { kind: "timeout" });
  assert.equal(stalled.current, "dEQP-EGL.hang");
});
