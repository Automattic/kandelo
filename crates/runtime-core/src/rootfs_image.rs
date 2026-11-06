use crate::kandelo_image_fs::BlockSource;
use crate::persistent_image::{CacheConfig, ImageIdentity, VerifiedImage};
use spin::Mutex;
use wasm_posix_shared::Errno;

pub type PhysicalImageRead = fn(u64, &mut [u8]) -> Result<usize, Errno>;

struct PhysicalSource {
    length: u64,
    read: PhysicalImageRead,
}

impl BlockSource for PhysicalSource {
    fn len(&self) -> u64 {
        self.length
    }

    fn read_exact_at(&self, offset: u64, destination: &mut [u8]) -> Result<(), Errno> {
        if offset
            .checked_add(destination.len() as u64)
            .filter(|end| *end <= self.length)
            .is_none()
        {
            return Err(Errno::EIO);
        }
        let mut done = 0;
        while done < destination.len() {
            let read = (self.read)(offset + done as u64, &mut destination[done..])?;
            if read == 0 || read > destination.len() - done {
                return Err(Errno::EIO);
            }
            done += read;
        }
        Ok(())
    }
}

static IMAGE: Mutex<Option<VerifiedImage<PhysicalSource>>> = Mutex::new(None);

pub(crate) fn install(
    physical_length: u64,
    expected: [u8; 32],
    config: CacheConfig,
    read: PhysicalImageRead,
) -> Result<ImageIdentity, Errno> {
    let source = PhysicalSource {
        length: physical_length,
        read,
    };
    let image = VerifiedImage::open(source, expected, config)?;
    let identity = image.binding();
    let mut slot = IMAGE.try_lock().ok_or(Errno::EBUSY)?;
    if slot.is_some() {
        return Err(Errno::EBUSY);
    }
    *slot = Some(image);
    Ok(identity)
}

pub(crate) fn read(offset: u64, destination: &mut [u8]) -> Result<Option<()>, Errno> {
    let slot = IMAGE.try_lock().ok_or(Errno::EBUSY)?;
    match slot.as_ref() {
        Some(image) => image.read_exact_at(offset, destination).map(Some),
        None => Ok(None),
    }
}

pub(crate) fn binding() -> Option<ImageIdentity> {
    IMAGE.lock().as_ref().map(VerifiedImage::binding)
}

pub(crate) fn clear() {
    *IMAGE.lock() = None;
}

pub(crate) fn discard_read_caches() {
    if let Some(slot) = IMAGE.try_lock() {
        if let Some(image) = slot.as_ref() {
            let _ = image.discard_read_caches();
        }
    }
}
