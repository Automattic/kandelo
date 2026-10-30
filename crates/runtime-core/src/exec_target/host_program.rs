use super::*;
use wasm_posix_shared::flags::O_RDONLY;

pub fn prepare_host_program(
    proc: &mut Process,
    locks: &mut AdvisoryLockManager,
    host: &mut dyn HostIO,
    owner: PreparedExecOwner,
    handle: i64,
    name: &[u8],
) -> Result<u32, Errno> {
    if handle < 0 {
        return Err(Errno::EBADF);
    }
    let opened = (|| {
        proc.prepared_exec_targets.ensure_insert_capacity()?;
        owner_matches_ledger_pid(owner, proc.pid)?;
        let PreparedExecOwner::Spawn { parent_pid, .. } = owner else {
            return Err(Errno::EINVAL);
        };
        owner.validate_spawn(parent_pid, proc.pid, proc.exec_generation)?;
        if proc.ppid != parent_pid
            || !proc.spawn_publication_pending
            || proc.exec_generation != 0
            || proc.exe.is_some()
        {
            return Err(Errno::EINVAL);
        }
        if name.is_empty() || name.len() > platform_limits::PATH_MAX_BYTES || name.contains(&0) {
            return Err(Errno::EINVAL);
        }
        let (stat, statfs) = source_authority(proc, host, handle, name)?;
        if stat.st_mode & 0o6222 != 0 || stat.st_nlink != 0 {
            return Err(Errno::EACCES);
        }
        let length = name
            .len()
            .checked_add(crate::procfs::EXE_DELETED_SUFFIX.len())
            .ok_or(Errno::ENOMEM)?;
        let mut path = crate::IoBuffer::try_with_capacity(length)?;
        path.extend_from_slice(name);
        path.extend_from_slice(crate::procfs::EXE_DELETED_SUFFIX);
        let mut prepared = proc.ofd_table.prepare(FileType::Regular, O_RDONLY, &path)?;
        let file_id = (stat.st_ino != 0).then_some(FileId::Host {
            dev: stat.st_dev,
            ino: stat.st_ino,
        });
        prepared.value_mut().file_id = file_id;
        let ofd_id = prepared.value_mut().ofd_id;
        let diagnostic_path = prepared.value_mut().path.clone();
        let index = proc.ofd_table.publish(prepared, handle);
        Ok(crate::syscalls::PreparedExecOpen {
            ofd_ref: OpenFileDescRef(index),
            ofd_id,
            file_id,
            stat,
            statfs,
            diagnostic_path,
        })
    })();
    match opened {
        Ok(opened) => insert_opened_target(proc, locks, host, owner, opened),
        Err(error) => {
            let _ = host.host_close(handle);
            Err(error)
        }
    }
}
