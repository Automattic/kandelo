//! Guest-private storage through the existing libc/kernel memfd interface.
use super::SpoolStorage;
use std::{fs::File, io, os::fd::FromRawFd};

/// No directory access, temporary pathname, or process-global configuration.
pub struct MemfdSpoolStorage;

// SAFETY: each memfd_create returns a new empty regular file with one owned
// descriptor and no public pathname. This owner retains no writable alias.
unsafe impl SpoolStorage for MemfdSpoolStorage {
    fn create(&self) -> io::Result<File> {
        // SAFETY: the static name is NUL-terminated and has no other owners.
        let fd = unsafe { libc::memfd_create(c"fork-instrument".as_ptr(), libc::MFD_CLOEXEC) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: ownership of the successful, fresh descriptor transfers once.
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}
