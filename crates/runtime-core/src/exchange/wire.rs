//! Byte layouts that cross the kernel/host boundary for Kandelo exchange.
//!
//! All integers are little-endian. Optional byte strings carry a `u16`
//! length, with `0xFFFF` meaning absent (distinct from empty).
//!
//! **Entry record** (`kernel_exchange_add_entry`):
//!
//! | Bytes | Field |
//! |---|---|
//! | 16 | batch ID |
//! | 1 | kind: 1 file, 2 directory, 3 stream (size 0) |
//! | 3 | reserved, zero |
//! | 8 | source |
//! | 8 | size |
//! | 8 | mtime seconds |
//! | 4 | mtime nanoseconds |
//! | 4 | index, `u32::MAX` for none |
//! | 2 | component count, then each component as `u16` length + bytes |
//! | var | MIME type, origin URL, original name: optional byte strings |
//!
//! **Notification record** (`kernel_exchange_drain_notifications`): `u16`
//! total length (header included), `u8` kind, then the kind's payload:
//!
//! | Kind | Payload |
//! |---|---|
//! | 1 committed | batch ID |
//! | 2 settled | batch ID, `u8` outcome (1 removed, 2 discarded, 3 cancelled), status as `u16` length + bytes |
//! | 3 status | batch ID, status |
//! | 4 source released | `u64` source |
//! | 5 output published | output ID, `u8` kind (1 stored, 2 stream), `u64` size, name, optional MIME type, `u16` count + IDs |
//! | 6 output withdrawn | output ID |
//! | 7 consumer | `u8` 1 present, 0 absent |
//! | 8 stream demand | `u64` source, `u32` free bytes |
//! | 9 stream readable | output ID |
//! | 10 activation check | (none) |
//! | 11 consumer state | `u8` state (1 unavailable, 2 idle, 3 starting, 4 ready), `u8` activation (0 off, 1 on-demand), `u8` last failure (0 none, 1 exit status, 2 signal, 3 errno), `i32` its value |
//! | 12 activation timer | `u32` delay in milliseconds |

use alloc::vec::Vec;
use wasm_posix_shared::Errno;

use super::batches::{EntryKind, Notification, Outcome, StagedEntry};
use super::ids::ExchangeId;

const ABSENT: u16 = 0xFFFF;
/// Fixed part of an entry record, before the components.
pub const ENTRY_FIXED_BYTES: usize = 16 + 1 + 3 + 8 + 8 + 8 + 4 + 4 + 2;

struct Reader<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8], Errno> {
        let end = self.position.checked_add(count).ok_or(Errno::EINVAL)?;
        let slice = self.bytes.get(self.position..end).ok_or(Errno::EINVAL)?;
        self.position = end;
        Ok(slice)
    }
    fn u8(&mut self) -> Result<u8, Errno> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, Errno> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into().map_err(|_| Errno::EINVAL)?))
    }
    fn u32(&mut self) -> Result<u32, Errno> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().map_err(|_| Errno::EINVAL)?))
    }
    fn u64(&mut self) -> Result<u64, Errno> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().map_err(|_| Errno::EINVAL)?))
    }
    fn id(&mut self) -> Result<ExchangeId, Errno> {
        self.take(16)?.try_into().map_err(|_| Errno::EINVAL)
    }
    fn optional(&mut self) -> Result<Option<Vec<u8>>, Errno> {
        match self.u16()? {
            ABSENT => Ok(None),
            length => Ok(Some(self.take(usize::from(length))?.to_vec())),
        }
    }
}

