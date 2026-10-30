use super::*;
use crate::lock::AdvisoryLockManager;
use crate::process::test_host::NoopHost;
use crate::syscalls::*;
use alloc::vec;
use wasm_posix_shared::flags::*;

mod host;
use host::{IMAGE_HANDLE, PairHost, SOURCE_HANDLE};

struct NamespaceGuard(bool, bool);

impl NamespaceGuard {
    fn enter() -> Self {
        let guard = Self(
            crate::rootfs::set_enabled(true),
            crate::tmpfs::set_enabled(true),
        );
        crate::rootfs::reset();
        crate::rootfs::insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        guard
    }
}

impl Drop for NamespaceGuard {
    fn drop(&mut self) {
        crate::rootfs::reset();
        crate::rootfs::set_enabled(self.0);
        crate::tmpfs::set_enabled(self.1);
    }
}

fn install(proc: &mut Process, handle: i64, flags: u32, path: &[u8]) -> i32 {
    let index = proc
        .ofd_table
        .create(FileType::Regular, flags, handle, path.to_vec());
    proc.fd_table.alloc(OpenFileDescRef(index), 0).unwrap()
}

fn reference(proc: &Process, fd: i32) -> OpenFileDescRef {
    proc.fd_table.get(fd).unwrap().ofd_ref
}

fn tmp_pair(proc: &mut Process, name: &[u8]) -> (i32, i32, i64) {
    let mut source = b"/tmp/exec-pair-source-".to_vec();
    source.extend_from_slice(name);
    let mut image = b"/tmp/exec-pair-image-".to_vec();
    image.extend_from_slice(name);
    let source_handle = crate::tmpfs::open(&source, O_CREAT | O_RDWR, 0o750, 0, 0).unwrap();
    let image_handle = crate::tmpfs::open(&image, O_CREAT | O_RDWR, 0o600, 0, 0).unwrap();
    let source_fd = install(proc, source_handle, O_RDWR, &source);
    let image_fd = install(proc, image_handle, O_RDWR, &image);
    sys_write(proc, &mut NoopHost, source_fd, b"source").unwrap();
    sys_write(proc, &mut NoopHost, image_fd, b"derived code").unwrap();
    let handle = create(
        proc,
        reference(proc, source_fd),
        reference(proc, image_fd),
        &mut NoopHost,
    )
    .unwrap();
    (source_fd, image_fd, handle)
}

fn close_raw_pair(proc: &mut Process, source_fd: i32, image_fd: i32) {
    sys_close(proc, &mut NoopHost, source_fd).unwrap();
    sys_close(proc, &mut NoopHost, image_fd).unwrap();
}

