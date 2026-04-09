/**
 * Reproduce the epoll_pwait crash using CentralizedKernelWorker in Node.js.
 * Run: npx tsx test/epoll-repro.ts
 */
import { CentralizedKernelWorker } from "../../../host/src/kernel-worker.ts";
import { VirtualPlatformIO, MemoryFileSystem, DeviceFileSystem } from "../../../host/src/vfs/index.ts";
import { readFileSync } from "fs";

const CH_SYSCALL = 4;
const CH_ARGS = 8;
const CH_RETURN = 32;
const CH_ERRNO = 36;
const CH_DATA = 40;
const CH_TOTAL_SIZE = 40 + 65536;
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
  const handleChannel = ki.exports.kernel_handle_channel as (off: number, pid: number) => number;

  // 1. epoll_create1(0)
  kernelView.setUint32(CH_SYSCALL, 239, true);
  kernelView.setInt32(CH_ARGS, 0, true);
  for (let i = 1; i < 6; i++) kernelView.setInt32(CH_ARGS + i * 4, 0, true);
  handleChannel(scratchOffset, 1);
  const epfd = kernelView.getInt32(CH_RETURN, true);
  console.log(`epoll_create1(0) = ${epfd}, SP=${getSP()}`);

  // 2. pipe2()
  kernelView.setUint32(CH_SYSCALL, 165, true);
  kernelView.setInt32(CH_ARGS, scratchOffset + CH_DATA, true);
  kernelView.setInt32(CH_ARGS + 4, 0, true);
  for (let i = 2; i < 6; i++) kernelView.setInt32(CH_ARGS + i * 4, 0, true);
  handleChannel(scratchOffset, 1);
  const pipeRet = kernelView.getInt32(CH_RETURN, true);
  const pipeR = new DataView(km.buffer).getInt32(scratchOffset + CH_DATA, true);
  const pipeW = new DataView(km.buffer).getInt32(scratchOffset + CH_DATA + 4, true);
  console.log(`pipe2() = ${pipeRet}, fds=[${pipeR}, ${pipeW}], SP=${getSP()}`);

  // 3. epoll_ctl(epfd, EPOLL_CTL_ADD=1, pipeR, event)
  const evtOff = scratchOffset + CH_DATA;
  new DataView(km.buffer).setUint32(evtOff, 1, true); // EPOLLIN
  new DataView(km.buffer).setBigUint64(evtOff + 4, BigInt(pipeR), true);
  kernelView.setUint32(CH_SYSCALL, 240, true);
  kernelView.setInt32(CH_ARGS, epfd, true);
  kernelView.setInt32(CH_ARGS + 4, 1, true);
  kernelView.setInt32(CH_ARGS + 8, pipeR, true);
  kernelView.setInt32(CH_ARGS + 12, evtOff, true);
  for (let i = 4; i < 6; i++) kernelView.setInt32(CH_ARGS + i * 4, 0, true);
  handleChannel(scratchOffset, 1);
  console.log(`epoll_ctl = ${kernelView.getInt32(CH_RETURN, true)}, SP=${getSP()}`);

  // 4. epoll_pwait(epfd, events, 1, 0, NULL, 8) — timeout=0 for immediate
  const eventsOff = scratchOffset + CH_DATA;
  kernelView.setUint32(CH_SYSCALL, 241, true);
  kernelView.setInt32(CH_ARGS, epfd, true);
  kernelView.setInt32(CH_ARGS + 4, eventsOff, true);
  kernelView.setInt32(CH_ARGS + 8, 1, true);
  kernelView.setInt32(CH_ARGS + 12, 0, true); // timeout=0
  kernelView.setInt32(CH_ARGS + 16, 0, true); // sigmask=NULL
  kernelView.setInt32(CH_ARGS + 20, 8, true);

  console.log(`\nCalling epoll_pwait... SP before=${getSP()}`);
  try {
    handleChannel(scratchOffset, 1);
    const ret = kernelView.getInt32(CH_RETURN, true);
    const err = kernelView.getUint32(CH_ERRNO, true);
    console.log(`epoll_pwait = ${ret}, errno=${err}, SP=${getSP()}`);
  } catch (e) {
    console.error(`CRASHED: ${e}`);
    console.log(`SP after crash: ${getSP()}, memPages=${km.grow(0)}`);
  }

  // Try with timeout=1000 (what PHP-FPM uses)
  kernelView.setUint32(CH_SYSCALL, 241, true);
  kernelView.setInt32(CH_ARGS, epfd, true);
  kernelView.setInt32(CH_ARGS + 4, eventsOff, true);
  kernelView.setInt32(CH_ARGS + 8, 1, true);
  kernelView.setInt32(CH_ARGS + 12, 1000, true);
  kernelView.setInt32(CH_ARGS + 16, 0, true);
  kernelView.setInt32(CH_ARGS + 20, 8, true);

  console.log(`\nCalling epoll_pwait(timeout=1000)... SP before=${getSP()}`);
  try {
    handleChannel(scratchOffset, 1);
    const ret = kernelView.getInt32(CH_RETURN, true);
    const err = kernelView.getUint32(CH_ERRNO, true);
    console.log(`epoll_pwait(1000) = ${ret}, errno=${err}, SP=${getSP()}`);
  } catch (e) {
    console.error(`CRASHED: ${e}`);
    console.log(`SP after crash: ${getSP()}, memPages=${km.grow(0)}`);
  }
}

main().catch(console.error);
