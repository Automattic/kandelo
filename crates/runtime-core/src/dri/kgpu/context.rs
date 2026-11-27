//! GPU contexts: kernel objects a process creates and the executor renders
//! for.
//!
//! Ownership: the GPU device (`super`) owns this table. A context belongs to
//! the process that created it (Ruling R9: the guest interface is a program
//! extension, so there is no file description to own it); only that process
//! may use or destroy it, and its exit or exec destroys it. The table keeps
//! the per-context retirement point waiters are decided against, so the
//! decision never depends on executor state.

extern crate alloc;

use alloc::collections::BTreeMap;
use alloc::vec::Vec;

use wasm_posix_shared::Errno;

/// The most contexts the device holds at once. Each context is kernel
/// memory a guest can ask for, so the count is bounded.
pub const MAX_CONTEXTS: usize = 256;

pub struct Context {
    /// The pid that created the context.
    pub owner: u32,
    /// Every submission of this context at or below this sequence number
    /// has retired.
    pub last_retired: u64,
    /// The context is lost: nothing new runs on it, and waits past
    /// `last_retired` answer `EIO`.
    pub lost: bool,
    /// The executor reported the loss itself (Ruling R16). It promises never
    /// to touch the context's memory again, so the loss released every
    /// in-flight pin and later completions for the context are ignored.
    pub released: bool,
    /// The executor that knew the context is gone (`KgpuDevice::reset`). A
    /// replacement executor never saw it, so destroying it sends nothing.
    pub detached: bool,
}

pub struct Contexts {
    map: BTreeMap<u32, Context>,
    /// Ids are never reused, so a stale id names nothing rather than a
    /// later context.
    next: u32,
}

impl Contexts {
    pub const fn new() -> Self {
        Self {
            map: BTreeMap::new(),
            next: 1,
        }
    }

    pub fn create(&mut self, owner: u32) -> Result<u32, Errno> {
        if self.map.len() >= MAX_CONTEXTS {
            return Err(Errno::ENOSPC);
        }
        let id = self.next;
        self.next = id.checked_add(1).ok_or(Errno::ENOSPC)?;
        self.map.insert(
            id,
            Context {
                owner,
                last_retired: 0,
                lost: false,
                released: false,
                detached: false,
            },
        );
        Ok(id)
    }

    pub fn get(&self, id: u32) -> Option<&Context> {
        self.map.get(&id)
    }

    pub fn get_mut(&mut self, id: u32) -> Option<&mut Context> {
        self.map.get_mut(&id)
    }

    /// The context `id` as process `pid` may use it: `ENOENT` if there is
    /// none, `EPERM` if another process owns it.
    pub fn owned(&self, id: u32, pid: u32) -> Result<&Context, Errno> {
        let context = self.map.get(&id).ok_or(Errno::ENOENT)?;
        if context.owner != pid {
            return Err(Errno::EPERM);
        }
        Ok(context)
    }

    pub fn remove(&mut self, id: u32) {
        self.map.remove(&id);
    }

    pub fn ids(&self) -> Vec<u32> {
        self.map.keys().copied().collect()
    }

    pub fn owned_by(&self, pid: u32) -> Vec<u32> {
        self.map
            .iter()
            .filter(|(_, context)| context.owner == pid)
            .map(|(id, _)| *id)
            .collect()
    }
}
