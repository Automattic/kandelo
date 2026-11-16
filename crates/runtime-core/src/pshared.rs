//! Kernel-side `PTHREAD_PROCESS_SHARED` objects for ABI-56 programs.
//!
//! The ABI-56 libc overlay (`libc/musl-overlay/src/thread/wasm32posix/`)
//! routes process-shared mutexes, condition variables and barriers here,
//! through legacy requests 400–414 (`wasm_posix_shared::legacy_pshared`,
//! recorded in `abi/snapshot.json` as `program_legacy_requests`).
//! `pthread_*_init` allocates an object here and stores its ID in the user
//! struct; every later operation names the object by that ID.
//!
//! WHY kernel objects: each process has its own WebAssembly memory, and
//! `MAP_SHARED` bytes converge only at syscall boundaries, so a user-space
//! atomic on a shared word is not atomic between processes. Keeping the
//! state here, and making every operation a syscall, gives mutual exclusion
//! and, at each lock and unlock boundary, coherent protected data.
//!
//! Semantics (docs/posix-status.md, "Process-Shared Synchronization"):
//!
//! * Owners and waiters are threads (`Owner::tid`), not processes, so a
//!   process-shared mutex also excludes the threads of one process.
//! * A mutex whose owner exits stays locked, as POSIX's default
//!   `PTHREAD_MUTEX_STALLED` requires. Robust process-shared mutexes never
//!   reach this table: the ABI-56 overlay sends them to musl's futex path.
//! * A call that must block answers `EAGAIN`. The kernel then parks the
//!   caller (`wait_retry::RetryOp::Pshared`) under the object's wake source
//!   and re-executes the call when the object changes; [`WakeIds`] names
//!   the sources an operation fired.
//! * The table is bounded ([`MAX_OBJECTS`]); a full table answers `EAGAIN`
//!   at init, one of POSIX's errors for every `*_init` here.
//!
//! The design that replaces these requests for newly built programs is
//! docs/plans/2026-11-15-process-shared-synchronization-design.md.

extern crate alloc;

use alloc::collections::{BTreeMap, VecDeque};
use alloc::vec::Vec;
use wasm_posix_shared::Errno;

// ── Mutex type flags (low 4 bits of pthread_mutex_t._m_type) ──
pub const MUTEX_TYPE_NORMAL: u32 = 0;
pub const MUTEX_TYPE_RECURSIVE: u32 = 1;
pub const MUTEX_TYPE_ERRORCHECK: u32 = 2;

// pthread_barrier_wait returns this to exactly one caller (arbitrarily, the
// Nth arriver in our implementation). Matches the value exposed by musl's
// <pthread.h>. All other callers return 0.
pub const PTHREAD_BARRIER_SERIAL_THREAD: i32 = -1;

/// Most live objects of all kinds together. About 2 MiB of kernel memory at
/// the limit; a program that needs more gets `EAGAIN` from init.
pub const MAX_OBJECTS: usize = 65_536;

/// The thread performing an operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Owner {
    pub pid: u32,
    pub tid: u32,
}

/// Object IDs whose waiters an operation may have unblocked: the kernel
/// notes each one's wake source so parked calls are re-executed.
pub type WakeIds = Vec<u32>;

struct PSharedMutex {
    owner: Option<Owner>,
    /// Extra holds of a `RECURSIVE` mutex; 0 means held once.
    recursive_count: u32,
    mtype: u32,
}

/// One thread waiting on a condition. `signaled` makes it eligible to
/// reacquire the mutex and return.
struct CondWaiter {
    who: Owner,
    mutex_id: u32,
    signaled: bool,
}

struct PSharedCond {
    waiters: VecDeque<CondWaiter>,
}

struct BarrierWaiter {
    who: Owner,
    /// True for exactly one waiter in a release round.
    is_serial: bool,
    /// Once the round is released, remaining entries are marked; their
    /// threads collect them when their parked call is re-executed.
    released: bool,
}

struct PSharedBarrier {
    count: u32,
    waiters: Vec<BarrierWaiter>,
}

