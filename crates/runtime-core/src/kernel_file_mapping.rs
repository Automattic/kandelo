//! Stable mapping handles for regular files the kernel owns.
//!
//! A `MAP_SHARED` mapping must keep reaching the same file after the
//! descriptor that created it is closed, and after the file is unlinked or
//! renamed (POSIX: `mmap` adds a reference to the file that a later `close`
//! does not remove). The shared-mapping table
//! ([`crate::memory::SharedMappingTable`]) therefore keys each backing on a
//! *stable handle* it can read, write and keep alive on its own, never on a
//! guest descriptor number a later `close` or `dup2` could retire or repoint.
//!
//! For the files the kernel owns itself — the root filesystem, the tmpfs
//! scratch mounts (`/tmp`, `/dev/shm`, ...) and memfds — that handle is a
//! *kernel mapping handle*, defined here. Rootfs and tmpfs file handles are
//! already per-inode and machine-unique, so they serve as-is. A memfd handle
//! is a small negative index that collides with the other descriptor-backing
//! tables (eventfd, timerfd, ...), so it is moved into its own band.
//!
//! Each object also reports a *content generation* that its storage layer
//! advances on every write, truncation and `O_TRUNC` open. Because every
//! writer of these files runs in the kernel, comparing it is enough for the
//! mapping table to see descriptor I/O, without a hook in each file syscall.

use alloc::string::String;
use wasm_posix_shared::Errno;

use crate::descriptor_backing::with_memfds;
use crate::ofd::FileType;
use crate::process::HostIO;

/// Base of the memfd mapping-handle band, encoded like the rootfs and tmpfs
/// bands as `-(BASE + index)`. Disjoint from both (`2e9`, `4e9`) and from
/// `SYNTHETIC_REGULAR_HANDLE_BASE` (`1e9`).
const MEMFD_MAPPING_HANDLE_BASE: i64 = 6_000_000_000;

/// Width of each handle band; matches the inode-index space of rootfs/tmpfs.
const BAND_WIDTH: i64 = 1_000_000_000;

enum Object {
    Rootfs(i64),
    Tmpfs(i64),
    MemFd(usize),
}

fn decode(handle: i64) -> Result<Object, Errno> {
    if crate::rootfs::is_rootfs_file_handle(handle) {
        return Ok(Object::Rootfs(handle));
    }
    if crate::tmpfs::is_tmpfs_file_handle(handle) {
        return Ok(Object::Tmpfs(handle));
    }
    let offset = handle
        .checked_neg()
        .and_then(|value| value.checked_sub(MEMFD_MAPPING_HANDLE_BASE))
        .filter(|value| (0..BAND_WIDTH).contains(value))
        .ok_or(Errno::EBADF)?;
    usize::try_from(offset)
        .map(Object::MemFd)
        .map_err(|_| Errno::EBADF)
}

/// The kernel mapping handle for an open description, or `None` when the
/// description is not a regular file the kernel owns.
pub fn mapping_handle_for(file_type: FileType, host_handle: i64) -> Option<i64> {
    match file_type {
        FileType::Regular
            if crate::rootfs::is_rootfs_file_handle(host_handle)
                || crate::tmpfs::is_tmpfs_file_handle(host_handle) =>
        {
            Some(host_handle)
        }
        FileType::MemFd => {
            // A memfd OFD carries `-(index + 1)`.
            let index = host_handle.checked_neg()?.checked_sub(1)?;
            if !(0..BAND_WIDTH).contains(&index) {
                return None;
            }
            Some(-(MEMFD_MAPPING_HANDLE_BASE + index))
        }
        _ => None,
    }
}

/// Whether `handle` is a kernel mapping handle rather than a host handle.
pub fn is_kernel_mapping_handle(handle: i64) -> bool {
    decode(handle).is_ok()
}

/// The backing key for a kernel mapping handle.
///
/// The handle names one live object for as long as a backing pins it, so it
/// is a complete identity on its own; no `(st_dev, st_ino)` pair is needed,
/// and none is trusted (memfds report a synthetic inode in a shared device).
pub fn identity_key(handle: i64) -> Option<String> {
    is_kernel_mapping_handle(handle).then(|| alloc::format!("kernel:{handle}"))
}

