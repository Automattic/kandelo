import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { upgradeCuts, exerciseOwnerLoss, type OwnerResult } from "./fixtures/kifs-upgrade-cuts";
import { writeCheckedUpgradeSource } from "./fixtures/kifs-upgrade-source";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import type { PositionedImageTarget } from "../../images/vfs/lib/positioned-image-targets";
import { resolveBinary } from "../src/binary-resolver";
import { ERRNO } from "../src/generated/abi";
import { HostFileSystem } from "../src/vfs/host-fs";
import { NodeKernelHost } from "../src/node-kernel-host";
import { capacityProgram } from "./fixtures/kifs-v3-guest";
import { NodeImageReader } from "../src/vfs/node-image-reader";
import { OverlayStorageFile } from "../src/vfs/overlay-storage";

const moduleBytes = () => new Uint8Array(readFileSync(resolveBinary("kandelo_image_module_positioned32.wasm")));

async function temporary(operation: (directory: string, filesystem: KandeloImageFs, open: (name: string) => OverlayStorageFile) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "kandelo-image-writer-"));
  const filesystem = KandeloImageFs.createPositioned(moduleBytes());
  const owned: OverlayStorageFile[] = [];
  try {
    await operation(directory, filesystem, name => {
      const target = OverlayStorageFile.open(new HostFileSystem(directory), `/${name}`);
      owned.push(target);
      return target;
    });
  } finally {
    filesystem.reset();
    for (const target of owned) target.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("Rust persistent image writer through real Wasm and Node files", () => {
  it.each(upgradeCuts)("recovers a real saved volume after worker termination at %s", async cut => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-upgrade-cut-"));
    try {
      const { identity } = await writeCheckedUpgradeSource(directory);
      const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href;
      const fixture = new URL("./fixtures/kifs-upgrade-node-worker.ts", import.meta.url).href;
      const entry = new URL("data:text/javascript," + encodeURIComponent(
        `import { tsImport } from ${JSON.stringify(loader)}; await tsImport(${JSON.stringify(fixture)}, ${JSON.stringify(import.meta.url)});`,
      ));
      const kernelPath = process.env.KANDELO_KIFS_BENCH_KERNEL ?? resolveBinary("kernel.wasm");
      await exerciseOwnerLoss(cut, async action => {
        const worker = new Worker(entry, { workerData: { action, directory, identity, kernelPath }, execArgv: [] });
        try {
          return await new Promise<OwnerResult>((resolve, reject) => {
            worker.once("message", resolve);
            worker.once("error", reject);
            worker.once("exit", code => reject(new Error(`upgrade worker exited before reporting (${code})`)));
          });
        } finally { await worker.terminate(); }
      }, process.env.KANDELO_KIFS_EXPECT_INDEX_QUOTA === "1");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 90_000);

  it("refuses damaged active KIFS authority while the old journal is still readable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kifs-authority-"));
    try {
      const checked = await writeCheckedUpgradeSource(directory);
      const kernel = Uint8Array.from(readFileSync(resolveBinary("kernel.wasm"))).buffer;
      const journal = join(directory, "computer");
      const boot = async (phase: "seed" | "upgrade" | "recover", identity = checked.identity) => {
        const host = new NodeKernelHost({ rootfsImageFile: checked.path,
          rootfsPersistentImageBinding: { identitySha256: identity, dataCachePages: 1, indexCachePages: 1 },
          experimentalResizablePersistencePath: journal, requireExistingRootfsPersistence: phase !== "seed",
          kifsUpgradeProfile: phase === "upgrade" ? "development" : phase === "seed" ? "legacy" : undefined });
        try {
          await host.init(kernel);
          if (phase === "seed") await host.writeFileToVfs("/saved", Uint8Array.of(1), 0o600);
          if (phase === "upgrade") await host.writeFileToVfs("/saved", Uint8Array.of(2), 0o600);
          return await host.readFileFromVfs("/saved");
        } finally { await host.destroy(); }
      };
      await boot("seed");
      const source = readFileSync(journal);
      await boot("upgrade");
      expect(existsSync(journal)).toBe(false);
      // Simulate storage restored from a stale backup after activation.
      writeFileSync(journal, source);
      const files = ["activation0", "activation1", "g0.volume", "g0.volume-seal"] as const;
      const path = (file: typeof files[number]) => journal + "." + file;
      const saved = new Map(files.map(file => [file, readFileSync(path(file))]));
      for (const damage of ["missing controls", "corrupt controls", "missing volume", "wrong seal", "wrong base"]) {
        if (damage.endsWith("controls")) {
          for (const replica of ["activation0", "activation1"] as const) {
            if (damage === "missing controls") rmSync(path(replica));
            else writeFileSync(path(replica), Buffer.alloc(128, 9));
          }
        } else if (damage === "missing volume") rmSync(path("g0.volume"));
        else if (damage === "wrong seal") {
          const bytes = Buffer.from(saved.get("g0.volume-seal")!);
          bytes[bytes.length - 1] ^= 1;
          writeFileSync(path("g0.volume-seal"), bytes);
        }
        await expect(boot("recover", damage === "wrong base" ? "00".repeat(32) : checked.identity), damage).rejects.toThrow();
        expect(readFileSync(journal), damage).toEqual(source);
        for (const [file, bytes] of saved) writeFileSync(path(file), bytes);
        expect(await boot("recover"), damage).toEqual(Uint8Array.of(2));
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 90_000);

  it.each(["development", "custom"] as const)("upgrades a checked saved %s computer and boots its activated volume", async profile => {
    await temporary(async (directory, filesystem, open) => {
      filesystem.setImageCapacity(8 * 1024 * 1024);
      filesystem.writeFile("/base-file", new TextEncoder().encode("checked base"), 0o644);
      const checked = await filesystem.exportPersistentImageTo(open("base.img"), "sha256");
      const journal = join(directory, "computer");
      const kernel = Uint8Array.from(readFileSync(resolveBinary("kernel.wasm"))).buffer;
      const guest = Uint8Array.from(readFileSync(capacityProgram)).buffer;
      let objects: string | undefined;
      let legacyBlocks: string | undefined;
      for (const phase of ["seed", "upgrade", "reopen"]) {
        let output = "";
        const diagnostics: string[] = [];
        const write = (_pid: number, bytes: Uint8Array) => { output += new TextDecoder().decode(bytes); };
        const host = new NodeKernelHost({
          rootfsImageFile: join(directory, "base.img"),
          rootfsPersistentImageBinding: { identitySha256: checked.identitySha256, dataCachePages: 1, indexCachePages: 1 },
          experimentalResizablePersistencePath: journal, requireExistingRootfsPersistence: phase !== "seed",
          kifsUpgradeProfile: phase === "upgrade" ? profile : undefined,
          onHostDiagnostic: event => diagnostics.push(event.message), onStdout: write, onStderr: write,
        });
        try {
          await host.init(kernel);
          expect(new TextDecoder().decode((await host.readFileFromVfs("/base-file"))!)).toBe("checked base");
          const code = await host.spawn(guest, ["kifs-capacity", phase === "seed" ? "seed-saved" : "check-saved", "/"], { uid: 0, gid: 0 });
          expect(code, output).toBe(0);
          const ids = output.match(/^saved objects .+$/m)?.[0];
          const geometry = output.match(/^geometry (\d+) (\d+)$/m);
          expect(ids).toBeDefined();
          expect(geometry).not.toBeNull();
          if (phase === "seed") {
            objects = ids;
            legacyBlocks = geometry![1];
            expect(Number(geometry![2])).toBeGreaterThan(0);
          } else {
            expect(ids).toBe(objects);
            expect(geometry!.slice(1)).toEqual([profile === "development" ? "262144" : legacyBlocks, "0"]);
            if (phase === "upgrade") {
              await host.writeFileToVfs("/after-upgrade", Uint8Array.of(83), 0o600);
            } else {
              expect(await host.readFileFromVfs("/after-upgrade")).toEqual(Uint8Array.of(83));
            }
          }
          expect(diagnostics.filter(message => message.includes("Upgrading the saved filesystem"))).toHaveLength(phase === "upgrade" ? 1 : 0);
        } finally { await host.destroy(); }
        expect(host.getPersistenceShutdownFailure()).toBeNull();
      }
    });
  }, 120_000);

  it("stages and verifies a standalone KIFS v3 volume in a positioned file", async () => {
    await temporary(async (directory, filesystem, open) => {
      filesystem.writeFile("/source", new TextEncoder().encode("content"));
      filesystem.symlink("source", "/alias");
      filesystem.registerLazyFile("/deferred", "https://example.invalid/v3-deferred.wasm", 32_768, 0o755);
      filesystem.setImageMetadata({ version: 1, createdBy: "KIFS v3 staging fixture" });
      const identity = new Uint8Array(32).fill(19);
      const target = open("volume.kifs");
      const length = filesystem.stageKifsV3To(target, 262_144, identity);
      expect(length).toBe(target.len());
      expect(length).toBeLessThan(64 * 1024);
      const bytes = readFileSync(join(directory, "volume.kifs"));
      expect(bytes.subarray(0, 4).toString()).toBe("KIFS");
      expect(bytes.readUInt32LE(4)).toBe(3);
      expect(bytes.readBigUInt64LE(24)).toBe(262_144n);
      expect(bytes.subarray(96, 128)).toEqual(Buffer.from(identity));
      expect(bytes.includes(Buffer.from("https://example.invalid/v3-deferred.wasm"))).toBe(true);
      expect(bytes.includes(Buffer.from("KIFS v3 staging fixture"))).toBe(true);
      expect(bytes.subarray(4096, 4096 + 168)).toEqual(bytes.subarray(0, 168));
      expect(() => filesystem.stageKifsV3To(target, 262_144, identity))
        .toThrow(expect.objectContaining({ errno: ERRNO.EEXIST }));
      expect(readFileSync(join(directory, "volume.kifs"))).toEqual(bytes);
    });
  });

  it.each([false, true])("checks positioned import bytes with native SHA-256 before parsing (short reads: %s)", async shortReads => {
    await temporary(async (_directory, filesystem) => {
      filesystem.writeFile("/source", Uint8Array.from({ length: 256 * 1024 + 19 }, (_, index) => index % 251));
      const source = filesystem.exportImage();
      const digest = createHash("sha256").update(source).digest("hex");
      let largest = 0;
      const readAt = (offset: number, destination: Uint8Array) => {
        largest = Math.max(largest, destination.length);
        const bytes = source.subarray(offset, offset + Math.min(destination.length, shortReads ? 137 : destination.length));
        destination.set(bytes);
        return bytes.length;
      };
      const loaded = KandeloImageFs.createFromPositionedImage(moduleBytes(), source.length, readAt, undefined, digest);
      try { expect(loaded.readFile("/source")).toEqual(filesystem.readFile("/source")); }
      finally { loaded.reset(); }
      expect(largest).toBeLessThanOrEqual(65536);
      let observed = 0;
      expect(() => KandeloImageFs.createFromPositionedImage(moduleBytes(), source.length, (offset, destination) => {
        observed += destination.length;
        return readAt(offset, destination);
      }, undefined, "00".repeat(32))).toThrow(/verifyPositionedSource/);
      expect(observed).toBeGreaterThanOrEqual(source.length);
      expect(() => KandeloImageFs.createFromPositionedImage(moduleBytes(), source.length, () => -12, undefined, digest))
        .toThrow(expect.objectContaining({ errno: 12 }));
      expect(() => KandeloImageFs.createFromPositionedImage(moduleBytes(), source.length, () => 0, undefined, digest))
        .toThrow(expect.objectContaining({ errno: 5 }));
    });
  });

  it.each(["crc32c", "sha256"] as const)("exports, checks and derives a demand-verified %s base", async policy => {
    await temporary(async (directory, filesystem, open) => {
      const content = new Uint8Array(512 * 1024 + 17);
      for (let index = 0; index < content.length; index++) content[index] = index % 251;
      filesystem.writeFile("/large", content);
      filesystem.symlink("large", "/link");
      const target = open("base.img");
      let largestWrite = 0;
      let largestRead = 0;
      const progress: Array<{ phase: string; bytes: number; total: number }> = [];
      const monitored: PositionedImageTarget = {
        len: target.len.bind(target), truncate: target.truncate.bind(target), flush: target.flush.bind(target),
        writeAllAt: (offset, bytes) => { largestWrite = Math.max(largestWrite, bytes.length); target.writeAllAt(offset, bytes); },
        readExactAt: (offset, bytes) => { largestRead = Math.max(largestRead, bytes.length); target.readExactAt(offset, bytes); },
      };
      const result = await filesystem.exportPersistentImageTo(monitored, policy, { onProgress: update => { progress.push(update); } });
      expect(result.integrityPolicy).toBe(policy);
      expect(result.identitySha256).toMatch(/^[0-9a-f]{64}$/);
      expect(result.physicalLength).toBe(target.len());
      expect(largestWrite).toBeLessThanOrEqual(65536);
      expect(largestRead).toBeLessThanOrEqual(65536);
      expect(progress.filter(update => update.phase === "write").at(-1)?.bytes).toBe(result.payloadLength);
      expect(progress.filter(update => update.phase === "verify").at(-1)?.bytes).toBe(result.payloadLength);
      const reader = NodeImageReader.open(join(directory, "base.img"), undefined, true);
      const binding = { identitySha256: result.identitySha256, dataCachePages: 1, indexCachePages: 1 };
      let inspectedBytes = 0;
      expect(KandeloImageFs.inspectPersistentImage(moduleBytes(), reader.length, (offset, destination) => {
        inspectedBytes += destination.length;
        return reader.readAt(offset, destination);
      }, result.identitySha256, policy)).toBe(result.payloadLength);
      expect(inspectedBytes).toBe(128);
      const inspected = KandeloImageFs.inspectPersistentImageState(moduleBytes(), reader.length,
        (offset, destination) => reader.readAt(offset, destination), result.identitySha256, policy);
      expect(inspected.payloadLength).toBe(result.payloadLength);
      expect(inspected.memoryPages).toBeGreaterThan(0);
      expect(inspected.memoryPages * 65536).toBeLessThanOrEqual(64 * 1024 * 1024);
      expect(() => KandeloImageFs.inspectPersistentImage(moduleBytes(), reader.length,
        (offset, destination) => reader.readAt(offset, destination), result.identitySha256,
        policy === "crc32c" ? "sha256" : "crc32c")).toThrow(expect.objectContaining({ errno: ERRNO.EINVAL }));
      const wrongIdentity = (result.identitySha256[0] === "0" ? "1" : "0") + result.identitySha256.slice(1);
      expect(() => KandeloImageFs.inspectPersistentImage(moduleBytes(), reader.length,
        (offset, destination) => reader.readAt(offset, destination), wrongIdentity, policy)).toThrow();
      let startupRead = 0;
      const derived = KandeloImageFs.createFromPositionedImage(moduleBytes(), reader.length, (offset, destination) => {
        startupRead += destination.length;
        return reader.readAt(offset, destination);
      }, binding);
      try {
        expect(startupRead).toBeLessThan(result.physicalLength / 2);
        expect(derived.readlink("/link")).toBe("large");
        expect(derived.readFile("/large")).toEqual(content);
        derived.writeFile("/new", new Uint8Array([17, 23]));
        const next = await derived.exportPersistentImageTo(open("derived.img"), policy);
        expect(next.identitySha256).not.toBe(result.identitySha256);
        const nextReader = NodeImageReader.open(join(directory, "derived.img"), undefined, true);
        const restored = KandeloImageFs.createFromPositionedImage(moduleBytes(), nextReader.length,
          (offset, destination) => nextReader.readAt(offset, destination), { ...binding, identitySha256: next.identitySha256 });
        try {
          expect(restored.readFile("/new")).toEqual(new Uint8Array([17, 23]));
          expect(restored.readFile("/large")).toEqual(content);
        } finally { restored.reset(); nextReader.close(); }
      } finally { derived.reset(); reader.close(); }
    });
  }, 60_000);

  it("rejects corruption introduced into stored bytes after flush instead of publishing an identity", async () => {
    await temporary(async (_directory, filesystem, open) => {
      const target = open("damaged.img");
      const damaged: PositionedImageTarget = {
        len: target.len.bind(target), truncate: target.truncate.bind(target),
        readExactAt: target.readExactAt.bind(target), writeAllAt: target.writeAllAt.bind(target),
        flush: () => {
          target.flush();
          const byte = new Uint8Array(1);
          target.readExactAt(135, byte);
          byte[0] ^= 1;
          target.writeAllAt(135, byte);
          target.flush();
        },
      };
      await expect(filesystem.writePersistentImageTo(damaged, 31, "sha256", [new Uint8Array(31)]))
        .rejects.toMatchObject({ errno: ERRNO.EIO });
      await expect(filesystem.writePersistentImageTo(open("retry.img"), 31, "sha256", [new Uint8Array(31)]))
        .resolves.toMatchObject({ payloadLength: 31 });
    });
  });

  it("preserves ENOSPC, refuses incomplete input and never erases a nonempty target", async () => {
    await temporary(async (_directory, filesystem, open) => {
      const target = open("quota.img");
      const limited: PositionedImageTarget = {
        len: target.len.bind(target), truncate: target.truncate.bind(target), flush: target.flush.bind(target),
        readExactAt: target.readExactAt.bind(target),
        writeAllAt: (offset, bytes) => {
          if (Number(offset) >= 128) throw Object.assign(new Error("quota"), { code: "ENOSPC" });
          target.writeAllAt(offset, bytes);
        },
      };
      await expect(filesystem.writePersistentImageTo(limited, 31, "crc32c", [new Uint8Array(31).fill(7)]))
        .rejects.toMatchObject({ errno: ERRNO.ENOSPC });
      const incomplete = open("incomplete.img");
      await expect(filesystem.writePersistentImageTo(incomplete, 31, "crc32c", [new Uint8Array(17)]))
        .rejects.toMatchObject({ errno: ERRNO.EINVAL });
      const existing = open("existing.img");
      existing.writeAllAt(0, new Uint8Array([17, 23]));
      await expect(filesystem.writePersistentImageTo(existing, 31, "sha256", [new Uint8Array(31)]))
        .rejects.toMatchObject({ errno: ERRNO.EINVAL });
      const bytes = new Uint8Array(2);
      existing.readExactAt(0, bytes);
      expect(Array.from(bytes)).toEqual([17, 23]);
    });
  });

  it("keeps a target bound across asynchronous progress, cancellation and refused replacement", async () => {
    await temporary(async (_directory, filesystem, open) => {
      const first = open("first.img");
      const other = open("other.img");
      const controller = new AbortController();
      let announce!: () => void;
      let release!: () => void;
      const entered = new Promise<void>(resolve => { announce = resolve; });
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const pending = filesystem.writePersistentImageTo(first, 31, "sha256", [new Uint8Array(31)], {
        signal: controller.signal,
        onProgress: async () => { announce(); await blocked; },
      });
      await entered;
      await expect(filesystem.writePersistentImageTo(other, 31, "sha256", [new Uint8Array(31)]))
        .rejects.toThrow(/busy/);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(other.len()).toBe(0);
      const header = new Uint8Array(128);
      first.readExactAt(0, header);
      expect(header.every(byte => byte === 0)).toBe(true);
      await expect(filesystem.writePersistentImageTo(other, 31, "crc32c", [new Uint8Array(31)]))
        .resolves.toMatchObject({ payloadLength: 31 });
      release();
      await blocked;
    });
  });

  it("aborts while a producer next call is pending and ignores its late result after target reuse", async () => {
    await temporary(async (_directory, filesystem, open) => {
      const first = open("pending.img");
      const nextTarget = open("after-abort.img");
      const controller = new AbortController();
      let announce!: () => void;
      let release!: (result: IteratorResult<Uint8Array>) => void;
      const entered = new Promise<void>(resolve => { announce = resolve; });
      const blocked = new Promise<IteratorResult<Uint8Array>>(resolve => { release = resolve; });
      let returned = 0;
      const input: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]: () => ({
          next: () => { announce(); return blocked; },
          return: async () => { returned++; return { done: true, value: undefined }; },
        }),
      };
      const pending = filesystem.writePersistentImageTo(first, 31, "sha256", input, { signal: controller.signal });
      await entered;
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(returned).toBe(1);
      await filesystem.writePersistentImageTo(nextTarget, 31, "crc32c", [new Uint8Array(31)]);
      const before = new Uint8Array(nextTarget.len());
      nextTarget.readExactAt(0, before);
      release({ done: false, value: new Uint8Array(31).fill(73) });
      await blocked;
      const after = new Uint8Array(nextTarget.len());
      nextTarget.readExactAt(0, after);
      expect(after).toEqual(before);
      const header = new Uint8Array(128);
      first.readExactAt(0, header);
      expect(header.every(byte => byte === 0)).toBe(true);
    });
  });

  it("does not cancel an export plan started by a verification-progress observer", async () => {
    await temporary(async (_directory, filesystem, open) => {
      filesystem.writeFile("/state", new Uint8Array([17, 23]));
      const native = Reflect.get(filesystem, "exports") as { sm_export_image_cancel(): void };
      let cancellations = 0;
      Reflect.set(filesystem, "exports", { ...native, sm_export_image_cancel: () => {
        cancellations++;
        native.sm_export_image_cancel();
      } });
      let observer: IterableIterator<Uint8Array> | undefined;
      let observedCancellations = -1;
      await filesystem.exportPersistentImageTo(open("base.img"), "sha256", {
        onProgress: progress => {
          if (progress.phase !== "verify" || progress.bytes !== 0) return;
          observer = filesystem.exportImageChunks(4096);
          expect(observer.next().done).toBe(false);
          observedCancellations = cancellations;
        },
      });
      expect(observedCancellations).toBeGreaterThanOrEqual(0);
      expect(cancellations).toBe(observedCancellations);
      expect(observer!.next().done).toBe(false);
      observer!.return?.();
      expect(cancellations).toBe(observedCancellations + 1);
    });
  });

  it("honors an abort between the final progress continuation and identity publication", async () => {
    await temporary(async (_directory, filesystem, open) => {
      const controller = new AbortController();
      await expect(filesystem.writePersistentImageTo(open("final-abort.img"), 31, "crc32c", [new Uint8Array(31)], {
        signal: controller.signal,
        onProgress: progress => {
          if (progress.phase === "verify" && progress.bytes === progress.total) {
            queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => controller.abort())));
          }
        },
      })).rejects.toMatchObject({ name: "AbortError" });
      await expect(filesystem.writePersistentImageTo(open("after-final-abort.img"), 31, "crc32c", [new Uint8Array(31)]))
        .resolves.toMatchObject({ payloadLength: 31 });
    });
  });

  it("releases a superseded native export plan when replacement scratch allocation fails", async () => {
    await temporary(async (_directory, filesystem) => {
      const native = Reflect.get(filesystem, "exports") as { sm_alloc(length: number): number; sm_export_image_cancel(): void };
      let refuse = false;
      let cancellations = 0;
      Reflect.set(filesystem, "exports", { ...native,
        sm_alloc: (length: number) => refuse ? 0 : native.sm_alloc(length),
        sm_export_image_cancel: () => { cancellations++; native.sm_export_image_cancel(); },
      });
      const original = filesystem.exportImageChunks(4096);
      expect(original.next().done).toBe(false);
      refuse = true;
      const refused = filesystem.exportImageChunks(4096);
      expect(() => refused.next()).toThrow(/allocation failed/);
      expect(cancellations).toBe(1);
      original.return?.();
      expect(cancellations).toBe(1);
      refuse = false;
      const retry = filesystem.exportImageChunks(4096);
      expect(retry.next().done).toBe(false);
      retry.return?.();
      expect(cancellations).toBe(2);
    });
  });

  it("gets export geometry from Rust without leaving an ownerless native plan or cancelling a live iterator", async () => {
    await temporary(async (_directory, filesystem) => {
      filesystem.writeFile("/state", new Uint8Array([17, 23]));
      const length = filesystem.exportImageLength();
      expect(filesystem.exportImage().length).toBe(length);
      const active = filesystem.exportImageChunks(4096);
      expect(active.next().done).toBe(false);
      expect(() => filesystem.exportImageLength()).toThrow(/busy/);
      expect(active.next().done).toBe(false);
      active.return?.();
      expect(filesystem.exportImageLength()).toBe(length);
    });
  });
});
