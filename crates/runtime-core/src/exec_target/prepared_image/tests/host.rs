use super::*;
use crate::process::HostIO;

const SOURCE: i64 = 82_001;
const IMAGE: i64 = 82_002;

fn private_program_host() -> MutableHost {
    MutableHost {
        closed: Vec::new(), program_metadata: Some((0o555, 0)),
        source: include_bytes!("../../../../../../abi/program-fixtures/v55/echo.wasm").to_vec(),
        image: Vec::new(), corrupt_source_on_image_read: false, source_bytes_read: 0,
        corrupt_image_after_source_bytes: None, image_revision: 0,
    }
}

struct MutableHost {
    closed: Vec<i64>,
    program_metadata: Option<(u32, u32)>,
    source: Vec<u8>,
    image: Vec<u8>,
    corrupt_source_on_image_read: bool,
    source_bytes_read: usize,
    corrupt_image_after_source_bytes: Option<usize>,
    image_revision: u64,
}

impl HostIO for MutableHost {
    fn host_close(&mut self, handle: i64) -> Result<(), Errno> {
        self.closed.push(handle);
        Ok(())
    }
    fn host_read(&mut self, _handle: i64, _bytes: &mut [u8]) -> Result<usize, Errno> {
        panic!("unpositioned read")
    }
    fn host_write(&mut self, _handle: i64, _bytes: &[u8]) -> Result<usize, Errno> {
        panic!("write")
    }
    fn host_seek(&mut self, _handle: i64, _offset: i64, _whence: u32) -> Result<i64, Errno> {
        panic!("seek")
    }
    fn host_pread(&mut self, handle: i64, bytes: &mut [u8], offset: i64) -> Result<usize, Errno> {
        if handle == IMAGE && self.corrupt_source_on_image_read {
            self.source[4] ^= 1;
            self.corrupt_source_on_image_read = false;
        }
        let data = match handle {
            SOURCE => &self.source,
            IMAGE => &self.image,
            _ => panic!("negative handle reached host"),
        };
        let start = usize::try_from(offset).unwrap().min(data.len());
        let count = bytes.len().min(data.len() - start);
        bytes[..count].copy_from_slice(&data[start..start + count]);
        if handle == SOURCE {
            self.source_bytes_read += count;
            if self
                .corrupt_image_after_source_bytes
                .is_some_and(|limit| self.source_bytes_read >= limit)
            {
                self.image[4] ^= 1;
                self.image_revision += 1;
                self.corrupt_image_after_source_bytes = None;
            }
        }
        Ok(count)
    }
    fn host_fstat(&mut self, handle: i64) -> Result<WasmStat, Errno> {
        let size = match handle {
            SOURCE => self.source.len(),
            IMAGE => self.image.len(),
            _ => panic!("negative handle reached host"),
        };
        Ok(WasmStat {
            st_dev: 99,
            st_ino: handle as u64,
            st_size: size as u64,
            st_mode: wasm_posix_shared::mode::S_IFREG
                | self.program_metadata.map_or(if handle == SOURCE { 0o755 } else { 0o600 }, |metadata| metadata.0),
            st_uid: 0,
            st_gid: 0,
            st_nlink: self.program_metadata.map_or(1, |metadata| metadata.1),
            st_atime_sec: 0,
            st_atime_nsec: 0,
            st_mtime_sec: if handle == IMAGE {
                self.image_revision
            } else {
                0
            },
            st_mtime_nsec: 0,
            st_ctime_sec: 0,
            st_ctime_nsec: 0,
            st_rdev: 0,
            _pad: 0,
        })
    }
    fn host_fstatfs(&mut self, handle: i64) -> Result<WasmStatfs, Errno> {
        assert!(handle == SOURCE || handle == IMAGE);
        Ok(WasmStatfs {
            f_type: 77,
            f_fsid: 99,
            f_flags: 0,
            f_bsize: 4096,
            f_blocks: 0,
            f_bfree: 0,
            f_bavail: 0,
            f_files: 0,
            f_ffree: 0,
            f_namelen: 255,
            f_frsize: 4096,
            _pad: 0,
        })
    }
    fn host_fsync(&mut self, _handle: i64) -> Result<(), Errno> {
        Ok(())
    }
    fn host_readdir(
        &mut self,
        _handle: i64,
        _bytes: &mut [u8],
    ) -> Result<Option<(u64, u32, usize)>, Errno> {
        panic!("readdir")
    }
    fn host_clock_gettime(&mut self, _clock: u32) -> Result<(i64, i64), Errno> {
        Ok((0, 0))
    }
    fn host_ftruncate(&mut self, _handle: i64, _length: i64) -> Result<(), Errno> {
        panic!("truncate")
    }
    fn host_fchmod(&mut self, _handle: i64, _mode: u32) -> Result<(), Errno> {
        panic!("chmod")
    }
    fn host_fchown(&mut self, _handle: i64, _uid: u32, _gid: u32) -> Result<(), Errno> {
        panic!("chown")
    }
    fn host_set_alarm(&mut self, _seconds: u32) -> Result<(), Errno> {
        panic!("alarm")
    }
    fn host_set_posix_timer(
        &mut self,
        _timer: i32,
        _signal: i32,
        _value: i64,
        _interval: i64,
    ) -> Result<(), Errno> {
        panic!("timer")
    }
    fn host_getrandom(&mut self, _bytes: &mut [u8]) -> Result<usize, Errno> {
        panic!("random")
    }
    fn host_net_connect(&mut self, _handle: i32, _address: &[u8], _port: u16) -> Result<(), Errno> {
        panic!("connect")
    }
    fn host_net_connect_status(&mut self, _handle: i32) -> Result<(), Errno> {
        panic!("connect status")
    }
    fn host_net_send(&mut self, _handle: i32, _bytes: &[u8], _flags: u32) -> Result<usize, Errno> {
        panic!("send")
    }
    fn host_net_recv(
        &mut self,
        _handle: i32,
        _length: u32,
        _flags: u32,
        _bytes: &mut [u8],
    ) -> Result<usize, Errno> {
        panic!("recv")
    }
    fn host_net_close(&mut self, _handle: i32) -> Result<(), Errno> {
        panic!("net close")
    }
    fn host_net_listen(&mut self, _fd: i32, _port: u16, _address: &[u8; 4]) -> Result<(), Errno> {
        panic!("listen")
    }
    fn host_getaddrinfo(&mut self, _name: &[u8], _result: &mut [u8]) -> Result<usize, Errno> {
        panic!("resolve")
    }
    fn bind_framebuffer(
        &mut self,
        _pid: i32,
        _address: usize,
        _length: usize,
        _width: u32,
        _height: u32,
        _stride: u32,
        _format: u32,
    ) {
        panic!("bind framebuffer")
    }
    fn unbind_framebuffer(&mut self, _pid: i32) {}
    fn fb_write(&mut self, _pid: i32, _offset: usize, _bytes: &[u8]) {
        panic!("framebuffer write")
    }
}

