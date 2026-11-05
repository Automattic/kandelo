# Directory entries and public readdir ownership

This source slice addresses the original readdir/Dirent observations and
the readdir portion of FS-013. It does not close FS-013, opendir/Dir, the
filesystem family or four-host runtime conformance. The exact Node 26.13.0
target/source/native-reference pin and frozen audit remain unchanged.
The finding-progress JSON links original matrix row indices/IDs without
promoting observations to closed APIs. The validation-candidates JSON records
fourteen unchanged files verified against the pinned source archive; those
upstream files have not been executed in this slice.

## Actual source behavior

`readdir-operations.h` uses guest POSIX scandir/stat/lstat, preserves byte
names and actual entry types, excludes dot entries, and retains libuv's
byte ordering and EINTR policy. A native type is mapped from the actual
dirent field where available; ordinary unknown entries stay unknown until
the unchanged public utility performs lstat. A failed lstat is no longer
silently converted into a regular file.

The recursive owner follows the pinned native policy: breadth-first result
order, directory symlink traversal, raw relative paths, actual failing scan
path, and unknown-type/stat failure behavior. In particular, recursive
unknown-type lstat failures remain unknown/non-descending, as in the target;
they are distinct from ordinary getDirent's rejecting fallback. A single
queued guest work item traverses the tree instead of Node's multi-helper
walk; it performs real I/O off the JS thread. No inode filter silently
prunes symlink cycles. Thread-count/performance parity is not established.

The directory-entry enum is generated unchanged from the pinned full libuv
header. The JS constants and C++ owner share that declaration. Seven
unchanged source selections retain public sync/callback/promise validation,
Dirent and DirentFromStats inheritance/symbols/predicates, parentPath,
encodings, VFS dispatch and recursive helpers. Callback/sync and promise
recursive-option validation differ in the target; the copied callers retain
that distinction. No upstream assertion or platform identity changes.

`native-readdir.cpp` copies validated path bytes, runs actual scans, and
roots the private result encoder/request until completion. Worker code
never enters JS or retains a JS backing-store pointer. Completed results
are copied into JS-owned bytes, encoded through private actual Buffer
codecs, then delivered through the existing native FSReq callback/promise
owner. The guest promise path adds no conversion reaction. Native work,
associated-memory reservation, cancellation/stopping and root retirement
reuse the shared owner. Exact GC/realm/error/async/lifecycle behavior remains
subject to guest validation.

Patch 75 registers two private native methods. Recipe 64 declares the new
native/header/generator inputs; the generated bundle contains the public
factory. Bootstrap removes the legacy three-kind Dirent and sync-backed
readdir wrappers from final public ownership. There is no kernel, syscall,
host import or wire ABI change. All four hosts select the same guest path.

## Scoped evidence

* `node26-readdir-controls-r3.log` under `.context`: five focused controls
  pass, zero failures/skips. One checks the exact native version; the others
  compare actual candidate public/byte algorithms with native results for
  types/descriptors, encodings, recursion, callbacks/promises and errors.
  Native Node supplies filesystem/request/engine dependencies. The Buffer
  fixture has a fixed JS allocator. Its promise transport adds an explicit
  reaction, so these controls do not prove guest allocation or scheduling.
* `.context/node26-readdir-native/report.json`: seven compiled portable
  POSIX-owner comparisons pass, including real files, directory links,
  FIFO/socket types, unknown fallback, syscall errors and a symlink cycle.
  Expected error outcomes are compared results, not successful operations.
  APFS rejects creation of the invalid-UTF-8 filename with EILSEQ; that
  setup remains unsupported and does not exclude guest raw-name coverage.
* The first frontend run retained three passes/two failures from the actual
  adapter's missing validateFunction dependency. The dependency is now
  imported; assertions are unchanged. Inputs/log remain in
  `.context/node26-readdir-controls-r1-inputs` and the r1 log. R2 passed five
  controls; R3 additionally routes native sync errno/path through the
  candidate private error-packet decoder rather than bypassing it.

These are not guest/four-host passes. The new JSAPI and actual guest libc
path require identified-artifact execution. Overall suites/full product
rebuild remain deferred. Follow-up unchanged upstream coverage includes
test-fs-readdir-types, test-fs-readdir, recursive readdir, buffer/encoding,
permission/error and async_hooks/resource cases; retain their full source
and native controls when that validation is scheduled.

The normal targeted wasm32 engine build at revision 64 succeeded (job
`node26-core-engine-r64-1104-142703-88ef`, exit zero, 206 seconds).
Mozilla's original include/macroassembler/opcode checks, optimization and
fork instrumentation pass. Both retained executable copies are 47,811,476
bytes, SHA-256
`4f0a74361eb9afa61140aad0a8dbd2b3dd3a057eb4f955180b826b9fc58a4dee`.
The report, frozen inputs, log and actual executables are in
`.context/node26-engine-r64-accepted`; all 514 selected input identities
matched after the build. This compiles/links the guest native bridge but
does not execute the public APIs in a guest or establish full conformance.

## Remaining dependencies

* Actual opendir/Dir native handle, read queues, iteration, buffering,
  recursion, close/error/ref/GC and disposal remain missing.
* Guest raw-byte files, mounts and permissions, races, huge allocations,
  symlink/backend/error details, shutdown/cancellation and accounting require
  guest verification; current native controls do not cover every branch.
* The guest Node Permission Model activation/enforcement remains missing,
  as with the existing filesystem owners. POSIX credentials/permissions still
  govern actual scans. Promise stack recapture retains the existing explicit
  capability guard; exact engine stacks remain a shared implementation gap.
* Buffer pooling/transfer/storage, complete public VFS and the remaining
  filesystem/shared-foundation findings remain open. Do not treat copied
  algorithms, rejected options or this scoped evidence as family closure.
