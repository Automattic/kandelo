//! Kernel-owned fork and vfork launch state, and the event queue that reports
//! its transitions to the host.
//!
//! Every launch is tracked here from `kernel_fork_process` until the parent's SYS_FORK/SYS_VFORK has
//! a result:
//!
//! * `PendingForkLaunch` on the child records who is parked (parent pid and
//!   task) and how far the launch got (`Launching → ReplayReady/Committed`).
//! * A vfork child additionally carries a `VforkParentLink` naming the
//!   borrowed `AddressSpaceId`, and the process table records the borrower
//!   for that address space so a second vfork on it is refused.
//!
//! The host still owns the facts the kernel cannot observe (Worker spawn,
//! realm quiescence, whether a child Worker ever started). It reports them
//! through `kernel_fork_launch_failed` and
//! `kernel_vfork_address_space_released`; the kernel reports its own
//! transitions through the queue below, whose record layout is
//! `wasm_posix_shared::fork_lifecycle_event_wire`.
//!
//! There is no host-completed launch any more: lane F stage 2d moved the
//! native host onto this state, and every host now completes a parked parent
//! only from this queue.

use alloc::vec::Vec;
use core::sync::atomic::{AtomicU64, Ordering};
use wasm_posix_shared::fork_contract::Mode;
use wasm_posix_shared::fork_lifecycle_event_wire as wire;

/// Identity of one process address space (one Wasm image and its memory).
///
/// Created with every process record and replaced at exec; a vfork child is
/// the only process that is given an existing identity, its parent's. Ids are
/// never reused within a kernel instance, so a stale id cannot alias a later
/// image.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct AddressSpaceId(u64);

static NEXT_ADDRESS_SPACE_ID: AtomicU64 = AtomicU64::new(1);

impl AddressSpaceId {
    /// Allocate a never-before-used identity.
    pub fn fresh() -> Self {
        AddressSpaceId(NEXT_ADDRESS_SPACE_ID.fetch_add(1, Ordering::Relaxed))
    }

    pub fn as_raw(self) -> u64 {
        self.0
    }
}

/// How far a kernel-completed fork launch has progressed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForkLaunchPhase {
    /// The child record exists; its replay has not reported readiness.
    Launching,
    /// A vfork child reached its fork site and runs on the borrowed image.
    /// The parent stays parked until the address space is released.
    ReplayReady,
    /// The parent's result is decided (queued as `KIND_PARENT_COMPLETE`).
    Committed,
}

/// Launch record carried by a child created with kernel completion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PendingForkLaunch {
    pub parent_pid: u32,
    pub parent_tid: u32,
    pub mode: Mode,
    pub phase: ForkLaunchPhase,
}

/// Present on a vfork child for as long as it borrows its parent's image.
///
/// Cleared when the child exec's or exits, the moment it stops running on
/// the borrowed image; the process table's borrower record outlives it until
/// the host reports quiescence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VforkParentLink {
    pub parent_pid: u32,
    pub parent_tid: u32,
    pub address_space: AddressSpaceId,
}

/// The table's record of the one child borrowing an address space.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VforkBorrow {
    pub child_pid: u32,
    pub parent_pid: u32,
    pub parent_tid: u32,
}

/// Outcome of `ProcessTable::fork_launch_failed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchFailedOutcome {
    /// The child was removed; the parent receives `-errno`.
    RolledBack,
    /// The child already died or committed; nothing was rolled back.
    AlreadyResolved,
}

impl LaunchFailedOutcome {
    pub fn wire_value(self) -> i32 {
        match self {
            LaunchFailedOutcome::RolledBack => wire::LAUNCH_FAILED_ROLLED_BACK,
            LaunchFailedOutcome::AlreadyResolved => wire::LAUNCH_FAILED_ALREADY_RESOLVED,
        }
    }
}

/// What the host asked for when it released a vfork address space.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VforkReleaseDisposition {
    Resume,
    Contain,
}

impl VforkReleaseDisposition {
    pub fn from_u32(value: u32) -> Option<Self> {
        match value {
            wire::RELEASE_RESUME => Some(Self::Resume),
            wire::RELEASE_CONTAIN => Some(Self::Contain),
            _ => None,
        }
    }
}

