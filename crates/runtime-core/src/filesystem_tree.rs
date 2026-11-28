//! Slotted pages and typed keys for the authenticated filesystem tree.
use crate::path::validate_dirent_name;
use wasm_posix_shared::Errno;

pub(crate) const PAGE_BYTES: usize = 1024;
pub(crate) const CHILD_BYTES: usize = 40;
pub(crate) const MAX_VALUE_BYTES: usize = 512;
pub(crate) const MAX_LEVEL: u8 = 16;
const PAGE_HEADER_BYTES: usize = 8;
pub(crate) const ORPHAN_KIND: u8 = 6;
const MAX_KEY_BYTES: usize = 9 + 255;

/// Keys sort by kind, inode number and then raw filename bytes. A directory's
/// names form one contiguous range even when inode numbers are sparse.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NamespaceKey<'a> {
    Inode(u64),
    Orphan(u64),
    Dirent { parent: u64, name: &'a [u8] },
    Block { inode: u64, block: u64 },
    Attribute { inode: u64, kind: u32, chunk: u32 },
    Archive { id: u32, chunk: u32 },
}

#[derive(Clone, Copy)]
pub(crate) struct EncodedKey {
    bytes: [u8; MAX_KEY_BYTES],
    len: usize,
}

impl EncodedKey {
    pub(crate) fn new(key: NamespaceKey<'_>) -> Result<Self, Errno> {
        let numeric;
        let (kind, inode, suffix): (u8, u64, &[u8]) = match key {
            NamespaceKey::Inode(inode) => (1, inode, &[]),
            NamespaceKey::Orphan(inode) => (ORPHAN_KIND, inode, &[]),
            NamespaceKey::Dirent { parent, name } => {
                validate_dirent_name(parent, name)?;
                (2, parent, name)
            }
            NamespaceKey::Block { inode, block } => {
                numeric = block.to_be_bytes();
                (3, inode, &numeric)
            }
            NamespaceKey::Attribute { inode, kind, chunk } => {
                if kind == 0 {
                    return Err(Errno::EINVAL);
                }
                numeric = ((u64::from(kind) << 32) | u64::from(chunk)).to_be_bytes();
                (4, inode, &numeric)
            }
            NamespaceKey::Archive { id, chunk } => {
                numeric = u64::from(chunk).to_be_bytes();
                (5, u64::from(id), &numeric)
            }
        };
        if inode == 0 {
            return Err(Errno::EINVAL);
        }
        let mut bytes = [0; MAX_KEY_BYTES];
        bytes[0] = kind;
        bytes[1..9].copy_from_slice(&inode.to_be_bytes());
        bytes[9..9 + suffix.len()].copy_from_slice(suffix);
        Ok(Self {
            bytes,
            len: 9 + suffix.len(),
        })
    }

    pub(crate) fn from_bytes(bytes: &[u8]) -> Self {
        let mut key = Self {
            bytes: [0; MAX_KEY_BYTES],
            len: bytes.len(),
        };
        key.bytes[..bytes.len()].copy_from_slice(bytes);
        key
    }

    pub(crate) fn bytes(&self) -> &[u8] {
        &self.bytes[..self.len]
    }
}

