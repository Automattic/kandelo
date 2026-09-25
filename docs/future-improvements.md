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

### `run.sh`'s program-freshness check is a file-existence hand-list, not a derived cache key

`has_programs()` at `run.sh:410` decides whether user-program artifacts need
rebuilding by checking about a dozen specific paths for existence — `has_resolvable
programs/fork-exec.wasm`, `[ -f .../pipe-throughput.wasm ]`, and so on through the
benchmark and browser-memory64 fixture lists. `has_resolvable()` itself
(`run.sh:190`) only asks `scripts/resolve-binary.sh` whether a binary can be
found at all; it says nothing about whether that binary was built with today's
contract. Nothing in either check derives from the actual build closure —
not the contents of `scripts/build-programs.sh`, not the SDK's link flags, not
a cache key computed from either.

The consequence was confirmed during this branch's Phase 0/1 build-path work:
after the program link contract changed to add `--export=__heap_base` (see
the entry below on routing `build-programs.sh` through the SDK),
`./run.sh setup` reported "programs" already present and **skipped the
rebuild**, leaving binaries on disk that were still linked under the old
contract with no `__heap_base` export and no error. Anyone validating the
link-contract change by running `./run.sh setup` and trusting a clean exit
was validating stale artifacts, silently.

This is the same defect class as the `./run.sh rebuild kernel` entry above —
a freshness check built from presence rather than from the closure that
produced the artifact — recurring at a different layer (program binaries
instead of the kernel projection). The fix belongs in the same family: derive
`has_programs()`'s verdict from a cache key over `build-programs.sh`'s actual
inputs (source files, SDK flags, toolchain version), not from a hand-maintained
path list that has to be remembered and updated every time a new fixture is
added.

**Files:** `run.sh` (`has_programs`, `has_resolvable`), `scripts/build-programs.sh`.

### Every host vitest invocation regenerates the program package index, and can race a live `local-build`

`host/vitest.config.ts:59` wires `globalSetup: ["test/global-setup.ts"]` for
every vitest run under `host/`, and `host/test/global-setup.ts:306-311` shells
out unconditionally to `cargo run -p xtask ... build-deps program-index`,
which overwrites `packages/registry/program-packages.json`. There is no
narrower `include` path that skips it: a single focused test file pays the
same regeneration as a full run. Roughly four minutes was observed for one
file during this branch's work — enough to discourage the tight edit/test loop
the platform-values contract expects.

The sharper cost is that `program-packages.json` is a build-graph input, not a
test fixture, and vitest mutates it as a side effect of merely starting. That
makes it unsafe to run vitest while an `xtask local-build` is in flight against
the same checkout. The collision happened for real on this branch: a
concurrent edit/regeneration during a local-build closure produced

```
local-build scheduler invariant: prerequisite lsof (wasm32) is not a completed source-only cache hit
```

failing a node (`lsof`) that had itself reported `SUCCEEDED` earlier in the
same run, and cascading to eleven blocked downstream nodes, including every
browser product. The scheduler's invariant check did its job — it failed
loudly rather than serving a torn artifact — but the root cause is that a test
runner and a build engine were both allowed to write the same file
concurrently with no coordination between them.

This belongs in Build freshness rather than Testing because the defect is not
about test coverage: it is that starting a test suite silently rewrites a file
the build graph treats as authoritative input, with no lock, no staleness
check, and no isolation from a concurrent build. Fixing it likely means either
scoping the index regeneration to suites that actually need it, caching it the
same closure-derived way other build outputs are cached (see the entries
above), or giving `local-build` and `global-setup.ts` a shared lock over
`program-packages.json` so one always fails loudly instead of the other
silently consuming a half-written file.

**Files:** `host/vitest.config.ts`, `host/test/global-setup.ts`,
`packages/registry/program-packages.json`, `tools/xtask/src/local_build.rs`
(scheduler invariant check), `tools/xtask/src/build_deps.rs` (`program-index`).

### `scripts/build-programs.sh` builds programs serially while the Rust package builder does not

The script's compile loop is a plain `for f in programs/*.c` with no
`xargs -P`, no backgrounded jobs, and no `wait` — one program at a time, single
core. By contrast, `xtask local-build run` was observed running with
`--jobs 16` against the same machine. A full rebuild of the ~107 program
artifacts this script produces took about 65 minutes; no before-number was
benchmarked for comparison, so that is a mechanism observation (serial vs.
parallel, one core vs. sixteen), not a measured regression.

