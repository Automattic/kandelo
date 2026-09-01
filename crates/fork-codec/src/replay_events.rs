//! Decoder for the fork replay-event journal (KFRE) wire format.
//!
//! Ported from `host/src/fork-replay-events.ts` (`inspectForkReplayEventWire`
//! / `validateForkReplayEventWire`, plus `decodeForkReplayEventManifest` and
//! `decodeForkReplayEventSegment`). The structural constants live in
//! `crates/shared/src/lib.rs` (`WPK_FORK_MODULE_STATE_REPLAY_EVENT*`).
//!
//! Unlike the linked-frame and module-state arenas, the replay-event journal is
//! NOT a linear-memory pointer walk. It is a self-contained *manifest* byte
//! array followed by an ordered sequence of *segment* byte arrays: the
//! leaf-to-root activation event journal that lets a forked child replay the
//! exact reverse of the parent's cross-module frame commit order. Each event is
//! a `(activation_id, function_ordinal)` pair; unwind records them innermost
//! (leaf) first, and replay consumes them in reverse.
//!
//! Layout recap (all little-endian):
//!
//! Manifest (`WPK_FORK_MODULE_STATE_REPLAY_EVENTS_HEADER_SIZE` = 40 bytes):
//! `+0` magic `KFRE`, `+4` version, `+6` header size, `+8` entry size,
//! `+10` segment header size, `+12` segment capacity (u32), `+16` flags (u16),
//! `+18` reserved (u16, 0), `+20` reserved (u32, 0), `+24` segment count (u64),
//! `+32` event count (u64). The segment count must equal
//! `ceil(event_count / segment_capacity)`.
//!
//! Segment (`WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_HEADER_SIZE` = 24 bytes
//! plus `count * WPK_FORK_MODULE_STATE_REPLAY_EVENT_SIZE` entry bytes):
//! `+0` version, `+2` header size, `+4` entry size, `+6` flags (u16),
//! `+8` sequence (u64), `+16` count (u32), `+20` reserved (u32, 0), then
//! `count` entries of `+0` activation id (u32), `+4` function ordinal (u32).
//!
//! Like `linked_frames` and `module_state`, this decoder is the STRUCTURAL
//! validation and event-extraction half: given the wire bytes it produces the
//! ordered events, the derived active-module set, and the manifest totals,
//! rejecting any framing violation with `Err(Errno::EINVAL)` and never
//! panicking. The LIVE half is deferred to the co-resident module (Phase 6
//! D5+): the stateful `ForkReplayEventJournal` phase machine (capture / seal /
//! peek / consume with its non-consuming atomic peek+consume replay cursor) and
//! the `ForkResumeTable`, which owns a real `WebAssembly.Table` of resume thunks
//! keyed by activation coordinates. Those are runtime instance state, not a
//! pure `&[u8]` decode, exactly as `linked_frames` deferred its live allocator
//! and `module_state` deferred its per-record semantic sub-decoders.

use wasm_posix_shared::abi;
use wasm_posix_shared::Errno;

use alloc::collections::BTreeSet;
use alloc::vec::Vec;

const MAGIC: [u8; 4] = abi::WPK_FORK_MODULE_STATE_REPLAY_EVENTS_MAGIC; // "KFRE"
const VERSION: u16 = abi::WPK_FORK_MODULE_STATE_REPLAY_EVENTS_VERSION;
const HEADER_SIZE: u16 = abi::WPK_FORK_MODULE_STATE_REPLAY_EVENTS_HEADER_SIZE;
const ENTRY_SIZE: u16 = abi::WPK_FORK_MODULE_STATE_REPLAY_EVENT_SIZE;
const KNOWN_FLAGS: u16 = abi::WPK_FORK_MODULE_STATE_REPLAY_EVENTS_KNOWN_FLAGS;
const SEGMENT_VERSION: u16 = abi::WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_VERSION;
const SEGMENT_HEADER_SIZE: u16 = abi::WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_HEADER_SIZE;
const SEGMENT_CAPACITY: u32 = abi::WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_CAPACITY;
const SEGMENT_KNOWN_FLAGS: u16 = abi::WPK_FORK_MODULE_STATE_REPLAY_EVENT_SEGMENT_KNOWN_FLAGS;

