//! Shadow comparison between the host scheduler and [`crate::wait_queue`].
//!
//! # Why this increment exists
//!
//! Every previous move of a subsystem into Rust followed the same pattern:
//! land the Rust store dormant, wire it behind a flag, flip the flag. That
//! pattern rests on an assumption — that wrong behaviour is *visible*. A
//! `tmpfs` that returns the wrong bytes tells you so.
//!
//! The blocking scheduler breaks that assumption. Its failure mode is a lost
//! wakeup, and a lost wakeup is a silent hang: no error, no log line, no
//! wrong value to diff. The task simply never runs again. There is nothing to
//! notice until a user notices.
//!
//! So the wait queue gets an increment the others did not need. Before any
//! family cuts over, both schedulers run: the host keeps owning every wait,
//! and every park and every wake is *also* recorded here, where the kernel's
//! own decision is computed and compared against what the host actually did.
//! A disagreement is reported loudly, with the specific hang risk it belongs
//! to, while the host is still the one making the decision and no user can be
//! hurt by the answer.
//!
//! # The asymmetry that makes this informative
//!
//! The host over-wakes on purpose. Its broad sweep wakes every parked poll,
//! select, pipe reader and pipe writer regardless of what changed, and three
//! safety timers (10 ms, 50 ms, 500 ms) retry anything the sweep missed. So
//! "the host woke someone the kernel would not have" is the *normal* case for
//! a sweep and says nothing.
//!
//! It says a great deal for a *targeted* wake. If the host woke a task in
//! response to a specific pipe or accept index and the kernel queue would not
//! have, then after cutover that task is not woken at all — that is
//! [`ShadowDivergence::WouldHang`], and it is the one finding that must never
//! be tolerated.
//!
//! The reverse, [`ShadowDivergence::WouldWakeEarly`], is safe but not
//! ignorable: it means the kernel's routing is broader than the host's, which
//! is how a spurious retry storm starts.
//!
//! # What the counters are for
//!
//! [`ShadowReport::unattributed_broad_wakes`] is the number this increment
//! exists to produce. Each one is a task that resumed only because something
//! swept the whole queue, with no identified source that would have reached
//! it precisely. Every one of them is a task that hangs the day the sweep is
//! deleted. Driving that number to zero — not the absence of test failures —
//! is what says the precise routing is complete.
//!
//! [`ShadowReport::safety_net_resolutions`] is hang risk 8.2's counter. A
//! bounded fallback deadline is acceptable through cutover only if it is
//! counted; a silent safety net is exactly the convenient illusion the
//! project's values forbid.
//!
//! # Status
//!
//! The comparator and its taxonomy are complete and tested. The host-side
//! wiring that feeds it live traffic is not in this commit — see the module's
//! entry in the K3 plan for what remains.

extern crate alloc;

use alloc::collections::BTreeMap;
use alloc::vec::Vec;

use crate::wait_queue::{
    ChannelGeneration, MonotonicNs, ParkRequest, WaitKind, WaitQueue, WaiterId, WakeSource,
};

/// One disagreement between the host scheduler and the kernel wait queue.
///
/// Each variant names the hang risk it belongs to, so a report says what the
/// finding *means* rather than only that two sets differed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ShadowDivergence {
    /// The host woke a waiter in response to an identified source, and the
    /// kernel queue would not have woken it.
    ///
    /// **Hang risk 8.2.** After cutover there is no broad sweep to catch
    /// this, so the task is never woken. This is the finding that blocks a
    /// cutover.
    WouldHang {
        waiter: WaiterId,
        pid: u32,
        tid: u32,
        kind: WaitKind,
        source: WakeSource,
    },
    /// The kernel queue would have woken a waiter the host left parked.
    ///
    /// Safe — the task runs, re-checks readiness and re-parks — but it means
    /// the kernel's routing is broader than the host's, which is how a
    /// spurious retry storm begins.
    WouldWakeEarly {
        waiter: WaiterId,
        pid: u32,
        kind: WaitKind,
        source: WakeSource,
    },
    /// The host woke a waiter the shadow has no record of parking.
    ///
    /// Bookkeeping has drifted: some park path is not recording into the
    /// shadow, so the comparison is not covering it and its findings mean
    /// nothing. Fix the instrumentation before trusting any other result.
    WokeUnknownWaiter { waiter: WaiterId },
    /// Both woke the same waiter, for different reasons.
    ///
    /// Most often a deadline the host reached on wall-clock `Date.now()` that
    /// the kernel had not reached on `CLOCK_MONOTONIC`, or the reverse.
    /// **Hang risk 8.7** — that difference is a real pre-existing defect the
    /// migration fixes, so a small number of these is expected and each one
    /// should be explained rather than assumed benign.
    ReasonMismatch {
        waiter: WaiterId,
        host_deadline_driven: bool,
        shadow_deadline_driven: bool,
    },
    /// Both woke the same set, in different orders.
    ///
    /// Ordering is observable: a `poll` that sees a `write` before the `raise`
    /// that follows it behaves differently from one that does not.
    /// **Hang risk 8.3.**
    OrderMismatch {
        host: Vec<WaiterId>,
        shadow: Vec<WaiterId>,
    },
    /// At a point where the machine is idle, the shadow still holds sleepers.
    ///
    /// The host believes nothing is waiting and the kernel believes something
    /// is. One of them has leaked, and if it is the kernel then after cutover
    /// these tasks are parked forever.
    Leaked { waiters: Vec<WaiterId> },
}

