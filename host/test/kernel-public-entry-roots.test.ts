import { describe, expect, it, vi } from "vitest";

import {
  createCentralizedKernelWorkerTestDouble,
} from "../src/kernel-worker";
import {
  createKernelEntryGatedInstance,
  KernelEntryGate,
  KernelReentrantEntryError,
} from "../src/kernel-entry-gate";
import {
  allocateKernelScratchRegion,
  KernelScratchError,
} from "../src/kernel-scratch";
import {
  PROCESS_SNAPSHOT_CMDLINE_LEN_OFFSET,
  PROCESS_SNAPSHOT_COMM_LEN_OFFSET,
  PROCESS_SNAPSHOT_COUNT_OFFSET,
  PROCESS_SNAPSHOT_GID_OFFSET,
  PROCESS_SNAPSHOT_HEADER_BYTES,
  PROCESS_SNAPSHOT_PID_OFFSET,
  PROCESS_SNAPSHOT_PPID_OFFSET,
  PROCESS_SNAPSHOT_RECORDS_OFFSET,
  PROCESS_SNAPSHOT_STATE_OFFSET,
  PROCESS_SNAPSHOT_UID_OFFSET,
  PROCESS_SNAPSHOT_VSIZE_OFFSET,
} from "../src/generated/abi";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";

const SCRATCH_OFFSET = 4096;
const SCRATCH_CAPACITY = 65_536;

interface RootHarness {
  readonly worker: ReturnType<typeof createCentralizedKernelWorkerTestDouble>;
  readonly gate: KernelEntryGate;
  readonly kernelBytes: Uint8Array;
  readonly implementations: Record<string, unknown>;
}

function kernelPointer(pointerWidth: 4 | 8, value: number): number | bigint {
  return pointerWidth === 8 ? BigInt(value) : value;
}

function makeRootHarness(pointerWidth: 4 | 8): RootHarness {
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 2 });
  const kernelBytes = new Uint8Array(memory.buffer);
  const implementations: Record<string, unknown> = {
    kernel_enum_procs: () => 0,
    kernel_pty_create: () => 7,
    kernel_pty_master_read: () => 0,
    kernel_read_proc_maps: () => 0,
    kernel_set_cwd: () => 0,
    kernel_set_process_credentials: () => 0,
  };
  const gate = new KernelEntryGate();
  const rawInstance = createKernelScratchTestInstance(
    pointerWidth,
    memory,
    () => implementations,
    () => kernelPointer(pointerWidth, SCRATCH_OFFSET),
    4,
    [
      "kernel_enum_procs",
      "kernel_pty_create",
      "kernel_pty_master_read",
      "kernel_read_proc_maps",
      "kernel_set_cwd",
      "kernel_set_process_credentials",
    ],
  );
  const instance = createKernelEntryGatedInstance(rawInstance, gate);
  const scratch = allocateKernelScratchRegion(
    memory,
    instance.exports.kernel_alloc_scratch as
      (capacity: number) => number | bigint,
    SCRATCH_CAPACITY,
    pointerWidth,
    "public entry-root test scratch",
    instance,
  );
  const worker = createCentralizedKernelWorkerTestDouble();
  worker.testAuthority.initializeKernelForTest({
    instance,
    gate,
    mainScratch: scratch,
    tcpScratch: scratch,
  });
  return { worker, gate, kernelBytes, implementations };
}

