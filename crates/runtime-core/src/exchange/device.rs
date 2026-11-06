//! The exchange device nodes: `events` and `work/clone`.
//!
//! Both are character-device nodes in the exchange mount's fixed layout, owned
//! `root:exchange` with mode 0440, so ordinary permission checks decide who
//! may open them. An open creates an open file description whose state lives
//! here, in a kernel-global table keyed by a negative host handle, so
//! descriptions shared by `dup` and `fork` share it (see
//! `descriptor_backing::add_ref_for_ofd`). The state ends when the last
//! reference to the description is released.
//!
//! - **`events`** has at most one open description: the consumer. A second
//!   open fails with EBUSY. Reading returns LF-terminated ASCII lines. The
//!   first line after open reports whether a host output listener exists
//!   (`outputs accepting` / `outputs none`). A read with no line pending fails
//!   with EAGAIN: the host returns that to an `O_NONBLOCK` caller and parks a
//!   blocking one until a new line arrives, as Linux character devices block.
//!   A buffer shorter than the next line streams through it, and a read never
//!   crosses into the following line.
//! - **`work/clone`** creates a work session per open: the directory
//!   `work/<n>/`, owned by the opener, mode 0700. Reading the description
//!   returns `<n>\n` once, then end-of-file. When the description's last
//!   reference is released (close, exit, even SIGKILL), the session directory
//!   and everything unpublished in it are removed.

use alloc::collections::{BTreeMap, VecDeque};
use alloc::vec::Vec;
use core::cell::UnsafeCell;
use core::hint::spin_loop;
use core::sync::atomic::{AtomicBool, Ordering};

use wasm_posix_shared::Errno;

use super::ids::ExchangeId;

/// Exchange descriptions use the band of negative character-device handles
/// below `-EXCHANGE_HANDLE_BASE`, far from the `VirtualDevice` handles
/// (`-1..=-12`) and every other negative-handle class.
pub const EXCHANGE_HANDLE_BASE: i64 = 7_000_000_000;
const HANDLE_BAND_WIDTH: i64 = 1_000_000_000;
/// The `events` description.
pub const EVENTS_HANDLE: i64 = -EXCHANGE_HANDLE_BASE;

/// Paths of the device nodes, relative to the exchange mount.
pub const EVENTS_NODE: &[u8] = b"/run/kandelo/exchange/events";
pub const CLONE_NODE: &[u8] = b"/run/kandelo/exchange/work/clone";
/// Directory that holds work sessions.
pub const WORK_DIR: &[u8] = b"/run/kandelo/exchange/work";

/// Work sessions open at once (spec quota).
pub const MAX_SESSIONS: usize = 32;

/// The longest line `events` produces, including its LF.
pub const MAX_LINE_BYTES: usize = 64;

/// Which device a path or handle names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExchangeDevice {
    Events,
    /// One work session, by number.
    Session(u32),
}

/// The device node at `path`, if any. Opening `work/clone` creates a session
/// rather than naming one.
pub fn device_node_at(path: &[u8]) -> Option<ExchangeNode> {
    match path {
        EVENTS_NODE => Some(ExchangeNode::Events),
        CLONE_NODE => Some(ExchangeNode::Clone),
        _ => None,
    }
}

/// A device node in the exchange layout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExchangeNode {
    Events,
    Clone,
}

impl ExchangeDevice {
    pub fn host_handle(self) -> i64 {
        match self {
            ExchangeDevice::Events => EVENTS_HANDLE,
            ExchangeDevice::Session(number) => -(EXCHANGE_HANDLE_BASE + 1 + i64::from(number)),
        }
    }

    pub fn from_host_handle(handle: i64) -> Option<ExchangeDevice> {
        if handle == EVENTS_HANDLE {
            return Some(ExchangeDevice::Events);
        }
        let offset = -handle - EXCHANGE_HANDLE_BASE - 1;
        if (0..HANDLE_BAND_WIDTH - 1).contains(&offset) {
            u32::try_from(offset).ok().map(ExchangeDevice::Session)
        } else {
            None
        }
    }

    /// The node an open description of this device was opened through.
    pub fn node_path(self) -> &'static [u8] {
        match self {
            ExchangeDevice::Events => EVENTS_NODE,
            ExchangeDevice::Session(_) => CLONE_NODE,
        }
    }
}

struct Session {
    refs: u32,
    /// How much of `<n>\n` the description has read.
    read_offset: usize,
}

struct State {
    /// References to the consumer's description; 0 means no consumer.
    events_refs: u32,
    /// Effective uid and gid of the process that opened `events`.
    consumer: (u32, u32),
    /// Lines to read, each with the batch it announces, if any.
    lines: VecDeque<(Vec<u8>, Option<ExchangeId>)>,
    /// Bytes of the front line already read.
    front_offset: usize,
    outputs_accepting: bool,
    sessions: BTreeMap<u32, Session>,
    next_session: u32,
}