impl ShadowDivergence {
    /// Whether this finding blocks a cutover.
    ///
    /// `WouldHang` and `Leaked` are hangs after cutover. `WokeUnknownWaiter`
    /// blocks too, for a different reason: it means the comparison itself is
    /// not covering the path, so a clean report would be meaningless.
    pub fn blocks_cutover(&self) -> bool {
        matches!(
            self,
            Self::WouldHang { .. } | Self::Leaked { .. } | Self::WokeUnknownWaiter { .. }
        )
    }
}

/// What the host scheduler did, as reported to the shadow.
pub struct HostWake {
    /// The source the host attributed the wake to.
    ///
    /// `None` means a broad sweep: `wakeAllBlockedRetries` and the safety
    /// timers wake everything parked without identifying what changed.
    pub source: Option<WakeSource>,
    /// The host's optional pid narrowing.
    pub pid_filter: Option<u32>,
    /// Whether the host held back its signal-safe waiters.
    pub defer_signal_safe: bool,
    /// The waiters the host woke, in the order it woke them.
    pub woke: Vec<WaiterId>,
    /// `CLOCK_MONOTONIC` reading at the moment of the wake.
    pub now_ns: MonotonicNs,
}

/// Aggregate readout across a shadow run.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ShadowReport {
    pub parks_observed: u64,
    pub wakes_observed: u64,
    /// Wakes where the host identified no source.
    pub broad_sweeps: u64,
    /// Waiters resumed only by an unattributed sweep.
    ///
    /// The number this increment exists to produce. Each is a task that hangs
    /// the day the sweep is deleted.
    pub unattributed_broad_wakes: u64,
    /// Waiters resolved by a fallback deadline despite holding a real
    /// readiness source. **Hang risk 8.2's counter.**
    pub safety_net_resolutions: u64,
    /// Waiters whose wake the kernel routed precisely, matching the host.
    pub agreed_targeted_wakes: u64,
    pub divergences: Vec<ShadowDivergence>,
}

impl ShadowReport {
    /// Whether the run is clean enough to cut a family over.
    ///
    /// Deliberately not "no divergences at all": `WouldWakeEarly` and
    /// `ReasonMismatch` are findings to explain, not necessarily to fix,
    /// while an unattributed broad wake means a precise path is missing and
    /// cutting over would hang that task.
    pub fn is_cutover_clean(&self) -> bool {
        self.unattributed_broad_wakes == 0 && !self.divergences.iter().any(|d| d.blocks_cutover())
    }

    pub fn blocking_divergences(&self) -> impl Iterator<Item = &ShadowDivergence> {
        self.divergences.iter().filter(|d| d.blocks_cutover())
    }
}

/// Runs a [`WaitQueue`] alongside the host scheduler and compares them.
///
/// The shadow owns a real wait queue and makes real decisions with it. It
/// never publishes a completion and never wakes a guest: the host remains the
/// only authority for as long as this is in use.
pub struct ShadowScheduler {
    queue: WaitQueue,
    /// Waiters the shadow believes are parked, for the unknown-waiter check.
    known: BTreeMap<WaiterId, (u32, u32)>,
    report: ShadowReport,
}

impl Default for ShadowScheduler {
    fn default() -> Self {
        Self::new()
    }
}

impl ShadowScheduler {
    pub fn new() -> Self {
        Self {
            queue: WaitQueue::new(),
            known: BTreeMap::new(),
            report: ShadowReport::default(),
        }
    }

    pub fn report(&self) -> &ShadowReport {
        &self.report
    }

    /// Mint an execution generation, mirroring a host channel registration.
    pub fn open_channel(&mut self) -> ChannelGeneration {
        self.queue.open_channel()
    }

