import assert from "node:assert/strict";
import test from "node:test";
import { accountAttempt, parseQpaRecords, runChunk, strictVerdict, summarize } from "./cts-accounting.mjs";

const done = (name, status = "Pass") => `#beginTestCaseResult ${name}\n`
  + `<TestCaseResult CasePath="${name}" Version="0.3.4"><Result StatusCode="${status}">${status} details</Result></TestCaseResult>\n`
  + "#endTestCaseResult\n";
const begun = name => `#beginTestCaseResult ${name}\n<TestCaseResult CasePath="${name}" Version="0.3.4">\n`;
const exit0 = { kind: "exit", code: 0 };

test("parses complete, terminated, open and malformed records", () => {
  const records = parseQpaRecords(done("a") + `${begun("b")}\n#terminateTestCaseResult Timeout\n`
    + done("c").replace("</TestCaseResult>", "") + begun("d"));
  assert.deepEqual(records.map(r => [r.path, r.state, r.status]),
    [["a", "complete", "Pass"], ["b", "complete", "Timeout"], ["c", "malformed", undefined], ["d", "open", undefined]]);
});

test("keeps upstream statuses verbatim and never upgrades NotSupported", () => {
  const result = accountAttempt(["a", "b", "c", "d"], done("a") + done("b", "NotSupported")
    + done("c", "QualityWarning") + done("d", "CompatibilityWarning"), exit0);
  assert.deepEqual(result.rows.map(r => r.status), ["Pass", "NotSupported", "QualityWarning", "CompatibilityWarning"]);
  assert.deepEqual(result.left, []);
});

test("attributes an abnormal end to the open case only", () => {
  const crash = accountAttempt(["a", "b", "c"], done("a") + begun("b"), { kind: "exit", code: 134 });
  assert.deepEqual(crash.rows.map(r => [r.path, r.status]), [["a", "Pass"], ["b", "Crash"]]);
  assert.deepEqual(crash.resume, ["c"]);
  const timeout = accountAttempt(["a", "b"], begun("a"), { kind: "timeout" });
  assert.deepEqual(timeout.rows.map(r => [r.path, r.status]), [["a", "Timeout"]]);
  const early = accountAttempt(["a", "b"], "", { kind: "error", message: "init failed" });
  assert.deepEqual([early.rows, early.resume, early.left], [[], [], ["a", "b"]]);
  const clean = accountAttempt(["a", "b"], done("a"), exit0);
  assert.deepEqual([clean.abnormal, clean.left, clean.resume], [false, ["b"], []]);
});

test("dEQP's exit 1 after a complete session with failures is a normal completion", async () => {
  const session = body => `#beginSession\n${body}\n#endSession\n`;
  const exit1 = { kind: "exit", code: 1 };
  const failed = accountAttempt(["a", "b"], session(done("a") + done("b", "Fail")), exit1);
  assert.deepEqual([failed.abnormal, failed.attributed, failed.left], [false, null, []]);
  assert.deepEqual(failed.rows.map(r => r.status), ["Pass", "Fail"]);
  const chunk = await runChunk({ id: "f#000", family: "f", cases: ["a", "b"] },
    async () => ({ qpa: session(done("a", "ResourceError") + done("b")), outcome: exit1 }));
  assert.equal(chunk.crashed, null);
  assert.deepEqual(chunk.attempts.map(a => a.outcome), [exit1]);
  // Exit 1 is abnormal without dEQP's own evidence for it: no failed case,
  // an unclosed session, an open record or a case dEQP never reported.
  assert.equal(accountAttempt(["a"], session(done("a")), exit1).abnormal, true);
  assert.equal(accountAttempt(["a"], done("a", "Fail"), exit1).abnormal, true);
  const open = accountAttempt(["a", "b"], session(done("a", "Fail") + begun("b")), exit1);
  assert.deepEqual([open.abnormal, open.attributed], [true, "b"]);
  assert.equal(accountAttempt(["a", "b"], session(done("a", "Fail")), exit1).abnormal, true);
  assert.equal(accountAttempt(["a"], session(done("a", "Fail")), { kind: "exit", code: 134 }).abnormal, true);
});

test("records unexpected and duplicate cases", () => {
  const result = accountAttempt(["a"], done("a") + done("a") + done("x"), exit0);
  assert.deepEqual([result.unexpected, result.duplicates], [["x"], ["a"]]);
});

test("a crash loses only the crashed case; the chunk resumes after it", async () => {
  const chunk = { id: "f#000", family: "f", cases: ["a", "b", "c", "d"] };
  const calls = [];
  const result = await runChunk(chunk, async remaining => {
    calls.push(remaining);
    if (remaining[0] === "a") return { qpa: done("a") + begun("b"), outcome: { kind: "exit", code: 139 } };
    return { qpa: remaining.map(name => done(name, name === "d" ? "Fail" : "Pass")).join(""), outcome: exit0 };
  });
  assert.deepEqual(calls, [["a", "b", "c", "d"], ["c", "d"]]);
  assert.deepEqual(result.rows.map(r => [r.path, r.status, r.attempt]),
    [["a", "Pass", 1], ["b", "Crash", 1], ["c", "Pass", 2], ["d", "Fail", 2]]);
  assert.deepEqual(result.crashed, { attempt: 1, case: "b", reason: "exit 139" });
});

