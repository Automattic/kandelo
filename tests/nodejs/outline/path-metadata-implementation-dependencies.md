# Pathname metadata source owners and remaining dependencies

Current integration checkpoint: the normal targeted engine96 build compiles
the source through95 with guest OpenSSL3.5.9; four focused Node-host
differential controls pass. Current source99 includes metadata97, sync whole-file98 and queued
promise write/append99 owners; these remain guest-uncompiled. Changed kernel/host
and complete four-host conformance remain outstanding. Recipe-stage
compilation statements below describe their historical checkpoints. See
[the current build and evidence record](engine96-integration.md).

Recipe91 adds pathname access/mode/ownership/time source owners. The exact
audited Node26.13.0 source/native pins and frozen audit remain unchanged.
This is an implementation-phase record, not a revision of the audit or a
claim of complete filesystem compatibility. The last accepted guest engine
is88; neither engine91 nor the changed kernel has been built for Wasm.

## Public algorithms and owning layers

The source manifest retains six complete pinned inputs under
third_party/node-core/upstream/path-metadata and hashes21 selected sections.
Eighteen public methods share these owners:

| Operations | Public source | Kandelo owner and behavior |
|---|---|---|
| access/accessSync/promises.access | lib/fs.js and internal/fs/promises.js | path-metadata-adapter.js preserves actual rights checks, overloads and native mode conversion; path-metadata-operations.h calls access rather than stat |
| chmod/chmodSync/promises.chmod | Same pinned public files | Actual chmod mode mutation through the guest POSIX bridge |
| chown/chownSync/promises.chown | Same pinned public files | Actual chown IDs/errors, including -1 preservation |
| lchown/lchownSync/promises.lchown | Same pinned public files | Actual lchown selects the link inode, including dangling symlinks |
| utimes/utimesSync/promises.utimes | Same pinned public files | Pinned timestamp conversion, actual utimensat and propagated errors |
| lutimes/lutimesSync/promises.lutimes | Same pinned public files | Actual utimensat with AT_SYMLINK_NOFOLLOW; no stat/utime imitation |

The private fsMetadataSync/fsMetadataPromise methods are registered by
engine patch0092 and forwarded by the shared SpiderMonkey adapter. Native
native-path-metadata.cpp owns path snapshots, scalar conversion, native
work, actual FSREQCALLBACK/FSREQPROMISE resources and completion scope.
Work executes POSIX calls through the existing queue; it does not enter JS
from a worker. Request cancellation/root retirement share KandeloFsWork.
Raw byte paths are copied using atomic byte reads by the shared KandeloFsPath
owner, with raw bytes retained until error-message decoding. This avoids native
data races; it does not make concurrent writes to a whole pathname atomic.

fs-system-errors-adapter.js ports the pinned native UVException field and
message construction over actual guest errno/libuv error data. The shared
bootstrap _throwErrno relay and truncation makeError owner use it, including
empty paths, raw UTF8 decoding, destination fields and own-property order.
This is a port of native error construction, not unchanged V8 C++ code.
Native access-mode conversion similarly follows pinned GetValidFileMode:
finite fractions truncate before checking the range, without uint32 wrap.
The promise rejection helper has the same explicitly guarded missing-V8
stack-recapture adaptation used by existing owners; assertions are unchanged.

The POSIX path reaches libc, runtime-core sys_utimensat, kernel path and
credential resolution, rootfs/tmpfs or the existing handle-only host mount
contract. sys_utimensat now selects the final link inode for NOFOLLOW,
checks permissions against that same inode, and forwards the existing flags
through hostdir::utimensat/host_utimensat. Host kernel.ts, PlatformIO,
VirtualPlatformIO and backend interfaces retain those flags. NodePlatformIO
and HostFileSystem choose native lstat/lutimes for the nofollow case; the
sandboxed backend permits a dangling final symlink without following it.
No new path-taking host import was introduced. The existing import already
carries flags; no wire signatures/layouts/constants/ABI identity files changed.
This restores required semantics, not a new binary calling convention.