    /// Record that the host parked a task.
    ///
    /// Returns the identity the host should store alongside its own container
    /// entry. That one extra field is the whole of the host-side bookkeeping
    /// this comparison needs — the host does not gain a parallel index.
    pub fn observe_park(&mut self, request: ParkRequest) -> Result<WaiterId, wasm_posix_shared::Errno> {
        let pid = request.pid;
        let tid = request.tid;
        let id = self.queue.park(request)?;
        self.known.insert(id, (pid, tid));
        self.report.parks_observed += 1;
        Ok(id)
    }

    /// Record that the host woke a set of waiters, and compare.
    pub fn observe_wake(&mut self, host: HostWake) -> Vec<ShadowDivergence> {
        self.report.wakes_observed += 1;
        let mut found = Vec::new();

        for waiter in &host.woke {
            if !self.known.contains_key(waiter) {
                found.push(ShadowDivergence::WokeUnknownWaiter { waiter: *waiter });
            }
        }

        match host.source {
            Some(source) => self.compare_targeted(source, &host, &mut found),
            None => self.absorb_broad_sweep(&host, &mut found),
        }

        self.report.divergences.extend(found.iter().cloned());
        found
    }

    /// Compare a wake the host attributed to a specific source.
    fn compare_targeted(
        &mut self,
        source: WakeSource,
        host: &HostWake,
        found: &mut Vec<ShadowDivergence>,
    ) {
        // Snapshot what the shadow knows about each host-woken waiter before
        // the shadow's own wake consumes them.
        let host_details: Vec<(WaiterId, Option<(u32, u32, WaitKind)>)> = host
            .woke
            .iter()
            .map(|id| {
                let detail = self
                    .queue
                    .get(*id)
                    .map(|s| (s.pid, s.tid, s.kind));
                (*id, detail)
            })
            .collect();

        let (shadow_woken, _deferred) =
            self.queue
                .wake(source, host.pid_filter, host.defer_signal_safe);
        let shadow_ids: Vec<WaiterId> = shadow_woken.iter().map(|w| w.id).collect();

        for (id, detail) in &host_details {
            if shadow_ids.contains(id) {
                continue;
            }
            let Some((pid, tid, kind)) = *detail else {
                // Already reported as WokeUnknownWaiter.
                continue;
            };
            found.push(ShadowDivergence::WouldHang {
                waiter: *id,
                pid,
                tid,
                kind,
                source,
            });
            // Keep the two queues in step: the host resumed this task, so the
            // shadow must stop holding it or every later comparison inherits
            // a waiter that no longer exists.
            self.forget(*id);
        }

        for wake in &shadow_woken {
            if host.woke.contains(&wake.id) {
                self.report.agreed_targeted_wakes += 1;
            } else {
                found.push(ShadowDivergence::WouldWakeEarly {
                    waiter: wake.id,
                    pid: wake.pid,
                    kind: wake.kind,
                    source,
                });
            }
            self.known.remove(&wake.id);
        }

        let agreed_host: Vec<WaiterId> = host
            .woke
            .iter()
            .copied()
            .filter(|id| shadow_ids.contains(id))
            .collect();
        let agreed_shadow: Vec<WaiterId> = shadow_ids
            .iter()
            .copied()
            .filter(|id| host.woke.contains(id))
            .collect();
        if agreed_host != agreed_shadow {
            found.push(ShadowDivergence::OrderMismatch {
                host: agreed_host,
                shadow: agreed_shadow,
            });
        }
    }

    /// Absorb a wake the host could not attribute to any source.
    ///
    /// Nothing is compared, because there is nothing to compare against: the
    /// host swept without deciding. What is recorded is that these waiters
    /// resumed with no precise path that would have reached them — the
    /// measure of how much of the machine still depends on sweeping.
    fn absorb_broad_sweep(&mut self, host: &HostWake, found: &mut Vec<ShadowDivergence>) {
        let _ = found;
        self.report.broad_sweeps += 1;
        for id in &host.woke {
            if self.known.contains_key(id) {
                self.report.unattributed_broad_wakes += 1;
            }
            self.forget(*id);
        }
    }