/// The processes a `Contain` release terminated (by SIGSEGV, through the
/// ordinary signal-termination path), so the caller can tear down exactly
/// those host realms.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VforkContainment {
    pub parent_pid: u32,
    /// `None` when the child already exited (or was reaped).
    pub child_pid: Option<u32>,
}

/// One queued transition. Field meanings are documented on
/// `wasm_posix_shared::fork_lifecycle_event_wire`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ForkLifecycleEvent {
    pub kind: u32,
    pub mode: Mode,
    pub child_pid: u32,
    pub parent_pid: u32,
    pub parent_tid: u32,
    pub value: i32,
}

impl ForkLifecycleEvent {
    pub fn parent_complete(
        mode: Mode,
        child_pid: u32,
        parent_pid: u32,
        parent_tid: u32,
        result: i32,
    ) -> Self {
        ForkLifecycleEvent {
            kind: wire::KIND_PARENT_COMPLETE,
            mode,
            child_pid,
            parent_pid,
            parent_tid,
            value: result,
        }
    }

    fn encode(&self, out: &mut [u8]) {
        let put = |out: &mut [u8], offset: usize, bytes: [u8; 4]| {
            out[offset..offset + 4].copy_from_slice(&bytes);
        };
        put(out, wire::KIND_OFFSET, self.kind.to_le_bytes());
        put(out, wire::MODE_OFFSET, (self.mode as u32).to_le_bytes());
        put(out, wire::CHILD_PID_OFFSET, self.child_pid.to_le_bytes());
        put(out, wire::PARENT_PID_OFFSET, self.parent_pid.to_le_bytes());
        put(out, wire::PARENT_TID_OFFSET, self.parent_tid.to_le_bytes());
        put(out, wire::VALUE_OFFSET, self.value.to_le_bytes());
    }
}

struct EventQueue {
    #[cfg(not(test))]
    events: core::cell::UnsafeCell<Vec<ForkLifecycleEvent>>,
}

// Kernel Wasm execution is serialized; see `wakeup.rs` for the same shape.
unsafe impl Sync for EventQueue {}

static EVENT_QUEUE: EventQueue = EventQueue {
    #[cfg(not(test))]
    events: core::cell::UnsafeCell::new(Vec::new()),
};

// Native unit tests run in parallel; give each test thread its own queue so
// one test cannot drain another's events.
#[cfg(test)]
std::thread_local! {
    static TEST_EVENTS: core::cell::RefCell<Vec<ForkLifecycleEvent>> =
        core::cell::RefCell::new(Vec::new());
}

/// Queue one transition for the host, and raise the fork-lifecycle wake so
/// the host's ordinary wake drain knows to drain this queue too.
pub fn push(event: ForkLifecycleEvent) {
    crate::wakeup::push(0, wasm_posix_shared::wakeup_event_wire::TYPE_FORK_LIFECYCLE);
    #[cfg(test)]
    {
        let _ = &EVENT_QUEUE;
        TEST_EVENTS.with(|events| events.borrow_mut().push(event));
    }
    #[cfg(not(test))]
    unsafe { &mut *EVENT_QUEUE.events.get() }.push(event);
}

/// Write up to `max_events` whole records into `out` and dequeue them.
/// Records that do not fit stay queued in order.
pub fn drain(out: &mut [u8], max_events: u32) -> u32 {
    #[cfg(test)]
    {
        TEST_EVENTS.with(|events| drain_from(&mut events.borrow_mut(), out, max_events))
    }
    #[cfg(not(test))]
    {
        drain_from(unsafe { &mut *EVENT_QUEUE.events.get() }, out, max_events)
    }
}

fn drain_from(events: &mut Vec<ForkLifecycleEvent>, out: &mut [u8], max_events: u32) -> u32 {
    let count = events
        .len()
        .min(max_events as usize)
        .min(out.len() / wire::RECORD_BYTES);
    for (index, event) in events.iter().take(count).enumerate() {
        let offset = index * wire::RECORD_BYTES;
        event.encode(&mut out[offset..offset + wire::RECORD_BYTES]);
    }
    events.drain(..count);
    count as u32
}

