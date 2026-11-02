/**
 * Pin, check and record which code path the Node kernel worker runs during a
 * benchmark.
 *
 * WHY: in a source checkout the Node host runs the compiled kernel worker
 * bundle (`host/dist/node-kernel-worker-entry.js`) only while the bundle's
 * embedded build-input fingerprint matches the current host sources.
 * Otherwise it falls back to compiling the TypeScript entry with tsx. That
 * fallback is right for development (an edit takes effect without a
 * rebuild), but it is measurably slower: syscall_latency went from about
 * 28 to 36 µs and pipe throughput dropped about 20% in one measurement. A
 * benchmark that silently takes it, or a before/after pair where only one
 * side takes it, measures the build state rather than the change.
 *
 * Benchmarks therefore set the host's `KANDELO_NODE_KERNEL_WORKER_PATH`
 * policy, so the decision is enforced where the host makes it (every kernel
 * worker launch), not predicted once by a second copy of the rule. The
 * default is `bundled`: a stale or missing bundle refuses to run and names
 * the rebuild command. `--kernel-worker=tsx` measures the tsx path on
 * purpose. Either way the result records the path and fingerprint, and the
 * launches the host actually made.
 *
 * Rebuilding automatically was rejected: the host build is a tsup run over a
 * tree a benchmark should observe, not mutate, and an automatic rebuild
 * would hide which sources the bundle came from (for example uncommitted
 * edits in a shared worktree). Refusing keeps the operator in charge of what
 * gets measured.
 */
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectCompiledWorkerEntry } from "../host/src/compiled-worker-entry.js";
import {
  HOST_BUNDLE_BUILD_COMMAND,
  NODE_KERNEL_WORKER_PATH_ENV,
  nodeKernelWorkerLaunches,
  selectNodeKernelWorkerEntry,
  type NodeKernelWorkerPath,
} from "../host/src/node-kernel-host.js";
import type { BenchmarkHostWorkerEvidence } from "./types.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Flag a benchmark entry point accepts to choose the kernel worker path. */
export const KERNEL_WORKER_FLAG = "--kernel-worker";

export const KERNEL_WORKER_FLAG_HELP =
  `  ${KERNEL_WORKER_FLAG}=bundled|tsx  Kernel worker path to measure ` +
  `(default: bundled; a stale host bundle refuses to run)`;

/** Read `--kernel-worker=<path>` (or `--kernel-worker <path>`); default bundled. */
export function benchmarkKernelWorkerPolicy(argv: string[]): NodeKernelWorkerPath {
  let value: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith(`${KERNEL_WORKER_FLAG}=`)) {
      value = arg.slice(KERNEL_WORKER_FLAG.length + 1);
    } else if (arg === KERNEL_WORKER_FLAG) {
      value = argv[++i];
    }
  }
  if (value === undefined) return "bundled";
  if (value === "bundled" || value === "tsx") return value;
  throw new Error(`${KERNEL_WORKER_FLAG} must be bundled or tsx, got ${value}`);
}

