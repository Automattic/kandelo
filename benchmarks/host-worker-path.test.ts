import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hostBuildFingerprintBanner } from "../host/src/compiled-worker-entry.js";
import { NODE_KERNEL_WORKER_PATH_ENV } from "../host/src/node-kernel-host.js";
import {
  benchmarkKernelWorkerPolicy,
  compareBenchmarkKernelWorkers,
  finishBenchmarkKernelWorker,
  prepareBenchmarkKernelWorker,
} from "./host-worker-path.js";

/** A fake repository whose host/dist bundles match host/src. */
function fakeRepo(): { root: string; hostSrc: string; edit: () => void; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "kandelo-bench-worker-"));
  const host = join(root, "host");
  const hostSrc = join(host, "src");
  mkdirSync(hostSrc, { recursive: true });
  mkdirSync(join(host, "dist"));
  for (const file of ["package-lock.json", "package.json", "tsconfig.json", "tsup.config.ts"]) {
    writeFileSync(join(host, file), `${file}\n`);
  }
  writeFileSync(join(hostSrc, "node-kernel-worker-entry.ts"), "export {};\n");
  writeFileSync(join(hostSrc, "worker-entry.ts"), "export {};\n");
  const banner = hostBuildFingerprintBanner(host);
  writeFileSync(join(host, "dist", "node-kernel-worker-entry.js"), banner);
  writeFileSync(join(host, "dist", "worker-entry.js"), banner);
  return {
    root,
    hostSrc,
    edit: () => writeFileSync(join(hostSrc, "kernel-worker.ts"), "// edited\n"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("a benchmark refuses a stale host bundle and names the rebuild command", () => {
  const repo = fakeRepo();
  try {
    repo.edit();
    const env: NodeJS.ProcessEnv = {};
    assert.throws(
      () => prepareBenchmarkKernelWorker("bundled", {
        env,
        hostModuleDir: repo.hostSrc,
        repoRoot: repo.root,
      }),
      /host bundle is stale or missing.*Rebuild it with: scripts\/dev-shell\.sh \.\/run\.sh build host/s,
    );
    // The policy is pinned in the environment the host reads, so every later
    // kernel launch in this process enforces it too.
    assert.equal(env[NODE_KERNEL_WORKER_PATH_ENV], "bundled");
  } finally {
    repo.cleanup();
  }
});

test("a benchmark on a current bundle records the bundled path and fingerprint", () => {
  const repo = fakeRepo();
  try {
    const evidence = prepareBenchmarkKernelWorker("bundled", {
      env: {},
      hostModuleDir: repo.hostSrc,
      repoRoot: repo.root,
    });
    assert.equal(evidence.policy, "bundled");
    assert.equal(evidence.path, "bundled");
    assert.equal(evidence.entry, "host/dist/node-kernel-worker-entry.js");
    assert.match(evidence.bundleFingerprint ?? "", /^[0-9a-f]{64}$/);
    assert.equal(evidence.sourceFingerprint, evidence.bundleFingerprint);
    assert.equal(evidence.processWorkerEntry, "host/dist/worker-entry.js");
    assert.equal(evidence.processWorkerBundleFingerprint, evidence.bundleFingerprint);

    const recorded = finishBenchmarkKernelWorker(evidence, {
      bundled: 3,
      tsx: 0,
      bundleFingerprints: [evidence.bundleFingerprint!],
    });
    assert.deepEqual(recorded.kernelWorkerLaunches, {
      bundled: 3,
      tsx: 0,
      bundleFingerprints: [evidence.bundleFingerprint],
    });
  } finally {
    repo.cleanup();
  }
});

test("a stale process-worker bundle also refuses", () => {
  const repo = fakeRepo();
  try {
    writeFileSync(join(repo.root, "host", "dist", "worker-entry.js"), "/* old */");
    assert.throws(
      () => prepareBenchmarkKernelWorker("bundled", {
        env: {},
        hostModuleDir: repo.hostSrc,
        repoRoot: repo.root,
      }),
      /process-worker bundle is stale or missing/,
    );
  } finally {
    repo.cleanup();
  }
});

test("--kernel-worker=tsx measures the tsx path deliberately and says so", () => {
  const repo = fakeRepo();
  try {
    repo.edit();
    assert.equal(benchmarkKernelWorkerPolicy([]), "bundled");
    assert.equal(benchmarkKernelWorkerPolicy(["--kernel-worker=tsx"]), "tsx");
    assert.equal(benchmarkKernelWorkerPolicy(["--kernel-worker", "tsx"]), "tsx");
    assert.throws(() => benchmarkKernelWorkerPolicy(["--kernel-worker=auto"]));

    const env: NodeJS.ProcessEnv = {};
    const evidence = prepareBenchmarkKernelWorker("tsx", {
      env,
      hostModuleDir: repo.hostSrc,
      repoRoot: repo.root,
    });
    assert.equal(env[NODE_KERNEL_WORKER_PATH_ENV], "tsx");
    assert.equal(evidence.path, "tsx");
    assert.equal(evidence.entry, "host/src/node-kernel-worker-entry.ts");
    assert.equal(evidence.bundleFingerprint, null);
  } finally {
    repo.cleanup();
  }
});

test("a launch on the other path or from another bundle voids the result", () => {
  const evidence = {
    policy: "bundled" as const,
    path: "bundled" as const,
    entry: "host/dist/node-kernel-worker-entry.js",
    bundleFingerprint: "a".repeat(64),
    sourceFingerprint: "a".repeat(64),
    fallbackReason: null,
  };
  assert.throws(
    () => finishBenchmarkKernelWorker(evidence, {
      bundled: 2,
      tsx: 1,
      bundleFingerprints: ["a".repeat(64)],
    }),
    /did not all run the bundled path/,
  );
  assert.throws(
    () => finishBenchmarkKernelWorker(evidence, {
      bundled: 2,
      tsx: 0,
      bundleFingerprints: ["a".repeat(64), "b".repeat(64)],
    }),
    /did not all run the bundled path/,
  );
});

test("compare refuses a bundled-vs-tsx pair and warns on unrecorded results", () => {
  const worker = (path: "bundled" | "tsx") => ({
    policy: path,
    path,
    entry: "x",
    bundleFingerprint: path === "bundled" ? "a".repeat(64) : null,
    sourceFingerprint: null,
    fallbackReason: null,
  });
  const mixed = compareBenchmarkKernelWorkers(
    { host: "node", hostWorker: worker("bundled") },
    { host: "node", hostWorker: worker("tsx") },
  );
  assert.match(mixed.error ?? "", /before ran the bundled kernel worker path and after ran tsx/);

  const same = compareBenchmarkKernelWorkers(
    { host: "node", hostWorker: worker("bundled") },
    { host: "node", hostWorker: worker("bundled") },
  );
  assert.equal(same.error, null);
  assert.deepEqual(same.warnings, []);

  const unrecorded = compareBenchmarkKernelWorkers(
    { host: "node" },
    { host: "node", hostWorker: worker("bundled") },
  );
  assert.equal(unrecorded.error, null);
  assert.match(unrecorded.warnings[0], /before result does not record/);

  const browser = compareBenchmarkKernelWorkers({ host: "browser" }, { host: "browser" });
  assert.deepEqual(browser, { error: null, warnings: [], notes: [] });
});
