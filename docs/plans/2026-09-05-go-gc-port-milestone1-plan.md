# Go `GOOS=kandelo` Port — Milestone 1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** A Go `hello world` built with a forked `gc` toolchain for
`GOOS=kandelo GOARCH=wasm` instantiates in a Kandelo process worker and
prints to stdout over the native channel-syscall ABI, exiting 0
(single-threaded, `GOMAXPROCS=1`).

**Architecture:** Fork the upstream Go `gc` toolchain, reuse the
`GOARCH=wasm` code generator unchanged, register a new `kandelo` OS,
add a minimal Kandelo runtime OS layer plus a minimal channel-syscall
backend, and modify `cmd/link` to emit an *admissible* module (imported
+ shared memory and the `__abi_version` marker). No threads, no
networking, no exec in this milestone.

**Tech Stack:** Go `gc` toolchain (pin `go1.25.6`), Go runtime/linker
internals (`runtime/`, `cmd/link/internal/wasm`, `cmd/internal/obj/wasm`,
`internal/syslist`, `cmd/dist`, `internal/platform`), Kandelo host
(`host/src/worker-main.ts`, `wasi-detect.ts`, kernel channel ABI in
`libc/glue/channel_syscall.c` and `crates/shared/src/lib.rs`), Node 24
under `scripts/dev-shell.sh`.

**Design reference:** `docs/plans/2026-09-05-go-gc-port-design.md`
(especially "Port strategy", "Syscall backend", "ABI marker and memory
model at link time", and the 2026-09-05 feasibility-gate result).

---

## Reader orientation (assume no Kandelo or Go-internals context)

- **Kandelo runs each process as a Wasm instance in a Web Worker.** It
  talks to a kernel (in its own worker) over a SharedArrayBuffer
  "channel": the program writes a syscall number + args into a shared
  memory region, signals the kernel with Wasm atomics, and blocks until
  the kernel writes the result back. There are **no Wasm imports** for
  syscalls. See `libc/glue/channel_syscall.c` for the C reference
  implementation of this handshake.
- **The host refuses inadmissible modules early.** A program module
  must (a) provide the memory as an *import* so the shared channel lives
  in the program's address space, and (b) carry an `__abi_version`
  marker matching the kernel (ABI 43). Stock Go output satisfies
  neither (feasibility gate, 2026-09-05).
- **Go's toolchain is self-contained.** It has its own compiler,
  assembler, and linker (`cmd/link`), and its own runtime; it does not
  use clang, musl, or `wasm-ld`. Adding an OS means adding Go source
  files named `*_kandelo.go` / `*_kandelo_wasm.go` and rebuilding the
  toolchain with `make.bash`.
- **The one thing we do NOT touch:** the `GOARCH=wasm` code generator
  (`cmd/compile/internal/wasm`, `cmd/internal/obj/wasm`) is
  OS-independent and already implements Asyncify-free goroutine
  switching. Reuse it unchanged except for the atomic-op addition in
  Task 6 if we take the pure-guest handshake route.

---

## Decisions (confirmed 2026-09-07)

1. **Where the Go fork lives.** A fork repo will be created on GitHub
   under the `kandelo-dev/` org. For milestone-1 prototyping, start
   from a local upstream clone at `../go-kandelo` (outside the Kandelo
   repo) and push it to the `kandelo-dev/` fork once that repo exists;
   productionize the committed pinning contract (patch series against a
   pinned source, mirroring `libc/musl`) after milestone 1 lands. Do
   NOT commit a multi-MB Go tree into the Kandelo repo.
2. **Channel handshake mechanism (Task 6).** Attempt Option 1 (pure-
   guest atomic handshake; preserves the zero-import contract; needs a
   wasm backend atomic-op addition). If the backend work balloons, land
   Option 2 (a minimal temporary host import) behind an explicit,
   documented temporary boundary and file the follow-up. Option 2 is
   ABI-visible and requires an ABI review.
3. **Pinned Go version: `go1.25.6`.** This is the version the design's
   file/line hook points were verified against, so pinning to it keeps
   this plan accurate. (Note: as of 2026-09-07 a newer stable Go may
   exist; the assistant's knowledge cutoff predates confirming that.
   The installed toolchain is `go1.25.6`.) Rebase the fork forward to
   the latest stable once milestone 1 works, re-verifying hook points
   at that time.

---

## Prerequisites / environment

- A bootstrap Go to build the fork. `go1.25.6` is installed
  (`/opt/homebrew/Cellar/go/1.25.6/libexec`). `make.bash` bootstraps
  from an existing Go.
- Kandelo provisioning for the end-to-end run (Task 8): a built
  `kernel.wasm` and `npm install`. Build these under
  `scripts/dev-shell.sh` (`./run.sh setup` builds musl + kernel). Do
  this once, before Task 8, not earlier.
- Wasm inspection tooling: `wasm-tools` and/or `wasm-objdump` (check
  availability in the dev shell; the feasibility gate used them).

---

## Task 1: Vendor and build an unmodified Go fork (baseline)

Establish that we can build the toolchain at all before changing it.

**Files:**
- Create: the Go fork tree at the location chosen in Decision 1 (e.g.
  `../go-kandelo`), checked out at the pinned tag.

**Step 1:** Clone/checkout the pinned Go source (Decision 3) to the
chosen location. Record the exact commit/tag in this plan file.

**Step 2:** Build the toolchain:
`cd ../go-kandelo/src && GOROOT_BOOTSTRAP=$(go env GOROOT) ./make.bash`
Expected: builds `../go-kandelo/bin/go` with no errors.

**Step 3:** Sanity-check an existing target builds and runs a hello
world for the host platform:
`../go-kandelo/bin/go run .context/go-gate/hello.go`
Expected: prints the hello line, exit 0.

**Step 4:** Confirm the stock `wasip1` target still builds (we will
mirror it):
`GOOS=wasip1 GOARCH=wasm ../go-kandelo/bin/go build -o /tmp/w.wasm .context/go-gate/hello.go`
Expected: succeeds; `/tmp/w.wasm` exists.

**Step 5:** No commit to the Kandelo repo yet (the fork is external).
Record the baseline commit hash of the fork in this plan.

---

## Task 2: Register `GOOS=kandelo` (deterministic)

Exact hook points, verified against go1.25.6. This task makes
`GOOS=kandelo GOARCH=wasm` a recognized target that the toolchain will
attempt to build (it will fail to link until later tasks — that is
expected).

**Files (in the Go fork):**
- Modify: `src/internal/syslist/syslist.go` — add `"kandelo": true` to
  `KnownOS` (near the `"wasip1": true` entry). Decide `UnixOS`
  membership: add `"kandelo": true` to `UnixOS` **only** if we intend
  `//go:build unix` stdlib files to apply; default to adding it, but
  audit fallout in Task 3.
- Modify: `src/cmd/dist/build.go` — add `"kandelo"` to the `okgoos`
  slice.
- Modify: the generator that produces `src/internal/platform/zosarch.go`
  (do NOT hand-edit the generated file). Add the `{"kandelo","wasm"}`
  `OSArch` pair and a `distInfo` entry (empty literal → `CgoSupported`
  stays `false`, which is correct). Regenerate, then confirm the
  generated `zosarch.go` contains `{"kandelo", "wasm"}: {}`.

**Step 1:** Make the three edits above.

**Step 2:** Rebuild the toolchain: `cd src && ./make.bash`. Expected:
builds without complaint about an unknown GOOS.

**Step 3:** Verify recognition:
`GOOS=kandelo GOARCH=wasm ../bin/go env GOOS GOARCH`
Expected: prints `kandelo` and `wasm`.

**Step 4:** Confirm cgo is reported unsupported (sanity):
a small `go/build` or `internal/platform` check, or observe that
`CGO_ENABLED=1 GOOS=kandelo GOARCH=wasm ../bin/go build` refuses cgo.
Expected: cgo not supported.

**Step 5:** Commit in the fork:
`git commit -am "kandelo: register GOOS=kandelo for GOARCH=wasm"`.

**Note:** After this task, `GOOS=kandelo GOARCH=wasm go build` of a
trivial program will fail — expected, because there are no
`runtime/*_kandelo.go` files yet. That failure mode is the entry point
to Task 3.

---

## Task 3: Minimal runtime OS layer that compiles

Create the `kandelo` runtime files mirroring the `wasip1` set, with the
syscall backend **stubbed** so the runtime compiles and links far
enough to reveal the next real gap. Do not implement real syscalls yet.

**Files (in the Go fork), mirroring the `*_wasip1.go` set:**
- Create: `src/runtime/os_kandelo.go` (mirror `os_wasip1.go`:
  `osinit` support, `walltime`/`nanotime1`, `readRandom`, `exit`,
  `write1`/`fd_write` equivalent — stubbed to `throw` or trap for now).
- Create: `src/runtime/lock_kandelo.go` (mirror `lock_wasip1.go`:
  `notetsleepg` cooperative version; keep single-M assumptions for this
  milestone).
- Create: `src/runtime/mem_kandelo.go` (mirror `mem_wasip1.go`; likely
  just `resetMemoryDataView()` no-op — memory OS hooks come from the
  shared `mem_sbrk.go`, which already builds for `wasm`).
- Create: `src/runtime/rt0_kandelo_wasm.s` (mirror
  `rt0_wasip1_wasm.s`).
- Audit/possibly create: `src/syscall/*_kandelo.go` counterparts of
  `syscall_wasip1.go`, `fs_wasip1.go`, `net_wasip1.go`,
  `os_wasip1.go`, `tables_wasip1.go`. For this milestone, provide the
  minimum that compiles; real bodies land in Task 6 and later
  milestones.

**Step 1:** Copy each `wasip1` file to its `kandelo` name, switch the
build constraint to `kandelo`, and replace the WASI-import syscall
bodies with clearly-marked `throw("kandelo: syscall not yet
implemented")` stubs (except the ones Task 6 will implement).

**Step 2:** Iteratively build and fix compile errors:
`GOOS=kandelo GOARCH=wasm ../bin/go build -o /tmp/k.wasm .context/go-gate/hello.go`
Work the error list down until it either links or fails **only** in the
linker (Task 4/5) rather than the compiler. Record which files the
`unix` build tag pulled in (Decision on `UnixOS`) and whether any are
inappropriate for wasm; narrow `UnixOS` if needed.

**Step 3:** Expected end state for this task: compilation of the Go
program and runtime succeeds; the failure (if any) is now in linking or
at runtime (a syscall stub `throw`), not a missing-OS compile error.

**Step 4:** Commit in the fork:
`git commit -am "kandelo: minimal runtime OS layer (stubbed syscalls)"`.

---

## Task 4: `cmd/link` — imported + shared memory and `__abi_version` (the internal gate)

**This is the highest-uncertainty task and the internal gate for the
milestone.** We do not yet know the exact diffs; this is a spike
followed by implementation. Be honest in the writeup: record findings
before writing code.

**Files (in the Go fork):**
- Investigate then modify: `src/cmd/link/internal/wasm/asm.go` (and
  neighbors in `cmd/link/internal/wasm/`). This is where the Wasm
  module's memory section, imports/exports, and custom sections are
  emitted.

**Step 1 (spike):** Read `cmd/link/internal/wasm/asm.go` and map
exactly where it (a) emits the memory section and its `memory` export,
(b) emits imports, (c) emits globals/exports, (d) could emit a custom
section. Write findings (functions + line ranges) into this plan file
before editing. Cross-reference how Kandelo expects memory to be
imported (module/field name, shared flag, min/max) — see how existing
Kandelo programs are linked (`docs/sdk-guide.md` `--import-memory
--shared-memory --max-memory`, and `host/src/worker-main.ts` /
`wasi-detect.ts` `wasiModuleImportsMemory` for the exact import name the
host looks for, e.g. `env.memory`).

**Pinned native-program admission contract (2026-09-07 spike, with
`host/src` + `libc/glue` evidence).** For the host to instantiate and
accept a native (non-WASI) program:

- **Import `env.memory`** — memory, `shared`, max `16384` pages (1 GiB;
  64 KiB pages). The host creates the shared `WebAssembly.Memory`
  (`host/src/process-memory.ts:314-318`, max 16384) and supplies it as
  `env.memory` (`host/src/worker-main.ts:2358`); the module's declared
  `min` is honored as a floor (`process-memory.ts:123-181`). This
  replaces Go's default defined+exported memory.
- **Export `__abi_version`** as a **function `() -> i32` whose body
  reduces to `i32.const 43`** (value = `crates/shared/src/lib.rs`
  `ABI_VERSION`). The host **byte-parses an exported FUNCTION** named
  `__abi_version` and follows at most one `call` wrapper
  (`host/src/constants.ts:2767-2938`, `worker-main.ts:3145-3176`); it
  never calls the export. A **global** named `__abi_version` does NOT
  satisfy the parser. Mismatch hard-fails; absence only warns.
- **Export `_start`** (reactor entry; already emitted by Go). Both are
  the required executable exports (`host/src/binary-resolver.ts:49`).
- The native path **does not stub imports**: any import the host cannot
  resolve (`wasi_snapshot_preview1.*`, unexpected `env.<fn>`, unknown
  `kernel.*`) is a hard `LinkError` (`worker-main.ts:2314-2333`). Our
  Task-3 stubs import nothing; Task 4 must not introduce stray imports.
- **Omit** the `kandelo.abi.contract` custom section — warn-only when
  missing, but a present-but-wrong digest hard-fails.

To *function* (Task 6, not needed for admission) the module must also
import `env.__channel_base` (mutable `i32` global; every syscall reads
it) and `kernel.kernel_exit` (`(i32)->()`). Neither is required merely
to instantiate/admit, so Task 4 does not add them.

**Task-6 wrinkle surfaced here:** `env.__channel_base` is an *imported
Wasm global*. Go has no mechanism to import a wasm global into runtime
code (`//go:wasmimport` covers functions only). Task 6 must add a
linker/runtime path to read it (emit the global import + a runtime
intrinsic) or obtain the channel base another way (e.g. a kernel
function import). Decide within Task 6.

**Step 2:** Implement: change the linker to **import** memory (`env`/
`memory`, `shared`, `max=16384`) instead of defining+exporting it, for
`GOOS=kandelo`. Guard the change so other targets are unaffected.

**Step 3:** Implement: emit the `__abi_version` marker the host checks.
Confirm the exact form the host requires (an exported global? a custom
section? both?) by reading the host admission path
(`host/src/worker-main.ts` and the ABI constants in
`crates/shared/src/lib.rs` / generated TS). Match that form exactly for
ABI 43. Record the required form in this plan.

**Step 4:** Rebuild toolchain (`./make.bash`) and relink the hello
world:
`GOOS=kandelo GOARCH=wasm ../bin/go build -o /tmp/k.wasm .context/go-gate/hello.go`

**Step 5 (verify the module shape):** Inspect `/tmp/k.wasm`:
- `wasm-tools print /tmp/k.wasm | grep -E "import|memory|__abi_version"`
- Expected: memory is **imported** (not exported), marked shared with a
  max; the `__abi_version` marker is present in the form the host
  requires. Compare against a known-good Kandelo C program's module
  shape.

**Step 6:** Commit in the fork:
`git commit -am "kandelo/link: import shared memory and emit __abi_version"`.

---

## Task 5: Host admits the module (host-side test)

Prove the module now passes Kandelo's pre-instantiation guard — the
exact check that rejected stock Go in the feasibility gate.

**Files (in the Kandelo repo):**
- Test: add a focused check, ideally reusing `host/test/` helpers
  (`host/test/wasi-shim.test.ts`, `host/test/centralized-test-helper.ts`),
  or a small script under `.context/` that imports the real
  `wasi-detect`/`worker-main` guard logic.

**Step 1 (write the failing check):** Point the guard/admission logic
at the pre-Task-4 module (or assert on the message) to confirm the
guard still rejects an exported-memory module — establishing the test
detects the condition.

**Step 2:** Run it. Expected: it reports rejection for the old shape
(the `worker-main.ts:3208-3214` throw / memory-import check).

**Step 3:** Point it at `/tmp/k.wasm` (Task 4 output). Expected: the
memory-model guard **passes** (module imports memory). Note: it may now
fail *later* (missing/incorrect `__abi_version`, or at first syscall) —
that is progress, and tells us the next gap.

**Step 4:** Iterate Task 4 ↔ Task 5 until the module clears the memory
guard and the `__abi_version` admission check.

**Step 5:** Commit the host-side test in the Kandelo repo:
`Test: admit a Kandelo-linked Go module past the memory/ABI guard`.

---

## Task 6: Minimal channel-syscall backend (`write`, `exit`, `clock`, `random`)

Implement the real channel handshake for the few syscalls a hello world
needs.

### Pinned channel protocol (2026-09-07 spike, `crates/shared/src/lib.rs` `mod channel` + `libc/glue/channel_syscall.c`)

Per-instance channel region layout:

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | `status` (u32) — the **atomic** slot |
| 4 | 4 | `syscall_number` |
| 8 | 48 | `args[6]`, each i64 (args are i64 even on wasm32) |
| 56 | 8 | `return_value` (i64) |
| 64 | 4 | `errno_value` (i32) |
| 68 | 4 | `request_flags` (u32; 0 for plain syscalls) |
| 72 | 65536 | `data_buffer` |

`ChannelStatus`: `Idle=0, Pending=1, Complete=2, Error=3`. Handshake
(`__do_syscall_impl`, `channel_syscall.c:843-920`): plain-store
number+args; `atomic.store` PENDING on `status`; `memory.atomic.notify`
(count 1); `memory.atomic.wait32` (expected PENDING, timeout -1); read
`return_value`/`errno_value`; `atomic.store` IDLE. Return to musl form
`err ? -err : result`.

Syscall numbers are **Kandelo's own, not Linux**: `write=4`,
`exit=34` (routed to the `kernel.kernel_exit` function import, not the
channel), `clock_gettime=40`, `getrandom=120`.

The three required atomic ops on `status`: `i32.atomic.store`
(`0xFE 0x17`), `memory.atomic.notify` (`0xFE 0x00`),
`memory.atomic.wait32` (`0xFE 0x01`) — all require a **shared** memory
(Task 4 imports one) and the wasm threads/atomics feature.

### Decision record: Option 1 vs Option 2 (revisit if Option 1 stalls)

Two ways to perform the handshake. **We are pursuing Option 1**; Option
2 is the documented fallback.

**Option 1 — pure-guest atomics (preserves the zero-import native
contract; chosen).** The Go runtime performs the handshake itself.
Requires:
- Adding the three `0xFE` atomic opcodes to Go's wasm assembler
  (`src/cmd/internal/obj/wasm/a.out.go` opcode enum + `anames.go` + a
  new `0xFE`-prefix branch in `writeOpcode`, `wasmobj.go:1418-1438`,
  with memarg encoding: align = log2(access size) = 2 for wait32/notify
  on i32). Go's wasm backend has **no** atomic opcodes today
  (`internal/runtime/atomic/atomic_wasm.go` is all plain access), so
  this is new capability, not a toggle.
- A runtime helper (hand-written `.s`, or an SSA intrinsic) that emits
  those ops for the `status` slot.
- Solving `__channel_base`: it is an imported wasm **global**, and Go
  cannot import a global. Path with no host change: synthesize a
  `__tls_base` export so the host's `setupChannelBase`
  (`host/src/worker-main.ts:4694-4733`) writes `channelOffset` into
  linear memory (at `__tls_base + 0` when `__get_channel_base_addr`
  detection fails), and read it from there in the runtime. (Go does not
  use the clang `__tls_base` TLS model, so this needs linker synthesis.)
- Ensuring the module validates with the atomics feature enabled (the
  memory is already shared from Task 4; confirm the threads feature /
  `target_features` is acceptable to the host).
- Pros: no host change, no ABI bump, Go stays structurally identical to
  C programs (zero syscall imports), and the atomic-opcode work is
  **needed anyway** for the threads milestone (milestone 3).
- Cons: unproven; touches the wasm backend and linker; the
  `__channel_base` acquisition is fiddly for Go.

**Option 2 — host function import (fallback).** Add a general host
import `kernel_channel_syscall(n, a1..a6) -> i64` implemented like the
existing `kernel_clone`/`kernel_exit` (`worker-main.ts:480-559`), which
do the write+`Atomics.store/notify/wait`+read entirely in JS, closing
over `channelOffset`. Go declares `//go:wasmimport kernel
kernel_channel_syscall` and calls it.
- Pros: zero assembler work, zero guest atomics, no `__channel_base`
  needed; reuses a proven, tested host pattern; Go-native mechanism.
- Cons: a host-runtime change (Node **and** browser), an **ABI bump
  (43->44)** + regenerated snapshot, and Go programs carry a
  `kernel.kernel_channel_syscall` import that C programs don't (a
  documented divergence from the zero-import native contract). The
  import is a *general* syscall-submit primitive, so it is an honest
  platform capability, not program-specific behavior.

