import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";
import type { WorkerOptions } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { hostFileReadImage } from "./fixtures/host-file-read-image";

vi.mock("node:worker_threads", async importOriginal => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return { ...actual, Worker: class extends actual.Worker {
    constructor(filename: string | URL, options: WorkerOptions = {}) {
      const inherited = (options.execArgv ?? process.execArgv).filter(argument => argument !== "--experimental-wasm-exnref");
      super(filename, { ...options, execArgv: [...inherited, "--import",
        new URL("./fixtures/short-file-read-preload.mjs", import.meta.url).href] });
    }
  } };
});

import { NodeKernelHost } from "../src/node-kernel-host";

const repository = resolve(import.meta.dirname, "../..");
const kernelBytes = readFileSync(join(repository, "target/wasm32-unknown-unknown/release/kandelo_kernel.wasm"));

it.each(["crc32c", "sha256"] as const)("bounds %s whole-file reads without truncating links, short reads or executable loading", async policy => {
  const directory = mkdtempSync(join(tmpdir(), "kandelo-read-budget-"));
  const previous = getEnvironmentData("kandelo-short-file-read");
  let active: NodeKernelHost | undefined;
  try {
    const fixture = await hostFileReadImage(directory, policy);
    const foreign = join(directory, "foreign");
    mkdirSync(foreign);
    const shortFile = join(foreign, "short");
    writeFileSync(shortFile, new Uint8Array(0));
    const counts = new SharedArrayBuffer(16);
    const measured = new Int32Array(counts);
    setEnvironmentData("kandelo-short-file-read", { path: shortFile, bytes: fixture.value, counts });
    const boot = async (existing: boolean) => {
      active = new NodeKernelHost({ rootfsImageFile: fixture.path, rootfsPersistentImageBinding: fixture.binding,
        experimentalResizablePersistencePath: join(directory, "journal"), requireExistingRootfsPersistence: existing,
        kernelMaxPages: 1024, maxPages: 1024, maxWorkers: 1, maxVfsFileReadBytes: 1024,
        extraMounts: [{ mountPoint: "/foreign", hostPath: foreign }] });
      await active.init(kernelBytes.buffer.slice(kernelBytes.byteOffset, kernelBytes.byteOffset + kernelBytes.byteLength) as ArrayBuffer);
      return active;
    };
    const first = await boot(false);
    expect(await first.readFileFromVfs("/a")).toEqual(fixture.value);
    const foreignValue = await first.readFileFromVfs("/foreign/short");
    expect(Atomics.load(measured, 0)).toBe(1);
    expect(Atomics.load(measured, 1)).toBe(0);
    expect(Atomics.load(measured, 2)).toBeGreaterThan(1);
    expect(Atomics.load(measured, 3)).toBeGreaterThan(0);
    expect(foreignValue).toEqual(fixture.value);
    console.log("bounded file-read transport", JSON.stringify({ policy, growths: Atomics.load(measured, 0),
      sizeBeforeRead: Atomics.load(measured, 1), shortReads: Atomics.load(measured, 2) }));
    expect(await first.readFileFromVfs("/empty")).toHaveLength(0);
    expect(await first.readFileFromVfs("/absent")).toBeNull();
    expect(await first.readFileFromVfs("/bin")).toBeNull();
    await expect(first.readFileFromVfs("/blocked")).rejects.toThrow("1024-byte memory allowance");
    expect(await first.readFileRangeFromVfs("/blocked", 0, fixture.large.length)).toEqual(fixture.large);
    await expect(first.readFileFromVfs("/bin/probe")).rejects.toThrow("1024-byte memory allowance");
    const process = await first.spawnFromVfs("/bin/probe", ["persistence-overwrite"]);
    expect(await process.exit).toBe(0);
    expect(new TextDecoder().decode((await first.readFileFromVfs("/state"))!)).toBe("XYcdefgh");
    await first.destroy();
    expect(first.getPersistenceShutdownFailure()).toBeNull();
    active = undefined;
    const second = await boot(true);
    expect(new TextDecoder().decode((await second.readFileFromVfs("/state"))!)).toBe("XYcdefgh");
    expect(await second.readFileFromVfs("/a")).toEqual(fixture.value);
    await second.destroy();
    expect(second.getPersistenceShutdownFailure()).toBeNull();
    active = undefined;
  } finally {
    await active?.destroy();
    setEnvironmentData("kandelo-short-file-read", previous);
    rmSync(directory, { recursive: true, force: true });
  }
}, 120_000);
