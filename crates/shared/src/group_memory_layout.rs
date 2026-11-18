//! Kernel-host configuration of one exact grouped image's virtual layout.
use crate::{Errno, memory_group::ReceiptRecord};
pub const VERSION: u32 = 1;
pub const CAPABILITY: u32 = 4;
pub const BYTES: usize = 96;
pub const FRESH: u32 = 0;
pub const INHERITED: u32 = 1;
pub const FIELDS: &[(&str, usize)] = &[("receipt", 0), ("initialPages", 32), ("maximumPages", 36),
    ("brkBase", 40), ("mmapBase", 48), ("brkLimit", 56), ("controlBase", 64), ("controlEnd", 72),
    ("channel", 80), ("mode", 88), ("reserved", 92)];
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Record {
    pub receipt: ReceiptRecord,
    pub initial_pages: u32,
    pub maximum_pages: u32,
    pub brk_base: u64,
    pub mmap_base: u64,
    pub brk_limit: u64,
    pub control_base: u64,
    pub control_end: u64,
    pub channel: u64,
    pub mode: u32,
}
impl Record {
    pub fn decode(bytes: &[u8]) -> Result<Self, Errno> {
        if bytes.len() != BYTES || bytes[92..] != [0; 4] { return Err(Errno::EINVAL); }
        let u32_at = |at| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
        let u64_at = |at| u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap());
        let record = Self { receipt: ReceiptRecord::decode(&bytes[..32])?, initial_pages: u32_at(32), maximum_pages: u32_at(36),
            brk_base: u64_at(40), mmap_base: u64_at(48), brk_limit: u64_at(56), control_base: u64_at(64),
            control_end: u64_at(72), channel: u64_at(80), mode: u32_at(88) };
        if record.mode > INHERITED || (record.mode == INHERITED
            && [record.brk_base, record.mmap_base, record.brk_limit, record.control_base, record.control_end].iter().any(|value| *value != 0)) {
            return Err(Errno::EINVAL);
        }
        Ok(record)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn bytes() -> [u8; BYTES] {
        let mut bytes = [0; BYTES];
        ReceiptRecord { group: 7, pid: 100, tid: 100, serial: u64::MAX, generation: 1 << 63 }.encode(&mut bytes[..32]).unwrap();
        bytes[32..36].copy_from_slice(&4u32.to_le_bytes()); bytes[36..40].copy_from_slice(&64u32.to_le_bytes());
        bytes[80..88].copy_from_slice(&(1u64 << 40).to_le_bytes()); bytes
    }
    #[test]
    fn layout_record_preserves_unsigned_identity_and_wide_input_before_semantic_checks() {
        let bytes = bytes(); let record = Record::decode(&bytes).unwrap();
        assert_eq!(record.receipt.serial, u64::MAX); assert_eq!(record.receipt.generation, 1 << 63);
        assert_eq!(record.channel, 1 << 40); assert_eq!(record.initial_pages, 4);
    }
    #[test]
    fn layout_record_requires_exact_size_reserved_words_and_known_mode() {
        let mut bytes = bytes();
        assert_eq!(Record::decode(&bytes[..BYTES - 1]), Err(Errno::EINVAL));
        bytes[92] = 1; assert_eq!(Record::decode(&bytes), Err(Errno::EINVAL)); bytes[92] = 0;
        bytes[88] = 2; assert_eq!(Record::decode(&bytes), Err(Errno::EINVAL));
    }
    #[test]
    fn inherited_registration_cannot_reset_kernel_owned_layout_values() {
        let mut bytes = bytes(); bytes[88] = 1;
        assert_eq!(Record::decode(&bytes).unwrap().mode, INHERITED);
        for at in [40, 48, 56, 64, 72] {
            bytes[at] = 1; assert_eq!(Record::decode(&bytes), Err(Errno::EINVAL)); bytes[at] = 0;
        }
    }
}