/// Test-only view of the queue without the byte encoding.
#[cfg(test)]
pub fn take_for_test() -> Vec<ForkLifecycleEvent> {
    TEST_EVENTS.with(|events| core::mem::take(&mut *events.borrow_mut()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drain_writes_whole_records_and_keeps_the_rest_in_order() {
        let _ = take_for_test();
        for child in [10u32, 11, 12] {
            push(ForkLifecycleEvent::parent_complete(
                Mode::Fork,
                child,
                2,
                3,
                child as i32,
            ));
        }
        push(ForkLifecycleEvent {
            kind: wire::KIND_VFORK_AWAITING_QUIESCENCE,
            mode: Mode::Vfork,
            child_pid: 13,
            parent_pid: 2,
            parent_tid: 4,
            value: wire::QUIESCENCE_REASON_EXEC,
        });

        // Room for one and a half records: exactly one is written.
        let mut out = [0u8; wire::RECORD_BYTES + wire::RECORD_BYTES / 2];
        assert_eq!(drain(&mut out, 8), 1);
        let word = |offset: usize| u32::from_le_bytes(out[offset..offset + 4].try_into().unwrap());
        assert_eq!(word(wire::KIND_OFFSET), wire::KIND_PARENT_COMPLETE);
        assert_eq!(word(wire::MODE_OFFSET), Mode::Fork as u32);
        assert_eq!(word(wire::CHILD_PID_OFFSET), 10);
        assert_eq!(word(wire::PARENT_PID_OFFSET), 2);
        assert_eq!(word(wire::PARENT_TID_OFFSET), 3);
        assert_eq!(word(wire::VALUE_OFFSET), 10);

        let mut big = [0u8; wire::RECORD_BYTES * 8];
        assert_eq!(drain(&mut big, 2), 2);
        let rest = take_for_test();
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].child_pid, 13);
        assert_eq!(rest[0].value, wire::QUIESCENCE_REASON_EXEC);
    }

    #[test]
    fn address_space_ids_are_never_reused() {
        let a = AddressSpaceId::fresh();
        let b = AddressSpaceId::fresh();
        assert_ne!(a, b);
        assert!(b > a);
    }
}

/// Kernel-owned launch and vfork lifetime, driven through the same process
/// table entry points the kernel exports use.
#[cfg(test)]
mod table_tests {
    use super::*;
    use crate::process::ProcessState;
    use crate::process::test_host::NoopHost;
    use crate::process_table::ProcessTable;
    use wasm_posix_shared::Errno;
    use wasm_posix_shared::signal::{SIGKILL, SIGSEGV};
    use wasm_posix_shared::wait::EVENT_EXITED;

    const ENOMEM: u32 = Errno::ENOMEM as u32;

    fn setup() -> (ProcessTable, u32) {
        let _ = take_for_test();
        let mut table = ProcessTable::new();
        let parent = table.create_process().unwrap();
        (table, parent)
    }

    fn kernel_fork(table: &mut ProcessTable, parent: u32, mode: Mode) -> Result<u32, Errno> {
        table.fork_process_for_caller_with_mode(parent, parent, mode)
    }

    fn parent_complete(mode: Mode, child: u32, parent: u32, result: i32) -> ForkLifecycleEvent {
        ForkLifecycleEvent::parent_complete(mode, child, parent, parent, result)
    }

    fn awaiting(child: u32, parent: u32, reason: i32) -> ForkLifecycleEvent {
        ForkLifecycleEvent {
            kind: wire::KIND_VFORK_AWAITING_QUIESCENCE,
            mode: Mode::Vfork,
            child_pid: child,
            parent_pid: parent,
            parent_tid: parent,
            value: reason,
        }
    }

    fn phase(table: &ProcessTable, child: u32) -> ForkLaunchPhase {
        table.get(child).unwrap().fork_launch.unwrap().phase
    }

