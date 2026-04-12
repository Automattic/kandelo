/**
 * Reproduce the epoll_pwait crash using CentralizedKernelWorker in Node.js.
 * Run: npx tsx test/epoll-repro.ts
 */
import { CentralizedKernelWorker } from "../../../host/src/kernel-worker.ts";
import { VirtualPlatformIO, MemoryFileSystem, DeviceFileSystem } from "../../../host/src/vfs/index.ts";
import { readFileSync } from "fs";

const CH_SYSCALL = 4;
const CH_ARGS = 8;      // 6 × i64 args on wasm64
const CH_RETURN = 56;   // 8 + 6*8 on wasm64
const CH_ERRNO = 64;    // CH_RETURN + 8 on wasm64
const CH_DATA = 72;     // CH_HEADER_SIZE on wasm64
const CH_TOTAL_SIZE = 72 + 65536;
const MAX_PAGES = 16384;
const PAGE_SIZE = 65536;

async function main() {
  const kernelWasm = readFileSync("/Users/brandon/ai-src/wasm-posix-kernel/host/wasm/wasm_posix_kernel.wasm");

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

  const ki = (kw as any).kernelInstance!;
  const km = (kw as any).kernelMemory!;
  const scratchOffset = (kw as any).scratchOffset as number;

  console.log(`scratchOffset=${scratchOffset}, memPages=${km.grow(0)}`);

  // Register a fake process
  const procMem = new WebAssembly.Memory({ initial: 17, maximum: MAX_PAGES, shared: true });
  // Grow to max so channel offset is valid
  procMem.grow(MAX_PAGES - 17);
  const channelOff = (MAX_PAGES - 2) * PAGE_SIZE;
  kw.registerProcess(1, procMem, [channelOff]);

  const getSP = ki.exports.kernel_get_stack_pointer as () => number;
  console.log(`SP initial: ${getSP()}`);

  // Directly call kernel_handle_channel to set up epoll
  const kernelView = new DataView(km.buffer, scratchOffset);
  const _handleChannel = ki.exports.kernel_handle_channel as (off: bigint, pid: number) => bigint;
  const handleChannel = (off: number, pid: number): number => Number(_handleChannel(BigInt(off), pid));

  // Helper to set i64 channel arg
  const setArg = (idx: number, val: number) => kernelView.setBigInt64(CH_ARGS + idx * 8, BigInt(val), true);

  // 1. epoll_create1(0)
  kernelView.setUint32(CH_SYSCALL, 239, true);
  for (let i = 0; i < 6; i++) setArg(i, 0);
  handleChannel(scratchOffset, 1);
  const epfd = Number(kernelView.getBigInt64(CH_RETURN, true));
  console.log(`epoll_create1(0) = ${epfd}, SP=${getSP()}`);

  // 2. pipe2()
  kernelView.setUint32(CH_SYSCALL, 165, true);
  setArg(0, scratchOffset + CH_DATA);
  setArg(1, 0);
  for (let i = 2; i < 6; i++) setArg(i, 0);
  handleChannel(scratchOffset, 1);
  const pipeRet = Number(kernelView.getBigInt64(CH_RETURN, true));
  const pipeR = new DataView(km.buffer).getInt32(scratchOffset + CH_DATA, true);
  const pipeW = new DataView(km.buffer).getInt32(scratchOffset + CH_DATA + 4, true);
  console.log(`pipe2() = ${pipeRet}, fds=[${pipeR}, ${pipeW}], SP=${getSP()}`);

  // 3. epoll_ctl(epfd, EPOLL_CTL_ADD=1, pipeR, event)
  const evtOff = scratchOffset + CH_DATA;
  new DataView(km.buffer).setUint32(evtOff, 1, true); // EPOLLIN
  new DataView(km.buffer).setBigUint64(evtOff + 4, BigInt(pipeR), true);
  kernelView.setUint32(CH_SYSCALL, 240, true);
  setArg(0, epfd);
  setArg(1, 1);
  setArg(2, pipeR);
  setArg(3, evtOff);
  for (let i = 4; i < 6; i++) setArg(i, 0);
  handleChannel(scratchOffset, 1);
  console.log(`epoll_ctl = ${Number(kernelView.getBigInt64(CH_RETURN, true))}, SP=${getSP()}`);

  // 4. epoll_pwait(epfd, events, 1, 0, NULL, 8) — timeout=0 for immediate
  const eventsOff = scratchOffset + CH_DATA;
  kernelView.setUint32(CH_SYSCALL, 241, true);
  setArg(0, epfd);
  setArg(1, eventsOff);
  setArg(2, 1);
  setArg(3, 0); // timeout=0
  setArg(4, 0); // sigmask=NULL
  setArg(5, 8);

  console.log(`\nCalling epoll_pwait... SP before=${getSP()}`);
  try {
    handleChannel(scratchOffset, 1);
    const ret = Number(kernelView.getBigInt64(CH_RETURN, true));
    const err = kernelView.getUint32(CH_ERRNO, true);
    console.log(`epoll_pwait = ${ret}, errno=${err}, SP=${getSP()}`);
  } catch (e) {
    console.error(`CRASHED: ${e}`);
    console.log(`SP after crash: ${getSP()}, memPages=${km.grow(0)}`);
  }

  // Try with timeout=1000 (what PHP-FPM uses)
  kernelView.setUint32(CH_SYSCALL, 241, true);
  setArg(0, epfd);
  setArg(1, eventsOff);
  setArg(2, 1);
  setArg(3, 1000);
  setArg(4, 0);
  setArg(5, 8);

  console.log(`\nCalling epoll_pwait(timeout=1000)... SP before=${getSP()}`);
  try {
    handleChannel(scratchOffset, 1);
    const ret = Number(kernelView.getBigInt64(CH_RETURN, true));
    const err = kernelView.getUint32(CH_ERRNO, true);
    console.log(`epoll_pwait(1000) = ${ret}, errno=${err}, SP=${getSP()}`);
  } catch (e) {
    console.error(`CRASHED: ${e}`);
    console.log(`SP after crash: ${getSP()}, memPages=${km.grow(0)}`);
  }
}

main().catch(console.error);
