# K3 grounding — move the blocking-wait scheduler into Rust

> Read-only grounding, 2026-09-09. Worktree
> `/Users/brandon/kandelo-abi44-reconcile`, branch
> `integration/k-tier1-20260909` (tip `bd3364c95`). No code was changed.
> Companion to `2026-09-09-rust-first-value-plan.md` (§5 Tier 2, K3),
> `2026-09-09-whole-kernel-rust-migration-census.md` (F4, §5.1) and
> `2026-09-09-runtime-ts-disposition-ledger.md`.
>
> **Every line number below was re-verified against this tip.** Several
> numbers carried in the census and the plan have drifted — the file is now
> 34,702 lines, not 34,875 — and one of them (`kernel-worker.ts:12274`, the
> epoll V8 comment) now points at unrelated code. Line numbers cited from
> earlier campaign documents should be re-resolved, not trusted.
>
> Claims are marked **VERIFIED** (I read the cited lines) or **INFERRED**
> (reasoning from what I read). Recommendations rest only on VERIFIED
> facts, except where an INFERRED claim is explicitly flagged as needing a
> probe.

---

## 0. Executive summary

**The shape is confirmed, and it is worse than "Rust computes, TypeScript
waits".** Rust computes readiness *and* classifies would-block *and* pins the
retry target — but it has **no concept of a sleeping task at all**. There is no
`Blocked` process state, no wait queue, no deadline, no timer. Every deadline
in the system is a JavaScript `Date.now()` comparison, and every parked task is
a JavaScript `Map` entry holding a `setTimeout` handle.

Six findings change what K3 *is*:

1. **The epoll mirror's stated justification is not merely disproved — the
   code already abandoned it.** `handleEpollPwait` dispatches `SYS_EPOLL_PWAIT`
   through `kernel_handle_channel` today (`kernel-worker.ts:20013`); commit
   `d94c4652b` removed the bypass. **Four** comments still assert the V8 crash
   as fact (`:3246`, `:12237`, `:18029`, `:19616`). The mirror now survives for
   exactly three uses, of which only one is functional — and the two POSIX gaps
   it conceals are already broken *with it in place* (§4).

2. **`blocked_retry.rs` is not K3's destination. Most of it is scaffolding for
   the thing K3 deletes.** The opaque token, `kernel_blocking_retry_token`,
   `kernel_blocking_retry_release`, and the `bound_tid`/`dispatch_tid`/`active`
   task mirrors exist *because the host owns the sleep and re-enters the kernel
   later*. A kernel that owns the wait holds the pinned target directly on the
   sleeper. K3 should be sized as **collapsing** `blocked_retry.rs`, not
   extending it (§3.4).

3. **Two of the four "wait primitive" host imports are already dead, and a
   third is a live whole-machine stall.** `host_futex_wait` and
   `host_sigsuspend_wait` have **zero Rust call sites**. `host_nanosleep` has
   two, and its Node and browser implementations both call **blocking
   `Atomics.wait` on the kernel-worker thread** (`host/src/vfs/time.ts:35`,
   `:56`), which stalls every process in the machine (§5.2).

4. **The proven floor after K3 is smaller than the census target of 2, and
   `host_futex_wait` is not in it.** The kernel worker is a single-threaded
   multiplexer that must never park. The irreducible acts are (a) notice a
   guest request, (b) publish a completion and notify the guest's channel word,
   (c) re-enter the kernel at a deadline. All three already exist. K3 can be
   done with **zero new host imports** (§5).

5. **The 4,500-line figure is low; the 21 containers are exactly right; the
   keystone framing is 80% right.** Measured by brace-matched spans, the
   scheduler is **5,794 lines across 82 methods** counting only methods that
   directly reference one of the 21 containers, and **7,793 lines across 128
   methods** counting their family helpers. The census's 4,532 reproduces only
   if you exclude stopped-process parking, waitpid/waitid deferral, futex and
   signal-wait — all of which are the scheduler by the brief's own definition
   (§10.2). Add ~1,278 lines of signal *routing* (§6) and ~29,700 lines of
   `host/test` (§9). Two pieces the brief attributes to K3 — the stopped-process
   Worker deferral, and epoll fork inheritance — belong to K4 and to a
   pre-existing POSIX gap respectively (§10.3).

6. **K3 and K7 do not collide.** Measured: **zero line-range overlap** between
   the 31 contiguous scheduler blocks and the 6 shared-mapping blocks, and only
   **5 methods** touch both state sets — with roughly **45 lines** of genuinely
   dual-touch text between them. K3 is also the stabler target: the mapping
   region gained +668 lines three days ago; the scheduler region has had no
   direct edit in the last 20 commits (§10.1).

**No ABI bump is required and none should be requested.** The guest parks in
`memory.atomic.wait32` on `CH_STATUS` until it is not `CH_PENDING`
(`libc/glue/channel_syscall.c:1872-1873`) — VERIFIED. It has no opinion about
who decided the wait. K3 is invisible to the guest contract. Kernel exports are
in `abi/snapshot.json`, so export churn is a snapshot regeneration under the
ABI-44 amendment rule already recorded for K13a and K2.

---

## 1. The state containers — the actual inventory

**The census's "21" is exactly reproducible and correct.** An independent
mechanical pass over the class body (2732–34696; 647 members = 536 methods +
111 fields) recovers precisely these 21 by searching each method span for a
direct container reference: `pendingSleeps`, `pendingSignalWaits`,
`signalWaitDeadlines`, `waitingForChild`, `parkedChannelCompletions`,
`deferredStoppedChannels`, `pendingPollRetries`, `blockingRetrySnapshots`,
`blockingRetryWakeTargets`, `pendingAdvisoryLockRetries`,
`pendingSelectRetries`, `wakeScheduled`, `pendingPipeReaders`,
`pendingPipeWriters`, `socketTimeoutTimers`, `pendingFutexWaits`,
`pendingCancels`, `epollInterests`, `stoppedPids`, `pendingResumePids`,
`resumePreparedSignals`.

K3 additionally **touches** five more that the census's 21 does not name —
`alarmTimers`, `posixTimers`, `deferredProcessWorkerStarts`, `hostReaped`, and
`activeChannelRequests` — plus two per-channel fields. They are listed below
and marked, because three of them (the two timer registries and the Worker
deferral) carry real sequencing consequences.

All declarations verified at the cited lines.

`ChannelInfo` **object identity** is the key for most of them: exec can reuse
both pid and mailbox offset, so a numeric key would let a stale timer complete
a later request. That invariant is the reason so many of these are keyed on an
object rather than a number, and it is stated at `kernel-worker.ts:3086-3090`.

### 1.1 Readiness / retry parking

| # | container | decl | keys on | holds | written by | read by | Rust home |
|---|---|---|---|---|---|---|---|
| 1 | `pendingPollRetries` | `:3065` | `ChannelInfo` | cancellation identity, timer handle, `pipeIndices[]`, `acceptIndices[]`, `needsSignalSafeWake`, `deadline`, `isWriteRetry` | `handleBlockingRetry` (`:17967`, `:18017`, `:18441`, `:18468`), `handleEpollPwait` (`:19968`, `:20104`) | `wakeAllBlockedRetries` `:16347`, `wakeBlockedAccept` `:15783`, `wakeBlockedPollRetriesForPipe` `:15810`, `wakeBlockedFallbackWriters` `:16211`, `postponeSignalSafePollRetries` `:16255`, `clearReadinessWait` `:16452` | `WaitQueue` sleeper + `WakeSource::{Pipe,Accept}` + deadline heap |
| 2 | `pendingSelectRetries` | `:3116` | `ChannelInfo` | timer, `origArgs`, `deadline`, `needsSignalSafeWake`, `syscallNr` | `handleSelect` `:19192`, `handlePselect6` `:19416` | `wakeAllBlockedRetries` `:16348`, `postponeSignalSafeSelectRetries` `:16278`, `cleanupPendingSelectRetries` `:15931` | same as #1; `select`/`pselect6` differ only in time-struct shape, which Rust already handles |
| 3 | `blockingRetrySnapshots` | `:3091` | `ChannelInfo` | the 7-variant `BlockingRetrySnapshot` union (`:2171`) — frozen `origArgs`, `argDescs`, planned scratch writes, `retryToken` | `#rememberBlockingRetrySnapshot` `:17154` | `#replayBlockingRetrySnapshot` `:17335`, `#retrySyscallWithinKernelEntry` `:18527` | **disappears.** The kernel re-executes from its own sleeper; there is nothing to replay |
| 4 | `blockingRetryWakeTargets` | `:3100` | `ChannelInfo` | `readPipeIndex`, `writePipeIndex`, `acceptIndex`, `pollPipeIndices[]`, `pollAcceptIndices[]` | `handleBlockingRetry` `:17925`, `:18336`, `:18365`, `:18414` | same | **disappears.** These are queried *from the kernel* (`kernel_get_fd_pipe_idx`, `kernel_get_fd_send_pipe_idx`, `kernel_get_fd_accept_wake_idx`) purely so TS can key its own maps |
| 5 | `pendingPipeReaders` | `:3135` | pipe index (`u32`) | array of `{channel, pid, cancellation identity}` | `handleBlockingRetry` `:18344-18358` | wake drain `:16061`, `wakeAllBlockedRetries` `:16373`, `cleanupPendingPipeReaders` `:16403` | `WaitQueue` indexed by `WakeSource::Pipe(idx)` |
| 6 | `pendingPipeWriters` | `:3147` | send-pipe index | same shape | `handleBlockingRetry` `:18386-18398` | wake drain `:16074`, `:16387`, `cleanupPendingPipeWriters` `:16414` | same |
| 7 | `pendingAdvisoryLockRetries` | `:3109` | `ChannelInfo` | cancellation identity, timer | `parkAdvisoryLockRetry` `:17033` | `wakeBlockedAdvisoryLockRetries` `:16173`, `clearReadinessWait` `:16461` | `WakeSource::AdvisoryLock`; the container's own doc already says "the host owns only channel parking and the short retry safety timer; it never inspects advisory-lock state" |
| 8 | `socketTimeoutTimers` | `:3160` | `ChannelInfo` | timer handle | `handleBlockingRetry` `:18307` | `clearSocketTimeout` `:16428` | a **deadline on the sleeper**. `SO_RCVTIMEO`/`SO_SNDTIMEO` are kernel state already |
| 9 | `pendingFutexWaits` | `:3165` | `ChannelInfo` | `futexIndex`, `hasTimeout`, an `interrupt(retVal, errVal)` closure, a `retire()` closure, cancellation identity | `handleFutex` `:25903` | `handleThreadCancel` `:16650`, `interruptPendingFutexForCaughtSignal` `:26420` | `WakeSource::Futex(pid, addr)` — **but see §11.1**, the kernel may be able to own futex outright |
| 10 | `epollInterests` | `:3247` | `"pid:epfd"` string | `Array<{fd, events, data: bigint}>` | 6 sites (§4) | 8 sites (§4) | **ELIMINATE** — duplicates `Process::epolls[].interests` (`process.rs:894`, interest record at `process.rs:647-651`) |

### 1.2 Timers and sleeps

| # | container | decl | keys on | holds | Rust home |
|---|---|---|---|---|---|
| 11 | `pendingSleeps` | `:2974` | `ChannelInfo` | timer, `syscallNr`, `origArgs`, staged `retVal`/`errVal`/`outputWrites` | deadline-only sleeper. Note the *result is computed before the sleep* and staged in JS |
| 12 | `pendingSignalWaits` | `:2989` | `"pid:channelOffset"` | timer, `origArgs`, `signalMask: bigint` | `WaitKind::SigTimedWait` sleeper with the mask; the mask is *already* Rust-owned per-task state (`PerThreadSignalState`, `signal.rs:344`, attached at `process.rs:565`) |
| 13 | `signalWaitDeadlines` | `:3001` | `"pid:channelOffset"` | `{pid, deadline}` — retained *across* wake-driven retries | folds into #12. It exists **only** because a retry loses the deadline; a sleeper does not |
| 14* | `alarmTimers` | `:2963` | pid | `setTimeout` handle | *(beyond the census 21)* kernel timer registry; `host_set_alarm` becomes one arm-at-deadline |
| 15* | `posixTimers` | `:2965` | `"pid:timerId"` | `{timeout, interval?, signo}` | *(beyond the census 21)* same; `host_set_posix_timer` collapses in |

