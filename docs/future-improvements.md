# Future Improvements

Technical debt, deferred enhancements, and explicitly documented conformance
gaps. Listing an item here does not imply that the current behavior is fully
supported.

## ABI staging product retirement

### Retire obsolete VFS-wrapper package entries after acceptance

Canonical VFS product manifests will replace package-registry entries whose
primary purpose is to wrap a rootfs, shell, browser service image, language
runtime image, SDK image, or VFS test image. Keep those wrappers and the
main-shell Brewfile operational during rollout, but inventory them in the ABI
staging retirement ledger and remove them after every consumer uses canonical
product authority and the required transition, source-custody, repair,
failure-recovery, and Pages evidence is retained.

This retirement does not apply to ordinary software recipes. Formula and
package recipes for Bash, PHP, zlib, and other software continue to own their
portable source, license, dependency, output, and build facts unless a separate
package-system design replaces that contract.

## ABI modeling and package provenance

### Model semantic ABI transitions in Rust-owned machine-readable data

The checked-in structural ABI snapshot detects covered layout, number,
marshalling, export, and generated-protocol changes, but it cannot prove that
an existing syscall retained the same argument meaning, errno space, blocking
and restart behavior, memory effects, fd/OFD effects, process and signal
effects, or inheritance rules. Tests reduce this risk but are not semantic
classification authority, and developers must not classify a change as
"implementation-only ABI" by declaration.

As more host/kernel behavior moves from TypeScript into Rust, define a
canonical Rust semantic ABI model whose typed primitives describe observable
state transitions. Generate structural metadata and TypeScript protocol views
from that model, restrict ABI-owned mutations to modeled primitives, normalize
and compare old/new transition models automatically, and prove or exhaustively
model-check that implementations refine the declared model. Ordinary
differential and conformance tests should remain supporting evidence. Moving
code into Rust makes ownership and typed modeling easier; Rust by itself does
not provide the proof.

**Related design:**
`docs/superpowers/specs/2026-08-08-abi-bottle-staging-design.md`

### Preserve all external build sources in deduplicated content-addressed custody

The ABI bottle-staging MVP preserves the exact Kandelo and tap Git trees plus
required submodules with actual builds. Extend that custody contract to every
upstream source role consumed by a bottle: primary archives, resources,
patches, generated inputs, vendored dependency archives, native build inputs,
and any authenticated metadata needed to reproduce acquisition. Store each
unique byte object once by digest, keep a canonical role/identity manifest per
build, and retain objects while referenced by candidate, verification,
admission, canonical bottle, or historical-repair records.

This is source preservation associated with the actual build, not a detached
request-time repository mirror. It should allow later reconstruction even when
an upstream URL disappears without duplicating shared sources across Formulae
or attempts.

**Related design:**
`docs/superpowers/specs/2026-08-08-abi-bottle-staging-design.md`

### Ship ABI-matched POSIX and Kandelo manual pages

Provide user-space manual pages for the POSIX interfaces Kandelo implements,
the explicit boundaries it does not yet implement, and Kandelo-specific tools
and runtime configuration. Generate or select the pages through the same
ABI-qualified product inputs used to build VFS images so documentation cannot
silently describe a different kernel contract. Package the pages as normal
Homebrew/VFS software with content-addressed provenance rather than embedding a
browser-only help copy.

This is separate from the ABI-staging MVP. The initial work should inventory
upstream POSIX/man-page licensing and source roles, decide which pages are
generated versus imported, and add a basic `man` smoke test in Node and the
browser product that ships them.

## Kernel

### `sys_openat` duplicates `sys_open` logic
`sys_openat` reimplements umask application, file type determination, creation flag stripping, and O_CLOEXEC handling rather than sharing code with `sys_open`. Consider extracting a shared internal helper or implementing `sys_open` as `sys_openat(proc, host, AT_FDCWD, path, oflags, mode)`.

**Files:** `crates/kernel/src/syscalls.rs` — `sys_open`, `sys_openat`

### Fork deserialization lacks bounds checks on variable-length fields
`deserialize_fork_state` and `deserialize_exec_state` read length-prefixed fields (env vars, cwd, OFD paths) without capping the length. A malformed buffer could request a multi-GB allocation via `to_vec()`, causing OOM abort in `no_std`. Consider adding `if len > MAX_LEN { return Err(Errno::EINVAL); }` guards.

