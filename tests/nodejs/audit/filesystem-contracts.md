# Filesystem, descriptor, FileHandle and public VFS contracts

Source review: **complete with gaps** for all 743 original filesystem-family
obligations: 351 documentation sections and 392 native descriptor observations.
The source ledger adds inherited, returned, symbol, descriptor and source-exposed
contracts not bounded by that inventory. Implementation completeness and current
four-host runtime conformance remain unestablished. No tests, runtime probes,
compilations, package builds or product rebuilds ran.

The exact Node 26.13.0 source/reference pin remains unchanged. The candidate
is unbuilt. [Source correspondence](filesystem-source-correspondence.json)
checks four full stored filesystem source files against the exact pin and all
102 declared selected slices. It records actual build-recipe transformations;
the recipe was read, never executed, and the bundle was not regenerated.
Unchanged stored code is not proof that every function in that file is selected,
that injected native state is correct, or that compiled/runtime behavior conforms.

## Final implementation ownership

Initial fs/promises initialization is bootstrap:2014–2525. Actual replacements
at 2831–2850 and 3242–3280 supersede selected earlier methods; both paths remain
in production. The family must not be described as wholly synchronous or wholly
replaced by pinned Node code.

| Public/returned surface | Actual final route and required behavior |
|---|---|
| fs constants | Native generated getFsConstants uses pinned Node/libuv constant definitions with actual guest SDK macros, readonly/permanent property installation. No Linux identity is required. Complete conditional values, missing SDK capabilities and current compiled artifact remain explicit. The separate node:constants aggregate is independently incomplete. |
| open/read/write/readv/writev, stat/lstat/fstat, fchmod/fchown/futimes/fsync/fdatasync callbacks | Selected unchanged public argument/overload/callback/custom-promisify algorithms dispatch actual FSReqCallback resources via fs-callback-adapter. Actual native jobs carry buffers/path/status and completion scope; they are not Promise wrappers posing as callback requests. Buffer/string encoding/errors/async/native state dependencies still have gaps. |
| Corresponding sync descriptor/stat APIs | Selected fs-utils/fs algorithms and native fsOpenSync/fsIoSync/fsVectorSync/fsStatSync/fsControlSync. Actual short I/O, offsets, stat scalars and errors; this does not replace path readFileSync/writeFileSync or all pathname operations. |
| truncate/ftruncate/close, sync and callback | Actual copied public validation and close/truncate owner via fs-truncate-adapter/native-fs. Path truncate uses open/ftruncate/close and real error composition; native descriptor operations are not path reopening aliases. |
| fs.promises open/readFile/stat/lstat/truncate | Actual selected FileHandle/promise/native ReadFileJob/stat/truncate paths. Open yields a returned FileHandle, not an invented fs.promises.FileHandle constructor export. Complete API/default/options/errors/abort/ref/GC scope remains required. |
| fs.promises writeFile/appendFile | FileHandle arguments select actual descriptor write algorithm; other arguments retain legacy path wrappers. The FileHandle branch intentionally rejects unsupported non-handle input in its internal selected excerpt. That rejection does not supply the public path implementation. |
| FileHandle | Actual EventEmitter subclass, private brand/ref/close state, native owned fd and descriptor read/write/vector/stat/truncate/chmod/chown/time/sync, readFile/writeFile/appendFile, readLines, Node streams and byte Web stream. Shared stream/encoding/readline/error/scheduler dependencies remain. Transfer registration and private destructive transfer hooks were deliberately removed because actual fd movement/rollback is missing; transfer is not implemented. |
| Stats and returned BigIntStats | Actual copied StatsBase inheritance, seven mode predicates, scalar/Date/nanosecond/Temporal Instant getters and descriptors over real native stat fields. Deprecated public Stats constructor uses real deprecator. BigIntStats is a returned owner, not a required own fs constructor export. Birthtime/native scalar limits remain per-field questions. |
| ReadStream/WriteStream and FileReadStream/FileWriteStream aliases | Actual pinned shared stream constructors/factories and distinct lazy accessor state; FileHandle stream operations share those constructors. Real open/ready/read/write/vector/flush/destroy/close state, pending and byte counters, autoClose/emitClose and custom fs options. Underlying Buffer copy/codec/native lease/async/permission and owner errors remain dependencies. |
| readFileSync | Still legacy std.open/seek/tell/single read path. No numeric fd overload, faithful open errno/flags/nonseekable/changing file/short read handling or complete cleanup. Async readFile replacement does not repair it. |
| writeFileSync/appendFileSync and remaining callback/path promises | Legacy path-only conversion/open/write loop, partial flags/modes, strings always UTF8, arbitrary nonbytes String conversion, missing flush/signal/iterable/data overloads. Callback and async wrappers do synchronous work; FileHandle routes are different actual owners. |
| readdir/Dirent/opendir/Dir | Custom readdir and Dirent only classify file/directory/symlink; other kinds false, lstat failure defaults to file, parentPath/encoding/recursive behavior absent. opendir promise throws; real Dir queue/iteration/close/read/recursive/buffer/dispose lifecycle missing. Stats mode predicates above are real and must not be conflated with these Dirent stubs. |
| access/chown/utimes and links/metadata | Path access only stats/ignores requested rights; chown only stats/ignores ids; utimes ignores failure and adapter missing function returns success. Descriptor fchown/futimes are separate real native operations. link/lchown/lutimes and complete byte/URL/encoding/error/flags/platform variants remain missing/partial. |
| mkdir/rmdir/rm/unlink/copy/rename/temp | Actual partial pathname operations with concrete semantic gaps below. Recursive operations are not atomic or complete merely because they call real kernel primitives. |
| watch/watchFile/unwatchFile and returned FSWatcher/StatWatcher | No actual observation: listener/ref/close facades or no-ops. Promise watch AsyncIterator/options/overflow/abort/return/resource ownership missing. Local polling or notifications need a real owning implementation. |
| cp/glob/statfs/openAsBlob/mkdtempDisposable and advanced public APIs | Missing/throwing/incomplete public integrations despite some lower operations existing. cp requires actual traversal/filter/link/metadata/exclusive policy; glob actual async/sync walking and options; statfs exact numeric/BigInt records; openAsBlob real file-backed lifetime/change checks; disposable temporary dirs require actual removal/async disposal. |
| fs.promises/global aliases and callable descriptors | Same actual promises object is used by builtin fs/promises, but custom data properties/constructor aliases, native aliases, symbol/custom-promisify/descriptor/receiver behavior must match the exact source. Do not manufacture nonexistent public classes from returned objects or source-private helpers. |
| node:vfs | Default absence without --experimental-vfs is correct. Enabled node:-only module, constructors/providers/registration/mount/loader/public fs integration absent. Kandelo kernel VFS and copied internal vfsState are different owners and do not implement the public Node module. |

