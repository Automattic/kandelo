/**
 * Aggregate the per-run JSON written by `wait-ab-host-source.sh` (or by
 * `wait-ab-bisect.sh`, whose output has the same shape).
 *
 * WHY minima and p10 rather than medians: machine contention can only ADD
 * time to a syscall loop, never remove any, so the per-run distribution is
 * one-sided -- a floor at what the code actually costs, with a long upper
 * tail wherever something else on the machine ran. Observed directly, the
 * same build returns ~29 us run after run and then 300-400 us for a burst.
 *
 * A median over that mixture reports how much of the session was loaded
 * rather than what the code costs, and counterbalancing does not rescue it:
 * `A B B A` cancels a monotone drift, but a contention BURST lands on
 * whichever arms it overlaps. That is the failure that produced this
 * campaign's withdrawn +35% figure.
 *
 * The minimum tracks the least-contended observation. Its downward bias
 * grows with sample count, but both arms are compared at equal counts, so
 * the bias is common and cancels in the difference. p10 is printed beside
 * it because one minimum is one sample: WHEN dMin AND dP10 DISAGREE ABOUT
 * THE SIGN, THE DIFFERENCE IS NOT RESOLVED AND MUST NOT BE REPORTED.
 *
 * Medians are printed only so a session that was loaded throughout is
 * visible as medians far above the minima. They are not the figure to quote.
 *
 * Usage: node benchmarks/wait-ab-aggregate.mjs <dir-of-run-json>
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node benchmarks/wait-ab-aggregate.mjs <dir>");
  process.exit(1);
}

const samples = [];
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const arm = file.match(/-(A|B)\.json$/)?.[1];
  if (!arm) continue;
  for (const sample of JSON.parse(readFileSync(join(dir, file), "utf8")).samples) {
    samples.push({ arm, metrics: sample.metrics });
  }
}
if (samples.length === 0) {
  console.error(`no run-*-{A,B}.json found in ${dir}`);
  process.exit(1);
}

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.round((sorted.length - 1) * p);
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
};
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const armValues = (arm, name) =>
  samples.filter((s) => s.arm === arm).map((s) => s.metrics[name]).filter(Number.isFinite);

const names = [...new Set(samples.flatMap((s) => Object.keys(s.metrics)))].sort();
console.log(
  `# A n=${samples.filter((s) => s.arm === "A").length}`
  + `   B n=${samples.filter((s) => s.arm === "B").length}`,
);
console.log(
  "metric".padEnd(26) + "A_min".padStart(10) + "B_min".padStart(10) + "dMin".padStart(9)
  + "A_p10".padStart(10) + "B_p10".padStart(10) + "dP10".padStart(9)
  + "A_med".padStart(10) + "B_med".padStart(10) + "  sign",
);
for (const name of names) {
  const a = armValues("A", name);
  const b = armValues("B", name);
  if (a.length === 0 || b.length === 0) continue;
  const aMin = Math.min(...a), bMin = Math.min(...b);
  const aP10 = percentile(a, 0.10), bP10 = percentile(b, 0.10);
  const dMin = bMin - aMin, dP10 = bP10 - aP10;
  // A difference whose two statistics disagree in sign is unresolved at this
  // sample count. Say so in the table rather than leaving a reader to notice.
  const agree = (dMin < 0) === (dP10 < 0) ? "" : "  UNRESOLVED";
  console.log(
    name.replace("_us_per_op", "").padEnd(26)
    + aMin.toFixed(2).padStart(10) + bMin.toFixed(2).padStart(10) + dMin.toFixed(2).padStart(9)
    + aP10.toFixed(2).padStart(10) + bP10.toFixed(2).padStart(10) + dP10.toFixed(2).padStart(9)
    + median(a).toFixed(2).padStart(10) + median(b).toFixed(2).padStart(10) + agree,
  );
}
console.log("# dMin / dP10 are the comparison; negative means arm B is faster.");
console.log("# Medians are context for how loaded the session was, not the figure to quote.");
console.log("# Report the load average the round ran under: the per-run column is in the driver's output.");