Per-program cost also rose independently of parallelism when the script was
routed through the SDK wrapper instead of invoking clang directly (commit
`8d9fe5c88`, "Build: Route test programs through the SDK, deleting a flag
copy"). The wrapper runs `clang -###` once to classify the compile/link job
and again to prepare the executable link, so each executable now costs
roughly three clang invocations (two of them `-###` dry runs) where the
script's old hand-maintained flag copy cost one. That commit's own message
notes the same thing: "no before-number exists to compare against." The
routing change was correct — the deleted flag copy had drifted and was
silently dropping `--export=__heap_base` (see the `has_programs()` entry
above for the resulting staleness) — but it makes the serial-loop cost higher
per artifact than it used to be, which sharpens the case for parallelizing.

**Files:** `scripts/build-programs.sh`.

### Port the identity-free dev-artifact path from `build-programs.sh` into an xtask verb

Planned follow-up, sequenced after the current Phase 0/1 build-path work on
this branch and before the storage-design changes that follow it.

`scripts/build-programs.sh` has two responsibilities welded together:
orchestration (which sources to build, where output goes, when to run
fork-instrument, how to maintain the ownership index) and, until commit
`8d9fe5c88` removed it, a second copy of the SDK's own compile/link recipe.
With that copy gone (−95 lines), what remains is orchestration written in
bash — the serial-loop and freshness gaps described in the two entries above.

The script's one genuinely distinct property is that it produces artifacts
with no package generation identity, which is what lets `local-binaries/`
override package-built binaries through the resolver's precedence. But that
property is a hazard the script has to actively defend against, not a feature
it is exploiting cleanly: its own comment at `scripts/build-programs.sh:38-41`
explains that a regular file at a package-owned resolver path has no immutable
package generation identity, that later package materialization must
correctly refuse to replace it, and that the script therefore has to derive
its complete ownership set from the generated package projection just to avoid
colliding with it.

`tools/xtask/src/local_build.rs` already solves the adjacent problem properly:
content-addressed generations keyed by a cache key derived from real inputs
(`:925`), with a hidden receipt sidecar recording what each generation
mirrored into the output tree (`:1441`). Porting `build-programs.sh`'s
orchestration into an xtask verb that writes identity-free dev artifacts
through that same machinery would remove the collision-avoidance hazard
rather than relocate it, and pick up closure-derived freshness (the
`has_programs()` entry above) and real parallelism (the entry above that) as
a consequence of reusing the engine, not as separate work. The boundary
between the two is already blurred in practice: the script shells out to
`cargo run -p xtask build-deps program-index` to compute the ownership set it
must not touch, so it already depends on xtask to stay safe.

**Files:** `scripts/build-programs.sh`, `tools/xtask/src/local_build.rs`,
`tools/xtask/src/build_deps.rs`.

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
- **A worker thread's own `unreachable` is swallowed.** The process's main
  thread no longer has this gap. When the kernel records a process's exit,
  the pump publishes `CH_TEARDOWN` on the exited main thread's channel and
  joins it, the native form of a JavaScript host's `kernel_exit` returning
  once the exit is committed (`kernelExitStatus` in
  `host/src/worker-main.ts`). `run_fork_capable_entry` therefore reads an
  `unreachable` trap as an exit only when its channel holds `CH_TEARDOWN`,
  and otherwise reports SIGILL through the kernel
  (`smoke_guest_unreachable_is_a_fault`,
  `smoke_fork_child_unreachable_is_reaped_as_a_fault`). A pthread's entry
  loop, `run_worker_thread`, still treats every `unreachable` trap as a clean
  thread exit, because musl's detached-thread teardown ends in exactly that
  trap after posting `SYS_exit`. Separating the two there needs the same
  signal for worker-thread exits.

Every other trap kind — memory, table/array bounds, stack overflow, integer
division and conversion faults, null and mistyped indirect calls — is
classified and reported.

### The `__heap_base` truthful-failure guard holds on the TypeScript host only

`host/src/process-memory.ts`'s `computeProcessMemoryLayout` now refuses a
caller that supplies a program and an explicit `heapBase: null` — the shape
`process-lifecycle.ts`'s `extractHeapBase` produces for a binary with no
`__heap_base` export — instead of silently substituting the 16 MiB
`PROCESS_MEMORY_FALLBACK_BRK_BASE`. This closes the fallback for the
Node/browser host.

`crates/host-native` was not changed and still takes the fallback path:
`crates/host-native/src/guest.rs:202` passes `heap_base:
read_heap_base(...)` straight through with no null check, and
`crates/shared/src/lib.rs:2375-2378` substitutes `FALLBACK_BRK_BASE` for a
`None` heap base exactly as before. `crates/host-native/src/guest.rs:2704`
is a green test that asserts this substitution happens — the fallback is not
just untouched, it is pinned by a passing test.

This is a platform-observable difference between hosts: a program with no
`__heap_base` fails loudly on Node/browser and succeeds silently (with the
same heap/shadow-stack overlap risk `crates/runtime-core/src/memory.rs:
384-392` describes) on native. `CLAUDE.md`'s host-parity contract requires
that an observable difference between hosts be justified by a real platform
boundary or removed; this one is neither — it has not been examined at all,
it is simply what was already there when the TypeScript side changed.

Closing this is a deliberate act, not a cleanup: it means deciding whether
native should also refuse (and updating or retiring the passing test at
`crates/host-native/src/guest.rs:2704` that currently depends on the
fallback), or documenting why native's silent fallback is an intentional,
scoped exception to host parity. Either answer is a maintainer decision, not
something to default into.

**Files:** `crates/host-native/src/guest.rs` (`spawn_guest_thread`'s
`heap_base` plumbing and the `guest.rs:2704` fallback test),
`crates/shared/src/lib.rs:2375-2378` (`FALLBACK_BRK_BASE` substitution),
`host/src/process-memory.ts` (the TypeScript-side guard this diverges from).

**Related:** `CLAUDE.md` § *Host Runtime Contract* (Node.js and browser hosts
are peers; this note extends the same question to the native host).

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
locals). Kandelo's SDK applies an 8 MiB default to executable links that make
no explicit stack-size request, and honours an explicit request verbatim
(with a warning below the default). That default covers the mainstream
workloads that exposed the 64 KiB `wasm-ld` default, but it is a capacity
policy rather than an overflow guard.

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
stack overflow ~thousands of frames earlier. The PHP recipe originally worked
around this with an explicit `LDFLAGS=-Wl,-z,stack-size=4194304` (4 MiB)
request; since that value sat below the SDK's 8 MiB default and the SDK at
the time silently raised any sub-floor request to the default, the recipe was
already linking with 8 MiB in practice, so the explicit flag recorded an
intention nobody had actually verified. It has since been removed (the SDK
now honours an explicit sub-floor request instead of silently discarding it,
so leaving a stale 4 MiB flag in place would have started actually shrinking
the reservation) and PHP now links with the SDK's 8 MiB default like any
other package that makes no request. The 8 MiB reserve covers PHP's observed
workload but doesn't *prevent* the failure mode: a deeper recursion or a
larger `alloca` can still silently corrupt data, and every linked program has
the same undetected-overflow risk.

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

