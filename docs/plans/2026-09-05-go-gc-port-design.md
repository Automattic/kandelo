# Go `gc` compiler port to Kandelo (`GOOS=kandelo`) — design

**Date:** 2026-09-05
**Status:** Proposed design (not yet implemented)
**Author:** Brandon Payton

> Ground-truth notes in this document were verified against a real Go
> source tree (`go1.25.6`, GOROOT
> `/opt/homebrew/Cellar/go/1.25.6/libexec/src`) and against the Kandelo
> tree at the time of writing (`crates/fork-instrument/`,
> `libc/glue/channel_syscall.c`, `crates/shared/src/lib.rs`, ABI 43).
> Line references to Go internals are for orientation; they will drift
> across Go releases and must be re-checked before implementation.

---

## Why

Today Kandelo can build and run C and C++ software through the normal
platform path (SDK, musl, resolver, VFS image, syscalls, host runtime,
kernel). Every user-language port to date is C/C++. There is no way to
build a Go program for Kandelo at all.

That is a real platform gap, not a missing convenience. A large and
growing share of modern systems software — CLIs, servers, developer
tooling, application runtimes — is written in Go, and none of it can
target Kandelo. Users who want to run that software have no path, and
the platform cannot honestly claim to be a general POSIX target while a
mainstream language cannot reach it.

This document proposes making **standard Go a first-class SDK language**
by porting the official Go `gc` compiler and runtime to a new operating
system target, `GOOS=kandelo`, that speaks Kandelo's native ABI. The
goal is full standard Go — the complete language, the real garbage
collector, the real goroutine scheduler, and as much of the standard
library as the platform's POSIX surface can honestly support — not a
crippled subset and not a compatibility-shim veneer.

The audience is anyone who wants to bring Go software to Kandelo:
package maintainers porting Go CLIs and servers, and eventually users
running Go application runtimes. The near-term deliverable is Go
programs that build and run through the normal package path; the
long-term deliverable is Go treated exactly like C/C++ in the resolver,
SDK, and VFS image tooling.

---

## Goals

- A `GOOS=kandelo GOARCH=wasm` port of the upstream `gc` toolchain that
  produces Kandelo-native Wasm programs: bare `wasm32-unknown-unknown`
  code that talks to the kernel over the SharedArrayBuffer
  **channel-syscall** ABI, carries the `__abi_version` marker the host
  checks at instantiation, and runs in a process worker like any other
  Kandelo program.
- The **full standard Go language and runtime**: real GC, real
  goroutine scheduler, `reflect`, generics, the standard library to the
  extent the platform's syscalls support it.
- **Real parallelism** (`GOMAXPROCS > 1`) by wiring Go's OS-thread
  creation to Kandelo's `clone` primitive, rather than accepting the
  single-threaded ceiling of the stock wasm ports.
- **Subprocess support** (`os/exec`, `os.StartProcess`) backed by
  Kandelo's non-forking `SYS_SPAWN` primitive.
- **Real networking** (`net.Dial` and listeners) backed by Kandelo's
  socket syscalls — an improvement over stock `wasip1`, which is
  accept-only.
- First-class package-system integration: a Go program builds through a
  `package.toml` / build-script recipe the same way a C program does.

## Non-goals

- **cgo.** The upstream `gc` toolchain does not support cgo on any wasm
  target (`internal/platform/zosarch.go` gives `{"wasip1","wasm"}` and
  `{"js","wasm"}` empty `distInfo` literals, so `CgoSupported` is the
  zero value `false`; `internal/platform/supported.go` `CgoSupported`
  reads that table). A `GOOS=kandelo GOARCH=wasm` entry inherits
  `false` unless we build a wasm C-interop toolchain, which is a
  separate research effort with no upstream precedent. cgo is out of
  scope for this port.
- **FrankenPHP.** It embeds `libphp` through cgo; with cgo out of
  scope, FrankenPHP is out of reach on Kandelo regardless of this port.
  This is a documented boundary, not a defect to paper over.
- **POSIX `fork()` for Go programs.** Go's runtime does not support
  fork-and-continue on any platform (native Go only does fork
  immediately followed by exec, in a locked-down child). We will not
  attempt to make `wasm-fork-instrument` rewrite Go binaries. See
  "Exec model" and "Alternatives considered."
- **A Go port merged upstream.** This port is maintained out-of-tree
  against tagged Go releases. Upstreaming is a possible later effort,
  not a goal here.

