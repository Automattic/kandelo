use super::*;
use crate::wait_park::{self, Resume};
use crate::wait_queue::WaitKind;
use crate::wait_retry::{self, RetryOp};

// These controls execute real producer hooks, retry bindings and sys_read.
// MockHostIO supplies only the caller-memory boundary, not readiness or data.
fn park_read(
    p: &mut Process,
    locks: &mut AdvisoryLockManager,
    h: &mut MockHostIO,
    fd: i32,
    count: u64,
) -> (RetryOp, u64) {
    let tid = p.pid;
    set_test_current_tid(tid);
    h.proc_memory.resize(256, 0xa7);
    let source = wait_retry::backing_read_source(p, fd).expect("actual blocking managed backing");
    assert_eq!(sys_read(p, h, fd, &mut [0; 32]), Err(Errno::EAGAIN));
    let token = ensure_blocking_retry_ofd_binding(p, locks, h, tid, wait_retry::SYS_READ, fd, None).unwrap();
    let op = RetryOp::BackingRead { fd, buf: 64, count, token, source };
    let generation = wait_park::with(|parks| {
        parks.park(tid, tid, WaitKind::Transfer { operation: BlockingRetryOperation::Read }, vec![op.source()], None, Resume::Retry(op)).unwrap()
    });
    assert!(wait_park::with(|parks| parks.take_dirty_retry_waiters()).is_empty());
    assert_eq!(op.attempt(p, locks, h, tid), Err(Errno::EAGAIN));
    (op, generation)
}

fn complete_read(
    p: &mut Process,
    locks: &mut AdvisoryLockManager,
    h: &mut MockHostIO,
    op: RetryOp,
    generation: u64,
    count: i32,
) {
    let waiters = wait_park::with(|parks| parks.take_dirty_retry_waiters());
    assert_eq!(waiters.len(), 1, "only the actual source's reader");
    let (id, pid, tid, actual) = waiters[0];
    assert_eq!((pid, tid, actual), (p.pid, p.pid, op));
    assert_eq!(op.attempt(p, locks, h, tid), Ok(count));
    wait_park::with(|parks| {
        assert!(parks.finish_retry_waiter(id, op, count));
        let done = parks.take_completions();
        assert_eq!(done.len(), 1);
        assert_eq!((done[0].generation, done[0].pid, done[0].tid, done[0].value), (generation, pid, tid, count));
        assert!(parks.take_dirty_retry_waiters().is_empty());
        assert_eq!(parks.take_released_retry_bindings(), vec![(pid, tid, op.token())]);
    });
    release_blocking_retry_binding(p, locks, h, tid, op.token()).unwrap();
    assert_eq!(p.blocked_retries.binding_count(), 0);
    set_test_current_tid(0);
}

#[test]
fn eventfd_producer_wakes_pinned_read_after_descriptor_reuse() {
    let mut p = Process::new(189);
    let mut h = MockHostIO::new();
    let mut locks = AdvisoryLockManager::new();
    let fd = sys_eventfd2(&mut p, 0, 0).unwrap();
    let writer = sys_dup(&mut p, fd).unwrap();
    let (op, generation) = park_read(&mut p, &mut locks, &mut h, fd, 8);
    sys_close_with_locks(&mut p, &mut locks, &mut h, fd).unwrap();
    let replacement = sys_eventfd2(&mut p, 0, 0).unwrap();
    assert_eq!(replacement, fd);
    sys_write(&mut p, &mut h, replacement, &99u64.to_le_bytes()).unwrap();
    assert!(wait_park::with(|parks| parks.take_dirty_retry_waiters()).is_empty());
    sys_write(&mut p, &mut h, writer, &7u64.to_le_bytes()).unwrap();
    sys_write(&mut p, &mut h, writer, &4u64.to_le_bytes()).unwrap();
    complete_read(&mut p, &mut locks, &mut h, op, generation, 8);
    assert_eq!(&h.proc_memory[64..72], &11u64.to_le_bytes());
    let mut counter = [0; 8];
    assert_eq!(sys_read(&mut p, &mut h, replacement, &mut counter), Ok(8));
    assert_eq!(u64::from_le_bytes(counter), 99);
    assert_eq!(sys_read(&mut p, &mut h, writer, &mut counter), Err(Errno::EAGAIN));
    for fd in [writer, replacement] { sys_close(&mut p, &mut h, fd).unwrap(); }
}

#[test]
fn fsnotify_actual_inode_mutation_wakes_and_copies_the_real_record() {
    let mut p = Process::new(190);
    let mut h = MockHostIO::new();
    let mut locks = AdvisoryLockManager::new();
    let path = b"/tmp/backing-read-wake-notify";
    let file = crate::tmpfs::open(path, O_CREAT | O_RDWR, 0o600, 0, 0).unwrap();
    let fd = crate::fsnotify::open_description(&mut p, 0, crate::fsnotify::Limits { watches: 4, events: 8 }).unwrap();
    let wd = crate::fsnotify::watch_tmpfs_description(&p, fd, path, crate::fsnotify::MODIFY).unwrap();
    let (op, generation) = park_read(&mut p, &mut locks, &mut h, fd, 32);
    crate::tmpfs::write(file, 0, b"actual mutation").unwrap();
    complete_read(&mut p, &mut locks, &mut h, op, generation, 16);
    assert_eq!(i32::from_le_bytes(h.proc_memory[64..68].try_into().unwrap()), wd);
    assert_eq!(u32::from_le_bytes(h.proc_memory[68..72].try_into().unwrap()), crate::fsnotify::MODIFY);
    assert_eq!(&h.proc_memory[72..80], &[0; 8]);
    assert_eq!(sys_read(&mut p, &mut h, fd, &mut [0; 32]), Err(Errno::EAGAIN));
    sys_close(&mut p, &mut h, fd).unwrap();
    crate::tmpfs::release_handle(file);
}
