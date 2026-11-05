# Filesystem source review

State: **source review complete with gaps**; see [complete contracts](filesystem-contracts.md)
and `filesystem-requirements.json`. This review distinguishes final pinned/native paths
from legacy methods that are still active. No new tests or builds ran.

## Layer and lifetime trace

Bootstrap:2014–2525 initially creates fs and promises. Later replacements
at 2829–2850,3239–3282 install actual native FSReqCallback jobs, selected
stats/sync descriptor algorithms, FileHandle methods and pinned file
streams. They supersede the corresponding earlier wrappers. Native
owners live in `third_party/node-core/native-fs.cpp`, native-file-handle,
native-fs-promise, native-file-jobs and native-work; libc/kernel own the
guest fds, OFDs, VFS metadata, credentials and readiness.

The current readFile path has real asynchronous native work, owned path
and buffer allocation, descriptor handoff and close/error records
(`native-file-jobs.cpp`:1–130). FileHandle refcounts/close and callback
resources are actual owners rather than path reopening. These source
improvements remain uncompiled and unvalidated. A native binding or
syscall's existence is not evidence for every Node overload or error.

| ID | Public requirement | Source finding |
|---|---|---|
| FS-001 | readFileSync supports fd/path, flags, non-seekable files, actual errno and partial reads with cleanup | Active legacy implementation at 2080–2101 accepts paths only, seeks for size, reads once, substitutes ENOENT on open failure and lacks finally around allocation/read. Later asynchronous readFile replacements do not replace this sync function |
| FS-002 | writeFile/appendFile path and descriptor overloads, encoding, mode/flag/flush, errors and async timing | Legacy sync path at 2103–2143 always UTF-8 encodes strings, ignores supplied encoding in conversion, uses truthy mode, accepts arbitrary string coercion. Path promises and callback writeFile remain wrappers around this path; FileHandle writes use a separate pinned implementation |
| FS-003 | readdir/Dirent preserve file types, parentPath, recursive and encoding options | 2018–2031,2145–2168 only classify regular/directory/symlink, return false for other types, omit parentPath and recursive/encoding behavior; lstat error defaults to file. Callback/promises variants share this path |
| FS-004 | Actual access/chown/utimes behavior and errors | accessSync only stats and ignores mode; chownSync stats but ignores uid/gid; utimesSync ignores returned error (2297–2316). These are implementation gaps despite lower guest credential/metadata capabilities |
| FS-005 | Watching change events and actual watch ownership | watch returns listener/ref/close no-ops; watchFile/unwatchFile do nothing (2463–2479). No actual change observation or FSWatcher/StatWatcher semantics |
| FS-006 | Complete public filesystem surface | link/lutimes/opendir/statfs promises are throwing stubs; statfsSync throws. cp/glob/Dir and many public aliases/options are absent or partial. Kernel support must be assessed independently before any boundary is accepted |
| FS-007 | copyFile exclusivity, metadata, atomic create and large/non-regular inputs | 2246–2252 reads whole source and uses exists-before-write for EXCL, leaving a race; ignores most copy mode/metadata and inherits sync read/write defects |
| FS-008 | True async callback/promise timing and resource completion | Only selected descriptor/readFile/stat operations have native jobs. Other methods still do synchronous work before microtask callback or in async wrappers. Promise return alone does not supply Node asynchronous resource semantics |
| FS-009 | Node experimental VFS public create/providers/mount/loader integration | node:vfs factory/activation missing. Internal copied registration state is not the public VirtualFileSystem/Memory/Composable/RealFS/ZipProvider implementation. Kandelo's kernel VFS is a distinct layer, not an equivalent public module |
| FS-010 | Byte path, error/path identity, stable storage and async memory ownership | Legacy _pathToString decodes Buffer paths as text; copied pinned descriptor paths and native paths have distinct validation/storage routes. The complete report records raw path and native pin/lease/GC/failure questions, including explicit shared/resizable rejection |

Exact native I/O close/cancel/GC/failure behavior remains subject to documented questions and later controls, including
fd reuse versus OFD identity, short I/O, seek offsets, concurrent writes,
native memory accounting and teardown. A prior implementation ledger is
not a semantic signoff for this family.

All four hosts share facade gaps; mounted guest filesystems can differ in
persistence, permissions, special-file and watch capability. Each backend
boundary needs concrete operation-specific analysis, not a browser-wide
exclusion. Guest POSIX rights and Node's missing flag-enabled Permission
Model are separate.

Later unchanged upstream fs categories must retain fd/path variants,
streams, watch/stat, directory/glob/cp, VFS activation/providers and real
fixtures. Native controls need pipes/devices, short I/O, invalid byte
paths, permissions/symlinks, races, abort/close/fd reuse, readonly mounts,
failed allocations and GC teardown. Historical artifacts do not validate
the source candidate; no new runtime result is claimed.

The completed source report reconciles all 743 original obligations, final
legacy/native assignments, inherited/returned/provider/stream/Dir/Stats
contracts and actual owning layers. Open questions concern exact native
error/validation/abort/combined-failure/GC/lease/teardown behavior, raw-fd
race applicability, stat/Temporal fields, mount state and later fixture/
flag/backend/four-host conformance. FS-021 records the target VFS promise
open numeric-fd return versus mirrors-fs.promises prose question.
