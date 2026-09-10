//! Kernel-owned queue of sleeping tasks.
//!
//! # Why this exists
//!
//! Today the kernel has no concept of a sleeping task at all. Readiness,
//! would-block classification and the stable retry target are all computed
//! here in Rust, but the *wait itself* lives in the host: seven independent
//! parking mechanisms in `host/src/kernel-worker.ts`, each with its own
//! container, its own `setTimeout`, and its own wake routing. `ProcessState`
//! has no `Blocked` variant; every deadline in the machine is a JavaScript
//! `Date.now()` comparison.
//!
//! That multiplicity -- not the line count of any one handler -- is the cost.
//! Seven mechanisms means seven chances to lose a wakeup, and a lost wakeup
//! is a silent hang with no error message. This module is the single
//! mechanism that replaces them.
//!
//! # Status: DORMANT
//!
//! Nothing calls into this module yet. It is landed ahead of its wiring so
//! that the design can be reviewed and differentially tested against the
//! behaviour of the seven mechanisms it replaces *before* any of them is cut
//! over. See [`crate::wait_shadow`] for that comparison.
//!
//! # The four invariants this queue must reproduce
//!
//! 1. **Execution-generation identity.** Most host containers are keyed on
//!    `ChannelInfo` *object identity* rather than on `(pid, channel_offset)`,
//!    because `exec` may reuse both the pid and the mailbox offset
//!    (`kernel-worker.ts:3086-3090`). A numeric key would let a timer armed
//!    before an `exec` complete a request issued after it. The Rust analogue
//!    is [`ChannelGeneration`]: a monotone, never-reused identity minted per
//!    channel registration and retired on exec or teardown -- the same device
//!    `OfdId` already uses for open file descriptions.
//!
//! 2. **A wake never redirects to a recycled object.** A retired generation
//!    matches nothing. Like a pinned SysV operation observing `IPC_RMID`, the
//!    correct outcome of "the thing you were waiting on is gone" is a
//!    truthful failure, never a silent reattachment to its successor.
//!
//! 3. **The retry target lives on the sleeper.** `BlockingRetryTarget` is
//!    deliberately non-`Clone` so that an exact release consumes it. While a
//!    task sleeps *in the kernel*, the pin can be held directly by its
//!    [`Sleeper`] -- there is no opaque token to hand out and no host-held
//!    key to take back. [`Sleeper::target`] is that home.
//!
//! 4. **A deadline is monotonic.** The host scheduler compares wall-clock
//!    `Date.now()`, so a system clock step can make a sleep return early or
//!    late. This queue takes `now_ns` from `CLOCK_MONOTONIC` and never reads
//!    a clock itself, which keeps it pure and makes the clock source the
//!    caller's explicit, reviewable choice.
//!
//! # What is deliberately *not* here
//!
//! No host import. The three irreducible host acts -- notice a request,
//! publish a completion and notify the guest's channel word, re-enter the
//! kernel at a deadline -- all already exist. [`WaitQueue::next_deadline_ns`]
//! is what lets one host timer for the whole machine replace the per-waiter
//! timers spread across eight containers.

extern crate alloc;

use alloc::collections::{BTreeMap, BTreeSet, BinaryHeap};
use alloc::vec::Vec;
use core::cmp::Reverse;

use wasm_posix_shared::Errno;

use crate::blocked_retry::{BlockingRetryOperation, BlockingRetryTarget};

/// Nanoseconds on `CLOCK_MONOTONIC`.
///
/// Signed because the host boundary marshals `i64`, and because "no deadline"
/// is expressed as [`Option::None`] rather than as a sentinel value.
pub type MonotonicNs = i64;

/// A never-reused identity for one parked task.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub struct WaiterId(pub u64);

/// A never-reused identity for one channel *execution generation*.
///
/// See invariant 1 in the module docs. This is the Rust replacement for
/// keying a host `Map` on a `ChannelInfo` object.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub struct ChannelGeneration(pub u64);

