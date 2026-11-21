//! Kernel-host records for one prepared grouped mapping. No guest ABI fields.
use crate::{Errno, memory_group::ReceiptRecord};

pub const VERSION: u32 = 5;
pub const CAPABILITY: u32 = 2;
pub const REQUEST_BYTES: usize = 64;
pub const DESCRIPTION_BYTES: usize = 136;
pub const REQUEST_FIELDS: &[(&str, usize)] = &[("syscall", 0), ("reserved", 4), ("args", 8), ("observedPages", 56), ("tailReserved", 60)];
pub const DESCRIPTION_FIELDS: &[(&str, usize)] = &[
    ("receipt", 0), ("token", 32), ("kind", 40), ("prot", 44),
    ("address", 48), ("length", 56), ("oldAddress", 64), ("oldLength", 72),
    ("result", 80), ("flags", 88), ("reserved", 92),
    ("populationAddress", 96), ("populationLength", 104),
    ("sharedObject", 112), ("sharedLength", 120), ("sharedOffset", 128),
];
pub const KINDS: &[(&str, u32)] = &[("map", 1), ("unmap", 2), ("protect", 3), ("remap", 4), ("break", 5)];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Request { pub syscall: u32, pub args: [u64; 6], pub observed_pages: u32 }
impl Request {
    pub fn decode(bytes: &[u8]) -> Result<Self, Errno> {
        if bytes.len() != REQUEST_BYTES || bytes[4..8] != [0; 4] || bytes[60..64] != [0; 4] { return Err(Errno::EINVAL); }
        let syscall = u32::from_le_bytes(bytes[..4].try_into().unwrap());
        let args = core::array::from_fn(|i| u64::from_le_bytes(bytes[8 + i * 8..16 + i * 8].try_into().unwrap()));
        let observed_pages = u32::from_le_bytes(bytes[56..60].try_into().unwrap());
        Ok(Self { syscall, args, observed_pages })
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
    pub population_address: u64,
    pub population_length: u64,
    pub shared_object: u64,
    pub shared_length: u64,
    pub shared_offset: u64,
}
impl Description {
    pub fn encode(&self, out: &mut [u8]) -> Result<(), Errno> {
        let valid_shared = if self.shared_object == 0 {
            self.shared_length == 0 && self.shared_offset == 0
                && !(self.kind == 1 && self.flags & crate::mmap::MAP_SHARED != 0)
        } else {
            matches!(self.kind, 1 | 4) && self.shared_length > 0 && self.shared_length % 65536 == 0
                && self.shared_offset % 65536 == 0
                && self.shared_offset.checked_add(self.length).is_some_and(|end| end <= self.shared_length)
                && ((self.population_address == 0 && self.population_length == 0)
                    || (self.kind == 1 && self.flags & crate::mmap::MAP_ANONYMOUS == 0
                        && self.shared_object == self.token && self.population_address == self.address
                        && self.population_length == self.length))
                && (self.kind != 1 || (self.flags & 3 == crate::mmap::MAP_SHARED
                    && (self.flags & crate::mmap::MAP_ANONYMOUS == 0 || self.shared_object == self.token)
                    && self.shared_offset == 0
                    && (self.flags & crate::mmap::MAP_ANONYMOUS == 0 || self.shared_length == self.length)))
        };
        if out.len() != DESCRIPTION_BYTES || self.token == 0 || !(1..=5).contains(&self.kind)
            || self.prot & !7 != 0 || !valid_shared { return Err(Errno::EINVAL); }
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
        out[96..104].copy_from_slice(&self.population_address.to_le_bytes());
        out[104..112].copy_from_slice(&self.population_length.to_le_bytes());
        out[112..120].copy_from_slice(&self.shared_object.to_le_bytes());
        out[120..128].copy_from_slice(&self.shared_length.to_le_bytes());
        out[128..136].copy_from_slice(&self.shared_offset.to_le_bytes());
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
        bytes[56..60].copy_from_slice(&65536u32.to_le_bytes()); assert_eq!(Request::decode(&bytes).unwrap().observed_pages, 65536);
        bytes[60] = 1; assert_eq!(Request::decode(&bytes), Err(Errno::EINVAL)); bytes[60] = 0;
        bytes[4] = 1; assert_eq!(Request::decode(&bytes), Err(Errno::EINVAL));
        assert_eq!(Request::decode(&bytes[..REQUEST_BYTES - 1]), Err(Errno::EINVAL));
    }
    #[test]
    fn description_keeps_unsigned_receipts_tokens_addresses_and_reserved_bytes() {
        let receipt = ReceiptRecord { group: 7, pid: 100, tid: 101, serial: u64::MAX - 1, generation: 1 << 63 };
        let value = Description { receipt, token: u64::MAX, kind: 4, prot: 3,
            address: 1 << 32, length: 1 << 40, old_address: 65536, old_length: 131072, result: 1 << 32, flags: 0,
            population_address: 65536, population_length: 131072, shared_object: 0, shared_length: 0, shared_offset: 0 };
        let mut bytes = [0xa5; DESCRIPTION_BYTES]; value.encode(&mut bytes).unwrap();
        assert_eq!(ReceiptRecord::decode(&bytes[..32]).unwrap(), receipt);
        assert_eq!(u64::from_le_bytes(bytes[32..40].try_into().unwrap()), u64::MAX);
        assert_eq!(u64::from_le_bytes(bytes[48..56].try_into().unwrap()), 1 << 32);
        assert_eq!(u64::from_le_bytes(bytes[56..64].try_into().unwrap()), 1 << 40);
        assert_eq!(&bytes[92..96], &[0; 4]);
        assert_eq!(u64::from_le_bytes(bytes[96..104].try_into().unwrap()), 65536);
        assert_eq!(u64::from_le_bytes(bytes[104..112].try_into().unwrap()), 131072);
        let before = bytes; let invalid = Description { token: 0, ..value };
        assert_eq!(invalid.encode(&mut bytes), Err(Errno::EINVAL)); assert_eq!(bytes, before);
    }
    #[test]
    fn shared_description_preserves_identity_and_rejects_bounds_before_writing() {
        let receipt = ReceiptRecord { group: 7, pid: 100, tid: 100, serial: 19, generation: 3 };
        let value = Description { receipt, token: u64::MAX - 1, kind: 1, prot: 3,
            address: 65536, length: 131072, old_address: 0, old_length: 0, result: 65536,
            flags: crate::mmap::MAP_SHARED | crate::mmap::MAP_ANONYMOUS,
            population_address: 0, population_length: 0,
            shared_object: u64::MAX - 1, shared_length: 131072, shared_offset: 0 };
        let mut bytes = [0xa5; DESCRIPTION_BYTES]; value.encode(&mut bytes).unwrap();
        assert_eq!(u64::from_le_bytes(bytes[112..120].try_into().unwrap()), u64::MAX - 1);
        assert_eq!(u64::from_le_bytes(bytes[120..128].try_into().unwrap()), 131072);
        let before = bytes;
        for invalid in [Description { shared_offset: 65536, ..value },
            Description { shared_object: 0, ..value }, Description { shared_object: 17, ..value },
            Description { flags: crate::mmap::MAP_PRIVATE | crate::mmap::MAP_ANONYMOUS, ..value }] {
            assert_eq!(invalid.encode(&mut bytes), Err(Errno::EINVAL)); assert_eq!(bytes, before);
        }
        let remap = Description { kind: 4, flags: 0, token: 23, length: 65536,
            old_address: 131072, old_length: 65536, shared_offset: 65536, ..value };
        remap.encode(&mut bytes).unwrap();
        assert_eq!(u64::from_le_bytes(bytes[128..136].try_into().unwrap()), 65536);
        let file = Description { flags: crate::mmap::MAP_SHARED, population_address: value.address,
            population_length: value.length, ..value };
        file.encode(&mut bytes).unwrap();
        Description { token: 23, population_address: 0, population_length: 0, ..file }.encode(&mut bytes).unwrap();
        assert_eq!(Description { token: 23, ..file }.encode(&mut bytes), Err(Errno::EINVAL));
        let prefix = Description { length: 65536, flags: crate::mmap::MAP_SHARED,
            population_address: 0, population_length: 0, ..value };
        prefix.encode(&mut bytes).unwrap();
        assert_eq!(u64::from_le_bytes(bytes[56..64].try_into().unwrap()), 65536);
        assert_eq!(u64::from_le_bytes(bytes[120..128].try_into().unwrap()), 131072);
        let before = bytes;
        assert_eq!(Description { flags: value.flags, ..prefix }.encode(&mut bytes), Err(Errno::EINVAL));
        assert_eq!(bytes, before);
    }

}
