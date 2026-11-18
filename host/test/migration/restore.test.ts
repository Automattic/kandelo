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
import {
  NodeKernelHost,
  resolveRootfsArtifact,
} from "../../src/node-kernel-host";
import {
  DEFAULT_MOUNT_SPEC,
  type MountSpec,
} from "../../src/vfs/default-mounts";
import { findRepoRoot, resolveBinary } from "../../src/binary-resolver";
import { doomSharewareWad } from "../support/doom-shareware";
import {
  ABI_VERSION,
  PROCESS_METADATA_ENTRY_MAX_BYTES,
  PROCESS_STARTUP_MAX_ARGV_COUNT,
} from "../../src/generated/abi";
import { FORK_SAVE_BUFFER_SIZE } from "../../src/process-memory";
import { maybeDecompressImage } from "../../src/vfs/vfs-image-transport";
import {
  rootfsImageSha256,
  type MachineCheckpoint,
} from "../../src/migration/checkpoint";
import {
  CheckpointRefusedError,
  describeCheckpointMountGaps,
  validateMachineCheckpoint,
} from "../../src/migration/restore";

const TIMEOUTS = { unwindTimeoutMs: 10_000, vforkTimeoutMs: 5_000 };

/**
 * What a host booted over the default `/` image expects of a checkpoint.
 *
 * The image is hashed here, apart from the capture, so a capture that named
 * the wrong image fails the accepting path rather than agreeing with itself.
 */
async function defaultHostExpectation(): Promise<{
  kernelAbiVersion: number;
  rootfsImageSha256: string;
}> {
  const image = maybeDecompressImage(
    new Uint8Array(readFileSync(resolveRootfsArtifact().selectedPath)),
  );
  return {
    kernelAbiVersion: ABI_VERSION,
    rootfsImageSha256: await rootfsImageSha256(image),
  };
}

