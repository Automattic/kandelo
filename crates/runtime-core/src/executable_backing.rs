use crate::descriptor_backing::{BackingReleaseEffects, GlobalBackingTable};
use crate::fd::OpenFileDescRef;
use crate::lock::OfdId;
use crate::ofd::FileType;
use crate::process::{HostIO, Process};
use wasm_posix_shared::{Errno, WasmStat};

mod source;
pub(crate) use source::SourceBinding;
pub(crate) use source::{source_generation, source_stat, source_statfs, verify_source};

pub const EXECUTABLE_HANDLE_BASE: i64 = 8_000_000_000;
const BAND_WIDTH: i64 = 1_000_000_000;

#[derive(Clone, Copy, Debug)]
struct RawRegular {
    handle: i64,
}

impl RawRegular {
    fn from_ofd(
        proc: &Process,
        reference: OpenFileDescRef,
        allow_path_only: bool,
    ) -> Result<(Self, OfdId), Errno> {
        let ofd = proc.ofd_table.get(reference.0).ok_or(Errno::EBADF)?;
        if ofd.file_type != FileType::Regular
            || (ofd.is_path_only() && !allow_path_only)
            || (!ofd.is_path_only()
                && ofd.status_flags() & wasm_posix_shared::flags::O_ACCMODE
                    == wasm_posix_shared::flags::O_WRONLY)
        {
            return Err(Errno::EBADF);
        }
        let handle = ofd.host_handle;
        if handle < 0
            && !crate::rootfs::is_rootfs_file_handle(handle)
            && !crate::tmpfs::is_tmpfs_file_handle(handle)
        {
            return Err(Errno::EBADF);
        }
        Ok((Self { handle }, ofd.ofd_id))
    }

    fn stat(self, host: &mut dyn HostIO) -> Result<WasmStat, Errno> {
        if crate::rootfs::is_rootfs_file_handle(self.handle) {
            crate::rootfs::fstat(self.handle)
        } else if crate::tmpfs::is_tmpfs_file_handle(self.handle) {
            crate::tmpfs::fstat(self.handle)
        } else {
            host.host_fstat(self.handle)
        }
    }

    fn retain(self) -> Result<(), Errno> {
        if !crate::descriptor_backing::add_ref_for_ofd(FileType::Regular, self.handle)? {
            crate::ofd::host_handle_fork_ref(self.handle)?;
        }
        Ok(())
    }

    fn release(self, effects: &mut BackingReleaseEffects) {
        if self.handle >= 0 {
            if crate::ofd::host_handle_close_ref(self.handle) {
                effects.push_host_close(self.handle);
            }
        } else {
            crate::descriptor_backing::release_for_ofd(FileType::Regular, self.handle);
        }
    }

    fn read(self, offset: i64, bytes: &mut [u8], host: &mut dyn HostIO) -> Result<usize, Errno> {
        if offset < 0 {
            return Err(Errno::EINVAL);
        }
        if crate::rootfs::is_rootfs_file_handle(self.handle) {
            crate::rootfs::read(
                self.handle,
                offset,
                bytes,
                |request, output| match request {
                    crate::rootfs::ByteReq::Image { offset } => host.image_read(output, offset),
                    crate::rootfs::ByteReq::Deferred { uri, offset } => {
                        host.fetch_deferred(&uri, output, offset)
                    }
                    crate::rootfs::ByteReq::DiscardDeferred { uri } => {
                        host.discard_deferred(&uri);
                        Ok(0)
                    }
                },
            )
        } else if crate::tmpfs::is_tmpfs_file_handle(self.handle) {
            crate::tmpfs::read(
                self.handle,
                offset,
                bytes,
                &mut |source, position, output| host.exchange_source_read(source, position, output),
            )
        } else {
            host.host_pread(self.handle, bytes, offset)
        }
    }
}

