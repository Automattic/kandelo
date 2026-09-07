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
needs. Follows Decision 2 (pure-guest handshake preferred).

**Files (in the Go fork):**
- Modify: `src/runtime/os_kandelo.go` and the relevant `syscall/
  *_kandelo.go` — replace the Task-3 stubs for `write`/`fd_write`,
  `exit`/`proc_exit`, `clock_time_get`, `random_get` with real channel
  marshalling.
- If Decision 2 = Option 1: add atomic wait/notify + atomic load/store
  emission in `src/cmd/internal/obj/wasm/` (and any assembler intrinsic
  plumbing) so runtime code can perform the `Atomics.wait`-equivalent
  handshake. Spike this first and record findings.

**Step 1 (study the contract):** Read `libc/glue/channel_syscall.c` and
the channel layout in `crates/shared/src/lib.rs` /
`docs/architecture.md` (channel status slot, arg region, data region,
`Atomics.wait/notify` handshake). Write the exact wire layout and
syscall numbers for `write`/`exit`/`clock`/`random` into this plan.

**Step 2:** Implement the handshake helper in the runtime (marshal
syscall number + args into the channel region, signal, block on the
status slot, read the result). Keep it single-threaded.

**Step 3 (unit-ish verification where possible):** If a host test
harness can drive a single syscall (e.g. a module that only does one
`write` then `exit`), build such a fixture under `.context/` and assert
the kernel observed the write. Otherwise defer to Task 8's end-to-end
run.

**Step 4:** Rebuild toolchain; rebuild hello world.

**Step 5:** Commit in the fork:
`git commit -am "kandelo/runtime: channel-syscall backend for write/exit/clock/random"`.

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
