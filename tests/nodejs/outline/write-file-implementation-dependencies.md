# Callback whole-file write ownership and remaining file jobs

Current integration checkpoint: the normal targeted engine96 build compiles
the source through95 with guest OpenSSL3.5.9; four focused Node-host
differential controls pass. Current source99 includes metadata97, sync whole-file98 and queued
promise write/append99 owners; these remain guest-uncompiled. Changed kernel/host
and complete four-host conformance remain outstanding. Recipe-stage
compilation statements below describe their historical checkpoints. See
[the current build and evidence record](engine96-integration.md).

Recipe95 implements callback writeFile/appendFile source and a real guest
WriteFileJob. This advances FS-001/FS-013/FS-015 in scope, not complete
filesystem compatibility. Exact Node26.13.0 pins and frozen audit remain
unchanged. The accepted engine is88; the new C++ job and combined source95
have not been compiled or validated on the four hosts.

## Public source and actual operations

fsCallbacks selects unchanged writeAll, writeFile and appendFile from the
already-pinned full lib/fs.js. Existing shared option, abort, callback,
validation and copy helpers remain the same owners. The public wrappers
preserve byte encodings/views, callback/option validation order, mode zero,
append option copies, user fd ownership, flush and abort/error precedence.
They replace synchronous callbackify wrappers for these two operations.
They do not replace sync readFile/writeFile/appendFile or path promises.

file-jobs-adapter.js supplies WriteFileJob over actual private native
registration in patch0094. native-file-jobs.cpp creates a real FSREQCALLBACK
resource and copied pathname, retains the data owner, enters the shared
work queue and publishes its actual completion in the original async scope.
The worker consumes native metadata captured on the JS thread and pinned/
owned byte ranges; it never reads GC slots or calls JS. Context teardown
joins running work before releasing storage, and canceled queued jobs suppress
callbacks like the pinned native WriteFileJob.

write-file-operations.h implements actual open/write-all/close through guest
libc/kernel/VFS, with close-on-exec and EINTR handling. It closes its own fd
after success or write failure; a write error takes precedence over a later
close error. Open errors retain pathname bytes for the shared UTF8 error
owner, while write/close errors have no fabricated pathname. Exclusive open
uses the actual atomic flag. Flush writes and supplied-fd writes use the
public target's existing open/write/fsync/close callback sequence rather
than a sync helper or pathname reopening.

Resizable view bytes are copied after resource init, matching the target's
native constructor order. Regular views use the shared native pin at dispatch
and stay rooted until completion/cancellation. This is incomplete backing-
store compatibility: required shared/external-pin/detach/transfer/reentry and
exact capture-time behavior still need the common lease/engine owner.
Rejecting a required input or preventing a target-allowed detach is an
implementation gap, not a platform exclusion or passing compatibility.
The public Permission Model remains default-disabled/rejected on activation;
real kernel permissions still apply. Its missing activated policy is not
implemented by this job.

## Scoped evidence

Exact identities are in write-file-finding-progress.json.

* .context/node26-write-file-frontend-r2.json: five controls pass with actual
  native Node job/descriptor/backing-store/ALS/resource dependencies. They
  cover encodings, DataView/typed input, mode zero, real errors, validation/
  abort phase, flush, unchanged frozen append options, retained user fd,
  callback receiver/scope and resizable capture after init/before shrink.
  These do not run the new guest C++ pin or copy implementation.
* .context/node26-write-file-native-r1/report.json: one compiled portable
  owner output matches native26 callback jobs for actual contents, append,
  empty/truncation and exclusive/readonly/missing-parent/directory failures.
  It uses the development host's libc, not guest libc or kernel. Short-write,
  close-failure precedence and guest cancellation are not proven by this
  finite set of real file operations.
* .context/node26-write-file-upstream-r1/report.json: four unchanged files
  pass in native and adapted modes with0fail/skip/timeout/harness errors.
  Only callback write/append are substituted. Sync/promise branches and
  descriptor/queue/backing-store dependencies remain native controls. The
  preload shares the real fs object, so public method overrides affect the
  selected wrappers as they do in production; no assertions are changed.
* .context/node26-write-file-source-r1/report.json: pinned public inputs and
  unchanged test bodies, frozen audit/target, generated bootstrap syntax,
  exact patch forward/reverse, unchanged Mozilla source/style and evidence
  registration checks pass. No guest compilation is implied.

The first five-case frontend run predates a fixture refinement to share fs
for upstream public overrides; its raw result is retained separately. The
current rerun verifies the final fixture. These are overlapping source
controls, not ten new cases or unique API/family/four-host scores.

## Remaining dependencies

* Compile actual source95/guest OpenSSL dependency and changed kernel, then
  verify native JSAPI/queue/ref/GC/realm/worker/cancellation/OOM/fatal/error
  and fd/byte lifetimes across all four hosts. Last accepted88 does not
  contain this code or the source89–94 additions.
* Complete backing-store leases and target-compatible capture/detach/resize/
  shared/external pin semantics, including async-init/run reentry.
* Replace legacy readFileSync/writeFileSync/appendFileSync with exact public
  algorithms and real UTF8 binding operations. Their fd/encoding/error/
  allocation/short-I/O/cleanup issues remain. Callback progress does not
  repair them.
* Complete path fs.promises write/append, iterable/abort/flush/FileHandle
  routing and native WriteFileJob promise ownership. Descriptor FileHandle
  write owners are separate existing paths.
* Complete all other file-job, permission, namespace, watch/copy/link/VFS,
  raw host byte-name and filesystem audit obligations. The retained
  Performance milestone/SQLite failures and other-family gaps remain open.

There is no new wire ABI layout/import/signature or identity change: the
registration and request fields are private to the packaged engine. This
source review does not establish whole-product ABI conformance. Full product
rebuilds and overall suites remain deferred; continue independent audited
source work rather than expanding a deep write-file test campaign.
