//! GLES2 command-buffer structural validation.
//!
//! `GLIO_SUBMIT` hands the host a `(pid, offset, length)` triple naming a run
//! of TLV records inside the process's cmdbuf mapping. Each record is
//! `{u16 op, u16 payload_len, payload[payload_len]}`, little-endian.
//!
//! **What is a well-formed command stream is kernel computation.** The rule
//! has two halves and both live here:
//!
//! 1. *Framing* — every record header fits, and no payload runs past the end
//!    of the submitted span.
//! 2. *Payload shape* — each opcode's payload has exactly the length its
//!    encoding requires, including the counted forms (`u32 n` followed by `n`
//!    names, a byte tail introduced by a `u32` length, a float tail introduced
//!    by a `u32` count).
//!
//! The host's `webgl/bridge.ts` used to own the shape table and re-derive the
//! framing while dispatching. It no longer does: the kernel rejects a
//! malformed buffer with `EINVAL` *before* `HostIO::gl_submit` is called, so
//! the host bridge only walks the records it is already trusted to issue.
//! Two consequences, both wanted:
//!
//! * `GLIO_SUBMIT` is now all-or-nothing. Previously a stream of
//!   `[valid, malformed]` dispatched the valid command into the live
//!   `WebGLRenderingContext` and *then* returned `EINVAL`, leaving the GL
//!   context half-advanced by a submission user space was told had failed.
//! * Node, browser and host-native answer identically, because there is one
//!   implementation instead of one per host adapter. Only the browser ever
//!   had one.
//!
//! # Reading the bytes without copying the buffer
//!
//! The cmdbuf mapping is 1 MiB ([`wasm_posix_shared::gl::CMDBUF_LEN`]) and a
//! submission may be most of it — a single `OP_TEX_IMAGE_2D` can carry a
//! multi-hundred-kilobyte texture. Copying the whole span into the kernel on
//! every submit would put an O(bytes) memcpy on a per-frame path.
//!
//! It is not needed. Shape validation reads a record's header (4 bytes) and at
//! most the first [`SHAPE_PREFIX`] bytes of its payload — the deepest field any
//! rule inspects is `OP_TEX_IMAGE_2D`'s `dataLen` at payload offset 32. So the
//! walker keeps a small sliding window over the span, refills it from the
//! process through [`HostIO::proc_read_bytes`] only when the next record's
//! header-plus-prefix is not already inside it, and *skips over* payload bytes
//! it never has to look at. A dense run of small commands costs one host read
//! per windowful; a large texture upload costs one read and is then stepped
//! over entirely.

use wasm_posix_shared::gl;
use wasm_posix_shared::Errno;

use crate::process::HostIO;

/// Bytes of a record's payload that any shape rule may inspect.
///
/// `OP_TEX_IMAGE_2D` / `OP_TEX_SUB_IMAGE_2D` read a `u32` at payload offset
/// 32, which is the deepest read in [`payload_shape_ok`]. Nothing may read
/// past this without raising the constant.
const SHAPE_PREFIX: usize = 36;

/// Sliding-window size. Large enough that a dense stream of 8- and 12-byte
/// records is walked with one host read per few hundred records, small enough
/// that the kernel never holds a meaningful fraction of a 1 MiB cmdbuf.
const WINDOW: usize = 4096;

/// A record header plus the shape prefix — the most one refill must deliver.
const MAX_LOOKAHEAD: usize = 4 + SHAPE_PREFIX;

/// Reads a run of guest bytes through a small refillable window.
struct SpanReader {
    /// Guest address of span offset 0.
    base: u64,
    /// Length of the span in bytes.
    len: usize,
    /// Span offset the window starts at.
    window_start: usize,
    /// Bytes currently held.
    window_len: usize,
    buf: [u8; WINDOW],
}

impl SpanReader {
    fn new(base: u64, len: usize) -> Self {
        Self {
            base,
            len,
            window_start: 0,
            window_len: 0,
            buf: [0u8; WINDOW],
        }
    }