**Files:** `crates/kernel/src/fork.rs` — `deserialize_fork_state`, `deserialize_exec_state`

### `deliver_pending_signals` silently discards handler call errors
When `host_call_signal_handler` fails (invalid function table index, handler throws), the error is discarded via `let _ =` and the signal is consumed (already dequeued). Consider falling back to the default action on handler failure, or re-raising the signal.

**Files:** `crates/kernel/src/wasm_api.rs` — `deliver_pending_signals`

### Make cross-process shared memory immediate and futex-addressable

Anonymous `MAP_SHARED` inherits one host-owned backing across fork; SysV SHM
and stable-identity regular-file mappings share backings across separately
attached or mapped processes. Because each PID still owns a different
WebAssembly `Memory`, coherence happens only when a process crosses a syscall
boundary: the host merges bytes changed relative to that process's snapshot and
then imports peer changes. A direct store does not immediately change another
PID's memory, and futex WAIT/WAKE cannot target the peer's separate
`SharedArrayBuffer`.

Closing this gap requires a memory architecture or host protocol that supports
both immediate observation and wakeups, not just periodic byte merging. Any
design must preserve independent process address spaces, fork continuation,
Node/browser parity, and signal/cancellation behavior. It also needs explicit
performance evidence: the current boundary coordinator runs in the syscall hot
path, and its cost has not yet been established by before/after micro and full
application benchmarks on both hosts.

**Files:** `host/src/kernel-worker.ts`, `host/src/worker-main.ts`,
`host/src/browser-kernel-worker-entry.ts`,
`host/src/node-kernel-worker-entry.ts`

### Close the remaining regular-file `MAP_SHARED` gaps

The mapping cache deliberately rejects objects it cannot identify or keep
alive safely. Node, mounted VFS backends, and supported OPFS browsers now
provide exact live-handle identity; OPFS uses session-scoped inode tokens and
preserves an open object across rename and unlink. Initial mappings retain the
descriptor's live handle rather than reopening its remembered pathname.
In-kernel memfds still return `ENOTSUP` because they do not expose the host
handle used by the file page cache, and any backend unable to prove exact,
stable identity remains an explicit unsupported boundary.

Further gaps are observable VM semantics rather than cache bookkeeping. Stores
beyond the current file size are zero-filled or discarded on refresh/writeback
instead of raising Linux `SIGBUS`, and writers outside Kandelo's direct file
syscall paths do not invalidate cached pages. Complete support needs a
kernel-owned memfd mapping bridge, external invalidation (or a documented
ownership boundary), and a Wasm mechanism or instrumentation for faulting
beyond EOF.

**Files:** `host/src/kernel-worker.ts`, `host/src/vfs/opfs-worker.ts`,
`host/src/vfs/vfs.ts`, `crates/kernel/src/descriptor_backing.rs`

## Browser

