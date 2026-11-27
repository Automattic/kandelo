//! SDK foreign-memory execution contract. No allocation or lifecycle authority.
pub const MODULE: &str = "kandelo.host-memory.v2";
pub const VERSION: u32 = 2;
pub const BOUNDS: i32 = -1;
pub const PROTECTION: i32 = -2;
pub const METADATA: i32 = -3;
pub const BUSY: i32 = -4;
pub const PUBLICATION_FAILED: i32 = -5;

use crate::program_extensions::memory_group_v3 as L;

/// Operations on an already bound foreign memory. This interface supplies no
/// admission, allocation, image ownership or reclamation authority.
pub trait Memory {
    fn bytes(&self) -> u64;
    fn load(&self, address: u32) -> u32;
    fn store(&mut self, address: u32, value: u32);
    fn compare_exchange(&mut self, address: u32, expected: u32, value: u32) -> u32;
    fn wait_value(&mut self, address: u32, expected: u32);
    fn wake(&mut self, address: u32, count: u32);
}

/// Wait on the exact task's kernel-owned fork gate. No allocation, commit or
/// lifecycle decision is made here: only the kernel can publish the outcome.
pub fn wait_fork_replay(memory: &mut impl Memory, replica: u32) -> i32 {
    if replica < L::PAGE_BYTES
        || replica % L::PAGE_BYTES != 0
        || u64::from(replica) + u64::from(L::REPLICA_BYTES) > memory.bytes()
        || memory.load(replica + L::REPLICA_MAGIC_OFFSET) != L::REPLICA_MAGIC
    {
        return METADATA;
    }
    loop {
        if memory.load(replica + L::REPLICA_RUN) != 1 {
            return PROTECTION;
        }
        match memory.load(replica + L::REPLICA_FORK_REPLAY) {
            L::REPLAY_COMMITTED => return 0,
            L::REPLAY_CANCELLED => return PROTECTION,
            L::REPLAY_PENDING => {
                memory.wait_value(replica + L::REPLICA_FORK_REPLAY, L::REPLAY_PENDING)
            }
            L::REPLAY_PAUSED => {
                let epoch = memory.load(replica + L::REPLICA_REQUEST);
                if epoch != 0 {
                    memory.store(replica + L::REPLICA_ACK, epoch);
                    memory.wake(replica + L::REPLICA_ACK, u32::MAX);
                    memory.wait_value(replica + L::REPLICA_REQUEST, epoch);
                }
            }
            _ => return METADATA,
        }
    }
}

pub fn length(memory: &impl Memory, root: u32, maximum: u32) -> i64 {
    if root < L::PAGE_BYTES
        || root % L::PAGE_BYTES != 0
        || maximum == 0
        || maximum > 65536
        || u64::from(root) + u64::from(L::ROOT_HEADER_BYTES) + u64::from(maximum) * 4
            > memory.bytes()
    {
        return i64::from(METADATA);
    }
    let pages = memory.load(root);
    if pages > maximum {
        return i64::from(METADATA);
    }
    i64::from(pages) * i64::from(L::PAGE_BYTES)
}

#[inline(always)]
fn entry(memory: &impl Memory, root: u32, address: u64, rights: u32) -> Result<u32, i32> {
    let pte =
        memory.load(root + L::ROOT_HEADER_BYTES + (address / u64::from(L::PAGE_BYTES)) as u32 * 4);
    let frame = pte & 0xffff0000;
    if pte & rights != rights || frame == 0 {
        return Err(PROTECTION);
    }
    if u64::from(frame) + u64::from(L::PAGE_BYTES) > memory.bytes() {
        return Err(METADATA);
    }
    Ok(frame + (address % u64::from(L::PAGE_BYTES)) as u32)
}

pub fn check(
    memory: &impl Memory,
    root: u32,
    maximum: u32,
    mut address: u64,
    mut bytes: u64,
    rights: u32,
) -> i32 {
    let limit = length(memory, root, maximum);
    if limit < 0 {
        return limit as i32;
    }
    if address > limit as u64 || bytes > limit as u64 - address {
        return BOUNDS;
    }
    if rights == 0 || rights > 3 {
        return METADATA;
    }
    while bytes != 0 {
        if let Err(error) = entry(memory, root, address, rights) {
            return error;
        }
        let count = bytes.min(u64::from(L::PAGE_BYTES) - address % u64::from(L::PAGE_BYTES));
        address += count;
        bytes -= count;
    }
    0
}

