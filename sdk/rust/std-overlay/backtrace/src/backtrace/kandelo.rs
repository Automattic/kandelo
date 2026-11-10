//! Captured VM frames, not stack unwinding. Own metadata so resolution stays
//! valid after another capture, executable replacement or a thread exit.
use alloc::{boxed::Box, vec::Vec};
use core::ffi::c_void;

#[path = "kandelo_wire.rs"]
mod wire;

#[derive(Clone)]
pub struct Frame {
    pub(crate) name: Box<[u8]>,
    pub(crate) filename: Box<[u8]>,
    pub(crate) line: Option<u32>,
    pub(crate) column: Option<u32>,
    pc: Option<u64>,
    _function: u32,
    _module_sha256: [u8; 32],
}
impl Frame {
    pub fn ip(&self) -> *mut c_void {
        // A Wasm code offset is an opaque instruction location, never an
        // address to dereference in linear memory. Unavailable PCs stay null.
        self.pc.and_then(|pc| usize::try_from(pc).ok()).unwrap_or(0) as *mut c_void
    }
    pub fn sp(&self) -> *mut c_void {
        core::ptr::null_mut()
    }
    // Function pointers are table indices on this target, not code offsets.
    // Returning a PC here could accidentally match an unrelated table index.
    pub fn symbol_address(&self) -> *mut c_void {
        core::ptr::null_mut()
    }
    pub fn module_base_address(&self) -> Option<*mut c_void> {
        None
    }
}

pub unsafe fn trace(cb: &mut dyn FnMut(&super::Frame) -> bool) {
    let mut packet = Vec::new();
    if packet
        .try_reserve_exact(wire::MAX_PACKET_BYTES as usize)
        .is_err()
    {
        return;
    }
    packet.resize(wire::MAX_PACKET_BYTES as usize, 0);
    // SAFETY: the synchronous import receives exactly this writable capacity.
    // The worker returns independent frame metadata and retains no guest view.
    let length = unsafe {
        wire::capture(
            packet.as_mut_ptr(),
            wire::MAX_PACKET_BYTES,
            wire::MAX_FRAMES,
        )
    };
    if length <= 0 || length as usize > packet.len() {
        return;
    }
    let Some(frames) = decode_packet(&packet[..length as usize]) else {
        return;
    };
    for inner in frames {
        if !cb(&super::Frame { inner }) {
            break;
        }
    }
}

fn u16_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u16::from_le_bytes(bytes.get(at..at.checked_add(2)?)?.try_into().ok()?) as u32)
}
fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(at..at.checked_add(4)?)?.try_into().ok()?,
    ))
}
fn u64_at(bytes: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_le_bytes(
        bytes.get(at..at.checked_add(8)?)?.try_into().ok()?,
    ))
}

pub(crate) fn decode_packet(bytes: &[u8]) -> Option<Vec<Frame>> {
    if bytes.len() < wire::HEADER_BYTES as usize
        || bytes.len() > wire::MAX_PACKET_BYTES as usize
        || u32_at(bytes, 0)? != wire::MAGIC
        || u16_at(bytes, wire::VERSION_OFFSET as usize)? != wire::VERSION
        || u32_at(bytes, wire::LENGTH_OFFSET as usize)? as usize != bytes.len()
    {
        return None;
    }
    let flags = u16_at(bytes, wire::FLAGS_OFFSET as usize)?;
    if flags & !(wire::FLAG_TRUNCATED | wire::FLAG_MODULE_UNRESOLVED) != 0 {
        return None;
    }
    let count = u32_at(bytes, wire::COUNT_OFFSET as usize)?;
    if count > wire::MAX_FRAMES {
        return None;
    }
    let module_sha256: [u8; 32] = bytes
        .get(wire::MODULE_HASH_OFFSET as usize..wire::HEADER_BYTES as usize)?
        .try_into()
        .ok()?;
    let mut frames = Vec::new();
    frames.try_reserve_exact(count as usize).ok()?;
    let mut position = wire::HEADER_BYTES as usize;
    for _ in 0..count {
        let header =
            bytes.get(position..position.checked_add(wire::FRAME_HEADER_BYTES as usize)?)?;
        position += wire::FRAME_HEADER_BYTES as usize;
        let function = u32_at(header, 0)?;
        let flags = u32_at(header, wire::FRAME_FLAGS_OFFSET as usize)?;
        if flags
            & !(wire::FRAME_HAS_PC
                | wire::FRAME_HAS_NAME
                | wire::FRAME_HAS_SOURCE
                | wire::FRAME_MODULE_KNOWN)
            != 0
        {
            return None;
        }
        let pc = u64_at(header, wire::FRAME_PC_OFFSET as usize)?;
        let line = u32_at(header, wire::FRAME_LINE_OFFSET as usize)?;
        let column = u32_at(header, wire::FRAME_COLUMN_OFFSET as usize)?;
        let name_length = u32_at(header, wire::FRAME_NAME_LENGTH_OFFSET as usize)?;
        let file_length = u32_at(header, wire::FRAME_FILE_LENGTH_OFFSET as usize)?;
        if name_length > wire::MAX_NAME_BYTES
            || file_length > wire::MAX_FILE_BYTES
            || (name_length > 0) != (flags & wire::FRAME_HAS_NAME != 0)
            || (flags & wire::FRAME_HAS_PC == 0 && pc != 0)
        {
            return None;
        }
        let source = flags & wire::FRAME_HAS_SOURCE != 0;
        if source {
            if flags & (wire::FRAME_MODULE_KNOWN | wire::FRAME_HAS_PC)
                != wire::FRAME_MODULE_KNOWN | wire::FRAME_HAS_PC
                || file_length == 0
                || line == 0
                || column == 0
            {
                return None;
            }
        } else if file_length != 0 || line != 0 || column != 0 {
            return None;
        }
        let name = bytes.get(position..position.checked_add(name_length as usize)?)?;
        position += name_length as usize;
        let filename = bytes.get(position..position.checked_add(file_length as usize)?)?;
        position += file_length as usize;
        core::str::from_utf8(name).ok()?;
        core::str::from_utf8(filename).ok()?;
        frames.push(Frame {
            name: name.into(),
            filename: filename.into(),
            line: source.then_some(line),
            column: source.then_some(column),
            pc: (flags & wire::FRAME_HAS_PC != 0).then_some(pc),
            _function: function,
            _module_sha256: if flags & wire::FRAME_MODULE_KNOWN != 0 {
                module_sha256
            } else {
                [0; 32]
            },
        });
    }
    if position != bytes.len() {
        return None;
    }
    Some(frames)
}
