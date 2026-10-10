import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolveBinary } from "../src/binary-resolver";
import { detectPtrWidth } from "../src/constants";
import {
  ABI_SYSCALLS,
  CH_ARGS,
  CH_ARG_SIZE,
  CH_ERRNO,
  CH_RETURN,
  CH_SYSCALL,
  CH_TOTAL_SIZE,
  KERNEL_WAIT_RESULT_SI_CODE_OFFSET,
  KERNEL_WAIT_RESULT_SI_STATUS_OFFSET,
  KERNEL_WAIT_RESULT_WAIT_STATUS_OFFSET,
  STRUCT_SIZE_KERNEL_WAIT_RESULT,
  WAIT_CLD_KILLED,
  WAIT_EVENT_EXITED,
} from "../src/generated/abi";

const ESRCH = 3;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function instantiateKernelOnly(
  bytes: Uint8Array,
  imports: Record<string, unknown> = {},
): Promise<WebAssembly.Instance> {
  const ptrWidth = detectPtrWidth(toArrayBuffer(bytes));
  const memory = ptrWidth === 8
    ? new WebAssembly.Memory({
        initial: 24n,
        maximum: 16384n,
        shared: true,
        address: "i64",
      } as unknown as WebAssembly.MemoryDescriptor)
    : new WebAssembly.Memory({
        initial: 24,
        maximum: 16384,
        shared: true,
      });
  const module = await WebAssembly.compile(bytes as BufferSource);
  const importObject: WebAssembly.Imports = { env: { memory, ...imports } };
  const envImports = importObject.env as Record<string, unknown>;
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.module !== "env" || imp.name === "memory") continue;
    envImports[imp.name] ??=
      imp.kind === "function"
        ? (..._args: unknown[]) => 0
        : imp.kind === "global"
          ? new WebAssembly.Global({ value: "i32", mutable: true }, 0)
          : undefined;
  }
  return await WebAssembly.instantiate(module, importObject);
}