impl State {
    const fn new() -> Self {
        State {
            events_refs: 0,
            consumer: (0, 0),
            lines: VecDeque::new(),
            front_offset: 0,
            outputs_accepting: false,
            sessions: BTreeMap::new(),
            next_session: 1,
        }
    }
}

struct Global {
    locked: AtomicBool,
    state: UnsafeCell<State>,
}

// SAFETY: `locked` serializes every access, like the tmpfs and descriptor
// backing globals; no reference escapes `with`.
unsafe impl Sync for Global {}

static GLOBAL: Global = Global {
    locked: AtomicBool::new(false),
    state: UnsafeCell::new(State::new()),
};

fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
    while GLOBAL
        .locked
        .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
        .is_err()
    {
        spin_loop();
    }
    struct Unlock;
    impl Drop for Unlock {
        fn drop(&mut self) {
            GLOBAL.locked.store(false, Ordering::Release);
        }
    }
    let _unlock = Unlock;
    // SAFETY: see `Global`.
    f(unsafe { &mut *GLOBAL.state.get() })
}

fn outputs_line(accepting: bool) -> Vec<u8> {
    if accepting {
        b"outputs accepting\n".to_vec()
    } else {
        b"outputs none\n".to_vec()
    }
}

/// Open `events`, making the caller's new description the consumer. EBUSY if
/// a consumer description already exists. Queues the `outputs` line first.
pub fn open_events(uid: u32, gid: u32) -> Result<ExchangeDevice, Errno> {
    with(|state| {
        if state.events_refs != 0 {
            return Err(Errno::EBUSY);
        }
        state.events_refs = 1;
        state.consumer = (uid, gid);
        state.lines.clear();
        state.front_offset = 0;
        let line = outputs_line(state.outputs_accepting);
        state.lines.push_back((line, None));
        Ok(ExchangeDevice::Events)
    })
}

/// The consumer's effective uid and gid, if a consumer exists.
pub fn consumer() -> Option<(u32, u32)> {
    with(|state| (state.events_refs != 0).then_some(state.consumer))
}

/// Allocate a new session number. The caller creates `work/<n>/`, then calls
/// [`activate_session`]; on failure it calls [`abandon_session`].
pub fn reserve_session() -> Result<u32, Errno> {
    with(|state| {
        if state.sessions.len() >= MAX_SESSIONS {
            return Err(Errno::ENOSPC);
        }
        let number = state.next_session;
        if i64::from(number) >= HANDLE_BAND_WIDTH - 1 {
            return Err(Errno::ENFILE);
        }
        state.next_session += 1;
        Ok(number)
    })
}

/// Record a session whose directory now exists.
pub fn activate_session(number: u32) -> ExchangeDevice {
    with(|state| {
        state.sessions.insert(number, Session { refs: 1, read_offset: 0 });
    });
    ExchangeDevice::Session(number)
}

/// Whether a consumer holds `events`.
pub fn consumer_present() -> bool {
    with(|state| state.events_refs != 0)
}

/// Whether a line is waiting to be read.
pub fn events_readable() -> bool {
    with(|state| !state.lines.is_empty())
}

/// Report whether a host output listener exists. A change is announced to the
/// consumer as a line.
pub fn set_outputs_accepting(accepting: bool) {
    let queued = with(|state| {
        if state.outputs_accepting == accepting {
            return false;
        }
        state.outputs_accepting = accepting;
        if state.events_refs == 0 {
            return false;
        }
        let line = outputs_line(accepting);
        state.lines.push_back((line, None));
        true
    });
    if queued {
        announce_line();
    }
}

/// Whether a host output listener exists.
pub fn outputs_accepting() -> bool {
    with(|state| state.outputs_accepting)
}

/// Queue a line for the consumer. Dropped when there is no consumer: lines
/// describe what a consumer can act on, and a later consumer learns the
/// current state when it opens.
pub fn push_line(line: Vec<u8>) {
    push_batch_line(line, None);
}

/// Queue a line that announces `batch`, so the batch counts as delivered
/// once the consumer has read the whole line.
pub fn push_batch_line(line: Vec<u8>, batch: Option<ExchangeId>) {
    debug_assert!(line.len() <= MAX_LINE_BYTES && line.last() == Some(&b'\n'));
    let queued = with(|state| {
        if state.events_refs == 0 {
            return false;
        }
        state.lines.push_back((line, batch));
        true
    });
    if queued {
        announce_line();
    }
}

