//! `/dev/console`: where a program's bytes go when it addresses the machine
//! rather than a file.
//!
//! Kandelo has no console of its own. The one place a machine's output
//! reaches the host is `host_write` on handle 1, which is what fd 1 of a
//! process started with host stdio already uses: the Node and browser hosts
//! both deliver it through the same `Kernel` path to the embedder's stdout
//! callback, attributed to the process the kernel is serving at the time.
//! `/dev/console` is that same stream, reachable by name. It is a chosen
//! design for a facility POSIX does not describe beyond requiring the node
//! to exist, not a statement of compatibility with any other system's
//! console.
//!
//! The reason it exists is `syslog(3)`'s `LOG_CONS` option. When no logging
//! daemon is reachable, musl opens `/dev/console` with
//! `O_WRONLY|O_NOCTTY|O_CLOEXEC` and writes the message there. The node used
//! to be an alias of `/dev/null`, so even that fallback discarded it.
//!
//! # Flow is one-way: program to console, never to the ring
//!
//! Every record in the kernel message ring is kernel-sourced. That is why
//! `/dev/kmsg` refuses writes (`EACCES`): a program able to append could
//! forge a kernel record. A program that could write the ring *through
//! `/dev/console`* would be the same forgery by a second path, so this module
//! takes only the host and the bytes. It has no access to the ring and names
//! neither of its writers; a test holds the source to that.
//!
//! # What is deliberately absent: echoing ring records
//!
//! The ring is not mirrored here. The only stream there is carries bytes
//! programs and test harnesses read as what the process wrote, and a record
//! echoed into it would surface in the output of whichever unrelated process
//! the kernel happened to be serving (every death by `SIGPIPE` is logged).
//! `docs/architecture.md` keeps host diagnostics out of guest output for the
//! same reason. Echoing needs a channel that is the machine's rather than a
//! process's, which is a host-contract change and is a separate decision.

use wasm_posix_shared::Errno;

use crate::process::HostIO;

/// The host handle the machine's output stream answers to: the same one fd 1
/// of a process started with host stdio is bound to.
pub(crate) const CONSOLE_HOST_HANDLE: i64 = 1;

/// Write `buf` to the console and report how much the host took.
///
/// An empty write reaches no one: a zero-length `host_write` would still be
/// delivered to the embedder's stdout callback as an empty chunk.
pub(crate) fn write(host: &mut dyn HostIO, buf: &[u8]) -> Result<usize, Errno> {
    if buf.is_empty() {
        return Ok(0);
    }
    host.host_write(CONSOLE_HOST_HANDLE, buf)
}

#[cfg(test)]
mod tests {
    // The device is exercised through the syscall surface, where the
    // descriptor, open flags and the host double live:
    // `syscalls::tests::console_device_tests`.
}