/// Decode an entry record into its batch and entry. Trailing bytes are EINVAL.
pub fn decode_entry(bytes: &[u8]) -> Result<(ExchangeId, StagedEntry), Errno> {
    let mut reader = Reader { bytes, position: 0 };
    let batch = reader.id()?;
    let kind = reader.u8()?;
    if reader.take(3)? != [0, 0, 0] {
        return Err(Errno::EINVAL);
    }
    let source = reader.u64()?;
    let size = reader.u64()?;
    let mtime = (reader.u64()?, reader.u32()?);
    if mtime.1 >= 1_000_000_000 {
        return Err(Errno::EINVAL);
    }
    let index = match reader.u32()? {
        u32::MAX => None,
        index => Some(index),
    };
    let count = reader.u16()?;
    let mut path = Vec::new();
    for _ in 0..count {
        let length = reader.u16()?;
        path.push(reader.take(usize::from(length))?.to_vec());
    }
    let mime_type = reader.optional()?;
    let origin_url = reader.optional()?;
    let original_name = reader.optional()?;
    if reader.position != bytes.len() {
        return Err(Errno::EINVAL);
    }
    let kind = match kind {
        1 => EntryKind::File { source, size },
        2 => EntryKind::Directory,
        3 if size == 0 => EntryKind::Stream { source },
        _ => return Err(Errno::EINVAL),
    };
    Ok((
        batch,
        StagedEntry { path, kind: Some(kind), mime_type, origin_url, original_name, index, mtime },
    ))
}

fn push_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn push_string(out: &mut Vec<u8>, bytes: &[u8]) {
    push_u16(out, bytes.len().min(usize::from(ABSENT - 1)) as u16);
    out.extend_from_slice(&bytes[..bytes.len().min(usize::from(ABSENT - 1))]);
}

fn push_optional(out: &mut Vec<u8>, bytes: &Option<Vec<u8>>) {
    match bytes {
        Some(bytes) => push_string(out, bytes),
        None => push_u16(out, ABSENT),
    }
}

/// Encode one notification record.
pub fn encode_notification(notification: &Notification) -> Vec<u8> {
    let mut body = Vec::new();
    let kind: u8 = match notification {
        Notification::Committed { batch } => {
            body.extend_from_slice(batch);
            1
        }
        Notification::Settled { batch, outcome, status } => {
            body.extend_from_slice(batch);
            body.push(match outcome {
                Outcome::Removed => 1,
                Outcome::Discarded => 2,
                Outcome::Cancelled => 3,
            });
            push_string(&mut body, status);
            2
        }
        Notification::Status { batch, status } => {
            body.extend_from_slice(batch);
            push_string(&mut body, status);
            3
        }
        Notification::SourceReleased { source } => {
            body.extend_from_slice(&source.to_le_bytes());
            4
        }
        Notification::OutputPublished { output, stream, name, size, mime_type, derived_from } => {
            body.extend_from_slice(output);
            body.push(if *stream { 2 } else { 1 });
            body.extend_from_slice(&size.to_le_bytes());
            push_string(&mut body, name);
            push_optional(&mut body, mime_type);
            push_u16(&mut body, derived_from.len() as u16);
            for id in derived_from {
                body.extend_from_slice(id);
            }
            5
        }
        Notification::OutputWithdrawn { output } => {
            body.extend_from_slice(output);
            6
        }
        Notification::Consumer { present } => {
            body.push(u8::from(*present));
            7
        }
        Notification::StreamDemand { source, free } => {
            body.extend_from_slice(&source.to_le_bytes());
            body.extend_from_slice(&free.to_le_bytes());
            8
        }
        Notification::StreamReadable { output } => {
            body.extend_from_slice(output);
            9
        }
        Notification::ActivationCheck => 10,
        Notification::ConsumerState { state, mode, failure } => {
            use super::activation::{ConsumerState, Failure, Mode};
            body.push(match state {
                ConsumerState::Unavailable => 1,
                ConsumerState::Idle => 2,
                ConsumerState::Starting => 3,
                ConsumerState::Ready => 4,
            });
            body.push(match mode {
                Mode::Off => 0,
                Mode::OnDemand => 1,
            });
            let (kind, value): (u8, i32) = match failure {
                None => (0, 0),
                Some(Failure::Exit(status)) => (1, *status),
                Some(Failure::Signal(signal)) => (2, *signal as i32),
                Some(Failure::Errno(errno)) => (3, *errno as i32),
            };
            body.push(kind);
            body.extend_from_slice(&value.to_le_bytes());
            11
        }
        Notification::ActivationTimer { delay_ms } => {
            body.extend_from_slice(&delay_ms.to_le_bytes());
            12
        }
    };
    let mut record = Vec::with_capacity(3 + body.len());
    push_u16(&mut record, (3 + body.len()) as u16);
    record.push(kind);
    record.extend_from_slice(&body);
    record
}