### PTY terminal integration with xterm.js
The kernel has full PTY support (PR #181), and browser UI surfaces should use xterm.js-backed PTYs rather than plain `<div>` output with `appendStdinData`. Connecting PTY pairs to xterm.js gives proper terminal rendering (ANSI escapes, cursor, scrollback) and real terminal behavior (isatty=true, proper termios).

## Package artifacts

### Restore a default external software gallery

The browser accepts explicitly configured package-source manifests, but the
canonical Pages build does not currently name a default external gallery.
Package sources publish independently from Kandelo, and constructing a URL for
Kandelo's current ABI before that source has published the matching index and
gallery creates a guaranteed failing request rather than a usable catalog.

Restore a default only when a package source continuously publishes the
current Kandelo ABI and the release boundary has an explicit coordination or
availability contract. The browser should still validate the ABI-matching
index and surface later fetch or schema failures truthfully; the default must
not imply that an unpublished generation exists.

**Files:** `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`,
package-source publication workflows, `docs/package-sources.md`

### Define compatibility for restored lazy VFS images

Kandelo currently rebuilds and publishes canonical VFS images for the current
runtime; it does not persist a machine image for restoration across releases.
Old lazy Homebrew images can describe deferred files whose authenticated bytes
depend on the producer's guest prefix and relocation inputs. If a later host
uses different relocation defaults, allowing the image to boot and consulting
those defaults on first access can produce bytes that no longer match the
image's registered size and digest.

Before downloaded, shared, historical, or persisted lazy images become a
supported cross-release contract, image admission needs an explicit strategy:
carry and authenticate every relocation input needed to reproduce the
producer's deferred bytes, or reject an incompatible image before boot. The
runtime must not silently reinterpret authenticated image content through
mutable host defaults and fail only when a deferred file is first opened.

**Files:** `host/src/vfs/`, `images/vfs/`, package image builders and metadata

## Performance

### Revisit an optional wasm32 kernel build for IPC-heavy workloads
A May 6, 2026 prototype found that the Rust kernel can likely be built as
`wasm32-unknown-unknown` while keeping user-process pointer width independent
through the host's existing `ptrWidth` handling. The ABI 7 syscall channel
layout remained unchanged (72-byte header, 6 x i64 args, i64 return, i32
errno, 64KiB data buffer), and focused local tests covered wasm32 users,
wasm64 users, pipe IPC, and fork/exec on a wasm32 kernel.

The performance result was not stable enough to justify changing the default.
The first Node benchmark pass showed modest wins in some syscall and process
lifecycle paths, but the rerun was noisy: wasm32 process-lifecycle results
stayed close to the first run, while wasm32 syscall latency and wasm64 process
lifecycle numbers varied widely. Treat `kernel32.wasm` as a possible optional
artifact to investigate, not a replacement for the current wasm64 kernel path.

Any follow-up should:

- keep ABI 7 and wasm64 user-program support intact;
- keep the wasm64 kernel as the default until broader benchmark evidence exists;
- run all benchmark suites on both Node and browser hosts with repeated,
  alternating wasm32/wasm64 runs;
- check whether IPC time is dominated by host-side copying, wakeup scheduling,
  or retry logic rather than kernel pointer width;
- if the approach still looks useful, expose it as a separate `kernel32.wasm`
  build option.

## Kernel — regressions

### wasm64 musl: missing `__NR_pselect6_time64` alias forces select() through SYS_select
`libc/musl-overlay/arch/wasm32posix/bits/syscall.h.in:109` defines `__NR_pselect6_time64 = __NR_pselect6`, so musl's `select.c` routes wasm32 through SYS_pselect6 (252). The wasm64 overlay omits that alias; musl falls through to `#ifdef SYS_select` and uses **SYS_select (103)** instead. The host gained a SYS_SELECT timeout-aware handler (kernel-worker.ts `handleSelect`) so this works correctly today, but as defense-in-depth the wasm64 overlay should mirror wasm32 — fewer code paths, single canonical entry point. Doing this requires rebuilding the cached wasm64 binaries (the libc.a baked into them changes), so it's a coordinated rebuild task.

**Files:** `libc/musl-overlay/arch/wasm64posix/bits/syscall.h.in`

### Audit other PR #383 callers that may have missed the `GLOBAL_PIPE_PID` migration
PR #383 (`fix(kernel): share AF_INET accept queue across fork — nginx multi-worker`, May 2026) moved injected-connection pipes to the kernel's GLOBAL pipe table. `kernel_pipe_{read,write,close_*,is_*_open}` now treat `pid == 0` as a sentinel meaning "use the global pipe table". The HTTP bridge in `host/src/browser-kernel-worker-entry.ts` and `NodeKernelHost` were updated; `apps/browser-demos/lib/mysql-client.ts`, `apps/browser-demos/lib/redis-client.ts`, and the legacy `apps/browser-demos/lib/connection-pump.ts` helper have since been fixed. **Audit any future call site that does `kernel.injectConnection(...)` and then `kernel.pipeRead/pipeWrite` with a non-zero pid** — it will be broken in the same way (silent EBADF; bytes never reach the accepted worker).

**Files:** `apps/browser-demos/lib/*-client.ts`, anything calling `BrowserKernel.injectConnection`. Convention: store `this.pid = 0` (or import `GLOBAL_PIPE_PID = 0`) for all pipe ops on injected pipes.

## Host runtime

### Runtime tuning for the default pthread limit
Kernel worker creation currently accepts `defaultThreadSlots`, and processes
that declare `__wasm_posix_thread_slots = -1` use that boot-time default.
The next step is a runtime control surface, likely under `/sys` or `/proc`,
so an integration can tune the host default pthread concurrency limit without
rebuilding the SDK output or recreating the worker.

**Files:** `host/src/browser-kernel-worker-entry.ts`,
`host/src/node-kernel-worker-entry.ts`, `host/src/process-memory.ts`

### Move pthread control channels to a separate Wasm control memory
WebAssembly multi-memory can eventually split guest process memory from
host/kernel communication memory. That would let pthread syscall channels,
spill buffers, and fork-save scratch storage grow in a separate per-process
control memory instead of being statically reserved in the guest process memory
prefix. Safari/iOS Safari support is not sufficient for this to be the only
browser ABI yet, so this remains future work with a single-memory fallback.

**Plan:** `docs/plans/2026-06-04-pthread-control-memory-multimemory-plan.md`

### Use a tracked dlopen memory arena instead of one mmap per side module
`host/src/worker-main.ts` currently allocates each dlopen side module's
linear-memory data with a synchronous anonymous `mmap` through the syscall
channel. That is intentionally correct for address-space accounting: the
kernel's mmap allocator records the range, so later guest mmaps cannot overlap
and zero side-module data/GOT by accident.

The cleaner version is a small per-process dlopen arena: reserve one tracked
anonymous mmap region on first `dlopen`, then suballocate side-module data from
that arena with the dylink alignment requirements. This would reduce syscall
traffic, avoid page-sized waste for many tiny side modules, and give `dlclose`
a clearer place to reclaim or recycle side-module data later.

**Files:** `host/src/worker-main.ts` (`buildDlopenImports`),
`host/src/dylink.ts` (`LoadSharedLibraryOptions.allocateMemory`).
### Clarify and encapsulate dlopen side-module memory allocation
`host/src/dylink.ts` exposes the lower-level `DynamicLinker` machinery used
to parse `dylink.0`, lay out side-module data, apply relocations, and resolve
symbols. The real process path is broader: guest C `dlopen()` enters
`libc/glue/dlopen.c`, calls the worker import in `host/src/worker-main.ts`, and
then reaches `DynamicLinker` with a runtime-provided allocator.

That split is useful, but it should be harder for tests and production to
accidentally exercise different contracts. The practical regression test for
runtime dlopen behavior should be an integration test such as
`examples/dlopen/test.test.ts`, because it covers the same path used by real
guest programs. Lower-level `DynamicLinker` tests are still useful for linker
internals, but they should be described and structured as core-linker coverage,
not as evidence that guest `dlopen()` works end to end.

Future cleanup:

- extract the process-worker side-module allocator into a named helper or
  small object, for example `createDlopenDataAllocator(...)`;
- make that helper's contract explicit: allocated side-module data must be
  visible to the guest address-space manager, so later guest `mmap()` calls
  cannot overlap and zero it;
- keep syscall/channel details out of `DynamicLinker`; it should require an
  allocator, while the process worker supplies the runtime-specific tracked
  mmap allocator;
- consider replacing one mmap per side module with a tracked per-process
  dlopen arena that reserves one anonymous mmap and suballocates with dylink
  alignment;
- keep `examples/dlopen/test.test.ts` or an equivalent guest-level test as the
  primary regression test whenever changing dlopen allocation behavior.

**Files:** `host/src/worker-main.ts` (`buildDlopenImports`),
`host/src/dylink.ts` (`DynamicLinker`, `LoadSharedLibraryOptions`),
`examples/dlopen/test.test.ts`, `host/test/dylink.test.ts`.

## User-space programs

### Add a real shadow-stack overflow guard beyond the SDK's 8 MiB floor
Upstream `wasm-ld` reserves a default 64 KiB shadow stack (the linear-memory
region the compiler uses for spilled locals, `alloca`, and address-taken
locals). Kandelo's SDK raises executable links to an 8 MiB floor while
preserving larger explicit requests. That floor covers the mainstream
workloads that exposed the 64 KiB default, but it is a capacity policy rather
than an overflow guard.

The shadow stack grows **downward** from `__stack_high`, and `wasm-ld` places it
*immediately below* the `.data` / `.bss` segments in the same linear memory.
There is no guard page, no stack-pointer bounds check, and no trap: a function
that consumes more than the effective shadow-stack budget silently writes
through `__stack_pointer` into whatever data segment happens to be just below
it, corrupting unrelated globals.

PR #423 (PHP opcache) hit this concretely. `zend_build_ssa` (PASS_6, the
DFA-based SSA optimization pass) recurses deeply on real-world PHP files; the
shadow-stack frame underflowed by ~108 KiB into PHP's `alloc_globals` data
segment, silently corrupting `AG(mm_heap)`. The next `_efree` call dereferenced
the now-bogus heap pointer and trapped — surfacing as "memory access out of
bounds" inside the optimizer, with no indication that the actual cause was
stack overflow ~thousands of frames earlier. The PHP recipe still requests
`LDFLAGS=-Wl,-z,stack-size=4194304` (4 MiB), which the SDK raises to its 8 MiB
floor. The larger reserve covers PHP's observed workload but doesn't *prevent*
the failure mode: a deeper recursion or a larger `alloca` can still silently
corrupt data, and every linked program has the same undetected-overflow risk.