**Chosen:** Option 1 (2026-09-07), to preserve the zero-import contract
and because the atomic-opcode work is required for milestone 3 anyway.
Fall back to Option 2 if the backend/`__channel_base` work stalls.

### Steps

**Step 1:** Add the three atomic opcodes to the wasm assembler and a
runtime helper that emits them; write a tiny test that assembles a
function using them and confirm `wasm-tools validate` accepts the
module (with the atomics feature).

**Step 2:** Implement `__channel_base` acquisition for Go (synthesize
`__tls_base` export; verify the host's `setupChannelBase` writes the
offset where the runtime reads it).

**Step 3:** Implement the handshake helper in the runtime (marshal
number + args, atomics on `status`, read result/errno) and wire
`write` (4), `clock_gettime` (40), `getrandom` (120) through it; route
`exit` (34) to the `kernel.kernel_exit` import.

**Step 4:** Rebuild toolchain; rebuild hello world; verify shape.
Full end-to-end run is Task 8 (needs kernel provisioning).

**Step 5:** Commit in the fork.

**Note:** this is exploratory — the goal is to make real progress on
Option 1 and learn where it resists. Record findings (esp. the
`__channel_base` mechanism that actually works and the atomics-feature
validation result) back into this file.

### Progress log

**2026-09-07 — Step 1 (atomic opcodes) done (fork `7dff620`).** Added
`AMemoryAtomicNotify` (`0xFE 00`), `AMemoryAtomicWait32` (`0xFE 01`),
`AI32AtomicStore` (`0xFE 17`) to `cmd/internal/obj/wasm/a.out.go` +
`anames.go`, and a `0xFE`-prefix branch in `wasmobj.go` `writeOpcode`
with memarg encoding (align=2 for i32). Emitted via a hand-written `.s`
helper; module `wasm-tools validate`s by default (threads is default-on
in wasm-tools; only fails with `-threads`, and then at the *shared
memory* decl, not the atomic ops). `wasip1`/`js` unaffected; `go test
cmd/internal/obj/wasm` passes.
- **`target_features` finding:** NOT needed for validation or engine
  execution (engines gate on the memory being shared + host enabling
  threads/SharedArrayBuffer). Go's linker doesn't emit one. Add a
  `writeTargetFeaturesSec` only if a downstream Kandelo pipeline tool
  consumes it — not required for milestone 1.

**Discovered blocker (prerequisite, affects Task 7):** the
`GOOS=kandelo` port's `runtime.main` does not reach `main.main` — a
trivial kandelo program keeps `runtime.main` but DCEs the user `main`
package (it survives under `GOOS=js`). So no kandelo program's `main`
runs today, independent of syscalls. Must be fixed before any
end-to-end run. Likely a linker DCE-root / entry-wiring difference for
the new GOOS (compare against how `js`/`wasip1` keep `main.main`).

**Revised next steps for Option 1:** (A) fix `runtime.main -> main.main`
[prerequisite, Task 7/Task 3]; (B) `__channel_base` acquisition for Go
(synthesize `__tls_base` export; host `setupChannelBase` writes the
offset; read it in the runtime); (C) handshake helper using the atomic
opcodes + wire `write`/`clock_gettime`/`getrandom`, route `exit` to
`kernel.kernel_exit`; (D) Task 8 end-to-end (needs `./run.sh setup`).

**2026-09-07 — MILESTONE 1 COMPLETE (Option 1, fork `7ac5bb3`).** A Go
`println("hello, kandelo")` built with `GOOS=kandelo GOARCH=wasm` runs
through the real `CentralizedKernelWorker` and prints, exit 0.
Independently reproduced via a vitest smoke test
(`runCentralizedProgram({programPath:"/tmp/k.wasm", useDefaultRootfs:
false})`): `exitCode: 0`, `stderr: "hello, kandelo\n"` (`println` writes
fd 2). Every stage passed: instantiation (imports `env.memory` shared +
`kernel.kernel_exit`; `__abi_version`=43 matched), channel-base via
`__tls_base` (host wrote the offset into `runtime.kandeloChannelBase` at
0xDB2B8), `write`=4 through the atomic handshake, `clock_gettime`=40 +
`getrandom`=120 during init, clean `kernel_exit`. Option 1 (pure-guest
atomics, zero-import contract preserved) validated end-to-end; Option 2
not needed. Prereqs built: `libc/musl` submodule init'd, `kernel.wasm`
(ABI 43), `npm ci`. (`./run.sh setup` full rootfs is NOT required for a
bare program; its failure was a transient upstream 502 fetching the
`make` package.)

**LATENT RISK — channel-region placement (fix before heavier programs).**
The host pins the channel region at a fixed 16 MiB (Go exports no
`__heap_base`, so the host uses `PROCESS_MEMORY_FALLBACK_BRK_BASE` = 16
MiB; channel at page 257 = 0x1010000). Go assumes it owns linear memory
from `runtime.end` upward and grows its heap into that space with
nothing reserving the channel pages. hello-world (~1.9 MiB) is far below
16 MiB so no collision, but a program whose live heap grows past ~16 MiB
will grow memory across the channel pages and corrupt the syscall
channel. Fix options: have the kandelo runtime reserve the channel
region (learned from `kandeloChannelBase`) so the allocator avoids it,
or export `__heap_base`/place the channel above Go's reservation. This
is the top follow-up.

**2026-09-07 — MILESTONE 2 (real stdlib) — `fmt.Println` + file I/O run
(fork `03d847f`, header fix `c3aeba7`).** Independently reproduced:
`fmt.Println("hello, kandelo")` prints on **stdout** (fd 1), exit 0, via
the real path `fmt` -> `os.Stdout.Write` -> `internal/poll.FD.Write` ->
`syscall.Write` -> channel `write`. File I/O verified with a mounted VFS:
`os.ReadFile("/etc/hostname")` drives `openat`->`fstat`->`read`->`close`
over the channel and returns the bytes; a missing path returns a correct
`ENOENT`. Changes: generalized the runtime handshake to `doSyscall6` and
`//go:linkname`d it into `syscall` (`syscall.kandeloSyscall6`);
implemented the `fs_kandelo.go` leaves (`Write`/`Read`/`Pread`/`Pwrite`/
`Close`/`Seek`/`Fsync`/`Fstat`/`Ftruncate`/`getrandom`) plus
`Open`/`Openat`/`Stat`/`Lstat` via kernel `openat`/`fstatat`; added
`internal/poll`/`os`/`time`/`internal/syscall/unix` `*_kandelo.go` peers.
No new wasm imports (still only `env.memory` + `kernel.kernel_exit`);
`wasip1`/`js` unaffected.
- **Key learning:** the Kandelo channel speaks **Linux/musl syscall
  numbers AND errno values** (musl `__NR_write==4`; errno slot is generic
  musl numbering) — required rewriting the kandelo errno table off WASI
  numbering. Paths/buffers are read **directly from linear memory via raw
  pointers** (NUL-terminated), so no `data_buffer` copy is needed.
- **Remaining gaps for real CLIs:** `os.Args`/environ are empty (need a
  host argc/argv mechanism — likely the `kernel_get_argc`/`kernel_argv_*`
  imports); `usleep`/timers stubbed; path-mutating ops
  (`Mkdir`/`Unlink`/`Rename`/`Chdir`) still ENOSYS; no netpoll
  (synchronous blocking channel); plus the channel-vs-heap 16 MiB risk.

**2026-09-07 — Real CLIs: `os.Args`/environ + path-mutating fs
(fork `c1f2888`).** Independently reproduced: a program run with
`argv:["prog","alpha","beta"]` prints `args: [prog alpha beta]`,
`cwd: /`, and `mkdir`/`write`/`read`/`rename`/`rm`/`rmdir` all succeed
(`<nil>`) against real kernel state, exit 0. `os.Args`/`os.Environ` come
from the host `kernel_get_argc`/`kernel_argv_read`/
`kernel_environ_count`/`kernel_environ_get` function imports (two-step
length-query-then-copy, no trailing NUL) wired into `runtime.goenvs`;
path ops (`mkdirat`/`unlinkat`+`AT_REMOVEDIR`/`renameat`/`chdir`/
`getcwd`/`chmod`/`truncate`/`linkat`/`symlinkat`/`readlinkat`/
`utimensat`) route through `kandeloSyscall6`, and
`internal/syscall/unix/at_kandelo.go` was rewritten to drop the WASI
`path_*` imports. Imports are now `env.memory` + 5 `kernel.*` functions,
zero WASI; validates; `wasip1`/`js`/native `std` still build. Remaining
std gaps (no kandelo port yet): `net`, `os/signal`, `path/filepath`,
`crypto/internal/sysrand`; `Chown` is honest ENOSYS.

**2026-09-07 — Channel-placement hardening (fork `0794818`).**
Guest-only fix, no host change. (1) Linker synthesizes a `__heap_base`
export (= `runtime.end`), so the host drops the channel from the fixed
16 MiB fallback to just above Go's data (`host/src/process-memory.ts`
`computeProcessMemoryLayout` reads `__heap_base`). (2) Runtime starts
Go's break at `blocMax` (top of the host's initial linear memory) so the
heap grows entirely ABOVE the channel; ~1.1 MiB reserved (mostly Go's
own 1 MiB linker init headroom). Rejected the alternatives (freelist
"hole" / 16 MiB placement) as brittle host-layout coupling or ~14 MiB
waste. Independently reproduced: a program allocating 64 MiB then doing
file + stdout syscalls exits 0 with `match: true` and `read:
channel-ok` (no corruption). Exports now include `__heap_base` (global
9) beside `__tls_base`; validates; `wasip1`/`js`/native unaffected; no
ABI bump (`__heap_base` is a guest export the host already consumes).
**Residual risk for MILESTONE 3 (threads):** the host would place a
dynamic pthread thread-slot at `firstThreadSlotPage`, which now equals
where the Go heap starts — so real wasm threads will collide with this
layout and the memory model must be reworked as part of the threads
work. (Go is single-M today; `newosproc` throws, so no thread slot is
requested.)

**2026-09-07 — MILESTONE 3 (threads) Phases 1-2 done.**
*Phase 1 — real atomics (fork `f3d46f3`).* Added the `0xFE` atomic RMW
opcode set (loads/stores/add/and/or/xchg/`cmpxchg`/`fence`) to Go's wasm
assembler and a kandelo-only real-atomics implementation
(`internal/runtime/atomic/atomic_kandelo.{go,s}`); `atomic_wasm.go`
gated to `wasm && !kandelo` so `js`/`wasip1` keep plain-access. A `sync/
atomic` program runs correct through the kernel (`add:15`, `cas:true
100`, `swap:42 7`, `load:0xDEADBEEF`, `andor:15`), exit 0; no regression;
`js`/`wasip1` unchanged. (Note: two and/or sub-opcode bytes in the task
spec were wrong; spec-correct values used and proven by disassembly.
`StorepNoWB` stays a plain store — minor shared-memory pointer-store
soundness gap to revisit at multi-M.)
*Phase 2 — per-M `g` pivot CONFIRMED.* Live host experiment: two
`WebAssembly.Instance`s of one module over one shared `WebAssembly.
Memory` have independent mutable globals (`a=111`, `b=222`) while sharing
linear memory (`b` reads `a`'s write `42`). So each Go M (its own
instance) gets its own `g`/`SP` globals for free with a shared heap —
the design's linchpin holds.
*Host-change/ABI verdict (2026-09-07): (A) NO host change, NO ABI bump.*
Go can drive the existing `centralizedThreadWorkerMain`/`onClone` clone
path with a guest-only delta. The only hard-required child export Go
lacks is `__indirect_function_table` (a one-line `writeExportSec`
addition; `worker-main.ts:5915-5920` throws without it). `__wasm_init_tls`
/`__wasm_thread_init`/`__stack_pointer` are all guarded/optional
(`worker-main.ts:5880-5900`); Go's per-M state is the per-instance wasm
globals SP/g, independent of musl TLS. `kernel_clone` is already a
provided host import (`abi/snapshot.json:1880`); no snapshot/`ABI_VERSION`
change. Per-M channel base: the host already delivers it per-instance via
the `env.__channel_base` imported global (`worker-main.ts:2422-2441`), so
the guest switches from the single-word `__tls_base` trick to importing
that global (needs Go linker/codegen to import + read a wasm global — the
one non-trivial guest-side item). Thread entry: `newosproc` calls
`kernel_clone(fnPtr=PC_F of an exported mstart trampoline, stackPtr,...)`;
host calls it via `table.get(fnPtr)()` (arity 0). Remaining true risks
(guest-side, Phase 4): (1) reading an imported wasm global from Go;
(2) whether the multi-M scheduler actually runs on wasm (unprecedented —
the real unknown, provable only by building it); (3) a heap-ceiling vs
host thread-slot-window memory partition; (4) `sbrk` stays under the
mheap lock. Concurrent `memory.grow` is engine-atomic/monotonic and the
host already handles view-detach — safe, not a blocker.

*Phase 4 is a genuine architectural + novel-runtime commitment; paused
for maintainer go/no-go before implementing.*

