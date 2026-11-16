//! Kernel-owned admission and exact execution receipts for opt-in memory groups.
//!
//! This ledger is independent of POSIX process groups. It does not stop a
//! Worker or establish quiescence: the owning host must supply that proof via
//! the lifecycle protocol before completing retirement. Ordinary processes
//! never enter this ledger. Public host/SDK integration is a later stage.

use crate::io_buffer::IO_MEMORY;
use crate::prepared_map::{MapMemory, PreparedMap, PreparedMapSlot};
use core::sync::atomic::{AtomicU32, Ordering};
use wasm_posix_shared::Errno;

static LAST_GROUP_ID: AtomicU32 = AtomicU32::new(0);

/// Minted by the kernel, not a POSIX pgid or a guest-supplied authority.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MemoryGroupId(u32);

impl MemoryGroupId {
    pub fn as_raw(self) -> u32 {
        self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MemoryGroupLimits {
    pub maximum_pages: u32,
    pub maximum_processes: u32,
    /// Includes the main execution of each process and pending admissions.
    pub maximum_tasks: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MemoryGroupSnapshot {
    pub id: MemoryGroupId,
    pub limits: MemoryGroupLimits,
    pub accepting: bool,
    pub processes: u32,
    pub tasks: u32,
    pub quarantined_tasks: u32,
    /// Object/snapshot owners that can outlive every execution in the group.
    pub backings: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GroupExecution {
    pub pid: u32,
    pub tid: u32,
    pub exec_generation: u64,
}

/// Exact admission receipt. Callers cannot construct one from a guessed pid.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GroupAdmission {
    group: MemoryGroupId,
    serial: u64,
    execution: GroupExecution,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GroupBackingLease {
    group: MemoryGroupId,
    serial: u64,
}

impl MapMemory for GroupBackingLease {
    fn heap_bytes(&self) -> Result<usize, Errno> {
        Ok(0)
    }
}

impl GroupAdmission {
    pub fn group(self) -> MemoryGroupId {
        self.group
    }
    pub fn execution(self) -> GroupExecution {
        self.execution
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Prepared,
    Running,
    Stopping,
    Quarantined,
}

struct Task {
    receipt: GroupAdmission,
    phase: Phase,
}

struct Group {
    snapshot: MemoryGroupSnapshot,
}

impl MapMemory for Task {
    fn heap_bytes(&self) -> Result<usize, Errno> {
        Ok(0)
    }
}
impl MapMemory for Group {
    fn heap_bytes(&self) -> Result<usize, Errno> {
        Ok(0)
    }
}

/// Owned by ProcessTable. All operations run under serialized kernel entry.
/// Metadata consumes the existing fallible I/O budget; no new memory ceiling.
pub struct MemoryGroups {
    groups: PreparedMap<u32, Group>,
    tasks: PreparedMap<u64, Task>,
    backings: PreparedMap<u64, GroupBackingLease>,
    next_admission: u64,
    maximum_reserved_pages: u32,
    maximum_groups: u32,
    reserved_pages: u32,
    configured: bool,
}

impl MemoryGroups {
    pub(crate) const fn new() -> Self {
        Self {
            groups: PreparedMap::new(),
            tasks: PreparedMap::new(),
            backings: PreparedMap::new(),
            next_admission: 1,
            maximum_reserved_pages: 0,
            maximum_groups: 0,
            reserved_pages: 0,
            configured: false,
        }
    }

    /// Configure once from the admitted host profile, before any group exists.
    /// The host must reserve backing capacity too; this is kernel accounting.
    pub fn configure(
        &mut self,
        maximum_reserved_pages: u32,
        maximum_groups: u32,
    ) -> Result<(), Errno> {
        if self.configured {
            return Err(Errno::EBUSY);
        }
        if maximum_reserved_pages == 0 || maximum_groups == 0 {
            return Err(Errno::EINVAL);
        }
        self.maximum_reserved_pages = maximum_reserved_pages;
        self.maximum_groups = maximum_groups;
        self.configured = true;
        Ok(())
    }

    pub fn create(&mut self, limits: MemoryGroupLimits) -> Result<MemoryGroupId, Errno> {
        if !self.configured {
            return Err(Errno::ENOTSUP);
        }
        if limits.maximum_pages == 0
            || limits.maximum_pages > 65536
            || limits.maximum_processes == 0
            || limits.maximum_tasks < limits.maximum_processes
        {
            return Err(Errno::EINVAL);
        }
        let reserved = self
            .reserved_pages
            .checked_add(limits.maximum_pages)
            .ok_or(Errno::ENOMEM)?;
        if reserved > self.maximum_reserved_pages
            || self.groups.len() >= self.maximum_groups as usize
        {
            return Err(Errno::ENOMEM);
        }
        let slot = PreparedMapSlot::new_in(&IO_MEMORY, 0)?;
        let raw = LAST_GROUP_ID
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |last| {
                last.checked_add(1).filter(|id| *id <= i32::MAX as u32)
            })
            .map_err(|_| Errno::EOVERFLOW)?
            + 1;
        let id = MemoryGroupId(raw);
        let snapshot = MemoryGroupSnapshot {
            id,
            limits,
            accepting: true,
            processes: 0,
            tasks: 0,
            quarantined_tasks: 0,
            backings: 0,
        };
        let entry = slot.finish(raw, Group { snapshot })?;
        self.groups.publish_io(entry);
        self.reserved_pages = reserved;
        Ok(id)
    }

    pub fn snapshot(&self, group: MemoryGroupId) -> Result<MemoryGroupSnapshot, Errno> {
        self.groups
            .get(&group.0)
            .map(|g| g.snapshot)
            .ok_or(Errno::ENOENT)
    }

    pub fn reserved_pages(&self) -> u32 {
        self.reserved_pages
    }

    /// Explicitly refuse new process/thread admissions without killing members.
    pub fn seal(&mut self, group: MemoryGroupId) -> Result<(), Errno> {
        self.groups
            .get_mut(&group.0)
            .ok_or(Errno::ENOENT)?
            .snapshot
            .accepting = false;
        Ok(())
    }

    /// An empty, sealed ledger is necessary but not sufficient to free physical
    /// memory. Object/backing owners in the integration layer must also retire.
    pub fn remove_empty(&mut self, group: MemoryGroupId) -> Result<(), Errno> {
        let snapshot = self.snapshot(group)?;
        if snapshot.accepting || snapshot.tasks != 0 || snapshot.backings != 0 {
            return Err(Errno::EBUSY);
        }
        self.groups.remove(&group.0).ok_or(Errno::ENOENT)?;
        self.reserved_pages -= snapshot.limits.maximum_pages;
        Ok(())
    }

    /// Admit an explicit object/snapshot owner before it can escape. This
    /// receipt owns group capacity, not a second copy of the object's bytes.
    pub fn retain_backing(&mut self, group: MemoryGroupId) -> Result<GroupBackingLease, Errno> {
        let snapshot = self.snapshot(group)?;
        if !snapshot.accepting {
            return Err(Errno::EBUSY);
        }
        let count = snapshot.backings.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        let serial = self.next_admission;
        let next = serial.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        let lease = GroupBackingLease { group, serial };
        let slot = PreparedMapSlot::new_in(&IO_MEMORY, 0)?;
        let entry = slot.finish(serial, lease)?;
        self.backings.publish_io(entry);
        self.next_admission = next;
        self.groups
            .get_mut(&group.0)
            .expect("validated group vanished")
            .snapshot
            .backings = count;
        Ok(lease)
    }

    /// The object/snapshot owner calls this after its actual final reference.
    pub fn release_backing(&mut self, lease: GroupBackingLease) -> Result<(), Errno> {
        if self.backings.get(&lease.serial) != Some(&lease) {
            return Err(Errno::ENOENT);
        }
        self.backings.remove(&lease.serial);
        self.groups
            .get_mut(&lease.group.0)
            .expect("owned group vanished")
            .snapshot
            .backings -= 1;
        Ok(())
    }

    /// ProcessTable validates that this exact main task/image exists first.
    pub(crate) fn prepare_process(
        &mut self,
        group: MemoryGroupId,
        pid: u32,
        exec_generation: u64,
    ) -> Result<GroupAdmission, Errno> {
        self.prepare(
            group,
            GroupExecution {
                pid,
                tid: pid,
                exec_generation,
            },
            true,
        )
    }

    pub(crate) fn prepare_thread(
        &mut self,
        parent: GroupAdmission,
        tid: u32,
    ) -> Result<GroupAdmission, Errno> {
        let owner = self.task(parent)?;
        // Any live pthread can create another, even after the main pthread
        // has exited. A main-Worker token is not the process root's lifetime.
        if owner.phase != Phase::Running {
            return Err(Errno::EINVAL);
        }
        if tid == parent.execution.pid {
            return Err(Errno::EINVAL);
        }
        self.prepare(
            parent.group,
            GroupExecution {
                tid,
                ..parent.execution
            },
            false,
        )
    }

    fn prepare(
        &mut self,
        group: MemoryGroupId,
        execution: GroupExecution,
        main: bool,
    ) -> Result<GroupAdmission, Errno> {
        if execution.pid == 0 || execution.tid == 0 {
            return Err(Errno::ESRCH);
        }
        let snapshot = self.snapshot(group)?;
        if !snapshot.accepting {
            return Err(Errno::EBUSY);
        }
        let new_process = !self.tasks.iter().any(|(_, task)| {
            task.receipt.group == group && task.receipt.execution.pid == execution.pid
        });
        if snapshot.tasks >= snapshot.limits.maximum_tasks
            || new_process && snapshot.processes >= snapshot.limits.maximum_processes
        {
            return Err(Errno::EAGAIN);
        }
        // A live task cannot inhabit two groups. Retiring exec predecessors
        // may overlap a new image, but never the same exact generation.
        if self
            .tasks
            .iter()
            .any(|(_, task)| task.receipt.execution == execution)
        {
            return Err(Errno::EBUSY);
        }
        if main
            && self.tasks.iter().any(|(_, task)| {
                task.receipt.execution.pid == execution.pid
                    && task.receipt.execution.exec_generation == execution.exec_generation
            })
        {
            return Err(Errno::EBUSY);
        }
        let serial = self.next_admission;
        let next = serial.checked_add(1).ok_or(Errno::EOVERFLOW)?;
        let receipt = GroupAdmission {
            group,
            serial,
            execution,
        };
        let slot = PreparedMapSlot::new_in(&IO_MEMORY, 0)?;
        let entry = slot.finish(
            serial,
            Task {
                receipt,
                phase: Phase::Prepared,
            },
        )?;
        self.tasks.publish_io(entry);
        self.next_admission = next;
        let group = self
            .groups
            .get_mut(&group.0)
            .expect("validated group vanished");
        group.snapshot.tasks += 1;
        if new_process {
            group.snapshot.processes += 1;
        }
        Ok(receipt)
    }

    fn task(&self, receipt: GroupAdmission) -> Result<&Task, Errno> {
        self.tasks
            .get(&receipt.serial)
            .filter(|t| t.receipt == receipt)
            .ok_or(Errno::ESRCH)
    }

    pub fn start(&mut self, receipt: GroupAdmission) -> Result<(), Errno> {
        if self.task(receipt)?.phase != Phase::Prepared {
            return Err(Errno::EINVAL);
        }
        self.tasks.get_mut(&receipt.serial).unwrap().phase = Phase::Running;
        Ok(())
    }

    /// Only the owner proving a Worker was never constructed may use rollback.
    pub fn cancel_unconstructed(&mut self, receipt: GroupAdmission) -> Result<(), Errno> {
        if self.task(receipt)?.phase != Phase::Prepared {
            return Err(Errno::EBUSY);
        }
        self.release(receipt)
    }

    pub fn begin_retirement(&mut self, receipt: GroupAdmission) -> Result<(), Errno> {
        match self.task(receipt)?.phase {
            Phase::Prepared | Phase::Running => {
                self.tasks.get_mut(&receipt.serial).unwrap().phase = Phase::Stopping
            }
            Phase::Stopping => {}
            Phase::Quarantined => return Err(Errno::EBUSY),
        }
        Ok(())
    }

    /// Failed proof retains capacity. It never becomes a successful exit ACK.
    pub fn quarantine(&mut self, receipt: GroupAdmission) -> Result<(), Errno> {
        let phase = self.task(receipt)?.phase;
        if phase == Phase::Quarantined {
            return Ok(());
        }
        if phase != Phase::Stopping {
            return Err(Errno::EINVAL);
        }
        self.tasks.get_mut(&receipt.serial).unwrap().phase = Phase::Quarantined;
        self.groups
            .get_mut(&receipt.group.0)
            .unwrap()
            .snapshot
            .quarantined_tasks += 1;
        Ok(())
    }

    /// Call only after the exact Worker receipt establishes execution stop.
    pub fn retire_quiescent(&mut self, receipt: GroupAdmission) -> Result<(), Errno> {
        match self.task(receipt)?.phase {
            Phase::Stopping | Phase::Quarantined => self.release(receipt),
            _ => Err(Errno::EBUSY),
        }
    }

    fn release(&mut self, receipt: GroupAdmission) -> Result<(), Errno> {
        self.task(receipt)?;
        let task = self
            .tasks
            .remove(&receipt.serial)
            .expect("validated admission vanished");
        let last_process_task = !self.tasks.iter().any(|(_, task)| {
            task.receipt.group == receipt.group
                && task.receipt.execution.pid == receipt.execution.pid
        });
        let snapshot = &mut self
            .groups
            .get_mut(&receipt.group.0)
            .expect("owned group vanished")
            .snapshot;
        snapshot.tasks -= 1;
        if last_process_task {
            snapshot.processes -= 1;
        }
        if task.phase == Phase::Quarantined {
            snapshot.quarantined_tasks -= 1;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backing_owner_outlives_last_worker_and_blocks_capacity_release() {
        let mut groups = groups();
        let id = groups.create(limits()).unwrap();
        let object = groups.retain_backing(id).unwrap();
        let main = groups.prepare_process(id, 100, 0).unwrap();
        groups.start(main).unwrap();
        groups.seal(id).unwrap();
        groups.begin_retirement(main).unwrap();
        groups.retire_quiescent(main).unwrap();
        assert_eq!(groups.snapshot(id).unwrap().tasks, 0);
        assert_eq!(groups.snapshot(id).unwrap().backings, 1);
        assert_eq!(groups.remove_empty(id), Err(Errno::EBUSY));
        let mut foreign = super::tests::groups();
        assert_eq!(foreign.release_backing(object), Err(Errno::ENOENT));
        groups.release_backing(object).unwrap();
        assert_eq!(groups.release_backing(object), Err(Errno::ENOENT));
        groups.remove_empty(id).unwrap();
        assert_eq!(groups.reserved_pages(), 0);
    }

    #[test]
    fn allocation_failure_never_publishes_partial_admission() {
        let mut groups = groups();
        crate::prepared_map::fail_after_allocations(0);
        assert_eq!(groups.create(limits()), Err(Errno::ENOMEM));
        assert_eq!(groups.reserved_pages(), 0);
        let id = groups.create(limits()).unwrap();
        crate::prepared_map::fail_after_allocations(0);
        assert_eq!(groups.prepare_process(id, 100, 0), Err(Errno::ENOMEM));
        assert_eq!(groups.snapshot(id).unwrap().tasks, 0);
        assert_eq!(groups.snapshot(id).unwrap().processes, 0);
        crate::prepared_map::fail_after_allocations(0);
        assert_eq!(groups.retain_backing(id), Err(Errno::ENOMEM));
        assert_eq!(groups.snapshot(id).unwrap().backings, 0);
        groups.prepare_process(id, 100, 0).unwrap();
    }

    #[test]
    fn process_table_validates_task_and_image_before_membership() {
        let mut table = crate::process_table::ProcessTable::new();
        table.memory_groups().configure(8192, 4).unwrap();
        let id = table.memory_groups().create(limits()).unwrap();
        assert_eq!(
            table.prepare_process_memory_group(id, 999),
            Err(Errno::ESRCH)
        );
        let pid = table.create_process().unwrap();
        let receipt = table.prepare_process_memory_group(id, pid).unwrap();
        table.memory_groups().start(receipt).unwrap();
        assert_eq!(
            table.prepare_thread_memory_group(receipt, pid + 999),
            Err(Errno::ESRCH)
        );
        table.get_mut(pid).unwrap().exec_generation += 1;
        assert_eq!(
            table.prepare_thread_memory_group(receipt, pid),
            Err(Errno::ESRCH)
        );
        assert_eq!(table.memory_groups().snapshot(id).unwrap().tasks, 1);
    }
    fn groups() -> MemoryGroups {
        let mut groups = MemoryGroups::new();
        groups.configure(8192, 4).unwrap();
        groups
    }
    fn limits() -> MemoryGroupLimits {
        MemoryGroupLimits {
            maximum_pages: 1024,
            maximum_processes: 2,
            maximum_tasks: 4,
        }
    }

    #[test]
    fn explicit_enable_and_machine_capacity() {
        let mut groups = MemoryGroups::new();
        assert_eq!(groups.create(limits()), Err(Errno::ENOTSUP));
        groups.configure(1024, 1).unwrap();
        assert_eq!(groups.configure(8192, 4), Err(Errno::EBUSY));
        let id = groups.create(limits()).unwrap();
        assert_eq!(groups.create(limits()), Err(Errno::ENOMEM));
        assert_eq!(groups.reserved_pages(), 1024);
        assert_eq!(groups.remove_empty(id), Err(Errno::EBUSY));
        groups.seal(id).unwrap();
        groups.remove_empty(id).unwrap();
        assert_eq!(groups.reserved_pages(), 0);
        let next = groups.create(limits()).unwrap();
        assert_ne!(id, next);
    }

    #[test]
    fn separate_groups_and_foreign_authority() {
        let mut groups = groups();
        let first = groups.create(limits()).unwrap();
        let second = groups.create(limits()).unwrap();
        assert_ne!(first, second);
        let main = groups.prepare_process(first, 100, 0).unwrap();
        assert_eq!(groups.prepare_process(second, 100, 0), Err(Errno::EBUSY));
        assert_eq!(groups.snapshot(second).unwrap().tasks, 0);
        let mut foreign = super::tests::groups();
        assert_eq!(foreign.snapshot(first), Err(Errno::ENOENT));
        let other = foreign.create(limits()).unwrap();
        assert_ne!(first, other);
        assert_eq!(foreign.start(main), Err(Errno::ESRCH));
    }

    #[test]
    fn pending_admissions_consume_limits_and_rollback_once() {
        let mut groups = groups();
        let id = groups.create(limits()).unwrap();
        let first = groups.prepare_process(id, 100, 0).unwrap();
        let second = groups.prepare_process(id, 101, 0).unwrap();
        assert_eq!(groups.prepare_process(id, 102, 0), Err(Errno::EAGAIN));
        groups.cancel_unconstructed(first).unwrap();
        assert_eq!(groups.cancel_unconstructed(first), Err(Errno::ESRCH));
        assert_eq!(groups.snapshot(id).unwrap().processes, 1);
        groups.start(second).unwrap();
        assert_eq!(groups.cancel_unconstructed(second), Err(Errno::EBUSY));
        groups.prepare_process(id, 102, 0).unwrap();
    }

    #[test]
    fn threads_follow_exact_parent_and_share_task_budget() {
        let mut groups = groups();
        let id = groups.create(limits()).unwrap();
        let main = groups.prepare_process(id, 100, 0).unwrap();
        assert_eq!(groups.prepare_thread(main, 101), Err(Errno::EINVAL));
        groups.start(main).unwrap();
        let thread = groups.prepare_thread(main, 101).unwrap();
        assert_eq!(thread.group(), id);
        assert_eq!(thread.execution().exec_generation, 0);
        assert_eq!(groups.prepare_thread(main, 101), Err(Errno::EBUSY));
        assert_eq!(groups.prepare_thread(main, 100), Err(Errno::EINVAL));
        groups.prepare_thread(main, 102).unwrap();
        groups.prepare_thread(main, 103).unwrap();
        assert_eq!(groups.prepare_thread(main, 104), Err(Errno::EAGAIN));
        assert_eq!(groups.snapshot(id).unwrap().processes, 1);
    }

    #[test]
    fn exact_exec_retirement_does_not_touch_successor() {
        let mut groups = groups();
        let id = groups
            .create(MemoryGroupLimits {
                maximum_processes: 1,
                ..limits()
            })
            .unwrap();
        let old = groups.prepare_process(id, 100, 0).unwrap();
        groups.start(old).unwrap();
        groups.begin_retirement(old).unwrap();
        let new = groups.prepare_process(id, 100, 1).unwrap();
        groups.start(new).unwrap();
        groups.retire_quiescent(old).unwrap();
        assert_eq!(groups.retire_quiescent(old), Err(Errno::ESRCH));
        assert_eq!(groups.snapshot(id).unwrap().tasks, 1);
        assert_eq!(groups.snapshot(id).unwrap().processes, 1);
        assert_eq!(groups.retire_quiescent(new), Err(Errno::EBUSY));
        groups.begin_retirement(new).unwrap();
        groups.retire_quiescent(new).unwrap();
        assert_eq!(groups.snapshot(id).unwrap().tasks, 0);
    }

    #[test]
    fn quarantine_and_live_sibling_prevent_release() {
        let mut groups = groups();
        let id = groups.create(limits()).unwrap();
        let main = groups.prepare_process(id, 100, 0).unwrap();
        groups.start(main).unwrap();
        let thread = groups.prepare_thread(main, 101).unwrap();
        groups.start(thread).unwrap();
        groups.seal(id).unwrap();
        assert_eq!(groups.prepare_thread(main, 102), Err(Errno::EBUSY));
        groups.begin_retirement(main).unwrap();
        groups.quarantine(main).unwrap();
        groups.quarantine(main).unwrap();
        assert_eq!(groups.snapshot(id).unwrap().quarantined_tasks, 1);
        assert_eq!(groups.remove_empty(id), Err(Errno::EBUSY));
        groups.retire_quiescent(main).unwrap();
        assert_eq!(groups.snapshot(id).unwrap().tasks, 1);
        assert_eq!(groups.snapshot(id).unwrap().processes, 1);
        assert_eq!(groups.remove_empty(id), Err(Errno::EBUSY));
        groups.begin_retirement(thread).unwrap();
        groups.retire_quiescent(thread).unwrap();
        groups.remove_empty(id).unwrap();
        assert_eq!(groups.reserved_pages(), 0);
    }

    #[test]
    fn surviving_pthread_can_create_after_main_pthread_exit() {
        let mut groups = groups();
        let id = groups.create(limits()).unwrap();
        let main = groups.prepare_process(id, 100, 0).unwrap();
        groups.start(main).unwrap();
        let thread = groups.prepare_thread(main, 101).unwrap();
        groups.start(thread).unwrap();
        groups.begin_retirement(main).unwrap();
        groups.retire_quiescent(main).unwrap();
        let child = groups.prepare_thread(thread, 102).unwrap();
        groups.start(child).unwrap();
        assert_eq!(groups.snapshot(id).unwrap().processes, 1);
        assert_eq!(groups.snapshot(id).unwrap().tasks, 2);
        assert_eq!(groups.prepare_process(id, 100, 0), Err(Errno::EBUSY));
    }
}
