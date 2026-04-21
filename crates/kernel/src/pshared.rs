//! Kernel-side PTHREAD_PROCESS_SHARED primitives.
//!
//! Musl's pthread mutex/cond/barrier implementations use futexes on shared
//! memory to synchronize. That works only when two processes map the same
//! physical page — which wasm doesn't provide (fork does a full memory copy;
//! MAP_SHARED|MAP_ANONYMOUS gives an initially-identical COW page, not a
//! genuinely shared one).
//!
//! For `PTHREAD_PROCESS_SHARED` primitives, the authoritative state lives in
//! kernel tables keyed by an ID that is written into the user struct at
//! `pthread_*_init` time. Because the struct lives on a page that is
//! byte-identical post-fork, both processes read the same ID and route
//! lock/unlock/wait/signal through the kernel.
//!
//! Blocking semantics are expressed as `Err(Errno::EAGAIN)` — the host
//! centralized-mode retry loop re-invokes the syscall after a short delay
//! until the operation can succeed. The kernel calls
//! `kernel_wake_blocked_retries()` from state-changing operations so waiters
//! are woken promptly rather than through pure timer polling.

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

// ── PSharedMutex ──

struct PSharedMutex {
    /// 0 = unlocked, otherwise the pid holding the lock.
    owner: u32,
    /// Recursive count (for PTHREAD_MUTEX_RECURSIVE). 0 means held once.
    recursive_count: u32,
    /// Mutex type (NORMAL/RECURSIVE/ERRORCHECK).
    mtype: u32,
}

// ── PSharedCond ──

/// A single waiter on a condition variable. Each waiter is a (pid, mutex_id,
/// signaled) triple. When `signaled=true`, the waiter is eligible to wake and
/// reacquire the mutex. Signal wakes the oldest non-signaled entry; broadcast
/// marks all of them.
struct CondWaiter {
    pid: u32,
    mutex_id: u32,
    signaled: bool,
}

struct PSharedCond {
    waiters: VecDeque<CondWaiter>,
}

// ── PSharedBarrier ──

struct BarrierWaiter {
    pid: u32,
    /// True for exactly one waiter in a release round — returned to that
    /// caller as PTHREAD_BARRIER_SERIAL_THREAD.
    is_serial: bool,
    /// Once the barrier is released, remaining unretrieved waiter entries
    /// are marked released; their owners retrieve them on the next retry.
    released: bool,
}

struct PSharedBarrier {
    count: u32,
    waiters: Vec<BarrierWaiter>,
}

// ── Table ──

