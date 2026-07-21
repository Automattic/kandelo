//! Checked layout planning for scalable linked fork-continuation frames.
//!
//! The instrumenter publishes this format in every rewritten artifact. The
//! generated frame emitter and host chunk allocator share these checked layout
//! rules. In particular, a frame node is not limited to one 64-KiB WebAssembly
//! page.

use std::fmt;

/// WebAssembly linear-memory allocation granularity.
pub const WASM_PAGE_SIZE: u64 = 64 * 1024;

/// Alignment used for chunk and node records.
pub const RECORD_ALIGNMENT: u64 = 8;

/// Linked-frame artifact metadata version used by ABI 42.
pub const LINKED_FRAME_FORMAT_VERSION: u16 = 1;
pub const LINKED_FRAME_FORMAT_SECTION: &str = "kandelo.wpk_fork.linked_frames";

const FORMAT_DESCRIPTOR_MAGIC: [u8; 4] = *b"KLCF";
const FORMAT_DESCRIPTOR_SIZE: usize = 24;
const FORMAT_FLAG_TRANSACTIONAL_NODES: u16 = 1 << 0;
const FORMAT_KNOWN_FLAGS: u16 = FORMAT_FLAG_TRANSACTIONAL_NODES;

/// Transactional lifecycle for one linked frame node.
///
/// These values are part of the version-1 linked-frame encoding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u16)]
pub enum FrameNodeState {
    Reserved = 1,
    Committed = 2,
    Consumed = 3,
}

/// Pointer representation used by an instrumented module.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PointerWidth {
    Wasm32,
    Wasm64,
}

impl PointerWidth {
    pub const fn bytes(self) -> u64 {
        match self {
            Self::Wasm32 => 4,
            Self::Wasm64 => 8,
        }
    }

    const fn max_record_size(self) -> u64 {
        match self {
            Self::Wasm32 => u32::MAX as u64,
            Self::Wasm64 => u64::MAX,
        }
    }
}

/// Checked layout failure. No caller may truncate one of these values to a
/// guest pointer or continue with a partially computed record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayoutError {
    ArithmeticOverflow,
    Wasm32AddressSpaceExceeded { required: u64 },
    InvalidChunkCursor { used: u64, capacity: u64 },
}

/// Strict decoding failure for the artifact format descriptor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetadataError {
    InvalidLength { actual: usize },
    InvalidMagic,
    UnsupportedVersion { version: u16 },
    UnsupportedPointerWidth { bytes: u8 },
    UnsupportedAlignment { bytes: u8 },
    UnknownFlags { flags: u16 },
    MissingRequiredFlags { flags: u16 },
    HeaderSizeMismatch,
}

impl fmt::Display for MetadataError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidLength { actual } => write!(
                f,
                "linked continuation metadata has length {actual}, expected {FORMAT_DESCRIPTOR_SIZE}"
            ),
            Self::InvalidMagic => write!(f, "linked continuation metadata has invalid magic"),
            Self::UnsupportedVersion { version } => write!(
                f,
                "linked continuation metadata version {version} is unsupported"
            ),
            Self::UnsupportedPointerWidth { bytes } => write!(
                f,
                "linked continuation metadata pointer width {bytes} is unsupported"
            ),
            Self::UnsupportedAlignment { bytes } => write!(
                f,
                "linked continuation metadata alignment {bytes} is unsupported"
            ),
            Self::UnknownFlags { flags } => write!(
                f,
                "linked continuation metadata contains unknown flags 0x{flags:04x}"
            ),
            Self::MissingRequiredFlags { flags } => write!(
                f,
                "linked continuation metadata is missing required flags 0x{flags:04x}"
            ),
            Self::HeaderSizeMismatch => write!(
                f,
                "linked continuation metadata header sizes do not match its pointer width"
            ),
        }
    }
}

impl std::error::Error for MetadataError {}

impl fmt::Display for LayoutError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ArithmeticOverflow => write!(f, "linked continuation layout overflow"),
            Self::Wasm32AddressSpaceExceeded { required } => write!(
                f,
                "linked continuation record requires {required} bytes, exceeding wasm32 addressability"
            ),
            Self::InvalidChunkCursor { used, capacity } => write!(
                f,
                "linked continuation chunk cursor {used} exceeds capacity {capacity}"
            ),
        }
    }
}

impl std::error::Error for LayoutError {}