/// Positional read.
pub fn pread(
    handle: i64,
    offset: u64,
    dst: &mut [u8],
    host: &mut dyn HostIO,
) -> Result<usize, Errno> {
    let offset = i64::try_from(offset).map_err(|_| Errno::EOVERFLOW)?;
    match decode(handle)? {
        Object::Rootfs(h) => crate::rootfs::read(h, offset, dst, |req, buf| match req {
            crate::rootfs::ByteReq::Deferred { uri, offset } => {
                host.fetch_deferred(&uri, buf, offset)
            }
            crate::rootfs::ByteReq::Image { offset } => host.image_read(buf, offset),
        }),
        Object::Tmpfs(h) => crate::tmpfs::read(h, offset, dst),
        Object::MemFd(index) => with_memfds(|table| {
            let backing = table.get(index).ok_or(Errno::EBADF)?;
            let start = usize::try_from(offset).map_err(|_| Errno::EOVERFLOW)?;
            if start >= backing.data.len() {
                return Ok(0);
            }
            let count = dst.len().min(backing.data.len() - start);
            dst[..count].copy_from_slice(&backing.data[start..start + count]);
            Ok(count)
        }),
    }
}

/// Positional write. The mapping table clamps every writeback to the file's
/// size, so this never grows a file on its behalf.
///
/// The modification time is stamped from the host clock first, as for a
/// descriptor write: POSIX marks a shared writable mapping's file for an
/// mtime/ctime update between a store and the next `msync`.
pub fn pwrite(handle: i64, offset: u64, src: &[u8], host: &mut dyn HostIO) -> Result<usize, Errno> {
    let offset_i64 = i64::try_from(offset).map_err(|_| Errno::EOVERFLOW)?;
    let object = decode(handle)?;
    if !matches!(object, Object::MemFd(_)) {
        let (sec, nsec) = host.host_clock_gettime(wasm_posix_shared::clock::CLOCK_REALTIME)?;
        let sec = u64::try_from(sec).map_err(|_| Errno::EINVAL)?;
        let nsec = u32::try_from(nsec).map_err(|_| Errno::EINVAL)?;
        crate::tmpfs::set_now(sec, nsec);
        crate::rootfs::set_now(sec, nsec);
    }
    match object {
        Object::Rootfs(h) => crate::rootfs::write(h, offset_i64, src, |req, buf| match req {
            crate::rootfs::ByteReq::Deferred { uri, offset } => {
                host.fetch_deferred(&uri, buf, offset)
            }
            crate::rootfs::ByteReq::Image { offset } => host.image_read(buf, offset),
        }),
        Object::Tmpfs(h) => crate::tmpfs::write(h, offset_i64, src),
        Object::MemFd(index) => with_memfds(|table| {
            let backing = table.get_mut(index).ok_or(Errno::EBADF)?;
            let start = usize::try_from(offset).map_err(|_| Errno::EOVERFLOW)?;
            let end = start.checked_add(src.len()).ok_or(Errno::EFBIG)?;
            if end > backing.data.len() {
                backing.data.resize(end, 0);
            }
            backing.data[start..end].copy_from_slice(src);
            backing.touch_modified();
            Ok(src.len())
        }),
    }
}

/// Current size and `st_mode` of the object.
pub fn size_and_mode(handle: i64) -> Result<(u64, u32), Errno> {
    match decode(handle)? {
        Object::Rootfs(h) => {
            let stat = crate::rootfs::fstat(h)?;
            Ok((stat.st_size, stat.st_mode))
        }
        Object::Tmpfs(h) => {
            let stat = crate::tmpfs::fstat(h)?;
            Ok((stat.st_size, stat.st_mode))
        }
        Object::MemFd(index) => with_memfds(|table| {
            let backing = table.get(index).ok_or(Errno::EBADF)?;
            Ok((
                backing.data.len() as u64,
                wasm_posix_shared::mode::S_IFREG | 0o600,
            ))
        }),
    }
}

/// Keep the object alive for a backing. See the module documentation.
pub fn pin(handle: i64) -> Result<(), Errno> {
    match decode(handle)? {
        Object::Rootfs(h) => crate::rootfs::pin_mapping(h),
        Object::Tmpfs(h) => crate::tmpfs::pin_mapping(h),
        Object::MemFd(index) => with_memfds(|table| table.pin(index)),
    }
}

