# Public builtin ESM synchronization owner

The shared actual builtin registry captures public export keys on first public
require/ESM load, independently of internal process.getBuiltinModule loading.
The unchanged pinned public sync algorithm visits only schemeless-eligible
actual records; it never evaluates a lazy builtin merely to synchronize it.
The unchanged getOwn/syncExports algorithms update real named bindings in key
order, propagate original getter errors after earlier changes, ignore inherited
properties, preserve default identity and never add new names.

The native loader passes a genuine rooted synthetic environment owner to its
private descriptor. Checked owner.setExport updates that exact environment;
no user URL/property is used to recover a native record. Existing CJS/JSON array
results keep their old path; only returning the identical native owner signals
that direct writes are already complete. Module/owner/descriptor JS slots trace
lifetime normally. A new guest realm/GC/OOM/link-failure interaction is still
uncompiled and needs identified-artifact validation.

This is partial L-011 builtin synchronization/L-009 API work, not async
module.register support. ASYNC-REGISTER-DECISION.md in the source capsule lists
its InternalWorker/shared wait/error/job prerequisites. Public loader-worker,
permissions, preload, full namespace/job ordering and four-host conformance
remain open. Native VM components are explicit dependencies, not guest proof.

The facade's initial getter/evaluation phase is still the existing deferred
synthetic evaluation path, rather than pinned getESMFacade's immediate facade
evaluation. Alternative cache-key/native registry identity and first-load
reentrant builtin initialization also remain open. These are implementation
obligations, not accepted engine/platform exclusions; focused normal-path
synchronization does not close them or L-011 as a whole.