/// The caller preflights the full transfer. Recheck each selected span; zero
/// asks it to revalidate instead of using a stale or incomplete translation.
pub fn span(
    memory: &impl Memory,
    root: u32,
    maximum: u32,
    address: u64,
    bytes: u64,
    rights: u32,
) -> u64 {
    let limit = length(memory, root, maximum);
    if limit < 0
        || address > limit as u64
        || bytes > limit as u64 - address
        || bytes == 0
        || rights == 0
        || rights > 3
    {
        return 0;
    }
    let first = match entry(memory, root, address, rights) {
        Ok(first) => first,
        Err(_) => return 0,
    };
    let mut count = bytes.min(u64::from(L::PAGE_BYTES) - address % u64::from(L::PAGE_BYTES));
    while count < bytes {
        let next = match entry(memory, root, address + count, rights) {
            Ok(next) => next,
            Err(_) => return 0,
        };
        if u64::from(next) != u64::from(first) + count {
            break;
        }
        count += (bytes - count).min(u64::from(L::PAGE_BYTES));
    }
    if count > u64::from(u32::MAX) {
        return 0;
    }
    (count << 32) | u64::from(first)
}

fn validate_queue(memory: &impl Memory) -> i32 {
    let mut previous = 0;
    let mut count = 0;
    let mut at = memory.load(L::WAIT_HEADER + 4);
    let capacity = (L::PAGE_BYTES - L::WAIT_NODES) / L::WAIT_NODE_BYTES;
    while at != 0 {
        if at < L::WAIT_NODES
            || at >= L::PAGE_BYTES
            || (at - L::WAIT_NODES) % L::WAIT_NODE_BYTES != 0
            || count >= capacity
            || memory.load(at) != L::WAIT_WAITING
        {
            return METADATA;
        }
        count += 1;
        previous = at;
        at = memory.load(at + 4);
    }
    let allocated = memory.load(L::WAIT_HEADER + 16);
    if memory.load(L::WAIT_HEADER + 8) != previous || allocated > capacity || allocated < count {
        METADATA
    } else {
        0
    }
}

pub fn unlock(memory: &mut impl Memory) {
    memory.store(L::WAIT_HEADER, 0);
    memory.wake(L::WAIT_HEADER, 1);
}

/// Validate the entire FIFO before publishing any bytes or selecting a waiter.
/// The callback reports failure as data, so Rust releases its own queue lock;
/// a JavaScript exception must not unwind through a Rust extern boundary.
pub fn notify(
    memory: &mut impl Memory,
    address: u32,
    count: u32,
    nonblocking: bool,
    publish: impl FnOnce() -> bool,
) -> i64 {
    if memory.bytes() < u64::from(L::PAGE_BYTES)
        || address % 4 != 0
        || u64::from(address) + 4 > memory.bytes()
    {
        return i64::from(BOUNDS);
    }
    loop {
        if memory.compare_exchange(L::WAIT_HEADER, 0, 1) == 0 {
            break;
        }
        if nonblocking {
            return i64::from(BUSY);
        }
        memory.wait_value(L::WAIT_HEADER, 1);
    }
    let valid = validate_queue(memory);
    if valid != 0 {
        unlock(memory);
        return i64::from(valid);
    }
    if !publish() {
        unlock(memory);
        return i64::from(PUBLICATION_FAILED);
    }
    let mut previous = 0;
    let mut woken = 0;
    let mut at = memory.load(L::WAIT_HEADER + 4);
    while at != 0 {
        let next = memory.load(at + 4);
        if woken < count && memory.load(at + 8) == address {
            memory.store(
                if previous != 0 {
                    previous + 4
                } else {
                    L::WAIT_HEADER + 4
                },
                next,
            );
            if memory.load(L::WAIT_HEADER + 8) == at {
                memory.store(L::WAIT_HEADER + 8, previous);
            }
            memory.store(at, L::WAIT_NOTIFIED);
            memory.wake(at, 1);
            woken += 1;
        } else {
            previous = at;
        }
        at = next;
    }
    unlock(memory);
    // Engine listeners observe the payload word but do not count as guest FIFO
    // waiters. Returning guest helpers retain ownership of node recycling.
    memory.wake(address, count);
    i64::from(woken)
}

#[cfg(test)]
mod tests {
    extern crate alloc;
    use self::alloc::{vec, vec::Vec};
    use super::*;

