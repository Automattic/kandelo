//! Kernel-owned admission and exact execution receipts for opt-in memory groups.
//!
//! This ledger is independent of POSIX process groups. It does not stop a
//! Worker or establish quiescence: the owning host must supply that proof via
//! the lifecycle protocol before completing retirement. Ordinary processes
//! never enter this ledger. Host admission metadata is available independently;
//! ordinary-launch execution integration remains a later stage.

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
    /// Execution images retain group capacity until explicit lifecycle cleanup,
    /// including the interval after their last Worker fence.
    pub images: u32,
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
    pub fn record(self) -> wasm_posix_shared::memory_group::ReceiptRecord {
        wasm_posix_shared::memory_group::ReceiptRecord {
            group: self.group.0,
            pid: self.execution.pid,
            tid: self.execution.tid,
            serial: self.serial,
            generation: self.execution.exec_generation,
        }
    }
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

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct ImageKey {
    pid: u32,
    generation: u64,
}

struct Image {
    group: MemoryGroupId,
    // An uncommitted exec may reuse its proposed generation after rollback.
    // Keep its exact serial even after the prepared task is cancelled.
    exec_serial: Option<u64>,
    // A committed but unexposed replacement still has a host owner. Parent
    // reaping must not erase its cancellation authority before that owner
    // either publishes Start or retires the exact unconstructed image.
    committed_exec_serial: Option<u64>,
}

impl MapMemory for ImageKey {
    fn heap_bytes(&self) -> Result<usize, Errno> {
        Ok(0)
    }
}
impl MapMemory for Image {
    fn heap_bytes(&self) -> Result<usize, Errno> {
        Ok(0)
    }
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
    images: PreparedMap<ImageKey, Image>,
    next_admission: u64,
    maximum_reserved_pages: u32,
    maximum_groups: u32,
    reserved_pages: u32,
    configured: bool,
}

impl MemoryGroups {
    /// Raw host metadata resolves only to an already owned kernel identity.
    pub fn resolve_group(&self, raw: u32) -> Result<MemoryGroupId, Errno> {
        self.groups
            .get(&raw)
            .map(|group| group.snapshot.id)
            .ok_or(Errno::ENOENT)
    }

    pub fn resolve_receipt(
        &self,
        record: wasm_posix_shared::memory_group::ReceiptRecord,
    ) -> Result<GroupAdmission, Errno> {
        let task = self.tasks.get(&record.serial).ok_or(Errno::ESRCH)?;
        if task.receipt.record() != record {
            return Err(Errno::ESRCH);
        }
        Ok(task.receipt)
    }

