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

## Participating code sites

All tagged `[JSC-TERMINATE-ATOMICS-WAIT-LEAK]`:

- `libc/glue/channel_syscall.c` — the `signum == 9` branch in
  `__deliver_pending_signal` calling `kernel_exit`.
- `host/src/kernel-worker.ts` — the `SIGKILL` constant, `killAllBlockedForTeardown()`,
  and `wakeChannelForTeardownExit()`.
- `host/src/browser-kernel-worker-entry.ts` — `DESTROY_KILL_DRAIN_*` constants and
  the wake/drain phases in `handleDestroy`.
- `host/src/node-kernel-worker-entry.ts` — `DESTROY_KILL_DRAIN_*` constants and
  the wake/drain preamble in `handleDestroy`.

Note the musl glue change means every program binary must be **relinked** to pick
up the new `kernel_exit`-on-SIGKILL behavior; CI rebuilds them from source.
Old-glue binaries degrade gracefully (they still leak on JSC, but do not crash).

## Known limitation

`killAllBlockedForTeardown` only wakes processes the kernel still reports as
**live** (`kernel_get_process_exit_status(pid) == -1`). It deliberately skips a
process that has already `exit_group`'d via one thread while another thread is
still parked in `Atomics.wait` (e.g. `pthread` calls `exit(0)` while `main` is
blocked): waking that parked sibling would run our `kernel_exit` and clobber the
already-recorded exit status (turning a real `exit(0)` into `137`). Such a
straggler is force-terminated instead. On V8 that reclaims fine; on JSC that one
stuck worker still leaks — but this is a narrow, unusual case (it also leaks on
JSC via the normal exit path, independent of teardown), not the dominant
per-machine-teardown leak this workaround targets.

## Removal

When JSC reclaims `Atomics.wait`-blocked workers on `terminate()` (verify against
the target Safari/Bun versions using the repro above and
`apps/browser-demos/public/terminate-atomics-test.html`):

1. Delete the wake/drain phases from both `handleDestroy` (revert to a plain
   terminate loop) and the `DESTROY_KILL_DRAIN_*` constants.
2. Delete `killAllBlockedForTeardown()` and `wakeChannelForTeardownExit()` from
   `kernel-worker.ts` (and the `SIGKILL` constant if unused elsewhere).
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
  cd host && npm run test:teardown:engines   # vitest on Node, then `bun x vitest`
  ```
  `pthread.test.ts` ("preserves exit(0)… while the main thread is blocked") also
  runs under both and covers the already-exited-process guard. `bun` is provided
  by the flake dev shell.
- Host vitest (Node/V8) also exercises the teardown path throughout the suite
  (it's how `runCentralizedProgram` tears down every process).
- Playwright WebKit: kernel-owned WordPress boot/destroy loop — threads flat,
  RSS converges to a bounded plateau (before the fix: +~11 threads and
  +~900–1100 MiB per switch, monotonic). This is the only check that measures
  actual memory/thread reclamation (the in-process tests assert the cooperative
  path ran, not the OS-level reclaim). See
  `~/notes/Agent-logs/2026-07-08-safari-image-switch-oom.md` and PR
  [Automattic/kandelo#863](https://github.com/Automattic/kandelo/pull/863).
