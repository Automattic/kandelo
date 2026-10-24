import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import type { PositionedImageTarget } from "../../images/vfs/lib/positioned-image-targets";
import { ERRNO } from "../src/generated/abi";
import { HostFileSystem } from "../src/vfs/host-fs";
import { NodeImageReader } from "../src/vfs/node-image-reader";
import { OverlayStorageFile } from "../src/vfs/overlay-storage";

const moduleBytes = () => new Uint8Array(readFileSync(new URL("../../local-binaries/kandelo_image_module_positioned32.wasm", import.meta.url)));

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
