# Temporary-directory creation and disposal

Source revision 114 addresses parts of FS-013 and FS-016. The frozen audit,
Node 26.13.0 source/native pin and all 19 incomplete family dispositions
remain unchanged. This slice has no new guest compilation or execution.

## Owning implementation

`tempdir-platform-adapter.js` selects the unchanged public sync, callback
and promise mkdtemp wrappers, disposable-directory wrappers, callback/VFS
dispatch and once-per-process portability warning from the pinned source.
The shared bundler verifies complete source and selected-section hashes.
As with the existing directory owner, promise error stack recapture is
guarded when the engine lacks it; exact stack compatibility remains open.

`directory-operations.h` appends the target's six template bytes and calls
actual libc mkdtemp. Libc performs atomic mkdir with mode 0700 and collision
retry, subject to actual guest credentials and umask. The legacy bootstrap
Math.random loop is removed. No pathname existence check chooses a name.
`native-directory.cpp` shares the existing FS request/work queue, copying
path bytes before dispatch and retaining its native owner until completion.
Worker execution enters no JS. The request roots the private result encoder;
completion copies native bytes into a new view and uses actual candidate
Buffer codecs. Conversion exceptions are delivered to that request.

Sync errors retain the original prefix plus template suffix, while async
errors use the actual libc-operated template, following the target's
distinct synchronous error wrapper and libuv request paths. Libc can mutate
that template on failure. Exact guest diagnostic behavior still requires
controls; the host control does not certify the guest libc implementation.

Disposable objects use the existing native sync removal and queued pinned
rimraf owners. The unchanged wrappers capture cwd before suspension where
required, retain the full removal path, remove nested contents, propagate
errors, support repeated removal and expose the target disposal symbols and
prototype shape. The private removal binding is shared internally, with no
new public fs namespace export. Its source is now also a declared recipe
input. No syscall, host wire format, ABI version or memory ceiling changes.

## Evidence and retained nonpasses

* `.context/node26-tempdir-frontend-r3.json`: 7 new controls and 12 affected
  directory/removal controls pass. Actual candidate wrappers, Buffer codecs
  and removal algorithms use native Node's real engine/FS requests and OS.
  Coverage includes validation before dispatch, asynchronous callbacks,
  URLs/byte prefixes, concurrent uniqueness, encodings/private codecs,
  cwd-independent disposal, recursive/symlink cleanup, permission errors,
  repeated removal, symbol/prototype shape, VFS delegation and warnings.
* `.context/node26-tempdir-native/report.json`: 9 portable-header/libc
  scenarios match the exact native reference. They compare real directory
  creation, byte-prefix/suffix shape, permissions/umask, uniqueness and
  syscall errors, including empty/relative prefixes, existing names,
  symlink parents, missing/file parents and overlong names. Matched errors
  are not successful filesystem operations. The helper compiles once on
  macOS; it does not execute guest JSAPI, work queues, libc or kernel code.
* `.context/node26-tempdir-upstream-r2/report.json`: all 4 unchanged
  upstream files pass in both native and selected candidate modes. Other
  fs APIs and engine/common dependencies remain native controls. The
  preloader explicitly registers its own exact internal-binding warning;
  upstream API assertions and unexpected-warning checks remain unchanged.
* `.context/node26-tempdir-source-r2/report.json`: 4 source/generation/
  syntax checks, 18 selected identities and 5 complete pinned references.
  Target, frozen audit, build script and separate Bun asset branch remain
  unchanged. These checks do not compile the changed guest JSAPI source.

The first frontend command used a wrong config path and never loaded a
test. The next run retained 5 passes and 2 failures: a real missing
PromiseReject import and fixture warning contamination. The first upstream
candidate mkdtemp run failed its unchanged unexpected-warning check on the
control preloader warning. The first source check exposed an undeclared
removal-adapter input. Original logs/reports remain retained and are not
reclassified as passing compatibility. Generated random suffixes are
compared by prefix/length and actual filesystem properties, not equality
between independent creations.

## Remaining work and checkpoint scope

Revision 114 is source-only; the last accepted engine is 113 and is not
current for this candidate. Its persistent constructor/error/session
failures and all earlier nonpasses remain in the evidence chain. No overall
suite, guest engine build, kernel/host/image build or product rebuild ran
for this slice. Four-host conformance is unestablished.

Validate the real guest encoder rooting/request scopes, cancellation,
GC/OOM/teardown, result-conversion failures, raw paths/backend identity,
non-default disposable encodings, EINTR/collision/error templates and
permissions/VFS integration later. Enabled public VFS remains a broader
implementation gap. No platform exclusion is accepted by this slice.
CopyFile, cp, glob, statfs, file-backed Blob, watches, descriptor/stream
ownership and the other filesystem findings remain independent work.

Local commits now retain the frozen audit separately from the prior
revision-113 implementation checkpoint. The latter includes 130 existing
Node source dependencies omitted from its earlier selected source snapshot;
this repairs Git source availability without retroactively claiming a full
immutable SDK/build closure. These dependencies are added to the current
source ledger. No implementation changes were pushed, merged or deployed.
