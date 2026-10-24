import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { startDeferredByteServer } from "./fixtures/deferred-byte-server";
import { startDeferredArchiveServer } from "./fixtures/deferred-archive-server";
import { hostTransportMetadataImage } from "./fixtures/host-transport-metadata-image";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { NodeKernelHost } from "../src/node-kernel-host";

const repoRoot = join(import.meta.dirname, "../..");
const sourceOnly = join(repoRoot, "local-binaries/source-only-v1");
const shellImage = join(sourceOnly, "programs/wasm32/shell.vfs.zst");
const coreutils = join(sourceOnly, "programs/wasm32/coreutils.wasm");
const bash = join(sourceOnly, "programs/wasm32/bash.wasm");
const kernel = join(sourceOnly, "kernel.wasm");
const mappingProgram = join(repoRoot, "local-binaries/test-fixtures/wasm32/persistence-overwrite.wasm");
const available = [shellImage, coreutils, bash, kernel, mappingProgram].every(existsSync);
const denseImage = process.env.KANDELO_DENSE_VFSI_FIXTURE;
const sparseImage = process.env.KANDELO_SPARSE_VFSI_FIXTURE;

describe.skipIf(!available)("persistent root filesystem statistics", () => {
  it("refuses host transport metadata before opening a journal and permits a smaller-image retry", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-host-metadata-pressure-"));
    const journal = join(directory, "journal");
    const kernelWasm = new Uint8Array(readFileSync(kernel));
    let closed = true;
    try {
      const oversized = new NodeKernelHost({ rootfsImage: await hostTransportMetadataImage(true),
        kernelMaxPages: 4096, experimentalResizablePersistencePath: journal });
      closed = false;
      try {
        await expect(oversized.init(kernelWasm.buffer)).rejects.toThrow("Host storage metadata memory budget exhausted");
      } finally { await oversized.destroy(); closed = true; }
      expect(existsSync(journal)).toBe(false);
      expect(existsSync(`${journal}.lock`)).toBe(false);
      const retry = new NodeKernelHost({ rootfsImage: await hostTransportMetadataImage(false),
        kernelMaxPages: 4096, experimentalResizablePersistencePath: journal });
      closed = false;
      try {
        await retry.init(kernelWasm.buffer);
        expect((await retry.statVfsPath("/asset-0"))?.size).toBe(1);
        expect(await retry.getKernelMemoryPages()).toBeLessThanOrEqual(4096);
      } finally { await retry.destroy(); closed = true; }
    } finally {
      if (closed) rmSync(directory, { recursive: true, force: true });
      else console.error(`Retained host metadata fixture after unproven shutdown: ${directory}`);
    }
  }, 120_000);
  it.each([
    { scenario: "refuses oversized mappings before changing a small sparse-file window and recovers its writes",
      fixture: "persistence-mapping-memory.wasm", capacity: 64 * 1024 * 1024,
      marker: "MAPPING_MEMORY_REFUSAL_VERIFIED" },
    { scenario: "bounds combined namespace, mapping and writeback pressure and recovers accepted state",
      fixture: "persistence-aggregate-pressure.wasm", capacity: 512 * 1024 * 1024,
      marker: "AGGREGATE_PRESSURE_VERIFIED" },
  ])("$scenario", async ({ scenario, fixture, capacity, marker }) => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-persistent-mapping-memory-"));
    const filesystem = KandeloImageFs.create();
    filesystem.setImageCapacity(capacity);
    filesystem.mkdir("/bin", 0o755);
    filesystem.writeFile("/bin/mapping-memory", readFileSync(join(repoRoot,
      "local-binaries/test-fixtures/wasm32", fixture)), 0o755);
    const image = await filesystem.saveImage();
    const memory: number[] = [];
    let closed = true;
    try {
      for (const recovered of [false, true]) {
        const output: string[] = [];
        const host = new NodeKernelHost({
          rootfsImage: image, kernelMaxPages: 1024,
          experimentalResizablePersistencePath: join(directory, "journal"),
          requireExistingRootfsPersistence: recovered,
          onStdout: (_pid, bytes) => output.push(new TextDecoder().decode(bytes)),
          onStderr: (_pid, bytes) => output.push(new TextDecoder().decode(bytes)),
        });
        closed = false;
        try {
          await host.init(new Uint8Array(readFileSync(kernel)).buffer);
          const { exit } = await host.spawnFromVfs("/bin/mapping-memory",
            ["mapping-memory", recovered ? "verify" : "write"], { uid: 0, gid: 0 });
          expect(await exit, output.join("")).toBe(0);
          expect(output.join("")).toContain(marker);
          if (!recovered && fixture === "persistence-aggregate-pressure.wasm") {
            expect(output.join("")).toMatch(/PRESSURE_REFUSAL created=\d+ errno=12/);
          }
          memory.push(await host.getKernelMemoryPages());
        } finally {
          await host.destroy();
          closed = true;
        }
      }
      expect(memory.every(pages => pages <= 1024)).toBe(true);
      console.info(`${scenario} kernel pages:`, JSON.stringify(memory));
    } finally {
      if (closed) rmSync(directory, { recursive: true, force: true });
      else console.error(`Retaining mapping-memory journal after unproven shutdown: ${directory}`);
    }
  }, 120_000);

  it.skipIf(sparseImage === undefined)("accounts for a near-dense file larger than 32 GiB without retaining a block map", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-near-dense-image-"));
    const memory: number[] = [];
    try {
      for (const recovered of [false, true]) {
        const output: string[] = [];
        const host = new NodeKernelHost({
          rootfsImageFile: sparseImage!, kernelMaxPages: 1024,
          experimentalResizablePersistencePath: join(directory, "journal"),
          requireExistingRootfsPersistence: recovered,
          onStdout: (_pid, bytes) => output.push(new TextDecoder().decode(bytes)),
          onStderr: (_pid, bytes) => output.push(new TextDecoder().decode(bytes)),
        });
        try {
          await host.init(new Uint8Array(readFileSync(kernel)).buffer);
          expect((await host.statVfsPath("/large"))?.size).toBe(2 ** 35 + 8192);
          if (!recovered) {
            const hole = await host.readFileRangeFromVfs("/large", 0, 4096);
            expect(hole?.length).toBe(4096);
            expect(hole?.every(byte => byte === 0)).toBe(true);
          }
          const { exit } = await host.spawnFromVfs("/bin/persistence-overwrite", [
            "persistence-overwrite", recovered ? "verify-near-dense" : "near-dense",
          ], { uid: 0, gid: 0, env: ["PATH=/bin", "HOME=/"] });
          expect(await exit, output.join("")).toBe(0);
          expect(output.join("")).toContain("NEAR_DENSE_LEDGER_OK");
          for (const offset of [0, 2 * 1024 * 1024 - 65_536]) {
            const bytes = await host.readFileRangeFromVfs("/large", 13 + offset, 65_536);
            expect(bytes?.length).toBe(65_536);
            expect(bytes?.every((byte, index) => byte === ((((offset + index) / 4096) ^ (offset + index)) & 255))).toBe(true);
          }
          memory.push(await host.getKernelMemoryPages());
        } finally {
          await host.destroy();
        }
      }
      for (const pages of memory) expect(pages).toBeLessThanOrEqual(1024);
      console.info("Near-dense image allocation-ledger kernel pages:", JSON.stringify(memory));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 1_800_000);

  it.skipIf(denseImage === undefined)("mounts and recovers a dense file larger than 32 GiB under a 64 MiB kernel ceiling", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-dense-image-"));
    const journal = join(directory, "journal");
    const memory: number[] = [];
    try {
      for (const recovered of [false, true]) {
        const stderr: string[] = [];
        const host = new NodeKernelHost({
          rootfsImageFile: denseImage!, kernelMaxPages: 1024,
          experimentalResizablePersistencePath: journal,
          requireExistingRootfsPersistence: recovered,
          onStderr: (_pid, bytes) => stderr.push(new TextDecoder().decode(bytes)),
        });
        try {
          await host.init(new Uint8Array(readFileSync(kernel)).buffer);
          const metadata = await host.statVfsPath("/large");
          expect(metadata?.size).toBeGreaterThan(32 * 1024 * 1024 * 1024);
          if (!recovered) {
            const initial = await host.readFileRangeFromVfs("/large", metadata!.size - 2 * 1024 * 1024 - 13, 4096);
            expect(initial?.every(byte => byte === 0)).toBe(true);
          }
          const { exit } = await host.spawnFromVfs("/bin/persistence-overwrite", ["persistence-overwrite", recovered ? "verify-large-tail" : "large-tail"], {
            uid: 0, gid: 0, env: ["PATH=/bin", "HOME=/"],
          });
          expect(await exit, stderr.join("")).toBe(0);
          const changed = await host.readFileRangeFromVfs("/large", metadata!.size - 2 * 1024 * 1024 - 13, 4096);
          expect(changed?.length).toBe(4096);
          expect(changed?.every((byte, index) => byte === (index & 255))).toBe(true);
          memory.push(await host.getKernelMemoryPages());
        } finally {
          await host.destroy();
        }
      }
      for (const pages of memory) expect(pages).toBeLessThanOrEqual(1024);
      console.info("Dense positioned image kernel pages:", JSON.stringify(memory));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 1_800_000);

  it.each([false, true])("streams large archive members under a 64 MiB kernel ceiling (deflated=%s)", async deflated => {
    const server = await startDeferredArchiveServer(96 * 1024 * 1024, deflated);
    onTestFinished(() => server.close());
    const directory = mkdtempSync(join(tmpdir(), "kandelo-persistent-archive-"));
    const filesystem = KandeloImageFs.create();
    filesystem.setImageCapacity(8 * 1024 * 1024);
    filesystem.registerLazyArchive({
      url: server.url, entries: server.entries, mountPrefix: "/",
      integrity: { sha256: server.sha256, bytes: server.size },
    });
    filesystem.mkdir("/bin", 0o755);
    filesystem.writeFile("/bin/coreutils", readFileSync(coreutils), 0o755);
    const image = await filesystem.saveImage();
    const journal = join(directory, "journal");
    const memory: number[] = [];
    let checkpointImage: Uint8Array | undefined;
    try {
      for (const phase of ["initial", "recover", "checkpoint"]) {
        const stderr: string[] = [];
        const host = new NodeKernelHost({
          kernelMaxPages: 1024, rootfsImage: phase === "checkpoint" ? checkpointImage! : image,
          experimentalResizablePersistencePath: phase === "checkpoint" ? join(directory, "checkpoint-journal") : journal,
          requireExistingRootfsPersistence: phase === "recover",
          onStderr: (_pid, bytes) => stderr.push(new TextDecoder().decode(bytes)),
        });
        try {
          await host.init(new Uint8Array(readFileSync(kernel)).buffer);
          const { exit } = await host.spawnFromVfs("/bin/coreutils", ["dd", "if=/large", "of=/dev/null", "bs=65536", "status=none"], {
            env: ["PATH=/bin", "HOME=/"], uid: 0, gid: 0,
          });
          expect(await exit, stderr.join("")).toBe(0);
          const before = await host.readFileRangeFromVfs("/large", server.memberSize - 65_537, 65_537);
          expect(before?.length).toBe(65_537);
          expect(before?.every(byte => byte === 86)).toBe(true);
          const hash = createHash("sha256");
          for (let offset = 0; offset < server.memberSize; offset += 1024 * 1024) {
            const bytes = await host.readFileRangeFromVfs("/large", offset, 1024 * 1024);
            expect(bytes?.byteLength).toBe(1024 * 1024);
            hash.update(bytes!);
          }
          expect(hash.digest("hex")).toBe(server.memberSha256);
          memory.push(await host.getKernelMemoryPages());
          if (phase === "recover") {
            const checkpoint = join(directory, "checkpoint.vfs");
            await host.exportRootfsImageToFile(checkpoint);
            checkpointImage = new Uint8Array(readFileSync(checkpoint));
            expect(KandeloImageFs.readImageCapacity(checkpointImage)).toEqual({ maxByteLength: 8 * 1024 * 1024 });
          }
        } finally {
          await host.destroy();
        }
      }
      expect(server.requests()).toBe(3);
      for (const pages of memory) expect(pages).toBeLessThanOrEqual(1024);
      console.info("Persistent archive kernel pages:", JSON.stringify({ deflated, memory }));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);

  it("cancels admitted deferred exec before shutdown drains creators and syncs dirty files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-persistent-cancel-exec-"));
    const program = readFileSync(bash);
    const server = await startDeferredByteServer(program.byteLength, { stall: true });
    onTestFinished(() => server.close());
    const filesystem = KandeloImageFs.create();
    filesystem.setImageCapacity(8 * 1024 * 1024);
    filesystem.registerLazyFile("/blocked", server.url, program.byteLength, 0o755,
      createHash("sha256").update(program).digest("hex"));
    const image = await filesystem.saveImage();
    const diagnostics: string[] = [];
    const journal = join(directory, "journal");
    const host = new NodeKernelHost({
      rootfsImage: image,
      experimentalResizablePersistencePath: journal,
      onHostDiagnostic: diagnostic => diagnostics.push(diagnostic.source + ": " + diagnostic.message),
    });
    let reopened: NodeKernelHost | undefined;
    try {
      await host.init(new Uint8Array(readFileSync(kernel)).buffer);
      await host.writeFileToVfs("/pending", new Uint8Array([1, 2, 3]));
      const pending = host.spawnFromVfs("/blocked", ["blocked"])
        .then(() => false, () => true);
      await server.requested;
      await host.destroy();
      expect(diagnostics.filter(message => message.startsWith("kernel worker destroy:"))).toEqual([]);
      expect(await pending).toBe(true);
      reopened = new NodeKernelHost({
        rootfsImage: image,
        experimentalResizablePersistencePath: journal,
        requireExistingRootfsPersistence: true,
      });
      await reopened.init(new Uint8Array(readFileSync(kernel)).buffer);
      expect(await reopened.readFileFromVfs("/pending")).toEqual(new Uint8Array([1, 2, 3]));
    } finally {
      await reopened?.destroy();
      await host.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 60_000);

  it("reads a persistent deferred file for longer than thirty seconds while bytes keep arriving", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-persistent-slow-read-"));
    const server = await startDeferredByteServer(5 * 64 * 1024, { chunkBytes: 64 * 1024, chunkDelayMs: 8_000 });
    onTestFinished(() => server.close());
    const filesystem = KandeloImageFs.create();
    filesystem.setImageCapacity(8 * 1024 * 1024);
    filesystem.registerLazyFile("/slow", server.url, server.size, 0o600, server.sha256);
    const host = new NodeKernelHost({
      kernelMaxPages: 1024,
      rootfsImage: await filesystem.saveImage(),
      experimentalResizablePersistencePath: join(directory, "journal"),
    });
    try {
      await host.init(new Uint8Array(readFileSync(kernel)).buffer);
      const started = performance.now();
      const bytes = await host.readFileFromVfs("/slow");
      expect(bytes?.byteLength).toBe(server.size);
      expect(bytes?.every(byte => byte === 86)).toBe(true);
      expect(performance.now() - started).toBeGreaterThanOrEqual(35_000);
      expect(server.requests()).toBe(1);
    } finally {
      await host.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);

  it("enforces file-size and inode capacities through unlink, strict reboot, and checkpoint", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-persistent-inodes-"));
    const verified = await startDeferredByteServer(96 * 1024 * 1024);
    onTestFinished(() => verified.close());
    const filesystem = KandeloImageFs.create();
    filesystem.setImageCapacity(8 * 1024 * 1024);
    filesystem.registerLazyFile("/verified-reader", verified.url, verified.size, 0o600, verified.sha256);
    filesystem.registerLazyFile("/deferred-orphan", "https://example.invalid/".padEnd(4096, "x"), 1, 0o600);
    filesystem.mkdir("/bin", 0o755);
    filesystem.writeFile("/bin/bash", readFileSync(bash), 0o755);
    filesystem.writeFile("/bin/coreutils", readFileSync(coreutils), 0o755);
    filesystem.writeFile("/bin/persistence-overwrite", readFileSync(mappingProgram), 0o755);
    for (const command of ["df", "tail", "rm", "rmdir", "sync", "mkdir", "ln", "mkfifo", "dd", "stat", "truncate"]) {
      filesystem.symlink("/bin/coreutils", "/bin/" + command);
    }
    const image = await filesystem.saveImage();
    const script = readFileSync(join(import.meta.dirname, "fixtures/persistent-inode-capacity.sh"), "utf8");
    const memory: { phase: string; pages: number }[] = [];
    let checkpointImage: Uint8Array | undefined;
    try {
      for (const phase of ["fill", "recover", "export", "checkpoint"]) {
        const output: string[] = [];
        const host = new NodeKernelHost({
          kernelMaxPages: 1024,
          rootfsImage: phase === "checkpoint" ? checkpointImage! : image,
          experimentalResizablePersistencePath: join(directory, phase === "checkpoint" ? "checkpoint-journal" : "journal"),
          requireExistingRootfsPersistence: phase === "recover" || phase === "export",
          onStdout: (_pid, bytes) => output.push(new TextDecoder().decode(bytes)),
          onStderr: (_pid, bytes) => output.push(new TextDecoder().decode(bytes)),
        });
        try {
          const kernelBytes = new Uint8Array(readFileSync(kernel));
          await host.init(kernelBytes.buffer.slice(
            kernelBytes.byteOffset,
            kernelBytes.byteOffset + kernelBytes.byteLength,
          ) as ArrayBuffer);
          if (phase === "export") {
            const snapshotPath = join(directory, "checkpoint.vfs");
            await host.exportRootfsImageToFile(snapshotPath);
            checkpointImage = new Uint8Array(readFileSync(snapshotPath));
            expect(KandeloImageFs.readImageCapacity(checkpointImage))
              .toEqual(KandeloImageFs.readImageCapacity(image));
            memory.push({ phase, pages: await host.getKernelMemoryPages() });
            continue;
          }
          const { exit } = await host.spawnFromVfs("/bin/bash", ["bash", "-c", script, "bash", phase], {
            env: ["PATH=/bin", "HOME=/"],
            uid: 0,
            gid: 0,
          });
          expect(await exit, output.join("")).toBe(0);
          expect(output.join("")).toContain(phase === "fill"
            ? "INODE_CAPACITY_FILLED"
            : phase === "recover" ? "INODE_CAPACITY_RECOVERED" : "INODE_CAPACITY_CHECKPOINTED");
          memory.push({ phase, pages: await host.getKernelMemoryPages() });
        } finally {
          await host.destroy();
        }
      }
      expect(memory).toHaveLength(4);
      expect(verified.requests()).toBe(3);
      for (const entry of memory) {
        expect(entry.pages, entry.phase).toBeGreaterThan(0);
        expect(entry.pages, entry.phase).toBeLessThanOrEqual(1024);
      }
      console.info("Persistent capacity kernel memory (64 KiB pages):", JSON.stringify(memory));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);

  it("reports logical capacity and guest writes through statfs on Node", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-persistent-statfs-"));
    const coreutilsBytes = new Uint8Array(readFileSync(coreutils));
    const output: string[] = [];
    const host = new NodeKernelHost({
      rootfsImage: new Uint8Array(readFileSync(shellImage)),
      rootfsLazyUrlBase: "https://kandelo.invalid/",
      rootfsLazyAssets: [{
        url: "https://kandelo.invalid/binaries/programs/wasm32/coreutils.wasm",
        sha256: createHash("sha256").update(coreutilsBytes).digest("hex"),
        size: coreutilsBytes.byteLength,
        bytes: coreutilsBytes,
      }],
      experimentalResizablePersistencePath: join(directory, "journal"),
      onStdout: (_pid, bytes) => output.push(new TextDecoder().decode(bytes)),
      onStderr: (_pid, bytes) => output.push(new TextDecoder().decode(bytes)),
    });
    try {
      const kernelBytes = new Uint8Array(readFileSync(kernel));
      await host.init(kernelBytes.buffer.slice(
        kernelBytes.byteOffset,
        kernelBytes.byteOffset + kernelBytes.byteLength,
      ) as ArrayBuffer);
      const script = [
        "set -eu",
        "read -r filesystem total used_before free_before percent mount < <(df -P -k / | tail -n 1)",
        "test \"$total\" -gt 0",
        "test \"$total\" -lt 1048576",
        "printf 'statfs probe\\n' > /home/projects/node-statfs-probe",
        "sync",
        "read -r filesystem total_after used_after free_after percent mount < <(df -P -k / | tail -n 1)",
        "test \"$total_after\" -eq \"$total\"",
        "test \"$free_after\" -lt \"$free_before\"",
        "printf 'STATFS_NODE_OK\\n'",
      ].join("\n");
      const { exit } = await host.spawnFromVfs("/bin/bash", ["bash", "-c", script], {
        env: ["PATH=/usr/bin:/bin", "HOME=/root"],
        uid: 0,
        gid: 0,
      });
      expect(await exit, output.join("")).toBe(0);
      expect(output.join("")).toContain("STATFS_NODE_OK");
    } finally {
      await host.destroy().catch(() => {});
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
