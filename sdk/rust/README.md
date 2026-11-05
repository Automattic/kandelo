# Rust target for Kandelo (`wasm32-unknown-kandelo`)

This directory holds the Rust cross-compilation target for Kandelo.

- `wasm32-unknown-kandelo.json` — `no_std`/`alloc` target spec
  (`target-family = ["wasm"]`).
- `wasm32-unknown-kandelo-std.json` — full-`std` target spec
  (`target-family = ["unix", "wasm"]`, so `std` selects its unix
  platform layer while `stdarch`'s wasm SIMD still compiles).

Both set `os = "kandelo"`, `env = "musl"`, and bake in
`+atomics,+bulk-memory,+mutable-globals` (required because the SDK link
contract uses `--shared-memory`).

## Building a guest today (spike-stage manual flow)

From the repo root, inside `scripts/dev-shell.sh`:

```
# no_std / alloc
cargo build --release -Z json-target-spec \
  -Z build-std=core,alloc,compiler_builtins \
  --target sdk/rust/wasm32-unknown-kandelo.json

# final link through the SDK (pulls crt1 + libc.a + channel glue)
wasm32posix-cc empty.c target/wasm32-unknown-kandelo/release/lib<name>.a \
  -o <name>.wasm

# run on the kernel
npx tsx examples/run-wasm.ts <name>.wasm
```

`std` builds use the private sysroot with a prebuilt `std` (from
`scripts/build-rust-sysroot.sh`); see below.

## Quick start: `wasm32posix-cargo`

From a Rust package directory, inside `scripts/dev-shell.sh`:

```
wasm32posix-cargo run --release -- [prog args]   # build + (instrument) + run
wasm32posix-cargo build --release                # just build
```

The wrapper assembles the private sysroot (including the prebuilt
`std`) on first use, selects the target by name, sets the `RUSTC`
wrapper and the musl-time64 env var, and fork-instruments any output
that uses fork (e.g. `std::process`). The manual flow below is what it automates.

## Building a full-`std` program (bin crate)

`std` programs use a normal `fn main` and are linked directly by the SDK
(the target spec sets `linker = wasm32posix-cc`,
`linker-flavor = wasm-lld-cc`, and `entry-name = __main_argc_argv`, so
rustc drives the SDK driver and its `lang_start` entry connects to
Kandelo's crt1). `cargo build` produces a runnable `.wasm` directly — no
staticlib or separate link step. `scripts/build-rust-sysroot.sh`
installs the target spec into the private sysroot and compiles `std` for
it once, so the target is selected by name with no `-Z build-std`:

```
RUSTC=$HOME/.kandelo/rust/rustc-kandelo \
RUST_LIBC_UNSTABLE_MUSL_V1_2_3=1 \
cargo build --release --target wasm32-unknown-kandelo-std

npx tsx examples/run-wasm.ts \
  target/wasm32-unknown-kandelo-std/release/<name>.wasm [args...]
```

`std::env::args`, `std::env::var`, `std::fs`, `std::time`, and `HashMap`
all work. See `programs/rust/std-hello/`.

## Porting Rust dependencies

Compiling `std` does not make every crate recognize a new operating system.
Separate target-selection failures from missing runtime behavior before
changing a dependency. The full target reports `target_os = "kandelo"`,
`target_env = "musl"`, and both `unix` and `wasm` target families. Keep those
facts true: neither an application nor a build wrapper should pretend the
target is Linux, WASI, or a browser.

The sysroot applies `std-kandelo.patch` in addition to the overlaid files.
Kandelo selects the ordinary POSIX `F_DUPFD_CLOEXEC` implementation for
`BorrowedFd::try_clone_to_owned`, `OwnedFd::try_clone` and `File::try_clone`.
The upstream architecture-only wasm32 fallback otherwise returns Unsupported
even though Kandelo implements descriptor duplication. Non-Kandelo wasm32
targets retain that fallback. The patch participates in the sysroot input
digest and package cache identity. `std-boundaries` exercises descriptor
lifetimes, shared offsets and positioned I/O through the ordinary SDK.

### Diagnose the first failing crate

- Inspect the pinned `Cargo.lock`, enabled features, and the failing crate's
  `cfg` branches. A crate that treats all `wasm32` targets as browser-only can
  select both its Wasm stub and its Unix implementation. Prefer its real Unix
  implementation where Kandelo supplies the required APIs.
- Explicit OS lists may omit Kandelo even when a suitable implementation
  exists. For example, mio 0.7.6 needs Kandelo added to its epoll, eventfd,
  pipe2, atomic socket, and accept4 selections. Check associated public types
  as well as private functions; their conditional fields must agree.
- A function that compiles or links may still lack correct runtime semantics.
  Check `docs/posix-status.md` and relevant platform contracts, then run a
  guest probe. Missing readiness, signal, socket, or thread behavior belongs
  in the platform, not in a dependency workaround. A successful C epoll probe
  alone does not establish that mio's event loop works.
- On wasm32 musl with time64, `libc::timespec` has private padding. Initialize
  the complete value (for example with `unsafe { std::mem::zeroed() }`, which
  is valid for this integer-only C struct), then assign `tv_sec` and
  `tv_nsec`. Do not remove padding, change the SDK layout, or substitute a
  hand-written FFI declaration to make a struct literal compile.
- Check other FFI layouts against the SDK headers too. Upstream's wasm32
  musl definitions can describe WALI rather than Kandelo. A short
  `sigset_t`, for example, shifts `sigaction.sa_flags` and can make a real
  signal callback trap even though registration succeeded. Check sizes,
  alignment, and field offsets, then exercise the callback at runtime.
- Keep optional hardware features separate from ordinary functionality. A
  Linux V4L webcam feature does not need to be enabled for text/file chat.
  State the shipped feature set rather than silently claiming the omitted
  functionality works.

### Build reproducibly through the registry

Use `packages/registry/termchat/` for a standalone Rust executable example,
and librsvg/rsvg-convert for Rust plus native library dependencies. Recipes
must use a private source tree, Cargo home, target directory, patched-crate
directories, and Rust sysroot below the resolver work root. Do not patch the
user's Cargo registry or write build products into the reviewed recipe.

`scripts/package-rust-build-env.sh` supplies a reusable standalone-crate
environment. Source it **inside a subshell** and call:

```bash
kandelo_package_rust_build_env "$REPO_ROOT" "$SRC" "$WORK" "$PATCHES"
cargo build --locked --release --target wasm32-unknown-kandelo-std \
  --target-dir "$WORK/target"
```

The helper assembles Kandelo's private Rust sysroot, pins the dependency graph
to its libc fork, vendors registry crates against lockfile checksums, and
applies reviewed patches named `<crate>-<exact-version>.patch` to private
copies. It then builds offline. These are build-local `[patch.crates-io]`
overrides, not unverified replacement dependencies. Patches should explain
the upstream portability issue and retain the crate's runtime contract.
Carry narrow changes suitable for upstream review; do not replace an event
backend merely to avoid implementing an API Kandelo already exposes.

The helper keeps patched path dependencies inside the staged application's
workspace and the libc fork inside the private Rust sysroot. Cargo otherwise
hashes absolute paths into crate identities even when compiler source paths
are remapped. It also remaps emitted paths for both `std` and the application,
and the sysroot builder includes compiler flags in its freshness stamp.
Verify a new recipe with independent builds in two cache directories and
compare executable bytes. A same-key cache-winner mismatch is a reproducibility
failure to investigate, not permission to overwrite the existing generation.

List the helper, patches, Rust target JSON, libc submodule and patch, std
overlay, and sysroot builder in `build.toml.inputs`. Cargo's lockfile owns
Rust crate dependencies; `package.toml.depends_on` owns native registry
dependencies. Auxiliary non-Cargo downloads still need declared inputs.
Do not describe Cargo vendoring as proof that the entire build is hermetic.

Keep guest Cargo configuration in its subshell: the install helper invokes
the repository's host Cargo and must not inherit a guest vendor tree or
`RUSTC` wrapper. A `[patch]` path dependency loses Cargo's registry lint cap;
the helper caps guest lint severity at warnings so newer compiler lints do
not turn an old dependency's `deny(dead_code)` into a consumer build error.
Type, link, and runtime errors remain errors.

### Validate the consumer

After building, inspect imports and run the real application through ordinary
guest sockets, PTYs, files, and process lifecycle on Node and browser hosts.
For a TUI, verify keyboard input, resizing, and terminal restoration; for
networking, verify peer discovery, actual payload delivery, and disconnects.
Treat a `--help` run as startup evidence, not application validation. Build
and test against current ABI artifacts; do not reuse stale kernel or sysroot
outputs after changing the platform.

Exercise delayed work too. Rust's timed parking uses absolute
`FUTEX_WAIT_BITSET` deadlines, while musl commonly uses relative `FUTEX_WAIT`
timeouts. A working mutex or first message does not prove either timed
parking or subsequent timer-driven file chunks work.
