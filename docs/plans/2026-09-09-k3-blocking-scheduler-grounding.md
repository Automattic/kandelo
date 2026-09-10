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

Five findings change what K3 *is*:

1. **The epoll mirror's stated justification is not merely disproved — the
   code already abandoned it.** `handleEpollPwait` dispatches `SYS_EPOLL_PWAIT`
   through `kernel_handle_channel` today (`kernel-worker.ts:20013`). Three
   comments still assert the V8 crash as fact (`:3246`, `:12237`, `:19616`).
   The mirror now survives for exactly three uses, one of which is a genuine
   platform gap it is hiding (§4).

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

5. **The 4,500-line figure is low and the keystone framing is 80% right.**
   `kernel-worker.ts` scheduler surface measures larger (§1.4), it is **≥24
   state containers, not 21** (§1), and ~29,700 lines of `host/test` are bound
   to it (§9). Two pieces the brief attributes to K3 — stopped-process worker
   deferral, and epoll fork/exec inheritance — belong to K4 and to a POSIX gap
   respectively (§10).

**No ABI bump is required and none should be requested.** The guest parks in
`memory.atomic.wait32` on `CH_STATUS` until it is not `CH_PENDING`
(`libc/glue/channel_syscall.c:1872-1873`) — VERIFIED. It has no opinion about
who decided the wait. K3 is invisible to the guest contract. Kernel exports are
in `abi/snapshot.json`, so export churn is a snapshot regeneration under the
ABI-44 amendment rule already recorded for K13a and K2.

---

## 1. The state containers — the actual inventory

The census says "21 of the 68 state containers". The measured count is **24
containers plus one boolean flag plus two per-channel fields**. All
declarations verified at the cited lines.

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
| 9 | `epollInterests` | `:3247` | `"pid:epfd"` string | `Array<{fd, events, data: bigint}>` | 6 sites (§4) | 8 sites (§4) | **ELIMINATE** — duplicates `Process::epolls[].interests` (`process.rs:894`) |

### 1.2 Timers and sleeps

| # | container | decl | keys on | holds | Rust home |
|---|---|---|---|---|---|
| 10 | `pendingSleeps` | `:2974` | `ChannelInfo` | timer, `syscallNr`, `origArgs`, staged `retVal`/`errVal`/`outputWrites` | deadline-only sleeper. Note the *result is computed before the sleep* and staged in JS |
| 11 | `alarmTimers` | `:2963` | pid | `setTimeout` handle | kernel timer registry; `host_set_alarm` becomes one arm-at-deadline |
| 12 | `posixTimers` | `:2965` | `"pid:timerId"` | `{timeout, interval?, signo}` | same; `host_set_posix_timer` collapses in |
| 13 | `pendingSignalWaits` | `:2989` | `"pid:channelOffset"` | timer, `origArgs`, `signalMask: bigint` | `WaitKind::SigTimedWait` sleeper with the mask; the mask is *already* Rust-owned per-task state (`PerThreadSignalState`, `process.rs:565`) |
| 14 | `signalWaitDeadlines` | `:3001` | `"pid:channelOffset"` | `{pid, deadline}` — retained *across* wake-driven retries | folds into #13. It exists **only** because a retry loses the deadline; a sleeper does not |

### 1.3 Process wait and job control

| # | container | decl | keys on | holds | Rust home |
|---|---|---|---|---|---|
| 15 | `waitingForChild` | `:3021` (array) | linear scan | `{parentPid, channel, origArgs, pid, options, syscallNr, cancellation identity}` | `WakeSource::ChildEvent(parent)`. `kernel_wait_child_poll` (`wasm_api.rs`) already computes the answer |
| 16 | `stoppedPids` | `:3036` | pid set | — | **already Rust-authoritative** (`ProcessState::Stopped`, `process.rs:441`); this is a cache fed by the wake stream |
| 17 | `pendingResumePids` | `:3042` | pid set | — | kernel resume-preflight state |
| 18 | `parkedChannelCompletions` | `:3044` | `ChannelInfo` | a completed result withheld until SIGCONT | sleeper with `WaitKind::StoppedPublication` |
| 19 | `resumePreparedSignals` | `:3054` (`WeakSet`) | `ChannelInfo` | marker | kernel signal-delivery state |
| 20 | `deferredStoppedChannels` | `:3056` | `ChannelInfo` | marker | kernel |
| 21 | `deferredProcessWorkerStarts` | `:3059` | pid | `Set<DeferredProcessWorkerStart>` — **JS Worker constructors** | **STAYS (K4 boundary).** The gating decision is kernel; the held closure is a host act (§10.2) |
| 22 | `hostReaped` | `:25125` | pid set | — | kernel reap state |

