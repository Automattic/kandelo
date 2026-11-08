# Public terminal stream constructors

The complete unchanged pinned Node 26.13.0 `lib/tty.js` now supplies public
`isatty`, `ReadStream` and `WriteStream`. The lazy builtin uses an actual module
factory over the existing native TTY constructor and callable Socket owner;
empty generic stream subclasses are removed. No substitute handle, namespace
constructor or host-production TTY implementation is supplied.

The native `tty-constructor` operation supplies its actual constructor through
the normal error/value envelope. Its per-environment/realm native cache and
constructor prototype exist before TTYWRAP init. The unchanged public algorithm
validates the fd, constructs that actual TTY and checks its context error before
calling `net.Socket.call` on the actual inheriting receiver. Full call/new forms,
prototype links, options spread/getter order and public method descriptors come
from the unchanged target module. Actual constructor/native exceptions propagate.

Socket's typed handle branch recognizes the real terminal class/context and
retains its authority through read/write/ref/close/finalization. It does not
turn TTY numbers into TCP descriptors. The real shared onStreamRead, private
byte publication, encoded scalar writes, retained request callbacks and queued
shutdown are consumed by the stream. The separate shutdown-envelope correction
is required: the private factory must submit the actual ShutdownWrap from the
native packet's value. Buffer/string ownership, prior-write barriers and native
TTY/SHUTDOWNWRAP identities stay with their existing owners.

WriteStream asks the actual retained owner to block and query its window; it
publishes columns/rows only on successful ioctl. It uses the genuine existing
color owner and lazily loads the actual readline owner for cursor/clear writes.
ReadStream consumes the real retained raw-mode owner and its error/status
policy. Public isatty uses the pinned integer/int32 gate before the actual
libc-backed isTTY operation. No dimensions or terminal capability are invented.

The ordinary Socket chain has no `_writev` implementation and inherits the
target Writable null default through Duplex. Writable.clearBuffer therefore
uses its genuine scalar `_write` loop. This is not native mixed-vector parity:
the lower private writev bridge still explicitly rejects mixed strings, custom
writev/prototype mutation can select other behavior, and native vector batching,
request shape and fairness remain implementation gaps. No fake vector success
or installed no-op is used to activate these constructors.

Actual native admission still has gaps for unreopenable/master TTYs, files and
pipes; candidate ENOTTY/ENOTSUP/error behavior is not an accepted platform
boundary or proof of target uv_tty_init parity. Init-hook close ordering remains
unresolved. Existing captured process stdin/stdout/stderr keep their independent
borrowed-fd publication rules; public TTY prototype identity for those captured
streams is not fixed by this slice. Native StreamBase prototype/request details,
partial EAGAIN, GC/OOM/realm/Worker and four-host conformance remain open.

The normal source builder verifies the already-pinned complete tty.js and embeds
it unchanged into this new declared adapter input. No engine patch or ABI/pin
change is needed. Source inspection and exact patch replay only were performed;
no normal generation, runtime controls, compilers, package/overall suites or
guest executions ran. This is partial public TTY implementation, not conformance
or finding closure.
