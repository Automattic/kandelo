/**
 * Prints one `[suite-health]` summary at the end of every vitest run, and
 * warns when the run's exit status cannot be trusted to describe coverage.
 *
 * Why: vitest's default output counts a test file that failed to *load*
 * (an unresolved import, a throw at module scope) the same as a file whose
 * tests failed. In one 2026-09 lane, 116 of 202 "expected" failing files were
 * a single missing module, so most of the suite never ran while the run read
 * as "nothing new failed". A run that collects zero tests is the same shape:
 * it reports success over nothing. This reporter separates "did not run"
 * from "ran and failed", groups load failures by cause, and says so loudly
 * when one cause dominates.
 *
 * Output goes to process.stdout directly: vitest intercepts `console`, and a
 * diagnostic that never prints is worse than none.
 *
 * Judged by evals/build-waiting/README.md (tool 4): kept only if at least
 * 80% of its warnings turn out to be real.
 */
import type { Reporter, SerializedError, TestModule, TestRunEndReason } from "vitest/node";

const DOMINANT_SHARE = 0.5;
const DOMINANT_MIN_FILES = 3;
const MAX_CAUSES = 5;

function causeOf(error: SerializedError, root: string): string {
  const first = (error.message || error.name || "unknown error").split("\n")[0];
  return first
    .split(root)
    .join("")
    .replace(/\(resolved id: [^)]*\)/g, "")
    // Group by what is missing, not by which file imported it.
    .replace(/ imported from \S+/g, "")
    .replace(/ in \/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

export default class SuiteHealthReporter implements Reporter {
  private root = process.cwd();

  onInit(vitest: { config: { root: string } }): void {
    // Strip the repo root (one level above host/) so causes group across files.
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
        const cause = causeOf(errors[0], this.root);
        const files = loadFailures.get(cause) ?? [];
        files.push(module.relativeModuleId);
        loadFailures.set(cause, files);
      }
    }

    const loadFailed = [...loadFailures.values()].reduce((n, files) => n + files.length, 0);
    const lines: string[] = [];
    lines.push(
      `[suite-health] files ${testModules.length} (${loadFailed} did not load); ` +
        `tests ${passed + failed + skipped}: ` +
        `${passed} passed, ${failed} failed, ${skipped} skipped` +
        (unhandledErrors.length ? `; ${unhandledErrors.length} unhandled errors` : "") +
        `; run ${reason}`,
    );

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
    process.stdout.write(`\n${lines.join("\n")}\n`);
  }
}
