# Public process abort ownership

The public main-environment process.abort function is the native abort
function, with no JavaScript numeric-exit replacement. Its native entry
prints actual executing engine frames and calls the shared process-state
libc abort owner. No exit listener, normal shutdown coordinator or
JavaScript exception recovery path is invoked. libc owns SIGABRT
unblocking, disposition reset and re-raise behavior; the kernel owns
actual signal-death and parent wait status.

Workers use the unchanged Node 26.13.0 internal/process/worker_thread_only
unavailable factory. Its disabled property, ordinary callable metadata,
ERR_WORKER_UNSUPPORTED_OPERATION and ignored receiver/arguments come from
the pinned algorithm. A native Worker guard separately prevents private
binding access from aborting a process the Worker does not own.

This source slice does not establish guest signal execution or four-host
conformance. Native helper controls compile the actual shared header
against the declared development shell's native libc, not guest musl.
Frontend controls consume actual pinned native Node errors and abort,
not the new guest JSAPI entry. Real native stack diagnostics, exact Node
abort formatting and core-dump output remain implementation gaps. The
separate uncaught-exception hard_abort SIGTRAP-versus-SIGABRT gap remains
unchanged. Kernel SIGABRT termination is real source ownership, but the
new public route still requires an identified guest artifact and actual
parent wait-status validation on all four hosts.
