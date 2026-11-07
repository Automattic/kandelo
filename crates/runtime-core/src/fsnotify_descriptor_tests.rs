use super::*;
use crate::fsnotify::{self, Limits, MODIFY, ATTRIB};
use wasm_posix_shared::epoll::{EPOLLIN, EPOLLRDNORM, EPOLLET};
use wasm_posix_shared::fd_flags::{FD_CLOEXEC, FD_CLOFORK};

fn open(p: &mut Process, flags: u32) -> i32 {
    fsnotify::open_description(p, flags, Limits { watches: 16, events: 32 }).unwrap()
}
fn handle(p: &Process, fd: i32) -> i64 {
    p.ofd_table.get(p.fd_table.get(fd).unwrap().ofd_ref.0).unwrap().host_handle
}
fn source(path: &[u8]) -> i64 {
    crate::tmpfs::open(path, O_CREAT | O_RDWR, 0o600, 0, 0).unwrap()
}
fn wait(p: &mut Process, h: &mut MockHostIO, ep: i32) -> Vec<(u32, u64)> {
    sys_epoll_pwait(p, h, ep, 8, 0, None).unwrap().1
}

#[test]
fn fsnotify_descriptor_dup_flags_queue_and_final_close_have_real_owners() {
    let mut p = Process::new(145);let mut h = MockHostIO::new();
    let path = b"/tmp/fsnotify_descriptor_alias";let file = source(path);
    let fd = open(&mut p, O_NONBLOCK | O_CLOEXEC);let backing = handle(&p, fd);
    let alias = sys_dup(&mut p, fd).unwrap();
    assert!(crate::descriptor_backing::is_live_managed_ofd(FileType::FsNotify, backing));
    assert_ne!(p.fd_table.get(fd).unwrap().fd_flags & FD_CLOEXEC, 0);
    assert_eq!(p.fd_table.get(alias).unwrap().fd_flags, 0);
    let wd = fsnotify::watch_tmpfs_description(&p, fd, path, MODIFY).unwrap();
    assert_eq!(sys_read(&mut p, &mut h, alias, &mut []), Err(Errno::EAGAIN));
    crate::tmpfs::write(file, 0, b"bytes").unwrap();
    let mut poll = [WasmPollFd { fd: alias, events: 0x41, revents: 0 }];
    assert_eq!(sys_poll(&mut p, &mut h, &mut poll, 0), Ok(1));assert_eq!(poll[0].revents, 0x41);
    let mut available = [0; 4];sys_ioctl(&mut p, &mut h, fd, 0x541B, &mut available).unwrap();
    assert_eq!(i32::from_le_bytes(available), 16);
    let mut short = [0xaa; 15];assert_eq!(sys_read(&mut p, &mut h, alias, &mut short), Err(Errno::EINVAL));assert_eq!(short, [0xaa; 15]);
    assert_eq!(sys_read(&mut p, &mut h, fd, &mut []), Err(Errno::EINVAL));
    let mut event = [0; 16];assert_eq!(sys_read(&mut p, &mut h, alias, &mut event), Ok(16));
    assert_eq!(i32::from_le_bytes(event[..4].try_into().unwrap()), wd);
    assert_eq!(u32::from_le_bytes(event[4..8].try_into().unwrap()), MODIFY);
    assert_eq!(sys_read(&mut p, &mut h, fd, &mut event), Err(Errno::EAGAIN));
    sys_fcntl(&mut p, alias, F_SETFL, 0).unwrap();
    assert_eq!(sys_fcntl(&mut p, fd, F_GETFL, 0).unwrap() as u32 & O_NONBLOCK, 0);
    assert_eq!(sys_write(&mut p, &mut h, alias, b"x"), Err(Errno::EBADF));
    for whence in 0..=4 { assert_eq!(sys_lseek(&mut p, &mut h, fd, -999, whence), Ok(0)); }
    assert_eq!(sys_lseek(&mut p, &mut h, fd, 999, 99), Err(Errno::EINVAL));
    assert_eq!(sys_pread(&mut p, &mut h, fd, &mut [0; 16], 0), Err(Errno::ESPIPE));
    assert_eq!(sys_pwrite(&mut p, &mut h, fd, b"x", 0), Err(Errno::ESPIPE));
    assert_eq!(validate_transfer_input(&p, fd, None), Err(Errno::EINVAL));
    // Async delivery is an implementation gap. Refuse admission before
    // changing real flags; expected refusal is not passing async conformance.
    let flags = sys_fcntl(&mut p, fd, F_GETFL, 0).unwrap();
    assert_eq!(sys_ioctl(&mut p, &mut h, fd, 0x5452, &mut 1i32.to_le_bytes()), Err(Errno::EOPNOTSUPP));
    assert_eq!(sys_fcntl(&mut p, fd, F_SETFL, wasm_posix_shared::flags::O_ASYNC), Err(Errno::EOPNOTSUPP));
    assert_eq!(sys_fcntl(&mut p, fd, F_GETFL, 0).unwrap(), flags);
    // This is a preserved implementation gap, not passing anonymous-stat parity.
    assert_eq!(sys_fstat(&p, &mut h, fd).unwrap_err(), Errno::EOPNOTSUPP);
    assert_eq!(sys_fchmod(&mut p, &mut h, fd, 0o777), Err(Errno::EOPNOTSUPP));
    assert_eq!(sys_fchown(&mut p, &mut h, fd, 7, 8), Err(Errno::EOPNOTSUPP));
    assert_eq!(sys_fstatfs(&mut p, &mut h, fd).unwrap_err(), Errno::EOPNOTSUPP);
    sys_close(&mut p, &mut h, fd).unwrap();assert!(fsnotify::is_live_handle(backing));
    sys_close(&mut p, &mut h, alias).unwrap();assert!(!fsnotify::is_live_handle(backing));
    assert!(h.closed_handles.is_empty(), "no anonymous handle may be delegated to host_close");
    crate::tmpfs::release_handle(file);
}

