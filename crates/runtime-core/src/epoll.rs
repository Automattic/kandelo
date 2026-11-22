//! Readiness subscriptions for epoll. Callbacks enqueue candidates even if a
//! descriptor stays readable between waits; delivery always rechecks state.
use crate::{descriptor_backing::with_epolls, lock::OfdId};
use alloc::vec::Vec;
use wasm_posix_shared::epoll::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Source {
    Pipe(u32, u8),
    Accept(u32),
    Pty(u32, bool),
    Description(OfdId),
    Backing(crate::ofd::FileType, i64),
    Network(i32),
    Device(i64),
    DatagramCapacity(OfdId),
}

// The index and backings share one lock. Candidate/index callbacks never allocate or
// observe half-published subscriptions. Values carry a unique registration id;
// a moved dense slot updates its existing index entries before it can be reused.
use crate::{
    PreparedMap,
    descriptor_backing::SharedBackingTable,
    prepared_map::{MapMemory, PreparedEntry},
    process::{EpollInstance, EpollInterest},
};
use wasm_posix_shared::Errno;

// Epoll metadata must not consume filesystem-cache admission. Credits track
// live index bytes, while allocation failure (not a new watch quota) bounds it.
static INDEX_MEMORY: crate::metadata_budget::MetadataBudget =
    crate::metadata_budget::MetadataBudget::new(usize::MAX);

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct SubscriptionKey {
    source: Source,
    registration: u64,
}
#[derive(Clone, Copy)]
struct Target {
    instance: usize,
    slot: usize,
}
impl MapMemory for SubscriptionKey {
    fn heap_bytes(&self) -> Result<usize, Errno> {
        Ok(0)
    }
}
impl MapMemory for Target {
    fn heap_bytes(&self) -> Result<usize, Errno> {
        Ok(0)
    }
}

pub struct Table {
    backings: SharedBackingTable<EpollInstance>,
    subscriptions: PreparedMap<SubscriptionKey, Target>,
    last_registration: u64,
    notification_epoch: u64,
    #[cfg(test)]
    pub notification_visits: usize,
}
impl core::ops::Deref for Table {
    type Target = SharedBackingTable<EpollInstance>;
    fn deref(&self) -> &Self::Target {
        &self.backings
    }
}
impl core::ops::DerefMut for Table {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.backings
    }
}
impl Table {
    pub(crate) fn new() -> Self {
        Self {
            backings: SharedBackingTable::new(),
            subscriptions: PreparedMap::new(),
            last_registration: 0,
            notification_epoch: 0,
            #[cfg(test)]
            notification_visits: 0,
        }
    }

    #[cfg(test)]
    pub fn subscription_count(&self) -> usize {
        self.subscriptions.len()
    }

    pub fn release(&mut self, idx: usize) -> bool {
        let released = self.backings.release_take(idx);
        if let Some(ep) = released.value {
            for i in ep.interests {
                for source in i.sources {
                    self.subscriptions.remove(&SubscriptionKey {
                        source,
                        registration: i.registration,
                    });
                }
            }
        }
        released.final_reference
    }

    fn prepare_sources(
        &self,
        sources: &[Source],
        registration: u64,
        target: Target,
    ) -> Result<Vec<PreparedEntry<SubscriptionKey, Target>>, Errno> {
        let mut prepared = Vec::new();
        prepared
            .try_reserve_exact(sources.len())
            .map_err(|_| Errno::ENOMEM)?;
        for source in sources {
            let key = SubscriptionKey {
                source: *source,
                registration,
            };
            if !self.subscriptions.contains_key(&key) {
                let credit =
                    PreparedEntry::<SubscriptionKey, Target>::reserve_in(&INDEX_MEMORY, 0)?;
                prepared.push(PreparedEntry::new_reserved_in(
                    &INDEX_MEMORY,
                    key,
                    target,
                    credit,
                )?);
            }
        }
        Ok(prepared)
    }

    pub fn replace_sources(
        &mut self,
        idx: usize,
        slot: usize,
        sources: Vec<Source>,
    ) -> Result<(), Errno> {
        let i = &self.backings.get(idx).ok_or(Errno::EBADF)?.interests[slot];
        if i.sources == sources {
            return Ok(());
        }
        let registration = i.registration;
        let prepared = self.prepare_sources(
            &sources,
            registration,
            Target {
                instance: idx,
                slot,
            },
        )?;
        let sampled = self.needs_sampling(&sources);
        // Keep both source sets live until every new node has been prepared.
        let i = &mut self.backings.get_mut(idx).unwrap().interests[slot];
        for source in &i.sources {
            if !sources.contains(source) {
                self.subscriptions.remove(&SubscriptionKey {
                    source: *source,
                    registration,
                });
            }
        }
        i.sources = sources;
        let ep = self.backings.get_mut(idx).unwrap();
        if sampled {
            if !ep.sampled.contains(&slot) {
                ep.sampled.push(slot);
            }
        } else {
            ep.sampled.retain(|s| *s != slot);
        }
        for entry in prepared {
            self.subscriptions.publish_io(entry);
        }
        self.update_parent_sampling(idx, 0);
        Ok(())
    }