/// Transaction-planning failure. A failed operation leaves both the committed
/// chain and the active chunk cursor unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlanError {
    Layout(LayoutError),
    PendingReservationExists,
    NoPendingReservation,
    ReservationTokenMismatch,
    ReservationTokenExhausted,
}

impl fmt::Display for PlanError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Layout(error) => error.fmt(f),
            Self::PendingReservationExists => {
                write!(f, "a linked continuation reservation is already pending")
            }
            Self::NoPendingReservation => {
                write!(f, "no linked continuation reservation is pending")
            }
            Self::ReservationTokenMismatch => {
                write!(f, "linked continuation reservation token mismatch")
            }
            Self::ReservationTokenExhausted => {
                write!(f, "linked continuation reservation tokens exhausted")
            }
        }
    }
}

impl std::error::Error for PlanError {}

impl From<LayoutError> for PlanError {
    fn from(error: LayoutError) -> Self {
        Self::Layout(error)
    }
}

/// Layout of one variable-sized frame node.
///
/// The header contains three pointer-width fields (`previous
/// node`, `payload size`, and `total node size`) followed by two u32 fields
/// (`state` and `format/version`). The payload and following node remain
/// eight-byte aligned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameNodeLayout {
    pub header_size: u64,
    pub payload_offset: u64,
    pub payload_size: u64,
    pub node_size: u64,
}

/// Self-describing, address-free properties published by an instrumented
/// artifact. Keeping this descriptor independent of runtime addresses makes it
/// safe to validate before unwind and before allocating any chunks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameFormatDescriptor {
    pub version: u16,
    pub pointer_width: PointerWidth,
    pub alignment: u8,
    pub flags: u16,
    pub chunk_header_size: u32,
    pub node_header_size: u32,
    /// Bytes at the start of the root chunk's payload reserved for the
    /// instrumented runtime header, saved globals, and exception scratch.
    pub fixed_prefix_size: u32,
}

impl FrameFormatDescriptor {
    pub fn current(pointer_width: PointerWidth, fixed_prefix_size: u32) -> Self {
        let chunk_header_size = chunk_header_size(pointer_width)
            .expect("current linked chunk header must be representable");
        let node_header_size = frame_node_header_size(pointer_width)
            .expect("current linked frame header must be representable");
        Self {
            version: LINKED_FRAME_FORMAT_VERSION,
            pointer_width,
            alignment: RECORD_ALIGNMENT as u8,
            flags: FORMAT_FLAG_TRANSACTIONAL_NODES,
            chunk_header_size: chunk_header_size as u32,
            node_header_size: node_header_size as u32,
            fixed_prefix_size,
        }
    }

    pub fn encode(self) -> [u8; FORMAT_DESCRIPTOR_SIZE] {
        let mut encoded = [0; FORMAT_DESCRIPTOR_SIZE];
        encoded[0..4].copy_from_slice(&FORMAT_DESCRIPTOR_MAGIC);
        encoded[4..6].copy_from_slice(&self.version.to_le_bytes());
        encoded[6..8].copy_from_slice(&(FORMAT_DESCRIPTOR_SIZE as u16).to_le_bytes());
        encoded[8] = self.pointer_width.bytes() as u8;
        encoded[9] = self.alignment;
        encoded[10..12].copy_from_slice(&self.flags.to_le_bytes());
        encoded[12..16].copy_from_slice(&self.chunk_header_size.to_le_bytes());
        encoded[16..20].copy_from_slice(&self.node_header_size.to_le_bytes());
        encoded[20..24].copy_from_slice(&self.fixed_prefix_size.to_le_bytes());
        encoded
    }

