# Directory and pathname source owners

This source slice addresses the mkdir portions of FS-012 and the distinct
unlink/rmdir operations in FS-014. Neither finding nor the filesystem family
is closed. The exact Node 26.13.0 target and frozen audit remain unchanged.

## Actual implementation

directory-operations.h owns a portable POSIX backend and the pinned
MKDirpSync/MKDirpAsync continuation decisions from src/node_file.cc and
node_file-inl.h. It tries the requested leaf first, visits missing parents
without normalizing away byte/dot/trailing components, records the first
directory actually created, accepts only existing directories, and bounds
retries of the same missing path. Mode zero is passed through unchanged;
the real guest umask/credentials govern creation. The sync and async policies
retain their distinct errors for a failed parent stat, including dangling
symlinks. It uses actual mkdir/stat/unlink/rmdir, with libuv's EINTR retry
policy, rather than C remove() or a preflight type check.

native-directory.cpp copies the validated pathname bytes before dispatch,
retains the native work/resource until actual completion and converts result
and error paths to JS using the existing native UTF-8 replacement owner.
Callback requests and promise jobs share the existing native FSReq lifetime,
queue, cancellation/stopping and callback-scope policy. Queued cancellation
does not pretend to undo an already running operation. Worker execution
enters no JS. Native memory accounting reserves the copied path/result bound;
an overflow check precedes async construction. These JSAPI paths are uncompiled.

directory-platform-adapter.js selects unchanged public mkdir/unlink/rmdir
wrappers for sync, callback and promise APIs, plus makeCallback, vfsVoid and
validateRmdirOptions. They preserve mode/options/path/callback validation,
removed rmdir recursive-option errors, VFS dispatch and async return shapes.
The promise error helper has the same explicit stack-recapture availability
guard as the existing FileHandle owner; exact engine stack filtering remains
an implementation gap. Public wrappers preserve raw Uint8Array paths until
the native copy. The later removal source owner supersedes legacy rmSync; see the removal
dependency record for actual traversal/retry/raw scan work and its limits.

Patch 64 stages/registers the native bridge. The recipe declares new inputs
and advances its revision for changed output source, without rebuilding an
artifact. All four runtime hosts select the same guest source; no host import,
kernel/syscall ABI change, merge or deployment occurs.

## Scoped evidence and preserved nonpasses

The final focused run node26-directory-controls-r3.log passes nine controls:
five directory API scenarios and four existing removal controls. Actual
candidate public wrappers run over native Node FSReq/OS bindings; this checks
the frontend, not the new guest native bridge. It covers validation/order,
recursive results, mode zero, URLs/byte paths, callbacks, file/directory/link
distinctions and removed options. On this APFS host, raw invalid-byte creation
returns an error matching native Node; it is not raw-filename guest evidence.

The portable header has 22 matching filesystem scenarios against exact native
Node sync/callback/promise APIs, including first-created returns, symlinks,
dot/trailing paths, zero mode and real unlink/rmdir errors. Comparisons retain
sync/async differences and actual post-operation trees; expected syscall
errors count as matched outcomes, not successful filesystem operations.
One additional pre-existing invalid-byte filename case is explicitly
unsupported by the host fixture (APFS mkdir EILSEQ), not a compatibility pass
or accepted guest platform exclusion. The native report and exact inputs
are node26-directory-native-r2/report.json.

Three unchanged upstream files cover mode masks, rmdir on files and basic
mkdir/rmdir. Candidate runs replace only these public APIs; the remaining fs,
native engine/request/OS bindings, assert/common stay native. Source identities
and process outcomes are in node26-directory-upstream-r3/report.json. These
are frontend controls, not tests of the portable header or a guest artifact.

Earlier failures remain retained: the first frontend fixture omitted its
native UV error binding (three failures/six passes); the second exposed an
actual missing kEmptyObject dependency and incorrectly assumed APFS accepted
the raw name (two failures/seven passes). The dependency is implemented and
raw-name assertions compare native outcomes without assuming success. The
first native harness compared sync and async results as identical, then
aborted setting up the invalid-byte name; raw logs/inputs remain. The first
upstream run had six setup errors because NODE_TEST_DIR did not exist. Its
unchanged common module required an existing root; the corrected runner
creates its own root before execution. No assertion or platform identity was
changed. The second upstream run preserved three candidate global-leak
assertion failures (native controls passed): Node's internal test binding
publishes globals when required during preload. The fixture now restores
only those native helper globals to their previous descriptors; the upstream
leak assertion remains unchanged and enabled. No historical nonpass becomes
current passing evidence.

## Remaining work

* Removal now has distinct actual native sync and pinned async rimraf owners,
  plus a private raw scanner. Full public readdir/name/Dir ownership, native
  retry timing/extreme options/error details, races and guest lifecycle remain
  open; see removal-implementation-dependencies.md. This does not close the
  audited public filesystem contracts.
* Readdir/Dirent/opendir/Dir, metadata/watch/copy/links/temp/disposal and other
  public FS/VFS obligations remain partial. Permission Model activation,
  deprecations, stack/error details and all individual API audit rows remain
  subject to implementation reconciliation.
* Native JSAPI compilation, actual guest libc/kernel mounts/credentials/umask,
  GC/realm/cancellation/shutdown and four-host conformance are unestablished.
  Browser memory/lifecycle and filesystem conformance gates must use identified
  rebuilt artifacts when the build constraint is lifted. A passing host-libc
  helper or native Node request fixture does not satisfy those gates.

Continue independent loader/stream/process findings before a larger directory
test campaign. After the breadth pass, run unchanged applicable upstream
filesystem coverage and native differential controls with durable per-host
accounting of all passes, failures, skips, unsupported cases and harness errors.