#[test]
fn procfs_reopens_the_image_with_independent_cursors_and_live_source_permissions() {
    let _namespace = NamespaceGuard::enter();
    let mut proc = Process::new(100);
    let (source_fd, image_fd, handle) = tmp_pair(&mut proc, b"procfs");
    let source_handle = source_handle(handle).unwrap();
    let source_id = proc
        .ofd_table
        .get(reference(&proc, source_fd).0)
        .unwrap()
        .ofd_id;
    let image_stat = stat(handle, &mut NoopHost).unwrap();
    assert_eq!(image_stat.st_size, 12);
    assert_eq!(image_stat.st_mode & 0o777, 0o750);
    assert_ne!((image_stat.st_dev, image_stat.st_ino), {
        let source = crate::tmpfs::fstat(source_handle).unwrap();
        (source.st_dev, source.st_ino)
    });
    let index = proc.ofd_table.create(
        FileType::Regular,
        O_RDONLY,
        handle,
        b"/tmp/original-name".to_vec(),
    );
    proc.exe = Some(OpenFileDescRef(index));
    let first = sys_open(&mut proc, &mut NoopHost, b"/proc/self/exe", O_RDONLY, 0).unwrap();
    let second = sys_open(&mut proc, &mut NoopHost, b"/proc/self/exe", O_RDONLY, 0).unwrap();
    close_raw_pair(&mut proc, source_fd, image_fd);
    assert!(crate::ofd::has_in_flight_ofd(source_id));
    let mut bytes = [0; 7];
    assert_eq!(
        sys_read(&mut proc, &mut NoopHost, first, &mut bytes).unwrap(),
        7
    );
    assert_eq!(&bytes, b"derived");
    let duplicate = sys_dup(&mut proc, first).unwrap();
    assert_eq!(
        sys_lseek(&mut proc, &mut NoopHost, duplicate, 0, 1).unwrap(),
        7
    );
    assert_eq!(
        sys_lseek(&mut proc, &mut NoopHost, second, 0, 1).unwrap(),
        0
    );
    assert_eq!(
        sys_pread(&mut proc, &mut NoopHost, first, &mut bytes, 0).unwrap(),
        7
    );
    assert_eq!(sys_lseek(&mut proc, &mut NoopHost, first, 0, 1).unwrap(), 7);
    crate::tmpfs::fchmod(source_handle, 0o700).unwrap();
    assert_eq!(
        sys_fstat(&proc, &mut NoopHost, first).unwrap().st_mode & 0o777,
        0o700
    );
    let mut link = [0; 80];
    crate::tmpfs::unlink(b"/tmp/exec-pair-image-procfs").unwrap();
    let count = crate::procfs::procfs_readlink(
        &proc,
        &crate::procfs::ProcfsEntry::Exe(proc.pid),
        &mut link,
    )
    .unwrap();
    assert_eq!(&link[..count], b"/tmp/original-name");
    crate::tmpfs::unlink(b"/tmp/exec-pair-source-procfs").unwrap();
    let count = crate::procfs::procfs_readlink(
        &proc,
        &crate::procfs::ProcfsEntry::Exe(proc.pid),
        &mut link,
    )
    .unwrap();
    assert_eq!(&link[..count], b"/tmp/original-name (deleted)");
    sys_setresuid(&mut proc, 1000, 1000, 1000).unwrap();
    assert_eq!(
        sys_open(&mut proc, &mut NoopHost, b"/proc/self/exe", O_RDONLY, 0),
        Err(Errno::EACCES)
    );
    crate::exec_target::release_process_exe(
        &mut proc,
        &mut AdvisoryLockManager::new(),
        &mut NoopHost,
    );
    assert!(is_live(handle));
    assert_eq!(
        sys_read(&mut proc, &mut NoopHost, first, &mut bytes).unwrap(),
        5
    );
    assert_eq!(&bytes[..5], b" code");
    sys_close(&mut proc, &mut NoopHost, first).unwrap();
    sys_close(&mut proc, &mut NoopHost, duplicate).unwrap();
    assert!(is_live(handle));
    sys_close(&mut proc, &mut NoopHost, second).unwrap();
    assert!(!is_live(handle));
    assert!(!crate::ofd::has_in_flight_ofd(source_id));
}

#[test]
fn readonly_views_refuse_metadata_and_data_mutations_and_sync_the_image() {
    let mut proc = Process::new(100);
    let (source_fd, image_fd, handle) = tmp_pair(&mut proc, b"readonly");
    let fd = install(&mut proc, handle, O_RDONLY, b"/tmp/not-the-image");
    assert_eq!(
        sys_write(&mut proc, &mut NoopHost, fd, b"bad"),
        Err(Errno::EBADF)
    );
    assert_eq!(
        sys_pwrite(&mut proc, &mut NoopHost, fd, b"bad", 0),
        Err(Errno::EBADF)
    );
    assert_eq!(
        sys_ftruncate(&mut proc, &mut NoopHost, fd, 0),
        Err(Errno::EINVAL)
    );
    assert_eq!(
        sys_fchmod(&mut proc, &mut NoopHost, fd, 0o777),
        Err(Errno::EPERM)
    );
    assert_eq!(
        sys_fchown(&mut proc, &mut NoopHost, fd, 1, 1),
        Err(Errno::EPERM)
    );
    assert_eq!(
        sys_utimensat(&mut proc, &mut NoopHost, fd, b"", None, 0),
        Err(Errno::EPERM)
    );
    sys_fsync(&mut proc, &mut NoopHost, fd).unwrap();
    assert!(!syncfs_targets_rootfs(&proc, fd).unwrap());
    let expected = crate::tmpfs::statfs(b"/tmp").unwrap();
    assert_eq!(
        sys_fstatfs(&mut proc, &mut NoopHost, fd).unwrap().f_type,
        expected.f_type
    );
    close_raw_pair(&mut proc, source_fd, image_fd);
    sys_close(&mut proc, &mut NoopHost, fd).unwrap();
}