struct ExecutableBacking {
    source: RawRegular,
    image: RawRegular,
    source_ofd: OfdId,
    image_length: u64,
    image_identity: ImageIdentity,
    source_binding: Option<SourceBinding>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct ImageIdentity {
    device: u64,
    inode: u64,
    mode: u32,
    size: u64,
    mtime: (u64, u32),
    ctime: (u64, u32),
    generation: Option<u64>,
}

impl ImageIdentity {
    fn observe(image: RawRegular, stat: &WasmStat) -> Result<Self, Errno> {
        let generation = if crate::rootfs::is_rootfs_file_handle(image.handle) {
            Some(crate::rootfs::content_generation(image.handle)?)
        } else if crate::tmpfs::is_tmpfs_file_handle(image.handle) {
            Some(crate::tmpfs::content_generation(image.handle)?)
        } else {
            None
        };
        Ok(Self {
            device: stat.st_dev,
            inode: stat.st_ino,
            mode: stat.st_mode,
            size: stat.st_size,
            mtime: (stat.st_mtime_sec, stat.st_mtime_nsec),
            ctime: (stat.st_ctime_sec, stat.st_ctime_nsec),
            generation,
        })
    }
}

static EXECUTABLES: GlobalBackingTable<ExecutableBacking> = GlobalBackingTable::new();

pub fn is_executable_handle(handle: i64) -> bool {
    handle <= -EXECUTABLE_HANDLE_BASE && handle > -(EXECUTABLE_HANDLE_BASE + BAND_WIDTH)
}

fn index(handle: i64) -> Result<usize, Errno> {
    if !is_executable_handle(handle) {
        return Err(Errno::EBADF);
    }
    usize::try_from(-handle - EXECUTABLE_HANDLE_BASE).map_err(|_| Errno::EBADF)
}

pub fn is_live(handle: i64) -> bool {
    index(handle).is_ok_and(|index| EXECUTABLES.with(|table| table.is_owned(index)))
}

pub fn create(
    proc: &Process,
    source: OpenFileDescRef,
    image: OpenFileDescRef,
    host: &mut dyn HostIO,
) -> Result<i64, Errno> {
    create_with_binding(proc, source, image, None, host)
}

pub(crate) fn create_bound(
    proc: &Process,
    source: OpenFileDescRef,
    image: OpenFileDescRef,
    binding: SourceBinding,
    host: &mut dyn HostIO,
) -> Result<i64, Errno> {
    create_with_binding(proc, source, image, Some(binding), host)
}

fn create_with_binding(
    proc: &Process,
    source: OpenFileDescRef,
    image: OpenFileDescRef,
    source_binding: Option<SourceBinding>,
    host: &mut dyn HostIO,
) -> Result<i64, Errno> {
    let (source, source_ofd) = RawRegular::from_ofd(proc, source, source_binding.is_some())?;
    let (image, _) = RawRegular::from_ofd(proc, image, false)?;
    let source_stat = source.stat(host)?;
    let image_stat = image.stat(host)?;
    if source_stat.st_mode & wasm_posix_shared::mode::S_IFMT != wasm_posix_shared::mode::S_IFREG
        || image_stat.st_mode & wasm_posix_shared::mode::S_IFMT != wasm_posix_shared::mode::S_IFREG
    {
        return Err(Errno::EACCES);
    }
    if let Some(binding) = source_binding {
        binding.check_identity(&source_stat)?;
    }
    let image_identity = ImageIdentity::observe(image, &image_stat)?;
    let slot = EXECUTABLES.with(|table| {
        table.try_alloc(ExecutableBacking {
            source,
            image,
            source_ofd,
            image_length: image_stat.st_size,
            image_identity,
            source_binding,
        })
    })?;
    if slot >= BAND_WIDTH as usize {
        drop(EXECUTABLES.with(|table| table.release_take(slot)));
        return Err(Errno::ENFILE);
    }
    let mut source_retained = false;
    let mut image_retained = false;
    let result = (|| {
        source.retain()?;
        source_retained = true;
        image.retain()?;
        image_retained = true;
        crate::ofd::retain_in_flight_ofd(source_ofd)?;
        Ok(())
    })();
    if let Err(error) = result {
        drop(EXECUTABLES.with(|table| table.release_take(slot)));
        let mut effects = BackingReleaseEffects::default();
        if source_retained {
            source.release(&mut effects);
        }
        if image_retained {
            image.release(&mut effects);
        }
        let _ = effects.close_with(host);
        return Err(error);
    }
    Ok(-(EXECUTABLE_HANDLE_BASE + slot as i64))
}

pub fn add_ref(handle: i64) -> Result<(), Errno> {
    EXECUTABLES.with(|table| table.add_ref(index(handle)?))
}

pub fn pin(handle: i64) -> Result<(), Errno> {
    EXECUTABLES.with(|table| table.pin(index(handle)?))
}

fn release_value(
    value: Option<ExecutableBacking>,
    final_ofd_reference: bool,
) -> BackingReleaseEffects {
    let mut effects = BackingReleaseEffects::default();
    effects.final_ofd_reference = final_ofd_reference;
    if let Some(value) = value {
        value.source.release(&mut effects);
        value.image.release(&mut effects);
        if crate::ofd::release_in_flight_ofd(value.source_ofd) {
            crate::ofd::note_possibly_orphaned_ofd_locks();
        }
    }
    effects
}

pub fn release(handle: i64) -> BackingReleaseEffects {
    let Ok(index) = index(handle) else {
        return BackingReleaseEffects::default();
    };
    let result = EXECUTABLES.with(|table| table.release_take(index));
    release_value(result.value, result.final_reference)
}

pub fn unpin(handle: i64) -> BackingReleaseEffects {
    let Ok(index) = index(handle) else {
        return BackingReleaseEffects::default();
    };
    release_value(EXECUTABLES.with(|table| table.unpin_take(index)), false)
}

fn constituents(handle: i64) -> Result<(RawRegular, RawRegular, u64), Errno> {
    EXECUTABLES.with(|table| {
        table
            .get(index(handle)?)
            .map(|value| (value.source, value.image, value.image_length))
            .ok_or(Errno::EBADF)
    })
}

pub(crate) fn validate_image(handle: i64, host: &mut dyn HostIO) -> Result<(), Errno> {
    let (image, expected) = EXECUTABLES.with(|table| {
        table
            .get(index(handle)?)
            .map(|value| (value.image, value.image_identity))
            .ok_or(Errno::EBADF)
    })?;
    let actual = ImageIdentity::observe(image, &image.stat(host)?)?;
    if actual != expected {
        return Err(Errno::ETXTBSY);
    }
    Ok(())
}

pub fn stat(handle: i64, host: &mut dyn HostIO) -> Result<WasmStat, Errno> {
    let (source, _, length) = constituents(handle)?;
    let mut stat = source.stat(host)?;
    validate_image(handle, host)?;
    stat.st_dev = 8;
    stat.st_ino = index(handle)? as u64 + 1;
    stat.st_nlink = 0;
    stat.st_size = length;
    Ok(stat)
}

pub fn source_handle(handle: i64) -> Result<i64, Errno> {
    Ok(constituents(handle)?.0.handle)
}

pub fn image_handle(handle: i64) -> Result<i64, Errno> {
    Ok(constituents(handle)?.1.handle)
}

pub fn image_size(handle: i64) -> Result<u64, Errno> {
    Ok(constituents(handle)?.2)
}

pub fn sync(handle: i64, host: &mut dyn HostIO) -> Result<(), Errno> {
    let image = image_handle(handle)?;
    validate_image(handle, host)?;
    if crate::rootfs::is_rootfs_file_handle(image) {
        crate::rootfs::sync_persistence()
    } else if crate::tmpfs::is_tmpfs_file_handle(image) {
        Ok(())
    } else {
        host.host_fsync(image)
    }
}

pub fn content_generation(handle: i64) -> Option<u64> {
    let image = image_handle(handle).ok()?;
    if crate::rootfs::is_rootfs_file_handle(image) {
        crate::rootfs::content_generation(image).ok()
    } else if crate::tmpfs::is_tmpfs_file_handle(image) {
        crate::tmpfs::content_generation(image).ok()
    } else {
        None
    }
}

pub fn prefetch(
    handle: i64,
    offset: i64,
    length: usize,
    host: &mut dyn HostIO,
) -> Result<(), Errno> {
    let (_, image, _) = constituents(handle)?;
    if crate::rootfs::is_rootfs_file_handle(image.handle) {
        crate::rootfs::prefetch_range(
            image.handle,
            offset,
            length,
            |request, output| match request {
                crate::rootfs::ByteReq::Image { offset } => host.image_read(output, offset),
                crate::rootfs::ByteReq::Deferred { uri, offset } => {
                    host.fetch_deferred(&uri, output, offset)
                }
                crate::rootfs::ByteReq::DiscardDeferred { uri } => {
                    host.discard_deferred(&uri);
                    Ok(0)
                }
            },
        )?;
    }
    Ok(())
}

pub fn read(
    handle: i64,
    offset: i64,
    bytes: &mut [u8],
    host: &mut dyn HostIO,
) -> Result<usize, Errno> {
    let (_, image, length) = constituents(handle)?;
    if offset < 0 {
        return Err(Errno::EINVAL);
    }
    let start = offset as u64;
    if start >= length || bytes.is_empty() {
        return Ok(0);
    }
    let wanted = bytes
        .len()
        .min(usize::try_from(length - start).unwrap_or(usize::MAX));
    validate_image(handle, host)?;
    let count = image.read(offset, &mut bytes[..wanted], host)?;
    if count == 0 || count > wanted {
        return Err(Errno::EIO);
    }
    validate_image(handle, host)?;
    Ok(count)
}

#[cfg(test)]
mod tests;
