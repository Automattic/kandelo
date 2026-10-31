import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { tryResolveBinary } from "../src/binary-resolver";
import {
  ABI_SYSCALLS, CH_ARGS, CH_ARG_SIZE, CH_ARGS_COUNT, CH_ERRNO, CH_RETURN,
  CH_STATUS, CH_SYSCALL, CHANNEL_STATUS_COMPLETE, CHANNEL_STATUS_PENDING, ERRNO,
} from "../src/generated/abi";
import { CAPTURED_STDIO, CentralizedKernelWorker, createCentralizedKernelWorkerTestDouble } from "../src/kernel-worker";
import { NodeKernelHost } from "../src/node-kernel-host";
import { NodePlatformIO } from "../src/platform/node";
import { configureRootfsOverlayFromImage } from "../src/process-lifecycle";
import { HostFileSystem } from "../src/vfs/host-fs";
import { OverlayStorageFile, type PersistentOverlayStorage } from "../src/vfs/overlay-storage";
import { verifyOverlayGenerationSeal, writeOverlayGenerationSeal } from "./fixtures/native-overlay-activation";
import { NoValidOverlayGenerationError } from "../src/vfs/overlay-generation-selection";
import { decodeOverlayActivation, encodeOverlayActivation } from "./fixtures/native-overlay-activation";
import { appendUnusedBlockTombstones } from "./fixtures/journal-block-tombstones";

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
const crashWriterPath = join(import.meta.dirname, "fixtures/persistent-rootfs-crash-writer.ts");
const tsxLoaderPath = join(import.meta.dirname, "../node_modules/tsx/dist/loader.mjs");
const encoder = new TextEncoder();

const largeWriteBytes = 2 * 1024 * 1024;

it("reclaims a native export plan after a real destination-write failure without destroying the kernel", async () => {
  if (kernelPath === null) throw new Error("Current ABI-matched kernel is required");
  const directory = mkdtempSync(join(tmpdir(), "kandelo-export-cancel-"));
  let worker: Worker | undefined;
  try {
    const fixtureUrl = pathToFileURL(join(import.meta.dirname, "fixtures/export-cancellation-worker.ts")).href;
    const tsxApiUrl = pathToFileURL(join(import.meta.dirname, "../node_modules/tsx/dist/esm/api/index.mjs")).href;
    const kernelBytes = readFileSync(kernelPath);
    worker = new Worker(`import { register } from ${JSON.stringify(tsxApiUrl)}; register(); await import(${JSON.stringify(fixtureUrl)});`, {
      eval: true, workerData: { image: await makeImage("abcdefgh"),
        kernelWasm: kernelBytes.buffer.slice(kernelBytes.byteOffset, kernelBytes.byteOffset + kernelBytes.byteLength),
        destination: join(directory, "readonly-output") },
    });
    const result = await new Promise<Record<string, any>>((resolve, reject) => {
      worker!.once("message", resolve);
      worker!.once("error", reject);
      worker!.once("exit", code => reject(new Error(`export-cancellation worker exited before reporting (${code})`)));
    });
    expect(result.unexpected).toBeUndefined();
    expect(result.code).toBe("EBADF");
    expect(result.afterFailure).toBe(result.baseline);
    expect(result.afterSuccess).toBe(result.beforeSuccess);
    expect(result.length).toBeGreaterThan(1024 * 1024);
    expect(result.visible).toBe("usable");
  } finally { await worker?.terminate(); rmSync(directory, { recursive: true, force: true }); }
});

function removeFixtureActivationControls(path: string): void {
  for (const replica of [0, 1]) rmSync(`${path}.activation${replica}`, { force: true });
}

function refreshFixtureControlSeal(path: string, slot: `g${number}`): void {
  const current = decodeOverlayActivation(readFileSync(`${path}.activation0`));
  expect(current.slot).toBe(slot);
  const bytes = encodeOverlayActivation({ ...current,
    sealDigest: new Uint8Array(createHash("sha256").update(readFileSync(`${path}.${slot}.seal`)).digest()),
  });
  for (const replica of [0, 1]) writeFileSync(`${path}.activation${replica}`, bytes);
}

