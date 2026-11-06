use super::IntegrityPolicy;
use sha2::{Digest, Sha256};

const fn crc32c_table() -> [u32; 256] {
    let mut table = [0; 256];
    let mut index = 0;
    while index < table.len() {
        let mut value = index as u32;
        let mut bit = 0;
        while bit < 8 {
            value = (value >> 1) ^ (0x82F63B78u32.wrapping_mul(value & 1));
            bit += 1;
        }
        table[index] = value;
        index += 1;
    }
    table
}

const CRC32C_TABLE: [u32; 256] = crc32c_table();

pub(super) enum Checksum {
    Crc32c(u32),
    Sha256(Sha256),
}

impl Checksum {
    pub(super) fn new(policy: IntegrityPolicy) -> Self {
        match policy {
            IntegrityPolicy::Crc32c => Self::Crc32c(u32::MAX),
            IntegrityPolicy::Sha256 => Self::Sha256(Sha256::new()),
        }
    }

    pub(super) fn update(&mut self, bytes: impl AsRef<[u8]>) {
        let bytes = bytes.as_ref();
        match self {
            Self::Crc32c(state) => {
                for byte in bytes {
                    *state = CRC32C_TABLE[((*state ^ *byte as u32) & 255) as usize] ^ (*state >> 8);
                }
            }
            Self::Sha256(state) => state.update(bytes),
        }
    }

    pub(super) fn finalize(self) -> [u8; 32] {
        match self {
            Self::Crc32c(state) => {
                let mut digest = [0; 32];
                digest[..4].copy_from_slice(&(!state).to_le_bytes());
                digest
            }
            Self::Sha256(state) => state.finalize().into(),
        }
    }
}