pub(crate) fn decode_key(bytes: &[u8]) -> Result<NamespaceKey<'_>, Errno> {
    let inode = u64::from_be_bytes(bytes.get(1..9).ok_or(Errno::EIO)?.try_into().unwrap());
    match (bytes[0], &bytes[9..]) {
        (1, []) if inode != 0 => Ok(NamespaceKey::Inode(inode)),
        (ORPHAN_KIND, []) if inode != 0 => Ok(NamespaceKey::Orphan(inode)),
        (2, name) => {
            validate_dirent_name(inode, name).map_err(|_| Errno::EIO)?;
            Ok(NamespaceKey::Dirent {
                parent: inode,
                name,
            })
        }
        (3, block) if inode != 0 && block.len() == 8 => Ok(NamespaceKey::Block {
            inode,
            block: u64::from_be_bytes(block.try_into().unwrap()),
        }),
        (4, attribute) if inode != 0 && attribute.len() == 8 && attribute[..4] != [0; 4] => {
            Ok(NamespaceKey::Attribute {
                inode,
                kind: u32::from_be_bytes(attribute[..4].try_into().unwrap()),
                chunk: u32::from_be_bytes(attribute[4..].try_into().unwrap()),
            })
        }
        (5, chunk) if inode != 0 && chunk.len() == 8 && chunk[..4] == [0; 4] => {
            Ok(NamespaceKey::Archive {
                id: u32::try_from(inode).map_err(|_| Errno::EIO)?,
                chunk: u32::from_be_bytes(chunk[4..].try_into().unwrap()),
            })
        }
        _ => Err(Errno::EIO),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct PageRef {
    pub(crate) number: u64,
    pub(crate) digest: [u8; 32],
}

impl PageRef {
    pub(crate) fn encode(self) -> [u8; CHILD_BYTES] {
        let mut bytes = [0; CHILD_BYTES];
        bytes[..8].copy_from_slice(&self.number.to_le_bytes());
        bytes[8..].copy_from_slice(&self.digest);
        bytes
    }

    pub(crate) fn decode(bytes: &[u8], parent: u64) -> Result<Self, Errno> {
        if bytes.len() != CHILD_BYTES {
            return Err(Errno::EIO);
        }
        let number = u64::from_le_bytes(bytes[..8].try_into().unwrap());
        if number >= parent {
            return Err(Errno::EIO);
        }
        Ok(Self {
            number,
            digest: bytes[8..].try_into().unwrap(),
        })
    }
}

pub(crate) struct PageBuilder {
    pub(crate) bytes: [u8; PAGE_BYTES],
    end: usize,
    pub(crate) count: usize,
}

impl PageBuilder {
    pub(crate) fn new(level: u8) -> Self {
        let mut bytes = [0; PAGE_BYTES];
        bytes[0] = level;
        Self {
            bytes,
            end: PAGE_HEADER_BYTES,
            count: 0,
        }
    }

    pub(crate) fn push(&mut self, key: &EncodedKey, value: &[u8]) -> bool {
        self.push_bytes(key.bytes(), value)
    }

    pub(crate) fn push_bytes(&mut self, key: &[u8], value: &[u8]) -> bool {
        let record_end = self.end + 4 + key.len() + value.len();
        let slot = PAGE_BYTES - (self.count + 1) * 2;
        if record_end > slot {
            return false;
        }
        let start = self.end;
        self.bytes[slot..slot + 2].copy_from_slice(&(start as u16).to_le_bytes());
        self.bytes[start..start + 2].copy_from_slice(&(key.len() as u16).to_le_bytes());
        self.bytes[start + 2..start + 4].copy_from_slice(&(value.len() as u16).to_le_bytes());
        self.bytes[start + 4..start + 4 + key.len()].copy_from_slice(key);
        self.bytes[start + 4 + key.len()..record_end].copy_from_slice(value);
        self.end = record_end;
        self.count += 1;
        true
    }

    /// Split an overflowing sorted sequence by occupied bytes. Keep the
    /// lower keys in this builder and return the upper keys, including the
    /// incoming final record. Both halves retain the existing page format.
    pub(crate) fn split_with_record(&mut self, key: &[u8], value: &[u8]) -> Result<Self, Errno> {
        let level = self.bytes[0];
        let combined = self.end - PAGE_HEADER_BYTES + 2 * self.count + 6 + key.len() + value.len();
        self.finish();
        let page = Page::open(&self.bytes, level)?;
        let mut left = Self::new(level);
        let mut right = Self::new(level);
        let mut left_bytes = 0;
        for slot in 0..page.count {
            let (old_key, old_value) = page.record(slot)?;
            let target = if left_bytes < combined.div_ceil(2) {
                left_bytes += 6 + old_key.len() + old_value.len();
                &mut left
            } else {
                &mut right
            };
            if !target.push_bytes(old_key, old_value) {
                return Err(Errno::EIO);
            }
        }
        if !right.push_bytes(key, value) {
            return Err(Errno::EIO);
        }
        *self = left;
        Ok(right)
    }

    pub(crate) fn first_key(&self) -> EncodedKey {
        let length = u16::from_le_bytes(self.bytes[8..10].try_into().unwrap()) as usize;
        EncodedKey::from_bytes(&self.bytes[12..12 + length])
    }

    pub(crate) fn finish(&mut self) {
        self.bytes[2..4].copy_from_slice(&(self.count as u16).to_le_bytes());
        self.bytes[4..6].copy_from_slice(&(self.end as u16).to_le_bytes());
    }
}

pub(crate) struct Page<'a> {
    bytes: &'a [u8],
    end: usize,
    pub(crate) count: usize,
}