**2026-09-30 — Reconciled onto latest main (ABI 45); Phase 4 approved.**
Main advanced 58 commits since the port's baseline; `ABI_VERSION` went
43 -> 45 (the Wayland/DRI desktop stack — GPU buffers, evdev, SDL2 —
additive). Merged `origin/main` into the branch (clean; docs are new
files). Verified the Go-port-critical contracts are UNCHANGED: channel
region layout (all offsets identical), the syscall numbers the port uses
(Write=4, Exit=34, ClockGettime=40, Openat=69, Mkdirat=95, …),
`struct stat` field offsets (only `st_rdev@88` is now populated;
112-byte layout unchanged), the process-memory constants
(`PROCESS_MEMORY_DEFAULT_MAX_PAGES=16384`,
`PROCESS_MEMORY_FALLBACK_BRK_BASE=16 MiB`), `env.__channel_base` still a
process-expected global, and required executable exports still
`["__abi_version","_start"]` — so the Phase-4 host-change verdict still
holds. The thread-worker path changed only a guarded `__stack_pointer`
read (musl pthread vararg stack alignment), which does not affect Go.
**Only fork change needed:** the synthesized `__abi_version` marker
43 -> 45 (fork `3e1d28f`). Reused the sibling `rust-programs-on-kandelo`
worktree's fresh clean-main ABI-45 `kernel.wasm` (its `crates/kernel`/
`crates/shared` match `origin/main` exactly) instead of a duplicate
build. Independently verified `fmt.Println` runs against that ABI-45
kernel: exit 0, stdout `"hello, kandelo\n"`. (Benign: Go binaries lack
the `kandelo.abi.contract` digest stamp — currently warn-and-pass;
track in case that rollout later hard-fails.) Proceeding into Phase 4.

**2026-09-30 — MILESTONE 3 breakthrough: a 2nd M runs (fork `6e0ba54`).**
First gc-Go wasm port to run a second M. Independently reproduced: a Go
`GOOS=kandelo` program spawns a 2nd OS thread via the real kernel path
(`//go:wasmimport kernel kernel_clone` -> kernel `sys_clone` -> host
`centralizedThreadWorkerMain` -> `table.get(PC_F)()`); the new instance
bootstraps its OWN `g`/`SP` and per-M channel base and performs an
observable channel syscall. Output: stdout `"M1: before spawn\nM1: after
spawn\n"`, stderr `"M2 alive via kernel_clone\n"`, exit 0, zero host
diagnostics (no corruption).
- *Phase 4a (fork `04dd1235e`):* exported `__indirect_function_table`,
  per-M `mOS.channelBase`, `wasm_pthread_start` trampoline; single-M
  intact.
- *Phase 4b (fork `6e0ba54`):* (A) bootstrap — a hand-written wasm-asm
  entry `wasmThreadTramp` installs `g` (global 2) and `SP` (global 0)
  from handoff words before any Go code (the `//go:wasmexport` wrapper
  can't be used: it starts with `global.get SP; i32.eqz; call
  notInitialized`); the trampoline must return the entry's i32 to pass
  `WebAssembly.validate`. (B) `newosprocKandelo` writes `g0`/stack to a
  shared handoff under `kandeloCloneLock`, computes
  `PC_F = FuncPCABI0(wasmThreadTramp)>>16` (never hardcoded), and calls
  `kernel_clone` with `CLONE_VM|FS|FILES|SIGHAND|THREAD|SYSVSEM`
  (`tls/ptid/ctid=0`; kernel `sys_clone` requires `VM|THREAD` and gates
  TID/TLS writes behind `SETTLS`/`CHILD_CLEARTID`). (C) per-instance
  wasm globals give per-M `g`/`SP` for free (proven). No imported
  global; `wasip1`/`js` unaffected.

**FUNDAMENTAL DECISION SURFACED — memory partition for many Ms.** Two
allocators share one linear memory: Go's heap grows up from `blocMax`,
and the host thread-slot allocator marches up from `firstThreadSlotPage`
— which sits just below Go's heap. They converge after ~3 threads. The
mechanics milestone holds (slot 0 landed in the forfeited gap below the
heap), but the FULL scheduler (GOMAXPROCS Ms, and extra Ms spawned when
blocking channel syscalls park a worker) needs this resolved. The host
already supports the fix: `computeProcessMemoryLayout` honors
`preallocateThreadSlots` + `threadSlotCount` (reserving the slot arena
below the heap, bounding the allocator via `maxPageExclusive`). The Go
module now exports `__wasm_posix_thread_slots=8`. Resolving it cleanly
means a **host launcher change** (Node+browser) to pass
`preallocateThreadSlots:true` + the guest count — crossing the "no host
change" line the thread-*entry* verdict established, and touching the
process-memory-layout (ABI-adjacent). A guest-only alternative (Go
reserves the arena in its heap-start computation) cannot bound the
host's allocator by itself, so it is not sufficient alone. Paused for
maintainer decision before making the host change.

*Full-scheduler follow-up (after the memory decision):* swap the
trampoline marker for `mstart()` + make `newosprocKandelo` the real
`newosproc`; real per-M parking (`notesleep`/`futex` via `memory.atomic.
wait32`/`notify`); child-ack handshake so the single handoff slot
tolerates >1 in-flight spawn; `dropm`/`mdestroy` slot teardown.

**2026-10-06 — Phase 4 memory-partition work resumed (draft PR #1492).**
Merged current `origin/main` (ABI 47) and began an explicit opt-in
preallocated thread arena for the Go runtime. The earlier suggestion to
preallocate every binary with a positive slot count would also change
existing C pthread programs, including fork and vfork behavior. The
new `__wasm_posix_preallocate_thread_slots=1` declaration leaves their
dynamic layout intact. The host's shared process-memory calculation now
reserves the declared eight Go slots below `brk_base`; the thread
allocator takes ordinary Go M slots from that arena and keeps host-only
control workspaces separate. The ABI snapshot and Go linker's marker
are moving together at ABI 48. The Go fork is now published at
`https://github.com/kandelo-dev/go`, branch `kandelo-port`, commit
`96e1169` (upstream base `go1.25.6`).

**2026-10-06 — Phase 4 memory-partition validation.** Rebuilt the fork
with `make.bash` using Go 1.25.6, then built the existing second-M
probe. Node 24 accepted the resulting Wasm (`WebAssembly.validate`
returned true) and found `__abi_version`,
`__wasm_posix_thread_slots`, and the new preallocation export. A
temporary Vitest through the real `NodeKernelHost` and the ABI-48
kernel returned exit 0, stdout through `M1: after spawn`, stderr
`M2 alive via kernel_clone`, and zero host diagnostics. The focused
layout, allocator, and host parity tests passed (32 total with the
temporary Go probe); the host TypeScript build and ABI snapshot check
also passed. The source is now checked in at `tests/go/second-m/`, with
an executable Node runner and reproduction steps; rebuilding and
running that checked-in fixture yielded the same exit 0 and markers.
This proves the opt-in arena preserves the two-M mechanics
probe, not that the full Go scheduler runs. Browser execution and broad
conformance remain unrun. The broad parser-suite attempt did not load
because a cached SpiderMonkey package artifact predates ABI 48; the
focused parser behavior is exercised by the synthetic Wasm layout
tests. Next: `mstart`, real parking, clone acknowledgment, teardown,
and observable parallel goroutines.

**2026-10-06 — Child-ack handoff (fork `bad577d`).** The parent now holds
the single-M clone lock until the child has consumed the shared `g0` and
stack-top words, captured its per-M channel base, and published an
atomic acknowledgment. A timed `memory.atomic.wait32` fails loudly if
the new Worker never reaches the entry. The checked-in
`tests/go/clone-handoff/` probe requests five Ms in sequence; each
acknowledged child emitted its marker through its own channel. The Node
run returned exit 0, five markers, and zero host diagnostics. This
proves repeated handoff reuse, not concurrent spawns from different Ms:
`lock_kandelo.go` still lacks a cross-thread atomic mutex, and the
child still exits without running `mstart`. Both remain Phase-4 work.

**2026-10-06 — Parallel scheduler slice (fork `973fd0a`).** Replaced the
single-M runtime mutex and note stubs with Wasm atomic compare/exchange,
`memory.atomic.wait32`, and `memory.atomic.notify`; a user-G note wait now
releases its P through `entersyscallblock`. `GOMAXPROCS(2)` is no longer
clamped on Kandelo. A cloned M with a P enters `mstart`, and its trampoline
continues through `wasm_pc_f_loop` after a goroutine switch. The previous
trampoline returned to the host on the first switch, so the M could reach
`execute` but never run the selected G. The no-P clone marker remains as a
separate mechanics path.

The first parallel probe intermittently printed completion but never
exited. Tracing showed `runtime.main` can finish on a worker M, where the
host's `kernel_exit` import issues thread-only `SYS_EXIT`. Go now commits
`SYS_EXIT_GROUP` before that non-returning import. Clock syscall output was
also moved from one shared package buffer to per-M scratch, avoiding
cross-M writes. A minimal `osyield` return replaces the Wasm trap on the
Kandelo build.

The checked-in `tests/go/scheduler/` probe forces two goroutines to overlap
without cooperative yields; five consecutive Node runs exited 0 with
`GOMAXPROCS: 2`, `parallel M: complete`, and no host diagnostics. Its
`exit-worker/` companion keeps M0 busy while another M calls `os.Exit(0)`;
five consecutive Node runs exited 0 with its worker marker and no host
diagnostics. The existing five-clone handoff probe still exits 0 with five
markers and no diagnostics. These are focused Node proofs, not full Go
scheduler conformance. Browser execution, concurrent clone contention,
per-M exit/reaping (`exitThread` is still a Wasm trap), `LockOSThread`,
sysmon/preemption behavior, and broader runtime tests remain. No Kandelo
ABI or host source changed in this slice.

**2026-10-06 — Chromium browser milestone probes.** Added a small Go
stdlib/startup/file-syscall probe and `tests/go/build-browser-fixtures.sh` to
compile it alongside the existing second-M, five-clone, parallel-scheduler,
and worker-exit probes. `apps/browser-demos/test/go-port.spec.ts` runs all
five as real browser process workers through `BrowserKernel`, using a VFS
image assembled in the Playwright Node process and the ABI-48 kernel selected
by the source binary resolver. It asserts exit 0, output markers, exact
clone-marker counts, no host diagnostics, and no page or console errors.

The dedicated Chromium run passed all five tests in 30.5 seconds with one
Playwright worker. The suite is opt-in (`KANDELO_GO_BROWSER_TESTS=1`) because
the external Go fork is not part of default browser-test provisioning; see
`tests/go/README.md` for the exact commands. The normal browser test-runner
page was not used: this checkout lacks its rootfs artifact, and its bundled
`scripts/resolve-binary.sh` still rejects the freshly built kernel although
the source resolver accepts it. The focused browser tests therefore supply
source-resolved kernel bytes explicitly. This proves these five browser-host
paths, not the complete browser demo, full Go runtime conformance, or broad
POSIX behavior. Concurrent clone contention, individual-M exit/reaping,
`LockOSThread`, sysmon/preemption, and broader runtime tests remain.

**2026-10-07 — ABI-48 resolver bundle and concurrent clone/affinity slice.**
The shell resolver rejection was a stale generated
`scripts/resolve-binary.bundle.mjs`: it still embedded ABI 47 after this
branch raised the generated ABI to 48. Regenerating it made
`scripts/test-resolve-binary-bundle.sh` and
`scripts/resolve-binary.sh kernel.wasm` pass. This artifact must be committed
with the ABI-48 Go PR, not independently against ABI-47 `main`; the existing
package-system resolver test already detects bundle drift.

A new concurrent-clone probe forces two scheduler Ms to overlap while each
requests a no-P M, twice. Node and Chromium both completed four clone
handoffs with exact child markers and no host diagnostics, exercising the
atomic handoff lock from separate parents. An initial eight-clone Chromium
probe hit the declared eight-slot limit before departed no-P workers were
fully recycled (`active=8`); reducing the contention probe to four clones
isolates lock behavior without treating slot capacity as solved. Slot reuse
under sustained thread churn remains separate work.

The fork's `LockOSThread` path still returned early on every Wasm target.
Fork commit `3fae0fa` exempts Kandelo from that no-thread guard and from
the template-thread path, because a Kandelo clone starts a fresh Wasm
instance rather than inheriting the parent's thread-local host state. The
new locked-thread probe checks that the binding exists, remains on one M
through 64 scheduler yields, and clears on unlock. It exits 0 with no host
diagnostics in Node and Chromium; `GOOS=js` and `GOOS=wasip1` standard-library
builds still pass. All seven focused Chromium milestone probes pass.
Individual M termination/reaping when a locked goroutine exits without
unlocking remains unimplemented (`exitThread` still traps), as do sysmon,
preemption, and broader Go/stdlib conformance.

**2026-10-08 — Locked-M exit and paced thread-slot recycling.** A focused
Node probe first reproduced a locked goroutine's natural return as an
`exitThread` unreachable trap, killing its thread worker with status 132.
The fork now calls a Kandelo-specific `kernel_thread_exit` import from
`exitThread` (fork commit `8be9c5a`). The shared Node/browser host import
reads the Go runtime's
`freeWait` pointer while its g0 stack is still live, atomically marks the
stack reclaimable, then sends only `SYS_EXIT` for that M and traps out of
the disposable Worker. The existing `kernel_exit` path still handles
process-wide exit; no `EXIT_GROUP` is sent for an individual M. This host
handoff is necessary because a Go-generated Wasm import wrapper rereads
the stack after an assembly-side `freeWait` clear; the initial direct-call
prototype was discarded after disassembly showed that use-after-free risk.

The probe then ran twelve sequential locked-M exits with a 100 ms drain
interval between rounds, exceeding the eight-slot thread arena. Node and
Chromium both exited 0 with no host diagnostics, showing individual M
reaping and paced slot reuse on both hosts. All eight focused Chromium Go
probes pass. The host TypeScript check, focused startup-import Vitest tests,
ABI snapshot check, and `GOOS=js`/`GOOS=wasip1` standard-library builds also
pass. The new import is additive within this unreleased ABI-48 branch and
does not alter an existing import's signature or the ABI snapshot. This
does not prove unpaced burst churn, a larger thread arena, sysmon/preemption,
or full Go/runtime/POSIX conformance; the concurrent eight-slot boundary
observed on 2026-10-07 remains.

**2026-10-08 — Kandelo sysmon and cooperative preemption.** A new
`GOMAXPROCS=1` probe showed the prior runtime delayed a 100 ms timer until a
two-second busy goroutine finished. Fork commit `022ee37` enables Go's
sysmon thread, uses Wasm atomic timed wait for `usleep` rather than returning
immediately,
and sends no-P Ms with an `mstartfn` (including sysmon) through `mstart`
instead of the clone-mechanics probe path. The probe checks that the timer
fires while the busy goroutine is still active, with a primarily arithmetic
loop containing Go call safe points. The existing locked-M exit probe now
retries when sysmon preempts main and the goroutine initially lands on M0.

Six focused Node scheduler probes and all nine Chromium probes exited 0
without host diagnostics. After tightening the busy loop, the sysmon probe
passed three further Node runs; the final nine-probe Chromium suite passed
again. `GOOS=js` and `GOOS=wasip1` standard-library builds and the ABI
snapshot check passed. This is cooperative preemption at Go safe points,
not asynchronous interruption of a call-free Wasm loop:
`preemptMSupported` remains false.
The eight-slot capacity, unpaced thread churn, broader Go runtime tests,
and full POSIX conformance remain open.

**2026-10-08 — Upstream Go package tests and honest I/O boundary (fork
`2aa3c9e`).** The fork now compiles Go's `internal/runtime/atomic` and
`sync` test binaries
for Kandelo: it corrects the Wasm atomic-wait assembly signature, adds
Kandelo's `crypto/internal/sysrand` reader over `getrandom` (including
short-read and `EINTR` handling), and makes the existing Unix path,
signal, and test-environment helpers available to this target. The
`getrandom` path is exercised by the browser basic probe. The syscall
backend no longer reports success for unsupported nonblocking-flag changes;
`fd_fdstat_set_flags` returns `ENOSYS` until it and a real poller exist.

