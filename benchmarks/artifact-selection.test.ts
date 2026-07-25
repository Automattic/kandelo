import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BENCHMARK_STATIC_ARTIFACTS,
  RUNNABLE_BENCHMARK_SUITES,
  benchmarkInputEvidenceFlags,
  benchmarkRuntimeArtifactEvidenceFlags,
  benchmarkStaticArtifactEvidenceFlags,
  selectBrowserBenchmarkRuntimeArtifacts,
  selectNodeBenchmarkRuntimeArtifacts,
} from "./artifact-selection.js";
import { assertRequiredBenchmarkArtifacts } from "./artifact-evidence.js";
import {
  collectSpawnScratchEvidence,
  SPAWN_SCRATCH_LARGE_WIRE_BYTES,
} from "./spawn-scratch-evidence.js";
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

test("Node selection does not resolve a rootfs for a self-contained suite", () => {
  let rootfsCalls = 0;
  const selections = selectNodeBenchmarkRuntimeArtifacts({
    resolveOptional: () => "/selected/kernel.wasm",
    resolveRootfs() {
      rootfsCalls++;
      throw new Error("must not be called");
    },
    includeRootfs: false,
  });

  assert.equal(rootfsCalls, 0);
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
  ]);
  assert.deepEqual(usedPaths("node", "spawn-scratch"), [
    "benchmarks/wasm/hello.wasm",
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

test("only the dedicated spawn scratch benchmark opts out of the Node rootfs", () => {
  assert.deepEqual(
    benchmarkRuntimeArtifactEvidenceFlags({
      host: "node",
      suiteFilter: "process-lifecycle",
      artifactName: "rootfs",
    }),
    { required: true, used: true },
  );
  assert.deepEqual(
    benchmarkRuntimeArtifactEvidenceFlags({
      host: "node",
      suiteFilter: "spawn-scratch",
      artifactName: "rootfs",
    }),
    { required: false, used: false },
  );
  assert.deepEqual(
    benchmarkRuntimeArtifactEvidenceFlags({
      host: "node",
      suiteFilter: "syscall-io",
      artifactName: "rootfs",
    }),
    { required: true, used: true },
  );
  assert.deepEqual(
    benchmarkRuntimeArtifactEvidenceFlags({
      host: "browser",
      suiteFilter: "process-lifecycle",
      artifactName: "rootfs",
    }),
    { required: false, used: false },
  );
});

test("Node process metrics keep default-rootfs semantics", () => {
  const processSource = readFileSync(
    resolve(__dirname, "suites/process-lifecycle.ts"),
    "utf8",
  );
  const spawnSource = readFileSync(
    resolve(__dirname, "suites/spawn-scratch.ts"),
    "utf8",
  );

  assert.doesNotMatch(processSource, /useDefaultRootfs\s*:\s*false/);
  assert.match(spawnSource, /useDefaultRootfs\s*:\s*false/);
});

test("spawn scratch workload fixes its ordinary env and validates child exit", () => {
  const source = readFileSync(
    resolve(__dirname, "programs/spawn-bench.c"),
    "utf8",
  );

  assert.doesNotMatch(source, /extern\s+char\s+\*\*environ/);
  assert.match(source, /spawn_and_wait\(ordinary_envp,\s*&ordinary_us\)/);
  assert.match(source, /"LANG=C"/);
  assert.match(source, /"PATH=\/bin"/);
  assert.match(source, /if\s*\(!WIFEXITED\(status\)\)/);
  assert.match(source, /if\s*\(WEXITSTATUS\(status\)\s*!=\s*0\)/);
});

test("spawn scratch evidence rejects missing timings and unexercised capacity", () => {
  const stdout = [
    "spawn_ms=1.25",
    `spawn_large_wire_bytes=${SPAWN_SCRATCH_LARGE_WIRE_BYTES}`,
    "spawn_large_first_ms=2.5",
    "spawn_large_repeat_ms=2.25",
  ].join("\n");

  assert.equal(SPAWN_SCRATCH_LARGE_WIRE_BYTES, 84_386);
  assert.deepEqual(
    collectSpawnScratchEvidence({
      stdout,
      retainedCapacity: SPAWN_SCRATCH_LARGE_WIRE_BYTES,
      kernelMemoryPages: 270,
    }),
    {
      spawn_ms: 1.25,
      spawn_large_wire_bytes: SPAWN_SCRATCH_LARGE_WIRE_BYTES,
      spawn_large_first_ms: 2.5,
      spawn_large_repeat_ms: 2.25,
      spawn_scratch_retained_bytes: SPAWN_SCRATCH_LARGE_WIRE_BYTES,
      spawn_scratch_kernel_bytes: 17_694_720,
    },
  );
  assert.throws(
    () => collectSpawnScratchEvidence({
      stdout: stdout.replace("spawn_large_first_ms=2.5\n", ""),
      retainedCapacity: SPAWN_SCRATCH_LARGE_WIRE_BYTES,
      kernelMemoryPages: 270,
    }),
    /spawn_large_first_ms/,
  );
  assert.throws(
    () => collectSpawnScratchEvidence({
      stdout,
      retainedCapacity: SPAWN_SCRATCH_LARGE_WIRE_BYTES - 1,
      kernelMemoryPages: 270,
    }),
    /did not retain enough scratch/,
  );
  assert.throws(
    () => collectSpawnScratchEvidence({
      stdout,
      retainedCapacity: SPAWN_SCRATCH_LARGE_WIRE_BYTES,
      kernelMemoryPages: 0,
    }),
    /kernel memory pages/,
  );
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
