# Go Runtime Port Guidance

Use this guide when changing the `GOOS=kandelo GOARCH=wasm` toolchain,
runtime, linker, or standard-library platform code. Registry package recipes
instead follow `porting-software-to-kandelo` and the package-build guide.

## Ownership and build

The Go source lives in the adjacent `../go-kandelo` checkout on its
`kandelo-port` branch, not in this repository. The pinned package input is
`packages/registry/go-hello/build.toml`; the implementation record is
`docs/plans/2026-09-05-go-gc-port-milestone1-plan.md`. Before changing code,
compare the fork's current commit with the package pin and progress log.
Runtime, syscall, and linker fixes belong in the Go fork. Kernel/host ABI and
POSIX fixes belong in Kandelo. Do not hide a platform defect in a probe or
package shim.

Build the fork with the dev shell's bootstrap Go:

```sh
scripts/dev-shell.sh bash -c 'cd ../go-kandelo/src && GOROOT_BOOTSTRAP="$(go env GOROOT)" ./make.bash'
```

The current fork is based on Go 1.25.6; cgo support remains partial for this
target. Confirm `GOOS=kandelo GOARCH=wasm` and cross-target `js`/`wasip1`
builds after runtime or linker changes. Do not assume Linux build tags or
APIs apply to Kandelo.

## Memory, threads, and syscalls

- The linker imports shared linear memory and declares a bounded pthread
  slot arena below the Go heap. The default is 32 slots; the per-program
  `-ldflags='-kandelothreadslots=N'` accepts 1–1024. Each slot reserves
  control memory, so increasing it is a memory-budget decision, especially
  for browser/WebKit. Go may start another M before `main`, so a one-slot
  program can hit the host limit during startup; the opt-in Node and
  three-browser ceiling probe requires a visible diagnostic and Go runtime
  failure, not a hang or silent arena overflow. See
  `src/cmd/link/internal/wasm/asm.go` in the fork and
  `host/src/process-memory.ts` in Kandelo.
- The main thread and each Go M need their own syscall channel. The host
  writes the channel offset through the linker's `__tls_base` receiver;
  `src/runtime/channel_kandelo.go` captures it into the M before syscalls.
  Channel layout comes from `crates/shared/src/lib.rs`, not a Go-local
  convention. Keep the Go heap above the channel/control region.
- In cgo builds, the shared Go `__tls_base` handoff word is unsafe when a C
  pthread and a Go M start concurrently. The Go runtime reads the C
  `__channel_base` mutable Wasm global through a typed C getter, so every
  instance captures its own channel. Non-cgo Go still uses the serialized
  shared handoff. A single callback pass does not detect this race; repeat
  the second-Go-M/C-pthread process probe.
- A cgo build must not grow a private contiguous Go `sbrk` heap beside C's
  `mmap` allocations. A C-created pthread can map directly above the break,
  blocking later Go growth despite unused process address space. Kandelo's Go
  runtime now allocates and reserves through the kernel's shared `mmap` and
  `munmap` manager. Test with both C-created pthreads and later Go scheduler
  allocations in Node and Chromium; success in one engine is insufficient.
- The exported `syscall` channel entry must release its scheduler P while a
  guest syscall blocks, then reacquire one before returning to Go. Keep
  runtime-internal channel calls separate: they also run from g0 and cannot
  unconditionally enter the user-g syscall transition. RoadRunner's
  concurrent HTTP assets exposed a deadlock that a one-request probe missed.
- A disconnected TCP client can make Kandelo `write` return `EPIPE` and raise
  `SIGPIPE`. Go's socket write path uses `Send` with `MSG_NOSIGNAL`, falling
  back to `write` for non-sockets. Exercise canceled browser requests as well
  as completed requests; a successful first page is not evidence that the
  server survives navigation or client disconnects.
- A foreign C pthread callback enters an extra Go goroutine through a
  synthetic frame, not a resumable Go caller. Mark that frame `TOPFRAME` in
  the Kandelo Wasm assembly; otherwise Go stack growth traces through the
  C callback argument address as a return PC and aborts. A small callback
  can pass despite this defect. Exercise deep recursion or a substantial
  PHP response from a C-created pthread on both Node and Chromium. Save the
  idle callback stack as an offset from its high bound, not an absolute
  pointer: Go may relocate the stack during the callback, and reentry must
  use the new high bound.
