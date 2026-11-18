//! Kernel-host records for one prepared grouped mapping. No guest ABI fields.
use crate::{Errno, memory_group::ReceiptRecord};

pub const VERSION: u32 = 1;
pub const CAPABILITY: u32 = 2;
pub const REQUEST_BYTES: usize = 56;
pub const DESCRIPTION_BYTES: usize = 96;
pub const REQUEST_FIELDS: &[(&str, usize)] = &[("syscall", 0), ("reserved", 4), ("args", 8)];
pub const DESCRIPTION_FIELDS: &[(&str, usize)] = &[
    ("receipt", 0), ("token", 32), ("kind", 40), ("prot", 44),
    ("address", 48), ("length", 56), ("oldAddress", 64), ("oldLength", 72),
    ("result", 80), ("flags", 88), ("reserved", 92),
];
pub const KINDS: &[(&str, u32)] = &[("map", 1), ("unmap", 2), ("protect", 3), ("remap", 4), ("break", 5)];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Request { pub syscall: u32, pub args: [u64; 6] }
impl Request {
    pub fn decode(bytes: &[u8]) -> Result<Self, Errno> {
        if bytes.len() != REQUEST_BYTES || bytes[4..8] != [0; 4] { return Err(Errno::EINVAL); }
        let syscall = u32::from_le_bytes(bytes[..4].try_into().unwrap());
        let args = core::array::from_fn(|i| u64::from_le_bytes(bytes[8 + i * 8..16 + i * 8].try_into().unwrap()));
        Ok(Self { syscall, args })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Description {
    pub receipt: ReceiptRecord,
    pub token: u64,
    pub kind: u32,
    pub prot: u32,
    pub address: u64,
    pub length: u64,
    pub old_address: u64,
    pub old_length: u64,
    pub result: u64,
    pub flags: u32,
}
impl Description {
    pub fn encode(&self, out: &mut [u8]) -> Result<(), Errno> {
        if out.len() != DESCRIPTION_BYTES || self.token == 0 || !(1..=5).contains(&self.kind)
            || self.prot & !7 != 0 { return Err(Errno::EINVAL); }
        // Validate the receipt before writing any part of the output.
        let mut receipt = [0; crate::memory_group::RECEIPT_BYTES];
        self.receipt.encode(&mut receipt)?;
        out.fill(0); out[..32].copy_from_slice(&receipt);
        out[32..40].copy_from_slice(&self.token.to_le_bytes());
        out[40..44].copy_from_slice(&self.kind.to_le_bytes());
        out[44..48].copy_from_slice(&self.prot.to_le_bytes());
        for (i, value) in [self.address, self.length, self.old_address, self.old_length, self.result].iter().enumerate() {
            out[48 + i * 8..56 + i * 8].copy_from_slice(&value.to_le_bytes());
        }
        out[88..92].copy_from_slice(&self.flags.to_le_bytes());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_requires_exact_length_and_zero_reserved_words_and_preserves_i64_bits() {
        let mut bytes = [0; REQUEST_BYTES]; bytes[..4].copy_from_slice(&123u32.to_le_bytes());
        for i in 0..6 { bytes[8 + i * 8..16 + i * 8].copy_from_slice(&(u64::MAX - i as u64).to_le_bytes()); }
        let value = Request::decode(&bytes).unwrap();
        assert_eq!(value.syscall, 123); assert_eq!(value.args[5], u64::MAX - 5);
        bytes[4] = 1; assert_eq!(Request::decode(&bytes), Err(Errno::EINVAL));
        assert_eq!(Request::decode(&bytes[..REQUEST_BYTES - 1]), Err(Errno::EINVAL));
    }
    #[test]
    fn description_keeps_unsigned_receipts_tokens_addresses_and_reserved_bytes() {
        let receipt = ReceiptRecord { group: 7, pid: 100, tid: 101, serial: u64::MAX - 1, generation: 1 << 63 };
        let value = Description { receipt, token: u64::MAX, kind: 4, prot: 3,
            address: 1 << 32, length: 1 << 40, old_address: 65536, old_length: 131072, result: 1 << 32, flags: 0 };
        let mut bytes = [0xa5; DESCRIPTION_BYTES]; value.encode(&mut bytes).unwrap();
        assert_eq!(ReceiptRecord::decode(&bytes[..32]).unwrap(), receipt);
        assert_eq!(u64::from_le_bytes(bytes[32..40].try_into().unwrap()), u64::MAX);
        assert_eq!(u64::from_le_bytes(bytes[48..56].try_into().unwrap()), 1 << 32);
        assert_eq!(u64::from_le_bytes(bytes[56..64].try_into().unwrap()), 1 << 40);
        assert_eq!(&bytes[92..], &[0; 4]);
        let before = bytes; let invalid = Description { token: 0, ..value };
        assert_eq!(invalid.encode(&mut bytes), Err(Errno::EINVAL)); assert_eq!(bytes, before);
    }
}
