# Future Improvements

Technical debt, deferred enhancements, and explicitly documented conformance
gaps. Listing an item here does not imply that the current behavior is fully
supported.

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

### Ship ABI-matched POSIX and Kandelo manual pages

Provide user-space manual pages for the POSIX interfaces Kandelo implements,
the explicit boundaries it does not yet implement, and Kandelo-specific tools
and runtime configuration. Generate or select the pages through the same
ABI-qualified product inputs used to build VFS images so documentation cannot
silently describe a different kernel contract. Package the pages as normal
VFS software with content-addressed provenance rather than embedding a
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

**Files:** `crates/runtime-core/src/memory.rs` (the mapping table and its
coherence protocol), `host/src/kernel-worker.ts` (still the live
implementation; see the cutover note below), `host/src/worker-main.ts`,
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

**Files:** `crates/runtime-core/src/memory.rs` (the page cache and its
writeback rules), `host/src/kernel-worker.ts` (still the live
implementation; see the cutover note below), `host/src/vfs/opfs-worker.ts`,
`host/src/vfs/vfs.ts`, `crates/kernel/src/descriptor_backing.rs`

**Cutover status.** `crates/runtime-core/src/memory.rs` now holds a Rust
implementation of the shared-mapping table, its page cache, the fd-writeback
bridge, the SysV byte-coherence mirror and fork inheritance, with unit tests.
It is dormant: nothing calls it, because a host-driven subsystem needs
host-callable `kernel_*` entry points and `crates/kernel/src/wasm_api.rs` is
the only place those can be declared. Until that wiring lands,
`host/src/kernel-worker.ts` remains the live implementation and is the file to
change for behavior. Moving ownership into Rust does not by itself close the
immediate-coherence gap above; that remains an architectural limit.

### Re-evaluate the Linux-specificity of the VT keyboard input path

The framebuffer keyboard path is Linux-shaped end to end so that
Linux-VT software such as fbDOOM runs unmodified. The host encodes key
events as single-byte Linux console MEDIUMRAW (`byte = keycode`, bit 7
set on release) in `host/src/framebuffer/browser-controls.ts`, the
kernel carries those bytes opaquely, and the guest decodes them. The
kernel also answers three Linux-VT keyboard ioctls
(`KDGKBTYPE`/`KDGKBMODE`/`KDSKBMODE`) on the process's terminal fd as
compatibility stubs: they report a Linux VT keyboard with sensible
defaults and treat mode changes as a no-op, without translating the
byte stream.

This is deliberate Linux-observable compatibility at a non-POSIX
boundary — VT keyboard input has no POSIX equivalent — but it has not
been evaluated as a long-term contract. Revisit whether the MEDIUMRAW
encoding and the VT-ioctl stubs are the model we want, whether they
should sit behind an explicitly documented input-device boundary, and
what the correct behavior is for non-VT consumers. Any change must keep
existing Linux-VT guests working and preserve Node/browser parity.

**Files:** `crates/runtime-core/src/syscalls.rs` (VT keyboard ioctls),
`host/src/framebuffer/browser-controls.ts`
(`encodeLinuxMediumRawKeyCode`), `crates/shared/src/ioctl_contract.rs`,
`docs/posix-status.md`

## Browser

### Replace the constrained public CORS proxy with an owned relay

The current public proxy has a narrow five-name request-header profile. A
Kandelo-owned authenticated relay should add explicit origin policy, private
network controls, rate limiting, abuse prevention, response limits, and
operational ownership. Once that capability exists, remove anonymous GET
omission mode and evaluate Node/browser transport parity without presenting the
current browser boundary as complete POSIX socket or HTTP fidelity.

**Files:** `host/src/networking/`, `apps/browser-demos/public/service-worker.js`,
deployment infrastructure and browser acceptance

### Reject credentialed Fetch modes at the constrained proxy boundary

The constrained proxy rejects explicit credential headers, but a
service-worker `Request` can also carry a credential mode independently of its
visible header list. Before the proxy path is used for authenticated browser
traffic, reject `credentials: "include"` and other credential-bearing modes
instead of rebuilding them as anonymous requests. Add a real service-worker
test that proves rejection happens before dispatch.

**Files:** `apps/browser-demos/public/service-worker.js`,
`apps/browser-demos/test/browser-cors-proxy.spec.ts`

### Forward `Content-Encoding` request bodies verbatim through the proxy

git compresses the smart-HTTP `git-upload-pack` fetch request and sets
`Content-Encoding: gzip`. The browser TLS-MITM currently decodes such bodies to
identity and drops the header so the request fits the proxy's five-name
allow-list — a faithful *equivalent* of what the guest sent, but not a
faithful *representation* of it. The more complete behavior is to forward
`Content-Encoding` and the compressed body unchanged. That requires
`content-encoding` in the CORS proxy request-header allow-list (the same
treatment the relay and upstream proxy already give `git-protocol`) and the
upstream proxy echoing it in `Access-Control-Allow-Headers` so the browser
preflight passes. Until then the decode path in `tls-network-backend.ts` is the
compatibility shim.

**Files:** `host/src/networking/tls-network-backend.ts`,
`host/src/networking/browser-cors-proxy.ts`,
`apps/browser-demos/public/service-worker.js`,
`apps/browser-demos/vite/dev-cors-proxy.ts`, upstream CORS proxy deployment

### Provide a real CA bundle at the shared `SSL_CERT_FILE` path on Node

