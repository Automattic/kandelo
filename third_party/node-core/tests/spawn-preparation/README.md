# Async spawn preparation ownership

This slice changes the consumed child-process frontend and the existing native
pipe publisher. It does not replace POSIX spawn or simulate descriptor validity.
Options/getter and supported first-three-stdio normalization precede physical
pipe acquisition. Both returned pipe ends are adopted into fixed own slots
without invoking an Array iterator. Every prepared owned end is retired and
closed on later acquisition/launch failure; borrowed descriptors stay borrowed.
Only genuine native Error errno data is interpreted as a launch outcome.
EMFILE/ENFILE return the public child and queue its actual error/close lifecycle;
nonlisted operation errors remain synchronous. Full normalization is still open.

The independent native patch uses JS_DefineElement rather than JS_SetElement in
the existing ScopeExit-protected native pipe publisher. This prevents inherited
Array setters from intercepting raw descriptor publication before cleanup is
released. This is source-reviewed/replayed, not compiled guest JSAPI evidence.

Run focused controls through scripts/dev-shell.sh with the exact pinned Node
26.13.0 executable, --expose-internals, and a fresh SPAWN_CONTROL_DIR. The script
run-controls.sh compiles only the tiny N-API POSIX dependency; it does not perform
product setup. control.cjs is run in isolated subprocesses with RLIMIT_NOFILE=128
and SPAWN_COMPONENT naming the resulting component.node. platform.cjs extracts
the actual bootstrap owner, uses genuine native pipe/fcntl/posix_spawn/waitpid,
and explicitly depends on native Node streams/errors/readiness for this bounded
control. It is not browser, kernel, guest JSAPI or four-host conformance evidence.

The complete unchanged upstream test-child-process-spawn-error.js is separately
run against native and the candidate preload. Original assertions are retained.
Existing child fixture support adds real primordials/native Error admission/path
validation. Its injected errno values now use actual host constants instead of
feeding guest ENOSYS38 into Darwin's native map (ENOSYS78); assertions unchanged.

Historical nonpass: numeric-diagnostic.cjs originally observed a closed numeric
fd reused by an earlier prepared pipe, followed by premature child-source close.
The separate actual action-order correction now keeps sources until all stdio
placements finish, and the unchanged diagnostic matches native. See ACTION-ORDER.md.
Its historical diagnostic explanation text is retained; compare actual observations
and subject status. No blanket inherited-fd precheck or reservation is added.
Other remaining gaps include argv coercion/resource chronology, complete stdio
(including extra fds/IPC/wrapped handles/sparse forms), active-child initialization,
post-success stream adoption failure, full process lifecycle, and public signal/
permission/IPC behavior. Passing this slice does not close those findings.