### 1.3 Process wait and job control

| # | container | decl | keys on | holds | Rust home |
|---|---|---|---|---|---|
| 16 | `waitingForChild` | `:3021` (array) | linear scan | `{parentPid, channel, origArgs, pid, options, syscallNr, cancellation identity}` | `WakeSource::ChildEvent(parent)`. `kernel_wait_child_poll` already computes the answer |
| 17 | `stoppedPids` | `:3036` | pid set | — | **already Rust-authoritative** (`ProcessState::Stopped`, `process.rs:441`); this is a cache fed by the wake stream |
| 18 | `pendingResumePids` | `:3042` | pid set | — | kernel resume-preflight state |
| 19 | `parkedChannelCompletions` | `:3044` | `ChannelInfo` | a completed result withheld until SIGCONT | sleeper with `WaitKind::StoppedPublication` |
| 20 | `resumePreparedSignals` | `:3054` (`WeakSet`) | `ChannelInfo` | marker | kernel signal-delivery state |
| 21 | `deferredStoppedChannels` | `:3056` | `ChannelInfo` | marker | kernel |
| 22* | `deferredProcessWorkerStarts` | `:3059` | pid | `Set<DeferredProcessWorkerStart>` — **JS Worker constructors** | *(beyond the census 21)* **STAYS (K4 boundary).** The gating decision is kernel; the held closure is a host act (§10.3) |
| 23* | `hostReaped` | `:25125` | pid set | — | *(beyond the census 21)* kernel reap state |

### 1.4 Cancellation, coalescing, transport

| # | container | decl | notes |
|---|---|---|---|
| 24 | `pendingCancels` | `:3185` | `Set<ChannelInfo>` — the pre-enqueue race guard for `SYS_THREAD_CANCEL`. Collapses into one kernel `cancel_task_wait(pid, tid)` (§6.4) |
| 25 | `wakeScheduled` | `:3130` (bool) | coalesces the broad-wake microtask. Disappears with the broad wake. *(Counted as one of the census 21.)* |
| 26* | `activeChannelRequests` | `:3029` | *(beyond the census 21)* frozen request identity; **partly transport** — it detaches the guest mailbox flag as it captures. SPLIT |
| — | `channel.readinessDeadline` | `:1530` | per-channel deadline memo, set by `getReadinessDeadline` `:16437` |
| — | `channel.readinessFinalCheck` | `:1532` | "run the kernel once more at the deadline" flag, consumed at `:13210` |

**Count reconciliation.** Entries 1–13, 16–21 and 24–25 are the census's 21,
reproduced exactly. Entries marked `*` (14, 15, 22, 23, 26) are five further
containers K3 touches. Of those, `alarmTimers`/`posixTimers` fold into the
deadline heap, `hostReaped` is kernel state, `activeChannelRequests` splits,
and `deferredProcessWorkerStarts` is the K4 boundary (§10.3). The census figure
is correct as stated; it is the *scope* of what K3 must edit that is wider.

---

## 2. `handleBlockingRetry` — the real algorithm

`kernel-worker.ts:17734-18479`, **746 lines** (VERIFIED by brace-matched span
extraction; the brief's "~:17771" is 37 lines into the body).

It is entered from exactly one production site: the post-dispatch EAGAIN arm of
`#handleSyscallInner` at `:13969`, reached when `retVal === -1 && errVal ===
EAGAIN` (`:13924`). It is also entered on replay from `#replayGenericBlockingRetry`
(`:17509`) and from the fcntl/select/flattened/sendmsg/recvmsg/sysv handlers.

### 2.1 Prologue — identity capture (`:17744-17764`)

1. A test hook short-circuits the whole method (`:17744`) — production
   scaffolding, part of the 1,444-line `#createTestAuthority` surface.
2. `isRegisteredChannel(channel)` — drop the retry if the channel generation
   died (`:17749`).
3. Fetch the retained `BlockingRetrySnapshot` (`:17750`) and narrow it to the
   `"generic-channel"` variant.
4. Extract the `BlockingRetryDisposition` (the frozen socket-timeout /
   nonblocking-fd / call-flag policy captured beside the first EAGAIN by
   `#captureBlockingRetryDisposition`, `:17640`).
5. Compute `cancellationIdentity` — either the snapshot's frozen copy or a
   fresh `#cancellationPointIdentity(channel)` (`:11152`).

The snapshot itself was created earlier, in the same kernel entry as the
EAGAIN, by `#rememberBlockingRetrySnapshot` (`:17154`), which calls
`kernel_blocking_retry_token(pid, tid, syscallNr)`. That export is the seam's
handshake: **> 0** = an opaque stable-target token; **0** = "this syscall is on
the reviewed host-only-snapshot list"; **negative** = errno. `ENOENT`/`ESRCH`
are accepted only after `kernel_get_process_state` independently proves the
process is `Exited` (`#retireBlockingRetryCaptureAfterExitedProcess`,
`:17311`). Anything else calls `#failBlockingRetryProtocol` (`:17263`), which
**fails the kernel instance** — a deliberate fail-closed.

### 2.2 Dispositions, in the order the method tries them

```
handleBlockingRetry(channel, syscallNr, origArgs, detachedOutput, entry,
                    replayingDetachedSnapshot, deliveredSignal,
                    effectiveReadinessTimeoutMs)
│
├─ SYS_FUTEX / FUTEX_WAIT                                    :17765-17838
│    deliveredSignal>0 → complete EINTR
│    checkedProcessRange(uaddr,4); require 4-byte alignment
│    Atomics.load(processMemory, addr/4) != expected → retrySyscall NOW
│    interruptPendingCancellationBeforeRegistration            (last chance)
│    Atomics.waitAsync(processMemory, index, expected)
│      .async  → on resolve, retrySyscall
│      .sync   → setImmediate(retrySyscall)   // never queueMicrotask
│
├─ SYS_POLL / SYS_PPOLL                                       :17841-18013
│    timeoutMs = effectiveReadinessTimeoutMs ?? snapshot.dispatch.readinessTimeoutMs
│    undefined                → EIO (protocol failure)
│    needsSignalSafeWake = PPOLL && sigmask ptr != 0
│    timeoutMs === 0          → #cancelHostOwnedKernelWait, complete 0
│    deliveredSignal > 0      → complete EINTR  (deliberately WITHOUT cancelling
│                               the kernel wait, so libc's SA_RESTART decision
│                               keeps ppoll's saved mask Rust-owned)
│    deadline reached         → channel.readinessFinalCheck = true; retrySyscall
│    resolvePollReadinessIndices(pid, dispatch)  ── kernel_get_fd_pipe_idx
│                                                └─ kernel_get_fd_accept_wake_idx
│      → cache into blockingRetryWakeTargets
│    nfds === 0 (pure sleep)  → single setTimeout(remaining); park
│    otherwise                → setTimeout(hasTargetedWake ? 10ms : 50ms); park
│
├─ SYS_RT_SIGTIMEDWAIT                                        :18018-18215
│    read the 8-byte sigmask out of plannedScratchWrites[argIndex 0]
│    deliveredSignal > 0      → complete EINTR
│    origArgs[2] === 0 (NULL timeout) → park with a 500 ms safety timer
│    else decode timespec from plannedScratchWrites[argIndex 2]
│         timeoutMs <= 0      → complete EAGAIN
│         reuse signalWaitDeadlines[key] across retries
│         park with setTimeout(remaining) → complete EAGAIN on expiry
│
├─ frozen-descriptor policy gate                              :18216-18249
│    #blockingRetryNonblockingDescriptors(syscallNr, origArgs) non-empty
│      && no retryDisposition → #failBlockingRetryProtocol
│    retryForbiddenByCallFlags || fdWasNonblocking → complete EAGAIN
│
├─ deliveredSignal > 0                                        :18251-18268
│    → complete EINTR   (only AFTER the nonblocking checks above)
│
├─ interruptPendingCancellationBeforeRegistration              :18274-18281
│    (single choke point before ANY host-owned park is installed)
│
├─ socket timeout arm                                         :18287-18324
│    disposition.applicableSocketTimeoutMs > 0 && READ/WRITE-like
│      && !socketTimeoutTimers.has(channel)
│    → setTimeout(→ removePendingPipeReader; complete ETIMEDOUT)
│
├─ READ_LIKE_SYSCALLS                                         :18329-18361
│    pipeIdx = kernel_get_fd_pipe_idx(pid, fd)   (cached in wake targets)
│    ≥ 0 → push into pendingPipeReaders[pipeIdx]; RETURN (no timer at all)
│
├─ WRITE_LIKE_SYSCALLS                                        :18363-18402
│    pipeIdx = kernel_get_fd_send_pipe_idx(pid, fd)
│    ≥ 0 → push into pendingPipeWriters[pipeIdx]; RETURN
│
├─ SYS_ACCEPT / SYS_ACCEPT4                                    :18404-18450
│    acceptIdx = kernel_get_fd_accept_wake_idx(pid, fd)
│    ≥ 0 → pendingPollRetries with acceptIndices=[acceptIdx], 10 ms timer
│
└─ default                                                     :18452-18478
     setTimeout(10ms) → retrySyscall; park in pendingPollRetries
     with isWriteRetry = WRITE_LIKE_SYSCALLS.has(syscallNr)
```

### 2.3 What is *not* in this method

Deliberately, because the seam is not one place:

- `SYS_EPOLL_PWAIT` — the comment at `:18014` says "epoll_pwait is now handled
  entirely on the host side by `handleEpollPwait`". `handleEpollPwait`
  (`:19870-20111`) has its own park.
- `SYS_SELECT` / `SYS_PSELECT6` — `handleSelect` (`:19192`) and `handlePselect6`
  (`:19416`), own park in `pendingSelectRetries`.
- `SYS_NANOSLEEP` / `SYS_CLOCK_NANOSLEEP` / `SYS_USLEEP` — `handleSleepDelay`
  (`:18545`), own park in `pendingSleeps`, entered from the *success* path
  (`:13984`), not the EAGAIN path.
- `SYS_WAIT4` / `SYS_WAITID` — `handleWaitpid` (`:25131`), own park in
  `waitingForChild`.
- `fcntl(F_SETLKW)` / `flock` — `parkAdvisoryLockRetry` (`:17033`).

**So the "one core method" framing is misleading.** There are **seven
independent parking mechanisms**, each with its own timer discipline, its own
cancellation arm, its own signal-interrupt arm, and its own teardown. That
multiplicity — not the 746 lines — is the actual cost, and it is exactly what
Rust's type system removes: one `enum WaitKind` with an exhaustive `match`.

### 2.4 Replay

`#replayBlockingRetrySnapshot` (`:17335-17398`) is a 7-arm dispatch over the
snapshot union, routing back into `#replayGenericBlockingRetry`,
`handleFcntlLock`, `handlePselect6`/`handleSelect`, `#handleFlattenedTransfer`,
`handleSendmsg`, `handleRecvmsg`, `handleSysvMessage`. `retrySyscall`
(`:18488`) → `#retrySyscallWithinKernelEntry` (`:18511`) chooses between replay
(if a snapshot exists) and re-entering `#handleSyscallWithinKernelEntry` for
unsnapshotted blockers, and first checks `#getProcessExitSignal` so a
signal-killed process is terminated rather than retried.

### 2.5 Wake routing

`#drainAndProcessWakeupEventsWithinKernelEntry` (`:15961-16170`) drains
`kernel_drain_wakeup_events` in 256-event batches, **owning the whole batch
before acting on any event** because STOPPED/CONTINUED handling can send
SIGCHLD and reuse the same scratch lease. Then:

| wake type | host action | line |
|---|---|---|
| `processStopped` | add to `stoppedPids`; `notifyParentOfChildStateTransition` | `:16035` |
| `processContinued` | `resumeStoppedProcess`; if it returns false, **recursively re-drain** | `:16043` |
| `readable` | pop `pendingPipeReaders[idx]`, `retrySyscall` each | `:16059` |
| `writable` | pop `pendingPipeWriters[idx]`, `retrySyscall` each | `:16072` |
| `readable｜writable` | `wakeBlockedPollRetriesForPipe(idx, …, {deferSignalSafe:true})` | `:16085` |
| `accept` | `wakeBlockedAccept(idx)` | `:16098` |
| `datagramWritable` | `wakeBlockedFallbackWriters()` — synchronous | `:16102`,`:16155` |
| `advisoryLock` | `wakeBlockedAdvisoryLockRetries()` | `:16116`,`:16158` |
| any readiness | broad `scheduleWakeBlockedRetries` **or** `…Deferred` | `:16120`,`:16160` |

**The single most important thing in this method is the 19-line comment at
`:16135-16153`.** It explains that a pipe write in process X is often followed
by a `kill` from X, and that a real kernel makes the reader observe both,
because X's two syscalls run before the scheduler runs the reader. Kandelo's
retry-based host cannot guarantee that ordering — `Atomics.notify → uv_async`
takes 1–5 ms — so the broad wake is **deferred by
`SIGNAL_SAFE_POLL_WAKE_DELAY_MS = 50`** (`:896`) whenever a mask-swapping
ppoll/pselect6 is parked, to give X's follow-up syscall time to land.

That is a millisecond race papered over with a millisecond grace period. It is
the clearest single argument for K3: **a kernel that owns the wait observes
both syscalls in issue order by construction**, because one serialized kernel
processes both. The grace period does not move to Rust; it is deleted.

The second-clearest is at `:18000-18012`: the 200 ms poll safety net was
"sleeping past wakeups in the browser worker (WordPress install.php measured
28 s with 200 ms, 1.9 s with 10 ms — a 14× difference far in excess of what 5
fallback fires can explain)". A 14× application-level regression traced to a
host timer constant is a scheduler that does not work, tuned until it mostly
does.