    #[test]
    fn replay_ready_before_the_host_registers_commits_the_parent() {
        let (mut table, parent) = setup();
        let child = kernel_fork(&mut table, parent, Mode::Fork).unwrap();
        assert_eq!(phase(&table, child), ForkLaunchPhase::Launching);
        // Nothing is reported until the child proves it reached the fork site.
        assert!(take_for_test().is_empty());

        // The kernel record exists from kernel_fork_process on, so readiness
        // is accepted whenever it arrives, with no host registration step.
        assert_eq!(table.fork_replay_ready(child), Ok(()));
        assert_eq!(phase(&table, child), ForkLaunchPhase::Committed);
        assert_eq!(
            take_for_test(),
            [parent_complete(Mode::Fork, child, parent, child as i32)]
        );
    }

    #[test]
    fn killed_pending_child_gives_the_parent_its_pid_and_a_reapable_zombie() {
        let (mut table, parent) = setup();
        let child = kernel_fork(&mut table, parent, Mode::Fork).unwrap();
        let mut host = NoopHost;
        crate::signal::terminate_process_by_signal(
            table.get_mut(child).unwrap(),
            &mut host,
            SIGKILL,
        );

        // Readiness never arrives, yet the parent's fork() returns the pid.
        assert_eq!(
            take_for_test(),
            [parent_complete(Mode::Fork, child, parent, child as i32)]
        );
        // A late ready from the dead child is refused.
        assert_eq!(table.fork_replay_ready(child), Err(Errno::ESRCH));
        // The host's late launch failure does not roll the zombie back.
        assert_eq!(
            table
                .fork_launch_failed(child, ENOMEM)
                .map(|(outcome, _)| outcome),
            Ok(LaunchFailedOutcome::AlreadyResolved)
        );
        assert!(take_for_test().is_empty());
        // POSIX: the parent can reap the child it was told about.
        let (reaped, event) = table
            .poll_wait_event(parent, child as i32, EVENT_EXITED, 0)
            .unwrap()
            .unwrap();
        assert_eq!(reaped, child);
        assert_eq!(event.si_status, SIGKILL as i32);
    }

    #[test]
    fn killed_pending_vfork_child_waits_for_release_then_gives_the_parent_its_pid() {
        let (mut table, parent) = setup();
        let child = kernel_fork(&mut table, parent, Mode::Vfork).unwrap();
        let mut host = NoopHost;
        crate::signal::terminate_process_by_signal(
            table.get_mut(child).unwrap(),
            &mut host,
            SIGKILL,
        );

        // The parent shares the image, so it waits for the host's quiescence
        // proof rather than resuming at the kill.
        assert_eq!(
            take_for_test(),
            [awaiting(child, parent, wire::QUIESCENCE_REASON_EXIT)]
        );
        // The dead child can no longer claim readiness.
        assert_eq!(table.fork_replay_ready(child), Err(Errno::ESRCH));
        assert_eq!(
            table.vfork_address_space_released(child, VforkReleaseDisposition::Resume, &mut host),
            Ok(None)
        );
        assert_eq!(
            take_for_test(),
            [parent_complete(Mode::Vfork, child, parent, child as i32)]
        );
        let (reaped, _) = table
            .poll_wait_event(parent, child as i32, EVENT_EXITED, 0)
            .unwrap()
            .unwrap();
        assert_eq!(reaped, child);
    }

    #[test]
    fn stale_and_duplicate_readiness_is_refused() {
        let (mut table, parent) = setup();
        let child = kernel_fork(&mut table, parent, Mode::Fork).unwrap();
        assert_eq!(table.fork_replay_ready(child), Ok(()));
        let _ = take_for_test();

        // Duplicate: the launch already committed.
        assert_eq!(table.fork_replay_ready(child), Err(Errno::EALREADY));
        // A process that is not a kernel-completed fork child.
        assert_eq!(table.fork_replay_ready(parent), Err(Errno::EINVAL));
        // No such process.
        assert_eq!(table.fork_replay_ready(0x7fff_0000), Err(Errno::ESRCH));
        // After exec the launch record belongs to a discarded image.
        let mut host = NoopHost;
        crate::syscalls::commit_exec_state(table.get_mut(child).unwrap(), &mut host, child)
            .unwrap();
        assert_eq!(table.fork_replay_ready(child), Err(Errno::EINVAL));
        assert!(take_for_test().is_empty());
    }

