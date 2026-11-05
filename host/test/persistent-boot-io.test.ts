import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEnvironmentData, setEnvironmentData, Worker } from "node:worker_threads";
import type { WorkerOptions } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { persistentBaseFixture, persistentColdPayloadRange, persistentReplacementBaseFixture } from "./fixtures/persistent-base-image";

vi.mock("node:worker_threads", async importOriginal => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return { ...actual, Worker: class extends actual.Worker {
    constructor(filename: string | URL, options: WorkerOptions = {}) {
      const inherited = (options.execArgv ?? process.execArgv).filter(argument => argument !== "--experimental-wasm-exnref");
      super(filename, { ...options, execArgv: [...inherited, "--import",
        new URL("./fixtures/persistent-io-preload.mjs", import.meta.url).href] });
    }
  } };
});

import { NodeKernelHost } from "../src/node-kernel-host";
import { resolveBinary } from "../src/binary-resolver";

const kernelBytes = readFileSync(resolveBinary("kernel.wasm"));

for (const policy of ["crc32c", "sha256"] as const) {
  it(`recovers a replaced ${policy} base namespace at the running metadata allowance`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-recovery-inode-slots-"));
    const fixtureUrl = new URL("./fixtures/recovery-slots-worker.ts", import.meta.url).href;
    const registration = new URL("../node_modules/tsx/dist/esm/api/index.mjs", import.meta.url).href;
    try {
      const fixture = await persistentReplacementBaseFixture(directory, policy);
      for (const budget of [768 * 1024, 896 * 1024]) {
        const stage = join(directory, String(budget));
        mkdirSync(stage);
        for (const phase of ["replace", "recover", "verify"]) {
          const worker = new Worker(`import {register} from ${JSON.stringify(registration)}; register(); await import(${JSON.stringify(fixtureUrl)});`, {
            eval: true, workerData: { imagePath: fixture.path, binding: fixture.binding, directory: stage,
              budget, count: fixture.count, phase,
              kernelWasm: kernelBytes.buffer.slice(kernelBytes.byteOffset, kernelBytes.byteOffset + kernelBytes.byteLength) },
          });
          try {
            const result = await new Promise<Record<string, any>>((resolve, reject) => {
              worker.once("message", resolve);
              worker.once("error", reject);
              worker.once("exit", code => reject(new Error(`recovery worker exited before reporting (${code})`)));
            });
            expect(result.error, `${policy}/${budget}/${phase}`).toBeUndefined();
            expect(result.count).toBe(fixture.count);
            expect(result.text).toBe(phase === "replace" ? "" : "after recovery");
            expect(result.ioMemory.used).toBeLessThanOrEqual(result.ioMemory.limit);
          } finally { await worker.terminate(); }
        }
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 120_000);
}

describe("checked-base normal reopen physical read bound", () => {
  it.each(["crc32c", "sha256"] as const)("bounds double-indirect positioned reads with %s checking", async policy => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-file-read-io-"));
    const previous = getEnvironmentData("kandelo-persistent-io-probe");
    let host: NodeKernelHost | undefined;
    try {
      const fixture = await persistentBaseFixture(directory, policy, 8 * 1024 * 1024 + 17);
      const counts = new SharedArrayBuffer(32);
      const values = new BigUint64Array(counts);
      setEnvironmentData("kandelo-persistent-io-probe", { counts, path: fixture.path, guard: { start: 0, end: 0 } });
      host = new NodeKernelHost({ rootfsImageFile: fixture.path,
        rootfsPersistentImageBinding: { ...fixture.binding, dataCachePages: 2, indexCachePages: 2 },
        experimentalResizablePersistencePath: join(directory, "journal"), kernelMaxPages: 1024, maxPages: 1024 });
      await host.init(kernelBytes.buffer.slice(kernelBytes.byteOffset, kernelBytes.byteOffset + kernelBytes.byteLength) as ArrayBuffer);
      values.fill(0n);
      const offset = 5 * 1024 * 1024 + 37;
      const length = 1024 * 1024 - 257;
      const actual = await host.readFileRangeFromVfs("/large", offset, length);
      const bytes = Number(Atomics.load(values, 0));
      const calls = Number(Atomics.load(values, 1));
      console.log("persistent positioned physical reads", JSON.stringify({ policy, offset, length, bytes, calls }));
      expect(actual).toEqual(fixture.content.subarray(offset, offset + length));
      expect(bytes).toBeGreaterThan(0);
      expect(bytes).toBeLessThan(length * 5);
      expect(Number(Atomics.load(values, 2))).toBeLessThanOrEqual(65536);
      expect(await host.getKernelMemoryPages()).toBeLessThanOrEqual(1024);
    } finally {
      await host?.destroy();
      setEnvironmentData("kandelo-persistent-io-probe", previous);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);

  it.each(["crc32c", "sha256"] as const)("does not scan untouched payload with %s checking", async policy => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-boot-io-"));
    const previous = getEnvironmentData("kandelo-persistent-io-probe");
    const measurements: Array<{ contentBytes: number; physicalBytes: number; bytes: number; calls: number; maxRequest: number; touchedPayload: boolean }> = [];
    try {
      for (const contentBytes of [512 * 1024, 32 * 1024 * 1024]) {
        const stage = join(directory, String(contentBytes));
        mkdirSync(stage);
        const fixture = await persistentBaseFixture(stage, policy, contentBytes);
        const counts = new SharedArrayBuffer(32);
        const values = new BigUint64Array(counts);
        const guard = persistentColdPayloadRange(fixture.path, fixture.content);
        setEnvironmentData("kandelo-persistent-io-probe", { counts, path: fixture.path, guard });
        const boot = async (existing: boolean) => {
          const host = new NodeKernelHost({ rootfsImageFile: fixture.path, rootfsPersistentImageBinding: fixture.binding,
            experimentalResizablePersistencePath: join(stage, "journal"), requireExistingRootfsPersistence: existing,
            kernelMaxPages: 1024, maxPages: 1024 });
          try { await host.init(kernelBytes.buffer.slice(kernelBytes.byteOffset, kernelBytes.byteOffset + kernelBytes.byteLength) as ArrayBuffer); }
          catch (error) { await host.destroy(); throw error; }
          return host;
        };
        const first = await boot(false);
        try { await first.writeFileToVfs("/state", new TextEncoder().encode("persisted"), 0o640); }
        finally { await first.destroy(); }
        values.fill(0n);
        const second = await boot(true);
        try {
          expect(new TextDecoder().decode((await second.readFileFromVfs("/state"))!)).toBe("persisted");
          measurements.push({ contentBytes, physicalBytes: statSync(fixture.path).size,
            bytes: Number(Atomics.load(values, 0)), calls: Number(Atomics.load(values, 1)), maxRequest: Number(Atomics.load(values, 2)),
            touchedPayload: Atomics.load(values, 3) !== 0n });
        } finally { await second.destroy(); }
      }
      const [small, large] = measurements;
      expect(small.bytes).toBeGreaterThan(0);
      expect(large.bytes).toBeGreaterThan(0);
      expect(large.bytes).toBeLessThan(large.physicalBytes / 4);
      expect(small.touchedPayload).toBe(false);
      expect(large.touchedPayload).toBe(false);
      expect(large.maxRequest).toBeLessThanOrEqual(65536);
      console.log("persistent boot physical reads", JSON.stringify({ policy, measurements }));
    } finally {
      setEnvironmentData("kandelo-persistent-io-probe", previous);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);
});
