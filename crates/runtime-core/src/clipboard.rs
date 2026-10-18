//! `/dev/kandelo/clipboard` — host clipboard text offered to a guest agent.
//!
//! The device carries one thing: the clipboard text the host most recently
//! offered. A guest agent (kclipd on the Omarchy desktop) reads each offer
//! and turns it into the desktop's Wayland selection, then writes an
//! acknowledgement the host reads back. The record layout and constants
//! live in [`wasm_posix_shared::clipboard`].
//!
//! ## Semantics
//!
//! - **Latest wins.** The kernel holds at most one unread offer. A new offer
//!   replaces an unread one, because a clipboard is one value, not a queue;
//!   the replaced offer's acknowledgement reads back as `-ECANCELED`. Once the
//!   agent starts reading a record, that record is finished first: a reader
//!   never sees two offers interleaved.
//! - **One record per read.** A `read()` never crosses from one record into
//!   the next, and a buffer shorter than the record streams through it. The
//!   device, not the open file description, holds the record being read —
//!   like a FIFO, two descriptors of the owner share one stream. That keeps
//!   the state machine-wide (the kernel is one instance), so `fork()` needs
//!   no per-descriptor clipboard state.
//! - **Blocking.** With no record to read, `read()` fails with `EAGAIN`: the
//!   host returns that to an `O_NONBLOCK` caller and parks a blocking one,
//!   and the host's offer wakes parked readers. `poll()` reports `POLLIN`
//!   only when a record is readable.
//! - **Single owner.** One process at a time may hold the device open, so
//!   only the agent ever sees pasted text; another process gets `EBUSY`.
//!   When the owner closes its last descriptor or exits, the unread offer
//!   and any partly read record are dropped, so the text does not outlive
//!   its reader.
//!
//! The kernel copies the text once from the host and frees it when the
//! agent has read it; it never logs it.

extern crate alloc;

use alloc::vec::Vec;
use core::cell::UnsafeCell;
use core::sync::atomic::{AtomicI32, Ordering};

use wasm_posix_shared::clipboard::{
    ACK_NO_AGENT, ACK_PENDING, ACK_SIZE, ACK_SUPERSEDED, ACK_UNKNOWN_SEQ, KIND_GUEST_TEXT,
    KIND_OFFER_TEXT, MAX_TEXT_BYTES, RECORD_HEADER_SIZE, RECORD_VERSION,
};
use wasm_posix_shared::Errno;

/// Owning pid of `/dev/kandelo/clipboard`, or `-1` if nobody holds it.
pub static CLIPBOARD_OWNER: AtomicI32 = AtomicI32::new(-1);

/// What became of the newest offer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OfferOutcome {
    /// Offered; the agent has not acknowledged it.
    Pending,
    /// The agent answered: 0, or a negative errno.
    Acked(i32),
    /// Dropped before the agent answered (the owner went away).
    Dropped(i32),
}

struct State {
    /// Text the host is copying in, chunk by chunk, before it offers it.
    staging: Vec<u8>,
    /// The newest offer, waiting to be read: (seq, text).
    pending: Option<(u32, Vec<u8>)>,
    /// The record being read: header + payload, and how much was read.
    reading: Option<(Vec<u8>, usize)>,
    /// Sequence number of the newest offer, 0 before the first.
    latest_seq: u32,
    latest: OfferOutcome,
    /// The desktop's latest selection as the agent reported it, for the
    /// host to copy out, and a counter that changes with every report.
    guest_text: Option<Vec<u8>>,
    guest_generation: u32,
}

struct GlobalClipboard(UnsafeCell<State>);
// SAFETY: the kernel is single-threaded; this mirrors the other device
// globals (`mouse::GLOBAL`).
unsafe impl Sync for GlobalClipboard {}

static GLOBAL: GlobalClipboard = GlobalClipboard(UnsafeCell::new(State {
    staging: Vec::new(),
    pending: None,
    reading: None,
    latest_seq: 0,
    latest: OfferOutcome::Pending,
    guest_text: None,
    guest_generation: 0,
}));

fn state() -> &'static mut State {
    // SAFETY: see `GlobalClipboard`.
    unsafe { &mut *GLOBAL.0.get() }
}

