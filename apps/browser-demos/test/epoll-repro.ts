/**
 * Reproduce the epoll_pwait crash using CentralizedKernelWorker in Node.js.
 * Run: npx tsx test/epoll-repro.ts
 */
import { CAPTURED_STDIO, CentralizedKernelWorker } from "../../../host/src/kernel-worker.ts";
import { resolveBinary } from "../../../host/src/binary-resolver.ts";
import {
  STRUCT_SIZE_WASM_EPOLL_EVENT,
  WASM_EPOLL_EVENT_DATA_OFFSET,
} from "../../../host/src/generated/abi.ts";
import type { KernelScratchRegion } from "../../../host/src/kernel-scratch.ts";
import { VirtualPlatformIO, MemoryFileSystem, DeviceFileSystem } from "../../../host/src/vfs/index.ts";
import { readFileSync } from "fs";

const CH_SYSCALL = 4;
const CH_ARGS = 8;
const CH_ARG_SIZE = 8;  // each arg is i64 (8 bytes)
const CH_RETURN = 56;
const CH_ERRNO = 64;
const CH_DATA = 72;
const CH_TOTAL_SIZE = 72 + 65536;
const MAX_PAGES = 16384;
const PAGE_SIZE = 65536;

interface KernelWorkerInternals {
  scratchRegion: KernelScratchRegion;
  kernelInstance: WebAssembly.Instance;
  kernelMemory: WebAssembly.Memory;
}