function processSnapshotBytes(): Uint8Array {
  const encoder = new TextEncoder();
  const comm = encoder.encode("demo");
  const cmdline = encoder.encode("demo\0--safe\0");
  const bytes = new Uint8Array(
    PROCESS_SNAPSHOT_RECORDS_OFFSET
      + PROCESS_SNAPSHOT_HEADER_BYTES
      + comm.length
      + cmdline.length,
  );
  const view = new DataView(bytes.buffer);
  view.setUint32(PROCESS_SNAPSHOT_COUNT_OFFSET, 1, true);
  const header = PROCESS_SNAPSHOT_RECORDS_OFFSET;
  view.setUint32(header + PROCESS_SNAPSHOT_PID_OFFSET, 41, true);
  view.setUint32(header + PROCESS_SNAPSHOT_PPID_OFFSET, 1, true);
  view.setUint32(header + PROCESS_SNAPSHOT_UID_OFFSET, 501, true);
  view.setUint32(header + PROCESS_SNAPSHOT_GID_OFFSET, 20, true);
  view.setBigUint64(header + PROCESS_SNAPSHOT_VSIZE_OFFSET, 8192n, true);
  view.setUint32(
    header + PROCESS_SNAPSHOT_STATE_OFFSET,
    "R".charCodeAt(0),
    true,
  );
  view.setUint32(
    header + PROCESS_SNAPSHOT_COMM_LEN_OFFSET,
    comm.length,
    true,
  );
  view.setUint32(
    header + PROCESS_SNAPSHOT_CMDLINE_LEN_OFFSET,
    cmdline.length,
    true,
  );
  let offset = header + PROCESS_SNAPSHOT_HEADER_BYTES;
  bytes.set(comm, offset); offset += comm.length;
  bytes.set(cmdline, offset);
  return bytes;
}