    pub fn apply_task_action(
        &mut self,
        receipt: GroupAdmission,
        action: wasm_posix_shared::memory_group::TaskAction,
    ) -> Result<(), Errno> {
        use wasm_posix_shared::memory_group::TaskAction;
        match action {
            TaskAction::Start => self.start(receipt),
            TaskAction::BeginRetirement => self.begin_retirement(receipt),
            TaskAction::RetireQuiescent => self.retire_quiescent(receipt),
            TaskAction::Quarantine => self.quarantine(receipt),
            TaskAction::CancelUnconstructed => self.cancel_unconstructed(receipt),
        }
    }
    pub(crate) const fn new() -> Self {
        Self {
            groups: PreparedMap::new(),
            tasks: PreparedMap::new(),
            backings: PreparedMap::new(),
            images: PreparedMap::new(),
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
            images: 0,
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
        if snapshot.accepting
            || snapshot.tasks != 0
            || snapshot.backings != 0
            || snapshot.images != 0
        {
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

    /// Atomically reserve both an execution image and its initial Worker.
    /// ProcessTable validates the exact live task before invoking this.
    pub(crate) fn prepare_image(
        &mut self,
        group: MemoryGroupId,
        pid: u32,
        generation: u64,
    ) -> Result<GroupAdmission, Errno> {
        let key = ImageKey { pid, generation };
        if self.images.contains_key(&key) {
            return Err(Errno::EBUSY);
        }
        let images = self
            .snapshot(group)?
            .images
            .checked_add(1)
            .ok_or(Errno::EOVERFLOW)?;
        let slot = PreparedMapSlot::new_in(&IO_MEMORY, 0)?;
        let entry = slot.finish(key, Image { group, exec_serial: None, committed_exec_serial: None })?;
        let receipt = self.prepare_process(group, pid, generation)?;
        self.images.publish_io(entry);
        self.groups
            .get_mut(&group.0)
            .expect("admitted group vanished")
            .snapshot
            .images = images;
        Ok(receipt)
    }

    pub(crate) fn prepare_exec_image(&mut self, group: MemoryGroupId, pid: u32, generation: u64) -> Result<GroupAdmission, Errno> {
        let receipt = self.prepare_image(group, pid, generation)?;
        self.images.get_mut(&ImageKey { pid, generation }).unwrap().exec_serial = Some(receipt.serial);
        Ok(receipt)
    }

    pub(crate) fn validate_exec_image(&self, receipt: GroupAdmission) -> Result<(), Errno> {
        if self.prepared_image_task(receipt.execution)? != receipt { return Err(Errno::ESRCH); }
        self.exec_image(receipt)?;
        Ok(())
    }

    fn exec_image(&self, receipt: GroupAdmission) -> Result<&Image, Errno> {
        self.images.get(&ImageKey { pid: receipt.execution.pid, generation: receipt.execution.exec_generation })
            .filter(|image| image.group == receipt.group && image.exec_serial == Some(receipt.serial))
            .ok_or(Errno::ESRCH)
    }

    pub(crate) fn commit_exec_image(&mut self, receipt: GroupAdmission) -> Result<(), Errno> {
        self.validate_exec_image(receipt)?;
        let image = self.images.get_mut(&ImageKey { pid: receipt.execution.pid, generation: receipt.execution.exec_generation }).unwrap();
        image.exec_serial = None;
        image.committed_exec_serial = Some(receipt.serial);
        Ok(())
    }

    pub(crate) fn finish_exec_image_cancellation(&mut self, receipt: GroupAdmission) -> Result<(), Errno> {
        self.exec_image(receipt)?;
        self.retire_image_inner(receipt.execution.pid, receipt.execution.exec_generation, true)
    }

    pub fn image_group(&self, pid: u32, generation: u64) -> Option<MemoryGroupId> {
        self.images
            .get(&ImageKey { pid, generation })
            .map(|image| image.group)
    }

    pub fn image_task(&self, execution: GroupExecution) -> Option<GroupAdmission> {
        self.tasks
            .iter()
            .find_map(|(_, task)| (task.receipt.execution == execution).then_some(task.receipt))
    }

    pub(crate) fn prepared_image_task(&self, execution: GroupExecution) -> Result<GroupAdmission, Errno> {
        let receipt = self.image_task(execution).ok_or(Errno::ESRCH)?;
        if self.task(receipt)?.phase != Phase::Prepared { return Err(Errno::EBUSY); }
        if self.image_group(execution.pid, execution.exec_generation) != Some(receipt.group) { return Err(Errno::ESRCH); }
        Ok(receipt)
    }

    pub(crate) fn running_image_task(
        &self,
        execution: GroupExecution,
    ) -> Result<GroupAdmission, Errno> {
        let receipt = self.image_task(execution).ok_or(Errno::ESRCH)?;
        if self.task(receipt)?.phase != Phase::Running {
            return Err(Errno::EBUSY);
        }
        if self.image_group(execution.pid, execution.exec_generation) != Some(receipt.group) {
            return Err(Errno::ESRCH);
        }
        Ok(receipt)
    }

    /// Thread-state cleanup is not Worker retirement. A running admission
    /// stays charged until the host's exact fence; a never-exposed one can
    /// roll back immediately after failed construction.
    pub fn note_thread_exit(&mut self, execution: GroupExecution) -> Result<(), Errno> {
        let Some(receipt) = self.image_task(execution) else {
            return Ok(());
        };
        match self.task(receipt)?.phase {
            Phase::Prepared => self.cancel_unconstructed(receipt),
            Phase::Running => self.begin_retirement(receipt),
            Phase::Stopping | Phase::Quarantined => Ok(()),
        }
    }

    /// Drop image custody only after every one of its exact Worker receipts
    /// has retired. Old-generation cleanup remains valid after exec advances.
    pub fn retire_image(&mut self, pid: u32, generation: u64) -> Result<(), Errno> {
        self.retire_image_inner(pid, generation, false)
    }

    fn retire_image_inner(&mut self, pid: u32, generation: u64, exec_cleanup: bool) -> Result<(), Errno> {
        let key = ImageKey { pid, generation };
        let image = self.images.get(&key).ok_or(Errno::ENOENT)?;
        if image.exec_serial.is_some() && !exec_cleanup { return Err(Errno::EBUSY); }
        let group = image.group;
        if self.tasks.iter().any(|(_, task)| {
            task.receipt.execution.pid == pid
                && task.receipt.execution.exec_generation == generation
        }) {
            return Err(Errno::EBUSY);
        }
        self.images.remove(&key).expect("validated image vanished");
        let last_process_owner = !self.owns_process(group, pid);
        let snapshot = &mut self
            .groups
            .get_mut(&group.0)
            .expect("owned group vanished")
            .snapshot;
        snapshot.images -= 1;
        if last_process_owner {
            snapshot.processes -= 1;
        }
        Ok(())
    }

    /// Once an admission has escaped to a Worker, PID removal is not proof
    /// that it stopped. Only prepared, unconstructed admissions can roll back.
    pub(crate) fn can_remove_process(&self, pid: u32) -> bool {
        !self.images.iter().any(|(key, image)| key.pid == pid
            && (image.exec_serial.is_some() || image.committed_exec_serial.is_some()))
            && self.tasks.iter().all(|(_, task)| task.receipt.execution.pid != pid || task.phase == Phase::Prepared)
    }

    pub(crate) fn rollback_unconstructed_image(
        &mut self,
        pid: u32,
        generation: u64,
    ) -> Result<(), Errno> {
        let image = self.images.get(&ImageKey { pid, generation }).ok_or(Errno::ENOENT)?;
        if image.exec_serial.is_some() || image.committed_exec_serial.is_some() { return Err(Errno::EBUSY); }
        if self.tasks.iter().any(|(_, task)| {
            task.receipt.execution.pid == pid
                && task.receipt.execution.exec_generation == generation
                && task.phase != Phase::Prepared
        }) {
            return Err(Errno::EBUSY);
        }
        loop {
            let receipt = self.tasks.iter().find_map(|(_, task)| {
                (task.receipt.execution.pid == pid
                    && task.receipt.execution.exec_generation == generation)
                    .then_some(task.receipt)
            });
            let Some(receipt) = receipt else { break };
            self.cancel_unconstructed(receipt)
                .expect("prepared admission changed during rollback");
        }
        self.retire_image(pid, generation)
    }

    pub(crate) fn rollback_removed_process(&mut self, pid: u32) -> Result<(), Errno> {
        if !self.can_remove_process(pid) {
            return Err(Errno::EBUSY);
        }
        loop {
            let key = self
                .images
                .iter()
                .find_map(|(key, _)| (key.pid == pid).then_some(*key));
            let Some(key) = key else { break };
            self.rollback_unconstructed_image(pid, key.generation)?;
        }
        Ok(())
    }

    fn owns_process(&self, group: MemoryGroupId, pid: u32) -> bool {
        self.tasks
            .iter()
            .any(|(_, task)| task.receipt.group == group && task.receipt.execution.pid == pid)
            || self
                .images
                .iter()
                .any(|(key, image)| key.pid == pid && image.group == group)
    }

    fn prepare_process(
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
        let new_process = !self.owns_process(group, execution.pid);
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
        if self.task(receipt)?.phase != Phase::Prepared { return Err(Errno::EINVAL); }
        // Exec's new main may become current before the outgoing Workers have
        // actually stopped. No successor can run while any older exact task
        // still owns execution custody, including a never-started sibling.
        if self.tasks.iter().any(|(_, task)| task.receipt.execution.pid == receipt.execution.pid
            && task.receipt.execution.exec_generation < receipt.execution.exec_generation) {
            return Err(Errno::EBUSY);
        }
        self.tasks.get_mut(&receipt.serial).unwrap().phase = Phase::Running;
        if let Some(image) = self.images.get_mut(&ImageKey { pid: receipt.execution.pid, generation: receipt.execution.exec_generation }) {
            if image.committed_exec_serial == Some(receipt.serial) { image.committed_exec_serial = None; }
        }
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
        let last_process_task = !self.owns_process(receipt.group, receipt.execution.pid);
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
    fn wire_actions_reject_forgery_and_late_start_but_allow_exact_old_cleanup() {
        use wasm_posix_shared::memory_group::TaskAction;
        let (mut table, group, main) = grouped_table();
        let pid = main.execution.pid;
        let tid = table.create_thread(pid, pid, 0x8000, 0, 0).unwrap();
        let receipt = table.memory_group_task(pid, tid).unwrap().unwrap();
        let record = receipt.record();
        let other = table.memory_groups().create(limits()).unwrap();
        let before = table.memory_groups().snapshot(group).unwrap();
        assert_eq!(
            table.memory_group_task_action(
                wasm_posix_shared::memory_group::ReceiptRecord {
                    group: other.as_raw(),
                    ..record
                },
                TaskAction::Start
            ),
            Err(Errno::ESRCH)
        );
        assert_eq!(
            table.memory_group_task_action(
                wasm_posix_shared::memory_group::ReceiptRecord {
                    serial: u64::MAX,
                    ..record
                },
                TaskAction::Start
            ),
            Err(Errno::ESRCH)
        );
        assert_eq!(table.memory_groups().snapshot(group).unwrap(), before);
        table.get_mut(pid).unwrap().exec_generation += 1;
        assert_eq!(
            table.memory_group_task_action(record, TaskAction::Start),
            Err(Errno::EAGAIN)
        );
        table
            .memory_group_task_action(record, TaskAction::CancelUnconstructed)
            .unwrap();
        assert_eq!(
            table.memory_group_task_action(record, TaskAction::Start),
            Err(Errno::ESRCH)
        );
        table
            .memory_group_task_action(main.record(), TaskAction::BeginRetirement)
            .unwrap();
        table
            .memory_group_task_action(main.record(), TaskAction::RetireQuiescent)
            .unwrap();
        table.remove_process(pid).unwrap();
        table.memory_groups().seal(other).unwrap();
        table.memory_groups().remove_empty(other).unwrap();
    }

    fn grouped_table() -> (
        crate::process_table::ProcessTable,
        MemoryGroupId,
        GroupAdmission,
    ) {
        let mut table = crate::process_table::ProcessTable::new();
        table.memory_groups().configure(8192, 4).unwrap();
        let group = table.memory_groups().create(limits()).unwrap();
        let pid = table.create_process().unwrap();
        let main = table.prepare_process_memory_group(group, pid).unwrap();
        table.memory_groups().start(main).unwrap();
        (table, group, main)
    }

    fn finish_member(table: &mut crate::process_table::ProcessTable, receipt: GroupAdmission) {
        table.memory_groups().begin_retirement(receipt).unwrap();
        table.memory_groups().retire_quiescent(receipt).unwrap();
        table.remove_process(receipt.execution.pid).unwrap();
    }

    #[test]
    fn real_pthread_creation_reserves_before_publication_and_enforces_limits() {
        let (mut table, group, main) = grouped_table();
        let pid = main.execution.pid;
        let first = table.create_thread(pid, pid, 0x8000, 0, 0).unwrap();
        let first_receipt = table.memory_group_task(pid, first).unwrap().unwrap();
        assert_eq!(first_receipt.group(), group);
        table.memory_groups().start(first_receipt).unwrap();
        let second = table.create_thread(pid, first, 0x9000, 0, 0).unwrap();
        let third = table.create_thread(pid, first, 0xa000, 0, 0).unwrap();
        let before = table.get(pid).unwrap().threads.len();
        assert_eq!(
            table.create_thread(pid, first, 0xb000, 0, 0),
            Err(Errno::EAGAIN)
        );
        assert_eq!(table.get(pid).unwrap().threads.len(), before);
        assert_eq!(table.memory_groups().snapshot(group).unwrap().tasks, 4);
        for tid in [second, third] {
            let execution = table
                .memory_group_task(pid, tid)
                .unwrap()
                .unwrap()
                .execution();
            table.get_mut(pid).unwrap().remove_thread(tid).unwrap();
            table.memory_groups().note_thread_exit(execution).unwrap();
        }
        table.get_mut(pid).unwrap().remove_thread(first).unwrap();
        table
            .memory_groups()
            .note_thread_exit(first_receipt.execution())
            .unwrap();
        assert_eq!(table.memory_groups().snapshot(group).unwrap().tasks, 2);
        table
            .memory_groups()
            .retire_quiescent(first_receipt)
            .unwrap();
        finish_member(&mut table, main);
    }

    #[test]
    fn failed_group_thread_allocation_never_publishes_a_kernel_thread() {
        let (mut table, group, main) = grouped_table();
        let pid = main.execution.pid;
        crate::prepared_map::fail_after_allocations(0);
        let result = table.create_thread(pid, pid, 0x8000, 0, 0);
        crate::prepared_map::fail_after_allocations(usize::MAX);
        assert_eq!(result, Err(Errno::ENOMEM));
        assert!(table.get(pid).unwrap().threads.is_empty());
        let snapshot = table.memory_groups().snapshot(group).unwrap();
        assert_eq!((snapshot.images, snapshot.tasks), (1, 1));
        finish_member(&mut table, main);
    }

    #[test]
    fn actual_fork_inherits_image_and_unconstructed_rollback_releases_it() {
        let (mut table, group, main) = grouped_table();
        let parent = main.execution.pid;
        let ordinary = table.create_process().unwrap();
        assert_eq!(table.process_memory_group(ordinary), Ok(None));
        let child = table.fork_process_for_caller(parent, parent).unwrap();
        assert_eq!(table.process_memory_group(child), Ok(Some(group)));
        let child_receipt = table
            .memory_groups()
            .image_task(GroupExecution {
                pid: child,
                tid: child,
                exec_generation: 0,
            })
            .unwrap();
        assert_eq!(child_receipt.group(), group);
        assert_eq!(table.memory_groups().snapshot(group).unwrap().images, 2);
        assert_eq!(table.get(parent).unwrap().fork_count(), 1);
        table.remove_process(child).unwrap();
        assert_eq!(
            table.memory_groups().image_task(child_receipt.execution()),
            None
        );
        let snapshot = table.memory_groups().snapshot(group).unwrap();
        assert_eq!(
            (snapshot.processes, snapshot.images, snapshot.tasks),
            (1, 1, 1)
        );
        table.remove_process(ordinary).unwrap();
        finish_member(&mut table, main);
    }

    #[test]
    fn process_removal_waits_for_running_stopping_and_quarantined_workers() {
        let (mut table, group, main) = grouped_table();
        let pid = main.execution.pid;
        assert!(table.remove_process(pid).is_none());
        table.memory_groups().begin_retirement(main).unwrap();
        assert!(table.remove_process(pid).is_none());
        table.memory_groups().quarantine(main).unwrap();
        assert!(table.remove_process(pid).is_none());
        table.memory_groups().retire_quiescent(main).unwrap();
        let snapshot = table.memory_groups().snapshot(group).unwrap();
        assert_eq!(
            (snapshot.processes, snapshot.images, snapshot.tasks),
            (1, 1, 0)
        );
        table.memory_groups().seal(group).unwrap();
        assert_eq!(table.memory_groups().remove_empty(group), Err(Errno::EBUSY));
        table.remove_process(pid).unwrap();
        table.memory_groups().remove_empty(group).unwrap();
        assert_eq!(table.memory_groups().reserved_pages(), 0);
    }

    #[test]
    fn grouped_exit_wait_preserves_status_until_every_exact_worker_retires() {
        use wasm_posix_shared::memory_group::TaskAction;
        use wasm_posix_shared::wait::{EVENT_EXITED, WNOWAIT};
        let (mut table, group, parent) = grouped_table();
        let parent_pid = parent.execution.pid;
        let child = table.fork_process_for_caller(parent_pid, parent_pid).unwrap();
        let main = table.memory_group_task(child, child).unwrap().unwrap();
        table.memory_group_task_action(main.record(), TaskAction::Start).unwrap();
        let tid = table.create_thread(child, child, 0x8000, 0, 0).unwrap();
        let thread = table.memory_group_task(child, tid).unwrap().unwrap();
        table.memory_group_task_action(thread.record(), TaskAction::Start).unwrap();
        assert!(table.get_mut(child).unwrap().record_normal_exit(23));
        for flags in [0, WNOWAIT] {
            assert_eq!(table.poll_wait_event(parent_pid, child as i32, EVENT_EXITED, flags), Ok(None));
        }
        for receipt in [main, thread] {
            assert_eq!(table.poll_wait_event(parent_pid, child as i32, EVENT_EXITED, 0), Ok(None));
            table.memory_group_task_action(receipt.record(), TaskAction::BeginRetirement).unwrap();
            table.memory_group_task_action(receipt.record(), TaskAction::Quarantine).unwrap();
            assert_eq!(table.poll_wait_event(parent_pid, child as i32, EVENT_EXITED, 0), Ok(None));
            // Another receipt, even one in the same group, proves no stop.
            let forged = wasm_posix_shared::memory_group::ReceiptRecord { generation: 1, ..receipt.record() };
            assert_eq!(table.memory_group_task_action(forged, TaskAction::RetireQuiescent), Err(Errno::ESRCH));
            table.memory_group_task_action(receipt.record(), TaskAction::RetireQuiescent).unwrap();
        }
        for _ in 0..2 {
            let (_, event) = table.poll_wait_event(parent_pid, child as i32, EVENT_EXITED, WNOWAIT).unwrap().unwrap();
            assert_eq!(event.wait_status, 23 << 8);
        }
        let (_, event) = table.poll_wait_event(parent_pid, child as i32, EVENT_EXITED, 0).unwrap().unwrap();
        assert_eq!(event.wait_status, 23 << 8);
        assert_eq!(table.poll_wait_event(parent_pid, child as i32, EVENT_EXITED, 0), Ok(None));
        table.remove_process(child).unwrap();
        assert_eq!(table.memory_groups().snapshot(group).unwrap().tasks, 1);
        finish_member(&mut table, parent);
    }

    #[test]
    fn failed_grouped_fork_preserves_parent_and_resource_counts() {
        let mut table = crate::process_table::ProcessTable::new();
        table.memory_groups().configure(8192, 4).unwrap();
        let group = table
            .memory_groups()
            .create(MemoryGroupLimits {
                maximum_processes: 1,
                ..limits()
            })
            .unwrap();
        let pid = table.create_process().unwrap();
        let main = table.prepare_process_memory_group(group, pid).unwrap();
        table.memory_groups().start(main).unwrap();
        let pids = table.all_pids();
        assert_eq!(table.fork_process_for_caller(pid, pid), Err(Errno::EAGAIN));
        assert_eq!(table.all_pids(), pids);
        assert_eq!(table.get(pid).unwrap().fork_count(), 0);
        let snapshot = table.memory_groups().snapshot(group).unwrap();
        assert_eq!(
            (snapshot.processes, snapshot.images, snapshot.tasks),
            (1, 1, 1)
        );
        finish_member(&mut table, main);
    }

    #[test]
    fn fork_fault_injection_leaves_no_child_admission_or_image() {
        let mut refused = 0;
        let mut succeeded = 0;
        for after in 0..32 {
            let (mut table, group, main) = grouped_table();
            let pid = main.execution.pid;
            let pids = table.all_pids();
            crate::prepared_map::fail_after_allocations(after);
            let result = table.fork_process_for_caller(pid, pid);
            crate::prepared_map::fail_after_allocations(usize::MAX);
            match result {
                Ok(child) => {
                    succeeded += 1;
                    table.remove_process(child).unwrap();
                }
                Err(Errno::ENOMEM) => {
                    refused += 1;
                    assert_eq!(table.all_pids(), pids);
                    assert_eq!(table.get(pid).unwrap().fork_count(), 0);
                }
                other => panic!("unexpected fork result {other:?}"),
            }
            let snapshot = table.memory_groups().snapshot(group).unwrap();
            assert_eq!(
                (snapshot.processes, snapshot.images, snapshot.tasks),
                (1, 1, 1)
            );
            finish_member(&mut table, main);
        }
        assert!(refused > 0);
        assert!(succeeded > 0);
    }

    #[test]
    fn group_vfork_refusal_does_not_change_ordinary_vfork_policy() {
        let (mut table, _, main) = grouped_table();
        let pid = main.execution.pid;
        assert_eq!(
            table.fork_process_for_caller_with_mode(
                pid,
                pid,
                wasm_posix_shared::fork_contract::Mode::Vfork
            ),
            Err(Errno::EOPNOTSUPP)
        );
        let ordinary = table.create_process().unwrap();
        let child = table
            .fork_process_for_caller_with_mode(
                ordinary,
                ordinary,
                wasm_posix_shared::fork_contract::Mode::Vfork,
            )
            .unwrap();
        assert_eq!(table.process_memory_group(child), Ok(None));
        table.remove_process(child).unwrap();
        table.remove_process(ordinary).unwrap();
        finish_member(&mut table, main);
    }

    #[test]
    fn image_hold_retirement_is_exact_across_replacement_generations() {
        let (mut table, group, old) = grouped_table();
        let pid = old.execution.pid;
        // Model the generation advance owned by exec_target; the old image's
        // custody is independent of the mutable current Process identity.
        table.get_mut(pid).unwrap().exec_generation = 1;
        assert_eq!(table.process_memory_group(pid), Ok(None));
        let new = table.prepare_process_memory_group(group, pid).unwrap();
        assert_eq!(table.memory_groups().start(new), Err(Errno::EBUSY));
        table.memory_groups().begin_retirement(old).unwrap();
        assert_eq!(table.memory_groups().start(new), Err(Errno::EBUSY));
        table.memory_groups().retire_quiescent(old).unwrap();
        table.memory_groups().start(new).unwrap();
        table.memory_groups().retire_image(pid, 0).unwrap();
        assert_eq!(table.process_memory_group(pid), Ok(Some(group)));
        assert_eq!(
            table.memory_groups().retire_image(pid, 0),
            Err(Errno::ENOENT)
        );
        assert_eq!(
            table.memory_groups().retire_image(pid, 1),
            Err(Errno::EBUSY)
        );
        let snapshot = table.memory_groups().snapshot(group).unwrap();
        assert_eq!(
            (snapshot.processes, snapshot.images, snapshot.tasks),
            (1, 1, 1)
        );
        finish_member(&mut table, new);
    }

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
        assert_eq!(table.memory_group_task(pid, pid + 999), Err(Errno::ESRCH));
        table.get_mut(pid).unwrap().exec_generation += 1;
        assert_eq!(table.memory_group_task(pid, pid), Ok(None));
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
        assert_eq!(groups.start(new), Err(Errno::EBUSY));
        groups.retire_quiescent(old).unwrap();
        groups.start(new).unwrap();
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