    pub fn register(
        &mut self,
        idx: usize,
        pos: Option<usize>,
        mut interest: EpollInterest,
    ) -> Result<(), Errno> {
        let sampled = self.needs_sampling(&interest.sources);
        let ep = self.backings.get(idx).ok_or(Errno::EBADF)?;
        let slot = pos.unwrap_or(ep.interests.len());
        let registration = self.last_registration.checked_add(1).ok_or(Errno::ENOMEM)?;
        let prepared = self.prepare_sources(
            &interest.sources,
            registration,
            Target {
                instance: idx,
                slot,
            },
        )?;
        let ep = self.backings.get_mut(idx).unwrap();
        if pos.is_none() {
            ep.interests.try_reserve(1).map_err(|_| Errno::ENOMEM)?;
        }
        if pos.is_none() {
            // Reserve a sampler slot even for a notified source: a nested
            // child can acquire a sampling-only provider later. Propagating
            // that relationship must never fail after ctl publication.
            ep.sampled
                .try_reserve(ep.interests.len() + 1 - ep.sampled.len())
                .map_err(|_| Errno::ENOMEM)?;
        }
        // Publication from here is allocation-free. A refused MOD leaves its
        // old event/data, queue position and subscriptions untouched.
        if let Some(slot) = pos {
            ep.dequeue(slot);
            let old = &ep.interests[slot];
            for source in &old.sources {
                self.subscriptions.remove(&SubscriptionKey {
                    source: *source,
                    registration: old.registration,
                });
            }
            ep.sampled.retain(|s| *s != slot);
        }
        interest.registration = registration;
        interest.ready_prev = None;
        interest.ready_next = None;
        interest.queued = false;
        if let Some(slot) = pos {
            ep.interests[slot] = interest;
        } else {
            ep.interests.push(interest);
        }
        if sampled {
            ep.sampled.push(slot);
        }
        ep.enqueue(slot);
        if ep.waiters != 0 {
            crate::wakeup::push_epoll_ready();
        }
        self.last_registration = registration;
        for entry in prepared {
            self.subscriptions.publish_io(entry);
        }
        self.update_parent_sampling(idx, 0);
        Ok(())
    }

    pub fn remove(&mut self, idx: usize, slot: usize) {
        let ep = self.backings.get_mut(idx).unwrap();
        ep.dequeue(slot);
        for source in &ep.interests[slot].sources {
            self.subscriptions.remove(&SubscriptionKey {
                source: *source,
                registration: ep.interests[slot].registration,
            });
        }
        ep.sampled.retain(|s| *s != slot);
        ep.interests.swap_remove(slot);
        if slot < ep.interests.len() {
            let old_slot = ep.interests.len();
            for sampled in &mut ep.sampled {
                if *sampled == old_slot {
                    *sampled = slot;
                }
            }
            let moved = &ep.interests[slot];
            if moved.queued {
                if let Some(prev) = moved.ready_prev {
                    ep.interests[prev].ready_next = Some(slot);
                } else {
                    ep.ready_head = Some(slot);
                }
                let next = ep.interests[slot].ready_next;
                if let Some(next) = next {
                    ep.interests[next].ready_prev = Some(slot);
                } else {
                    ep.ready_tail = Some(slot);
                }
            }
            for source in &ep.interests[slot].sources {
                self.subscriptions
                    .get_mut(&SubscriptionKey {
                        source: *source,
                        registration: ep.interests[slot].registration,
                    })
                    .unwrap()
                    .slot = slot;
            }
        }
        ep.cursor %= ep.interests.len().max(1);
        self.update_parent_sampling(idx, 0);
    }