async function main() {
  const kernelWasm = readFileSync(resolveBinary("kernel.wasm"));

  const memfs = MemoryFileSystem.create(new SharedArrayBuffer(16 * 1024 * 1024));
  const devfs = new DeviceFileSystem();
  const io = new VirtualPlatformIO([
    { mountPoint: "/dev", backend: devfs },
    { mountPoint: "/", backend: memfs },
  ]);

  // Create dirs
  for (const d of ["/tmp", "/etc", "/var", "/proc"]) {
    try { memfs.mkdir(d, 0o755); } catch {}
  }

  const kw = new CentralizedKernelWorker({ maxWorkers: 4, dataBufferSize: PAGE_SIZE, useSharedMemory: true }, io);
  await kw.init(kernelWasm);

  const internals = kw as unknown as KernelWorkerInternals;
  const ki = internals.kernelInstance;
  const km = internals.kernelMemory;
  const scratchRegion = internals.scratchRegion;

  console.log(
    `scratchCapacity=${scratchRegion.capacity}, memPages=${km.grow(0)}`,
  );

  // Register a fake process
  const procMem = new WebAssembly.Memory({ initial: 17, maximum: MAX_PAGES, shared: true });
  // Grow to max so channel offset is valid
  procMem.grow(MAX_PAGES - 17);
  const channelOff = (MAX_PAGES - 2) * PAGE_SIZE;
  const pid = kw.createProcess(CAPTURED_STDIO);
  kw.registerProcess(pid, procMem, [channelOff]);

  const getSP = ki.exports.kernel_get_stack_pointer as () => number;
  console.log(`SP initial: ${getSP()}`);

  // WHY: this diagnostic directly drives the kernel channel, so it must hold
  // the same exclusive capacity-bearing lease as production channel dispatch.
  scratchRegion.withLease((scratch) => {
    const kernelView = scratch.dataView(0, CH_TOTAL_SIZE);
    const handleChannel = ki.exports.kernel_handle_channel as (
      off: number | bigint,
      pid: number,
    ) => number;
    const setCurrentTid = ki.exports.kernel_set_current_tid as (
      pid: number,
      tid: number,
    ) => number;
    const handleBoundChannel = (): number => {
      const bindResult = setCurrentTid(pid, pid);
      if (bindResult !== 0) {
        throw new Error(
          `kernel_set_current_tid(${pid}, ${pid}) failed: ${bindResult}`,
        );
      }
      return handleChannel(
        kw.toKernelPtr(scratch.address(0, CH_TOTAL_SIZE)),
        pid,
      );
    };

    // 1. epoll_create1(0)
    kernelView.setUint32(CH_SYSCALL, 239, true);
    kernelView.setBigInt64(CH_ARGS, 0n, true);
    for (let i = 1; i < 6; i++) {
      kernelView.setBigInt64(CH_ARGS + i * CH_ARG_SIZE, 0n, true);
    }
    handleBoundChannel();
    const epfd = Number(kernelView.getBigInt64(CH_RETURN, true));
    console.log(`epoll_create1(0) = ${epfd}, SP=${getSP()}`);

    // 2. pipe2()
    kernelView.setUint32(CH_SYSCALL, 165, true);
    kernelView.setBigInt64(
      CH_ARGS,
      BigInt(scratch.address(CH_DATA, 8)),
      true,
    );
    kernelView.setBigInt64(CH_ARGS + CH_ARG_SIZE, 0n, true);
    for (let i = 2; i < 6; i++) {
      kernelView.setBigInt64(CH_ARGS + i * CH_ARG_SIZE, 0n, true);
    }
    handleBoundChannel();
    const pipeRet = Number(kernelView.getBigInt64(CH_RETURN, true));
    const pipeR = kernelView.getInt32(CH_DATA, true);
    const pipeW = kernelView.getInt32(CH_DATA + 4, true);
    console.log(
      `pipe2() = ${pipeRet}, fds=[${pipeR}, ${pipeW}], SP=${getSP()}`,
    );

    // 3. epoll_ctl(epfd, EPOLL_CTL_ADD=1, pipeR, event)
    kernelView.setUint32(CH_DATA, 1, true); // EPOLLIN
    kernelView.setUint32(CH_DATA + 4, 0, true); // native alignment padding
    kernelView.setBigUint64(
      CH_DATA + WASM_EPOLL_EVENT_DATA_OFFSET,
      BigInt(pipeR),
      true,
    );
    kernelView.setUint32(CH_SYSCALL, 240, true);
    kernelView.setBigInt64(CH_ARGS, BigInt(epfd), true);
    kernelView.setBigInt64(CH_ARGS + CH_ARG_SIZE, 1n, true);
    kernelView.setBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, BigInt(pipeR), true);
    kernelView.setBigInt64(
      CH_ARGS + 3 * CH_ARG_SIZE,
      BigInt(scratch.address(CH_DATA, STRUCT_SIZE_WASM_EPOLL_EVENT)),
      true,
    );
    for (let i = 4; i < 6; i++) {
      kernelView.setBigInt64(CH_ARGS + i * CH_ARG_SIZE, 0n, true);
    }
    handleBoundChannel();
    console.log(
      `epoll_ctl = ${Number(kernelView.getBigInt64(CH_RETURN, true))}, SP=${getSP()}`,
    );

    const issueEpollPwait = (timeout: number): void => {
      kernelView.setUint32(CH_SYSCALL, 241, true);
      kernelView.setBigInt64(CH_ARGS, BigInt(epfd), true);
      kernelView.setBigInt64(
        CH_ARGS + CH_ARG_SIZE,
        BigInt(scratch.address(CH_DATA, STRUCT_SIZE_WASM_EPOLL_EVENT)),
        true,
      );
      kernelView.setBigInt64(CH_ARGS + 2 * CH_ARG_SIZE, 1n, true);
      kernelView.setBigInt64(
        CH_ARGS + 3 * CH_ARG_SIZE,
        BigInt(timeout),
        true,
      );
      kernelView.setBigInt64(CH_ARGS + 4 * CH_ARG_SIZE, 0n, true);
      kernelView.setBigInt64(CH_ARGS + 5 * CH_ARG_SIZE, 8n, true);

      console.log(
        `\nCalling epoll_pwait(timeout=${timeout})... SP before=${getSP()}`,
      );
      try {
        handleBoundChannel();
        const ret = Number(kernelView.getBigInt64(CH_RETURN, true));
        const err = kernelView.getUint32(CH_ERRNO, true);
        console.log(
          `epoll_pwait(${timeout}) = ${ret}, errno=${err}, SP=${getSP()}`,
        );
      } catch (error) {
        console.error(`CRASHED: ${error}`);
        console.log(`SP after crash: ${getSP()}, memPages=${km.grow(0)}`);
      }
    };

    // 4. timeout=0 for an immediate result, then use PHP-FPM's 1s timeout.
    issueEpollPwait(0);
    issueEpollPwait(1000);
  });
}

main().catch(console.error);
