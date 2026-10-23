# JSC-TERMINATE-ATOMICS-WAIT-LEAK

Status: confirmed on Bun 1.3.3 (macOS), through `node:worker_threads`.
Playwright WebKit reproduced it on build webkit-2311 and does not on
webkit-2359. Released Safari has not been checked. Not filed.

## Defect

On Bun 1.3.3, `worker.terminate()` (`node:worker_threads`) does not stop a
worker that is blocked in an infinite atomic wait, either JavaScript
`Atomics.wait()` or WebAssembly `memory.atomic.wait32`. The worker stays
registered as a waiter on the word it waited on. While it stays blocked,
the promise `terminate()` returns does not settle, no `'exit'` event
fires, and the worker's OS thread and everything it holds (its
`WebAssembly.Memory`, its JavaScript heap) are not released. Only when
something wakes the waiter (an `Atomics.notify()` on that word) does the
termination complete: the promise settles and `'exit'` fires within a
second. A worker that nothing wakes therefore leaks, and repeating create,
block, terminate leaks one thread and the worker's committed memory each
time. A worker terminated while idle is reclaimed.

Bun implements the Node.js `worker_threads` API, whose documentation says
`worker.terminate()` stops all JavaScript execution in the worker thread as
soon as possible and returns a promise fulfilled when the `'exit'` event is
emitted. Node.js 24 does that for the same blocked worker in about 5 ms;
on Bun the promise is still pending 5 s later and settles only after the
notify.

Earlier WebKit builds showed the same in a browser: on Playwright WebKit
webkit-2311 a dedicated worker (`new Worker` in a page) blocked in either
wait was still a registered waiter 10 s after `terminate()`, and the
maintainer measured one leaked thread and the committed memory per
iteration there. webkit-2359 no longer does this. Whether the cause is in
JavaScriptCore itself, which Bun and WebKit share, or separately in Bun's
worker layer and WebKit's, is not known; the ID names JSC because that is
where the defect was first seen.

## Why Kandelo is affected

Every Kandelo process and thread runs in a worker, and that worker spends
almost all its life blocked in `memory.atomic.wait32` (in the musl syscall
glue) or `Atomics.wait` (in `host/src/worker-main.ts`), waiting for the
kernel to answer a syscall on its channel. Tearing a machine down by
terminating those workers leaked all of them on Safari in July 2026:
repeatedly booting or switching machines in one tab grew memory until
Safari threw "Out of memory" (PR #863). The Node.js host entry is affected
when it runs under Bun, which reproduces the leak today.

## Workaround and its cost

Instead of terminating a blocked worker directly, teardown drives it to run
its own exit path, so it returns to an idle JavaScript event loop that
`terminate()` can reclaim. The kernel completes each blocked syscall with
`EINTR` and queues `SIGKILL` in the channel; the syscall glue treats that
as "exit now" and calls the `kernel_exit` import directly; the worker posts
its exit and is then terminated. Whole-machine destroy wakes every process
(`killAllBlockedForTeardown`); on the browser host `terminate_process`
wakes one (`killBlockedProcessForTeardown`). The Node host's
`terminate_process` handler terminates directly, so under Bun a blocked
process killed that way still leaks its worker: a known gap. The mechanism, the participating code
and its interaction with exec retirement are described in
[`docs/jsc-terminate-atomics-wait-workaround.md`](../../../docs/jsc-terminate-atomics-wait-workaround.md).
Every site carries the tag (`git grep -n "RUNTIME-WORKAROUND: JSC-TERMINATE"`).

Cost: whole-machine destroy (on both hosts) and the browser host's
`terminate_process` wait up to `DESTROY_KILL_DRAIN_TIMEOUT_MS` (1.5 s) for
workers to exit (the Node host's `terminate_process` does not wait; it
terminates directly, as above); the glue has a
special case for `SIGKILL`; teardown has more states to get right. It runs
on every engine (on V8 it is a small no-op cost) because that is cheaper and
less fragile than detecting the engine. A guest stuck in a loop that never
makes a syscall never sees the wake and still leaks its worker on an
affected runtime.

## Evidence

`repro/repro.mjs` (JavaScript hosts, `node:worker_threads`) and
`repro/repro.html` (browsers) run the same probe. Both are declared
`[[repro]]` tables, so the suite runs the script on Bun and the page on
WebKit. A worker commits 16 MiB of
a shared `WebAssembly.Memory` and blocks in an infinite wait on word 0. The
parent terminates it, waits 5 s, and calls `Atomics.notify()` on word 0.
`notify` returns how many waiters it woke, so 0 means the terminated worker
is gone and 1 means it is still parked. A sanity check runs first: a
blocked worker that is *not* terminated must be counted as 1. Both waits are
tested (`js` = `Atomics.wait`, `wasm` = `memory.atomic.wait32`).

Driver results on macOS 27, 2026-10-22 (counts per round). Node.js,
Chromium and Firefox are controls: they are recorded only here, because
`entry.toml`'s `observed` holds the affected runtimes (a control that never
had the defect is not evidence of a fix).

