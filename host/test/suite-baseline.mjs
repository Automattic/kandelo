#!/usr/bin/env node
/**
 * Run the host suite and compare its failing FILES against the recorded
 * baseline.
 *
 * Exists because a mostly-red suite is not a signal. Lane F had two regressions
 * in its own layer survive for hours inside 200-odd expected failures, because
 * the checks that ran were a hand-picked list rather than everything.
 *
 * Fails in BOTH directions, like docs/surface-budget.json:
 *   - a file failing that is not in the baseline is a regression;
 *   - a file in the baseline that now passes is an unbanked improvement, and
 *     leaving it listed would let the next regression hide behind it.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dirname;
const baseline = JSON.parse(
  readFileSync(join(here, "expected-failures.json"), "utf8"),
);
const expected = new Set(baseline.expectedFailures);

/**
 * Stream the suite's output instead of buffering it.
 *
 * This used `execFileSync`, which returns nothing until vitest exits. That was
 * tolerable while most of the suite failed instantly on a missing import and a
 * run took four minutes. It stopped being tolerable when the restored tests
 * started booting real kernels: a run now takes 15-20 minutes, and during one of
 * them a worker sat at 0% CPU for fourteen minutes with no way to tell which
 * FILE it was on, or whether it was hung or merely slow. Those two look
 * identical from outside, and only one of them is worth waiting for.
 *
 * Echoing each line as it arrives makes a stall attributable: the last `FAIL` or
 * test-file line printed is the one it is stuck on.
 */
/**
 * Strip SGR colour escapes before anything parses this output.
 *
 * Vitest colours its summary when it thinks a terminal is watching, and it
 * thought so here even through a pipe. A coloured summary line begins with an
 * escape sequence rather than whitespace, so the NO RUN guard's
 * `/^\s*Test Files/m` did not match it -- and the guard then declared a
 * COMPLETE 450-file run dead and skipped the comparison. A guard that cries
 * wolf on good runs is worse than no guard: the next real setup failure arrives
 * looking like the false one. Everything downstream -- the FAIL list, the skip
 * counts, the missing-module census -- reads the stripped text for the same
 * reason.
 */