/// Claim the device for `pid`. Re-opens by the owner are allowed.
pub fn acquire_or_busy(pid: u32) -> Result<(), Errno> {
    let pid = pid as i32;
    let owner = CLIPBOARD_OWNER.load(Ordering::SeqCst);
    if owner != -1 && owner != pid {
        return Err(Errno::EBUSY);
    }
    let _ = CLIPBOARD_OWNER.compare_exchange(-1, pid, Ordering::SeqCst, Ordering::SeqCst);
    Ok(())
}

/// Release the device if `pid` owns it, dropping any text it had not read.
/// Idempotent: safe from `close` and from process exit.
pub fn release(pid: u32) {
    if CLIPBOARD_OWNER
        .compare_exchange(pid as i32, -1, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        let st = state();
        st.pending = None;
        st.reading = None;
        st.guest_text = None;
        if st.latest == OfferOutcome::Pending && st.latest_seq != 0 {
            st.latest = OfferOutcome::Dropped(ACK_NO_AGENT);
        }
    }
}

/// Copy one chunk of host text into the staging buffer at `offset`. The
/// host stages text in kernel-scratch-sized chunks because an offer can be
/// far larger than one scratch lease; offset 0 starts over, so a transfer
/// the host abandoned halfway can never leak into the next one. Chunks
/// must arrive in order.
pub fn stage(chunk: &[u8], offset: usize) -> Result<(), Errno> {
    let st = state();
    if offset == 0 {
        st.staging.clear();
    }
    if offset != st.staging.len() {
        st.staging.clear();
        return Err(Errno::EINVAL);
    }
    if offset + chunk.len() > MAX_TEXT_BYTES as usize {
        st.staging.clear();
        return Err(Errno::EMSGSIZE);
    }
    st.staging.extend_from_slice(chunk);
    Ok(())
}

/// Offer the staged text (see [`stage`]) and empty the staging buffer.
pub fn offer_staged() -> Result<u32, Errno> {
    let text = core::mem::take(&mut state().staging);
    offer(&text)
}

/// Offer `text` as the new clipboard contents. Returns the offer's
/// sequence number. Fails with `ENXIO` when no agent holds the device,
/// `EMSGSIZE` over [`MAX_TEXT_BYTES`], and `EINVAL` for text that is not
/// UTF-8.
pub fn offer(text: &[u8]) -> Result<u32, Errno> {
    if CLIPBOARD_OWNER.load(Ordering::SeqCst) == -1 {
        return Err(Errno::ENXIO);
    }
    if text.len() > MAX_TEXT_BYTES as usize {
        return Err(Errno::EMSGSIZE);
    }
    if core::str::from_utf8(text).is_err() {
        return Err(Errno::EINVAL);
    }
    let st = state();
    // Sequence numbers stay positive as i32: kernel_clipboard_offer returns
    // them through the same i32 that carries negative errnos.
    let seq = if st.latest_seq >= i32::MAX as u32 { 1 } else { st.latest_seq + 1 };
    st.latest_seq = seq;
    st.latest = OfferOutcome::Pending;
    st.pending = Some((seq, text.to_vec()));
    Ok(seq)
}

/// The agent's answer to offer `seq`: [`ACK_PENDING`] while it has not
/// answered, 0 once it installed the selection, or a negative errno — its
/// own, [`ACK_SUPERSEDED`] for an offer a newer one replaced,
/// [`ACK_NO_AGENT`] if the agent went away first, [`ACK_UNKNOWN_SEQ`] for a
/// sequence number never issued.
pub fn ack_status(seq: u32) -> i32 {
    let st = state();
    if seq == 0 || seq > st.latest_seq {
        return ACK_UNKNOWN_SEQ;
    }
    if seq != st.latest_seq {
        return ACK_SUPERSEDED;
    }
    match st.latest {
        OfferOutcome::Pending => ACK_PENDING,
        OfferOutcome::Acked(status) | OfferOutcome::Dropped(status) => status,
    }
}

/// True when a `read()` would return data: drives `POLLIN`.
pub fn has_data() -> bool {
    let st = state();
    st.reading.is_some() || st.pending.is_some()
}