| runtime | version | result |
|---|---|---|
| Bun | 1.3.3 | reproduced: js [1,1], wasm [1,1]; `terminate()` settled 0/2 before the notify, 2/2 within 1 s after it |
| Node.js (V8, control) | v24.15.0 | not reproduced: js [0,0], wasm [0,0]; `terminate()` settled 2/2 before the notify |
| Playwright WebKit webkit-2311 (Playwright 1.61.0) | 26.5 | reproduced: js [1,1,1], wasm [1,1,1] (an earlier draft of the page that ran three rounds); still 1 after 10 s |
| Playwright WebKit webkit-2359 | 26.6 | not reproduced: js [0,0], wasm [0,0] (suite run, page default of 2 rounds) |
| Playwright Chromium | 153.0.8010.12 | not reproduced with the 5 s wait |
| Playwright Firefox | 155.0 | not reproduced |

The webkit-2311 run used a scratch launcher with Playwright 1.61.0, because
the repository's Playwright 1.63.0 cannot drive that build; that record is
`source = "manual"`. Chromium still counted the terminated worker 1 s after
`terminate()` and no longer after 2 s, which is why the probe waits 5 s.

The waiter count tracks the real leak. A scratch thread-and-RSS script
run once on 2026-10-22 while this entry was written (not committed, and
not something `repro/` produces) found that in Bun, 10 workers that each
committed 64 MiB and were terminated while blocked raised the process from
6 to 18 threads and its RSS by 691 MiB; the same workers terminated while
idle raised it from 6 to 9 threads and 78 MiB. Under Node.js the thread
count stayed at 7. Before quoting those numbers upstream, rerun such a
measurement and attach it.

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
wait, `terminate()`. It reproduces on Bun 1.3.3 and reproduced on WebKit
build webkit-2311; it does not on Node.js (V8), Chromium, Firefox or
webkit-2359, and the sanity check shows the probe counts a blocked worker
correctly. Whether released Safari leaks today is not known, and neither
is whether the cause lies in JavaScriptCore or in each embedder's worker
layer.

## Draft upstream report

Not filed. The Bun result goes to Bun (github.com/oven-sh/bun); a WebKit
report (bugs.webkit.org, JavaScriptCore) only if released Safari still
reproduces. Related WebKit bugs, neither of which covers this case:

| Bug | Title | Status | Relevance |
|---|---|---|---|
| [278866](https://bugs.webkit.org/show_bug.cgi?id=278866) | [JSC] Fix `Atomics.wait` by handling termination cases | RESOLVED FIXED, Aug 2024 (`282974@main`) | Made JSC wake infinite-timeout waiters on VM termination. Touched `AtomicsObject.cpp`, `VMTraps.cpp`, `WaiterListManager.{h,cpp}`; JS `Atomics.wait` only. webkit-2311 still reproduced after it. |
| [250569](https://bugs.webkit.org/show_bug.cgi?id=250569) | Terminated worker memory leak | RESOLVED CONFIGURATION CHANGED (disputed) | Child workers not collected after the parent terminates. The reporter said it still reproduced in Safari 18.0.1; the WebKit engineer asked for a fresh bug with a concrete reproduction. |

> **Title:** `worker.terminate()` (`node:worker_threads`) does not complete
> while the worker is blocked in `Atomics.wait` or `memory.atomic.wait32`;
> the worker's thread and memory leak until something wakes it
>
> **Environment:** Bun 1.3.3, macOS 27.
>
> **Summary:** When a worker is blocked in an infinite `Atomics.wait()` or
> WebAssembly `memory.atomic.wait32`, `worker.terminate()` does not stop
> it: while the worker stays blocked, the returned promise does not settle
> and no `'exit'` event fires. Five seconds later `Atomics.notify()` on the
> word it waited on still wakes one waiter; only then does the promise
> settle and `'exit'` fire. Until that wake the worker's OS thread and
> committed memory stay in the process. A worker terminated while idle is
> reclaimed.
> Node.js 24 terminates the same blocked worker in about 5 ms, as its
> `worker.terminate()` documentation describes.
>
> **Steps:** run `bun repro.mjs` in the attached `repro/` directory. It
> prints a `REPRO-VERDICT` line with the waiter counts per round and how
> many `terminate()` promises settled before and after the notify. Compare
> `node repro.mjs`.
>
> **Expected:** after `terminate()`, the worker's wait ends, its thread
> exits, its memory is released and the promise settles; `notify` counts
> 0.
> **Actual:** `notify` counts 1 for every terminated worker and the
> promise settles only after that notify; without a wake, threads and
> memory grow with each create, block, terminate cycle.
>
> **Impact:** a WebAssembly multi-process runtime that runs each process in
> a worker blocked on a syscall channel leaks every worker it tears down,
> and repeated restarts run the tab or process out of memory.
>
> **References:** possibly related WebKit bugs 278866 (`282974@main`) and
> 250569; Playwright WebKit webkit-2311 showed the same with
> `repro/repro.html`, webkit-2359 does not.

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
