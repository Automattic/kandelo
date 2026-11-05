# Queued whole-file promise writes and appends

Source recipe99 connects full unchanged pinned Node26.13.0 writeFile and
appendFile promise functions to existing native queued jobs and FileHandle
owners. The exact audited source/native pin and frozen audit are unchanged.
Engine96 is still the last accepted artifact; source97–99 and the reconciled
kernel/host candidate are not guest-validated. No engine/package/kernel or
full product build, overall suite, merge or deployment runs in this slice.

## Existing read ownership and corrected accounting

Promise readFile already selected _nodeFileHandles.readFile in source98,
including its actual ReadFileJob and FileHandle continuation. Earlier blanket
statements that all pathname promise whole-file methods used synchronous
wrappers were wrong. The source98 bootstrap before-image and its hash are
bound in `.context/node26-file-promises-source-r1/report.json`. This pass
does not newly implement promise reads or count existing read code as new
compatibility. The historical source98 snapshot remains intact; mutable
current documentation and the implementation ledger carry the correction.

The actual missing paths were promise writeFile and appendFile: the old
bootstrap routed FileHandle inputs to a truncated pinned writeFile function
and pathname inputs back to synchronous wrappers. The truncated function's
manual rejection suffix is now removed. Full source functions, rather than
an argument-dispatch wrapper, are installed on the promise namespace.
Unused early synchronous read/write/append promise fallbacks are removed;
the final owner installation remains authoritative.

## Pinned algorithms and actual dependencies

The existing full lib/internal/fs/promises.js and its exact source hash are
retained. The manifest now selects full writeFile plus appendFile,
writeFileInOneRoundTrip and handleFdSync. All33 selected FileHandle/promise
sections are hash-checked. Public writeFile/appendFile bodies are unchanged.
Private round-trip error helpers retain the existing guarded V8 stack
recapture adaptation; actual engine Error stacks remain available, and
exact stack diagnostics remain an unresolved integration requirement.

Small non-iterable unflushed writes use the real native WriteFileJob shared
with callbacks: actual open/write/close, owned path/bytes, FSREQCALLBACK
identity, worker completion and resource retirement. No new C++ job or
stand-in AsyncResource is introduced. Public validation, small-job abort
checks before/after native completion and Promise settlement follow Node.

Large, iterable and flush pathname writes open an actual FileHandle and
use the existing queued descriptor-promise operations. Full pinned code
chunks actual bytes, consumes sync/async iterables, checks aborts and owns
handle ref/unref, sync and close behavior. The existing handleFdClose helper
preserves an operation error and aggregates a close error when applicable.
Caller-supplied FileHandles keep their descriptor ownership and offsets.
The target's existing FileHandle branch returns before pathname flush
handling; no additional flush or close behavior is invented for that path.
appendFile copies options and applies the pinned append flag default.

The adapter now supplies WriteFileJob and the already existing copyObject
utility to these selected source functions. Its native FileHandle, I/O,
queue, error and byte dependencies are otherwise unchanged. Permission
activation and public VFS remain incomplete; default-disabled state does
not establish the enabled branches. No syscall, host protocol, platform
identity or external ABI changes are made.

## Focused evidence

`.context/node26-file-promises-frontend-r1.json`:6new controls pass.
Five compare actual output/errors/settlement, bytes/modes/frozen options,
flush/iterables, caller-handle offsets and async resource/context behavior
against the pinned native reference. One routing control observes actual
native small jobs and descriptor/sync operations. The fixture uses the
complete pinned public FileHandle source and shared job facade with real
native26 jobs, backing stores, fds and Promise resources. Buffer, events,
streams and the native boundary remain actual native dependencies; this
is not current guest JSAPI/libc/kernel or complete combined conformance.

`.context/node26-file-promises-affected-r1.json`:11existing callback-write
and sync-file controls pass. Counts overlap earlier checkpoints; these are
not eleven additional completed APIs. No focused run in this slice failed.
Earlier unrelated failures remain preserved in the ledger and snapshots.

Four unchanged files pass in candidate and native modes:

- test-fs-promises-writefile.js
- test-fs-promises-file-handle-append-file.js
- test-fs-write-file-flush.js
- test-fs-append-file-flush.js

Report: `.context/node26-file-promises-upstream-r1/report.json`.
The candidate preload installs the public open/read/write/append promise
owners and uses actual native dependencies. Other sync/callback/fs branches
in these mixed files remain native, not candidate compatibility passes.
The public read owner is existing implementation, not new work in99.

`.context/node26-file-promises-source-r1/report.json` verifies all33 pinned
sections, four test identities against the original archive, frozen audit,
target/native-source coherence, the existing98 read route, generated bundle
and bootstrap syntax, evidence registration and whitespace. These source
checks do not compile or execute the changed guest candidate.

## Remaining work

Current97–99 engine source and the reconciled host/kernel candidate need
later targeted integration and identified-artifact evidence on all four
hosts. Full native backing-store leases, shared/resizable/transfer/reentry
ownership and cancellation/GC/OOM/realm/fatal/worker/ref/close-error races
remain open. Actual guest FileHandle, stream and event dependencies are
not validated by native-boundary controls.

Complete promise namespace/descriptors/aliases, enabled permission/public
VFS, other filesystem operations/backend/raw-byte metadata and all remaining
families still require implementation and conformance. Existing SQLite
public-load, Performance milestone and host typecheck nonpasses are retained.
Overall suites and full product rebuild remain deferred. This source slice
does not complete the filesystem family or the overall compatibility goal.
