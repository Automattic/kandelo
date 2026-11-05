# SQLite scalar, aggregate and window callback ownership

Source113 addresses part of NI-002 using the actual guest SQLite3.54.0 owner.
It preserves the exact Node26.13.0 source/native pins, completed audit and the
separate Claude/npm/Bun branch. Authorizer/virtual-table callbacks, Statement
close/dispose, backup, tag stores and the remaining native-integration modules
remain separate implementation work. This slice is not complete SQLite support.

## Public methods and SQLite registrations

The shared SQLite frontend now supplies `Database.prototype.function` and
`aggregate` instead of their explicit throwing stubs. Scalar registration
preserves the target overload, getter order, function.length validation
(including negative-zero rejection), varargs, deterministic/directOnly flags
and BigInt argument policy. Aggregates preserve start/step/result/inverse
reads, callable start versus literal state, arity calculation and directOnly.
Nonfunction result values are ignored as in the pinned source. Native state is
rechecked after getters that can close the connection.

`native-sqlite.cpp` registers actual sqlite3_create_function_v2 and
sqlite3_create_window_function callbacks. SQLite owns registration destruction,
including failed registrations and overload replacement. The bridge performs
real SQL/JS value conversion, explicit UTF8 lengths including NUL, independent
blob argument copies, signed64-bit BigInt conversion and safe-number checks.
Callback results use SQLite's actual transient text/blob copies. Unsupported
Promise/boolean/object results and excessive BigInts produce SQLite errors,
not fabricated successful values. Fixed empty raw buffers and empty views
retain their distinct SQL NULL/BLOB behavior; resizable/shared result storage
uses its actual synchronous backing span.

Synchronous callbacks enter the actual caller's JS context and realm through
the engine call API. They do not allocate synthetic AsyncResources or claim
an unrelated async scope. A connection callback-depth guard prevents closing
the database on SQLite's active callback stack. Existing active-statement
guards remain a dependency, including their incomplete public close/dispose
surface and exact error/overload behavior.

## GC graph, accumulator and cleanup ownership

The real database native JS object's trace hook visits callback values and
live aggregate accumulators. Statement and session private handles retain
that native database object in a traced reserved slot, including while only
their native entry argument remains rooted. Registrations have a weak native
connection reference, preventing a native connection/registration cycle.

This avoids permanent JS roots: callback closures can reference their public
database without making an unreachable database/closure cycle immortal.
Each aggregate invocation has its own SQLite-context state, traced through
its registration. Window step/inverse update that state; value/final follow
the target's final-result suppression after window values have been emitted.
Failed and completed contexts are retired without leaving accumulator roots.

Native-handle finalization marks the registry as retiring while SQLite
finalizes statements/connections. Aggregate cleanup then releases state
without calling start/result JS from GC. C++ exceptions are caught at C callback
boundaries, and pending JS exceptions stay primary in the guest dispatch.
Complete GC/realm/OOM/teardown/accounting behavior still needs adversarial
validation; source review alone does not establish it.

Attached native sessions are pinned across whole exec/step/reset calls,
including nested callbacks and subsequent SQLite list traversal. The
unchanged portable session ownership fixture still matches the exact native
reference after this header change. That control does not execute the new
SpiderMonkey JSAPI callback bridge.

## Existing evidence and explicit limits

The old engine88 report's enabled-SQLite load failure is preserved. A narrow
engine112 prerequisite now loads, opens, queries and closes a database
successfully, with the same source/output on the exact native reference.
This establishes that prerequisite only; no historical cause was identified,
and it does not turn the older composite failure into a pass.

The first112callback baseline has8callback-stub failures plus an existing
session-case failure. A stronger baseline preserves the same missing callback
behavior and adds explicit nonfinite/empty/shared/resizable/detached result
observations and distinct aggregate error registrations. The original aggregate
error fixture accidentally reused a different-arity overload; its source and
native results remain retained and do not establish phase coverage.

The stronger aggregate-step expectation fails on the exact native reference:
with a result callback present, a throwing step is observed as an empty-message
ERR_SQLITE_ERROR rather than the thrown object. A separate pure-native trace
records all four phases, including two calls to throwing start. This is an
unresolved source/native error-policy question, not an accepted engine limit,
an alleged outside-runtime defect or permission to change the assertions.
The failing expectation is preserved. The existing112session scenario also
fails independently, and its original trap and phase markers remain retained.

Source generation, pinned-file identity and syntax reports are in
`.context/node26-sqlite-callback-source/report.json`. The portable owner report
is `.context/node26-sqlite-callback-portable/report.json`.

Canonical targeted113compilation succeeds with all8dependency libraries cached.
Normal admission accepts the49,742,420-byte stamped engine, SHA256
`ab9a1808cf8fe197b5f4ef421dda9431817ae27d41312f97bad3d472cf1a4fdb`.
Program/kernel ABI55contract digests match, and selected prebuild sources were
checked unchanged afterward. This does not establish an immutable full product
closure or broad runtime compatibility.

The nine current comparisons record3pass/6fail, zero skips/unsupported/timeouts/
harness errors. Return conversion (including raw/view empty, shared/resizable
and detached cases), grouped aggregate state/receivers and sliding-window
step/inverse/result output match the native reference. The remaining scalar,
policy, exception, reentry, aggregate-error and session scenarios fail. Eight
native references pass; the stronger aggregate-error expectation fails on
native as described above. A failed reference is not candidate conformance.

The small additional diagnostic distinguishes JS validation success from
several constructor/error variants that fail with uncaught Wasm exceptions.
Some variants stop after the loaded marker, before the constructor returns;
the two-connection variant succeeds. No C++-exception, GC, SQLite, kernel or
engine root cause has been established. Its missing-marker/other nonpasses
remain diagnostic observations, not additional API failures or passes.
Raw reports are `.context/node26-sqlite-callback-candidate/report.json` and
`.context/node26-sqlite-error-trace/report.json`. No assertion was relaxed to
hide those outcomes.

No overall suite, full product rebuild or four-host compatibility claim
follows from this work.

## Remaining dependency order

1. Reconcile native/guest callback errors and repeated-start behavior without
   masking primary exceptions or weakening unchanged upstream assertions.
2. Diagnose the persistent session/connection integration failure and complete
   Statement close/dispose and busy/authorizer/reset/iterator resource guards.
3. Implement actual authorizer and virtual-table callbacks using equally real
   ownership, reentry, error and GC rules; add tag stores, backup, serialization,
   extensions/permissions and complete metadata/byte/path/error contracts.
4. Validate callback roots, cycles, replacement, OOM, realms, collection,
   teardown and resource accounting on identified artifacts across all hosts.
5. Run unchanged public callback/aggregate/UDF-close and other SQLite upstream
   files with their actual harness and dependencies after relevant owners exist.
   Native-only controls and partial API files are not whole-family conformance.

All19families remain partial. The full Error layout failure, compression's
preserved gzip-platform comparisons and all historical nonpasses remain open
in their own ledgers. Overall suites/full product rebuild remain deferred.
