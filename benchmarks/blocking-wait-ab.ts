/**
 * Counterbalanced A/B harness for the blocking-wait metrics.
 *
 * WHY this exists as its own entry point rather than `run.ts --rounds`:
 * the measurement it serves compares two *builds* of the runtime on a
 * machine that other work is also using, and the last attempt at that
 * comparison was wrong for a harness reason rather than a platform one.
 * That harness alternated `eager -> lazy` in both of its rounds, so any
 * trend over wall-clock time — a background build ramping up, thermal
 * drift — landed on one arm systematically and was read as a difference
 * between the arms.
 *
 * Two properties fix that, and this file exists to make them the default:
 *
 *   Counterbalancing. Runs alternate `A B B A`, so a monotone trend over
 *   the session contributes equally to both arms instead of to one. A
 *   plain `A B A B` is not enough: it cancels a linear trend only if the
 *   spacing is exactly even, which it is not when each run's duration
 *   itself varies with load.
 *
 *   Paired metrics. Every run of the guest reports all of its metrics from
 *   one process, so metrics from the same run share that run's machine
 *   conditions. Reporting a metric normalised against a control metric
 *   from the *same run* therefore cancels most load noise, which the
 *   cross-run comparison of raw medians cannot do.
 *
 * It is also usable with both arms pointing at the *same* build, which is
 * how the noise floor is measured: whatever separation it reports then is
 * instrument, not signal, and no smaller difference between two real
 * builds can be believed.
 */
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { runCentralizedProgram } from "../host/test/centralized-test-helper.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Args {
  runs: number;
  kernelA?: string;
  kernelB?: string;
  label: string;
  program: string;
  json?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    runs: 8,
    label: "ab",
    program: resolve(__dirname, "wasm/blocking-wait.wasm"),
  };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key === "runs") args.runs = Number(value);
    else if (key === "kernel-a") args.kernelA = resolve(value);
    else if (key === "kernel-b") args.kernelB = resolve(value);
    else if (key === "label") args.label = value;
    else if (key === "program") args.program = resolve(value);
    else if (key === "json") args.json = resolve(value);
  }
  return args;
}

function parseMetrics(stdout: string): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const line of stdout.split("\n")) {
    const match = line.match(/^(\w+)=([\d.eE+-]+)$/);
    if (match) metrics[match[1]] = parseFloat(match[2]);
  }
  return metrics;
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The p-th percentile, and the minimum, are what this harness compares --
 * not the median.
 *
 * Machine contention can only ADD time to a syscall loop; it never removes
 * any. The per-run distribution is therefore one-sided: a floor at what the
 * code actually costs, with a long upper tail wherever something else on the
 * machine ran. Observed directly, the same build measured repeatedly returns
 * ~29 us run after run and then 300-400 us for a burst of runs, so the tail
 * is not a slight skew -- it is an order of magnitude.
 *
 * A median over such a mixture reports how much of the session was loaded
 * rather than what the code costs, and it is not rescued by counterbalancing:
 * `A B B A` cancels a monotone drift, but a contention *burst* lands on
 * whichever arms it overlaps, and the tail of the session is not balanced
 * across arms. That is the same failure that produced this campaign's
 * withdrawn +35% figure.
 *
 * The minimum tracks the least-contended observation, which is the best
 * available estimate of the true cost. Its downward bias grows with sample
 * count, but both arms are compared at equal counts, so the bias is common
 * and cancels in the difference. p10 is reported beside it because one
 * minimum is one sample: when min and p10 disagree about the sign of a
 * difference, that difference is not resolved and must not be reported.
 */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.round((sorted.length - 1) * p);
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

/**
 * Counterbalanced order: `A B B A` repeated, so the mean *position in the
 * session* of the two arms is equal and a monotone drift cannot favour one.
 */
function counterbalancedOrder(runs: number): ("A" | "B")[] {
  const pattern: ("A" | "B")[] = ["A", "B", "B", "A"];
  return Array.from({ length: runs }, (_, i) => pattern[i % 4]);
}

