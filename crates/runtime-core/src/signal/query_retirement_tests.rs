//! Actual signal delivery against the retained request engine. Admission/current
//! validation has its own syscall tests; these cases begin with captured owned
//! requests and exercise their real token, OFD pin and native-control replies.
use super::*;
use crate::{
    blocked_retry::{BlockingRetryOperation, BlockingRetryTarget, StableOfdTarget},
    fd::OpenFileDescRef,
    gl_query_receipt::{self as wire, Control, Mode, Reply},
    gl_query_request::{GlQueryOwner, GlQueryProgress, GlQueryRequest},
    lock::AdvisoryLockManager,
    ofd::FileType,
    process::{ThreadInfo, test_host::NoopHost},
    syscalls,
};
use alloc::{vec, vec::Vec};
use wasm_posix_shared::{WasmStat, flags::O_RDONLY, gl, signal::*, wait::*};

#[derive(Debug, PartialEq, Eq)]
enum Event {
    Control(i64, Control),
    Close(i64),
}
struct Host {
    replies: VecDeque<Result<Vec<u8>, i32>>,
    events: Vec<Event>,
}
impl Host {
    fn new() -> Self {
        Self {
            replies: VecDeque::new(),
            events: Vec::new(),
        }
    }
    fn reply(&mut self, token: i64, control: Control, mode: Option<Mode>, reply: Reply) {
        self.replies.push_back(Ok(wire::encode_reply(
            &reply,
            wire::ExpectedReply {
                control,
                token: token as u64,
                capacity: 0,
                retirement_mode: mode,
            },
        )
        .unwrap()));
    }
    fn pending(&mut self, token: i64) {
        self.reply(
            token,
            Control::Cancel,
            Some(Mode::Cancel),
            Reply::Retiring(Mode::Cancel),
        );
    }
    fn retired(&mut self, token: i64) {
        self.reply(
            token,
            Control::Cancel,
            Some(Mode::Cancel),
            Reply::Retired {
                mode: Mode::Cancel,
                accepted: true,
            },
        );
        // Forget transport failure follows an authenticated terminal ACK. It
        // leaves only host scalar metadata, never actual cleanup authority.
        self.replies.push_back(Err(-(Errno::EIO as i32)));
    }
}
macro_rules! noop_methods {
    ($(fn $method:ident($($arg:ident: $ty:ty),*) -> $result:ty;)*) => {
        $(fn $method(&mut self, $($arg: $ty),*) -> $result {
            NoopHost.$method($($arg),*)
        })*
    };
}
impl HostIO for Host {
    fn host_close(&mut self, handle: i64) -> Result<(), Errno> {
        self.events.push(Event::Close(handle));
        Ok(())
    }
    fn gl_query(&mut self, _: i32, op: u32, input: &[u8], output: &mut [u8], _: u32) -> i32 {
        assert_eq!(op, gl::KERNEL_GL_QUERY_CONTROL);
        let request = wire::decode_request(input).unwrap();
        self.events
            .push(Event::Control(request.token as i64, request.control));
        match self
            .replies
            .pop_front()
            .expect("script every native control response")
        {
            Ok(bytes) => {
                let count = bytes.len().min(output.len());
                output[..count].copy_from_slice(&bytes[..count]);
                bytes.len() as i32
            }
            Err(code) => code,
        }
    }
    noop_methods! {
        fn host_read(h: i64, b: &mut [u8]) -> Result<usize, Errno>;
        fn host_write(h: i64, b: &[u8]) -> Result<usize, Errno>;
        fn host_seek(h: i64, o: i64, w: u32) -> Result<i64, Errno>;
        fn host_fstat(h: i64) -> Result<WasmStat, Errno>;
        fn host_readdir(h: i64, b: &mut [u8]) -> Result<Option<(u64, u32, usize)>, Errno>;
        fn host_clock_gettime(c: u32) -> Result<(i64, i64), Errno>;
        fn host_ftruncate(h: i64, l: i64) -> Result<(), Errno>;
        fn host_fsync(h: i64) -> Result<(), Errno>;
        fn host_fchmod(h: i64, m: u32) -> Result<(), Errno>;
        fn host_fchown(h: i64, u: u32, g: u32) -> Result<(), Errno>;
        fn host_set_alarm(s: u32) -> Result<(), Errno>;
        fn host_set_posix_timer(t: i32, s: i32, v: i64, i: i64) -> Result<(), Errno>;
        fn host_getrandom(b: &mut [u8]) -> Result<usize, Errno>;
        fn host_net_connect(h: i32, a: &[u8], p: u16) -> Result<(), Errno>;
        fn host_net_connect_status(h: i32) -> Result<(), Errno>;
        fn host_net_send(h: i32, d: &[u8], f: u32) -> Result<usize, Errno>;
        fn host_net_recv(h: i32, l: u32, f: u32, b: &mut [u8]) -> Result<usize, Errno>;
        fn host_net_close(h: i32) -> Result<(), Errno>;
        fn host_net_listen(f: i32, p: u16, a: &[u8; 4]) -> Result<(), Errno>;
        fn host_getaddrinfo(n: &[u8], r: &mut [u8]) -> Result<usize, Errno>;
        fn bind_framebuffer(p: i32, a: usize, l: usize, w: u32, h: u32, s: u32, f: u32) -> ();
        fn unbind_framebuffer(p: i32) -> ();
        fn fb_write(p: i32, o: usize, b: &[u8]) -> ();
    }
}

