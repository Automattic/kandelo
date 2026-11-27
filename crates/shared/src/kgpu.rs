//! kgpu kernel contracts: the guest-facing `kandelo.kgpu.v1` extension ops
//! and the kernel-to-host submission and completion records.
//!
//! Ownership: this module is the single definition of (a) the ops and
//! argument structs a guest GL driver passes to the
//! `__kandelo_kgpu_v1(arg, size, op)` import and (b) the byte records the
//! kernel exchanges with the GPU host adapter. The guest interface is a
//! program extension, not ioctls, because the base program surface (and so
//! its digest) is frozen; see `docs/program-extensions.md`. Both sides read
//! the same definitions (the C header is generated from them by
//! `cargo xtask dump-abi`), so the guest, kernel and host cannot drift.
//!
//! Why records carry `Extent`s instead of addresses: the GPU worker can only
//! see the memory group's shared backing, never a process's address space.
//! The kernel resolves guest virtual ranges to byte ranges of that backing
//! and the host reads exactly those ranges; a guest address is never a
//! backing offset.
//!
//! Wire layout (little-endian):
//!
//! ```text
//! submission  header { kind u32, context u32, seqno u64,
//!                      stream_extent_count u32, buffer_count u32 }   24
//!             stream_extent_count * Extent                           16 each
//!             per buffer { access u32, extent_count u32 } + Extents
//! completion  { kind u32, context u32, seqno u64, status i32, pad u32 } 24
//! ```
//!
//! Decoding treats input as hostile: every count is bounded, all arithmetic
//! is checked, and malformed input yields a `RecordError`, never a panic.

pub const KGPU_PROTOCOL_VERSION: u32 = 1;

pub const KGPU_ACCESS_READ: u32 = 1;
pub const KGPU_ACCESS_WRITE: u32 = 2;
pub const KGPU_MAX_BUFFERS: u32 = 64;
pub const KGPU_MAX_STREAM: u32 = 1 << 20;
/// Upper bound on extents in one range. A maximal stream over 4 KiB pages
/// needs 256; the headroom lets the kernel report fragmentation as an error
/// of its own instead of the decoder rejecting a legitimate record.
pub const KGPU_MAX_EXTENTS: u32 = 4096;

pub const KGPU_OP_CONTEXT_CREATE: i32 = 1;
pub const KGPU_OP_CONTEXT_DESTROY: i32 = 2;
pub const KGPU_OP_SUBMIT: i32 = 3;
pub const KGPU_OP_WAIT: i32 = 4;