/// What can end a wait, named rather than encoded.
///
/// The existing wake-event wire packs every kind into one `u32 idx` whose
/// meaning depends on the type byte: pipe indices are small, PCM streams
/// start at `0x2000_0000`, accept indices come from a separate counter, pids
/// reuse the same field, and two kinds always send zero. That is a
/// partitioned namespace, not a type. Making it an enum is the point: an
/// unhandled source becomes a compile error instead of a lost wakeup.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum WakeSource {
    /// A pipe became readable or writable. `idx` is the kernel pipe index.
    Pipe(u32),
    /// A listening socket's accept queue changed. `idx` is from
    /// `wakeup::alloc_accept_wake_idx`.
    Accept(u32),
    /// A PCM playback stream changed readiness.
    PcmStream(u32),
    /// Advisory-lock state changed somewhere in the machine.
    ///
    /// Broad today because the host cannot key it. A kernel-owned queue can
    /// narrow this later; it is kept as a distinct variant so that narrowing
    /// is a local change rather than a re-encoding.
    AdvisoryLock,
    /// AF_UNIX datagram send readiness changed somewhere in the machine.
    DatagramWritable,
    /// A child of this parent changed state (exit, stop, continue).
    ChildEvent { parent: u32 },
    /// A signal became deliverable to this task.
    Signal { pid: u32, tid: u32 },
    /// A futex word was woken. `addr` is a guest address.
    Futex { pid: u32, addr: u64 },
    /// A process entered the stopped state.
    ProcessStopped { pid: u32 },
    /// A stopped process was continued.
    ProcessContinued { pid: u32 },
}

impl WakeSource {
    /// Whether this source carries no identity and therefore matches every
    /// waiter registered for its kind.
    ///
    /// Two of the seven wire kinds are broad today. Reporting this explicitly
    /// is what lets a caller count broad wakes and drive the count to zero,
    /// rather than leaving an untargeted sweep as permanent background
    /// behaviour.
    pub fn is_broad(self) -> bool {
        matches!(self, Self::AdvisoryLock | Self::DatagramWritable)
    }
}

/// Why a task is asleep.
///
/// Deliberately `Copy` and `PartialEq`: shadow comparison and tests must be
/// able to describe an expected wait without owning one. The non-`Clone`
/// retry authority lives in [`Sleeper::target`] instead of inside this enum,
/// which is also where invariant 3 says it belongs.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WaitKind {
    /// A data-transfer syscall that returned `EAGAIN` (or, for `connect`,
    /// `EINPROGRESS`/`EALREADY`) and holds a pinned target.
    Transfer { operation: BlockingRetryOperation },
    /// `poll` / `ppoll`.
    Poll,
    /// `select` / `pselect6`.
    Select,
    /// `epoll_wait` / `epoll_pwait`.
    EpollWait,
    /// `nanosleep` / `clock_nanosleep` / `usleep`: a deadline and nothing else.
    Sleep,
    /// `sigtimedwait` with the mask the task is waiting on.
    SigTimedWait { mask: u64 },
    /// `wait4` / `waitid` with the caller's options.
    ChildWait { options: u32 },
    /// `FUTEX_WAIT` / `FUTEX_WAIT_BITSET`.
    Futex,
    /// `fcntl(F_SETLKW)` / blocking `flock`.
    AdvisoryLock,
    /// A completed result withheld from a stopped process until `SIGCONT`.
    StoppedPublication,
}

/// One parked task.
///
/// Not `Clone`: it may own a [`BlockingRetryTarget`], whose whole purpose is
/// that exactly one release consumes it.
pub struct Sleeper {
    pub id: WaiterId,
    pub pid: u32,
    pub tid: u32,
    /// The execution generation that parked. Invariant 1.
    pub channel: ChannelGeneration,
    pub kind: WaitKind,
    /// Every source that may end this wait. Empty means deadline-only.
    pub sources: Vec<WakeSource>,
    /// `CLOCK_MONOTONIC` deadline; `None` means wait forever.
    pub deadline: Option<MonotonicNs>,
    /// The pinned resource authority for a transfer wait. Invariant 3.
    pub target: Option<BlockingRetryTarget>,
    /// Reproduces the host's `needsSignalSafeWake`.
    ///
    /// The host defers waking these by a fixed 50 ms
    /// (`SIGNAL_SAFE_POLL_WAKE_DELAY_MS`) so that a signal-safe poll observes
    /// a `write` before the `raise` that follows it. That delay is a race
    /// papered over with a constant. Recording the property here -- rather
    /// than the delay -- is what lets the ordering become structural when
    /// poll/select cut over.
    pub signal_safe: bool,
}

impl Sleeper {
    /// Whether this sleeper is ended by `source`.
    fn matches(&self, source: WakeSource) -> bool {
        self.sources.iter().any(|s| *s == source)
    }
}

/// A request to park, before an identity has been assigned.
pub struct ParkRequest {
    pub pid: u32,
    pub tid: u32,
    pub channel: ChannelGeneration,
    pub kind: WaitKind,
    pub sources: Vec<WakeSource>,
    pub deadline: Option<MonotonicNs>,
    pub target: Option<BlockingRetryTarget>,
    pub signal_safe: bool,
}