    #[test]
    fn launch_failure_rolls_back_and_reports_the_errno_to_the_parent() {
        let (mut table, parent) = setup();
        let child = kernel_fork(&mut table, parent, Mode::Fork).unwrap();
        assert_eq!(
            table.fork_launch_failed(child, 0).map(|(o, _)| o),
            Err(Errno::EINVAL)
        );
        assert_eq!(
            table.fork_launch_failed(child, 4096).map(|(o, _)| o),
            Err(Errno::EINVAL)
        );

        let (outcome, removed) = table.fork_launch_failed(child, ENOMEM).unwrap();
        assert_eq!(outcome, LaunchFailedOutcome::RolledBack);
        assert!(removed.is_some());
        // The parent never observes the rolled-back PID.
        assert!(table.get(child).is_none());
        assert_eq!(
            take_for_test(),
            [parent_complete(Mode::Fork, child, parent, -(ENOMEM as i32))]
        );
        assert_eq!(
            table.fork_launch_failed(child, ENOMEM).map(|(o, _)| o),
            Err(Errno::ESRCH)
        );

        // A committed child is the parent's result already.
        let committed = kernel_fork(&mut table, parent, Mode::Fork).unwrap();
        table.fork_replay_ready(committed).unwrap();
        let _ = take_for_test();
        assert_eq!(
            table.fork_launch_failed(committed, ENOMEM).map(|(o, _)| o),
            Ok(LaunchFailedOutcome::AlreadyResolved)
        );
        assert!(table.get(committed).is_some());
        assert!(take_for_test().is_empty());

        // A vfork launch failure also frees the borrowed address space.
        let vchild = kernel_fork(&mut table, parent, Mode::Vfork).unwrap();
        let (outcome, _) = table.fork_launch_failed(vchild, ENOMEM).unwrap();
        assert_eq!(outcome, LaunchFailedOutcome::RolledBack);
        assert_eq!(
            take_for_test(),
            [parent_complete(
                Mode::Vfork,
                vchild,
                parent,
                -(ENOMEM as i32)
            )]
        );
        let space = table.get(parent).unwrap().address_space;
        assert!(!table.vfork_address_space_borrowed(space));
        assert!(kernel_fork(&mut table, parent, Mode::Vfork).is_ok());
    }

    #[test]
    fn second_vfork_on_a_borrowed_address_space_is_eagain() {
        let (mut table, parent) = setup();
        let space = table.get(parent).unwrap().address_space;
        let child = kernel_fork(&mut table, parent, Mode::Vfork).unwrap();
        assert_eq!(table.get(child).unwrap().address_space, space);
        assert!(table.vfork_address_space_borrowed(space));

        let pids_before: alloc::vec::Vec<u32> = table.processes.keys().copied().collect();
        assert_eq!(
            kernel_fork(&mut table, parent, Mode::Vfork),
            Err(Errno::EAGAIN)
        );
        // Refusal happens before any child state exists.
        let pids_after: alloc::vec::Vec<u32> = table.processes.keys().copied().collect();
        assert_eq!(pids_before, pids_after);
        // An ordinary fork copies the image and is unaffected.
        let forked = kernel_fork(&mut table, parent, Mode::Fork).unwrap();
        assert_ne!(table.get(forked).unwrap().address_space, space);
    }