    pub fn decode(encoded: &[u8]) -> Result<Self, MetadataError> {
        if encoded.len() != FORMAT_DESCRIPTOR_SIZE {
            return Err(MetadataError::InvalidLength {
                actual: encoded.len(),
            });
        }
        if encoded[0..4] != FORMAT_DESCRIPTOR_MAGIC {
            return Err(MetadataError::InvalidMagic);
        }

        let version = u16::from_le_bytes([encoded[4], encoded[5]]);
        if version != LINKED_FRAME_FORMAT_VERSION {
            return Err(MetadataError::UnsupportedVersion { version });
        }
        let declared_size = u16::from_le_bytes([encoded[6], encoded[7]]) as usize;
        if declared_size != FORMAT_DESCRIPTOR_SIZE {
            return Err(MetadataError::InvalidLength {
                actual: declared_size,
            });
        }
        let pointer_width = match encoded[8] {
            4 => PointerWidth::Wasm32,
            8 => PointerWidth::Wasm64,
            bytes => return Err(MetadataError::UnsupportedPointerWidth { bytes }),
        };
        if encoded[9] != RECORD_ALIGNMENT as u8 {
            return Err(MetadataError::UnsupportedAlignment { bytes: encoded[9] });
        }
        let flags = u16::from_le_bytes([encoded[10], encoded[11]]);
        if flags & !FORMAT_KNOWN_FLAGS != 0 {
            return Err(MetadataError::UnknownFlags { flags });
        }
        if flags & FORMAT_FLAG_TRANSACTIONAL_NODES == 0 {
            return Err(MetadataError::MissingRequiredFlags {
                flags: FORMAT_FLAG_TRANSACTIONAL_NODES,
            });
        }
        let chunk_size = u32::from_le_bytes(encoded[12..16].try_into().unwrap());
        let node_size = u32::from_le_bytes(encoded[16..20].try_into().unwrap());
        let fixed_prefix_size = u32::from_le_bytes(encoded[20..24].try_into().unwrap());
        let expected = Self::current(pointer_width, fixed_prefix_size);
        if chunk_size != expected.chunk_header_size || node_size != expected.node_header_size {
            return Err(MetadataError::HeaderSizeMismatch);
        }

        Ok(Self {
            version,
            pointer_width,
            alignment: encoded[9],
            flags,
            chunk_header_size: chunk_size,
            node_header_size: node_size,
            fixed_prefix_size,
        })
    }
}

/// One successful suballocation inside a continuation chunk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameReservation {
    pub node_offset: u64,
    pub payload_offset: u64,
    pub payload_size: u64,
    pub node_size: u64,
    pub next_used: u64,
}

/// Outcome of trying to reserve one complete frame node in the active chunk.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReserveFrame {
    Reserved(FrameReservation),
    NeedsAnotherChunk { required_node_size: u64 },
}

/// Opaque identity for a pending frame reservation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReservationToken(u64);

/// One chunk in a not-yet-emitted linked continuation plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlannedChunk {
    pub capacity: u64,
    pub used: u64,
}

/// A reservation which has not yet advanced its chunk's committed cursor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PendingFrameReservation {
    pub token: ReservationToken,
    pub chunk_index: usize,
    pub frame: FrameReservation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PendingFrame {
    reservation: PendingFrameReservation,
    created_chunk: bool,
}

/// One frame published into the logical continuation chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommittedFrame {
    pub chunk_index: usize,
    pub frame: FrameReservation,
    /// Earlier frame in unwind order. Replay follows this link in reverse.
    pub previous: Option<usize>,
}

/// Transactional model for building a multi-chunk continuation.
///
/// Unwind reserves a complete node before writing it. The chunk cursor moves
/// only when the caller commits that node after all payload writes succeed.
/// Consequently, a cancelled or failed reservation cannot expose a partial
/// frame to replay.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkedContinuationPlan {
    width: PointerWidth,
    preferred_chunk_capacity: u64,
    chunks: Vec<PlannedChunk>,
    committed: Vec<CommittedFrame>,
    pending: Option<PendingFrame>,
    next_token: u64,
}

impl LinkedContinuationPlan {
    pub fn new(width: PointerWidth, preferred_chunk_capacity: u64) -> Self {
        Self {
            width,
            preferred_chunk_capacity,
            chunks: Vec::new(),
            committed: Vec::new(),
            pending: None,
            next_token: 1,
        }
    }

    pub fn chunks(&self) -> &[PlannedChunk] {
        &self.chunks
    }

    pub fn committed_frames(&self) -> &[CommittedFrame] {
        &self.committed
    }

    pub fn pending(&self) -> Option<PendingFrameReservation> {
        self.pending.map(|pending| pending.reservation)
    }