/// Why a sleeper stopped sleeping.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WakeReason {
    /// A readiness source fired.
    Source(WakeSource),
    /// The deadline passed.
    Deadline,
    /// A signal became deliverable, or the task was cancelled.
    Interrupted,
    /// The channel generation was retired (exec, exit, teardown).
    Retired,
}

/// One task that has been taken off the queue, with the reason.
pub struct Wakeup {
    pub id: WaiterId,
    pub pid: u32,
    pub tid: u32,
    pub channel: ChannelGeneration,
    pub kind: WaitKind,
    pub reason: WakeReason,
    /// The pin, handed back to the caller that will re-execute the syscall.
    pub target: Option<BlockingRetryTarget>,
}

/// Counters that make the queue's own health assertable.
///
/// A missed wakeup has no error message, so the only way to see one before a
/// user does is to count the things that stand in for it. `broad_wakes` and
/// `deadline_expiries_with_sources` are the two numbers that must trend to
/// zero as families cut over; a test can assert on them directly.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct WaitQueueStats {
    /// Sleepers parked since construction.
    pub parked: u64,
    /// Sleepers woken by a precisely identified source.
    pub woken_by_source: u64,
    /// Sleepers woken because their deadline passed.
    pub woken_by_deadline: u64,
    /// Sleepers woken by a source carrying no identity.
    ///
    /// Every one of these is a wake the kernel could not target. This is the
    /// measure of how much untargeted sweeping remains.
    pub broad_wakes: u64,
    /// Deadline expiries for sleepers that *had* a readiness source.
    ///
    /// This is the fallback-timer counter. A transfer or poll waiter that
    /// times out having registered a real source either genuinely timed out
    /// or lost a wakeup, and the two are indistinguishable from inside. A
    /// nonzero value under a workload that should never time out is the
    /// signature of a lost wakeup.
    pub deadline_expiries_with_sources: u64,
    /// Sleepers dropped because their execution generation was retired.
    pub retired: u64,
    /// Sleepers cancelled explicitly (thread cancel, signal interrupt).
    pub cancelled: u64,
}

/// The single kernel-owned parking mechanism.
///
/// Ordering is insertion order throughout, matching the host `Map` iteration
/// the seven mechanisms rely on today. A `BTreeMap` keyed on the monotone
/// [`WaiterId`] gives that for free and keeps lookup logarithmic.
pub struct WaitQueue {
    /// Dormant until wiring lands. See the module docs.
    enabled: bool,
    next_waiter: u64,
    next_generation: u64,
    sleepers: BTreeMap<WaiterId, Sleeper>,
    /// Min-heap of deadlines, with lazy deletion.
    ///
    /// A sleeper woken by readiness before its deadline leaves a stale entry
    /// behind. Popping validates against `sleepers`, so a stale entry is a
    /// cheap discard rather than a correctness problem -- and because
    /// `WaiterId` is never reused, a stale entry can never match a later
    /// sleeper.
    deadlines: BinaryHeap<Reverse<(MonotonicNs, WaiterId)>>,
    /// Channel generations that are still live.
    live_channels: BTreeSet<ChannelGeneration>,
    stats: WaitQueueStats,
}

impl Default for WaitQueue {
    fn default() -> Self {
        Self::new()
    }
}

impl WaitQueue {
    pub fn new() -> Self {
        Self {
            enabled: false,
            next_waiter: 1,
            next_generation: 1,
            sleepers: BTreeMap::new(),
            deadlines: BinaryHeap::new(),
            live_channels: BTreeSet::new(),
            stats: WaitQueueStats::default(),
        }
    }

    /// Whether the kernel owns the wait. Dormant by default.
    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// Enable or disable kernel-owned waiting.
    ///
    /// Disabling does not silently discard sleepers: a caller that turns the
    /// queue off while tasks are parked would be dropping wakeups on the
    /// floor, which is the exact failure this module exists to prevent.
    /// [`WaitQueue::len`] is the caller's obligation to check.
    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    pub fn stats(&self) -> WaitQueueStats {
        self.stats
    }

    pub fn len(&self) -> usize {
        self.sleepers.len()
    }

    pub fn is_empty(&self) -> bool {
        self.sleepers.is_empty()
    }

    /// Mint a fresh execution generation for a newly registered channel.
    pub fn open_channel(&mut self) -> ChannelGeneration {
        let generation = ChannelGeneration(self.next_generation);
        self.next_generation = self
            .next_generation
            .checked_add(1)
            .expect("channel generation counter exhausted");
        self.live_channels.insert(generation);
        generation
    }