A real fix needs runtime detection so the failure surfaces as an obvious
crash, not silent corruption. Possible approaches:

- **Stack-pointer bounds check on syscall entry**: the channel-syscall glue
  already reads `__stack_pointer` for other reasons (`worker-main.ts`,
  `libc/glue/channel_syscall.c`). Adding `__stack_pointer < __stack_low` →
  `kill(SIGSEGV)` at each syscall entry would catch overflow at the next
  kernel crossing. Cheap to implement, low overhead, but only catches
  overflow when the program eventually calls into the kernel — silent
  corruption between syscalls is still possible.
- **`-fstack-check` / `-fstack-clash-protection`**: clang emits explicit
  page-touching probes for every function prologue when the frame exceeds a
  threshold. Catches overflow at the moment it happens, with no
  kernel-side cost, but inflates code size and may not be fully supported
  for the wasm target.
- **Linker-emitted stack-overflow check**: `wasm-ld` has a `-z stack-overflow-check`
  proposal in upstream binaryen / LLVM discussions. Worth tracking whether
  it ships and whether it interacts with our musl + fork-instrument
  pipeline.
- **Guard-page-style trap region**: reserve unmapped pages just below
  `__stack_low` so any underflow store traps cleanly. Wasm's linear memory
  has no native "unmapped" concept, but the kernel could mark a sentinel
  region and trap on writes to it via `kernel_*` checks at syscall time
  (degrades to the bounds-check approach above).

