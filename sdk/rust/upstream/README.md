# Upstream-shaped diffs (tier-3 prep)

These are the changes the `wasm32-unknown-kandelo` target makes to
upstream Rust, isolated for review and as the basis for upstreaming the
target (rust-lang/libc + rust-lang/rust) as tier-3.

- **libc:** `../libc-kandelo.patch` (the build-time overlay itself,
  applied to the `sdk/rust/libc-upstream` submodule). ~9 files: the
  `kandelo` dispatch arms plus the wasm32 arch leaf reconciled to
  Kandelo's `wasm32posix` ABI (the bulk is the 279-entry syscall-number
  table). This is both the build input and the upstream submission.
- `std-overlay.patch` — diff of `sdk/rust/std-overlay/` against the
  pinned toolchain's `library/`. ~10 files, ~55 changed lines: `kandelo`
  `cfg` arms in `std`'s unix pal. Small because we reuse the existing
  unix backend rather than authoring one.

Regenerate the libc patch: `git -C sdk/rust/libc-upstream diff` after
editing the submodule tree, or diff a working copy against the pinned
submodule. Regenerate `std-overlay.patch`: diff each
`sdk/rust/std-overlay/` file vs
`$(rustc --print sysroot)/lib/rustlib/src/rust/library/`.

NOTE: upstreaming the target also requires a rustc target-spec
registration (compiler PR); these diffs cover the library side.