describe("CentralizedKernelWorker public kernel-entry roots", () => {
  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "%s scopes PTY, cwd, credential, and process-inspection exports",
    (_name, pointerWidth) => {
      const harness = makeRootHarness(pointerWidth);
      const cwd = new TextEncoder().encode("/safe");
      const maps = new TextEncoder().encode(
        "1000-2000 rw-p 00000000 00:00 0 [heap]\n",
      );
      const snapshots = processSnapshotBytes();
      const setupPty = vi.fn(() => 9);
      const setCredentials = vi.fn(() => 0);
      const setCwd = vi.fn((
        pid: number,
        pointer: number | bigint,
        length: number,
      ) => {
        expect(pid).toBe(41);
        expect(harness.kernelBytes.slice(
          Number(pointer),
          Number(pointer) + length,
        )).toEqual(cwd);
        return 0;
      });
      const readPty = vi.fn((
        ptyIndex: number,
        pointer: number | bigint,
        capacity: number,
      ) => {
        expect(ptyIndex).toBe(9);
        expect(capacity).toBe(4096);
        harness.kernelBytes.set([1, 2, 3], Number(pointer));
        return 3;
      });
      const enumProcs = vi.fn((
        pointer: number | bigint,
        capacity: number,
      ) => {
        expect(capacity).toBe(SCRATCH_CAPACITY);
        harness.kernelBytes.set(snapshots, Number(pointer));
        return snapshots.length;
      });
      const readMaps = vi.fn((
        pid: number,
        pointer: number | bigint,
        capacity: number,
      ) => {
        expect(pid).toBe(41);
        expect(capacity).toBe(SCRATCH_CAPACITY);
        harness.kernelBytes.set(maps, Number(pointer));
        return maps.length;
      });
      Object.assign(harness.implementations, {
        kernel_enum_procs: enumProcs,
        kernel_pty_create: setupPty,
        kernel_pty_master_read: readPty,
        kernel_read_proc_maps: readMaps,
        kernel_set_cwd: setCwd,
        kernel_set_process_credentials: setCredentials,
      });

      expect(harness.worker.setupPty(41)).toBe(9);
      harness.worker.setCredentials(41, { uid: 501, gid: 20 });
      harness.worker.setCwd(41, "/safe");
      expect(harness.worker.ptyMasterRead(9)).toEqual(
        new Uint8Array([1, 2, 3]),
      );
      expect(harness.worker.enumProcs()).toEqual([{
        pid: 41,
        ppid: 1,
        uid: 501,
        gid: 20,
        vsizeBytes: 8192,
        state: "R",
        comm: "demo",
        cmdline: "demo --safe",
      }]);
      expect(harness.worker.readProcMaps(41)).toBe(
        new TextDecoder().decode(maps),
      );

      expect(setupPty).toHaveBeenCalledOnce();
      expect(setCredentials).toHaveBeenCalledWith(41, 501, 20);
      expect(setCwd).toHaveBeenCalledOnce();
      expect(readPty).toHaveBeenCalledOnce();
      expect(enumProcs).toHaveBeenCalledOnce();
      expect(readMaps).toHaveBeenCalledOnce();
    },
  );

  it("rejects result-bearing reverse entry before any export runs", () => {
    const harness = makeRootHarness(4);
    const calls = Object.fromEntries(
      [
        "kernel_enum_procs",
        "kernel_pty_create",
        "kernel_pty_master_read",
        "kernel_read_proc_maps",
        "kernel_set_cwd",
        "kernel_set_process_credentials",
      ].map((name) => [name, vi.fn(() => 0)]),
    );
    Object.assign(harness.implementations, calls);

    harness.gate.invokeKernelExport("active outer export", () => {
      for (const operation of [
        () => harness.worker.setupPty(41),
        () => harness.worker.ptyMasterRead(7),
        () => harness.worker.setCwd(41, "/"),
        () => harness.worker.setCredentials(41, { uid: 1 }),
        () => harness.worker.enumProcs(),
        () => harness.worker.readProcMaps(41),
      ]) {
        expect(operation).toThrow(KernelReentrantEntryError);
      }
      return 0;
    });

    for (const call of Object.values(calls)) {
      expect(call).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["wasm32", 4],
    ["wasm64", 8],
  ] as const)(
    "fails closed on malformed %s process snapshot records",
    (_pointerKind, pointerWidth) => {
      const valid = processSnapshotBytes();
      const truncatedSecond = new Uint8Array(
        valid.byteLength + PROCESS_SNAPSHOT_HEADER_BYTES - 1,
      );
      truncatedSecond.set(valid);
      new DataView(truncatedSecond.buffer).setUint32(
        PROCESS_SNAPSHOT_COUNT_OFFSET,
        2,
        true,
      );

      const oversizedCmdline = valid.slice();
      const view = new DataView(oversizedCmdline.buffer);
      view.setUint32(
        PROCESS_SNAPSHOT_RECORDS_OFFSET
          + PROCESS_SNAPSHOT_CMDLINE_LEN_OFFSET,
        view.getUint32(
          PROCESS_SNAPSHOT_RECORDS_OFFSET
            + PROCESS_SNAPSHOT_CMDLINE_LEN_OFFSET,
          true,
        ) + 1,
        true,
      );

      const invalidState = valid.slice();
      new DataView(invalidState.buffer).setUint32(
        PROCESS_SNAPSHOT_RECORDS_OFFSET + PROCESS_SNAPSHOT_STATE_OFFSET,
        "X".charCodeAt(0),
        true,
      );
      const invalidWideState = valid.slice();
      new DataView(invalidWideState.buffer).setUint32(
        PROCESS_SNAPSHOT_RECORDS_OFFSET + PROCESS_SNAPSHOT_STATE_OFFSET,
        0x1_0000,
        true,
      );

      for (const malformed of [
        valid.slice(0, PROCESS_SNAPSHOT_RECORDS_OFFSET - 1),
        truncatedSecond,
        oversizedCmdline,
        invalidState,
        invalidWideState,
      ]) {
        const harness = makeRootHarness(pointerWidth);
        harness.implementations.kernel_enum_procs = (
          pointer: number | bigint,
          capacity: number,
        ) => {
          expect(malformed.byteLength).toBeLessThanOrEqual(capacity);
          harness.kernelBytes.set(malformed, Number(pointer));
          return malformed.byteLength;
        };

        expect(() => harness.worker.enumProcs()).toThrow(
          /malformed kernel process snapshot/,
        );
      }
    },
  );

  it("keeps ordinary PTY/cwd/credential errnos process-local", () => {
    const harness = makeRootHarness(4);

    harness.implementations.kernel_pty_create = () => -12;
    expect(() => harness.worker.setupPty(41)).toThrow("errno 12");
    harness.implementations.kernel_pty_create = () => 11;
    expect(harness.worker.setupPty(41)).toBe(11);

    harness.implementations.kernel_set_cwd = () => -36;
    expect(() => harness.worker.setCwd(41, "/missing")).toThrow("errno 36");
    harness.implementations.kernel_set_cwd = () => 0;
    expect(() => harness.worker.setCwd(41, "/safe")).not.toThrow();

    harness.implementations.kernel_set_process_credentials = () => -1;
    expect(() =>
      harness.worker.setCredentials(41, { uid: 501 })
    ).toThrow("errno 1");
    harness.implementations.kernel_set_process_credentials = () => 0;
    expect(() =>
      harness.worker.setCredentials(41, { uid: 501 })
    ).not.toThrow();
  });

  it.each([
    {
      name: "PTY read",
      request: 4096,
      install(
        harness: RootHarness,
        result: (pointer: number | bigint, capacity: number) => number,
      ): void {
        harness.implementations.kernel_pty_master_read = (
          _ptyIndex: number,
          pointer: number | bigint,
          capacity: number,
        ) => result(pointer, capacity);
      },
      invoke(harness: RootHarness): unknown {
        return harness.worker.ptyMasterRead(7);
      },
    },
    {
      name: "process enumeration",
      request: SCRATCH_CAPACITY,
      install(
        harness: RootHarness,
        result: (pointer: number | bigint, capacity: number) => number,
      ): void {
        harness.implementations.kernel_enum_procs = result;
      },
      invoke(harness: RootHarness): unknown {
        return harness.worker.enumProcs();
      },
    },
    {
      name: "process maps",
      request: SCRATCH_CAPACITY,
      install(
        harness: RootHarness,
        result: (pointer: number | bigint, capacity: number) => number,
      ): void {
        harness.implementations.kernel_read_proc_maps = (
          _pid: number,
          pointer: number | bigint,
          capacity: number,
        ) => result(pointer, capacity);
      },
      invoke(harness: RootHarness): unknown {
        return harness.worker.readProcMaps(41);
      },
    },
  ])(
    "accepts exact capacity and rejects capacity+1 for $name",
    ({ name, request, install, invoke }) => {
      const exact = makeRootHarness(4);
      install(exact, (pointer, capacity) => {
        expect(capacity).toBe(request);
        exact.kernelBytes.fill(0, Number(pointer), Number(pointer) + capacity);
        if (name === "process enumeration") {
          const view = new DataView(exact.kernelBytes.buffer);
          const base = Number(pointer);
          view.setUint32(base + PROCESS_SNAPSHOT_COUNT_OFFSET, 1, true);
          view.setUint32(
            base
              + PROCESS_SNAPSHOT_RECORDS_OFFSET
              + PROCESS_SNAPSHOT_STATE_OFFSET,
            "R".charCodeAt(0),
            true,
          );
          view.setUint32(
            base
              + PROCESS_SNAPSHOT_RECORDS_OFFSET
              + PROCESS_SNAPSHOT_COMM_LEN_OFFSET,
            capacity
              - PROCESS_SNAPSHOT_RECORDS_OFFSET
              - PROCESS_SNAPSHOT_HEADER_BYTES,
            true,
          );
        }
        return capacity;
      });
      expect(() => invoke(exact)).not.toThrow();

      const oversized = makeRootHarness(4);
      install(oversized, (_pointer, capacity) => capacity + 1);
      let failure: unknown;
      try {
        invoke(oversized);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error & { cause?: unknown }).cause)
        .toBeInstanceOf(KernelScratchError);
    },
  );
});
