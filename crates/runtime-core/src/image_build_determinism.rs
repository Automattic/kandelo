//! Deterministic image-build mode: a guest wall clock and entropy source that
//! are a pure function of an explicit seed, for the kernels an image builder
//! boots *while building an image*.
//!
//! # Why this exists
//!
//! Some VFS image packages run real software during their build. The
//! WordPress and LAMP images run WordPress's installer (and bootstrap
//! MariaDB) so a machine boots already installed. Everything that software
//! writes becomes part of the image, and an image package is cached by its
//! content key, so two builds under one key must produce the same bytes
//! ("Reproducible VFS image packages" in `docs/package-management.md`). The
//! installers read the wall clock (`user_registered`, post dates, MariaDB's
//! table UUIDs) and the entropy source (bcrypt salts, UUID bits), so with a
//! live clock and live entropy no two builds agree.
//!
//! Rewriting those rows or files after the installer ran would hide where
//! the bytes come from. Instead the kernel that runs the installer answers
//! the two questions the installer asks -- "what time is it?" and "give me
//! random bytes" -- from the build's declared inputs: an epoch (the
//! `SOURCE_DATE_EPOCH` instant the image writer stamps on every inode) and a
//! seed. The same inputs then yield the same image.
//!
//! # The security boundary
//!
//! Seeded entropy is not entropy. Everything derived from it is public:
//! anyone with the repository can recompute every "random" byte a build
//! produced. That is acceptable only because (a) the mode exists solely for
//! kernels an image *builder* boots, and (b) the images that use it replace
//! every secret the installer generated on each machine's first boot, from
//! the machine's real entropy source (the `wordpress-secrets` first-boot service; see
//! `docs/package-management.md`).
//!
//! Enabling it is therefore deliberately narrow:
//!
//! * No syscall, ioctl, `/proc` file or device enables, disables or
//!   reconfigures it. The only entry point is the host-called kernel export
//!   `kernel_set_image_build_determinism`, and guests cannot call kernel
//!   exports.
//! * It is set at most once, and only before the first user process exists
//!   (the export enforces that). A kernel that has run a guest on real
//!   entropy cannot be switched to seeded entropy, and a seeded kernel cannot
//!   be switched back.
//! * Only the Node host can pass it (`NodeKernelHost`'s
//!   `imageBuildDeterminism` option, used by the image builders). The browser
//!   host has no way to express it: neither its worker protocol, nor boot
//!   descriptors, nor share URLs carry the setting.
//!
//! # What changes, and what does not
//!
//! * `CLOCK_REALTIME` (and `CLOCK_REALTIME_COARSE`, which the syscall layer
//!   maps onto it) is a per-task logical clock: `epoch + n µs + waited`,
//!   where `n` counts the calling task's own earlier realtime reads and
//!   `waited` is the time the task has spent in sleeps and in timed waits
//!   that ran to their timeout. A task's readings therefore depend only on
//!   its own history, not on how it interleaves with other tasks or how fast
//!   the host runs.
//!   - It advances a little over a microsecond per read, instead of
//!     standing still, because software polls for the clock to change:
//!     PHP's `uniqid()` spins until `gettimeofday()` moves. The step is
//!     1001 ns, not 1000, so that coarser units do not always roll over at
//!     the same parity of read: MariaDB's timer calibration reads the clock
//!     in pairs until the two readings of one pair differ in milliseconds,
//!     and with an exact microsecond step every millisecond boundary fell
//!     between pairs, so the loop never ended.
//!   - It advances by a sleep's duration, and by a timed wait's full timeout
//!     when the wait expires, because software waits for an absolute
//!     realtime deadline that another thread computed. MariaDB's timer
//!     thread sleeps until the earliest queued timer's expiry and then
//!     checks `now >= expiry`; a clock that only counted reads never got
//!     there, and server startup stalled on it. A wait that ends early (its
//!     event arrived) adds nothing, so a timeout it never reached does not
//!     leak into the task's time.
//! * `getrandom(2)`, `/dev/urandom`, `/dev/random` and kernel-internal
//!   entropy (the network interface's MAC address) return
//!   `SHA-256(domain || SHA-256(seed) || process || thread || counter)`
//!   blocks, again per task so the interleaving of tasks does not change what
//!   any task gets. A task is named by its process's creation ordinal and its
//!   thread's creation ordinal within that process, not by its pid and tid:
//!   processes and threads share one id sequence, so a multithreaded server
//!   that starts threads on timing-dependent demand (MariaDB's thread pool)
//!   shifts the pid of every process started after it. With pids in the key,
//!   WordPress's installer drew a different password salt on every LAMP
//!   build.
//! * The guest's `CLOCK_MONOTONIC` (and `CLOCK_BOOTTIME` and the coarse
//!   variant) is the same per-task logical clock counted from a fixed base
//!   instead of the epoch: MariaDB builds its time-based UUIDs -- stamped
//!   into every `.frm` and Aria table header -- from `CLOCK_MONOTONIC` plus an
//!   offset, so a real monotonic clock made every table differ between
//!   builds. Both clocks share one per-task counter, so they advance
//!   together.
//! * The kernel's own deadlines stay on the host's real monotonic clock:
//!   timeouts, sleeps and poll deadlines are measured there, so software
//!   still makes progress in real time. CPU-time clocks stay real; nothing
//!   the installers persist is derived from them.
//!
//! This is not faithful POSIX time: two tasks can observe different
//! realtime values, and realtime does not track elapsed time. That is the
//! purpose of the mode, and why it must never reach a machine a person uses.

