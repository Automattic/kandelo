//! Coalesced cursor-plane records for the host presenter.
//!
//! The cursor plane is device state (Linux plane state, not master state):
//! a master change neither hides nor replaces it, so records carry no grant.
//! A record names the plane's current framebuffer, whose BO the plane holds
//! a reference on, so a host never reads a retired image.

use wasm_posix_shared::{Errno, kms_cursor as wire};

pub struct CursorTransport {
    enabled: bool,
    pending: bool,
    words: [u32; wire::RECORD_WORDS],
}

impl CursorTransport {
    pub const fn new() -> Self {
        Self { enabled: false, pending: false, words: [0; wire::RECORD_WORDS] }
    }

    pub fn supported(&self) -> bool { self.enabled }

    pub fn configure(&mut self, version: u32) -> i32 {
        if version != wire::PROTOCOL_VERSION { return -(Errno::ENOTSUP as i32); }
        self.enabled = true;
        wire::PROTOCOL_VERSION as i32
    }

    pub fn update(
        &mut self, flags: u32, bo: u32, width: u32,
        height: u32, x: i32, y: i32, hot_x: i32, hot_y: i32, fb_id: u32,
    ) {
        if !self.enabled { return; }
        if flags & 1 != 0 {
            assert_eq!(bo == 0, fb_id == 0, "cursor image requires actual framebuffer identity");
            self.words[9] = fb_id;
            self.words[2..5].copy_from_slice(&[bo, width, height]);
            self.words[7..9].copy_from_slice(&[hot_x as u32, hot_y as u32]);
        }
        if flags & 2 != 0 { self.words[5..7].copy_from_slice(&[x as u32, y as u32]); }
        self.pending = true;
    }

    /// Reconcile delayed cleanup against the authoritative plane in one
    /// serialized kernel entry. Never synthesize a missing nonzero image.
    /// Refusal leaves the pending record intact for honest recovery/retry.
    pub fn take_for_plane(&mut self, fb_id: u32, x: i32, y: i32)
        -> Result<Option<[u32; wire::RECORD_WORDS]>, Errno>
    {
        if !self.enabled { return Ok(None); }
        if fb_id != 0 {
            if self.words[9] != fb_id || self.words[2] == 0 {
                return Err(Errno::EIO);
            }
        } else {
            let disabled = [0, 0, 0, 0, 0, x as u32, y as u32, 0, 0, 0];
            if self.words != disabled {
                self.words = disabled;
                self.pending = true;
            }
        }
        Ok(self.take())
    }

    /// Normal export serializer. All refusals precede output writes and
    /// record consumption; an unchanged image also preserves caller bytes.
    pub fn read_into(&mut self, fb_id: u32, x: i32, y: i32, out: &mut [u8])
        -> Result<usize, Errno>
    {
        if out.len() < wire::RECORD_BYTES { return Err(Errno::EINVAL); }
        let Some(words) = self.take_for_plane(fb_id, x, y)? else { return Ok(0) };
        for (chunk, word) in out[..wire::RECORD_BYTES].chunks_exact_mut(4).zip(words) {
            chunk.copy_from_slice(&word.to_le_bytes());
        }
        Ok(wire::RECORD_BYTES)
    }

    pub fn take(&mut self) -> Option<[u32; wire::RECORD_WORDS]> {
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
        for version in [1, 2, 3, 5] {
            assert_eq!(transport.configure(version), -(Errno::ENOTSUP as i32));
        }
        transport.update(3, 9, 64, 64, 5, 6, 0, 0, 42);
        assert_eq!(transport.take(), None);
        assert_eq!(transport.configure(wire::PROTOCOL_VERSION), 4);
        assert!(transport.supported());
    }

    #[test]
    fn motion_coalesces_without_losing_image_or_hotspot() {
        let mut transport = CursorTransport::new();
        transport.configure(wire::PROTOCOL_VERSION);
        transport.update(3, 9, 64, 32, 5, 6, -3, 4, 42);
        transport.update(2, 0, 0, 0, -1, 99, 0, 0, 42);
        assert_eq!(transport.take(), Some([0, 0, 9, 64, 32, u32::MAX, 99, (-3i32) as u32, 4, 42]));
        assert_eq!(transport.take(), None);
    }

    #[test]
    fn disabled_plane_replaces_pending_and_drained_retired_images_once() {
        for drained in [false, true] {
            let mut transport = CursorTransport::new();
            transport.configure(wire::PROTOCOL_VERSION);
            transport.update(3, 9, 64, 32, 5, 6, -3, 4, 42);
            if drained { assert!(transport.take().is_some()); }
            let mut out = [0xa5; wire::RECORD_BYTES];
            assert_eq!(transport.read_into(0, 5, 6, &mut out), Ok(wire::RECORD_BYTES));
            let words: alloc::vec::Vec<_> = out.chunks_exact(4)
                .map(|v| u32::from_le_bytes(v.try_into().unwrap())).collect();
            assert_eq!(words, [0, 0, 0, 0, 0, 5, 6, 0, 0, 0]);
            out.fill(0xa5);
            assert_eq!(transport.read_into(0, 5, 6, &mut out), Ok(0));
            assert_eq!(out, [0xa5; wire::RECORD_BYTES]);
        }
    }

    #[test]
    fn current_image_wins_and_nonzero_refusal_preserves_output_and_pending_image() {
        let mut transport = CursorTransport::new();
        transport.configure(wire::PROTOCOL_VERSION);
        transport.update(3, 9, 64, 32, 5, 6, 0, 0, 42);
        transport.update(3, 9, 64, 32, 5, 6, 0, 0, 43);
        let mut out = [0xa5; wire::RECORD_BYTES];
        assert_eq!(transport.read_into(42, 5, 6, &mut out), Err(Errno::EIO));
        assert_eq!(out, [0xa5; wire::RECORD_BYTES]);
        assert_eq!(transport.read_into(43, 5, 6, &mut out[..39]), Err(Errno::EINVAL));
        assert_eq!(out, [0xa5; wire::RECORD_BYTES]);
        assert_eq!(transport.read_into(43, 5, 6, &mut out), Ok(wire::RECORD_BYTES));
        assert_eq!(u32::from_le_bytes(out[36..40].try_into().unwrap()), 43);
        assert_eq!(transport.read_into(43, 5, 6, &mut out), Ok(0));
    }
}