### 1.4 Cancellation, transport, coalescing

| # | container | decl | notes |
|---|---|---|---|
| 23 | `pendingCancels` | `:3185` | `Set<ChannelInfo>` — the pre-enqueue race guard for `SYS_THREAD_CANCEL`. Collapses into one kernel `cancel_task_wait(pid, tid)` (§6.3) |
| 24 | `activeChannelRequests` | `:3029` | frozen request identity; **partly transport** (it detaches the guest mailbox flag). SPLIT |
| — | `wakeScheduled` | `:3130` (bool) | coalesces the broad-wake microtask. Disappears with the broad wake |
| — | `channel.readinessDeadline` | `:1530` | per-channel deadline memo, set by `getReadinessDeadline` `:16437` |
| — | `channel.readinessFinalCheck` | `:1532` | "run the kernel once more at the deadline" flag, consumed at `:13210` |

**Count check.** 24 containers (9 readiness + 5 timer + 8 lifecycle + 2
cancellation/transport) + 1 flag + 2 channel fields. The census's "21" is an
undercount; nothing in the migration plan turns on the difference, but the
container inventory in the ledger should be corrected.

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

So the three comments assert a fact that is both untrue on today's engines and
untrue of today's code. **They should be deleted on sight**, independently of
K3 — an inline comment asserting a disproved browser boundary is precisely what
the ledger's §3 forbids.

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

### 4.4 The gap the mirror is hiding — the real cost

**VERIFIED: the Rust kernel discards all epoll state on fork and on exec.**

- `crates/runtime-core/src/fork.rs:1631` — `child.epolls.clear();`
- `crates/runtime-core/src/fork.rs:2093` — `process.epolls.clear();` (exec)

POSIX and Linux both require the opposite: `fork` duplicates the epoll fd, and
parent and child then refer to **the same** epoll instance through the same
open file description; `exec` preserves any epoll fd without `FD_CLOEXEC`.

So `inheritHostFdMirrors` (`:9329`) and `#prepareExecFdMirrorPrune*` (`:9385`)
are not merely a shadow — they are **the only implementation of epoll
fork/exec inheritance in the system**, and even they get it wrong: they *copy*
the interest list into an independent per-child map instead of sharing one
instance, so a post-fork `epoll_ctl` in the child is invisible to the parent.

There is a second, self-documented gap at `:9392-9394`: "The current epoll model
stores numeric fds rather than OFD identity. Dropping closed targets prevents
later fd reuse from observing a stale registration; **duplicate-fd retention
remains a documented gap**." Linux keys an epoll registration on
`(fd, file description)`.

**Deleting the mirror therefore requires, in order:**

| step | work | where |
|---|---|---|
| D1 | Delete the three stale V8 comments | `:3246`, `:12237`, `:19616` |
| D2 | Implement POSIX epoll fd inheritance in Rust: `fork` shares the instance via the fd/OFD table instead of `epolls.clear()`; `exec` preserves non-`CLOEXEC` epoll fds | `fork.rs:1631`, `:2093`, plus the fd table |
| D3 | Re-key `EpollInterest` on OFD identity, not the numeric fd — the gap named at `:9392` | `process.rs:894`, `syscalls.rs:16409` |
| D4 | Replace `resolveEpollReadinessIndices` — either an interim export `kernel_epoll_wake_sources(pid, epfd, out, cap)`, **or nothing**, once the kernel owns the wait and registers its own sleeper against the interests it already holds | `:15749` |
| D5 | Delete touchpoints 3–8, 10–14 outright: the kernel's fd table already handles create, ctl, child rollback and teardown | 11 sites |
| D6 | Fix `sys_epoll_pwait`'s empty-interest `host_nanosleep` stall | `syscalls.rs:16514` |
| D7 | Handle `EPOLLRDHUP`, currently `#[allow(dead_code)]` and never mapped | `syscalls.rs:16522` |
| D8 | Update tests: `exec-state-tracking.test.ts` (`:1716,1730,1733,1902,1920-1923`), `kernel-exec-entry.test.ts` (`:45,304,349,419,422`), `kernel-scratch-transfer-boundaries.test.ts` (`:445,4707,4721,4759`) | 3 files |

