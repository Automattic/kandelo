//! Native decoder/ownership tests. Actual VM capture is tested by the host.
extern crate alloc;
#[path = "../../rust/std-overlay/backtrace/src/backtrace/kandelo.rs"]
mod kandelo;
#[path = "../../rust/std-overlay/backtrace/src/backtrace/kandelo_wire.rs"]
mod wire;
pub struct Frame { inner: kandelo::Frame }
#[unsafe(no_mangle)]
extern "C" fn __kandelo_stack_capture_v1(_: *mut u8, _: u32, _: u32) -> i32 { -22 }

fn u32_at(bytes: &mut [u8], offset: u32, value: u32) { bytes[offset as usize..offset as usize + 4].copy_from_slice(&value.to_le_bytes()); }
fn packet() -> Vec<u8> {
    let name = b"user::inner";
    let file = b"/project/src/main.rs";
    let mut bytes = vec![0; (wire::HEADER_BYTES + wire::FRAME_HEADER_BYTES) as usize];
    u32_at(&mut bytes, 0, wire::MAGIC);
    bytes[wire::VERSION_OFFSET as usize..wire::VERSION_OFFSET as usize + 2].copy_from_slice(&(wire::VERSION as u16).to_le_bytes());
    u32_at(&mut bytes, wire::COUNT_OFFSET, 1);
    bytes[wire::MODULE_HASH_OFFSET as usize..wire::HEADER_BYTES as usize].fill(7);
    let base = wire::HEADER_BYTES;
    u32_at(&mut bytes, base, 3);
    u32_at(&mut bytes, base + wire::FRAME_FLAGS_OFFSET, wire::FRAME_HAS_PC | wire::FRAME_HAS_NAME | wire::FRAME_HAS_SOURCE | wire::FRAME_MODULE_KNOWN);
    bytes[(base + wire::FRAME_PC_OFFSET) as usize..(base + wire::FRAME_PC_OFFSET + 8) as usize].copy_from_slice(&128u64.to_le_bytes());
    u32_at(&mut bytes, base + wire::FRAME_LINE_OFFSET, 42);
    u32_at(&mut bytes, base + wire::FRAME_COLUMN_OFFSET, 7);
    u32_at(&mut bytes, base + wire::FRAME_NAME_LENGTH_OFFSET, name.len() as u32);
    u32_at(&mut bytes, base + wire::FRAME_FILE_LENGTH_OFFSET, file.len() as u32);
    bytes.extend_from_slice(name);
    bytes.extend_from_slice(file);
    let length = bytes.len() as u32;
    u32_at(&mut bytes, wire::LENGTH_OFFSET, length);
    bytes
}
#[test]
fn captured_frames_own_their_metadata_after_buffer_reuse() {
    let mut bytes = packet();
    let frame = kandelo::decode_packet(&bytes).unwrap().remove(0);
    bytes.fill(0);
    let frame = frame.clone();
    assert_eq!(&*frame.name, b"user::inner");
    assert_eq!(&*frame.filename, b"/project/src/main.rs");
    assert_eq!(frame.line, Some(42));
    assert_eq!(frame.column, Some(7));
    assert_eq!(frame.ip().addr(), 128);
    assert!(frame.sp().is_null());
    assert!(frame.module_base_address().is_none());
}
#[test]
fn truncated_unknown_and_inconsistent_packets_are_rejected() {
    let valid = packet();
    for length in 0..valid.len() { assert!(kandelo::decode_packet(&valid[..length]).is_none(), "{length}"); }
    for (offset, value) in [
        (0,0), (wire::COUNT_OFFSET,wire::MAX_FRAMES + 1),
        (wire::HEADER_BYTES + wire::FRAME_FLAGS_OFFSET, 0x80000000),
        (wire::HEADER_BYTES + wire::FRAME_NAME_LENGTH_OFFSET,wire::MAX_NAME_BYTES + 1),
        (wire::HEADER_BYTES + wire::FRAME_FILE_LENGTH_OFFSET,0),
    ] {
        let mut invalid = valid.clone(); u32_at(&mut invalid, offset, value);
        assert!(kandelo::decode_packet(&invalid).is_none());
    }
}
