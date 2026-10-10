//! The POSIX readiness decision for host-delegated stream sockets.
//!
//! Workstream H4 (host-surface minimization). Until this module existed, the
//! rule that turns a connection's observable state into `poll` `revents` was
//! implemented **eight** times and the copies disagreed:
//!
//! 1. `crate::syscalls::poll_check`, `FileType::Socket` arm (this kernel).
//! 2. `HostIO::host_net_poll`'s default method — `Ok(events)`, i.e. "every
//!    event you asked for is ready". Every test `HostIO` in the tree inherited
//!    it, so no kernel unit test could observe a readiness divergence at all.
//! 3. `FetchNetworkBackend.poll` (`host/src/networking/fetch-backend.ts`).
//! 4. `TcpNetworkBackend.poll` (`host/src/networking/tcp-backend.ts`).
//! 5. `TlsNetworkBackend.poll` (`host/src/networking/tls-network-backend.ts`),
//!    itself two rules behind one `if` — an HTTP branch and a tunnel branch.
//! 6. `VirtualTcpPeer.poll` (`host/src/networking/virtual-network.ts`).
//! 7. `VirtualNetworkBackend.poll`'s `return events` fallback for a peer that
//!    implements no `poll` (same file).
//! 8. `KernelHost.#hostNetPoll`'s `return events & (POLLIN | POLLOUT)`
//!    fallback for a backend that implements no `poll` (`host/src/kernel.ts`).
//!
//! Sites 2, 7 and 8 are the ones a census by name misses: they are not named
//! after the feature and contain no `POLL*` reasoning to grep for — two of
//! them are a bare `return events`.
//!
//! # What POSIX actually requires
//!
//! POSIX.1-2017 XSH `poll()` constrains this decision in three ways that the
//! copies above broke:
//!
//! * "`POLLERR`, `POLLHUP`, and `POLLNVAL` ... shall be ignored in the
//!   `events` member, and shall be set in the `revents` member whenever the
//!   corresponding condition is true." Site 6 gated `POLLHUP` on the caller
//!   having asked for `POLLIN`, so a `poll(fd, POLLOUT)` caller was never told
//!   the connection had hung up. Sites 3, 4 and 5 report it ungated.
//!
//! * "`POLLHUP` and `POLLOUT` are mutually exclusive: a stream can never be
//!   writable if a hangup has occurred." Sites 1, 3, 5 and 6 could report both
//!   at once. Only site 4 got this right, by gating `POLLOUT` on the same
//!   `closed` flag that raises `POLLHUP`.
//!
//! * `POLLIN` means "data *may be read* without blocking". A stream at
//!   end-of-file reads without blocking — it returns 0 — so EOF is `POLLIN`.
//!   Site 4 reports it; sites 3 and 5 report only `POLLHUP` and leave
//!   `POLLIN` clear.
//!
//! Where POSIX permits several behaviours, `CLAUDE.md` prefers the
//! Linux-observable one. Linux raises `POLLHUP` only once *both* directions
//! are down (`sk->sk_shutdown == SHUTDOWN_MASK`); a bare peer FIN is
//! `POLLIN`, not `POLLHUP`. That is why [`HANGUP`] is specified as "torn down
//! in both directions" and a peer FIN alone is [`RECV_EOF`].
//!
//! [`HANGUP`]: wasm_posix_shared::net_readiness::HANGUP
//! [`RECV_EOF`]: wasm_posix_shared::net_readiness::RECV_EOF

use wasm_posix_shared::net_readiness as facts;
use wasm_posix_shared::poll::{POLLERR, POLLHUP, POLLIN, POLLOUT};

/// Decide `revents` for a host-delegated stream connection from the facts its
/// host engine reported and the `events` the caller asked about.
///
/// This is the whole rule, in one place, for every backend on every host.
pub fn stream_revents(host_facts: u32, events: i16) -> i16 {
    let flags = host_facts & facts::FLAG_MASK;

    // An engine with no readiness source gets the documented wake-every-round
    // treatment: report what the caller asked for and let `recv`/`send`
    // answer `EAGAIN` if the data is not there yet. This is a real fallback,
    // not a readiness claim, so it does not synthesise POLLERR/POLLHUP.
    if flags & facts::UNOBSERVABLE != 0 {
        return events & (POLLIN | POLLOUT);
    }

    let mut revents: i16 = 0;

    // POSIX: POLLERR and POLLHUP are ignored in `events` and set in `revents`
    // whenever the condition holds.
    if flags & facts::ERROR != 0 {
        revents |= POLLERR;
    }
    if flags & facts::HANGUP != 0 {
        revents |= POLLHUP;
    }

    // POLLIN: data may be read without blocking. End-of-stream qualifies —
    // the read returns 0 rather than blocking.
    if events & POLLIN != 0 && flags & (facts::RECV_READY | facts::RECV_EOF) != 0 {
        revents |= POLLIN;
    }

    // POLLOUT: normal data may be written without blocking.
    if events & POLLOUT != 0
        && flags & facts::SEND_READY != 0
        && flags & facts::SEND_CLOSED == 0
    {
        revents |= POLLOUT;
    }

    // POSIX: "a stream can never be writable if a hangup has occurred."
    if revents & POLLHUP != 0 {
        revents &= !POLLOUT;
    }

    revents
}

