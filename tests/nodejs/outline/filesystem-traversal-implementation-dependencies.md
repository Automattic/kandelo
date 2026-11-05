# Path resolution and filesystem glob ownership

Source122 connects the complete pinned logical/native realpath, readlink and
filesystem glob owners to actual filesystem primitives. The exact audited
Node26.13.0 target, source/native reference and frozen audit remain unchanged.
FS-013/016 are still partial findings; this slice supplies their path/glob
prerequisites without closing unrelated callback, copy, watch or metadata gaps.

## Actual owners

`realpath-platform-adapter.js` retains the pinned symlink walk, hard-link and
optional path caches, root/pipe/socket rules, encoding, overloads and native
aliases. Callback logical resolution uses real stat/readlink requests and
next ticks. Promise/native paths dispatch actual requests instead of a sync
operation hidden in a Promise. Public readlink now uses complete pinned sync,
callback and promise wrappers, including target validation/error ordering.

`path-metadata-operations.h` owns real libc realpath allocation/free and a
readlink buffer that grows on exact fills; targets are neither truncated nor
assumed UTF8. The existing metadata JSAPI/work owner copies input bytes before
queueing, retains the result encoder as a GC root, accounts completed buffers,
and publishes encoded results in the original request callback scope. Actual
encoding exceptions reject their request. Existing metadata void operations
retain their route. These new guest bindings remain uncompiled.

`glob-platform-adapter.js` installs the full unchanged pinned Glob/cache/
depth/symlink/exclusion/traversal source and public callback/sync/promise
wrappers. The existing pinned matching bundle and lazy helper are reused.
DirentFromStats comes from the same pinned Dirent owner used by fs.readdir;
actual stat/readdir and the new logical/native path owners supply traversal.
No outer-host glob implementation substitutes for these algorithms.

The pinned private URL-or-path converter now serves Stats, FileHandle,
realpath/readlink and glob consumers. It retains Node's URL-like predicate
and private decoder; public url.fileURLToPath mutation does not redirect
filesystem input conversion. No extra public url export is installed.

## Scoped evidence

* `.context/node26-realpath-glob-source-r2/report.json` verifies seven complete
  archive references, selected identities, source selectors, bundle/bootstrap
  generation and syntax, and all614 guarded source/verification inputs. Held
  engine source exposes Array.fromAsync; that is source evidence, not a guest
  execution result. No kernel/libc/host wire, syscall or ABI change was made.
* `.context/node26-realpath-glob-affected-r2.json`:16 new comparisons and37
  affected controls pass, with no failures/skips. They cover path/native alias
  and error/encoding/URL behavior; glob traversal, exclusions, depth/symlink/
  Dirent/iterator/descriptor behavior; shared URL conversion, including public
  mutation; and affected metadata/readdir/input guards. The controls use
  actual candidate JS owners with explicit native process/binding/FS request,
  inspection and byte/engine dependencies. They are not the guest JSAPI.
* `.context/node26-realpath-native-r2/report.json`:16 portable byte/error
  comparisons pass against exact native Node on controlled real files and
  symlinks, including long and raw-byte targets, missing/dangling paths and
  cycles. Two helper compilation attempts occurred: the first compiled but
  setup could not create an invalid-UTF8 filename on the development host.
  Its failure is retained; the corrected fixture preserves the raw link
  target and does not pretend invalid-byte filename resolution was tested.
* `.context/node26-realpath-glob-upstream-r2/report.json`:four unchanged
  upstream files pass in candidate/native modes (eight runs), including
  native aliases, encodings, readlink type checks and a throwing glob callback.
  The native common harness/dependencies and ESM export synchronization are
  explicit. Neither whole-fixture closure nor guest/four-host conformance
  follows. Earlier positive controls retain their original source scope.

The initial multisource-selector generation error and development-host raw
filename setup failure remain recorded. Earlier environment-clone, cipher,
SQLite, Error and compression nonpasses remain unresolved; no exclusions or
passing compatibility result replaces them.

## Remaining implementation and validation dependencies

Compile and integrate source117–122 through the normal resolver at the next
warranted targeted build. Accepted116 is not current. Guest result conversion,
allocation/GC/OOM, callback exceptions, cancellation/ref/exit, workers and
real backend path/permission/VFS behavior remain unvalidated on all four hosts.
The public permission model and experimental VFS module remain separate gaps;
the current guest CLI rejects their activation. Loader/cache/origin policy
still needs its own full reconciliation.

FS-022 remains a concrete backend byte-path gap: some host routes decode raw
paths nonfatally before a string API, potentially aliasing invalid names.
Kernel byte-name filesystems and Unicode-only mounted backends require
separate evidence; this is not a blanket engine/platform exclusion. The
portable control's macOS fixture limit does not excuse the guest gap.

Source inspection also records kernel default_statfs's fixed4GB/2GB fallback
and the Node host fstatfs route's zero-capacity report. Actual mount policy
flags do not establish measured capacity. Keep the Node statfs entry points
unavailable until actual per-backend state is supplied; this slice exposes no
new statfs success and does not alter that separate kernel/host dependency.

All19 families remain partial. Overall suites and full product rebuild remain
deferred. Continue independent audited owners instead of deepening this
subsystem indefinitely; later identified-artifact four-host coverage must
reconcile every remaining API/alias/descriptor and backend deviation.

## Disk maintenance

The authorized cache-gc --apply command skipped the shared cache because a
build held its lock; it removed nothing. Separately,43 idle old generated
bootstrap headers (1,006,240,984 bytes) were archived to135,120,181 bytes,
round-trip hash verified and then retired. The current output, accepted116
header, binaries, pinned references and evidence were protected. The archive
and index under `.context/retired-generated-node-headers-20261105T212542Z/`
restore original paths. No global physical-free-space attribution is claimed
while other worktrees and APFS sharing change available space.