/// Global table of kernel-side shared pthread primitives.
///
/// IDs are assigned monotonically across all three primitive kinds. A value
/// of 0 is reserved so the common "zeroed out" case (uninitialized user
/// struct) is never a valid ID.
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

    fn alloc_id(&mut self) -> u32 {
        let id = self.next_id;
        // Wrap but skip 0 so zeroed structs are never a valid ID.
        self.next_id = self.next_id.wrapping_add(1);
        if self.next_id == 0 {
            self.next_id = 1;
        }
        id
    }

    // ═══════════════════════════════════════════════════════════════
    // Mutex
    // ═══════════════════════════════════════════════════════════════

    pub fn mutex_init(&mut self, mtype: u32) -> u32 {
        let id = self.alloc_id();
        self.mutexes.insert(id, PSharedMutex {
            owner: 0,
            recursive_count: 0,
            mtype: mtype & 0xF,
        });
        id
    }

    pub fn mutex_destroy(&mut self, id: u32) -> Result<(), Errno> {
        let m = self.mutexes.get(&id).ok_or(Errno::EINVAL)?;
        if m.owner != 0 {
            return Err(Errno::EBUSY);
        }
        self.mutexes.remove(&id);
        Ok(())
    }

    pub fn mutex_trylock(&mut self, id: u32, pid: u32) -> Result<(), Errno> {
        let m = self.mutexes.get_mut(&id).ok_or(Errno::EINVAL)?;
        if m.owner == 0 {
            m.owner = pid;
            m.recursive_count = 0;
            return Ok(());
        }
        if m.owner == pid {
            match m.mtype {
                MUTEX_TYPE_RECURSIVE => {
                    m.recursive_count = m.recursive_count.saturating_add(1);
                    return Ok(());
                }
                MUTEX_TYPE_ERRORCHECK => return Err(Errno::EDEADLK),
                _ => return Err(Errno::EBUSY),
            }
        }
        Err(Errno::EBUSY)
    }

    /// Blocking lock: returns EAGAIN when contended so the host can retry.
    pub fn mutex_lock(&mut self, id: u32, pid: u32) -> Result<(), Errno> {
        match self.mutex_trylock(id, pid) {
            Ok(()) => Ok(()),
            Err(Errno::EBUSY) => Err(Errno::EAGAIN),
            Err(e) => Err(e),
        }
    }

    pub fn mutex_unlock(&mut self, id: u32, pid: u32) -> Result<(), Errno> {
        let m = self.mutexes.get_mut(&id).ok_or(Errno::EINVAL)?;
        if m.owner != pid {
            return Err(Errno::EPERM);
        }
        if m.mtype == MUTEX_TYPE_RECURSIVE && m.recursive_count > 0 {
            m.recursive_count -= 1;
            return Ok(());
        }
        m.owner = 0;
        m.recursive_count = 0;
        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════
    // Condition variables
    // ═══════════════════════════════════════════════════════════════

    pub fn cond_init(&mut self) -> u32 {
        let id = self.alloc_id();
        self.conds.insert(id, PSharedCond { waiters: VecDeque::new() });
        id
    }

    pub fn cond_destroy(&mut self, id: u32) -> Result<(), Errno> {
        let c = self.conds.get(&id).ok_or(Errno::EINVAL)?;
        if !c.waiters.is_empty() {
            return Err(Errno::EBUSY);
        }
        self.conds.remove(&id);
        Ok(())
    }

    /// Begin waiting on a condition variable: atomically release the
    /// associated mutex and enqueue this pid as a waiter. Called once per
    /// `pthread_cond_wait` invocation; returns `Ok(())` on success,
    /// `EPERM` if the caller doesn't own the mutex, or `EINVAL` on bad IDs.
    ///
    /// A pid may have at most one outstanding wait on a given cond at a
    /// time (pthread implementations already serialize on the mutex).
    pub fn cond_wait_begin(&mut self, cond_id: u32, mutex_id: u32, pid: u32) -> Result<(), Errno> {
        // Validate mutex and transfer ownership release.
        let m = self.mutexes.get_mut(&mutex_id).ok_or(Errno::EINVAL)?;
        if m.owner != pid {
            return Err(Errno::EPERM);
        }
        m.owner = 0;
        m.recursive_count = 0;

        let c = self.conds.get_mut(&cond_id).ok_or(Errno::EINVAL)?;
        // Record the waiter. If an entry already exists for this pid on
        // this cond (it shouldn't under correct use), dedupe.
        if !c.waiters.iter().any(|w| w.pid == pid) {
            c.waiters.push_back(CondWaiter {
                pid,
                mutex_id,
                signaled: false,
            });
        }
        Ok(())
    }

    /// Poll the condition variable: if this pid has been signaled and the
    /// mutex is available, reacquire it and return `Ok(())`. Returns
    /// `EAGAIN` while still waiting (either not yet signaled, or mutex
    /// busy). `EINVAL` if the wait was never registered.
    pub fn cond_wait_check(&mut self, cond_id: u32, mutex_id: u32, pid: u32) -> Result<(), Errno> {
        let c = self.conds.get_mut(&cond_id).ok_or(Errno::EINVAL)?;
        let idx = c.waiters.iter().position(|w| w.pid == pid).ok_or(Errno::EINVAL)?;
        // Guard against the user re-associating the wait with a different
        // mutex between begin and check (POSIX allows mixing only if we
        // detect it; we'd rather return EINVAL than silently relock the
        // wrong lock).
        if c.waiters[idx].mutex_id != mutex_id {
            return Err(Errno::EINVAL);
        }
        if !c.waiters[idx].signaled {
            return Err(Errno::EAGAIN);
        }
        // Signaled. Try to reacquire the mutex.
        let m = self.mutexes.get_mut(&mutex_id).ok_or(Errno::EINVAL)?;
        if m.owner != 0 && m.owner != pid {
            // Mutex held by someone else — remain in waiter queue with
            // signaled=true; retry.
            return Err(Errno::EAGAIN);
        }
        m.owner = pid;
        m.recursive_count = 0;
        // Remove our waiter entry — we're awake.
        c.waiters.remove(idx);
        Ok(())
    }

    /// Abort a cond wait (e.g. on cancellation or timeout in a future
    /// extension). Removes the waiter without reacquiring the mutex.
    /// Returns `Ok(())` whether or not the waiter was present.
    pub fn cond_wait_abort(&mut self, cond_id: u32, pid: u32) {
        if let Some(c) = self.conds.get_mut(&cond_id) {
            c.waiters.retain(|w| w.pid != pid);
        }
    }

    /// Wake one waiter. Returns the pid that was signaled (or 0 if no
    /// waiters). The waiter itself still needs to retry and pick up the
    /// signal — this just marks them eligible.
    pub fn cond_signal(&mut self, cond_id: u32) -> Result<u32, Errno> {
        let c = self.conds.get_mut(&cond_id).ok_or(Errno::EINVAL)?;
        for w in c.waiters.iter_mut() {
            if !w.signaled {
                w.signaled = true;
                return Ok(w.pid);
            }
        }
        Ok(0)
    }

    /// Wake all waiters. Returns the number that were marked.
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
        let id = self.alloc_id();
        self.barriers.insert(id, PSharedBarrier {
            count,
            waiters: Vec::new(),
        });
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

    /// `pthread_barrier_wait`. Returns:
    /// - `Ok(0)` for a non-serial release
    /// - `Ok(PTHREAD_BARRIER_SERIAL_THREAD)` for exactly one caller per round
    /// - `Err(EAGAIN)` if waiting for more arrivals (host retries)
    pub fn barrier_wait(&mut self, id: u32, pid: u32) -> Result<i32, Errno> {
        let b = self.barriers.get_mut(&id).ok_or(Errno::EINVAL)?;

        // Retrying caller: check if our waiter has been released.
        if let Some(idx) = b.waiters.iter().position(|w| w.pid == pid) {
            if b.waiters[idx].released {
                let was_serial = b.waiters[idx].is_serial;
                b.waiters.remove(idx);
                return Ok(if was_serial { PTHREAD_BARRIER_SERIAL_THREAD } else { 0 });
            }
            return Err(Errno::EAGAIN);
        }

        // New arrival.
        b.waiters.push(BarrierWaiter { pid, is_serial: false, released: false });

        if b.waiters.len() as u32 == b.count {
            // This caller is the last arrival — release the round. Mark
            // this caller as the serial thread and all others as released.
            let last_idx = b.waiters.len() - 1;
            b.waiters[last_idx].is_serial = true;
            for w in b.waiters.iter_mut() {
                w.released = true;
            }
            // Consume our own entry.
            b.waiters.remove(last_idx);
            return Ok(PTHREAD_BARRIER_SERIAL_THREAD);
        }
        Err(Errno::EAGAIN)
    }

    // ═══════════════════════════════════════════════════════════════
    // Cleanup
    // ═══════════════════════════════════════════════════════════════

    /// Remove all waiter entries and release held mutexes owned by `pid`.
    /// Called from process removal.
    pub fn cleanup_process(&mut self, pid: u32) {
        // Drop owned mutex locks so peers aren't wedged.
        for m in self.mutexes.values_mut() {
            if m.owner == pid {
                m.owner = 0;
                m.recursive_count = 0;
            }
        }
        // Drop cond waiter entries.
        for c in self.conds.values_mut() {
            c.waiters.retain(|w| w.pid != pid);
        }
        // Drop barrier waiter entries.
        for b in self.barriers.values_mut() {
            b.waiters.retain(|w| w.pid != pid);
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

    #[test]
    fn mutex_basic_lock_unlock() {
        let mut t = PSharedTable::new();
        let id = t.mutex_init(MUTEX_TYPE_NORMAL);
        assert!(id > 0);
        assert_eq!(t.mutex_lock(id, 100), Ok(()));
        assert_eq!(t.mutex_unlock(id, 100), Ok(()));
    }

    #[test]
    fn mutex_ids_skip_zero() {
        let mut t = PSharedTable::new();
        // Fast-forward next_id to wrap boundary.
        t.next_id = u32::MAX;
        let id_a = t.alloc_id();
        let id_b = t.alloc_id();
        assert_eq!(id_a, u32::MAX);
        // After wrap, 0 is skipped.
        assert_eq!(id_b, 1);
    }

    #[test]
    fn mutex_contention_returns_eagain() {
        let mut t = PSharedTable::new();
        let id = t.mutex_init(MUTEX_TYPE_NORMAL);
        assert_eq!(t.mutex_lock(id, 100), Ok(()));
        // Different pid: EAGAIN (blocking lock).
        assert_eq!(t.mutex_lock(id, 200), Err(Errno::EAGAIN));
        // Trylock returns EBUSY instead.
        assert_eq!(t.mutex_trylock(id, 200), Err(Errno::EBUSY));
        // Unlock releases.
        assert_eq!(t.mutex_unlock(id, 100), Ok(()));
        // Now the other pid can lock.
        assert_eq!(t.mutex_lock(id, 200), Ok(()));
    }

    #[test]
    fn mutex_unlock_non_owner_eperm() {
        let mut t = PSharedTable::new();
        let id = t.mutex_init(MUTEX_TYPE_NORMAL);
        assert_eq!(t.mutex_lock(id, 100), Ok(()));
        assert_eq!(t.mutex_unlock(id, 200), Err(Errno::EPERM));
    }

    #[test]
    fn mutex_recursive_allows_nested_locks() {
        let mut t = PSharedTable::new();
        let id = t.mutex_init(MUTEX_TYPE_RECURSIVE);
        assert_eq!(t.mutex_lock(id, 100), Ok(()));
        assert_eq!(t.mutex_lock(id, 100), Ok(()));
        assert_eq!(t.mutex_lock(id, 100), Ok(()));
        assert_eq!(t.mutex_unlock(id, 100), Ok(()));
        assert_eq!(t.mutex_unlock(id, 100), Ok(()));
        // Still one lock left.
        assert_eq!(t.mutex_trylock(id, 200), Err(Errno::EBUSY));
        assert_eq!(t.mutex_unlock(id, 100), Ok(()));
        // Fully released now.
        assert_eq!(t.mutex_trylock(id, 200), Ok(()));
    }

    #[test]
    fn mutex_errorcheck_deadlock_detected() {
        let mut t = PSharedTable::new();
        let id = t.mutex_init(MUTEX_TYPE_ERRORCHECK);
        assert_eq!(t.mutex_lock(id, 100), Ok(()));
        assert_eq!(t.mutex_trylock(id, 100), Err(Errno::EDEADLK));
    }

    #[test]
    fn mutex_destroy_held_returns_ebusy() {
        let mut t = PSharedTable::new();
        let id = t.mutex_init(MUTEX_TYPE_NORMAL);
        assert_eq!(t.mutex_lock(id, 100), Ok(()));
        assert_eq!(t.mutex_destroy(id), Err(Errno::EBUSY));
        assert_eq!(t.mutex_unlock(id, 100), Ok(()));
        assert_eq!(t.mutex_destroy(id), Ok(()));
        // Subsequent lookup is EINVAL.
        assert_eq!(t.mutex_lock(id, 100), Err(Errno::EINVAL));
    }

    #[test]
    fn cond_wait_then_signal() {
        let mut t = PSharedTable::new();
        let mid = t.mutex_init(MUTEX_TYPE_NORMAL);
        let cid = t.cond_init();
        // pid 100 acquires mutex, then waits.
        assert_eq!(t.mutex_lock(mid, 100), Ok(()));
        assert_eq!(t.cond_wait_begin(cid, mid, 100), Ok(()));
        // Mutex is released during wait.
        assert_eq!(t.mutex_lock(mid, 200), Ok(()));
        assert_eq!(t.mutex_unlock(mid, 200), Ok(()));

        // No signal yet — waiter check returns EAGAIN.
        assert_eq!(t.cond_wait_check(cid, mid, 100), Err(Errno::EAGAIN));

        // Signal: marks waiter.
        assert_eq!(t.cond_signal(cid), Ok(100));

        // Waiter can now wake and reacquires mutex.
        assert_eq!(t.cond_wait_check(cid, mid, 100), Ok(()));
        // Now holds the mutex.
        assert_eq!(t.mutex_trylock(mid, 200), Err(Errno::EBUSY));
    }

    #[test]
    fn cond_signal_picks_oldest_waiter() {
        let mut t = PSharedTable::new();
        let mid = t.mutex_init(MUTEX_TYPE_NORMAL);
        let cid = t.cond_init();

        // Two distinct pids wait sequentially (not concurrent since each
        // must hold the mutex to begin waiting).
        assert_eq!(t.mutex_lock(mid, 100), Ok(()));
        assert_eq!(t.cond_wait_begin(cid, mid, 100), Ok(()));
        assert_eq!(t.mutex_lock(mid, 200), Ok(()));
        assert_eq!(t.cond_wait_begin(cid, mid, 200), Ok(()));

        // Signal wakes the oldest: pid 100.
        assert_eq!(t.cond_signal(cid), Ok(100));
        assert_eq!(t.cond_wait_check(cid, mid, 100), Ok(()));
        // pid 200 still blocked.
        assert_eq!(t.cond_wait_check(cid, mid, 200), Err(Errno::EAGAIN));

        // Release mutex, signal again.
        assert_eq!(t.mutex_unlock(mid, 100), Ok(()));
        assert_eq!(t.cond_signal(cid), Ok(200));
        assert_eq!(t.cond_wait_check(cid, mid, 200), Ok(()));
    }

    #[test]
    fn cond_broadcast_wakes_all() {
        let mut t = PSharedTable::new();
        let mid = t.mutex_init(MUTEX_TYPE_NORMAL);
        let cid = t.cond_init();

        assert_eq!(t.mutex_lock(mid, 100), Ok(()));
        assert_eq!(t.cond_wait_begin(cid, mid, 100), Ok(()));
        assert_eq!(t.mutex_lock(mid, 200), Ok(()));
        assert_eq!(t.cond_wait_begin(cid, mid, 200), Ok(()));
        assert_eq!(t.mutex_lock(mid, 300), Ok(()));
        assert_eq!(t.cond_wait_begin(cid, mid, 300), Ok(()));

        assert_eq!(t.cond_broadcast(cid), Ok(3));

        // First retry grabs mutex. Others get EAGAIN (mutex held).
        assert_eq!(t.cond_wait_check(cid, mid, 100), Ok(()));
        assert_eq!(t.cond_wait_check(cid, mid, 200), Err(Errno::EAGAIN));
        assert_eq!(t.cond_wait_check(cid, mid, 300), Err(Errno::EAGAIN));
        // After unlock, next retry succeeds.
        assert_eq!(t.mutex_unlock(mid, 100), Ok(()));
        assert_eq!(t.cond_wait_check(cid, mid, 200), Ok(()));
        assert_eq!(t.mutex_unlock(mid, 200), Ok(()));
        assert_eq!(t.cond_wait_check(cid, mid, 300), Ok(()));
    }

    #[test]
    fn cond_wait_begin_without_mutex_is_eperm() {
        let mut t = PSharedTable::new();
        let mid = t.mutex_init(MUTEX_TYPE_NORMAL);
        let cid = t.cond_init();
        // pid 100 tries to wait without holding the mutex.
        assert_eq!(t.cond_wait_begin(cid, mid, 100), Err(Errno::EPERM));
    }

    #[test]
    fn cond_wait_check_without_begin_is_einval() {
        let mut t = PSharedTable::new();
        let mid = t.mutex_init(MUTEX_TYPE_NORMAL);
        let cid = t.cond_init();
        assert_eq!(t.cond_wait_check(cid, mid, 100), Err(Errno::EINVAL));
    }

    #[test]
    fn cond_signal_no_waiters_returns_zero() {
        let mut t = PSharedTable::new();
        let cid = t.cond_init();
        assert_eq!(t.cond_signal(cid), Ok(0));
        assert_eq!(t.cond_broadcast(cid), Ok(0));
    }

    #[test]
    fn cond_destroy_with_waiters_is_ebusy() {
        let mut t = PSharedTable::new();
        let mid = t.mutex_init(MUTEX_TYPE_NORMAL);
        let cid = t.cond_init();
        t.mutex_lock(mid, 100).unwrap();
        t.cond_wait_begin(cid, mid, 100).unwrap();
        assert_eq!(t.cond_destroy(cid), Err(Errno::EBUSY));
        t.cond_wait_abort(cid, 100);
        assert_eq!(t.cond_destroy(cid), Ok(()));
    }

    #[test]
    fn barrier_releases_when_count_reached() {
        let mut t = PSharedTable::new();
        let id = t.barrier_init(2).unwrap();
        // First arrival: EAGAIN.
        assert_eq!(t.barrier_wait(id, 100), Err(Errno::EAGAIN));
        // First arrival retries: still EAGAIN until final arrival.
        assert_eq!(t.barrier_wait(id, 100), Err(Errno::EAGAIN));
        // Final arrival releases and returns SERIAL.
        assert_eq!(t.barrier_wait(id, 200), Ok(PTHREAD_BARRIER_SERIAL_THREAD));
        // First arrival retries and now reaps 0 (non-serial).
        assert_eq!(t.barrier_wait(id, 100), Ok(0));
    }

    #[test]
    fn barrier_three_participants() {
        let mut t = PSharedTable::new();
        let id = t.barrier_init(3).unwrap();
        assert_eq!(t.barrier_wait(id, 100), Err(Errno::EAGAIN));
        assert_eq!(t.barrier_wait(id, 200), Err(Errno::EAGAIN));
        assert_eq!(t.barrier_wait(id, 300), Ok(PTHREAD_BARRIER_SERIAL_THREAD));
        assert_eq!(t.barrier_wait(id, 100), Ok(0));
        assert_eq!(t.barrier_wait(id, 200), Ok(0));
    }

    #[test]
    fn barrier_reusable_across_rounds() {
        let mut t = PSharedTable::new();
        let id = t.barrier_init(2).unwrap();
        // Round 1.
        assert_eq!(t.barrier_wait(id, 100), Err(Errno::EAGAIN));
        assert_eq!(t.barrier_wait(id, 200), Ok(PTHREAD_BARRIER_SERIAL_THREAD));
        assert_eq!(t.barrier_wait(id, 100), Ok(0));
        // Round 2.
        assert_eq!(t.barrier_wait(id, 200), Err(Errno::EAGAIN));
        assert_eq!(t.barrier_wait(id, 100), Ok(PTHREAD_BARRIER_SERIAL_THREAD));
        assert_eq!(t.barrier_wait(id, 200), Ok(0));
    }

    #[test]
    fn barrier_zero_count_invalid() {
        let mut t = PSharedTable::new();
        assert_eq!(t.barrier_init(0), Err(Errno::EINVAL));
    }

    #[test]
    fn barrier_destroy_with_waiters_is_ebusy() {
        let mut t = PSharedTable::new();
        let id = t.barrier_init(2).unwrap();
        assert_eq!(t.barrier_wait(id, 100), Err(Errno::EAGAIN));
        assert_eq!(t.barrier_destroy(id), Err(Errno::EBUSY));
    }

    #[test]
    fn cleanup_releases_owned_mutex_and_clears_waiters() {
        let mut t = PSharedTable::new();
        let mid = t.mutex_init(MUTEX_TYPE_NORMAL);
        let cid = t.cond_init();
        let bid = t.barrier_init(3).unwrap();

        // pid 100 holds mutex and is waiting on cond and barrier.
        t.mutex_lock(mid, 100).unwrap();
        t.cond_wait_begin(cid, mid, 100).unwrap();
        // mutex was released by cond_wait_begin; re-lock so cleanup has something to release.
        t.mutex_lock(mid, 100).unwrap();
        t.barrier_wait(bid, 100).unwrap_err();

        t.cleanup_process(100);

        // Mutex is released.
        assert_eq!(t.mutex_lock(mid, 200), Ok(()));
        // Cond waiter removed.
        assert_eq!(t.cond_signal(cid), Ok(0));
        // Barrier waiter removed.
        assert_eq!(t.barrier_wait(bid, 200), Err(Errno::EAGAIN));
    }

    #[test]
    fn invalid_ids_return_einval() {
        let mut t = PSharedTable::new();
        assert_eq!(t.mutex_lock(999, 100), Err(Errno::EINVAL));
        assert_eq!(t.mutex_unlock(999, 100), Err(Errno::EINVAL));
        assert_eq!(t.mutex_destroy(999), Err(Errno::EINVAL));
        assert_eq!(t.cond_signal(999), Err(Errno::EINVAL));
        assert_eq!(t.cond_broadcast(999), Err(Errno::EINVAL));
        assert_eq!(t.cond_destroy(999), Err(Errno::EINVAL));
        assert_eq!(t.barrier_wait(999, 100), Err(Errno::EINVAL));
        assert_eq!(t.barrier_destroy(999), Err(Errno::EINVAL));
    }
}