    pub fn is_channel_live(&self, channel: ChannelGeneration) -> bool {
        self.live_channels.contains(&channel)
    }

    /// Park a task.
    ///
    /// Fails with `ESRCH` if the channel generation is not live: a parked
    /// wait on a retired generation could only ever complete a request that
    /// no longer exists.
    pub fn park(&mut self, request: ParkRequest) -> Result<WaiterId, Errno> {
        if !self.live_channels.contains(&request.channel) {
            return Err(Errno::ESRCH);
        }
        if self.next_waiter > i64::MAX as u64 {
            return Err(Errno::EOVERFLOW);
        }
        let id = WaiterId(self.next_waiter);
        self.next_waiter += 1;

        if let Some(deadline) = request.deadline {
            self.deadlines.push(Reverse((deadline, id)));
        }
        self.sleepers.insert(
            id,
            Sleeper {
                id,
                pid: request.pid,
                tid: request.tid,
                channel: request.channel,
                kind: request.kind,
                sources: request.sources,
                deadline: request.deadline,
                target: request.target,
                signal_safe: request.signal_safe,
            },
        );
        self.stats.parked += 1;
        Ok(id)
    }

    /// The earliest deadline in the machine, or `None` if nothing is timed.
    ///
    /// This is what replaces N per-waiter host timers with one. Stale heap
    /// entries are discarded here so the answer is always a real deadline.
    pub fn next_deadline_ns(&mut self) -> Option<MonotonicNs> {
        loop {
            let Reverse((deadline, id)) = *self.deadlines.peek()?;
            match self.sleepers.get(&id) {
                Some(sleeper) if sleeper.deadline == Some(deadline) => return Some(deadline),
                _ => {
                    self.deadlines.pop();
                }
            }
        }
    }

    /// Wake every sleeper registered for `source`.
    ///
    /// `pid_filter` reproduces the host's optional pid narrowing: accepted
    /// TCP pipes omit it because fork children can inherit the same
    /// connection, while unshareable ownership passes it.
    ///
    /// `defer_signal_safe` reproduces the host's signal-safe deferral. It
    /// returns whether any sleeper was held back, so the caller can decide
    /// what to do about it, rather than the queue silently applying a delay.
    ///
    /// # Why this cannot livelock
    ///
    /// The host equivalent iterates a `Map` while the retry it triggers can
    /// re-insert into that same `Map`; because JS `Map` iterators are not
    /// snapshots, a re-inserted entry appears at the tail and is yielded
    /// again, which livelocked wakeup/poll/poll-register inside one tick.
    /// Here the matching set is computed and removed before anything is
    /// returned, so a re-park during the caller's loop mints a new
    /// [`WaiterId`] that this call cannot observe. The fix is structural, not
    /// a snapshot-and-skip convention each call site must remember.
    pub fn wake(
        &mut self,
        source: WakeSource,
        pid_filter: Option<u32>,
        defer_signal_safe: bool,
    ) -> (Vec<Wakeup>, bool) {
        let mut deferred = false;
        let mut selected: Vec<WaiterId> = Vec::new();
        for (id, sleeper) in self.sleepers.iter() {
            if let Some(pid) = pid_filter {
                if sleeper.pid != pid {
                    continue;
                }
            }
            if !sleeper.matches(source) {
                continue;
            }
            if defer_signal_safe && sleeper.signal_safe {
                deferred = true;
                continue;
            }
            selected.push(*id);
        }

        let broad = source.is_broad();
        let mut woken = Vec::with_capacity(selected.len());
        for id in selected {
            if let Some(sleeper) = self.sleepers.remove(&id) {
                if broad {
                    self.stats.broad_wakes += 1;
                } else {
                    self.stats.woken_by_source += 1;
                }
                woken.push(into_wakeup(sleeper, WakeReason::Source(source)));
            }
        }
        (woken, deferred)
    }

    /// Wake every sleeper whose deadline has passed.
    ///
    /// Returned in deadline order, earliest first, so a caller that publishes
    /// completions in order produces the ordering a single-threaded machine
    /// would have produced anyway.
    pub fn expire(&mut self, now_ns: MonotonicNs) -> Vec<Wakeup> {
        let mut expired = Vec::new();
        loop {
            let Some(&Reverse((deadline, id))) = self.deadlines.peek() else {
                break;
            };
            if deadline > now_ns {
                break;
            }
            self.deadlines.pop();
            let stale = match self.sleepers.get(&id) {
                Some(sleeper) => sleeper.deadline != Some(deadline),
                None => true,
            };
            if stale {
                continue;
            }
            let sleeper = self
                .sleepers
                .remove(&id)
                .expect("sleeper present in the check immediately above");
            self.stats.woken_by_deadline += 1;
            if !sleeper.sources.is_empty() {
                self.stats.deadline_expiries_with_sources += 1;
            }
            expired.push(into_wakeup(sleeper, WakeReason::Deadline));
        }
        expired
    }

