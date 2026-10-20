//! Coalesced host cursor transport. BO ownership stays with the KMS OFD;
//! the host consumes only the latest state before reading any cursor pixels.

use wasm_posix_shared::Errno;

pub struct CursorTransport {
    enabled: bool,
    pending: bool,
    words: [u32; 8],
}

impl CursorTransport {
    pub const fn new() -> Self {
        Self {
            enabled: false,
            pending: false,
            words: [0; 8],
        }
    }

    pub fn supported(&self) -> bool {
        self.enabled
    }

    pub fn configure(&mut self, version: u32) -> i32 {
        if version != 1 {
            return -(Errno::ENOTSUP as i32);
        }
        self.enabled = true;
        1
    }

    pub fn update(
        &mut self,
        pid: i32,
        flags: u32,
        bo: u32,
        width: u32,
        height: u32,
        x: i32,
        y: i32,
        hot_x: i32,
        hot_y: i32,
    ) {
        if !self.enabled {
            return;
        }
        self.words[0] = pid as u32;
        if flags & 1 != 0 {
            self.words[1..4].copy_from_slice(&[bo, width, height]);
            self.words[6..8].copy_from_slice(&[hot_x as u32, hot_y as u32]);
        }
        if flags & 2 != 0 {
            self.words[4..6].copy_from_slice(&[x as u32, y as u32]);
        }
        self.pending = true;
    }

    pub fn clear(&mut self) {
        self.words = [0; 8];
        self.pending = self.enabled;
    }

    pub fn take(&mut self) -> Option<[u32; 8]> {
        if !core::mem::take(&mut self.pending) {
            return None;
        }
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
        assert_eq!(transport.configure(2), -(Errno::ENOTSUP as i32));
        transport.update(1, 3, 9, 64, 64, 5, 6, 0, 0);
        assert_eq!(transport.take(), None);
        assert_eq!(transport.configure(1), 1);
        assert!(transport.supported());
    }

    #[test]
    fn motion_coalesces_without_losing_image_or_hotspot() {
        let mut transport = CursorTransport::new();
        transport.configure(1);
        transport.update(100, 3, 9, 64, 32, 5, 6, -3, 4);
        transport.update(100, 2, 0, 0, 0, -1, 99, 0, 0);
        assert_eq!(
            transport.take(),
            Some([100, 9, 64, 32, u32::MAX, 99, (-3i32) as u32, 4])
        );
        assert_eq!(transport.take(), None);
    }

    #[test]
    fn dropping_master_discards_pending_bo_before_next_owner() {
        let mut transport = CursorTransport::new();
        transport.configure(1);
        transport.update(100, 3, 9, 64, 64, 5, 6, 3, 4);
        transport.clear();
        assert_eq!(transport.take(), Some([0; 8]));
        transport.update(101, 2, 0, 0, 0, 7, 8, 0, 0);
        assert_eq!(transport.take(), Some([101, 0, 0, 0, 7, 8, 0, 0]));
    }
}
