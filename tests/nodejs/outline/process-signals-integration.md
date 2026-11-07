# Main-environment process signal ownership

Source162 replaces JS-only process signal listeners with the pinned first/last
listener activation algorithm over a real main-environment SignalWrap owner.
The native owner installs sigaction, queues fixed records through a real
nonblocking close-on-exec pipe and enters JavaScript only on the owning loop.
Watch roots, native allocation claims, IDs/frames/triggers, pending-record
counts, deferred close and shutdown retirement belong to actual native state.
Worker entry cannot acquire the main process signal environment.

Signal names and aliases derive from the exact pinned node_constants.cc body.
The generated header uses the real target signal.h values when compiled; no
Darwin reference numbers become guest constants. The production header/binding
has not yet been compiled. The same source/header compiled on the native host
matches its31 Node signal constants, which is a separate bounded control.

The integration adds an actual checkpoint for preceding legacy socket/child
Promise producers before signal JavaScript and stops before adapter timers if
the checkpoint or signal callback requests exit. Modern TCP native scopes
already checkpoint; these fences do not replace their owners. Signal and stat
watcher close work rotates without entering a second callback after failure
or stopping. The canonical engine patch is additive over current TCP/X509 and
preserves the shared-buffer layout correction.

757 current production inputs, normal bundle/bootstrap/header/unity staging
and14 existing package-source tests pass. Five bounded owner/activation groups
pass with an unchanged existing portable POSIX signal binary and the current
pinned listener algorithm over explicit native Node signal/async dependencies.
The worker control supplies environment metadata; it is not a Kandelo Worker
execution. No new native/engine compilation or guest/four-host test ran here.
Four earlier tiny owner compile attempts are recorded: three successful and
one Darwin macro-qualification error, all preserved.

Engine-owned custom/coverage dispositions still yield EBUSY and remain an
implementation gap. The actual default no-JIT recipe has no active Wasm trap
handler; coverage SIGUSR1/2 conflicts are concrete conditional branches. The
preliminary C++17/constinit concern was retracted: this unity translation unit
has the existing C++20 override. No compiler error or patch is manufactured
from that false lead. The native pipe stress observation4096queued/5904dropped
is retained separately, consistent with the pinned handler's pipe-full path,
not a public API pass or a newly accepted platform boundary.

SignalWrap prototype/descriptors, allowed/denied wrapper and getter failures,
GC/fatal/realm/loop-phase/cooperative libc delivery, masks/fork/debugger/default
termination and private TTY SIGWINCH activation remain open. All nineteen
families remain partial; current engine and four-host conformance are
unestablished. Overall suites and the full product rebuild remain deferred.

Exact evidence: [process-signals-finding-progress.json](process-signals-finding-progress.json).
