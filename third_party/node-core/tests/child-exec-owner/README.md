# Focused child exec collector controls

Run unchanged control.cjs under the pinned Node26.13.0 reference with
`--expose-internals control.cjs native|before|after REPO`. Native uses actual
public Node exec; after loads the current normal generated production adapter
and values over actual native spawn/Buffer/stream/timers/errors. Before loads
exact preserved old bootstrap collector from REPO/../before. It is historical
comparison only; a live root normally has no such sibling baseline layout.

Every process records23semantic rows; compare exact native/after rows and retain
nonpasses, raw stdout/stderr and nonzero exits. Process exit0 alone is not a
compatibility pass. Native subprocess safety termination is explicitly reported
as fixtureSafetyKill and cannot count as target timeout behavior. A baseline
collector accepting an invalid callback is recorded before cleanup removes its
invalid close/error listener to avoid aborting the whole observation process;
that cleanup does not establish a passing callback contract. Real input errors
are observed and included, never swallowed into a success row.

preload.cjs selects only actual collector functions, retaining native child
transport as an explicit fixture dependency for unchanged upstream files.
Native child/stream/decoder/Buffer/timer/OS/realm/error ownership is not guest
conformance. No engine/product builds or overall suite is needed for this JS
source slice. Preserve original aggregate ERR_STREAM_WRITE_AFTER_END nonpass.
