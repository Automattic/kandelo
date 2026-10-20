# Workaround: JSC `Worker.terminate()` does not reclaim `Atomics.wait`-blocked workers

**Status:** active workaround. Remove when the JavaScriptCore engine bug is fixed
(see [Removal](#removal)).

**Marker:** every participating code site is tagged
`[JSC-TERMINATE-ATOMICS-WAIT-LEAK]`. To find them all:

```
git grep -n "JSC-TERMINATE-ATOMICS-WAIT-LEAK"
```

## The engine bug

On **JavaScriptCore (JSC)**, calling `Worker.terminate()` on a worker that is
parked in `Atomics.wait()` does **not** free the worker's OS thread or its
committed memory. In Kandelo every process/thread worker spends nearly all its
life parked in `Atomics.wait` (JS side in `worker-main.ts`, or the wasm
`memory.atomic.wait32` in the musl channel glue) waiting for the kernel to
service a syscall on its shared channel. So tearing a machine down by terminating
those workers leaks all of them — threads and working set — and repeatedly
booting/switching machines in one tab grows memory without bound until the tab
throws "Out of Memory".

**This is engine-specific, not host-specific.** The relevant boundary is the
JavaScript engine, not "browser vs Node":

| Engine | Runtimes | `terminate()` on a blocked worker |
|---|---|---|
| **JSC** | **Safari, Bun** | leaks thread + memory — needs this workaround |
| **V8** | Chrome, Node.js | interrupts the wait and reclaims — workaround is a no-op |

Because Bun embeds JSC, the **Node host entry** (`node-kernel-worker-entry.ts`)
is affected too when run under Bun — not just the browser. The workaround is
therefore applied in **both** host entries, unconditionally: it is required on
JSC and merely a small, bounded no-op cost on V8, which is cheaper and less
fragile than sniffing the engine at runtime.

Upstream: closest existing WebKit bug is
[#278866](https://bugs.webkit.org/show_bug.cgi?id=278866) ("[JSC] Fix
`Atomics.wait` by handling termination cases", fixed 2024 but JS-only and does
not resolve this case) and the disputed
[#250569](https://bugs.webkit.org/show_bug.cgi?id=250569). A fresh, minimal
reproduction + a draft bug report to file are in
`~/notes/Agent-logs/2026-07-09-webkit-atomics-wait-terminate-leak.md`. The
committed standalone repro is `apps/browser-demos/public/terminate-atomics-test.html`.

## How the workaround reaches a clean exit

Instead of terminating a blocked worker directly, on teardown we drive it to run
its own exit path so it returns to an idle JS event loop, which `terminate()`
*can* reclaim on JSC:

1. **`host/src/kernel-worker.ts` → `killAllBlockedForTeardown()`** — for every
   process channel currently parked at `CH_STATUS == CH_PENDING` (main threads
   and pthreads; keyed on channel status so it also catches `accept()`/`epoll`
   waiters that aren't in any per-resource wait map), complete the blocked
   syscall with `-EINTR` and write `SIGKILL` into the channel signal slot
   (`wakeChannelForTeardownExit`).
2. **`libc/glue/channel_syscall.c` → `__deliver_pending_signal()`** — runs right
   after every syscall returns; a queued `SIGKILL` (never delivered to the guest
   in normal operation) is treated as "exit now" and calls the **`kernel_exit`
   import directly**. It must NOT call musl `_exit()`, which issues
   `SYS_exit_group` over the channel and then spins `for(;;) SYS_exit`, re-parking
   the worker in `Atomics.wait` — the exact un-reclaimable state we are escaping.
   The `_Noreturn` import is followed by an `unreachable` trap.
3. **`host/src/worker-main.ts`** — catches the `unreachable` trap as a clean
   exit, posts `{exit}`, and the worker returns to its idle JS event loop.
4. **Both host `handleDestroy`** (`browser-kernel-worker-entry.ts`,
   `node-kernel-worker-entry.ts`) — call `killAllBlockedForTeardown()`, then
   drain (`while (processes.size > 0)`, bounded by
   `DESTROY_KILL_DRAIN_TIMEOUT_MS`) while the woken workers exit and their
   `{exit}` handlers reclaim them, then terminate any stragglers.

## Single-process variant: `terminate_process` (machine switch)

The same leak has a second entry point. Whole-machine `destroy()` is not the
only path that terminates a blocked worker: the `terminate_process` RPC
(`BrowserKernel.terminateProcess`) force-kills one process, and a kandelo-session
machine switch uses it to tear down the previous terminal session's process
before booting the next image. An idle shell is parked in an in-wasm
`Atomics.wait` on its syscall channel (a blocked PTY `read`), so
`handleTerminateProcess` calling `terminateTrackedWorker` directly leaked one
`WebCore: Worker` thread (+ its committed working set) per switch on JSC —
non-decaying — until Safari/iOS threw "Out of memory". `destroy()`'s
`performDestroy` never covered it: by the time it runs, `terminate_process` has
already removed the process (`processes.size == 0`), so its Phase-1
`killAllBlockedForTeardown` wakes nothing.

Fix: `killBlockedProcessForTeardown(pid)` — a per-pid counterpart of
`killAllBlockedForTeardown` that wakes only the target process's `CH_PENDING`
channels, so sibling processes (e.g. several servers torn down independently)
keep running. `handleTerminateProcess` calls it and drains (bounded) for the
cooperative `{exit}`; if the process exits, `finishProcessExit` terminates the
now-idle worker and the force path is skipped. A guest wedged in a
non-syscalling wasm loop never observes the wake and falls through to the
force-terminate (still leaks that one worker on JSC — the truthful cost of an
unresponsive guest). Delivering SIGKILL through the ordinary signal path
(`signalProcess`) is **not** sufficient: it wakes only *registered* blockers
(signal-waits, futex, `wait4`, pipe readers), never a channel merely parked at
`CH_PENDING` on a blocked `read`/`accept` — the wake must scan `CH_STATUS`.

The Node host's `handleTerminate` does **not** need this: on V8
`Worker.terminate()` reaps an `Atomics.wait`-parked worker, so a direct
terminate frees the thread. The wake is browser-only by the same platform
boundary as the rest of this workaround.

## Exec retirement

Successful `exec` also has to unwind the old Worker without issuing `SYS_EXIT`
for the persistent PID. The kernel completes its old channel with SIGKILL and
the private `EXEC_RETIRE_SIGNAL_CODE`. The `kernel_exit` import executes a real Wasm trap, leaving that marker
intact until the Worker
boundary recognizes it. Import adapters may re-trap and replace the exception
object, so class identity alone cannot identify retirement.

A JavaScript-thrown `Error` or `WebAssembly.RuntimeError` here is catchable by
guest exception machinery. The Wasm helper supplies a real uncatchable trap
for both normal exit and exec retirement.
In particular, libc++'s `noexcept` handler attempts to print `libc++abi:` with
`writev` on a channel the host has stopped servicing. This leaves the old
Worker in `Atomics.wait`, where JSC termination cannot reclaim it. Committed
normal exit must also bypass guest deallocators, whose syscalls would otherwise
park on a channel already closed by Rust. Pthread exit still releases host-side
replication locks needed by the surviving process. Both main
and pthread worker boundaries recognize terminal traps, avoid executing
guest deallocators on the retired image, and report `exec_retired` before the
entry wrapper reports `memory_quiescent`. The containing browser's destroy
deadline must also cover the worker's cleanup phases; its 15-second bound
allows the existing exec, process, framebuffer and PCM drains to finish.

## Participating code sites

All tagged `[JSC-TERMINATE-ATOMICS-WAIT-LEAK]`:

- `libc/glue/channel_syscall.c` — the `signum == 9` branch in
  `__deliver_pending_signal` calling `kernel_exit`.
- `host/src/kernel-worker.ts` — the `SIGKILL` constant, `killAllBlockedForTeardown()`,
  `killBlockedProcessForTeardown()` (per-pid), and `wakeChannelForTeardownExit()`.
- `host/src/browser-kernel-worker-entry.ts` — `DESTROY_KILL_DRAIN_*` constants,
  the wake/drain phases in `handleDestroy`, and the per-pid wake/drain preamble
  in `handleTerminateProcess`.
- `host/src/node-kernel-worker-entry.ts` — `DESTROY_KILL_DRAIN_*` constants and
  the wake/drain preamble in `handleDestroy` (and the parity note in
  `handleTerminate` explaining why the per-pid wake is browser-only).

Note the musl glue change means every program binary must be **relinked** to pick
up the new `kernel_exit`-on-SIGKILL behavior; CI rebuilds them from source.
Old-glue binaries degrade gracefully (they still leak on JSC, but do not crash).

## Already-exited processes

A process can already have a recorded exit status while one of its Workers is
still blocked (for example, after a signal or a sibling's `exit_group`). Wake
these Workers too, before awaiting their terminal fences. Non-exit requests on
an exited channel receive EINTR plus SIGKILL and `EXIT_RETIRE_SIGNAL_CODE`.
The Worker boundary recognizes this host-only marker, skips guest cleanup and
returns without issuing `SYS_EXIT` or a second exit message. Deferred-signal
JS imports use the same terminal path even if they throw EINTR before returning
to Wasm. Rust's recorded status and parent notification remain authoritative.

A genuinely unresponsive guest that never reaches a syscall can still require
forced termination. This remains an engine boundary on JSC.

## Pending asynchronous futex waits

Waking the guest's syscall channel is only half of futex teardown. The kernel
worker also owns an `Atomics.waitAsync` on the futex address. Deleting its
`pendingFutexWaits` entry does not cancel that engine wait: the unresolved
promise reaction retains the process Memory and can survive termination of
its owning Worker realm. This exhausts iOS's shared-Wasm reservation pool even
when OS samples show no leaked guest Worker threads.

Both teardown variants call each selected wait's `retire()` before dropping
its registration. Retirement wakes the engine waiter and settles its state
without publishing a guest syscall completion. Per-process teardown preserves
sibling processes' waits. This is ordinary resource cleanup on every engine,
not a temporary JavaScriptCore workaround.

## Removal

When JSC reclaims `Atomics.wait`-blocked workers on `terminate()` (verify against
the target Safari/Bun versions using the repro above and
`apps/browser-demos/public/terminate-atomics-test.html`):

1. Delete the wake/drain phases from both `handleDestroy` (revert to a plain
   terminate loop), the per-pid wake/drain preamble in the browser
   `handleTerminateProcess`, and the `DESTROY_KILL_DRAIN_*` constants.
2. Remove the guest-channel wake helpers only after preserving cancellation
   of asynchronous futex waits in the ordinary teardown path. Do not delete
   futex retirement, real Wasm exit traps, or exact-generation terminal fences:
   those enforce portable resource and process-lifecycle contracts.
3. Delete the `signum == 9` branch in `__deliver_pending_signal`, then rebuild
   musl (`scripts/build-musl.sh`) and relink programs / rebuild VFS images.
4. Re-run validation on **both** engines: the WordPress boot/destroy loop on
   Safari **and Bun** should now stay flat (threads + RSS) with the workaround
   removed. If it doesn't, the engine bug isn't fully fixed — keep the workaround.

## Validation (while the workaround is in place)

- **Cross-engine teardown test** (`host/test/teardown-reclaim.test.ts`): spawns a
  daemon parked in a blocking syscall (`examples/block-forever.c`), destroys the
  kernel, and asserts it was woken into a cooperative exit (status 137 = 128 +
  SIGKILL) rather than force-terminated. Runs under **both** V8 and JSC:
  ```
  cd host && npm run test:teardown:engines   # Node, then bun x --bun vitest
  ```
  `pthread.test.ts` ("preserves exit(0)… while the main thread is blocked") also
  runs under both and covers the already-exited-process guard. `bun` is provided
  by the flake dev shell. `--bun` is required because the Vitest executable's
  Node shebang otherwise selects V8. The Bun invocation also declares its
  expected runtime, and the teardown test refuses a Node worker in that run.
  The test uses the worktree's SourceOnly kernel output, with the former flat
  output retained as a fallback; it never selects an ambient global kernel.
- Host vitest (Node/V8) also exercises the teardown path throughout the suite
  (it's how `runCentralizedProgram` tears down every process).
- Playwright WebKit: kernel-owned WordPress boot/destroy loop — threads flat,
  RSS converges to a bounded plateau (before the fix: +~11 threads and
  +~900–1100 MiB per switch, monotonic). This is the only check that measures
  actual memory/thread reclamation (the in-process tests assert the cooperative
  path ran, not the OS-level reclaim). See
  `~/notes/Agent-logs/2026-07-08-safari-image-switch-oom.md` and PR
  [Automattic/kandelo#863](https://github.com/Automattic/kandelo/pull/863).
