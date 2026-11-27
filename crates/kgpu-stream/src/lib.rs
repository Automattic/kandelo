//! The kgpu command-stream wire format.
//!
//! Ownership: this crate is the single definition of the bytes a guest GL
//! driver writes and the GPU executor reads. Keeping it `no_std`,
//! dependency-free and allocation-free lets the same code run inside a guest
//! process, inside the kernel module, and in host tests, and lets
//! `cargo xtask dump-abi` derive the C header from these definitions instead
//! of a hand-kept copy.
//!
//! Layout (all fields little-endian, every record 4-byte aligned):
//!
//! ```text
//! stream header  { magic: u32, version: u16, reserved: u16,
//!                  context: u32, record_bytes: u32 }          16 bytes
//! record         { op: u16, flags: u16, len: u32 } + payload   8 + len
//! ```
//!
//! `record_bytes` counts every record byte after the stream header, so a
//! reader can bound its single copy of the stream before interpreting it.
//! Decoding treats the input as hostile: all arithmetic is checked and every
//! malformed input yields a `StreamError`, never a panic.
#![cfg_attr(not(test), no_std)]

pub const KGPU_STREAM_VERSION: u16 = 1;
/// "KKGU" read as little-endian bytes.
pub const KGPU_STREAM_MAGIC: u32 = 0x5547_4B4B;
pub const STREAM_HEADER_SIZE: usize = 16;
pub const RECORD_HEADER_SIZE: usize = 8;

/// Clear mask bits use the WebGL values so the driver passes GL masks through.
pub const CLEAR_COLOR_BIT: u32 = 0x4000;
pub const CLEAR_DEPTH_BIT: u32 = 0x100;
pub const CLEAR_STENCIL_BIT: u32 = 0x400;

pub const VIEWPORT_PAYLOAD_SIZE: u32 = 16;
pub const CLEAR_COLOR_PAYLOAD_SIZE: u32 = 16;
pub const CLEAR_PAYLOAD_SIZE: u32 = 4;
pub const READ_PIXELS_PAYLOAD_SIZE: u32 = 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u16)]
pub enum Op {
    Viewport = 1,
    ClearColor = 2,
    Clear = 3,
    /// RGBA8 into entry `buffer` of the submission's buffer table.
    ReadPixels = 4,
}

impl Op {
    pub fn from_u16(v: u16) -> Option<Op> {
        match v {
            1 => Some(Op::Viewport),
            2 => Some(Op::ClearColor),
            3 => Some(Op::Clear),
            4 => Some(Op::ReadPixels),
            _ => None,
        }
    }

