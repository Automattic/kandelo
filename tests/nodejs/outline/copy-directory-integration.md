# Recursive copy source integration

Source checkpoint 147 installs the pinned fs.cp, fs.cpSync and
fs.promises.cp algorithms over actual directory-copy operations. Nine complete
Node reference files match the audited 26.13.0 archive. The recursive native
walk, path normalization and containment algorithms are selected unchanged;
the V8-facing preflight and overwrite errors are adapted to owned error
records. The private POSIX port uses real stat, mkdir, timestamps, filesystem
operations and the existing descriptor-copy owner. It supplies no alternate
host filesystem backend for the guest.

Fresh asynchronous destinations use a real native worker request, exclusive
creation and byte copies. Other entries retain their awaited filesystem
operations and filter rejection identity. Sync and async paths keep the
target's distinct link, merge, skip, mode and canonicalization behavior.
Error construction preserves the different positive errno, negative UV and
plain coded errors, including inherited code setters. The selected JS source
guards unavailable ErrorCaptureStackTrace; full target stack capture remains
an implementation and validation obligation.

CpDirJob has its own native class, private state, async ID, default trigger,
frame and error factory. Inactive jobs have no persistent root. Scheduled
work retains the actual object until completion or retirement; workers do
not enter JavaScript. Actual paths, state, work records and string capacities
have retained-memory claims. Cancellation joins real running work and
suppresses delivery without claiming to undo filesystem effects. Finalized's
shared destroy-queue append may still allocate.

The production adapter forwards all five methods, the ordinary bootstrap
installs the public and promise APIs, and the package stages the actual
operations unit with its own C++20 flag. Engine patch 0117 adds the class
resource-info branch, guarded registrations and source unit over checkpoint
146. It preserves the current StatWatcher unit and earlier backing, TLS,
Worker, lazy-property and VM hooks. No native-fs slot layout, kernel/host ABI,
target pin, platform identity or upstream assertion changes.

Existing sealed native/component evidence is retained under exact identities:
16 matching groups and one nonpass, with the driver correctly exiting 1.
The recovered callback-throw case observes init, getter, before, callback,
uncaught, after and destroy on native Node. The component misses after.
Both processes exit 0, but the trace mismatch is still a failed comparison.
Shared process uncaught recovery and native execution-stack ownership remain
implementation gaps. Unconditionally emitting after is not an accepted fix.

The matching groups cover real byte trees, filters, errors and partial trees,
links, validation, timestamps, clone modes, special files, replacement,
destination races, error setters and default options. Two unchanged upstream
files pass in both native and component modes. These results depend on native
Node filesystem, Dir, Stats, path, errors and callback helpers for existing
per-entry APIs; they do not establish current guest behavior. Earlier fixture
compile, handle-scope, link-expectation and default-mode failures remain
preserved in the sealed evidence.

Root verification stages the integrated source through the normal generators,
compiles the actual portable copy unit with strict warnings, executes the
five-method production adapter control, and parses the complete generated
bootstrap. Existing affected frontend and package-source checks are recorded
separately. Initial root hash-precondition, old EOF-context rebase and flat include-fixture
failures are retained; no source or assertion was discarded to resolve them.

The production SpiderMonkey class, GC, weak inactive ownership, realms, OOM,
interrupts, callback recovery, retained-memory projection and guest VFS/backend
behavior remain unvalidated. FS-006/FS-016 and the complete copy contract remain open.
The combined engine is uncompiled and no current conformance evidence exists
across all four hosts. All 19 families remain partial. No overall suite,
package/engine build or full product rebuild ran for this integration.

Exact source, evidence identities and limitations:
[copy-directory-finding-progress.json](copy-directory-finding-progress.json).
