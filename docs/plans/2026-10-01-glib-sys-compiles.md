# glib-sys compiles for Kandelo — the gtk-rs `-sys` path works

Status: validated via spike (2026-10-01). The foundational gtk-rs `-sys`
crate, `glib-sys 0.20`, compiles for `wasm32-unknown-kandelo` against the
ported glib package. This takes M7.3 from "pkg-config mechanism proven with a
zlib proxy" to "a real gtk-rs `-sys` crate builds," the concrete gate for the
librsvg path.

## Result

A staticlib depending on `glib-sys = "0.20"` built for the target (exit 0),
with glib (2.84.4) + libffi + pcre2 + zlib built from the registry. `glib-sys`
uses `system-deps` (not the raw pkg-config crate), so this also validates that
`system-deps` resolves a ported library.

## The recipe (what a `-sys`-depending Rust package needs)

Two things beyond the plain Rust-package pattern:

1. **Pin `libc` to the fork's exact version.** The Kandelo libc fork is
   `0.2.185` and `[patch.crates-io] libc = { path = <fork> }` is
   **version-exact**: it only replaces a `0.2.185` in the graph. A `-sys`
   crate's `libc = "0.2"` floats to the newest `0.2.x` (e.g. `0.2.189`), so
   the patch is silently "not used" and the unpatched registry libc (no
   kandelo support) compiles and fails. Fix: pin in the package's
   `Cargo.toml`:
   ```toml
   [dependencies]
   libc = "=0.2.185"
   [patch.crates-io]
   libc = { path = "<assembled fork>" }   # $KANDELO_RUST_DIR/libc-kandelo
   ```
   (The assembled fork is produced by `scripts/build-rust-sysroot.sh`.)

2. **Point `system-deps`/pkg-config at the ported libraries.** Resolve the C
   deps and set:
   ```
   PKG_CONFIG=wasm32posix-pkg-config
   PKG_CONFIG_ALLOW_CROSS=1
   PKG_CONFIG_PATH=<glib>/lib/pkgconfig:<libffi>/.../pkgconfig:<pcre2>/...:<zlib>/...
   ```
   `wasm32posix-pkg-config` resolves `glib-2.0` and its `Requires`/`Libs`
   chain (verified: `-lglib-2.0 -lpcre2-8`). Build with `-Z build-std=std`.

## Correction to the M7.3 findings (#1447)

**gettext is NOT a gap.** Kandelo's musl provides `gettext`, `dcngettext`,
`dgettext`, and `bindtextdomain` in `libc.a`, and glib builds against them
(its deps are libffi/zlib/pcre2, no gettext package). The earlier
`docs/plans/2026-09-30-rust-dependency-packaging.md` note that glib needs a
gettext package is wrong and should be amended.

## Remaining toward librsvg

- Other `-sys` crates: `gobject-sys`, `gio-sys` (depend on glib-sys, same
  recipe), and `cairo-sys-rs` (needs the cairo package built — same approach).
- The safe wrapper crates (`glib`, `cairo`, `gio`, …) on top of the `-sys`
  layer.
- A real dependency-bearing Rust **package** combining the libc pin, vendored
  crates (M7.3 §2), and the pkg-config env in its `build-<name>.sh`.
- librsvg itself (its build runs cargo inside autotools/meson).

## Spike

`.context/rust-m73b/glibsys/` (gitignored). Recreate from the recipe above.
