# Persistent Dir and opendir owners

This is a partial filesystem implementation slice after the accepted engine65
checkpoint. The frozen Node26.13.0 audit and exact source/native reference pins
remain unchanged. No original observation or family closes here.

## Actual source owners

The full unchanged lib/internal/fs/dir.js owns Dir private fields, operation
and recursive-handler queues, read callbacks/promises, concurrent sync guards,
path receiver checks, recursive reads, async iteration, early-exit cleanup,
close and sync/async disposal. Public callback/sync and promise exports share
this owner, replacing the promise-opendir stub. Existing getDirent/Dirent,
validation, private byte codecs, errors, path and nextTick owners are reused.

DirectoryCursor owns a real persistent libc DIR*. It reads bounded batches
from that cursor, retries interrupted batches with the pinned libuv policy,
copies names before libc reuses its storage, preserves
native type values and distinguishes EOF from actual errno. Open failures,
renamed-open-directory behavior, reservation/refusal/release, close and RAII
cleanup derive from the actual cursor, not a readdir array or a re-opened path.
One reservation spans each native job through completion/cancellation; a failed
reservation completes once without dispatching native I/O. Pinned libuv's
closedir owner ignores libc's return value after retiring the cursor; the
source follows that exact policy and never retries a reused descriptor.

A real native DIRHANDLE async resource owns the cursor. Open/read/close use the
shared FSReqCallback/native work queue. Worker code owns only POSIX data and
never touches JS roots or enters a realm. Pending requests trace their native
parent/prototype and private converter; completion releases reservations before
JS conversion/callback reentrancy. Byte-conversion exceptions go to the actual
request oncomplete rejection path within its native callback scope, rather
than a fabricated errno or fatal native-loop error. Sync opendirSync errors
omit the path as in src/node_dir.cc; callback and recursive native-open errors
retain the target's distinct path-bearing diagnostics.

GC closes abandoned native directory cursors synchronously and queues a
non-JS diagnostic record. Successful Dir warnings are unreferenced native
immediates; failed closes and FileHandle GC errors remain referenced fatal
records. The record is retained until acknowledged outside GC. Directory and
request wrapper/batch/name allocations are accounted; opaque libc directory
and allocator/control-block overhead is not fully measured.

Patch77 and recipe67 stage the shared native Dir owner/header and full public
module through the normal engine package route. No kernel/syscall/host import,
wire ABI, platform identity or separate Claude/npm/Bun dispatch changes.

## Bounded evidence

Six frontend scenarios in .context/node26-dir-controls-r2/report.json pass:
sync byte encodings/batches/EOF, queued reads/close and sync concurrency,
recursive/early-break iteration, descriptors/disposal/receivers, validation/
errors and conversion rejection. Actual candidate public Dir/Dirent/private
codecs run over substituted native Node cursor/request/filesystem/engine
owners. This does not execute the guest JSAPI, work queue or GC/ref lifecycle.

Seven portable native comparisons in .context/node26-dir-native/report.json
pass against the pinned native fs_dir binding: batch sizes1/2/32, empty,
missing, not-directory and a directory renamed after open. Successful helper
paths also check unperformed reservation release, busy refusal, repeated EOF
and post-close EBADF. Expected syscall errors are compared outcomes, not
successful opens. Native FIFO/socket/link/Unicode entries retain actual types.
A separate injected-EINTR control first reproduced a missing batch retry.
The corrected source discards the partial interrupted batch and retries the
same persistent cursor, as uv__fs_readdir plus uv__fs_work do; the same control
now passes, along with the seven ordinary native comparisons. The failing
log/binary and old source remain retained. This fault injection is a portable
owner control, not a signal/guest/four-host conformance claim.

The initial frontend run's five passes and one path-diagnostic failure remain
retained with exact inputs. Assertions and pinned module bytes are unchanged.

## Remaining requirements

* Actual guest libc/VFS raw-path and directory semantics, including backend
  facilities and error/permission policy. The Node public VFS handler and
  Permission Model remain missing owners; their tests are not platform skips.
* GC/unref/fatal warning scheduling, init/trigger/destroy IDs and frames,
  cancellation/shutdown, realm crossing and OOM/encoding-error resource
  retirement on the actual guest. Native Node dependencies in frontend
  controls do not establish guest behavior.
* Complete memory accounting/limits, large bufferSize handling, unknown-type
  lstat/error races and recursive exceptional cleanup. Pinned algorithm
  inclusion is not sufficient evidence for every lifecycle branch.
* Exact lazy namespace/property metadata, async/error/stack/byte/shared owners
  and all original filesystem requirements not addressed by this slice.
* Four-host identified-artifact validation, unchanged upstream opendir and
  public VFS tests, with failures/skips/unsupported/timeouts/harness errors
  retained. dir-validation-candidates.json catalogs future files only.

The normal targeted wasm32 engine revision67 was accepted in 240.2 seconds,
including the unchanged upstream include/macroassembler/opcode checks, Wasm
optimization and fork instrumentation. Both executables are 47,867,830 bytes,
SHA-256 `07ca8793960ac38506d8bc89f1315efeb1c4e7645f8625a2952fcbf194efdf23`.
All 554 frozen source identities matched after compilation. The report and
executable copies are retained in .context/node26-engine-r67-accepted.
Revision66 also compiled the full native bridge; its earlier report/artifacts
remain retained and explicitly predate the interrupted-batch correction.
Build integration does not establish runtime API behavior.
No overall suite or full product image rebuild ran. Continue independent audited
families after this bounded integration checkpoint.