/// The POSIX errno a host engine attached to a reported error, if any.
///
/// Returned for `SO_ERROR`. `None` when the engine reported [`ERROR`] without
/// classifying it, so the caller keeps whatever it already knows rather than
/// inventing a classification.
///
/// [`ERROR`]: wasm_posix_shared::net_readiness::ERROR
pub fn reported_errno(host_facts: u32) -> Option<u32> {
    if host_facts & facts::ERROR == 0 {
        return None;
    }
    match facts::errno_of(host_facts) {
        0 => None,
        errno => Some(errno),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: i16 = POLLIN | POLLOUT;

    #[test]
    fn hangup_is_reported_even_when_not_requested() {
        // POSIX: POLLHUP "shall be ignored in the events member, and shall be
        // set in the revents member whenever the corresponding condition is
        // true". `virtual-network.ts` gated it on the caller asking for
        // POLLIN, so a POLLOUT-only poller never learned of the hangup.
        let revents = stream_revents(facts::HANGUP, POLLOUT);
        assert_eq!(revents & POLLHUP, POLLHUP);
    }

    #[test]
    fn error_is_reported_even_when_not_requested() {
        let revents = stream_revents(facts::ERROR, POLLOUT);
        assert_eq!(revents & POLLERR, POLLERR);
    }

    #[test]
    fn hangup_and_pollout_are_mutually_exclusive() {
        // POSIX: "POLLHUP and POLLOUT are mutually exclusive: a stream can
        // never be writable if a hangup has occurred." `fetch-backend.ts` and
        // the HTTP branch of `tls-network-backend.ts` reported POLLOUT
        // unconditionally alongside POLLHUP.
        let revents = stream_revents(facts::HANGUP | facts::SEND_READY, ALL);
        assert_eq!(revents & POLLOUT, 0);
        assert_eq!(revents & POLLHUP, POLLHUP);
    }

    #[test]
    fn end_of_stream_is_readable() {
        // A stream at EOF reads without blocking (it returns 0), so POSIX
        // POLLIN holds. `tcp-backend.ts` reported this; the fetch and TLS
        // backends reported only POLLHUP.
        let revents = stream_revents(facts::RECV_EOF, POLLIN);
        assert_eq!(revents & POLLIN, POLLIN);
    }

    #[test]
    fn buffered_bytes_are_readable() {
        assert_eq!(stream_revents(facts::RECV_READY, POLLIN) & POLLIN, POLLIN);
    }

    #[test]
    fn readable_is_gated_on_the_requested_events() {
        // POLLIN, unlike POLLERR/POLLHUP, *is* gated by `events`.
        assert_eq!(stream_revents(facts::RECV_READY, POLLOUT) & POLLIN, 0);
    }

    #[test]
    fn writable_only_while_the_write_half_lives() {
        assert_eq!(
            stream_revents(facts::SEND_READY, POLLOUT) & POLLOUT,
            POLLOUT
        );
        assert_eq!(
            stream_revents(facts::SEND_READY | facts::SEND_CLOSED, POLLOUT) & POLLOUT,
            0
        );
    }

    #[test]
    fn a_peer_fin_is_readable_not_a_hangup() {
        // Linux raises POLLHUP only once both directions are down. A bare
        // peer FIN leaves the socket writable and readable-at-EOF.
        let revents = stream_revents(facts::RECV_EOF | facts::SEND_READY, ALL);
        assert_eq!(revents & POLLIN, POLLIN);
        assert_eq!(revents & POLLOUT, POLLOUT);
        assert_eq!(revents & POLLHUP, 0);
    }

    #[test]
    fn unobservable_wakes_every_round_without_claiming_error_or_hangup() {
        let revents = stream_revents(facts::UNOBSERVABLE, ALL);
        assert_eq!(revents, ALL);
        assert_eq!(revents & (POLLERR | POLLHUP), 0);
    }

    #[test]
    fn idle_connection_is_not_ready_for_reading() {
        assert_eq!(stream_revents(facts::SEND_READY, ALL) & POLLIN, 0);
    }

    #[test]
    fn reported_errno_round_trips_and_stays_absent_when_unclassified() {
        let classified = facts::with_errno(facts::ERROR, 111); // ECONNREFUSED
        assert_eq!(reported_errno(classified), Some(111));
        assert_eq!(stream_revents(classified, ALL) & POLLERR, POLLERR);

        assert_eq!(reported_errno(facts::ERROR), None);
        assert_eq!(reported_errno(facts::RECV_READY), None);
    }
}
