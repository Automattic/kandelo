# Guest waits into Rust — kernel-owned parking and wake decisions

> Plan, 2026-09-27. Branch `lane-waits-rust`, cut from `af430c1a6`.
> Line numbers are against that commit. They drift; re-resolve them before
> quoting.
>
> Companion to `2026-09-09-k3-blocking-scheduler-grounding.md` (the K3
> grounding, which this plan builds on and does not repeat), and to
> `crates/runtime-core/src/wait_queue.rs`, whose module docs state the
> direction this plan executes.

## Status

- **Step 1 (park contract + futex): landed** on `lane-waits-rust`. The commit
  message carries its validation record.
- **Step 2a (sleeps): landed.** `nanosleep`, `clock_nanosleep` and `usleep`
  park in the kernel with a deadline and write `rem` on a signal. Both
  timespecs travel as raw process addresses (declared in the channel scalar
  contract), because `rem` is written when the decision is drained, after
  any per-call staging is gone. `alarm`, `setitimer` and POSIX timers (the
  rest of step 2) are step 2b.
- Steps 2b-6: not started.

Two operational facts learned in step 1 that the next step should plan for:

- A standalone `cargo xtask bootstrap kernel` republishes the source-only
  projection authority for the kernel alone, after which every other package
  in the tier is refused ("not declared by the source-only projection
  authority"). After a kernel-only rebuild, run `./run.sh setup` before any
  suite that resolves packages. The same holds after editing `host/src`: some
  packages (WordPress among them) key their identity on it.
- On `af430c1a6`, before this lane, the git HTTP clone tests already fail:
  `prepareProcessForExec` calls `kernel_wait_retire_process` outside a kernel
  entry while a "syscall retry" ingress is queued, and the entry gate refuses
  it. That is a pre-existing host defect, not caused here; step 2 touches the
  same retirement path and should fix it.

## 1. Why this work exists

Two reasons, one urgent and one structural.

**The urgent reason.** On 2026-09-27 the maintainer ruled that the LAMP image
(it contains MariaDB) cannot be built reproducibly without a *serialized,
deterministic build-time scheduler*: a mode where the machine runs one guest
thread at a time, and where time only advances when every thread is blocked.
Such a scheduler needs one thing above all: **a single place that knows every
blocked thread, why it is blocked, and when it could wake**. Today that place
does not exist. Nearly every guest wait lives in host TypeScript
(`host/src/kernel-worker.ts`), spread across roughly a dozen containers, and
many of them are resumed by real-time JavaScript timers (10 ms, 50 ms and
500 ms polls among them). A scheduler cannot serialize a machine whose waits
are decided by `setTimeout`.

**The structural reason.** `CLAUDE.md` makes kernel control flow Rust-first:
TypeScript shrinks toward an irreducible host floor. "Should this thread wake
now, and with what result?" is kernel control flow. Moving it into Rust also
gives one wait implementation shared by the Node host, the browser host and
the native host (`crates/host-native`), instead of a TypeScript implementation
that the native host does not share at all (§3.4 shows the consequence: native
`futex` never actually waits).

This lane is the prerequisite for the scheduler. It does not build the
scheduler; §8 describes the hook the scheduler will plug into.

## 2. Vocabulary

- **Channel**: the per-thread shared-memory mailbox through which a guest
  thread submits a syscall and then parks in `memory.atomic.wait32` on the
  channel's status word until the host publishes a result
  (`libc/glue/channel_syscall.c:1640-1650`). The guest has no opinion about
  *who* decided when to publish; that is why this lane needs no ABI bump
  (§6).
- **Park**: a syscall has been received but its result is withheld until
  some future event.
- **Host-owned park**: TypeScript holds the parked channel in a `Map` and
  decides when to retry or complete it. This is today's model.
- **Kernel-owned park**: the Rust kernel records the parked task in its wait
  queue and later *decides* the result. The host only publishes what the
  kernel decided. This is the target.
- **Sleeper**: one entry in the Rust wait queue (`wait_queue::Sleeper`).

## 3. Census: every host-side wait today

Legend for the "timer" column: *deadline* means a timer armed for the caller's
own timeout; *poll N ms* means a repeating safety/retry timer that exists
because the host does not know precisely when the wait could end.

### 3.1 Parking containers (`host/src/kernel-worker.ts`)

| # | Wait (syscalls) | Container, decl | Parked by | What wakes it | Timer |
|---|---|---|---|---|---|
| 1 | futex `FUTEX_WAIT[_BITSET]` | `pendingFutexWaits` `:3249` | `handleFutex` `:24748` (intercepts `SYS_FUTEX` at `:12029`, before the kernel) | `Atomics.waitAsync` on the *guest's* futex word, resolved by `Atomics.notify` from `FUTEX_WAKE` (`:24987`), clear-child-tid (`:25154`), cancel (`:16506`), signal (`:25306`) | deadline, chunked (`:24968`) |
| 1b | futex (retry path) | `handleBlockingRetry` arm `:17585-17660` | EAGAIN retry of `SYS_FUTEX` | same | `setImmediate` |
| 2 | `nanosleep`, `clock_nanosleep`, `usleep` | `pendingSleeps` `:3055` | `handleSleepDelay` `:18371`, entered from the *success* path | the timer, or a caught signal (`sendSignalToProcess`), or cancel | deadline (`:18403`) |
| 3 | `rt_sigtimedwait` | `pendingSignalWaits` `:3070` | `handleBlockingRetry` `:17900-18020` | `wakePendingSignalWaits` `:25186` on signal generation | deadline; **poll 500 ms** when the timeout is NULL |
| 4 | `sigsuspend`, `pause` | `pendingPollRetries` (default arm) | `handleBlockingRetry` default arm `:18285-18305` (kernel returns EAGAIN from `sys_sigsuspend` `:9590`) | the poll timer re-runs the syscall until a signal is deliverable | **poll 10 ms** |
| 5 | `wait4`, `waitid` | `waitingForChild` `:3097` | `handleWaitpid` `:23969`, `handleWaitid` `:24590` | child exit/stop/continue routed by the host; signals via `interruptWaitingChildForSignal` | none (event-driven) |
| 6 | `poll`, `ppoll` | `pendingPollRetries` `:3141` | `handleBlockingRetry` `:17700-17850` | pipe/accept wake events (targeted) or the broad sweep `wakeAllBlockedRetries` | deadline for `nfds==0`; else **poll 10 ms** (targeted) / **50 ms** (untargeted) (`:17835`) |
| 7 | `select`, `pselect6` | `pendingSelectRetries` `:3198` | `handleSelect` `:19018`, `handlePselect6` `:19258` | broad sweep | deadline; **poll 50 ms** when infinite (`:19223`) |
| 8 | `epoll_wait`, `epoll_pwait` | `pendingPollRetries` | `handleEpollPwait` `:19518` | targeted via `kernel_epoll_wake_indices`, or broad sweep | **poll 10 ms** (`:19701`) |
| 9 | blocking `read`-like on pipes/sockets | `pendingPipeReaders` `:3219` | `handleBlockingRetry` read arm | `WAKE_READABLE` event for the pipe index | none, unless `SO_RCVTIMEO` (row 12) |
| 10 | blocking `write`-like on pipes/sockets | `pendingPipeWriters` `:3231` | `handleBlockingRetry` write arm | `WAKE_WRITABLE` event | none, unless `SO_SNDTIMEO` |
| 11 | `accept`, `accept4`, other blocking I/O with no pipe token | `pendingPollRetries` | `handleBlockingRetry` accept arm `:18258` / default arm `:18285` | accept wake event, broad sweep | **poll 10 ms** (`:18267`, `:18299`) |
| 12 | `SO_RCVTIMEO`/`SO_SNDTIMEO` expiry | `socketTimeoutTimers` `:3244` | `handleBlockingRetry` `:18110` | the timer | deadline |
| 13 | `fcntl(F_SETLKW)`, blocking `flock` | `pendingAdvisoryLockRetries` `:3191` | `parkAdvisoryLockRetry` `:16880` | `WAKE_ADVISORY_LOCK` (broad) | **poll 10 ms** (`:16912`) |
| 14 | signal-safe `ppoll`/`pselect6` deferral | same as 6/7 | `scheduleWakeBlockedRetriesDeferred` `:15962`, `postponeSignalSafe*` `:15981`, `:16004` | a fixed grace period after a pipe event | **delay 50 ms** (`SIGNAL_SAFE_POLL_WAKE_DELAY_MS`, `:924`) |
| 15 | broad retry sweep | `wakeScheduled` | `scheduleWakeBlockedRetries` `:16036` | any readiness event | `setImmediate` |
| 16 | stopped-process publication | `parkedChannelCompletions`, `deferredStoppedChannels`, `stoppedPids` | `publishOrParkChannelCompletion` | `SIGCONT` via `resumeStoppedProcess` | none |
| 17 | worker launch while stopped | `deferredProcessWorkerStarts` | `startProcessWorkerWhenRunnable` | `SIGCONT` | none |
| 18 | `alarm`, `setitimer` | `alarmTimers` `:3043` | `host_set_alarm` callback `:3478` | the timer → `kernel_generate_host_signal` | deadline |
| 19 | POSIX timers | `posixTimers` `:3045` | `host_set_posix_timer` callback `:3572` | the timer → `firePosixTimer` | deadline + `setInterval` |
| 20 | pthread cancellation | `pendingCancels` `:3269` | `handleThreadCancel` `:16421` | walks rows 1-13 in a fixed order | none |

Rows 16 and 17 are job-control publication, not guest waits in the scheduler
sense; they are listed because the scheduler must see them. Rows 18 and 19 are
timer *sources*, not waits: they generate signals.

Not guest waits, and out of scope: the channel listener
(`listenOnChannel` `:10683`, `Atomics.waitAsync` on each channel status word —
this is floor act F1 in the K3 grounding), PCM drain observers (`:30122`,
`:30162`), and the HTTP/TCP bridge pumps (`:30994`, `:31194`, `:31485`), which
move bytes between host sockets and kernel pipes.

### 3.2 Kernel-side state that already exists

- `crates/runtime-core/src/wait_queue.rs`: the queue (sleepers, typed
  `WakeSource`, a monotonic deadline heap, execution-generation identity,
  counters). Live today only as the *deadline authority* for
  poll/select/epoll/sigtimedwait: the host opens a deadline-only record with
  `kernel_wait_deadline_open` and asks `kernel_wait_deadline_remaining_ns`.
  Nothing parks in it.
- `crates/runtime-core/src/wait_shadow.rs`: a differential comparator, not
  wired.
- `wakeup.rs`: the kernel→host readiness event stream (`kernel_drain_wakeup_events`).
- `fork_lifecycle.rs`: already a kernel-decided completion for a parked
  channel — `KIND_PARENT_COMPLETE` completes a parent parked in `fork`. This
  is the precedent this plan generalizes.

### 3.3 How each wait's result is decided today

For rows 2-15 the kernel computes *readiness* and returns `EAGAIN`; the host
decides *when to ask again*. For row 1 the kernel is bypassed entirely:
`sys_futex` returns `EAGAIN` for every `FUTEX_WAIT` without comparing the
futex word (`crates/runtime-core/src/syscalls.rs:16428`), and on Node and the
browser the syscall never reaches it.

### 3.4 The native host (`crates/host-native`)

The native pump (`run_pump`, `guest.rs:8625`) re-dispatches parked
`poll`/`read`/`wait4` every iteration and sleeps 1 ms when idle
(`guest.rs:9266`). It has no TypeScript and no timers; its "wait
implementation" is re-running the syscall.

For futex this is a real defect, not a stylistic difference: `sys_futex`'s
`FUTEX_WAIT` returns `EAGAIN` without comparing, `futex` is not in
`syscall_can_block` (`guest.rs:10867`), so the pump completes the wait
immediately with `EAGAIN` — which musl reads as "the value changed" and loops.
**Every native futex wait is a busy spin through the kernel.** It works only
because the spin eventually observes the change. Moving the futex wait into
the kernel fixes native as a side effect, which is the parity argument in
miniature.

## 4. Target design

### 4.1 The shape

```
guest thread ──syscall──▶ host (any) ──kernel_handle_channel──▶ kernel
                                                                  │
                             ┌── result now ◀─────────────────────┤
                             │                                    │ parks: records a Sleeper,
                             │                                    │ returns KERNEL_WAIT_PARKED
host publishes result ◀──────┘                                    │
                                                                  ▼
            later, inside ANY kernel entry: a wake, a signal, a thread exit,
            a cancellation, or a deadline decides the parked task's result
            and queues a completion record { generation, pid, tid, value, flags }
                                                                  │
host drains completion records ◀── TYPE_WAIT_COMPLETE wake event ─┘
host publishes each result into the named channel (the floor act F2)
host arms ONE timer: "re-enter the kernel in kernel_wait_next_timeout_ns()"
```

The host keeps exactly three acts, the three irreducible ones the K3
grounding named (§5.4 there): notice a request (F1), publish a completion and
notify the guest (F2), and re-enter the kernel at a deadline (F3). It stops
making any *decision*: it never compares a futex word, never computes a
remaining timeout, never chooses which thread a signal interrupts, and never
polls.

### 4.2 Contract pieces (host ↔ kernel)

1. **`KERNEL_WAIT_PARKED` result.** A syscall the kernel parks returns
   `ret = <park generation>`, `errno = KERNEL_WAIT_PARKED_ERRNO` (65536).
   The value is above Linux's `MAX_ERRNO` (4095), so it can never collide with
   a real errno, and it never reaches a guest: every host intercepts it before
   publication. The generation is the park's never-reused identity
   (`ChannelGeneration`, invariant 1 in `wait_queue.rs`).

   *Why a result value and not a new export per syscall:* the kernel already
   runs the syscall; a park is one of its outcomes. A separate "should I park?"
   export would reintroduce the host decision this lane removes.

2. **Completion records** (`wait_completion_wire`, 24 bytes:
   `generation u64, pid u32, tid u32, value i32, flags u32`), drained with
   `kernel_drain_wait_completions(out, len, max)`. `value` is the syscall
   result (`>= 0`) or a negated errno. `flags` carries
   `SUPPRESS_RESTART` (a timed wait interrupted by a caught handler must not be
   restarted by `SA_RESTART`, matching Linux) and `CANCELLED` (the wait ended
   because of `pthread_cancel`).

   The host publishes a record only if the channel for `(pid, tid)` still
   holds the *same* park generation. A record for a channel that exec'd,
   exited or was otherwise completed is discarded. This is invariant 1 made
   explicit rather than enforced by object identity in a `Map`.

3. **`TYPE_WAIT_COMPLETE` wake event.** The wake-event type byte is full (all
   eight bits are assigned). It is widened to `u16` and bit 256 means "the
   wait-completion queue has records". This keeps the idle cost at zero extra
   exports per syscall: the host already drains wake events after every
   completion.

   *Rejected:* reusing the fork-lifecycle queue with a new kind. It carries
   exactly the right idea (a kernel-decided completion for a parked task), but
   its fields are named for fork (`child_pid`, `parent_pid`), and overloading
   them would make every future reader decode the wrong names. *Rejected:*
   calling the drain export unconditionally after every syscall — a second
   export call on the hottest path in the system, to learn "nothing" almost
   every time.

4. **`kernel_wait_next_timeout_ns()`** — nanoseconds until the earliest
   kernel-owned deadline, or `-1`. Relative, not absolute: the host then never
   does clock arithmetic in the kernel's clock domain, which is what lets §8's
   virtual clock replace the real one without touching any host.

   *Rejected:* one timer per sleeper (today's model), and a fixed polling
   interval. Both put timing decisions in the host.

5. **Signals.** Every signal generation passes through
   `Process::prepare_signal_generation`. It marks the parked set dirty. The
   next wake-event drain (or completion drain) sweeps parked sleepers: a
   sleeper is interrupted with `EINTR` exactly when a pending, unblocked signal
   *targets its thread* — a thread-directed signal for that TID, or a
   process-directed one for which `pick_thread_for_shared_signal` picks that
   TID. Stopped processes are skipped (they resume on `SIGCONT`, which is
   itself a generation). A process that died is retired, not completed.

   *Why a sweep at drain time and not a call at each generation site:* there
   are many generation sites (kill, tkill, sigqueue, alarm, POSIX timers,
   SIGCHLD, PTY job control, fault delivery). A hook at each is the "seven
   places to remember" failure the K3 grounding called hang risk 8.4. One
   choke point marks dirty; one function decides.

   *Why not wake on generation directly inside `prepare_signal_generation`:*
   generation happens mid-syscall while the process is borrowed mutably; the
   target thread's deliverability (its mask, the pick) is only final once the
   generating syscall finishes.

6. **Cancellation.** The kernel's exact-task cleanup
   (`SYS_THREAD_CANCEL` → `cancel_host_owned_wait_for_live_tid`) also cancels
   a kernel-owned park with `EINTR | CANCELLED`. The host already calls it
   only for a wakeable cancellation point.

7. **Teardown.** Exec and process removal retire the pid's parks silently
   (no completion), and thread exit retires that TID's parks, so no record can
   reach a successor image.

### 4.3 What each wait becomes

| Wait | Kernel owner | Wake decided by |
|---|---|---|
| futex | `sys_futex` compares the word it reads through `host_proc_read_bytes`, parks with `WakeSource::Futex{pid, addr}` | `FUTEX_WAKE[_BITSET]`, `FUTEX_[CMP_]REQUEUE` (a real requeue), clear-child-tid at thread exit, signals, cancel, deadline |
| sleeps | `sys_nanosleep`/`sys_clock_nanosleep`/`sys_usleep` park with a deadline | deadline; signal → `EINTR` + remaining time written through `host_proc_write_bytes` |
| `wait4`/`waitid` | `kernel_wait4`/`waitid` park with `WakeSource::ChildEvent{parent}` | the kernel's own child state transition (it already computes the answer in `kernel_wait_child_poll`), signals |
| `sigsuspend`, `pause`, `sigtimedwait` | park with `WakeSource::Signal{pid,tid}` (+ deadline for `sigtimedwait`) | signal generation sweep, deadline |
| fd readiness (poll/select/epoll, blocking I/O, accept, advisory locks, socket timeouts) | park with the readiness sources the kernel already computes, then **re-execute the syscall inside the kernel** at wake time | the existing `wakeup.rs` push sites, deadline, signals |

The last row is different in kind: its result is not a constant but the
output of re-running the syscall. §5 step 5 covers it.

### 4.4 Invariants that must survive (from `wait_queue.rs`)

1. Execution-generation identity — enforced by the park generation in
   completion records.
2. A wake never redirects to a recycled object — retired generations match
   nothing.
3. The retry target lives on the sleeper (step 5).
4. Deadlines are monotonic — the kernel reads `CLOCK_MONOTONIC` through
   `host_clock_gettime`, never wall time.

## 5. Migration order — independently landable steps

Each step deletes the TypeScript it replaces in the same commit. Progress is
measured in host lines *removed*.

**Step 1 — the park contract + futex.** Adds §4.2 (parked result, completion
queue, `TYPE_WAIT_COMPLETE`, next-timeout export, signal sweep, cancel,
teardown) and moves futex onto it. Deletes `handleFutex`, the `SYS_FUTEX`
intercept, `pendingFutexWaits` and its eight touchpoints, the futex arm of
`handleBlockingRetry`, `interruptPendingFutexForCaughtSignal`, the
clear-child-tid write/notify, and `host_futex_wake` (the kernel no longer
notifies guest memory; nothing parks on a futex word). Native gains the same
completion drain and a real futex wait.

*Why futex first:* it is the one wait with no retry semantics — its result is
a constant (`0`, `-EAGAIN`, `-ETIMEDOUT`, `-EINTR`) — so it proves the whole
contract (park, wake, deadline, signal, cancel, teardown, three hosts) with
the smallest POSIX surface. It is also the MariaDB wait, which is the
scheduler's first customer.

**Step 2 — sleeps and timed waits.** `nanosleep`, `clock_nanosleep`, `usleep`
park in the kernel with a deadline; the remaining-time write on `EINTR` moves
into Rust. Deletes `pendingSleeps`, `handleSleepDelay`,
`#completeSleepWithSignalCheckWithinKernelEntry`, and the sleep arms of
`sendSignalToProcess` and `handleThreadCancel`. `alarm` and POSIX timers fold
into the same deadline heap (a timer expiry is a kernel event that generates a
signal), deleting `alarmTimers`, `posixTimers`, `host_set_alarm` and
`host_set_posix_timer`.

**Step 3 — `wait4`/`waitid`.** Park with `ChildEvent{parent}`; the kernel's
child-state transitions complete them. Deletes `waitingForChild` and the
`interruptWaitingChild*` family.

**Step 4 — signal waits.** `sigsuspend`, `pause`, `rt_sigtimedwait` park with
`Signal{pid,tid}`. Deletes `pendingSignalWaits`, `wakePendingSignalWaits`, the
500 ms NULL-timeout poll, and the 10 ms `sigsuspend` poll.

**Step 5 — fd-readiness waits.** poll/ppoll/select/pselect6/epoll, blocking
read/write/accept/connect/sendmsg/recvmsg/sendfile/splice, mqueue/SysV, advisory
locks, socket timeouts. The kernel parks with the readiness sources it already
computes, holds the pinned `BlockingRetryTarget` on the sleeper (invariant 3),
and re-executes the syscall itself when a source fires. Sub-steps in the K3
order: advisory locks → transfers (read-like, write-like, accept/connect,
msg/splice, IPC) → poll/select → epoll. Deletes `pendingPollRetries`,
`pendingSelectRetries`, `pendingPipeReaders/Writers`,
`pendingAdvisoryLockRetries`, `socketTimeoutTimers`, `blockingRetrySnapshots`,
`blockingRetryWakeTargets`, the broad sweep, **all 10/50 ms polls, and the
50 ms signal-safe grace** (the ordering it papered over becomes structural,
because one serialized kernel sees the pipe write and the following `kill` in
issue order). This step is the largest and carries the real hang risk; it
needs the K3 §7.2 shadow comparison run first.

The re-execution in step 5 needs the syscall's arguments and scratch bytes to
be kernel-owned across the park. That is the "opaque record" transport's job
(Phase 4 in `crates/shared/src/host_raw_syscalls.rs`) and must land with, or
before, step 5.

**Step 6 — remove scaffolding.** The blocking-retry token protocol
(`kernel_blocking_retry_token`/`_release`), the per-fd wake-index exports,
`kernel_wait_deadline_open`/`_remaining_ns`/`_close`, and `pendingCancels`.

## 6. ABI impact

The guest ABI is untouched: guests park on their channel status word and
cannot tell who decided when to publish (`channel_syscall.c:1640-1650`). No
syscall number, struct, errno a guest can observe, or channel layout changes.

The host↔kernel contract changes, and it is ABI surface (kernel exports,
host imports, generated constants, wake-event wire). ABI 44 is unreleased, so
every change here is a content change that regenerates `abi/snapshot.json`
with `bash scripts/check-abi-version.sh update`, with no version bump. Per
step: new exports (`kernel_drain_wait_completions`,
`kernel_wait_next_timeout_ns`), the widened wake-event type, the new
`wait_completion_wire` constants, and removed imports (`host_futex_wake` in
step 1; `host_set_alarm`, `host_set_posix_timer` in step 2).

One semantic change that a guest *can* observe, deliberately: after step 1 a
raw `memory.atomic.notify` on a futex word no longer wakes a thread blocked in
`FUTEX_WAIT`, and `FUTEX_WAKE` no longer wakes a raw `memory.atomic.wait32`.
That is Linux behavior — the futex queue is kernel state, not a property of
the memory word — and no Kandelo libc path mixes the two (verified:
`libc/` and `libc/musl-overlay/` contain no raw wait/notify outside the
channel glue; musl wakes only through `__wake` → `SYS_futex`).

## 7. Node, browser and native parity

- **Node and browser** share `kernel-worker.ts`, so the host half of each step
  is written once. The only per-host behavior is timer clamping: one
  `setTimeout` for the next deadline is subject to the browser's 4 ms nested
  clamp and background throttling (K3 risk 8.8). That is no worse than today's
  per-waiter timers, which are clamped identically.
- **Native** gets the same contract in `run_pump`: a park result moves the
  channel into a `kernel_parked` list (so the pump does not re-dispatch its
  still-`PENDING` request), and every pump iteration drains completion records
  (the drain performs deadline expiry). Native keeps its 1 ms idle sleep, which
  is its existing loop structure and not a wait decision; moving native to
  "sleep until next timeout or event" is a small follow-up once all waits are
  kernel-owned.
- Parity is enforced by construction: the decision is in Rust, and the three
  hosts only transport it.

## 8. The deterministic-scheduler hook (design only — not built here)

The scheduler needs two things from this lane, and gets both:

1. **Virtual time.** Every kernel-owned deadline is compared against a `now`
   the kernel obtains in exactly one function (`wait_park::now_ns`). Today it
   reads `CLOCK_MONOTONIC` via `host_clock_gettime`. The scheduler replaces it
   with a kernel-held virtual clock that advances **only when every live
   thread is parked** — at that moment it jumps to the earliest deadline
   (`next_timeout`), which is exactly "sleep until the kernel says the next
   deadline" with the sleep made instantaneous. Because hosts only ever ask
   for a *relative* timeout, no host changes when the clock becomes virtual.
   `CLOCK_MONOTONIC`/`CLOCK_REALTIME` reads by guests must then come from the
   same virtual clock, or a guest would observe time that the queue does not.
2. **A run token at the publish point.** Every completion now flows through
   one queue that the host drains in order. The scheduler grants a single run
   token: the host publishes (floor act F2) only the completion or new request
   the token names, and the kernel hands the token to the next runnable task
   in a deterministic order (for example lowest `(pid, tid)` first). Before
   step 5, fd-readiness waits still decide in TypeScript, so the scheduler can
   only be complete after step 5.

## 9. Validation per step

Per commit (the brief's hard rules):

- `npx vitest run test/surface-budget.test.ts` in `host/` — read every verdict
  line; lower a ceiling a deletion falls well below, never raise one.
- `cargo test` for `runtime-core`, `kernel`, `shared` (host target), and
  `cargo test -p kandelo-host-native` for native parity.
- `bash scripts/check-abi-version.sh` after `update`.
- Host Vitest: the whole suite, one run per worktree at a time.
- Conformance for the affected syscalls: `scripts/run-sortix-tests.sh --all`,
  `scripts/run-posix-tests.sh` (the pthread/signal/timer areas for steps 1-4),
  `scripts/run-libc-tests.sh` (`pthread_*`, `sem_*`, `sleep` regressions).
- Chromium browser tests (`apps/browser-demos`, `--project=chromium`,
  `--grep-invert @slow`) on a free `KANDELO_PLAYWRIGHT_PORT`.
- Benchmarks, before/after, Node and browser: `benchmarks/run.ts
  --rounds=3` and `--host=browser`, compared with `benchmarks/compare.ts`.
- Each new guard is perturbed until a test fails, then restored.

## 10. Residual risks

- **A lost wakeup is a silent hang** (K3 §8.2). Step 1 keeps no safety-net
  timer for futex, because the futex contract has exactly four wake paths and
  each is tested; a miss would be a missing `FUTEX_WAKE` in the guest, which
  Linux does not paper over either. Step 5 needs the shadow comparator first.
- **A missed drain.** Signal interruption and completions reach the host on
  the next wake-event drain. Every kernel entry that can generate a signal,
  wake a futex, cancel, or exit a thread is followed by a drain today; the
  step 1 commit adds the two that were missing (thread exit, the deadline
  timer). A new entry point that forgets to drain delays — does not lose — a
  completion until the next syscall anywhere in the machine.
- **Re-entrancy** (K3 §8.1, §8.6): publishing a completion runs
  `completeChannel`, which drains again. The completion queue is moved out of
  the kernel before any record is acted on, so a nested drain sees only new
  records.
- **`FUTEX_WAKE_OP`** cannot be atomic with respect to guest user code without
  an atomic read-modify-write on guest memory, which the cross-memory
  primitive does not provide. It keeps today's approximation (wake both words,
  do not modify `uaddr2`); musl never issues it.
- **`FUTEX_WAIT_BITSET` absolute timeouts against `CLOCK_REALTIME`** are
  converted to a monotonic deadline once, at park time; a realtime clock step
  during the wait is not tracked. Linux tracks it. Today's host treated the
  absolute timeout as *relative*, which was worse.