**D2 and D3 are POSIX work, not migration work.** They are the honest cost of
the deletion, and they are exactly the "treat the failure as platform feedback"
the values contract asks for: the mirror has been concealing missing epoll
inheritance for five months. They should be tracked as their own POSIX item
inside K3-7 rather than absorbed silently. **NEEDS-DEFER-DECISION (§11.3).**

D1 alone is a two-minute change with no risk and should not wait for K3.

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
| wait primitives | 4 | 2 | **0** — all four imports deleted |
| timers | 2 (`host_set_alarm`, `host_set_posix_timer`) | 1 | **0–1** — both are deadline arms that fold into F3's single timer; the registry is kernel state either way |

That is **84 → 80 declared imports** and, more importantly, **two whole
concepts removed** from the list a host author must understand. It beats the
census target. **STRONG DOUBT is satisfied: K3 adds no host surface.**

### 5.6 Things that are *not* floor, recorded so they are not re-argued

| claim | status |
|---|---|
| "`host_futex_wait` is irreducible because `Atomics.wait` compares and parks atomically" | **The premise is true and the conclusion does not follow.** The kernel worker must not park, so it can never call it. Zero Rust call sites. See §11.1 for the futex design |
| "`epoll_pwait` crashes Chrome via `kernel_handle_channel`" | Disproved by probe **and** already abandoned in code (§4.1) |
| "`Atomics.waitAsync` microtask chains freeze the main thread, so use the `MessageChannel` poller" (`:15449`) | A **fifth** inherited, never-re-tested V8 claim. `usePolling` is set `true` only by 6 test files; production sets it `false`, and CLAUDE.md forbids the main-thread topology it exists for. See §11.2 |
| "the host must own the wait because retries need the request bytes" | The bytes live in guest memory, which K2's widened `host_proc_read_bytes` now reaches from the kernel |

---

## 6. Signals — how much collapses into K3

*(This section is completed from the signal-surface inventory in §6.4; the
routing analysis below is VERIFIED from the code cited.)*

### 6.1 The shape

Signal delivery does not have its own wake mechanism. It **reaches into every
one of the seven parking mechanisms**, because each holds a channel that must be
completed with `EINTR` (or terminated). VERIFIED at
`kernel-worker.ts:26560-26640`:

```
sendSignalToProcess(pid, signo, …)
  → kernel_kill / kernel_deliver_pending_signals   (Rust: queue + disposition)
  → Array.from(this.pendingSleeps.entries()).find(…)          :26560
  → Array.from(this.pendingPollRetries.entries()).filter(…)   :26584
  → Array.from(this.pendingSelectRetries.entries()).filter(…) :26614
  → wakePendingSignalWaits                                    :26316
  → interruptPendingFutexForCaughtSignal                      :26420
  → retryPendingWriterForCaughtSignal                         :16515
  → wakeWaitingParent                                         :25590
```

The **pending/blocked signal sets, per-thread masks, dispositions, RT queues and
the `SignalMaskWaitKind` LIFO are already Rust-owned** (`PerThreadSignalState`,
`process.rs:565`; `Process::signals`; `deliverable_for` / `should_restart_for`,
used by `sys_poll` at `syscalls.rs:14330`). What TypeScript owns is **the
routing**: finding which of its 24 maps holds the target and interrupting it.

### 6.2 The classification

| class | what it is | fate |
|---|---|---|
| **(a) dies with the scheduler** | the per-container interrupt arms — `wakePendingSignalWaits`, `interruptPendingFutexForCaughtSignal`, `retryPendingWriterForCaughtSignal`, the three `Array.from(...).filter(...)` sweeps in `sendSignalToProcess`, `interruptStoppedChannelWithPreparedSignal`, `completeSleepWithSignalCheck`, `completeSelectSignalOutcome`, `completeEpollSignalOutcome`, `postponeSignalSafe{Poll,Select}Retries`, `anyPendingRetryNeedsSignalSafeWake`, `scheduleWakeBlockedRetriesDeferred` | replaced by **one** kernel operation: "interrupt the sleeper for `(pid, tid)`", with an exhaustive `match WaitKind` |
| **(b) separate work** | signal *semantics* still in TS: `#dequeueSignalForDelivery`, `#finishSignalTermination`, `#getProcessExitSignal`, sigaction/sigprocmask marshalling, `SIGCHLD` generation policy, `SA_NOCLDSTOP` handling (`:16197`) | belongs to a later item; K3 does not close it |
| **(c) host floor** | `host_call_signal_handler` (`kernel.ts:1902`) — calling a guest export on the kernel's behalf; and the `Atomics.notify` that wakes a parked guest | stays (ledger §2.2) |

