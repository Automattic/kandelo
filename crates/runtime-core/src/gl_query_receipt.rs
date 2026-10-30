//! Strict, presently unwired kernel/host query receipt codec. This validates
//! bytes, not owner authority or native retirement. Detach/Transferred are
//! deliberately unsupported until actual cleanup custody can be transferred.
extern crate alloc;
use alloc::vec::Vec;
use wasm_posix_shared::{Errno, gl};

pub const MAGIC: u32 = 0x43525147;
pub const VERSION: u16 = 1;
pub const REQUEST_HEADER: usize = 48;
pub const REPLY_HEADER: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CodecError {
    Malformed,
    Unsupported,
    Allocation,
}
type Result<T> = core::result::Result<T, CodecError>;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u16)]
pub enum Control {
    Begin = 1,
    Poll = 2,
    Commit = 3,
    Cancel = 4,
    Forget = 6,
}
impl Control {
    fn parse(v: u16) -> Result<Self> {
        match v {
            1 => Ok(Self::Begin),
            2 => Ok(Self::Poll),
            3 => Ok(Self::Commit),
            4 => Ok(Self::Cancel),
            6 => Ok(Self::Forget),
            5 => Err(CodecError::Unsupported),
            _ => Err(CodecError::Malformed),
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Mode {
    Commit = 1,
    Cancel = 2,
}
impl Mode {
    fn parse(v: u32) -> Result<Self> {
        match v {
            1 => Ok(Self::Commit),
            2 => Ok(Self::Cancel),
            _ => Err(CodecError::Malformed),
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Begin {
    pub op: u32,
    pub capacity: u32,
    pub has_current: bool,
    pub context: Option<u32>,
    pub draw: u32,
    pub read: u32,
    pub input: Vec<u8>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    pub control: Control,
    pub token: u64,
    pub begin: Option<Begin>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Reply {
    Pending,
    Ready {
        result: i32,
        bytes: Vec<u8>,
    },
    Retiring(Mode),
    /// Cleanup is complete. Accepted means publication for commit, accepted
    /// cancellation for cancel (which MUST be true); it is not a cleanup bit.
    Retired {
        mode: Mode,
        accepted: bool,
    },
    Rejected(Errno),
}
#[derive(Clone, Copy, Debug)]
pub struct ExpectedReply {
    pub control: Control,
    pub token: u64,
    pub capacity: u32,
    /// The already-requested terminal mode, preserved even across cancellation.
    /// Required for Commit/Cancel/Forget; Poll may observe an existing mode.
    pub retirement_mode: Option<Mode>,
}
fn valid_token(token: u64) -> bool {
    token != 0 && token <= i64::MAX as u64
}
fn word(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}
fn half(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap())
}
fn put(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}
fn copy(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut result = Vec::new();
    result
        .try_reserve_exact(bytes.len())
        .map_err(|_| CodecError::Allocation)?;
    result.extend_from_slice(bytes);
    Ok(result)
}
fn header(bytes: &[u8], min: usize, max: usize) -> Result<u64> {
    if bytes.len() < min
        || bytes.len() > max
        || word(bytes, 0) != MAGIC
        || half(bytes, 4) != VERSION
    {
        return Err(CodecError::Malformed);
    }
    let token = word(bytes, 8) as u64 | ((word(bytes, 12) as u64) << 32);
    if !valid_token(token) {
        return Err(CodecError::Malformed);
    }
    Ok(token)
}
fn blank(size: usize, tag: u16, token: u64) -> Result<Vec<u8>> {
    if !valid_token(token) {
        return Err(CodecError::Malformed);
    }
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(size)
        .map_err(|_| CodecError::Allocation)?;
    bytes.resize(size, 0);
    put(&mut bytes, 0, MAGIC);
    bytes[4..6].copy_from_slice(&VERSION.to_le_bytes());
    bytes[6..8].copy_from_slice(&tag.to_le_bytes());
    put(&mut bytes, 8, token as u32);
    put(&mut bytes, 12, (token >> 32) as u32);
    Ok(bytes)
}
fn validate_begin(b: &Begin) -> Result<()> {
    if b.op == gl::KERNEL_GL_QUERY_CONTROL
        || b.capacity > gl::MAX_QUERY_OUT_LEN
        || b.input.len() > gl::MAX_QUERY_IN_LEN as usize
        || b.context == Some(0)
        || (!b.has_current && (b.draw != 0 || b.read != 0))
        || (b.has_current && b.context.is_none())
    {
        return Err(CodecError::Malformed);
    }
    Ok(())
}
pub fn encode_request(request: &Request) -> Result<Vec<u8>> {
    if (request.control == Control::Begin) != request.begin.is_some() {
        return Err(CodecError::Malformed);
    }
    let len = if let Some(b) = &request.begin {
        validate_begin(b)?;
        b.input.len()
    } else {
        0
    };
    let mut bytes = blank(
        REQUEST_HEADER
            .checked_add(len)
            .ok_or(CodecError::Malformed)?,
        request.control as u16,
        request.token,
    )?;
    if let Some(b) = &request.begin {
        put(&mut bytes, 16, b.op);
        put(&mut bytes, 20, len as u32);
        put(&mut bytes, 24, b.capacity);
        put(
            &mut bytes,
            28,
            u32::from(b.has_current) | (u32::from(b.context.is_some()) << 1),
        );
        put(&mut bytes, 32, b.context.unwrap_or(0));
        put(&mut bytes, 36, b.draw);
        put(&mut bytes, 40, b.read);
        bytes[REQUEST_HEADER..].copy_from_slice(&b.input);
    }
    Ok(bytes)
}
pub fn decode_request(bytes: &[u8]) -> Result<Request> {
    let token = header(
        bytes,
        REQUEST_HEADER,
        REQUEST_HEADER + gl::MAX_QUERY_IN_LEN as usize,
    )?;
    let control = Control::parse(half(bytes, 6))?;
    if word(bytes, 44) != 0 {
        return Err(CodecError::Malformed);
    }
    let begin = if control == Control::Begin {
        let flags = word(bytes, 28);
        if flags & !3 != 0
            || word(bytes, 20) as usize != bytes.len() - REQUEST_HEADER
            || (flags & 2 == 0 && word(bytes, 32) != 0)
        {
            return Err(CodecError::Malformed);
        }
        let b = Begin {
            op: word(bytes, 16),
            capacity: word(bytes, 24),
            has_current: flags & 1 != 0,
            context: if flags & 2 != 0 {
                Some(word(bytes, 32))
            } else {
                None
            },
            draw: word(bytes, 36),
            read: word(bytes, 40),
            input: copy(&bytes[REQUEST_HEADER..])?,
        };
        validate_begin(&b)?;
        Some(b)
    } else {
        if bytes.len() != REQUEST_HEADER || bytes[16..].iter().any(|v| *v != 0) {
            return Err(CodecError::Malformed);
        }
        None
    };
    Ok(Request {
        control,
        token,
        begin,
    })
}
fn validate_reply(reply: &Reply, e: ExpectedReply) -> Result<()> {
    if !valid_token(e.token)
        || e.capacity > gl::MAX_QUERY_OUT_LEN
        || (matches!(
            e.control,
            Control::Commit | Control::Cancel | Control::Forget
        ) && e.retirement_mode.is_none())
        || (e.control == Control::Commit && e.retirement_mode != Some(Mode::Commit))
        || (e.control == Control::Begin && e.retirement_mode.is_some())
    {
        return Err(CodecError::Malformed);
    }
    match reply {
        Reply::Pending | Reply::Ready { .. }
            if !matches!(e.control, Control::Begin | Control::Poll)
                || e.retirement_mode.is_some() =>
        {
            return Err(CodecError::Malformed);
        }
        Reply::Retired { .. } if e.control == Control::Begin || e.retirement_mode.is_none() => {
            return Err(CodecError::Malformed);
        }
        Reply::Retiring(Mode::Commit) if e.retirement_mode.is_none() => {
            return Err(CodecError::Malformed);
        }
        Reply::Retiring(_) if e.control == Control::Forget => return Err(CodecError::Malformed),
        Reply::Rejected(_) if !matches!(e.control, Control::Begin) => {
            return Err(CodecError::Malformed);
        }
        _ => (),
    }
    match reply {
        Reply::Ready { result, bytes } => {
            if (*result < 0 && Errno::from_u32(result.unsigned_abs()).is_none())
                || bytes.len() != (*result).max(0) as usize
                || bytes.len() > e.capacity as usize
            {
                return Err(CodecError::Malformed);
            }
        }
        Reply::Retiring(mode) | Reply::Retired { mode, .. } => {
            if e.retirement_mode.is_some_and(|expected| expected != *mode) {
                return Err(CodecError::Malformed);
            }
            if matches!(
                reply,
                Reply::Retired {
                    mode: Mode::Cancel,
                    accepted: false
                }
            ) {
                return Err(CodecError::Malformed);
            }
        }
        _ => (),
    }
    Ok(())
}
pub fn encode_reply(reply: &Reply, e: ExpectedReply) -> Result<Vec<u8>> {
    validate_reply(reply, e)?;
    let (tag, result, flags, payload): (u16, i32, u32, &[u8]) = match reply {
        Reply::Pending => (1, 0, 0, &[]),
        Reply::Ready { result, bytes } => (2, *result, 0, bytes),
        Reply::Retiring(mode) => (3, 0, *mode as u32, &[]),
        Reply::Retired { mode, accepted } => {
            (4, 0, *mode as u32 | (u32::from(*accepted) << 2), &[])
        }
        Reply::Rejected(error) => (6, -(*error as i32), 0, &[]),
    };
    let mut bytes = blank(
        REPLY_HEADER
            .checked_add(payload.len())
            .ok_or(CodecError::Malformed)?,
        tag,
        e.token,
    )?;
    put(&mut bytes, 16, result as u32);
    put(&mut bytes, 20, payload.len() as u32);
    put(&mut bytes, 24, flags);
    bytes[REPLY_HEADER..].copy_from_slice(payload);
    Ok(bytes)
}
pub fn decode_reply(bytes: &[u8], e: ExpectedReply) -> Result<Reply> {
    if header(
        bytes,
        REPLY_HEADER,
        REPLY_HEADER + gl::MAX_QUERY_OUT_LEN as usize,
    )? != e.token
        || word(bytes, 28) != 0
        || word(bytes, 20) as usize != bytes.len() - REPLY_HEADER
    {
        return Err(CodecError::Malformed);
    }
    let result = word(bytes, 16) as i32;
    let flags = word(bytes, 24);
    let phase = half(bytes, 6);
    if phase == 5 {
        return Err(CodecError::Unsupported);
    }
    if (phase != 2 && bytes.len() != REPLY_HEADER) || (matches!(phase, 1 | 3 | 4) && result != 0) {
        return Err(CodecError::Malformed);
    }
    let reply = match phase {
        1 if flags == 0 => Reply::Pending,
        2 if flags == 0 => Reply::Ready {
            result,
            bytes: copy(&bytes[REPLY_HEADER..])?,
        },
        3 => Reply::Retiring(Mode::parse(flags)?),
        4 if flags & !7 == 0 => Reply::Retired {
            mode: Mode::parse(flags & 3)?,
            accepted: flags & 4 != 0,
        },
        6 if flags == 0 && result < 0 => {
            Reply::Rejected(Errno::from_u32(result.unsigned_abs()).ok_or(CodecError::Malformed)?)
        }
        _ => return Err(CodecError::Malformed),
    };
    validate_reply(&reply, e)?;
    Ok(reply)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;
    fn expected(
        control: Control,
        token: u64,
        capacity: u32,
        retirement_mode: Option<Mode>,
    ) -> ExpectedReply {
        ExpectedReply {
            control,
            token,
            capacity,
            retirement_mode,
        }
    }
    fn hex(text: &str) -> Vec<u8> {
        text.as_bytes()
            .chunks_exact(2)
            .map(|p| u8::from_str_radix(core::str::from_utf8(p).unwrap(), 16).unwrap())
            .collect()
    }
    #[test]
    fn shared_wire_vectors_are_exact_and_tokens_never_round() {
        let vectors = include_str!("../../../tests/graphics/gl-query-receipt-wire-v1.tsv");
        assert!(vectors.contains(&alloc::format!(
            "# reservation\t{}\t{}",
            gl::KERNEL_GL_QUERY_CONTROL,
            gl::GL_QUERY_NEEDS_OWNED_ADMISSION
        )));
        let mut count = 0;
        for line in vectors
            .lines()
            .filter(|line| !line.starts_with('#') && !line.is_empty())
        {
            let fields: Vec<_> = line.split('\t').collect();
            let control = Control::parse(fields[2].parse().unwrap()).unwrap();
            let token: u64 = fields[3].parse().unwrap();
            let bytes = hex(fields[6]);
            if fields[1] == "request" {
                let request = decode_request(&bytes).unwrap();
                assert_eq!(request.token, token);
                assert_eq!(request.control, control);
                if fields[0] == "begin-current" {
                    let b = request.begin.as_ref().unwrap();
                    assert_eq!(
                        (b.op, b.capacity, b.context, b.draw, b.read),
                        (49, 4, Some(7), 8, 9)
                    );
                    assert_eq!(b.input, [0xde, 0xad]);
                }
                if fields[0] == "begin-source-with-context" {
                    let b = request.begin.as_ref().unwrap();
                    assert!(!b.has_current);
                    assert_eq!((b.op, b.context, b.draw, b.read), (47, Some(7), 0, 0));
                    assert_eq!(b.input, 7u32.to_le_bytes());
                }
                assert_eq!(encode_request(&request).unwrap(), bytes);
            } else {
                let mode: u32 = fields[5].parse().unwrap();
                let e = expected(
                    control,
                    token,
                    fields[4].parse().unwrap(),
                    if mode == 0 {
                        None
                    } else {
                        Some(Mode::parse(mode).unwrap())
                    },
                );
                let reply = decode_reply(&bytes, e).unwrap();
                if fields[0] == "ready" {
                    assert_eq!(
                        reply,
                        Reply::Ready {
                            result: 3,
                            bytes: b"abc".to_vec()
                        }
                    );
                }
                assert_eq!(encode_reply(&reply, e).unwrap(), bytes);
            }
            count += 1;
        }
        assert_eq!(count, 15);
    }
    fn request() -> Request {
        Request {
            control: Control::Begin,
            token: 1,
            begin: Some(Begin {
                op: gl::QOP_FLUSH,
                capacity: 4,
                has_current: true,
                context: Some(7),
                draw: 0,
                read: 0,
                input: vec![1, 2],
            }),
        }
    }
    #[test]
    fn request_rejects_bad_lengths_flags_authority_and_transfer() {
        let original = encode_request(&request()).unwrap();
        for (offset, value) in [
            (0, 0),
            (4, 2),
            (6, 5),
            (6, 99),
            (8, 0),
            (12, 0x8000_0000),
            (16, gl::KERNEL_GL_QUERY_CONTROL),
            (20, 3),
            (24, 65537),
            (28, 4),
            (28, 1),
            (32, 0),
            (44, 1),
        ] {
            let mut bytes = original.clone();
            if offset == 4 || offset == 6 {
                bytes[offset..offset + 2].copy_from_slice(&(value as u16).to_le_bytes());
            } else {
                put(&mut bytes, offset, value);
            }
            assert!(
                decode_request(&bytes).is_err(),
                "offset {offset}, value {value}"
            );
        }
        for len in 0..48 {
            assert!(decode_request(&original[..len]).is_err());
        }
        let mut stray_surface = original.clone();
        put(&mut stray_surface, 28, 2);
        put(&mut stray_surface, 36, 1);
        assert!(decode_request(&stray_surface).is_err());

        let mut trailing = original.clone();
        trailing.push(0);
        assert!(decode_request(&trailing).is_err());
        let mut control = encode_request(&Request {
            control: Control::Poll,
            token: 1,
            begin: None,
        })
        .unwrap();
        put(&mut control, 16, 1);
        assert!(decode_request(&control).is_err());
        let mut too_big = request();
        too_big.begin.as_mut().unwrap().input = vec![0; 65537];
        assert!(encode_request(&too_big).is_err());
        for token in [0, 1 << 63, u64::MAX] {
            let mut r = request();
            r.token = token;
            assert!(encode_request(&r).is_err());
        }
    }
    #[test]
    fn replies_require_exact_length_token_phase_and_retirement_proof() {
        let e = expected(Control::Poll, 0x20_0000_0000_0001, 4, None);
        let ready = Reply::Ready {
            result: 3,
            bytes: b"abc".to_vec(),
        };
        let original = encode_reply(&ready, e).unwrap();
        for (offset, value) in [
            (0, 0),
            (4, 2),
            (6, 5),
            (6, 99),
            (8, 2),
            (12, 0x8000_0000),
            (16, 2),
            (16, 5),
            (16, i32::MIN as u32),
            (20, 2),
            (24, 1),
            (28, 1),
        ] {
            let mut bytes = original.clone();
            if offset == 4 || offset == 6 {
                bytes[offset..offset + 2].copy_from_slice(&(value as u16).to_le_bytes());
            } else {
                put(&mut bytes, offset, value);
            }
            assert!(
                decode_reply(&bytes, e).is_err(),
                "offset {offset}, value {value}"
            );
        }
        assert!(decode_reply(&original, ExpectedReply { capacity: 2, ..e }).is_err());
        for len in 0..32 {
            assert!(decode_reply(&original[..len], e).is_err());
        }
        let cancel = expected(Control::Cancel, e.token, 4, Some(Mode::Cancel));
        let ack = Reply::Retired {
            mode: Mode::Cancel,
            accepted: true,
        };
        let encoded = encode_reply(&ack, cancel).unwrap();
        assert_eq!(decode_reply(&encoded, cancel).unwrap(), ack);
        assert!(
            decode_reply(
                &encoded,
                ExpectedReply {
                    token: e.token + 1,
                    ..cancel
                }
            )
            .is_err()
        );
        assert!(decode_reply(&encoded, expected(Control::Begin, e.token, 4, None)).is_err());
        assert!(
            decode_reply(
                &encoded,
                expected(Control::Commit, e.token, 4, Some(Mode::Commit))
            )
            .is_err()
        );
        for flags in [0, 1, 2, 3, 7, 8] {
            let mut bytes = encoded.clone();
            put(&mut bytes, 24, flags);
            assert!(decode_reply(&bytes, cancel).is_err());
        }
        let pending = encode_reply(&Reply::Pending, e).unwrap();
        assert!(decode_reply(&pending, cancel).is_err());
        let rejected = encode_reply(
            &Reply::Rejected(Errno::ENOMEM),
            expected(Control::Begin, e.token, 4, None),
        )
        .unwrap();
        assert!(decode_reply(&rejected, cancel).is_err());
        let retiring = encode_reply(&Reply::Retiring(Mode::Cancel), cancel).unwrap();
        assert!(
            decode_reply(
                &retiring,
                expected(Control::Forget, e.token, 4, Some(Mode::Cancel))
            )
            .is_err()
        );
    }
    #[test]
    fn exact_caps_and_owned_decode_preserve_first_bytes() {
        let mut r = request();
        let b = r.begin.as_mut().unwrap();
        b.input = vec![9; 65536];
        b.capacity = 65536;
        let mut encoded = encode_request(&r).unwrap();
        let captured = decode_request(&encoded).unwrap();
        encoded[48] = 0;
        assert_eq!(captured.begin.unwrap().input[0], 9);
        let e = expected(Control::Poll, i64::MAX as u64, 65536, None);
        let reply = Reply::Ready {
            result: 65536,
            bytes: vec![8; 65536],
        };
        let mut bytes = encode_reply(&reply, e).unwrap();
        let decoded = decode_reply(&bytes, e).unwrap();
        bytes[32] = 0;
        assert_eq!(decoded, reply);
        assert!(
            encode_reply(
                &Reply::Ready {
                    result: 65537,
                    bytes: vec![8; 65537]
                },
                e
            )
            .is_err()
        );
        assert!(
            encode_reply(
                &Reply::Ready {
                    result: gl::GL_QUERY_NEEDS_OWNED_ADMISSION,
                    bytes: vec![]
                },
                e
            )
            .is_err()
        );
    }
}