impl<'a> Page<'a> {
    pub(crate) fn open(bytes: &'a [u8], level: u8) -> Result<Self, Errno> {
        if bytes.len() != PAGE_BYTES || bytes[0] != level || bytes[1] != 0 || bytes[6..8] != [0; 2]
        {
            return Err(Errno::EIO);
        }
        let count = u16::from_le_bytes(bytes[2..4].try_into().unwrap()) as usize;
        let end = u16::from_le_bytes(bytes[4..6].try_into().unwrap()) as usize;
        let slots = PAGE_BYTES.checked_sub(2 * count).ok_or(Errno::EIO)?;
        if end < PAGE_HEADER_BYTES || end > slots || (level != 0 && count == 0) {
            return Err(Errno::EIO);
        }
        Ok(Self { bytes, end, count })
    }

    pub(crate) fn verify_records(&self, reference: PageRef, level: u8) -> Result<(), Errno> {
        let mut previous_key = None;
        let mut next_offset = PAGE_HEADER_BYTES;
        for slot in 0..self.count {
            let offset = self.offset(slot);
            let (key, value) = self.record(slot)?;
            if offset != next_offset || previous_key.is_some_and(|previous| previous >= key) {
                return Err(Errno::EIO);
            }
            decode_key(key)?;
            if level != 0 {
                PageRef::decode(value, reference.number)?;
            }
            next_offset = offset + 4 + key.len() + value.len();
            previous_key = Some(key);
        }
        if next_offset != self.end {
            return Err(Errno::EIO);
        }
        Ok(())
    }

    fn offset(&self, slot: usize) -> usize {
        let slot = PAGE_BYTES - (slot + 1) * 2;
        u16::from_le_bytes(self.bytes[slot..slot + 2].try_into().unwrap()) as usize
    }

    pub(crate) fn bytes(&self) -> &[u8] {
        self.bytes
    }

    /// Location of the value of a record already validated by `record`.
    pub(crate) fn value_offset(&self, slot: usize, key_length: usize) -> usize {
        self.offset(slot) + 4 + key_length
    }

    pub(crate) fn record(&self, slot: usize) -> Result<(&'a [u8], &'a [u8]), Errno> {
        if slot >= self.count {
            return Err(Errno::EIO);
        }
        let offset = self.offset(slot);
        let record = self.bytes.get(offset..self.end).ok_or(Errno::EIO)?;
        let header = record.get(..4).ok_or(Errno::EIO)?;
        let key_length = u16::from_le_bytes(header[..2].try_into().unwrap()) as usize;
        let value_length = u16::from_le_bytes(header[2..].try_into().unwrap()) as usize;
        if !(9..=MAX_KEY_BYTES).contains(&key_length)
            || !(1..=MAX_VALUE_BYTES).contains(&value_length)
        {
            return Err(Errno::EIO);
        }
        let key_end = 4 + key_length;
        let value = record
            .get(key_end..key_end + value_length)
            .ok_or(Errno::EIO)?;
        Ok((&record[4..key_end], value))
    }

    pub(crate) fn lower_bound(&self, key: &[u8]) -> Result<usize, Errno> {
        let (mut low, mut high) = (0, self.count);
        while low < high {
            let mid = low + (high - low) / 2;
            if self.record(mid)?.0 < key {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        Ok(low)
    }
}