#[test]
fn same_size_image_mutation_is_not_mistaken_for_a_sealed_image() {
    let mut proc = Process::new(100);
    let (source_fd, image_fd, handle) = tmp_pair(&mut proc, b"drift");
    sys_pwrite(&mut proc, &mut NoopHost, image_fd, b"corrupt code", 0).unwrap();
    assert_eq!(
        read(handle, 0, &mut [0; 12], &mut NoopHost),
        Err(Errno::ETXTBSY)
    );
    assert!(matches!(stat(handle, &mut NoopHost), Err(Errno::ETXTBSY)));
    close_raw_pair(&mut proc, source_fd, image_fd);
    release(handle).close_with(&mut NoopHost).unwrap();
}

#[test]
fn mapping_pin_retains_both_constituents_without_allowing_new_descriptor_owners() {
    let mut proc = Process::new(100);
    let (source_fd, image_fd, handle) = tmp_pair(&mut proc, b"mapping");
    let source = source_handle(handle).unwrap();
    let image = image_handle(handle).unwrap();
    crate::tmpfs::unlink(b"/tmp/exec-pair-source-mapping").unwrap();
    crate::tmpfs::unlink(b"/tmp/exec-pair-image-mapping").unwrap();
    let source_id = proc
        .ofd_table
        .get(reference(&proc, source_fd).0)
        .unwrap()
        .ofd_id;
    crate::kernel_file_mapping::pin(handle).unwrap();
    close_raw_pair(&mut proc, source_fd, image_fd);
    let effects = release(handle);
    assert!(effects.final_ofd_reference);
    effects.close_with(&mut NoopHost).unwrap();
    assert!(!is_live(handle));
    assert_eq!(add_ref(handle), Err(Errno::EBADF));
    assert!(crate::ofd::has_in_flight_ofd(source_id));
    assert!(crate::tmpfs::fstat(source).is_ok());
    assert_eq!(
        crate::kernel_file_mapping::size_and_mode_with_io(handle, &mut NoopHost)
            .unwrap()
            .0,
        12
    );
    let mut bytes = [0; 12];
    assert_eq!(
        crate::kernel_file_mapping::pread(handle, 0, &mut bytes, &mut NoopHost).unwrap(),
        12
    );
    assert_eq!(&bytes, b"derived code");
    assert_eq!(
        crate::kernel_file_mapping::pwrite(handle, 0, b"bad", &mut NoopHost),
        Err(Errno::EPERM)
    );
    let _budget = crate::io_buffer::test_budget(crate::io_buffer::IO_MEMORY.usage().0);
    crate::kernel_file_mapping::unpin_with_io(handle, &mut NoopHost);
    assert!(!crate::ofd::has_in_flight_ofd(source_id));
    assert!(crate::tmpfs::fstat(source).is_err());
    assert!(crate::tmpfs::fstat(image).is_err());
}

#[test]
fn queued_rights_survive_sender_exit_and_transfer_the_same_cursor() {
    let mut table = crate::process_table::ProcessTable::new();
    let sender_pid = table.create_process().unwrap();
    let sender = table.get_mut(sender_pid).unwrap();
    let (source_fd, image_fd, handle) = tmp_pair(sender, b"transfer");
    let fd = install(sender, handle, O_RDONLY, b"/tmp/executable-transfer");
    let mut queued = snapshot_scm_rights_fd(sender, fd).unwrap();
    queued.retain_reference().unwrap();
    sys_lseek(sender, &mut NoopHost, fd, 8, 0).unwrap();
    close_raw_pair(sender, source_fd, image_fd);
    assert_eq!(
        table.remove_process(sender_pid).unwrap().host_closes,
        vec![0, 1, 2]
    );
    assert!(is_live(handle));
    let mut receiver = Process::new(200);
    let fds = install_scm_rights_fds(&mut receiver, vec![queued]);
    assert_eq!(fds.len(), 1);
    let mut bytes = [0; 4];
    assert_eq!(
        sys_read(&mut receiver, &mut NoopHost, fds[0], &mut bytes).unwrap(),
        4
    );
    assert_eq!(&bytes, b"code");
    sys_close(&mut receiver, &mut NoopHost, fds[0]).unwrap();
    assert!(!is_live(handle));
}

#[test]
fn discarded_rights_release_the_final_pair_at_the_io_aware_drain() {
    let mut proc = Process::new(100);
    let (source_fd, image_fd, handle) = tmp_pair(&mut proc, b"discard");
    let fd = install(&mut proc, handle, O_RDONLY, b"/tmp/executable-discard");
    let mut queued = snapshot_scm_rights_fd(&proc, fd).unwrap();
    queued.retain_reference().unwrap();
    close_raw_pair(&mut proc, source_fd, image_fd);
    sys_close(&mut proc, &mut NoopHost, fd).unwrap();
    drop(queued);
    assert!(is_live(handle));
    let _budget = crate::io_buffer::test_budget(crate::io_buffer::IO_MEMORY.usage().0);
    drain_deferred_scm_rights_releases(&mut AdvisoryLockManager::new(), &mut NoopHost);
    assert!(!is_live(handle));
}

