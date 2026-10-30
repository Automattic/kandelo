//! Coalesced cursor state is owned by the current DRM master grant.
//! A renewed grant cannot inherit a delayed image from an older grant.

use wasm_posix_shared::Errno;

pub struct CursorTransport {
    enabled: bool,
    pending: bool,
    words: [u32; 10],
}

impl CursorTransport {
    pub const fn new() -> Self {
        Self { enabled: false, pending: false, words: [0; 10] }
    }

    pub fn supported(&self) -> bool { self.enabled }

    pub fn configure(&mut self, version: u32) -> i32 {
        if version != 2 { return -(Errno::ENOTSUP as i32); }
        self.enabled = true;
        2
    }

    fn lease_id(&self) -> u64 {
        u64::from(self.words[0]) | (u64::from(self.words[1]) << 32)
    }

    pub fn update(
        &mut self, lease_id: u64, flags: u32, bo: u32, width: u32,
        height: u32, x: i32, y: i32, hot_x: i32, hot_y: i32,
    ) {
        if !self.enabled { return; }
        assert_ne!(lease_id, 0, "cursor update requires a master grant");
        if self.lease_id() != lease_id { self.words = [0; 10]; }
        self.words[0] = lease_id as u32;
        self.words[1] = (lease_id >> 32) as u32;
        if flags & 1 != 0 {
            self.words[2..5].copy_from_slice(&[bo, width, height]);
            self.words[7..9].copy_from_slice(&[hot_x as u32, hot_y as u32]);
        }
        if flags & 2 != 0 { self.words[5..7].copy_from_slice(&[x as u32, y as u32]); }
        self.pending = true;
    }

    /// Delayed cleanup may not clear an update from a renewed grant.
    pub fn clear(&mut self, lease_id: u64) {
        if self.lease_id() != lease_id { return; }
        self.words = [0; 10];
        self.pending = self.enabled;
    }

    pub fn take(&mut self) -> Option<[u32; 10]> {
        if !core::mem::take(&mut self.pending) { return None; }
        Some(self.words)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_or_unknown_host_protocol_does_not_enable_cursor() {
        let mut transport = CursorTransport::new();
        assert!(!transport.supported());
        assert_eq!(transport.configure(1), -(Errno::ENOTSUP as i32));
        transport.update(1, 3, 9, 64, 64, 5, 6, 0, 0);
        assert_eq!(transport.take(), None);
        assert_eq!(transport.configure(2), 2);
        assert!(transport.supported());
    }

    #[test]
    fn motion_coalesces_without_losing_image_or_hotspot() {
        let mut transport = CursorTransport::new();
        transport.configure(2);
        transport.update(100, 3, 9, 64, 32, 5, 6, -3, 4);
        transport.update(100, 2, 0, 0, 0, -1, 99, 0, 0);
        assert_eq!(transport.take(), Some([100, 0, 9, 64, 32, u32::MAX, 99, (-3i32) as u32, 4, 0]));
        assert_eq!(transport.take(), None);
    }

    #[test]
    fn dropping_master_discards_pending_bo_before_next_owner() {
        let mut transport = CursorTransport::new();
        transport.configure(2);
        transport.update(100, 3, 9, 64, 64, 5, 6, 3, 4);
        transport.clear(100);
        assert_eq!(transport.take(), Some([0; 10]));
        transport.update(101, 2, 0, 0, 0, 7, 8, 0, 0);
        assert_eq!(transport.take(), Some([101, 0, 0, 0, 0, 7, 8, 0, 0, 0]));
    }

    #[test]
    fn stale_cleanup_cannot_clear_a_renewed_grant() {
        let mut transport = CursorTransport::new();
        transport.configure(2);
        transport.update(100, 3, 9, 64, 64, 5, 6, 3, 4);
        transport.update(101, 2, 0, 0, 0, 7, 8, 0, 0);
        transport.clear(100);
        assert_eq!(transport.take(), Some([101, 0, 0, 0, 0, 7, 8, 0, 0, 0]));
    }

    #[test]
    fn grant_identity_keeps_all_sixty_four_bits() {
        let mut transport = CursorTransport::new();
        transport.configure(2);
        transport.update(0x8765_4321_1234_5678, 3, 9, 64, 64, 5, 6, 3, 4);
        assert_eq!(transport.take().unwrap()[..2], [0x1234_5678, 0x8765_4321]);
    }
}
