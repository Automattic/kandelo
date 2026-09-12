// K0c: drive SYS_EPOLL_PWAIT through kernel_handle_channel on the REAL
// kernel.wasm, to test the 2026-04-01 claim that this crashes Chrome
// (kernel-worker.ts:12274, "suspected V8 bug with shared Wasm memory").
//
// Deliberately minimal: no worker, no guest, no VFS. Just the kernel
// instance + a shared memory + the channel call the claim names.
export const CH = {
  STATUS: 0, SYSCALL: 4, ARGS: 8, ARG_SIZE: 8,
  RETURN: 56, ERRNO: 64, DATA: 72, TOTAL: 65608,
};
export const SYS_EPOLL_PWAIT = 241;
const EPOLL_CTL_ADD = 1, EPOLLIN = 1;

export async function runEpollProbe(kernelBytes, sharePeer) {
  const log = [];
  const step = (k, v) => { log.push([k, v]); return v; };

  const memory = new WebAssembly.Memory({ initial: 24, maximum: 16384, shared: true });
  step('sab', memory.buffer instanceof SharedArrayBuffer);
  if (sharePeer) { sharePeer(memory); step('peer_worker_sharing_memory', true); await new Promise(r => setTimeout(r, 150)); }

  const module = await WebAssembly.compile(kernelBytes);
  const env = { memory };
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.module !== 'env' || imp.name === 'memory') continue;
    env[imp.name] ??= imp.kind === 'function'
      ? (() => 0)
      : imp.kind === 'global'
        ? new WebAssembly.Global({ value: 'i32', mutable: true }, 0)
        : undefined;
  }
  const { exports: ex } = await WebAssembly.instantiate(module, { env });
  step('abi_version', ex.__abi_version ? ex.__abi_version() : null);

  const dv = () => new DataView(memory.buffer);

  const pid = step('pid', ex.kernel_create_process());
  if (pid <= 0) return { log, verdict: 'setup-failed' };
  step('bind_tid', ex.kernel_set_current_tid(pid, pid));

  // eventfd with a nonzero counter is immediately EPOLLIN-ready, so
  // epoll_pwait has real work to do and a real result to write back.
  const efd  = step('eventfd', ex.kernel_eventfd2(1, 0));
  const epfd = step('epoll_create1', ex.kernel_epoll_create1(0));
  if (efd < 0 || epfd < 0) return { log, verdict: 'setup-failed' };

  const evPtr = ex.kernel_alloc_scratch(16);
  dv().setUint32(evPtr + 0, EPOLLIN, true);
  dv().setBigUint64(evPtr + 8, 0xdeadbeefn, true);
  step('epoll_ctl_add', ex.kernel_epoll_ctl(epfd, EPOLL_CTL_ADD, efd, evPtr));

  // Build the channel record and make THE call the claim is about.
  const chan = ex.kernel_alloc_scratch(CH.TOTAL);
  step('chan_ptr_nonzero', chan !== 0);
  const v = dv();
  v.setUint32(chan + CH.STATUS, 1 /* PENDING */, true);
  v.setUint32(chan + CH.SYSCALL, SYS_EPOLL_PWAIT, true);
  const arg = (i, val) => v.setBigUint64(chan + CH.ARGS + i * CH.ARG_SIZE, BigInt(val), true);
  arg(0, epfd);
  arg(1, chan + CH.DATA); // events out-buffer, absolute kernel pointer
  arg(2, 4);              // maxevents
  arg(3, 0);              // timeout 0 = non-blocking
  arg(4, 0);              // sigmask NULL

  step('CALLING_kernel_handle_channel', true);
  const rc = ex.kernel_handle_channel(chan, CH.TOTAL, pid, 0n);
  step('handle_channel_rc', rc);

  const v2 = dv();
  const ret = v2.getInt32(chan + CH.RETURN, true);
  const errno = v2.getInt32(chan + CH.ERRNO, true);
  step('ch_return', ret);
  step('ch_errno', errno);
  if (ret > 0) {
    step('event0_events', v2.getUint32(chan + CH.DATA, true));
    step('event0_data_lo', v2.getUint32(chan + CH.DATA + 8, true));
  }
  // Call it repeatedly: a shared-memory JIT bug may need warm-up to tier up.
  let repeats = 0;
  for (let i = 0; i < 2000; i++) {
    v2.setUint32(chan + CH.STATUS, 1, true);
    v2.setUint32(chan + CH.SYSCALL, SYS_EPOLL_PWAIT, true);
    arg(0, epfd); arg(1, chan + CH.DATA); arg(2, 4); arg(3, 0); arg(4, 0);
    ex.kernel_handle_channel(chan, CH.TOTAL, pid, 0n);
    repeats++;
  }
  step('repeat_calls_survived', repeats);
  return { log, verdict: ret >= 0 ? 'OK' : `errno ${errno}` };
}
