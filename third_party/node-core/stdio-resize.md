# Main-environment stdio SIGWINCH consumer

Lazy process stdout/stderr now register named SIGWINCH listeners through the
actual process signal hooks, after their captured terminal/stream owners exist.
The first/last listener module selects the compiled signal name and owns the
real unreferenced SignalWrap; this replaces the empty private os.signal call.
Only a successfully initialized main-environment TTY output subscribes. The
existing Worker stdio and public TTY constructor gaps are not activated here.

Stdio publishes its real stream before registration so SignalWrap init and
newListener reentry observe the same owner. Publication is tentative: failure
clears the cache, removes only this consumer and invokes the genuine empty-
listener cleanup owner, then rethrows the original error. Existing subscribers
are preserved. The fd-stream factory's optional internal publication callback
extends its captured-owner rollback through terminal binding and registration.
Failure closes that actual reopened OutputHandle, never a mutable public fd.
A cleanup allocation/close failure can still prevent immediate retirement;
original failure remains primary and environment/GC cleanup is still required.

Resize uses the existing pinned refresh method and actual captured window-size
owner. Public descriptor reuse cannot retarget it. Stdio dummyDestroy/reuse,
callback/encoding/backpressure and shared signal delivery remain existing owners.
Output destroy does not remove the process resize listener, matching stdio reuse.
Unreopenable TTY fallback retains its existing borrowed asynchronous/raw-fd size
owner and identity/blocking gaps; captured descriptor guarantees apply only when
a real OutputHandle was acquired. Rollback never closes the borrowed public fd.

Focused component evidence uses real native PTYs, ioctl and SIGWINCH, actual
pinned native SignalWrap/stream/EventEmitter/VM dependencies and the unchanged
existing OutputHandle addon. Seven component groups pass versus one baseline;
one actual public native resize group agrees on both streams' dimensions. These
are distinct scopes, not eight independent native comparisons. Zero compilers.
Actual guest signal self-pipe/admission/EBUSY sharing, queued output close,
callback/frame/ref/fatal/GC/Worker/four-host behavior remain unvalidated.

The existing closing/closed Signal.start branch returns undefined. Its exact
relationship to pinned native post-detach unwrap versus closing uv_signal_start
remains unresolved; this slice neither invents errno nor claims init-close
registration conformance. Existing signal-sharing EBUSY is an implementation
ownership prerequisite, not an accepted platform exclusion. No registration
exception is converted into successful stdio publication.
