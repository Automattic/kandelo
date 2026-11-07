# Native Socket destroySoon component

Run control.cjs with the exact pinned Node26.13.0 binary and
--expose-internals. Arguments are native|before|after and the materialized
private repo path. before additionally requires sibling before/bootstrap
snapshot and baseline-core.js created by the sealed capsule. Current native
and after subjects use the supplied repo source/bundle. Run through the
repository's scripts/dev-shell.sh; no global product setup runs.

The fixture retains the exact current Socket/stream/bootstrap factory and
reuses genuine native TCP resources, real native StreamBase state, writes,
ShutdownWrap and close callbacks. A local native listener merely supplies an
actual accepted TCP owner; it does not prove guest server/connect support.
The two2MiB cases compare peer bytes through EOF and real socket close. Actual
native request results are retained without a retry-dependent threshold.
Native resource/OS behavior is an explicit dependency, not guest JSAPI proof.

Before/after/native groups and raw failures are retained in the capsule. The
before finalization calls the explicit native boundary with invalid-1 and
that boundary refuses it; this is not a claimed observed guest errno. No
upstream assertion is changed, no fake handle/ref/queue field is supplied and
no broader suite is launched. Connected native ShutdownWrap scheduling, exact
fatal/error/realm/GC, pending-connect/reuse and all four hosts remain open.