---

## 3. What Rust already owns — the seam, precisely

`crates/kernel/src/syscalls.rs` **does not exist**; the syscall bodies are in
`crates/runtime-core/src/syscalls.rs` (47,203 lines). `crates/kernel/` is the
Wasm export shell. The brief's `syscalls.rs:16361` resolves to
`crates/runtime-core/src/syscalls.rs`, where `sys_epoll_pwait` is now at
**`:16475`**.

### 3.1 Readiness — fully Rust-owned

`poll_check` (`syscalls.rs:14343`) is a complete in-kernel readiness evaluator
over `WasmPollFd`, covering `PcmPlayback` (incl. `POLLERR` on sink error),
`EventFd`, `Epoll`, `TimerFd`, `SignalFd` (`pending_for(tid) & mask`), regular
files / char devices / directories / memfd (with a `/dev/input/mice` special
case that gates `POLLIN` on `mouse::has_data()`), PTY master/slave (incl.
`POLLHUP` on zero peer refs), pipes (host-delegated ⇒ always ready; kernel
pipes ⇒ real `available()`/`free_space()`/`read_end_has_hangup()`), and sockets
(listening backlog incl. shared backlog, shutdown → `POLLERR`/`POLLIN`,
datagram vs stream). It is reused by `sys_poll` (`:14323`), `sys_select`
(`:17789`) and `sys_epoll_pwait` (`:16475`).

All three have the same three-line tail:

```rust
if ready > 0 || timeout_ms == 0 { return Ok(ready); }
if proc.deliverable_for(tid) != 0 && !proc.should_restart_for(tid) { return Err(Errno::EINTR); }
Err(Errno::EAGAIN)
```

**`timeout_ms` is tested only against zero.** A positive or infinite timeout is
passed in and thrown away. Rust does not know when a poll should time out.

### 3.2 Would-block classification — Rust-owned

- `result_needs_target(syscall, errno)` (`blocked_retry.rs:135`): a result needs
  a pin when `errno == EAGAIN`, **or** when `connect` returns
  `EINPROGRESS`/`EALREADY`.
- `is_explicit_host_only_snapshot_syscall` (`:117`): the reviewed list —
  `open`, `openat`, `poll`, `select`, `rt_sigtimedwait`, `ppoll`, `pselect6` —
  that legitimately gets token 0. Its doc says the point was "removing a
  duplicated TypeScript allowlist". Anything unmapped is `EINVAL`; a mapped op
  with no binding is `ENOENT`. **This is already scheduler policy in Rust.**

### 3.3 Stable retry targets — Rust-owned

`BlockingRetryState` lives on `Process::blocked_retries` (`process.rs:843`).
Six target kinds (`BlockingRetryTarget`, `blocked_retry.rs:153`): `Ofd`,
`OfdPair` (sendfile/copy_file_range/splice — either endpoint can block),
`Sendmsg { carrier, ancillary: Vec<InFlightFd> }`, `Mqueue`, `SysvMessage`,
`SysvSemaphore`. The enum is deliberately **not `Clone`** (`:150`) so an exact
release consumes it and a second caller cannot decrement the same pin.

The fd-reuse defense is `resolve_io_ofd` (`syscalls.rs:62`): when a binding is
active it **ignores the fd table**, asserts `target.original_fd == fd`, looks up
`ofd_table.get(target.ofd_idx)`, and asserts `ofd.ofd_id == target.ofd_id`.
`OfdId` is a non-reusable machine identity; the slot index alone is reusable.
Pins **observe removal rather than redirect**: after `msgctl(IPC_RMID)` a pinned
SysV operation returns `EIDRM`, not a redirect to a recycled id.

Timing guarantee (`syscalls.rs:4264-4269`): the pin is created inside the same
kernel entry that produced the EAGAIN, so "no close, dup2, exec, or nested
channel can interleave between the failed attempt and this pin."

### 3.4 Why most of this is scaffolding K3 deletes

The token protocol has three moving parts that exist **only because control
returns to JavaScript between the would-block and the retry**:

1. The opaque `i64` token and its monotone counter (`blocked_retry.rs:198`,
   `EOVERFLOW` on exhaustion) — a lookup key for a host that holds no Rust
   reference.
2. `kernel_blocking_retry_token` (`wasm_api.rs:6583`) and
   `kernel_blocking_retry_release` (`:6601`) — a round trip to hand the host a
   key and take it back.
3. The `bound_tid` / `dispatch_tid` / `active` single-slot mirrors
   (`blocked_retry.rs:201-207`) plus `kernel_set_current_tid`
   (`wasm_api.rs:6566`), whose doc states the reason: "The host tracks
   `(pid, channelOffset) -> tid` in its own map (`channelTids`) and must call
   this *before* dispatching a thread-originated syscall… This is ambient
   dispatch context for today's serialized host/kernel entry model."

A kernel that owns the wait holds the pinned `BlockingRetryTarget` **directly on
the sleeper record**, in the same `Process`, for the duration of the sleep.
There is no key to hand out, nothing to release from the host, and no ambient
TID to bind — the sleeper *is* the TID.

**Consequence for sizing.** The census says K3's destination is "`blocked_retry.rs`
+ `wakeup.rs` (extend)". More accurate: the *targets* (the six pin kinds and
`OfdId` identity checking) are load-bearing and survive; the *token protocol*
(~200 of the 927 lines, plus 4 kernel exports) is scaffolding that K3 removes.
That is an unbudgeted **V4 win** and it should be claimed.

### 3.5 The per-task signal-mask wait context — already Rust

`sys_ppoll` (`:16222`) and `sys_pselect6` (`:16252`) call
`proc.enter_signal_mask_wait_for(tid, SignalMaskWaitKind::Ppoll | ::Pselect, m)`
— a **per-task LIFO** so a wait nested inside a caught handler is distinct from
the outer one — and call `finish_signal_mask_wait_for` **only if the result is
not `EAGAIN`**, deliberately leaving the replacement mask installed across the
host's sleep. `sys_sigsuspend` and `sys_pause` use the same mechanism.

This is the second piece of genuine scheduler state Rust already owns, and it is
the reason `handleBlockingRetry`'s ppoll arm must *not* cancel the kernel wait
when a caught signal arrives (`:17939-17948`).

### 3.6 There is no wait queue in the kernel — VERIFIED

- `grep -rn "wait_queue|waitqueue|WaitQueue|sleeper|Sleeper|SleepQueue"` over
  `crates/{runtime-core,kernel,shared}/src` returns **zero matches**.
- `ProcessState` (`process.rs:441-451`) has four variants: `Running`,
  `Stopped`, `Exited`, `Limbo`. **No `Blocked`.** `Stopped` is job control.
- The only kernel `deadline` is `Process::alarm_deadline_ns` (`process.rs:868`),
  for `alarm(2)`/`setitimer(2)` — and even it delegates arming to
  `host_set_alarm`.
- `mq_timed_blocking_errno` (`wasm_api.rs:3358`) is the closest thing: it reads
  the caller's `abs_timeout` and `host_clock_gettime(CLOCK_REALTIME)` and
  returns `ETIMEDOUT` if already past, else `EAGAIN` with the note "host
  retries; subsequent calls re-check the deadline" (`:3370`). **Rust stores
  nothing.**
- `crates/runtime-core/src/pshared.rs:16-19` states the model outright:
  "Blocking semantics are expressed as `Err(Errno::EAGAIN)` — the host retry
  loop re-invokes the syscall after a short delay." *(That comment then cites
  `kernel_wake_blocked_retries()`, which does not exist anywhere in the repo —
  a stale doc reference worth fixing in passing.)*

### 3.7 The wake-event channel

`wakeup.rs` (252 lines) is a single **process-global** `Vec<WakeupEvent>`
(`:40-52`, `unsafe impl Sync` justified by serialized kernel execution). Wire
form is 5 bytes: `idx: u32` LE, `wake_type: u8` (`crates/shared/src/lib.rs:237`).
`wake_type` is a bit mask; the host tests with `&`.

| flag | value | `idx` means | pushed by |
|---|---|---|---|
| `WAKE_READABLE` | 1 | pipe index (or `0x2000_0000 + pcm stream`) | `pipe.rs:859,934,1175,1188`; `syscalls.rs:12280` |
| `WAKE_WRITABLE` | 2 | same | `pipe.rs:1016,1138,1159,1182`; `audio.rs:759` |
| `WAKE_ACCEPT` | 4 | accept index from `alloc_accept_wake_idx()` | `syscalls.rs:13682,13816,14027`; `wasm_api.rs:10199,…` |
| `WAKE_DATAGRAM_WRITABLE` | 8 | always 0 (broad) | 14 sites in `syscalls.rs` |
| `TYPE_PROCESS_STOPPED` | 16 | **pid** | `process.rs:1344` |
| `TYPE_PROCESS_CONTINUED` | 32 | **pid** | `process.rs:1364` |
| `WAKE_ADVISORY_LOCK` | 64 | always 0 (broad) | `process_table.rs:759`; `syscalls.rs:3596,7434` |

`drain_events` (`:123`) writes `min(queued, max_events, out_len/5)` and
**preserves the remainder** — "Lifecycle wakeups share this channel with
readiness events, so dropping overflow could strand a stopped or resumed
process indefinitely" (`:138-140`).

Two observations that matter for K3:

- **The `idx` namespace is partitioned, not typed.** Pipe indices are small,
  PCM streams start at `0x2000_0000`, accept indices come from a separate
  counter, pids reuse the same field, and two kinds send 0. A Rust-owned
  scheduler should make this a typed `WakeSource` enum — a direct V2 win.
- **Two of seven kinds are already "broad wake, no identity"**
  (`datagramWritable`, `advisoryLock`). A kernel-owned queue can key both
  precisely, removing the last reasons for a broad retry sweep.

---

## 4. The epoll mirror — what deleting it actually costs

### 4.1 The justification is stale in two independent ways

The claim appears **three times**, all asserting a suspicion as fact:

- `:3246` — "…without calling `kernel_handle_channel` (which crashes in Chrome
  for epoll_pwait due to a suspected V8 bug)."
