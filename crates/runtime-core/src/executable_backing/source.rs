use super::{EXECUTABLES, RawRegular, index};
use crate::process::HostIO;
use sha2::{Digest, Sha256};
use wasm_posix_shared::{Errno, WasmStat, WasmStatfs};

#[derive(Clone, Copy)]
pub(crate) struct SourceBinding {
    device: u64,
    inode: u64,
    length: u64,
    digest: [u8; 32],
}

impl SourceBinding {
    pub(crate) fn from_observed(stat: &WasmStat, bytes: &[u8]) -> Result<Self, Errno> {
        if stat.st_size != bytes.len() as u64 {
            return Err(Errno::ETXTBSY);
        }
        let mut digest = Sha256::new();
        for chunk in bytes.chunks(64 * 1024) {
            digest.update(chunk);
        }
        Ok(Self {
            device: stat.st_dev,
            inode: stat.st_ino,
            length: stat.st_size,
            digest: digest.finalize().into(),
        })
    }

    pub(super) fn check_identity(self, stat: &WasmStat) -> Result<(), Errno> {
        if stat.st_dev != self.device
            || stat.st_ino != self.inode
            || stat.st_size != self.length
            || stat.st_mode & wasm_posix_shared::mode::S_IFMT != wasm_posix_shared::mode::S_IFREG
        {
            return Err(Errno::ETXTBSY);
        }
        Ok(())
    }
}

fn bound_source(handle: i64) -> Result<(RawRegular, SourceBinding), Errno> {
    EXECUTABLES.with(|table| {
        let pair = table.get(index(handle)?).ok_or(Errno::EBADF)?;
        Ok((pair.source, pair.source_binding.ok_or(Errno::ENOTSUP)?))
    })
}

pub(crate) fn source_stat(handle: i64, host: &mut dyn HostIO) -> Result<WasmStat, Errno> {
    let (source, binding) = bound_source(handle)?;
    let stat = source.stat(host)?;
    binding.check_identity(&stat)?;
    Ok(stat)
}

pub(crate) fn source_statfs(handle: i64, host: &mut dyn HostIO) -> Result<WasmStatfs, Errno> {
    let (source, _) = bound_source(handle)?;
    if crate::rootfs::is_rootfs_file_handle(source.handle) {
        crate::rootfs::statfs_for_exec(b"/")
    } else if crate::tmpfs::is_tmpfs_file_handle(source.handle) {
        crate::tmpfs::fstatfs(source.handle)
    } else {
        host.host_fstatfs(source.handle)
    }
}

pub(crate) fn source_generation(handle: i64) -> Result<Option<u64>, Errno> {
    let (source, _) = bound_source(handle)?;
    if crate::rootfs::is_rootfs_file_handle(source.handle) {
        crate::rootfs::content_generation(source.handle).map(Some)
    } else if crate::tmpfs::is_tmpfs_file_handle(source.handle) {
        crate::tmpfs::content_generation(source.handle).map(Some)
    } else {
        Ok(None)
    }
}

pub(crate) fn verify_source(handle: i64, host: &mut dyn HostIO) -> Result<(), Errno> {
    let (source, binding) = bound_source(handle)?;
    binding.check_identity(&source.stat(host)?)?;
    let mut digest = Sha256::new();
    let mut scratch = [0; 64 * 1024];
    let mut offset = 0;
    while offset < binding.length {
        let wanted = scratch
            .len()
            .min(usize::try_from(binding.length - offset).unwrap_or(usize::MAX));
        let count = source.read(
            i64::try_from(offset).map_err(|_| Errno::EOVERFLOW)?,
            &mut scratch[..wanted],
            host,
        )?;
        if count == 0 || count > wanted {
            return Err(Errno::ETXTBSY);
        }
        digest.update(&scratch[..count]);
        offset += count as u64;
    }
    if <[u8; 32]>::from(digest.finalize()) != binding.digest {
        return Err(Errno::ETXTBSY);
    }
    binding.check_identity(&source.stat(host)?)
}