/// A queued line is a readiness edge for epoll waiters on `events` (poll
/// rechecks [`events_readable`] itself). Called outside the exchange state:
/// epoll may evaluate readiness while it runs.
fn announce_line() {
    use wasm_posix_shared::epoll::{EPOLLIN, EPOLLRDNORM};
    crate::epoll::notify(crate::epoll::Source::Device(EVENTS_HANDLE), EPOLLIN | EPOLLRDNORM);
}

/// Read from `events`. Never crosses from one line into the next. A batch
/// whose line has now been read completely is marked delivered.
pub fn read_events(buf: &mut [u8]) -> Result<usize, Errno> {
    let (n, delivered) = with(|state| {
        let Some((front, _)) = state.lines.front() else {
            return Err(Errno::EAGAIN);
        };
        if buf.is_empty() {
            return Ok((0, None));
        }
        let rest = &front[state.front_offset..];
        let n = rest.len().min(buf.len());
        buf[..n].copy_from_slice(&rest[..n]);
        state.front_offset += n;
        let mut delivered = None;
        if state.front_offset == front.len() {
            delivered = state.lines.pop_front().and_then(|(_, batch)| batch);
            state.front_offset = 0;
        }
        Ok((n, delivered))
    })?;
    if let Some(batch) = delivered {
        super::batches::mark_delivered(&batch);
    }
    Ok(n)
}

/// Read a session description: `<n>\n` once, then end-of-file.
pub fn read_session(number: u32, buf: &mut [u8]) -> Result<usize, Errno> {
    with(|state| {
        let session = state.sessions.get_mut(&number).ok_or(Errno::EBADF)?;
        let mut text = [0u8; 11];
        let len = format_decimal(number, &mut text);
        let rest = &text[session.read_offset.min(len)..len];
        let n = rest.len().min(buf.len());
        buf[..n].copy_from_slice(&rest[..n]);
        session.read_offset += n;
        Ok(n)
    })
}

/// `n` in decimal followed by LF; returns the length.
fn format_decimal(number: u32, out: &mut [u8; 11]) -> usize {
    let mut digits = [0u8; 10];
    let mut value = number;
    let mut count = 0;
    loop {
        digits[count] = b'0' + (value % 10) as u8;
        count += 1;
        value /= 10;
        if value == 0 {
            break;
        }
    }
    for index in 0..count {
        out[index] = digits[count - 1 - index];
    }
    out[count] = b'\n';
    count + 1
}

/// A forked or otherwise duplicated description adds a reference.
pub fn add_ref(device: ExchangeDevice) -> Result<(), Errno> {
    with(|state| match device {
        ExchangeDevice::Events if state.events_refs != 0 => {
            state.events_refs += 1;
            Ok(())
        }
        ExchangeDevice::Session(number) => match state.sessions.get_mut(&number) {
            Some(session) => {
                session.refs += 1;
                Ok(())
            }
            None => Err(Errno::EBADF),
        },
        ExchangeDevice::Events => Err(Errno::EBADF),
    })
}

/// What ended when a reference was released.
#[derive(Debug, PartialEq, Eq)]
pub enum Released {
    /// Other references remain.
    Nothing,
    /// The consumer's description is gone.
    Consumer,
    /// The session's description is gone; its directory must be removed.
    Session(u32),
}

/// Release one reference. The caller acts on what ended.
pub fn release(device: ExchangeDevice) -> Released {
    with(|state| match device {
        ExchangeDevice::Events => {
            if state.events_refs == 0 {
                return Released::Nothing;
            }
            state.events_refs -= 1;
            if state.events_refs != 0 {
                return Released::Nothing;
            }
            state.lines.clear();
            state.front_offset = 0;
            Released::Consumer
        }
        ExchangeDevice::Session(number) => {
            let Some(session) = state.sessions.get_mut(&number) else {
                return Released::Nothing;
            };
            session.refs -= 1;
            if session.refs != 0 {
                return Released::Nothing;
            }
            state.sessions.remove(&number);
            Released::Session(number)
        }
    })
}