/// Global table of kernel-side shared pthread objects.
///
/// IDs are shared by all three kinds and never 0, so a zeroed (never
/// initialized) struct never names an object. A wrapped allocator skips IDs
/// still in use, so a live object is never aliased.
pub struct PSharedTable {
    mutexes: BTreeMap<u32, PSharedMutex>,
    conds: BTreeMap<u32, PSharedCond>,
    barriers: BTreeMap<u32, PSharedBarrier>,
    next_id: u32,
}

impl PSharedTable {
    pub const fn new() -> Self {
        Self {
            mutexes: BTreeMap::new(),
            conds: BTreeMap::new(),
            barriers: BTreeMap::new(),
            next_id: 1,
        }
    }

    fn in_use(&self, id: u32) -> bool {
        self.mutexes.contains_key(&id) || self.conds.contains_key(&id) || self.barriers.contains_key(&id)
    }

    fn alloc_id(&mut self) -> Result<u32, Errno> {
        if self.mutexes.len() + self.conds.len() + self.barriers.len() >= MAX_OBJECTS {
            return Err(Errno::EAGAIN);
        }
        loop {
            let id = self.next_id;
            self.next_id = self.next_id.wrapping_add(1).max(1);
            if id != 0 && !self.in_use(id) {
                return Ok(id);
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // Mutex
    // ═══════════════════════════════════════════════════════════════

    pub fn mutex_init(&mut self, mtype: u32) -> Result<u32, Errno> {
        let id = self.alloc_id()?;
        self.mutexes.insert(
            id,
            PSharedMutex {
                owner: None,
                recursive_count: 0,
                mtype: mtype & 0xF,
            },
        );
        Ok(id)
    }

    pub fn mutex_destroy(&mut self, id: u32) -> Result<(), Errno> {
        let m = self.mutexes.get(&id).ok_or(Errno::EINVAL)?;
        if m.owner.is_some() {
            return Err(Errno::EBUSY);
        }
        self.mutexes.remove(&id);
        Ok(())
    }

    /// `pthread_mutex_trylock`: `EBUSY` whenever the mutex is held, even by
    /// the caller, except that the owner of a `RECURSIVE` mutex takes
    /// another hold.
    pub fn mutex_trylock(&mut self, id: u32, who: Owner) -> Result<(), Errno> {
        let m = self.mutexes.get_mut(&id).ok_or(Errno::EINVAL)?;
        match m.owner {
            None => {
                m.owner = Some(who);
                m.recursive_count = 0;
                Ok(())
            }
            Some(owner) if owner.tid == who.tid && m.mtype == MUTEX_TYPE_RECURSIVE => {
                m.recursive_count = m.recursive_count.checked_add(1).ok_or(Errno::EAGAIN)?;
                Ok(())
            }
            Some(_) => Err(Errno::EBUSY),
        }
    }

    /// `pthread_mutex_lock`: `EAGAIN` means the caller must block. An
    /// `ERRORCHECK` owner relocking gets `EDEADLK`; a `NORMAL` owner
    /// relocking blocks forever, as POSIX specifies.
    pub fn mutex_lock(&mut self, id: u32, who: Owner) -> Result<(), Errno> {
        let m = self.mutexes.get(&id).ok_or(Errno::EINVAL)?;
        if let Some(owner) = m.owner {
            if owner.tid == who.tid && m.mtype == MUTEX_TYPE_ERRORCHECK {
                return Err(Errno::EDEADLK);
            }
        }
        match self.mutex_trylock(id, who) {
            Ok(()) => Ok(()),
            Err(Errno::EBUSY) => Err(Errno::EAGAIN),
            Err(e) => Err(e),
        }
    }

    /// `pthread_mutex_unlock`: only the owning thread may unlock (`EPERM`
    /// otherwise, for every type). Returns the objects whose waiters may
    /// now proceed: the mutex, and every condition with a signaled waiter
    /// that must reacquire it.
    pub fn mutex_unlock(&mut self, id: u32, who: Owner) -> Result<WakeIds, Errno> {
        let m = self.mutexes.get_mut(&id).ok_or(Errno::EINVAL)?;
        if m.owner.map(|owner| owner.tid) != Some(who.tid) {
            return Err(Errno::EPERM);
        }
        if m.mtype == MUTEX_TYPE_RECURSIVE && m.recursive_count > 0 {
            m.recursive_count -= 1;
            return Ok(Vec::new());
        }
        m.owner = None;
        m.recursive_count = 0;
        Ok(self.released_mutex_wakes(id))
    }

    fn released_mutex_wakes(&self, mutex_id: u32) -> WakeIds {
        let mut wakes = alloc::vec![mutex_id];
        for (cond_id, c) in &self.conds {
            if c.waiters.iter().any(|w| w.signaled && w.mutex_id == mutex_id) {
                wakes.push(*cond_id);
            }
        }
        wakes
    }

    // ═══════════════════════════════════════════════════════════════
    // Condition variables
    // ═══════════════════════════════════════════════════════════════

    pub fn cond_init(&mut self) -> Result<u32, Errno> {
        let id = self.alloc_id()?;
        self.conds.insert(
            id,
            PSharedCond {
                waiters: VecDeque::new(),
            },
        );
        Ok(id)
    }

    pub fn cond_destroy(&mut self, id: u32) -> Result<(), Errno> {
        let c = self.conds.get(&id).ok_or(Errno::EINVAL)?;
        if !c.waiters.is_empty() {
            return Err(Errno::EBUSY);
        }
        self.conds.remove(&id);
        Ok(())
    }

    /// Begin a wait: atomically release the mutex (which the calling thread
    /// must own) and enqueue the thread. Returns the objects whose waiters
    /// the released mutex may unblock.
    pub fn cond_wait_begin(&mut self, cond_id: u32, mutex_id: u32, who: Owner) -> Result<WakeIds, Errno> {
        if !self.conds.contains_key(&cond_id) {
            return Err(Errno::EINVAL);
        }
        let m = self.mutexes.get_mut(&mutex_id).ok_or(Errno::EINVAL)?;
        if m.owner.map(|owner| owner.tid) != Some(who.tid) {
            return Err(Errno::EPERM);
        }
        m.owner = None;
        m.recursive_count = 0;
        let c = self.conds.get_mut(&cond_id).ok_or(Errno::EINVAL)?;
        // A thread has at most one wait in progress; a stale entry from an
        // abandoned wait is replaced.
        c.waiters.retain(|w| w.who.tid != who.tid);
        c.waiters.push_back(CondWaiter {
            who,
            mutex_id,
            signaled: false,
        });
        Ok(self.released_mutex_wakes(mutex_id))
    }

    /// Finish a wait if the thread was signaled and can reacquire the
    /// mutex; `EAGAIN` while it must keep waiting. `EINVAL` if the thread
    /// has no wait on this condition or named another mutex.
    pub fn cond_wait_check(&mut self, cond_id: u32, mutex_id: u32, who: Owner) -> Result<(), Errno> {
        let c = self.conds.get_mut(&cond_id).ok_or(Errno::EINVAL)?;
        let idx = c
            .waiters
            .iter()
            .position(|w| w.who.tid == who.tid)
            .ok_or(Errno::EINVAL)?;
        if c.waiters[idx].mutex_id != mutex_id {
            return Err(Errno::EINVAL);
        }
        if !c.waiters[idx].signaled {
            return Err(Errno::EAGAIN);
        }
        let m = self.mutexes.get_mut(&mutex_id).ok_or(Errno::EINVAL)?;
        if m.owner.is_some() {
            return Err(Errno::EAGAIN);
        }
        m.owner = Some(who);
        m.recursive_count = 0;
        c.waiters.remove(idx);
        Ok(())
    }

    /// Abandon a wait without reacquiring the mutex.
    pub fn cond_wait_abort(&mut self, cond_id: u32, who: Owner) {
        if let Some(c) = self.conds.get_mut(&cond_id) {
            c.waiters.retain(|w| w.who.tid != who.tid);
        }
    }

    /// Mark the oldest unsignaled waiter. Returns its TID, or 0 if none.
    pub fn cond_signal(&mut self, cond_id: u32) -> Result<u32, Errno> {
        let c = self.conds.get_mut(&cond_id).ok_or(Errno::EINVAL)?;
        for w in c.waiters.iter_mut() {
            if !w.signaled {
                w.signaled = true;
                return Ok(w.who.tid);
            }
        }
        Ok(0)
    }

    /// Mark every waiter. Returns how many were newly marked.
    pub fn cond_broadcast(&mut self, cond_id: u32) -> Result<u32, Errno> {
        let c = self.conds.get_mut(&cond_id).ok_or(Errno::EINVAL)?;
        let mut n = 0;
        for w in c.waiters.iter_mut() {
            if !w.signaled {
                w.signaled = true;
                n += 1;
            }
        }
        Ok(n)
    }

    // ═══════════════════════════════════════════════════════════════
    // Barriers
    // ═══════════════════════════════════════════════════════════════

    pub fn barrier_init(&mut self, count: u32) -> Result<u32, Errno> {
        if count == 0 {
            return Err(Errno::EINVAL);
        }
        let id = self.alloc_id()?;
        self.barriers.insert(
            id,
            PSharedBarrier {
                count,
                waiters: Vec::new(),
            },
        );
        Ok(id)
    }

    pub fn barrier_destroy(&mut self, id: u32) -> Result<(), Errno> {
        let b = self.barriers.get(&id).ok_or(Errno::EINVAL)?;
        if !b.waiters.is_empty() {
            return Err(Errno::EBUSY);
        }
        self.barriers.remove(&id);
        Ok(())
    }

    /// `pthread_barrier_wait`. Returns `PTHREAD_BARRIER_SERIAL_THREAD` for
    /// exactly one thread per round and 0 for the others, or `EAGAIN` while
    /// the round is incomplete. A thread whose call is re-executed collects
    /// its result from its own entry.
    pub fn barrier_wait(&mut self, id: u32, who: Owner) -> Result<i32, Errno> {
        let b = self.barriers.get_mut(&id).ok_or(Errno::EINVAL)?;

        if let Some(idx) = b.waiters.iter().position(|w| w.who.tid == who.tid) {
            if b.waiters[idx].released {
                let was_serial = b.waiters[idx].is_serial;
                b.waiters.remove(idx);
                return Ok(if was_serial {
                    PTHREAD_BARRIER_SERIAL_THREAD
                } else {
                    0
                });
            }
            return Err(Errno::EAGAIN);
        }

        // A new round must not count threads still collecting the last one.
        let arrived = b.waiters.iter().filter(|w| !w.released).count() as u32;
        if arrived + 1 == b.count {
            for w in b.waiters.iter_mut() {
                w.released = true;
            }
            return Ok(PTHREAD_BARRIER_SERIAL_THREAD);
        }
        b.waiters.push(BarrierWaiter {
            who,
            is_serial: false,
            released: false,
        });
        Err(Errno::EAGAIN)
    }

    // ═══════════════════════════════════════════════════════════════
    // Lifecycle
    // ═══════════════════════════════════════════════════════════════

    /// A thread is gone: drop its condition and barrier waiter entries.
    /// Mutexes it holds stay held (`PTHREAD_MUTEX_STALLED`).
    pub fn cleanup_task(&mut self, tid: u32) {
        for c in self.conds.values_mut() {
            c.waiters.retain(|w| w.who.tid != tid);
        }
        for b in self.barriers.values_mut() {
            b.waiters.retain(|w| w.who.tid != tid);
        }
    }

    /// A process image is gone (exit or exec): drop the condition and
    /// barrier waiter entries of all its threads. Mutexes its threads hold
    /// stay held (`PTHREAD_MUTEX_STALLED`): POSIX takes "no special
    /// actions", and releasing them would hide data the owner may have left
    /// inconsistent.
    pub fn cleanup_process(&mut self, pid: u32) {
        for c in self.conds.values_mut() {
            c.waiters.retain(|w| w.who.pid != pid);
        }
        for b in self.barriers.values_mut() {
            b.waiters.retain(|w| w.who.pid != pid);
        }
    }
}

// ── Global singleton ──

use core::cell::UnsafeCell;

struct PSharedTableCell(UnsafeCell<PSharedTable>);
unsafe impl Sync for PSharedTableCell {}

static PSHARED_TABLE: PSharedTableCell = PSharedTableCell(UnsafeCell::new(PSharedTable::new()));

/// Get a mutable reference to the global pshared table.
///
/// # Safety
/// Must only be called from a single-threaded context (Wasm is single-threaded).
pub unsafe fn global_pshared_table() -> &'static mut PSharedTable {
    unsafe { &mut *PSHARED_TABLE.0.get() }
}

// ── Tests ──

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    /// The main thread of process `pid` (its TID is its PID).
    fn main(pid: u32) -> Owner {
        Owner { pid, tid: pid }
    }

    fn thread(pid: u32, tid: u32) -> Owner {
        Owner { pid, tid }
    }

    #[test]
    fn mutex_basic_lock_unlock() {
        let mut t = PSharedTable::new();
        let id = t.mutex_init(MUTEX_TYPE_NORMAL).unwrap();
        assert!(id > 0);
        assert_eq!(t.mutex_lock(id, main(100)), Ok(()));
        assert_eq!(t.mutex_unlock(id, main(100)), Ok(vec![id]));
    }

    #[test]
    fn ids_skip_zero_and_live_objects() {
        let mut t = PSharedTable::new();
        t.next_id = u32::MAX;
        let a = t.mutex_init(MUTEX_TYPE_NORMAL).unwrap();
        assert_eq!(a, u32::MAX);
        let b = t.mutex_init(MUTEX_TYPE_NORMAL).unwrap();
        assert_eq!(b, 1, "wraps past 0");
        // Wrap again onto the live IDs: neither is reused.
        t.next_id = u32::MAX;
        let c = t.cond_init().unwrap();
        assert_eq!(c, 2);
    }

    #[test]
    fn a_full_table_refuses_init_with_eagain() {
        let mut t = PSharedTable::new();
        for _ in 0..MAX_OBJECTS {
            t.mutex_init(MUTEX_TYPE_NORMAL).unwrap();
        }
        assert_eq!(t.cond_init(), Err(Errno::EAGAIN));
        assert_eq!(t.barrier_init(2), Err(Errno::EAGAIN));
    }

    #[test]
    fn a_contended_lock_asks_to_block() {
        let mut t = PSharedTable::new();
        let id = t.mutex_init(MUTEX_TYPE_NORMAL).unwrap();
        assert_eq!(t.mutex_lock(id, main(100)), Ok(()));
        assert_eq!(t.mutex_lock(id, main(200)), Err(Errno::EAGAIN));
        assert_eq!(t.mutex_trylock(id, main(200)), Err(Errno::EBUSY));
        assert_eq!(t.mutex_unlock(id, main(100)), Ok(vec![id]));
        assert_eq!(t.mutex_lock(id, main(200)), Ok(()));
    }

    #[test]
    fn threads_of_one_process_exclude_each_other() {
        let mut t = PSharedTable::new();
        let id = t.mutex_init(MUTEX_TYPE_RECURSIVE).unwrap();
        assert_eq!(t.mutex_lock(id, thread(100, 100)), Ok(()));
        assert_eq!(t.mutex_trylock(id, thread(100, 101)), Err(Errno::EBUSY));
        assert_eq!(t.mutex_lock(id, thread(100, 101)), Err(Errno::EAGAIN));
        assert_eq!(t.mutex_unlock(id, thread(100, 101)), Err(Errno::EPERM));
    }

    #[test]
    fn only_the_owning_thread_unlocks() {
        let mut t = PSharedTable::new();
        let id = t.mutex_init(MUTEX_TYPE_ERRORCHECK).unwrap();
        assert_eq!(t.mutex_lock(id, thread(100, 100)), Ok(()));
        assert_eq!(t.mutex_unlock(id, main(200)), Err(Errno::EPERM));
        assert_eq!(t.mutex_unlock(id, thread(100, 101)), Err(Errno::EPERM));
        assert_eq!(t.mutex_unlock(id, thread(100, 100)), Ok(vec![id]));
    }

    #[test]
    fn mutex_recursive_allows_nested_locks() {
        let mut t = PSharedTable::new();
        let id = t.mutex_init(MUTEX_TYPE_RECURSIVE).unwrap();
        assert_eq!(t.mutex_lock(id, main(100)), Ok(()));
        assert_eq!(t.mutex_lock(id, main(100)), Ok(()));
        assert_eq!(t.mutex_trylock(id, main(100)), Ok(()));
        assert_eq!(t.mutex_unlock(id, main(100)), Ok(vec![]));
        assert_eq!(t.mutex_unlock(id, main(100)), Ok(vec![]));
        assert_eq!(t.mutex_trylock(id, main(200)), Err(Errno::EBUSY));
        assert_eq!(t.mutex_unlock(id, main(100)), Ok(vec![id]));
        assert_eq!(t.mutex_trylock(id, main(200)), Ok(()));
    }

    #[test]
    fn errorcheck_relock_is_edeadlk_and_trylock_is_ebusy() {
        let mut t = PSharedTable::new();
        let id = t.mutex_init(MUTEX_TYPE_ERRORCHECK).unwrap();
        assert_eq!(t.mutex_lock(id, main(100)), Ok(()));
        assert_eq!(t.mutex_lock(id, main(100)), Err(Errno::EDEADLK));
        assert_eq!(t.mutex_trylock(id, main(100)), Err(Errno::EBUSY));
    }

    #[test]
    fn a_normal_owner_relocking_blocks() {
        let mut t = PSharedTable::new();
        let id = t.mutex_init(MUTEX_TYPE_NORMAL).unwrap();
        assert_eq!(t.mutex_lock(id, main(100)), Ok(()));
        assert_eq!(t.mutex_lock(id, main(100)), Err(Errno::EAGAIN));
    }

    #[test]
    fn mutex_destroy_held_returns_ebusy() {
        let mut t = PSharedTable::new();
        let id = t.mutex_init(MUTEX_TYPE_NORMAL).unwrap();
        assert_eq!(t.mutex_lock(id, main(100)), Ok(()));
        assert_eq!(t.mutex_destroy(id), Err(Errno::EBUSY));
        assert_eq!(t.mutex_unlock(id, main(100)), Ok(vec![id]));
        assert_eq!(t.mutex_destroy(id), Ok(()));
        assert_eq!(t.mutex_lock(id, main(100)), Err(Errno::EINVAL));
    }

    #[test]
    fn a_dead_owners_mutex_stays_held() {
        let mut t = PSharedTable::new();
        let id = t.mutex_init(MUTEX_TYPE_NORMAL).unwrap();
        assert_eq!(t.mutex_lock(id, thread(100, 105)), Ok(()));
        t.cleanup_task(105);
        t.cleanup_process(100);
        assert_eq!(t.mutex_trylock(id, main(200)), Err(Errno::EBUSY));
        assert_eq!(t.mutex_lock(id, main(200)), Err(Errno::EAGAIN));
    }

    #[test]
    fn cond_wait_then_signal() {
        let mut t = PSharedTable::new();
        let mid = t.mutex_init(MUTEX_TYPE_NORMAL).unwrap();
        let cid = t.cond_init().unwrap();
        assert_eq!(t.mutex_lock(mid, main(100)), Ok(()));
        assert_eq!(t.cond_wait_begin(cid, mid, main(100)), Ok(vec![mid]));
        assert_eq!(t.mutex_lock(mid, main(200)), Ok(()));
        assert_eq!(t.mutex_unlock(mid, main(200)), Ok(vec![mid]));
        assert_eq!(t.cond_wait_check(cid, mid, main(100)), Err(Errno::EAGAIN));
        assert_eq!(t.cond_signal(cid), Ok(100));
        assert_eq!(t.cond_wait_check(cid, mid, main(100)), Ok(()));
        assert_eq!(t.mutex_trylock(mid, main(200)), Err(Errno::EBUSY));
    }

    #[test]
    fn unlock_wakes_conditions_whose_signaled_waiters_need_the_mutex() {
        let mut t = PSharedTable::new();
        let mid = t.mutex_init(MUTEX_TYPE_NORMAL).unwrap();
        let cid = t.cond_init().unwrap();
        assert_eq!(t.mutex_lock(mid, main(100)), Ok(()));
        t.cond_wait_begin(cid, mid, main(100)).unwrap();
        assert_eq!(t.mutex_lock(mid, main(200)), Ok(()));
        assert_eq!(t.cond_signal(cid), Ok(100));
        assert_eq!(t.cond_wait_check(cid, mid, main(100)), Err(Errno::EAGAIN), "mutex held");
        assert_eq!(t.mutex_unlock(mid, main(200)), Ok(vec![mid, cid]));
        assert_eq!(t.cond_wait_check(cid, mid, main(100)), Ok(()));
    }

    #[test]
    fn two_threads_of_one_process_wait_on_one_condition() {
        let mut t = PSharedTable::new();
        let mid = t.mutex_init(MUTEX_TYPE_NORMAL).unwrap();
        let cid = t.cond_init().unwrap();
        let (a, b) = (thread(100, 101), thread(100, 102));
        t.mutex_lock(mid, a).unwrap();
        t.cond_wait_begin(cid, mid, a).unwrap();
        t.mutex_lock(mid, b).unwrap();
        t.cond_wait_begin(cid, mid, b).unwrap();
        assert_eq!(t.cond_broadcast(cid), Ok(2));
        assert_eq!(t.cond_wait_check(cid, mid, a), Ok(()));
        assert_eq!(t.cond_wait_check(cid, mid, b), Err(Errno::EAGAIN), "a holds the mutex");
        t.mutex_unlock(mid, a).unwrap();
        assert_eq!(t.cond_wait_check(cid, mid, b), Ok(()));
    }

    #[test]
    fn cond_signal_picks_oldest_waiter() {
        let mut t = PSharedTable::new();
        let mid = t.mutex_init(MUTEX_TYPE_NORMAL).unwrap();
        let cid = t.cond_init().unwrap();
        t.mutex_lock(mid, main(100)).unwrap();
        t.cond_wait_begin(cid, mid, main(100)).unwrap();
        t.mutex_lock(mid, main(200)).unwrap();
        t.cond_wait_begin(cid, mid, main(200)).unwrap();
        assert_eq!(t.cond_signal(cid), Ok(100));
        assert_eq!(t.cond_wait_check(cid, mid, main(100)), Ok(()));
        assert_eq!(t.cond_wait_check(cid, mid, main(200)), Err(Errno::EAGAIN));
        t.mutex_unlock(mid, main(100)).unwrap();
        assert_eq!(t.cond_signal(cid), Ok(200));
        assert_eq!(t.cond_wait_check(cid, mid, main(200)), Ok(()));
    }

    #[test]
    fn cond_wait_begin_without_mutex_is_eperm() {
        let mut t = PSharedTable::new();
        let mid = t.mutex_init(MUTEX_TYPE_NORMAL).unwrap();
        let cid = t.cond_init().unwrap();
        assert_eq!(t.cond_wait_begin(cid, mid, main(100)), Err(Errno::EPERM));
        t.mutex_lock(mid, thread(100, 101)).unwrap();
        assert_eq!(t.cond_wait_begin(cid, mid, thread(100, 102)), Err(Errno::EPERM));
    }

    #[test]
    fn cond_wait_check_without_begin_is_einval() {
        let mut t = PSharedTable::new();
        let mid = t.mutex_init(MUTEX_TYPE_NORMAL).unwrap();
        let cid = t.cond_init().unwrap();
        assert_eq!(t.cond_wait_check(cid, mid, main(100)), Err(Errno::EINVAL));
    }

    #[test]
    fn cond_destroy_with_waiters_is_ebusy() {
        let mut t = PSharedTable::new();
        let mid = t.mutex_init(MUTEX_TYPE_NORMAL).unwrap();
        let cid = t.cond_init().unwrap();
        t.mutex_lock(mid, main(100)).unwrap();
        t.cond_wait_begin(cid, mid, main(100)).unwrap();
        assert_eq!(t.cond_destroy(cid), Err(Errno::EBUSY));
        t.cond_wait_abort(cid, main(100));
        assert_eq!(t.cond_destroy(cid), Ok(()));
    }

    #[test]
    fn barrier_releases_when_count_reached() {
        let mut t = PSharedTable::new();
        let id = t.barrier_init(2).unwrap();
        assert_eq!(t.barrier_wait(id, main(100)), Err(Errno::EAGAIN));
        assert_eq!(t.barrier_wait(id, main(100)), Err(Errno::EAGAIN), "re-executed, still waiting");
        assert_eq!(t.barrier_wait(id, main(200)), Ok(PTHREAD_BARRIER_SERIAL_THREAD));
        assert_eq!(t.barrier_wait(id, main(100)), Ok(0));
    }

    #[test]
    fn two_threads_of_one_process_meet_at_a_barrier() {
        let mut t = PSharedTable::new();
        let id = t.barrier_init(2).unwrap();
        assert_eq!(t.barrier_wait(id, thread(100, 101)), Err(Errno::EAGAIN));
        assert_eq!(t.barrier_wait(id, thread(100, 102)), Ok(PTHREAD_BARRIER_SERIAL_THREAD));
        assert_eq!(t.barrier_wait(id, thread(100, 101)), Ok(0));
    }

    #[test]
    fn barrier_reusable_while_the_last_round_is_collected() {
        let mut t = PSharedTable::new();
        let id = t.barrier_init(2).unwrap();
        assert_eq!(t.barrier_wait(id, main(100)), Err(Errno::EAGAIN));
        assert_eq!(t.barrier_wait(id, main(200)), Ok(PTHREAD_BARRIER_SERIAL_THREAD));
        // 200 arrives for round two before 100 collected round one.
        assert_eq!(t.barrier_wait(id, main(200)), Err(Errno::EAGAIN));
        assert_eq!(t.barrier_wait(id, main(100)), Ok(0));
        assert_eq!(t.barrier_wait(id, main(100)), Ok(PTHREAD_BARRIER_SERIAL_THREAD));
        assert_eq!(t.barrier_wait(id, main(200)), Ok(0));
    }

    #[test]
    fn barrier_zero_count_invalid() {
        let mut t = PSharedTable::new();
        assert_eq!(t.barrier_init(0), Err(Errno::EINVAL));
    }

    #[test]
    fn barrier_destroy_with_waiters_is_ebusy() {
        let mut t = PSharedTable::new();
        let id = t.barrier_init(3).unwrap();
        assert_eq!(t.barrier_wait(id, main(100)), Err(Errno::EAGAIN));
        assert_eq!(t.barrier_destroy(id), Err(Errno::EBUSY));
    }

    #[test]
    fn cleanup_drops_waiters_but_not_held_mutexes() {
        let mut t = PSharedTable::new();
        let mid = t.mutex_init(MUTEX_TYPE_NORMAL).unwrap();
        let cid = t.cond_init().unwrap();
        let bid = t.barrier_init(2).unwrap();
        t.mutex_lock(mid, main(100)).unwrap();
        t.cond_wait_begin(cid, mid, main(100)).unwrap();
        assert_eq!(t.barrier_wait(bid, thread(100, 101)), Err(Errno::EAGAIN));
        t.mutex_lock(mid, thread(100, 102)).unwrap();
        t.cleanup_process(100);
        assert_eq!(t.cond_destroy(cid), Ok(()));
        assert_eq!(t.barrier_destroy(bid), Ok(()));
        assert_eq!(t.mutex_trylock(mid, main(200)), Err(Errno::EBUSY));
    }

    #[test]
    fn invalid_ids_return_einval() {
        let mut t = PSharedTable::new();
        assert_eq!(t.mutex_lock(999, main(100)), Err(Errno::EINVAL));
        assert_eq!(t.mutex_unlock(999, main(100)), Err(Errno::EINVAL));
        assert_eq!(t.cond_signal(999), Err(Errno::EINVAL));
        assert_eq!(t.barrier_wait(999, main(100)), Err(Errno::EINVAL));
    }
}