Once a real guard is in place, the per-program `-Wl,-z,stack-size=...`
overrides should be audited: programs that genuinely need a larger shadow
stack (PHP optimizer, deep parser stacks) keep the explicit override and
document why; everything else can drop the package-local flag and rely on the
SDK floor plus the guard.

**Files:** `sdk/src/lib/flags.ts` and `sdk/kandelo/bin/wasm32posix-cc` (current
8 MiB floor), `packages/registry/php/build-php.sh` (current 4 MiB request),
`libc/glue/channel_syscall.c` (likely site for a syscall-entry bounds check),
`host/src/worker-main.ts` (instantiation-time wiring for stack bounds),
plus any other `build-*.sh` that hits the same wall in the meantime.

**Related:** PR #423 (commit `fa9f579f6 feat(php): make opcache fully load opcache.so + survive PASS_6`) for the original root-cause analysis.

## Testing

### Browser-host vitest parity via `@vitest/browser`
Today's host test coverage is asymmetric: `host/test/*.test.ts` runs 56 vitest files against the Node host (kernel worker, NodeKernelHost, NodePlatformIO, syscall behavior, dlopen, mmap, fork via worker_threads), but the browser host is exercised only by:

- `host/test/browser-worker-adapter.test.ts` — single vitest file using mocked Web Workers in Node; does not run real browser code.
- `host/test/php-browser.spec.ts` — Playwright, one fixture.
- `apps/browser-demos/test/*.spec.ts` - Playwright over the Kandelo UI and retained browser labs.

