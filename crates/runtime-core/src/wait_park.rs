//! Kernel-owned parking: the kernel withholds a syscall's result and later
//! decides it.
//!
//! # Why this exists
//!
//! [`crate::wait_queue`] records *who* is asleep and *what* can end the sleep.
//! Until this module, nothing ever parked in it: every guest wait lived in
//! host TypeScript, where a container per wait kind held the blocked channel
//! and a JavaScript timer or `Atomics.waitAsync` callback decided when, and
//! with what result, to complete it. Those decisions are kernel control flow.
//! They are also the one thing a deterministic scheduler must be able to see
//! and serialize, and they were per host: the native host shared none of the
//! TypeScript and, for `futex`, never really waited at all (its pump answered
//! every `FUTEX_WAIT` with `EAGAIN`, so musl span through the kernel).
//!
//! This module is where the decision now lives. A syscall parks here; the
//! kernel entry that can end the wait -- a `FUTEX_WAKE`, a signal, a
//! cancellation, a thread exit, or the deadline -- decides the result and
//! queues a completion record. Hosts only transport it: they publish the
//! recorded result into the named channel and re-enter the kernel at
//! [`next_timeout_ns`]. The wire is `wasm_posix_shared::wait_completion_wire`.
//!
//! # How a park ends, and why each way is decided here
//!
//! Parked today: `futex` waits and sleeps (`nanosleep`, `clock_nanosleep`,
//! `usleep`).
//!
//! * **A source fires** (`FUTEX_WAKE`): the waking syscall runs in the kernel,
//!   so the wake and the park are ordered by the kernel's own serialization.
//!   No lost wakeup is possible between a compare and a park: if the wake is
//!   handled first, the later wait reads the new word and returns `EAGAIN`; if
//!   the wait is handled first, the wake finds it here.
//! * **The deadline passes**: deadlines are `CLOCK_MONOTONIC` nanoseconds read
//!   by the kernel in [`now_ns`]; a host only sleeps for the relative time the
//!   kernel reports. That single clock read is also the hook where a
//!   deterministic scheduler substitutes virtual time.
//! * **A signal targets the parked thread**: every signal generation passes
//!   through `Process::prepare_signal_generation`, which calls
//!   [`note_signal_generated`]. The next drain sweeps the parked set once
//!   ([`sweep_signals`]). One choke point and one decision function replace
//!   the per-wait-kind interrupt arms the host used to keep in step. A new
//!   park asks for a sweep of its own process only: a signal already
//!   pending there may target the parking thread or, if that thread blocks
//!   it, another parked thread of the same process -- never a task of any
//!   other process, whose targets this park cannot change. Changes that can
//!   retarget a pending process-directed signal without generating one (a
//!   mask change, a thread's exit) count as a generation.
//! * **Cancellation, exit, exec**: the kernel's own task cleanup calls
//!   [`cancel_task`], [`retire_task`] and [`retire_process`].
//!
//! # What this module deliberately does not do
//!
//! It never writes a guest's channel and never notifies a guest. Publishing a
//! result into a `WebAssembly.Memory` the kernel does not own is the host's
//! irreducible act (floor act F2 in the K3 grounding). It records the decision
//! and raises `TYPE_WAIT_COMPLETE` on the wake-event stream so the host knows
//! to collect it.

extern crate alloc;

use alloc::collections::{BTreeMap, VecDeque};
use alloc::vec::Vec;
use core::cell::UnsafeCell;

use wasm_posix_shared::wait_completion_wire as wire;
use wasm_posix_shared::Errno;

use crate::process::{Process, ProcessState};
use crate::process_table::ProcessTable;
use crate::wait_queue::{
    MonotonicNs, ParkRequest, WaitKind, WaitQueue, WaiterId, WakeReason, WakeSource, Wakeup,
};

/// How the kernel answers a park, by the way it ends.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Resume {
    /// `FUTEX_WAIT` / `FUTEX_WAIT_BITSET`.
    ///
    /// `bitset` narrows which `FUTEX_WAKE_BITSET` reaches this waiter
    /// (`FUTEX_WAIT` is `u32::MAX`). `timeout_ns` is the wait's length on the
    /// guest's clock, if it has one: Linux answers a timed wait that a caught
    /// handler interrupted with `EINTR` regardless of `SA_RESTART`, and an
    /// image-build kernel credits the task's logical clock with the full
    /// timeout when the wait runs out (`image_build_determinism`).
    Futex { bitset: u32, timeout_ns: Option<u64> },
    /// `nanosleep` / `clock_nanosleep` / `usleep`: only the deadline or a
    /// signal ends it.
    ///
    /// `remainder` is the guest `rem` address of a relative sleep; a signal
    /// interruption fills it with the unslept part of `deadline`.
    Sleep {
        remainder: Option<u64>,
        deadline: MonotonicNs,
    },
    /// `wait4` / `waitid`: a child's state change or a signal ends it. The
    /// kernel re-polls the request whenever a child's waitable state changes
    /// ([`note_children_changed`]); see `crate::wait_child`.
    Child(crate::wait_child::ChildWait),
    /// `sigsuspend` / `pause`: only a signal the (temporary) mask lets
    /// through ends it, always with `EINTR`.
    Suspend,
    /// `rt_sigtimedwait`: a signal in the set (taken by the kernel; see
    /// `crate::wait_signal`), a caught signal outside it (`EINTR`), or the
    /// deadline (`EAGAIN`).
    SigTimed(crate::wait_signal::SigWait),
    /// A blocking call the kernel re-executes when one of its sources fires
    /// (`crate::wait_retry`). A caught signal interrupts it with `EINTR`
    /// (restartable under `SA_RESTART`, as Linux's ERESTARTSYS).
    Retry(crate::wait_retry::RetryOp),
}

impl Resume {
    fn woken_value(self) -> i32 {
        match self {
            Resume::Futex { .. }
            | Resume::Sleep { .. }
            | Resume::Child(_)
            | Resume::Suspend
            | Resume::SigTimed(_)
            | Resume::Retry(_) => 0,
        }
    }

    fn deadline_value(self) -> i32 {
        match self {
            Resume::Futex { .. } => -(Errno::ETIMEDOUT as i32),
            // A sleep that ran its course succeeded.
            Resume::Sleep { .. } => 0,
            // Child waits and suspends carry no deadline.
            // A transfer's deadline is SO_RCVTIMEO/SO_SNDTIMEO, which POSIX
            // reports as EAGAIN/EWOULDBLOCK.
            Resume::Retry(crate::wait_retry::RetryOp::Transfer { .. }) => -(Errno::EAGAIN as i32),
            Resume::Child(_) | Resume::Suspend | Resume::Retry(_) => -(Errno::ETIMEDOUT as i32),
            // POSIX: a sigtimedwait whose timeout passes fails with EAGAIN.
            Resume::SigTimed(_) => -(Errno::EAGAIN as i32),
        }
    }