    /// Make `[at, at + want)` available in the window, clamped to the span
    /// end. Returns the bytes actually available at `at`, which is
    /// `min(want, len - at)`; a short return is a framing error for the
    /// caller to report, never a fault here.
    fn ensure(
        &mut self,
        host: &mut dyn HostIO,
        pid: i32,
        at: usize,
        want: usize,
    ) -> Result<&[u8], Errno> {
        let available = self.len.saturating_sub(at);
        let want = want.min(available).min(WINDOW);
        let in_window = at >= self.window_start
            && at.saturating_sub(self.window_start) + want <= self.window_len;
        if !in_window {
            let fill = (self.len - at).min(WINDOW);
            let rc = host.proc_read_bytes(pid, self.base + at as u64, &mut self.buf[..fill]);
            if rc < 0 {
                return Err(Errno::from_u32((-rc) as u32).unwrap_or(Errno::EFAULT));
            }
            self.window_start = at;
            self.window_len = fill;
        }
        let off = at - self.window_start;
        Ok(&self.buf[off..off + want])
    }
}

fn u16_at(bytes: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([bytes[off], bytes[off + 1]])
}

fn u32_at(bytes: &[u8], off: usize) -> Option<u32> {
    if bytes.len() < off + 4 {
        return None;
    }
    Some(u32::from_le_bytes([
        bytes[off],
        bytes[off + 1],
        bytes[off + 2],
        bytes[off + 3],
    ]))
}

/// Does `payload_len` match the encoding `op` requires?
///
/// `prefix` holds the first `min(payload_len, SHAPE_PREFIX)` payload bytes;
/// the counted forms read their count out of it. An unknown opcode is
/// rejected — the guest is not permitted to send records the bridge cannot
/// issue.
fn payload_shape_ok(op: u16, payload_len: usize, prefix: &[u8]) -> bool {
    /// `u32 n` followed by exactly `n` u32 names.
    fn u32_array(payload_len: usize, prefix: &[u8]) -> bool {
        match u32_at(prefix, 0) {
            Some(n) => (n as usize)
                .checked_mul(4)
                .and_then(|b| b.checked_add(4))
                .map(|total| total == payload_len)
                .unwrap_or(false),
            None => false,
        }
    }

    /// A fixed header of `header_len` whose byte tail is introduced by a `u32`
    /// length at `len_offset`.
    fn tail_bytes(payload_len: usize, prefix: &[u8], header_len: usize, len_offset: usize) -> bool {
        match u32_at(prefix, len_offset) {
            Some(data_len) => (data_len as usize)
                .checked_add(header_len)
                .map(|total| total == payload_len)
                .unwrap_or(false),
            None => false,
        }
    }

    /// A fixed header of `header_len` whose float tail is `count *
    /// floats_per_count` f32 values, with `count` a `u32` at `count_offset`.
    fn counted_floats(
        payload_len: usize,
        prefix: &[u8],
        header_len: usize,
        count_offset: usize,
        floats_per_count: usize,
    ) -> bool {
        match u32_at(prefix, count_offset) {
            Some(count) => (count as usize)
                .checked_mul(floats_per_count)
                .and_then(|f| f.checked_mul(4))
                .and_then(|b| b.checked_add(header_len))
                .map(|total| total == payload_len)
                .unwrap_or(false),
            None => false,
        }
    }

    match op {
        gl::OP_CLEAR
        | gl::OP_ENABLE
        | gl::OP_DISABLE
        | gl::OP_DEPTH_FUNC
        | gl::OP_CULL_FACE
        | gl::OP_FRONT_FACE
        | gl::OP_LINE_WIDTH
        | gl::OP_ACTIVE_TEXTURE
        | gl::OP_GENERATE_MIPMAP
        | gl::OP_COMPILE_SHADER
        | gl::OP_DELETE_SHADER
        | gl::OP_CREATE_PROGRAM
        | gl::OP_LINK_PROGRAM
        | gl::OP_USE_PROGRAM
        | gl::OP_DELETE_PROGRAM
        | gl::OP_ENABLE_VERTEX_ATTRIB_ARRAY
        | gl::OP_DISABLE_VERTEX_ATTRIB_ARRAY
        | gl::OP_BIND_VERTEX_ARRAY => payload_len == 4,

        gl::OP_BLEND_FUNC
        | gl::OP_PIXEL_STOREI
        | gl::OP_BIND_BUFFER
        | gl::OP_BIND_TEXTURE
        | gl::OP_CREATE_SHADER
        | gl::OP_ATTACH_SHADER
        | gl::OP_UNIFORM1I
        | gl::OP_UNIFORM1F
        | gl::OP_BIND_FRAMEBUFFER
        | gl::OP_BIND_RENDERBUFFER => payload_len == 8,

        gl::OP_TEX_PARAMETERI | gl::OP_UNIFORM2F | gl::OP_DRAW_ARRAYS => payload_len == 12,

        gl::OP_CLEAR_COLOR
        | gl::OP_VIEWPORT
        | gl::OP_SCISSOR
        | gl::OP_UNIFORM3F
        | gl::OP_DRAW_ELEMENTS
        | gl::OP_RENDERBUFFER_STORAGE
        | gl::OP_FRAMEBUFFER_RENDERBUFFER => payload_len == 16,

        gl::OP_UNIFORM4F | gl::OP_FRAMEBUFFER_TEXTURE_2D => payload_len == 20,

        gl::OP_VERTEX_ATTRIB_POINTER => payload_len == 24,

        gl::OP_GEN_BUFFERS
        | gl::OP_DELETE_BUFFERS
        | gl::OP_GEN_TEXTURES
        | gl::OP_DELETE_TEXTURES
        | gl::OP_GEN_VERTEX_ARRAYS
        | gl::OP_DELETE_VERTEX_ARRAYS
        | gl::OP_GEN_FRAMEBUFFERS
        | gl::OP_GEN_RENDERBUFFERS => u32_array(payload_len, prefix),

        gl::OP_BUFFER_DATA => tail_bytes(payload_len, prefix, 12, 4),
        gl::OP_BUFFER_SUB_DATA => tail_bytes(payload_len, prefix, 12, 8),
        gl::OP_TEX_IMAGE_2D | gl::OP_TEX_SUB_IMAGE_2D => tail_bytes(payload_len, prefix, 36, 32),
        gl::OP_SHADER_SOURCE => tail_bytes(payload_len, prefix, 8, 4),
        gl::OP_BIND_ATTRIB_LOCATION => tail_bytes(payload_len, prefix, 12, 8),

        gl::OP_UNIFORM_MATRIX4FV => counted_floats(payload_len, prefix, 12, 4, 16),
        gl::OP_UNIFORM4FV => counted_floats(payload_len, prefix, 8, 4, 4),

        _ => false,
    }
}

