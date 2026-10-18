import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { NodeKernelHost } from "../src/node-kernel-host";
import type { ClosedLazyAsset } from "../src/vfs/closed-lazy-assets";
import type { WasmModuleCacheStats } from "../src/wasm-module-cache";

// The kernel worker compiles each distinct program once and shares the
// module across spawn, exec, fork and threads; these cases run the real Node
// host and read the kernel worker's own cache counters.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const programs = join(repoRoot, "local-binaries/source-only-v1/programs/wasm32");
const shellImage = join(programs, "shell.vfs.zst");
const coreutils = join(programs, "coreutils.wasm");
const kernel = join(repoRoot, "local-binaries/source-only-v1/kernel.wasm");
const pthreadProgram = join(repoRoot, "examples/test-pthread.wasm");
const available = [shellImage, coreutils, kernel].every(existsSync);

// shell.vfs.zst stores coreutils as a lazy file at this image-relative URL.
const LAZY_URL_BASE = "https://kandelo.invalid/";
const COREUTILS_URL = `${LAZY_URL_BASE}binaries/programs/wasm32/coreutils.wasm`;

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function closedAsset(url: string, path: string): ClosedLazyAsset {
  const bytes = new Uint8Array(readFileSync(path));
  return {
    url,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
    bytes,
  };
}

async function withShellHost<T>(
  run: (host: NodeKernelHost, output: () => string) => Promise<T>,
): Promise<T> {
  let output = "";
  const decoder = new TextDecoder();
  const host = new NodeKernelHost({
    rootfsImage: new Uint8Array(readFileSync(shellImage)),
    rootfsLazyUrlBase: LAZY_URL_BASE,
    rootfsLazyAssets: [closedAsset(COREUTILS_URL, coreutils)],
    onStdout: (_pid, bytes) => { output += decoder.decode(bytes); },
    onStderr: (_pid, bytes) => { output += decoder.decode(bytes); },
  });
  try {
    await host.init(arrayBuffer(new Uint8Array(readFileSync(kernel))));
    return await run(host, () => output);
  } finally {
    await host.destroy().catch(() => {});
  }
}

async function bash(host: NodeKernelHost, script: string): Promise<number> {
  const { exit } = await host.spawnFromVfs("/bin/bash", ["bash", "-c", script], {
    env: ["PATH=/usr/bin:/bin", "HOME=/root"],
    uid: 0,
    gid: 0,
  });
  return exit;
}

function delta(
  after: WasmModuleCacheStats,
  before: WasmModuleCacheStats,
): { compiles: number; reused: number; failures: number } {
  return {
    compiles: after.compiles - before.compiles,
    reused: after.hits + after.joins - before.hits - before.joins,
    failures: after.compileFailures - before.compileFailures,
  };
}

describe.skipIf(!available)("compiled-module sharing on the Node host", () => {
  it("compiles one binary once across sequential exec, concurrent exec and fork", async () => {
    await withShellHost(async (host, output) => {
      const start = await host.getWasmModuleCacheStats();
      // bash forks for each command; every child execs the same coreutils
      // bytes (ls and sleep are both links to the multicall binary).
      const code = await bash(host, [
        "for i in 1 2 3; do /bin/ls / > /dev/null; done",
        "/bin/sleep 0.2 & /bin/sleep 0.2 & wait",
        "echo finished",
      ].join("; "));
      expect(code, output()).toBe(0);
      expect(output()).toContain("finished");
      const stats = await host.getWasmModuleCacheStats();
      // bash itself (the top-level launch) and coreutils, once each.
      expect(delta(stats, start)).toEqual({ compiles: 2, reused: 4, failures: 0 });
      expect(stats.liveEntries).toBeGreaterThanOrEqual(1);
    });
  }, 120_000);

  it("never runs a stale module after the executable's bytes change", async () => {
    await withShellHost(async (host, output) => {
      // The same path holds four different contents in turn. A path-keyed
      // cache would keep running the first module for all of them.
      const env = "mkdir -p /tmp/x; cp /usr/bin/coreutils /tmp/x/echo";
      expect(await bash(host, `${env}; /tmp/x/echo first`), output()).toBe(0);
      const first = await host.getWasmModuleCacheStats();

      // A valid custom section appended in place: new bytes, same program.
      // It must be compiled afresh, not served from coreutils' module.
      const custom = "printf '\\000\\004\\003abc' >> /tmp/x/echo";
      expect(await bash(host, `${custom}; /tmp/x/echo second`), output()).toBe(0);
      const second = await host.getWasmModuleCacheStats();
      expect(second.compiles - first.compiles).toBe(1);
      expect(second.compileFailures).toBe(first.compileFailures);

      // Different program at the same path: bash's own module, not echo's.
      expect(
        await bash(host, "cp /usr/bin/bash /tmp/x/echo; /tmp/x/echo -c 'echo as-bash'"),
        output(),
      ).toBe(0);

      // A trailing byte makes the bytes invalid: exec fails instead of
      // reusing either module compiled from earlier contents.
      expect(await bash(host, [
        "cp /usr/bin/coreutils /tmp/x/echo",
        "printf '\\0' >> /tmp/x/echo",
        "/tmp/x/echo must-not-run",
        "echo status=$?",
      ].join("; ")), output()).toBe(0);

      const text = output();
      expect(text).toMatch(/^first$/m);
      expect(text).toMatch(/^second$/m);
      expect(text).toMatch(/^as-bash$/m);
      expect(text).not.toContain("must-not-run");
      expect(text).toMatch(/status=126/);
    });
  }, 120_000);

  it.skipIf(!existsSync(pthreadProgram))(
    "shares one thread module between processes running the same bytes",
    async () => {
      await withShellHost(async (host, output) => {
        const bytes = arrayBuffer(new Uint8Array(readFileSync(pthreadProgram)));
        const start = await host.getWasmModuleCacheStats();
        expect(await host.spawn(bytes.slice(0), ["test-pthread"]), output()).toBe(0);
        const first = await host.getWasmModuleCacheStats();
        expect(await host.spawn(bytes.slice(0), ["test-pthread"]), output()).toBe(0);
        const second = await host.getWasmModuleCacheStats();
        // test-pthread has a start section, so its threads run a separately
        // compiled thread-patched module. The first run compiles the program
        // and that thread module; the second process reuses both.
        expect(delta(first, start).compiles).toBe(2);
        expect(first.threadCompiles - start.threadCompiles).toBe(1);
        expect(delta(second, first).compiles).toBe(0);
        expect(second.threadCompiles).toBe(first.threadCompiles);
        expect(
          second.threadHits + second.threadJoins
            - first.threadHits - first.threadJoins,
        ).toBe(1);
      });
    },
    120_000,
  );
});