use alloc::collections::BTreeMap;
use core::cell::UnsafeCell;

use sha2::{Digest, Sha256};
use wasm_posix_shared::Errno;

/// Longest seed accepted. The kernel export passes the host's 64-bit seed as
/// its 8 little-endian bytes; the bound keeps the input to the digest small.
pub const MAX_SEED_LEN: usize = 256;

/// Clock advance per read, in nanoseconds: at least the one microsecond
/// resolution of `gettimeofday`, so consecutive reads always differ there,
/// and not a divisor of a millisecond or a second (see the module notes on
/// MariaDB's calibration loop).
const REALTIME_STEP_NS: u64 = 1_001;

/// Where the guest's monotonic clock starts. Any fixed value works; it is
/// nonzero because some software reads a zero timestamp as "unset".
pub const MONOTONIC_BASE_SEC: u64 = 1;

const SEED_DOMAIN: &[u8] = b"kandelo image-build seed v1\0";
const ENTROPY_DOMAIN: &[u8] = b"kandelo image-build entropy v1\0";

#[derive(Default)]
struct TaskState {
    realtime_reads: u64,
    /// Time spent in sleeps and in timed waits that reached their timeout.
    waited_ns: u64,
    entropy_blocks: u64,
}

/// A timed wait in progress: whose clock to credit if it expires, and by how
/// much.
struct TimedWait {
    task: (u32, u32),
    timeout_ns: u64,
}

/// The main thread is named by its process id in some kernel paths and by 0
/// in others; both mean the same clock.
fn task_key(pid: u32, tid: u32) -> (u32, u32) {
    (pid, if tid == 0 { pid } else { tid })
}

/// The mode's state: the build's epoch and seed, and each task's position in
/// its clock and entropy streams.
pub struct Determinism {
    epoch_sec: u64,
    seed_digest: [u8; 32],
    tasks: BTreeMap<(u32, u32), TaskState>,
    timed_waits: BTreeMap<u64, TimedWait>,
    /// pid -> creation ordinal among processes created in this kernel.
    process_ordinals: BTreeMap<u32, u32>,
    next_process_ordinal: u32,
    /// (pid, tid) -> creation ordinal among that process's threads (the
    /// main thread is 0).
    thread_ordinals: BTreeMap<(u32, u32), u32>,
    next_thread_ordinal: BTreeMap<u32, u32>,
}

impl Determinism {
    /// `EINVAL` for an empty or oversized seed.
    pub fn new(seed: &[u8], epoch_sec: u64) -> Result<Self, Errno> {
        if seed.is_empty() || seed.len() > MAX_SEED_LEN || epoch_sec > i64::MAX as u64 {
            return Err(Errno::EINVAL);
        }
        let mut hasher = Sha256::new();
        hasher.update(SEED_DOMAIN);
        hasher.update(seed);
        let mut seed_digest = [0u8; 32];
        seed_digest.copy_from_slice(&hasher.finalize());
        Ok(Self {
            epoch_sec,
            seed_digest,
            tasks: BTreeMap::new(),
            timed_waits: BTreeMap::new(),
            process_ordinals: BTreeMap::new(),
            next_process_ordinal: 0,
            thread_ordinals: BTreeMap::new(),
            next_thread_ordinal: BTreeMap::new(),
        })
    }

    pub fn epoch_sec(&self) -> u64 {
        self.epoch_sec
    }

