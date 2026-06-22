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
} from "../src/generated/abi";

const ESRCH = 3;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function instantiateKernelOnly(bytes: Uint8Array): Promise<WebAssembly.Instance> {
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
  const importObject: WebAssembly.Imports = { env: { memory } };
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
    const createProcess = instance.exports.kernel_create_process as (pid: number) => number;
    const forkProcess = instance.exports.kernel_fork_process as (
      parentPid: number,
      childPid: number,
    ) => number;
    const markProcessSignaled = instance.exports.kernel_mark_process_signaled as (
      pid: number,
      signum: number,
    ) => number;
    const wait4Poll = instance.exports.kernel_wait4_poll as (
      parentPid: number,
      targetPid: number,
      statusPtr: number,
    ) => number;
    const reapExitedChild = instance.exports.kernel_reap_exited_child as (
      parentPid: number,
      childPid: number,
    ) => number;
    const handleChannel = instance.exports.kernel_handle_channel as (
      offset: number,
      pid: number,
    ) => number;

    const parentPid = 4242;
    const childPid = 4243;
    const channelOffset = allocScratch(CH_TOTAL_SIZE);
    const channel = new Uint8Array(memory.buffer, channelOffset, CH_TOTAL_SIZE);
    channel.fill(0);
    const view = new DataView(memory.buffer, channelOffset, CH_TOTAL_SIZE);

    expect(createProcess(parentPid)).toBe(0);
    expect(forkProcess(parentPid, childPid)).toBe(0);
    expect(markProcessSignaled(childPid, 11)).toBe(0);
    expect(wait4Poll(parentPid, childPid, channelOffset)).toBe(childPid);
    expect(reapExitedChild(parentPid, childPid)).toBe(0);

    channel.fill(0);
    view.setUint32(CH_SYSCALL, ABI_SYSCALLS.Mmap, true);
    view.setBigInt64(CH_ARGS + CH_ARG_SIZE * 0, 0n, true);
    view.setBigInt64(CH_ARGS + CH_ARG_SIZE * 1, 4096n, true);
    view.setBigInt64(CH_ARGS + CH_ARG_SIZE * 2, 0n, true);
    view.setBigInt64(CH_ARGS + CH_ARG_SIZE * 3, 0x22n, true);
    view.setBigInt64(CH_ARGS + CH_ARG_SIZE * 4, -1n, true);
    view.setBigInt64(CH_ARGS + CH_ARG_SIZE * 5, 0n, true);

    expect(handleChannel(channelOffset, childPid)).toBe(-ESRCH);
    expect(view.getBigInt64(CH_RETURN, true)).toBe(-1n);
    expect(view.getUint32(CH_ERRNO, true)).toBe(ESRCH);
  });
});