Real-browser regressions land here repeatedly because the Node vitest suite is the de-facto fast feedback loop, and Playwright tests are slow and often `@slow`-tagged in CI. The dual-host-parity requirement (`CLAUDE.md` -> *Two hosts: Browser AND Node.js*) is enforced by review prompts, not by tests - which has already failed twice (PRs #388 and #410 shipped Node-only fixes that broke browser behavior with no test signal).

The structural fix is to stand up `@vitest/browser` (Vitest's official browser provider, Playwright or WebdriverIO transport) so the existing `host/test/*.test.ts` suite can re-run inside a real Chromium. Each test that doesn't depend on Node-only APIs (worker_threads, fs from Node, etc.) becomes free dual-host coverage. The tests that *do* hit Node-only APIs would either be tagged `@node-only` or refactored against the host abstractions (`PlatformIO`, `WorkerAdapter`) so they pass through `BrowserWorkerAdapter` + `VirtualPlatformIO` in browser mode.

Approximate scope:

- `host/vitest.config.ts`: add a `browser` workspace project (Vitest 3.x supports per-project provider config).
- Per-test audit: most fork/exec/pipe/socket tests should run unchanged once `node:fs`/`node:worker_threads` imports are routed through host adapters. File-resolution helpers (e.g., `tryResolveBinary`, `centralized-test-helper.ts`) need a browser-side equivalent that fetches `.wasm` via `import.meta.glob` or a vite-served URL.
- CI: a new job under `prepare-merge.yml` / `staging-build.yml`'s `test-gate` runs the browser vitest project. Should run in headless Chromium against pre-built kernel + fixtures, not require a full demo page.
- Migration is incremental: light up the browser project, run it with `--bail=0`, audit failures, tag genuinely Node-only tests, refactor the rest.

End state: a regression that shows up only on the browser host (signal delivery race, worker exit message wiring, dlopen GOT handling) fails a vitest test in the same PR, not a Playwright demo or a user-reported `./run.sh browser` failure.

**Files:** `host/vitest.config.ts`, `host/test/centralized-test-helper.ts`, `host/test/*.test.ts` (per-test audit), `host/src/worker-adapter-browser.ts`, `.github/workflows/prepare-merge.yml`, `.github/workflows/staging-build.yml`.

**Related:** `CLAUDE.md` § *Two hosts: Browser AND Node.js — DUAL-HOST PARITY IS LOAD-BEARING*; PR #388 (brk-base) and PR #410 (a_crash trap) as the failure-mode precedents this would close.

### Fork-instrument callback discovery broadening
PR #307's C3/C4 fixtures pass through the existing direct + table/`call_indirect`
closure, so the originally proposed "instrument every address-taken function"
rule was not added. If a future port registers a fork-calling callback that is
not discovered by that closure, implement a targeted callback-root rule rather
than broad full address-taken expansion. Two approaches:

- **Inter-procedural analysis:** identify `sigaction()` / `signal()` / `pthread_cleanup_push()` callers and propagate the function-pointer argument to determine which functions are actually registered as callbacks. Requires constant-propagation through the wasm bytecode. Complex but tool-internal.
- **Libc-hook approach:** intercept `sigaction()` / `signal()` / `pthread_cleanup_push()` at the libc layer (a wpk-specific override in musl-overlay) and surface the registered callbacks to the kernel at runtime. The fork-instrument tool then doesn't need to discover them statically — it instruments only the call graph from `kernel_fork`, and the kernel rejects fork attempts from un-instrumented callbacks at delivery time. Simpler to implement but breaks the "fork from anywhere works statically" property.

Any targeted rule must cover the callback-registration entry points proven by
the current regression matrix:

- `sigaction()` / `signal()` — signal handlers (C3).
- `pthread_cleanup_push()` — pthread cancellation cleanup handlers (C4).
- Any future address-taken host callback (`atexit`, `pthread_atfork`, `pthread_key_create` destructors, `qsort` comparators if they ever fork — pathological but possible).

Trigger criterion: a shipping port reaches `fork()` from a registered callback
that is absent from `wasm-fork-instrument --discover-only` output and fails at
runtime because the callback's call chain was not instrumented.

**Files:** `crates/fork-instrument/src/call_graph.rs` plus a possible
`instrument::analyze_callback_registrations` pass.
