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

export interface BenchmarkOutput {
  timestamp: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  host: "node" | "browser";
  rounds: number;
  artifacts?: BenchmarkArtifacts;
  suites: Record<string, Record<string, number>>;
}
