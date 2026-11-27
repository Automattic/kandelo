use super::IntegrityPolicy;
use sha2::{Digest, Sha256};

const fn crc32c_tables() -> [[u32; 256]; 4] {
    let mut tables = [[0; 256]; 4];
    let mut index = 0;
    while index < tables[0].len() {
        let mut value = index as u32;
        let mut bit = 0;
        while bit < 8 {
            value = (value >> 1) ^ (0x82F63B78u32.wrapping_mul(value & 1));
            bit += 1;
        }
        tables[0][index] = value;
        index += 1;
    }
    // Each following row advances a contribution by one more zero byte.
    let mut row = 1;
    while row < tables.len() {
        let mut index = 0;
        while index < 256 {
            let previous = tables[row - 1][index];
            tables[row][index] = tables[0][(previous & 255) as usize] ^ (previous >> 8);
            index += 1;
        }
        row += 1;
    }
    tables
}

static CRC32C: [[u32; 256]; 4] = crc32c_tables();

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
                // Slicing by four computes four independent table lookups per word.
                let (words, tail) = bytes.as_chunks::<4>();
                for word in words {
                    let [a, b, c, d] = (*state ^ u32::from_le_bytes(*word)).to_le_bytes();
                    *state = CRC32C[3][a as usize] ^ CRC32C[2][b as usize]
                        ^ CRC32C[1][c as usize] ^ CRC32C[0][d as usize];
                }
                for byte in tail {
                    *state = CRC32C[0][((*state ^ *byte as u32) & 255) as usize] ^ (*state >> 8);
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