/// One replay-event journal entry: the activation and function coordinates that
/// name a committed continuation frame. Mirrors the TS `ForkReplayEvent`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReplayEvent {
    pub activation_id: u32,
    pub function_ordinal: u32,
}

/// The fully decoded replay-event journal: the manifest totals, every event in
/// capture (leaf-to-root) order, and the derived set of active activation ids.
///
/// `events` is in the same order the wire stores them, which is the order
/// `recordCommit` appended during unwind. Replay consumes the exact reverse;
/// that stateful cursor is the deferred live half (see the module doc comment),
/// so this owned struct exposes the ordered source rather than a replay cursor.
/// `activation_ids` mirrors the `ForkReplayEventWireSummary.activationIds` set
/// that `validateForkReplayEventWire` derives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplayEvents {
    pub event_count: u64,
    pub segment_count: u64,
    pub events: Vec<ReplayEvent>,
    pub activation_ids: BTreeSet<u32>,
}

/// Bounds-checked little-endian `u16` read.
fn r_u16(bytes: &[u8], off: u64) -> Result<u16, Errno> {
    let off = usize::try_from(off).map_err(|_| Errno::EINVAL)?;
    let end = off.checked_add(2).ok_or(Errno::EINVAL)?;
    let slice = bytes.get(off..end).ok_or(Errno::EINVAL)?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

/// Bounds-checked little-endian `u32` read.
fn r_u32(bytes: &[u8], off: u64) -> Result<u32, Errno> {
    let off = usize::try_from(off).map_err(|_| Errno::EINVAL)?;
    let end = off.checked_add(4).ok_or(Errno::EINVAL)?;
    let slice = bytes.get(off..end).ok_or(Errno::EINVAL)?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

/// Bounds-checked little-endian `u64` read.
fn r_u64(bytes: &[u8], off: u64) -> Result<u64, Errno> {
    let off = usize::try_from(off).map_err(|_| Errno::EINVAL)?;
    let end = off.checked_add(8).ok_or(Errno::EINVAL)?;
    let slice = bytes.get(off..end).ok_or(Errno::EINVAL)?;
    let mut value: u64 = 0;
    for (index, byte) in slice.iter().enumerate() {
        value |= (*byte as u64) << (8 * index);
    }
    Ok(value)
}

/// Segments needed to hold `event_count` events. Mirrors the TS
/// `segmentCountForEvents`; the `(n - 1) / cap + 1` form avoids the `n + cap`
/// overflow the TS bigint path cannot hit but a `u64` could near its maximum.
fn segment_count_for_events(event_count: u64) -> u64 {
    if event_count == 0 {
        0
    } else {
        (event_count - 1) / SEGMENT_CAPACITY as u64 + 1
    }
}

/// Decode and validate the manifest, returning `(event_count, segment_count)`.
/// Mirrors the TS `decodeForkReplayEventManifest`.
fn decode_manifest(manifest: &[u8]) -> Result<(u64, u64), Errno> {
    // TS distinguishes "truncated" (`< HEADER_SIZE`) from "inconsistent bounds"
    // (`!= HEADER_SIZE`); both are malformed input here.
    if manifest.len() != HEADER_SIZE as usize {
        return Err(Errno::EINVAL);
    }
    if manifest.get(0..4) != Some(&MAGIC[..]) {
        return Err(Errno::EINVAL);
    }
    if r_u16(manifest, 4)? != VERSION
        || r_u16(manifest, 6)? != HEADER_SIZE
        || r_u16(manifest, 8)? != ENTRY_SIZE
        || r_u16(manifest, 10)? != SEGMENT_HEADER_SIZE
        || r_u32(manifest, 12)? != SEGMENT_CAPACITY
    {
        return Err(Errno::EINVAL);
    }
    if r_u16(manifest, 16)? & !KNOWN_FLAGS != 0
        || r_u16(manifest, 18)? != 0
        || r_u32(manifest, 20)? != 0
    {
        return Err(Errno::EINVAL);
    }
    let segment_count = r_u64(manifest, 24)?;
    let event_count = r_u64(manifest, 32)?;
    if segment_count_for_events(event_count) != segment_count {
        return Err(Errno::EINVAL);
    }
    Ok((event_count, segment_count))
}

/// Validate one segment's framing, append its events in order, and record its
/// activation ids. Returns the entry count. Mirrors the TS
/// `decodeForkReplayEventSegment` plus the per-event walk in
/// `inspectForkReplayEventWire`.
fn decode_segment(
    payload: &[u8],
    sequence: u64,
    expected_count: u32,
    events: &mut Vec<ReplayEvent>,
    activation_ids: &mut BTreeSet<u32>,
) -> Result<u32, Errno> {
    if payload.len() < SEGMENT_HEADER_SIZE as usize {
        return Err(Errno::EINVAL); // truncated
    }
    if r_u16(payload, 0)? != SEGMENT_VERSION
        || r_u16(payload, 2)? != SEGMENT_HEADER_SIZE
        || r_u16(payload, 4)? != ENTRY_SIZE
    {
        return Err(Errno::EINVAL);
    }
    if r_u16(payload, 6)? & !SEGMENT_KNOWN_FLAGS != 0 {
        return Err(Errno::EINVAL);
    }
    if r_u64(payload, 8)? != sequence {
        return Err(Errno::EINVAL); // out of order
    }
    let count = r_u32(payload, 16)?;
    if r_u32(payload, 20)? != 0 {
        return Err(Errno::EINVAL); // reserved data
    }
    if count != expected_count {
        return Err(Errno::EINVAL); // wrong entry count (non-final page not full)
    }
    let expected_size = (SEGMENT_HEADER_SIZE as u64)
        .checked_add((count as u64).checked_mul(ENTRY_SIZE as u64).ok_or(Errno::EINVAL)?)
        .ok_or(Errno::EINVAL)?;
    if payload.len() as u64 != expected_size {
        return Err(Errno::EINVAL); // inconsistent bounds
    }
    events.reserve(count as usize);
    for index in 0..count as u64 {
        let offset = SEGMENT_HEADER_SIZE as u64 + index * ENTRY_SIZE as u64;
        let activation_id = r_u32(payload, offset)?;
        let function_ordinal = r_u32(payload, offset + 4)?;
        events.push(ReplayEvent {
            activation_id,
            function_ordinal,
        });
        activation_ids.insert(activation_id);
    }
    Ok(count)
}

/// Decode and validate a replay-event journal wire.
///
/// `manifest` is the 40-byte manifest header; `segments` is the ordered
/// sequence of segment byte arrays (each element is one segment payload, e.g.
/// `journal.capturedSegmentPayloads()` in TS). Returns the ordered events, the
/// derived activation-id set, and the manifest totals. Any framing violation
/// (bad magic/version/sizes, out-of-order or miscounted segment, a non-final
/// page that is not full, a segment count inconsistent with the event count,
/// missing or trailing segments) yields `Err(Errno::EINVAL)`; the function
/// never panics.
///
/// Mirrors `inspectForkReplayEventWire(wire, retainPages = true)` and the
/// exact-set validation in `validateForkReplayEventWire`.
pub fn decode_replay_events(
    manifest: &[u8],
    segments: &[&[u8]],
) -> Result<ReplayEvents, Errno> {
    let (event_count, segment_count) = decode_manifest(manifest)?;

    let mut events: Vec<ReplayEvent> = Vec::new();
    let mut activation_ids: BTreeSet<u32> = BTreeSet::new();
    let mut remaining = event_count;
    let mut sequence: u64 = 0;
    let mut consumed: usize = 0;
    while sequence < segment_count {
        let payload = segments.get(consumed).ok_or(Errno::EINVAL)?; // wire ended early
        // WHY: every non-final page must be full, so the expected count is the
        // segment capacity until the remainder is smaller. `remaining` is
        // always > 0 here because `segment_count == ceil(event_count / cap)`.
        let expected = if remaining > SEGMENT_CAPACITY as u64 {
            SEGMENT_CAPACITY
        } else {
            remaining as u32
        };
        let count = decode_segment(payload, sequence, expected, &mut events, &mut activation_ids)?;
        remaining = remaining.checked_sub(count as u64).ok_or(Errno::EINVAL)?;
        sequence = sequence.checked_add(1).ok_or(Errno::EINVAL)?;
        consumed = consumed.checked_add(1).ok_or(Errno::EINVAL)?;
    }
    // Trailing segments after the declared segment count are malformed.
    if consumed != segments.len() {
        return Err(Errno::EINVAL);
    }
    if remaining != 0 {
        return Err(Errno::EINVAL);
    }

    Ok(ReplayEvents {
        event_count,
        segment_count,
        events,
        activation_ids,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put_u16(bytes: &mut [u8], off: usize, value: u16) {
        bytes[off..off + 2].copy_from_slice(&value.to_le_bytes());
    }

    fn put_u32(bytes: &mut [u8], off: usize, value: u32) {
        bytes[off..off + 4].copy_from_slice(&value.to_le_bytes());
    }

    fn put_u64(bytes: &mut [u8], off: usize, value: u64) {
        bytes[off..off + 8].copy_from_slice(&value.to_le_bytes());
    }

    // --- Cross-language fixture (emitted by the real TS journal) ----------

    /// Bytes are the manifest concatenated with the single captured segment,
    /// emitted by `ForkReplayEventJournal` in host/src/fork-replay-events.ts via
    /// `crates/fork-codec/testdata/gen-replay-events-fixture.mts`. If the TS
    /// journal and this decoder ever disagree on the replay-event wire format,
    /// this test catches the drift.
    const TS_FIXTURE: &[u8] = include_bytes!("../testdata/replay-events-wasm32.bin");

    fn fixture_manifest() -> &'static [u8] {
        &TS_FIXTURE[..HEADER_SIZE as usize]
    }

    fn fixture_segment() -> &'static [u8] {
        &TS_FIXTURE[HEADER_SIZE as usize..]
    }

    #[test]
    fn decodes_ts_emitted_fixture() {
        let manifest = fixture_manifest();
        let segment = fixture_segment();
        let decoded = decode_replay_events(manifest, &[segment]).unwrap();

        assert_eq!(decoded.event_count, 3);
        assert_eq!(decoded.segment_count, 1);
        // Capture (leaf-to-root) order; replay consumes the exact reverse.
        assert_eq!(
            decoded.events,
            alloc::vec![
                ReplayEvent { activation_id: 3, function_ordinal: 8 },
                ReplayEvent { activation_id: 3, function_ordinal: 4 },
                ReplayEvent { activation_id: 0, function_ordinal: 11 },
            ]
        );
        // Derived active-module set: the distinct activation ids.
        let mut expected_ids = BTreeSet::new();
        expected_ids.insert(0u32);
        expected_ids.insert(3u32);
        assert_eq!(decoded.activation_ids, expected_ids);
    }

    #[test]
    fn decodes_empty_journal() {
        // event_count 0 => segment_count 0 => no segments.
        let manifest = encode_manifest(0, 0);
        let decoded = decode_replay_events(&manifest, &[]).unwrap();
        assert_eq!(decoded.event_count, 0);
        assert_eq!(decoded.segment_count, 0);
        assert!(decoded.events.is_empty());
        assert!(decoded.activation_ids.is_empty());
    }

    // --- Manifest negatives (mutations of the genuine fixture) ------------

    fn decode_mutated_manifest(mutate: impl FnOnce(&mut Vec<u8>)) -> Result<ReplayEvents, Errno> {
        let mut manifest = fixture_manifest().to_vec();
        mutate(&mut manifest);
        decode_replay_events(&manifest, &[fixture_segment()])
    }

    #[test]
    fn rejects_truncated_manifest() {
        let mut manifest = fixture_manifest().to_vec();
        manifest.truncate(HEADER_SIZE as usize - 1);
        assert_eq!(
            decode_replay_events(&manifest, &[fixture_segment()]),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_manifest_trailing_bytes() {
        let mut manifest = fixture_manifest().to_vec();
        manifest.push(0);
        assert_eq!(
            decode_replay_events(&manifest, &[fixture_segment()]),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_manifest_bad_magic() {
        assert_eq!(
            decode_mutated_manifest(|m| m[0] ^= 0xff),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_manifest_bad_version() {
        assert_eq!(
            decode_mutated_manifest(|m| put_u16(m, 4, VERSION + 1)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_manifest_bad_header_size() {
        assert_eq!(
            decode_mutated_manifest(|m| put_u16(m, 6, HEADER_SIZE + 8)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_manifest_bad_entry_or_segment_header_size() {
        assert_eq!(
            decode_mutated_manifest(|m| put_u16(m, 8, ENTRY_SIZE + 1)),
            Err(Errno::EINVAL)
        );
        assert_eq!(
            decode_mutated_manifest(|m| put_u16(m, 10, SEGMENT_HEADER_SIZE + 1)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_manifest_bad_segment_capacity() {
        assert_eq!(
            decode_mutated_manifest(|m| put_u32(m, 12, SEGMENT_CAPACITY + 1)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_manifest_nonzero_reserved_fields() {
        assert_eq!(
            decode_mutated_manifest(|m| put_u16(m, 16, 0x8000)),
            Err(Errno::EINVAL)
        );
        assert_eq!(
            decode_mutated_manifest(|m| put_u16(m, 18, 1)),
            Err(Errno::EINVAL)
        );
        assert_eq!(
            decode_mutated_manifest(|m| put_u32(m, 20, 1)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_manifest_inconsistent_counts() {
        // A segment count that disagrees with ceil(event_count / capacity).
        assert_eq!(
            decode_mutated_manifest(|m| put_u64(m, 24, 2)),
            Err(Errno::EINVAL)
        );
        // An event count that no longer matches the single declared segment.
        assert_eq!(
            decode_mutated_manifest(|m| put_u64(m, 32, 5)),
            Err(Errno::EINVAL)
        );
    }

    // --- Segment negatives (mutations of the genuine fixture) -------------

    fn decode_mutated_segment(mutate: impl FnOnce(&mut Vec<u8>)) -> Result<ReplayEvents, Errno> {
        let mut segment = fixture_segment().to_vec();
        mutate(&mut segment);
        decode_replay_events(fixture_manifest(), &[&segment])
    }

    #[test]
    fn rejects_truncated_segment_header() {
        let segment = fixture_segment();
        let short = &segment[..SEGMENT_HEADER_SIZE as usize - 1];
        assert_eq!(
            decode_replay_events(fixture_manifest(), &[short]),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_segment_bad_version_or_layout() {
        assert_eq!(
            decode_mutated_segment(|s| put_u16(s, 0, SEGMENT_VERSION + 1)),
            Err(Errno::EINVAL)
        );
        assert_eq!(
            decode_mutated_segment(|s| put_u16(s, 2, SEGMENT_HEADER_SIZE + 1)),
            Err(Errno::EINVAL)
        );
        assert_eq!(
            decode_mutated_segment(|s| put_u16(s, 4, ENTRY_SIZE + 1)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_segment_unknown_flags() {
        assert_eq!(
            decode_mutated_segment(|s| put_u16(s, 6, 0x0001)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_segment_wrong_sequence() {
        assert_eq!(
            decode_mutated_segment(|s| put_u64(s, 8, 1)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_segment_wrong_count() {
        assert_eq!(
            decode_mutated_segment(|s| put_u32(s, 16, 2)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_segment_reserved_data() {
        assert_eq!(
            decode_mutated_segment(|s| put_u32(s, 20, 1)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_segment_inconsistent_bounds() {
        // Drop one entry's worth of bytes: count still says 3 but bytes are short.
        let mut segment = fixture_segment().to_vec();
        segment.truncate(segment.len() - 1);
        assert_eq!(
            decode_replay_events(fixture_manifest(), &[&segment]),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_missing_segment() {
        assert_eq!(
            decode_replay_events(fixture_manifest(), &[]),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_trailing_segment() {
        // A wire that declares one segment but supplies two.
        let extra = encode_segment(&[(9, 13)], 1);
        assert_eq!(
            decode_replay_events(fixture_manifest(), &[fixture_segment(), &extra]),
            Err(Errno::EINVAL)
        );
    }

    // --- Hand-built multi-segment wire (cross-page ordering) --------------

    fn encode_manifest(event_count: u64, segment_count: u64) -> Vec<u8> {
        let mut m = alloc::vec![0u8; HEADER_SIZE as usize];
        m[0..4].copy_from_slice(&MAGIC);
        put_u16(&mut m, 4, VERSION);
        put_u16(&mut m, 6, HEADER_SIZE);
        put_u16(&mut m, 8, ENTRY_SIZE);
        put_u16(&mut m, 10, SEGMENT_HEADER_SIZE);
        put_u32(&mut m, 12, SEGMENT_CAPACITY);
        put_u16(&mut m, 16, 0);
        put_u64(&mut m, 24, segment_count);
        put_u64(&mut m, 32, event_count);
        m
    }

    fn encode_segment(events: &[(u32, u32)], sequence: u64) -> Vec<u8> {
        let mut s = alloc::vec![0u8; SEGMENT_HEADER_SIZE as usize + events.len() * ENTRY_SIZE as usize];
        put_u16(&mut s, 0, SEGMENT_VERSION);
        put_u16(&mut s, 2, SEGMENT_HEADER_SIZE);
        put_u16(&mut s, 4, ENTRY_SIZE);
        put_u16(&mut s, 6, 0);
        put_u64(&mut s, 8, sequence);
        put_u32(&mut s, 16, events.len() as u32);
        for (index, (activation, ordinal)) in events.iter().enumerate() {
            let off = SEGMENT_HEADER_SIZE as usize + index * ENTRY_SIZE as usize;
            put_u32(&mut s, off, *activation);
            put_u32(&mut s, off + 4, *ordinal);
        }
        s
    }

    /// Build a valid multi-segment wire from `events`, chunked at capacity.
    fn build_wire(events: &[(u32, u32)]) -> (Vec<u8>, Vec<Vec<u8>>) {
        let cap = SEGMENT_CAPACITY as usize;
        let segment_count = segment_count_for_events(events.len() as u64);
        let manifest = encode_manifest(events.len() as u64, segment_count);
        let mut segments: Vec<Vec<u8>> = Vec::new();
        for (index, chunk) in events.chunks(cap).enumerate() {
            segments.push(encode_segment(chunk, index as u64));
        }
        (manifest, segments)
    }

    fn as_slices(segments: &[Vec<u8>]) -> Vec<&[u8]> {
        segments.iter().map(|s| s.as_slice()).collect()
    }

    #[test]
    fn decodes_two_segment_wire_in_capture_order() {
        // One full page plus two events on the next page.
        let total = SEGMENT_CAPACITY as usize + 2;
        let events: Vec<(u32, u32)> = (0..total)
            .map(|index| ((index % 3) as u32, index as u32))
            .collect();
        let (manifest, segments) = build_wire(&events);
        assert_eq!(segments.len(), 2);

        let decoded = decode_replay_events(&manifest, &as_slices(&segments)).unwrap();
        assert_eq!(decoded.event_count, total as u64);
        assert_eq!(decoded.segment_count, 2);
        assert_eq!(decoded.events.len(), total);
        // Capture order is preserved across the page boundary.
        assert_eq!(decoded.events[0], ReplayEvent { activation_id: 0, function_ordinal: 0 });
        assert_eq!(
            decoded.events[SEGMENT_CAPACITY as usize],
            ReplayEvent {
                activation_id: SEGMENT_CAPACITY % 3,
                function_ordinal: SEGMENT_CAPACITY,
            }
        );
        assert_eq!(
            *decoded.events.last().unwrap(),
            ReplayEvent {
                activation_id: ((total - 1) % 3) as u32,
                function_ordinal: (total - 1) as u32,
            }
        );
        let mut expected_ids = BTreeSet::new();
        expected_ids.insert(0u32);
        expected_ids.insert(1u32);
        expected_ids.insert(2u32);
        assert_eq!(decoded.activation_ids, expected_ids);
    }

    #[test]
    fn rejects_non_final_page_not_full() {
        let total = SEGMENT_CAPACITY as usize + 2;
        let events: Vec<(u32, u32)> = (0..total).map(|i| (0, i as u32)).collect();
        let (manifest, mut segments) = build_wire(&events);
        // Shorten the FIRST (non-final) page by one event; the manifest still
        // declares the full event count, so the expected count for page 0 is the
        // capacity and this partial page must be rejected.
        let short = events[..SEGMENT_CAPACITY as usize - 1].to_vec();
        segments[0] = encode_segment(&short, 0);
        assert_eq!(
            decode_replay_events(&manifest, &as_slices(&segments)),
            Err(Errno::EINVAL)
        );
    }

    #[test]
    fn rejects_reordered_segments() {
        let total = SEGMENT_CAPACITY as usize + 1;
        let events: Vec<(u32, u32)> = (0..total).map(|i| (0, i as u32)).collect();
        let (manifest, segments) = build_wire(&events);
        // Swap the two pages: sequence numbers no longer ascend from zero.
        let swapped = alloc::vec![segments[1].as_slice(), segments[0].as_slice()];
        assert_eq!(
            decode_replay_events(&manifest, &swapped),
            Err(Errno::EINVAL)
        );
    }

    // --- Panic-freedom on arbitrary bytes --------------------------------

    #[test]
    fn arbitrary_lengths_never_panic() {
        // Feed progressively truncated fixtures as a single wire buffer split at
        // every possible manifest/segment boundary. Every outcome is Ok or Err.
        for split in 0..=TS_FIXTURE.len() {
            let manifest = &TS_FIXTURE[..split.min(TS_FIXTURE.len())];
            let segment = &TS_FIXTURE[split.min(TS_FIXTURE.len())..];
            let _ = decode_replay_events(manifest, &[segment]);
            let _ = decode_replay_events(segment, &[manifest]);
        }
        // Empty and single-byte inputs.
        let _ = decode_replay_events(&[], &[]);
        let _ = decode_replay_events(&[0u8], &[&[0u8]]);
    }

    #[test]
    fn single_byte_corruptions_never_panic() {
        // Corrupt each byte of the concatenated manifest+segment fixture and
        // confirm the decoder stays panic-free (Ok or Err, either is fine).
        for offset in 0..TS_FIXTURE.len() {
            let mut buffer = TS_FIXTURE.to_vec();
            buffer[offset] ^= 0xff;
            let manifest = &buffer[..HEADER_SIZE as usize];
            let segment = &buffer[HEADER_SIZE as usize..];
            let _ = decode_replay_events(manifest, &[segment]);
        }
    }
}