- Clone handoff needs an acknowledgment before reusing its shared words.
  A child must bootstrap its own stack and channel before entering the Go
  scheduler. Thread replicas must not replay active Wasm data segments over
  the live process's shared Go globals.
- An individual M exit is not process `EXIT_GROUP`. The `kernel_thread_exit`
  import reads Go's `freeWait` pointer while the g0 stack is still live,
  marks it reclaimable, exits that kernel thread, then traps out of the
  disposable worker. Do not clear or reclaim the stack before the Go Wasm
  import wrapper finishes reading it: the direct-call prototype trapped
  because generated wrapper code reread the stack. Process exit still uses
  the separate `kernel_exit` path.
- Go `syscall.StartProcess` uses non-forking `SYS_SPAWN`; descriptor
  inheritance must be serialized with `ForkLock`. The existing spawn
  attribute supports child-atomic process groups. Requested child
  credentials currently return `ENOSYS`; do not report a no-op as success.
- Kandelo directory reads use the kernel's Linux-style `getdents64` records
  and fd-owned iteration position, not the WASI preview-1 dirent/cookie
  format. Match `syscall.Dirent` and `os` parsing to the kernel's byte layout;
  preserve zero-inode entries, and send directory `Seek` to the kernel so
  rewind and `seekdir` cookies affect the real iterator. The selected upstream
  `os` and `syscall` dirent tests exercise multi-buffer reads on Node and all
  three browser engines.
- Kernel `stat` already supplies real mode, uid, and gid. Map those values
  into Go `FileInfo`; do not substitute WASI-style default permissions or
  zero owners. `Chown`, `Fchown`, and `Lchown` route through Kandelo's
  existing ownership syscalls, including no-follow behavior for symlinks.
  The selected upstream `os` chmod/chown tests cover these paths.
- Compare Go's `syscall_kandelo.go` `O_*` values with Kandelo's
  `crates/shared/src/lib.rs` and the wasm32posix musl headers, not WASI
  constants. Wrong `O_DIRECTORY`/`O_NOFOLLOW` values let `Root.MkdirAll`
  open a regular file as an intermediate directory and report the wrong
  error path; the upstream `TestMkdirAll/InRoot` case catches this.
- A wider upstream `os.Root` sweep is a platform probe, not a license to
  patch around kernel defects in Go. `TestRootRemoveDot` exposed Kandelo's
  `unlinkat(..., AT_REMOVEDIR)` removal of `.`; SharedFS millisecond time
  storage and pathname-backed directory OFDs likewise cause separate
  `Chtimes` and rename-after-open failures. Fix these at their owning
  syscall/VFS/OFD layers and keep the other upstream failures visible.
- `linkat` without `AT_SYMLINK_FOLLOW` must link the source symlink inode.
  Kernel no-follow resolution alone does not ensure that behavior: Node's
  `fs.linkSync` follows a symlink source on macOS, while browser SharedFS
  links the symlink inode. `TestRootLinkFrom` exposes this host mismatch;
  fix the HostFileSystem capability rather than changing Go's expectation.
- Kandelo's `lseek` channel has four argument slots: fd, 32-bit offset low,
  signed 32-bit offset high, and whence. Passing Go's `int64` offset in one
  slot shifts whence into the high half; `Seek(0, SEEK_CUR)` then returns
  `1<<32`. Keep the split at the syscall boundary and use upstream
  `TestRootDirFS` with its three empty-file fixtures to catch regressions.
- Keep logical file positions separate from writable file extents. The
  upstream `TestSeek` exercises offsets above 4 GiB; Node scratch mounts
  accepted them while browser SharedFS initially returned EFBIG at its
  smaller maximum file size. `lseek` and EOF reads may retain that logical
  position without allocating data, while a write beyond the limit fails.
- Root-relative rename consistency is a syscall/platform check. Kandelo's
  component walker canonicalizes `dir/.` to `dir`; `rename` and `renameat`
  must reject a final `.` before host mutation or the plain-path operation
  can move the directory while `os.Root.Rename` correctly fails.