    fn interrupted_flags(self) -> u32 {
        match self {
            Resume::Futex { timeout_ns: Some(_), .. } => wire::FLAG_SUPPRESS_RESTART,
            Resume::Futex { timeout_ns: None, .. } => 0,
            // Linux answers a sleep a caught handler interrupted with EINTR
            // whatever SA_RESTART says (nanosleep(2), signal(7)).
            Resume::Sleep { .. } => wire::FLAG_SUPPRESS_RESTART,
            // wait4/waitid restart under SA_RESTART (signal(7)); the libc
            // glue reissues them.
            Resume::Child(_) => 0,
            Resume::Retry(op) if op.restartable() => 0,
            Resume::Retry(_) => wire::FLAG_SUPPRESS_RESTART,
            // Neither is ever restarted (signal(7)).
            Resume::Suspend | Resume::SigTimed(_) => wire::FLAG_SUPPRESS_RESTART,
        }
    }

    fn interrupted_remainder(self) -> Option<Remainder> {
        match self {
            Resume::Sleep {
                remainder: Some(addr),
                deadline,
            } => Some(Remainder { addr, deadline }),
            _ => None,
        }
    }
}

/// A `rem` write owed to an interrupted sleep: the unslept part of
/// `deadline`, stored at guest address `addr` as a `struct timespec`.
///
/// It is computed and written when the decision is drained -- the moment
/// before the guest can observe it -- because that is when the kernel next
/// reads its clock; the sweep that decided the interruption has no clock.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Remainder {
    pub addr: u64,
    pub deadline: MonotonicNs,
}

impl Remainder {
    /// The `struct timespec` bytes for the time left at `now_ns`. Sixteen
    /// bytes on both caller widths; on wasm32 the high half of the second
    /// word is `tv_nsec`'s padding, written as zero.
    pub fn timespec_at(&self, now_ns: MonotonicNs) -> [u8; 16] {
        let left = self.deadline.saturating_sub(now_ns).max(0);
        let mut out = [0u8; 16];
        out[0..8].copy_from_slice(&(left / 1_000_000_000).to_le_bytes());
        out[8..16].copy_from_slice(&(left % 1_000_000_000).to_le_bytes());
        out
    }
}

/// One decided result, waiting for a host to publish it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Completion {
    pub generation: u64,
    pub pid: u32,
    pub tid: u32,
    pub value: i32,
    pub flags: u32,
    /// Owed to an interrupted relative sleep; see [`Remainder`].
    pub remainder: Option<Remainder>,
}

impl Completion {
    fn encode(&self, out: &mut [u8]) {
        out[wire::GENERATION_OFFSET..wire::GENERATION_OFFSET + 8]
            .copy_from_slice(&self.generation.to_le_bytes());
        out[wire::PID_OFFSET..wire::PID_OFFSET + 4].copy_from_slice(&self.pid.to_le_bytes());
        out[wire::TID_OFFSET..wire::TID_OFFSET + 4].copy_from_slice(&self.tid.to_le_bytes());
        out[wire::VALUE_OFFSET..wire::VALUE_OFFSET + 4].copy_from_slice(&self.value.to_le_bytes());
        out[wire::FLAGS_OFFSET..wire::FLAGS_OFFSET + 4].copy_from_slice(&self.flags.to_le_bytes());
    }
}

/// The machine's kernel-owned parks.
///
/// A second [`WaitQueue`] instance, separate from the deadline-authority one
/// in `wait_queue::global`, on purpose: that queue holds deadline-only records
/// the *host* still owns (poll, select, epoll, sigtimedwait), and expiring one
/// of those here would silently end a wait the host is still timing. When
/// those families move here (steps 4 and 5 of
/// `docs/plans/2026-09-27-guest-waits-into-rust.md`) the other instance goes
/// away.
pub struct Parks {
    queue: WaitQueue,
    resume: BTreeMap<WaiterId, Resume>,
    completions: VecDeque<Completion>,
    /// Set by every signal generation; cleared by the sweep that consumes it.
    signals_dirty: bool,
    /// Processes a new park asked to have swept (see [`Self::park`]); a
    /// narrower request than `signals_dirty`, consumed by the same sweep.
    sweep_pids: Vec<u32>,
    /// See [`note_parked_result`].
    last_park: Option<u64>,
    /// Set whenever a child's waitable state changes; cleared by the kernel
    /// pass that re-polls parked `wait4`/`waitid` callers.
    children_dirty: bool,
    /// Processes whose exit is recorded but not yet announced to the parent
    /// (SIGCHLD, or the SA_NOCLDWAIT auto-reap); see [`note_child_exited`].
    exit_notices: Vec<u32>,
    /// Wake sources that fired since the last re-execution pass: advisory
    /// lock state, a pipe's readiness. Parked re-executable calls waiting on
    /// one of them are re-run by the next settle.
    dirty_sources: Vec<WakeSource>,
    /// `(pid, tid, token)` of re-executable calls whose park completed: the
    /// kernel releases each blocked-retry binding (`crate::wait_retry`)
    /// before the completion can reach the guest.
    released_retry_bindings: Vec<(u32, u32, i64)>,
}

impl Default for Parks {
    fn default() -> Self {
        Self::new()
    }
}

impl Parks {
    pub const fn new() -> Self {
        Self {
            queue: WaitQueue::new(),
            resume: BTreeMap::new(),
            completions: VecDeque::new(),
            signals_dirty: false,
            sweep_pids: Vec::new(),
            last_park: None,
            children_dirty: false,
            exit_notices: Vec::new(),
            dirty_sources: Vec::new(),
            released_retry_bindings: Vec::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.queue.len()
    }

    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }

    pub fn pending_completions(&self) -> usize {
        self.completions.len()
    }

    /// Park `(pid, tid)` until one of `sources` fires or `deadline` passes.
    /// Returns the park generation the host must quote back.
    pub fn park(
        &mut self,
        pid: u32,
        tid: u32,
        kind: WaitKind,
        sources: Vec<WakeSource>,
        deadline: Option<MonotonicNs>,
        resume: Resume,
    ) -> Result<u64, Errno> {
        let channel = self.queue.open_channel();
        let id = match self.queue.park(ParkRequest {
            pid,
            tid,
            channel,
            kind,
            sources,
            deadline,
            target: None,
            signal_safe: false,
        }) {
            Ok(id) => id,
            Err(error) => {
                self.queue.release_channel(channel);
                return Err(error);
            }
        };
        self.resume.insert(id, resume);
        // A signal may already be pending in this process, for this thread or
        // -- when this thread blocks it -- for another of its parked threads.
        // Let the next sweep decide it rather than duplicating the targeting
        // rule here (the caller's host drains immediately after a park), but
        // sweep only this process: no other process's targets changed.
        if !self.sweep_pids.contains(&pid) {
            self.sweep_pids.push(pid);
        }
        Ok(channel.0)
    }

