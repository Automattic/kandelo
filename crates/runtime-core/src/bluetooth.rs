//! `/dev/kandelo/bluetooth` — a Web Bluetooth (GATT) device the browser page
//! paired, brokered to one guest process.
//!
//! The record layout and constants live in [`wasm_posix_shared::bluetooth`].
//!
//! ## Semantics
//!
//! - **Guest-driven.** The guest writes `KIND_REQUEST` records (a UTF-8
//!   command line with its own non-zero request id). The host takes them
//!   with [`take_request`], runs the GATT operation on the page, and pushes
//!   the answer back as a `KIND_RESPONSE` echoing the id.
//! - **Queued answers.** Unlike the clipboard's single latest-wins slot,
//!   host-to-guest records queue in order, up to `MAX_QUEUED_RECORDS`. When
//!   the queue is full the oldest `KIND_NOTIFY` is dropped to make room; if
//!   there is none to drop, the push fails with `ENOSPC`. Responses and
//!   status records are never dropped silently.
//! - **One record per read**, exactly as `crate::clipboard`: a `read()`
//!   never crosses records and a short buffer streams through one. With
//!   nothing to read, `read()` fails with `EAGAIN` (the host parks blocking
//!   readers and a push wakes them); `poll()` reports `POLLIN` only when a
//!   record is readable.
//! - **One request per write.** A write must be exactly one whole
//!   `KIND_REQUEST` record; anything else is `EINVAL`, oversized payloads
//!   `EMSGSIZE`, and a full request queue `EAGAIN`.
//! - **Single owner**, as `crate::clipboard`: another process gets `EBUSY`;
//!   when the owner closes its last descriptor or exits, queued records and
//!   requests are dropped.
//!
//! The state is machine-global (the kernel is one instance), so `fork()`
//! needs no per-descriptor state.

extern crate alloc;

use alloc::collections::VecDeque;
use alloc::vec::Vec;
use core::cell::UnsafeCell;
use core::sync::atomic::{AtomicI32, Ordering};

use wasm_posix_shared::bluetooth::{
    KIND_NOTIFY, KIND_REQUEST, KIND_RESPONSE, KIND_STATUS, MAX_PAYLOAD_BYTES,
    MAX_PENDING_REQUESTS, MAX_QUEUED_RECORDS, RECORD_HEADER_SIZE, RECORD_VERSION,
};
use wasm_posix_shared::Errno;

/// Owning pid of `/dev/kandelo/bluetooth`, or `-1` if nobody holds it.
pub static BLUETOOTH_OWNER: AtomicI32 = AtomicI32::new(-1);

struct Record {
    kind: u32,
    seq: u32,
    payload: Vec<u8>,
}

impl Record {
    fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(RECORD_HEADER_SIZE as usize + self.payload.len());
        for word in [RECORD_VERSION, self.kind, self.seq, self.payload.len() as u32] {
            out.extend_from_slice(&word.to_le_bytes());
        }
        out.extend_from_slice(&self.payload);
        out
    }
}

struct State {
    /// Host -> guest records waiting to be read.
    inbox: VecDeque<Record>,
    /// The record being read: encoded bytes and how much was read.
    reading: Option<(Vec<u8>, usize)>,
    /// Guest -> host requests the host has not taken yet.
    requests: VecDeque<Record>,
}

struct GlobalBluetooth(UnsafeCell<State>);
// SAFETY: the kernel is single-threaded; this mirrors `clipboard::GLOBAL`.
unsafe impl Sync for GlobalBluetooth {}

static GLOBAL: GlobalBluetooth = GlobalBluetooth(UnsafeCell::new(State {
    inbox: VecDeque::new(),
    reading: None,
    requests: VecDeque::new(),
}));

fn state() -> &'static mut State {
    // SAFETY: see `GlobalBluetooth`.
    unsafe { &mut *GLOBAL.0.get() }
}

/// Claim the device for `pid`. Re-opens by the owner are allowed.
pub fn acquire_or_busy(pid: u32) -> Result<(), Errno> {
    let pid = pid as i32;
    let owner = BLUETOOTH_OWNER.load(Ordering::SeqCst);
    if owner != -1 && owner != pid {
        return Err(Errno::EBUSY);
    }
    let _ = BLUETOOTH_OWNER.compare_exchange(-1, pid, Ordering::SeqCst, Ordering::SeqCst);
    Ok(())
}

/// Release the device if `pid` owns it, dropping everything queued.
/// Idempotent: safe from `close` and from process exit.
pub fn release(pid: u32) {
    if BLUETOOTH_OWNER
        .compare_exchange(pid as i32, -1, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        let st = state();
        st.inbox.clear();
        st.reading = None;
        st.requests.clear();
    }
}