#[test]
fn trusted_host_program_uses_normal_observation_and_spawn_commit_with_exact_release() {
    let mut host = private_program_host();
    let mut proc = Process::new(100);
    proc.ppid = 1;
    proc.spawn_publication_pending = true;
    let mut locks = AdvisoryLockManager::new();
    let owner = PreparedExecOwner::Spawn { parent_pid: 1, child_pid: 100, launch: 0 };
    let token = crate::exec_target::prepare_host_program(&mut proc, &mut locks, &mut host, owner,
        SOURCE, b"current-preparer").unwrap();
    assert!(proc.exe.is_none());
    assert_eq!(proc.exec_generation, 0);
    assert!(host.closed.is_empty());
    assert_eq!(observe(&mut proc, &mut host, token), host.source);
    assert!(matches!(admit(&proc, 100, token, 55), Ok(Admission::Program)));
    commit_spawn(&mut proc, &mut locks, &mut host, 1, 100, token).unwrap();
    assert_eq!(proc.exec_generation, 1);
    assert!(!proc.secure_exec);
    assert!(host.closed.is_empty());
    assert_eq!(crate::exec_target::prepare_host_program(&mut proc, &mut locks, &mut host,
        PreparedExecOwner::Spawn { parent_pid: 1, child_pid: 100, launch: 1 }, IMAGE, b"second-preparer"), Err(Errno::EINVAL));
    assert_eq!(host.closed, vec![IMAGE]);
    crate::exec_target::release_process_exe(&mut proc, &mut locks, &mut host);
    assert_eq!(host.closed, vec![IMAGE, SOURCE]);
    assert!(proc.exe.is_none());
}

#[test]
fn trusted_host_program_refuses_mutable_named_set_id_or_unpublished_targets_and_closes_once() {
    for (metadata, pending, generation) in [
        ((0o755, 0), true, 0), ((0o555, 1), true, 0),
        ((0o4555, 0), true, 0), ((0o2555, 0), true, 0),
        ((0o555, 0), false, 0), ((0o555, 0), true, 1),
    ] {
        let mut host = private_program_host();
        host.program_metadata = Some(metadata);
        let mut proc = Process::new(100);
        proc.ppid = 1;
        proc.spawn_publication_pending = pending;
        let mut locks = AdvisoryLockManager::new();
        let owner = PreparedExecOwner::Spawn { parent_pid: 1, child_pid: 100, launch: generation };
        assert!(crate::exec_target::prepare_host_program(&mut proc, &mut locks, &mut host, owner,
            SOURCE, b"current-preparer").is_err());
        assert_eq!(host.closed, vec![SOURCE]);
        assert!(proc.exe.is_none());
        assert!(proc.prepared_exec_targets.is_empty());
    }
}

