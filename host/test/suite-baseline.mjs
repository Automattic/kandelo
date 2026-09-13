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
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dirname;
const baseline = JSON.parse(
  readFileSync(join(here, "expected-failures.json"), "utf8"),
);
const expected = new Set(baseline.expectedFailures);

let output = "";
try {
  output = execFileSync(join(here, "..", "node_modules", ".bin", "vitest"), ["run"], {
    cwd: join(here, ".."),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (error) {
  // A non-zero exit is the normal case while the baseline is non-empty.
  output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
}

const failing = new Set(
  [...output.matchAll(/^ FAIL {2}(\S+)/gm)].map((m) => m[1]),
);

const regressions = [...failing].filter((f) => !expected.has(f)).sort();
const fixed = [...expected].filter((f) => !failing.has(f)).sort();

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
if (regressions.length === 0 && fixed.length === 0) {
  console.log(
    `host suite matches its baseline: ${failing.size} expected failures, nothing new, nothing unbanked.`,
  );
  process.exit(0);
}
process.exit(1);
