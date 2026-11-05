use super::*;
use crate::process::test_host::NoopHost;
use crate::program_preparation::{PreparationLimits, PreparationProfile};
use crate::syscalls::*;
use alloc::{vec, vec::Vec};
use sha2::{Digest, Sha256};
use wasm_posix_shared::flags::*;
use wasm_posix_shared::mode::{S_ISGID, S_ISUID};

mod host;

const ORIGINAL: &[u8] = include_bytes!("../../../../../abi/program-fixtures/v55/raw-fork.wasm");

#[test]
fn initial_exec_commits_the_retained_path_once_after_complete_observation() {
    let _namespace = NamespaceGuard::enter();
    let mut proc = Process::new(100);
    let mut locks = AdvisoryLockManager::new();
    let source = include_bytes!("../../../../../abi/program-fixtures/v55/echo.wasm");
    let descriptor = install(&mut proc, b"/source", source);
    let owner = PreparedExecOwner::Process { pid: 100, caller_tid: 100, generation: 0 };
    let token = prepare(&mut proc, &mut locks, &mut NoopHost, owner, AT_FDCWD, b"/source", 0).unwrap();
    sys_unlink(&mut proc, &mut NoopHost, b"/source").unwrap();
    install(&mut proc, b"/source", ORIGINAL);
    assert_eq!(observe(&mut proc, &mut NoopHost, token), source);
    assert!(matches!(admit(&proc, 100, token, 55), Ok(Admission::Program)));
    commit_initial(&mut proc, &mut locks, &mut NoopHost, 100, token).unwrap();
    assert_eq!(proc.exec_generation, 1);
    assert!(proc.exe.is_some());
    assert_eq!(proc.pointer_width, 4);
    assert!(proc.fd_table.get(descriptor).is_err());
    assert_eq!(commit_initial(&mut proc, &mut locks, &mut NoopHost, 100, token), Err(Errno::EINVAL));
    release_process_exe(&mut proc, &mut locks, &mut NoopHost);
}

#[test]
fn initial_exec_refuses_incomplete_stale_registered_spawn_or_wrong_thread_targets() {
    let _namespace = NamespaceGuard::enter();
    for case in 0..6 {
        let mut proc = Process::new(100);
        let mut locks = AdvisoryLockManager::new();
        let descriptor = install(&mut proc, b"/source", ORIGINAL);
        let owner = if case == 5 {
            PreparedExecOwner::Process { pid: 100, caller_tid: 101, generation: 0 }
        } else {
            PreparedExecOwner::Process { pid: 100, caller_tid: 100, generation: 0 }
        };
        let token = prepare(&mut proc, &mut locks, &mut NoopHost, owner, AT_FDCWD, b"/source", 0).unwrap();
        if case != 0 { observe(&mut proc, &mut NoopHost, token); }
        match case {
            1 => proc.exec_generation = 1,
            2 => proc.main_channel_addr = 128,
            3 => proc.spawn_publication_pending = true,
            4 => attach_exe_path(&mut proc, &mut locks, &mut NoopHost, b"/source").unwrap(),
            _ => {},
        }
        let previous_exe = proc.exe;
        assert!(commit_initial(&mut proc, &mut locks, &mut NoopHost, 100, token).is_err());
        assert_eq!(proc.exe, previous_exe);
        assert!(proc.fd_table.get(descriptor).is_ok());
        assert!(proc.prepared_exec_targets.is_empty());
        release_process_exe(&mut proc, &mut locks, &mut NoopHost);
        sys_close(&mut proc, &mut NoopHost, descriptor).unwrap();
    }
}

#[test]
fn initial_exec_rechecks_permissions_if_launch_credentials_changed() {
    let _namespace = NamespaceGuard::enter();
    let mut proc = Process::new(100);
    let mut locks = AdvisoryLockManager::new();
    install(&mut proc, b"/source", ORIGINAL);
    sys_chmod(&mut proc, &mut NoopHost, b"/source", 0o700).unwrap();
    let owner = PreparedExecOwner::Process { pid: 100, caller_tid: 100, generation: 0 };
    let token = prepare(&mut proc, &mut locks, &mut NoopHost, owner, AT_FDCWD, b"/source", 0).unwrap();
    observe(&mut proc, &mut NoopHost, token);
    sys_setuid(&mut proc, 1000).unwrap();
    assert_eq!(commit_initial(&mut proc, &mut locks, &mut NoopHost, 100, token), Err(Errno::EACCES));
    assert_eq!(proc.exec_generation, 0);
    assert!(proc.exe.is_none());
}