- `:12237` — "`kernel_handle_channel` crashes in Chrome (V8 shared-memory Wasm
  bug) for epoll_pwait. Handle epoll_create1/ctl on the kernel but mirror the
  interest list, and convert epoll_pwait to poll entirely on the host."
- `:19616` — "epoll_pwait → convert to poll entirely on host, no
  `kernel_handle_channel`".

*(Note: the census and probe cite `:12274`. On this tip that line is inside the
SysV `semctl` comment. The claim moved to `:12237`.)*

**(a) It was disproved by re-test.** `docs/plans/probes/2026-09-09-k0c-epoll/`
drove `SYS_EPOLL_PWAIT` through `kernel_handle_channel` on the real ABI-44
kernel on Node v24.15.0, Chromium 151.0.7922.34 and WebKit 26.5, on the page
main thread *and* in a dedicated Worker with a peer worker concurrently reading
the kernel's `SharedArrayBuffer`, under real cross-origin isolation, 2,000
repeat calls. No crash.

**(b) The code already stopped doing what the comments describe.** VERIFIED at
`:19983-20035`: `handleEpollPwait` builds a channel record with
`CH_SYSCALL = SYS_EPOLL_PWAIT`, `timeout = 0`, and **calls
`kernel_handle_channel`**. Its own inline comment at `:19979-19984` says so:
"the kernel — not a host-side poll conversion — now computes epoll readiness
(`sys_epoll_pwait`) and writes the ready `epoll_events` into the scratch data
region… (The interest mirror is retained only to resolve targeted wake indices
for the retry loop.)"

The bypass was removed by commit **`d94c4652b`** ("Host: Route epoll_pwait
through the kernel (remove the V8 bypass)"). The comments were not. There is a
fourth stale one at `:18029` — "(epoll_pwait is now handled entirely on the host
side by handleEpollPwait)".

So four comments assert a fact that is both untrue on today's engines and untrue
of today's code. **They should be deleted on sight**, independently of K3 — an
inline comment asserting a disproved browser boundary is precisely what the
ledger's §3 forbids.

### 4.2 The 14 touchpoints, mapped

| # | line | enclosing method (span) | what it does |
|---|---|---|---|
| 1 | `:2342` | `ExecFdMirrorPrunePlan` interface (`:2341-2352`) | plan field carrying the replacement map |
| 2 | `:3247` | declaration | the mirror itself |
| 3 | `:8300-8302` | `hostPosixTimerIdsForProcess` region / process cleanup (`:8296-8305`) | drop all keys for a pid |
| 4 | `:9329-9338` | `inheritHostFdMirrors` (fork/spawn child) | **copy** parent interests to `childPid`, filtered by `kernel_fd_is_open(childPid, …)` |
| 5 | `:9361-9362` | `#rollbackChildHostRegistrationWithinKernelEntry` (`:9355-9363`) | delete child keys after a failed Worker launch |
| 6 | `:9385-9386` | `#prepareExecFdMirrorPruneWithinKernelEntry` (`:9375-…`) | build a replacement map: drop closed epfds, filter closed interest fds |
| 7 | `:9489` | same method, plan construction | `epollInterests: nextEpollInterests` |
| 8 | `:9542` | `#publishExecFdMirrorPrune` | commit the plan in one detached protocol effect |
| 9 | `:15762` | `resolveEpollReadinessIndices` (`:15742-15748` public / `:15749-…` body) | iterate all interests for a pid, map each fd → pipe index / accept index |
| 10 | `:19681` | `handleEpollCreate` (`:19626-19695`) | initialise an empty interest list after the kernel creates the fd |
| 11 | `:19812-19815` | `handleEpollCtl` (`:19701-19843`) | lazily create the list |
| 12 | `:19928` | `handleEpollPwait` (`:19870-20111`) | `!interests` → `-EBADF`; `interests.length === 0` → separate park path |
| 13 | `:25096-25097` | process teardown | delete keys for an exited pid |
| 14 | `:25112-25113` | process teardown, second path | same |

### 4.3 What the mirror is still *used* for

Only three things survive `handleEpollPwait`'s cutover to the kernel:

1. **`-EBADF` for an unknown epfd** (`:19928`). Redundant — `sys_epoll_pwait`
   (`syscalls.rs:16475`) validates the epfd type and returns `EBADF` itself.
2. **The empty-interest short-circuit** (`:19935-19976`). Also redundant —
   `sys_epoll_pwait` has its own empty-interest branch
   (`syscalls.rs:16506-16519`). *That branch is itself defective*: it calls
   `host.host_nanosleep(0, timeout_ms * 1e6)`, which blocks the entire kernel
   worker (§5.2).
3. **`resolveEpollReadinessIndices`** (`:15749`) — the only genuine use. It
   needs `(pid, fd)` for every interest to call `kernel_get_socket_recv_pipe`
   and `kernel_get_fd_accept_wake_idx`, so the host can key `pendingPollRetries`.

### 4.4 The gaps the mirror is hiding — the real cost

**Gap 1 — fork does not inherit epoll instances. VERIFIED.** The live fork path
is serialize/deserialize (`ProcessTable::fork_process_for_caller_with_mode`,
`process_table.rs:1042` -> `fork::deserialize_allocated_fork_state`, `:1074`).
`serialize_fork_state` writes no epoll bytes, and the deserializer executes
**`child.epolls.clear();`** at `crates/runtime-core/src/fork.rs:1631`, beside
`clear_threads()` and `posix_timers.clear()`. The child's fd table still holds
the epfd with `host_handle = -(idx+1)`, so a lookup into an empty `Vec` yields
**`EBADF`**. Linux shares the parent's epoll instance across fork.

**But the mirror does not fix this, and the framing must be honest about that.**
INFERRED (code reasoning, not runtime-tested): since `handleEpollPwait` now
dispatches to the kernel (§4.1), a forked child with a *non-empty* inherited
mirror passes the host gate and then gets `EBADF` from the kernel anyway. The
only case the mirror actually masks is a child inheriting an **empty-interest**
epfd, where the host answers `0` without ever asking the kernel. So deleting the
mirror mostly makes an **already-broken** POSIX behavior *visible* rather than
creating a new regression — which is precisely what the platform-values contract
asks for. It should nonetheless land together with the Rust fix, not alone.

The mirror's own call sites already concede the gap: `inheritHostFdMirrors` is
invoked from `handleFork` (`:22140`) with `includeEpoll` defaulted true, and from
`#handleSpawnAfterResolve` (`:23345`) with **`false`**, commented "Epoll backing
tables are not yet cloned by `spawn_child`."

**Gap 2 — interests carry no OFD identity and are never pruned in Rust.
VERIFIED.** `EpollInterest { fd: i32, events: u32, data: u64 }`
(`process.rs:647-651`) holds a bare numeric fd. `interests` is mutated only by
`sys_epoll_ctl` (`syscalls.rs:16444/16454/16461`). On exec,
`commit_exec_state_impl` (`syscalls.rs:875`) closes CLOEXEC fds (`:921-932`) and
the `FileType::Epoll` close arm nulls the slot (`:4136-4142`), but **`epolls` is
absent from the reset block at `:954-982`** — so a non-CLOEXEC epoll survives
exec still holding interests for now-closed fds. `poll_check` returns `POLLNVAL`
for those (`:14360-14363`), which the epoll result mapper does not translate
(`:16564-16583`), producing an event with `ep_events == 0`. **That latent bug is
exactly what the TS prune at `:9394-9398` currently hides**, and its own comment
admits the model: "The current epoll model stores numeric fds rather than OFD
identity… duplicate-fd retention remains a documented gap."

*(Correction to an easy misreading: `fork.rs:2093`'s `process.epolls.clear()`
sits in `deserialize_exec_state`, which has **no callers outside `fork.rs`** — a
fixture path, not the live exec. The live exec problem is Gap 2, not a clear.)*

**Deleting the mirror therefore requires:**

| step | work | where | blocked? |
|---|---|---|---|
| D1 | Delete the three stale V8 comments, plus the stale one at `:18029` | `:3246`, `:12237`, `:19616`, `:18029` | no |
| D2 | Serialize `epolls` across fork so the child inherits the instance (Linux shares it through the file description) | `fork.rs:1631` + the fork serializer | **the one genuine blocker** |
| D3 | Re-key `EpollInterest` on OFD identity and prune on close/exec — Gap 2 | `process.rs:647`, `syscalls.rs:16409`, `:954-982` | separable |
| D4 | Replace `resolveEpollReadinessIndices` (`:15760-15777`) — the **only** touchpoint needing new Rust. Interim: an export `kernel_epoll_wake_indices(pid, epfd, out, cap)`. Rust has the primitives (`Socket.accept_wake_idx` `socket.rs:655`, `alloc_accept_wake_idx` `wakeup.rs:63`, `PendingConnection.recv_pipe_idx` `socket.rs:940`) but **nothing today joins an `EpollInterest` to a wake index**. After K3-6 it is **nothing** — the kernel registers its own sleeper against interests it already holds | `:15742-15780` | new work |
| D5 | Delete the other 12 touchpoints against exports the kernel already has: the EBADF gate (`sys_epoll_pwait` returns EBADF at `syscalls.rs:16500-16503`), the empty-interest path (kernel handles it at `:16507`), create seed, ctl replay, child rollback, exec prune + plan + publish, and the three teardown sites | 12 sites | no |
| D6 | Fix `sys_epoll_pwait`'s empty-interest `host_nanosleep` stall | `syscalls.rs:16514` | no |
| D7 | `EPOLLRDHUP` is `#[allow(dead_code)]` and never mapped; `EPOLLET`/`EPOLLONESHOT` are not modelled at all | `syscalls.rs:16524` | separate POSIX item |
| D8 | Tests: ~110 lines rewritten or deleted (2 epoll-specific cases), ~30 lines of setup/assertions removed from 3 surviving mixed cases, across `kernel-scratch-transfer-boundaries.test.ts`, `kernel-exec-entry.test.ts`, `exec-state-tracking.test.ts`. No non-test source depends on `epollInterests` | 3 files | no |

**D2 and D3 are POSIX work, not migration work.** They are the honest cost of
the deletion, and they are exactly the "treat the failure as platform feedback"
the values contract asks for. **NEEDS-DEFER-DECISION (§11.3).**

D1 alone is a comment deletion with no risk and should not wait for K3.

*(Housekeeping found while grounding: the `handleChannel` mock in
`kernel-scratch-transfer-boundaries.test.ts:4749-4800` still writes a `pollfd`
at `CH_ARGS`+6 — i.e. it is already stale with respect to the post-`d94c4652b`
`CH_DATA` `epoll_event` path, and passes only because `retVal=1` drives the
copy-out. A test that no longer models the code it guards.)*

---

## 5. The host floor — what is actually irreducible

### 5.1 The architectural fact that decides this

**The kernel worker is a single-threaded multiplexer for every process in the
machine, and it must never park.** VERIFIED:

- It listens on each guest channel with `Atomics.waitAsync`
  (`kernel-worker.ts:10843`), not `Atomics.wait`.
- Every retry is a `setTimeout`/`setImmediate` through `#registerTimeout`
  (`:10596`) / `#registerImmediate` (`:10648`).
- `CLAUDE.md`'s host-runtime contract requires the kernel to run in a dedicated
  worker on every host, and forbids instantiating `CentralizedKernelWorker` on
  the main thread.

Any host import that parks the calling thread therefore stalls **the whole
machine**, not one process. This single fact reclassifies three of the four
"wait primitives".

### 5.2 The four "wait primitives", re-verified