fn fixture() -> (Process, AdvisoryLockManager, Host) {
    let mut proc = Process::new(42);
    proc.blocked_retries.bind_task(42);
    proc.add_thread(ThreadInfo::new(43, 0, 0, 0));
    (proc, AdvisoryLockManager::new(), Host::new())
}

fn admit(proc: &mut Process, host: &mut Host, tid: u32, handle: i64) -> (i64, usize) {
    let idx = proc.ofd_table.create(
        FileType::Regular,
        O_RDONLY,
        handle,
        b"/query-owner".to_vec(),
    );
    let id = proc.ofd_table.get(idx).unwrap().ofd_id;
    let fd = proc.fd_table.alloc(OpenFileDescRef(idx), 0).unwrap();
    let request = GlQueryRequest::new(
        GlQueryOwner {
            target: StableOfdTarget {
                original_fd: fd,
                ofd_idx: idx,
                ofd_id: id,
            },
            pid: proc.pid as i32,
            exec_generation: proc.exec_generation,
            tid,
            session_id: 1,
            display_id: 1,
            context_id: Some(7),
            draw_surface_id: Some(0),
            read_surface_id: Some(0),
            pointer_width: 4,
        },
        gl::QOP_FINISH,
        vec![],
        0,
        0,
    )
    .unwrap();
    let token = proc.blocked_retries.prepare_insert().unwrap();
    proc.ofd_table.try_inc_ref_exact(idx, id).unwrap();
    assert!(
        proc.blocked_retries
            .insert_prepared(
                token,
                tid,
                BlockingRetryOperation::GlQuery,
                BlockingRetryTarget::GlQuery(request)
            )
            .is_ok()
    );
    host.reply(token, Control::Begin, None, Reply::Pending);
    assert_eq!(
        syscalls::step_retained_gl_query(proc, host, tid, token),
        Ok(GlQueryProgress::PendingOwned)
    );
    (token, idx)
}

fn mask_bookkeeping(proc: &mut Process) {
    proc.signals.blocked = sig_bit(SIGUSR2);
    proc.enter_signal_mask_wait_for(42, SignalMaskWaitKind::Ppoll, sig_bit(SIGUSR1));
    proc.install_caught_handler_mask_for(42, sig_bit(SIGWINCH), SIGCHLD);
    proc.returned_handler_depths.push(7);
    proc.set_blocked_for(43, sig_bit(SIGUSR2));
    proc.enter_signal_mask_wait_for(43, SignalMaskWaitKind::Pselect, sig_bit(SIGUSR1));
    proc.install_caught_handler_mask_for(43, 0, SIGCHLD);
    proc.get_thread_mut(43)
        .unwrap()
        .signals
        .returned_handler_depths
        .push(8);
}

