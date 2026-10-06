/**
 * Prints one `[suite-health]` summary at the end of every vitest run, and
 * warns when the run's exit status cannot be trusted to describe coverage.
 *
 * Why it exists: vitest's default output counts a test file that failed to
 * *load* (an unresolved import, a throw at module scope) the same as a file
 * whose tests failed, and it reports a run that executed nothing as a
 * success. Both read as green, or as "nothing new failed", while most of
 * the suite never ran. In one 2026-09 lane, 116 of 202 "expected" failing
 * files were a single missing module. Agents then either cite a pass that
 * tested nothing, which costs rework when it surfaces later, or read
 * hundreds of near-identical failure blocks to find that one cause. This
 * summary separates "did not run" from "ran and failed" and groups load
 * failures by what is missing, so one line replaces that reading.
 *
 * Judged by evals/build-waiting/README.md (tool 4): kept only if at least
 * 80% of its warnings turn out to be real.
 */
import type { Reporter, SerializedError, TestModule, TestRunEndReason } from "vitest/node";

// A load error "dominates" when it explains at least half of the failing
// files, and at least 3 of them. Below that, the per-cause list already says
// enough, and a headline warning would be noise.
const DOMINANT_SHARE = 0.5;
const DOMINANT_MIN_FILES = 3;
// The top causes are enough to act on. A long tail of causes means many
// unrelated breakages, and listing every one would bring back the wall of
// text this reporter exists to replace.
const MAX_CAUSES = 5;
// Files where every test skipped are named, but only a few: enough to notice
// an unexpected one without restating the whole skip list on every run.
const MAX_SKIPPED_FILES = 5;

/**
 * One line describing why a file failed to load, normalized so that files
 * sharing a root cause produce the same string. Without normalization, the
 * same missing module imported from 100 test files would read as 100
 * different errors, and the grouping would hide the very pattern it is for.
 */
function causeOf(error: SerializedError, root: string): string {
  const first = (error.message || error.name || "unknown error").split("\n")[0];
  return first
    .split(root)
    .join("")
    // Resolved ids and importer paths differ per file; what is missing does not.
    .replace(/\(resolved id: [^)]*\)/g, "")
    .replace(/ imported from \S+/g, "")
    .replace(/ in \/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export default class SuiteHealthReporter implements Reporter {
  private root = process.cwd();

  onInit(vitest: { config: { root: string } }): void {
    // Strip the repo root (one level above host/) from error text, because
    // absolute paths differ between worktrees and would split one cause in two.
    this.root = vitest.config.root.replace(/\/host\/?$/, "/");
  }

  onTestRunEnd(
    testModules: ReadonlyArray<TestModule>,
    unhandledErrors: ReadonlyArray<SerializedError>,
    reason: TestRunEndReason,
  ): void {
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    const loadFailures = new Map<string, string[]>();
    const wholeFileSkips: string[] = [];

    for (const module of testModules) {
      let moduleTests = 0;
      let moduleSkipped = 0;
      for (const test of module.children.allTests()) {
        moduleTests++;
        const state = test.result().state;
        if (state === "passed") passed++;
        else if (state === "failed") failed++;
        else if (state === "skipped") {
          skipped++;
          moduleSkipped++;
        }
      }
      const errors = module.errors();
      const ran = moduleTests - moduleSkipped;
      if (errors.length > 0 && ran === 0) {
        // A module-level error with no test executed means the file never
        // ran, which is a different fact from "its tests failed".
        const cause = causeOf(errors[0], this.root);
        const files = loadFailures.get(cause) ?? [];
        files.push(module.relativeModuleId);
        loadFailures.set(cause, files);
      } else if (moduleTests > 0 && moduleSkipped === moduleTests) {
        // A file where every test skipped is usually an availability guard
        // (skipIf on a missing artifact or browser). It reads as green, but
        // the contract it covers was not tested. In 2026-09, both Ruby
        // fork/vfork tests skipped this way under the source-only policy
        // while the suite stayed green for the very contract being migrated.
        wholeFileSkips.push(module.relativeModuleId);
      }
    }

    const loadFailed = [...loadFailures.values()].reduce((n, files) => n + files.length, 0);
    const lines: string[] = [];
    lines.push(
      `[suite-health] files ${testModules.length} (${loadFailed} did not load, ` +
        `${wholeFileSkips.length} fully skipped); tests ${passed + failed + skipped}: ` +
        `${passed} passed, ${failed} failed, ${skipped} skipped` +
        (unhandledErrors.length ? `; ${unhandledErrors.length} unhandled errors` : "") +
        `; run ${reason}`,
    );

    // An interrupted run legitimately stops early; any other run that
    // executed no test proves nothing, even though vitest may exit 0.
    if (reason !== "interrupted" && testModules.length > 0 && passed + failed === 0) {
      lines.push(
        `[suite-health] WARN zero tests ran: ${testModules.length} file(s) selected, none executed ` +
          `a test. This run proves nothing; check the file filter, skips, and load errors.`,
      );
    }
    if (loadFailed > 0) {
      const causes = [...loadFailures.entries()].sort((a, b) => b[1].length - a[1].length);
      const [topCause, topFiles] = causes[0];
      const failingFiles = loadFailed + testModules.filter((m) => !m.ok() && m.errors().length === 0).length;
      if (topFiles.length >= DOMINANT_MIN_FILES && topFiles.length / failingFiles >= DOMINANT_SHARE) {
        // Say "fix this first" outright: until it is fixed, every other
        // failure in the run describes a suite that mostly did not execute.
        lines.push(
          `[suite-health] WARN one load error covers ${topFiles.length} of ${failingFiles} failing files; ` +
            `those files did not run at all. Fix it before reading the other failures: ${topCause}`,
        );
      }
      lines.push(`[suite-health] WARN ${loadFailed} files failed to load (no test in them ran):`);
      for (const [cause, files] of causes.slice(0, MAX_CAUSES)) {
        lines.push(`[suite-health]   ${files.length}x ${cause}  (e.g. ${files[0]})`);
      }
      if (causes.length > MAX_CAUSES) {
        lines.push(`[suite-health]   ... ${causes.length - MAX_CAUSES} more causes`);
      }
    }
    if (wholeFileSkips.length > 0) {
      // Informational, not a warning: many full-file skips are expected on a
      // given host. Naming them lets an agent notice an unexpected one
      // before citing the run as coverage for it.
      const shown = wholeFileSkips.slice(0, MAX_SKIPPED_FILES).join(", ");
      const more = wholeFileSkips.length > MAX_SKIPPED_FILES ? `, +${wholeFileSkips.length - MAX_SKIPPED_FILES} more` : "";
      lines.push(`[suite-health] info: every test skipped in ${shown}${more}`);
    }
    // Write to process.stdout, not console: vitest intercepts `console`, so a
    // console.error diagnostic in this repo never reached the log (2026-09-20,
    // artifact-gate.ts). A diagnostic that never prints is worse than none.
    process.stdout.write(`\n${lines.join("\n")}\n`);
  }
}