    /// Reserve a complete node without publishing it or advancing `used`.
    pub fn reserve(&mut self, payload_size: u64) -> Result<PendingFrameReservation, PlanError> {
        if self.pending.is_some() {
            return Err(PlanError::PendingReservationExists);
        }

        let next_token = self
            .next_token
            .checked_add(1)
            .ok_or(PlanError::ReservationTokenExhausted)?;
        let mut created_chunk = false;

        let reservation = if let Some(chunk) = self.chunks.last() {
            match reserve_frame(self.width, chunk.capacity, chunk.used, payload_size)? {
                ReserveFrame::Reserved(frame) => PendingFrameReservation {
                    token: ReservationToken(self.next_token),
                    chunk_index: self.chunks.len() - 1,
                    frame,
                },
                ReserveFrame::NeedsAnotherChunk { .. } => {
                    created_chunk = true;
                    self.reserve_in_new_chunk(payload_size)?
                }
            }
        } else {
            created_chunk = true;
            self.reserve_in_new_chunk(payload_size)?
        };

        self.next_token = next_token;
        self.pending = Some(PendingFrame {
            reservation,
            created_chunk,
        });
        Ok(reservation)
    }

    fn reserve_in_new_chunk(
        &mut self,
        payload_size: u64,
    ) -> Result<PendingFrameReservation, PlanError> {
        let capacity = chunk_capacity_for_frame(
            self.width,
            self.preferred_chunk_capacity,
            payload_size,
        )?;
        let used = chunk_header_size(self.width)?;
        let frame = match reserve_frame(self.width, capacity, used, payload_size)? {
            ReserveFrame::Reserved(frame) => frame,
            ReserveFrame::NeedsAnotherChunk { .. } => unreachable!(
                "chunk_capacity_for_frame must accommodate its requested frame"
            ),
        };
        let chunk_index = self.chunks.len();
        self.chunks.push(PlannedChunk { capacity, used });
        Ok(PendingFrameReservation {
            token: ReservationToken(self.next_token),
            chunk_index,
            frame,
        })
    }

    /// Publish the pending frame and advance the active chunk cursor.
    pub fn commit(&mut self, token: ReservationToken) -> Result<CommittedFrame, PlanError> {
        let pending = self.validate_pending(token)?;
        let previous = self.committed.len().checked_sub(1);
        let committed = CommittedFrame {
            chunk_index: pending.reservation.chunk_index,
            frame: pending.reservation.frame,
            previous,
        };
        self.chunks[committed.chunk_index].used = committed.frame.next_used;
        self.committed.push(committed);
        self.pending = None;
        Ok(committed)
    }

    /// Discard the pending frame. A chunk created solely for this reservation
    /// is also discarded, returning the plan to its pre-reservation shape.
    pub fn cancel(&mut self, token: ReservationToken) -> Result<(), PlanError> {
        let pending = self.validate_pending(token)?;
        if pending.created_chunk {
            debug_assert_eq!(pending.reservation.chunk_index + 1, self.chunks.len());
            self.chunks.pop();
        }
        self.pending = None;
        Ok(())
    }

    fn validate_pending(&self, token: ReservationToken) -> Result<PendingFrame, PlanError> {
        let pending = self.pending.ok_or(PlanError::NoPendingReservation)?;
        if pending.reservation.token != token {
            return Err(PlanError::ReservationTokenMismatch);
        }
        Ok(pending)
    }

    /// Frames are committed inner-to-outer during unwind and replayed
    /// outer-to-inner, so replay traverses the committed chain in reverse.
    pub fn replay_order(&self) -> impl Iterator<Item = &CommittedFrame> {
        self.committed.iter().rev()
    }
}

fn checked_align_up(value: u64, alignment: u64) -> Result<u64, LayoutError> {
    debug_assert!(alignment.is_power_of_two());
    value
        .checked_add(alignment - 1)
        .map(|n| n & !(alignment - 1))
        .ok_or(LayoutError::ArithmeticOverflow)
}

fn check_pointer_width(width: PointerWidth, value: u64) -> Result<u64, LayoutError> {
    if value > width.max_record_size() {
        return Err(LayoutError::Wasm32AddressSpaceExceeded { required: value });
    }
    Ok(value)
}

/// Size of the version-1 chunk header: a fixed eight-byte magic/version/flags
/// prefix followed by six pointer-width fields (`root`, `previous`, `next`,
/// `capacity`, `used`, and the root's global committed tail`). Every address
/// is continuation-owned and may be rebased when a chain is aggregated.
pub fn chunk_header_size(width: PointerWidth) -> Result<u64, LayoutError> {
    let pointer_fields = width
        .bytes()
        .checked_mul(6)
        .ok_or(LayoutError::ArithmeticOverflow)?;
    let raw = pointer_fields
        .checked_add(8)
        .ok_or(LayoutError::ArithmeticOverflow)?;
    check_pointer_width(width, checked_align_up(raw, RECORD_ALIGNMENT)?)
}

