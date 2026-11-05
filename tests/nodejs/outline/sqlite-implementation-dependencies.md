# SQLite owners and remaining native-integration requirements

Current follow-up: [source113 scalar/aggregate/window ownership](sqlite-callback-implementation-dependencies.md)
is compiled/admitted and has scoped actual Node-host results. Older recipe
statements below remain historical. A narrow112load/open/query/close case now
passes, but the existing session scenario and other constructor/error program
variants still fail. No cause of the historical88load failure was established.

This is partial NI-002/NI-006 implementation. The immutable Node26.13.0
source/native pins and historical audit remain unchanged. No family/API
finding closes from source presence or the scoped evidence below.

## Actual owners

The exact Node-vendored SQLite3.54.0/gyp-feature library is linked through
the declared SDK/resolver recipe. Engine88 retains its actual wasm32 archive
and provenance. Wasm64 and four-host API conformance remain unestablished.
The portable sqlite-store.h owns real connections, statements, native column
metadata, sqlite3_limit/defensive state and attached sessions. Close retires
statements and sessions before SQLite closes; actual configured limits and
defensive policy survive reopen. Sessions retain connections without a cycle;
connection observers are weak, and native pins prevent callback-triggered GC
from deleting sessions while SQLite is walking its list.

The frontend owns actual live statement iterators over SQLite stepping/reset,
reset-generation invalidation and target Iterator inheritance. Result records
and column metadata have null prototypes. Row settings remain live. Statement
close/dispose remains missing; whole Statement compatibility is not claimed.
Eleven limit names/IDs come from the unchanged pinned node_sqlite.h table.
The native limits object weakly owns its real connection, reads and updates
actual SQLite limits and forwards ordinary extra properties. It uses an engine
native property handler because the target native interceptor permits deletion
of virtual non-configurable properties; a scripted Proxy cannot model that
contract. Accessor/definition/freeze/preventExtensions/error/GC/realm details
still need full reconciliation; no engine/platform exclusion is accepted.

Actual sessions generate independent Uint8Array changesets/patchsets, own
close/idempotent dispose and are invalidated by connection close. Applying a
changeset snapshots actual bytes before SQLite callbacks; shared bytes use
relaxed atomic loads and no borrowed engine span survives reentry. Filter and
conflict functions stay rooted on the owning JS context; primary exceptions
survive SQLite error reporting, and close guards protect active native frames.
Source113adds partial scalar/aggregate/window callback ownership; authorizer/
virtual-table callbacks, arbitrary binding storage leases and complete callback/
GC/error/accounting behavior remain open.

## Shared activation and idle dependencies

Engine88's actual CLI state defaults SQLite on because its declared backend is
linked, matching target HAVE_SQLITE. Positive/negative options and NODE_OPTIONS
use the existing real parser; the captured startup/worker snapshot supplies
the public builtin gate. Other unimplemented feature gates stay unsupported.
The adapter now forwards every native SQLite argument, including the conflict
callback previously dropped by its fixed four-argument wrapper.

The event loop now emits process beforeExit at an actual transition to no
referenced timer/socket/work/port/worker owner. It drains listener-created
ticks/jobs, resumes actual revived work and emits again at the next idle
transition. Microtasks alone do not manufacture another loop turn. This is a
shared process/scheduler owner, not test-specific exit logic. Full fatal,
rejection/monitor, finalization/ref, interactive/worker and resource policies
remain open. The unchanged Test/Suite/harness sources consume that real event.

## Evidence and preserved nonpasses

Nine frontend controls use actual native Node SQLite/session/limits and a
compiled exact-SQLite parameter inspector; eight groups are positive/composite
and one includes explicit missing-feature guards. A portable native C++ owner
control matches native26 changeset/patchset bytes, filters/conflicts, limits,
close/error and reopen state. It additionally asserts native session pins stay
live through callback reentry and retire afterward. These controls are not
guest JSAPI/GC/VFS or four-host conformance. Their exact reports are
.context/node26-sqlite-owner-frontend-r2/report.json and
.context/node26-sqlite-session-native-r3/report.json.

Initial frontend8pass1fail evidence exposed the scripted Proxy mismatch. The
first native compile failed its own incompatible pointer conditional; the next
native/C++ fixtures both failed because a column limit of4 forbade SQLite's
five-column sqlite_master schema. Correcting the fixture to8 retains its actual
limit enforcement/reopen assertions. The first public native test tree fixture
miscounted assertions: the assertion plus subtest requires plan2; its original
native failure and exact source remain retained. No upstream assertion changed.

Engine85 failed unchanged Mozilla checks on own include order/canonical staging.
Engine86 accepted the compiled native owners, but identified public guest
checks exposed a hidden SQLite gate and a failing test incorrectly exiting0
because beforeExit was absent. Engine87 fixed actual idle/test failure semantics, but SQLite remained hidden.
The JSAPI property overload had promoted bool arguments to numeric0/1; engine88
publishes actual booleans for all six CLI fields and two private worker status
fields. The JavaScript predicates retain their strict boolean semantics. All build,
fixture and guest reports retain exact inputs and distinct outcomes; no prior
failure is converted to a pass. ABI-contract stamp warnings remain visible;
no executable was retagged. Normal stamped-consumer/ABI validation remains open.

## Remaining dependency order

1. Complete Statement close/dispose, serialization/deserialization and complete
   constructor/receiver/byte/path/URL/error/descriptor and limits semantics.
2. Add scalar/aggregate/window/authorizer/virtual-table callback lifetimes,
   native JS conversion, reentry/destructor/GC guards and error policy.
3. Add actual tag-store LRU/cache, async backup jobs, extension permissions and
   native library lifetime, plus storage/allocator accounting.
4. Validate actual guest files, raw paths, permissions, locking/contention,
   transactions/recovery, GC/realm/worker/shutdown/exceptional ownership on all
   four hosts. Native host filesystem behavior is not guest evidence.
5. Reconcile all original public observations and unchanged upstream tests.
   Candidate test sources include test-sqlite-session.js, options-getter-reentry,
   database/config and typed-array/data-view cases. Shared idle candidates are
   test-process-beforeexit.js, test-timers-unrefed-in-beforeexit.js,
   test-process-exit-from-before-exit.js and beforeexit-event-exit. No overall
   suite or full product rebuild is authorized by this plan.

FFI/WASI/SEA/Node-API/addon/embedding public bridges remain missing work. Real
lower libraries and portable code do not make those public APIs implemented.

The recorded engine88enabled SQLite guest case fails with an uncaught WebAssembly
exception during node:sqlite loading, before database construction; its reported
host status is -1 rather than a normal exit. The marked diagnostic reaches only
its first phase. This remains an unresolved implementation/integration failure,
not a platform exclusion or proof of a kernel/outside-engine defect. The shared
public test tree, deliberate failed-test exit, idle revival and disabled SQLite
mode are separately recorded. Source/native control passes are not guest SQLite
conformance. Diagnose this load failure before making any such claim.

Engine88 build: 247.7 seconds; 652 frozen selected inputs.
Exact accepted artifact/log/dependency identities: .context/node26-engine-r88-accepted/report.json.
Node-host guest report: .context/node26-sqlite-testing-guest-r3/report.json; counts {'pass': 3, 'expected-failure-observed': 1, 'fail': 1, 'timeout': 0, 'harness-error': 0}.
These bounded cases are not full SQLite/testing/process/ABI/four-host conformance.