### 6.3 The clearest single demonstration: `handleThreadCancel`

`kernel-worker.ts:16574-16813`, **240 lines**. After completing the caller's
syscall it arms `pendingCancels`, then walks **seven** container-specific
interrupt arms in a fixed order — futex (`:16650`), sleep (`:16663`),
`rt_sigtimedwait` (`:16680`), and further arms for pipe readers/writers, poll
retries, advisory locks and `waitingForChild`. Each arm re-implements "prove
this entry still names this exact channel generation, cancel its timer, delete
its record, publish `EINTR`".

With one kernel wait queue this is `kernel_cancel_task_wait(pid, tid)` and one
`match` the compiler checks for exhaustiveness. **That is the V2 payoff in one
method**: today, adding an eighth wait kind and forgetting to add an eighth arm
here produces a thread that cannot be cancelled, and nothing catches it.

### 6.4 Quantified

Pending the completed method-level inventory (§9 note), the measured signal
surface reachable from the scheduler is:

| method | span | lines | class |
|---|---|---|---|
| `handleThreadCancel` | `:16574-16813` | 240 | (a) — collapses to ~10 |
| `resumeStoppedProcess` | `:14643-14875` | 233 | (a)/(b) split |
| `wakeWaitingParent` | `:25590-25683` | 94 | (a) |
| `interruptStoppedChannelWithPreparedSignal` | `:14882-14952` | 71 | (a) |
| `#killAllBlockedForTeardownWithinKernelEntry` | `:15213-15281` | 69 | (a) |
| `#completeSleepWithSignalCheckWithinKernelEntry` | `:18646-18689` | 44 | (a) |
| `wakePendingSignalWaits` | `:26316-26354` | 39 | (a) |
| `interruptPendingFutexForCaughtSignal` | `:26420-26456` | 37 | (a) |
| `completeSleepWithSignalCheck` | `:18619-18644` | 26 | (a) |
| `interruptPendingCancellationBeforeRegistration` | `:15059-15084` | 26 | (a) |
| `retryPendingWriterForCaughtSignal` | `:16515-16539` | 25 | (a) |
| `completeSelectSignalOutcome` | `:18887-18911` | 25 | (a) |
| `postponeSignalSafeSelectRetries` | `:16278-16301` | 24 | (a) |
| `#retireBlockingRetryCaptureAfterExitedProcess` | `:17311-17333` | 23 | (a) |
| `postponeSignalSafePollRetries` | `:16255-16275` | 21 | (a) |
| `completeEpollSignalOutcome` | `:19846-19862` | 17 | (a) |
| `wakeBlockedAdvisoryLockRetries` | `:16173-16188` | 16 | (a) |
| `#cancelHostOwnedKernelWait` | `:14997-15009` | 13 | (a) |
| `#cancelLiveTaskKernelWait` | `:15020-15048` | 29 | (a) |
| `anyPendingRetryNeedsSignalSafeWake` | `:16224-16232` | 9 | (a) |
| + the three sweeps inside `sendSignalToProcess` | `:26560`,`:26584`,`:26614` | ~80 | (a) |

**≈900 lines classified (a)** — larger than the brief's "~700 signal lines",
and it disappears with the scheduler. The genuine signal *semantics* (class b)
— disposition, masks, queueing, `SIGCHLD` policy, handler invocation — are
**already mostly in Rust**, and what remains in TS is marshalling that belongs
to K6, not K3.

**Answer to the brief's question:** most of the signal surface named is
scheduler routing, and it collapses. Signals do not need a separate migration
item to make K3 complete; they need one to make *signal marshalling* complete,
which is a different, smaller item.

---

## 7. Sequencing — the increment order

The `tmpfs.rs` pattern (`docs/plans/2026-08-28-phase5-vfs-to-rust.md:363-384`)
is **dormant store → mutable → ABI/manifest → syscall wiring (still dormant) →
cutover**. It applies here, but with one addition that no previous K item
needed, because the failure mode here is a **silent hang** rather than a wrong
answer.

### 7.0 — Debt and dead weight (no behavior change)

