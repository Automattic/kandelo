# Async child spawn cancellation owner

The public async spawn owner validates signal and killSignal before physical
stdio pipe preparation. It consumes the existing process kill/wait and child
close owners: abort never substitutes a successful exit or releases a PID
without actual reaping. Already-aborted signals schedule the target nextTick
handler after the launch; live signals use the existing pinned resistant
addAbortListener. An actual successful kill emits AbortError with the original
reason as cause. A false kill result emits no fabricated abort or exit.

The listener is disposed on the actual child exit event. Failed launches keep
the pinned target listener behavior: an un-aborted signal remains subscribed
until its abort event even though error/close already occurred. Aborting such
a failed child does not add AbortError because child.kill returns false. This
is recorded target behavior, not a manufactured exit-based cleanup policy.

killSignal names/numbers use the real platform signal table. A killSignal
option of zero is rejected by the pinned sanitizer; this differs from the
actual child.kill(0) probe, which must not terminate a process. Timeout input
validation retains target precedence, but positive async timeout enforcement
remains a separate implementation gap.

This source slice does not resolve argv0/executable-role authority, custom
shell paths, IPC/extra stdio, uid/gid or complete spawn normalization. Native
POSIX and EventTarget component evidence does not establish guest scheduler,
signal numbers, callback/GC/Worker or four-host runtime conformance. The existing
native PID, descriptor actions, reap and pipe-close ownership remains decisive.