    struct Bytes {
        words: Vec<u32>,
        wakes: Vec<(u32, u32)>,
        wait_actions: Vec<(u32, u32, Vec<(u32, u32)>)>,
    }
    impl Bytes {
        fn new(pages: u32) -> Self {
            Self {
                words: vec![0; pages as usize * L::PAGE_BYTES as usize / 4],
                wakes: Vec::new(),
                wait_actions: Vec::new(),
            }
        }
        fn node(&mut self, at: u32, next: u32, address: u32) {
            self.store(at, L::WAIT_WAITING);
            self.store(at + 4, next);
            self.store(at + 8, address);
        }
    }
    impl Memory for Bytes {
        fn bytes(&self) -> u64 {
            self.words.len() as u64 * 4
        }
        fn load(&self, at: u32) -> u32 {
            self.words[at as usize / 4]
        }
        fn store(&mut self, at: u32, value: u32) {
            self.words[at as usize / 4] = value;
        }
        fn compare_exchange(&mut self, at: u32, expected: u32, value: u32) -> u32 {
            let old = self.load(at);
            if old == expected {
                self.store(at, value);
            }
            old
        }
        fn wait_value(&mut self, address: u32, expected: u32) {
            assert!(
                !self.wait_actions.is_empty(),
                "unit fixture must not park without a native completion"
            );
            let (wanted, value, changes) = self.wait_actions.remove(0);
            assert_eq!((address, expected), (wanted, value));
            assert_eq!(self.load(address), expected);
            for (at, value) in changes {
                self.store(at, value);
            }
        }
        fn wake(&mut self, at: u32, count: u32) {
            self.wakes.push((at, count));
        }
    }

    #[test]
    fn fork_replay_wait_obeys_commit_cancel_stop_and_exact_control_bounds() {
        let mut memory = Bytes::new(3);
        let replica = L::PAGE_BYTES;
        assert_eq!(wait_fork_replay(&mut memory, replica), METADATA);
        memory.store(replica + L::REPLICA_MAGIC_OFFSET, L::REPLICA_MAGIC);
        memory.store(replica + L::REPLICA_RUN, 1);
        memory.store(replica + L::REPLICA_FORK_REPLAY, L::REPLAY_COMMITTED);
        assert_eq!(wait_fork_replay(&mut memory, replica), 0);
        memory.store(replica + L::REPLICA_FORK_REPLAY, L::REPLAY_CANCELLED);
        assert_eq!(wait_fork_replay(&mut memory, replica), PROTECTION);
        memory.store(replica + L::REPLICA_FORK_REPLAY, 9);
        assert_eq!(wait_fork_replay(&mut memory, replica), METADATA);
        memory.store(replica + L::REPLICA_RUN, 0);
        memory.store(replica + L::REPLICA_FORK_REPLAY, L::REPLAY_COMMITTED);
        assert_eq!(wait_fork_replay(&mut memory, replica), PROTECTION);
        assert_eq!(wait_fork_replay(&mut memory, replica + 4), METADATA);
        assert_eq!(wait_fork_replay(&mut memory, u32::MAX), METADATA);
    }
    #[test]
    fn fork_replay_wait_acknowledges_pause_then_resumes_without_a_lost_gate_wake() {
        let mut memory = Bytes::new(3);
        let replica = L::PAGE_BYTES;
        memory.store(replica + L::REPLICA_MAGIC_OFFSET, L::REPLICA_MAGIC);
        memory.store(replica + L::REPLICA_RUN, 1);
        memory.store(replica + L::REPLICA_FORK_REPLAY, L::REPLAY_PAUSED);
        memory.store(replica + L::REPLICA_REQUEST, 7);
        memory.wait_actions.push((
            replica + L::REPLICA_REQUEST,
            7,
            vec![
                (replica + L::REPLICA_REQUEST, 0),
                (replica + L::REPLICA_FORK_REPLAY, L::REPLAY_PENDING),
            ],
        ));
        memory.wait_actions.push((
            replica + L::REPLICA_FORK_REPLAY,
            L::REPLAY_PENDING,
            vec![(replica + L::REPLICA_FORK_REPLAY, L::REPLAY_COMMITTED)],
        ));
        assert_eq!(wait_fork_replay(&mut memory, replica), 0);
        assert_eq!(memory.load(replica + L::REPLICA_ACK), 7);
        assert_eq!(memory.wakes, vec![(replica + L::REPLICA_ACK, u32::MAX)]);
        assert!(memory.wait_actions.is_empty());
    }
    #[test]
    fn translation_keeps_the_unsigned_memory32_boundary_and_full_span_rights() {
        let mut memory = Bytes::new(8);
        let root = L::PAGE_BYTES;
        memory.store(root, 65536);
        let last = 0x1_0000_0000u64;
        for (page, physical) in [(65534, 6 * L::PAGE_BYTES), (65535, 7 * L::PAGE_BYTES)] {
            memory.store(root + L::ROOT_HEADER_BYTES + page * 4, physical | 3);
        }
        assert_eq!(
            check(
                &memory,
                root,
                65536,
                last - 2 * u64::from(L::PAGE_BYTES),
                2 * u64::from(L::PAGE_BYTES),
                3
            ),
            0
        );
        assert_eq!(
            span(
                &memory,
                root,
                65536,
                last - 2 * u64::from(L::PAGE_BYTES),
                2 * u64::from(L::PAGE_BYTES),
                3
            ),
            (u64::from(2 * L::PAGE_BYTES) << 32) | u64::from(6 * L::PAGE_BYTES)
        );
        assert_eq!(check(&memory, root, 65536, last, 0, 1), 0);
        assert_eq!(check(&memory, root, 65536, last, 1, 1), BOUNDS);
        assert_eq!(check(&memory, root, 65536, u64::MAX, 1, 1), BOUNDS);
        memory.store(
            root + L::ROOT_HEADER_BYTES + 65535 * 4,
            7 * L::PAGE_BYTES | 1,
        );
        assert_eq!(
            check(
                &memory,
                root,
                65536,
                last - 2 * u64::from(L::PAGE_BYTES),
                2 * u64::from(L::PAGE_BYTES),
                2
            ),
            PROTECTION
        );
    }

