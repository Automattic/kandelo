import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { tryResolveBinary } from "../src/binary-resolver";
import { CentralizedKernelWorker } from "../src/kernel-worker";
import { NodeKernelHost } from "../src/node-kernel-host";
import { NodePlatformIO } from "../src/platform/node";
import { configureRootfsOverlayFromImage } from "../src/process-lifecycle";
import { HostFileSystem } from "../src/vfs/host-fs";
import { OverlayStorageFile, type PersistentOverlayStorage } from "../src/vfs/overlay-storage";
import { writeOverlayGenerationSeal } from "../src/vfs/overlay-generation-seal";
import { NoValidOverlayGenerationError } from "../src/vfs/overlay-generation-selection";

const directKernelPath = join(import.meta.dirname, "../../target/wasm32-unknown-unknown/release/kandelo_kernel.wasm");
const directImageModulePath = join(import.meta.dirname, "../../target/wasm32-unknown-unknown/release/kandelo_image_module.wasm");
const publishedImageModulePath = join(import.meta.dirname, "../../local-binaries/kandelo_image_module32.wasm");
const kernelPath = tryResolveBinary("kernel.wasm") ?? (existsSync(directKernelPath) ? directKernelPath : null);
const imageModulePath = [publishedImageModulePath, directImageModulePath].find((path) => {
  if (!existsSync(path)) return false;
  return WebAssembly.Module.imports(new WebAssembly.Module(readFileSync(path))).length === 0;
}) ?? null;
const guestProgramPath = tryResolveBinary("test-fixtures/wasm32/persistence-overwrite.wasm");
const guestProgramName = "/bin/persistence-overwrite";
const encoder = new TextEncoder();

const largeWriteBytes = 2 * 1024 * 1024;

async function makeImage(state: string, includeLargeFile = false, largeFileBytes = largeWriteBytes + 4096): Promise<Uint8Array> {
  const filesystem = KandeloImageFs.create(new Uint8Array(readFileSync(imageModulePath!)));
  if (guestProgramPath !== null) {
    filesystem.mkdir("/bin", 0o755);
    filesystem.writeFile(guestProgramName, new Uint8Array(readFileSync(guestProgramPath)), 0o755);
  }
  filesystem.writeFile("/state", encoder.encode(state), 0o644);
  if (includeLargeFile) filesystem.writeFile("/large", new Uint8Array(largeFileBytes), 0o644);
  return filesystem.saveImage();
}

async function boot(image: Uint8Array, path: string, resizable = false, requireExisting = false): Promise<NodeKernelHost> {
  const host = new NodeKernelHost({
    rootfsImage: image,
    ...(resizable
      ? { experimentalResizablePersistencePath: path }
      : { experimentalFixedPersistencePath: path }),
    requireExistingRootfsPersistence: requireExisting,
  });
  const kernelBytes = new Uint8Array(readFileSync(kernelPath!));
  try {
    await host.init(kernelBytes.buffer.slice(
      kernelBytes.byteOffset,
      kernelBytes.byteOffset + kernelBytes.byteLength,
    ) as ArrayBuffer);
    return host;
  } catch (error) {
    await host.destroy();
    throw error;
  }
}

function expandJournalToCompactionThreshold(path: string): number {
  const original = readFileSync(path);
  const transactionLength = original.readUInt32LE(72 + 4);
  expect(original.byteLength).toBe(72 + transactionLength);
  const count = Math.ceil((32 * 1024 * 1024 - original.byteLength) / transactionLength) + 1;
  const repeated = Buffer.allocUnsafe(count * transactionLength);
  for (let index = 0; index < count; index++) {
    const offset = index * transactionLength;
    original.copy(repeated, offset, 72);
    repeated.writeBigUInt64LE(BigInt(index + 2), offset + 8);
    createHash("sha256")
      .update(repeated.subarray(offset, offset + transactionLength - 36))
      .digest()
      .copy(repeated, offset + transactionLength - 36);
  }
  writeFileSync(path, Buffer.concat([original, repeated]));
  return original.byteLength + repeated.byteLength;
}