/// Size of the prospective node header: three pointer-width fields plus two
/// u32 fields, rounded to the record alignment.
pub fn frame_node_header_size(width: PointerWidth) -> Result<u64, LayoutError> {
    let pointer_fields = width
        .bytes()
        .checked_mul(3)
        .ok_or(LayoutError::ArithmeticOverflow)?;
    let raw = pointer_fields
        .checked_add(8)
        .ok_or(LayoutError::ArithmeticOverflow)?;
    check_pointer_width(width, checked_align_up(raw, RECORD_ALIGNMENT)?)
}

/// Compute the complete contiguous node required for one serialized frame.
pub fn frame_node_layout(
    width: PointerWidth,
    payload_size: u64,
) -> Result<FrameNodeLayout, LayoutError> {
    let header_size = frame_node_header_size(width)?;
    let node_size = checked_align_up(
        header_size
            .checked_add(payload_size)
            .ok_or(LayoutError::ArithmeticOverflow)?,
        RECORD_ALIGNMENT,
    )?;
    check_pointer_width(width, node_size)?;
    Ok(FrameNodeLayout {
        header_size,
        payload_offset: header_size,
        payload_size,
        node_size,
    })
}

/// Try to suballocate one complete frame node from the active chunk.
///
/// Returning `NeedsAnotherChunk` is not an error and never exposes a partial
/// reservation. The future emitter must perform all frame/reference writes
/// only after receiving `Reserved`, then publish the node as COMMITTED last.
pub fn reserve_frame(
    width: PointerWidth,
    chunk_capacity: u64,
    used: u64,
    payload_size: u64,
) -> Result<ReserveFrame, LayoutError> {
    let header_size = chunk_header_size(width)?;
    if used < header_size || used > chunk_capacity {
        return Err(LayoutError::InvalidChunkCursor {
            used,
            capacity: chunk_capacity,
        });
    }

    let layout = frame_node_layout(width, payload_size)?;
    let remaining = chunk_capacity - used;
    if layout.node_size > remaining {
        return Ok(ReserveFrame::NeedsAnotherChunk {
            required_node_size: layout.node_size,
        });
    }

    let payload_offset = used
        .checked_add(layout.payload_offset)
        .ok_or(LayoutError::ArithmeticOverflow)?;
    let next_used = used
        .checked_add(layout.node_size)
        .ok_or(LayoutError::ArithmeticOverflow)?;
    check_pointer_width(width, next_used)?;

    Ok(ReserveFrame::Reserved(FrameReservation {
        node_offset: used,
        payload_offset,
        payload_size,
        node_size: layout.node_size,
        next_used,
    }))
}

