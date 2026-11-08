# Captured TTY output write-request foundation

This is a partial owning prerequisite for terminal.md T-002 and T-010, with a
shared contribution to T-006. It does not activate public tty constructors or
claim complete StreamBase, Socket inheritance or TTY conformance. Existing
source231 stdio publication/SIGWINCH, source201/213 input/read ownership and
captured output/window-size consumers remain real and are preserved.

Existing TCP original-allocation material is factored byte-for-byte into
stream-write-material.h, with a TCP alias. Captured OutputHandle vector writes
use the actual private descriptor and writev result, EINTR retry, real vector
limit and exact remaining addresses/count. They do not copy queued payloads.
A complete first try-write has no WRITEWRAP. A remainder creates an actual
native WriteWrap, its current frame, parent's default trigger and original
allocation capabilities before committing the remainder to the queue.
Blocking remainder syscalls can finish inline; their callback stays queued.
The request owns native material until callback/checkpoint retirement. Error
remainder bytes stay counted until callback admission, and immediate new
progress is gated by the actual pre-publication queue count (libuv stream.c
1354–1408); this avoids issuing a new syscall while completed errors still
mark a nonempty stream. The queued error/reentry path remains guest-unvalidated.

The TTY queue is tied to its real lease/generation. Completed physical writes
keep success when close starts; unfinished requests receive actual cancellation.
All queued requests retire before the parent's close callback/destroy. Pending
requests keep the loop alive independently of handle unref, using actual
membership, not a guessed ref flag. No queue/list-next pointer crosses callback
reentry. Runtime shutdown discards requests without invoking user callbacks.

Native configureWrite binds the actual shared Int32 stream state once. Security
and realm checks precede no-GC byte access. Original vector properties are read
through the caller's wrapper; an array does not delegate its realm's authority
to buffer results. Init-hook reentry can close the owner or detach the bound
view; the bound original state is rooted/revalidated before an infallible queue
commit. No fallible JS publication step follows that commit in the native call.

Existing stdio Writable now consumes genuine native scalar/vector results and
callbacks. The callback field retains the actual supplied callback identity.
This consumer has no fabricated Socket timer, _handle, TCP identity or shutdown
method. Errors during request-property publication propagate, including after
native work was committed; replayed callback exceptions stay on their original
path. Source callback/root/realm behavior remains uncompiled and unvalidated in
the guest. The native low-level synchronous tty-output-write seam is retained;
the production stdio path consumes the new request owner.

## Evidence and remaining obligations

Three sequential tiny native helper compilations passed. The second also
instantiates the unchanged shared TCP template. The third checks actual
error/cancel remainder accounting before callback admission. Real PTY checks cover an
IOV_MAX prefix, original last-buffer mutation, order, lifetime, canceled real
partial output, public-fd reuse and preserved borrowed public descriptor.
Pinned Node and production-JS-over-native-TTY controls both observe exact
A*1024 ! Z bytes and real WRITEWRAP init, parent trigger, queued callback,
before/after and destroy. A second native/JS control preserves an actual
throwing callback-property setter exception without duplicating completion.
These controls do not execute the new JSAPI request class, GC roots, native
callback scope, queued-close barrier or guest code.

The public TTY constructors, generic Socket admission, full native AsyncWrap
prototype, mixed string writes, input-kind writable transport, full duplex,
setBlocking/window/raw controls in the shared public handle shape, nonblocking
output readiness and shutdown still require implementation. Existing stdio
capture does not make those APIs complete. Existing master/unreopenable
backpressure deviations and the historical raw-mode restoration evidence remain
preserved. Concurrent external close/reuse of the private owned descriptor,
fork and cross-Worker native lifetime also remain unvalidated/unresolved; the
fd-reuse control proves the supplied public-fd case only. These are not accepted
platform exclusions. Native guest C++ and four-host conformance are unvalidated.

The exact reference remains Node26.13.0/source
18b32a3b1552e199a01f1a8d9fd64aa756d3b75b. Owning algorithms are traced to
src/stream_base.cc, src/stream_wrap.cc, src/tty_wrap.cc,
lib/internal/stream_base_commons.js and deps/uv/src/unix/{stream,tty,core}.c.
No target, kernel ABI, platform identity or shared build-tool change is made.
The current recipe/publication revision and normal patch number are coordinator
owned. Rebase raw hunks over the actual current parent and regenerate its core;
never overwrite a newer bundle with this source238 postimage.
