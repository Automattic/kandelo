//! Point reads of inode and directory records on a live mount. Point edits
//! replace their cached values. A failed transaction drops its cached view.
use crate::IoBuffer;
use wasm_posix_shared::Errno;

const NAME_BYTES: usize = 64;
const VALUE_BYTES: usize = 96;

#[derive(Clone, Copy)]
struct Entry {
    key: [u8; NAME_BYTES],
    length: u8,
    value: [u8; VALUE_BYTES],
    value_len: Option<u8>,
}

pub(super) struct RecordCache {
    entries: IoBuffer<Option<Entry>>,
}

impl RecordCache {
    pub(super) fn new() -> Self {
        Self {
            entries: IoBuffer::new(),
        }
    }

    pub(super) fn clear(&mut self) {
        self.entries.fill(None);
    }

    fn eligible(key: &[u8]) -> bool {
        matches!(key.first(), Some(1 | 2 | 4)) && key.len() <= NAME_BYTES
    }

    fn slot(&self, key: &[u8]) -> usize {
        let mut hash = 2166136261u32;
        for &byte in key {
            hash = (hash ^ u32::from(byte)).wrapping_mul(16777619);
        }
        hash as usize % self.entries.len()
    }

    pub(super) fn lookup(
        &self,
        key: &[u8],
        output: &mut [u8],
    ) -> Result<Option<Option<usize>>, Errno> {
        if self.entries.is_empty() || !Self::eligible(key) {
            return Ok(None);
        }
        let Some(entry) = self.entries[self.slot(key)].as_ref() else {
            return Ok(None);
        };
        if &entry.key[..usize::from(entry.length)] != key {
            return Ok(None);
        }
        let count = entry.value_len.map(usize::from);
        if let Some(count) = count {
            output
                .get_mut(..count)
                .ok_or(Errno::ERANGE)?
                .copy_from_slice(&entry.value[..count]);
        }
        Ok(Some(count))
    }

    pub(super) fn remember(&mut self, key: &[u8], value: Option<&[u8]>) {
        if !Self::eligible(key) {
            return;
        }
        if self.entries.is_empty() {
            let budget = super::record_cache_budget();
            let slots = budget / core::mem::size_of::<Option<Entry>>();
            if slots == 0 {
                return;
            }
            let Ok(entries) = IoBuffer::try_filled(slots, None) else {
                return;
            };
            self.entries = entries;
        }
        let slot = self.slot(key);
        // Range reclamation may delete any attribute. Only cache attribute
        // absence, which survives erasure. A point insertion evicts the miss.
        if value.is_some_and(|bytes| key[0] == 4 || bytes.len() > VALUE_BYTES) {
            self.entries[slot] = None;
            return;
        }
        let mut entry = Entry {
            key: [0; NAME_BYTES],
            length: key.len() as u8,
            value: [0; VALUE_BYTES],
            value_len: value.map(|bytes| bytes.len() as u8),
        };
        entry.key[..key.len()].copy_from_slice(key);
        if let Some(value) = value {
            entry.value[..value.len()].copy_from_slice(value);
        }
        self.entries[slot] = Some(entry);
    }
}
