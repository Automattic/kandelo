# Synchronous whole-file ownership

Source recipe98 installs the unchanged pinned Node26.13.0 algorithms for
fs.readFileSync, fs.writeFileSync and fs.appendFileSync. The exact audited
source/native target remains unchanged. These are source/native-boundary
controls; engine96 is still the last accepted guest artifact. The source97
metadata and source98 changes have not been guest-compiled or validated on
all four hosts. Overall suites and full product rebuilds remain deferred.

## Source and actual owners

`third_party/node-core/sources.json:fsWholeSync` selects nine exact sections
from the already retained full lib/fs.js: three public functions, file-type
inspection and five read/allocation/cleanup helpers. The bundler checks the
full file and every section hash. No upstream assertion or selected public
function body is changed. The bootstrap's three old wrappers now delegate to
`file-sync-adapter.js`; the new input is declared in the engine recipe.

The shared existing Stats utilities supply options, flags, paths, caller
buffers/factories and errors. General paths retain the target's replaceable
public fs operations. Private UTF8 binding paths instead use actual native
open/read/write/close primitives, private byte allocation, encoding and
replacement decoding. They do not consult mutable public fs/Buffer methods,
Buffer species or public Array iteration for private chunk ownership.
No second native file-I/O implementation or guest/host shortcut is added.
The shared private codec exposes encodeUtf8 for this consumer.

Reads continue to actual EOF, including unknown-size files and supplied fds.
UTF8 is decoded once after joining real owned chunks, preserving split
multibyte sequences, BOM, NUL and malformed-byte replacement. Generic reads
retain pinned caller-buffer/factory sizing, aliases and cleanup behavior.
Writes preserve actual bytes, flags, file modes and caller-fd offsets.
appendFileSync copies options instead of mutating frozen caller input.
The pinned UTF8 write fast path validates flush but does not call fsync;
the selected generic path does. That exact target behavior is retained,
not a new promise of durability.

Input conversion precedes opening a pathname. After opening, allocations,
reads, decoding and writes are inside fd cleanup protection. Caller-owned
fds remain open on success and failure. A focused injected failure control
verifies that actual development-host fds are closed when allocation or
decoding throws. This addresses the source defect in FS-015 without
establishing complete filesystem or guest resource conformance.

The native synchronous I/O primitive now admits signed int32 descriptors
at its private boundary and lets actual POSIX read/write report errors.
Public descriptor wrappers retain nonnegative validation; fstat retains
that validation too. This distinction is observable: UTF8 whole-file paths
pass signed fds to native I/O, whereas generic descriptor paths validate
before calling it. This small C++ extension is still uncompiled. No kernel
import, syscall, host protocol, platform identity or external ABI changes.

## Focused evidence and retained nonpasses

Final frontend report: `.context/node26-file-sync-frontend-r6.json`.
Six new controls pass: five focused behavioral controls and one actual-fd
cleanup control using explicit allocator/decoder failure injection. Fourteen
affected callback-write/Buffer-codec controls also pass. These20 controls
are not20 APIs or a compatibility percentage. Earlier overlapping passing
runs remain historical evidence, not additional distinct cases.

The default fixture uses complete candidate Buffer/codec/allocation source
with actual native26 allocator and descriptor dependencies. It does not run
the new guest C++/libc/kernel path. The private-byte tamper control replaces
public fs methods, Buffer static/prototype methods and Buffer species;
actual UTF8 reads/writes still succeed through the private owners.

Four unchanged upstream files pass in native and candidate modes:

- test-fs-write-file-sync.js
- test-fs-append-file-sync.js
- test-fs-readfile-utf8-fast-path.js
- test-fs-readfile-buffer-option.js

Report: `.context/node26-file-sync-upstream-r3/report.json`. This preload
keeps the actual native public Buffer and other async/promise/fs operations;
it substitutes the three public sync functions and uses candidate private
codec/allocation owners over native26 I/O. Mixed native branches are not
candidate passes. Exact test bytes are checked against the pinned archive.

The first frontend run aborted in the control fixture: private native
WriteBuffer was called with5 arguments instead of its required7. The log,
report and exact fixture remain retained as a harness error; individual
Vitest status fields do not turn that aborted process into passing cases.
The second run recorded4pass/1fail because generic native bindings rejected
negative fds before reaching POSIX. The fixture now uses the actual pinned
UTF8 native bindings for that signed-fd differential. No errno is invented.
The exact failed outputs and earlier fixture inputs remain retained.
A preparation script also stopped on an overly broad source selector;
its guard failure is retained separately as a preparation harness error.

Final post-main source report: `.context/node26-file-sync-source-r3/report.json`.
The frozen audit/target, all nine selected sections, four upstream files,
generated bundle/bootstrap syntax, evidence registry, private native unity
and Mozilla's unchanged style checker pass their source checks. None is a
substitute for compiling or running the changed guest owner.

## Remaining implementation and validation

Correction: in source98, pathname promise writeFile/appendFile still used
legacy synchronous fallbacks; promise readFile already selected the queued
read owner. Source99 now connects the full pinned write/append functions to
actual job/FileHandle dependencies. Full guest ownership and conformance
remain separate requirements; see [promise ownership](file-promises-implementation-dependencies.md).

Full byte leases, shared/resizable/transfer/reentry ownership, public VFS
activation, permission enforcement, metadata/backend/raw-byte paths,
watch/copy/link/statfs/temp/loader/namespace and other filesystem findings
remain open. Huge allocations/string limits, exceptional close-error
precedence, unknown-size concurrent changes, actual guest pipes/devices,
GC/OOM/realm/lifecycle and four-host conformance require further evidence.
The private JS UTF8 implementation uses bounded read chunks and joins them;
its allocation/performance profile differs from Node's native optimized
buffer strategy. Performance was not measured. That difference does not
justify excluding required APIs or changing observable results.
Existing SQLite/Performance/host-typecheck failures remain preserved.

## Main reconciliation

Six new main commits were incorporated locally after the focused controls.
The runtime/fixture source bytes used by those controls are unchanged; the
pre-sync backup covers1096 paths and verification permits differences only
in the ten declared overlapping files. Both host imports, upstream persistent
filesystem accounting and local entropy/metadata behavior are retained.
Rootfs conflict resolution uses upstream checked offset conversion and its
streamed export cache, preserving the earlier no-wrap behavior. PHP recipe22
combines upstream recipe21 changes with the current OpenSSL dependency.
The branch name, frozen audit and exact Node pins are preserved. No PR was
merged or published.

The first native Rust check attempt could not compile because the new main
requires absent historical executable fixtures. Its log remains under
`.context/node26-file-sync-main-reconciliation/`. The canonical pinned
producer helper materializes those exact frozen hashes independently of the
current compatibility engine. The final reconciliation receipt records its
actual result and the subsequent narrow Rust checks; neither these checks
nor source checks establish current guest/four-host conformance.
