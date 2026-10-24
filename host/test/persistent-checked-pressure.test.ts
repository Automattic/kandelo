import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { NodeKernelHost } from "../src/node-kernel-host";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { OverlayStorageFile } from "../src/vfs/overlay-storage";
import { resolveBinary } from "../src/binary-resolver";
import { parseFilesystemMemory, validateFilesystemMemoryBounds } from "./fixtures/filesystem-memory";
import type { StorageMemoryUsage } from "../src/vfs/storage-memory-budget";
import { checkedPressureImage, checkPressureSnapshot, PRESSURE_COLD_BYTES,
  PRESSURE_SAMPLE_OFFSETS, PRESSURE_SEED_FILES, pressureColdByte, pressureSeedPath, retainPressureFixture } from "./fixtures/checked-pressure-image";

const kernel = new Uint8Array(readFileSync(resolveBinary("kernel.wasm")));

for (const stage of ["construction", "snapshot"] as const) {
  it(`pressure ${stage} fixture attempts every cleanup and preserves uncertain storage`, async () => {
    const primary = new Error("primary fixture operation failed");
    const resetFailure = new Error("fixture reset failed");
    const closeFailure = new Error("target close failed");
    const reset = vi.fn(() => { throw resetFailure; });
    const targetClose = vi.fn(() => { throw closeFailure; });
    const sourceClose = vi.fn();
    const filesystem = { setImageCapacity: () => { throw primary; }, reset,
      exportPersistentImageTo: async () => { throw primary; } } as unknown as KandeloImageFs;
    const create = vi.spyOn(KandeloImageFs, stage === "construction" ? "createPositioned" : "createFromPositionedImage")
      .mockReturnValue(filesystem);
    const open = vi.spyOn(OverlayStorageFile, "open");
    if (stage === "snapshot") open.mockReturnValueOnce({ len: () => 128, close: sourceClose } as unknown as OverlayStorageFile);
    open.mockReturnValueOnce({ close: targetClose } as unknown as OverlayStorageFile);
    try {
      const failure = await (stage === "construction" ? checkedPressureImage("/unused", "crc32c")
        : checkPressureSnapshot("/unused", "crc32c")).catch(error => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.errors).toEqual([primary, resetFailure, closeFailure]);
      expect(retainPressureFixture(failure)).toBe(true);
      expect(reset).toHaveBeenCalledOnce();
      expect(targetClose).toHaveBeenCalledOnce();
      expect(sourceClose).toHaveBeenCalledTimes(stage === "snapshot" ? 1 : 0);
    } finally { create.mockRestore(); open.mockRestore(); }
  });
}

for (const policy of ["crc32c", "sha256"] as const) {
  it(`bounded ${policy} checked-base pressure preserves a large namespace, mappings, writeback and streamed snapshots`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-checked-pressure-"));
    let active: NodeKernelHost | undefined;
    let retainStorage = false;
    const phases: Array<{ phase: string; pages: number; elapsedMs: number; output: string }> = [];
    const memory: Array<{ phase: string; stage: string; admission: ReturnType<typeof parseFilesystemMemory>; host: StorageMemoryUsage; pages: number }> = [];
    try {
      const original = await checkedPressureImage(directory, policy);
      expect(original.physicalLength).toBeGreaterThan(PRESSURE_COLD_BYTES);
      expect(statSync(original.path).size).toBe(original.physicalLength);
      let snapshot: Awaited<ReturnType<typeof checkPressureSnapshot>> | undefined;
      for (const phase of ["write", "reopen", "snapshot", "snapshot-reopen"]) {
        const source = phase.startsWith("snapshot") ? snapshot! : original;
        const started = performance.now();
        let output = "";
        const accept = (_pid: number, bytes: Uint8Array) => { output = (output + new TextDecoder().decode(bytes)).slice(-16384); };
        active = new NodeKernelHost({ rootfsImageFile: source.path, rootfsPersistentImageBinding: source.binding,
          kernelMaxPages: 1024, maxPages: 1024, maxWorkers: 1,
          experimentalResizablePersistencePath: join(directory, phase.startsWith("snapshot") ? "snapshot.journal" : "journal"),
          requireExistingRootfsPersistence: phase.endsWith("reopen"), onStdout: accept, onStderr: accept });
        await active.init(kernel.buffer);
        const observeMemory = async (stage: string) => {
          const previousOutput = output;
          output = "";
          const observer = await active!.spawnFromVfs("/bin/pressure", ["pressure", "memory"]);
          expect(await observer.exit, output).toBe(0);
          const admission = parseFilesystemMemory(output);
          validateFilesystemMemoryBounds(admission);
          output = previousOutput;
          const host = await active!.getStorageMetadataMemoryUsage();
          const pages = await active!.getKernelMemoryPages();
          expect(pages).toBeLessThanOrEqual(1024);
          memory.push({ phase, stage, admission, host, pages });
        };
        await observeMemory("initialized");
        const process = await active.spawnFromVfs("/bin/pressure", ["pressure", phase === "write" ? "write" : "verify"]);
        expect(await process.exit, output).toBe(0);
        expect(output).toContain("AGGREGATE_PRESSURE_VERIFIED");
        if (phase === "write") expect(output).toMatch(/PRESSURE_REFUSAL created=\d+ errno=12/);
        await observeMemory("workload-complete");
        expect((await active.statVfsPath("/cold"))?.size).toBe(PRESSURE_COLD_BYTES);
        for (const offset of PRESSURE_SAMPLE_OFFSETS) {
          expect(await active.readFileRangeFromVfs("/cold", offset, 257)).toEqual(
            Uint8Array.from({ length: 257 }, (_, index) => pressureColdByte(offset + index)));
        }
        const entries = await active.readDirFromVfs("/seed");
        expect(entries?.length).toBe(PRESSURE_SEED_FILES);
        const names = new Set(Array.from({ length: PRESSURE_SEED_FILES }, (_, index) => pressureSeedPath(index).slice(6)));
        for (const entry of entries!) {
          expect(names.delete(entry.name)).toBe(true);
          expect(entry.mode & 0o777).toBe(0o640);
          expect(entry.size).toBe(0);
        }
        expect(names.size).toBe(0);
        if (phase === "snapshot") await active.writeFileToVfs("/snapshot-journal-only", new TextEncoder().encode(policy), 0o600);
        if (phase === "snapshot-reopen") {
          expect(new TextDecoder().decode((await active.readFileFromVfs("/snapshot-journal-only"))!)).toBe(policy);
        }
        if (phase === "write") {
          await active.exportRootfsImageToFile(join(directory, "snapshot.vfs"));
          await observeMemory("snapshot-export-complete");
        }
        const pages = await active.getKernelMemoryPages();
        expect(pages).toBeLessThanOrEqual(1024);
        phases.push({ phase, pages, elapsedMs: performance.now() - started, output });
        await active.destroy();
        expect(active.getPersistenceShutdownFailure()).toBeNull();
        active = undefined;
        if (phase === "write") snapshot = await checkPressureSnapshot(directory, policy);
      }
      console.info("checked aggregate pressure", JSON.stringify({ policy, physicalBytes: original.physicalLength,
        seedFiles: PRESSURE_SEED_FILES, kernelCeilingBytes: 64 * 1024 * 1024, phases, memory }));
    } catch (error) { retainStorage = retainPressureFixture(error); throw error; }
    finally {
      await active?.destroy();
      if (!retainStorage && active?.getPersistenceShutdownFailure() == null) rmSync(directory, { recursive: true, force: true });
      else console.error(`Retained checked pressure storage after unproven shutdown: ${directory}`);
    }
  }, 600_000);
}
