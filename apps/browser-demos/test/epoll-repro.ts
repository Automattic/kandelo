/**
 * Reproduce the epoll_pwait crash using CentralizedKernelWorker in Node.js.
 * Run: npx tsx test/epoll-repro.ts
 */
import {
  CAPTURED_STDIO,
  createCentralizedKernelWorkerTestDouble,
} from "../../../host/src/kernel-worker.ts";
import { resolveBinary } from "../../../host/src/binary-resolver.ts";
import {
  CH_ARGS,
  CH_ARG_SIZE,
  CH_DATA,
  CH_ERRNO,
  CH_RETURN,
  CH_STATUS,
  CH_SYSCALL,
  CH_TOTAL_SIZE,
  CHANNEL_STATUS_COMPLETE,
  CHANNEL_STATUS_PENDING,
  STRUCT_SIZE_WASM_EPOLL_EVENT,
  WASM_EPOLL_EVENT_DATA_OFFSET,
} from "../../../host/src/generated/abi.ts";
import { VirtualPlatformIO, MemoryFileSystem, DeviceFileSystem } from "../../../host/src/vfs/index.ts";
import { BrowserTimeProvider } from "../../../host/src/vfs/time.ts";
import { readFileSync } from "fs";

const MAX_PAGES = 16384;
const PAGE_SIZE = 65536;

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
  ], new BrowserTimeProvider());

  // Create dirs
  for (const d of ["/tmp", "/etc", "/var", "/proc"]) {
    try { memfs.mkdir(d, 0o755); } catch {}
  }

  const kw = createCentralizedKernelWorkerTestDouble({
    config: {
      maxWorkers: 4,
      dataBufferSize: PAGE_SIZE,
      useSharedMemory: true,
    },
    io,
  });
  await kw.init(kernelWasm);

  console.log(
    `memPages=${kw.getKernelMemoryPages()}`,
  );

  // Register a fake process
  const procMem = new WebAssembly.Memory({ initial: 17, maximum: MAX_PAGES, shared: true });
  // Grow to max so channel offset is valid
  procMem.grow(MAX_PAGES - 17);
  const channelOff = (MAX_PAGES - 2) * PAGE_SIZE;
  const pid = kw.createProcess(CAPTURED_STDIO);
  kw.registerProcess(pid, procMem, [channelOff]);

  const issueChannel = async (
    syscall: number,
    args: readonly ChannelArgument[],
    event?: EpollEventPreparation,
  ) => {
    // Exercise the same registered process mailbox used by real guests. The
    // worker, not this diagnostic, owns kernel scratch and entry serialization.
    const channel = new DataView(procMem.buffer, channelOff, CH_TOTAL_SIZE);
    if (event !== undefined) {
      channel.setUint32(CH_DATA, event.events, true);
      channel.setUint32(CH_DATA + 4, 0, true);
      channel.setBigUint64(
        CH_DATA + WASM_EPOLL_EVENT_DATA_OFFSET,
        event.data,
        true,
      );
    }
    channel.setUint32(CH_SYSCALL, syscall, true);
    for (let index = 0; index < 6; index++) {
      const argument = args[index] ?? 0n;
      if (typeof argument === "object") {
        if (
          !Number.isSafeInteger(argument.offset)
          || !Number.isSafeInteger(argument.length)
          || argument.offset < 0
          || argument.length < 0
          || argument.offset + argument.length > CH_TOTAL_SIZE
        ) {
          throw new RangeError("diagnostic channel pointer is out of range");
        }
        channel.setBigUint64(
          CH_ARGS + index * CH_ARG_SIZE,
          BigInt(channelOff + argument.offset),
          true,
        );
      } else {
        channel.setBigInt64(
          CH_ARGS + index * CH_ARG_SIZE,
          argument,
          true,
        );
      }
    }
    const words = new Int32Array(procMem.buffer);
    const statusIndex = (channelOff + CH_STATUS) / Int32Array.BYTES_PER_ELEMENT;
    Atomics.store(words, statusIndex, CHANNEL_STATUS_PENDING);
    Atomics.notify(words, statusIndex, 1);
    const deadline = Date.now() + 10_000;
    while (Atomics.load(words, statusIndex) !== CHANNEL_STATUS_COMPLETE) {
      if (Date.now() >= deadline) {
        throw new Error(`syscall ${syscall} did not complete within 10 seconds`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    return {
      result: channel.getBigInt64(CH_RETURN, true),
      errno: channel.getUint32(CH_ERRNO, true),
      data0: channel.getInt32(CH_DATA, true),
      data1: channel.getInt32(CH_DATA + 4, true),
    };
  };

  // 1. epoll_create1(0)
  const epfd = (await issueChannel(239, [0n])).result;
  console.log(`epoll_create1(0) = ${epfd}`);

  // 2. pipe2()
  const pipe = await issueChannel(165, [
    { offset: CH_DATA, length: 8 },
    0n,
  ]);
  console.log(
    `pipe2() = ${pipe.result}, fds=[${pipe.data0}, ${pipe.data1}]`,
  );

  // 3. epoll_ctl(epfd, EPOLL_CTL_ADD=1, pipe.data0, event)
  const ctlResult = (await issueChannel(
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
  )).result;
  console.log(`epoll_ctl = ${ctlResult}`);

  // 4. timeout=0 for an immediate result, then use PHP-FPM's 1s timeout.
  for (const timeout of [0, 1000]) {
    console.log(
      `\nCalling epoll_pwait(timeout=${timeout})...`,
    );
    try {
      const result = await issueChannel(241, [
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
        `epoll_pwait(${timeout}) = ${result.result}, errno=${result.errno}`,
      );
    } catch (error) {
      console.error(`CRASHED: ${error}`);
      console.log(
        `memPages=${kw.getKernelMemoryPages()}`,
      );
    }
  }
}

main().catch(console.error);