    /// Cancel one sleeper by identity -- thread cancel, or a caught signal.
    pub fn cancel(&mut self, id: WaiterId) -> Option<Wakeup> {
        let sleeper = self.sleepers.remove(&id)?;
        self.stats.cancelled += 1;
        Some(into_wakeup(sleeper, WakeReason::Interrupted))
    }

    /// Cancel every sleeper belonging to one task.
    ///
    /// This is the whole of what `handleThreadCancel` needs from the
    /// scheduler: one call instead of a pre-enqueue race guard plus a walk of
    /// every container.
    pub fn cancel_task(&mut self, pid: u32, tid: u32) -> Vec<Wakeup> {
        let ids: Vec<WaiterId> = self
            .sleepers
            .iter()
            .filter(|(_, s)| s.pid == pid && s.tid == tid)
            .map(|(id, _)| *id)
            .collect();
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(sleeper) = self.sleepers.remove(&id) {
                self.stats.cancelled += 1;
                out.push(into_wakeup(sleeper, WakeReason::Interrupted));
            }
        }
        out
    }

    /// Retire an execution generation: exec, exit, or channel teardown.
    ///
    /// Invariant 2. After this, no wake can reach a sleeper that belonged to
    /// the old generation, and a fresh [`WaitQueue::open_channel`] for the
    /// same pid and mailbox offset produces an identity that matches nothing
    /// left behind.
    pub fn retire_channel(&mut self, channel: ChannelGeneration) -> Vec<Wakeup> {
        self.live_channels.remove(&channel);
        let ids: Vec<WaiterId> = self
            .sleepers
            .iter()
            .filter(|(_, s)| s.channel == channel)
            .map(|(id, _)| *id)
            .collect();
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(sleeper) = self.sleepers.remove(&id) {
                self.stats.retired += 1;
                out.push(into_wakeup(sleeper, WakeReason::Retired));
            }
        }
        out
    }

    /// Retire every generation belonging to a process.
    pub fn retire_process(&mut self, pid: u32) -> Vec<Wakeup> {
        let channels: Vec<ChannelGeneration> = self
            .sleepers
            .values()
            .filter(|s| s.pid == pid)
            .map(|s| s.channel)
            .collect();
        let mut out = Vec::new();
        for channel in channels {
            out.extend(self.retire_channel(channel));
        }
        out
    }

    /// Every sleeper currently parked, in insertion order. Diagnostics only.
    pub fn iter(&self) -> impl Iterator<Item = &Sleeper> {
        self.sleepers.values()
    }

    /// Look one sleeper up without disturbing it.
    pub fn get(&self, id: WaiterId) -> Option<&Sleeper> {
        self.sleepers.get(&id)
    }
}