    /// Task `(pid, tid)`'s logical elapsed time for its next clock read.
    fn next_elapsed_ns(&mut self, pid: u32, tid: u32) -> u64 {
        let task = self.tasks.entry(task_key(pid, tid)).or_default();
        let offset_ns = task
            .realtime_reads
            .saturating_mul(REALTIME_STEP_NS)
            .saturating_add(task.waited_ns);
        task.realtime_reads = task.realtime_reads.saturating_add(1);
        offset_ns
    }

    fn reading(base_sec: u64, offset_ns: u64) -> (i64, i64) {
        let sec = base_sec
            .saturating_add(offset_ns / 1_000_000_000)
            .min(i64::MAX as u64);
        (sec as i64, (offset_ns % 1_000_000_000) as i64)
    }

    /// The next realtime reading for task `(pid, tid)`.
    pub fn realtime(&mut self, pid: u32, tid: u32) -> (i64, i64) {
        let offset_ns = self.next_elapsed_ns(pid, tid);
        Self::reading(self.epoch_sec, offset_ns)
    }

    /// The next guest-visible monotonic reading for task `(pid, tid)`.
    pub fn monotonic(&mut self, pid: u32, tid: u32) -> (i64, i64) {
        let offset_ns = self.next_elapsed_ns(pid, tid);
        Self::reading(MONOTONIC_BASE_SEC, offset_ns)
    }

    /// Fill `buf` with task `(pid, tid)`'s next seeded bytes. Each call
    /// consumes whole 32-byte blocks, so what a call returns depends only on
    /// the lengths of that task's earlier calls.
    /// Advance task `(pid, tid)`'s clock by time it spent waiting.
    pub fn credit_wait(&mut self, pid: u32, tid: u32, ns: u64) {
        let task = self.tasks.entry(task_key(pid, tid)).or_default();
        task.waited_ns = task.waited_ns.saturating_add(ns);
    }

    /// A timed wait identified by `handle` began for task `(pid, tid)`.
    pub fn timed_wait_opened(&mut self, handle: u64, pid: u32, tid: u32, timeout_ns: u64) {
        self.timed_waits.insert(
            handle,
            TimedWait {
                task: task_key(pid, tid),
                timeout_ns,
            },
        );
    }

    /// The wait reached its timeout: credit its task with the full timeout,
    /// once.
    pub fn timed_wait_expired(&mut self, handle: u64) {
        if let Some(wait) = self.timed_waits.remove(&handle) {
            self.credit_wait(wait.task.0, wait.task.1, wait.timeout_ns);
        }
    }

    /// The wait ended; if it did not expire first, it credits nothing.
    pub fn timed_wait_closed(&mut self, handle: u64) {
        self.timed_waits.remove(&handle);
    }

    /// A process `pid` was created: it takes the next process ordinal.
    pub fn process_created(&mut self, pid: u32) {
        let ordinal = self.next_process_ordinal;
        self.next_process_ordinal = self.next_process_ordinal.wrapping_add(1);
        self.process_ordinals.insert(pid, ordinal);
    }

    /// A thread `tid` was created in `pid`: it takes that process's next
    /// thread ordinal (the main thread is 0).
    pub fn thread_created(&mut self, pid: u32, tid: u32) {
        let next = self.next_thread_ordinal.entry(pid).or_insert(0);
        *next = next.wrapping_add(1);
        self.thread_ordinals.insert((pid, tid), *next);
    }

    /// The name a task's entropy stream is derived from. A task the mode
    /// never saw created (the kernel itself, or anything that predates the
    /// mode) is named by its raw ids under a distinct tag.
    fn stream_name(&self, pid: u32, tid: u32) -> (u8, u32, u32) {
        let (pid, tid) = task_key(pid, tid);
        match self.process_ordinals.get(&pid) {
            Some(&process) => {
                let thread = if tid == pid {
                    0
                } else {
                    self.thread_ordinals.get(&(pid, tid)).copied().unwrap_or(u32::MAX)
                };
                (1, process, thread)
            }
            None => (0, pid, tid),
        }
    }

    pub fn fill_random(&mut self, pid: u32, tid: u32, buf: &mut [u8]) {
        let seed_digest = self.seed_digest;
        let (tag, process, thread) = self.stream_name(pid, tid);
        let task = self.tasks.entry(task_key(pid, tid)).or_default();
        for chunk in buf.chunks_mut(32) {
            let mut hasher = Sha256::new();
            hasher.update(ENTROPY_DOMAIN);
            hasher.update(seed_digest);
            hasher.update([tag]);
            hasher.update(process.to_le_bytes());
            hasher.update(thread.to_le_bytes());
            hasher.update(task.entropy_blocks.to_le_bytes());
            task.entropy_blocks = task.entropy_blocks.wrapping_add(1);
            let block = hasher.finalize();
            chunk.copy_from_slice(&block[..chunk.len()]);
        }
    }
}

