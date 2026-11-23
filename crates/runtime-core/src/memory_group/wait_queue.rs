//! The kernel inspects and controls the SDK's shared wait queue. Unlinking a
//! node wakes its owner; only that returning waiter may recycle the node.

use super::physical::PhysicalMemory;
use wasm_posix_shared::{program_extensions::memory_group_v3 as L, Errno};

const Q: u32 = L::WAIT_HEADER;
const FIRST: u32 = L::WAIT_NODES;
const STEP: u32 = L::WAIT_NODE_BYTES;
const CAPACITY: u32 = (L::PAGE_BYTES - FIRST) / STEP;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WaitState {
    None,
    Waiting,
    Returning,
}

fn node(address: u32) -> bool {
    (FIRST..L::PAGE_BYTES).contains(&address) && (address - FIRST) % STEP == 0
}
fn load(memory: &(impl PhysicalMemory + ?Sized), address: u32) -> Result<u32, Errno> {
    memory.atomic_load(address)
}

fn validate(memory: &(impl PhysicalMemory + ?Sized)) -> Result<(), Errno> {
    let mut at = load(memory, Q + 4)?;
    let mut previous = 0;
    let mut count = 0;
    while at != 0 {
        if !node(at) || count >= CAPACITY || load(memory, at)? != L::WAIT_WAITING {
            return Err(Errno::EIO);
        }
        count += 1;
        previous = at;
        at = load(memory, at + 4)?;
    }
    let allocated = load(memory, Q + 16)?;
    if load(memory, Q + 8)? != previous || allocated > CAPACITY || allocated < count {
        return Err(Errno::EIO);
    }
    Ok(())
}

fn locked<T, M: PhysicalMemory + ?Sized>(
    memory: &mut M,
    operation: impl FnOnce(&mut M) -> Result<T, Errno>,
) -> Result<T, Errno> {
    if memory.atomic_compare_exchange(Q, 0, 1)? != 0 {
        return Err(Errno::EAGAIN);
    }
    let result = validate(memory).and_then(|()| operation(memory));
    memory.atomic_store(Q, 0)?;
    memory.atomic_notify(Q, 1)?;
    result
}

fn replica(memory: &(impl PhysicalMemory + ?Sized), root: u32, control: u32) -> Result<(), Errno> {
    if root < L::PAGE_BYTES
        || root % L::PAGE_BYTES != 0
        || control < L::PAGE_BYTES
        || control % L::REPLICA_BYTES != 0
        || u64::from(control) + u64::from(L::REPLICA_BYTES)
            > u64::from(memory.current_pages()?) * u64::from(L::PAGE_BYTES)
        || load(memory, control + L::REPLICA_ROOT)? != root
        || load(memory, control + L::REPLICA_MAGIC_OFFSET)? != L::REPLICA_MAGIC
    {
        return Err(Errno::EIO);
    }
    Ok(())
}

/// Validated exact registration, including already-unlinked returning nodes.
fn registration(
    memory: &(impl PhysicalMemory + ?Sized),
    root: u32,
    control: u32,
) -> Result<(u32, u32, u32), Errno> {
    let at = memory.atomic_load(control + L::REPLICA_WAIT_NODE)?;
    let mut linked = 0;
    let mut predecessor = 0;
    let mut previous = 0;
    let mut next = memory.atomic_load(Q + 4)?;
    while next != 0 {
        if memory.atomic_load(next + 16)? == control {
            linked += 1;
            if next != at {
                return Err(Errno::EIO);
            }
            predecessor = previous;
        }
        previous = next;
        next = memory.atomic_load(next + 4)?;
    }
    if at == 0 {
        return if linked == 0 {
            Ok((0, 0, 0))
        } else {
            Err(Errno::EIO)
        };
    }
    if !node(at) || memory.atomic_load(at + 12)? != root || memory.atomic_load(at + 16)? != control
    {
        return Err(Errno::EIO);
    }
    let state = memory.atomic_load(at)?;
    if !(L::WAIT_WAITING..=L::WAIT_STOPPED).contains(&state)
        || memory.atomic_load(Q + 16)? == 0
        || (state == L::WAIT_WAITING && linked != 1)
        || (state != L::WAIT_WAITING && linked != 0)
    {
        return Err(Errno::EIO);
    }
    Ok((at, state, predecessor))
}

pub(crate) fn inspect(
    memory: &mut (impl PhysicalMemory + ?Sized),
    root: u32,
    control: u32,
) -> Result<WaitState, Errno> {
    replica(memory, root, control)?;
    locked(memory, |memory| {
        let (at, state, _) = registration(memory, root, control)?;
        Ok(if at == 0 {
            WaitState::None
        } else if state == L::WAIT_WAITING {
            WaitState::Waiting
        } else {
            WaitState::Returning
        })
    })
}

pub(crate) fn pause(
    memory: &mut (impl PhysicalMemory + ?Sized),
    root: u32,
    control: u32,
    epoch: u32,
) -> Result<(), Errno> {
    replica(memory, root, control)?;
    if epoch == 0 || load(memory, control + L::REPLICA_REQUEST)? != epoch {
        return Err(Errno::ESRCH);
    }
    locked(memory, |memory| {
        let (at, state, _) = registration(memory, root, control)?;
        if state == L::WAIT_STOPPED {
            return Err(Errno::ESRCH);
        }
        if at != 0 {
            // Parked waiters are quiescent for PTE replacement, but their
            // target pages remain pinned through native return and recycling.
            memory.atomic_store(control + L::REPLICA_ACK, epoch)?;
            memory.atomic_notify(control + L::REPLICA_ACK, u32::MAX)?;
        }
        Ok(())
    })
}