describe("kernel_handle_channel", () => {
  it("returns ESRCH instead of trapping for a late syscall from a reaped process", async () => {
    const instance = await instantiateKernelOnly(readFileSync(resolveBinary("kernel.wasm")));
    const memory = instance.exports.memory as WebAssembly.Memory;
    const allocScratch = instance.exports.kernel_alloc_scratch as (size: number) => number;
    const createProcess = instance.exports.kernel_create_process as () => number;
    const forkProcess = instance.exports.kernel_fork_process as (
      parentPid: number,
      callerTid: number,
      mode: number,
    ) => number;
    const markProcessSignaled = instance.exports.kernel_mark_process_signaled as (
      pid: number,
      signum: number,
    ) => number;
    const reapExitedChild = instance.exports.kernel_reap_exited_child as (
      parentPid: number,
      childPid: number,
    ) => number;
    const handleChannel = instance.exports.kernel_handle_channel as (
      offset: number,
      capacity: number,
      pid: number,
      retryToken: bigint,
    ) => number;

    const parentPid = createProcess();
    expect(forkProcess(parentPid, parentPid, 2)).toBe(-22);
    const childPid = forkProcess(parentPid, parentPid, 0);
    const channelOffset = allocScratch(CH_TOTAL_SIZE);
    const channel = new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE);
    channel.fill(0);
    const view = new DataView(memory.buffer, channelOffset, CH_TOTAL_SIZE);

    expect(parentPid).toBeGreaterThan(0);
    expect(childPid).toBeGreaterThan(0);
    expect(markProcessSignaled(childPid, 11)).toBe(0);
    expect(reapExitedChild(parentPid, childPid)).toBe(0);

    channel.fill(0);
    view.setUint32(CH_SYSCALL, ABI_SYSCALLS.Mmap, true);
    view.setBigInt64(CH_ARGS + CH_ARG_SIZE * 0, 0n, true);
    view.setBigInt64(CH_ARGS + CH_ARG_SIZE * 1, 4096n, true);
    view.setBigInt64(CH_ARGS + CH_ARG_SIZE * 2, 0n, true);
    view.setBigInt64(CH_ARGS + CH_ARG_SIZE * 3, 0x22n, true);
    view.setBigInt64(CH_ARGS + CH_ARG_SIZE * 4, -1n, true);
    view.setBigInt64(CH_ARGS + CH_ARG_SIZE * 5, 0n, true);

    expect(handleChannel(channelOffset, CH_TOTAL_SIZE, childPid, 0n)).toBe(
      -ESRCH,
    );
    expect(view.getBigInt64(CH_RETURN, true)).toBe(-1n);
    expect(view.getUint32(CH_ERRNO, true)).toBe(ESRCH);
  });

  it("keeps a signaled spawn child hidden from wasm wait/reap until publication", async () => {
    // The caller's memory the kernel reads the spawn request from: the
    // target path at 0x100 and an empty 40-byte request blob at 0x200.
    const callerMemory = new Uint8Array(0x1000);
    const path = new TextEncoder().encode("/tmp/prog");
    callerMemory.set(path, 0x100);
    let kernelMemory!: WebAssembly.Memory;
    const instance = await instantiateKernelOnly(
      readFileSync(resolveBinary("kernel.wasm")),
      {
        host_proc_read_bytes: (_pid: number, addr: bigint, dst: number, len: number) => {
          new Uint8Array(kernelMemory.buffer, Number(dst), len)
            .set(callerMemory.subarray(Number(addr), Number(addr) + len));
          return 0;
        },
      },
    );
    const memory = instance.exports.memory as WebAssembly.Memory;
    kernelMemory = memory;
    const allocScratch = instance.exports.kernel_alloc_scratch as (size: number) => number;
    const createProcess = instance.exports.kernel_create_process as () => number;
    const spawnProcess = instance.exports.kernel_spawn_process as (
      parentPid: number,
      callerTid: number,
      pathAddr: bigint,
      pathLen: number,
      blobAddr: bigint,
      blobLen: number,
    ) => number;
    // The kernel refuses a target a launch could not run, so give it one: an
    // executable WebAssembly header in the in-kernel tmpfs.
    (instance.exports.kernel_set_rootfs_enabled as (enabled: number) => number)(1);
    (instance.exports.kernel_set_tmpfs_enabled as (enabled: number) => number)(1);
    const header = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const headerPtr = allocScratch(header.byteLength);
    new Uint8Array(memory.buffer, headerPtr, header.byteLength).set(header);
    const pathPtr = allocScratch(path.byteLength);
    new Uint8Array(memory.buffer, pathPtr, path.byteLength).set(path);
    expect(
      (instance.exports.kernel_rootfs_write_file as (...args: number[]) => number)(
        pathPtr, path.byteLength, 0, 0, headerPtr, header.byteLength, 0o755, 1,
      ),
    ).toBeGreaterThanOrEqual(0);
    const markProcessSignaled = instance.exports.kernel_mark_process_signaled as (
      pid: number,
      signum: number,
    ) => number;
    const waitChildPoll = instance.exports.kernel_wait_child_poll as (
      parentPid: number,
      callerTid: number,
      targetPid: number,
      eventMask: number,
      flags: number,
      outPtr: number,
      outCapacity: number,
    ) => number;
    const reapExitedChild = instance.exports.kernel_reap_exited_child as (
      parentPid: number,
      childPid: number,
    ) => number;
    const publishSpawnChild = instance.exports.kernel_publish_spawn_child as (
      parentPid: number,
      childPid: number,
    ) => number;
    const getExitSignal = instance.exports.kernel_get_process_exit_signal as (
      pid: number,
    ) => number;

    const parentPid = createProcess();
    const childPid = spawnProcess(parentPid, parentPid, 0x100n, path.byteLength, 0x200n, 40);
    const waitResultPtr = allocScratch(STRUCT_SIZE_KERNEL_WAIT_RESULT);

    expect(childPid).toBeGreaterThan(0);
    expect(markProcessSignaled(childPid, 15)).toBe(0);
    expect(
      waitChildPoll(
        parentPid,
        parentPid,
        -1,
        WAIT_EVENT_EXITED,
        0,
        waitResultPtr,
        STRUCT_SIZE_KERNEL_WAIT_RESULT,
      ),
    ).toBe(0);
    expect(reapExitedChild(parentPid, childPid)).toBe(-10);

    expect(publishSpawnChild(parentPid, childPid)).toBe(15);
    expect(
      waitChildPoll(
        parentPid,
        parentPid,
        -1,
        WAIT_EVENT_EXITED,
        0,
        waitResultPtr,
        STRUCT_SIZE_KERNEL_WAIT_RESULT,
      ),
    ).toBe(childPid);
    const waitResult = new DataView(
      memory.buffer,
      waitResultPtr,
      STRUCT_SIZE_KERNEL_WAIT_RESULT,
    );
    expect(waitResult.getInt32(KERNEL_WAIT_RESULT_WAIT_STATUS_OFFSET, true)).toBe(15);
    expect(waitResult.getInt32(KERNEL_WAIT_RESULT_SI_CODE_OFFSET, true)).toBe(
      WAIT_CLD_KILLED,
    );
    expect(waitResult.getInt32(KERNEL_WAIT_RESULT_SI_STATUS_OFFSET, true)).toBe(15);
    expect(getExitSignal(childPid)).toBe(-ESRCH);
  });
});