/// True while a guest holds the device open.
pub fn has_agent() -> bool {
    BLUETOOTH_OWNER.load(Ordering::SeqCst) != -1
}

/// Queue a host -> guest record. Fails with `ENXIO` when no guest holds the
/// device, `EINVAL` for a kind the host may not send or a non-UTF-8
/// payload, `EMSGSIZE` over the cap, and `ENOSPC` when the queue is full of
/// records that may not be dropped.
pub fn push(kind: u32, seq: u32, payload: &[u8]) -> Result<(), Errno> {
    if !has_agent() {
        return Err(Errno::ENXIO);
    }
    if !matches!(kind, KIND_RESPONSE | KIND_NOTIFY | KIND_STATUS) {
        return Err(Errno::EINVAL);
    }
    if payload.len() > MAX_PAYLOAD_BYTES as usize {
        return Err(Errno::EMSGSIZE);
    }
    if core::str::from_utf8(payload).is_err() {
        return Err(Errno::EINVAL);
    }
    let st = state();
    if st.inbox.len() >= MAX_QUEUED_RECORDS as usize {
        match st.inbox.iter().position(|r| r.kind == KIND_NOTIFY) {
            Some(i) => {
                st.inbox.remove(i);
            }
            None => return Err(Errno::ENOSPC),
        }
    }
    st.inbox.push_back(Record { kind, seq, payload: payload.to_vec() });
    Ok(())
}

/// Number of guest requests the host has not taken yet.
pub fn request_pending() -> usize {
    state().requests.len()
}

/// Move the oldest guest request, encoded (header + payload), into `out`.
/// Returns the bytes written, `EAGAIN` with no request, or `EMSGSIZE` when
/// `out` is too small (the request stays queued).
pub fn take_request(out: &mut [u8]) -> Result<usize, Errno> {
    let st = state();
    let front = st.requests.front().ok_or(Errno::EAGAIN)?;
    let bytes = front.encode();
    if bytes.len() > out.len() {
        return Err(Errno::EMSGSIZE);
    }
    out[..bytes.len()].copy_from_slice(&bytes);
    st.requests.pop_front();
    Ok(bytes.len())
}

/// True when a `read()` would return data: drives `POLLIN`.
pub fn has_data() -> bool {
    let st = state();
    st.reading.is_some() || !st.inbox.is_empty()
}

/// Copy the next bytes of the current record into `buf`, starting the next
/// queued record if none is in progress. `EAGAIN` when there is nothing to
/// read; never returns bytes from two records in one call.
pub fn read_into(buf: &mut [u8]) -> Result<usize, Errno> {
    let st = state();
    if st.reading.is_none() {
        let record = st.inbox.pop_front().ok_or(Errno::EAGAIN)?;
        st.reading = Some((record.encode(), 0));
    }
    if buf.is_empty() {
        return Ok(0);
    }
    let (bytes, cursor) = st.reading.as_mut().expect("record in progress");
    let n = core::cmp::min(buf.len(), bytes.len() - *cursor);
    buf[..n].copy_from_slice(&bytes[*cursor..*cursor + n]);
    *cursor += n;
    if *cursor == bytes.len() {
        st.reading = None;
    }
    Ok(n)
}

/// A `write()` from the guest: exactly one whole `KIND_REQUEST` record.
pub fn write_from_agent(buf: &[u8]) -> Result<usize, Errno> {
    if buf.len() < RECORD_HEADER_SIZE as usize {
        return Err(Errno::EINVAL);
    }
    let word = |i: usize| u32::from_le_bytes(buf[i * 4..i * 4 + 4].try_into().unwrap());
    let (version, kind, seq, len) = (word(0), word(1), word(2), word(3) as usize);
    if version != RECORD_VERSION
        || kind != KIND_REQUEST
        || seq == 0
        || len != buf.len() - RECORD_HEADER_SIZE as usize
    {
        return Err(Errno::EINVAL);
    }
    if len > MAX_PAYLOAD_BYTES as usize {
        return Err(Errno::EMSGSIZE);
    }
    let payload = &buf[RECORD_HEADER_SIZE as usize..];
    if core::str::from_utf8(payload).is_err() {
        return Err(Errno::EINVAL);
    }
    let st = state();
    if st.requests.len() >= MAX_PENDING_REQUESTS as usize {
        return Err(Errno::EAGAIN);
    }
    st.requests.push_back(Record { kind, seq, payload: payload.to_vec() });
    Ok(buf.len())
}

/// Forget everything. Tests only.
#[cfg(test)]
pub fn reset_for_test() {
    BLUETOOTH_OWNER.store(-1, Ordering::SeqCst);
    let st = state();
    st.inbox.clear();
    st.reading = None;
    st.requests.clear();
}

