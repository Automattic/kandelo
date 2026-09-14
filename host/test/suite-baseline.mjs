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
const output = await new Promise((resolve) => {
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
});

const failing = new Set(
  [...output.matchAll(/^ FAIL {2}(\S+)/gm)].map((m) => m[1]),
);

const regressions = [...failing].filter((f) => !expected.has(f)).sort();
const fixed = [...expected].filter((f) => !failing.has(f)).sort();

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