fn assert_preserved(proc: &Process, idx: usize) {
    assert_eq!(proc.state, ProcessState::Running);
    assert_eq!(proc.exit_status, 0);
    assert_eq!(proc.exit_signal, 0);
    assert!(proc.wait_event.is_none());
    assert!(proc.blocked_retries.has_external_query_receipts());
    assert_eq!(proc.ofd_table.get(idx).unwrap().ref_count, 2);
    assert_eq!(proc.mask_waits.len(), 1);
    assert_eq!(proc.mask_waits[0].saved_mask, sig_bit(SIGUSR2));
    assert_eq!(
        proc.signals.blocked,
        sig_bit(SIGUSR1) | sig_bit(SIGWINCH) | sig_bit(SIGCHLD)
    );
    assert_eq!(proc.caught_handler_depth, 1);
    assert_eq!(proc.returned_handler_depths, [7]);
    let sibling = proc.get_thread(43).unwrap();
    assert_eq!(sibling.signals.mask_waits.len(), 1);
    assert_eq!(sibling.signals.caught_handler_depth, 1);
    assert_eq!(sibling.signals.returned_handler_depths, [8]);
}

#[test]
fn queued_termination_keeps_signal_and_masks_until_late_ack() {
    let (mut proc, mut locks, mut host) = fixture();
    let (token, idx) = admit(&mut proc, &mut host, 43, 900);
    mask_bookkeeping(&mut proc);
    proc.raise_signal_with_value(SIGTERM, 0xabcd);
    let signal_generation = proc.signals.readiness_generation;
    for _ in 0..2 {
        host.pending(token);
        assert_eq!(
            try_deliver_pending_signals_for_tid_with_locks(&mut proc, &mut locks, &mut host, 42),
            Ok(SignalProgress::PendingOwned)
        );
        assert_preserved(&proc, idx);
        assert!(proc.signals.is_pending(SIGTERM));
        assert_eq!(proc.signals.rt_queue.front().unwrap().si_value_bits, 0xabcd);
        assert_eq!(proc.signals.readiness_generation, signal_generation);
        assert!(!host.events.iter().any(|e| matches!(e, Event::Close(_))));
    }
    host.retired(token);
    assert_eq!(
        try_deliver_pending_signals_for_tid_with_locks(&mut proc, &mut locks, &mut host, 42),
        Ok(SignalProgress::Complete(()))
    );
    assert_eq!(proc.state, ProcessState::Exited);
    assert!(!proc.signals.is_pending(SIGTERM));
    assert!(proc.mask_waits.is_empty());
    assert_eq!(proc.caught_handler_depth, 0);
    assert!(proc.returned_handler_depths.is_empty());
    assert!(!proc.blocked_retries.has_external_query_receipts());
    assert!(proc.ofd_table.get(idx).is_none());
    assert_eq!(proc.wait_event.unwrap().si_code, CLD_KILLED);
    assert_eq!(proc.wait_event.unwrap().si_status, SIGTERM as i32);
    assert_eq!(
        host.events
            .iter()
            .filter(|e| **e == Event::Close(900))
            .count(),
        1
    );
    let events = host.events.len();
    assert_eq!(
        try_deliver_pending_signals(&mut proc, &mut host),
        SignalProgress::Complete(())
    );
    assert_eq!(host.events.len(), events);
}

#[test]
fn malformed_transport_or_foreign_ack_retains_signal_and_direct_termination_bookkeeping() {
    for (direct, failure) in [
        (false, 0),
        (true, 0),
        (false, 1),
        (true, 1),
        (false, 2),
        (true, 2),
    ] {
        let (mut proc, mut locks, mut host) = fixture();
        let (token, idx) = admit(&mut proc, &mut host, 42, 901);
        mask_bookkeeping(&mut proc);
        proc.raise_signal(SIGTERM);
        match failure {
            0 => host.replies.push_back(Ok(vec![0; wire::REPLY_HEADER])),
            1 => host.replies.push_back(Err(-(Errno::EIO as i32))),
            _ => host.reply(
                token + 1,
                Control::Cancel,
                Some(Mode::Cancel),
                Reply::Retired {
                    mode: Mode::Cancel,
                    accepted: true,
                },
            ),
        }
        let progress = if direct {
            try_terminate_process_by_signal_with_locks(&mut proc, &mut locks, &mut host, SIGTERM)
        } else {
            try_deliver_pending_signals_with_locks(&mut proc, &mut locks, &mut host)
        };
        assert_eq!(progress, SignalProgress::ProtocolFaultOwned);
        assert_preserved(&proc, idx);
        assert!(proc.signals.is_pending(SIGTERM));
        host.retired(token);
        assert_eq!(
            try_deliver_pending_signals_with_locks(&mut proc, &mut locks, &mut host),
            SignalProgress::Complete(())
        );
        assert_eq!(proc.state, ProcessState::Exited);
        assert_eq!(
            host.events
                .iter()
                .filter(|e| **e == Event::Close(901))
                .count(),
            1
        );
    }
}