Treat changes to memory declarations, Wasm imports/exports, channel layout,
or syscall semantics as ABI reviews. Follow `docs/agent-guidance/abi.md`:
incompatible changes require an `ABI_VERSION` bump and updated snapshot.
Stamp newly built probe binaries with this checkout's ABI-contract digest;
do not validate against a stale or unstamped binary.

## Go/Wasm cgo and C linking

FrankenPHP classic mode embeds a PHP ZTS SAPI through cgo. A working
`cmd/cgo` frontend is only one layer of that port. The `go-hello` package
pins the current fork revision, but remains a pure-Go hello program.
The adjacent fork runs focused Go/C calls and Go-owned and C-created-pthread
callbacks on Node and Chromium. The `php-zts` package and PHP embed lifecycle
probe pass on both hosts. The `frankenphp-classic` package now serves a PHP
request and a static asset through real HTTP on Node and Chromium. A
source-only WordPress VFS serves homepage and admin requests on Node and
Chromium, including the browser gallery profile. Do not infer full cgo,
POSIX conformance, or a WordPress performance advantage from these gates.

Trace the whole link path before changing flags or package recipes:

- `src/cmd/cgo/main.go`, `gcc.go`, and `out.go` own C type discovery,
  DWARF/constant extraction, and dynamic-import handling. Wasm is not
  ELF, Mach-O, PE, or XCOFF. A magic-byte bypass of object parsing is
  insufficient: the generated constants, symbols, and imports still need
  correct interpretations. The WIP Wasm reader in the adjacent fork
  is not yet a reviewed implementation.
- Kandelo's C ABI uses 32-bit pointers while Go/Wasm pointers are 64-bit.
  Exported Go callbacks need a byte-exact C frame: the Go `struct` generated
  by stock cgo pads pointer fields and can return null even when the Go
  callback returns a valid pointer. The fork now marshals exported scalar
  and pointer fields through C-sized byte offsets. Test mixed scalar/pointer
  arguments and pointer results on C-created pthreads. This does not repair
  direct Go field access to C structs containing pointers: FrankenPHP's
  version, header-list, and request-info paths use C accessors at that
  explicit interop boundary. Audit every new C struct access by comparing
  C `sizeof`/`offsetof` with generated Go layout before trusting it.
- FrankenPHP's CGI bulk registration passed a pointer-bearing C struct by
  value, another unsupported mixed-width case. Its Kandelo package patch
  uses the existing scalar/pointer `frankenphp_register_single` entry until
  a general packed-struct cgo bridge exists. This makes extra Go-to-C calls
  per request; measure the app before making performance claims.
- Static libraries must be declared through `#cgo LDFLAGS` with
  `-L${SRCDIR}/lib -l...`; environment-only `CGO_LDFLAGS` does not give the
  internal linker a search path, while `-extldflags` forces unsupported
  external linking. The internal linker selects archive members recursively
  for referenced C code, including PHP's dependency archives. The
  `static-archive` and `php-embed` probes cover this path on both hosts.
- A Go cgo executable must be fork-instrumented and carry the exact current
  `kandelo.abi.contract` digest. `install_local_binary` can instrument but
  does not stamp by itself: instrument first, stamp that fresh artifact, then
  install it. Unset cross-compiler `CC`/`CXX`/`AR` variables before the
  host-side Rust instrumentation and stamping builds.
- `src/cmd/link/internal/ld/lib.go` loads cgo's C objects. Internal mode
  originally rejected their format; the adjacent fork now imports C functions,
  initialized data, active table elements, and the CODE relocations reached
  by `runtime/cgo`, including narrow `reloc.DATA` address references and a
  bounded per-instance C TLS template. Fork commit `acc452f`
  asks the SDK compiler for its libc archive and resolves C function-pointer
  table relocations needed by the selected members.
  External mode reaches unsupported PC-relative relocations.
  `src/cmd/link/internal/wasm/asm.go` emits a final Wasm module, not an
  object that `wasm-ld` can link with the SDK's C Wasm objects. A direct
  `wasm-ld` attempt on that output rejects it. Do not suppress relocation
  errors to make the build appear to advance.