    /// Record that the host expired a set of deadline waiters, and compare.
    pub fn observe_expire(
        &mut self,
        now_ns: MonotonicNs,
        host_expired: &[WaiterId],
    ) -> Vec<ShadowDivergence> {
        let mut found = Vec::new();

        let had_sources: BTreeMap<WaiterId, bool> = host_expired
            .iter()
            .filter_map(|id| self.queue.get(*id).map(|s| (*id, !s.sources.is_empty())))
            .collect();

        let shadow_expired = self.queue.expire(now_ns);
        let shadow_ids: Vec<WaiterId> = shadow_expired.iter().map(|w| w.id).collect();

        for id in host_expired {
            if !self.known.contains_key(id) {
                found.push(ShadowDivergence::WokeUnknownWaiter { waiter: *id });
                continue;
            }
            // A waiter that held a readiness source and was resolved by a
            // timer instead is the safety net doing the scheduler's job.
            if *had_sources.get(id).unwrap_or(&false) {
                self.report.safety_net_resolutions += 1;
            }
            if !shadow_ids.contains(id) {
                // The host's wall-clock deadline fired where the kernel's
                // monotonic one had not. Hang risk 8.7.
                found.push(ShadowDivergence::ReasonMismatch {
                    waiter: *id,
                    host_deadline_driven: true,
                    shadow_deadline_driven: false,
                });
                self.forget(*id);
            }
        }

        for wake in &shadow_expired {
            if !host_expired.contains(&wake.id) {
                found.push(ShadowDivergence::ReasonMismatch {
                    waiter: wake.id,
                    host_deadline_driven: false,
                    shadow_deadline_driven: true,
                });
            }
            self.known.remove(&wake.id);
        }

        self.report.divergences.extend(found.iter().cloned());
        found
    }

    /// Record that the host retired a channel generation.
    pub fn observe_retire(&mut self, channel: ChannelGeneration) {
        for wake in self.queue.retire_channel(channel) {
            self.known.remove(&wake.id);
        }
    }

    /// Record that the host cancelled every wait held by one task.
    pub fn observe_cancel_task(&mut self, pid: u32, tid: u32) {
        for wake in self.queue.cancel_task(pid, tid) {
            self.known.remove(&wake.id);
        }
    }

    /// Check both schedulers at a point where the machine should be idle.
    ///
    /// The host having nothing parked while the shadow still holds sleepers
    /// is a leak, and after cutover those tasks never run again.
    pub fn observe_quiesce(&mut self) -> Vec<ShadowDivergence> {
        let mut found = Vec::new();
        if !self.queue.is_empty() {
            found.push(ShadowDivergence::Leaked {
                waiters: self.queue.iter().map(|s| s.id).collect(),
            });
        }
        self.report.divergences.extend(found.iter().cloned());
        found
    }

