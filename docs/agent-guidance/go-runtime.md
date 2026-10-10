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
  for browser/WebKit. See `src/cmd/link/internal/wasm/asm.go` in the fork and
  `host/src/process-memory.ts` in Kandelo.
- The main thread and each Go M need their own syscall channel. The host
  writes the channel offset through the linker's `__tls_base` receiver;
  `src/runtime/channel_kandelo.go` captures it into the M before syscalls.
  Channel layout comes from `crates/shared/src/lib.rs`, not a Go-local
  convention. Keep the Go heap above the channel/control region.
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

Treat changes to memory declarations, Wasm imports/exports, channel layout,
or syscall semantics as ABI reviews. Follow `docs/agent-guidance/abi.md`:
incompatible changes require an `ABI_VERSION` bump and updated snapshot.
Stamp newly built probe binaries with this checkout's ABI-contract digest;
do not validate against a stale or unstamped binary.

## Go/Wasm cgo and C linking

FrankenPHP classic mode embeds a PHP ZTS SAPI through cgo. A working
`cmd/cgo` frontend is only one layer of that port. The `go-hello` package
still pins an earlier pure-Go revision that fails the first cgo probe at
Wasm pointer-size recognition. The adjacent fork now runs a narrow standard
Go-to-C fixture on Node and Chromium. **Callbacks, C-created pthreads, and
PHP embedding do not work.** Do not pin it for a FrankenPHP package.

Trace the whole link path before changing flags or package recipes:

- `src/cmd/cgo/main.go`, `gcc.go`, and `out.go` own C type discovery,
  DWARF/constant extraction, and dynamic-import handling. Wasm is not
  ELF, Mach-O, PE, or XCOFF. A magic-byte bypass of object parsing is
  insufficient: the generated constants, symbols, and imports still need
  correct interpretations. The WIP Wasm reader in the adjacent fork
  is not yet a reviewed implementation.
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
  `cgocallback` assembly entry remains `UNDEF`, and C-created threads
  cannot attach. FrankenPHP additionally
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
fixture links and validates but its C-created callback cannot enter Go.
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
resolve to zero, while nonempty constructor arrays fail explicitly until
their linker-owned layout and execution are implemented. The emitted module
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
thread-local `errno`, on Node and Chromium. This does **not** attach C-created
pthreads: they still require a real
Go-compatible entry, musl thread pointer and TLS, M/P attachment, and a
per-instance Kandelo channel. C function pointers cannot call raw Go table
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
environment table with independent C `mmap`: that collided with the Go
heap in the combined process. A Node/Chromium cgo probe verifies this
narrow environment path. Secure-exec behavior and nonempty constructor/
destructor execution are still unproven in a Go process.
For Go-owned callbacks, a typed Wasm export wrapper keeps the C call stack
while Go's resumable scheduler completes the callback. Its linker root must
traverse Go dependencies even when C relocations eagerly marked the wrapper
reachable. C-created pthreads still enter with no Go `g`, stack pointer,
or attached M; the Go-owned export wrapper is not a general foreign-thread
callback adapter.
The combined pthread fixture currently faults in `runtime.canpanic` on the
child because it has no Go `g` or Go stack. A C-created thread needs a
separate Go bootstrap stack before
entering any Go export, a valid per-instance Go channel, and the
`needm`/`cgocallback`/`dropm` lifecycle for an extra M. Do not reuse live
C frames as that Go stack or treat the trap as successful attachment.

For a repeatable C function-and-data link proof, run
`scripts/dev-shell.sh bash tests/go/cgo/link-only/test-link.sh`. It appends
small SDK C objects to a cgo-free Go archive and verifies C-to-C and C-data
relocations in the final Wasm module on Node and Chromium. After stamping,
`tests/go/cgo/link-only/run.ts` and the opt-in Chromium case verify the
assembly Go-to-C call inside a process. This is not the normal cgo build. The
standard `C.abs` and Go-owned callback gates pass; C-created pthread
callbacks remain the required runtime gate.

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
