use super::*;
use crate::fsnotify::{self, Limits, OPEN, ACCESS, MODIFY, CLOSE_WRITE, CLOSE_NOWRITE};
const EVENTS: u32 = OPEN | ACCESS | MODIFY | CLOSE_WRITE | CLOSE_NOWRITE;
fn watch(p: &mut Process, path: &[u8]) -> i32 {
    let fd = fsnotify::open_description(p, O_NONBLOCK, Limits { watches: 16, events: 64 }).unwrap();
    fsnotify::watch_tmpfs_description(p, fd, path, EVENTS).unwrap();fd
}
fn drain(p: &mut Process, h: &mut MockHostIO, fd: i32) -> Vec<(u32, Vec<u8>)> {
    let mut bytes = [0; 4096];let n = match sys_read(p, h, fd, &mut bytes) { Ok(n) => n, Err(Errno::EAGAIN) => return vec![], other => panic!("notification read: {other:?}") };
    let mut out = Vec::new();let mut offset = 0;
    while offset < n {
        let mask = u32::from_le_bytes(bytes[offset+4..offset+8].try_into().unwrap());
        let len = u32::from_le_bytes(bytes[offset+12..offset+16].try_into().unwrap()) as usize;
        let name = &bytes[offset+16..offset+16+len];let end = name.iter().position(|b| *b == 0).unwrap_or(name.len());
        out.push((mask, name[..end].to_vec()));offset += 16 + len;
    }
    assert_eq!(offset, n);out
}
fn seed(path: &[u8], data: &[u8]) {
    let handle = crate::tmpfs::open(path, O_CREAT | O_RDWR, 0o600, 0, 0).unwrap();
    crate::tmpfs::write(handle, 0, data).unwrap();crate::tmpfs::release_handle(handle);
}
#[test]
fn opened_dentry_actual_syscalls_emit_and_dup_waits_for_last_description_owner() {
    let _tmpfs = TmpfsEnableGuard(crate::tmpfs::set_enabled(true));
    let mut p = Process::new(170);let mut h = MockHostIO::new();let dir = b"/tmp/dentry_events";
    crate::tmpfs::mkdir(dir, 0o700, 0, 0).unwrap();seed(b"/tmp/dentry_events/file", b"value");let notify = watch(&mut p, dir);
    let fd = sys_open(&mut p, &mut h, b"/tmp/dentry_events/file", O_RDWR, 0).unwrap();
    assert_eq!(drain(&mut p, &mut h, notify), [(OPEN, b"file".to_vec())]);
    let alias = sys_dup(&mut p, fd).unwrap();assert!(drain(&mut p, &mut h, notify).is_empty());
    assert_eq!(sys_read(&mut p, &mut h, alias, &mut [0; 1]), Ok(1));
    assert_eq!(drain(&mut p, &mut h, notify), [(ACCESS, b"file".to_vec())]);
    assert_eq!(sys_write(&mut p, &mut h, fd, b"x"), Ok(1));
    assert_eq!(drain(&mut p, &mut h, notify), [(MODIFY, b"file".to_vec())]);
    assert_eq!(sys_pread(&mut p, &mut h, fd, &mut [0; 1], 0), Ok(1));
    assert_eq!(drain(&mut p, &mut h, notify), [(ACCESS, b"file".to_vec())]);
    assert_eq!(sys_pwrite(&mut p, &mut h, fd, b"y", 0), Ok(1));
    assert_eq!(drain(&mut p, &mut h, notify), [(MODIFY, b"file".to_vec())]);
    sys_read(&mut p, &mut h, fd, &mut []).unwrap();sys_write(&mut p, &mut h, fd, b"").unwrap();
    assert!(drain(&mut p, &mut h, notify).is_empty());
    sys_close(&mut p, &mut h, fd).unwrap();assert!(drain(&mut p, &mut h, notify).is_empty());
    sys_close(&mut p, &mut h, alias).unwrap();assert_eq!(drain(&mut p, &mut h, notify), [(CLOSE_WRITE, b"file".to_vec())]);
    let path_only = sys_open(&mut p, &mut h, b"/tmp/dentry_events/file", O_PATH, 0).unwrap();
    sys_close(&mut p, &mut h, path_only).unwrap();assert!(drain(&mut p, &mut h, notify).is_empty());

    sys_close(&mut p, &mut h, notify).unwrap();
}
#[test]
fn opened_dentry_hardlink_rename_unlink_and_name_reuse_follow_exact_entry() {
    let _tmpfs = TmpfsEnableGuard(crate::tmpfs::set_enabled(true));
    let mut p = Process::new(171);let mut h = MockHostIO::new();
    crate::tmpfs::mkdir(b"/tmp/dentry_a", 0o700, 0, 0).unwrap();crate::tmpfs::mkdir(b"/tmp/dentry_b", 0o700, 0, 0).unwrap();
    seed(b"/tmp/dentry_a/original", b"old");crate::tmpfs::link(b"/tmp/dentry_a/original", b"/tmp/dentry_a/alias").unwrap();
    let a = watch(&mut p, b"/tmp/dentry_a");let b = watch(&mut p, b"/tmp/dentry_b");
    let moved = sys_open(&mut p, &mut h, b"/tmp/dentry_a/original", O_RDWR, 0).unwrap();
    let alias = sys_open(&mut p, &mut h, b"/tmp/dentry_a/alias", O_RDWR, 0).unwrap();drain(&mut p, &mut h, a);
    crate::tmpfs::rename(b"/tmp/dentry_a/original", b"/tmp/dentry_b/renamed").unwrap();
    sys_pwrite(&mut p, &mut h, moved, b"m", 0).unwrap();assert_eq!(drain(&mut p, &mut h, b), [(MODIFY, b"renamed".to_vec())]);assert!(drain(&mut p, &mut h, a).is_empty());
    sys_pwrite(&mut p, &mut h, alias, b"a", 0).unwrap();assert_eq!(drain(&mut p, &mut h, a), [(MODIFY, b"alias".to_vec())]);
    crate::tmpfs::unlink(b"/tmp/dentry_b/renamed").unwrap();seed(b"/tmp/dentry_b/renamed", b"new");
    let fresh = sys_open(&mut p, &mut h, b"/tmp/dentry_b/renamed", O_RDONLY, 0).unwrap();drain(&mut p, &mut h, b);
    let mut old = [0; 3];sys_pread(&mut p, &mut h, moved, &mut old, 0).unwrap();assert_eq!(&old, b"ald");
    assert_eq!(drain(&mut p, &mut h, b), [(ACCESS, b"renamed".to_vec())]);
    sys_close(&mut p, &mut h, moved).unwrap();assert_eq!(drain(&mut p, &mut h, b), [(CLOSE_WRITE, b"renamed".to_vec())]);
    sys_close(&mut p, &mut h, fresh).unwrap();assert_eq!(drain(&mut p, &mut h, b), [(CLOSE_NOWRITE, b"renamed".to_vec())]);
    sys_close(&mut p, &mut h, alias).unwrap();assert_eq!(drain(&mut p, &mut h, a), [(CLOSE_WRITE, b"alias".to_vec())]);
    for fd in [a,b] { sys_close(&mut p, &mut h, fd).unwrap(); }
}
#[test]
fn opened_dentry_rename_over_open_hardlink_keeps_replaced_inode_and_alias() {
    let _tmpfs = TmpfsEnableGuard(crate::tmpfs::set_enabled(true));let mut p = Process::new(172);let mut h = MockHostIO::new();
    crate::tmpfs::mkdir(b"/tmp/dentry_replace", 0o700, 0, 0).unwrap();seed(b"/tmp/dentry_replace/source", b"source");seed(b"/tmp/dentry_replace/dest", b"dest");
    crate::tmpfs::link(b"/tmp/dentry_replace/dest", b"/tmp/dentry_replace/alias").unwrap();let notify = watch(&mut p, b"/tmp/dentry_replace");
    let fd = sys_open(&mut p, &mut h, b"/tmp/dentry_replace/dest", O_RDONLY, 0).unwrap();drain(&mut p, &mut h, notify);
    crate::tmpfs::rename(b"/tmp/dentry_replace/source", b"/tmp/dentry_replace/dest").unwrap();
    assert_eq!(crate::tmpfs::lstat(b"/tmp/dentry_replace/alias").unwrap().st_nlink, 1);
    let mut out = [0; 4];sys_read(&mut p, &mut h, fd, &mut out).unwrap();assert_eq!(&out, b"dest");
    assert_eq!(drain(&mut p, &mut h, notify), [(ACCESS, b"dest".to_vec())]);
    sys_close(&mut p, &mut h, fd).unwrap();assert_eq!(drain(&mut p, &mut h, notify), [(CLOSE_NOWRITE, b"dest".to_vec())]);
    assert_eq!(crate::tmpfs::lstat(b"/tmp/dentry_replace/alias").unwrap().st_size, 4);sys_close(&mut p, &mut h, notify).unwrap();
}
#[test]
fn opened_dentry_scm_retains_description_and_exec_does_not_reopen() {
    let _tmpfs = TmpfsEnableGuard(crate::tmpfs::set_enabled(true));let mut p = Process::new(173);let mut q = Process::new(174);let mut h = MockHostIO::new();
    crate::tmpfs::mkdir(b"/tmp/dentry_scm", 0o700, 0, 0).unwrap();seed(b"/tmp/dentry_scm/file", b"x");let notify = watch(&mut p, b"/tmp/dentry_scm");
    let fd = sys_open(&mut p, &mut h, b"/tmp/dentry_scm/file", O_RDONLY, 0).unwrap();drain(&mut p, &mut h, notify);
    let queued = retain_fd_for_scm_rights(&p, fd);sys_close(&mut p, &mut h, fd).unwrap();assert!(drain(&mut p, &mut h, notify).is_empty());
    let installed = install_scm_rights_fds_with_flags(&mut q, vec![queued], 0)[0];
    sys_read(&mut q, &mut h, installed, &mut [0;1]).unwrap();assert_eq!(drain(&mut p, &mut h, notify), [(ACCESS,b"file".to_vec())]);
    let pid = q.pid;commit_exec_state(&mut q, &mut h, pid).unwrap();assert!(drain(&mut p, &mut h, notify).is_empty());
    sys_close(&mut q, &mut h, installed).unwrap();assert_eq!(drain(&mut p, &mut h, notify), [(CLOSE_NOWRITE,b"file".to_vec())]);sys_close(&mut p, &mut h, notify).unwrap();
}
#[test]
fn opened_dentry_fork_relinks_owner_without_changing_frozen_wire() {
    let _tmpfs = TmpfsEnableGuard(crate::tmpfs::set_enabled(true));let mut table = crate::process_table::ProcessTable::new();let parent = table.create_process().unwrap();let mut h = MockHostIO::new();
    crate::tmpfs::mkdir(b"/tmp/dentry_fork", 0o700, 0, 0).unwrap();seed(b"/tmp/dentry_fork/file", b"x");let p = table.get_mut(parent).unwrap();let notify = watch(p, b"/tmp/dentry_fork");
    sys_fcntl(p, notify, F_SETFD, wasm_posix_shared::fd_flags::FD_CLOFORK).unwrap();let fd = sys_open(p, &mut h, b"/tmp/dentry_fork/file", O_RDONLY, 0).unwrap();drain(p, &mut h, notify);
    let child = table.fork_process_for_caller(parent, parent).unwrap();
    sys_read(table.get_mut(child).unwrap(), &mut h, fd, &mut [0;1]).unwrap();assert_eq!(drain(table.get_mut(parent).unwrap(), &mut h, notify), [(ACCESS,b"file".to_vec())]);
    sys_close(table.get_mut(child).unwrap(), &mut h, fd).unwrap();assert!(drain(table.get_mut(parent).unwrap(), &mut h, notify).is_empty());
    sys_close(table.get_mut(parent).unwrap(), &mut h, fd).unwrap();assert_eq!(drain(table.get_mut(parent).unwrap(), &mut h, notify), [(CLOSE_NOWRITE,b"file".to_vec())]);sys_close(table.get_mut(parent).unwrap(), &mut h, notify).unwrap();
}
#[test]
fn opened_dentry_failed_fd_admission_precedes_truncation_or_publication() {
    let _tmpfs = TmpfsEnableGuard(crate::tmpfs::set_enabled(true));let mut p = Process::new(175);let mut h = MockHostIO::new();
    crate::tmpfs::mkdir(b"/tmp/dentry_refuse", 0o700, 0, 0).unwrap();seed(b"/tmp/dentry_refuse/file", b"stable");let notify = watch(&mut p, b"/tmp/dentry_refuse");
    sys_setrlimit(&mut p, wasm_posix_shared::rlimit::RLIMIT_NOFILE, 4, 4).unwrap();
    assert_eq!(sys_open(&mut p, &mut h, b"/tmp/dentry_refuse/file", O_RDWR | O_TRUNC, 0), Err(Errno::EMFILE));
    assert_eq!(crate::tmpfs::lstat(b"/tmp/dentry_refuse/file").unwrap().st_size, 6);assert!(drain(&mut p, &mut h, notify).is_empty());sys_close(&mut p, &mut h, notify).unwrap();
}

