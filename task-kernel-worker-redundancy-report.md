# kernel-worker.ts redundancy + Rust-migration-backlog audit

Worktree: `/Users/brandon/kandelo-abi44-reconcile`
(branch `brandonpayton/rust-first-abi44-reconcile`, READ-ONLY analysis)
Target: `host/src/kernel-worker.ts` — 34,876 lines, one class
`CentralizedKernelWorker` (2746→EOF).

## Bottom line

The maintainer's redundancy hypothesis is **largely not borne out**: there is
**almost no dead-redundant "moved-to-Rust" TypeScript** in this file. The three
migrations named in the brief did not leave a dead TS twin behind here:

- **The generic descriptor / syscall-marshalling path is NOT dead.** The
  opaque-record transport (`#handleRecordSyscall`, blind byte-copy to Rust, no
  TS decode) is **additive**: the guest (`libc/glue/channel_syscall.c`,
  `__marshal_channel_record`) only builds a record for non-RAW syscalls it can
  marshal, and **falls back to raw args** (`rlen < 0`) for any shape it can't,
  plus keeps all scalar-only and RAW syscalls on the raw path. The big generic
  descriptor+scratch machinery inside `#handleSyscallInner` (11894–14173) is the
  live primary/fallback path and is reached on every raw/fallback syscall.
- **Rootfs `/` is delegated, not duplicated.** All `/`-authority code calls the
  Rust `kernel_rootfs_*` exports; the "keep host-served `/`" lines (5089, 5112)
  are dead-comment defensive early-returns for a *kernel that predates the
  exports* — not reachable against the ABI-44 kernel, which has them.
- **Fork/exec already delegate authority to Rust** (`kernel_fork_process`,
  `kernel_exec_commit`, `kernel_spawn_*`); the surrounding TS is the host fork
  *mechanism* (COW capture/replay, worker spawn), which Wasm cannot do itself.

Genuinely dead code (category a) totals only ~50 lines: a few uncalled public
wrapper methods. **The real story is category (b):** ~10,000–11,000 lines of
this file are a host-resident kernel **blocking-wait scheduler + readiness/retry
state + network/IPC/mmap state machines** that hold kernel state/logic the Rust
kernel should own. A large fraction of that is currently host-side because of
**genuine Wasm-platform boundaries** (the single-threaded kernel worker cannot
itself block; separate Wasm memories cannot share pages; a Wasm instance cannot
fork itself) — so migrating it means the *logic/state* moves into Rust while a
thin (c) wake/timer/copy primitive stays. It is still migration backlog, not a
resting state.

## (a) DEAD-REDUNDANT — delete now (superseded + proven unreachable)

Small. The bundled `host/dist/*` hits for these are compiled copies, not
callers.

| Section / method | Lines | ~bytes | Superseded by | Unreachability evidence |
|---|---|---|---|---|
| `rollbackChildHostRegistration` public wrapper (9364–9376) | 13 | ~450 | `#rollbackChildHostRegistrationWithinKernelEntry` (the scoped variant is the only one ever called: 22076, 23109, 23143, 23228) | grep of `host/ web-libs/ apps/` shows zero calls to the non-`WithinKernelEntry` name; only its own body references the scoped variant |
| `terminateForKernelProtocolFailure` public wrapper (11787–11804) | 18 | ~650 | `#terminateForKernelProtocolFailureWithinKernelEntry` (all live call sites use the scoped variant: 11262, 22091, 22282, 23131, 23171, 23243, 24607, 24666, 24731) | zero callers of the public wrapper anywhere in src/test |
| `checkedKernelWirePointer` (7137–7156) | ~20 | ~700 | (no replacement; simply unused) | defined once, never called in `host/src`, `host/test`, `web-libs`, `apps` |

Total category (a): **~50 lines**. Not the multi-thousand-line reduction the
hypothesis expected. (Note: the large `createTestAuthority` (3542–4990, 1448
lines) and the many `*ForTest` seams are test-only, not dead — they are invoked
from `host/test`. They are a separate "test-surface" reduction question, not
dead-redundant runtime code.)

## (b) MUST-MIGRATE BACKLOG — kernel state/logic still in TS (the centerpiece)

Every row below holds kernel state or implements kernel logic and should end up
in `crates/kernel`. "Kernel counterpart" = a Rust export already exists (reached
via `kernel_handle_channel`'s internal by-number dispatch, so it has 0 direct
host call sites — that is expected, not evidence of absence). Sizes are approx
lines of the owning methods; the backing state is the instance `Map`/`Set`
fields cited.