#[test]
fn fsnotify_descriptor_actual_enqueue_coalescing_and_edges_use_queue_state() {
    let mut p = Process::new(146);let mut h = MockHostIO::new();
    let path = b"/tmp/fsnotify_descriptor_edges";let file = source(path);
    let fd = open(&mut p, O_NONBLOCK);let ep = sys_epoll_create1(&mut p, 0).unwrap();
    let wd = fsnotify::watch_tmpfs_description(&p, fd, path, MODIFY | ATTRIB).unwrap();
    sys_epoll_ctl(&mut p, ep, 1, fd, EPOLLIN | EPOLLRDNORM | EPOLLET, 99).unwrap();
    assert!(wait(&mut p, &mut h, ep).is_empty());
    crate::tmpfs::write(file, 0, b"a").unwrap();
    assert_eq!(wait(&mut p, &mut h, ep), [(EPOLLIN | EPOLLRDNORM, 99)]);
    assert!(wait(&mut p, &mut h, ep).is_empty());
    // The real adjacent event merges: no new record, therefore no callback.
    crate::tmpfs::write(file, 0, b"b").unwrap();assert!(wait(&mut p, &mut h, ep).is_empty());
    #[cfg(not(any(target_arch = "wasm32", target_arch = "wasm64")))]
    {
        let mut changed = Err(Errno::EIO);
        let allocations = crate::epoll::allocation_probe::measure(|| { changed = crate::tmpfs::fchmod(file, 0o640); });
        assert_eq!(changed, Ok(()));assert_eq!(allocations, 0, "real committed inode mutation/queue/candidate publication must not allocate");
    }
    #[cfg(any(target_arch = "wasm32", target_arch = "wasm64"))]
    crate::tmpfs::fchmod(file, 0o640).unwrap();
    assert_eq!(wait(&mut p, &mut h, ep), [(EPOLLIN | EPOLLRDNORM, 99)]);
    let mut events = [0; 32];assert_eq!(sys_read(&mut p, &mut h, fd, &mut events), Ok(32));
    assert!(wait(&mut p, &mut h, ep).is_empty());
    crate::tmpfs::write(file, 0, b"c").unwrap();
    assert_eq!(wait(&mut p, &mut h, ep), [(EPOLLIN | EPOLLRDNORM, 99)]);
    fsnotify::remove_description_watch(&p, fd, wd).unwrap();
    assert_eq!(wait(&mut p, &mut h, ep), [(EPOLLIN | EPOLLRDNORM, 99)]);
    sys_close(&mut p, &mut h, fd).unwrap();
    assert!(epoll_resolved_interests(&p, ep).unwrap().is_empty());
    sys_close(&mut p, &mut h, ep).unwrap();crate::tmpfs::release_handle(file);
}