/// Drop a [`pin`].
pub fn unpin(handle: i64) {
    match decode(handle) {
        Ok(Object::Rootfs(h)) => crate::rootfs::unpin_mapping(h),
        Ok(Object::Tmpfs(h)) => crate::tmpfs::unpin_mapping(h),
        Ok(Object::MemFd(index)) => with_memfds(|table| table.unpin(index)),
        Err(_) => {}
    }
}

/// The object's content generation. See the module documentation.
pub fn content_generation(handle: i64) -> Option<u64> {
    match decode(handle).ok()? {
        Object::Rootfs(h) => crate::rootfs::content_generation(h).ok(),
        Object::Tmpfs(h) => crate::tmpfs::content_generation(h).ok(),
        Object::MemFd(index) => {
            with_memfds(|table| table.get(index).map(|backing| backing.content_gen))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_memfd_handle_moves_into_its_own_band_and_back() {
        let handle = mapping_handle_for(FileType::MemFd, -1).unwrap();
        assert_eq!(handle, -MEMFD_MAPPING_HANDLE_BASE);
        assert!(matches!(decode(handle), Ok(Object::MemFd(0))));
        let handle = mapping_handle_for(FileType::MemFd, -8).unwrap();
        assert!(matches!(decode(handle), Ok(Object::MemFd(7))));
    }

    #[test]
    fn only_kernel_owned_regular_files_have_a_mapping_handle() {
        assert_eq!(
            mapping_handle_for(FileType::Regular, 5),
            None,
            "a host handle"
        );
        assert_eq!(mapping_handle_for(FileType::EventFd, -1), None);
        assert_eq!(
            mapping_handle_for(FileType::MemFd, 3),
            None,
            "not a memfd encoding"
        );
        assert!(!is_kernel_mapping_handle(5));
        assert!(
            !is_kernel_mapping_handle(-1),
            "a raw memfd index is not a mapping handle"
        );
    }

    #[test]
    fn a_memfd_stays_readable_through_a_pin_after_its_last_descriptor() {
        let index = with_memfds(|table| {
            let mut backing = crate::descriptor_backing::MemFdBacking::new();
            backing.data = b"abc".to_vec();
            table.alloc(backing)
        });
        let ofd_handle = -((index as i64) + 1);
        let handle = mapping_handle_for(FileType::MemFd, ofd_handle).unwrap();
        pin(handle).unwrap();

        // The last descriptor goes: its lifetime ends, the bytes do not.
        assert!(crate::descriptor_backing::release_for_ofd(
            FileType::MemFd,
            ofd_handle
        ));
        assert!(!crate::descriptor_backing::is_live_managed_ofd(
            FileType::MemFd,
            ofd_handle
        ));
        assert_eq!(size_and_mode(handle).unwrap().0, 3);
        let bytes = with_memfds(|table| table.get(index).unwrap().data.clone());
        assert_eq!(bytes, b"abc".to_vec());
        assert!(content_generation(handle).is_some());

        unpin(handle);
        assert!(
            content_generation(handle).is_none(),
            "the last pin frees the memfd"
        );
    }

    #[test]
    fn a_tmpfs_file_outlives_unlink_and_close_while_pinned() {
        let path = b"/tmp/kernel-file-mapping-pin";
        let fd = crate::tmpfs::open(
            path,
            wasm_posix_shared::flags::O_CREAT | wasm_posix_shared::flags::O_RDWR,
            0o600,
            0,
            0,
        )
        .unwrap();
        crate::tmpfs::write(fd, 0, b"live").unwrap();
        let handle = mapping_handle_for(FileType::Regular, fd).unwrap();
        pin(handle).unwrap();
        let before = content_generation(handle).unwrap();

        crate::tmpfs::unlink(path).unwrap();
        crate::tmpfs::release_handle(fd);

        assert_eq!(size_and_mode(handle).unwrap().0, 4);
        crate::tmpfs::write(handle, 0, b"L").unwrap();
        assert_ne!(content_generation(handle).unwrap(), before);

        unpin(handle);
        assert!(
            content_generation(handle).is_none(),
            "the last pin frees the inode"
        );
    }
}
