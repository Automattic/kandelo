/**
 * Checkpoint validation against a real captured machine.
 *
 * Every corruption case starts from a genuine `captureCheckpointBytes` result,
 * so a refusal proves the validator catches the corruption rather than an
 * artifact of a hand-built fixture. The pristine clone validates at the end,
 * which proves the refusals came from the corruption alone.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NodeKernelHost } from "../../src/node-kernel-host";
import { findRepoRoot } from "../../src/binary-resolver";
import { ABI_VERSION } from "../../src/generated/abi";
import { FORK_SAVE_BUFFER_SIZE } from "../../src/process-memory";
import type { MachineCheckpoint } from "../../src/migration/checkpoint";
import {
  CheckpointRefusedError,
  validateMachineCheckpoint,
} from "../../src/migration/restore";

const TIMEOUTS = { unwindTimeoutMs: 10_000, vforkTimeoutMs: 5_000 };
const EXPECTED = { kernelAbiVersion: ABI_VERSION };

function programBytes(name: string): ArrayBuffer {
  const bytes = readFileSync(join(findRepoRoot(), "examples", name));
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function captureRealCheckpoint(): Promise<MachineCheckpoint> {
  let ready = () => {};
  const isReady = new Promise<void>((resolve) => { ready = resolve; });
  let output = "";
  const host = new NodeKernelHost({
    rootfsImage: "default",
    onStdout: (_pid, data) => {
      output += new TextDecoder().decode(data);
      if (output.includes("READY")) ready();
    },
  });
  await host.init();
  try {
    await new Promise<void>((resolve) => {
      void host.spawn(programBytes("checkpoint-loop.wasm"), [
        "checkpoint-loop",
      ], { onStarted: () => resolve() });
    });
    await isReady;
    const response = await host.captureCheckpointBytes(TIMEOUTS);
    if (response.status !== "captured") {
      throw new Error(`capture failed: ${JSON.stringify(response)}`);
    }
    return response.checkpoint;
  } finally {
    await host.destroy();
  }
}

/** Deep copy so each corruption starts from the same captured machine. */
function cloneCheckpoint(checkpoint: MachineCheckpoint): MachineCheckpoint {
  return structuredClone(checkpoint);
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

describe("checkpoint validation", () => {
  it(
    "accepts a captured machine and refuses every corruption of it",
    { timeout: 60_000 },
    async () => {
      const captured = await captureRealCheckpoint();

      await expect(
        validateMachineCheckpoint(cloneCheckpoint(captured), EXPECTED),
      ).resolves.toEqual(
        new Map(
          captured.processes.map((bucket) => [
            bucket.pid,
            expect.any(WebAssembly.Module),
          ]),
        ),
      );

      const refusal = async (
        corrupt: (checkpoint: Mutable<MachineCheckpoint>) => void,
        reason: string | RegExp,
      ) => {
        const checkpoint = cloneCheckpoint(captured) as
          Mutable<MachineCheckpoint>;
        corrupt(checkpoint);
        const attempt = validateMachineCheckpoint(checkpoint, EXPECTED);
        await expect(attempt).rejects.toThrow(CheckpointRefusedError);
        await expect(attempt).rejects.toThrow(reason);
      };

      await refusal((checkpoint) => {
        (checkpoint as { format: number }).format = 999;
      }, "unknown checkpoint format 999");

      await refusal((checkpoint) => {
        (checkpoint as { kernelAbiVersion: number }).kernelAbiVersion =
          ABI_VERSION + 1;
      }, `kernel ABI ${ABI_VERSION + 1} does not match`);

      await refusal((checkpoint) => {
        (checkpoint as { kernelMemory: Uint8Array }).kernelMemory =
          checkpoint.kernelMemory.subarray(0, 100);
      }, "not a whole number of pages");

      await refusal((checkpoint) => {
        (checkpoint as { filesystem: Uint8Array }).filesystem =
          new Uint8Array(0);
      }, "the filesystem buffer is empty");

      await refusal((checkpoint) => {
        (checkpoint as { processes: unknown[] }).processes = [
          checkpoint.processes[0]!,
          checkpoint.processes[0]!,
        ];
      }, /appears in more than one process bucket/);

      await refusal((checkpoint) => {
        const bucket = checkpoint.processes[0]! as { memory: Uint8Array };
        bucket.memory = bucket.memory.subarray(1);
      }, /does not cover its whole buffer/);

      await refusal((checkpoint) => {
        const bucket = checkpoint.processes[0]! as { ptrWidth: number };
        bucket.ptrWidth = 5;
      }, /claims pointer width 5/);

      await refusal((checkpoint) => {
        const bucket = checkpoint.processes[0]! as { ptrWidth: number };
        bucket.ptrWidth = 8;
      }, /pointer width 8 but its program declares 4/);

      await refusal((checkpoint) => {
        const bucket = checkpoint.processes[0]! as {
          programBytes: ArrayBuffer;
        };
        bucket.programBytes = new Uint8Array([1, 2, 3, 4]).buffer;
      }, /is not a WebAssembly module/);

      await refusal((checkpoint) => {
        const bucket = checkpoint.processes[0]! as {
          programBytes: ArrayBuffer;
        };
        // Magic and version only: a valid module with no capability claim.
        bucket.programBytes =
          new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]).buffer;
      }, /does not claim activation-state-safe replay/);

      await refusal((checkpoint) => {
        const bucket = checkpoint.processes[0]! as { channelOffset: number };
        bucket.channelOffset = checkpoint.processes[0]!.memory.byteLength;
      }, /does not fit inside/);

      await refusal((checkpoint) => {
        const bucket = checkpoint.processes[0]!;
        new DataView(bucket.memory.buffer).setUint32(
          bucket.channelOffset - FORK_SAVE_BUFFER_SIZE,
          7,
          true,
        );
      }, /continuation root is unusable/);

      // The corruptions above never touched the captured object itself.
      await expect(
        validateMachineCheckpoint(cloneCheckpoint(captured), EXPECTED),
      ).resolves.toBeDefined();
    },
  );

  it(
    "boots a machine from a checkpoint's kernel and filesystem",
    { timeout: 120_000 },
    async () => {
      const waldo = new TextEncoder().encode("waldo\n");
      const keeper = new NodeKernelHost({ rootfsImage: "default" });
      await keeper.init();
      let checkpoint: MachineCheckpoint;
      let keeperPid = -1;
      try {
        // A process that ran and exited advances the kernel's pid counter,
        // which lives in kernel memory. The receiver proves it adopted that
        // memory by allocating the next pid rather than starting over.
        await expect(
          keeper.spawn(programBytes("test-pthread.wasm"), ["test-pthread"], {
            onStarted: (pid) => { keeperPid = pid; },
          }),
        ).resolves.toBe(0);
        await keeper.writeFileToVfs("/etc/waldo", waldo);
        // The exited spawn's worker may still be tearing down, and a freeze
        // that meets that teardown fails with "the process ended during the
        // checkpoint freeze" — truthfully and reversibly, so retry it.
        let response = await keeper.captureCheckpointBytes(TIMEOUTS);
        for (
          let attempt = 0;
          attempt < 10
          && response.status === "failed"
          && response.reason.includes("ended during the checkpoint freeze");
          attempt++
        ) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          response = await keeper.captureCheckpointBytes(TIMEOUTS);
        }
        if (response.status !== "captured") {
          throw new Error(`capture failed: ${JSON.stringify(response)}`);
        }
        checkpoint = response.checkpoint;
        expect(checkpoint.processes).toEqual([]);
      } finally {
        await keeper.destroy();
      }

      const receiver = new NodeKernelHost({
        rootfsImage: "default",
        restoreCheckpoint: checkpoint,
      });
      await receiver.init();
      try {
        // The filesystem is the captured one, not the image's fresh state.
        expect(await receiver.readFileFromVfs("/etc/waldo")).toEqual(waldo);

        // The restored machine is whole enough to be read again. Before the
        // spawn below: a capture that lands while an exited process is still
        // tearing down fails with "the process ended during the checkpoint
        // freeze", which is the freeze telling the truth, not this test's
        // subject.
        const second = await receiver.captureCheckpoint(TIMEOUTS);
        if (second.status !== "captured") {
          throw new Error(`second capture: ${JSON.stringify(second)}`);
        }

        let receiverPid = -1;
        await expect(
          receiver.spawn(programBytes("test-pthread.wasm"), ["test-pthread"], {
            onStarted: (pid) => { receiverPid = pid; },
          }),
        ).resolves.toBe(0);
        expect(receiverPid).toBeGreaterThan(keeperPid);
      } finally {
        await receiver.destroy();
      }
    },
  );

  it(
    "refuses to boot from a checkpoint it cannot adopt",
    { timeout: 120_000 },
    async () => {
      const keeper = new NodeKernelHost({ rootfsImage: "default" });
      await keeper.init();
      let checkpoint: MachineCheckpoint;
      try {
        const response = await keeper.captureCheckpointBytes(TIMEOUTS);
        if (response.status !== "captured") {
          throw new Error(`capture failed: ${JSON.stringify(response)}`);
        }
        checkpoint = response.checkpoint;
      } finally {
        await keeper.destroy();
      }

      const wrongAbi = cloneCheckpoint(checkpoint) as
        Mutable<MachineCheckpoint>;
      (wrongAbi as { kernelAbiVersion: number }).kernelAbiVersion =
        ABI_VERSION + 1;
      const refused = new NodeKernelHost({
        rootfsImage: "default",
        restoreCheckpoint: wrongAbi,
      });
      try {
        await expect(refused.init()).rejects.toThrow(
          `kernel ABI ${ABI_VERSION + 1} does not match`,
        );
      } finally {
        await refused.destroy().catch(() => undefined);
      }

      // A checkpoint with process buckets is valid input, but its consumer
      // does not exist yet; the boot says so instead of dropping the buckets.
      const withProcess = await captureRealCheckpoint();
      expect(withProcess.processes.length).toBeGreaterThan(0);
      const unimplemented = new NodeKernelHost({
        rootfsImage: "default",
        restoreCheckpoint: withProcess,
      });
      try {
        await expect(unimplemented.init()).rejects.toThrow(
          "restoring a checkpoint with processes is not implemented yet",
        );
      } finally {
        await unimplemented.destroy().catch(() => undefined);
      }
    },
  );
});
