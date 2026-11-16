/**
 * Expected results of `examples/psync_semantics_test.c`, shared by the Node
 * test (host/test/psync-semantics.test.ts) and the Chromium spec
 * (apps/browser-demos/test/psync-semantics.spec.ts).
 *
 * Each case checks one POSIX requirement for process-shared synchronization.
 * The table records what Kandelo does today, so the suite stays green while
 * known gaps remain visible: a case expected to diverge must still diverge,
 * and the change that fixes it must flip its entry here. The plan for each
 * gap is docs/plans/2026-11-15-process-shared-synchronization-design.md; the
 * user-facing status is docs/posix-status.md.
 */

export type PsyncExpectation =
  /** The case must report PASS. */
  | { status: "passes" }
  /** The case must report DIVERGE, until `fixedBy` lands. */
  | { status: "diverges"; fixedBy: string }
  /**
   * The case may report either. Used where today's divergence depends on
   * timing: two processes racing on unsynchronized copies of a shared page.
   * Becomes "passes" once `fixedBy` lands.
   */
  | { status: "unstable"; fixedBy: string };

const NEW_PSYNC_SEMAPHORES =
  "kernel semaphores through kandelo.psync.v1 (design phase 3)";
const NEW_PSYNC_PTHREAD =
  "kernel pthread objects through kandelo.psync.v1 (design phase 4); ABI-56 programs need a rebuild";
const LEGACY_REQUESTS = "POSIX semantics for legacy requests 400-414 (design phase 1)";

export const PSYNC_SEMANTICS_EXPECTATIONS: Record<string, PsyncExpectation> = {
  "sem-pshared-wakeup": { status: "diverges", fixedBy: NEW_PSYNC_SEMAPHORES },
  "sem-open-wakeup": { status: "diverges", fixedBy: NEW_PSYNC_SEMAPHORES },
  "sem-binary-one-holder": { status: "unstable", fixedBy: NEW_PSYNC_SEMAPHORES },
  "sem-lock-counter": { status: "unstable", fixedBy: NEW_PSYNC_SEMAPHORES },
  "mutex-thread-exclusion": { status: "diverges", fixedBy: LEGACY_REQUESTS },
  "mutex-errorcheck-foreign-unlock": { status: "diverges", fixedBy: LEGACY_REQUESTS },
  "mutex-owner-exit-stalled": { status: "diverges", fixedBy: LEGACY_REQUESTS },
  "robust-mutex-owner-exit": { status: "diverges", fixedBy: NEW_PSYNC_PTHREAD },
  "mutex-timedlock-deadline": { status: "diverges", fixedBy: NEW_PSYNC_PTHREAD },
  "mutex-handoff": { status: "passes" },
  "mutex-lock-signal-no-eintr": { status: "diverges", fixedBy: LEGACY_REQUESTS },
  "mutex-lock-counter": { status: "passes" },
  "cond-wait-wakeup": { status: "passes" },
  "cond-wait-signal-resumes": { status: "diverges", fixedBy: LEGACY_REQUESTS },
  "cond-timedwait-wakeup": { status: "diverges", fixedBy: NEW_PSYNC_PTHREAD },
  "cond-two-thread-broadcast": { status: "diverges", fixedBy: LEGACY_REQUESTS },
  "rwlock-wakeup": { status: "diverges", fixedBy: NEW_PSYNC_PTHREAD },
  "barrier-two-processes": { status: "passes" },
  "barrier-two-threads": { status: "diverges", fixedBy: LEGACY_REQUESTS },
};

/**
 * Compare the program's output with the table. Returns one message per
 * mismatch; an empty list means the output matches.
 */
export function checkPsyncSemantics(stdout: string): string[] {
  const reports = new Map<string, string[]>();
  for (const match of stdout.matchAll(/^case ([a-z0-9-]+): (PASS|DIVERGE) ?(.*)$/gm)) {
    const [, name, verdict, detail] = match;
    const list = reports.get(name) ?? [];
    list.push(`${verdict} ${detail}`);
    reports.set(name, list);
  }
  const problems: string[] = [];
  if (!/^PSYNC_SEMANTICS_DONE$/m.test(stdout)) {
    problems.push("the program did not finish (no PSYNC_SEMANTICS_DONE)");
  }
  for (const name of reports.keys()) {
    if (!(name in PSYNC_SEMANTICS_EXPECTATIONS)) {
      problems.push(`case ${name} has no expectation`);
    }
  }
  for (const [name, expected] of Object.entries(PSYNC_SEMANTICS_EXPECTATIONS)) {
    const got = reports.get(name);
    if (!got) {
      problems.push(`case ${name} did not report`);
      continue;
    }
    // A case that reported PASS and then crashed reports twice; any
    // DIVERGE counts.
    const diverged = got.some((line) => line.startsWith("DIVERGE"));
    if (expected.status === "passes" && diverged) {
      problems.push(`case ${name} must pass: ${got.join(" / ")}`);
    } else if (expected.status === "diverges" && !diverged) {
      problems.push(
        `case ${name} now passes (${got.join(" / ")}); flip its expectation ` +
          `to "passes" in host/test/fixtures/psync-semantics.ts and update ` +
          `docs/posix-status.md (expected fix: ${expected.fixedBy})`,
      );
    }
  }
  return problems;
}