#[test]
fn opened_dentry_memory_admission_precedes_existing_inode_truncation() {
    // Exercise the consumed provider reservation independently of earlier fd/OFD
    // admission: fill real retained slots, then deny the next actual growth.
    let (baseline, capacity) = crate::tmpfs::test_opened_slots();assert_eq!(baseline, 0);
    let mut owned = Vec::new();let path = b"/tmp/dentry_memory_refuse";seed(path, b"stable");
    for index in 0..capacity {
        let name = alloc::format!("/tmp/dentry_memory_fill_{index}");seed(name.as_bytes(), b"x");
        owned.push(crate::tmpfs::open_with_dentry(name.as_bytes(), O_RDONLY, 0, 0, 0).unwrap());
    }
    assert_eq!(crate::tmpfs::test_opened_slots(), (capacity, capacity));
    let used = crate::io_buffer::IO_MEMORY.usage().0;
    { let _budget = crate::io_buffer::test_budget(used);
      assert!(matches!(crate::tmpfs::open_with_dentry(path, O_RDWR | O_TRUNC, 0, 0, 0), Err(Errno::ENOMEM))); }
    assert_eq!(crate::tmpfs::lstat(path).unwrap().st_size, 6);assert_eq!(crate::tmpfs::test_opened_slots().0, capacity);
    for (handle, dentry) in owned { drop(dentry);crate::tmpfs::release_handle(handle); }
    assert_eq!(crate::tmpfs::test_opened_slots().0, 0);
}