| # | Subsystem | TS location (methods / line ranges) | ~lines | State it holds (fields) | Rust counterpart today | What Rust must own (and the (c) primitive that stays) |
|---|---|---|---|---|---|---|
| B1 | **Blocking-wait / retry scheduler** | `handleBlockingRetry` 17772–18525, `replayGenericBlockingRetry` 17438–17600, `retrySyscall` 18526, `handleSleepDelay` 18583, + ~24 helpers | ~1,900 | `blockingRetrySnapshots` (3105), `blockingRetryWakeTargets` (3114), `pendingSleeps` (2988), `signalWaitDeadlines` (3015), `pendingSignalWaits` (3003) | partial: kernel returns EAGAIN; `kernel_blocking_retry_token/release`, `kernel_drain_wakeup_events` | The **when-to-retry / wait-queue / deadline** logic is the kernel scheduler. Rust owns the wait-queue + parks tasks; host keeps only a `setTimeout`/`Atomics.waitAsync` wake primitive (irreducible: the kernel worker cannot block on itself). |
| B2 | **select / pselect6 / poll / epoll** | `handleSelect` 19230, `handlePselect6` 19454, `handleEpollCreate` 19664, `handleEpollCtl` 19739, `handleEpollPwait` 19908, `runSelectKernelAttempt` | ~1,080 | `pendingSelectRetries` (3130), `pendingPollRetries` (3079), `epollInterests` (3261 — the whole epoll interest list mirrored in TS) | yes: `kernel_select/pselect/poll/ppoll/epoll_create/epoll_ctl/epoll_pwait` all exist; readiness decision is already in Rust (via `runSelectKernelAttempt`→`kernel_handle_channel`) | Rust already decides readiness. Migrate the **epoll interest set** and the wait/timeout orchestration into the kernel wait-queue (B1). Boundary note: `epoll_pwait` is host-intercepted partly for a documented V8 SAB-Wasm crash (12275) — that is a real browser boundary for the *wake*, not for the interest-set state. |
| B3 | **futex** | `handleFutex` 26083–26325 (+1) | ~285 | `pendingFutexWaits` (3179), `pendingCancels` (3199) | yes: `kernel_futex` exists | Futex hashing/requeue/wake-count is kernel logic; the wait-queue moves to Rust (B1). Primitive kept: `Atomics.waitAsync` on process memory (futex addresses are in *process* memory, not kernel memory — the reason for the intercept, 12155). |
| B4 | **fcntl/flock advisory locks** | `handleFcntlLock` 18742, `handleFlockConflict` 17121 | ~320 | `pendingAdvisoryLockRetries` (3123) | yes: `kernel_fcntl_lock`, `kernel_flock` (lock table already in Rust) | Only the **blocking-wait-for-lock** retry remains in TS; fold into B1. |
| B5 | **Socket / TCP / UDP connection state machine** | `handleSendmsg` 21314, `handleRecvmsg` 21620, `handlePendingInetConnect` 16976, `handleIncomingTcpConnection` 32532, `handleIncomingVirtualTcpConnection` 32896, `startNodeTcpConnectionPump` 32681, `startIncomingVirtualTcpConnectionPump` 32972, `handleIoctlIfconf` 20189, ~34 more | ~2,800 | `tcpListeners` (3020), `tcpListenerTargets` (3024), `tcpListenerRRIndex` (3025), `tcpVirtualListenerKeys` (3027), `udpBindings` (3029), `tcpConnections` (3214), `socketTimeoutTimers` (3174) | partial: `kernel_inject_connection`, `kernel_inject_datagram`, `kernel_pick_tcp_listener_target`, `kernel_find_listener_fd_by_accept_wake`, `kernel_get_socket_recv_pipe`; core socket ops (`kernel_socket/bind/listen/accept/connect/send/recv/...`) exist | The **listener registry, accept round-robin, connection/handshake state, socket timeout tracking** are kernel network state → Rust. `sendmsg/recvmsg` msghdr decomposition should move to the Rust record path. (c) primitive that stays: the raw host transport byte send/recv/connect (WebSocket/Node net / WebRTC) and its async pump. |
| B6 | **Pipe/FIFO blocking readers/writers** | `wakeBlockedReaders` 32415, `wakeBlockedWriters` 32431, ~19 helpers | ~405 | `pendingPipeReaders` (3149), `pendingPipeWriters` (3161) | yes: pipe buffers in Rust (`kernel_pipe_read/write`, `kernel_pipe_close_*`, `kernel_pipe_has_readers`) | Buffers already in Rust. Only the **blocked-reader/writer wait queues** remain → fold into B1. |
| B7 | **Process lifecycle: wait/zombie/reap, job-control stop/cont, exec-handoff** | `handleWaitpid` 25304, `handleWaitid` 25925, `resumeStoppedProcess` 14681, `reapKilledProcessesAfterSyscall` 25156, `handleProcessTerminated` 24967, exec-handoff cluster 9198–9880 | ~2,500 (of the 5,879 proc bucket) | `waitingForChild` (3035), `stoppedPids` (3050), `pendingResumePids` (3056), `parkedChannelCompletions` (3058), `deferredStoppedChannels` (3070), `resumePreparedSignals` (3068), `hostReaped` (25298), `execHandoffPids` (2815), `committedExecTransitions` (2817), `committedExecSecureExec` (2824) | partial: `kernel_wait_child_poll`, `kernel_reap_exited_child`, `kernel_get_process_state/exit_status/exit_signal`, `kernel_has_sa_nocldwait/nocldstop` | The **wait4/waitid blocking queue, SIGSTOP/SIGCONT job-control state, zombie/reap orchestration, and exec-transition commit state** are kernel scheduler/process-table logic → Rust. (c) primitive that stays: worker spawn/terminate and the pid→worker/memory registration map (`processes`, `channelTids`, `threadForkContexts`). |
| B8 | **SysV IPC (msg/sem/shm attach)** | `handleSysvMessage` 33492, `handleIpcControl` 33766, `handleSemctl` 33925, `handleIpcShmat` 34198, `handleIpcShmdt` 34414 | ~1,270 | `shmMappings` (3269), `shmSegmentVersions` (3271) | partial: `kernel_ipc_shmat*`, `kernel_ipc_shmdt*`, `kernel_ipc_shm_read/write_chunk`, `kernel_semctl_array_bytes`, `kernel_msqid_ds_bytes` | The **shm attach map + segment versioning** and the wasm32/wasm64 msgbuf/semun width translation → Rust (record path). (c) primitive: cross-Wasm-memory shm byte copy (separate memories can't share pages). |
| B9 | **Shared-mmap / MAP_SHARED coherence bookkeeping** | `prepareSharedMmapFromFile` 27202, `handleSharedMappingsAfterFileSyscall` 28676, `flushSharedMappingsBeforeFileSyscall` 28447, `prepareSharedMappingInheritance` 29252, `inheritPreparedSharedMappingsWithinKernelEntry` 30297, ~65 more | ~3,225 | `sharedMappings` (3224), `fdWritebackFdRefs` (3232), `anonymousSharedBackings` (3238), `sharedMmapBackings` (3244), `sharedMemoryReleasePids` (3246), `sharedMappingInheritancePids` (3254), `sharedMmapFdCache` (3256) | partial: `kernel_mmap/munmap/mremap/mprotect`, `kernel_fd_supports_mmap_writeback`, `kernel_reserve_host_region*` | **Hard boundary case.** The per-page dirty-merge byte copy across separate Wasm memories is an irreducible (c) primitive (documented no-shared-anon-memory gap). But the **mapping tables / writeback-fd refcounts / inheritance sets** are kernel VM bookkeeping that should be Rust-owned; the host would keep only the copy primitive. This is the largest and least cleanly migratable bucket — split it deliberately. |
| B10 | **Timers / alarm / posix timers** | `prepareProcessHostTimerCleanup*` 26400±, ~8 helpers | ~285 | `alarmTimers` (2977), `posixTimers` (2979) | yes: `kernel_alarm`, `kernel_setitimer/getitimer`, `kernel_timer_create/settime/...`, `kernel_take_process_timer_cleanup`, `kernel_posix_timer_fire` | Timer expiry→signal mapping is already largely in Rust; TS holds the live `setTimeout` handles + fires them. Rust owns the timer table; (c) primitive kept: one host timer/clock source. |
| B11 | **Signal delivery orchestration** | `sendSignalToProcess` 26636, `dequeueSignalForDelivery` 27… , `signalProcess` 26547, ~18 helpers | ~800 | (uses B1's `pendingSignalWaits`/`signalWaitDeadlines`) | yes: `kernel_dequeue_signal`, `kernel_sigaction`, `kernel_kill*`, `kernel_mark_process_signaled`, `kernel_pick_signal_target_tid`, `kernel_generate_host_signal`, `kernel_is_signal_blocked` | Dispositions/masks/pending-queues are already in Rust. The remaining TS is **delivery-into-channel + wake of a blocked target + sigtimedwait deadlines** — the wake half folds into B1; the channel write is (c) transport. |

Approx category (b): **~10,000–11,000 lines** of state/logic, of which the
cleanly-migratable core (B1–B8, B10–B11 minus their thin primitives) is on the
order of **~7,000–8,000 lines**, and B9 (~3,200) is a mixed boundary bucket to
split.

Coupled files with the same character (not separately sized here, flagged for
the same backlog): `host/src/browser-kernel-worker-entry.ts` (175 KB) and
`host/src/browser-kernel-host.ts` (63 KB) wire the host adapters and VFS/lazy
archive providers that feed the kernel; the fork-module `fork-*.ts` cluster
(~1.0 MB across ~40 files) is the host-native fork capture/replay engine — that
one is (c) by the Wasm-can't-self-fork boundary, per the campaign's own
"host-native stays" decision, not (b).

## (c) LEGITIMATE FLOOR — irreducible wasm-boundary primitives + transport

These hold no migratable kernel state; they are the true floor.

- **Channel transport plumbing / kernel-entry gate**: `handleSyscall`,
  `#handleSyscallWithinKernelEntry`, `#runKernelEntryOperation`, the
  `kernelEntryIntrinsic*` frozen-intrinsic hardening block (351–2547, ~2,200
  lines), `activeChannels`/`activeChannelRequests`/`retiredChannelListeners`
  registries, scratch-transfer lease machinery. This is the guest↔kernel
  transport itself.
- **Generic descriptor marshalling** (`#handleSyscallInner` scratch-planning,
  11894–14173): live primary/fallback transport for raw syscalls — not kernel
  *state*, it is the ABI marshalling boundary. (Reducible only as the guest
  opaque-record coverage grows and RAW/fallback shapes shrink — a transport
  simplification, not a state migration.)
- **Raw device/host I/O primitives**: framebuffer/KMS (`kmsCanvases`,
  `tickVblank`, OffscreenCanvas), audio PCM transport, PTY byte I/O
  (`kernel_pty_*` + `ptyOutputCallbacks`), stdin byte feed, host timer/clock
  reads, worker spawn/terminate.
- **Cross-Wasm-memory copy primitive** (the byte-copy half of B9) and
  **Atomics.waitAsync / setTimeout wake** (the primitive half of B1/B3): forced
  by documented platform boundaries (no shared anon memory across Wasm
  instances; the kernel worker must not block).

## Method

- Traced `handleSyscall` (11079) → `#handleSyscallInner` (11894): a Tier-A
  intercept ladder (fork/exec/clone/exit/wait/futex/epoll/select/sysv/…, all
  handled in TS for blocking or nested-pointer reasons) sits above the
  opaque-record fast-path (12072) and the generic descriptor path.
- Confirmed the record path (`#handleRecordSyscall` 14174) is a **blind
  transport with no TS decode**, and that the guest still falls back to raw args
  (`libc/glue/channel_syscall.c` 1766–1795) — so the generic path is live, not
  dead.
- Cross-referenced all `kernel_*` exports (`crates/kernel/src/wasm_api.rs`,
  14,899 lines, one module) against the TS handlers: the kernel already has a
  by-number handler for essentially every syscall (select/poll/epoll/futex/
  locks/sockets/pipes/timers/signals/ipc/mmap), which is why the intercept
  handlers hold only the *wait/state* half.
- Proved (a) unreachability by grepping `host/ web-libs/ apps/` for callers
  (excluding the `dist/` bundle) and by the internal-only-caller check.
- Sized subsystems by bucketing every method in the class by name against its
  line span.

## Note for the maintainer

The dominant reason this file is enormous is **not** dead moved-to-Rust code; it
is that the host runs a **kernel blocking/wait scheduler and several kernel
state machines in TypeScript**. Finishing "whole kernel in Rust" here is a real
project: fold B1–B4/B6/B7(wait)/B11(wake) into a single Rust-owned wait-queue
that parks tasks and asks the host only to wake it (the irreducible primitive),
move the network/IPC/mmap tables (B5/B8/B9) into Rust leaving only the raw I/O
and cross-memory copy primitives, and let epoll/futex keep their documented
browser/process-memory boundary for the *wake* only. Deleting category (a) now
is safe but recovers only ~50 lines.