/// Encode as many whole records as fit in `out`; returns the bytes written
/// and how many notifications were encoded.
pub fn encode_into(notifications: &[Notification], out: &mut [u8]) -> (usize, usize) {
    let mut written = 0;
    let mut encoded = 0;
    for notification in notifications {
        let record = encode_notification(notification);
        if written + record.len() > out.len() {
            break;
        }
        out[written..written + record.len()].copy_from_slice(&record);
        written += record.len();
        encoded += 1;
    }
    (written, encoded)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn entry_record(batch: &ExchangeId, path: &[&[u8]], source: u64, size: u64, mime: Option<&[u8]>) -> Vec<u8> {
        let mut out = batch.to_vec();
        out.push(1);
        out.extend_from_slice(&[0, 0, 0]);
        out.extend_from_slice(&source.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&1_700_000_000u64.to_le_bytes());
        out.extend_from_slice(&5u32.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&(path.len() as u16).to_le_bytes());
        for component in path {
            out.extend_from_slice(&(component.len() as u16).to_le_bytes());
            out.extend_from_slice(component);
        }
        match mime {
            Some(mime) => {
                out.extend_from_slice(&(mime.len() as u16).to_le_bytes());
                out.extend_from_slice(mime);
            }
            None => out.extend_from_slice(&ABSENT.to_le_bytes()),
        }
        out.extend_from_slice(&ABSENT.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // an empty original name
        out
    }

    #[test]
    fn entry_records_decode_exactly() {
        let batch = [7u8; 16];
        let record = entry_record(&batch, &[b"dir", b"a.txt"], 42, 9, Some(b"text/plain"));
        let (decoded_batch, entry) = decode_entry(&record).unwrap();
        assert_eq!(decoded_batch, batch);
        assert_eq!(entry.path, [b"dir".to_vec(), b"a.txt".to_vec()]);
        assert_eq!(entry.kind, Some(EntryKind::File { source: 42, size: 9 }));
        assert_eq!(entry.mime_type.as_deref(), Some(&b"text/plain"[..]));
        assert_eq!(entry.origin_url, None);
        assert_eq!(entry.original_name.as_deref(), Some(&b""[..]), "empty is not absent");
        assert_eq!((entry.index, entry.mtime), (Some(0), (1_700_000_000, 5)));
        let mut trailing = record.clone();
        trailing.push(0);
        assert_eq!(decode_entry(&trailing).unwrap_err(), Errno::EINVAL);
        assert_eq!(decode_entry(&record[..record.len() - 1]).unwrap_err(), Errno::EINVAL);
        let mut bad_kind = record.clone();
        bad_kind[16] = 9;
        assert_eq!(decode_entry(&bad_kind).unwrap_err(), Errno::EINVAL);
        // A stream has no size.
        let mut sized_stream = record.clone();
        sized_stream[16] = 3;
        assert_eq!(decode_entry(&sized_stream).unwrap_err(), Errno::EINVAL);
        let stream = entry_record(&batch, &[b"feed"], 7, 0, None);
        let mut stream = stream;
        stream[16] = 3;
        assert_eq!(decode_entry(&stream).unwrap().1.kind, Some(EntryKind::Stream { source: 7 }));
    }

    #[test]
    fn notifications_encode_with_their_lengths_and_only_whole_records_fit() {
        let notes = [
            Notification::Consumer { present: true },
            Notification::Settled { batch: [1; 16], outcome: Outcome::Removed, status: b"done".to_vec() },
            Notification::SourceReleased { source: 5 },
        ];
        let first = encode_notification(&notes[0]);
        assert_eq!(first, [4, 0, 7, 1]);
        let second = encode_notification(&notes[1]);
        assert_eq!(usize::from(u16::from_le_bytes([second[0], second[1]])), second.len());
        assert_eq!(second[2], 2);
        let mut out = [0u8; 64];
        let (written, encoded) = encode_into(&notes, &mut out[..first.len() + second.len() + 3]);
        assert_eq!((written, encoded), (first.len() + second.len(), 2), "the third does not fit");
    }
}
