/**
 * Reproduce the epoll_pwait crash using CentralizedKernelWorker in Node.js.
 * Run: npx tsx test/epoll-repro.ts
 */
import { CAPTURED_STDIO, CentralizedKernelWorker } from "../../../host/src/kernel-worker.ts";
import { resolveBinary } from "../../../host/src/binary-resolver.ts";
import {
  CH_ARGS,
  CH_ARG_SIZE,
  CH_DATA,
  CH_ERRNO,
  CH_RETURN,
  CH_SYSCALL,
  CH_TOTAL_SIZE,
  STRUCT_SIZE_WASM_EPOLL_EVENT,
  WASM_EPOLL_EVENT_DATA_OFFSET,
} from "../../../host/src/generated/abi.ts";
import type { KernelScratchRegion } from "../../../host/src/kernel-scratch.ts";
import { VirtualPlatformIO, MemoryFileSystem, DeviceFileSystem } from "../../../host/src/vfs/index.ts";
import { readFileSync } from "fs";

const MAX_PAGES = 16384;
const PAGE_SIZE = 65536;

interface KernelWorkerInternals {
  scratchRegion: KernelScratchRegion;
  kernelInstance: WebAssembly.Instance;
  kernelMemory: WebAssembly.Memory;
}

interface ScratchPointerArgument {
  readonly offset: number;
  readonly length: number;
}

type ChannelArgument = bigint | ScratchPointerArgument;

interface EpollEventPreparation {
  readonly events: number;
  readonly data: bigint;
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

  const setCurrentTid = ki.exports.kernel_set_current_tid as (
    pid: number,
    tid: number,
  ) => number;
  const bindCurrentTid = (): void => {
    const bindResult = setCurrentTid(pid, pid);
    if (bindResult !== 0) {
      throw new Error(
        `kernel_set_current_tid(${pid}, ${pid}) failed: ${bindResult}`,
      );
    }
  };
  const issueChannel = (
    syscall: number,
    args: readonly ChannelArgument[],
    event?: EpollEventPreparation,
  ) =>
    scratchRegion.withLease((scratch) => {
      // WHY: preparation is inert data rather than a callback receiving the
      // lease. No promise or helper can retain scratch authority after this
      // synchronous callback returns.
      const kernelView = scratch.dataView(0, CH_TOTAL_SIZE);
      if (event !== undefined) {
        kernelView.setUint32(CH_DATA, event.events, true);
        kernelView.setUint32(CH_DATA + 4, 0, true);
        kernelView.setBigUint64(
          CH_DATA + WASM_EPOLL_EVENT_DATA_OFFSET,
          event.data,
          true,
        );
      }
      kernelView.setUint32(CH_SYSCALL, syscall, true);
      for (let index = 0; index < 6; index++) {
        const argument = args[index] ?? 0n;
        if (typeof argument === "object") {
          // Keep the kernel pointer opaque and encode it losslessly into the
          // channel's fixed u64 syscall slot.
          scratch.writeAddress(
            CH_ARGS + index * CH_ARG_SIZE,
            argument.offset,
            argument.length,
            "u64-le",
          );
        } else {
          kernelView.setBigInt64(
            CH_ARGS + index * CH_ARG_SIZE,
            argument,
            true,
          );
        }
      }
      bindCurrentTid();
      scratch.invokeKernelExport("kernel_handle_channel", [
        scratch.exportPointer(0, CH_TOTAL_SIZE),
        CH_TOTAL_SIZE,
        pid,
      ]);
      return {
        result: kernelView.getBigInt64(CH_RETURN, true),
        errno: kernelView.getUint32(CH_ERRNO, true),
        data0: kernelView.getInt32(CH_DATA, true),
        data1: kernelView.getInt32(CH_DATA + 4, true),
      };
    });

  // 1. epoll_create1(0)
  const epfd = issueChannel(239, [0n]).result;
  console.log(`epoll_create1(0) = ${epfd}, SP=${getSP()}`);

  // 2. pipe2()
  const pipe = issueChannel(165, [
    { offset: CH_DATA, length: 8 },
    0n,
  ]);
  console.log(
    `pipe2() = ${pipe.result}, fds=[${pipe.data0}, ${pipe.data1}], SP=${getSP()}`,
  );

  // 3. epoll_ctl(epfd, EPOLL_CTL_ADD=1, pipe.data0, event)
  const ctlResult = issueChannel(
    240,
    [
      epfd,
      1n,
      BigInt(pipe.data0),
      {
        offset: CH_DATA,
        length: STRUCT_SIZE_WASM_EPOLL_EVENT,
      },
    ],
    {
      events: 1, // EPOLLIN
      data: BigInt(pipe.data0),
    },
  ).result;
  console.log(`epoll_ctl = ${ctlResult}, SP=${getSP()}`);

  // 4. timeout=0 for an immediate result, then use PHP-FPM's 1s timeout.
  for (const timeout of [0, 1000]) {
    console.log(
      `\nCalling epoll_pwait(timeout=${timeout})... SP before=${getSP()}`,
    );
    try {
      const result = issueChannel(241, [
        epfd,
        {
          offset: CH_DATA,
          length: STRUCT_SIZE_WASM_EPOLL_EVENT,
        },
        1n,
        BigInt(timeout),
        0n,
        8n,
      ]);
      console.log(
        `epoll_pwait(${timeout}) = ${result.result}, errno=${result.errno}, SP=${getSP()}`,
      );
    } catch (error) {
      console.error(`CRASHED: ${error}`);
      console.log(`SP after crash: ${getSP()}, memPages=${km.grow(0)}`);
    }
  }
}

main().catch(console.error);
