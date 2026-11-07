# SQLite statement statistics

Statement.stat(counter) reads the actual sqlite3_stmt_status counter from
the live owned SQLite VM; resetStats resets all exposed cumulative counters
and preserves memused. Reads do not reset counters. Statistics operations
do not reset, step or invalidate an active iterator and remain usable from
an executing SQL callback, as in the pinned source.

The generated existing SQLite metadata header now also consumes the exact
pinned status-name/constant table and SQLite-version feature gate. Only
std::to_array initialization becomes an equivalent C++17 constexpr array;
no names, counter IDs or feature conditions are invented. The existing
normal limit-header generator/check and staging path own this addition.

Missing arguments do not read inherited rest-array indices. Receiver and
finalized state precede counter access and validation; wrong receivers use the actual
Illegal invocation TypeError policy. New methods retain native length0,
nonconstructibility and enumerable/writable/configurable descriptors.
Unknown counter names raise ERR_INVALID_ARG_VALUE as TypeError. The shared
native SQLite error bridge now classifies that code consistently, also for
existing native callers. No generic Error is substituted for it.

The current statement owner reads column names from the live SQLite VM
instead of caching by the reprepare counter, so resetting that counter
has no separate column cache to invalidate. Real schema-change controls
verify this owner property. No constant measurements or timing surrogate
is supplied.

One tiny native owner executable links the preserved exact SQLite3.54
object and exercises actual counters, active callbacks/VMs, reprepare,
reset and close state. Frontend controls and the selected unchanged
upstream suites use explicit native Node SQLite/encoding/VM dependencies;
they do not execute the new guest JSAPI operation/error bridge. Guest
compilation, GC/realm/Worker and four-host conformance remain unvalidated.
Tag stores, authorizers, extensions and other independent SQLite/FFI gaps
remain explicit; this slice does not close NI-002 or its module family.