| import | Rust call sites | TS implementation | verdict |
|---|---|---|---|
| `host_futex_wait` (`wasm_api.rs:208`) | **ZERO.** `sys_futex`'s `FUTEX_WAIT`/`FUTEX_WAIT_BITSET` arm returns `Err(EAGAIN)` (`syscalls.rs:16135`) | `kernel.ts:4903` — blocking `Atomics.wait` on **kernel** memory | **DEAD.** Not a floor; a vestigial import. Delete |
| `host_sigsuspend_wait` (`wasm_api.rs:147`) | **ZERO.** `sys_sigsuspend` (`syscalls.rs:9526`) takes `_host` unused; `sys_pause` (`:9534`) does `let _ = host;` | `kernel.ts:3936` — blocking `Atomics.wait` on `signalWakeSab` | **DEAD.** Delete |
| `host_nanosleep` (`wasm_api.rs:133`) | **TWO:** `sys_usleep` (`syscalls.rs:14725`) and `sys_epoll_pwait`'s empty-interest branch (`:16514`) | `kernel.ts:3865` → `io.nanosleep` → **blocking `Atomics.wait` on a throwaway SAB**, in *both* `NodeTimeProvider` (`vfs/time.ts:35`) and `BrowserTimeProvider` (`vfs/time.ts:56`) | **LIVE DEFECT.** `SYS_USLEEP` (68) is a real dispatch arm (`wasm_api.rs:4435`). A guest calling it stalls every process for the duration — and then `handleSleepDelay` (`:18558`) sleeps *again* on the host side. Delete both call sites |
| `host_futex_wake` (`wasm_api.rs:209`) | **FIVE**, all in `sys_futex` (`syscalls.rs:16136,16143,16152,16157,16159`) | `kernel.ts:4957` — `Atomics.notify` on **kernel** memory | Live in Rust, but see §5.3 |

**Notably `sys_nanosleep` does not call `host_nanosleep`.** It validates the
timespec and returns immediately (`syscalls.rs:9816`); `sys_clock_nanosleep`
(`:9853`) converts `TIMER_ABSTIME` to a relative delay, writes it back to the
scratch timespec, and returns — the comment at `:9884-9885` says "the host reads
it from CH_DATA and sets up the timer". The correct pattern already exists; the
two `host_nanosleep` call sites are the exceptions.

### 5.3 The futex path is a Node/browser vs native divergence

VERIFIED: `#handleSyscallInner` intercepts `SYS_FUTEX` at
`kernel-worker.ts:12137` and never dispatches it, with the comment (`:12134`)
"The kernel's `host_futex_wake`/`wait` imports use kernel memory, but futex
addresses are in process memory. Intercept here and handle directly."
`handleFutex` (`:25910`) then implements the ops with `Atomics.waitAsync` /
`Atomics.notify` on the **process's** memory.

So on Node and browser, `sys_futex`, `kernel_futex` (`wasm_api.rs:13150`,
dispatch arm 200 at `:4911`) and the five `host_futex_wake` call sites are all
unreachable. On `host-native` they *are* reachable: `host_futex_wake` is one of
the 21 imports host-native implements (`guest.rs:1843-1856`,
`current_memory.lock().atomic_notify(addr, n)`), while `host_futex_wait` traps.

That is a genuine, undocumented host divergence, and it is K3's problem because
K3 must produce one implementation.

### 5.4 The proven floor after K3

Three acts, all of which **already exist**. None is a new import.

**F1 — notice that a guest submitted a request.**
`Atomics.waitAsync` on the channel status word (`kernel-worker.ts:10843`), or
the `MessageChannel` poller. Wasm cannot wait asynchronously on a memory it does
not own. **VERIFIED irreducible.** Already host code; unchanged by K3.

**F2 — publish a completion and wake the guest.**
The guest parks in `memory.atomic.wait32` on `CH_STATUS`
(`libc/glue/channel_syscall.c:1872`). Waking it requires an atomic notify on a
`WebAssembly.Memory` the kernel does not own. Wasm's `memory.atomic.notify`
operates only on the module's own memory. **VERIFIED irreducible.**

*But it needs no new import.* Two ways to drive it, both using surface that
exists:

- **(B) preferred — zero new imports.** Extend the wake-event record with a
  `TASK_COMPLETE` kind carrying `(pid, tid)`. The host drains it through the
  existing `kernel_drain_wakeup_events` and publishes through the existing
  `completeChannel`. The kernel decides *whether*, *when* and *with what*; the
  host performs the store and the notify.
- (A) alternative — one import `host_wake_channel(pid, channel_offset)`, with
  the kernel writing the result bytes itself via `host_proc_write_bytes` (K2,
  now `addr: u64`). Cleaner separation, +1 import. **Reject unless (B) proves
  insufficient**, per V4.

**F3 — re-enter the kernel at a deadline.**
Wasm cannot schedule its own re-entry. **VERIFIED irreducible.**

*Also needs no new import.* Add a kernel **export**
`kernel_next_wait_deadline_ns() -> i64` (or return it from the drain call); the
host arms **one** `setTimeout` for the whole machine. Kernel exports are
snapshot-regen, not new host capability. This replaces N per-waiter timers
across 8 containers with one.

### 5.5 The resulting concept table

| concept | census "now" | census target | K3 outcome |
|---|---|---|---|
| wait primitives | 4 | 2 | **0–1** — three are deleted outright in 7.0 (`host_futex_wait`, `host_sigsuspend_wait`, `host_nanosleep`); the fourth, `host_futex_wake`, goes only if §11.1's probe says the kernel can own futex. If it cannot, the concept is 1, not 0 — still below the census target |
| timers | 2 (`host_set_alarm`, `host_set_posix_timer`) | 1 | **0–1** — both are deadline arms that fold into F3's single timer; the registry is kernel state either way |

That is **84 → 81 declared imports** unconditionally, **→ 80** if §11.1 holds,
and — more importantly — **one to two whole concepts removed** from the list a
host author must understand. Both beat the census target.
**STRONG DOUBT is satisfied: K3 adds no host surface.**

### 5.6 Things that are *not* floor, recorded so they are not re-argued

| claim | status |
|---|---|
| "`host_futex_wait` is irreducible because `Atomics.wait` compares and parks atomically" | **The premise is true and the conclusion does not follow.** The kernel worker must not park, so it can never call it. Zero Rust call sites. See §11.1 for the futex design |
| "`epoll_pwait` crashes Chrome via `kernel_handle_channel`" | Disproved by probe **and** already abandoned in code (§4.1) |
| "`Atomics.waitAsync` microtask chains freeze the main thread, so use the `MessageChannel` poller" (`:15449`) | A **fifth** inherited, never-re-tested V8 claim. `usePolling` is set `true` only by 6 test files; production sets it `false`, and CLAUDE.md forbids the main-thread topology it exists for. See §11.2 |
| "the host must own the wait because retries need the request bytes" | The bytes live in guest memory, which K2's widened `host_proc_read_bytes` now reaches from the kernel |

---

## 6. Signals — how much collapses into K3

### 6.1 The shape

`sendSignalToProcess` is at **`kernel-worker.ts:26463-26627`, 165 lines** (doc
comment `:26458`). *(The brief's `:26635` is now
`#generateHostSignalWithinKernelEntry`, `:26635-26665`, its immediate helper.)*

The method is an ordered barrier inside one `KernelWorkerEntryContext`, and its
proportions are the finding: **one line mutates the kernel; 106 lines interrupt
TypeScript wait queues.**

1. `:26469-26473` — test-hook bypass.
2. `:26474-26489` — bail without a kernel instance; re-enter through
   `#runOrDeferKernelEntry` if called without entry authority.
3. `:26495-26501` — **the only kernel mutation**:
   `kernel_generate_host_signal(pid, signum)` (`wasm_api.rs:2534`). `-ESRCH`
   returns; any other nonzero calls `#failBlockingRetryProtocol`.
4. `:26504-26627` — **pure TypeScript wait-queue interruption**, in a fixed
   order that is itself load-bearing:

```
wakePendingSignalWaits            :26504  → pendingSignalWaits
#drainAndProcessWakeupEvents…     :26509  → stoppedPids, parkedChannelCompletions,
                                            deferredStoppedChannels,
                                            deferredProcessWorkerStarts,
                                            pendingPipeReaders/Writers,
                                            pendingPollRetries, pendingSelectRetries,
                                            pendingAdvisoryLockRetries
reapKilledProcessesAfterSyscall   :26515  → cancelPendingSleepsForProcess, processes,
                                            hostReaped
hostReaped gate                   :26520  → return if routing already complete
interruptWaitingChildForSignal    :26526  → waitingForChild  (splice out, EINTR,
                                            re-splice on failure)
kernel_pick_signal_target_tid     :26530  → Rust picks the target thread
kernel_thread_has_deliverable     :26538  → Rust deliverability gate
interruptPendingFutexForCaught…   :26545  → pendingFutexWaits  (dequeue-then-
                                            interrupt; never a raw Atomics.notify,
                                            which would complete the futex
                                            *successfully* and strand the
                                            handler record in Rust)
retryPendingWriterForCaughtSignal :26557  → pendingPipeWriters
pendingSleeps sweep               :26560  → cancel timer, EINTR
pendingPollRetries sweep          :26584  → snapshot-filter-skip-if-replaced
pendingAdvisoryLockRetries sweep  :26598  → same
pendingSelectRetries sweep        :26614  → cancels BOTH timeout and immediate
```

Three Rust queries steer the routing and mutate nothing:
`kernel_pick_signal_target_tid` (`wasm_api.rs:2486`),
`kernel_thread_has_deliverable` (`:2507`), `kernel_get_process_exit_signal`
(`:2238`). Not touched directly: `socketTimeoutTimers`,
`blockingRetrySnapshots`, `epollInterests`, `signalWaitDeadlines`.

### 6.2 Rust already owns every piece of signal *semantics* — VERIFIED

There is no authoritative signal state in TypeScript at all.

| state | Rust home |
|---|---|
| dispositions | `SignalState.actions: [SignalAction; 65]` (private), `signal.rs:565` |
| process blocked mask / pending set / RT queue | `signal.rs:567`, `:570`, `:573`; attached at `process.rs:850` |
| per-thread mask / pending / RT queue / mask-wait LIFO / handler depth | `PerThreadSignalState`, `signal.rs:344-357`; attached at `process.rs:565`, `:854` |
| fusing accessors | `pending_for` `process.rs:1692`, `blocked_for` `:1663`, `deliverable_for` `:1766`, `pick_thread_for_shared_signal` `:1745`, `next_deliverable_signal` `:1775` |
| default actions and delivery | `default_action` table `signal.rs:60`, `apply_default_signal_action_impl` `:137`, `deliver_pending_signals_impl` `:216`, `dequeue_signal_for` `:160` → `Process::consume_signal_for` `process.rs:1940` |
| syscalls | `sys_kill` `syscalls.rs:9287`, `sys_raise` `:9306`, `sys_sigaction` `:9543`, `sys_signal` `:9593`, `sys_sigprocmask` `:9635`, `sys_sigsuspend` `:9526`, `sys_pause` `:9534`, `sys_sigtimedwait` `:9469`, `sys_alarm` `:9335`, `sys_signalfd4` `:16802`; `rt_sigpending`/`rt_sigreturn` inline at `wasm_api.rs:4328`/`:5461`; `tkill` at `wasm_api.rs:8615` |
| exports | 18 signal-related `kernel_*` exports |

Known gap found in passing: **`tgkill` is not wired** (`wasm_api.rs:5433-5434`).

**So K3 is a wake-path migration, not a signal-semantics migration.**

### 6.3 The measured classification

**(a)** dies with the scheduler · **(b)** separate work · **(c)** host floor.

| class | lines in `kernel-worker.ts` | share |
|---|---|---|
| **(a) dies with K3** | **1,278** | 71% |
| **(b) separate signal work** | **310** | 17% |
| **(c) host floor** | **209** | 12% |
| total | **1,797** | |

**The brief's "~700 signal lines" is roughly half the real figure, and the
single largest item is not `sendSignalToProcess`.** It is the inline
`rt_sigtimedwait` host-owned wait/retry block at **`:18031-18218`, 188 lines** —
which is pure scheduler, and which §2.2 already traced.

Largest class-(a) items:

| item | span | lines |
|---|---|---|
| inline `rt_sigtimedwait` wait + retry | `:18031-18218` | 188 |
| `resumeStoppedProcess` — wake/preflight half | `:14643-14875` | ~180 |
| `sendSignalToProcess` — waiter interruption half | `:26522-26627` | 106 |
| `interruptStoppedChannelWithPreparedSignal` | `:14882-14952` | 71 |
| `#killAllBlockedForTeardownWithinKernelEntry` | `:15213-15281` | 69 |
| inline `kill`/`tkill`/`rt_sigqueueinfo` post-dispatch | `:14023-14081` | 59 |
| inline `onPosixTimer` → `firePosixTimer` | `:3453-3505` | 53 |
| `#completeSleepWithSignalCheckWithinKernelEntry` | `:18646-18689` | 44 |
| `wakePendingSignalWaits` | `:26316-26354` | 39 |
| `interruptPendingFutexForCaughtSignal` | `:26420-26456` | 37 |
| `interruptWaitingChildForSignal` / `…ForDirectedSignal` / `…ForGenerated…` | `:25511-25587` | 73 |
| `#pickKernelSignalTargetTid` + `#kernelThreadHasDeliverable` + `#validateKernelSignalTargetTid` | `:25445-25504` | 46 |
| `postponeSignalSafe{Poll,Select}Retries` + `anyPendingRetryNeedsSignalSafeWake` | `:16224-16301` | 54 |
| … 20 further methods of 4–31 lines each | | |

Class **(c)** — the genuine floor, which survives everything:

| item | where | lines | why it is floor |
|---|---|---|---|
| `host_call_signal_handler` | `kernel.ts:1901-1927` | 27 | `Table.get(index)` then **calls the guest function**. The one true "call a guest export" act |
| `#dequeueSignalForDelivery` | `kernel-worker.ts:14260-14384` | 125 | writes the `CH_SIG` record into the *process's* `WebAssembly.Memory`. **Weaker than it looks:** K2's widened `host_proc_write_bytes` can now reach that memory from the kernel, so the *write* is migratable and only the notify is floor. Re-examine at K3-9 rather than inheriting it |
| `wakeChannelForTeardownExit` | `:15394-15424` | 31 | writes `CH_SIG_SIGNUM = SIGKILL` into guest memory — same caveat |
| `resumeStoppedProcess` — Worker launch + publication half | within `:14643-14875` | ~53 | constructing/starting a Worker (K4 boundary) |
| `host_set_alarm` / `host_set_posix_timer` bodies | `kernel.ts:1890-1897`, `:3922-3934` | 20 | `setTimeout`/`setInterval` — collapse into the single deadline timer (§5.4 F3) |
| `host_sigsuspend_wait` body | `kernel.ts:1898-1900`, `:3936-3970` | 38 | **not floor — dead.** Zero Rust callers; blocking `Atomics.wait`. Delete in 7.0 |

### 6.4 The clearest single demonstration: `handleThreadCancel`

`kernel-worker.ts:16574-16813`, **240 lines**. After completing the caller's
syscall it arms `pendingCancels`, then walks **seven** container-specific
interrupt arms in a fixed order — futex (`:16650`), sleep (`:16663`),
`rt_sigtimedwait` (`:16680`), and further arms for pipe readers/writers, poll
retries, advisory locks and `waitingForChild`. Each arm re-implements "prove
this entry still names this exact channel generation, cancel its timer, delete
its record, publish `EINTR`".

With one kernel wait queue this is `kernel_cancel_task_wait(pid, tid)` and one
`match` the compiler checks for exhaustiveness. **That is the V2 payoff in one
method:** today, adding an eighth wait kind and forgetting the eighth arm here
produces a thread that cannot be cancelled, and nothing catches it.

### 6.5 Answer to the brief's question

Most of the signal surface named is **scheduler routing**, and it collapses:
**~1,278 lines disappear with K3**, against ~310 lines of genuine remaining
signal work (crash notification, `SIGCHLD` policy, exec-handoff termination,
the public `signalProcess` API) and ~209+85 lines of floor, two of which
(`#dequeueSignalForDelivery`, `wakeChannelForTeardownExit`) should be
re-examined against K2's widened cross-memory primitive rather than inherited.

Signals do **not** need a separate migration item to make K3 complete. They need
one to finish *signal marshalling and `tgkill`*, which is a different, smaller
item.

## 7. Sequencing — the increment order

The `tmpfs.rs` pattern (`docs/plans/2026-08-28-phase5-vfs-to-rust.md:363-384`)
is **dormant store → mutable → ABI/manifest → syscall wiring (still dormant) →
cutover**. It applies here, but with one addition that no previous K item
needed, because the failure mode here is a **silent hang** rather than a wrong
answer.

### 7.0 — Debt and dead weight (no behavior change)

| step | work | risk |
|---|---|---|
| 0a | Delete the four stale V8 epoll comments (`:3246`, `:12237`, `:18029`, `:19616`) | none |
| 0b | Delete the dead imports `host_futex_wait` and `host_sigsuspend_wait` (zero Rust call sites) + their `HostIO` methods, `WasmHostIO` impls and `kernel.ts` bodies. Snapshot regen, no ABI bump | none |
| 0c | Remove `host_nanosleep`'s two call sites: make `sys_usleep` behave like `sys_nanosleep`; delete `sys_epoll_pwait`'s empty-interest sleep. Then delete `host_nanosleep` too | fixes a live whole-machine stall |
| 0d | Mechanically split `crates/runtime-core/src/syscalls.rs` (47,203 lines) before adding a subsystem to it — census §11.6 already flags this | none, but large diff |

Steps 0a–0c are **84 → 81 imports** and remove the whole "blocking wait
primitive" concept for near-zero risk, and 0c fixes a live defect. They are worth landing even if K3 stalls.

### 7.1 — Dormant kernel wait queue

`crates/runtime-core/src/wait_queue.rs`, unit-tested, wired to nothing:

```rust
enum WakeSource { Pipe(u32), Accept(u32), AdvisoryLock, DatagramWritable,
                  ChildEvent(Pid), Signal(Tid), Futex(Pid, GuestAddr) }
enum WaitKind   { Transfer(BlockingRetryTarget), Poll, Select, EpollWait,
                  Sleep, SigTimedWait{mask}, ChildWait{opts}, Futex,
                  AdvisoryLock, StoppedPublication }
struct Sleeper  { pid, tid, kind: WaitKind, sources: SmallVec<WakeSource>,
                  deadline: Option<MonotonicNs>, request: FrozenRequest }
```

Plus a monotonic deadline min-heap, and:

- export `kernel_next_wait_deadline_ns() -> i64`;
- a `TASK_COMPLETE { pid, tid }` wake-event kind;
- gate `kernel_set_wait_queue_enabled(u32)`, **default off**.

Deadlines must use `host_clock_gettime(CLOCK_MONOTONIC)`, **not** the
wall-clock `Date.now()` the TS scheduler uses today (§8.7).

### 7.2 — Shadow mode (the increment tmpfs did not need)

TS still owns every wait, but every park/unpark is *also* recorded into the
kernel queue, and the kernel's computed ready set is compared against TS's
decision. A divergence fails loudly in tests and in a debug build.

This is the increment that makes the rest safe. A hang has no error message; the
only way to find a lost wakeup before it reaches a user is to run both
schedulers and diff them under the conformance suites and a WordPress boot.
**Do not skip it to save time.**

### 7.3 → 7.11 — Family cutovers, smallest semantics first

| # | family | containers deleted | why here |
|---|---|---|---|
| 3 | **timers** — `nanosleep`, `clock_nanosleep`, `usleep` | `pendingSleeps` | no readiness source, one wake source (deadline). Proves the heap, the single host timer, and the completion path with the smallest POSIX contract |
| 4 | **advisory locks** — `fcntl(F_SETLKW)`, `flock` | `pendingAdvisoryLockRetries` | one broad wake source, lock state already Rust-owned, and the container's own doc says the host never inspects it |
| 5 | **transfer** — read/write/pread/pwrite/recv/send/…/accept/connect | `pendingPipeReaders`, `pendingPipeWriters`, `socketTimeoutTimers`, `blockingRetryWakeTargets`, most of `blockingRetrySnapshots` | the pin machinery already exists; sub-split (a) read-like (b) write-like (c) accept/connect (d) sendmsg/recvmsg/sendfile/splice (e) mqueue + SysV |
| 6 | **poll / ppoll / select / pselect6** | `pendingPollRetries`, `pendingSelectRetries`, `wakeScheduled`, `channel.readiness*`, `getReadinessDeadline`, `resolvePollReadinessIndices` | **this is where `SIGNAL_SAFE_POLL_WAKE_DELAY_MS` dies.** Ordering becomes structural |
| 7 | **epoll** | `epollInterests` + 14 touchpoints | **gated on D2** (fork inheritance, `fork.rs:1631`); 12 of 14 touchpoints delete against existing exports, and only `resolveEpollReadinessIndices` needs new Rust — and after step 6 it needs none. D3 (OFD keying) splits out — see §4.4 |
| 8 | **futex** | `pendingFutexWaits`, `handleFutex` | **gated on the probe in §11.1** |
| 9 | **process wait + signal wait** | `waitingForChild`, `pendingSignalWaits`, `signalWaitDeadlines` | `kernel_wait_child_poll` already computes the answer |
| 10 | **stopped-process parking** | `stoppedPids`, `parkedChannelCompletions`, `deferredStoppedChannels`, `pendingResumePids`, `resumePreparedSignals` | **not** `deferredProcessWorkerStarts` — see §10.3 |
| 11 | **cancellation unification** | `pendingCancels` | `handleThreadCancel` 240 → ~10 lines |
| 12 | **remove the flag and the scaffolding** | — | delete the token protocol (`kernel_blocking_retry_token`/`_release`), `kernel_set_current_tid`, `kernel_get_fd_pipe_idx`, `kernel_get_fd_send_pipe_idx`, `kernel_get_fd_accept_wake_idx`, and the TS test authority that drove them |

At every step the system is complete: an un-migrated family still uses its TS
park, and the flag selects per-family.

### 7.12 — Validation contract

Per the batching policy (§2d of the value plan), each increment keeps only what
is load-bearing, and the rest goes to the coordinator's group run. For K3 the
load-bearing gate is **not** unit tests:

| increment | its own gate |
|---|---|
| 7.0 | `cargo test -p kandelo-runtime-core`; `check-abi-version.sh update` (expect only import/export removals) |
| 7.1 | `cargo test -p kandelo-runtime-core` (the queue is pure logic) |
| 7.2 | **shadow-divergence must be zero** across host Vitest + `scripts/run-sortix-tests.sh --all` + a WordPress Chromium boot |
| 7.3–7.11 | per family: the sortix signal/poll/select subtrees, `scripts/run-posix-tests.sh`, `host/test` for that family, **and a browser run** — `kernel-worker.ts` is a shared cross-host file, so Node green proves nothing about the browser (the K2 grounding made exactly this point) |
| 7.6 | additionally `tests/sortix/os-test/signal/ppoll-block-sleep-write-raise`, named in the code as the case the 50 ms grace exists for |
| all | **benchmarks.** K3 is the syscall hot path. `docs/agent-guidance/performance.md` requires full suites on Node *and* browser, before/after. The WordPress install.php 28 s vs 1.9 s datum at `:18000` shows this is not theoretical |

---

## 8. The hang risks, named

Every historical hang in this project lives in this code. These are the specific
mechanisms, each traced to code on this tip.

**8.1 — Iterator livelock (the `[[wordpress-smtp-reset-deadlock]]` shape).**
`retrySyscall` runs `handleSyscall` **synchronously**, which can re-insert the
same key via `pendingPollRetries.set` when the kernel returns EAGAIN again. JS
`Map` iterators are not snapshots, so a re-inserted key appears at the new tail
and the iterator yields it forever — one kernel-worker thread spinning, whole
machine dead. The comment stating this is at `:15801-15809`. The mitigation is
hand-repeated at **five** sites (`:15783`, `:15810`, `:16179`, `:16211`,
`:16347`) as "snapshot with `Array.from(...)` then skip-if-replaced". The
canonical trigger is `accept()`, which **has no EINTR path**, so a SIGCHLD wake
re-parks it under the same key.
*In the Rust design:* the drain must produce an **owned** ready set and the
re-park must happen in a distinct kernel entry. Rust does not prevent this bug —
`Vec` iteration with mutation is a borrow error, which helps, but re-entrancy
through the host is not. Make it structural, and keep
`host/test/signal-accept-livelock.test.ts` (677 lines) alive against the new
implementation.