/// Copy the next bytes of the current record into `buf`, starting the next
/// record if none is in progress. Fails with `EAGAIN` when there is nothing
/// to read, and never returns bytes from two records in one call.
pub fn read_into(buf: &mut [u8]) -> Result<usize, Errno> {
    let st = state();
    if st.reading.is_none() {
        let (seq, text) = st.pending.take().ok_or(Errno::EAGAIN)?;
        let mut record = Vec::with_capacity(RECORD_HEADER_SIZE as usize + text.len());
        for word in [RECORD_VERSION, KIND_OFFER_TEXT, seq, text.len() as u32] {
            record.extend_from_slice(&word.to_le_bytes());
        }
        record.extend_from_slice(&text);
        st.reading = Some((record, 0));
    }
    if buf.is_empty() {
        return Ok(0);
    }
    let (record, cursor) = st.reading.as_mut().expect("record in progress");
    let n = core::cmp::min(buf.len(), record.len() - *cursor);
    buf[..n].copy_from_slice(&record[*cursor..*cursor + n]);
    *cursor += n;
    if *cursor == record.len() {
        st.reading = None;
    }
    Ok(n)
}

/// A `write()` from the agent: an acknowledgement (`ACK_SIZE` bytes) or a
/// whole `KIND_GUEST_TEXT` record (header + text) reporting the desktop's
/// new selection. One write carries exactly one of them; anything else is
/// `EINVAL`, and text over the cap is `EMSGSIZE` (never truncated).
pub fn write_from_agent(buf: &[u8]) -> Result<usize, Errno> {
    if buf.len() == ACK_SIZE as usize {
        return write_ack(buf);
    }
    if buf.len() < RECORD_HEADER_SIZE as usize {
        return Err(Errno::EINVAL);
    }
    let word = |i: usize| u32::from_le_bytes(buf[i * 4..i * 4 + 4].try_into().unwrap());
    let (version, kind, len) = (word(0), word(1), word(3) as usize);
    if version != RECORD_VERSION
        || kind != KIND_GUEST_TEXT
        || len != buf.len() - RECORD_HEADER_SIZE as usize
    {
        return Err(Errno::EINVAL);
    }
    if len > MAX_TEXT_BYTES as usize {
        return Err(Errno::EMSGSIZE);
    }
    let text = &buf[RECORD_HEADER_SIZE as usize..];
    if core::str::from_utf8(text).is_err() {
        return Err(Errno::EINVAL);
    }
    let st = state();
    st.guest_text = Some(text.to_vec());
    st.guest_generation = match st.guest_generation.wrapping_add(1) {
        0 => 1,
        n => n,
    };
    Ok(buf.len())
}

/// Changes every time the agent reports a new desktop selection; 0 until
/// the first report. The host compares it before and after a copy gesture.
pub fn guest_generation() -> u32 {
    state().guest_generation
}

/// Copy the latest reported desktop selection, from byte `offset`, into
/// `out`. Returns the bytes copied, or `None` when there is none.
pub fn guest_read(out: &mut [u8], offset: usize) -> Option<usize> {
    let text = state().guest_text.as_ref()?;
    let start = offset.min(text.len());
    let n = out.len().min(text.len() - start);
    out[..n].copy_from_slice(&text[start..start + n]);
    Some(n)
}

/// Bytes in the latest reported desktop selection, or `None`.
pub fn guest_len() -> Option<usize> {
    state().guest_text.as_ref().map(Vec::len)
}

/// Take an acknowledgement `{u32 seq, i32 status}` from the agent. The
/// status must be 0 or a negative errno. An answer for an offer that is no
/// longer the newest is accepted and ignored: that offer reads back as
/// [`ACK_SUPERSEDED`] regardless.
pub fn write_ack(buf: &[u8]) -> Result<usize, Errno> {
    if buf.len() != ACK_SIZE as usize {
        return Err(Errno::EINVAL);
    }
    let seq = u32::from_le_bytes(buf[0..4].try_into().unwrap());
    let status = i32::from_le_bytes(buf[4..8].try_into().unwrap());
    if status > 0 {
        return Err(Errno::EINVAL);
    }
    let st = state();
    if seq != 0 && seq == st.latest_seq && st.latest == OfferOutcome::Pending {
        st.latest = OfferOutcome::Acked(status);
    }
    Ok(buf.len())
}

/// Forget everything, including the sequence counter. Tests only.
#[cfg(test)]
pub fn reset_for_test() {
    CLIPBOARD_OWNER.store(-1, Ordering::SeqCst);
    let st = state();
    st.staging.clear();
    st.pending = None;
    st.reading = None;
    st.latest_seq = 0;
    st.latest = OfferOutcome::Pending;
    st.guest_text = None;
    st.guest_generation = 0;
}

