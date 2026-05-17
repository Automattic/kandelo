/**
 * Benchmark suite interface and output types.
 */

export interface BenchmarkSuite {
  name: string;
  run(): Promise<Record<string, number>>;
}

export interface BenchmarkArtifactFile {
  path: string;
  sizeBytes?: number;
  sha256?: string;
  missing?: boolean;
}

export interface ForkBenchSymbolReport {
  hasWpkForkSymbols: boolean;
  hasAsyncifySymbols: boolean;
  matchedSymbols: string[];
  expected: "asyncify" | "wpk_fork_without_asyncify" | "unknown";
  passed: boolean | null;
}

export interface BenchmarkArtifacts {
  gitHead: string;
  gitRef: string;
  files: Record<string, BenchmarkArtifactFile>;
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