**8.2 — Lost wakeup becomes fatal.** Today a missed `wakeup.rs` `push()` is
survivable: the 10 ms / 50 ms / 500 ms safety timers eventually retry, and the
broad wake sweeps everything. With a precise kernel queue there is no broad
fallback, so a missed push is a permanent hang. Two of the seven wake kinds are
*already* broad-with-no-identity (`datagramWritable`, `advisoryLock`), which
means the precise paths for those do not exist yet.
*Mitigation:* keep a bounded safety-net deadline through shadow mode and one
release past cutover, **with a counter that reports loudly** every time the
safety net rather than a targeted wake resolved a sleeper. A silent safety net
is the convenient illusion the Bar forbids; a counted one is evidence.
**NEEDS-DEFER-DECISION (§11.4)** on when to remove it.

**8.3 — The ppoll/kill ordering race.** `SIGNAL_SAFE_POLL_WAKE_DELAY_MS = 50`
(`:896`, applied at `:16241-16248`) exists because a pipe write and a follow-up
`kill` from the same process can reach the reader out of order. The cutover must
**prove** the ordering is structural inside the serialized kernel, not restore
the grace period. If the grace has to come back, K3-6 has not worked and that
must be reported as such.

**8.4 — A missed `WaitKind` arm.** Seven parking mechanisms today means seven
places a new signal-interrupt path must be added, and nothing enforces it — see
`handleThreadCancel` (§6.4). The Rust design must make `WaitKind` an enum
matched exhaustively in exactly one interrupt function, so the compiler is the
enforcement.

**8.5 — The kernel worker must never park.** `host_nanosleep`,
`host_futex_wait` and `host_sigsuspend_wait` all call blocking `Atomics.wait`
**on the kernel-worker thread**. `host_nanosleep` is reachable today
(§5.2). Deleting all three in 7.0 makes the hazard unrepresentable rather than
merely unused.

**8.6 — Re-entrant drain.** `#drainAndProcessWakeupEventsWithinKernelEntry`
already recurses into itself (`:16053`) when a CONTINUED resume enqueues a
follow-up STOPPED. That recursion is correct today because the kernel entry
gate serializes it; the Rust design must keep an equivalent bound.

**8.7 — Wall-clock deadlines.** `getReadinessDeadline` (`:16437`) and every
`deadline` comparison use `Date.now()`. A backwards NTP step extends every
sleep in the machine; a forwards step expires them early. The kernel queue must
use `CLOCK_MONOTONIC` via `host_clock_gettime(1)`. This is a pre-existing latent
defect the migration should fix rather than port.

**8.8 — Browser timer clamping.** One host timer at the next deadline is
elegant but exposed to the browser's 4 ms nested-`setTimeout` clamp and to
background-tab throttling (≥1 s). The existing `pollTick` yields to
`setTimeout(0)` every 4 ms for exactly this reason (`:15489-15495`). Measure
before claiming the single-timer design is neutral.

**8.9 — Scratch-lease reentrancy.** The wake drain deliberately "owns the
complete batch before acting on any event" (`:15973-15975`) because
STOPPED/CONTINUED can send SIGCHLD and reuse the same scratch allocation. Any
new kernel→host completion stream inherits that constraint.

---

## 9. Test fallout

Files in `host/test` that reference a scheduler container, by size:

| lines | file | fate |
|---|---|---|
| 8,138 | `kernel-scratch-transfer-boundaries.test.ts` | mixed — transport contract survives, scheduler assertions die |
| 5,772 | `kernel-blocking-retry-snapshot.test.ts` | **dies with its subject**; replaced by Rust tests on the wait queue |
| 3,185 | `process-wait-lifecycle.test.ts` | becomes a Rust test |
| 2,257 | `exec-state-tracking.test.ts` | epoll-mirror assertions die (§4.4 D8) |
| 2,112 | `kernel-scratch-contract.test.ts` | mostly survives (3 of 8 cases already fail pre-existing — value plan §2e) |
| 1,696 | `file-shared-memory.test.ts` | K7 overlap |
| 1,669 | `kernel-large-transfer-protocol.test.ts` | mixed |
| 799 | `advisory-lock-retry.test.ts` | becomes a Rust test |
| 677 | `signal-accept-livelock.test.ts` | **keep** — the livelock regression must survive the rewrite |
| 672 | `readiness-deadline.test.ts` | becomes a Rust test |
| 436 | `kernel-clone-exit-entry.test.ts` | mixed |
| 425 | `kernel-exec-entry.test.ts` | epoll-mirror assertions die |
| 337 | `kernel-network-cleanup-entry.test.ts` | mixed |
| 336 | `select-signal-outcome.test.ts` | becomes a Rust test |
| 283 | `kernel-teardown-pipe-entry.test.ts` | mixed |
| 282 | `kernel-telemetry-entry.test.ts` | mixed |
| 246 | `kernel-worker-entry-root-contract.test.ts` | survives |
| 229 | `connect-pending-retry.test.ts` | becomes a Rust test |
| 183 | `readiness-wakeup.test.ts` | becomes a Rust test |
| 129 | `datagram-wakeup.test.ts` | becomes a Rust test |
| **29,663** | **20 files** | |

**Seven** test files set `usePolling: true` (`clone-tid-authority`,
`kernel-ipc-shmat-entry`, `datagram-wakeup`, `kernel-large-transfer-protocol`,
`kernel-worker-copyback`, `kernel-clone-exit-entry`,
`kernel-network-cleanup-entry`) — see §11.2. That test dependency is the only
thing keeping the `MessageChannel` poller alive.

The epoll-mirror subset is smaller than the file list suggests: **~110 lines**
must be rewritten or deleted (two epoll-specific cases) and **~30 lines** of
setup and assertions come out of three surviving mixed cases (§4.4 D8).

---

## 10. Interaction with K7, and challenging the brief's framing

### 10.1 K7 (shared-mapping page cache) — measured, and it does not collide

Both items edit `kernel-worker.ts`. Measured mechanically over the class body
(2732–34696, 647 members = 536 methods + 111 fields), classifying each member by
whether its span references a scheduler container (**A**) or a mapping container
(`sharedMappings`, `fdWritebackFdRefs`, `anonymousSharedBackings`,
`nextAnonymousSharedBackingId`, `sharedMmapBackings`, `sharedMemoryReleasePids`,
`sharedMappingInheritancePids`, `sharedMmapFdCache`, `shmMappings`,
`shmSegmentVersions`, `#fdWritebackFlushLossReports` — **B**):

| region | direct-reference methods / lines | + family helpers |
|---|---|---|
| **A — blocking scheduler (K3)** | 82 / **5,794** | 128 methods / **7,793** |
| **B — shared-mapping page cache (K7)** | 46 / **2,821** | 89 methods / **4,362** |
| C — everything else | — | 317 methods / 15,579 |
| the 2 cross-cutting giants | — | 2 methods / 3,688 |

The census's K7 figure (3,027) sits between B's two tiers — consistent. The
census's K3 figure (4,532) sits *below* even A's narrow tier; see §10.2.

**Verdict: no rewrite collision. Either order works; parallel is feasible with a
6-method contract freeze.** The evidence:

- **Zero line-range overlap** between A's 31 contiguous blocks and B's 6.
- **83% of B is one block** (`26871–30574`, 3,704 lines, 80 members) and it
  contains no scheduler reference at all.
- A is scattered — its largest blocks are `17563–20111` (2,549), `15662–16853`
  (1,192), `14504–15424` (921), `25506–26144` (639), `16938–17398` (461) — but
  never *interleaved* with B.
- Only **5 methods** touch both state sets, and only ~45 lines of genuinely
  dual-touch text:

| method | span | lines | the dual touch |
|---|---|---|---|
| `#handleSyscallInner` | `11873-14116` | 2,244 | 34 A lines + 33 B lines, **never coincident** — nearest approach is 6 lines apart (`12241-12249` vs `12255-12259`) |
| `#createTestAuthority` | `3528-4971` | 1,444 | 4 A lines (`:3879`, `:4905`, `:4910`, `:4911`), 0 B |
| `#replayGenericBlockingRetry` | `17400-17561` | 162 | **1 B line** (`:17523`) — a `(this.sharedMmapBackings?.size ?? 0) > 0` guard gating post-replay writeback |
| `#unregisterProcessWithinKernelEntry` | `8254-8328` | 75 | 1 B line (`:8272`, `releaseAllSharedMemoryForProcess`) among ~14 A lines |
| `#deactivateProcessWithinKernelEntry` | `8571-8608` | 38 | 1 B line (`:8585`) among ~10 A lines |

Plus one A→B call: `materializePreparedChannelCompletion` (`14589-14614`) calls
`synchronizeSharedMemoryForBoundary` at `:14602` inside a try/catch degrading to
`-EIO`. And one declaration-level interleave: `epollInterests` (`:3243-3247`) is
wedged between `sharedMmapFdCache` (`:3242`) and `shmMappings` (`:3249`) — the
**only** place A and B field declarations are adjacent.

**If K3 and K7 run in parallel, freeze these four contracts up front:**

1. The **ordering** of the scheduler cleanup relative to
   `releaseAllSharedMemoryForProcess` inside the two `*WithinKernelEntry`
   teardown methods (`8254-8328`, `8571-8608`). That is a semantic contract, not
   just text.
2. K7 exposes the `:17523` guard as a predicate (e.g. `hasSharedMmapBackings()`)
   so K3 can move `#replayGenericBlockingRetry` wholesale.
3. `synchronizeSharedMemoryForBoundary` stays callable from the completion path
   (`:14602`).
4. Neither item **reflows** `#handleSyscallInner`. Its A and B clusters are ≥6
   lines apart everywhere, so git merges pure case-arm edits; a structural
   rewrite of the dispatcher by either item conflicts with the other.
5. Move `epollInterests` out of the B field block before either splits fields.

**Churn argues for K3 first.** Region B gained **+668 lines three days ago**
(`5f455e156`, `13c96774a`, `e6e269960`, 2026-09-06 — MAP_SHARED writeback
correctness in `27000–27800`, plus new B fields at `:3213`/`:3235` and the exec
address-space satellite at `:9640`/`:9721`). Region A has had **no direct edit in
the last 20 commits**; its only recent neighbour is today's `eb36f4be3`
(SIOCGIFCONF removal, K2) at `20112–20246`, immediately past `handleEpollPwait`'s
close at `:20111`. K7's target is a moving surface and should be re-measured
against HEAD immediately before it starts.

### 10.2 The line count is understated

Measured, **the scheduler is 5,794 lines across 82 methods** counting only
methods that directly reference one of the 21 containers, and **7,793 lines
across 128 methods** including their family helpers (`runSelectKernelAttempt`,
`captureSelectBlockingRetrySnapshot`, `#captureBlockingRetryDisposition`,
`handleFcntlLock`, …).

The census's 4,532 is reproducible as **4,333** — blocks `17563-20111` (2,549) +
`15662-16853` (1,192) + `16938-17398` (461) + `15464-15594` (131) — i.e. the
poll/select/epoll + blocking-retry + wake core **only**. It excludes
stopped-process parking, waitpid/waitid deferral, futex and signal-wait, all of
which the brief itself names as the scheduler.

Add to that:

- **~1,278 lines** of signal routing that is really scheduler routing (§6.3);
- **~29,700 lines** of `host/test` (§9);
- the ~200 lines of `blocked_retry.rs` token scaffolding that is *deleted*
  rather than moved (§3.4).

So K3 is **larger than billed by roughly 1,300–3,300 lines of production code**,
and its largest single component is test migration — real work the plan already
says must be sized rather than discovered (census §9).

### 10.3 "Keystone" is right about signals and IPC, wrong about two pieces