    #[test]
    fn corrupt_later_fifo_node_prevents_earlier_wake_and_publication() {
        let mut memory = Bytes::new(1);
        let first = L::WAIT_NODES;
        memory.node(first, first + 1, 128);
        memory.store(L::WAIT_HEADER + 4, first);
        memory.store(L::WAIT_HEADER + 8, first);
        memory.store(L::WAIT_HEADER + 16, 1);
        assert_eq!(
            notify(&mut memory, 128, 1, true, || panic!(
                "must preflight the full queue"
            )),
            i64::from(METADATA)
        );
        assert_eq!(memory.load(first), L::WAIT_WAITING);
        assert_eq!(memory.load(L::WAIT_HEADER), 0);
        assert_eq!(memory.wakes, [(L::WAIT_HEADER, 1)]);
    }

    #[test]
    fn fifo_selection_and_failed_callback_retain_exact_lock_ownership() {
        let mut memory = Bytes::new(1);
        let first = L::WAIT_NODES;
        let second = first + L::WAIT_NODE_BYTES;
        let third = second + L::WAIT_NODE_BYTES;
        memory.node(first, second, 128);
        memory.node(second, third, 132);
        memory.node(third, 0, 128);
        memory.store(L::WAIT_HEADER + 4, first);
        memory.store(L::WAIT_HEADER + 8, third);
        memory.store(L::WAIT_HEADER + 16, 3);
        memory.store(L::WAIT_HEADER, 1);
        assert_eq!(
            notify(&mut memory, 128, 1, true, || panic!("peer owns the lock")),
            i64::from(BUSY)
        );
        assert_eq!(memory.load(L::WAIT_HEADER), 1);
        assert!(memory.wakes.is_empty());
        memory.store(L::WAIT_HEADER, 0);
        assert_eq!(
            notify(&mut memory, 128, 1, true, || false),
            i64::from(PUBLICATION_FAILED)
        );
        assert_eq!(memory.load(L::WAIT_HEADER), 0);
        assert_eq!(memory.load(first), L::WAIT_WAITING);
        assert_eq!(notify(&mut memory, 128, 1, true, || true), 1);
        assert_eq!(memory.load(first), L::WAIT_NOTIFIED);
        assert_eq!(memory.load(second), L::WAIT_WAITING);
        assert_eq!(memory.load(third), L::WAIT_WAITING);
        assert_eq!(memory.load(L::WAIT_HEADER + 4), second);
        assert_eq!(memory.load(L::WAIT_HEADER + 8), third);
        assert!(memory.wakes.contains(&(first, 1)));
        assert!(!memory.wakes.contains(&(third, 1)));
    }
}
