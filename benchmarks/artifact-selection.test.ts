import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BENCHMARK_STATIC_ARTIFACTS,
  RUNNABLE_BENCHMARK_SUITES,
  benchmarkInputEvidenceFlags,
  benchmarkStaticArtifactEvidenceFlags,
  selectBrowserBenchmarkRuntimeArtifacts,
  selectNodeBenchmarkRuntimeArtifacts,
} from "./artifact-selection.js";
import { assertRequiredBenchmarkArtifacts } from "./artifact-evidence.js";
import type { BenchmarkArtifacts } from "./types.js";
import { resolveRootfsArtifact } from "../host/src/node-kernel-host.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("Node selection follows the kernel resolver and rootfs fallback order", () => {
  const rootfsRequests: string[] = [];
  const rootfs = resolveRootfsArtifact((request) => {
    rootfsRequests.push(request);
    if (request === "rootfs.vfs") throw new Error("canonical rootfs absent");
    if (request === "programs/rootfs.vfs") return "/selected/package-rootfs.vfs";
    throw new Error(`unexpected request: ${request}`);
  });
  const kernelRequests: string[] = [];
  const selections = selectNodeBenchmarkRuntimeArtifacts({
    resolveOptional(request) {
      kernelRequests.push(request);
      return "/selected/fetched-kernel.wasm";
    },
    resolveRootfs: () => rootfs,
  });

  assert.deepEqual(kernelRequests, ["kernel.wasm"]);
  assert.deepEqual(rootfsRequests, [
    "rootfs.vfs",
    "programs/rootfs.vfs",
  ]);
  assert.equal(selections.kernel.selectedPath, "/selected/fetched-kernel.wasm");
  assert.equal(selections.kernel.resolverRequest, "kernel.wasm");
  assert.equal(selections.rootfs?.selectedPath, "/selected/package-rootfs.vfs");
  assert.equal(selections.rootfs?.resolverRequest, "programs/rootfs.vfs");
});

test("browser selection uses the same policy-aware kernel resolver as Vite", () => {
  const resolverRequests: string[] = [];
  const selections = selectBrowserBenchmarkRuntimeArtifacts({
    resolveOptional(request) {
      resolverRequests.push(request);
      return "/selected/resolver-kernel.wasm";
    },
  });

  assert.deepEqual(resolverRequests, ["kernel.wasm"]);
  assert.equal(selections.kernel.selectedPath, "/selected/resolver-kernel.wasm");
  assert.equal(selections.rootfs, undefined);
});

test("runtime and static evidence are required only for workloads that consume them", () => {
  assert.deepEqual(
    benchmarkInputEvidenceFlags({
      host: "browser",
      suiteFilter: "wordpress",
      suites: RUNNABLE_BENCHMARK_SUITES,
    }),
    { required: true, used: true },
  );
  assert.deepEqual(
    benchmarkInputEvidenceFlags({
      host: "node",
      suiteFilter: "erlang-ring",
      suites: RUNNABLE_BENCHMARK_SUITES,
    }),
    { required: false, used: false },
  );
  assert.deepEqual(
    benchmarkInputEvidenceFlags({
      host: "node",
      suites: ["syscall-io", "process-lifecycle"],
      hosts: ["node"],
    }),
    { required: true, used: true },
  );
  assert.deepEqual(
    benchmarkInputEvidenceFlags({
      host: "node",
      suiteFilter: "wordpress",
      suites: ["syscall-io", "process-lifecycle"],
      hosts: ["node"],
    }),
    { required: false, used: false },
  );
  assert.deepEqual(
    benchmarkInputEvidenceFlags({
      host: "node",
      suiteFilter: "process-lifecycle",
      suites: ["process-lifecycle"],
      hosts: ["node"],
    }),
    { required: true, used: true },
  );
  assert.deepEqual(
    benchmarkInputEvidenceFlags({
      host: "browser",
      suiteFilter: "process-lifecycle",
      suites: ["process-lifecycle"],
      hosts: ["node"],
    }),
    { required: false, used: false },
  );
});