- C objects carry Wasm `linking` and `reloc.*` sections. The pthread
  callback fixture's C object needs function-index, global-index,
  table-index, and debug relocations; it references `go_double`,
  `pthread_create`, `pthread_join`, `__stack_pointer`, and
  `__table_base`. A linker design must resolve these into one function
  table and one shared linear memory without colliding with Go's
  `funcValueOffset`, static data, heap, TLS, or Kandelo's thread slots.
- Go's Wasm functions use the runtime's resumable call convention, while
  the SDK's C functions use the Wasm C ABI. A final link also needs
  real Go-to-C and C-to-Go adapters. `asmcgocall` now makes a typed C call
  on Go-created Ms. A Wasm-exported `crosscall2` wrapper resumes
  Go-owned callback goroutines across scheduler yields; the generic
  `cgocallback` assembly entry remains `UNDEF`. A separate foreign-thread
  bootstrap now attaches C-created pthreads for the focused callback probe.
  FrankenPHP additionally
  starts PHP threads with C `pthread_create`, so callbacks from a thread
  Go did not create must attach to a valid M, scheduler P, and per-thread
  Kandelo syscall channel. A same-thread callback alone is insufficient.

Continue linker work from the internal Wasm host-object reader, because the
Go linker already owns Kandelo's final memory, table, exports, and ABI
marker. The narrow fixture now verifies Go-to-C calls, C static data,
function-pointer DATA relocation, and per-instance TLS on Node and Chromium.
The normal `C.abs` build now validates, fork-instruments, and runs through
an ABI-stamped Kandelo process on Node and Chromium, including scalar and
pointer argument frames and distinct musl state on a second Go M. The
Go-owned callback fixture runs on Node and Chromium, including a scheduler
yield, timer wait, nested Go-to-C call, and second Go M. The combined pthread
fixture also executes its C-created callback on Node and Chromium.
If the internal path cannot
preserve C function types, table slots, static data and TLS alongside Go's
layout, evaluate a
relocatable-Go-object/external-link design explicitly. Never feed a final
Go module to `wasm-ld` as though it were a relocatable object, implement
only the object parser and call the link complete, or route calls through a
host shim that changes Kandelo's normal program model.

`cmd/link/internal/loadwasm` in the adjacent fork decodes imports, symbols,
signatures, bodies, data and active element segments, and the CODE relocation
kinds exercised by the C-call, C-data, and runtime/cgo objects. The
Kandelo-only internal linker imports C functions and initialized data into
Go's static layout, resolves direct C-to-C calls and memory-relative C-data
addresses, and maps C function-pointer relocations to Go's existing table.
Fork commit `2fcbf8c` also resolves C data-address globals that refer to
symbols in another C object; the checked-in linker fixture verifies this
through Go assembly on both hosts.
Fork commit `686572e` records global data symbols even from C objects with
no function body and retains their static segments. This is required for
musl archive members that define only data.
The link-only fixture now makes a narrow Go assembly call to C, including
an initialized `_Thread_local` value, and executes as a Kandelo process on
Node and Chromium. Direct table tests also prove per-instance TLS isolation
on shared memory in both engines. It does not exercise `runtime/cgo` or the
standard Go/C adapters. The normal `C.abs` build discovers SDK libc and
executable glue without manual linker flags. Absent weak init/fini bounds
resolve to zero. The fork now parses standard Wasm `INIT_FUNCS` linking
metadata, orders C constructors by priority, and runs them after musl
initialization through a C-ABI function-pointer table. Explicit nonempty
`.init_array`/`.fini_array` segments still fail until their linker-owned
layout and execution are implemented. The emitted module
passes the Node and Chromium process gate with empty stderr and no host
diagnostics. Musl/PHP TLS conformance, C-to-Go adapters, and
C-created-thread attachment remain. Do not treat the C shim's `_cgo_topofstack` call as
a direct call to a Go-resumable function. The C-data path is only one link
layer.