/// Return to the initial state, except that session numbers keep counting:
/// a number is never reused while the kernel runs.
pub fn reset() {
    with(|state| {
        let next_session = state.next_session;
        *state = State::new();
        state.next_session = next_session;
    });
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Serializes tests that touch the process-global exchange state.
    pub(crate) static TEST_LOCK: AtomicBool = AtomicBool::new(false);

    pub(crate) struct TestGuard;

    impl TestGuard {
        pub(crate) fn acquire() -> Self {
            while TEST_LOCK
                .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
                .is_err()
            {
                std::thread::yield_now();
            }
            reset();
            TestGuard
        }
    }

    impl Drop for TestGuard {
        fn drop(&mut self) {
            reset();
            TEST_LOCK.store(false, Ordering::Release);
        }
    }

    fn read_all_lines() -> Vec<u8> {
        let mut out = Vec::new();
        let mut buf = [0u8; 7];
        while let Ok(n) = read_events(&mut buf) {
            out.extend_from_slice(&buf[..n]);
        }
        out
    }

    #[test]
    fn events_has_one_consumer_description_shared_by_its_references() {
        let _guard = TestGuard::acquire();
        assert!(!consumer_present());
        let events = open_events(0, 0).unwrap();
        assert_eq!(open_events(0, 0), Err(Errno::EBUSY));
        add_ref(events).unwrap(); // fork
        assert_eq!(release(events), Released::Nothing);
        assert!(consumer_present());
        assert_eq!(release(events), Released::Consumer);
        assert!(!consumer_present());
        assert!(open_events(0, 0).is_ok(), "a new consumer may open after the last close");
    }

    #[test]
    fn the_first_line_reports_the_output_listener_and_changes_follow() {
        let _guard = TestGuard::acquire();
        set_outputs_accepting(true);
        open_events(0, 0).unwrap();
        set_outputs_accepting(false);
        set_outputs_accepting(false); // no change, no line
        assert_eq!(read_all_lines(), b"outputs accepting\noutputs none\n");
        assert_eq!(read_events(&mut [0u8; 4]), Err(Errno::EAGAIN));
    }

    #[test]
    fn a_read_never_crosses_into_the_next_line() {
        let _guard = TestGuard::acquire();
        open_events(0, 0).unwrap();
        push_line(b"batch x\n".to_vec());
        let mut buf = [0u8; 64];
        let n = read_events(&mut buf).unwrap();
        assert_eq!(&buf[..n], b"outputs none\n");
        let mut small = [0u8; 3];
        assert_eq!(read_events(&mut small), Ok(3));
        assert_eq!(&small, b"bat");
        let n = read_events(&mut buf).unwrap();
        assert_eq!(&buf[..n], b"ch x\n");
    }

    #[test]
    fn lines_without_a_consumer_are_dropped_and_closing_discards_unread_lines() {
        let _guard = TestGuard::acquire();
        push_line(b"batch early\n".to_vec());
        let events = open_events(0, 0).unwrap();
        push_line(b"batch kept\n".to_vec());
        assert_eq!(release(events), Released::Consumer);
        open_events(0, 0).unwrap();
        assert_eq!(read_all_lines(), b"outputs none\n");
    }

    #[test]
    fn a_session_reads_its_number_once_and_ends_with_its_last_reference() {
        let _guard = TestGuard::acquire();
        let first = reserve_session().unwrap();
        let session = activate_session(first);
        let second = reserve_session().unwrap();
        assert_ne!(first, second, "session numbers are never reused");
        let mut buf = [0u8; 16];
        let n = read_session(first, &mut buf).unwrap();
        let mut expected = Vec::new();
        expected.extend_from_slice(alloc::format!("{first}\n").as_bytes());
        assert_eq!(&buf[..n], expected.as_slice());
        assert_eq!(read_session(first, &mut buf), Ok(0));
        add_ref(session).unwrap();
        assert_eq!(release(session), Released::Nothing);
        assert_eq!(release(session), Released::Session(first));
        assert_eq!(read_session(first, &mut buf), Err(Errno::EBADF));
    }

    #[test]
    fn at_most_32_sessions_are_open_at_once() {
        let _guard = TestGuard::acquire();
        let sessions: Vec<_> = (0..MAX_SESSIONS).map(|_| activate_session(reserve_session().unwrap())).collect();
        assert_eq!(reserve_session(), Err(Errno::ENOSPC));
        release(sessions[0]);
        assert!(reserve_session().is_ok(), "an ended session frees a place");
    }

    #[test]
    fn handles_round_trip_and_stay_out_of_the_virtual_device_band() {
        for device in [ExchangeDevice::Events, ExchangeDevice::Session(0), ExchangeDevice::Session(4_000_000)] {
            let handle = device.host_handle();
            assert!(handle <= -EXCHANGE_HANDLE_BASE);
            assert_eq!(ExchangeDevice::from_host_handle(handle), Some(device));
        }
        for unrelated in [-1, -12, 0, 5, -2_000_000_000, -6_999_999_999, -8_000_000_000] {
            assert_eq!(ExchangeDevice::from_host_handle(unrelated), None, "{unrelated}");
        }
        let mut text = [0u8; 11];
        let len = format_decimal(4_294_967_295, &mut text);
        assert_eq!(&text[..len], b"4294967295\n");
    }
}