    #[test]
    fn vfork_exec_and_exit_both_move_to_awaiting_quiescence() {
        for reason in [wire::QUIESCENCE_REASON_EXEC, wire::QUIESCENCE_REASON_EXIT] {
            let (mut table, parent) = setup();
            let space = table.get(parent).unwrap().address_space;
            let child = kernel_fork(&mut table, parent, Mode::Vfork).unwrap();
            // Readiness starts the child on the borrowed image; the parent
            // stays parked, so nothing is reported.
            assert_eq!(table.fork_replay_ready(child), Ok(()));
            assert_eq!(phase(&table, child), ForkLaunchPhase::ReplayReady);
            assert!(take_for_test().is_empty());

            let mut host = NoopHost;
            if reason == wire::QUIESCENCE_REASON_EXEC {
                crate::syscalls::commit_exec_state(table.get_mut(child).unwrap(), &mut host, child)
                    .unwrap();
                assert_ne!(table.get(child).unwrap().address_space, space);
            } else {
                crate::syscalls::sys_exit(table.get_mut(child).unwrap(), &mut host, 0);
            }
            assert!(table.get(child).unwrap().vfork_parent.is_none());
            assert_eq!(take_for_test(), [awaiting(child, parent, reason)]);
            // Until the host proves quiescence the image is still lent out.
            assert!(table.vfork_address_space_borrowed(space));
            assert_eq!(
                kernel_fork(&mut table, parent, Mode::Vfork),
                Err(Errno::EAGAIN)
            );
        }
    }

    #[test]
    fn release_resume_completes_the_parent_only_after_the_borrow_ends() {
        let (mut table, parent) = setup();
        let space = table.get(parent).unwrap().address_space;
        let child = kernel_fork(&mut table, parent, Mode::Vfork).unwrap();
        table.fork_replay_ready(child).unwrap();
        let mut host = NoopHost;

        assert_eq!(
            table.vfork_address_space_released(child, VforkReleaseDisposition::Resume, &mut host),
            Err(Errno::EBUSY)
        );
        crate::syscalls::sys_exit(table.get_mut(child).unwrap(), &mut host, 3);
        let _ = take_for_test();

        assert_eq!(
            table.vfork_address_space_released(child, VforkReleaseDisposition::Resume, &mut host),
            Ok(None)
        );
        assert_eq!(
            take_for_test(),
            [parent_complete(Mode::Vfork, child, parent, child as i32)]
        );
        assert_eq!(phase(&table, child), ForkLaunchPhase::Committed);
        assert!(!table.vfork_address_space_borrowed(space));
        assert_eq!(table.get(parent).unwrap().state, ProcessState::Running);
        assert_eq!(
            table.vfork_address_space_released(child, VforkReleaseDisposition::Resume, &mut host),
            Err(Errno::ESRCH)
        );
        // The image can be lent again.
        assert!(kernel_fork(&mut table, parent, Mode::Vfork).is_ok());
    }

    #[test]
    fn release_resume_after_the_child_was_reaped() {
        let (mut table, parent) = setup();
        let child = kernel_fork(&mut table, parent, Mode::Vfork).unwrap();
        let mut host = NoopHost;
        crate::syscalls::sys_exit(table.get_mut(child).unwrap(), &mut host, 0);
        // A sibling thread of the parked parent may reap the zombie first.
        table.reap_process(child).unwrap();
        let _ = take_for_test();
        assert_eq!(
            table.vfork_address_space_released(child, VforkReleaseDisposition::Resume, &mut host),
            Ok(None)
        );
        assert_eq!(
            take_for_test(),
            [parent_complete(Mode::Vfork, child, parent, child as i32)]
        );
    }

    #[test]
    fn release_contain_terminates_both_images_and_never_completes_the_parent() {
        let (mut table, parent) = setup();
        let space = table.get(parent).unwrap().address_space;
        let child = kernel_fork(&mut table, parent, Mode::Vfork).unwrap();
        table.fork_replay_ready(child).unwrap();
        let mut host = NoopHost;

        // Ambiguous teardown while the child may still run on the image.
        assert_eq!(
            table.vfork_address_space_released(child, VforkReleaseDisposition::Contain, &mut host),
            Ok(Some(VforkContainment {
                parent_pid: parent,
                child_pid: Some(child)
            }))
        );
        for pid in [parent, child] {
            let proc = table.get(pid).unwrap();
            assert_eq!(proc.state, ProcessState::Exited);
            assert_eq!(proc.exit_signal, SIGSEGV);
        }
        // Neither a parent completion nor a second quiescence request.
        assert!(take_for_test().is_empty());
        assert!(!table.vfork_address_space_borrowed(space));
    }
}