Musl C objects use a mutable per-instance TLS base for `_Thread_local` data.
The Go linker now gives C a distinct internal mutable global, reserves a main
TLS block, copies its template before `_start`, and exports `__wasm_init_tls`
for the host's pthread bootstrap. The exported immutable `__tls_base` remains
the Go channel handoff address; do not conflate it with C TLS. Keep the
template within the host's 64 KiB thread-control page, and reject overflow
or unsupported TLS initializer relocations explicitly. Validate musl/PHP TLS,
C-created threads, fork replay, and both hosts before claiming general TLS
support. The link-only fixture proves only a simple initialized TLS variable.

Kandelo-owned Go Ms use the native `newosprocKandelo` path even when cgo is
enabled, avoiding the `_cgo_sys_thread_start` gate for those Ms. Each
Go-created M now gets a separate 8 MiB C stack, reclaimed with the retired
M, and a 256-byte musl thread-pointer backing store. The host installs its C
stack pointer and musl thread pointer before the child entry, and the child
calls `__init_tp` before joining the Go scheduler. The scalar/pointer cgo
probe checks four worker rounds, including distinct `pthread_self()` and
thread-local `errno`, on Node and Chromium. C-created pthreads use a separate
typed Go bootstrap export, musl's `__wasm_thread_init`, an extra Go M/P, and
the per-instance Kandelo channel. C function pointers cannot call raw Go table
entries with the wrong Wasm signature. Do not add no-op thread or callback
symbols to satisfy the linker. The new per-instance C `__channel_base` global
and Go handoff word must both be initialized by the host; do not conflate
either with C TLS. The SDK's normal executable glue (syscall, compiler-rt,
and C++ runtime) is loaded by the Go linker through SDK source queries.
The shared host assigns a new instance's `__stack_pointer` from the
`kernel_clone` stack argument. Go passes the dedicated C stack top for cgo
Ms, not the g0 stack top; reusing g0 here would overwrite live Go frames.
The musl thread pointer and C TLS block are per-instance, not Go goroutine
state. Fork commit `8aec831` passes Go's process environment to musl
`__init_libc` in Go-owned storage; `os.Setenv`/`os.Unsetenv` use C-width
pointer frames so C `getenv` observes changes. Keep the libc initializer
separate from the C process entry archive member, and do not allocate its
environment table with independent C `mmap` while Go still uses a private
contiguous `sbrk` heap: that collided in the combined process. A Node/Chromium cgo probe verifies this
narrow environment path. Fork commit `dbec8a7` adds the Wasm constructor
table and a static `__dso_handle` for C destructor registration. The
constructor fixture verifies priority order, metadata-only
`.init_array.150` dispatch, and explicit C `exit(0)` destructor dispatch on
Node and Chromium. Go-led secure-exec startup passes focused set-ID and
`POSIX_SPAWN_RESETIDS` transitions on both hosts. The linker accepts only
zero-filled initializer arrays whose priorities match `INIT_FUNCS` metadata;
it rejects nonzero, relocated, exported, or referenced arrays rather than
treating their bytes as callable pointers. LLVM currently rejects
`.fini_array` sections. Go main return and `os.Exit` use Kandelo's
process-wide `exit_group` path and do not dispatch registered C exit handlers;
explicit C `exit(0)` does, and C `_exit(0)` does not. The constructor
fixture verifies all four paths on Node, Chromium, Firefox, and WebKit.
This matches the Linux Go runtime's raw `exit_group`
shutdown, not native macOS Go/cgo's observed C-handler behavior. Broader Go
security and shutdown semantics remain unproven. A cgo-disabled mixed C/Go
link must reject C constructor
metadata rather than silently discard it.
For Go-owned callbacks, a typed Wasm export wrapper keeps the C call stack
while Go's resumable scheduler completes the callback. Its linker root must
traverse Go dependencies even when C relocations eagerly marked the wrapper
reachable. C-created pthreads need a distinct typed bootstrap export. The
host invokes it with the kernel thread-slot index before the C start
function, giving the thread a reserved Go bootstrap stack. The callback
adapter then uses `needm`/`cgocallbackg`/`dropm`; after a yield it reloads
g0 from the resumed Go M rather than trusting Wasm locals across the
scheduler unwind. The focused callback probe exercises two callbacks per C
thread and a second Go M on Node and Chromium. Its stress mode runs three
simultaneous C pthread callbacks across eight rounds, with C malloc/free and
Go allocation/GC between rounds, on both hosts. This is bounded contention
and reclaim evidence, not general foreign-thread or PHP conformance.

