# JSC-TERMINATE-ATOMICS-WAIT-LEAK

Status: confirmed on Bun 1.3.3 (macOS). Not reproduced on Playwright WebKit
webkit-2359; reproduced on webkit-2311. Released Safari not yet checked.
Not filed.

## Defect

On JavaScriptCore (JSC), `Worker.terminate()` does not stop a worker that is
blocked in an infinite atomic wait, either JavaScript `Atomics.wait()` or
WebAssembly `memory.atomic.wait32`. The worker stays registered as a waiter
on the word it waited on, and its OS thread and everything it holds (its
`WebAssembly.Memory`, its JavaScript heap) are not released. Repeating
create, block, terminate leaks one thread and the worker's committed memory
each time, until the process runs out of memory.

The HTML specification's "terminate a worker" steps abort the script
running in the worker; a worker that cannot be terminated while it waits
breaks that, and the leaked resources are never reclaimable.

## Why Kandelo is affected

Every Kandelo process and thread runs in a worker, and that worker spends
almost all its life blocked in `memory.atomic.wait32` (in the musl syscall
glue) or `Atomics.wait` (in `host/src/worker-main.ts`), waiting for the
kernel to answer a syscall on its channel. Tearing a machine down by
terminating those workers leaked all of them on Safari: repeatedly booting
or switching machines in one tab grew memory until Safari threw "Out of
memory" (PR #863). Bun embeds JSC, so the Node.js host entry is affected
when it runs under Bun.

## Workaround and its cost

Instead of terminating a blocked worker directly, teardown drives it to run
its own exit path, so it returns to an idle JavaScript event loop that
`terminate()` can reclaim. The kernel completes each blocked syscall with
`EINTR` and queues `SIGKILL` in the channel; the syscall glue treats that
as "exit now" and calls the `kernel_exit` import directly; the worker posts
its exit and is then terminated. Whole-machine destroy wakes every process
(`killAllBlockedForTeardown`); `terminate_process` wakes one
(`killBlockedProcessForTeardown`). The mechanism, the participating code
and its interaction with exec retirement are described in
[`docs/jsc-terminate-atomics-wait-workaround.md`](../../../docs/jsc-terminate-atomics-wait-workaround.md).
Every site carries the tag (`git grep -n "RUNTIME-WORKAROUND: JSC-TERMINATE"`).

Cost: destroy and `terminate_process` wait up to
`DESTROY_KILL_DRAIN_TIMEOUT_MS` (1.5 s) for workers to exit; the glue has a
special case for `SIGKILL`; teardown has more states to get right. It runs
on every engine (on V8 it is a small no-op cost) because that is cheaper and
less fragile than detecting the engine. A guest stuck in a loop that never
makes a syscall never sees the wake and still leaks its worker on JSC.

## Evidence

`repro/repro.mjs` (JavaScript hosts, `node:worker_threads`) and
`repro/repro.html` (browsers) run the same probe. A worker commits 16 MiB of
a shared `WebAssembly.Memory` and blocks in an infinite wait on word 0. The
parent terminates it, waits 5 s, and calls `Atomics.notify()` on word 0.
`notify` returns how many waiters it woke, so 0 means the terminated worker
is gone and 1 means it is still parked. A sanity check runs first: a
blocked worker that is *not* terminated must be counted as 1. Both waits are
tested (`js` = `Atomics.wait`, `wasm` = `memory.atomic.wait32`).

Driver results on macOS 27, 2026-10-22 (counts per round):

| runtime | version | result |
|---|---|---|
| Bun | 1.3.3 | reproduced: js [1,1], wasm [1,1] |
| Node.js (V8, control) | v24.15.0 | not reproduced: js [0,0], wasm [0,0] |
| Playwright WebKit webkit-2311 (Playwright 1.61.0) | 26.5 | reproduced: js [1,1,1], wasm [1,1,1]; still 1 after 10 s |
| Playwright WebKit webkit-2359 | 26.6 | not reproduced: js [0,0,0], wasm [0,0,0] |
| Playwright Chromium | 153.0.8010.12 | not reproduced with the 5 s wait |
| Playwright Firefox | 155.0 | not reproduced |

The webkit-2311 run used a scratch launcher with Playwright 1.61.0, because
the repository's Playwright 1.63.0 cannot drive that build; that record is
`source = "manual"`. Chromium still counted the terminated worker 1 s after
`terminate()` and no longer after 2 s, which is why the probe waits 5 s.

The waiter count tracks the real leak. In Bun, 10 workers that each
committed 64 MiB and were terminated while blocked raised the process from
6 to 18 threads and its RSS by 691 MiB; the same workers terminated while
idle raised it from 6 to 9 threads and 78 MiB. Under Node.js the thread
count stayed at 7.

History from the maintainer's notes:

- 2026-07-09: the manual harness
  (`apps/browser-demos/public/terminate-atomics-test.html`) leaked one
  thread and the committed memory per iteration on Playwright WebKit
  webkit-2311, measured in Activity Monitor. Waking the worker with
  `Atomics.notify()` before `terminate()` did not leak.
- 2026-09-24: on webkit-2336, infinite JS `Atomics.wait` (100 MiB
  committed) and Wasm `memory.atomic.wait32` variants terminated while
  parked were both flat. In the same investigation the Kandelo app still
  leaked one `WebCore: Worker` thread per machine switch, whose sampled
  stack was in `operationMemoryAtomicWait32`, until `terminate_process`
  gained the per-process wake. So on recent WebKit builds the trigger may be
  narrower than this reduction, or that leak had another cause; it is
  unresolved.