#[test]
fn forked_pair_references_are_released_after_both_processes_exit() {
    let mut table = crate::process_table::ProcessTable::new();
    let parent_pid = table.create_process().unwrap();
    let parent = table.get_mut(parent_pid).unwrap();
    let (source_fd, image_fd, handle) = tmp_pair(parent, b"fork");
    let fd = install(parent, handle, O_RDONLY, b"/tmp/executable-fork");
    close_raw_pair(parent, source_fd, image_fd);
    let child_pid = table
        .fork_process_for_caller(parent_pid, parent_pid)
        .unwrap();
    table.remove_process(parent_pid).unwrap();
    assert!(is_live(handle));
    let child = table.get_mut(child_pid).unwrap();
    let mut bytes = [0; 7];
    sys_read(child, &mut NoopHost, fd, &mut bytes).unwrap();
    assert_eq!(&bytes, b"derived");
    table.remove_process(child_pid).unwrap();
    assert!(!is_live(handle));
}

#[test]
fn both_host_closes_are_consumed_even_when_the_first_one_fails() {
    let mut proc = Process::new(100);
    let mut host = PairHost::new();
    let source_fd = install(&mut proc, SOURCE_HANDLE, O_RDONLY, b"/source");
    let image_fd = install(&mut proc, IMAGE_HANDLE, O_RDONLY, b"/image");
    let handle = create(
        &proc,
        reference(&proc, source_fd),
        reference(&proc, image_fd),
        &mut host,
    )
    .unwrap();
    let fd = install(&mut proc, handle, O_RDONLY, b"/source");
    sys_close(&mut proc, &mut host, source_fd).unwrap();
    sys_close(&mut proc, &mut host, image_fd).unwrap();
    assert!(host.closed.is_empty());
    assert_eq!(sys_pread(&mut proc, &mut host, fd, &mut [0; 7], 0), Ok(7));
    sys_fsync(&mut proc, &mut host, fd).unwrap();
    assert_eq!(host.synced, vec![IMAGE_HANDLE]);
    host.fail_close = Some(SOURCE_HANDLE);
    let _budget = crate::io_buffer::test_budget(crate::io_buffer::IO_MEMORY.usage().0);
    assert_eq!(sys_close(&mut proc, &mut host, fd), Err(Errno::EIO));
    assert_eq!(host.closed, vec![SOURCE_HANDLE, IMAGE_HANDLE]);
    assert!(!is_live(handle));
}

#[test]
fn aliased_raw_constituents_own_two_references_but_close_one_host_handle() {
    let mut proc = Process::new(100);
    let mut host = PairHost::new();
    let source_fd = install(&mut proc, SOURCE_HANDLE, O_RDONLY, b"/source");
    let source = reference(&proc, source_fd);
    let handle = create(&proc, source, source, &mut host).unwrap();
    sys_close(&mut proc, &mut host, source_fd).unwrap();
    assert!(host.closed.is_empty());
    release(handle).close_with(&mut host).unwrap();
    assert_eq!(host.closed, vec![SOURCE_HANDLE]);
}

#[test]
fn refusal_during_later_retains_rolls_back_prior_references_and_the_pair_slot() {
    for retain_image in [false, true] {
        let mut proc = Process::new(100);
        let mut host = PairHost::new();
        let source_fd = install(&mut proc, SOURCE_HANDLE, O_RDONLY, b"/source");
        let image_fd = install(&mut proc, IMAGE_HANDLE, O_RDONLY, b"/image");
        let source = reference(&proc, source_fd);
        let image = reference(&proc, image_fd);
        let warm = create(&proc, source, image, &mut host).unwrap();
        release(warm).close_with(&mut host).unwrap();
        crate::ofd::host_handle_fork_ref(SOURCE_HANDLE).unwrap();
        if retain_image {
            crate::ofd::host_handle_fork_ref(IMAGE_HANDLE).unwrap();
        }
        {
            let _budget = crate::io_buffer::test_budget(crate::io_buffer::IO_MEMORY.usage().0);
            assert_eq!(create(&proc, source, image, &mut host), Err(Errno::ENOMEM));
        }
        assert!(!is_live(warm));
        assert!(host.closed.is_empty());
        sys_close(&mut proc, &mut host, image_fd).unwrap();
        sys_close(&mut proc, &mut host, source_fd).unwrap();
        if retain_image {
            assert!(host.closed.is_empty());
            assert!(crate::ofd::host_handle_close_ref(IMAGE_HANDLE));
            host.host_close(IMAGE_HANDLE).unwrap();
        } else {
            assert_eq!(host.closed, vec![IMAGE_HANDLE]);
        }
        assert!(crate::ofd::host_handle_close_ref(SOURCE_HANDLE));
        host.host_close(SOURCE_HANDLE).unwrap();
    }
}

