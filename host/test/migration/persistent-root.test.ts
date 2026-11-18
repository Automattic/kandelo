/**
 * A checkpoint of a machine whose `/` lives in a journal, restored on a host
 * that has neither its image nor its journal.
 *
 * The data cache holds one page, so the files written before the capture are
 * in the journal and not in kernel memory: a restore that carried kernel
 * memory alone would read them back wrong.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { NodeKernelHost } from "../../src/node-kernel-host";
import { resolveBinary } from "../../src/binary-resolver";
import type { MachineCheckpoint } from "../../src/migration/checkpoint";
import { CheckpointRefusedError, validateMachineCheckpoint } from "../../src/migration/restore";
import { validatePersistentRoot, type CheckpointPersistentRoot } from "../../src/migration/persistent-root";
import { ABI_VERSION } from "../../src/generated/abi";
import { persistentBaseFixture, preparePersistentBaseFixtures } from "../fixtures/persistent-base-image";

const TIMEOUTS = { unwindTimeoutMs: 10_000, vforkTimeoutMs: 5_000 };
const artifacts = join(import.meta.dirname, "../../../local-binaries/source-only-v1");

beforeAll(() => preparePersistentBaseFixtures(), 180_000);

function kernelBytes(): ArrayBuffer {
  const bytes = readFileSync(resolveBinary("kernel.wasm"));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pattern(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_, offset) => (offset * seed + Math.floor(offset / 4096)) & 255);
}

async function capture(host: NodeKernelHost): Promise<MachineCheckpoint> {
  const response = await host.captureCheckpointBytes(TIMEOUTS);
  if (response.status !== "captured") throw new Error(`capture failed: ${JSON.stringify(response)}`);
  return response.checkpoint;
}

async function restore(checkpoint: MachineCheckpoint, output?: string[]): Promise<NodeKernelHost> {
  const host = new NodeKernelHost({
    restoreCheckpoint: checkpoint,
    onStdout: (_pid, bytes) => output?.push(new TextDecoder().decode(bytes)),
    onStderr: (_pid, bytes) => output?.push(new TextDecoder().decode(bytes)),
  });
  try {
    await host.init(kernelBytes());
    return host;
  } catch (error) {
    await host.destroy();
    throw error;
  }
}

describe("persistent root checkpoint", () => {
  it("carries a checked base and its journal to a host that has neither", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-persistent-root-"));
    const journal = join(directory, "computer.journal");
    const files = [1, 2, 3].map(index => ({ path: `/home/maker/foo${index}`, bytes: pattern(1024 * 1024 + index, index * 17) }));
    try {
      const { path, binding, content } = await persistentBaseFixture(directory, "crc32c", undefined, undefined, 64 * 1024 * 1024);
      const original = new NodeKernelHost({
        rootfsImageFile: path,
        rootfsPersistentImageBinding: binding,
        experimentalResizablePersistencePath: journal,
      });
      let checkpoint: MachineCheckpoint;
      try {
        await original.init(kernelBytes());
        for (const file of files) await original.writeFileToVfs(file.path, file.bytes, 0o600);
        checkpoint = await capture(original);
      } finally {
        await original.destroy();
      }
      const root = checkpoint.persistentRoot!;
      const liveJournal = root.generation.slot === "legacy" ? journal : `${journal}.${root.generation.slot}.journal`;
      expect(root.binding).toEqual(binding);
      expect(root.image).toEqual(new Uint8Array(readFileSync(path)));
      expect(root.files.find(entry => entry.file === "journal" && entry.slot === root.generation.slot)!.bytes)
        .toEqual(new Uint8Array(readFileSync(liveJournal)));
      expect(checkpoint.rootfsImageSha256).toBeNull();
      const journalBefore = digest(readFileSync(liveJournal));

      await expect(validateMachineCheckpoint(structuredClone(checkpoint), {
        kernelAbiVersion: ABI_VERSION, rootfsImageSha256: "0".repeat(64),
      })).rejects.toThrow(/travels with its checkpoint/);
      const missingJournal = structuredClone(checkpoint);
      (missingJournal.persistentRoot as { files: unknown }).files = root.files.filter(entry => entry.file !== "journal");
      await expect(validateMachineCheckpoint(missingJournal, { kernelAbiVersion: ABI_VERSION, rootfsImageSha256: null }))
        .rejects.toThrow(CheckpointRefusedError);

      const doubled = new NodeKernelHost({ restoreCheckpoint: structuredClone(checkpoint), rootfsImageFile: path });
      await expect(doubled.init(kernelBytes())).rejects.toThrow(/brings its own image and journal/);
      await doubled.destroy();

      const replica = await restore(checkpoint);
      try {
        for (const file of files) expect(digest((await replica.readFileFromVfs(file.path))!)).toBe(digest(file.bytes));
        expect(await replica.readFileFromVfs("/large")).toEqual(content);
        await replica.writeFileToVfs("/home/maker/bar", pattern(2 * 1024 * 1024, 29), 0o600);
        expect(digest((await replica.readFileFromVfs("/home/maker/bar"))!)).toBe(digest(pattern(2 * 1024 * 1024, 29)));
        const again = await capture(replica);
        expect(again.persistentRoot!.image).toEqual(root.image);
        expect(again.persistentRoot!.binding).toEqual(binding);
      } finally {
        await replica.destroy();
      }
      expect(digest(readFileSync(liveJournal))).toBe(journalBefore);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);

  it("compacts a restored unchecked journal past its tail bound", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-persistent-root-tail-"));
    const output: string[] = [];
    const coreutils = new Uint8Array(readFileSync(join(artifacts, "programs/wasm32/coreutils.wasm")));
    try {
      const original = new NodeKernelHost({
        rootfsImage: new Uint8Array(readFileSync(join(artifacts, "programs/wasm32/shell.vfs.zst"))),
        rootfsLazyUrlBase: "https://kandelo.invalid/",
        rootfsLazyAssets: [{
          url: "https://kandelo.invalid/binaries/programs/wasm32/coreutils.wasm",
          sha256: digest(coreutils),
          size: coreutils.byteLength,
          bytes: coreutils,
        }],
        experimentalResizablePersistencePath: join(directory, "journal"),
      });
      let checkpoint: MachineCheckpoint;
      try {
        await original.init(kernelBytes());
        await original.writeFileToVfs("/home/maker/foo", pattern(1024 * 1024, 7), 0o644);
        checkpoint = await capture(original);
      } finally {
        await original.destroy();
      }
      expect(checkpoint.persistentRoot!.binding).toBeNull();

      const replica = await restore(checkpoint, output);
      try {
        const { exit } = await replica.spawnFromVfs("/bin/bash", ["bash", "-ec", `
          test "$(sha256sum < /home/maker/foo)" = "${digest(pattern(1024 * 1024, 7))}  -"
          for i in 1 2 3; do
            dd if=/dev/urandom of=/home/maker/bar$i bs=65536 count=528
          done
          for i in 1 2 3; do test "$(stat -c %s /home/maker/bar$i)" = 34603008; done
          printf 'REPLICA_PAST_TAIL\\n'
        `], { env: ["PATH=/usr/bin:/bin", "HOME=/root"] });
        expect(await exit, output.join("")).toBe(0);
        expect(output.join("")).toContain("REPLICA_PAST_TAIL");
      } finally {
        await replica.destroy();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 180_000);

  it("captures while a write waits for compaction at the tail bound", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kandelo-persistent-root-park-"));
    const output: string[] = [];
    const coreutils = new Uint8Array(readFileSync(join(artifacts, "programs/wasm32/coreutils.wasm")));
    try {
      const original = new NodeKernelHost({
        rootfsImage: new Uint8Array(readFileSync(join(artifacts, "programs/wasm32/shell.vfs.zst"))),
        rootfsLazyUrlBase: "https://kandelo.invalid/",
        rootfsLazyAssets: [{
          url: "https://kandelo.invalid/binaries/programs/wasm32/coreutils.wasm",
          sha256: digest(coreutils),
          size: coreutils.byteLength,
          bytes: coreutils,
        }],
        experimentalResizablePersistencePath: join(directory, "journal"),
        onStdout: (_pid, bytes) => output.push(new TextDecoder().decode(bytes)),
        onStderr: (_pid, bytes) => output.push(new TextDecoder().decode(bytes)),
      });
      const statuses: string[] = [];
      let checkpoint: MachineCheckpoint | undefined;
      try {
        await original.init(kernelBytes());
        await original.writeFileToVfs("/home/maker/foo", pattern(1024 * 1024, 11), 0o644);
        const { exit } = await original.spawnFromVfs("/bin/bash", ["bash", "-ec", `
          for i in 1 2 3; do
            dd if=/dev/urandom of=/home/maker/bar$i bs=65536 count=528
          done
          for i in 1 2 3; do test "$(stat -c %s /home/maker/bar$i)" = 34603008; done
          printf 'ORIGINAL_PAST_TAIL\\n'
        `], { env: ["PATH=/usr/bin:/bin", "HOME=/root"] });
        let exited = false;
        const status = exit.finally(() => { exited = true; });
        while (!exited) {
          const response = await original.captureCheckpointBytes(TIMEOUTS);
          statuses.push(response.status === "captured" ? "captured" : `${response.status}: ${response.reason}`);
          if (response.status === "captured") checkpoint = response.checkpoint;
        }
        expect(await status, output.join("")).toBe(0);
      } finally {
        await original.destroy();
      }
      expect(output.join("")).toContain("ORIGINAL_PAST_TAIL");
      expect(statuses.filter(status => status !== "captured")).toEqual([]);
      expect(checkpoint).toBeDefined();

      const replica = await restore(checkpoint!);
      try {
        expect(digest((await replica.readFileFromVfs("/home/maker/foo"))!)).toBe(digest(pattern(1024 * 1024, 11)));
      } finally {
        await replica.destroy();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 300_000);
});

describe("persistent root validation", () => {
  const root = (change: Partial<CheckpointPersistentRoot> = {}): CheckpointPersistentRoot => ({
    image: new Uint8Array([1]),
    binding: null,
    files: [{ slot: "legacy", file: "journal", bytes: new Uint8Array() }],
    generation: { slot: "legacy" } as CheckpointPersistentRoot["generation"],
    slots: { journal: 0, index: null },
    ...change,
  });

  it("accepts a root whose live generation has its journal", () => {
    expect(validatePersistentRoot(root())).toBeNull();
  });

  it.each([
    ["an invalid binding", { binding: {} as CheckpointPersistentRoot["binding"] }, /image binding is invalid/],
    ["no base image", { image: new Uint8Array() }, /carries no base image/],
    ["a kernel slot out of range", { slots: { journal: 3 as 0, index: null } }, /kernel slots are invalid/],
    ["the journal and index in one slot", { slots: { journal: 1, index: 1 } }, /kernel slots are invalid/],
    ["a file its slot does not hold", { files: [{ slot: "legacy", file: "seal", bytes: new Uint8Array() }] }, /invalid file "legacy.seal"/],
    ["a file twice", { files: [
      { slot: "legacy", file: "journal", bytes: new Uint8Array() },
      { slot: "legacy", file: "journal", bytes: new Uint8Array() },
    ] }, /legacy.journal twice/],
    ["an index slot without its index file", { slots: { journal: 0, index: 1 } }, /live generation does not match its files/],
  ] as const)("refuses %s", (_name, change, reason) => {
    expect(validatePersistentRoot(root(change as Partial<CheckpointPersistentRoot>))).toMatch(reason);
  });
});