| step | work | risk |
|---|---|---|
| 0a | Delete the three stale V8 epoll comments (`:3246`, `:12237`, `:19616`) | none |
| 0b | Delete the dead imports `host_futex_wait` and `host_sigsuspend_wait` (zero Rust call sites) + their `HostIO` methods, `WasmHostIO` impls and `kernel.ts` bodies. Snapshot regen, no ABI bump | none |
| 0c | Remove `host_nanosleep`'s two call sites: make `sys_usleep` behave like `sys_nanosleep`; delete `sys_epoll_pwait`'s empty-interest sleep. Then delete `host_nanosleep` too | fixes a live whole-machine stall |
| 0d | Mechanically split `crates/runtime-core/src/syscalls.rs` (47,203 lines) before adding a subsystem to it — census §11.6 already flags this | none, but large diff |

Steps 0a–0c are **~84 → 81 imports and two concepts** for near-zero risk, and
0c fixes a defect. They are worth landing even if K3 stalls.

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
| 7 | **epoll** | `epollInterests` + 14 touchpoints | **gated on D2/D3** (epoll fork/exec inheritance + OFD keying) — see §4.4 |
| 8 | **futex** | `pendingFutexWaits`, `handleFutex` | **gated on the probe in §11.1** |
| 9 | **process wait + signal wait** | `waitingForChild`, `pendingSignalWaits`, `signalWaitDeadlines` | `kernel_wait_child_poll` already computes the answer |
| 10 | **stopped-process parking** | `stoppedPids`, `parkedChannelCompletions`, `deferredStoppedChannels`, `pendingResumePids`, `resumePreparedSignals` | **not** `deferredProcessWorkerStarts` — see §10.2 |
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
`handleThreadCancel` (§6.3). The Rust design must make `WaitKind` an enum
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

Six of these set `usePolling: true` (§11.2). That test dependency is the only
thing keeping the `MessageChannel` poller alive.

---

## 10. Challenging the brief's framing

### 10.1 The line count is low

The census's 4,532 is a floor. A name-based sweep of class methods matching the
scheduler vocabulary, with brace-matched spans, returns **114 methods / 5,828
lines** — over-inclusive by perhaps 15% (it catches `startPcmWakeObserver`,
some TCP pipe helpers). A defensible band is **4,800–5,500 lines of
`kernel-worker.ts`**, plus:

- ~900 lines of signal routing that is really scheduler routing (§6.4);
- ~29,700 lines of `host/test` (§9);
- the ~200 lines of `blocked_retry.rs` token scaffolding that is deleted rather
  than moved (§3.4).

So K3 is **larger than billed**, and the largest single component of it is test
migration, which is real work the plan already says must be sized rather than
discovered (census §9).

### 10.2 "Keystone" is right about signals and IPC, wrong about two pieces

**Right:** signals collapse into it (§6 — ~900 lines of class-(a) routing), and
IPC blocking collapses into it (mqueue / SysV msg / SysV sem already have pinned
targets in `blocked_retry.rs`).

**Wrong on two counts:**

1. **`deferredProcessWorkerStarts` (`:3059`) is K4, not K3.** It holds JS
   `Worker` **constructors** withheld while the authoritative `Process` is
   stopped. The *decision* is kernel state; the *held closure* is a host act
   (ledger §2.2). K3 should move the gating predicate and leave the closure,
   and K4 should absorb the rest. Not splitting this cleanly is how K3 and K4
   collide.
2. **Deleting the epoll mirror requires new POSIX work in Rust**, not
   migration: epoll fd inheritance across fork and exec, which `fork.rs:1631`
   and `:2093` currently discard (§4.4). That is neither K3 nor K7; it is a
   platform gap that K3 exposes. It should be tracked as such.

### 10.3 "Highest risk" — agreed, and here is why it is different in kind

K1, K2, K10 and K13a all fail *loudly*: a wrong byte, a missing export, a
divergent translation. K3's failure mode is a **process that never wakes up**,
in one browser, under one workload, after a delay. That is why §7.2's shadow
mode is not optional overhead — it is the only mechanism that converts this
item's failure mode into the loud kind the rest of the campaign relies on.

---

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

### 11.7 Recorded doubts that need no decision

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

Not examined: `crates/runtime-core/src/pipe.rs` and `socket.rs` internals beyond
their `wakeup::push` sites; the `#createTestAuthority` surface beyond noting that
`handleBlockingRetry` has a test hook in its first five lines; benchmark
harnesses.
