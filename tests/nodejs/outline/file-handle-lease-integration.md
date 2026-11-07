# FileHandle descriptor lease prerequisite

Source240 integrates one move-only native descriptor lease into actual existing
FileHandle adoption, synchronous close, foreground GC and queued close. A queued
close takes authority before publication. Admission failure and unperformed
cancellation restore that same lease before clearing the rooted parent; a
performed close consumes it exactly once and never retries a reused fd number.
The existing EINTR/EINPROGRESS close policy remains unchanged. The normal recipe
stages the actual header and declares its source input, preserving executable
build-script mode without changing integration-tool policy.

Public transfer remains disabled in this lease slice. Native clone tag/sidecar,
receiver-local registration/error/init/rollback, packet retirement and Worker
exit ownership are a separately reviewed next slice. Raw outside fd closure,
public active-I/O/ref/stream lifetime and exact JSAPI/GC/realm/OOM/fatal behavior
remain explicit obligations, not accepted boundaries.

Six exact portable-header native fd/OFD/thread groups and two pinned Node26.13
Worker/in-use reference groups are narrow evidence. They do not execute the new
candidate FS translation unit, workqueue or guest libc. One original successful
portable helper compilation is counted once315→316; root reuses its exact binary
and compiles nothing. Four previous239dependency attributions remain unresolved,
so316is a lower bound. Existing accepted239 build and its three scoped Node-host
guest passes retain their original source scope; source240 is uncompiled.

Qualified audit requirements are filesystem.md FS-010, the FileHandle lifetime
section in filesystem-contracts.md, and worker-contracts.md R-013. R-004 is only
an original prose reference here, not an invented standalone definition. No
finding, family or public transfer compatibility is closed. All nineteen families
remain partial; overall suites/full rebuilding stay deferred.
