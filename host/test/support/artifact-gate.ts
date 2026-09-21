/**
 * Turn a silent skip into either an announcement or a failure.
 *
 * WHY: `describe.skipIf(!hasKernel)` is invisible in a passing run. The
 * real-`dlopen` end-to-end suites skip their entire behavioural half unless
 * `local-binaries/kernel.wasm` exists — which `./run.sh setup` does not create
 * — so a fresh worktree reports `3 passed | 3 skipped`, **exit 0**, beside a
 * hundred green unit tests. An agent asked to "run the dlopen suites" before
 * deleting 6,340 lines would have seen green and proven nothing.
 *
 * Two behaviours, because the two callers want different things:
 *
 * - **Default:** still skip, so a partially provisioned tree stays usable for
 *   unrelated work — but print a line naming the artifact and the command that
 *   builds it, so the skip is visible in the log rather than inferred from a
 *   test count. The line goes to `process.stderr` directly; see the comment at
 *   the write for why `console.error` silently did not work here.
 * - **`KANDELO_REQUIRE_E2E=1`:** the missing artifact is a failure. This is
 *   what a gate should set when a run's result is being used as evidence, and
 *   it is what makes "the suite passed" mean the suite ran.
 */
export interface RequiredArtifact {
  /** Human name, e.g. "local-binaries/kernel.wasm". */
  readonly what: string;
  /** True when the artifact is present. */
  readonly present: boolean;
  /** The command that produces it. */
  readonly build: string;
}

export function artifactGate(
  suite: string,
  artifacts: readonly RequiredArtifact[],
): { skip: boolean } {
  const missing = artifacts.filter((a) => !a.present);
  if (missing.length === 0) return { skip: false };

  const detail = missing
    .map((a) => `  - ${a.what}  (build with: ${a.build})`)
    .join("\n");

  if (process.env.KANDELO_REQUIRE_E2E === "1") {
    throw new Error(
      `${suite}: refusing to skip because KANDELO_REQUIRE_E2E=1 and these ` +
        `artifacts are missing:\n${detail}`,
    );
  }

  // `process.stderr.write`, NOT `console.error`, and this is load-bearing.
  //
  // This announcement was written with `console.error` and NEVER REACHED THE
  // OUTPUT, so from the day it was added until 2026-09-20 the default branch
  // did neither of the two things this helper's own doc comment promises: it
  // did not announce, and it did not fail. It skipped silently — the exact
  // defect it exists to close — while reading as though it had been fixed.
  //
  // Measured under `host/vitest.config.ts` with a throwaway probe file: a
  // module-scope `console.error` and an IN-TEST `console.error` both vanish,
  // while `process.stderr.write` survives from both positions. Vitest
  // intercepts the `console` object; writing the file descriptor goes around
  // it. Do not "tidy" this back into `console.error`, and do not assume a
  // diagnostic is visible because it was printed — in this suite, check.
  process.stderr.write(
    `\n[artifact-gate] ${suite} is SKIPPING its end-to-end cases — this run ` +
      `proves nothing about them.\n${detail}\n` +
      `[artifact-gate] Set KANDELO_REQUIRE_E2E=1 to make this a failure.\n`,
  );
  return { skip: true };
}