#[test]
fn discarding_one_description_drops_its_locks_while_an_independent_pair_open_lives() {
    use crate::lock::{AdvisoryLockType, FileId, LockOwner, LockRange};
    let mut table = crate::process_table::ProcessTable::new();
    let pid = table.create_process().unwrap();
    let proc = table.get_mut(pid).unwrap();
    let (source_fd, image_fd, handle) = tmp_pair(proc, b"queued-lock");
    let fd = install(proc, handle, O_RDONLY, b"/tmp/executable-lock");
    add_ref(handle).unwrap();
    let independent = install(proc, handle, O_RDONLY, b"/tmp/executable-lock");
    let ofd_id = proc.ofd_table.get(reference(proc, fd).0).unwrap().ofd_id;
    let mut queued = snapshot_scm_rights_fd(proc, fd).unwrap();
    queued.retain_reference().unwrap();
    close_raw_pair(proc, source_fd, image_fd);
    table
        .advisory_locks_mut()
        .set_lock(
            FileId::Host {
                dev: 8,
                ino: index(handle).unwrap() as u64 + 1,
            },
            LockOwner::OpenFileDescription(ofd_id),
            Some(AdvisoryLockType::Read),
            LockRange::normalize(0, 0).unwrap(),
        )
        .unwrap();
    let (proc, locks) = table.process_and_advisory_locks(pid).unwrap();
    sys_close_with_locks(proc, locks, &mut NoopHost, fd).unwrap();
    table.release_orphaned_ofd_locks();
    assert_eq!(table.advisory_locks().len(), 1);
    drop(queued);
    drain_deferred_scm_rights_releases(table.advisory_locks_mut(), &mut NoopHost);
    table.release_orphaned_ofd_locks();
    assert!(table.advisory_locks().is_empty());
    assert!(is_live(handle));
    let proc = table.get_mut(pid).unwrap();
    sys_close(proc, &mut NoopHost, independent).unwrap();
    table.remove_process(pid).unwrap();
    assert!(!is_live(handle));
}

#[test]
fn a_host_pair_pinned_only_by_a_mapping_closes_both_raw_handles_at_final_unpin() {
    let mut proc = Process::new(100);
    let mut host = PairHost::new();
    let source_fd = install(&mut proc, SOURCE_HANDLE, O_RDONLY, b"/source");
    let image_fd = install(&mut proc, IMAGE_HANDLE, O_RDONLY, b"/image");
    let handle = create(
        &proc,
        reference(&proc, source_fd),
        reference(&proc, image_fd),
        &mut host,
    )
    .unwrap();
    crate::kernel_file_mapping::pin(handle).unwrap();
    sys_close(&mut proc, &mut host, source_fd).unwrap();
    sys_close(&mut proc, &mut host, image_fd).unwrap();
    release(handle).close_with(&mut host).unwrap();
    assert!(host.closed.is_empty());
    assert_eq!(crate::kernel_file_mapping::content_generation(handle), None);
    let mut bytes = [0; 7];
    assert_eq!(
        crate::kernel_file_mapping::pread(handle, 0, &mut bytes, &mut host),
        Ok(7)
    );
    assert_eq!(&bytes, b"derived");
    host.fail_close = Some(SOURCE_HANDLE);
    let _budget = crate::io_buffer::test_budget(crate::io_buffer::IO_MEMORY.usage().0);
    crate::kernel_file_mapping::unpin_with_io(handle, &mut host);
    assert_eq!(host.closed, vec![SOURCE_HANDLE, IMAGE_HANDLE]);
    assert!(matches!(stat(handle, &mut host), Err(Errno::EBADF)));
}

