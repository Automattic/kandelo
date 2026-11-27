//! Decode the address needed for one fetch. The opaque export payload stays on disk.
use super::{DEFERRED_FILE, Key, KifsNamespace, MAX_VALUE_BYTES, PositionedStorage};
use crate::{IoBuffer, sdef};
use wasm_posix_shared::Errno;

const HEADER_BYTES: usize = 48;

pub(crate) struct Descriptor {
    pub reference: u64, // Archive id for a file, declared byte size for an archive.
    pub address: IoBuffer<u8>, // Standalone URI, archive member path, or archive URI.
    pub digest: [u8; 32],
}

impl<S: PositionedStorage> KifsNamespace<S> {
    pub(crate) fn deferred_file(&mut self, inode: u64) -> Result<Option<Descriptor>, Errno> {
        self.descriptor(
            |chunk| Key::Attribute {
                inode,
                kind: DEFERRED_FILE,
                chunk,
            },
            false,
        )
    }

    pub(crate) fn archive(&mut self, id: u32) -> Result<Descriptor, Errno> {
        self.descriptor(|chunk| Key::Archive { id, chunk }, true)?
            .ok_or(Errno::EIO)
    }

    fn descriptor(
        &mut self,
        key: impl Fn(u32) -> Key<'static>,
        archive: bool,
    ) -> Result<Option<Descriptor>, Errno> {
        let mut page = [0; MAX_VALUE_BYTES];
        let Some(first) = self.volume.lookup(key(0), &mut page)? else {
            return Ok(None);
        };
        if first < HEADER_BYTES {
            return Err(Errno::EIO);
        }
        let word = |at| u32::from_le_bytes(page[at..at + 4].try_into().unwrap());
        let (reference, path) = if archive {
            (u64::from_le_bytes(page[..8].try_into().unwrap()), 0)
        } else {
            (u64::from(word(0)), word(4))
        };
        let uri = word(8);
        let payload = word(12);
        if uri > sdef::MAX_URI_LEN
            || path > sdef::MAX_SOURCE_PATH_LEN
            || payload > sdef::MAX_PAYLOAD_LEN
            || (!archive && ((reference == 0) != (path == 0) || (reference != 0 && uri != 0)))
        {
            return Err(Errno::EIO);
        }
        let digest = page[16..HEADER_BYTES].try_into().unwrap();
        let mut address = IoBuffer::try_filled((path + uri) as usize, 0)?;
        let end = HEADER_BYTES + address.len();
        let total = end + payload as usize;
        // Validate the framing before exposing an address. Consume opaque chunks
        // one at a time, including the last chunk when the address ends earlier.
        for chunk in 0..total.div_ceil(MAX_VALUE_BYTES) {
            let start = chunk * MAX_VALUE_BYTES;
            let length = if chunk == 0 {
                first
            } else {
                self.volume
                    .lookup(key(chunk as u32), &mut page)?
                    .ok_or(Errno::EIO)?
            };
            if length != MAX_VALUE_BYTES.min(total - start) {
                return Err(Errno::EIO);
            }
            let from = start.max(HEADER_BYTES);
            let to = (start + length).min(end);
            if from < to {
                address[from - HEADER_BYTES..to - HEADER_BYTES]
                    .copy_from_slice(&page[from - start..to - start]);
            }
        }
        Ok(Some(Descriptor {
            reference,
            address,
            digest,
        }))
    }
}