#[test]
fn typed_default_preflight_composes_before_host_free_dequeue() {
    let (mut proc, mut locks, mut host) = fixture();
    let (token, _) = admit(&mut proc, &mut host, 43, 908);
    proc.raise_signal_with_value(SIGTERM, 0x1234);
    host.pending(token);
    assert_eq!(
        preflight_default_signal_action(&mut proc, &mut host, SIGTERM),
        SignalProgress::PendingOwned
    );
    assert!(proc.signals.is_pending(SIGTERM));
    assert_eq!(
        try_apply_default_signal_action_with_locks(&mut proc, &mut locks, &mut host, SIGCONT),
        SignalProgress::Complete(DefaultSignalOutcome::Continue)
    );
    host.retired(token);
    assert_eq!(
        preflight_default_signal_action(&mut proc, &mut host, SIGTERM),
        SignalProgress::Complete(())
    );
    let controls = host.events.len();
    let info = dequeue_signal_for(&mut proc, 42, SIGTERM);
    assert_eq!((info.0, info.1), (SIGTERM, 0x1234));
    assert_eq!(
        try_apply_default_signal_action_with_locks(&mut proc, &mut locks, &mut host, SIGTERM),
        SignalProgress::Complete(DefaultSignalOutcome::Exited)
    );
    assert_eq!(proc.state, ProcessState::Exited);
    // Default action/exit sees proven retirement: no duplicate native control.
    assert!(
        host.events[controls..]
            .iter()
            .all(|event| matches!(event, Event::Close(_)))
    );
}

#[test]
fn legacy_and_host_free_consumers_fail_before_signal_loss() {
    for boundary in 0..4 {
        let (mut proc, mut locks, mut host) = fixture();
        let (token, idx) = admit(&mut proc, &mut host, 42, 902);
        mask_bookkeeping(&mut proc);
        proc.raise_signal(SIGTERM);
        if boundary != 0 {
            host.pending(token);
        }
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match boundary {
            0 => {
                dequeue_signal_for(&mut proc, 42, SIGTERM);
            }
            1 => deliver_pending_signals(&mut proc, &mut host),
            2 => {
                apply_default_signal_action(&mut proc, &mut host, SIGTERM);
            }
            _ => terminate_process_by_signal_with_locks(&mut proc, &mut locks, &mut host, SIGTERM),
        }));
        assert!(result.is_err());
        assert_preserved(&proc, idx);
        assert!(proc.signals.is_pending(SIGTERM));
    }
}

#[test]
fn caught_ignored_stop_and_continue_do_not_cancel_queries() {
    let (mut proc, mut locks, mut host) = fixture();
    let (_, idx) = admit(&mut proc, &mut host, 43, 903);
    proc.signals
        .set_handler(SIGUSR1, SignalHandler::Handler(123))
        .unwrap();
    proc.raise_signal(SIGUSR1);
    assert_eq!(
        try_deliver_pending_signals(&mut proc, &mut host),
        SignalProgress::Complete(())
    );
    assert!(proc.signals.is_pending(SIGUSR1));
    assert_eq!(proc.caught_handler_depth, 0);
    assert_eq!(host.events.len(), 1); // Only Begin; caught signal stays queued.
    assert_eq!(dequeue_signal_for(&mut proc, 42, SIGUSR1).0, SIGUSR1);
    assert_eq!(proc.install_caught_handler_mask_for(42, 0, SIGUSR1), 0);
    proc.set_blocked_for(42, 0);
    proc.signals
        .set_handler(SIGUSR2, SignalHandler::Ignore)
        .unwrap();
    proc.raise_signal(SIGUSR2);
    proc.raise_signal(SIGCHLD);
    assert_eq!(
        try_deliver_pending_signals_with_locks(&mut proc, &mut locks, &mut host),
        SignalProgress::Complete(())
    );
    assert!(!proc.signals.is_pending(SIGUSR2));
    assert!(!proc.signals.is_pending(SIGCHLD));
    proc.raise_signal(SIGTSTP);
    assert_eq!(
        try_deliver_pending_signals(&mut proc, &mut host),
        SignalProgress::Complete(())
    );
    assert_eq!(proc.state, ProcessState::Stopped);
    assert_eq!(proc.wait_event.unwrap().event_mask, EVENT_STOPPED);
    proc.raise_signal(SIGCONT); // Mandatory continuation occurs on generation.
    assert_eq!(proc.state, ProcessState::Running);
    assert_eq!(
        try_deliver_pending_signals(&mut proc, &mut host),
        SignalProgress::Complete(())
    );
    assert_eq!(proc.wait_event.unwrap().event_mask, EVENT_CONTINUED);
    assert_eq!(host.events.len(), 1);
    assert_eq!(proc.ofd_table.get(idx).unwrap().ref_count, 2);
    assert!(proc.blocked_retries.has_external_query_receipts());
}