## Why this is not a Kandelo defect

The reproduction contains no Kandelo code: a worker, a shared memory, one
wait, `terminate()`. It reproduces on Bun and on an older WebKit build, and
not on V8 or SpiderMonkey, and the sanity check shows the probe counts a
blocked worker correctly. Whether released Safari still leaks is not yet
known.

## Draft upstream report

Not filed. Two candidate trackers: Bun (github.com/oven-sh/bun) for the Bun
result, and bugs.webkit.org (JavaScriptCore) if released Safari still
reproduces. Related WebKit bugs, neither of which covers this case:

| Bug | Title | Status | Relevance |
|---|---|---|---|
| [278866](https://bugs.webkit.org/show_bug.cgi?id=278866) | [JSC] Fix `Atomics.wait` by handling termination cases | RESOLVED FIXED, Aug 2024 (`282974@main`) | Made JSC wake infinite-timeout waiters on VM termination. Touched `AtomicsObject.cpp`, `VMTraps.cpp`, `WaiterListManager.{h,cpp}`; JS `Atomics.wait` only. webkit-2311 still reproduced after it. |
| [250569](https://bugs.webkit.org/show_bug.cgi?id=250569) | Terminated worker memory leak | RESOLVED CONFIGURATION CHANGED (disputed) | Child workers not collected after the parent terminates. The reporter said it still reproduced in Safari 18.0.1; the WebKit engineer asked for a fresh bug with a concrete reproduction. |

> **Title:** `Worker.terminate()` does not reclaim a worker blocked in
> `Atomics.wait` or `memory.atomic.wait32`; the terminated worker stays a
> registered waiter and its thread and memory leak
>
> **Environment:** Bun 1.3.3 (macOS 27); WebKit: Playwright WebKit
> webkit-2311 (26.5) reproduces, webkit-2359 (26.6) does not; Safari
> _<version to check>_. Browsers need a cross-origin-isolated page
> (`Cross-Origin-Opener-Policy: same-origin`,
> `Cross-Origin-Embedder-Policy: require-corp`) for shared memory.
>
> **Summary:** When a worker is blocked in an infinite `Atomics.wait()` or
> WebAssembly `memory.atomic.wait32`, `worker.terminate()` does not stop it.
> Five seconds later `Atomics.notify()` on the word it waited on still wakes
> one waiter, and the worker's OS thread and committed memory are still in
> the process: 10 such workers, each holding 64 MiB, added 12 threads and
> 691 MiB RSS to a Bun process. A worker terminated while idle is
> reclaimed. Node.js (V8) and Firefox reclaim the blocked worker.
>
> **Steps:** run `bun repro.mjs` (attached `repro/` directory), or serve
> `repro/` cross-origin isolated and open `repro.html`. Each prints a
> verdict line with the waiter counts per round.
>
> **Expected:** after `terminate()`, the worker's wait ends, its thread
> exits, and its memory is released; `notify` counts 0.
> **Actual:** `notify` counts 1 for every terminated worker; threads and
> memory grow with each create, block, terminate cycle.
>
> **Impact:** a WebAssembly multi-process runtime that runs each process in
> a worker blocked on a syscall channel leaks every worker it tears down,
> and repeated restarts run the tab or process out of memory.
>
> **References:** WebKit bugs 278866 (`282974@main`) and 250569.

The original draft for bugs.webkit.org, written 2026-07-09 against
webkit-2311 with the manual harness (watch threads and RSS in Activity
Monitor), is kept in the maintainer's notes
(`2026-07-09-webkit-atomics-wait-terminate-leak.md`); it also explains how
to build WebKit locally and where to look (`WaiterListManager`, `VMTraps`,
`AtomicsObject.cpp`, `Source/JavaScriptCore/wasm/`,
`Source/WebCore/workers/`).

## Removal criteria

Remove the workaround only when every supported JSC host reclaims a blocked
worker: the latest released Safari (macOS and iOS) and the Bun version the
dev shell pins. Check with this entry's reproduction first; a
`not-reproduced` on a Playwright build alone is not enough. Then:

1. Delete the wake/drain phases from both `handleDestroy` paths (revert to a
   plain terminate loop), the per-process wake/drain preamble in the browser
   `handleTerminateProcess`, and the `DESTROY_KILL_DRAIN_*` constants.
2. Remove the guest-channel wake helpers (`killAllBlockedForTeardown`,
   `killBlockedProcessForTeardown`, `wakeChannelForTeardownExit`) only
   after keeping cancellation of asynchronous futex waits in the ordinary
   teardown path. Do not delete futex retirement, real Wasm exit traps, or
   exact-generation terminal fences: those enforce portable resource and
   process-lifecycle contracts.
3. Delete the `signum == 9` branch in `__deliver_pending_signal`
   (`libc/glue/channel_syscall.c`), then rebuild musl
   (`scripts/build-musl.sh`) and relink programs and rebuild VFS images.
4. Re-run validation on both JSC hosts: the WordPress boot/destroy loop on
   Safari and on Bun must stay flat (threads and RSS) with the workaround
   removed. If it does not, the engine defect is not fully fixed; keep the
   workaround.
5. Set this entry to `retired` with the removal commit.