Sources: fs-{truncate,stats,callback,handle,streams}-adapter.js,
file-jobs-adapter.js; native-fs.cpp, native-fs-promise.cpp,
native-file-handle.cpp, native-file-jobs.cpp and native-work.cpp under
third_party/node-core. The requirements ledger retains exact source/range/
capture identities; public docs and target lib/fs.js, internal/fs/{promises,
utils,streams,dir,watchers,glob,cp/*}.js define the complete obligations.

## Actual native resource, byte and completion lifetimes

Native resources have actual class/receiver state, async id/frame/provider,
reserved roots and deterministic retirement (native-fs.cpp:7–107,145–234).
FSReqCallback, FSReqPromise, FILEHANDLE and FILEHANDLECLOSEREQ are distinct
actual owners. Complete releases I/O leases, settles handle close state,
prepares results and enters the original async callback scope. It retires and
clears callback/frame/parent/promise/buffer/result roots even if a callback
throws. Teardown uses a separate silent Cancel path. Native jobs and JS wrappers
still depend on correct shared errors/async/fatal/Promise behavior.

native-work.cpp:224–375 owns queued/running/completed counts, roots and pins.
Workers call libc and never enter JS or manipulate GC roots. Queued cancellation
produces real ECANCELED completion; running work finishes before roots/pins are
released. Shutdown cancels queued work, joins running ownership and suppresses
JS callbacks. Reentrant dispatch does not keep the loop alive just by waiting
on itself. Existing native pthread/work-queue host differences and teardown
require actual four-host evidence; source state is not conformance.

Scalar/vector I/O uses real read/write/pread/pwrite/readv/writev calls and
EINTR/short-result handling; positional BigInt/int64 and current-position
sentinels differ from public validators and must retain exact target conversion.
Vectors honor actual IOV_MAX, at most one read batch, write-all partial progress
and later-error precedence. Native spans are derived from real intrinsic view
bytes, checked again after Promise init hooks, and pinned/rooted until completion.
An empty vector's target rejection/callback lifecycle must be reviewed at the
public caller: a native binding rejecting empty IOV does not mean public APIs
that bypass it should fail.

Pins reject SharedArrayBuffer, resizable views, detached buffers and externally
owned pins (native-work.cpp:322–365). Fixed regular buffers share canonical
backing-store identity/refcounts, non-inline storage and an actual engine length
pin, released on the owning JS thread. These are real safety/lifetime operations.
Their rejected required inputs remain **implementation gaps**, not proof an
engine cannot support them. A shared/cross-context lease protocol is absent.
Native file operations hold fd numbers; closing/reusing a raw fd before an
operation finishes needs target applicability and ownership controls. Do not
invent a stronger fd/OFD guarantee than the public API promises.

FileHandle private JS refs defer close until calls/streams complete. Native
close returns the cached actual promise, adopts a real close request and marks
fd invalid after the operation; queue handoff failure rolls closing state back
(native-file-handle.cpp:34–67). Native GC closes an abandoned fd synchronously
without JS, queues an owned diagnostic record, and the JS immediate later throws
the target FileHandle GC error (native-fs.cpp:27–35; fs-truncate-adapter:49–71).
FileHandle GC and Dir GC have different target policies; see DEP0137/0200.
Transfer remains missing despite real normal close and ArrayBuffer transfers.

Path readFile native job copies actual path bytes and owns allocation/open/fstat/
read/close. Regular oversized files hand off the same open fd, not a reopened
path, to the selected JS continuation. Unknown-size reads grow owned storage;
close errors are retained separately. Result ArrayBuffer adopts actual storage,
transfers memory accounting and builds a Buffer-prototype view before callback
entry (native-file-jobs.cpp:6–108). Allocation/prepare-result failures, handoff,
abort/close/combined-error precedence, unknown-size limits and tearing down a
blocked read remain explicit native questions rather than assumed success.

Stat records use actual guest libc struct stat and 18-value Number/BigInt scalar
ordering, not host struct layout (native-fs-promise.cpp:338–357). Birthtime uses
ctime fallback because this stat interface lacks a creation field. Kernel
sys_statx:7898 delegates to fstatat/WasmStat and does not itself establish a btime
capability. This is a concrete current interface limitation, not acceptance of
every metadata deviation or proof birthtime can never be represented. Date/
Instant fields, precision, unsigned values and backend times need per-field
controls. Temporal getters must throw the target ERR_NO_TEMPORAL when absent,
not invent a timestamp; normal Stats getters and predicates are implemented.

File streams use actual kIsPerformingIO/kIoDone guards before closing pending
operations (fs-streams.js:276–335,504–561), real partial-write/vector retries,
FileHandle refs, flags/offsets/flush/custom fs and Readable/Writable inheritance.
They still inherit Buffer slice/copy/encoding issues and async/native lease gaps.
FileHandle.readableWebStream is the actual byte stream algorithm with lock,
BYOB/min/ref/EOF/cancel/autoClose; the adapter supplies the selected Node Web
Stream owner, not the retained old ponyfill. Complete Web/stream findings apply.

## Concrete findings beyond the initial survey

FS-001–010 remain as clarified by the final routes above.

| ID | Source-backed gap/question | Layer/prerequisite |
|---|---|---|
| FS-011 | Async native Pin explicitly rejects shared/resizable/external-pin inputs even when public Buffer/TypedArray/DataView contracts accept corresponding views. Stable regular pins and deterministic unpin are real, not complete byte ownership. | Native/engine backing-store leases and public input semantics; no established engine defect |
| FS-012 | rmSync force suppresses any initial lstat/removal error and can ignore failed recursive readdir (bootstrap:2203–2231), whereas force only suppresses missing paths. mkdirSync recursive can skip an existing non-directory, returns requested path rather than first-created/undefined and uses mode||0777. | Real validation/traversal/error/retry/permission and return-value ownership |
| FS-013 | Legacy _callbackify pops the last argument without validating a callback, runs syncFn immediately and drops errors without a callable callback (2359–2370). fs.exists calls its callback synchronously. Promise wrappers around sync work do not provide native async completion or correct missing-callback rejection. Selected native callback APIs are separate real paths. | Callback/overload/throw-versus-queue/async-resource/error scope |
| FS-014 | rmdirSync and unlinkSync both use os.remove; adapter:338 forwards shellFile.remove, patch0012:147–170 calls C remove(), which can remove files or directories. Thus rmdir can delete a regular file and unlink can remove an empty directory instead of the correct operation-specific failure. | Distinct libc/kernel unlink/rmdir APIs, type/path/errors |
| FS-015 | writeFileSync opens fd before data String/TextEncoder conversion but starts finally only after conversion (2103–2143); conversion/allocation failures can leave it open. Async ReadFileJob/descriptor owners do not repair that legacy path. | Transactional descriptor ownership and byte/conversion failure paths |
| FS-016 | copyFile EXCL is exists-before-write race and reads entire source; mkdtemp uses Math.random suffixes, partial options/encoding and no disposable owner; native aliases/advanced cp/glob/openAsBlob/statfs/Dir integrations absent. Required semantics cannot be inferred from available kernel primitives. | Atomic open/creation/byte/traversal/data-lifetime and correct API surface |
| FS-017 | Number/BigInt Stats have real mode/date/Instant inheritance, but backend precision, ctime-as-birthtime, signed/unsigned ranges and actual Temporal capability need explicit decisions. The current stat ABI and no-btime statx path do not justify arbitrary fake metadata. | libc/kernel stat records/backend clocks/engine Temporal and values |
| FS-018 | Public VFS enabled module/providers/fd/Dir/stream/watch/mount/loader routing/SEA/ZIP integration missing. Internal registration state exists but has no public installer/complete dispatch closure. Default unflagged absence is correct. | Full public virtual filesystem owner, actual loader and selected fs dispatch; not kernel VFS identity |
| FS-019 | Node host-backed mounts and browser OPFS differ by operation. OPFS direct link/symlink/readlink throw ENOTSUP, chmod/chown/lchown/utimensat are no-ops (opfs.ts:304–332); those no-ops are not successful guest metadata conformance. Shared kernel image/tmpfs can support distinct POSIX semantics. readonly is described as advisory in default-mounts.ts:10–12; exact mounted backend enforcement cannot be assumed. | Backend metadata/capability/error/permission/persistence ownership; no browser-wide exclusion |
| FS-020 | The generated promises namespace includes raw-fd sync-wrapper exports such as close/read/write/fstat/fchmod/fchown/futimes/fsync/fdatasync, whereas target fs/promises exposes descriptor operations on returned FileHandle. Extra callable exports, incomplete realpath.native aliases and fs.promises data-versus-getter descriptors need exact namespace reconciliation; they are not required new APIs. bootstrap:2484–2522; target lib/internal/fs/promises.js exports. | Module exposure/aliases/descriptors and actual returned FileHandle ownership |
| FS-021 | Target VirtualFileSystem.#createPromisesAPI open calls provider.openSync then openVirtualFd and returns a numeric virtual fd (file_system.js:1337–1341), while documentation says its namespace mirrors fs.promises. Do not silently require a native FileHandle from this source or change the target; record exact enabled native return/close/interop controls as a target contract question. | Exact target source/prose reconciliation and virtual fd/router lifetime |
| FS-022 | Kernel host_openat passes raw component bytes, but host kernel.ts:3865–3885 decodes them with default nonfatal TextDecoder, then VirtualPlatformIO.openat and FileSystemBackend take strings. Invalid UTF8 components can map to replacement-character names on host-backed mounts. Native raw path copying is insufficient for end-to-end identity; kernel tmpfs byte-name maps are a different route. | Host/kernel/backend byte component contract, not an inherent browser/engine limit |

## Public Node VFS and returned provider contracts

Target node:vfs is node:-only and gated by --experimental-vfs. Its public create
factory, registerProvider and vfsBase plus VirtualFileSystem, VirtualProvider,
MemoryProvider, ComposableProvider, RealFSProvider and ZipProvider are distinct
from guest kernel VFS. The default provider supports actual memory-tree symlinks
and watching, not merely a readonly map. Custom provider defaults throw
ERR_METHOD_NOT_IMPLEMENTED and reject readonly writes with EROFS; derived
methods, capability getters and returned virtual handle/Dir/watcher lifetimes
are requirements. Provider registration uses newest-first canHandle/create and
built-in directory/ZIP fallback. This is not an access-control sandbox.

Mounted paths live in a reserved root under path.join(os.devNull,'vfs'), do not
shadow a real disk namespace or fall back to disk on missing mounted paths, and
bound package-scope/node_modules ascent at the mount point. Absolute imports
can cross the boundary; legacy global CJS folders retain their documented rules.
Module hooks, fs callbacks/promises/sync/descriptor/stream/watch routing and
unmount/disposal/active resources need actual shared ownership. --vfs-load,
registered providers and SEA archive activation are separate CLI/native owners.

RealFSProvider validates root/path/symlink mapping without becoming a sandbox;
ZipProvider uses actual ZipBuffer/ZipFile state, writable policy and close-time
member commit, explicit/implicit directories and sync/async codec lifetime.
VFS Stats' documented synthetic stable device/inode/block/time rules are
legitimate provider-owned state, unlike arbitrary fake physical filesystem
measurements. Full source member declarations in the ledger cover APIs listed
in prose, inherited provider methods, returned handles and symbols, not only
37 section headings. None are claimed implemented by the candidate.

## Kernel/host boundaries, evidence and later validation

Real libc calls reach guest syscall dispatch, fd/OFD tables, credentials, path
resolution, rootfs/tmpfs and configured host mount. Runtime-core syscalls.rs
implements ftruncate:20062, fsync/fdatasync:20193–20246, metadata/link/utimens
operations at 11290,20638–20812 and statfs at 21250. Kernel wasm_api.rs routes
these; fsync on nonpersistent in-kernel memory legitimately succeeds without a
host disk flush, while host-backed mounts call their actual backend flush.
That valid memory-filesystem behavior is not a blanket allowance for no-op
metadata. statfs has real mount-specific kernel/host data even though the Node
public binding is missing. Kernel capability must not become invented Node
success or be overlooked because the guest is inside a browser.

FS-022 adds a concrete end-to-end byte-path gap: the guest kernel passes raw
component bytes, but host kernel.ts:3856–3895 uses nonfatal TextDecoder before
calling the string-based VirtualPlatformIO.openat at vfs.ts:593. Different
invalid byte names can be reinterpreted as replacement-character names; this
is not byte-preserving access. Even a backend restricted to Unicode names
needs truthful rejection instead of silently accessing a different name.
Kernel tmpfs stores byte-name maps (tmpfs.rs:165–167), so this finding must
not be generalized to every guest filesystem route. Exact source excerpts
and hashes are in filesystem-raw-path-source-evidence.json.

Node HostFileSystem uses actual host fd I/O and guest metadata routing; OPFS
uses its actual worker/channel. Four hosts share the reviewed guest facade/native
source, while launch/waits/teardown, configured persistent mounts and host route
capabilities differ. FileSystemBackend's concrete interface is not proof every
implementation supplies all operations. Kernel rootfs/tmpfs, mounted HostFS and
OPFS are separate applicability axes; browser engine alone does not select all
filesystem behavior. Backend no-ops and missing native/public bindings remain
implementation gaps until justified per concrete operation/model.

Existing baseline/selected evidence remains tied to its archived source/artifact/
host identities. Most baseline failures stop in common/index before testing the
named filesystem case. Older narrow results do not validate unbuilt native source.
All failure/skip/unsupported/timeout/harness-error/pending classifications remain
unchanged. No new current four-host conformance is established.

After explicit authorization, unchanged target sources and exact native controls
must cover path/fd/URL/raw bytes, callbacks/promises/sync and custom promisify,
Stats/Dirent/Dir/streams/FileHandle inheritance/brands/descriptors/symbol aliases,
short scalar/vector I/O/BigInt offsets, shared/resizable/detached/view mutation,
fd close/reuse/OFD concurrency, FileHandle ref/close/GC/transfer, stream destruction,
path/readFile job handoff/unknown sizes/abort/combined errors, permissions/modes/
links/recursive copy/remove/glob/watch/statfs/temp/disposal and enabled VFS/provider/
loader/SEA/ZIP behavior. Use actual pipes/devices/races/failure/GC/native fixtures,
all supported mount types, real flags/resources and per-host artifact identities.
The future catalog includes helpers/resources and is not an executed denominator
or completed fixture/variant/native applicability closure.

Open audit questions: target error/validation/descriptor/async/abort/combined-error
precedence, every native OOM/cancel/GC/teardown branch, raw fd racing ownership
applicability, current byte lease and stat/Temporal metadata decisions, mounted
backend readonly/metadata/persistence limits, full unchanged fixture/flag closure
and all current four-host results. These do not authorize fixes, probes or builds
and do not prevent finishing the remaining broad values-family source audit.

Source-inventory corrections retain earlier observation IDs: Dirent name and
parentPath are own returned fields, not required prototype properties. The
VFS promise namespace is the actual 27-method source object, not every fs
callback/descriptor method. Earlier inferred exists/ftruncate/opendir/close/
read/write/fstat labels are explicitly non-API observations; they must not
lead a later implementation to manufacture those own namespace exports.