    fn finish(&mut self, wakeup: Wakeup, value: i32, flags: u32) {
        self.finish_with(wakeup, value, flags, None);
    }

    fn finish_with(&mut self, wakeup: Wakeup, value: i32, flags: u32, remainder: Option<Remainder>) {
        if let Some(Resume::Retry(op)) = self.resume.remove(&wakeup.id) {
            self.released_retry_bindings
                .push((wakeup.pid, wakeup.tid, op.token()));
        }
        self.queue.release_channel(wakeup.channel);
        self.completions.push_back(Completion {
            generation: wakeup.channel.0,
            pid: wakeup.pid,
            tid: wakeup.tid,
            value,
            flags,
            remainder,
        });
    }

    fn forget(&mut self, wakeup: Wakeup) {
        self.resume.remove(&wakeup.id);
        self.queue.release_channel(wakeup.channel);
    }

    /// `FUTEX_WAKE[_BITSET]`: wake at most `max` waiters on `(pid, addr)`
    /// whose bitset intersects `bitset`, oldest first. Returns how many woke.
    pub fn futex_wake(&mut self, pid: u32, addr: u64, max: usize, bitset: u32) -> usize {
        let resume = &self.resume;
        let woken = self.queue.wake_limited(WakeSource::Futex { pid, addr }, max, |s| {
            match resume.get(&s.id) {
                Some(Resume::Futex { bitset: mine, .. }) => mine & bitset != 0,
                Some(_) | None => false,
            }
        });
        let count = woken.len();
        for wakeup in woken {
            let value = self
                .resume
                .get(&wakeup.id)
                .map(|r| r.woken_value())
                .unwrap_or(0);
            self.finish(wakeup, value, 0);
        }
        count
    }

    /// `FUTEX_REQUEUE` tail: move at most `max` waiters from `from` to `to`
    /// without waking them. Returns how many moved.
    pub fn futex_requeue(&mut self, pid: u32, from: u64, to: u64, max: usize) -> usize {
        if from == to {
            return 0;
        }
        self.queue.retarget(
            WakeSource::Futex { pid, addr: from },
            WakeSource::Futex { pid, addr: to },
            max,
        )
    }

    /// End every park whose deadline is at or before `now_ns`.
    ///
    /// Returns the timed futex waits that ran out, as `(pid, tid, timeout)`:
    /// an image-build kernel advances each task's logical clock by its
    /// timeout (`image_build_determinism`), as the host's deadline records
    /// did before the wait moved here. The caller applies them, so this
    /// decision stays testable without that mode's machine-wide state.
    /// (Sleeps are credited when they begin.)
    pub fn expire(&mut self, now_ns: MonotonicNs) -> Vec<(u32, u32, u64)> {
        let mut credits = Vec::new();
        for wakeup in self.queue.expire(now_ns) {
            let resume = self.resume.get(&wakeup.id).copied();
            match resume {
                Some(Resume::Futex { timeout_ns: Some(ns), .. })
                | Some(Resume::SigTimed(crate::wait_signal::SigWait {
                    timeout_ns: Some(ns),
                    ..
                })) => credits.push((wakeup.pid, wakeup.tid, ns)),
                _ => {}
            }
            let value = resume
                .map(|r| r.deadline_value())
                .unwrap_or(-(Errno::ETIMEDOUT as i32));
            self.finish(wakeup, value, 0);
        }
        credits
    }

    /// Whether a drain needs the clock: some park has a deadline to expire,
    /// or some queued decision owes a `rem` measured against it. Without
    /// either, the clock read (a host call) is skipped.
    pub fn needs_clock(&mut self) -> bool {
        self.queue.next_deadline_ns().is_some()
            || self.completions.iter().any(|c| c.remainder.is_some())
    }

    /// Whether any park has a deadline.
    pub fn has_deadline(&mut self) -> bool {
        self.queue.next_deadline_ns().is_some()
    }

    /// Nanoseconds until the earliest park deadline, saturating at zero.
    pub fn next_timeout_ns(&mut self, now_ns: MonotonicNs) -> Option<MonotonicNs> {
        self.queue
            .next_deadline_ns()
            .map(|deadline| deadline.saturating_sub(now_ns).max(0))
    }

    pub fn note_children_changed(&mut self) {
        self.children_dirty = true;
    }

    /// The parked `wait4`/`waitid` callers, oldest first, if a child's state
    /// changed since the last call. The kernel re-polls each and reports a
    /// decision with [`Self::finish_child_waiter`].
    pub fn take_dirty_child_waiters(&mut self) -> Option<Vec<(WaiterId, u32, u32, crate::wait_child::ChildWait)>> {
        if !core::mem::take(&mut self.children_dirty) {
            return None;
        }
        let resume = &self.resume;
        Some(
            self.queue
                .iter()
                .filter_map(|s| match resume.get(&s.id) {
                    Some(Resume::Child(wait)) => Some((s.id, s.pid, s.tid, *wait)),
                    _ => None,
                })
                .collect(),
        )
    }

    /// Decide the child wait `id` of `parent` that the kernel re-polled.
    /// Returns false if it is no longer parked.
    pub fn finish_child_waiter(&mut self, id: WaiterId, parent: u32, value: i32) -> bool {
        match self
            .queue
            .remove_with_reason(id, WakeReason::Source(WakeSource::ChildEvent { parent }))
        {
            Some(wakeup) => {
                self.finish(wakeup, value, 0);
                true
            }
            None => false,
        }
    }

    /// The parked `rt_sigtimedwait` callers, oldest first, if a signal was
    /// generated since the last sweep. The kernel offers each one the signals
    /// in its set before the sweep runs ([`Self::finish_signal_waiter`]);
    /// the flag stays set for that sweep.
    pub fn dirty_signal_waiters(&self) -> Vec<(WaiterId, u32, u32, crate::wait_signal::SigWait)> {
        if !self.signals_dirty {
            return Vec::new();
        }
        self.queue
            .iter()
            .filter_map(|s| match self.resume.get(&s.id) {
                Some(Resume::SigTimed(wait)) => Some((s.id, s.pid, s.tid, *wait)),
                _ => None,
            })
            .collect()
    }