test("static Wasm evidence follows the selected suite and host", () => {
  const usedPaths = (
    host: "node" | "browser",
    suiteFilter: string,
  ): string[] => BENCHMARK_STATIC_ARTIFACTS
    .filter((artifact) => benchmarkStaticArtifactEvidenceFlags({
      host,
      suiteFilter,
      artifact,
    }).used)
    .map((artifact) => artifact.path);

  assert.deepEqual(usedPaths("node", "syscall-io"), [
    "benchmarks/wasm/pipe-throughput.wasm",
    "benchmarks/wasm/file-throughput.wasm",
    "benchmarks/wasm/syscall-latency.wasm",
  ]);
  assert.deepEqual(usedPaths("node", "process-lifecycle"), [
    "benchmarks/wasm/hello.wasm",
    "benchmarks/wasm/fork-bench.wasm",
    "benchmarks/wasm/exec-bench.wasm",
    "benchmarks/wasm/clone-bench.wasm",
    "benchmarks/wasm/spawn-bench.wasm",
  ]);
  assert.deepEqual(usedPaths("browser", "process-lifecycle"), [
    "benchmarks/wasm/pipe-throughput.wasm",
    "benchmarks/wasm/file-throughput.wasm",
    "benchmarks/wasm/syscall-latency.wasm",
    "benchmarks/wasm/hello.wasm",
    "benchmarks/wasm/fork-bench.wasm",
    "benchmarks/wasm/clone-bench.wasm",
    "benchmarks/wasm/spawn-bench.wasm",
  ]);
  assert.deepEqual(
    usedPaths("browser", "wordpress"),
    usedPaths("browser", "process-lifecycle"),
  );
  assert.deepEqual(usedPaths("node", "wordpress"), []);
});

test("browser static evidence matches the benchmark page's top-level Wasm imports", () => {
  const pageSource = readFileSync(
    resolve(__dirname, "../apps/browser-demos/pages/benchmark/main.ts"),
    "utf8",
  );
  const topLevelImports = Array.from(pageSource.matchAll(
    /from "\.\.\/\.\.\/\.\.\/\.\.\/benchmarks\/wasm\/([^"?]+)\?url"/g,
  ))
    .map((match) => `benchmarks/wasm/${match[1]}`)
    .sort();
  const browserEvidence = BENCHMARK_STATIC_ARTIFACTS
    .filter((artifact) => artifact.hosts?.includes("browser") ?? true)
    .map((artifact) => artifact.path)
    .sort();

  assert.deepEqual(browserEvidence, topLevelImports);
});

function emptyArtifacts(): BenchmarkArtifacts {
  return {
    gitHead: "head",
    gitRef: "ref",
    files: {},
    forkBench: {
      hasWpkForkSymbols: false,
      hasLegacyForkSymbols: false,
      matchedSymbols: [],
      expected: "wpk_fork_without_legacy",
      passed: null,
    },
  };
}

test("required missing evidence stops the runner unless it is explicitly unused", () => {
  const artifacts = emptyArtifacts();
  artifacts.files["runtime.kernel"] = {
    path: "kernel.wasm",
    missing: true,
    required: true,
    used: true,
  };
  artifacts.files["optional.opcache"] = {
    path: "opcache.so",
    missing: true,
    required: false,
  };
  artifacts.files["unused.input"] = {
    path: "unused.wasm",
    missing: true,
    required: true,
    used: false,
  };
  artifacts.directories = {
    "node.wordpress.sourceTree": {
      path: "wordpress",
      missing: true,
      required: true,
    },
  };

  assert.throws(
    () => assertRequiredBenchmarkArtifacts(artifacts),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.match(error.message, /runtime\.kernel/);
      assert.match(error.message, /node\.wordpress\.sourceTree/);
      assert.doesNotMatch(error.message, /optional\.opcache/);
      assert.doesNotMatch(error.message, /unused\.input/);
      return true;
    },
  );

  artifacts.files["runtime.kernel"].missing = false;
  artifacts.directories["node.wordpress.sourceTree"].missing = false;
  assert.doesNotThrow(() => assertRequiredBenchmarkArtifacts(artifacts));
});