function programBytes(name: string): ArrayBuffer {
  const bytes = readFileSync(join(findRepoRoot(), "examples", name));
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

async function captureRealCheckpoint(
  program = "checkpoint-loop.wasm",
  rootfsMountSpec?: readonly MountSpec[],
): Promise<MachineCheckpoint> {
  let ready = () => {};
  const isReady = new Promise<void>((resolve) => { ready = resolve; });
  let output = "";
  const host = new NodeKernelHost({
    rootfsImage: "default",
    rootfsMountSpec,
    onStdout: (_pid, data) => {
      output += new TextDecoder().decode(data);
      if (output.includes("READY")) ready();
    },
  });
  await host.init();
  try {
    await new Promise<void>((resolve) => {
      void host.spawn(programBytes(program), [
        program.replace(/\.wasm$/, ""),
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
      const expected = await defaultHostExpectation();

      await expect(
        validateMachineCheckpoint(cloneCheckpoint(captured), expected),
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
        const attempt = validateMachineCheckpoint(checkpoint, expected);
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

      // `/` reads every file the machine never modified out of its boot
      // image, by offset, so the same kernel memory over another image would
      // read the wrong bytes.
      const otherImage = "0".repeat(64);
      await refusal((checkpoint) => {
        (checkpoint as { rootfsImageSha256: string | null })
          .rootfsImageSha256 = otherImage;
      }, `the machine booted / image ${otherImage}, `
        + `and this host booted ${expected.rootfsImageSha256}`);

      // An image streamed from a file has no identity, so a second host
      // streaming another file would also answer null.
      const unidentified = cloneCheckpoint(captured) as Mutable<MachineCheckpoint>;
      unidentified.rootfsImageSha256 = null;
      await expect(
        validateMachineCheckpoint(unidentified, { ...expected, rootfsImageSha256: null }),
      ).rejects.toThrow("an image with no identity");

      // A restore printing the gaps would name one host mount twice.
      await refusal((checkpoint) => {
        (checkpoint as { unreadableFilesystems: unknown }).unreadableFilesystems =
          [
            { mountPoint: "/run", reason: "no" },
            { mountPoint: "/run", reason: "no" },
          ];
      }, 'mount point "/run" appears twice');

      await refusal((checkpoint) => {
        (checkpoint as { unreadableFilesystems: unknown }).unreadableFilesystems =
          [{ mountPoint: "tmp", reason: "no" }];
      }, "is not absolute");

      // The reason is printed unaltered, and a peer wrote it.
      await refusal((checkpoint) => {
        (checkpoint as { unreadableFilesystems: unknown }).unreadableFilesystems =
          [{ mountPoint: "/tmp", reason: "x".repeat(201) }];
      }, "is 201 characters");

      await refusal((checkpoint) => {
        (checkpoint as { unreadableFilesystems: unknown }).unreadableFilesystems =
          [{ mountPoint: "/tmp", reason: "" }];
      }, "is 0 characters");

      await refusal((checkpoint) => {
        (checkpoint as { unreadableFilesystems: unknown }).unreadableFilesystems =
          undefined;
      }, "carries no unreadable-mount list");

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
        const bucket = checkpoint.processes[0]! as { argv: unknown };
        bucket.argv = new Array(PROCESS_STARTUP_MAX_ARGV_COUNT + 1).fill("a");
      }, /argv list is unusable/);

      await refusal((checkpoint) => {
        const bucket = checkpoint.processes[0]! as { env: unknown };
        bucket.env = [7];
      }, /environment carries a non-string entry/);

      await refusal((checkpoint) => {
        const bucket = checkpoint.processes[0]! as { env: unknown };
        bucket.env = ["x".repeat(PROCESS_METADATA_ENTRY_MAX_BYTES + 1)];
      }, /environment carries a 65537-byte entry/);

      await refusal((checkpoint) => {
        const bucket = checkpoint.processes[0]! as { env: unknown };
        bucket.env = new Array(64).fill(
          "x".repeat(PROCESS_METADATA_ENTRY_MAX_BYTES),
        );
      }, /environment exceeds ARG_MAX/);

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

      await refusal((checkpoint) => {
        (checkpoint as { monotonicNs: number }).monotonicNs = -1;
      }, /captured monotonic clock -1 is unusable/);

      await refusal((checkpoint) => {
        (checkpoint as { framebuffers: unknown[] }).framebuffers = [
          { pid: 424242, addr: 0, len: 0, w: 8, h: 8, stride: 32,
            fmt: "BGRA32", hostBuffer: new Uint8Array(256) },
        ];
      }, /names pid 424242, which has no process bucket/);

      await refusal((checkpoint) => {
        (checkpoint as { framebuffers: unknown[] }).framebuffers = [
          { pid: checkpoint.processes[0]!.pid, addr: 0, len: 0, w: 8, h: 8,
            stride: 32, fmt: "BGRA32", hostBuffer: new Uint8Array(7) },
        ];
      }, /carries 7 pixel bytes for a 256-byte frame/);

      await refusal((checkpoint) => {
        (checkpoint as { framebuffers: unknown[] }).framebuffers = [
          { pid: checkpoint.processes[0]!.pid, addr: 4096, len: 256, w: 8,
            h: 8, stride: 32, fmt: "BGRA32", hostBuffer: new Uint8Array(256) },
        ];
      }, /carries host pixels/);

      await refusal((checkpoint) => {
        const bucket = checkpoint.processes[0]!;
        (checkpoint as { framebuffers: unknown[] }).framebuffers = [
          { pid: bucket.pid, addr: bucket.memory.byteLength, len: 256, w: 8,
            h: 8, stride: 32, fmt: "BGRA32", hostBuffer: null },
        ];
      }, /framebuffer range does not fit inside/);

      // A modeset display bound to the captured machine's own process, which
      // every KMS corruption below starts from.
      const modeset = (checkpoint: MachineCheckpoint) => {
        const pid = checkpoint.processes[0]!.pid;
        return {
          fbs: [{
            fb_id: 10,
            bo_id: 100,
            width: 8,
            height: 8,
            pixel_format: 0x34325258,
            pitch: 32,
          }],
          crtcs: [{ crtc_id: 1, fb_id: 10 } as Mutable<MachineCheckpoint["kms"]["crtcs"][number]>],
          masterPid: pid,
          master: { fileId: "1", leaseId: "1" } as MachineCheckpoint["kms"]["master"],
          lastMasterLeaseId: "1",
          gammas: [] as { crtc_id: number; table: Uint8Array }[],
          cursor: { bo: 0, fbId: 0, x: 0, y: 0, hotX: 0, hotY: 0, width: 0, height: 0 },
          buffers: [{
            bo_id: 100,
            size: 256,
            w: 8,
            h: 8,
            stride: 32,
            pids: [pid],
            bindings: [{ pid, addr: 0, len: 256 }],
            pixels: new Uint8Array(256),
          }],
        };
      };

      await refusal((checkpoint) => {
        const kms = modeset(checkpoint);
        kms.fbs[0]!.bo_id = 424242;
        checkpoint.kms = kms;
      }, /buffer object 424242, which the checkpoint does not carry/);

      await refusal((checkpoint) => {
        const kms = modeset(checkpoint);
        kms.buffers[0]!.pixels = new Uint8Array(7);
        checkpoint.kms = kms;
      }, /carries 7 pixel bytes for a 256-byte buffer/);

      await refusal((checkpoint) => {
        const kms = modeset(checkpoint);
        kms.buffers[0]!.pids = [424242];
        checkpoint.kms = kms;
      }, /held by pid 424242, which has no process bucket/);

      await refusal((checkpoint) => {
        const kms = modeset(checkpoint);
        kms.buffers[0]!.pids = [];
        checkpoint.kms = kms;
      }, /buffer object 100 is held by no process/);

      await refusal((checkpoint) => {
        const kms = modeset(checkpoint);
        kms.buffers[0]!.bindings[0]!.pid = 424242;
        checkpoint.kms = kms;
      }, /mapped by pid 424242, which has no process bucket/);

      await refusal((checkpoint) => {
        const kms = modeset(checkpoint);
        kms.buffers[0]!.bindings[0]!.addr =
          checkpoint.processes[0]!.memory.byteLength;
        checkpoint.kms = kms;
      }, /mapping in pid \d+ does not fit inside/);

      await refusal((checkpoint) => {
        const kms = modeset(checkpoint);
        kms.crtcs.push({ crtc_id: 1, fb_id: 10 });
        checkpoint.kms = kms;
      }, /CRTC 1 is bound twice/);

      await refusal((checkpoint) => {
        const kms = modeset(checkpoint);
        kms.masterPid = 424242;
        checkpoint.kms = kms;
      }, /DRM master is pid 424242, which has no process bucket/);

      await refusal((checkpoint) => {
        const kms = modeset(checkpoint);
        kms.fbs[0]!.pitch = 31;
        checkpoint.kms = kms;
      }, /framebuffer 10's geometry is unusable/);

      await refusal((checkpoint) => {
        const kms = modeset(checkpoint);
        kms.crtcs[0]!.viewport = { x: 0, y: 0, width: 0, height: 8 };
        checkpoint.kms = kms;
      }, /CRTC 1's viewport is unusable/);

      await refusal((checkpoint) => {
        const kms = modeset(checkpoint);
        kms.master = { fileId: "1", leaseId: "18446744073709551616" };
        checkpoint.kms = kms;
      }, /DRM master grant names file 1 and lease 18446744073709551616/);

      await refusal((checkpoint) => {
        const kms = modeset(checkpoint);
        kms.master = { fileId: "1", leaseId: "2" };
        checkpoint.kms = kms;
      }, /DRM master lease 2 is newer than the newest lease 1/);

      await refusal((checkpoint) => {
        const kms = modeset(checkpoint);
        kms.gammas.push({ crtc_id: 1, table: new Uint8Array(767) });
        checkpoint.kms = kms;
      }, /CRTC 1's gamma table is not 768 bytes/);

      await refusal((checkpoint) => {
        const kms = modeset(checkpoint);
        kms.cursor = { ...kms.cursor, bo: 100, fbId: 0, width: 16, height: 16 };
        checkpoint.kms = kms;
      }, /cursor plane's image or geometry is unusable/);

      await refusal((checkpoint) => {
        const kms = modeset(checkpoint);
        kms.cursor = { ...kms.cursor, bo: 424242, fbId: 11, width: 16, height: 16 };
        checkpoint.kms = kms;
      }, /cursor plane shows buffer object 424242, which the checkpoint does not carry/);

      // A GL device bound to the captured machine's own process: one GPU
      // BO a GBM window surface renders into, one session that draws a
      // texture into a framebuffer. Every GL corruption below starts here.
      const glDevice = (checkpoint: MachineCheckpoint) => {
        const pid = checkpoint.processes[0]!.pid;
        return {
          gpuBos: [{ boId: 200, texId: 0x6000_0000, width: 2, height: 2, format: 0x34325258, pixels: new Uint8Array(16) }],
          sessions: [{
            pid,
            sessionId: 1,
            displayFileId: "1",
            cmdbufAddr: 0,
            cmdbufLen: 16,
            crtcId: 1,
            surface: { surfaceId: 1, kind: 1, width: 2, height: 2, samples: 0, targetBoId: 200, borrowedBoId: 200 },
            context: { contextId: 1, robustAccess: false },
            drawable: { drawSurfaceId: 1, readSurfaceId: 1, width: 2, height: 2 },
            buffers: [],
            textures: [{
              name: 3,
              levels: [{
                level: 0, internalFormat: 0x1908, width: 2, height: 2, format: 0x1908, type: 0x140b,
                pixels: new Uint8Array(32),
              }],
              minFilter: 0x2601, magFilter: 0x2601, wrapS: 0x812f, wrapT: 0x812f,
            }],
            foreignTextures: [{
              name: 0x6000_0000, boId: 200, width: 2, height: 2, pixels: null as Uint8Array | null,
              minFilter: 0x2601, magFilter: 0x2601, wrapS: 0x812f, wrapT: 0x812f,
            }],
            nextForeignTexId: 0x4000_0000,
            renderbuffers: [],
            shaders: [],
            programs: [{
              name: 4, shaders: [], attribBindings: [], linked: false, deletePending: false,
              uniforms: [{ name: "dt", type: 0x1406, guestType: 0x1406, size: 1, array: false, location: 0 }],
              values: [],
            }],
            vertexArrays: [],
            framebuffers: [{
              name: 5,
              attachments: [{ attachment: 0x8ce0, kind: "texture" as const, target: 0x0de1, name: 3, level: 0 }],
            }],
            state: null,
            errors: [],
            boundaries: [],
            programCaptures: { next: 2, handles: [{ handle: 1, name: 4 }] },
            programJournalOrder: { sequence: 3, nextJournal: 2 } as { sequence: number; nextJournal: number } | null,
            programJournal: {
              id: 1, capacity: 256, guestMetadata: true, nextGeneration: 2, published: 3, executed: 3,
              current: 1, logicalName: 4, generations: [{ token: 1, name: 4, cache: true }],
              slots: [{ index: 0, ticket: 3, sequence: 3 }], uniformCpu: true, buffers: null,
              framebuffers: Array.from({ length: 16 }, (_, index) => index === 0
                ? { token: 7, framebuffer: 5, inputs: [{ unit: 0, texture: 3 }] }
                : { token: 0, framebuffer: 0, inputs: [] as { unit: number; texture: number }[] }),
              ownedDraws: Array.from({ length: 16 }, () => ({ token: 2, family: 0, target: 0, targetToken: 7, ready: true })),
            },
            programJournalReceipt: [0, 9, 13, 1, 0, 3, 0, 3, 0, 3, 0, 0x47514c33],
          }],
        };
      };

      const scanningGpuBo = cloneCheckpoint(captured) as Mutable<MachineCheckpoint>;
      scanningGpuBo.gl = glDevice(scanningGpuBo);
      scanningGpuBo.kms = { ...modeset(scanningGpuBo), buffers: [] };
      scanningGpuBo.kms.fbs[0]!.bo_id = 200;
      await expect(validateMachineCheckpoint(scanningGpuBo, expected)).resolves.toBeInstanceOf(Map);

      await refusal((checkpoint) => {
        const gl = glDevice(checkpoint);
        gl.gpuBos[0]!.pixels = new Uint8Array(15);
        checkpoint.gl = gl;
      }, /GPU BO 200 carries 15 pixel bytes/);

      await refusal((checkpoint) => {
        const gl = glDevice(checkpoint);
        gl.sessions[0]!.pid = 424242;
        checkpoint.gl = gl;
      }, /a GL session names pid 424242, which has no process bucket/);

      await refusal((checkpoint) => {
        const gl = glDevice(checkpoint);
        gl.sessions[0]!.surface.borrowedBoId = 201;
        checkpoint.gl = gl;
      }, /GL session 1's surface is unusable/);

      await refusal((checkpoint) => {
        const gl = glDevice(checkpoint);
        gl.sessions[0]!.textures[0]!.levels[0]!.pixels = new Uint8Array(16);
        checkpoint.gl = gl;
      }, /GL texture 3 level 0 carries unusable texels/);

      await refusal((checkpoint) => {
        const gl = glDevice(checkpoint);
        gl.gpuBos.push({ ...gl.gpuBos[0]!, boId: 201 });
        checkpoint.gl = gl;
      }, /GPU BO 201 carries an unusable texture id/);

      await refusal((checkpoint) => {
        const gl = glDevice(checkpoint);
        gl.sessions[0]!.foreignTextures[0]!.boId = 201;
        checkpoint.gl = gl;
      }, /GL foreign texture 1610612736 carries unusable texels/);

      await refusal((checkpoint) => {
        const gl = glDevice(checkpoint);
        gl.sessions[0]!.foreignTextures[0]!.pixels = new Uint8Array(15);
        checkpoint.gl = gl;
      }, /GL foreign texture 1610612736 carries unusable texels/);

      await refusal((checkpoint) => {
        const gl = glDevice(checkpoint);
        gl.sessions[0]!.foreignTextures[0]!.name = 3;
        checkpoint.gl = gl;
      }, /carries GL texture 3 twice/);

      await refusal((checkpoint) => {
        const gl = glDevice(checkpoint);
        gl.sessions[0]!.framebuffers[0]!.attachments[0]!.name = 9;
        checkpoint.gl = gl;
      }, /GL framebuffer 5 names texture 9, which the checkpoint does not carry/);

      await refusal((checkpoint) => {
        const gl = glDevice(checkpoint);
        gl.sessions[0]!.programs[0]!.uniforms[0]!.type = 0x8b5f;
        checkpoint.gl = gl;
      }, /GL program 4 numbers an unusable uniform/);

      await refusal((checkpoint) => {
        const gl = glDevice(checkpoint);
        gl.sessions[0]!.programJournal.generations[0]!.name = 9;
        checkpoint.gl = gl;
      }, /program journal names program 9, which the checkpoint does not carry/);

      await refusal((checkpoint) => {
        const gl = glDevice(checkpoint);
        gl.sessions[0]!.programJournal.framebuffers[0]!.inputs[0]!.texture = 9;
        checkpoint.gl = gl;
      }, /framebuffer snapshot names texture 9, which the checkpoint does not carry/);

      await refusal((checkpoint) => {
        const gl = glDevice(checkpoint);
        gl.sessions[0]!.programJournalOrder = null;
        checkpoint.gl = gl;
      }, /GL session 1's program journal is unusable/);

      await refusal((checkpoint) => {
        const gl = glDevice(checkpoint);
        gl.sessions[0]!.programCaptures.handles[0]!.handle = 2;
        checkpoint.gl = gl;
      }, /program capture 2 is unusable/);

      await refusal((checkpoint) => {
        const gl = glDevice(checkpoint);
        gl.sessions[0]!.programJournalReceipt.pop();
        checkpoint.gl = gl;
      }, /carries an unusable program journal receipt/);

      // The corruptions above never touched the captured object itself.
      await expect(
        validateMachineCheckpoint(cloneCheckpoint(captured), expected),
      ).resolves.toBeDefined();

      // DRM leaves a CRTC modeset when its framebuffer goes, so a CRTC naming
      // an absent fb_id is a real machine's state, not a broken record.
      const staleBinding = cloneCheckpoint(captured) as Mutable<MachineCheckpoint>;
      const kms = modeset(staleBinding);
      kms.fbs = [];
      staleBinding.kms = kms;
      await expect(
        validateMachineCheckpoint(staleBinding, expected),
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

    },
  );

  it(
    "says which filesystems a restored Node machine did not get",
    { timeout: 120_000 },
    async () => {
      // The kernel carries `/` and every scratch mount it owns, so a default
      // Node machine leaves nothing behind.
      const whole = await captureRealCheckpoint();
      expect(whole.unreadableFilesystems).toEqual([]);

      // A scratch mount outside the kernel's prefixes is a host directory,
      // which stays with this computer. A restore that reported nothing would
      // present the machine as whole.
      const spec: MountSpec[] = [
        ...DEFAULT_MOUNT_SPEC,
        { path: "/mnt/session", source: "scratch", mode: 0o755, nosuid: true },
      ];
      const checkpoint = await captureRealCheckpoint(undefined, spec);
      expect(checkpoint.unreadableFilesystems).toEqual([
        {
          mountPoint: "/mnt/session",
          reason: "a host directory stays with the computer that mounts it",
        },
      ]);
      const diagnostics: string[] = [];
      const receiver = new NodeKernelHost({
        rootfsImage: "default",
        rootfsMountSpec: spec,
        restoreCheckpoint: checkpoint,
        onHostDiagnostic: (diagnostic) => {
          if (diagnostic.source === "checkpoint restore") {
            diagnostics.push(diagnostic.message);
          }
        },
      });
      await receiver.init();
      try {
        expect(diagnostics).toEqual([
          "this machine was restored without /mnt/session "
          + "(a host directory stays with the computer that mounts it)",
        ]);
      } finally {
        await receiver.destroy();
      }
    },
  );

  it(
    "restores a checkpointed process that keeps running",
    { timeout: 120_000 },
    async () => {
      const checkpoint = await captureRealCheckpoint();
      expect(checkpoint.processes.length).toBe(1);
      const pid = checkpoint.processes[0]!.pid;

      const receiver = new NodeKernelHost({
        rootfsImage: "default",
        restoreCheckpoint: checkpoint,
      });
      await receiver.init();
      try {
        expect(await receiver.signalProcess(pid, 0)).toBe(true);

        // The strongest liveness proof a checkpoint-loop guest offers: a
        // capture completes only when the process crosses a syscall boundary
        // and unwinds, so a captured recapture means the restored process
        // genuinely resumed its loop in the fresh instance.
        const recapture = await receiver.captureCheckpointBytes(TIMEOUTS);
        if (recapture.status !== "captured") {
          throw new Error(`recapture: ${JSON.stringify(recapture)}`);
        }
        expect(
          recapture.checkpoint.processes.map((bucket) => bucket.pid),
        ).toEqual([pid]);
      } finally {
        await receiver.destroy();
      }

      // A host whose memory configuration differs computes a different
      // process layout, and a captured image copied into the wrong layout
      // would put the channel and thread arena at the wrong addresses.
      const mismatched = new NodeKernelHost({
        rootfsImage: "default",
        maxPages: 4096,
        restoreCheckpoint: checkpoint,
      });
      try {
        await expect(mismatched.init()).rejects.toThrow(
          "does not match this host's computed",
        );
      } finally {
        await mismatched.destroy().catch(() => undefined);
      }
    },
  );

  it(
    "serves epoll_wait from a restored machine",
    { timeout: 120_000 },
    async () => {
      // The captured guest registered its pipe before the freeze. The interest
      // list lives on the kernel's epoll description, so it arrives inside
      // the kernel memory copy; a restore that lost it would answer EBADF
      // and the guest's tick would die.
      const checkpoint = await captureRealCheckpoint("checkpoint-epoll.wasm");
      const pid = checkpoint.processes[0]!.pid;

      let output = "";
      let sawTick = () => {};
      const ticked = new Promise<void>((resolve) => { sawTick = resolve; });
      const receiver = new NodeKernelHost({
        rootfsImage: "default",
        restoreCheckpoint: checkpoint,
        onStdout: (_pid, data) => {
          output += new TextDecoder().decode(data);
          if (output.includes("TICK")) sawTick();
        },
      });
      await receiver.init();
      try {
        await ticked;
        expect(output).not.toContain("EPOLL_ERR");
      } finally {
        await receiver.destroy();
      }
    },
  );

  it(
    "restores a running fbDOOM that keeps playing",
    { timeout: 180_000 },
    async () => {
      const fbdoomBytes = readFileSync(resolveBinary("programs/fbdoom/fbdoom.wasm"));
      const fbdoom = fbdoomBytes.buffer.slice(
        fbdoomBytes.byteOffset,
        fbdoomBytes.byteOffset + fbdoomBytes.byteLength,
      ) as ArrayBuffer;
      const wad = await doomSharewareWad();

      let ptyOutput = "";
      const keeper = new NodeKernelHost({
        rootfsImage: "default",
        onPtyOutput: (_pid, data) => {
          ptyOutput += new TextDecoder().decode(data);
        },
      });
      await keeper.init();
      let checkpoint: MachineCheckpoint;
      try {
        await keeper.writeFileToVfs("/doom1.wad", wad);
        await new Promise<void>((resolve) => {
          void keeper.spawn(fbdoom, ["fbdoom", "-iwad", "/doom1.wad"], {
            pty: true,
            env: ["AUDIODEV=/nonexistent-dsp"],
            onStarted: () => resolve(),
          });
        });
        await expect
          .poll(() => ptyOutput.includes("ST_Init"), { timeout: 60_000 })
          .toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        const response = await keeper.captureCheckpointBytes(TIMEOUTS);
        if (response.status !== "captured") {
          throw new Error(`capture failed: ${JSON.stringify(response)}`);
        }
        checkpoint = response.checkpoint;
      } finally {
        await keeper.destroy();
      }
      expect(checkpoint.processes.length).toBe(1);
      const pid = checkpoint.processes[0]!.pid;
      // fbDOOM renders write-based, so the checkpoint carries the current
      // frame in a host-owned pixel buffer.
      expect(checkpoint.framebuffers.length).toBe(1);
      const capturedFb = checkpoint.framebuffers[0]!;
      expect(capturedFb.pid).toBe(pid);
      expect(capturedFb.addr).toBe(0);
      expect(capturedFb.hostBuffer).not.toBeNull();
      expect(capturedFb.hostBuffer!.byteLength).toBe(
        capturedFb.h * capturedFb.stride,
      );
      expect(capturedFb.hostBuffer!.some((byte) => byte !== 0)).toBe(true);

      const receiver = new NodeKernelHost({
        rootfsImage: "default",
        restoreCheckpoint: checkpoint,
      });
      await receiver.init();
      try {
        expect(await receiver.signalProcess(pid, 0)).toBe(true);

        // The game keeps playing only if it keeps crossing syscall
        // boundaries every tic; a capture completes only then, so a
        // captured recapture is the proof the demo loop resumed.
        const recapture = await receiver.captureCheckpointBytes(TIMEOUTS);
        if (recapture.status !== "captured") {
          throw new Error(`recapture: ${JSON.stringify(recapture)}`);
        }
        expect(
          recapture.checkpoint.processes.map((bucket) => bucket.pid),
        ).toEqual([pid]);
        // The receiver rebound the framebuffer: its own capture carries the
        // same binding, seeded and still receiving the game's writes.
        expect(recapture.checkpoint.framebuffers.length).toBe(1);
        const reboundFb = recapture.checkpoint.framebuffers[0]!;
        expect(reboundFb.pid).toBe(pid);
        expect(reboundFb.w).toBe(capturedFb.w);
        expect(reboundFb.h).toBe(capturedFb.h);
        expect(reboundFb.stride).toBe(capturedFb.stride);
        expect(reboundFb.hostBuffer!.some((byte) => byte !== 0)).toBe(true);
      } finally {
        await receiver.destroy();
      }
    },
  );

  it(
    "routes terminal input and output to a restored process",
    { timeout: 120_000 },
    async () => {
      let keeperOutput = "";
      const keeper = new NodeKernelHost({
        rootfsImage: "default",
        onPtyOutput: (_pid, data) => {
          keeperOutput += new TextDecoder().decode(data);
        },
      });
      await keeper.init();
      let checkpoint: MachineCheckpoint;
      try {
        let spawnedPid = 0;
        await new Promise<void>((resolve) => {
          void keeper.spawn(programBytes("checkpoint-pty-echo.wasm"), [
            "checkpoint-pty-echo",
          ], {
            pty: true,
            onStarted: (startedPid) => {
              spawnedPid = startedPid;
              resolve();
            },
          });
        });
        await expect
          .poll(() => keeperOutput.includes("READY"), { timeout: 30_000 })
          .toBe(true);
        keeper.ptyWrite(spawnedPid, new TextEncoder().encode("a\n"));
        await expect
          .poll(() => keeperOutput.includes("GOT:a"), { timeout: 30_000 })
          .toBe(true);
        const response = await keeper.captureCheckpointBytes(TIMEOUTS);
        if (response.status !== "captured") {
          throw new Error(`capture failed: ${JSON.stringify(response)}`);
        }
        checkpoint = response.checkpoint;
      } finally {
        await keeper.destroy();
      }
      expect(checkpoint.processes.length).toBe(1);
      const pid = checkpoint.processes[0]!.pid;

      // Input written to the restored terminal must reach the process and
      // its tagged echo must come back: the captured machine's pid → PTY
      // routing died with it, so the receiver has to re-derive the pair
      // from the restored kernel memory.
      let restoredOutput = "";
      const receiver = new NodeKernelHost({
        rootfsImage: "default",
        restoreCheckpoint: checkpoint,
        onPtyOutput: (_pid, data) => {
          restoredOutput += new TextDecoder().decode(data);
        },
      });
      await receiver.init();
      try {
        receiver.ptyWrite(pid, new TextEncoder().encode("b\n"));
        await expect
          .poll(() => restoredOutput.includes("GOT:b"), { timeout: 30_000 })
          .toBe(true);
      } finally {
        await receiver.destroy();
      }
    },
  );

  it(
    "restores a checkpointed process whose pthread keeps running",
    { timeout: 120_000 },
    async () => {
      const checkpoint = await captureRealCheckpoint("checkpoint-threads.wasm");
      const expected = await defaultHostExpectation();
      expect(checkpoint.processes.length).toBe(1);
      const bucket = checkpoint.processes[0]!;
      const pid = bucket.pid;
      expect(bucket.threadAllocator.activeCount).toBeGreaterThan(0);
      expect(bucket.threads.length).toBe(bucket.threadAllocator.activeCount);

      // A bucket whose thread records disagree with its allocator is refused
      // before anything is instantiated: a missing record would leave a live
      // thread's frames parked forever.
      const missingThread = cloneCheckpoint(checkpoint);
      (missingThread.processes[0]! as { threads: unknown[] }).threads = [];
      const missingAttempt = validateMachineCheckpoint(missingThread, expected);
      await expect(missingAttempt).rejects.toThrow(CheckpointRefusedError);
      await expect(missingAttempt).rejects.toThrow(/thread record\(s\)/);

      const brokenAnchor = cloneCheckpoint(checkpoint);
      const brokenThread = brokenAnchor.processes[0]!.threads[0]!;
      new DataView(brokenAnchor.processes[0]!.memory.buffer).setUint32(
        brokenThread.channelOffset - FORK_SAVE_BUFFER_SIZE,
        7,
        true,
      );
      const brokenAttempt = validateMachineCheckpoint(brokenAnchor, expected);
      await expect(brokenAttempt).rejects.toThrow(CheckpointRefusedError);
      await expect(brokenAttempt).rejects.toThrow(
        /tid \d+'s continuation root is unusable/,
      );

      const threadRefusal = async (
        corrupt: (thread: Record<string, unknown>) => void,
        reason: string | RegExp,
      ) => {
        const corrupted = cloneCheckpoint(checkpoint);
        corrupt(
          corrupted.processes[0]!.threads[0]! as
            unknown as Record<string, unknown>,
        );
        const attempt = validateMachineCheckpoint(corrupted, expected);
        await expect(attempt).rejects.toThrow(CheckpointRefusedError);
        await expect(attempt).rejects.toThrow(reason);
      };
      await threadRefusal((thread) => {
        thread.tid = pid;
      }, `carries a thread with kernel TID ${pid}`);
      await threadRefusal((thread) => {
        thread.channelOffset = checkpoint.processes[0]!.memory.byteLength;
      }, /syscall channel at \d+ does not fit inside/);

      const duplicateTid = cloneCheckpoint(checkpoint);
      const duplicated = duplicateTid.processes[0]! as unknown as {
        threads: unknown[];
        threadAllocator: { activeCount: number };
      };
      duplicated.threads = [
        duplicateTid.processes[0]!.threads[0]!,
        { ...duplicateTid.processes[0]!.threads[0]! },
      ];
      duplicated.threadAllocator = {
        ...duplicateTid.processes[0]!.threadAllocator,
        activeCount: 2,
      };
      const duplicateAttempt = validateMachineCheckpoint(
        duplicateTid,
        expected,
      );
      await expect(duplicateAttempt).rejects.toThrow(CheckpointRefusedError);
      await expect(duplicateAttempt).rejects.toThrow(
        /carries kernel TID \d+ twice/,
      );

      const receiver = new NodeKernelHost({
        rootfsImage: "default",
        restoreCheckpoint: checkpoint,
      });
      await receiver.init();
      try {
        expect(await receiver.signalProcess(pid, 0)).toBe(true);

        // A capture completes only when every task of the process crosses a
        // syscall boundary and unwinds, so a captured recapture proves the
        // restored pthread genuinely resumed its nap loop alongside the main
        // thread rather than staying parked in its captured frames.
        const recapture = await receiver.captureCheckpointBytes(TIMEOUTS);
        if (recapture.status !== "captured") {
          throw new Error(`recapture: ${JSON.stringify(recapture)}`);
        }
        const recaptured = recapture.checkpoint.processes.find(
          (candidate) => candidate.pid === pid,
        );
        expect(recaptured).toBeDefined();
        expect(recaptured!.threads.map((thread) => thread.tid)).toEqual(
          bucket.threads.map((thread) => thread.tid),
        );
      } finally {
        await receiver.destroy();
      }
    },
  );

  it(
    "restores a file mid-write, a directory mid-iteration, and a pending alarm",
    { timeout: 120_000 },
    async () => {
      // The fixture writes its files under a writable `/`.
      const spec: MountSpec[] = [
        { path: "/", source: "image", readonly: false },
      ];
      let keeperOut = "";
      let ready = () => {};
      const isReady = new Promise<void>((resolve) => { ready = resolve; });
      const keeper = new NodeKernelHost({
        rootfsImage: "default",
        rootfsMountSpec: spec,
        onStdout: (_pid, data) => {
          keeperOut += new TextDecoder().decode(data);
          if (keeperOut.includes("READY")) ready();
        },
        onStderr: (_pid, data) => {
          keeperOut += new TextDecoder().decode(data);
        },
      });
      await keeper.init();
      let checkpoint: MachineCheckpoint;
      try {
        await new Promise<void>((resolve) => {
          void keeper.spawn(
            programBytes("checkpoint-handles.wasm"),
            ["checkpoint-handles"],
            { onStarted: () => resolve() },
          );
        });
        await isReady;
        const response = await keeper.captureCheckpointBytes(TIMEOUTS);
        if (response.status !== "captured") {
          throw new Error(`capture failed: ${JSON.stringify(response)}`);
        }
        checkpoint = response.checkpoint;
        // The alarm is pending, the file half-written, the directory
        // mid-iteration: none of the completion markers may exist yet.
        expect(keeperOut).not.toContain("OK");
      } finally {
        await keeper.destroy();
      }

      let receiverOut = "";
      const receiver = new NodeKernelHost({
        rootfsImage: "default",
        rootfsMountSpec: spec,
        restoreCheckpoint: checkpoint,
        onStdout: (_pid, data) => {
          receiverOut += new TextDecoder().decode(data);
        },
        onStderr: (_pid, data) => {
          receiverOut += new TextDecoder().decode(data);
        },
      });
      await receiver.init();
      try {
        await expect
          .poll(() => receiverOut.includes("ALARM OK"), { timeout: 30_000 })
          .toBe(true);
        expect(receiverOut).toContain("MONO OK");
        expect(receiverOut).toContain("FILE OK");
        expect(receiverOut).toContain("DIR OK");
      } finally {
        await receiver.destroy();
      }
    },
  );
});

describe("what a restore says about the mounts it did not get", () => {
  const carried = (gaps: MachineCheckpoint["unreadableFilesystems"]) =>
    ({ unreadableFilesystems: gaps }) as MachineCheckpoint;

  it("says nothing when every mount arrived", () => {
    expect(describeCheckpointMountGaps(carried([]))).toBeNull();
  });

  it("names each mount the sender could not read, with its reason", () => {
    expect(
      describeCheckpointMountGaps(
        carried([{ mountPoint: "/tmp", reason: "a host directory" }]),
      ),
    ).toBe("this machine was restored without /tmp (a host directory)");
  });

  it("names every missing mount in one line", () => {
    expect(
      describeCheckpointMountGaps(
        carried([
          { mountPoint: "/tmp", reason: "a host directory" },
          { mountPoint: "/run", reason: "a host directory" },
        ]),
      ),
    ).toBe(
      "this machine was restored without /tmp (a host directory), "
      + "/run (a host directory)",
    );
  });
});

describe("what a restore does with a handed-over checkpoint", () => {
  it(
    "transfers the checkpoint's buffers to the worker instead of cloning them",
    { timeout: 120_000 },
    async () => {
      // A replica boots from a checkpoint another computer sent it, and that
      // checkpoint is restored exactly once. Handing over ownership must move
      // the buffers — a clone of a large machine is an allocation the runtime
      // can refuse — and the machine adopted from moved buffers must be whole.
      const checkpoint = await captureRealCheckpoint();
      const memories = checkpoint.processes.map((bucket) => bucket.memory);
      expect(checkpoint.kernelMemory.byteLength).toBeGreaterThan(0);
      expect(memories.length).toBeGreaterThan(0);

      const replica = new NodeKernelHost({
        rootfsImage: "default",
        restoreCheckpoint: checkpoint,
        takeRestoreCheckpointOwnership: true,
      });
      await replica.init();
      try {
        // The kernel memory carries `/` and the scratch mounts, so its
        // transfer moves the machine's files too.
        expect(checkpoint.kernelMemory.byteLength).toBe(0);
        for (const memory of memories) expect(memory.byteLength).toBe(0);

        const second = await replica.captureCheckpoint(TIMEOUTS);
        expect(second.status).toBe("captured");
      } finally {
        await replica.destroy();
      }
    },
  );
});
