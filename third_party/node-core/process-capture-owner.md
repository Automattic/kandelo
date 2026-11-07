# Process exception capture owner

The shared process frontend now consumes the complete unchanged pinned Node
26.13.0 capture state/set/add/has/global-handler algorithms. Its actual private
Uint32Array belongs to the native environment, is rooted through that lifetime
and is read by native fatal admission; it is not a support flag or detached
JavaScript-only substitute. CLI admission sets private native option state;
Worker kind disables abort policy because that environment does not own the
process. Fatal admission performs real guest libc abort when unsuppressed.
The environment unregisters the toggle root during teardown.

Primary callback priority, reverse auxiliary strict-true handling, report
configuration getter/setter chronology, original errors and continuation
frames are retained. No report measurements/schema or REPL module is added.
Report configuration storage does not establish report emission support.

Native controls consume the actual pinned Node aliased toggle/async/fatal and
Worker private port/serializer owners. They do not compile or execute new
guest JSAPI, realm/GC/OOM/context-shutdown or fatal paths. The guest libc
SIGABRT consumer does not establish default V8 hard_abort immediate-crash
signal/diagnostic parity (the native Darwin arm64 control reports SIGTRAP).
That is an open implementation/validation gap, not an accepted platform
boundary. The exact source/compiled target and all nonpasses remain recorded
in the private process-capture-owner handoff. Public REPL activation, VM
import callbacks and full exception/rejection/Worker/CLI conformance remain.