    pub fn payload_size(self) -> u32 {
        match self {
            Op::Viewport => VIEWPORT_PAYLOAD_SIZE,
            Op::ClearColor => CLEAR_COLOR_PAYLOAD_SIZE,
            Op::Clear => CLEAR_PAYLOAD_SIZE,
            Op::ReadPixels => READ_PIXELS_PAYLOAD_SIZE,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Command {
    Viewport { x: i32, y: i32, w: i32, h: i32 },
    ClearColor { r: f32, g: f32, b: f32, a: f32 },
    Clear { mask: u32 },
    ReadPixels { x: i32, y: i32, w: i32, h: i32, buffer: u32 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamError {
    BadMagic,
    BadVersion,
    Truncated,
    Misaligned,
    UnknownOp(u16),
    BadLength { op: u16, len: u32 },
    Overflow,
}

/// Writes records into a caller-owned buffer. The stream header is
/// reserved up front and finalized by `finish`, so the encoder never
/// allocates and a too-small buffer is reported rather than truncated.
pub struct Encoder<'a> {
    out: &'a mut [u8],
    context: u32,
    pos: usize,
    overflowed: bool,
}

impl<'a> Encoder<'a> {
    pub fn new(out: &'a mut [u8], context: u32) -> Self {
        let overflowed = out.len() < STREAM_HEADER_SIZE;
        Encoder { out, context, pos: STREAM_HEADER_SIZE, overflowed }
    }

    fn record(&mut self, op: Op, payload: &[u8]) -> Result<(), StreamError> {
        if self.overflowed {
            return Err(StreamError::Overflow);
        }
        let end = self
            .pos
            .checked_add(RECORD_HEADER_SIZE)
            .and_then(|e| e.checked_add(payload.len()))
            .ok_or(StreamError::Overflow)?;
        if end > self.out.len() {
            // Later records must not follow a dropped one.
            self.overflowed = true;
            return Err(StreamError::Overflow);
        }
        let p = self.pos;
        self.out[p..p + 2].copy_from_slice(&(op as u16).to_le_bytes());
        self.out[p + 2..p + 4].copy_from_slice(&0u16.to_le_bytes());
        self.out[p + 4..p + 8].copy_from_slice(&(payload.len() as u32).to_le_bytes());
        self.out[p + 8..end].copy_from_slice(payload);
        self.pos = end;
        Ok(())
    }

    pub fn viewport(&mut self, x: i32, y: i32, w: i32, h: i32) -> Result<(), StreamError> {
        let mut b = [0u8; 16];
        b[0..4].copy_from_slice(&x.to_le_bytes());
        b[4..8].copy_from_slice(&y.to_le_bytes());
        b[8..12].copy_from_slice(&w.to_le_bytes());
        b[12..16].copy_from_slice(&h.to_le_bytes());
        self.record(Op::Viewport, &b)
    }

    pub fn clear_color(&mut self, r: f32, g: f32, b_: f32, a: f32) -> Result<(), StreamError> {
        let mut b = [0u8; 16];
        b[0..4].copy_from_slice(&r.to_le_bytes());
        b[4..8].copy_from_slice(&g.to_le_bytes());
        b[8..12].copy_from_slice(&b_.to_le_bytes());
        b[12..16].copy_from_slice(&a.to_le_bytes());
        self.record(Op::ClearColor, &b)
    }

    pub fn clear(&mut self, mask: u32) -> Result<(), StreamError> {
        self.record(Op::Clear, &mask.to_le_bytes())
    }

    pub fn read_pixels(
        &mut self,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        buffer: u32,
    ) -> Result<(), StreamError> {
        let mut b = [0u8; 20];
        b[0..4].copy_from_slice(&x.to_le_bytes());
        b[4..8].copy_from_slice(&y.to_le_bytes());
        b[8..12].copy_from_slice(&w.to_le_bytes());
        b[12..16].copy_from_slice(&h.to_le_bytes());
        b[16..20].copy_from_slice(&buffer.to_le_bytes());
        self.record(Op::ReadPixels, &b)
    }

    /// Writes the stream header and returns the total stream length.
    pub fn finish(self) -> Result<usize, StreamError> {
        if self.overflowed {
            return Err(StreamError::Overflow);
        }
        let record_bytes = (self.pos - STREAM_HEADER_SIZE) as u32;
        let o = self.out;
        o[0..4].copy_from_slice(&KGPU_STREAM_MAGIC.to_le_bytes());
        o[4..6].copy_from_slice(&KGPU_STREAM_VERSION.to_le_bytes());
        o[6..8].copy_from_slice(&0u16.to_le_bytes());
        o[8..12].copy_from_slice(&self.context.to_le_bytes());
        o[12..16].copy_from_slice(&record_bytes.to_le_bytes());
        Ok(self.pos)
    }
}

pub struct Decoded<'a> {
    pub context: u32,
    pub records: RecordIter<'a>,
}

#[derive(Clone)]
pub struct RecordIter<'a> {
    rest: &'a [u8],
}

fn u32_at(b: &[u8], i: usize) -> u32 {
    u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]])
}
fn i32_at(b: &[u8], i: usize) -> i32 {
    u32_at(b, i) as i32
}
fn f32_at(b: &[u8], i: usize) -> f32 {
    f32::from_bits(u32_at(b, i))
}

/// Validates the stream header and bounds the record region to the
/// header's `record_bytes`; records themselves are validated lazily.
pub fn decode(bytes: &[u8]) -> Result<Decoded<'_>, StreamError> {
    if bytes.len() < STREAM_HEADER_SIZE {
        return Err(StreamError::Truncated);
    }
    if u32_at(bytes, 0) != KGPU_STREAM_MAGIC {
        return Err(StreamError::BadMagic);
    }
    if u16::from_le_bytes([bytes[4], bytes[5]]) != KGPU_STREAM_VERSION {
        return Err(StreamError::BadVersion);
    }
    let context = u32_at(bytes, 8);
    let record_bytes = u32_at(bytes, 12) as usize;
    let end = STREAM_HEADER_SIZE
        .checked_add(record_bytes)
        .ok_or(StreamError::Truncated)?;
    if end > bytes.len() {
        return Err(StreamError::Truncated);
    }
    Ok(Decoded { context, records: RecordIter { rest: &bytes[STREAM_HEADER_SIZE..end] } })
}

impl<'a> Iterator for RecordIter<'a> {
    type Item = Result<Command, StreamError>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.rest.is_empty() {
            return None;
        }
        let r = self.parse();
        if r.is_err() {
            // A malformed record leaves no trustworthy boundary to resume at.
            self.rest = &[];
        }
        Some(r)
    }
}