    /// Only a path entering parent or leaving child can become invalid.
    /// Use the existing graph and reverse index directly, with no fallible
    /// graph snapshot between ctl validation and subscription publication.
    pub fn check_graph(&self, parent: usize, child: usize) -> Result<(), Errno> {
        fn below(t: &Table, node: usize, forbidden: usize, depth: usize) -> Result<usize, Errno> {
            if node == forbidden || depth > 4 {
                return Err(Errno::ELOOP);
            }
            let mut longest = 0;
            if let Some(ep) = t.backings.get(node) {
                for i in &ep.interests {
                    for source in &i.sources {
                        if let Source::Backing(crate::ofd::FileType::Epoll, h) = *source {
                            longest = longest
                                .max(1 + below(t, (-(h + 1)) as usize, forbidden, depth + 1)?);
                        }
                    }
                }
            }
            Ok(longest)
        }
        fn above(t: &Table, node: usize, depth: usize) -> Result<usize, Errno> {
            if depth > 4 {
                return Err(Errno::ELOOP);
            }
            let source = Source::Backing(crate::ofd::FileType::Epoll, -(node as i64 + 1));
            let mut after = SubscriptionKey {
                source,
                registration: 0,
            };
            let mut longest = 0;
            while let Some((key, target)) = t.subscriptions.next_after(&after) {
                if key.source != source {
                    break;
                }
                after = *key;
                longest = longest.max(1 + above(t, target.instance, depth + 1)?);
            }
            Ok(longest)
        }
        if above(self, parent, 0)? + 1 + below(self, child, parent, 0)? > 4 {
            Err(Errno::ELOOP)
        } else {
            Ok(())
        }
    }

    fn needs_sampling(&self, sources: &[Source]) -> bool {
        needs_sampling(sources)
            || sources.iter().any(|s| {
                if let Source::Backing(crate::ofd::FileType::Epoll, h) = *s {
                    self.backings
                        .get((-(h + 1)) as usize)
                        .is_some_and(|ep| !ep.sampled.is_empty())
                } else {
                    false
                }
            })
    }

    fn update_parent_sampling(&mut self, idx: usize, depth: u32) {
        if depth == 4 {
            return;
        }
        let source = Source::Backing(crate::ofd::FileType::Epoll, -(idx as i64 + 1));
        let mut after = SubscriptionKey {
            source,
            registration: 0,
        };
        while let Some((key, target)) = self.subscriptions.next_after(&after) {
            if key.source != source {
                break;
            }
            after = *key;
            let target = *target;
            let sampled = self.needs_sampling(
                &self.backings.get(target.instance).unwrap().interests[target.slot].sources,
            );
            let ep = self.backings.get_mut(target.instance).unwrap();
            let was_sampled = ep.sampled.contains(&target.slot);
            if was_sampled == sampled {
                continue;
            }
            if sampled {
                ep.sampled.push(target.slot);
            } else {
                ep.sampled.retain(|s| *s != target.slot);
            }
            self.update_parent_sampling(target.instance, depth + 1);
        }
    }

    fn invalidate_authority(&mut self, source: Source, depth: u32) {
        let mut after = SubscriptionKey {
            source,
            registration: 0,
        };
        while let Some((key, target)) = self.subscriptions.next_after(&after) {
            if key.source != source {
                break;
            }
            after = *key;
            let target = *target;
            let ep = self.backings.get_mut(target.instance).unwrap();
            // An alias loss requires revalidation, but is not a new ET edge.
            ep.enqueue(target.slot);
            if depth < 4 {
                self.invalidate_authority(
                    Source::Backing(crate::ofd::FileType::Epoll, -(target.instance as i64 + 1)),
                    depth + 1,
                );
            }
        }
    }

    fn notify(&mut self, source: Source, events: u32, depth: u32, epoch: u64) {
        let mut after = SubscriptionKey {
            source,
            registration: 0,
        };
        let mut exclusive_selected = false;
        while let Some((key, target)) = self.subscriptions.next_after(&after) {
            if key.source != source {
                break;
            }
            after = *key;
            let target = *target;
            #[cfg(test)]
            {
                self.notification_visits += 1;
            }
            let ep = self.backings.get_mut(target.instance).unwrap();
            let i = &mut ep.interests[target.slot];
            if i.disabled || i.events & events == 0 && events & (EPOLLERR | EPOLLHUP) == 0 {
                continue;
            }
            if i.events & EPOLLEXCLUSIVE != 0 {
                if exclusive_selected {
                    continue;
                }
                if ep.waiters != 0 {
                    exclusive_selected = true;
                }
            }
            i.pending = true;
            ep.enqueue(target.slot);
            if ep.waiters != 0 {
                crate::wakeup::push_epoll_ready();
            }
            if depth < 4 && ep.notification_epoch != epoch {
                ep.notification_epoch = epoch;
                self.notify(
                    Source::Backing(crate::ofd::FileType::Epoll, -(target.instance as i64 + 1)),
                    EPOLLIN,
                    depth + 1,
                    epoch,
                );
            }
        }
    }

