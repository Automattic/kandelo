# host-native test fixtures

**These are built, not committed.** Every `.wasm` here is produced from a
tracked source by `build-fixtures.sh`, and `cargo test -p host-native` runs
that script itself when an artifact is missing or older than what it is built
from (`../src/fixtures.rs`). Nothing under this directory is in git except
sources, this file, and the script.

That is the repository's rule, stated in `.gitignore` beside the blanket
`*.wasm`: "Wasm binaries are build artifacts... Nothing tracked under git",
and "test fixtures under `host/test/fixtures/` are produced by the vitest
global-setup from `.wat` sources". This directory is now the Rust side of the
same arrangement.

Until 2026-09-14 the 43 artifacts here were force-added past that rule. Two
reasons were given and only one held. The weaker was convenience: they were
checked in "so the test needs only a built `kernel.wasm`, not a full
guest-program build". The stronger was a real cycle -- the generators that
rebuild the hand-written WAT fixtures live in the crate that `include_bytes!`
would not compile without them. **Loading at runtime dissolves that cycle**,
because the crate compiles whether or not an artifact exists.

What the exception cost was silent staleness. Nothing rebuilt these when libc
changed, and for months nothing checked them at load either (L-D4); 23 of them
were measurably stale, carrying dead glue from deletions since they were
linked. Building them from source is what makes that impossible rather than
merely unlikely.

To rebuild them by hand -- the tests do this for you:

```sh
scripts/dev-shell.sh bash crates/host-native/fixtures/build-fixtures.sh
```

One script covers all three arms: the C fixtures through the SDK, the
hand-written WAT through `wasm-tools parse`, and the fork-instrumented
variants through the real production instrumenter. The per-fixture recipes
below record what each arm does and why; they are no longer steps anyone has
to run in order.

## `native_hello.wasm`

The trivial guest the native Wasmtime host runs end-to-end in
`smoke_runs_trivial_guest_through_channel` (see `../src/guest.rs`). Source:
`native_hello.c`.

It is built through the same SDK wrapper `scripts/build-programs.sh` drives
for the example C programs: the driver supplies the target, the sysroot, the
channel syscall glue, `compiler_rt.c`, `crt1.o`, `libc.a` and every `-Wl,`
flag, so the fixture and a user program agree on the process memory layout by
construction. A non-forking standalone program is returned byte-for-byte
unchanged by `wasm-fork-instrument`, so the raw linker output is used directly
(no fork instrumentation step).

One deliberate difference from `build-programs.sh`: `build-fixtures.sh`
declares `--kandelo-thread-slots -1` (the host default) for every fixture
rather than letting the SDK infer a slot count from the source text. The
inference looks for `pthread_create` and friends in the named file and does
not follow `#include`, and several fixtures here are a one-line `#include` of
a shared source under `examples/`, so it would see no thread API and declare
zero slots. The pre-SDK recipe passed no thread-slot define at all, which is
the same host default; declaring it keeps that and makes it a choice rather
than a guess.

Rebuild it from within the dev shell (`scripts/dev-shell.sh`) whenever
`native_hello.c`, the libc glue, or the ABI changes — running the whole
script is the normal way, and this is what it does for one fixture:

```sh
# From the repo root, inside scripts/dev-shell.sh. The SDK resolves the
# sysroot and glue dir by walking up from the cwd, so run it from there.
OUT=crates/host-native/fixtures

sdk/bin/wasm32posix-cc -O2 --kandelo-thread-slots -1 \
  "$OUT/native_hello.c" -o "$OUT/native_hello.wasm"
```

This file used to spell out a `"$LLVM_BIN/clang"` command here with the whole
`-Wl,` list written out. That was a hand-maintained copy of a contract
`sdk/src/lib/flags.ts` owns, and it had already drifted — it named neither
`--export=__heap_base` nor a `-z stack-size`, so following it produced a
fixture on the 16 MiB brk fallback and wasm-ld's ~64 KiB default shadow
stack. Do not write the flags out again.

The program's `__abi_version` export must match the kernel's ABI, and as of
2026-09-14 this host enforces that -- `guest_module_for_this_epoch` in
`../src/guest.rs`, applied at all three places a guest program is compiled
(boot, spawn, exec). A program declaring a different epoch is refused; one
declaring none is allowed through, because predating the marker is a
different fact from being stale. That is the peer host's rule, so the two
cannot answer one question two ways.

**It did not, for months, and this file asserted that it did.** The sentence
here said the host "asserts this at load", so a stale fixture "fails loudly
rather than running wrong". `EXPECTED_ABI_VERSION` was compared against the
KERNEL's marker only; nothing read a GUEST's. That was shown by running, not
by reading: renaming the export out of a fixture left every test passing,
while flipping one byte of its code made the same test fail -- so the bytes
were reaching the host and the marker was simply never looked up.

**Import linkage does not cover the gap either, and the first version of this
correction said it did.** A guest names between 1 and 16 `kernel.*` functions
(14 for `native_hello`) plus `env.__channel_base` and `env.memory`.
`spawn_guest_thread` ends its wiring with
`linker.define_unknown_imports_as_traps(&module)`, and wasmtime's
`_get_by_import` matches on NAME alone, so:

* a name the host does not define gets a trap stub carrying the GUEST's own
  declared signature -- instantiation succeeds, and the failure arrives only
  if that path runs;
* a name that IS defined but with a different signature gets no stub, and
  `instantiate` refuses it.

Only the second half is loud, and the first half is the one that matters
here: of the 16 distinct kernel imports across these fixtures, **six are
trap-stubbed today** -- `kernel_push_argv` and the fork-exec family, names
`guest.rs` does not contain anywhere.

So nothing structurally separates a guest built for an older epoch from a
current one. Drift in the syscall channel's LAYOUT -- where most of the ABI
lives, and the one kind of staleness these fixtures actually exhibit -- is
invisible to every check the native host performs.

**What is still open.** The epoch check above catches a bump that left a
program behind. It does not catch a renamed or dropped import, and nothing on
either host catches channel-LAYOUT drift -- which is the only kind these
fixtures actually exhibit. The remainder stays filed as **L-D4** in
`docs/plans/2026-09-13-lane-l-line-attribution.md`.

## `native_fork.instrumented.wasm`

`smoke_fork_parent_child`'s fixture (N1-I4 Task 3): the SAME source as
`native_fork.wasm` (`native_fork.c`), but run through the REAL production
fork-instrumentation tool (`scripts/run-wasm-fork-instrument.sh` — the exact
tool every fork-using package build runs its own artifacts through), so its
`fork()` call site can actually unwind/rewind through the co-resident
fork-module's `fm_*` coordinator (`guest.rs`'s `run_fork_capable_entry`).
`native_fork.wasm` itself (this fixture's un-instrumented sibling) stays
committed too — nothing still needs it directly, but it is still produced by
`build-fixtures.sh`'s uniform "every `.c` in this directory" loop, and
removing it would be an unrelated, unforced change.

Regenerate both from within the dev shell:

```sh
# 1. Rebuild every fixture (including native_fork.wasm) through the SDK:
scripts/dev-shell.sh bash crates/host-native/fixtures/build-fixtures.sh

# 2. Instrument native_fork.wasm specifically:
scripts/dev-shell.sh bash -lc '
  cd crates/host-native/fixtures
  <repo>/scripts/run-wasm-fork-instrument.sh \
    native_fork.wasm -o native_fork.instrumented.wasm --entry kernel.kernel_fork
'
```

Like `native_hello.wasm`, the program's `__abi_version` must match the
kernel's ABI -- unenforced here, see above -- and re-running step 2 after any `crates/fork-instrument` change
picks up the current instrumentation tool automatically (see
`scripts/run-wasm-fork-instrument.sh`'s own input-hash rebuild check).

## `native_vfork.instrumented.wasm` / `native_vfork_exec.instrumented.wasm`

`smoke_vfork_exit_shares_memory_and_blocks_parent`'s and `smoke_vfork_
execve_releases_parent`'s fixtures (real vfork, N1 residual): the vfork
analogues of `native_fork.instrumented.wasm`. `native_vfork.c`'s child
writes a genuinely SHARED global (`shared_marker`) then `_exit`s; the parent
checks that write is visible after `vfork()` returns — the proof that this
host's `vfork()` borrows the parent's own memory rather than cloning it, as
plain `fork()` does. `native_vfork_exec.c`'s child instead `execve`s the
existing `native_exec_target.wasm` fixture, proving the parent stays
suspended all the way to a successful exec commit, not just to a `_exit`.

Regenerate both from within the dev shell, same recipe as `native_fork.
instrumented.wasm`:

```sh
scripts/dev-shell.sh bash crates/host-native/fixtures/build-fixtures.sh

scripts/dev-shell.sh bash -lc '
  cd crates/host-native/fixtures
  <repo>/scripts/run-wasm-fork-instrument.sh \
    native_vfork.wasm -o native_vfork.instrumented.wasm --entry kernel.kernel_fork
  <repo>/scripts/run-wasm-fork-instrument.sh \
    native_vfork_exec.wasm -o native_vfork_exec.instrumented.wasm --entry kernel.kernel_fork
'
```

Like every other fixture, `__abi_version` must match the kernel's ABI
(unenforced by this host -- see `native_hello.wasm` above).

## `native_fork_from_thread.instrumented.wasm` / `native_fork_from_thread.wasm`

`smoke_fork_from_thread`'s (currently `#[ignore]`d) and `smoke_fork_from_
thread_non_instrumented`'s (passing) fixtures (N1 residual #4a,
non-main-thread `fork()`): the SAME real-fork proof as `native_fork.c`,
except `fork()` is called from a PTHREAD `main` creates and joins, never the
main thread itself. `main` calls `pthread_create`, the pthread's own
`forker` function calls `fork()`, and `main`'s `pthread_join` must return
the forking pthread's own reaped exit status — proving the pthread's OS
thread was not silently killed and no joiner hangs. The non-instrumented
`.wasm` sibling is fully working (see that test's doc comment); the
`.instrumented.wasm` variant currently hits a deeper `crates/fork-
instrument`/`crates/fork-codec` resume-slot gap for a `wpk_fork_resume_
thread`-reached (non-`_start`) captured chain — see `smoke_fork_from_
thread`'s own doc comment for the full root-cause trace.

Regenerate both from within the dev shell, same recipe as `native_fork.
instrumented.wasm`:

```sh
scripts/dev-shell.sh bash crates/host-native/fixtures/build-fixtures.sh

scripts/dev-shell.sh bash -lc '
  cd crates/host-native/fixtures
  <repo>/scripts/run-wasm-fork-instrument.sh \
    native_fork_from_thread.wasm -o native_fork_from_thread.instrumented.wasm \
    --entry kernel.kernel_fork
'
```

Like every other fixture, `__abi_version` must match the kernel's ABI
(unenforced by this host -- see `native_hello.wasm` above).

## `native_fork_refs.instrumented.wasm`

`smoke_fork_reconstructs_references`'s fixture (N1-I5 Task 3, currently
`#[ignore]`d — see that test's doc comment for why). Unlike every other
fixture here, the source is hand-written WAT
(`native_fork_refs.wat`), not C: a genuine WASM `funcref`/`externref`
*value* held live across `fork()` is not reachable from portable C on this
SDK's clang/LLVM 21 toolchain (`__funcref`-qualified pointer types parse but
reproducibly ICE the compiler on every realistic use tried), matching the
Node/browser hosts' own reason for hand-writing `host/test/fixtures/
funcref-local-fork-fresh-worker.wat` / `externref-local-fork-fresh-worker.wat`.
`native_fork_refs.wat`'s own doc comment has the full design (what each
reference kind proves, exit-code table) and current status (assembles and
instruments cleanly; the RUN currently traps during CAPTURE on native's
documented, pre-existing "no module-state capture mechanism yet" gap — see
`guest.rs`'s `write_empty_module_state_arena` doc comment).

Regenerate from within the dev shell:

```sh
# 1. Assemble the hand-written WAT. NOT WABT's wat2wasm, which this file
#    used to name here: wabt 1.0.37 cannot assemble the four GC fixtures even
#    with --enable-all, and `wasm-tools parse` is what actually produced them.
scripts/dev-shell.sh bash -lc '
  cd crates/host-native/fixtures
  wasm-tools parse native_fork_refs.wat -o native_fork_refs.wasm
'

# 2. Instrument it, exactly like native_fork.wasm:
scripts/dev-shell.sh bash -lc '
  cd crates/host-native/fixtures
  <repo>/scripts/run-wasm-fork-instrument.sh \
    native_fork_refs.wasm -o native_fork_refs.instrumented.wasm \
    --entry kernel.kernel_fork
'
```

Like every other fixture, `__abi_version` must match the kernel's ABI
(unenforced by this host -- see `native_hello.wasm` above).

## `native_process_layout.wasm` and `native_process_layout.wasm64.wasm`

One C source, `native_process_layout.c`, built at **both** data models. It
drives every syscall whose descriptor carries a `SyscallArgSize::ProcessLayout`
record — a record whose byte count is a property of the *calling process's*
pointer width rather than of the call — through the real channel against the
real kernel, and checks a plausible record for each rather than merely a
non-error return. `../src/lib.rs` derives the set that must appear here from
`SYSCALL_ARG_DESCRIPTORS` itself, so adding such a descriptor without adding
coverage fails the test rather than passing unnoticed.

**Why a second artifact exists.** The wasm32 arm catches the regression that
actually happened (a caller width read as `0`, which made every one of these
syscalls return `EINVAL` while the whole suite stayed green). It cannot catch a
regression that only manifests at width **8** — and that is the likelier future
one, precisely because wasm64 has no guests in daily use to notice it. The
wasm64 arm is what made the native host's *missing* pointer-width registration
visible: without it, the kernel parsed a wasm64 guest's LP64 records at ILP32
offsets and the fixture stopped at exit code 4 on `statfs`.

The expected output block is **identical at both widths**, and that is the
point. Every value in it is either one of the kernel's own compiled-in
constants or a value the guest supplied earlier in the same run, so none of
them depends on how wide a pointer is. What does depend on it is how many bytes
each record occupies — and a disagreement about that surfaces as a changed
value, never as a changed expectation.

Both arms are produced by `build-fixtures.sh`, which builds every `*.c` here at
wasm32 and the names in its `WASM64_FIXTURES` list at wasm64 as well, from one
compile/link helper so the two arms cannot drift apart in flags. The wasm64 arm
needs `<repo>/sysroot64`:

```sh
scripts/dev-shell.sh bash scripts/build-musl.sh --arch wasm64posix
scripts/dev-shell.sh crates/host-native/fixtures/build-fixtures.sh
```

Without that sysroot the script **fails loudly** instead of skipping the wasm64
arm, because a silently un-rebuilt wasm64 fixture against a current kernel is
exactly the stale-artifact failure this family exists to catch.

Like every other fixture, `__abi_version` must match the kernel's ABI
(unenforced by this host -- see `native_hello.wasm` above) at both
widths.