Once a real guard is in place, the remaining per-program
`-Wl,-z,stack-size=...` overrides should be audited: a package task already
removed eight call sites across seven packages (sqlite-cli, vim, sqlite's
testfixture build, bash, git, ruby's two call sites, and php) whose explicit
request was below the SDK's 8 MiB default and so was already linking at the
default in practice — recording an intention nobody had actually formed.
mariadb's two toolchain files had the same explicit 1 MiB request, but
mariadb links through raw clang rather than through `wasm32posix-cc`, so it
gets no SDK-applied default to fall back to; its flag was restored rather
than removed, since deleting it would have silently dropped mariadb to
`wasm-ld`'s own ~64 KiB default instead of any 8 MiB floor. Programs that
genuinely need a shadow stack *larger* than the SDK default (SpiderMonkey's
16 MiB is the current example) should keep their explicit override and
document why; everything else that goes through the SDK driver should rely
on the SDK default plus the guard, with no package-local flag at all.

**Files:** `sdk/src/lib/flags.ts` and `sdk/kandelo/bin/wasm32posix-cc` (current
8 MiB default), `packages/registry/php/build-php.sh` (no stack-size override;
relies on the SDK default), `libc/glue/channel_syscall.c` (likely site for a
syscall-entry bounds check), `host/src/worker-main.ts` (instantiation-time
wiring for stack bounds), plus any other `build-*.sh` that hits the same wall
in the meantime.

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

### Committed WebAssembly modules wearing a TypeScript costume

This repository's rule is that wasm artifacts are never committed — they are
built at test time, and `git ls-files '*.wasm'` returns zero. But four
complete WebAssembly modules are checked in anyway, as hex strings inside
`.ts` files, which the rule as stated does not catch:

- `host/test/fixtures/gc-reference-cycle-fresh-worker-bytes.ts`
- `host/test/fixtures/gc-reference-state-fresh-worker-bytes.ts`
- `host/test/fixtures/static-root-bare-local-fork-fresh-worker-bytes.ts`
- `host/test/fixtures/static-root-local-fork-fresh-worker-bytes.ts`

Each test reads only the exported hex constant, e.g. `Buffer.from(RAW_
..._HEX, "hex")` in `host/test/gc-reference-state-fresh-worker.test.ts:36`.
Each has a sibling `.wat` source, but the `.wat` is documentation only —
nothing recompiles it and compares it against the checked-in hex, so nothing
enforces that the two agree.

Editing the `.wat` sources requires hand-regenerating all four hex blobs by
running the compiler once and pasting the output back in; a review then has
to decode the hex at section granularity to confirm the paste matches the
edited source. Hand-regeneration is not a mechanism — this was exactly the
hazard that made verifying a `.wat` edit slow and manual (see
`.superpowers/sdd/2026-09-18-fork-storage-phase0-and-build-path/
task-10-report.md`), and nothing prevents a future edit to one of the four
`.wat` files from silently leaving its `-bytes.ts` twin stale.

This is pre-existing; it was not introduced by that work, only exposed by it.

Two candidate fixes:

- Add a test that recompiles each `.wat` with the Rust `wat` crate (already a
  build dependency for `crates/fork-instrument`'s fixture generators) and
  asserts byte equality against the checked-in hex, so drift fails loudly
  instead of shipping silently.
- Move assembly of these four into `host/test/global-setup.ts` behind the
  `wat` crate, alongside the existing `.wat` fixtures already built at test
  time (see `WAT_FIXTURES` near `global-setup.ts:162`), so the hex is never
  checked in at all and the `.wasm` these four represent joins the rest under
  the "never committed" rule as written.

**Files:** `host/test/fixtures/{gc-reference-cycle,gc-reference-state,
static-root-bare-local-fork,static-root-local-fork}-fresh-worker-bytes.ts`
and their sibling `.wat` files; `host/test/global-setup.ts`.

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
  `fm_capture_*`, `fm_ref_*`, `fm_funcref_ordinal`,
  `fm_static_root_slot`, `fm_decoded_*`, `fm_decode_reference_graph`, and the
  reconstruction drive/plan/install group — are a wide per-type guest<->module
  surface. A follow-up PR should consolidate them behind a narrower opaque
  encode/decode dispatch, driving the fork-module export count well below the 71
  this PR reaches. **Files:** `crates/fork-module/src/lib.rs`,
  `crates/fork-codec`, `host/src`.

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

### `npm run typecheck` did not type-check

`host/package.json`'s `typecheck` script was `tsup --dts-only`, which emits
declaration files rather than checking every source file. It passed with an
`import` statement placed **inside a leading block comment** — so the imported
symbol was never in scope, and every use of it should have been an error.

Repointed at `tsc -p tsconfig.typecheck.json`; the old behaviour remains as
`typecheck:dts`.

**Why a separate tsconfig:** `tsc --noEmit -p tsconfig.json` reports 35
`TS6059` "not under rootDir" errors, all structural. They come from
`host/src/networking/tls-network-backend.ts` importing TypeScript source
directly out of `packages/registry/openssl/src/`. `rootDir` and `declaration`
constrain where output may be written and are irrelevant to type checking, so
the check-only config drops them.

**Baseline after the change: 19 errors, and they are real** — the previous
gate reported none of them.

- **7 × TS2307** on Vite virtual modules (`@kernel-wasm?url`,
  `@fork-module32-wasm?url`, `./worker-entry-browser.ts?worker&url`, …) and
  **2 × TS2339** on `ImportMeta.env`. These need Vite's ambient client types in
  the program; they are a **typing gap, not defects**.
- **~8 in `packages/registry/openssl`**, mostly `SharedArrayBuffer` not being
  assignable to `BufferSource`. Out of campaign scope, but in host's program
  because host imports that source directly.
- **2 that look like genuine defects** and deserve their own look:
  `fork-replay-gate.ts:208` reads `.status` off a union
  (`Partial<WorkerExitMessage> | Partial<WorkerErrorMessage>`) where only one
  arm has it, and `tls-network-backend.ts:213` passes a
  `Uint8Array<ArrayBufferLike>` where a `BufferSource` is required.

The Vite-typing gap should be closed first, so the remaining count is small
enough that a new error is visible — the property this gate lacked.

### The TLS code's type errors describe a browser-only runtime hazard

With Vite's ambient types in the program, the host typecheck baseline is **9
errors**, and **8 are Web Crypto calls in `packages/registry/openssl/src/tls/`**
(`crypto.subtle.importKey`, `crypto.subtle.sign`, and the certificate path)
receiving `Uint8Array<ArrayBufferLike>` where `BufferSource` is required. The
ninth is `host/src/networking/tls-network-backend.ts:213`, the same shape.

`ArrayBufferLike` is `ArrayBuffer | SharedArrayBuffer`. **`BufferSource`
excludes `SharedArrayBuffer`, and SubtleCrypto throws a `TypeError` when handed
a view backed by one.**

In Kandelo a guest's memory **is** a `SharedArrayBuffer`. So the type error is
not pedantry: it says that if TLS key or secret material ever reaches these
calls as a view over guest memory, rather than copied into a non-shared buffer
first, the call fails at runtime — in the browser, in the TLS path.

**Not yet proven reachable**, and that is the next step rather than a fix. What
is established is that the types permit a value Web Crypto forbids, on a path
where the forbidden value is the ambient case rather than an exotic one. A
short probe — pass a SAB-backed view to `crypto.subtle.importKey` in each
engine — would settle it, in the way the K0/K0c probes settled their questions.

Out of the rust-first campaign's scope (`packages/**`), and
`tls-network-backend.ts` belongs to K11's outstanding second pass, so this is
recorded rather than fixed.

### `install-local-artifact` refreshes the copy the tests do not read

The binary resolver tries `local-binaries/source-only-v1/` **before** ambient
`local-binaries/` (`host/src/binary-resolver.ts:291`). `./run.sh rebuild kernel`
refreshes the first; `build-deps … install-local-artifact` refreshes the second.

So running only the install refreshes the copy guest tests do not read: they go
on executing the previous kernel while the command reports success. That cost
one agent two hours, and `verify-fresh` had named both build keys the whole
time.

The workaround is to run both, in that order, and it is now written into the
provisioning list. The real fix is for one command to leave every tier
consistent, or for the install to fail loudly when it leaves a higher-priority
tier stale — the current behaviour is a partial update that looks complete.

### No SysV IPC conformance coverage exists

Checked, not assumed, while migrating the SysV shared-memory mirror: nothing in
`tests/posix`, `tests/libc` or `tests/sortix` exercises System V IPC. The
kernel owns message queues, semaphores and shared memory, and its only
end-to-end coverage is the repo's own `examples/sysv-ipc` case plus host unit
tests.

**Deferred deliberately** (maintainer's call, 2026-09-10). Neither upstream
suite carries SysV cases, so this is writing new conformance tests rather than
adopting existing ones — a different size of job from wiring up a suite that
already exists.

Worth doing because the migration moved real decisions into the kernel: the
`semctl` GETALL/SETALL sizing defect found during K6 (the guest sized its array
with a preliminary `IPC_STAT`, which needs READ permission where SETALL needs
only WRITE, so a `0222` set failed `EACCES` on a call POSIX permits) is exactly
the class a conformance suite catches and unit tests do not.

### Closed: `report_writeback_loss` is kernel state, not a console log

Closed on 2026-09-11, the way this entry proposed. A console log was a weak
home for **unrecoverable data loss**: the event says a shared file mapping's
dirty pages could not be written back, and a developer who was not watching a
console at that moment had no way to learn it happened.

The kernel now records the loss as its own state in
`runtime_core::writeback_loss` — pid, mapping address, and reason as separate
fields — and publishes it at `/proc/kandelo/writeback_losses`. It costs no
import and no new export: the ordinary `read(2)` path already exists, and
adding a kernel export to retire a host import would have been a wash for the
minimize-host-surface goal while growing the ABI's export surface.

The record keeps the first 64 losses and counts every one, publishing `total`,
`recorded` and `dropped`, so a loss it could not store still raises the total
the reader sees. The mapping layer's old "report at most 50, then stop" cap
went in the same change: with a counting sink behind it, that cap would have
made the kernel's own total saturate.

`host_debug_log` was this entry's only caller, so the import went with it and
the host import count moved 73 -> 72, measured on the built kernel artifact.
The loss is also now testable, which a console log was not:
`procfs::tests::a_recorded_writeback_loss_is_readable_through_procfs` fails if
the diagnostic is dropped on the floor rather than recorded.

### Closed: pthread control slots are placed by the kernel on every host

Closed on 2026-09-10. Both entries that stood here — host-native reporting its
own 16-slot arena as a process's concurrent-thread ceiling instead of the
program's `__wasm_posix_thread_slots` declaration, and the slot placement
arithmetic existing once per host — had the same fix, and it is the one the
second entry proposed: `sys_clone` reserves the slot from
`MemoryManager::reserve_host_region` and records the address, and each host
reads it back through `kernel_thread_slot_addr`.

The division of labour is the one the open question could not settle from the
outside. Only a host can grow a `WebAssembly.Memory`, so the kernel decides
*where* a slot goes — it is the only party that can see every mapping,
reservation and heap boundary in the address space — and the host makes that
range addressable, zeroes it, and launches the thread. That is the same split
`CLONE_PARENT_SETTID` and the child-tid clear already used: the kernel names an
address, the host performs the store.

Releasing a slot stayed a host act, and deliberately so. The kernel does not
free the range at thread exit, because a worker terminated without publishing a
quiescence fence can still write into its slot; the host calls
`kernel_release_host_region` when it knows that has settled. That preserved the
JavaScript hosts' existing `terminationProvesQuiescence || quiescent` rule
without restating it in the kernel.

Two costs, both accepted before the work started and both realized:
host-native's `brk_base` moved down by the 16-slot arena that no longer exists
(its layout is now byte-identical to `computeProcessMemoryLayout`'s), and the
change had to be right across fork and exec. Neither needed new code: a fork
child inherits no host reservations, and both exec paths replace
`Process::memory` with a fresh `MemoryManager` before `clear_threads()`.

`examples/pthread-concurrent-slots.c` is the evidence, run on both hosts: 20
threads live at once, where the native arena stopped at 16.

### Two realms that cannot read artifacts, and both blame the artifact

Measured 2026-09-10. Running the host Vitest suites from a worktree checkout,
every guest process died with:

    [process-worker] Kernel worker failed: Could not find repo root
    (expected workspace Cargo.toml + package.json)

The chain: running from source, `NodeWorkerAdapter` bundles the worker entry
with esbuild into `mkdtempSync(join(tmpdir(), "kandelo-worker-entry-"))`
(`host/src/worker-adapter.ts`) rather than spawning a `tsx` loader per worker.
Inside that bundle every module is inlined, so `currentModuleDir()` is the
temporary directory. `useNodeWasmArtifactModule` then calls `findRepoRoot()`
with no starting point (`host/src/wasm-artifact-module-node.ts`), which walks
up from there looking for the workspace `Cargo.toml` plus a `package.json`
named `kandelo` -- and under the default `TMPDIR`
(`/private/tmp/nix-shell.*` inside `scripts/dev-shell.sh`) there is nothing to
find. The artifact reader is never installed, so the worker cannot judge a
single `.wasm`.

Pointing `TMPDIR` at a directory inside the checkout makes the same suites pass
unchanged, which is what this session did to run them. That is a workaround,
not a fix: nothing about a guest process should depend on where the operating
system puts temporary files.

`WASM_POSIX_BINARY_RESOLVER_REPO_ROOT` does not help -- it is read by
`resolverRepoRoot()`, not by the artifact-module loader's bare `findRepoRoot()`
call. The fix is for the worker to be *told* where its artifacts live rather
than deducing it from its own file path: the parent host already knows, and
already sends the worker its program bytes, memory and channel offsets.

How this passes in continuous integration is unclear, and that question is
worth answering before a fix is chosen -- a bundling path that silently differs
between CI and a developer's checkout is its own problem.

The same *class* of defect blocks the browser dev server, in a way that reads
as something else entirely. `apps/browser-demos`'s Vite realm never calls
`installWasmArtifactModule`, so `hasWasmArtifactPolicyFailures` cannot read an
artifact at all and fails closed. Every candidate is then reported as

    Binary exists but was rejected by artifact policy: kernel.wasm

which names the artifact and implicates the build, when the artifact is fine
and the *reader* is missing. Reproduced directly on 2026-09-10: calling
`tryResolveBinary("kernel.wasm")` after `installWasmArtifactModule` returns the
path; the identical call without it produces exactly that rejection, against a
kernel rebuilt through `./run.sh rebuild kernel` with `xtask verify-fresh`
green. A realm that cannot read artifacts should say *that*, not accuse the
artifact.

### The process worker runs `host/dist` with no freshness check, so e2e evidence can describe a bundle nobody edited

Measured 2026-09-21. `NodeWorkerAdapter.resolveCompiledEntry()`
(`host/src/worker-adapter.ts:199-225`) spawns every PROCESS worker from
`host/dist/worker-entry.js` **if that file merely exists**. It compares no
timestamps and no fingerprints. The KERNEL worker's spawn path
(`host/src/node-kernel-host.ts:1352`) calls `compiledWorkerEntryIsCurrent`,
which hashes every file under `host/src` plus the four declared build inputs
and falls back to the `tsx` loader when the bundle does not match. The process
worker has no equivalent, so in a source checkout whose `host/dist` predates
the working tree, the two workers run DIFFERENT versions of the host.

This is worse than producing a wrong artifact: it silently invalidates
evidence. A host-source change that the process worker is supposed to execute
can be absent from every end-to-end run while the suite reports green, and
nothing in the output says which copy ran.

It was found by proving a branch reachable rather than by noticing a wrong
answer. `fm_publish_resume_assignment` (since folded into
`fm_bind_activation`) was made to return `ENOMEM` unconditionally and the
fork module rebuilt (build key changed, so the mutation reached the
artifact); `host/test/fork-module-worker-instantiation.test.ts`
— a real kernel worker driving a real fork — **still passed**, while the unit
test loading the same `fork_module32.wasm` directly failed six of seven cases.
`host/dist/worker-entry.js` was 7 hours old and contained none of the host
source under test. After `npm run build` in `host/`, the same file surfaced
four genuine failures.

The fix is to give the process-worker spawn the gate the kernel-worker spawn
already has: call `compiledWorkerEntryIsCurrent` before using `dist/`, and fall
back to the loader otherwise. A stale bundle should cost startup time, not
truth. Until then, no end-to-end claim from a source checkout is meaningful
without a `host/` build first, and that requirement is stated nowhere.

**Files:** `host/src/worker-adapter.ts`, `host/src/compiled-worker-entry.ts`,
`docs/agent-guidance/validation.md`.

### `KANDELO_SOURCE_CACHE_ROOT` does not isolate the programs cache

Measured 2026-09-10 while a machine filled its disk: with the flag set, the
private cache held **1.2 MB** and the shared tree held **237 GB**. The flag
isolates the source-only projection cache and **not** the built-programs cache,
so concurrent agents still share the expensive half.

This is the **third** mitigation this session that looked applied and was not,
after `nix develop --ignore-environment` stripping this very variable, and the
per-session scratchpad being shared between agents. All three share a shape: an
instruction that is present, plausible, and inert.

Consequences observed:
- A machine reached **100% of 1.8 TiB** with 151 GB in 34 agent worktrees,
  which fails builds with `StorageFull` errors that name a package rather than
  the disk.
- One agent discarded a full test run whose 15 failures were all `StorageFull`.

Two things worth doing: make the flag cover the programs cache too, or rename
it so it stops promising isolation it does not deliver; and give agent
worktrees a cleanup path, since 34 full checkouts with build artifacts is the
steady state of a parallel campaign rather than an accident.

### The co-resident fork module has no diagnostic channel

The Rust fork module (`crates/fork-module`) is `no_std` position-independent
code compiled to wasm and instantiated inside each guest's linear memory. Its
only outward channels are syscalls, the `fm_stats(field)` counter surface, and
`fm_last_errno`. It has no way to say anything to a human.

That is fine for errors, which travel as errno values the host turns into real
failures. It is a gap for **signals that are not failures**: "this is working,
and it is working outside the envelope it was designed for". The case that
raised it, 2026-09-20: the dynamic storage conversion replaces a sorted
directory with a linear walk plus a one-entry memo, on the measured basis that
live activations max out at 7. Past roughly 64 the sorted design becomes worth
revisiting — but exceeding 64 is a *performance* signal, not a correctness
failure, so returning an errno would be the truthful-failure contract
inverted: a working system reported as broken.

With no channel, the options were a counter nobody reads or a prose note in a
plan telling whoever implements it to stop and report — which binds only at
authoring time, and only for the fixtures that person happened to run. The
resolution taken was to expose the count as an `fm_stats` field and put the
threshold assertion in a host test, which makes the trigger fire by itself but
only when a test runs, never inside a browser production run.

Worth building: a bounded, opt-in way for the module to emit a one-shot
diagnostic the host surfaces — the same role `dmesg` plays for a kernel. It
should be cheap enough to leave compiled in, latched so a hot path cannot
spam, and carry no host API surface beyond what already exists. The
constraint that makes this interesting is that the obvious implementation, a
host import, grows exactly the TypeScript surface the fork campaign exists to
shrink; a ring buffer in module memory that the host drains through an
existing entry point probably does not.

### Nested fixture budgets make the fork-coverage timeouts uninformative

`host/test/fork-instrument-coverage.test.ts` gives its heaviest cases two
budgets that must fit inside each other: an inner program timeout for the
guest, and an outer vitest `it()` timeout. K-03 (fork from a
`pthread_cleanup_push` handler) carries 7s inside 10s. Both have been
unchanged since `50937c19d3` (2026-05-20).

The gap between them — roughly three seconds — is everything that is not the
guest: worker spawn and wasm compile. When a loaded machine eats that margin,
the **outer** timeout fires first, so the failure reads as a bare
`Test timed out in 10000ms` instead of the named "missing expected stdout"
assertion the inner budget exists to produce.

So the test is least informative exactly when the thing that ran out is the
startup margin, which is also the most likely thing to run out.

**The margin is 1.5 seconds.** Measured 2026-09-21, same binary throughout,
one-minute load recorded before each run:

| 1-min load (18 cores) | K-03 test phase | vs the 10s budget |
|---|---|---|
| 2.43 | 8.57s | 14% margin, pass |
| 1.98 | 8.49s | 15% margin, pass |
| 2.00 | 8.49s | 15% margin, pass |
| ~20  | 10.42s | 4% over, fail |
| ~26  | 12.06s | 21% over, fail |

The quiet times cluster within 80ms, so the cost is deterministic at about
8.5s and what varies is the machine. Module import moves the same way: 17.0s
quiet against 28.6s loaded. **K-03 therefore does not need heavy contention to
fail — it needs roughly 18% of slowdown**, which a single concurrent build on
a shared workstation supplies easily.

The failure text says none of this. It reports a bare timeout, and an
investigation ran a long way on it before anyone measured the machine rather
than the worktree — filtering processes to one's own checkout is structurally
blind to the other sessions that are the contention.

Two candidate fixes, both cheap. Shrink the inner budget relative to the
outer, so the inner assertion always fires first and names what was missing.
Or grow the outer until the same is true. The second is likelier correct
given the measured cost of these fixtures — but the point is the ORDER, not
the size: whichever budget expires first should be the one that can say why.

Worth pairing with the open question behind `testTimeout: 30_000` in
`host/vitest.config.ts`, which that file's own comment calls a stopgap and
routes to "why does a fixture that forks and prints cost 8.5s". A suite whose
per-test margins are thinner than the variance of the machine it runs on will
keep producing investigations like this one.

### Fork instrumentation has three hand-maintained freshness lists

A guest that Kandelo forks must carry the exports `crates/fork-instrument`
injects. When that tool gains an export, every fork-using guest needs
rebuilding. Three separate mechanisms decide whether that happens, and on
2026-09-21 all three failed open at once for one package, shipping an msmtpd
that died before `_start` from a build that reported success.

**1. Per-package `inputs` lists the wrapper, not the tool.** Eight
`packages/registry/*/build.toml` files declare
`scripts/run-wasm-fork-instrument.sh` as an input. Seven of them do not
declare `crates/fork-instrument`. The wrapper is a few lines that invoke the
instrumenter; changing the instrumenter does not change the wrapper, so the
cache key holds still across exactly the change that invalidates the output.
msmtpd has since been corrected; `dinit`, `sdl2-mixer-playwave`,
`sdl-dsp-test`, `spidermonkey`, `sqlite`, `sqlite-cli` and `sudo` still carry
the narrow list. Those are latent rather than broken today — their build nodes
run and re-instrument for other reasons — but the key cannot detect the one
change that matters to them.

**2. `wasm_has_complete_fork_instrumentation` checks nine hand-listed
markers.** `scripts/wasm-artifact-guards.sh:1524-1548` certifies an artifact
as completely instrumented by looking for nine known exports. It does not know
about `__wpk_fork_place_resume_thunks`, so it certified a September binary as
complete and skipped re-instrumenting it. Any package shipping a pre-built
`bin/` inherits this on the next instrumenter change. A predicate that
enumerates what it expects will always lag the thing it describes; deriving
the expected set from the instrumenter would not.

**3. A package script may skip instrumentation entirely.** `build-msmtpd.sh`
carried an `exit 0` reuse guard above both its compile and its instrumentation
call — the only one in the registry, removed in the same change as this entry.

**Why it stayed invisible**, and this is the part worth generalising:
`packages/registry/*/bin/` is gitignored. A fresh clone has no stale input, so
the guard never fires and the package instruments normally. The failure
reproduces only in a worktree that has built the package before — which is
every long-lived development checkout and no CI job. A defect that CI cannot
see and that every developer machine carries is the worst combination
available.

The durable fix is the one this repository already has for the kernel: derive
cache keys from the real build closure rather than a hand-maintained list, the
pattern in `build_deps.rs`. The same shape has now been found four times --
the kernel `build.toml` omitting `crates/runtime-core`, the `has_programs()`
hand-list, `newest_input()` omitting the instrumenter, and this.

### The fourth freshness list was the ABI contract itself, and it is closed

The three lists above are build-side. A fourth lived in the ABI contract:
`crates/shared/src/lib.rs`'s `WPK_FORK_REQUIRED_EXPORTS`, a hand-written
table of the `wpk_fork_*` guest exports an instrumented artifact must carry.
It did not list `__wpk_fork_place_resume_thunks`, so the export the host
calls before a forked child can resume was not one the platform required.

`docs/agent-guidance/abi.md:13-28` names "`wasm-fork-instrument`'s
`wpk_fork_*` exports" as ABI surface, so the export was ABI surface by that
enumeration. It is now listed, under ABI 44 and with no version bump: 44 is
unreleased and this lane defines its contents, so the entry is additive
within the epoch. `abi/snapshot.json` records the list at
`/program_artifact/fork_instrumentation/required_exports` and was
regenerated in the same change.

Two mechanisms gained a check they did not have:

1. **Publication.** `tools/xtask/src/build_deps.rs` rejects an artifact with
   fork surface that is missing any listed export ("has incomplete ABI 43
   wasm-fork-instrument exports; missing ..."). A guest instrumented by a
   pre-2026-09-20 toolchain used to pass; it is now named and refused.
2. **Process admission.** `host/src/worker-main.ts` refuses a guest carrying
   some but not all of them, before `_start`. The same stale guest used to
   reach resume placement (then `ForkResumeTable.registerActivation`,
   now `placeForkResumeThunks`) and fail there instead --
   which does name the export, so the gain is not a better message but an
   earlier and cheaper one: refused at publication and at process start
   rather than at the first `fork()`.

A third mechanism was expected to change and did not. `dlsym` visibility
(`host/src/dylink-artifact.ts`, `crates/dylink/src/scope.rs`) derives
`is_fork_runtime_export` from the same list, and the concern was that
`dlsym` on a side module could hand the placement shim out as an application
symbol. It could not. Every path that publishes a symbol into a scope --
`publish_main_image`, `rebuild_global_symbols`,
`publish_global_library_symbols`, `scoped_symbol` and the collection in
`plan.rs` -- filters with `is_public_dylink_export`, which rejects any
`__`-prefixed name before the fork-export test is reached. The TypeScript
`isForkRuntimeExport` has no in-tree caller at all. Listing the export
tightens that predicate; it did not fix a reachable defect.

What remains open is item 2 above, and it is now the only way a stale guest
is still certified complete: `wasm_has_complete_fork_instrumentation`
(`scripts/wasm-artifact-guards.sh`) reads a fixed-arity inventory from
`crates/fork-instrument/src/contract_inventory.rs`, whose fields are
hand-enumerated and independent of `WPK_FORK_REQUIRED_EXPORTS`. A package
that ships a prebuilt `bin/` can still be told it needs no re-instrumenting
by a predicate that has never heard of the export the ABI now requires.

### `dash` ships a stale fork-instrumented guest, and six packages could

msmtpd was not the only one. On 2026-09-21, in a worktree that had built the
registry, `packages/registry/dash/bin/dash.wasm` (dated Sep 20 13:28) exports
`__wpk_fork_ref_gc_fill` and `__wpk_fork_resume_catalog` but not
`__wpk_fork_place_resume_thunks`, which landed at 23:25 the same day. dash is
a shell: it forks, so it reaches `registerActivation` and fails there.

Auditing every registry package with a fork-instrumented prebuilt binary:

| Package | Has the new export | Declares the wrapper as an input | Declares `crates/fork-instrument` |
|---|---|---|---|
| dash | **no** | no | no |
| git | yes | no | no |
| msmtpd | yes | yes | yes |
| redis | yes | no | no |
| tar | yes | no | no |
| vim | yes | no | no |
| wget | yes | no | no |

Only msmtpd's `inputs` were corrected. The other six declare neither the
wrapper nor the instrumenter, which is narrower still than the eight packages
named in item 1 above -- those at least declare the wrapper. Five of the six
happen to be current because their build nodes re-ran for other reasons; dash
did not, and nothing in its cache key could have noticed.

`packages/registry/*/bin/` is gitignored, so this reproduces only in a
checkout that has built before -- the same invisibility described above.

Re-measured on 2026-09-21 after the ABI table was corrected and the whole
artifact tier was rebuilt through `./run.sh setup`. Three things held and one
did not:

- The artifact anything actually resolves is now correct.
  `local-binaries/source-only-v1/programs/wasm32/dash.wasm` was rebuilt from
  source and carries the export. That tier is the highest-priority one for
  Node, Vitest and the browser alike, so the shell a test or a demo gets is
  the fresh one.
- `packages/registry/dash/bin/dash.wasm` is still the Sep 20 13:28 prebuilt,
  untouched by the rebuild, and so is the default-policy symlink
  `local-binaries/programs/wasm32/dash.wasm` that points into
  `.kandelo-local-generations/`. Both are now refused by name rather than
  accepted, which is the intended behaviour -- but a full setup did not
  replace either, so "rebuild it" is not yet a command a reader can run.
- A `dash` cache generation built at 16:04, DURING that same setup and after
  the ABI table already required the export, does not carry it. It is not
  referenced by the projection, so nothing resolves it, and its 615,845 bytes
  match neither the stale prebuilt (628,476) nor the fresh build (628,745) --
  a third shape, from some dependency context that was not identified. Worth
  identifying before trusting that publication validation runs on every node
  that stages a guest.

### `tsc` does not typecheck `host/test`

`host/tsconfig.typecheck.json` sets `"include": ["src"]`, so
`npx tsc -p tsconfig.typecheck.json` — the typecheck gate every task in this
repository runs before committing — never looks at `host/test`.

A dangling import in a test file therefore passes the gate and fails only when
that file runs. Found 2026-09-21 while deleting a dead module: the deletion
removed symbols a test imported, and `tsc` reported clean. What caught it was
running the affected test files and sweeping for the symbols by name. Both of
those are things a careful person does and neither is the gate.

The risk is proportional to how much people trust the gate. "Typecheck passes"
is quoted as evidence in task reports throughout this lane, and for test files
it means nothing. That is worse than having no gate, because a check that
covers less than its name suggests is read as covering everything.

Two shapes of fix. A second config over `test` run alongside the first keeps
the `src`-rooted path that the existing config's comment says it exists for.
Widening `include` to both is simpler but changes what the existing invocation
means, and the test tree may not be clean today — measure before assuming it
is a one-line change.

Worth pairing with the observation that this lane's own test files have grown
substantially: `host/test` now holds the characterization baselines, the
artifact gates and the seam tests that several plans depend on for evidence.
Code that produces evidence deserves the same checking as code that ships.