    fn notify_source(&mut self, source: Source, events: u32) {
        self.notification_epoch = self
            .notification_epoch
            .checked_add(1)
            .expect("epoll notification epoch exhausted");
        self.notify(source, events, 0, self.notification_epoch);
    }

    fn update_generations(
        &mut self,
        source: Source,
        mut update: impl FnMut(&mut EpollInterest) -> u32,
    ) {
        let mut after = SubscriptionKey {
            source,
            registration: 0,
        };
        let mut events = 0;
        while let Some((key, target)) = self.subscriptions.next_after(&after) {
            if key.source != source {
                break;
            }
            after = *key;
            events |=
                update(&mut self.backings.get_mut(target.instance).unwrap().interests[target.slot]);
        }
        if events != 0 {
            self.notify_source(source, events);
        }
    }
}

/// Sources whose current contract still requires a readiness/history sample.
/// Pipe-backed streams and listeners use mutation notifications; sockets with
/// process-local queues, host transports and asynchronous devices retain their
/// existing provider behavior until their notification contracts are complete.
pub fn needs_sampling(sources: &[Source]) -> bool {
    use crate::ofd::FileType;
    sources
        .iter()
        .any(|s| matches!(s, Source::Backing(FileType::Pipe, h) if *h >= 0))
        || sources.iter().any(|s| {
            matches!(
                s,
                Source::Network(_)
                    | Source::Device(_)
                    | Source::Backing(
                        FileType::TimerFd | FileType::SignalFd | FileType::PcmPlayback,
                        _
                    )
            )
        })
        || sources
            .iter()
            .any(|s| matches!(s, Source::Backing(FileType::Socket, _)))
            && !sources
                .iter()
                .any(|s| matches!(s, Source::Pipe(..) | Source::Accept(_)))
}

pub fn refresh_sources(id: OfdId, sources: &[Source]) -> Result<(), Errno> {
    with_epolls(|t| {
        let source = Source::Description(id);
        let mut after = SubscriptionKey {
            source,
            registration: 0,
        };
        while let Some((key, target)) = t.subscriptions.next_after(&after) {
            if key.source != source {
                break;
            }
            after = *key;
            let target = *target;
            if t.backings.get(target.instance).unwrap().interests[target.slot].sources == sources {
                continue;
            }
            let mut copy = Vec::new();
            copy.try_reserve_exact(sources.len())
                .map_err(|_| Errno::ENOMEM)?;
            copy.extend_from_slice(sources);
            t.replace_sources(target.instance, target.slot, copy)?;
        }
        Ok(())
    })
}

impl EpollInterest {
    pub fn try_snapshot(&self) -> Result<Self, Errno> {
        #[cfg(test)]
        if SNAPSHOT_FAILURE_AFTER.fetch_update(
            core::sync::atomic::Ordering::Relaxed,
            core::sync::atomic::Ordering::Relaxed,
            |count| (count != usize::MAX).then(|| count.wrapping_sub(1)),
        ) == Ok(0)
        {
            return Err(Errno::ENOMEM);
        }
        let mut sources = Vec::new();
        sources
            .try_reserve_exact(self.sources.len())
            .map_err(|_| Errno::ENOMEM)?;
        sources.extend_from_slice(&self.sources);
        Ok(Self { sources, ..*self })
    }
}

impl EpollInstance {
    pub fn enqueue(&mut self, slot: usize) {
        let i = &mut self.interests[slot];
        if i.queued || i.disabled {
            return;
        }
        i.queued = true;
        i.ready_prev = self.ready_tail;
        i.ready_next = None;
        if let Some(tail) = self.ready_tail {
            self.interests[tail].ready_next = Some(slot);
        } else {
            self.ready_head = Some(slot);
        }
        self.ready_tail = Some(slot);
        self.ready_count += 1;
    }
    pub fn dequeue(&mut self, slot: usize) {
        let i = &mut self.interests[slot];
        if !i.queued {
            return;
        }
        i.queued = false;
        let prev = i.ready_prev.take();
        let next = i.ready_next.take();
        if let Some(prev) = prev {
            self.interests[prev].ready_next = next;
        } else {
            self.ready_head = next;
        }
        if let Some(next) = next {
            self.interests[next].ready_prev = prev;
        } else {
            self.ready_tail = prev;
        }
        self.ready_count -= 1;
    }
}

