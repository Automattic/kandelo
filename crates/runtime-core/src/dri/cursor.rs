//! Coalesced host cursor transport. BO ownership stays with the KMS OFD;
//! the host consumes only the latest state before reading any cursor pixels.

use wasm_posix_shared::Errno;
use wasm_posix_shared::dri::WPK_CURSOR_SHAPE_DEFAULT;

const CLEARED: [u32; 9] = [0, 0, 0, 0, 0, 0, 0, 0, WPK_CURSOR_SHAPE_DEFAULT];

pub struct CursorTransport {
    version: u32,
    pending: bool,
    words: [u32; 9],
}

impl CursorTransport {
    pub const fn new() -> Self {
        Self {
            version: 0,
            pending: false,
            words: CLEARED,
        }
    }

    pub fn supported(&self) -> bool {
        self.version != 0
    }

    pub fn shapes_supported(&self) -> bool {
        self.version >= 2
    }

    /// Protocol 1 records hold eight words; protocol 2 appends the shape.
    pub fn record_len(&self) -> usize {
        if self.shapes_supported() { 36 } else { 32 }
    }

    pub fn configure(&mut self, version: u32) -> i32 {
        if !(1..=2).contains(&version) {
            return -(Errno::ENOTSUP as i32);
        }
        self.version = version;
        version as i32
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
        if !self.supported() {
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

    pub fn set_shape(&mut self, pid: i32, shape: u32) {
        if !self.shapes_supported() {
            return;
        }
        self.words[0] = pid as u32;
        self.words[8] = shape;
        self.pending = true;
    }

    pub fn clear(&mut self) {
        self.words = CLEARED;
        self.pending = self.supported();
    }

    pub fn take(&mut self) -> Option<[u32; 9]> {
        if !core::mem::take(&mut self.pending) {
            return None;
        }
        Some(self.words)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasm_posix_shared::dri::WPK_CURSOR_SHAPE_HIDDEN;

    #[test]
    fn absent_or_unknown_host_protocol_does_not_enable_cursor() {
        let mut transport = CursorTransport::new();
        assert!(!transport.supported());
        assert_eq!(transport.configure(3), -(Errno::ENOTSUP as i32));
        transport.update(1, 3, 9, 64, 64, 5, 6, 0, 0);
        transport.set_shape(1, WPK_CURSOR_SHAPE_HIDDEN);
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
            Some([100, 9, 64, 32, u32::MAX, 99, (-3i32) as u32, 4, 1])
        );
        assert_eq!(transport.take(), None);
    }

    #[test]
    fn dropping_master_discards_pending_bo_before_next_owner() {
        let mut transport = CursorTransport::new();
        transport.configure(2);
        transport.update(100, 3, 9, 64, 64, 5, 6, 3, 4);
        transport.set_shape(100, WPK_CURSOR_SHAPE_HIDDEN);
        transport.clear();
        assert_eq!(transport.take(), Some(CLEARED));
        transport.update(101, 2, 0, 0, 0, 7, 8, 0, 0);
        assert_eq!(transport.take(), Some([101, 0, 0, 0, 7, 8, 0, 0, 1]));
    }

    #[test]
    fn protocol_1_ignores_shapes_and_keeps_its_record_length() {
        let mut transport = CursorTransport::new();
        assert_eq!(transport.configure(1), 1);
        assert!(!transport.shapes_supported());
        assert_eq!(transport.record_len(), 32);
        transport.set_shape(100, WPK_CURSOR_SHAPE_HIDDEN);
        assert_eq!(transport.take(), None);
    }

    #[test]
    fn protocol_2_coalesces_shape_with_cursor_state() {
        let mut transport = CursorTransport::new();
        assert_eq!(transport.configure(2), 2);
        assert_eq!(transport.record_len(), 36);
        transport.update(100, 2, 0, 0, 0, 5, 6, 0, 0);
        transport.set_shape(100, WPK_CURSOR_SHAPE_HIDDEN);
        transport.set_shape(100, 8);
        assert_eq!(transport.take(), Some([100, 0, 0, 0, 5, 6, 0, 0, 8]));
        assert_eq!(transport.take(), None);
    }
}