pub(crate) fn stop(
    memory: &mut (impl PhysicalMemory + ?Sized),
    root: u32,
    control: u32,
) -> Result<(), Errno> {
    replica(memory, root, control)?;
    memory.atomic_store(control + L::REPLICA_RUN, 0)?;
    memory.atomic_notify(control + L::REPLICA_REQUEST, u32::MAX)?;
    memory.atomic_notify(control + L::REPLICA_ACK, u32::MAX)?;
    locked(memory, |memory| {
        let (at, state, previous) = registration(memory, root, control)?;
        if at == 0 {
            return Ok(());
        }
        if state == L::WAIT_WAITING {
            let next = memory.atomic_load(at + 4)?;
            memory.atomic_store(if previous == 0 { Q + 4 } else { previous + 4 }, next)?;
            if memory.atomic_load(Q + 8)? == at {
                memory.atomic_store(Q + 8, previous)?;
            }
        }
        memory.atomic_store(at, L::WAIT_STOPPED)?;
        memory.atomic_notify(at, 1)?;
        Ok(())
    })
}

/// Enumerate every allocated node, not just the linked queue: notification
/// and stop leave native target pins until the waiting SDK call returns.
pub(crate) fn visit_pins(
    memory: &mut (impl PhysicalMemory + ?Sized),
    mut visit: impl FnMut(u32, u32, u32),
) -> Result<(), Errno> {
    locked(memory, |memory| {
        let mut count = 0;
        for at in (FIRST..L::PAGE_BYTES).step_by(STEP as usize) {
            let state = memory.atomic_load(at)?;
            if state == L::WAIT_FREE {
                continue;
            }
            if !(L::WAIT_WAITING..=L::WAIT_STOPPED).contains(&state) {
                return Err(Errno::EIO);
            }
            count += 1;
            let target = memory.atomic_load(at + 8)?;
            if target % 4 != 0
                || u64::from(target) + 4
                    > u64::from(memory.current_pages()?) * u64::from(L::PAGE_BYTES)
            {
                return Err(Errno::EIO);
            }
            visit(
                memory.atomic_load(at + 12)?,
                memory.atomic_load(at + 16)?,
                target,
            );
        }
        if count != memory.atomic_load(Q + 16)? {
            return Err(Errno::EIO);
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory_group::physical::tests::Memory;
    const ROOT: u32 = L::PAGE_BYTES;
    const CONTROL: u32 = 2 * L::PAGE_BYTES;
    fn queued() -> Memory {
        let mut memory = Memory::new(8);
        memory.grow(3).unwrap();
        for (at, value) in [
            (CONTROL + L::REPLICA_ROOT, ROOT),
            (CONTROL + L::REPLICA_MAGIC_OFFSET, L::REPLICA_MAGIC),
            (CONTROL + L::REPLICA_RUN, 1),
            (CONTROL + L::REPLICA_REQUEST, 7),
            (CONTROL + L::REPLICA_WAIT_NODE, FIRST),
            (Q + 4, FIRST),
            (Q + 8, FIRST),
            (Q + 16, 1),
            (FIRST, L::WAIT_WAITING),
            (FIRST + 8, ROOT + 100),
            (FIRST + 12, ROOT),
            (FIRST + 16, CONTROL),
        ] {
            memory.atomic_store(at, value).unwrap();
        }
        memory
    }
    #[test]
    fn pause_acknowledges_a_parked_replica_without_retiring_its_target() {
        let mut memory = queued();
        pause(&mut memory, ROOT, CONTROL, 7).unwrap();
        assert_eq!(memory.atomic_load(CONTROL + L::REPLICA_ACK).unwrap(), 7);
        assert_eq!(
            inspect(&mut memory, ROOT, CONTROL).unwrap(),
            WaitState::Waiting
        );
        let mut pins = 0;
        visit_pins(&mut memory, |_, _, target| {
            assert_eq!(target, ROOT + 100);
            pins += 1;
        })
        .unwrap();
        assert_eq!(pins, 1);
    }
    #[test]
    fn stopped_unlinked_nodes_remain_pinned_until_the_waiter_recycles_them() {
        let mut memory = queued();
        stop(&mut memory, ROOT, CONTROL).unwrap();
        assert_eq!(memory.atomic_load(Q + 4).unwrap(), 0);
        assert_eq!(
            inspect(&mut memory, ROOT, CONTROL).unwrap(),
            WaitState::Returning
        );
        let mut pins = 0;
        visit_pins(&mut memory, |_, _, _| pins += 1).unwrap();
        assert_eq!(pins, 1);
        assert_eq!(pause(&mut memory, ROOT, CONTROL, 7), Err(Errno::ESRCH));
    }
    #[test]
    fn contention_and_forged_registration_do_not_authorize_progress() {
        let mut memory = queued();
        memory.atomic_store(Q, 1).unwrap();
        assert_eq!(pause(&mut memory, ROOT, CONTROL, 7), Err(Errno::EAGAIN));
        assert_eq!(memory.atomic_load(CONTROL + L::REPLICA_ACK).unwrap(), 0);
        memory.atomic_store(Q, 0).unwrap();
        memory.atomic_store(FIRST + 16, CONTROL + 64).unwrap();
        assert_eq!(inspect(&mut memory, ROOT, CONTROL), Err(Errno::EIO));
        assert_eq!(memory.atomic_load(Q).unwrap(), 0);
    }
}