#[test]
fn opened_dentry_independent_opens_share_entry_but_have_distinct_close_owners() {
    let _tmpfs = TmpfsEnableGuard(crate::tmpfs::set_enabled(true));let mut p = Process::new(176);let mut h = MockHostIO::new();
    crate::tmpfs::mkdir(b"/tmp/dentry_two_opens", 0o700, 0, 0).unwrap();seed(b"/tmp/dentry_two_opens/old", b"x");let notify = watch(&mut p, b"/tmp/dentry_two_opens");
    let one = sys_open(&mut p, &mut h, b"/tmp/dentry_two_opens/old", O_RDONLY, 0).unwrap();assert_eq!(drain(&mut p, &mut h, notify), [(OPEN,b"old".to_vec())]);
    let two = sys_open(&mut p, &mut h, b"/tmp/dentry_two_opens/old", O_RDWR, 0).unwrap();assert_eq!(drain(&mut p, &mut h, notify), [(OPEN,b"old".to_vec())]);
    sys_close(&mut p, &mut h, one).unwrap();assert_eq!(drain(&mut p, &mut h, notify), [(CLOSE_NOWRITE,b"old".to_vec())]);
    crate::tmpfs::rename(b"/tmp/dentry_two_opens/old", b"/tmp/dentry_two_opens/new").unwrap();
    sys_pwrite(&mut p, &mut h, two, b"y", 0).unwrap();assert_eq!(drain(&mut p, &mut h, notify), [(MODIFY,b"new".to_vec())]);
    sys_ftruncate(&mut p, &mut h, two, 0).unwrap();assert_eq!(drain(&mut p, &mut h, notify), [(MODIFY,b"new".to_vec())]);
    sys_close(&mut p, &mut h, two).unwrap();assert_eq!(drain(&mut p, &mut h, notify), [(CLOSE_WRITE,b"new".to_vec())]);sys_close(&mut p, &mut h, notify).unwrap();
}