struct NamespaceGuard(bool, bool);

impl NamespaceGuard {
    fn enter() -> Self {
        let guard = Self(
            crate::rootfs::set_enabled(true),
            crate::tmpfs::set_enabled(true),
        );
        crate::rootfs::reset();
        let _ = crate::tmpfs::unlink(b"/tmp/source");
        let _ = crate::tmpfs::unlink(b"/tmp/image");
        crate::rootfs::insert_base_dir(b"/", 0o755, 0, 0, 1).unwrap();
        crate::rootfs::insert_base_dir(b"/tmp", 0o1777, 0, 0, 2).unwrap();
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

fn append_section(bytes: &[u8], name: &[u8], data: &[u8]) -> Vec<u8> {
    fn append_length(bytes: &mut Vec<u8>, mut length: usize) {
        loop {
            let value = (length & 127) as u8;
            length >>= 7;
            bytes.push(value | if length == 0 { 0 } else { 128 });
            if length == 0 {
                return;
            }
        }
    }
    let mut payload = Vec::new();
    append_length(&mut payload, name.len());
    payload.extend_from_slice(name);
    payload.extend_from_slice(data);
    let mut output = bytes.to_vec();
    output.push(0);
    append_length(&mut output, payload.len());
    output.extend_from_slice(&payload);
    output
}

fn profile() -> PreparationProfile {
    PreparationProfile {
        preparer_sha256: [1; 32],
        optimizer_sha256: None,
        options_sha256: [2; 32],
        dependency_closure_sha256: [3; 32],
        program_abi: 55,
        program_contract_sha256: wasm_artifact::facts::read_custom_section(
            ORIGINAL,
            wasm_artifact::ABI_CONTRACT_SECTION,
        )
        .unwrap()
        .try_into()
        .unwrap(),
    }
}

fn plan(source: &[u8]) -> PreparationPlan {
    PreparationPlan::from_source(source, profile(), limits()).unwrap()
}

fn limits() -> PreparationLimits {
    PreparationLimits {
        source_bytes: 4 * 1024 * 1024,
        original_bytes: 4 * 1024 * 1024,
        output_bytes: 4 * 1024 * 1024,
        metadata_bytes: 1024 * 1024,
        metadata_work_items: 1_000_000,
    }
}

fn output(source: &[u8]) -> Vec<u8> {
    let reference = wasm_artifact::original_program::OriginalProgramReference {
        length: source.len() as u64,
        sha256: Sha256::digest(source).into(),
    };
    let bound = append_section(
        ORIGINAL,
        wasm_artifact::original_program::ORIGINAL_REFERENCE_SECTION.as_bytes(),
        &reference.encode(),
    );
    append_section(&bound, b"test-payload", b"UNCHANGED")
}

fn install(proc: &mut Process, path: &[u8], bytes: &[u8]) -> i32 {
    let fd = sys_open(
        proc,
        &mut NoopHost,
        path,
        O_CREAT | O_TRUNC | O_RDWR | O_CLOEXEC,
        0o755,
    )
    .unwrap();
    assert_eq!(
        sys_write(proc, &mut NoopHost, fd, bytes).unwrap(),
        bytes.len()
    );
    fd
}

fn observe(proc: &mut Process, host: &mut dyn HostIO, token: u32) -> Vec<u8> {
    let mut bytes = vec![0; size(proc, proc.pid, token).unwrap() as usize];
    let mut offset = 0;
    while offset < bytes.len() {
        let count = read(
            proc,
            host,
            proc.pid,
            token,
            offset as i64,
            &mut bytes[offset..],
        )
        .unwrap();
        assert!(count > 0);
        offset += count;
    }
    bytes
}

fn prepare_fd(
    proc: &mut Process,
    locks: &mut AdvisoryLockManager,
    host: &mut dyn HostIO,
    fd: i32,
) -> u32 {
    prepare(
        proc,
        locks,
        host,
        PreparedExecOwner::Process {
            pid: proc.pid,
            caller_tid: proc.pid,
            generation: proc.exec_generation,
        },
        fd,
        b"",
        AT_EMPTY_PATH,
    )
    .unwrap()
}

struct Fixture {
    _namespace: NamespaceGuard,
    proc: Process,
    locks: AdvisoryLockManager,
    source_fd: i32,
    image_fd: i32,
    token: u32,
    plan: PreparationPlan,
    receipt: PreparationReceipt,
    source: Vec<u8>,
    image: Vec<u8>,
}

impl Fixture {
    fn new(source_scratch: bool, image_scratch: bool, padded: bool) -> Self {
        let namespace = NamespaceGuard::enter();
        let source = if padded {
            append_section(ORIGINAL, b"source-padding", &[0x55; 8192])
        } else {
            ORIGINAL.to_vec()
        };
        let image = output(&source);
        let mut proc = Process::new(100);
        let mut locks = AdvisoryLockManager::new();
        let source_fd = install(
            &mut proc,
            if source_scratch {
                b"/tmp/source"
            } else {
                b"/source"
            },
            &source,
        );
        let image_fd = install(
            &mut proc,
            if image_scratch {
                b"/tmp/image"
            } else {
                b"/image"
            },
            &image,
        );
        let plan = plan(&source);
        let receipt = plan.verify_output(&image).unwrap();
        let token = prepare_fd(&mut proc, &mut locks, &mut NoopHost, source_fd);
        assert_eq!(observe(&mut proc, &mut NoopHost, token), source);
        Self {
            _namespace: namespace,
            proc,
            locks,
            source_fd,
            image_fd,
            token,
            plan,
            receipt,
            source,
            image,
        }
    }

    fn source_ref(&self) -> OpenFileDescRef {
        self.proc.fd_table.get(self.source_fd).unwrap().ofd_ref
    }
    fn image_ref(&self) -> OpenFileDescRef {
        self.proc.fd_table.get(self.image_fd).unwrap().ofd_ref
    }

    fn bind(&mut self) -> Result<(), Errno> {
        let image = self.image_ref();
        let pid = self.proc.pid;
        bind_prepared_image(
            &mut self.proc,
            &mut self.locks,
            &mut NoopHost,
            pid,
            self.token,
            image,
            &self.plan,
            &self.receipt,
        )
    }

    fn commit(&mut self) -> Result<(), Errno> {
        let pid = self.proc.pid;
        commit_process(
            &mut self.proc,
            &mut self.locks,
            &mut NoopHost,
            pid,
            pid,
            self.token,
        )
    }

    fn pair(&self) -> i64 {
        let reference = self
            .proc
            .prepared_exec_targets
            .get(self.token)
            .unwrap()
            .ofd_ref;
        self.proc.ofd_table.get(reference.0).unwrap().host_handle
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        sys_exit_with_locks(&mut self.proc, &mut self.locks, &mut NoopHost, 0);
    }
}

#[test]
fn proc_fd_exec_retains_the_open_inode_after_unlink_and_path_replacement() {
    let mut fixture = Fixture::new(false, false, false);
    let source_fd = fixture.source_fd;
    let source_handle = fixture.proc.ofd_table.get(fixture.source_ref().0).unwrap().host_handle;
    sys_lseek(&mut fixture.proc, &mut NoopHost, source_fd, 17, 0).unwrap();
    sys_unlink(&mut fixture.proc, &mut NoopHost, b"/source").unwrap();
    let replacement = install(&mut fixture.proc, b"/source", &fixture.image);
    let path = alloc::format!("/proc/self/fd/{source_fd}");
    let owner = PreparedExecOwner::Process { pid: fixture.proc.pid, caller_tid: fixture.proc.pid, generation: fixture.proc.exec_generation };
    let token = prepare(&mut fixture.proc, &mut fixture.locks, &mut NoopHost, owner,
        AT_FDCWD, path.as_bytes(), 0).unwrap();
    assert_eq!(observe(&mut fixture.proc, &mut NoopHost, token), fixture.source);
    assert_eq!(sys_lseek(&mut fixture.proc, &mut NoopHost, source_fd, 0, 1), Ok(17));
    let pid = fixture.proc.pid;
    commit_process(&mut fixture.proc, &mut fixture.locks, &mut NoopHost, pid, pid, token).unwrap();
    let executable = fixture.proc.exe.unwrap();
    assert_eq!(fixture.proc.ofd_table.get(executable.0).unwrap().host_handle,
        source_handle);
    assert!(fixture.proc.fd_table.get(source_fd).is_err());
    assert!(fixture.proc.fd_table.get(replacement).is_err());
}

#[test]
fn proc_fd_exec_honors_nofollow_and_live_execute_permissions() {
    let mut fixture = Fixture::new(false, false, false);
    let path = alloc::format!("/proc/self/fd/{}", fixture.source_fd);
    let owner = PreparedExecOwner::Process { pid: fixture.proc.pid, caller_tid: fixture.proc.pid, generation: fixture.proc.exec_generation };
    let before = fixture.proc.ofd_table.get(fixture.source_ref().0).unwrap().ref_count;
    assert_eq!(prepare(&mut fixture.proc, &mut fixture.locks, &mut NoopHost, owner,
        AT_FDCWD, path.as_bytes(), AT_SYMLINK_NOFOLLOW), Err(Errno::ELOOP));
    sys_fchmod(&mut fixture.proc, &mut NoopHost, fixture.source_fd, 0o600).unwrap();
    assert_eq!(prepare(&mut fixture.proc, &mut fixture.locks, &mut NoopHost, owner,
        AT_FDCWD, path.as_bytes(), 0), Err(Errno::EACCES));
    assert_eq!(fixture.proc.ofd_table.get(fixture.source_ref().0).unwrap().ref_count, before);
    assert!(fixture.proc.exe.is_none());
}

#[test]
fn trusted_inspection_path_binds_and_commits_without_reparsing_metadata() {
    let mut fixture = Fixture::new(false, false, true);
    let read_limits = wasm_artifact::policy_surface::PolicyReadLimits {
        metadata_bytes: limits().metadata_bytes,
        work_items: limits().metadata_work_items,
    };
    let source = kandelo_program_policy::Inspection::read(&fixture.source, read_limits).unwrap();
    let image = kandelo_program_policy::Inspection::read(&fixture.image, read_limits).unwrap();
    let pid = fixture.proc.pid;
    assert_eq!(preparation_plan_inspected(&fixture.proc, pid, fixture.token, &source, profile(), limits()), Ok(fixture.plan));
    assert_eq!(preparation_plan_inspected(&fixture.proc, pid, fixture.token, &image, profile(), limits()), Err(Errno::ETXTBSY));
    let reference = fixture.image_ref();
    assert_eq!(bind_prepared_image_inspected(&mut fixture.proc, &mut fixture.locks, &mut NoopHost,
        pid, fixture.token, reference, &fixture.plan, &fixture.receipt, &source), Err(Errno::ETXTBSY));
    assert_eq!(fixture.proc.prepared_exec_targets.get(fixture.token).unwrap().observed_bytes().unwrap(), fixture.source);
    bind_prepared_image_inspected(&mut fixture.proc, &mut fixture.locks, &mut NoopHost,
        pid, fixture.token, reference, &fixture.plan, &fixture.receipt, &image).unwrap();
    assert_eq!(observe(&mut fixture.proc, &mut NoopHost, fixture.token), fixture.image);
    assert_eq!(fixture.commit(), Ok(()));
}

#[test]
fn conversion_keeps_source_authority_and_guest_descriptions_when_lengths_differ() {
    for padded in [false, true] {
        let mut fixture = Fixture::new(false, false, padded);
        let source_ref = fixture.source_ref();
        let source = fixture.proc.ofd_table.get(source_ref.0).unwrap();
        let original_handle = source.host_handle;
        let original_cursor = source.offset();
        fixture.bind().unwrap();
        assert_eq!(
            preparation_plan(&fixture.proc, 100, fixture.token, profile(), limits()),
            Err(Errno::ENOTSUP)
        );
        let target = fixture
            .proc
            .prepared_exec_targets
            .get(fixture.token)
            .unwrap();
        assert_eq!(target.stat.st_size, fixture.source.len() as u64);
        assert_eq!(target.size(), fixture.image.len());
        assert_ne!(target.stat.st_size as usize, target.size());
        assert_eq!(target.observed_bytes().unwrap(), fixture.image);
        assert_ne!(target.ofd_ref, source_ref);
        let source = fixture.proc.ofd_table.get(source_ref.0).unwrap();
        assert_eq!(source.host_handle, original_handle);
        assert_eq!(source.offset(), original_cursor);
        fixture.proc.pointer_width = 64;
        fixture.commit().unwrap();
        assert_eq!(
            fixture.proc.pointer_width,
            wasm_artifact::detect_pointer_width(&fixture.image)
        );
        assert!(fixture.proc.fd_table.get(fixture.source_fd).is_err());
        assert!(fixture.proc.fd_table.get(fixture.image_fd).is_err());
        let fd = sys_open(
            &mut fixture.proc,
            &mut NoopHost,
            b"/proc/self/exe",
            O_RDONLY,
            0,
        )
        .unwrap();
        assert_eq!(
            sys_fstat(&fixture.proc, &mut NoopHost, fd).unwrap().st_size,
            fixture.image.len() as u64
        );
    }
}

#[test]
fn failed_conversion_leaves_the_source_token_and_descriptors_intact() {
    let mut fixture = Fixture::new(false, false, false);
    let original = fixture
        .proc
        .prepared_exec_targets
        .get(fixture.token)
        .unwrap()
        .ofd_ref;
    let image_ref = fixture.image_ref();
    let handle = fixture.proc.ofd_table.get(image_ref.0).unwrap().host_handle;
    crate::rootfs::write(handle, (fixture.image.len() - 1) as i64, b"X", |_, _| {
        Err(Errno::EIO)
    })
    .unwrap();
    assert_eq!(fixture.bind(), Err(Errno::EIO));
    assert_eq!(
        fixture
            .proc
            .prepared_exec_targets
            .get(fixture.token)
            .unwrap()
            .ofd_ref,
        original
    );
    assert_eq!(
        artifact_bytes(&fixture.proc, fixture.proc.pid, fixture.token).unwrap(),
        fixture.source
    );
    assert_eq!(fixture.proc.ofd_table.reserved_count(), 0);
    crate::rootfs::write(handle, (fixture.image.len() - 1) as i64, b"D", |_, _| {
        Err(Errno::EIO)
    })
    .unwrap();
    {
        let _budget = crate::io_buffer::test_budget(crate::io_buffer::IO_MEMORY.usage().0);
        assert_eq!(fixture.bind(), Err(Errno::ENOMEM));
    }
    assert_eq!(
        fixture
            .proc
            .prepared_exec_targets
            .get(fixture.token)
            .unwrap()
            .ofd_ref,
        original
    );
    assert_eq!(fixture.proc.ofd_table.reserved_count(), 0);
    fixture.bind().unwrap();
}

#[test]
fn same_length_source_and_image_writes_refuse_commit_without_replacing_the_executable() {
    for corrupt_source in [false, true] {
        let mut fixture = Fixture::new(false, false, false);
        fixture.bind().unwrap();
        let fd = if corrupt_source {
            fixture.source_fd
        } else {
            fixture.image_fd
        };
        sys_pwrite(&mut fixture.proc, &mut NoopHost, fd, b"bad!", 0).unwrap();
        assert_eq!(fixture.commit(), Err(Errno::ETXTBSY));
        assert!(fixture.proc.exe.is_none());
        assert_eq!(fixture.proc.exec_generation, 0);
        assert!(fixture.proc.prepared_exec_targets.is_empty());
    }
}

#[test]
fn saved_pair_exec_ignores_the_current_executable_and_replaced_or_deleted_pathnames() {
    let mut fixture = Fixture::new(false, false, false);
    fixture.bind().unwrap();
    fixture.commit().unwrap();
    let saved = sys_open(
        &mut fixture.proc,
        &mut NoopHost,
        b"/proc/self/exe",
        O_RDONLY,
        0,
    )
    .unwrap();
    let other = install(&mut fixture.proc, b"/other", ORIGINAL);
    let other_token = prepare_fd(&mut fixture.proc, &mut fixture.locks, &mut NoopHost, other);
    observe(&mut fixture.proc, &mut NoopHost, other_token);
    let pid = fixture.proc.pid;
    commit_process(
        &mut fixture.proc,
        &mut fixture.locks,
        &mut NoopHost,
        pid,
        pid,
        other_token,
    )
    .unwrap();
    crate::rootfs::unlink(b"/source").unwrap();
    install(&mut fixture.proc, b"/source", b"not the retained source");
    let token = prepare_fd(&mut fixture.proc, &mut fixture.locks, &mut NoopHost, saved);
    assert_eq!(
        observe(&mut fixture.proc, &mut NoopHost, token),
        fixture.image
    );
    assert_eq!(
        fixture
            .proc
            .prepared_exec_targets
            .get(token)
            .unwrap()
            .stat
            .st_nlink,
        0
    );
    commit_process(
        &mut fixture.proc,
        &mut fixture.locks,
        &mut NoopHost,
        pid,
        pid,
        token,
    )
    .unwrap();
    let mut link = [0; 64];
    let count = sys_readlink(
        &mut fixture.proc,
        &mut NoopHost,
        b"/proc/self/exe",
        &mut link,
    )
    .unwrap();
    assert_eq!(&link[..count], b"/source (deleted)");
    let next = prepare(
        &mut fixture.proc,
        &mut fixture.locks,
        &mut NoopHost,
        PreparedExecOwner::Process {
            pid,
            caller_tid: pid,
            generation: 3,
        },
        AT_FDCWD,
        b"/proc/self/exe",
        0,
    )
    .unwrap();
    assert_eq!(
        observe(&mut fixture.proc, &mut NoopHost, next),
        fixture.image
    );
}

#[test]
fn source_mount_not_image_mount_decides_set_id_credentials() {
    for source_scratch in [false, true] {
        let mut fixture = Fixture::new(source_scratch, !source_scratch, false);
        cancel(
            &mut fixture.proc,
            &mut fixture.locks,
            &mut NoopHost,
            100,
            fixture.token,
        )
        .unwrap();
        let source = fixture
            .proc
            .ofd_table
            .get(fixture.source_ref().0)
            .unwrap()
            .host_handle;
        if source_scratch {
            crate::tmpfs::fchown(source, 4100, 4200, false).unwrap();
            crate::tmpfs::fchmod(source, 0o755 | S_ISUID | S_ISGID).unwrap();
        } else {
            crate::rootfs::fchown(source, 4100, 4200, false).unwrap();
            crate::rootfs::fchmod(source, 0o755 | S_ISUID | S_ISGID).unwrap();
        }
        fixture.token = prepare_fd(
            &mut fixture.proc,
            &mut fixture.locks,
            &mut NoopHost,
            fixture.source_fd,
        );
        observe(&mut fixture.proc, &mut NoopHost, fixture.token);
        fixture.bind().unwrap();
        fixture.commit().unwrap();
        assert_eq!(
            fixture.proc.effective_uid(),
            if source_scratch { 0 } else { 4100 }
        );
        assert_eq!(
            fixture.proc.effective_gid(),
            if source_scratch { 0 } else { 4200 }
        );
    }
}

#[test]
fn new_preparation_reads_live_source_permissions_and_refuses_later_credential_drift() {
    let mut fixture = Fixture::new(false, false, false);
    fixture.bind().unwrap();
    let handle = fixture.pair();
    let source = crate::executable_backing::source_handle(handle).unwrap();
    fixture.commit().unwrap();
    let saved = sys_open(
        &mut fixture.proc,
        &mut NoopHost,
        b"/proc/self/exe",
        O_RDONLY,
        0,
    )
    .unwrap();
    crate::rootfs::fchown(source, 4100, 4200, false).unwrap();
    crate::rootfs::fchmod(source, 0o755 | S_ISUID | S_ISGID).unwrap();
    let token = prepare_fd(&mut fixture.proc, &mut fixture.locks, &mut NoopHost, saved);
    assert_eq!(
        fixture
            .proc
            .prepared_exec_targets
            .get(token)
            .unwrap()
            .stat
            .st_uid,
        4100
    );
    observe(&mut fixture.proc, &mut NoopHost, token);
    crate::rootfs::fchmod(source, 0o755).unwrap();
    assert_eq!(
        commit_process(
            &mut fixture.proc,
            &mut fixture.locks,
            &mut NoopHost,
            100,
            100,
            token
        ),
        Err(Errno::ETXTBSY)
    );
    assert_eq!(fixture.proc.exec_generation, 1);
    assert_eq!(fixture.proc.effective_uid(), 0);
    crate::rootfs::fchmod(source, 0o644).unwrap();
    assert_eq!(
        prepare(
            &mut fixture.proc,
            &mut fixture.locks,
            &mut NoopHost,
            PreparedExecOwner::Process {
                pid: 100,
                caller_tid: 100,
                generation: 1
            },
            saved,
            b"",
            AT_EMPTY_PATH
        ),
        Err(Errno::EACCES)
    );
    crate::rootfs::fchmod(source, 0o755 | S_ISUID | S_ISGID).unwrap();
    let token = prepare_fd(&mut fixture.proc, &mut fixture.locks, &mut NoopHost, saved);
    observe(&mut fixture.proc, &mut NoopHost, token);
    commit_process(
        &mut fixture.proc,
        &mut fixture.locks,
        &mut NoopHost,
        100,
        100,
        token,
    )
    .unwrap();
    assert_eq!(fixture.proc.effective_uid(), 4100);
    assert_eq!(fixture.proc.effective_gid(), 4200);
}

#[test]
fn alias_unbound_and_stale_conversions_do_not_grant_exec_authority() {
    let mut fixture = Fixture::new(false, false, false);
    let source = fixture.source_ref();
    assert_eq!(
        bind_prepared_image(
            &mut fixture.proc,
            &mut fixture.locks,
            &mut NoopHost,
            100,
            fixture.token,
            source,
            &fixture.plan,
            &fixture.receipt
        ),
        Err(Errno::EINVAL)
    );
    fixture.proc.exec_generation = 1;
    assert_eq!(fixture.bind(), Err(Errno::EINVAL));
    fixture.proc.exec_generation = 0;
    let image = fixture.image_ref();
    let pair =
        crate::executable_backing::create(&fixture.proc, source, image, &mut NoopHost).unwrap();
    let index =
        fixture
            .proc
            .ofd_table
            .create(FileType::Regular, O_RDONLY, pair, b"/unbound".to_vec());
    let fd = fixture
        .proc
        .fd_table
        .alloc(OpenFileDescRef(index), 0)
        .unwrap();
    let owner = PreparedExecOwner::Process {
        pid: 100,
        caller_tid: 100,
        generation: 0,
    };
    assert_eq!(
        prepare(
            &mut fixture.proc,
            &mut fixture.locks,
            &mut NoopHost,
            owner,
            fd,
            b"",
            AT_EMPTY_PATH
        ),
        Err(Errno::ENOTSUP)
    );
    let id = fixture.proc.ofd_table.get(index).unwrap().ofd_id;
    fixture.proc.ofd_table.try_inc_ref_exact(index, id).unwrap();
    fixture.proc.exe = Some(OpenFileDescRef(index));
    assert_eq!(
        prepare(
            &mut fixture.proc,
            &mut fixture.locks,
            &mut NoopHost,
            owner,
            AT_FDCWD,
            b"/proc/self/exe",
            0
        ),
        Err(Errno::ENOTSUP)
    );
    assert_eq!(
        artifact_bytes(&fixture.proc, 100, fixture.token).unwrap(),
        fixture.source
    );
}

#[test]
fn a_received_and_fork_inherited_pair_can_exec_after_the_sender_exits() {
    let mut fixture = Fixture::new(false, false, false);
    fixture.bind().unwrap();
    fixture.commit().unwrap();
    let saved = sys_open(
        &mut fixture.proc,
        &mut NoopHost,
        b"/proc/self/exe",
        O_RDONLY,
        0,
    )
    .unwrap();
    let mut queued = snapshot_scm_rights_fd(&fixture.proc, saved).unwrap();
    queued.retain_reference().unwrap();
    sys_exit_with_locks(&mut fixture.proc, &mut fixture.locks, &mut NoopHost, 0);
    let mut receiver = Process::new(200);
    let received = install_scm_rights_fds_with_flags(
        &mut receiver,
        vec![queued],
        wasm_posix_shared::fd_flags::FD_CLOEXEC,
    );
    assert_eq!(received.len(), 1);
    let fd = received[0];
    let mut wire = vec![0; 128 * 1024];
    let length = crate::fork::serialize_fork_state(&receiver, &mut wire).unwrap();
    let mut child = crate::fork::deserialize_fork_state(&wire[..length], 300).unwrap();
    crate::process_table::bump_inherited_resource_refcounts(receiver.pid, &child).unwrap();
    sys_exit_with_locks(&mut receiver, &mut fixture.locks, &mut NoopHost, 0);
    let token = prepare_fd(&mut child, &mut fixture.locks, &mut NoopHost, fd);
    assert_eq!(observe(&mut child, &mut NoopHost, token), fixture.image);
    commit_process(
        &mut child,
        &mut fixture.locks,
        &mut NoopHost,
        300,
        300,
        token,
    )
    .unwrap();
    assert!(child.fd_table.get(fd).is_err());
    assert!(child.exe.is_some());
    sys_exit_with_locks(&mut child, &mut fixture.locks, &mut NoopHost, 0);
}

#[test]
fn an_execute_only_path_descriptor_does_not_grant_reads_of_the_prepared_image() {
    let mut fixture = Fixture::new(false, false, false);
    cancel(
        &mut fixture.proc,
        &mut fixture.locks,
        &mut NoopHost,
        100,
        fixture.token,
    )
    .unwrap();
    let source = fixture
        .proc
        .ofd_table
        .get(fixture.source_ref().0)
        .unwrap()
        .host_handle;
    crate::rootfs::fchmod(source, 0o111).unwrap();
    sys_close(&mut fixture.proc, &mut NoopHost, fixture.source_fd).unwrap();
    sys_setresuid(&mut fixture.proc, 1000, 1000, 1000).unwrap();
    fixture.source_fd = sys_open(
        &mut fixture.proc,
        &mut NoopHost,
        b"/source",
        O_PATH | O_CLOEXEC,
        0,
    )
    .unwrap();
    fixture.token = prepare_fd(
        &mut fixture.proc,
        &mut fixture.locks,
        &mut NoopHost,
        fixture.source_fd,
    );
    assert_eq!(
        observe(&mut fixture.proc, &mut NoopHost, fixture.token),
        fixture.source
    );
    fixture.bind().unwrap();
    crate::rootfs::unlink(b"/image").unwrap();
    fixture.commit().unwrap();
    assert_eq!(fixture.proc.effective_uid(), 1000);
    assert_eq!(
        sys_open(
            &mut fixture.proc,
            &mut NoopHost,
            b"/proc/self/exe",
            O_RDONLY,
            0
        ),
        Err(Errno::EACCES)
    );
    assert_eq!(
        sys_open(&mut fixture.proc, &mut NoopHost, b"/image", O_RDONLY, 0),
        Err(Errno::ENOENT)
    );
    let stat = sys_stat(&mut fixture.proc, &mut NoopHost, b"/proc/self/exe").unwrap();
    assert_eq!(stat.st_mode & 0o777, 0o111);
    assert_eq!(stat.st_size, fixture.image.len() as u64);
}
