# Retained terminal shutdown requests

A genuine native terminal shutdown request owns SHUTDOWNWRAP identity, its
actual TTYWRAP default trigger, captured frame and native parent. Init runs
before nonallocating admission; close, a nested shutdown or context retirement
can prevent that admission. A queued request keeps the loop alive independently
of handle unref. Its rooted request retains the original terminal lease until
the callback, after hook and job checkpoint retire.

The Unix libuv target does not make TTY shutdown a no-op. `uv_shutdown`
removes writable admission and defers `shutdown(retainedFd, SHUT_WR)` until
the write queue drains. A PTY returns actual ENOTSOCK; that status is delivered
to the raw request. The pinned net `afterShutdown` callback ignores status
and invokes the Writable final callback. Kandelo consumes that unchanged
callback, preserving this distinction instead of manufacturing syscall success.

All admitted earlier write requests retire through their callbacks before
shutdown dispatch. Later writes reject with EPIPE, including writes whose
init hook admitted a shutdown. A close cancels outstanding writes, then
shutdown with ECANCELED, then publishes parent close. Only the captured
extra descriptor is closed; the borrowed public fd and reused numbers are
never shutdown or closed after lease retirement. Context teardown retires
requests without new JS callbacks before descriptor/environment release.

Completed-close and retired-wrap gates remain distinct from a live closing
handle. Raw requests are checked native capabilities with exact parent/context
and consume-once admission, not fd properties. New native JSAPI integration
has not been compiled or executed. Public constructor activation is a separate
consuming source slice; native mixed-vector admission, exact prototypes and
complete StreamBase parity remain implementation gaps.

One pinned native Node26.13.0 PTY process observes real ENOTSOCK, queued-close
ECANCELED, duplicate ENOTCONN, actual TTY trigger and borrowed-fd preservation.
A separately compiled portable ShutdownOwner/IOHandle helper verifies six
ownership groups over native Darwin PTYs, including the write barrier,
read-only admission and descriptor reuse. Two preceding fixture compile
failures remain preserved. These are reference/component evidence, not guest,
GC/realm/Worker/fatal or four-host conformance. No product or engine build,
normal bundle generation or overall suite was run.


## Native request publication envelope

The terminal request factory consumes the actual `operatingSystem` result's
`value` and `error`. Unlike direct `tty-stream-open/state/abort` operations,
`tty-stream-shutdown-request` traverses the native OS owner's ordinary result
packet. Passing that packet to `owner.shutdown` would fail its exact native
ShutdownWrap class check before any request could be admitted. The private
Socket factory now supplies the real request capability in `packet.value`;
actual native abrupt completion is unchanged and a nonzero status remains a
real ErrnoException. TCP's distinct direct request route is unchanged.

This is a source-confirmed cross-layer correction. Earlier portable/native
shutdown controls did not execute this guest publication seam and are not
passing coverage for it. No new runtime, compiler, generation or overall test
was run. The retained request/parent/generation/frame/write barrier and close
owners remain unchanged; actual guest callback/GC/realm/Worker evidence remains
required. The original shutdown capsules/evidence are preserved.