---

## Background: what Kandelo's ABI forces

Kandelo's native program contract (verified against the current tree)
determines the shape of the port:

- **Target and libc.** Programs are `wasm32-unknown-unknown` +
  musl; there is no WASI SDK in the native path. Go's `GOARCH=wasm`
  backend already emits `wasm32-unknown-unknown`-class code, so the
  code generator is compatible; the libc question is moot because Go
  does not link a libc (it has its own runtime and syscall layer).
- **Syscalls travel over a shared-memory channel, with zero kernel
  imports.** `libc/glue/channel_syscall.c` writes the syscall number
  and arguments into a per-thread channel region in shared memory, does
  `Atomics.store`/`Atomics.notify` to wake the kernel worker, and
  blocks on `Atomics.wait`. This is *not* WASI; the `wasi-shim`
  (`host/src/wasi-shim.ts`) exists only to run pre-built third-party
  `wasip1` binaries and gives no fork/exec, no multi-process, and no
  native ABI.
- **The `__abi_version` marker is mandatory.** The host checks it at
  instantiation; current ABI is 43 (`crates/shared/src/lib.rs`).
- **Memory is host-provided and shared.** Native programs link with
  `--import-memory --shared-memory --max-memory=...` and are built with
  atomics and bulk-memory. Threads exist only via the kernel's `clone`,
  host-orchestrated (`onClone` → `centralizedThreadWorkerMain`); the
  guest cannot spawn a thread by itself.
- **Subprocesses have a non-forking primitive.** `SYS_SPAWN` (host
  syscall 500; contract in `crates/shared/src/lib.rs::spawn_contract`,
  ABI 43; design in
  `docs/plans/2026-05-04-non-forking-posix-spawn-design.md`) launches a
  new process worker without copying parent memory or running a
  fork-instrument unwind.

The consequence: Go's stock outputs do not fit (`GOOS=js` needs a
`gojs` host Kandelo lacks; `GOOS=wasip1` can only ride the compat shim
with none of the above). A native `GOOS=kandelo` port is required to
get first-class behavior.

---

## Port strategy

The strategy is: **fork the upstream `gc` toolchain, reuse the
`GOARCH=wasm` code generator unchanged, and add a new OS target whose
runtime and syscall layer speak Kandelo's ABI.** The single hardest,
most novel piece is bringing up a *multi-threaded* wasm runtime, which
no `gc`-Go wasm port has done.

### Why the code generator is reused unchanged

The critical wasm-specific problem — switching goroutines when the wasm
call stack is not addressable — is already solved by Go's `GOARCH=wasm`
backend, and it is solved *without* Binaryen Asyncify. The backend
keeps Go frames on a Go-managed stack in linear memory (the `SP`
register handling in `cmd/internal/obj/wasm/wasmobj.go`) and emits
natively **resumable** control flow via resume points around calls
(`ARESUMEPOINT`, introduced for CALL instructions in `wasmobj.go`;
`morestack` handling in the same file). The SSA lowering lives in
`cmd/compile/internal/wasm/ssa.go`.

Crucially, **none of this references any GOOS**; it is purely
`GOARCH=wasm`. A new OS target reuses `cmd/compile/internal/wasm` and
`cmd/internal/obj/wasm` **unmodified**. This is the reason the `gc`
port is tractable at all and the decisive advantage over every
alternative in the "Alternatives considered" section: the one
wasm-hard, Asyncify-free piece already exists in this toolchain.

### GOOS registration

Adding `kandelo` as a known OS touches (verified in go1.25.6; note the
list moved out of the old `go/build/syslist.go`, which no longer
exists):

| Concern | File | Change |
|---|---|---|
| Master OS list | `internal/syslist/syslist.go` (`KnownOS`) | add `"kandelo": true` |
| Bootstrap allowlist | `cmd/dist/build.go` (`okgoos`) | add `"kandelo"` |
| Supported-platform table | generated `internal/platform/zosarch.go` (`OSArch` pair + `distInfo` entry) | add `{"kandelo","wasm"}` via its generator |

Once `kandelo` is in `KnownOS`, the file-suffix machinery in
`go/build/build.go` `goodOSArchFile` automatically treats `*_kandelo.go`
and `*_kandelo_wasm.go` as OS-constrained, and `//go:build kandelo`
resolves. Adding `kandelo` to `syslist.UnixOS` is optional and only
affects `//go:build unix` matching; we likely want it so the large body
of `//go:build unix` stdlib files apply, but that must be audited file
by file rather than assumed.