#[test]
fn fsnotify_descriptor_modern_exec_retains_queue_and_releases_cloexec_owners() {
    let mut p = Process::new(147);let mut h = MockHostIO::new();
    let path = b"/tmp/fsnotify_descriptor_exec";let file = source(path);
    let clo = open(&mut p, O_NONBLOCK | O_CLOEXEC);let retained = sys_dup(&mut p, clo).unwrap();
    let backing = handle(&p, retained);fsnotify::watch_tmpfs_description(&p, clo, path, MODIFY).unwrap();
    let last = open(&mut p, O_CLOEXEC);let dropped = handle(&p, last);
    crate::tmpfs::write(file, 0, b"exec").unwrap();let pid = p.pid;
    commit_exec_state(&mut p, &mut h, pid).unwrap();
    assert!(p.fd_table.get(clo).is_err());assert!(p.fd_table.get(last).is_err());
    assert!(fsnotify::is_live_handle(backing));assert!(!fsnotify::is_live_handle(dropped));
    assert_eq!(sys_read(&mut p, &mut h, retained, &mut [0; 16]), Ok(16));
    sys_close(&mut p, &mut h, retained).unwrap();assert!(!fsnotify::is_live_handle(backing));
    crate::tmpfs::release_handle(file);
}

#[test]
fn fsnotify_descriptor_wire_refusal_precedes_writes_and_filters_real_cloexec_clofork() {
    let mut p = Process::new(148);let mut h = MockHostIO::new();
    let mut before_fork = vec![0; 65536];let n = crate::fork::serialize_fork_state(&p, &mut before_fork).unwrap();before_fork.truncate(n);
    let mut before_exec = vec![0; 65536];let n = crate::fork::serialize_exec_state(&p, &mut before_exec).unwrap();before_exec.truncate(n);
    let fd = open(&mut p, O_CLOEXEC);let backing = handle(&p, fd);
    let mut refused = [0xa7; 256];assert_eq!(crate::fork::serialize_fork_state(&p, &mut refused), Err(Errno::EOPNOTSUPP));assert_eq!(refused, [0xa7; 256]);
    // Test-only legacy exec wire omits the real CLOEXEC description; production
    // modern exec is separately covered above and never serializes this tag.
    let mut filtered = vec![0; 65536];let n = crate::fork::serialize_exec_state(&p, &mut filtered).unwrap();assert_eq!(&filtered[..n], &before_exec);
    sys_fcntl(&mut p, fd, F_SETFD, FD_CLOFORK).unwrap();
    let n = crate::fork::serialize_fork_state(&p, &mut filtered).unwrap();assert_eq!(&filtered[..n], &before_fork);
    let mut refused = [0xb7; 256];assert_eq!(crate::fork::serialize_exec_state(&p, &mut refused), Err(Errno::EOPNOTSUPP));assert_eq!(refused, [0xb7; 256]);
    assert!(fsnotify::is_live_handle(backing));sys_close(&mut p, &mut h, fd).unwrap();
}

#[test]
fn fsnotify_descriptor_blocked_read_pin_keeps_exact_queue_across_fd_reuse() {
    let mut p = Process::new(149);let mut h = MockHostIO::new();let mut locks = AdvisoryLockManager::new();
    let path = b"/tmp/fsnotify_descriptor_retry";let file = source(path);let tid = p.pid;set_test_current_tid(tid);
    let fd = open(&mut p, 0);let backing = handle(&p, fd);
    fsnotify::watch_tmpfs_description(&p, fd, path, MODIFY).unwrap();
    assert_eq!(sys_read(&mut p, &mut h, fd, &mut [0; 16]), Err(Errno::EAGAIN));
    let token = ensure_blocking_retry_ofd_binding(&mut p, &mut locks, &mut h, tid, 3, fd, None).unwrap();
    sys_close_with_locks(&mut p, &mut locks, &mut h, fd).unwrap();assert!(fsnotify::is_live_handle(backing));
    let reused = open(&mut p, O_NONBLOCK);assert_eq!(reused, fd);let replacement = handle(&p, reused);assert_ne!(replacement, backing);
    crate::tmpfs::write(file, 0, b"pinned").unwrap();
    p.blocked_retries.activate(tid, token, BlockingRetryOperation::Read).unwrap();
    assert_eq!(sys_read(&mut p, &mut h, reused, &mut [0; 16]), Ok(16));p.blocked_retries.clear_active();
    assert_eq!(sys_read(&mut p, &mut h, reused, &mut [0; 16]), Err(Errno::EAGAIN));
    release_blocking_retry_binding(&mut p, &mut locks, &mut h, tid, token).unwrap();
    assert!(!fsnotify::is_live_handle(backing));assert!(fsnotify::is_live_handle(replacement));
    sys_close(&mut p, &mut h, reused).unwrap();set_test_current_tid(0);crate::tmpfs::release_handle(file);
}