/// Whether `clock_id`, as the syscall layer hands it to the host, names the
/// wall clock this mode replaces.
pub fn is_realtime_clock(clock_id: u32) -> bool {
    use wasm_posix_shared::clock::{CLOCK_REALTIME, CLOCK_REALTIME_COARSE};
    clock_id == CLOCK_REALTIME || clock_id == CLOCK_REALTIME_COARSE
}

struct Global(UnsafeCell<Option<Determinism>>);

// SAFETY: the kernel services one entry at a time under the global kernel
// lock, the same discipline as `process_table::GLOBAL_PROCESS_TABLE`.
unsafe impl Sync for Global {}

static STATE: Global = Global(UnsafeCell::new(None));

fn global() -> &'static mut Option<Determinism> {
    // SAFETY: see `Global`.
    unsafe { &mut *STATE.0.get() }
}

/// Enable the mode for this kernel. `EBUSY` if it is already enabled: it is
/// set once and never changes. The caller (the kernel export) must also
/// refuse once any user process exists.
pub fn enable(seed: &[u8], epoch_sec: u64) -> Result<(), Errno> {
    let slot = global();
    if slot.is_some() {
        return Err(Errno::EBUSY);
    }
    *slot = Some(Determinism::new(seed, epoch_sec)?);
    Ok(())
}

pub fn is_enabled() -> bool {
    global().is_some()
}

/// The configured epoch, when enabled.
pub fn epoch_sec() -> Option<u64> {
    global().as_ref().map(Determinism::epoch_sec)
}

/// The calling task's next realtime reading, or `None` when the mode is off
/// (the caller then asks the host).
pub fn realtime_for_current_task() -> Option<(i64, i64)> {
    let state = global().as_mut()?;
    Some(state.realtime(
        crate::process_table::current_pid(),
        crate::process_table::current_tid(),
    ))
}

/// The calling task's next guest-visible monotonic reading, or `None` when
/// the mode is off (the caller then asks the host). Only the syscall layer's
/// guest-facing reads use this; the kernel's own deadlines stay real.
pub fn monotonic_for_current_task() -> Option<(i64, i64)> {
    let state = global().as_mut()?;
    Some(state.monotonic(
        crate::process_table::current_pid(),
        crate::process_table::current_tid(),
    ))
}

/// Whether `clock_id`, as the syscall layer hands it to the host, is the
/// guest's monotonic clock family this mode replaces.
pub fn is_monotonic_clock(clock_id: u32) -> bool {
    use wasm_posix_shared::clock::{CLOCK_BOOTTIME, CLOCK_MONOTONIC, CLOCK_MONOTONIC_COARSE};
    clock_id == CLOCK_MONOTONIC || clock_id == CLOCK_MONOTONIC_COARSE || clock_id == CLOCK_BOOTTIME
}

/// Fill `buf` from the calling task's seeded stream. Returns `false`, leaving
/// `buf` untouched, when the mode is off (the caller then asks the host).
pub fn fill_random_for_current_task(buf: &mut [u8]) -> bool {
    let Some(state) = global().as_mut() else {
        return false;
    };
    state.fill_random(
        crate::process_table::current_pid(),
        crate::process_table::current_tid(),
        buf,
    );
    true
}

/// Credit the calling task's clock with a sleep it is about to take.
pub fn credit_current_task_sleep(ns: u64) {
    if let Some(state) = global().as_mut() {
        state.credit_wait(
            crate::process_table::current_pid(),
            crate::process_table::current_tid(),
            ns,
        );
    }
}

/// See [`Determinism::process_created`]. No-op when the mode is off.
pub fn process_created(pid: u32) {
    if let Some(state) = global().as_mut() {
        state.process_created(pid);
    }
}

/// See [`Determinism::thread_created`]. No-op when the mode is off.
pub fn thread_created(pid: u32, tid: u32) {
    if let Some(state) = global().as_mut() {
        state.thread_created(pid, tid);
    }
}

/// See [`Determinism::timed_wait_opened`]. No-op when the mode is off.
pub fn timed_wait_opened(handle: u64, pid: u32, tid: u32, timeout_ns: u64) {
    if let Some(state) = global().as_mut() {
        state.timed_wait_opened(handle, pid, tid, timeout_ns);
    }
}