The upstream atomic package's short suite and selected `sync` tests
(`TestMutex`, `TestWaitGroup`, and `TestCondSignal`) pass through the real
Kandelo kernel in Node. They also have opt-in Chromium browser-host tests
alongside the nine existing milestone probes. The final eleven-probe
Chromium run passed in 1.1 minutes with exit 0 and no host diagnostics.
A wider short `sync` run
passes when subprocess-dependent `TestMutexMisuse` and examples are
excluded. The complete short suite does **not** pass: `TestMutexMisuse`
needs `os.Executable`/subprocess support, and `ExamplePool` needs a pipe.
An experimental `pipe2` bridge created the pipe but hung example capture:
the fork's existing fd-flags stub claimed nonblocking success without
changing kernel state, and the runtime still has a fake netpoller. That
bridge was removed rather than masking the missing scheduler/I/O contract.
The `runtime` test binary itself still cannot build because `net` lacks
Kandelo's `netFD`; networking/netpoll belongs to milestone 4. Full
runtime conformance, unpaced thread churn, a policy for CPU-count reporting
(Kandelo's current `sysconf` also reports one), and later networking,
subprocess, and package milestones remain open.
An unpaced 64-round locked-M experiment succeeded three times in Node but
exhausted the declared eight pthread slots in Chromium while exited Ms were
still live. The checked-in paced probe remains the supported claim; its
main goroutine now pins its M so a preemptive migration cannot invalidate
the worker-M identity check.

**2026-10-08 — Configurable Go pthread arena and burst churn (fork
`e27c900`).** The Go
linker's hardcoded eight-slot declaration was the immediate reason a
64-round locked-M burst exhausted the browser arena. The fork now defaults
to 32 preallocated slots (8 MiB of control pages) and accepts
`-ldflags='-kandelothreadslots=N'` for 1–1024 slots. The linker rejects
out-of-range counts; the host's source resolver reads both the default 32
and an explicit four-slot build correctly. No host layout or ABI changed.
The checked-in burst mode starts 64 locked worker Ms without pacing their
exits, alongside the existing twelve-round paced mode. The burst passed
three Node runs with exit 0 and no host diagnostics; the twelve-probe
Chromium suite also passed, including the burst; three further Chromium
burst repeats passed concurrently. `GOOS=js` and `GOOS=wasip1` standard
library builds and the ABI snapshot check passed. This proves slot reuse
under this workload with the larger declared arena, not unbounded Go thread
creation or complete runtime conformance. Programs demanding more concurrent
Ms must choose a larger count and budget its control memory. The runtime
test binary remains blocked on the missing `netFD`, and CPU-count reporting
still follows Kandelo's current `sysconf` value of one.

**2026-10-08 — First real Go socket syscalls (fork `ee860d3`).** Removed
Kandelo from Go's fake socket constant table and added Kandelo's actual
IPv4/IPv6 address layouts, socket constants, and channel-backed stream
operations in `syscall`. The new checked-in Go probe runs IPv4 and IPv6
TCP loopback using `Socket`, `SetsockoptInt`/`GetsockoptInt`, `Bind`,
`Listen`, `Getsockname`, `Connect`, `Accept`, `Getpeername`, and stream
`Write`/`Read`. It exits 0 with `GO SOCKET PASS` and no host diagnostics
in Node and Chromium. The full thirteen-probe Chromium suite passed; the
`GOOS=js` and `GOOS=wasip1` standard-library builds passed. An initial
browser attempt on the default Playwright port failed loading a Vite module;
the fresh-port focused and full runs passed. This is a syscall-level
networking slice, not `net.Dial`: the Kandelo `netFD` and runtime netpoller
are still absent, as are datagram/message syscalls and deadlines. Next,
wire the Go `net` package and poller to Kandelo's socket/epoll contract,
then prove `net.Dial` and a listener through both hosts before HTTP.

**2026-10-08 — Real Go runtime netpoll and nonblocking flags (fork
`63b22e7`).** Replaced Kandelo's fake runtime poller with an epoll-backed,
level-triggered poller and eventfd `netpollBreak`. Its registrations exist
only while a read or write waiter is armed; leaving unarmed descriptors in
epoll caused repeated HUP events from stdio and starved timers. Kandelo
`SetNonblock` and `fcntl(F_GETFL/F_SETFL)` now use the real kernel calls, so
`os.NewFile` can detect and poll a nonblocking socket. A focused probe wraps
an accepted TCP socket in `os.NewFile` and confirms a read deadline expires,
later data wakes a blocked read, and close unblocks another blocked read.
The first implementation failed intermittently on additional Ms because
nonzero-initialized poller fd globals were reset when a new Wasm instance
applied its active data segments to shared memory. Keeping the runtime fd
state zero-initialized, then setting it in `netpollinit`, removed those
failures: eight Node repeats and ten Chromium repeats passed before the
close check; the final close check passed three Node and five Chromium
repeats, and the full fourteen-probe Chromium suite passed. No kernel or
host ABI changed; `GOOS=js` and `GOOS=wasip1` standard-library builds passed.
This proves the focused socket/poller path, not full Go `net` support.
`GOOS=kandelo go build net` still fails at the missing `netFD`; next, add
that package backend and prove `net.Dial` and `net.Listen` on both hosts.

**2026-10-08 — Go `net` and loopback HTTP (fork `a4b548a`).** Enabled
the upstream POSIX `netFD`, address, resolver, TCP, and socket-option paths
for Kandelo, adding the missing syscall socket options and truthful
`ENOSYS` interface enumeration. `GOOS=kandelo go build net` and
`net/http` now succeed. Checked-in probes perform IPv4 and IPv6
`net.Listen`/`net.DialTimeout` exchanges and serve a real HTTP response to
Go's default client. Each passed three Node runs with exit 0 and no host
diagnostics; all sixteen dedicated Chromium probes passed. The HTTP probe
first failed with duplicate `runtime.forcegchelper` goroutines: each new
Wasm thread instance replayed Go's active data segments over shared memory,
resetting package-initialization state. The shared host thread-module
patch now removes an all-active data section from no-Start modules, so only
the process-main instance initializes data. Seven focused host tests and
host typecheck pass; `GOOS=js` and `GOOS=wasip1` standard-library builds
pass. `GOOS=kandelo go build std` still fails in `net/internal/socktest`
and `os/user`. This meets the milestone-4 focused TCP/HTTP checks, not full
Go networking or runtime conformance: datagram/message syscalls and broader
DNS/TLS coverage remain. Next milestone: implement `syscall.StartProcess`
through Kandelo `SYS_SPAWN`, then package integration; finish the recorded
Go-runtime guidance work item at the end.

**2026-10-08 — Go process execution through non-forking spawn (fork
`3296d3f`).** Replaced Kandelo's `syscall.StartProcess`, `Wait4`, `Kill`, and
process-ID stubs with
native channel syscalls. `StartProcess` now encodes the established 40-byte
`SYS_SPAWN` header, argv/env string tables, ordered `CHDIR`/`DUP2`/`CLOSE`
actions, and a PID output slot. It duplicates requested child fds above the
target range with `F_DUPFD_CLOEXEC` before issuing actions, preventing
remapping collisions and parent fd leaks; it enforces path, string, action,
and `ARG_MAX` limits and rejects embedded NULs. The Go port now exposes real
wait status and 144-byte rusage layout, `pipe2`, `dup`, `dup2`, and close-on-exec
flags so `os.Pipe` and `os/exec.Cmd.Output` work. The checked-in self-exec
probe validates child parent PID, cwd, environment, exit code, output capture,
and launch errors. It passes in Node with no host diagnostics, and the
instrumented Node runner records fork-count samples `[0, 0]`; the focused
Chromium probe passes too, and all seventeen Go Chromium probes pass together.
This meets milestone 5's focused shell-out/child management check, not
comprehensive process or signal conformance. Next is
milestone 6: first-class Go package integration through the normal resolver
and VFS path. At this point, directly built Go fixtures still emit the legacy
`kandelo.abi.contract` stamp warning. The recorded Go-runtime-specific agent
guidance follows at the end.

**2026-10-08 — Stamp directly built Go fixtures.** The Go browser-fixture
builder now records exactly its sixteen newly built Wasm outputs and applies
the existing `stamp-abi-contract` tool once to that list. It does not sweep
other files or overwrite stale stamps. The Node exec probe and all Chromium
Go probes now require their fixture digest to equal the running kernel's
digest, preventing the host's warn-and-allow path from masking a missing
stamp. The Node exec probe passes without the misleading legacy-binary
warning, and all seventeen Chromium Go probes pass with matching stamps.
The existing stamp-helper regression test passes. The browser-demo TypeScript
project check still reports unrelated errors outside the changed Go probe
test. This fixes the direct-fixture gap independently of milestone 6;
package integration still needs to produce stamped Go programs through the
normal resolver/VFS build path.

**2026-10-08 — First-class Go package through source-only resolution (fork
`3296d3f`).** Added `go-hello` as a registry program and selected local-build
root. Its recipe obtains the pinned fork commit as a sealed `git_input`, builds
the Kandelo Go toolchain with the dev shell's declared Go bootstrap, and invokes
the SDK's `wasm32posix-go` wrapper. The source-only resolver caches and
ABI-contract-stamps the declared Wasm output; no adjacent fork checkout or
ambient compiler is needed. The package import audit originally rejected the
Go runtime's supported `kernel.kernel_thread_exit` process-worker import, so
its shared typed declaration now admits the exact pointer-width signature
without allowing arbitrary kernel exports. The source-only `go-hello` and
kernel builds succeeded. A C launcher uses `posix_spawn` to run the resolved
Go output from `/bin` in a VFS image: Node exits 0 with both expected markers,
empty stderr/diagnostics, and fork-count sample `[0]`; the equivalent
Chromium browser-host test passes with no console errors. The legacy Default
resolver's artifact remains unstamped and is not used for these runtime
checks. This meets the focused milestone-6 package/VFS smoke criterion, not
full Go conformance or a browser-demo UI test. The remaining discrete plan
item is Go-runtime-specific agent guidance below. During iteration, a
metadata-only manifest license edit left a cached source-only receipt tied to
the previous manifest SHA and caused projection finalization to refuse it;
`cargo xtask clean go-hello` followed by `cargo xtask bootstrap go-hello`
recovered through the supported path. The underlying receipt-refresh behavior
is a package-manager gap, not a Go runtime failure.

**2026-10-08 — RoadRunner-first PHP-server feasibility (fork `bd12cbf`).**
RoadRunner is the first practical integration target: it runs PHP workers as
separate processes and supports a `CGO_ENABLED=0` Go build. FrankenPHP embeds
PHP through cgo, which remains outside this Go/Wasm port. The RoadRunner
v2025.1.6 source is
the latest release compatible with the fork's Go 1.25 toolchain; v2025.1.7
raises the minimum to Go 1.26. This is a pinned feasibility probe, not a
RoadRunner package or a supported server release.

The full `GOOS=kandelo GOARCH=wasm` RoadRunner binary stops in third-party
`fasthttp/tcplisten`: no source file matches the Kandelo target. A narrower
RoadRunner server-core build first exposed missing `os/user` lookup. Enabling
the upstream pure-Go `/etc/passwd` and `/etc/group` parser for Kandelo in the
fork makes public user/group lookup and seven selected upstream parser tests
pass in Node and Chromium with VFS account files. The full nineteen-probe
Chromium Go suite passes. The source-only `go-hello` recipe rebuilt from the
new fork pin and its resolved VFS-launch probe passes in Node and Chromium.
Full `go build std` now fails only in `net/internal/socktest`; this is still
not full standard-library
conformance. The server-core compile then reaches `syscall.ForkLock` and
`SysProcAttr` process-group and credential fields. These are genuine process
integration gaps in the Go fork. Kandelo already has child-atomic
`SETPGROUP` in its `SYS_SPAWN` attributes; explicit child credentials have
no spawn representation. The fork lock must preserve descriptor inheritance
semantics rather than merely satisfy the compiler.

The next broader work is therefore the process-startup and descriptor
contract: wire existing spawn-time group attributes, define honest
credential behavior, and protect descriptor inheritance on both hosts.
After that,
compile a minimal RoadRunner server and demonstrate an HTTP request through
a real PHP worker. The RoadRunner executable and PHP worker have not run;
UDP, DNS, and TLS are not the first blockers for this target. Keep the
Go-runtime-specific agent guidance work item at the end of this plan.

**2026-10-09 — RoadRunner process integration (fork `98dc3f1`).** The Go
fork now serializes its descriptor snapshot and `SYS_SPAWN` call against
third-party non-atomic socket/close-on-exec creation through
`syscall.ForkLock`. `SysProcAttr.Setpgid` and `Pgid` use the existing
Kandelo `SETPGROUP` spawn attribute; negative group IDs fail before spawn.
The Go `Getpgid` wrapper lets the child verify its own group. A requested
`Credential` explicitly returns `ENOSYS`, since no child-atomic credential
action exists in the spawn wire contract. The checked-in Go exec probe now
checks the isolated child's group and the two failure cases. It exits 0 in
Node with three fork-count samples of zero, and the focused Chromium exec
probe passes. No ABI or kernel source changed; the Go package source pin is
updated to this fork commit.

With a generic `net.Listen` adapter for
`roadrunner-server/tcplisten`, the RoadRunner server core and HTTP plugin
compile for Kandelo. A minimal custom entrypoint using RoadRunner's real
server, HTTP, and logging plugins also builds to a 35 MiB Wasm program and
receives this checkout's ABI-contract stamp. The stock all-plugin CLI still
hits unrelated terminal (`goterm`) and reload (`syscall.Exec`) compile gaps.
The full CLI's modified plugin list remains scratch-only.

The checked-in `tests/go/roadrunner/build.sh` now reproducibly builds that
minimal server from pinned upstream source and the listener adapter. The
source-only PHP package supplies the CLI worker. A C supervisor launches the
server, sends a loopback HTTP request, verifies the PHP worker's Goridge
response, terminates the server, and reaps it. The Node test exits 0 with
`ROADRUNNER ROUND TRIP PASS`, empty stderr/host diagnostics, and zero fork
counts; the opt-in Chromium test passes the same VFS-loaded round trip.
Both programs carry the kernel's ABI-contract digest. This proves an actual
RoadRunner-to-PHP request, not a full package, Composer SDK integration,
all-plugin CLI, or Go conformance.

The first Node run exposed a host signal-exit race: `waitpid` wakeup tried
to dequeue a signal from a thread whose process had already exited. The
shared host now retires host-deferred child waiters when the parent is already
host-reaped, before polling or publishing any completion. A focused host
regression test, all 70 process-wait lifecycle tests, and the Node/Chromium
integration run pass. The `go-hello` source-only package rebuilds from fork
`98dc3f1`; its resolved VFS child exits 0 in Node and Chromium. No ABI or
kernel source changed. A real child-credential feature is a separate
POSIX/ABI design task, not a shim for the optional RoadRunner user-switch
setting.

Focused Sortix process/signal conformance was attempted twice, but its
runner never reached a guest test: the worktree lacks the full built-in
program closure. Building `dash` moved the missing artifact to `grep`;
the complete local-build plan has 157 uncached nodes and an estimated
36-minute critical path. This is a provisioning gap, not a conformance
pass or an observed POSIX failure. Full conformance remains merge
validation work after the closure is built.

**2026-10-09 — WordPress RoadRunner local profile (fork `ab8c85d`).** The
existing WordPress SQLite VFS now has an opt-in Node profile that stages the
pinned-source minimal RoadRunner binary, PHP CLI, and a Goridge PHP bridge into
the same boot image. RoadRunner owns public port 3000; the bridge forwards to
the image's unchanged nginx/PHP-FPM application path on guest port 38080.
This is not direct WordPress execution as a RoadRunner worker, a browser
gallery profile, or a source-only RoadRunner package.

Real browser navigation revealed two Go-runtime gaps hidden by the one-request
probe. The exported `syscall` channel entry blocked without releasing its P,
starving concurrent HTTP handling; `entersyscallblock`/`exitsyscall` now wrap
user-g channel calls, while runtime-internal calls stay separate. Guest socket
`write` raised fatal `SIGPIPE` when a browser canceled an asset request; Go
now uses `Send` with `MSG_NOSIGNAL` for sockets and falls back to `write` for
non-sockets. The fork revision is pinned by `go-hello`. No Kandelo ABI or
kernel source changed.

The same-VFS local demo returned WordPress HTTP 200 in Chromium for home and
login, loaded their assets with no failed requests, and served repeated
sequential curl requests. The original focused RoadRunner Node and Chromium
worker round trips pass with the new fork; cross-target `js` and `wasip1`
`os`/`net/http` builds pass. The pinned `go-hello` source-only build and its
resolved VFS child pass in Node and Chromium. The netpoll probe now includes a
raw blocking pipe read under `GOMAXPROCS=1`; it passes in Node and Chromium
without stderr or host diagnostics. A stronger C-pthread concurrent-request browser
probe completed the HTTP checks but repeatedly reported a browser kernel-worker
detach timeout during teardown; it was not retained as a passing regression.
Browser-host concurrency and direct PHP request-lifecycle integration remain
separate work. The Go-runtime-specific guidance item below is complete and
now includes these two lessons.

Next: turn the minimal server into a registry package with a source-only
recipe, then exercise normal package resolution and VFS launch in Node and
Chromium. After that, expand realistic configuration and PHP worker coverage,
and revisit the all-plugin CLI only where its features are needed.

**2026-10-09 — Direct WordPress worker requirement.** The same-VFS proxy
profile is not an acceptable performance demo of RoadRunner as an alternative
to PHP-FPM: its WordPress requests still execute in PHP-FPM. PHP CLI cannot
substitute for an HTTP SAPI by including WordPress in a loop; its SAPI discards
response headers, and a persistent PHP request would also retain request
globals and WordPress state. The next WordPress milestone is a PHP worker
entrypoint with a real per-request PHP lifecycle, not another HTTP proxy or a
one-shot CLI process per request. Keep the current profile only as a Go server
and Goridge integration probe.

Build and validate that milestone in this order:

1. Prototype a dedicated PHP SAPI worker that accepts RoadRunner's pipe
   protocol, maps request method, URI, headers, cookies and body into PHP's
   request environment, and maps PHP status, headers and body back to
   RoadRunner. Reuse PHP module startup across requests but run PHP request
   startup, WordPress entrypoint execution and request shutdown for each one.
2. Prove isolation with two distinct sequential WordPress requests in one
   worker process, including redirects, cookies, POST bodies and PHP `exit`;
   then test concurrent requests across workers. Do this in Node and Chromium
   against the same VFS without starting nginx or PHP-FPM.
3. Add a direct-worker demo profile and compare it with the existing
   nginx/PHP-FPM profile on the same WordPress content, VFS and host, with
   warmup, repeated page/API requests, throughput and latency distributions.
   Report failures and resource limits; make no performance claim until these
   measurements exist. The proxy profile is not a comparison baseline.

This supersedes the WordPress-facing part of the preceding package-first
sequence; packaging the minimal RoadRunner server remains useful, but it does
not by itself meet the direct-worker milestone.

**2026-10-09 — WordPress server pivot to FrankenPHP.** The direct RoadRunner
WordPress worker milestone above is superseded: the desired demo is now
FrankenPHP classic mode executing WordPress directly, without nginx or
PHP-FPM, on the existing WordPress VFS. Remove the RoadRunner-to-FPM
WordPress proxy profile; retain the focused RoadRunner Go/PHP worker probe
as Go process and IPC coverage, not as a WordPress server or benchmark.

FrankenPHP cannot yet be built for Kandelo. Its official source build requires
Go cgo plus a ZTS PHP embed SAPI (`--enable-embed --enable-zts`). The Kandelo
Go port defaults to `CGO_ENABLED=0`; forcing `CGO_ENABLED=1` on a minimal
`C.abs` probe with `CC=wasm32posix-cc` currently stops at
`cgo: unknown ptrSize for $GOARCH "wasm"`. This is only the first error:
the Go wasm `runtime.asmcgocall` and `runtime/cgo` cross-call implementations
are `UNDEF`, and the current PHP package builds CLI and FPM but not a ZTS
embed library. A proxy to FPM or a native-host FrankenPHP sidecar would not
meet the Kandelo demo goal; neither is a substitute for this prerequisite.

Next milestones, in dependency order:

1. Design and implement Kandelo Go/Wasm cgo interoperability, including C/Go
   calls, callbacks, shared memory, linker integration, and pthread behavior.
   First prove a minimal C call and callback in both Node and Chromium; do
   not start FrankenPHP packaging from a failing cgo target.
2. Build PHP's ZTS embed library through the normal package resolver, with
   its required extensions and request-lifecycle behavior. Validate a small
   Go-to-embedded-PHP request on both hosts before WordPress.
3. Port a minimal FrankenPHP `net/http` handler in classic mode, then boot
   the existing WordPress VFS without nginx or PHP-FPM. Verify home, login,
   admin, redirects, cookies, POST, static assets, and repeated requests.
4. Compare against the existing FPM profile on the same VFS/content and host,
   with warmup and repeated latency/throughput measurements. Do not claim a
   performance benefit until both paths are running and measured.

No direct FrankenPHP demo URL or performance result exists yet.

**2026-10-09 — cgo feasibility trace.** A scratch change in the Go fork taught
`cmd/cgo` the correct 32-bit Wasm pointer and integer sizes, moving the
checked-in C-call probe past its first error. Its next build stage tried to
parse a linked Wasm module as ELF, Mach-O, PE or XCOFF for dynamic imports.
Temporarily recognizing the Wasm magic exposed the next independent barrier:
`gccDebug` also needs a real Wasm object reader for DWARF and generated
constant/symbol data. A magic-byte skip is not a correct implementation; it
does not provide the data cgo requires. Beyond parsing, the Go Wasm runtime's
`asmcgocall` and `runtime/cgo` cross-calls still trap, and Go's linker does
not integrate the SDK's C/Wasm objects into the current final module. This
is an ABI, runtime and linker design task, not a package flag. The scratch
parser bypass was discarded rather than promoted as apparent cgo support.

FrankenPHP v1.11.0 is a candidate source pin because its `go.mod` requires
Go 1.25.4, within the fork's Go 1.25 line; current upstream `main` requires
Go 1.27. Source-version compatibility does not remove the cgo and ZTS PHP
embed prerequisites. Do not claim a runnable FrankenPHP port from a cgo
frontend or compile-only result: the first real gate is a C call and C-to-Go
callback executing in the same Kandelo process on Node and Chromium.

**2026-10-09 — FrankenPHP classic-mode integration trace.** Keep the focused
RoadRunner Go/PHP-worker probe as a separate integration test, but do not use
its old WordPress-to-FPM proxy as a performance demo. FrankenPHP's documented
WordPress setup uses classic mode, which executes PHP scripts directly. In
FrankenPHP v1.11.0, `frankenphp_execute_script` calls PHP request startup,
executes the script, and calls request shutdown for each request. This gives
WordPress its normal per-request lifecycle; it does **not** keep WordPress
bootstrapped between requests as FrankenPHP worker mode would. No speedup
over FPM should be assumed without a same-content measurement.

The smallest honest integration gate is the v1.11.0 FrankenPHP Go library,
not the entire Caddy/xcaddy distribution. Its `Init`,
`NewRequestWithContext`, and `ServeHTTP` path can serve a simple PHP file in
classic mode without configuring worker scripts. That is a proof of PHP
execution and response handling, not yet a WordPress server: the eventual
demo also needs real front-controller routing, static-file handling, and the
rest of the browser-visible HTTP behavior. Prefer the upstream Caddy
`php_server` path for that final demo if it can be ported; do not call a
bespoke Go router a drop-in FrankenPHP configuration.

Three independent implementation gates remain before even the library proof:

1. Finish Kandelo Go/Wasm cgo: parse actual Wasm debug/object information,
   link Go and SDK C objects into one module, and implement Go-to-C and
   C-to-Go transitions. The local, uncommitted cgo reader experiment advanced
   beyond the pointer-size error but stopped at unsupported imported Wasm
   globals; forcing the final link also exposed unsupported Go linker
   relocations or an unrecognized C object format. It is not a usable port.
2. Validate C-created pthreads calling back into Go. FrankenPHP v1.11.0
   starts its PHP main and request threads with `pthread_create`, and C
   callbacks enter Go for request data and response writes. A C-call-only
   probe would not exercise the required runtime/thread contract.
3. Build PHP 8.3's ZTS embed SAPI through the package resolver with the
   WordPress extension set, then link it into the Go/C module. The current
   `php` package produces CLI and FPM Wasm outputs but no ZTS `libphp` embed
   library; neither executable can stand in for one.

After these gates, run a simple classic-mode PHP page in Node and Chromium,
then add the actual FrankenPHP/Caddy request routing and serve the existing
WordPress VFS without nginx or FPM. Verify repeated page, admin, redirect,
cookie, POST, and static-asset requests before comparing it to the existing
FPM profile. There is still no runnable Kandelo FrankenPHP binary, demo URL,
or performance result.

**2026-10-09 — cgo frontend and callback probe.** The adjacent Go fork's
uncommitted `cmd/cgo` experiment now accounts for imported Wasm globals in
the linked debug module. The full `cmd/cgo` unit suite passes with that
change. A tracked fixture at `tests/go/cgo/callback` adds both a synchronous
Go-to-C-to-Go callback and a callback from a C-created pthread. With the
scratch frontend, both this fixture and the existing `C.abs` probe compile
their generated Go and C files, then fail at the Go linker's unsupported
PC-relative relocation handling for Kandelo/Wasm. The callback fixture runs
successfully with native-host Go, which checks the fixture but not Kandelo.
Forcing internal linking instead rejects the C Wasm object format. The Wasm
linker currently emits a final module, not a relocatable Go object that
`wasm-ld` can combine with C.
Its `runtime.asmcgocall` and `runtime.cgocallback` implementations also end
in `UNDEF`. Therefore this is a frontend-only advance, not a runnable C
call or callback, and no PHP/FrankenPHP request was executed. The scratch
fork changes are not committed, pushed, or pinned by the package. The next
implementation task is a coherent Go/C Wasm link and cross-call ABI design;
do not mask these failures with a cgo parser skip or package-local shim.

**2026-10-09 — Go/C Wasm link-route inspection.** `llvm-readobj` on the
callback fixture's SDK C object found `linking` and `reloc.CODE` sections:
function-index relocations to `go_double`, `pthread_create`, and
`pthread_join`, global-index relocations to `__stack_pointer` and
`__table_base`, and a table-index relocation for the pthread entry. The
fresh cgo-disabled Go binary is already a final Kandelo Wasm module;
handing it and the C object to `wasm-ld` fails with `out of order section
type: 0`. This does not establish that an external-link implementation is
impossible, only that the current Go output cannot be used as its input.
The next executable linker spike should import one SDK C Wasm object into
Go's internal Wasm linker, resolve its symbols and relocations, and run the
existing C-call probe in one module. It must preserve the imported shared
memory, function table, thread-slot declaration, and ABI stamp. If that
route cannot accommodate C function types, table elements, data and TLS,
evaluate emitting a relocatable Go object instead. Neither route is
implemented, and the C-call and callback probes remain unpassed on Kandelo.

**2026-10-09 — internal Wasm C-object reader spike.** Published fork commit
`85c99ecc12d0dedde902d884369ee1bfbaa40a6f` with an isolated
`cmd/link/internal/loadwasm` reader. It decodes the
SDK object's import names, linking symbol table, section references, and
the function-index, global-index, and table-relative CODE relocations needed
by the current probes; it rejects unsupported CODE relocation types instead
of misinterpreting them. Unit tests cover a small object and malformed
inputs. With `KANDELO_WASM_OBJECT` set to each actual SDK object, the reader
tests pass for the `C.abs` cgo shim (two `_cgo_topofstack` relocations) and
the pthread callback fixture (nine CODE relocations); the decoded entries
match `llvm-readobj`. The cgo build still stops at unsupported Go linker
relocations, and this reader is not yet connected to `ldobj` or the Wasm
emitter. No Go/C call has linked or run on Kandelo, Node, or Chromium. The
next step is to map parsed C function types/bodies, globals, data, table
elements, and relocations into the Go linker's final Wasm layout, beginning
with the C-call shim. Debug relocations and archives remain out of scope for
this reader spike. The `go-hello` package remains pinned to fork commit
`ab8c85d83da6f18ade171f557fd0201344c65ddf`; no Kandelo ABI change or
package pin update is warranted until a usable linker revision exists.

**2026-10-09 — Wasm host-function import and link boundary.** Published Go
fork commit `9c67cfe51e473c76f3a8d15020e9ca79106dcdcd`. The internal
linker now recognizes Kandelo Wasm C objects, loads defined C functions as
text symbols, carries their actual Wasm signatures and bodies into the final
emitter, and patches direct function/global index relocations when their
targets are available. The C-call shim's two `_cgo_topofstack` relocation
sites are verified against its real SDK object, including padded LEB rewrite;
the parser rejects relocations outside function bodies and unsupported kinds.
This is *not* a linked cgo program: a `CGO_ENABLED=1` build with the
uncommitted frontend and `-ldflags=-linkmode=internal` reaches the new loader
but stops on `runtime/cgo`'s `R_WASM_MEMORY_ADDR_REL_SLEB` relocation. That
object also carries data segments and references to `malloc`, `stderr`,
`fwrite`, and `abort`; Go's internal link reports unsupported dynamic-symbol
handling and undefined runtime/cgo symbols. The C-call shim itself invokes
`_cgo_topofstack`, a Go/C calling-convention transition not yet implemented;
`runtime.asmcgocall` and `runtime.cgocallback` still trap. The next work must
model C data/memory/global relocations and archive resolution, then implement
typed Go/C cross-call adapters and runtime/cgo thread attachment before the
C-call and callback probes can run. `cmd/link/...` tests pass; pure-Go
`kandelo`, `js`, and `wasip1` sample builds pass, and the Kandelo sample
validates with Wasm threads enabled. No new C-containing Wasm module was
produced or run on Node or Chromium. The `go-hello` package remains pinned
to `ab8c85d83da6f18ade171f557fd0201344c65ddf`; no Kandelo ABI or
package-pin change accompanies this incomplete link step.

**2026-10-09 — function-only Go/C module proof.** Published fork commit
`450543dc16b46ff49edb4865209bec6c2c4f323e` adds linker reachability
edges for C-to-C calls so dead-code elimination retains the callee. The
checked-in `tests/go/cgo/link-only/test-link.sh` packages a two-function
SDK C object into a cgo-free Go archive, links it with the fork's normal
internal Wasm linker, and validates the resulting Kandelo module with Wasm
threads enabled. `wasm-objdump` confirms both `c_target` and `triple` in the
Go module and a rewritten `call 7 <triple>` in `c_target`; the script passes
in the dev shell. The fixture deliberately only retains a C function value:
it does not execute a Go-to-C call, use `runtime/cgo`, stamp the output for
the Kandelo host, or run on Node/Chromium. This proves C function-body
import and C-to-C function-index relocation in a final Go module, **not**
cgo interoperability. The full `C.abs` build remains stopped at the
`runtime/cgo` memory/data/dynamic-symbol and Go/C adapter barriers above.

**2026-10-09 — initialized C data and executable C-only calls in a Go
module.** Published Go fork commit
`27f85fe4f40aeef2a7469fc9c70b2cf17044bbf6`. Its Wasm object reader
now decodes active data segments, segment alignment, data symbols, and
memory-address CODE relocations, with malformed-object checks. The internal
linker places initialized C data in Go's pointer-free static section,
resolves C memory addresses against that placement, and adds an internal
`__memory_base` global only when a retained C object needs it. This raises
the final module's static-data end before Kandelo allocates host channel
memory, rather than placing C data in Go's heap. Unsupported `reloc.DATA`
and element/global sections fail explicitly; C archives are not resolved.

`scripts/dev-shell.sh bash tests/go/cgo/link-only/test-link.sh` now links
C-to-C and C-data fixtures into a cgo-free Go Wasm module, validates it,
and invokes their C functions through the exported Wasm table on Node and
Chromium. The result is 10 from `c_target(5)` and 12 from `weighted(5)`,
whose second result reads initialized C static data. This is executable
C-in-Go-module evidence, **not** Go-to-C interoperability: no Go runtime
code calls C and no Kandelo process worker executes this module. Focused
`cmd/link/...` and `cmd/cgo` tests pass, pure-Go `kandelo`/`js`/`wasip1`
builds pass, the Kandelo sample validates, and the Kandelo ABI snapshot
check passes. The full `C.abs` link with the uncommitted cgo frontend now
stops at `adddynsym: unsupported binary format` for cgo exports and at
undefined `x_cgo_pthread_key_created` and
`x_cgo_notify_runtime_init_done`. The Go/C cross-call adapters, C runtime
symbols, archive resolution, callback/thread attachment, ZTS PHP embed
library, FrankenPHP classic-mode server, and WordPress demo are still
unimplemented. No package pin or Kandelo ABI version changes in this step.

**2026-10-09 — executable Go→C linker probe and next cgo boundary.** The
checked-in link-only fixture now has a Go Wasm assembly function that calls
`weighted(5)` through the linked C function table, checks the return value
12, and prints `GO TO C DATA PASS`. Its output is stamped with the current
ABI-contract digest before running as a Kandelo process. The Node runner
reported exit 0, that marker, empty stderr, and no host diagnostics. The
opt-in Chromium Playwright process-worker case passed. The older direct
Wasm-table Node/Chromium checks also passed. This proves a narrow same-signature
Go→C call and initialized C data in one process, **not** standard cgo or a
Go callback.

The adjacent fork's WIP commit
`24313139e5ac59367c16370d9a9dd17aa05c0679` now admits validated active
C element segments already covered by Go's full function-table initialization,
resolves C function-pointer slots and `__table_base`, and declares an
exported `__stack_pointer` only for retained C objects that need it. The
opt-in SDK `gcc_libinit.c` object test and focused `cmd/link/internal/loadwasm`,
`ld`, and `wasm` tests passed. With the WIP Wasm cgo frontend and Kandelo-tagged
POSIX `runtime/cgo` C files, the full `C.abs` build moves past the prior ELF
dynamic-symbol, type-index, and element-section failures. A raw C-ABI
`_cgo_topofstack` Wasm function resolves the next C shim call; the link now
stops at `pthread_mutex_lock`, an SDK libc archive member. No normal cgo
binary was emitted. The linker still cannot load SDK C archives or
`reloc.DATA` and cannot execute C wrappers without the `asmcgocall` adapter
and valid C stack state. Focused `cmd/cgo` and linker tests passed; pure-Go
`kandelo`, `js`, and `wasip1` browser-basic builds succeeded.
ABI review: no version bump; the optional `__stack_pointer` export is
already recognized by the host, and this step changes neither the syscall
channel nor an existing required import/export. The package source pin stays
at the last usable pure-Go revision until standard cgo runs.

**2026-10-09 — SDK archive selection reaches TLS and DATA relocations.**
Go fork commit `8e3a5871110968ebd8ce5b562a261b2b34b344d0` marks undefined
Wasm C relocation targets as external references, allowing Go's existing
lazy host-archive loader to select SDK libc members. With the explicit
`-libgcc=<this checkout>/sysroot/lib/libc.a` probe flag, `C.abs` now reaches
those members and reports unsupported `reloc.DATA` plus CODE relocation type
21 (`R_WASM_MEMORY_ADDR_TLS_SLEB`) in musl objects. Focused linker tests pass.
This is not an executable cgo module: the linker still needs DATA relocation,
TLS layout and per-thread TLS addressing, a normal SDK archive lookup path,
and the Go/C runtime adapters above. No Kandelo ABI or package-pin change.

**2026-10-09 — SDK DATA relocation milestone.** Go fork commit
`d2b748a1fb21dd8aaf4373f818af676bce68fe09` parses checked DATA
address relocations and emits Go static-data `R_ADDR` edges so SDK C pointer
initializers relocate with their target symbols. The `lite_malloc.o` SDK
object test and focused linker tests pass. The `C.abs` link with an explicit
SDK libc archive no longer reports DATA errors, but still fails on musl's
type-21 `R_WASM_MEMORY_ADDR_TLS_SLEB` relocations. This requires real
per-thread C TLS allocation and addressing, not treating TLS symbols as
ordinary static data. No executable cgo binary or FrankenPHP demo yet.

TLS design boundary: musl's `_Thread_local` objects use a per-instance
mutable `__tls_base` and LLVM TLS address relocations. The current Go linker
instead exports an immutable `__tls_base` whose value is the address of its
legacy syscall-channel handoff word. The host's pthread startup calls
`__wasm_init_tls(tlsOffset)` when that export exists and separately sets
`__stack_pointer`. A combined Go/C module cannot map LLVM TLS relocations to
the current Go `__tls_base` without corrupting this channel contract. The
next linker/runtime design must give C a distinct mutable TLS base and a
correct TLS template/init export (or migrate Go channel discovery to an
independent import), then validate main-thread, pthread, fork replay, and
Node/Chromium behavior. Do not map TLS offsets into Go static memory or
reuse the immutable channel handoff global as a shortcut.
Go fork commit `3e2250b11e1dcc561ee8d7c0f717dec84d0d392d` makes this
boundary explicit: it rejects TLS CODE relocations and TLS data segments
instead of silently placing thread-local bytes in Go static data. SDK
`abort.o` and `__wasm_tp.o` tests cover those cases. This does not implement
TLS or advance the runnable cgo gate.

**2026-10-09 — normal SDK archive discovery.** Go fork commit
`acc452fd67b8109a4eb9eaf5a7181c94f713af93` uses the existing Go lazy
host-archive loader with the libc path reported by `wasm32posix-cc`; the SDK
driver now answers `--print-file-name=libc.a` from its resolved sysroot. The
normal `C.abs` command, without manual linker flags, selects musl members
and fails explicitly on `__wasm_thread_pointer` TLS relocations. The parser
also decodes those relocations and C function-pointer table relocations, while
the linker still rejects TLS until it has real per-thread layout. The SDK
compiler query and 31 focused `cc.test.ts` cases pass; focused Go linker
tests pass. This changes no existing Kandelo ABI or package source pin.

**2026-10-09 — cross-object C data addresses.** Go fork commit
`2fcbf8c92b29590062c4208cfe89118dfc456c6b` collects defined C data
symbols across host objects and synthesizes immutable Wasm address globals
for cross-object `global.get` relocations. The checked-in link-only fixture
now links a third C object whose `cross_weighted(5)` reads `offset` from a
different C object and returns 13. Direct Wasm-table checks pass in Node and
Chromium. After ABI stamping, the Go assembly call runs in a Kandelo process
with exit 0, expected stdout, empty stderr, and no host diagnostics on Node;
the Chromium process-worker test passes. This remains a cgo-free linker
fixture, not `runtime/cgo` or a PHP embed. The added globals are internal to
C-containing modules, so no Kandelo ABI version or package pin change.

**2026-10-09 — data-only C archive members.** Go fork commit
`686572e8259d21dcd53468d7f2239dc163ac3e94` records C global data
symbols independently of retained C functions and keeps loaded C data
segments in the final module. The fixture moves `offset=7` into a fourth,
function-free object; both `weighted(5)=12` and `cross_weighted(5)=13` now
resolve its address. The direct table tests pass in Node and Chromium, and
the ABI-stamped Go process test passes in Node (exit 0, expected stdout,
empty stderr and diagnostics) and Chromium. Pure-Go `kandelo`, `js`, and
`wasip1` browser-basic builds pass. The normal `C.abs` build still stops at
the explicit musl TLS boundary. No ABI or package pin change.

**2026-10-09 — per-instance C TLS linker proof.** Adjacent Go fork commit
`76410fd` lays out C TLS segments in a bounded 64 KiB
per-thread template, relocates `R_WASM_MEMORY_ADDR_TLS_SLEB`, reserves a
separate main-thread TLS block, emits `__wasm_init_tls`, and calls it before
the Go `_start` entry. C TLS uses a mutable internal global distinct from
the exported legacy `__tls_base` channel handoff. The host already calls
`__wasm_init_tls` with each pthread's TLS/control page. The link-only
fixture now increments a real `_Thread_local` C value from Go and checks
that two Wasm instances over the same memory keep independent TLS bases.
`tests/go/cgo/link-only/test-link.sh` passes direct table checks in Node and
Chromium; the ABI-stamped Kandelo process exits 0 with `GO TO C DATA PASS`
and no host diagnostics on Node, and the Chromium process test passes.
This proves only the fixture's TLS initializer and instance isolation, not
musl or PHP TLS conformance, C-created pthread callbacks, or fork replay.

The same linker work now recognizes C function-pointer DATA relocations,
cross-object GOT-style data globals, weak function definitions, and exported
aliases instead of failing immediately on musl's TLS objects. A second
link-only fixture initializes a C function pointer in DATA, calls through
it from Go, and checks the result in Node and Chromium direct-table tests;
the ABI-stamped Kandelo process also exits 0 on Node and Chromium. Pure-Go
`kandelo`, `js`, and `wasip1` browser-basic builds pass. The normal
`CGO_ENABLED=1` `C.abs` build currently stops at unresolved
`_cgo_sys_thread_start`: Kandelo lacks the platform-specific `runtime/cgo`
thread-start implementation. It still emits no cgo binary. The package pin
stays at the earlier pure-Go fork revision; no ABI change or FrankenPHP demo
is claimed.

Next runtime/cgo boundary: `gcc_util.c` supplies `x_cgo_thread_start` and
calls an operating-system-specific `_cgo_sys_thread_start`, but the fork has
no Kandelo/Wasm implementation. This is not dead code: with `iscgo`,
`runtime.newm` calls `_cgo_thread_start` for new Ms. A platform C thread
start must connect C `pthread_create` to a Go-compatible entry, initialize
musl's thread pointer and C TLS, and capture a per-instance Kandelo channel.
Go's resumable Wasm function type is not the C ABI function-pointer type, so
calling a raw Go table entry as a C `void (*)(void)` is invalid. The same
adapter issue appears in `asmcgocall`, `cgocallback`, and `crosscall2`, all
still `UNDEF` in the fork's Wasm assembly. Do not resolve the linker error
with a no-op thread-start stub or an unverified direct table call.

**2026-10-09 — cgo executable glue and channel checkpoint.** Published Go
fork commit `ead1b2352595dbbb92d61bc82dff61c66c389050`. The Go fork
now keeps Kandelo-owned Go Ms on `newosprocKandelo` even when cgo is
enabled, instead of requiring `_cgo_sys_thread_start` for those Ms. The SDK
exposes its executable glue sources to toolchain consumers; the Go internal
linker compiles and loads the syscall, compiler-rt, and C++ runtime glue
through that SDK path. Its Wasm object reader retains typed function imports;
the final linker maps C `kernel.*` imports into its function index space and
creates an exported, per-instance mutable `__channel_base` for C while
preserving Go's existing channel handoff word. The shared host assigns both
when present. libc archive selection now recognizes TLS-only references,
and C function relocations retain referenced weak functions. These edits
move the normal `C.abs` build from `_cgo_sys_thread_start` to unresolved
`__fini_array_end` in musl's exit path. The link-only fixture now also
calls a C function that reads `__channel_base`; its ABI-stamped process
checks exit 0, `GO TO C DATA PASS`, empty stderr and host diagnostics on
Node, and the matching Chromium Playwright case passes. Direct-table
Node/Chromium checks, focused Go linker tests, SDK compiler tests, pure-Go
`kandelo`/`js`/`wasip1` browser-basic builds, and the ABI snapshot check
pass. There is still **no cgo executable**; the host typecheck encounters
unrelated `rootDir` errors from the OpenSSL package. The added optional
`__channel_base` export preserves existing Go and C process behavior, so no
ABI bump was made. The package pin remains on the earlier pure-Go revision.

**2026-10-09 — first standard-cgo Wasm link, runtime still blocked.**
Published Go fork commit `fbfffde21d6011b85f34837003c3734bbbfa04da`.
The linker now resolves absent weak C data to zero, rejects nonempty
constructor/destructor arrays instead of silently skipping them, and emits
a typed C-ABI `_cgo_topofstack` wrapper around Go's resumable function.
The Kandelo-tagged `runtime/cgo/setenv.go` is included. A forced normal
`CGO_ENABLED=1` build of `C.abs` now emits a Wasm binary, and
`wasm-validate --enable-threads` accepts the raw module. This is **not a
working cgo runtime**. `wasm-fork-instrument` rejects the instrumented
module with `expected valid result type`, so the host refuses the raw
artifact because its retained `kernel_fork` import requires full fork
instrumentation. A separate run of the previously emitted instrumented
artifact reached Go runtime initialization but failed `_cgo_setenv missing`;
the setenv build-tag fix has not been revalidated in a runnable process.
`asmcgocall` remains `UNDEF`; no standard Go-to-C call has executed.
Focused Go linker and cgo frontend tests pass. The Go fork binary is not
yet repinned in the `go-hello` package; ABI version is unchanged.

**2026-10-09 — mixed-module fork instrumentation and next runtime gate.**
The fork instrumenter's Binaryen post-pass now enables the Wasm features
found in its emitted module. Its prior no-flag invocation rejected the
mixed Go/C output despite a valid `target_features` section. The new
shared-memory CLI regression and the full `fork-instrument` crate tests
pass. The normal `C.abs` build, fork instrumentation, ABI stamp, and
Kandelo Node process launch now all complete, but the process traps at
`runtime.abort` during `runtime.main` after `_cgo_setenv` is present.
Disassembly places the trap at an indirect Go function call in cgo runtime
startup; `runtime/cgo/asm_wasm.s` still defines `set_crosscall2` and
`crosscall2` as `UNDEF`, and `runtime/asm_wasm.s` still leaves
`asmcgocall` and `cgocallback` undefined. This is not a passing C call;
there is no Chromium standard-cgo run or PHP embed yet. The narrow
Go-assembly→C process probe continues to pass Node and Chromium.

**2026-10-09 — first standard cgo calls on Node and Chromium.**
Published Go fork commit `6a04d1a208d9f4e506ed7a755d8a3aa74640231b`.
The adjacent Go fork now reserves an 8 MiB C stack below the heap, gives C
calls the `(i32) -> ()` Wasm signature, initializes the main musl thread
pointer before C work, and replaces the undefined `set_crosscall2` startup
routine with a typed C initializer. The C callback entry deliberately traps
until a real Go/C callback transition exists. `cmd/cgo` now pads the generated
argument frame at the Go/Wasm 8-byte boundary while retaining the SDK's
4-byte C pointer size; the focused frame-layout unit test covers a pointer
between scalars. The normal `C.abs` probe also calls C functions with three
scalars and with pointers in first and middle argument positions. A forced
build validates, fork-instruments, receives the current ABI stamp, and exits
0 with `CGO ABS PASS`, empty stderr, and no host diagnostics in both the
Node process and Chromium browser-host test. The C stack is only safe on the
main Go M; a C call from another Go M traps rather than sharing it.

The same-thread callback fixture now links and validates after retaining a
Go callback referenced through a C function-address global. Its Node run
still traps at the explicit `crosscall2` callback boundary. The combined
same-thread/pthread fixture also links and validates after retaining musl's
local function aliases, but has not passed its process gate. Full musl
startup, C-created thread attachment, callbacks, PHP ZTS, FrankenPHP,
and the WordPress demo remain unimplemented. The `go-hello` package still
pins the earlier pure-Go fork revision; there is no PHP/FrankenPHP
performance claim. Focused Go
`cmd/cgo`, `cmd/link/internal/loadwasm`, `cmd/link/internal/ld`, and
`cmd/link/internal/wasm` tests pass. Pure-Go Kandelo browser fixtures
rebuild, and all 20 opt-in Chromium Go-port tests pass, including the new
standard-cgo process case. Forced
`js` and `wasip1` browser-basic builds validate; the ABI snapshot check
passes. No PHP or POSIX conformance suite was run at this checkpoint.
Follow-up source tracing found that the host sets a child instance's C
`__stack_pointer` from `kernel_clone`'s stack argument, but native Go M
creation passes the g0 stack top. Reusing that as a C stack would corrupt
live g0 frames; a separate per-M C stack and thread-pointer initialization
must precede lifting the current trap. The C-to-Go trampoline must also
respect Go/Wasm's resumable scheduler convention across a synchronous C
callback. These are design constraints, not yet passing behavior.

**2026-10-09 — Go-created secondary M has its own C stack and musl state.**
Published Go fork commit `fc42f1a2d2a59d8d8c8d383bf95c77a8e387bc8f`.
The adjacent Go fork now allocates a distinct 8 MiB C stack for every
Go-created M in a cgo process and reclaims it when the M's g0 stack is
reaped. C state is kept behind a pointer so the native Go `m` still fits
its required allocation size class. `kernel_clone` receives that C stack
top instead of the live g0 stack top. The host sets the child's C stack
pointer and musl thread pointer; the child calls `__init_tp` before
entering the scheduler.
The standard cgo fixture locks the main Go M, makes Go-to-C calls across
four worker rounds, and verifies distinct `pthread_self()` values and
isolated `errno`. Forced build, Wasm validation, fork instrumentation,
and ABI stamp pass; the Node process exits 0 with `CGO ABS PASS`, empty stderr and no host
diagnostics. The focused Chromium browser-host test also passes. Focused
Go cgo/linker tests, forced `kandelo`, `js`, and `wasip1` pure-Go builds,
the ABI snapshot check, and all 20 opt-in Chromium Go-port tests pass.
This establishes Go-created M isolation for simple calls, not C-created
pthread attachment, callbacks, full libc startup, PHP ZTS, or WordPress.

**2026-10-09 — callbacks into Go-owned threads execute on Node and Chromium.**
Published Go fork commit `926b131d8d969757cbf0aed04c013c5c67e2868b`.
The Go fork now supplies a C-ABI `crosscall2` through a Go Wasm export
wrapper. It resumes the Go callback before returning to the still-live C
Wasm call stack, including when the callback yields to the scheduler. The
internal linker maps C relocations to that Go export and traverses Go
dependencies that C relocation loading had marked reachable before the
dead-code pass. The Go-owned callback fixture calls back into Go on the
main and a second Go M. In each callback it yields, waits on a timer, and
makes a nested Go-to-C call. Forced build, Wasm validation, instrumentation,
and ABI stamp pass; Node exits 0 with `CGO CALLBACK PASS`, empty stderr,
and no host diagnostics. The focused Chromium browser-host test and all
21 opt-in Go-port browser-host tests pass. Focused Go cgo/linker tests,
forced `js`/`wasip1` builds, and the Kandelo ABI snapshot check pass.

The combined C-created pthread fixture also links and validates but fails
its Node process gate. The new pthread instance has no Go `g`, Go stack
pointer, attached M/P, or per-M Go channel. Its call to the Go-owned export
wrapper hits `runtime.notInitialized`; the attempted Go diagnostic then
faults on an uninitialized channel. This is a known unsupported path, not
a passing callback or PHP-ZTS claim. Full libc startup is still missing.

**2026-10-09 — Go-led libc environment startup and mutation.** Published
Go fork commit `8aec831cb5d6d3b9f2a0bb1c9d18aeabd4f2929a`. The musl
overlay now isolates `__init_libc` from C process entry, allowing a Go-led
cgo program to initialize libc without pulling in the C runtime's `_start`
and incompatible constructor references. The Go runtime builds a
process-lifetime C-width environment and program-name table through its own
allocator, avoiding a separate C `mmap` allocation that collided with Go
heap growth. `runtime/cgo` passes that table to musl initialization. The
Kandelo `setenv_c`/`unsetenv_c` frames use 32-bit C pointers rather than
Go's 64-bit pointers. The standard cgo fixture verifies C `getenv` at
startup, Go `os.Setenv` and `os.Unsetenv` reflected in C, a Go GC, existing
scalar/pointer calls, and per-M `pthread_self`/`errno`. The raw Wasm
validates, fork-instruments, and receives the current ABI stamp; Node
exits 0 with empty stderr and diagnostics. The focused Chromium standard
cgo and Go-owned callback cases pass. Focused Go cgo/linker tests pass;
`fmt`, `net`, `os`, and `runtime` build with cgo disabled for `kandelo`,
`js`, and `wasip1`; the Kandelo ABI snapshot check passes. Follow-up Go
fork commit `00a02c890d2da06c82e5c359904bc160ddd3949c` adds Kandelo to
the socket-test helper build tags, closing the `net/internal/socktest.Sockets`
failure; forced cgo-disabled `go build -a std` now passes for `kandelo`,
`js`, and `wasip1`. The first narrow libc-test
attempt cannot resolve missing rootfs/builtin artifacts; provisioning and
rerun are required before claiming C-process conformance.

This is **not** complete libc startup: nonempty C constructor arrays still
fail in the linker, destructor execution is unproven, and secure-exec
behavior has not been exercised in a Go-led process. The C-created pthread
fixture still traps in `runtime.canpanic` with no Go `g`/stack/channel,
exiting 139 on Node; libc initialization did not attach that thread.

**2026-10-09 — Wasm C constructor metadata executes before Go main.**
Published Go fork commit `dbec8a76cecd897e5e09c3b8b5770194138202ef`.
The linker now parses standard Wasm `INIT_FUNCS` metadata, orders functions
by priority, emits one C-ABI function-pointer table, and runs it after
musl initialization. It provides the static `__dso_handle` required by C
destructor registration. A cgo-disabled mixed C/Go link with constructor
metadata now fails explicitly rather than silently skipping it. The
tracked cgo fixture checks two priority levels and a registered C
destructor that it dispatches explicitly. Its raw Wasm validates, fork-
instruments, receives the ABI stamp, and exits 0 on Node with
`CGO CONSTRUCTORS PASS`, empty stderr, and no host diagnostics. The focused
Chromium case and all 22 opt-in Chromium Go-port process cases pass.
The standard cgo and Go-owned callback probes were rebuilt under this
linker and pass on Node. Focused Go cgo/linker tests pass.

This does **not** prove automatic C exit-handler execution when Go exits;
Go's normal exit bypasses musl `exit`, as it does on native Go systems.
Explicit `.init_array`/`.fini_array` segments remain rejected, and secure
startup in a Go-led process is still untested. C-created pthreads still
cannot call Go; PHP ZTS and FrankenPHP remain unbuilt. The go-hello package
pin and Kandelo ABI version are unchanged.

**2026-10-09 — C-created pthread callback and shared memory allocator.**
The Go fork now exports a typed C-thread bootstrap and musl's
`__wasm_thread_init`, attaches a C-created pthread through `needm`, and gives
it a Go bootstrap stack and the thread's Kandelo syscall channel. The callback
probe calls Go twice on each C-created pthread, yields and waits on a timer in
each callback, and repeats from a second Go M. Its ABI-stamped, fork-instrumented
Wasm exits 0 on Node with `CGO CALLBACK PASS`, empty stderr, and no host
diagnostics. A focused Chromium process run also passes. This is a callback
milestone, not PHP or general cgo conformance.

Repeat runs exposed a second, independent race: the shared Go channel handoff
word could be overwritten when a C pthread and Go M started concurrently.
The cgo runtime now reads the per-instance C `__channel_base` global instead
of that shared word. Ten clean Node callback process runs and three serial
Chromium runs pass after the fix, all with empty stderr and no host
diagnostics. A parallel three-worker Chromium repeat timed out before this
race was fixed; it is not evidence of passing concurrent-process load.
The stronger Chromium run exposed a real allocator collision: Go's original
contiguous `sbrk` growth lost access to later pages when a C pthread mapped
above the break, and an 8 MiB Go-created-M C stack then failed. Kandelo Go
runtime allocations now use the same kernel `mmap`/`munmap` address manager as
C, including reserved Go arenas and fixed-address commits. The strengthened
callback passes on both hosts after that change. Forced cgo-disabled std builds
for `kandelo`, `js`, and `wasip1`, focused cgo/linker tests, and ABI snapshot
check pass. A narrow libc `env`/`argv`/`tls_init` conformance invocation could
not resolve the required rootfs/builtin artifacts; `./run.sh setup` finished
with unrelated `librsvg` and `rsvg-convert` package failures. The broader
browser run, libc conformance, PHP ZTS, and FrankenPHP remain separate gates;
no WordPress/FrankenPHP demo is running.

The `go-hello` package input now pins fork commit
`44b8926f137a7ea1887ded013f08e90cfc793523`; its resolver build remains
a separate validation gate.

Remaining work, in dependency order:

1. Finish Go/C runtime semantics: handle explicit `.init_array` and
   `.fini_array` segments where needed, validate secure-exec behavior,
   define C shutdown expectations, and review callback safety and the
   mixed-width `cmd/cgo` frontend beyond the passing probes.
2. Stress and harden C-created pthread attachment and shared Go/C memory
   allocation beyond the focused Node and Chromium callback process tests,
   including concurrent callbacks, reclaim, limits, and libc conformance.
3. Build PHP ZTS embed through the normal SDK/resolver, prove PHP lifecycle,
   port FrankenPHP classic mode, and deliver the WordPress VFS demo without
   nginx or PHP-FPM. Measure performance only after the Kandelo server runs.
4. Recheck ABI, pure-Go `kandelo`/`js`/`wasip1` regressions, package pin,
   browser end-to-end behavior, conformance, and Go-runtime guidance before
   closing the draft PR.

**2026-10-10 — static archive selection and PHP ZTS build in progress.**
The adjacent Go linker now consumes cgo library search flags and pulls C Wasm
archive members reached by C code relocations, including a second member
called by the first. The checked-in `tests/go/cgo/static-archive` fixture
builds through normal cgo, then runs with the Kandelo kernel in Node and
Chromium with empty stderr and host diagnostics. The linker changes are not
yet pinned by a registry package and do not establish that a large PHP archive
can link. A `php-zts` resolver recipe now requests PHP 8.3.15's static embed
SAPI, ZTS, and the WordPress extension set; its first source build is still
running. The existing `go-hello` package resolves and runs directly; its
`posix_spawn` package-launch test has passed repeatedly after one earlier
stalled attempt. Do not claim that stall fixed without a reproduced cause.

The immediate gates are: complete and verify the PHP ZTS resolver build;
link a minimal PHP embed lifecycle probe through the Kandelo Go/C linker;
then compile upstream FrankenPHP classic mode, serve a simple PHP request,
and only then integrate the existing WordPress VFS without FPM. Repeat Node
and Chromium request tests, conformance, ABI, and package checks before any
performance or completion claim. No Kandelo FrankenPHP demo URL exists yet.

**2026-10-10 — PHP embed lifecycle passes; FrankenPHP reveals mixed-width
cgo layout.** The `php-zts` resolver build completed. The Go linker now
imports the host's `__c_longjmp` tag and VM-interrupt function, resolves
object-local functions and weak/strong C data across the PHP, ICU, libc++,
curl, and libc archives, and preserves the Go-owned 8-byte `_cgo_yield`
storage required when C pointers are 4 bytes. The checked-in
`tests/go/cgo/php-embed` fixture builds through the SDK and package resolver,
validates and fork-instruments its roughly 40 MiB raw module, and executes
PHP init, evaluation, and shutdown in Node and Chromium with exit 0, both
output markers, empty stderr, and no host diagnostics. PHP Fibers' always-
compiled ucontext references link only against Kandelo's documented
abort-on-use unsupported library; the probe does not use Fibers.

Upstream FrankenPHP v1.11.0, with hot reload and Mercure excluded, now
*compiles and links* into a Kandelo Go/C module in a scratch checkout. Its
first Node classic-mode attempt failed before request handling: `Version()`
received a C struct with 4-byte pointer fields that `cmd/cgo` generated as
8-byte Go pointer fields, causing a huge invalid `GoString` allocation.
A scratch C-accessor change removed that immediate layout mismatch; the
resulting module is being tested. The same dependency graph also exposed
`golang.org/x/sys/cpu`'s zero cache-line padding for generic Wasm, which
breaks Otter's compile-time sizes on a threaded Kandelo target. Its
Kandelo-only 64-byte adaptation is still scratch, not a reviewed package
patch. The PHP ZTS recipe has a revised header macro patch rebuilding in
the resolver; neither a FrankenPHP package nor WordPress demo is published.

**2026-10-10 — FrankenPHP classic executes a PHP request on Kandelo.**
Fork commit `471e7821508c58ed5d2022e52adf3abac3539e87` adds cgo static
archive selection, Wasm tag imports, C data/function symbol fixes, foreign
callback C-stack reentry, and byte-exact exported callback frames. Before the
frame fix, the C-created PHP thread received a null script pointer even
though its Go callback returned a pinned string; a callback fixture now
checks a mixed scalar/pointer result on a C-created pthread. The PHP ZTS
resolver revision 2 removes a header macro redefinition that upstream
FrankenPHP treats as an error. The embed lifecycle fixture passes Node and
Chromium against that revision, as do the callback and static-archive browser
gates. Focused Go cgo/linker tests and forced cgo-disabled `kandelo`, `js`,
and `wasip1` standard-library builds pass.

Upstream FrankenPHP v1.11.0, with a local `x/sys` cache-line adaptation and
C accessors for mislaid pointer-bearing PHP structs, now initializes its
embedded PHP runtime and handles a classic-mode PHP request in the Kandelo
Node host: `FRANKENPHP CLASSIC PASS`, exit 0. The first PHP execution had
faulted while reading a `zend_llist` header field directly through Go's
64-bit pointer layout; C accessors remove that mismatch. Request-info
fields need the same treatment for WordPress and are being applied in the
package patch. A new `frankenphp-classic` source package and a WordPress
profile sharing the existing VFS are in progress, not yet validated or
published. There is still no running demo URL or performance result.

**2026-10-10 — resolver-built FrankenPHP serves HTTP on both hosts.**
The `frankenphp-classic@1.11.0` source recipe builds the v1.11.0 Go library
and PHP ZTS archive through the pinned Kandelo Go fork. The package carries
scoped C-accessor patches for mixed-width PHP structs and registers CGI
variables through scalar/pointer C calls rather than a pointer-bearing
struct-by-value argument. A first real HTTP request exposed the missing
Kandelo build tag on Go's Unix MIME registry; fork commit
`0d3e83bce3f6329d80074361a7c00a9a3c7ba89c` fixes that runtime/stdlib
gap. The package recipe now fork-instruments and ABI-stamps the produced
module explicitly; `install_local_binary` did not stamp it automatically.

Resolver revision 6 succeeds. Its Node test requests a rewritten PHP URL
and a static text asset through `fetchInKernel`: both return 200, PHP sees
the original request URI and script name, headers are correct, and host
diagnostics are empty. The matching Chromium browser-host test passes.
This is actual embedded PHP served by FrankenPHP, not FPM or a proxy. The
package patch currently makes 23 separate Go-to-C calls for CGI variables;
there is no performance claim until the application is measured. The
WordPress profile has been added to the existing VFS recipe, but its
full source-only image build and end-to-end requests remain in progress.

**2026-10-10 — WordPress VFS exposes a foreign-callback stack boundary.**
The existing shell/WordPress VFS builder, with FrankenPHP as an alternate
dinit service, produces a 266 MiB raw / 50 MiB compressed image and
preinstalls WordPress SQLite. A first in-kernel homepage request reached
FrankenPHP's PHP output callback, then aborted during Go stack growth:
the synthetic C-created-thread callback frame exposed a C pointer as its
return PC. Fork commit `24e918744d0fe8d932e120654dcfba822d7acfd5`
marks that frame as the stack top. A strengthened callback fixture now
forces stack growth on a C-created pthread and passes in Node and Chromium.
The next WordPress request reached PHP output but exposed a second stack
boundary: the callback adapter restored an absolute idle stack pointer
after Go had relocated that stack. Fork commit
`5cf3a87e416c6d6c5f05a27fd74e45fce3a5aec8` preserves the offset
from the stack high bound instead. The fixture now repeats deep callbacks
on one C pthread and passes in Node and Chromium. `frankenphp-classic`
revision 8 and `go-hello` revision 6 pin both fixes.
The WordPress end-to-end rerun against the rebuilt binary remains open;
this checkpoint is not a working WordPress or performance claim.

**2026-10-10 — WordPress PHP requests pass on Node and Chromium hosts.**
The direct image builder now embeds revision-8 FrankenPHP alongside the
existing nginx/PHP-FPM stack, adds a separate dinit target and profile,
and gives embedded PHP its own `PHPRC` so it does not attempt to load
FPM's dynamic OPcache module. The preinstalled SQLite image responds to
`GET /` in the Node kernel host with HTTP 200 and a 68 KiB WordPress
homepage, with no host diagnostics. A direct Chromium kernel-host test
boots the same VFS, gets HTTP 200 for the homepage and WordPress login
form, and shuts down dinit without diagnostics. These are application
requests executed in FrankenPHP classic mode, not FPM or a proxy.

The full WordPress package build is still resolving the canonical shell
dependency tree. This invocation was later found to use the default resolver
policy, not `source-only-v1`; see the correction below. Its prior projection
is stale, so the
gallery/UI test cannot load the image yet; the direct browser-host test
uses the built VFS bytes without bypassing the kernel. Pending gates are
the resolver-built image, gallery login flow, durable running demo URL,
ABI and package pin checks, and any defensible performance comparison.

**2026-10-10 — Direct WordPress admin flow passes.** The Node-host
FrankenPHP demo boots the verified direct-build VFS through dinit and serves
the preinstalled site at `http://localhost:3000/`. A Chromium Playwright
session navigated to `/wp-login.php`, submitted the image's preinstalled
admin credentials, and reached the real WordPress admin UI. The direct
Chromium kernel-host test independently received the homepage and login
form from embedded PHP. Neither path starts nginx or PHP-FPM. This is an
application-behavior check, not an application-performance comparison.

The remaining gates, in order, are:

1. Complete the source-only WordPress resolver build, including its
   canonical shell dependency tree; then rebuild with the current package
   revisions and verify the projected VFS image.
2. Run the Node demo without a direct-image override, the browser gallery
   profile and admin flow, and the merge-gate profile test against that
   resolver-owned image.
3. Recheck the package pin, ABI snapshot, and relevant Node/Chromium probes;
   record any conformance suites that remain unrun or blocked. Compare
   WordPress application performance only with measured, comparable runs.
4. Keep the draft PR and this log aligned with the evidence. Broader Go/C
   conformance remains distinct from the WordPress demo: explicit C
   initializer/finalizer handling, secure-exec and C shutdown semantics,
   general callback/thread stress, and wider libc/POSIX coverage have not
   been established by these focused probes.

**2026-10-10 — Shell dependency Rust compiler unblocked.** The first full
WordPress resolution, inadvertently run under the resolver's default policy,
built many canonical shell packages but stopped when
SpiderMonkey's Mozilla configure selected the user's Rustup `stable`
compiler after entering its external source directory. That compiler lacked
the Wasm standard library; it was not a Go/FrankenPHP failure. The
SpiderMonkey recipe now exports the absolute compiler selected by Kandelo's
pinned dev shell. Its revision-15 package resolver build succeeded under the
default policy.
A default-policy WordPress retry then stopped at a browser bundle that
requires the source-only verified-source handoff. The WordPress resolver was
restarted with `WASM_POSIX_RESOLUTION_POLICY=source-only-v1` and the current
package revisions; the projected image and browser gallery checks remain
pending. Neither failed default-policy run is source-only evidence.

**2026-10-10 — Source-only FrankenPHP package stamping fixed.** The first
actual source-only WordPress resolution built through its shell and PHP ZTS
dependencies, then rejected `frankenphp-classic` because its recipe had
already stamped the Wasm with `kandelo.abi.contract`. The source-only resolver
owns that stamp and correctly refuses a duplicate. The recipe now stamps
only for default-policy/direct builds; revision 9 resolves under
`source-only-v1`. A new WordPress resolution is running against that verified
dependency. The revision-9 source-only artifact independently served PHP and
static HTTP in Node and Chromium with no host diagnostics. This fixes package
distribution and preserves the request behavior already established; it is
not WordPress gallery validation.

**2026-10-10 — Source-only WordPress gallery and admin pass.** Revision-21
WordPress resolved under `source-only-v1` with revision-9 FrankenPHP, then
`xtask bootstrap wordpress` published the verified image. The resolver-owned
image passes a Node demo admin login with no image override, a direct
Chromium kernel-host PHP request, the focused browser profile admin login,
and the gallery Launch/admin merge-gate case. The browser tests use the
product's actual Vite image URL; an earlier synthetic `page.route` URL was
intercepted by the service worker and returned HTML instead of the VFS, so
it was not valid end-to-end evidence. The canonical source-only projection
required current ownership for other authored service assets before Vite
could load any gallery machine; the selected service products and the
remaining MariaDB test/Wasm64 artifacts were published for that test.

`./run.sh browser` triggers the entire local-build set and stopped on two
unrelated package failures outside the selected WordPress/service closure.
Those failures are not evidence against FrankenPHP; they also mean this
full-tree command is not a passing validation claim. Restore the selected
projection after that failed run, then use the direct Vite server to keep a
live browser demo available. No WordPress performance comparison has been
made, and broader Go/C conformance gaps from the list above remain open.

**2026-10-10 — FrankenPHP demo integration gates complete.** After restoring
the selected source-only projection, all 149 authored browser imports that
have physical files have current projection ownership. The final focused
Chromium run passed three cases in one worker: the real product-profile
homepage/admin flow, Gallery Launch/admin flow, and Node-host demo/admin
flow. The test now resolves the product URL through the same fixture as the
gallery, rather than mocking a service-worker-intercepted request. The
source-only FrankenPHP artifact independently served PHP and static HTTP in
Node and Chromium; the source-only WordPress image served requests in the
direct Chromium kernel host. ABI snapshot, the Go cgo frontend test, pure-Go
`kandelo`/`js`/`wasip1` std builds, and libc-test `env`, `argv`, and
`tls_init` cases pass. These are focused gates, not full Go or POSIX
conformance.

The resolved Node demo runs at `http://localhost:3000/` and the direct Vite
browser app at `http://127.0.0.1:5401/`; Gallery can launch "WordPress on
FrankenPHP" from the same `wordpress.vfs.zst` used by the existing
nginx/PHP-FPM profile. `./run.sh browser` still cannot start because its
entire local-build set fails on two unrelated packages, so this live Vite
server was started directly after successful selected-product builds. A
measured WordPress performance comparison and the broader Go/C runtime
semantics (explicit init/fini arrays, secure-exec, automatic C shutdown,
general callback/thread stress and wider conformance) remain open.

**2026-10-10 — Go/cgo secure-startup gate.** A new Go/cgo child is launched
through a real set-ID VFS exec and a subsequent `posix_spawn`, both preserving
and resetting effective IDs. On Node and Chromium it observes the exact
kernel-owned secure marker through musl `issetugid`, `getauxval(AT_SECURE)`,
and `secure_getenv`; each result agrees with the expected image state, with
empty stderr and host diagnostics. This closes the focused Go-led secure-exec
startup gate, not a broad Go environment-security audit. The remaining order
is explicit `.init_array`/`.fini_array` layout and C shutdown expectations;
then general foreign-thread/callback and shared-memory reclaim/limit stress;
then broader Go, libc, and POSIX conformance and a measured WordPress
performance comparison. The FrankenPHP demo integration gates above remain
complete. The draft PR remains the single review target.

**2026-10-10 — metadata-only C init arrays and C-owned shutdown.** Fork
`b2ffde7ef08137e962f954b17b74603badf67d28` accepts the zero-filled
`.init_array.150` segments LLVM emits only when matching `INIT_FUNCS`
metadata supplies the callable constructor. It still rejects nonzero,
relocated, exported, or referenced array data. The constructor fixture now
checks priority-150 dispatch before the existing priority-200/300 functions
on Node and Chromium. A separate mode enters C `exit(0)` and verifies the
registered destructor runs on both hosts with empty stderr/diagnostics. Go
main return is not claimed to dispatch C exit handlers; LLVM itself rejects
`.fini_array` sections at compile time. `cmd/link/internal/ld`,
`cmd/link/internal/loadwasm`, and `cmd/cgo` tests pass. `go-hello` revision 7
and `frankenphp-classic` revision 10 pin the new fork commit; the source-only
package rebuild and WordPress regression are the next distribution gate.

**2026-10-10 — bounded concurrent foreign-thread stress.** The C-created
pthread callback fixture now runs three simultaneous callbacks for eight
rounds, freeing C allocations and forcing Go allocation/GC between rounds.
The stamped program passes Node and Chromium process gates with empty stderr
and host diagnostics. This exercises contention and a repeated reclaim path,
but not the configured thread-slot ceiling, long-running PHP worker churn,
or broad allocator/POSIX conformance. The Go fork itself is unchanged by this
fixture; package distribution still requires the resolver-owned WordPress
image from the new fork pin.

**2026-10-10 — pinned fork package regression.** The source-only resolver
built `go-hello` revision 7 and WordPress revision 21 with
`frankenphp-classic` revision 10 from fork `b2ffde7`; `xtask bootstrap
wordpress` republished the new image. Three focused Chromium cases then
passed in one run against that image: product-profile homepage/admin login,
gallery Launch/admin login, and the Node-host counterpart admin login. This
also verifies that metadata-only initializer support does not regress the
FrankenPHP WordPress route. Go package VFS launch, ABI snapshot, wider
conformance, performance comparison, and restarting the live demo on the new
projection remain as final handoff checks.

**2026-10-10 — resolver and live-demo handoff.** The source-only projection
now contains revision-7 `go-hello` and the new WordPress image. The resolved
Go package launches from a VFS child in Node and Chromium; Node reports zero
forks, and both hosts have empty stderr/diagnostics. ABI snapshot and pure-Go
`kandelo`/`js`/`wasip1` standard-library builds pass. The Node WordPress
demo restarted without an image override on the new projection and serves
homepage and login HTTP 200. The browser Vite app serves the new source-only
image and its WordPress/FrankenPHP profile loads in a manual Chromium session.
The broader Go browser suite is running; no application performance comparison
or complete Go/POSIX conformance claim is made.

**2026-10-10 — full focused Go browser suite and exploratory WordPress timing.**
All 27 Chromium Go-port cases pass, including process, network, stdlib,
PHP-embed, cgo callbacks, constructor order, C-owned exit, and the new
concurrent callback stress case. The `go-hello` revision-7 VFS launch also
passes Node and Chromium, with zero Node forks. A focused libc-test run passes
`pthread_mutex`, `pthread_cond`, and `pthread_tsd` (3/3); `tls_align` was
excluded because its companion `.mk` DSO is skipped by the runner and an
explicit invocation cannot link its helper. This is not a full libc-test run.

For a bounded browser-only application comparison, Chromium booted each
profile from the same source-only `wordpress.vfs.zst`, then fetched 15 dynamic
homepage URLs per profile (three warmups, 12 measured, full response body),
twice in alternating order. The two nginx/PHP-FPM sample medians were 713 and
721 ms; FrankenPHP classic's were 744 and 737 ms. The raw 48 samples are in
`.context/wordpress-stack-bench.log`, and the local bench script is in
`.context/wordpress-stack-bench.mjs`. This single-machine, sequential,
browser-proxy measurement shows no demonstrated FrankenPHP latency advantage;
it is not a throughput, cold-start, Node-host, or statistically powered
comparison. No general performance claim follows from it.

Remaining before **complete Go/C support** can be claimed: distinguish and
implement real initializer/finalizer array data if a source needs it (LLVM
currently rejects `.fini_array`); decide and test C exit-handler policy when
Go main returns; exercise thread-slot ceiling, extended PHP worker churn,
allocation limits, and callback races; run broader Go stdlib, libc-test,
Sortix/POSIX and cross-browser conformance. The FrankenPHP demo itself is
integrated and running; these remaining items are platform-wide rather than
demo-specific. The unrelated full-tree `./run.sh browser` failures in
`librsvg` and `rsvg-convert` remain a separate build issue.

**2026-10-10 — broader libc functional coverage.** The full musl libc-test
`functional` runner completed: 62 PASS, zero unexpected FAIL/BUILD/TIMEOUT,
and one expected `pthread_cancel` XFAIL for asynchronous cancellation that
Wasm cannot preempt. This supersedes the narrow three-case pthread run as
libc functional evidence, but is not the libc regression/math categories,
the Open POSIX Test Suite, Sortix os-test, or full Go standard-library tests.

**2026-10-10 — Open POSIX runner preflight and suite pass.** The first full
Open POSIX invocation timed out before guest execution because every test
launched a cold release `xtask` build inside its 30-second watchdog. The
runner now prepares the exact release checker once before entering per-test
timeouts and exports its path; its focused `asctime`/`clock` retry passed
3/3. The corrected full Open POSIX Test Suite then completed 179 cases:
174 PASS, three documented XFAIL (`mlock` and `munmap`), two unsupported
scheduler-priority SKIP, and zero unexpected failures, build errors,
unresolved cases, or timeouts. This is real C/POSIX conformance evidence,
not full Go stdlib or cross-browser POSIX conformance. Libc regression/math
and Sortix coverage remain separate.

**2026-10-10 — complete available musl libc-test categories.** The full
`regression` runner completed 59 PASS, two documented XFAIL, and one
`pthread_cond-smasher` FLAKE-PASS (62 total); the full `math` runner completed
185 PASS and 14 documented XFAIL (199 total). Together with `functional`,
the three categories ran 324 cases: 306 PASS, 17 documented XFAIL, and one
FLAKE-PASS, with zero unexpected failures, build errors, or timeouts. These
are C/libc conformance suites, not Go standard-library tests. They do not
erase the documented XFAIL boundaries.

**2026-10-10 — Go browser parity and shutdown policy.** The focused Go/C
runtime suite now runs in Chromium, Firefox, and WebKit. Its 31 cases per
engine include Go-owned return, `os.Exit`, C `exit(0)`, and C `_exit(0)`.
Go-led exits and C `_exit` bypass C handlers; C `exit(0)` dispatches them.
The four modes also pass in Node. The full browser matrix passed 93/93;
a three-engine smoke test also passed with a fresh Playwright-owned Vite
server. This intentionally follows Kandelo's
Linux-style raw `exit_group` Go runtime path, not observed native macOS
Go/cgo C-handler behavior. It is focused lifecycle evidence, not full Go
stdlib conformance or cross-engine WordPress behavior.

**2026-10-10 — Go filesystem/ownership conformance and refreshed packages.**
Fork commit `aff9084745912a3b0aedcda1214a0c809c3ace25` fixes Kandelo
directory enumeration, seek position, zero-inode entries, kernel-owned mode
bits, and path/fd/symlink ownership syscalls. Selected upstream Go `os`
(14 tests) and `syscall` (two tests) now pass on Node, Chromium, Firefox,
and WebKit. Pure-Go `kandelo`, `js`, and `wasip1` standard-library builds and
focused `cmd/cgo`/`cmd/link` host tests pass. These are selected upstream
cases, not the complete Go standard-library suites.

The source-only `go-hello` revision 8 and `frankenphp-classic` revision 11
packages now pin that fork commit. Both resolver bootstraps pass, including
the revision-21 WordPress image. The `go-hello` package VFS launch passes
Node and all three browsers (3/3 browser); direct FrankenPHP PHP/static HTTP
passes Node and all three browsers (3/3 browser). The WordPress/FrankenPHP
homepage, admin, and Gallery browser flow passes 3/3 in Chromium on that
image. The focused Go browser suite passes 33 cases per engine, 99/99 total,
including the selected upstream `os` and `syscall` cases. This supersedes the
31-per-engine checkpoint above. The live Node demo serves HTTP 200 at
`http://localhost:3000/`; the source-only browser image is served from the
Vite app at `http://127.0.0.1:5401/`. Neither the exploratory timing nor
these correctness gates show a FrankenPHP performance advantage.

**2026-10-10 — Go open-flag ABI and wider upstream `os` coverage.** A wider
upstream `os` run revealed `TestMkdirAll/InRoot` returned the wrong error
path: the fork's `O_DIRECTORY` and `O_NOFOLLOW` values did not match Kandelo's
kernel flags, so a regular file could be opened as an intermediate directory.
Fork commit `e2cb38f430915ba703332d91eb9950643c89a84e` aligns those
flags and `O_SYNC` with the Kandelo/musl constants. The selected `os` set now
includes 30 upstream top-level tests, including root-relative `MkdirAll`,
recursive removal, symlink/rename, file read/write, temporary paths,
directory seek/rewind, and root-relative open/symlink containment. All 30
pass on Node; two AF_UNIX-dependent subcases skip because that socket family
is unsupported. The combined probe passes on Chromium, Firefox, and WebKit
(3/3). The VFS supplies the upstream test files/directories these tests
normally find in Go's source checkout; the
initial missing-fixture failures were not platform failures. This does not
establish full upstream `os` conformance. Package revision 9 of `go-hello`
and revision 12 of `frankenphp-classic` pin the new fork commit; their
source-only bootstrap and WordPress image validation are pending below.

**2026-10-10 — refreshed fork/package/demo validation.** The dev-shell Go
fork rebuild succeeds. Pure-Go `kandelo`, `js`, and `wasip1` standard-library
builds and focused `cmd/cgo`, `cmd/link/internal/ld`, and
`cmd/link/internal/loadwasm` host tests pass. The full focused Go browser
matrix passes 99/99 (33 per engine) with the corrected open flags and 30
selected upstream `os` tests in its filesystem probe. Source-only bootstrap
of `go-hello` revision 9 and WordPress revision 21 succeeds; the latter
includes `frankenphp-classic` revision 12. The resolved Go package VFS
launch passes Node with zero forks and passes Chromium, Firefox, and WebKit
(3/3). Direct FrankenPHP PHP/static HTTP passes Node and all three browsers
(3/3). The WordPress/FrankenPHP direct kernel-host request, preinstalled
homepage/admin profile, and Node-host admin counterpart pass 3/3 Chromium
on the current source-only image. A first UI run failed before boot on a
Vite `react-dom` optimizer export mismatch while another Vite server was
active; stopping the concurrent server, forcing source-only dependency
optimization, and rerunning the same 3 cases passed. This was not evidence
of a Go/FrankenPHP process failure.

The live Node homepage and login return HTTP 200 at
`http://localhost:3000/`, and the refreshed source-only browser app at
`http://127.0.0.1:5401/` reaches the `wordpress-frankenphp` profile with
status Running and the WordPress homepage. The exact image URL is stored in
`.context/frankenphp-live-url.log`; its asset digest is
`a11cb3b5f83f3314fa6da2e9414f6bfd625d5920dbf4e7bf4995dc779d6a3daa`.
The current screenshot is `.context/frankenphp-browser-demo.png`. These
correctness results do not turn the exploratory timing into a performance
advantage or full Go/POSIX conformance claim.

The remaining Go/C platform gates, in recommended order, are:

1. Run broader Go standard-library/runtime conformance on the Kandelo target.
2. Support real relocated/non-metadata C initializer and finalizer arrays
   if needed by source ports; the current LLVM toolchain rejects
   `.fini_array` before Kandelo's linker sees it.
3. Generalize mixed-width pointer-bearing C struct access and by-value cgo
   calls; current PHP integration uses explicit C accessors and a scalar
   registration entry at that interop boundary.
4. Exercise configured thread-slot ceilings, longer PHP worker churn,
   allocator pressure, and concurrent callbacks; provision the full built-in
   program closure before rerunning Sortix os-test. Keep a formal application
   performance suite distinct from correctness validation. The exploratory
   browser timing so far demonstrates no FrankenPHP latency advantage.

---

## Task 7: Wire process start and args/env/stdout as needed

Ensure `_start`/`rt0`, `args`/`environ`, and stdout fd routing are
correct enough for `fmt.Println` to reach the terminal.

**Files (in the Go fork):**
- `src/runtime/rt0_kandelo_wasm.s`, `src/runtime/os_kandelo.go`
  (`args`/`environ`/`goenvs`), and the stdout path.

**Step 1:** Confirm the entry point runs `runtime` init and `main` on
Kandelo (mirror `rt0_wasip1_wasm.s`). Implement `goenvs`/args as
needed via channel syscalls or the Kandelo process-args mechanism
(record which Kandelo provides).

**Step 2:** Rebuild; proceed to Task 8 for the observable check.

**Step 3:** Commit in the fork.

---

## Task 8: End-to-end — hello world runs in a Kandelo worker (milestone success)

**Files (in the Kandelo repo):**
- Test/harness: reuse `runCentralizedProgram`
  (`host/test/centralized-test-helper.ts`) or the closest existing
  runner to launch `/tmp/k.wasm` through the real
  `CentralizedKernelWorker`.

**Step 1 (provision):** Under `scripts/dev-shell.sh`, run `./run.sh
setup` (builds musl + `kernel.wasm`) and `npm install` if not already
present. This is the one heavier provisioning step; do it now.

**Step 2 (write the end-to-end test):** A test that runs `/tmp/k.wasm`
via the centralized kernel and asserts stdout contains the hello line
and exit code is 0.

**Step 3:** Run it under `scripts/dev-shell.sh`. Capture literal
output. Expected: the hello line prints; exit 0.

**Step 4 (parity):** Note host parity is a contract. Full browser
validation via `./run.sh browser` is a follow-up within this milestone;
at minimum, confirm nothing in the path is Node-specific. Record what
was and was not run.

**Step 5:** Commit the end-to-end test in the Kandelo repo:
`Test: Go GOOS=kandelo hello world runs end-to-end via the kernel`.

---

## Milestone exit criteria

- A Go `hello world` built with the forked `GOOS=kandelo GOARCH=wasm`
  toolchain **instantiates** in a Kandelo process worker (passes the
  memory + `__abi_version` guards) and **runs**, printing to stdout via
  the channel ABI and exiting 0, verified by an end-to-end test under
  `scripts/dev-shell.sh` on Node.
- The Go fork is reproducible from a pinned upstream version plus the
  recorded changes (Decision 1's storage productionized, or at least
  the exact patch set captured).
- The design doc is updated with anything the implementation revealed
  (especially the exact `__abi_version` form and the chosen channel
  handshake mechanism), per the documentation contract.

## Explicitly out of scope for milestone 1

Threads/parallelism (`clone`/`newosproc`), networking (`net.Dial`,
netpoller), `os/exec`/`SYS_SPAWN`, cgo, browser-parity hardening beyond
a smoke check, and SDK/package-system integration. These are
milestones 3–6 in the design doc.

## Risks specific to this milestone

- **Task 4 (`cmd/link`) is the real unknown.** If importing shared
  memory from Go's linker proves large, timebox the spike and report
  findings before committing to an approach; it remains the internal
  gate and everything downstream depends on it.
- **Channel handshake atomics (Task 6, Option 1)** may require more
  wasm-backend work than expected; Option 2 (temporary host import) is
  the documented fallback and needs an ABI note.
- **`unix` build-tag fallout (Task 3)** may pull stdlib files that
  assume real syscalls; be prepared to narrow `UnixOS` membership or
  add `kandelo`-specific overrides.

---

## Follow-up work item: Go-runtime-specific agent guidance

**Completed 2026-10-09.** `docs/agent-guidance/go-runtime.md` is linked from
`CLAUDE.md` and routes fork/runtime work separately from registry package
porting. It records the build, ABI, per-M memory/channel, `exitThread`,
Node/browser probe, and progress-log contracts below.

Add a focused guide for extending the `GOOS=kandelo` Go runtime port. Route
agents to it from `CLAUDE.md` and distinguish it from the registry-package
porting skill. Cover the adjacent Go fork and its bootstrap/build commands;
the shared-memory, thread-slot, per-M channel, and Wasm import contracts;
Node and browser probe workflows; ABI/version decisions; and how to record
fork commits and validation in this progress log and the Kandelo PR. Include
the `exitThread` stack-reclamation ordering pitfall as a concrete example.
Done when an agent can reproduce a Go runtime probe, identify which repo owns
the fix, and report exact Node/browser evidence without relying on prior chat.