#[test]
fn trusted_host_program_requires_complete_unchanged_observation_before_commit() {
    for changed in [false, true] {
        let mut host = private_program_host();
        let mut proc = Process::new(100);
        proc.ppid = 1;
        proc.spawn_publication_pending = true;
        let mut locks = AdvisoryLockManager::new();
        let owner = PreparedExecOwner::Spawn { parent_pid: 1, child_pid: 100, launch: 0 };
        let token = crate::exec_target::prepare_host_program(&mut proc, &mut locks, &mut host, owner,
            SOURCE, b"current-preparer").unwrap();
        if changed {
            observe(&mut proc, &mut host, token);
            host.source[4] ^= 1;
        }
        assert!(commit_spawn(&mut proc, &mut locks, &mut host, 1, 100, token).is_err());
        assert_eq!(host.closed, vec![SOURCE]);
        assert_eq!(proc.exec_generation, 0);
        assert!(proc.exe.is_none());
    }
}

#[test]
fn source_digest_is_exact_retained_source_and_is_checked_again_after_image_reads() {
    let source = output(ORIGINAL);
    let image = append_section(&source, b"current-preparation", b"prepared");
    let plan = plan(&source);
    let receipt = plan.verify_output(&image).unwrap();
    let mut host = MutableHost {
        closed: Vec::new(), program_metadata: None,
        source,
        image,
        corrupt_source_on_image_read: false,
        source_bytes_read: 0,
        corrupt_image_after_source_bytes: None,
        image_revision: 0,
    };
    let mut proc = Process::new(100);
    let mut locks = AdvisoryLockManager::new();
    let source = proc.ofd_table.create(
        FileType::Regular,
        O_RDONLY | O_CLOEXEC,
        SOURCE,
        b"/retained-source".to_vec(),
    );
    let fd = proc
        .fd_table
        .alloc(
            OpenFileDescRef(source),
            wasm_posix_shared::fd_flags::FD_CLOEXEC,
        )
        .unwrap();
    let image = proc.ofd_table.create(
        FileType::Regular,
        O_RDONLY,
        IMAGE,
        b"/private-image".to_vec(),
    );
    let token = prepare_fd(&mut proc, &mut locks, &mut host, fd);
    observe(&mut proc, &mut host, token);
    bind_prepared_image(
        &mut proc,
        &mut locks,
        &mut host,
        100,
        token,
        OpenFileDescRef(image),
        &plan,
        &receipt,
    )
    .unwrap();
    let handle = proc
        .ofd_table
        .get(proc.prepared_exec_targets.get(token).unwrap().ofd_ref.0)
        .unwrap()
        .host_handle;
    crate::executable_backing::verify_source(handle, &mut host).unwrap();
    host.source_bytes_read = 0;
    host.corrupt_source_on_image_read = true;
    assert_eq!(
        commit_process(&mut proc, &mut locks, &mut host, 100, 100, token),
        Err(Errno::ETXTBSY)
    );
    assert_eq!(host.source_bytes_read, host.source.len() * 2);
    assert!(proc.exe.is_none());
    assert_eq!(proc.exec_generation, 0);
    crate::syscalls::release_prepared_exec_ofd_with_locks(
        &mut proc,
        &mut locks,
        &mut host,
        OpenFileDescRef(image),
    )
    .unwrap();
    sys_exit_with_locks(&mut proc, &mut locks, &mut host, 0);
}

#[test]
fn an_image_changed_during_the_trailing_source_hash_is_not_committed() {
    let source = ORIGINAL.to_vec();
    let image = output(&source);
    let plan = plan(&source);
    let receipt = plan.verify_output(&image).unwrap();
    let mut host = MutableHost {
        closed: Vec::new(), program_metadata: None,
        source,
        image,
        corrupt_source_on_image_read: false,
        source_bytes_read: 0,
        corrupt_image_after_source_bytes: None,
        image_revision: 0,
    };
    let mut proc = Process::new(100);
    let mut locks = AdvisoryLockManager::new();
    let source = proc.ofd_table.create(
        FileType::Regular,
        O_RDONLY,
        SOURCE,
        b"/retained-source".to_vec(),
    );
    let fd = proc.fd_table.alloc(OpenFileDescRef(source), 0).unwrap();
    let image = proc.ofd_table.create(
        FileType::Regular,
        O_RDONLY,
        IMAGE,
        b"/private-image".to_vec(),
    );
    let token = prepare_fd(&mut proc, &mut locks, &mut host, fd);
    observe(&mut proc, &mut host, token);
    bind_prepared_image(
        &mut proc,
        &mut locks,
        &mut host,
        100,
        token,
        OpenFileDescRef(image),
        &plan,
        &receipt,
    )
    .unwrap();
    host.source_bytes_read = 0;
    host.corrupt_image_after_source_bytes = Some(host.source.len() + 1);
    assert_eq!(
        commit_process(&mut proc, &mut locks, &mut host, 100, 100, token),
        Err(Errno::ETXTBSY)
    );
    assert_eq!(host.image_revision, 1);
    assert!(proc.exe.is_none());
    assert_eq!(proc.exec_generation, 0);
    crate::syscalls::release_prepared_exec_ofd_with_locks(
        &mut proc,
        &mut locks,
        &mut host,
        OpenFileDescRef(image),
    )
    .unwrap();
    sys_exit_with_locks(&mut proc, &mut locks, &mut host, 0);
}
