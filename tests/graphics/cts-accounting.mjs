/**
 * Per-case accounting for chunked upstream dEQP runs.
 *
 * Every planned case ends with exactly one status. Upstream QPA statuses are
 * kept verbatim (Pass, Fail, NotSupported, QualityWarning,
 * CompatibilityWarning, ResourceError, InternalError, ...). The runner adds
 * three of its own, never derived from a guess:
 * - Crash: the guest ended abnormally while this case's
 *   `#beginTestCaseResult` was open (or dEQP terminated it as Crash);
 * - Timeout: the chunk deadline expired while this case was open (or dEQP's
 *   watchdog terminated it as Timeout);
 * - Missing: no completed record exists for the case.
 * NotSupported and Missing are never converted to Pass.
 *
 * dEQP's own main (framework/platform/tcuMain.cpp) exits with EXIT_FAILURE
 * after a session that ran to completion when any case failed. That exit is
 * the upstream verdict on finished cases, already recorded verbatim, not an
 * abnormal end: an attempt is a normal completion when it exits 0, or exits 1
 * with its session closed (`#endSession`), every case accounted by a complete
 * record and at least one of them a status dEQP counts as failed.
 */

export const STATUS_ORDER = ["Pass", "Fail", "NotSupported", "QualityWarning", "CompatibilityWarning",
  "Crash", "Timeout", "Missing"];

/** Statuses that do not fail strict mode. Every other status, including
 * upstream ResourceError/InternalError and unknown codes, fails it. */
export const STRICT_ACCEPTED = new Set(["Pass", "NotSupported", "QualityWarning", "CompatibilityWarning",
  "CapabilityWarning"]);

/** Results dEQP does not count in `numFailed`
 * (framework/common/tcuTestSessionExecutor.cpp); any other status is failed. */
const DEQP_NOT_FAILED = new Set(["Pass", "NotSupported", "QualityWarning", "CompatibilityWarning",
  "CapabilityWarning", "Waiver"]);

const oneLine = text => String(text ?? "").replace(/[\t\r\n]+/g, " ").trim().slice(0, 400);

/** Parse a possibly partial QPA log into ordered case records. */
export function parseQpaRecords(text) {
  const records = [];
  for (const chunk of String(text ?? "").split("#beginTestCaseResult ").slice(1)) {
    const path = chunk.split(/\r?\n/, 1)[0].trim();
    const end = chunk.indexOf("#endTestCaseResult");
    const terminate = /#terminateTestCaseResult\s+(\S+)/.exec(chunk);
    if (end >= 0) {
      const xml = chunk.slice(0, end);
      const results = [...xml.matchAll(/<Result\s+StatusCode="([^"]+)"[^>]*>([\s\S]*?)<\/Result>/g)];
      const xmlPath = /<TestCaseResult\s[^>]*\bCasePath="([^"]+)"/.exec(xml)?.[1];
      if (results.length === 1 && xmlPath === path && xml.includes("</TestCaseResult>")) {
        records.push({ path, status: results[0][1], detail: oneLine(results[0][2]), state: "complete" });
      } else records.push({ path, state: "malformed" });
    } else if (terminate) {
      records.push({ path, status: terminate[1], detail: "terminated by dEQP", state: "complete" });
    } else records.push({ path, state: "open" });
  }
  return records;
}

/**
 * Account one guest attempt over `remaining` (ordered as dEQP runs them).
 * `outcome` is { kind: "exit", code } | { kind: "timeout" } | { kind: "error", message }.
 * Returns rows for accounted cases, the cases still unaccounted, and
 * whether a resume after an attributed case is meaningful.
 */
export function accountAttempt(remaining, qpa, outcome, attempt = 1) {
  const planned = new Set(remaining), seen = new Set();
  const rows = [], unexpected = [], duplicates = [], malformed = [];
  let open = null;
  for (const record of parseQpaRecords(qpa)) {
    if (!planned.has(record.path)) { unexpected.push(record.path); continue; }
    if (seen.has(record.path)) { duplicates.push(record.path); continue; }
    seen.add(record.path);
    if (record.state === "complete") rows.push({ path: record.path, status: record.status, detail: record.detail, attempt });
    else if (record.state === "open") open = record.path;
    else malformed.push(record.path);
  }
  const complete = !open && malformed.length === 0 && rows.length === remaining.length;
  const failedSession = outcome.kind === "exit" && outcome.code === 1 && complete
    && /\n#endSession\s*$/.test(String(qpa ?? "")) && rows.some(row => !DEQP_NOT_FAILED.has(row.status));
  const abnormal = !(outcome.kind === "exit" && outcome.code === 0) && !failedSession;
  let attributed = null;
  if (open && abnormal) {
    const status = outcome.kind === "timeout" ? "Timeout" : "Crash";
    const detail = outcome.kind === "timeout" ? "chunk deadline expired during this case"
      : outcome.kind === "error" ? `guest error: ${oneLine(outcome.message)}` : `guest exit ${outcome.code}`;
    rows.push({ path: open, status, detail, attempt });
    attributed = open;
  } else if (open) {
    rows.push({ path: open, status: "Missing", detail: "result record left open at exit 0", attempt });
  }
  for (const path of malformed) rows.push({ path, status: "Missing", detail: "malformed result record", attempt });
  const accounted = new Set(rows.map(row => row.path));
  const left = remaining.filter(path => !accounted.has(path));
  // Resume only past an attributed case: other cases were never begun, so a
  // retry without progress would only repeat the same failure.
  const resume = attributed !== null ? left.filter(path => remaining.indexOf(path) > remaining.indexOf(attributed)) : [];
  return { rows, left, resume, unexpected, duplicates, abnormal, attributed };
}