For a repeatable C function-and-data link proof, run
`scripts/dev-shell.sh bash tests/go/cgo/link-only/test-link.sh`. It appends
small SDK C objects to a cgo-free Go archive and verifies C-to-C and C-data
relocations in the final Wasm module on Node and Chromium. After stamping,
`tests/go/cgo/link-only/run.ts` and the opt-in Chromium case verify the
assembly Go-to-C call inside a process. This is not the normal cgo build. The
standard `C.abs`, Go-owned callback, and focused C-created-pthread callback
gates pass; broader cgo and PHP lifecycle remain required runtime gates.

The Kandelo internal linker now reads cgo `-L` and `-l` flags and explicit
absolute `.a` paths, then selects referenced SDK C archive members, including
members reached through another archive member's C relocation. A cgo package
must declare its library search path with `#cgo LDFLAGS` pointing at a
resolver-owned archive directory. Setting `CGO_LDFLAGS` alone does not put
`-L` on this internal-link path, while `-extldflags` selects an external
link mode that the Kandelo Go/C linker does not support. Run
`bash tests/go/cgo/static-archive/build.sh`, its Node
runner, and the opt-in Chromium case before relying on a large archive such as
`libphp.a`. That fixture proves a small two-member C archive, not general PHP
linkability or archive relocation coverage.

PHP ZTS's larger archive additionally requires imported Wasm exception tags
for `__c_longjmp`, target-owned weak/strong C data symbols, object-local
function names, transitive static archives, and the documented unsupported
ucontext stubs for PHP Fibers that are compiled but not used. The
`tests/go/cgo/php-embed` probe now initializes, evaluates, and shuts down PHP
through the normal Kandelo process path on Node and Chromium. It does not
establish that upstream FrankenPHP requests work. In mixed-width cgo, Go's
8-byte `unsafe.Pointer` must not read a 4-byte C data pointer and adjacent
bytes; Kandelo's non-TSAN `_cgo_yield` storage is widened so Go observes a
real nil value. Watch for C structs containing 4-byte pointers: generating
native Go pointer fields silently changes their layout and corrupts values.

Use the staged probes in `tests/go/README.md`:
first a C call, then Go-to-C-to-Go on the calling thread, then a C-created
pthread callback. For the scratch frontend, run `../bin/go test cmd/cgo`
from `../go-kandelo/src` under `scripts/dev-shell.sh`. Use `go build -x -work`
and `llvm-readobj --sections --symbols --relocations` on its generated C
object to locate the exact build boundary. A successful native-host probe
checks the fixture only; a successful cgo frontend or link is not proof of
runtime behavior. Require a process that executes both callback paths on
Node and Chromium with the normal ABI stamp, matching memory/table layout,
expected output, empty stderr, and no host diagnostics before building a
PHP embed library or FrankenPHP. Re-run `js` and `wasip1` builds after
compiler, linker, or runtime changes.

## Evidence and handoff

The reproducible probe commands and scope are in `tests/go/README.md`.
After building the kernel, run `tests/go/build-browser-fixtures.sh` under
`scripts/dev-shell.sh`; it stamps the outputs. Run the relevant Node probe
and opt-in Chromium Playwright case against those exact outputs. Check exit
status, expected output, stderr, host diagnostics, and where applicable
fork-count samples. A Node pass does not establish browser parity; a focused
probe does not establish Go or POSIX conformance. For package integration,
also rebuild `go-hello` through the source-only resolver and launch the
resolved artifact from a VFS child on both hosts.

Record the exact Go fork commit, Kandelo commit or PR, changed contract,
Node/browser commands and results, ABI decision, and remaining gaps in the
same implementation progress log. Update the Go package source pin when
publishing a fork revision used by the package. Keep the Kandelo draft PR's
description aligned with verified evidence, not planned behavior.
