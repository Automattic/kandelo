# Upstream-shaped diffs (tier-3 prep)

These are the changes the `wasm32-unknown-kandelo` target makes to
upstream Rust, isolated for review and as the basis for upstreaming the
target (rust-lang/libc + rust-lang/rust) as tier-3.

- **libc:** `../libc-kandelo.patch` (the build-time overlay itself,
  applied to the `sdk/rust/libc-upstream` submodule). It contains the
  `kandelo` dispatch arms plus the wasm32 arch leaf reconciled to
  Kandelo's `wasm32posix` ABI (the bulk is the 279-entry syscall-number
  table), plus ILP32 signal, pthread, and semaphore layouts matching the
  installed musl headers. This is both the build input and the upstream
  submission.
- `std-overlay.patch` — diff of `sdk/rust/std-overlay/` against the
  pinned toolchain's `library/`: `kandelo` selectors in std's Unix backend,
  descriptor duplication through `fcntl`, file locking through `flock`,
  and the documented unsupported
  stack-backtrace backend. These reuse existing implementations.

Regenerate the libc patch: `git -C sdk/rust/libc-upstream diff` after
editing the submodule tree, or diff a working copy against the pinned
submodule. Regenerate `std-overlay.patch`: diff each
`sdk/rust/std-overlay/` file vs
`$(rustc --print sysroot)/lib/rustlib/src/rust/library/`.

NOTE: upstreaming the target also requires a rustc target-spec
registration (compiler PR); these diffs cover the library side.
