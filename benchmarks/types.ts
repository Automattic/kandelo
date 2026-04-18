/**
 * Benchmark suite interface and output types.
 */

export interface BenchmarkSuite {
  name: string;
  run(): Promise<Record<string, number>>;
}

export interface BenchmarkOutput {
  timestamp: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  host: "node" | "browser";
  rounds: number;
  suites: Record<string, Record<string, number>>;
}
