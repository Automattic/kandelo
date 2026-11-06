# Directory copy source owner

This slice adds the missing fs.cp, fs.cpSync and fs.promises.cp source routes
at the exact audited Node.js v26.13.0 pin. It does not close FS-016, the
filesystem family, or native callback/exception recovery. The frozen audit
and target/source/native identities remain unchanged.

The complete pinned cp.js and cp-sync.js modules are retained and assembled,
with the pinned public wrappers, lazy-loading/callbackify path and validators.
The sole module-body adaptation guards unavailable stack recapture when a
native directory job fails; engine stack filtering remains unimplemented.
Native GetValidFileMode's null/undefined copy-mode default is supplied at its
binding boundary, including options omitted for an existing destination.

The original CopyDirRecursive, path normalization and containment algorithms
are selected unchanged from the full pinned node_file.cc. Sync preflight and
file overwrite retain their original decisions; generation replaces V8 error
construction with owned native error records. The POSIX source port executes
real stat, mkdir and utimensat, the existing actual descriptor-based CopyPathFile,
and the pinned std::filesystem operations. Its private uv-named shim is not a
libuv ABI or an asynchronous timer facade. Its stat request owns only an inline
native record, so cleanup has no heap allocation to release. No filesystem
state, identity, permissions, bytes or timestamps are invented.

Sync copies retain the pinned merge/canonicalization/mode behavior. A fresh
async destination is copied by one real native worker request; this path uses
exclusive creation and preserves the actual destination-race error, rejects
special entries through the pinned JS error builder, and keeps its lexical
symlink behavior. Filtered/existing-tree/dereferenced async paths retain the
pinned per-entry awaited operations. Running I/O is not pretended to roll back
when its owning environment stops.

native-copy-directory.cpp provides an actual CpDirJob class and private slots,
copied native paths, native async ID/default-trigger/frame ownership, real
FSREQCALLBACK init, an inactive collectible owner and a scheduled native work
root. Worker code enters no JS. Completion resolves ondone before entering its
native callback scope; noncallable properties enter none, getter exceptions
retain the actual exception, and resource/material retirement follows the
callback/checkpoint fence. Existing native work shutdown joins running work
before silent cancellation/root release. No loop/provider phase is replaced.
Native slots, checked receiver unwrapping, owning-realm entry and returned-value
wrapping are source implementations, uncompiled in this slice.

Native state/work and their actual persistent string capacities use the
existing process retained-memory ledger and an existing environment claim;
lookup creates no environment. Inactive GC owns no PersistentRootedObject.
The finalizer only retires native state; the existing async destroy-vector
append can allocate. Transient std::filesystem/std::function implementation
allocations are allocator-owned and not separately projected by this bridge.
Comprehensive primary GC pressure/accounting has not been validated.

Scoped controls run the actual portable owner and actual POSIX worker in a
host component, with native Node fs/Dir/stat/path/errors/callbackify as explicit
dependencies. This is not the guest JSAPI. The component's N-API async context
does not establish weak inactive GC behavior. Its own internal packets define
own elements, matching production dense-array construction. Native C++ error
code assignment intentionally preserves inherited Error.prototype setters.

Sealed evidence is in .context/copy-directory-agent. Sixteen of seventeen
focused comparison groups match (thirteen public/portable and three job
lifecycle groups). The handled callback-throw group is nonpassing: exact Node
emits uncaught then after then destroy; the component emits uncaught then
destroy. Production callback-scope.h likewise skips After when it closes a
failed callback, and the current shell loop lacks process uncaught recovery.
This shared dependency must be implemented separately, not hidden by emitting
After indiscriminately. Two unchanged focused upstream files pass separately
in candidate/native modes. Prior tree-assumption/default-mode failures,
fixture compile failure and two fixture HandleScope SIGABRTs remain retained.

No production JSAPI/engine/guest/package/kernel/product build, sanitizer gate,
whole suite or four-host validation was run. Full internal AsyncWrap prototype
and constructor descriptor fidelity, actual GC/realm/shutdown/cancellation,
exception/recovery/throwing-hook ordering, extreme timestamps/options, locale
and byte-name errors, permission-model activation and enabled VFS/provider
routing remain open. Fs.watch/native notification, promises.watch, statfs,
openAsBlob and backend OPFS metadata are independent gaps. Export presence or
a copied reference is not support evidence.

Skill feedback: porting-software-to-kandelo guidance applied; no skill change
was needed.
