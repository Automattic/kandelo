//! Copied layouts emitted by the actual kernel operation, never host inputs.
pub const THREAD_BYTES: usize = 48;
pub const THREAD_FIELDS: &[(&str, usize)] = &[
    ("slotStartPage", 0),
    ("basePage", 4),
    ("tlsOffset", 8),
    ("tlsAllocAddr", 12),
    ("forkSaveOffset", 16),
    ("channelOffset", 20),
    ("processChannelOffset", 24),
    ("fnPtr", 28),
    ("argPtr", 32),
    ("stackPtr", 36),
    ("tlsPtr", 40),
    ("ctidPtr", 44),
];
pub const FORK_OFFSET: usize = 32;
pub const FORK_BYTES: usize = 28;
pub const MAIN: u32 = 0;
pub const THREAD: u32 = 1;
pub const FORK_FIELDS: &[(&str, usize)] = &[
    ("kind", 0),
    ("forkBufAddr", 4),
    ("fnPtr", 8),
    ("argPtr", 12),
    ("slotStart", 16),
    ("slotLen", 20),
    ("channelOffset", 24),
];

#[derive(Clone, Copy)]
pub struct Thread(pub [u32; 12]);
#[derive(Clone, Copy)]
pub struct Fork(pub [u32; 7]);
fn encode(words: &[u32], bytes: &mut [u8]) {
    for (word, bytes) in words.iter().zip(bytes.chunks_exact_mut(4)) {
        bytes.copy_from_slice(&word.to_le_bytes());
    }
}
impl Thread {
    pub fn encode(self, bytes: &mut [u8; super::PAYLOAD_BYTES]) {
        encode(&self.0, &mut bytes[..THREAD_BYTES]);
    }
}
impl Fork {
    pub fn encode(self, bytes: &mut [u8; super::PAYLOAD_BYTES]) {
        encode(&self.0, &mut bytes[FORK_OFFSET..FORK_OFFSET + FORK_BYTES]);
    }
}
