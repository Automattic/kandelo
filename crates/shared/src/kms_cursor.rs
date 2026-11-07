//! Kernel-host coalesced cursor record. This is not a guest DRM ioctl layout.
//! Protocol 4 describes the cursor plane as device state: the first eight
//! bytes, which protocol 3 used for the master grant, are reserved zero,
//! because a master change neither hides nor replaces the plane.
pub const PROTOCOL_VERSION: u32 = 4;
pub const RECORD_BYTES: usize = 40;
pub const RECORD_WORDS: usize = RECORD_BYTES / 4;
pub const RESERVED_OFFSET: usize = 0;
pub const BO_OFFSET: usize = 8;
pub const WIDTH_OFFSET: usize = 12;
pub const HEIGHT_OFFSET: usize = 16;
pub const X_OFFSET: usize = 20;
pub const Y_OFFSET: usize = 24;
pub const HOT_X_OFFSET: usize = 28;
pub const HOT_Y_OFFSET: usize = 32;
pub const FRAMEBUFFER_OFFSET: usize = 36;