async function runOnce(
  program: string,
  kernelWasmPath: string | undefined,
): Promise<Record<string, number>> {
  const result = await runCentralizedProgram({
    programPath: program,
    argv: ["blocking-wait"],
    timeout: 120_000,
    // WHY no rootfs: the guest opens no file during any timed section — it
    // measures pipes and the three wait syscalls — so the canonical image
    // contributes nothing to what is being timed. Booting without it keeps
    // this harness off the package build path, whose cache root is shared
    // across worktrees and cannot be isolated from outside the dev shell.
    // Both arms boot identically, which is what the comparison requires.
    useDefaultRootfs: false,
    ...(kernelWasmPath ? { kernelWasmPath } : {}),
  });
  if (result.exitCode !== 0) {
    throw new Error(`blocking-wait exited ${result.exitCode}: ${result.stderr}`);
  }
  const metrics = parseMetrics(result.stdout);
  if (Object.keys(metrics).length === 0) {
    throw new Error(`blocking-wait produced no metrics: ${result.stdout}`);
  }
  return metrics;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const order = counterbalancedOrder(args.runs);
  const samples: { arm: "A" | "B"; index: number; metrics: Record<string, number> }[] = [];

  console.log(`# ${args.label}: ${args.runs} runs, order ${order.join("")}`);
  console.log(`#   A kernel: ${args.kernelA ?? "(resolver default)"}`);
  console.log(`#   B kernel: ${args.kernelB ?? "(resolver default)"}`);

  for (let i = 0; i < order.length; i++) {
    const arm = order[i];
    const kernel = arm === "A" ? args.kernelA : args.kernelB;
    const metrics = await runOnce(args.program, kernel);
    samples.push({ arm, index: i, metrics });
    const keys = Object.keys(metrics).filter((k) => k.includes("ready"));
    const summary = keys
      .map((k) => `${k.replace("_us_per_op", "")}=${metrics[k].toFixed(2)}`)
      .join(" ");
    console.log(`run ${String(i).padStart(2)} ${arm}  ${summary}`);
  }

  const metricNames = [...new Set(samples.flatMap((s) => Object.keys(s.metrics)))].sort();
  console.log("");
  console.log(
    "metric".padEnd(30)
    + "A_min".padStart(9) + "B_min".padStart(9) + "dMin".padStart(8)
    + "A_p10".padStart(9) + "B_p10".padStart(9) + "dP10".padStart(8)
    + "A_med".padStart(9) + "B_med".padStart(9),
  );
  const table: Record<string, Record<string, number>> = {};
  for (const name of metricNames) {
    const a = samples.filter((s) => s.arm === "A").map((s) => s.metrics[name]).filter(Number.isFinite);
    const b = samples.filter((s) => s.arm === "B").map((s) => s.metrics[name]).filter(Number.isFinite);
    if (a.length === 0 || b.length === 0) continue;
    const aMin = Math.min(...a);
    const bMin = Math.min(...b);
    const aP10 = percentile(a, 0.10);
    const bP10 = percentile(b, 0.10);
    const aMed = median(a);
    const bMed = median(b);
    table[name] = {
      aMin, bMin, dMin: bMin - aMin,
      aP10, bP10, dP10: bP10 - aP10,
      aMed, bMed,
    };
    console.log(
      name.padEnd(30)
      + aMin.toFixed(2).padStart(9) + bMin.toFixed(2).padStart(9)
      + (bMin - aMin).toFixed(2).padStart(8)
      + aP10.toFixed(2).padStart(9) + bP10.toFixed(2).padStart(9)
      + (bP10 - aP10).toFixed(2).padStart(8)
      + aMed.toFixed(2).padStart(9) + bMed.toFixed(2).padStart(9),
    );
  }
  console.log("");
  console.log("# dMin and dP10 are the comparison. The medians are shown only");
  console.log("# so a session that was loaded throughout is visible as medians");
  console.log("# far above the minima; they are not the figure to quote.");

  if (args.json) {
    const { writeFileSync } = await import("fs");
    writeFileSync(args.json, JSON.stringify({ label: args.label, order, samples, table }, null, 2));
    console.log(`\n# wrote ${args.json}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