/**
 * Run one chunk through `runAttempt(cases) -> { qpa, outcome, ... }`,
 * resuming after each attributed Crash/Timeout, at most `maxAttempts` times.
 * A thrown runAttempt (page or host lost) ends the chunk. Every case not
 * accounted for is Missing.
 */
export async function runChunk(chunk, runAttempt, { maxAttempts = 8 } = {}) {
  const rows = [], attempts = [], unexpected = [], duplicates = [];
  let remaining = chunk.cases.slice(), crashed = null;
  for (let attempt = 1; remaining.length && attempt <= maxAttempts; attempt++) {
    let result;
    try { result = await runAttempt(remaining, attempt); }
    catch (error) {
      attempts.push({ attempt, cases: remaining.length, outcome: { kind: "error", message: oneLine(error?.message ?? error) }, runnerLost: true });
      crashed ??= { attempt, case: null, reason: `runner lost: ${oneLine(error?.message ?? error)}` };
      break;
    }
    const accounted = accountAttempt(remaining, result.qpa, result.outcome, attempt);
    rows.push(...accounted.rows);
    unexpected.push(...accounted.unexpected);
    duplicates.push(...accounted.duplicates);
    attempts.push({ attempt, cases: remaining.length, outcome: result.outcome, accounted: accounted.rows.length,
      attributed: accounted.attributed, diagnostics: result.diagnostics ?? [] });
    if (accounted.abnormal) crashed ??= { attempt, case: accounted.attributed,
      reason: result.outcome.kind === "exit" ? `exit ${result.outcome.code}` : result.outcome.kind };
    const missing = accounted.left.filter(path => !accounted.resume.includes(path));
    for (const path of missing) rows.push({ path, status: "Missing", detail: accounted.abnormal
      ? "not run: guest ended before this case" : "not run: no result record", attempt });
    remaining = accounted.resume;
  }
  const lost = attempts.at(-1)?.runnerLost;
  for (const path of remaining) rows.push({ path, status: "Missing",
    detail: lost ? "not run: runner lost" : "not run: resume limit reached", attempt: attempts.length });
  const order = new Map(chunk.cases.map((path, index) => [path, index]));
  rows.sort((a, b) => order.get(a.path) - order.get(b.path));
  return { id: chunk.id, family: chunk.family, rows, attempts, unexpected, duplicates, crashed };
}

const emptyCounts = () => Object.fromEntries(STATUS_ORDER.map(status => [status, 0]));
const add = (counts, status) => { counts[status] = (counts[status] ?? 0) + 1; };

/**
 * Combine chunk results (by engine) with the plan. A chunk without a result
 * file contributes Missing for every case; a result that does not cover its
 * planned cases exactly is an accounting error.
 */
export function summarize(plan, resultsByEngine) {
  const engines = {}, tsv = [["engine", "chunk", "family", "case", "status", "attempt", "detail"].join("\t")];
  const errors = [];
  for (const [engine, results] of Object.entries(resultsByEngine)) {
    const byId = new Map(results.map(result => [result.id, result]));
    const totals = emptyCounts(), familyCounts = {}, crashedChunks = [];
    for (const chunk of plan.chunks) {
      let result = byId.get(chunk.id);
      if (!result) {
        result = { id: chunk.id, family: chunk.family, crashed: { attempt: 0, case: null, reason: "chunk result absent" },
          rows: chunk.cases.map(path => ({ path, status: "Missing", detail: "chunk result absent", attempt: 0 })) };
      }
      const paths = result.rows.map(row => row.path);
      if (paths.length !== chunk.cases.length || paths.some((path, i) => path !== chunk.cases[i])) {
        errors.push(`${engine} ${chunk.id}: result rows do not match the planned cases`);
      }
      if (result.crashed) crashedChunks.push({ chunk: chunk.id, ...result.crashed });
      if (result.unexpected?.length) errors.push(`${engine} ${chunk.id}: unexpected cases ${result.unexpected.join(" ")}`);
      if (result.duplicates?.length) errors.push(`${engine} ${chunk.id}: duplicate cases ${result.duplicates.join(" ")}`);
      const family = (familyCounts[chunk.family] ??= emptyCounts());
      for (const row of result.rows) {
        add(totals, row.status); add(family, row.status);
        tsv.push([engine, chunk.id, chunk.family, row.path, row.status, row.attempt, oneLine(row.detail)].join("\t"));
      }
    }
    const strictFailures = Object.entries(totals).filter(([status]) => !STRICT_ACCEPTED.has(status))
      .reduce((sum, [, count]) => sum + count, 0);
    engines[engine] = { totals, families: familyCounts, crashedChunks, strictFailures };
  }
  return { summary: { version: 1, suite: plan.suite, selector: plan.selector, chunkSize: plan.chunkSize,
    inventorySha256: plan.inventorySha256, caseCount: plan.caseCount, chunkCount: plan.chunks.length,
    engines, accountingErrors: errors }, tsv: tsv.join("\n") + "\n" };
}

/** Strict mode: any non-accepted status or accounting error fails. */
export function strictVerdict(summary) {
  const reasons = [];
  for (const [engine, data] of Object.entries(summary.engines)) {
    if (data.strictFailures) reasons.push(`${engine}: ${data.strictFailures} case(s) Fail/Crash/Timeout/Missing or other non-passing status`);
  }
  for (const error of summary.accountingErrors) reasons.push(error);
  if (Object.keys(summary.engines).length === 0) reasons.push("no engine results");
  return { ok: reasons.length === 0, reasons };
}