/// See [`Determinism::timed_wait_expired`]. No-op when the mode is off.
pub fn timed_wait_expired(handle: u64) {
    if let Some(state) = global().as_mut() {
        state.timed_wait_expired(handle);
    }
}

/// See [`Determinism::timed_wait_closed`]. No-op when the mode is off.
pub fn timed_wait_closed(handle: u64) {
    if let Some(state) = global().as_mut() {
        state.timed_wait_closed(handle);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_seed_and_task_history_give_the_same_bytes() {
        let mut a = Determinism::new(b"kandelo-image:test", 315_532_800).unwrap();
        let mut b = Determinism::new(b"kandelo-image:test", 315_532_800).unwrap();
        let (mut x, mut y) = ([0u8; 70], [0u8; 70]);
        a.fill_random(100, 0, &mut x);
        b.fill_random(100, 0, &mut y);
        assert_eq!(x, y);
        assert_ne!(x[..32], x[32..64], "consecutive blocks must differ");
    }

    /// Two builds in which a thread pool started a different number of
    /// threads before the installer ran: the installer gets a different pid,
    /// and must still draw the same bytes.
    #[test]
    fn a_processes_stream_does_not_depend_on_its_pid() {
        let mut quiet = Determinism::new(b"s", 0).unwrap();
        quiet.process_created(100); // server
        quiet.thread_created(100, 101);
        quiet.process_created(102); // installer
        let mut busy = Determinism::new(b"s", 0).unwrap();
        busy.process_created(100); // server
        for tid in 101..110 {
            busy.thread_created(100, tid);
        }
        busy.process_created(110); // installer
        let (mut x, mut y) = ([0u8; 32], [0u8; 32]);
        quiet.fill_random(102, 102, &mut x);
        busy.fill_random(110, 0, &mut y);
        assert_eq!(x, y);
        // The server's first extra thread matches too.
        quiet.fill_random(100, 101, &mut x);
        busy.fill_random(100, 101, &mut y);
        assert_eq!(x, y);
        // And distinct tasks still draw distinct streams.
        busy.fill_random(100, 102, &mut x);
        assert_ne!(x, y);
    }

    #[test]
    fn different_seeds_give_different_bytes() {
        let mut a = Determinism::new(b"seed-a", 0).unwrap();
        let mut b = Determinism::new(b"seed-b", 0).unwrap();
        let (mut x, mut y) = ([0u8; 32], [0u8; 32]);
        a.fill_random(100, 0, &mut x);
        b.fill_random(100, 0, &mut y);
        assert_ne!(x, y);
    }

    /// What one task receives must not depend on what other tasks asked for
    /// in between: concurrent consumers (MariaDB threads, PHP) interleave in
    /// a timing-dependent order.
    #[test]
    fn a_tasks_stream_is_independent_of_other_tasks() {
        let mut quiet = Determinism::new(b"s", 0).unwrap();
        let mut busy = Determinism::new(b"s", 0).unwrap();
        let mut noise = [0u8; 64];
        busy.fill_random(101, 0, &mut noise);
        busy.fill_random(100, 7, &mut noise);
        let _ = busy.realtime(100, 7);
        let (mut x, mut y) = ([0u8; 16], [0u8; 16]);
        quiet.fill_random(100, 0, &mut x);
        busy.fill_random(100, 0, &mut y);
        assert_eq!(x, y);
        assert_eq!(quiet.realtime(100, 0), busy.realtime(100, 0));
        let mut other = [0u8; 16];
        quiet.fill_random(101, 0, &mut other);
        assert_ne!(x, other, "distinct tasks draw from distinct streams");
    }

    #[test]
    fn realtime_starts_at_the_epoch_and_advances_just_over_a_microsecond_per_read() {
        let mut d = Determinism::new(b"s", 315_532_800).unwrap();
        assert_eq!(d.realtime(100, 0), (315_532_800, 0));
        assert_eq!(d.realtime(100, 0), (315_532_800, 1_001));
        assert_eq!(d.realtime(100, 0), (315_532_800, 2_002));
        assert_eq!(d.realtime(200, 0), (315_532_800, 0));
        for _ in 3..999_001 {
            let _ = d.realtime(100, 0);
        }
        assert_eq!(d.realtime(100, 0), (315_532_801, 1));
    }

    /// MariaDB's `my_timer_init_resolution` reads a millisecond timer twice
    /// per iteration and stops once the two readings of one pair differ.
    /// With a step that divides a millisecond, every rollover fell between
    /// pairs and the loop ran its full ten million iterations.
    #[test]
    fn paired_reads_see_a_millisecond_rollover() {
        let mut d = Determinism::new(b"s", 0).unwrap();
        let ms = |(sec, nsec): (i64, i64)| sec as u64 * 1_000 + nsec as u64 / 1_000_000;
        let mut pairs = 0;
        loop {
            let first = ms(d.monotonic(100, 0));
            let second = ms(d.monotonic(100, 0));
            pairs += 1;
            if first != second {
                break;
            }
            assert!(pairs < 10_000, "no rollover within a pair");
        }
    }

    /// A thread that sleeps until another thread's realtime deadline must
    /// get there: MariaDB's timer thread does exactly this, and a clock that
    /// only counted reads stalled server startup.
    #[test]
    fn waiting_to_a_timeout_advances_only_the_waiting_tasks_clock() {
        let mut d = Determinism::new(b"s", 1_000).unwrap();
        let ns = |(sec, nsec): (i64, i64)| (sec as u64 - 1_000) * 1_000_000_000 + nsec as u64;
        // Another thread has read the clock many times, and queued a timer
        // one second past its own now.
        for _ in 0..5_000 {
            let _ = d.realtime(100, 7);
        }
        let expiry_ns = ns(d.realtime(100, 7)) + 1_000_000_000;
        // The timer thread waits for the difference from its own clock.
        let timer_now = ns(d.realtime(100, 3));
        d.timed_wait_opened(42, 100, 3, expiry_ns - timer_now);
        d.timed_wait_expired(42);
        d.timed_wait_expired(42); // credited once
        let after = ns(d.realtime(100, 3));
        assert!(after >= expiry_ns, "the timer thread reached the deadline");
        assert!(after < expiry_ns + 10_000);
        // A wait that ends early credits nothing.
        d.timed_wait_opened(43, 100, 3, 5_000_000_000);
        d.timed_wait_closed(43);
        d.timed_wait_expired(43);
        assert!(ns(d.realtime(100, 3)) < after + 10_000);
        // The main thread is one clock whether named by pid or by 0.
        d.credit_wait(200, 0, 2_000_000_000);
        assert_eq!(d.realtime(200, 200).0, 1_002);
    }

    #[test]
    fn empty_or_oversized_seeds_are_refused() {
        assert_eq!(Determinism::new(b"", 0).err(), Some(Errno::EINVAL));
        let long = [b'x'; MAX_SEED_LEN + 1];
        assert_eq!(Determinism::new(&long, 0).err(), Some(Errno::EINVAL));
        assert!(Determinism::new(&long[..MAX_SEED_LEN], 0).is_ok());
    }

    #[test]
    fn monotonic_shares_the_tasks_counter_from_a_fixed_base() {
        let mut d = Determinism::new(b"s", 315_532_800).unwrap();
        assert_eq!(d.monotonic(100, 0), (MONOTONIC_BASE_SEC as i64, 0));
        assert_eq!(d.realtime(100, 0), (315_532_800, 1_001));
        assert_eq!(d.monotonic(100, 0), (MONOTONIC_BASE_SEC as i64, 2_002));
        d.credit_wait(100, 0, 3_000_000_000);
        assert_eq!(d.monotonic(100, 0).0, MONOTONIC_BASE_SEC as i64 + 3);
        assert!(is_monotonic_clock(wasm_posix_shared::clock::CLOCK_MONOTONIC));
        assert!(is_monotonic_clock(wasm_posix_shared::clock::CLOCK_BOOTTIME));
        assert!(!is_monotonic_clock(wasm_posix_shared::clock::CLOCK_REALTIME));
        assert!(!is_monotonic_clock(wasm_posix_shared::clock::CLOCK_PROCESS_CPUTIME_ID));
    }

    #[test]
    fn only_the_wall_clock_is_replaced() {
        use wasm_posix_shared::clock::*;
        assert!(is_realtime_clock(CLOCK_REALTIME));
        assert!(is_realtime_clock(CLOCK_REALTIME_COARSE));
        for id in [
            CLOCK_MONOTONIC,
            CLOCK_PROCESS_CPUTIME_ID,
            CLOCK_THREAD_CPUTIME_ID,
            CLOCK_MONOTONIC_COARSE,
            CLOCK_BOOTTIME,
        ] {
            assert!(!is_realtime_clock(id));
        }
    }
}