function displayPath(path: string, root: string): string {
  const rel = relative(root, path);
  if (rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`)) {
    return rel.split(sep).join("/");
  }
  return path;
}

export interface PrepareOptions {
  /** Process environment the host reads; mutated to carry the policy. */
  env?: NodeJS.ProcessEnv;
  /** Directory holding the host's `node-kernel-host` module (tests). */
  hostModuleDir?: string;
  /** Root used to print repository-relative paths. */
  repoRoot?: string;
}

/**
 * Pin the host's kernel worker policy for this process and check it can be
 * honored before any workload runs.
 *
 * Under `bundled` this also requires the process worker bundle
 * (`dist/worker-entry.js`) to be current: guest processes run in it, and
 * without it the host falls back to an esbuild or tsx build of the source.
 */
export function prepareBenchmarkKernelWorker(
  policy: NodeKernelWorkerPath,
  options: PrepareOptions = {},
): BenchmarkHostWorkerEvidence {
  const env = options.env ?? process.env;
  const root = options.repoRoot ?? repoRoot;
  const hostModuleDir = options.hostModuleDir ?? resolve(root, "host/src");
  env[NODE_KERNEL_WORKER_PATH_ENV] = policy;

  // Throws, naming the rebuild command, when `bundled` cannot be honored.
  const selection = selectNodeKernelWorkerEntry({
    env,
    moduleDir: hostModuleDir,
  });

  const evidence: BenchmarkHostWorkerEvidence = {
    policy,
    path: selection.path,
    entry: displayPath(selection.entry, root),
    bundleFingerprint: selection.bundleFingerprint,
    sourceFingerprint: selection.sourceFingerprint,
    fallbackReason: selection.fallbackReason,
  };

  if (selection.path === "bundled") {
    const processSource = resolve(hostModuleDir, "worker-entry.ts");
    const processBundle = resolve(dirname(hostModuleDir), "dist/worker-entry.js");
    const inspection = inspectCompiledWorkerEntry(processSource, processBundle);
    if (!inspection.current) {
      throw new Error(
        `The host process-worker bundle is stale or missing: ` +
          `${inspection.reason}. Rebuild it with: ${HOST_BUNDLE_BUILD_COMMAND}`,
      );
    }
    evidence.processWorkerEntry = displayPath(processBundle, root);
    evidence.processWorkerBundleFingerprint = inspection.bundleFingerprint;
  }
  return evidence;
}

/**
 * After the workloads, record the kernel worker launches the host actually
 * made, and refuse the result if any of them disagreed with the preflight.
 * The host enforces the policy at each launch; this check turns that into
 * recorded evidence and also catches a bundle rebuilt from different
 * sources mid-run (a second bundled fingerprint).
 */
export function finishBenchmarkKernelWorker(
  evidence: BenchmarkHostWorkerEvidence,
  launches: ReturnType<typeof nodeKernelWorkerLaunches> = nodeKernelWorkerLaunches(),
): BenchmarkHostWorkerEvidence {
  const recorded: BenchmarkHostWorkerEvidence = {
    ...evidence,
    kernelWorkerLaunches: {
      bundled: launches.bundled,
      tsx: launches.tsx,
      bundleFingerprints: [...launches.bundleFingerprints],
    },
  };
  const other = evidence.path === "bundled" ? launches.tsx : launches.bundled;
  const foreignFingerprints = launches.bundleFingerprints.filter(
    (fingerprint) => fingerprint !== evidence.bundleFingerprint,
  );
  if (other > 0 || foreignFingerprints.length > 0) {
    throw new Error(
      `Benchmark kernel workers did not all run the ${evidence.path} path ` +
        `(bundled=${launches.bundled}, tsx=${launches.tsx}, bundle ` +
        `fingerprints=${launches.bundleFingerprints.join(",") || "none"}; ` +
        `expected ${evidence.bundleFingerprint ?? "none"}). ` +
        `The results mix host builds and are not recorded.`,
    );
  }
  return recorded;
}

/** One-line summary for the console report. */
export function describeBenchmarkKernelWorker(
  evidence: BenchmarkHostWorkerEvidence,
): string {
  const fingerprint = evidence.bundleFingerprint
    ? ` fingerprint=${evidence.bundleFingerprint}`
    : "";
  const launches = evidence.kernelWorkerLaunches
    ? ` launches: bundled=${evidence.kernelWorkerLaunches.bundled} ` +
      `tsx=${evidence.kernelWorkerLaunches.tsx}`
    : "";
  return `kernel worker: ${evidence.path} (${evidence.entry})${fingerprint}${launches}`;
}

/**
 * Check that two benchmark results measured the same kernel worker path.
 * Returns an error for a bundled-vs-tsx pair, warnings for results that
 * cannot show which path ran, and a note naming what each side ran.
 */
export function compareBenchmarkKernelWorkers(
  before: { host?: string; hostWorker?: BenchmarkHostWorkerEvidence },
  after: { host?: string; hostWorker?: BenchmarkHostWorkerEvidence },
): { error: string | null; warnings: string[]; notes: string[] } {
  const warnings: string[] = [];
  const notes: string[] = [];
  const sides = [["before", before], ["after", after]] as const;
  for (const [label, result] of sides) {
    if (result.host !== "node") continue;
    if (!result.hostWorker) {
      warnings.push(
        `${label} result does not record which kernel worker path ran ` +
          `(bundled or tsx); it may have measured the slower tsx fallback.`,
      );
    } else {
      notes.push(
        `${label} kernel worker: ${result.hostWorker.path}` +
          (result.hostWorker.bundleFingerprint
            ? ` (bundle ${result.hostWorker.bundleFingerprint})`
            : ""),
      );
    }
  }
  const beforePath = before.hostWorker?.path;
  const afterPath = after.hostWorker?.path;
  const error =
    beforePath !== undefined && afterPath !== undefined && beforePath !== afterPath
      ? `before ran the ${beforePath} kernel worker path and after ran ` +
        `${afterPath}; the difference would measure the host build, not the change.`
      : null;
  return { error, warnings, notes };
}