    fn forget(&mut self, id: WaiterId) {
        self.known.remove(&id);
        self.queue.cancel(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blocked_retry::BlockingRetryOperation;

    const MS: MonotonicNs = 1_000_000;

    fn park(
        s: &mut ShadowScheduler,
        channel: ChannelGeneration,
        pid: u32,
        kind: WaitKind,
        sources: Vec<WakeSource>,
        deadline: Option<MonotonicNs>,
    ) -> WaiterId {
        s.observe_park(ParkRequest {
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

    fn targeted(source: WakeSource, woke: Vec<WaiterId>) -> HostWake {
        HostWake {
            source: Some(source),
            pid_filter: None,
            defer_signal_safe: false,
            woke,
            now_ns: 0,
        }
    }

    fn sweep(woke: Vec<WaiterId>) -> HostWake {
        HostWake {
            source: None,
            pid_filter: None,
            defer_signal_safe: false,
            woke,
            now_ns: 0,
        }
    }

    #[test]
    fn agreement_on_a_targeted_wake_produces_no_finding() {
        let mut s = ShadowScheduler::new();
        let c = s.open_channel();
        let a = park(&mut s, c, 1, WaitKind::Poll, alloc::vec![WakeSource::Pipe(4)], None);

        let found = s.observe_wake(targeted(WakeSource::Pipe(4), alloc::vec![a]));
        assert!(found.is_empty(), "{found:?}");
        assert_eq!(s.report().agreed_targeted_wakes, 1);
        assert!(s.observe_quiesce().is_empty());
        assert!(s.report().is_cutover_clean());
    }

    #[test]
    fn a_waiter_the_kernel_would_not_reach_is_reported_as_a_hang() {
        // The host woke this task because of a specific pipe, but the task was
        // registered against a different source. After cutover nothing wakes
        // it. This is the finding that blocks a cutover.
        let mut s = ShadowScheduler::new();
        let c = s.open_channel();
        let a = park(&mut s, c, 1, WaitKind::Poll, alloc::vec![WakeSource::Pipe(9)], None);

        let found = s.observe_wake(targeted(WakeSource::Pipe(4), alloc::vec![a]));
        assert_eq!(found.len(), 1);
        match &found[0] {
            ShadowDivergence::WouldHang { waiter, pid, source, .. } => {
                assert_eq!(*waiter, a);
                assert_eq!(*pid, 1);
                assert_eq!(*source, WakeSource::Pipe(4));
            }
            other => panic!("expected WouldHang, got {other:?}"),
        }
        assert!(found[0].blocks_cutover());
        assert!(!s.report().is_cutover_clean());
        // The shadow must not keep holding a task the host already resumed.
        assert!(s.observe_quiesce().is_empty());
    }

    #[test]
    fn a_waiter_only_the_kernel_would_reach_is_reported_as_early_not_as_a_hang() {
        let mut s = ShadowScheduler::new();
        let c = s.open_channel();
        let a = park(&mut s, c, 1, WaitKind::Poll, alloc::vec![WakeSource::Pipe(4)], None);
        let b = park(&mut s, c, 2, WaitKind::Poll, alloc::vec![WakeSource::Pipe(4)], None);

        // The host woke only one of the two waiters on this pipe.
        let found = s.observe_wake(targeted(WakeSource::Pipe(4), alloc::vec![a]));
        assert_eq!(found.len(), 1);
        match &found[0] {
            ShadowDivergence::WouldWakeEarly { waiter, .. } => assert_eq!(*waiter, b),
            other => panic!("expected WouldWakeEarly, got {other:?}"),
        }
        assert!(
            !found[0].blocks_cutover(),
            "waking too eagerly is a retry storm, not a hang"
        );
    }

    #[test]
    fn a_broad_sweep_counts_every_waiter_it_resumed() {
        // This is the number the increment exists to produce: tasks that ran
        // again only because something swept the whole queue.
        let mut s = ShadowScheduler::new();
        let c = s.open_channel();
        let a = park(&mut s, c, 1, WaitKind::Poll, alloc::vec![WakeSource::Pipe(1)], None);
        let b = park(&mut s, c, 2, WaitKind::Select, alloc::vec![WakeSource::Pipe(2)], None);
        let d = park(&mut s, c, 3, WaitKind::AdvisoryLock, alloc::vec![WakeSource::AdvisoryLock], None);

        let found = s.observe_wake(sweep(alloc::vec![a, b, d]));
        assert!(found.is_empty(), "a sweep decides nothing, so it proves nothing");
        assert_eq!(s.report().broad_sweeps, 1);
        assert_eq!(
            s.report().unattributed_broad_wakes,
            3,
            "three tasks would hang the day the sweep is deleted"
        );
        assert!(
            !s.report().is_cutover_clean(),
            "unattributed sweeps must block a cutover even with no divergence"
        );
        assert!(s.observe_quiesce().is_empty());
    }

    #[test]
    fn a_fallback_timer_resolving_a_readiness_waiter_is_counted() {
        // Hang risk 8.2: a safety net is acceptable only while it is counted.
        let mut s = ShadowScheduler::new();
        let c = s.open_channel();
        let a = park(
            &mut s,
            c,
            1,
            WaitKind::Transfer { operation: BlockingRetryOperation::Read },
            alloc::vec![WakeSource::Pipe(1)],
            Some(10 * MS),
        );
        let pure_sleep = park(&mut s, c, 2, WaitKind::Sleep, Vec::new(), Some(10 * MS));

        let found = s.observe_expire(11 * MS, &[a, pure_sleep]);
        assert!(found.is_empty(), "{found:?}");
        assert_eq!(
            s.report().safety_net_resolutions,
            1,
            "only the waiter that had a real readiness source counts as a safety net"
        );
    }

    #[test]
    fn a_wall_clock_deadline_the_kernel_has_not_reached_is_a_reason_mismatch() {
        // Hang risk 8.7: the host compares Date.now(), the kernel compares
        // CLOCK_MONOTONIC. A clock step makes them disagree, and the shadow is
        // where that pre-existing defect becomes visible instead of assumed.
        let mut s = ShadowScheduler::new();
        let c = s.open_channel();
        let a = park(&mut s, c, 1, WaitKind::Sleep, Vec::new(), Some(100 * MS));

        let found = s.observe_expire(10 * MS, &[a]);
        assert_eq!(found.len(), 1);
        match &found[0] {
            ShadowDivergence::ReasonMismatch {
                waiter,
                host_deadline_driven,
                shadow_deadline_driven,
            } => {
                assert_eq!(*waiter, a);
                assert!(*host_deadline_driven);
                assert!(!*shadow_deadline_driven);
            }
            other => panic!("expected ReasonMismatch, got {other:?}"),
        }
    }

    #[test]
    fn a_waiter_the_shadow_never_saw_park_invalidates_the_comparison() {
        let mut s = ShadowScheduler::new();
        let found = s.observe_wake(targeted(WakeSource::Pipe(1), alloc::vec![WaiterId(999)]));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0], ShadowDivergence::WokeUnknownWaiter { waiter: WaiterId(999) });
        assert!(
            found[0].blocks_cutover(),
            "a clean report means nothing if a park path is uninstrumented"
        );
    }

    #[test]
    fn a_leak_at_quiesce_is_reported() {
        let mut s = ShadowScheduler::new();
        let c = s.open_channel();
        let a = park(&mut s, c, 1, WaitKind::Poll, alloc::vec![WakeSource::Pipe(1)], None);

        let found = s.observe_quiesce();
        assert_eq!(found.len(), 1);
        match &found[0] {
            ShadowDivergence::Leaked { waiters } => assert_eq!(waiters, &alloc::vec![a]),
            other => panic!("expected Leaked, got {other:?}"),
        }
        assert!(found[0].blocks_cutover());
    }

    #[test]
    fn a_retired_generation_leaves_no_leak_behind() {
        let mut s = ShadowScheduler::new();
        let c = s.open_channel();
        park(&mut s, c, 1, WaitKind::Poll, alloc::vec![WakeSource::Pipe(1)], None);
        s.observe_retire(c);
        assert!(s.observe_quiesce().is_empty());
    }

    #[test]
    fn cancelling_a_task_clears_its_waits_from_the_shadow() {
        let mut s = ShadowScheduler::new();
        let c = s.open_channel();
        park(&mut s, c, 5, WaitKind::Poll, alloc::vec![WakeSource::Pipe(1)], None);
        park(&mut s, c, 5, WaitKind::Futex, alloc::vec![WakeSource::Futex { pid: 5, addr: 8 }], None);
        s.observe_cancel_task(5, 5);
        assert!(s.observe_quiesce().is_empty());
    }

    #[test]
    fn order_differences_on_an_agreed_set_are_reported() {
        // Hang risk 8.3: ordering is observable, so an agreed set woken in a
        // different order is still a difference in behaviour.
        let mut s = ShadowScheduler::new();
        let c = s.open_channel();
        let a = park(&mut s, c, 1, WaitKind::Poll, alloc::vec![WakeSource::Pipe(1)], None);
        let b = park(&mut s, c, 2, WaitKind::Poll, alloc::vec![WakeSource::Pipe(1)], None);

        let found = s.observe_wake(targeted(WakeSource::Pipe(1), alloc::vec![b, a]));
        assert_eq!(found.len(), 1);
        match &found[0] {
            ShadowDivergence::OrderMismatch { host, shadow } => {
                assert_eq!(host, &alloc::vec![b, a]);
                assert_eq!(shadow, &alloc::vec![a, b]);
            }
            other => panic!("expected OrderMismatch, got {other:?}"),
        }
    }

    // ---- differential runs against a model of the host's mechanisms ----
    //
    // The model reproduces the decision rules transcribed from
    // host/src/kernel-worker.ts, so these are comparisons against the host's
    // behaviour rather than against the wait queue restated.

    /// A model of the host's parking containers and wake routing.
    ///
    /// Rules transcribed from `kernel-worker.ts`:
    ///   - `wakeBlockedPollRetriesForPipe` (`:15811`): match on
    ///     `pipeIndices.includes(idx)`, optional pid narrowing, signal-safe
    ///     entries deferred.
    ///   - `wakeAllBlockedRetries` (`:16358`): snapshot and clear every poll
    ///     retry, select retry, pipe reader and pipe writer, unconditionally.
    ///   - `wakeBlockedAdvisoryLockRetries` (`:16186`): every advisory-lock
    ///     retry, no identity.
    struct HostModel {
        entries: Vec<HostEntry>,
    }

    struct HostEntry {
        id: WaiterId,
        pid: u32,
        sources: Vec<WakeSource>,
        signal_safe: bool,
        /// True for the four container kinds the broad sweep drains.
        swept_by_broad_wake: bool,
    }

    impl HostModel {
        fn new() -> Self {
            Self { entries: Vec::new() }
        }

        fn park(
            &mut self,
            id: WaiterId,
            pid: u32,
            sources: Vec<WakeSource>,
            signal_safe: bool,
            swept_by_broad_wake: bool,
        ) {
            self.entries.push(HostEntry {
                id,
                pid,
                sources,
                signal_safe,
                swept_by_broad_wake,
            });
        }

        fn wake_targeted(
            &mut self,
            source: WakeSource,
            pid_filter: Option<u32>,
            defer_signal_safe: bool,
        ) -> Vec<WaiterId> {
            let mut woke = Vec::new();
            self.entries.retain(|e| {
                if let Some(pid) = pid_filter {
                    if e.pid != pid {
                        return true;
                    }
                }
                if !e.sources.contains(&source) {
                    return true;
                }
                if defer_signal_safe && e.signal_safe {
                    return true;
                }
                woke.push(e.id);
                false
            });
            woke
        }

        fn wake_all(&mut self) -> Vec<WaiterId> {
            let mut woke = Vec::new();
            self.entries.retain(|e| {
                if e.swept_by_broad_wake {
                    woke.push(e.id);
                    false
                } else {
                    true
                }
            });
            woke
        }
    }

    #[test]
    fn differential_targeted_pipe_traffic_agrees_end_to_end() {
        let mut s = ShadowScheduler::new();
        let mut host = HostModel::new();
        let c = s.open_channel();

        // Twelve waiters spread over four pipe indices and three pids, the
        // shape a pipeline of forked children produces.
        let mut ids = Vec::new();
        for i in 0..12u32 {
            let pipe = i % 4;
            let pid = 1 + (i % 3);
            let id = s
                .observe_park(ParkRequest {
                    pid,
                    tid: pid,
                    channel: c,
                    kind: WaitKind::Poll,
                    sources: alloc::vec![WakeSource::Pipe(pipe)],
                    deadline: None,
                    target: None,
                    signal_safe: false,
                })
                .expect("park");
            host.park(id, pid, alloc::vec![WakeSource::Pipe(pipe)], false, true);
            ids.push(id);
        }

        for pipe in 0..4u32 {
            let woke = host.wake_targeted(WakeSource::Pipe(pipe), None, false);
            let found = s.observe_wake(targeted(WakeSource::Pipe(pipe), woke));
            assert!(found.is_empty(), "pipe {pipe}: {found:?}");
        }

        assert!(s.observe_quiesce().is_empty());
        assert_eq!(s.report().agreed_targeted_wakes, 12);
        assert_eq!(s.report().unattributed_broad_wakes, 0);
        assert!(s.report().is_cutover_clean());
    }

    #[test]
    fn differential_pid_narrowed_wake_agrees() {
        let mut s = ShadowScheduler::new();
        let mut host = HostModel::new();
        let c = s.open_channel();

        let mut ids = Vec::new();
        for pid in 1..=3u32 {
            let id = s
                .observe_park(ParkRequest {
                    pid,
                    tid: pid,
                    channel: c,
                    kind: WaitKind::Transfer { operation: BlockingRetryOperation::Recv },
                    sources: alloc::vec![WakeSource::Pipe(7)],
                    deadline: None,
                    target: None,
                    signal_safe: false,
                })
                .expect("park");
            host.park(id, pid, alloc::vec![WakeSource::Pipe(7)], false, true);
            ids.push(id);
        }

        let woke = host.wake_targeted(WakeSource::Pipe(7), Some(2), false);
        assert_eq!(woke.len(), 1);
        let found = s.observe_wake(HostWake {
            source: Some(WakeSource::Pipe(7)),
            pid_filter: Some(2),
            defer_signal_safe: false,
            woke,
            now_ns: 0,
        });
        assert!(found.is_empty(), "{found:?}");
    }

    #[test]
    fn differential_signal_safe_deferral_agrees() {
        let mut s = ShadowScheduler::new();
        let mut host = HostModel::new();
        let c = s.open_channel();

        let plain = s
            .observe_park(ParkRequest {
                pid: 1,
                tid: 1,
                channel: c,
                kind: WaitKind::Poll,
                sources: alloc::vec![WakeSource::Pipe(1)],
                deadline: None,
                target: None,
                signal_safe: false,
            })
            .expect("park");
        host.park(plain, 1, alloc::vec![WakeSource::Pipe(1)], false, true);

        let safe = s
            .observe_park(ParkRequest {
                pid: 2,
                tid: 2,
                channel: c,
                kind: WaitKind::Poll,
                sources: alloc::vec![WakeSource::Pipe(1)],
                deadline: None,
                target: None,
                signal_safe: true,
            })
            .expect("park");
        host.park(safe, 2, alloc::vec![WakeSource::Pipe(1)], true, true);

        let woke = host.wake_targeted(WakeSource::Pipe(1), None, true);
        assert_eq!(woke, alloc::vec![plain], "the signal-safe waiter is held back");
        let found = s.observe_wake(HostWake {
            source: Some(WakeSource::Pipe(1)),
            pid_filter: None,
            defer_signal_safe: true,
            woke,
            now_ns: 0,
        });
        assert!(found.is_empty(), "{found:?}");

        let woke = host.wake_targeted(WakeSource::Pipe(1), None, false);
        let found = s.observe_wake(targeted(WakeSource::Pipe(1), woke));
        assert!(found.is_empty(), "{found:?}");
        assert!(s.observe_quiesce().is_empty());
    }

    #[test]
    fn differential_broad_sweep_exposes_how_much_depends_on_sweeping() {
        // The host's `wakeAllBlockedRetries` drains four containers with no
        // regard for what changed. Nothing here is a divergence — and that is
        // the point: a sweep proves nothing, so every waiter it resumed is
        // recorded as unaccounted for.
        let mut s = ShadowScheduler::new();
        let mut host = HostModel::new();
        let c = s.open_channel();

        for i in 0..6u32 {
            let id = s
                .observe_park(ParkRequest {
                    pid: 1 + i,
                    tid: 1 + i,
                    channel: c,
                    kind: if i % 2 == 0 { WaitKind::Poll } else { WaitKind::Select },
                    sources: alloc::vec![WakeSource::Pipe(i)],
                    deadline: None,
                    target: None,
                    signal_safe: false,
                })
                .expect("park");
            host.park(id, 1 + i, alloc::vec![WakeSource::Pipe(i)], false, true);
        }
        // An advisory-lock waiter, which the broad sweep does not drain.
        let lock = s
            .observe_park(ParkRequest {
                pid: 20,
                tid: 20,
                channel: c,
                kind: WaitKind::AdvisoryLock,
                sources: alloc::vec![WakeSource::AdvisoryLock],
                deadline: None,
                target: None,
                signal_safe: false,
            })
            .expect("park");
        host.park(lock, 20, alloc::vec![WakeSource::AdvisoryLock], false, false);

        let woke = host.wake_all();
        assert_eq!(woke.len(), 6);
        let found = s.observe_wake(sweep(woke));
        assert!(found.is_empty());
        assert_eq!(
            s.report().unattributed_broad_wakes,
            6,
            "six tasks resumed with no source that would have reached them"
        );
        assert!(!s.report().is_cutover_clean());

        // The lock waiter is still parked in both, so quiesce is not clean --
        // and that is correct, because the machine is not idle.
        let leaked = s.observe_quiesce();
        assert_eq!(leaked.len(), 1);
    }

    #[test]
    fn differential_exec_generation_reuse_agrees() {
        // The invariant that motivates ChannelGeneration: a pre-exec waiter
        // must not be completed by a post-exec wake on the same pid.
        let mut s = ShadowScheduler::new();
        let mut host = HostModel::new();

        let before = s.open_channel();
        let stale = s
            .observe_park(ParkRequest {
                pid: 42,
                tid: 42,
                channel: before,
                kind: WaitKind::Poll,
                sources: alloc::vec![WakeSource::Pipe(3)],
                deadline: None,
                target: None,
                signal_safe: false,
            })
            .expect("park");
        host.park(stale, 42, alloc::vec![WakeSource::Pipe(3)], false, true);

        // exec: the host drops its entry, the shadow retires the generation.
        host.entries.retain(|e| e.id != stale);
        s.observe_retire(before);

        let after = s.open_channel();
        let fresh = s
            .observe_park(ParkRequest {
                pid: 42,
                tid: 42,
                channel: after,
                kind: WaitKind::Poll,
                sources: alloc::vec![WakeSource::Pipe(3)],
                deadline: None,
                target: None,
                signal_safe: false,
            })
            .expect("park");
        host.park(fresh, 42, alloc::vec![WakeSource::Pipe(3)], false, true);

        let woke = host.wake_targeted(WakeSource::Pipe(3), None, false);
        assert_eq!(woke, alloc::vec![fresh]);
        let found = s.observe_wake(targeted(WakeSource::Pipe(3), woke));
        assert!(found.is_empty(), "{found:?}");
        assert!(s.observe_quiesce().is_empty());
    }

    #[test]
    fn differential_a_lost_kernel_push_is_caught_as_a_hang() {
        // The failure this whole increment exists to catch. The host resolves
        // the waiter through its accept path; the kernel never registered the
        // accept source, so after cutover this task is never woken. The shadow
        // reports it while the host is still deciding and no user is hurt.
        let mut s = ShadowScheduler::new();
        let mut host = HostModel::new();
        let c = s.open_channel();

        // The kernel-side registration records only a pipe source; the host
        // knows the waiter is also an accept waiter.
        let id = s
            .observe_park(ParkRequest {
                pid: 1,
                tid: 1,
                channel: c,
                kind: WaitKind::Transfer { operation: BlockingRetryOperation::Accept },
                sources: alloc::vec![WakeSource::Pipe(1)],
                deadline: None,
                target: None,
                signal_safe: false,
            })
            .expect("park");
        host.park(
            id,
            1,
            alloc::vec![WakeSource::Pipe(1), WakeSource::Accept(5)],
            false,
            true,
        );

        let woke = host.wake_targeted(WakeSource::Accept(5), None, false);
        assert_eq!(woke, alloc::vec![id]);
        let found = s.observe_wake(targeted(WakeSource::Accept(5), woke));
        assert_eq!(found.len(), 1);
        assert!(matches!(found[0], ShadowDivergence::WouldHang { .. }));
        assert!(!s.report().is_cutover_clean());
    }
}