test("an abnormal end after a finished case resumes after it; one without progress does not", async () => {
  const session = body => `#beginSession\n${body}\n#endSession\n`;
  // dEQP ends its session after a ResourceError (terminateAfter) with exit 1.
  const early = accountAttempt(["a", "b", "c"], session(done("a") + done("b", "ResourceError")), { kind: "exit", code: 1 });
  assert.deepEqual([early.abnormal, early.attributed, early.resume], [true, null, ["c"]]);
  // A threaded case that fails can abort the program from deinit (exit 134)
  // after its record is complete.
  const calls = [];
  const chunk = await runChunk({ id: "f#000", family: "f", cases: ["a", "b", "c", "d"] }, async remaining => {
    calls.push(remaining);
    if (remaining[0] === "a") return { qpa: done("a") + done("b", "Fail"), outcome: { kind: "exit", code: 134 } };
    return { qpa: session(remaining.map(name => done(name)).join("")), outcome: exit0 };
  });
  assert.deepEqual(calls, [["a", "b", "c", "d"], ["c", "d"]]);
  assert.deepEqual(chunk.rows.map(r => [r.path, r.status, r.attempt]),
    [["a", "Pass", 1], ["b", "Fail", 1], ["c", "Pass", 2], ["d", "Pass", 2]]);
  assert.deepEqual(chunk.crashed, { attempt: 1, case: null, reason: "exit 134" });
  // A case dEQP skipped before the last finished one is not retried.
  const skipped = accountAttempt(["a", "b", "c"], done("b"), { kind: "exit", code: 134 });
  assert.deepEqual([skipped.left, skipped.resume], [["a", "c"], ["c"]]);
  // A clean exit never resumes, and an attempt that finished nothing does not either.
  assert.deepEqual(accountAttempt(["a", "b"], done("a"), exit0).resume, []);
  assert.deepEqual(accountAttempt(["a", "b"], "", { kind: "exit", code: 134 }).resume, []);
});

test("no progress, lost runners and the resume limit leave Missing cases", async () => {
  const chunk = { id: "f#000", family: "f", cases: ["a", "b"] };
  const stalled = await runChunk(chunk, async () => ({ qpa: "", outcome: { kind: "error", message: "boom" } }));
  assert.deepEqual(stalled.rows.map(r => r.status), ["Missing", "Missing"]);
  assert.equal(stalled.attempts.length, 1);
  const lost = await runChunk(chunk, async () => { throw new Error("page crashed"); });
  assert.deepEqual(lost.rows.map(r => [r.status, r.detail]), [["Missing", "not run: runner lost"], ["Missing", "not run: runner lost"]]);
  assert.match(lost.crashed.reason, /page crashed/);
  const limited = await runChunk({ ...chunk, cases: ["a", "b", "c"] },
    async remaining => ({ qpa: begun(remaining[0]), outcome: { kind: "timeout" } }), { maxAttempts: 2 });
  assert.deepEqual(limited.rows.map(r => r.status), ["Timeout", "Timeout", "Missing"]);
});

test("summarizes per engine and family, reports absent chunks and strict failures", () => {
  const plan = { suite: "egl", selector: "all", chunkSize: 2, inventorySha256: "x", caseCount: 3,
    chunks: [{ id: "f#000", family: "f", cases: ["f.1", "f.2"] }, { id: "g#000", family: "g", cases: ["g.1"] }] };
  const passing = { id: "f#000", family: "f", rows: [
    { path: "f.1", status: "Pass", attempt: 1, detail: "ok" }, { path: "f.2", status: "NotSupported", attempt: 1, detail: "no\tcap" }] };
  const { summary, tsv } = summarize(plan, { chromium: [passing, { id: "g#000", family: "g", rows: [
    { path: "g.1", status: "Pass", attempt: 1 }] }], webkit: [passing] });
  assert.deepEqual(summary.engines.chromium.totals,
    { Pass: 2, Fail: 0, NotSupported: 1, QualityWarning: 0, CompatibilityWarning: 0, Crash: 0, Timeout: 0, Missing: 0 });
  assert.equal(summary.engines.chromium.strictFailures, 0);
  assert.equal(summary.engines.webkit.families.g.Missing, 1);
  assert.deepEqual(summary.engines.webkit.crashedChunks, [{ chunk: "g#000", attempt: 0, case: null, reason: "chunk result absent" }]);
  assert.equal(tsv.split("\n").filter(Boolean).length, 1 + 3 + 3);
  assert.match(tsv, /chromium\tf#000\tf\tf\.2\tNotSupported\t1\tno cap/);
  const verdict = strictVerdict(summary);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons.join(), /webkit: 1 case/);
  assert.equal(strictVerdict(summarize(plan, { chromium: summary && [passing, { id: "g#000", family: "g",
    rows: [{ path: "g.1", status: "Pass", attempt: 1 }] }] }).summary).ok, true);
  const wrong = summarize(plan, { node: [{ ...passing, rows: passing.rows.slice(1) }] }).summary;
  assert.match(wrong.accountingErrors[0], /do not match/);
  assert.equal(strictVerdict({ engines: {}, accountingErrors: [] }).ok, false);
});
