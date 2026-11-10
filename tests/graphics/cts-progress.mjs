/**
 * Progress-based attempt deadline for chunked upstream dEQP runs.
 *
 * A flat per-attempt budget (base + N x per-case) charges every case the
 * same time, so one legitimately slow case (a performance case issuing
 * hundreds of thousands of draw calls) exhausts the budget of a chunk that is
 * still making progress, and its record is reported as Timeout although
 * nothing hung. The deadline is instead tied to dEQP's own progress:
 * framework/common/tcuTestSessionExecutor.cpp prints `Test case '<path>'..`
 * on stdout as it enters each case. The guest gets `startupMs` to reach its
 * first case and `caseMs` from each case line to the next case line (or to
 * exit). A case that runs longer than `caseMs`, or a guest that never reaches
 * a case, still expires: a real hang or deadlock fails loudly as Timeout of
 * the case that was open, never silently extended.
 */

/** One dEQP case-entry line. Only complete lines are matched. */
const CASE_LINE = /^Test case '([^'\r\n]+)'\.\.\r?$/;
/** A partial line longer than this cannot be a case line; drop its head. */
const MAX_PARTIAL_LINE = 4096;

/** Deadline parameters from the runner environment. */
export function ctsDeadlineConfig(env = process.env) {
  const startupMs = Number(env.KANDELO_CTS_ATTEMPT_BASE_MS ?? 60_000);
  const caseMs = Number(env.KANDELO_CTS_CASE_MS ?? 600_000);
  if (!(startupMs > 0) || !(caseMs > 0)) {
    throw new Error("KANDELO_CTS_ATTEMPT_BASE_MS and KANDELO_CTS_CASE_MS must be positive");
  }
  return { startupMs, caseMs };
}

/** Longest an attempt over `cases` cases can last before every case
 * individually used its ceiling: the outer bound for test-runner timeouts. */
export function ctsAttemptCeilingMs(cases, { startupMs, caseMs }) {
  return startupMs + caseMs * Math.max(1, cases);
}

/** Tracks dEQP case entries in a guest's stdout. `feed` takes decoded text
 * in arbitrary pieces; `deadline` is the time the attempt expires unless a
 * new case line arrives first. */
export class CaseProgress {
  constructor({ startupMs, caseMs }, now = Date.now()) {
    this.startupMs = startupMs;
    this.caseMs = caseMs;
    this.startedAt = now;
    this.lastAt = now;
    this.cases = 0;
    this.current = null;
    this.partial = "";
  }

  feed(text, now = Date.now()) {
    const lines = (this.partial + text).split("\n");
    this.partial = lines.pop() ?? "";
    if (this.partial.length > MAX_PARTIAL_LINE) this.partial = this.partial.slice(-MAX_PARTIAL_LINE);
    for (const line of lines) {
      const match = CASE_LINE.exec(line);
      if (!match) continue;
      this.cases++;
      this.current = match[1];
      this.lastAt = now;
    }
  }

  deadline() {
    return this.lastAt + (this.cases ? this.caseMs : this.startupMs);
  }

  expired(now = Date.now()) {
    return now >= this.deadline();
  }

  /** Evidence recorded with a timed-out attempt. */
  snapshot(now = Date.now()) {
    return { casesEntered: this.cases, lastCase: this.current, sinceLastCaseMs: now - this.lastAt,
      limitMs: this.cases ? this.caseMs : this.startupMs, elapsedMs: now - this.startedAt };
  }
}

/** Resolve `{ kind: "exit", code }` when `exit` settles with a code,
 * `{ kind: "error", message }` when it rejects, or `{ kind: "timeout" }`
 * once `progress` expires. Checks every `pollMs`. */
export function waitForExitOrStall(exit, progress, { pollMs = 250, now = () => Date.now() } = {}) {
  return new Promise(resolve => {
    let timer, settled = false;
    const finish = outcome => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    exit.then(code => finish({ kind: "exit", code }), error => finish({ kind: "error", message: String(error) }));
    const check = () => {
      if (settled) return;
      if (progress.expired(now())) finish({ kind: "timeout" });
      else timer = setTimeout(check, Math.max(1, Math.min(pollMs, progress.deadline() - now())));
    };
    check();
  });
}

/** A runner/transport failure, not evidence that a guest case timed out. */
export class CtsHostDeadlineError extends Error {
  constructor(phase, timeoutMs, cause) {
    super(`CTS page did not respond during ${phase} within ${timeoutMs} ms`, { cause });
    this.name = "CtsHostDeadlineError";
    this.phase = phase;
  }
}

/** The timer lives in the runner: a wedged page cannot suspend this limit. */
export async function withCtsHostDeadline(operation, timeoutMs, phase) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new CtsHostDeadlineError(phase, timeoutMs)), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

/** Keep the page's responsiveness separate from the guest's case deadline.
 * Legitimate long chunks retain their progress-based budget. Only one probe
 * can be outstanding, and stopping removes the scheduling owner. */
export function watchCtsPageLiveness(probe, { timeoutMs = 30_000, intervalMs = 1000 } = {}) {
  let stopped = false, pending = false, rejectFailure;
  const failure = new Promise((_, reject) => { rejectFailure = reject; });
  const check = () => {
    if (stopped || pending) return;
    pending = true;
    withCtsHostDeadline(Promise.resolve().then(probe), timeoutMs, "liveness probe").then(
      () => { pending = false; },
      error => {
        pending = false;
        if (!stopped) rejectFailure(error instanceof CtsHostDeadlineError ? error
          : new CtsHostDeadlineError("liveness probe", timeoutMs, error));
      },
    );
  };
  const timer = setInterval(check, intervalMs);
  check();
  return { failure, stop() { stopped = true; clearInterval(timer); } };
}
