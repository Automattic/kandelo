//! Stable, read-only file authority for private grouped mappings. Copies of
//! mapping metadata share one hold; no descriptor number is retained. Final
//! native close effects are queued in storage admitted before acquisition and
//! drained by the outer kernel scope, never by an allocator/metadata Drop.
use crate::{IoBox, io_owner::IoRc, process::{HostIO, Process}};
use crate::descriptor_backing::BackingReleaseEffects;
use crate::ofd::FileType;
use wasm_posix_shared::{Errno, WasmStat, flags};

struct Release {
    effects: BackingReleaseEffects,
    next: Option<IoBox<Release>>,
}
#[cfg(not(test))]
struct Releases(core::cell::UnsafeCell<Option<IoBox<Release>>>);
#[cfg(not(test))]
unsafe impl Sync for Releases {}
#[cfg(not(test))]
static RELEASES: Releases = Releases(core::cell::UnsafeCell::new(None));
#[cfg(test)]
std::thread_local! { static RELEASES: core::cell::RefCell<Option<IoBox<Release>>> = const { core::cell::RefCell::new(None) }; }
fn with_releases<T>(f: impl FnOnce(&mut Option<IoBox<Release>>) -> T) -> T {
    #[cfg(not(test))]
    { f(unsafe { &mut *RELEASES.0.get() }) }
    #[cfg(test)]
    { RELEASES.with(|releases| f(&mut releases.borrow_mut())) }
}

/// The outer serialized kernel scope calls this after dropping process borrows.
/// Removal precedes callbacks; draining requires no allocation or scratch lease.
pub fn drain_releases(host: &mut dyn HostIO) -> Result<(), Errno> {
    let mut failure = None;
    while let Some(mut release) = with_releases(Option::take) {
        with_releases(|head| *head = release.next.take());
        if let Err(error) = release.into_inner().effects.close_with(host) { failure.get_or_insert(error); }
    }
    failure.map_or(Ok(()), Err)
}

#[derive(Debug, Clone, Copy)]
enum Kind { Kernel(i64), Host(i64) }
struct Held {
    kind: Kind,
    ofd: crate::lock::OfdId,
    ofd_held: bool,
    release: Option<IoBox<Release>>,
    acquired: bool,
    immutable_shared: bool,
    _metadata: crate::metadata_budget::MetadataReservation<'static>,
}
impl Drop for Held {
    fn drop(&mut self) {
        if self.ofd_held && crate::ofd::release_in_flight_ofd(self.ofd) { crate::ofd::note_possibly_orphaned_ofd_locks(); }
        if !self.acquired { return; }
        if self.immutable_shared {
            crate::rootfs::release_group_read_lease(match self.kind { Kind::Kernel(handle) => handle, _ => unreachable!() });
        }
        let mut release = self.release.take().expect("private mapping lost admitted close custody");
        match self.kind {
            Kind::Kernel(handle) if crate::executable_backing::is_executable_handle(handle) => {
                release.effects = crate::executable_backing::unpin(handle);
            }
            Kind::Kernel(handle) => crate::kernel_file_mapping::unpin(handle),
            Kind::Host(handle) => {
                if crate::ofd::host_handle_close_ref(handle) { release.effects.push_host_close(handle); }
            }
        }
        with_releases(|head| { release.next = head.take(); *head = Some(release); });
    }
}

#[derive(Clone)]
pub(crate) struct Source(IoRc<Held>);
impl core::fmt::Debug for Source {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result { f.debug_tuple("PrivateMappingSource").field(&self.0.identity()).finish() }
}
impl PartialEq for Source { fn eq(&self, other: &Self) -> bool { self.0.identity() == other.0.identity() } }
impl Eq for Source {}
impl Source {
    pub(crate) fn kernel_handle(&self) -> Option<i64> {
        match self.0.kind { Kind::Kernel(handle) => Some(handle), _ => None }
    }
    pub(crate) fn capture(proc: &Process, fd: i32, host: &mut dyn HostIO) -> Result<(Self, WasmStat), Errno> {
        Self::capture_for_mapping(proc, fd, host, false)
    }
    pub(crate) fn is_immutable_shared(&self) -> bool { self.0.immutable_shared }
    pub(crate) fn capture_for_mapping(proc: &Process, fd: i32, host: &mut dyn HostIO,
        immutable_shared: bool) -> Result<(Self, WasmStat), Errno> {
        let entry = proc.fd_table.get(fd)?;
        let ofd = proc.ofd_table.get(entry.ofd_ref.0).ok_or(Errno::EBADF)?;
        if ofd.is_path_only() { return Err(Errno::EBADF); }
        if !matches!(ofd.file_type, FileType::Regular | FileType::MemFd) { return Err(Errno::ENODEV); }
        if ofd.status_flags() & flags::O_ACCMODE == flags::O_WRONLY { return Err(Errno::EACCES); }
        let kind = match crate::kernel_file_mapping::mapping_handle_for(ofd.file_type, ofd.host_handle) {
            Some(handle) => Kind::Kernel(handle),
            None if ofd.file_type == FileType::Regular && ofd.host_handle >= 0 => Kind::Host(ofd.host_handle),
            _ => return Err(Errno::ENODEV),
        };
        let stat = crate::syscalls::fstat_ofd(proc, host, entry.ofd_ref.0)?;
        if stat.st_mode & wasm_posix_shared::mode::S_IFMT != wasm_posix_shared::mode::S_IFREG { return Err(Errno::ENODEV); }
        // Pay for the file label/Rc as well as the separately admitted source
        // and close node. Cloned VMAs share these credits rather than re-pin.
        let metadata = ofd.path.len().checked_add(11 + core::mem::size_of::<crate::memory::MappingFile>() + 4 * core::mem::size_of::<usize>())
            .and_then(|bytes| bytes.checked_mul(2)).ok_or(Errno::ENOMEM)?;
        let metadata = crate::io_buffer::IO_MEMORY.reserve(metadata)?;
        let release = IoBox::try_new(Release { effects: BackingReleaseEffects::default(), next: None })?;
        let mut held = Held { kind, ofd: ofd.ofd_id, ofd_held: false, release: Some(release), acquired: false, immutable_shared: false, _metadata: metadata };
        // Acquire after all close storage exists. IoRc allocation failure drops
        // this exact hold into the admitted release queue.
        crate::ofd::retain_in_flight_ofd(ofd.ofd_id)?;
        held.ofd_held = true;
        match kind {
            Kind::Kernel(handle) => crate::kernel_file_mapping::pin(handle)?,
            Kind::Host(handle) => crate::ofd::host_handle_fork_ref(handle)?,
        }
        held.acquired = true;
        if immutable_shared {
            let Kind::Kernel(handle) = kind else { return Err(Errno::EOPNOTSUPP); };
            crate::rootfs::acquire_group_read_lease(handle)?;
            held.immutable_shared = true;
        }
        Ok((Self(IoRc::try_new(held)?), stat))
    }

    pub(crate) fn read(&self, offset: u64, output: &mut [u8], host: &mut dyn HostIO) -> Result<usize, Errno> {
        let result = match self.0.kind {
            Kind::Kernel(handle) => crate::kernel_file_mapping::pread(handle, offset, output, host),
            Kind::Host(handle) => host.host_pread(handle, output, i64::try_from(offset).map_err(|_| Errno::EOVERFLOW)?),
        }?;
        if result > output.len() { return Err(Errno::EIO); }
        Ok(result)
    }
}