/// The device state is machine-global, so every test that touches it takes
/// this lock.
#[cfg(test)]
pub static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    fn request(seq: u32, text: &str) -> Vec<u8> {
        Record { kind: KIND_REQUEST, seq, payload: text.as_bytes().to_vec() }.encode()
    }

    fn header(bytes: &[u8]) -> (u32, u32, u32, u32) {
        let w = |i: usize| u32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap());
        (w(0), w(1), w(2), w(3))
    }

    #[test]
    fn request_round_trip_through_host() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_test();
        acquire_or_busy(7).unwrap();
        assert_eq!(write_from_agent(&request(5, "services")), Ok(16 + 8));
        assert_eq!(request_pending(), 1);
        let mut out = [0u8; 64];
        let n = take_request(&mut out).unwrap();
        assert_eq!(header(&out[..n]), (RECORD_VERSION, KIND_REQUEST, 5, 8));
        assert_eq!(&out[16..n], b"services");
        assert_eq!(take_request(&mut out), Err(Errno::EAGAIN));

        push(KIND_RESPONSE, 5, b"ok 180f").unwrap();
        assert!(has_data());
        let mut buf = [0u8; 64];
        let n = read_into(&mut buf).unwrap();
        assert_eq!(header(&buf[..n]), (RECORD_VERSION, KIND_RESPONSE, 5, 7));
        assert_eq!(&buf[16..n], b"ok 180f");
        assert_eq!(read_into(&mut buf), Err(Errno::EAGAIN));
    }

    #[test]
    fn rejects_bad_writes_and_pushes() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_test();
        assert_eq!(push(KIND_STATUS, 0, b"connected"), Err(Errno::ENXIO));
        acquire_or_busy(1).unwrap();
        assert_eq!(acquire_or_busy(2), Err(Errno::EBUSY));
        assert_eq!(write_from_agent(&request(0, "x")), Err(Errno::EINVAL));
        assert_eq!(write_from_agent(&[0u8; 4]), Err(Errno::EINVAL));
        assert_eq!(push(KIND_REQUEST, 1, b"x"), Err(Errno::EINVAL));
        assert_eq!(push(KIND_NOTIFY, 0, &[0xff]), Err(Errno::EINVAL));
        let big = alloc::vec![b'a'; MAX_PAYLOAD_BYTES as usize + 1];
        assert_eq!(push(KIND_NOTIFY, 0, &big), Err(Errno::EMSGSIZE));
        for i in 1..=MAX_PENDING_REQUESTS {
            write_from_agent(&request(i, "x")).unwrap();
        }
        assert_eq!(write_from_agent(&request(99, "x")), Err(Errno::EAGAIN));
    }

    #[test]
    fn full_queue_drops_oldest_notification_first() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_test();
        acquire_or_busy(1).unwrap();
        push(KIND_NOTIFY, 0, b"notify first").unwrap();
        for _ in 1..MAX_QUEUED_RECORDS {
            push(KIND_RESPONSE, 1, b"ok").unwrap();
        }
        push(KIND_STATUS, 0, b"disconnected").unwrap();
        let mut buf = [0u8; 64];
        let n = read_into(&mut buf).unwrap();
        assert_eq!(header(&buf[..n]).1, KIND_RESPONSE, "the notification was dropped");
        // Now full of responses + status: nothing droppable.
        push(KIND_RESPONSE, 2, b"ok").unwrap();
        assert_eq!(push(KIND_RESPONSE, 3, b"ok"), Err(Errno::ENOSPC));
    }

    #[test]
    fn short_reads_stream_one_record_and_release_drops_all() {
        let _g = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_test();
        acquire_or_busy(3).unwrap();
        push(KIND_STATUS, 0, b"connected Pulse").unwrap();
        push(KIND_STATUS, 0, b"disconnected").unwrap();
        // Record one is 16 header + 15 payload = 31 bytes: 10 + 10 + 10 + 1.
        let mut small = [0u8; 10];
        assert_eq!(read_into(&mut small), Ok(10));
        assert_eq!(read_into(&mut small), Ok(10));
        assert_eq!(read_into(&mut small), Ok(10));
        assert_eq!(read_into(&mut small), Ok(1), "rest of record one only");
        // The next read starts record two at its header.
        assert_eq!(read_into(&mut small), Ok(10));
        assert_eq!(u32::from_le_bytes(small[4..8].try_into().unwrap()), KIND_STATUS);
        write_from_agent(&request(4, "info")).unwrap();
        release(3);
        assert!(!has_agent());
        assert!(!has_data());
        assert_eq!(request_pending(), 0);
    }
}