#[test]
fn terminating_delivery_waits_for_every_threads_exact_receipt() {
    let (mut proc, mut locks, mut host) = fixture();
    let (first, idx) = admit(&mut proc, &mut host, 42, 904);
    let (second, _) = admit(&mut proc, &mut host, 43, 905);
    proc.raise_for_thread(42, SIGTERM);
    host.retired(first);
    host.pending(second);
    assert_eq!(
        try_deliver_pending_signals_for_tid_with_locks(&mut proc, &mut locks, &mut host, 42),
        Ok(SignalProgress::PendingOwned)
    );
    assert!(proc.is_live_explicit_tid(42));
    assert!(proc.signal_pending_anywhere(SIGTERM));
    assert_eq!(proc.state, ProcessState::Running);
    assert!(proc.ofd_table.get(idx).is_some());
    assert!(!host.events.iter().any(|e| matches!(e, Event::Close(_))));
    host.retired(second);
    assert_eq!(
        try_deliver_pending_signals_for_tid_with_locks(&mut proc, &mut locks, &mut host, 42),
        Ok(SignalProgress::Complete(()))
    );
    let close = host
        .events
        .iter()
        .position(|e| matches!(e, Event::Close(_)))
        .unwrap();
    assert!(host.events[..close].contains(&Event::Control(first, Control::Cancel)));
    assert_eq!(
        host.events[..close]
            .iter()
            .filter(|e| **e == Event::Control(second, Control::Cancel))
            .count(),
        2
    );
    assert_eq!(proc.state, ProcessState::Exited);
}

#[test]
fn stopped_sigkill_is_not_cleared_before_query_retirement() {
    let (mut proc, mut locks, mut host) = fixture();
    let (token, _) = admit(&mut proc, &mut host, 43, 906);
    proc.record_stop(SIGTSTP);
    proc.raise_for_thread(43, SIGKILL);
    host.pending(token);
    assert_eq!(
        try_deliver_pending_signals_for_tid_with_locks(&mut proc, &mut locks, &mut host, 42),
        Ok(SignalProgress::PendingOwned)
    );
    assert!(proc.signal_pending_anywhere(SIGKILL));
    assert_eq!(proc.state, ProcessState::Stopped);
    assert_eq!(proc.wait_event.unwrap().event_mask, EVENT_STOPPED);
    host.retired(token);
    assert_eq!(
        try_deliver_pending_signals_for_tid_with_locks(&mut proc, &mut locks, &mut host, 42),
        Ok(SignalProgress::Complete(()))
    );
    assert!(!proc.signal_pending_anywhere(SIGKILL));
    assert_eq!(proc.state, ProcessState::Exited);
    assert_eq!(proc.wait_event.unwrap().si_status, SIGKILL as i32);
}

#[test]
fn foreign_task_does_not_cancel_or_consume_queued_signal() {
    let (mut proc, mut locks, mut host) = fixture();
    let (_, _) = admit(&mut proc, &mut host, 43, 907);
    proc.raise_signal(SIGTERM);
    assert_eq!(
        try_deliver_pending_signals_for_tid_with_locks(&mut proc, &mut locks, &mut host, 999),
        Err(Errno::ESRCH)
    );
    assert!(proc.signals.is_pending(SIGTERM));
    assert_eq!(host.events.len(), 1);
}