fn into_wakeup(sleeper: Sleeper, reason: WakeReason) -> Wakeup {
    Wakeup {
        id: sleeper.id,
        pid: sleeper.pid,
        tid: sleeper.tid,
        channel: sleeper.channel,
        kind: sleeper.kind,
        reason,
        target: sleeper.target,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: MonotonicNs = 1_000_000;

    fn queue_with_channel() -> (WaitQueue, ChannelGeneration) {
        let mut q = WaitQueue::new();
        let c = q.open_channel();
        (q, c)
    }

    fn park(
        q: &mut WaitQueue,
        channel: ChannelGeneration,
        pid: u32,
        kind: WaitKind,
        sources: Vec<WakeSource>,
        deadline: Option<MonotonicNs>,
    ) -> WaiterId {
        q.park(ParkRequest {
            pid,
            tid: pid,
            channel,
            kind,
            sources,
            deadline,
            target: None,
            signal_safe: false,
        })
        .expect("park")
    }

    #[test]
    fn starts_dormant() {
        let q = WaitQueue::new();
        assert!(
            !q.is_enabled(),
            "the queue must be wired to nothing by default"
        );
        assert!(q.is_empty());
    }

    #[test]
    fn a_pipe_wake_reaches_only_its_own_index() {
        let (mut q, c) = queue_with_channel();
        let a = park(&mut q, c, 1, WaitKind::Poll, alloc::vec![WakeSource::Pipe(7)], None);
        let _b = park(&mut q, c, 1, WaitKind::Poll, alloc::vec![WakeSource::Pipe(8)], None);

        let (woken, deferred) = q.wake(WakeSource::Pipe(7), None, false);
        assert!(!deferred);
        assert_eq!(woken.len(), 1);
        assert_eq!(woken[0].id, a);
        assert_eq!(woken[0].reason, WakeReason::Source(WakeSource::Pipe(7)));
        assert_eq!(q.len(), 1, "the unrelated waiter must stay asleep");
        assert_eq!(q.stats().woken_by_source, 1);
        assert_eq!(q.stats().broad_wakes, 0);
    }

    #[test]
    fn a_waiter_on_several_sources_wakes_on_any_of_them() {
        let (mut q, c) = queue_with_channel();
        let id = park(
            &mut q,
            c,
            1,
            WaitKind::Poll,
            alloc::vec![WakeSource::Pipe(3), WakeSource::Accept(9)],
            None,
        );
        let (woken, _) = q.wake(WakeSource::Accept(9), None, false);
        assert_eq!(woken.len(), 1);
        assert_eq!(woken[0].id, id);
    }

    #[test]
    fn pid_filter_narrows_a_wake() {
        let (mut q, c) = queue_with_channel();
        let mine = park(&mut q, c, 4, WaitKind::Poll, alloc::vec![WakeSource::Pipe(1)], None);
        let _theirs = park(&mut q, c, 5, WaitKind::Poll, alloc::vec![WakeSource::Pipe(1)], None);

        let (woken, _) = q.wake(WakeSource::Pipe(1), Some(4), false);
        assert_eq!(woken.len(), 1);
        assert_eq!(woken[0].id, mine);
        assert_eq!(q.len(), 1);
    }

    #[test]
    fn broad_sources_are_counted_separately() {
        let (mut q, c) = queue_with_channel();
        park(
            &mut q,
            c,
            1,
            WaitKind::AdvisoryLock,
            alloc::vec![WakeSource::AdvisoryLock],
            None,
        );
        let (woken, _) = q.wake(WakeSource::AdvisoryLock, None, false);
        assert_eq!(woken.len(), 1);
        assert_eq!(
            q.stats().broad_wakes,
            1,
            "an untargeted wake must be visible in the counters"
        );
        assert_eq!(q.stats().woken_by_source, 0);
    }

    #[test]
    fn signal_safe_waiters_can_be_deferred() {
        let (mut q, c) = queue_with_channel();
        q.park(ParkRequest {
            pid: 1,
            tid: 1,
            channel: c,
            kind: WaitKind::Poll,
            sources: alloc::vec![WakeSource::Pipe(2)],
            deadline: None,
            target: None,
            signal_safe: true,
        })
        .expect("park");

        let (woken, deferred) = q.wake(WakeSource::Pipe(2), None, true);
        assert!(woken.is_empty());
        assert!(deferred, "the caller must learn that a waiter was held back");
        assert_eq!(q.len(), 1);

        let (woken, deferred) = q.wake(WakeSource::Pipe(2), None, false);
        assert_eq!(woken.len(), 1);
        assert!(!deferred);
    }

    #[test]
    fn deadlines_expire_in_order_and_only_when_due() {
        let (mut q, c) = queue_with_channel();
        let late = park(&mut q, c, 1, WaitKind::Sleep, Vec::new(), Some(30 * MS));
        let early = park(&mut q, c, 2, WaitKind::Sleep, Vec::new(), Some(10 * MS));
        let never = park(&mut q, c, 3, WaitKind::Sleep, Vec::new(), None);

        assert_eq!(q.expire(5 * MS).len(), 0, "nothing is due yet");

        let due = q.expire(30 * MS);
        assert_eq!(due.len(), 2);
        assert_eq!(due[0].id, early, "earliest deadline must come out first");
        assert_eq!(due[1].id, late);
        assert!(due.iter().all(|w| w.reason == WakeReason::Deadline));

        assert_eq!(q.len(), 1);
        assert!(q.get(never).is_some(), "an untimed waiter never expires");
        assert_eq!(q.stats().woken_by_deadline, 2);
        assert_eq!(
            q.stats().deadline_expiries_with_sources,
            0,
            "a pure sleep has no readiness source, so it is not a fallback expiry"
        );
    }

    #[test]
    fn a_timeout_on_a_waiter_that_had_a_source_is_counted_as_a_fallback() {
        let (mut q, c) = queue_with_channel();
        park(
            &mut q,
            c,
            1,
            WaitKind::Transfer {
                operation: BlockingRetryOperation::Read,
            },
            alloc::vec![WakeSource::Pipe(1)],
            Some(10 * MS),
        );
        assert_eq!(q.expire(11 * MS).len(), 1);
        assert_eq!(
            q.stats().deadline_expiries_with_sources,
            1,
            "a readiness waiter that timed out is indistinguishable from a lost \
             wakeup and must be counted"
        );
    }

    #[test]
    fn next_deadline_reports_the_earliest_live_deadline() {
        let (mut q, c) = queue_with_channel();
        park(&mut q, c, 1, WaitKind::Sleep, Vec::new(), Some(50 * MS));
        let early = park(
            &mut q,
            c,
            2,
            WaitKind::Poll,
            alloc::vec![WakeSource::Pipe(1)],
            Some(20 * MS),
        );

        assert_eq!(q.next_deadline_ns(), Some(20 * MS));

        // Waking the early waiter by readiness leaves a stale heap entry.
        let (woken, _) = q.wake(WakeSource::Pipe(1), None, false);
        assert_eq!(woken[0].id, early);
        assert_eq!(
            q.next_deadline_ns(),
            Some(50 * MS),
            "a stale heap entry must not arm the host timer early"
        );
    }

    #[test]
    fn next_deadline_is_none_when_nothing_is_timed() {
        let (mut q, c) = queue_with_channel();
        park(&mut q, c, 1, WaitKind::Poll, alloc::vec![WakeSource::Pipe(1)], None);
        assert_eq!(q.next_deadline_ns(), None);
    }

    #[test]
    fn a_retired_generation_matches_nothing() {
        let (mut q, c) = queue_with_channel();
        park(&mut q, c, 1, WaitKind::Poll, alloc::vec![WakeSource::Pipe(1)], None);

        let dropped = q.retire_channel(c);
        assert_eq!(dropped.len(), 1);
        assert_eq!(dropped[0].reason, WakeReason::Retired);
        assert!(q.is_empty());

        let (woken, _) = q.wake(WakeSource::Pipe(1), None, false);
        assert!(woken.is_empty());
    }

    #[test]
    fn exec_reuse_of_pid_and_offset_cannot_complete_the_old_request() {
        // The invariant the host encodes as ChannelInfo object identity: exec
        // may reuse both pid and mailbox offset, so the same pid parking again
        // must be a different identity.
        let (mut q, before) = queue_with_channel();
        park(&mut q, before, 42, WaitKind::Poll, alloc::vec![WakeSource::Pipe(5)], None);

        q.retire_channel(before);
        let after = q.open_channel();
        assert_ne!(before, after, "a generation must never be reused");

        let fresh = park(&mut q, after, 42, WaitKind::Poll, alloc::vec![WakeSource::Pipe(5)], None);
        let (woken, _) = q.wake(WakeSource::Pipe(5), Some(42), false);
        assert_eq!(woken.len(), 1);
        assert_eq!(
            woken[0].id, fresh,
            "only the post-exec generation may be completed"
        );
    }

    #[test]
    fn parking_on_a_retired_generation_fails_truthfully() {
        let (mut q, c) = queue_with_channel();
        q.retire_channel(c);
        let err = q
            .park(ParkRequest {
                pid: 1,
                tid: 1,
                channel: c,
                kind: WaitKind::Poll,
                sources: Vec::new(),
                deadline: None,
                target: None,
                signal_safe: false,
            })
            .unwrap_err();
        assert_eq!(err, Errno::ESRCH);
    }

    #[test]
    fn cancel_task_takes_every_wait_that_task_holds() {
        let (mut q, c) = queue_with_channel();
        let d = q.open_channel();
        q.park(ParkRequest {
            pid: 3,
            tid: 9,
            channel: c,
            kind: WaitKind::Poll,
            sources: alloc::vec![WakeSource::Pipe(1)],
            deadline: Some(MS),
            target: None,
            signal_safe: false,
        })
        .expect("park");
        q.park(ParkRequest {
            pid: 3,
            tid: 9,
            channel: d,
            kind: WaitKind::Futex,
            sources: alloc::vec![WakeSource::Futex {
                pid: 3,
                addr: 0x1000
            }],
            deadline: None,
            target: None,
            signal_safe: false,
        })
        .expect("park");
        let other = park(&mut q, c, 4, WaitKind::Poll, alloc::vec![WakeSource::Pipe(1)], None);

        let cancelled = q.cancel_task(3, 9);
        assert_eq!(cancelled.len(), 2);
        assert!(cancelled.iter().all(|w| w.reason == WakeReason::Interrupted));
        assert_eq!(q.len(), 1);
        assert!(q.get(other).is_some());
        assert_eq!(q.stats().cancelled, 2);
    }

    #[test]
    fn a_repark_during_a_wake_is_not_re_yielded() {
        // The host's Map-iterator livelock, made structurally impossible: the
        // set is chosen and removed before any wakeup is returned, so a
        // re-park mints an id this call cannot see.
        let (mut q, c) = queue_with_channel();
        park(&mut q, c, 1, WaitKind::Poll, alloc::vec![WakeSource::Pipe(1)], None);

        let (woken, _) = q.wake(WakeSource::Pipe(1), None, false);
        assert_eq!(woken.len(), 1);

        // The caller re-executes, still gets EAGAIN, and re-parks.
        let again = park(&mut q, c, 1, WaitKind::Poll, alloc::vec![WakeSource::Pipe(1)], None);
        assert_ne!(again, woken[0].id);
        assert_eq!(q.len(), 1);
    }

    #[test]
    fn waking_is_fifo_across_waiters_on_one_source() {
        let (mut q, c) = queue_with_channel();
        let first = park(&mut q, c, 1, WaitKind::Poll, alloc::vec![WakeSource::Pipe(1)], None);
        let second = park(&mut q, c, 2, WaitKind::Poll, alloc::vec![WakeSource::Pipe(1)], None);
        let third = park(&mut q, c, 3, WaitKind::Poll, alloc::vec![WakeSource::Pipe(1)], None);

        let (woken, _) = q.wake(WakeSource::Pipe(1), None, false);
        let ids: Vec<WaiterId> = woken.iter().map(|w| w.id).collect();
        assert_eq!(ids, alloc::vec![first, second, third]);
    }

    #[test]
    fn a_transfer_wait_carries_its_kind_back_to_the_waker() {
        // The pin lives on the sleeper, not behind an opaque host-held token.
        let (mut q, c) = queue_with_channel();
        park(
            &mut q,
            c,
            1,
            WaitKind::Transfer {
                operation: BlockingRetryOperation::Recv,
            },
            alloc::vec![WakeSource::Pipe(2)],
            None,
        );
        let (woken, _) = q.wake(WakeSource::Pipe(2), None, false);
        assert_eq!(
            woken[0].kind,
            WaitKind::Transfer {
                operation: BlockingRetryOperation::Recv
            }
        );
    }

    #[test]
    fn retire_process_drops_every_generation_that_process_holds() {
        let mut q = WaitQueue::new();
        let a = q.open_channel();
        let b = q.open_channel();
        let other = q.open_channel();
        park(&mut q, a, 7, WaitKind::Poll, alloc::vec![WakeSource::Pipe(1)], None);
        park(&mut q, b, 7, WaitKind::Sleep, Vec::new(), Some(MS));
        park(&mut q, other, 8, WaitKind::Sleep, Vec::new(), Some(MS));

        let dropped = q.retire_process(7);
        assert_eq!(dropped.len(), 2);
        assert_eq!(q.len(), 1);
        assert!(!q.is_channel_live(a));
        assert!(!q.is_channel_live(b));
        assert!(q.is_channel_live(other));
    }

    #[test]
    fn child_and_signal_sources_are_keyed_not_broadcast() {
        let (mut q, c) = queue_with_channel();
        let parent = park(
            &mut q,
            c,
            1,
            WaitKind::ChildWait { options: 0 },
            alloc::vec![WakeSource::ChildEvent { parent: 1 }],
            None,
        );
        let _unrelated = park(
            &mut q,
            c,
            2,
            WaitKind::ChildWait { options: 0 },
            alloc::vec![WakeSource::ChildEvent { parent: 2 }],
            None,
        );
        let (woken, _) = q.wake(WakeSource::ChildEvent { parent: 1 }, None, false);
        assert_eq!(woken.len(), 1);
        assert_eq!(woken[0].id, parent);

        let sig = park(
            &mut q,
            c,
            3,
            WaitKind::SigTimedWait { mask: 1 << 10 },
            alloc::vec![WakeSource::Signal { pid: 3, tid: 3 }],
            None,
        );
        let (woken, _) = q.wake(WakeSource::Signal { pid: 3, tid: 3 }, None, false);
        assert_eq!(woken.len(), 1);
        assert_eq!(woken[0].id, sig);
    }

    #[test]
    fn expiring_the_same_deadline_twice_yields_nothing_the_second_time() {
        let (mut q, c) = queue_with_channel();
        park(&mut q, c, 1, WaitKind::Sleep, Vec::new(), Some(MS));
        assert_eq!(q.expire(2 * MS).len(), 1);
        assert_eq!(q.expire(2 * MS).len(), 0);
        assert_eq!(q.next_deadline_ns(), None);
    }
}
