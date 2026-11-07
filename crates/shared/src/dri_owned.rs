//! Opt-in driver-owned OFD/BO resources. All legacy fd operations are unchanged.

pub const REQUEST: u32 = 0xc140_64e7;
pub const VERSION: u32 = 1;
pub const MAGIC: u32 = 0x4f57_4e31;
pub const BODY_BYTES: usize = 256;
pub const OPEN: u32 = 1;
pub const ACQUIRE: u32 = 2;
pub const IOCTL: u32 = 3;
pub const MMAP: u32 = 4;
pub const RELEASE: u32 = 5;
pub const READ_LAST: u32 = 6;
pub const ACK: u32 = 7;
pub const DUP_FD: u32 = 8;
pub const BO_RELEASE: u32 = 9;
pub const BO_INFO: u32 = 10;
pub const POLL: u32 = 11;
pub const CANCEL_POLL: u32 = 12;
pub const CONSUME_FD: u32 = 1;
pub const CAPTURE_FD: u32 = 2;
pub const CAPTURE_BO: u32 = 4;
pub const REUSE_EXACT: u32 = 8;
pub const BO_BINDINGS: u32 = 16;
pub const BORROW_ALIAS: u32 = 32;
pub const EXPECT_SYNC_FILE: u32 = 64;
pub const COMPLETE: u32 = 1;
pub const ABSENT: u32 = 2;
pub const PENDING: u32 = 3;
pub const NODE_RENDER: u32 = 1;
pub const NODE_CARD: u32 = 2;

/// The packet has no native pointers; nested ioctl bodies retain their normal
/// caller-width layouts. A receipt owns bytes, never a borrowed guest view.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Packet {
    pub version: u32,
    pub action: u32,
    pub transaction: u64,
    pub acknowledge: u64,
    pub token: u32,
    pub source_token: u32,
    pub fd: i32,
    pub request: u32,
    pub length: u32,
    pub flags: u32,
    pub result: i32,
    pub state: u32,
    pub magic: u32,
    pub reserved: u32,
    pub body: [u8; BODY_BYTES],
}
impl Default for Packet {
    fn default() -> Self {
        Self {
            version: VERSION,
            action: 0,
            transaction: 0,
            acknowledge: 0,
            token: 0,
            source_token: 0,
            fd: -1,
            request: 0,
            length: 0,
            flags: 0,
            result: 0,
            state: 0,
            magic: 0,
            reserved: 0,
            body: [0; BODY_BYTES],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn packet_is_exactly_320_bytes_on_both_data_models() {
        use core::mem::{align_of, offset_of, size_of};
        assert_eq!(size_of::<Packet>(), 320);
        assert_eq!(align_of::<Packet>(), 8);
        assert_eq!(offset_of!(Packet, transaction), 8);
        assert_eq!(offset_of!(Packet, token), 24);
        assert_eq!(offset_of!(Packet, fd), 32);
        assert_eq!(offset_of!(Packet, result), 48);
        assert_eq!(offset_of!(Packet, body), 64);
        assert_eq!(
            REQUEST,
            0xc000_0000 | (320 << 16) | (b'd' as u32) << 8 | 0xe7
        );
    }
}