**Right:** signals collapse into it (§6 — ~1,278 lines of class-(a) routing, 71%
of the signal surface), and IPC blocking collapses into it (mqueue / SysV msg /
SysV sem already have pinned targets in `blocked_retry.rs`).

**Wrong on two counts:**

1. **`deferredProcessWorkerStarts` (`:3059`) is K4, not K3.** It holds JS
   `Worker` **constructors** withheld while the authoritative `Process` is
   stopped, and `resumeStoppedProcess` splits ~180 scheduler lines from ~53
   Worker-launch lines. The *decision* is kernel state; the *held closure* is a
   host act (ledger §2.2). K3 should move the gating predicate and leave the
   closure. Not splitting this cleanly is how K3 and K4 collide.
2. **Deleting the epoll mirror is gated on a pre-existing POSIX gap, not on
   migration.** `fork.rs:1631` discards the child's epoll instances, and — the
   sharper point — that is **already broken today with the mirror in place**
   (§4.4). K3-7 must land the Rust fix; it is neither K3 nor K7 work in kind.

### 10.4 "Highest risk" — agreed, and here is why it differs in kind

K1, K2, K10 and K13a all fail *loudly*: a wrong byte, a missing export, a
divergent translation. K3's failure mode is a **process that never wakes up**, in
one browser, under one workload, after a delay. That is why §7.2's shadow mode is
not optional overhead — it is the only mechanism that converts this item's
failure mode into the loud kind the rest of the campaign relies on.


## 11. NEEDS-DEFER-DECISION and STRONG DOUBT

### 11.1 STRONG DOUBT + NEEDS-DEFER-DECISION — is futex a host floor at all?

**What.** The brief states `host_futex_wait` / `host_futex_wake` are
irreducible. §5.2 shows `host_futex_wait` has zero Rust callers and would stall
the machine if called, and §5.3 shows the real futex implementation is TS
`Atomics.waitAsync` on process memory. So the question is not "keep the import"
but "**can the kernel own the futex wait queue outright?**"

**The argument that it can (INFERRED — not yet probed).** Every futex operation
that matters is a syscall, and every syscall in the machine is serialized
through the one kernel worker. So a compare-and-park performed inside the kernel
*is* atomic with respect to every other futex operation:

- waker stores, then issues `FUTEX_WAKE` → if `FUTEX_WAKE` is handled first, the
  later `FUTEX_WAIT` reads the new value and returns `EAGAIN`. No lost wakeup.
- if `FUTEX_WAIT` is handled first, the sleeper is in the kernel queue and
  `FUTEX_WAKE` finds it. No lost wakeup.

The value compare needs to read guest memory from the kernel — which is exactly
what K2's widened `host_proc_read_bytes` now does. Under this design no guest
thread is parked on the futex address at all (it is parked on its channel), so a
raw `memory.atomic.notify` with no `FUTEX_WAKE` syscall wakes nothing —
**which is the correct Linux behavior**, where the wait queue lives in the
kernel, not in userspace.

**Why it is doubt and not a conclusion.** It rests on (i) musl never waking a
futex without a syscall when there may be waiters, and (ii) no fork/exec path
carrying a futex address across an address-space change. Neither is verified.
`FUTEX_REQUEUE`, `CMP_REQUEUE` and `WAKE_OP` (`syscalls.rs:16143-16159`) also
need checking.

**Cost now:** a focused probe — a pthread-heavy guest (MariaDB is the known
stress case, cited at `:18072`) driven through a kernel-owned futex path on
Node, Chromium and WebKit. Perhaps a day.
**Cost later:** if it holds and we did not check, `pendingFutexWaits`, the whole
of `handleFutex` (~235 lines), the `SYS_FUTEX` intercept, and two host imports
survive the campaign for no reason — and the Node/browser vs native divergence
(§5.3) is baked in permanently.
**Recommendation:** run the probe **before** increment 7.8, and treat 7.8 as
gated on it. Do not assume either answer.

### 11.2 NEEDS-DEFER-DECISION — the `usePolling` `MessageChannel` poller

**What.** `usePolling` (`:15459`) selects a `MessageChannel`-driven poller
(`startPolling` `:15466`, `pollTick` `:15504`, ~120 lines) instead of
per-channel `Atomics.waitAsync`. Its justification (`:15449`) is a **fifth**
never-re-tested V8 claim, and its stated purpose is "browser embeddings that run
the kernel on the main thread" — a topology `CLAUDE.md` explicitly forbids.
VERIFIED: production sets it `false`; only six `host/test` files set it `true`.

**Cost now:** migrating six test files off it.
**Cost later:** K3 must support two dispatch topologies through every increment,
doubling the shadow-mode matrix and the hang surface.
**Recommendation:** delete it in 7.0, after re-testing the V8 claim the way K0c
re-tested the epoll one. If the claim reproduces, document it properly in
`docs/browser-support.md` — which it has never had. **This is the maintainer's
call, not mine.**

### 11.3 NEEDS-DEFER-DECISION — epoll fork/exec inheritance and OFD keying

**What.** Deleting the mirror requires implementing epoll inheritance in Rust
(`fork.rs:1631`, `:2093`) and, separately, re-keying interests on OFD identity
(the gap self-documented at `:9392`).
**Cost now:** real POSIX work in `fork.rs` and the fd table; the OFD re-keying
touches `EpollInstance` and `sys_epoll_ctl`.
**Cost later:** the mirror cannot be deleted, so K3-7 cannot complete, so
`epollInterests` and its 14 touchpoints survive the campaign — and the POSIX gap
stays hidden behind a host shadow, which is exactly what the platform-values
contract forbids.
**Recommendation:** land D2 (inheritance) inside K3-7 as a prerequisite; split
D3 (OFD keying) into its own POSIX item, since it is orthogonal to who owns the
wait and has its own conformance surface. **Ask before splitting.**

### 11.4 NEEDS-DEFER-DECISION — the post-cutover safety net

**What.** Whether to keep a bounded fallback deadline after each family cuts
over.
**Cost now:** keeping it hides a genuinely missing wake behind a slow retry —
unless it is counted and reported.
**Cost later:** removing it means the first missed `push()` is a user-visible
hang with no diagnostic.
**Recommendation:** keep it through shadow mode and one release past each
family's cutover, **with a loud counter** and a test that asserts the counter is
zero across the conformance suites. Remove it when that assertion has held for a
full green run on Node, browser and native. Report it as a temporary measure in
every interim claim; never let it become silent.

### 11.5 NEEDS-DEFER-DECISION — `syscalls.rs` split before or during K3

Census §11.6 already flags that `crates/runtime-core/src/syscalls.rs` is 47,203
lines in one file and that adding four subsystems without a mechanical split
makes it unreviewable. K3 adds one of those four.
**Cost now:** a large, purely mechanical diff that will conflict with any
in-flight work touching `syscalls.rs`.
**Cost later:** the K3 review is unreviewable, which for the campaign's
highest-risk item is the worst place to spend that debt.
**Recommendation:** split first, as its own commit, at a moment when no sibling
agent is editing `syscalls.rs`.

### 11.6 NEEDS-DEFER-DECISION — benchmark scope

`docs/agent-guidance/performance.md` requires full benchmark suites on both
hosts, before/after, for syscall hot-path changes. K3 changes the hot path in
every increment. The batching policy (value plan §2d) defers expensive suites to
one coordinator group pass.
**Recommendation:** these conflict. Take benchmarks at **three** points — after
7.2 (shadow, expected regression), after 7.6 (poll/select, the largest win), and
at 7.12 — rather than per increment or once at the end. Anything else either
burns days or produces a performance claim with no evidence. **Confirm the
three-point plan before starting.**

### 11.7 NEEDS-DEFER-DECISION — run K3 and K7 in parallel, or in sequence?

**What.** §10.1 shows they do not collide: zero block overlap, 5 dual-touch
methods, ~45 lines of genuinely shared text.
**Cost now (parallel):** the four-contract freeze in §10.1 must be agreed before
either starts, and neither may reflow `#handleSyscallInner`.
**Cost later (sequential):** both are large; serializing them adds their
durations. K7 also unblocks Workstream H5, which is waiting.
**Recommendation:** run them in parallel with the freeze, and start **K3 first**
on churn grounds — region B gained +668 lines three days ago and is still moving,
while region A has had no direct edit in 20 commits. Re-measure K7's region
against HEAD immediately before it begins. **Confirm the freeze list before
launching both.**

### 11.8 Recorded doubts that need no decision

- **No ABI bump.** VERIFIED: the guest parks on `CH_STATUS` and has no view of
  who scheduled it (`libc/glue/channel_syscall.c:1872`). Export churn is a
  snapshot regen under the ABI-44 amendment rule. **Reject any ABI-bump demand
  for K3 unless a guest-observable change is actually proposed.**
- **No new host import.** VERIFIED path exists for both remaining floor acts
  (§5.4). Reject option (A) unless (B) demonstrably fails.
- **`pshared.rs:16-19` cites `kernel_wake_blocked_retries()`, which does not
  exist.** Stale doc reference; fix in passing.
- **`EPOLLRDHUP` is declared and never mapped** (`syscalls.rs:16522`,
  `#[allow(dead_code)]`). A real unimplemented epoll event, unrelated to K3 but
  found while grounding it.
- **`poll_check`'s `TimerFd` arm** (`syscalls.rs:14422`) reads `tfd.expirations`
  without calling `timerfd_compute_expirations` (`:16763`), which runs only on
  the read path. INFERRED: a `poll()` on an unread armed timerfd may report
  not-ready. Needs its own check; not K3's to fix, but K3 will be blamed for it
  if it is not recorded now.
- **`tgkill` is not wired** (`wasm_api.rs:5433-5434`). A missing POSIX/Linux
  syscall found while grounding the signal surface. Not K3's, but it belongs in
  the signal-marshalling item K3 hands off to (§6.5).
- **Two class-(c) "floors" in the signal path deserve re-examination, not
  inheritance.** `#dequeueSignalForDelivery` (`:14260`, 125 lines) and
  `wakeChannelForTeardownExit` (`:15394`, 31 lines) are floor only because they
  write into the *process's* `WebAssembly.Memory` — which K2's widened
  `host_proc_write_bytes` now reaches from the kernel. Only the atomic notify is
  genuinely floor. Re-check at K3-9 rather than carrying the classification
  forward; this campaign has inherited five stale floors already.
- **`epollInterests` sits between two mapping-cache field declarations**
  (`:3242`/`:3249`). Move it before either K3 or K7 reorganises fields (§10.1).

---

## 12. Method

`kernel-worker.ts` method spans were extracted with a brace-matching Python pass
over the file and spot-checked against `sed -n` output;
`handleBlockingRetry`'s span (`17734-18479`, 746 lines) was verified that way.
Container declarations, wake routing, the epoll path, the four wait imports and
their call sites, the guest channel park, and `fork.rs`'s `epolls.clear()` were
read directly. The Rust seam (`blocked_retry.rs`, `wakeup.rs`, `sys_poll` /
`sys_select` / `sys_epoll_*`, the `HostIO` wait methods, host-native's 21
implemented imports) was grounded by a dedicated read-only pass and cross-checked
against my own greps at every load-bearing claim.

Three dedicated read-only passes contributed measurements that I cross-checked:
the Rust blocking seam (§3, §5.2); the signal surface and epoll mirror (§4, §6);
and the K3/K7 region accounting (§10.1). The region census partitions the class
body mechanically (member starts at exactly two-space indent, doc comments
attached to the following member, spans trimmed of trailing blanks) and was
spot-checked exactly against `sed -n` for `handleBlockingRetry` (17734-18479),
`handleSelect` (19192-19414) and `handleFutex` (25897-26144). The A/B
classification is given at two tiers because the narrow tier (direct container
reference) is VERIFIED and the wide tier (family helpers) is INFERRED from names,
line locality and call edges.

Not examined: `crates/runtime-core/src/pipe.rs` and `socket.rs` internals beyond
their `wakeup::push` sites; the `#createTestAuthority` surface beyond noting that
`handleBlockingRetry` has a test hook in its first five lines; benchmark
harnesses.