    /// Decide the `rt_sigtimedwait` `id` of `(pid, tid)` the kernel answered.
    pub fn finish_signal_waiter(&mut self, id: WaiterId, pid: u32, tid: u32, value: i32) -> bool {
        match self
            .queue
            .remove_with_reason(id, WakeReason::Source(WakeSource::Signal { pid, tid }))
        {
            Some(wakeup) => {
                self.finish(wakeup, value, 0);
                true
            }
            None => false,
        }
    }

    /// The parked re-executable calls whose sources fired since the last
    /// pass, oldest first. Today the only source is advisory-lock state.
    pub fn take_dirty_retry_waiters(&mut self) -> Vec<(WaiterId, u32, u32, crate::wait_retry::RetryOp)> {
        if self.dirty_sources.is_empty() {
            return Vec::new();
        }
        let dirty = core::mem::take(&mut self.dirty_sources);
        let resume = &self.resume;
        self.queue
            .iter()
            .filter_map(|s| match resume.get(&s.id) {
                Some(Resume::Retry(op)) if dirty.contains(&op.source()) => {
                    Some((s.id, s.pid, s.tid, *op))
                }
                _ => None,
            })
            .collect()
    }

    /// Record that `source` fired, if anything is parked to care.
    pub fn note_source_ready(&mut self, source: WakeSource) {
        if !self.queue.is_empty() && !self.dirty_sources.contains(&source) {
            self.dirty_sources.push(source);
        }
    }

    /// Decide the re-executed call `id` of `(pid, tid)`.
    pub fn finish_retry_waiter(&mut self, id: WaiterId, op: crate::wait_retry::RetryOp, value: i32) -> bool {
        match self.queue.remove_with_reason(id, WakeReason::Source(op.source())) {
            Some(wakeup) => {
                self.finish(wakeup, value, 0);
                true
            }
            None => false,
        }
    }

    /// The blocked-retry bindings of completed re-executable parks, for the
    /// kernel to release. A park that was retired instead (its thread or
    /// image is gone) is not listed: that lifecycle cleanup releases it.
    pub fn take_released_retry_bindings(&mut self) -> Vec<(u32, u32, i64)> {
        core::mem::take(&mut self.released_retry_bindings)
    }

    #[cfg(test)]
    pub fn note_advisory_lock_changed_for_test(&mut self) {
        self.note_source_ready(WakeSource::AdvisoryLock);
    }

    pub fn note_signal_generated(&mut self) {
        if !self.queue.is_empty() {
            self.signals_dirty = true;
        }
    }

    /// Interrupt every park a pending signal now targets, and retire every
    /// park whose task no longer exists. Runs only after a signal generation
    /// (every park), or a new park (that park's process only).
    pub fn sweep_signals(&mut self, table: &ProcessTable) {
        let all = core::mem::take(&mut self.signals_dirty);
        let pids = core::mem::take(&mut self.sweep_pids);
        if !all && pids.is_empty() {
            return;
        }
        let mut interrupt: Vec<WaiterId> = Vec::new();
        let mut retire: Vec<WaiterId> = Vec::new();
        for sleeper in self.queue.iter() {
            if !all && !pids.contains(&sleeper.pid) {
                continue;
            }
            match table.get(sleeper.pid) {
                Some(proc) if proc.is_live_explicit_tid(sleeper.tid) => {
                    if signal_targets_task(proc, sleeper.tid) {
                        interrupt.push(sleeper.id);
                    }
                }
                _ => retire.push(sleeper.id),
            }
        }
        for id in retire {
            if let Some(wakeup) = self.queue.remove_with_reason(id, WakeReason::Retired) {
                self.forget(wakeup);
            }
        }
        for id in interrupt {
            if let Some(wakeup) = self.queue.remove_with_reason(id, WakeReason::Interrupted) {
                let resume = self.resume.get(&wakeup.id).copied();
                let flags = resume.map(|r| r.interrupted_flags()).unwrap_or(0);
                let remainder = resume.and_then(|r| r.interrupted_remainder());
                self.finish_with(wakeup, -(Errno::EINTR as i32), flags, remainder);
            }
        }
    }

    /// `pthread_cancel` reached a thread parked here: end the park with
    /// `EINTR`. Returns whether a park existed.
    pub fn cancel_task(&mut self, pid: u32, tid: u32) -> bool {
        let woken = self.queue.cancel_task(pid, tid);
        let any = !woken.is_empty();
        for wakeup in woken {
            self.finish(
                wakeup,
                -(Errno::EINTR as i32),
                wire::FLAG_CANCELLED,
            );
        }
        any
    }

    /// The thread is gone: drop its park without a completion.
    pub fn retire_task(&mut self, pid: u32, tid: u32) {
        for wakeup in self.queue.cancel_task(pid, tid) {
            self.forget(wakeup);
        }
    }

    /// The process image is gone (exit, exec, removal): drop every park
    /// without a completion, so no decision can reach a successor image.
    pub fn retire_process(&mut self, pid: u32) {
        for wakeup in self.queue.retire_process(pid) {
            self.forget(wakeup);
        }
        self.completions.retain(|c| c.pid != pid);
        self.released_retry_bindings.retain(|&(p, _, _)| p != pid);
    }

    /// Move up to `max` records into `out`; the rest stay queued in order.
    ///
    /// A record that owes a `rem` write gets it first, through
    /// `write_guest(pid, addr, bytes)` (the kernel's cross-memory write);
    /// `now_ns` is the clock the remainder is measured against. If the write
    /// fails the result becomes `EFAULT`, as Linux reports a `rem` it cannot
    /// store.
    pub fn drain(
        &mut self,
        out: &mut [u8],
        max: u32,
        now_ns: MonotonicNs,
        write_guest: &mut dyn FnMut(u32, u64, &[u8]) -> bool,
    ) -> u32 {
        let fit = (out.len() / wire::RECORD_BYTES).min(max as usize);
        let count = fit.min(self.completions.len());
        for i in 0..count {
            let mut completion = self
                .completions
                .pop_front()
                .expect("count is bounded by the queue length");
            if let Some(remainder) = completion.remainder.take() {
                if !write_guest(completion.pid, remainder.addr, &remainder.timespec_at(now_ns)) {
                    completion.value = -(Errno::EFAULT as i32);
                }
            }
            completion.encode(&mut out[i * wire::RECORD_BYTES..(i + 1) * wire::RECORD_BYTES]);
        }
        count as u32
    }

    /// Take the queued decisions. Test and native-host convenience.
    pub fn take_completions(&mut self) -> Vec<Completion> {
        self.completions.drain(..).collect()
    }
}