const plain = (text) => text.replace(/\u001b\[[0-9;]*m/g, "");

const output = plain(await new Promise((resolve) => {
  const child = spawn(join(here, "..", "node_modules", ".bin", "vitest"), ["run"], {
    cwd: join(here, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let seen = "";
  const absorb = (chunk) => {
    const text = chunk.toString();
    seen += text;
    process.stderr.write(text);
  };
  child.stdout.on("data", absorb);
  child.stderr.on("data", absorb);
  // A non-zero exit is the normal case while the baseline is non-empty, so the
  // exit CODE is not the signal here -- the parsed FAIL lines are.
  child.on("close", () => resolve(seen));
}));

/**
 * Refuse to compare a run that never started.
 *
 * The failure mode this exists for is the worst one this script can have. When
 * vitest dies in GLOBAL SETUP -- the program-package-index build, which fails
 * outright if the package registry changes underneath it, as it does when
 * anything else in the worktree is building -- no test file runs, so no file
 * emits a `FAIL` line, so EVERY baseline entry looks fixed. The run that
 * prompted this printed "UNBANKED: 195 baseline file(s) now pass" and told the
 * reader to delete them from `expected-failures.json`. Doing that would have
 * emptied the ratchet on the strength of a suite that executed nothing.
 *
 * Note what does NOT catch it. The skip counter above cannot: there were no
 * skips, because there were no tests. The exit code cannot: a non-zero exit is
 * this script's normal case. The existing "unresolved imports" census cannot: a
 * setup crash names no module. The only reliable witness is that vitest never
 * printed a `Test Files` summary line at all -- it gets that far even when
 * every file fails to load, and never when setup dies first.
 */
if (!/^\s*Test Files\s+/m.test(output)) {
  console.error(
    "NO RUN: vitest produced no `Test Files` summary, so no test file " +
      "executed -- almost always a global-setup failure (the program package " +
      "index build races anything else building in this worktree; its own " +
      "error says `retry`).\n" +
      "  The baseline comparison is MEANINGLESS for this run and has been " +
      "skipped. Every baseline entry would have looked fixed.\n" +
      "  Re-run it with nothing else building.",
  );
  process.exit(1);
}

const failing = new Set(
  [...output.matchAll(/^ FAIL {2}(\S+)/gm)].map((m) => m[1]),
);

const regressions = [...failing].filter((f) => !expected.has(f)).sort();
const fixed = [...expected].filter((f) => !failing.has(f)).sort();

/**
 * How many tests DECLINED TO RUN, which this ratchet otherwise reads as success.
 *
 * It tracks failing FILES, so a file whose tests all skip looks exactly like one
 * that passes: neither emits a `FAIL` line. That is not a hypothetical. Three
 * dlopen fork e2e files left the expected-failure list when a restored module
 * let them LOAD, and were reported as the env stride's first real coverage --
 * while every test in them skipped on a missing `local-binaries/kernel.wasm`.
 * Eighteen tests, none of which ran, recorded as a win.
 *
 * A skip is usually an artifact gate, which is provisioning rather than a
 * boundary, so this number going UP is a reason to build something rather than
 * to celebrate.
 */
const skipped = /^\s*Tests\s+.*?(\d+) skipped/m.exec(output)?.[1];
const skippedFiles = /^\s*Test Files\s+.*?(\d+) skipped/m.exec(output)?.[1];

/**
 * Why the baseline is the size it is, grouped by cause.
 *
 * A count alone is not a diagnosis, and this one hid a big fact for a long
 * time: 116 of the 202 expected failures are ONE missing module that a shared
 * test helper imports, so most of the suite never runs at all. Every commit
 * that said "baseline green at 202 expected failures" was true and implied far
 * more coverage than existed -- including a claim of "no regression" about
 * paths whose tests cannot even load.
 *
 * Printing the dominant causes makes the number answerable. A single cause
 * covering a large share of the baseline is a lead, not a background condition.
 */
const MISSING_MODULE = /Cannot find module '([^']+)'/g;
const causes = new Map();
for (const [, specifier] of output.matchAll(MISSING_MODULE)) {
  causes.set(specifier, (causes.get(specifier) ?? 0) + 1);
}
const ranked = [...causes].sort((a, b) => b[1] - a[1]).slice(0, 5);

if (regressions.length > 0) {
  console.error(
    `REGRESSION: ${regressions.length} test file(s) fail that the baseline does not list:`,
  );
  for (const f of regressions) console.error(`  ${f}`);
}
if (fixed.length > 0) {
  console.error(
    `UNBANKED: ${fixed.length} baseline file(s) now pass. Remove them from ` +
      `host/test/expected-failures.json in the same commit that fixed them:`,
  );
  for (const f of fixed) console.error(`  ${f}`);
}
if (skipped !== undefined && Number(skipped) > 0) {
  console.log(
    `${skipped} test(s) across ${skippedFiles ?? "?"} file(s) SKIPPED. A skipped ` +
      `file emits no FAIL line, so this ratchet cannot tell it from a passing ` +
      `one -- check what gates them before reading any file as restored.`,
  );
}
if (ranked.length > 0) {
  console.log("what the failures are made of (unresolved imports, top causes):");
  for (const [specifier, count] of ranked) {
    console.log(`  ${String(count).padStart(4)}  ${specifier}`);
  }
  console.log(
    "  A cause covering much of the baseline means most of the suite is not " +
      "running. Read a green verdict below accordingly.",
  );
}
if (regressions.length === 0 && fixed.length === 0) {
  console.log(
    `host suite matches its baseline: ${failing.size} expected failures, nothing new, nothing unbanked.`,
  );
  process.exit(0);
}
process.exit(1);
