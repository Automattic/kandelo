use sha2::digest::{generic_array::GenericArray, typenum::U64};
use wasm_posix_shared::Errno;

pub const STATE_BYTES: usize = 112;
pub const CHUNK_BYTES: usize = 60 * 1024;
pub const MAX_INPUT_BYTES: usize = STATE_BYTES + CHUNK_BYTES;
const MAX_LENGTH: u64 = (1u64 << 53) - 1;
const INITIAL: [u32; 8] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

struct State {
    words: [u32; 8],
    length: u64,
    used: usize,
    pending: [u8; 64],
}

impl State {
    fn new() -> Self {
        Self { words: INITIAL, length: 0, used: 0, pending: [0; 64] }
    }

    fn decode(bytes: &[u8]) -> Result<Self, Errno> {
        if bytes.len() != STATE_BYTES { return Err(Errno::EINVAL); }
        let length = u64::from_le_bytes(bytes[32..40].try_into().unwrap());
        let used = u32::from_le_bytes(bytes[40..44].try_into().unwrap()) as usize;
        if length > MAX_LENGTH || used >= 64 || used as u64 != length % 64
            || bytes[44..48] != [0; 4] || bytes[48 + used..].iter().any(|byte| *byte != 0)
        { return Err(Errno::EINVAL); }
        let mut words = [0u32; 8];
        for (index, word) in words.iter_mut().enumerate() {
            *word = u32::from_le_bytes(bytes[index * 4..index * 4 + 4].try_into().unwrap());
        }
        Ok(Self { words, length, used, pending: bytes[48..].try_into().unwrap() })
    }

    fn encode(&self) -> [u8; STATE_BYTES] {
        let mut bytes = [0u8; STATE_BYTES];
        for (index, word) in self.words.iter().enumerate() {
            bytes[index * 4..index * 4 + 4].copy_from_slice(&word.to_le_bytes());
        }
        bytes[32..40].copy_from_slice(&self.length.to_le_bytes());
        bytes[40..44].copy_from_slice(&(self.used as u32).to_le_bytes());
        bytes[48..48 + self.used].copy_from_slice(&self.pending[..self.used]);
        bytes
    }

    fn compress(&mut self, block: &[u8]) {
        let block = GenericArray::<u8, U64>::from_slice(block);
        sha2::compress256(&mut self.words, core::slice::from_ref(block));
    }

    fn update(&mut self, mut bytes: &[u8]) -> Result<(), Errno> {
        self.length = self.length.checked_add(bytes.len() as u64)
            .filter(|length| *length <= MAX_LENGTH).ok_or(Errno::EINVAL)?;
        if self.used != 0 {
            let count = bytes.len().min(64 - self.used);
            self.pending[self.used..self.used + count].copy_from_slice(&bytes[..count]);
            self.used += count;
            bytes = &bytes[count..];
            if self.used == 64 {
                let block = self.pending;
                self.compress(&block);
                self.used = 0;
                self.pending.fill(0);
            }
        }
        while bytes.len() >= 64 {
            self.compress(&bytes[..64]);
            bytes = &bytes[64..];
        }
        if !bytes.is_empty() {
            self.pending[..bytes.len()].copy_from_slice(bytes);
            self.used = bytes.len();
        }
        Ok(())
    }

    fn finish(mut self) -> [u8; 32] {
        let mut block = self.pending;
        block[self.used] = 0x80;
        if self.used >= 56 {
            self.compress(&block);
            block.fill(0);
        }
        block[56..].copy_from_slice(&(self.length * 8).to_be_bytes());
        self.compress(&block);
        let mut result = [0u8; 32];
        for (index, word) in self.words.iter().enumerate() {
            result[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
        }
        result
    }
}

pub fn codec(operation: u32, input: &[u8], output: &mut [u8]) -> Result<usize, Errno> {
    let mut result = [0u8; STATE_BYTES];
    let count = match operation {
        6 if input == [0] => { result = State::new().encode(); STATE_BYTES },
        7 if (STATE_BYTES..=MAX_INPUT_BYTES).contains(&input.len()) => {
            let mut state = State::decode(&input[..STATE_BYTES])?;
            state.update(&input[STATE_BYTES..])?;
            result = state.encode();
            STATE_BYTES
        },
        8 => {
            result[..32].copy_from_slice(&State::decode(input)?.finish());
            32
        },
        _ => return Err(Errno::EINVAL),
    };
    if output.len() < count { return Err(Errno::EINVAL); }
    output[..count].copy_from_slice(&result[..count]);
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn fragmented_digest_matches_sha256_across_padding_and_chunk_boundaries() {
        let bytes: alloc::vec::Vec<u8> = (0..CHUNK_BYTES * 2 + 131).map(|index| (index % 251) as u8).collect();
        for length in [0, 1, 55, 56, 63, 64, 65, 119, 120, CHUNK_BYTES - 1, CHUNK_BYTES, bytes.len()] {
            for chunk in [1, 13, 63, 64, 65, 4096, CHUNK_BYTES] {
                let mut state = State::new();
                for part in bytes[..length].chunks(chunk) {
                    state = State::decode(&state.encode()).unwrap();
                    state.update(part).unwrap();
                }
                assert_eq!(state.finish()[..], Sha256::digest(&bytes[..length])[..]);
            }
        }
    }

    #[test]
    fn malformed_state_and_overflow_leave_output_untouched() {
        let valid = State::new().encode();
        for offset in [32, 40, 44, 48, 111] {
            let mut damaged = valid;
            damaged[offset] = 1;
            let mut output = [0xa5; STATE_BYTES];
            assert_eq!(codec(8, &damaged, &mut output), Err(Errno::EINVAL));
            assert_eq!(output, [0xa5; STATE_BYTES]);
        }
        let mut state = State::new();
        state.length = MAX_LENGTH;
        state.used = (MAX_LENGTH % 64) as usize;
        let mut input = state.encode().to_vec();
        input.push(1);
        let mut output = [0xa5; STATE_BYTES];
        assert_eq!(codec(7, &input, &mut output), Err(Errno::EINVAL));
        assert_eq!(output, [0xa5; STATE_BYTES]);
        assert_eq!(codec(6, &[0], &mut [0; STATE_BYTES - 1]), Err(Errno::EINVAL));
        assert_eq!(codec(7, &alloc::vec![0; MAX_INPUT_BYTES + 1], &mut output), Err(Errno::EINVAL));
    }
}