/// Whether a pending, unblocked signal is directed at `tid`.
///
/// This is the same targeting the host applied before this module existed,
/// now in one place: a thread-directed signal targets exactly its thread; a
/// process-directed one targets the thread `pick_thread_for_shared_signal`
/// picks (the main thread when it accepts the signal). Waking any other
/// thread would complete its wait early while the signal stayed pending for
/// the intended one.
///
/// A stopped process is never interrupted: its threads resume on `SIGCONT`,
/// and `SIGCONT` is itself a generation that re-runs the sweep.
///
/// An ignored signal never interrupts (`ignored_signals`). Linux discards one
/// at generation unless it is blocked; one that was blocked and is now let
/// through -- `sigsuspend` with a mask that unblocks a default-ignored
/// SIGCHLD -- is discarded without the wait returning (the syscall restarts,
/// since no handler ran). Here it simply stays pending until the next
/// syscall boundary consumes it.
pub fn signal_targets_task(proc: &Process, tid: u32) -> bool {
    if proc.state == ProcessState::Stopped {
        return false;
    }
    let blocked = proc.blocked_for(tid) | ignored_signals(proc);
    let directed = if proc.pid == tid {
        proc.main_thread_signals.pending
    } else {
        match proc.get_thread(tid) {
            Some(thread) => thread.signals.pending,
            None => return false,
        }
    };
    if directed & !blocked != 0 {
        return true;
    }
    let mut shared = proc.signals.pending & !blocked;
    while shared != 0 {
        let signum = shared.trailing_zeros() + 1;
        if proc.pick_thread_for_shared_signal(signum) == Some(tid) {
            return true;
        }
        shared &= shared - 1;
    }
    false
}

/// The signals whose delivery would do nothing to a running process: those
/// set to `SIG_IGN`, and those left at a default action of "ignore" (SIGCHLD,
/// SIGWINCH, ...) or "continue" (SIGCONT, whose resume happens at
/// generation). As a bit mask in the `pending` layout.
fn ignored_signals(proc: &Process) -> u64 {
    use crate::signal::{default_action, DefaultAction, SignalHandler};
    let mut mask = 0u64;
    for signum in 1..wasm_posix_shared::signal::NSIG {
        let ignored = match proc.signals.get_action(signum).handler {
            SignalHandler::Ignore => true,
            SignalHandler::Default => matches!(
                default_action(signum),
                DefaultAction::Ignore | DefaultAction::Continue
            ),
            SignalHandler::Handler(_) => false,
        };
        if ignored {
            mask |= crate::signal::sig_bit(signum);
        }
    }
    mask
}

// ---------------------------------------------------------------------------
// The one `Parks` a running kernel owns.
// ---------------------------------------------------------------------------

struct ParksGlobal(UnsafeCell<Parks>);

// SAFETY: the kernel is entered by one host thread at a time (the same
// serialization `wakeup.rs` and `fork_lifecycle.rs` rely on), and no
// reference escapes `with`.
unsafe impl Sync for ParksGlobal {}

#[cfg(not(test))]
static PARKS: ParksGlobal = ParksGlobal(UnsafeCell::new(Parks::new()));

// Native unit tests run in parallel; give each its own set.
#[cfg(test)]
std::thread_local! {
    static TEST_PARKS: core::cell::RefCell<Parks> = core::cell::RefCell::new(Parks::new());
}

pub fn with<R>(f: impl FnOnce(&mut Parks) -> R) -> R {
    #[cfg(test)]
    {
        return TEST_PARKS.with(|p| f(&mut p.borrow_mut()));
    }
    #[cfg(not(test))]
    f(unsafe { &mut *PARKS.0.get() })
}

/// The kernel's one clock read for park deadlines: `CLOCK_MONOTONIC`, in
/// nanoseconds.
///
/// Every deadline a park carries, and every expiry check, goes through here
/// and nowhere else. That is deliberate: it is the single point where a
/// deterministic scheduler replaces real time with virtual time (see §8 of
/// `docs/plans/2026-09-27-guest-waits-into-rust.md`). Hosts never see an
/// absolute deadline, only [`Parks::next_timeout_ns`]'s relative answer, so
/// no host changes when this clock does.
pub fn now_ns(host: &mut dyn crate::process::HostIO) -> Result<MonotonicNs, Errno> {
    let (sec, nsec) = host.host_clock_gettime(wasm_posix_shared::clock::CLOCK_MONOTONIC)?;
    sec.checked_mul(1_000_000_000)
        .and_then(|ns| ns.checked_add(nsec))
        .ok_or(Errno::EOVERFLOW)
}

/// Record the generation of the park the current syscall just made.
///
/// The syscall dispatcher reports a park as `errno = PARKED_ERRNO`; the
/// generation travels in the return slot, which the narrow `i32` dispatch
/// path cannot carry. The kernel is entered by one caller at a time, so the
/// value set here is taken by the same entry's result writer.
pub fn note_parked_result(generation: u64) {
    with(|p| p.last_park = Some(generation));
}

pub fn take_parked_result() -> Option<u64> {
    with(|p| p.last_park.take())
}

/// A child's waitable state changed: an event was recorded, a zombie was
/// reaped, a process group changed, or a spawned child was published. Parked
/// `wait4`/`waitid` callers are re-polled by the next settle.
pub fn note_children_changed() {
    with(|p| p.note_children_changed());
}

/// A process's exit was just recorded. Its parent is told (SIGCHLD, or an
/// SA_NOCLDWAIT/SIG_IGN auto-reap) by the kernel's next exit-notice pass,
/// which always runs before any wait is re-decided, so a parent's `wait`
/// never returns an exit whose SIGCHLD has not been generated (Linux's
/// exit_notify order).
///
/// WHY a queue and not an inline signal: the exit is recorded on the child's
/// `Process`, which has no access to its parent; the pass runs where the
/// process table is in hand.
pub fn note_child_exited(pid: u32) {
    with(|p| {
        p.exit_notices.push(pid);
        p.children_dirty = true;
    });
}

/// Advisory-lock state changed (a lock was released or downgraded, an owner
/// went away): parked lock requests are re-executed by the next settle.
pub fn note_advisory_lock_changed() {
    with(|p| p.note_source_ready(WakeSource::AdvisoryLock));
}

/// A pipe (or the socket buffer backed by it) changed readiness: parked
/// transfers on it are re-executed by the next settle (`crate::wait_retry`).
pub fn note_pipe_ready(idx: u32) {
    with(|p| p.note_source_ready(WakeSource::Pipe(idx)));
}

/// Take the queued exit notices, oldest first.
pub fn take_exit_notices() -> Vec<u32> {
    with(|p| core::mem::take(&mut p.exit_notices))
}

/// Put back notices that cannot be announced yet (an unpublished spawn
/// child), ahead of any queued since.
pub fn requeue_exit_notices(mut pids: Vec<u32>) {
    if pids.is_empty() {
        return;
    }
    with(|p| {
        pids.append(&mut p.exit_notices);
        p.exit_notices = pids;
    });
}