#[test]
fn pairing_rejects_nested_nonregular_and_unreadable_descriptions_without_retaining() {
    let mut proc = Process::new(100);
    let (source_fd, image_fd, handle) = tmp_pair(&mut proc, b"admission");
    let source = reference(&proc, source_fd);
    let image = reference(&proc, image_fd);
    let nested = install(&mut proc, handle, O_RDONLY, b"/nested");
    assert_eq!(
        create(&proc, reference(&proc, nested), image, &mut NoopHost),
        Err(Errno::EBADF)
    );
    assert_eq!(
        create(&proc, source, reference(&proc, nested), &mut NoopHost),
        Err(Errno::EBADF)
    );
    proc.ofd_table
        .get(source.0)
        .unwrap()
        .set_status_flags_raw(O_WRONLY);
    assert_eq!(
        create(&proc, source, image, &mut NoopHost),
        Err(Errno::EBADF)
    );
    proc.ofd_table
        .get(source.0)
        .unwrap()
        .set_status_flags_raw(O_PATH);
    assert_eq!(
        create(&proc, source, image, &mut NoopHost),
        Err(Errno::EBADF)
    );
    proc.ofd_table
        .get(source.0)
        .unwrap()
        .set_status_flags_raw(O_RDONLY);
    proc.ofd_table.get_mut(image.0).unwrap().file_type = FileType::Directory;
    assert_eq!(
        create(&proc, source, image, &mut NoopHost),
        Err(Errno::EBADF)
    );
    proc.ofd_table.get_mut(image.0).unwrap().file_type = FileType::Regular;
    close_raw_pair(&mut proc, source_fd, image_fd);
    sys_close(&mut proc, &mut NoopHost, nested).unwrap();
    assert!(!is_live(handle));
}

#[test]
fn forced_removal_releases_hidden_source_locks_without_another_dispatch() {
    use crate::lock::{AdvisoryLockType, FileId, LockOwner, LockRange};
    let mut table = crate::process_table::ProcessTable::new();
    let pid = table.create_process().unwrap();
    let proc = table.get_mut(pid).unwrap();
    let (source_fd, _, handle) = tmp_pair(proc, b"source-lock");
    let ofd_id = proc
        .ofd_table
        .get(reference(proc, source_fd).0)
        .unwrap()
        .ofd_id;
    let source = crate::tmpfs::fstat(source_handle(handle).unwrap()).unwrap();
    install(proc, handle, O_RDONLY, b"/tmp/executable-source-lock");
    table
        .advisory_locks_mut()
        .set_lock(
            FileId::Host {
                dev: source.st_dev,
                ino: source.st_ino,
            },
            LockOwner::OpenFileDescription(ofd_id),
            Some(AdvisoryLockType::Read),
            LockRange::normalize(0, 0).unwrap(),
        )
        .unwrap();
    assert!(crate::ofd::has_in_flight_ofd(ofd_id));
    let mut wakes = [0; 128];
    while crate::wakeup::drain(&mut wakes, 25) != 0 {}
    table.remove_process(pid).unwrap();
    assert!(table.advisory_locks().is_empty());
    assert!(!crate::ofd::has_in_flight_ofd(ofd_id));
    assert!(!is_live(handle));
    let count = crate::wakeup::drain(&mut wakes, 25) as usize;
    assert!(
        wakes[..count * wasm_posix_shared::wakeup_event_wire::RECORD_BYTES]
            .chunks_exact(wasm_posix_shared::wakeup_event_wire::RECORD_BYTES)
            .any(|record| record[4] == wasm_posix_shared::wakeup_event_wire::TYPE_ADVISORY_LOCK)
    );
}

#[test]
fn inheritance_rollback_does_not_release_the_parents_pair_or_leave_a_child_reference() {
    let mut parent = Process::new(100);
    let (source_fd, image_fd, handle) = tmp_pair(&mut parent, b"rollback");
    let fd = install(&mut parent, handle, O_RDONLY, b"/tmp/executable-rollback");
    let mut child = Process::new(200);
    install(&mut child, handle, O_RDONLY, b"/tmp/executable-rollback");
    child
        .ofd_table
        .create(FileType::EventFd, O_RDONLY, -999_999, b"".to_vec());
    assert_eq!(
        crate::process_table::bump_inherited_resource_refcounts(parent.pid, &child),
        Err(Errno::EBADF)
    );
    assert!(is_live(handle));
    close_raw_pair(&mut parent, source_fd, image_fd);
    sys_close(&mut parent, &mut NoopHost, fd).unwrap();
    assert!(!is_live(handle));
}