/// The device state is machine-global, so every test that touches it —
/// here and in `syscalls` — takes this lock.
#[cfg(test)]
pub(crate) static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;
    use super::TEST_LOCK as LOCK;

    fn header(buf: &[u8]) -> [u32; 4] {
        let w = |i: usize| u32::from_le_bytes(buf[i * 4..i * 4 + 4].try_into().unwrap());
        [w(0), w(1), w(2), w(3)]
    }

    #[test]
    fn offer_without_an_owner_is_enxio() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_test();
        assert_eq!(offer(b"x"), Err(Errno::ENXIO));
    }

    #[test]
    fn offer_reads_as_one_framed_record() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_test();
        acquire_or_busy(7).unwrap();
        let seq = offer("héllo".as_bytes()).unwrap();
        assert!(has_data());
        let mut buf = [0u8; 64];
        let n = read_into(&mut buf).unwrap();
        assert_eq!(n, 16 + "héllo".len());
        assert_eq!(header(&buf), [RECORD_VERSION, KIND_OFFER_TEXT, seq, 6]);
        assert_eq!(&buf[16..n], "héllo".as_bytes());
        assert!(!has_data());
        assert_eq!(read_into(&mut buf), Err(Errno::EAGAIN));
    }

    #[test]
    fn a_short_buffer_streams_through_the_record() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_test();
        acquire_or_busy(7).unwrap();
        offer(b"abcdefgh").unwrap();
        let mut got = Vec::new();
        let mut chunk = [0u8; 5];
        while let Ok(n) = read_into(&mut chunk) {
            got.extend_from_slice(&chunk[..n]);
        }
        assert_eq!(got.len(), 24);
        assert_eq!(&got[16..], b"abcdefgh");
    }

    #[test]
    fn latest_wins_and_a_record_is_never_interleaved() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_test();
        acquire_or_busy(7).unwrap();
        let first = offer(b"first").unwrap();
        let replaced = offer(b"second").unwrap();
        assert_eq!(ack_status(first), ACK_SUPERSEDED);

        // Start reading `second`, then a third offer arrives mid-record.
        let mut part = [0u8; 10];
        assert_eq!(read_into(&mut part).unwrap(), 10);
        let third = offer(b"third").unwrap();
        // The rest of `second` comes first, and stops at its end.
        let mut rest = [0u8; 64];
        let n = read_into(&mut rest).unwrap();
        assert_eq!(&rest[n - 6..n], b"second");
        assert_eq!(n, 16 + 6 - 10);
        // Then `third`, whole.
        let n = read_into(&mut rest).unwrap();
        assert_eq!(header(&rest)[2], third);
        assert_eq!(&rest[16..n], b"third");
        assert_eq!(ack_status(replaced), ACK_SUPERSEDED);
    }

    #[test]
    fn staged_chunks_become_one_offer() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_test();
        acquire_or_busy(7).unwrap();
        // A stale half-transfer is discarded by the next offset-0 chunk.
        stage(b"stale", 0).unwrap();
        stage(b"hello ", 0).unwrap();
        stage(b"world", 6).unwrap();
        assert_eq!(stage(b"gap", 99), Err(Errno::EINVAL));
        stage(b"hello ", 0).unwrap();
        stage(b"world", 6).unwrap();
        let seq = offer_staged().unwrap();
        let mut buf = [0u8; 64];
        let n = read_into(&mut buf).unwrap();
        assert_eq!(header(&buf)[2], seq);
        assert_eq!(&buf[16..n], b"hello world");
        // The staging buffer is empty again.
        assert_eq!(stage(b"x", 1), Err(Errno::EINVAL));
        let big = alloc::vec![b'a'; MAX_TEXT_BYTES as usize];
        stage(&big, 0).unwrap();
        assert_eq!(stage(b"a", MAX_TEXT_BYTES as usize), Err(Errno::EMSGSIZE));
    }

    fn guest_record(text: &[u8]) -> Vec<u8> {
        let mut r = Vec::new();
        for w in [RECORD_VERSION, KIND_GUEST_TEXT, 0, text.len() as u32] {
            r.extend_from_slice(&w.to_le_bytes());
        }
        r.extend_from_slice(text);
        r
    }

    #[test]
    fn agent_reports_the_desktop_selection_for_copy_out() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_test();
        acquire_or_busy(7).unwrap();
        assert_eq!(guest_generation(), 0);
        assert_eq!(guest_len(), None);
        let rec = guest_record("copied in foot ✓".as_bytes());
        assert_eq!(write_from_agent(&rec), Ok(rec.len()));
        assert_eq!(guest_generation(), 1);
        let mut out = [0u8; 64];
        let n = guest_read(&mut out, 0).unwrap();
        assert_eq!(&out[..n], "copied in foot ✓".as_bytes());
        // Chunked reads from an offset.
        let n = guest_read(&mut out[..4], 7).unwrap();
        assert_eq!(&out[..n], b"in f");
        // A second report replaces the first and moves the generation.
        write_from_agent(&guest_record(b"second")).unwrap();
        assert_eq!(guest_generation(), 2);
        assert_eq!(guest_len(), Some(6));
        // Acknowledgements still go through the same write.
        let seq = offer(b"x").unwrap();
        let mut ack = [0u8; 8];
        ack[..4].copy_from_slice(&seq.to_le_bytes());
        assert_eq!(write_from_agent(&ack), Ok(8));
        assert_eq!(ack_status(seq), 0);
        // The agent going away drops the text it reported.
        release(7);
        assert_eq!(guest_len(), None);
    }

    #[test]
    fn malformed_agent_writes_are_refused() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_test();
        acquire_or_busy(7).unwrap();
        let mut rec = guest_record(b"abc");
        assert_eq!(write_from_agent(&rec[..10]), Err(Errno::EINVAL));
        rec[12] = 9; // len no longer matches the payload
        assert_eq!(write_from_agent(&rec), Err(Errno::EINVAL));
        let mut wrong_kind = guest_record(b"abc");
        wrong_kind[4] = KIND_OFFER_TEXT as u8;
        assert_eq!(write_from_agent(&wrong_kind), Err(Errno::EINVAL));
        assert_eq!(write_from_agent(&guest_record(&[0xff, 0xfe])), Err(Errno::EINVAL));
        let big = alloc::vec![b'a'; MAX_TEXT_BYTES as usize + 1];
        assert_eq!(write_from_agent(&guest_record(&big)), Err(Errno::EMSGSIZE));
        assert_eq!(guest_generation(), 0);
    }

    #[test]
    fn ack_round_trip() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_test();
        acquire_or_busy(7).unwrap();
        let seq = offer(b"x").unwrap();
        assert_eq!(ack_status(seq), ACK_PENDING);
        let mut ack = [0u8; 8];
        ack[..4].copy_from_slice(&seq.to_le_bytes());
        ack[4..].copy_from_slice(&0i32.to_le_bytes());
        assert_eq!(write_ack(&ack), Ok(8));
        assert_eq!(ack_status(seq), 0);
        // A failure status is reported as given.
        let seq2 = offer(b"y").unwrap();
        ack[..4].copy_from_slice(&seq2.to_le_bytes());
        ack[4..].copy_from_slice(&(-(Errno::EIO as i32)).to_le_bytes());
        write_ack(&ack).unwrap();
        assert_eq!(ack_status(seq2), -(Errno::EIO as i32));
        // Malformed acknowledgements are refused.
        assert_eq!(write_ack(&ack[..7]), Err(Errno::EINVAL));
        ack[4..].copy_from_slice(&5i32.to_le_bytes());
        assert_eq!(write_ack(&ack), Err(Errno::EINVAL));
        assert_eq!(ack_status(0), ACK_UNKNOWN_SEQ);
        assert_eq!(ack_status(seq2 + 1), ACK_UNKNOWN_SEQ);
    }

    #[test]
    fn cap_and_utf8_are_enforced() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_test();
        acquire_or_busy(7).unwrap();
        let big = alloc::vec![b'a'; MAX_TEXT_BYTES as usize + 1];
        assert_eq!(offer(&big), Err(Errno::EMSGSIZE));
        assert!(offer(&big[..MAX_TEXT_BYTES as usize]).is_ok());
        assert_eq!(offer(&[0xff, 0xfe]), Err(Errno::EINVAL));
    }

    #[test]
    fn single_owner_and_release_drops_unread_text() {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        reset_for_test();
        acquire_or_busy(7).unwrap();
        acquire_or_busy(7).unwrap();
        assert_eq!(acquire_or_busy(8), Err(Errno::EBUSY));
        let seq = offer(b"secret").unwrap();
        release(8); // not the owner: no effect
        assert!(has_data());
        release(7);
        assert!(!has_data());
        assert_eq!(ack_status(seq), ACK_NO_AGENT);
        assert_eq!(offer(b"x"), Err(Errno::ENXIO));
        acquire_or_busy(8).unwrap();
        let mut buf = [0u8; 32];
        assert_eq!(read_into(&mut buf), Err(Errno::EAGAIN));
    }
}