async function makeImage(state: string, includeLargeFile = false, largeFileBytes = largeWriteBytes + 4096, includeDenseSnapshotFile = false): Promise<Uint8Array> {
  const filesystem = KandeloImageFs.create(new Uint8Array(readFileSync(imageModulePath!)));
  if (guestProgramPath !== null) {
    filesystem.mkdir("/bin", 0o755);
    filesystem.writeFile(guestProgramName, new Uint8Array(readFileSync(guestProgramPath)), 0o755);
  }
  filesystem.writeFile("/state", encoder.encode(state), 0o644);
  if (includeLargeFile) filesystem.writeFile("/large", new Uint8Array(largeFileBytes), 0o644);
  if (includeDenseSnapshotFile) filesystem.writeFile("/snapshot-dense-base", encoder.encode("original"), 0o644);
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

function expandLargestJournalTransactionToCompactionThreshold(path: string, requireCompaction = false): number {
  const original = readFileSync(path);
  let position = 72;
  let sequence = 0n;
  let largestTransaction: Buffer | null = null;
  while (position < original.byteLength) {
    const length = original.readUInt32LE(position + 4);
    expect(length).toBeGreaterThanOrEqual(60);
    expect(position + length).toBeLessThanOrEqual(original.byteLength);
    if (largestTransaction === null || length > largestTransaction.byteLength) {
      largestTransaction = Buffer.from(original.subarray(position, position + length));
    }
    position += length;
    sequence++;
  }
  expect(largestTransaction).not.toBeNull();
  const transaction = largestTransaction!;
  const minimumSize = 32 * 1024 * 1024 + (requireCompaction ? original.byteLength : 0);
  const count = Math.ceil((minimumSize - original.byteLength) / transaction.byteLength) + 1;
  const repeated = Buffer.allocUnsafe(count * transaction.byteLength);
  for (let index = 0; index < count; index++) {
    const offset = index * transaction.byteLength;
    transaction.copy(repeated, offset);
    repeated.writeBigUInt64LE(++sequence, offset + 8);
    createHash("sha256")
      .update(repeated.subarray(offset, offset + transaction.byteLength - 36))
      .digest()
      .copy(repeated, offset + transaction.byteLength - 36);
  }
  writeFileSync(path, Buffer.concat([original, repeated]));
  return original.byteLength + repeated.byteLength;
}

class FaultingMemoryOverlayStorage implements PersistentOverlayStorage {
  bytes = new Uint8Array();
  fault: "write" | "partial" | "flush" | null = null;

  len(): number { return this.bytes.byteLength; }

  readExactAt(offset: number | bigint, destination: Uint8Array): void {
    const start = Number(offset);
    if (start + destination.byteLength > this.bytes.byteLength) throw new Error("short overlay read");
    destination.set(this.bytes.subarray(start, start + destination.byteLength));
  }

  writeAllAt(offset: number | bigint, source: Uint8Array): void {
    if (this.fault === "write") throw Object.assign(new Error("journal quota exceeded"), { code: "ENOSPC" });
    const start = Number(offset);
    const length = this.fault === "partial" ? Math.min(128, source.byteLength) : source.byteLength;
    const end = start + length;
    if (end > this.bytes.byteLength) {
      const grown = new Uint8Array(end);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes.set(source.subarray(0, length), start);
    if (this.fault === "partial") throw Object.assign(new Error("journal quota exceeded"), { code: "ENOSPC" });
  }

  flush(): void {
    if (this.fault === "flush") throw Object.assign(new Error("journal quota exceeded"), { code: "ENOSPC" });
  }

  truncate(length: number | bigint): void {
    const resized = new Uint8Array(Number(length));
    resized.set(this.bytes.subarray(0, resized.byteLength));
    this.bytes = resized;
  }

  close(): void {}
}

class FaultingNodeFileSystem extends HostFileSystem {
  fault: "write" | "short-write" | "flush" | null = null;
  partialWrites = 0;

  override write(...args: Parameters<HostFileSystem["write"]>): number {
    if (this.fault === "write") throw Object.assign(new Error("journal quota exceeded"), { code: "ENOSPC" });
    if (this.fault === "short-write") {
      if (this.partialWrites > 0) throw Object.assign(new Error("journal quota exceeded"), { code: "ENOSPC" });
      this.partialWrites++;
      return super.write(args[0], args[1], args[2], Math.min(128, args[3]));
    }
    return super.write(...args);
  }

  override fsync(handle: number): void {
    if (this.fault === "flush") throw Object.assign(new Error("journal quota exceeded"), { code: "ENOSPC" });
    super.fsync(handle);
  }
}

describe.skipIf(kernelPath === null || imageModulePath === null)("fixed rootfs persistence", () => {
  for (const scenario of [
    { label: "enforces metadata quota without losing the journal and recovers at the same budget",
      budget: 65536, createMode: "metadata-quota", verifyMode: "verify-metadata-quota" },
    { label: "reuses base directory-name credits for same-budget rename recovery and checkpoint",
      budget: 80 * 1024, createMode: "rename-metadata", verifyMode: "verify-rename-metadata" },
    { label: "bounds unlinked inode-history recovery by the live tree at the same metadata budget",
      budget: 65536, createMode: "inode-history", verifyMode: "verify-inode-history" },
    { label: "bounds inactive FIFO memory and recovers reclaimed buffer quota through strict reboot and checkpoint",
      budget: 8 * 1024 * 1024, createMode: "many-fifos", verifyMode: "verify-many-fifos" },
  ]) {
    it.skipIf(guestProgramPath === null)(scenario.label, async () => {
      const started = performance.now();
      const mark = (stage: string) => {
        if (process.env.KANDELO_PERSISTENCE_TEST_TIMING === "1") console.info("metadata-quota-phase", scenario.createMode, stage, Math.round(performance.now() - started));
      };
      const directory = mkdtempSync(join(tmpdir(), "kandelo-metadata-quota-"));
      const imagePath = join(directory, "base.vfs");
      const journalPath = join(directory, "machine.journal");
      const snapshotPath = join(directory, "snapshot.vfs");
      const kernel = new Uint8Array(readFileSync(kernelPath!)).buffer as ArrayBuffer;
      const stderr: string[] = [];
      const createHost = (budget: number, requireExisting = false) => new NodeKernelHost({
        rootfsImageFile: imagePath,
        experimentalResizablePersistencePath: journalPath,
        requireExistingRootfsPersistence: requireExisting,
        kernelMaxPages: 1024,
        rootfsMetadataBytes: budget,
        onStderr: (_pid, bytes) => stderr.push(new TextDecoder().decode(bytes)),
      });
      try {
        const filesystem = KandeloImageFs.create(new Uint8Array(readFileSync(imageModulePath!)));
        filesystem.setImageCapacity(512 * 1024 * 1024);
        filesystem.mkdir("/bin", 0o755);
        filesystem.writeFile(guestProgramName, new Uint8Array(readFileSync(guestProgramPath!)), 0o755);
        filesystem.writeFile("/state", encoder.encode("abcdefgh"), 0o644);
        if (scenario.createMode === "rename-metadata") {
          for (let index = 0; index < 32; index++) {
            filesystem.writeFile(`/base-rename-${String(index).padStart(3, "0")}`, new Uint8Array(), 0o644);
          }
        }
        writeFileSync(imagePath, await filesystem.saveImage());
        mark("image-ready");
        const first = createHost(scenario.budget);
        try {
          await expect(first.init(kernel), "initial base-image boot").resolves.toBeUndefined();
          mark("first-boot");
          const { exit } = await first.spawnFromVfs(guestProgramName, ["persistence-overwrite", scenario.createMode]);
          expect(await exit, stderr.join("")).toBe(0);
          expect(new TextDecoder().decode((await first.readFileFromVfs("/state"))!)).toBe("abcdefgh");
        } finally { await first.destroy(); }
        mark("first-closed");
        const committed = readFileSync(journalPath);
        expect(committed.byteLength).toBeGreaterThan(72);
        const denied = createHost(8192, true);
        try {
          await expect(denied.init(kernel)).rejects.toThrow("errno 12");
        } finally { await denied.destroy(); }
        mark("denied-closed");
        expect(readFileSync(journalPath)).toEqual(committed);
        const recovered = createHost(scenario.budget, true);
        try {
          await expect(recovered.init(kernel), "same-budget journal recovery").resolves.toBeUndefined();
          const { exit } = await recovered.spawnFromVfs(guestProgramName, ["persistence-overwrite", scenario.verifyMode]);
          expect(await exit).toBe(0);
          expect(await recovered.getKernelMemoryPages()).toBeLessThanOrEqual(1024);
        } finally { await recovered.destroy(); }
        mark("recovered-closed");
        const exporter = createHost(scenario.budget, true);
        try {
          await exporter.init(kernel);
          await exporter.exportRootfsImageToFile(snapshotPath);
        } finally { await exporter.destroy(); }
        mark("snapshot-closed");
        const checkpoint = new NodeKernelHost({ rootfsImageFile: snapshotPath, kernelMaxPages: 1024, rootfsMetadataBytes: scenario.budget });
        try {
          await checkpoint.init(kernel);
          const { exit } = await checkpoint.spawnFromVfs(guestProgramName, ["persistence-overwrite", scenario.verifyMode]);
          expect(await exit).toBe(0);
        } finally { await checkpoint.destroy(); }
        mark("checkpoint-closed");
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }, scenario.createMode === "metadata-quota" ? 5_000 : 180_000);
  }

  it("reports image metadata exhaustion without an unrelated format-rebuild hint", async () => {
    const diagnostics: string[] = [];
    const host = new NodeKernelHost({ rootfsImage: await makeImage("abcdefgh"), rootfsMetadataBytes: 4096,
      onHostDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message) });
    try {
      const failure = await host.init(new Uint8Array(readFileSync(kernelPath!)).buffer as ArrayBuffer)
        .then(() => null, (error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("errno 12");
      expect((failure as Error).message).toContain("metadata budget");
      expect((failure as Error).message).not.toContain("must be rebuilt");
      expect(diagnostics.some((message) => message.includes("fatal kernel instance failure"))).toBe(false);
    } finally { await host.destroy(); }
  });

  it.each([undefined, "https://assets.example.test/release/"])("recovers a resizable journal against a positioned Node image file with lazy directory %s", async rootfsLazyAssetDirectory => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-positioned-persistence-"));
    const imagePath = join(directory, "base.vfs");
    const journalPath = join(directory, "machine.journal");
    try {
      const baseImage = await makeImage("abcdefgh");
      writeFileSync(imagePath, baseImage);
      const kernelBytes = new Uint8Array(readFileSync(kernelPath!));
      const kernel = kernelBytes.buffer.slice(
        kernelBytes.byteOffset,
        kernelBytes.byteOffset + kernelBytes.byteLength,
      ) as ArrayBuffer;
      const first = new NodeKernelHost({
        rootfsImageFile: imagePath,
        rootfsLazyAssetDirectory,
        experimentalResizablePersistencePath: journalPath,
      });
      try {
        await first.init(kernel);
        await first.writeFileToVfs("/state", encoder.encode("position"));
      } finally {
        await first.destroy();
      }
      const reopened = new NodeKernelHost({
        rootfsImageFile: imagePath,
        rootfsLazyAssetDirectory,
        experimentalResizablePersistencePath: journalPath,
        requireExistingRootfsPersistence: true,
      });
      try {
        await reopened.init(kernel);
        expect(new TextDecoder().decode((await reopened.readFileFromVfs("/state"))!)).toBe("position");
      } finally {
        await reopened.destroy();
      }
      writeFileSync(imagePath, await makeImage("different"));
      const incompatible = new NodeKernelHost({
        rootfsImageFile: imagePath,
        rootfsLazyAssetDirectory,
        experimentalResizablePersistencePath: journalPath,
        requireExistingRootfsPersistence: true,
      });
      try {
        await expect(incompatible.init(kernel)).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
      } finally {
        await incompatible.destroy();
      }
      writeFileSync(imagePath, baseImage);
      const restored = new NodeKernelHost({
        rootfsImageFile: imagePath,
        rootfsLazyAssetDirectory,
        experimentalResizablePersistencePath: journalPath,
        requireExistingRootfsPersistence: true,
      });
      try {
        await restored.init(kernel);
        expect(new TextDecoder().decode((await restored.readFileFromVfs("/state"))!)).toBe("position");
      } finally {
        await restored.destroy();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("boots an extended VFSI container through the Node kernel host", async () => {
    const original = await makeImage("abcdefgh");
    const bodyLength = new DataView(original.buffer, original.byteOffset, original.byteLength).getUint32(12, true);
    const extended = new Uint8Array(original.byteLength + 8);
    extended.set(original.subarray(0, 12));
    const header = new DataView(extended.buffer);
    header.setUint32(4, 2, true);
    header.setUint32(12, 24, true);
    header.setBigUint64(16, BigInt(bodyLength), true);
    extended.set(original.subarray(16), 24);
    const host = new NodeKernelHost({ rootfsImage: extended });
    const kernelBytes = new Uint8Array(readFileSync(kernelPath!));
    try {
      await host.init(kernelBytes.buffer.slice(
        kernelBytes.byteOffset,
        kernelBytes.byteOffset + kernelBytes.byteLength,
      ) as ArrayBuffer);
      expect(new TextDecoder().decode((await host.readFileFromVfs("/state"))!)).toBe("abcdefgh");
    } finally {
      await host.destroy();
    }
  });

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

  it.skipIf(guestProgramPath === null).each(
    (["fixed", "resizable"] as const).flatMap((persistenceMode) =>
      (["synced", "unsynced"] as const).map((writeMode) => [persistenceMode, writeMode] as const)),
  )("recovers %s %s guest state after SIGKILL without shutdown", async (persistenceMode, writeMode) => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-rootfs-crash-"));
    const imagePath = join(directory, "base.vfs");
    const journalPath = join(directory, "machine.journal");
    const image = await makeImage("abcdefgh");
    writeFileSync(imagePath, image);
    const child = spawn(process.execPath, [
      "--import", tsxLoaderPath, crashWriterPath,
      imagePath, journalPath, kernelPath!, writeMode, persistenceMode,
    ], {
      cwd: join(import.meta.dirname, "../.."),
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let diagnostics = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { diagnostics += chunk; });
    const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
      child.once("exit", (code, signal) => resolve([code, signal]));
      child.once("error", reject);
    });
    void exited.catch(() => {});
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`crash writer did not finish guest: ${diagnostics}`)), 60_000);
        child.once("message", (message) => {
          clearTimeout(timer);
          if (message === "guest-exited") resolve();
          else reject(new Error(`unexpected crash writer message: ${String(message)}`));
        });
        child.once("exit", (code, signal) => {
          clearTimeout(timer);
          reject(new Error(`crash writer exited before guest completion (${code}, ${signal}): ${diagnostics}`));
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      expect(child.kill("SIGKILL")).toBe(true);
      const [code, signal] = await exited;
      expect([code, signal]).toEqual([null, "SIGKILL"]);
      const reopened = await boot(image, journalPath, persistenceMode === "resizable", true);
      try {
        const state = new TextDecoder().decode((await reopened.readFileFromVfs("/state"))!);
        expect(state).toBe(writeMode === "synced" ? "XYcdefgh" : "abcdefgh");
      } finally {
        await reopened.destroy();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await exited.catch(() => {});
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it("refuses an unowned legacy directory lock until explicitly migrated", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-legacy-overlay-lock-"));
    const path = join(directory, "machine.journal");
    const lockPath = `${path}.lock`;
    try {
      const image = await makeImage("abcdefgh");
      mkdirSync(lockPath);
      await expect(boot(image, path, true)).rejects.toThrow(/legacy or invalid lock/);
      expect(lstatSync(lockPath).isDirectory()).toBe(true);
      rmdirSync(lockPath);
      const first = await boot(image, path, true);
      await first.destroy();
      expect(lstatSync(lockPath).isFile()).toBe(true);
      const reopened = await boot(image, path, true, true);
      await reopened.destroy();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a dangling symlink lock without creating its target", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-overlay-symlink-lock-"));
    const path = join(directory, "machine.journal");
    const target = join(directory, "missing-target");
    try {
      symlinkSync(target, `${path}.lock`);
      await expect(boot(await makeImage("abcdefgh"), path, true)).rejects.toThrow(/legacy or invalid lock/);
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a lock hard-linked to journal data before opening SQLite", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-overlay-aliased-lock-"));
    const path = join(directory, "machine.journal");
    const image = await makeImage("abcdefgh");
    try {
      const first = await boot(image, path, true);
      await first.destroy();
      unlinkSync(`${path}.lock`);
      const journalBefore = readFileSync(path);
      linkSync(path, `${path}.lock`);
      await expect(boot(image, path, true, true)).rejects.toThrow(/legacy or invalid lock/);
      expect(readFileSync(path)).toEqual(journalBefore);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a hard-linked journal alias rather than admitting a second writer", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-overlay-hardlink-"));
    const path = join(directory, "machine.journal");
    const alias = join(directory, "alias.journal");
    const image = await makeImage("abcdefgh");
    try {
      const first = await boot(image, path, true);
      try {
        linkSync(path, alias);
        await expect(boot(image, alias, true, true)).rejects.toThrow(/multiple hard links/);
        expect(new TextDecoder().decode((await first.readFileFromVfs("/state"))!)).toBe("abcdefgh");
      } finally {
        await first.destroy();
      }
      await expect(boot(image, path, true, true)).rejects.toThrow(/multiple hard links/);
      unlinkSync(alias);
      const reopened = await boot(image, path, true, true);
      try {
        expect(new TextDecoder().decode((await reopened.readFileFromVfs("/state"))!)).toBe("abcdefgh");
      } finally {
        await reopened.destroy();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(guestProgramPath === null)("refuses a concurrent writer in another Node process", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-overlay-cross-process-lock-"));
    const imagePath = join(directory, "base.vfs");
    const journalPath = join(directory, "machine.journal");
    const image = await makeImage("abcdefgh");
    writeFileSync(imagePath, image);
    try {
      const first = await boot(image, journalPath, true);
      try {
        const contender = spawnSync(process.execPath, [
          "--import", tsxLoaderPath, crashWriterPath,
          imagePath, journalPath, kernelPath!, "synced", "resizable",
        ], {
          cwd: join(import.meta.dirname, "../.."),
          encoding: "utf8",
          timeout: 30_000,
        });
        expect(contender.error).toBeUndefined();
        expect(contender.status, contender.stderr).toBe(1);
        expect(contender.stderr).toContain("database is locked");
        const { exit } = await first.spawnFromVfs(guestProgramName, ["persistence-overwrite"]);
        expect(await exit).toBe(0);
      } finally {
        await first.destroy();
      }
      const reopened = await boot(image, journalPath, true, true);
      try {
        expect(new TextDecoder().decode((await reopened.readFileFromVfs("/state"))!)).toBe("XYcdefgh");
      } finally {
        await reopened.destroy();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it.skipIf(guestProgramPath === null).each([
    { label: "fixed injected refusal", mode: "fixed", tombstones: 0 },
    { label: "resizable injected refusal", mode: "resizable", tombstones: 0 },
    { label: "resizable admitted replay", mode: "resizable", tombstones: 65_000 },
    { label: "resizable proactive pressure", mode: "resizable", tombstones: 30_000 },
  ] as const)("converts a memory-limited small journal ($label) through Rust and reopens later guest writes", async ({ mode, tombstones }) => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-memory-recovery-"));
    const path = join(directory, "overlay.journal");
    try {
      const image = await makeImage("abcdefgh");
      const first = await boot(image, path, mode === "resizable");
      try {
        const { exit } = await first.spawnFromVfs(guestProgramName, ["persistence-overwrite"]);
        expect(await exit).toBe(0);
      } finally {
        await first.destroy();
      }
      if (tombstones !== 0) writeFileSync(path, await appendUnusedBlockTombstones(readFileSync(path), tombstones));
      const before = readFileSync(path);
      expect(before.byteLength).toBeGreaterThan(72);
      expect(before.byteLength).toBeLessThan(32 * 1024 * 1024);
      const fixtureUrl = pathToFileURL(join(import.meta.dirname, "fixtures/persistent-memory-recovery-worker.ts")).href;
      const tsxApiUrl = pathToFileURL(join(import.meta.dirname, "../node_modules/tsx/dist/esm/api/index.mjs")).href;
      const kernelBytes = readFileSync(kernelPath!);
      const worker = new Worker(`import { register } from ${JSON.stringify(tsxApiUrl)}; register(); await import(${JSON.stringify(fixtureUrl)});`, {
        eval: true,
        workerData: { image, path, mode, injectMemoryRefusal: tombstones === 0, reportMemory: tombstones !== 0,
          kernelWasm: kernelBytes.buffer.slice(kernelBytes.byteOffset, kernelBytes.byteOffset + kernelBytes.byteLength) },
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await new Promise((resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("memory-recovery worker timed out")), 120_000);
          worker.once("message", message => message.error === undefined ? resolve(message) : reject(new Error(message.error)));
          worker.once("error", reject);
          worker.once("exit", code => reject(new Error(`memory-recovery worker exited before its result (${code})`)));
        });
        expect(result).toMatchObject({ visible: "XYcdefgh", attempts: tombstones === 30_000 ? 1 : 2,
          conversions: tombstones === 30_000 ? 0 : 1, slot: "g0" });
        if (tombstones !== 0) {
          const memory = result as { initialMemory: { used: number; pressure: boolean }; finalMemory: { used: number; pressure: boolean }; compactions: number };
          expect(memory.initialMemory.used).toBeLessThanOrEqual(8 * 1024 * 1024);
          expect(memory.initialMemory.pressure).toBe(tombstones === 30_000);
          expect(memory.compactions).toBe(tombstones === 30_000 ? 1 : 0);
          expect(memory.finalMemory).toEqual({ used: 0, pressure: false });
          const ioMemory = (result as { ioMemory: { used: number; limit: number } }).ioMemory;
          expect(ioMemory.limit).toBe(8 * 1024 * 1024);
          expect(ioMemory.used).toBeGreaterThan(0);
          expect(ioMemory.used).toBeLessThanOrEqual(ioMemory.limit);
        }
      } finally {
        clearTimeout(timeout);
        await worker.terminate();
      }
      expect(readFileSync(path)).toEqual(before);
      expect(readFileSync(`${path}.g0.seal`).byteLength).toBeGreaterThan(96);
      const continued = await boot(image, path, mode === "resizable", true);
      try {
        expect(new TextDecoder().decode((await continued.readFileFromVfs("/state"))!)).toBe("XYcdefgh");
        const { exit } = await continued.spawnFromVfs(guestProgramName, ["persistence-overwrite", "mmap-fsync"]);
        expect(await exit).toBe(0);
      } finally {
        await continued.destroy();
      }
      const recovered = await boot(image, path, mode === "resizable", true);
      try {
        expect(new TextDecoder().decode((await recovered.readFileFromVfs("/state"))!)).toBe("MScdefgh");
      } finally {
        await recovered.destroy();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);

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

  it.each(([
    ["fixed", "write", ABI_SYSCALLS.Fsync],
    ["fixed", "flush", ABI_SYSCALLS.Fsync],
    ["fixed", "write", ABI_SYSCALLS.Fdatasync],
    ["fixed", "flush", ABI_SYSCALLS.Fdatasync],
    ["resizable", "write", ABI_SYSCALLS.Fsync],
    ["resizable", "flush", ABI_SYSCALLS.Fsync],
    ["resizable", "write", ABI_SYSCALLS.Fdatasync],
    ["resizable", "flush", ABI_SYSCALLS.Fdatasync],
  ] as const).flatMap(([mode, fault, syncSyscall]) =>
    (fault === "write" ? ["memory", "node-file", "node-short-write"] : ["memory", "node-file"])
      .map((storageKind) => [mode, fault, syncSyscall, storageKind] as const),
  ))("keeps mapped %s %s fault visible through sync syscall %s on %s storage", async (mode, fault, syncSyscall, storageKind) => {
    const image = await makeImage("abcdefgh");
    const worker = createCentralizedKernelWorkerTestDouble({
      config: { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      io: new NodePlatformIO(),
    });
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
    const directory = mkdtempSync(join(tmpdir(), "kandelo-mapped-node-fault-"));
    const sourcePath = join(directory, "source.journal");
    const backend = new FaultingNodeFileSystem(directory);
    const memoryStorage = storageKind === "memory" ? new FaultingMemoryOverlayStorage() : null;
    const storage = memoryStorage ?? OverlayStorageFile.open(backend, "/source.journal");
    if (mode === "fixed") worker.enableFixedRootfsPersistence(storage);
    else worker.enableResizableRootfsPersistence(storage);

    const memory = new WebAssembly.Memory({ initial: 32, maximum: 32, shared: true });
    const pid = worker.createProcess(CAPTURED_STDIO);
    expect(worker.setBrkBase(pid, 0x10000)).toBe(true);
    expect(worker.setMmapBase(pid, 0x20000)).toBe(true);
    const [channel] = worker.testAuthority.replaceProcessRegistrationForLifecycleTest({
      pid,
      memory,
      channelOffsets: [0x1e0000],
      pointerWidth: 4,
    });
    const issue = (syscall: number, args: readonly number[]) => {
      const view = new DataView(memory.buffer, channel.channelOffset);
      view.setUint32(CH_STATUS, CHANNEL_STATUS_PENDING, true);
      view.setUint32(CH_SYSCALL, syscall, true);
      for (let index = 0; index < CH_ARGS_COUNT; index++) {
        view.setBigInt64(CH_ARGS + index * CH_ARG_SIZE, BigInt(args[index] ?? 0), true);
      }
      worker.testAuthority.dispatchScratchBoundarySyscallForTest(channel);
      if (view.getUint32(CH_STATUS, true) !== CHANNEL_STATUS_COMPLETE) {
        throw new Error(`syscall ${syscall} did not complete`);
      }
      return { value: Number(view.getBigInt64(CH_RETURN, true)), errno: view.getUint32(CH_ERRNO, true) };
    };
    const processBytes = new Uint8Array(memory.buffer);
    processBytes.set(encoder.encode("/state\0"), 1024);
    const opened = issue(ABI_SYSCALLS.Open, [1024, 2, 0]);
    expect(opened.errno).toBe(0);
    const mapped = issue(ABI_SYSCALLS.Mmap, [0, 4096, 3, 1, opened.value, 0]);
    expect(mapped.errno).toBe(0);
    expect(mapped.value).toBeGreaterThan(0);
    processBytes.set(encoder.encode("XY"), mapped.value);

    if (memoryStorage !== null) memoryStorage.fault = fault;
    else backend.fault = storageKind === "node-short-write" ? "short-write" : fault;
    expect(issue(syncSyscall, [opened.value])).toEqual({ value: -1, errno: ERRNO.ENOSPC });
    expect(issue(ABI_SYSCALLS.Pread, [opened.value, 4096, 2, 0])).toEqual({ value: 2, errno: 0 });
    expect(new TextDecoder().decode(processBytes.subarray(4096, 4098))).toBe("XY");

    const path = join(directory, "machine.journal");
    try {
      if (storageKind === "node-short-write") {
        expect(backend.partialWrites).toBe(1);
        expect(readFileSync(sourcePath).byteLength).toBe(72 + 128);
      }
      writeFileSync(path, memoryStorage === null ? readFileSync(sourcePath) : memoryStorage.bytes);
      const reopened = await boot(image, path, mode === "resizable", true);
      try {
        const recovered = new TextDecoder().decode((await reopened.readFileFromVfs("/state"))!);
        if (fault === "write") expect(recovered).toBe("abcdefgh");
        else expect(["abcdefgh", "XYcdefgh"]).toContain(recovered);
      } finally {
        await reopened.destroy();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each((["fixed", "resizable"] as const).flatMap((mode) =>
    (["write", "partial", "flush"] as const).map((fault) => [mode, fault] as const)))
  ("keeps %s cache eviction atomic through %s fault on the Node channel", async (mode, fault) => {
    const blockBytes = 4096;
    const cachedBytes = 64 * blockBytes;
    const image = await makeImage("abcdefgh", true, cachedBytes + blockBytes);
    const worker = createCentralizedKernelWorkerTestDouble({
      config: { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      io: new NodePlatformIO(),
    });
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
    const storage = new FaultingMemoryOverlayStorage();
    if (mode === "fixed") worker.enableFixedRootfsPersistence(storage);
    else worker.enableResizableRootfsPersistence(storage);
    const memory = new WebAssembly.Memory({ initial: 32, maximum: 32, shared: true });
    const pid = worker.createProcess(CAPTURED_STDIO);
    expect(worker.setBrkBase(pid, 0x10000)).toBe(true);
    const [channel] = worker.testAuthority.replaceProcessRegistrationForLifecycleTest({
      pid,
      memory,
      channelOffsets: [0x1e0000],
      pointerWidth: 4,
    });
    const processBytes = new Uint8Array(memory.buffer);
    processBytes.set(encoder.encode("/large\0"), 1024);
    processBytes.fill(88, 4096, 4096 + cachedBytes + blockBytes);
    const issue = (syscall: number, args: readonly number[]) => {
      const view = new DataView(memory.buffer, channel.channelOffset);
      view.setUint32(CH_STATUS, CHANNEL_STATUS_PENDING, true);
      view.setUint32(CH_SYSCALL, syscall, true);
      for (let index = 0; index < CH_ARGS_COUNT; index++) {
        view.setBigInt64(CH_ARGS + index * CH_ARG_SIZE, BigInt(args[index] ?? 0), true);
      }
      worker.testAuthority.dispatchScratchBoundarySyscallForTest(channel);
      expect(view.getUint32(CH_STATUS, true)).toBe(CHANNEL_STATUS_COMPLETE);
      return { value: Number(view.getBigInt64(CH_RETURN, true)), errno: view.getUint32(CH_ERRNO, true) };
    };
    const opened = issue(ABI_SYSCALLS.Open, [1024, 2, 0]);
    expect(opened.errno).toBe(0);
    storage.fault = fault;
    expect(issue(ABI_SYSCALLS.Pwrite, [opened.value, 4096, cachedBytes + blockBytes, 0]))
      .toEqual({ value: cachedBytes, errno: 0 });
    expect(issue(ABI_SYSCALLS.Fdatasync, [opened.value])).toEqual({ value: -1, errno: ERRNO.ENOSPC });
    const live = worker.rootfsInspectFile("/large");
    expect(live.subarray(0, cachedBytes).every((byte) => byte === 88)).toBe(true);
    expect(live.subarray(cachedBytes).every((byte) => byte === 0)).toBe(true);

    const directory = mkdtempSync(join(tmpdir(), "kandelo-eviction-fault-"));
    const path = join(directory, "machine.journal");
    try {
      writeFileSync(path, storage.bytes);
      const reopened = await boot(image, path, mode === "resizable", true);
      try {
        const recovered = (await reopened.readFileFromVfs("/large"))!;
        expect(recovered).not.toBeNull();
        const oldState = recovered.every((byte) => byte === 0);
        const completeEviction = recovered.subarray(0, 16 * blockBytes).every((byte) => byte === 88)
          && recovered.subarray(16 * blockBytes).every((byte) => byte === 0);
        expect(fault === "flush" ? oldState || completeEviction : oldState).toBe(true);
      } finally {
        await reopened.destroy();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each((["rename", "link", "unlink"] as const).flatMap((operation) =>
    (["write", "flush"] as const).map((fault) => [operation, fault] as const)))
  ("does not publish a failed persistent %s through %s fault on the Node channel", async (operation, fault) => {
    const image = await makeImage("abcdefgh");
    const worker = createCentralizedKernelWorkerTestDouble({
      config: { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      io: new NodePlatformIO(),
    });
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
    const storage = new FaultingMemoryOverlayStorage();
    worker.enableResizableRootfsPersistence(storage);
    const memory = new WebAssembly.Memory({ initial: 32, maximum: 32, shared: true });
    const pid = worker.createProcess(CAPTURED_STDIO);
    expect(worker.setBrkBase(pid, 0x10000)).toBe(true);
    const [channel] = worker.testAuthority.replaceProcessRegistrationForLifecycleTest({
      pid,
      memory,
      channelOffsets: [0x1e0000],
      pointerWidth: 4,
    });
    const processBytes = new Uint8Array(memory.buffer);
    processBytes.set(encoder.encode("/state\0"), 1024);
    const target = operation === "rename" ? "/renamed" : "/quota-linked";
    processBytes.set(encoder.encode(`${target}\0`), 2048);
    storage.fault = fault;
    const view = new DataView(memory.buffer, channel.channelOffset);
    view.setUint32(CH_STATUS, CHANNEL_STATUS_PENDING, true);
    view.setUint32(CH_SYSCALL, operation === "rename" ? ABI_SYSCALLS.Rename
      : operation === "link" ? ABI_SYSCALLS.Link : ABI_SYSCALLS.Unlink, true);
    view.setBigInt64(CH_ARGS, 1024n, true);
    view.setBigInt64(CH_ARGS + CH_ARG_SIZE, 2048n, true);
    worker.testAuthority.dispatchScratchBoundarySyscallForTest(channel);
    expect(view.getUint32(CH_STATUS, true)).toBe(CHANNEL_STATUS_COMPLETE);
    expect(Number(view.getBigInt64(CH_RETURN, true))).toBe(-1);
    expect(view.getUint32(CH_ERRNO, true)).toBe(ERRNO.ENOSPC);
    expect(new TextDecoder().decode(worker.rootfsInspectFile("/state"))).toBe("abcdefgh");
    if (operation !== "unlink") expect(() => worker.rootfsInspectFile(target)).toThrow();

    const directory = mkdtempSync(join(tmpdir(), `kandelo-${operation}-fault-`));
    const path = join(directory, "machine.journal");
    try {
      writeFileSync(path, storage.bytes);
      const reopened = await boot(image, path, true, true);
      try {
        const state = await reopened.readFileFromVfs("/state");
        const targetBytes = operation === "unlink" ? null : await reopened.readFileFromVfs(target);
        if (operation === "rename") {
          expect([state, targetBytes].filter((bytes) => bytes !== null)).toHaveLength(1);
          expect(new TextDecoder().decode(state ?? targetBytes!)).toBe("abcdefgh");
        } else if (operation === "link") {
          expect(new TextDecoder().decode(state!)).toBe("abcdefgh");
          if (targetBytes !== null) expect(new TextDecoder().decode(targetBytes)).toBe("abcdefgh");
        } else if (state !== null) {
          expect(new TextDecoder().decode(state)).toBe("abcdefgh");
        }
        if (fault === "write") {
          expect(state).not.toBeNull();
          expect(targetBytes).toBeNull();
        }
        if (operation === "link" || operation === "unlink") {
          const { exit } = await reopened.spawnFromVfs(guestProgramName, [
            "persistence-overwrite", `verify-quota-${operation}`,
          ]);
          expect(await exit, `operation=${operation} fault=${fault} state=${state !== null} target=${targetBytes !== null}`).toBe(0);
        }
      } finally {
        await reopened.destroy();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["write", "flush"] as const)("keeps a failed persistent truncate invisible through %s fault on the Node channel", async (fault) => {
    const image = await makeImage("abcdefgh");
    const worker = createCentralizedKernelWorkerTestDouble({
      config: { maxWorkers: 4, dataBufferSize: 65536, useSharedMemory: true },
      io: new NodePlatformIO(),
    });
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
    const storage = new FaultingMemoryOverlayStorage();
    worker.enableResizableRootfsPersistence(storage);
    const memory = new WebAssembly.Memory({ initial: 32, maximum: 32, shared: true });
    const pid = worker.createProcess(CAPTURED_STDIO);
    expect(worker.setBrkBase(pid, 0x10000)).toBe(true);
    const [channel] = worker.testAuthority.replaceProcessRegistrationForLifecycleTest({
      pid,
      memory,
      channelOffsets: [0x1e0000],
      pointerWidth: 4,
    });
    new Uint8Array(memory.buffer).set(encoder.encode("/state\0"), 1024);
    storage.fault = fault;
    const view = new DataView(memory.buffer, channel.channelOffset);
    view.setUint32(CH_STATUS, CHANNEL_STATUS_PENDING, true);
    view.setUint32(CH_SYSCALL, ABI_SYSCALLS.Truncate, true);
    view.setBigInt64(CH_ARGS, 1024n, true);
    view.setBigInt64(CH_ARGS + CH_ARG_SIZE, 3n, true);
    worker.testAuthority.dispatchScratchBoundarySyscallForTest(channel);
    expect(view.getUint32(CH_STATUS, true)).toBe(CHANNEL_STATUS_COMPLETE);
    expect(Number(view.getBigInt64(CH_RETURN, true))).toBe(-1);
    expect(view.getUint32(CH_ERRNO, true)).toBe(ERRNO.ENOSPC);
    expect(new TextDecoder().decode(worker.rootfsInspectFile("/state"))).toBe("abcdefgh");

    const directory = mkdtempSync(join(tmpdir(), "kandelo-truncate-fault-"));
    const path = join(directory, "machine.journal");
    try {
      writeFileSync(path, storage.bytes);
      const reopened = await boot(image, path, true, true);
      try {
        const state = new TextDecoder().decode((await reopened.readFileFromVfs("/state"))!);
        expect(fault === "write" ? ["abcdefgh"] : ["abcdefgh", "abc"]).toContain(state);
      } finally {
        await reopened.destroy();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
    const repeatedSnapshotPath = join(directory, "snapshot-again.vfs");
    try {
      const image = await makeImage("abcdefgh", false, undefined, true);
      const first = await boot(image, path, true);
      try {
        await first.writeFileToVfs("/state", encoder.encode("SNAP"));
        await first.writeFileToVfs("/created", encoder.encode("created"));
        const { exit } = await first.spawnFromVfs(guestProgramName, ["persistence-overwrite", "create-fifo"]);
        expect(await exit).toBe(0);
        const socket = await first.spawnFromVfs(guestProgramName, ["persistence-overwrite", "create-socket"]);
        expect(await socket.exit).toBe(0);
        const sparse = await first.spawnFromVfs(guestProgramName, ["persistence-overwrite", "snapshot-sparse"]);
        expect(await sparse.exit).toBe(0);
        const dense = await first.spawnFromVfs(guestProgramName, ["persistence-overwrite", "snapshot-dense-reextend"]);
        expect(await dense.exit).toBe(0);
      } finally {
        await first.destroy();
      }
      const reopened = await boot(image, path, true);
      try {
        expect(new TextDecoder().decode((await reopened.readFileFromVfs("/state"))!)).toBe("SNAP");
        const integrity = await reopened.exportRootfsImageToFile(snapshotPath);
        expect(integrity.length).toBeLessThan(64 * 1024 * 1024);
        const snapshot = readFileSync(snapshotPath);
        expect(integrity.length).toBe(snapshot.byteLength);
        expect(snapshot.readUInt32LE(20)).toBe(2);
        expect(KandeloImageFs.readImageCapacity(new Uint8Array(snapshot)))
          .toEqual(KandeloImageFs.readImageCapacity(image));
        expect(snapshot.readUInt32LE(32)).toBe(new DataView(
          image.buffer, image.byteOffset, image.byteLength,
        ).getUint32(32, true));
        expect(integrity.chunkBytes).toBe(1024 * 1024);
        expect(integrity.imageSha256).toBe(createHash("sha256").update(snapshot).digest("hex"));
        expect(integrity.chunkSha256).toBeUndefined();
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
        const sparse = await withoutJournal.spawnFromVfs(guestProgramName, ["persistence-overwrite", "verify-snapshot-sparse"]);
        expect(await sparse.exit).toBe(0);
        const dense = await withoutJournal.spawnFromVfs(guestProgramName, ["persistence-overwrite", "verify-snapshot-dense-reextend"]);
        expect(await dense.exit).toBe(0);
      } finally {
        await withoutJournal.destroy();
      }
      const baseImage = new NodeKernelHost({ rootfsImage: new Uint8Array(readFileSync(snapshotPath)) });
      try {
        const kernelBytes = new Uint8Array(readFileSync(kernelPath!));
        await baseImage.init(kernelBytes.buffer.slice(
          kernelBytes.byteOffset,
          kernelBytes.byteOffset + kernelBytes.byteLength,
        ) as ArrayBuffer);
        const repeated = await baseImage.exportRootfsImageToFile(repeatedSnapshotPath);
        expect(repeated.length).toBeLessThan(64 * 1024 * 1024);
        expect(readFileSync(repeatedSnapshotPath).readUInt32LE(20)).toBe(2);
      } finally {
        await baseImage.destroy();
      }
      const repeated = new NodeKernelHost({ rootfsImage: new Uint8Array(readFileSync(repeatedSnapshotPath)) });
      try {
        const kernelBytes = new Uint8Array(readFileSync(kernelPath!));
        await repeated.init(kernelBytes.buffer.slice(
          kernelBytes.byteOffset,
          kernelBytes.byteOffset + kernelBytes.byteLength,
        ) as ArrayBuffer);
        const sparse = await repeated.spawnFromVfs(guestProgramName, ["persistence-overwrite", "verify-snapshot-sparse"]);
        expect(await sparse.exit).toBe(0);
        const dense = await repeated.spawnFromVfs(guestProgramName, ["persistence-overwrite", "verify-snapshot-dense-reextend"]);
        expect(await dense.exit).toBe(0);
      } finally {
        await repeated.destroy();
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
          if (mode === "resize" || mode === "verify-resize" || mode === "verify-zero") {
            const tail = 8 * 1024 * 1024 * 1024 + 7;
            expect(await host.readFileRangeFromVfs("/state", tail - 2, 6)).toEqual(
              mode === "resize" ? Uint8Array.of(0, 0, 71, 82, 79, 87) : new Uint8Array(6),
            );
            expect(await host.readFileRangeFromVfs("/state", tail + 4, 16)).toEqual(new Uint8Array(0));
            expect(await host.readFileRangeFromVfs("/missing", 0, 1)).toBeNull();
            await expect(host.readFileRangeFromVfs("/state", 0, 1024 * 1024 + 1)).rejects.toThrow(RangeError);
          }
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

  it.skipIf(guestProgramPath === null)("bounds resizable timestamp writeback across guest-created files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-timestamp-writeback-"));
    const path = join(directory, "machine.journal");
    try {
      const filesystem = KandeloImageFs.create(new Uint8Array(readFileSync(imageModulePath!)));
      filesystem.setImageCapacity(2 * 1024 * 1024);
      filesystem.mkdir("/bin", 0o755);
      filesystem.writeFile(guestProgramName, new Uint8Array(readFileSync(guestProgramPath!)), 0o755);
      filesystem.writeFile("/state", encoder.encode("abcdefgh"), 0o644);
      const image = await filesystem.saveImage();
      const first = await boot(image, path, true);
      try {
        const { exit } = await first.spawnFromVfs(guestProgramName, ["persistence-overwrite", "many-timestamps"]);
        expect(await exit).toBe(0);
      } finally {
        await first.destroy();
      }
      const recovered = await boot(image, path, true, true);
      try {
        const { exit } = await recovered.spawnFromVfs(guestProgramName, ["persistence-overwrite", "verify-many-timestamps"]);
        expect(await exit).toBe(0);
      } finally {
        await recovered.destroy();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it.skipIf(guestProgramPath === null)("refuses older sealed snapshots when the controlled legacy source is damaged", async () => {
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
      await expect(boot(image, path)).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
      const goodIndex = readFileSync(`${path}.g1.index`);
      const damagedIndex = Buffer.from(goodIndex);
      damagedIndex[0] ^= 1;
      writeFileSync(`${path}.g1.index`, damagedIndex);
      await expect(boot(image, path)).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
      writeFileSync(`${path}.g1.index`, goodIndex);
      writeFileSync(`${path}.g1.seal`, Buffer.from("torn"));
      await expect(boot(image, path)).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
      writeFileSync(`${path}.g0.seal`, Buffer.from("torn"));
      await expect(boot(image, path)).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
      writeFileSync(path, new Uint8Array());
      await expect(boot(image, path)).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
      expect(readFileSync(path).byteLength).toBe(0);
      writeFileSync(path, legacy);
      const fallback = await boot(image, path);
      expect(new TextDecoder().decode((await fallback.readFileFromVfs("/state"))!)).toBe("XYcdefgh");
      await fallback.destroy();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it.skipIf(guestProgramPath === null)("does not replace a damaged current resizable journal with an older staged snapshot", async () => {
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
      await expect(boot(image, path, true)).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
      writeFileSync(`${path}.g0.seal`, Buffer.from("torn"));
      await expect(boot(image, path, true)).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it.skipIf(guestProgramPath === null).each(["fixed", "resizable"].flatMap(mode =>
    ["seal", "index", "journal", "committed-record"].map(damage => ({ mode, damage }))))(
    "refuses stale fallback after acknowledged $mode post-compaction writes and active $damage corruption", async ({ mode, damage }) => {
      const directory = mkdtempSync(join(tmpdir(), "kandelo-active-generation-corruption-"));
      const path = join(directory, "machine.journal");
      const image = await makeImage("abcdefgh");
      try {
        const first = await boot(image, path, mode === "resizable");
        try {
          const { exit } = await first.spawnFromVfs(guestProgramName, ["persistence-overwrite"]);
          expect(await exit).toBe(0);
        } finally { await first.destroy(); }
        expandLargestJournalTransactionToCompactionThreshold(path);
        const second = await boot(image, path, mode === "resizable");
        try {
          expect(new TextDecoder().decode((await second.readFileFromVfs("/state"))!)).toBe("XYcdefgh");
          const { exit } = await second.spawnFromVfs(guestProgramName, ["persistence-overwrite", "mmap-fsync"]);
          expect(await exit).toBe(0);
          expect(new TextDecoder().decode((await second.readFileFromVfs("/state"))!)).toBe("MScdefgh");
        } finally { await second.destroy(); }
        const activePath = `${path}.g0.${damage === "committed-record" ? "journal" : damage}`;
        let bytes = readFileSync(activePath);
        if (damage === "committed-record") {
          let position = 72;
          let sequence = 0n;
          while (position < bytes.length) {
            const length = bytes.readUInt32LE(position + 4);
            expect(length).toBeGreaterThanOrEqual(60);
            expect(position + length).toBeLessThanOrEqual(bytes.length);
            sequence = bytes.readBigUInt64LE(position + 8);
            position += length;
          }
          const record = Buffer.alloc(83);
          record.set([75, 84, 88, 78]);
          record.writeUInt32LE(record.length, 4);
          record.writeBigUInt64LE(sequence + 1n, 8);
          record.writeUInt32LE(1, 16);
          record.writeUInt32LE((~record.length) >>> 0, 20);
          record.set([1, 255], 24);
          createHash("sha256").update(record.subarray(0, -36)).digest().copy(record, record.length - 36);
          record.set([68, 79, 78, 69], record.length - 4);
          bytes = Buffer.concat([bytes, record]);
        } else bytes[0] ^= 1;
        writeFileSync(activePath, bytes);
        const before = readFileSync(path);
        let failure: unknown;
        try {
          const unexpected = await boot(image, path, mode === "resizable", true);
          await unexpected.destroy();
        } catch (error) { failure = error; }
        expect(failure instanceof Error ? failure.message : undefined).toContain("no valid journal generation");
        expect(readFileSync(path).equals(before)).toBe(true);
        expect(readFileSync(activePath).equals(bytes)).toBe(true);
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }, 120_000,
  );

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
      expect(readFileSync(`${path}.g0.seal`).readUInt32LE(4)).toBe(4);
      expect(readFileSync(`${path}.g0.index`).readUInt32LE(4)).toBe(5);
      expect(readFileSync(`${path}.g0.journal`).byteLength).toBeLessThan(sourceLength / 2);
      const firstSlotLength = expandJournalToCompactionThreshold(`${path}.g0.journal`);
      const reopened = await boot(image, path);
      try {
        expect(new TextDecoder().decode((await reopened.readFileFromVfs("/state"))!)).toBe("XYcdefgh");
      } finally {
        await reopened.destroy();
      }
      expect(readFileSync(`${path}.g0.journal`).byteLength).toBe(firstSlotLength);
      expect(existsSync(path)).toBe(false);
      expect(existsSync(`${path}.g1.seal`)).toBe(true);
      expect(existsSync(`${path}.g1.index`)).toBe(true);
      expect(readFileSync(`${path}.g1.seal`).readUInt32LE(4)).toBe(3);
      expect(readFileSync(`${path}.g1.index`).readUInt32LE(4)).toBe(5);
      expect(readFileSync(`${path}.g1.journal`).byteLength).toBeLessThan(firstSlotLength / 2);
      const secondSlot = await boot(image, path);
      await secondSlot.destroy();
      expect(readFileSync(`${path}.g1.journal`).byteLength).toBeLessThan(firstSlotLength / 2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it.skipIf(guestProgramPath === null)("converts an oversized resizable journal before replaying namespace and truncation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-resizable-legacy-convert-"));
    const path = join(directory, "machine.journal");
    try {
      const image = await makeImage("abcdefgh", true);
      const first = await boot(image, path, true);
      try {
        for (const mode of ["create-file", "verify-created", "verify-created-shrunk", "resize", "verify-resize", "large", "set-metadata"] as const) {
          const { exit } = await first.spawnFromVfs(guestProgramName, ["persistence-overwrite", mode]);
          expect(await exit, mode).toBe(0);
        }
      } finally {
        await first.destroy();
      }
      const sourceLength = expandLargestJournalTransactionToCompactionThreshold(path);
      const reopened = await boot(image, path, true);
      try {
        for (const mode of ["verify-created-link", "verify-metadata", "verify-zero"] as const) {
          const { exit } = await reopened.spawnFromVfs(guestProgramName, ["persistence-overwrite", mode]);
          expect(await exit).toBe(0);
        }
        const large = await reopened.readFileRangeFromVfs("/large", 13, 4096);
        expect(large?.every((byte, position) => byte === (position & 255))).toBe(true);
      } finally {
        await reopened.destroy();
      }
      expect(readFileSync(path).byteLength).toBe(sourceLength);
      expect(readFileSync(`${path}.g0.index`).readUInt32LE(4)).toBe(4);
      expect(readFileSync(`${path}.g0.journal`).byteLength).toBeLessThan(sourceLength / 2);
      const again = await boot(image, path, true);
      try {
        const { exit } = await again.spawnFromVfs(guestProgramName, ["persistence-overwrite", "verify-created-link"]);
        expect(await exit).toBe(0);
      } finally {
        await again.destroy();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);

  it.skipIf(guestProgramPath === null)("upgrades an oversized sealed v1 checkpoint before mounting", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-v1-index-upgrade-"));
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
      const legacyLength = expandJournalToCompactionThreshold(path);
      const firstCompacted = await boot(image, path);
      await firstCompacted.destroy();
      const indexPath = `${path}.g0.index`;
      const oldIndex = Buffer.from(readFileSync(indexPath));
      expect(oldIndex.readUInt32LE(4)).toBe(5);
      oldIndex.writeUInt32LE(1, 4);
      createHash("sha256").update(oldIndex.subarray(0, 128)).digest().copy(oldIndex, 128);
      writeFileSync(indexPath, oldIndex);
      const backend = new HostFileSystem(directory);
      const journal = OverlayStorageFile.open(backend, "/machine.journal.g0.journal", false);
      const index = OverlayStorageFile.open(backend, "/machine.journal.g0.index", false);
      const seal = OverlayStorageFile.open(backend, "/machine.journal.g0.seal", false);
      try {
        await writeOverlayGenerationSeal(journal, seal, 1,
          new Uint8Array(createHash("sha256").update(image).digest()), index,
          { slot: "legacy", journalLength: legacyLength });
      } finally {
        seal.close();
        index.close();
        journal.close();
      }
      const oldJournalLength = expandJournalToCompactionThreshold(`${path}.g0.journal`);
      removeFixtureActivationControls(path);
      const upgraded = await boot(image, path);
      try {
        expect(new TextDecoder().decode((await upgraded.readFileFromVfs("/state"))!)).toBe("XYcdefgh");
      } finally {
        await upgraded.destroy();
      }
      expect(readFileSync(`${path}.g0.journal`).byteLength).toBe(oldJournalLength);
      expect(readFileSync(indexPath)).toEqual(oldIndex);
      expect(readFileSync(`${path}.g1.index`).readUInt32LE(4)).toBe(5);
      const reopened = await boot(image, path);
      try {
        expect(new TextDecoder().decode((await reopened.readFileFromVfs("/state"))!)).toBe("XYcdefgh");
      } finally {
        await reopened.destroy();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);

  it.skipIf(guestProgramPath === null)("upgrades an oversized v1 checkpoint with two valid generation slots", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-v1-three-slot-upgrade-"));
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
      expandJournalToCompactionThreshold(path);
      const firstCompacted = await boot(image, path);
      await firstCompacted.destroy();
      const g0Length = expandJournalToCompactionThreshold(`${path}.g0.journal`);
      const secondCompacted = await boot(image, path);
      await secondCompacted.destroy();
      const g0Seal = readFileSync(`${path}.g0.seal`);
      const g1IndexPath = `${path}.g1.index`;
      const oldIndex = Buffer.from(readFileSync(g1IndexPath));
      expect(oldIndex.readUInt32LE(4)).toBe(5);
      oldIndex.writeUInt32LE(1, 4);
      createHash("sha256").update(oldIndex.subarray(0, 128)).digest().copy(oldIndex, 128);
      writeFileSync(g1IndexPath, oldIndex);
      const backend = new HostFileSystem(directory);
      const journal = OverlayStorageFile.open(backend, "/machine.journal.g1.journal", false);
      const index = OverlayStorageFile.open(backend, "/machine.journal.g1.index", false);
      const seal = OverlayStorageFile.open(backend, "/machine.journal.g1.seal", false);
      try {
        await writeOverlayGenerationSeal(journal, seal, 2,
          new Uint8Array(createHash("sha256").update(image).digest()), index,
          { slot: "g0", journalLength: g0Length });
      } finally {
        seal.close();
        index.close();
        journal.close();
      }
      const g1Length = expandJournalToCompactionThreshold(`${path}.g1.journal`);
      removeFixtureActivationControls(path);
      const upgraded = await boot(image, path);
      try {
        expect(new TextDecoder().decode((await upgraded.readFileFromVfs("/state"))!)).toBe("XYcdefgh");
      } finally {
        await upgraded.destroy();
      }
      expect(readFileSync(`${path}.g0.seal`)).toEqual(g0Seal);
      expect(readFileSync(`${path}.g0.journal`).byteLength).toBe(g0Length);
      expect(readFileSync(`${path}.g1.journal`).byteLength).toBe(g1Length);
      expect(readFileSync(g1IndexPath)).toEqual(oldIndex);
      expect(readFileSync(`${path}.g2.index`).readUInt32LE(4)).toBe(5);
      const reopened = await boot(image, path);
      try {
        expect(new TextDecoder().decode((await reopened.readFileFromVfs("/state"))!)).toBe("XYcdefgh");
      } finally {
        await reopened.destroy();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);

  it.skipIf(guestProgramPath === null)("upgrades an oversized v1 checkpoint with three valid generation slots", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-v1-four-slot-upgrade-"));
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
      expandJournalToCompactionThreshold(path);
      const firstCompacted = await boot(image, path);
      await firstCompacted.destroy();
      expandJournalToCompactionThreshold(`${path}.g0.journal`);
      const secondCompacted = await boot(image, path);
      await secondCompacted.destroy();
      const g1Length = expandJournalToCompactionThreshold(`${path}.g1.journal`);
      const thirdCompacted = await boot(image, path);
      await thirdCompacted.destroy();
      const indexPath = `${path}.g2.index`;
      const oldIndex = Buffer.from(readFileSync(indexPath));
      expect(oldIndex.readUInt32LE(4)).toBe(5);
      oldIndex.writeUInt32LE(1, 4);
      createHash("sha256").update(oldIndex.subarray(0, 128)).digest().copy(oldIndex, 128);
      writeFileSync(indexPath, oldIndex);
      const backend = new HostFileSystem(directory);
      const journal = OverlayStorageFile.open(backend, "/machine.journal.g2.journal", false);
      const index = OverlayStorageFile.open(backend, "/machine.journal.g2.index", false);
      const seal = OverlayStorageFile.open(backend, "/machine.journal.g2.seal", false);
      try {
        await writeOverlayGenerationSeal(journal, seal, 3,
          new Uint8Array(createHash("sha256").update(image).digest()), index,
          { slot: "g1", journalLength: g1Length });
      } finally {
        seal.close();
        index.close();
        journal.close();
      }
      const g2Length = expandJournalToCompactionThreshold(`${path}.g2.journal`);
      for (const slot of ["g0", "g1"]) {
        for (const suffix of ["journal", "index", "seal"]) {
          copyFileSync(`${path}.${slot}.${suffix}`, `${path}.backup-${slot}.${suffix}`);
        }
      }
      removeFixtureActivationControls(path);
      const upgraded = await boot(image, path);
      try {
        expect(new TextDecoder().decode((await upgraded.readFileFromVfs("/state"))!)).toBe("XYcdefgh");
      } finally {
        await upgraded.destroy();
      }
      expect(readFileSync(`${path}.g2.journal`).byteLength).toBe(g2Length);
      expect(readFileSync(indexPath)).toEqual(oldIndex);
      expect(readFileSync(`${path}.g3.index`).readUInt32LE(4)).toBe(5);
      for (const slot of ["g0", "g1"]) {
        for (const suffix of ["journal", "index", "seal"]) {
          expect(existsSync(`${path}.${slot}.${suffix}`)).toBe(false);
        }
      }
      expect(existsSync(`${path}.g2.seal`)).toBe(true);
      writeFileSync(`${path}.g0.journal`, Uint8Array.of(1));
      writeFileSync(`${path}.g0.index`, Uint8Array.of(2));
      writeFileSync(`${path}.g0.seal`, new Uint8Array());
      const reopened = await boot(image, path);
      try {
        expect(new TextDecoder().decode((await reopened.readFileFromVfs("/state"))!)).toBe("XYcdefgh");
      } finally {
        await reopened.destroy();
      }
      for (const suffix of ["journal", "index", "seal"]) {
        expect(existsSync(`${path}.g0.${suffix}`)).toBe(false);
      }
      for (const slot of ["g0", "g1"]) {
        for (const suffix of ["journal", "index", "seal"]) {
          copyFileSync(`${path}.backup-${slot}.${suffix}`, `${path}.${slot}.${suffix}`);
        }
      }
      const g3IndexPath = `${path}.g3.index`;
      const g3OldIndex = Buffer.from(readFileSync(g3IndexPath));
      g3OldIndex.writeUInt32LE(1, 4);
      createHash("sha256").update(g3OldIndex.subarray(0, 128)).digest().copy(g3OldIndex, 128);
      writeFileSync(g3IndexPath, g3OldIndex);
      const g3Journal = OverlayStorageFile.open(backend, "/machine.journal.g3.journal", false);
      const g3Index = OverlayStorageFile.open(backend, "/machine.journal.g3.index", false);
      const g3Seal = OverlayStorageFile.open(backend, "/machine.journal.g3.seal", false);
      try {
        await writeOverlayGenerationSeal(g3Journal, g3Seal, 4,
          new Uint8Array(createHash("sha256").update(image).digest()), g3Index,
          { slot: "g2", journalLength: g2Length });
      } finally {
        g3Seal.close();
        g3Index.close();
        g3Journal.close();
      }
      expandJournalToCompactionThreshold(`${path}.g3.journal`);
      removeFixtureActivationControls(path);
      const migrated = await boot(image, path);
      try {
        expect(new TextDecoder().decode((await migrated.readFileFromVfs("/state"))!)).toBe("XYcdefgh");
      } finally {
        await migrated.destroy();
      }
      expect(readFileSync(`${path}.g3.index`)).toEqual(g3OldIndex);
      expect(readFileSync(`${path}.g4.index`).readUInt32LE(4)).toBe(5);
      for (const slot of ["g0", "g1", "g2"]) {
        for (const suffix of ["journal", "index", "seal"]) {
          expect(existsSync(`${path}.${slot}.${suffix}`)).toBe(false);
        }
      }
      expect(existsSync(`${path}.g3.seal`)).toBe(true);
      expandJournalToCompactionThreshold(`${path}.g4.journal`);
      const compacted = await boot(image, path);
      try {
        expect(new TextDecoder().decode((await compacted.readFileFromVfs("/state"))!)).toBe("XYcdefgh");
      } finally {
        await compacted.destroy();
      }
      expect(readFileSync(`${path}.g0.index`).readUInt32LE(4)).toBe(5);
      for (const slot of ["g1", "g2", "g3"]) {
        for (const suffix of ["journal", "index", "seal"]) {
          expect(existsSync(`${path}.${slot}.${suffix}`)).toBe(false);
        }
      }
      expect(existsSync(`${path}.g4.seal`)).toBe(true);
      const damagedIndex = Buffer.from(readFileSync(`${path}.g0.index`));
      damagedIndex[160] ^= 1;
      writeFileSync(`${path}.g0.index`, damagedIndex);
      const sourceBytes = readFileSync(`${path}.g4.journal`);
      await expect(boot(image, path)).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
      expect(readFileSync(`${path}.g0.index`).equals(damagedIndex)).toBe(true);
      expect(readFileSync(`${path}.g4.journal`).equals(sourceBytes)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);

  it.skipIf(guestProgramPath === null)("upgrades an oversized sealed v2 resizable checkpoint with metadata", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-v2-resizable-upgrade-"));
    const path = join(directory, "machine.journal");
    try {
      const image = await makeImage("abcdefgh", true);
      const first = await boot(image, path, true);
      try {
        for (const mode of ["create-file", "large"] as const) {
          const { exit } = await first.spawnFromVfs(guestProgramName, ["persistence-overwrite", mode]);
          expect(await exit, mode).toBe(0);
        }
      } finally {
        await first.destroy();
      }
      const legacyLength = expandLargestJournalTransactionToCompactionThreshold(path);
      const firstCompacted = await boot(image, path, true);
      await firstCompacted.destroy();
      const indexPath = `${path}.g0.index`;
      const indexBytes = Buffer.from(readFileSync(indexPath));
      expect(indexBytes.readUInt32LE(4)).toBe(4);
      const blockEnd = 160 + Number(indexBytes.readBigUInt64LE(80)) * 56;
      const oldIndex = Buffer.from(indexBytes.subarray(0, blockEnd));
      oldIndex.writeUInt32LE(2, 4);
      createHash("sha256").update(oldIndex.subarray(160)).digest().copy(oldIndex, 96);
      createHash("sha256").update(oldIndex.subarray(0, 128)).digest().copy(oldIndex, 128);
      writeFileSync(indexPath, oldIndex);
      const backend = new HostFileSystem(directory);
      const journal = OverlayStorageFile.open(backend, "/machine.journal.g0.journal", false);
      const index = OverlayStorageFile.open(backend, "/machine.journal.g0.index", false);
      const seal = OverlayStorageFile.open(backend, "/machine.journal.g0.seal", false);
      try {
        await writeOverlayGenerationSeal(journal, seal, 1,
          new Uint8Array(createHash("sha256").update(image).digest()), index,
          { slot: "legacy", journalLength: legacyLength });
      } finally {
        seal.close();
        index.close();
        journal.close();
      }
      const sourceLength = expandLargestJournalTransactionToCompactionThreshold(`${path}.g0.journal`);
      removeFixtureActivationControls(path);
      const upgraded = await boot(image, path, true);
      try {
        const tail = await upgraded.readFileRangeFromVfs("/created", 8 * 1024 * 1024 * 1024 + 7, 4);
        expect(new TextDecoder().decode(tail!)).toBe("NEWW");
        const large = await upgraded.readFileRangeFromVfs("/large", 13, 4096);
        expect(large?.every((byte, position) => byte === (position & 255))).toBe(true);
      } finally {
        await upgraded.destroy();
      }
      expect(readFileSync(`${path}.g0.journal`).byteLength).toBe(sourceLength);
      expect(readFileSync(indexPath)).toEqual(oldIndex);
      expect(readFileSync(`${path}.g1.index`).readUInt32LE(4)).toBe(4);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);

  it.skipIf(guestProgramPath === null)("upgrades an oversized v2 metadata checkpoint with two valid generation slots", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-v2-three-slot-upgrade-"));
    const path = join(directory, "machine.journal");
    try {
      const image = await makeImage("abcdefgh", true);
      const first = await boot(image, path, true);
      try {
        for (const mode of ["create-file", "large"] as const) {
          const { exit } = await first.spawnFromVfs(guestProgramName, ["persistence-overwrite", mode]);
          expect(await exit, mode).toBe(0);
        }
      } finally {
        await first.destroy();
      }
      expandLargestJournalTransactionToCompactionThreshold(path);
      const firstCompacted = await boot(image, path, true);
      await firstCompacted.destroy();
      const g0Length = expandLargestJournalTransactionToCompactionThreshold(`${path}.g0.journal`, true);
      const secondCompacted = await boot(image, path, true);
      await secondCompacted.destroy();
      const g0Seal = readFileSync(`${path}.g0.seal`);
      const g1IndexPath = `${path}.g1.index`;
      const current = readFileSync(g1IndexPath);
      expect(current.readUInt32LE(4)).toBe(4);
      const blockEnd = 160 + Number(current.readBigUInt64LE(80)) * 56;
      const oldIndex = Buffer.from(current.subarray(0, blockEnd));
      oldIndex.writeUInt32LE(2, 4);
      createHash("sha256").update(oldIndex.subarray(160)).digest().copy(oldIndex, 96);
      createHash("sha256").update(oldIndex.subarray(0, 128)).digest().copy(oldIndex, 128);
      writeFileSync(g1IndexPath, oldIndex);
      const backend = new HostFileSystem(directory);
      const journal = OverlayStorageFile.open(backend, "/machine.journal.g1.journal", false);
      const index = OverlayStorageFile.open(backend, "/machine.journal.g1.index", false);
      const seal = OverlayStorageFile.open(backend, "/machine.journal.g1.seal", false);
      try {
        await writeOverlayGenerationSeal(journal, seal, 2,
          new Uint8Array(createHash("sha256").update(image).digest()), index,
          { slot: "g0", journalLength: g0Length });
      } finally {
        seal.close();
        index.close();
        journal.close();
      }
      const g1Length = expandLargestJournalTransactionToCompactionThreshold(`${path}.g1.journal`);
      removeFixtureActivationControls(path);
      const upgraded = await boot(image, path, true);
      try {
        const tail = await upgraded.readFileRangeFromVfs("/created", 8 * 1024 * 1024 * 1024 + 7, 4);
        expect(new TextDecoder().decode(tail!)).toBe("NEWW");
      } finally {
        await upgraded.destroy();
      }
      expect(readFileSync(`${path}.g0.seal`)).toEqual(g0Seal);
      expect(readFileSync(`${path}.g0.journal`).byteLength).toBe(g0Length);
      expect(readFileSync(`${path}.g1.journal`).byteLength).toBe(g1Length);
      expect(readFileSync(g1IndexPath)).toEqual(oldIndex);
      expect(readFileSync(`${path}.g2.index`).readUInt32LE(4)).toBe(4);
      const reopened = await boot(image, path, true);
      try {
        const tail = await reopened.readFileRangeFromVfs("/created", 8 * 1024 * 1024 * 1024 + 7, 4);
        expect(new TextDecoder().decode(tail!)).toBe("NEWW");
      } finally {
        await reopened.destroy();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);

  it.skipIf(guestProgramPath === null)("rejects a resealed v3 block index with a false digest", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-v3-index-fallback-"));
    const path = join(directory, "machine.journal");
    try {
      const image = await makeImage("abcdefgh", true);
      const first = await boot(image, path, true);
      try {
        for (const mode of ["create-file", "large"] as const) {
          const { exit } = await first.spawnFromVfs(guestProgramName, ["persistence-overwrite", mode]);
          expect(await exit, mode).toBe(0);
        }
      } finally {
        await first.destroy();
      }
      const sourceLength = expandLargestJournalTransactionToCompactionThreshold(path);
      const compacted = await boot(image, path, true);
      await compacted.destroy();
      const indexPath = `${path}.g0.index`;
      const current = readFileSync(indexPath);
      expect(current.readUInt32LE(4)).toBe(4);
      const blockEnd = 160 + Number(current.readBigUInt64LE(80)) * 56;
      const metadataCount = (current.byteLength - blockEnd) / 312;
      expect(metadataCount).toBeGreaterThan(0);
      const v3 = Buffer.alloc(blockEnd + metadataCount * 280);
      current.copy(v3, 0, 0, blockEnd);
      for (let position = 0; position < metadataCount; position++) {
        current.copy(v3, blockEnd + position * 280, blockEnd + position * 312, blockEnd + position * 312 + 280);
      }
      const rehashIndex = () => {
        const blockDigest = createHash("sha256").update(v3.subarray(160, blockEnd)).digest();
        const metadataDigest = createHash("sha256").update(v3.subarray(blockEnd)).digest();
        createHash("sha256").update(blockDigest).update(metadataDigest).digest().copy(v3, 96);
        createHash("sha256").update(v3.subarray(0, 128)).digest().copy(v3, 128);
      };
      v3.writeUInt32LE(3, 4);
      rehashIndex();
      const backend = new HostFileSystem(directory);
      const digest = new Uint8Array(createHash("sha256").update(image).digest());
      const reseal = async () => {
        writeFileSync(indexPath, v3);
        const journal = OverlayStorageFile.open(backend, "/machine.journal.g0.journal", false);
        const index = OverlayStorageFile.open(backend, "/machine.journal.g0.index", false);
        const seal = OverlayStorageFile.open(backend, "/machine.journal.g0.seal", false);
        try {
          await writeOverlayGenerationSeal(journal, seal, 1, digest, index,
            { slot: "legacy", journalLength: sourceLength });
        } finally {
          seal.close();
          index.close();
          journal.close();
        }
      };
      await reseal();
      removeFixtureActivationControls(path);
      const legacyV3 = await boot(image, path, true);
      try {
        const tail = await legacyV3.readFileRangeFromVfs("/created", 8 * 1024 * 1024 * 1024 + 7, 4);
        expect(new TextDecoder().decode(tail!)).toBe("NEWW");
      } finally {
        await legacyV3.destroy();
      }
      expect(readFileSync(indexPath).readUInt32LE(4)).toBe(3);
      v3[160 + 24] ^= 1;
      rehashIndex();
      await reseal();
      refreshFixtureControlSeal(path, "g0");
      let recovered: NodeKernelHost | undefined;
      let failure: unknown;
      try {
        recovered = await boot(image, path, true);
        await recovered.readFileRangeFromVfs("/large", 0, 4096);
      } catch (error) { failure = error; }
      finally { await recovered?.destroy(); }
      expect(failure).toBeInstanceOf(Error);
      expect(readFileSync(path).byteLength).toBe(sourceLength);
      expect(readFileSync(indexPath).readUInt32LE(4)).toBe(3);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);

  it.skipIf(guestProgramPath === null)("keeps the controlled active generation instead of a forged unpublished v5 index", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-fixed-index-fallback-"));
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
      expandJournalToCompactionThreshold(path);
      const compacted = await boot(image, path);
      await compacted.destroy();
      const priorJournal = readFileSync(`${path}.g0.journal`);
      const priorIndex = readFileSync(`${path}.g0.index`);
      expect(priorIndex.readUInt32LE(4)).toBe(5);
      expect(priorIndex.readBigUInt64LE(80)).toBeGreaterThan(0n);
      writeFileSync(`${path}.g1.journal`, priorJournal);
      const forgedIndex = Buffer.from(priorIndex);
      forgedIndex[160 + 24] ^= 1;
      createHash("sha256").update(forgedIndex.subarray(160)).digest().copy(forgedIndex, 96);
      createHash("sha256").update(forgedIndex.subarray(0, 128)).digest().copy(forgedIndex, 128);
      writeFileSync(`${path}.g1.index`, forgedIndex);
      const backend = new HostFileSystem(directory);
      const journal = OverlayStorageFile.open(backend, "/machine.journal.g1.journal", false);
      const index = OverlayStorageFile.open(backend, "/machine.journal.g1.index", false);
      const seal = OverlayStorageFile.open(backend, "/machine.journal.g1.seal");
      try {
        const digest = new Uint8Array(createHash("sha256").update(image).digest());
        await writeOverlayGenerationSeal(journal, seal, 2, digest, index, {
          slot: "g0",
          journalLength: priorJournal.byteLength,
        });
        expect((await verifyOverlayGenerationSeal(journal, seal, digest, false, index)).generation).toBe(2);
      } finally {
        seal.close();
        index.close();
        journal.close();
      }
      const recovered = await boot(image, path);
      try {
        expect(new TextDecoder().decode((await recovered.readFileFromVfs("/state"))!)).toBe("XYcdefgh");
      } finally {
        await recovered.destroy();
      }
      expect(readFileSync(`${path}.g1.index`)).toEqual(forgedIndex);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it.skipIf(guestProgramPath === null)("migrates an uncontrolled legacy source with later committed writes instead of its stale target", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-stale-overlay-slot-"));
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
      const transaction = Buffer.from(readFileSync(path).subarray(72));
      const valueOffset = transaction.indexOf("XYcdefgh");
      expect(valueOffset).toBeGreaterThan(0);
      const sourceLength = expandJournalToCompactionThreshold(path);
      const compacted = await boot(image, path);
      await compacted.destroy();
      expect(readFileSync(`${path}.g0.seal`).readUInt32LE(4)).toBe(4);
      const newer = Buffer.from(transaction);
      newer.writeBigUInt64LE(BigInt((sourceLength - 72) / transaction.length + 1), 8);
      newer.write("ZZcdefgh", valueOffset, "ascii");
      createHash("sha256").update(newer.subarray(0, newer.length - 36)).digest().copy(newer, newer.length - 36);
      removeFixtureActivationControls(path);
      appendFileSync(path, newer);
      const recovered = await boot(image, path, false, true);
      try {
        expect(new TextDecoder().decode((await recovered.readFileFromVfs("/state"))!)).toBe("ZZcdefgh");
      } finally {
        await recovered.destroy();
      }
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
        expect(await reopened.readFileRangeFromVfs("/large", 100_000, 1024 * 1024)).toEqual(
          expected.subarray(100_000, 100_000 + 1024 * 1024),
        );
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
          expect(readFileSync(`${path}.${slot}.seal`).readUInt32LE(4)).toBe(slot === "g0" ? 4 : 3);
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