/// The exact argument size an op requires; the import returns `-EINVAL`
/// (-22) for any other `size`, so a short or long buffer never reaches a
/// handler. `None` for an unknown op.
pub fn op_arg_size(op: i32) -> Option<usize> {
    use core::mem::size_of;
    match op {
        KGPU_OP_CONTEXT_CREATE => Some(size_of::<KgpuContextCreate>()),
        KGPU_OP_CONTEXT_DESTROY => Some(size_of::<KgpuContextDestroy>()),
        KGPU_OP_SUBMIT => Some(size_of::<KgpuSubmit>()),
        KGPU_OP_WAIT => Some(size_of::<KgpuWait>()),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(C)]
pub struct KgpuContextCreate {
    pub flags: u32,
    /// Out.
    pub context: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(C)]
pub struct KgpuContextDestroy {
    pub context: u32,
    pub pad: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(C)]
pub struct KgpuSubmit {
    pub context: u32,
    pub flags: u32,
    pub stream_addr: u64,
    pub stream_len: u32,
    pub buffer_count: u32,
    pub buffers_addr: u64,
    /// Out.
    pub seqno: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(C)]
pub struct KgpuBuffer {
    pub addr: u64,
    pub len: u32,
    pub access: u32,
}

/// A negative `timeout_ns` waits forever; zero polls and returns `ETIME`
/// while the sequence number is still pending.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(C)]
pub struct KgpuWait {
    pub context: u32,
    pub flags: u32,
    pub seqno: u64,
    pub timeout_ns: i64,
}

/// A byte range of the memory group's shared backing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(C)]
pub struct Extent {
    pub offset: u64,
    pub len: u32,
    pub pad: u32,
}

pub const SUBMISSION_HEADER_SIZE: usize = 24;
pub const BUFFER_HEADER_SIZE: usize = 8;
pub const EXTENT_SIZE: usize = 16;
pub const COMPLETION_SIZE: usize = 24;

/// The submission record header's wire layout. The codec reads every field
/// at its `offset_of!` here, and `cargo xtask dump-abi` generates the host's
/// field offsets from the same struct, so a host that parses records (the
/// GPU worker) cannot drift from the kernel that writes them.
#[repr(C)]
pub struct SubmissionHeaderWire {
    pub kind: u32,
    pub context: u32,
    pub seqno: u64,
    pub stream_extent_count: u32,
    pub buffer_count: u32,
}

/// One buffer-table entry's header on the wire; its extents follow.
#[repr(C)]
pub struct BufferHeaderWire {
    pub access: u32,
    pub extent_count: u32,
}

/// A completion record's wire layout (see `SubmissionHeaderWire`).
#[repr(C)]
pub struct CompletionWire {
    pub kind: u32,
    pub context: u32,
    pub seqno: u64,
    pub status: i32,
    pub pad: u32,
}

const _: () = {
    assert!(core::mem::size_of::<SubmissionHeaderWire>() == SUBMISSION_HEADER_SIZE);
    assert!(core::mem::size_of::<BufferHeaderWire>() == BUFFER_HEADER_SIZE);
    assert!(core::mem::size_of::<Extent>() == EXTENT_SIZE);
    assert!(core::mem::size_of::<CompletionWire>() == COMPLETION_SIZE);
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum SubmissionKind {
    Submit = 1,
    ContextCreate = 2,
    ContextDestroy = 3,
}

impl SubmissionKind {
    pub fn from_u32(v: u32) -> Option<Self> {
        match v {
            1 => Some(Self::Submit),
            2 => Some(Self::ContextCreate),
            3 => Some(Self::ContextDestroy),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum CompletionKind {
    Retired = 1,
    ContextLost = 2,
    ContextReady = 3,
}

impl CompletionKind {
    pub fn from_u32(v: u32) -> Option<Self> {
        match v {
            1 => Some(Self::Retired),
            2 => Some(Self::ContextLost),
            3 => Some(Self::ContextReady),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecordError {
    Truncated,
    UnknownKind(u32),
    /// A count exceeds `KGPU_MAX_BUFFERS` or `KGPU_MAX_EXTENTS`.
    TooMany,
    /// Non-submit records carry no extents or buffers.
    UnexpectedPayload,
    BadAccess(u32),
    /// The caller's output buffer is too small.
    Overflow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SubmissionHeader {
    pub kind: SubmissionKind,
    pub context: u32,
    pub seqno: u64,
}

/// One buffer-table entry on the encode side.
#[derive(Clone, Copy, Debug)]
pub struct BufferSpec<'a> {
    pub access: u32,
    pub extents: &'a [Extent],
}

struct Writer<'a> {
    out: &'a mut [u8],
    pos: usize,
}

impl Writer<'_> {
    fn put(&mut self, bytes: &[u8]) -> Result<(), RecordError> {
        let end = self
            .pos
            .checked_add(bytes.len())
            .ok_or(RecordError::Overflow)?;
        self.out
            .get_mut(self.pos..end)
            .ok_or(RecordError::Overflow)?
            .copy_from_slice(bytes);
        self.pos = end;
        Ok(())
    }
    fn u32(&mut self, v: u32) -> Result<(), RecordError> {
        self.put(&v.to_le_bytes())
    }
    fn u64(&mut self, v: u64) -> Result<(), RecordError> {
        self.put(&v.to_le_bytes())
    }
    fn extent(&mut self, e: &Extent) -> Result<(), RecordError> {
        self.u64(e.offset)?;
        self.u32(e.len)?;
        self.u32(e.pad)
    }
}

/// Encodes a submission record; returns the bytes written.
pub fn encode_submission(
    out: &mut [u8],
    header: &SubmissionHeader,
    stream: &[Extent],
    buffers: &[BufferSpec<'_>],
) -> Result<usize, RecordError> {
    if stream.len() > KGPU_MAX_EXTENTS as usize || buffers.len() > KGPU_MAX_BUFFERS as usize {
        return Err(RecordError::TooMany);
    }
    if header.kind != SubmissionKind::Submit && (!stream.is_empty() || !buffers.is_empty()) {
        return Err(RecordError::UnexpectedPayload);
    }
    let mut w = Writer { out, pos: 0 };
    w.u32(header.kind as u32)?;
    w.u32(header.context)?;
    w.u64(header.seqno)?;
    w.u32(stream.len() as u32)?;
    w.u32(buffers.len() as u32)?;
    for e in stream {
        w.extent(e)?;
    }
    for b in buffers {
        if b.extents.len() > KGPU_MAX_EXTENTS as usize {
            return Err(RecordError::TooMany);
        }
        if !valid_access(b.access) {
            return Err(RecordError::BadAccess(b.access));
        }
        w.u32(b.access)?;
        w.u32(b.extents.len() as u32)?;
        for e in b.extents {
            w.extent(e)?;
        }
    }
    Ok(w.pos)
}

fn valid_access(a: u32) -> bool {
    a != 0 && a & !(KGPU_ACCESS_READ | KGPU_ACCESS_WRITE) == 0
}

fn rd_u32(b: &[u8], at: usize) -> Result<u32, RecordError> {
    let end = at.checked_add(4).ok_or(RecordError::Truncated)?;
    let s = b.get(at..end).ok_or(RecordError::Truncated)?;
    Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

fn rd_u64(b: &[u8], at: usize) -> Result<u64, RecordError> {
    let end = at.checked_add(8).ok_or(RecordError::Truncated)?;
    let s = b.get(at..end).ok_or(RecordError::Truncated)?;
    let mut a = [0u8; 8];
    a.copy_from_slice(s);
    Ok(u64::from_le_bytes(a))
}

fn rd_extent(b: &[u8], at: usize) -> Result<Extent, RecordError> {
    Ok(Extent {
        offset: rd_u64(b, at)?,
        len: rd_u32(b, at + 8)?,
        pad: rd_u32(b, at + 12)?,
    })
}

/// A validated submission record. Decoding walks the whole layout once, so
/// the accessors below can only fail on an out-of-range index.
#[derive(Clone, Copy, Debug)]
pub struct SubmissionView<'a> {
    pub header: SubmissionHeader,
    bytes: &'a [u8],
    stream_extents: u32,
    buffer_count: u32,
    /// Total bytes the record occupies; trailing input is ignored.
    pub encoded_len: usize,
}

#[derive(Clone, Copy, Debug)]
pub struct BufferView<'a> {
    pub access: u32,
    bytes: &'a [u8],
    extents_at: usize,
    extent_count: u32,
}

impl SubmissionView<'_> {
    pub fn stream_extent_count(&self) -> u32 {
        self.stream_extents
    }
    pub fn buffer_count(&self) -> u32 {
        self.buffer_count
    }
    pub fn stream_extent(&self, i: u32) -> Option<Extent> {
        if i >= self.stream_extents {
            return None;
        }
        rd_extent(
            self.bytes,
            SUBMISSION_HEADER_SIZE + i as usize * EXTENT_SIZE,
        )
        .ok()
    }
    /// Buffers are variable-length, so lookup walks from the start; counts
    /// are bounded by `KGPU_MAX_BUFFERS`.
    pub fn buffer(&self, index: u32) -> Option<BufferView<'_>> {
        if index >= self.buffer_count {
            return None;
        }
        let mut at = SUBMISSION_HEADER_SIZE + self.stream_extents as usize * EXTENT_SIZE;
        let mut i = 0;
        loop {
            let access = rd_u32(self.bytes, at).ok()?;
            let n = rd_u32(self.bytes, at + 4).ok()?;
            let extents_at = at + BUFFER_HEADER_SIZE;
            if i == index {
                return Some(BufferView {
                    access,
                    bytes: self.bytes,
                    extents_at,
                    extent_count: n,
                });
            }
            at = extents_at + n as usize * EXTENT_SIZE;
            i += 1;
        }
    }
}

impl BufferView<'_> {
    pub fn extent_count(&self) -> u32 {
        self.extent_count
    }
    pub fn extent(&self, i: u32) -> Option<Extent> {
        if i >= self.extent_count {
            return None;
        }
        rd_extent(self.bytes, self.extents_at + i as usize * EXTENT_SIZE).ok()
    }
}

pub fn decode_submission(bytes: &[u8]) -> Result<SubmissionView<'_>, RecordError> {
    use core::mem::offset_of;
    type H = SubmissionHeaderWire;
    let kind_raw = rd_u32(bytes, offset_of!(H, kind))?;
    let kind = SubmissionKind::from_u32(kind_raw).ok_or(RecordError::UnknownKind(kind_raw))?;
    let context = rd_u32(bytes, offset_of!(H, context))?;
    let seqno = rd_u64(bytes, offset_of!(H, seqno))?;
    let stream_extents = rd_u32(bytes, offset_of!(H, stream_extent_count))?;
    let buffer_count = rd_u32(bytes, offset_of!(H, buffer_count))?;
    if stream_extents > KGPU_MAX_EXTENTS || buffer_count > KGPU_MAX_BUFFERS {
        return Err(RecordError::TooMany);
    }
    if kind != SubmissionKind::Submit && (stream_extents != 0 || buffer_count != 0) {
        return Err(RecordError::UnexpectedPayload);
    }
    let mut at = SUBMISSION_HEADER_SIZE
        .checked_add(stream_extents as usize * EXTENT_SIZE)
        .ok_or(RecordError::Truncated)?;
    if at > bytes.len() {
        return Err(RecordError::Truncated);
    }
    for _ in 0..buffer_count {
        let access = rd_u32(bytes, at + offset_of!(BufferHeaderWire, access))?;
        let n = rd_u32(bytes, at + offset_of!(BufferHeaderWire, extent_count))?;
        if n > KGPU_MAX_EXTENTS {
            return Err(RecordError::TooMany);
        }
        if !valid_access(access) {
            return Err(RecordError::BadAccess(access));
        }
        at = at
            .checked_add(BUFFER_HEADER_SIZE + n as usize * EXTENT_SIZE)
            .ok_or(RecordError::Truncated)?;
        if at > bytes.len() {
            return Err(RecordError::Truncated);
        }
    }
    Ok(SubmissionView {
        header: SubmissionHeader {
            kind,
            context,
            seqno,
        },
        bytes,
        stream_extents,
        buffer_count,
        encoded_len: at,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Completion {
    pub kind: CompletionKind,
    pub context: u32,
    pub seqno: u64,
    /// 0 or a negative errno.
    pub status: i32,
}

pub fn encode_completion(out: &mut [u8], c: &Completion) -> Result<usize, RecordError> {
    let mut w = Writer { out, pos: 0 };
    w.u32(c.kind as u32)?;
    w.u32(c.context)?;
    w.u64(c.seqno)?;
    w.put(&c.status.to_le_bytes())?;
    w.u32(0)?;
    Ok(w.pos)
}

pub fn decode_completion(bytes: &[u8]) -> Result<Completion, RecordError> {
    use core::mem::offset_of;
    type C = CompletionWire;
    let kind_raw = rd_u32(bytes, offset_of!(C, kind))?;
    let kind = CompletionKind::from_u32(kind_raw).ok_or(RecordError::UnknownKind(kind_raw))?;
    let status = rd_u32(bytes, offset_of!(C, status))? as i32;
    rd_u32(bytes, offset_of!(C, pad))?;
    Ok(Completion {
        kind,
        context: rd_u32(bytes, offset_of!(C, context))?,
        seqno: rd_u64(bytes, offset_of!(C, seqno))?,
        status,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::mem::{offset_of, size_of};

    /// The encoders write sequentially; the wire structs hosts are generated
    /// from must name the bytes they actually write.
    #[test]
    fn encoders_write_fields_at_the_wire_struct_offsets() {
        let extent = Extent {
            offset: 0x1122_3344_5566_7788,
            len: 0x99aa_bbcc,
            pad: 0,
        };
        let mut out = [0u8; 128];
        let n = encode_submission(
            &mut out,
            &SubmissionHeader {
                kind: SubmissionKind::Submit,
                context: 0x0102_0304,
                seqno: 0x0a0b_0c0d_0e0f_1011,
            },
            &[extent],
            &[BufferSpec {
                access: KGPU_ACCESS_WRITE,
                extents: &[extent, extent],
            }],
        )
        .unwrap();
        assert_eq!(
            n,
            SUBMISSION_HEADER_SIZE + EXTENT_SIZE + BUFFER_HEADER_SIZE + 2 * EXTENT_SIZE
        );
        let u32_at = |at: usize| u32::from_le_bytes(out[at..at + 4].try_into().unwrap());
        let u64_at = |at: usize| u64::from_le_bytes(out[at..at + 8].try_into().unwrap());
        type H = SubmissionHeaderWire;
        assert_eq!(u32_at(offset_of!(H, kind)), SubmissionKind::Submit as u32);
        assert_eq!(u32_at(offset_of!(H, context)), 0x0102_0304);
        assert_eq!(u64_at(offset_of!(H, seqno)), 0x0a0b_0c0d_0e0f_1011);
        assert_eq!(u32_at(offset_of!(H, stream_extent_count)), 1);
        assert_eq!(u32_at(offset_of!(H, buffer_count)), 1);
        let at = SUBMISSION_HEADER_SIZE;
        assert_eq!(u64_at(at + offset_of!(Extent, offset)), extent.offset);
        assert_eq!(u32_at(at + offset_of!(Extent, len)), extent.len);
        let buffer = at + EXTENT_SIZE;
        assert_eq!(
            u32_at(buffer + offset_of!(BufferHeaderWire, access)),
            KGPU_ACCESS_WRITE
        );
        assert_eq!(
            u32_at(buffer + offset_of!(BufferHeaderWire, extent_count)),
            2
        );

        let mut done = [0xffu8; COMPLETION_SIZE];
        encode_completion(
            &mut done,
            &Completion {
                kind: CompletionKind::ContextLost,
                context: 7,
                seqno: 9,
                status: -5,
            },
        )
        .unwrap();
        type C = CompletionWire;
        let c32 = |at: usize| u32::from_le_bytes(done[at..at + 4].try_into().unwrap());
        assert_eq!(c32(offset_of!(C, kind)), CompletionKind::ContextLost as u32);
        assert_eq!(c32(offset_of!(C, context)), 7);
        assert_eq!(u64::from_le_bytes(done[8..16].try_into().unwrap()), 9);
        assert_eq!(offset_of!(C, seqno), 8);
        assert_eq!(c32(offset_of!(C, status)) as i32, -5);
        assert_eq!(c32(offset_of!(C, pad)), 0);
    }

    #[test]
    fn struct_sizes_match_contract() {
        assert_eq!(size_of::<KgpuContextCreate>(), 8);
        assert_eq!(size_of::<KgpuContextDestroy>(), 8);
        assert_eq!(size_of::<KgpuSubmit>(), 40);
        assert_eq!(size_of::<KgpuBuffer>(), 16);
        assert_eq!(size_of::<KgpuWait>(), 24);
        assert_eq!(size_of::<Extent>(), 16);
        assert_eq!(COMPLETION_SIZE, 24);
    }

    #[test]
    fn op_numbers_and_descriptor() {
        assert_eq!(KGPU_OP_CONTEXT_CREATE, 1);
        assert_eq!(KGPU_OP_CONTEXT_DESTROY, 2);
        assert_eq!(KGPU_OP_SUBMIT, 3);
        assert_eq!(KGPU_OP_WAIT, 4);
        assert_eq!(crate::extension_requests::KGPU_V1, 602);
        // The kernel stages the guest argument itself: one InOut buffer
        // sized by the import's `size` argument, which the kernel then
        // requires to equal the op's struct size (at most KgpuSubmit).
        let d = crate::host_abi::request_arg_descriptor(crate::extension_requests::KGPU_V1)
            .expect("descriptor for KGPU_V1");
        assert_eq!(d.args.len(), 1);
        assert_eq!(d.args[0].arg_index, 0);
        assert_eq!(
            d.args[0].direction,
            crate::host_abi::SyscallArgDirection::InOut
        );
        assert!(matches!(
            d.args[0].size,
            crate::host_abi::SyscallArgSize::Arg { arg_index: 1, .. }
        ));
        for op in [
            KGPU_OP_CONTEXT_CREATE,
            KGPU_OP_CONTEXT_DESTROY,
            KGPU_OP_SUBMIT,
            KGPU_OP_WAIT,
        ] {
            assert!(op_arg_size(op).unwrap() <= size_of::<KgpuSubmit>());
        }
        assert_eq!(op_arg_size(0), None);
        assert_eq!(op_arg_size(5), None);
    }

    fn ext(offset: u64, len: u32) -> Extent {
        Extent {
            offset,
            len,
            pad: 0,
        }
    }

    #[test]
    fn submission_roundtrip_multi_extent() {
        let stream = [ext(0x1000, 64), ext(0x9000, 32)];
        let bufext = [ext(0x2000, 100), ext(0x5000, 200), ext(0x7000, 4)];
        let header = SubmissionHeader {
            kind: SubmissionKind::Submit,
            context: 7,
            seqno: 99,
        };
        let mut buf = [0u8; 512];
        let n = encode_submission(
            &mut buf,
            &header,
            &stream,
            &[BufferSpec {
                access: KGPU_ACCESS_WRITE,
                extents: &bufext,
            }],
        )
        .unwrap();
        assert_eq!(n, 24 + 2 * 16 + 8 + 3 * 16);
        let v = decode_submission(&buf[..n]).unwrap();
        assert_eq!(v.header, header);
        assert_eq!(v.encoded_len, n);
        assert_eq!(v.stream_extent_count(), 2);
        assert_eq!(v.stream_extent(0), Some(stream[0]));
        assert_eq!(v.stream_extent(1), Some(stream[1]));
        assert_eq!(v.stream_extent(2), None);
        assert_eq!(v.buffer_count(), 1);
        let b = v.buffer(0).unwrap();
        assert_eq!(b.access, KGPU_ACCESS_WRITE);
        assert_eq!(b.extent_count(), 3);
        for (i, e) in bufext.iter().enumerate() {
            assert_eq!(b.extent(i as u32), Some(*e));
        }
        assert!(v.buffer(1).is_none());
    }

    #[test]
    fn completion_roundtrip() {
        let c = Completion {
            kind: CompletionKind::ContextLost,
            context: 3,
            seqno: 1 << 40,
            status: -19,
        };
        let mut buf = [0u8; 24];
        assert_eq!(encode_completion(&mut buf, &c), Ok(24));
        assert_eq!(decode_completion(&buf), Ok(c));
        assert_eq!(
            encode_completion(&mut buf[..23], &c),
            Err(RecordError::Overflow)
        );
        assert_eq!(decode_completion(&buf[..23]), Err(RecordError::Truncated));
        buf[0] = 9;
        assert_eq!(decode_completion(&buf), Err(RecordError::UnknownKind(9)));
    }

    #[test]
    fn decode_rejects_truncated_and_oversized_counts() {
        let header = SubmissionHeader {
            kind: SubmissionKind::Submit,
            context: 1,
            seqno: 1,
        };
        let mut buf = [0u8; 256];
        let n = encode_submission(
            &mut buf,
            &header,
            &[ext(0, 8)],
            &[BufferSpec {
                access: KGPU_ACCESS_READ,
                extents: &[ext(8, 8)],
            }],
        )
        .unwrap();
        for cut in 0..n {
            assert!(decode_submission(&buf[..cut]).is_err(), "cut {cut}");
        }
        // Oversized stream extent count.
        let mut bad = buf;
        bad[16..20].copy_from_slice(&(KGPU_MAX_EXTENTS + 1).to_le_bytes());
        assert_eq!(
            decode_submission(&bad[..n]).unwrap_err(),
            RecordError::TooMany
        );
        // Count that would overflow a naive size computation.
        bad[16..20].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(
            decode_submission(&bad[..n]).unwrap_err(),
            RecordError::TooMany
        );
        // Oversized buffer count.
        let mut bad = buf;
        bad[20..24].copy_from_slice(&(KGPU_MAX_BUFFERS + 1).to_le_bytes());
        assert_eq!(
            decode_submission(&bad[..n]).unwrap_err(),
            RecordError::TooMany
        );
        // Oversized per-buffer extent count.
        let mut bad = buf;
        let at = 24 + 16 + 4;
        bad[at..at + 4].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(
            decode_submission(&bad[..n]).unwrap_err(),
            RecordError::TooMany
        );
        // Count claims more extents than bytes present.
        let mut bad = buf;
        bad[at..at + 4].copy_from_slice(&5u32.to_le_bytes());
        assert_eq!(
            decode_submission(&bad[..n]).unwrap_err(),
            RecordError::Truncated
        );
        // Bad access and unknown kind.
        let mut bad = buf;
        bad[24 + 16..24 + 20].copy_from_slice(&0u32.to_le_bytes());
        assert_eq!(
            decode_submission(&bad[..n]).unwrap_err(),
            RecordError::BadAccess(0)
        );
        let mut bad = buf;
        bad[0] = 0;
        assert_eq!(
            decode_submission(&bad[..n]).unwrap_err(),
            RecordError::UnknownKind(0)
        );
        // A context-create record must not carry extents.
        let mut bad = buf;
        bad[0] = 2;
        assert_eq!(
            decode_submission(&bad[..n]).unwrap_err(),
            RecordError::UnexpectedPayload
        );
    }
}