#[test]
fn fsnotify_descriptor_scm_queue_holds_backing_after_sender_close() {
    let mut sender = Process::new(150);let mut receiver = Process::new(151);let mut h = MockHostIO::new();
    let path = b"/tmp/fsnotify_descriptor_scm";let file = source(path);let fd = open(&mut sender, O_NONBLOCK);
    let backing = handle(&sender, fd);let id = scm_rights_test_ofd_id(&sender, fd);
    fsnotify::watch_tmpfs_description(&sender, fd, path, MODIFY).unwrap();
    let queued = retain_fd_for_scm_rights(&sender, fd);sys_close(&mut sender, &mut h, fd).unwrap();assert!(fsnotify::is_live_handle(backing));
    let installed = install_scm_rights_fds_with_flags(&mut receiver, vec![queued], FD_CLOEXEC);assert_eq!(installed.len(), 1);let target = installed[0];
    assert_eq!(scm_rights_test_ofd_id(&receiver, target), id);assert_ne!(receiver.fd_table.get(target).unwrap().fd_flags & FD_CLOEXEC, 0);
    crate::tmpfs::write(file, 0, b"received").unwrap();assert_eq!(sys_read(&mut receiver, &mut h, target, &mut [0; 16]), Ok(16));
    sys_close(&mut receiver, &mut h, target).unwrap();assert!(!fsnotify::is_live_handle(backing));crate::tmpfs::release_handle(file);
}

#[test]
fn fsnotify_descriptor_fork_failure_does_not_publish_child_or_consume_task_id() {
    let mut table = crate::process_table::ProcessTable::new();let parent = table.create_process().unwrap();let mut h = MockHostIO::new();
    let fd = open(table.get_mut(parent).unwrap(), 0);let backing = handle(table.get(parent).unwrap(), fd);
    assert_eq!(table.fork_process_for_caller(parent, parent), Err(Errno::EOPNOTSUPP));
    assert_eq!(table.get(parent).unwrap().fork_count(), 0);assert!(fsnotify::is_live_handle(backing));
    assert_eq!(table.create_process().unwrap(), parent + 1);
    sys_close(table.get_mut(parent).unwrap(), &mut h, fd).unwrap();assert!(!fsnotify::is_live_handle(backing));
}

#[test]
fn fsnotify_descriptor_admission_refusal_does_not_publish_or_retain_owner() {
    let mut p = Process::new(152);let before = fsnotify::test_instance_count();
    assert_eq!(fsnotify::open_description(&mut p, 0x80, Limits { watches: 1, events: 1 }), Err(Errno::EINVAL));
    assert_eq!(fsnotify::open_description(&mut p, 0, Limits { watches: 0, events: 1 }), Err(Errno::EINVAL));
    assert_eq!(p.fd_table.iter().count(), 3);assert_eq!(p.ofd_table.iter().count(), 3);assert_eq!(fsnotify::test_instance_count(), before);
    sys_setrlimit(&mut p, wasm_posix_shared::rlimit::RLIMIT_NOFILE, 3, 3).unwrap();
    assert_eq!(fsnotify::open_description(&mut p, 0, Limits { watches: 1, events: 1 }), Err(Errno::EMFILE));assert_eq!(fsnotify::test_instance_count(), before);
    let mut q = Process::new(153);let used = crate::io_buffer::IO_MEMORY.usage().0;
    { let _budget = crate::io_buffer::test_budget(used);assert_eq!(fsnotify::open_description(&mut q, 0, Limits { watches: 1, events: 1 }), Err(Errno::ENOMEM)); }
    assert_eq!(q.fd_table.iter().count(), 3);assert_eq!(q.ofd_table.iter().count(), 3);assert_eq!(fsnotify::test_instance_count(), before);
}