Both hosts export `SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt`, but the
rootfs ships only `/etc/ssl/cert.pem`. The browser worker creates
`ca-certificates.crt` at runtime holding the per-session MITM CA; the Node host
creates nothing, so `SSL_CERT_FILE`-honoring clients (curl, openssl) find no CA
file on Node and external HTTPS from those clients cannot verify. git's remote
helper happens to fall back to libcurl's compiled-in real-root bundle, so the
gap is masked today and the Node git test only exercises plain HTTP. The Node
host should populate `ca-certificates.crt` with real roots (or the image should
ship it), so the same VFS image verifies real certificates on Node and MITM
certificates in the browser.

**Files:** `host/src/node-kernel-host.ts`,
`host/src/node-kernel-worker-entry.ts`, `images/rootfs/etc/ssl/`

### PTY terminal integration with xterm.js
The kernel has full PTY support (PR #181), and browser UI surfaces should use xterm.js-backed PTYs rather than plain `<div>` output with `appendStdinData`. Connecting PTY pairs to xterm.js gives proper terminal rendering (ANSI escapes, cursor, scrollback) and real terminal behavior (isatty=true, proper termios).

## Package artifacts

### `bc`'s upstream source cannot be fetched, so the rootfs cannot be built

**A fresh checkout cannot build `rootfs.vfs`.** `scripts/build-rootfs.sh`
fails at `bc@1.07.1`:

```
xtask build-deps: bc@1.07.1: build script packages/registry/bc/build-bc.sh
  exited with exit status: 1
curl: (22) The requested URL returned error: 404
```

This is not a missing tarball, and not a local accident. Measured
2026-09-09:

| URL | Result |
|---|---|
| `https://ftpmirror.gnu.org/gnu/bc/bc-1.07.1.tar.gz` (what `packages/registry/bc/package.toml:8` declares) | **404** |
| ...which redirects to `https://mirror.ihost.md/gnu//gnu/bc/bc-1.07.1.tar.gz` | note the doubled `/gnu/` |
| `https://ftp.gnu.org/gnu/bc/bc-1.07.1.tar.gz` (canonical) | **200** |

`ftpmirror.gnu.org` is a redirector that picks a nearby GNU mirror. At least
one mirror in its rotation answers with a **malformed path** — the `/gnu`
prefix appears twice — so the redirect lands on a URL that cannot exist.
Reproducible across retries, so it is not transient. Because the redirector
is chosen per request and per region, whether a given machine can build `bc`
depends on which mirror it is handed, which is exactly the kind of
undeclared-host-state dependency the build contract exists to remove.

**What it blocks.** `rootfs.vfs` is a hard prerequisite for every test that
boots a kernel with the canonical image. Concretely, the three original WASI
fixtures (`host/test/wasi-shim.test.ts`, the `wasi-hello` / `wasi-args` /
`wasi-scalar-abi` cases) cannot run at all in a checkout where the rootfs has
not been built, and neither can anything else that asks for
`rootfsImage: "default"`.

**Workaround for tests that do not need the base programs.** A test that
creates everything it needs can pass `useDefaultRootfs: false` and write
under `/tmp`, the tmpfs the kernel enables. The kernel's overlay `/` is
**read-only** with no image loaded — a `path_open` under `/` returns `EROFS`
— so a scratch file has to go somewhere else. `wasi-file-io.wat` and
`wasi-readdir.wat` are built this way and run without a rootfs image at all.
That is a better shape for a fixture regardless: a test of WASI file I/O has
no business requiring the whole base-program set.

**Fixes to consider**, in rough order of preference: point the recipe at the
canonical `ftp.gnu.org` URL instead of the redirector (loses mirror
selection, gains determinism); teach the fetcher to retry the canonical host
when a redirected fetch 404s; or vendor the checksum-pinned tarball the way
other pinned sources are handled. The source has a recorded `sha256`, so any
of these stays verifiable.

### Restore external software gallery support

The browser currently exposes only repository-defined gallery entries and
does not request explicitly configured package-source manifests. Package
sources publish independently from Kandelo, and constructing a URL for
Kandelo's current ABI before that source has published the matching index and
gallery creates a failing request rather than a usable catalog.

Restore this feature only with an explicit trust, coordination, and
availability contract. The browser should validate the ABI-matching index and
surface fetch or schema failures truthfully; support must not imply that an
unpublished generation exists.

**Files:** `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`,
package-source publication workflows, `docs/package-sources.md`

### Define compatibility for restored lazy VFS images

Kandelo currently rebuilds and publishes canonical VFS images for the current
runtime; it does not persist a machine image for restoration across releases.
Old lazy images can describe deferred files whose authenticated bytes
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

### RESOLVED 2026-09-09: the `bc` source URL was malformed, not mirror roulette

The `bc@1.07.1` fetch failure recorded elsewhere in this file was diagnosed as
`ftpmirror.gnu.org` handing out a mirror that emits a doubled `/gnu/` path, and
therefore as depending on which mirror a machine happened to be given. That is
not what was happening.

`bc` was **the only one of the 14 GNU packages in this registry whose declared
URL carried a `/gnu/` path prefix**. Every sibling uses
`https://ftpmirror.gnu.org/<package>/…`; `bc` used
`https://ftpmirror.gnu.org/gnu/bc/…`. The redirector prepends its own `/gnu/`,
so `bc` alone resolved to `…/gnu//gnu/bc/…` and 404'd. Measured:

| URL | result |
|---|---|
| `ftpmirror.gnu.org/gnu/bc/bc-1.07.1.tar.gz` (as declared) | **404** → `mirror.ihost.md/gnu//gnu/bc/…` |
| `ftpmirror.gnu.org/bc/bc-1.07.1.tar.gz` (sibling convention) | **200** → `mirrors.ustc.edu.cn/gnu//bc/…` |
| `ftpmirror.gnu.org/sed/sed-4.9.tar.xz` (control) | **200** |

So it was deterministic and repo-local, not environmental — which matters,
because "flaky mirror" invites a retry loop while the actual fix is one
character class of path. Fixed by dropping the redundant prefix; the recorded
`sha256` (`62adfca8…`) verifies bit-identically against the bytes the corrected
URL returns, so the artifact is unchanged.

This unblocks building `rootfs.vfs` in a fresh checkout, and with it
`KANDELO_SOURCE_CACHE_ROOT`-isolated build caches — which were unusable while a
cold cache could not fetch `bc`.

## Build freshness

### `scripts/build-musl.sh` exits 0 when its overlay copy fails

Reported 2026-09-09 by an agent provisioning a fresh worktree. With
`libc/musl` uninitialized, the overlay `cp` inside `scripts/build-musl.sh`
failed, but the script **exited 0**, leaving a partial `libc/musl/arch` tree and
no sysroot. The caller had no way to distinguish that from a successful build,
and the failure only surfaced much later as a confusing missing-sysroot error.

This is the same family as the stale-rebuild entry below and the two
skip-instead-of-fail test gates fixed on the same day: a step that cannot do its
job reports success anyway. The platform's own rule is truthful failure over
convenient illusion, and a build script is exactly where that has to hold —
everything downstream trusts its exit status.

Fix: fail the script when the overlay copy fails (and check the submodule is
initialized before attempting it), so a caller sees the real boundary.

**Files:** `scripts/build-musl.sh`.

### `./run.sh rebuild kernel` leaves the consumed artifact stale

`./run.sh rebuild kernel` compiles the kernel and installs it into the
SourceOnly cache, then exits reporting success — **without repointing
`local-binaries/kernel.wasm`**, which is the artifact every host actually
loads. `./run.sh local-build` does not repair it either: it trusts the cache
and skips the finalizer when the graph is otherwise clean.

Observed 2026-09-09 while validating the rust-first Tier-1 batch. The kernel's
`host_proc_read_bytes` import had been widened from a 32-bit to a 64-bit
address. The rebuild produced a correct artifact
(`kernel-…-d9828ad327e06ac0…`, verified with `wasm-tools print` to import
`(func (param i32 i64 i32 i32) (result i32))`), while
`local-binaries/kernel.wasm` still resolved to a generation built three days
earlier with the `i32` signature. Every `crates/host-native` smoke test failed
with `incompatible import type for env::host_proc_read_bytes`, and two full
rebuild cycles were spent before the projection — rather than the code — was
identified as stale.

The mismatch itself failed loudly, which is the stale-artifact contract working
as intended. The defect is one layer up: a command named `rebuild` reported
success while the consumed artifact did not change. A build step that cannot
refresh what it claims to rebuild should either do so or fail.

The declared installer repoints it correctly and takes seconds:

```
WASM_POSIX_LOCAL_INSTALL_SOURCE=<cache path>/kandelo-kernel.wasm \
WASM_POSIX_LOCAL_INSTALL_SESSION=<session> \
  xtask build-deps --arch wasm32 --binaries-dir local-binaries \
    install-local-artifact kernel kandelo-kernel.wasm
```

Fixes to consider, in preference order: have `cmd_rebuild` finish with that
install step; or have the freshness check compare the projection target against
the cache key it just produced and fail loudly on divergence, rather than
letting a stale symlink survive a successful rebuild.

**Files:** `run.sh` (`cmd_rebuild`, `cmd_local_build`),
`tools/xtask/src/local_build.rs`, `tools/xtask/src/build_deps.rs`.

## Kernel — regressions

### wasm64 musl: missing `__NR_pselect6_time64` alias forces select() through SYS_select
`libc/musl-overlay/arch/wasm32posix/bits/syscall.h.in:109` defines `__NR_pselect6_time64 = __NR_pselect6`, so musl's `select.c` routes wasm32 through SYS_pselect6 (252). The wasm64 overlay omits that alias; musl falls through to `#ifdef SYS_select` and uses **SYS_select (103)** instead. The host gained a SYS_SELECT timeout-aware handler (kernel-worker.ts `handleSelect`) so this works correctly today, but as defense-in-depth the wasm64 overlay should mirror wasm32 — fewer code paths, single canonical entry point. Doing this requires rebuilding the cached wasm64 binaries (the libc.a baked into them changes), so it's a coordinated rebuild task.

**Files:** `libc/musl-overlay/arch/wasm64posix/bits/syscall.h.in`

### Audit other PR #383 callers that may have missed the `GLOBAL_PIPE_PID` migration
PR #383 (`fix(kernel): share AF_INET accept queue across fork — nginx multi-worker`, May 2026) moved injected-connection pipes to the kernel's GLOBAL pipe table. `kernel_pipe_{read,write,close_*,is_*_open}` now treat `pid == 0` as a sentinel meaning "use the global pipe table". The HTTP bridge in `host/src/browser-kernel-worker-entry.ts` and `NodeKernelHost` were updated; `apps/browser-demos/lib/mysql-client.ts`, `apps/browser-demos/lib/redis-client.ts`, and the legacy `apps/browser-demos/lib/connection-pump.ts` helper have since been fixed. **Audit any future call site that does `kernel.injectConnection(...)` and then `kernel.pipeRead/pipeWrite` with a non-zero pid** — it will be broken in the same way (silent EBADF; bytes never reach the accepted worker).

**Files:** `apps/browser-demos/lib/*-client.ts`, anything calling `BrowserKernel.injectConnection`. Convention: store `this.pid = 0` (or import `GLOBAL_PIPE_PID = 0`) for all pipe ops on injected pipes.

## Host runtime

### The scratch-export allowlist is written twice, and only one copy is tested

`host/src/kernel-scratch.ts` states which kernel exports may borrow a scratch
lease in two places: the frozen `KERNEL_SCRATCH_EXPORT_NAMES` array
(`:131`) and a hand-written `switch` in `isKernelScratchExportName` (`:323`).
The array is the one `kernel-scratch-contract.test.ts` iterates; the `switch`
is the one the runtime actually consults.

Adding an export to the array alone therefore passes every test and fails at
run time — and it fails **fatally**: a rejected borrow is an export-failure
signal, so the entry gate poisons the kernel instance rather than returning an
error to the caller. Found on 2026-09-10 while adding
`kernel_classify_wasm_trap_signal`, where the symptom was every Wasm trap
reporting exit status -1 with the kernel worker torn down underneath it.

The `switch` exists so the check is a compile-time-exhaustive type guard rather
than an array scan. Both properties are obtainable from one source: derive the
predicate from the frozen array (a `Set` membership test with a
`value is KernelScratchExportName` return), or have a test assert the two agree
name-for-name. Either removes the second authority.

### `crates/host-native` reports a faulting guest without `WIFSIGNALED`

A guest that traps under `crates/host-native` now ends with the same wait
status a JavaScript host records — `128 + signum`, with the signal chosen by
`wasm_posix_shared::trap_signal` from wasmtime's typed `Trap`. Two pieces of
fidelity are still missing, and both are recorded here rather than papered
over in the host.

- **The signal flag.** Node and the browser additionally call the kernel's
  `kernel_mark_process_signaled(pid, signum)` export, which is what makes
  `WIFSIGNALED(status)` true and `WTERMSIG(status)` name the signal. That
  export must be called on the kernel `Store`, which belongs to the pump
  thread; the fault is detected on the guest's own OS thread, which has no
  access to it. Closing this needs the guest thread to hand the classified
  signal to the pump — a small shared slot the pump drains beside the exit it
  already processes — rather than a new export.
- **A guest's own `unreachable` is swallowed.** `run_fork_capable_entry`
  treats `Trap::UnreachableCodeReached` as a clean return, because this host's
  exit path unwinds the guest with exactly that trap once the kernel has
  committed the exit status. A guest that genuinely executes `unreachable`
  therefore ends silently where a JavaScript host reports SIGILL. Separating
  the two needs a committed-exit flag the guest OS thread can read; the
  coordinator's information is already there in the kernel, so this is
  plumbing rather than a new decision.

Every other trap kind — memory, table/array bounds, stack overflow, integer
division and conversion faults, null and mistyped indirect calls — is
classified and reported.

### WASI modules that define their own memory cannot be run (proven boundary)

`host/src/worker-main.ts:3292` refuses any WASI module that defines and
exports its own linear memory rather than importing one, and
`host/src/wasi-detect.ts:44` (`wasiModuleDefinesMemory`) is what detects it.
This is the shape a **default wasi-sdk link emits**, so it is the first thing
someone trying to run an off-the-shelf WASI binary will hit. The refusal is a
real platform boundary with a proven cause, not a conservative stub, and it
should stay a loud failure.

Measured 2026-09-09 on Node v24.15.0, Chromium 151, and WebKit 26.5 (all
agree). Harness and raw results: `docs/plans/probes/2026-09-09-k10/`, probe 4.

- **A self-defined memory is not shared.** Kandelo's syscall channel needs a
  shared memory: the guest side blocks on `memory.atomic.wait32` and the
  kernel worker wakes it with `Atomics.notify`. Neither works on a
  non-shared memory, so there is no way to make a syscall at all.
- **`memory.atomic.wait32` on a non-shared memory fails, and the engines
  disagree on how.** Node and Chromium throw `Atomics.wait cannot be called
  in this context`; WebKit traps `Out of bounds memory access`.
- **The `Atomics.notify` half fails SILENTLY — it returns `0`** rather than
  throwing. Any future code that reaches this path would look like a lost
  wakeup rather than an unsupported configuration. If this category is ever
  revisited, assert shared-ness explicitly instead of relying on a failure.
- **The guest-side translation cannot be moved out of the way either.** A
  co-resident side module (the `crates/wasi-module` design) must declare its
  imported memory `shared` in order to use `memory.atomic.wait32`, so it
  cannot even be *linked* against a self-defined non-shared memory:
  instantiation fails with a shared-state mismatch on all three engines.
  Separately, the wiring is circular — the side module needs the guest's
  memory at its own instantiation, and the guest needs the side module's
  exports at its own instantiation.
- **The one serviceable sub-case is not worth having.** A guest that defines
  its memory but declares it `shared` *can* be served, but only by breaking
  the cycle with a JavaScript trampoline that forwards every WASI call —
  reinstating the per-call JS frame the Rust migration exists to remove. No
  such artifact exists in this repository.

To actually support off-the-shelf WASI binaries, the fix is not to soften the
check: it is to relink or rewrite the module to import a shared memory
(`--import-memory --shared-memory`), which is what Kandelo's own
`wasm32-posix` toolchain already does. A future improvement could detect this
category and say exactly that in the error message.

Related and separate: the repository has **no way to build a realistic WASI
guest** today. There is no wasi-libc sysroot in `flake.nix`
(`clang --target=wasm32-wasi` fails in the dev shell) and the pinned Rust
toolchain carries std only for `aarch64-apple-darwin` and
`wasm32-unknown-unknown`, not `wasm32-wasip1`. Every WASI test fixture is
therefore hand-written `.wat`, which can call every entry point but cannot
exercise a real libc's heap growth, path handling, or multi-batch directory
reads. Adding a wasi-sdk to the flake was considered and **declined**
2026-09-09: it changes the build-environment contract and pulls a large nix
closure for a capability with no in-repo consumer. Revisit only when a real
WASI binary needs to ship.

### Complete SpiderMonkey nonblocking TLS cancellation and write ordering

The native Node compatibility layer now retries OpenSSL `WANT_READ` and
`WANT_WRITE` through the existing readiness dispatcher, which is sufficient
for ordinary HTTPS and npm traffic. Two lifecycle edges remain to harden:

- serialize concurrent writes per TLS handle so a later write cannot enter
  OpenSSL while an earlier write is waiting to retry; and
- retain a cancellation handle for a handshake that has not produced a socket
  object yet, so destroying the JavaScript socket can unlink its readiness
  watch and release the file descriptor, `SSL`, and context exactly once.

Add focused cases for two writes where the first returns `WANT_WRITE`, and for
socket destruction while a handshake remains pending.

**Files:** `packages/registry/node-compat/bootstrap.js`,
`packages/registry/spidermonkey/patches/0012-kandelo-node-compat-shell-entry.patch`

### Resolve main-script relative imports in SpiderMonkey Node compatibility

The installed cowsay package works through its public module API, but directly
executing its CLI currently fails to resolve `./index` relative to the package
entry script. Fix the main-script module base so normal installed bin shims can
run without an API-level invocation, then restore browser acceptance to execute
`./node_modules/.bin/cowsay Kandelo` through the ordinary shell path.

**Files:** `packages/registry/node-compat/bootstrap.js`,
`apps/browser-demos/test/kandelo-node.spec.ts`

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

### Native (wasmtime) exnref fork CAPTURE wiring + empirical exnref fork

Context: the coarse-fork-module migration brought `crates/host-native` in line
with the Node/browser hosts — the native fork driver now drives every phase
through the coarse `fm_parent_*`/`fm_child_*` entries, and (like the other
hosts) binds the guest's reference/GC/exception decode imports to the module's
`fm_ref_*`/`fm_funcref_ordinal` feed and host-drives the topological GC/exnref
reconstruction via `fm_drive_execute`.

The exnref RECONSTRUCT side is fully wired on native and is NOT blocked by
wasmtime: wasmtime 48 with `wasm_gc(true)` + `wasm_exceptions(true)` loads the
fork-instrumented exnref-declaring guest and runs it (`smoke_loads_fork_
instrumented_guest`), `ThrownException` + `Store::take_pending_exception` work,
the guest's `__wpk_fork_ref_exn_{route,load,cache_index}` imports are bound to
the module's `fm_ref_exn_*` exports, and the `_exception_materialize` drive-table
slot is bound. So the maintainer's originally-flagged concern ("wasmtime cannot
reconstruct exnref") is stale — reconstruction is not the blocker.

The remaining gap is native's exnref CAPTURE side. The exception-codec CAPTURE
imports the guest calls while spilling a live exnref across a fork —
`__wpk_fork_ref_exn_claim`, `__wpk_fork_ref_exn_define`,
`__wpk_fork_ref_exn_broker_encode`, `__wpk_fork_ref_exn_lookup`,
`__wpk_fork_ref_exn_ingress_throw` (see `WPK_FORK_EXCEPTION_IMPORT_*` in
`crates/shared/src/lib.rs`) — are NOT bound in `crates/host-native/src/guest.rs`
(only the three reconstruct-side imports are). They fall through to
`define_unknown_imports_as_traps`, so an exnref-carrying fork would TRAP during
capture (fail loud — a wasm trap ending the guest OS thread — not silently
wrong), rather than reconstruct or cleanly gate.

This was not driven empirically because no exnref-carrying fork FIXTURE exists:
the current fixtures cover frames-only, funcref, externref, and Wasm-GC
struct/array/i31 forks, none of which hold a live exnref across `fork()`.
Authoring one (a WAT with `try_table`/`throw` + an exnref local held across
`fork()`, run through `scripts/run-wasm-fork-instrument.sh` so the tool emits the
`kandelo.wpk_fork.exception_codec` section and the capture calls) is a
substantial, separate effort.

Recommended follow-up:
- Bind the exception-codec CAPTURE imports on native, either to a full Rust
  capture body (the exnref analogue of the `gc_lookup`/`gc_claim`/`gc_define`
  bodies in `spawn_guest_thread`) so an exnref reconstructs end-to-end, or — as a
  smaller first step — to a clean `NativeReferenceCapture::mark_unsupported(
  "exnref")` gate (mirroring the `encode_externref` gate) so an exnref fork's
  parent survives with `EOPNOTSUPP` instead of a raw unbound-import trap.
- Author an exnref-carrying fork fixture and a `smoke_fork_exnref_reconstructs`
  test to drive capture + reconstruct end-to-end and assert
  `exnrefs_reconstructed > 0`.

**Files:** `crates/host-native/src/guest.rs` (the reference/exception import
binding block in `spawn_guest_thread`, and `NativeReferenceCapture`);
`crates/host-native/fixtures/` (a new exnref fixture); `crates/host-native/src/
lib.rs` (a new test).

## Fork control-flow inversion and rust-first migration

Deferred follow-ups from the fork control-flow-inversion / rust-first campaign.
The behaviors below are enforced today (fail-loud or documented boundary); these
items reduce host surface, remove fixed caps, or close truthful-failure gaps.

- **Consolidate the per-type reference marshalling exports behind an opaque
  encode/decode dispatch (the 71-export count is not the true floor).** The
  ~43 per-type reference capture/reconstruction marshalling exports —
  `fm_capture_*`, `fm_ref_*`, `fm_funcref_ordinal`, `fm_externref_handle`,
  `fm_static_root_slot`, `fm_decoded_*`, `fm_decode_reference_graph`, and the
  reconstruction drive/plan/install group — are a wide per-type guest<->module
  surface. A follow-up PR should consolidate them behind a narrower opaque
  encode/decode dispatch, driving the fork-module export count well below the 71
  this PR reaches. **Files:** `crates/fork-module/src/lib.rs`,
  `crates/fork-codec`, `host/src`.

- **Move the pre-launch externref-handle scan out of TypeScript into
  fork-codec (Rust).** The browser/production path scans the segmented fork
  reference wire for externref handles in TypeScript
  (`host/src/fork-reference-wire.ts` `scanSegmentedForkReferenceExternrefHandles`
  + `parseSegmentedForkReferenceTransaction`, consumed by
  `host/src/fork-externref-process-owner.ts`), re-decoding the fork-codec wire
  format (node-record kind byte, handle words, manifest/segment layout) in the
  host — duplicating decode logic `fork-codec` owns. `6da756719` deleted the
  unused Rust scanner (`fm_scan_externref_handles`) rather than wiring it. A
  follow-up should have `fork-codec` own the scan and the host consume decoded
  handles (host keeps only the externref-identity / process-ownership
  bookkeeping, which is legitimately host-side). Not done in this PR: it is not
  a correctness bug, and re-adding a module export now would work against this
  PR's export-reduction goal. **Files:** `crates/fork-codec`,
  `host/src/fork-reference-wire.ts`, `host/src/fork-externref-process-owner.ts`.

- **Retire the remaining test-only fine-grained `fm_*` fork-module exports.**
  Two bounded, already-flagged reductions (~5 exports): (a) migrate the
  `fm_drive_execute` store-#2 GC-integrity trap regression from the Node-only
  `host/test/fork-module-drive-shim.test.ts` (driven by `fm_build_trivial_plan` /
  `fm_trivial_plan_count`) into a host-native wasmtime instantiation test built on
  `fork_codec::drive_plan::{trivial_struct_plan, serialize_plan}`, then delete both
  exports; (b) retire the three V8 build-time `.mjs` harnesses and move their
  fixed-arena unwind/serialize coverage into Rust wasmtime tests, then delete
  `fm_begin_unwind_fixed_arena`, `fm_add_activation_unwind_fixed_arena`, and
  `fm_serialize_journal_fixed_arena`. **Files:** `crates/fork-module/src/lib.rs`,
  `crates/host-native`, `host/test/fork-module-drive-shim.test.ts`, the
  fork-module `.mjs` harnesses.

- **Migrate host-native's fork engine onto the coarse drive-table entries
  (major).** `crates/host-native` is a second, complete fork engine that drives
  the guest through the fine-grained reference-decode import plane, interleaved
  wasmtime-native reference materialization, and direct guest phase calls, so it
  cannot adopt the coarse `fm_parent_*` / `fm_child_*` entries without a ground-up
  rewrite; roughly 29 native seed/phase exports stay on the fine-grained surface
  until then (and about 10 reference-decode import exports are irreducible on
  native regardless). **Files:** `crates/host-native/src/guest.rs`.

- **Fold the capture-begin and child-seed fork phases into coarse module
  entries.** `fm_begin_unwind` / `fm_add_activation_unwind` (capture-begin) and
  `fm_begin_child_replay` / `fm_add_activation_child_replay` (+ borrowed variants,
  child-seed) still run as host-called seed ops because they exchange KFMS
  arena-root, journal-image, and continuation-manifest metadata bidirectionally
  with the host. Folding them requires moving KFMS arena-root ownership and
  journal/manifest decode into the Rust module; the child-seed fold is on the
  browser-gated reentrant child-drive path and must be validated on browser, not
  Node alone. **Files:** `crates/fork-module/src/lib.rs`, `crates/fork-codec`,
  `host/src/fork-process-continuation.ts`.

- **Make the fork resume-catalog cap dynamic.** The per-activation resume catalog
  is a fixed 65536-entry fork-module BSS array (`RESUME_CATALOG_CAP` /
  `ACTIVATION_CATALOG_ORD_CAP`), sized to survive the per-fork bump-heap reset; a
  guest with more fork-instrumented functions fails loud (`E2BIG`) rather than
  growing. A module-owned catalog backed by a host-provided persistent
  (non-bump-reset) region would remove the cap if a future guest approaches it.
  **Files:** `crates/fork-module/src/lib.rs`, `host/src/fork-module-backend.ts`,
  `crates/host-native/src/guest.rs`.

- **Bound or reclaim the native externref/GC provenance registry.** Wasmtime 48
  has no weak GC-ref primitive, so the native reference-provenance registry uses a
  4096-entry cap with a loud diagnostic instead of the TypeScript hosts' WeakMap;
  revisit if wasmtime gains weak references or a guest exceeds the cap.
  **Files:** `crates/host-native/src/guest.rs`.

- **Preempt the pre-exec thread and memory leaked by native `execve`.** A
  successful native (wasmtime) `execve` cannot preempt the old guest's parked OS
  thread — no engine epoch-interruption or fuel is configured — so each call
  permanently leaks one OS thread plus its backing `SharedMemory`; a guest that
  `execve`s in a loop leaks unboundedly. A multi-threaded `execve` also does not
  reconcile the old process's worker/pthread channels against the kernel's
  `clear_threads`. Both need engine-wide epoch interruption. **Files:**
  `crates/host-native/src/guest.rs`.

- **Close the fork/exec-from-thread and concurrent-fork residuals (post-ship
  truthful-failure boundaries).** (a) Instrumented fork-from-thread parent replay
  traps in `RewindDriver::resume_peek` / `ResumeSlotTable::slot_for` for a
  `wpk_fork_resume_thread`-reached (non-`_start`) resume chain the host resume
  table does not cover — cross-crate and high blast radius. (b) `execve` from a
  non-main thread and compute-bound sibling-thread teardown on multi-threaded
  `execve` need engine-wide epoch interruption. (c) Concurrent `fork()` from two
  threads of one process contends on the shared fork-module region. (d) Nested
  `pthread_create` / `kernel_clone` from a worker thread hits the same
  unwired-import shape as (a). **Files:** `crates/fork-codec`,
  `crates/host-native/src/guest.rs`, `host/src/worker-main.ts`.

- **Support references held across a borrowed vfork child and mid-borrow
  teardown.** References held across a borrowed vfork child are out of scope
  today, and there is no nuclear-teardown path if a process crashes mid-borrow.
  **Files:** `crates/host-native/src/guest.rs`.

- **Wire the pthread worker's fork-module frame imports so a dlopen'd
  fork-instrumented side module can instantiate on a foreign pthread.** The
  two pthread-hosted dlopen tests in `host/test/fork-dlopen-replay-e2e.test.ts`
  ("replays pthread-hosted dlopen table state into a fresh fork child" and
  "blocks a foreign pthread until the staged loader owner commits") fail with
  `WebAssembly.Instance(): Import "env" "__wpk_fork_frame_reserve": function
  import requires a callable`. This is pre-existing (baseline red before the
  fork control-flow inversion, not caused by it); the three main-thread dlopen
  siblings in the same file pass. Root cause: the pthread worker in
  `host/src/worker-main.ts` builds `threadForkModuleInstance` /
  `threadForkModuleBackend` but never constructs a thread-side
  `ForkModuleTrampolines`, and `replicaActivationOwner` is created without a
  `forkModuleFrameFlip`, so a dlopen'd fork-instrumented side module on a
  foreign pthread instantiates with `__wpk_fork_frame_reserve === undefined`.
  Fix (host-side import wiring only, no ABI bump — mirror the main process
  worker's path): (1) declare a thread-side `threadForkModuleTrampolines:
  ForkModuleTrampolines | null` alongside the existing thread fork-module
  instance/backend; (2) after `threadForkModuleBackend.setup()` construct
  `new ForkModuleTrampolines(threadForkModuleInstance.exports)` and pass the
  eviction callback on the thread `enableModuleBacking` call, mirroring the
  main-worker call; (3) add `forkModuleFrameFlip` (the thread trampolines plus
  backend, when both exist) to the `replicaActivationOwner` options. Deferred
  because it is pre-existing and a shared pthread-worker-lifecycle change beyond
  this PR's inversion scope. **Files:** `host/src/worker-main.ts`.

### `cargo run -p xtask` needs an explicit host target

`.cargo/config.toml` sets `[build] target = "wasm32-unknown-unknown"` for the
whole workspace, so `cargo run -p xtask -- verify-fresh` compiles **xtask
itself** for wasm32. xtask depends on `ring`, `getrandom` and `zstd-sys`, none
of which build for that target, and nix's `NIX_HARDENING_ENABLE=…zerocallusedregs`
expands to `-fzero-call-used-regs=used-gpr`, which clang rejects for wasm32.
The failure is a wall of `cc-rs` errors that names none of this.

The freshness gate — the thing that makes stale artifacts fail loudly — is
therefore unreachable by its obvious invocation. Correct form:

```
./scripts/dev-shell.sh cargo run -p xtask --target aarch64-apple-darwin -- verify-fresh
```

**Fixed (2026-09-10) by `scripts/xtask.sh`**, which derives the host triple and
passes `--target`. Use it for any direct xtask verb:

```
./scripts/dev-shell.sh scripts/xtask.sh verify-fresh
```

The properly-declarative fix is `forced-target` in `tools/xtask/Cargo.toml`,
which is what the manifest's own comment recommends. It is still unavailable:
it is gated on the nightly-only `per-package-target` feature, and re-testing it
on this repo's current pinned toolchain (2026-09-10) still panics the cargo
resolver rather than erroring cleanly. Revisit when that lands; the wrapper can
then be deleted.

### The shared source cache captures absolute paths from the worktree that filled it

`$HOME/.cache/kandelo/source-only` is shared by every worktree on a machine,
and a cache entry records the **absolute source path** of whichever worktree
populated it first. A later `./run.sh setup` in a *different* worktree can then
execute that other tree's build script against that other tree.

Observed 2026-09-10: `setup` in worktree B ran worktree A's
`build-kandelo-sdk.sh` against A, which failed on a missing `fzstd` because A
had no `node_modules`. The failure names neither worktree and looks like a
dependency problem in the tree you are standing in.

This is **distinct from** the resolved cache-key drift investigated in 2026-08,
and distinct from ordinary contention (two agents mutating
`program-packages.json` concurrently, which cost one agent three consecutive
`prepare-browser` attempts and made several suites appear flaky).

Two things follow:

1. **Workaround, available today:** set `KANDELO_SOURCE_CACHE_ROOT` to an
   absolute path unique to the worktree (`run.sh:25`,
   `tools/xtask/src/local_build.rs:406`). Costs a cold first build.
2. **Real fix:** a cache entry should either key on, or be independent of, the
   populating worktree's absolute path. Silently running another checkout's
   build script is the kind of cross-tree action the build contract otherwise
   forbids, and it produces failures that are indistinguishable from real
   defects in the current tree — the property that makes it dangerous rather
   than merely annoying.

### Check `no_std` targets, not just the host

`cargo check -p runtime-core --target aarch64-apple-darwin` passing does not
mean the crate builds. On 2026-09-10 a `String` reference that resolves through
`std` on the host failed on wasm32/wasm64, where the crate is `no_std` and must
name it through `alloc`. A native-only check called that code green.

Runtime-core and the kernel ship to wasm. Check **wasm32 and wasm64** before
claiming a Rust change builds.

Two reproducible symptoms of the shared-cache contention above, recorded so
they are recognized rather than investigated as defects in the current tree:

- `trusted source-only cache entry vanished before capture` — two agents
  populating the same entry concurrently.
- `source-only build input changed while it was validated and digested` — a
  concurrent Vitest run regenerating `packages/registry/program-packages.json`
  underneath an in-flight build.

Both cost one agent several build cycles and three consecutive
`prepare-browser` attempts.

### `./run.sh setup` does not install the repository's root npm dependencies

`rootfs` and `node-browser-bundle` both fail in a fresh worktree because
`node_modules/tsx/dist/cli.mjs` is absent at the **repository root**. Neither
message said so, and the campaign's own recorded recipe —
`npm --prefix host install`, which exists because `vitest` is a `host/`
devDependency — does not satisfy it.

`rootfs` failing then **cascade-blocks every browser product**:
`platform-rootfs`, `browser-main-shell`, `browser-nginx`, `browser-wordpress`,
`shell`, `node-vfs`, `nginx-vfs`, `lamp`, `coreutils-docs`. An agent told not to
fight browser provisioning hits this and reasonably reads it as the browser
being broken.

Both messages now name `npm ci` at the repo root and say explicitly that
`npm --prefix host install` is not enough. **That is the diagnostic half.** The
open question is whether `./run.sh setup` should install root dependencies
itself, the way it already bootstraps `host/` and `tools/mkrootfs/` in the
non-sealed path. It is the one provisioning step a fresh worktree needs that
`setup` does not perform, which makes it the odd one out rather than a
deliberate boundary.

### epoll fork inheritance and OFD keying are ONE change, not two

The K3 grounding lists these as D2 ("serialize `epolls` across fork") and D3
("re-key `EpollInterest` on OFD identity"), and calls D3 "separable". Measured:
they are the same change.

`Process.epolls` is a per-process `Vec<Option<EpollInstance>>`. `fork.rs` does
`child.epolls.clear()`, so a child's inherited epoll fd resolves to nothing and
`epoll_ctl`/`epoll_pwait` return `EBADF`. On Linux an epoll fd names an open
file description: the child's duplicated descriptor refers to the **same**
instance, and `epoll_ctl` through either descriptor is visible to both.

Implementing that sharing means the instance cannot live in `Process`. It has to
move to an OFD-keyed machine-wide table — which *is* D3. Doing D2 without D3
would mean copying the instance into the child, and a copy gets the common case
right (child forks, then uses its own epoll) while being **silently wrong** on
shared mutation.

**That is why the copy shortcut is not taken.** The platform-values contract
says a POSIX gap stays visible as a gap rather than becoming silent success.
`EBADF` on a valid inherited descriptor is wrong, but it is *loud*; a copy would
be wrong and *quiet*. Trading the first for the second to make a fork/epoll test
pass would be the worse outcome by this project's own standard.

Estimated shape when taken: relocate `EpollInstance` ownership to an OFD-keyed
table alongside the socket table's model, then key `EpollInterest` on OFD
identity and prune on close/exec. `docs/posix-status.md` now records both gaps
against the three epoll entries, which previously read "Full".

### The agent scratchpad is not isolated between concurrent agents

An agent wrote a helper script to its scratchpad path, and by the time it ran
it, **another agent had overwritten that path with its own script**. The
executed script `cd`'d into the sibling's worktree and ran that worktree's
`install_local_binary kernel`, refreshing a sibling's
`local-binaries/kernel.wasm`.

No data was lost, and the agent caught and reported it. But the environment
presents the scratchpad as session-isolated, and with several agents running it
is not isolated between them.

**Confirmed as systematic, not a one-off.** The same agent later found a
sibling's `./run.sh setup` writing its log into that agent's scratchpad
directory. It verified via `lsof` that the sibling's working directory was its
own worktree, so no tree was mutated that time — but the collision is the same,
and it has now happened twice from two different directions.

**The defensive pattern that worked:** a uniquely-named file *plus* an in-script
guard that asserts the expected worktree before acting. A unique name alone is
not enough, because the failure is a replacement between write and execute.

This belongs in agent briefs beside the `KANDELO_SOURCE_CACHE_ROOT` note,
because the failure mode is identical in shape: **a mitigation that looks
applied and is not.** The cache flag was stripped by
`nix develop --ignore-environment` while every brief mandated setting it; the
scratchpad is described as session-isolated while being shared. Both produce
cross-worktree side effects, and both produce failures that name neither
worktree.