OPFS fchmod/fchown/chmod/chown/lchown/utimensat now report ENOTSUP instead
of silent success. This makes six missing operations truthful; it does not
implement them. A real persistent guest metadata owner is still required.
This is an implementation gap, not an accepted browser-wide limitation.
The ordinary browser guest rootfs/tmpfs routes have their own kernel state
and do not become unsupported because a separate OPFS backend lacks it.

## Evidence and exact limits

Machine-readable identities are in path-metadata-finding-progress.json.

* .context/node26-path-metadata-frontend-r2.json: seven paired public-source
  controls and two actual Node-backed host-adapter inode tests pass (9/0/0).
  Controls cover overload/error fields, callback timing/receiver/ALS/resource
  scope, sync/callback/promise initialization-time snapshots, raw/empty
  paths and real metadata changes. Native Node supplies private request,
  async and filesystem owners. These are not guest bridge or OPFS tests.
* .context/node26-path-metadata-native-r1/report.json: compiled portable
  POSIX owner output matches exact native26 output, including access denial,
  mode/ownership, dangling link selection, actual times and six missing-path
  errors. This exercises the development host's libc, not guest libc/kernel.
* .context/node26-path-metadata-upstream-r1/report.json: eight unchanged
  upstream filesystem files pass in native and adapted modes. Their full
  bodies are verified against the pinned archive. Other filesystem APIs
  inside those files still use native Node; this is scoped frontend evidence.
* Native runtime-core unit job cargo-test--p-1104-232135-295c passes two
  selected kernel tests: actual selected inode/timestamps/flags, dangling
  link behavior, unknown flag rejection and link-versus-target ownership.
  This compiles the native Rust test target with mock host I/O, not kernel
  Wasm. The earlier pre-format run also passed; these are overlapping runs.
* .context/node26-path-metadata-source-r1/report.json: pinned archive/source
  and frozen audit identities, generated bundle/bootstrap syntax, exact
  patch forward/reverse and unchanged Mozilla style checks pass. There are
  28 dependency-ordered native fragments. No engine compile is implied.
* The plain host tsc --noEmit check fails with39 diagnostics outside the
  changed files (browser bundler imports, enum/replay typing and TLS source
  types/rootDir). Its complete log is retained. No whole-host typecheck pass
  or absence of indirect regressions is claimed. An initial invocation used
  a nonexistent compiler path; that harness error is retained separately.

The first frontend run recorded8pass/1fail: a missing captured PromiseReject
turned real promise I/O failures into ReferenceError. The import was fixed,
and original source/generated bundle/controls/logs remain under
.context/node26-path-metadata-first-nonpass. It is not relabeled as passing.
No upstream assertion was weakened or changed.

## Remaining dependencies and breadth work

FS-001/FS-013/FS-017/FS-019 are only partially addressed. The remaining
audited filesystem findings and family obligations stay open. In particular:

* Compile the actual guest binding and changed kernel; validate initialization,
  callback/error/resource/ref/GC/OOM/cancellation/worker and realm ownership.
* Complete kernel signed/pre-epoch timestamps (current stat/VFS fields are
  unsigned), host timestamp precision (Node adapters quantize to milliseconds),
  fd/O_PATH/AT_EMPTY_PATH and full UTIME_NOW/OMIT/error-order semantics.
* Supply persistent OPFS metadata and complete permission/backend capabilities.
  Successful native controls do not validate browser storage behavior.
* Close host-mount raw byte-name identity (FS-022); atomic guest path copying
  does not repair a later host TextDecoder/string conversion.
* Reconcile descriptor/promise namespaces, aliases/descriptors, enabled public
  Node VFS, complete metadata/statfs, links/copy/cp/glob/openAsBlob, file jobs,
  watchers and the rest of the frozen filesystem audit.
* Reconcile shared system-error consumers and their stack/error details using
  actual guest artifacts. The focused relay controls are not all-consumer
  conformance.

All four hosts still lack current combined-candidate conformance. Source91
also contains uncompiled process89 and KDF90, with the unbuilt guest
OpenSSL3.5.9 prerequisite. Overall suites and the full product rebuild remain
deferred. Continue independent audited source work rather than expanding a
deep metadata test campaign before the breadth-first pass is complete.