/// Called from `Process::prepare_signal_generation`.
pub fn note_signal_generated() {
    with(|p| p.note_signal_generated());
}

pub fn retire_process(pid: u32) {
    with(|p| p.retire_process(pid));
}

pub fn retire_task(pid: u32, tid: u32) {
    with(|p| p.retire_task(pid, tid));
}

pub fn cancel_task(pid: u32, tid: u32) -> bool {
    with(|p| p.cancel_task(pid, tid))
}

/// Run the signal sweep and report whether decisions are waiting.
///
/// The wake-event drain calls this on every drain; with no park and no signal
/// since the last sweep it is two field reads.
pub fn settle(table: &ProcessTable) -> bool {
    with(|p| {
        p.sweep_signals(table);
        p.pending_completions() != 0
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    const MS: MonotonicNs = 1_000_000;
    const ANY: u32 = u32::MAX;

    fn futex(parks: &mut Parks, pid: u32, tid: u32, addr: u64, deadline: Option<MonotonicNs>) -> u64 {
        parks
            .park(
                pid,
                tid,
                WaitKind::Futex,
                vec![WakeSource::Futex { pid, addr }],
                deadline,
                Resume::Futex {
                    bitset: ANY,
                    timeout_ns: deadline.map(|d| d as u64),
                },
            )
            .expect("park")
    }

    #[test]
    fn a_wake_completes_the_oldest_waiters_up_to_the_count() {
        let mut parks = Parks::new();
        let first = futex(&mut parks, 10, 11, 0x100, None);
        let second = futex(&mut parks, 10, 12, 0x100, None);
        let _third = futex(&mut parks, 10, 13, 0x100, None);

        assert_eq!(parks.futex_wake(10, 0x100, 2, ANY), 2);
        let done = parks.take_completions();
        assert_eq!(
            done,
            vec![
                Completion { generation: first, pid: 10, tid: 11, value: 0, flags: 0, remainder: None },
                Completion { generation: second, pid: 10, tid: 12, value: 0, flags: 0, remainder: None },
            ]
        );
        assert_eq!(parks.len(), 1, "the third waiter must stay parked");
    }

    #[test]
    fn a_wake_reaches_only_its_own_process_and_word() {
        let mut parks = Parks::new();
        futex(&mut parks, 10, 10, 0x100, None);
        futex(&mut parks, 20, 20, 0x100, None);
        futex(&mut parks, 10, 11, 0x104, None);
        assert_eq!(parks.futex_wake(10, 0x100, usize::MAX, ANY), 1);
        assert_eq!(parks.take_completions()[0].pid, 10);
        assert_eq!(parks.len(), 2);
    }

    #[test]
    fn a_bitset_wake_skips_waiters_whose_bitset_does_not_intersect() {
        let mut parks = Parks::new();
        parks
            .park(1, 1, WaitKind::Futex, vec![WakeSource::Futex { pid: 1, addr: 8 }], None,
                Resume::Futex { bitset: 0b01, timeout_ns: None })
            .unwrap();
        parks
            .park(1, 2, WaitKind::Futex, vec![WakeSource::Futex { pid: 1, addr: 8 }], None,
                Resume::Futex { bitset: 0b10, timeout_ns: None })
            .unwrap();
        assert_eq!(parks.futex_wake(1, 8, usize::MAX, 0b10), 1);
        assert_eq!(parks.take_completions()[0].tid, 2);
    }

    #[test]
    fn a_requeued_waiter_is_woken_only_through_its_new_word() {
        let mut parks = Parks::new();
        futex(&mut parks, 1, 1, 0x10, None);
        futex(&mut parks, 1, 2, 0x10, None);
        assert_eq!(parks.futex_requeue(1, 0x10, 0x20, 1), 1);
        assert_eq!(parks.futex_wake(1, 0x10, usize::MAX, ANY), 1);
        assert_eq!(parks.take_completions()[0].tid, 2);
        assert_eq!(parks.futex_wake(1, 0x20, usize::MAX, ANY), 1);
        assert_eq!(parks.take_completions()[0].tid, 1);
    }

    #[test]
    fn a_deadline_ends_a_park_with_etimedout_and_is_reported_relative() {
        let mut parks = Parks::new();
        let generation = futex(&mut parks, 1, 1, 0x10, Some(50 * MS));
        futex(&mut parks, 1, 2, 0x10, None);
        assert_eq!(parks.next_timeout_ns(20 * MS), Some(30 * MS));
        parks.expire(49 * MS);
        assert!(parks.take_completions().is_empty(), "not due yet");
        parks.expire(50 * MS);
        assert_eq!(
            parks.take_completions(),
            vec![Completion {
                generation,
                pid: 1,
                tid: 1,
                value: -(Errno::ETIMEDOUT as i32),
                flags: 0,
                remainder: None,
            }]
        );
        assert_eq!(parks.next_timeout_ns(60 * MS), None, "the untimed waiter has no deadline");
    }

    #[test]
    fn only_a_timed_futex_that_runs_out_reports_its_timeout() {
        let mut parks = Parks::new();
        futex(&mut parks, 1, 1, 0x10, Some(50 * MS));
        futex(&mut parks, 1, 2, 0x10, Some(80 * MS));
        futex(&mut parks, 1, 3, 0x10, None);
        parks
            .park(1, 4, WaitKind::Sleep, Vec::new(), Some(10 * MS),
                Resume::Sleep { remainder: None, deadline: 10 * MS })
            .unwrap();
        // The sleep and the first futex are due; the sleep credits nothing
        // here (sleeps are credited when they begin).
        assert_eq!(parks.expire(60 * MS), vec![(1, 1, (50 * MS) as u64)]);
        // A wait woken before its deadline credits nothing either.
        assert_eq!(parks.futex_wake(1, 0x10, usize::MAX, ANY), 2);
        assert!(parks.expire(100 * MS).is_empty());
    }

    #[test]
    fn cancellation_ends_a_park_with_eintr_and_says_so() {
        let mut parks = Parks::new();
        futex(&mut parks, 1, 3, 0x10, None);
        assert!(parks.cancel_task(1, 3));
        let done = parks.take_completions();
        assert_eq!(done[0].value, -(Errno::EINTR as i32));
        assert_eq!(done[0].flags, wire::FLAG_CANCELLED);
        assert!(!parks.cancel_task(1, 3), "a second cancel finds nothing");
    }

    #[test]
    fn retiring_a_process_drops_its_parks_and_decisions_silently() {
        let mut parks = Parks::new();
        futex(&mut parks, 1, 1, 0x10, None);
        futex(&mut parks, 1, 2, 0x10, None);
        futex(&mut parks, 2, 2, 0x10, None);
        parks.futex_wake(1, 0x10, 1, ANY);
        parks.retire_process(1);
        assert!(parks.take_completions().is_empty(), "no decision may reach a successor image");
        assert_eq!(parks.len(), 1);
        assert_eq!(parks.futex_wake(1, 0x10, usize::MAX, ANY), 0);
    }

    #[test]
    fn drained_records_use_the_wire_layout_and_keep_the_remainder() {
        let mut parks = Parks::new();
        let a = futex(&mut parks, 7, 8, 0x10, None);
        futex(&mut parks, 7, 9, 0x10, None);
        parks.futex_wake(7, 0x10, usize::MAX, ANY);
        let mut out = [0u8; wire::RECORD_BYTES];
        assert_eq!(parks.drain(&mut out, 8, 0, &mut |_, _, _| unreachable!()), 1, "only one record fits");
        assert_eq!(u64::from_le_bytes(out[0..8].try_into().unwrap()), a);
        assert_eq!(u32::from_le_bytes(out[8..12].try_into().unwrap()), 7);
        assert_eq!(u32::from_le_bytes(out[12..16].try_into().unwrap()), 8);
        assert_eq!(i32::from_le_bytes(out[16..20].try_into().unwrap()), 0);
        assert_eq!(parks.pending_completions(), 1, "the other record stays queued");
    }

    fn table_with_process() -> (ProcessTable, u32) {
        let mut table = ProcessTable::new();
        let pid = table.create_process().expect("process");
        (table, pid)
    }

    #[test]
    fn a_signal_for_the_parked_thread_interrupts_it() {
        let (mut table, pid) = table_with_process();
        let mut parks = Parks::new();
        let generation = futex(&mut parks, pid, pid, 0x10, Some(i64::MAX));
        parks.sweep_signals(&table);
        assert!(parks.take_completions().is_empty(), "nothing pending yet");

        table.get_mut(pid).unwrap().raise_signal(wasm_posix_shared::signal::SIGUSR1);
        parks.note_signal_generated();
        parks.sweep_signals(&table);
        assert_eq!(
            parks.take_completions(),
            vec![Completion {
                generation,
                pid,
                tid: pid,
                value: -(Errno::EINTR as i32),
                flags: wire::FLAG_SUPPRESS_RESTART,
                remainder: None,
            }],
            "a timed futex must not be restarted by SA_RESTART"
        );
    }

    #[test]
    fn a_blocked_signal_leaves_the_park_alone() {
        let (mut table, pid) = table_with_process();
        let mut parks = Parks::new();
        futex(&mut parks, pid, pid, 0x10, None);
        let usr1 = wasm_posix_shared::signal::SIGUSR1;
        let proc = table.get_mut(pid).unwrap();
        proc.set_blocked_for(pid, crate::signal::sig_bit(usr1));
        proc.raise_signal(usr1);
        parks.note_signal_generated();
        parks.sweep_signals(&table);
        assert!(parks.take_completions().is_empty());
        assert_eq!(parks.len(), 1);
    }

    #[test]
    fn an_ignored_signal_leaves_the_park_alone() {
        use crate::signal::{SignalAction, SignalHandler};
        use wasm_posix_shared::signal::{SIGCHLD, SIGCONT};
        let (mut table, pid) = table_with_process();
        let mut parks = Parks::new();
        futex(&mut parks, pid, pid, 0x10, None);
        let proc = table.get_mut(pid).unwrap();
        // A process-directed default-ignored signal is discarded when it is
        // generated, but a default-continue SIGCONT stays pending, and so
        // does a thread-directed SIGCHLD. Neither would run anything.
        proc.raise_signal(SIGCONT);
        proc.main_thread_signals.raise(SIGCHLD);
        parks.note_signal_generated();
        parks.sweep_signals(&table);
        assert!(parks.take_completions().is_empty(), "nothing would run");

        // A handler makes the same pending SIGCONT a reason to return.
        table
            .get_mut(pid)
            .unwrap()
            .signals
            .set_action(SIGCONT, SignalAction { handler: SignalHandler::Handler(1), ..SignalAction::default() })
            .unwrap();
        parks.note_signal_generated();
        parks.sweep_signals(&table);
        assert_eq!(parks.take_completions().len(), 1);
    }

    #[test]
    fn a_stopped_process_is_not_interrupted() {
        let (mut table, pid) = table_with_process();
        let mut parks = Parks::new();
        futex(&mut parks, pid, pid, 0x10, None);
        let proc = table.get_mut(pid).unwrap();
        proc.state = ProcessState::Stopped;
        proc.raise_signal(wasm_posix_shared::signal::SIGUSR1);
        parks.note_signal_generated();
        parks.sweep_signals(&table);
        assert!(parks.take_completions().is_empty());
    }

    #[test]
    fn a_park_of_a_vanished_process_is_retired_by_the_sweep() {
        let (table, _pid) = table_with_process();
        let mut parks = Parks::new();
        futex(&mut parks, 9_999, 9_999, 0x10, None);
        parks.note_signal_generated();
        parks.sweep_signals(&table);
        assert!(parks.take_completions().is_empty());
        assert!(parks.is_empty());
    }

    fn sleep(parks: &mut Parks, pid: u32, tid: u32, deadline: MonotonicNs, rem: Option<u64>) -> u64 {
        parks
            .park(
                pid,
                tid,
                WaitKind::Sleep,
                Vec::new(),
                Some(deadline),
                Resume::Sleep {
                    remainder: rem,
                    deadline,
                },
            )
            .expect("park")
    }

    #[test]
    fn a_sleep_that_runs_out_succeeds_and_owes_no_remainder() {
        let mut parks = Parks::new();
        let generation = sleep(&mut parks, 1, 1, 10 * MS, Some(0x40));
        parks.expire(10 * MS);
        assert_eq!(
            parks.take_completions(),
            vec![Completion { generation, pid: 1, tid: 1, value: 0, flags: 0, remainder: None }]
        );
    }

    #[test]
    fn an_interrupted_sleep_answers_eintr_and_writes_the_unslept_time() {
        let (mut table, pid) = table_with_process();
        let mut parks = Parks::new();
        let generation = sleep(&mut parks, pid, pid, 3_250 * MS, Some(0x40));
        table.get_mut(pid).unwrap().raise_signal(wasm_posix_shared::signal::SIGUSR1);
        parks.note_signal_generated();
        parks.sweep_signals(&table);

        let mut writes = Vec::new();
        let mut out = [0u8; wire::RECORD_BYTES];
        let drained = parks.drain(&mut out, 1, 1_000 * MS, &mut |p, addr, bytes| {
            writes.push((p, addr, bytes.to_vec()));
            true
        });
        assert_eq!(drained, 1);
        assert_eq!(u64::from_le_bytes(out[0..8].try_into().unwrap()), generation);
        assert_eq!(
            i32::from_le_bytes(out[16..20].try_into().unwrap()),
            -(Errno::EINTR as i32)
        );
        assert_eq!(
            u32::from_le_bytes(out[20..24].try_into().unwrap()),
            wire::FLAG_SUPPRESS_RESTART,
            "SA_RESTART never restarts a sleep"
        );
        assert_eq!(writes.len(), 1);
        let (p, addr, bytes) = &writes[0];
        assert_eq!((*p, *addr), (pid, 0x40));
        assert_eq!(i64::from_le_bytes(bytes[0..8].try_into().unwrap()), 2);
        assert_eq!(i64::from_le_bytes(bytes[8..16].try_into().unwrap()), 250_000_000);
    }

    #[test]
    fn an_unwritable_remainder_turns_the_result_into_efault() {
        let (mut table, pid) = table_with_process();
        let mut parks = Parks::new();
        sleep(&mut parks, pid, pid, 5 * MS, Some(0x40));
        table.get_mut(pid).unwrap().raise_signal(wasm_posix_shared::signal::SIGUSR1);
        parks.note_signal_generated();
        parks.sweep_signals(&table);
        let mut out = [0u8; wire::RECORD_BYTES];
        parks.drain(&mut out, 1, 0, &mut |_, _, _| false);
        assert_eq!(
            i32::from_le_bytes(out[16..20].try_into().unwrap()),
            -(Errno::EFAULT as i32)
        );
    }

    fn child_wait(parks: &mut Parks, pid: u32, tid: u32) -> u64 {
        let wait = crate::wait_child::ChildWait::wait4(-1, 0, 0, 0).unwrap();
        parks
            .park(
                pid,
                tid,
                WaitKind::ChildWait { options: 0 },
                vec![WakeSource::ChildEvent { parent: pid }],
                None,
                Resume::Child(wait),
            )
            .expect("park")
    }

    #[test]
    fn child_waiters_are_offered_only_after_a_child_change() {
        let mut parks = Parks::new();
        let generation = child_wait(&mut parks, 5, 5);
        futex(&mut parks, 5, 6, 0x10, None);
        assert_eq!(parks.take_dirty_child_waiters(), None, "nothing changed yet");
        parks.note_children_changed();
        let waiters = parks.take_dirty_child_waiters().expect("dirty");
        assert_eq!(waiters.len(), 1, "only the child wait is offered, not the futex");
        let (id, pid, tid, _) = waiters[0];
        assert_eq!((pid, tid), (5, 5));
        assert_eq!(parks.take_dirty_child_waiters(), None, "the flag is consumed");

        assert!(parks.finish_child_waiter(id, pid, 42));
        assert_eq!(
            parks.take_completions(),
            vec![Completion { generation, pid: 5, tid: 5, value: 42, flags: 0, remainder: None }]
        );
        assert!(!parks.finish_child_waiter(id, pid, 42), "a decided waiter is gone");
    }

    #[test]
    fn an_interrupted_child_wait_may_be_restarted() {
        let (mut table, pid) = table_with_process();
        let mut parks = Parks::new();
        child_wait(&mut parks, pid, pid);
        table.get_mut(pid).unwrap().raise_signal(wasm_posix_shared::signal::SIGUSR1);
        parks.note_signal_generated();
        parks.sweep_signals(&table);
        let done = parks.take_completions();
        assert_eq!(done[0].value, -(Errno::EINTR as i32));
        assert_eq!(done[0].flags, 0, "SA_RESTART restarts wait4/waitid");
    }

    fn sigtimed(parks: &mut Parks, pid: u32, tid: u32, deadline: Option<MonotonicNs>) -> u64 {
        parks
            .park(
                pid,
                tid,
                WaitKind::SigTimedWait { mask: 1 },
                vec![WakeSource::Signal { pid, tid }],
                deadline,
                Resume::SigTimed(crate::wait_signal::SigWait {
                    mask: 1,
                    info: 0,
                    timeout_ns: deadline.map(|d| d as u64),
                }),
            )
            .expect("park")
    }

    #[test]
    fn a_sigtimedwait_that_runs_out_answers_eagain_and_credits_its_timeout() {
        let mut parks = Parks::new();
        let generation = sigtimed(&mut parks, 3, 3, Some(40 * MS));
        assert_eq!(parks.expire(40 * MS), vec![(3, 3, (40 * MS) as u64)]);
        assert_eq!(
            parks.take_completions(),
            vec![Completion {
                generation,
                pid: 3,
                tid: 3,
                value: -(Errno::EAGAIN as i32),
                flags: 0,
                remainder: None
            }]
        );
    }

    #[test]
    fn sigtimedwaiters_are_offered_signals_only_after_a_generation() {
        let mut parks = Parks::new();
        let generation = sigtimed(&mut parks, 3, 4, None);
        child_wait(&mut parks, 3, 5);
        parks.signals_dirty = false;
        assert!(parks.dirty_signal_waiters().is_empty(), "no generation yet");
        parks.note_signal_generated();
        let waiters = parks.dirty_signal_waiters();
        assert_eq!(waiters.len(), 1, "only the sigtimedwait is offered");
        let (id, pid, tid, wait) = waiters[0];
        assert_eq!((pid, tid, wait.mask), (3, 4, 1));
        assert!(parks.signals_dirty, "the sweep still runs after the offer");
        assert!(parks.finish_signal_waiter(id, pid, tid, 10));
        assert_eq!(parks.take_completions()[0], Completion {
            generation,
            pid: 3,
            tid: 4,
            value: 10,
            flags: 0,
            remainder: None
        });
    }

    #[test]
    fn interrupted_signal_waits_are_never_restarted() {
        let (mut table, pid) = table_with_process();
        let mut parks = Parks::new();
        parks
            .park(pid, pid, WaitKind::SigTimedWait { mask: 0 }, Vec::new(), None, Resume::Suspend)
            .unwrap();
        table.get_mut(pid).unwrap().raise_signal(wasm_posix_shared::signal::SIGUSR1);
        parks.note_signal_generated();
        parks.sweep_signals(&table);
        let done = parks.take_completions();
        assert_eq!(done[0].value, -(Errno::EINTR as i32));
        assert_eq!(done[0].flags, wire::FLAG_SUPPRESS_RESTART);
    }

    #[test]
    fn a_cancelled_sleep_owes_no_remainder() {
        let mut parks = Parks::new();
        sleep(&mut parks, 1, 1, 5 * MS, Some(0x40));
        assert!(parks.cancel_task(1, 1));
        assert_eq!(parks.take_completions()[0].remainder, None);
    }
}
