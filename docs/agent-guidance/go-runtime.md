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

The current fork is based on Go 1.25.6 and builds with cgo disabled for this
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
`cmd/cgo` frontend is only one layer of that port. The current published
`GOOS=kandelo GOARCH=wasm` fork defaults to `CGO_ENABLED=0`; its first cgo
probe fails at Wasm pointer-size recognition. An uncommitted frontend
experiment can compile the C-call and callback fixtures, but **neither
links or runs on Kandelo**. Do not describe it as cgo support or pin it
for a FrankenPHP package.

Trace the whole link path before changing flags or package recipes:

- `src/cmd/cgo/main.go`, `gcc.go`, and `out.go` own C type discovery,
  DWARF/constant extraction, and dynamic-import handling. Wasm is not
  ELF, Mach-O, PE, or XCOFF. A magic-byte bypass of object parsing is
  insufficient: the generated constants, symbols, and imports still need
  correct interpretations. The scratch Wasm reader in the adjacent fork
  is not yet a reviewed implementation.
- `src/cmd/link/internal/ld/lib.go` loads cgo's C objects. Internal mode
  originally rejected their format; the current fork imports function-only
  Wasm objects but not the data/memory relocations in `runtime/cgo`.
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
  real Go-to-C and C-to-Go adapters. `src/runtime/asm_wasm.s` currently
  leaves `asmcgocall` and `cgocallback` as `UNDEF`. FrankenPHP additionally
  starts PHP threads with C `pthread_create`, so callbacks from a thread
  Go did not create must attach to a valid M, scheduler P, and per-thread
  Kandelo syscall channel. A same-thread callback alone is insufficient.

Continue linker work from the internal Wasm host-object reader, because the
Go linker already owns Kandelo's final memory, table, exports, and ABI
marker. Extend it to C data and memory relocations, then resolve the C
shim's Go-facing symbols and prove one real C call in the final Go module
before expanding to C archives or PHP. This path is not yet established
feasible: if it cannot preserve C function types, table slots, static data
and TLS alongside Go's layout, evaluate a
relocatable-Go-object/external-link design explicitly. Never feed a final
Go module to `wasm-ld` as though it were a relocatable object, implement
only the object parser and call the link complete, or route calls through a
host shim that changes Kandelo's normal program model.

`cmd/link/internal/loadwasm` in the adjacent fork decodes imports, symbols,
signatures, bodies, and the CODE relocation kinds exercised by the C-call and
callback objects. The Kandelo-only internal-linker path imports C function
bodies and signatures and resolves direct function-index relocations among
loaded C functions. It still does not decode debug relocations or archives,
and it cannot link the cgo probes. The first full internal-link attempt
encounters `runtime/cgo`'s memory-relative relocation and data segments,
followed by dynamic-symbol and unresolved runtime/cgo references. Do not
silently omit those sections or treat the C shim's `_cgo_topofstack` call as
a direct call to a Go-resumable function. The function-body path is only one
link layer.

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
