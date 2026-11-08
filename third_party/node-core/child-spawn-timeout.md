# Async child spawn timeout owner

Async spawn validates timeout before stdio/launch, then installs the complete
pinned referenced timer after actual child materialization and before its
AbortSignal subscription. The child module captures actual timer module methods
at initialization, as pinned child_process.js76 does. Timer expiry calls the
actual mutable child.kill(killSignal) once, catches a thrown original error and
emits that error. It creates no TimeoutError, AbortError, synthetic exit code or
signal status. False kill is not successful termination and causes no retry.

Actual close clears a still-pending timer. Exit alone is insufficient: a child
can exit while an inherited descendant still owns its stdout pipe. The existing
wait/reap and pipe-close gate remains the sole owner of exit/close publication.
Timeout and AbortSignal remain independent owners with the target order; one
may attempt a false kill and the other later terminate the real child. No
child.killed-based global deduplication is invented. The timeout remains
referenced; child.unref does not unref this timer. Zero installs no timer.

Eight focused native/candidate closure groups match exact selected observations:
real default/custom termination, early/failed close cleanup, descendant-held
pipe, thrown kill identity/no retry, AbortSignal after false timeout kill, and
zero timeout. They reuse actual native POSIX spawn/kill/WNOHANG/pipe and native
Node timer/stream/error/EventTarget dependencies. Actual Timeout resources are
observed through native async_hooks; none are fabricated. Host controls launch
/bin/sleep, /bin/sh and /usr/bin/true, using host-native signal tables. These are
not guest kernel/scheduler/signal-number/GC/realm/Worker/four-host evidence.

Preserved R1 caught an authored mistake about captured versus global timers
and a nonexistent /bin/true fixture path. Final source uses actual module timer
capture; final controls observe native Timeout identity and use /usr/bin/true.
No unchanged upstream assertions changed. No compiler, normal generation,
package/regression/overall suite or engine/product build ran. Existing helper
artifact is reused without recounting its historical compile.

Full spawn normalization, argv0/executable role, custom shell/IPC/extra stdio,
credentials and eager-versus-target lazy builtin initialization timing remain
separate gaps. Existing native wait cancellation/ref and guest timer/fatal/
shutdown owners need applicable runtime validation. This source change does
not establish full child_process compatibility.
