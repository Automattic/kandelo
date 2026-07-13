import {
  tryResolveBinary,
} from "../host/src/binary-resolver.js";
import {
  resolveRootfsArtifact,
  type ResolvedRootfsArtifact,
} from "../host/src/node-kernel-host.js";

export interface BenchmarkRuntimeArtifactSelection {
  logicalPath: string;
  selectedPath: string | null;
  resolverRequest?: string;
  resolverSelectedPath?: string | null;
  error?: string;
}

export interface BenchmarkRuntimeArtifactSelections {
  kernel: BenchmarkRuntimeArtifactSelection;
  rootfs?: BenchmarkRuntimeArtifactSelection;
}

export interface BenchmarkStaticArtifactSelection {
  path: string;
  suites: string[];
  hosts?: Array<"node" | "browser">;
}

export const BENCHMARK_STATIC_ARTIFACTS: BenchmarkStaticArtifactSelection[] = [
  {
    path: "benchmarks/wasm/pipe-throughput.wasm",
    suites: ["syscall-io"],
  },
  {
    path: "benchmarks/wasm/file-throughput.wasm",
    suites: ["syscall-io"],
  },
  {
    path: "benchmarks/wasm/syscall-latency.wasm",
    suites: ["syscall-io"],
  },
  {
    path: "benchmarks/wasm/hello.wasm",
    suites: ["process-lifecycle"],
  },
  {
    path: "benchmarks/wasm/fork-bench.wasm",
    suites: ["process-lifecycle"],
  },
  {
    path: "benchmarks/wasm/exec-bench.wasm",
    suites: ["process-lifecycle"],
    hosts: ["node"],
  },
  {
    path: "benchmarks/wasm/clone-bench.wasm",
    suites: ["process-lifecycle"],
  },
  {
    path: "benchmarks/wasm/spawn-bench.wasm",
    suites: ["process-lifecycle"],
  },
];

export const RUNNABLE_BENCHMARK_SUITES = [
  "syscall-io",
  "process-lifecycle",
  "wordpress",
  "mariadb-aria",
  "mariadb-aria-64",
  "mariadb-innodb",
  "mariadb-innodb-64",
];

type OptionalResolver = (request: string) => string | null;

export function benchmarkInputEvidenceFlags(options: {
  host: "node" | "browser";
  suiteFilter?: string;
  suites: string[];
  hosts?: ReadonlyArray<"node" | "browser">;
}): { required: boolean; used: boolean } {
  const hosts = options.hosts ?? ["node", "browser"];
  const used = hosts.includes(options.host) && (
    options.suiteFilter === undefined || options.suites.includes(options.suiteFilter)
  );
  return { required: used, used };
}

export function benchmarkStaticArtifactEvidenceFlags(options: {
  host: "node" | "browser";
  suiteFilter?: string;
  artifact: BenchmarkStaticArtifactSelection;
}): { required: boolean; used: boolean } {
  return benchmarkInputEvidenceFlags({
    host: options.host,
    suiteFilter: options.suiteFilter,
    // The browser benchmark page imports every browser-compatible micro Wasm
    // URL at module load, before a suite is selected. Node loads by suite.
    suites: options.host === "browser"
      ? RUNNABLE_BENCHMARK_SUITES
      : options.artifact.suites,
    hosts: options.artifact.hosts,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function selectNodeBenchmarkRuntimeArtifacts(
  options: {
    resolveOptional?: OptionalResolver;
    resolveRootfs?: () => ResolvedRootfsArtifact;
  } = {},
): BenchmarkRuntimeArtifactSelections {
  const resolveOptional = options.resolveOptional ?? tryResolveBinary;
  const resolveRootfs = options.resolveRootfs ?? resolveRootfsArtifact;
  const kernelPath = resolveOptional("kernel.wasm");

  let rootfs: BenchmarkRuntimeArtifactSelection;
  try {
    const resolved = resolveRootfs();
    rootfs = {
      logicalPath: "rootfs.vfs",
      selectedPath: resolved.selectedPath,
      resolverRequest: resolved.resolverRequest,
      resolverSelectedPath: resolved.selectedPath,
    };
  } catch (error) {
    rootfs = {
      logicalPath: "rootfs.vfs",
      selectedPath: null,
      resolverRequest: "rootfs.vfs -> programs/rootfs.vfs",
      error: errorMessage(error),
    };
  }

  return {
    kernel: {
      logicalPath: "kernel.wasm",
      selectedPath: kernelPath,
      resolverRequest: "kernel.wasm",
      resolverSelectedPath: kernelPath,
      ...(!kernelPath
        ? { error: "tryResolveBinary(\"kernel.wasm\") returned no usable artifact" }
        : {}),
    },
    rootfs,
  };
}

export function selectBrowserBenchmarkRuntimeArtifacts(options: {
  resolveOptional?: OptionalResolver;
} = {}): BenchmarkRuntimeArtifactSelections {
  const resolveOptional = options.resolveOptional ?? tryResolveBinary;
  const kernelPath = resolveOptional("kernel.wasm");

  return {
    kernel: {
      logicalPath: "@kernel-wasm",
      selectedPath: kernelPath,
      resolverRequest: "kernel.wasm",
      resolverSelectedPath: kernelPath,
      ...(!kernelPath
        ? { error: "tryResolveBinary(\"kernel.wasm\") returned no usable artifact" }
        : {}),
    },
  };
}