/// Validate the framing and payload shapes of a `GLIO_SUBMIT` span.
///
/// `cmdbuf_addr` is the process address of the cmdbuf mapping; `offset` and
/// `length` are the caller's submission window inside it, already checked
/// against the mapping's length by the GLIO_SUBMIT handler.
///
/// Returns `Ok(())` when every record in the span is well formed, `EINVAL`
/// when any is not, and the host's error when the process bytes cannot be
/// read.
pub fn validate_submission(
    host: &mut dyn HostIO,
    pid: i32,
    cmdbuf_addr: usize,
    offset: usize,
    length: usize,
) -> Result<(), Errno> {
    if length == 0 {
        return Ok(());
    }
    let base = (cmdbuf_addr as u64)
        .checked_add(offset as u64)
        .ok_or(Errno::EINVAL)?;
    let mut reader = SpanReader::new(base, length);
    let mut p = 0usize;
    while p < length {
        let head = reader.ensure(host, pid, p, MAX_LOOKAHEAD)?;
        if head.len() < 4 {
            return Err(Errno::EINVAL);
        }
        let op = u16_at(head, 0);
        let payload_len = u16_at(head, 2) as usize;
        let payload_start = p + 4;
        let payload_end = payload_start
            .checked_add(payload_len)
            .ok_or(Errno::EINVAL)?;
        if payload_end > length {
            return Err(Errno::EINVAL);
        }
        let prefix_len = payload_len.min(SHAPE_PREFIX).min(head.len() - 4);
        if !payload_shape_ok(op, payload_len, &head[4..4 + prefix_len]) {
            return Err(Errno::EINVAL);
        }
        p = payload_end;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::process::test_host::GuestMemoryHost;

    /// Guest address the modelled cmdbuf starts at. Deliberately non-zero so a
    /// test cannot pass because an offset happened to equal an address.
    const CMDBUF_ADDR: usize = 0x2_0000;

    fn record(op: u16, payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(4 + payload.len());
        out.extend_from_slice(&op.to_le_bytes());
        out.extend_from_slice(&(payload.len() as u16).to_le_bytes());
        out.extend_from_slice(payload);
        out
    }

    /// Stage `bytes` as the cmdbuf contents and validate the whole span.
    fn check(bytes: &[u8]) -> Result<(), Errno> {
        let (result, _) = check_counted(bytes, bytes.len());
        result
    }

    /// As [`check`], but submits `span_len` bytes (which may exceed what the
    /// modelled region holds) and returns the host that served the reads.
    fn check_counted(bytes: &[u8], span_len: usize) -> (Result<(), Errno>, GuestMemoryHost) {
        let mut host = GuestMemoryHost::new(CMDBUF_ADDR as u64, bytes.len());
        if !bytes.is_empty() {
            host.poke(CMDBUF_ADDR as u64, bytes);
        }
        let result = validate_submission(&mut host, 1, CMDBUF_ADDR, 0, span_len);
        (result, host)
    }

    #[test]
    fn empty_submission_is_valid() {
        assert!(check(&[]).is_ok());
    }

    #[test]
    fn fixed_shape_records_pass_and_wrong_length_fails() {
        assert!(check(&record(gl::OP_CLEAR, &[0, 0, 0, 0])).is_ok());
        assert_eq!(check(&record(gl::OP_CLEAR, &[0, 0, 0])), Err(Errno::EINVAL));
        assert!(check(&record(gl::OP_VERTEX_ATTRIB_POINTER, &[0u8; 24])).is_ok());
        assert_eq!(
            check(&record(gl::OP_VERTEX_ATTRIB_POINTER, &[0u8; 20])),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn unknown_opcode_is_rejected() {
        assert_eq!(check(&record(0xBEEF, &[0, 0, 0, 0])), Err(Errno::EINVAL));
    }

    #[test]
    fn truncated_tlv_header_is_rejected() {
        assert_eq!(check(&[0x01, 0x00, 0x04]), Err(Errno::EINVAL));
    }

    #[test]
    fn payload_running_past_the_span_is_rejected() {
        // Header claims a 4-byte payload but only 3 bytes follow.
        assert_eq!(
            check(&[0x01, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00]),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn counted_name_array_shape_is_enforced() {
        let mut good = 2u32.to_le_bytes().to_vec();
        good.extend_from_slice(&[0u8; 8]);
        assert!(check(&record(gl::OP_GEN_BUFFERS, &good)).is_ok());

        let mut short = 2u32.to_le_bytes().to_vec();
        short.extend_from_slice(&[0u8; 4]);
        assert_eq!(
            check(&record(gl::OP_GEN_BUFFERS, &short)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn counted_name_array_length_cannot_overflow() {
        // `n` large enough that `n * 4` wraps a 32-bit multiply.
        let mut evil = u32::MAX.to_le_bytes().to_vec();
        evil.extend_from_slice(&[0u8; 4]);
        assert_eq!(check(&record(gl::OP_GEN_BUFFERS, &evil)), Err(Errno::EINVAL));
    }

    #[test]
    fn byte_tail_shape_is_enforced() {
        // OP_BUFFER_DATA: u32 target, u32 dataLen, u8 data[dataLen], u32 usage.
        let mut good = Vec::new();
        good.extend_from_slice(&0x8892u32.to_le_bytes());
        good.extend_from_slice(&6u32.to_le_bytes());
        good.extend_from_slice(&[1, 2, 3, 4, 5, 6]);
        good.extend_from_slice(&0u32.to_le_bytes());
        assert!(check(&record(gl::OP_BUFFER_DATA, &good)).is_ok());

        let mut bad = good.clone();
        bad.pop();
        assert_eq!(check(&record(gl::OP_BUFFER_DATA, &bad)), Err(Errno::EINVAL));
    }

    #[test]
    fn counted_float_shape_is_enforced() {
        // OP_UNIFORM_MATRIX4FV: i32 loc, u32 count, u32 transpose, f32[count*16].
        let mut good = Vec::new();
        good.extend_from_slice(&0i32.to_le_bytes());
        good.extend_from_slice(&1u32.to_le_bytes());
        good.extend_from_slice(&0u32.to_le_bytes());
        good.extend_from_slice(&[0u8; 64]);
        assert!(check(&record(gl::OP_UNIFORM_MATRIX4FV, &good)).is_ok());

        let mut bad = good.clone();
        bad.truncate(bad.len() - 4);
        assert_eq!(
            check(&record(gl::OP_UNIFORM_MATRIX4FV, &bad)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn a_late_bad_record_rejects_the_whole_submission() {
        let mut stream = record(gl::OP_CLEAR, &[0, 0, 0, 0]);
        stream.extend_from_slice(&record(gl::OP_CLEAR, &[0, 0, 0]));
        assert_eq!(check(&stream), Err(Errno::EINVAL));
    }

    #[test]
    fn a_large_payload_is_stepped_over_rather_than_copied() {
        // One near-maximal byte-tail record between two small ones. The TLV
        // `payload_len` field is a u16, so 60 KiB is close to the largest a
        // single record can carry; the walker must step over its body rather
        // than copy it.
        let big_data = 60_000usize;
        let mut big = Vec::new();
        big.extend_from_slice(&0x8892u32.to_le_bytes());
        big.extend_from_slice(&(big_data as u32).to_le_bytes());
        big.resize(8 + big_data, 0);
        big.extend_from_slice(&0u32.to_le_bytes());

        let mut stream = record(gl::OP_CLEAR, &[0, 0, 0, 0]);
        stream.extend_from_slice(&record(gl::OP_BUFFER_DATA, &big));
        stream.extend_from_slice(&record(gl::OP_CLEAR, &[0, 0, 0, 0]));

        let len = stream.len();
        let (result, host) = check_counted(&stream, len);
        assert!(result.is_ok());
        assert!(
            host.bytes_read < len / 4,
            "walker copied {} of {} span bytes",
            host.bytes_read,
            len
        );
    }

    #[test]
    fn a_dense_stream_costs_one_read_per_window() {
        // 512 eight-byte records = 4096 bytes, one WINDOW.
        let mut stream = Vec::new();
        for _ in 0..512 {
            stream.extend_from_slice(&record(gl::OP_CLEAR, &[0, 0, 0, 0]));
        }
        let len = stream.len();
        let (result, host) = check_counted(&stream, len);
        assert!(result.is_ok());
        assert!(host.reads <= 2, "took {} host reads", host.reads);
    }

    #[test]
    fn a_record_straddling_the_window_edge_is_read_correctly() {
        // Fill to just short of WINDOW with 8-byte records, then place a
        // counted-array record whose shape prefix crosses the boundary.
        let mut stream = Vec::new();
        while stream.len() + 8 <= WINDOW - 4 {
            stream.extend_from_slice(&record(gl::OP_CLEAR, &[0, 0, 0, 0]));
        }
        let mut names = 3u32.to_le_bytes().to_vec();
        names.extend_from_slice(&[0u8; 12]);
        stream.extend_from_slice(&record(gl::OP_GEN_TEXTURES, &names));
        stream.extend_from_slice(&record(gl::OP_CLEAR, &[0, 0, 0, 0]));

        assert!(check(&stream).is_ok());
    }

    #[test]
    fn a_read_fault_is_reported_not_swallowed() {
        // Span claims more bytes than the process image holds.
        let bytes = record(gl::OP_CLEAR, &[0, 0, 0, 0]);
        let (result, _) = check_counted(&bytes, 64);
        assert_eq!(result, Err(Errno::EFAULT));
    }
}
