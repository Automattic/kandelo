//! `/dev/console`: where a program's bytes go when it addresses the machine
//! rather than a file.
//!
//! Kandelo has no console of its own. The one place a machine's output
//! reaches the host is `host_write` on handle 1 (stdout) or 2 (stderr), the
//! streams fd 1 and fd 2 of a process started with host stdio are bound to.
//! The Node and browser hosts deliver both through the same `Kernel` path
//! (`host/src/kernel.ts`, `hostWrite`) to the embedder's `onStdout` /
//! `onStderr` callback, falling back to `process.stdout` / `process.stderr`
//! and then `console`. Both callbacks are attributed to the process the
//! kernel is serving at the time: neither stream has an identity of its own.
//!
//! `/dev/console` writes to the second of them, stderr (handle 2). Console
//! text is diagnostic rather than program output, so it belongs on the
//! channel that already carries out-of-band text. A harness that captures
//! stdout to parse what a program produced then does not find a `LOG_CONS`
//! message mixed into it, and musl's own `LOG_PERROR` fallback likewise
//! writes to fd 2. Handle 2 is wired exactly as handle 1 is, on both hosts,
//! so the choice costs nothing. It is a chosen design for a facility POSIX
//! does not describe beyond requiring the node to exist, not a statement of
//! compatibility with any other system's console.
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
//! `/dev/console`* would be the same forgery by a second path, so the code
//! here takes only the host and the bytes and does not touch the ring.
//!
//! The types do not enforce that: the ring is reachable from anywhere through
//! an `unsafe` global accessor and `klog` needs only a host. It is held by
//! two checks. A source lint over this file (not over the `Console` arm of
//! `sys_write`, where the routing is decided) asserts it names no ring item.
//! A behavioural test, `writes_arriving_at_dev_console_never_enter_the_ring`,
//! writes forged-looking records through the real syscall path and asserts
//! the ring and a `/dev/kmsg` reader see nothing; it fails if either this
//! file or the `sys_write` arm is changed to log, which is the protection
//! that matters because it covers the decision itself.
//!
//! # What is deliberately absent: echoing ring records
//!
//! The ring is not mirrored here. The streams there are carry bytes that
//! programs and test harnesses read as what the process wrote, attributed to
//! whichever unrelated process the kernel happened to be serving (every death
//! by `SIGPIPE` is logged), and nothing filters by level. The same principle
//! as `docs/architecture.md`'s separation of host diagnostics from guest
//! file descriptor 2 applies; that passage concerns host diagnostics, not
//! ring records, so it is an analogy and not a rule that covers this. Echoing
//! needs a channel that is the machine's rather than a process's, which is a
//! host-contract change and is a separate decision.

use wasm_posix_shared::Errno;

use crate::process::HostIO;

/// The host handle the console writes to: stderr, the one fd 2 of a process
/// started with host stdio is bound to. See the module documentation for why
/// it is not stdout.
pub(crate) const CONSOLE_HOST_HANDLE: i64 = 2;

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