### Runtime OS layer

Mirror the `wasip1` runtime file set with `kandelo` equivalents. The
`wasip1` port splits into shared `GOARCH=wasm` files (reused) and
`GOOS=wasip1` files (re-implemented):

- Reused as-is (GOARCH=wasm): `runtime/os_wasm.go`,
  `runtime/mem_wasm.go`, `runtime/mem_sbrk.go`, `runtime/sys_wasm.*`,
  `runtime/asm_wasm.s`, `runtime/stubs_wasm.go`.
- New, mirroring the `*_wasip1.go` set: `runtime/os_kandelo.go`,
  `runtime/lock_kandelo.go`, `runtime/mem_kandelo.go`,
  `runtime/netpoll_kandelo.go`, `runtime/rt0_kandelo_wasm.s`.

The bounded set of runtime primitives a new OS supplies (verified
signatures/locations in the `wasip1` port): `osinit`
(`runtime/os_wasm.go`), `walltime`/`nanotime1`
(`runtime/os_wasip1.go`, via the syscall backend), `readRandom` (note:
the current hook is `readRandom`, not `getRandomData`), `exit`, the
memory OS hooks (`sysAllocOS`/`sysReserveOS`/`sysMapOS` in
`runtime/mem_sbrk.go`, backed by `sbrk`/`growMemory`), and the
scheduler parking primitive. On `wasip1` the park primitive is neither
futex nor semaphore: `runtime/lock_wasip1.go` implements `notetsleepg`
by cooperatively spinning on `sched_yield` + `Gosched()` and throws
from the g0 variants, because the port is single-M. Our multi-threaded
port must replace this with a real cross-thread park (see "Thread
model").

### Syscall backend: channel ABI instead of Wasm imports

This is where the port most fundamentally diverges from `wasip1`.
`wasip1` issues syscalls as `//go:wasmimport wasi_snapshot_preview1
<name>` host-function imports (10 in `runtime/os_wasip1.go`, 26 in
`syscall/fs_wasip1.go`, 2 in `syscall/net_wasip1.go`, plus
`syscall/os_wasip1.go`, `syscall/tables_wasip1.go`). The generic
`syscall.Syscall*` entrypoints (`syscall/syscall_wasip1.go`) are stubs;
the real work is in typed wasmimport wrappers.

Kandelo has **zero kernel imports** — the channel protocol is
`Atomics.store`/`Atomics.notify`/`Atomics.wait` on a shared-memory
channel region. So the port cannot merely re-point wasmimport module
names. It must **reproduce the channel handshake inside the Go
runtime**, and Go cannot link musl's `channel_syscall.c` to borrow it.
This is a core design decision with two candidate implementations:

1. **Pure-guest channel handshake (matches the native contract).**
   Implement the marshalling + `Atomics`-equivalent handshake in Go
   runtime code. This requires the `GOARCH=wasm` backend to emit atomic
   memory operations and `memory.atomic.wait32`/`notify` (today Go's
   wasm backend does not expose these to runtime code), so it implies
   backend/assembler additions in `cmd/internal/obj/wasm`. Preferred
   because it preserves Kandelo's zero-import contract.
2. **Minimal host shim import.** Expose one or two Kandelo host
   functions (e.g. a "submit channel request and block" import) that
   perform the wait, keeping marshalling in Go. Easier to implement but
   diverges from the zero-import contract and is an ABI-visible
   addition; acceptable only as a documented, intentional boundary.

We will prototype (1) and fall back to (2) only if the backend work
proves disproportionate. Either way, the syscall surface files are new
`*_kandelo.go` files re-declaring the typed wrappers and reimplementing
`fs_*`, `net_*`, `os_*` on top of the channel backend.

### ABI marker and memory model at link time

Two link-time obligations that `wasip1` does not satisfy:

- **`__abi_version` export / ABI custom section.** Go binaries must
  carry the marker the host checks (ABI 43). Go uses its own linker
  (`cmd/link`), not `wasm-ld`, so this is either emitted by the linker
  for `GOOS=kandelo` or injected by a post-link step in the SDK build
  path. Design decision: prefer emitting it in `cmd/link` so the
  artifact is self-describing.
- **Imported, shared memory.** Kandelo programs link with
  `--import-memory --shared-memory --max-memory`. Go's wasm linker
  currently emits a module that *exports* its own non-shared memory and
  grows it via `growMemory`. Producing a module with **imported +
  shared** memory (required for threads to share one linear memory
  across workers) is a `cmd/link` change. This is one of the deep-work
  items and is a prerequisite for the thread model below.

---

## Thread model

Stock wasm Go is single-M by construction: `newosproc`
(`runtime/os_wasm.go`) unconditionally `throw`s
`"newosproc: not implemented"`, `getCPUCount` returns `1`,
`preemptMSupported = false`, and `runtime/lock_wasip1.go`'s `lock2`
throws `"self deadlock"` on the assumption that "wasm is
single-threaded so we should never observe this."

Kandelo, unlike stock WASI/JS hosts, **has** a generic thread-creation
primitive: the kernel `clone` syscall spawns a new process worker
running another wasm instance over the **same shared linear memory**
(`onClone` → `centralizedThreadWorkerMain`). This is what makes real
parallel Go possible here and not on stock wasm.

The port therefore:

- Implements `newosproc(mp *m)` to request a new worker via Kandelo
  `clone`, with the new worker entering at a thread-entry export that
  sets up that M and calls `mstart`.
- Establishes **per-M TLS** (`__tls_base` per worker) so each M has its
  own runtime thread-local state; this interacts with `cmd/link`'s TLS
  handling for the shared-memory build.
- **Reverses the single-M assumptions**: a real cross-thread park
  primitive in `runtime/lock_kandelo.go` (replacing `wasip1`'s
  cooperative `notetsleepg`), a real `getCPUCount`, and a `netpollBreak`
  that can actually interrupt another M (`wasip1`'s is empty).
- Keeps **cooperative preemption only.** Wasm has no signals, so Go's
  signal-based async preemption is unavailable; `preemptM` stays a
  no-op and preemption happens at safe points. Tight loops without safe
  points cannot be preempted. This is an accepted limitation to
  document, not hide.

This multi-threaded runtime bring-up is the **primary risk** of the
whole project: no `gc`-Go wasm port has done real threads, so this is
frontier work combining a shared-memory linker mode, per-M TLS,
cross-thread parking, and a thread-safe scheduler over the
linear-memory goroutine-stack machinery.

---

## Exec model

Go does not fork-and-continue; `os/exec` and `os.StartProcess`
ultimately do a fork immediately followed by exec, fused. That maps
cleanly onto Kandelo's **non-forking `SYS_SPAWN`** (syscall 500,
contract in `crates/shared/src/lib.rs::spawn_contract`). The port
implements `syscall.StartProcess` on `GOOS=kandelo` to marshal argv,
envp, the resolved absolute path (PATH search stays in the caller, as
`SYS_SPAWN` takes one resolved path), and the fd/attribute actions into
the spawn request, and to launch via `SYS_SPAWN`.

We deliberately do **not** implement POSIX `fork()` for Go and do
**not** use `wasm-fork-instrument` on Go binaries. `fork()`-and-continue
is incompatible with Go's runtime on every platform, and the
instrumenter is architecturally a fork engine keyed to the wasm
call stack and clang/musl stack discipline (see "Alternatives
considered"). Spawn-based exec is both the POSIX-conformant choice
(`posix_spawn` is explicitly permitted to be non-forking) and the one
that matches Go's actual behavior.

---

## Netpoller and networking

`wasip1` networking is accept-only: in `syscall/net_wasip1.go` only
`sock_accept` and `sock_shutdown` are real; `Socket`, `Bind`,
`Connect`, `Listen`, `Sendto`, `Recvfrom`, etc. return `ENOSYS`, so
`net.Dial` does not work. The `wasip1` netpoller
(`runtime/netpoll_wasip1.go`) is built on `poll_oneoff` with an empty
`netpollBreak` (single-M).

Kandelo has a real socket layer and a real `poll`/`epoll`
implementation, so the port can do better than `wasip1`:

- Implement `net_kandelo.go` against Kandelo's socket syscalls,
  supporting outbound `net.Dial` and listeners — a genuine improvement
  over the stock wasm ports.
- Implement `runtime/netpoll_kandelo.go` against Kandelo `poll`/`epoll`
  with a working `netpollBreak` once threads exist.

**Blocking-syscall starvation.** A Kandelo channel syscall blocks the
calling worker on `Atomics.wait`. With a single M that stalls all
goroutines; with the multi-threaded model and a real netpoller, a
blocked M does not starve runnable goroutines on other Ms, and I/O
readiness is driven through the netpoller rather than blocking calls
wherever possible. This is a correctness-and-throughput reason the
thread model and netpoller are co-dependent milestones.

---

## Milestones

Phased so each milestone runs something real before the next risk is
taken on:

1. **Toolchain registration + `hello world` (single-threaded, minimal
   runtime).** Add the GOOS, new runtime OS files, the channel-syscall
   backend for the minimal set the runtime needs
   (`write`/`exit`/`clock`/`random`), imported-shared-memory linking,
   and the `__abi_version` marker. Success: a Go `hello world` builds
   and runs in a Kandelo process worker, printing via the channel ABI,
   with correct exit code. Single M, `GOMAXPROCS=1`.
2. **Syscall coverage for CLIs.** Grow `fs_kandelo.go` / `os_kandelo.go`
   to cover files, args, env, stdin/stdout/stderr, working directory,
   time. Success: a non-trivial Go CLI (filesystem + args) runs.
3. **Real threads.** Wire `newosproc` to `clone`, per-M TLS,
   cross-thread parking, thread-safe scheduler. Success: a
   goroutine-parallel program runs with `GOMAXPROCS > 1` and observable
   parallelism; the runtime's own thread tests pass. **Highest-risk
   milestone.**
4. **Netpoller + networking.** `net_kandelo.go` + `netpoll_kandelo.go`.
   Success: `net.Dial` and a listener both work; a small Go HTTP client
   and server run.
5. **Exec.** `syscall.StartProcess` via `SYS_SPAWN`. Success: a Go
   program that shells out / manages a child process works.
6. **First-class package integration.** A `package.toml` +
   build-script recipe that invokes the Kandelo Go toolchain through the
   SDK path, produces the declared outputs, and lands in a VFS image
   like any C package. Success: a Go package builds and runs through the
   normal resolver/VFS path.

---

## Risks and open questions

- **Multi-threaded wasm Go is unprecedented (highest risk).** Milestone
  3 combines shared-memory linking, per-M TLS, cross-thread parking, and
  a thread-safe scheduler over linear-memory goroutine stacks. If it
  proves intractable, the fallback is a single-threaded but otherwise
  full Go port (concurrency without parallelism), which is still far
  more capable than the `wasip1`-shim path.
- **Channel handshake in the runtime.** Whether the `GOARCH=wasm`
  backend can be extended to emit atomic wait/notify for runtime use
  (option 1) versus taking a minimal host import (option 2) is an open
  prototype question.
- **`cmd/link` changes.** Imported+shared memory and the `__abi_version`
  marker are linker-level changes to Go's own linker; scope to be
  confirmed by prototype.
- **TLS model under threads.** Go's runtime TLS vs. wasm `__tls_base`
  per worker under a shared-memory build needs validation.
- **Maintenance burden.** The port is an out-of-tree fork rebased
  against each Go release. Go provides no third-party/out-of-tree
  target mechanism (no target-spec files, no plugin API), so this cost
  is unavoidable for the `gc` toolchain and must be planned for.
- **ABI touch points.** The port is primarily a *consumer* of the
  existing ABI (channel syscalls, `SYS_SPAWN`, `clone`). If option 2
  (host shim import) is chosen, or if Go needs a syscall Kandelo does
  not yet implement, that is normal platform work and, if it changes
  the host/program contract, requires an `ABI_VERSION` bump and
  regenerated snapshot per `docs/agent-guidance/abi.md`.

---

## Alternatives considered

Each was investigated against ground truth and rejected for the reason
given.

### A. Standard Go via `GOOS=wasip1` on the WASI shim

Build stock Go with `GOOS=wasip1` and run it through
`host/src/wasi-shim.ts`. **Why not:** it is capped by `wasip1`
semantics forever — single-threaded, no `os/exec`/fork, and
`net.Dial` unsupported (accept-only on preopened sockets, per
`syscall/net_wasip1.go`). It bypasses the native channel ABI and the
package-system-native path, so it is "Go runs" rather than "Go is a
first-class SDK language." Useful only as a throwaway feasibility gate,
not a destination.

### B. TinyGo with a Kandelo target

TinyGo is LLVM-based, links a libc, and supports pluggable targets via
target-spec JSON — the only genuinely pluggable Go path (no toolchain
fork). **Why not:** it delivers a language/stdlib *subset* (partial
`reflect`, stdlib gaps), which conflicts with the "full Go" goal. Its
wasm goroutine scheduler has historically relied on Binaryen Asyncify,
which Kandelo bans; making it ban-compliant would require building a
Kandelo-native Asyncify replacement (see D). TinyGo remains the right
choice *if* the priority ever shifts to pluggability over language
completeness; it is not chosen here because the requirement is full
standard Go.

### C. gollvm / generic LLVM

gollvm pairs the complete `gofrontend` with an LLVM backend and the
`libgo` (gccgo) runtime — full language on LLVM, conceptually the
"pluggable + full semantics" combination. **Why not:** it has no wasm
target, and `libgo` is a native-OS runtime that switches goroutines via
native stack manipulation (`ucontext`/`makecontext`-style, split-stack
for growth) plus real threads and signals — none of which exist on
wasm. LLVM's generic wasm backend does not emit the resumable control
flow that makes goroutines possible on wasm; only the `gc` backend
does. So a gollvm→wasm route would require reimplementing gc-style
resumable codegen in LLVM **and** rewriting `libgo`'s scheduler **and**
porting `libgo`'s native OS deps to Kandelo **and** adding a wasm
target — strictly more work than the `gc` port, with cgo-on-wasm still
unsolved. The `gc` toolchain already ships the one wasm-hard piece
gollvm lacks.

### D. Generalize `wasm-fork-instrument` into a goroutine scheduler

Kandelo replaced Asyncify's role (for `fork`) with
`wasm-fork-instrument`, which is genuinely deeper than Asyncify:
selective (only the reverse-reachable fork slice; non-forking modules
pass through untouched), PC-precise `br_table` resume that skips
intervening side effects, variable-sized host-managed linked frames,
first-class reference/GC/exception reconstruction, cross-module resume,
and **already-coexisting per-worker/per-pthread continuations** with a
**parameterized** buffer pointer (`_wpk_fork_buf` is set from a
parameter each transition, not a fixed global). Its stack-serialization
*substrate* is a legitimate, reusable foundation.

**Why not, for this port:** two independent reasons.

1. **It serializes the wasm call stack, which is the wrong layer for
   `gc` Go.** The `gc` backend keeps goroutine frames off the wasm call
   stack (in linear-memory Go stacks) and switches them with its own
   resumable codegen. So for the chosen `gc` port the tool is both at
   the wrong layer and **redundant** — the port needs no external
   coroutine engine.
2. **Even where it is the right layer (call-stack-frame toolchains like
   TinyGo/gollvm), the engine is fork-shaped, not switch-shaped.** It
   is one-directional (leaf→seed), one-shot (rewind *consumes* the
   continuation: frame nodes go `Reserved→Committed→Consumed`),
   triggered only by the `fork()` import, with suspension points only
   at fork-reaching call sites, and it is built around
   **clone-then-reinstantiate** (a fresh child Store, references rebuilt
   via recipes). A goroutine scheduler needs the opposite: repeatable,
   re-entrant, **in-instance** switching with many simultaneously live
   continuations, arbitrary suspension points, and a scheduler/driver
   API. That is a fundamental rebuild of the driver and lifecycle on
   top of the reusable substrate — not an expansion.

Where it *would* pay off: a Kandelo-native, ban-compliant Asyncify
replacement for the **TinyGo** path (alternative B), or a
language-agnostic Kandelo coroutine primitive. Both are independent
platform investments, irrelevant to the `gc` port chosen here.

---

## Validation plan

Per `docs/agent-guidance/validation.md`, evidence must match the claim.
Milestone-specific validation:

- Each milestone runs the concrete success program above under
  `scripts/dev-shell.sh`, on both Node and browser hosts where the
  behavior is host-observable (host-runtime parity is a contract).
- The threads milestone (3) is validated against the Go runtime's own
  concurrency tests and observable parallelism, not just a smoke test —
  a passing single-threaded program does not prove the threaded
  scheduler.
- Networking (4) is validated with real dial + listen, not a stub that
  returns success.
- Any ABI-affecting choice (option 2 host import, or a new syscall)
  goes through the ABI snapshot process and an `ABI_VERSION` bump.
- No performance claims are made without benchmark evidence on both
  hosts.

This is multi-month, frontier work. The honest framing is that
milestones 1–2 are a well-understood port of a known template
(`wasip1`), milestone 3 is genuinely novel runtime engineering, and
milestones 4–6 are platform integration. The project should be
sequenced and reported against these milestones rather than claimed
whole.