describe.skipIf(kernelPath === null || imageModulePath === null)("fixed rootfs persistence", () => {
  it.skipIf(guestProgramPath === null).each(["mmap-sync", "mmap-syncfs", "mmap-sync-all", "mmap-fsync", "mmap-fdatasync", "sync", "syncfs"] as const)("makes %s durable before host shutdown", async (mode) => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-mmap-persistence-"));
    const path = join(directory, "machine.journal");
    const committedPath = join(directory, "committed.journal");
    const image = await makeImage("abcdefgh");
    try {
      const first = await boot(image, path);
      try {
        const { exit } = await first.spawnFromVfs(guestProgramName, ["persistence-overwrite", mode]);
        expect(await exit).toBe(0);
        expect(readFileSync(path).byteLength).toBeGreaterThan(72);
        copyFileSync(path, committedPath);
      } finally {
        await first.destroy();
      }
      const reopened = await boot(image, committedPath, false, true);
      try {
        expect(new TextDecoder().decode((await reopened.readFileFromVfs("/state"))!)).toBe(mode.startsWith("mmap-") ? "MScdefgh" : "XYcdefgh");
      } finally {
        await reopened.destroy();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["fixed", "resizable"] as const)("preserves %s host storage failures instead of reporting a corrupt generation", async (mode) => {
    const image = await makeImage("abcdefgh");
    const worker = new CentralizedKernelWorker(
      { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      new NodePlatformIO(),
    );
    configureRootfsOverlayFromImage(worker, {
      imageLength: image.byteLength,
      imageRead: (offset, destination) => {
        const bytes = image.subarray(offset, offset + destination.byteLength);
        destination.set(bytes);
        return bytes.byteLength;
      },
      foreignPrefixes: [],
      nosuid: false,
    });
    const kernelBytes = new Uint8Array(readFileSync(kernelPath!));
    await worker.init(kernelBytes.buffer.slice(kernelBytes.byteOffset, kernelBytes.byteOffset + kernelBytes.byteLength));
    const failure = Object.assign(new Error("injected host journal read failure"), { code: "EIO" });
    const storage: PersistentOverlayStorage = {
      len: () => 72,
      readExactAt: () => { throw failure; },
      writeAllAt: () => {},
      flush: () => {},
      truncate: () => {},
      close: () => {},
    };
    const enable = () => mode === "fixed"
      ? worker.enableFixedRootfsPersistence(storage)
      : worker.enableResizableRootfsPersistence(storage);
    let rejection: unknown;
    try {
      enable();
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain("persistent overlay host storage failed during kernel initialization");
    expect((rejection as Error).message).toContain("injected host journal read failure");
    expect((rejection as Error).cause).toBe(failure);
  });

  it.skipIf(guestProgramPath === null)("refuses to reset a restored computer whose journal disappeared", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-missing-journal-"));
    const path = join(directory, "machine.journal");
    try {
      const image = await makeImage("abcdefgh");
      const first = await boot(image, path);
      try {
        const { exit } = await first.spawnFromVfs(guestProgramName, ["persistence-overwrite"]);
        expect(await exit).toBe(0);
      } finally {
        await first.destroy();
      }
      rmSync(path);
      await expect(boot(image, path, false, true)).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
      expect(existsSync(path)).toBe(false);
      writeFileSync(path, new Uint8Array());
      await expect(boot(image, path, false, true)).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
      expect(readFileSync(path).byteLength).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(guestProgramPath === null)("streams a composed resizable snapshot to a file that boots without its journal", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-resizable-export-"));
    const path = join(directory, "machine.journal");
    const snapshotPath = join(directory, "snapshot.vfs");
    try {
      const image = await makeImage("abcdefgh");
      const first = await boot(image, path, true);
      try {
        await first.writeFileToVfs("/state", encoder.encode("SNAP"));
        await first.writeFileToVfs("/created", encoder.encode("created"));
        const { exit } = await first.spawnFromVfs(guestProgramName, ["persistence-overwrite", "create-fifo"]);
        expect(await exit).toBe(0);
        const socket = await first.spawnFromVfs(guestProgramName, ["persistence-overwrite", "create-socket"]);
        expect(await socket.exit).toBe(0);
      } finally {
        await first.destroy();
      }
      const reopened = await boot(image, path, true);
      try {
        expect(new TextDecoder().decode((await reopened.readFileFromVfs("/state"))!)).toBe("SNAP");
        const integrity = await reopened.exportRootfsImageToFile(snapshotPath);
        const snapshot = readFileSync(snapshotPath);
        expect(integrity.length).toBe(snapshot.byteLength);
        expect(integrity.chunkBytes).toBe(1024 * 1024);
        expect(integrity.chunkSha256).toEqual([createHash("sha256").update(snapshot).digest("hex")]);
        await expect(reopened.exportRootfsImageToFile(snapshotPath)).rejects.toThrow();
        expect(readFileSync(snapshotPath).byteLength).toBe(integrity.length);
      } finally {
        await reopened.destroy();
      }
      const withoutJournal = new NodeKernelHost({ rootfsImage: new Uint8Array(readFileSync(snapshotPath)) });
      try {
        const kernelBytes = new Uint8Array(readFileSync(kernelPath!));
        await withoutJournal.init(kernelBytes.buffer.slice(
          kernelBytes.byteOffset,
          kernelBytes.byteOffset + kernelBytes.byteLength,
        ) as ArrayBuffer);
        expect(new TextDecoder().decode((await withoutJournal.readFileFromVfs("/state"))!)).toBe("SNAP");
        expect(new TextDecoder().decode((await withoutJournal.readFileFromVfs("/created"))!)).toBe("created");
        const { exit } = await withoutJournal.spawnFromVfs(guestProgramName, ["persistence-overwrite", "verify-fifo"]);
        expect(await exit).toBe(0);
        const socket = await withoutJournal.spawnFromVfs(guestProgramName, ["persistence-overwrite", "verify-socket"]);
        expect(await socket.exit).toBe(0);
      } finally {
        await withoutJournal.destroy();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it.skipIf(guestProgramPath === null)("reopens sparse image and created files across namespace changes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-resizable-rootfs-"));
    const path = join(directory, "machine.journal");
    try {
      const image = await makeImage("abcdefgh");
      for (const mode of ["resize", "verify-resize", "verify-zero", "rename-state", "verify-rename", "unlink-state", "verify-unlink", "create-file", "verify-created", "verify-created-shrunk", "verify-created-link", "create-symlink", "verify-symlink", "verify-symlink-moved", "create-tree", "verify-tree", "verify-tree-moved", "verify-tree-removed", "set-metadata", "verify-metadata", "replace-open", "verify-replacement", "create-fifo", "verify-fifo", "create-socket", "verify-socket"] as const) {
        const host = await boot(image, path, true);
        try {
          const { exit } = await host.spawnFromVfs(guestProgramName, ["persistence-overwrite", mode]);
          expect(await exit).toBe(0);
        } finally {
          await host.destroy();
        }
        if (mode === "resize") {
          expect(readFileSync(path).byteLength).toBeLessThan(10_000);
          await expect(boot(image, path)).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
        }
      }
      expect(readFileSync(path).byteLength).toBeLessThan(64 * 1024);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it.skipIf(guestProgramPath === null)("rejects an authenticated but invalid index and falls back from a torn slot", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-fixed-rootfs-slot-"));
    const path = join(directory, "machine.journal");
    try {
      const image = await makeImage("abcdefgh");
      const host = await boot(image, path);
      try {
        const { exit } = await host.spawnFromVfs(guestProgramName, ["persistence-overwrite"]);
        expect(await exit).toBe(0);
      } finally {
        await host.destroy();
      }
      copyFileSync(path, `${path}.g0.journal`);
      copyFileSync(path, `${path}.g1.journal`);
      writeFileSync(`${path}.g0.journal`, readFileSync(path).subarray(0, 72));
      const backend = new HostFileSystem(directory);
      const digest = new Uint8Array(createHash("sha256").update(image).digest());
      for (const [slot, generation] of [["g0", 1], ["g1", 2]] as const) {
        const journal = OverlayStorageFile.open(backend, `/machine.journal.${slot}.journal`, false);
        const seal = OverlayStorageFile.open(backend, `/machine.journal.${slot}.seal`);
        const index = slot === "g1"
          ? OverlayStorageFile.open(backend, `/machine.journal.${slot}.index`)
          : null;
        try {
          index?.writeAllAt(0, Uint8Array.of(1, 2, 3));
          await writeOverlayGenerationSeal(journal, seal, generation, digest, index ?? undefined);
        } finally {
          index?.close();
          seal.close();
          journal.close();
        }
      }
      const legacy = readFileSync(path);
      writeFileSync(path, Buffer.from("damaged legacy"));
      const latest = await boot(image, path);
      try {
        expect(new TextDecoder().decode((await latest.readFileFromVfs("/state"))!)).toBe("abcdefgh");
      } finally {
        await latest.destroy();
      }
      const goodIndex = readFileSync(`${path}.g1.index`);
      const damagedIndex = Buffer.from(goodIndex);
      damagedIndex[0] ^= 1;
      writeFileSync(`${path}.g1.index`, damagedIndex);
      const priorIndex = await boot(image, path);
      try {
        expect(new TextDecoder().decode((await priorIndex.readFileFromVfs("/state"))!)).toBe("abcdefgh");
      } finally {
        await priorIndex.destroy();
      }
      writeFileSync(`${path}.g1.index`, goodIndex);
      writeFileSync(`${path}.g1.seal`, Buffer.from("torn"));
      const prior = await boot(image, path);
      try {
        expect(new TextDecoder().decode((await prior.readFileFromVfs("/state"))!)).toBe("abcdefgh");
      } finally {
        await prior.destroy();
      }
      writeFileSync(`${path}.g0.seal`, Buffer.from("torn"));
      await expect(boot(image, path)).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
      writeFileSync(path, new Uint8Array());
      await expect(boot(image, path)).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
      expect(readFileSync(path).byteLength).toBe(0);
      writeFileSync(path, legacy);
      const fallback = await boot(image, path);
      await fallback.destroy();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it.skipIf(guestProgramPath === null)("falls back from a sealed but semantically invalid resizable generation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-resizable-fallback-"));
    const path = join(directory, "machine.journal");
    try {
      const image = await makeImage("abcdefgh");
      const first = await boot(image, path, true);
      try {
        const { exit } = await first.spawnFromVfs(guestProgramName, ["persistence-overwrite"]);
        expect(await exit).toBe(0);
      } finally {
        await first.destroy();
      }
      const committed = readFileSync(path);
      writeFileSync(`${path}.g0.journal`, committed.subarray(0, 72));
      copyFileSync(path, `${path}.g1.journal`);
      const backend = new HostFileSystem(directory);
      const digest = new Uint8Array(createHash("sha256").update(image).digest());
      for (const [slot, generation] of [["g0", 1], ["g1", 2]] as const) {
        const journal = OverlayStorageFile.open(backend, `/machine.journal.${slot}.journal`, false);
        const seal = OverlayStorageFile.open(backend, `/machine.journal.${slot}.seal`);
        const index = slot === "g1"
          ? OverlayStorageFile.open(backend, `/machine.journal.${slot}.index`)
          : null;
        try {
          index?.writeAllAt(0, Uint8Array.of(1, 2, 3));
          await writeOverlayGenerationSeal(journal, seal, generation, digest, index ?? undefined);
        } finally {
          index?.close();
          seal.close();
          journal.close();
        }
      }
      writeFileSync(path, Buffer.from("damaged legacy"));
      const recovered = await boot(image, path, true);
      try {
        expect(new TextDecoder().decode((await recovered.readFileFromVfs("/state"))!)).toBe("abcdefgh");
      } finally {
        await recovered.destroy();
      }
      writeFileSync(`${path}.g0.seal`, Buffer.from("torn"));
      await expect(boot(image, path, true)).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it.skipIf(guestProgramPath === null)("compacts an oversized journal before serving the computer", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-fixed-rootfs-compact-"));
    const path = join(directory, "machine.journal");
    try {
      const image = await makeImage("abcdefgh");
      const first = await boot(image, path);
      try {
        const { exit } = await first.spawnFromVfs(guestProgramName, ["persistence-overwrite"]);
        expect(await exit).toBe(0);
      } finally {
        await first.destroy();
      }
      const sourceLength = expandJournalToCompactionThreshold(path);
      const compacted = await boot(image, path);
      try {
        expect(new TextDecoder().decode((await compacted.readFileFromVfs("/state"))!)).toBe("XYcdefgh");
      } finally {
        await compacted.destroy();
      }
      expect(readFileSync(path).byteLength).toBe(sourceLength);
      expect(existsSync(`${path}.g0.seal`)).toBe(true);
      expect(existsSync(`${path}.g0.index`)).toBe(true);
      expect(readFileSync(`${path}.g0.seal`).readUInt32LE(4)).toBe(2);
      expect(readFileSync(`${path}.g0.journal`).byteLength).toBeLessThan(sourceLength / 2);
      const firstSlotLength = expandJournalToCompactionThreshold(`${path}.g0.journal`);
      const reopened = await boot(image, path);
      try {
        expect(new TextDecoder().decode((await reopened.readFileFromVfs("/state"))!)).toBe("XYcdefgh");
      } finally {
        await reopened.destroy();
      }
      expect(readFileSync(`${path}.g0.journal`).byteLength).toBe(firstSlotLength);
      expect(existsSync(`${path}.g1.seal`)).toBe(true);
      expect(existsSync(`${path}.g1.index`)).toBe(true);
      expect(readFileSync(`${path}.g1.seal`).readUInt32LE(4)).toBe(2);
      expect(readFileSync(`${path}.g1.journal`).byteLength).toBeLessThan(firstSlotLength / 2);
      const secondSlot = await boot(image, path);
      await secondSlot.destroy();
      expect(readFileSync(`${path}.g1.journal`).byteLength).toBeLessThan(firstSlotLength / 2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it("boots read-only, rejects incompatible images and concurrent writers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-fixed-rootfs-"));
    const path = join(directory, "machine.journal");
    try {
      const image = await makeImage("abcdefgh");
      const host = await boot(image, path);
      try {
        expect(new TextDecoder().decode((await host.readFileFromVfs("/state"))!)).toBe("abcdefgh");
        await expect(host.writeFileToVfs("/state", encoder.encode("new"))).rejects.toThrow();
        await expect(host.writeFileToVfs("/new", encoder.encode("new"))).rejects.toThrow();
        await expect(boot(image, path)).rejects.toThrow();
      } finally {
        await host.destroy();
      }
      const recovered = await boot(image, path);
      try {
        expect(new TextDecoder().decode((await recovered.readFileFromVfs("/state"))!)).toBe("abcdefgh");
      } finally {
        await recovered.destroy();
      }
      await expect(boot(await makeImage("different"), path)).rejects.toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it.skipIf(guestProgramPath === null)("flushes an unsynced guest overwrite on graceful destroy", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-fixed-rootfs-"));
    const path = join(directory, "machine.journal");
    try {
      const image = await makeImage("abcdefgh");
      const host = await boot(image, path);
      try {
        const { exit } = await host.spawnFromVfs(guestProgramName, ["persistence-overwrite", "unsynced"]);
        expect(await exit).toBe(0);
        expect(new TextDecoder().decode((await host.readFileFromVfs("/state"))!)).toBe("XYcdefgh");
      } finally {
        await host.destroy();
      }
      const recovered = await boot(image, path);
      try {
        expect(new TextDecoder().decode((await recovered.readFileFromVfs("/state"))!)).toBe("XYcdefgh");
      } finally {
        await recovered.destroy();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it.skipIf(guestProgramPath === null)("replays a guest write larger than the bounded dirty cache", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-fixed-rootfs-large-"));
    const path = join(directory, "machine.journal");
    try {
      const image = await makeImage("abcdefgh", true);
      const first = await boot(image, path);
      try {
        const { exit } = await first.spawnFromVfs(guestProgramName, ["persistence-overwrite", "large"]);
        expect(await exit).toBe(0);
      } finally {
        await first.destroy();
      }
      const reopened = await boot(image, path);
      try {
        const actual = await reopened.readFileFromVfs("/large");
        expect(actual?.byteLength).toBe(largeWriteBytes + 4096);
        const expected = new Uint8Array(largeWriteBytes + 4096);
        for (let index = 0; index < largeWriteBytes; index++) {
          expected[index + 13] = ((index / 4096) ^ index) & 0xff;
        }
        expect(actual).toEqual(expected);
      } finally {
        await reopened.destroy();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it.skipIf(guestProgramPath === null)("checkpoints 8192 distinct dirty blocks and reopens them through the index", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-fixed-rootfs-many-blocks-"));
    const path = join(directory, "machine.journal");
    try {
      const image = await makeImage("abcdefgh", true, 32 * 1024 * 1024);
      const first = await boot(image, path);
      try {
        const { exit } = await first.spawnFromVfs(guestProgramName, ["persistence-overwrite", "many"]);
        expect(await exit).toBe(0);
        await vi.waitFor(() => expect(readFileSync(`${path}.g0.seal`).byteLength).toBeGreaterThan(96), {
          timeout: 60_000,
          interval: 100,
        });
        expect(readFileSync(`${path}.g0.index`).readBigUInt64LE(80)).toBe(8192n);
      } finally {
        await first.destroy();
      }
      const reopened = await boot(image, path);
      try {
        const { exit } = await reopened.spawnFromVfs(guestProgramName, ["persistence-overwrite", "verify-many"]);
        expect(await exit).toBe(0);
      } finally {
        await reopened.destroy();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);

  it.skipIf(guestProgramPath === null)("compacts resizable data without retaining a closed orphan", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-resizable-orphan-"));
    const path = join(directory, "machine.journal");
    try {
      const image = await makeImage("abcdefgh", true, 32 * 1024 * 1024);
      const first = await boot(image, path, true);
      try {
        const { exit } = await first.spawnFromVfs(guestProgramName, ["persistence-overwrite", "orphan-many"]);
        expect(await exit).toBe(0);
        await vi.waitFor(() => expect(readFileSync(`${path}.g0.seal`).byteLength).toBeGreaterThan(96), {
          timeout: 60_000,
          interval: 100,
        });
        expect(readFileSync(`${path}.g0.index`).readBigUInt64LE(80)).toBe(8192n);
      } finally {
        await first.destroy();
      }
      const reopened = await boot(image, path, true);
      try {
        const { exit } = await reopened.spawnFromVfs(guestProgramName, ["persistence-overwrite", "verify-orphan-many"]);
        expect(await exit).toBe(0);
      } finally {
        await reopened.destroy();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);

  it.skipIf(guestProgramPath === null)("keeps an open-unlinked file readable through live compaction", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-resizable-open-orphan-"));
    const path = join(directory, "machine.journal");
    try {
      const image = await makeImage("abcdefgh", true, 32 * 1024 * 1024);
      const first = await boot(image, path, true);
      try {
        const guest = await first.spawnFromVfs(guestProgramName, ["persistence-overwrite", "open-orphan-many"]);
        await vi.waitFor(() => expect(readFileSync(`${path}.g0.seal`).byteLength).toBeGreaterThan(96), {
          timeout: 60_000,
          interval: 100,
        });
        expect(readFileSync(`${path}.g0.index`).readBigUInt64LE(80)).toBe(8193n);
        await first.writeFileToVfs("/release", Uint8Array.of(1));
        expect(await guest.exit).toBe(0);
        const next = await first.spawnFromVfs(guestProgramName, ["persistence-overwrite", "many"]);
        expect(await next.exit).toBe(0);
        await vi.waitFor(() => expect(readFileSync(`${path}.g1.seal`).byteLength).toBeGreaterThan(96), {
          timeout: 60_000,
          interval: 100,
        });
        expect(readFileSync(`${path}.g1.index`).readBigUInt64LE(80)).toBe(8192n);
      } finally {
        await first.destroy();
      }
      const reopened = await boot(image, path, true);
      try {
        const { exit } = await reopened.spawnFromVfs(guestProgramName, ["persistence-overwrite", "verify-orphan-many"]);
        expect(await exit).toBe(0);
      } finally {
        await reopened.destroy();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);

  it.skipIf(guestProgramPath === null)("compacts an indexed journal twice while guests keep writing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-fixed-rootfs-live-"));
    const path = join(directory, "machine.journal");
    try {
      const image = await makeImage("abcdefgh", true);
      const host = await boot(image, path);
      try {
        for (const slot of ["g0", "g1"] as const) {
          for (let iteration = 0; iteration < 17; iteration++) {
            const { exit } = await host.spawnFromVfs(guestProgramName, ["persistence-overwrite", "large"]);
            expect(await exit).toBe(0);
          }
          await vi.waitFor(() => expect(readFileSync(`${path}.${slot}.seal`).byteLength).toBeGreaterThan(96), {
            timeout: 30_000,
            interval: 100,
          });
          expect(readFileSync(`${path}.${slot}.seal`).readUInt32LE(4)).toBe(2);
          expect(existsSync(`${path}.${slot}.index`)).toBe(true);
        }
      } finally {
        await host.destroy();
      }
      const recovered = await boot(image, path);
      try {
        const actual = await recovered.readFileFromVfs("/large");
        expect(actual?.byteLength).toBe(largeWriteBytes + 4096);
        expect(actual?.[13]).toBe(0);
        expect(actual?.[4096 + 13]).toBe(1);
      } finally {
        await recovered.destroy();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);

  it.skipIf(guestProgramPath === null)("replays a guest overwrite after a worker restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-fixed-rootfs-"));
    const path = join(directory, "machine.journal");
    try {
      const image = await makeImage("abcdefgh");
      const host = await boot(image, path);
      try {
        const { exit } = await host.spawnFromVfs(guestProgramName, ["persistence-overwrite"]);
        expect(await exit).toBe(0);
        expect(new TextDecoder().decode((await host.readFileFromVfs("/state"))!)).toBe("XYcdefgh");
      } finally {
        await host.destroy();
      }
      const recovered = await boot(image, path);
      try {
        expect(new TextDecoder().decode((await recovered.readFileFromVfs("/state"))!)).toBe("XYcdefgh");
      } finally {
        await recovered.destroy();
      }
      const committed = readFileSync(path);
      const transaction = Buffer.from(committed.subarray(72));
      transaction.writeBigUInt64LE(2n, 8);
      createHash("sha256")
        .update(transaction.subarray(0, transaction.length - 36))
        .digest()
        .copy(transaction, transaction.length - 36);
      const cuts = [0, 1, 23, 24, 59, 60, 100, Math.floor(transaction.length / 2), transaction.length - 1];
      for (const cut of cuts) {
        writeFileSync(path, Buffer.concat([committed, transaction.subarray(0, cut)]));
        const afterTail = await boot(image, path);
        try {
          expect(new TextDecoder().decode((await afterTail.readFileFromVfs("/state"))!), `cut ${cut}`).toBe("XYcdefgh");
        } finally {
          await afterTail.destroy();
        }
        expect(readFileSync(path), `cut ${cut}`).toEqual(committed);
      }
      const damaged = readFileSync(path);
      damaged[damaged.length - 37] ^= 1;
      writeFileSync(path, damaged);
      await expect(boot(image, path)).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
      expect(readFileSync(path)).toEqual(damaged);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);
});