/// Called before the host drains its independent wake queue, never while the
/// epoll table is borrowed. Only subscribers to this source and their parents
/// are visited; repeated notifications occupy no additional queue storage.
pub fn notify(source: Source, events: u32) {
    with_epolls(|table| table.notify_source(source, events));
}

pub fn invalidate_authority(id: OfdId) {
    with_epolls(|t| t.invalidate_authority(Source::Description(id), 0));
}

pub fn forget(id: OfdId) {
    with_epolls(|table| {
        let source = Source::Description(id);
        loop {
            let first = table.subscriptions.next_after(&SubscriptionKey {
                source,
                registration: 0,
            });
            let Some((key, target)) = first else {
                break;
            };
            if key.source != source {
                break;
            }
            let target = *target;
            table.remove(target.instance, target.slot);
        }
    });
}

pub fn network_generation(handle: i32, generations: [Option<u64>; 2], terminal: u32) {
    with_epolls(|t| {
        t.update_generations(Source::Network(handle), |i| {
            let mut events = 0;
            for direction in 0..2 {
                if generations[direction].is_some()
                    && i.network_generations[direction].is_some()
                    && generations[direction] != i.network_generations[direction]
                {
                    events |= if direction == 0 {
                        EPOLLIN | EPOLLRDNORM | EPOLLPRI | EPOLLRDHUP | terminal
                    } else {
                        EPOLLOUT | EPOLLWRNORM | EPOLLWRBAND | terminal
                    };
                }
            }
            i.network_generations = generations;
            events
        })
    });
}

/// An in-flight wait owns the exact description, independently of the fd number
/// another thread may close and reuse. The backing reference also records a
/// sleeper for EPOLLEXCLUSIVE callback selection.
pub struct WaitLease {
    pub index: usize,
    pub token: u64,
    _description: crate::ofd::SharedOfdState,
}
impl WaitLease {
    pub fn new(
        index: usize,
        description: crate::ofd::SharedOfdState,
    ) -> Result<Self, wasm_posix_shared::Errno> {
        with_epolls(|table| {
            table.add_ref(index)?;
            table.get_mut(index).unwrap().waiters += 1;
            Ok(())
        })?;
        static LAST_WAIT_TOKEN: core::sync::atomic::AtomicU64 =
            core::sync::atomic::AtomicU64::new(0);
        let token = LAST_WAIT_TOKEN
            .fetch_update(
                core::sync::atomic::Ordering::Relaxed,
                core::sync::atomic::Ordering::Relaxed,
                |last| last.checked_add(1),
            )
            .expect("epoll wait identity space exhausted")
            + 1;
        Ok(Self {
            index,
            token,
            _description: description,
        })
    }
}
impl Drop for WaitLease {
    fn drop(&mut self) {
        with_epolls(|table| {
            if let Some(ep) = table.get_mut(self.index) {
                ep.waiters = ep.waiters.saturating_sub(1);
            }
            table.release(self.index);
        });
    }
}

pub fn finish_wait(proc: &mut crate::process::Process, tid: u32) {
    if let Some(pos) = proc.epoll_waits.iter().position(|(owner, _)| *owner == tid) {
        proc.epoll_waits.remove(pos);
    }
}

pub fn device_generation(source: Source, generation: (u64, u32), events: u32) {
    with_epolls(|t| {
        t.update_generations(source, |i| {
            let changed = i.device_generation.is_some_and(|old| old != generation);
            i.device_generation = Some(generation);
            if changed { events } else { 0 }
        })
    });
}

pub fn signal_generation(id: OfdId, generations: [Option<u64>; 2]) {
    with_epolls(|t| {
        t.update_generations(Source::Description(id), |i| {
            let changed =
                i.network_generations[0].is_some() && i.network_generations != generations;
            i.network_generations = generations;
            if changed { EPOLLIN } else { 0 }
        })
    });
}

pub fn finish_wait_token(proc: &mut crate::process::Process, tid: u32, token: u64) {
    if token != 0
        && proc
            .epoll_waits
            .iter()
            .any(|(owner, lease)| *owner == tid && lease.token == token)
    {
        finish_wait(proc, tid);
    }
}

#[cfg(test)]
pub static READINESS_CHECKS: core::sync::atomic::AtomicUsize =
    core::sync::atomic::AtomicUsize::new(0);

#[cfg(test)]
pub static SNAPSHOT_FAILURE_AFTER: core::sync::atomic::AtomicUsize =
    core::sync::atomic::AtomicUsize::new(usize::MAX);

#[cfg(test)]
pub static REFUSE_SOURCE_COLLECTION: core::sync::atomic::AtomicBool =
    core::sync::atomic::AtomicBool::new(false);