/// Choose a page-rounded chunk capacity that can hold its header and the
/// requested frame node. `preferred_capacity` is a growth/performance hint,
/// never a maximum.
pub fn chunk_capacity_for_frame(
    width: PointerWidth,
    preferred_capacity: u64,
    payload_size: u64,
) -> Result<u64, LayoutError> {
    let required = chunk_header_size(width)?
        .checked_add(frame_node_layout(width, payload_size)?.node_size)
        .ok_or(LayoutError::ArithmeticOverflow)?;
    let preferred = preferred_capacity.max(WASM_PAGE_SIZE);
    let capacity = checked_align_up(required.max(preferred), WASM_PAGE_SIZE)?;
    check_pointer_width(width, capacity)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headers_follow_pointer_width_and_alignment() {
        assert_eq!(chunk_header_size(PointerWidth::Wasm32), Ok(32));
        assert_eq!(chunk_header_size(PointerWidth::Wasm64), Ok(56));
        assert_eq!(frame_node_header_size(PointerWidth::Wasm32), Ok(24));
        assert_eq!(frame_node_header_size(PointerWidth::Wasm64), Ok(32));
    }

    #[test]
    fn format_descriptor_round_trips_for_both_pointer_widths() {
        for width in [PointerWidth::Wasm32, PointerWidth::Wasm64] {
            let descriptor = FrameFormatDescriptor::current(width, 1234);
            assert_eq!(
                FrameFormatDescriptor::decode(&descriptor.encode()),
                Ok(descriptor)
            );
        }
    }

    #[test]
    fn format_descriptor_rejects_unknown_or_incomplete_contracts() {
        let mut encoded = FrameFormatDescriptor::current(PointerWidth::Wasm32, 32).encode();
        encoded[10..12].copy_from_slice(&(1_u16 << 15).to_le_bytes());
        assert_eq!(
            FrameFormatDescriptor::decode(&encoded),
            Err(MetadataError::UnknownFlags { flags: 1 << 15 })
        );

        encoded[10..12].copy_from_slice(&0_u16.to_le_bytes());
        assert_eq!(
            FrameFormatDescriptor::decode(&encoded),
            Err(MetadataError::MissingRequiredFlags {
                flags: FORMAT_FLAG_TRANSACTIONAL_NODES,
            })
        );
    }

    #[test]
    fn format_descriptor_rejects_layout_mismatch() {
        let mut encoded = FrameFormatDescriptor::current(PointerWidth::Wasm64, 32).encode();
        encoded[12..16].copy_from_slice(&24_u32.to_le_bytes());
        assert_eq!(
            FrameFormatDescriptor::decode(&encoded),
            Err(MetadataError::HeaderSizeMismatch)
        );
    }

    #[test]
    fn reserves_exactly_to_the_chunk_boundary() {
        let width = PointerWidth::Wasm32;
        let header = chunk_header_size(width).unwrap();
        let node = frame_node_layout(width, 100).unwrap();
        let capacity = header + node.node_size;
        assert_eq!(
            reserve_frame(width, capacity, header, 100),
            Ok(ReserveFrame::Reserved(FrameReservation {
                node_offset: header,
                payload_offset: header + node.payload_offset,
                payload_size: 100,
                node_size: node.node_size,
                next_used: capacity,
            }))
        );
    }

    #[test]
    fn one_byte_short_requests_another_chunk_without_partial_reservation() {
        let width = PointerWidth::Wasm64;
        let header = chunk_header_size(width).unwrap();
        let node = frame_node_layout(width, 100).unwrap();
        assert_eq!(
            reserve_frame(width, header + node.node_size - 1, header, 100),
            Ok(ReserveFrame::NeedsAnotherChunk {
                required_node_size: node.node_size,
            })
        );
    }

    #[test]
    fn a_single_frame_can_span_multiple_wasm_pages() {
        let payload_size = WASM_PAGE_SIZE + 29_000;
        let layout = frame_node_layout(PointerWidth::Wasm32, payload_size).unwrap();
        assert!(layout.node_size > WASM_PAGE_SIZE);
        assert_eq!(layout.node_size % RECORD_ALIGNMENT, 0);

        let capacity =
            chunk_capacity_for_frame(PointerWidth::Wasm32, WASM_PAGE_SIZE, payload_size).unwrap();
        assert_eq!(capacity, 2 * WASM_PAGE_SIZE);
        assert!(capacity >= chunk_header_size(PointerWidth::Wasm32).unwrap() + layout.node_size);
    }

    #[test]
    fn preferred_chunk_capacity_is_a_floor_not_a_frame_limit() {
        let small = chunk_capacity_for_frame(PointerWidth::Wasm64, 4 * WASM_PAGE_SIZE, 32).unwrap();
        assert_eq!(small, 4 * WASM_PAGE_SIZE);

        let large =
            chunk_capacity_for_frame(PointerWidth::Wasm64, WASM_PAGE_SIZE, 3 * WASM_PAGE_SIZE)
                .unwrap();
        assert_eq!(large, 4 * WASM_PAGE_SIZE);
    }

    #[test]
    fn rejects_invalid_chunk_cursor() {
        assert_eq!(
            reserve_frame(PointerWidth::Wasm32, 100, 101, 8),
            Err(LayoutError::InvalidChunkCursor {
                used: 101,
                capacity: 100,
            })
        );
        assert_eq!(
            reserve_frame(PointerWidth::Wasm32, 100, 0, 8),
            Err(LayoutError::InvalidChunkCursor {
                used: 0,
                capacity: 100,
            })
        );
    }

    #[test]
    fn rejects_wasm32_node_larger_than_its_address_space() {
        assert_eq!(
            frame_node_layout(PointerWidth::Wasm32, u32::MAX as u64),
            Err(LayoutError::Wasm32AddressSpaceExceeded {
                required: (u32::MAX as u64 + 24 + 7) & !7,
            })
        );
    }

    #[test]
    fn rejects_rounding_overflow() {
        assert_eq!(
            chunk_capacity_for_frame(PointerWidth::Wasm64, WASM_PAGE_SIZE, u64::MAX),
            Err(LayoutError::ArithmeticOverflow)
        );
    }

    #[test]
    fn committed_small_frames_share_a_chunk() {
        let mut plan = LinkedContinuationPlan::new(PointerWidth::Wasm32, WASM_PAGE_SIZE);
        let first = plan.reserve(100).unwrap();
        plan.commit(first.token).unwrap();
        let second = plan.reserve(200).unwrap();
        plan.commit(second.token).unwrap();

        assert_eq!(plan.chunks().len(), 1);
        assert_eq!(plan.committed_frames().len(), 2);
        assert_eq!(plan.committed_frames()[1].previous, Some(0));
        assert_eq!(
            plan.chunks()[0].used,
            plan.committed_frames()[1].frame.next_used
        );
    }

    #[test]
    fn reservation_is_invisible_until_commit_and_cancel_reuses_space() {
        let mut plan = LinkedContinuationPlan::new(PointerWidth::Wasm32, WASM_PAGE_SIZE);
        let header = chunk_header_size(PointerWidth::Wasm32).unwrap();
        let first = plan.reserve(80).unwrap();

        assert_eq!(plan.chunks()[0].used, header);
        assert!(plan.committed_frames().is_empty());
        plan.cancel(first.token).unwrap();
        assert!(plan.chunks().is_empty());

        let replacement = plan.reserve(80).unwrap();
        assert_eq!(replacement.frame.node_offset, header);
        plan.commit(replacement.token).unwrap();
    }

    #[test]
    fn only_one_reservation_can_be_pending() {
        let mut plan = LinkedContinuationPlan::new(PointerWidth::Wasm32, WASM_PAGE_SIZE);
        let pending = plan.reserve(16).unwrap();
        assert_eq!(plan.reserve(16), Err(PlanError::PendingReservationExists));
        assert_eq!(plan.pending(), Some(pending));
    }

    #[test]
    fn token_mismatch_preserves_the_pending_reservation() {
        let mut plan = LinkedContinuationPlan::new(PointerWidth::Wasm64, WASM_PAGE_SIZE);
        let pending = plan.reserve(16).unwrap();
        let wrong = ReservationToken(pending.token.0 + 1);

        assert_eq!(plan.commit(wrong), Err(PlanError::ReservationTokenMismatch));
        assert_eq!(plan.cancel(wrong), Err(PlanError::ReservationTokenMismatch));
        assert_eq!(plan.pending(), Some(pending));
        plan.commit(pending.token).unwrap();
    }

    #[test]
    fn oversized_frame_receives_a_multi_page_chunk() {
        let mut plan = LinkedContinuationPlan::new(PointerWidth::Wasm32, WASM_PAGE_SIZE);
        let pending = plan.reserve(WASM_PAGE_SIZE + 29_000).unwrap();

        assert_eq!(plan.chunks()[pending.chunk_index].capacity, 2 * WASM_PAGE_SIZE);
        plan.commit(pending.token).unwrap();
    }

    #[test]
    fn full_active_chunk_causes_transactional_chunk_growth() {
        let width = PointerWidth::Wasm32;
        let header = chunk_header_size(width).unwrap();
        let first_payload = WASM_PAGE_SIZE - header - frame_node_header_size(width).unwrap();
        let mut plan = LinkedContinuationPlan::new(width, WASM_PAGE_SIZE);
        let first = plan.reserve(first_payload).unwrap();
        plan.commit(first.token).unwrap();
        assert_eq!(plan.chunks()[0].used, WASM_PAGE_SIZE);

        let second = plan.reserve(8).unwrap();
        assert_eq!(second.chunk_index, 1);
        assert_eq!(plan.chunks().len(), 2);
        plan.cancel(second.token).unwrap();
        assert_eq!(plan.chunks().len(), 1);
    }

    #[test]
    fn replay_reverses_unwind_commit_order() {
        let mut plan = LinkedContinuationPlan::new(PointerWidth::Wasm32, WASM_PAGE_SIZE);
        for payload_size in [11, 22, 33] {
            let pending = plan.reserve(payload_size).unwrap();
            plan.commit(pending.token).unwrap();
        }

        let replayed: Vec<u64> = plan
            .replay_order()
            .map(|committed| committed.frame.payload_size)
            .collect();
        assert_eq!(replayed, vec![33, 22, 11]);
    }
}
