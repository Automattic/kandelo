/**
 * Benchmark suite interface and output types.
 */

export interface BenchmarkSuite {
  name: string;
  run(): Promise<Record<string, number>>;
}

export interface BenchmarkArtifactFile {
  /** Stable logical name for the input. */
  path: string;
  /** Exact filesystem path selected for this run, when one was found. */
  selectedPath?: string;
  /** Binary-resolver request used to locate the input. */
  resolverRequest?: string;
  /** Exact path returned by the binary resolver before any browser copy. */
  resolverSelectedPath?: string;
  sizeBytes?: number;
  sha256?: string;
  missing?: boolean;
  required?: boolean;
  used?: boolean;
  error?: string;
}

export interface BenchmarkArtifactDirectory {
  /** Stable logical name for the input tree. */
  path: string;
  /** Exact filesystem path traversed for this run. */
  selectedPath?: string;
  fileCount?: number;
  sizeBytes?: number;
  sha256?: string;
  missing?: boolean;
  required?: boolean;
  used?: boolean;
  /** Runtime-owned paths intentionally omitted from the digest. */
  excludedPaths?: string[];
  error?: string;
}

export interface ForkBenchSymbolReport {
  hasWpkForkSymbols: boolean;
  hasLegacyForkSymbols: boolean;
  matchedSymbols: string[];
  expected: "wpk_fork_without_legacy" | "unknown";
  passed: boolean | null;
}

export interface BenchmarkArtifacts {
  gitHead: string;
  gitRef: string;
  files: Record<string, BenchmarkArtifactFile>;
  directories?: Record<string, BenchmarkArtifactDirectory>;
  forkBench: ForkBenchSymbolReport;
}

/**
 * Which code path the Node kernel worker ran, and the evidence for it.
 * A tsx-path result is not comparable with a bundled-path result.
 */
export interface BenchmarkHostWorkerEvidence {
  /** Path the run was told to measure (`--kernel-worker`, default bundled). */
  policy: "bundled" | "tsx";
  /** Path the host selected for this run. */
  path: "bundled" | "tsx";
  /** Repository-relative file the kernel worker runs. */
  entry: string;
  /** Host build-input fingerprint embedded in the kernel worker bundle. */
  bundleFingerprint: string | null;
  /** Fingerprint of the checkout's host build inputs at preflight. */
  sourceFingerprint: string | null;
  /** Why the bundle was not used; null on the bundled path. */
  fallbackReason: string | null;
  /** Process (guest) worker bundle, checked on the bundled path. */
  processWorkerEntry?: string;
  processWorkerBundleFingerprint?: string | null;
  /** Kernel worker launches the host actually made during the run. */
  kernelWorkerLaunches?: {
    bundled: number;
    tsx: number;
    bundleFingerprints: string[];
  };
}

export interface BenchmarkOutput {
  timestamp: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  host: "node" | "browser";
  rounds: number;
  artifacts?: BenchmarkArtifacts;
  /**
   * Node: kernel worker path evidence. Browser: absent; the browser runner
   * serves host sources through the Vite dev server, which has no
   * bundled/fallback choice to make.
   */
  hostWorker?: BenchmarkHostWorkerEvidence;
  suites: Record<string, Record<string, number>>;
}