impl<'a> RecordIter<'a> {
    fn parse(&mut self) -> Result<Command, StreamError> {
        let b = self.rest;
        if b.len() < RECORD_HEADER_SIZE {
            return Err(StreamError::Truncated);
        }
        let op = u16::from_le_bytes([b[0], b[1]]);
        let len = u32_at(b, 4);
        if len % 4 != 0 {
            return Err(StreamError::Misaligned);
        }
        let total = (len as usize)
            .checked_add(RECORD_HEADER_SIZE)
            .ok_or(StreamError::Truncated)?;
        if total > b.len() {
            return Err(StreamError::Truncated);
        }
        let known = Op::from_u16(op).ok_or(StreamError::UnknownOp(op))?;
        if known.payload_size() != len {
            return Err(StreamError::BadLength { op, len });
        }
        let p = &b[RECORD_HEADER_SIZE..total];
        let cmd = match known {
            Op::Viewport => Command::Viewport {
                x: i32_at(p, 0),
                y: i32_at(p, 4),
                w: i32_at(p, 8),
                h: i32_at(p, 12),
            },
            Op::ClearColor => Command::ClearColor {
                r: f32_at(p, 0),
                g: f32_at(p, 4),
                b: f32_at(p, 8),
                a: f32_at(p, 12),
            },
            Op::Clear => Command::Clear { mask: u32_at(p, 0) },
            Op::ReadPixels => Command::ReadPixels {
                x: i32_at(p, 0),
                y: i32_at(p, 4),
                w: i32_at(p, 8),
                h: i32_at(p, 12),
                buffer: u32_at(p, 16),
            },
        };
        self.rest = &b[total..];
        Ok(cmd)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(buf: &mut [u8]) -> usize {
        let mut e = Encoder::new(buf, 7);
        e.viewport(0, 0, 4, 4).unwrap();
        e.clear_color(0.25, 0.5, 0.75, 1.0).unwrap();
        e.clear(CLEAR_COLOR_BIT).unwrap();
        e.read_pixels(0, 0, 4, 4, 0).unwrap();
        e.finish().unwrap()
    }

    #[test]
    fn encode_decode_roundtrip() {
        let mut buf = [0u8; 256];
        let n = sample(&mut buf);
        let d = decode(&buf[..n]).unwrap();
        assert_eq!(d.context, 7);
        let cmds: Vec<_> = d.records.collect::<Result<_, _>>().unwrap();
        assert_eq!(
            cmds,
            vec![
                Command::Viewport { x: 0, y: 0, w: 4, h: 4 },
                Command::ClearColor { r: 0.25, g: 0.5, b: 0.75, a: 1.0 },
                Command::Clear { mask: 0x4000 },
                Command::ReadPixels { x: 0, y: 0, w: 4, h: 4, buffer: 0 },
            ]
        );
    }

    #[test]
    fn rejects_bad_magic_version_truncation() {
        let mut buf = [0u8; 256];
        let n = sample(&mut buf);
        let good = buf[..n].to_vec();

        let mut m = good.clone();
        m[0] ^= 0xff;
        assert_eq!(decode(&m).err(), Some(StreamError::BadMagic));

        let mut v = good.clone();
        v[4] = 2;
        assert_eq!(decode(&v).err(), Some(StreamError::BadVersion));

        assert_eq!(decode(&good[..8]).err(), Some(StreamError::Truncated));
        assert_eq!(decode(&good[..n - 1]).err(), Some(StreamError::Truncated));
    }

    #[test]
    fn rejects_unknown_op_and_wrong_length() {
        let mut buf = [0u8; 256];
        let mut e = Encoder::new(&mut buf, 1);
        e.clear(0).unwrap();
        let n = e.finish().unwrap();

        let mut unk = buf[..n].to_vec();
        unk[16] = 99;
        let d = decode(&unk).unwrap();
        let r: Vec<_> = d.records.collect();
        assert_eq!(r, vec![Err(StreamError::UnknownOp(99))]);

        // ClearColor needs 16 payload bytes; give it 12.
        let mut bad = Vec::new();
        bad.extend_from_slice(&KGPU_STREAM_MAGIC.to_le_bytes());
        bad.extend_from_slice(&KGPU_STREAM_VERSION.to_le_bytes());
        bad.extend_from_slice(&0u16.to_le_bytes());
        bad.extend_from_slice(&1u32.to_le_bytes());
        bad.extend_from_slice(&20u32.to_le_bytes());
        bad.extend_from_slice(&2u16.to_le_bytes());
        bad.extend_from_slice(&0u16.to_le_bytes());
        bad.extend_from_slice(&12u32.to_le_bytes());
        bad.extend_from_slice(&[0u8; 12]);
        let r: Vec<_> = decode(&bad).unwrap().records.collect();
        assert_eq!(r, vec![Err(StreamError::BadLength { op: 2, len: 12 })]);
    }

    #[test]
    fn rejects_misaligned_and_oversized_lengths() {
        let mut buf = [0u8; 64];
        let mut e = Encoder::new(&mut buf, 1);
        e.clear(0).unwrap();
        let n = e.finish().unwrap();
        let mut m = buf[..n].to_vec();
        m[20] = 3;
        let r: Vec<_> = decode(&m).unwrap().records.collect();
        assert_eq!(r, vec![Err(StreamError::Misaligned)]);
        let mut m = buf[..n].to_vec();
        m[20..24].copy_from_slice(&u32::MAX.wrapping_sub(3).to_le_bytes());
        let r: Vec<_> = decode(&m).unwrap().records.collect();
        assert_eq!(r, vec![Err(StreamError::Truncated)]);
    }

    #[test]
    fn encoder_reports_overflow() {
        let mut buf = [0u8; 16];
        let mut e = Encoder::new(&mut buf, 7);
        assert_eq!(e.viewport(0, 0, 1, 1), Err(StreamError::Overflow));
        assert_eq!(e.finish(), Err(StreamError::Overflow));
    }
}
